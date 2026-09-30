// ==UserScript==
// @name         BWN Suite - Low GP Note (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.5.2
// @description  A "Low GP" button beside the global "Search Work Orders" box. Enter a WO#, Tracking#, Source PO#, or Source Job#; it finds the work order, shows a CONFIRM step (WO / client / location / assignee / both note bodies, plus a warn-only notice if the WO already has an active Billing "Low GP" note), then posts TWO notes via Umbrava's own API: a Billing-type note reading "Low GP", and a second note that @-mentions the WO's assignee ("@Name Low GP note added"). The @-mention is the real TipTap mention span the SPA sends (captured live 2026-08-17); actionNoteEmails stays null - the span alone notifies. The mention is skipped when the WO has no assignee user GUID. Same-origin /api/graphql with the app's Auth0 bearer, @grant none, zero egress. Nothing posts until you click Confirm.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-low-gp.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-low-gp.user.js
// ==/UserScript==
(function () {
  'use strict';

  // ===== Pure logic (sliced + unit-tested by scripts/test-low-gp.js) =====================
  // LOW-GP-SLICE-START
  var BILLING_TYPE_NAME = 'Billing';   // note #1 type (id 3 in the 82-type map) - Mike's spec
  var PING_TYPE_NAME = 'Internal';     // note #2 type (id 13); the @-mention notifies regardless of type
  var NOTE1_CONTENT = 'Low GP';        // note #1 body
  var PING_MESSAGE = 'Low GP note added';   // note #2 body (after the @-mention)

  function lgIsGuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s == null ? '' : s)); }

  function lgEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ESC-rank visibility floor (server-computed ladder: 1 staff .. 5 director). The Low GP button
  // posts a Billing GP write-down note - a management-visible call, gated to manager+ (rank 4).
  // Pure decision so the test pins it; the localStorage rank read lives outside the slice.
  // Fail-CLOSED: an unresolved rank yields 'wait' (button never shown until the rank proves
  // >= floor), mirroring the dock's BWN_DOCK_POLICY contract (bwn-suite-core, PR #106).
  var LOWGP_MIN_RANK = 4;
  function lgRankGate(rk) { return (typeof rk !== 'number') ? 'wait' : (rk < LOWGP_MIN_RANK ? 'hide' : 'show'); }

  // Note-type id resolved by NAME from Core's bwn:noteTypes cache (82 types; Core populates it).
  // cacheRaw is the raw localStorage string (or null). Floor covers the two types this script needs,
  // so a missing cache never blocks a note. Never hardcode past the floor, never infer from position.
  var LG_TYPE_FLOOR = { 'billing': 3, 'internal': 13 };
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

  // Note #2 gate: the mention needs a real assignee user GUID (data-id) - that is what notifies.
  // data-tenant is NOT gated: the SPA no longer stores localStorage.tenantId (checked live 2026-09-29),
  // and 0.4.0 posted data-tenant="" for months with the @-mention still notifying. Gating on it (0.5.0)
  // silently skipped every mention. Missing assignee -> skip note #2 (note #1 still posts) and say why.
  function lgNote2Gate(row) {
    if (!row || !lgIsGuid(row.assigneeId)) return { send: false, reason: 'no-assignee' };
    return { send: true, reason: '' };
  }

  // Duplicate warning. A note is an existing Low GP note ONLY when it is active (the read already
  // excludes deleted notes server-side; an isDeleted:true that is present anyway is still rejected,
  // an absent isDeleted reads as active), Billing-typed (id
  // resolved by name, passed in), and its plain-text content is exactly NOTE1_CONTENT after trimming
  // and collapsing whitespace. Warn-only: the caller never blocks on it.
  function lgNormText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function lgIsDupLowGp(note, billingId) {
    return !!note && typeof note === 'object' && !note.isDeleted && typeof billingId === 'number' &&
      note.type === billingId && lgNormText(note.content) === NOTE1_CONTENT;
  }
  // -> { status: 'found' | 'none' | 'unknown', note }. 'unknown' = the read failed or came back in a
  // shape we cannot trust (not an array, or no Billing id) - never reported as "no duplicate".
  function lgFindDupLowGp(notes, billingId) {
    if (!Array.isArray(notes) || typeof billingId !== 'number') return { status: 'unknown', note: null };
    for (var i = 0; i < notes.length; i++) { if (lgIsDupLowGp(notes[i], billingId)) return { status: 'found', note: notes[i] }; }
    return { status: 'none', note: null };
  }
  // createdDate -> 'M/D/YYYY' from the literal date part (same rule as wo-audit fmtMD: no Date
  // parsing, so no timezone shift and no day-age math). Unparseable -> '' (the caller omits it).
  function lgFmtNoteDate(createdDate) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(createdDate == null ? '' : createdDate).trim());
    if (!m) return '';
    var mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return mo + '/' + d + '/' + m[1];
  }

  // A read cancelled by its AbortController (Stop waiting / leaving the view). Never a lookup failure,
  // and never a reason to fire the slow fallback.
  function lgIsAbort(err) { return !!err && err.name === 'AbortError'; }

  // Note #1 failure classification. 'refused' = provably NOT posted: blocked before send (not signed
  // in, a bwnGqlOp gate: feature-off / permission / validation), a GraphQL error with NO data (rejected
  // before execution), or a success:false refusal. Everything else - a GraphQL error beside a data
  // object, fetch rejection, non-JSON body, timeout, unrecognized response - is 'uncertain': the
  // request may have landed, so the UI must not claim either way or offer a retry.
  function lgNote1Outcome(err) {
    if (!err || typeof err !== 'object') return 'uncertain';
    if (err.lgNotSent === true) return 'refused';
    var msg = String(err.message || '');
    if (/^bwnGqlOp: /.test(msg)) return 'refused';
    if (err.lgGqlExecuted === true) return 'uncertain';   // GraphQL errors[] beside data: execution ran
    if (/unrecognized write response/.test(msg)) return 'uncertain';
    if (/network|failed to fetch|load failed|timeout|timed out|abort/i.test(msg)) return 'uncertain';
    if (err.lgGqlError === true || err.bwnNonTransient === true) return 'refused';
    return 'uncertain';
  }
  var LG_UNCERTAIN_MSG = 'We could not confirm whether the Billing note was posted. Check the WO notes before trying again.';
  // -> the error view model. actions never include a re-post: 'back' starts a fresh search and a
  // fresh confirm; an uncertain outcome offers only 'close'.
  function lgPostErrorView(err, woNumber) {
    if (lgNote1Outcome(err) === 'uncertain') {
      return { kind: 'uncertain', title: 'Posting status unknown', text: LG_UNCERTAIN_MSG, detail: '', actions: ['close'] };
    }
    return { kind: 'refused', title: 'Nothing was posted', text: 'Nothing was posted to WO #' + woNumber + '.',
      detail: (err && err.message) || String(err), actions: ['back', 'close'] };
  }

  // The two-note write, with its I/O injected so the order and the no-rollback rule are testable.
  //   deps.post(input) -> Promise   deps.typeId(name) -> id|null   deps.tenant   deps.onStep(n)
  // Billing note first; the Internal mention only after it succeeds AND the gate passes. A note #2
  // failure never undoes note #1 - it is reported in result.note2error.
  function lgApplyWith(row, deps) {
    return Promise.resolve().then(function () {
      var billingId = deps.typeId(BILLING_TYPE_NAME);
      if (billingId == null) { var e0 = new Error("Couldn't resolve the 'Billing' note type."); e0.lgNotSent = true; throw e0; }
      var result = { note1: false, note2: false, note2skipped: false, note2skipReason: '', note2error: '' };
      var note1 = lgNoteInput(row.number, billingId, NOTE1_CONTENT, lgSimpleHtml(NOTE1_CONTENT));
      return deps.post(note1).then(function () {
        result.note1 = true;
        var gate = lgNote2Gate(row);
        if (!gate.send) { result.note2skipped = true; result.note2skipReason = gate.reason; return result; }
        try { if (deps.onStep) deps.onStep(2); } catch (e1) { /* progress text only */ }
        var label = row.assigneeName || 'assignee';
        var note2 = lgNoteInput(row.number, deps.typeId(PING_TYPE_NAME),
          lgPingContent(label, PING_MESSAGE),
          lgMentionHtml(label, row.assigneeId, deps.tenant, PING_MESSAGE));
        return deps.post(note2).then(
          function () { result.note2 = true; return result; },
          function (err) { result.note2error = (err && err.message) || String(err); return result; }
        );
      });
    });
  }

  // Session controller: the ONE owner of the panel's phase. Every async callback captures a token
  // {sid, gen} and must pass isCurrent() before touching the UI - any view change bumps gen, any new
  // session bumps sid. The posting lock is taken synchronously by beginPosting() and held until
  // finish(); while held nothing can change phase, close, or start a new session, and `hold` keeps
  // the session (and its terminal outcome) alive across a close/reopen until the user closes the
  // terminal view. Confirm needs a fresh activation armed ON the confirm button after it rendered.
  function lgSessionCtl() {
    var s = { sid: 0, gen: 0, phase: 'closed', posting: false, hold: false, armed: false };
    function tok() { return { sid: s.sid, gen: s.gen }; }
    function isCurrent(t) { return !!t && t.sid === s.sid && t.gen === s.gen; }
    return {
      phase: function () { return s.phase; },
      isPosting: function () { return s.posting; },
      token: tok,
      isCurrent: isCurrent,
      open: function () {
        if (s.hold) return { resume: true, token: tok() };
        s.sid++; s.gen = 0; s.phase = 'input'; s.armed = false;
        return { resume: false, token: tok() };
      },
      go: function (phase) {
        if (s.posting || s.phase === 'closed' || phase === 'posting') return null;
        s.gen++; s.phase = phase; s.armed = false;
        return tok();
      },
      arm: function () { if (s.phase === 'confirm' && !s.posting) s.armed = true; },
      disarm: function () { s.armed = false; },
      canConfirm: function (act) {
        return s.phase === 'confirm' && !s.posting && s.armed === true && !(act && act.detail > 1);
      },
      beginPosting: function () {
        if (s.posting || s.phase !== 'confirm') return null;
        s.posting = true; s.hold = true; s.armed = false; s.gen++; s.phase = 'posting';
        return tok();
      },
      finish: function (t, phase) {
        if (!s.posting || !isCurrent(t)) return false;
        s.posting = false; s.phase = phase;
        return true;
      },
      canClose: function () { return !s.posting; },
      close: function () {
        if (s.posting) return false;
        s.hold = false; s.phase = 'closed'; s.gen++; s.armed = false;
        return true;
      }
    };
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
  function lgCacheRaw() { try { return localStorage.getItem('bwn:noteTypes'); } catch (e) { return null; } }
  function lgTenant() { try { return lgUnwrap(localStorage.getItem('tenantId')); } catch (e) { return ''; } }

  // `signal` (optional) is passed ONLY by the lookup / duplicate-check READS so Stop waiting can abort
  // them. The write path (bwnGql -> lgGql) never passes one. Error flags feed lgNote1Outcome:
  // lgNotSent = refused before any request left; lgGqlError = the server answered with a GraphQL error;
  // lgGqlExecuted = that error came back alongside a data object (execution ran).
  function lgGql(op, query, variables, signal) {
    var tok = authToken();
    if (!tok) { var ns = new Error('Not signed in to Umbrava (no app token found).'); ns.lgNotSent = true; return Promise.reject(ns); }
    var init = {
      method: 'POST',
      credentials: 'include',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName: op, query: query, variables: variables || {} })
    };
    if (signal) init.signal = signal;
    return fetch('/api/graphql', init).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) {
        var ge = new Error(j.errors[0].message || 'GraphQL error'); ge.lgGqlError = true;
        // errors[] WITH a data object = the operation executed (a resolver may have written) -> the
        // write outcome is not provable. errors[] with no data = rejected before execution.
        if (j.data && typeof j.data === 'object') ge.lgGqlExecuted = true;
        throw ge;
      }
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
  function lgFetchByNumbers(nums, signal) {
    if (!nums.length) return Promise.resolve([]);
    return lgGql('BwnLowGpByNum', LG_BYNUM_Q, {
      page: { skip: 0, take: nums.length }, sortBy: [{ columnName: 'number', direction: 'DESC' }], WorkOrderNumbers: nums
    }, signal).then(lgRowsFromList);
  }
  function lgSearchSlow(text, signal) {
    return lgGql('BwnLowGpSearch', LG_SEARCH_Q, {
      page: { skip: 0, take: 25 }, sortBy: [{ columnName: 'numberOfDays', direction: 'DESC' }], search: String(text)
    }, signal).then(lgRowsFromList);
  }
  // opts: { signal, onPhase('expanded') } - onPhase fires when the slow fallback starts, so the UI can
  // say so honestly. An abort is re-thrown, never treated as "lookupJob broke".
  function lgSearch(text, opts) {
    opts = opts || {};
    return lgGql('LookupJob', LG_LOOKUP_Q, {
      page: { skip: 0, take: 25 }, sortBy: [{ columnName: 'LastModified', direction: 'DESC' }], search: String(text)
    }, opts.signal).then(function (d) {
      var items = (d && d.lookupJob && d.lookupJob.items) || [], seen = {}, nums = [];
      items.forEach(function (it) { var n = it.number; if (typeof n === 'number' && !seen[n]) { seen[n] = 1; nums.push(n); } });
      return lgFetchByNumbers(nums, opts.signal);
    }).catch(function (err) {
      if (lgIsAbort(err)) throw err;
      if (opts.onPhase) opts.onPhase('expanded');
      return lgSearchSlow(text, opts.signal);   // lookupJob broke -> slow but working
    });
  }

  // Duplicate check: the same jobNotes read bwn-drop-upload / bwn-wo-audit already use (not a paged
  // list, so no page/sortBy). Every selected field is wire-proven there (bwn-ask NOTES_Q, drop-upload
  // BwnDuNotes); isDeleted is deliberately NOT selected on jobNotes - includeDeleted:false is the
  // server-side deleted filter. Resolves to the raw array (or undefined) for lgFindDupLowGp to judge.
  var LG_NOTES_Q = 'query BwnLowGpNotes($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content createdDate } }';
  function lgFetchNotes(woNumber, signal) {
    return lgGql('BwnLowGpNotes', LG_NOTES_Q, { n: woNumber }, signal).then(function (d) { return d ? d.jobNotes : undefined; });
  }

  // ---- BWN-OPS: audited GraphQL wrapper for this sandbox --------------------
  // Routes the Low GP note write through bwnGqlOp (the paste-identical BWN-OPS-WRAP below,
  // SHA-gated to Core): a correlation id + the shared bwn:audit entry + centralized success:false
  // rejection. addEditJobNote is moderate (no confirm gate). bwnGql wraps this file's 3-arg lgGql,
  // recovering the SPA operation name (the document's second token) for lgGql's operationName arg
  // without a regex. The WO-lookup reads stay on lgGql directly.
  var bwnGql = function (query, variables) {
    var q = String(query), i = 0, n = q.length;
    while (i < n && q.charAt(i) <= ' ') i++;
    while (i < n && q.charAt(i) > ' ') i++;
    while (i < n && q.charAt(i) <= ' ') i++;
    var j = i;
    while (j < n) { var c = q.charAt(j); if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_') j++; else break; }
    return lgGql(q.slice(i, j) || null, query, variables);
  };
  var BWN_VER = '0.5.2';

  // Reader for the server-computed ESC rank (grant-none-safe; mirrors bwnEscRank / bwn-ask). Live
  // bus event trusted directly; the bwn:role:last slot is the cross-refresh fallback (ok + fresh).
  // Script-local, kept OUT of the paste-identical BWN-OPS-WRAP block below.
  var ROLE_TTL_MS = 6 * 3600 * 1000;
  var _lgLiveRank = null;
  try { document.addEventListener('bwn:evt', function (e) { var d = e && e.detail; if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _lgLiveRank = d.rank; }); } catch (e) { }
  function lgRank() {
    if (typeof _lgLiveRank === 'number') return _lgLiveRank;
    try { var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null'); if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank; } catch (e2) { }
    return null;
  }
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  // Central governance (governance-sync): fold the org flags bwn-suite-ai caches to bwn:gov into
  // BWN_MODULES as ONE-WAY disables, the SAME shape as bwn-suite-core's bwnApplyGov(). A remote
  // flags['lowGp']===false or flags.globalKillSwitch DISABLES this script's writes - the bwnGqlOp
  // per-feature gate below reads BWN_MODULES['lowGp'] live - and can NEVER enable one. Fail-closed:
  // an absent or corrupt bundle keeps the local defaults (last-known-good), never relaxes. Re-applies
  // on the bwn:gov ping so a remote kill blocks new writes with no reload.
  if (!('lowGp' in BWN_MODULES)) BWN_MODULES.lowGp = true;
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

  var LG_ADD_NOTE = 'mutation AddEditWONote($addEditInput: WorkOrderNoteInput!) { addEditJobNote(data: $addEditInput) { success message note { id type } } }';
  function lgPostNote(input) {
    // Routed through bwnGqlOp: correlation id + shared bwn:audit entry + centralized success:false
    // rejection. addEditJobNote is moderate (no confirm gate); ids carry the scalar WO number only
    // (the note text stays in variables, never the audit trail).
    return bwnGqlOp('addEditJobNote', LG_ADD_NOTE, { addEditInput: input }, { feature: 'lowGp', ids: { wo: input.workOrderNumber } }).then(function (d) {
      var res = d && d.addEditJobNote;
      if (!res || res.success !== true) throw new Error((res && res.message) || 'addEditJobNote reported no success');
      return res.note;
    });
  }

  // Post note #1 (Billing "Low GP"), then note #2 (@assignee ping) if the WO has an assignee GUID
  // (the tenant rides along as-is, possibly ''). Note #2 failing does NOT undo note #1 - the result carries per-note
  // outcome so the UI can tell the truth. The order + gate live in the sliced lgApplyWith.
  function lgApply(row, tenant, onStep) {
    return lgApplyWith(row, {
      post: lgPostNote,
      typeId: function (name) { return lgTypeId(name, lgCacheRaw()); },
      tenant: tenant,
      onStep: onStep
    });
  }

  // ===== Panel UI =================================================================================
  // ONE container at a time, always #bwn-lowgp-panel. Lookup views (input / loading / results / done /
  // error) live in a NON-modal popover (role=dialog, no trap). The irreversible step (confirm +
  // posting) swaps in a FRESH role=alertdialog aria-modal node with a Tab trap - the node is replaced,
  // never re-roled in place. lgSessionCtl (sliced + tested) owns the phase, the token every async
  // callback checks, the confirm arming, and the posting lock (module-level, survives a close).
  var BTN_ID = 'bwn-lowgp-btn';
  var PANEL_ID = 'bwn-lowgp-panel';
  var STYLE_ID = 'bwn-lowgp-style';
  var MODAL_VIEWS = { confirm: 1, posting: 1 };
  var ctl = lgSessionCtl();
  function lgFreshState(q) {
    return { query: q || '', invalid: false, rows: [], row: null, error: null, result: null, lookupPhase: 'fast', canStop: false, step: 1, total: 2 };
  }
  var st = lgFreshState('');
  var lgReads = [];   // AbortControllers of in-flight READS only - a write is never given a signal

  // Tokens: var(--bwn-*) only for names Core's injectTokens defines, each with the canonical
  // bn-theme literal (wiki/bwn-design-tokens.md) as fallback. Borders Core has no token for use the
  // canonical literal directly. One idempotent sheet, scoped to the launcher, the panel and .bwn-lg-*.
  var LG_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif';
  var LG_CSS = [
    '#bwn-lowgp-btn{margin-left:8px;min-height:32px;padding:6px 12px;border:1px solid transparent;border-radius:8px;cursor:pointer;color:#ffffff;background:var(--bwn-green,#1a5f3e);font-family:' + LG_FONT + ';font-size:13px;font-weight:600;line-height:1.2;text-transform:none;letter-spacing:normal;vertical-align:middle;white-space:nowrap;}',
    '#bwn-lowgp-btn:hover{background:var(--bwn-green-dk,#0d3d26);}',
    '#bwn-lowgp-btn:focus-visible,#bwn-lowgp-panel:focus-visible,#bwn-lowgp-panel :focus-visible{outline:2px solid var(--bwn-text-strong,#0d3d26);outline-offset:2px;}',
    '#bwn-lowgp-panel{position:fixed;z-index:99999;box-sizing:border-box;width:min(340px,calc(100vw - 16px));overflow:auto;padding:14px;background:var(--bwn-surface,#ffffff);color:var(--bwn-text,#1e293b);border:1px solid var(--bwn-border,#e2e8f0);border-radius:12px;box-shadow:var(--bwn-shadow,0 4px 14px rgba(0,0,0,.10),0 2px 4px rgba(0,0,0,.08));font-family:' + LG_FONT + ';font-size:13px;font-weight:400;line-height:1.5;text-align:left;text-transform:none;letter-spacing:normal;overflow-wrap:anywhere;}',
    '#bwn-lowgp-panel *{box-sizing:border-box;}',
    '#bwn-lowgp-panel [hidden]{display:none !important;}',
    '.bwn-lg-title{margin:0 0 10px;font-size:14px;font-weight:700;line-height:1.3;color:var(--bwn-text-strong,#0d3d26);}',
    '.bwn-lg-label{display:block;margin:0 0 4px;font-weight:600;}',
    '.bwn-lg-input{display:block;width:100%;min-height:32px;margin:0;padding:7px 10px;border:1px solid var(--bwn-text-muted,#64748b);border-radius:8px;background:var(--bwn-surface,#ffffff);color:var(--bwn-text,#1e293b);font:inherit;}',
    '.bwn-lg-input[aria-invalid="true"]{border-color:var(--bwn-bad-fg,#8b1a1a);}',
    '.bwn-lg-hint{margin:4px 0 10px;font-size:12px;color:var(--bwn-text-muted,#64748b);}',
    '.bwn-lg-err{color:var(--bwn-bad-fg,#8b1a1a);font-weight:600;}',
    '.bwn-lg-p{margin:0 0 10px;}',
    '.bwn-lg-muted{color:var(--bwn-text-muted,#64748b);}',
    '.bwn-lg-sub{display:block;}',
    '.bwn-lg-wo{display:block;font-weight:700;color:var(--bwn-text-strong,#0d3d26);}',
    '.bwn-lg-list{list-style:none;margin:0 0 4px;padding:0;}',
    '.bwn-lg-btn{display:block;width:100%;min-height:32px;margin:0 0 6px;padding:7px 12px;border:1px solid transparent;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;line-height:1.3;text-align:center;text-transform:none;letter-spacing:normal;}',
    '.bwn-lg-primary{background:var(--bwn-green,#1a5f3e);color:#ffffff;}',
    '.bwn-lg-primary:hover{background:var(--bwn-green-dk,#0d3d26);}',
    '.bwn-lg-ghost{background:var(--bwn-surface-3,#f1f5f9);color:var(--bwn-text,#1e293b);border-color:var(--bwn-border,#e2e8f0);}',
    '.bwn-lg-pick{text-align:left;font-weight:400;background:var(--bwn-surface,#ffffff);color:var(--bwn-text,#1e293b);border-color:var(--bwn-border,#e2e8f0);}',
    '.bwn-lg-pick:hover{background:var(--bwn-surface-2,#f8fafc);}',
    '.bwn-lg-btn:disabled{opacity:.55;cursor:not-allowed;}',
    '.bwn-lg-actions{display:flex;gap:8px;margin-top:4px;}',
    '.bwn-lg-actions .bwn-lg-btn{flex:1 1 0;margin:0;}',
    '.bwn-lg-dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0 0 10px;}',
    '.bwn-lg-dl dt{font-weight:600;color:var(--bwn-text-muted,#64748b);}',
    '.bwn-lg-dl dd{margin:0;}',
    '.bwn-lg-p.bwn-lg-dup,.bwn-lg-box.bwn-lg-dup{margin:10px 0 0;}',   // two classes: must beat the .bwn-lg-box / .bwn-lg-p margins
    '.bwn-lg-box{margin:0 0 10px;padding:8px 10px;border:1px solid;border-radius:8px;}',
    '.bwn-lg-warn{background:var(--bwn-warn-bg,#fff8e6);border-color:#f0d87a;color:var(--bwn-warn-fg,#7d5a00);}',
    '.bwn-lg-bad{background:var(--bwn-bad-bg,#fef0ee);border-color:#f7c9c9;color:var(--bwn-bad-fg,#8b1a1a);}',
    '.bwn-lg-ok{background:var(--bwn-ok-bg,#f0fdf4);border-color:#c6f0da;color:var(--bwn-ok-fg,#1a5f3e);}',
    '.bwn-lg-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}'
  ].join('\n');
  function lgEnsureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = LG_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- small DOM helpers (textContent only - no data ever reaches innerHTML) ----
  function lgEl(tag, cls, text, attrs) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function lgBtn(label, kind, onClick) {
    var b = lgEl('button', 'bwn-lg-btn bwn-lg-' + kind, label, { type: 'button' });
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  // A status box: text prefix (never color alone) + optional aria-hidden glyph.
  function lgBox(kind, glyph, prefix, text) {
    var box = lgEl('div', 'bwn-lg-box bwn-lg-' + kind);
    if (glyph) box.appendChild(lgEl('span', null, glyph + ' ', { 'aria-hidden': 'true' }));
    if (prefix) box.appendChild(lgEl('strong', null, prefix + ' '));
    box.appendChild(document.createTextNode(text));
    return box;
  }
  function lgTitle(b, text) { var t = lgEl('h2', 'bwn-lg-title', text, { id: 'bwn-lg-title' }); b.appendChild(t); return t; }
  function lgDt(dl, k, v) { dl.appendChild(lgEl('dt', null, k)); dl.appendChild(lgEl('dd', null, v)); }
  function lgPanel() { return document.getElementById(PANEL_ID); }

  // ---- read cancellation (AbortController on READS only) ----
  function lgNewRead() {
    if (typeof AbortController !== 'function') return null;
    var ac = new AbortController();
    lgReads.push(ac);
    return ac;
  }
  function lgDropRead(ac) { var i = lgReads.indexOf(ac); if (i !== -1) lgReads.splice(i, 1); }
  function lgAbortReads() {
    var a = lgReads; lgReads = [];
    a.forEach(function (ac) { try { ac.abort(); } catch (e) { /* already settled */ } });
  }

  // ---- container: popover (role=dialog) or confirm/posting (role=alertdialog, aria-modal, trapped) ----
  function lgBuildContainer(modal) {
    var p = document.createElement('div');
    p.id = PANEL_ID;
    p.tabIndex = -1;
    p.setAttribute('role', modal ? 'alertdialog' : 'dialog');
    p.setAttribute('aria-labelledby', 'bwn-lg-title');
    if (modal) { p.setAttribute('aria-modal', 'true'); p.setAttribute('aria-describedby', 'bwn-lg-desc'); }
    p.setAttribute('data-bwn-lg-kind', modal ? 'modal' : 'popover');
    p.appendChild(lgEl('div', 'bwn-lg-body'));
    // ONE persistent polite live region per container, OUTSIDE the re-rendered body.
    p.appendChild(lgEl('div', 'bwn-lg-sr bwn-lg-live', null, { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }));
    if (modal) p.addEventListener('keydown', lgTrapTab);
    return p;
  }
  // Script-local Tab/Shift+Tab wrap for the alertdialog (deliberately NOT the suite's shared focus-trap helper -
  // that one is a pinned byte-identical family; this panel swaps nodes instead of closing one).
  function lgTrapTab(e) {
    if (e.key !== 'Tab') return;
    var p = e.currentTarget;
    var f = [].filter.call(p.querySelectorAll('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])'), function (el) {
      return !el.disabled && el.getClientRects().length > 0;
    });
    var a = document.activeElement;
    if (!f.length) { e.preventDefault(); p.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (a === first || a === p)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }
  function lgFocusFirst(p) {
    var f = [].filter.call(p.querySelectorAll('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])'), function (el) {
      return !el.disabled && el.getClientRects().length > 0;
    });
    (f[0] || p).focus();
  }
  // Focus containment for the modal views: installed only while confirm/posting is shown (render
  // adds/removes it on every swap; lgClose removes it), and it removes itself if the panel is gone.
  function lgOnFocusIn(e) {
    var p = lgPanel();
    if (!p || !MODAL_VIEWS[ctl.phase()]) { document.removeEventListener('focusin', lgOnFocusIn, true); return; }
    if (p.contains(e.target)) return;
    lgFocusFirst(p);
  }
  // Swap a FRESH node in when the view needs the other container kind; otherwise reuse the live one.
  function lgContainerFor(view) {
    var p = lgPanel();
    if (!p) return null;
    var modal = !!MODAL_VIEWS[view];
    if ((p.getAttribute('data-bwn-lg-kind') === 'modal') === modal) return p;
    var n = lgBuildContainer(modal);
    n.style.top = p.style.top; n.style.left = p.style.left; n.style.maxHeight = p.style.maxHeight;
    p.parentNode.replaceChild(n, p);
    return n;
  }

  var lgAnnounceT = null;
  function lgAnnounce(msg) {
    var p = lgPanel(), live = p && p.querySelector('.bwn-lg-live');
    if (!live) return;
    clearTimeout(lgAnnounceT);
    live.textContent = '';
    // Deferred so a region inserted with a fresh container is in the a11y tree before it changes.
    lgAnnounceT = setTimeout(function () { if (live.isConnected) live.textContent = msg; }, 60);
  }

  function lgReposition() {
    var p = lgPanel(), b = document.getElementById(BTN_ID);
    if (!p) return;
    var vw = window.innerWidth, vh = window.innerHeight, top = 8, left = 8;
    if (b && b.isConnected) {
      var r = b.getBoundingClientRect();
      top = Math.round(r.bottom + 6); left = Math.round(r.left);
    } else if (p.style.top) return;   // launcher gone mid-re-render: keep the last position
    var w = p.offsetWidth || 340;
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, Math.min(top, vh - 120));
    p.style.top = top + 'px';
    p.style.left = left + 'px';
    p.style.maxHeight = Math.max(120, vh - top - 8) + 'px';
  }

  function lgSyncLauncher(btn) {
    var b = btn || document.getElementById(BTN_ID);
    if (!b) return;
    b.setAttribute('aria-expanded', lgPanel() ? 'true' : 'false');
    b.title = ctl.isPosting()
      ? 'Low GP notes are posting - open to see progress'
      : 'Add a Billing "Low GP" note to a work order and @-mention its assignee';
  }

  // ---- open / close / global listeners ----
  function lgOnDoc(e) {
    var p = lgPanel(), b = document.getElementById(BTN_ID);
    if (!p || p.contains(e.target) || (b && b.contains(e.target))) return;
    if (MODAL_VIEWS[ctl.phase()]) return;   // confirm + posting: only Cancel / Escape leave confirm
    lgClose(false);                         // outside click: close, do not force focus
  }
  function lgOnKey(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    var p = lgPanel(), lb = document.getElementById(BTN_ID);
    if (!p) return;
    var inside = p.contains(e.target);
    // In a modal view an Escape whose target is the bare document (focus fell to blank host space)
    // is still ours; any other Escape aimed at the host page is not.
    var bare = e.target === document.body || e.target === document.documentElement;
    if (!inside && !(lb && lb.contains(e.target)) && !(bare && MODAL_VIEWS[ctl.phase()])) return;
    e.preventDefault();
    e.stopPropagation();
    if (ctl.isPosting()) return;            // never close mid-post
    if (ctl.phase() === 'confirm') { lgCancelConfirm(); return; }   // Escape = Cancel, no write
    lgClose(true);
  }
  function lgListen() {
    document.addEventListener('mousedown', lgOnDoc, true);
    document.addEventListener('keydown', lgOnKey, true);
    window.addEventListener('scroll', lgReposition, true);
    window.addEventListener('resize', lgReposition, true);
  }
  function lgUnlisten() {
    document.removeEventListener('mousedown', lgOnDoc, true);
    document.removeEventListener('keydown', lgOnKey, true);
    window.removeEventListener('scroll', lgReposition, true);
    window.removeEventListener('resize', lgReposition, true);
  }
  function lgOpen() {
    if (lgPanel()) return;
    lgEnsureStyle();
    var o = ctl.open();                     // resumes a held (posting / posted) session, else fresh
    if (!o.resume) st = lgFreshState('');
    document.body.appendChild(lgBuildContainer(!!MODAL_VIEWS[ctl.phase()]));
    lgListen();
    render();
  }
  function lgClose(returnFocus) {
    if (!ctl.close()) return false;         // refused while posting
    lgAbortReads();
    var p = lgPanel();
    if (p) p.remove();
    lgUnlisten();
    document.removeEventListener('focusin', lgOnFocusIn, true);
    lgSyncLauncher();
    if (returnFocus) { var b = document.getElementById(BTN_ID); if (b && b.isConnected) b.focus(); }
    return true;
  }
  // Fresh session inside the open panel ("Add another" / Back after a refused post).
  function lgRestart(keepQuery) {
    if (ctl.isPosting()) return;
    var q = keepQuery ? st.query : '';
    ctl.close(); ctl.open();
    st = lgFreshState(q);
    render();
  }
  function lgGo(view) {
    lgAbortReads();
    var tok = ctl.go(view);
    if (!tok) return null;
    render();
    return tok;
  }

  // ---- views: each renders into the body and returns the element to focus ----
  function render() {
    lgSyncLauncher();
    var view = ctl.phase();
    var p = lgContainerFor(view);
    if (!p) return;                         // panel gone: the launcher re-shows this session on reopen
    var b = p.querySelector('.bwn-lg-body');
    while (b.firstChild) b.removeChild(b.firstChild);
    if (MODAL_VIEWS[view]) document.addEventListener('focusin', lgOnFocusIn, true);
    else document.removeEventListener('focusin', lgOnFocusIn, true);
    var fn = LG_VIEWS[view] || lgViewInput;
    var focusEl = fn(b, p);
    lgReposition();
    // A modal view (confirm / posting) always takes focus - opening a modal is not focus theft.
    // A non-modal view moves focus only if it is already ours (panel / launcher) or nowhere; one that
    // lands late (e.g. a terminal outcome) never steals focus from the host - its live region speaks.
    var a = document.activeElement, lb = document.getElementById(BTN_ID);
    var ours = !a || a === document.body || p.contains(a) || (lb && lb.contains(a));
    if ((MODAL_VIEWS[view] || ours) && focusEl && focusEl.focus) focusEl.focus();
  }

  function lgSetInvalid(inp, err, on) {
    err.hidden = !on;
    if (on) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', 'bwn-lg-hint bwn-lg-qerr'); }
    else { inp.removeAttribute('aria-invalid'); inp.setAttribute('aria-describedby', 'bwn-lg-hint'); }
  }
  function lgViewInput(b) {
    lgTitle(b, 'Low GP note');
    b.appendChild(lgEl('label', 'bwn-lg-label', 'Work order', { 'for': 'bwn-lg-q' }));
    var inp = lgEl('input', 'bwn-lg-input', null, { id: 'bwn-lg-q', type: 'text', autocomplete: 'off', spellcheck: 'false' });
    inp.value = st.query;
    b.appendChild(inp);
    b.appendChild(lgEl('p', 'bwn-lg-hint', 'WO#, Tracking#, Source PO#, or Source Job#. Press Enter to search.', { id: 'bwn-lg-hint' }));
    var err = lgEl('p', 'bwn-lg-hint bwn-lg-err', 'Enter a WO#, Tracking#, Source PO#, or Source Job# to search.', { id: 'bwn-lg-qerr' });
    b.appendChild(err);
    lgSetInvalid(inp, err, st.invalid);
    b.appendChild(lgBtn('Find work order', 'primary', lgDoFind));
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); lgDoFind(); } });
    inp.addEventListener('input', function () { if (st.invalid && inp.value.trim()) { st.invalid = false; lgSetInvalid(inp, err, false); } });
    return inp;
  }
  function lgFillLoading(m) {
    m.textContent = (st.lookupPhase === 'expanded')
      ? 'Expanded search running - this can take up to 30 seconds. Searching for "' + st.query + '"…'
      : 'Searching for "' + st.query + '"…';
  }
  function lgViewLoading(b, p) {
    lgTitle(b, 'Low GP note');
    var m = lgEl('p', 'bwn-lg-p', null, { id: 'bwn-lg-loadmsg' });
    lgFillLoading(m);
    b.appendChild(m);
    lgAnnounce('Searching for the work order.');
    if (!st.canStop) return p;
    var stop = lgBtn('Stop waiting', 'ghost', lgStopSearch);
    b.appendChild(stop);
    return stop;
  }
  function lgViewResults(b) {
    lgTitle(b, 'Low GP note');
    if (!st.rows.length) {
      b.appendChild(lgEl('p', 'bwn-lg-p', 'No work order found for "' + st.query + '".'));
      var back0 = lgBtn('Back', 'ghost', lgBackToInput);
      b.appendChild(back0);
      lgAnnounce('No work order found.');
      return back0;
    }
    var n = st.rows.length, first = null;
    b.appendChild(lgEl('p', 'bwn-lg-p bwn-lg-muted', n + ' match' + (n === 1 ? '' : 'es') + ' for "' + st.query + '" - pick one:', { id: 'bwn-lg-rhint' }));
    var list = lgEl('ul', 'bwn-lg-list', null, { 'aria-labelledby': 'bwn-lg-rhint' });
    st.rows.forEach(function (r, i) {
      var btn = lgEl('button', 'bwn-lg-btn bwn-lg-pick', null, { type: 'button' });
      btn.appendChild(lgEl('span', 'bwn-lg-wo', 'WO #' + r.number));
      var sub = [r.client, r.location, r.status].filter(Boolean).join(' · ');
      if (sub) btn.appendChild(lgEl('span', 'bwn-lg-sub', sub));
      btn.appendChild(lgEl('span', 'bwn-lg-sub bwn-lg-muted', r.hasAssignee ? ('Assignee: ' + (r.assigneeName || 'assignee')) : 'No assignee'));
      btn.addEventListener('click', function () { lgPick(i); });
      var li = lgEl('li');
      li.appendChild(btn);
      list.appendChild(li);
      if (!first) first = btn;
    });
    b.appendChild(list);
    b.appendChild(lgBtn('Back', 'ghost', lgBackToInput));
    lgAnnounce(n + ' match' + (n === 1 ? '' : 'es') + ' found.');
    return first;
  }

  var LG_SKIP_WHY = {
    'no-assignee': 'this WO has no assignee with a user ID, so nobody can be @-mentioned.'
  };
  function lgViewConfirm(b) {
    var r = st.row, gate = lgNote2Gate(r), label = r.assigneeName || 'assignee';
    st.total = gate.send ? 2 : 1;
    lgTitle(b, 'Confirm Low GP note');
    var desc = lgEl('div', null, null, { id: 'bwn-lg-desc' });
    var dl = lgEl('dl', 'bwn-lg-dl');
    lgDt(dl, 'Work order', 'WO #' + r.number);
    lgDt(dl, 'Client', r.client || 'Not listed');
    lgDt(dl, 'Location', r.location || 'Not listed');
    if (r.status) lgDt(dl, 'Status', r.status);
    if (r.tracking) lgDt(dl, 'Tracking #', r.tracking);
    lgDt(dl, 'Assignee', r.hasAssignee ? label : 'None');
    desc.appendChild(dl);
    // Order: what posts (note 1, then note 2 or why it is skipped), then the consequence box directly
    // above the buttons it describes.
    desc.appendChild(lgEl('p', 'bwn-lg-p', 'Note 1 - Billing: "' + NOTE1_CONTENT + '"'));
    if (gate.send) desc.appendChild(lgEl('p', 'bwn-lg-p', 'Note 2 - Internal: "' + lgPingContent(label, PING_MESSAGE) + '" (@-mentions ' + label + ')'));
    else desc.appendChild(lgBox('warn', '⚠', 'Warning:', 'Note 2 will be skipped - ' + LG_SKIP_WHY[gate.reason] + ' Nobody will be notified.'));
    desc.appendChild(lgBox('warn', '⚠', "Can't be undone:", gate.send
      ? 'Posts 2 notes to WO #' + r.number + ". Notes can't be unposted; the @-mention notification can't be recalled."
      : 'Posts 1 note to WO #' + r.number + ". Notes can't be unposted."));
    b.appendChild(desc);
    var actions = lgEl('div', 'bwn-lg-actions');
    var cancel = lgBtn('Cancel', 'ghost', function (e) { if (e && e.detail > 1) return; lgCancelConfirm(); });
    var apply = lgBtn(gate.send ? 'Post 2 notes' : 'Post 1 note', 'primary', lgDoApply);
    apply.id = 'bwn-lg-apply';
    // Arm ONLY on an activation that starts on this button after this view rendered (ctl.go reset it).
    apply.addEventListener('pointerdown', function (e) { if (e.button === 0) ctl.arm(); });
    apply.addEventListener('mousedown', function (e) { if (e.button === 0) ctl.arm(); });
    apply.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') ctl.arm(); });
    actions.appendChild(cancel);
    actions.appendChild(apply);
    b.appendChild(actions);
    // The duplicate answer lands BELOW the button row: whatever height it grows to, Cancel / Post
    // never move under the pointer (the R3 guarantee), and no space is reserved while it is pending.
    var dup = lgEl('p', 'bwn-lg-p bwn-lg-muted bwn-lg-dup', 'Checking for an existing Low GP note…', { id: 'bwn-lg-dup' });
    b.appendChild(dup);
    lgStartDupCheck(dup, r.number);
    lgAnnounce('Review before posting. Nothing has been posted yet.');
    return cancel;                          // focus lands on Cancel, never on Confirm
  }
  function lgFillDup(el, res) {
    while (el.firstChild) el.removeChild(el.firstChild);
    if (res.status === 'found') {
      var when = lgFmtNoteDate(res.note && res.note.createdDate);
      var t = 'This WO already has a Billing "Low GP" note' + (when ? ' (posted ' + when + ')' : '') + '. Confirming adds another one.';
      el.className = 'bwn-lg-box bwn-lg-warn bwn-lg-dup';
      el.appendChild(lgEl('span', null, '⚠ ', { 'aria-hidden': 'true' }));
      el.appendChild(lgEl('strong', null, 'Warning: '));
      el.appendChild(document.createTextNode(t));
      lgAnnounce('Warning: ' + t);
    } else if (res.status === 'none') {
      el.className = 'bwn-lg-p bwn-lg-muted bwn-lg-dup';
      el.textContent = 'No existing Low GP note found on this WO.';
    } else {
      el.className = 'bwn-lg-box bwn-lg-warn bwn-lg-dup';
      el.appendChild(lgEl('span', null, '⚠ ', { 'aria-hidden': 'true' }));
      el.appendChild(lgEl('strong', null, 'Warning: '));
      el.appendChild(document.createTextNode("Couldn't check for an existing Low GP note. You can still post."));
      lgAnnounce("Couldn't check for an existing Low GP note.");
    }
  }
  // Warn-only: never blocks Confirm, never steals focus, and a stale answer never lands.
  function lgStartDupCheck(el, woNumber) {
    var tok = ctl.token();
    var billingId = lgTypeId(BILLING_TYPE_NAME, lgCacheRaw());
    var ac = lgNewRead();
    lgFetchNotes(woNumber, ac && ac.signal).then(
      function (notes) { return lgFindDupLowGp(notes, billingId); },
      function () { return { status: 'unknown', note: null }; }
    ).then(function (res) {
      lgDropRead(ac);
      if (!ctl.isCurrent(tok) || !el.isConnected) return;
      lgFillDup(el, res);
    });
  }
  function lgFillPosting(m) { m.textContent = 'Posting note ' + st.step + ' of ' + st.total + ' to WO #' + st.row.number + '…'; }
  function lgViewPosting(b, p) {
    lgTitle(b, 'Posting Low GP note');
    var m = lgEl('p', 'bwn-lg-p', null, { id: 'bwn-lg-desc' });
    lgFillPosting(m);
    b.appendChild(m);
    b.appendChild(lgEl('p', 'bwn-lg-p bwn-lg-muted', 'This panel stays open until posting finishes.'));
    lgAnnounce('Posting note ' + st.step + ' of ' + st.total + '.');
    return p;
  }
  var LG_SKIP_DONE = {
    'no-assignee': 'No mention posted - this WO has no assignee with a user ID, so nobody was notified.'
  };
  function lgViewDone(b) {
    var res = st.result, r = st.row, said = [];
    lgTitle(b, 'Low GP note posted');
    var box = lgEl('div', null, null, { tabindex: '-1' });
    var s1 = 'Billing "Low GP" note posted to WO #' + r.number + '.';
    box.appendChild(lgBox('ok', '✓', 'Done:', s1)); said.push(s1);
    if (res.note2) {
      var s2 = 'Mention posted to ' + (r.assigneeName || 'the assignee') + '.';
      box.appendChild(lgBox('ok', '✓', 'Done:', s2)); said.push(s2);
    } else if (res.note2skipped) {
      var s3 = LG_SKIP_DONE[res.note2skipReason] || 'No mention posted. Nobody was notified.';
      box.appendChild(lgBox('warn', '⚠', 'Warning:', s3)); said.push('Warning: ' + s3);
    } else if (res.note2error) {
      var a = lgBox('bad', '⚠', 'Error:', 'The @-mention was not posted (' + res.note2error + '). The Billing note above stays posted; nobody was notified.');
      a.setAttribute('role', 'alert');
      box.appendChild(a);
    }
    b.appendChild(box);
    var actions = lgEl('div', 'bwn-lg-actions');
    actions.appendChild(lgBtn('Add another', 'ghost', function () { lgRestart(false); }));
    actions.appendChild(lgBtn('Close', 'primary', function () { lgClose(true); }));
    b.appendChild(actions);
    if (!res.note2error) lgAnnounce(said.join(' '));   // the mixed outcome speaks through role=alert
    return box;
  }
  function lgViewError(b) {
    var e = st.error || { kind: 'lookup', title: 'Something went wrong', text: '', detail: '', actions: ['close'] };
    lgTitle(b, e.title);
    var a = e.kind === 'uncertain' ? lgBox('warn', '⚠', 'Warning:', e.text) : lgBox('bad', '⚠', 'Error:', e.text);
    a.setAttribute('role', 'alert');
    a.setAttribute('tabindex', '-1');
    if (e.detail) a.appendChild(lgEl('span', 'bwn-lg-sub', e.detail));
    b.appendChild(a);
    var actions = lgEl('div', 'bwn-lg-actions');
    if (e.actions.indexOf('back') !== -1) {
      actions.appendChild(lgBtn('Back', 'ghost', e.kind === 'lookup' ? lgBackToInput : function () { lgRestart(true); }));
    }
    actions.appendChild(lgBtn('Close', 'ghost', function () { lgClose(true); }));
    b.appendChild(actions);
    return a;
  }
  var LG_VIEWS = { input: lgViewInput, loading: lgViewLoading, results: lgViewResults, confirm: lgViewConfirm,
    posting: lgViewPosting, done: lgViewDone, error: lgViewError };

  // ---- actions ----
  function lgBackToInput() { lgGo('input'); }
  function lgPick(i) {
    if (ctl.phase() !== 'results' || !st.rows[i]) return;
    st.row = st.rows[i];
    lgGo('confirm');
  }
  function lgCancelConfirm() {
    if (ctl.phase() !== 'confirm') return;
    lgGo(st.rows.length > 1 ? 'results' : 'input');
  }
  function lgStopSearch() {
    if (ctl.phase() !== 'loading') return;
    if (lgGo('input')) lgAnnounce('Search stopped.');   // lgGo aborts the read; the query is kept
  }
  function lgDoFind() {
    if (ctl.phase() !== 'input') return;
    var inp = document.getElementById('bwn-lg-q');
    var q = inp ? inp.value.trim() : '';
    if (!q) {
      st.invalid = true;
      var err = document.getElementById('bwn-lg-qerr');
      if (inp && err) { lgSetInvalid(inp, err, true); inp.focus(); }
      lgAnnounce('Enter a WO#, Tracking#, Source PO#, or Source Job# to search.');
      return;
    }
    st.query = q; st.invalid = false; st.rows = []; st.row = null; st.lookupPhase = 'fast';
    st.canStop = typeof AbortController === 'function';
    var tok = lgGo('loading');
    if (!tok) return;
    var ac = lgNewRead();
    lgSearch(q, {
      signal: ac && ac.signal,
      onPhase: function (ph) {
        if (!ctl.isCurrent(tok)) return;
        st.lookupPhase = ph;
        var m = document.getElementById('bwn-lg-loadmsg');
        if (m) lgFillLoading(m);
        lgAnnounce('Expanded search running - this can take up to 30 seconds.');
      }
    }).then(function (rows) {
      lgDropRead(ac);
      if (!ctl.isCurrent(tok)) return;
      st.rows = rows;
      if (rows.length === 1) { st.row = rows[0]; lgGo('confirm'); } else lgGo('results');
    }, function (err) {
      lgDropRead(ac);
      if (!ctl.isCurrent(tok)) return;
      if (lgIsAbort(err)) { lgGo('input'); return; }
      st.error = { kind: 'lookup', title: 'Search failed', text: "The work order search didn't finish.",
        detail: (err && err.message) || String(err), actions: ['back', 'close'] };
      lgGo('error');
    });
  }
  function lgDoApply(e) {
    if (ctl.isPosting()) return;            // posting lock: every further activation is ignored
    if (!ctl.canConfirm({ detail: e ? e.detail : 0 })) { ctl.disarm(); return; }
    var tok = ctl.beginPosting();           // lock taken synchronously, before any write
    if (!tok) return;
    // The lock above is the guard; render() below replaces the confirm view (and its button) at once.
    lgAbortReads();                         // the duplicate read is moot now
    var row = st.row, tenant = lgTenant();
    st.step = 1; st.total = lgNote2Gate(row).send ? 2 : 1; st.result = null; st.error = null;
    render();
    lgApply(row, tenant, function (n) {
      if (!ctl.isCurrent(tok)) return;
      st.step = n;
      var m = document.getElementById('bwn-lg-desc');
      if (m) lgFillPosting(m);
      lgAnnounce('Posting note ' + n + ' of ' + st.total + '.');
    }).then(function (result) {
      if (!ctl.finish(tok, 'done')) return;
      st.result = result;
      render();
    }, function (err) {
      if (!ctl.finish(tok, 'error')) return;
      st.error = lgPostErrorView(err, row.number);
      render();
    });
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
    lgEnsureStyle();
    var b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = 'Low GP';
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-controls', PANEL_ID);
    lgSyncLauncher(b);                      // a re-mounted launcher reflects the live panel / posting state
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var p = lgPanel();
      if (!p) { lgOpen(); return; }
      if (MODAL_VIEWS[ctl.phase()]) { lgFocusFirst(p); return; }   // confirm / posting: never close, just show it
      lgClose(false);                         // focus stays on the launcher that was clicked
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
    // Umbrava permission gate: this button's whole job is posting a Billing note. Returns TRUE so
    // the caller stops polling for a mount that is never coming. bwnCan fails OPEN while the
    // decode is unknown, so nothing changes for a user Core has not decoded yet.
    if (!bwnCan('WorkOrderNote.AddNew')) return true;
    // ESC-rank visibility floor (fail-closed): manager+ only. An unresolved rank keeps polling
    // (button stays hidden until the rank proves >= floor); a known below-floor rank hides for good.
    var lgGate = lgRankGate(lgRank());
    if (lgGate === 'wait') return false;
    if (lgGate === 'hide') return true;
    var existing = document.getElementById(BTN_ID);
    // Already mounted: re-sync aria-expanded / title so a panel the host removed reads as collapsed.
    // Same return value as before - the gates above and the poll cadence are unchanged.
    if (existing && existing.isConnected) { lgSyncLauncher(existing); return true; }
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
  // RM route helper adoption (phased follow-on to RM-B4). Route-change re-mount is the piece that
  // centralizes: when BWN_MODULES.routeHelper is ON and Core published window.bwnOnRoute (both are
  // @grant none, same page window - the same bridge kanban uses for window.__bwnHeatRows), subscribe
  // to Core's ONE history patch instead of our own per-mutation body observer, and keep a steady
  // low-rate poll as the re-render recovery net (React can drop the button mid-route, which route
  // detection does not cover; a fixed-interval mount() is cheaper and starvation-proof vs a
  // clear-and-reset observer debounce on a busy SPA - see wiki/observer-debounce-starves.md). Flag
  // OFF, or Core absent/disabled/throwing, => the legacy RM-B5 body observer installs, byte-for-byte
  // the old behavior (fail-safe: an unresolved flag or a missing helper both take the legacy path,
  // never a silent half-migration).
  function lowgpRouteHooks(onChange) {
    if (BWN_MODULES.routeHelper === true && typeof window.bwnOnRoute === 'function') {
      try {
        window.bwnOnRoute(onChange);
        // ponytail: permanent 500ms poll as the re-render recovery net the dropped observer used to
        // give (mount() is idempotent via its isConnected guard, so no double-inject). Matches the
        // consumer's existing 500ms mount cadence; tighten only if a wipe ever needs faster recovery.
        setInterval(mount, 500);
        return;
      } catch (e) { /* fall through to legacy */ }
    }
    // Trailing debounce (RM-B5): coalesce the SPA re-render bursts instead of firing on every mutation.
    var obsT = null;
    var obs = new MutationObserver(function () { clearTimeout(obsT); obsT = setTimeout(onChange, 300); });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  lowgpRouteHooks(schedule);
  schedule();
})();
