// test-bulk-ops.js - the Bulk Operations Console engine (Core module, flag bulkOps default OFF).
//
// WHAT THIS PROVES, against the REAL shipped bytes of bwn-suite-core.user.js: the BULK-OPS-ENGINE
// region (the pure, DOM-free write engine) is sliced out and CONCATENATED with the BWN-OPS region
// (the audited bwnGqlOp wrapper + registry), then run in a vm with a fake localStorage and an
// injectable bwnGql transport - so the batch write path is exercised end to end through the real
// audit ring + fail-closed confirm gate, not a stub.
//
//   add-note shape   the addEditJobNote input is byte-shape-identical to bwn-write-queue's wo.note
//                    (marker present, type 13, every sibling field), and a re-run finds its marker.
//   set-ecd shape    the patchWorkOrder data carries the WHOLE priority object - every sibling copied
//                    or blanked-hazard - plus serviceLevelAgreementId ONLY when the read had it.
//   dry-run          mode:'dry' builds the exact variables but sends ZERO writes (mutation path spied).
//   4-state tally    done / no-op / failed / not-run, holes counted, never via .filter.
//   caps             over the per-op record cap -> REFUSED, count reported, never truncated.
//   retry dedup      the idemKey is runId+':'+wo, stable across a Retry that reuses the runId.
//
// Every guarantee carries a negative control: a mutated copy of the same source that MUST turn the
// check red (mutate() throws if its target is absent or not unique), so no assertion is decorative.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bulk-ops.js
// CI runs: node scripts/test-bulk-ops.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  if (coreFull.indexOf(end, b + 1) !== -1) throw new Error(what + ': END marker not unique');
  return coreFull.slice(a, b + end.length);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S_OPS = slice('  // ===== BWN-OPS START v1', '  // ===== BWN-OPS END v1 =====', 'BWN-OPS block');
var S_ENG = slice('    // ===== BULK-OPS-ENGINE START v1', '    // ===== BULK-OPS-ENGINE END v1 =====', 'BULK-OPS-ENGINE block');

// The engine must never touch the DOM - that is what lets this harness drive the shipped bytes.
A.ok('BULK-OPS-ENGINE slice is DOM-free', !/\bdocument\b|\bwindow\b|\bXLSX\b/.test(S_ENG), 'engine must not reach the DOM');

// The pinned docs must be the VERBATIM bwn-write-queue strings (a re-shaped selector is a silent bug).
A.ok('WO_READ_Q is the verbatim write-queue read', S_ENG.indexOf('var WO_READ_Q = "query($n:Int!){ workOrder(workOrderNumber:$n){ assignedTo statusId serviceLevelAgreementId priority{ label responseMinutes firstTripDate serviceLevelAgreementMinutes expirationMinutes expectedCompletionDate hasPriorityOverride category skipWeekends } } }";') !== -1);
A.ok('NOTES_Q is the verbatim write-queue notes read', S_ENG.indexOf('var NOTES_Q = "query BwnWorkOrderNotes($n: Int!) { workOrderNotes(workOrderNumber: $n) { id type content isDeleted } }";') !== -1);
A.ok('PATCH_M is the verbatim write-queue mutation', S_ENG.indexOf('var PATCH_M = "mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }";') !== -1);
A.ok('ADD_NOTE_M is the verbatim write-queue mutation', S_ENG.indexOf('var ADD_NOTE_M = "mutation AddEditWONote($addEditInput: WorkOrderNoteInput!) { addEditJobNote(data: $addEditInput) { success message note { id type } } }";') !== -1);

// ---- source-level ship-safety: the module is gated OFF and nothing mounts when the flag is off ----
A.ok('bulkOps flag ships default OFF', /bulkOps: false,/.test(coreFull));
A.ok('bulkOpsDestructive flag ships default OFF', /bulkOpsDestructive: false/.test(coreFull));
A.ok('the whole module mounts only behind BWN_MODULES.bulkOps', /bwnBoot\('bulkOps', BWN_MODULES\.bulkOps, function \(\) \{/.test(coreFull));
A.ok('the add-note write passes feature:bulkOps to the wrapper', /feature: 'bulkOps', ids: \{ wo: wo \}/.test(S_ENG));
// F4-DEEP: the converged bulk path must NEVER pass a bare confirmed:true - every high-risk write
// routes through the ARMED per-batch confirm handler. A confirmed:true literal on the bulk path would
// re-open the exact trust residual the WRAP flags, so its ABSENCE here is load-bearing.
// Strip full-line comments so the check sees CODE only (the design is described with the phrase
// "confirmed:true" in several comments; what must never appear is a confirmed:true in an opts object).
var S_ENG_CODE = S_ENG.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');
A.ok('NO bare confirmed:true anywhere in the bulk engine CODE (F4-deep)', S_ENG_CODE.indexOf('confirmed: true') === -1 && S_ENG_CODE.indexOf('confirmed:true') === -1);
A.ok('the engine installs an injected _confirmFn via bwnGqlOp.setConfirm', /bwnGqlOp\.setConfirm\(bulkConfirmHandler\)/.test(S_ENG));
A.ok('the destructive verbs (status/assign) are gated by a second flag bulkOpsDestructive', /bulkOpsDestructive/.test(coreFull) && /needsDestructiveFlag/.test(S_ENG));

var DEFAULT_WO = {
  assignedTo: 'g', statusId: 41, serviceLevelAgreementId: 'sla-1',
  priority: { label: 'P3', responseMinutes: 1440, firstTripDate: null, serviceLevelAgreementMinutes: 1440, expirationMinutes: 0, expectedCompletionDate: '2026-01-01', hasPriorityOverride: false, category: 'Svc', skipWeekends: false }
};
// Programmable bwnGql: records every call so a test can assert what was (or was NOT) issued. The
// classification order matters - workOrderNotes must be tested before the bare workOrder read.
function mkGql(opts) {
  opts = opts || {};
  function gql(query) {
    var variables = arguments[1];
    gql.calls.push({ q: query, v: variables });
    if (/patchWorkOrder/.test(query)) return Promise.resolve({ patchWorkOrder: { success: opts.patchFail ? false : true, message: opts.patchFail ? 'refused' : '' } });
    if (/addEditJobNote/.test(query)) return Promise.resolve({ addEditJobNote: { success: opts.noteFail ? false : true, note: { id: 'note-1' }, message: '' } });
    if (/addTask/.test(query)) return Promise.resolve({ addTask: { success: opts.taskFail ? false : true, message: '' } });
    if (/workOrderNotes/.test(query)) return Promise.resolve({ workOrderNotes: opts.notes || [] });
    if (/workOrder\s*\(/.test(query)) return Promise.resolve({ workOrder: (opts.wo === undefined ? DEFAULT_WO : opts.wo) });
    return Promise.resolve({});
  }
  gql.calls = [];
  return gql;
}
function writeCalls(g) { return g.calls.filter(function (c) { return /patchWorkOrder|addEditJobNote|addTask/.test(c.q); }); }
function patchCalls(g) { return g.calls.filter(function (c) { return /patchWorkOrder/.test(c.q); }); }
function notePosts(g) { return g.calls.filter(function (c) { return /addEditJobNote/.test(c.q); }); }
function taskPosts(g) { return g.calls.filter(function (c) { return /addTask/.test(c.q); }); }

function makeEnv(opts, engSrc) {
  opts = opts || {};
  var store = Object.create(null);
  var gql = mkGql(opts);
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, JSON: JSON, RegExp: RegExp,
    Promise: Promise, Error: Error, Math: Math, Date: Date, console: console,
    parseInt: parseInt, isFinite: isFinite,
    window: {},                                   // no crypto -> corrId uses the timestamp form
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    setTimeout: function (fn) { return setTimeout(fn, 0); },
    BWN_VER: '0.0.0-test',
    BWN_MODULES: opts.modules || { bulkOps: true },
    bwnGql: gql
  };
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + S_OPS + '\n' + (engSrc || S_ENG) + '\n' +
    'return { run: bwnGqlOp, auditAll: bwnAuditAll,\n' +
    '  bulkExecNote: bulkExecNote, bulkExecEcd: bulkExecEcd, bulkExecStatus: bulkExecStatus, bulkExecAssign: bulkExecAssign,\n' +
    '  bulkExecTask: bulkExecTask, bulkExecDocReq: bulkExecDocReq, bulkExecPatch: bulkExecPatch,\n' +
    '  bulkTally: bulkTally, auditTally: auditTally,\n' +
    '  pendingRows: pendingRows, runPool: runPool, overCap: overCap, capForOp: capForOp, idemKeyFor: idemKeyFor,\n' +
    '  priorityWriteValue: priorityWriteValue, markerFor: markerFor, noteHasMarker: noteHasMarker, cond: cond,\n' +
    '  armBatchConfirm: armBatchConfirm, disarmBatchConfirm: disarmBatchConfirm, bulkConfirmHandler: bulkConfirmHandler, batchArmed: batchArmed, withArmedBatch: withArmedBatch,\n' +
    '  bulkModuleKilled: bulkModuleKilled, approvalDecision: approvalDecision, isHighRisk: isHighRisk, needsDestructiveFlag: needsDestructiveFlag, destructiveArmBlocked: destructiveArmBlocked,\n' +
    '  clampReason: clampReason, clampRef: clampRef, undoLabelFor: undoLabelFor, bulkScalar: bulkScalar,\n' +
    '  BULK_MAX_RECORDS: BULK_MAX_RECORDS, ADD_NOTE_M: ADD_NOTE_M, PATCH_M: PATCH_M, M_ADD_TASK: M_ADD_TASK };\n})()',
    sandbox, { filename: 'bulk-ops.js' });
  return { api: api, gql: gql };
}
function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 6); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}

(async function () {
  // ---- pure helpers ------------------------------------------------------------------------
  var e = makeEnv();
  A.eq('cond wraps {shouldInclude:true, value}', e.api.cond(41), { shouldInclude: true, value: 41 });
  A.eq('idemKey = runId + : + wo', e.api.idemKeyFor('R1', 100), 'R1:100');
  A.eq('markerFor(idemKey)', e.api.markerFor('R1:100'), '[bwn:R1:100]');
  A.ok('noteHasMarker finds the run marker', e.api.noteHasMarker([{ content: 'x [bwn:R1:100] y' }], 'R1:100'));
  A.ok('noteHasMarker ignores a deleted note', !e.api.noteHasMarker([{ content: '[bwn:R1:100]', isDeleted: true }], 'R1:100'));
  A.ok('noteHasMarker is per idemKey', !e.api.noteHasMarker([{ content: '[bwn:R1:999]' }], 'R1:100'));

  // priorityWriteValue: whole-object copy, every sibling carried, override forced.
  var pw = e.api.priorityWriteValue({ label: 'P2', responseMinutes: 720, firstTripDate: '2026-01-01', serviceLevelAgreementMinutes: 60, expirationMinutes: 10, category: 'RF', skipWeekends: true, hasPriorityOverride: false }, '2026-09-01');
  A.eq('priority carries EVERY sibling (9 keys)', Object.keys(pw).sort(), ['category', 'expectedCompletionDate', 'expirationMinutes', 'firstTripDate', 'hasOverridePriority', 'label', 'responseMinutes', 'serviceLevelAgreementMinutes', 'skipWeekends']);
  A.eq('priority sets the new ECD', pw.expectedCompletionDate, '2026-09-01');
  A.eq('priority forces hasOverridePriority (read->input name flip)', pw.hasOverridePriority, true);

  // ---- add-note happy: posts once, exact input shape, marker present -----------------------
  e = makeEnv({ notes: [] });
  var rN = await e.api.bulkExecNote('run', 'RUN1', '100', 'call the vendor');
  await tick();
  A.eq('add-note: outcome done', rN.outcome, 'done');
  A.eq('add-note: exactly one post', notePosts(e.gql).length, 1);
  var inp = notePosts(e.gql)[0].v.addEditInput;
  A.eq('add-note: input keys are the write-queue set', Object.keys(inp).sort(), ['actionNoteEmails', 'content', 'contentHtml', 'isCompletion', 'isInvoice', 'isPinned', 'targetPurchaseOrderNumbers', 'type', 'workOrderNumber']);
  A.eq('add-note: workOrderNumber is the numeric WO', inp.workOrderNumber, 100);
  A.eq('add-note: type is 13 (Internal)', inp.type, 13);
  A.ok('add-note: content carries the [bwn:RUN1:100] marker', inp.content.indexOf('[bwn:RUN1:100]') !== -1);
  A.ok('add-note: contentHtml is the paragraph form', /^<p>/.test(inp.contentHtml));
  A.eq('add-note: targetPurchaseOrderNumbers is []', inp.targetPurchaseOrderNumbers, []);
  A.eq('add-note: actionNoteEmails is null', inp.actionNoteEmails, null);
  A.ok('add-note: the three flags are false', inp.isCompletion === false && inp.isInvoice === false && inp.isPinned === false);
  A.eq('add-note: one audit entry, outcome ok', (e.api.auditAll()[0] || {}).outcome, 'ok');

  // ---- add-note idempotency: marker already present -> no-op, no second post ---------------
  e = makeEnv({ notes: [{ content: 'prior [bwn:RUN1:100] tag', isDeleted: false }] });
  var rNoop = await e.api.bulkExecNote('run', 'RUN1', '100', 'call the vendor');
  await tick();
  A.eq('add-note idempotency: outcome no-op', rNoop.outcome, 'noop');
  A.eq('add-note idempotency: reason already-posted', rNoop.reason, 'already-posted');
  A.eq('add-note idempotency: NO post issued', notePosts(e.gql).length, 0);
  A.eq('add-note idempotency: no audit entry for a no-op (no write)', e.api.auditAll().length, 0);

  // ---- Retry dedup: same runId -> same marker -> the retried row is a no-op ----------------
  //   (A DIFFERENT runId would post - the control below.)
  e = makeEnv({ notes: [{ content: '[bwn:RUN1:100]', isDeleted: false }] });
  var rRetrySame = await e.api.bulkExecNote('run', 'RUN1', '100', 'x');
  await tick();
  A.eq('retry with the SAME runId dedups (no double-post)', notePosts(e.gql).length, 0);
  A.eq('...and reports no-op', rRetrySame.outcome, 'noop');
  e = makeEnv({ notes: [{ content: '[bwn:RUN1:100]', isDeleted: false }] });
  await e.api.bulkExecNote('run', 'RUN2', '100', 'x');   // different runId -> different marker
  await tick();
  A.eq('CONTROL: a DIFFERENT runId is not deduped (marker is per-run, so dedup is load-bearing)', notePosts(e.gql).length, 1);

  // ---- set-ECD happy: whole-object priority, every sibling, SLA bundled --------------------
  //   Now ARM the per-batch confirm first (F4-deep): no bare confirmed:true carries this any more.
  e = makeEnv();   // DEFAULT_WO, oldEcd 2026-01-01
  e.api.armBatchConfirm('RUN1', [200], 'audit cleanup: reset stale ECDs');
  var rE = await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01', 'audit cleanup: reset stale ECDs', 'TCK-1');
  await tick();
  A.eq('set-ECD: outcome done', rE.outcome, 'done');
  A.eq('set-ECD: exactly one patch', patchCalls(e.gql).length, 1);
  var data = patchCalls(e.gql)[0].v.data;
  A.eq('set-ECD: data keys are workOrderNumber + priority + serviceLevelAgreementId', Object.keys(data).sort(), ['priority', 'serviceLevelAgreementId', 'workOrderNumber']);
  A.eq('set-ECD: workOrderNumber numeric', data.workOrderNumber, 200);
  A.eq('set-ECD: priority.value carries EVERY sibling (9 keys)', Object.keys(data.priority.value).sort(), ['category', 'expectedCompletionDate', 'expirationMinutes', 'firstTripDate', 'hasOverridePriority', 'label', 'responseMinutes', 'serviceLevelAgreementMinutes', 'skipWeekends']);
  A.eq('set-ECD: label preserved (not blanked)', data.priority.value.label, 'P3');
  A.eq('set-ECD: category preserved', data.priority.value.category, 'Svc');
  A.eq('set-ECD: new ECD set inside the whole priority', data.priority.value.expectedCompletionDate, '2026-09-01');
  A.eq('set-ECD: override forced', data.priority.value.hasOverridePriority, true);
  A.eq('set-ECD: serviceLevelAgreementId bundled as a cond', data.serviceLevelAgreementId, { shouldInclude: true, value: 'sla-1' });
  A.eq('set-ECD: high-risk write audited ok (the ARMED handler unblocked the gate)', (e.api.auditAll()[0] || {}).outcome, 'ok');
  A.eq('set-ECD: audit after carries the clamped reason (PII-free scalar, not in ids)', (e.api.auditAll()[0] || {}).after.reason, 'audit cleanup: reset stale ECDs');
  A.eq('set-ECD: audit after carries the ticket ref', (e.api.auditAll()[0] || {}).after.ref, 'TCK-1');
  A.eq('set-ECD: audit after carries the runId', (e.api.auditAll()[0] || {}).after.runId, 'RUN1');
  A.eq('set-ECD: audit ids carry ONLY the wo (reason/ref NEVER in ids)', Object.keys((e.api.auditAll()[0] || {}).ids || {}), ['wo']);
  e.api.disarmBatchConfirm();

  // ---- set-ECD no-op: the date already matches -> skip, no patch ---------------------------
  e = makeEnv({ wo: { serviceLevelAgreementId: 's', priority: { expectedCompletionDate: '2026-09-01T12:00:00Z' } } });
  var rEnoop = await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01');
  await tick();
  A.eq('set-ECD no-op: outcome no-op', rEnoop.outcome, 'noop');
  A.eq('set-ECD no-op: NO patch when the ECD already matches', patchCalls(e.gql).length, 0);

  // ---- set-ECD without an SLA on the read -> no serviceLevelAgreementId key ----------------
  e = makeEnv({ wo: { priority: { label: 'P1', expectedCompletionDate: '2026-01-01' } } });
  e.api.armBatchConfirm('RUN1', [200], 'r');
  await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01', 'r', 'T');
  await tick();
  A.ok('set-ECD: serviceLevelAgreementId omitted when the read had none', !('serviceLevelAgreementId' in patchCalls(e.gql)[0].v.data));
  e.api.disarmBatchConfirm();

  // ---- DRY-RUN: builds the exact vars, sends ZERO writes ----------------------------------
  e = makeEnv({ notes: [] });
  var dN = await e.api.bulkExecNote('dry', 'DRY', '100', 'hello');
  await tick();
  A.eq('dry add-note: outcome would-send', dN.outcome, 'would-send');
  A.ok('dry add-note: it built the real addEditInput (marker + type 13)', dN.vars.addEditInput.type === 13 && dN.vars.addEditInput.content.indexOf('[bwn:DRY:100]') !== -1);
  A.eq('dry add-note: ZERO writes sent', writeCalls(e.gql).length, 0);
  e = makeEnv();
  var dE = await e.api.bulkExecEcd('dry', 'DRY', '200', '2026-09-01');
  await tick();
  A.eq('dry set-ECD: outcome would-send', dE.outcome, 'would-send');
  A.ok('dry set-ECD: it built the real whole-priority data', dE.vars.data.priority.value.expectedCompletionDate === '2026-09-01');
  A.eq('dry set-ECD: ZERO writes sent', writeCalls(e.gql).length, 0);

  // ---- 4-state tally: done / no-op / failed / not-run ------------------------------------
  e = makeEnv();
  var res = new Array(5);
  res[0] = { outcome: 'done' };
  res[1] = { outcome: 'noop', reason: 'already-posted' };
  res[2] = { error: 'boom' };
  res[3] = { outcome: 'done' };
  // res[4] left a HOLE (not-run)
  A.eq('bulkTally splits all four states', e.api.bulkTally(res, 5), { done: 2, noop: 1, failed: 1, notRun: 1 });
  A.eq('a hole is never a done (auditTally discipline holds)', e.api.bulkTally(new Array(3), 3), { done: 0, noop: 0, failed: 0, notRun: 3 });

  // ---- MAX-RECORDS: over cap -> REFUSED, count reported, NEVER truncated -------------------
  A.eq('note cap is 50', e.api.capForOp('note'), 50);
  A.eq('ecd cap is 25', e.api.capForOp('ecd'), 25);
  A.eq('note at cap is allowed', e.api.overCap('note', 50), { refused: false, cap: 50, count: 50, over: 0 });
  A.eq('note over cap is REFUSED with the count + overage', e.api.overCap('note', 51), { refused: true, cap: 50, count: 51, over: 1 });
  A.eq('ecd over cap is REFUSED (tighter cap)', e.api.overCap('ecd', 26), { refused: true, cap: 25, count: 26, over: 1 });
  A.ok('overCap reports the count, it does not truncate it', e.api.overCap('ecd', 100).count === 100);

  // ---- feature kill switch: bulkOps off -> the write is refused, nothing sent -------------
  e = makeEnv({ modules: { bulkOps: false }, notes: [] });
  var offDenied = false;
  await e.api.bulkExecNote('run', 'RUN1', '100', 'x').then(function () {}, function () { offDenied = true; });
  await tick();
  A.ok('kill switch: bulkOps:false refuses the note write', offDenied);
  A.eq('kill switch: nothing posted when the module is off', notePosts(e.gql).length, 0);
  A.eq('kill switch: audit outcome denied', (e.api.auditAll()[0] || {}).outcome, 'denied');

  // ---- high-risk gate: a patchWorkOrder with NO confirmed:true and NO armed handler is refused ----
  e = makeEnv();
  var gateRefused = false;
  await e.api.run('patchWorkOrder', e.api.PATCH_M, { data: { workOrderNumber: 1, priority: e.api.cond({}) } }, { feature: 'bulkOps', ids: { wo: 1 } })
    .then(function () {}, function () { gateRefused = true; });
  await tick();
  A.ok('gate: an UNCONFIRMED patchWorkOrder is refused', gateRefused);
  A.eq('gate: nothing sent on the refusal', patchCalls(e.gql).length, 0);
  A.eq('gate: audit outcome denied', (e.api.auditAll()[0] || {}).outcome, 'denied');

  // =========================================================================================
  // F4-DEEP: the bulk high-risk path is authorized ONLY by the ARMED per-batch confirm handler.
  // A bare confirmed:true is never used; without arming, a high-risk bulk write is REFUSED.
  // =========================================================================================
  // (a) NOT armed -> bulkExecEcd is refused (the confirm handler is the gate, not a literal).
  e = makeEnv();
  var ecdUnarmed = false;
  await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01', 'r', 'T').then(function () {}, function () { ecdUnarmed = true; });
  await tick();
  A.ok('F4-deep: an UNARMED bulkExecEcd is refused', ecdUnarmed);
  A.eq('F4-deep: nothing sent when unarmed', patchCalls(e.gql).length, 0);
  // (b) armed for THIS runId + WO + reason -> it sends.
  e = makeEnv();
  e.api.armBatchConfirm('RUN1', [200], 'r');
  await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01', 'r', 'T');
  await tick();
  A.eq('F4-deep: an ARMED bulkExecEcd DOES send', patchCalls(e.gql).length, 1);
  e.api.disarmBatchConfirm();
  // (c) armed for a DIFFERENT WO -> the write for a WO outside the cohort is refused.
  e = makeEnv();
  e.api.armBatchConfirm('RUN1', [999], 'r');
  var offCohort = false;
  await e.api.bulkExecStatus('run', 'RUN1', '200', 7, 'r', 'T').then(function () {}, function () { offCohort = true; });
  await tick();
  A.ok('F4-deep: a WO OUTSIDE the armed cohort is refused', offCohort);
  A.eq('F4-deep: nothing sent for the off-cohort WO', patchCalls(e.gql).length, 0);
  e.api.disarmBatchConfirm();
  // (d) armed but reason MISSING at the write -> refused (reason is mandatory in the handler).
  e = makeEnv();
  e.api.armBatchConfirm('RUN1', [200], 'r');
  var noReason = false;
  await e.api.bulkExecStatus('run', 'RUN1', '200', 7, '', '').then(function () {}, function () { noReason = true; });
  await tick();
  A.ok('F4-deep: a high-risk write with NO reason is refused even when armed', noReason);
  e.api.disarmBatchConfirm();
  // (e) disarm actually tears the handler down: setConfirm(null) -> a later high-risk write is refused.
  e = makeEnv();
  e.api.armBatchConfirm('RUN1', [200], 'r');
  e.api.disarmBatchConfirm();
  var afterDisarm = false;
  await e.api.bulkExecStatus('run', 'RUN1', '200', 7, 'r', 'T').then(function () {}, function () { afterDisarm = true; });
  await tick();
  A.ok('F4-deep: after disarm, a high-risk write is refused (setConfirm(null) is load-bearing)', afterDisarm);
  A.ok('F4-deep: bulkConfirmHandler denies when nothing is armed', e.api.bulkConfirmHandler({ risk: 'high', ids: { wo: 200 }, reason: 'r' }) === false);

  // ---- success:false envelope rejects (never a silent false) ------------------------------
  e = makeEnv({ patchFail: true });
  e.api.armBatchConfirm('RUN1', [200], 'r');
  var envRejected = false;
  await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01', 'r', 'T').then(function () {}, function () { envRejected = true; });
  await tick();
  A.ok('a patchWorkOrder success:false rejects', envRejected);
  e.api.disarmBatchConfirm();

  // ---- runPool cancel semantics carry over (holes, not errors) ----------------------------
  e = makeEnv();
  var settled = 0;
  var pool = await e.api.runPool([1, 2, 3, 4, 5], function () { settled++; return Promise.resolve({ outcome: 'done' }); }, 1, null, function () { return settled >= 2; });
  A.ok('runPool: cancel leaves later rows as HOLES', pool[2] === undefined && pool[3] === undefined && pool[4] === undefined);
  A.eq('runPool: the tally counts the holes as not-run', e.api.bulkTally(pool, 5), { done: 2, noop: 0, failed: 0, notRun: 3 });

  // =========================================================================================
  // NEGATIVE CONTROLS - each guarantee must be observably load-bearing.
  // =========================================================================================

  // (1) Drop a priority sibling -> the "every sibling" assertion goes red.
  await (async function () {
    var mut = mutate(S_ENG, 'skipWeekends: !!p.skipWeekends\n      };', 'skipWeekendsDROPPED: !!p.skipWeekends\n      };');
    var m = makeEnv({}, mut);
    m.api.armBatchConfirm('RUN1', [200], 'r');
    await m.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01', 'r', 'T');
    await tick();
    var d = patchCalls(m.gql)[0].v.data;
    A.ok('CONTROL: dropping a priority sibling blanks it (whole-object assertion is load-bearing)', !('skipWeekends' in d.priority.value));
  })();

  // (2) Wrong note type -> the "type 13" assertion goes red.
  await (async function () {
    var mut = mutate(S_ENG, 'type: INTERNAL_NOTE_TYPE, content: marked', 'type: 999, content: marked');
    var m = makeEnv({ notes: [] }, mut);
    await m.api.bulkExecNote('run', 'RUN1', '100', 'x');
    await tick();
    A.eq('CONTROL: a wrong note type IS observable (type assertion is load-bearing)', notePosts(m.gql)[0].v.addEditInput.type, 999);
  })();

  // (3) A dry-run that accidentally writes -> the "zero writes" assertion goes red.
  await (async function () {
    var mut = mutate(S_ENG, "if (mode === 'dry') return { op: 'note', wo: wo, outcome: 'would-send'", "if (false) return { op: 'note', wo: wo, outcome: 'would-send'");
    var m = makeEnv({ notes: [] }, mut);
    await m.api.bulkExecNote('dry', 'DRY', '100', 'x');
    await tick();
    A.eq('CONTROL: neutering the dry gate DOES write (the dry gate is load-bearing)', notePosts(m.gql).length, 1);
  })();

  // (4) Neuter the note no-op pre-check -> a re-run double-posts over its own marker.
  await (async function () {
    var mut = mutate(S_ENG, 'if (noteHasMarker(notes, idemKey)) return { op: \'note\', wo: wo, outcome: \'noop\'', 'if (false) return { op: \'note\', wo: wo, outcome: \'noop\'');
    var m = makeEnv({ notes: [{ content: '[bwn:RUN1:100]', isDeleted: false }] }, mut);
    await m.api.bulkExecNote('run', 'RUN1', '100', 'x');
    await tick();
    A.eq('CONTROL: disabling the marker check DOES double-post (dedup is load-bearing)', notePosts(m.gql).length, 1);
  })();

  // =========================================================================================
  // CONVERGED OPS v2: status / assign (HIGH, armed) · escalation task / doc-request (moderate)
  // =========================================================================================

  // ---- SET-STATUS (armed): statusId ALONE, coerced to Int; no-op when already at target -----
  e = makeEnv();   // DEFAULT_WO statusId 41
  e.api.armBatchConfirm('RS', [200], 'move to In Progress');
  var rS = await e.api.bulkExecStatus('run', 'RS', '200', 7, 'move to In Progress', 'JIRA-9');
  await tick();
  A.eq('set-status: outcome done', rS.outcome, 'done');
  A.eq('set-status: exactly one patch', patchCalls(e.gql).length, 1);
  var sdata = patchCalls(e.gql)[0].v.data;
  A.eq('set-status: data keys are workOrderNumber + statusId ONLY (siblings blank otherwise)', Object.keys(sdata).sort(), ['statusId', 'workOrderNumber']);
  A.eq('set-status: statusId is a ConditionalInput with an INT value', sdata.statusId, { shouldInclude: true, value: 7 });
  A.eq('set-status: audit after carries statusId + runId + reason + ref', [(e.api.auditAll()[0] || {}).after.statusId, (e.api.auditAll()[0] || {}).after.runId, (e.api.auditAll()[0] || {}).after.reason, (e.api.auditAll()[0] || {}).after.ref], [7, 'RS', 'move to In Progress', 'JIRA-9']);
  e.api.disarmBatchConfirm();
  // no-op: already at the target status -> no patch (even armed)
  e = makeEnv();
  e.api.armBatchConfirm('RS', [200], 'r');
  var rSnoop = await e.api.bulkExecStatus('run', 'RS', '200', 41, 'r', 'T');   // 41 == DEFAULT_WO.statusId
  await tick();
  A.eq('set-status no-op: already at target -> no-op', rSnoop.outcome, 'noop');
  A.eq('set-status no-op: NO patch sent', patchCalls(e.gql).length, 0);
  e.api.disarmBatchConfirm();

  // ---- REASSIGN (armed): assignedTo ALONE ---------------------------------------------------
  e = makeEnv();   // DEFAULT_WO assignedTo 'g'
  e.api.armBatchConfirm('RA', [200], 'load balance');
  var rA = await e.api.bulkExecAssign('run', 'RA', '200', 'user-guid-2', 'load balance', 'REF-2');
  await tick();
  A.eq('reassign: outcome done', rA.outcome, 'done');
  var adata = patchCalls(e.gql)[0].v.data;
  A.eq('reassign: data keys are workOrderNumber + assignedTo ONLY', Object.keys(adata).sort(), ['assignedTo', 'workOrderNumber']);
  A.eq('reassign: assignedTo is a ConditionalInput with the GUID (not coerced)', adata.assignedTo, { shouldInclude: true, value: 'user-guid-2' });
  e.api.disarmBatchConfirm();
  // no-op: already assigned to the same user
  e = makeEnv();
  e.api.armBatchConfirm('RA', [200], 'r');
  var rAnoop = await e.api.bulkExecAssign('run', 'RA', '200', 'g', 'r', 'T');   // 'g' == DEFAULT_WO.assignedTo
  await tick();
  A.eq('reassign no-op: already assigned -> no-op, no patch', [rAnoop.outcome, patchCalls(e.gql).length], ['noop', 0]);
  e.api.disarmBatchConfirm();

  // ---- ESCALATION TASK (moderate, addTask - NO confirm gate) ---------------------------------
  e = makeEnv();
  var rT = await e.api.bulkExecTask('run', 'RT', '200', 'Escalate: vendor unresponsive 48h');
  await tick();
  A.eq('task: outcome done', rT.outcome, 'done');
  A.eq('task: exactly one addTask, no confirm needed (moderate)', taskPosts(e.gql).length, 1);
  var tvars = taskPosts(e.gql)[0].v.data;
  A.eq('task: entityType 1 (work order)', tvars.entityType, 1);
  A.eq('task: entityId is the WO number as a String', tvars.entityId, '200');
  A.ok('task: description carries the [bwn:RT:200] run marker', tvars.description.indexOf('[bwn:RT:200]') !== -1);
  A.eq('task: metadata carries the number', JSON.parse(tvars.metadata).number, '200');
  A.eq('task: audit after.task is clamped, plus runId', [(e.api.auditAll()[0] || {}).after.runId, (e.api.auditAll()[0] || {}).outcome], ['RT', 'ok']);

  // ---- REQUEST-MISSING-DOCS (moderate, addEditJobNote; op relabelled to docreq) --------------
  e = makeEnv({ notes: [] });
  var rD = await e.api.bulkExecDocReq('run', 'RD', '200', 'W-9 + COI');
  await tick();
  A.eq('docreq: op relabelled to docreq (for the run-log)', rD.op, 'docreq');
  A.eq('docreq: one addEditJobNote (it IS a note write)', notePosts(e.gql).length, 1);
  A.ok('docreq: the canned prefix is in the body', notePosts(e.gql)[0].v.addEditInput.content.indexOf('Document request:') !== -1);
  A.ok('docreq: the operator context is appended', notePosts(e.gql)[0].v.addEditInput.content.indexOf('W-9 + COI') !== -1);
  A.eq('docreq: audit after carries noteType only (body NEVER audited)', (e.api.auditAll()[0] || {}).after, { noteType: 13 });

  // ---- caps for the new ops (risk-tiered) ---------------------------------------------------
  A.eq('status cap is the tight 25 (high risk)', e.api.capForOp('status'), 25);
  A.eq('assign cap is 25 (high risk)', e.api.capForOp('assign'), 25);
  A.eq('task cap is 50 (moderate)', e.api.capForOp('task'), 50);
  A.eq('docreq cap is 50 (moderate)', e.api.capForOp('docreq'), 50);
  A.eq('status over cap REFUSED not truncated', e.api.overCap('status', 26), { refused: true, cap: 25, count: 26, over: 1 });

  // =========================================================================================
  // ADVISORY APPROVAL GATE (fail-closed, rank-based). PURE - driven with an injected rank.
  // =========================================================================================
  A.ok('approval: unknown rank denies EVERY op (deny-for-all, fail-closed)', e.api.approvalDecision('note', 5, null).allowed === false && e.api.approvalDecision('status', 5, null).allowed === false);
  A.eq('approval: unknown-rank reason is explicit', e.api.approvalDecision('note', 5, null).reason, 'rank-unknown');
  A.ok('approval: coordinator (1) may add a note', e.api.approvalDecision('note', 5, 1).allowed);
  A.ok('approval: coordinator (1) may NOT set status (needs supervisor)', e.api.approvalDecision('status', 5, 1).allowed === false);
  A.ok('approval: supervisor (3) may reassign + set status (small batch)', e.api.approvalDecision('assign', 5, 3).allowed && e.api.approvalDecision('status', 5, 3).allowed);
  A.ok('approval: a LARGE high-risk batch needs a manager', e.api.approvalDecision('status', 15, 3).allowed === false && e.api.approvalDecision('status', 15, 5).allowed);
  A.eq('approval: the large-batch denial names the manager bar', e.api.approvalDecision('status', 15, 3).needLabel, 'manager');

  // ---- undo-eligibility labels: NEVER a bare "undo available" -------------------------------
  A.ok('undo: status label names the non-reversible CLOCK', e.api.undoLabelFor('status').indexOf('NON-reversible CLOCK') !== -1);
  A.ok('undo: ECD label names the non-reversible CLOCK', e.api.undoLabelFor('ecd').indexOf('NON-reversible CLOCK') !== -1);
  A.ok('undo: no label is a bare "undo available"', e.api.undoLabelFor('status').toLowerCase().indexOf('undo available') === -1 && e.api.undoLabelFor('ecd').toLowerCase().indexOf('undo available') === -1);

  // =========================================================================================
  // KILL SWITCH MID-BATCH (item 9): a live BWN_MODULES flip halts the in-flight batch.
  // =========================================================================================
  A.ok('kill: bulkOps:false halts', e.api.bulkModuleKilled({ bulkOps: false }, false) === true);
  A.ok('kill: bulkOps:true does not halt', e.api.bulkModuleKilled({ bulkOps: true }, false) === false);
  A.ok('kill: a destructive op ALSO halts on bulkOpsDestructive:false', e.api.bulkModuleKilled({ bulkOps: true, bulkOpsDestructive: false }, true) === true);
  A.ok('kill: a moderate op is unaffected by bulkOpsDestructive', e.api.bulkModuleKilled({ bulkOps: true, bulkOpsDestructive: false }, false) === false);
  // Drive the real runPool with a kill flip mid-batch: rows after the flip are left as HOLES.
  e = makeEnv();
  var mods = { bulkOps: true };
  var seen = 0;
  var killPool = await e.api.runPool([1, 2, 3, 4, 5], function () { seen++; if (seen === 2) mods.bulkOps = false; return Promise.resolve({ outcome: 'done' }); }, 1, null, function () { return e.api.bulkModuleKilled(mods, false); });
  A.ok('kill mid-batch: rows after the flip are not-run (holes), not written', killPool[3] === undefined && killPool[4] === undefined);
  A.eq('kill mid-batch: tally counts the halted rows as not-run', e.api.bulkTally(killPool, 5).notRun >= 2, true);

  // =========================================================================================
  // PII: the note/task BODY never reaches the audit ring; the export projection drops annotations.
  // =========================================================================================
  e = makeEnv({ notes: [] });
  await e.api.bulkExecNote('run', 'RP', '200', 'CLIENT PHONE 555-0000 do-not-leak');
  await tick();
  A.ok('PII: a note BODY never appears in the audit ring', JSON.stringify(e.api.auditAll()).indexOf('555-0000') === -1 && JSON.stringify(e.api.auditAll()).indexOf('do-not-leak') === -1);
  e = makeEnv();
  await e.api.bulkExecTask('run', 'RP', '200', 'x'.repeat(200) + ' SECRETTAIL');   // long body
  await tick();
  A.ok('PII: the task run-marker + overflow body never reach the audit (after.task clamped <= 40)', (e.api.auditAll()[0] || {}).after.task.length <= 40 && JSON.stringify(e.api.auditAll()).indexOf('SECRETTAIL') === -1 && JSON.stringify(e.api.auditAll()).indexOf('[bwn:RP:200]') === -1);
  // export projection: bulkScalar returns the lone VALUE scalar, dropping runId/reason/ref annotations
  var DROP = { runId: true, reason: true, ref: true, task: true, noteType: true, hasMarker: true };
  A.eq('export: bulkScalar flattens {statusId} to its scalar', e.api.bulkScalar({ statusId: 7, runId: 'R', reason: 'secret reason', ref: 'T' }, DROP), 7);
  A.eq('export: bulkScalar NEVER returns the reason/ref annotations', e.api.bulkScalar({ reason: 'secret reason', ref: 'T', runId: 'R' }, DROP), null);
  A.eq('export: a note projection is null (body/type never a value scalar)', e.api.bulkScalar({ noteType: 13, runId: 'R' }, DROP), null);

  // =========================================================================================
  // NEGATIVE CONTROLS for the converged path - each guarantee observably load-bearing.
  // =========================================================================================

  // (5) F4-DEEP: re-introduce a bare confirmed:true into the patch path -> an UNARMED status write
  //     now sends. Proves the ABSENCE of confirmed:true + the armed handler are load-bearing.
  await (async function () {
    // Target is unique to bulkExecPatch (its validate opens with the BWN_MODULES bulkOpsDestructive
    // re-check); inserting confirmed:true into its opts lets an UNARMED destructive write through.
    var mut = mutate(S_ENG,
      "feature: 'bulkOps', ids: { wo: wo }, reason: clampReason(reason),\n          validate: function (v) {\n            if (typeof BWN_MODULES",
      "feature: 'bulkOps', confirmed: true, ids: { wo: wo }, reason: clampReason(reason),\n          validate: function (v) {\n            if (typeof BWN_MODULES");
    var m = makeEnv({}, mut);   // NOTE: no armBatchConfirm here
    await m.api.bulkExecStatus('run', 'RS', '200', 7, 'r', 'T');
    await tick();
    A.eq('CONTROL: a bare confirmed:true lets an UNARMED high-risk write through (its absence is load-bearing)', patchCalls(m.gql).length, 1);
  })();

  // (6) Neuter the status no-op precheck -> a same-value write is sent (the precheck is load-bearing).
  await (async function () {
    var mut = mutate(S_ENG, "var same = String(cur == null ? '' : cur) === String(newValue == null ? '' : newValue);", "var same = false;");
    var m = makeEnv({}, mut);
    m.api.armBatchConfirm('RS', [200], 'r');
    await m.api.bulkExecStatus('run', 'RS', '200', 41, 'r', 'T');   // 41 == current; should have been a no-op
    await tick();
    A.eq('CONTROL: neutering the no-op precheck writes a same-value patch (precheck is load-bearing)', patchCalls(m.gql).length, 1);
  })();

  // =========================================================================================
  // F1: a mid-batch bulkOpsDestructive kill DENIES a not-yet-dispatched destructive write at send.
  // The destructive execs pass feature:'bulkOps' (so the WRAP feature-check watches bulkOps, not
  // bulkOpsDestructive); their validate() re-reads bulkOpsDestructive so a row not yet past validate
  // is blocked before the network call.
  // =========================================================================================
  e = makeEnv({ modules: { bulkOps: true, bulkOpsDestructive: false } });
  e.api.armBatchConfirm('RF1', [200], 'r');
  var f1Denied = false;
  await e.api.bulkExecStatus('run', 'RF1', '200', 7, 'r', 'T').then(function () {}, function () { f1Denied = true; });
  await tick();
  A.ok('F1: a destructive write is DENIED when bulkOpsDestructive is off (validate blocks at send)', f1Denied);
  A.eq('F1: nothing sent on the destructive-kill denial', patchCalls(e.gql).length, 0);
  A.eq('F1: audit records the validation denial', (e.api.auditAll()[0] || {}).outcome, 'denied');
  e.api.disarmBatchConfirm();
  // assign is denied the same way (both destructive execs share bulkExecPatch's validate)
  var eA = makeEnv({ modules: { bulkOps: true, bulkOpsDestructive: false } });
  eA.api.armBatchConfirm('RF1', [200], 'r');
  var f1AssignDenied = false;
  await eA.api.bulkExecAssign('run', 'RF1', '200', 'g2', 'r', 'T').then(function () {}, function () { f1AssignDenied = true; });
  await tick();
  A.ok('F1: reassign is denied the same way (shared validate)', f1AssignDenied && patchCalls(eA.gql).length === 0);
  eA.api.disarmBatchConfirm();
  // control: with bulkOpsDestructive ON (armed), the SAME status write DOES send - the validate gate is load-bearing.
  e = makeEnv({ modules: { bulkOps: true, bulkOpsDestructive: true } });
  e.api.armBatchConfirm('RF1', [200], 'r');
  await e.api.bulkExecStatus('run', 'RF1', '200', 7, 'r', 'T');
  await tick();
  A.eq('F1 control: with bulkOpsDestructive ON, the destructive write sends (gate is load-bearing)', patchCalls(e.gql).length, 1);
  e.api.disarmBatchConfirm();

  // =========================================================================================
  // F2: withArmedBatch ALWAYS disarms - a sync throw AND a rejected promise both restore
  // setConfirm(null), so a failed/wedged run never leaks a live arm.
  // =========================================================================================
  e = makeEnv();
  var f2Threw = false;
  await e.api.withArmedBatch('RF2', [200], 'r', function () { throw new Error('boom in body'); }).then(function () {}, function () { f2Threw = true; });
  A.ok('F2: a SYNC throw in the batch body still disarms', f2Threw && e.api.batchArmed() === false);
  var f2Refused = false;
  await e.api.bulkExecStatus('run', 'RF2', '200', 7, 'r', 'T').then(function () {}, function () { f2Refused = true; });
  await tick();
  A.ok('F2: after a thrown body, a high-risk write is refused again (setConfirm back to null)', f2Refused);
  // a REJECTED promise body also disarms
  e = makeEnv();
  await e.api.withArmedBatch('RF2', [200], 'r', function () { return Promise.reject(new Error('rejected body')); }).then(function () {}, function () {});
  A.ok('F2: a REJECTED batch body also disarms', e.api.batchArmed() === false);
  // the happy path still disarms + propagates the body's value
  e = makeEnv();
  var f2Val = await e.api.withArmedBatch('RF2', [200], 'r', function () { return Promise.resolve('ok-value'); });
  A.ok('F2: a resolved body disarms AND propagates its value', f2Val === 'ok-value' && e.api.batchArmed() === false);

  // =========================================================================================
  // F3: a destructive verb cannot be ARMED while bulkOpsDestructive is off (pre-Approve gate).
  // =========================================================================================
  A.ok('F3: status is arm-blocked when bulkOpsDestructive is off', e.api.destructiveArmBlocked('status', { bulkOpsDestructive: false }) === true);
  A.ok('F3: assign is arm-blocked when bulkOpsDestructive is off', e.api.destructiveArmBlocked('assign', { bulkOpsDestructive: false }) === true);
  A.ok('F3: status is NOT blocked when bulkOpsDestructive is on', e.api.destructiveArmBlocked('status', { bulkOpsDestructive: true }) === false);
  A.ok('F3: ECD is NOT destructive-arm-blocked (it rides bulkOps alone, not the second flag)', e.api.destructiveArmBlocked('ecd', { bulkOpsDestructive: false }) === false);
  A.ok('F3: a moderate op (note) is never destructive-arm-blocked', e.api.destructiveArmBlocked('note', { bulkOpsDestructive: false }) === false);

  A.finish();
})().catch(function (e) { console.error('\nHARNESS ERROR:', e && e.stack || e); process.exit(2); });
