// test-bulk-source.js - the Bulk Source Job# engine (Core module, flag bulkSource default OFF).
//
// WHAT THIS PROVES, against the REAL shipped bytes of bwn-suite-core.user.js: the
// BULK-SOURCE-ENGINE region (the pure, DOM-free write engine) is sliced out and CONCATENATED with
// the BWN-OPS region (the audited bwnGqlOp wrapper + registry), then run in a vm with a fake
// localStorage and an injectable bwnGql transport - so the batch write path is exercised end to end
// through the real audit ring + fail-closed high-risk confirm gate, not a stub.
//
//   ref number     the parens carry the TRACKING number, falling back to the WO number when blank.
//   Q/R value      "Q/R (tracking# else WO#)".
//   RF value       "RF (clientWorkOrderNumber)" when present, else "RF (tracking# else WO#)".
//   Source PO#     with setPO, a BLANK Source PO# is also set to "N/A" in the SAME atomic patch.
//   blanks only    per field: an already-set Source Job# / Source PO# is skipped (re-checked at
//                  write time). A row with nothing writable no-ops with zero writes.
//   write shape    patchWorkOrder data = { workOrderNumber, sourceJobNumber?, sourcePurchaseOrderNumber? }
//                  - only the fields being written, each a ConditionalStringInput (no whole-object hazard).
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
A.ok('WOSRC_READ_Q reads sourceJobNumber + sourcePurchaseOrderNumber + clientWorkOrderNumber + trackingNumber',
  S_ENG.indexOf("var WOSRC_READ_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ sourceJobNumber sourcePurchaseOrderNumber clientWorkOrderNumber trackingNumber } }';") !== -1);
A.ok('WOSRC_PATCH_M is the patchWorkOrder success/message mutation',
  S_ENG.indexOf("var WOSRC_PATCH_M = 'mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }';") !== -1);

// ---- source-level ship-safety: the module is gated OFF and nothing mounts when the flag is off ----
A.ok('bulkSource flag ships default OFF', /bulkSource: false,/.test(coreFull));
A.ok('the whole module mounts only behind BWN_MODULES.bulkSource', /bwnBoot\('bulkSource', BWN_MODULES\.bulkSource, function \(\) \{/.test(coreFull));
A.ok('the write passes feature:bulkSource + confirmed:true to the wrapper', /feature: 'bulkSource', confirmed: true/.test(S_ENG));

// ---- UI-layer regression guards. The selection + checkbox-injection code is NOT in the sliced
// (DOM-free) engine, so two live bugs escaped through it during the smoke: (1) Array.prototype.slice
// .call() on a Set returns [] - a Set is not array-like - which made selList() always empty, so Dry
// Run silently no-op'd even with rows checked; (2) inserting the checkbox before the WO <a> failed
// with NotFoundError because the anchor is nested (td > div > a), not a direct child of the td. Lock
// both fixes by source pattern so neither can regress. ----
A.ok('selList converts the Set with Array.from (slice.call on a Set yields [])', /function selList\(\) \{ return Array\.from\(selected\)/.test(coreFull));
A.ok('selList never uses Array.prototype.slice on the Set (that returns [])', !/slice\.call\(selected\)/.test(coreFull));
A.ok('the row checkbox mounts at the cell edge (cell.firstChild), not before the nested anchor', /cell\.insertBefore\(cb, cell\.firstChild\)/.test(coreFull));
A.ok('ensureBoxes never inserts before the WO anchor (nested, not a direct child of the td)', !/insertBefore\(cb, anchor\)/.test(coreFull));

// A full WorkOrder read record with the four fields the engine reads; override per test.
function WO(o) { return Object.assign({ sourceJobNumber: null, sourcePurchaseOrderNumber: null, clientWorkOrderNumber: null, trackingNumber: null }, o || {}); }

// Programmable bwnGql: records every call so a test can assert what was (or was NOT) issued.
function mkGql(opts) {
  opts = opts || {};
  function gql(query, variables) {
    gql.calls.push({ q: query, v: variables });
    if (/patchWorkOrder/.test(query)) return Promise.resolve({ patchWorkOrder: { success: opts.patchFail ? false : true, message: opts.patchFail ? 'refused' : '' } });
    if (/workOrder\s*\(/.test(query)) return Promise.resolve({ workOrder: (opts.wo === undefined ? WO() : opts.wo) });
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
function keys(o) { return Object.keys(o).sort(); }

(async function () {
  // ---- pure helpers -------------------------------------------------------------------------
  var e = makeEnv();
  A.eq('cond wraps {shouldInclude:true, value}', e.api.cond('x'), { shouldInclude: true, value: 'x' });

  // ---- srcValueFor: the whole shorthand contract, pure. Args (op, wo, client, tracking). ----
  A.eq('Q/R uses the tracking number', e.api.srcValueFor('qr', 386473, 'CLI-9', 'TRK-1'), 'Q/R (TRK-1)');
  A.eq('Q/R falls back to the WO# when no tracking number', e.api.srcValueFor('qr', 386473, 'CLI-9', null), 'Q/R (386473)');
  A.eq('Q/R WO# fallback also on empty/whitespace tracking', e.api.srcValueFor('qr', 386473, null, '   '), 'Q/R (386473)');
  A.eq('Q/R coerces a string WO#', e.api.srcValueFor('qr', '386473', null, null), 'Q/R (386473)');
  A.eq('RF prefers the client WO# over the tracking number', e.api.srcValueFor('rf', 386473, 'CLI-9', 'TRK-1'), 'RF (CLI-9)');
  A.eq('RF uses the tracking number when there is no client WO#', e.api.srcValueFor('rf', 386473, null, 'TRK-1'), 'RF (TRK-1)');
  A.eq('RF falls back to WO# when neither client nor tracking', e.api.srcValueFor('rf', 386473, '', ''), 'RF (386473)');
  A.eq('RF trims a padded client#', e.api.srcValueFor('rf', 386473, '  CLI-9  ', 'TRK-1'), 'RF (CLI-9)');
  A.eq('RF trims a padded tracking#', e.api.srcValueFor('rf', 386473, null, '  TRK-1  '), 'RF (TRK-1)');

  // ---- caps -----------------------------------------------------------------------------------
  A.eq('cap is 50', e.api.BULK_SRC_MAX, 50);
  A.ok('overCap(50) is within the cap', !e.api.overCap(50).refused);
  A.ok('overCap(51) is refused', e.api.overCap(51).refused);
  A.eq('overCap reports the overage', e.api.overCap(53).over, 3);

  // ---- Q/R run happy (no tracking#): one patch, single field, WO# fallback, audited ok --------
  e = makeEnv({ wo: WO() });
  var rQ = await e.api.bulkExecSrc('run', 'qr', '386473');
  await tick();
  A.eq('Q/R run: outcome done', rQ.outcome, 'done');
  A.eq('Q/R run: exactly one patch', patchCalls(e.gql).length, 1);
  var data = patchCalls(e.gql)[0].v.data;
  A.eq('Q/R run: data keys are ONLY workOrderNumber + sourceJobNumber (setPO off)', keys(data), ['sourceJobNumber', 'workOrderNumber']);
  A.eq('Q/R run: workOrderNumber is numeric', data.workOrderNumber, 386473);
  A.eq('Q/R run: sourceJobNumber is the WO# fallback value', data.sourceJobNumber, { shouldInclude: true, value: 'Q/R (386473)' });
  A.eq('Q/R run: high-risk write audited ok (confirmed:true unblocked the gate)', (e.api.auditAll()[0] || {}).outcome, 'ok');

  // ---- Q/R run uses the tracking number when present -----------------------------------------
  e = makeEnv({ wo: WO({ trackingNumber: 'TRK-7' }) });
  await e.api.bulkExecSrc('run', 'qr', '386473');
  await tick();
  A.eq('Q/R run: value is the tracking number, not W-######', patchCalls(e.gql)[0].v.data.sourceJobNumber.value, 'Q/R (TRK-7)');

  // ---- RF run: client WO# beats tracking ----------------------------------------------------
  e = makeEnv({ wo: WO({ clientWorkOrderNumber: 'AMZ-55', trackingNumber: 'TRK-9' }) });
  var rR = await e.api.bulkExecSrc('run', 'rf', '400001');
  await tick();
  A.eq('RF run: value uses the client WO# over tracking', patchCalls(e.gql)[0].v.data.sourceJobNumber.value, 'RF (AMZ-55)');
  A.eq('RF run: outcome done', rR.outcome, 'done');

  // ---- RF run: no client -> tracking; no tracking -> WO# ------------------------------------
  e = makeEnv({ wo: WO({ trackingNumber: 'TRK-2' }) });
  await e.api.bulkExecSrc('run', 'rf', '400002');
  await tick();
  A.eq('RF run: tracking used when no client WO#', patchCalls(e.gql)[0].v.data.sourceJobNumber.value, 'RF (TRK-2)');
  e = makeEnv({ wo: WO() });
  await e.api.bulkExecSrc('run', 'rf', '400003');
  await tick();
  A.eq('RF run: WO# fallback when no client and no tracking', patchCalls(e.gql)[0].v.data.sourceJobNumber.value, 'RF (400003)');

  // ---- Source PO# = N/A (setPO true): both blank -> one atomic patch with BOTH fields --------
  e = makeEnv({ wo: WO({ trackingNumber: 'TRK-1' }) });
  var rBoth = await e.api.bulkExecSrc('run', 'qr', '386473', true);
  await tick();
  A.eq('PO both-blank: exactly one patch', patchCalls(e.gql).length, 1);
  var d2 = patchCalls(e.gql)[0].v.data;
  A.eq('PO both-blank: BOTH fields in one write', keys(d2), ['sourceJobNumber', 'sourcePurchaseOrderNumber', 'workOrderNumber']);
  A.eq('PO both-blank: Source Job# value', d2.sourceJobNumber.value, 'Q/R (TRK-1)');
  A.eq('PO both-blank: Source PO# is N/A', d2.sourcePurchaseOrderNumber, { shouldInclude: true, value: 'N/A' });
  A.eq('PO both-blank: outcome done', rBoth.outcome, 'done');

  // ---- setPO true, Source Job# already set -> ONLY the PO is written -------------------------
  e = makeEnv({ wo: WO({ sourceJobNumber: 'RF (old)', trackingNumber: 'TRK-1' }) });
  var rPOonly = await e.api.bulkExecSrc('run', 'qr', '386473', true);
  await tick();
  A.eq('PO-only: one patch', patchCalls(e.gql).length, 1);
  A.eq('PO-only: writes ONLY sourcePurchaseOrderNumber (job already set is skipped)', keys(patchCalls(e.gql)[0].v.data), ['sourcePurchaseOrderNumber', 'workOrderNumber']);
  A.eq('PO-only: outcome done, after has PO only', [rPOonly.outcome, rPOonly.after.sourcePO, rPOonly.after.sourceJob], ['done', 'N/A', undefined]);

  // ---- setPO true, Source PO# already set -> ONLY the Job# is written ------------------------
  e = makeEnv({ wo: WO({ sourcePurchaseOrderNumber: 'PO-123', trackingNumber: 'TRK-1' }) });
  await e.api.bulkExecSrc('run', 'qr', '386473', true);
  await tick();
  A.eq('Job-only: writes ONLY sourceJobNumber (PO already set is skipped)', keys(patchCalls(e.gql)[0].v.data), ['sourceJobNumber', 'workOrderNumber']);

  // ---- setPO true, BOTH already set -> no-op, no patch --------------------------------------
  e = makeEnv({ wo: WO({ sourceJobNumber: 'RF (x)', sourcePurchaseOrderNumber: 'PO-9' }) });
  var rBothSet = await e.api.bulkExecSrc('run', 'qr', '386473', true);
  await tick();
  A.eq('both-set: outcome no-op', rBothSet.outcome, 'noop');
  A.eq('both-set: NO patch issued', patchCalls(e.gql).length, 0);

  // ---- blanks-only (setPO off): a WO that already has a Source Job# is a no-op, NO patch ------
  e = makeEnv({ wo: WO({ sourceJobNumber: 'RF (99999)' }) });
  var rNoop = await e.api.bulkExecSrc('run', 'qr', '386473');
  await tick();
  A.eq('blanks-only: outcome no-op', rNoop.outcome, 'noop');
  A.eq('blanks-only: reason already-set', rNoop.reason, 'already-set');
  A.eq('blanks-only: NO patch issued', patchCalls(e.gql).length, 0);
  A.eq('blanks-only: no audit entry (no write)', e.api.auditAll().length, 0);

  // whitespace-only source counts as blank -> writes
  e = makeEnv({ wo: WO({ sourceJobNumber: '   ' }) });
  await e.api.bulkExecSrc('run', 'qr', '386473');
  await tick();
  A.eq('blanks-only: a whitespace-only Source Job# is treated as blank and DOES write', patchCalls(e.gql).length, 1);

  // ---- dry run: builds the exact vars, sends ZERO writes -------------------------------------
  e = makeEnv({ wo: WO({ clientWorkOrderNumber: 'C1' }) });
  var rDry = await e.api.bulkExecSrc('dry', 'rf', '386473', true);
  await tick();
  A.eq('dry: outcome would-send', rDry.outcome, 'would-send');
  A.eq('dry: the Source Job# it WOULD send', rDry.vars.data.sourceJobNumber.value, 'RF (C1)');
  A.eq('dry: the Source PO# it WOULD send (setPO)', rDry.vars.data.sourcePurchaseOrderNumber.value, 'N/A');
  A.eq('dry: ZERO patches sent', patchCalls(e.gql).length, 0);
  A.eq('dry: no audit entry (no write)', e.api.auditAll().length, 0);

  // ---- dry run over an already-set WO: no-op verdict, still zero writes ----------------------
  e = makeEnv({ wo: WO({ sourceJobNumber: 'x' }) });
  var rDryNoop = await e.api.bulkExecSrc('dry', 'qr', '386473');
  await tick();
  A.eq('dry no-op: outcome no-op for an already-set WO', rDryNoop.outcome, 'noop');
  A.eq('dry no-op: still zero patches', patchCalls(e.gql).length, 0);

  // ---- kill switch: feature OFF refuses the write (audited denied) ---------------------------
  e = makeEnv({ wo: WO(), modules: { bulkSource: false } });
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
  // (1) Neuter the Source Job# blanks-only pre-check -> an already-set job gets OVERWRITTEN.
  await (async function () {
    var mut = mutate(S_ENG, 'if (!curJob) { var jv', 'if (true) { var jv');
    var m = makeEnv({ wo: WO({ sourceJobNumber: 'ALREADY' }) }, mut);
    await m.api.bulkExecSrc('run', 'qr', '386473');
    await tick();
    A.eq('CONTROL: disabling the blanks-only check DOES overwrite (the check is load-bearing)', patchCalls(m.gql).length, 1);
  })();

  // (2) Neuter the dry gate -> a dry-run accidentally WRITES.
  await (async function () {
    var mut = mutate(S_ENG, "if (mode === 'dry') return { op: 'src', wo: wo, outcome: 'would-send'", "if (false) return { op: 'src', wo: wo, outcome: 'would-send'");
    var m = makeEnv({ wo: WO() }, mut);
    await m.api.bulkExecSrc('dry', 'qr', '386473');
    await tick();
    A.eq('CONTROL: neutering the dry gate DOES write (the dry gate is load-bearing)', patchCalls(m.gql).length, 1);
  })();

  // (3) Flip the RF fallback to drop the client WO# -> RF stops honouring it.
  await (async function () {
    var mut = mutate(S_ENG, "return 'RF (' + (client || ref) + ')';", "return 'RF (' + ref + ')';");
    var m = makeEnv({ wo: WO({ clientWorkOrderNumber: 'C1' }) }, mut);
    await m.api.bulkExecSrc('run', 'rf', '386473');
    await tick();
    A.eq('CONTROL: dropping the client-WO# branch makes RF ignore it (the branch is load-bearing)', patchCalls(m.gql)[0].v.data.sourceJobNumber.value, 'RF (386473)');
  })();

  // (4) Neuter the Source PO# blanks-only pre-check -> an already-set PO gets OVERWRITTEN.
  await (async function () {
    var mut = mutate(S_ENG, 'if (setPO && !curPO) {', 'if (setPO) {');
    var m = makeEnv({ wo: WO({ sourceJobNumber: 'keep', sourcePurchaseOrderNumber: 'PO-EXISTING' }) }, mut);
    await m.api.bulkExecSrc('run', 'qr', '386473', true);
    await tick();
    A.eq('CONTROL: disabling the PO blanks-only check DOES overwrite the PO (load-bearing)', (patchCalls(m.gql)[0] || { v: { data: {} } }).v.data.sourcePurchaseOrderNumber && patchCalls(m.gql)[0].v.data.sourcePurchaseOrderNumber.value, 'N/A');
  })();

  A.finish();
})().catch(function (e) { console.error('\nHARNESS ERROR:', e && e.stack || e); process.exit(2); });
