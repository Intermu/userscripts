// ==UserScript==
// @name         BWN Proposal Actions (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.5.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-actions.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-actions.user.js
// @description  On a Client Proposal DETAILS page, a "Proposal Actions" dropdown runs the internal review workflow in one confirmed action: Approval / TSP Review / Kickback. Each posts a note to the Proposal + the Work Order, sets the WO status, completes open tasks, and files a new task (assigned to the WO coordinator, or Ronny Sharp for TSP). Kickback drafts a rejection reason with the on-device browser AI for the operator to confirm. Every write is shown in a confirm dialog first; nothing fires until Confirm. @grant none.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.5.0';   // keep in step with @version
  var DRY_RUN = false; // when true, every WRITE is console.logged instead of sent
  console.info('[BWN PROPOSAL ACTIONS] v' + VER + ' - Approval / TSP Review / Kickback workflow on the Client Proposal details page');

  // ===== constants ==========================================================
  var RONNY_GUID = 'ff655968-a371-43b9-a199-e66847a54a2a';   // Ronny Sharp - the Trade Specialist assignee for the TSP action
  var NOTE_TYPE_INTERNAL = 13;                               // Umbrava note-type id "Internal" (bwn:noteTypes cache; pinned in umbrava-graphql-operations)
  var STATUS_FALLBACK = {                                     // resolved live from workOrderStatuses; these are the confirmed ids for this tenant
    'Internal Proposal Approved': 51,
    'Pending Trade Specialist': 232,
    'Internal Proposal Rejected': 52
  };
  var MIN_RANK = 4;   // same manager gate as bwn-proposal-copy

  // ===== auth + gql (copied from bwn-proposal-copy) =========================
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
  function paGql(op, query, variables) {
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

  // ===== role gate (copied from bwn-proposal-copy) ==========================
  var ROLE_TTL_MS = 6 * 3600 * 1000;
  var _liveRank = null;
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _liveRank = d.rank;
    });
  } catch (e) { }
  function rank() {
    if (typeof _liveRank === 'number') return _liveRank;
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank;
    } catch (e2) { }
    return null;
  }
  function gated() { return typeof rank() === 'number' && rank() >= MIN_RANK; }

  // ===== url + format helpers ===============================================
  function woNumberFromUrl() {
    var m = String(location.pathname || '').match(/\/work-orders\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  function proposalIdFromUrl() {
    var m = String(location.pathname || '').match(/\/client-proposals\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  function onProposalDetailsPage() {
    return /\/work-orders\/\d+\/proposals\/client-proposals\/\d+\/details/.test(location.pathname || '');
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(m) {
    if (!m || m.amount == null) return '$0.00';
    var p = (m.precision != null) ? m.precision : 2;
    var v = Number(m.amount) / Math.pow(10, p);
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // ===== PA-GPLABEL START (sliced by scripts/test-proposal-actions.js) =====
  // Rule (per Mike 2026-08-17): negative GP -> "Negative GP"; below 33% -> "Low GP"; 33%+ -> "Good GP".
  // gpPct is a FRACTION parsed from the API's string (0.4107 = 41.07%, -0.41 = -41%), so the 33%
  // threshold is 0.33. A null / unreadable GP returns "GP unknown" so a failed read is VISIBLE in the
  // posted note rather than silently mislabeled as Low GP (the old rule defaulted everything non-negative
  // to "Low GP", which mislabeled a 41% proposal).
  var GP_GOOD_THRESHOLD = 0.33;   // 33%, expressed as a fraction to match the API GP
  function gpLabel(gpPct) {
    if (typeof gpPct !== 'number' || isNaN(gpPct)) return 'GP unknown';
    if (gpPct < 0) return 'Negative GP';
    return gpPct < GP_GOOD_THRESHOLD ? 'Low GP' : 'Good GP';
  }
  // ===== PA-GPLABEL END =====
  function textToHtml(t) {
    return String(t == null ? '' : t).split('\n').map(function (ln) {
      return '<p>' + (ln === '' ? '<br>' : escapeHtml(ln)) + '</p>';
    }).join('');
  }
  function firstLine(t) {
    var s = String(t == null ? '' : t).split('\n')[0] || '';
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  }

  // ===== note templates =====================================================
  // Exact shape from Mike's examples:  <lead> - <GP> - Summary \n Total \n <$total>
  function approvalNote(gp, total) { return 'Good to submit - ' + gp + ' - Summary\nTotal\n' + total; }
  function tspNote(gp, total) { return 'TSP Review - ' + gp + ' - Summary\nTotal\n' + total; }
  function kickbackNote(reason, total) { return String(reason || '').trim() + '\n\nSummary\nTotal\n' + total; }

  // ===== reads ==============================================================
  var Q_WO = 'query PA_WO($n: Int!){ workOrder(workOrderNumber: $n){ id assignedTo statusName } }';
  function readWO(n) {
    return paGql('PA_WO', Q_WO, { n: n }).then(function (d) {
      var w = d && d.workOrder;
      if (!w) throw new Error('work order ' + n + ' not found');
      return { jobId: w.id, coordinator: w.assignedTo, statusName: w.statusName };
    });
  }

  var Q_PROP = 'query PA_Prop($p: Int!){ proposal(id: $p){ total { amount currency precision } grossProfitPercent } }';
  var Q_LIST = 'query PA_List($j: Int!){ listClientProposals(jobId: $j, page: { skip: 0, take: 50 }){ items { id total { amount currency precision } grossProfitPercent } } }';
  function toGpNumber(raw) {
    if (raw == null || raw === '') return null;
    var v = (typeof raw === 'number') ? raw : parseFloat(raw);
    return isNaN(v) ? null : v;
  }
  function readTotals(jobId, proposalId) {
    // Prefer the single-node read; fall back to the paged list (which the catalog guarantees
    // carries total + grossProfitPercent) if proposal(id:) does not expose them here.
    return paGql('PA_Prop', Q_PROP, { p: proposalId }).then(function (d) {
      var pr = d && d.proposal;
      if (pr && pr.total && pr.total.amount != null) {
        return { total: pr.total, gpPct: toGpNumber(pr.grossProfitPercent) };
      }
      throw new Error('proposal-node-missing-total');
    }).catch(function () {
      return paGql('PA_List', Q_LIST, { j: jobId }).then(function (d) {
        var items = (d && d.listClientProposals && d.listClientProposals.items) || [];
        var it = items.filter(function (x) { return x.id === proposalId; })[0] || items[0];
        if (!it || !it.total) throw new Error('could not read proposal total');
        return { total: it.total, gpPct: toGpNumber(it.grossProfitPercent) };
      });
    });
  }

  var Q_TASKS = 'query PA_Tasks($e: String!){ tasksByEntityTypeAndId(entityType: 1, entityId: $e, includeComplete: false){ tasks { id isComplete } } }';
  function readOpenTasks(n) {
    return paGql('PA_Tasks', Q_TASKS, { e: String(n) }).then(function (d) {
      var t = (d && d.tasksByEntityTypeAndId && d.tasksByEntityTypeAndId.tasks) || [];
      return t.filter(function (x) { return !x.isComplete; });
    });
  }

  // WO-notes read, for the idempotent WO-note step below. workOrderNotes is the REAL query (proven
  // live in bwn-write-queue; the vault records a fabricated `workOrderNotes` as a past bug, so this
  // reuses the confirmed one - it is not invented). Used to skip re-posting an identical WO note.
  var Q_WONOTES = 'query PA_WONotes($n: Int!){ workOrderNotes(workOrderNumber: $n){ content isDeleted } }';
  function readWONotes(n) {
    return paGql('PA_WONotes', Q_WONOTES, { n: n }).then(function (d) {
      return (d && d.workOrderNotes) || [];
    });
  }
  function woNoteExists(notes, text) {
    return (notes || []).some(function (x) {
      return x && !x.isDeleted && String(x.content == null ? '' : x.content) === text;
    });
  }

  // ===== PA-RESOLVE-SLICE-START (RM-A3: live-resolve status ids + the TSP assignee, FAIL-CLOSED;
  // sliced by scripts/test-pa-live-resolve.js; references injected paGql / STATUS_FALLBACK / RONNY_GUID) =====
  // R3/RM-A3: status ids and the TSP assignee used to come from hardcoded constants (STATUS_FALLBACK,
  // RONNY_GUID). If the tenant reconfigures a status id, or Ronny leaves / his user id changes, a
  // hardcoded value silently MISROUTES a live write (wrong status, task filed on a ghost user). Now
  // both resolve LIVE and FAIL CLOSED when they cannot - no write goes out on a stale id. The rollback
  // flag (bwn:modules.paLegacyFallback=true) reinstates the constants as a last resort, no reship.
  function paLegacyFallback() { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}').paLegacyFallback === true; } catch (e) { return false; } }

  var Q_STATUSES = 'query PA_Statuses{ workOrderStatuses { id name isActive } }';
  var _statusCache = null;
  // Resolve a status NAME to its live tenant id. Fail-closed: a name not present in the live
  // workOrderStatuses (or a failed read) yields null so setStatus ABORTS, rather than patching to a
  // stale hardcoded id. The rollback flag reinstates STATUS_FALLBACK.
  function readStatusId(name) {
    function pick(list) {
      var hit = (list || []).filter(function (s) { return s.name === name; })[0];
      if (hit) return hit.id;
      return paLegacyFallback() ? STATUS_FALLBACK[name] : null;   // fail-closed unless the rollback flag is on
    }
    if (_statusCache) return Promise.resolve(pick(_statusCache));
    return paGql('PA_Statuses', Q_STATUSES, {}).then(function (d) {
      _statusCache = (d && d.workOrderStatuses) || [];
      return pick(_statusCache);
    }).catch(function () { return paLegacyFallback() ? STATUS_FALLBACK[name] : null; });   // read failed: fail-closed
  }

  var Q_USER = 'query PA_User($id: ID!){ user(id: $id){ firstName lastName } }';
  function resolveUserName(guid) {
    if (!guid) return Promise.resolve('(unassigned)');
    return paGql('PA_User', Q_USER, { id: guid }).then(function (d) {
      var u = d && d.user;
      if (!u) return guid.slice(0, 8);
      return ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || guid.slice(0, 8);
    }).catch(function () { return guid.slice(0, 8); });
  }

  // The TSP (Trade Specialist) assignee. RONNY_GUID is only a SEED: verified LIVE against the proven
  // user(id:) read before any task is assigned to it. If the seed no longer resolves to a user named
  // TSP_ASSIGNEE_NAME (Ronny left, or his id changed), resolution FAILS CLOSED (returns null) so the
  // TSP action aborts rather than filing a task on a ghost id. The rollback flag reinstates the seed.
  var TSP_ASSIGNEE_NAME = 'Ronny Sharp';
  function resolveTspAssignee() {
    return paGql('PA_User', Q_USER, { id: RONNY_GUID }).then(function (d) {
      var u = d && d.user;
      var nm = u ? (((u.firstName || '') + ' ' + (u.lastName || '')).trim()) : '';
      if (u && nm.toLowerCase() === TSP_ASSIGNEE_NAME.toLowerCase()) return { guid: RONNY_GUID, name: nm };
      return paLegacyFallback() ? { guid: RONNY_GUID, name: TSP_ASSIGNEE_NAME } : null;   // seed stale -> fail-closed
    }).catch(function () { return paLegacyFallback() ? { guid: RONNY_GUID, name: TSP_ASSIGNEE_NAME } : null; });
  }
  // ===== PA-RESOLVE-SLICE-END =====

  // ===== PA-WRITES START (sliced by scripts/test-proposal-actions.js; references injected paGql / textToHtml / DRY_RUN / NOTE_TYPE_INTERNAL) =====
  // ===== writes: PROVEN =====================================================
  // ---- BWN-OPS: audited GraphQL wrapper for this sandbox --------------------
  // Routes proposal-actions writes through bwnGqlOp (paste-identical BWN-OPS-WRAP below, SHA-gated
  // to Core): correlation id + shared audit entry + the high-risk confirm gate. paGql is 3-arg;
  // this adapter gives the wrapper the uniform bwnGql(query,variables). proposal-actions confirms
  // every write in its own dialog, so patchWorkOrder (high) passes confirmed:true.
  function bwnGql(query, variables) { var m = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query); return paGql(m ? m[1] : null, query, variables); }
  var BWN_VER = VER;
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  var BWN_OPS = {
    patchWorkOrder: { kind: 'write', perm: bwnPermsForPatch, target: 'workOrder', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Work order updated.', fail: 'The work order was not updated.' },
    addEditJobNote: { kind: 'write', perm: 'WorkOrderNote.AddNew', target: 'note', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Note posted.', fail: 'The note was not posted.' },
    addClientProposalNote: { kind: 'write', perm: 'WorkOrderProposal.AddNote', target: 'proposal', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Proposal note posted.', fail: 'The proposal note was not posted.' },
    addTask: { kind: 'write', perm: 'Task.AddNew', target: 'task', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Task created.', fail: 'The task was not created.' },
    completeTask: { kind: 'write', perm: 'Task.Complete', target: 'task', risk: 'moderate', idempotent: true, retry: 'none',
      ok: 'Task completed.', fail: 'The task was not completed.' }
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

  var M_PATCH = 'mutation PatchWorkOrder($data: PatchWorkOrderInput!){ patchWorkOrder(data: $data){ success message } }';
  function setStatus(n, statusId) {
    // Fail-closed (RM-A3): a status write MUST carry a live-resolved numeric id. A null/NaN id means
    // readStatusId could not resolve the status name against the live workOrderStatuses (rollback flag
    // off), so REFUSE here rather than patch the WO to a null/stale status. This is the single write
    // chokepoint, so the guard covers every caller.
    if (statusId == null || !isFinite(Number(statusId))) {
      return Promise.reject(new Error('status id did not resolve to a live value - not writing (set bwn:modules.paLegacyFallback=true to use the built-in fallback ids)'));
    }
    var vars = { data: { workOrderNumber: n, statusId: { shouldInclude: true, value: statusId } } };
    if (DRY_RUN) { console.log('[PA DRY_RUN] setStatus', vars); return Promise.resolve(true); }
    // Routed through bwnGqlOp: audit + corrId + the high-risk confirm gate. proposal-actions
    // confirms every write in its own dialog, so this high-risk write passes confirmed:true.
    return bwnGqlOp('patchWorkOrder', M_PATCH, vars, {
      confirmed: true, ids: { wo: n }, after: { statusId: statusId }
    }).then(function () { return true; });
  }

  var M_WONOTE = 'mutation AddEditWONote($addEditInput: WorkOrderNoteInput!){ addEditJobNote(data: $addEditInput){ success message note { id type } } }';
  function addWONote(n, text) {
    var input = {
      workOrderNumber: n,
      type: NOTE_TYPE_INTERNAL,
      content: text,
      contentHtml: textToHtml(text),
      isCompletion: false,
      isInvoice: false,
      isPinned: false,
      actionNoteEmails: null,
      targetPurchaseOrderNumbers: []
    };
    if (DRY_RUN) { console.log('[PA DRY_RUN] addWONote', input); return Promise.resolve(true); }
    return bwnGqlOp('addEditJobNote', M_WONOTE, { addEditInput: input }, { ids: { wo: n } }).then(function () { return true; });
  }

  // ===== writes: PINNED 2026-08-17 ==========================================
  // These three were greenfield stubs (NOT_PINNED) until the mutations were pinned by read-only
  // introspection - full shapes in the Claude Brain vault [[umbrava-graphql-operations]] "Task +
  // entity-NOTE write mutations". Each takes a single `data` input object and returns the Umbrava
  // house-style `{ success message }` payload (same wrapper addEditJobNote / patchWorkOrder use
  // above); we select only those two always-present scalars and check `.success`, exactly like the
  // proven writes. Values are never invented: `type` numeric ids, proposal `entityId`, and the
  // entityType/entityId task convention all come from the pinned schema.

  // addProposalNote - a proposal Notes-tab note is a "billing note", NOT a WO note (addEditJobNote
  // is WO-only). Mutation: addClientProposalNote(data: AddBillingNoteInput!). entityId is the
  // proposal INTERNAL id, which is exactly what /client-proposals/<id> in the URL carries (the UI
  // "#537526" IS that id, not a per-WO sequence number - resolved 2026-08-17). Both text fields are
  // required (unlike WO notes, whose contentHtml is optional). noteTypeId is a DIFFERENT enum from
  // WO note types and is optional, so it is omitted and the server applies its default.
  var M_ADD_PROP_NOTE = 'mutation AddClientProposalNote($data: AddBillingNoteInput!){ addClientProposalNote(data: $data){ success message } }';
  function addProposalNote(proposalId, text) {
    if (DRY_RUN) { console.log('[PA DRY_RUN] addProposalNote', { proposalId: proposalId, text: text }); return Promise.resolve(true); }
    var input = { entityId: proposalId, plainTextContent: text, htmlContent: textToHtml(text) };
    return bwnGqlOp('addClientProposalNote', M_ADD_PROP_NOTE, { data: input }, { ids: { proposalId: proposalId } }).then(function () { return true; });
  }

  // createTask - addTask(data: AddTaskInput!). entityType 1 = work order, entityId = the WO number
  // as a String (the Task read's own convention). assignedTo is a USER GUID; a task assigned to the
  // coordinator. targetStartDate REQUIRED (full ISO, matching the SPA). `metadata` and `notifyCreator`
  // are OPTIONAL in the GraphQL schema but the backend REST service (taskrestapi/api/Task/AddTask)
  // 500s with an empty body when `metadata` is absent - so both are sent to MATCH the SPA's own
  // payload, captured off the wire 2026-08-17: metadata = the WO number as a JSON string
  // `{"number":"<wo>"}`. (Introspection said they were optional; the live REST backend disagreed -
  // same class as the addWorkOrder capture. Do not drop metadata again.)
  var M_ADD_TASK = 'mutation AddTask($data: AddTaskInput!){ addTask(data: $data){ success message } }';
  function createTask(woNumber, assigneeGuid, text) {
    if (DRY_RUN) { console.log('[PA DRY_RUN] createTask', { woNumber: woNumber, assigneeGuid: assigneeGuid, text: text }); return Promise.resolve(true); }
    var input = {
      entityId: String(woNumber),
      entityType: 1,
      description: text,
      targetStartDate: new Date().toISOString(),
      assignedTo: assigneeGuid || null,
      notifyCreator: false,
      metadata: JSON.stringify({ number: String(woNumber) })
    };
    return bwnGqlOp('addTask', M_ADD_TASK, { data: input }, { ids: { wo: woNumber } }).then(function () { return true; });
  }

  // completeTask - completeTask(data: CompleteTaskInput!). CompleteTaskInput is JUST { id: ID! }.
  var M_COMPLETE_TASK = 'mutation CompleteTask($data: CompleteTaskInput!){ completeTask(data: $data){ success message } }';
  function completeTask(taskId) {
    if (DRY_RUN) { console.log('[PA DRY_RUN] completeTask', { taskId: taskId }); return Promise.resolve(true); }
    return bwnGqlOp('completeTask', M_COMPLETE_TASK, { data: { id: taskId } }, { ids: { taskId: taskId } }).then(function () { return true; });
  }
  function completeAllTasks(tasks) {
    // Promise.all([]) resolves immediately, so a WO with zero open tasks succeeds trivially.
    return Promise.all((tasks || []).map(function (t) { return completeTask(t.id); })).then(function () { return true; });
  }
  // ===== PA-WRITES END ======================================================

  // ===== on-device browser AI (copied from bwn-drop-upload) =================
  function langModel() {
    var g = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : null);
    if (typeof LanguageModel !== 'undefined' && LanguageModel) return LanguageModel;
    if (g && g.LanguageModel) return g.LanguageModel;
    if (g && g.ai && g.ai.languageModel) return g.ai.languageModel;
    return null;
  }
  function aiReady(api) {
    try {
      if (typeof api.availability === 'function') return Promise.resolve(api.availability()).then(function (s) { return s === 'available'; }, function () { return false; });
      if (typeof api.capabilities === 'function') return Promise.resolve(api.capabilities()).then(function (c) { return !!c && c.available === 'readily'; }, function () { return false; });
    } catch (e) { }
    return Promise.resolve(false);
  }
  var _AI_SESSIONS = {};
  function aiSession(api, sys) {
    var cached = _AI_SESSIONS[sys];
    if (cached) return Promise.resolve(cached);
    function keep(hasSystem) { return function (s) { try { s._bwnSystem = hasSystem; } catch (e) { } _AI_SESSIONS[sys] = s; return s; }; }
    return Promise.resolve(api.create({ initialPrompts: [{ role: 'system', content: sys }], outputLanguage: 'en' }))
      .then(keep(true), function () { return Promise.resolve(api.create({ outputLanguage: 'en' })).then(keep(false)); });
  }
  function onDevice(sys, content) {
    var api = langModel();
    if (!api || typeof api.create !== 'function') return Promise.resolve('');
    return aiReady(api).then(function (ok) {
      if (!ok) return '';
      return aiSession(api, sys).then(function (s) {
        var usedSystem = !!(s && s._bwnSystem !== false);
        return s.prompt((usedSystem ? '' : sys + '\n\n') + content);
      });
    }).catch(function () { _AI_SESSIONS[sys] = null; return ''; });
  }
  function draftKickbackReason(ctx) {
    var sys = 'You are an internal operations reviewer at a facilities-management company reviewing a client proposal before it is sent to the client. In 1 to 3 short, plain sentences, state specifically why this proposal is being kicked back to the coordinator instead of approved (e.g. margin too low or negative, pricing/scope issues, missing detail). Professional and direct. No greeting, no sign-off, no bullet points.';
    var content = 'Scope of work:\n' + (ctx.scope || '(none)') +
      '\n\nClient total: ' + ctx.total +
      '\nGross profit: ' + ctx.gpText +
      '\nLine items:\n' + (ctx.items || '(none)');
    return onDevice(sys, content).then(function (t) { return (t || '').trim(); });
  }

  // Scope + line-item context for the AI (best-effort; reuses the proposal details read).
  var Q_PROP_CTX = 'query PA_PropCtx($p: Int!){ proposal(id: $p){ scopeOfWork proposalLineItems { item quantity category } } }';
  function readProposalContext(proposalId) {
    return paGql('PA_PropCtx', Q_PROP_CTX, { p: proposalId }).then(function (d) {
      var pr = d && d.proposal;
      var scope = (pr && pr.scopeOfWork) || '';
      var items = ((pr && pr.proposalLineItems) || []).map(function (li) {
        return '- ' + (li.item || 'item') + ' x' + (li.quantity == null ? '?' : li.quantity);
      }).join('\n');
      return { scope: scope, items: items };
    }).catch(function () { return { scope: '', items: '' }; });
  }

  // ===== styles =============================================================
  function ensureStyle() {
    if (document.getElementById('bwn-pa-style')) return;
    var st = document.createElement('style');
    st.id = 'bwn-pa-style';
    st.textContent =
      '.bwn-pa-trigger{display:inline-flex;align-items:center;gap:4px;margin:0 8px;padding:6px 12px;border:1px solid #1a5f3e;' +
      'border-radius:8px;background:#f0fdf4;color:#0d3d26;font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer;white-space:nowrap;}' +
      '.bwn-pa-trigger:hover{background:#dcfce7;}' +
      '.bwn-pa-menu{position:fixed;z-index:2147483000;min-width:200px;background:#fff;border:1px solid #d5e6dd;border-radius:10px;' +
      'box-shadow:0 12px 34px rgba(9,30,66,.22);padding:6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;}' +
      '.bwn-pa-menu button{display:block;width:100%;text-align:left;padding:9px 12px;border:0;background:transparent;border-radius:7px;' +
      'font:500 13px inherit;color:#12241b;cursor:pointer;}' +
      '.bwn-pa-menu button:hover{background:#f0fdf4;}' +
      '.bwn-pa-menu .sub{display:block;font-size:11px;color:#5b6b62;margin-top:1px;}' +
      '#bwn-pa-overlay{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(9,30,66,.45);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;}' +
      '#bwn-pa-card{width:520px;max-width:94vw;max-height:88vh;overflow:auto;background:#fff;border-radius:12px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;color:#12241b;}' +
      '#bwn-pa-card .hd{padding:14px 18px;border-radius:12px 12px 0 0;background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;}' +
      '#bwn-pa-card .hd .t{font:600 15px inherit;}' +
      '#bwn-pa-card .hd .s{font:400 12px inherit;opacity:.9;margin-top:2px;}' +
      '#bwn-pa-card .bd{padding:16px 18px;}' +
      '#bwn-pa-card .steps{list-style:none;margin:0 0 12px;padding:0;}' +
      '#bwn-pa-card .steps li{padding:7px 0;border-bottom:1px solid #eef3f0;font-size:13px;display:flex;gap:8px;align-items:flex-start;}' +
      '#bwn-pa-card .steps li .ic{flex:0 0 16px;text-align:center;}' +
      '#bwn-pa-card .pending{color:#8a6d3b;}' +
      '#bwn-pa-card .ok{color:#166534;}' +
      '#bwn-pa-card .err{color:#b42318;}' +
      '#bwn-pa-card .skip{color:#8a6d3b;}' +
      '#bwn-pa-card .notebox{white-space:pre-wrap;background:#f6faf8;border:1px solid #e3efe9;border-radius:8px;padding:10px 12px;font-size:12px;margin:0 0 12px;}' +
      '#bwn-pa-card textarea{width:100%;min-height:90px;box-sizing:border-box;border:1px solid #cddbd3;border-radius:8px;padding:9px 11px;font:inherit;font-size:13px;resize:vertical;}' +
      '#bwn-pa-card .ft{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid #eef3f0;}' +
      '#bwn-pa-card .btn{padding:8px 16px;border-radius:8px;border:1px solid #1a5f3e;font:600 13px inherit;cursor:pointer;}' +
      '#bwn-pa-card .btn.go{background:#1a5f3e;color:#fff;}' +
      '#bwn-pa-card .btn.cancel{background:#fff;color:#0d3d26;}' +
      '#bwn-pa-card .btn:disabled{opacity:.55;cursor:default;}';
    document.head.appendChild(st);
  }

  // ===== toast (copied pattern from bwn-proposal-copy) ======================
  function paToast(msg) {
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483002;' +
      'background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:8px;' +
      'font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:70vw;';
    el.textContent = 'BWN Proposal Actions: ' + msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }

  // ===== confirm modal ======================================================
  // plan = { title, subtitle, isKickback, aiReason, noteFn(reason)->text, steps:[{label,pending,run}] }
  // Each step.run() returns a Promise. A step whose run rejects with NOT_PINNED is SKIPPED
  // (shown "pending capture"); any other rejection STOPS the run and is reported.
  function openConfirm(plan) {
    // A step builder returns null when this operator's Umbrava permissions do not cover that write
    // (see the build*Step functions). Dropping them HERE keeps the three workflow definitions
    // readable and means the plan the operator confirms is exactly the plan that will run.
    if (plan && Array.isArray(plan.steps)) plan.steps = plan.steps.filter(Boolean);
    ensureStyle();
    var prior = document.getElementById('bwn-pa-overlay');
    if (prior) prior.remove();

    var overlay = document.createElement('div');
    overlay.id = 'bwn-pa-overlay';
    var card = document.createElement('div');
    card.id = 'bwn-pa-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    var reasonTa = null;
    var stepEls = [];
    var stepsHtml = plan.steps.map(function (s, i) {
      return '<li data-i="' + i + '" class="' + (s.pending ? 'pending' : '') + '">' +
        '<span class="ic">' + (s.pending ? '⚠' : '•') + '</span>' +
        '<span class="lb">' + escapeHtml(s.label) + (s.pending ? ' <em>(pending capture)</em>' : '') + '</span></li>';
    }).join('');

    card.innerHTML =
      '<div class="hd"><div class="t">' + escapeHtml(plan.title) + '</div>' +
      (plan.subtitle ? '<div class="s">' + escapeHtml(plan.subtitle) + '</div>' : '') + '</div>' +
      '<div class="bd">' +
      (plan.isKickback ? '<div style="font-size:12px;color:#5b6b62;margin:0 0 6px;">Kickback reason (editable) - drafted by the on-device AI:</div><textarea id="bwn-pa-reason"></textarea><div style="height:12px;"></div>' : '') +
      '<div style="font-size:12px;color:#5b6b62;margin:0 0 4px;">Note that will be posted:</div>' +
      '<div class="notebox" id="bwn-pa-notepreview"></div>' +
      '<div style="font-size:12px;color:#5b6b62;margin:0 0 4px;">This will:</div>' +
      '<ul class="steps">' + stepsHtml + '</ul>' +
      '</div>' +
      '<div class="ft"><button class="btn cancel" id="bwn-pa-cancel">Cancel</button>' +
      '<button class="btn go" id="bwn-pa-go">Confirm</button></div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    var cancelBtn = card.querySelector('#bwn-pa-cancel');
    var goBtn = card.querySelector('#bwn-pa-go');
    var notePreview = card.querySelector('#bwn-pa-notepreview');
    reasonTa = card.querySelector('#bwn-pa-reason');
    plan.steps.forEach(function (s, i) { stepEls[i] = card.querySelector('li[data-i="' + i + '"]'); });

    function currentReason() { return reasonTa ? reasonTa.value : ''; }
    function refreshPreview() { notePreview.textContent = plan.noteFn(currentReason()); }
    if (reasonTa) {
      reasonTa.value = plan.aiReason || '';
      reasonTa.addEventListener('input', refreshPreview);
    }
    refreshPreview();

    function close() { try { overlay.remove(); } catch (e) { } document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    cancelBtn.addEventListener('click', close);

    goBtn.addEventListener('click', function () {
      goBtn.disabled = true; cancelBtn.disabled = true;
      if (reasonTa) reasonTa.disabled = true;
      var reason = currentReason();
      if (plan.isKickback && !reason.trim()) {
        paToast('Enter a kickback reason first.');
        goBtn.disabled = false; cancelBtn.disabled = false; if (reasonTa) reasonTa.disabled = false;
        return;
      }
      runSteps(plan.steps, reason, stepEls).then(function (res) {
        if (res.ok) {
          goBtn.textContent = res.skipped ? 'Done (some pending)' : 'Done';
          paToast(res.skipped
            ? 'Proven steps done. ' + res.skipped + ' step(s) skipped - awaiting mutation capture.'
            : 'All steps complete.');
          setTimeout(close, res.skipped ? 4500 : 2200);
        } else {
          cancelBtn.disabled = false;
          goBtn.disabled = false; goBtn.textContent = 'Retry';
          paToast('Stopped at "' + res.failedLabel + '": ' + res.error);
        }
      });
    });
  }

  function mark(li, cls, icon, note) {
    if (!li) return;
    li.className = cls;
    var ic = li.querySelector('.ic'); if (ic) ic.textContent = icon;
    if (note) { var lb = li.querySelector('.lb'); if (lb) lb.innerHTML = lb.innerHTML.replace(/ <em>.*<\/em>/, '') + ' <em>' + escapeHtml(note) + '</em>'; }
  }

  // Sequential runner. reason is threaded so kickback step closures can read the confirmed text.
  function runSteps(steps, reason, stepEls) {
    var skipped = 0;
    // Resume from the first not-yet-completed step: a step already marked 'ok' (a checkmark from a
    // previous run) is not re-run, so a Retry after a mid-sequence failure does NOT re-post a note,
    // re-create the task, or re-set the status that already succeeded. First run: nothing is 'ok', so
    // idx stays 0 and behaviour is unchanged.
    var idx = 0;
    while (idx < steps.length && stepEls[idx] && stepEls[idx].className === 'ok') idx++;
    function next() {
      if (idx >= steps.length) return Promise.resolve({ ok: true, skipped: skipped });
      var s = steps[idx];
      var li = stepEls[idx];
      if (li) { var ic = li.querySelector('.ic'); if (ic) ic.textContent = '…'; }
      return Promise.resolve().then(function () { return s.run(reason); }).then(function () {
        mark(li, 'ok', '✓');
        idx++; return next();
      }, function (err) {
        var msg = (err && err.message) || String(err);
        if (/^NOT_PINNED/.test(msg)) {
          skipped++;
          mark(li, 'skip', '⚠', 'skipped - not yet captured');
          idx++; return next();
        }
        mark(li, 'err', '✗', msg);
        return { ok: false, failedLabel: s.label, error: msg };
      });
    }
    return next();
  }

  // ===== action orchestration ===============================================
  function gatherContext() {
    var n = woNumberFromUrl();
    var pid = proposalIdFromUrl();
    if (n == null || pid == null) return Promise.reject(new Error('not on a proposal details page'));
    return readWO(n).then(function (wo) {
      return readTotals(wo.jobId, pid).then(function (tot) {
        return readOpenTasks(n).then(function (openTasks) {
          return {
            n: n, pid: pid, wo: wo,
            total: money(tot.total), gpPct: tot.gpPct, gp: gpLabel(tot.gpPct),
            gpText: (tot.gpPct == null ? 'unknown' : (tot.gpPct * 100).toFixed(2) + '%'),
            openTasks: openTasks
          };
        });
      });
    });
  }

  function buildStatusStep(ctx, statusName) {
    return {
      label: 'Set WO status → ' + statusName, pending: false,
      run: function () {
        // Idempotent set (matches bwn-write-queue's set-verb skip): re-read the WO's current status
        // and skip the write when it is already at the target, so a Retry never resets the
        // time-in-status clock a second time.
        return readWO(ctx.n).then(function (cur) {
          if (cur && cur.statusName === statusName) return true;
          return readStatusId(statusName).then(function (id) { return setStatus(ctx.n, id); });
        });
      }
    };
  }
  function buildProposalNoteStep(ctx, noteFn) {
    // ponytail: NOT deduped on Retry - no client-proposal-notes (billing-note) READ query is pinned,
    // and inventing one is the fabricated-`workOrderNotes` bug class (vault umbrava-graphql-operations).
    // The resume-from-first-incomplete-step fix above stops a re-post in the normal case; a true
    // read-then-skip dedup (like the WO note below) needs a billing-notes read query pinned first.
    if (!bwnCan('WorkOrderProposal.AddNote')) return null;   // dropped from the plan by openConfirm
    return { label: 'Add note to Proposal #' + ctx.pid + ' Notes tab', pending: false,
      run: function (reason) { return addProposalNote(ctx.pid, noteFn(reason)); } };
  }
  function buildWONoteStep(ctx, noteFn) {
    if (!bwnCan('WorkOrderNote.AddNew')) return null;
    return { label: 'Add note to Work Order W-' + ctx.n + ' notes', pending: false,
      run: function (reason) {
        var text = noteFn(reason);
        // Idempotent (matches bwn-write-queue's note dedup, keyed on the note text via workOrderNotes):
        // skip the post when an identical, non-deleted note already exists, so a Retry does not
        // duplicate it. Fail OPEN - if the read fails, post anyway (a missing note is worse than a
        // rare duplicate, and the note text is itself the stable key).
        return readWONotes(ctx.n).then(function (notes) {
          if (woNoteExists(notes, text)) return true;
          return addWONote(ctx.n, text);
        }, function () { return addWONote(ctx.n, text); });
      } };
  }
  function buildCompleteStep(ctx) {
    if (!bwnCan('Task.Complete')) return null;
    var c = ctx.openTasks.length;
    return { label: c ? ('Complete ' + c + ' open task(s)') : 'No open tasks to complete', pending: false,
      run: function () {
        // Idempotent (skip the task write when already at the target state): re-read at execution
        // time and complete only the still-open tasks, so a Retry completes nothing already done.
        // Fail open to the gather-time task list if the re-read fails.
        return readOpenTasks(ctx.n).then(function (open) { return completeAllTasks(open); },
          function () { return completeAllTasks(ctx.openTasks); });
      } };
  }
  function buildCreateTaskStep(ctx, assigneeGuid, assigneeName, noteFn) {
    if (!bwnCan('Task.AddNew')) return null;
    // ponytail: this append is NOT deduped - the created task carries no idempotency key we can read
    // back (the frozen addTask payload has no marker, and Task has no confirmed read field to match
    // on). It is the LAST step, so the resume fix means it only re-runs if it ITSELF failed; grounding
    // a read-then-skip here needs a task-identity field pinned first.
    return { label: 'Create task for ' + assigneeName + ': ' + firstLine(noteFn('')), pending: false,
      run: function (reason) { return createTask(ctx.n, assigneeGuid, noteFn(reason)); } };
  }

  function startApproval() { startWorkflow('approval'); }
  function startTsp() { startWorkflow('tsp'); }
  function startKickback() { startWorkflow('kickback'); }

  function startWorkflow(kind) {
    paToast('Reading proposal…');
    gatherContext().then(function (ctx) {
      if (kind === 'approval') {
        var aNote = function () { return approvalNote(ctx.gp, ctx.total); };
        return resolveUserName(ctx.wo.coordinator).then(function (name) {
          openConfirm({
            title: 'Approve proposal - Internal Proposal Approved',
            subtitle: 'W-' + ctx.n + '  ·  Proposal #' + ctx.pid + '  ·  ' + ctx.total + '  ·  ' + ctx.gp,
            isKickback: false, noteFn: aNote,
            steps: [
              buildStatusStep(ctx, 'Internal Proposal Approved'),
              buildProposalNoteStep(ctx, aNote),
              buildWONoteStep(ctx, aNote),
              buildCompleteStep(ctx),
              buildCreateTaskStep(ctx, ctx.wo.coordinator, name, aNote)
            ]
          });
        });
      }
      if (kind === 'tsp') {
        var tNote = function () { return tspNote(ctx.gp, ctx.total); };
        // RM-A3: resolve the TSP assignee LIVE and fail closed - never file a task on a stale RONNY_GUID.
        return resolveTspAssignee().then(function (tsp) {
          if (!tsp) { paToast('TSP assignee "' + TSP_ASSIGNEE_NAME + '" could not be verified live - nothing sent. (Set bwn:modules.paLegacyFallback=true to override.)'); return; }
          openConfirm({
            title: 'Send to Trade Specialist - Pending Trade Specialist',
            subtitle: 'W-' + ctx.n + '  ·  Proposal #' + ctx.pid + '  ·  ' + ctx.total + '  ·  ' + ctx.gp,
            isKickback: false, noteFn: tNote,
            steps: [
              buildStatusStep(ctx, 'Pending Trade Specialist'),
              buildProposalNoteStep(ctx, tNote),
              buildWONoteStep(ctx, tNote),
              buildCompleteStep(ctx),
              buildCreateTaskStep(ctx, tsp.guid, tsp.name, tNote)   // TSP is the ONLY action that reassigns the task (to Ronny)
            ]
          });
        });
      }
      // kickback
      var kNote = function (reason) { return kickbackNote(reason, ctx.total); };
      return readProposalContext(ctx.pid).then(function (pc) {
        return draftKickbackReason({ scope: pc.scope, items: pc.items, total: ctx.total, gpText: ctx.gpText }).then(function (reason) {
          return resolveUserName(ctx.wo.coordinator).then(function (name) {
            openConfirm({
              title: 'Kick back proposal - Internal Proposal Rejected',
              subtitle: 'W-' + ctx.n + '  ·  Proposal #' + ctx.pid + '  ·  ' + ctx.total + '  ·  ' + ctx.gp,
              isKickback: true, aiReason: reason, noteFn: kNote,
              steps: [
                buildStatusStep(ctx, 'Internal Proposal Rejected'),
                buildProposalNoteStep(ctx, kNote),
                buildWONoteStep(ctx, kNote),
                buildCompleteStep(ctx),
                buildCreateTaskStep(ctx, ctx.wo.coordinator, name, kNote)
              ]
            });
          });
        });
      });
    }).catch(function (err) {
      paToast('Could not start: ' + ((err && err.message) || err));
    });
  }

  // ===== dropdown UI ========================================================
  var DROPDOWN_ID = 'bwn-pa-dropdown';
  var openMenuEl = null;
  function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener('click', onDocClick, true); } }
  function onDocClick(e) { if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.classList.contains('bwn-pa-trigger')) closeMenu(); }
  function buildMenu(trigger) {
    closeMenu();
    var menu = document.createElement('div');
    menu.className = 'bwn-pa-menu';
    menu.setAttribute('role', 'menu');
    var items = [
      { label: 'Approval', sub: 'Good to submit → Internal Proposal Approved', fn: startApproval },
      { label: 'TSP Review', sub: 'Send to Ronny → Pending Trade Specialist', fn: startTsp },
      { label: 'Kickback', sub: 'AI reason → Internal Proposal Rejected', fn: startKickback }
    ];
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.innerHTML = escapeHtml(it.label) + '<span class="sub">' + escapeHtml(it.sub) + '</span>';
      b.addEventListener('click', function () { closeMenu(); it.fn(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    var r = trigger.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    menu.style.left = Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    openMenuEl = menu;
    setTimeout(function () { document.addEventListener('click', onDocClick, true); }, 0);
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { closeMenu(); document.removeEventListener('keydown', esc); } });
  }
  function buildDropdown() {
    var wrap = document.createElement('span');
    wrap.id = DROPDOWN_ID;
    wrap.style.display = 'inline-flex';
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'bwn-pa-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.textContent = 'Proposal Actions ▾';
    trigger.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (openMenuEl) { closeMenu(); return; }
      buildMenu(trigger);
    });
    wrap.appendChild(trigger);
    return wrap;
  }

  // ===== injection lifecycle ================================================
  function findAnchor() {
    // Prefer sitting next to the proposal's "Submit" button (top-right of the details header).
    var btns = [].slice.call(document.querySelectorAll('button'));
    var submit = btns.filter(function (b) { return /^\s*Submit\s*$/i.test(b.textContent || ''); })[0];
    if (submit && submit.parentNode) return submit;
    // Else the Details/Notes tab strip: a link/tab labelled "Details".
    var tab = [].slice.call(document.querySelectorAll('a,button,[role="tab"]'))
      .filter(function (el) { return /^\s*Details\s*$/i.test(el.textContent || ''); })[0];
    if (tab && tab.parentNode) return tab;
    return null;
  }
  function removeDropdown() { var d = document.getElementById(DROPDOWN_ID); if (d) { closeMenu(); d.remove(); } }
  function injectDropdown() {
    try {
      if (!onProposalDetailsPage()) { removeDropdown(); return; }
      if (!gated()) { removeDropdown(); return; }
      // Every one of the three workflows starts by writing the work order's status, so that
      // checkbox is what makes this menu meaningful at all. The later steps gate themselves.
      // Fails OPEN while the decode is unknown.
      if (!bwnCan('WorkOrderField.Status')) { removeDropdown(); return; }
      ensureStyle();
      if (document.getElementById(DROPDOWN_ID)) return;   // presence-based guard (React wipes; we re-add)
      var dd = buildDropdown();
      var anchor = findAnchor();
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(dd, anchor);
      } else {
        // Fixed fallback so the control is always reachable even before the anchor is pinned.
        dd.style.position = 'fixed';
        dd.style.top = '72px';
        dd.style.right = '20px';
        dd.style.zIndex = '2147483000';
        document.body.appendChild(dd);
      }
    } catch (e) { /* never break the page */ }
  }

  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role') injectDropdown();
    });
  } catch (e) { }
  // RM route helper adoption (phased follow-on to RM-B4). Route-change re-inject centralizes: when
  // BWN_MODULES.routeHelper is ON and Core published window.bwnOnRoute (both @grant none, same page
  // window), subscribe to Core's ONE history patch instead of our own per-mutation body observer.
  // The permanent 900ms poll below stays in BOTH states and is this consumer's re-render recovery net
  // (injectDropdown re-adds the dropdown React wipes), so no recovery poll is needed in the helper.
  // Flag OFF, or Core absent/disabled/throwing, => the legacy RM-B5 body observer installs,
  // byte-for-byte the old behavior (fail-safe).
  function paRouteHooks(onChange) {
    if (BWN_MODULES.routeHelper === true && typeof window.bwnOnRoute === 'function') {
      try { window.bwnOnRoute(onChange); return; } catch (e) { /* fall through to legacy */ }
    }
    try {
      // Trailing debounce (RM-B5): coalesce the SPA re-render bursts instead of firing on every mutation.
      var paObsT = null;
      var paObs = new MutationObserver(function () { clearTimeout(paObsT); paObsT = setTimeout(onChange, 300); });
      paObs.observe(document.body, { childList: true, subtree: true });
    } catch (e) { }
  }
  paRouteHooks(injectDropdown);
  setInterval(injectDropdown, 900);
  injectDropdown();

})();
