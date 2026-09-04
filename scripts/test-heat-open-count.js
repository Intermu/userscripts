// test-heat-open-count.js - node harness for WO List Heat v3.22: which rows count as OPEN.
//
// WHAT WAS BROKEN, measured against the live board on 2026-08-05 (not inferred):
//   The WO list showed 218 work orders, EVERY ONE of them phase "Open" (Umbrava's own
//   lifecycle field, read straight off the board query - the Audit panel even printed
//   "By phase - Open ... of 218"). The My Day strip announced "of 199 open - full board".
//   The missing 19 all sat in status "Clocked Out: Complete": the tech has clocked out
//   saying their visit is done, the WO is still Open, and it still owes cost review on the
//   used POs and close-out. Heat never read the phase for that decision - it pattern-matched
//   the status TEXT against /complete|invoiced|closed|cancel/i, the word "Complete" hit, and
//   the same regex sat in FIVE places, so those rows vanished from all of them at once:
//     - computeVerdict returned sev 0     -> never tinted, no reasons, no offender ranking
//     - myDayCounts                       -> out of the open denominator AND every pill
//     - heatSnapshot                      -> out of the daily trend baseline
//     - the Audit panel's delta strip     -> out of red/amber/open/over-30 and the age buckets
//     - o30BatchStart                     -> out of the over-30 batch
//   Cost, measured on those 19: 5 were over 30 days old (so the "72 over 30d" pill was really
//   77) and 10 were past their complete-by date. They were the LAST rows that should have been
//   silent. Core's own action taxonomy already disagreed with the regex: WO_PHASE maps
//   'clocked out: complete' to 'costreview', explicitly NOT terminal.
//
// THE FIX under test: one heatDone(status, phase), asked by all five call sites.
//   1. terminal phase (closed/cancel*/declined/revoked)  -> done, whatever the status says
//   2. explicitly ACTIVE phase (open/on hold/pending acceptance/confirm reopen/confirm complete)
//                                                        -> NOT done; it VETOES the name guess
//   3. no phase read at all (the DOM tinting pass has no phase column) -> the name guess, as before
// Step 2 is the change. The active list is a WHITELIST on purpose: a WorkComplete phase still
// falls through to the name regex (ConfirmComplete was ADDED to the whitelist 2026-08-18 after
// measuring 5 live WOs it was silencing), so this can only ever REMOVE silence, and only on a
// row the server itself calls active.
//
// Drives the REAL shipped bytes: slices heatDone, computeVerdict, the shared status-clock
// engine, heatSnapshot, myDayCounts and o30BatchStart out of bwn-suite-core.user.js and runs
// them in a vm over a fixture built to the measured live shape - 218 phase-Open rows, 19 of
// them "Clocked Out: Complete", 5 of those over 30 days. The M1 control asserts the fixture
// reproduces the live number EXACTLY (199), so these numbers are the board's numbers and not
// a shape invented to suit the fix.
//
// NOT covered here, and not claimed: the Audit panel's own copy of the gate lives inside
// toggleAuditPanel, ~250 lines of DOM building, and is not sliced - it carries the identical
// one-line call and is verified only by the live gate below. Nothing here proves the browser
// renders any of this either. LIVE GATE: one WO-list load where the strip must read
// "of 218 open - full board" on this board, with the 19 "Clocked Out: Complete" rows tinted
// per their own clocks.
//
// FIXED IN v3.23 (this note was the "KNOWN OPEN" of the v3.22 pass): the module-local alias
// `function thresholdsFor(status, prioText, C)` took THREE parameters while both call sites
// passed four - computeVerdict passes `f.sla`, the offender ranking passes `e.sla` - so the
// v3.19 client-SLA scaling was dropped on the floor and `slaScaled` was never true. It was
// held back deliberately because it moves every row's threshold, which would have blurred
// this change's live gate. Both harnesses now SLICE the real alias instead of stubbing it
// (the stub took four args and forwarded, which is how 287 assertions stayed green over a
// dead path), so the same shape cannot come back. The numbers are asserted in
// test-heat-api-scan.js under "v3.23".
//
// This harness' own counts are unaffected by that fix and that is the point: its fixture is
// a DOM/scroll-shaped board with no `sla` on any row, so every threshold here still comes
// from the "P3 Standard" label parse, exactly as it did in v3.22.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-heat-open-count.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}

// Every mutation must hit exactly one site, or the "control" is a silent no-op that reads
// green (this repo has been bitten by that four times in one session).
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var core = readLF(CORE_SRC);

// ---- The real blocks under test ------------------------------------------------------
var SRC_DONE = slice(core,
  '    // ---- Is this row finished? ONE place (v3.22) ---',
  '    // ---- Audit panel: open-row tally',
  'heatDone');
// v3.28: the audit panel's open-row tally, factored out of toggleAuditPanel so the FIFTH
// heatDone call site is sliced and EXERCISED, not merely source-checked. Needs heatDone
// (from SRC_DONE) in scope.
var SRC_AUDIT = slice(core,
  '    // ---- Audit panel: open-row tally',
  '    // ---- Threshold model ---',
  'auditOpenTally');
var SRC_THRESH = slice(core,
  '  var BWN_HEAT_CFG = {',
  '  // ---- Next-actions engine, published across module closures',
  'BWN_HEAT_CFG + bwnSlaMult + bwnThresholdsFor');
// v3.23: the module-local alias, SLICED not stubbed (see the FIXED IN v3.23 note in the
// header). The PRELUDE used to declare a 4-arg forwarder while the shipped alias took 3.
var SRC_ALIAS = slice(core,
  '    // ---- Threshold model ---',
  '    // ---- Per-row verdict',
  'thresholdsFor alias');
var SRC_VERDICT = slice(core,
  '    function computeVerdict(f, C) {',
  '    // One place that turns a STORED row',
  'computeVerdict');
var SRC_SNAP = slice(core,
  '    // ---- Daily full-scan snapshots (v3.8) ---',
  '    // ---- Is this row finished? ONE place (v3.22) ---',
  'heatSnapshot');
var SRC_O30 = slice(core,
  '    function o30BatchStart() {',
  '    function myDayCounts() {',
  'o30BatchStart');
var SRC_MYDAY = slice(core,
  '    function myDayCounts() {',
  '    function renderMyDay() {',
  'myDayCounts');

// A fixed "today" so the age/overdue arithmetic is deterministic. The live board was read
// on 2026-08-05.
var TODAY = new Date(2026, 7, 5).setHours(0, 0, 0, 0);

// What the sliced code leans on that lives elsewhere: config, the DOM reads myDayCounts
// falls back to, localStorage/sessionStorage, and the alert/confirm o30BatchStart uses.
// Instrumented so the assertions read what the real code DID.
var PRELUDE = [
  'var __today = ' + TODAY + ';',
  'var console = { info: function () { }, warn: function () { } };',
  'var heatStore = null, heatScanning = false, heatScanClean = true, heatScanNote = null;',
  'var __alerts = [], __confirms = [], __confirmAnswer = true, __cmds = [];',
  'function alert(m) { __alerts.push(String(m)); }',
  'var window = { confirm: function (m) { __confirms.push(String(m)); return __confirmAnswer; } };',
  'var __ss = {};',
  'var sessionStorage = { getItem: function (k) { return (k in __ss) ? __ss[k] : null; }, setItem: function (k, v) { __ss[k] = String(v); } };',
  'var __ls = {};',
  'function CustomEvent(name, init) { return { type: name, detail: init && init.detail }; }',
  'var document = { dispatchEvent: function (e) { __cmds.push(e.detail && e.detail.id); }, getElementById: function () { return null; } };',
  'function dSince(ts) { return Math.floor((__today - ts) / 86400000); }',
  'function dUntil(ts) { return Math.ceil((ts - __today) / 86400000); }',
  'function mydayDateKey() { return "2026-08-05"; }',
  // NO thresholdsFor stub - SRC_ALIAS supplies the shipped one.
  'function bwnConfig() { return __cfg; }',
  'function ackGet() { return false; }',
  'function cleanName(s) { return String(s == null ? "" : s).trim(); }',
  // myDayCounts' no-scan fallback reads the visible table. __domRows drives it: null means
  // "no table", so the heatStore branch is the one under test unless a test asks otherwise.
  'var __domRows = null;',
  'function findBodyTable() { return __domRows ? { querySelectorAll: function () { return __domRows; }, rows: __domRows } : null; }',
  'function headerMap() { return { status: 0, prio: 1, days: 2, hrs: 3, lastNote: 4, created: -1 }; }',
  'function alignMap(H) { return H; }',
  'function rowWOLink(tr) { return tr.__wo ? {} : null; }',
  'function cellText(tr, i) { return String(tr.cells[i] == null ? "" : tr.cells[i]); }',
  'var BWN = {',
  '  cfg: function () { return __cfg; },',
  '  parseUSDate: function (s) { var m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(String(s == null ? "" : s)); if (!m) return null; var d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])); d.setHours(0, 0, 0, 0); return d.getTime(); },',
  '  money: function (n) { return "$" + Number(n).toFixed(2); },',
  '  lsGetJSON: function (k, d) { return (k in __ls) ? __ls[k] : d; },',
  '  lsSetJSON: function (k, v) { __ls[k] = v; },',
  '  parseNoteDateLoose: function () { return null; }',
  '};',
  'var parseUSDate = BWN.parseUSDate;'
].join('\n');

function build(opts) {
  var o = opts || {};
  var src = [PRELUDE, SRC_THRESH, SRC_DONE, SRC_AUDIT, SRC_ALIAS, SRC_VERDICT, SRC_SNAP, SRC_O30, SRC_MYDAY].join('\n\n');
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = { Date: Date, JSON: JSON, Math: Math, String: String, Number: Number, parseFloat: parseFloat, parseInt: parseInt, isNaN: isNaN, Object: Object, Array: Array };
  // The live config, so these numbers are the board's numbers.
  sandbox.__cfg = o.cfg || { hrsWarn: 60, hrsBad: 120, activeMult: 0.5, dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7 };
  vm.runInNewContext(src, sandbox, { filename: 'open-count-slice.js' });
  return sandbox;
}

// ---- The fixture: the measured live board ------------------------------------------
// 218 rows, every one phase "Open". 19 in status "Clocked Out: Complete", 5 of those over
// 30 days old (81, 81, 39, 36, 33 - the real ages of W-361519/361563/372705/373545/375123).
// Ages and clocks on the other 199 are plain and quiet unless a test says otherwise, so any
// count that moves in these assertions moved because of the 19.
function usDate(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
}
var MUTED_AGES = [81, 81, 39, 36, 33, 21, 13, 12, 11, 8, 8, 7, 6, 5, 5, 5, 4, 1, 1];   // 19 rows, 5 over 30
function board(over) {
  var o = over || {};
  var store = {};
  var i, e;
  // The quiet majority: 199 phase-Open rows, 10 days old, 5h in status - nothing fires.
  for (i = 0; i < 199; i++) {
    store['/work-orders/' + (300000 + i)] = {
      src: 'api', wo: String(300000 + i), status: 'Scheduled', prio: 'P3 Standard', phase: 'Open',
      client: 'Pilot Travel Centers', assignee: 'Lisa Porzelt',
      days: '10', hrs: '5', dne: '', sched: '', lastNote: usDate(TODAY - 86400000), exp: '', sev: 0
    };
  }
  // The 19 the regex ate. 200h in status: past the 120h base limit for a status the
  // ACTIVE_RE/BLOCKED_RE classes do not match, so each one is a real red on its own clock.
  for (i = 0; i < MUTED_AGES.length; i++) {
    e = {
      src: 'api', wo: String(361500 + i), status: o.mutedStatus || 'Clocked Out: Complete',
      prio: 'P3 Standard', phase: o.mutedPhase || 'Open',
      client: 'Pilot Travel Centers', assignee: 'Lisa Porzelt',
      days: String(MUTED_AGES[i]), hrs: '200', dne: '', sched: '',
      lastNote: usDate(TODAY - 86400000), exp: '', sev: 0
    };
    if (o.mutedPhaseAbsent) delete e.phase;
    store['/work-orders/' + (361500 + i)] = e;
  }
  return store;
}
function seed(s, over) { s.heatStore = board(over); return s; }

console.log('-- heatDone: the three signals, in order of authority --');
(function () {
  var s = build({});
  A.eq('a terminal phase is done whatever the status says', s.heatDone('Scheduled', 'Closed'), true);
  A.eq('Canceled too', s.heatDone('Scheduled', 'Canceled'), true);
  A.eq('and Declined / Revoked', [s.heatDone('Scheduled', 'Declined'), s.heatDone('Scheduled', 'Revoked')], [true, true]);
  // THE FIX: an active phase beats the word in the status name.
  A.eq('"Clocked Out: Complete" on an Open-phase WO is NOT done', s.heatDone('Clocked Out: Complete', 'Open'), false);
  A.eq('case and padding do not matter', s.heatDone('Clocked Out: Complete', '  open '), false);
  A.eq('On Hold is active too', [s.heatDone('Work Complete', 'On Hold'), s.heatDone('Work Complete', 'OnHold')], [false, false]);
  A.eq('Pending Acceptance and Confirm Reopen as well',
    [s.heatDone('Invoiced', 'PendingAcceptance'), s.heatDone('Invoiced', 'ConfirmReopen')], [false, false]);
  // Added 2026-08-18 (measured: 5 live WOs at "Confirm Complete", 3 over-30, 3 past-due).
  A.eq('ConfirmComplete is on the whitelist now: a "Confirm Complete" row is NOT done',
    [s.heatDone('Confirm Complete', 'ConfirmComplete'), s.heatDone('Confirm Complete', 'Confirm Complete')], [false, false]);
  // The name guess, untouched, for the DOM pass that has no phase column to read.
  A.eq('no phase read -> the status name still decides', s.heatDone('Work Complete', ''), true);
  A.eq('and an ordinary status is still open', s.heatDone('Scheduled', ''), false);
  A.eq('undefined phase behaves like no phase', s.heatDone('Invoiced', undefined), true);
  // The whitelist, stated as a test: these phases are NOT on it, so they keep the old
  // name-based behaviour rather than quietly changing meaning.
  A.eq('a WorkComplete phase still defers to the name', s.heatDone('Work Complete', 'WorkComplete'), true);
  A.eq('and a WorkComplete row whose name does not match stays exactly as it was',
    s.heatDone('Pending Ability To Bill', 'WorkComplete'), false);
})();

console.log('\n-- computeVerdict: the 19 are judged, not muted --');
(function () {
  var s = build({});
  function V(over) {
    var f = {
      status: 'Clocked Out: Complete', prio: 'P3 Standard', phase: 'Open',
      ageDays: 81, hrs: 200, expTs: null, schedTs: null, lastNoteTs: null,
      remDays: null, sla: null
    };
    Object.keys(over || {}).forEach(function (k) { f[k] = over[k]; });
    return s.computeVerdict(f, s.__cfg);
  }
  var v = V({});
  A.eq('200h in "Clocked Out: Complete" on an Open WO is red', v.sev, 2);
  A.ok('and it says which clock it broke', /in "Clocked Out: Complete" \(limit 120h\)/.test(v.reasons.join('|')), v.reasons.join('|'));
  A.eq('its age still counts as over 30', v.over30, true);
  A.eq('the same row in a Closed phase is silent', V({ phase: 'Closed' }).sev, 0);
  A.eq('and with no phase read at all it is silent, as before', V({ phase: '' }).sev, 0);
  A.eq('a stale note on it is still a stale note',
    V({ hrs: NaN, lastNoteTs: TODAY - 20 * 86400000 }).stale, true);
})();

console.log('\n-- myDayCounts: the strip and its pills --');
(function () {
  var s = seed(build({}));
  var d = s.myDayCounts();
  A.eq('the open denominator is the whole board', d.open, 218);
  A.eq('total and open agree - nothing on this board is finished', [d.total, d.open], [218, 218]);
  // The pills, which is where "counted but never a problem" would hide.
  A.eq('the over-30 pill includes the 5 aged muted rows', d.over30, 5);
  A.eq('all 19 are past their status limit', d.limitBad, 19);
  A.eq('and none of them lands in watch instead', d.limitWatch, 0);
  A.eq('scanned reads as a full board', d.scanned, true);

  // A DOM-only store (no phase on any row) must behave exactly as it did before: the name
  // decides. This is the path a scroll-sweep scan leaves behind.
  var s2 = seed(build({}), { mutedPhaseAbsent: true });
  var d2 = s2.myDayCounts();
  A.eq('with no phase read, the 19 are muted by name as before', d2.open, 199);
  A.eq('and they contribute to no pill', [d2.over30, d2.limitBad], [0, 0]);

  // The no-scan DOM fallback still reads the visible rows and still has no phase.
  var s3 = build({});
  s3.__domRows = [
    { __wo: 1, cells: ['Scheduled', 'P3 Standard', '10', '5', ''] },
    { __wo: 1, cells: ['Clocked Out: Complete', 'P3 Standard', '81', '200', ''] },
    { __wo: 1, cells: ['Work Complete', 'P3 Standard', '81', '200', ''] }
  ];
  var d3 = s3.myDayCounts();
  A.eq('the pre-scan DOM tally counts every row it can see', d3.total, 3);
  A.eq('and mutes the two complete-looking ones on name alone', d3.open, 1);
  A.eq('it says so: not a full board', d3.scanned, false);
})();

console.log('\n-- heatSnapshot: the daily trend baseline --');
(function () {
  var s = seed(build({}));
  // sev is what the scan stored; the snapshot counts those, so mark the 19 red the way a
  // v3.22 scan now would.
  Object.keys(s.heatStore).forEach(function (k) { if (/Clocked Out/.test(s.heatStore[k].status)) s.heatStore[k].sev = 2; });
  s.heatSnapshot();
  var snap = s.__ls['bwn:heat:snap']['2026-08-05'];
  A.eq('the day is recorded against the whole board', snap.open, 218);
  A.eq('with the 19 red rows in it', snap.bad, 19);
  A.eq('and the 5 aged ones in over-30', snap.over30, 5);
})();

console.log('\n-- o30BatchStart: the over-30 batch --');
(function () {
  var s = seed(build({}));
  s.o30BatchStart();
  A.eq('nothing was refused', s.__alerts, []);
  A.eq('the batch command was dispatched', s.__cmds, ['ai:over30batch']);
  var staged = JSON.parse(s.__ss['bwn:o30batch']);
  A.eq('and it staged exactly the 5 aged Clocked-Out rows', staged.jobs.length, 5);
  A.eq('the oldest two are the 81-day pair', staged.jobs.slice(0, 2).map(function (j) { return j.days; }), [81, 81]);
  A.ok('every staged row is one of the 19', staged.jobs.every(function (j) { return j.status === 'Clocked Out: Complete'; }));

  // Same board with no phase: the batch is empty and the user is told, rather than a silent
  // "nothing to do".
  var s2 = seed(build({}), { mutedPhaseAbsent: true });
  s2.o30BatchStart();
  A.eq('with no phase read there is nothing over 30 to stage', s2.__ss['bwn:o30batch'], undefined);
  A.eq('and it says so out loud', s2.__alerts, ['No open over-30 jobs in the scan.']);
})();

console.log('\n-- auditOpenTally: the Audit panel delta strip, now SLICED (was source-only) --');
(function () {
  // The fifth heatDone site. Until v3.28 it lived inside toggleAuditPanel's ~250 lines of DOM
  // building and was covered by a source-string check alone; it is now a pure function and is
  // exercised here exactly like the other four callers. The panel reads the STORED sev off each
  // row (not a recomputation), so mark the 19 "Clocked Out: Complete" rows red the way a v3.22
  // scan now would - same as the snapshot test - then hand it the entries array the panel builds.
  function entriesOf(s) { return Object.keys(s.heatStore).map(function (k) { var e = s.heatStore[k]; e._href = k; return e; }); }
  function markClockedRed(s) { Object.keys(s.heatStore).forEach(function (k) { if (/Clocked Out/.test(s.heatStore[k].status)) s.heatStore[k].sev = 2; }); }

  var s = seed(build({})); markClockedRed(s);
  var t = s.auditOpenTally(entriesOf(s));
  A.eq('open is the whole board - the 19 Clocked-Out rows are active-phase, not done', t.open, 218);
  A.eq('the 19 red rows are counted, none as amber', [t.bad, t.warn], [19, 0]);
  A.eq('the 5 aged Clocked-Out rows land in over-30', t.over30, 5);
  A.eq('over-30 equals the 31-60 plus 60+ buckets', t.bkt.c + t.bkt.d, 5);
  A.eq('every scanned row falls in exactly one age bucket', t.bkt.a + t.bkt.b + t.bkt.c + t.bkt.d, 218);
  A.eq('this board has no data gaps', [t.noHrs, t.noNote], [0, 0]);

  // THE GATE, both directions. A terminal phase drops all 19 from every count...
  var sC = seed(build({}), { mutedPhase: 'Closed' }); markClockedRed(sC);
  var tC = sC.auditOpenTally(entriesOf(sC));
  A.eq('a Closed phase drops the 19 from open', tC.open, 199);
  A.eq('and from red and over-30 too', [tC.bad, tC.over30], [0, 0]);

  // ...and with no phase read at all, the status NAME mutes them, exactly as before the fix.
  var sN = seed(build({}), { mutedPhaseAbsent: true }); markClockedRed(sN);
  var tN = sN.auditOpenTally(entriesOf(sN));
  A.eq('with no phase, the name mutes the 19 - open is 199', tN.open, 199);
  A.eq('and they reach no count', [tN.bad, tN.over30], [0, 0]);

  // Data-gap counters run AFTER the gate: a blank hrs / blank lastNote on an OPEN row is
  // counted; an empty list tallies to zero rather than throwing.
  var sG = seed(build({}));
  sG.heatStore['/work-orders/300000'].hrs = '';
  sG.heatStore['/work-orders/300000'].lastNote = '';
  var tG = sG.auditOpenTally(entriesOf(sG));
  A.eq('a blank-hrs, blank-note open row shows in both data-gap counts', [tG.noHrs, tG.noNote], [1, 1]);
  A.eq('an empty entries list tallies to zero, never throws', s.auditOpenTally([]).open, 0);
})();

console.log('\n-- mutation controls (each must FAIL an assertion above) --');
(function () {
  // M1: the fix reverted - the active-phase veto removed, so the status name rules again.
  // This is the live board as it stood on 2026-08-05, and the number it prints is the
  // number the strip printed: 199. That is what makes this fixture the live board and not
  // a shape invented to flatter the fix.
  var m1 = [['      if (HEAT_ACTIVE_PHASE_RE.test(ph)) return false;     // the server says it is NOT - beats the name',
    '      if (false) return false;']];
  var s1 = seed(build({ mutations: m1 }));
  var d1 = s1.myDayCounts();
  A.eq('M1 control: without the veto the strip says 199 of 218 - the live symptom, exactly', [d1.open, d1.total], [199, 218]);
  A.eq('M1 control: and the over-30 pill loses the 5 aged rows', d1.over30, 0);
  A.eq('M1 control: 19 rows past their limit report as none', d1.limitBad, 0);
  var v1 = s1.computeVerdict({ status: 'Clocked Out: Complete', prio: 'P3 Standard', phase: 'Open', ageDays: 81, hrs: 200, expTs: null, schedTs: null, lastNoteTs: null }, s1.__cfg);
  A.eq('M1 control: and the row itself goes back to sev 0 - untinted, no reasons', [v1.sev, v1.reasons.length], [0, 0]);

  // M2: the count gate fixed but the phase NOT forwarded into the engine from myDayCounts.
  // The nastier half-fix: 218 open and not one problem among the extra 19.
  var m2 = [['          status: o.status, prio: o.prio, phase: o.phase, sla: o.sla,', '          status: o.status, prio: o.prio, sla: o.sla,']];
  var s2 = seed(build({ mutations: m2 }));
  var d2 = s2.myDayCounts();
  A.eq('M2 control: without the phase, the 19 count as open', d2.open, 218);
  A.eq('M2 control: but every pill still reads zero for them', [d2.over30, d2.limitBad], [0, 0]);

  // M3: heatSnapshot back to its own inline regex - the trend baseline drifts from the strip.
  var m3 = [['          if (heatDone(e.status, e.phase)) return;', "          if (/complete|invoiced|closed|cancel/i.test(e.status || '')) return;"]];
  var s3 = seed(build({ mutations: m3 }));
  Object.keys(s3.heatStore).forEach(function (k) { if (/Clocked Out/.test(s3.heatStore[k].status)) s3.heatStore[k].sev = 2; });
  s3.heatSnapshot();
  A.eq('M3 control: the snapshot records 199 while the strip says 218', s3.__ls['bwn:heat:snap']['2026-08-05'].open, 199);

  // M4: o30BatchStart back to its own inline regex - the batch silently skips them. The
  // target carries the line above it because myDayCounts' tally uses the byte-identical
  // call, and mutate() refuses an ambiguous target rather than picking one.
  var m4 = [['        if (isNaN(days) || days <= 30) return;\n        if (heatDone(o.status, o.phase)) return;',
    "        if (isNaN(days) || days <= 30) return;\n        if (/complete|invoiced|closed|cancel/i.test(o.status || '')) return;"]];
  var s4 = seed(build({ mutations: m4 }));
  s4.o30BatchStart();
  A.eq('M4 control: the batch stages nothing', s4.__ss['bwn:o30batch'], undefined);
  A.eq('M4 control: and blames the board', s4.__alerts, ['No open over-30 jobs in the scan.']);

  // M5: the terminal-phase test defanged. Proves it is the branch doing the work when a
  // Closed-phase row falls silent - not the status name quietly covering for it.
  var m5 = [['    var HEAT_TERMINAL_PHASE_RE = /^(closed|cancel|canceled|cancelled|declined|revoked)/i;',
    '    var HEAT_TERMINAL_PHASE_RE = /^__never__$/i;']];
  var s5 = build({ mutations: m5 });
  A.eq('M5 control: a Closed-phase row with a live-sounding status reads as open', s5.heatDone('Scheduled', 'Closed'), false);
  A.eq('M5 control: and the shipped code does not', build({}).heatDone('Scheduled', 'Closed'), true);

  // M6: the name fallback defanged. Proves the DOM-only assertions above have teeth - that
  // those rows are muted BY THE NAME, not by some other accident.
  var m6 = [["      return HEAT_DONE_STATUS_RE.test(String(status == null ? '' : status));", '      return false;']];
  var s6 = seed(build({ mutations: m6 }), { mutedPhaseAbsent: true });
  A.eq('M6 control: with no name test, a phase-less "Clocked Out: Complete" board counts all 218', s6.myDayCounts().open, 218);
  A.eq('M6 control: and a phase-less "Work Complete" row stops being finished', s6.heatDone('Work Complete', ''), false);

  // M7: the ACTIVE whitelist widened to "anything not terminal" - the over-reach this fix
  // deliberately avoided. WorkComplete rows would change meaning in the same commit.
  var m7 = [['      if (HEAT_ACTIVE_PHASE_RE.test(ph)) return false;     // the server says it is NOT - beats the name',
    '      if (ph) return false;']];
  var s7 = build({ mutations: m7 });
  A.eq('M7 control: a widened whitelist drags WorkComplete rows in too', s7.heatDone('Work Complete', 'WorkComplete'), false);
  A.eq('M7 control: and the shipped whitelist leaves them alone', build({}).heatDone('Work Complete', 'WorkComplete'), true);

  // M8: the audit tally's gate reverted to an inline regex - the delta strip drifts from the
  // My Day strip and the snapshot, the exact five-places-disagree bug, on the very site that
  // used to be source-checked only. Targeted by its unique trailing "t.open++;" so the mutation
  // lands in auditOpenTally and not in heatSnapshot's byte-identical (but s.open++) copy.
  var m8 = [['        if (heatDone(e.status, e.phase)) return;\n        t.open++;',
    "        if (/complete|invoiced|closed|cancel/i.test(e.status || '')) return;\n        t.open++;"]];
  var s8 = seed(build({ mutations: m8 }));
  Object.keys(s8.heatStore).forEach(function (k) { if (/Clocked Out/.test(s8.heatStore[k].status)) s8.heatStore[k].sev = 2; });
  var t8 = s8.auditOpenTally(Object.keys(s8.heatStore).map(function (k) { var e = s8.heatStore[k]; e._href = k; return e; }));
  A.eq('M8 control: with the inline regex the audit tally says 199 open, drifting from 218', t8.open, 199);
  A.eq('M8 control: and it loses the 19 red and the 5 over-30', [t8.bad, t8.over30], [0, 0]);

  // M9: the ConfirmComplete token removed from the active whitelist - proves the 2026-08-18
  // add is load-bearing. Without it a "Confirm Complete" row falls back to the name regex,
  // matches "complete", and goes silent again (the 5-WO drop this change fixed).
  var m9 = [['|confirm\\s?reopen|confirm\\s?complete)$/i;', '|confirm\\s?reopen)$/i;']];
  var s9 = build({ mutations: m9 });
  A.eq('M9 control: without the ConfirmComplete add a "Confirm Complete" row is silent again', s9.heatDone('Confirm Complete', 'ConfirmComplete'), true);
  A.eq('M9 control: and the shipped whitelist keeps it active', build({}).heatDone('Confirm Complete', 'ConfirmComplete'), false);
})();

console.log('\n-- the shipped call sites: all five ask the same question --');
(function () {
  // The regex must survive in exactly ONE place: inside heatDone. Four inline copies are
  // what let five counts disagree in the first place.
  var hits = core.split(/\/complete\|invoiced\|closed\|cancel\/i/).length - 1;
  A.eq('the done-status regex is written once, not five times', hits, 1);
  A.ok('and it lives in heatDone', /var HEAT_DONE_STATUS_RE = \/complete\|invoiced\|closed\|cancel\/i;/.test(core));
  A.eq('every open count calls heatDone', core.split('heatDone(').length - 1, 6);   // 1 definition + 5 call sites
  A.ok('the verdict engine asks it too', core.indexOf('if (heatDone(f.status, f.phase)) return v;') !== -1);
  A.ok('the audit panel delegates its open tally to auditOpenTally (SLICED + exercised above, no longer source-only)',
    /var curS = auditOpenTally\(entries\);/.test(core));
  A.ok('and auditOpenTally is the one carrying the fifth heatDone gate',
    /function auditOpenTally\(entries\) \{[\s\S]*?if \(heatDone\(e\.status, e\.phase\)\) return;/.test(core));
  A.ok('and the tint borrows the phase from the API record for the same row',
    core.indexOf('phase: apiRec ? apiRec.phase : undefined') !== -1);
  // Version bumps: without them the fix reaches nobody (Tampermonkey compares versions).
  // Updated for 1.78.5: the dataset push now also carries Job ID / Source PO # / WO Date / Project Type
  // (the v2 gap); List Heat bumps to v3.27. (v3.26 carried Last Note Date; v3.25 added the push.)
  // v3.28 / Core 1.78.15: the audit panel's open tally was factored into auditOpenTally so its
  // heatDone gate is sliced above rather than source-checked. (1.66.35 had added the closure
  // auto-advance step.) The exact pin is the point: it forces a conscious edit on every Core
  // bump, so a version can never ride out attached to an unrelated change. It was red on main
  // from 1.66.33 (the mirror-retirement sweep bumped Core without acknowledging it here) until
  // 2026-08-06.
  A.ok('Core is bumped to 1.81.7', core.indexOf('// @version      1.81.7') !== -1);
  A.ok('and List Heat announces v3.28', core.indexOf("console.info('[BWN HEAT] v3.28 loaded on', location.href);") !== -1);
  // Drift guard (1.78.17): the module-inventory banner had read "List Heat 3.24" while the module
  // banner read v3.28 - the two are hand-kept and had silently diverged. Assert they agree so it
  // cannot recur (the same shape po-act-keys pins for the three WO Assist version strings).
  var invLH = (core.match(/List Heat (\d+\.\d+)/) || [])[1];
  var bannerLH = (core.match(/\[BWN HEAT\] v(\d+\.\d+) loaded/) || [])[1];
  A.ok('the inventory banner List Heat version matches the module banner (' + invLH + ' == ' + bannerLH + ')',
    !!invLH && invLH === bannerLH);
})();

A.finish();
