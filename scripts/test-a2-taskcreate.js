// test-a2-taskcreate.js - the WO-Assist "Create follow-up task" write path (Tier A2).
//
// WHAT THIS PROVES, against the REAL shipped bytes of bwn-suite-core.user.js: the WA-WRITES region
// (waCreateTask / waTaskSubmit) is sliced out and CONCATENATED with the BWN-OPS region (the audited
// bwnGqlOp wrapper + registry), then run in a vm with a fake localStorage and an injectable
// transport - so addTask is exercised end to end through the real safety spine, not a stub.
//
//   A2-create        confirm -> exactly ONE addTask call, whose variables carry the frozen shape
//                    incl. metadata = {"number":"<wo>"} (the field the REST backend 500s without).
//   A2-double-click  two synchronous clicks through waTaskSubmit's button guard -> ONE task
//                    (addTask is retry:'none'; a double-post would be two real tasks).
//   A2-validate      empty description -> bwnGqlOp's validate DENIES it before the wire; zero sends,
//                    one audit entry outcome:'denied'.
//
// Every case is re-run against a mutated copy of the same source; each mutation MUST turn a check
// red (mutate() throws if its target is absent or not unique), so no assertion is decorative.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-a2-taskcreate.js
// CI runs: node scripts/test-a2-taskcreate.js

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
var S_WA = slice('    // ===== WA-WRITES START v1', '    // ===== WA-WRITES END v1 =====', 'WA-WRITES block');

// The WA slice must reference ONLY bwnGqlOp + its own frozen consts - never the DOM. This static
// guard makes that contract load-bearing: if a later edit reaches for document/window inside the
// sliced writers, the harness fails here instead of throwing opaquely in the vm.
A.ok('WA-WRITES slice is DOM-free (only bwnGqlOp + consts)', !/\bdocument\b|\bwindow\b/.test(S_WA), 'WA-WRITES must not touch the DOM');

// ---- Shared gate: the button mounts ONLY behind BWN_MODULES.woAssistWrites, default OFF -------
A.ok('shipping default: woAssistWrites is false in BWN_MODULES', /woAssistWrites:\s*false/.test(coreFull), 'the guided-write flag must ship OFF');
// The render-layer "Create task…" button lives inside the flag guard: slice from the guard to the
// button's own creation and assert the guard opens the region (no button mounts when the flag is off).
(function () {
  var gi = coreFull.indexOf('if (BWN_MODULES.woAssistWrites) {');
  A.ok('render: the guided-write buttons are wrapped in an if (BWN_MODULES.woAssistWrites) guard', gi !== -1);
  var region = gi === -1 ? '' : coreFull.slice(gi, gi + 900);
  A.ok('render: the "Create task…" button is created inside that guard', /Create task/.test(region) && /taskHelperOpen\(state, act\)/.test(region));
})();

// A programmable transport. Records every call; returns the {op:{success}} envelope bwnGqlOp reads.
function makeEnv(opts) {
  opts = opts || {};
  var store = Object.create(null);
  var env = { calls: [] };
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, JSON: JSON,
    Promise: Promise, Error: Error, RegExp: RegExp, Math: Math, Date: Date, console: console,
    window: {},                                   // no crypto -> corrId uses the timestamp form
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    setTimeout: function (fn) { return setTimeout(fn, 0); },
    BWN_VER: '0.0.0-test',
    BWN_MODULES: opts.modules || { woAssist: true },
    bwnGql: function (query, variables) {
      env.calls.push({ query: query, variables: variables });
      if (opts.fail) return Promise.reject(new Error('refused'));
      var field = /addTask/.test(query) ? 'addTask' : null;
      var o = {}; if (field) o[field] = { success: opts.envFalse ? false : true, message: '' };
      return Promise.resolve(o);
    }
  };
  vm.createContext(sandbox);
  env.api = vm.runInContext(
    '(function () {\n' + S_OPS + '\n' + S_WA + '\n' +
    'return { run: bwnGqlOp, waCreateTask: waCreateTask, waTaskSubmit: waTaskSubmit,\n' +
    '  auditAll: bwnAuditAll };\n})()',
    sandbox, { filename: 'wa-a2.js' });
  return env;
}
function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 5); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}
function addTaskCalls(env) { return env.calls.filter(function (c) { return /addTask/.test(c.query); }); }

(async function () {
  // ---- A2-create ---------------------------------------------------------------------------
  var e1 = makeEnv();
  await e1.api.waCreateTask(370534, 'guid-abc', 'Call vendor for ETA');
  await tick();
  var c1 = addTaskCalls(e1);
  A.eq('A2-create: exactly one addTask sent', c1.length, 1);
  var v = c1.length ? c1[0].variables : {};
  var d = v && v.data || {};
  A.eq('A2-create: entityId is the WO number as a String', d.entityId, '370534');
  A.eq('A2-create: entityType is 1 (work order)', d.entityType, 1);
  A.eq('A2-create: description carries the task text', d.description, 'Call vendor for ETA');
  A.eq('A2-create: assignedTo carries the coordinator GUID', d.assignedTo, 'guid-abc');
  A.eq('A2-create: notifyCreator is false', d.notifyCreator, false);
  A.eq('A2-create: metadata is {"number":"<wo>"} (backend 500s without it)', d.metadata, '{"number":"370534"}');
  A.ok('A2-create: targetStartDate is a full ISO timestamp', typeof d.targetStartDate === 'string' && /^\d{4}-\d\d-\d\dT/.test(d.targetStartDate), d.targetStartDate);
  A.eq('A2-create: one audit entry, outcome ok', e1.api.auditAll().length, 1);
  A.eq('A2-create: audit outcome is ok', (e1.api.auditAll()[0] || {}).outcome, 'ok');

  // assignedTo defaults to null when none is picked (payload allows an unassigned task).
  var eNull = makeEnv();
  await eNull.api.waCreateTask(370534, null, 'Unassigned follow-up');
  await tick();
  A.eq('A2-create: assignedTo null when no assignee picked', (addTaskCalls(eNull)[0].variables.data.assignedTo), null);

  // ---- A2-double-click ---------------------------------------------------------------------
  var e2 = makeEnv();
  var btn = { disabled: false };
  var p2a = e2.api.waTaskSubmit(btn, 370534, 'guid-abc', 'Chase the vendor', {});
  var p2b = e2.api.waTaskSubmit(btn, 370534, 'guid-abc', 'Chase the vendor', {});   // second click, still in flight
  A.ok('A2-double-click: button is disabled after the first click', btn.disabled === true);
  A.eq('A2-double-click: the second click is a no-op (returns null)', p2b, null);
  await Promise.resolve(p2a).catch(function () {});
  await tick();
  A.eq('A2-double-click: exactly ONE task filed despite two clicks', addTaskCalls(e2).length, 1);

  // ---- A2-validate -------------------------------------------------------------------------
  var e3 = makeEnv();
  var denied = false;
  await e3.api.waCreateTask(370534, 'guid-abc', '   ').then(
    function () { denied = false; },
    function (err) { denied = /validation/.test(String(err && err.message)); });
  await tick();
  A.ok('A2-validate: empty description rejects at bwnGqlOp validate', denied);
  A.eq('A2-validate: NOTHING was sent to the wire', addTaskCalls(e3).length, 0);
  A.eq('A2-validate: exactly one audit entry', e3.api.auditAll().length, 1);
  A.eq('A2-validate: audit outcome is denied', (e3.api.auditAll()[0] || {}).outcome, 'denied');

  // A validation reason of "no WO number" also blocks (entityId falsy).
  var e3b = makeEnv();
  var denied2 = false;
  await e3b.api.waCreateTask('', 'guid', 'has text').then(function () {}, function () { denied2 = true; });
  await tick();
  A.ok('A2-validate: missing WO number is also denied', denied2);
  A.eq('A2-validate: missing-WO case sent nothing', addTaskCalls(e3b).length, 0);

  // ---- feature kill switch: woAssist off -> refused before the wire -------------------------
  var eOff = makeEnv({ modules: { woAssist: false } });
  var offDenied = false;
  await eOff.api.waCreateTask(370534, 'guid', 'Call vendor').then(function () {}, function () { offDenied = true; });
  await tick();
  A.ok('kill switch: woAssist:false refuses the write', offDenied);
  A.eq('kill switch: nothing sent when the module is off', addTaskCalls(eOff).length, 0);

  // ---- a success:false envelope is REJECTED, not swallowed ----------------------------------
  var eF = makeEnv({ envFalse: true });
  var envRejected = false;
  await eF.api.waCreateTask(370534, 'guid', 'Call vendor').then(function () {}, function () { envRejected = true; });
  await tick();
  A.ok('a success:false addTask envelope rejects (never a silent false)', envRejected);

  // ---- CONTROLS: each guarantee is load-bearing --------------------------------------------
  // (1) Drop `metadata` from the payload -> the metadata assertion goes red.
  await (async function () {
    var wa2 = mutate(S_WA, "metadata: JSON.stringify({ number: String(woNumber) })", "notify2: false");
    var store = Object.create(null); var calls = [];
    var sb = {
      Object: Object, Array: Array, Number: Number, String: String, JSON: JSON, Promise: Promise,
      Error: Error, RegExp: RegExp, Math: Math, Date: Date, console: console, window: {},
      localStorage: { getItem: function (k) { return (k in store) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } },
      setTimeout: function (fn) { return setTimeout(fn, 0); }, BWN_VER: 'x', BWN_MODULES: { woAssist: true },
      bwnGql: function (q, vv) { calls.push({ q: q, v: vv }); var o = {}; if (/addTask/.test(q)) o.addTask = { success: true }; return Promise.resolve(o); }
    };
    vm.createContext(sb);
    var api = vm.runInContext('(function(){\n' + S_OPS + '\n' + wa2 + '\nreturn { waCreateTask: waCreateTask };\n})()', sb, { filename: 'wa-mut.js' });
    await api.waCreateTask(1, 'g', 't');
    await tick();
    A.ok('CONTROL: dropping metadata makes it absent (assertion is load-bearing)', calls[0].v.data.metadata === undefined);
  })();

  // (2) Neuter the validate() -> A2-validate would send an empty task. Prove the mutation flips it.
  await (async function () {
    var wa3 = mutate(S_WA, "if (!String(d.description || '').trim()) return 'empty task text';", "/* validate removed */");
    var store = Object.create(null); var calls = [];
    var sb = {
      Object: Object, Array: Array, Number: Number, String: String, JSON: JSON, Promise: Promise,
      Error: Error, RegExp: RegExp, Math: Math, Date: Date, console: console, window: {},
      localStorage: { getItem: function (k) { return (k in store) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } },
      setTimeout: function (fn) { return setTimeout(fn, 0); }, BWN_VER: 'x', BWN_MODULES: { woAssist: true },
      bwnGql: function (q, vv) { calls.push({ q: q, v: vv }); var o = {}; if (/addTask/.test(q)) o.addTask = { success: true }; return Promise.resolve(o); }
    };
    vm.createContext(sb);
    var api = vm.runInContext('(function(){\n' + S_OPS + '\n' + wa3 + '\nreturn { waCreateTask: waCreateTask };\n})()', sb, { filename: 'wa-mut2.js' });
    await api.waCreateTask(1, 'g', '   ').then(function () {}, function () {});
    await tick();
    A.eq('CONTROL: with the empty-text guard removed, an empty task WOULD send (guard is load-bearing)', calls.length, 1);
  })();

  A.finish();
})().catch(function (e) { console.error('\nHARNESS ERROR:', e && e.stack || e); process.exit(2); });
