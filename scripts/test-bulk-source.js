// test-bulk-source.js - the Bulk Source Job# engine (Core module, flag bulkSource default OFF).
//
// WHAT THIS PROVES, against the REAL shipped bytes of bwn-suite-core.user.js: the
// BULK-SOURCE-ENGINE region (the pure, DOM-free write engine) is sliced out and CONCATENATED with
// the BWN-OPS region (the audited bwnGqlOp wrapper + registry), then run in a vm with a fake
// localStorage and an injectable bwnGql transport - so the batch write path is exercised end to end
// through the real audit ring + fail-closed high-risk confirm gate, not a stub.
//
//   Q/R value      srcValueFor('qr',...) is always "Q/R (WO#)".
//   RF value       "RF (clientWorkOrderNumber)" when the WO carries one (trimmed), else "RF (WO#)".
//   write shape    patchWorkOrder data is EXACTLY { workOrderNumber, sourceJobNumber:{shouldInclude,value} }
//                  - a single scalar PATCH, no whole-object hazard.
//   blanks only    a WO whose sourceJobNumber already has a value -> no-op, NO patch (re-checked at
//                  write time, not just in the dry-run).
//   dry-run        mode:'dry' builds the exact variables but sends ZERO writes.
//   high-risk gate confirmed:true unblocks patchWorkOrder (risk:'high'); the write is audited ok.
//   cap            over the 50-record cap -> REFUSED, count reported, never truncated.
//
// Every guarantee carries a negative control: a mutated copy of the same source that MUST turn the
// check red (mutate() throws if its target is absent or not unique), so no assertion is decorative.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bulk-source.js
// CI runs: node scripts/test-bulk-source.js

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
var S_ENG = slice('    // ===== BULK-SOURCE-ENGINE START v1', '    // ===== BULK-SOURCE-ENGINE END v1 =====', 'BULK-SOURCE-ENGINE block');

// The engine must never touch the DOM - that is what lets this harness drive the shipped bytes.
A.ok('BULK-SOURCE-ENGINE slice is DOM-free', !/\bdocument\b|\bwindow\b|\bXLSX\b|querySelector/.test(S_ENG), 'engine must not reach the DOM');

// Pinned docs must be the exact captured strings (a re-shaped selector is a silent bug).
A.ok('WOSRC_READ_Q reads sourceJobNumber + clientWorkOrderNumber',
  S_ENG.indexOf("var WOSRC_READ_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ sourceJobNumber clientWorkOrderNumber } }';") !== -1);
A.ok('WOSRC_PATCH_M is the patchWorkOrder success/message mutation',
  S_ENG.indexOf("var WOSRC_PATCH_M = 'mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }';") !== -1);

// ---- source-level ship-safety: the module is gated OFF and nothing mounts when the flag is off ----
A.ok('bulkSource flag ships default OFF', /bulkSource: false,/.test(coreFull));
A.ok('the whole module mounts only behind BWN_MODULES.bulkSource', /bwnBoot\('bulkSource', BWN_MODULES\.bulkSource, function \(\) \{/.test(coreFull));
A.ok('the write passes feature:bulkSource + confirmed:true to the wrapper', /feature: 'bulkSource', confirmed: true/.test(S_ENG));

// Programmable bwnGql: records every call so a test can assert what was (or was NOT) issued.
function mkGql(opts) {
  opts = opts || {};
  function gql(query, variables) {
    gql.calls.push({ q: query, v: variables });
    if (/patchWorkOrder/.test(query)) return Promise.resolve({ patchWorkOrder: { success: opts.patchFail ? false : true, message: opts.patchFail ? 'refused' : '' } });
    if (/workOrder\s*\(/.test(query)) return Promise.resolve({ workOrder: (opts.wo === undefined ? { sourceJobNumber: null, clientWorkOrderNumber: null } : opts.wo) });
    return Promise.resolve({});
  }
  gql.calls = [];
  return gql;
}
function patchCalls(g) { return g.calls.filter(function (c) { return /patchWorkOrder/.test(c.q); }); }

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
    BWN_MODULES: opts.modules || { bulkSource: true },
    bwnGql: gql
  };
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + S_OPS + '\n' + (engSrc || S_ENG) + '\n' +
    'return { run: bwnGqlOp, auditAll: bwnAuditAll,\n' +
    '  bulkExecSrc: bulkExecSrc, srcValueFor: srcValueFor, overCap: overCap, runPool: runPool,\n' +
    '  bulkTally: bulkTally, cond: cond, BULK_SRC_MAX: BULK_SRC_MAX };\n})()',
    sandbox, { filename: 'bulk-source.js' });
  return { api: api, gql: gql };
}
function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 6); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}

(async function () {
  // ---- pure helpers -------------------------------------------------------------------------
  var e = makeEnv();
  A.eq('cond wraps {shouldInclude:true, value}', e.api.cond('x'), { shouldInclude: true, value: 'x' });

  // ---- srcValueFor: the whole shorthand contract, pure ---------------------------------------
  A.eq('Q/R is always "Q/R (WO#)" (client# ignored)', e.api.srcValueFor('qr', 386473, 'CLI-9'), 'Q/R (386473)');
  A.eq('Q/R coerces a string WO#', e.api.srcValueFor('qr', '386473', null), 'Q/R (386473)');
  A.eq('RF uses the client WO# when present', e.api.srcValueFor('rf', 386473, 'CLI-9'), 'RF (CLI-9)');
  A.eq('RF falls back to WO# when client# is null', e.api.srcValueFor('rf', 386473, null), 'RF (386473)');
  A.eq('RF falls back to WO# when client# is empty', e.api.srcValueFor('rf', 386473, ''), 'RF (386473)');
  A.eq('RF trims whitespace-only client# to the WO# fallback', e.api.srcValueFor('rf', 386473, '   '), 'RF (386473)');
  A.eq('RF trims a padded client#', e.api.srcValueFor('rf', 386473, '  CLI-9  '), 'RF (CLI-9)');

  // ---- caps -----------------------------------------------------------------------------------
  A.eq('cap is 50', e.api.BULK_SRC_MAX, 50);
  A.ok('overCap(50) is within the cap', !e.api.overCap(50).refused);
  A.ok('overCap(51) is refused', e.api.overCap(51).refused);
  A.eq('overCap reports the overage', e.api.overCap(53).over, 3);

  // ---- Q/R run happy: one patch, exact single-scalar shape, audited ok -----------------------
  e = makeEnv({ wo: { sourceJobNumber: null, clientWorkOrderNumber: null } });
  var rQ = await e.api.bulkExecSrc('run', 'qr', '386473');
  await tick();
  A.eq('Q/R run: outcome done', rQ.outcome, 'done');
  A.eq('Q/R run: exactly one patch', patchCalls(e.gql).length, 1);
  var data = patchCalls(e.gql)[0].v.data;
  A.eq('Q/R run: data keys are ONLY workOrderNumber + sourceJobNumber', Object.keys(data).sort(), ['sourceJobNumber', 'workOrderNumber']);
  A.eq('Q/R run: workOrderNumber is numeric', data.workOrderNumber, 386473);
  A.eq('Q/R run: sourceJobNumber is a cond-wrapped value', data.sourceJobNumber, { shouldInclude: true, value: 'Q/R (386473)' });
  A.eq('Q/R run: high-risk write audited ok (confirmed:true unblocked the gate)', (e.api.auditAll()[0] || {}).outcome, 'ok');

  // ---- RF run: uses the client WO# from the read ---------------------------------------------
  e = makeEnv({ wo: { sourceJobNumber: '', clientWorkOrderNumber: 'AMZ-55' } });
  var rR = await e.api.bulkExecSrc('run', 'rf', '400001');
  await tick();
  A.eq('RF run: value uses the client WO#', patchCalls(e.gql)[0].v.data.sourceJobNumber.value, 'RF (AMZ-55)');
  A.eq('RF run: outcome done', rR.outcome, 'done');

  // ---- RF run with no client WO#: WO# fallback ----------------------------------------------
  e = makeEnv({ wo: { sourceJobNumber: null, clientWorkOrderNumber: null } });
  await e.api.bulkExecSrc('run', 'rf', '400002');
  await tick();
  A.eq('RF run: WO# fallback when the WO has no client WO#', patchCalls(e.gql)[0].v.data.sourceJobNumber.value, 'RF (400002)');

  // ---- blanks-only: a WO that already has a Source Job# is a no-op, NO patch ------------------
  e = makeEnv({ wo: { sourceJobNumber: 'RF (99999)', clientWorkOrderNumber: null } });
  var rNoop = await e.api.bulkExecSrc('run', 'qr', '386473');
  await tick();
  A.eq('blanks-only: outcome no-op', rNoop.outcome, 'noop');
  A.eq('blanks-only: reason already-set', rNoop.reason, 'already-set');
  A.eq('blanks-only: NO patch issued', patchCalls(e.gql).length, 0);
  A.eq('blanks-only: no audit entry (no write)', e.api.auditAll().length, 0);

  // whitespace-only source counts as blank -> writes
  e = makeEnv({ wo: { sourceJobNumber: '   ', clientWorkOrderNumber: null } });
  await e.api.bulkExecSrc('run', 'qr', '386473');
  await tick();
  A.eq('blanks-only: a whitespace-only Source Job# is treated as blank and DOES write', patchCalls(e.gql).length, 1);

  // ---- dry run: builds the exact vars, sends ZERO writes -------------------------------------
  e = makeEnv({ wo: { sourceJobNumber: null, clientWorkOrderNumber: 'C1' } });
  var rDry = await e.api.bulkExecSrc('dry', 'rf', '386473');
  await tick();
  A.eq('dry: outcome would-send', rDry.outcome, 'would-send');
  A.eq('dry: the vars it WOULD send', rDry.vars.data.sourceJobNumber.value, 'RF (C1)');
  A.eq('dry: ZERO patches sent', patchCalls(e.gql).length, 0);
  A.eq('dry: no audit entry (no write)', e.api.auditAll().length, 0);

  // ---- dry run over an already-set WO: no-op verdict, still zero writes ----------------------
  e = makeEnv({ wo: { sourceJobNumber: 'x', clientWorkOrderNumber: null } });
  var rDryNoop = await e.api.bulkExecSrc('dry', 'qr', '386473');
  await tick();
  A.eq('dry no-op: outcome no-op for an already-set WO', rDryNoop.outcome, 'noop');
  A.eq('dry no-op: still zero patches', patchCalls(e.gql).length, 0);

  // ---- kill switch: feature OFF refuses the write (audited denied) ---------------------------
  e = makeEnv({ wo: { sourceJobNumber: null, clientWorkOrderNumber: null }, modules: { bulkSource: false } });
  var refused = false;
  await e.api.bulkExecSrc('run', 'qr', '386473').then(function () { }, function () { refused = true; });
  await tick();
  A.ok('kill switch: a run with bulkSource OFF is REFUSED', refused);
  A.eq('kill switch: no patch left the browser', patchCalls(e.gql).length, 0);
  A.eq('kill switch: audited denied', (e.api.auditAll()[0] || {}).outcome, 'denied');

  // ---- runPool: bounded, sparse results, cancel stops NEW rows -------------------------------
  e = makeEnv();
  var seen = [];
  var out = await e.api.runPool([1, 2, 3, 4], function (x) { seen.push(x); return Promise.resolve(x * 10); }, 2, null, function () { return false; });
  A.eq('runPool ran every item', seen.sort(function (a, b) { return a - b; }), [1, 2, 3, 4]);
  A.eq('runPool results are positional', out, [10, 20, 30, 40]);
  var ran = [];
  await e.api.runPool([1, 2, 3, 4], function (x) { ran.push(x); return Promise.resolve(x); }, 1, null, function () { return true; });
  A.eq('runPool with shouldStop()=true hands out no rows', ran, []);

  // ---- bulkTally: 4-state split, holes counted ----------------------------------------------
  A.eq('bulkTally counts done/noop/failed/not-run',
    e.api.bulkTally([{ outcome: 'done' }, { outcome: 'noop' }, { error: 'x' }, undefined], 4),
    { done: 1, noop: 1, failed: 1, notRun: 1 });

  // ---- NEGATIVE CONTROLS (each proves a guard is load-bearing) -------------------------------
  // (1) Neuter the blanks-only pre-check -> an already-set WO gets OVERWRITTEN (a patch is issued).
  await (async function () {
    var mut = mutate(S_ENG, "if (cur) return { op: 'src', wo: wo, outcome: 'noop'", "if (false) return { op: 'src', wo: wo, outcome: 'noop'");
    var m = makeEnv({ wo: { sourceJobNumber: 'ALREADY', clientWorkOrderNumber: null } }, mut);
    await m.api.bulkExecSrc('run', 'qr', '386473');
    await tick();
    A.eq('CONTROL: disabling the blanks-only check DOES overwrite (the check is load-bearing)', patchCalls(m.gql).length, 1);
  })();

  // (2) Neuter the dry gate -> a dry-run accidentally WRITES.
  await (async function () {
    var mut = mutate(S_ENG, "if (mode === 'dry') return { op: 'src', wo: wo, outcome: 'would-send'", "if (false) return { op: 'src', wo: wo, outcome: 'would-send'");
    var m = makeEnv({ wo: { sourceJobNumber: null, clientWorkOrderNumber: null } }, mut);
    await m.api.bulkExecSrc('dry', 'qr', '386473');
    await tick();
    A.eq('CONTROL: neutering the dry gate DOES write (the dry gate is load-bearing)', patchCalls(m.gql).length, 1);
  })();

  // (3) Flip the RF fallback to Q/R's unconditional WO# -> RF stops honouring the client WO#.
  await (async function () {
    var mut = mutate(S_ENG, "return 'RF (' + (client || wo) + ')';", "return 'RF (' + wo + ')';");
    var m = makeEnv({ wo: { sourceJobNumber: null, clientWorkOrderNumber: 'C1' } }, mut);
    await m.api.bulkExecSrc('run', 'rf', '386473');
    await tick();
    A.eq('CONTROL: dropping the client-WO# branch makes RF ignore it (the branch is load-bearing)', patchCalls(m.gql)[0].v.data.sourceJobNumber.value, 'RF (386473)');
  })();

  A.finish();
})().catch(function (e) { console.error('\nHARNESS ERROR:', e && e.stack || e); process.exit(2); });
