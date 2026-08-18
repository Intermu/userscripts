// ==UserScript==
// @name         BWN Suite - Low GP Note (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.2.1
// @description  A "Low GP" button beside the global "Search Work Orders" box. Enter a WO#, Tracking#, Source PO#, or Source Job#; it finds the work order, shows a one-click CONFIRM card (WO / client / location / assignee), then posts TWO notes via Umbrava's own API: a Billing-type note reading "Low GP", and a second note that @-mentions the WO's assignee ("@Name Low GP note added") so they are notified. The @-mention is the real TipTap mention span the SPA sends (captured live 2026-08-17); actionNoteEmails stays null - the span alone notifies. Same-origin /api/graphql with the app's Auth0 bearer, @grant none, zero egress. Nothing posts until you click Confirm.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-low-gp.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-low-gp.user.js
// ==/UserScript==
(function () {
  'use strict';

  var GREEN = 'linear-gradient(135deg,#2ECC71,#1a5f3e)';   // Broadway green (Core's --bwn-green/-dk, inlined for a standalone script)
  var BILLING_TYPE_NAME = 'Billing';   // note #1 type (id 3 in the 82-type map) - Mike's spec
  var PING_TYPE_NAME = 'Internal';     // note #2 type (id 13); the @-mention notifies regardless of type
  var NOTE1_CONTENT = 'Low GP';        // note #1 body
  var PING_MESSAGE = 'Low GP note added';   // note #2 body (after the @-mention)

  // ===== Pure logic (sliced + unit-tested by scripts/test-low-gp.js) =====================
  // LOW-GP-SLICE-START
  function lgIsGuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s == null ? '' : s)); }

  function lgEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Note-type id resolved by NAME from Core's bwn:noteTypes cache (82 types; Core populates it).
  // cacheRaw is the raw localStorage string (or null). Floor covers the two types this script needs,
  // so a missing cache never blocks a note. Never hardcode past the floor, never infer from position.
  var LG_TYPE_FLOOR = { 'billing': 3, 'internal': 13, 'low gp': 75 };
  function lgTypeId(name, cacheRaw) {
    var want = String(name == null ? '' : name).toLowerCase();
    try {
      var c = JSON.parse(cacheRaw || 'null');
      if (c && c.map) { for (var id in c.map) { if (String(c.map[id]).toLowerCase() === want) return parseInt(id, 10); } }
    } catch (e) { /* fall through to floor */ }
    return (typeof LG_TYPE_FLOOR[want] === 'number') ? LG_TYPE_FLOOR[want] : null;
  }

  // note #1 is a single plain line -> one escaped <p>.
  function lgSimpleHtml(text) { return '<p>' + lgEsc(text) + '</p>'; }

  // note #2 contentHtml: the TipTap mention span the SPA sends (captured live 2026-08-17 - class,
  // attr set, and <p> style all verbatim from the wire). The span ALONE drives the notification;
  // actionNoteEmails stays null. data-id is the assignee's user GUID, data-tenant the org tenant GUID.
  function lgMentionHtml(name, userId, tenantId, message) {
    var n = lgEsc(name);
    return '<p style="font-size: 14px; line-height: 1.4">' +
      '<span data-type="mention" class="rich-text-editor-mention"' +
      ' data-id="' + lgEsc(userId) + '"' +
      ' data-label="' + n + '"' +
      ' data-tenant="' + lgEsc(tenantId) + '">@' + n + '</span> ' +
      lgEsc(message) + '</p>';
  }

  // note #2 plain content mirrors the wire: "@<Name> <message>".
  function lgPingContent(name, message) { return '@' + String(name == null ? '' : name) + ' ' + String(message == null ? '' : message); }

  // WorkOrderNoteInput - matches the captured AddEditWONote shape exactly.
  function lgNoteInput(woNumber, typeId, content, contentHtml) {
    return {
      workOrderNumber: woNumber, type: typeId, content: String(content), contentHtml: contentHtml,
      isCompletion: false, isInvoice: false, isPinned: false, actionNoteEmails: null, targetPurchaseOrderNumbers: []
    };
  }

  // Normalize a listWorkOrdersPaginated item to what the UI + poster need. hasAssignee gates the
  // notify: it needs a real user GUID (a WO can carry a name column with no id, or vice versa).
  function lgRow(it) {
    var id = String(it.assignedTo == null ? '' : it.assignedTo);
    var guid = lgIsGuid(id) ? id : '';
    return {
      number: it.number, tracking: it.trackingNumber || '', client: it.clientName || '',
      location: it.locationName || '', status: it.statusName || '',
      sourceJob: it.sourceJobNumber || '', sourcePO: it.sourcePurchaseOrderNumber || '',
      assigneeName: it.assignedToMemberName || '', assigneeId: guid, hasAssignee: !!guid
    };
  }

  // localStorage['tenantId'] is stored JSON-quoted ("<guid>", length 38) - measured live 2026-08-17.
  // Unwrap to the bare value so the mention's data-tenant is the GUID, not "&quot;<guid>&quot;". A raw
  // (unquoted) value or any non-string is returned as-is / stripped of wrapping quotes.
  function lgUnwrap(raw) {
    if (raw == null) return '';
    try { var v = JSON.parse(raw); if (typeof v === 'string') return v; } catch (e) { /* not JSON */ }
    return String(raw).replace(/^"|"$/g, '');
  }
  // LOW-GP-SLICE-END

  // ===== Auth + GraphQL (same-origin, app bearer - the drop-upload write path, proven) ===========
  // ===== BWN-SHARED START v1 (paste-identical; pinned by scripts/test-shared-block-ledger.js) =====
  function isUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
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
        var tok = (body && body.access_token) || '';
        if (tok && isUmbravaToken(tok)) return tok;
      }
      return '';
    } catch (e) { return ''; }
  }
  // ===== BWN-SHARED END v1 =====
  function lgCacheRaw() { try { return localStorage.getItem('bwn:noteTypes'); } catch (e) { return null; } }
  function lgTenant() { try { return lgUnwrap(localStorage.getItem('tenantId')); } catch (e) { return ''; } }

  function lgGql(op, query, variables) {
    var tok = authToken();
    if (!tok) return Promise.reject(new Error('Not signed in to Umbrava (no app token found).'));
    return fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName: op, query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      return j && j.data;
    });
  }

  // Fast lookup. `lookupJob` is the op Umbrava's OWN "Search Work Orders" box fires - a typeahead index
  // that resolves WO#/Tracking#/Source PO#/Source Job# in ~300ms (measured live 2026-08-17). The generic
  // `listWorkOrdersPaginated(search:)` took 6-28s for the SAME lookup, so we resolve the identifier via
  // lookupJob, then hydrate the matched WO number(s) with the fast `WorkOrderNumbers` filter (~40ms) -
  // lookupJob does not expose `assignedToMemberName`/`locationName`, which the confirm card + @-mention need.
  var LG_LOOKUP_Q = 'query LookupJob($page:PageInput!,$sortBy:[SortInput!]!,$search:String!){ lookupJob(page:$page,sortBy:$sortBy,search:$search){ items{ number } } }';
  var LG_BYNUM_Q = 'query BwnLowGpByNum($page:PageInput!,$sortBy:[SortInput!]!,$WorkOrderNumbers:[Int]){ listWorkOrdersPaginated(page:$page,sortBy:$sortBy,WorkOrderNumbers:$WorkOrderNumbers){ items{ number trackingNumber assignedTo assignedToMemberName clientName locationName statusName sourceJobNumber sourcePurchaseOrderNumber } } }';
  // Slow fallback, only if lookupJob ever changes/breaks: the generic board search (6-28s but works).
  var LG_SEARCH_Q = 'query BwnLowGpSearch($page:PageInput!,$sortBy:[SortInput!]!,$search:String){ listWorkOrdersPaginated(page:$page,sortBy:$sortBy,search:$search){ items{ number trackingNumber assignedTo assignedToMemberName clientName locationName statusName sourceJobNumber sourcePurchaseOrderNumber } } }';

  function lgRowsFromList(d) { var l = d && d.listWorkOrdersPaginated; return (l && l.items) ? l.items.map(lgRow) : []; }
  function lgFetchByNumbers(nums) {
    if (!nums.length) return Promise.resolve([]);
    return lgGql('BwnLowGpByNum', LG_BYNUM_Q, {
      page: { skip: 0, take: nums.length }, sortBy: [{ columnName: 'number', direction: 'DESC' }], WorkOrderNumbers: nums
    }).then(lgRowsFromList);
  }
  function lgSearchSlow(text) {
    return lgGql('BwnLowGpSearch', LG_SEARCH_Q, {
      page: { skip: 0, take: 25 }, sortBy: [{ columnName: 'numberOfDays', direction: 'DESC' }], search: String(text)
    }).then(lgRowsFromList);
  }
  function lgSearch(text) {
    return lgGql('LookupJob', LG_LOOKUP_Q, {
      page: { skip: 0, take: 25 }, sortBy: [{ columnName: 'LastModified', direction: 'DESC' }], search: String(text)
    }).then(function (d) {
      var items = (d && d.lookupJob && d.lookupJob.items) || [], seen = {}, nums = [];
      items.forEach(function (it) { var n = it.number; if (typeof n === 'number' && !seen[n]) { seen[n] = 1; nums.push(n); } });
      return lgFetchByNumbers(nums);
    }).catch(function () { return lgSearchSlow(text); });   // lookupJob broke -> slow but working
  }

  var LG_ADD_NOTE = 'mutation AddEditWONote($addEditInput: WorkOrderNoteInput!) { addEditJobNote(data: $addEditInput) { success message note { id type } } }';
  function lgPostNote(input) {
    return lgGql('AddEditWONote', LG_ADD_NOTE, { addEditInput: input }).then(function (d) {
      var res = d && d.addEditJobNote;
      if (!res || res.success !== true) throw new Error((res && res.message) || 'addEditJobNote reported no success');
      return res.note;
    });
  }

  // Post note #1 (Billing "Low GP"), then note #2 (@assignee ping) if the WO has an assignee. Note #2
  // failing does NOT undo note #1 - the result carries per-note outcome so the UI can tell the truth.
  function lgApply(row) {
    var billingId = lgTypeId(BILLING_TYPE_NAME, lgCacheRaw());
    if (billingId == null) return Promise.reject(new Error("Couldn't resolve the 'Billing' note type."));
    var result = { note1: false, note2: false, note2skipped: false, note2error: '' };
    var note1 = lgNoteInput(row.number, billingId, NOTE1_CONTENT, lgSimpleHtml(NOTE1_CONTENT));
    return lgPostNote(note1).then(function () {
      result.note1 = true;
      if (!row.hasAssignee) { result.note2skipped = true; return result; }
      var label = row.assigneeName || 'assignee';
      var pingId = lgTypeId(PING_TYPE_NAME, lgCacheRaw());
      var note2 = lgNoteInput(row.number, pingId,
        lgPingContent(label, PING_MESSAGE),
        lgMentionHtml(label, row.assigneeId, lgTenant(), PING_MESSAGE));
      return lgPostNote(note2).then(
        function () { result.note2 = true; return result; },
        function (err) { result.note2error = (err && err.message) || String(err); return result; }
      );
    });
  }

  // ===== Panel UI (fixed-positioned under the button; one container, re-rendered per view) ========
  var BTN_ID = 'bwn-lowgp-btn';
  var PANEL_ID = 'bwn-lowgp-panel';
  var view = 'input';   // input | loading | results | confirm | posting | done | error
  var st = { query: '', rows: [], row: null, error: '', result: null };

  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
  }
  function onDoc(e) {
    var p = document.getElementById(PANEL_ID), b = document.getElementById(BTN_ID);
    if (p && !p.contains(e.target) && b && !b.contains(e.target)) closePanel();
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); closePanel(); } }

  function reposition() {
    var p = document.getElementById(PANEL_ID), b = document.getElementById(BTN_ID);
    if (!p || !b) return;
    var r = b.getBoundingClientRect();
    var w = p.offsetWidth || 340;
    p.style.top = Math.round(r.bottom + 6) + 'px';
    p.style.left = Math.round(Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  }

  function openPanel() {
    closePanel();
    view = 'input'; st = { query: '', rows: [], row: null, error: '', result: null };
    var p = document.createElement('div');
    p.id = PANEL_ID;
    p.style.cssText = 'position:fixed;z-index:99999;width:340px;max-height:78vh;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.20);padding:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1e293b;';
    document.body.appendChild(p);
    render();
    reposition();
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
  }

  function h(html) { var p = document.getElementById(PANEL_ID); if (p) p.innerHTML = html; return p; }
  function on(sel, ev, fn) { var p = document.getElementById(PANEL_ID); if (!p) return; var el = p.querySelector(sel); if (el) el.addEventListener(ev, fn); }
  function onAll(sel, ev, fn) { var p = document.getElementById(PANEL_ID); if (!p) return; [].forEach.call(p.querySelectorAll(sel), function (el) { el.addEventListener(ev, fn); }); }

  var TITLE = '<div style="font:700 13px/1.2 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;color:#1a5f3e;margin-bottom:10px;display:flex;align-items:center;gap:7px;">Low GP note</div>';
  // Single-quote the font family: these strings go into an innerHTML style="..." attribute, so a
  // double quote inside would terminate the attribute and void the whole style (measured 2026-08-17).
  var BTN_CSS = 'padding:9px 12px;border:none;border-radius:8px;cursor:pointer;font:600 13px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;';
  var PRIMARY = BTN_CSS + 'color:#fff;background:' + GREEN + ';width:100%;';
  var GHOST = BTN_CSS + 'color:#475569;background:#f1f5f9;';

  function render() {
    if (view === 'input') {
      h(TITLE +
        '<input id="lg-q" type="text" placeholder="WO#, Tracking#, Source PO#, or Source Job#" ' +
        'style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;font:400 13px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;margin-bottom:10px;" />' +
        '<button id="lg-find" style="' + PRIMARY + '">Find work order</button>');
      var inp = document.getElementById('lg-q');
      if (inp) { inp.value = st.query; inp.focus(); }
      on('#lg-find', 'click', doFind);
      on('#lg-q', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doFind(); } });
    } else if (view === 'loading') {
      h(TITLE + '<div style="padding:8px 2px;color:#64748b;font-size:13px;">Searching for "' + lgEsc(st.query) + '"…</div>');
    } else if (view === 'results') {
      if (!st.rows.length) {
        h(TITLE + '<div style="padding:4px 2px 12px;color:#334155;font-size:13px;">No work order found for "' + lgEsc(st.query) + '".</div>' +
          '<button id="lg-back" style="' + GHOST + 'width:100%;">Back</button>');
        on('#lg-back', 'click', function () { view = 'input'; render(); });
      } else {
        var rowsHtml = st.rows.map(function (r, i) {
          var sub = [r.client, r.location, r.status].filter(Boolean).map(lgEsc).join(' · ');
          var asg = r.hasAssignee ? lgEsc(r.assigneeName || 'assignee') : 'no assignee';
          return '<button class="lg-pick" data-i="' + i + '" style="display:block;width:100%;box-sizing:border-box;text-align:left;padding:9px 10px;margin-bottom:6px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font:400 12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;">' +
            '<span style="font-weight:700;color:#1a5f3e;">WO #' + lgEsc(r.number) + '</span>' +
            (sub ? '<br><span style="color:#475569;">' + sub + '</span>' : '') +
            '<br><span style="color:#64748b;">' + asg + '</span></button>';
        }).join('');
        h(TITLE + '<div style="color:#64748b;font-size:11px;margin-bottom:8px;">' + st.rows.length + ' match' + (st.rows.length === 1 ? '' : 'es') + ' for "' + lgEsc(st.query) + '" — pick one:</div>' +
          rowsHtml + '<button id="lg-back" style="' + GHOST + 'width:100%;margin-top:2px;">Back</button>');
        onAll('.lg-pick', 'click', function (e) {
          var i = parseInt(e.currentTarget.getAttribute('data-i'), 10);
          st.row = st.rows[i]; view = 'confirm'; render();
        });
        on('#lg-back', 'click', function () { view = 'input'; render(); });
      }
    } else if (view === 'confirm') {
      var r2 = st.row;
      var meta = [];
      if (r2.client || r2.location) meta.push('<div style="color:#334155;">' + [r2.client, r2.location].filter(Boolean).map(lgEsc).join(' · ') + '</div>');
      if (r2.status) meta.push('<div style="color:#64748b;">Status: ' + lgEsc(r2.status) + '</div>');
      if (r2.tracking) meta.push('<div style="color:#64748b;">Tracking #' + lgEsc(r2.tracking) + '</div>');
      var assigneeLine = r2.hasAssignee
        ? '<div style="color:#334155;margin-top:6px;">Assignee: <b>' + lgEsc(r2.assigneeName || 'assignee') + '</b></div>'
        : '<div style="color:#a11;margin-top:6px;">No assignee — the Low GP note will be added, but nobody will be notified.</div>';
      var applyLabel = r2.hasAssignee ? ('Add Low GP note + notify ' + lgEsc(r2.assigneeName || 'assignee')) : 'Add Low GP note';
      h(TITLE +
        '<div style="font-size:13px;line-height:1.5;margin-bottom:12px;">' +
        '<div style="font-weight:700;color:#1a5f3e;font-size:15px;">WO #' + lgEsc(r2.number) + '</div>' +
        meta.join('') + assigneeLine +
        '<div style="margin-top:10px;color:#475569;">Will post: <b>Billing</b> note "<b>Low GP</b>"' +
        (r2.hasAssignee ? ', then an @-mention to the assignee.' : '.') + '</div></div>' +
        '<button id="lg-apply" style="' + PRIMARY + 'margin-bottom:7px;">' + applyLabel + '</button>' +
        '<button id="lg-cancel" style="' + GHOST + 'width:100%;">Cancel</button>');
      on('#lg-apply', 'click', doApply);
      on('#lg-cancel', 'click', function () { view = st.rows.length > 1 ? 'results' : 'input'; render(); });
    } else if (view === 'posting') {
      h(TITLE + '<div style="padding:8px 2px;color:#64748b;font-size:13px;">Posting notes to WO #' + lgEsc(st.row.number) + '…</div>');
    } else if (view === 'done') {
      var res = st.result, lines = [];
      lines.push('<div style="color:#1a5f3e;">✓ Billing "Low GP" note added to WO #' + lgEsc(st.row.number) + '.</div>');
      if (res.note2) lines.push('<div style="color:#1a5f3e;">✓ ' + lgEsc(st.row.assigneeName || 'Assignee') + ' notified.</div>');
      else if (res.note2skipped) lines.push('<div style="color:#a11;">⚠ No assignee on this WO — nobody was notified.</div>');
      else if (res.note2error) lines.push('<div style="color:#a11;">⚠ Low GP note added, but the @-mention failed: ' + lgEsc(res.note2error) + '</div>');
      h(TITLE + '<div style="font-size:13px;line-height:1.6;margin-bottom:12px;">' + lines.join('') + '</div>' +
        '<button id="lg-again" style="' + PRIMARY + 'margin-bottom:7px;">Add another</button>' +
        '<button id="lg-close" style="' + GHOST + 'width:100%;">Close</button>');
      on('#lg-again', 'click', function () { view = 'input'; st = { query: '', rows: [], row: null, error: '', result: null }; render(); });
      on('#lg-close', 'click', closePanel);
    } else if (view === 'error') {
      h(TITLE + '<div style="color:#a11;font-size:13px;line-height:1.5;margin-bottom:12px;">' + lgEsc(st.error) + '</div>' +
        '<button id="lg-back" style="' + GHOST + 'width:100%;">Back</button>');
      on('#lg-back', 'click', function () { view = 'input'; render(); });
    }
    reposition();
  }

  function doFind() {
    var inp = document.getElementById('lg-q');
    var q = inp ? inp.value.trim() : st.query;
    if (!q) { if (inp) inp.focus(); return; }
    st.query = q; view = 'loading'; render();
    lgSearch(q).then(function (rows) {
      st.rows = rows;
      if (rows.length === 1) { st.row = rows[0]; view = 'confirm'; }
      else { view = 'results'; }
      render();
    }, function (err) { st.error = (err && err.message) || String(err); view = 'error'; render(); });
  }

  function doApply() {
    if (!st.row) return;
    view = 'posting'; render();
    lgApply(st.row).then(function (result) {
      st.result = result; view = 'done'; render();
    }, function (err) { st.error = (err && err.message) || String(err); view = 'error'; render(); });
  }

  // ===== Mount beside the global "Search Work Orders" box =========================================
  function searchBox() {
    var ins = document.querySelectorAll('input[placeholder]');
    for (var i = 0; i < ins.length; i++) {
      var ph = (ins[i].getAttribute('placeholder') || '').trim().toLowerCase();
      if (ph === 'search work orders' && ins[i].getBoundingClientRect().width > 0) return ins[i];
    }
    return null;
  }
  function buildButton() {
    var b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = 'Low GP';
    b.title = 'Add a Billing "Low GP" note to a work order and notify its assignee';
    b.style.cssText = 'margin-left:8px;padding:7px 12px;border:none;border-radius:8px;cursor:pointer;color:#fff;background:' + GREEN + ';font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial;vertical-align:middle;white-space:nowrap;';
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (document.getElementById(PANEL_ID)) closePanel(); else openPanel();
    });
    return b;
  }
  // Walk up from the search box to the first HORIZONTAL flex row wide enough to be the nav cluster,
  // then insert the button just after the search box's own subtree so it sits to its RIGHT. The MUI
  // search lives inside a COLUMN form-control (measured live 2026-08-17) - anchoring on the input's
  // immediate wrapper stacks the button BELOW the pill, so anchor on the row, not the wrapper.
  function mountRef() {
    var box = searchBox();
    if (!box) return null;
    var el = box, hops = 0;
    while (el.parentElement && hops < 8) {
      var parent = el.parentElement, cs = getComputedStyle(parent);
      if (cs.display === 'flex' && cs.flexDirection === 'row' &&
        parent.getBoundingClientRect().width > 300 && parent.children.length > 1) {
        return { row: parent, node: el };
      }
      el = parent; hops++;
    }
    return null;
  }
  function mount() {
    var existing = document.getElementById(BTN_ID);
    if (existing && existing.isConnected) return true;
    var ref = mountRef();
    if (!ref) return false;
    ref.row.insertBefore(buildButton(), ref.node.nextSibling);
    console.info('[BWN LOW GP] button mounted beside "Search Work Orders"');
    return true;
  }

  var pollTimer = null;
  function schedule() {
    if (mount()) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } return; }
    if (pollTimer) return;
    pollTimer = setInterval(function () { if (mount()) { clearInterval(pollTimer); pollTimer = null; } }, 500);
  }
  var obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true });
  schedule();
})();
