// test-bulk-task.js - the Bulk Task Reassign engine (Core module, flag bulkTask, ships OFF).
//
// WHAT THIS PROVES, against the REAL shipped bytes of bwn-suite-core.user.js: the BULK-TASK-ENGINE
// region (pure, DOM-free) is sliced out and CONCATENATED with the real BWN-PERM + BWN-OPS regions,
// then run in a vm with a programmable bwnGql transport that models Umbrava's task store - so every
// EditTask goes through the real bwnGqlOp (feature kill switch, high-risk confirm gate, audit ring).
//
//   parsing        newline / comma / space / semicolon; W- prefix; trim; dedupe; invalid; ambiguous.
//   preview        not found / ambiguous / read failure / short page / no open task / already
//                  assigned / missing full-replace field / no target / Reassign - and ZERO EditTask.
//   binding        the stamp moves with the WO list, the target and each row's snapshot; APPLY n
//                  arms only on an exact match.
//   payload        EditTask is a FULL REPLACE (live capture 2026-09-29): exact description (trailing
//                  space kept) and metadata, SPA ISO date, assignedTo the ONLY change, categoryId
//                  OMITTED when absent (never null), kept when present, captured key order.
//   execution      fresh re-read before each write; a row that moved since preview is skipped with
//                  no write; a failed write is never retried; later rows still run; strictly serial.
//   read-back      success ONLY when the re-read shows the target AND every protected field
//                  unchanged; a mismatch, a no-op write, a failed read-back, or a write that errored
//                  are never labelled success.
//   flag           ships OFF; with the module flag off the wrapper refuses and nothing is sent.
//
// Every guarantee carries a negative control: a mutated copy of the same source that MUST turn a
// check red (mutate() throws if its target is absent or not unique).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bulk-task.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var coreFull = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');
function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return coreFull.slice(a, b + end.length);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}
var S_OPS = slice('  // ===== BWN-PERM START v1', '  // ===== BWN-PERM END v1 =====', 'BWN-PERM') + '\n' +
  slice('  // ===== BWN-OPS START v1', '  // ===== BWN-OPS END v1 =====', 'BWN-OPS');
var S_ENG = slice('    // ===== BULK-TASK-ENGINE START v1', '    // ===== BULK-TASK-ENGINE END v1 =====', 'BULK-TASK-ENGINE');

// ---- task store + programmable transport ------------------------------------------------------
var TARGET = 'aaaaaaaa-0000-0000-0000-00000000000t', OTHER = 'bbbbbbbb-0000-0000-0000-00000000000o';
function T(o) {
  return Object.assign({ id: 'task-1', entityId: '397888', entityType: 1, description: 'Please review both options ',
    targetStartDate: '2026-09-28T23:45:00+00:00', assignedTo: OTHER,
    metadata: '{"number":"397888","purchaseOrderNumber":"1","formattedPurchaseOrderNumber":"W-397888-001","vendorName":"X"}',
    categoryId: null, isComplete: false, flag: false, priorityStatus: 0 }, o || {});
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }
// opts: { store:{wo:[tasks]}, notFound:[wo], woReadFail:[wo], ambiguous:[wo], shortPage:[wo],
//         edit: 'apply'|'refuse'|'throw'|'applyAndThrow'|'corrupt'|'noop',
//         failReadsAfterEdit: true, onRead: fn(wo, readNo, store) }
function mkGql(opts) {
  var store = clone(opts.store || {}), wos = clone(opts.wos || {}), reads = 0;
  function gql(query, variables) {
    gql.calls.push({ q: query, v: clone(variables || {}) });
    if (/mutation EditTask/.test(query)) {
      gql.edits++;
      var d = variables.data, list = store[d.entityId] || [], hit = list.filter(function (t) { return t.id === d.id; })[0];
      var mode = opts.edit || 'apply';
      if (mode === 'throw') return Promise.reject(new Error('Failed to fetch'));
      if (mode === 'refuse') return Promise.resolve({ editTask: { success: false, message: 'nope' } });
      if (hit && mode !== 'noop') {
        hit.assignedTo = d.assignedTo;
        if (mode === 'corrupt') hit.description = '';
      }
      if (mode === 'applyAndThrow') return Promise.reject(new Error('Failed to fetch'));
      return Promise.resolve({ editTask: { success: true, message: '' } });
    }
    if (/mutation PatchWorkOrder/.test(query)) {
      gql.patches++;
      var pd = variables.data, rec = wos[pd.workOrderNumber], pm = opts.patch || 'apply';
      if (pm === 'throw') return Promise.reject(new Error('Failed to fetch'));
      if (pm === 'refuse') return Promise.resolve({ patchWorkOrder: { success: false, message: 'nope' } });
      if (rec && pm !== 'noop') { rec.assignedTo = pd.assignedTo.value; if (pm === 'statusToo') rec.statusId = 99; }
      return Promise.resolve({ patchWorkOrder: { success: true, message: '' } });
    }
    if (/query BTWorkOrder/.test(query)) {
      var n = variables.n;
      if ((opts.notFound || []).indexOf(n) !== -1) return Promise.reject(new Error('Cannot return null for non-nullable field Query.workOrder.'));
      if ((opts.woReadFail || []).indexOf(n) !== -1) return Promise.reject(new Error('Not authorized'));
      if (opts.failWoReadsAfterPatch && gql.patches > 0) return Promise.reject(new Error('Failed to fetch'));
      var w = wos[n] || { assignedTo: null, statusId: 1 };
      return Promise.resolve({ workOrder: { number: (opts.ambiguous || []).indexOf(n) !== -1 ? n + 1 : n, assignedTo: w.assignedTo, statusId: w.statusId } });
    }
    if (/query BTOpenTasks/.test(query)) {
      reads++;
      var wo = variables.id;
      if (opts.onRead) opts.onRead(wo, reads, store);
      if (opts.failReadsAfterEdit && gql.edits > 0) return Promise.reject(new Error('Failed to fetch'));
      var open = (store[wo] || []).filter(function (t) { return !t.isComplete; });
      var total = open.length + ((opts.shortPage || []).indexOf(Number(wo)) !== -1 ? 5 : 0);
      return Promise.resolve({ tasksByEntityTypeAndId: { total: total, tasks: clone(open) } });
    }
    return Promise.resolve({});
  }
  gql.calls = []; gql.edits = 0; gql.patches = 0; gql.store = store; gql.wos = wos;
  return gql;
}
function makeEnv(opts, engSrc) {
  opts = opts || {};
  var ls = Object.create(null), gql = mkGql(opts);
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, JSON: JSON, RegExp: RegExp,
    Promise: Promise, Error: Error, Math: Math, Date: Date, console: console, parseInt: parseInt, isFinite: isFinite,
    window: {}, setTimeout: function (fn) { return setTimeout(fn, 0); },
    localStorage: { getItem: function (k) { return (k in ls) ? ls[k] : null; }, setItem: function (k, v) { ls[k] = String(v); }, removeItem: function (k) { delete ls[k]; } },
    BWN_VER: '0.0.0-test', BWN_MODULES: opts.modules || { bulkTask: true }, bwnGql: gql
  };
  vm.createContext(sandbox);
  // 'use strict' like Core's IIFE: sloppy mode silently swallows writes that throw in the real page
  // (a smoke run caught btParse assigning a property onto a string that this harness had missed).
  var api = vm.runInContext('(function () {\n"use strict";\n' + S_OPS + '\n' + (engSrc || S_ENG) + '\n' +
    'return { btParse: btParse, btMissing: btMissing, btSameProtected: btSameProtected, btPayload: btPayload, btStamp: btStamp,\n' +
    '  btConfirmArmed: btConfirmArmed, btReadWO: btReadWO, btRowsFor: btRowsFor, btExecRow: btExecRow,\n' +
    '  btRunSequential: btRunSequential, btSummary: btSummary, audit: bwnAuditAll, BT_MAX_WOS: BT_MAX_WOS };\n})()',
    sandbox, { filename: 'bulk-task.js' });
  return { api: api, gql: gql };
}
function previewRow(env, wo) { return env.api.btReadWO(wo).then(function (res) { return env.api.btRowsFor(wo, res, TARGET); }); }

(async function () {
  // ---- ship safety (source level) ------------------------------------------------------------
  A.ok('engine slice is DOM-free', !/\bdocument\b|\bwindow\b|querySelector/.test(S_ENG));
  A.ok('bulkTask flag ships OFF', /\n    bulkTask: false,/.test(coreFull));
  A.ok('the whole module mounts only behind BWN_MODULES.bulkTask', /bwnBoot\('bulkTask', BWN_MODULES\.bulkTask, function \(\) \{/.test(coreFull));
  A.ok('editTask is registered high-risk, non-idempotent, never retried, gated on Task.EditTask',
    /editTask: \{ kind: 'write', perm: 'Task\.EditTask', target: 'task', risk: 'high', idempotent: false, retry: 'none',/.test(coreFull));
  A.ok('the only EditTask call-site is the engine, with feature:bulkTask', (coreFull.match(/bwnGqlOp\('editTask'/g) || []).length === 1 && /feature: 'bulkTask', confirmed: true/.test(S_ENG));
  A.ok('the mutation document is the captured EditTask(data: EditTaskInput!)', /mutation EditTask\(\$data: EditTaskInput!\) \{ editTask\(data: \$data\)/.test(S_ENG));
  A.ok('no task-create / complete / flag write anywhere in the engine', !/addTask|completeTask|completeAllTasks|flagTask/.test(S_ENG));
  A.ok('the one patchWorkOrder call-site pins the payload to exactly { workOrderNumber, assignedTo }',
    (S_ENG.match(/bwnGqlOp\('patchWorkOrder'/g) || []).length === 1 && /Object\.keys\(d\)\.join\(','\) !== 'workOrderNumber,assignedTo'\) return 'only assignedTo may be sent';/.test(S_ENG));
  A.ok('the picker reads people AND teams (searchMembers BOTH), not the users-only directory', /searchMembers\(searchType: BOTH/.test(S_ENG) && !/users\(includeInactiveUsers/.test(coreFull.slice(coreFull.indexOf('MODULE: Bulk Task Reassign'))));
  A.ok('drawer mount is idempotent (returns if already open)', /if \(document\.getElementById\('bwn-bt-drawer'\)\) return;   \/\/ idempotent mount/.test(coreFull));
  A.ok('dock row is policy-gated at rank 4 + Task.EditTask', /BWN_DOCK_POLICY\['bulk-task'\]\s+= \{ minRank: 4, perms: \['Task\.EditTask'\] \}/.test(coreFull));

  // ---- 1. parsing ----------------------------------------------------------------------------
  var e = makeEnv();
  var p = e.api.btParse(' 397888\nW-399174, w393951;397888  \n\n abc  W-397888-001 12/34 0 ');
  A.eq('parse: unique WO numbers in input order', p.unique, [397888, 399174, 393951]);
  A.eq('parse: token count', p.total, 8);
  A.eq('parse: duplicate counted, not repeated', p.dupes, 1);
  A.eq('parse: a PO-style or multi-number token is ambiguous', p.ambiguous, ['W-397888-001', '12/34']);
  A.eq('parse: garbage and zero are invalid', p.invalid, ['abc', '0']);
  A.eq('parse: empty input', e.api.btParse('').unique, []);
  A.eq('parse: the original token is kept per WO (first occurrence)', [p.raw[397888], p.raw[399174], p.raw[393951]], ['397888', 'W-399174', 'w393951']);
  A.eq('parse: a single bare WO number (the smoke-run input)', e.api.btParse('393951').unique, [393951]);

  // ---- 2. preview classification (reads only) ---------------------------------------------------
  var env2 = makeEnv({
    store: {
      '397888': [T()],
      '399174': [],
      '393951': [T({ id: 'task-3', entityId: '393951', assignedTo: TARGET })],
      '400001': [T({ id: 'task-4', entityId: '400001', metadata: '' })],
      '400002': [T({ id: 'task-5', entityId: '400002', isComplete: true })],
      '400003': [T({ id: 'task-6', entityId: '400003' })]
    },
    notFound: [999999], woReadFail: [400009], ambiguous: [400010], shortPage: [400003]
  });
  var byWo = {};
  for (var wo of [397888, 399174, 393951, 400001, 400002, 400003, 999999, 400009, 400010]) byWo[wo] = await previewRow(env2, wo);
  A.eq('preview: an open task on a resolved WO is Reassign', [byWo[397888][0].action, byWo[397888][0].reason], ['Reassign', '']);
  A.eq('preview: current and proposed assignee carried', [byWo[397888][0].cur, byWo[397888][0].to], [OTHER, TARGET]);
  A.eq('preview: WO with no tasks', byWo[399174][0].reason, 'No open task');
  A.eq('preview: already assigned to the target', [byWo[393951][0].action, byWo[393951][0].reason], ['Skip', 'Already assigned to target user']);
  A.eq('preview: missing metadata blocks the full replace', byWo[400001][0].reason, 'Missing required field(s): metadata');
  A.eq('preview: a completed task is not a candidate', byWo[400002][0].reason, 'No open task');
  A.eq('preview: a short task page is a read failure, never a partial list', byWo[400003][0].reason, 'Task read incomplete (1 of 6)');
  A.eq('preview: WO not found', byWo[999999][0].reason, 'Work order not found');
  A.eq('preview: permission / read failure', byWo[400009][0].reason, 'Read failed (permission or network)');
  A.eq('preview: resolved number mismatch is ambiguous', byWo[400010][0].reason, 'Ambiguous work-order match');
  A.eq('preview: no target user -> skip', e.api.btRowsFor(397888, { status: 'ok', tasks: [T()] }, '')[0].reason, 'No resolved target user');
  A.eq('preview: a bad start date blocks the full replace', e.api.btMissing(T({ targetStartDate: 'soon' })), ['targetStartDate']);
  A.eq('preview: an offset-less date is refused (would shift by the UTC offset)', e.api.btMissing(T({ targetStartDate: '2026-09-28T23:45:00' })), ['targetStartDate']);
  A.eq('preview: a sub-millisecond date is refused (would truncate)', e.api.btMissing(T({ targetStartDate: '2026-09-28T23:45:00.1234567+00:00' })), ['targetStartDate']);
  A.eq('preview: Z and ms forms are accepted', [e.api.btMissing(T({ targetStartDate: '2026-09-28T23:45:00.000Z' })), e.api.btMissing(T())], [[], []]);
  A.eq('preview: a flagged task is skipped until live-verified', e.api.btRowsFor(397888, { status: 'ok', tasks: [T({ flag: true })] }, TARGET)[0].reason, 'Flagged or categorised task - not yet verified live, reassign by hand');
  A.eq('preview: a categorised task is skipped until live-verified', e.api.btRowsFor(397888, { status: 'ok', tasks: [T({ categoryId: 16 })] }, TARGET)[0].action, 'Skip');
  A.eq('preview issued ZERO EditTask', env2.gql.edits, 0);

  // ---- 3. confirmation binding --------------------------------------------------------------------
  var rows = byWo[397888];
  var st = e.api.btStamp([397888, 399174], TARGET, rows);
  A.ok('stamp: same inputs, same stamp (order-insensitive)', st === e.api.btStamp([399174, 397888], TARGET, rows));
  A.ok('stamp: a changed WO list moves it', st !== e.api.btStamp([397888], TARGET, rows));
  A.ok('stamp: a changed target moves it', st !== e.api.btStamp([397888, 399174], OTHER, rows));
  var rows2 = clone(rows); rows2[0].snap.description = 'edited';
  A.ok('stamp: a changed task snapshot moves it', st !== e.api.btStamp([397888, 399174], TARGET, rows2));
  A.ok('confirm: exact APPLY n on a current stamp arms', e.api.btConfirmArmed('APPLY 1', 1, st, st));
  A.ok('confirm: wrong count does not arm', !e.api.btConfirmArmed('APPLY 2', 1, st, st));
  A.ok('confirm: case / spacing must be exact', !e.api.btConfirmArmed('apply 1', 1, st, st) && !e.api.btConfirmArmed('APPLY  1', 1, st, st));
  A.ok('confirm: a stale stamp does not arm', !e.api.btConfirmArmed('APPLY 1', 1, e.api.btStamp([397888], TARGET, rows), st));
  A.ok('confirm: no preview does not arm', !e.api.btConfirmArmed('APPLY 1', 1, st, null));
  A.ok('confirm: zero actionable never arms', !e.api.btConfirmArmed('APPLY 0', 0, st, st));

  // ---- 4. payload -------------------------------------------------------------------------------
  var pl = e.api.btPayload(T(), TARGET).data;
  A.eq('payload: captured key order, no categoryId when absent', Object.keys(pl), ['id', 'entityId', 'entityType', 'description', 'targetStartDate', 'assignedTo', 'metadata']);
  A.ok('payload: categoryId omitted, not null', !('categoryId' in pl));
  A.eq('payload: description exact, trailing space kept', pl.description, 'Please review both options ');
  A.eq('payload: metadata byte-for-byte', pl.metadata, T().metadata);
  A.eq('payload: date in the SPA ISO form', pl.targetStartDate, '2026-09-28T23:45:00.000Z');
  A.eq('payload: assignedTo is the target', pl.assignedTo, TARGET);
  var src = T(), diffKeys = Object.keys(pl).filter(function (k) { return k !== 'targetStartDate' && pl[k] !== src[k]; });
  A.eq('payload: assignedTo is the ONLY changed field', diffKeys, ['assignedTo']);
  A.eq('payload: a present categoryId is kept exactly', e.api.btPayload(T({ categoryId: 16 }), TARGET).data.categoryId, 16);

  // ---- 5 + 6. execution + read-back -----------------------------------------------------------------
  async function runOne(opts, row) {
    var env = makeEnv(opts);
    var r = row || (await previewRow(env, 397888))[0];
    var before = env.gql.edits;
    var out = await env.api.btExecRow(r, TARGET);
    return { out: out, env: env, edits: env.gql.edits - before };
  }
  var ok1 = await runOne({ store: { '397888': [T()] } });
  A.eq('run: clean write is Verified', ok1.out.result, 'Verified');
  A.eq('run: exactly one EditTask', ok1.edits, 1);
  A.eq('run: before / after assignee recorded', [ok1.out.before, ok1.out.after], [OTHER, TARGET]);
  var sent = ok1.env.gql.calls.filter(function (c) { return /mutation EditTask/.test(c.q); })[0].v.data;
  A.eq('run: the sent payload is the fresh record with only assignedTo changed', sent, e.api.btPayload(T(), TARGET).data);
  A.ok('run: re-read BEFORE the write (a task read precedes the EditTask)', /BTOpenTasks/.test(ok1.env.gql.calls[ok1.env.gql.calls.findIndex(function (c) { return /EditTask/.test(c.q); }) - 1].q));
  A.eq('run: audit ring recorded the high-risk write ok', ok1.env.api.audit().map(function (a) { return a.op + ':' + a.outcome; }), ['editTask:ok']);

  // changed since preview: another field moved between preview and the write
  var envC = makeEnv({ store: { '397888': [T()] } });
  var rowC = (await previewRow(envC, 397888))[0];
  envC.gql.store['397888'][0].description = 'someone edited it';
  var outC = await envC.api.btExecRow(rowC, TARGET);
  A.eq('run: a task changed since preview is skipped', [outC.result, outC.reason], ['Skipped', 'Changed since preview (description)']);
  A.eq('run: ...with NO write', envC.gql.edits, 0);
  var envC2 = makeEnv({ store: { '397888': [T()] } });
  var rowC2 = (await previewRow(envC2, 397888))[0];
  envC2.gql.store['397888'][0].assignedTo = 'cccc';
  A.eq('run: a reassignment by someone else since preview is skipped, no write', [(await envC2.api.btExecRow(rowC2, TARGET)).result, envC2.gql.edits], ['Skipped', 0]);
  var envC3 = makeEnv({ store: { '397888': [T()] } });
  var rowC3 = (await previewRow(envC3, 397888))[0];
  envC3.gql.store['397888'][0].isComplete = true;
  A.eq('run: a task completed since preview is skipped, no write', [(await envC3.api.btExecRow(rowC3, TARGET)).reason, envC3.gql.edits], ['Changed since preview (task no longer open)', 0]);

  var fail1 = await runOne({ store: { '397888': [T()] }, edit: 'throw' });
  A.eq('run: a failed write is Mutation failed', fail1.out.result, 'Mutation failed');
  A.eq('run: ...and is NOT retried', fail1.edits, 1);
  var ref1 = await runOne({ store: { '397888': [T()] }, edit: 'refuse' });
  A.eq('run: success:false is Mutation failed, not retried', [ref1.out.result, ref1.edits], ['Mutation failed', 1]);
  A.eq('run: the reason is a fixed category, never the server text', [ref1.out.reason, fail1.out.reason], ['Refused by Umbrava', 'Request failed']);
  A.ok('drawer: Preview clears the typed confirm and disarms Apply', /A typed confirm never carries into a new preview[^\n]*\n\s*\$\('bwn-bt-confirm'\)\.value = ''; \$\('bwn-bt-approve'\)\.disabled = true;/.test(coreFull));
  A.ok('drawer: a finished run clears the typed confirm and disarms Apply', /a finished run never re-arms; preview again\n\s*\$\('bwn-bt-confirm'\)\.value = ''; \$\('bwn-bt-approve'\)\.disabled = true;/.test(coreFull));
  var landed = await runOne({ store: { '397888': [T()] }, edit: 'applyAndThrow' });
  A.eq('run: a write that errored but landed is never Verified', landed.out.result, 'Mutation failed');
  A.ok('run: ...and is flagged for review', /READ-BACK SHOWS THE TARGET ASSIGNEE/.test(landed.out.reason), landed.out.reason);
  var corrupt = await runOne({ store: { '397888': [T()] }, edit: 'corrupt' });
  A.eq('read-back: a protected field changed -> Verification failed', [corrupt.out.result, corrupt.out.reason], ['Verification failed', 'Protected field(s) changed: description']);
  var noop = await runOne({ store: { '397888': [T()] }, edit: 'noop' });
  A.eq('read-back: success:true but assignee unchanged -> Verification failed', [noop.out.result, noop.out.reason], ['Verification failed', 'Read-back assignee is not the target user']);
  var rbf = await runOne({ store: { '397888': [T()] }, failReadsAfterEdit: true });
  A.eq('read-back: a failed read-back is Verification unavailable, never success', rbf.out.result, 'Verification unavailable');

  // sequential batch: a failure in row 1 does not stop or retry, row 2 still runs, one write each
  var envS = makeEnv({ store: { '397888': [T()], '399174': [T({ id: 'task-2', entityId: '399174' })] } });
  var batch = (await previewRow(envS, 397888)).concat(await previewRow(envS, 399174));
  envS.gql.store['397888'][0].flag = true;   // row 1 moves -> skipped
  var results = await envS.api.btRunSequential(batch, TARGET, null, null);
  A.eq('batch: per-row isolation', results.map(function (r) { return r.result; }), ['Skipped', 'Verified']);
  A.eq('batch: one write total (only the unchanged row)', envS.gql.edits, 1);
  var envX = makeEnv({ store: { '397888': [T()], '399174': [T({ id: 'task-2', entityId: '399174' })] } });
  var bx = (await previewRow(envX, 397888)).concat(await previewRow(envX, 399174));
  var stopped = await envX.api.btRunSequential(bx, TARGET, null, (function () { var n = 0; return function () { return n++ >= 1; }; })());
  A.eq('batch: cancel stops new rows', stopped.map(function (r) { return r.result; }), ['Verified', 'Not run']);
  var inFlight = 0, maxInFlight = 0;
  var envP = makeEnv({ store: { '397888': [T()], '399174': [T({ id: 'task-2', entityId: '399174' })], '393951': [T({ id: 'task-3', entityId: '393951' })] } });
  var realGql = envP.gql, wrapped = function (q, v) {
    if (/EditTask/.test(q)) { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); }
    return realGql(q, v).then(function (x) { if (/EditTask/.test(q)) inFlight--; return x; });
  };
  var envP2 = (function () {   // same env, transport wrapped to measure concurrency
    var ls = {}, sb = { Object: Object, Array: Array, Number: Number, String: String, JSON: JSON, RegExp: RegExp, Promise: Promise, Error: Error, Math: Math, Date: Date, console: console, parseInt: parseInt, isFinite: isFinite, window: {}, setTimeout: function (fn) { return setTimeout(fn, 0); },
      localStorage: { getItem: function (k) { return (k in ls) ? ls[k] : null; }, setItem: function (k, v) { ls[k] = String(v); }, removeItem: function (k) { delete ls[k]; } },
      BWN_VER: 't', BWN_MODULES: { bulkTask: true }, bwnGql: wrapped };
    vm.createContext(sb);
    return vm.runInContext('(function(){"use strict";' + S_OPS + '\n' + S_ENG + '\nreturn { btReadWO: btReadWO, btRowsFor: btRowsFor, btRunSequential: btRunSequential };})()', sb);
  })();
  var bp = [];
  for (var w of [397888, 399174, 393951]) bp = bp.concat(envP2.btRowsFor(w, await envP2.btReadWO(w), TARGET));
  var rp = await envP2.btRunSequential(bp, TARGET, null, null);
  A.eq('batch: all three verified', rp.map(function (r) { return r.result; }), ['Verified', 'Verified', 'Verified']);
  A.eq('batch: never more than one EditTask in flight', maxInFlight, 1);

  // summary: identifiers + outcomes only, no task text / metadata
  var sum = e.api.btSummary('bt-x', e.api.btParse('397888 399174 abc'), batch, results);
  A.eq('summary: counts', [sum.inputCount, sum.uniqueCount, sum.invalidCount, sum.attempted, sum.verified, sum.skippedAtRun], [3, 2, 1, 1, 1, 1]);
  A.ok('summary: carries no task description or metadata', JSON.stringify(sum).indexOf('Please review') === -1 && JSON.stringify(sum).indexOf('vendorName') === -1);

  // ---- WO Assigned To rows (withWO) ----------------------------------------------------------------
  var TEAM = 'a87ed136-0000-0000-0000-00000000team';
  var envW = makeEnv({ store: { '398436': [], '397888': [T()] }, wos: { 398436: { assignedTo: TEAM, statusId: -1 }, 397888: { assignedTo: TARGET, statusId: 3 } } });
  var rw1 = envW.api.btRowsFor(398436, await envW.api.btReadWO(398436), TARGET, true);
  A.eq('withWO: a WO with NO open task still gets a Reassign WO row (the automation-PM case)', rw1.map(function (r) { return r.kind + ':' + r.action; }), ['wo:Reassign']);
  A.eq('withWO: current / proposed owner carried', [rw1[0].cur, rw1[0].to], [TEAM, TARGET]);
  A.eq('withWO off: the same WO is "No open task"', envW.api.btRowsFor(398436, await envW.api.btReadWO(398436), TARGET)[0].reason, 'No open task');
  var rw2 = envW.api.btRowsFor(397888, await envW.api.btReadWO(397888), TARGET, true);
  A.eq('withWO: WO already owned by the target is skipped, its task still planned', rw2.map(function (r) { return r.kind + ':' + r.action; }), ['wo:Skip', 'task:Reassign']);
  A.eq('withWO: the skip reason', rw2[0].reason, 'Work order already assigned to target');
  var rOnly = envW.api.btRowsFor(397888, await envW.api.btReadWO(397888), OTHER, 'only');
  A.eq("mode 'only': just the WO row, the WO's tasks are NOT planned", rOnly.map(function (r) { return r.kind + ':' + r.action; }), ['wo:Reassign']);
  var rTeam = envW.api.btRowsFor(398436, await envW.api.btReadWO(398436), TARGET, true, true);
  A.eq('team WO owner (live-proven 2026-09-29): a WO row targeting a TEAM plans', rTeam[0].action, 'Reassign');
  var envG = makeEnv({ store: { '398436': [] }, wos: { 398436: { assignedTo: OTHER, statusId: -1 } } }, mutate(S_ENG, 'var BT_TEAM_WO_VERIFIED = true;', 'var BT_TEAM_WO_VERIFIED = false;'));
  var rG = envG.api.btRowsFor(398436, await envG.api.btReadWO(398436), TARGET, true, true);
  A.eq('team gate: re-closing the constant skips team WO rows again', [rG[0].action, rG[0].reason], ['Skip', 'A team as work-order owner is not yet verified live - set it by hand']);
  A.eq('team gate: a closed gate never blocks a PERSON target', envG.api.btRowsFor(398436, await envG.api.btReadWO(398436), TARGET, true, false)[0].action, 'Reassign');
  var rTeamT = envW.api.btRowsFor(397888, await envW.api.btReadWO(397888), TEAM, true, true);
  A.eq('team target: both the WO row and the task row plan', rTeamT.map(function (r) { return r.kind + ':' + r.action; }), ['wo:Reassign', 'task:Reassign']);
  A.ok('team gate is open only because it was proven live (dated comment beside it)', /proven live 2026-09-29[\s\S]{0,300}var BT_TEAM_WO_VERIFIED = true;/.test(S_ENG));
  A.ok('target picker excludes technicians', /function targets\(\) \{ return members\.filter\(function \(m\) \{ return !m\.tech; \}\); \}/.test(coreFull) && /fillMemberSelect\(\$\('bwn-bt-user'\), targets\(\)/.test(coreFull));
  var sA = envW.api.btStamp([398436], TARGET, rw1, true);
  A.ok("stamp: switching to 'only' moves it", sA !== envW.api.btStamp([398436], TARGET, rw1, 'only'));
  A.ok('stamp: toggling withWO moves it', sA !== envW.api.btStamp([398436], TARGET, rw1, false));
  var wr = await envW.api.btExecRow(rw1[0], TARGET);
  A.eq('WO row: clean write is Verified', [wr.result, wr.before, wr.after], ['Verified', TEAM, TARGET]);
  var pcall = envW.gql.calls.filter(function (c) { return /mutation PatchWorkOrder/.test(c.q); });
  A.eq('WO row: exactly one patchWorkOrder, carrying only workOrderNumber + assignedTo', pcall.map(function (c) { return c.v.data; }), [{ workOrderNumber: 398436, assignedTo: { shouldInclude: true, value: TARGET } }]);
  A.eq('WO row: no EditTask sent for a WO row', envW.gql.edits, 0);
  A.ok('WO row: result keyed per WO', wr.key === 'wo:398436' && wr.kind === 'wo');
  async function woRun(opts, mut) {
    var en = makeEnv(Object.assign({ store: { '398436': [] }, wos: { 398436: { assignedTo: TEAM, statusId: -1 } } }, opts));
    var r = en.api.btRowsFor(398436, await en.api.btReadWO(398436), TARGET, true)[0];
    if (mut) mut(en.gql.wos);
    return { out: await en.api.btExecRow(r, TARGET), env: en };
  }
  var wc = await woRun({}, function (w) { w[398436].assignedTo = OTHER; });
  A.eq('WO row: owner changed since preview -> skipped, no write', [wc.out.result, wc.out.reason, wc.env.gql.patches], ['Skipped', 'Changed since preview (assignedTo)', 0]);
  var ws = await woRun({}, function (w) { w[398436].statusId = 5; });
  A.eq('WO row: status changed since preview -> skipped, no write', [ws.out.reason, ws.env.gql.patches], ['Changed since preview (status)', 0]);
  var wst = await woRun({ patch: 'statusToo' });
  A.eq('WO row: a write that also moved the status is Verification failed', [wst.out.result, wst.out.reason], ['Verification failed', 'Work order status changed']);
  var wno = await woRun({ patch: 'noop' });
  A.eq('WO row: success but owner unchanged -> Verification failed', wno.out.result, 'Verification failed');
  var wrf = await woRun({ patch: 'refuse' });
  A.eq('WO row: refused -> Mutation failed, one attempt, fixed reason', [wrf.out.result, wrf.env.gql.patches, wrf.out.reason], ['Mutation failed', 1, 'Refused by Umbrava']);
  var wrb = await woRun({ failWoReadsAfterPatch: true });
  A.eq('WO row: failed read-back -> Verification unavailable', wrb.out.result, 'Verification unavailable');
  var woff = await woRun({ modules: { bulkTask: false } });
  A.eq('WO row: flag off -> nothing sent', [woff.env.gql.patches, woff.out.result], [0, 'Mutation failed']);
  // mixed batch: WO row then its task, sequential, summary keyed per row
  var envM = makeEnv({ store: { '397888': [T()] }, wos: { 397888: { assignedTo: TEAM, statusId: 3 } } });
  var mrows = envM.api.btRowsFor(397888, await envM.api.btReadWO(397888), TARGET, true);
  var mres = await envM.api.btRunSequential(mrows.filter(function (r) { return r.action === 'Reassign'; }), TARGET, null, null);
  A.eq('mixed: WO + task both Verified, one write each', [mres.map(function (r) { return r.kind + ':' + r.result; }), envM.gql.patches, envM.gql.edits], [['wo:Verified', 'task:Verified'], 1, 1]);
  var msum = envM.api.btSummary('bt-m', envM.api.btParse('397888'), mrows, mres);
  A.eq('mixed: summary rows matched per key', msum.rows.map(function (r) { return r.kind + ':' + r.result; }), ['wo:Verified', 'task:Verified']);

  // ---- 7. flag off: the wrapper refuses, nothing is sent ------------------------------------------
  var off = await runOne({ store: { '397888': [T()] }, modules: { bulkTask: false } });
  A.eq('flag off: no EditTask sent', off.edits, 0);
  A.eq('flag off: row reports Mutation failed (not sent), never success', off.out.result, 'Mutation failed');

  // ---- negative controls ----------------------------------------------------------------------------
  console.log('\n-- negative controls: each must turn a case red --');
  async function caught(what, from, to, check) {
    var red = false;
    try { red = !(await check(mutate(S_ENG, from, to))); } catch (err) { red = true; }
    A.ok('CAUGHT: ' + what, red);
  }
  function withEng(src, opts) { return makeEnv(opts, src); }
  await caught('sending categoryId:null when absent', "if (t.categoryId != null) d.categoryId = t.categoryId;", 'd.categoryId = t.categoryId;',
    function (s) { var en = withEng(s); return !('categoryId' in en.api.btPayload(T(), TARGET).data); });
  await caught('dropping the changed-since-preview check', "if (!btSameProtected(fresh, row.snap) || (fresh.assignedTo || null) !== before) {", 'if (false) {',
    async function (s) { var en = withEng(s, { store: { '397888': [T()] } }); var r = (await previewRow(en, 397888))[0]; en.gql.store['397888'][0].description = 'x'; await en.api.btExecRow(r, TARGET); return en.gql.edits === 0; });
  await caught('trusting the write without read-back verification', "if (postTo !== targetId) return out('Verification failed', 'Read-back assignee is not the target user', postTo);", '',
    async function (s) { var en = withEng(s, { store: { '397888': [T()] }, edit: 'noop' }); var r = (await previewRow(en, 397888))[0]; return (await en.api.btExecRow(r, TARGET)).result !== 'Verified'; });
  await caught('skipping the protected-field diff on read-back', "if (diff.length) return out('Verification failed', 'Protected field(s) changed: ' + diff.join(', '), postTo);", '',
    async function (s) { var en = withEng(s, { store: { '397888': [T()] }, edit: 'corrupt' }); var r = (await previewRow(en, 397888))[0]; return (await en.api.btExecRow(r, TARGET)).result !== 'Verified'; });
  await caught('labelling a failed read-back as success', "return out('Verification unavailable', 'Read-back failed - do not assume success');", "return out('Verified', '');",
    async function (s) { var en = withEng(s, { store: { '397888': [T()] }, failReadsAfterEdit: true }); var r = (await previewRow(en, 397888))[0]; return (await en.api.btExecRow(r, TARGET)).result !== 'Verified'; });
  await caught('dropping confirmed:true (the high-risk gate must then refuse)', "feature: 'bulkTask', confirmed: true,", "feature: 'bulkTask',",
    async function (s) { var en = withEng(s, { store: { '397888': [T()] } }); var r = (await previewRow(en, 397888))[0]; return (await en.api.btExecRow(r, TARGET)).result === 'Verified'; });
  await caught('re-serializing the date differently', "targetStartDate: new Date(Date.parse(t.targetStartDate)).toISOString(),", 'targetStartDate: t.targetStartDate,',
    function (s) { return withEng(s).api.btPayload(T(), TARGET).data.targetStartDate === '2026-09-28T23:45:00.000Z'; });
  await caught('accepting a short task page as complete', "if (typeof r.total === 'number' && r.total > r.tasks.length) return", 'if (false) return',
    async function (s) { var en = withEng(s, { store: { '400003': [T({ id: 'x', entityId: '400003' })] }, shortPage: [400003] }); var rr = await previewRow(en, 400003); return rr[0].action === 'Skip'; });

  await caught('letting the WO patch carry more than assignedTo', "if (Object.keys(d).join(',') !== 'workOrderNumber,assignedTo') return 'only assignedTo may be sent';", '',
    async function (s) {
      var en = withEng(mutate(s, "var vars = { data: { workOrderNumber: row.wo, assignedTo: cond(targetId) } };", "var vars = { data: { workOrderNumber: row.wo, assignedTo: cond(targetId), statusId: cond(1) } };"), { store: { '398436': [] }, wos: { 398436: { assignedTo: OTHER, statusId: -1 } } });
      var r = en.api.btRowsFor(398436, await en.api.btReadWO(398436), TARGET, true)[0]; await en.api.btExecRow(r, TARGET); return en.gql.patches === 0;
    });
  await caught('dropping the team WO-owner gate check (with the gate closed)', "else if (targetIsTeam && !BT_TEAM_WO_VERIFIED) wr.reason = 'A team as work-order owner is not yet verified live - set it by hand';", '',
    async function (s) { var en = withEng(mutate(s, 'var BT_TEAM_WO_VERIFIED = true;', 'var BT_TEAM_WO_VERIFIED = false;'), { store: { '398436': [] }, wos: { 398436: { assignedTo: OTHER, statusId: -1 } } }); return en.api.btRowsFor(398436, await en.api.btReadWO(398436), TARGET, true, true)[0].action === 'Skip'; });
  await caught('dropping the Conditional-wrapper check (with a bare assignee payload)', "if (!d.assignedTo || Object.keys(d.assignedTo).join(',') !== 'shouldInclude,value' || d.assignedTo.shouldInclude !== true) return 'bad assignee wrapper';", '',
    async function (s) { s = mutate(s, "var vars = { data: { workOrderNumber: row.wo, assignedTo: cond(targetId) } };", "var vars = { data: { workOrderNumber: row.wo, assignedTo: { value: targetId } } };"); var en = withEng(s, { store: { '398436': [] }, wos: { 398436: { assignedTo: OTHER, statusId: -1 } } }); var r = en.api.btRowsFor(398436, await en.api.btReadWO(398436), TARGET, true)[0]; await en.api.btExecRow(r, TARGET); return en.gql.patches === 0; });
  await caught('dropping the WO status read-back check', "if (post.statusId !== fresh.statusId) return out('Verification failed', 'Work order status changed', post.assignedTo);", '',
    async function (s) { var en = withEng(s, { store: { '398436': [] }, wos: { 398436: { assignedTo: OTHER, statusId: -1 } }, patch: 'statusToo' }); var r = en.api.btRowsFor(398436, await en.api.btReadWO(398436), TARGET, true)[0]; return (await en.api.btExecRow(r, TARGET)).result !== 'Verified'; });

  A.finish();
})().catch(function (err) { console.error(err); process.exit(1); });
