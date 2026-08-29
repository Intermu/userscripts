// ==UserScript==
// @name         BWN Suite - Temp-Activate Vendor for PO (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.3.1
// @description  Inside the "Create Purchase Order" modal, adds a "Temp-Activate Vendor" button. Type an inactive vendor's name or number; it finds them, temporarily activates them via Umbrava's own API (reason ALWAYS "Temporary Activation") so they become assignable in the PO. After you assign them and click Create, it watches the PO save and auto-prompts a one-click re-deactivation (reason ALWAYS "Pending Compliance"). A persistent reminder pill keeps the temporarily-active vendor visible until you deactivate, so nobody is left active by mistake. Same-origin /api/graphql with the app's Auth0 bearer, @grant none, zero egress. Every write is one click behind a confirm.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-temp-vendor.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-temp-vendor.user.js
// ==/UserScript==
(function () {
  'use strict';

  var GREEN = 'linear-gradient(135deg,#2ECC71,#1a5f3e)';   // Broadway green (Core's --bwn-green/-dk, inlined for a standalone script)
  var DANGER = '#c0392b';                                   // deactivate = destructive-ish, so it reads red
  var ACT_REASON_NAME = 'Temporary Activation';   // Mike's spec: activation reason is ALWAYS this
  var DEACT_REASON_NAME = 'Pending Compliance';   // Mike's spec: deactivation reason is ALWAYS this
  // Reason ids are resolved by NAME at runtime from vendorActivationReasons/vendorDeactivationReasons
  // (the same lists the modal dropdowns use); these floors only apply if that lookup ever fails.
  // Measured live 2026-08-18: "Temporary Activation" = 3, "Pending Compliance" = 2.
  var ACT_REASON_FLOOR = 3;
  var DEACT_REASON_FLOOR = 2;
  var ACT_NOTE = 'Temporary activation to assign to a purchase order (BWN).';
  var DEACT_NOTE = 'Re-deactivated after purchase-order assignment (BWN).';
  var PEND_KEY = 'bwn:tempVendorPending';   // sessionStorage: survives a re-render / accidental close within the tab

  // ===== Pure helpers ============================================================================
  function tvEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

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

  function tvGql(op, query, variables) {
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

  // ---- BWN-OPS: audited GraphQL wrapper for this sandbox --------------------
  // Routes the vendor activate/deactivate writes through bwnGqlOp (the paste-identical
  // BWN-OPS-WRAP below, SHA-gated to Core): correlation id + shared audit entry + the high-risk
  // confirm gate. tvGql is 3-arg (op,query,variables); this adapter gives the wrapper the uniform
  // bwnGql(query,variables) it calls, recovering the op name from the query. temp-vendor confirms
  // each write in its own panel (vendor + reason spelled out), so it passes confirmed:true.
  function bwnGql(query, variables) { var m = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query); return tvGql(m ? m[1] : null, query, variables); }
  var BWN_VER = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.3.1';
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  var BWN_OPS = {
    activateVendor: { kind: 'write', target: 'vendor', risk: 'high', idempotent: true, retry: 'none',
      ok: 'Vendor activated.', fail: 'The vendor was not activated.' },
    deactivateVendor: { kind: 'write', target: 'vendor', risk: 'moderate', idempotent: true, retry: 'none',
      ok: 'Vendor deactivated.', fail: 'The vendor was not deactivated.' }
  };
  // ===== BWN-OPS-WRAP START v2 (paste-identical across adopters; SHA-gated by scripts/test-bwn-ops.js) =====
  // Generic machinery only - NO registry, NO window hook - so it is byte-identical in every
  // sandbox that adopts it (Core, drop-upload, ...). It closes over four things each sandbox
  // supplies on its own: BWN_OPS (that file's registry), BWN_MODULES (kill switches), BWN_VER,
  // and bwnGql(query, variables) (that file's same-origin transport). The audit ring buffer
  // writes to the shared localStorage key, so every sandbox's writes land in ONE audit trail.
  function bwnCorrId() {
    try { if (window.crypto && window.crypto.randomUUID) return 'bwn-' + window.crypto.randomUUID(); }
    catch (e) { /* fall through to the timestamp form */ }
    return 'bwn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Bounded, PII-free audit ring buffer in localStorage. Records ONLY what the caller passes
  // (ids + scalar before/after) plus operation metadata - NEVER the raw variables or the
  // response, which can carry note text, addresses, or vendor identity.
  var BWN_AUDIT_KEY = 'bwn:audit', BWN_AUDIT_MAX = 200, BWN_AUDIT_SCHEMA = 1;
  function bwnAuditAll() {
    try { var a = JSON.parse(localStorage.getItem(BWN_AUDIT_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function bwnAuditRecord(entry) {
    try {
      var a = bwnAuditAll();
      a.push(entry);
      if (a.length > BWN_AUDIT_MAX) a = a.slice(a.length - BWN_AUDIT_MAX);
      localStorage.setItem(BWN_AUDIT_KEY, JSON.stringify(a));
    } catch (e) { /* audit is best-effort - it must never block or fail a write */ }
    return entry;
  }
  function bwnAuditExport() {
    return JSON.stringify({ schema: BWN_AUDIT_SCHEMA, ver: BWN_VER, exportedTs: Date.now(), entries: bwnAuditAll() }, null, 2);
  }
  function bwnAuditClear() { try { localStorage.removeItem(BWN_AUDIT_KEY); } catch (e) { /* best-effort */ } }
  function bwnAuditActor() {
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      return (r && (r.label || r.role)) || 'unknown';
    } catch (e) { return 'unknown'; }
  }

  // Only a network-level failure is transient. A GraphQL validation error comes back through
  // bwnGql as a thrown Error carrying the server's message (deterministic - retrying just
  // repeats it), and a write refused with success:false is flagged bwnNonTransient below.
  // ponytail: bwnGql does not surface the HTTP status, so 429/5xx are not distinguished here;
  // attach r.status in bwnGql and widen this test if status-aware backoff is ever needed.
  function bwnIsTransient(err) {
    if (err && err.bwnNonTransient) return false;
    return /network|failed to fetch|load failed|timeout|timed out/i.test(String(err && err.message || err));
  }
  function bwnBackoff(tryNo) { return Math.min(4000, 400 * Math.pow(2, tryNo - 1)); }
  function bwnDelay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // bwnGqlOp(op, query, variables, opts) -> Promise(data)
  //   op        BWN_OPS key. THROWS if unregistered - a captured op must be classified before
  //             it can be sent, which is what keeps guessed selectors out of the suite.
  //   query     the captured GraphQL document TEXT - the caller owns it, never invented here.
  //   variables the variables object (sent as-is to bwnGql; never copied into the audit).
  //   opts      { feature, validate, ids, before, after, actor } - all optional:
  //     feature   BWN_MODULES key; if that module is switched off the op is REFUSED and, for a
  //               write, audited outcome:'denied' - this is the per-feature kill switch.
  //     validate  fn(variables) -> true | 'message'; a write is blocked before it is sent.
  //     ids       { wo, po, vendorId, ... } scalar identifiers for the audit trail (NO PII).
  //     before    scalar snapshot of the value(s) about to change (NO PII, NO bulk data).
  //     after     scalar snapshot of the intended new value(s).
  //     actor     who initiated; defaults to the last-known rank label, else 'unknown'.
  // Reads resolve to `data`. A write whose {success,message} envelope says success:false is
  // REJECTED (never a silent false - the exact bug class the op-catalog warns about) and
  // audited outcome:'error'.
  // Injected per-sandbox by a caller that owns a high-risk write's confirmation UI, via
  // bwnGqlOp.setConfirm(fn). A risk:'high' write is refused unless the caller either passes
  // opts.confirmed===true (it confirmed through its own UI) OR a confirm handler returns truthy.
  var _confirmFn = null;
  function bwnGqlOp(op, query, variables, opts) {
    opts = opts || {};
    var meta = BWN_OPS[op];
    if (!meta) return Promise.reject(new Error('bwnGqlOp: unregistered operation "' + op + '"'));
    var isWrite = meta.kind === 'write';
    var corrId = bwnCorrId();
    var t0 = Date.now();
    var actor = opts.actor || bwnAuditActor();

    function writeAudit(outcome, extra) {
      if (!isWrite) return;
      var e = {
        ts: Date.now(), corrId: corrId, op: op, kind: meta.kind, target: meta.target,
        risk: meta.risk || null, actor: actor, ids: opts.ids || null,
        before: (opts.before === undefined ? null : opts.before),
        after: (opts.after === undefined ? null : opts.after),
        outcome: outcome, ms: Date.now() - t0, ver: BWN_VER
      };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]; } }
      bwnAuditRecord(e);
    }

    // Fail-closed write classification (G5): a WRITE must carry a RECOGNIZED risk tier. An
    // unclassified write - a registry entry whose risk is missing or misspelled - is REFUSED here
    // rather than sent unlabelled, so a new mutation cannot slip past the governance by omitting
    // its risk. 'low'/'moderate' skip the confirm gate below; 'high' hits it; anything else fails
    // closed. Reads are unaffected (isWrite guards this). Audited denied so the refusal is visible.
    if (isWrite && meta.risk !== 'low' && meta.risk !== 'moderate' && meta.risk !== 'high') {
      writeAudit('denied', { reason: 'unclassified-write:' + (meta.risk || 'none') });
      return Promise.reject(new Error('bwnGqlOp: write "' + op + '" has no recognized risk classification'));
    }
    // Per-feature kill switch: a disabled module must not mutate even if its UI leaked in.
    if (opts.feature && BWN_MODULES[opts.feature] === false) {
      writeAudit('denied', { reason: 'feature-off:' + opts.feature });
      return Promise.reject(new Error('bwnGqlOp: feature "' + opts.feature + '" is disabled'));
    }
    // Validate a write BEFORE it leaves the browser.
    if (isWrite && typeof opts.validate === 'function') {
      var vr = opts.validate(variables);
      if (vr !== true) {
        writeAudit('denied', { reason: 'validation:' + vr });
        return Promise.reject(new Error('bwnGqlOp: validation failed for "' + op + '": ' + vr));
      }
    }

    var maxTries = (meta.retry === 'safe' && (meta.kind === 'read' || meta.idempotent === true)) ? 3 : 1;
    function attempt(tryNo) {
      return bwnGql(query, variables).then(function (data) {
        if (isWrite) {
          var env = data && data[op];
          // F3: fail closed on an unrecognized write response. A registered write MUST return
          // { success: <bool>, ... } under its own field name (op === the response field name
          // for every adopter). A missing data[op] (a name/alias mismatch) or a non-boolean
          // success means the write cannot be confirmed to have landed - classify it as an
          // error, never a silent 'ok'. Verified safe: every current adopter selects `success`.
          if (!env || typeof env.success !== 'boolean') {
            var badShape = new Error(op + ': unrecognized write response (no {success} under data.' + op + ')');
            badShape.bwnNonTransient = true;
            writeAudit('error', { tries: tryNo, reason: 'unexpected-response-shape' });
            throw badShape;
          }
          if (env && env.success === false) {
            var refused = new Error(env.message || (op + ' was refused'));
            refused.bwnNonTransient = true;
            // F5: record a fixed category, never the server message (env.message can echo
            // input-derived text). The message still rides the thrown `refused` to the caller.
            writeAudit('error', { tries: tryNo, reason: 'write-refused' });
            throw refused;
          }
          writeAudit('ok', { tries: tryNo });
        }
        return data;
      }, function (err) {
        if (bwnIsTransient(err) && tryNo < maxTries) {
          return bwnDelay(bwnBackoff(tryNo)).then(function () { return attempt(tryNo + 1); });
        }
        // F5: audit a fixed category, never the raw error text (which can echo input-derived
        // server strings into the "PII-free" trail). The full error still rides the thrown err
        // to the caller for its toast/log.
        writeAudit('error', { tries: tryNo, reason: bwnIsTransient(err) ? 'transient-failure' : 'request-failed' });
        throw err;
      });
    }
    // High-risk confirmation gate (fail-closed, by construction). F4: a risk:'high' write has
    // NO path to the transport except through this block - it returns in every sub-case (send
    // or reject), so the trailing `return attempt(1)` below is reachable only by non-high-risk
    // ops. A future high-risk writer therefore cannot skip the gate by omission: an absent
    // confirmation is refused, never silently sent. Confirmation is proven EITHER by the
    // caller's own UI (opts.confirmed===true, e.g. dispatch's modal) OR by an injected _confirmFn
    // returning truthy.
    // KNOWN RESIDUAL (flagged, NOT closed here): opts.confirmed===true is a caller assertion the
    // wrapper trusts - it cannot tell a genuine confirm from a hardcoded literal. Closing that
    // would mean dropping bare-boolean trust and mandating an injected _confirmFn, which every
    // current high-risk adopter would fail (none inject one) - a live-behavior change, out of scope.
    if (isWrite && meta.risk === 'high') {
      if (opts.confirmed !== true) {
        if (typeof _confirmFn !== 'function') {
          writeAudit('denied', { reason: 'confirm-required' });
          return Promise.reject(new Error('bwnGqlOp: "' + op + '" is high-risk and needs confirmation (no confirm handler set)'));
        }
        var details = {
          op: op, target: meta.target, risk: meta.risk, ids: opts.ids || null,
          current: (opts.current === undefined ? null : opts.current),
          proposed: (opts.proposed === undefined ? null : opts.proposed),
          count: (opts.count === undefined ? null : opts.count),
          reason: opts.reason || null, irreversible: !!opts.irreversible
        };
        return Promise.resolve().then(function () { return _confirmFn(details); }).then(function (okd) {
          if (!okd) {
            writeAudit('denied', { reason: 'user-cancelled' });
            throw new Error('bwnGqlOp: "' + op + '" cancelled at confirmation');
          }
          return attempt(1);
        });
      }
      return attempt(1);
    }
    return attempt(1);
  }
  bwnGqlOp.setConfirm = function (fn) { _confirmFn = (typeof fn === 'function') ? fn : null; };
  // ===== BWN-OPS-WRAP END v2 =====

  // ---- queries / mutations (introspected + live-verified 2026-08-18) ----
  var Q_LOOKUP = 'query TvLookupVendors($page:PageInput!,$search:String,$includeInactive:Boolean){ lookupVendors(page:$page,search:$search,includeInactive:$includeInactive){ rowCount items{ id number companyName status isDependent } } }';
  var Q_ACT_REASONS = 'query TvActReasons{ vendorActivationReasons(includeInactive:false){ success value{ id value isActive } } }';
  var Q_DEACT_REASONS = 'query TvDeactReasons{ vendorDeactivationReasons(includeInactive:false){ success value{ id value isActive } } }';
  var M_ACTIVATE = 'mutation TvActivateVendor($data:ActivateVendorRequest!){ activateVendor(data:$data){ success message } }';
  var M_DEACTIVATE = 'mutation TvDeactivateVendor($data:DeactivateVendorRequest!){ deactivateVendor(data:$data){ success message } }';

  function tvSearch(text) {
    return tvGql('TvLookupVendors', Q_LOOKUP, { page: { skip: 0, take: 25 }, search: String(text), includeInactive: true })
      .then(function (d) { var l = d && d.lookupVendors; return (l && l.items) ? l.items : []; });
  }

  // Reason id by NAME, cached, floored. kind = 'act' | 'deact'.
  var _reasonCache = {};
  function tvReasonId(kind) {
    if (typeof _reasonCache[kind] === 'number') return Promise.resolve(_reasonCache[kind]);
    var q = kind === 'act' ? Q_ACT_REASONS : Q_DEACT_REASONS;
    var op = kind === 'act' ? 'TvActReasons' : 'TvDeactReasons';
    var want = (kind === 'act' ? ACT_REASON_NAME : DEACT_REASON_NAME).toLowerCase();
    var floor = kind === 'act' ? ACT_REASON_FLOOR : DEACT_REASON_FLOOR;
    return tvGql(op, q, {}).then(function (d) {
      var res = d && (kind === 'act' ? d.vendorActivationReasons : d.vendorDeactivationReasons);
      var list = (res && res.value) ? res.value : [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].value).toLowerCase() === want) { _reasonCache[kind] = list[i].id; return list[i].id; }
      }
      _reasonCache[kind] = floor; return floor;
    }, function () { _reasonCache[kind] = floor; return floor; });
  }

  function tvActivate(vendor) {
    return tvReasonId('act').then(function (rid) {
      // Routed through bwnGqlOp: audit + corrId + the high-risk confirm gate. temp-vendor already
      // confirmed via its panel (vendor + reason spelled out), so it passes confirmed:true; the
      // wrapper owns the success:false rejection.
      return bwnGqlOp('activateVendor', M_ACTIVATE, { data: { vendorId: vendor.id, activationReasonId: rid, notes: ACT_NOTE } }, {
        confirmed: true,
        ids: { vendorId: vendor.id },
        before: { status: 'Inactive' }, after: { status: 'Active' }, reason: ACT_REASON_NAME
      });
    }).then(function (d) {
      return d && d.activateVendor;
    });
  }
  function tvDeactivate(vendor) {
    return tvReasonId('deact').then(function (rid) {
      // Moderate write - routed through bwnGqlOp for the audit trail + centralized success handling.
      return bwnGqlOp('deactivateVendor', M_DEACTIVATE, { data: { vendorId: vendor.id, deactivationReasonId: rid, notes: DEACT_NOTE } }, {
        ids: { vendorId: vendor.id },
        before: { status: 'Active' }, after: { status: 'Inactive' }, reason: DEACT_REASON_NAME
      });
    }).then(function (d) {
      return d && d.deactivateVendor;
    });
  }

  // ===== Pending state (the vendor WE temporarily activated, awaiting re-deactivation) ===========
  // Source of truth for the reminder pill + the PO-save watcher. Persisted to sessionStorage so a
  // panel close / re-render inside the tab never loses the "must deactivate" obligation.
  var pending = null;
  function loadPending() { try { var r = sessionStorage.getItem(PEND_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function savePending(v) {
    pending = v;
    try { if (v) sessionStorage.setItem(PEND_KEY, JSON.stringify(v)); else sessionStorage.removeItem(PEND_KEY); } catch (e) { }
    renderPill();
  }
  pending = loadPending();

  // ===== Panel UI (fixed top-right; one container re-rendered per view) ==========================
  var PANEL_ID = 'bwn-tv-panel';
  var TRIGGER_ID = 'bwn-tv-trigger';
  var PILL_ID = 'bwn-tv-pill';
  var OVERLAY_ID = 'bwn-tv-overlay';
  // view: input | loading | results | confirm | activating | armed | deactconfirm | deactivating | done | error
  var view = 'input';
  var st = { query: '', rows: [], vendor: null, error: '', doneMsg: '' };

  function isBusy() { return view === 'activating' || view === 'deactivating'; }

  function closePanel() {
    var o = document.getElementById(OVERLAY_ID);
    if (o) o.remove();
    var c = document.getElementById(PANEL_ID);
    if (c) c.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape' && !isBusy()) { e.preventDefault(); closePanel(); } }

  // Umbrava's Create-PO dialog is a react-aria modal: it marks every OTHER subtree `inert` AND traps
  // focus inside itself, so a floating panel on document.body can be neither clicked nor typed into
  // (proven live). So while the dialog is OPEN we render the panel INLINE, as a real child of the
  // dialog - inside the focus scope, non-inert, normally positioned (real click + keyboard verified).
  // When NO dialog is open (the post-save re-deactivate prompt, or a pill click) we render a normal
  // centered modal on body, where there are no such barriers.
  function openPanel(startView) {
    closePanel();
    view = startView || 'input';
    if (view === 'input') st = { query: '', rows: [], vendor: null, error: '', doneMsg: '' };
    var dlg = poModal();
    var p = document.createElement('div');
    p.id = PANEL_ID;
    if (dlg) {
      p.style.cssText = 'margin:12px 0;padding:14px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;box-shadow:0 8px 22px rgba(0,0,0,.14);color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
      var trig = document.getElementById(TRIGGER_ID);
      if (trig && trig.parentElement && trig.parentElement.parentElement) {
        trig.parentElement.parentElement.insertBefore(p, trig.parentElement.nextSibling);   // right below the button
      } else {
        var content = dlg.querySelector('form') || dlg;
        content.insertBefore(p, content.firstChild);
      }
      render();
      p.scrollIntoView({ block: 'nearest' });
    } else {
      var o = document.createElement('div');
      o.id = OVERLAY_ID;
      o.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483600;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding:8vh 12px 12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
      p.style.cssText = 'width:380px;max-width:calc(100vw - 24px);max-height:84vh;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:16px;color:#1e293b;';
      o.appendChild(p);
      o.addEventListener('mousedown', function (e) { e.stopPropagation(); if (e.target === o && !isBusy()) closePanel(); });
      o.addEventListener('click', function (e) { e.stopPropagation(); });
      document.body.appendChild(o);
      render();
    }
    document.addEventListener('keydown', onKey, true);
  }

  function h(html) { var p = document.getElementById(PANEL_ID); if (p) p.innerHTML = html; return p; }
  function on(sel, ev, fn) { var p = document.getElementById(PANEL_ID); if (!p) return; var el = p.querySelector(sel); if (el) el.addEventListener(ev, fn); }
  function onAll(sel, ev, fn) { var p = document.getElementById(PANEL_ID); if (!p) return; [].forEach.call(p.querySelectorAll(sel), function (el) { el.addEventListener(ev, fn); }); }

  // Single-quote font families: these strings go into innerHTML style="..." attributes, so a double
  // quote inside would terminate the attribute and void the whole style.
  var TITLE = '<div style="font:700 13px/1.2 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;color:#1a5f3e;margin-bottom:10px;">Temp-Activate Vendor</div>';
  var BTN_CSS = 'padding:9px 12px;border:none;border-radius:8px;cursor:pointer;font:600 13px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;';
  var PRIMARY = BTN_CSS + 'color:#fff;background:' + GREEN + ';width:100%;';
  var GHOST = BTN_CSS + 'color:#475569;background:#f1f5f9;';
  var REDBTN = BTN_CSS + 'color:#fff;background:' + DANGER + ';width:100%;';

  function render() {
    if (view === 'input') {
      h(TITLE +
        '<div style="font-size:12px;color:#64748b;margin-bottom:8px;line-height:1.4;">Find an inactive vendor to temporarily activate so you can assign them to this PO.</div>' +
        '<input id="tv-q" type="text" placeholder="Vendor name or number (e.g. 27606)" ' +
        'style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;font:400 13px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;margin-bottom:10px;" />' +
        '<button id="tv-find" style="' + PRIMARY + '">Find vendor</button>');
      var inp = document.getElementById('tv-q');
      if (inp) { inp.value = st.query; inp.focus(); }
      on('#tv-find', 'click', doFind);
      on('#tv-q', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doFind(); } });

    } else if (view === 'loading') {
      h(TITLE + '<div style="padding:8px 2px;color:#64748b;font-size:13px;">Searching for "' + tvEsc(st.query) + '"…</div>');

    } else if (view === 'results') {
      if (!st.rows.length) {
        h(TITLE + '<div style="padding:4px 2px 12px;color:#334155;font-size:13px;">No vendor found for "' + tvEsc(st.query) + '".</div>' +
          '<button id="tv-back" style="' + GHOST + 'width:100%;">Back</button>');
        on('#tv-back', 'click', function () { view = 'input'; render(); });
      } else {
        var rowsHtml = st.rows.map(function (r, i) {
          var active = String(r.status).toLowerCase() === 'active';
          var badge = active
            ? '<span style="color:#166534;background:#dcfce7;border-radius:6px;padding:1px 6px;font-size:11px;">Active</span>'
            : '<span style="color:#991b1b;background:#fee2e2;border-radius:6px;padding:1px 6px;font-size:11px;">Inactive</span>';
          return '<button class="tv-pick" data-i="' + i + '" style="display:block;width:100%;box-sizing:border-box;text-align:left;padding:9px 10px;margin-bottom:6px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font:400 12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial;">' +
            '<span style="font-weight:700;color:#1a5f3e;">' + tvEsc(r.companyName) + '</span> ' + badge +
            '<br><span style="color:#64748b;">Vendor #' + tvEsc(r.number) + '</span></button>';
        }).join('');
        h(TITLE + '<div style="color:#64748b;font-size:11px;margin-bottom:8px;">' + st.rows.length + ' match' + (st.rows.length === 1 ? '' : 'es') + ' for "' + tvEsc(st.query) + '" — pick one:</div>' +
          rowsHtml + '<button id="tv-back" style="' + GHOST + 'width:100%;margin-top:2px;">Back</button>');
        onAll('.tv-pick', 'click', function (e) {
          var i = parseInt(e.currentTarget.getAttribute('data-i'), 10);
          st.vendor = st.rows[i]; view = 'confirm'; render();
        });
        on('#tv-back', 'click', function () { view = 'input'; render(); });
      }

    } else if (view === 'confirm') {
      var v = st.vendor;
      var alreadyActive = String(v.status).toLowerCase() === 'active';
      if (alreadyActive) {
        h(TITLE +
          '<div style="font-size:13px;line-height:1.5;margin-bottom:12px;">' +
          '<div style="font-weight:700;color:#1a5f3e;font-size:15px;">' + tvEsc(v.companyName) + '</div>' +
          '<div style="color:#64748b;">Vendor #' + tvEsc(v.number) + '</div>' +
          '<div style="color:#166534;margin-top:8px;">This vendor is already <b>Active</b> — no temporary activation needed. Just select them in the PO\'s <b>Assign Vendor</b> field.</div></div>' +
          '<button id="tv-back" style="' + GHOST + 'width:100%;">Back</button>');
        on('#tv-back', 'click', function () { view = st.rows.length > 1 ? 'results' : 'input'; render(); });
      } else {
        h(TITLE +
          '<div style="font-size:13px;line-height:1.5;margin-bottom:12px;">' +
          '<div style="font-weight:700;color:#1a5f3e;font-size:15px;">' + tvEsc(v.companyName) + '</div>' +
          '<div style="color:#64748b;">Vendor #' + tvEsc(v.number) + ' · <span style="color:#991b1b;">Inactive</span></div>' +
          '<div style="margin-top:10px;color:#475569;">Will activate with reason <b>' + tvEsc(ACT_REASON_NAME) + '</b>. After you assign them to the PO and click Create, you\'ll be prompted to re-deactivate (reason <b>' + tvEsc(DEACT_REASON_NAME) + '</b>).</div></div>' +
          '<button id="tv-act" style="' + PRIMARY + 'margin-bottom:7px;">Activate temporarily</button>' +
          '<button id="tv-cancel" style="' + GHOST + 'width:100%;">Cancel</button>');
        on('#tv-act', 'click', doActivate);
        on('#tv-cancel', 'click', function () { view = st.rows.length > 1 ? 'results' : 'input'; render(); });
      }

    } else if (view === 'activating') {
      h(TITLE + '<div style="padding:8px 2px;color:#64748b;font-size:13px;">Activating ' + tvEsc(st.vendor.companyName) + '…</div>');

    } else if (view === 'armed') {
      var a = pending || st.vendor;
      h(TITLE +
        '<div style="font-size:13px;line-height:1.5;margin-bottom:12px;">' +
        '<div style="color:#166534;font-weight:700;">✓ ' + tvEsc(a.companyName) + ' is now ACTIVE (temporary).</div>' +
        '<div style="color:#475569;margin-top:8px;">Now in the PO: open <b>Assign Vendor</b> (or click <b>Find</b>), select <b>' + tvEsc(a.companyName) + '</b>, set the NTE, and click <b>Create</b>.</div>' +
        '<div style="color:#475569;margin-top:8px;">I\'ll auto-prompt you to re-deactivate when the PO saves. If it doesn\'t catch it, use the button below.</div></div>' +
        '<button id="tv-deact" style="' + REDBTN + 'margin-bottom:7px;">Deactivate now (' + tvEsc(DEACT_REASON_NAME) + ')</button>' +
        '<button id="tv-close" style="' + GHOST + 'width:100%;">Close (stay armed)</button>');
      on('#tv-deact', 'click', doDeactivate);
      on('#tv-close', 'click', closePanel);

    } else if (view === 'deactconfirm') {
      var dv = pending || st.vendor;
      h(TITLE +
        '<div style="font-size:13px;line-height:1.5;margin-bottom:12px;">' +
        '<div style="font-weight:700;color:#1a5f3e;">PO saved with ' + tvEsc(dv.companyName) + '.</div>' +
        '<div style="color:#475569;margin-top:8px;">Re-deactivate them now with reason <b>' + tvEsc(DEACT_REASON_NAME) + '</b>?</div></div>' +
        '<button id="tv-deact" style="' + REDBTN + 'margin-bottom:7px;">Deactivate (' + tvEsc(DEACT_REASON_NAME) + ')</button>' +
        '<button id="tv-keep" style="' + GHOST + 'width:100%;">Keep active for now</button>');
      on('#tv-deact', 'click', doDeactivate);
      on('#tv-keep', 'click', function () { view = 'armed'; render(); });

    } else if (view === 'deactivating') {
      h(TITLE + '<div style="padding:8px 2px;color:#64748b;font-size:13px;">Deactivating ' + tvEsc((pending || st.vendor).companyName) + '…</div>');

    } else if (view === 'done') {
      h(TITLE + '<div style="color:#1a5f3e;font-size:13px;line-height:1.6;margin-bottom:12px;">' + st.doneMsg + '</div>' +
        '<button id="tv-again" style="' + PRIMARY + 'margin-bottom:7px;">Temp-activate another</button>' +
        '<button id="tv-close" style="' + GHOST + 'width:100%;">Close</button>');
      on('#tv-again', 'click', function () { openPanel('input'); });
      on('#tv-close', 'click', closePanel);

    } else if (view === 'error') {
      h(TITLE + '<div style="color:#a11;font-size:13px;line-height:1.5;margin-bottom:12px;">' + tvEsc(st.error) + '</div>' +
        '<button id="tv-back" style="' + GHOST + 'width:100%;">Back</button>');
      on('#tv-back', 'click', function () { view = pending ? 'armed' : 'input'; render(); });
    }
  }

  function doFind() {
    var inp = document.getElementById('tv-q');
    var q = inp ? inp.value.trim() : st.query;
    if (!q) { if (inp) inp.focus(); return; }
    st.query = q; view = 'loading'; render();
    tvSearch(q).then(function (rows) {
      st.rows = rows;
      if (rows.length === 1) { st.vendor = rows[0]; view = 'confirm'; }
      else { view = 'results'; }
      render();
    }, function (err) { st.error = (err && err.message) || String(err); view = 'error'; render(); });
  }

  function doActivate() {
    if (!st.vendor) return;
    view = 'activating'; render();
    tvActivate(st.vendor).then(function () {
      savePending({ id: st.vendor.id, number: st.vendor.number, companyName: st.vendor.companyName });
      view = 'armed'; render();
    }, function (err) { st.error = (err && err.message) || String(err); view = 'error'; render(); });
  }

  function doDeactivate() {
    var v = pending || st.vendor;
    if (!v) return;
    view = 'deactivating'; render();
    tvDeactivate(v).then(function () {
      st.doneMsg = '✓ ' + tvEsc(v.companyName) + ' deactivated (' + tvEsc(DEACT_REASON_NAME) + ').';
      savePending(null);
      view = 'done'; render();
    }, function (err) { st.error = (err && err.message) || String(err); view = 'error'; render(); });
  }

  // ===== PO-save watcher: hook fetch, auto-prompt deactivation when the temp vendor lands on a PO ==
  // Only acts while a temp activation is pending, and only when the outgoing /api/graphql request
  // both carries our vendor's id AND is a purchase-order create/assign. The actual deactivation is
  // still one click behind a confirm; this only decides WHEN to surface it.
  (function installHook() {
    if (window.__bwnTempVendorHook) return;
    window.__bwnTempVendorHook = true;
    try {
      var of = window.fetch;
      if (typeof of !== 'function') return;
      window.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        var body = (init && init.body) || (input && input.body) || null;
        var p = of.apply(this, arguments);
        try {
          if (pending && typeof body === 'string' && /\/api\/graphql\b/.test(url) &&
            body.indexOf(pending.id) !== -1 && /purchaseOrder/i.test(body) && /(addEdit|assign|create)/i.test(body)) {
            p.then(function (res) {
              try {
                res.clone().json().then(function (j) {
                  if (j && !(j.errors && j.errors.length)) onPoCreated();
                }, function () { onPoCreated(); });   // clone/parse failed: prompt anyway, user can decline
              } catch (e) { onPoCreated(); }
              return res;
            }, function () { });
          }
        } catch (e) { }
        return p;
      };
    } catch (e) { }
  })();

  function onPoCreated() {
    if (!pending) return;
    if (view === 'deactconfirm' || view === 'deactivating' || view === 'done') return;   // already prompting/handled
    // Let Umbrava close the PO dialog first, then prompt on body (no modal open = not inert).
    setTimeout(function () { if (pending && view !== 'deactivating' && view !== 'done') openPanel('deactconfirm'); }, 800);
  }

  // ===== Reminder pill (persistent while a temp activation is pending) ===========================
  function renderPill() {
    var existing = document.getElementById(PILL_ID);
    if (!pending) { if (existing) existing.remove(); return; }
    if (existing) {
      var lbl = existing.querySelector('.tv-pill-name');
      if (lbl) lbl.textContent = pending.companyName;
      return;
    }
    var pill = document.createElement('button');
    pill.id = PILL_ID;
    pill.type = 'button';
    pill.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147482000;max-width:320px;padding:10px 14px;border:none;border-radius:10px;cursor:pointer;color:#fff;background:' + DANGER + ';box-shadow:0 8px 22px rgba(0,0,0,.25);font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial;text-align:left;line-height:1.35;';
    pill.innerHTML = '⚠ <span class="tv-pill-name"></span> is temporarily <b>ACTIVE</b><br><span style="font-weight:400;opacity:.9;">Click to deactivate (' + tvEsc(DEACT_REASON_NAME) + ')</span>';
    pill.querySelector('.tv-pill-name').textContent = pending.companyName;
    pill.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPanel('deactconfirm'); });
    document.body.appendChild(pill);
  }

  // ===== Mount the trigger button inside the "Create Purchase Order" modal =======================
  // The modal title text is the anchor. Guard against re-mount, and against a partly-built dialog.
  function elWithText(root, re) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.children.length === 0 && re.test((e.textContent || '').trim())) return e;
    }
    return null;
  }
  function poModal() {
    var dialogs = document.querySelectorAll('[role="dialog"], .MuiDialog-container');
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i];
      if (d.getBoundingClientRect().width === 0) continue;
      if (elWithText(d, /^create purchase order$/i)) return d;
    }
    return null;
  }
  function findButtonIn(d, re) {
    var btns = d.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (re.test((btns[i].textContent || '').trim())) return btns[i];
    }
    return null;
  }
  function buildTrigger() {
    var b = document.createElement('button');
    b.id = TRIGGER_ID;
    b.type = 'button';
    b.textContent = 'Temp-Activate Vendor';
    b.title = 'Temporarily activate an inactive vendor so you can assign them to this PO, then re-deactivate after.';
    b.style.cssText = 'margin:8px 0 0;padding:8px 12px;border:none;border-radius:8px;cursor:pointer;color:#fff;background:' + GREEN + ';font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial;white-space:nowrap;';
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (document.getElementById(PANEL_ID)) closePanel();
      else openPanel(pending ? 'armed' : 'input');
    });
    return b;
  }
  function mount() {
    var existing = document.getElementById(TRIGGER_ID);
    if (existing && existing.isConnected) return true;
    var d = poModal();
    if (!d) return false;
    var btn = buildTrigger();
    var findBtn = findButtonIn(d, /^find$/i);
    var wrap = document.createElement('div');
    wrap.style.cssText = 'width:100%;margin-top:6px;';
    wrap.appendChild(btn);
    // The Assign Vendor row is the flex stack two levels up from the native "Find" button
    // (button -> MuiBox -> MuiStack row). Drop our button on its OWN full-width line just after
    // that row (before Vendor NTE), verified live against the real modal DOM 2026-08-18.
    var stack = findBtn && findBtn.parentElement && findBtn.parentElement.parentElement;
    if (stack && stack.parentElement) {
      stack.parentElement.insertBefore(wrap, stack.nextSibling);
    } else {
      (d.querySelector('.MuiDialogContent-root') || d).appendChild(wrap);
    }
    console.info('[BWN TEMP-VENDOR] trigger mounted in the Create Purchase Order modal');
    return true;
  }

  var pollTimer = null;
  function schedule() {
    mount();   // modal comes and goes; keep trying, but don't stop the observer (unlike a one-shot nav button)
  }
  // Trailing debounce (RM-B5): coalesce the SPA re-render bursts instead of firing on every mutation.
  var obsT = null;
  var obs = new MutationObserver(function () { clearTimeout(obsT); obsT = setTimeout(schedule, 300); });
  obs.observe(document.body, { childList: true, subtree: true });
  // poll fallback (React can fill the modal without a body mutation the observer sees)
  pollTimer = setInterval(schedule, 700);
  schedule();
  renderPill();   // if a prior temp activation is still pending in this tab, surface it immediately
})();
