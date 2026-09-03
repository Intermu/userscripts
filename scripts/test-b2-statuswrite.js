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

// WRAP v3's permission gate closes over bwnCan/bwnCanAll and the registry over bwnPermsForPatch,
// so the REAL BWN-PERM reader block is prepended to the slice rather than stubbed. With no
// localStorage slot planted in these sandboxes every permission reads as unknown, which fails
// OPEN - so every case below runs against the same behaviour it had before the gate existed.
// (The gate itself is proven in scripts/test-bwn-ops.js and scripts/test-perm-block-ledger.js.)
var S_PERM = slice('  // ===== BWN-PERM START v1', '  // ===== BWN-PERM END v1 =====', 'BWN-PERM block');
var S_OPS = S_PERM + "\n" + slice('  // ===== BWN-OPS START v1', '  // ===== BWN-OPS END v1 =====', 'BWN-OPS block');
var S_WA = slice('    // ===== WA-WRITES START v1', '    // ===== WA-WRITES END v1 =====', 'WA-WRITES block');

A.ok('WA-WRITES slice is DOM-free (only bwnGqlOp + consts)', !/\bdocument\b|\bwindow\b/.test(S_WA), 'WA-WRITES must not touch the DOM');

// The PATCH_M doc must be the VERBATIM dispatch string, and the payload must send statusId alone.
A.ok('PATCH_M is the verbatim dispatch mutation doc', S_WA.indexOf("var PATCH_M = 'mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }';") !== -1);

// Shaped like the live record read off W-371126 on 2026-09-03: an ECD stored as the UTC instant
// of 11:59 PM local, a real SLA id, and siblings that patchWorkOrder blanks if they are not copied.
var DEFAULT_WO_READ = {
  serviceLevelAgreementId: 'dcc21347-28a7-46b0-9b97-a31345405df0',
  priority: {
    label: 'P4 PM', responseMinutes: 7200, firstTripDate: '2026-06-27T16:09:50Z',
    serviceLevelAgreementMinutes: 66949, expirationMinutes: null,
    expectedCompletionDate: '2026-08-08T03:59:00+00:00',
    hasPriorityOverride: true, category: 'Standard', skipWeekends: false
  }
};
function makeEnv(opts, waSrc) {
  opts = opts || {};
  var store = Object.create(null);
  var env = { calls: [] };
  // The BWN-PERM block reads the decoded grant list out of localStorage. Seeding it here is how
  // a probe models 'this user does not hold that checkbox'; absent = unknown = fails OPEN.
  env.setPerm = function (groups, granted) {
    store['bwn:perm:last'] = JSON.stringify({ v: 1, ts: Date.now(), ver: 'test', groups: groups, granted: granted });
  };
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
      // waSetEcd reads the WO before patching (the sibling priority fields are not on the page
      // any more). Answer that read here; opts.woRead === null models a WO that cannot be read.
      if (/workOrder\(workOrderNumber/.test(query)) {
        return Promise.resolve({ workOrder: ('woRead' in opts) ? opts.woRead : DEFAULT_WO_READ });
      }
      var field = /patchWorkOrder/.test(query) ? 'patchWorkOrder' : null;
      var o = {}; if (field) o[field] = { success: opts.envFalse ? false : true, message: '' };
      return Promise.resolve(o);
    }
  };
  vm.createContext(sandbox);
  env.api = vm.runInContext(
    '(function () {\n' + S_OPS + '\n' + (waSrc || S_WA) + '\n' +
    'return { run: bwnGqlOp, PATCH_M: PATCH_M, waChangeStatus: waChangeStatus,\n' +
    '  waStatusSubmit: waStatusSubmit, waSetEcd: waSetEcd, waEcdSubmit: waEcdSubmit,\n' +
    '  auditAll: bwnAuditAll };\n})()',
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

  // ---- B3: SET ECD via patchWorkOrder ------------------------------------------------------
  // Replaces the old DOM writer (type into the picker, then click the WO header Save). Umbrava
  // rebuilt the WO form on 2026-09-03: the header holds no inputs and no button reads "Save",
  // so both halves of that writer lost their target. These drive the real WA-WRITES bytes.
  console.log('\n-- B3: set the expected completion date through the API --');

  var e10 = makeEnv();
  var ecdBtn = { disabled: false };
  var ecdOk = null, ecdNoop = false;
  await e10.api.waEcdSubmit(ecdBtn, 371126, '2026-09-18T03:59:00.000Z', {
    ok: function (r) { ecdOk = r; }, noop: function () { ecdNoop = true; }
  });
  await tick();
  var c10 = patchCalls(e10);
  A.eq('B3-happy: exactly one patchWorkOrder sent', c10.length, 1);
  var d10 = c10.length ? c10[0].variables.data : {};
  A.eq('B3-happy: data carries the WO, the whole priority, and the SLA id',
    Object.keys(d10).sort(), ['priority', 'serviceLevelAgreementId', 'workOrderNumber']);
  A.eq('B3-happy: workOrderNumber is numeric', d10.workOrderNumber, 371126);
  A.eq('B3-happy: only the ECD is changed', d10.priority.value.expectedCompletionDate, '2026-09-18T03:59:00.000Z');
  // THE hazard this shape exists for: patchWorkOrder replaces the entire priority object, so a
  // sibling that is not copied back is BLANKED on a live record.
  A.eq('B3-happy: the label sibling is carried, not blanked', d10.priority.value.label, 'P4 PM');
  A.eq('B3-happy: the SLA minutes sibling is carried', d10.priority.value.serviceLevelAgreementMinutes, 66949);
  A.eq('B3-happy: the first-trip sibling is carried', d10.priority.value.firstTripDate, '2026-06-27T16:09:50Z');
  A.eq('B3-happy: the read hasPriorityOverride maps onto hasOverridePriority, forced true',
    d10.priority.value.hasOverridePriority, true);
  A.ok('B3-happy: the input carries no hasPriorityOverride key (that is the READ spelling)',
    !('hasPriorityOverride' in d10.priority.value), Object.keys(d10.priority.value).join(','));
  A.eq('B3-happy: ok fired with the before/after pair, noop did not', [!!ecdOk, ecdNoop], [true, false]);
  A.eq('B3-happy: the audit entry records the outcome', (e10.api.auditAll()[0] || {}).outcome, 'ok');

  // Same calendar day as the stored value -> no write at all. The stored ECD is a UTC instant, so
  // this also pins that the comparison is made on the date part of the SAME representation.
  var e11 = makeEnv();
  var noopFired11 = false;
  await e11.api.waEcdSubmit({ disabled: false }, 371126, '2026-08-08T03:59:00.000Z', { noop: function () { noopFired11 = true; } });
  await tick();
  A.eq('B3-noop: an unchanged date sends NO patch', patchCalls(e11).length, 0);
  A.ok('B3-noop: and reports the no-op instead of claiming a write', noopFired11);

  // A WO with no SLA id must not have the key invented.
  var e12 = makeEnv({ woRead: { serviceLevelAgreementId: null, priority: { label: 'X', responseMinutes: 60, firstTripDate: null, serviceLevelAgreementMinutes: 60, expirationMinutes: null, expectedCompletionDate: '2026-01-01T00:00:00Z', hasPriorityOverride: false, category: 'Standard', skipWeekends: false } } });
  await e12.api.waEcdSubmit({ disabled: false }, 371126, '2026-09-18T03:59:00.000Z', {});
  await tick();
  var d12 = patchCalls(e12)[0].variables.data;
  A.ok('B3-nosla: serviceLevelAgreementId is omitted when the WO has none', !('serviceLevelAgreementId' in d12), Object.keys(d12).join(','));

  // An unreadable WO must NOT fall through into a patch built on an empty priority - that would
  // blank every sibling on the live record.
  var e13 = makeEnv({ woRead: null });
  var failed13 = null, btn13 = { disabled: false };
  await e13.api.waEcdSubmit(btn13, 371126, '2026-09-18T03:59:00.000Z', { fail: function (e) { failed13 = e; } }).catch(function () { });
  await tick();
  A.eq('B3-unreadable: no patch is sent when the WO could not be read', patchCalls(e13).length, 0);
  A.ok('B3-unreadable: it fails loudly rather than writing a guess', failed13 && /NOT written/.test(failed13.message), failed13 && failed13.message);
  A.eq('B3-unreadable: the button is re-enabled so the coordinator can retry', btn13.disabled, false);

  // The Umbrava permission gate owns the ECD field via WorkOrderField.CompletionSLA.
  var e14 = makeEnv();
  var permDenied = null;
  e14.setPerm(['WorkOrderField'], ['WorkOrderField.Status']);   // has Status, NOT CompletionSLA
  await e14.api.waEcdSubmit({ disabled: false }, 371126, '2026-09-18T03:59:00.000Z', { fail: function (e) { permDenied = e; } }).catch(function () { });
  await tick();
  A.eq('B3-perm: a user without WorkOrderField.CompletionSLA sends NO patch', patchCalls(e14).length, 0);
  A.ok('B3-perm: and the refusal names the permission', permDenied && /CompletionSLA/.test(permDenied.message), permDenied && permDenied.message);

  // ---- B3 mutations: each must redden a probe above -----------------------------------------
  console.log('\n-- B3 mutations --');

  // M-B3a: stop copying a sibling. This is the exact bug the whole-object contract exists to
  // prevent, and on a live WO it silently wipes the SLA window.
  var mA = makeEnv({}, mutate(S_WA, '        serviceLevelAgreementMinutes: waNum(p.serviceLevelAgreementMinutes),\n', ''));
  await mA.api.waEcdSubmit({ disabled: false }, 371126, '2026-09-18T03:59:00.000Z', {});
  await tick();
  A.ok('M-B3a dropping a sibling from the copy blanks it in the payload',
    patchCalls(mA)[0].variables.data.priority.value.serviceLevelAgreementMinutes === undefined,
    'the sibling survived a mutation that should have removed it');

  // M-B3b: drop the no-op pre-check -> an unchanged date becomes a real high-risk write.
  var mB = makeEnv({}, mutate(S_WA,
    "          return { noop: true, before: oldEcd, after: newEcd };",
    "          void 0;"));
  await mB.api.waEcdSubmit({ disabled: false }, 371126, '2026-08-08T03:59:00.000Z', {});
  await tick();
  A.eq('M-B3b without the no-op pre-check an unchanged date still patches', patchCalls(mB).length, 1);

  A.finish();
})().catch(function (e) { console.error('\nHARNESS ERROR:', e && e.stack || e); process.exit(2); });
