// test-coord-queue.js - node harness for the Coordinator Action Queue PARTITIONING +
// RANKING (bwn-suite-core 1.88.0 / WO Assist 2.75). Slices the real COORD-QUEUE block out
// of bwn-suite-core.user.js and runs it in a vm - the attention gate, the DO-NOW cap, the
// section precedence, the counts, and the coordinatorScore ordering are the shipped bytes.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-coord-queue.js

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
  var body = DEPS + src + '\n return { buildCoordinatorQueue:buildCoordinatorQueue, needsCoordinatorAttention:needsCoordinatorAttention, classifyCoordinatorAction:classifyCoordinatorAction };';
  return vm.runInContext('(function(){\n' + body + '\n})()', sandbox, { filename: 'coord-queue.js' });
}

var NOW = Date.parse('2026-09-22T12:00:00Z');
var CC = { status: 'Confirm Complete', hrs: 10, priority: 'P3', pos: [] };   // a shared, deterministic state

function keys(list) { return list.map(function (c) { return c.key; }); }

function runCases(src) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  var m;
  try { m = build(src); } catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }
  function q(acts, state) { return m.buildCoordinatorQueue(acts, state || CC, {}, NOW); }
  function find(qr, key) { for (var i = 0; i < qr.fullLifecycle.length; i++) if (qr.fullLifecycle[i].key === key) return qr.fullLifecycle[i]; return null; }

  // --- Attention gate + partition placement + counts --------------------------
  var mixed = q([
    { key: 'advance:workcomplete', baseHint: 58 },              // coordinator / ready / due  -> DO NOW
    { key: 'phase:proposal-sent', baseHint: 100, text: 'x' },   // client / waiting           -> Waiting
    { key: 'escalate:client:3', owner: 'management', baseHint: 94 }, // management / waiting (critical) -> Waiting
    { key: 'phase:schedule', baseHint: 40, text: 'x' },         // coordinator / ready / not-due -> Upcoming
    { key: 'anchor:active', anchor: true, why: 'x' }            // informational -> Full lifecycle only
  ]);
  ok('DO NOW holds only the ready+due coordinator action', JSON.stringify(keys(mixed.doNow)) === JSON.stringify(['advance:workcomplete']), keys(mixed.doNow).join(','));
  ok('a management escalation lands in Waiting', keys(mixed.waiting).indexOf('escalate:client:3') !== -1, keys(mixed.waiting).join(','));
  ok('the client chase lands in Waiting', keys(mixed.waiting).indexOf('phase:proposal-sent') !== -1, keys(mixed.waiting).join(','));
  ok('the not-due coordinator step lands in Upcoming', keys(mixed.upcoming).indexOf('phase:schedule') !== -1, keys(mixed.upcoming).join(','));
  ok('the anchor is in Full lifecycle but no action bucket',
    keys(mixed.fullLifecycle).indexOf('anchor:active') !== -1 &&
    keys(mixed.doNow).concat(keys(mixed.waiting), keys(mixed.upcoming), keys(mixed.blocked)).indexOf('anchor:active') === -1, '');
  ok('counts are correct', JSON.stringify(mixed.counts) === JSON.stringify({ doNow: 1, moreAttention: 0, blocked: 0, waiting: 2, upcoming: 1, full: 5 }), JSON.stringify(mixed.counts));
  ok('a critical item in Waiting is flagged', mixed.critical.waiting === true, '');

  // --- DO NOW is capped at three; overflow goes to "More requiring attention" -
  //     (NOT Upcoming - that mislabel was the live-validation defect).
  var five = q([
    { key: 'docs:none', baseHint: 92 }, { key: 'advance:workcomplete', baseHint: 80 },
    { key: 'intake:a', baseHint: 70 }, { key: 'dne:1.00', baseHint: 60 }, { key: 'note:2026-09-01', baseHint: 50 }
  ]);
  ok('DO NOW never shows more than three', five.doNow.length === 3, 'got ' + five.doNow.length);
  ok('the three shown are the top-scoring', JSON.stringify(keys(five.doNow)) === JSON.stringify(['docs:none', 'advance:workcomplete', 'intake:a']), keys(five.doNow).join(','));
  ok('the 4th/5th attention items go to More requiring attention, never Upcoming',
    five.moreAttention.length === 2 && five.upcoming.length === 0, 'more=' + five.moreAttention.length + ' upcoming=' + five.upcoming.length);
  ok('Full lifecycle retains every generated action', five.fullLifecycle.length === 5, 'got ' + five.fullLifecycle.length);

  // --- The live-validation scenario: 15 attention-eligible, 0 genuine upcoming --
  var many = [];
  for (var i = 0; i < 15; i++) many.push({ key: 'intake:' + i, baseHint: 100 - i, why: 'x' });
  var mq = q(many);
  ok('15 attention items -> DO NOW exactly 3', mq.doNow.length === 3, 'got ' + mq.doNow.length);
  ok('15 attention items -> More requiring attention exactly 12', mq.moreAttention.length === 12, 'got ' + mq.moreAttention.length);
  ok('15 attention items -> Upcoming 0 (no due/ready item leaks in)', mq.upcoming.length === 0, 'got ' + mq.upcoming.length);
  ok('every overflow item keeps coordinator/ready/due|critical', mq.moreAttention.every(function (c) { return c.ownership === 'coordinator' && c.readiness === 'ready' && (c.urgency === 'due' || c.urgency === 'critical'); }), '');
  ok('DO NOW + More cover all 15 attention items, none lost', mq.doNow.concat(mq.moreAttention).length === 15, '');
  var mqKeys = mq.doNow.concat(mq.moreAttention).map(function (c) { return c.key; });
  ok('order across DO NOW then More is deterministic (by score desc)', JSON.stringify(mqKeys) === JSON.stringify(many.map(function (a) { return a.key; })), mqKeys.join(','));

  // --- Overflow AND genuine upcoming coexist, cleanly separated ---------------
  var mix2 = q([
    { key: 'intake:a', baseHint: 90 }, { key: 'docs:none', baseHint: 88 }, { key: 'advance:workcomplete', baseHint: 86 },
    { key: 'dne:1', baseHint: 84 }, { key: 'note:2026-09-01', baseHint: 82 },  // 5 due coordinator -> 3 DO NOW + 2 More
    { key: 'phase:schedule', baseHint: 40, text: 'x' }                          // coordinator / ready / not-due -> Upcoming
  ], { status: 'Pending Dispatch', hrs: 5, priority: 'P3', pos: [] });
  ok('mixed: DO NOW 3', mix2.doNow.length === 3, 'got ' + mix2.doNow.length);
  ok('mixed: More requiring attention holds only the 2 overflow attention items', mix2.moreAttention.length === 2, 'got ' + mix2.moreAttention.length);
  ok('mixed: Upcoming holds only the genuine not-due item', mix2.upcoming.length === 1 && keys(mix2.upcoming)[0] === 'phase:schedule', keys(mix2.upcoming).join(','));
  ok('mixed: no overflow action appears in Upcoming', mix2.doNow.concat(mix2.moreAttention).filter(function (c) { return keys(mix2.upcoming).indexOf(c.key) !== -1; }).length === 0, '');
  ok('mixed: counts are independently correct', JSON.stringify(mix2.counts) === JSON.stringify({ doNow: 3, moreAttention: 2, blocked: 0, waiting: 0, upcoming: 1, full: 6 }), JSON.stringify(mix2.counts));

  // --- Fewer than / equal to three attention -> no overflow ------------------
  var few = q([{ key: 'docs:none', baseHint: 90 }, { key: 'advance:workcomplete', baseHint: 88 }]);
  ok('<=3 attention -> More requiring attention is empty', few.moreAttention.length === 0, 'got ' + few.moreAttention.length);

  // --- Ranking: a ready/due coordinator action outranks a higher-base waiting one
  var rank = q([{ key: 'advance:workcomplete', baseHint: 58 }, { key: 'phase:proposal-sent', baseHint: 100, text: 'x' }]);
  ok('ready+due coordinator outranks a higher-base waiting item',
    find(rank, 'advance:workcomplete').coordinatorScore > find(rank, 'phase:proposal-sent').coordinatorScore,
    find(rank, 'advance:workcomplete').coordinatorScore + ' vs ' + find(rank, 'phase:proposal-sent').coordinatorScore);
  // ...decisively: a much higher-base WAITING item is held below a ready coordinator one by
  // the waiting penalty (remove the penalty and this flips - the negative control below).
  var pen = q([{ key: 'phase:schedule', baseHint: 100, text: 'x' }, { key: 'phase:materials', baseHint: 200, text: 'x' }], { status: 'Pending Dispatch', hrs: 100, priority: 'P3', pos: [] });
  ok('the waiting penalty keeps a high-base waiting item below a ready coordinator one',
    find(pen, 'phase:schedule').coordinatorScore > find(pen, 'phase:materials').coordinatorScore &&
    keys(pen.doNow).indexOf('phase:schedule') !== -1 && keys(pen.waiting).indexOf('phase:materials') !== -1,
    find(pen, 'phase:schedule').coordinatorScore + ' vs ' + find(pen, 'phase:materials').coordinatorScore);

  // --- Ranking: critical coordinator work outranks ordinary due work ----------
  var crit = q([{ key: 'escalate:x:3', owner: 'director', baseHint: 60 }, { key: 'advance:workcomplete', baseHint: 60 }]);
  ok('critical coordinator work sorts above due coordinator work', keys(crit.doNow)[0] === 'escalate:x:3', keys(crit.doNow).join(','));

  // --- Low friction is only a bounded tie-break, never a criticality override --
  var fric = q([{ key: 'poconf:sid1:V', poNum: '1', baseHint: 60, text: 'x' }, { key: 'dne:2.00', baseHint: 60 }]);
  ok('one-click nudges above an equal manual action', keys(fric.doNow)[0] === 'poconf:sid1:V', keys(fric.doNow).join(','));
  var fric2 = q([{ key: 'poconf:sid1:V', poNum: '1', baseHint: 60, text: 'x' }, { key: 'stall:V:9/1', baseHint: 60 }], { status: 'Scheduled', hrs: 10, priority: 'P3', pos: [], stall: { vendor: 'V', date: '9/1', days: 20 } });
  ok('a critical manual action still beats a due one-click action', keys(fric2.doNow)[0] === 'stall:V:9/1', keys(fric2.doNow).join(','));

  // --- Deterministic ----------------------------------------------------------
  var d1 = keys(q([{ key: 'docs:none', baseHint: 92 }, { key: 'advance:workcomplete', baseHint: 80 }, { key: 'intake:a', baseHint: 80 }]).doNow);
  var d2 = keys(q([{ key: 'docs:none', baseHint: 92 }, { key: 'advance:workcomplete', baseHint: 80 }, { key: 'intake:a', baseHint: 80 }]).doNow);
  ok('the same input yields the same DO NOW order', JSON.stringify(d1) === JSON.stringify(d2), d1 + ' | ' + d2);

  return out;
}

var MUTATIONS = [
  { what: 'the DO NOW cap is removed',
    fn: function (s) { return mutate(s, 'doNow = doNow.slice(0, COORD_CFG.doNowMax);', 'doNow = doNow.slice(0, 99);'); } },
  { what: 'critical no longer outweighs due in the score',
    fn: function (s) { return mutate(s, "urg: { critical: 50, due: 30, upcoming: 10, 'not-due': -35 }", "urg: { critical: 5, due: 30, upcoming: 10, 'not-due': -35 }"); } },
  { what: 'the waiting penalty is dropped (waiting can outrank ready)',
    fn: function (s) { return mutate(s, "if (c.readiness === 'waiting') s += S.waiting;", "if (c.readiness === 'waiting') s += 0;"); } },
  { what: 'the informational (anchor) skip is removed, leaking it into an action bucket',
    fn: function (s) { return mutate(s, "if (c.readiness === 'informational') return;", "if (c.readiness === 'informational' && false) return;"); } },
  { what: 'DO NOW overflow is dropped instead of bucketed as More requiring attention',
    fn: function (s) { return mutate(s, 'var moreAttention = doNow.slice(COORD_CFG.doNowMax);', 'var moreAttention = [];'); } },
  { what: 'the old defect: overflow folded back into Upcoming',
    fn: function (s) { return mutate(s, 'doNow: doNow, moreAttention: moreAttention, blocked: blocked, waiting: waiting, upcoming: upcoming,', 'doNow: doNow, moreAttention: [], blocked: blocked, waiting: waiting, upcoming: upcoming.concat(moreAttention),'); } }
];

function main() {
  console.log('\n-- Coordinator Action Queue: partitioning + ranking against the shipped bytes --');
  // Source guards: the Coordinator-facing label exists, and the old overflow-into-upcoming
  // code is gone from the real file (these read the unmutated source, not a VM slice).
  A.ok('renderer uses the "More requiring attention" label', coreFull.indexOf("'More requiring attention'") !== -1, 'label missing');
  A.ok('the pure builder no longer folds overflow into upcoming', coreFull.indexOf('overflow.concat(upcoming)') === -1, 'old overflow-into-upcoming code still present');
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
