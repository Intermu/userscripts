// test-b2-statuswrite.js - the WO-Assist "Change status" guided write path (Tier B2).
//
// WHAT THIS PROVES, against the REAL shipped bytes of bwn-suite-core.user.js: the WA-WRITES region
// (waChangeStatus / waStatusSubmit) is sliced out and CONCATENATED with the BWN-OPS region (the
// audited bwnGqlOp wrapper + registry), then run in a vm with a fake localStorage and an injectable
// transport - so the high-risk patchWorkOrder is exercised end to end through the real fail-closed
// confirm gate, not a stub.
//
//   B2-happy       a resolvable target (typed confirm already satisfied by the dialog) -> exactly
//                  ONE patchWorkOrder whose data carries statusId ALONE (workOrderNumber + statusId,
//                  nothing else - bundling blanks siblings), and the reason is drafted as a note.
//   B2-gate-fail   the SAME payload WITHOUT confirmed:true, and Core wires no _confirmFn -> the
//                  high-risk gate REFUSES it; zero sends, one audit entry outcome:'denied'.
//   B2-noop        target statusId === current statusId -> waChangeStatus skips the write entirely.
//
// Every case is re-run against a mutated copy of the same source; each mutation MUST turn a check
// red (mutate() throws if its target is absent or not unique), so no assertion is decorative.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-b2-statuswrite.js
// CI runs: node scripts/test-b2-statuswrite.js

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
var S_WA = slice('    // ===== WA-WRITES START v1', '    // ===== WA-WRITES END v1 =====', 'WA-WRITES block');

A.ok('WA-WRITES slice is DOM-free (only bwnGqlOp + consts)', !/\bdocument\b|\bwindow\b/.test(S_WA), 'WA-WRITES must not touch the DOM');

// The PATCH_M doc must be the VERBATIM dispatch string, and the payload must send statusId alone.
A.ok('PATCH_M is the verbatim dispatch mutation doc', S_WA.indexOf("var PATCH_M = 'mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }';") !== -1);

function makeEnv(opts, waSrc) {
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
      var field = /patchWorkOrder/.test(query) ? 'patchWorkOrder' : null;
      var o = {}; if (field) o[field] = { success: opts.envFalse ? false : true, message: '' };
      return Promise.resolve(o);
    }
  };
  vm.createContext(sandbox);
  env.api = vm.runInContext(
    '(function () {\n' + S_OPS + '\n' + (waSrc || S_WA) + '\n' +
    'return { run: bwnGqlOp, PATCH_M: PATCH_M, waChangeStatus: waChangeStatus,\n' +
    '  waStatusSubmit: waStatusSubmit, auditAll: bwnAuditAll };\n})()',
    sandbox, { filename: 'wa-b2.js' });
  return env;
}
function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 5); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}
function patchCalls(env) { return env.calls.filter(function (c) { return /patchWorkOrder/.test(c.query); }); }

(async function () {
  // ---- B2-happy ----------------------------------------------------------------------------
  var e1 = makeEnv();
  var btn = { disabled: false };
  var drafted = [];
  var okFired = false, noopFired = false;
  await e1.api.waStatusSubmit(btn, 386473, 7, 'Invoiced', 'Work Complete', 3, 'billing package is on file', {
    draftNote: function (t) { drafted.push(t); },
    ok: function () { okFired = true; },
    noop: function () { noopFired = true; }
  });
  await tick();
  var c1 = patchCalls(e1);
  A.eq('B2-happy: exactly one patchWorkOrder sent', c1.length, 1);
  var data = c1.length ? c1[0].variables.data : {};
  A.eq('B2-happy: data carries statusId ALONE (workOrderNumber + statusId, nothing else)', Object.keys(data).sort(), ['statusId', 'workOrderNumber']);
  A.eq('B2-happy: workOrderNumber is the numeric WO', data.workOrderNumber, 386473);
  A.eq('B2-happy: statusId is the Conditional wrapper with the integer target', data.statusId, { shouldInclude: true, value: 7 });
  A.eq('B2-happy: the button is disabled after submit', btn.disabled, true);
  A.eq('B2-happy: exactly one note drafted', drafted.length, 1);
  A.ok('B2-happy: the drafted note carries the target status + the reason', /Invoiced/.test(drafted[0]) && /billing package is on file/.test(drafted[0]), drafted[0]);
  A.ok('B2-happy: ok fired, noop did not', okFired && !noopFired);
  A.eq('B2-happy: one audit entry, outcome ok', (e1.api.auditAll()[0] || {}).outcome, 'ok');

  // ---- B2-gate-fail: omit confirmed AND no _confirmFn -> refused ----------------------------
  var e2 = makeEnv();
  var refused = false, reason = '';
  await e2.api.run('patchWorkOrder', e2.api.PATCH_M, { data: { workOrderNumber: 386473, statusId: { shouldInclude: true, value: 7 } } }, {
    feature: 'woAssist',
    validate: function (v) { var d = v && v.data || {}; if (!d.workOrderNumber) return 'no WO number'; return true; },
    ids: { wo: 386473 }, irreversible: true
    // NOTE: no confirmed:true, and Core wires no _confirmFn
  }).then(function () {}, function (err) { refused = true; reason = String(err && err.message); });
  await tick();
  A.ok('B2-gate-fail: the high-risk gate refuses an unconfirmed patchWorkOrder', refused);
  A.ok('B2-gate-fail: refusal names the missing confirmation', /confirm/i.test(reason), reason);
  A.eq('B2-gate-fail: NOTHING was sent to the wire', patchCalls(e2).length, 0);
  A.eq('B2-gate-fail: audit outcome is denied', (e2.api.auditAll()[0] || {}).outcome, 'denied');

  // waChangeStatus itself passes confirmed:true, so the SAME op DOES proceed through it (the
  // sanctioned own-dialog path) - proving confirmed:true is what unblocks the gate.
  var e2b = makeEnv();
  await e2b.api.waChangeStatus(386473, 7, 'Invoiced', 'Work Complete', 3);
  await tick();
  A.eq('B2-gate-fail control: waChangeStatus (confirmed:true) DOES send - confirmed is the gate', patchCalls(e2b).length, 1);

  // ---- B2-noop: target === current statusId -> skipped --------------------------------------
  var e3 = makeEnv();
  var r3 = await e3.api.waChangeStatus(386473, 3, 'Work Complete', 'Work Complete', 3);
  await tick();
  A.ok('B2-noop: waChangeStatus returns a noop marker', r3 && r3.noop === true);
  A.eq('B2-noop: NO patchWorkOrder sent when already at the target status', patchCalls(e3).length, 0);
  A.eq('B2-noop: no audit entry for a skipped write', e3.api.auditAll().length, 0);

  // noop through the submit wrapper: reports noop, drafts NOTHING, sends NOTHING.
  var e3b = makeEnv();
  var b2 = { disabled: false }; var noopFired2 = false; var drafted2 = [];
  await e3b.api.waStatusSubmit(b2, 386473, 3, 'Work Complete', 'Work Complete', 3, 'reason', {
    draftNote: function (t) { drafted2.push(t); }, noop: function () { noopFired2 = true; }
  });
  await tick();
  A.ok('B2-noop: submit reports noop and drafts no note', noopFired2 && drafted2.length === 0);
  A.eq('B2-noop: submit sends nothing on a noop', patchCalls(e3b).length, 0);

  // ---- double-submit guard (retry:'none' - a second click must not double-patch) ------------
  var e4 = makeEnv();
  var b4 = { disabled: false };
  var pA = e4.api.waStatusSubmit(b4, 386473, 7, 'Invoiced', 'Work Complete', 3, 'reason', {});
  var pB = e4.api.waStatusSubmit(b4, 386473, 7, 'Invoiced', 'Work Complete', 3, 'reason', {});
  A.eq('guard: the second submit is a no-op (returns null)', pB, null);
  await Promise.resolve(pA).catch(function () {});
  await tick();
  A.eq('guard: exactly ONE patchWorkOrder despite two submits', patchCalls(e4).length, 1);

  // ---- feature kill switch + success:false rejection ---------------------------------------
  var eOff = makeEnv({ modules: { woAssist: false } });
  var offDenied = false;
  await eOff.api.waChangeStatus(386473, 7, 'Invoiced', 'Work Complete', 3).then(function () {}, function () { offDenied = true; });
  await tick();
  A.ok('kill switch: woAssist:false refuses the status write', offDenied);
  A.eq('kill switch: nothing sent when the module is off', patchCalls(eOff).length, 0);

  var eF = makeEnv({ envFalse: true });
  var envRejected = false;
  await eF.api.waChangeStatus(386473, 7, 'Invoiced', 'Work Complete', 3).then(function () {}, function () { envRejected = true; });
  await tick();
  A.ok('a success:false patchWorkOrder envelope rejects (never a silent false)', envRejected);

  // ---- CONTROLS: each guarantee is load-bearing --------------------------------------------
  // (1) Bundle a sibling field into data -> the "statusId ALONE" assertion goes red.
  await (async function () {
    var wa2 = mutate(S_WA, 'statusId: { shouldInclude: true, value: targetId }\n      } }',
      'statusId: { shouldInclude: true, value: targetId }, assignedTo: { shouldInclude: true, value: null }\n      } }');
    var e = makeEnv({}, wa2);
    await e.api.waChangeStatus(1, 7, 'X', 'Y', 3);
    await tick();
    var keys = Object.keys(patchCalls(e)[0].variables.data).sort();
    A.ok('CONTROL: bundling a sibling breaks statusId-alone (assertion is load-bearing)', keys.length === 3 && keys.indexOf('assignedTo') !== -1);
  })();

  // (2) Drop confirmed:true from waChangeStatus -> it can no longer send (gate refuses it).
  await (async function () {
    var wa3 = mutate(S_WA, 'confirmed: true,\n        feature: \'woAssist\',', "feature: 'woAssist',");
    var e = makeEnv({}, wa3);
    var blocked = false;
    await e.api.waChangeStatus(1, 7, 'X', 'Y', 3).then(function () {}, function () { blocked = true; });
    await tick();
    A.ok('CONTROL: without confirmed:true waChangeStatus is refused (confirmed is load-bearing)', blocked && patchCalls(e).length === 0);
  })();

  // (3) Neuter the noop pre-check -> a same-status change WOULD send.
  await (async function () {
    var wa4 = mutate(S_WA, 'if (currentStatusId != null && Number(currentStatusId) === Number(targetId)) {',
      'if (false) {');
    var e = makeEnv({}, wa4);
    await e.api.waChangeStatus(1, 3, 'Same', 'Same', 3);
    await tick();
    A.eq('CONTROL: with the noop guard removed, a same-status change WOULD send (guard is load-bearing)', patchCalls(e).length, 1);
  })();

  // ---- render gate: the "Change status…" button mounts ONLY behind the flag + only on the ---
  //      advance:workcomplete / phase-chase rows.
  (function () {
    var gi = coreFull.indexOf('if (BWN_MODULES.woAssistWrites) {');
    var region = gi === -1 ? '' : coreFull.slice(gi, gi + 1600);
    A.ok('render: "Change status…" is inside the woAssistWrites guard', /Change status/.test(region) && /statusHelperOpen\(state, act\)/.test(region));
    A.ok('render: it is scoped to advance:workcomplete + phase-chase rows', /act\.key === 'advance:workcomplete' \|\| act\.key\.indexOf\('phase:'\) === 0/.test(region));
  })();

  A.finish();
})().catch(function (e) { console.error('\nHARNESS ERROR:', e && e.stack || e); process.exit(2); });
