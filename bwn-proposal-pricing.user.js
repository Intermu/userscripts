// ==UserScript==
// @name         BWN Proposal Pricing (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-pricing.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-pricing.user.js
// @description  Prices a work order's vendor quote into a client-ready proposal. Reads the WO header, its purchase orders, every vendor quote WITH its line items, the client's contracted rate card and any existing client proposals - all DIRECTLY from Umbrava's GraphQL API in-page using your live session, no pasted token and no MCP. Vendor costs and cost categories are the vendor's own; gross profit is computed on Umbrava's PRE-TAX basis (subtotal - vendorCost) so the number agrees with the platform. Rate matching calls Umbrava's own rateMatches with the crew size read out of the vendor's line text, and refuses to price a lump-sum line until you supply the real quantity rather than inventing one. Optional AI (emailed-quote parse, photo read, client-facing verbiage) rides the broadway-internal-ops SWA api/ai route, x-bwn-key gated with the model key server-side, manager-gated. Push-to-draft replays Umbrava's own createDraftProposal + editProposal through the audited write wrapper; it never submits, approves or sends.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.1.0';   // keep in step with @version
  console.info('[BWN PROPOSAL PRICING] v' + VER + ' - price a WO vendor quote into a client proposal (contracted rates + pre-tax GP)');

  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var AI_URL = SWA_BASE + '/api/ai';
  var GREEN = '#1a5f3e';
  var DOCK_KEY = 'proposal-pricing';
  var MIN_RANK = 4;            // manager+, same gate as proposal-copy / proposal-actions

  // The live WO detail route is /work-orders/<n>/details - an anchored /work-orders/<n> test
  // would match nothing forever and read as "the tool is off" ([[dom-handle-protocol]]).
  // This tool is WO-LEVEL (it consumes the whole WO and emits a proposal), so it is reachable
  // from any Umbrava route via the dock and only needs a WO number when one is on screen.
  function woNumberFromPath() {
    var m = /\/work-orders\/(\d+)/.exec(location.pathname || '');
    return m ? parseInt(m[1], 10) : null;
  }

  // RM-B2 error-reporter adoption: a bounded, PII-FREE bwn:errlog breadcrumb via Core's
  // window.bwnReport. Scalar ids + a short fixed stage code ONLY - never a line item, an amount,
  // a client name, a scope body or the error text. Core absent or the flag OFF is a no-op.
  function reportFail(o) { try { if (typeof window.bwnReport === 'function') window.bwnReport(o); } catch (e) { } }

  // --- bwnFocusTrap: shared a11y focus manager for the BWN drawer-modal family (RM-B3 / ACC1) ---
  // Sandboxes can't share a runtime object across the @grant boundary (see Core's BWN block), so
  // each drawer-modal carries this BYTE-IDENTICAL copy; scripts/test-a11y-focus.js asserts the
  // copies stay identical (drift guard) and runs the behaviour. On open it records the
  // previously-focused element and, if focus is not already inside, moves it to the first
  // focusable. It traps Tab / Shift-Tab within the modal's focusables. It self-releases when the
  // modal gains .bwn-closing (the drawer exit contract) or leaves the DOM, restoring focus to the
  // opener. Idempotent; returns release and also stashes it on el._bwnFocusRelease. Call it AFTER
  // the modal is in the DOM and BEFORE the module's own initial .focus(), so the recorded element
  // is the real opener, not an inner field.
  function bwnFocusTrap(modalEl) {
    if (!modalEl || !modalEl.addEventListener) return function () { };
    var SEL = 'a[href],area[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[contenteditable=""]';
    var prev = document.activeElement;
    var released = false, mo = null, pmo = null;
    function visible(el) { return el.offsetWidth > 0 || el.offsetHeight > 0 || (el.getClientRects && el.getClientRects().length > 0); }
    function focusables() { return [].slice.call(modalEl.querySelectorAll(SEL)).filter(visible); }
    function onKey(e) {
      if (e.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey) { if (a === first || !modalEl.contains(a)) { e.preventDefault(); last.focus(); } }
      else if (a === last || !modalEl.contains(a)) { e.preventDefault(); first.focus(); }
    }
    function release() {
      if (released) return; released = true;
      try { modalEl.removeEventListener('keydown', onKey, true); } catch (e) { }
      try { if (mo) mo.disconnect(); } catch (e) { }
      try { if (pmo) pmo.disconnect(); } catch (e) { }
      if (modalEl._bwnFocusRelease === release) modalEl._bwnFocusRelease = null;
      try { if (prev && prev.focus && prev.isConnected !== false) prev.focus(); } catch (e) { }
    }
    modalEl.addEventListener('keydown', onKey, true);
    modalEl._bwnFocusRelease = release;
    try {
      mo = new MutationObserver(function () { if (modalEl.classList && modalEl.classList.contains('bwn-closing')) release(); });
      mo.observe(modalEl, { attributes: true, attributeFilter: ['class'] });
      if (modalEl.parentNode) {
        pmo = new MutationObserver(function (recs) {
          for (var i = 0; i < recs.length; i++) {
            var rm = recs[i].removedNodes || [];
            for (var j = 0; j < rm.length; j++) { if (rm[j] === modalEl) { release(); return; } }
          }
        });
        pmo.observe(modalEl.parentNode, { childList: true });
      }
    } catch (e) { }
    if (!modalEl.contains(document.activeElement)) {
      var f0 = focusables();
      if (f0.length) { try { f0[0].focus(); } catch (e) { } }
      else { try { if (!modalEl.hasAttribute('tabindex')) modalEl.setAttribute('tabindex', '-1'); modalEl.focus(); } catch (e) { } }
    }
    return release;
  }

  function drawerDismiss(el) {
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    if (reduce) { el.remove(); return; }
    el.removeAttribute('id'); el.setAttribute('aria-hidden', 'true');   // id freed now: a reopen builds a fresh node
    el.classList.add('bwn-closing');
    setTimeout(function () { try { el.remove(); } catch (e) { } }, 170);
  }

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

  // ===== BWN-PERM START v1 (paste-identical; pinned by scripts/test-perm-block-ledger.js) =====
  // Umbrava's own per-user permission checkboxes, as the one question a control has:
  //   bwnCan('WorkOrderNote.AddNew') -> true | false
  // Umbrava returns me.permissions as a JSON STRING of {"<Type>Permissions": "<bitmask>"} - one
  // bit per checkbox on /company/users/<id>/permissions. bwn-suite-core decodes it once a session
  // and publishes the DECODED grant list to `bwn:perm:last` + the `bwn:perm` bus event, the same
  // one-way producer/consumer shape as bwn:role. This block only READS that slot, so every
  // sandbox that pastes it needs neither the query, the token, nor the flag numbers.
  //
  // FAIL-OPEN on anything unknown - no slot yet, a stale slot, or a group the producer does not
  // map. Umbrava's server is the real boundary (it refuses the mutation either way), so an
  // unreadable cache must never strand a coordinator mid-shift. Fail-CLOSED only on a
  // positively-known missing bit. localStorage is per-origin, so this answers "unknown" (and
  // therefore allows) anywhere but app.umbrava.com - by design.
  var BWN_PERM_KEY = 'bwn:perm:last';
  var BWN_PERM_TTL_MS = 24 * 3600 * 1000;
  var _bwnPermSlot = null;      // memoized parse; invalidated by the bwn:perm listener below
  function bwnPermSlot() {
    if (_bwnPermSlot) return _bwnPermSlot;
    try {
      var p = JSON.parse(localStorage.getItem(BWN_PERM_KEY) || 'null');
      if (p && p.ts && (Date.now() - p.ts) < BWN_PERM_TTL_MS &&
        Array.isArray(p.groups) && Array.isArray(p.granted)) _bwnPermSlot = p;
    } catch (e) { /* an unreadable cache reads as unknown, which fails open */ }
    return _bwnPermSlot;
  }
  function bwnCan(key) {
    var p = bwnPermSlot();
    if (!p) return true;                                          // nothing decoded yet -> allow
    var grp = String(key).split('.')[0];
    if (p.groups.indexOf(grp) === -1) return true;                // group unmapped/absent -> allow
    return p.granted.indexOf(key) !== -1;
  }
  // keys: a 'Group.Flag' string, or an array of them (ALL must be granted).
  function bwnCanAll(keys) {
    if (!keys) return true;
    if (typeof keys === 'string') return bwnCan(keys);
    for (var i = 0; i < keys.length; i++) { if (!bwnCan(keys[i])) return false; }
    return true;
  }
  // patchWorkOrder is ONE mutation over MANY fields and Umbrava gates each field separately, so
  // its permission depends on the variables rather than the operation. This maps the data keys the
  // suite actually sends, all of them wire-proven; a key this map does not know contributes NO
  // requirement, which is the block's unknown -> allow rule and keeps a future field from being
  // blocked by a map nobody updated. `workOrderNumber` is the identifier, not a field write.
  var BWN_PATCH_FIELD_PERM = {
    statusId: 'WorkOrderField.Status',
    assignedTo: 'WorkOrderField.AssignedTo',
    // ECD rides inside the whole-object `priority` replace, and the SPA bundles the SLA id with it.
    priority: 'WorkOrderField.CompletionSLA',
    serviceLevelAgreementId: 'WorkOrderField.CompletionSLA',
    sourceJobNumber: 'WorkOrderField.SourceJobNumber',
    sourcePurchaseOrderNumber: 'WorkOrderField.SourcePurchaseOrderNumber'
  };
  // -> [] | ['WorkOrderField.Status', ...]; deduped, so a bundled priority+SLA asks once.
  function bwnPermsForPatch(variables) {
    var data = (variables && variables.data) || {};
    var out = [];
    Object.keys(data).forEach(function (k) {
      var p = BWN_PATCH_FIELD_PERM[k];
      if (p && out.indexOf(p) === -1) out.push(p);
    });
    return out;
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:perm') _bwnPermSlot = null;          // a fresh decode landed
    });
  } catch (e) { }
  // ===== BWN-PERM END v1 =====

  // ---- same-origin GraphQL transport ---------------------------------------
  // Plain fetch to /api/graphql carrying the page's own Auth0 bearer. No @connect, no key, no
  // pasted token - the whole reason this is a userscript and not the standalone HTML tool
  // ([[wo-audit-automation]] "the MCP wall").
  function ppGql(op, query, variables) {
    var tok = authToken();
    if (!tok) return Promise.reject(new Error('no-umbrava-token'));
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
  // The two push-to-draft writes go through bwnGqlOp (the paste-identical BWN-OPS-WRAP below,
  // SHA-gated to Core): a correlation id, the shared bwn:audit entry, the Umbrava permission
  // gate, the fail-closed high-risk confirm gate, and centralized success:false rejection.
  // bwnGql wraps this file's 3-arg ppGql, recovering the SPA operation name (the document's
  // second token) without a regex. Reads stay on ppGql directly. BWN_VER uses a typeof guard so
  // the node harnesses (which slice pure blocks without VER in scope) still load.
  var bwnGql = function (query, variables) {
    var q = String(query), i = 0, n = q.length;
    while (i < n && q.charAt(i) <= ' ') i++;
    while (i < n && q.charAt(i) > ' ') i++;
    while (i < n && q.charAt(i) <= ' ') i++;
    var j = i;
    while (j < n) { var c = q.charAt(j); if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_') j++; else break; }
    return ppGql(q.slice(i, j) || null, query, variables);
  };
  var BWN_VER = (typeof VER !== 'undefined') ? VER : '0.1.0';
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  var BWN_OPS = {
    createDraftProposal: { kind: 'write', perm: 'WorkOrderProposal.AddNew', target: 'proposal', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Draft proposal created.', fail: 'The draft proposal was not created.' },
    editProposal: { kind: 'write', perm: 'WorkOrderProposal.EditFields', target: 'proposal', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Proposal priced.', fail: 'The proposal was not priced.' }
  };
  // ===== BWN-OPS-WRAP START v3 (paste-identical across adopters; SHA-gated by scripts/test-bwn-ops.js) =====
  // v3 (2026-09-02) adds the Umbrava permission gate (G7 below). It closes over bwnCan/bwnCanAll
  // from the BWN-PERM block, so an adopter of this wrapper must carry that block too - the ledger
  // in scripts/test-perm-block-ledger.js is what keeps the two lists in step.
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
    // Umbrava permission gate (G7). The UI hides a control the operator's checkboxes do not cover,
    // but hiding is not enforcement: a palette entry, a stale drawer, a queued command, or a future
    // caller can all reach a write whose button was never rendered. This is the enforcement point -
    // every registered write passes through here, so ONE guard covers every caller.
    //   meta.perm  'Group.Flag' | ['Group.Flag', ...] | fn(variables) -> either of those
    // A function is how a multi-field mutation (patchWorkOrder) asks per FIELD instead of per op.
    // bwnCanAll fails OPEN on anything undecided - no slot, a stale slot, an unmapped group - so
    // this refuses ONLY a positively-known missing checkbox. Refusals are non-transient (retrying
    // cannot grant a permission) and audited `denied`, so a refusal is visible in the ring rather
    // than silent. The reason carries the permission NAME, which is a static key, never user data.
    if (isWrite && meta.perm) {
      var need = (typeof meta.perm === 'function') ? meta.perm(variables) : meta.perm;
      if (typeof need === 'string') need = [need];
      if (!Array.isArray(need)) need = [];
      if (need.length && !bwnCanAll(need)) {
        var missing = need.filter(function (k) { return !bwnCan(k); });
        writeAudit('denied', { reason: 'permission:' + missing.join('+') });
        var noPerm = new Error('bwnGqlOp: "' + op + '" needs Umbrava permission ' + missing.join(' + ') + ' - the write was NOT sent.');
        noPerm.bwnNonTransient = true;
        noPerm.bwnPermissionDenied = missing;
        return Promise.reject(noPerm);
      }
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
  // ===== BWN-OPS-WRAP END v3 =====

  // ===== bwnAI v1 - shared suite-wide AI router - KEEP IN SYNC across suite scripts =====
  // Single tiered helper (spec: [[bwn-ai-tiering]]). Generalizes this module's original
  // on-device aiSummary into a router every module can call the same way. Three tiers:
  //   local    - a module-supplied mechanical fn (no model). Always-available floor.
  //   ondevice - Chrome's built-in Prompt API (Gemini Nano). Free, zero-egress, no key,
  //              @grant none. Everyone. Good for summaries/labels/short classification.
  //   proxy    - one SERVER key behind the bwn-ai SWA (Claude/Haiku). Rank-gated to
  //              managers+ (BWN_AI_ADVANCED_MIN_RANK, default 4). The network transport
  //              is INJECTED by a grant-holding script via bwnAI.setProxy(fn); modules
  //              that are @grant none (this one) never attempt it - proxy simply misses
  //              and the router falls through to on-device / local.
  // Contract: async, self-bounded by timeoutMs, ALWAYS resolves (never throws), returns
  // '' (or the local result) on any miss. Paste this block verbatim into any module that
  // needs AI; only put the block here, never a key. This is UX/cost routing - the SERVER
  // re-enforces the rank on the proxy tier (403 ROLE_REQUIRED, treated here as a miss).
  var bwnAI = (function () {
    var TASK_TIER = { summarize: 'ondevice', classify: 'ondevice', draft: 'proxy', render: 'proxy' };
    var TASK_ONELINE = { summarize: true, classify: true };
    var TASK_SYSTEM = {
      summarize: 'Summarize the input into a single plain-text line (<=200 chars). No greeting, no sign-off, no preamble, no quotes - output only the one line.',
      classify: 'Classify the input. Respond with ONLY a short label of a few words - no explanation, no punctuation beyond the label.',
      draft: 'Draft a short, professional message for a facilities coordinator. Clear and courteous. Output only the message body - no preamble.',
      render: 'Synthesize the provided work-order details into a clear, well-structured plain-text brief for a facilities coordinator. Output only the brief.'
    };
    var ROLE_TTL_MS = 6 * 3600 * 1000;   // trust the cross-refresh role slot this long

    // ---- Rank read (client, cost/UX only - the server is the real gate) ----------
    // @grant-none-safe: the AI script resolves the SERVER-computed rank once per session
    // ([[umbrava-role-auth]]) and publishes it on the `bwn:role` bus event + the
    // localStorage `bwn:role:last` slot. A live bus event is trusted directly; the slot
    // is the cross-refresh fallback, trusted only when marked ok + fresh. Never re-fetches.
    var _liveRank = null;
    try {
      document.addEventListener('bwn:evt', function (e) {
        var d = e && e.detail;
        if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _liveRank = d.rank;
      });
    } catch (e) { /* no document (worker) - rank stays unknown -> on-device */ }
    function rank() {
      if (typeof _liveRank === 'number') return _liveRank;
      try {
        var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
        if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank;
      } catch (e2) { }
      return null;
    }

    // ---- On-device (Chrome built-in Prompt API) -----------------------------------
    function langModel() {
      // The Prompt API surface has shifted across Chrome versions; probe the globals.
      var g = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : null);
      if (typeof LanguageModel !== 'undefined' && LanguageModel) return LanguageModel;
      if (g && g.LanguageModel) return g.LanguageModel;
      if (g && g.ai && g.ai.languageModel) return g.ai.languageModel;   // older window.ai shape
      return null;
    }
    function ready(api) {
      // Newer: availability() -> 'available'|'downloadable'|'downloading'|'unavailable'.
      // Older: capabilities() -> {available:'readily'|'after-download'|'no'}. Only
      // 'available'/'readily' means we can infer NOW without a multi-GB model download.
      try {
        if (typeof api.availability === 'function') return Promise.resolve(api.availability()).then(function (s) { return s === 'available'; }, function () { return false; });
        if (typeof api.capabilities === 'function') return Promise.resolve(api.capabilities()).then(function (c) { return !!c && c.available === 'readily'; }, function () { return false; });
      } catch (e) { }
      return Promise.resolve(false);
    }
    // Reuse one session PER system prompt (a new task/system gets its own; recreated on error).
    var SESSIONS = {};
    function session(api, sys) {
      var cached = SESSIONS[sys];
      if (cached) return Promise.resolve(cached);
      function keep(hasSystem) { return function (s) { try { s._bwnSystem = hasSystem; } catch (e) { } SESSIONS[sys] = s; return s; }; }
      // Prefer the system-prompt option; fall back to a bare session (older/newer variants)
      // where the instruction is prepended to the user prompt instead (_bwnSystem = false).
      return Promise.resolve(api.create({ initialPrompts: [{ role: 'system', content: sys }], outputLanguage: 'en' }))
        .then(keep(true), function () { return Promise.resolve(api.create({ outputLanguage: 'en' })).then(keep(false)); });
    }
    function onDevice(sys, content) {
      var api = langModel();
      if (!api || typeof api.create !== 'function') return Promise.resolve('');
      return ready(api).then(function (ok) {
        if (!ok) return '';
        return session(api, sys).then(function (s) {
          var usedSystem = !!(s && s._bwnSystem !== false);   // best-effort; harmless if unknown
          return s.prompt((usedSystem ? '' : sys + '\n\n') + content);
        });
      }).catch(function () { SESSIONS[sys] = null; return ''; });   // drop a bad cached session
    }

    // ---- Proxy (server key, injected transport) -----------------------------------
    // A grant-holding script installs the real cross-origin sender:
    //   bwnAI.setProxy(function (payload) { ... return Promise<string text>; })
    // payload = {task, system, prompt, maxTokens, minRank, rank}. The sender owns auth
    // (token in the JSON BODY, never Authorization - the SWA edge overwrites it) and must
    // RESOLVE '' / REJECT on any miss (403 ROLE_REQUIRED, network, empty) so we fall through.
    var _proxySend = null;
    function proxy(payload, send) {
      var fn = send || _proxySend;
      if (typeof fn !== 'function') return Promise.resolve('');   // no transport -> miss
      return Promise.resolve().then(function () { return fn(payload); })
        .then(function (t) { return String(t || ''); }, function () { return ''; });
    }

    function withTimeout(p, ms) {
      return new Promise(function (resolve) {
        var t = setTimeout(function () { resolve(undefined); }, ms);
        Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); }, function () { clearTimeout(t); resolve(undefined); });
      });
    }
    function clean(text, oneLine, maxChars) {
      var s = String(text || '');
      if (oneLine) s = s.replace(/\s+/g, ' ').replace(/^["']+|["']+$/g, '');
      return s.trim().slice(0, maxChars);
    }

    // ---- Router -------------------------------------------------------------------
    function bwnAI(opts) {
      opts = opts || {};
      var task = opts.task || 'summarize';
      var oneLine = (opts.oneLine !== undefined) ? !!opts.oneLine : !!TASK_ONELINE[task];
      var maxChars = opts.maxChars || (oneLine ? 300 : 4000);
      var sys = opts.system || TASK_SYSTEM[task] || TASK_SYSTEM.summarize;
      var content = (opts.prompt != null) ? String(opts.prompt)
        : (typeof opts.input === 'string' ? opts.input : (opts.input != null ? JSON.stringify(opts.input) : ''));
      var localFn = (typeof opts.local === 'function') ? opts.local : null;
      var floor = function () { try { return localFn ? clean(localFn(), oneLine, maxChars) : ''; } catch (e) { return ''; } };

      // Ordered tier list: desired ceiling first (task default, unless tier overrides),
      // then the fallback chain. Deduped, capped at proxy when tier says 'ondevice'.
      var desired = (opts.tier && opts.tier !== 'auto') ? opts.tier : (TASK_TIER[task] || 'ondevice');
      var order = [desired].concat(opts.fallback || ['ondevice', 'local']);
      var seen = {}, tiers = [];
      order.forEach(function (t) { if (t && !seen[t]) { seen[t] = 1; tiers.push(t); } });

      var minRank = (typeof opts.minRank === 'number') ? opts.minRank : 4;
      var r = rank();

      function step(i) {
        if (i >= tiers.length) return Promise.resolve('');
        var t = tiers[i], next = function () { return step(i + 1); };
        if (t === 'local') { return Promise.resolve(floor()); }   // terminal floor
        if (t === 'proxy') {
          // Fail CLOSED: unknown/under-rank quietly skips the paid tier (no 403 flash, no
          // wasted key) and drops to on-device. The server still backstops if we do send.
          if (r == null || r < minRank) return next();
          return proxy({ task: task, system: sys, prompt: content, maxTokens: opts.maxTokens, minRank: minRank, rank: r }, opts.proxySend)
            .then(function (out) { out = clean(out, oneLine, maxChars); return out || next(); });
        }
        if (t === 'ondevice') {
          return onDevice(sys, content).then(function (out) { out = clean(out, oneLine, maxChars); return out || next(); });
        }
        return next();
      }

      var run = step(0).then(function (out) { return out || floor(); });
      return withTimeout(run, opts.timeoutMs || 8000).then(function (v) { return v || floor() || ''; });
    }
    bwnAI.setProxy = function (fn) { _proxySend = (typeof fn === 'function') ? fn : null; };
    bwnAI.rank = rank;   // exposed for debug / gating UI
    return bwnAI;
  })();
  // ===== END bwnAI =====

  // ===== SWA transport + AI ==================================================
  // The ONE cross-origin host this script reaches. The Umbrava user token rides in the JSON
  // BODY as `userToken`, never the Authorization header - the SWA edge overwrites that header.
  // GM storage is per SCRIPT, not per @namespace, so this script needs its own copy of the key;
  // the boolean-only presence beacon lets Core's Ops panel name a blank one without ever
  // reading the value.
  function getKey() { try { return GM_getValue('ingest_key', ''); } catch (e) { return ''; } }
  // ts is stamped ONCE at load, never inline: an inline Date.now() makes Core read this script
  // as freshly-beaconed the moment the key is set mid-session, hiding a stale beacon.
  var INGEST_BEACON_TS = Date.now();
  function publishIngestPresence() {
    try {
      localStorage.setItem('bwn:ingest:proposal-pricing', JSON.stringify({ k: getKey() ? 1 : 0, ts: INGEST_BEACON_TS }));
    } catch (e) { /* best-effort */ }
  }

  var AI_ATTEMPT_TIMEOUT_MS = 45000;
  var AI_BUDGET_MS = 150000;
  var AI_ROUTER_TIMEOUT_MS = AI_BUDGET_MS + 15000;   // must EXCEED the sender's own deadline:
  // bwnAI's withTimeout resolves '' and discards ctx.reason, so a router that fires first hides
  // the real cause.
  var THROTTLE_BACKOFF_MS = [15000, 45000];
  var TRANSIENT_BACKOFF_MS = [2000, 6000];

  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 60000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j, headers: r.responseHeaders || '' }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  // retry-after is a FLOOR against the backoff table, never a replacement - a server hint of 0
  // must not shorten a planned wait. Presence is tested separately from the value so
  // `retry-after: 0` is not misread as absent.
  function retryAfterMs(raw) {
    try {
      var m = /^\s*retry-after\s*:\s*(.+)$/im.exec(String(raw || ''));
      if (!m) return 0;
      var v = m[1].replace(/^\s+|\s+$/g, '');
      if (/^\d+$/.test(v)) return Math.min(120000, parseInt(v, 10) * 1000);
      var t = Date.parse(v);
      if (isFinite(t)) return Math.max(0, Math.min(120000, t - Date.now()));
    } catch (e) { }
    return 0;
  }
  function isThrottle(r) {
    if (!r) return false;
    if (r.status === 429) return true;
    // A 502 whose body error names an upstream 429/529 is a throttle wearing a gateway status.
    var e = (r.json && r.json.error) ? String(r.json.error) : '';
    return r.status === 502 && /\((?:429|529)\)/.test(e);
  }
  function isNonRetryable(r) {
    if (!r) return false;
    var up = (r.json && r.json.upstreamStatus) || 0;
    if (!up) { var m = /Anthropic API error \((\d{3})\)/.exec((r.json && r.json.error) || ''); if (m) up = parseInt(m[1], 10); }
    if (r.json && r.json.code === 'INSUFFICIENT_CREDITS') return true;
    if (r.status === 403 || r.status === 413) return true;
    return up === 400 || up === 401 || up === 403 || up === 413;
  }
  function napFor(kind, attempt, raw) {
    var table = (kind === 'throttle') ? THROTTLE_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
    var planned = table[Math.min(attempt, table.length - 1)] || table[table.length - 1];
    return Math.max(retryAfterMs(raw), planned);
  }
  function nap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ONE POST to /api/ai with retries. Resolves the final text, or '' with ctx.reason set, so a
  // caller can report WHY without a throw crossing a backgrounded tab.
  function ppAiPost(body, ctx) {
    ctx = ctx || {};
    var key = getKey();
    if (!key) { ctx.reason = 'no SWA ingest key set - use the Tampermonkey menu "BWN Proposal Pricing: Set SWA ingest key"'; return Promise.resolve(''); }
    var deadline = Date.now() + AI_BUDGET_MS;
    var attempt = 0, sawThrottle = false;
    function give(why) { ctx.reason = why + (attempt > 1 ? ' after ' + attempt + ' tries' : '') + (sawThrottle && !/rate limit/.test(why) ? '; the service was rate limiting earlier' : ''); return ''; }
    function once() {
      attempt++;
      var remain = deadline - Date.now();
      if (remain <= 2000) return give('ran out of time');
      ctx.reason = 'in flight';   // provisional, so an abandoned call still reports truthfully
      return gmPost(AI_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, body, Math.min(AI_ATTEMPT_TIMEOUT_MS, remain))
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok && r.json.status === 'final') return String(r.json.text || '');
          if (r.status === 403 && r.json && r.json.code === 'ROLE_REQUIRED') return give('this needs manager access (rank ' + MIN_RANK + '+)');
          if (r.json && r.json.code === 'INSUFFICIENT_CREDITS') return give('the AI account is out of credits');
          if (isNonRetryable(r)) return give('the AI service refused this request (' + r.status + ')');
          if (isThrottle(r)) {
            sawThrottle = true;
            if (attempt >= 3) return give('rate limited');
            return nap(napFor('throttle', attempt - 1, r.headers)).then(once);
          }
          if (attempt >= 3) return give('the AI service failed (' + r.status + ')');
          return nap(napFor('transient', attempt - 1, r.headers)).then(once);
        }, function (e) {
          if (attempt >= 3) return give(String((e && e.message) || 'network error'));
          return nap(napFor('transient', attempt - 1, '')).then(once);
        });
    }
    return once();
  }

  // bwnAI's injected proxy sender. bwnAI hands a flat {task, system, prompt, ...} payload; the
  // media features below bypass it because they need a messages array and have no fallback tier
  // (the same reason bwn-ask drives its own transport).
  function aiProxySend(payload, ctx) {
    payload = payload || {};
    var body = {
      task: payload.task || 'render',
      input: (payload.prompt != null) ? String(payload.prompt) : '',
      userToken: authToken()
    };
    if (payload.system) body.system = payload.system;
    return ppAiPost(body, ctx || {});
  }

  // Media (PDF / photos): Anthropic-shaped content blocks in a messages array. api/ai passes any
  // content ARRAY through untouched apart from cache breakpoints, so the blocks reach the model
  // without a server change. Budget: the route rejects a conversation over 500 KB, so the
  // caller must cap count and bytes BEFORE calling - a base64 photo is ~1.37x its raw size.
  var AI_MEDIA_BUDGET_BYTES = 380000;   // headroom under the route's 500000
  function ppAiMedia(task, system, promptText, blocks, ctx) {
    ctx = ctx || {};
    var content = [], used = 0, i, b, skipped = 0;
    for (i = 0; i < (blocks || []).length; i++) {
      b = blocks[i];
      var sz = (b && b.source && b.source.data) ? String(b.source.data).length : 0;
      if (used + sz > AI_MEDIA_BUDGET_BYTES) { skipped++; continue; }
      used += sz; content.push(b);
    }
    if (!content.length) { ctx.reason = 'nothing small enough to send (the AI route caps a request at ~500 KB)'; return Promise.resolve(''); }
    if (skipped) ctx.skipped = skipped;
    content.push({ type: 'text', text: String(promptText || '') });
    return ppAiPost({
      task: task, system: system, userToken: authToken(),
      messages: [{ role: 'user', content: content }]
    }, ctx);
  }

  // ===== PP-ENGINE START (pure; sliced by scripts/test-proposal-pricing-engine.js) ==============
  // Declarations only - no statements, no DOM, no clock. Every external arrives as a free
  // variable so the same shipped bytes run headless. Same discipline as BWN AUDIT FLAGS in
  // bwn-wo-audit.user.js: the pricing must survive an AI outage, because none of it needs AI.

  // Cost categories - the COMPLETE live list from Umbrava's own `costCategories` (read
  // 2026-09-08). All eighteen. Two traps the short five-entry map used to hide: Other is 7 (an
  // earlier build had 3), and 3 is NOT unused - it is Recycling. Shipping is 6, so a five-entry
  // map that aliased Shipping onto Other silently wrote shipping rows out as "Other".
  var CAT_LABEL = {
    0: 'Labor', 1: 'Material', 2: 'Equipment', 3: 'Recycling',
    4: 'Travel', 5: 'Management Fee', 6: 'Shipping', 7: 'Other',
    8: 'Tax', 9: 'Regular Rate', 10: 'Overtime Rate', 11: 'Premium Rate',
    12: 'Emergency Rate', 13: 'Labor And Material', 14: 'Adjustment', 15: 'Discount',
    16: 'Credit/Debit', 17: 'Permit'
  };
  // Reverse map derived from CAT_LABEL so the two can never drift apart, plus the one alias the
  // pricing rows use ("Materials" plural).
  var CAT_ID = (function () {
    var m = {}, k;
    for (k in CAT_LABEL) { if (Object.prototype.hasOwnProperty.call(CAT_LABEL, k)) m[CAT_LABEL[k]] = Number(k); }
    m.Materials = 1;
    return m;
  })();

  // Money is MINOR UNITS with a precision field (amount 468584 / precision 2 = $4,685.84).
  // Divide once on the way in, re-scale on the way out, and never float-math a raw `amount`.
  function ppMoney(m) {
    return (m && typeof m.amount === 'number') ? m.amount / Math.pow(10, (m.precision == null ? 2 : m.precision)) : 0;
  }
  function ppMoneyIn(dollars, currency, precision) {
    var p = (precision == null) ? 2 : precision;
    return { amount: Math.round(Number(dollars || 0) * Math.pow(10, p)), currency: currency || 'USD', precision: p };
  }

  // Crew size, READ out of what the vendor wrote. "labor - 2 techs" is a stated 2. This parses a
  // number the vendor supplied; it never invents one, and a line with no crew in its text yields
  // 0, which means "send no crewSize filter at all".
  // Why it matters, measured live: omitting crewSize made Umbrava's matcher rank a 1-Man rate
  // first out of 19 and price a 2-tech line at -60%; sending crewSize:2 narrowed to 7 and
  // suggested the 2-Man rate, moving the same line to +4%.
  function ppCrewOf(it) {
    it = it || {};
    var parts = [], i;
    var src = [it.clientDescription, it.description, it._umbItem];
    for (i = 0; i < src.length; i++) { if (src[i]) parts.push(String(src[i])); }
    var txt = parts.join(' ');
    var m = txt.match(/(\d+)\s*(?:-|\s)?\s*(?:man|men|tech(?:s|nician|nicians)?|guy|guys|crew)\b/i);
    if (!m) m = txt.match(/crew\s*(?:of|size)?\s*(\d+)/i);
    var n = m ? Number(m[1]) : 0;
    return (n > 0 && n < 20) ? n : 0;
  }

  // Cost category for one internal item. Returns null when the line is mixed or unlabelled -
  // "say nothing rather than guess a category", because the category is what the rate lookup
  // keys on.
  function ppCatOf(it) {
    it = it || {};
    if (it._catRaw && CAT_ID[it._catRaw] != null) return CAT_ID[it._catRaw];
    if (it.labor > 0 && !(it.materials > 0)) return CAT_ID.Labor;
    if (it.materials > 0 && !(it.labor > 0)) return CAT_ID.Material;
    return null;
  }

  // ---- gross profit -------------------------------------------------------
  // THE BASIS THAT HAS TO AGREE WITH UMBRAVA. Measured on live records to the cent:
  //   grossProfit  = subtotal - vendorCost   (PRE-TAX)
  //   grossProfit% = grossProfit / subtotal
  // `total - vendorCost` folds sales tax into the profit and reads several points high. On a
  // $1,000 pre-tax / $700 cost / 8% tax fixture the taxed basis reads 35.19% where Umbrava's
  // basis is 30.00%. Confirmed pre-tax on six live client proposals.
  // gpTarget arrives as a FRACTION (0.33), never a percent.
  function ppTotals(rows, gpTarget) {
    rows = rows || [];
    var i, r, sub = 0, tax = 0, cost = 0;
    for (i = 0; i < rows.length; i++) {
      r = rows[i] || {};
      sub += Number(r.subtotal) || 0;
      tax += Number(r.taxAmt) || 0;
      cost += Number(r.vendorCost) || 0;
    }
    var total = sub + tax;
    var gp = sub - cost;
    var gpPct = sub > 0 ? (gp / sub) * 100 : 0;
    // Kept only so the difference stays inspectable - never rendered as THE number.
    var gpTaxed = total - cost;
    var gpTaxedPct = total > 0 ? (gpTaxed / total) * 100 : 0;
    var t = (gpTarget == null) ? 0.33 : gpTarget;
    var targetSub = cost > 0 ? cost / (1 - t) : 0;
    return {
      subtotal: sub, taxTotal: tax, total: total, vendorCost: cost,
      gp: gp, gpPct: gpPct, gpTaxed: gpTaxed, gpTaxedPct: gpTaxedPct,
      targetSubtotal: targetSub, targetGap: targetSub - sub,
      hitsTarget: gpPct >= (t * 100) - 0.5
    };
  }

  // ---- rate-match rows ----------------------------------------------------
  // A contracted rate is PER UNIT. A vendor line is very often a LUMP SUM with no stated unit
  // and quantity "1" - measured across 15 live quotes from 4 vendors, roughly three in four look
  // like that, and it splits by VENDOR not by client. Multiplying a per-unit rate by a
  // placeholder 1 is not a price, it is a wrong number that looks like one: on a real WO it
  // valued a $3,360 labour line at $90 and an $8,300 material line at $98, then reported "$8,412
  // under water" off an invented unit.
  // So a row is only AUTO-PRICED when the arithmetic is actually defined: a matched rate, no
  // unit disagreement, and a REAL quantity. Everything else is presented, not applied.
  // needsQty depends on the QUANTITY alone. An unstated unit is resolved by adopting the matched
  // rate's unit and must NOT gate pricing - it did, and because `unitKnown` never becomes true
  // for a lump-sum line, re-picking a rate after the operator had typed the quantity silently
  // reverted the row to unpriced.
  function ppMatchRow(it, suggested) {
    it = it || {};
    var cid = ppCatOf(it);
    var sug = suggested || null;
    var qty = Number(it.qty) || 1;
    var unitKnown = !!(it.unit && String(it.unit).replace(/^\s+|\s+$/g, ''));
    var qtyKnown = !!it._umbQtyKnown;
    var uomMismatch = !!(sug && unitKnown && sug.uom &&
      String(it.unit).toLowerCase() !== String(sug.uom).toLowerCase());
    var needsQty = !!sug && !uomMismatch && !qtyKnown;
    return {
      itemId: it.id,
      description: it.clientDescription || it.description || '',
      categoryId: cid,
      category: (cid == null) ? '(none)' : CAT_LABEL[cid],
      vendorCost: Number(it.vendorTotal) || 0,
      qty: qty,
      unit: unitKnown ? it.unit : (sug && sug.uom ? sug.uom : ''),
      unitKnown: unitKnown,
      qtyKnown: qtyKnown,
      needsQty: needsQty,
      crew: ppCrewOf(it),
      matched: sug,
      chosenRateId: sug ? sug.id : null,
      clientPrice: sug ? sug.rate * qty : null,
      uomMismatch: uomMismatch,
      skip: !sug || uomMismatch || needsQty
    };
  }

  // Re-derive one row after the operator supplies a quantity or picks a different rate. Kept
  // here (not in the UI) so the harness can prove the quantity survives a rate switch.
  function ppSetQty(row, val) {
    if (!row) return row;
    var q = Number(val);
    if (!(q > 0)) {
      row.qty = 1; row.qtyKnown = false; row.needsQty = !!row.matched && !row.uomMismatch;
      row.clientPrice = row.matched ? row.matched.rate : null;
      row.skip = !row.matched || row.uomMismatch || row.needsQty;
      return row;
    }
    row.qty = q;
    row.qtyKnown = true;
    row.needsQty = false;
    row.clientPrice = row.matched ? row.matched.rate * q : null;
    row.skip = !row.matched || row.uomMismatch;
    return row;
  }
  function ppSetRate(row, pick) {
    if (!row || !pick) return row;
    row.matched = pick;
    row.chosenRateId = pick.id;
    // Only a unit the VENDOR stated can disagree with the rate's unit. If the vendor stated
    // none, picking a rate adopts that rate's unit.
    row.uomMismatch = !!(row.unitKnown && pick.uom &&
      String(row.unit).toLowerCase() !== String(pick.uom).toLowerCase());
    if (!row.unitKnown) row.unit = pick.uom || row.unit;
    row.needsQty = !row.uomMismatch && !row.qtyKnown;
    row.clientPrice = pick.rate * (Number(row.qty) || 1);
    row.skip = row.uomMismatch || row.needsQty;
    return row;
  }

  // Warnings the panel must not swallow. Derived from the ROWS, never from a merged option pool:
  // reading a pool's (deliberately null) suggestion reported "No Labor rate is contracted" on a
  // job whose labour lines had just priced.
  function ppConstraints(rows, cats) {
    rows = rows || []; cats = cats || [];
    var out = [], i, j, r, inCat, allUnmatched;
    var noMatch = 0, badUom = 0, needQty = 0, below = 0, belowAmt = 0;
    for (i = 0; i < rows.length; i++) {
      r = rows[i] || {};
      if (!r.matched) noMatch++;
      if (r.matched && r.uomMismatch) badUom++;
      if (r.needsQty) needQty++;
      if (!r.skip && r.clientPrice < (r.vendorCost || 0)) { below++; belowAmt += (r.vendorCost || 0) - r.clientPrice; }
    }
    if (noMatch) out.push(noMatch + ' line(s) have no contracted rate for their category - left at vendor cost');
    if (badUom) out.push(badUom + ' line(s) skipped: unit differs from the rate\'s unit of measurement');
    if (needQty) out.push(needQty + ' line(s) are lump sums - the vendor stated no unit or quantity, so enter the real quantity to price them at the contracted rate');
    // A contracted rate CAN price below vendor cost. That is a real loss, not a rounding
    // artefact, and it belongs in the warning line rather than left to be read off a column.
    if (below) out.push('LOSS: ' + below + ' line(s) price BELOW vendor cost at the contracted rate - ' + belowAmt.toFixed(2) + ' under water');
    for (j = 0; j < cats.length; j++) {
      inCat = []; allUnmatched = true;
      for (i = 0; i < rows.length; i++) { if (rows[i] && rows[i].categoryId === cats[j]) { inCat.push(rows[i]); if (rows[i].matched) allUnmatched = false; } }
      if (inCat.length && allUnmatched) out.push('No ' + (CAT_LABEL[cats[j]] || cats[j]) + ' rate is contracted for this client');
    }
    return out;
  }
  // ===== PP-ENGINE END ==========================================================================

  // ===== PP-LINEMAP START (pure; sliced by scripts/test-proposal-pricing-linemap.js) ============
  // Vendor quoteLineItems -> this tool's internal items. Declarations only; ppMoney/CAT_LABEL
  // arrive as free variables.
  //
  // NOTHING IS DEFAULTED HERE. Vendor line items in the wild are not reliably itemized:
  // measured across 15 live quotes from 4 vendors, only ~1 in 4 carries a unitOfMeasurement at
  // all, most send quantity "1" with unitCost === totalCost (a lump sum wearing a line item's
  // clothes), and many carry no item/description text either. An absent unit stays absent - a
  // `|| 'ea'` default invented a unit, which then satisfied the rate matcher's own unit check
  // and produced client prices off by 80x. A `||` default on a field read off a record IS
  // fabrication.

  // One vendor quote line -> a normalized line. `uom: ''` means UNKNOWN, not 'ea'.
  function ppMapQuoteLine(l) {
    l = l || {};
    var qty = Number(l.quantity);
    var cost = ppMoney(l.totalCost);
    var uom = l.unitOfMeasurement || '';
    return {
      category: CAT_LABEL[l.category] || (l.categoryObject && l.categoryObject.name) || 'Other',
      categoryId: l.category,
      item: l.item || '',
      description: l.description || l.item || '',
      // quantity and taxRate come back as STRINGS on the read side.
      qty: (isFinite(qty) && qty > 0) ? qty : null,
      uom: uom,
      unitCost: ppMoney(l.unitCost),
      totalCost: cost,
      totalCharge: ppMoney(l.totalCharge),
      taxable: !!l.isTaxable,
      taxPct: (Number(l.taxRate) || 0) * 100,
      trade: (l.trade && l.trade.name) || '',
      // A lump-sum row: one "unit" whose cost is the whole line. Rate-card pricing cannot be
      // derived from these without a human supplying the real quantity. Note `uom: "total"`
      // occurs live - some vendors express a lump sum AS a unit - and the !(qty > 1) half
      // catches it.
      isLumpSum: !uom || !(qty > 1) || ppMoney(l.unitCost) === cost,
      // Umbrava's own verdict vs the contracted rate. Measured caveat: across those 15 quotes
      // ZERO lines carried a rateId, so this reads Manual or NotApplicable almost everywhere -
      // a weak signal on this tenant, not the authoritative comparison.
      rateVerdict: l.rateDiscrepancy || null,
      rateId: l.rateId || null
    };
  }

  // Whole quote -> lines, dropping the empty placeholder rows (zero cost AND no quantity).
  function ppMapQuoteLines(quoteLineItems) {
    var src = quoteLineItems || [], out = [], i, l;
    for (i = 0; i < src.length; i++) {
      l = ppMapQuoteLine(src[i]);
      if (l.totalCost > 0 || l.qty) out.push(l);
    }
    return out;
  }

  // A normalized line -> an internal pricing item. qty falls back to 1 so the arithmetic is
  // defined, but `_umbQtyKnown` records whether the vendor actually STATED it - a fabricated 1
  // is how a $3,360 labour line gets priced as one hour.
  function ppItemFromLine(l, woTrade, mkId) {
    l = l || {};
    return {
      id: mkId ? mkId() : null,
      vendorTotal: l.totalCost,
      qty: l.qty || 1,
      _umbQtyKnown: (l.qty != null) && !l.isLumpSum,
      unit: l.uom,                       // may be '' - unknown, not 'ea'
      _catRaw: l.category,
      _umbItem: l.item,
      trade: l.trade || woTrade || '',
      clientDescription: l.description || (l.category + ' - ' + (l.totalCost).toFixed(2)),
      taxPct: l.taxPct,
      taxable: l.taxable,
      // The labour/material split is READ from the category, never estimated.
      labor: l.categoryId === 0 ? l.totalCost : 0,
      materials: l.categoryId === 1 ? l.totalCost : 0,
      _umbRateVerdict: l.rateVerdict,
      _fromUmbravaQuote: true
    };
  }
  // ===== PP-LINEMAP END =========================================================================

  // ===== umbrava reads ======================================================
  // Every document below is a REPLAY of an op Umbrava's own SPA fires or that was pinned by
  // read-only introspection, and every one was fired against the live tenant 2026-09-08.
  // Catalogue: [[umbrava-graphql-operations]]. Hard rule: never invent a field here.
  //
  // jobId vs workOrderNumber is not interchangeable: workOrder / jobNotes / purchaseOrders key
  // off the WO NUMBER; proposals keys off jobId, which IS workOrder.id.
  // TRAP: workOrder.purchaseOrders reads NULL even on WOs with a dozen POs (measured across
  // twelve). The ROOT purchaseOrders(workOrderNumber:) is the live one, so the dead nested
  // selection is deliberately absent below.

  var Q_LOOKUP_JOB = 'query LookupJob($page: PageInput!, $sortBy: [SortInput!]!, $search: String!, $filterOutIds: [String!]) { lookupJob(page: $page, sortBy: $sortBy, search: $search, filterOutIds: $filterOutIds) { rowCount items { id number trackingNumber formattedJobNumber sourceJobNumber sourcePurchaseOrderNumber clientName locationNumber state assignedTo phase assetName assetTagId linksCount status { name } } } }';


  var Q_WO = 'query WorkOrderForWODetails($workOrderNumber: Int!) { workOrder(workOrderNumber: $workOrderNumber) { id number trackingNumber clientId clientName rootClientId rootClientName locationId locationNumber locationName phoneNumber timezone workOrderDate acceptedDate completionDate nextOnsiteDate numberOfDays remainingDays formattedJobNumber formattedClientPurchaseOrderNumber sourceJobNumber sourcePurchaseOrderNumber statusId statusName systemStatusName phase assignedTo state source scopeOfWork serviceInstructions serviceRequestRateUnitOfMeasurement canEditWorkOrder preventEdit doNotExceed { amount currency precision } totalNTE { amount currency precision } serviceRequestRate { amount currency precision } grossProfitInfo { id estimatedGrossProfitPercent estimatedGrossProfitTaxedPercent trueGrossProfitPercent grossProfitPercentType } trades { id name systemTradeName } priority { id label expectedCompletionDate } address { addressLine1 addressLine2 city state postalCode isInternational latitude longitude googlePlaceId subAdministrativeArea countryCode } asset { id name manufacturer modelNumber serialNumber tagId } workOrderTypeValue { id name } workOrderCategoryValue { id name colorHex } } }';

  var Q_NOTES = 'query WONotesForWODetails($workOrderNumber: Int!, $includeDeleted: Boolean) { jobNotes(workOrderNumber: $workOrderNumber, includeDeleted: $includeDeleted) { id type content createdDate isPinned isCompletion isInvoice sourcePurchaseOrderNumber createdBy { id firstName lastName } } }';

  var Q_POS = 'query PosForWoVendorProposalList($workOrderNumber: Int) { purchaseOrders(workOrderNumber: $workOrderNumber) { id number formattedPurchaseOrderNumber state scopeOfWork vendorId vendorName } }';

  // quotes(..., includeLineItems: true) is the vendor-proposal read WITH line items.
  // listVendorProposals is the paged tenant-wide SEARCH surface and carries totals only.
  var Q_QUOTES = 'query QuotesForWO($purchaseOrderIds: [Int!]) { quotes(purchaseOrderIds: $purchaseOrderIds, includeLineItems: true) { id number description state purchaseOrderId purchaseOrderNumber formattedPurchaseOrderNumber jobNumber vendorName vendorTenantProfileId created submittedDate approvedDate aggregateRateDiscrepancy scopeOfWork status { id name } type { id name } subtotal { amount currency precision } taxTotal { amount currency precision } total { amount currency precision } quoteLineItems { id category item description quantity unitOfMeasurement isTaxable taxRate rateId rateDiscrepancy sortOrder categoryObject { id name } trade { id name systemTradeName } unitCost { amount currency precision } totalCost { amount currency precision } totalTax { amount currency precision } totalCharge { amount currency precision } } } }';

  // Client proposals on THIS WO, with line items. Keys off jobId. Carries the platform's own
  // grossProfit / vendorCost / subtotal - read them, never recompute.
  var Q_PROPOSALS = 'query ProposalsForWO($jobId: Int) { proposals(jobId: $jobId, includeLineItems: true) { id number description state jobId jobNumber formattedJobNumber created submittedDate approvedDate isSubmitted grossProfitPercent formattedClientPurchaseOrderNumber type { id name } status { id name } subtotal { amount currency precision } taxTotal { amount currency precision } total { amount currency precision } vendorCost { amount currency precision } grossProfit { amount currency precision } proposalLineItems { id category item description quantity unitOfMeasurement isTaxable taxRate sortOrder categoryObject { id name } unitCost { amount currency precision } unitCharge { amount currency precision } } } }';


  // TRAP: sortBy is NULLABLE in the schema but the SERVER rejects the call without it -
  // {"errors":{"SortBy":["The SortBy field is required."]}} as an HTTP 400, not a GraphQL error.
  var Q_CLIENT_RATES = 'query ListClientRates($targetTenantId: ID!, $page: PageInput!, $sortBy: [SortInput!]) { listClientRates(targetTenantId: $targetTenantId, page: $page, sortBy: $sortBy, isActive: true) { rowCount items { id isActive category item unitOfMeasurement type status locationId categoryObject { id name } unitCost { amount currency precision } trade { id name systemTradeName } } } }';

  var Q_RATE_MATCHES = 'query RateMatches($input: RateMatchInput!) { rateMatches(input: $input) { suggestedRate { id item unitOfMeasurement rank isAccepted isServiceRequestRate status locationId category { id name } trade { id name } amount { amount currency precision } labor { rateClass priorityCategory crewSize professionLevel isUnion } } rates { rowCount take items { id item unitOfMeasurement rank isAccepted isServiceRequestRate status category { id name } trade { id name } amount { amount currency precision } labor { crewSize rateClass } } } } }';

  var Q_PROPOSAL_TYPES = 'query ProposalTypes($onlyActive: Boolean, $onlyTenantLevel: Boolean) { proposalTypes(onlyActive: $onlyActive, onlyTenantLevel: $onlyTenantLevel) { id name } }';

  var M_CREATE_DRAFT = 'mutation CreateDraftProposal($proposalData: CreateDraftProposalInput!) { createDraftProposal(proposalData: $proposalData) { success message proposal { id number } } }';
  var M_EDIT = 'mutation EditProposal($proposalData: EditProposalInput!) { editProposal(proposalData: $proposalData) { success message proposal { id number } } }';

  // ---- readers -------------------------------------------------------------
  function readLookupJob(search, take) {
    return ppGql('LookupJob', Q_LOOKUP_JOB, {
      page: { skip: 0, take: take || 8 },
      sortBy: [{ columnName: 'LastModified', direction: 'DESC' }],
      search: String(search),
      filterOutIds: []
    }).then(function (d) { return (d && d.lookupJob && d.lookupJob.items) || []; });
  }
  function readWo(n) {
    return ppGql('WorkOrderForWODetails', Q_WO, { workOrderNumber: Number(n) })
      .then(function (d) { return (d && d.workOrder) || null; });
  }
  function readNotes(n) {
    return ppGql('WONotesForWODetails', Q_NOTES, { workOrderNumber: Number(n), includeDeleted: false })
      .then(function (d) { return (d && d.jobNotes) || []; });
  }
  function readPos(n) {
    return ppGql('PosForWoVendorProposalList', Q_POS, { workOrderNumber: Number(n) })
      .then(function (d) { return (d && d.purchaseOrders) || []; });
  }
  function readQuotes(poIds) {
    if (!poIds || !poIds.length) return Promise.resolve([]);
    return ppGql('QuotesForWO', Q_QUOTES, { purchaseOrderIds: poIds })
      .then(function (d) { return (d && d.quotes) || []; });
  }
  function readProposals(jobId) {
    return ppGql('ProposalsForWO', Q_PROPOSALS, { jobId: Number(jobId) })
      .then(function (d) { return (d && d.proposals) || []; });
  }
  function readClientRates(clientId) {
    return ppGql('ListClientRates', Q_CLIENT_RATES, {
      targetTenantId: clientId,
      page: { skip: 0, take: 200 },
      sortBy: [{ columnName: 'category', direction: 'ASC' }]   // REQUIRED by the server
    }).then(function (d) { return (d && d.listClientRates) || { rowCount: 0, items: [] }; });
  }
  // Umbrava's OWN rate matcher. Five traps, all measured live, and the first four return an
  // EMPTY result rather than an error so none announces itself:
  //  1. behavior 'SingleBest' returned 0 rows where 'Ranked' returned 19 - use Ranked and read
  //     suggestedRate, which Ranked populates.
  //  2. Do NOT pass tradeId: adding the WO's own trade id took the same query from 19 to 0.
  //     Rate rows carry trade ids, but not the ones the work order carries.
  //  3. direction 'VendorBilling' REJECTS workOrderId (use workOrderPurchaseOrderId). This tool
  //     wants client billing, so it sends ClientBilling + workOrderId.
  //  4. `rank` is NOT an ordering - all 19 rows read rank 6, unsorted by amount.
  //  5. crewSize decides the answer; see ppCrewOf. Sent only when the vendor stated a crew.
  function readRateMatches(clientId, categoryId, o) {
    o = o || {};
    var input = {
      behavior: 'Ranked',
      direction: 'ClientBilling',
      targetTenantId: clientId,
      categoryId: Number(categoryId),
      page: { skip: 0, take: o.take || 25 }
    };
    if (o.locationId) input.locationId = o.locationId;
    if (o.workOrderId) input.workOrderId = Number(o.workOrderId);
    if (o.unitOfMeasurement) input.unitOfMeasurement = o.unitOfMeasurement;
    if (o.crewSize > 0) input.crewSize = Number(o.crewSize);
    // `search` is the FUZZY field; `item` is exact-match and had no effect on real free text.
    if (o.search) input.search = String(o.search);
    return ppGql('RateMatches', Q_RATE_MATCHES, { input: input }).then(function (d) {
      var r = (d && d.rateMatches) || null;
      function norm(x) {
        if (!x) return null;
        return {
          id: x.id, item: x.item || '', uom: x.unitOfMeasurement || 'ea',
          rate: ppMoney(x.amount),
          categoryId: (x.category && x.category.id != null) ? x.category.id : Number(categoryId),
          accepted: !!x.isAccepted, labor: x.labor || null
        };
      }
      var opts = [], src = (r && r.rates && r.rates.items) || [], i;
      for (i = 0; i < src.length; i++) opts.push(norm(src[i]));
      return { suggested: norm(r && r.suggestedRate), rowCount: (r && r.rates && r.rates.rowCount) || 0, options: opts };
    });
  }
  function readProposalTypes() {
    return ppGql('ProposalTypes', Q_PROPOSAL_TYPES, { onlyActive: true, onlyTenantLevel: true })
      .then(function (d) { return (d && d.proposalTypes) || []; });
  }

  // ===== push to draft (write leg) ==========================================
  // Two mutations, replayed exactly as the SPA sends them, both routed through bwnGqlOp so they
  // inherit the correlation id, the PII-free bwn:audit entry, the Umbrava permission gate and
  // the fail-closed high-risk confirm gate. Nothing here submits, approves, sends or deletes.
  //
  // Quantity coercion: ProposalLineItemInput.quantity / chargeQuantity are Int, while the read
  // side returns them as STRINGS. Sending a raw string to the Int field is REJECTED
  // ('Int cannot represent non-integer value: "1"'). Send BOTH - the truncated Int to satisfy
  // the scalar, and the exact value as the fractional String so precision survives.
  function ppInt(v) { if (v == null || v === '') return null; var n = Math.trunc(Number(v)); return isFinite(n) ? n : null; }
  function ppFrac(v) { return (v == null) ? null : String(v); }

  // One PRICED row -> a new ProposalLineItemInput. `id` is deliberately absent: every row is a
  // new line. rateId is carried through when the row was priced off a contracted rate, so
  // Umbrava can compute its own rateDiscrepancy against it instead of seeing a manual price.
  function ppLineItemInput(row, i) {
    row = row || {};
    var qty = row.qty;
    var unitCharge = (!row.skip && row.matched) ? row.matched.rate : null;
    var unitCost = (qty > 0) ? (row.vendorCost / qty) : row.vendorCost;
    var out = {
      category: (row.categoryId == null) ? CAT_ID.Other : row.categoryId,
      item: String(row.description || '').slice(0, 200),
      description: String(row.description || ''),
      quantity: ppInt(qty),
      fractionalQuantity: ppFrac(qty),
      chargeQuantity: ppInt(qty),
      fractionalChargeQuantity: ppFrac(qty),
      unitOfMeasurement: row.unit || null,
      unitCost: ppMoneyIn(unitCost),
      isTaxable: !!row.taxPct,
      taxRate: String((Number(row.taxPct) || 0) / 100),
      sortOrder: i
    };
    if (unitCharge != null) out.unitCharge = ppMoneyIn(unitCharge);
    if (row.chosenRateId) out.rateId = row.chosenRateId;
    return out;
  }

  // createDraftProposal server-validates jobId AND a full location.address as REQUIRED - both
  // are nullable in the GraphQL schema but rejected empty by the server.
  // ProposalLocationInfoInput has no id field, so the location goes by number/name + address,
  // copied off the WO this proposal is being created on.
  function ppBuildCreateVars(wo, typeId, scope) {
    wo = wo || {};
    var a = wo.address || {};
    return { proposalData: {
      jobId: wo.id,
      workOrderNumber: wo.number,
      location: {
        number: wo.locationNumber,
        name: wo.locationName,
        address: {
          addressLine1: a.addressLine1, addressLine2: a.addressLine2,
          city: a.city, state: a.state, postalCode: a.postalCode,
          isInternational: a.isInternational, latitude: a.latitude, longitude: a.longitude,
          googlePlaceId: a.googlePlaceId, subAdministrativeArea: a.subAdministrativeArea,
          countryCode: a.countryCode
        }
      },
      typeId: typeId,
      scopeOfWork: scope || wo.scopeOfWork || '',
      description: 'Priced from the vendor quote - BWN Proposal Pricing v' + VER,
      clientPurchaseOrderNumber: wo.formattedClientPurchaseOrderNumber || null
    } };
  }
  function ppBuildEditVars(proposalId, typeId, rows, scope) {
    var items = [], i;
    for (i = 0; i < (rows || []).length; i++) items.push(ppLineItemInput(rows[i], i));
    return { proposalData: {
      proposalId: proposalId,
      typeId: typeId,
      scopeOfWork: scope || '',
      proposalLineItems: items
    } };
  }

  // The whole push. Resolves {number, verified, problems[]}; rejects with a staged error.
  function ppStage(code, msg) { var e = new Error(msg); e.stage = code; return e; }
  function ppPushDraft(wo, rows, scope) {
    if (!wo || wo.id == null) return Promise.reject(ppStage('no-wo', 'no work order loaded'));
    var priced = [], i;
    for (i = 0; i < (rows || []).length; i++) { if (rows[i] && !rows[i].skip) priced.push(rows[i]); }
    if (!priced.length) return Promise.reject(ppStage('nothing-priced', 'no line is priced yet - supply the quantities first'));

    var typeId = null, newId = null, newNumber = null;
    // Resolve the proposal type live and BY NAME, never by list position and never hardcoded -
    // an id renumber or a reordered lookup would otherwise pick the wrong type in silence.
    // Live values 2026-09-08: Original 1, Option 2, Revision 3, Billing 4, ATF 5.
    return readProposalTypes().then(function (types) {
      var j;
      for (j = 0; j < (types || []).length; j++) { if (/^original$/i.test(types[j].name || '')) { typeId = types[j].id; break; } }
      if (typeId == null) throw ppStage('no-type', 'no "Original" proposal type in ' + ((types || []).length) + ' returned type(s) - refusing to guess');
      return bwnGqlOp('createDraftProposal', M_CREATE_DRAFT, ppBuildCreateVars(wo, typeId, scope),
        { confirmed: true, feature: 'proposalPricing', ids: { wo: wo.number } });
    }).then(function (d) {
      var res = d && d.createDraftProposal;
      if (!res || res.success !== true || !res.proposal || res.proposal.id == null) throw ppStage('create', (res && res.message) || 'createDraftProposal reported no success');
      newId = res.proposal.id; newNumber = res.proposal.number;
      return bwnGqlOp('editProposal', M_EDIT, ppBuildEditVars(newId, typeId, priced, scope),
        { confirmed: true, feature: 'proposalPricing', ids: { wo: wo.number, proposalId: newId }, after: { lineItems: priced.length } });
    }).then(function (d) {
      var res = d && d.editProposal;
      if (!res || res.success !== true) throw ppStage('edit', (res && res.message) || 'editProposal reported no success');
      // Verify by RE-READING the record, not by trusting the mutation's own success flag.
      return readProposals(wo.id);
    }).then(function (list) {
      var back = null, k;
      for (k = 0; k < (list || []).length; k++) { if (list[k].id === newId) { back = list[k]; break; } }
      var expect = ppTotals(priced.map(function (r) {
        return { subtotal: r.clientPrice, taxAmt: (r.clientPrice || 0) * ((Number(r.taxPct) || 0) / 100), vendorCost: r.vendorCost };
      }), 0.33);
      var problems = [];
      if (!back) problems.push('the draft did not come back on a re-read of the WO');
      else {
        var n = (back.proposalLineItems || []).length;
        if (n !== priced.length) problems.push('sent ' + priced.length + ' line items, the proposal holds ' + n);
        if (Math.abs(ppMoney(back.subtotal) - expect.subtotal) > 0.02) problems.push('subtotal is ' + ppMoney(back.subtotal).toFixed(2) + ', expected ' + expect.subtotal.toFixed(2));
      }
      return { number: newNumber, id: newId, verified: !problems.length, problems: problems, readBack: back };
    });
  }

  // ===== state + rank =======================================================
  var S = { wo: null, notes: null, pos: null, quotes: null, proposals: null, rates: null,
            items: [], rows: [], cats: [], byKey: {}, scope: '', busy: false };

  // Rank is a POLICY gate, not a security boundary - it arrives over a CustomEvent and a
  // page-writable slot. It fails CLOSED here (same as proposal-copy / proposal-actions): an
  // unknown rank hides the paid-AI and write surfaces rather than offering them.
  var _liveRank = null;
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role' && typeof d.rank === 'number') { _liveRank = d.rank; renderAll(); }
    });
  } catch (e) { }
  function ppRank() {
    if (typeof _liveRank === 'number') return _liveRank;
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < 6 * 3600 * 1000) return r.rank;
    } catch (e2) { }
    return null;
  }
  function gated() { return typeof ppRank() === 'number' && ppRank() >= MIN_RANK; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function $id(id) { return document.getElementById(id); }
  function setHtml(id, html) { var el = $id(id); if (el) el.innerHTML = html; }
  function logln(s) {
    var el = $id('bwn-pp-log'); if (!el) return;
    el.textContent += (el.textContent ? '\n' : '') + s; el.scrollTop = el.scrollHeight;
  }

  // ===== load a work order ==================================================
  function loadWo(n) {
    if (S.busy) return Promise.resolve();
    S.busy = true;
    S.wo = null; S.quotes = null; S.proposals = null; S.rates = null;
    S.items = []; S.rows = []; S.cats = []; S.byKey = {};
    setHtml('bwn-pp-status', 'Loading W-' + esc(String(n)) + '...');
    renderAll();
    // Header, notes and POs in parallel; a notes or PO miss must not fail the load.
    return Promise.all([
      readWo(n),
      readNotes(n).catch(function () { return []; }),
      readPos(n).catch(function () { return []; })
    ]).then(function (r) {
      S.wo = r[0]; S.notes = r[1]; S.pos = r[2];
      if (!S.wo) throw new Error('work order ' + n + ' not found');
      S.scope = S.wo.scopeOfWork || '';
      var poIds = [], i;
      for (i = 0; i < (S.pos || []).length; i++) poIds.push(S.pos[i].id);
      return Promise.all([
        readQuotes(poIds).catch(function () { return []; }),
        S.wo.id != null ? readProposals(S.wo.id).catch(function () { return []; }) : Promise.resolve([]),
        S.wo.clientId ? readClientRates(S.wo.clientId).catch(function () { return null; }) : Promise.resolve(null)
      ]);
    }).then(function (r) {
      S.quotes = r[0]; S.proposals = r[1]; S.rates = r[2];
      setHtml('bwn-pp-status', '');
      S.busy = false; renderAll();
    })['catch'](function (e) {
      S.busy = false;
      setHtml('bwn-pp-status', '<span style="color:#8a1c1c">' + esc((e && e.message) || 'load failed') + '</span>');
      reportFail({ tag: 'pp-load', code: 'read', ids: { wo: n } });
      renderAll();
    });
  }

  // ===== import a vendor quote's lines ======================================
  var _uid = 0;
  function mkId() { _uid++; return 'pp' + _uid; }
  function importQuote(qi) {
    var q = (S.quotes || [])[qi]; if (!q) return;
    var lines = ppMapQuoteLines(q.quoteLineItems);
    var woTrade = (S.wo && S.wo.trades && S.wo.trades[0] && S.wo.trades[0].name) || '';
    var i, lump = 0;
    for (i = 0; i < lines.length; i++) {
      S.items.push(ppItemFromLine(lines[i], woTrade, mkId));
      if (lines[i].isLumpSum) lump++;
    }
    logln('Imported ' + lines.length + ' line(s) from ' + (q.vendorName || 'vendor') +
      ' - costs and categories are the vendor\'s own' +
      (lump ? '. ' + lump + ' are lump sums with no stated unit, so rate matching will ask for the quantity.' : '.'));
    S.rows = []; renderAll();
  }
  // Fallback for a quote that carries NO line items: seed one lump-sum item at the pre-tax
  // subtotal. Labelled as a lump sum so the matcher still asks for the quantity.
  function importQuoteLump(qi) {
    var q = (S.quotes || [])[qi]; if (!q) return;
    S.items.push({
      id: mkId(), vendorTotal: ppMoney(q.subtotal), qty: 1, _umbQtyKnown: false, unit: '',
      _catRaw: 'Other', _umbItem: '', trade: (S.wo && S.wo.trades && S.wo.trades[0] && S.wo.trades[0].name) || '',
      clientDescription: (q.vendorName || 'Vendor') + ' quote (lump sum)', taxPct: 0, taxable: false,
      labor: 0, materials: 0, _fromUmbravaQuote: true
    });
    logln('Loaded ' + (q.vendorName || 'vendor') + ' quote as ONE lump-sum line at ' + money(ppMoney(q.subtotal)) +
      ' pre-tax. Its category and quantity are unknown, so nothing prices until you set them.');
    S.rows = []; renderAll();
  }

  // ===== rate matching ======================================================
  function runRateMatch() {
    if (!S.wo || !S.wo.clientId) { logln('Load a work order first - the matcher needs the client tenant.'); return; }
    if (!S.items.length) { logln('Import a vendor quote first.'); return; }
    var cats = [], keys = {}, i, cid, crew, key;
    for (i = 0; i < S.items.length; i++) {
      cid = ppCatOf(S.items[i]);
      if (cid == null) continue;
      if (cats.indexOf(cid) < 0) cats.push(cid);
      crew = ppCrewOf(S.items[i]);
      key = cid + '|' + crew;
      if (!keys[key]) keys[key] = { cat: cid, crew: crew };
    }
    if (!cats.length) { logln('No line has a single cost category - set the categories first.'); return; }
    S.cats = cats;
    var list = [], k;
    for (k in keys) { if (Object.prototype.hasOwnProperty.call(keys, k)) list.push({ key: k, v: keys[k] }); }
    setHtml('bwn-pp-status', 'Matching ' + list.length + ' category/crew combination(s) against the contracted card...');
    // One lookup per (category + crew): two labour lines with different crews need different
    // rates, and asking once per category would hand both the same (wrong) suggestion.
    var chain = Promise.resolve(), byKey = {};
    list.forEach(function (e) {
      chain = chain.then(function () {
        return readRateMatches(S.wo.clientId, e.v.cat, {
          locationId: S.wo.locationId, workOrderId: S.wo.id, crewSize: e.v.crew, take: 25
        }).then(function (m) { byKey[e.key] = m; });
      });
    });
    return chain.then(function () {
      S.byKey = byKey;
      S.rows = [];
      for (i = 0; i < S.items.length; i++) {
        cid = ppCatOf(S.items[i]);
        var m = byKey[cid + '|' + ppCrewOf(S.items[i])];
        S.rows.push(ppMatchRow(S.items[i], m && m.suggested));
      }
      setHtml('bwn-pp-status', '');
      renderAll();
    })['catch'](function (e) {
      setHtml('bwn-pp-status', '<span style="color:#8a1c1c">rate match failed: ' + esc((e && e.message) || '') + '</span>');
      reportFail({ tag: 'pp-ratematch', code: 'read', ids: { wo: S.wo && S.wo.number } });
    });
  }
  // The category-wide option pool for a row's dropdown. Merged across crews so the operator can
  // pick a rate the crew filter would have hidden; it deliberately carries NO suggestion of its
  // own - suggestions are per category+crew (see ppConstraints).
  function optionsFor(categoryId) {
    var out = [], k, i, o;
    for (k in S.byKey) {
      if (!Object.prototype.hasOwnProperty.call(S.byKey, k)) continue;
      if (Number(k.split('|')[0]) !== categoryId) continue;
      for (i = 0; i < (S.byKey[k].options || []).length; i++) {
        o = S.byKey[k].options[i];
        var dup = false, j;
        for (j = 0; j < out.length; j++) { if (out[j].id === o.id) { dup = true; break; } }
        if (!dup) out.push(o);
      }
    }
    return out;
  }
  function findRow(itemId) { var i; for (i = 0; i < S.rows.length; i++) { if (S.rows[i].itemId === itemId) return S.rows[i]; } return null; }
  function onQty(itemId, val) {
    var r = findRow(itemId); if (!r) return;
    ppSetQty(r, val);
    var it, i;
    for (i = 0; i < S.items.length; i++) { if (S.items[i].id === itemId) it = S.items[i]; }
    if (it && Number(val) > 0) { it.qty = Number(val); it._umbQtyKnown = true; }
    renderAll();
  }
  function onRate(itemId, rateId) {
    var r = findRow(itemId); if (!r) return;
    var opts = optionsFor(r.categoryId), i, pick = null;
    for (i = 0; i < opts.length; i++) { if (opts[i].id === rateId) pick = opts[i]; }
    if (pick) ppSetRate(r, pick);
    renderAll();
  }

  // Priced rows -> the shape ppTotals expects.
  function totalRows() {
    var out = [], i, r;
    for (i = 0; i < S.rows.length; i++) {
      r = S.rows[i];
      var sub = r.skip ? (r.vendorCost || 0) : (r.clientPrice || 0);
      out.push({ subtotal: sub, taxAmt: sub * ((Number(r.taxPct) || 0) / 100), vendorCost: r.vendorCost || 0 });
    }
    return out;
  }

  // ===== AI features (all rank-gated; each states its own fallback) ==========
  function aiText(task, system, prompt, localFn) {
    var ctx = {};
    return bwnAI({
      task: task, tier: 'proxy', minRank: MIN_RANK, fallback: ['local'],
      system: system, prompt: prompt, timeoutMs: AI_ROUTER_TIMEOUT_MS,
      maxChars: 4000, local: localFn || function () { return ''; }, proxySend: function (p) { return aiProxySend(p, ctx); }
    }).then(function (txt) {
      if (!txt && ctx.reason) logln('AI: ' + ctx.reason);
      return txt;
    });
  }
  // Mechanical floor for the client-facing text: the priced rows themselves, so a coordinator
  // is never left with a blank box when the model is unreachable.
  function localScopeText() {
    var i, r, out = [];
    for (i = 0; i < S.rows.length; i++) {
      r = S.rows[i];
      out.push('- ' + (r.description || r.category) + (r.qty ? ' (' + r.qty + ' ' + (r.unit || 'ea') + ')' : ''));
    }
    return out.join('\n');
  }

  // ===== render =============================================================
  function renderAll() {
    if (!$id('bwn-pp-ov')) return;
    renderWo(); renderQuotes(); renderRows(); renderActions();
  }

  function renderWo() {
    var wo = S.wo;
    if (!wo) { setHtml('bwn-pp-wo', '<div style="color:#666">No work order loaded.</div>'); return; }
    var trades = [], i;
    for (i = 0; i < (wo.trades || []).length; i++) trades.push(esc(wo.trades[i].name));
    // Both GP bases are served. estimatedGrossProfitTaxedPercent is the basis the platform CHIP
    // shows, so matching the chip needs no per-location tax rate. Both are STRING fractions.
    var gpT = wo.grossProfitInfo ? Number(wo.grossProfitInfo.estimatedGrossProfitTaxedPercent) : NaN;
    var gpU = wo.grossProfitInfo ? Number(wo.grossProfitInfo.estimatedGrossProfitPercent) : NaN;
    var pins = [], n;
    for (i = 0; i < (S.notes || []).length && pins.length < 4; i++) {
      n = S.notes[i];
      if (n.isPinned || /\b(rate|pricing|nte|not to exceed|markup|agreement|approved amount)\b/i.test(n.content || '')) {
        pins.push((n.isPinned ? '[pinned] ' : '') + String(n.content || '').replace(/^\s+|\s+$/g, ''));
      }
    }
    var props = [];
    for (i = 0; i < (S.proposals || []).length; i++) {
      var p = S.proposals[i];
      props.push('#' + esc(String(p.number)) + ' ' + esc((p.status && p.status.name) || p.state) +
        ' - ' + money(ppMoney(p.subtotal)) + (p.grossProfitPercent != null ? ' - GP ' + (Number(p.grossProfitPercent) * 100).toFixed(1) + '%' : ''));
    }
    setHtml('bwn-pp-wo',
      '<div style="font-weight:600;font-size:14px">' + esc(wo.formattedJobNumber || ('W-' + wo.number)) + ' - ' + esc(wo.clientName || '') + '</div>' +
      '<div style="color:#555;margin:2px 0 6px">' + esc(wo.locationName || '') + (wo.locationNumber ? ' - ' + esc(wo.locationNumber) : '') +
        ' - ' + esc(wo.statusName || '') + (wo.phase ? ' - ' + esc(wo.phase) : '') + '</div>' +
      '<div style="font-size:12.5px;line-height:1.7">' +
      (trades.length ? '<b>Trades</b> ' + trades.join(', ') + '<br>' : '') +
      (wo.doNotExceed ? '<b>Client DNE</b> ' + money(ppMoney(wo.doNotExceed)) + ' &nbsp; <b>Vendor NTE</b> ' + money(ppMoney(wo.totalNTE)) + '<br>' : '') +
      (isFinite(gpT) ? '<b>Umbrava GP</b> ' + (gpT * 100).toFixed(2) + '% <span style="color:#666">(platform basis' +
        (isFinite(gpU) ? '; ' + (gpU * 100).toFixed(2) + '% untaxed/DNE' : '') + ')</span><br>' : '') +
      (props.length ? '<b>Existing proposals</b> ' + props.join(' &nbsp;|&nbsp; ') + '<br>' : '') +
      (S.rates ? '<b>Contracted rates</b> ' + S.rates.rowCount + ' active<br>' : '<span style="color:#8a4b00">No contracted rate card read for this client.</span><br>') +
      '</div>' +
      (pins.length ? '<div style="margin-top:8px;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:6px;padding:7px 9px;font-size:12px;white-space:pre-wrap;max-height:120px;overflow:auto"><b>Pricing notes</b>\n' + esc(pins.join('\n\n')) + '</div>' : '') +
      (wo.scopeOfWork ? '<div style="margin-top:8px;font-size:12px;color:#333;white-space:pre-wrap;max-height:140px;overflow:auto"><b>Scope</b>\n' + esc(wo.scopeOfWork) + '</div>' : ''));
  }

  function renderQuotes() {
    var qs = S.quotes;
    if (!qs || !qs.length) { setHtml('bwn-pp-quotes', S.wo ? '<div style="color:#666">No vendor quotes on this WO.</div>' : ''); return; }
    var h = '', i, q, lines, cats, mism;
    for (i = 0; i < qs.length; i++) {
      q = qs[i];
      lines = ppMapQuoteLines(q.quoteLineItems);
      cats = []; mism = 0;
      for (var j = 0; j < lines.length; j++) {
        if (cats.indexOf(lines[j].category) < 0) cats.push(lines[j].category);
        if (/Mismatch/i.test(lines[j].rateVerdict || '')) mism++;
      }
      h += '<div style="border:1px solid #e0e6e2;border-radius:6px;padding:7px 9px;margin-bottom:6px">' +
        '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">' +
        '<b>' + esc(q.vendorName || 'Vendor') + '</b>' +
        '<span style="color:#666;font-size:12px">' + esc(q.formattedPurchaseOrderNumber || '') +
        ((q.status && q.status.name) ? ' - ' + esc(q.status.name) : '') +
        (lines.length ? ' - ' + lines.length + ' line' + (lines.length > 1 ? 's' : '') : ' - no line items') +
        (cats.length ? ' - ' + esc(cats.join(', ')) : '') + '</span>' +
        '<span style="margin-left:auto;font-weight:600">' + money(ppMoney(q.subtotal)) + '</span>' +
        '<span style="color:#666;font-size:11px">pre-tax cost</span></div>' +
        (mism ? '<div style="font-size:11px;color:#8a4b00">' + mism + ' line(s) off the contracted rate - Umbrava\'s own comparison</div>' : '') +
        '<div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">' +
        (lines.length ? '<button type="button" data-pp-import="' + i + '" style="background:' + GREEN + ';color:#fff;border:0;padding:5px 11px;border-radius:6px;font-weight:600;cursor:pointer">Import ' + lines.length + ' lines</button>' : '') +
        '<button type="button" data-pp-lump="' + i + '" style="background:#f2f4f3;border:1px solid #cfd8d3;padding:5px 11px;border-radius:6px;cursor:pointer">Use as lump sum</button>' +
        '</div></div>';
    }
    setHtml('bwn-pp-quotes', h +
      '<div style="font-size:11px;color:#666">Costs and cost categories are the vendor\'s own - nothing here is estimated. The paste / PDF / photo actions below are for emailed bid-out replies.</div>');
  }

  function renderRows() {
    if (!S.items.length) { setHtml('bwn-pp-rows', ''); setHtml('bwn-pp-totals', ''); return; }
    if (!S.rows.length) {
      setHtml('bwn-pp-rows', '<div style="color:#666">' + S.items.length + ' line(s) imported. Run <b>Match to contracted rates</b> to price them.</div>');
      setHtml('bwn-pp-totals', ''); return;
    }
    var h = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;border-bottom:1px solid #dde3df">' +
      '<th>Line</th><th>Category</th><th style="text-align:right">Cost</th><th style="text-align:right">Qty</th><th>Contracted rate</th><th style="text-align:right">Price</th><th style="text-align:right">GP</th></tr></thead><tbody>';
    var i, r, opts, j, lineGp;
    for (i = 0; i < S.rows.length; i++) {
      r = S.rows[i];
      opts = optionsFor(r.categoryId);
      lineGp = (!r.skip && r.clientPrice > 0) ? ((r.clientPrice - r.vendorCost) / r.clientPrice * 100) : null;
      h += '<tr style="border-bottom:1px solid #eef2f0' + (r.skip ? ';opacity:.65' : '') + '">' +
        '<td style="max-width:180px">' + esc(r.description || '(no description)') +
        (r.uomMismatch ? '<div style="font-size:10px;color:#8a4b00">unit "' + esc(r.unit) + '" != rate unit "' + esc(r.matched ? r.matched.uom : '') + '" - skipped</div>' : '') +
        (!r.matched ? '<div style="font-size:10px;color:#8a4b00">no contracted rate - left at cost</div>' : '') +
        (r.needsQty ? '<div style="font-size:10px;color:#185fa5">lump sum - enter the ' + esc(r.unit || 'unit') + ' quantity to price it</div>' : '') +
        '</td>' +
        '<td style="color:#555">' + esc(r.category) + (r.crew ? '<div style="font-size:10px;color:#666">crew ' + r.crew + ' (from the vendor\'s text)</div>' : '') + '</td>' +
        '<td style="text-align:right">' + money(r.vendorCost) + '</td>' +
        '<td style="text-align:right">' + (r.qtyKnown && r.unitKnown
          ? (r.qty + ' ' + esc(r.unit || ''))
          : '<input type="number" min="0" step="0.25" value="' + (r.needsQty ? '' : r.qty) + '" data-pp-qty="' + esc(r.itemId) + '" style="width:58px;text-align:right">' +
            '<div style="font-size:10px;color:#666">' + esc(r.unit || '?') + ' - not stated</div>') + '</td>' +
        '<td>';
      if (opts.length) {
        h += '<select data-pp-rate="' + esc(r.itemId) + '" style="max-width:200px;font-size:11px">';
        for (j = 0; j < opts.length; j++) {
          h += '<option value="' + esc(opts[j].id) + '"' + (opts[j].id === r.chosenRateId ? ' selected' : '') + '>' +
            esc(opts[j].item) + ' - ' + money(opts[j].rate) + '/' + esc(opts[j].uom) +
            (opts[j].accepted ? '' : ' (unaccepted)') +
            (opts[j].labor && opts[j].labor.crewSize > 1 ? ' - crew ' + opts[j].labor.crewSize : '') + '</option>';
        }
        h += '</select>';
      } else { h += '<span style="color:#666">no contracted rate</span>'; }
      h += '</td>' +
        '<td style="text-align:right;font-weight:600">' + (r.skip ? '-' : money(r.clientPrice)) + '</td>' +
        '<td style="text-align:right' + (lineGp !== null && lineGp < 0 ? ';color:#8a1c1c;font-weight:600' : '') + '">' +
        (lineGp === null ? '-' : lineGp.toFixed(1) + '%') + '</td></tr>';
    }
    h += '</tbody></table>';
    setHtml('bwn-pp-rows', h);

    var t = ppTotals(totalRows(), 0.33);
    var cons = ppConstraints(S.rows, S.cats);
    var col = t.hitsTarget ? '#1a5f3e' : (t.gpPct >= 20 ? '#8a4b00' : '#8a1c1c');
    setHtml('bwn-pp-totals',
      '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;padding:7px 9px;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:6px">' +
      '<div><span style="color:#666;font-size:11px">VENDOR COST</span><br><b>' + money(t.vendorCost) + '</b></div>' +
      '<div><span style="color:#666;font-size:11px">CLIENT SUBTOTAL</span><br><b>' + money(t.subtotal) + '</b></div>' +
      '<div><span style="color:#666;font-size:11px">GP (PRE-TAX)</span><br><b style="color:' + col + '">' + money(t.gp) + ' - ' + t.gpPct.toFixed(2) + '%</b></div>' +
      '<div><span style="color:#666;font-size:11px">TO HIT 33%</span><br><b>' + money(t.targetSubtotal) + '</b></div>' +
      '</div>' +
      '<div style="font-size:10px;color:#666;margin-top:3px">Umbrava basis: subtotal minus vendor cost, pre-tax. The taxed basis would read ' + t.gpTaxedPct.toFixed(2) + '%. Skipped lines stay at vendor cost.</div>' +
      (cons.length ? '<div style="margin-top:6px;background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;border-radius:6px;padding:7px 9px;font-size:11.5px">' + esc(cons.join(' - ')) + '</div>' : ''));
  }

  function renderActions() {
    var canAi = gated();
    var priced = 0, i;
    for (i = 0; i < S.rows.length; i++) { if (!S.rows[i].skip) priced++; }
    var canWrite = canAi && S.wo && priced > 0 && bwnCanAll(['WorkOrderProposal.AddNew', 'WorkOrderProposal.EditFields']);
    setHtml('bwn-pp-actions',
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<button type="button" id="bwn-pp-match" style="background:' + GREEN + ';color:#fff;border:0;padding:7px 13px;border-radius:6px;font-weight:600;cursor:pointer">Match to contracted rates</button>' +
      (canAi ? '<button type="button" id="bwn-pp-verbiage" style="background:#f2f4f3;border:1px solid #cfd8d3;padding:7px 11px;border-radius:6px;cursor:pointer">Client verbiage</button>' +
               '<button type="button" id="bwn-pp-protect" style="background:#f2f4f3;border:1px solid #cfd8d3;padding:7px 11px;border-radius:6px;cursor:pointer">Exclusions + CO triggers</button>'
             : '<span style="font-size:11px;color:#666">AI drafting needs manager access (rank ' + MIN_RANK + '+).</span>') +
      '</div>' +
      (canAi ? '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
        '<label style="font-size:11.5px">Emailed quote: <input type="file" id="bwn-pp-media" accept=".pdf,image/*" multiple style="font-size:11px"></label>' +
        '<button type="button" id="bwn-pp-readmedia" style="background:#f2f4f3;border:1px solid #cfd8d3;padding:5px 11px;border-radius:6px;cursor:pointer">Read PDF / photos</button>' +
        '</div>' : '') +
      '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e0e6e2">' +
      (canWrite
        ? '<button type="button" id="bwn-pp-push" style="background:#8a4b00;color:#fff;border:0;padding:7px 13px;border-radius:6px;font-weight:600;cursor:pointer">Push ' + priced + ' priced line(s) as a Draft proposal</button>' +
          '<div style="font-size:11px;color:#666;margin-top:4px">Creates a DRAFT only - nothing is submitted, approved or sent - then re-reads it to verify.</div>'
        : '<div style="font-size:11px;color:#666">Push-to-draft needs manager access, at least one priced line, and the WorkOrderProposal add/edit permissions.</div>') +
      '</div>' +
      '<div id="bwn-pp-out" style="margin-top:8px;font-size:12px"></div>');
  }

  // ===== drawer =============================================================
  function buildDrawer() {
    if ($id('bwn-pp-ov')) return;
    var ov = document.createElement('aside');
    ov.id = 'bwn-pp-ov'; ov.className = 'bwn-drawer';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Proposal Pricing');
    // Mark our own root so the DOM collector prunes it instead of reading this UI back to a
    // model as Umbrava record fact ([[dom-handle-protocol]] injected-UI finding).
    ov.setAttribute('data-bwn-domp-ui', '1');
    // Claim the single drawer slot BEFORE mounting, so any other tool folds away first.
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;';
    var guess = woNumberFromPath();
    box.innerHTML =
      '<div class="bwn-drawer-hd"><div><div class="t">Proposal Pricing</div><div class="s">vendor quote to client proposal, on contracted rates</div></div>' +
      '<button type="button" id="bwn-pp-x" class="bwn-drawer-x" title="Close" aria-label="Close">&times;</button></div>' +
      '<div class="bwn-drawer-body">' +
      '<div id="bwn-pp-keywarn" style="display:none;background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;padding:8px 10px;border-radius:8px;margin-bottom:10px;font-size:12.5px"></div>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">' +
      '<label style="font-weight:600;font-size:12.5px">WO</label>' +
      '<input id="bwn-pp-won" type="text" inputmode="numeric" value="' + (guess ? String(guess) : '') + '" placeholder="WO / tracking #" style="width:130px">' +
      '<button type="button" id="bwn-pp-load" style="background:' + GREEN + ';color:#fff;border:0;padding:6px 13px;border-radius:6px;font-weight:600;cursor:pointer">Load</button>' +
      '<span id="bwn-pp-status" role="status" aria-live="polite" style="font-size:12px;color:#555"></span>' +
      '</div>' +
      '<div id="bwn-pp-wo" style="margin-bottom:10px"></div>' +
      '<div id="bwn-pp-quotes" style="margin-bottom:10px"></div>' +
      '<div id="bwn-pp-actions" style="margin-bottom:10px"></div>' +
      '<div id="bwn-pp-rows" style="margin-bottom:8px;overflow-x:auto"></div>' +
      '<div id="bwn-pp-totals" style="margin-bottom:10px"></div>' +
      '<div id="bwn-pp-log" style="font:12px ui-monospace,Consolas,monospace;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:8px;padding:9px;max-height:150px;overflow:auto;white-space:pre-wrap"></div>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    bwnFocusTrap(ov);

    function tryClose() {
      if (S.busy) { logln('  (still loading - give it a moment)'); return; }
      drawerDismiss(ov);
    }
    ov.addEventListener('click', function (e) { if (e.target === ov) tryClose(); });
    $id('bwn-pp-x').onclick = tryClose;
    if (!getKey()) {
      var kw = $id('bwn-pp-keywarn');
      kw.style.display = 'block';
      kw.textContent = 'No SWA ingest key set, so the AI actions are off. Set it from the Tampermonkey menu: "BWN Proposal Pricing: Set SWA ingest key". Everything else - reads, rate matching, pricing and push-to-draft - works without it.';
    }

    // The field takes a WO number, a tracking number or a source job/PO number. A WO number
    // loads directly; anything else is resolved through lookupJob, the op Umbrava's own search
    // box fires (~300ms, versus 6-28s for a free-text listWorkOrdersPaginated search).
    $id('bwn-pp-load').onclick = function () {
      var raw = String($id('bwn-pp-won').value || '').replace(/^\s+|\s+$/g, '');
      if (!raw) { setHtml('bwn-pp-status', '<span style="color:#8a1c1c">enter a WO, tracking or source number</span>'); return; }
      var digits = raw.replace(/^(W|PO)[-\s]*/i, '').replace(/[^\d]/g, '');
      // A bare 6-digit value is a WO number; try it directly and fall back to the typeahead.
      if (digits && digits.length <= 7 && /^(W[-\s]*)?\d+$/i.test(raw)) {
        loadWo(parseInt(digits, 10));
        return;
      }
      setHtml('bwn-pp-status', 'Looking up "' + esc(raw) + '"...');
      readLookupJob(digits || raw, 8).then(function (hits) {
        if (!hits.length) { setHtml('bwn-pp-status', '<span style="color:#8a1c1c">nothing matches "' + esc(raw) + '"</span>'); return; }
        if (hits.length > 1) {
          // More than one match is the operator's call, not ours to guess.
          setHtml('bwn-pp-status', hits.length + ' matches: ' + hits.map(function (h) {
            return esc(h.formattedJobNumber || ('W-' + h.number));
          }).join(', ') + ' - enter the WO number you want');
          return;
        }
        $id('bwn-pp-won').value = String(hits[0].number);
        loadWo(hits[0].number);
      })['catch'](function (e) {
        setHtml('bwn-pp-status', '<span style="color:#8a1c1c">lookup failed: ' + esc((e && e.message) || '') + '</span>');
      });
    };
    // One delegated listener for everything inside the body: the rows and quote cards are
    // re-rendered wholesale, so per-element handlers would be re-bound on every repaint.
    box.addEventListener('click', function (e) {
      var t = e.target; if (!t || !t.getAttribute) return;
      var imp = t.getAttribute('data-pp-import'), lump = t.getAttribute('data-pp-lump');
      if (imp != null) { importQuote(Number(imp)); return; }
      if (lump != null) { importQuoteLump(Number(lump)); return; }
      if (t.id === 'bwn-pp-match') { runRateMatch(); return; }
      if (t.id === 'bwn-pp-verbiage') { doVerbiage(); return; }
      if (t.id === 'bwn-pp-protect') { doProtections(); return; }
      if (t.id === 'bwn-pp-readmedia') { doReadMedia(); return; }
      if (t.id === 'bwn-pp-push') { doPush(); return; }
    });
    box.addEventListener('change', function (e) {
      var t = e.target; if (!t || !t.getAttribute) return;
      var q = t.getAttribute('data-pp-qty'), r = t.getAttribute('data-pp-rate');
      if (q) { onQty(q, t.value); return; }
      if (r) { onRate(r, t.value); return; }
    });

    renderAll();
    if (guess) loadWo(guess);
  }

  // ===== AI actions =========================================================
  function doVerbiage() {
    if (!S.rows.length) { logln('Price the lines first.'); return; }
    logln('Drafting client verbiage...');
    aiText('draft',
      'You are writing the client-facing scope line for a facilities work order proposal. Plain, factual, no marketing language. Output only the text.',
      'Work order scope:\n' + (S.scope || '(none)') + '\n\nPriced lines:\n' + localScopeText(),
      localScopeText
    ).then(function (txt) {
      if (txt) setHtml('bwn-pp-out', '<b>Client verbiage</b><div style="white-space:pre-wrap;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:6px;padding:8px;margin-top:4px">' + esc(txt) + '</div>');
    });
  }
  function doProtections() {
    if (!S.rows.length) { logln('Price the lines first.'); return; }
    logln('Drafting exclusions and change-order triggers...');
    aiText('render',
      'You are a construction estimator. From the scope and priced lines, list (a) exclusions and assumptions worth stating, and (b) conditions that would trigger a change order. Be specific to this scope. Do not invent prices or quantities. Output two short labelled lists.',
      'Scope:\n' + (S.scope || '(none)') + '\n\nPriced lines:\n' + localScopeText(),
      function () { return ''; }
    ).then(function (txt) {
      if (txt) setHtml('bwn-pp-out', '<b>Exclusions + change-order triggers</b><div style="white-space:pre-wrap;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:6px;padding:8px;margin-top:4px">' + esc(txt) + '</div>');
    });
  }
  // PDF / photos: read the files as base64 and send them as content blocks. This is the only
  // place estimation is defensible - an EMAILED bid-out reply that is not a record yet.
  function doReadMedia() {
    var inp = $id('bwn-pp-media');
    var files = (inp && inp.files) ? inp.files : null;
    if (!files || !files.length) { logln('Choose a PDF or photos first.'); return; }
    var blocks = [], pending = files.length, i;
    logln('Reading ' + files.length + ' file(s)...');
    function done() {
      if (--pending > 0) return;
      if (!blocks.length) { logln('Nothing readable in those files.'); return; }
      var ctx = {};
      ppAiMedia('render',
        'You are a field service cost analyst. Extract every line item you can see. For each, output one block:\n<item>\ncategory: Labor|Material|Equipment|Travel|Other\ndescription: ...\nqty: ...\nunit: ...\nunitCost: ...\ntotalCost: ...\n</item>\nUse ONLY numbers that appear in the document. If a value is not stated, leave it blank - never estimate one.',
        'Extract the vendor line items.' + (S.scope ? '\n\nWO scope for context: ' + S.scope : ''),
        blocks, ctx
      ).then(function (txt) {
        if (!txt) { logln('Read failed: ' + (ctx.reason || 'no answer')); return; }
        if (ctx.skipped) logln('Note: ' + ctx.skipped + ' file(s) were too large to send.');
        setHtml('bwn-pp-out', '<b>Extracted from the document</b><div style="font-size:11px;color:#8a4b00;margin:3px 0">AI-extracted from an emailed quote - check every number against the document before pricing it.</div><div style="white-space:pre-wrap;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:6px;padding:8px;font:12px ui-monospace,Consolas,monospace">' + esc(txt) + '</div>');
      });
    }
    for (i = 0; i < files.length; i++) {
      (function (f) {
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var s = String(fr.result || ''), c = s.indexOf(',');
            var b64 = c >= 0 ? s.slice(c + 1) : '';
            var isPdf = /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name || '');
            if (b64) blocks.push(isPdf
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
              : { type: 'image', source: { type: 'base64', media_type: f.type || 'image/jpeg', data: b64 } });
          } catch (e) { }
          done();
        };
        fr.onerror = function () { done(); };
        fr.readAsDataURL(f);
      })(files[i]);
    }
  }

  // ===== push ===============================================================
  function doPush() {
    if (!S.wo) return;
    var priced = 0, i;
    for (i = 0; i < S.rows.length; i++) { if (!S.rows[i].skip) priced++; }
    var label = 'W-' + S.wo.number;
    // A second, explicit confirmation on top of bwnGqlOp's own high-risk gate: this creates a
    // record on a real work order.
    if (!window.confirm('Create a DRAFT client proposal on ' + label + ' with ' + priced + ' priced line(s)?\n\nNothing is submitted, approved or sent. The draft is re-read afterwards to verify it.')) return;
    var btn = $id('bwn-pp-push'); if (btn) { btn.disabled = true; btn.textContent = 'Creating draft...'; }
    ppPushDraft(S.wo, S.rows, S.scope).then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = 'Push priced line(s) as a Draft proposal'; }
      if (res.verified) {
        setHtml('bwn-pp-out', '<div style="background:#eef7f1;border:1px solid #b7dcc4;color:#1a5f3e;border-radius:6px;padding:8px"><b>Draft #' + esc(String(res.number)) + ' created and verified.</b><br>' + esc(String((res.readBack && res.readBack.proposalLineItems || []).length)) + ' line items, subtotal ' + money(ppMoney(res.readBack && res.readBack.subtotal)) + '. Nothing was submitted.</div>');
        logln('Draft #' + res.number + ' created and verified.');
      } else {
        setHtml('bwn-pp-out', '<div style="background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;border-radius:6px;padding:8px"><b>Draft #' + esc(String(res.number)) + ' was created but did NOT verify.</b><br>' + esc(res.problems.join('; ')) + '<br>Open it in Umbrava and check it by hand.</div>');
        logln('Draft #' + res.number + ' created but not verified: ' + res.problems.join('; '));
        reportFail({ tag: 'pp-push', code: 'verify', ids: { wo: S.wo.number, proposalId: res.id } });
      }
      renderAll();
    })['catch'](function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Push priced line(s) as a Draft proposal'; }
      var msg = (e && e.message) || 'push failed';
      setHtml('bwn-pp-out', '<div style="background:#fdeaea;border:1px solid #f0b7b7;color:#8a1c1c;border-radius:6px;padding:8px"><b>The draft was not created.</b><br>' + esc(msg) + '</div>');
      logln('Push failed: ' + msg);
      reportFail({ tag: 'pp-push', code: (e && e.stage) || 'write', ids: { wo: S.wo.number } });
    });
  }

  // ===== menu ===============================================================
  try {
    GM_registerMenuCommand('BWN Proposal Pricing: Set SWA ingest key', function () {
      var cur = getKey();
      var v = window.prompt('SWA ingest key (same value as the connector WO_INGEST_KEY). Tampermonkey scopes this PER SCRIPT, so setting it here sets it for Proposal Pricing only - every other suite script needs its own copy. Only the AI actions use it; reads, rate matching and push-to-draft do not:', cur || '');
      if (v === null) return;
      try { GM_setValue('ingest_key', String(v).replace(/^\s+|\s+$/g, '')); } catch (e) { }
      publishIngestPresence();
      var kw = $id('bwn-pp-keywarn'); if (kw) kw.style.display = getKey() ? 'none' : 'block';
    });
    GM_registerMenuCommand('BWN Proposal Pricing: open', function () { buildDrawer(); });
  } catch (e) { /* menu API absent - the dock entry is still the launcher */ }

  // ===== shared launcher dock (bwn:dock:*) ==================================
  // This is a WO-LEVEL tool - it consumes a whole work order and emits a proposal - so it
  // registers a dock entry rather than anchoring to one record ([[bwn-launcher-dock]]).
  // detail.key carries the entry id; detail.id is the bwn:evt event name.
  var _hostSeen = false;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Proposal Pricing', icon: '🧾', weight: 26,
        minRank: 1, title: 'BWN Proposal Pricing - price a WO vendor quote on the client\'s contracted rates'
      } }));
    } catch (e) { }
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail; if (!d) return;
      if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') { _hostSeen = true; dockRegister(); }
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildDrawer();
      // Another tool claimed the single drawer slot - fold ours away, unless a load is in
      // flight (the reads span several round trips and evicting mid-load loses them).
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY && !S.busy) {
        var o = $id('bwn-pp-ov'); if (o) drawerDismiss(o);
      }
    });
  } catch (e) { }

  bwnAI.setProxy(aiProxySend);
  publishIngestPresence();
  dockRegister();
  setTimeout(function () {
    if (!_hostSeen) console.warn('[BWN PROPOSAL PRICING] no dock host - install/enable BWN Suite Core to reach Proposal Pricing.');
  }, 4000);
})();
