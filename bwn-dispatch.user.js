// ==UserScript==
// @name         BWN Dispatch (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-dispatch.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-dispatch.user.js
// @description  One-click Dispatch for a work order - replaces manually typing a row into Dispatch_Notifications.xlsx. On a work order it opens a confirm modal prefilled from the BWN Ops Suite bus (Tracking / Location) and a same-origin Umbrava GraphQL read (Priority + the coordinator this WO / site is assigned to); the coordinator name + email are editable before you send. On submit it POSTs the 5 fields to the broadway-internal-ops SWA proxy (x-bwn-key gated) which forwards to the HTTP-triggered "Dispatch HTTP" Power Automate flow - the flow adds the row to Dispatch_Notifications.xlsx AND dispatches it (posts a Teams adaptive card to the coordinator and waits for their accept). Dispatching is a coordinator action, so there is no role gate (the x-bwn-key is the boundary). The assignee's email is not on the WO record, so it is resolved from a per-user name->email roster (you maintain it; it also remembers each coordinator you dispatch to). The flow's secret URL stays server-side; nothing sensitive lives in this script. Registers a single "Dispatch" launcher into the shared dock (bwn:dock:*); floating-button fallback when no dock host.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

/* eslint-disable */
(function () {
  'use strict';

  var VER = '0.1.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var GREEN = '#0d3d26';          // BWN Ops Suite brand green - matches CC Request / WO Audit
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/dispatch';
  console.info('[BWN DISPATCH] v' + VER + ' - confirm modal (bus + same-origin GraphQL prefill, name->email roster) -> SWA /api/dispatch (x-bwn-key) -> Dispatch HTTP flow -> Dispatch_Notifications.xlsx + Teams card. Registers the Dispatch launcher into the shared dock (bwn:dock:*), floating-button fallback when no host.');

  // ---- WO id + BWN Ops Suite bus (read-only consumer, suite data contract v1) --
  // bwn-suite-core (WO Assist) PUBLISHES the current WO's facts to sessionStorage
  // key `bwn:wo:{id}` (fields incl. tracking, location, coordinator = the WO's
  // "Assigned To"). We only READ it. Priority is NOT on the bus, so it comes from
  // the GraphQL read below. Absent (Core not installed / Job View not opened yet)
  // -> graceful blank, and the modal fields are all editable anyway.
  function woIdFromUrl() {
    var m = location.pathname.match(/(?:^|\/)work-orders\/(\d+)(?:\/|$|\?|#)/);
    return m ? m[1] : null;
  }
  function isWOPage() { return !!woIdFromUrl(); }
  function busGet(id, maxAgeMs) {
    if (!id) return null;
    try {
      var raw = sessionStorage.getItem('bwn:wo:' + id);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d.v !== 1 || (maxAgeMs && Date.now() - d.ts > maxAgeMs)) return null;
      return d;
    } catch (e) { return null; }
  }

  // ---- Who's signed in (Umbrava Auth0 session) -----------------------------
  // Used as the telemetry `actor`, and as a known-good name->email seed for the
  // roster (a coordinator most often dispatches to themselves or a teammate).
  function actor() {
    try {
      var k = Object.keys(localStorage).find(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); });
      var u = k ? ((JSON.parse(localStorage.getItem(k)) || {}).decodedToken || {}).user : null;
      return { name: (u && u.name) || '', email: (u && u.email) || '' };
    } catch (e) { return { name: '', email: '' }; }
  }

  // ---- Umbrava access token (for the same-origin GraphQL read) -------------
  // Picked by CONTENT, not first key: the audience-keyed Auth0 cache slot transiently
  // holds NON-Umbrava tokens. Only an unexpired token whose iss is an Umbrava issuer is
  // usable. Same rule as bwn-ask / bwn-suite-ai. The token is only ever attached to the
  // same-origin /api/graphql call (Authorization header); it is NEVER sent to the SWA.
  function isUmbravaToken(t) {
    try {
      var p = JSON.parse(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function authToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var t = (body && body.access_token) || '';
        if (t && isUmbravaToken(t)) return t;
      }
      return '';
    } catch (e) { return ''; }
  }

  // ---- Same-origin GraphQL (mirrors bwn-ask / bwn-wo-audit gql) ------------
  // app.umbrava.com is same-origin, so a plain fetch carries no @connect need; the
  // page's own bearer is passed explicitly so it works from the GM_* sandbox. Best
  // effort only: any miss leaves the modal on its bus prefill, never blocks the send.
  function gql(query, variables) {
    var tok = authToken();
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
        return j && j.data;
      });
  }

  // Current WO: all selectors proven live (bwn-ask CORE_Q / COORD_Q). One isolated
  // query - if it errors we just fall back to the bus prefill.
  var DISP_WO_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ trackingNumber locationId locationName assignedToMemberName priority{ label } } }';

  // ---- Site-history coordinator (Phase 1.5 location roster, reused) ---------
  // On a NEW / undispatched WO the "Assigned To" field is often blank, so the best
  // default assignee is the coordinator who most recently handled THIS location.
  // Umbrava's "work orders at a location" field/arg name is not known from source, so
  // (exactly like bwn-ask) we DISCOVER it via introspection rather than guess, then
  // read a compact roster. Everything here is best-effort + isolated: any miss leaves
  // the name blank for manual entry, never fabricated. Cached per session.
  var _locField;             // undefined=unqueried, null=none found, else {field,locArg,argType,container}
  var _locRoster = {};       // locationId -> [wo...]  (session cache)
  var ROSTER_SEL = 'number assignedToMemberName workOrderDate creationDate';
  function unwrapType(t) { var isList = false, cur = t; while (cur && cur.ofType) { if (cur.kind === 'LIST') isList = true; cur = cur.ofType; } return { name: cur && cur.name, kind: cur && cur.kind, isList: isList }; }
  function discoverLocField() {
    if (_locField !== undefined) return Promise.resolve(_locField);
    var Q = '{ __schema { queryType { fields { name args { name type { kind name ofType { kind name } } } type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }';
    return gql(Q, {}).then(function (d) {
      var fs = (d && d.__schema && d.__schema.queryType && d.__schema.queryType.fields) || [];
      var pick = null;
      for (var i = 0; i < fs.length && !pick; i++) {
        var f = fs[i], nm = String(f.name || '');
        if (!/work.?orders/i.test(nm)) continue;                 // plural list field, not single workOrder
        var la = null, at = 'ID';
        (f.args || []).forEach(function (a) { if (!la && /location.?id|^location$/i.test(a.name)) { la = a.name; var u = unwrapType(a.type || {}); at = u.name || 'ID'; } });
        if (!la) continue;
        var ret = unwrapType(f.type || {});
        pick = { field: nm, locArg: la, argType: at, retName: ret.name, retKind: ret.kind, retIsList: ret.isList };
      }
      if (!pick) { _locField = null; return null; }
      if (pick.retIsList) { pick.container = null; _locField = pick; return pick; }
      var TQ = 'query($t:String!){ __type(name:$t){ fields { name type { kind name ofType { kind name ofType { kind name } } } } } }';
      return gql(TQ, { t: pick.retName }).then(function (td) {
        var tf = (td && td.__type && td.__type.fields) || [];
        for (var j = 0; j < tf.length; j++) { var u = unwrapType(tf[j].type || {}); if (u.isList && (u.kind === 'OBJECT' || u.kind === 'INTERFACE')) { pick.container = tf[j].name; break; } }
        _locField = pick.container ? pick : null;
        return _locField;
      }, function () { _locField = null; return null; });
    }, function () { _locField = null; return null; });
  }
  function fetchLocationRoster(locationId) {
    if (locationId == null) return Promise.resolve([]);
    var key = String(locationId);
    if (_locRoster[key]) return Promise.resolve(_locRoster[key]);
    return discoverLocField().then(function (fld) {
      if (!fld) { _locRoster[key] = []; return []; }
      var vtype = /int/i.test(fld.argType) ? 'Int!' : 'ID!';
      var inner = fld.container === 'edges' ? ('edges{ node{ ' + ROSTER_SEL + ' } }') : (fld.container ? (fld.container + '{ ' + ROSTER_SEL + ' }') : ROSTER_SEL);
      var Q = 'query($loc:' + vtype + '){ ' + fld.field + '(' + fld.locArg + ':$loc){ ' + inner + ' } }';
      return gql(Q, { loc: locationId }).then(function (d) {
        var root = d && d[fld.field];
        var arr = !fld.container ? root : (fld.container === 'edges' ? (root && root.edges || []).map(function (e) { return e && e.node; }) : (root && root[fld.container]));
        arr = Array.isArray(arr) ? arr.filter(Boolean) : [];
        _locRoster[key] = arr;
        return arr;
      }, function () { _locRoster[key] = []; return []; });
    });
  }
  function ts(d) { var n = Date.parse(d); return isNaN(n) ? 0 : n; }
  // Most-recent prior WO (excluding the current one) that carries an assignee name.
  function siteCoordinator(locationId, curNumber) {
    return fetchLocationRoster(locationId).then(function (wos) {
      var cur = String(curNumber == null ? '' : curNumber);
      var withName = (wos || [])
        .filter(function (w) { return w && String(w.number) !== cur && w.assignedToMemberName; })
        .sort(function (a, b) { return ts(b && (b.workOrderDate || b.creationDate)) - ts(a && (a.workOrderDate || a.creationDate)); });
      return withName.length ? String(withName[0].assignedToMemberName).trim() : '';
    }, function () { return ''; });
  }

  // ---- Name -> email roster (the AssigneeEmail source) ----------------------
  // The assignee's email is NOT on the WO record (Umbrava exposes the coordinator
  // NAME, not their UPN), and Get-user-profile (V2) in the flow resolves the Teams
  // identity by email - so we keep a per-user name->email map in GM storage. It is
  // seeded with the signed-in user, grows automatically on each successful dispatch,
  // and is editable from the Tampermonkey menu. Store work emails only. (Live recon
  // TODO in wo-dispatch-button.md: a members(name)->email GraphQL read could later
  // seed this, but that field is unproven, so we do not guess it here.)
  function loadRoster() {
    try { var o = JSON.parse(GM_getValue('dispatch_roster', '{}')); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function saveRoster(o) { try { GM_setValue('dispatch_roster', JSON.stringify(o || {})); } catch (e) { } }
  function rosterKey(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function rosterLookup(name) { var k = rosterKey(name); return k ? (loadRoster()[k] || '') : ''; }
  function rosterRemember(name, email) {
    var k = rosterKey(name); email = String(email || '').trim();
    if (!k || !email) return;
    var o = loadRoster(); if (o[k] === email) return; o[k] = email; saveRoster(o);
  }
  function seedRosterWithMe() {
    var me = actor();
    if (me.name && me.email) rosterRemember(me.name, me.email);
  }
  function manageRoster() {
    var o = loadRoster();
    var lines = Object.keys(o).sort().map(function (k) { return k + ' = ' + o[k]; });
    var v = prompt('Dispatch name->email roster (one per line, "Coordinator Name = coordinator@broadwaynational.com"). Used to prefill the Assignee Email from the coordinator name. Edit / add / remove:', lines.join('\n'));
    if (v === null) return;
    var next = {};
    v.split(/\r?\n/).forEach(function (ln) {
      var i = ln.indexOf('=');
      if (i < 0) return;
      var nm = rosterKey(ln.slice(0, i));
      var em = ln.slice(i + 1).trim();
      if (nm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) next[nm] = em;
    });
    saveRoster(next);
    toast(Object.keys(next).length ? 'Saved ' + Object.keys(next).length + ' roster entr' + (Object.keys(next).length === 1 ? 'y' : 'ies') + '.' : 'Roster cleared.');
  }

  // ---- Toast --------------------------------------------------------------
  function toast(msg, ms, bg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%);background:' + (bg || GREEN) + ';color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:74vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.5;';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 420); }, ms || 6000);
  }

  // ---- SWA POST (GM_xmlhttpRequest bypasses same-origin; @connect authorizes) ----
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 30000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  // ---- Field spec (order = modal layout). Mirrors the proxy's 5-prop body ---
  // key      = the JSON prop the proxy / flow expect
  // required = enforced client-side (api/dispatch re-checks the same minimum;
  //            Priority is optional - the card's else-branch color-codes a blank).
  var FIELDS = [
    { key: 'AssignedToName', label: 'Assigned To (coordinator)', type: 'text', required: true, ph: 'Coordinator who owns this WO' },
    { key: 'AssigneeEmail', label: 'Assignee Email', type: 'email', required: true, ph: 'coordinator@broadwaynational.com' },
    { key: 'Tracking', label: 'Tracking #', type: 'text', required: true, ph: 'WO tracking number' },
    { key: 'Location', label: 'Location', type: 'text', required: true, ph: 'Site / store' },
    { key: 'Priority', label: 'Priority', type: 'text', ph: 'e.g. P2 - Normal (optional)' }
  ];
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var openEl = null;
  function closeModal() { if (openEl) { openEl.remove(); openEl = null; document.removeEventListener('keydown', onKey); } }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  function buildModal() {
    if (openEl) return;   // one at a time
    seedRosterWithMe();
    var me = actor();
    var woId = woIdFromUrl();
    var bus = busGet(woId, 12 * 3600000);

    // Synchronous prefill from the bus (present immediately). GraphQL patches the
    // rest below once it resolves - only for fields the user has not typed into.
    var pre = {
      AssignedToName: (bus && bus.coordinator) ? String(bus.coordinator).trim() : '',
      AssigneeEmail: '',
      Tracking: (bus && bus.tracking) ? String(bus.tracking).trim() : (woId || ''),
      Location: (bus && bus.location) ? String(bus.location).trim() : '',
      Priority: ''
    };
    if (pre.AssignedToName) pre.AssigneeEmail = rosterLookup(pre.AssignedToName);

    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px;';
    back.addEventListener('click', function (e) { if (e.target === back) closeModal(); });

    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;color:#12241b;font:400 14px ' + FONT + ';width:480px;max-width:100%;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden;';

    var head = document.createElement('div');
    head.style.cssText = 'background:' + GREEN + ';color:#fff;padding:16px 20px;font-weight:600;font-size:16px;display:flex;justify-content:space-between;align-items:center;';
    head.innerHTML = '<span>Dispatch Work Order</span>';
    var x = document.createElement('button');
    x.textContent = '×';
    x.style.cssText = 'background:none;border:none;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0 4px;';
    x.addEventListener('click', closeModal);
    head.appendChild(x);

    var form = document.createElement('form');
    form.style.cssText = 'padding:18px 20px 8px;';
    form.setAttribute('autocomplete', 'off');

    // What happens on send (the flow posts a Teams card the coordinator must accept).
    var who = document.createElement('div');
    who.style.cssText = 'font-size:12.5px;color:#33473d;background:#eef4f0;border:1px solid #cfe0d7;border-radius:8px;padding:8px 11px;margin-bottom:14px;line-height:1.45;';
    who.textContent = 'Sends a Teams "New Dispatch Work Order" card to the coordinator below, who accepts it. Assignee is prefilled from this WO / the site history - edit it before sending.';
    form.appendChild(who);

    var inputs = {};
    var touched = {};
    var lblCss = 'display:block;font-weight:600;font-size:12px;margin:0 0 4px;color:#33473d;';
    var inCss = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #c6d2cc;border-radius:8px;font:400 14px ' + FONT + ';background:#fff;color:#12241b;';

    FIELDS.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:13px;';
      var lbl = document.createElement('label');
      lbl.style.cssText = lblCss;
      lbl.textContent = f.label + (f.required ? ' *' : '');
      var el = document.createElement('input');
      el.type = (f.type === 'email') ? 'email' : 'text';
      el.style.cssText = inCss;
      if (f.ph) el.placeholder = f.ph;
      if (pre[f.key]) el.value = pre[f.key];
      el.addEventListener('input', function () { touched[f.key] = true; });
      lbl.setAttribute('for', 'disp_' + f.key);
      el.id = 'disp_' + f.key;
      inputs[f.key] = el;
      wrap.appendChild(lbl); wrap.appendChild(el);
      form.appendChild(wrap);
    });

    // When the coordinator name is (re)typed, offer the roster email if we know it
    // and the email field is still empty / untouched.
    inputs.AssignedToName.addEventListener('change', function () {
      if (touched.AssigneeEmail || inputs.AssigneeEmail.value.trim()) return;
      var em = rosterLookup(inputs.AssignedToName.value);
      if (em) inputs.AssigneeEmail.value = em;
    });

    var msg = document.createElement('div');
    msg.style.cssText = 'min-height:18px;color:#b4231f;font-size:12.5px;margin:2px 0 10px;';

    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding:6px 0 14px;';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:9px 16px;border:1px solid #c6d2cc;background:#fff;color:#33473d;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    cancel.addEventListener('click', closeModal);
    var submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = 'Dispatch';
    submit.style.cssText = 'padding:9px 18px;border:none;background:' + GREEN + ';color:#fff;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    foot.appendChild(cancel); foot.appendChild(submit);

    form.appendChild(msg);
    form.appendChild(foot);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';

      var key = GM_getValue('ingest_key', '');
      if (!key) { msg.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }

      var payload = { actor: me.email || me.name || 'unknown' };
      var missing = [];
      FIELDS.forEach(function (f) {
        var v = (inputs[f.key].value || '').trim();
        if (f.required && !v) missing.push(f.label);
        payload[f.key] = v;
      });
      if (missing.length) { msg.textContent = 'Required: ' + missing.join(', '); return; }
      if (!EMAIL_RE.test(payload.AssigneeEmail)) { msg.textContent = 'Assignee Email must be a valid email address.'; return; }

      var reenable = function () { submit.disabled = false; submit.textContent = 'Dispatch'; };
      submit.disabled = true;
      submit.textContent = 'Dispatching…';

      gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 30000)
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
            rosterRemember(payload.AssignedToName, payload.AssigneeEmail);   // learn this coordinator for next time
            closeModal();
            toast('Dispatched ✓  ' + payload.AssignedToName + ' will get a Teams card to accept (Tracking ' + payload.Tracking + ').', 7000);
          } else if (r.status === 400) {
            reenable(); msg.textContent = 'Rejected (400)' + (r.json && r.json.error ? ': ' + r.json.error : ' - check the fields') + '.';
          } else if (r.status === 403) {
            reenable(); msg.textContent = 'Rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.';
          } else if (r.status === 429) {
            reenable(); msg.textContent = 'Too many dispatches in a row - wait a moment and try again.';
          } else if (r.status === 503) {
            reenable(); msg.textContent = 'Dispatch is not fully configured on the server yet (503) - tell Mike the DISPATCH_FLOW_URL app setting is missing.';
          } else {
            reenable(); msg.textContent = 'Dispatch failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : '') + '.';
          }
        })
        .catch(function (err) {
          reenable(); msg.textContent = (err && err.message ? err.message : 'could not reach the proxy') + '.';
        });
    });

    card.appendChild(head); card.appendChild(form);
    back.appendChild(card);
    document.body.appendChild(back);
    openEl = back;
    document.addEventListener('keydown', onKey);

    // If we are not on a WO page (opened from the TM menu), say so - the fields are
    // then all manual. Otherwise upgrade the prefill from Umbrava in the background.
    if (!woId) {
      msg.style.color = '#7a5b00';
      msg.textContent = 'No work order open - enter the dispatch fields manually.';
    } else {
      hydrateFromUmbrava(woId, inputs, touched);
    }

    var first = inputs.AssignedToName;
    if (first) setTimeout(function () { first.focus(); first.select && first.select(); }, 30);
  }

  // Background prefill upgrade: read the current WO live, patch Priority + Tracking +
  // Location + the coordinator name/email, but ONLY for fields the user has not typed
  // into and that are still empty. If the WO has no assignee yet, fall back to the most
  // recent coordinator at the same location (site history). All best-effort.
  function hydrateFromUmbrava(woId, inputs, touched) {
    var n = parseInt(woId, 10);
    function setIfEmpty(k, v) {
      v = (v == null) ? '' : String(v).trim();
      if (!v) return;
      var el = inputs[k];
      if (el && !touched[k] && !el.value.trim()) el.value = v;
    }
    gql(DISP_WO_Q, { n: n }).then(function (d) {
      var wo = (d && d.workOrder) || {};
      setIfEmpty('Tracking', wo.trackingNumber);
      setIfEmpty('Location', wo.locationName);
      setIfEmpty('Priority', wo.priority && wo.priority.label);
      var name = wo.assignedToMemberName ? String(wo.assignedToMemberName).trim() : '';
      if (name) {
        setIfEmpty('AssignedToName', name);
        fillEmailFor(inputs, touched, inputs.AssignedToName.value);
        return;
      }
      // No assignee on this WO -> site history (most recent coordinator at the location).
      if (wo.locationId != null) {
        siteCoordinator(wo.locationId, wo.number != null ? wo.number : n).then(function (sc) {
          if (sc) { setIfEmpty('AssignedToName', sc); fillEmailFor(inputs, touched, inputs.AssignedToName.value); }
        });
      }
    }, function () { /* GraphQL unavailable - bus prefill stands */ });
  }
  // Prefill AssigneeEmail from the roster (or from the signed-in user when the name
  // matches them), only if untouched + empty.
  function fillEmailFor(inputs, touched, name) {
    if (touched.AssigneeEmail || inputs.AssigneeEmail.value.trim()) return;
    var em = rosterLookup(name);
    if (!em) { var me = actor(); if (me.email && rosterKey(me.name) === rosterKey(name)) em = me.email; }
    if (em) inputs.AssigneeEmail.value = em;
  }

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // bwn-suite-core's Launcher hosts the shared dock ([[bwn-launcher-dock]]). Dispatch
  // is a WO-level action, so we register the 'dispatch' entry ONLY on a work-order page
  // and unregister when navigating away (Umbrava is a SPA). detail.key carries the entry
  // id (detail.id is the bwn:evt event name). If no host announces within a few seconds
  // we fall back to a self-drawn floating button (also WO-page gated) so it is reachable.
  var DOCK_KEY = 'dispatch';
  var _hostSeen = false;
  var _fallbackActive = false;
  var _registered = false;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Dispatch', icon: '🚚', weight: 15,
        title: 'Dispatch this work order to a coordinator'
      } }));
    } catch (e) { }
  }
  function dockUnregister() {
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:dock:unregister', key: DOCK_KEY } })); } catch (e) { }
  }
  function removeButton() { var b = document.getElementById('bwn-dispatch-btn'); if (b) b.remove(); }
  function addButton() {
    if (document.getElementById('bwn-dispatch-btn')) return;
    var b = document.createElement('button');
    b.id = 'bwn-dispatch-btn';
    b.textContent = '🚚 Dispatch';
    b.title = 'Dispatch this work order to a coordinator';
    // bottom-right, lifted above the CC Request fallback (bottom:18px) so the two rare
    // no-host fallbacks do not overlap.
    b.style.cssText = 'position:fixed;z-index:2147483645;right:18px;bottom:70px;background:' + GREEN + ';color:#fff;border:0;padding:11px 16px;border-radius:24px;font:600 13px ' + FONT + ';cursor:pointer;box-shadow:0 6px 20px rgba(13,38,26,.35);';
    b.onclick = buildModal;
    document.body.appendChild(b);
  }
  // Reconcile dock/fallback presence with the current route.
  function reeval() {
    var on = isWOPage();
    if (_hostSeen) {
      removeButton(); _fallbackActive = false;
      if (on && !_registered) { dockRegister(); _registered = true; }
      else if (!on && _registered) { dockUnregister(); _registered = false; }
    } else if (_fallbackActive) {
      if (on) { if (document.body) addButton(); } else { removeButton(); }
    }
  }
  function onDockHost() {
    _hostSeen = true;
    if (_fallbackActive) { _fallbackActive = false; removeButton(); }
    _registered = false;   // force a fresh register for a newly-elected host
    reeval();
  }
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail; if (!d) return;
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') onDockHost();
    if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildModal();
  });
  // Post-WO-Intake / cross-script opener hook: any suite script can request the modal
  // with bwn:cmd {id:'dispatch:open'} (e.g. WO Intake could fire it after Create so the
  // coordinator can dispatch the fresh WO immediately - see wo-dispatch-button.md).
  document.addEventListener('bwn:cmd', function (e) {
    var d = e && e.detail; if (d && d.id === 'dispatch:open') buildModal();
  });

  // SPA route changes: re-reconcile on history navigation.
  (function hookNav() {
    function fire() { setTimeout(reeval, 0); }
    try {
      var wrap = function (orig) { return function () { var r = orig.apply(this, arguments); fire(); return r; }; };
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch (e) { }
    window.addEventListener('popstate', fire);
  })();

  // ---- Tampermonkey menu --------------------------------------------------
  try {
    GM_registerMenuCommand('Dispatch this work order', buildModal);
    GM_registerMenuCommand('Manage dispatch roster (name -> email)', manageRoster);
    GM_registerMenuCommand('Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', GM_getValue('ingest_key', '') || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { /* menu API absent - the dock / fallback button still opens the modal */ }

  // Register into the dock on load (covers a host already up); the host heartbeat/ping
  // re-registers us later. If no host is seen within 4s, switch to the fallback button.
  seedRosterWithMe();
  if (isWOPage()) { dockRegister(); _registered = true; }
  setTimeout(function () {
    if (_hostSeen || _fallbackActive) return;
    _fallbackActive = true; _registered = false;
    reeval();
  }, 4000);
})();
