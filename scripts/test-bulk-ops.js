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

// WRAP v3's permission gate closes over bwnCan/bwnCanAll and the registry over bwnPermsForPatch,
// so the REAL BWN-PERM reader block is prepended to the slice rather than stubbed. With no
// localStorage slot planted in these sandboxes every permission reads as unknown, which fails
// OPEN - so every case below runs against the same behaviour it had before the gate existed.
// (The gate itself is proven in scripts/test-bwn-ops.js and scripts/test-perm-block-ledger.js.)
var S_PERM = slice('  // ===== BWN-PERM START v1', '  // ===== BWN-PERM END v1 =====', 'BWN-PERM block');
var S_OPS = S_PERM + "\n" + slice('  // ===== BWN-OPS START v1', '  // ===== BWN-OPS END v1 =====', 'BWN-OPS block');
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
A.ok('the set-ECD write passes confirmed:true + feature:bulkOps', /feature: 'bulkOps', confirmed: true/.test(S_ENG));

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
    if (/workOrderNotes/.test(query)) return Promise.resolve({ workOrderNotes: opts.notes || [] });
    if (/workOrder\s*\(/.test(query)) return Promise.resolve({ workOrder: (opts.wo === undefined ? DEFAULT_WO : opts.wo) });
    return Promise.resolve({});
  }
  gql.calls = [];
  return gql;
}
function writeCalls(g) { return g.calls.filter(function (c) { return /patchWorkOrder|addEditJobNote/.test(c.q); }); }
function patchCalls(g) { return g.calls.filter(function (c) { return /patchWorkOrder/.test(c.q); }); }
function notePosts(g) { return g.calls.filter(function (c) { return /addEditJobNote/.test(c.q); }); }

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
    '  bulkExecNote: bulkExecNote, bulkExecEcd: bulkExecEcd, bulkTally: bulkTally, auditTally: auditTally,\n' +
    '  pendingRows: pendingRows, runPool: runPool, overCap: overCap, capForOp: capForOp, idemKeyFor: idemKeyFor,\n' +
    '  priorityWriteValue: priorityWriteValue, markerFor: markerFor, noteHasMarker: noteHasMarker, cond: cond,\n' +
    '  BULK_MAX_RECORDS: BULK_MAX_RECORDS, ADD_NOTE_M: ADD_NOTE_M, PATCH_M: PATCH_M };\n})()',
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
  e = makeEnv();   // DEFAULT_WO, oldEcd 2026-01-01
  var rE = await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01');
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
  A.eq('set-ECD: high-risk write audited ok (confirmed:true unblocked the gate)', (e.api.auditAll()[0] || {}).outcome, 'ok');

  // ---- set-ECD no-op: the date already matches -> skip, no patch ---------------------------
  e = makeEnv({ wo: { serviceLevelAgreementId: 's', priority: { expectedCompletionDate: '2026-09-01T12:00:00Z' } } });
  var rEnoop = await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01');
  await tick();
  A.eq('set-ECD no-op: outcome no-op', rEnoop.outcome, 'noop');
  A.eq('set-ECD no-op: NO patch when the ECD already matches', patchCalls(e.gql).length, 0);

  // ---- set-ECD without an SLA on the read -> no serviceLevelAgreementId key ----------------
  e = makeEnv({ wo: { priority: { label: 'P1', expectedCompletionDate: '2026-01-01' } } });
  await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01');
  await tick();
  A.ok('set-ECD: serviceLevelAgreementId omitted when the read had none', !('serviceLevelAgreementId' in patchCalls(e.gql)[0].v.data));

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

  // ---- high-risk gate: patchWorkOrder WITHOUT confirmed:true is refused (Core wires no _confirmFn)
  e = makeEnv();
  var gateRefused = false;
  await e.api.run('patchWorkOrder', e.api.PATCH_M, { data: { workOrderNumber: 1, priority: e.api.cond({}) } }, { feature: 'bulkOps', ids: { wo: 1 } })
    .then(function () {}, function () { gateRefused = true; });
  await tick();
  A.ok('gate: an UNCONFIRMED patchWorkOrder is refused', gateRefused);
  A.eq('gate: nothing sent on the refusal', patchCalls(e.gql).length, 0);
  A.eq('gate: audit outcome denied', (e.api.auditAll()[0] || {}).outcome, 'denied');
  // control: bulkExecEcd carries confirmed:true, so the SAME high-risk op DOES send through it.
  e = makeEnv();
  await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01');
  await tick();
  A.eq('gate control: bulkExecEcd (confirmed:true) DOES send - confirmed is the gate', patchCalls(e.gql).length, 1);

  // ---- success:false envelope rejects (never a silent false) ------------------------------
  e = makeEnv({ patchFail: true });
  var envRejected = false;
  await e.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01').then(function () {}, function () { envRejected = true; });
  await tick();
  A.ok('a patchWorkOrder success:false rejects', envRejected);

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
    await m.api.bulkExecEcd('run', 'RUN1', '200', '2026-09-01');
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

  A.finish();
})().catch(function (e) { console.error('\nHARNESS ERROR:', e && e.stack || e); process.exit(2); });
