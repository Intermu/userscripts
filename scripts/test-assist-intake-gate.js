// test-assist-intake-gate.js - node harness for the Next-Actions INTAKE ACTIONABILITY
// gate, shipped in bwn-suite-core 1.66.34 / WO Assist 2.68 (Phase 2 of
// next-actions-overhaul).
//
// THE FEATURE, as found in source:
//   A WO created without the fields it needs to be worked (no NTE, no priority, no site)
//   stalls downstream - unassignable, mis-scheduled, wrong vendor - but nothing surfaced
//   that at inception. The gate fires ONLY pre-dispatch (intake / schedule / accept) and
//   lists exactly what is missing. RELIABLE fields (NTE, priority, site) drive the
//   trigger; trade/scope are ADVISORY (the label read can be absent even when set), so an
//   empty trade/scope read only ADDS a "verify" item - it never blocks or false-completes.
//
// WHAT THIS PROVES, against the REAL shipped bytes (sliced from bwn-suite-core.user.js
// and run in a vm - nothing here restates the logic):
//   - the gate is silent outside intake/schedule/accept, whatever is missing.
//   - a fully-specified WO produces NO intake step (self-clears).
//   - NTE, priority and site are the hard-required set; each missing one is listed.
//   - trade and scope are soft: their absence adds a "Verify" note, never a "Required" one.
//   - the step key encodes the missing SET, so it reopens if a different field drops and
//     self-clears when all are set (never orphans a checked state on a field flap).
//
// WHAT IT DOES NOT PROVE:
//   - that headerInfo() actually reads trade/scope/site on a live WO - only a real WO
//     does, and the softness of trade/scope exists precisely because that read is
//     unreliable. This harness pins the LOGIC given the fields; the live gate is a
//     genuinely incomplete WO showing the right missing list and a complete one showing
//     nothing.
//   - anything about how the checklist RENDERS or scores the step.
//
// Every case re-runs against mutated copies of the same source; each mutation MUST turn
// this harness red. mutate() throws if its target is absent or not unique. The slice
// throws if the gate is not in source, so this is also the tripwire for it going missing.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-intake-gate.js

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
  return coreFull.slice(a, b);
}

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S_PRIO = slice('  function bwnPrioNum(prioText)', '  function bwnPrioMult', 'bwnPrioNum');
var S_INTAKE = slice(
  '      // ---- Intake actionability gate (Phase 2)',
  "      if (state.stall) {\n        acts.push({\n          key: 'stall:'",
  'intake gate block');

// Wrap the real gate block so a test can drive it with the (woPhase, state, hd, ref)
// the real caller supplies. bwnPrioNum is the real one-liner, not a stub.
function build(prioSrc, gateSrc) {
  var sandbox = { String: String, Array: Array, console: console };
  vm.createContext(sandbox);
  var src =
    '(function () {\n' +
    prioSrc + '\n' +
    'function intakeFrag(woPhase, state, hd, ref) {\n  var acts = [];\n' + gateSrc + '\n  return acts;\n}\n' +
    'return { intakeFrag: intakeFrag };\n})()';
  return vm.runInContext(src, sandbox, { filename: 'intake-gate.js' });
}

function runCases(prioSrc, gateSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }

  var m;
  try { m = build(prioSrc, gateSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  function gate(woPhase, nte, prio, hd) { return m.intakeFrag(woPhase, { nte: nte, priority: prio }, hd || {}, 'W-1'); }
  var FULL_HD = { location: 'Store 12', trade: 'HVAC', scope: 'Replace RTU' };
  var NTE_OK = { amount: 5000 };

  // --- phase gating: only fires pre-dispatch, whatever is missing
  eq('a job already in flight is never re-litigated (onsite, everything missing)', gate('onsite', null, '', {}).length, 0);
  eq('nor at proposal', gate('proposal', null, '', {}).length, 0);

  // --- self-clears on a fully specified WO
  eq('a fully-specified intake WO produces no step', gate('intake', NTE_OK, 'P2', FULL_HD).length, 0);

  // --- one hard field missing
  var noNte = gate('intake', null, 'P2', FULL_HD);
  eq('exactly one step when only NTE is missing', noNte.length, 1);
  eq('and its key names the missing NTE', noNte[0].key, 'intake:NTE / client budget');
  ok('the why calls a hard field REQUIRED', (noNte[0].why || '').indexOf('Required field(s) not set') !== -1, noNte[0].why);

  // --- all three hard fields missing (site = neither location nor addr)
  var allHard = gate('intake', { amount: 0 }, '', { trade: 'HVAC', scope: 'x' });
  eq('all three hard fields listed, in order', allHard[0].key, 'intake:NTE / client budget,priority (P1-P4),site / location');

  // --- soft only: trade + scope absent, hard fields all present
  var softOnly = gate('intake', NTE_OK, 'P1', { location: 'Store 9' });
  eq('a soft-only gap still surfaces a step', softOnly.length, 1);
  eq('keyed by the soft fields', softOnly[0].key, 'intake:trade,scope of work');
  ok('soft fields are asked to be VERIFIED', (softOnly[0].why || '').indexOf('Verify: trade, scope of work') !== -1, softOnly[0].why);
  ok('and a soft-only gap is NEVER phrased as a required-field block', (softOnly[0].why || '').indexOf('Required field(s)') === -1, softOnly[0].why);

  // --- the key reopens when a DIFFERENT field drops (never orphans a checked state)
  var noPrio = gate('intake', NTE_OK, '', FULL_HD);
  ok('a different missing field yields a different key', noNte[0].key !== noPrio[0].key, noNte[0].key + ' vs ' + noPrio[0].key);

  // --- fires on schedule and accept as well as intake
  eq('the gate also fires at schedule', gate('schedule', null, 'P2', FULL_HD).length, 1);
  eq('and at accept', gate('accept', null, 'P2', FULL_HD).length, 1);

  return out;
}

// ---- Negative controls ------------------------------------------------------
var MUTATIONS = [
  { what: 'the gate escaping its pre-dispatch phases',
    gate: function (s) { return mutate(s, "if (woPhase === 'intake' || woPhase === 'schedule' || woPhase === 'accept') {", 'if (true) {'); } },
  { what: 'a step pushed even when nothing is missing',
    gate: function (s) { return mutate(s, 'if (allMiss.length) {', 'if (true) {'); } },
  { what: 'the NTE presence test inverted',
    gate: function (s) { return mutate(s, 'if (!(state.nte && state.nte.amount > 0)) miss.push', 'if ((state.nte && state.nte.amount > 0)) miss.push'); } },
  { what: 'priority no longer required',
    gate: function (s) { return mutate(s, 'if (!bwnPrioNum(state.priority)) miss.push', 'if (bwnPrioNum(state.priority)) miss.push'); } },
  { what: 'trade promoted from advisory to a hard block',
    gate: function (s) { return mutate(s, "if (!String(hd.trade || '').trim()) softMiss.push('trade');", "if (!String(hd.trade || '').trim()) miss.push('trade');"); } },
  { what: 'the key delimiter changed (checked-state migration would break)',
    gate: function (s) { return mutate(s, "key: 'intake:' + allMiss.join(',')", "key: 'intake:' + allMiss.join(';')"); } }
];

function main() {
  console.log('\n-- the shipped intake actionability gate --');
  var results = runCases(S_PRIO, S_INTAKE);
  results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

  console.log('\n-- negative controls: each must turn the cases above red --');
  MUTATIONS.forEach(function (mm) {
    var gateSrc = mm.gate ? mm.gate(S_INTAKE) : S_INTAKE;
    var prioSrc = mm.prio ? mm.prio(S_PRIO) : S_PRIO;
    var rs;
    try { rs = runCases(prioSrc, gateSrc); }
    catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
  });

  A.finish();
}

main();
