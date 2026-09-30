// ==UserScript==
// @name         BWN WO Audit (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.18.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-audit.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-audit.user.js
// @description  Batch WO-audit tool. Upload a WO audit .xlsx; for each work order this reads its two most recent notes DIRECTLY from Umbrava's GraphQL API in-page (using your live Umbrava session - the same read the BWN Ops Suite AI drafts use), then asks the broadway-internal-ops SWA summarize route (x-bwn-key gated, Anthropic key server-side) to write a status note - for jobs aged over 30 days a dated "Over 30 - trade - event timeline - ECD" chain built from the WO's FULL note history (with a PAST/needs-ECD flag when the committed date has lapsed), otherwise a 1-3 sentence client-ready status note. Fills the audit's notes column and downloads the workbook, preserving every other cell and formula. It also reads each WO's live header (status, phase, priority, GP, DNE/NTE, PO/vendor, schedule) in the same call and writes a deterministic Audit Flags column (OVERDUE, NEG/LOW GP, NTE>DNE, NO VENDOR, UNSCHEDULED, STALE) computed with no AI - so the exception audit survives an AI outage. Runs entirely in the app.umbrava.com page so it inherits your Umbrava auth - no MCP, no pasted keys, nothing sensitive in this script. This replaces the old standalone WO_Audit_Automation.html SWA tool, whose server-side MCP path could not authenticate to Umbrava. After a run drafts its notes, the coordinator can post each drafted note as an INTERNAL Umbrava note onto its aged (>30d) work order - one explicit click per note (human-gated, idempotent), routed through the governed bwnGqlOp write path with its permission gate and audit trail. 0.17.0 adds an Operations Action List layer on top of the existing deterministic pipeline: three output modes (Detailed WO Audit / Operations Action List / Hybrid, default), a rules-based action engine that turns each WO into a prioritized (P0/P1/P2/Monitor) manager action with bucket, internal owner, external escalation, an operational-target due label, short risk flags, evidence and rule IDs, 16 structured audit columns appended to the source sheet, and a separate "WO Action List - YYYY.MM.DD" worksheet of the actionable rows - all deterministic, no AI opinions, source data never overwritten. 0.18.0 redesigns the Action List into an operational WORK QUEUE: two separate scores (Operational Risk vs Actionability), six queues (Immediate Intervention / Execute Today / Follow Up Today / Upcoming Watch / Blocked-Waiting / Closeout-Billing) plus an Action Undefined / Needs Triage exception, an explainable P0-P3 priority, a transparent Daily Rank (actionability first, risk second, age last), a valid-waiting-state test, meaningful-update / ECD / onsite-expected gating, and structured contradiction detection. The Action List worksheet is now grouped by queue with per-section counts; a flat filterable "Action Diagnostics" sheet carries the score components and evidence; the legacy audit/bucket columns and Dashboard/Rules sheets are preserved as the management layer.
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

  var VER = '0.18.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  // Inline SVG icons (no external image/font). 18px, stroke=currentColor so they take card color.
  function _svg(p, o) { return '<svg class="woa-i" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (o || '') + '>' + p + '</svg>'; }
  var ICON = {
    upload: _svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>'),
    file: _svg('<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4"/>'),
    settings: _svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M16.9 16.9l2.1 2.1M19.1 4.9l-2.1 2.1M7.1 16.9l-2.1 2.1"/>'),
    info: _svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    check: _svg('<path d="M20 6L9 17l-5-5"/>'),
    warn: _svg('<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
    activity: _svg('<path d="M22 12h-4l-3 8-6-16-3 8H2"/>'),
    download: _svg('<path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>'),
    close: _svg('<path d="M18 6L6 18M6 6l12 12"/>'),
    stop: _svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    play: _svg('<path d="M7 5l12 7-12 7z"/>'),
    pause: _svg('<path d="M9 5v14M15 5v14"/>'),
    copy: _svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    trash: _svg('<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>'),
    reset: _svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>')
  };

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
  // Model is chosen SERVER-SIDE: api/ai's pickModel reads BWN_AI_MODEL (else its own default).
  // A client dropdown of model ids drifts every Anthropic release and forced a @version bump +
  // reinstall to fix a stale label; the server env is the one place that changes with no redeploy.
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  console.info('[BWN WO AUDIT] v' + VER + ' - in-page GraphQL header+notes read -> deterministic Audit Flags + bwnAI /api/ai status note -> filled .xlsx download; can then post each drafted note as an INTERNAL note onto its aged (>30d) work order, one click per note (governed bwnGqlOp write path); registers into the shared dock (bwn:dock:*); 0.18.0 adds the operational work-queue Action List (two scores, six queues, P0-P3, daily rank, contradictions)');

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

  // ===== BWN AUDIT CHECKS START (pure; sliced by scripts/test-wo-audit-checks.js) ==============
  // Redesign-added, deliberately OUTSIDE the FLAGS block above so computeFlags stays byte-stable
  // for test-wo-audit-flags.js. Both functions are pure and add NO fetch, NO AI, and NO cost - the
  // cancellation scan runs over the notes already read in-page; the gate just filters computeFlags
  // output by the operator's enabled checks.
  //
  // Cancellation / no-service language: emits a single 'CANCEL?' review prompt when a recent note
  // reads like a cancellation, no-access, or no-service visit. It NEVER asserts the WO was
  // cancelled - it flags a human-review candidate. Only the newest few notes are scanned; an older
  // cancel is usually already resolved by a later note.
  var WOA_CANCEL_RE = /\b(cancel(?:led|ling|lation|ed)?|no[\s-]?access|no[\s-]?show|unable to (?:access|complete|service|enter)|could not (?:access|complete|gain access)|site (?:closed|not ready|inaccessible)|customer (?:refused|declined|not ready)|rescheduled? indefinitely|do not (?:service|dispatch))\b/i;
  function cancelScan(notes) {
    if (!notes || !notes.length) return false;
    for (var i = 0; i < Math.min(4, notes.length); i++) {
      var n = notes[i] || {};
      var body = _stripHtml(n.content || n.contentHtml || '');
      if (WOA_CANCEL_RE.test(body)) return true;
    }
    return false;
  }
  // Map one computeFlags() string to the audit-check category that gates it. An unrecognized flag
  // returns null and is ALWAYS kept - an unknown-category bug must never silently drop a real flag.
  function flagCatKey(flag) {
    if (/^OVERDUE|^STALE/.test(flag)) return 'aged';
    if (/^NO NOTES/.test(flag)) return 'notes';
    if (/^(NEG GP|LOW GP|NTE>DNE)/.test(flag)) return 'pricing';
    if (/^NO VENDOR/.test(flag)) return 'vendor';
    if (/^UNSCHEDULED/.test(flag)) return 'scheduling';
    if (/^CLIENT UPDATE|^NO CLIENT NOTE/.test(flag)) return 'clientUpdate';
    return null;
  }
  // Client-update overdue check. A note is client-facing when its numeric `type` maps to a
  // bwn:noteTypes NAME containing "client" - the same "Client" note type the suite's Client Update
  // draft and the Next-Actions "client update due" cadence key on. The set is resolved live from
  // Core's cache; when Core is not loaded (or the node harness has no localStorage) the set is null
  // and the check NO-OPS rather than guessing a type id.
  function clientTypeIdSet(typeMap) {
    var out = null;
    if (typeMap) { for (var id in typeMap) { if (/client/i.test(String(typeMap[id]))) { if (!out) out = {}; out[String(id)] = 1; } } }
    return out;
  }
  // '' when the client has been updated within the threshold (or the set is unknown); else a flag.
  // `nowMs` injected (harness clock). Default threshold 2 days. A WO with NO client-typed note is
  // flagged NO CLIENT NOTE only once it has ANY activity older than the threshold, so a brand-new WO
  // is not flagged for an update it does not yet owe (and NO NOTES already covers a note-less WO).
  function clientUpdateFlag(notes, clientSet, thresholdDays, nowMs) {
    if (!notes || !notes.length || !clientSet) return '';
    var thr = (typeof thresholdDays === 'number' && isFinite(thresholdDays) && thresholdDays >= 0) ? thresholdDays : 2;
    var newestClient = null, newestAny = null;
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i] || {}; var d = _date(n.createdDate); if (!d) continue; var t = +d;
      if (newestAny === null || t > newestAny) newestAny = t;
      if (clientSet[String(n.type)] && (newestClient === null || t > newestClient)) newestClient = t;
    }
    if (newestClient !== null) {
      var ca = Math.floor((nowMs - newestClient) / MS_DAY);
      return ca > thr ? ('CLIENT UPDATE ' + ca + 'd') : '';
    }
    if (newestAny !== null && Math.floor((nowMs - newestAny) / MS_DAY) > thr) return 'NO CLIENT NOTE';
    return '';
  }
  // The operator-facing checks. 'repeat' (repeat-dispatch detection) has no data source yet - trip
  // history is not fetched - so it is disabled in the UI and never appears here.
  var WOA_CHECKS = ['aged', 'notes', 'pricing', 'vendor', 'scheduling', 'cancel', 'clientUpdate'];
  function woaDefaultChecks() {
    var c = {}; for (var i = 0; i < WOA_CHECKS.length; i++) c[WOA_CHECKS[i]] = true; c.repeat = false; return c;
  }
  // Filter deterministic header flags by the enabled categories, then append the note-scan flags:
  // 'CANCEL?' (cancel check) and the client-update flag (clientUpdate check, needs ctx.clientSet +
  // ctx.clientDays + ctx.nowMs from the run). A MISSING cfg key defaults to enabled, so a
  // partial/empty cfg reproduces the full flag output (the safe default).
  function applyChecks(headerFlags, notes, cfg, ctx) {
    cfg = cfg || {};
    var on = function (k) { return cfg[k] !== false; };
    var out = (headerFlags || []).filter(function (fl) { var c = flagCatKey(fl); return c === null || on(c); });
    if (on('cancel') && cancelScan(notes)) out.push('CANCEL?');
    if (on('clientUpdate') && ctx && ctx.clientSet) {
      var cf = clientUpdateFlag(notes, ctx.clientSet, ctx.clientDays, ctx.nowMs);
      if (cf) out.push(cf);
    }
    return out;
  }
  // ===== BWN AUDIT CHECKS END ==================================================================

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
  // The {id:name} note-type map from Core's cache, or null. Feeds clientTypeIdSet (client-update check).
  function bwnNoteTypeMap() { try { var c = JSON.parse(noteTypesRaw() || 'null'); return (c && c.map) || null; } catch (e) { return null; } }
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

  // ===== BWN WO-AUDIT ACTIONS START (pure; sliced by scripts/test-wo-audit-actions.js) ============
  // The Operations Action List layer (0.17.0). A DETERMINISTIC post-processing pass over deriveState's
  // fact set plus the deterministic flags (computeFlags/applyChecks). It assigns one management action
  // bucket, a P0/P1/P2/Monitor priority, an internal action owner + an external escalation target, an
  // operational-target due LABEL, short pipe-delimited risk flags, a recommended next step, evidence,
  // confidence and the rule IDs that fired. No AI, no network, no DOM: it only RE-READS what
  // deriveState already established, so it can never invent a stage, owner, date or blocker the
  // deterministic layer did not ([[worst-reading-of-a-gap-is-invention]]).
  //
  // Action Due is a LABEL, never a calendar date. There is no business-day calendar in this tool, so
  // manufacturing "2026-09-24" would be a commitment nobody made; the labels ARE the operational
  // targets the spec asked for.
  //
  // nowMs / ecdDueSoon / visitPast / hasFutureOnsite are INJECTED by the caller (which owns the dates)
  // so this stays pure and the harness asserts on a fixed clock ([[headless-harness-cannot-time]]).

  var ACT_BUCKET = {
    OVERDUE_ECD: 'Overdue ECD', VENDOR_SCHEDULING: 'Vendor Scheduling', CLIENT_APPROVAL: 'Client Approval',
    PO_RELEASE: 'PO Release', MATERIAL: 'Material Delay', PROPOSAL: 'Vendor Quote / Proposal',
    COMPLETION: 'Completion Verification', CLOSEOUT: 'Closeout / Cost Review', STALE: 'Stale Update',
    DATA_QUALITY: 'Data Quality', MONITOR: 'Monitor'
  };
  // The en dash in the priority labels is intentional and matches the operator-facing spec exactly;
  // it is a display string only (sorted by ACT_PRIORITY_RANK, never by the text).
  var ACT_PRIORITY = { P0: 'P0 – Immediate', P1: 'P1 – Today', P2: 'P2 – This Week', MON: 'Monitor' };
  var ACT_PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, MON: 3 };
  var ACT_DUE_RANK = { 'Today': 0, 'Next business day': 1, 'Next 2 business days': 2, 'This week': 3, 'Monitor / no action due': 4 };

  // ==============================================================================================
  // WORK-QUEUE MODEL (0.18.0). A deterministic layer ON TOP OF the legacy bucket/priority audit
  // above - it never rewrites those fields (the audit/exception layer stays available for
  // management), it ADDS an operational work-queue view that answers, per WO: what to do today,
  // why it matters today, who owes the next move, and what result removes it from the list.
  //
  // Two SEPARATE scores drive it, never one black box:
  //   operationalRiskScore  - how exposed the WO is if it is not managed (0-100)
  //   actionabilityScore    - whether Broadway can take a concrete step TODAY (0-100)
  // The daily rank ranks ACTIONABILITY first, operational risk second, urgency/age last; a valid
  // documented waiting state subtracts hard so a properly-parked WO stops crowding today's queue.
  // ==============================================================================================
  var ACT_QUEUE = {
    IMMEDIATE: 'Immediate Intervention', EXECUTE: 'Execute Today', FOLLOWUP: 'Follow Up Today',
    CLOSEOUT: 'Closeout / Billing Readiness', WATCH: 'Upcoming Watch', BLOCKED: 'Blocked / Waiting',
    UNDEFINED: 'Action Undefined / Needs Triage'
  };
  // Spec classification order: the FIRST matching queue wins (Closeout before Execute so completed
  // field work is triaged as closeout, not re-dispatched).
  var ACT_QUEUE_ORDER = ['IMMEDIATE', 'CLOSEOUT', 'EXECUTE', 'FOLLOWUP', 'WATCH', 'BLOCKED', 'UNDEFINED'];
  // Worksheet reading order: today-work + triage first and prominent, Blocked/Waiting quiet and last.
  var ACT_QUEUE_DISPLAY = ['IMMEDIATE', 'EXECUTE', 'FOLLOWUP', 'UNDEFINED', 'WATCH', 'CLOSEOUT', 'BLOCKED'];
  var ACT_QUEUE_DISPLAY_RANK = (function () { var m = {}; ACT_QUEUE_DISPLAY.forEach(function (k, i) { m[ACT_QUEUE[k]] = i; }); return m; })();
  // The new P0-P3 scheme (P3 = the old Monitor tier). Kept distinct from ACT_PRIORITY so the legacy
  // audit columns are unchanged while the queue view uses the spec's decision order.
  var QUEUE_PRIORITY = { P0: 'P0 – Intervene Now', P1: 'P1 – Complete Today', P2: 'P2 – Follow Up / Prepare', P3: 'P3 – Monitor' };
  var QUEUE_PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

  // Central config: every weight, window, threshold and status set lives here, not scattered through
  // the classifier. Weights are applied to 0-100 sub-scores; actionability is the largest contributor.
  var ACT_CFG = {
    weights: { actionability: 1.0, operationalRisk: 0.6, dueUrgency: 0.4, scheduleProximity: 0.2, escalationRisk: 0.25, dataQuality: 0.15, validWaiting: 0.9 },
    watchDays: 3,            // a confirmed visit / delivery this many business-ish days out = Upcoming Watch
    ecdRiskWindowDays: 3,    // ECD inside this window (not yet overdue) = a P2 preparation signal
    overdueManagerDays: 7,   // ECD overdue beyond this escalates
    p0RankFloor: 1000,       // Immediate Intervention pins above every numeric rank
    // A physical visit is the next required step - so a blank Next Onsite Date is a real gap.
    onsiteExpectedPhases: { schedule: 1, scheduled: 1, onsite: 1, inprogress: 1, recall: 1 },
    // A credible completion forecast is possible - so a blank ECD is a real gap.
    ecdExpectedPhases: { scheduled: 1, onsite: 1, inprogress: 1, materials: 1, 'materials-client': 1, 'proposal-approved': 1, confirmcomplete: 1, costreview: 1, recall: 1, client: 1 },
    // Phase -> the external party Broadway is legitimately waiting on (the recognized waiting-on party).
    waitingParty: { 'proposal-sent': 'Client', client: 'Client', 'materials-client': 'Client', materials: 'Vendor / Supplier', accept: 'Vendor', 'proposal-approved': 'PO / Finance Owner', onhold: 'Internal review' }
  };
  // A next-step Broadway itself owns (vs one that waits on an outside party). Used by actionability
  // and by Execute-Today classification. These are the deriveState owner labels for internal work.
  var ACT_INTERNAL_OWNERS = { Coordinator: 1, 'PO/Approval': 1, 'Scheduling/Access': 1 };

  // Bucket -> the spec rule ID it corresponds to (for the Audit Rule IDs column + the Audit Rules sheet).
  var ACT_RULE = {
    VENDOR_SCHEDULING: 'VENDOR_SCHEDULING', CLIENT_APPROVAL: 'CLIENT_APPROVAL', PO_RELEASE: 'PO_RELEASE',
    MATERIAL: 'MATERIALS', PROPOSAL: 'PROPOSAL_OR_QUOTE', COMPLETION: 'ON_SITE_OR_SCHEDULED_FOLLOWUP',
    CLOSEOUT: 'CLOSEOUT', OVERDUE_ECD: 'ECD_OVERDUE', STALE: 'STALE_UPDATE', DATA_QUALITY: 'DATA_QUALITY'
  };
  // deriveState phase -> the management bucket its blocker maps to. Progressing/terminal phases map to
  // null and are resolved from the overlays (overdue ECD / stale) or fall through to Monitor.
  var ACT_PHASE_BUCKET = {
    intake: 'VENDOR_SCHEDULING', schedule: 'VENDOR_SCHEDULING', accept: 'VENDOR_SCHEDULING', recall: 'VENDOR_SCHEDULING',
    proposal: 'PROPOSAL', 'proposal-sent': 'CLIENT_APPROVAL', 'proposal-approved': 'PO_RELEASE',
    materials: 'MATERIAL', 'materials-client': 'MATERIAL',
    scheduled: 'COMPLETION', onsite: 'COMPLETION', inprogress: 'COMPLETION',
    client: 'CLIENT_APPROVAL', onhold: null, confirmcomplete: 'CLOSEOUT', costreview: 'CLOSEOUT', terminal: null
  };
  // Controlled fallback text per bucket. Used for Primary Issue / Required Next Action / Recommended
  // Status ONLY where deriveState gave no grounded blocker/next-action of its own - the grounded value
  // is always preferred so the action stays specific to the actual work order.
  var ACT_TEMPLATE = {
    OVERDUE_ECD: { issue: 'Expected completion date is overdue with no documented completed resolution.', next: 'Review the current blocker, update the work order with a specific outcome, and reset the ECD to a defensible date.', rec: 'Reset ECD' },
    VENDOR_SCHEDULING: { issue: 'No confirmed on-site date on file for an open work order.', next: 'Obtain a confirmed on-site date, technician/crew commitment, and next update from the vendor; document all three on the work order.', rec: 'Confirm on-site date' },
    CLIENT_APPROVAL: { issue: 'Submitted proposal is awaiting a client decision.', next: 'Confirm the approval owner, decision status, and decision due date; update the work order with the approval outcome.', rec: 'Confirm client decision' },
    PO_RELEASE: { issue: 'Proposal approved but the vendor purchase order has not been released.', next: 'Confirm the purchase order is issued and released to the vendor; document PO status and vendor release confirmation.', rec: 'Issue / release PO' },
    MATERIAL: { issue: 'Parts or materials are not yet delivered.', next: 'Obtain the material delivery date, confirm site/vendor receipt, and secure the return-visit date after delivery.', rec: 'Confirm delivery + return visit' },
    PROPOSAL: { issue: 'Vendor quote is not yet converted into a client proposal.', next: 'Obtain the complete vendor quote, validate scope/cost, and submit or revise the client proposal.', rec: 'Obtain quote / submit proposal' },
    COMPLETION: { issue: 'Scheduled or on-site visit has passed with no completion outcome recorded.', next: 'Obtain the vendor completion report, confirm completed versus remaining scope, and update the work order status and ECD.', rec: 'Obtain completion report' },
    CLOSEOUT: { issue: 'Work reported complete but closeout / final cost review is outstanding.', next: 'Confirm final vendor cost, completion documentation, and billing/closure readiness; advance or close the work order.', rec: 'Confirm cost + close' },
    STALE: { issue: 'No meaningful status update within the configured threshold.', next: 'Post an outcome-based update stating the current blocker, responsible party, next commitment, and revised ECD if needed.', rec: 'Post current status update' },
    DATA_QUALITY: { issue: 'Work order data is missing or conflicting and cannot be reliably managed.', next: 'Correct the missing or conflicting workflow data before the work order can be reliably managed.', rec: 'Correct work order data' },
    MONITOR: { issue: 'Progressing with a future schedule or valid ECD; no action exception detected.', next: 'No action required; continue to monitor.', rec: '' }
  };
  // Explicit safety / business-continuity language ONLY. Matched against Scope + Notes text the caller
  // supplies; a bare high priority is NEVER enough (the spec is emphatic: do not manufacture a safety
  // issue from a P1). The matched text is preserved verbatim in Evidence.
  var ACT_SAFETY_RE = /\b(safety hazard|unsafe|fallen (?:pole|sign|tree)|downed pole|exposed (?:wir\w*|electr\w*)|hanging (?:metal|canopy|sign)|canopy (?:damage|failing|falling)|structural (?:damage|risk|failure|collapse)|power (?:failure|outage)|gas leak|live wire|electrical hazard|fire (?:hazard|risk)|life[- ]safety|no lighting)\b/i;

  function actHasFlag(flags, re) { for (var i = 0; i < (flags || []).length; i++) { if (re.test(flags[i])) return true; } return false; }
  // A usable internal owner: has a letter, and is not an ERRORNAME placeholder or an "unassigned" token.
  function actValidOwner(s) { s = String(s == null ? '' : s).trim(); return !!s && /[a-z]/i.test(s) && !/errorname|error\s*name|\?\?\?|^unassigned|^unknown$|^n\/?a$|^tbd$/i.test(s); }

  // ---- WORK-QUEUE MODEL functions (pure; every input is a normalized signals object S) ----------
  function actClamp(n) { n = Math.round(Number(n) || 0); return n < 0 ? 0 : n > 100 ? 100 : n; }
  // Is a physical on-site visit the next required step for this phase? Only then is a blank Next
  // Onsite Date a real "Schedule Required but Missing" gap - never merely because the field is blank.
  function isOnsiteDateExpected(phase) { return !!ACT_CFG.onsiteExpectedPhases[phase]; }
  // Does this phase support a credible completion forecast? Only then is a blank ECD a real gap; in
  // early/undefined-scope phases a decision or follow-up date is the right control instead.
  function isEcdExpected(phase) { return !!ACT_CFG.ecdExpectedPhases[phase]; }

  // A blocked state is VALID only with all four: a recognized waiting-on party, a meaningful reason,
  // a future expected response/follow-up date, and a defined owner to follow up. Returns what is
  // present and, crucially, what is MISSING (an invalid waiting state is a triage exception, not a
  // silent park).
  function evaluateWaitingState(S) {
    var party = ACT_CFG.waitingParty[S.phase] || '';
    var reason = S.primaryBlocker || '';
    var respDate = S.expectedResponseDate || '';
    var ownerOk = !!S.ownerValid;
    var missing = [];
    if (!party) missing.push('Waiting Party Undefined');
    if (!reason) missing.push('Meaningful Update Missing');
    if (!respDate) missing.push('Follow-Up Date Missing');
    if (!ownerOk) missing.push('Owner Undefined');
    // A live exception (overdue/stale/safety/passed visit) means Broadway CAN act now, so the wait
    // is not currently valid however well documented.
    var liveException = S.safety || S.overdueEcd || S.visitPast || S.stale || S.sameDayVisit;
    var valid = !!party && !!reason && !!respDate && ownerOk && !liveException;
    return { valid: valid, party: party, reason: reason, expectedResponseDate: respDate, owner: ownerOk, missing: missing, liveException: !!liveException };
  }

  // Structured contradictions. Each is emitted ONLY when the fields it needs are actually present in
  // the parsed data (no false exception from a missing column). Codes are machine-readable; severity
  // drives the dashboard rollup and can lift priority.
  function evaluateContradictions(S) {
    var out = [];
    function add(code, label, sev, why, action) { out.push({ code: code, label: label, severity: sev, why: why, action: action || '' }); }
    var onsiteKnown = S.hasNextOnsiteField;           // we read Next Onsite (live or column)
    if (S.phase === 'scheduled' && onsiteKnown && !S.hasFutureOnsite)
      add('SCHEDULED_NO_FUTURE_VISIT', 'Scheduled with no future visit date', 'high', 'Status is Scheduled but no upcoming on-site date is on file.', 'Confirm and record the on-site date, or correct the status.');
    if ((S.terminal || S.phase === 'confirmcomplete' || S.phase === 'costreview') && S.remainingScopeNoted)
      add('COMPLETE_REMAINING_SCOPE', 'Complete status with remaining scope noted', 'high', 'The status reads complete but the latest meaningful note describes outstanding work.', 'Reconcile scope; reopen or document the remaining work.');
    if ((S.phase === 'materials' || S.phase === 'materials-client') && (S.visitPast || S.ecdExpired))
      add('MATERIAL_DATE_EXPIRED', 'Material pending with an expired date', 'medium', 'Materials are pending but the delivery/on-site date has already passed.', 'Confirm the current delivery date and reschedule the return visit.');
    if (S.phase === 'client' && (!ACT_CFG.waitingParty[S.phase] || !S.expectedResponseDate))
      add('AWAITING_3P_NO_DATE', 'Awaiting third party with no follow-up date', 'medium', 'The work order is awaiting a party with no documented response date on file.', 'Record the responsible party and the expected response date.');
    if (S.phase === 'proposal-sent' && !S.expectedResponseDate)
      add('PROPOSED_NO_DECISION_DATE', 'Proposed with no decision date', 'low', 'A proposal is out for approval with no decision-due date on file.', 'Confirm and record the client decision-due date. (Proposal amount / submission date are not exposed to this tool.)');
    if (S.phase === 'onsite' && S.hasMeaningfulUpdate === false)
      add('ONSITE_NO_SAMEDAY_OUTCOME', 'On-site with no documented outcome', 'high', 'Status is On-Site but no meaningful outcome note is on file.', 'Obtain the technician outcome and document completed vs remaining scope.');
    else if (S.phase === 'onsite' && S.meaningfulUpdateDays != null && S.meaningfulUpdateDays > 0)
      add('ONSITE_NO_SAMEDAY_OUTCOME', 'On-site with no same-day outcome', 'high', 'Status is On-Site but the latest meaningful note predates today.', 'Obtain the same-day technician outcome and next step.');
    if (S.phase === 'schedule' && S.noVendor)
      add('PENDING_SCHEDULE_NO_VENDOR', 'Pending schedule with no vendor', 'medium', 'The work order needs scheduling but no vendor is assigned.', 'Assign a vendor, then confirm the on-site date.');
    if (S.phase === 'client' && !S.ownerValid)
      add('CLIENT_ACTION_NO_OWNER', 'Client action required with no owner', 'medium', 'Client action is required but no internal decision owner is recorded.', 'Assign an internal owner to drive the client decision.');
    if ((S.phase === 'confirmcomplete' || S.phase === 'costreview') && S.hasCompletionEvidence === false)
      add('COMPLETE_NO_CLOSEOUT_EVIDENCE', 'Complete with no closeout evidence', 'medium', 'The job is in closeout but no completion evidence note is on file.', 'Collect the completion evidence (photos / sign-off / invoice) before closing.');
    if (S.ecdKnownFuture && S.visitPast && S.hasCompletionEvidence === false)
      add('FUTURE_ECD_PRIOR_VISIT_PASSED', 'Future ECD but a prior visit passed with no result', 'medium', 'A visit date has passed with no outcome, yet the ECD is set in the future.', 'Confirm what happened at the visit before relying on the ECD.');
    if (ACT_CFG.waitingParty[S.phase] && !S.expectedResponseDate && S.phase !== 'proposal-sent' && S.phase !== 'client')
      add('WAITING_NO_RESPONSE_DATE', 'Waiting status with no response date', 'low', 'The work order is in a waiting phase with no expected response date recorded.', 'Record the expected response / follow-up date and the owner.');
    if (S.terminal && (S.hasFutureOnsite || (S.primaryBlocker && S.primaryBlocker.length)))
      add('CLOSED_WITH_OPEN_SIGNAL', 'Closed status with an open signal', 'high', 'The status reads closed but a future visit or an unresolved blocker is still on file.', 'Reconcile: reopen the work order or clear the stray schedule/blocker.');
    return out;
  }

  // Operational risk: how exposed the WO is if not managed (0-100). Age is a LIMITED modifier only.
  function calculateOperationalRisk(S) {
    var pts = 0, why = [];
    function add(p, r) { pts += p; why.push(r); }
    if (S.safety) add(35, 'safety / property-damage exposure');
    if (S.critical) add(22, 'critical source priority');
    if (S.overdueEcd) { add(18 + Math.min(12, (S.overdueDays || 0)), 'ECD overdue' + (S.overdueDays ? ' ' + S.overdueDays + 'd' : '')); }
    if (S.pricing) add(14, 'financial exposure (margin / NTE)');
    if (S.visitPast && !S.hasCompletionEvidence) add(16, 'scheduled visit passed with no credible outcome');
    if (S.phase === 'recall') add(14, 'return trip / failed completion');
    if (S.remainingScopeNoted && S.terminal) add(15, 'completion claimed but scope not reconciled');
    if (S.clientOverdue) add(12, 'client-commitment / update exposure');
    if (S.severeContradiction) add(15, 'major data contradiction blocks safe handling');
    if (S.stale) add(Math.min(10, 4 + Math.floor((S.staleDays || 0) / 7)), 'stale ' + (S.staleDays || 0) + 'd (age modifier)');
    return { score: actClamp(pts), reasons: why };
  }

  // Actionability: can Broadway take a concrete, useful step TODAY (0-100)? A valid waiting state
  // caps it low so a well-parked WO cannot crowd the daily queue. Note age alone never counts.
  function calculateActionability(S) {
    if (S.validWaitingState) return { score: actClamp(8), reasons: ['valid documented waiting state - no step due today'] };
    var pts = 0, why = [];
    function add(p, r) { pts += p; why.push(r); }
    var internal = !!ACT_INTERNAL_OWNERS[S.nextActionOwner];
    if (internal) add(40, 'Broadway controls the next step');
    if (S.nextActionSpecific) add(18, 'a specific next action is identified');
    if (S.ownerValid) add(14, 'a responsible owner is known');
    if (S.overdueEcd || S.dueToday) add(24, 'a due date is today or overdue');
    if (S.confidence === 'high' || S.confidence === 'medium') add(12, 'the needed information is available');
    if (S.awaitingBroadwayDecision) add(30, 'a party is awaiting a Broadway decision');
    if (S.onsiteNow || S.sameDayVisit) add(34, 'a technician is on site or a same-day visit is at risk');
    if (S.externalCommitmentDue) add(20, 'an external follow-up commitment is due today or overdue');
    return { score: actClamp(pts), reasons: why };
  }

  // First matching queue wins (ACT_QUEUE_ORDER). All matches are recorded for diagnostics.
  function classifyActionQueue(S) {
    var matched = {}, reasons = {};
    function m(key, why) { if (!matched[key]) { matched[key] = true; reasons[key] = []; } reasons[key].push(why); }

    // IMMEDIATE INTERVENTION (P0-worthy, live exposure)
    if (S.safety) m('IMMEDIATE', 'safety / property-damage exposure');
    if ((S.phase === 'onsite' || S.phase === 'inprogress') && (S.primaryBlocker || !S.hasSameDayOutcome)) m('IMMEDIATE', 'technician on site and blocked or with no documented outcome');
    if (S.visitPast && !S.hasCompletionEvidence && (S.critical || S.overdueEcd)) m('IMMEDIATE', 'a visit occurred with no outcome on an urgent work order');
    if (S.critical && (S.overdueEcd || S.noVendor || S.unscheduled)) m('IMMEDIATE', 'critical service blocked (overdue / no vendor / unscheduled)');
    if (S.sameDayVisit && (S.overdueEcd || S.stale || S.primaryBlocker)) m('IMMEDIATE', 'same-day visit at risk');
    if (S.phase === 'recall' && (S.critical || S.overdueEcd)) m('IMMEDIATE', 'failed visit needs an urgent decision');
    if (S.critical && (S.noVendor || !S.ownerValid)) m('IMMEDIATE', 'critical work order with no owner or vendor');

    // CLOSEOUT / BILLING READINESS
    if (S.phase === 'confirmcomplete' || S.phase === 'costreview') m('CLOSEOUT', 'operational work complete; verification / cost review outstanding');
    if ((S.terminal || S.phase === 'confirmcomplete' || S.phase === 'costreview') && S.remainingScopeNoted) m('CLOSEOUT', 'completion status conflicts with remaining scope in the latest note');
    if (S.hasCompletionEvidence && !S.terminal && (S.phase === 'confirmcomplete' || S.phase === 'costreview')) m('CLOSEOUT', 'completed but not yet closed');

    // EXECUTE TODAY (Broadway owns the next step)
    var internal = !!ACT_INTERNAL_OWNERS[S.nextActionOwner];
    if (S.overdueEcd && internal) m('EXECUTE', 'reset the ECD with a defensible date');
    if (S.phase === 'intake' || S.phase === 'proposal' || S.phase === 'proposal-approved' || S.phase === 'onhold') m('EXECUTE', 'a coordinator-owned step is ready to take');
    if (S.noVendor || (S.unscheduled && isOnsiteDateExpected(S.phase))) m('EXECUTE', 'assign a vendor / set the schedule');
    if (S.pricing) m('EXECUTE', 'review the margin / adjust the PO');
    if (S.visitPast && !S.hasCompletionEvidence && !matched.IMMEDIATE) m('EXECUTE', 'chase the completion report and update status');
    if (internal && S.nextActionSpecific && (S.dueToday || S.overdueEcd)) m('EXECUTE', 'a specific Broadway action is due today');

    // FOLLOW UP TODAY (an external party owes an update and a real date is due/overdue)
    var externalPhase = { 'proposal-sent': 1, client: 1, materials: 1, 'materials-client': 1, accept: 1 }[S.phase];
    if (externalPhase && (S.expectedResponseOverdue || S.clientOverdue || (S.overdueEcd && !internal))) m('FOLLOWUP', 'a documented external commitment is due today or overdue');

    // UPCOMING WATCH (no action today, monitor soon)
    if (S.hasFutureOnsite && S.onsiteDaysAway != null && S.onsiteDaysAway <= ACT_CFG.watchDays) m('WATCH', 'a confirmed visit is within the watch window');
    if (S.ecdKnownFuture && S.ecdDaysAway != null && S.ecdDaysAway <= ACT_CFG.ecdRiskWindowDays && S.primaryBlocker) m('WATCH', 'ECD approaching with an unresolved scope');
    if ((S.phase === 'materials' || S.phase === 'materials-client') && S.hasFutureOnsite) m('WATCH', 'material delivery / return visit approaching');
    if (S.hasFutureOnsite && (S.critical || S.pricing)) m('WATCH', 'confirmed future visit with elevated risk');

    // BLOCKED / WAITING (valid, documented waiting state)
    if (S.validWaitingState) m('BLOCKED', 'valid documented waiting state: ' + (S.waitingParty || 'third party') + (S.expectedResponseDate ? ' by ' + S.expectedResponseDate : ''));

    // pick first in spec order
    for (var i = 0; i < ACT_QUEUE_ORDER.length; i++) {
      var k = ACT_QUEUE_ORDER[i];
      if (matched[k]) return { key: k, queue: ACT_QUEUE[k], reasons: reasons[k], matched: matched, allReasons: reasons };
    }
    // Fallbacks - a clean terminal WO is monitor/excluded; a future-dated valid monitor is Blocked;
    // otherwise there is no determinable action -> triage (never a fabricated "follow up").
    if (S.terminal) return { key: 'MONITOR', queue: '', reasons: ['closed - no action'], monitor: true, matched: matched, allReasons: reasons };
    if (S.ownerValid && S.nextActionSpecific && (S.ecdKnownFuture || S.hasFutureOnsite || S.expectedResponseDate)) {
      m('BLOCKED', 'owner, next step and a future follow-up date are all valid');
      return { key: 'BLOCKED', queue: ACT_QUEUE.BLOCKED, reasons: reasons.BLOCKED, matched: matched, allReasons: reasons };
    }
    if (S.hasFutureOnsite) { m('WATCH', 'a future visit is on file'); return { key: 'WATCH', queue: ACT_QUEUE.WATCH, reasons: reasons.WATCH, matched: matched, allReasons: reasons }; }
    m('UNDEFINED', 'no usable owner, next action, or follow-up date could be determined');
    return { key: 'UNDEFINED', queue: ACT_QUEUE.UNDEFINED, reasons: reasons.UNDEFINED, matched: matched, allReasons: reasons };
  }

  // Priority in the P0-P3 scheme, with explainable reasons.
  function calculateQueuePriority(S, queueKey) {
    var why = [];
    if (queueKey === 'IMMEDIATE') { why.push('immediate operational exposure'); return { key: 'P0', label: QUEUE_PRIORITY.P0, reasons: why }; }
    if (S.safety) { why.push('explicit safety language'); return { key: 'P0', label: QUEUE_PRIORITY.P0, reasons: why }; }
    if (queueKey === 'EXECUTE') {
      if (S.overdueEcd || S.dueToday || S.visitPast) { why.push('a Broadway-controlled action is due today or overdue'); return { key: 'P1', label: QUEUE_PRIORITY.P1, reasons: why }; }
      why.push('a Broadway-controlled action can be prepared'); return { key: 'P2', label: QUEUE_PRIORITY.P2, reasons: why };
    }
    if (queueKey === 'CLOSEOUT') {
      if (S.overdueEcd || S.stale || S.remainingScopeNoted) { why.push('closeout is aging or contradicts remaining scope'); return { key: 'P1', label: QUEUE_PRIORITY.P1, reasons: why }; }
      why.push('closeout / billing readiness'); return { key: 'P2', label: QUEUE_PRIORITY.P2, reasons: why };
    }
    if (queueKey === 'FOLLOWUP') {
      if (S.expectedResponseOverdue || S.clientOverdue || S.overdueEcd) { why.push('an external commitment is overdue'); return { key: 'P1', label: QUEUE_PRIORITY.P1, reasons: why }; }
      why.push('an external commitment is due'); return { key: 'P2', label: QUEUE_PRIORITY.P2, reasons: why };
    }
    if (queueKey === 'UNDEFINED') {
      if (S.operationalRiskScore >= 55) { why.push('undefined action on a high-risk work order'); return { key: 'P1', label: QUEUE_PRIORITY.P1, reasons: why }; }
      why.push('needs triage to define owner / action / date'); return { key: 'P2', label: QUEUE_PRIORITY.P2, reasons: why };
    }
    if (queueKey === 'WATCH') {
      if ((S.critical || S.pricing) && S.onsiteDaysAway != null && S.onsiteDaysAway <= ACT_CFG.watchDays) { why.push('near-term event with elevated risk'); return { key: 'P2', label: QUEUE_PRIORITY.P2, reasons: why }; }
      why.push('future-dated, no exception due yet'); return { key: 'P3', label: QUEUE_PRIORITY.P3, reasons: why };
    }
    why.push('legitimately waiting with a valid future follow-up date');
    return { key: 'P3', label: QUEUE_PRIORITY.P3, reasons: why };
  }

  // Daily rank: actionability first, risk second, urgency/age last; valid waiting subtracts hard.
  // Every component is returned so the sheet can explain the number (never a black box).
  function calculateDailyRank(S, queueKey) {
    var w = ACT_CFG.weights;
    var A = S.actionabilityScore, R = S.operationalRiskScore;
    var U = S.overdueEcd ? 100 : S.dueToday ? 80 : (S.ecdDaysAway != null && S.ecdDaysAway <= ACT_CFG.ecdRiskWindowDays) ? 50 : 0;
    var SP = S.sameDayVisit ? 100 : (S.visitPast && !S.hasCompletionEvidence) ? 80 : (S.onsiteDaysAway != null && S.onsiteDaysAway <= ACT_CFG.watchDays) ? 60 : 0;
    var E = S.safety ? 100 : S.critical ? 70 : (S.overdueDays > ACT_CFG.overdueManagerDays) ? 60 : S.clientOverdue ? 40 : 0;
    var DQ = S.severeContradiction ? 100 : (queueKey === 'UNDEFINED') ? 60 : S.contradictionCount ? 50 : S.dataGap ? 30 : 0;
    var VW = S.validWaitingState ? 100 : 0;
    var comps = { actionability: A, operationalRisk: R, dueUrgency: U, scheduleProximity: SP, escalationRisk: E, dataQuality: DQ, validWaiting: VW };
    var rank = w.actionability * A + w.operationalRisk * R + w.dueUrgency * U + w.scheduleProximity * SP + w.escalationRisk * E + w.dataQuality * DQ - w.validWaiting * VW;
    if (queueKey === 'IMMEDIATE') rank += ACT_CFG.p0RankFloor;   // pin above all numeric ranks
    return { rank: Math.round(rank), components: comps };
  }

  // The concrete plan fields. Never fabricates: an unresolvable owner/action/date becomes an explicit
  // Action-Undefined reason rather than a vague "follow up".
  var ACT_DEF_OF_DONE = {
    IMMEDIATE: 'Same-day outcome obtained, blocker resolved or escalated, and the work order updated.',
    EXECUTE: 'The Broadway action is completed and its outcome recorded on the work order.',
    FOLLOWUP: 'The external response is received (or re-committed with a date) and recorded on the work order.',
    CLOSEOUT: 'Completion evidence, final cost, and billing readiness confirmed; the work order closed.',
    WATCH: 'The scheduled event occurs as planned, or an exception is raised if it slips.',
    BLOCKED: 'The awaited party responds by the follow-up date, or the date is re-confirmed.',
    UNDEFINED: 'An owner, a specific next action, and a due / follow-up date are established on the work order.'
  };
  var ACT_BLOCKER_CAT = {
    schedule: 'Scheduling / Vendor', scheduled: 'Scheduling / Vendor', accept: 'Scheduling / Vendor', recall: 'Scheduling / Vendor', intake: 'Dispatch',
    proposal: 'Quote / Proposal', 'proposal-sent': 'Client Decision', 'proposal-approved': 'PO / Finance', client: 'Client Decision',
    materials: 'Materials', 'materials-client': 'Materials', onsite: 'On-Site Execution', inprogress: 'On-Site Execution',
    onhold: 'On Hold', confirmcomplete: 'Closeout', costreview: 'Closeout', terminal: 'None'
  };
  function buildActionPlan(S, queueKey) {
    var reasons = [];
    var owner = S.ownerValid ? S.owner : 'Owner Undefined';
    if (!S.ownerValid) reasons.push('Owner Undefined');
    var next = (S.nextAction && String(S.nextAction).trim()) || '';
    if (!next) reasons.push('Next Action Undefined');
    var waitingOn = ACT_CFG.waitingParty[S.phase] || '';
    var respDate = S.expectedResponseDate || '';
    // Only demand a date where the workflow actually needs one now.
    var needDate = queueKey === 'FOLLOWUP' || queueKey === 'BLOCKED' || (waitingOn && !isEcdExpected(S.phase));
    if (needDate && !respDate) reasons.push('Follow-Up Date Missing');
    if (isEcdExpected(S.phase) && (!S.ecdText || S.ecdText === 'TBD') && !S.overdueEcd) reasons.push('Due Date Undefined');
    if (isOnsiteDateExpected(S.phase) && !S.hasFutureOnsite && !S.visitPast) reasons.push('Schedule Required but Missing');
    if (!S.hasMeaningfulUpdate) reasons.push('Meaningful Update Missing');
    if (waitingOn === '' && (S.phase === 'client')) reasons.push('Waiting Party Undefined');
    var dod = ACT_DEF_OF_DONE[queueKey] || ACT_DEF_OF_DONE.UNDEFINED;
    var blockerCat = ACT_BLOCKER_CAT[S.phase] || 'Other';
    if (S.safety) blockerCat = 'Safety';
    // Escalation trigger: concrete, priority-aware, never invented past what the signals support.
    var esc;
    if (queueKey === 'IMMEDIATE') esc = 'Escalate to Operations Manager now if the blocker is not cleared today.';
    else if (queueKey === 'FOLLOWUP') esc = 'Escalate to the ' + (waitingOn || 'responsible') + ' owner if no response by end of day.';
    else if (queueKey === 'EXECUTE') esc = 'Escalate to Operations Manager if the action cannot be completed today.';
    else if (queueKey === 'CLOSEOUT') esc = 'Escalate to Operations Manager if closeout lingers beyond this week.';
    else if (queueKey === 'UNDEFINED') esc = 'Route to a coordinator/manager to define owner, action, and date.';
    else esc = 'Re-confirm with the owner if the follow-up date passes with no response.';
    return { owner: owner, nextAction: next, waitingOn: waitingOn, expectedResponseDate: respDate, definitionOfDone: dod, escalationTrigger: esc, blockerCategory: blockerCat, actionUndefinedReasons: reasons };
  }

  // Orchestrator: takes the normalized signals S, runs the model in dependency order, and returns
  // the full derived-field set. Pure and self-contained so the harness can drive it directly.
  function actQueueModel(S) {
    S = S || {};
    var waiting = evaluateWaitingState(S);
    S.validWaitingState = waiting.valid; S.waitingParty = waiting.party;
    var contradictions = evaluateContradictions(S);
    S.contradictionCount = contradictions.length;
    S.severeContradiction = contradictions.some(function (c) { return c.severity === 'high'; });
    S.dataGap = (isEcdExpected(S.phase) && (!S.ecdText || S.ecdText === 'TBD') && !S.overdueEcd) || !S.ownerValid;
    var risk = calculateOperationalRisk(S); S.operationalRiskScore = risk.score;
    var act = calculateActionability(S); S.actionabilityScore = act.score;
    var cls = classifyActionQueue(S);
    var pr = calculateQueuePriority(S, cls.key);
    var dr = calculateDailyRank(S, cls.key);
    var plan = buildActionPlan(S, cls.key);
    // Due label (never a fabricated calendar date - the tool has no business-day calendar).
    var due;
    if (cls.key === 'IMMEDIATE') due = 'Today – now';
    else if (pr.key === 'P1') due = (cls.key === 'FOLLOWUP' && S.expectedResponseOverdue) ? 'Overdue' : 'Today';
    else if (cls.key === 'CLOSEOUT') due = 'This week';
    else if (cls.key === 'WATCH') due = (S.onsiteDaysAway != null) ? ('Within ' + S.onsiteDaysAway + ' day' + (S.onsiteDaysAway === 1 ? '' : 's')) : 'This week';
    else if (cls.key === 'FOLLOWUP') due = S.expectedResponseOverdue ? 'Overdue' : 'Today';
    else if (cls.key === 'UNDEFINED') due = 'Triage today';
    else if (cls.key === 'BLOCKED') due = S.expectedResponseDate ? ('By ' + S.expectedResponseDate) : 'Monitor';
    else due = 'Monitor';
    var nextEvent = S.hasFutureOnsite && S.nextOnsiteMd ? ('Visit ' + S.nextOnsiteMd)
      : S.ecdKnownFuture && S.ecdText && S.ecdText !== 'TBD' ? ('ECD ' + S.ecdText) : '';
    var lastMu = S.lastMeaningfulUpdateMd
      ? (S.lastMeaningfulUpdateMd + (S.meaningfulUpdateDays != null ? ' (' + S.meaningfulUpdateDays + 'd ago)' : '') + (S.meaningfulSummary ? ': ' + S.meaningfulSummary : ''))
      : (S.hasMeaningfulUpdate ? '' : 'no meaningful update on file');
    return {
      actionQueue: cls.queue, queueKey: cls.key, queueMonitor: !!cls.monitor,
      queueDisplayRank: (ACT_QUEUE_DISPLAY_RANK[cls.queue] == null ? 99 : ACT_QUEUE_DISPLAY_RANK[cls.queue]),
      queuePriorityKey: pr.key, queuePriority: pr.label, queuePriorityRank: QUEUE_PRIORITY_RANK[pr.key],
      operationalRiskScore: risk.score, operationalRiskReasons: risk.reasons,
      actionabilityScore: act.score, actionabilityReasons: act.reasons,
      dailyRank: dr.rank, rankComponents: dr.components,
      nextAction: plan.nextAction, actionOwner: plan.owner, dueDateTime: due,
      waitingOn: plan.waitingOn, expectedResponseDate: plan.expectedResponseDate,
      definitionOfDone: plan.definitionOfDone, escalationTrigger: plan.escalationTrigger,
      blockerCategory: plan.blockerCategory, validWaitingState: waiting.valid, waitingMissing: waiting.missing,
      actionUndefinedReasons: plan.actionUndefinedReasons, contradictions: contradictions,
      lastMeaningfulUpdate: lastMu, nextScheduledEvent: nextEvent,
      priorityReasons: pr.reasons, queueReasons: cls.reasons || [], queueAllReasons: cls.allReasons || {}
    };
  }

  // deriveAction(ctx) -> the structured management record for one work order. ctx:
  //   facts            deriveState output (authoritative; never re-inferred here)
  //   flags            applyChecks output (array of short flag strings)
  //   header           the live WorkOrder header (statusName / remainingDays / priority read only)
  //   assignedTo, fm   the internal owner candidates (workbook or live)
  //   scopeText, notesText   text scanned for explicit safety language ONLY
  //   priorityLabel, priorityCategory   source priority, for the P1-Critical gate
  //   ageDays, statusHours   display + manager-review inputs (numbers/strings, may be absent)
  //   ecdDueSoon, visitPast, hasFutureOnsite   date facts the CALLER computes (kept pure here)
  //   includeMonitor, staleDays, ageExpected
  function deriveAction(ctx) {
    ctx = ctx || {};
    var f = ctx.facts || {};
    var flags = ctx.flags || [];
    var h = ctx.header || null;
    var staleThr = (typeof ctx.staleDays === 'number') ? ctx.staleDays : 7;
    var phase = f.phase || null;
    var statusName = String((h && h.statusName) || '').trim();
    var remaining = (h && typeof h.remainingDays === 'number') ? h.remainingDays : null;

    // ---- signals -----------------------------------------------------------------------------
    var overdueEcd = !!f.ecdExpired || actHasFlag(flags, /^OVERDUE/) || (remaining != null && remaining < 0);
    var overdueDays = (remaining != null && remaining < 0) ? Math.abs(remaining)
      : (typeof ctx.ecdOverdueDays === 'number' ? ctx.ecdOverdueDays : 0);
    var stale = (typeof f.staleDays === 'number' && f.staleDays > staleThr) || actHasFlag(flags, /^STALE/);
    var noVendor = actHasFlag(flags, /^NO VENDOR/);
    var unscheduled = actHasFlag(flags, /^UNSCHEDULED/);
    var pricing = actHasFlag(flags, /^(NEG GP|LOW GP|NTE>DNE)/);
    var clientUpd = actHasFlag(flags, /^CLIENT UPDATE|^NO CLIENT NOTE/);
    var cancel = actHasFlag(flags, /CANCEL\?/);
    var ecdDueSoon = !!ctx.ecdDueSoon;
    var visitPast = !!ctx.visitPast;
    var safetyText = '';
    var sm = ACT_SAFETY_RE.exec(String(ctx.scopeText || '') + ' ' + String(ctx.notesText || ''));
    if (sm) safetyText = sm[0];
    var safety = !!safetyText;
    var critical = /\b(critical|emergency|life[- ]safety|priority\s*1|p1)\b/i.test(String(ctx.priorityLabel || '') + ' ' + String(ctx.priorityCategory || ''));

    // ---- internal owner ----------------------------------------------------------------------
    var owner = actValidOwner(ctx.assignedTo) ? String(ctx.assignedTo).trim()
      : actValidOwner(ctx.fm) ? String(ctx.fm).trim()
        : 'Unassigned – Manager Review';
    var ownerInvalid = owner === 'Unassigned – Manager Review';

    // ---- data quality: the RECORD itself cannot be managed (not merely a thin field) ---------
    var dqReasons = [];
    if (!h) dqReasons.push('work order record could not be read');
    if (h && !statusName) dqReasons.push('status is missing');
    if (/errorname|error\s*name/i.test(String(ctx.assignedTo || ''))) dqReasons.push('assignee is an ERRORNAME placeholder');
    var severeDq = !h || (!!h && !statusName);

    // ---- primary bucket ----------------------------------------------------------------------
    var bk = Object.prototype.hasOwnProperty.call(ACT_PHASE_BUCKET, phase) ? ACT_PHASE_BUCKET[phase] : null;
    // Scheduled/on-site with a FUTURE visit and no other exception is not yet a verification miss.
    if ((phase === 'scheduled' || phase === 'onsite' || phase === 'inprogress') && !visitPast && !stale && !overdueEcd) bk = null;
    if (!bk) {
      // F1: a terminal (Invoiced/Closed/Paid) work order must NOT be pulled into an actionable
      // Overdue-ECD/Stale bucket just because a stale ECD lingers - the ECD is no longer the control
      // point once the job is closed. It stays MONITOR. Real closeout work lives in the costreview /
      // confirmcomplete phases, which map to a bucket ABOVE this fallback and are unaffected.
      if (overdueEcd && phase !== 'terminal') bk = 'OVERDUE_ECD';
      else if (stale && phase !== 'terminal') bk = 'STALE';
      else if (severeDq) bk = 'DATA_QUALITY';
      else bk = 'MONITOR';
    }
    if (severeDq && bk === 'MONITOR') bk = 'DATA_QUALITY';
    // Safety must NEVER be hidden as Monitor: force an actionable bucket so the row is included as P0.
    if (safety && bk === 'MONITOR') bk = ACT_PHASE_BUCKET[phase] || 'COMPLETION';
    var actionable = bk !== 'MONITOR';

    // ---- priority ----------------------------------------------------------------------------
    // F1: non-actionable (Monitor) status wins FIRST, before any critical/overdue urgency - so a
    // terminal WO with a lapsed ECD (or a critical priority) can never be promoted to P0/P1 while
    // its bucket is Monitor. Safety already forced an actionable bucket above, so it is never
    // stranded here. For an actionable row the outcome is identical to before.
    var noSchedule = bk === 'VENDOR_SCHEDULING' || unscheduled || noVendor;
    var pk;
    if (!actionable) pk = 'MON';
    else if (safety) pk = 'P0';
    else if (critical && (overdueEcd || noSchedule || stale)) pk = 'P0';
    else if (overdueEcd || ecdDueSoon || critical) pk = 'P1';
    else pk = 'P2';

    // ---- risk flags (short, controlled, multiple allowed) ------------------------------------
    var risk = [];
    if (safety) risk.push('SAFETY/CRITICAL RISK');
    if (overdueEcd) risk.push('OVERDUE ECD');
    if (bk === 'VENDOR_SCHEDULING') risk.push(noVendor ? 'NO VENDOR' : 'UNSCHEDULED');
    if (bk === 'MATERIAL') risk.push('MATERIALS PENDING');
    if (bk === 'CLIENT_APPROVAL') risk.push('CLIENT APPROVAL PENDING');
    if (bk === 'PO_RELEASE') risk.push('PO RELEASE PENDING');
    if (bk === 'PROPOSAL') risk.push('QUOTE/PROPOSAL BLOCKER');
    if (bk === 'COMPLETION') risk.push('COMPLETION UPDATE MISSING');
    if (bk === 'CLOSEOUT') risk.push('CLOSEOUT PENDING');
    if (stale) risk.push('STALE UPDATE');
    if (clientUpd) risk.push('CLIENT UPDATE OVERDUE');
    if (pricing) risk.push('PRICING EXCEPTION');
    if (cancel) risk.push('CANCELLATION REVIEW');
    if (severeDq || dqReasons.length) risk.push('DATA QUALITY');
    risk = actUniq(risk);

    // ---- rule IDs ----------------------------------------------------------------------------
    var rules = [];
    if (ACT_RULE[bk]) rules.push(ACT_RULE[bk]);
    if (overdueEcd) rules.push('ECD_OVERDUE');
    if (stale) rules.push('STALE_UPDATE');
    if (safety) rules.push('SAFETY_OR_CRITICAL_SCOPE');
    if (severeDq || dqReasons.length) rules.push('DATA_QUALITY');
    rules = actUniq(rules);

    // ---- contradiction (drives manager review) -----------------------------------------------
    var contradiction = false;
    if (phase === 'scheduled' && !ctx.hasFutureOnsite) contradiction = true;   // "Scheduled" but no future date
    if (phase === 'terminal' && (bk === 'CLOSEOUT' || stale || overdueEcd)) contradiction = true;
    if (cancel) contradiction = true;

    // ---- confidence --------------------------------------------------------------------------
    var conf = severeDq ? 'Review Needed'
      : (f.confidence === 'high' ? 'High' : f.confidence === 'medium' ? 'Medium' : 'Low');
    if (!h) conf = 'Review Needed';

    // ---- manager review ----------------------------------------------------------------------
    // F2: the generic "more than one risk flag" trigger is removed - common flags (OVERDUE ECD +
    // a bucket flag + CLIENT UPDATE OVERDUE) coexist on most rows and flooded the queue. Manager
    // Review is now a narrow, targeted escalation set. F3B: a Monitor item is never a manager-review
    // escalation, so any contradiction flag on a Monitor row does not leak a hidden [MANAGER REVIEW].
    var manager = pk === 'P0' || ownerInvalid || (pk !== 'MON' && overdueDays > 7) ||
      safety || contradiction || conf === 'Review Needed';
    if (pk === 'MON') manager = false;

    // ---- action due (LABEL only) -------------------------------------------------------------
    var due;
    if (pk === 'MON') due = 'Monitor / no action due';
    else if (pk === 'P0' || pk === 'P1') due = 'Today';
    else if (bk === 'CLOSEOUT') due = 'This week';
    else if (bk === 'COMPLETION' && visitPast) due = 'Next business day';
    else due = 'Next 2 business days';

    // ---- escalate to (external dependency + Operations Manager when severity warrants) -------
    var em = {
      VENDOR_SCHEDULING: 'Vendor Manager', MATERIAL: 'Vendor Manager', COMPLETION: 'Vendor Manager',
      PROPOSAL: 'Vendor Manager', CLIENT_APPROVAL: 'Client Approval Owner', PO_RELEASE: 'PO / Finance Owner',
      CLOSEOUT: 'Operations Manager', OVERDUE_ECD: 'Operations Manager', STALE: 'Operations Manager'
    };
    var esc = [];
    if (bk === 'DATA_QUALITY' && ownerInvalid) esc.push('Unassigned – Manager Review');
    if (em[bk]) esc.push(em[bk]);
    if ((pk === 'P0' || pk === 'P1' || manager || ownerInvalid) && esc.indexOf('Operations Manager') === -1) esc.push('Operations Manager');
    var escalateTo = actUniq(esc).join(' + ');

    // ---- primary issue -----------------------------------------------------------------------
    // F3A: the Completion-Verification template asserts the visit "has passed". When the row is
    // actionable only because the ECD lapsed but the visit is still in the FUTURE, that wording is
    // false - state the scheduled future visit instead. Uses ONLY the caller-established onsite date
    // (ctx.nextOnsiteMd); no new parser and no date inferred from note prose.
    var tpl = ACT_TEMPLATE[bk] || ACT_TEMPLATE.MONITOR;
    var stageBit = f.currentStage || '';
    var futureVisit = bk === 'COMPLETION' && !!ctx.hasFutureOnsite && !visitPast;
    var completionFutureText = 'visit is scheduled for ' + (ctx.nextOnsiteMd || 'an upcoming date') + '; confirm vendor attendance and document the outcome after the visit.';
    var issue;
    if (bk === 'DATA_QUALITY') issue = tpl.issue + (dqReasons.length ? ' (' + dqReasons.join('; ') + ')' : '');
    else if (futureVisit) issue = (stageBit && stageBit !== 'Status unclear') ? (stageBit + ' – ' + completionFutureText) : completionFutureText;
    else if (stageBit && f.primaryBlocker && (f.confidence !== 'low' || f.blockerCertain)) issue = stageBit + ' – ' + f.primaryBlocker;
    else if (stageBit && stageBit !== 'Status unclear') issue = stageBit + ' – ' + tpl.issue;
    else issue = tpl.issue;
    if (overdueEcd && !/ecd|overdue/i.test(issue)) issue = issue + ' ECD overdue.';
    // [MANAGER REVIEW] prefix only when it adds signal and is not already present (spec).
    if (manager && !/^\[MANAGER REVIEW\]/.test(issue)) issue = '[MANAGER REVIEW] ' + issue;

    // ---- required next action (reuse the grounded deterministic action; template only if none)
    var next = (f.nextAction && String(f.nextAction).trim()) || tpl.next;

    // ---- evidence ----------------------------------------------------------------------------
    var evb = [];
    if (statusName) evb.push('Status: ' + statusName);
    evb.push('ECD: ' + (f.ecdText || 'TBD') + (f.ecdExpired ? ' (lapsed)' : ''));
    if (ctx.nextOnsiteMd) evb.push('Next onsite: ' + ctx.nextOnsiteMd);
    if (ctx.lastNoteMd) evb.push('Last note ' + ctx.lastNoteMd + (f.latestMeaningfulEvent ? ': ' + String(f.latestMeaningfulEvent).slice(0, 90) : ''));
    else if (f.latestMeaningfulEvent) evb.push('Latest: ' + String(f.latestMeaningfulEvent).slice(0, 90));
    if (typeof ctx.ageDays === 'number') evb.push('Age: ' + ctx.ageDays + 'd');
    if (ctx.statusHours) evb.push('Status hrs: ' + ctx.statusHours);
    if (safetyText) evb.push('Safety text: "' + safetyText + '"');
    if (flags && flags.length) evb.push('Flags: ' + flags.join(' | '));
    var evidence = evb.join(' | ').slice(0, 500);

    // ---- data gaps + confidence knock-down ---------------------------------------------------
    // A missing ECD is a gap ONLY where the workflow requires one (spec). An early-phase job
    // (intake/schedule/proposal/awaiting-approval/on-hold) legitimately has no ECD yet, so flagging
    // it there would over-report and needlessly knock confidence on ordinary work.
    var ECD_EXPECTED = { scheduled: 1, onsite: 1, inprogress: 1, materials: 1, 'materials-client': 1, 'proposal-approved': 1, confirmcomplete: 1, costreview: 1, recall: 1, client: 1 };
    var gaps = dqReasons.slice();
    if ((!f.ecdText || f.ecdText === 'TBD') && ECD_EXPECTED[phase] && !overdueEcd) gaps.push('no valid ECD on file');
    if (ownerInvalid) gaps.push('no valid internal owner (Assigned To / FM)');
    if (typeof ctx.ageDays !== 'number' && ctx.ageExpected) gaps.push('no work-order age available');
    var dataGaps = gaps.join(' | ');
    if (dataGaps && conf === 'High') conf = 'Medium';

    var include = pk !== 'MON' || ctx.includeMonitor === true || safety;

    // ---- WORK-QUEUE MODEL (0.18.0): additive - never touches the legacy fields above ------------
    // Build the normalized signals from what deriveState + the flags + the caller's date facts
    // already established (nothing new is inferred here). Date-formatted values arrive via ctx so the
    // pure slice never needs fmtMD.
    var external = { 'proposal-sent': 1, client: 1, materials: 1, 'materials-client': 1, accept: 1 }[phase];
    var ecdKnownFuture = !!f.ecd;                                   // set only for a valid future header ECD
    var onsiteNow = phase === 'onsite' || phase === 'inprogress';
    var hasSameDayOutcome = ctx.meaningfulUpdateDays === 0;
    var expectedResponseDate = (ctx.hasFutureOnsite && ctx.nextOnsiteMd) ? ctx.nextOnsiteMd
      : (ecdKnownFuture && f.ecdText && f.ecdText !== 'TBD') ? f.ecdText
        : (ctx.expectedResponseMd || '');
    var expectedResponseOverdue = !!(external && (ctx.visitPast || clientUpd || overdueEcd));
    var S = {
      phase: phase, terminal: !!f.terminal, statusName: statusName,
      owner: owner, ownerValid: !ownerInvalid,
      safety: safety, critical: critical,
      overdueEcd: overdueEcd, overdueDays: overdueDays, ecdExpired: !!f.ecdExpired,
      ecdText: f.ecdText, ecdKnownFuture: ecdKnownFuture, ecdDaysAway: (typeof ctx.ecdDaysAway === 'number' ? ctx.ecdDaysAway : null),
      dueToday: !!ctx.ecdDueSoon,
      stale: stale, staleDays: (typeof f.staleDays === 'number' ? f.staleDays : null),
      noteCount: f.noteCount, hasMeaningfulUpdate: (f.noteCount || 0) > 0,
      meaningfulUpdateDays: (typeof ctx.meaningfulUpdateDays === 'number' ? ctx.meaningfulUpdateDays : (typeof f.staleDays === 'number' ? f.staleDays : null)),
      lastMeaningfulUpdateMd: ctx.lastNoteMd || '', meaningfulSummary: (f.latestMeaningfulEvent ? String(f.latestMeaningfulEvent).slice(0, 80) : ''),
      noVendor: noVendor, unscheduled: unscheduled, pricing: pricing, clientOverdue: clientUpd, cancel: cancel,
      visitPast: !!ctx.visitPast, hasFutureOnsite: !!ctx.hasFutureOnsite, onsiteDaysAway: (typeof ctx.onsiteDaysAway === 'number' ? ctx.onsiteDaysAway : null),
      nextOnsiteMd: ctx.nextOnsiteMd || '', hasNextOnsiteField: !!ctx.hasNextOnsiteField,
      sameDayVisit: ctx.onsiteDaysAway === 0,
      onsiteNow: onsiteNow, hasSameDayOutcome: hasSameDayOutcome,
      awaitingBroadwayDecision: !!((onsiteNow && (f.primaryBlocker || !hasSameDayOutcome)) || (ctx.visitPast && !ctx.hasCompletionEvidence)),
      externalCommitmentDue: !!(clientUpd || expectedResponseOverdue), expectedResponseOverdue: expectedResponseOverdue,
      // GROUNDED next action only (never the legacy bucket-template fallback `next`), so an
      // unmapped/triage WO with no evidenced action correctly reads as Next Action Undefined.
      nextAction: f.nextAction, nextActionOwner: f.nextActionOwner, nextActionSpecific: !!(f.nextAction && (f.confidence !== 'low' || f.blockerCertain)),
      blockerOwner: f.blockerOwner, primaryBlocker: f.primaryBlocker, confidence: f.confidence,
      hasCompletionEvidence: (ctx.hasCompletionEvidence === undefined ? null : !!ctx.hasCompletionEvidence),
      remainingScopeNoted: !!ctx.remainingScopeNoted,
      severeDq: severeDq, expectedResponseDate: expectedResponseDate
    };
    var Q = actQueueModel(S);

    return {
      include: include, priorityKey: pk, priority: ACT_PRIORITY[pk], bucketKey: bk, bucket: ACT_BUCKET[bk],
      primaryIssue: issue, nextAction: next, owner: owner, escalateTo: escalateTo,
      actionDue: due, dueRank: (ACT_DUE_RANK[due] == null ? 9 : ACT_DUE_RANK[due]),
      riskFlags: risk.join(' | '), riskList: risk, evidence: evidence, recommendedStatus: tpl.rec,
      managerReview: manager ? 'YES' : 'NO', managerReviewBool: manager, confidence: conf,
      ruleIds: rules.join(', '), ruleList: rules, dataGaps: dataGaps,
      // ---- work-queue model fields (0.18.0) ----
      actionQueue: Q.actionQueue, queueKey: Q.queueKey, queueMonitor: Q.queueMonitor, queueDisplayRank: Q.queueDisplayRank,
      queuePriority: Q.queuePriority, queuePriorityKey: Q.queuePriorityKey, queuePriorityRank: Q.queuePriorityRank,
      operationalRiskScore: Q.operationalRiskScore, operationalRiskReasons: Q.operationalRiskReasons,
      actionabilityScore: Q.actionabilityScore, actionabilityReasons: Q.actionabilityReasons,
      dailyRank: Q.dailyRank, rankComponents: Q.rankComponents,
      queueNextAction: Q.nextAction, actionOwner: Q.actionOwner, dueDateTime: Q.dueDateTime,
      waitingOn: Q.waitingOn, expectedResponseDate: Q.expectedResponseDate, definitionOfDone: Q.definitionOfDone,
      escalationTrigger: Q.escalationTrigger, blockerCategory: Q.blockerCategory,
      validWaitingState: Q.validWaitingState, waitingMissing: Q.waitingMissing,
      actionUndefinedReasons: Q.actionUndefinedReasons, contradictions: Q.contradictions,
      lastMeaningfulUpdate: Q.lastMeaningfulUpdate, nextScheduledEvent: Q.nextScheduledEvent,
      priorityReasons: Q.priorityReasons, queueReasons: Q.queueReasons
    };
  }
  function actUniq(a) { var o = [], i; for (i = 0; i < a.length; i++) { if (o.indexOf(a[i]) === -1) o.push(a[i]); } return o; }

  // The 16 structured columns appended to the SOURCE sheet (in this order), and the WO Action List
  // sheet's own column order (the leaner operating-review set). Kept as data so the tests and the
  // sheet builder read ONE definition.
  var ACTION_SOURCE_COLS = ['Audit Include', 'Audit Priority', 'Action Bucket', 'Primary Issue', 'Required Next Action', 'Action Owner', 'Escalate To', 'Action Due', 'Risk Flags', 'Evidence', 'Recommended Status', 'Manager Review', 'Audit Confidence', 'Audit Rule IDs', 'Audit Data Gaps', 'Audit Run Date'];
  var ACTION_SHEET_COLS = ['Audit Priority', 'Action Due', 'Action Bucket', 'Required Next Action', 'Action Owner', 'Escalate To', 'Manager Review', 'WO', 'Status', 'Priority', 'Location', 'FM', 'Assigned To', 'Trade', 'Vendor', 'Expected Completion Date', 'Next Onsite Date', 'Last Note Date', 'Primary Issue', 'Risk Flags', 'Evidence', 'Audit Confidence', 'Audit Rule IDs', 'Source Row Number'];
  var ACTION_SHEET_WIDTHS = [16, 20, 22, 52, 22, 26, 14, 12, 20, 12, 22, 16, 18, 16, 20, 16, 14, 14, 52, 30, 60, 14, 24, 12];

  // Sort: priority, then due, then Manager Review = YES first, then owner, then oldest first.
  function actionSort(a, b) {
    var ra = ACT_PRIORITY_RANK[a.priorityKey] == null ? 9 : ACT_PRIORITY_RANK[a.priorityKey];
    var rb = ACT_PRIORITY_RANK[b.priorityKey] == null ? 9 : ACT_PRIORITY_RANK[b.priorityKey];
    if (ra !== rb) return ra - rb;
    if (a.dueRank !== b.dueRank) return a.dueRank - b.dueRank;
    var ma = a.managerReviewBool ? 0 : 1, mb = b.managerReviewBool ? 0 : 1;
    if (ma !== mb) return ma - mb;
    var oa = String(a.owner || ''), ob = String(b.owner || '');
    if (oa !== ob) return oa < ob ? -1 : 1;
    var aa = (typeof a.ageDays === 'number') ? a.ageDays : -1;
    var ab = (typeof b.ageDays === 'number') ? b.ageDays : -1;
    return ab - aa;
  }
  // rows: flat row objects carrying the deriveAction fields PLUS the display fields (wo/status/...).
  // Returns an array-of-arrays (header first) for XLSX.utils.aoa_to_sheet. Only actionable rows are
  // kept unless includeMonitor. Pure - the XLSX write itself lives at the impure call site.
  function buildActionListAoa(rows, includeMonitor) {
    var inc = (rows || []).filter(function (r) { return r && (r.include || (includeMonitor && r.priorityKey === 'MON')); });
    inc.sort(actionSort);
    var aoa = [ACTION_SHEET_COLS.slice()];
    for (var i = 0; i < inc.length; i++) {
      var r = inc[i];
      aoa.push([
        r.priority, r.actionDue, r.bucket, r.nextAction, r.owner, r.escalateTo, r.managerReview,
        r.wo, r.status, r.srcPriority, r.location, r.fm, r.assignedTo, r.trade, r.vendor,
        r.ecd, r.nextOnsite, r.lastNoteDate, r.primaryIssue, r.riskFlags, r.evidence,
        r.confidence, r.ruleIds, r.sourceRow
      ]);
    }
    return aoa;
  }
  // ---- QUEUE-GROUPED Action List (0.18.0) ------------------------------------------------------
  // The primary operational worksheet: rows GROUPED under the six work queues (+ Action Undefined),
  // each section self-labelled with its count. Today-work and triage sit first and prominent;
  // Blocked/Waiting is quiet and last. The flat, filterable table lives on Action Diagnostics
  // (buildActionListAoa) for power users - progressive disclosure across two sheets.
  var QUEUE_SHEET_COLS = ['WO', 'Client / Location', 'Priority', 'Next Action', 'Action Owner', 'Due', 'Waiting On', 'Expected Response', 'Definition of Done', 'Blocker', 'Last Meaningful Update', 'Next Scheduled Event', 'Why in Queue', 'Why This Priority', 'Op Risk', 'Actionability', 'Daily Rank', 'Contradictions', 'Src Row'];
  var QUEUE_SHEET_WIDTHS = [12, 26, 22, 52, 22, 16, 18, 16, 46, 18, 34, 18, 44, 40, 8, 12, 10, 34, 8];
  // Queues that are ALWAYS shown (even at zero) so their absence is explicit; the rest appear only
  // when populated.
  var QUEUE_ALWAYS_SHOW = { IMMEDIATE: 1, EXECUTE: 1, FOLLOWUP: 1, UNDEFINED: 1 };
  function queueIncluded(r, includeMonitor) {
    if (!r) return false;
    if (r.queueMonitor) return includeMonitor === true;    // clean terminal / nothing-to-do
    return !!r.actionQueue;
  }
  // Within a queue: priority, then Daily Rank desc, then Op Risk desc, then age desc (age is the
  // final tie-breaker only). Daily Rank already folds in due-urgency and schedule proximity.
  function queueSort(a, b) {
    var ra = QUEUE_PRIORITY_RANK[a.queuePriorityKey] == null ? 9 : QUEUE_PRIORITY_RANK[a.queuePriorityKey];
    var rb = QUEUE_PRIORITY_RANK[b.queuePriorityKey] == null ? 9 : QUEUE_PRIORITY_RANK[b.queuePriorityKey];
    if (ra !== rb) return ra - rb;
    if ((b.dailyRank || 0) !== (a.dailyRank || 0)) return (b.dailyRank || 0) - (a.dailyRank || 0);
    if ((b.operationalRiskScore || 0) !== (a.operationalRiskScore || 0)) return (b.operationalRiskScore || 0) - (a.operationalRiskScore || 0);
    var aa = (typeof a.ageDays === 'number') ? a.ageDays : -1, ab = (typeof b.ageDays === 'number') ? b.ageDays : -1;
    return ab - aa;
  }
  function queueRowCells(r) {
    return [
      r.wo, r.location, r.queuePriority, (r.queueNextAction || r.nextAction || ''), r.actionOwner, r.dueDateTime,
      r.waitingOn || '', r.expectedResponseDate || '', r.definitionOfDone || '', r.blockerCategory || '',
      r.lastMeaningfulUpdate || '', r.nextScheduledEvent || '',
      (r.queueReasons && r.queueReasons.length ? r.queueReasons.join('; ') : ''),
      (r.priorityReasons && r.priorityReasons.length ? r.priorityReasons.join('; ') : ''),
      r.operationalRiskScore, r.actionabilityScore, r.dailyRank,
      (r.contradictions && r.contradictions.length ? r.contradictions.map(function (c) { return c.code; }).join(', ') : ''),
      r.sourceRow
    ];
  }
  // Returns { aoa, counts } - counts is {queueKey: n} for the dashboard's Today totals.
  function buildQueueListAoa(rows, includeMonitor) {
    var inc = (rows || []).filter(function (r) { return queueIncluded(r, includeMonitor); });
    var byQueue = {}, counts = {};
    ACT_QUEUE_DISPLAY.forEach(function (k) { byQueue[k] = []; counts[k] = 0; });
    for (var i = 0; i < inc.length; i++) {
      var r = inc[i];
      for (var k in ACT_QUEUE) { if (ACT_QUEUE[k] === r.actionQueue && byQueue[k]) { byQueue[k].push(r); counts[k]++; break; } }
    }
    var todayTotal = counts.IMMEDIATE + counts.EXECUTE + counts.FOLLOWUP;
    var aoa = [];
    aoa.push(['WO ACTION LIST — operational work queue']);
    aoa.push(['Today (Immediate + Execute + Follow Up): ' + todayTotal + '   |   ' +
      ACT_QUEUE_DISPLAY.map(function (k) { return ACT_QUEUE[k] + ': ' + counts[k]; }).join('   |   ')]);
    aoa.push([]);
    for (var d = 0; d < ACT_QUEUE_DISPLAY.length; d++) {
      var key = ACT_QUEUE_DISPLAY[d], list = byQueue[key];
      if (!list.length && !QUEUE_ALWAYS_SHOW[key]) continue;
      list.sort(queueSort);
      aoa.push(['▶ ' + ACT_QUEUE[key].toUpperCase() + '  (' + list.length + ')']);
      aoa.push(QUEUE_SHEET_COLS.slice());
      if (!list.length) aoa.push(['(none)']);
      for (var j = 0; j < list.length; j++) aoa.push(queueRowCells(list[j]));
      aoa.push([]);
    }
    return { aoa: aoa, counts: counts, todayTotal: todayTotal };
  }

  // Run-date helpers. LOCAL date (the coordinator's day), zero-padded. nowMs injected for the harness.
  function actPad(n) { return (n < 10 ? '0' : '') + n; }
  function actRunDate(ms) { var d = new Date(typeof ms === 'number' ? ms : Date.now()); return d.getFullYear() + '-' + actPad(d.getMonth() + 1) + '-' + actPad(d.getDate()); }
  function actSheetDate(ms) { var d = new Date(typeof ms === 'number' ? ms : Date.now()); return d.getFullYear() + '.' + actPad(d.getMonth() + 1) + '.' + actPad(d.getDate()); }
  // ===== BWN WO-AUDIT ACTIONS END ==================================================================

  // ===== BWN WO-AUDIT DASHBOARD START (pure; sliced by scripts/test-wo-audit-dashboard.js) ========
  // The manager-readable roll-ups + the rule catalog, as array-of-arrays for XLSX.utils.aoa_to_sheet.
  // Everything here is a DETERMINISTIC aggregation of the action rows the engine already produced -
  // no new judgement, no AI. Text-first: section labels in column A, no fills/tables/panes. The
  // Action List sheet carries the one filterable table; the Dashboard is a mixed briefing layout.
  var DASH_PRI_RANK = { P0: 0, P1: 1, P2: 2, MON: 3 };
  // The bucket labels the run summary counts, in reading order (mirrors ACT_BUCKET values).
  var DASH_BUCKETS = ['Overdue ECD', 'Vendor Scheduling', 'Vendor Quote / Proposal', 'Client Approval', 'PO Release', 'Material Delay', 'Completion Verification', 'Closeout / Cost Review', 'Stale Update', 'Data Quality'];
  function dashCount(rows, pred) { var n = 0; for (var i = 0; i < rows.length; i++) { if (pred(rows[i])) n++; } return n; }
  // {key,count}[] sorted by count desc then key asc. Blank/absent keys fold into '(none)'.
  function dashRollup(rows, keyFn) {
    var m = {}, order = [];
    for (var i = 0; i < rows.length; i++) {
      var k = keyFn(rows[i]); if (k == null || k === '') k = '(none)'; k = String(k);
      if (!Object.prototype.hasOwnProperty.call(m, k)) { m[k] = 0; order.push(k); }
      m[k]++;
    }
    return order.map(function (k) { return { key: k, count: m[k] }; })
      .sort(function (a, b) { return (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
  }
  // Manager-review rows, sorted priority -> due -> source row, capped at 20.
  function dashTop20(rows) {
    var mr = rows.filter(function (r) { return r.managerReviewBool; });
    mr.sort(function (a, b) {
      var ra = DASH_PRI_RANK[a.priorityKey] == null ? 9 : DASH_PRI_RANK[a.priorityKey];
      var rb = DASH_PRI_RANK[b.priorityKey] == null ? 9 : DASH_PRI_RANK[b.priorityKey];
      if (ra !== rb) return ra - rb;
      if ((a.dueRank || 0) !== (b.dueRank || 0)) return (a.dueRank || 0) - (b.dueRank || 0);
      return (a.sourceRow || 0) - (b.sourceRow || 0);
    });
    return mr.slice(0, 20);
  }
  // The full deterministic count set the run summary prints. rows = the actionRow objects.
  // Queue keys in reading order + their labels (mirrors ACT_QUEUE; redeclared here so the DASHBOARD
  // slice is self-contained for the harness).
  var DASH_QUEUES = [
    ['IMMEDIATE', 'Immediate Intervention'], ['EXECUTE', 'Execute Today'], ['FOLLOWUP', 'Follow Up Today'],
    ['UNDEFINED', 'Action Undefined / Needs Triage'], ['WATCH', 'Upcoming Watch'],
    ['CLOSEOUT', 'Closeout / Billing Readiness'], ['BLOCKED', 'Blocked / Waiting']
  ];
  function dashboardCounts(rows, total) {
    rows = rows || [];
    var byBucket = {};
    DASH_BUCKETS.forEach(function (b) { byBucket[b] = dashCount(rows, function (r) { return r.bucket === b; }); });
    // ---- work-queue aggregates (0.18.0). All guarded so legacy fixtures without the new fields
    // still return zeros rather than throwing. ----
    var byQueue = {};
    DASH_QUEUES.forEach(function (q) { byQueue[q[0]] = dashCount(rows, function (r) { return r.queueKey === q[0]; }); });
    var undefReasons = {}, contraBySev = { high: 0, medium: 0, low: 0 }, contraByCode = {}, aging = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    rows.forEach(function (r) {
      (r.actionUndefinedReasons || []).forEach(function (x) { undefReasons[x] = (undefReasons[x] || 0) + 1; });
      (r.contradictions || []).forEach(function (c) { if (c && c.severity && contraBySev[c.severity] != null) contraBySev[c.severity]++; if (c && c.code) contraByCode[c.code] = (contraByCode[c.code] || 0) + 1; });
      var a = (typeof r.ageDays === 'number') ? r.ageDays : null;
      if (a != null) aging[a <= 30 ? '0-30' : a <= 60 ? '31-60' : a <= 90 ? '61-90' : '90+']++;
    });
    return {
      total: (typeof total === 'number') ? total : rows.length,
      actionable: dashCount(rows, function (r) { return r.priorityKey !== 'MON'; }),
      monitor: dashCount(rows, function (r) { return r.priorityKey === 'MON'; }),
      p0: dashCount(rows, function (r) { return r.priorityKey === 'P0'; }),
      p1: dashCount(rows, function (r) { return r.priorityKey === 'P1'; }),
      p2: dashCount(rows, function (r) { return r.priorityKey === 'P2'; }),
      overdueEcd: dashCount(rows, function (r) { return /OVERDUE ECD/.test(r.riskFlags || ''); }),
      managerReview: dashCount(rows, function (r) { return r.managerReviewBool; }),
      byBucket: byBucket,
      // work-queue model
      byQueue: byQueue,
      todayTotal: byQueue.IMMEDIATE + byQueue.EXECUTE + byQueue.FOLLOWUP,
      qp0: dashCount(rows, function (r) { return r.queuePriorityKey === 'P0'; }),
      qp1: dashCount(rows, function (r) { return r.queuePriorityKey === 'P1'; }),
      qp2: dashCount(rows, function (r) { return r.queuePriorityKey === 'P2'; }),
      qp3: dashCount(rows, function (r) { return r.queuePriorityKey === 'P3'; }),
      actionUndefined: byQueue.UNDEFINED,
      undefReasons: Object.keys(undefReasons).map(function (k) { return { key: k, count: undefReasons[k] }; }).sort(function (a, b) { return b.count - a.count || (a.key < b.key ? -1 : 1); }),
      validBlocked: dashCount(rows, function (r) { return r.validWaitingState === true; }),
      highRisk: dashCount(rows, function (r) { return (r.operationalRiskScore || 0) >= 60; }),
      highActionability: dashCount(rows, function (r) { return (r.actionabilityScore || 0) >= 60; }),
      contraBySev: contraBySev, contraByCode: contraByCode, aging: aging
    };
  }
  // The priority legend + interpretation, stated once so the sheet and the tests share them.
  var DASH_LEGEND = [
    ['P0 – Immediate', 'Act today. Critical priority with an overdue/uncommitted schedule, or explicit safety language.'],
    ['P1 – Today', 'Act today. Overdue ECD, due today/next business day, or a critical operational exception.'],
    ['P2 – This Week', 'Plan this week. Standard-priority blocker, stale update, or an aging job needing a documented plan.'],
    ['Monitor', 'No action exception. Future schedule or valid future ECD; excluded from the Action List by default.']
  ];
  var DASH_INTERPRETATION = 'This workbook is a rules-based operational triage tool. It highlights conditions found in the exported or live work-order data; it does not replace coordinator judgment, vendor confirmation, or client direction.';

  // buildDashboardAoa(rows, meta) -> aoa. meta: {sheetTitle, runStamp, sourceSheet, mode, includeMonitor, total}
  function buildDashboardAoa(rows, meta) {
    rows = rows || []; meta = meta || {};
    var c = dashboardCounts(rows, meta.total);
    var out = [];
    out.push([meta.sheetTitle || 'WO Audit Dashboard']);
    out.push(['Run: ' + (meta.runStamp || '') + '   |   Source sheet: ' + (meta.sourceSheet || '') + '   |   Mode: ' + (meta.mode || '') + '   |   Include Monitor: ' + (meta.includeMonitor ? 'yes' : 'no')]);
    out.push([]);
    out.push(['PRIORITY LEGEND']);
    DASH_LEGEND.forEach(function (l) { out.push([l[0], l[1]]); });
    out.push([]);
    out.push(['RUN SUMMARY']);
    out.push(['Total work orders reviewed', c.total]);
    out.push(['Actionable work orders', c.actionable]);
    out.push(['Monitor work orders', c.monitor]);
    out.push(['Immediate / P0', c.p0]);
    out.push(['Today / P1', c.p1]);
    out.push(['This Week / P2', c.p2]);
    out.push(['Overdue ECD (flagged, any bucket)', c.overdueEcd]);
    out.push(['Manager Review', c.managerReview]);
    out.push(['— by action bucket —']);
    DASH_BUCKETS.forEach(function (b) { out.push([b, c.byBucket[b]]); });
    out.push([]);
    // ---- WORK QUEUE (0.18.0): the daily operational posture, kept distinct from audit totals ----
    out.push(['WORK QUEUE POSTURE']);
    out.push(['TODAY (Immediate + Execute + Follow Up)', c.todayTotal]);
    DASH_QUEUES.forEach(function (q) { out.push([q[1], c.byQueue[q[0]]]); });
    out.push(['— by queue priority —']);
    out.push(['P0 – Intervene Now', c.qp0]);
    out.push(['P1 – Complete Today', c.qp1]);
    out.push(['P2 – Follow Up / Prepare', c.qp2]);
    out.push(['P3 – Monitor', c.qp3]);
    out.push(['Valid Blocked / Waiting', c.validBlocked]);
    out.push(['High operational risk (>=60)', c.highRisk]);
    out.push(['High actionability (>=60)', c.highActionability]);
    out.push([]);
    out.push(['ACTION UNDEFINED / NEEDS TRIAGE', c.actionUndefined]);
    if (c.undefReasons && c.undefReasons.length) { out.push(['top missing-data reasons', 'count']); c.undefReasons.slice(0, 8).forEach(function (x) { out.push([x.key, x.count]); }); }
    out.push([]);
    out.push(['CONTRADICTIONS BY SEVERITY']);
    out.push(['High', c.contraBySev.high]); out.push(['Medium', c.contraBySev.medium]); out.push(['Low', c.contraBySev.low]);
    var codes = Object.keys(c.contraByCode);
    if (codes.length) { out.push(['— by code —']); codes.sort().forEach(function (k) { out.push([k, c.contraByCode[k]]); }); }
    out.push([]);
    out.push(['AGING (management insight - age raises RISK but never alone creates a daily task)']);
    out.push(['0-30 days', c.aging['0-30']]); out.push(['31-60 days', c.aging['31-60']]);
    out.push(['61-90 days', c.aging['61-90']]); out.push(['90+ days', c.aging['90+']]);
    out.push([]);
    out.push(['BY AUDIT PRIORITY', 'count']);
    dashRollup(rows, function (r) { return r.priority; }).forEach(function (x) { out.push([x.key, x.count]); });
    out.push([]);
    out.push(['BY ACTION BUCKET', 'count']);
    dashRollup(rows, function (r) { return r.bucket; }).forEach(function (x) { out.push([x.key, x.count]); });
    out.push([]);
    out.push(['BY ACTION OWNER', 'count']);
    dashRollup(rows, function (r) { return r.owner; }).forEach(function (x) { out.push([x.key, x.count]); });
    out.push([]);
    out.push(['BY FM', 'count']);
    dashRollup(rows, function (r) { return r.fm; }).forEach(function (x) { out.push([x.key, x.count]); });
    out.push([]);
    out.push(['TOP 20 MANAGER REVIEW']);
    out.push(['Audit Priority', 'Action Due', 'WO', 'Action Bucket', 'Action Owner', 'Primary Issue']);
    dashTop20(rows).forEach(function (r) { out.push([r.priority, r.actionDue, r.wo, r.bucket, r.owner, r.primaryIssue]); });
    return out;
  }

  // The rule catalog, declarative so a new rule is one row not a new branch. Mirrors deriveAction.
  var RULE_CATALOG = [
    { id: 'ECD_OVERDUE', cond: 'Expected completion date is before today, or the live WO reports negative remaining days.', bucket: 'Overdue ECD (or a risk flag on the phase bucket)', priority: 'Raises to P1; P0 when the source priority is critical.', next: 'Review the blocker, record a specific outcome, and reset the ECD to a defensible date.', own: 'Assigned To; escalates to Operations Manager (esp. when >7 days overdue or unassigned).', evid: 'Prints the ECD and its lapsed state.', limits: 'A lapsed ECD reads TBD in the note; no calendar date is invented.' },
    { id: 'VENDOR_SCHEDULING', cond: 'Phase is intake / pending-schedule / recruiting-vendor / awaiting-acceptance / recall with no confirmed on-site date.', bucket: 'Vendor Scheduling', priority: 'P2; P1 when overdue/critical; P0 when critical + exception.', next: 'Obtain a confirmed on-site date, technician commitment, and next update from the vendor.', own: 'Assigned To; escalate Vendor Manager (+ Operations Manager when at risk).', evid: 'Status, any next-onsite date, NO VENDOR / UNSCHEDULED flags.', limits: 'A missing vendor is an internal dispatch gap, never blamed on the vendor.' },
    { id: 'PROPOSAL_OR_QUOTE', cond: 'Phase indicates a vendor quote/proposal is being prepared but not yet a client proposal.', bucket: 'Vendor Quote / Proposal', priority: 'P2; P1 when overdue/critical.', next: 'Obtain the complete vendor quote, validate scope/cost, submit or revise the client proposal.', own: 'Assigned To; escalate Vendor Manager.', evid: 'Status + QUOTE/PROPOSAL BLOCKER flag.', limits: 'Financial detail is never invented; cited only when the evidence carries it.' },
    { id: 'CLIENT_APPROVAL', cond: 'Status/phase is proposed / awaiting client approval / client action required.', bucket: 'Client Approval', priority: 'P2; P1 when overdue/critical.', next: 'Confirm the approval owner, decision status, and decision due date.', own: 'Assigned To; escalate Client Approval Owner (+ Operations Manager when overdue/stale).', evid: 'Status + CLIENT APPROVAL PENDING / CLIENT UPDATE OVERDUE flags.', limits: 'No ECD gap is raised at this phase (an ECD is not expected yet).' },
    { id: 'PO_RELEASE', cond: 'Proposal approved but the vendor purchase order has not been released.', bucket: 'PO Release', priority: 'P2; P1 when a scheduled visit or ECD is at risk.', next: 'Confirm the PO is issued and released to the vendor; document the release.', own: 'Assigned To; escalate PO / Finance Owner.', evid: 'Status + PO RELEASE PENDING flag.', limits: 'Does not confirm PO existence in a finance system; a documentation prompt only.' },
    { id: 'MATERIALS', cond: 'Phase indicates materials/parts pending (ordered, backorder, fabrication, in transit).', bucket: 'Material Delay', priority: 'P2; P1 when overdue/critical.', next: 'Obtain the delivery date, confirm receipt, and secure the return-visit date after delivery.', own: 'Assigned To; vendor as contributing party; escalate Vendor Manager.', evid: 'Status + MATERIALS PENDING flag; delivery detail only when the note carries it.', limits: 'Refines a blocker only where a note affirms backorder/lead-time/in-transit.' },
    { id: 'ON_SITE_OR_SCHEDULED_FOLLOWUP', cond: 'Status is Scheduled / On-site / Awaiting 3rd party and the visit date has passed with no completion outcome.', bucket: 'Completion Verification', priority: 'P2 (due next business day); P1 when overdue/critical.', next: 'Obtain the vendor completion report, confirm completed vs remaining scope, update status/ECD.', own: 'Assigned To; escalate Vendor Manager (+ Operations Manager).', evid: 'Status, next-onsite date, COMPLETION UPDATE MISSING flag.', limits: 'A future-dated visit is Monitor, not a verification miss.' },
    { id: 'CLOSEOUT', cond: 'Status is Clocked Out Complete / Complete, or a note indicates final cost review / billing pending.', bucket: 'Closeout / Cost Review', priority: 'P2 (due this week).', next: 'Confirm final vendor cost, completion documentation, and billing/closure readiness.', own: 'Assigned To; escalate Operations Manager when it lingers.', evid: 'Status + CLOSEOUT PENDING flag.', limits: 'Not raised from stale-update alone on an otherwise complete job unless closeout is pending.' },
    { id: 'STALE_UPDATE', cond: 'Newest meaningful note is older than the configured threshold (P1 2 / P2 3 / P3-P4 5 business days; default 7).', bucket: 'Stale Update (or a risk flag on the phase bucket)', priority: 'Adds urgency; does not by itself set P0.', next: 'Post an outcome-based update: current blocker, responsible party, next commitment, revised ECD.', own: 'Assigned To (chasing a status is internal work, not fault).', evid: 'Days since the last meaningful note.', limits: 'Never assigns blame or invents a blocker; lowers confidence only.' },
    { id: 'DATA_QUALITY', cond: 'Missing WO number / status, ERRORNAME-style assignee, unreadable live record, or conflicting status vs schedule.', bucket: 'Data Quality', priority: 'Forces Manager Review; confidence Review Needed.', next: 'Correct the missing or conflicting workflow data before the WO can be reliably managed.', own: 'Assigned To if valid, otherwise Unassigned – Manager Review.', evid: 'The specific gap(s) in Audit Data Gaps.', limits: 'Seizes the bucket only when there is no other actionable signal.' },
    { id: 'SAFETY_OR_CRITICAL_SCOPE', cond: 'Explicit safety / business-continuity language in Scope or Notes (unsafe, exposed wiring, downed pole, structural damage, no power, ...).', bucket: 'Adds a SAFETY/CRITICAL RISK flag to the phase bucket.', priority: 'Raises to P0 when combined with an actionable blocker; always included.', next: 'Follows the phase bucket; the matched safety text is preserved in Evidence.', own: 'Phase owner; always Manager Review.', evid: 'The exact matched source text.', limits: 'Never inferred from a bare high priority; explicit text only.' }
  ];
  var RULE_CATALOG_COLS = ['Rule ID', 'Trigger / Condition', 'Action Bucket', 'Priority Effect', 'Required Next Action', 'Ownership / Escalation', 'Evidence', 'Limitations / Confidence'];

  // buildAuditRulesAoa(meta) -> aoa. meta carries the run configuration for the transparency block.
  function buildAuditRulesAoa(meta) {
    meta = meta || {};
    var out = [];
    out.push([meta.sheetTitle || 'Audit Rules']);
    out.push([DASH_INTERPRETATION]);
    out.push([]);
    out.push(RULE_CATALOG_COLS.slice());
    RULE_CATALOG.forEach(function (r) { out.push([r.id, r.cond, r.bucket, r.priority, r.next, r.own, r.evid, r.limits]); });
    out.push([]);
    out.push(['RUN CONFIGURATION']);
    out.push(['Output mode', meta.mode || '']);
    out.push(['Include Monitor items', meta.includeMonitor ? 'yes' : 'no']);
    out.push(['Enabled checks', meta.checks || '']);
    out.push(['Client-update threshold (days)', (meta.clientDays == null ? '' : meta.clientDays)]);
    out.push(['Run date/time', meta.runStamp || '']);
    out.push(['Source sheet', meta.sourceSheet || '']);
    out.push(['WO # column', meta.woCol || '']);
    out.push(['Notes column', meta.noteCol || '']);
    // ---- WORK-QUEUE METHODOLOGY (0.18.0). Text rows only - the legacy RULE_CATALOG above is
    // unchanged. Weights come from meta (live ACT_CFG) with a literal fallback so the sheet is
    // truthful whether or not the caller passed them. ----
    var w = meta.weights || { actionability: 1.0, operationalRisk: 0.6, dueUrgency: 0.4, scheduleProximity: 0.2, escalationRisk: 0.25, dataQuality: 0.15, validWaiting: 0.9 };
    out.push([]);
    out.push(['WORK-QUEUE MODEL (0.18.0)']);
    out.push(['Queue classification order (first match wins)', 'Immediate Intervention > Closeout/Billing > Execute Today > Follow Up Today > Upcoming Watch > Blocked/Waiting > Action Undefined']);
    out.push(['Priority decision order', 'P0 Intervene Now > P1 Complete Today > P2 Follow Up/Prepare > P3 Monitor. Source priority alone never makes P0.']);
    out.push(['Two independent scores', 'Operational Risk = exposure if unmanaged (0-100). Actionability = a concrete Broadway step exists today (0-100). Shown separately, never merged into one number.']);
    out.push(['Daily Rank formula', 'rank = ' + w.actionability + '*Actionability + ' + w.operationalRisk + '*OpRisk + ' + w.dueUrgency + '*DueUrgency + ' + w.scheduleProximity + '*ScheduleProximity + ' + w.escalationRisk + '*EscalationRisk + ' + w.dataQuality + '*DataQuality - ' + w.validWaiting + '*ValidWaiting. Immediate Intervention pins above all numeric ranks. Actionability is the largest normal contributor; age is only a limited risk modifier.']);
    out.push(['Valid waiting state requires ALL of', 'a recognized waiting-on party, a meaningful reason, a future expected response/follow-up date, and a defined owner - and no live exception. Missing any element -> not validly blocked (flagged, not parked).']);
    out.push(['Meaningful update', 'A note counts only with operational substance (outcome, blocker, party, date, next step, ETA, proposal/decision, completion, scope, materials, vendor confirmation). Bare "LVM / following up / emailed vendor / updated" do not reset the clock. Raw latest-note date is preserved separately.']);
    out.push(['Onsite date expected when', 'phase is pending-schedule / scheduled / on-site / in-progress / recall. Only then is a blank Next Onsite a "Schedule Required but Missing" gap.']);
    out.push(['ECD expected when', 'work is scheduled/in-progress, vendor+scope known, proposal approved / PO issued, materials ETA supports a forecast, go-back scope defined, or closeout. Early proposal / client-approval / undefined-scope phases need a decision or follow-up date instead - a blank ECD there is NOT penalized.']);
    out.push(['Contradiction checks enabled', 'SCHEDULED_NO_FUTURE_VISIT, COMPLETE_REMAINING_SCOPE, MATERIAL_DATE_EXPIRED, AWAITING_3P_NO_DATE, PROPOSED_NO_DECISION_DATE, ONSITE_NO_SAMEDAY_OUTCOME, PENDING_SCHEDULE_NO_VENDOR, CLIENT_ACTION_NO_OWNER, COMPLETE_NO_CLOSEOUT_EVIDENCE, FUTURE_ECD_PRIOR_VISIT_PASSED, WAITING_NO_RESPONSE_DATE, CLOSED_WITH_OPEN_SIGNAL.']);
    out.push(['Source-data limitations', 'Proposal AMOUNT and proposal SUBMISSION date are not exposed to this tool, so the "Proposed with no proposal amount/submission date" check is narrowed to a decision-date check. Repeat-dispatch history is not exposed, so repeat-visit risk is not detected. Due labels are operational targets, never invented calendar dates.']);
    return out;
  }
  // The count of the rule catalog's data columns, so the Audit Rules autofilter spans the table only.
  var RULE_CATALOG_HEADER_ROW = 3;   // 0-based row index of RULE_CATALOG_COLS in buildAuditRulesAoa
  // ===== BWN WO-AUDIT DASHBOARD END ================================================================

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
  // ===== BWN WO-AUDIT MAP START (findCol/mapSheet aliases; sliced by scripts/test-wo-audit-dashboard.js) =====
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
      location: findCol(hdr, [/location|site|store|^asset$/i]),
      days: findCol(hdr, [/aged|days\s*open|^#?\s*days$/i]),
      assigned: findCol(hdr, [/assigned\s*to|coordinator|^owner$/i]),
      note: findNoteCol(hdr),
      noteAppended: false,
      flag: findFlagCol(hdr),
      flagAppended: false,
      // Operations Action List fields (0.17.0). Auto-detected only; live Umbrava data is the primary
      // source for status/priority/trade/vendor/ECD/next-onsite, so these are display/fallback columns
      // and never override the live read. An override UI is Commit 2. -1 = absent (recorded as a gap).
      fm: findCol(hdr, [/^fm$/i, /facility\s*manager/i]),
      priority: findCol(hdr, [/^priority$/i]),
      trade: findCol(hdr, [/^trades?$/i]),
      vendor: findCol(hdr, [/^vendors?$/i]),
      scope: findCol(hdr, [/scope\s*of\s*work/i, /^scope$/i]),
      ecd: findCol(hdr, [/expected\s*completion/i, /^ecd$/i]),
      nextOnsite: findCol(hdr, [/next\s*onsite/i, /scheduled\s*date/i]),
      lastNote: findCol(hdr, [/last\s*note\s*date/i, /latest\s*update/i]),
      statusHours: findCol(hdr, [/status\s*hrs?\.?/i, /status\s*hours/i, /age\s*in\s*status/i]),
      po: findCol(hdr, [/source\s*po/i, /^po\s*#?$/i]),
      nte: findCol(hdr, [/total\s*vendor\s*nte/i, /vendor\s*nte/i, /^nte$/i]),
      type: findCol(hdr, [/^type$/i]),
      action: null,          // ensureActionCols fills this {colName: index} map on first write
      actionAppended: false,
    };
    map.noteName = map.note > -1 ? hdr[map.note] : null;
    map.flagName = map.flag > -1 ? hdr[map.flag] : null;
    map.aoa = aoa;
    return map;
  }
  // ===== BWN WO-AUDIT MAP END ======================================================================
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

  // Ensure the 16 Operations Action List columns (ACTION_SOURCE_COLS) exist on the worksheet, in
  // order, after the last used column. On a recurring audit the workbook may already carry them (our
  // own prior output): those are REUSED by exact header name rather than duplicated - low clobber risk
  // because they are this tool's columns, not the client's data (unlike the Notes/Flags columns, which
  // keep their new/reuse + acknowledgement protections). Returns map.action = {header: colIndex, ...}.
  // Guarded by actionAppended so a retry never appends a second block.
  function ensureActionCols(ws, map) {
    if (map.action) return map;
    var range = XLSX.utils.decode_range(ws['!ref']);
    var hdr = (map.aoa[map.headerRow] || []).map(function (x) { return String(x == null ? '' : x); });
    var idx = {};
    var next = range.e.c + 1;
    for (var i = 0; i < ACTION_SOURCE_COLS.length; i++) {
      var name = ACTION_SOURCE_COLS[i];
      var found = -1;
      for (var c = 0; c < hdr.length; c++) { if (hdr[c] === name) { found = c; break; } }
      if (found === -1) {
        found = next++;
        ws[XLSX.utils.encode_cell({ c: found, r: map.headerRow })] = { t: 's', v: name };
      }
      idx[name] = found;
    }
    if (next - 1 > range.e.c) { range.e.c = next - 1; ws['!ref'] = XLSX.utils.encode_range(range); }
    map.action = idx; map.actionAppended = true;
    return map;
  }
  // Append a generated worksheet from an array-of-arrays, replacing any same-named sheet (so a
  // repeat download rebuilds it rather than throwing on a duplicate name). Optional column widths.
  // Impure (XLSX), so it sits with the other worksheet helpers, not in a pure sliced block.
  function appendAoaSheet(wb, name, aoa, widths) {
    var sh = XLSX.utils.aoa_to_sheet(aoa);
    if (widths) sh['!cols'] = widths.map(function (w) { return { wch: w }; });
    if (wb.Sheets[name]) {
      delete wb.Sheets[name];
      var i = wb.SheetNames.indexOf(name);
      if (i > -1) wb.SheetNames.splice(i, 1);
    }
    XLSX.utils.book_append_sheet(wb, sh, name);
    return sh;
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

  // Scoped once under #bwn-woaudit-ov so it can't leak to Core's sheet or the other suite drawers.
  // Only styles this tool's own body controls - the drawer chrome (.bwn-drawer*) stays Core's.
  function injectStyle() {
    if (document.getElementById('bwn-woaudit-css')) return;
    var st = document.createElement('style');
    st.id = 'bwn-woaudit-css';
    var G = GREEN, ACC = '#1a7a4c', AMBER = '#b7791f', RED = '#b42318', BLUE = '#175cd3';
    var P = '#bwn-woaudit-ov ';
    st.textContent = [
      // ---- shell: widen the drawer for this tool; off-white body behind white cards ----
      P + '.bwn-drawer-body,' + P + '{box-sizing:border-box}',
      P + '*,' + P + '*::before,' + P + '*::after{box-sizing:border-box}',
      // Geometry stays Core\'s: left-anchored off the dock rail, sliding in from the left with the
      // bwn-drawer-in keyframe (the redesign briefly forced it to the right; reverted). Only WIDEN it
      // past Core\'s 420px so the two-column layout can engage - Core\'s left + max-width + transform hold.
      '#bwn-woaudit-ov.bwn-drawer{width:min(820px,86vw);background:#eef2f0;color:#243530;font-size:13px;line-height:1.5}',
      P + '.woa-box{display:flex;flex-direction:column;flex:1;min-height:0}',
      P + '.woa-i{flex:0 0 auto;vertical-align:middle}',
      // ---- header ----
      P + '.woa-hd{background:linear-gradient(160deg,' + G + ' 0%,#0a3220 100%);color:#eaf3ee;padding:16px 20px 14px;display:flex;align-items:flex-start;gap:12px}',
      P + '.woa-hd-txt{flex:1;min-width:0}',
      P + '.woa-eyebrow{font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8fc9ac;margin:0 0 3px}',
      P + '.woa-title{font-size:19px;font-weight:700;letter-spacing:-.01em;margin:0;color:#fff}',
      P + '.woa-sub{font-size:12.5px;color:#b7d3c5;margin:3px 0 0}',
      P + '.woa-x{flex:0 0 auto;background:rgba(255,255,255,.12);border:0;color:#eaf3ee;width:30px;height:30px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s}',
      P + '.woa-x:hover{background:rgba(255,255,255,.24)}',
      P + '.woa-pill{flex:0 0 auto;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.14);color:#eaf3ee;white-space:nowrap}',
      P + '.woa-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}',
      P + '.woa-pill.is-ready{color:#bfe3d0}',
      P + '.woa-pill.is-proc{color:#ffe08a}',
      P + '.woa-pill.is-done{color:#7be0a6}',
      P + '.woa-pill.is-warn{color:#ffc4a3}',
      // ---- step indicator ----
      P + '.woa-steps{display:flex;gap:4px;padding:12px 20px;background:#dfe7e2;border-bottom:1px solid #cdd9d2;overflow-x:auto}',
      P + '.woa-step{flex:1 1 0;min-width:92px;display:flex;align-items:center;gap:8px;font-size:11.5px;color:#6b7c74;font-weight:600}',
      P + '.woa-step-n{flex:0 0 auto;width:20px;height:20px;border-radius:50%;background:#c2cec7;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}',
      P + '.woa-step.is-active{color:' + G + '}',
      P + '.woa-step.is-active .woa-step-n{background:' + G + '}',
      P + '.woa-step.is-done{color:' + ACC + '}',
      P + '.woa-step.is-done .woa-step-n{background:' + ACC + '}',
      // ---- layout ----
      P + '.woa-scroll{flex:1;min-height:0;overflow:auto;padding:16px 20px 20px}',
      P + '.woa-grid{display:grid;grid-template-columns:1fr;gap:16px}',
      '@media (min-width:760px){' + P + '.woa-grid{grid-template-columns:1.35fr 1fr}}',
      P + '.woa-col{display:flex;flex-direction:column;gap:16px;min-width:0}',
      // ---- cards ----
      P + '.woa-card{background:#fff;border:1px solid #e3e9e5;border-radius:12px;box-shadow:0 1px 2px rgba(16,40,30,.04);overflow:hidden}',
      P + '.woa-card-hd{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #eef2f0;color:' + G + ';font-weight:700;font-size:12.5px}',
      P + '.woa-card-hd .woa-count{margin-left:auto;font-weight:600;font-size:11px;color:#6b7c74}',
      P + '.woa-card-b{padding:14px}',
      // ---- drop zone ----
      P + '.woa-drop{border:2px dashed #cfdbd4;border-radius:10px;background:#f7faf8;padding:24px 16px;text-align:center;cursor:pointer;transition:border-color .12s,background .12s}',
      P + '.woa-drop:hover,' + P + '.woa-drop:focus-visible{border-color:' + ACC + ';background:#eef6f1;outline:none}',
      P + '.woa-drop.is-drag{border-color:' + ACC + ';background:#e6f2ec}',
      P + '.woa-drop-ic{color:' + ACC + ';margin-bottom:6px}',
      P + '.woa-drop-ic svg{width:30px;height:30px}',
      P + '.woa-drop-t{font-weight:700;font-size:13.5px;color:#243530}',
      P + '.woa-drop-s{font-size:12px;color:#6b7c74;margin-top:2px}',
      P + '.woa-browse{color:' + ACC + ';font-weight:700;text-decoration:underline}',
      P + '.woa-drop-x{font-size:11px;color:#8a988f;margin-top:8px}',
      // ---- file card (selected state) ----
      P + '.woa-file{display:flex;flex-direction:column;gap:12px}',
      P + '.woa-file-row{display:flex;align-items:center;gap:10px}',
      P + '.woa-file-ic{flex:0 0 auto;width:38px;height:38px;border-radius:9px;background:#e8f2ec;color:' + ACC + ';display:flex;align-items:center;justify-content:center}',
      P + '.woa-file-name{font-weight:700;font-size:13px;word-break:break-all}',
      P + '.woa-file-size{font-size:11.5px;color:#6b7c74}',
      P + '.woa-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}',
      P + '.woa-meta-k{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:#8a988f;font-weight:700}',
      P + '.woa-meta-v{font-size:12.5px;color:#243530;font-weight:600}',
      P + '.woa-meta-v.is-miss{color:' + RED + '}',
      P + '.woa-file-acts{display:flex;gap:14px}',
      // ---- banners ----
      P + '.woa-banner{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:9px;font-size:12px;line-height:1.45;border:1px solid}',
      P + '.woa-banner .woa-i{margin-top:1px}',
      P + '.woa-banner.is-info{background:#eef4fb;border-color:#c7dbf5;color:#1a3f74}',
      P + '.woa-banner.is-warn{background:#fdf6ea;border-color:#f0dcae;color:#7a5410}',
      P + '.woa-banner.is-err{background:#fdeceb;border-color:#f3c9c5;color:#8f231c}',
      P + '.woa-banner.is-ok{background:#ecf6f0;border-color:#bfe3cf;color:#155c38}',
      // ---- fields ----
      P + '.woa-field{margin-bottom:14px}',
      P + '.woa-field:last-child{margin-bottom:0}',
      P + '.woa-lbl{display:block;font-weight:700;font-size:12px;color:#243530;margin:0 0 4px}',
      P + '.woa-help{font-size:11.5px;color:#6b7c74;margin:0 0 7px;line-height:1.45}',
      P + '.woa-select{width:100%;padding:8px 10px;border:1px solid #cfdbd4;border-radius:8px;background:#fff;font:13px ' + FONT + ';color:#243530}',
      P + '.woa-select:focus,' + P + 'input:focus-visible,' + P + '.woa-seg-btn:focus-visible{outline:2px solid rgba(26,122,76,.4);outline-offset:1px;border-color:' + ACC + '}',
      // ---- radios / ack ----
      P + '.woa-radio{display:flex;gap:9px;align-items:flex-start;padding:9px 10px;border:1px solid #e3e9e5;border-radius:9px;margin-bottom:7px;cursor:pointer}',
      P + '.woa-radio.is-on{border-color:' + ACC + ';background:#f2f9f5}',
      P + '.woa-radio input{margin-top:2px}',
      P + '.woa-radio-t{font-weight:600;font-size:12.5px}',
      P + '.woa-radio-s{font-size:11.5px;color:#6b7c74}',
      P + '.woa-ack{display:none;gap:8px;align-items:flex-start;margin-top:2px;padding:9px 10px;border-radius:8px;background:#fdf6ea;border:1px solid #f0dcae;color:#7a5410;font-size:12px}',
      P + '.woa-ack.is-show{display:flex}',
      // ---- check toggles ----
      P + '.woa-check{display:flex;gap:10px;align-items:flex-start;padding:9px 2px}',
      P + '.woa-check+' + '.woa-check{border-top:1px solid #f0f3f1}',
      P + '.woa-check-txt{flex:1;min-width:0}',
      P + '.woa-check-t{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:7px}',
      P + '.woa-check-s{font-size:11.5px;color:#6b7c74;margin-top:1px}',
      P + '.woa-badge{font-size:9.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:5px;background:#eef2f0;color:#8a988f}',
      // switch
      P + '.woa-sw{flex:0 0 auto;position:relative;width:38px;height:22px;margin-top:1px}',
      P + '.woa-sw input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}',
      P + '.woa-sw-t{position:absolute;inset:0;background:#c8d2cc;border-radius:999px;transition:background .14s}',
      P + '.woa-sw-t::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;background:#fff;border-radius:50%;transition:transform .14s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
      P + '.woa-sw input:checked+.woa-sw-t{background:' + ACC + '}',
      P + '.woa-sw input:checked+.woa-sw-t::after{transform:translateX(16px)}',
      P + '.woa-sw input:disabled+.woa-sw-t{opacity:.45}',
      P + '.woa-sw input:focus-visible+.woa-sw-t{outline:2px solid rgba(26,122,76,.5);outline-offset:2px}',
      // ---- speed segmented ----
      P + '.woa-seg{display:flex;gap:0;border:1px solid #cfdbd4;border-radius:9px;overflow:hidden}',
      P + '.woa-seg-btn{flex:1;border:0;border-right:1px solid #cfdbd4;background:#fff;padding:8px 6px;font:600 12px ' + FONT + ';color:#5f6f68;cursor:pointer;transition:background .12s}',
      P + '.woa-seg-btn:last-child{border-right:0}',
      P + '.woa-seg-btn.is-on{background:' + G + ';color:#fff}',
      P + '.woa-speed-note{font-size:11.5px;color:#6b7c74;margin-top:7px}',
      P + '.woa-adv{display:flex;align-items:center;gap:8px;margin-top:9px;font-size:12px;color:#5f6f68}',
      P + '.woa-adv input{width:56px;padding:5px 7px;border:1px solid #cfdbd4;border-radius:7px;font:13px ' + FONT + '}',
      P + '.woa-days{width:42px;padding:2px 5px;margin:0 2px;border:1px solid #cfdbd4;border-radius:6px;font:12px ' + FONT + ';text-align:center;vertical-align:baseline}',
      // ---- progress ----
      P + '.woa-progress{display:none}',
      P + '.woa-progress.is-show{display:block}',
      P + '.woa-prog-top{display:flex;align-items:baseline;gap:8px}',
      P + '.woa-prog-num{font-size:26px;font-weight:800;letter-spacing:-.02em;color:' + G + ';font-variant-numeric:tabular-nums}',
      P + '.woa-prog-pct{font-size:13px;font-weight:700;color:#6b7c74;margin-left:auto}',
      P + '.woa-bar{height:8px;border-radius:999px;background:#e6ece9;overflow:hidden;margin:8px 0 2px}',
      P + '.woa-bar-fill{height:100%;width:0;background:linear-gradient(90deg,' + ACC + ',' + G + ');border-radius:999px;transition:width .3s ease}',
      P + '.woa-cur{font-size:11.5px;color:#6b7c74;margin-top:6px;min-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
      P + '.woa-eta{font-size:11.5px;color:#8a988f;margin-top:2px}',
      P + '.woa-counters{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}',
      P + '.woa-counter{text-align:center;padding:8px 4px;border-radius:9px;background:#f4f7f5;border:1px solid #eef2f0}',
      P + '.woa-counter b{display:block;font-size:17px;font-weight:800;font-variant-numeric:tabular-nums}',
      P + '.woa-counter span{font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#8a988f;font-weight:700}',
      P + '.woa-counter.c-ok b{color:' + ACC + '}',
      P + '.woa-counter.c-flag b{color:' + AMBER + '}',
      P + '.woa-counter.c-skip b{color:#6b7c74}',
      P + '.woa-counter.c-err b{color:' + RED + '}',
      P + '.woa-run-ctrls{display:none;gap:8px;margin-top:12px}',
      P + '.woa-run-ctrls.is-show{display:flex}',
      // ---- live log ----
      P + '.woa-log-hd{display:flex;align-items:center;gap:6px}',
      P + '.woa-log-acts{margin-left:auto;display:flex;gap:4px}',
      P + '.woa-logbtn{border:1px solid #e3e9e5;background:#fff;border-radius:7px;padding:3px 8px;font:600 10.5px ' + FONT + ';color:#5f6f68;cursor:pointer;display:inline-flex;align-items:center;gap:4px}',
      P + '.woa-logbtn:hover{background:#f4f7f5}',
      P + '.woa-logbtn.is-on{background:' + G + ';color:#fff;border-color:' + G + '}',
      P + '.woa-logbtn .woa-i{width:12px;height:12px}',
      P + '#bwn-woaudit-log{font:11.5px ui-monospace,Consolas,monospace;background:#0f1c16;color:#c7dccf;border-radius:9px;padding:10px 11px;height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}',
      P + '#bwn-woaudit-log .l-err{color:#ff9f8f}',
      P + '#bwn-woaudit-log .l-warn{color:#ffd27a}',
      P + '#bwn-woaudit-log .l-ok{color:#8fe0ac}',
      P + '#bwn-woaudit-log .l-ts{color:#5c7166}',
      P + '#bwn-woaudit-log .l-wait{color:#9fb3a8}',
      P + '.woa-log-empty{font:11.5px ui-monospace,Consolas,monospace;color:#8a988f;padding:14px 2px;text-align:center}',
      // ---- actions ----
      P + '.woa-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px;padding-top:14px;border-top:1px solid #e3e9e5}',
      P + '.woa-btn{display:inline-flex;align-items:center;gap:7px;border:1px solid transparent;border-radius:9px;padding:10px 18px;font:700 13px ' + FONT + ';cursor:pointer;transition:filter .12s,background .12s}',
      P + '.woa-btn .woa-i{width:16px;height:16px}',
      P + '.woa-btn:disabled{opacity:.5;cursor:not-allowed}',
      P + '.woa-btn-primary{background:' + G + ';color:#fff}',
      P + '.woa-btn-primary:hover:not(:disabled){filter:brightness(1.12)}',
      P + '.woa-btn-primary.is-complete{background:' + ACC + '}',
      P + '.woa-btn-dl{background:' + ACC + ';color:#fff}',
      P + '.woa-btn-dl:hover:not(:disabled){filter:brightness(1.1)}',
      P + '.woa-btn-ghost{background:#fff;border-color:#cfdbd4;color:#5f6f68}',
      P + '.woa-btn-ghost:hover:not(:disabled){background:#f4f7f5}',
      P + '.woa-btn-cancel{background:#fff;border-color:#e6c3bf;color:' + RED + '}',
      P + '.woa-btn-cancel:hover:not(:disabled){background:#fdeceb}',
      P + '.woa-btn-retry{background:#fff;border-color:#f0dcae;color:' + AMBER + '}',
      P + '.woa-btn-retry:hover:not(:disabled){background:#fdf6ea}',
      P + '.woa-spacer{flex:1}',
      // ---- disclosure / fine print ----
      P + '.woa-disc{margin-top:12px;border:1px solid #e3e9e5;border-radius:9px;background:#fff;overflow:hidden}',
      P + '.woa-disc>summary{cursor:pointer;padding:10px 12px;font-weight:600;font-size:12px;color:' + G + ';list-style:none;display:flex;align-items:center;gap:7px}',
      P + '.woa-disc>summary::-webkit-details-marker{display:none}',
      P + '.woa-disc[open]>summary{border-bottom:1px solid #eef2f0}',
      P + '.woa-disc-b{padding:11px 13px;font-size:12px;color:#4a5852;line-height:1.55}',
      P + '.woa-disc-b ul{margin:0;padding-left:18px}',
      P + '.woa-disc-b li{margin:3px 0}',
      // ---- run diagnostics + post section (renderDiagnostics / renderPostSection) ----
      P + '#bwn-woaudit-post{margin-top:4px}',
      P + '.woa-sect{margin-top:16px;border-top:1px solid #e3e9e5;padding-top:14px}',
      P + '.woa-sect-hd{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13px;color:' + G + ';margin:0 0 4px}',
      P + '.woa-sect-hd .woa-i{width:16px;height:16px}',
      P + '.woa-sect-sub{font-size:12px;color:#5f6f68;margin:0 0 10px;line-height:1.45}',
      P + '.woa-diag-copy{margin-top:2px}',
      P + '.woa-pcard{border:1px solid #e3e9e5;border-radius:10px;padding:11px;margin-bottom:9px;background:#fff}',
      P + '.woa-pcard-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:7px}',
      P + '.woa-pcard-t{font-weight:700;font-size:12.5px;color:#243530}',
      P + '.woa-pstatus{font-size:11.5px;color:#5f6f68;text-align:right}',
      P + '.woa-pstatus.is-ok{color:' + ACC + ';font-weight:700}',
      P + '.woa-pstatus.is-block{color:' + AMBER + '}',
      P + '.woa-pstatus.is-fail{color:' + RED + '}',
      P + '.woa-pfacts{font-size:11.5px;color:#2f4a39;background:#f2f9f5;border:1px solid #cfe6d9;border-radius:8px;padding:6px 8px;margin-bottom:7px;line-height:1.5}',
      P + '.woa-pmeta{font-size:11.5px;color:#5f6f68;margin-bottom:7px;line-height:1.5;white-space:pre-line}',
      P + '.woa-pnote{width:100%;box-sizing:border-box;min-height:58px;font:12px ui-monospace,Consolas,monospace;border:1px solid #cfdbd4;border-radius:8px;padding:7px;resize:vertical;background:#f7faf8;color:#243530}',
      P + '.woa-btn-sm{padding:7px 14px;font-size:12px;margin-top:8px}',
      // hide legacy nodes we keep in the DOM for the engine but no longer show inline
      // hide legacy nodes we keep in the DOM for the engine but no longer show inline
      P + '#bwn-woaudit-mapinfo{display:none}',
      P + '#bwn-woaudit-conc{display:none}',
      P + '#bwn-woaudit-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
      // No CSS keyframe animations in this module (the progress bar uses a width transition only);
      // this still honours reduced motion by dropping the transitions.
      '@media (prefers-reduced-motion:reduce){#bwn-woaudit-ov *{transition:none!important}}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  function buildModal() {
    if (document.getElementById('bwn-woaudit-ov')) return;
    injectStyle();
    // Suite drawer: slides out from the dock rail, styled by Core's page-wide sheet.
    var ov = document.createElement('aside');
    ov.id = 'bwn-woaudit-ov'; ov.className = 'bwn-drawer';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'WO Audit');
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }
    var box = document.createElement('div');
    box.className = 'woa-box';
    // Small markup builders (run once, at build time).
    var step = function (n, label, id, cls) { return '<div class="woa-step ' + cls + '" id="' + id + '"><span class="woa-step-n">' + n + '</span><span class="woa-step-t">' + label + '</span></div>'; };
    var card = function (title, icon, countId, body) { return '<section class="woa-card"><div class="woa-card-hd">' + icon + '<span>' + title + '</span>' + (countId ? '<span class="woa-count" id="' + countId + '"></span>' : '') + '</div><div class="woa-card-b">' + body + '</div></section>'; };
    var radio = function (id, name, val, t, s, on) { return '<label class="woa-radio' + (on ? ' is-on' : '') + '" id="' + id + '-l"><input type="radio" name="' + name + '" value="' + val + '" id="' + id + '"' + (on ? ' checked' : '') + '><span><span class="woa-radio-t">' + t + '</span><span class="woa-radio-s">' + s + '</span></span></label>'; };
    var chk = function (key, t, s, on, soon) { return '<div class="woa-check"><div class="woa-check-txt"><div class="woa-check-t">' + t + (soon ? ' <span class="woa-badge">Coming soon</span>' : '') + '</div><div class="woa-check-s">' + s + '</div></div><label class="woa-sw"><input type="checkbox" id="woa-chk-' + key + '"' + (on ? ' checked' : '') + (soon ? ' disabled' : '') + ' aria-label="' + t + '"><span class="woa-sw-t"></span></label></div>'; };
    var counter = function (id, label, cls) { return '<div class="woa-counter ' + cls + '"><b id="' + id + '">0</b><span>' + label + '</span></div>'; };

    box.innerHTML =
      '<header class="woa-hd">' +
        '<div class="woa-hd-txt">' +
          '<div class="woa-eyebrow">Work Order Operations</div>' +
          '<h2 class="woa-title" id="bwn-woaudit-ttl">WO Audit</h2>' +
          '<p class="woa-sub">Audit work-order history and generate structured audit flags.</p>' +
        '</div>' +
        '<span class="woa-pill is-ready" id="woa-pill" role="status" aria-live="polite">Ready</span>' +
        '<button type="button" id="bwn-woaudit-x" class="woa-x" title="Close (Esc)" aria-label="Close">' + ICON.close + '</button>' +
      '</header>' +
      '<nav class="woa-steps" aria-label="Workflow progress">' +
        step(1, 'Upload workbook', 'woa-st-1', 'is-active') +
        step(2, 'Configure audit', 'woa-st-2', '') +
        step(3, 'Run audit', 'woa-st-3', '') +
        step(4, 'Download results', 'woa-st-4', '') +
      '</nav>' +
      '<div class="woa-scroll">' +
        // ingest-key + completeness banners (ids preserved for the engine)
        '<div id="bwn-woaudit-keywarn" class="woa-banner is-warn" style="display:none">' + ICON.warn + '<span></span></div>' +
        '<div id="bwn-woaudit-warn" class="woa-banner is-warn" role="status" aria-live="polite" style="display:none">' + ICON.warn + '<span></span></div>' +
        '<div class="woa-grid">' +
          '<div class="woa-col">' +
            card('1 &middot; Workbook', ICON.file, 'bwn-woaudit-wbcount',
              '<div id="woa-drop" class="woa-drop" role="button" tabindex="0" aria-label="Upload audit workbook, Excel XLSX only">' +
                '<div class="woa-drop-ic">' + ICON.upload + '</div>' +
                '<div class="woa-drop-t">Drop your audit workbook here</div>' +
                '<div class="woa-drop-s">or <span class="woa-browse">browse files</span></div>' +
                '<div class="woa-drop-x">Excel .xlsx / .xlsm / .xls &middot; your original file is never modified</div>' +
              '</div>' +
              '<div id="woa-filecard" class="woa-file" style="display:none"></div>' +
              '<input type="file" id="bwn-woaudit-file" accept=".xlsx,.xlsm,.xls" tabindex="-1" aria-hidden="true">' +
              '<div id="bwn-woaudit-sheetwrap" class="woa-field" style="display:none;margin-top:12px"><label class="woa-lbl" for="bwn-woaudit-sheet">Worksheet</label><select id="bwn-woaudit-sheet" class="woa-select"></select></div>' +
              '<div id="woa-fidelity" class="woa-banner is-info" style="display:none;margin-top:12px">' + ICON.info + '<span>The exported workbook preserves cell values and formulas where supported. Some Excel-specific presentation features, such as charts, conditional formatting, or validation rules, may not be retained.</span></div>'
            ) +
            card('2 &middot; Audit configuration', ICON.settings, null,
              '<div class="woa-field"><label class="woa-lbl">Output mode</label>' +
                '<div class="woa-help">What the audit produces. <b>Detailed</b> keeps today\'s status-note audit unchanged. <b>Operations Action List</b> adds the manager action columns and the Action List sheet, and skips per-WO AI notes for a faster management-only run. <b>Hybrid</b> does both.</div>' +
                radio('woa-mode-detailed', 'outMode', 'detailed', 'Detailed WO Audit', 'Status notes + Audit Flags, exactly as today.', false) +
                radio('woa-mode-operations', 'outMode', 'operations', 'Operations Action List', 'Structured action columns + the WO Action List sheet. No AI status notes (fastest).', false) +
                radio('woa-mode-hybrid', 'outMode', 'hybrid', 'Hybrid Audit', 'Both: detailed status notes and the structured manager action list.', true) +
                '<div class="woa-check" id="woa-incmon-wrap" style="margin-top:6px"><div class="woa-check-txt"><div class="woa-check-t">Include Monitor items</div><div class="woa-check-s">Add non-actionable (Monitor) work orders to the Action List. Off by default &mdash; the list shows only work that needs action.</div></div><label class="woa-sw"><input type="checkbox" id="woa-inc-monitor" aria-label="Include Monitor items in the Action List"><span class="woa-sw-t"></span></label></div>' +
              '</div>' +
              '<div class="woa-field"><label class="woa-lbl" for="woa-wocol">Work-order number column</label><div class="woa-help">The column that identifies each work order. Detected automatically &mdash; change it if the guess is wrong.</div><select id="woa-wocol" class="woa-select"></select></div>' +
              '<div class="woa-field"><label class="woa-lbl" for="bwn-woaudit-notecol">Write status notes to</label><div class="woa-help">The column that receives each work order\'s status note. Detected automatically &mdash; change it if the guess is wrong.</div><select id="bwn-woaudit-notecol" class="woa-select"></select></div>' +
              '<details class="woa-disc" id="woa-advmap-wrap" style="margin:0 0 14px"><summary>' + ICON.settings + 'Advanced column mapping</summary><div class="woa-disc-b"><div class="woa-help" style="margin-bottom:8px">Operational fields the Action List can use. Live Umbrava data is the primary source for status, priority, trade, ECD and next-onsite; the workbook is used only as a fallback or where live data is not read. Override a detected column only where the field is actually read from the workbook.</div><div id="woa-advmap"></div></div></details>' +
              '<div class="woa-field" id="woa-outwrap"><label class="woa-lbl">Audit flags output</label>' +
                radio('woa-out-new', 'flagsMode', 'new', 'Create a new "Audit Flags" column', 'Leaves any existing audit column untouched.', true) +
                radio('woa-out-reuse', 'flagsMode', 'reuse', 'Reuse the detected audit column', 'Replaces the values already in that column.', false) +
                '<div id="woa-ack" class="woa-ack">' + ICON.warn + '<label><input type="checkbox" id="woa-ack-cb"> I understand this overwrites existing audit values in that column.</label></div>' +
              '</div>' +
              '<div class="woa-field"><label class="woa-lbl">Audit checks</label><div class="woa-help">Deterministic exception flags written to the Audit Flags column &mdash; no AI, no extra cost.</div>' +
                chk('aged', 'Aged &amp; overdue work orders', 'Flags OVERDUE and STALE (no recent note).', true, false) +
                chk('notes', 'Missing service notes', 'Flags work orders with no notes on file.', true, false) +
                chk('pricing', 'Pricing &amp; margin exceptions', 'Flags negative/low GP and NTE over DNE.', true, false) +
                chk('vendor', 'Missing vendor / PO', 'Flags work orders with no active purchase order.', true, false) +
                chk('scheduling', 'Unscheduled work', 'Flags open work orders with no return-visit date.', true, false) +
                chk('cancel', 'Cancellation / no-service language', 'Scans recent notes for cancel, no-access or no-show wording.', true, false) +
                '<div class="woa-check"><div class="woa-check-txt"><div class="woa-check-t">Client update overdue</div>' +
                  '<div class="woa-check-s">Flags a work order whose last client-facing note is older than <input id="woa-chk-clientDays" class="woa-days" type="number" min="0" max="90" value="2" aria-label="Client-update threshold in days"> day(s). Uses the suite\'s "Client" note type.</div></div>' +
                  '<label class="woa-sw"><input type="checkbox" id="woa-chk-clientUpdate" checked aria-label="Client update overdue"><span class="woa-sw-t"></span></label></div>' +
                chk('repeat', 'Repeat dispatches', 'Needs trip history, which this tool does not read yet.', false, true) +
              '</div>' +
              '<div class="woa-field"><label class="woa-lbl">Processing speed</label>' +
                '<div class="woa-seg" role="group" aria-label="Processing speed">' +
                  '<button type="button" class="woa-seg-btn" data-conc="1" id="woa-sp-1">Low</button>' +
                  '<button type="button" class="woa-seg-btn is-on" data-conc="3" id="woa-sp-3">Balanced</button>' +
                  '<button type="button" class="woa-seg-btn" data-conc="6" id="woa-sp-6">Fast</button>' +
                '</div>' +
                '<div class="woa-speed-note" id="woa-speed-note">Balanced processes 3 work orders at a time.</div>' +
                '<div class="woa-adv"><label for="bwn-woaudit-conc-adv">Advanced</label><input id="bwn-woaudit-conc-adv" type="number" min="1" max="6" value="3" aria-label="Work orders at a time, 1 to 6"><span>at a time (1&ndash;6)</span></div>' +
                '<input id="bwn-woaudit-conc" type="number" min="1" max="6" value="3" tabindex="-1" aria-hidden="true">' +
              '</div>'
            ) +
          '</div>' +
          '<div class="woa-col">' +
            card('Progress', ICON.activity, null,
              '<div id="woa-empty-prog" class="woa-log-empty">The audit has not run yet.</div>' +
              '<div id="bwn-woaudit-prog" class="woa-progress">' +
                '<div class="woa-prog-top"><span class="woa-prog-num" id="woa-prog-num">0 / 0</span><span class="woa-prog-pct" id="woa-prog-pct">0%</span></div>' +
                '<div class="woa-bar" id="woa-bar"><div class="woa-bar-fill" id="woa-bar-fill"></div></div>' +
                '<div class="woa-cur" id="woa-cur"></div>' +
                '<div class="woa-eta" id="woa-eta"></div>' +
                '<div class="woa-counters">' +
                  counter('woa-c-ok', 'Audited', 'c-ok') +
                  counter('woa-c-flag', 'Flagged', 'c-flag') +
                  counter('woa-c-skip', 'Skipped', 'c-skip') +
                  counter('woa-c-err', 'Errors', 'c-err') +
                '</div>' +
                '<div class="woa-run-ctrls" id="woa-run-ctrls">' +
                  '<button type="button" id="woa-pause" class="woa-btn woa-btn-ghost" style="flex:1;justify-content:center">' + ICON.pause + '<span>Pause</span></button>' +
                  '<button id="bwn-woaudit-cancel" class="woa-btn woa-btn-cancel" style="flex:1;justify-content:center">' + ICON.stop + '<span>Cancel</span></button>' +
                '</div>' +
              '</div>'
            ) +
            '<section class="woa-card"><div class="woa-card-hd woa-log-hd">' + ICON.activity + '<span>Live activity</span>' +
              '<div class="woa-log-acts">' +
                '<button type="button" class="woa-logbtn is-on" id="woa-log-auto" title="Toggle auto-scroll" aria-pressed="true">Autoscroll</button>' +
                '<button type="button" class="woa-logbtn" id="woa-log-copy" title="Copy log to clipboard">' + ICON.copy + 'Copy</button>' +
                '<button type="button" class="woa-logbtn" id="woa-log-clear" title="Clear the display (audit data is kept)">' + ICON.trash + 'Clear</button>' +
              '</div></div>' +
              '<div class="woa-card-b" style="padding:10px">' +
                '<div id="woa-log-empty" class="woa-log-empty">Activity will stream here during the audit.</div>' +
                '<div id="bwn-woaudit-log" role="log" aria-live="polite" style="display:none"></div>' +
              '</div></section>' +
          '</div>' +
        '</div>' +
        '<div id="woa-preview"></div>' +
        '<div class="woa-actions">' +
          '<button id="bwn-woaudit-start" class="woa-btn woa-btn-primary">' + ICON.play + '<span>Start audit</span></button>' +
          '<button id="bwn-woaudit-retry" class="woa-btn woa-btn-retry" style="display:none">' + ICON.reset + '<span>Retry unfinished</span></button>' +
          '<button type="button" id="woa-reset" class="woa-btn woa-btn-ghost">' + ICON.reset + '<span>Reset</span></button>' +
          '<span class="woa-spacer"></span>' +
          '<button id="bwn-woaudit-dl" class="woa-btn woa-btn-dl" disabled>' + ICON.download + '<span>Download audited workbook</span></button>' +
        '</div>' +
        '<details class="woa-disc"><summary>' + ICON.info + 'What will change?</summary><div class="woa-disc-b"><ul>' +
          '<li>Notes are read live from Umbrava for each work order; the status note is written to the column selected above.</li>' +
          '<li>Audit flags are written to the Audit Flags column according to the output mode you chose.</li>' +
          '<li>In Operations Action List or Hybrid mode, 16 structured action columns are appended to the source sheet and a separate "WO Action List - date" worksheet lists the actionable work orders, sorted by priority.</li>' +
          '<li>Your original workbook is never modified in the browser &mdash; the tool produces a separate downloadable copy, and the source Notes column is never overwritten.</li>' +
          '<li>The Action List uses a text-first layout (explicit "P0 &ndash; Immediate" priorities, YES/NO Manager Review, column widths and filters). It does NOT use Excel fill colours, conditional formatting, native tables or frozen panes &mdash; the bundled spreadsheet library cannot write those.</li>' +
          '<li>The export preserves cell values and formulas where supported; some Excel presentation features (charts, conditional formatting, validation) may not be retained.</li>' +
        '</ul></div></details>' +
        // Run diagnostics: unmapped live statuses + review-required rows, populated when a run
        // finishes (quality 0.13.0). Read-only, in-memory, copyable - never written to bwn:audit.
        '<div id="bwn-woaudit-diag"></div>' +
        '<div id="bwn-woaudit-post"></div>' +
        '<div id="bwn-woaudit-mapinfo"></div>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    bwnFocusTrap(ov);

    var $ = function (id) { return document.getElementById(id); };

    // ---- status pill + step indicator ---------------------------------------
    var PILL = { ready: ['is-ready', 'Ready'], proc: ['is-proc', 'Processing'], done: ['is-done', 'Complete'], warn: ['is-warn', 'Needs attention'] };
    function setStatus(state) {
      var p = $('woa-pill'); if (!p) return;
      var s = PILL[state] || PILL.ready;
      p.className = 'woa-pill ' + s[0]; p.textContent = s[1];
    }
    // Mark steps 1..n: below `active` = done, `active` = active, above = pending.
    function setStep(active) {
      for (var n = 1; n <= 4; n++) {
        var el = $('woa-st-' + n); if (!el) continue;
        el.className = 'woa-step' + (n < active ? ' is-done' : (n === active ? ' is-active' : ''));
      }
    }

    // ---- close (backdrop click, X, Escape); refused mid-run without confirm --
    function tryClose() {
      if (_running) {
        var stop = false;
        try { stop = window.confirm('An audit is still running.\n\nClosing stops it and discards the in-progress workbook (the notes written so far are lost). To keep them, press Cancel instead, let the in-flight rows finish, then Download.\n\nClose and discard anyway?'); } catch (e) { stop = false; }
        if (!stop) return;
        _cancelled = true;
      }
      drawerDismiss(ov);
    }
    ov.addEventListener('click', function (e) { if (e.target === ov) tryClose(); });
    ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); tryClose(); } });
    $('bwn-woaudit-x').onclick = tryClose;

    // ---- ingest-key banner (icon + span markup, so set the span not the node) -
    var kw = $('bwn-woaudit-keywarn');
    function setKeyWarn(msg) {
      var sp = kw.querySelector('span'); if (sp) sp.textContent = msg || '';
      kw.style.display = msg ? 'flex' : 'none';
    }
    if (!getKey()) setKeyWarn('SWA ingest key not set. Open the Tampermonkey menu → "BWN WO Audit: Set SWA ingest key" (same key as the rest of the BWN Ops Suite), then reopen this.');

    // ---- live log: timestamps, severity color, auto-scroll gate --------------
    var log = $('bwn-woaudit-log'), logEmpty = $('woa-log-empty'), _autoscroll = true;
    // Canonical attribute-safe escaper (pinned suite-wide by scripts/test-esc-canonical.js): the
    // workbook filename and note text are rendered into innerHTML, including quoted attributes.
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function logln(s) {
      if (!log) return;
      if (logEmpty) logEmpty.style.display = 'none';
      if (log.style.display === 'none') log.style.display = 'block';
      var sev = /^\s*!/.test(s) ? 'l-err' : /^\s*\./.test(s) ? 'l-wait' : /\bfailed\b|\berror\b/i.test(s) ? 'l-warn' : /\bDone\b|written|\bComplete\b/.test(s) ? 'l-ok' : '';
      var ts = new Date().toTimeString().slice(0, 8);
      var line = document.createElement('div');
      line.innerHTML = '<span class="l-ts">' + ts + '</span> <span class="' + sev + '">' + esc(s) + '</span>';
      log.appendChild(line);
      if (_autoscroll) log.scrollTop = log.scrollHeight;
    }
    $('woa-log-auto').onclick = function () {
      _autoscroll = !_autoscroll;
      this.classList.toggle('is-on', _autoscroll);
      this.setAttribute('aria-pressed', String(_autoscroll));
      if (_autoscroll) log.scrollTop = log.scrollHeight;
    };
    $('woa-log-copy').onclick = function () {
      var txt = log.textContent || '';
      try { navigator.clipboard.writeText(txt).then(function () { toast('Activity log copied.'); }, function () { toast('Copy blocked by the browser.'); }); }
      catch (e) { toast('Copy not available.'); }
    };
    // Clears only the DISPLAY. session.results is the audit's real state and is untouched.
    $('woa-log-clear').onclick = function () {
      log.innerHTML = ''; log.style.display = 'none';
      if (logEmpty) logEmpty.style.display = '';
    };

    // ---- completeness banner (persists outside the log) ----------------------
    function setWarn(msg) {
      var w = $('bwn-woaudit-warn'); if (!w) return;
      var sp = w.querySelector('span'); if (sp) sp.textContent = msg || '';
      w.className = 'woa-banner ' + (msg ? 'is-warn' : 'is-warn');
      w.style.display = msg ? 'flex' : 'none';
    }

    // ---- concurrency: hidden #bwn-woaudit-conc stays the source of truth -----
    var SPEED_NOTE = { 1: 'Low processes 1 work order at a time \u2014 gentlest on the AI service.', 3: 'Balanced processes 3 work orders at a time.', 6: 'Fast processes 6 work orders at a time \u2014 large batches may hit AI rate limits.' };
    function setConc(n, fromAdv) {
      n = Math.max(1, Math.min(6, parseInt(n, 10) || 3));
      $('bwn-woaudit-conc').value = n;
      if (!fromAdv) $('bwn-woaudit-conc-adv').value = n;
      ['1', '3', '6'].forEach(function (v) { var b = $('woa-sp-' + v); if (b) b.classList.toggle('is-on', String(n) === v); });
      var note = SPEED_NOTE[n] || ('Custom \u2014 ' + n + ' work orders at a time.' + (n > 3 ? ' Higher speed can hit AI rate limits or throttle inconsistently.' : ''));
      $('woa-speed-note').textContent = note;
    }
    ['1', '3', '6'].forEach(function (v) { $('woa-sp-' + v).onclick = function () { setConc(v); }; });
    $('bwn-woaudit-conc-adv').oninput = function () { setConc(this.value, true); };

    // ---- output mode (radios) + overwrite acknowledgement --------------------
    function syncOutMode() {
      var reuse = $('woa-out-reuse').checked;
      $('woa-out-new-l').classList.toggle('is-on', !reuse);
      $('woa-out-reuse-l').classList.toggle('is-on', reuse);
      $('woa-ack').classList.toggle('is-show', reuse);
      if (!reuse) $('woa-ack-cb').checked = false;
    }
    $('woa-out-new').onchange = syncOutMode;
    $('woa-out-reuse').onchange = syncOutMode;

    // ---- output mode (Detailed / Operations Action List / Hybrid) ------------
    function currentMode() {
      return $('woa-mode-operations').checked ? 'operations' : $('woa-mode-detailed').checked ? 'detailed' : 'hybrid';
    }
    function syncMode() {
      var m = currentMode();
      ['detailed', 'operations', 'hybrid'].forEach(function (v) {
        var l = $('woa-mode-' + v + '-l'); if (l) l.classList.toggle('is-on', m === v);
      });
      // The status-note column only matters when a narrative note is written (Detailed / Hybrid).
      var noteRelevant = m !== 'operations';
      var ncw = $('bwn-woaudit-notecol'); if (ncw) ncw.disabled = !noteRelevant;
      // Include-Monitor only affects the Action List, which Detailed mode does not produce.
      var incw = $('woa-incmon-wrap'); if (incw) incw.style.opacity = (m === 'detailed') ? '.5' : '1';
      var inc = $('woa-inc-monitor'); if (inc) inc.disabled = (m === 'detailed');
      if (typeof renderPreview === 'function') renderPreview();
    }
    ['detailed', 'operations', 'hybrid'].forEach(function (v) { var el = $('woa-mode-' + v); if (el) el.onchange = syncMode; });
    var incMon = $('woa-inc-monitor'); if (incMon) incMon.onchange = syncMode;
    syncMode();

    // ---- audit-check switches sync the step indicator / nothing else here ----
    var loaded = null;   // { wb, name, file }

    // ---- file handling: validation, drag-drop, browse, sheet picker ----------
    function fmtSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
    function readFile(f) {
      if (!f) return;
      if (_running) { logln('! A run is in progress - finish or cancel it before loading another workbook.'); return; }
      if (!/\.(xlsx|xlsm|xls)$/i.test(f.name || '')) {
        showFidelity(false);
        showError('That file is not an Excel workbook. Upload an .xlsx, .xlsm, or .xls audit file.');
        return;
      }
      var fr = new FileReader();
      fr.onload = function () {
        try {
          if (typeof XLSX === 'undefined') throw new Error('spreadsheet library not loaded - reload the page');
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellFormula: true, cellStyles: true });
          loaded = { wb: wb, name: (f.name || 'wo-audit.xlsx').replace(/\.(xlsx|xlsm|xls)$/i, ''), file: f };
          var sw = $('bwn-woaudit-sheetwrap'), ss = $('bwn-woaudit-sheet');
          ss.innerHTML = '';
          wb.SheetNames.forEach(function (nm) { var o = document.createElement('option'); o.value = nm; o.textContent = nm; ss.appendChild(o); });
          sw.style.display = wb.SheetNames.length > 1 ? 'block' : 'none';
          ss.onchange = describe;
          describe();
        } catch (err) { showError('Could not read that workbook: ' + ((err && err.message) || err) + '. It may be corrupt or password-protected.'); }
      };
      fr.onerror = function () { showError('The browser could not read that file. Try again.'); };
      fr.readAsArrayBuffer(f);
    }
    function showError(msg) {
      var d = $('woa-drop');
      d.style.display = 'block'; $('woa-filecard').style.display = 'none';
      // reuse the fidelity banner slot as an inline error under the drop zone
      var fb = $('woa-fidelity');
      fb.className = 'woa-banner is-err'; fb.style.display = 'flex';
      fb.querySelector('span').textContent = msg;
      setStatus('warn'); setStep(1);
    }
    function showFidelity(show) {
      var fb = $('woa-fidelity');
      fb.className = 'woa-banner is-info';
      fb.querySelector('span').textContent = 'The exported workbook preserves cell values and formulas where supported. Some Excel-specific presentation features, such as charts, conditional formatting, or validation rules, may not be retained.';
      fb.style.display = show ? 'flex' : 'none';
    }
    $('bwn-woaudit-file').onchange = function (e) { readFile(e.target.files && e.target.files[0]); };
    (function wireDrop() {
      var d = $('woa-drop'), fi = $('bwn-woaudit-file');
      d.onclick = function () { if (!_running) fi.click(); };
      d.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!_running) fi.click(); } };
      ['dragenter', 'dragover'].forEach(function (ev) { d.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); if (!_running) d.classList.add('is-drag'); }); });
      ['dragleave', 'dragend'].forEach(function (ev) { d.addEventListener(ev, function (e) { e.preventDefault(); d.classList.remove('is-drag'); }); });
      d.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation(); d.classList.remove('is-drag');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) readFile(f);
      });
    })();

    function renderFileCard(map, count) {
      var f = loaded.file || {};
      var miss = function (v, real) { return real ? '<span class="woa-meta-v">' + esc(v) + '</span>' : '<span class="woa-meta-v is-miss">' + esc(v) + '</span>'; };
      var noteName = map.noteName != null ? map.noteName : 'will append "Audit Notes"';
      var flagName = map.flagName != null ? map.flagName : 'will append "Audit Flags"';
      $('woa-filecard').innerHTML =
        '<div class="woa-file-row"><div class="woa-file-ic">' + ICON.file + '</div>' +
          '<div style="min-width:0"><div class="woa-file-name">' + esc(f.name || (loaded.name + '.xlsx')) + '</div>' +
          '<div class="woa-file-size">' + (f.size ? fmtSize(f.size) : '') + (loaded.wb.SheetNames.length > 1 ? ' &middot; ' + loaded.wb.SheetNames.length + ' sheets' : '') + '</div></div></div>' +
        '<div class="woa-meta">' +
          '<div><div class="woa-meta-k">Work orders</div>' + miss(String(count), count > 0) + '</div>' +
          '<div><div class="woa-meta-k">WO # column</div>' + miss(map.keyName != null ? map.keyName : 'not found', map.key > -1) + '</div>' +
          '<div><div class="woa-meta-k">Notes column</div>' + miss(noteName, true) + '</div>' +
          '<div><div class="woa-meta-k">Audit flags column</div>' + miss(flagName, true) + '</div>' +
        '</div>' +
        '<div class="woa-file-acts"><span class="woa-browse" id="woa-replace">Replace file</span><span class="woa-browse" id="woa-remove" style="color:#b42318;text-decoration-color:#b42318">Remove</span></div>';
      $('woa-replace').onclick = function () { if (!_running) $('bwn-woaudit-file').click(); };
      $('woa-remove').onclick = function () { if (!_running) resetAll(); };
      $('woa-drop').style.display = 'none';
      $('woa-filecard').style.display = 'flex';
    }

    // Operational fields for the Advanced Column Mapping section. 'live' = read primarily from live
    // Umbrava data (the workbook column is a fallback); 'workbook' = read from the workbook (or a gap
    // when absent). Only these are consumed by the action layer, so only these get an override.
    var FIELD_META = [
      ['status', 'Status', 'live'], ['priority', 'Priority', 'live'], ['trade', 'Trade', 'live'],
      ['ecd', 'Expected Completion Date', 'live'], ['nextOnsite', 'Next Onsite Date', 'live'], ['lastNote', 'Last Note Date', 'live'],
      ['assigned', 'Assigned To', 'workbook'], ['fm', 'FM', 'workbook'], ['location', 'Location / Site', 'workbook'],
      ['city', 'City', 'workbook'], ['state', 'State', 'workbook'], ['days', 'Days (age)', 'workbook'],
      ['statusHours', 'Status Hours', 'workbook'], ['vendor', 'Vendor', 'workbook'], ['scope', 'Scope Of Work', 'workbook'],
      ['po', 'Source PO', 'workbook'], ['nte', 'Total Vendor NTE', 'workbook'], ['type', 'Type', 'workbook']
    ];
    // The current data-row count under session.map.key. Recomputed when the WO # column changes.
    function recountRows() {
      if (!session) return 0;
      var rows = [];
      for (var r = session.map.headerRow + 1; r < session.map.aoa.length; r++) {
        var key = cellStr(session.map.aoa, r, session.map.key);
        if (key) rows.push({ rowIdx: r, key: key });
      }
      session.rows = rows;
      return rows.length;
    }
    function populateWoCol(hdr, map) {
      var sel = $('woa-wocol'); if (!sel) return;
      sel.innerHTML = '';
      hdr.forEach(function (h, i) { var o = document.createElement('option'); o.value = String(i); o.textContent = (h || ('(col ' + (i + 1) + ')')) + (i === map.key ? '  — detected' : ''); sel.appendChild(o); });
      sel.value = String(map.key > -1 ? map.key : 0);
      sel.onchange = function () {
        if (_running || !session) return;
        session.map.key = parseInt(sel.value, 10);
        session.map.keyName = hdr[session.map.key] || null;
        var n = recountRows();
        $('bwn-woaudit-start').disabled = !(session.map.key > -1 && n > 0);
        renderPreview();
      };
    }
    // The Advanced Column Mapping rows: detected header + source classification + an override select.
    function renderAdvMap(hdr, map) {
      var host = $('woa-advmap'); if (!host) return;
      host.innerHTML = '';
      FIELD_META.forEach(function (fm) {
        var key = fm[0], label = fm[1], cls = fm[2];
        var idx = (typeof map[key] === 'number') ? map[key] : -1;
        var detected = idx > -1;
        var klass = cls === 'live'
          ? (detected ? 'Live WO data (workbook fallback: "' + (hdr[idx] || '') + '")' : 'Live WO data')
          : (detected ? 'Workbook: "' + (hdr[idx] || '') + '"' : 'Unavailable / data gap');
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #f0f3f1';
        var lab = document.createElement('div');
        lab.style.cssText = 'flex:0 0 150px;min-width:0';
        lab.innerHTML = '<div style="font-weight:600;font-size:12px">' + esc(label) + '</div><div style="font-size:10.5px;color:' + (detected ? '#5f6f68' : '#b42318') + '">' + esc(klass) + '</div>';
        row.appendChild(lab);
        var sel = document.createElement('select');
        sel.className = 'woa-select';
        sel.style.cssText = 'flex:1;min-width:0;font-size:12px;padding:5px 7px';
        var none = document.createElement('option'); none.value = '-1'; none.textContent = '(not mapped)'; sel.appendChild(none);
        hdr.forEach(function (h, i) { var o = document.createElement('option'); o.value = String(i); o.textContent = h || ('(col ' + (i + 1) + ')'); sel.appendChild(o); });
        sel.value = String(idx);
        sel.setAttribute('aria-label', label + ' column');
        sel.onchange = function () { if (_running || !session) return; session.map[key] = parseInt(sel.value, 10); renderPreview(); };
        row.appendChild(sel);
        host.appendChild(row);
      });
    }
    // Pre-run preview: source-only estimate. Actionable/Monitor split needs the live run, so it is
    // NOT claimed here - only what the parsed workbook + resolved mappings can support.
    function renderPreview() {
      var host = $('woa-preview'); if (!host) return;
      host.innerHTML = '';
      if (!session) return;
      var map = session.map, n = session.rows.length;
      var mode = $('woa-mode-operations').checked ? 'operations' : $('woa-mode-detailed').checked ? 'detailed' : 'hybrid';
      var gaps = [];
      if (map.key === -1) gaps.push('no work-order-number column (the audit cannot run)');
      if (mode !== 'operations' && map.note === -1) gaps.push('no notes column detected - a new "Audit Notes" column will be appended');
      // Optional fields absent from BOTH live and workbook that will leave Action List cells blank.
      var wbOnly = [['fm', 'FM'], ['vendor', 'Vendor'], ['scope', 'Scope'], ['statusHours', 'Status Hours'], ['nte', 'Total Vendor NTE']];
      var missing = wbOnly.filter(function (p) { return map[p[0]] === -1; }).map(function (p) { return p[1]; });
      var wrap = document.createElement('div');
      wrap.className = 'woa-banner is-info';
      wrap.style.cssText = 'display:block;margin-top:4px';
      var lines = [
        '<b>Pre-run preview (estimate)</b>',
        'Rows detected: ' + n + '  &middot;  work orders to audit: ' + n,
        'Output mode: ' + (mode === 'detailed' ? 'Detailed WO Audit' : mode === 'operations' ? 'Operations Action List' : 'Hybrid Audit') + (mode === 'detailed' ? '' : '  &middot;  Include Monitor: ' + ($('woa-inc-monitor').checked ? 'yes' : 'no'))
      ];
      if (missing.length) lines.push('Workbook fields not found (those Action List columns stay blank): ' + esc(missing.join(', ')));
      if (gaps.length) lines.push('<span style="color:#8f231c">Data gaps: ' + esc(gaps.join('; ')) + '</span>');
      if (mode !== 'detailed') lines.push('<i>The priority / actionable / Monitor split is determined by the live audit run, not this estimate.</i>');
      wrap.innerHTML = ICON.info + '<div style="line-height:1.5">' + lines.join('<br>') + '</div>';
      host.appendChild(wrap);
    }

    function currentSheet() { return loaded ? ($('bwn-woaudit-sheet').value || loaded.wb.SheetNames[0]) : null; }
    function describe() {
      if (!loaded || _running) return;
      var rb0 = $('bwn-woaudit-retry'); if (rb0) rb0.style.display = 'none';
      var db0 = $('bwn-woaudit-dl'); if (db0) { db0.disabled = true; }
      setWarn('');
      var ph0 = $('bwn-woaudit-post'); if (ph0) ph0.innerHTML = '';
      var dg0 = $('bwn-woaudit-diag'); if (dg0) dg0.innerHTML = '';   // stale diagnostics belong to the old workbook
      var ws = loaded.wb.Sheets[currentSheet()];
      var map = mapSheet(ws);
      var hdr = (map.aoa[map.headerRow] || []).map(function (x) { return String(x == null ? '' : x); });
      var dataRows = [];
      for (var r = map.headerRow + 1; r < map.aoa.length; r++) {
        var key = cellStr(map.aoa, r, map.key);
        if (key) dataRows.push({ rowIdx: r, key: key });
      }
      // notes-column picker (detection is a hint; operator confirms)
      var ncsel = $('bwn-woaudit-notecol');
      ncsel.innerHTML = '';
      hdr.forEach(function (h, i) { var o = document.createElement('option'); o.value = String(i); o.textContent = (h || ('(col ' + (i + 1) + ')')) + (i === map.note ? '  \u2014 detected' : ''); ncsel.appendChild(o); });
      var appendOpt = document.createElement('option'); appendOpt.value = 'append'; appendOpt.textContent = '+ append a new "Audit Notes" column'; ncsel.appendChild(appendOpt);
      ncsel.value = (map.note > -1) ? String(map.note) : 'append';
      // output mode: "reuse" is only meaningful when a flags column already exists
      var hasFlags = map.flag > -1;
      var reuseIn = $('woa-out-reuse'), reuseL = $('woa-out-reuse-l');
      reuseIn.disabled = !hasFlags;
      reuseL.style.opacity = hasFlags ? '1' : '.5';
      reuseL.querySelector('.woa-radio-s').textContent = hasFlags ? ('Replaces the values in the detected "' + map.flagName + '" column.') : 'No existing audit column was detected in this workbook.';
      if (!hasFlags) { $('woa-out-new').checked = true; }
      syncOutMode();
      // legacy hidden text node kept for parity/debugging
      $('bwn-woaudit-mapinfo').textContent = 'WO # column: ' + (map.keyName != null ? map.keyName : 'NOT FOUND') + ' | WOs: ' + dataRows.length + ' | flags: ' + (map.flagName != null ? map.flagName : 'append');
      var wc = $('bwn-woaudit-wbcount'); if (wc) wc.textContent = dataRows.length + ' WO' + (dataRows.length === 1 ? '' : 's');
      renderFileCard(map, dataRows.length);
      showFidelity(true);
      var ok = map.key > -1 && dataRows.length > 0;
      $('bwn-woaudit-start').disabled = !ok;
      if (!ok) {
        showError(map.key === -1 ? 'No "WO #" column found in this workbook. The audit needs a work-order-number column (WO #, Work Order #, or Source Job #).' : 'No work-order rows were found under the detected header.');
      } else {
        setStatus('ready'); setStep(2);
      }
      session = { wb: loaded.wb, sheet: currentSheet(), map: map, rows: dataRows, results: [], name: loaded.name };
      populateWoCol(hdr, map);
      renderAdvMap(hdr, map);
      renderPreview();
    }

    // ---- reset: back to the empty state, keep config defaults ----------------
    function resetAll() {
      if (_running) return;
      loaded = null; session = null;
      $('bwn-woaudit-file').value = '';
      $('woa-filecard').style.display = 'none'; $('woa-filecard').innerHTML = '';
      $('woa-drop').style.display = 'block';
      $('bwn-woaudit-sheetwrap').style.display = 'none';
      showFidelity(false);
      $('bwn-woaudit-post').innerHTML = '';
      var am = $('woa-advmap'); if (am) am.innerHTML = '';
      var pv = $('woa-preview'); if (pv) pv.innerHTML = '';
      var dg = $('bwn-woaudit-diag'); if (dg) dg.innerHTML = '';
      setWarn('');
      $('bwn-woaudit-start').disabled = true;
      $('bwn-woaudit-start').classList.remove('is-complete');
      $('bwn-woaudit-start').innerHTML = ICON.play + '<span>Start audit</span>';
      $('bwn-woaudit-retry').style.display = 'none';
      var dl = $('bwn-woaudit-dl'); dl.disabled = true; dl.classList.remove('woa-btn-primary');
      $('bwn-woaudit-prog').classList.remove('is-show');
      $('woa-empty-prog').style.display = '';
      log.innerHTML = ''; log.style.display = 'none';
      if (logEmpty) logEmpty.style.display = '';
      setStatus('ready'); setStep(1);
    }
    $('woa-reset').onclick = resetAll;

    // ---- pause gate: parks NEW rows between fetches; in-flight rows finish ----
    var _paused = false, _pauseWaiters = [];
    function waitIfPaused() { return _paused ? new Promise(function (res) { _pauseWaiters.push(res); }) : Promise.resolve(); }
    function releasePause() { var w = _pauseWaiters; _pauseWaiters = []; w.forEach(function (f) { f(); }); }
    function setPaused(p) {
      _paused = p;
      var b = $('woa-pause'); if (b) b.innerHTML = (p ? ICON.play + '<span>Resume</span>' : ICON.pause + '<span>Pause</span>');
      if (!p) releasePause();
      if (p) { logln('Paused - in-flight work orders finish; no new ones start until you resume.'); setStatus('warn'); }
      else { logln('Resumed.'); setStatus('proc'); }
    }
    $('woa-pause').onclick = function () { if (_running) setPaused(!_paused); };

    // ---- progress card ------------------------------------------------------
    var _runStart = 0, _flagged = 0, _lastCur = '';
    function fmtEta(ms) {
      if (!isFinite(ms) || ms < 0) return '';
      var s = Math.round(ms / 1000);
      if (s < 60) return '~' + s + 's remaining';
      var m = Math.floor(s / 60); return '~' + m + 'm ' + (s % 60) + 's remaining';
    }
    function updateProgress(done, total, curKey) {
      var pc = total ? Math.round(done / total * 100) : 0;
      $('woa-prog-num').textContent = done + ' / ' + total;
      $('woa-prog-pct').textContent = pc + '%';
      $('woa-bar-fill').style.width = pc + '%';
      if (curKey != null) _lastCur = curKey;
      $('woa-cur').textContent = (done >= total && total) ? 'All work orders processed.' : (_running && _lastCur ? 'Processing WO ' + _lastCur + '…' : '');
      // honest ETA: only once a few rows have timed, only while running
      var eta = '';
      if (_runStart && done >= 3 && done < total) { var per = (Date.now() - _runStart) / done; eta = fmtEta(per * (total - done)); }
      $('woa-eta').textContent = eta;
      // live counters from what actually settled
      var ok = 0, err = 0;
      if (session) { for (var i = 0; i < session.rows.length; i++) { var r = session.results[i]; if (!r) continue; if (r.error) err++; else ok++; } }
      $('woa-c-ok').textContent = ok;
      $('woa-c-flag').textContent = _flagged;
      $('woa-c-skip').textContent = Math.max(0, total - ok - err);
      $('woa-c-err').textContent = err;
    }

    // ---- primary actions ----------------------------------------------------
    $('bwn-woaudit-start').onclick = function () { if (!this.classList.contains('is-complete')) runAudit(false); };
    $('bwn-woaudit-retry').onclick = function () { runAudit(true); };
    $('bwn-woaudit-dl').onclick = function () { downloadResult(); };
    // Cancel: confirm, then stop handing out new rows; in-flight rows finish and Download stays.
    $('bwn-woaudit-cancel').onclick = function () {
      if (!_running || _cancelled) return;
      var go = false;
      try { go = window.confirm('Cancel the audit?\n\nWork orders already in progress will finish and their notes are kept. Rows not yet started will be skipped.\n\nYou can still download the partial workbook, or press Retry Unfinished to complete it later.'); } catch (e) { go = true; }
      if (!go) return;
      _cancelled = true;
      if (_paused) setPaused(false);   // release parked rows so they can settle and the run can end
      logln('Cancelling - letting the rows already in flight finish...');
      this.disabled = true;
    };

    // The config inputs locked while a run is in flight (values are preserved, not reset).
    var CONFIG_IDS = ['bwn-woaudit-file', 'bwn-woaudit-sheet', 'woa-wocol', 'bwn-woaudit-notecol', 'woa-mode-detailed', 'woa-mode-operations', 'woa-mode-hybrid', 'woa-inc-monitor', 'woa-out-new', 'woa-out-reuse', 'woa-ack-cb', 'woa-sp-1', 'woa-sp-3', 'woa-sp-6', 'bwn-woaudit-conc-adv', 'woa-reset', 'woa-chk-aged', 'woa-chk-notes', 'woa-chk-pricing', 'woa-chk-vendor', 'woa-chk-scheduling', 'woa-chk-cancel', 'woa-chk-clientUpdate', 'woa-chk-clientDays'];
    function lockConfig(dis) { CONFIG_IDS.forEach(function (id) { var el = $(id); if (el) el.disabled = dis; }); }

    function runAudit(retryOnly) {
      if (!session) return;
      if (_running) return;   // guard against a double Start / duplicate run
      var key = getKey();
      if (!key) { setKeyWarn('Set the SWA ingest key first: Tampermonkey menu → "BWN WO Audit: Set SWA ingest key".'); setStatus('warn'); return; }
      if (!authToken()) { logln('! Not signed into Umbrava (no usable token). Reload the tab and retry.'); setStatus('warn'); return; }
      var model = '';   // empty -> api/ai picks the model server-side (BWN_AI_MODEL, else its default)
      var conc = Math.max(1, Math.min(6, parseInt($('bwn-woaudit-conc').value, 10) || 3));
      // Audit configuration read once, at run start (locked for the run's duration).
      var cfg = {
        checks: {
          aged: $('woa-chk-aged').checked, notes: $('woa-chk-notes').checked,
          pricing: $('woa-chk-pricing').checked, vendor: $('woa-chk-vendor').checked,
          scheduling: $('woa-chk-scheduling').checked, cancel: $('woa-chk-cancel').checked,
          clientUpdate: $('woa-chk-clientUpdate').checked
        },
        flagsMode: $('woa-out-reuse').checked ? 'reuse' : 'new',
        outputMode: currentMode(),                    // 'detailed' | 'operations' | 'hybrid'
        includeMonitor: !!$('woa-inc-monitor').checked
      };
      // Operations Action List and Hybrid produce the structured layer; Detailed is unchanged.
      var wantActions = cfg.outputMode !== 'detailed';
      // Operations mode is the fast management-only run: it skips the per-WO AI status note entirely
      // (deriveState + flags + the action engine are all deterministic and need no network/AI).
      var wantNote = cfg.outputMode !== 'operations';
      // Client-update context: the set of note-type ids that count as a client-facing update
      // (resolved live from Core's bwn:noteTypes; null when Core is not loaded -> the check no-ops),
      // and the operator-set day threshold from the modal (default 2, honours bwn:config.audit).
      var clientDays = Math.max(0, Math.min(90, parseInt($('woa-chk-clientDays').value, 10) || auditCfg('clientUpdateDays', 2)));
      var clientCtx = { clientSet: clientTypeIdSet(bwnNoteTypeMap()), clientDays: clientDays };
      if (cfg.checks.clientUpdate && !clientCtx.clientSet) {
        logln('  (client-update check skipped: no "Client" note type found in Core\'s cache - open the suite so bwn:noteTypes loads)');
      }
      if (cfg.flagsMode === 'reuse' && !$('woa-ack-cb').checked) {
        $('woa-ack').classList.add('is-show'); $('woa-ack-cb').focus();
        logln('! "Reuse the detected audit column" overwrites existing values - tick the acknowledgement, or choose "Create a new column".');
        setStatus('warn'); return;
      }
      var ws = session.wb.Sheets[session.sheet];
      // Resolve the write-back NOTES column from the picker (detection is only the default) - but
      // never again once a column has been APPENDED (defeating ensureNoteCol's guard would append a
      // SECOND "Audit Notes" column and split one audit across two half-blank columns). Skipped in
      // Operations mode: no narrative note is written, so there is no column to resolve or append.
      if (wantNote && !session.map.noteAppended) {
        var pick = $('bwn-woaudit-notecol').value;
        if (pick === 'append') { session.map.note = -1; ensureNoteCol(ws, session.map); }
        else { session.map.note = parseInt(pick, 10); if (isNaN(session.map.note)) { session.map.note = -1; ensureNoteCol(ws, session.map); } }
      }
      // Flags column, per the chosen output mode. "new" forces a fresh appended column (leaving any
      // detected one untouched); "reuse" writes into the detected column. flagAppended guards a
      // retry from appending a second column.
      if (cfg.flagsMode === 'new') {
        if (!session.map.flagAppended) { session.map.flag = -1; ensureFlagCol(ws, session.map); }
      } else {
        if (session.map.flag === -1 && !session.map.flagAppended) ensureFlagCol(ws, session.map);
      }
      // The 16 structured Operations columns (appended once; reused by name on a re-run).
      if (wantActions) ensureActionCols(ws, session.map);
      // Remember the mode + the run date for downloadResult (the Action List sheet is assembled at
      // download from the settled results, so a cancel/retry always reflects the final state).
      session.outputMode = cfg.outputMode;
      session.includeMonitor = cfg.includeMonitor;
      session.runDate = actRunDate(Date.now());       // 'YYYY-MM-DD' string, stable for this run
      // Run configuration snapshot for the Audit Rules sheet's transparency block (Commit 2).
      session.checksLabel = Object.keys(cfg.checks).filter(function (k) { return cfg.checks[k]; }).join(', ') || '(none)';
      session.clientDays = clientDays;
      session.woColName = session.map.keyName || '';
      session.noteColName = wantNote ? (session.map.noteName || '') : '(not written in Operations mode)';

      // Resume, not just retry: rows a cancel skipped owe a note exactly as much as errored rows do.
      var targets = retryOnly
        ? pendingRows(session.rows, session.results)
        : session.rows.slice();
      if (retryOnly && !targets.length) { logln('Nothing left to finish - every row has a note.'); return; }

      // Lock config (values preserved) + switch the UI into the processing state.
      lockConfig(true);
      $('bwn-woaudit-start').disabled = true;
      $('bwn-woaudit-retry').style.display = 'none';
      var dl0 = $('bwn-woaudit-dl'); dl0.disabled = true; dl0.classList.remove('woa-btn-primary');
      var ph = $('bwn-woaudit-post'); if (ph) ph.innerHTML = '';   // rebuilt when the run finishes
      $('woa-empty-prog').style.display = 'none';
      $('bwn-woaudit-prog').classList.add('is-show');
      $('woa-run-ctrls').classList.add('is-show');
      var dgh = $('bwn-woaudit-diag'); if (dgh) dgh.innerHTML = '';   // clear last run's diagnostics
      $('bwn-woaudit-cancel').disabled = false;
      if (_paused) setPaused(false);
      _running = true; _cancelled = false;
      _runStart = Date.now(); _flagged = 0; _lastCur = '';
      setStatus('proc'); setStep(3);
      setWarn('');
      // One id per pass so every row can be correlated in the diagnostics copy. In-memory only:
      // per-row diagnostics deliberately do NOT go into the shared bwn:audit write trail (that ring
      // buffer is the cross-script WRITE trail and per-row rows would bury real writes).
      var RUN_ID = bwnCorrId();
      if (!retryOnly) { log.innerHTML = ''; log.style.display = 'none'; session.results = new Array(session.rows.length); }
      logln((retryOnly ? 'Retrying ' : 'Auditing ') + targets.length + ' work orders (' + conc + ' at a time)...');
      updateProgress(0, targets.length, null);

      // ---- Operations Action layer (wantActions). Computes the structured record for one row and a
      // flat row object for the Action List sheet. The CALLER owns the dates (deriveAction is pure),
      // so ECD-due-soon / visit-past / future-onsite are resolved here from the live header. Live
      // Umbrava data is primary; the workbook cell is the fallback ONLY when the live field is absent.
      var LOCAL_MID = function (raw) {
        if (!raw) return null;
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw).trim());
        if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        var p = new Date(String(raw)); return isNaN(+p) ? null : new Date(p.getFullYear(), p.getMonth(), p.getDate());
      };
      function computeActionForRow(row, h, facts, flags, ageDays, notes) {
        var now = Date.now(), map = session.map, aoa = map.aoa, ri = row.rowIdx;
        var nd = new Date(now), todayMid = new Date(nd.getFullYear(), nd.getMonth(), nd.getDate());
        var ecdRaw = h && h.priority && h.priority.expectedCompletionDate;
        var ei = h ? ecdInfo(h, now) : null;
        var ecdMid = LOCAL_MID(ecdRaw), du = ecdMid ? (ecdMid - todayMid) / MS_DAY : null;
        var ecdDueSoon = !!(ecdMid && !(ei && ei.past) && du >= 0 && du <= 1);
        var onsiteMid = LOCAL_MID(h && h.nextOnsiteDate);
        var visitPast = !!(onsiteMid && onsiteMid < todayMid);
        var hasFutureOnsite = !!(onsiteMid && onsiteMid >= todayMid);
        var onsiteDaysAway = onsiteMid ? Math.round((onsiteMid - todayMid) / MS_DAY) : null;
        var ecdDaysAway = (ecdMid && !(ei && ei.past)) ? Math.round(du) : null;
        var wbPriority = cellStr(aoa, ri, map.priority), wbFm = cellStr(aoa, ri, map.fm);
        var wbAssigned = cellStr(aoa, ri, map.assigned), wbTrade = cellStr(aoa, ri, map.trade);
        var wbVendor = cellStr(aoa, ri, map.vendor), wbScope = cellStr(aoa, ri, map.scope);
        var wbEcd = cellStr(aoa, ri, map.ecd), wbNextOnsite = cellStr(aoa, ri, map.nextOnsite);
        var wbLastNote = cellStr(aoa, ri, map.lastNote), wbStatusHrs = cellStr(aoa, ri, map.statusHours);
        var wbLocation = cellStr(aoa, ri, map.location), wbStatus = cellStr(aoa, ri, map.status);
        var liveTrade = tradeLabel(h);
        var noteBodies = (notes || []).slice(0, 4).map(function (n) { return String((n && n.content) || ''); }).join(' ');
        var nextOnsiteMd = fmtMD(h && h.nextOnsiteDate) || wbNextOnsite;
        var lastNoteMd = fmtMD(facts.latestMeaningfulEventDate) || wbLastNote;
        // Completion / remaining-scope signals for the queue model + contradictions. Deterministic
        // text scans over the same meaningful bodies the audit already read (never invents a fact).
        var completionRe = /\b(work (is |was )?complete|completed on ?site|closed out|sign(ed)?[- ]off|photos? (attached|uploaded|submitted)|\bnoc\b|invoice (submitted|attached|created))\b/i;
        var remainingRe = /\b(remaining (scope|work)|still (needs?|pending)|outstanding|not (yet )?complete|return trip|go[- ]?back|punch ?list|additional work|left to (do|complete))\b/i;
        var hasCompletionEvidence = (notes || []).some(function (n) { return n && n.isCompletion; }) || completionRe.test(noteBodies);
        var remainingScopeNoted = remainingRe.test(String(facts.latestMeaningfulEvent || '') + ' ' + noteBodies);
        var action = deriveAction({
          facts: facts, flags: flags, header: h,
          assignedTo: wbAssigned, fm: wbFm,
          scopeText: wbScope, notesText: (facts.latestMeaningfulEvent || '') + ' ' + noteBodies,
          priorityLabel: (h && h.priority && h.priority.label) || wbPriority,
          priorityCategory: (h && h.priority && h.priority.category) || '',
          ageDays: (typeof ageDays === 'number') ? ageDays : undefined,
          ageExpected: map.days !== -1, statusHours: wbStatusHrs,
          nextOnsiteMd: nextOnsiteMd, lastNoteMd: lastNoteMd,
          ecdDueSoon: ecdDueSoon, visitPast: visitPast, hasFutureOnsite: hasFutureOnsite,
          onsiteDaysAway: onsiteDaysAway, ecdDaysAway: ecdDaysAway, hasNextOnsiteField: !!(h && h.nextOnsiteDate) || !!wbNextOnsite,
          hasCompletionEvidence: hasCompletionEvidence, remainingScopeNoted: remainingScopeNoted,
          meaningfulUpdateDays: (typeof facts.staleDays === 'number') ? facts.staleDays : undefined,
          staleDays: auditCfg('staleDays', STALE_DAYS), includeMonitor: session.includeMonitor
        });
        var ecdDisplay = fmtMD(ecdRaw) || wbEcd || (facts.ecdText && facts.ecdText !== 'TBD' ? facts.ecdText : '');
        if (ecdDisplay && ei && ei.past) ecdDisplay += ' (lapsed)';
        var actionRow = {
          include: action.include, priorityKey: action.priorityKey, priority: action.priority,
          actionDue: action.actionDue, dueRank: action.dueRank, bucket: action.bucket,
          nextAction: action.nextAction, owner: action.owner, escalateTo: action.escalateTo,
          managerReview: action.managerReview, managerReviewBool: action.managerReviewBool,
          primaryIssue: action.primaryIssue, riskFlags: action.riskFlags, evidence: action.evidence,
          confidence: action.confidence, ruleIds: action.ruleIds,
          wo: row.key, status: (h && h.statusName) || wbStatus, srcPriority: (h && h.priority && h.priority.label) || wbPriority,
          location: wbLocation || [cellStr(aoa, ri, map.city), cellStr(aoa, ri, map.state)].filter(Boolean).join(', '),
          fm: wbFm, assignedTo: wbAssigned, trade: liveTrade || wbTrade, vendor: wbVendor,
          ecd: ecdDisplay, nextOnsite: nextOnsiteMd, lastNoteDate: lastNoteMd,
          ageDays: (typeof ageDays === 'number') ? ageDays : null, sourceRow: ri + 1,
          // ---- work-queue model fields (0.18.0) ----
          actionQueue: action.actionQueue, queueKey: action.queueKey, queueMonitor: action.queueMonitor,
          queuePriority: action.queuePriority, queuePriorityKey: action.queuePriorityKey,
          dailyRank: action.dailyRank, rankComponents: action.rankComponents,
          operationalRiskScore: action.operationalRiskScore, actionabilityScore: action.actionabilityScore,
          queueNextAction: action.queueNextAction, actionOwner: action.actionOwner, dueDateTime: action.dueDateTime,
          waitingOn: action.waitingOn, expectedResponseDate: action.expectedResponseDate,
          definitionOfDone: action.definitionOfDone, escalationTrigger: action.escalationTrigger,
          blockerCategory: action.blockerCategory, validWaitingState: action.validWaitingState,
          actionUndefinedReasons: action.actionUndefinedReasons, contradictions: action.contradictions,
          lastMeaningfulUpdate: action.lastMeaningfulUpdate, nextScheduledEvent: action.nextScheduledEvent,
          priorityReasons: action.priorityReasons, queueReasons: action.queueReasons
        };
        return { action: action, actionRow: actionRow };
      }
      function writeActionCols(ws, map, rowIdx, a, runDate) {
        var v = {
          'Audit Include': a.include ? 'Yes' : 'No', 'Audit Priority': a.priority, 'Action Bucket': a.bucket,
          'Primary Issue': a.primaryIssue, 'Required Next Action': a.nextAction, 'Action Owner': a.owner,
          'Escalate To': a.escalateTo, 'Action Due': a.actionDue, 'Risk Flags': a.riskFlags,
          'Evidence': a.evidence, 'Recommended Status': a.recommendedStatus, 'Manager Review': a.managerReview,
          'Audit Confidence': a.confidence, 'Audit Rule IDs': a.ruleIds, 'Audit Data Gaps': a.dataGaps,
          'Audit Run Date': runDate
        };
        for (var name in map.action) {
          if (!Object.prototype.hasOwnProperty.call(map.action, name)) continue;
          ws[XLSX.utils.encode_cell({ c: map.action[name], r: rowIdx })] = { t: 's', v: String(v[name] == null ? '' : v[name]) };
        }
      }

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
        // The row's pre-audit workbook note from the aoa snapshot (ORIGINAL text even on a retry) -
        // what a retention decision compares against. '' when the notes column was appended.
        var priorNote = cellStr(session.map.aoa, row.rowIdx, session.map.note);
        // Park here (not mid-fetch) when paused: the worker holds before starting a new row, so
        // in-flight rows still finish and the workbook is never left half-written.
        return waitIfPaused().then(function () {
          if (!_cancelled) { _lastCur = row.key; var c = $('woa-cur'); if (c) c.textContent = 'Processing WO ' + row.key + '…'; }
          return woFetch(row.key);
        })
          .then(function (data) {
            var h = data.header;
            // Deterministic flags first, written straight to the sheet - they need no AI, so they
            // survive even if the summarize below fails (credits/throttle). A header miss -> [].
            // applyChecks gates the deterministic flags by the operator's enabled checks and appends
            // the cancellation review flag; an empty/partial cfg reproduces the full flag set.
            // Computed unconditionally so the structured row result can carry `flags` even when no
            // flags column is written.
            var flags = applyChecks(computeFlags(h, data.notes, Date.now()), data.notes, cfg.checks, { clientSet: clientCtx.clientSet, clientDays: clientCtx.clientDays, nowMs: Date.now() });
            if (session.map.flag > -1) {
              ws[XLSX.utils.encode_cell({ c: session.map.flag, r: row.rowIdx })] = { t: 's', v: flags.join(', ') };
              if (flags.length) _flagged++;
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
            // The deterministic Operations Action record (bucket/priority/owner/escalation/due/...).
            // Computed here from the SAME live header + facts + flags, before any AI, and attached to
            // every return path so retained and note-skipped rows still carry their action row.
            var actionRec = wantActions ? computeActionForRow(row, h, facts, flags, ageDays, data.notes) : null;
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
                ageDays: ageDays, over30: over30, header: h, review: review, action: actionRec
              };
            }
            // Operations Action List mode is the fast management-only run: no per-WO AI note. The
            // structured action layer + flags are already computed deterministically; skip the model.
            if (!wantNote) {
              return {
                retained: false, noteSkipped: true, note: '', degraded: '', facts: facts, flags: flags,
                notesFound: data.notes.length, evidenceCount: evidenceNotes.length,
                matchConfidence: data.matchConfidence, priorAudit: priorAudit,
                ageDays: ageDays, over30: over30, header: h, review: review, action: actionRec
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
                priorAudit: priorAudit, ageDays: ageDays, over30: over30, header: h, review: review, action: actionRec
              };
            });
          })
          .then(function (out) {
            var h = out.header;
            // A RETAINED row is never written: the whole point is that the client's existing cell
            // survives untouched. A note-SKIPPED row (Operations mode) writes no note either. Every
            // other row writes the drafted note, dropping any formula.
            if (!out.retained && !out.noteSkipped && session.map.note > -1) {
              ws[XLSX.utils.encode_cell({ c: session.map.note, r: row.rowIdx })] = { t: 's', v: out.note };
            }
            // The 16 structured Operations columns, for every mode that produces them.
            if (wantActions && out.action) writeActionCols(ws, session.map, row.rowIdx, out.action.action, session.runDate);
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
              noteMode: out.noteSkipped ? 'operations' : (out.retained ? 'retained' : (out.degraded ? 'deterministic_fallback' : 'ai')),
              priorNote: priorNote,
              proposedNote: (out.retained || out.noteSkipped) ? '' : out.note,
              finalNote: out.note,
              noteValidation: { valid: !out.degraded, reasons: out.degraded ? [out.degraded] : [] },
              reviewRequired: !!reasons.length,
              reviewReasons: reasons,
              changed: !out.retained && !out.noteSkipped && String(out.note || '') !== String(priorNote || ''),
              action: out.action ? out.action.action : null,
              actionRow: out.action ? out.action.actionRow : null,
              postEligible: false, postIneligibleReason: null,
              error: null
            };
            logln('  WO ' + row.key + ' (' + out.notesFound + ' notes, ' + out.evidenceCount + ' usable)' +
              (out.retained ? ' [RETAINED - existing note kept]' : '') +
              (out.noteSkipped ? ' [action list only]' : '') +
              (out.degraded ? ' [deterministic note - ' + out.degraded + ']' : '') +
              (out.action ? ' [' + out.action.action.priority + ' / ' + out.action.action.bucket + ']' : '') + ': ' +
              (out.note ? out.note.slice(0, 90) : '(no status note)'));
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
      }, conc, function (done, total) { updateProgress(done, total, null); },
        function () { return _cancelled; })
        .then(function () {
          _running = false; _paused = false; releasePause();
          lockConfig(false);
          $('woa-run-ctrls').classList.remove('is-show');
          var tal = auditTally(session.results, session.rows.length);
          updateProgress(tal.ok + tal.errs, session.rows.length, null);
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
          var incomplete = tal.errs + tal.skipped;
          var sb = $('bwn-woaudit-start');
          var db = $('bwn-woaudit-dl');
          var rb = $('bwn-woaudit-retry');
          // Download becomes available now that an output workbook exists; on a clean finish it is
          // promoted to the primary next action and Start becomes a non-actionable completion marker.
          if (db) { db.disabled = false; if (!incomplete && !degraded) db.classList.add('woa-btn-primary'); }
          if (incomplete || degraded) {
            if (sb) { sb.disabled = false; sb.classList.remove('is-complete'); sb.innerHTML = ICON.play + '<span>Start audit</span>'; }
            if (rb) rb.style.display = '';   // degraded rows are in pendingRows - Retry must be reachable
            setStatus('warn'); setStep(3);
          } else {
            if (sb) { sb.disabled = true; sb.classList.add('is-complete'); sb.innerHTML = ICON.check + '<span>Audit complete</span>'; }
            if (rb) rb.style.display = 'none';
            setStatus('done'); setStep(4);
          }
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
      wrap.className = 'woa-sect';
      var h = document.createElement('div');
      h.className = 'woa-sect-hd';
      h.innerHTML = ICON.activity + '<span>Run diagnostics</span>';
      wrap.appendChild(h);
      var lines = [];
      if (cov.unmapped.length) {
        var box = document.createElement('div');
        box.className = 'woa-banner is-warn';
        box.style.marginBottom = '8px';
        box.innerHTML = ICON.warn + '<span>' + esc('Umbrava status names this build does not map (' + cov.unmapped.length + '): ' +
          cov.unmapped.map(function (o) { return '"' + o.status + '" x' + o.count; }).join(', ') +
          '. Those rows printed the status verbatim at low confidence rather than being mapped to a guessed stage. Nothing was changed automatically.') + '</span>';
        wrap.appendChild(box);
        lines.push('UNMAPPED STATUSES (' + cov.unmapped.length + ' of ' + cov.observed.length + ' seen):');
        cov.unmapped.forEach(function (o) { lines.push('  ' + o.status + '\tx' + o.count); });
      }
      if (reviews.length) {
        var rb = document.createElement('div');
        rb.className = 'woa-banner is-info';
        rb.style.marginBottom = '8px';
        rb.innerHTML = ICON.info + '<span>' + esc(reviews.length + ' row' + (reviews.length === 1 ? '' : 's') + ' need review: ' +
          reviews.slice(0, 12).map(function (r) { return 'WO ' + r.key; }).join(', ') +
          (reviews.length > 12 ? ', ...' : '') + '. Reasons are in the copy below and on each card.') + '</span>';
        wrap.appendChild(rb);
        lines.push('', 'REVIEW REQUIRED (' + reviews.length + '):');
        reviews.forEach(function (r) {
          lines.push('  WO ' + r.key + '\t' + (r.noteMode || '') + '\t' + (r.sourceStatusName || '(status unread)'));
          (r.reviewReasons || []).forEach(function (x) { lines.push('    - ' + x); });
        });
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = ICON.copy + '<span>Copy diagnostics</span>';
      btn.className = 'woa-btn woa-btn-ghost woa-btn-sm woa-diag-copy';
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
      wrap.className = 'woa-sect';
      var h = document.createElement('div');
      h.className = 'woa-sect-hd';
      h.innerHTML = ICON.file + '<span>Post drafted notes to work orders</span>';
      wrap.appendChild(h);
      var sub = document.createElement('div');
      sub.className = 'woa-sect-sub';
      sub.textContent = 'Posts the drafted note as an INTERNAL note on the work order. One click per note - jobs aged over 30 days only.';
      wrap.appendChild(sub);
      // If there is no days column, every row is eligible by construction - surface that once.
      if (session.map.days === -1) {
        var notice = document.createElement('div');
        notice.className = 'woa-banner is-warn';
        notice.style.marginBottom = '10px';
        notice.innerHTML = ICON.warn + '<span>No days/aged column detected - treating every row as aged &gt;30d (this export is over-30 by construction).</span>';
        wrap.appendChild(notice);
      }
      rows.forEach(function (r) {
        var card = document.createElement('div');
        card.className = 'woa-pcard';
        var head = document.createElement('div');
        head.className = 'woa-pcard-hd';
        var label = document.createElement('div');
        label.className = 'woa-pcard-t';
        label.textContent = 'WO ' + r.key + '  -  ' + (r.ageDays == null ? 'age n/a' : (r.ageDays + 'd'));
        head.appendChild(label);
        var status = document.createElement('span');
        status.className = 'woa-pstatus';
        head.appendChild(status);
        card.appendChild(head);
        // The derived reading, shown BEFORE the post button: an operator should be able to see the
        // stage, the blocker and who owns it without reading the whole note back out of the box.
        if (r.facts) {
          var fx = document.createElement('div');
          fx.className = 'woa-pfacts';
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
        meta.className = 'woa-pmeta';
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
          rv.className = 'woa-banner is-err';
          rv.style.marginBottom = '6px';
          rv.innerHTML = ICON.warn + '<span style="white-space:pre-line">' + esc('Review required:\n- ' + r.reviewReasons.join('\n- ')) + '</span>';
          card.appendChild(rv);
        }
        if (r.degraded) {
          var dg = document.createElement('div');
          dg.className = 'woa-banner is-warn';
          dg.style.marginBottom = '6px';
          dg.innerHTML = ICON.warn + '<span>' + esc('Deterministic note (no AI phrasing): ' + r.degraded) + '</span>';
          card.appendChild(dg);
        }
        var ta = document.createElement('textarea');
        ta.readOnly = true;
        ta.value = r.note;
        ta.className = 'woa-pnote';
        card.appendChild(ta);
        // ONE ordered answer to "can this be posted, and if not why not", so the operator reads the
        // reason on the card instead of discovering it from a failed click. Display only: bwnGqlOp
        // remains the enforcement point for the kill switch and the Umbrava permission, and nothing
        // here can widen what it allows.
        var block = postBlockReason(r);
        r.postIneligibleReason = block;
        r.postEligible = !block && !r.posted;
        if (r.posted) {
          status.className = 'woa-pstatus is-ok'; status.textContent = 'posted ✓';
        } else if (block) {
          status.className = 'woa-pstatus is-block'; status.textContent = 'cannot post - ' + block;
        } else {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.innerHTML = ICON.upload + '<span>Post</span>';
          btn.className = 'woa-btn woa-btn-primary woa-btn-sm';
          btn.onclick = function () {
            btn.disabled = true;
            status.className = 'woa-pstatus'; status.textContent = 'posting…';
            postAuditNote(r.key, r.note).then(function () {
              r.posted = true;
              status.className = 'woa-pstatus is-ok'; status.textContent = 'posted ✓';
              try { btn.remove(); } catch (e) { }
              logln('  posted WO-audit note on WO ' + r.key);
            }, function (e) {
              var msg = (e && e.message) || String(e);
              status.className = 'woa-pstatus is-fail'; status.textContent = 'failed: ' + msg;
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
      // Assemble the WO Action List worksheet from the settled results (Operations / Hybrid only).
      // Built at download so a cancel/retry always reflects the final state; rebuilt (replaced) on a
      // repeat download. Text-first: column widths + an autofilter are the only Excel features the
      // bundled community SheetJS writes reliably - NO fills, tables, conditional formatting or panes.
      if (session.outputMode && session.outputMode !== 'detailed') {
        try {
          var arows = [];
          for (var ai = 0; ai < session.rows.length; ai++) {
            var rr = session.results[ai];
            if (rr && rr.actionRow) arows.push(rr.actionRow);
          }
          var sheetDate = actSheetDate(Date.now());
          // PRIMARY: the queue-grouped operational work list. Sections are self-labelled with counts,
          // so no autofilter (banner rows would break the range); the flat filterable table lives on
          // Action Diagnostics below.
          var qres = buildQueueListAoa(arows, session.includeMonitor);
          var alName = 'WO Action List - ' + sheetDate;
          appendAoaSheet(session.wb, alName, qres.aoa, QUEUE_SHEET_WIDTHS);
          logln('Built "' + alName + '" - Today ' + qres.todayTotal + ' (Immediate ' + qres.counts.IMMEDIATE + ' / Execute ' + qres.counts.EXECUTE + ' / Follow Up ' + qres.counts.FOLLOWUP + ').');

          // Action Diagnostics: the flat, filterable table of every actionable row (legacy audit
          // columns + evidence) for power users who want to sort/filter the whole set.
          var diagAoa = buildActionListAoa(arows, session.includeMonitor);
          var diagName = 'Action Diagnostics - ' + sheetDate;
          var diagSheet = appendAoaSheet(session.wb, diagName, diagAoa, ACTION_SHEET_WIDTHS);
          if (diagSheet['!ref']) diagSheet['!autofilter'] = { ref: diagSheet['!ref'] };

          // Dashboard + Audit Rules sheets, built from the SAME settled action rows.
          var runStamp = actRunDate(Date.now()) + ' ' + new Date().toTimeString().slice(0, 5);
          var dashName = 'WO Audit Dashboard - ' + sheetDate;
          var dashAoa = buildDashboardAoa(arows, {
            sheetTitle: dashName, runStamp: runStamp, sourceSheet: session.sheet,
            mode: session.outputMode, includeMonitor: session.includeMonitor, total: session.rows.length,
            queueCounts: qres.counts, todayTotal: qres.todayTotal
          });
          appendAoaSheet(session.wb, dashName, dashAoa, [22, 60, 16, 26, 22, 60]);
          var rulesName = 'Audit Rules - ' + sheetDate;
          var rulesAoa = buildAuditRulesAoa({
            sheetTitle: rulesName, runStamp: runStamp, mode: session.outputMode, includeMonitor: session.includeMonitor,
            checks: session.checksLabel, clientDays: session.clientDays, sourceSheet: session.sheet,
            woCol: session.woColName, noteCol: session.noteColName, weights: ACT_CFG.weights
          });
          var rulesSheet = appendAoaSheet(session.wb, rulesName, rulesAoa, [26, 52, 30, 30, 52, 40, 40, 44]);
          // Autofilter over the rule TABLE only (header row + the 11 rule rows), not the config block.
          try {
            rulesSheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: RULE_CATALOG_HEADER_ROW, c: 0 }, e: { r: RULE_CATALOG_HEADER_ROW + RULE_CATALOG.length, c: RULE_CATALOG_COLS.length - 1 } }) };
          } catch (e) { /* autofilter is a nicety; a failure must not block the export */ }
          logln('Built "' + dashName + '" and "' + rulesName + '".');
        } catch (e) { logln('! Could not build the Action List / Dashboard sheets: ' + ((e && e.message) || e)); }
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
