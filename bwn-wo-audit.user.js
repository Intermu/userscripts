// ==UserScript==
// @name         BWN WO Audit (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.13.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-audit.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-audit.user.js
// @description  Batch WO-audit tool. Upload a WO audit .xlsx; for each work order this reads its two most recent notes DIRECTLY from Umbrava's GraphQL API in-page (using your live Umbrava session - the same read the BWN Ops Suite AI drafts use), then asks the broadway-internal-ops SWA summarize route (x-bwn-key gated, Anthropic key server-side) to write a status note - for jobs aged over 30 days a dated "Over 30 - trade - event timeline - ECD" chain built from the WO's FULL note history (with a PAST/needs-ECD flag when the committed date has lapsed), otherwise a 1-3 sentence client-ready status note. Fills the audit's notes column and downloads the workbook, preserving every other cell and formula. It also reads each WO's live header (status, phase, priority, GP, DNE/NTE, PO/vendor, schedule) in the same call and writes a deterministic Audit Flags column (OVERDUE, NEG/LOW GP, NTE>DNE, NO VENDOR, UNSCHEDULED, STALE) computed with no AI - so the exception audit survives an AI outage. Runs entirely in the app.umbrava.com page so it inherits your Umbrava auth - no MCP, no pasted keys, nothing sensitive in this script. This replaces the old standalone WO_Audit_Automation.html SWA tool, whose server-side MCP path could not authenticate to Umbrava. After a run drafts its notes, the coordinator can post each drafted note as an INTERNAL Umbrava note onto its aged (>30d) work order - one explicit click per note (human-gated, idempotent), routed through the governed bwnGqlOp write path with its permission gate and audit trail.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js#sha384=bed8dab3289d528d245bde0ae4c5c35e7b73389a50801297984eded866b82c6d2c9134cb7818bdede1405eca9ec098f0
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.13.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";

  // Suite drawer exit, per the contract in Core's ensureStyle. Core's stylesheet owns the fade;
  // sandboxes cannot share the helper, so these five lines are duplicated in every drawer module.
  // Module scope on purpose - both the close button and the drawer-slot bus listener call it.
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
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var GREEN = '#0d3d26';
  var MS_DAY = 86400000;
  var MODELS = [
    { id: 'claude-sonnet-5', label: 'Sonnet 5 (default)' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8 (best)' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
  ];
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  console.info('[BWN WO AUDIT] v' + VER + ' - in-page GraphQL header+notes read -> deterministic Audit Flags + bwnAI /api/ai status note -> filled .xlsx download; can then post each drafted note as an INTERNAL note onto its aged (>30d) work order, one click per note (governed bwnGqlOp write path); registers into the shared dock (bwn:dock:*)');

  // ====================================================================
  // Auth: the live Umbrava Auth0 bearer, read straight from the page (same
  // content-based pick bwn-suite-ai/gql use). This is the whole reason the tool
  // runs in-page: a server-side Function has no Umbrava session, which is why the
  // old MCP route failed with a 400 "Authentication error".
  // ====================================================================
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

  // Same-origin GraphQL POST -> resolves to `data`, throws on errors[]. Carries the
  // page's own Umbrava bearer; no @connect needed (app.umbrava.com is same-origin).
  // Bounded. Without a timeout one hung read parks runPool forever: that runner never settles, so
  // Promise.all never resolves, the completion block never runs, Download never appears, and the
  // close-guard refuses to let the drawer go because `_running` is still true. The only exit was
  // reloading the tab, which discards every note already written into the in-memory workbook -
  // exactly the orphaning the guard exists to prevent, made unrecoverable.
  var GQL_TIMEOUT_MS = 30000;
  function gql(query, variables) {
    var tok = authToken();
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctl) { try { ctl.abort(); } catch (e) { } }
        reject(new Error('Umbrava did not respond in time (' + Math.round(GQL_TIMEOUT_MS / 1000) + 's)'));
      }, GQL_TIMEOUT_MS);
      fetch('/api/graphql', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, variables: variables || {} }),
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        // A batch now spans many minutes, so the bearer read once at Start can expire mid-run.
        // r.json() on a non-JSON 401 body rejects with "Unexpected token '<'", which is the exact
        // class of un-actionable message the plain-language cause layer exists to remove.
        if (r.status === 401 || r.status === 403) {
          throw new Error('your Umbrava session expired - reload the tab and press Retry Unfinished');
        }
        return r.json();
      }).then(function (j) {
        if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
        resolve(j && j.data);
      }).catch(reject);
    }).then(function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; });
  }

  function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
  function _stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // One WO's LIVE header + notes, newest first. Notes use Umbrava's REAL jobNotes query (captured
  // off the wire 2026-07-23, a ROOT field keyed by the WO NUMBER - no internal-id lookup). The
  // header is the pinned single-WO WorkOrderFields read (the same one WO Assist's GP/NTE override
  // uses): status, phase, priority, GP, DNE/NTE and PO/vendor presence in ONE call - so the audit
  // judges LIVE state instead of the uploaded sheet's stale columns. Same call count as before
  // (header replaces the old statusName-only read). The header is BEST-EFFORT (null on any error):
  // a header miss must NOT fail the row - notes still summarize and flags just stay silent for that
  // WO. Notes errors still REJECT (surface loudly per WO).
  var NOTES_Q = 'query($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content contentHtml createdDate isPinned isCompletion workOrderNoteSource createdBy { firstName lastName } } }';
  var HEADER_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ statusName phase remainingDays nextOnsiteDate priority{ label category responseMinutes expectedCompletionDate } doNotExceed{ amount precision } totalNTE{ amount precision } grossProfitInfo{ estimatedGrossProfitPercent trueGrossProfitPercent } hasNonTerminatedPurchaseOrders purchaseOrders{ id } trades{ name } } }';

  // ===== BWN AUDIT FLAGS START (pure; sliced by scripts/test-wo-audit-flags.js) =================
  // Money arrives as minor units + its own precision ({amount:1448564, precision:2} = 14485.64).
  function moneyDollars(m) {
    if (!m || m.amount == null) return null;
    var p = (typeof m.precision === 'number') ? m.precision : 2;
    var n = Number(m.amount);
    return isFinite(n) ? n / Math.pow(10, p) : null;
  }
  // GP% is a STRING FRACTION of DNE revenue, not a 0-100 number (pin: est = (DNE-NTE)/DNE). Prefer
  // the true (invoiced) GP when present, else estimated. Returns a percent (x100) or null.
  function gpPercent(h) {
    var g = h && h.grossProfitInfo; if (!g) return null;
    var raw = (g.trueGrossProfitPercent != null && g.trueGrossProfitPercent !== '') ? g.trueGrossProfitPercent : g.estimatedGrossProfitPercent;
    if (raw == null || raw === '') return null;
    var n = Number(raw);
    return isFinite(n) ? n * 100 : null;
  }
  // Deterministic exception flags from the LIVE header + notes - no LLM, no rate limit, no cost, so
  // they survive an AI outage (the 2026-08-18 credit failure would still have delivered these).
  // `nowMs` is INJECTED, never Date.now(), so the harness asserts ages on a fixed clock
  // ([[fixture-clock-time-day-age]] / [[headless-harness-cannot-time]]). A null header returns []
  // (say nothing rather than fabricate a clean bill of health - unread is not empty).
  var GP_LOW_PCT = 15;   // default - per-user override: Core Ops Suite panel > Preferences (bwn:config.audit.gpLow)
  var STALE_DAYS = 7;    // default - per-user override: bwn:config.audit.staleDays
  // Reads the override off the shared bwn:config blob Core's panel writes. Page localStorage is
  // readable from this GM sandbox (same channel as bwn:role:last). Absent, malformed, non-finite,
  // or no localStorage at all (the node harness) -> the default.
  function auditCfg(key, def) {
    try {
      var c = JSON.parse(localStorage.getItem('bwn:config') || 'null');
      var v = c && c.audit && c.audit[key];
      return (typeof v === 'number' && isFinite(v)) ? v : def;
    } catch (e) { return def; }
  }
  function computeFlags(h, notes, nowMs) {
    var f = [];
    if (!h) return f;
    if (typeof h.remainingDays === 'number' && h.remainingDays < 0) f.push('OVERDUE ' + Math.abs(h.remainingDays) + 'd');
    var gp = gpPercent(h);
    if (gp != null) { if (gp < 0) f.push('NEG GP'); else if (gp < auditCfg('gpLow', GP_LOW_PCT)) f.push('LOW GP ' + Math.round(gp) + '%'); }
    var dne = moneyDollars(h.doNotExceed), nte = moneyDollars(h.totalNTE);
    if (dne != null && nte != null && dne > 0 && nte > dne) f.push('NTE>DNE');
    var hasVendor = (typeof h.hasNonTerminatedPurchaseOrders === 'boolean')
      ? h.hasNonTerminatedPurchaseOrders
      : !!(h.purchaseOrders && h.purchaseOrders.length);
    if (!hasVendor) f.push('NO VENDOR');
    if (String(h.phase || '') === 'Open' && !h.nextOnsiteDate) f.push('UNSCHEDULED');
    if (notes && notes.length) {
      var newest = _date(notes[0] && notes[0].createdDate);
      if (newest) { var age = Math.floor((nowMs - (+newest)) / MS_DAY); if (age > auditCfg('staleDays', STALE_DAYS)) f.push('STALE ' + age + 'd'); }
    } else if (notes) {
      f.push('NO NOTES');
    }
    return f;
  }
  // ===== BWN AUDIT FLAGS END ====================================================================

  // ---- BWN-OPS: audited GraphQL write path for the note-posting step -----------
  // Routes the posted status note through bwnGqlOp (the paste-identical BWN-OPS-WRAP below,
  // SHA-gated to Core by scripts/test-bwn-ops.js): a correlation id + the shared bwn:audit entry +
  // centralized success:false rejection + the Umbrava permission gate. addEditJobNote is moderate
  // (no confirm gate; the human click IS the gate). bwnGql just forwards to this file's own gql()
  // (POSTs /api/graphql, resolves `data`, throws on errors[]) - the transport contract the wrapper
  // needs. Reads (header + notes) stay on gql() directly; only the WRITE goes through here.
  var bwnGql = function (query, variables) { return gql(query, variables); };
  var BWN_VER = '0.10.0';
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  // Central governance (governance-sync): fold the org flags bwn-suite-ai caches to bwn:gov into
  // BWN_MODULES as ONE-WAY disables, the SAME shape as bwn-suite-core's bwnApplyGov(). A remote
  // flags['lowGp']===false or flags.globalKillSwitch DISABLES this script's writes - the bwnGqlOp
  // per-feature gate below reads BWN_MODULES['lowGp'] live - and can NEVER enable one. Fail-closed:
  // an absent or corrupt bundle keeps the local defaults (last-known-good), never relaxes. Re-applies
  // on the bwn:gov ping so a remote kill blocks new writes with no reload.
  if (!('woAuditNotes' in BWN_MODULES)) BWN_MODULES.woAuditNotes = true;
  function bwnApplyGov() {
    try {
      var g = JSON.parse(localStorage.getItem('bwn:gov') || 'null');
      if (!g || typeof g !== 'object' || !g.flags || typeof g.flags !== 'object') return;
      var f = g.flags, kill = f.globalKillSwitch === true;
      Object.keys(BWN_MODULES).forEach(function (k) {
        if (kill || f[k] === false) BWN_MODULES[k] = false;   // one-way: only ever disable
      });
    } catch (e) { /* corrupt bundle -> keep local defaults (safe) */ }
  }
  bwnApplyGov();
  try { document.addEventListener('bwn:gov', function () { bwnApplyGov(); }); } catch (e) { }
  var BWN_OPS = {
    addEditJobNote: { kind: 'write', perm: 'WorkOrderNote.AddNew', target: 'note', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Note posted.', fail: 'The note was not posted.' }
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

  // ===== BWN WO-AUDIT POST START (pure; sliced by scripts/test-wo-audit-post.js) ================
  // The note-posting helpers, mirroring bwn-low-gp's note plumbing. Kept pure (no DOM, no network)
  // so the node harness runs the shipped bytes: eligibility, the WorkOrderNoteInput shape, the
  // idempotency marker, and the marker embed. postAuditNote (below, outside this slice) is the one
  // impure piece - it calls bwnGqlOp.
  var ADD_NOTE_M = "mutation AddEditWONote($addEditInput: WorkOrderNoteInput!) { addEditJobNote(data: $addEditInput) { success message note { id type } } }";
  var AUDIT_MARKER = '[bwn:wo-audit]';
  // Note-type id resolved by NAME from Core's bwn:noteTypes cache, floored to the one type this
  // script posts. Mirrors low-gp's lgTypeId; never hardcode past the floor, never infer by position.
  var WOA_TYPE_FLOOR = { internal: 13 };
  function noteTypesRaw() { try { return localStorage.getItem('bwn:noteTypes'); } catch (e) { return null; } }
  function noteTypeId(name) {
    var want = String(name == null ? '' : name).toLowerCase();
    try {
      var c = JSON.parse(noteTypesRaw() || 'null');
      if (c && c.map) { for (var id in c.map) { if (String(c.map[id]).toLowerCase() === want) return parseInt(id, 10); } }
    } catch (e) { /* fall through to floor */ }
    return (typeof WOA_TYPE_FLOOR[want] === 'number') ? WOA_TYPE_FLOOR[want] : null;
  }
  // WorkOrderNoteInput - matches the captured AddEditWONote shape exactly (mirrors lgNoteInput).
  function noteInput(woNumber, typeId, content, contentHtml) {
    return {
      workOrderNumber: woNumber, type: typeId, content: String(content), contentHtml: contentHtml,
      isCompletion: false, isInvoice: false, isPinned: false, actionNoteEmails: null, targetPurchaseOrderNumbers: []
    };
  }
  // A single plain block -> one escaped <p>, newlines as <br>.
  function simpleHtml(text) {
    var s = String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<p>' + s.replace(/\n/g, '<br>') + '</p>';
  }
  // The posted note carries a hidden idempotency marker so a re-run can SEE its own prior note.
  function postBody(noteText) { return noteText + '\n\n' + AUDIT_MARKER; }
  // True if any of the WO's notes already carries this tool's marker (idempotency: do not double-post).
  function hasPriorAuditNote(notes) {
    if (!notes) return false;
    for (var i = 0; i < notes.length; i++) {
      var c = notes[i] && notes[i].content;
      if (c && String(c).indexOf(AUDIT_MARKER) !== -1) return true;
    }
    return false;
  }
  // Parse the workbook's days/aged cell to an integer age, or null when it is blank/non-numeric.
  function parseAgeDays(cell) {
    var n = parseInt(String(cell == null ? '' : cell).replace(/[^0-9.\-]/g, ''), 10);
    return isFinite(n) ? n : null;
  }
  // Post-eligible only when the job is aged STRICTLY over 30 days. When the workbook has no days
  // column (daysColAbsent), the export is over-30 by construction, so every row qualifies. Age
  // exactly 30 is NOT eligible.
  function postEligible(ageDays, daysColAbsent) {
    if (daysColAbsent) return true;
    return typeof ageDays === 'number' && isFinite(ageDays) && ageDays > 30;
  }
  // ===== BWN WO-AUDIT POST END ==================================================================

  // Post one drafted status note as an INTERNAL note on its WO, through the governed write path.
  // Impure (calls bwnGqlOp), so it sits OUTSIDE the sliced block above. ids carry the scalar WO
  // number only; the note text stays in variables, never the audit trail.
  function postAuditNote(woNumber, noteText) {
    var t = noteTypeId('internal');
    if (t == null) return Promise.reject(new Error('could not resolve the Internal note type'));
    var body = postBody(noteText);
    return bwnGqlOp('addEditJobNote', ADD_NOTE_M, { addEditInput: noteInput(woNumber, t, body, simpleHtml(body)) }, { feature: 'woAuditNotes', ids: { wo: woNumber } }).then(function (d) {
      var r = d && d.addEditJobNote;
      if (!r || r.success !== true) throw new Error((r && r.message) || 'addEditJobNote reported no success');
      return r.note;
    });
  }

  function woFetch(number) {
    // 0.13.0: strict normalization. The old reader stripped every non-digit, so a compound cell
    // resolved to a DIFFERENT real work order and the audit read the wrong job with no sign of it.
    var k = woaNormalizeKey(number);
    if (!k.n) return Promise.reject(new Error(k.reason || ('not a WO number: "' + number + '"')));
    var n = k.n;
    var headerP = gql(HEADER_Q, { n: n }).then(function (d) { return (d && d.workOrder) || null; }).catch(function () { return null; });
    var notesP = gql(NOTES_Q, { n: n }).then(function (d) { return (d && d.jobNotes) || []; });
    return Promise.all([headerP, notesP]).then(function (a) {
      var header = a[0];
      var notes = a[1].slice().sort(function (x, y) {
        return (_date(y && y.createdDate) || 0) - (_date(x && x.createdDate) || 0);
      }).map(function (x) {
        x = x || {};
        var who = x.createdBy ? [x.createdBy.firstName, x.createdBy.lastName].filter(Boolean).join(' ') : '';
        return {
          content: (x.content && String(x.content).trim()) || _stripHtml(x.contentHtml),
          createdDate: x.createdDate || '',
          type: x.type || '',
          isPinned: !!x.isPinned,
          by: who,
          source: x.workOrderNoteSource || '',
        };
      });
      return {
        id: n, header: header, statusName: (header && header.statusName) || '', notes: notes,
        matchConfidence: k.confidence, matchReason: k.reason
      };
    });
  }

  // ---- SWA summarize call (cross-origin -> GM_xmlhttpRequest + @connect) ----
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 60000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j, headers: r.responseHeaders || '' }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); },
        });
      } catch (e) { reject(e); }
    });
  }
  // ===== BWN AI TRANSPORT (Phase 3, TASK-011) =====================================
  // Batch summarize now rides the shared suite-wide bwnAI router and the single
  // /api/ai route (server Anthropic key; summarize tier is key-gated, no rank on the
  // server). The bwnAI block below is pasted BYTE-IDENTICAL from the suite (PAT-002) -
  // verify the SHA matches across scripts; do NOT edit its internals, only the injected
  // sender differs. summarize passes NO tools, so the sender is a single POST (no tool
  // loop, no registry).
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

  // ---- injected transport: constants + one-shot sender (TASK-011) --------------------
  var AI_URL = SWA_BASE + '/api/ai';

  // The old /api/wo-audit system prompt, replicated verbatim (hyphens only, no em-dash)
  // so the status-note style matches the retired route (output parity, TASK-011).
  // The model PHRASES facts the deterministic layer already established; it does not infer them.
  // Written to the same compact, dash-joined register the over-30 notes use, because that is the
  // style the audit's readers have actually been reading (108 of 108 notes in the 09/17 workbook).
  var WO_AUDIT_SYSTEM = [
    'You write one-line operational status notes for a facilities-maintenance work order audit.',
    'Your reader is an operations manager scanning a spreadsheet. They need to know, at a glance,',
    'where the job is, what is holding it, who owes the next move, and by when.',
    '',
    'You are given DERIVED FACTS (already established from the live work order) and NOTE EVIDENCE.',
    'You may use ONLY those. The derived facts outrank the notes wherever they disagree.',
    '',
    'Output format - a single compact line, segments joined by " - " (space hyphen space):',
    '<current stage> - <blocker and who owns it, only if one is given> - <M/D: latest meaningful',
    'event, only if one is given> - <next action and owner, only if a blocker exists> - ECD <date or TBD>',
    '',
    'Hard rules:',
    '- NEVER invent a date, ETA, approval, vendor commitment, site visit, completion, cause,',
    '  contact, or owner. If it is not in the derived facts or the note evidence, it does not exist.',
    '- Every date you write must appear verbatim in the supplied evidence. Do not compute or guess one.',
    '- The line MUST end with "ECD <M/D>" or "ECD TBD", exactly as the derived facts give it.',
    '- Always state the current stage. State a blocker and an owner ONLY if the facts name one;',
    '  if the job is progressing normally, say the stage and the next expected milestone instead.',
    '- Prefer the latest meaningful update. Keep an older dated milestone only when it explains why',
    '  the job sits where it does now.',
    '- Do not blame anyone. Name the condition and the role that owes the next step, never a person.',
    '- Banned as empty filler: "being handled", "working on it", "pending updates", "follow up",',
    '  "awaiting resolution". Name WHAT is pending and WHO must act, or say nothing.',
    '- If the evidence does not support a conclusion, say so plainly rather than filling the gap.',
    // 0.13.0: these mirror the claim gate the output is now checked against, so the model is told
    // the rule rather than merely failed by it. Each line corresponds to a WOA_CLAIM_RULES row.
    '- Do NOT say the work is complete, closed out or done unless the evidence states it outright.',
    '- Do NOT say anything was approved, signed off, quoted, priced, or that an NTE/DNE/PO exists,',
    '  unless the evidence says so.',
    '- Do NOT say a visit is scheduled or dispatched, a technician is on site, or a vendor is',
    '  assigned, unless the evidence says so.',
    '- Do NOT say the client was contacted, notified or updated unless the evidence says so.',
    '- Assign the next move only to the party the derived facts name. Coordinator is always',
    '  acceptable for an internal chase.',
    '- Never mention this tool, the audit process, a source system, a model, or a confidence level.',
    '',
    'Return ONLY the note line. No preamble, no labels, no quotes, no markdown, no bullet points.'
  ].join('\n');

  // Build the user turn: the DERIVED FACTS first (so the model phrases rather than infers), then
  // the live header facts, then the note evidence. The facts block is what makes the output
  // checkable - validateAiNote holds the model to the dates and the ECD token that appear here.
  function buildAuditInput(wo, notes, facts) {
    wo = wo || {};
    var top2 = (notes || []).slice(0, 5);
    var noteLines = top2.map(function (n, i) {
      n = (n && typeof n === 'object') ? n : {};
      var when = String(n.createdDate || '').trim().slice(0, 40);
      var type = String(n.type || '').trim().slice(0, 40);
      // Belt and braces with meaningfulNotes, which already sanitizes: the model must never be
      // shown pasted email headers, addresses or thread bodies, because it copies them into the
      // note and they then ground its dates. Stripping twice is a no-op.
      var txt = woaStripQuotedEmail(n.content).slice(0, 4000);
      var head = 'Note ' + (i + 1) + (when ? ' (' + when + ')' : '') + (type ? ' [' + type + ']' : '') + ':';
      return head + '\n' + (txt || '(empty)');
    });
    var loc = [String(wo.location || '').trim(), [String(wo.city || '').trim(), String(wo.state || '').trim()].filter(Boolean).join(', ')].filter(Boolean).join(' ');
    // Client-appropriate LIVE header facts only. GP / DNE / NTE / system flags are internal audit
    // signals (they land in the Audit Flags column) and are deliberately NOT fed to the client note.
    var lines = [
      'WO #: ' + (String(wo.raw || wo.number || '').trim() || '(unknown)'),
      'Status: ' + (String(wo.status || '').trim() || '(unknown)'),
      'Phase: ' + (String(wo.phase || '').trim() || '(unknown)'),
      'Priority: ' + (String(wo.priority || '').trim() || '(unknown)'),
      'Location: ' + (loc || '(unknown)'),
      'Days open: ' + (String(wo.days || '').trim() || '(unknown)'),
      'Assigned: ' + (String(wo.assignedTo || '').trim() || '(unknown)'),
      'Scheduled on-site: ' + (String(wo.schedule || '').trim() || '(none on file)')
    ];
    if (String(wo.overdue || '').trim()) lines.push('Overdue: ' + String(wo.overdue).trim());
    var f = facts || {};
    var factLines = [
      'DERIVED FACTS (authoritative - phrase these, do not re-infer them):',
      'Current stage: ' + (f.currentStage || '(unknown)'),
      'Blocker: ' + (f.primaryBlocker || '(none evidenced - the job is progressing)'),
      'Blocker owner: ' + (f.blockerOwner || 'Unknown'),
      'Next action: ' + (f.nextAction || '(none evidenced)'),
      'Next action owner: ' + (f.nextActionOwner || 'Unknown'),
      'ECD to print verbatim: ECD ' + (f.ecdText || 'TBD') + (f.ecdSource ? '  [source: ' + f.ecdSource + ']' : ''),
      'Confidence: ' + (f.confidence || 'low')
    ];
    if (f.confidence === 'low') factLines.push('NOTE: confidence is low - omit the blocker and the owner; state the stage, any dated event, and the ECD only.');
    lines.unshift(factLines.join('\n'), '');
    lines.push(
      '',
      'Note evidence (newest first):',
      noteLines.length ? noteLines.join('\n\n') : '(no notes provided)',
      '',
      'Write ONLY the single status line, ending in "ECD ' + (f.ecdText || 'TBD') + '".'
    );
    return lines.join('\n');
  }

  // ===== BWN WO-AUDIT TIMELINE START (pure; sliced by scripts/test-wo-audit-timeline.js) ==========
  // The over-30 note is a dated event CHAIN the model extracts from the job's full note history,
  // wrapped by these DETERMINISTIC pieces: the "Over 30 - <trade> -" prefix and the "- ECD <date>"
  // tail with a PAST flag. Trade, ECD and the past-flag are computed here, never by the model, so a
  // gap can never be filled with an invented date ([[worst-reading-of-a-gap-is-invention]]).

  // Format an Umbrava date to M/D. A bare YYYY-MM-DD is UTC midnight, so read the parts from the
  // STRING to avoid the local-timezone off-by-one (the dashboard date trap). '' when unparseable.
  function fmtMD(dateStr) {
    var s = String(dateStr == null ? '' : dateStr).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return parseInt(m[2], 10) + '/' + parseInt(m[3], 10);
    var d = new Date(s);
    return isNaN(+d) ? '' : ((d.getMonth() + 1) + '/' + d.getDate());
  }
  // {str, past} for the WO's expected completion date, or null when none is set. `past` is computed
  // against today's LOCAL date (midnight) from the same parts fmtMD shows, so display and flag agree.
  // nowMs is INJECTED so the harness asserts past/future on a fixed clock (headless cannot time).
  function ecdInfo(h, nowMs) {
    var raw = h && h.priority && h.priority.expectedCompletionDate;
    var str = fmtMD(raw);
    if (!str) return null;
    var now = (typeof nowMs === 'number') ? new Date(nowMs) : new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var d = null, m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw).trim());
    if (m) d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    else { var p = new Date(String(raw)); if (!isNaN(+p)) d = new Date(p.getFullYear(), p.getMonth(), p.getDate()); }
    return { str: str, past: !!(d && d < today) };
  }
  // The trade label from the header (first named trade), '' when none.
  function tradeLabel(h) {
    var t = h && h.trades;
    if (t && t.length) { for (var i = 0; i < t.length; i++) { var nm = t[i] && t[i].name; if (nm) return String(nm).trim(); } }
    return '';
  }
  // Wrap the model's event chain into the final over-30 note. The chain is the ONLY model-authored
  // part; the ends are deterministic. A past OR absent ECD both flag that a fresh ECD is owed - the
  // whole point of the over-30 report is to surface a job whose committed date has lapsed.
  function composeTimelineNote(chain, h, nowMs) {
    var trade = tradeLabel(h);
    var head = 'Over 30' + (trade ? ' - ' + trade : '');
    // defence: strip an "Over 30" the model echoed despite the instruction, then trim stray dashes.
    var body = String(chain == null ? '' : chain).trim()
      .replace(/^over\s*30\b[\s-]*/i, '').replace(/^[-\s]+|[-\s]+$/g, '');
    var ecd = ecdInfo(h, nowMs), tail;
    if (!ecd) tail = ' - ECD not set - needs ECD';
    else if (ecd.past) tail = ' - ECD ' + ecd.str + ' PAST - awaiting new ECD';
    else tail = ' - ECD ' + ecd.str;
    return head + (body ? ' - ' + body : '') + tail;
  }
  // ===== BWN WO-AUDIT TIMELINE END ================================================================

  // ===== BWN WO-AUDIT STATE START (pure; sliced by scripts/test-wo-audit-state.js) ================
  // The normalized operational-state layer: where the WO is, what is holding it, who owns the next
  // move, and by when - derived DETERMINISTICALLY from the live header + note history, with no AI,
  // no network and no DOM. It exists so the audit still says something true when the AI is down,
  // and so the model is asked to PHRASE grounded facts rather than to infer them.
  //
  // The stage is a TABLE LOOKUP on the live statusName, not a regex guess on note prose. The table
  // is Core's measured WO_PHASE map (the ~50-status Umbrava taxonomy behind the WO Assist playbook)
  // - COPIED, not imported, because GM sandboxes cannot share a runtime object across the @grant
  // boundary (same reason bwnFocusTrap is duplicated). Notes only REFINE a blocker the stage has
  // already established; a note can never invent a stage, an owner, or a date.
  //
  // nowMs is INJECTED, never Date.now() - the harness asserts ages/expiry on a fixed clock
  // ([[fixture-clock-time-day-age]] / [[headless-harness-cannot-time]]).

  // Status display name (lowercased) -> canonical phase. Copied from bwn-suite-core's WO_PHASE.
  var WOA_PHASE = {
    'new': 'intake', 'pending service request': 'schedule', 'pending dispatch': 'schedule',
    'pending schedule': 'schedule', 'recruiting vendor': 'schedule', 'vendor compliance': 'schedule',
    'vendor proposal required': 'proposal', 'vendor proposal received': 'proposal', 'supplier proposal pending': 'proposal',
    'preparing client proposal': 'proposal', 'pending proposal review': 'proposal', 'internal proposal rejected': 'proposal',
    'proposal rejected': 'proposal', 'pending trade specialist': 'proposal', 'atf prep': 'proposal', 'atf rejected': 'proposal',
    'proposed': 'proposal-sent', 'atf submitted': 'proposal-sent',
    'internal proposal approved': 'proposal-approved', 'proposal approved': 'proposal-approved', 'atf approved': 'proposal-approved',
    'need material': 'materials', 'material ordered': 'materials', 'pending materials supplier': 'materials',
    'awaiting supplier': 'materials', 'rma': 'materials', 'fabrication': 'materials', 'equipment rental': 'materials',
    'pending materials client': 'materials-client',
    'scheduled': 'scheduled', 'on the way': 'onsite', 'on-site': 'onsite',
    'clocked out: in progress': 'inprogress', 'awaiting 3rd party': 'inprogress',
    'client action required': 'client', 'on hold': 'onhold', 'pending acceptance': 'accept',
    'confirm complete': 'confirmcomplete', 'confirm reopen': 'recall', 'recall': 'recall',
    'clocked out: complete': 'costreview',
    'work complete': 'terminal', 'resolved': 'terminal', 'pending ability to bill': 'terminal',
    'invoice created': 'terminal', 'invoice rejected': 'terminal', 'invoiced': 'terminal',
    'invoice approved': 'terminal', 'paid': 'terminal', 'closed': 'terminal', 'canceled': 'terminal',
    'cancelled': 'terminal', 'declined': 'terminal', 'revoked': 'terminal', 'confirm cancel': 'terminal'
  };

  // Phase -> the operational reading. `blocker:null` means the phase is PROGRESSING NORMALLY: the
  // note then states the stage and the next expected milestone and asserts no blocker, rather than
  // manufacturing one to fill the slot.
  var WOA_STATE = {
    intake: { stage: 'Intake - not yet dispatched', owner: 'Coordinator', blocker: 'work order not yet dispatched to a vendor', next: 'Coordinator to dispatch this work order and record a vendor and on-site date' },
    schedule: { stage: 'Vendor scheduling pending', owner: 'Vendor', blocker: 'no confirmed on-site date on file', next: 'Vendor to confirm an on-site date and technician' },
    accept: { stage: 'Awaiting vendor acceptance', owner: 'Vendor', blocker: 'vendor has not accepted the assignment', next: 'Vendor to accept or decline so coverage can be confirmed or reassigned' },
    proposal: { stage: 'Quote/proposal in preparation', owner: 'Coordinator', blocker: 'vendor quote not yet converted into a client proposal', next: 'Coordinator to obtain the vendor quote and submit the client proposal' },
    'proposal-sent': { stage: 'Awaiting client approval', owner: 'Client', blocker: 'submitted proposal not yet approved', next: 'Client to approve the submitted proposal so work can be scheduled' },
    'proposal-approved': { stage: 'Approved - awaiting PO release', owner: 'PO/Approval', blocker: 'proposal approved but the vendor purchase order has not been released', next: 'Coordinator to issue the purchase order and release the vendor' },
    materials: { stage: 'Materials pending', owner: 'Materials', blocker: 'parts/materials not yet delivered', next: 'Vendor to confirm the delivery date and schedule the return visit on receipt' },
    'materials-client': { stage: 'Materials pending - client supplied', owner: 'Client', blocker: 'client-supplied materials not yet delivered', next: 'Client to confirm the delivery date for the client-supplied materials' },
    scheduled: { stage: 'Scheduled', owner: 'Vendor', blocker: null, next: 'Vendor to attend the scheduled visit and report the outcome' },
    onsite: { stage: 'Technician on site', owner: 'Vendor', blocker: null, next: 'Vendor to report completion or the remaining scope at end of visit' },
    inprogress: { stage: 'Service in progress', owner: 'Vendor', blocker: null, next: 'Vendor to report completion or the remaining scope' },
    client: { stage: 'Awaiting client response', owner: 'Client', blocker: 'client response outstanding', next: 'Client to provide the outstanding direction on this work order' },
    onhold: { stage: 'On hold', owner: 'Coordinator', blocker: 'work order on hold', next: 'Coordinator to review the hold and either release it or record the blocking condition' },
    confirmcomplete: { stage: 'Work complete - closeout pending', owner: 'Coordinator', blocker: 'completion documentation outstanding', next: 'Coordinator to obtain the completion documentation and close the work order' },
    costreview: { stage: 'Work complete - final cost review pending', owner: 'Coordinator', blocker: 'final vendor cost not yet confirmed on the purchase order', next: 'Coordinator to confirm the final vendor cost and advance the work order' },
    recall: { stage: 'Recalled - return visit required', owner: 'Vendor', blocker: 'return visit not yet scheduled', next: 'Vendor to confirm the return-visit date and the corrective scope' },
    terminal: { stage: 'Closed', owner: 'Unknown', blocker: null, next: null }
  };

  // Clause-scoped, negation-vetoed matching. Copied from Core's ACT_NEG/actClauses/actAffirm - the
  // measured polarity guard, so "no parts ordered" / "haven't heard back" never read as positives.
  // Over-vetoing is the safe direction: a missed refinement costs detail, a false one costs truth.
  var WOA_NEG = /\b(no|nothing|none|not|never|without|cannot|can'?t|couldn'?t|won'?t|wouldn'?t|didn'?t|doesn'?t|don'?t|haven'?t|hasn'?t|hadn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|shouldn'?t|unable)\b/i;
  function woaClauses(b) { return String(b || '').split(/[.!?;\n•]+/); }
  function woaAffirm(b, posRe) {
    var cl = woaClauses(b);
    for (var i = 0; i < cl.length; i++) { if (posRe.test(cl[i]) && !WOA_NEG.test(cl[i])) return true; }
    return false;
  }

  // Blocker refinements. Each may only SHARPEN the wording of a blocker the phase already set - it
  // never creates one where the phase said the job is progressing, and never changes the owner
  // except where the evidence names a different party outright.
  var WOA_BACKORDER = /\bback[- ]?order(ed)?\b/i;
  var WOA_LEADTIME = /\blead[- ]?time\b|\bfabricat(ing|ion)\b/i;
  var WOA_INTRANSIT = /\b(ship(ped|ping)|in transit|tracking\s*(#|number|no))\b/i;
  // Access is the one signal the negation veto must NOT guard: the phrases are themselves negative
  // ("could not get access", "denied access"), so running them through WOA_NEG vetoes every real
  // match. The pattern is therefore tightened to encode the failure directly, and matched raw -
  // which is why "no access ISSUES" (the healthy case) is excluded by requiring an object after
  // "no access to".
  // ONLY phrases that encode a FAILURE to get in. Bare nouns were removed after they inverted the
  // truth on ordinary notes: "badge reader repair" is an access-control TRADE, "site contact is Bob"
  // and "access window confirmed for Monday" are the job going RIGHT. Five of nine realistic notes
  // read as an access blocker before this was tightened.
  var WOA_ACCESS = /\b(could not (get |gain )?(access|in)\b|unable to (get |gain )?access\b|denied access\b|no access to the \w+|site (was )?(closed|locked)\b|locked out\b|turned away\b|could not enter\b|no one (on ?site|to let)\b)/i;
  var WOA_NTE = /\b((requested|submitted)\s+(a |an |the )?(dne|nte|change[- ]?order|increase)|(dne|nte|change[- ]?order)\s+(submitted|requested|sent|approved)|revised\s+(costs?|nte|dne|pricing)|price increase\s+(requested|submitted))\b/i;

  // Quoted-email furniture. A coordinator's job note is very often a pasted email reply, and
  // everything from the quote boundary on is header and thread, not event. Measured on the 09/18
  // workbook (282 shipped notes): 64 carried this furniture and 32 carried live email addresses -
  // 28 distinct, including client contacts, vendor addresses, internal @broadwaynational.com
  // addresses and app@umbrava.com - all of which shipped in a client-facing column. The paste also
  // ate a median 62% of the note.
  //
  // The boundary set is deliberately narrow. `From:` and friends are matched CASE-SENSITIVELY and
  // only with the colon, so ordinary prose ("awaiting update from vendor", "findings from the
  // technician", and the measured "Email attempted to be sent: -Type: ...") is never a boundary,
  // while the real headers - which are always capitalized, and sometimes prefixed with a dash as
  // "-From:" - always are. "Original Message" must appear in words: a run of hyphens alone is not a
  // marker. This is NOT a general PII redactor; it removes pasted email furniture and addresses,
  // nothing else.
  var WOA_QUOTE_RE = /-{2,}\s*Original Message|(?:^|[\s>\-])(?:From|Sent|To|Subject|Cc|Bcc):\s/;
  var WOA_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  function woaStripQuotedEmail(text) {
    var s = String(text == null ? '' : text);
    var m = WOA_QUOTE_RE.exec(s);
    if (m) s = s.slice(0, m.index);          // keep the real content BEFORE the quote boundary
    // Addresses are REMOVED, not marked: a "[email]" token in a client-facing note is still noise,
    // and the reader loses nothing by its absence. Bracketed forms go first so "<a@b.com>" does not
    // leave an empty pair behind.
    s = s.replace(/[<(\[]\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*[>)\]]/g, ' ')
      .replace(WOA_EMAIL_RE, ' ');
    // Tidy only what the removal can leave behind - empty brackets, doubled separators, dangling
    // dashes and edge punctuation. Sentence-ending periods are deliberately untouched.
    return s.replace(/[<(\[]\s*[>)\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,;:.])/g, '$1')
      // Only comma/semicolon runs are collapsed - those are what a removed address list leaves
      // ("Contact: a@b, c@d" -> "Contact: ,"). Colons and dashes are NOT touched: they are load
      // bearing in real notes, and collapsing them turned the measured "sent: -Type: Purchase
      // Order" into "sent-Type: Purchase Order".
      .replace(/([,;])\s*(?=[,;])/g, '')
      .replace(/^[\s,;:\-]+/, '')
      .replace(/[\s,;:\-]+$/, '')
      .trim();
  }

  // A note that carries operational meaning. Excludes anything bearing a [bwn:*] marker - this
  // tool's OWN prior posts most of all: reading yesterday's draft back as today's evidence would
  // launder a guess into a fact. hasPriorAuditNote still sees them, so idempotency is untouched.
  var WOA_MARKER_RE = /\[bwn:[^\]]+\]/;
  function meaningfulNotes(notes, nowMs) {
    var out = [];
    for (var i = 0; i < (notes || []).length; i++) {
      var n = notes[i] || {};
      var raw = String(n.content == null ? '' : n.content).trim();
      // ORDER MATTERS. The [bwn:*] marker is tested on the RAW body first: the marker sits at the
      // END of a posted note, so sanitizing first could cut it off and this tool would stop
      // recognizing its own post as ineligible evidence - reopening the self-laundering hole.
      if (WOA_MARKER_RE.test(raw)) continue;
      // Then strip pasted email furniture, and only then judge whether anything operational is
      // left. A note that was ONLY a forwarded thread now correctly reads as no usable evidence
      // rather than shipping its headers into a client-facing cell.
      var body = woaStripQuotedEmail(raw);
      if (body.length < 12) continue;
      var d = _date(n.createdDate);
      // A note dated after the audit clock cannot be evidence of something that has happened.
      if (d && typeof nowMs === 'number' && (+d) > nowMs) continue;
      // `type` is carried through because the AI prompts are now built from THIS filtered list
      // (0.13.0) rather than the raw history, and the note type was part of what they showed.
      out.push({ content: body, createdDate: n.createdDate || '', date: d, by: n.by || '', type: n.type || '', isCompletion: !!n.isCompletion });
    }
    return out;
  }

  // Completion-commitment vocabulary + date shapes, copied from Core (ECD_NOTE_WORDS / CFG.DATE_RE).
  // Deliberately NOT bare "complete": "work completed 7/15" is a past record, not a promise.
  var WOA_ECD_WORDS = /\becd\b|\bcomplet(?:e|ed|ion)\s+(?:by|date)\b|\bfinish(?:ed)?\s+by\b|\bdone\s+by\b/i;
  var WOA_DATE_RE = /\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/;
  // A bare hyphenated pair is a RANGE, not a date. Copied from Core's ecdDropHyphenRanges, which
  // exists because a note containing "1-5" once produced a 2027-01-05 ECD proposal on W-386564.
  function woaDropHyphenRanges(body) {
    return String(body == null ? '' : body).replace(/\d{1,2}-\d{1,2}/g, function (m, off, s) {
      var before = off > 0 ? s.charAt(off - 1) : '';
      var after = s.charAt(off + m.length);
      if (/[\d-]/.test(before) || /[-\d]/.test(after)) return m;
      return ' ';
    });
  }
  // Every M/D-shaped token in a text, normalized to "M/D" - the grounding set for date validation.
  function woaDateTokens(text) {
    var out = [], re = /\b(\d{1,2})[\/](\d{1,2})(?:[\/]\d{2,4})?\b/g, m;
    while ((m = re.exec(String(text || '')))) {
      var t = parseInt(m[1], 10) + '/' + parseInt(m[2], 10);
      if (out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  // The normalized fact set. Never throws, never returns null, always carries at least one evidence
  // row - including for the "we could not read it" cases, because unread is not empty.
  function deriveState(h, notes, nowMs) {
    var ev = [];
    var mn = meaningfulNotes(notes, nowMs);
    var statusName = String((h && h.statusName) || '').trim();
    var phase = WOA_PHASE[statusName.toLowerCase()] || null;
    var base = phase ? WOA_STATE[phase] : null;

    var f = {
      currentStage: 'Status unclear', primaryBlocker: null, blockerOwner: 'Unknown',
      latestMeaningfulEvent: null, latestMeaningfulEventDate: null,
      nextAction: null, nextActionOwner: 'Unknown',
      ecd: null, ecdText: 'TBD', ecdSource: 'none', ecdExpired: false,
      confidence: 'low', evidence: ev, phase: phase, terminal: phase === 'terminal',
      // A blocker read straight off a header FIELD is certain even when the overall picture is not
      // (e.g. "no vendor assigned" with zero notes). The confidence gate exists to suppress blockers
      // INFERRED from note prose, so it must not swallow a fact the work order states outright.
      blockerCertain: false,
      noteCount: mn.length, staleDays: null
    };

    if (!h) {
      // Client-neutral wording on purpose. This clause can reach the workbook's Notes column (a
      // header miss with usable notes still composes a note), and "re-run the audit once the
      // header read succeeds" names this tool's own internals to a reader who has never heard of
      // it. State the gap and the action; the mechanism stays in the row result and the log.
      f.currentStage = 'Current status unavailable';
      f.nextAction = 'Coordinator to confirm the current work order status and record it on the work order';
      f.nextActionOwner = 'Coordinator';
      ev.push({ kind: 'absence', field: 'workOrder', date: null, value: 'header read failed' });
      return f;
    }
    ev.push({ kind: 'header', field: 'statusName', date: null, value: statusName || '(blank)' });

    if (base) {
      f.currentStage = base.stage;
      f.primaryBlocker = base.blocker;
      f.blockerOwner = base.blocker ? base.owner : 'Unknown';
      f.nextAction = base.next;
      f.nextActionOwner = base.next ? base.owner : 'Unknown';
      f.confidence = 'high';
    } else {
      // Unmapped/custom status: say it verbatim rather than guessing a stage from it.
      f.currentStage = statusName ? ('Status "' + statusName + '"') : 'Status not available';
      f.confidence = 'low';
    }

    // --- refinements that the header alone licenses -------------------------------------------
    var hasVendor = (typeof h.hasNonTerminatedPurchaseOrders === 'boolean')
      ? h.hasNonTerminatedPurchaseOrders
      : !!(h.purchaseOrders && h.purchaseOrders.length);
    // No vendor holds the job -> the gap is an INTERNAL dispatch gap. It is never the vendor's:
    // there is no vendor to own it. (Anti-rule: NO VENDOR must not read as "vendor at fault".)
    if (phase === 'schedule' && !hasVendor) {
      f.primaryBlocker = 'no vendor assigned yet';
      f.blockerOwner = 'Coordinator';
      f.nextAction = 'Coordinator to assign a vendor and record a confirmed on-site date';
      f.nextActionOwner = 'Coordinator';
      f.blockerCertain = true;   // the header states it outright; no note is needed to support it
      ev.push({ kind: 'header', field: 'hasNonTerminatedPurchaseOrders', date: null, value: 'false' });
    }
    if (phase === 'scheduled' && h.nextOnsiteDate) {
      var od = fmtMD(h.nextOnsiteDate);
      if (od) {
        f.nextAction = 'Vendor to attend the visit scheduled ' + od + ' and report the outcome';
        ev.push({ kind: 'header', field: 'nextOnsiteDate', date: null, value: od });
      }
    }

    // --- refinements the NOTES license --------------------------------------------------------
    var newest = mn.length ? mn[0] : null;
    if (newest) {
      // The event clause quotes a note body verbatim, and the fallback path writes it straight into
      // the downloaded workbook. buildAuditInput deliberately withholds GP/DNE/NTE from the note as
      // internal-only signals, so the deterministic path must not reintroduce them through the back
      // door - a note reading "vendor quoted $4,200, our GP is thin" would otherwise ship as-is.
      f.latestMeaningfulEvent = newest.content.replace(/\s+/g, ' ')
        .replace(/\$\s?[\d,]+(\.\d{2})?/g, '[amount]')
        .replace(/\b(gross profit|GP)\b[^.;]*/gi, '[margin detail removed]')
        .slice(0, 160);
      f.latestMeaningfulEventDate = newest.createdDate || null;
      ev.push({ kind: 'note', field: 'jobNotes', date: fmtMD(newest.createdDate) || null, value: f.latestMeaningfulEvent });
      if (newest.date) {
        var age = Math.floor((nowMs - (+newest.date)) / MS_DAY);
        f.staleDays = age;
        if (age > auditCfg('staleDays', STALE_DAYS)) {
          // Staleness is a fact about the NOTES, never about a party: it may not assign BLAME and
          // may not invent a blocker - it only lowers confidence and states the gap.
          f.confidence = (f.confidence === 'high') ? 'medium' : 'low';
          // It does, however, replace the next action. A stage action is forward-looking ("attend
          // the visit scheduled 8/20") and on a job with no update in weeks that date has usually
          // already passed - shipping it would tell the reader to wait on something that is not
          // happening. The honest move is to go find out. Chasing a status is an INTERNAL action,
          // so naming Coordinator here assigns work, not fault.
          f.nextAction = 'Coordinator to obtain a current status from the assigned party and record it on the work order';
          f.nextActionOwner = 'Coordinator';
        }
      }
      var body = newest.content;
      if (phase === 'materials') {
        if (woaAffirm(body, WOA_BACKORDER)) f.primaryBlocker = 'parts on backorder';
        else if (woaAffirm(body, WOA_INTRANSIT)) f.primaryBlocker = 'parts in transit, not yet delivered';
        else if (woaAffirm(body, WOA_LEADTIME)) f.primaryBlocker = 'parts still in fabrication/lead time';
      }
      if (phase === 'onhold' && woaAffirm(body, WOA_NTE)) {
        f.primaryBlocker = 'NTE/change-order increase awaiting approval';
        f.blockerOwner = 'PO/Approval';
        f.nextAction = 'Approval of the NTE increase required before further work is authorized';
        f.nextActionOwner = 'PO/Approval';
      }
      // Access is the one dependency with NO header field behind it, so it may only ever refine
      // the wording of an existing scheduling blocker - never become a stage of its own, and never
      // reassign ownership to the client. The vocabulary is unvalidated against a note corpus.
      if ((phase === 'schedule' || phase === 'scheduled') && WOA_ACCESS.test(body)) {
        f.primaryBlocker = 'site access/appointment window not confirmed';
        f.blockerOwner = 'Scheduling/Access';
        f.nextAction = 'Site access window and site contact to be confirmed before the visit is rebooked';
        f.nextActionOwner = 'Scheduling/Access';
      }
    } else {
      ev.push({ kind: 'absence', field: 'jobNotes', date: null, value: (notes && notes.length) ? 'no meaningful notes (all filtered as short/auto/prior-audit)' : 'no notes on file' });
      f.confidence = 'low';
      if (!base) {
        f.nextAction = 'Coordinator to record a current status note stating the blocker, owner and expected completion date';
        f.nextActionOwner = 'Coordinator';
      }
    }

    // --- ECD ----------------------------------------------------------------------------------
    // Only two sources may ever produce one: the WO's own expected-completion field, and a note
    // clause that explicitly commits to a COMPLETION date. An arrival/delivery/appointment date is
    // never an ECD - promising completion off a parts-delivery date is the invention this guards.
    // There is deliberately no calendar default: Core's "second Friday" exists for a human-confirmed
    // picker, and an unattended audit note must not manufacture a commitment.
    var ei = ecdInfo(h, nowMs);
    if (ei && !ei.past) {
      f.ecd = String(h.priority.expectedCompletionDate); f.ecdText = ei.str; f.ecdSource = 'wo.expectedCompletionDate';
      ev.push({ kind: 'header', field: 'priority.expectedCompletionDate', date: ei.str, value: ei.str });
    } else if (ei && ei.past) {
      f.ecdExpired = true; f.ecdText = 'TBD'; f.ecdSource = 'wo.expectedCompletionDate.expired';
      ev.push({ kind: 'header', field: 'priority.expectedCompletionDate', date: ei.str, value: ei.str + ' (lapsed)' });
    } else {
      // Latest-WRITTEN commitment wins, not furthest-future: one stale over-promise from months ago
      // must not outrank today's revision.
      for (var i = 0; i < mn.length; i++) {
        var stripped = woaDropHyphenRanges(mn[i].content);
        if (!woaAffirm(mn[i].content, WOA_ECD_WORDS)) continue;
        if (!WOA_DATE_RE.test(stripped)) continue;
        var toks = woaDateTokens(stripped);
        if (!toks.length) continue;
        f.ecdText = toks[toks.length - 1]; f.ecdSource = 'note.vendorCommitment';
        f.confidence = (f.confidence === 'high') ? 'medium' : f.confidence;
        ev.push({ kind: 'note', field: 'jobNotes', date: fmtMD(mn[i].createdDate) || null, value: 'completion commitment: ' + mn[i].content.slice(0, 100) });
        break;
      }
    }
    if (f.ecdExpired) {
      // The lapse is stated as a fact plus the action it owes, BEFORE the ECD token, so the note
      // still ends on "ECD TBD" while losing none of what the over-30 tail has always conveyed.
      // Fold into the existing action rather than chaining a second "Coordinator to ..." sentence:
      // an audit line is scanned, not read, and two actors in one clause is what makes it unreadable.
      if (f.nextAction && f.nextActionOwner === 'Coordinator') {
        f.nextAction = f.nextAction + ' and reset the ECD (prior ECD ' + ei.str + ' lapsed)';
      } else if (f.nextAction) {
        f.nextAction = f.nextAction + '; prior ECD ' + ei.str + ' lapsed, Coordinator to reset it';
      } else {
        f.nextAction = 'prior ECD ' + ei.str + ' lapsed; Coordinator to reset the expected completion date';
        f.nextActionOwner = 'Coordinator';
      }
    }
    // Belt and braces: no path may leave a renderable ECD as undefined/null/empty/Invalid Date.
    if (!f.ecdText || !/^(\d{1,2}\/\d{1,2}|TBD)$/.test(f.ecdText)) { f.ecdText = 'TBD'; f.ecdSource = 'none'; }
    return f;
  }

  // Deterministic audit note. Every clause is omitted rather than invented when unsupported; the
  // stage and the ECD tail are the only two that always render, and the ECD is always last.
  function composeAuditStatusNote(f) {
    f = f || {};
    var parts = [];
    parts.push(String(f.currentStage || 'Status unclear'));
    // Low confidence SHORTENS the note - it never softens the wording. A blocker and an owner we
    // cannot stand behind are dropped, not hedged.
    if (f.primaryBlocker && (f.confidence !== 'low' || f.blockerCertain)) {
      parts.push(f.primaryBlocker + (f.blockerOwner && f.blockerOwner !== 'Unknown' ? ' (' + f.blockerOwner + ')' : ''));
    }
    if (f.latestMeaningfulEvent && f.latestMeaningfulEventDate) {
      var d = fmtMD(f.latestMeaningfulEventDate);
      if (d) parts.push(d + ': ' + f.latestMeaningfulEvent.slice(0, 120));
    } else if (!f.noteCount) {
      parts.push(f.latestMeaningfulEventDate ? ('no documented update since ' + fmtMD(f.latestMeaningfulEventDate)) : 'no documented update available');
    }
    var next = f.nextAction;   // local: the formatter must not mutate the facts it was handed
    if (typeof f.staleDays === 'number' && f.staleDays > auditCfg('staleDays', STALE_DAYS)) {
      parts.push('no meaningful update in ' + f.staleDays + 'd');
      if (!next) next = 'Coordinator to obtain a current status from the assigned party and record it on the work order';
    }
    if (!next && !f.terminal) next = 'Coordinator to obtain a current status from the assigned party and record it on the work order';
    if (next) parts.push(next);
    return parts.join(' - ') + ' - ECD ' + (f.ecdText || 'TBD');
  }

  // Accept the model's phrasing only when it is grounded. Returns '' when usable, else the reason
  // the caller records as the row's degradation cause. The date check is the real hallucination
  // gate: any M/D the model prints that appears in neither the note history nor the header is an
  // invented commitment, and that is exactly the failure this overhaul exists to stop.
  var WOA_VAGUE = /\b(being handled|working on it|pending updates?|awaiting resolution|will (provide|keep you)|in progress as needed|as soon as possible|monitoring (this|it)( closely)?|no update available)\b/i;
  // Shared date gate, used by BOTH generated paths - the standard note and the over-30 chain that
  // actually gets posted. Returns '' when every date in `text` appears in the evidence.
  // 0.13.0: both sides now go through woaGroundTokens, not woaDateTokens. The old slash-only reader
  // saw nothing in "ECD 2026-11-30", "by 11-30" or "by Nov 30", so three whole date FORMATS walked
  // past the one gate that exists to catch an invented commitment. Widening it here cannot invent a
  // date - the evidence set widens by exactly the same rule.
  function ungroundedDates(text, groundText) {
    var allowed = woaGroundTokens(String(groundText || ''));
    var used = woaGroundTokens(String(text || ''));
    for (var i = 0; i < used.length; i++) {
      if (allowed.indexOf(used[i]) === -1) return 'AI output cited a date (' + used[i] + ') not present in the work order evidence';
    }
    return '';
  }
  // A deterministic stand-in for the model's event chain, so an over-30 row that loses the AI still
  // ships in the house "Over 30 - <trade> - ... - ECD ..." format rather than a fourth note shape.
  function fallbackChain(f) {
    f = f || {};
    var seg = [];
    if (f.latestMeaningfulEventDate && f.latestMeaningfulEvent) {
      var d = fmtMD(f.latestMeaningfulEventDate);
      seg.push((d ? d + ' ' : '') + f.latestMeaningfulEvent.slice(0, 120));
    }
    seg.push(f.currentStage || 'status unclear');
    if (f.primaryBlocker && (f.confidence !== 'low' || f.blockerCertain)) {
      seg.push(f.primaryBlocker + (f.blockerOwner && f.blockerOwner !== 'Unknown' ? ' (' + f.blockerOwner + ')' : ''));
    }
    if (f.nextAction) seg.push(f.nextAction);
    return seg.join(' - ');
  }
  function validateAiNote(note, f, groundText) {
    var s = String(note == null ? '' : note).trim();
    if (!s) return 'empty AI note';
    if (s.length < 25) return 'AI note too short to be a status';
    var m = / - ECD (\d{1,2}\/\d{1,2}|TBD)$/.exec(s);
    if (!m) return 'AI note did not end with the required ECD clause';
    // The ECD must be the DERIVED one, not merely a date that appears somewhere in the evidence.
    // Without this the model could lift a parts-delivery or appointment date out of a note body and
    // print it as a completion commitment - it would pass the generic date check below, because the
    // date really is in the evidence, while still promising something nobody committed to.
    var want = (f && f.ecdText) ? f.ecdText : 'TBD';
    if (m[1] !== want) return 'AI note printed an ECD (' + m[1] + ') the derived facts did not supply (expected ' + want + ')';
    if (WOA_VAGUE.test(s)) return 'AI note used vague filler wording';
    var claim = woaClaimIssue(s, f, String(groundText || ''));
    if (claim) return 'AI note ' + claim;
    // The derived ECD is grounded BY DEFINITION - it came from the header field or an evidenced
    // completion commitment - so it is always allowed, even if the caller passes a thin groundText.
    return ungroundedDates(s, String(groundText || '') + ' ' + want);
  }

  // ---------------------------------------------------------------------------------------------
  // 0.13.0: grounding tokens, the claim gate, key normalization and status coverage. All pure, all
  // inside this slice, so scripts/test-wo-audit-evidence.js runs the shipped bytes.
  // ---------------------------------------------------------------------------------------------

  // The GROUNDING tokenizer, deliberately separate from woaDateTokens above. woaDateTokens feeds
  // ECD DERIVATION, and widening THAT would start lifting ISO/month-name strings out of note prose
  // as completion commitments - the invention the no-ECD rule exists to stop. This one only ever
  // compares an AI line against the evidence it was given, and it is applied to BOTH sides, so it
  // cannot invent a date: it can only refuse one the evidence does not carry. Everything normalizes
  // to the same "M/D" family, so "2026-09-30", "9/30" and "Sept 30" are one token. A BARE hyphen
  // pair is excluded - see the note on the hyphen pass below; it is a range in real audit notes,
  // never a date, and reading it as one would hand out false grounding licences.
  var WOA_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function woaGroundTokens(text) {
    var s = String(text || ''), out = [], m;
    function add(mo, da) {
      mo = parseInt(mo, 10); da = parseInt(da, 10);
      if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return;
      var t = mo + '/' + da;
      if (out.indexOf(t) === -1) out.push(t);
    }
    // ISO first, then REMOVE it, so its inner "09-30" is not re-read as a bare hyphen date and a
    // 4-digit year cannot leak into the hyphen pass.
    var iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
    while ((m = iso.exec(s))) add(m[2], m[3]);
    var rest = s.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ');
    var slash = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
    while ((m = slash.exec(rest))) add(m[1], m[2]);
    // A BARE hyphen pair is deliberately NOT a date token. Measured against the 09/18 workbook
    // (282 shipped notes): 26 carried a date-shaped bare pair and not one of them was a date. They
    // were the spillover between two slash dates ("5/4-5/5" -> "4-5", already tokenized correctly
    // by the slash pass) or a quantity/lead-time range ("3-4 months", "4-6 weeks"). Tokenizing them
    // would have let "4-6 weeks" in the evidence GROUND an invented "4/6" in the output - a false
    // licence, which is the dangerous direction. The bypass this was meant to close is shut
    // anyway: validateAiNote's tail rule only accepts "ECD <M>/<D>" or "ECD TBD", so an "ECD 9-30"
    // is rejected before any grounding check runs.
    // Month names must be real month spellings. A permissive /(dec)[a-z]*\s+\d/ read "declined 4"
    // and "decline 8" as December dates in that same workbook - phantom tokens that could ground an
    // invented 12/4.
    var mon = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/gi;
    while ((m = mon.exec(rest))) add(WOA_MONTHS[m[1].toLowerCase().slice(0, 4) === 'sept' ? 'sept' : m[1].toLowerCase().slice(0, 3)], m[2]);
    return out;
  }

  // Clause splitter for the claim gate. woaClauses above splits note PROSE on sentence punctuation,
  // which is right for a note body and wrong for an audit LINE: the house format joins its segments
  // with " - " and carries no full stops, so the whole line reads as one clause and a single "not"
  // anywhere in it would veto every claim check on the line. This splitter adds the " - " separator
  // so each segment is judged on its own polarity. Returns the MATCH (the owner rule needs the
  // captured party), or null when no un-negated clause carries the pattern.
  function woaClaimMatch(text, re) {
    var cl = String(text || '').split(/[.!?;\n•]|\s+-\s+/);
    for (var i = 0; i < cl.length; i++) {
      if (WOA_NEG.test(cl[i])) continue;
      var m = re.exec(cl[i]);
      if (m) return m;
    }
    return null;
  }
  function woaEvidenceHas(ev, re) { return !!woaClaimMatch(ev, re); }

  // The claim gate. Each row is {id, claim, allow, reason, literal}: `claim` is what the LINE
  // asserts, `allow` is what the EVIDENCE (the note history the model was handed, PLUS the derived
  // facts) must show for that assertion to be legitimate. Claim and evidence are BOTH matched
  // clause-scoped and negation-vetoed, so "not yet approved" is neither a claim nor a licence.
  // `literal: true` opts a row out of the veto, for rows whose text is inherently negative or where
  // a negation does not redeem it ("there is no AI here" is still internal wording).
  // Table-driven so a newly observed phrasing is one row, not a new branch.
  var WOA_CLAIM_RULES = [
    {
      id: 'completion',
      claim: /\b(work (is |was )?complete\b|job (is |was )?(done|complete)\b|installation (is |was )?complete\b|repair (is |was )?complete\b|completed on ?site|closed out\b|has been completed\b|was completed\b)/i,
      allow: function (f, ev) {
        return ['confirmcomplete', 'costreview', 'terminal'].indexOf(f.phase) !== -1 ||
          woaEvidenceHas(ev, /\b(completed|work complete|closed out)\b/i);
      },
      reason: 'claimed the work is complete with no completion evidence'
    },
    {
      id: 'approval',
      claim: /\b(approved\b|approval (was )?(received|granted|given)\b|sign(ed)?[- ]off\b)/i,
      allow: function (f, ev) {
        return ['proposal-approved', 'terminal'].indexOf(f.phase) !== -1 ||
          woaEvidenceHas(ev, /\b(approved|approval (was )?(received|granted|given)|sign(ed)?[- ]off)\b/i);
      },
      reason: 'claimed an approval with no approval evidence'
    },
    {
      id: 'financial',
      claim: /\b(nte\b|dne\b|purchase order\b|\bpo\b|quoted?\b|pricing\b|priced\b|cost(s)?\b|estimate[ds]?\b|change[- ]order\b|\$\s?\d)/i,
      allow: function (f, ev) {
        return woaEvidenceHas(ev, /\b(nte|dne|purchase order|\bpo\b|quoted?|pricing|priced|cost(s)?|estimate[ds]?|change[- ]order|\$\s?\d)/i);
      },
      reason: 'cited pricing/PO/NTE detail with no matching evidence'
    },
    {
      id: 'operational',
      // ASSERTIVE forms only. A directive is not a claim: "Vendor to confirm an on-site date" is
      // the deterministic next action, and matching it here would have the gate reject the very
      // fallback note it exists to protect. "technician is on-site now" is a claim; "so work can be
      // scheduled" is not.
      claim: /\b((is|was|has been) (scheduled|dispatched|on[- ]?site|assigned)|visit (is |was )?(booked|scheduled)|scheduled (for|on)\b|dispatched\b|crew (arrived|dispatched)|tech(nician)? (is |was )?(on[- ]?site|assigned)|vendor (is |was |has been )?assigned|attended\b|on[- ]?site now)/i,
      allow: function (f, ev) {
        return ['scheduled', 'onsite', 'inprogress'].indexOf(f.phase) !== -1 ||
          woaEvidenceHas(ev, /\b((is|was|has been) (scheduled|dispatched|on[- ]?site|assigned)|visit (is |was )?(booked|scheduled)|scheduled (for|on)\b|dispatched\b|crew (arrived|dispatched)|tech(nician)? (is |was )?(on[- ]?site|assigned)|vendor (is |was |has been )?assigned|attended\b|on[- ]?site now)/i);
      },
      reason: 'claimed scheduling/dispatch/on-site activity with no supporting evidence'
    },
    {
      id: 'client-contact',
      claim: /\b(contacted the client\b|client (was |has been )?(notified|advised|updated|contacted|informed)\b|spoke (with|to) the client\b|emailed the client\b|called the client\b)/i,
      allow: function (f, ev) {
        return woaEvidenceHas(ev, /\b(contacted (the )?client|client (was |has been )?(notified|advised|updated|contacted|informed)|spoke (with|to) (the )?client|emailed (the )?client|called (the )?client)\b/i);
      },
      reason: 'claimed client contact with no evidence of it'
    },
    {
      id: 'blame',
      claim: /\b(unresponsive\b|failed to (respond|show|deliver|attend)\b|no[- ]show\b|at fault\b|negligen\w*|dropped the ball\b|ignored\b|neglected\b)/i,
      allow: function (f, ev) {
        // Matched RAW on both sides. This vocabulary is inherently negative - "no-show" trips the
        // negation veto on the word "no" - so running either side through the clause filter would
        // make the rule refuse a no-show the source note plainly records.
        return /\b(unresponsive|failed to (respond|show|deliver|attend)|no[- ]show|negligen\w*|ignored|neglected)\b/i.test(String(ev || ''));
      },
      literal: true,   // "failed to respond" is itself negative; the veto would silence every match
      reason: 'attributed fault with no evidence of it'
    },
    {
      id: 'owner',
      // Ownership may only be assigned to a party the DERIVED facts already put on the hook.
      // Coordinator is always allowed: chasing a status is internal work, and assigning internal
      // work is not blame - the same reading the stale-note rule above already relies on.
      claim: /\b(vendor|client|supplier|materials|landlord)\s+(to|must|needs? to|is responsible|owes)\b/i,
      allow: function (f, ev, m) {
        var who = String(m[1] || '').toLowerCase();
        var allowed = ['coordinator'];
        [f.blockerOwner, f.nextActionOwner].forEach(function (o) {
          if (o && o !== 'Unknown') allowed.push(String(o).toLowerCase());
        });
        // A caller that supplied no derived facts establishes no ownership, so there is nothing
        // here for the line to contradict and this rule has no basis to refuse it. The other rules,
        // and the date gate, still apply. Without this the gate would reject a perfectly ordinary
        // line purely because the caller omitted the facts argument.
        if (allowed.length === 1 && !f.nextAction) return true;
        if (allowed.indexOf(who) !== -1) return true;
        // PO/Approval covers the approval chain; a line naming the client as approver on a
        // proposal-sent job is the same fact under the label the reader actually uses.
        if (who === 'client' && allowed.indexOf('po/approval') !== -1) return true;
        // The facts' own prose may name a party the LABEL does not: the materials stage is owned by
        // "Materials" but its next action reads "Vendor to confirm the delivery date". A line that
        // repeats what the derived facts already say is grounded, whatever the label.
        return woaEvidenceHas(ev, new RegExp('\\b' + who + '\\s+(to|must|needs? to|is responsible|owes)\\b', 'i'));
      },
      reason: 'assigned the next move to a party the evidence does not put on the hook'
    },
    {
      id: 'internal-wording',
      claim: /\b(umbrava|graphql|\bbwn\b|\bai\b|\bllm\b|system prompt|derived facts|confidence|this audit\b|audit (tool|process|run|script)|source system)\b/i,
      allow: function () { return false; },
      literal: true,
      reason: 'used internal tooling wording that must not reach a client-facing note'
    },
    {
      id: 'contradicts-status',
      claim: /\b(awaiting|pending|in progress|not yet|outstanding)\b/i,
      allow: function (f) { return !f.terminal; },
      literal: true,   // "not yet" is inherently negative; the veto would silence the rule
      reason: 'asserted open work on a work order whose live status reports it closed'
    }
  ];
  // The FIRST rule a line trips, or '' when it trips none. One reason, because the caller records
  // one degradation cause and a list of nine would not change what the operator does about it.
  // The derived facts are folded into the evidence haystack: in production the prompt always
  // carries them, and a fact the deterministic layer established IS grounding - it is the same
  // material the fallback note is built from, so the gate must not reject the fallback's own
  // wording just because the caller passed a thin groundText.
  function woaClaimIssue(text, f, evidence) {
    var s = String(text || '');
    f = f || {};
    var ev = String(evidence || '') + '\n' +
      [f.currentStage, f.primaryBlocker, f.nextAction].filter(Boolean).join(' - ');
    for (var i = 0; i < WOA_CLAIM_RULES.length; i++) {
      var r = WOA_CLAIM_RULES[i];
      var m = r.literal ? r.claim.exec(s) : woaClaimMatch(s, r.claim);
      if (!m) continue;
      if (r.allow && r.allow(f, ev, m)) continue;
      return r.reason;
    }
    return '';
  }

  // The over-30 chain is the line that actually reaches a work order, so it gets the SAME gate as
  // the standard note - minus the ECD clause, because the wrapper owns that end and the model is
  // instructed not to write one. Until 0.13.0 this path had only the date check, which made the
  // posted note the least validated output in the tool.
  function validateTimelineChain(chain, f, groundText) {
    var s = String(chain == null ? '' : chain).trim();
    if (!s) return 'empty AI timeline chain';
    if (WOA_VAGUE.test(s)) return 'AI timeline used vague filler wording';
    var claim = woaClaimIssue(s, f, String(groundText || ''));
    if (claim) return 'AI timeline ' + claim;
    return ungroundedDates(s, String(groundText || ''));
  }

  // Work-order key normalization. The old reader stripped EVERY non-digit, so a compound or
  // mistyped cell silently CONCATENATED into a different, perfectly valid work-order number and the
  // audit went and read someone else's job: "386564-2" became 3865642 and "386564/386565" became
  // 386564386565. Anything carrying more than one candidate number is refused outright rather than
  // guessed at. Returns {n, confidence, reason}; n === null means DO NOT FETCH.
  function woaNormalizeKey(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { n: null, confidence: 'low', reason: 'the work order cell is empty' };
    var t = s.replace(/\.0+$/, '');                       // Excel numeric round-trip ("386564.0")
    var groups = t.match(/\d+/g) || [];
    if (!groups.length) return { n: null, confidence: 'low', reason: 'not a WO number: "' + s + '"' };
    if (groups.length > 1) {
      return { n: null, confidence: 'low', reason: '"' + s + '" holds more than one number - it was NOT guessed at; split or correct the cell and re-run' };
    }
    var n = parseInt(groups[0], 10);
    if (!n || isNaN(n)) return { n: null, confidence: 'low', reason: 'not a WO number: "' + s + '"' };
    // What is left once the number and the house decoration (W, W-, #, spaces) are removed.
    var decor = t.replace(/\d+/, '').replace(/^\s*w[-\s]*/i, '').replace(/[#\s]/g, '');
    return {
      n: n,
      confidence: decor ? 'medium' : 'high',
      reason: decor ? 'unexpected characters ("' + decor + '") around the work order number' : null
    };
  }

  // Read-only WOA_PHASE coverage. The table was COPIED from Core and has never been re-measured
  // against the live tenant, so a status it does not carry is not an error - it is a fact about the
  // table that nobody could see. This records what the run actually met. It never edits the table,
  // never maps an unknown status to a stage, and asks Umbrava nothing extra: every name here came
  // from a header the run had already read. Comparison is lowercased+trimmed; the RAW name is kept.
  function statusCoverage(results) {
    var seen = {}, order = [];
    for (var i = 0; i < (results || []).length; i++) {
      var r = results[i];
      var raw = (r && r.sourceStatusName) ? String(r.sourceStatusName).trim() : '';
      if (!raw) continue;
      var k = raw.toLowerCase();
      if (!seen[k]) { seen[k] = { status: raw, count: 0, mapped: WOA_PHASE[k] || null }; order.push(k); }
      seen[k].count++;
    }
    var observed = order.map(function (k) { return seen[k]; });
    return {
      observed: observed,
      unmapped: observed.filter(function (o) { return !o.mapped; })
    };
  }
  // ===== BWN WO-AUDIT STATE END ==================================================================

  var WO_TIMELINE_SYSTEM = [
    'You summarize a facilities work order\'s note history into a compact, dated event timeline for',
    'an over-30-days aging report.',
    '',
    'You are given the work order\'s notes, OLDEST first. Output a SINGLE line: the key events in',
    'chronological order, separated by " - ", each with its date as M/D when the note gives one,',
    'describing what happened and any delay and its reason.',
    '',
    'Example output:',
    'panels damaged received 7/29 refused delivery - claim filed - replacement panels fabricating delayed - new panels ship 8/6 - received 8/13 - install sched 8/25 cancelled truck breakdown - onsite 8/27 - wrong cutouts detected 8/28 - reorder pending',
    '',
    'Rules:',
    '- Use ONLY events, dates and reasons actually present in the notes. Never invent a date, ETA,',
    '  approval, or event. If a note gives no date, state the event without one.',
    '- Oldest to newest. Keep each event terse (a few words).',
    '- Focus on WHERE the job stands and WHY it is delayed.',
    '- Do NOT add a heading, the trade, an "Over 30" prefix, or an ECD line - those are added',
    '  separately. Output ONLY the dash-separated event chain: no preamble, no quotes, no markdown.',
    '- END the chain with the CURRENT position: the last segment must say where the job stands now,',
    '  what is holding it and who owes the next move, using the DERIVED FACTS block supplied below.',
    '  Do not restate the facts block verbatim and do not add an ECD - just land the chain on the',
    '  present state instead of trailing off at whatever the last note happened to mention.',
    '- If no note says anything about status, output exactly: no status notes on file',
    // 0.13.0: the chain is now held to the same claim gate as the standard note (it is the line
    // that actually gets posted onto a work order), so it is told the same rules.
    '- Report only what the notes state. Never assert completion, approval, pricing/NTE/DNE/PO,',
    '  scheduling, dispatch, on-site attendance, vendor assignment or client contact that the notes',
    '  do not record, and never attribute fault to anyone.',
    '- Never mention this tool, the audit process, a source system, a model, or a confidence level.'
  ].join('\n');

  // Build the timeline user turn: the WO's FULL note history OLDEST-FIRST (the chronology lives
  // across all notes, not the last two). Capped so a very chatty job cannot blow the AI row budget.
  // ponytail: 40-note / 600-char cap; widen if a real job's early history is being truncated.
  function buildTimelineInput(wo, notesNewestFirst, facts) {
    var oldestFirst = (notesNewestFirst || []).slice().reverse();
    var capped = oldestFirst.slice(-40);   // keep the 40 most recent, still oldest->newest
    var lines = capped.map(function (n) {
      n = (n && typeof n === 'object') ? n : {};
      var when = fmtMD(n.createdDate);
      // Same sanitization as the standard prompt, applied BEFORE the 600-char cap so the cap is
      // spent on the event history rather than on an email header block (measured median: the
      // paste took 62% of the note it appeared in).
      var txt = woaStripQuotedEmail(n.content).replace(/\s+/g, ' ').slice(0, 600);
      return (when ? when + ': ' : '') + (txt || '(empty)');
    });
    var f = facts || {};
    // Additive only: the note history stays the model's primary input and keeps its oldest-first
    // framing and its caps, exactly as before. The facts block is appended so the chain can LAND on
    // the present state - it never replaces the history the chronology is extracted from.
    var factBlock = [
      'DERIVED FACTS for the final segment only (do not restate verbatim, do not add an ECD):',
      'Current stage: ' + (f.currentStage || '(unknown)'),
      'Blocker: ' + (f.primaryBlocker || '(none evidenced)'),
      'Blocker owner: ' + (f.blockerOwner || 'Unknown'),
      'Next action: ' + (f.nextAction || '(none evidenced)')
    ].join('\n');
    return [
      'Work order ' + (String(wo.raw || wo.number || '').trim() || '(unknown)') + ' note history, oldest first:',
      lines.length ? lines.join('\n') : '(no notes on file)',
      '',
      factBlock,
      '',
      'Output ONLY the dated event chain per the instructions.'
    ].join('\n');
  }

  // Parse `retry-after` out of GM_xmlhttpRequest's raw CRLF header blob. Accepts either form
  // RFC 9110 allows (delay-seconds or an HTTP-date). Returns 0 when absent or unparseable so
  // callers fall back to their own table; clamped to 120s so a wild value cannot park a row.
  function retryAfterMs(rawHeaders) {
    var m = /^[ \t]*retry-after[ \t]*:[ \t]*(.+)$/im.exec(String(rawHeaders || ''));
    if (!m) return 0;
    var v = m[1].trim();
    var secs = /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
    if (isNaN(secs)) {
      var when = Date.parse(v);
      if (isNaN(when)) return 0;
      secs = Math.ceil((when - Date.now()) / 1000);
    }
    if (!(secs > 0)) return 0;
    return Math.min(secs, 120) * 1000;
  }
  // Whether the header was PRESENT, independent of whether it parsed to a usable wait. This used
  // to be inferred at the call site as `retryAfterMs(...) > 0`, which is wrong for every header
  // the server really did send but that clamps to 0: `retry-after: 0`, `+60`, `-5`, `60, 30`, or
  // any garbage. The log line it feeds ("(no retry-after header)") is the designated live proof
  // that the SWA edge forwards the header at all, so deriving it from the value makes the one
  // planned verification report a working feature as dead.
  function hasRetryAfter(rawHeaders) {
    return /^[ \t]*retry-after[ \t]*:/im.test(String(rawHeaders || ''));
  }

  // Timing budget. These MUST fit inside the timeoutMs handed to bwnAI at the call site: the
  // BYTE-FROZEN router wraps the whole run in withTimeout(run, timeoutMs) and resolves '' when
  // it wins, which discards the recorded reason and falls through to the generic message. The
  // sender therefore gets the SHORTER deadline and always reports first; the router is only a
  // backstop. Getting this wrong is what made a 15s+45s schedule inside a 60s router budget a
  // guaranteed row failure that merely took a minute longer to arrive.
  var AI_ATTEMPT_TIMEOUT_MS = 45000;                          // one wire attempt
  var AI_ROW_BUDGET_MS = 150000;                              // attempt + a full 60s wait + attempt
  var AI_ROUTER_TIMEOUT_MS = AI_ROW_BUDGET_MS + 15000;        // backstop, never the reporter
  var THROTTLE_BACKOFF_MS = [15000, 45000];   // cumulative 60s - clears either 60s window
  var TRANSIENT_BACKOFF_MS = [2000, 6000];    // plain 5xx / network blip
  // A wait that leaves less than this cannot produce an answer, so it is the point at which the
  // budget is genuinely spent rather than merely tight. Used to TRIM an over-long wait instead of
  // abandoning the row while budget remains.
  var AI_MIN_ATTEMPT_MS = 8000;

  // Plain-language cause for a coordinator, wire detail kept in parentheses for support.
  // "HTTP 502: Anthropic API error (429)" tells the reader nothing they can act on.
  function causeText(kind, status, detail) {
    var head = (kind === 'throttle') ? 'the AI service was busy, rate limited'
      : (kind === 'timeout') ? 'the AI service did not respond in time'
      : (kind === 'auth') ? 'the SWA rejected the ingest key'
      : (kind === 'credits') ? 'the AI account is out of credits - top up Anthropic billing (a retry will not fix it)'
      : (kind === 'budget') ? 'gave up waiting out a rate limit'
      : 'the AI service errored';
    var tail = [];
    if (status) tail.push('HTTP ' + status);
    if (detail) tail.push(String(detail));
    return head + (tail.length ? ' (' + tail.join(': ') + ')' : '');
  }

  // An upstream Anthropic throttle reaches us as a GENERIC 502 whose body names the real
  // status, so testing status === 429 alone misses it and drops to the fast transient table -
  // reintroducing the very bug this schedule exists to fix.
  function isThrottle(r) {
    if (r.status === 429 || r.status === 529) return true;
    var e = (r.json && r.json.error) ? String(r.json.error) : '';
    return r.status === 502 && /\((?:429|529)\)/.test(e);
  }

  // The route wraps EVERY upstream Anthropic failure as a generic 502, so r.status alone cannot
  // tell a retryable overload (429/529) from a verdict a human must act on. The route now reports
  // the real upstream status in `upstreamStatus`; older deploys are covered by parsing the "(400)"
  // out of the error string. A 400/401/403/413 is a verdict - retrying only burns the budget, and
  // for exhausted credits it spends tries on a call that cannot succeed while hiding the real cause
  // behind the same rate-limit message that misled the 216-WO batch on 2026-08-18.
  function upstreamStatus(r) {
    var u = r && r.json && r.json.upstreamStatus;
    if (typeof u === 'number') return u;
    var m = /Anthropic API error \((\d{3})\)/.exec((r && r.json && r.json.error) ? String(r.json.error) : '');
    return m ? parseInt(m[1], 10) : 0;
  }
  function isNonRetryable(r) {
    var u = upstreamStatus(r);
    return u === 400 || u === 401 || u === 403 || u === 413;
  }

  // Injected proxy sender: ONE POST to /api/ai (summarize tier). Reuses the existing
  // ingest-key + Umbrava-token plumbing. Resolves '' on any miss so bwnAI falls through and
  // never throws (backgrounded-tab rule), recording WHY into `ctx.reason` - including a
  // PROVISIONAL reason before each wire call, so a row abandoned mid-flight still reports
  // something truthful rather than the generic rank/key fallback.
  function aiProxySend(payload, ctx) {
    payload = payload || {};
    ctx = ctx || {};
    var key = getKey();
    if (!key) { ctx.reason = causeText('auth', 0, 'no ingest key set; use the Tampermonkey menu'); return Promise.resolve(''); }
    var body = {
      task: payload.task || 'summarize',
      input: (payload.prompt != null) ? String(payload.prompt) : '',
      userToken: authToken()
    };
    if (payload.system) body.system = payload.system;
    if (payload.model) body.model = payload.model;
    var tries = 3, attempt = 0;
    var deadline = Date.now() + AI_ROW_BUDGET_MS;
    var lastKind = '', lastStatus = 0;   // what we most recently SAW, for the budget message
    var sawThrottle = false;             // sticky: a row throttled twice then timing out is,
                                         // in substance, rate limited - say so or the reader
                                         // chases the wrong cause on the last attempt's class.
    function give(why) {
      var msg = why + (attempt > 1 ? ' after ' + attempt + ' tries' : '');
      if (sawThrottle && !/rate limited/.test(msg)) msg += '; the service was rate limiting this batch earlier';
      ctx.reason = msg;
      return '';
    }
    // When the budget is the binding constraint, name what we were up against - "ran out of
    // time" alone would send a coordinator chasing the wrong thing, which is the whole bug.
    function giveBudget() {
      var head = lastKind ? causeText(lastKind, lastStatus, '') : 'the AI service did not respond';
      return give(head + ', and the ' + Math.round(AI_ROW_BUDGET_MS / 1000) + 's limit for one row ran out');
    }
    // Never sleep past the budget, and never issue a POST after it: sleeping into the router
    // abort is what discarded the reason, and a late POST spends the shared IP throttle on a
    // row that has already been marked errored.
    function pause(waitMs, throttled, hadHeader) {
      // TRIM an over-long wait, do not abandon the row. A wait that does not fit is not proof the
      // budget is spent: a 60s hint arriving at t=90s used to fail the row reporting "the 150s
      // limit for one row ran out" with roughly 60s still unspent, when a shorter wait would have
      // left room for a third attempt. Only when there is no room for a usable attempt at all is
      // the budget actually gone - which is also what makes giveBudget()'s claim true.
      var room = deadline - Date.now() - AI_MIN_ATTEMPT_MS;
      if (waitMs > room) waitMs = room;
      if (waitMs <= 0) return Promise.resolve(giveBudget());
      if (ctx.onWait) { try { ctx.onWait(waitMs, throttled, hadHeader); } catch (e) { } }
      return sleep(waitMs).then(once);
    }
    function once() {
      attempt++;
      // Cap this attempt to what is left. An attempt that STARTS inside the budget can still
      // run past it - and past the router backstop - which is exactly how a reason gets lost.
      var remain = deadline - Date.now();
      if (remain <= 1000) return Promise.resolve(giveBudget());
      ctx.reason = causeText('timeout', 0, 'no reply yet on try ' + attempt);
      return gmPost(AI_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, body, Math.min(AI_ATTEMPT_TIMEOUT_MS, remain))
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok && r.json.status === 'final') return String(r.json.text || '');
          var throttled = isThrottle(r);
          var detail = (r.json && r.json.error) ? String(r.json.error) : '';
          var up = upstreamStatus(r);                       // the REAL Anthropic status behind a 502 shell
          var credits = !!(r.json && r.json.code === 'INSUFFICIENT_CREDITS');
          lastKind = throttled ? 'throttle' : (credits ? 'credits' : ((r.status === 403 || up === 401 || up === 403) ? 'auth' : 'error'));
          lastStatus = up || r.status;                      // report what Anthropic said, not the 502 wrapper
          if (throttled) sawThrottle = true;
          // A verdict, not weather: the route's own 403/400/413, OR an upstream one it wrapped as a
          // generic 502 (isNonRetryable / credits). Retrying only wastes the budget; for exhausted
          // credits it spends nothing while masking the cause. Fail fast with the truth. The status
          // number carries the detail, so the redundant wrapper string is dropped here.
          if (r.status === 403 || r.status === 400 || r.status === 413 || credits || isNonRetryable(r)) return give(causeText(lastKind, lastStatus, ''));
          if (attempt >= tries) return give(causeText(lastKind, lastStatus, detail));
          var hinted = retryAfterMs(r.headers);
          var table = throttled ? THROTTLE_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
          var planned = table[attempt - 1] || table[table.length - 1];
          // FLOOR the server hint against the table; never let it REPLACE the table. The server
          // now emits the real remaining window, which is the wait for one slot to free (~1s under
          // a steady batch) and NOT the wait until this caller is admitted. Taking it verbatim
          // made a throttled row burn all three tries in about two seconds - the same sub-2s burn
          // this release exists to remove, reintroduced by making the server honest. The table is
          // the floor because it is sized to clear the 60s sliding window on both sides of the
          // wire; a longer hint still wins, which is the case where the server knows better.
          return pause(Math.max(hinted, planned), throttled, hasRetryAfter(r.headers));
        }, function (e) {
          var why = (e && e.message) || 'network error';
          lastKind = /timed out/i.test(why) ? 'timeout' : 'error';
          lastStatus = 0;
          if (attempt >= tries) return give(causeText(lastKind, 0, why));
          return pause(TRANSIENT_BACKOFF_MS[attempt - 1] || TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1], false, false);
        });
    }
    return once();
  }
  bwnAI.setProxy(aiProxySend);

  // Summarize one WO into a status note through the unified transport. tier:'proxy'
  // (minRank 1) forces the /api/ai summarize call for any staff+ with a known role; the
  // server is key-only, so the client rank read is UX-only. A miss (connector down / role
  // not yet resolved) throws so the batch pool marks the row for "Retry Errors" (unchanged).
  function summarize(woFacts, notes, model, onWait, facts) {
    // Per-WO context, not module state: concurrency defaults to 3, so a shared object would
    // cross-report one row's reason onto another. `onWait` lets the batch log a liveness line
    // while the sender sits in backoff.
    var ctx = { onWait: onWait };
    var prompt = buildAuditInput(woFacts, notes, facts);
    return bwnAI({
      task: 'summarize',
      tier: 'proxy',
      minRank: 1,
      prompt: prompt,
      system: WO_AUDIT_SYSTEM,
      oneLine: false,
      maxChars: 4000,
      timeoutMs: AI_ROUTER_TIMEOUT_MS,
      fallback: [],
      proxySend: function (p) { p.model = model; return aiProxySend(p, ctx); }
    }).then(function (note) {
      note = String(note || '').trim();
      // ctx.reason is set before the first wire call, so an unset reason now means bwnAI never
      // reached the sender AT ALL - the router fail-closed on an unknown Umbrava rank
      // (`bwn:role:last` unpublished, i.e. running without the Ops Suite). That is the only
      // case the key/role hint ever described, and the run summary states it once.
      if (!note) throw new Error(ctx.reason || 'Umbrava rank not resolved - run alongside the BWN Ops Suite');
      // Strict output gate. An ungrounded or malformed line is DISCARDED, not shipped and not
      // patched up: the deterministic note is always available and is never worse than a note
      // carrying a date nobody wrote. `degraded` tells the caller to say so on the row.
      var bad = validateAiNote(note, facts, prompt);
      if (bad) return { note: composeAuditStatusNote(facts), degraded: bad };
      return { note: note, degraded: '' };
    });
  }

  // Over-30 timeline note: the model extracts the dated event CHAIN from the full history; the
  // deterministic prefix (Over 30 - trade) and ECD tail are added by composeTimelineNote, never by
  // the model. Same transport/budget as summarize; oneLine collapses the chain onto one line.
  function summarizeTimeline(woFacts, notes, header, model, onWait, facts) {
    var ctx = { onWait: onWait };
    var prompt = buildTimelineInput(woFacts, notes, facts);
    return bwnAI({
      task: 'summarize',
      tier: 'proxy',
      minRank: 1,
      prompt: prompt,
      system: WO_TIMELINE_SYSTEM,
      oneLine: true,
      maxChars: 2000,
      timeoutMs: AI_ROUTER_TIMEOUT_MS,
      fallback: [],
      proxySend: function (p) { p.model = model; return aiProxySend(p, ctx); }
    }).then(function (chain) {
      chain = String(chain || '').trim();
      if (!chain) throw new Error(ctx.reason || 'Umbrava rank not resolved - run alongside the BWN Ops Suite');
      // The wrapper is unchanged and still owns both ends; the chain is still the only model-authored
      // part. A chain that echoed an ECD token despite the instruction would put TWO ECDs on the line,
      // so strip a trailing one - the deterministic tail stays the single source of the ECD.
      // ANCHORED to a trailing ECD token, never greedy. An over-30 chain routinely NAMES a lapsed
      // ECD mid-history ("... - ECD 8/15 committed - 8/20 vendor no-show - ..."), and a `[\s\S]*$`
      // strip silently deleted every segment after the first such mention - the richest part of the
      // note. Only a genuine trailing "- ECD <date|TBD|not set> ..." tail is removed.
      chain = chain.replace(/\s*-\s*ECD\s+(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|TBD|not set)\b[^-]*$/i, '').trim();
      // The posted path gets the FULL gate as of 0.13.0 - dates, vague filler, and every claim
      // rule - not just the date check. This is the chain that reaches a real work order, so it is
      // the last place an invented date OR an unevidenced claim should be allowed. The wrapper and
      // its ECD tail are unchanged either way, so a rejected chain still ships the house format.
      var bad = validateTimelineChain(chain, facts, prompt);
      if (bad) return { note: composeTimelineNote(fallbackChain(facts), header, Date.now()), degraded: bad };
      return { note: composeTimelineNote(chain, header, Date.now()), degraded: '' };
    });
  }

  // ---- Bounded-concurrency runner ----
  function runPool(items, worker, concurrency, onProgress, shouldStop) {
    return new Promise(function (resolve) {
      var i = 0, done = 0, results = new Array(items.length);
      function next() {
        if (i >= items.length) return Promise.resolve();
        // Cancel stops handing out NEW rows; rows already in flight finish so their notes are
        // not lost. Backoff waits can run to minutes, so a batch must be interruptible.
        if (shouldStop && shouldStop()) return Promise.resolve();
        var idx = i++;
        return Promise.resolve().then(function () { return worker(items[idx], idx); })
          .then(function (v) { results[idx] = v; }, function (e) { results[idx] = { error: (e && e.message) || String(e) }; })
          .then(function () { done++; if (onProgress) onProgress(done, items.length); return next(); });
      }
      var runners = [];
      for (var k = 0; k < Math.min(Math.max(1, concurrency), items.length || 1); k++) runners.push(next());
      Promise.all(runners).then(function () { resolve(results); });
    });
  }

  // ===== RUN ACCOUNTING =====================================================
  // A row has THREE outcomes, not two. Cancel returns from next() before the row is ever handed
  // to the worker, so `session.results[i]` stays a HOLE - distinct from a written note and from
  // an `{error}`. Every consumer used to test `.error` alone, so a skipped row was invisible: it
  // counted nowhere, could not be retried, and its note cell went out unwritten with nothing on
  // screen saying so. Module scope, and marked, so the node harness drives the real shipped bytes.

  // Index loop, not `.filter`/`.reduce`: `session.results` is a SPARSE array (assigned by index,
  // never pushed) and the iterator methods skip holes entirely - the exact rows this counts.
  // `skipped` is derived from the total so a hole cannot escape it.
  function auditTally(results, total) {
    var ok = 0, errs = 0;
    for (var i = 0; i < total; i++) {
      var r = results[i];
      if (!r) continue;
      if (r.error) errs++; else ok++;
    }
    return { ok: ok, errs: errs, skipped: total - ok - errs };
  }

  // Everything that still owes a note: errored rows, rows the cancel never reached, AND rows that
  // fell back to the deterministic note because the AI failed or returned something ungrounded.
  // A degraded row DID get a usable note (so it is not counted as "no note" and auditTally still
  // sees two outcomes) but it is exactly what "Retry Unfinished" should pick up once the AI is back.
  // Positional - `session.results` is indexed by position in `session.rows`.
  function pendingRows(rows, results) {
    return rows.filter(function (row, i) {
      var r = results[i];
      return !r || !!r.error || !!r.degraded;
    });
  }

  // One vocabulary for every surface. The summary, the cancel warning and the download warning
  // previously used three different phrasings and two different totals ("unaudited" meaning
  // errored+skipped in one place, "never audited" meaning skipped only in another), so the number
  // a coordinator read at download matched nothing they had been shown.
  function owedPhrase(tal) {
    var owed = tal.errs + tal.skipped;
    var parts = [];
    if (tal.errs) parts.push(tal.errs + ' failed');
    if (tal.skipped) parts.push(tal.skipped + ' never audited');
    return owed + ' row' + (owed === 1 ? '' : 's') + ' with no note' +
      (parts.length ? ' (' + parts.join(', ') + ')' : '');
  }
  // Said wherever an unwritten cell can reach the client. Deliberately does NOT claim the cells
  // are blank: nothing is written to a row that errored or was skipped, so the cell keeps whatever
  // the uploaded workbook held - and on a recurring audit the detected notes column carries LAST
  // cycle's status text. Shipping that as current is worse than shipping a blank.
  var UNWRITTEN_NOTE = 'Those cells were not written: blank if this column is new, otherwise still holding the workbook\'s previous text.';
  // ===== END RUN ACCOUNTING =================================================

  // ====================================================================
  // Workbook mapping. Header-based (survives column reorder) with a scan for the
  // header row; write-back column detected dynamically, appended if absent.
  // ====================================================================
  var KEY_PATTERNS = [/^wo\s*#?$/i, /work\s*order\s*#/i, /^wo\s*number/i];
  var KEY_FALLBACK = [/source\s*job\s*#?/i, /^job\s*id$/i, /^job\s*#?$/i];
  function findCol(hdr, patterns) {
    for (var p = 0; p < patterns.length; p++) {
      for (var c = 0; c < hdr.length; c++) { if (patterns[p].test(hdr[c])) return c; }
    }
    return -1;
  }
  function findNoteCol(hdr) {
    // Prefer an explicit notes column; then any "note(s)" header that is about note CONTENT -
    // never a date/count/author/timestamp column, so "Last Note Date" must NOT match.
    var pref = [/^audit\s*notes?$/i, /^status\s*notes?$/i, /^notes?$/i, /coordinator\s*notes?/i, /audit.*note|note.*audit/i, /status\s*note/i];
    for (var p = 0; p < pref.length; p++) { for (var c = 0; c < hdr.length; c++) { if (pref[p].test(hdr[c])) return c; } }
    var last = -1;
    for (var i = 0; i < hdr.length; i++) {
      if (/\bnotes?\b/i.test(hdr[i]) && !/date|count|#|by|author|time|updated|\blast\b/i.test(hdr[i])) last = i;
    }
    return last;
  }
  // Flags column: prefer an explicit "Audit Flags"/"Flags"/"Exceptions" header (so a recurring
  // audit reuses its own column instead of appending a duplicate each run); else -1 -> append.
  function findFlagCol(hdr) {
    var pref = [/^audit\s*flags?$/i, /^flags?$/i, /^exceptions?$/i, /audit.*flags?|flags?.*audit/i];
    for (var p = 0; p < pref.length; p++) { for (var c = 0; c < hdr.length; c++) { if (pref[p].test(hdr[c])) return c; } }
    return -1;
  }
  function mapSheet(ws) {
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
    // Locate the header row: the first row (of the first 15) that matches a key pattern.
    var headerRow = 0, keyCol = -1;
    for (var r = 0; r < Math.min(15, aoa.length); r++) {
      var row = (aoa[r] || []).map(function (x) { return String(x == null ? '' : x); });
      var k = findCol(row, KEY_PATTERNS);
      if (k === -1) k = findCol(row, KEY_FALLBACK);
      if (k !== -1) { headerRow = r; keyCol = k; break; }
    }
    var hdr = (aoa[headerRow] || []).map(function (x) { return String(x == null ? '' : x); });
    if (keyCol === -1) keyCol = findCol(hdr, KEY_PATTERNS);
    if (keyCol === -1) keyCol = findCol(hdr, KEY_FALLBACK);
    var map = {
      headerRow: headerRow,
      key: keyCol,
      keyName: keyCol > -1 ? hdr[keyCol] : null,
      status: findCol(hdr, [/^status$/i, /wo\s*status/i]),
      city: findCol(hdr, [/^city$/i]),
      state: findCol(hdr, [/^state$/i]),
      location: findCol(hdr, [/location|site|store/i]),
      days: findCol(hdr, [/aged|days\s*open|^#?\s*days$/i]),
      assigned: findCol(hdr, [/assigned|coordinator|owner/i]),
      note: findNoteCol(hdr),
      noteAppended: false,
      flag: findFlagCol(hdr),
      flagAppended: false,
    };
    map.noteName = map.note > -1 ? hdr[map.note] : null;
    map.flagName = map.flag > -1 ? hdr[map.flag] : null;
    map.aoa = aoa;
    return map;
  }
  // Ensure a note column exists on the worksheet; append "Audit Notes" if none was found.
  function ensureNoteCol(ws, map) {
    if (map.note > -1) return map;
    var range = XLSX.utils.decode_range(ws['!ref']);
    var col = range.e.c + 1;
    ws[XLSX.utils.encode_cell({ c: col, r: map.headerRow })] = { t: 's', v: 'Audit Notes' };
    range.e.c = col;
    ws['!ref'] = XLSX.utils.encode_range(range);
    map.note = col; map.noteName = 'Audit Notes'; map.noteAppended = true;
    return map;
  }
  // Ensure an Audit Flags column; append one if none was detected. Mirrors ensureNoteCol.
  function ensureFlagCol(ws, map) {
    if (map.flag > -1) return map;
    var range = XLSX.utils.decode_range(ws['!ref']);
    var col = range.e.c + 1;
    ws[XLSX.utils.encode_cell({ c: col, r: map.headerRow })] = { t: 's', v: 'Audit Flags' };
    range.e.c = col;
    ws['!ref'] = XLSX.utils.encode_range(range);
    map.flag = col; map.flagName = 'Audit Flags'; map.flagAppended = true;
    return map;
  }
  function cellStr(aoa, r, c) {
    if (c < 0) return '';
    var row = aoa[r] || [];
    var v = row[c];
    return v == null ? '' : String(v).trim();
  }

  // ====================================================================
  // UI
  // ====================================================================
  var session = null;   // { wb, ws, map, rows:[{rowIdx, key}], results:[], name }
  // Module scope so the dock-eviction listener can see it too. A run can now span many minutes
  // of rate-limit backoff, so dismissing the drawer mid-run has to stop being a silent way to
  // throw away every note already written into the workbook.
  var _running = false, _cancelled = false;

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:' + GREEN + ';color:#fff;padding:9px 16px;border-radius:8px;font:600 13px ' + FONT + ';z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function getKey() { return GM_getValue('ingest_key', ''); }

  function buildModal() {
    if (document.getElementById('bwn-woaudit-ov')) return;
    // Suite drawer: slides out from the dock rail, styled by Core's page-wide sheet.
    var ov = document.createElement('aside');
    ov.id = 'bwn-woaudit-ov'; ov.className = 'bwn-drawer';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'WO Audit');
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;';
    box.innerHTML =
      '<div class="bwn-drawer-hd"><div><div class="t">WO Audit</div><div class="s">batch status notes from an audit .xlsx</div></div>' +
      '<button type="button" id="bwn-woaudit-x" class="bwn-drawer-x" title="Close" aria-label="Close">&times;</button></div>' +
      '<div class="bwn-drawer-body">' +
      '<div id="bwn-woaudit-keywarn" style="display:none;background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:12.5px"></div>' +
      // Completeness gets its OWN banner rather than sharing the ingest-key one: they fire in
      // different situations and would clobber each other. It persists outside the 240px log,
      // where the same sentence is one 12px monospace line among forty that look identical - the
      // coordinator clicks Download, the browser takes focus, and the file is already on disk.
      // role=status so it is announced rather than only drawn.
      '<div id="bwn-woaudit-warn" role="status" aria-live="polite" style="display:none;background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:12.5px;font-weight:600"></div>' +
      '<label style="display:block;font-weight:600;margin-bottom:6px">1. Audit workbook (.xlsx)</label>' +
      '<input type="file" id="bwn-woaudit-file" accept=".xlsx,.xls" style="margin-bottom:6px">' +
      '<div id="bwn-woaudit-sheetwrap" style="display:none;margin:8px 0"><label style="font-weight:600;margin-right:8px">Sheet</label><select id="bwn-woaudit-sheet"></select></div>' +
      '<div id="bwn-woaudit-mapinfo" style="font-size:12.5px;color:#444;margin:8px 0;white-space:pre-line"></div>' +
      '<div id="bwn-woaudit-notecolwrap" style="display:none;margin:8px 0"><label style="font-weight:600;margin-right:8px">Write notes to column</label><select id="bwn-woaudit-notecol"></select></div>' +
      '<div style="display:flex;gap:16px;margin:12px 0;flex-wrap:wrap">' +
      '<div><label style="display:block;font-weight:600;margin-bottom:4px">Model</label><select id="bwn-woaudit-model"></select></div>' +
      '<div><label style="display:block;font-weight:600;margin-bottom:4px">Concurrency</label><input id="bwn-woaudit-conc" type="number" min="1" max="6" value="3" style="width:64px"></div>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0">' +
      '<button id="bwn-woaudit-start" style="background:' + GREEN + ';color:#fff;border:0;padding:9px 18px;border-radius:8px;font-weight:600;cursor:pointer">Start Audit</button>' +
      '<button id="bwn-woaudit-cancel" style="display:none;background:#6b1d1d;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Cancel</button>' +
      '<button id="bwn-woaudit-retry" style="display:none;background:#8a4b00;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Retry Unfinished</button>' +
      '<button id="bwn-woaudit-dl" style="display:none;background:#1a5f3e;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Download .xlsx</button>' +
      '</div>' +
      '<div id="bwn-woaudit-prog" style="font-weight:600;margin:6px 0"></div>' +
      '<div id="bwn-woaudit-log" style="font:12px ui-monospace,Consolas,monospace;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:8px;padding:10px;max-height:240px;overflow:auto;white-space:pre-wrap"></div>' +
      // Run diagnostics: unmapped live statuses + review-required rows, populated when a run
      // finishes. Read-only, in-memory, copyable - it is never written to the shared bwn:audit trail.
      '<div id="bwn-woaudit-diag"></div>' +
      // Post-step section: populated by renderPostSection() when a run finishes. One Post button per
      // drafted note, human-gated - there is NO bulk "post all".
      '<div id="bwn-woaudit-post"></div>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    bwnFocusTrap(ov);

    var $ = function (id) { return document.getElementById(id); };
    // Dismissal is refused while a run is in flight - a stray backdrop click during a long
    // backoff would otherwise orphan the workbook in memory with no route to Download.
    function tryClose() {
      if (_running) { logln('  (still running - press Cancel first if you want to stop)'); return; }
      drawerDismiss(ov);
    }
    ov.addEventListener('click', function (e) { if (e.target === ov) tryClose(); });
    $('bwn-woaudit-x').onclick = tryClose;

    var msel = $('bwn-woaudit-model');
    MODELS.forEach(function (m) { var o = document.createElement('option'); o.value = m.id; o.textContent = m.label; msel.appendChild(o); });

    var kw = $('bwn-woaudit-keywarn');
    if (!getKey()) { kw.style.display = 'block'; kw.textContent = 'SWA ingest key not set. Open the Tampermonkey menu -> "BWN WO Audit: Set SWA ingest key" (same key as the rest of the BWN Ops Suite), then reopen this.'; }

    var log = $('bwn-woaudit-log');
    function logln(s) { log.textContent += (log.textContent ? '\n' : '') + s; log.scrollTop = log.scrollHeight; }
    // The persistent half of a warning. Null-safe for the same reason the button writes are: the
    // drawer can be gone or rebuilt while a run is in flight.
    function setWarn(msg) {
      var w = $('bwn-woaudit-warn'); if (!w) return;
      w.textContent = msg || '';
      w.style.display = msg ? 'block' : 'none';
    }

    var loaded = null;   // { wb, name }
    $('bwn-woaudit-file').onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      // Belt and braces with the disabled attribute set in runAudit: a file picked mid-run would
      // replace `loaded` and orphan every note already written into the workbook in memory.
      if (_running) { logln('! A run is in progress - finish or cancel it before loading another workbook.'); return; }
      var fr = new FileReader();
      fr.onload = function () {
        try {
          if (typeof XLSX === 'undefined') throw new Error('spreadsheet library not loaded - reload the page');
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellFormula: true, cellStyles: true });
          loaded = { wb: wb, name: (f.name || 'wo-audit.xlsx').replace(/\.(xlsx|xls)$/i, '') };
          var sw = $('bwn-woaudit-sheetwrap'), ss = $('bwn-woaudit-sheet');
          ss.innerHTML = '';
          wb.SheetNames.forEach(function (nm) { var o = document.createElement('option'); o.value = nm; o.textContent = nm; ss.appendChild(o); });
          sw.style.display = wb.SheetNames.length > 1 ? 'block' : 'none';
          ss.onchange = describe;
          describe();
        } catch (err) { $('bwn-woaudit-mapinfo').textContent = 'Could not read workbook: ' + ((err && err.message) || err); }
      };
      fr.readAsArrayBuffer(f);
    };

    function currentSheet() { return loaded ? ($('bwn-woaudit-sheet').value || loaded.wb.SheetNames[0]) : null; }
    function describe() {
      if (!loaded) return;
      // Never rebuild `session` mid-run. A run now spans minutes of backoff, and swapping the
      // session under in-flight workers makes `session.rows.indexOf(row)` return -1, so their
      // notes are written to `results[-1]` where auditTally's index loop can never see them -
      // the rows report as "never audited" while their notes went into the OLD sheet.
      if (_running) return;
      // Results on screen belong to the session being replaced. Leaving Retry visible lets a
      // stale press audit the NEW workbook into whatever column was detected for it, overwriting
      // the client's existing Notes text; leaving Download visible offers the previous workbook.
      var rb0 = $('bwn-woaudit-retry'); if (rb0) rb0.style.display = 'none';
      var db0 = $('bwn-woaudit-dl'); if (db0) db0.style.display = 'none';
      setWarn('');   // the previous session's completeness state does not describe this workbook
      var ph0 = $('bwn-woaudit-post'); if (ph0) ph0.innerHTML = '';   // stale post cards belong to the old workbook
      var dg0 = $('bwn-woaudit-diag'); if (dg0) dg0.innerHTML = '';   // ...and so do stale diagnostics
      var ws = loaded.wb.Sheets[currentSheet()];
      var map = mapSheet(ws);
      var hdr = (map.aoa[map.headerRow] || []).map(function (x) { return String(x == null ? '' : x); });
      var dataRows = [];
      for (var r = map.headerRow + 1; r < map.aoa.length; r++) {
        var key = cellStr(map.aoa, r, map.key);
        if (key) dataRows.push({ rowIdx: r, key: key });
      }
      // Write-back column picker: every header + an append option, defaulting to the detection.
      // Header-detection is a hint only; the operator confirms so a wrong guess is never silent.
      var ncsel = $('bwn-woaudit-notecol');
      ncsel.innerHTML = '';
      hdr.forEach(function (h, i) { var o = document.createElement('option'); o.value = String(i); o.textContent = (h || ('(col ' + (i + 1) + ')')) + (i === map.note ? '  <-- detected' : ''); ncsel.appendChild(o); });
      var appendOpt = document.createElement('option'); appendOpt.value = 'append'; appendOpt.textContent = '+ append new "Audit Notes" column'; ncsel.appendChild(appendOpt);
      ncsel.value = (map.note > -1) ? String(map.note) : 'append';
      $('bwn-woaudit-notecolwrap').style.display = 'block';
      var info = [
        'WO # column: ' + (map.keyName != null ? '"' + map.keyName + '"' : 'NOT FOUND (cannot run)'),
        'Work orders detected: ' + dataRows.length,
        'Audit Flags column: ' + (map.flagName != null ? '"' + map.flagName + '"' : 'will append "Audit Flags"'),
        // Stated, not hidden: the spreadsheet library this tool ships (SheetJS Community) rewrites
        // the file on download, and its free build does not round-trip every Excel feature. Cell
        // values and formulas come through; presentation and workbook-level extras may not. A
        // coordinator sending this to a client needs to know that before, not after.
        'Writes ONLY the Notes and Audit Flags columns. Downloading rewrites the file: values and formulas are preserved, but styles, charts, images, conditional formatting, data validation and some workbook-level features may not survive with full fidelity.',
      ].join('\n');
      $('bwn-woaudit-mapinfo').textContent = info;
      $('bwn-woaudit-start').disabled = !(map.key > -1 && dataRows.length);
      session = { wb: loaded.wb, sheet: currentSheet(), map: map, rows: dataRows, results: [], name: loaded.name };
    }

    $('bwn-woaudit-start').onclick = function () { runAudit(false); };
    $('bwn-woaudit-retry').onclick = function () { runAudit(true); };
    $('bwn-woaudit-dl').onclick = function () { downloadResult(); };
    // Stops handing out new rows; in-flight rows finish so their notes are kept and Download
    // still appears. Without this the only exit from a long backoff is reloading the tab.
    $('bwn-woaudit-cancel').onclick = function () {
      if (!_running || _cancelled) return;
      _cancelled = true;
      logln('Cancelling - letting the rows already in flight finish...');
      this.disabled = true;
    };

    function runAudit(retryOnly) {
      if (!session) return;
      var key = getKey();
      if (!key) { kw.style.display = 'block'; kw.textContent = 'Set the SWA ingest key first (Tampermonkey menu).'; return; }
      if (!authToken()) { logln('! Not signed into Umbrava (no usable token). Reload the tab and retry.'); return; }
      var model = $('bwn-woaudit-model').value;
      var conc = Math.max(1, Math.min(6, parseInt($('bwn-woaudit-conc').value, 10) || 3));
      var ws = session.wb.Sheets[session.sheet];
      // Resolve the write-back column from the picker (detection is only the default) - but never
      // again once a column has been APPENDED. Both branches force `note = -1` first, which
      // defeats ensureNoteCol's own `if (map.note > -1) return` guard, so re-resolving appends a
      // SECOND "Audit Notes" column and splits one audit across two half-blank columns in the
      // client's workbook. The picker still governs the first resolution, and a run against an
      // EXISTING column stays re-resolvable because nothing was appended.
      if (!session.map.noteAppended) {
        var pick = $('bwn-woaudit-notecol').value;
        if (pick === 'append') { session.map.note = -1; ensureNoteCol(ws, session.map); }
        else { session.map.note = parseInt(pick, 10); if (isNaN(session.map.note)) { session.map.note = -1; ensureNoteCol(ws, session.map); } }
      }

      // Flags column: detect-or-append once (no picker - flags are new output, low clobber risk).
      // Guard on flagAppended so a resume/retry does not append a second "Audit Flags" column.
      if (session.map.flag === -1 && !session.map.flagAppended) ensureFlagCol(ws, session.map);

      // Resume, not just retry: rows a cancel skipped owe a note exactly as much as errored rows
      // do, and matching `.error` alone left them permanently unfinishable.
      var targets = retryOnly
        ? pendingRows(session.rows, session.results)
        : session.rows.slice();
      if (retryOnly && !targets.length) { logln('Nothing left to finish - every row has a note.'); return; }

      $('bwn-woaudit-start').disabled = true; $('bwn-woaudit-retry').style.display = 'none'; $('bwn-woaudit-dl').style.display = 'none';
      var ph = $('bwn-woaudit-post'); if (ph) ph.innerHTML = '';   // rebuilt when the run finishes
      var dgh = $('bwn-woaudit-diag'); if (dgh) dgh.innerHTML = '';
      // Lock the inputs that can replace `session` under in-flight workers. describe() also
      // refuses while running; this stops the interaction reaching it at all.
      $('bwn-woaudit-file').disabled = true;
      var shSel = $('bwn-woaudit-sheet'); if (shSel) shSel.disabled = true;
      $('bwn-woaudit-cancel').style.display = 'inline-block';
      $('bwn-woaudit-cancel').disabled = false;
      _running = true; _cancelled = false;
      setWarn('');   // stale from the previous pass; recomputed when this one finishes
      // One id per pass, so every row this pass produced can be correlated in the diagnostics copy
      // and in a support conversation. In-memory only - per the 0.13.0 decision, per-row audit
      // diagnostics deliberately do NOT go into the shared bwn:audit write trail.
      var RUN_ID = bwnCorrId();
      if (!retryOnly) { log.textContent = ''; session.results = new Array(session.rows.length); }
      logln((retryOnly ? 'Retrying ' : 'Auditing ') + targets.length + ' work orders with ' + model + ' (concurrency ' + conc + ')...');
      var prog = $('bwn-woaudit-prog');
      // Seed it: onProgress only fires when a row SETTLES, and a throttled row can now sit in
      // backoff for over a minute. A blank progress area plus a silent log reads as a hang.
      prog.textContent = 'Progress: 0 / ' + targets.length;

      runPool(targets, function (row) {
        var origIdx = session.rows.indexOf(row);
        // Liveness while the sender waits out a throttle. `hadHeader` is deliberately surfaced:
        // this is the first use of GM_xmlhttpRequest responseHeaders anywhere in the suite, so
        // the first live throttle tells us whether the retry-after plumbing actually works.
        var onWait = function (ms, throttled, hadHeader) {
          logln('  . WO ' + row.key + ': ' + (throttled ? 'AI service busy' : 'retrying') +
            ', waiting ' + Math.round(ms / 1000) + 's' +
            (throttled ? (hadHeader ? ' (server retry-after)' : ' (no retry-after header)') : ''));
        };
        // The row's pre-audit workbook note, read from the aoa snapshot taken at upload - so it is
        // the ORIGINAL text even on a retry pass, which is what a retention decision has to compare
        // against. '' when the notes column was appended by this tool.
        var priorNote = cellStr(session.map.aoa, row.rowIdx, session.map.note);
        return woFetch(row.key)
          .then(function (data) {
            var h = data.header;
            // Deterministic flags first, written straight to the sheet - they need no AI, so they
            // survive even if the summarize below fails (credits/throttle). A header miss -> [].
            var flags = computeFlags(h, data.notes, Date.now());
            if (session.map.flag > -1) {
              ws[XLSX.utils.encode_cell({ c: session.map.flag, r: row.rowIdx })] = { t: 's', v: flags.join(', ') };
            }
            var woFacts = {
              raw: row.key,
              number: row.key,
              status: (h && h.statusName) || cellStr(session.map.aoa, row.rowIdx, session.map.status),
              phase: h ? (h.phase || '') : '',
              priority: (h && h.priority && h.priority.label) || '',
              schedule: (h && h.nextOnsiteDate) || '',
              overdue: (h && typeof h.remainingDays === 'number' && h.remainingDays < 0) ? (Math.abs(h.remainingDays) + ' days past expected completion') : '',
              city: cellStr(session.map.aoa, row.rowIdx, session.map.city),
              state: cellStr(session.map.aoa, row.rowIdx, session.map.state),
              location: cellStr(session.map.aoa, row.rowIdx, session.map.location),
              days: cellStr(session.map.aoa, row.rowIdx, session.map.days),
              assignedTo: cellStr(session.map.aoa, row.rowIdx, session.map.assigned),
            };
            // priorAudit is read from the LIVE notes fetched this run, so a re-run sees a note this
            // tool already posted (idempotency for the post step below).
            var priorAudit = hasPriorAuditNote(data.notes);
            // The normalized operational state: deterministic, computed from the SAME live header
            // and notes, before any AI call. It grounds the prompt, backs the strict output check,
            // and is the fallback note's only input - so a row is never left without a usable note.
            var facts = deriveState(h, data.notes, Date.now());
            // THE evidence set, for the model and for the grounding check alike. Until 0.13.0 the
            // prompts were handed the RAW history, so this tool's own prior [bwn:wo-audit] post was
            // fed back as evidence - and, because ungroundedDates grounds against that same prompt,
            // a date this tool invented last cycle validated as a fact this cycle. deriveState has
            // always filtered; the prompts now use the SAME filtered list. hasPriorAuditNote above
            // still reads the raw notes, so posting idempotency is untouched.
            var evidenceNotes = meaningfulNotes(data.notes, Date.now());
            // Over-30 rows get the dated timeline note (full note history + trade + ECD); every other
            // row keeps the 1-3 sentence status note. Age is read from the workbook days column - or,
            // when there is no days column, the export is over-30 by construction so all rows qualify.
            var daysColAbsent = session.map.days === -1;
            var ageDays = daysColAbsent ? null : parseAgeDays(cellStr(session.map.aoa, row.rowIdx, session.map.days));
            var over30 = postEligible(ageDays, daysColAbsent);
            var review = [];
            if (data.matchReason) review.push(data.matchReason);
            if (!h) review.push('the live work order record could not be read this run - the note below rests on job notes alone');
            // RETENTION. A header miss with no usable notes leaves nothing that can be said
            // truthfully, and the deterministic note would then be a statement about the TOOL, not
            // the job - written over whatever the coordinator already had in the cell. Keep the
            // existing note, say why, and put the row in front of a human.
            if (!h && !evidenceNotes.length) {
              return {
                retained: true, note: priorNote, degraded: '', facts: facts, flags: flags,
                notesFound: data.notes.length, evidenceCount: 0, priorAudit: priorAudit,
                matchConfidence: data.matchConfidence,
                ageDays: ageDays, over30: over30, header: h, review: review
              };
            }
            var draftP = over30
              ? summarizeTimeline(woFacts, evidenceNotes, h, model, onWait, facts)
              : summarize(woFacts, evidenceNotes.slice(0, 5), model, onWait, facts);
            // An AI failure must not cost the row its note. The deterministic note is written
            // instead and the row is marked DEGRADED - visibly, and still retryable - so an outage
            // stays legible in the run summary rather than passing as a clean result.
            return draftP.catch(function (e) {
              // An over-30 row keeps its house format even without the model: the deterministic
              // chain goes through the SAME composeTimelineNote wrapper, so the note a coordinator
              // posts still reads "Over 30 - <trade> - ... - ECD ..." and never becomes a fourth
              // note shape the workbook convention has never carried.
              var fb = over30 ? composeTimelineNote(fallbackChain(facts), h, Date.now()) : composeAuditStatusNote(facts);
              return { note: fb, degraded: (e && e.message) || String(e) };
            }).then(function (out) {
              return {
                retained: false, note: out.note, degraded: out.degraded || '', facts: facts, flags: flags,
                notesFound: data.notes.length, evidenceCount: evidenceNotes.length,
                matchConfidence: data.matchConfidence,
                priorAudit: priorAudit, ageDays: ageDays, over30: over30, header: h, review: review
              };
            });
          })
          .then(function (out) {
            var h = out.header;
            // A RETAINED row is never written: the whole point is that the client's existing cell
            // survives untouched. Every other row writes the drafted note, dropping any formula.
            if (!out.retained) {
              ws[XLSX.utils.encode_cell({ c: session.map.note, r: row.rowIdx })] = { t: 's', v: out.note };
            }
            var reasons = (out.review || []).slice();
            if (out.retained) reasons.push('no live work order record and no usable job notes - the existing tracker note was kept rather than replaced with a statement about the read failure');
            // Post-step state (used only by the "Post drafted notes" section after the run): a row
            // is post-eligible when aged >30d, or when the workbook has no days column at all. Both
            // were already computed to pick the draft style above; reuse them, do not re-parse.
            // 0.13.0 adds the structured fields ADDITIVELY - auditTally still reads `.error` only
            // and pendingRows still reads `.error`/`.degraded`, so neither changes shape or meaning.
            session.results[origIdx] = {
              correlationId: RUN_ID + ':' + row.key,
              workOrderNumber: row.key,
              rowIndex: row.rowIdx,
              key: row.key, note: out.note, notesFound: out.notesFound,
              evidenceCount: out.evidenceCount,
              fetchStatus: h ? 'ok' : 'error',
              matchConfidence: out.matchConfidence || 'high',
              sourceStatusName: (h && h.statusName) || '',
              sourcePhase: (h && h.phase) || '',
              flags: out.flags || [],
              ageDays: out.ageDays, eligible: !!out.over30, priorAudit: !!out.priorAudit,
              degraded: out.degraded || '', facts: out.facts || null,
              noteMode: out.retained ? 'retained' : (out.degraded ? 'deterministic_fallback' : 'ai'),
              priorNote: priorNote,
              proposedNote: out.retained ? '' : out.note,
              finalNote: out.note,
              noteValidation: { valid: !out.degraded, reasons: out.degraded ? [out.degraded] : [] },
              reviewRequired: !!reasons.length,
              reviewReasons: reasons,
              changed: !out.retained && String(out.note || '') !== String(priorNote || ''),
              postEligible: false, postIneligibleReason: null,
              error: null
            };
            logln('  WO ' + row.key + ' (' + out.notesFound + ' notes, ' + out.evidenceCount + ' usable)' +
              (out.retained ? ' [RETAINED - existing note kept]' : '') +
              (out.degraded ? ' [deterministic note - ' + out.degraded + ']' : '') + ': ' +
              (out.note ? out.note.slice(0, 90) : '(cell left as-is)'));
            return session.results[origIdx];
          })
          .catch(function (e) {
            session.results[origIdx] = {
              correlationId: RUN_ID + ':' + row.key, workOrderNumber: row.key, rowIndex: row.rowIdx,
              key: row.key, fetchStatus: 'error', matchConfidence: 'low',
              noteMode: 'skipped', priorNote: priorNote, finalNote: priorNote, changed: false,
              reviewRequired: true, reviewReasons: [(e && e.message) || String(e)],
              postEligible: false, postIneligibleReason: 'the work order could not be read this run',
              error: (e && e.message) || String(e)
            };
            logln('  ! WO ' + row.key + ': ' + session.results[origIdx].error);
            throw e;   // marks the pool slot as errored too
          });
      }, conc, function (done, total) { prog.textContent = 'Progress: ' + done + ' / ' + total; },
        function () { return _cancelled; })
        .then(function () {
          _running = false;
          var fi = $('bwn-woaudit-file'); if (fi) fi.disabled = false;
          var sh = $('bwn-woaudit-sheet'); if (sh) sh.disabled = false;
          var tal = auditTally(session.results, session.rows.length);
          logln((_cancelled ? 'Cancelled. ' : 'Done. ') + tal.ok + ' written, ' + tal.errs + ' failed' +
            (tal.skipped ? ', ' + tal.skipped + ' never audited' : '') + '.');
          // Guidance belongs HERE, once, not appended to every failing row: mid-run a reader
          // cannot evaluate "if every row failed", and 40 copies scroll the results out of the
          // 240px log box. This line is the actual decision point.
          // Guidance is derived from what the rows ACTUALLY reported, not from the fact that they
          // all failed. The old all-failed branch reprinted the key/role diagnosis that this
          // release exists to kill: when a whole batch throttles, ok is 0 and the last line the
          // coordinator reads told them to re-enter a key that was never the problem.
          // A DEGRADED row wrote a deterministic note, so it is not an error - but its cause is the
          // same outage an errored row would have reported. Counting only `.error` here is how a
          // full credit exhaustion could read as "Done. 216 written, 0 failed." and hide both the
          // billing diagnosis and the Retry button. The causes ladder reads BOTH.
          var degraded = 0;
          for (var di = 0; di < session.rows.length; di++) {
            if (session.results[di] && session.results[di].degraded) degraded++;
          }
          if (degraded) {
            logln('! ' + degraded + ' row' + (degraded === 1 ? '' : 's') +
              ' fell back to the deterministic audit note (the AI did not supply a usable one). Those cells ARE written and are safe to send; press Retry Unfinished to re-draft them once the cause below clears.');
          }
          if (tal.errs || degraded) {
            var causes = [];
            for (var ci = 0; ci < session.rows.length; ci++) {
              var rr = session.results[ci];
              if (rr && (rr.error || rr.degraded)) causes.push(String(rr.error || rr.degraded));
            }
            var anyCredits = causes.some(function (c) { return /out of credits/i.test(c); });
            var allThrottle = causes.length && causes.every(function (c) { return /rate limited|was busy/i.test(c); });
            var anyAuth = causes.some(function (c) { return /ingest key|rank not resolved|session expired/i.test(c); });
            if (anyCredits) {
              logln('The AI account is out of credits. A retry will NOT help until Anthropic billing is topped up - do that first, then press Retry Unfinished. (This is the failure that stopped the batch, not a rate limit.)');
            } else if (allThrottle) {
              logln('Every failure was the AI service rate limiting this batch. Nothing is misconfigured - wait a minute and press Retry Unfinished.');
            } else if (anyAuth) {
              logln('At least one row failed on access. Check the SWA ingest key (Tampermonkey menu) and that you are signed into Umbrava with a resolved role - run the BWN Ops Suite alongside this.');
            } else {
              logln('Some rows failed. The causes are listed above; rate limits clear on their own, so Retry Unfinished usually finishes them.');
            }
          }
          // The cancel path's own warning. A skipped row produced no log line at all while it was
          // being skipped, so without this the only trace it existed is the row count.
          if (tal.skipped) {
            logln('! ' + tal.skipped + ' row' + (tal.skipped === 1 ? '' : 's') +
              ' stopped before being audited. ' + UNWRITTEN_NOTE + ' Press Retry Unfinished to complete them.');
          }
          // Null-safe: the drawer can be gone if it was dismissed before the guard existed, or
          // rebuilt mid-run. Losing the buttons must not kill the results.
          var sb = $('bwn-woaudit-start'); if (sb) sb.disabled = false;
          var cb = $('bwn-woaudit-cancel'); if (cb) cb.style.display = 'none';
          var db = $('bwn-woaudit-dl'); if (db) db.style.display = 'inline-block';
          // Degraded rows are in pendingRows, so the button that re-drafts them has to be REACHABLE.
          if (tal.errs || tal.skipped || degraded) { var rb = $('bwn-woaudit-retry'); if (rb) rb.style.display = 'inline-block'; }
          // Persist the completeness state outside the scrolling log, where it survives the
          // coordinator being pulled away between finishing a run and pressing Download.
          setWarn(tal.errs + tal.skipped
            ? 'This workbook is INCOMPLETE: ' + owedPhrase(tal) + ' of ' + session.rows.length + '. ' + UNWRITTEN_NOTE + ' Press Retry Unfinished before sending it.'
            : '');
          // Retained rows wrote nothing, on purpose. They are NOT errors and NOT skips - the row
          // was audited, nothing safe could be said, and the coordinator's own note was kept - so
          // they must be named explicitly or a silent no-write looks like a silent success.
          var retained = 0, reviewN = 0;
          for (var ri = 0; ri < session.rows.length; ri++) {
            var rrr = session.results[ri];
            if (!rrr) continue;
            if (rrr.noteMode === 'retained') retained++;
            if (rrr.reviewRequired) reviewN++;
          }
          if (retained) {
            logln('! ' + retained + ' row' + (retained === 1 ? '' : 's') +
              ' KEPT the workbook\'s existing note: the live work order could not be read and there were no usable job notes, so nothing could be said truthfully. Nothing was overwritten. Review those rows below.');
          }
          if (reviewN) {
            logln('! ' + reviewN + ' row' + (reviewN === 1 ? '' : 's') + ' need a human look - see "Run diagnostics" below.');
          }
          // Reveal the per-note post buttons for the rows that drafted a note this run.
          renderDiagnostics();
          renderPostSection();
        });
    }

    // Run diagnostics: the two things a run knows that nothing else surfaces - live statuses that
    // WOA_PHASE does not carry, and rows a human should look at. Read-only, in-memory, copyable.
    // An unmapped status is not a failure; it is the measurement the table has never had, and the
    // rows carrying it already degraded safely (stage printed verbatim, confidence low).
    function renderDiagnostics() {
      var host = $('bwn-woaudit-diag');
      if (!host) return;
      host.innerHTML = '';
      if (!session) return;
      var cov = statusCoverage(session.results);
      var reviews = [];
      for (var i = 0; i < session.rows.length; i++) {
        var r = session.results[i];
        if (r && r.reviewRequired) reviews.push(r);
      }
      if (!cov.unmapped.length && !reviews.length) return;
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:14px;border-top:1px solid #e0e6e2;padding-top:12px';
      var h = document.createElement('div');
      h.style.cssText = 'font-weight:600;margin-bottom:6px;color:' + GREEN;
      h.textContent = 'Run diagnostics';
      wrap.appendChild(h);
      var lines = [];
      if (cov.unmapped.length) {
        var box = document.createElement('div');
        box.style.cssText = 'font-size:12px;color:#8a4b00;background:#fff4e5;border:1px solid #ffcf99;border-radius:6px;padding:7px 9px;margin-bottom:8px;line-height:1.5';
        box.textContent = 'Umbrava status names this build does not map (' + cov.unmapped.length + '): ' +
          cov.unmapped.map(function (o) { return '"' + o.status + '" x' + o.count; }).join(', ') +
          '. Those rows printed the status verbatim at low confidence rather than being mapped to a guessed stage. Nothing was changed automatically.';
        wrap.appendChild(box);
        lines.push('UNMAPPED STATUSES (' + cov.unmapped.length + ' of ' + cov.observed.length + ' seen):');
        cov.unmapped.forEach(function (o) { lines.push('  ' + o.status + '\tx' + o.count); });
      }
      if (reviews.length) {
        var rb = document.createElement('div');
        rb.style.cssText = 'font-size:12px;color:#444;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:6px;padding:7px 9px;margin-bottom:8px;line-height:1.5';
        rb.textContent = reviews.length + ' row' + (reviews.length === 1 ? '' : 's') + ' need review: ' +
          reviews.slice(0, 12).map(function (r) { return 'WO ' + r.key; }).join(', ') +
          (reviews.length > 12 ? ', ...' : '') + '. Reasons are in the copy below and on each card.';
        wrap.appendChild(rb);
        lines.push('', 'REVIEW REQUIRED (' + reviews.length + '):');
        reviews.forEach(function (r) {
          lines.push('  WO ' + r.key + '\t' + (r.noteMode || '') + '\t' + (r.sourceStatusName || '(status unread)'));
          (r.reviewReasons || []).forEach(function (x) { lines.push('    - ' + x); });
        });
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Copy diagnostics';
      btn.style.cssText = 'background:#fff;color:' + GREEN + ';border:1px solid ' + GREEN + ';padding:6px 12px;border-radius:8px;font-weight:600;cursor:pointer';
      var payload = ['WO Audit ' + VER + ' run diagnostics', 'run: ' + (session.results[0] && session.results[0].correlationId ? String(session.results[0].correlationId).split(':')[0] : '(n/a)'), ''].concat(lines).join('\n');
      btn.onclick = function () {
        // Clipboard API is not available on every surface this drawer opens on, so fall back to a
        // selected textarea rather than silently doing nothing.
        function fallback() {
          try {
            var ta = document.createElement('textarea');
            ta.value = payload; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
            btn.textContent = 'Copied';
          } catch (e) { btn.textContent = 'Copy failed - see the log'; logln(payload); }
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(payload).then(function () { btn.textContent = 'Copied'; }, fallback);
          } else fallback();
        } catch (e) { fallback(); }
      };
      wrap.appendChild(btn);
      host.appendChild(wrap);
    }

    // Renders the "Post drafted notes to work orders" section from session.results. One Post button
    // per row that drafted a non-empty note. The button is shown+enabled ONLY when the row is aged
    // >30d (or the workbook has no days column), has no prior WO-audit note, and has not been posted
    // this session. Each button posts exactly ONE note on an explicit human click - there is
    // deliberately NO bulk / auto "post all".
    // The ordered posting gate, as the operator sees it. The two global blocks come first because
    // they make every row unpostable and a per-row reason would be misleading. Mirrors what
    // bwnGqlOp enforces; it does NOT replace it.
    function postBlockReason(r) {
      if (BWN_MODULES.woAuditNotes === false) return 'note posting is switched off for this suite (kill switch)';
      if (!bwnCan('WorkOrderNote.AddNew')) return 'your Umbrava permissions do not include WorkOrderNote.AddNew';
      if (r.error) return 'the work order could not be read this run';
      if (r.noteMode === 'retained') return 'no note was drafted - the workbook\'s existing note was retained';
      if (!r.note) return 'no note was drafted for this row';
      if (!r.eligible) return 'not aged over 30 days';
      if (r.priorAudit) return 'this work order already carries a ' + AUDIT_MARKER + ' note';
      return null;
    }

    function renderPostSection() {
      var host = $('bwn-woaudit-post');
      if (!host) return;
      host.innerHTML = '';
      if (!session) return;
      var rows = [];
      for (var i = 0; i < session.rows.length; i++) {
        var r = session.results[i];
        // Retained and review-required rows belong on this list too: they are exactly the rows a
        // human has to look at, and dropping them for having no drafted note is what made a
        // deliberate no-write indistinguishable from a row that was never processed.
        if (r && !r.error && (r.note || r.noteMode === 'retained' || r.reviewRequired)) rows.push(r);
      }
      if (!rows.length) return;
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:14px;border-top:1px solid #e0e6e2;padding-top:12px';
      var h = document.createElement('div');
      h.style.cssText = 'font-weight:600;margin-bottom:4px;color:' + GREEN;
      h.textContent = 'Post drafted notes to work orders';
      wrap.appendChild(h);
      var sub = document.createElement('div');
      sub.style.cssText = 'font-size:12px;color:#555;margin-bottom:10px';
      sub.textContent = 'Posts the drafted note as an INTERNAL note on the work order. One click per note - jobs aged over 30 days only.';
      wrap.appendChild(sub);
      // If there is no days column, every row is eligible by construction - surface that once.
      if (session.map.days === -1) {
        var notice = document.createElement('div');
        notice.style.cssText = 'font-size:12px;color:#8a4b00;background:#fff4e5;border:1px solid #ffcf99;border-radius:6px;padding:6px 8px;margin-bottom:10px';
        notice.textContent = 'No days/aged column detected - treating every row as aged >30d (this export is over-30 by construction).';
        wrap.appendChild(notice);
      }
      rows.forEach(function (r) {
        var card = document.createElement('div');
        card.style.cssText = 'border:1px solid #e0e6e2;border-radius:8px;padding:10px;margin-bottom:8px';
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px';
        var label = document.createElement('div');
        label.style.cssText = 'font-weight:600';
        label.textContent = 'WO ' + r.key + '  -  ' + (r.ageDays == null ? 'age n/a' : (r.ageDays + 'd'));
        head.appendChild(label);
        var status = document.createElement('span');
        status.style.cssText = 'font-size:12px;color:#555';
        head.appendChild(status);
        card.appendChild(head);
        // The derived reading, shown BEFORE the post button: an operator should be able to see the
        // stage, the blocker and who owns it without reading the whole note back out of the box.
        if (r.facts) {
          var fx = document.createElement('div');
          fx.style.cssText = 'font-size:11.5px;color:#41613f;background:#f2f7f3;border:1px solid #dbe7dd;border-radius:6px;padding:5px 7px;margin-bottom:6px;line-height:1.45';
          var bits = [r.facts.currentStage];
          if (r.facts.primaryBlocker && r.facts.confidence !== 'low') {
            bits.push(r.facts.primaryBlocker + (r.facts.blockerOwner && r.facts.blockerOwner !== 'Unknown' ? ' (' + r.facts.blockerOwner + ')' : ''));
          }
          bits.push('ECD ' + (r.facts.ecdText || 'TBD'));
          fx.textContent = bits.join('  |  ') + '   [' + (r.facts.confidence || 'low') + ' confidence, ' + (r.facts.noteCount || 0) + ' usable notes]';
          card.appendChild(fx);
        }
        // The operational line: what the audit found, and what it did with the cell. Flags are the
        // deterministic exception signals (NOT narrative - they never enter the note), so they are
        // shown as their own row rather than folded into the derived reading above.
        var meta = document.createElement('div');
        meta.style.cssText = 'font-size:11.5px;color:#555;margin-bottom:6px;line-height:1.45';
        var metaBits = [
          'note: ' + (r.noteMode === 'ai' ? 'AI-drafted' : r.noteMode === 'deterministic_fallback' ? 'deterministic fallback' : r.noteMode === 'retained' ? 'RETAINED (workbook note kept)' : String(r.noteMode || '-')),
          (r.changed ? 'workbook cell CHANGED' : 'workbook cell unchanged'),
          'status: ' + (r.sourceStatusName || '(unread)')
        ];
        if (r.matchConfidence && r.matchConfidence !== 'high') metaBits.push('match confidence: ' + r.matchConfidence);
        meta.textContent = metaBits.join('  |  ') + ((r.flags && r.flags.length) ? ('\nflags: ' + r.flags.join(', ')) : '\nflags: none');
        meta.style.whiteSpace = 'pre-line';
        card.appendChild(meta);
        if (r.reviewRequired && (r.reviewReasons || []).length) {
          var rv = document.createElement('div');
          rv.style.cssText = 'font-size:11.5px;color:#6b1d1d;background:#fdf1f1;border:1px solid #f0cccc;border-radius:6px;padding:5px 7px;margin-bottom:6px;line-height:1.45;white-space:pre-line';
          rv.textContent = 'Review required:\n- ' + r.reviewReasons.join('\n- ');
          card.appendChild(rv);
        }
        if (r.degraded) {
          var dg = document.createElement('div');
          dg.style.cssText = 'font-size:11.5px;color:#8a4b00;background:#fff4e5;border:1px solid #ffcf99;border-radius:6px;padding:5px 7px;margin-bottom:6px';
          dg.textContent = 'Deterministic note (no AI phrasing): ' + r.degraded;
          card.appendChild(dg);
        }
        var ta = document.createElement('textarea');
        ta.readOnly = true;
        ta.value = r.note;
        ta.style.cssText = 'width:100%;box-sizing:border-box;min-height:56px;font:12px ' + FONT + ';border:1px solid #e0e6e2;border-radius:6px;padding:6px;resize:vertical;background:#fafbfa';
        card.appendChild(ta);
        // ONE ordered answer to "can this be posted, and if not why not", so the operator reads the
        // reason on the card instead of discovering it from a failed click. Display only: bwnGqlOp
        // remains the enforcement point for the kill switch and the Umbrava permission, and nothing
        // here can widen what it allows.
        var block = postBlockReason(r);
        r.postIneligibleReason = block;
        r.postEligible = !block && !r.posted;
        if (r.posted) {
          status.textContent = 'posted ✓';
        } else if (block) {
          status.textContent = 'cannot post - ' + block;
        } else {
          var btn = document.createElement('button');
          btn.textContent = 'Post';
          btn.style.cssText = 'margin-top:8px;background:' + GREEN + ';color:#fff;border:0;padding:7px 14px;border-radius:8px;font-weight:600;cursor:pointer';
          btn.onclick = function () {
            btn.disabled = true;
            status.textContent = 'posting...';
            postAuditNote(r.key, r.note).then(function () {
              r.posted = true;
              status.textContent = 'posted ✓';
              try { btn.remove(); } catch (e) { }
              logln('  posted WO-audit note on WO ' + r.key);
            }, function (e) {
              var msg = (e && e.message) || String(e);
              status.textContent = 'failed: ' + msg;
              btn.disabled = false;   // re-enable so the coordinator can retry this one note
              logln('  ! post failed for WO ' + r.key + ': ' + msg);
            });
          };
          card.appendChild(btn);
        }
        wrap.appendChild(card);
      });
      host.appendChild(wrap);
    }

    function downloadResult() {
      if (!session) return;
      // The workbook is what reaches the client, so the warning fires HERE too, not only in the
      // run summary a coordinator may have scrolled past in a 240px log box.
      var tal = auditTally(session.results, session.rows.length);
      var owed = tal.errs + tal.skipped;
      if (owed) {
        logln('! Downloading with ' + owedPhrase(tal) + ' of ' + session.rows.length + '. ' + UNWRITTEN_NOTE);
        // A blocking acknowledgement, because everything softer has already failed here: the
        // warning used to be one monospace line in a scrolling box, and the moment Download is
        // pressed the browser takes focus and the file is on disk. This is the last point at
        // which an incomplete workbook can still be stopped from reaching a client.
        var proceed = true;
        try {
          proceed = window.confirm(
            'This audit is INCOMPLETE.\n\n' + owedPhrase(tal) + ' of ' + session.rows.length + '.\n\n' +
            UNWRITTEN_NOTE + '\n\nDownload it anyway?');
        } catch (e) { proceed = true; }   // a page that breaks confirm must not trap the workbook
        if (!proceed) { logln('Download cancelled. Press Retry Unfinished to complete the batch.'); return; }
      }
      // The filename is the only part of this that survives into Downloads, an email, and the
      // client's inbox. A partial export must not arrive under the same name as a complete one.
      var fname = session.name + (owed ? '-audited-INCOMPLETE-' + owed + '-unwritten' : '-audited') + '.xlsx';
      try {
        var out = XLSX.write(session.wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
        var blob = new Blob([out], { type: XLSX_MIME });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        // The toast is a success signal; it must not read as one for a partial export.
        toast(owed ? ('Downloaded INCOMPLETE ' + fname) : ('Downloaded ' + fname));
      } catch (err) { logln('! Download failed: ' + ((err && err.message) || err)); }
    }
  }

  // ---- SWA ingest key presence beacon ---------------------------------------
  // GM storage is scoped PER SCRIPT, not per @namespace (measured 2026-09-03 on TM 5.x): this
  // script's ingest_key is its own private copy, invisible to every sibling, which is exactly
  // why a blank one fails silently. Publish a BOOLEAN - never the key - so Core's Ops panel can
  // name the scripts that are still blank. ts is the LOAD time and is deliberately NOT refreshed
  // on save: Core's "loaded this session" handshake compares it to Core's own load stamp, so a
  // fresh Date.now() on save would make this script read as stale the moment the key was set.
  var INGEST_BEACON_TS = Date.now();
  function publishIngestPresence() {
    try {
      localStorage.setItem('bwn:ingest:wo-audit', JSON.stringify({ k: getKey() ? 1 : 0, ts: INGEST_BEACON_TS }));
    } catch (e) { /* best-effort */ }
  }
  publishIngestPresence();

  // ---- Launchers ----
  try {
    GM_registerMenuCommand('BWN WO Audit: open', buildModal);
    GM_registerMenuCommand('BWN WO Audit: Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY). Tampermonkey scopes this PER SCRIPT, so setting it here sets it for WO Audit only - every other suite script needs its own copy:', getKey() || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); publishIngestPresence(); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { /* menu API absent - floating button still works */ }

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // bwn-suite-core's Launcher hosts the shared dock ([[bwn-launcher-dock]]); we
  // register one entry ('wo-audit') instead of hand-placing a bottom-left button.
  // detail.key carries the entry id (detail.id is the bwn:evt event name). If no
  // host announces within a few seconds we fall back to the old floating button.
  var DOCK_KEY = 'wo-audit';
  var _hostSeen = false;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'WO Audit', icon: '📋', weight: 20,
        title: 'BWN WO Audit - batch status notes from an audit .xlsx'
      } }));
    } catch (e) { }
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail; if (!d) return;
      if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') {
        _hostSeen = true;
        dockRegister();
      }
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildModal();
      // Another tool took the drawer slot - close ours, UNLESS a batch is in flight (a run can
      // span minutes of rate-limit backoff, and evicting it would discard the written rows).
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY && !_running) {
        var o = document.getElementById('bwn-woaudit-ov'); if (o) drawerDismiss(o);
      }
    });
  } catch (e) { }

  // Register into the dock on load (covers a host already up); the host heartbeat
  // re-registers us later. No host means Core is off or failed to load - warn rather
  // than drawing a corner button; the dock tab is the only launcher this tool has.
  dockRegister();
  setTimeout(function () {
    if (!_hostSeen) console.warn('[BWN WO AUDIT] no dock host - install/enable BWN Suite Core to reach WO Audit.');
  }, 4000);
})();
