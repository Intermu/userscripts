// ==UserScript==
// @name         BWN Proposal Actions (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.7.12
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-actions.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-actions.user.js
// @description  On a Client Proposal DETAILS page, a "Proposal Actions" dropdown runs the internal review workflow in one confirmed action: Approval / TSP Review / Kickback. Each posts a note to the Proposal + the Work Order, sets the WO status, completes open tasks, and files a new task (assigned to the WO coordinator, or Ronny Sharp for TSP). The posted note is an EDITABLE field seeded with the auto-generated text (Kickback's is drafted by the on-device browser AI) so the reviewer can add what they changed as coaching for the coordinator; a "changes since review opened" line (total + GP) is prepended automatically. When the job has more than one client proposal, the trigger shows the option count, a read-only "Compare proposals" view lists every alternative side by side, and the confirm dialog names the job, the exact proposal being acted on and its siblings (with an explicit acknowledgement). Completed actions are kept as a browser-local history (never synced, never an Umbrava status) shown in Compare and as a non-blocking warning on a repeat. Opening an action only reads (proposal, work order, tasks) to prepare the confirm dialog; every change is listed there first, and no proposal or work-order change is submitted until Confirm. @grant none.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.7.12';   // keep in step with @version
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
  var Q_LIST = 'query PA_List($j: Int!){ listClientProposals(jobId: $j, page: { skip: 0, take: 50 }, sortBy: [{ columnName: "id", direction: DESC }]){ items { id total { amount currency precision } grossProfitPercent } } }';
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
        // Match by id ONLY. The old `|| items[0]` fell back to whichever proposal sorted first, so on a
        // job with several alternatives the note could carry a SIBLING's total and GP.
        var it = items.filter(function (x) { return x.id === proposalId; })[0];
        if (!it || !it.total) throw new Error('could not read the total for proposal #' + proposalId);
        return { total: it.total, gpPct: toGpNumber(it.grossProfitPercent) };
      });
    });
  }

  // ===== PA-SIBLINGS START (sliced by scripts/test-pa-multi-proposal.js; references injected paGql / money / toGpNumber) =====
  // A job can carry several client proposals that are alternatives for the same work. The workflow
  // always acts on the proposal in the URL; these helpers read its siblings so the reviewer can compare
  // them and the confirm dialog names exactly which one is being acted on. The extended field list is
  // the PagedClientProposals schema (vault umbrava-graphql-operations); if the server refuses it, the
  // read falls back to the fields this suite already reads live (PA_List + Core's terminal dates) and
  // every field it could not read shows as "not available" rather than a guess.
  var PA_SIB_ARGS = 'jobId: $j, page: { skip: 0, take: 50 }, sortBy: [{ columnName: "id", direction: DESC }]';
  var Q_SIBLINGS = 'query PA_Siblings($j: Int!){ listClientProposals(' + PA_SIB_ARGS + '){ rowCount items { id number description created submittedDate approvedDate rejectedDate canceledDate isSubmitted createdByMemberName status { name } type { name } total { amount currency precision } vendorCost { amount currency precision } grossProfitPercent } } }';
  var Q_SIBLINGS_MIN = 'query PA_SiblingsMin($j: Int!){ listClientProposals(' + PA_SIB_ARGS + '){ rowCount items { id approvedDate rejectedDate canceledDate total { amount currency precision } grossProfitPercent } } }';
  function proposalRow(it) {
    it = it || {};
    var derived = it.canceledDate ? 'Canceled' : it.rejectedDate ? 'Rejected' : it.approvedDate ? 'Approved'
      : (it.isSubmitted === true || it.submittedDate) ? 'Submitted' : (it.isSubmitted === false ? 'Draft' : '');
    return {
      id: it.id,
      // Umbrava's visible per-job proposal number (#1, #2...). Live-verified 2026-09-25 to equal the '#'
      // column for W-397334 / W-395613. DISPLAY ONLY - every lookup, URL and write keys on id.
      number: isPosInt(it.number) ? it.number : null,
      title: it.description || '',
      type: (it.type && it.type.name) || '',
      status: (it.status && it.status.name) || derived,
      canceled: !!it.canceledDate,
      total: (it.total && it.total.amount != null) ? money(it.total) : '',
      gpPct: toGpNumber(it.grossProfitPercent),
      vendorCost: (it.vendorCost && it.vendorCost.amount != null) ? money(it.vendorCost) : '',
      created: it.created || '',
      submitted: it.submittedDate || '',
      createdBy: it.createdByMemberName || ''
    };
  }
  function readJobProposals(jobId) {
    function shape(d, partial) {
      var l = (d && d.listClientProposals) || {};
      var rows = (l.items || []).map(proposalRow);
      return { rows: rows, rowCount: (typeof l.rowCount === 'number') ? l.rowCount : rows.length, partial: partial };
    }
    return paGql('PA_Siblings', Q_SIBLINGS, { j: jobId }).then(function (d) { return shape(d, false); }, function () {
      return paGql('PA_SiblingsMin', Q_SIBLINGS_MIN, { j: jobId }).then(function (d) { return shape(d, true); });
    });
  }
  // Canceled proposals are history, not options: they are listed in Compare but not counted.
  function liveOptions(rows) { return (rows || []).filter(function (r) { return !r.canceled; }); }
  // What the confirm dialog needs to know about the proposal being acted on and its siblings.
  // sib = readJobProposals() result, or null when that read failed. needsAck is true whenever the
  // reviewer could be looking at the wrong alternative: several live options, the acted-on proposal
  // missing from the list, or the list unreadable (fail toward the extra check, never away from it).
  function siblingContext(sib, pid) {
    if (!sib) return { known: false, selected: null, others: [], count: null, needsAck: true };
    var selected = sib.rows.filter(function (r) { return r.id === pid; })[0] || null;
    var others = sib.rows.filter(function (r) { return r.id !== pid; });
    var count = liveOptions(sib.rows).length;
    return { known: true, selected: selected, others: others, count: count,
      needsAck: count > 1 || !selected || sib.rowCount > sib.rows.length };
  }
  // ===== PA-SIBLINGS END =====

  // ===== PA-HISTORY START (sliced by scripts/test-pa-multi-proposal.js; references injected localStorage / escapeHtml) =====
  // Browser-local record of Proposal Actions that COMPLETED here, so a reviewer can see which
  // alternative on a job was already acted on. Umbrava keeps Approval / Kickback / TSP only as the
  // job-level WO status, so it cannot say which proposal they were for. This is a safety aid, never a
  // status: it is not synced, not sent anywhere, and never feeds an outgoing request. Same storage
  // convention as the bwn:audit ring (localStorage, KEY / MAX / SCHEMA constants), under its own key.
  var PA_HIST_KEY = 'bwn:pa:history', PA_HIST_SCHEMA = 1;
  var PA_HIST_MAX = 300;                          // newest records kept, all jobs together
  var PA_HIST_MAX_AGE_MS = 180 * 24 * 3600 * 1000; // records older than 180 days are pruned
  var PA_HIST_NOTE_MAX = 1000;                    // chars of the posted note kept
  var PA_HIST_KINDS = {
    approval: { row: 'Marked good to submit', verb: 'marked good to submit (Approval)' },
    kickback: { row: 'Kicked back', verb: 'kicked back' },
    tsp: { row: 'Sent to TSP', verb: 'sent to TSP' }
  };
  function isPosInt(v) { return typeof v === 'number' && v > 0 && Math.floor(v) === v; }
  // Stored data is untrusted: anything not exactly our v1 shape is dropped, not repaired.
  // ponytail: a record from a NEWER schema is dropped too (and gone on the next write); add a
  // pass-through for schema > PA_HIST_SCHEMA when a v2 actually ships.
  function paHistValid(r) {
    return !!r && typeof r === 'object' && r.schema === PA_HIST_SCHEMA && r.localOnly === true &&
      typeof r.id === 'string' && isPosInt(r.n) && isPosInt(r.pid) && PA_HIST_KINDS.hasOwnProperty(r.kind) &&
      typeof r.ts === 'string' && !isNaN(Date.parse(r.ts));
  }
  // -> { records, error }  error: '' | 'unavailable' | 'corrupt'. Never throws.
  function paHistLoad() {
    var raw;
    try { raw = localStorage.getItem(PA_HIST_KEY); } catch (e) { return { records: [], error: 'unavailable' }; }
    if (raw == null) return { records: [], error: '' };
    try {
      var a = JSON.parse(raw);
      if (!Array.isArray(a)) return { records: [], error: 'corrupt' };
      return { records: a.filter(paHistValid), error: '' };
    } catch (e) { return { records: [], error: 'corrupt' }; }
  }
  function paHistPrune(records, nowMs) {
    return records.filter(function (r) { return nowMs - Date.parse(r.ts) <= PA_HIST_MAX_AGE_MS; })
      .sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); })
      .slice(0, PA_HIST_MAX);
  }
  // Newest first, for one job + proposal.
  function paHistFor(records, n, pid) {
    return records.filter(function (r) { return r.n === n && r.pid === pid; })
      .sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); });
  }
  // The one write. Only this key is touched. -> 'ok' | 'dup' | 'fail'. Never throws.
  function paHistAppend(rec, nowMs) {
    try {
      if (!paHistValid(rec)) return 'fail';
      var cur = paHistLoad();
      if (cur.error === 'unavailable') return 'fail';
      if (cur.records.some(function (r) { return r.id === rec.id; })) return 'dup';
      localStorage.setItem(PA_HIST_KEY, JSON.stringify(paHistPrune(cur.records.concat([rec]), nowMs)));
      return 'ok';
    } catch (e) { return 'fail'; }   // quota, blocked storage
  }
  // Called with runSteps' result. Records ONLY a fully completed run: ok, nothing skipped. The id is
  // the confirm dialog's run id, so a Retry inside the same dialog that finally succeeds writes one
  // record, and a second completion callback for the same run is a 'dup'. A new dialog is a new run,
  // so a legitimate repeat action is recorded separately.
  // -> 'none' (not complete) | 'ok' | 'dup' | 'fail'
  function paHistOnResult(plan, noteText, res, nowMs) {
    var c = plan && plan.ctx;
    if (!res || !res.ok || res.skipped || !c || !plan.runId || !PA_HIST_KINDS.hasOwnProperty(plan.kind)) return 'none';
    var sel = null;
    try { sel = siblingContext(c.siblings, c.pid).selected; } catch (e) { sel = null; }
    try {
      return paHistAppend({
      schema: PA_HIST_SCHEMA, localOnly: true, id: plan.runId,
      ts: new Date(nowMs).toISOString(), kind: plan.kind, n: c.n, pid: c.pid,
      title: (sel && sel.title) || '',           // only the acted-on proposal's own row
      total: c.total || '',                      // readTotals matched this pid (no sibling fallback)
      gpPct: (typeof c.gpPct === 'number' && !isNaN(c.gpPct)) ? c.gpPct : null,
      note: String(noteText || '').slice(0, PA_HIST_NOTE_MAX)
      }, nowMs);
    } catch (e) { return 'fail'; }
  }
  function paHistWhen(r) {
    try {
      return new Date(r.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return String(r.ts); }
  }
  function paHistLine(r) { return 'Local record: ' + PA_HIST_KINDS[r.kind].row + ' · ' + paHistWhen(r); }
  // Compare-view cell: newest record, plus a native disclosure with the rest.
  function paHistCellHtml(recs) {
    if (!recs || !recs.length) return '<span class="na">none in this browser</span>';
    var html = escapeHtml(paHistLine(recs[0]));
    if (recs.length > 1) {
      html += '<details><summary>' + recs.length + ' local records</summary><ul>' + recs.map(function (r) {
        return '<li>' + escapeHtml(paHistLine(r)) + (r.total ? ' · ' + escapeHtml(r.total) : '') + '</li>';
      }).join('') + '</ul></details>';
    }
    return html;
  }
  // Confirm-dialog warning. Informational only: no checkbox, never gates Confirm.
  function paHistWarnHtml(recs) {
    if (!recs || !recs.length) return '';
    var r = recs[0];
    return '<div class="warn hist">' + escapeHtml('Local history shows this proposal was previously ' +
      PA_HIST_KINDS[r.kind].verb + ' on ' + paHistWhen(r) + '. This is not an authoritative Umbrava status.') +
      (recs.length > 1 ? ' <span class="na">(' + recs.length + ' local records)</span>' : '') + '</div>';
  }
  // ===== PA-HISTORY END =====

  // ===== PA-STOPPED START (sliced by scripts/test-pa-multi-proposal.js via the reads slice; references injected localStorage / escapeHtml) =====
  // Browser-local record of an action run that STOPPED partway (runSteps returned ok:false), so a NEW
  // dialog for the same job + proposal + action can warn that starting over repeats the steps this
  // browser saw complete. Separate from bwn:pa:history (completed actions only) and never an Umbrava
  // status. What it can prove: a step listed as done had its own request resolve successfully here;
  // the failed step's request may or may not have reached Umbrava; later steps were not attempted.
  // Keyed by action too: Approval / TSP / Kickback set different statuses and file different tasks.
  var PA_STOP_KEY = 'bwn:pa:stopped', PA_STOP_SCHEMA = 1;
  var PA_STOP_MAX = 100;                           // newest records kept, all jobs together
  var PA_STOP_MAX_AGE_MS = 30 * 24 * 3600 * 1000;  // older than 30 days: pruned
  // Stored as keys, rendered from this fixed map: step labels are not stored (the create-task label
  // carries the note's first line), and an unknown stored key is dropped, never rendered.
  var PA_STOP_STEPS = {
    status: 'WO status change', proposalNote: 'proposal note', woNote: 'WO note',
    completeTasks: 'open-task completion', createTask: 'new task'
  };
  var PA_STOP_ACTIONS = { approval: 'Approval', tsp: 'TSP Review', kickback: 'Kickback' };   // as named in the menu
  function paStopValid(r) {
    return !!r && typeof r === 'object' && r.schema === PA_STOP_SCHEMA && r.localOnly === true &&
      isPosInt(r.n) && isPosInt(r.pid) && PA_HIST_KINDS.hasOwnProperty(r.kind) &&
      typeof r.ts === 'string' && !isNaN(Date.parse(r.ts)) && Array.isArray(r.done) &&
      (r.failed === '' || PA_STOP_STEPS.hasOwnProperty(r.failed)) && isPosInt(r.attempts);
  }
  // -> { records, error }  error: '' | 'unavailable' | 'corrupt'. Never throws.
  function paStopLoad() {
    var raw;
    try { raw = localStorage.getItem(PA_STOP_KEY); } catch (e) { return { records: [], error: 'unavailable' }; }
    if (raw == null) return { records: [], error: '' };
    try {
      var a = JSON.parse(raw);
      if (!Array.isArray(a)) return { records: [], error: 'corrupt' };
      return { records: a.filter(paStopValid), error: '' };
    } catch (e) { return { records: [], error: 'corrupt' }; }
  }
  function paStopFind(records, n, pid, kind) {
    return records.filter(function (r) { return r.n === n && r.pid === pid && r.kind === kind; })[0] || null;
  }
  // Called with every runSteps result. ok:false -> record (merged with an earlier stop of the same
  // action: done steps are unioned, attempts counted). ok with nothing skipped -> resolve (remove) the
  // matching record. Only this key is touched. -> 'none' | 'recorded' | 'resolved' | 'fail'. Never throws.
  function paStopOnResult(plan, res, stepEls, nowMs) {
    try {
      var c = plan && plan.ctx;
      if (!c || !res || !PA_HIST_KINDS.hasOwnProperty(plan.kind)) return 'none';
      var complete = res.ok && !res.skipped;
      if (res.ok && !complete) return 'none';
      var cur = paStopLoad();
      if (cur.error === 'unavailable') return 'fail';
      var prev = paStopFind(cur.records, c.n, c.pid, plan.kind);
      var rest = cur.records.filter(function (r) { return r !== prev; });
      var out;
      if (complete) {
        if (!prev) return 'none';
        out = rest;
      } else {
        var done = [], failed = '';
        (plan.steps || []).forEach(function (s, i) {
          var cls = stepEls && stepEls[i] && stepEls[i].className;
          if (!s || !PA_STOP_STEPS.hasOwnProperty(s.key)) return;
          if (cls === 'ok') done.push(s.key);
          else if (cls === 'err') failed = s.key;
        });
        (prev ? prev.done : []).forEach(function (k) { if (done.indexOf(k) === -1 && PA_STOP_STEPS.hasOwnProperty(k)) done.push(k); });
        out = rest.concat([{
          schema: PA_STOP_SCHEMA, localOnly: true, n: c.n, pid: c.pid, kind: plan.kind,
          ts: new Date(nowMs).toISOString(), firstTs: prev ? prev.firstTs || prev.ts : new Date(nowMs).toISOString(),
          attempts: (prev ? prev.attempts : 0) + 1, failed: failed, done: done
        }]);
      }
      out = out.filter(function (r) { return nowMs - Date.parse(r.ts) <= PA_STOP_MAX_AGE_MS; })
        .sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); }).slice(0, PA_STOP_MAX);
      localStorage.setItem(PA_STOP_KEY, JSON.stringify(out));
      return complete ? 'resolved' : 'recorded';
    } catch (e) { return 'fail'; }   // quota, blocked storage
  }
  // Inline warning for a NEW dialog. rec = the matching record or null; error = paStopLoad().error.
  // -> { html, needsAck }. A record requires the explicit acknowledgement; an unreadable store only
  // says so (it cannot prove there was, or was not, an earlier attempt) and does not block.
  function paStopWarnHtml(rec, error, kind) {
    if (error) {
      return { needsAck: false, html: '<div class="warn stop">' + escapeHtml('Earlier stopped attempts could not be checked (' +
        (error === 'corrupt' ? 'the local record is unreadable' : 'browser storage is unavailable') +
        '). That does not mean no earlier attempt happened.') + '</div>' };
    }
    if (!rec) return { needsAck: false, html: '' };
    var names = function (keys) { return keys.filter(function (k) { return PA_STOP_STEPS.hasOwnProperty(k); }).map(function (k) { return PA_STOP_STEPS[k]; }); };
    var done = names(rec.done);
    var action = PA_STOP_ACTIONS[kind] || 'this action';
    var text = 'Stopped attempt (this browser): a previous ' + action + ' run on this proposal stopped on ' +
      paHistWhen(rec) + (rec.attempts > 1 ? ' (' + rec.attempts + ' stopped attempts)' : '') + '. ' +
      (done.length ? 'The local runner saw these steps complete: ' + done.join(', ') + '. '
        : 'The local runner saw no step complete. ') +
      (rec.failed ? 'It stopped at the ' + PA_STOP_STEPS[rec.failed] + '; that request may or may not have reached Umbrava. ' : '') +
      'A new run starts again at the first step. The proposal note and the new task are not de-duplicated and may be posted again; ' +
      'the WO status, WO note and open tasks are re-checked before writing.';
    return { needsAck: true, html: '<div class="warn stop" role="alert">' + escapeHtml(text) +
      '<label><input type="checkbox" id="bwn-pa-ack-stopped"> I understand this new run may repeat those steps</label></div>' };
  }
  // ===== PA-STOPPED END =====

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
  // Central governance (governance-sync): fold the org flags bwn-suite-ai caches to bwn:gov into
  // BWN_MODULES as ONE-WAY disables, the SAME shape as bwn-suite-core's bwnApplyGov(). A remote
  // flags['proposalActions']===false or flags.globalKillSwitch DISABLES this script's writes - the
  // bwnGqlOp per-feature gate below reads BWN_MODULES['proposalActions'] live - and can NEVER enable
  // one. Fail-closed: an absent or corrupt bundle keeps the local defaults (last-known-good), never
  // relaxes. Re-applies on the bwn:gov ping so a remote kill blocks new writes with no reload.
  if (!('proposalActions' in BWN_MODULES)) BWN_MODULES.proposalActions = true;
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
      feature: 'proposalActions', confirmed: true, ids: { wo: n }, after: { statusId: statusId }
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
    return bwnGqlOp('addEditJobNote', M_WONOTE, { addEditInput: input }, { feature: 'proposalActions', ids: { wo: n } }).then(function () { return true; });
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
    return bwnGqlOp('addClientProposalNote', M_ADD_PROP_NOTE, { data: input }, { feature: 'proposalActions', ids: { proposalId: proposalId } }).then(function () { return true; });
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
    return bwnGqlOp('addTask', M_ADD_TASK, { data: input }, { feature: 'proposalActions', ids: { wo: woNumber } }).then(function () { return true; });
  }

  // completeTask - completeTask(data: CompleteTaskInput!). CompleteTaskInput is JUST { id: ID! }.
  var M_COMPLETE_TASK = 'mutation CompleteTask($data: CompleteTaskInput!){ completeTask(data: $data){ success message } }';
  function completeTask(taskId) {
    if (DRY_RUN) { console.log('[PA DRY_RUN] completeTask', { taskId: taskId }); return Promise.resolve(true); }
    return bwnGqlOp('completeTask', M_COMPLETE_TASK, { data: { id: taskId } }, { feature: 'proposalActions', ids: { taskId: taskId } }).then(function () { return true; });
  }
  function completeAllTasks(tasks) {
    // Promise.all([]) resolves immediately, so a WO with zero open tasks succeeds trivially.
    return Promise.all((tasks || []).map(function (t) { return completeTask(t.id); })).then(function () { return true; });
  }
  // ===== PA-WRITES END ======================================================

  // ===== PA-KICKBACK START (sliced by scripts/test-pa-kickback.js; references injected paGql / LanguageModel) =====
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
  // One NEW session per draft, never cached: an on-device session keeps its conversation history,
  // so a reused session would carry one proposal's scope and prices into the next proposal's draft.
  // ponytail: a fresh create() per draft pays the model start-up each time; clone() of a warm base
  // session would avoid that if drafting feels slow.
  function aiSession(api, sys) {
    function tag(hasSystem) { return function (s) { try { s._bwnSystem = hasSystem; } catch (e) { } return s; }; }
    return Promise.resolve(api.create({ initialPrompts: [{ role: 'system', content: sys }], outputLanguage: 'en' }))
      .then(tag(true), function () { return Promise.resolve(api.create({ outputLanguage: 'en' })).then(tag(false)); });
  }
  function aiDispose(s) { try { if (s && typeof s.destroy === 'function') s.destroy(); } catch (e) { } }
  function onDevice(sys, content) {
    var api = langModel();
    if (!api || typeof api.create !== 'function') return Promise.resolve('');
    return aiReady(api).then(function (ok) {
      if (!ok) return '';
      return aiSession(api, sys).then(function (s) {
        var usedSystem = !!(s && s._bwnSystem !== false);
        return Promise.resolve().then(function () { return s.prompt((usedSystem ? '' : sys + '\n\n') + content); })
          .then(function (t) { aiDispose(s); return t; }, function (err) { aiDispose(s); throw err; });
      });
    }).catch(function () { return ''; });
  }
  // pc = readProposalContext() result. A FAILED read is never shown to the AI: with no scope or lines
  // to go on it could only guess (and "no scope" would read as a real finding), so no draft is made and
  // the reviewer writes the reason. A SUCCESSFUL read says exactly what it found: an empty field is
  // real data, a field the server did not return is "not reported".
  function draftKickbackReason(pc, total, gpText) {
    if (!pc || !pc.ok) return Promise.resolve('');
    var sys = 'You are an internal operations reviewer at a facilities-management company reviewing a client proposal before it is sent to the client. In 1 to 3 short, plain sentences, state specifically why this proposal is being kicked back to the coordinator instead of approved (e.g. margin too low or negative, pricing/scope issues, missing detail). Professional and direct. No greeting, no sign-off, no bullet points.';
    var scope = !pc.scopeReported ? '(not reported)' : (pc.scope.trim() ? pc.scope : '(empty - the proposal has no scope text)');
    var items = !pc.itemsReported ? '(not reported)' : (pc.items ? pc.items : '(no line items on the proposal)');
    var content = 'Scope of work:\n' + scope +
      '\n\nClient total: ' + total +
      '\nGross profit: ' + gpText +
      '\nLine items:\n' + items;
    return onDevice(sys, content).then(function (t) { return (t || '').trim(); });
  }

  // Scope + line-item context for the AI. -> { ok:true, scope, items, scopeReported, itemsReported }
  // on a successful read, { ok:false } when the request failed or returned no proposal. Never throws.
  var Q_PROP_CTX = 'query PA_PropCtx($p: Int!){ proposal(id: $p){ scopeOfWork proposalLineItems { item quantity category } } }';
  function readProposalContext(proposalId) {
    return paGql('PA_PropCtx', Q_PROP_CTX, { p: proposalId }).then(function (d) {
      var pr = d && d.proposal;
      if (!pr) return { ok: false };
      var scopeReported = pr.scopeOfWork != null;
      var itemsReported = Array.isArray(pr.proposalLineItems);
      var items = (itemsReported ? pr.proposalLineItems : []).map(function (li) {
        return '- ' + (li.item || 'item') + ' x' + (li.quantity == null ? '?' : li.quantity);
      }).join('\n');
      return { ok: true, scope: scopeReported ? String(pr.scopeOfWork) : '', items: items, scopeReported: scopeReported, itemsReported: itemsReported };
    }, function () { return { ok: false }; });
  }

  // Kickback reason gate. The seed is built by this script, so every machine-written line has a known,
  // fixed shape; the gate strips ONLY those and passes the note if any other line has a letter or digit.
  // It never judges wording: whatever a reviewer (or the AI draft they can see and edit) wrote counts.
  var PA_KB_PH_AI = '[AI draft unavailable - replace this line with the reason for the coordinator]';
  var PA_KB_PH_READ = '[Proposal details could not be read - replace this line with the reason for the coordinator]';
  function kickbackReasonSeed(pc, reason) {
    if (reason) return reason;
    return (pc && pc.ok) ? PA_KB_PH_AI : PA_KB_PH_READ;
  }
  function paIsMachineLine(ln) {
    return ln === 'Summary' || ln === 'Total' ||
      /^\$-?\d{1,3}(,\d{3})*\.\d{2}$/.test(ln) ||                  // money() output on a line of its own
      /^Changes since review opened: .+\.$/.test(ln);             // deltaLine() output
  }
  // -> '' when the note carries a reason, else the message to show the reviewer.
  function paKickbackReasonGap(noteText) {
    var lines = String(noteText == null ? '' : noteText).split(/\r?\n/).map(function (l) { return l.trim(); });
    var phHead = [PA_KB_PH_AI.slice(0, 22), PA_KB_PH_READ.slice(0, 22)];
    if (lines.some(function (l) { return phHead.some(function (h) { return l.indexOf(h) !== -1; }); })) {
      return 'Replace the placeholder line with the reason for the coordinator.';
    }
    var hasReason = lines.some(function (l) { return !paIsMachineLine(l) && /[\p{L}\p{N}]/u.test(l); });
    return hasReason ? '' : 'Write the reason for the kickback first - the Summary / Total lines are not a reason.';
  }
  // ===== PA-KICKBACK END =====

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
      '#bwn-pa-card textarea{width:100%;min-height:120px;box-sizing:border-box;border:1px solid #cddbd3;border-radius:8px;padding:9px 11px;font:inherit;font-size:13px;resize:vertical;white-space:pre-wrap;}' +
      '#bwn-pa-card .ft{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid #eef3f0;}' +
      '#bwn-pa-card .btn{padding:8px 16px;border-radius:8px;border:1px solid #1a5f3e;font:600 13px inherit;cursor:pointer;}' +
      '#bwn-pa-card .btn.go{background:#1a5f3e;color:#fff;}' +
      '#bwn-pa-card .btn.cancel{background:#fff;color:#0d3d26;}' +
      '#bwn-pa-card .btn:disabled{opacity:.55;cursor:default;}' +
      // The count chip is absolutely positioned so it adds NO width: the trigger sits in the proposal header
      // row next to Umbrava's Submit, and a wider trigger pushed Submit out of view (live 2026-09-25, 950px).
      '.bwn-pa-trigger{position:relative;}' +
      '.bwn-pa-trigger .opts{position:absolute;top:-9px;right:-8px;padding:0 6px;border-radius:999px;background:#fef3c7;border:1px solid #f5d77a;color:#7a4b00;font-size:10px;line-height:14px;font-weight:700;white-space:nowrap;pointer-events:none;}' +
      '#bwn-pa-card.wide{width:960px;}' +
      '#bwn-pa-card .sum{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 12px;font-size:13px;}' +
      '#bwn-pa-card .sum dt{color:#5b6b62;}#bwn-pa-card .sum dd{margin:0;font-weight:600;}' +
      '#bwn-pa-card .warn{background:#fffbeb;border:1px solid #f5d77a;border-radius:8px;padding:9px 11px;margin:0 0 12px;font-size:12.5px;color:#5c3d00;}' +
      '#bwn-pa-card .warn ul{margin:4px 0 6px 18px;padding:0;}' +
      '#bwn-pa-card .na{color:#8a948f;font-style:italic;font-weight:400;}' +
      '#bwn-pa-card .tbl{overflow-x:auto;}' +
      '#bwn-pa-card table{border-collapse:collapse;width:100%;font-size:12.5px;}' +
      '#bwn-pa-card th,#bwn-pa-card td{padding:7px 8px;border-bottom:1px solid #eef3f0;text-align:left;vertical-align:top;}' +
      '#bwn-pa-card th{font-weight:600;color:#5b6b62;white-space:nowrap;}' +
      '#bwn-pa-card td.num{text-align:right;white-space:nowrap;}' +
      '#bwn-pa-card tr.sel td{background:#f0fdf4;}#bwn-pa-card tr.sel td:first-child{box-shadow:inset 3px 0 0 #1a5f3e;}' +
      '#bwn-pa-card tr.cxl td{color:#8a948f;}' +
      '#bwn-pa-card .chip{display:inline-block;padding:1px 7px;border-radius:999px;background:#1a5f3e;color:#fff;font-size:11px;font-weight:600;white-space:nowrap;}' +
      '#bwn-pa-card .note{font-size:12px;color:#5b6b62;margin:10px 0 0;}' +
      '#bwn-pa-card .warn.hist{background:#eff6ff;border-color:#bfdbfe;color:#1e3a5f;}' +
      '#bwn-pa-card details summary{cursor:pointer;color:#1a5f3e;font-size:12px;}#bwn-pa-card details ul{margin:4px 0 0 16px;padding:0;}';
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

  // ===== focus trap (paste-identical copy of the suite helper; drift-guarded by scripts/test-a11y-focus.js) =====
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

  // ===== multi-proposal display helpers =====================================
  function na(why) { return '<span class="na">' + escapeHtml(why || 'not available') + '</span>'; }
  function orNa(v, why) { return v ? escapeHtml(v) : na(why); }
  // Live listClientProposals dates are UTC with an offset and 7 fraction digits
  // ("2026-09-22T17:57:32.5739342+00:00", verified 2026-09-25). Format in the reviewer's LOCAL zone:
  // slicing the leading YYYY-MM-DD showed the UTC day, one day ahead for anything after 8 PM Eastern.
  function fmtDate(s) {
    if (!s) return '';
    var t = Date.parse(String(s));
    if (!isNaN(t)) return new Date(t).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    return m ? m[2] + '/' + m[3] + '/' + m[1] : String(s);
  }
  function gpPctText(p) { return (typeof p === 'number' && !isNaN(p)) ? (p * 100).toFixed(1) + '%' : ''; }
  // '#2 (ID 561841)' when the row carries a proven visible number, else '#561841' exactly as before.
  // Never derived from row position or id order: no number on the row -> id only.
  function propLabel(r, id) { return (r && isPosInt(r.number)) ? '#' + r.number + ' (ID ' + id + ')' : '#' + id; }
  function proposalHref(n, id) { return '/work-orders/' + n + '/proposals/client-proposals/' + id + '/details'; }
  // Local-history read problems are said once per page session, and only from user-opened views
  // (Compare, confirm) - never from the 900ms inject loop.
  var _paHistWarned = false;
  function paHistNotice(error) {
    if (!error || _paHistWarned) return;
    _paHistWarned = true;
    paToast(error === 'corrupt'
      ? 'Local action history was unreadable and is ignored (it is replaced on the next completed action). Actions still work.'
      : 'Local action history is unavailable in this browser. Actions still work.');
  }
  // A plan is bound to the WO + proposal it was gathered for; the page must still show that pair.
  function stillOnPlanPage(plan) {
    var c = plan && plan.ctx;
    return !c || (woNumberFromUrl() === c.n && proposalIdFromUrl() === c.pid);
  }
  // The "what exactly am I about to do" block at the top of the confirm dialog.
  function confirmSummaryHtml(plan) {
    var c = plan && plan.ctx;
    if (!c) return '';
    var sc = siblingContext(c.siblings, c.pid);
    var sel = sc.selected;
    var titleBits = sel ? [sel.title, sel.type].filter(Boolean).join(' · ') : '';
    var html = '<dl class="sum">' +
      '<dt>Job</dt><dd>W-' + escapeHtml(c.n) + (c.wo && c.wo.statusName ? ' <span class="na">(WO status now: ' + escapeHtml(c.wo.statusName) + ')</span>' : '') + '</dd>' +
      '<dt>Proposal</dt><dd>' + escapeHtml(propLabel(sel, c.pid)) + (titleBits ? ' - ' + escapeHtml(titleBits) : ' ' + na('title not available')) + '</dd>' +
      '<dt>Vendor</dt><dd>' + na('not on the client proposal record') + (sel && sel.vendorCost ? ' <span class="na">(vendor cost ' + escapeHtml(sel.vendorCost) + ')</span>' : '') + '</dd>' +
      '<dt>Amount</dt><dd>' + escapeHtml(c.total) + ' · ' + escapeHtml(c.gp) + (c.gpText !== 'unknown' ? ' (' + escapeHtml(c.gpText) + ')' : '') + '</dd>' +
      '<dt>Action</dt><dd>' + escapeHtml(plan.action || plan.title) + '</dd>' +
      '<dt>Routing</dt><dd>' + orNa(plan.routing) + '</dd>' +
      '<dt>Comment</dt><dd>Required - the editable note below</dd>' +
      '</dl>';
    var hist = paHistLoad();
    paHistNotice(hist.error);
    html += paHistWarnHtml(paHistFor(hist.records, c.n, c.pid));   // informational; never gates Confirm
    // A stopped earlier attempt of THIS action gates Confirm on its own acknowledgement (#bwn-pa-ack-stopped).
    var stop = paStopLoad();
    html += paStopWarnHtml(paStopFind(stop.records, c.n, c.pid, plan.kind), stop.error, plan.kind).html;
    if (!sc.needsAck) return html;
    var why;
    if (!sc.known) why = 'The other proposals on this job could not be read, so this dialog cannot rule out a sibling option.';
    else if (!sel) why = 'Proposal #' + c.pid + ' was not found in this job\'s proposal list.';
    else why = 'This job has ' + sc.count + ' proposal options. Only ' + propLabel(sel, c.pid) + ' gets the proposal note; the WO status and tasks change for the whole job.';
    var list = sc.others.map(function (r) {
      return '<li>' + escapeHtml(propLabel(r, r.id)) + ' - ' + orNa(r.status, 'status n/a') + ' · ' + orNa(r.total, 'total n/a') +
        (r.title ? ' · ' + escapeHtml(r.title) : '') + '</li>';
    }).join('');
    if (c.siblings && c.siblings.rowCount > c.siblings.rows.length) list += '<li>' + na('+' + (c.siblings.rowCount - c.siblings.rows.length) + ' more not shown') + '</li>';
    return html + '<div class="warn">' + escapeHtml(why) + (list ? '<ul>' + list + '</ul>' : '') +
      '<label><input type="checkbox" id="bwn-pa-ack"> I am acting on Proposal ' + escapeHtml(propLabel(sel, c.pid)) + '</label></div>';
  }

  // ===== confirm modal ======================================================
  // plan = { title, subtitle, noteSeed, steps:[{label,pending,run(noteText)}] }
  // The note preview is an EDITABLE textarea seeded with noteSeed (the auto-generated note, with any
  // "what changed" delta line already prepended). The operator's final text is threaded to every
  // note-posting step by runSteps, so what they see is exactly what posts to the Proposal, the WO
  // note, and the coordinator's task. For kickback the seed is the AI-drafted reason + summary.
  // Each step.run() returns a Promise. A step whose run rejects with NOT_PINNED is SKIPPED
  // (shown "pending capture"); any other rejection STOPS the run and is reported.
  function openConfirm(plan) {
    // A step builder returns null when this operator's Umbrava permissions do not cover that write
    // (see the build*Step functions). Dropping them HERE keeps the three workflow definitions
    // readable and means the plan the operator confirms is exactly the plan that will run.
    if (plan && Array.isArray(plan.steps)) plan.steps = plan.steps.filter(Boolean);
    // The reads between the menu click and here are async; if the reviewer moved to another proposal
    // meanwhile, this plan belongs to a page they are no longer looking at. Refuse rather than open it.
    if (!stillOnPlanPage(plan)) { paToast('You moved to a different proposal - nothing opened. Run Proposal Actions again on the proposal you want.'); return; }
    if (!paTakeOverlaySlot()) return;   // a run is in flight in the dialog on screen: keep it, open nothing
    // One id per opened dialog: the local-history identity of this run (Retry reuses it).
    plan.runId = 'pa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    ensureStyle();

    var overlay = document.createElement('div');
    overlay.id = 'bwn-pa-overlay';
    var card = document.createElement('div');
    card.id = 'bwn-pa-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    var stepEls = [];
    var stepsHtml = plan.steps.map(function (s, i) {
      return '<li data-i="' + i + '" class="' + (s.pending ? 'pending' : '') + '">' +
        '<span class="ic">' + (s.pending ? '⚠' : '•') + '</span>' +
        '<span class="lb">' + escapeHtml(s.label) + (s.pending ? ' <em>(pending capture)</em>' : '') + '</span></li>';
    }).join('');

    card.innerHTML =
      '<div class="hd"><div class="t">' + escapeHtml(plan.title) + '</div>' +
      (plan.subtitle ? '<div class="s">' + escapeHtml(plan.subtitle) + '</div>' : '') + '</div>' +
      '<div class="bd">' + confirmSummaryHtml(plan) +
      '<div style="font-size:12px;color:#5b6b62;margin:0 0 4px;">Note that will be posted (editable) - add what you changed for the coordinator:</div>' +
      '<textarea id="bwn-pa-note"></textarea>' +
      '<div style="height:12px;"></div>' +
      '<div style="font-size:12px;color:#5b6b62;margin:0 0 4px;">This will:</div>' +
      '<ul class="steps">' + stepsHtml + '</ul>' +
      '<div id="bwn-pa-runstat" aria-live="polite"></div>' +
      '</div>' +
      '<div class="ft"><button class="btn cancel" id="bwn-pa-cancel">Cancel</button>' +
      '<button class="btn go" id="bwn-pa-go">Confirm</button></div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    var cancelBtn = card.querySelector('#bwn-pa-cancel');
    var goBtn = card.querySelector('#bwn-pa-go');
    var noteTa = card.querySelector('#bwn-pa-note');
    plan.steps.forEach(function (s, i) { stepEls[i] = card.querySelector('li[data-i="' + i + '"]'); });

    noteTa.value = plan.noteSeed || '';
    // Several alternatives on the job (or siblings unreadable): Confirm stays disabled until the
    // reviewer ticks that this is the proposal they mean.
    var ack = card.querySelector('#bwn-pa-ack');
    var ackStopped = card.querySelector('#bwn-pa-ack-stopped');
    var ctl = paConfirmController(plan, { goBtn: goBtn, cancelBtn: cancelBtn, noteTa: noteTa, ack: ack, ackStopped: ackStopped, stepEls: stepEls, card: card, status: card.querySelector('#bwn-pa-runstat') }, close);
    _paActiveCtl = ctl;
    overlay._paClose = close;
    [ack, ackStopped].forEach(function (a) {
      if (!a) return;
      goBtn.disabled = true;
      a.addEventListener('change', ctl.ackChanged);
    });
    var releaseTrap = paArmTrap(overlay);

    // Every dismissal path goes through ctl.requestClose, which refuses while a run is in flight.
    function close() {
      try { overlay.remove(); } catch (e) { }
      document.removeEventListener('keydown', onKey);
      if (_paActiveCtl === ctl) _paActiveCtl = null;
      try { releaseTrap(); } catch (e) { }   // focus back to the Proposal Actions trigger
    }
    function onKey(e) { if (e.key === 'Escape') ctl.requestClose(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) ctl.requestClose(); });
    cancelBtn.addEventListener('click', ctl.requestClose);
    goBtn.addEventListener('click', ctl.go);
  }

  function mark(li, cls, icon, note) {
    if (!li) return;
    li.className = cls;
    var ic = li.querySelector('.ic'); if (ic) ic.textContent = icon;
    if (note) { var lb = li.querySelector('.lb'); if (lb) lb.innerHTML = lb.innerHTML.replace(/ <em>.*<\/em>/, '') + ' <em>' + escapeHtml(note) + '</em>'; }
  }

  // The runner's own step marks (li.className) are the one progress record: '' = before any run,
  // 'wait' = not started, 'run' = running, 'ok' = completed (run() resolved: change made, or a re-check found it in place), 'err' = failed.
  // Retry resumes at the first step that is not 'ok'; the status line reads the same marks.
  function paFirstUnfinished(stepEls, n) {
    var i = 0;
    while (i < n && stepEls[i] && stepEls[i].className === 'ok') i++;
    return i;
  }

  // Sequential runner. noteText (the operator's final, edited note) is threaded to each step's run.
  function runSteps(steps, noteText, stepEls) {
    var skipped = 0;
    // Resume from the first not-yet-completed step: a step already marked 'ok' (a checkmark from a
    // previous run) is not re-run, so a Retry after a mid-sequence failure does NOT re-post a note,
    // re-create the task, or re-set the status that already succeeded. First run: nothing is 'ok', so
    // idx stays 0 and behaviour is unchanged.
    var idx = paFirstUnfinished(stepEls, steps.length);
    for (var w = idx; w < steps.length; w++) mark(stepEls[w], 'wait', '•', 'not started');
    function next() {
      if (idx >= steps.length) return Promise.resolve({ ok: true, skipped: skipped });
      var s = steps[idx];
      var li = stepEls[idx];
      mark(li, 'run', '…', 'running');
      return Promise.resolve().then(function () { return s.run(noteText); }).then(function () {
        mark(li, 'ok', '✓', 'completed');
        idx++; return next();
      }, function (err) {
        var msg = (err && err.message) || String(err);
        if (/^NOT_PINNED/.test(msg)) {
          skipped++;
          mark(li, 'skip', '⚠', 'skipped - not yet captured');
          idx++; return next();
        }
        mark(li, 'err', '✗', 'failed: ' + msg);
        return { ok: false, failedLabel: s.label, error: msg };
      });
    }
    return next();
  }

  // The dialog's persistent run-status line, built from the runner's marks above (no second tracker).
  // phase: 'ready' | 'running' | 'failed' | 'done'; res = runSteps' result for 'failed' / 'done'.
  // A failed request is reported as uncertain: it may or may not have reached Umbrava.
  function paRunStatusHtml(phase, steps, stepEls, res) {
    var n = steps.length;
    function lbl(i) { return 'step ' + (i + 1) + ' (' + steps[i].label + ')'; }
    if (phase === 'ready') {
      return '<div class="note runstat-msg">' + escapeHtml('No proposal or work-order changes are submitted until you press Confirm. Cancel closes this dialog without submitting any.') + '</div>';
    }
    if (phase === 'running') {
      return '<div class="note runstat-msg">' + escapeHtml('Running: steps run one at a time, in the order listed. Cancel is unavailable until this run stops.') + '</div>';
    }
    if (phase === 'done') {
      var sk = (res && res.skipped) || 0;
      return '<div class="note runstat-msg">' + escapeHtml((sk
        ? (n - sk) + ' of ' + n + ' steps completed; ' + sk + ' step(s) skipped (not yet captured, not sent).'
        : 'All ' + n + ' steps completed.') + ' A completed step either made its change or found it already in place.') + '</div>';
    }
    var completed = [], failedAt = -1;
    for (var i = 0; i < n; i++) {
      var c = stepEls[i] && stepEls[i].className;
      if (c === 'ok') completed.push(i);
      // 'run' = an unexpected stop left this step's request in flight: just as uncertain as a failure
      else if ((c === 'err' || c === 'run') && failedAt < 0) failedAt = i;
    }
    var resume = paFirstUnfinished(stepEls, n);
    var err = res && res.error ? ' (error: ' + res.error + ')' : '';
    var lines = [
      failedAt >= 0
        ? 'This run stopped at ' + lbl(failedAt) + ', ' + (failedAt + 1) + ' of ' + n + '.'
        : 'This run stopped unexpectedly' + err + '.',
      completed.length
        // 'ok' only means the step's run() resolved: it made its change, or a re-check found the change
        // already in place (status, WO note, open tasks re-check before writing). Say exactly that.
        ? 'Completed: ' + completed.map(lbl).join('; ') + '. A completed step either made its change or found it already in place.'
        : 'No step completed.'
    ];
    if (failedAt >= 0) lines.push('The failed request may or may not have reached Umbrava' + err + '.');
    if (resume < n) lines.push('Retry resumes at step ' + (resume + 1) + ' and does not repeat completed steps.' +
      (failedAt >= 0 ? ' It sends step ' + (failedAt + 1) + ' again, so if that request did reach Umbrava it may be repeated.' : ''));
    // res.stopRecord = paStopOnResult's outcome: 'fail' means no stopped-attempt record exists, so a new
    // dialog has nothing to warn from - do not promise that it will.
    lines.push('Cancel is available now: it stops this dialog from attempting further steps; it does not undo completed steps. ' +
      (res && res.stopRecord === 'fail'
        ? 'This browser could not save a stopped-attempt record, so a new dialog for this action will not warn that it may repeat steps.'
        : 'If you start this action again in a new dialog, that dialog warns that it may repeat steps.'));
    // No role="alert": the region is already aria-live="polite", and an alert inside it is read twice.
    return '<div class="warn runstat-msg"><b>' + escapeHtml(lines[0]) + '</b>' +
      lines.slice(1).map(function (t) { return '<div>' + escapeHtml(t) + '</div>'; }).join('') + '</div>';
  }

  // Confirm-dialog run lifecycle: ONE run at a time, and no dismissal while it is in flight. The steps
  // are separate non-atomic writes, so a second overlapping run would re-send steps the first has not
  // finished (duplicate proposal note / task), and hiding a running dialog would hide a partial
  // failure. state: 'idle' (not started, or failed and retryable) -> 'running' -> 'done' | 'idle'.
  // els = { goBtn, cancelBtn, noteTa, ack (or null), stepEls }; closeFn removes the dialog.
  function paConfirmController(plan, els, closeFn) {
    var state = 'idle';
    var goBtn = els.goBtn, cancelBtn = els.cancelBtn, noteTa = els.noteTa;
    // Every acknowledgement the dialog rendered must be ticked: the multi-option one and/or the
    // stopped-attempt one. Either may be absent (null).
    var acks = [els.ack, els.ackStopped].filter(Boolean);
    function allAcked() { return acks.every(function (a) { return a.checked; }); }
    function setAcksDisabled(v) { acks.forEach(function (a) { a.disabled = v; }); }
    // The persistent in-dialog status line (els.status, optional): the runner's marks, in words.
    function setStatus(phase, res) { if (els.status) els.status.innerHTML = paRunStatusHtml(phase, plan.steps, els.stepEls, res); }
    setStatus('ready');
    function unlockForRetry() {
      state = 'idle';
      cancelBtn.disabled = false;
      goBtn.disabled = false; goBtn.textContent = 'Retry';
      setAcksDisabled(false);
    }
    function requestClose() {
      if (state === 'running') return false;
      closeFn();
      return true;
    }
    // Only an idle dialog lets the acknowledgement drive Confirm; mid-run or after Done it is inert.
    function ackChanged() { if (state === 'idle' && acks.length) goBtn.disabled = !allAcked(); }
    function go() {
      if (state !== 'idle') return null;   // a run is in flight or already done
      var noteText = noteTa.value;
      if (!allAcked()) return null;
      if (!stillOnPlanPage(plan)) {
        paToast('This page now shows a different proposal - nothing sent.');
        closeFn();
        return null;
      }
      if (!noteText.trim()) {
        paToast('Enter a note first.');
        return null;
      }
      // A kickback must tell the coordinator why: the Summary / Total block, the change-since-review
      // line and the placeholder are not a reason. Approval and TSP are unaffected.
      var kbGap = plan.kind === 'kickback' ? paKickbackReasonGap(noteText) : '';
      if (kbGap) {
        paToast(kbGap);
        return null;
      }
      state = 'running';
      goBtn.disabled = true; cancelBtn.disabled = true; noteTa.disabled = true;
      setAcksDisabled(true);
      // Disabling the focused Confirm drops focus to <body>, outside the focus trap; park it on the
      // card so Tab stays contained while every control is disabled.
      if (els.card) { try { els.card.setAttribute('tabindex', '-1'); els.card.focus(); } catch (e) { } }
      setStatus('running');
      return runSteps(plan.steps, noteText, els.stepEls).then(function (res) {
        // Stopped-attempt record: written on a stop, resolved on a full completion (never on cancel).
        var sw = paStopOnResult(plan, res, els.stepEls, Date.now());
        var swNote = sw === 'fail' ? ' (The stopped-attempt record could not be ' + (res.ok ? 'cleared' : 'saved') + ' in this browser.)' : '';
        if (res.ok) {
          state = 'done';
          setStatus('done', res);
          goBtn.textContent = res.skipped ? 'Done (some pending)' : 'Done';
          // After the writes, never before; a failed history write never changes the outcome.
          var h = paHistOnResult(plan, noteText, res, Date.now());
          paToast((res.skipped
            ? 'Proven steps done. ' + res.skipped + ' step(s) skipped - awaiting mutation capture.'
            : 'All steps complete.') + (h === 'fail' ? ' (Local action history could not be saved in this browser.)' : '') + swNote);
          setTimeout(closeFn, res.skipped ? 4500 : 2200);
        } else {
          unlockForRetry();
          setStatus('failed', { ok: false, error: res.error, stopRecord: sw });   // persistent; the toast below is only a courtesy
          paToast('Stopped at "' + res.failedLabel + '": ' + res.error + swNote);
        }
        return res;
      }).then(null, function (err) {
        // runSteps itself never rejects; this only keeps an unexpected throw from leaving the
        // dialog locked in 'running' with no way to close or retry.
        if (state === 'running') unlockForRetry();
        // a throw after Done must not turn a completed run's status into a failure/Retry message
        if (state !== 'done') setStatus('failed', { ok: false, error: String((err && err.message) || err) });
        paToast('Run stopped unexpectedly: ' + ((err && err.message) || err));
        return { ok: false, error: String((err && err.message) || err) };
      });
    }
    return { go: go, ackChanged: ackChanged, requestClose: requestClose, state: function () { return state; } };
  }

  // Active-run overlay guard. The confirmation on screen registers its controller here; every path
  // that opens the menu, Compare, or another confirmation asks paRefuseWhileRunning() first, and the
  // one place a prior overlay is removed for a new one (paTakeOverlaySlot) refuses while that run is
  // in flight - so nothing can hide or replace a dialog whose writes are still going out.
  var _paActiveCtl = null;
  var _paBusyToastAt = 0;
  var PA_BUSY_TOAST_MS = 4000;   // at most one "still running" notice per 4s of blocked attempts
  function paRunBusy() { return !!(_paActiveCtl && _paActiveCtl.state() === 'running'); }
  function paRefuseWhileRunning() {
    if (!paRunBusy()) return false;
    var now = Date.now();
    if (now - _paBusyToastAt > PA_BUSY_TOAST_MS) {
      _paBusyToastAt = now;
      paToast('An action is still running on this proposal - wait for it to finish.');
    }
    return true;
  }
  // -> true when the slot is free (any prior overlay closed through its own close path).
  function paTakeOverlaySlot() {
    if (paRefuseWhileRunning()) return false;
    var prior = document.getElementById('bwn-pa-overlay');
    if (prior) { if (typeof prior._paClose === 'function') prior._paClose(); else prior.remove(); }
    return true;
  }
  // Arm the suite focus trap on a confirmation overlay. The menu item that started the action is
  // gone by the time the dialog opens, so the trigger is focused first: the trap records it as the
  // opener and returns focus there on close.
  function paArmTrap(overlay) {
    var trig = document.querySelector('#bwn-pa-dropdown .bwn-pa-trigger');
    if (trig && trig.focus) { try { trig.focus(); } catch (e) { } }
    return bwnFocusTrap(overlay);
  }

  // ===== "what changed" delta (total + GP) ==================================
  // Coaching aid: snapshot the proposal's total + GP the first time the reviewer lands on the
  // details page (before they edit it in Umbrava), then compare at action time so the posted note
  // tells the coordinator what moved. ponytail: total + GP only - line-level "added 4 hrs / revised
  // scope" needs a proposal-revision read that is not pinned; that stays the reviewer's own words in
  // the editable note. Baseline is best-effort: if the page is opened AFTER edits, or the read fails,
  // no delta is shown (never a wrong one). Keyed by proposal id, per page session (memory only).
  var _paBaseline = {};   // pid -> { amount, precision, gpPct } | null (in-flight or unavailable)
  function captureBaseline(pid) {
    if (pid == null || _paBaseline[pid] !== undefined) return;   // once per pid; null marks in-flight/failed
    _paBaseline[pid] = null;
    var n = woNumberFromUrl();
    if (n == null) return;
    readWO(n).then(function (wo) { return readTotals(wo.jobId, pid); }).then(function (tot) {
      _paBaseline[pid] = { amount: tot.total && tot.total.amount, precision: tot.total && tot.total.precision, gpPct: tot.gpPct };
    }).catch(function () { _paBaseline[pid] = null; });
  }
  function deltaLine(pid, curTot, curGpPct) {
    var b = _paBaseline[pid];
    if (!b) return '';
    var parts = [];
    var bAmt = b.amount, cAmt = curTot && curTot.amount;
    if (bAmt != null && cAmt != null && Number(bAmt) !== Number(cAmt)) {
      var p = (curTot.precision != null) ? curTot.precision : 2;
      var d = (Number(cAmt) - Number(bAmt)) / Math.pow(10, p);
      parts.push((d > 0 ? 'raised total ' : 'lowered total ') +
        '$' + Math.abs(d).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }
    if (b.gpPct != null && curGpPct != null && Math.abs(b.gpPct - curGpPct) >= 0.0001) {
      parts.push('GP ' + (b.gpPct * 100).toFixed(1) + '% -> ' + (curGpPct * 100).toFixed(1) + '%');
    }
    return parts.length ? 'Changes since review opened: ' + parts.join(', ') + '.' : '';
  }
  function seedWithDelta(pid, curTot, curGpPct, baseNote) {
    var dl = deltaLine(pid, curTot, curGpPct);
    return dl ? dl + '\n\n' + baseNote : baseNote;
  }

  // ===== action orchestration ===============================================
  function gatherContext() {
    var n = woNumberFromUrl();
    var pid = proposalIdFromUrl();
    if (n == null || pid == null) return Promise.reject(new Error('not on a proposal details page'));
    return readWO(n).then(function (wo) {
      return readTotals(wo.jobId, pid).then(function (tot) {
        return readOpenTasks(n).then(function (openTasks) {
          // Siblings are read fresh at action time (not from the badge cache) so the confirm dialog's
          // list is current. A failed read is null, which the dialog treats as "cannot rule out".
          return readJobProposals(wo.jobId).catch(function () { return null; }).then(function (siblings) {
            return {
              n: n, pid: pid, wo: wo,
              total: money(tot.total), totalRaw: tot.total, gpPct: tot.gpPct, gp: gpLabel(tot.gpPct),
              gpText: (tot.gpPct == null ? 'unknown' : (tot.gpPct * 100).toFixed(2) + '%'),
              openTasks: openTasks, siblings: siblings
            };
          });
        });
      });
    });
  }

  function buildStatusStep(ctx, statusName) {
    return {
      key: 'status', label: 'Set WO status → ' + statusName, pending: false,
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
  // The three workflows now post the SAME operator-editable note (threaded as noteText by runSteps),
  // seeded from the auto-generated template. The step no longer rebuilds the text from a template fn.
  function buildProposalNoteStep(ctx) {
    // ponytail: NOT deduped on Retry - no client-proposal-notes (billing-note) READ query is pinned,
    // and inventing one is the fabricated-`workOrderNotes` bug class (vault umbrava-graphql-operations).
    // The resume-from-first-incomplete-step fix above stops a re-post in the normal case; a true
    // read-then-skip dedup (like the WO note below) needs a billing-notes read query pinned first.
    if (!bwnCan('WorkOrderProposal.AddNote')) return null;   // dropped from the plan by openConfirm
    return { key: 'proposalNote', label: 'Add note to Proposal #' + ctx.pid + ' Notes tab', pending: false,
      run: function (noteText) { return addProposalNote(ctx.pid, noteText); } };
  }
  function buildWONoteStep(ctx) {
    if (!bwnCan('WorkOrderNote.AddNew')) return null;
    return { key: 'woNote', label: 'Add note to Work Order W-' + ctx.n + ' notes', pending: false,
      run: function (noteText) {
        // Idempotent (matches bwn-write-queue's note dedup, keyed on the note text via workOrderNotes):
        // skip the post when an identical, non-deleted note already exists, so a Retry does not
        // duplicate it. Fail OPEN - if the read fails, post anyway (a missing note is worse than a
        // rare duplicate, and the note text is itself the stable key).
        return readWONotes(ctx.n).then(function (notes) {
          if (woNoteExists(notes, noteText)) return true;
          return addWONote(ctx.n, noteText);
        }, function () { return addWONote(ctx.n, noteText); });
      } };
  }
  function buildCompleteStep(ctx) {
    if (!bwnCan('Task.Complete')) return null;
    var c = ctx.openTasks.length;
    return { key: 'completeTasks', label: c ? ('Complete ' + c + ' open task(s)') : 'No open tasks to complete', pending: false,
      run: function () {
        // Idempotent (skip the task write when already at the target state): re-read at execution
        // time and complete only the still-open tasks, so a Retry completes nothing already done.
        // Fail open to the gather-time task list if the re-read fails.
        return readOpenTasks(ctx.n).then(function (open) { return completeAllTasks(open); },
          function () { return completeAllTasks(ctx.openTasks); });
      } };
  }
  function buildCreateTaskStep(ctx, assigneeGuid, assigneeName, seedText) {
    if (!bwnCan('Task.AddNew')) return null;
    // ponytail: this append is NOT deduped - the created task carries no idempotency key we can read
    // back (the frozen addTask payload has no marker, and Task has no confirmed read field to match
    // on). It is the LAST step, so the resume fix means it only re-runs if it ITSELF failed; grounding
    // a read-then-skip here needs a task-identity field pinned first.
    // Label previews the seed's first line; the task actually posts the operator's final note text.
    return { key: 'createTask', label: 'Create task for ' + assigneeName + ': ' + firstLine(seedText), pending: false,
      run: function (noteText) { return createTask(ctx.n, assigneeGuid, noteText); } };
  }

  function startApproval() { startWorkflow('approval'); }
  function startTsp() { startWorkflow('tsp'); }
  function startKickback() { startWorkflow('kickback'); }

  function startWorkflow(kind) {
    if (paRefuseWhileRunning()) return;   // no reads, no new plan while a confirmation run is in flight
    paToast('Reading proposal…');
    gatherContext().then(function (ctx) {
      if (kind === 'approval') {
        var aSeed = seedWithDelta(ctx.pid, ctx.totalRaw, ctx.gpPct, approvalNote(ctx.gp, ctx.total));
        return resolveUserName(ctx.wo.coordinator).then(function (name) {
          openConfirm({
            title: 'Approve proposal - Internal Proposal Approved',
            subtitle: 'W-' + ctx.n + '  ·  Proposal #' + ctx.pid + '  ·  ' + ctx.total + '  ·  ' + ctx.gp,
            ctx: ctx, kind: 'approval', action: 'Approval (good to submit)',
            routing: 'WO status → Internal Proposal Approved; task → ' + name + ' (coordinator)',
            noteSeed: aSeed,
            steps: [
              buildStatusStep(ctx, 'Internal Proposal Approved'),
              buildProposalNoteStep(ctx),
              buildWONoteStep(ctx),
              buildCompleteStep(ctx),
              buildCreateTaskStep(ctx, ctx.wo.coordinator, name, aSeed)
            ]
          });
        });
      }
      if (kind === 'tsp') {
        var tSeed = seedWithDelta(ctx.pid, ctx.totalRaw, ctx.gpPct, tspNote(ctx.gp, ctx.total));
        // RM-A3: resolve the TSP assignee LIVE and fail closed - never file a task on a stale RONNY_GUID.
        return resolveTspAssignee().then(function (tsp) {
          if (!tsp) { paToast('TSP assignee "' + TSP_ASSIGNEE_NAME + '" could not be verified live - nothing sent. (Set bwn:modules.paLegacyFallback=true to override.)'); return; }
          openConfirm({
            title: 'Send to Trade Specialist - Pending Trade Specialist',
            subtitle: 'W-' + ctx.n + '  ·  Proposal #' + ctx.pid + '  ·  ' + ctx.total + '  ·  ' + ctx.gp,
            ctx: ctx, kind: 'tsp', action: 'TSP Review',
            routing: 'WO status → Pending Trade Specialist; task → ' + tsp.name + ' (Trade Specialist)',
            noteSeed: tSeed,
            steps: [
              buildStatusStep(ctx, 'Pending Trade Specialist'),
              buildProposalNoteStep(ctx),
              buildWONoteStep(ctx),
              buildCompleteStep(ctx),
              buildCreateTaskStep(ctx, tsp.guid, tsp.name, tSeed)   // TSP is the ONLY action that reassigns the task (to Ronny)
            ]
          });
        });
      }
      // kickback: the on-device AI drafts the rejection reason; that becomes the editable seed, so
      // the reviewer confirms/edits the WHOLE note (reason + summary) in one field. No draft (AI
      // unavailable, or the proposal details could not be read) seeds a placeholder the reviewer must
      // replace - Confirm refuses until the note carries a reason (paKickbackReasonGap).
      return readProposalContext(ctx.pid).then(function (pc) {
        return draftKickbackReason(pc, ctx.total, ctx.gpText).then(function (reason) {
          return resolveUserName(ctx.wo.coordinator).then(function (name) {
            var kSeed = seedWithDelta(ctx.pid, ctx.totalRaw, ctx.gpPct, kickbackNote(kickbackReasonSeed(pc, reason), ctx.total));
            openConfirm({
              title: 'Kick back proposal - Internal Proposal Rejected',
              subtitle: 'W-' + ctx.n + '  ·  Proposal #' + ctx.pid + '  ·  ' + ctx.total + '  ·  ' + ctx.gp,
              ctx: ctx, kind: 'kickback', action: 'Kickback (correction / more info)',
              routing: 'WO status → Internal Proposal Rejected; task → ' + name + ' (coordinator)',
              noteSeed: kSeed,
              steps: [
                buildStatusStep(ctx, 'Internal Proposal Rejected'),
                buildProposalNoteStep(ctx),
                buildWONoteStep(ctx),
                buildCompleteStep(ctx),
                buildCreateTaskStep(ctx, ctx.wo.coordinator, name, kSeed)
              ]
            });
          });
        });
      });
    }).catch(function (err) {
      paToast('Could not start: ' + ((err && err.message) || err));
    });
  }

  // ===== job-level proposal count (trigger badge) ===========================
  // One sibling read per WO per page session, for the badge only. null = in flight or failed (no badge,
  // no retry storm from the 900ms inject loop). Compare and the confirm dialog always re-read fresh.
  var _paJob = {};   // WO# -> readJobProposals() result | null
  function loadJobProposals(n) {
    if (n == null || _paJob[n] !== undefined) return;
    _paJob[n] = null;
    readWO(n).then(function (wo) { return readJobProposals(wo.jobId); })
      .then(function (r) { _paJob[n] = r; paintTrigger(); }, function () { /* stays null: no badge */ });
  }
  function optionCount() {
    var r = _paJob[woNumberFromUrl()];
    return r ? liveOptions(r.rows).length : 0;
  }
  function paintTrigger() {
    var t = document.querySelector('#' + DROPDOWN_ID + ' .bwn-pa-trigger');
    if (!t) return;
    var c = optionCount();
    var key = proposalIdFromUrl() + ':' + c;
    if (t.getAttribute('data-k') === key) return;   // unchanged: no DOM write, so no observer echo
    t.setAttribute('data-k', key);
    t.innerHTML = 'Proposal Actions ▾' + (c > 1 ? '<span class="opts">' + c + ' options</span>' : '');
    t.title = c > 1 ? 'This job has ' + c + ' proposal options. Actions apply only to #' + proposalIdFromUrl() + ' (this page).' : '';
  }

  // ===== compare view (read-only) ===========================================
  // Every proposal on the job side by side. Selecting another proposal NAVIGATES to its own details
  // page: the page URL stays the single source of "selected", so an action can never target a
  // proposal other than the one the reviewer is looking at.
  function openCompare() {
    var n = woNumberFromUrl(), pid = proposalIdFromUrl();
    if (n == null || pid == null) return;
    if (paRefuseWhileRunning()) return;   // no read, no overlay while a confirmation run is in flight
    paToast('Reading proposals on this job…');
    readWO(n).then(function (wo) {
      return readJobProposals(wo.jobId).then(function (sib) { renderCompare(n, pid, wo, sib); });
    }).catch(function (err) { paToast('Could not read this job\'s proposals: ' + ((err && err.message) || err)); });
  }
  function renderCompare(n, pid, wo, sib) {
    if (woNumberFromUrl() !== n || proposalIdFromUrl() !== pid) return;   // navigated away during the read
    if (!paTakeOverlaySlot()) return;   // a confirmation run is in flight: keep that dialog, render nothing
    ensureStyle();
    var overlay = document.createElement('div');
    overlay.id = 'bwn-pa-overlay';
    var card = document.createElement('div');
    card.id = 'bwn-pa-card';
    card.className = 'wide';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Compare proposals on W-' + n);
    var live = liveOptions(sib.rows).length, cxl = sib.rows.length - live;
    var hist = paHistLoad();
    paHistNotice(hist.error);
    var rows = sib.rows.map(function (r) {
      var isSel = r.id === pid;
      var pick = isSel ? '<span class="chip" aria-current="page">Selected (this page)</span>'
        : '<a href="' + escapeHtml(proposalHref(n, r.id)) + '">Open to act on ' + escapeHtml(propLabel(r, r.id)) + '</a>';
      return '<tr class="' + (isSel ? 'sel' : '') + (r.canceled ? ' cxl' : '') + '">' +
        '<td>' + escapeHtml(propLabel(r, r.id)) + '</td>' +
        '<td>' + orNa(r.title, 'no description') + (r.type ? '<div class="na">' + escapeHtml(r.type) + '</div>' : '') + '</td>' +
        '<td class="num">' + orNa(r.total) + '</td>' +
        '<td class="num">' + orNa(gpPctText(r.gpPct)) + '</td>' +
        '<td class="num">' + orNa(r.vendorCost) + '</td>' +
        '<td>' + orNa(r.status) + '</td>' +
        '<td>' + orNa(fmtDate(r.created)) + (r.createdBy ? '<div class="na">' + escapeHtml(r.createdBy) + '</div>' : '') + '</td>' +
        '<td>' + orNa(fmtDate(r.submitted), 'not submitted / n/a') + '</td>' +
        '<td>' + paHistCellHtml(paHistFor(hist.records, n, r.id)) + '</td>' +
        '<td>' + pick + '</td></tr>';
    }).join('');
    card.innerHTML =
      '<div class="hd"><div class="t">Compare proposals - W-' + escapeHtml(n) + '</div>' +
      '<div class="s">' + live + ' option(s)' + (cxl ? ' + ' + cxl + ' canceled' : '') + '  ·  WO status: ' + escapeHtml(wo.statusName || 'not available') + '</div></div>' +
      '<div class="bd"><div class="tbl"><table><thead><tr>' +
      '<th>Proposal</th><th>Description</th><th>Total</th><th>GP</th><th>Vendor cost</th><th>Status</th><th>Created</th><th>Submitted</th><th>Local action history</th><th>Selection</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (sib.rowCount > sib.rows.length ? '<div class="note">Showing the first ' + sib.rows.length + ' of ' + sib.rowCount + ' proposals.</div>' : '') +
      (sib.partial ? '<div class="note">The extended proposal read was refused, so description, type, vendor cost, created and submitted dates are not available here.</div>' : '') +
      '<div class="note">Approval / TSP Review / Kickback act only on the selected proposal. The WO status and tasks they change are job-wide. ' +
      'Local action history lists only actions completed in THIS browser; it is not an Umbrava status and is not shared. ' +
      'Vendor, trade and NTE are not on client proposal records. Approval / Kickback / TSP are job-level WO statuses, not stored per proposal.</div>' +
      '</div><div class="ft"><button class="btn cancel" id="bwn-pa-cmp-close">Close</button></div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    function close() { try { overlay.remove(); } catch (e) { } document.removeEventListener('keydown', onKey); }
    overlay._paClose = close;
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    var closeBtn = card.querySelector('#bwn-pa-cmp-close');
    closeBtn.addEventListener('click', close);
    closeBtn.focus();
  }

  // ===== dropdown UI ========================================================
  var DROPDOWN_ID = 'bwn-pa-dropdown';
  var openMenuEl = null;
  function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener('click', onDocClick, true); } }
  function onDocClick(e) { if (openMenuEl && !openMenuEl.contains(e.target) && !(e.target.closest && e.target.closest('.bwn-pa-trigger'))) closeMenu(); }
  function buildMenu(trigger) {
    if (paRefuseWhileRunning()) return;
    closeMenu();
    var menu = document.createElement('div');
    menu.className = 'bwn-pa-menu';
    menu.setAttribute('role', 'menu');
    var items = [
      { label: 'Approval', sub: 'Good to submit → Internal Proposal Approved', fn: startApproval },
      { label: 'TSP Review', sub: 'Send to Ronny → Pending Trade Specialist', fn: startTsp },
      { label: 'Kickback', sub: 'AI reason → Internal Proposal Rejected', fn: startKickback }
    ];
    var c = optionCount();
    if (c > 1) items.unshift({ label: 'Compare proposals (' + c + ' options)', sub: 'Read-only - nothing is changed', fn: openCompare });
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
    wrap.style.alignSelf = 'center';   // in a flex row: do not stretch to the row height (keeps the badge inside it)
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
  // Returns the WHOLE Details/Notes tab component; the trigger is inserted as its next sibling, in the
  // row that holds it. Live 2026-09-25 (878px): that row is a flex row with visible overflow and free
  // space to the right of the tabs. Two placements were measured and rejected:
  //  - beside Umbrava's Submit (<= 0.7.7): on a long title the trigger pushed Submit out of view;
  //  - inside the tablist, before "Details" (0.7.8): the tab scroller clipped the options badge, the
  //    selected-tab underline moved under our trigger, and a non-tab control sat among the tabs.
  // null -> the caller's fixed fallback (never the tablist, never Submit's row).
  function findAnchor() {
    var tab = [].slice.call(document.querySelectorAll('a,button,[role="tab"]'))
      .filter(function (el) { return /^\s*Details\s*$/i.test(el.textContent || ''); })[0];
    var comp = tab && tab.closest ? tab.closest('.MuiTabs-root') : null;   // MUI's stable component class
    if (!comp || !comp.parentNode) return null;
    var rowHasSubmit = [].slice.call(comp.parentNode.querySelectorAll('button'))
      .some(function (b) { return /^\s*Submit\s*$/i.test(b.textContent || ''); });
    return rowHasSubmit ? null : comp;
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
      captureBaseline(proposalIdFromUrl());   // snapshot total+GP once, before the reviewer edits
      loadJobProposals(woNumberFromUrl());    // sibling count for the badge, once per WO
      ensureStyle();
      var existing = document.getElementById(DROPDOWN_ID);
      if (existing) {   // presence-based guard (React wipes; we re-add)
        // Injected before the tab strip rendered -> it sits in the fixed fallback. Move that same node
        // (listeners intact) into the tab row once the anchor exists, instead of floating over the page.
        if (existing.style.position === 'fixed') {
          var late = findAnchor();
          if (late && late.parentNode) {
            existing.style.position = ''; existing.style.top = ''; existing.style.right = ''; existing.style.zIndex = '';
            late.parentNode.insertBefore(existing, late.nextSibling);   // after the tab component
          }
        }
        paintTrigger();
        return;
      }
      var dd = buildDropdown();
      var anchor = findAnchor();
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(dd, anchor.nextSibling);   // sibling AFTER the whole tab component
      } else {
        // Fixed fallback so the control is always reachable even before the anchor is pinned.
        dd.style.position = 'fixed';
        dd.style.top = '72px';
        dd.style.right = '20px';
        dd.style.zIndex = '2147483000';
        document.body.appendChild(dd);
      }
      paintTrigger();
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
