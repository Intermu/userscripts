// test-assist-priority-clock.js - node harness for the Next-Actions PRIORITY-SCALED
// status clock and the escalation fire/severity math, shipped in bwn-suite-core
// 1.66.34 / WO Assist 2.68 (Phases 1 + 3 of next-actions-overhaul).
//
// THE FEATURE, as found in source:
//   The playbook used to chase every WO on one clock: a flat ESCALATE_DAYS = 14 and a
//   hardcoded "way past" at 720h, regardless of priority - so a P1 emergency and a P4
//   backlog job escalated on the same schedule. Phase 1 routed the shared
//   bwnThresholdsFor(status, prio, C) clock into the engine. This harness pins that math.
//
// WHAT THIS PROVES, against the REAL shipped bytes (sliced from bwn-suite-core.user.js
// and run in a vm - nothing here restates the logic):
//   - bwnThresholdsFor scales the bad-hours limit by PRIO_MULT: P1 0.25x, P2 0.5x,
//     P3 1.0x (neutral), P4 1.5x; an unparseable priority is neutral, never harsher.
//   - escDays = max(2, round(14 * prioMult)): P1 ~4d, P2 7d, P3 14d, P4 ~21d.
//   - a vendor miss escalates only past escDays, and P1 escalates SOONER than P3 on the
//     identical stall - the headline behavioural claim.
//   - escSev is how far past the clock: stall days/escDays; wait-on-client hrs/(2*bad),
//     so sev is exactly 1 at the 2x-limit fire point; GP-underwater forced to 3 (a
//     write-down is a management call regardless of the clock).
//   - the "way past" flag is overRatio >= 3, which reproduces the old 720h at P3
//     (240h base) and now scales - P1 hits it at 180h.
//   - the escalate step is keyed escalate:<phase>:<tier> and feeds (escSev, escPn,
//     escRank) into bwnEscalationTier.
//
// WHAT IT DOES NOT PROVE:
//   - the tier/recipient MAPPING (bwnEscalationTier itself) - that is
//     test-assist-escalation-tier.js. Here it is stubbed to capture its arguments.
//   - that any real WO's Priority field parses to a P-number - only a live WO does
//     (see the BWN_HEAT_CFG note: most client labels are not "P<n>"-shaped).
//   - anything about how the checklist RENDERS the step.
//
// Every case re-runs against mutated copies of the same source; each mutation MUST turn
// this harness red. mutate() throws if its target is absent or not unique, so a control
// that silently no-ops cannot pass. The slices throw if the clock or the escalate block
// is not in source, so this is also the tripwire for either going missing.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-priority-clock.js

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

var S_HELP = slice('  var BWN_HEAT_CFG = {', '  // ---- Next-actions engine, published across module closures', 'BWN_HEAT_CFG + bwnThresholdsFor');
var S_CLOCK = slice('      var th = bwnThresholdsFor(status, state.priority, state.cfg || bwnConfig());', '      var A = {\n        intake:', 'woActionForStatus clock fragment');
var S_ESC = slice("      var waitOnClient = (woPhase === 'client'", '      // ---- Intake actionability gate (Phase 2)', 'escalate block');

// Build the three real slices into callable fns inside one sandbox. The helper slice
// defines the clock helpers; the clock fragment and the escalate block are wrapped so a
// test can drive them with the synthetic state compute() would hand over. Only
// bwnEscalationTier is stubbed - the tier MAPPING is a separate harness.
function build(helpSrc, clockSrc, escSrc) {
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, Math: Math,
    JSON: JSON, isFinite: isFinite, console: console,
    BWN: { cfg: function () { return { activeMult: 1.0, hrsWarn: 120, hrsBad: 240 }; } }
  };
  vm.createContext(sandbox);
  var src =
    '(function () {\n' +
    helpSrc + '\n' +
    'function bwnConfig() { return BWN.cfg(); }\n' +
    'function clockFrag(status, state) {\n' + clockSrc + '\n' +
    '  return { badHours: th.bad, overRatio: overRatio, stale720: stale720 };\n}\n' +
    'function escFrag(woPhase, state, C, ref, ESCALATE_DAYS, bwnEscalationTier) {\n' +
    '  var acts = [];\n' + escSrc + '\n  return acts;\n}\n' +
    'return { bwnThresholdsFor: bwnThresholdsFor, bwnPrioMult: bwnPrioMult, bwnPrioNum: bwnPrioNum, clockFrag: clockFrag, escFrag: escFrag };\n' +
    '})()';
  return vm.runInContext(src, sandbox, { filename: 'priority-clock.js' });
}

// Returns a result list rather than asserting directly, so the same cases can be re-run
// against a mutant and checked for redness.
function runCases(helpSrc, clockSrc, escSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }

  var m;
  try { m = build(helpSrc, clockSrc, escSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  var C = { activeMult: 1.0, hrsWarn: 120, hrsBad: 240 };
  var ST = 'Pending Acceptance';   // matches neither ACTIVE_RE nor BLOCKED_RE, so only priority moves the base

  // --- bwnThresholdsFor priority scaling (the base 240h bad limit, times PRIO_MULT)
  eq('P1 bad-hours are 0.25x the P3 base', m.bwnThresholdsFor(ST, 'P1', C).bad, 60);
  eq('P2 bad-hours are 0.5x', m.bwnThresholdsFor(ST, 'P2', C).bad, 120);
  eq('P3 bad-hours are the neutral base', m.bwnThresholdsFor(ST, 'P3', C).bad, 240);
  eq('P4 bad-hours are 1.5x', m.bwnThresholdsFor(ST, 'P4', C).bad, 360);
  eq('an unparseable priority label is neutral, never harsher', m.bwnThresholdsFor(ST, 'Emergency Same Day', C).bad, 240);

  // --- escalate fire threshold + severity, driven through the real block
  function escOf(woPhase, state) {
    var calls = [];
    var stub = function (sev, pn, rank) {
      calls.push({ sev: sev, pn: pn, rank: rank });
      return { tier: 2, tierName: 'supervisor', label: 'L', owner: 'supervisor', lead: '' };
    };
    var acts = m.escFrag(woPhase, state, C, 'W-1', 14, stub);
    return { acts: acts, calls: calls };
  }
  function stallState(prio, days) {
    return { status: ST, priority: prio, hrs: null, stall: { vendor: 'Acme', days: days, date: '2026-08-01' }, gpPct: null, nte: null, escRank: null };
  }

  eq('a P3 vendor miss does NOT escalate at 10d (escDays 14)', escOf('schedule', stallState('P3', 10)).acts.length, 0);
  eq('a P3 vendor miss escalates at 28d', escOf('schedule', stallState('P3', 28)).acts.length, 1);
  var p3 = escOf('schedule', stallState('P3', 28));
  eq('escSev is how far past the clock (28/14 = 2)', p3.calls[0].sev, 2);
  eq('the priority number flows into the tier fn as 3', p3.calls[0].pn, 3);
  ok('the step is keyed escalate:<phase>:<tier>', p3.acts[0].key === 'escalate:schedule:2', p3.acts[0].key);
  eq('the engine severity rides on the act for the assist POST', p3.acts[0].sev, 2);

  // --- the headline: P1 escalates SOONER than P3 on the identical 5-day stall
  eq('P1 escalates on a 5-day stall (escDays ~4)', escOf('schedule', stallState('P1', 5)).acts.length, 1);
  eq('P3 does NOT escalate on the same 5-day stall (escDays 14)', escOf('schedule', stallState('P3', 5)).acts.length, 0);

  // --- wait-on-client escalates at 2x the priority-scaled hours limit; sev = 1 at fire
  function waitState(prio, hrs) {
    return { status: 'On Hold', priority: prio, hrs: hrs, stall: null, gpPct: null, nte: null, escRank: null };
  }
  eq('wait-on-client does NOT escalate at 479h (P3 limit 240, fires at 2x = 480)', escOf('onhold', waitState('P3', 479)).acts.length, 0);
  var wc = escOf('onhold', waitState('P3', 480));
  eq('wait-on-client escalates at exactly 2x its limit', wc.acts.length, 1);
  eq('and sev is 1 right at the fire point', wc.calls[0].sev, 1);

  // --- GP underwater is a management call regardless of the clock: sev forced to 3
  var gp = escOf('inprogress', { status: ST, priority: 'P4', hrs: 1, stall: null, gpPct: -5, nte: { amount: 100 }, escRank: null });
  eq('GP underwater escalates even on a cold clock', gp.acts.length, 1);
  eq('GP underwater is forced to the top severity (3)', gp.calls[0].sev, 3);

  // --- clock "way past" flag: overRatio >= 3 reproduces 720h at P3, scales for P1
  function clk(prio, hrs) { return m.clockFrag(ST, { priority: prio, hrs: hrs, cfg: C }); }
  ok('P3 720h is exactly 3x its 240h limit -> stale720', clk('P3', 720).stale720 === true, JSON.stringify(clk('P3', 720)));
  ok('P3 719h is just under, not stale720', clk('P3', 719).stale720 === false, JSON.stringify(clk('P3', 719)));
  ok('P1 hits the same "way past" flag at 180h (60h limit)', clk('P1', 180).stale720 === true, JSON.stringify(clk('P1', 180)));
  eq('overRatio is hours over the priority-scaled bad limit', clk('P1', 180).overRatio, 3);

  return out;
}

// ---- Negative controls ------------------------------------------------------
// Each reverts one piece of the real behaviour. A control that cannot go red is worse
// than no control, so every entry is asserted to produce failures.
var MUTATIONS = [
  { what: 'PRIO_MULT inverted (P1 no longer the tightest clock)',
    help: function (s) { return mutate(s, 'PRIO_MULT: { 1: 0.25, 2: 0.5, 3: 1.0, 4: 1.5 }', 'PRIO_MULT: { 1: 1.5, 2: 0.5, 3: 1.0, 4: 0.25 }'); } },
  { what: 'the bad-hours limit stops scaling with priority',
    help: function (s) { return mutate(s, 'return { warn: C.hrsWarn * mult, bad: C.hrsBad * mult, sla: sm !== null };', 'return { warn: C.hrsWarn, bad: C.hrsBad, sla: sm !== null };'); } },
  { what: 'escDays flattened back to a priority-blind 14',
    esc: function (s) { return mutate(s, 'Math.max(2, Math.round(ESCALATE_DAYS * bwnPrioMult(state.priority)))', 'ESCALATE_DAYS'); } },
  { what: 'stall severity hardcoded instead of days/escDays',
    esc: function (s) { return mutate(s, 'escSev = state.stall.days / escDays;', 'escSev = 1;'); } },
  { what: 'wait-on-client fires at the 1x limit, not 2x',
    esc: function (s) { return mutate(s, 'state.hrs >= 2 * escTh.bad', 'state.hrs >= escTh.bad'); } },
  { what: 'GP-underwater no longer forced to the top tier',
    esc: function (s) { return mutate(s, 'escSev = 3;   // a money write-down', 'escSev = 1;   // a money write-down'); } },
  { what: 'the "way past" flag widened below 3x',
    clock: function (s) { return mutate(s, 'var stale720 = overRatio >= 3;', 'var stale720 = overRatio >= 2;'); } }
];

function main() {
  console.log('\n-- the shipped priority clock + escalate math --');
  var results = runCases(S_HELP, S_CLOCK, S_ESC);
  results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

  console.log('\n-- negative controls: each must turn the cases above red --');
  MUTATIONS.forEach(function (mm) {
    var help = mm.help ? mm.help(S_HELP) : S_HELP;
    var clock = mm.clock ? mm.clock(S_CLOCK) : S_CLOCK;
    var esc = mm.esc ? mm.esc(S_ESC) : S_ESC;
    var rs;
    try { rs = runCases(help, clock, esc); }
    catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
  });

  A.finish();
}

main();
