// test-coord-classify.js - node harness for the Coordinator Action Queue CLASSIFICATION
// pass (bwn-suite-core 1.88.0 / WO Assist 2.75). Proves ownership / readiness / urgency /
// friction against the REAL shipped bytes: the COORD-QUEUE block is sliced out of
// bwn-suite-core.user.js and executed in a vm - nothing here restates the logic.
//
// The engine's own timing helpers (bwnThresholdsFor / bwnPrioNum / bwnPrioMult /
// ESCALATE_DAYS) and scoreAct are STUBBED so the cases are deterministic; the classifier's
// own decision logic is the real thing under test.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-coord-classify.js

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
  var body = DEPS + src + '\n return { classifyCoordinatorAction:classifyCoordinatorAction, needsCoordinatorAttention:needsCoordinatorAttention, buildCoordinatorQueue:buildCoordinatorQueue };';
  return vm.runInContext('(function(){\n' + body + '\n})()', sandbox, { filename: 'coord-classify.js' });
}

var NOW = Date.parse('2026-09-22T12:00:00Z');

function runCases(src) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  var m;
  try { m = build(src); } catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }
  function cls(a, state) { return m.classifyCoordinatorAction(a, state || {}, {}, NOW); }
  function trip(name, a, state, own, ready, urg) {
    var c = cls(a, state);
    ok(name + ' -> ownership ' + own, c.ownership === own, 'got ' + c.ownership);
    ok(name + ' -> readiness ' + ready, c.readiness === ready, 'got ' + c.readiness);
    if (urg) ok(name + ' -> urgency ' + urg, c.urgency === urg, 'got ' + c.urgency);
    return c;
  }

  // 1. Coordinator-owned overdue vendor follow-up (a hard miss past the escalate clock).
  trip('overdue stall (20d, P3)', { key: 'stall:ACME:9/1', text: 'chase' }, { priority: 'P3', stall: { vendor: 'ACME', date: '9/1', days: 20 } }, 'coordinator', 'ready', 'critical');
  // ...and a fresh one (within the follow-up window) is due, still the coordinator's.
  trip('recent stall (5d, P3)', { key: 'stall:ACME:9/1', text: 'chase' }, { priority: 'P3', stall: { vendor: 'ACME', date: '9/1', days: 5 } }, 'coordinator', 'ready', 'due');

  // 2. Proposal awaiting client approval, not past its clock -> client, waiting.
  trip('proposal-sent, fresh', { key: 'phase:proposal-sent', text: 'chase' }, { status: 'Proposed', priority: 'P3', hrs: 10, pos: [] }, 'client', 'waiting', 'not-due');

  // 3. Completion docs needed while the tech is still on site -> vendor, waiting (never falsely ready).
  var onsite = cls({ key: 'phase:onsite', text: 'chase' }, { status: 'On-Site', priority: 'P3', hrs: 5, pos: [] });
  ok('onsite (fresh) is waiting, not ready', onsite.readiness === 'waiting', 'got ' + onsite.readiness);
  ok('onsite (fresh) is vendor-owned', onsite.ownership === 'vendor', 'got ' + onsite.ownership);

  // 4. Documents present and status can advance -> coordinator, ready, due.
  trip('advance-to-work-complete', { key: 'advance:workcomplete' }, { status: 'Confirm Complete' }, 'coordinator', 'ready', 'due');

  // 5. Unknown clock stays conservative: a status chase with no hrs is NOT-DUE (never DO NOW).
  var unk = cls({ key: 'phase:schedule', text: 'chase' }, { status: 'Pending Dispatch', priority: 'P3', hrs: null, pos: [] });
  ok('phase chase with unknown clock -> not-due', unk.urgency === 'not-due', 'got ' + unk.urgency);
  ok('...and does NOT enter DO NOW', !m.needsCoordinatorAttention(unk), 'needsAttention was true');

  // 6. Escalation tiers keep their ownership; a management decision reads as management/waiting.
  trip('escalate (management tier)', { key: 'escalate:client:3', owner: 'management' }, { status: 'Client Action Required', priority: 'P1' }, 'management', 'waiting', 'critical');
  trip('escalate (supervisor tier)', { key: 'escalate:scheduled:2', owner: 'supervisor' }, { status: 'Scheduled', priority: 'P3' }, 'supervisor', 'waiting', 'critical');
  trip('escalate (director owns the call)', { key: 'escalate:client:3', owner: 'director' }, { status: 'Client Action Required', priority: 'P1' }, 'coordinator', 'ready', 'critical');

  // 7. Friction: a nav-able PO step is one-click; a copy-only step is assisted.
  ok('poconf is one-click (nav target)', cls({ key: 'poconf:sid1:ACME', poNum: '001', text: 'x' }, { status: 'Confirm Complete', pos: [] }).friction === 'one-click', '');
  ok('a note step with no nav/tool is assisted (has copy)', cls({ key: 'clientcad:none', text: 'update' }, { status: 'On-Site', pos: [] }).friction === 'assisted', '');

  // 8. The anchor is informational / system, never actionable.
  var anch = cls({ key: 'anchor:active', anchor: true, why: 'x' }, {});
  ok('anchor -> system ownership', anch.ownership === 'system', 'got ' + anch.ownership);
  ok('anchor -> informational readiness', anch.readiness === 'informational', 'got ' + anch.readiness);
  ok('anchor never needs attention', !m.needsCoordinatorAttention(anch), '');

  // 9. Every classified action carries plain-language reason + doneWhen.
  var dc = cls({ key: 'docs:none' }, { status: 'Confirm Complete' });
  ok('reason is present + non-empty', typeof dc.reason === 'string' && dc.reason.length > 0, '');
  ok('doneWhen is present + non-empty', typeof dc.doneWhen === 'string' && dc.doneWhen.length > 0, '');
  ok('reason avoids threshold jargon', !/threshold|multiplier|overRatio|scoreAct/i.test(dc.reason), dc.reason);

  return out;
}

var MUTATIONS = [
  { what: 'stall past the escalate clock no longer reads critical',
    fn: function (s) { return mutate(s, "return days > escDays ? 'critical' : 'due';", "return days > escDays ? 'due' : 'due';"); } },
  { what: 'internal steps stop being coordinator-owned',
    fn: function (s) { return mutate(s, 'if (internal) return \'coordinator\';', 'if (internal) return \'vendor\';'); } },
  { what: 'a due chase stops being promoted to the coordinator',
    fn: function (s) { return mutate(s, "return (urgency === 'due' || urgency === 'critical') ? 'coordinator' : actor;", 'return actor;'); } },
  { what: 'the DO NOW attention gate lets not-due items through',
    fn: function (s) { return mutate(s, "return c.ownership === 'coordinator' && c.readiness === 'ready' && c.urgency !== 'not-due';", "return c.ownership === 'coordinator' && c.readiness === 'ready';"); } }
];

function main() {
  console.log('\n-- Coordinator Action Queue: classification against the shipped bytes --');
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
