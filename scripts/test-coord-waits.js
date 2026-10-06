// test-coord-waits.js - node harness for the Coordinator Action Queue WAITING/REVISIT
// foundation (bwn-suite-core 1.88.0 / WO Assist 2.75). Slices the real COORD-QUEUE block and
// exercises coordFingerprintPure + coordWaitValidPure (and the readiness='scheduled' effect
// through classifyCoordinatorAction) against the shipped bytes.
//
// Contract proven:
//   - a valid, well-formed wait suppresses the action (readiness 'scheduled') before revisitAt
//   - the action re-enters normal evaluation at/after revisitAt
//   - a change in the underlying state (fingerprint mismatch) invalidates the wait
//   - malformed storage (missing revisitAt / fingerprint, wrong version, wrong disposition,
//     mismatched actionKey) does NOT suppress - fail-open to visible
//   - a wait NEVER marks the lifecycle requirement complete (it only changes readiness)
//   - records are keyed by actionKey; a record for one action does not validate another
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-coord-waits.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END not found');
  if (coreFull.indexOf(end, b + 1) !== -1) throw new Error(what + ': END not unique');
  return coreFull.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var COORD_SRC = slice('// ==== COORD-QUEUE BEGIN', '    // Published for the audit / cross-module consumers', 'coord-queue block');
var DEPS =
  'var ESCALATE_DAYS = 14;\n' +
  'var PM = {1:0.25,2:0.5,3:1,4:1.5};\n' +
  'function bwnPrioNum(p){ var m=String(p||"").match(/p\\s*([1-4])/i); return m?+m[1]:null; }\n' +
  'function bwnPrioMult(p){ var n=bwnPrioNum(p); return (n&&PM[n])||1; }\n' +
  'function bwnThresholdsFor(status,prio,C){ var n=bwnPrioNum(prio); var m=(n&&PM[n])||1; return {warn:24*m,bad:240*m,sla:false}; }\n' +
  'function scoreAct(a,state){ return a.baseHint!=null?a.baseHint:50; }\n';

function build(src) {
  var sandbox = { Math: Math, Date: Date, JSON: JSON, console: console };
  vm.createContext(sandbox);
  var body = DEPS + src + '\n return { coordFingerprintPure:coordFingerprintPure, coordWaitValidPure:coordWaitValidPure, classifyCoordinatorAction:classifyCoordinatorAction, COORD_WAIT_V:COORD_WAIT_V };';
  return vm.runInContext('(function(){\n' + body + '\n})()', sandbox, { filename: 'coord-waits.js' });
}

var NOW = Date.parse('2026-09-22T12:00:00Z');
var FUTURE = new Date(NOW + 86400000).toISOString();
var PAST = new Date(NOW - 3600000).toISOString();

function runCases(src) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  var m;
  try { m = build(src); } catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  var V = m.COORD_WAIT_V;
  var A_STALL = { key: 'stall:V:9/1', text: 'x' };
  // A stall on an overdue vendor: without a wait it is coordinator/ready.
  var baseState = { status: 'Scheduled', priority: 'P3', hrs: 10, stall: { vendor: 'V', date: '9/1', days: 20 }, pos: [{ sid: 's1', done: false, poStatus: 'confirm', schedDate: '9/1' }], docs: { count: 0 }, due: { raw: '9/30' } };
  function rec(over) {
    var r = { v: V, actionKey: A_STALL.key, disposition: 'waiting', waitingOn: 'vendor', revisitAt: FUTURE, stateFingerprint: m.coordFingerprintPure(A_STALL, baseState), createdAt: PAST };
    if (over) for (var k in over) r[k] = over[k];
    return r;
  }
  function valid(r, a, state) { return m.coordWaitValidPure(r, a || A_STALL, state || baseState, NOW); }
  function withWait(r, state) { var s = {}; for (var k in (state || baseState)) s[k] = (state || baseState)[k]; s.waits = {}; s.waits[A_STALL.key] = r; return s; }

  // 1. A valid wait before revisitAt suppresses the action.
  ok('a valid, current wait is valid', valid(rec()) === true, '');
  ok('...and the action reads as scheduled (suppressed), not complete',
    m.classifyCoordinatorAction(A_STALL, withWait(rec()), {}, NOW).readiness === 'scheduled', '');

  // 2. At/after revisitAt the action re-enters normal evaluation.
  ok('a past-revisit wait is invalid', valid(rec({ revisitAt: PAST })) === false, '');
  ok('...and the action returns to ready/coordinator', m.classifyCoordinatorAction(A_STALL, withWait(rec({ revisitAt: PAST })), {}, NOW).readiness === 'ready', '');

  // 3. A state change (fingerprint mismatch) invalidates the wait.
  var moved = {}; for (var k in baseState) moved[k] = baseState[k]; moved.status = 'Work Complete';
  ok('a wait taken against a now-changed status is invalid', valid(rec(), A_STALL, moved) === false, '');
  var posChanged = {}; for (var k2 in baseState) posChanged[k2] = baseState[k2]; posChanged.pos = [{ sid: 's1', done: true, poStatus: 'confirm', schedDate: '9/1' }];
  ok('a wait taken before a PO completed is invalid', valid(rec(), A_STALL, posChanged) === false, '');

  // 4. Malformed / unknown storage NEVER suppresses (fail-open to visible).
  ok('missing revisitAt does not suppress', valid(rec({ revisitAt: '' })) === false, '');
  ok('missing fingerprint does not suppress', valid(rec({ stateFingerprint: '' })) === false, '');
  ok('an unparseable revisitAt does not suppress', valid(rec({ revisitAt: 'not-a-date' })) === false, '');
  ok('a wrong schema version does not suppress', valid(rec({ v: 999 })) === false, '');
  ok('a non-waiting disposition does not suppress', valid(rec({ disposition: 'done' })) === false, '');
  ok('a null record does not suppress', valid(null) === false, '');

  // 5. Records are keyed by actionKey; one action's wait never validates another.
  ok('a record for another action does not validate this one', valid(rec({ actionKey: 'stall:OTHER:1' })) === false, '');
  ok('distinct actions produce distinct fingerprints',
    m.coordFingerprintPure({ key: 'poconf:s1:V' }, baseState) !== m.coordFingerprintPure({ key: 'pomat:s1:V' }, baseState), '');

  // 6. Fingerprint is stable across an unrelated re-read (same inputs -> same value).
  ok('the fingerprint is deterministic for identical state', m.coordFingerprintPure(A_STALL, baseState) === m.coordFingerprintPure(A_STALL, baseState), '');

  return out;
}

var MUTATIONS = [
  { what: 'an expired wait is no longer treated as expired',
    fn: function (s) { return mutate(s, 'if (isNaN(due) || now >= due) return false;', 'if (isNaN(due) || now >= due + 1e15) return false;'); } },
  { what: 'the fingerprint no longer invalidates on a state change',
    fn: function (s) { return mutate(s, 'if (rec.stateFingerprint !== coordFingerprintPure(a, state)) return false;', 'if (false) return false;'); } },
  { what: 'a non-waiting disposition is allowed to suppress',
    fn: function (s) { return mutate(s, "rec.disposition !== 'waiting') return false;", "rec.disposition !== 'never') return false;"); } },
  { what: "a PO's done flag drops out of the fingerprint (a completed PO no longer cancels a wait)",
    fn: function (s) { return mutate(s, "(p.done ? 'd' : '')", "''"); } }
];

function main() {
  console.log('\n-- Coordinator Action Queue: waiting/revisit foundation against the shipped bytes --');
  runCases(COORD_SRC).forEach(function (r) { A.ok(r.name, r.ok, r.detail); });
  console.log('\n-- negative controls: each must turn a case above red --');
  MUTATIONS.forEach(function (mm) {
    var rs;
    try { rs = runCases(mm.fn(COORD_SRC)); } catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case');
  });
  A.finish();
}
main();
