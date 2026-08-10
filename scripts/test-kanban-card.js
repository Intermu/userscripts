// test-kanban-card.js - node harness for bwn-kanban 0.4.0 and the List Heat v3.24 verdict
// publish it consumes.
//
// THE DEFECT this exists for, measured live 2026-08-05 on a 219-row open board:
//   The kanban card rendered `Math.round(r.timeInStatus) + 'h in status'`. `timeInStatus` is
//   MINUTES, so every card on the board was 60x out - W-326938's card read "12930h in status"
//   while bwn-suite-core's own published verdict for the same WO in the same second read
//   `215h in "Scheduled" (limit 120h)`, and 12930/60 = 215.5. Corroborated two more ways: the
//   number ticked up by 1 per minute while it was watched, and Umbrava's own CSV export from
//   the previous morning read 191.55 hrs for that WO, which is ~215 a day later. Because every
//   card was inflated by the same factor, none of them stood out - the one number a coordinator
//   would triage on was noise. This is the same units fault List Heat carried until v3.19,
//   reappearing in a second file that had never been in version control.
//
// WHAT IS ASSERTED, and against what:
//   The pure readers are SLICED OUT OF THE SHIPPED BYTES of bwn-kanban.user.js and run for
//   real - statusHours, dayDelta, fmtDate, moneyAmt/fmtMoney, heatOf. heatPublishVerdicts is
//   sliced out of the shipped bytes of bwn-suite-core.user.js and run against a fake
//   sessionStorage. Nothing is stubbed: there is no local reimplementation of any of them, so a
//   signature the browser does not have cannot be asserted against. That rule exists because
//   v3.19 shipped a dead next-step column behind 17 green assertions over a STUBBED engine, and
//   v3.23 shipped a dead SLA clock behind 287 green assertions over a stub that forwarded an
//   argument the real alias dropped.
//
// HONEST LIMIT: this harness does NOT prove the card RENDERS. buildCard needs a DOM, and a fake
//   one would be the stub this file refuses to write. What stands in for it is a set of SOURCE
//   PINS - buildCard must call statusHours(r) and must not touch r.timeInStatus, and the file
//   as a whole must contain no threshold model - so the specific defect cannot return unnoticed.
//   The render itself is gated on one live board load.
//
// Every mutation reverts one piece and asserts THIS harness goes red. mutate() throws if its
// target is absent or not unique, so a mutation that silently fails to apply cannot read as a
// pass (see negative-control-silent-noop).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-kanban-card.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var KB_SRC = path.join(__dirname, '..', 'bwn-kanban.user.js');
var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var kbFull = fs.readFileSync(KB_SRC, 'utf8').replace(/\r\n/g, '\n');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slicer(src, label) {
  return function (start, end, what) {
    var a = src.indexOf(start);
    if (a === -1) throw new Error(label + ' ' + what + ': START marker not found');
    if (src.indexOf(start, a + 1) !== -1) throw new Error(label + ' ' + what + ': START marker not unique');
    var b = src.indexOf(end, a);
    if (b === -1) throw new Error(label + ' ' + what + ': END marker not found after start');
    return src.slice(a, b);
  };
}
var sliceKb = slicer(kbFull, 'kanban');
var sliceCore = slicer(coreFull, 'core');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// The kanban's pure readers, as shipped. One slice, because they are one block in the file and
// splitting it would let a reordering slip past.
var S_READERS = sliceKb('  function prioClass(label) {', '  function groupDef() {', 'card readers');
// The core-side publisher, as shipped.
var S_PUBLISH = sliceCore('    function heatPublishVerdicts(store) {', '    // ---- Assignee names from GUIDs', 'heatPublishVerdicts');

// ---- fake storage ---------------------------------------------------------------------------
// Enough sessionStorage for both sides: getItem/setItem/removeItem, plus a quota switch so the
// publisher's "stopped after N rows" path is exercised rather than assumed.
function makeStorage(quota) {
  var map = {};
  return {
    _map: map,
    _n: function () { return Object.keys(map).length; },
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) {
      if (quota != null && Object.keys(map).length >= quota) { var e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      map[k] = String(v);
    },
    removeItem: function (k) { delete map[k]; }
  };
}

// ---- build a runnable context for the kanban readers ---------------------------------------
function readersCtx(src, opts) {
  opts = opts || {};
  var sandbox = {
    console: { info: function () { }, warn: function () { }, log: function () { } },
    Date: Date, Math: Math, JSON: JSON, String: String, Number: Number, Array: Array,
    isFinite: isFinite, parseFloat: parseFloat, parseInt: parseInt, isNaN: isNaN,
    sessionStorage: opts.storage || makeStorage(),
    // heatCount() walks `rows`; heatOf reads `heatMap`; snapAgeMin reads `pullState`. All three
    // are file-level in the script. 0.5.0: heatOf no longer touches sessionStorage at all -
    // rows and verdicts arrive together from bwn-suite-core's snapshot.
    rows: opts.rows || [],
    heatMap: opts.heatMap || {},
    pullState: opts.pullState || { running: false, ok: true, reason: null, ts: null },
    HEAT_MAX_AGE: opts.maxAge === undefined ? 30 * 60000 : opts.maxAge,
    group: 'status',
    CARD_SCOPE_CHARS: 140,
    // `el` needs just enough of a node to exist; nothing here asserts rendering.
    document: {
      createElement: function (tag) {
        return {
          tagName: String(tag).toUpperCase(), className: '', textContent: '', children: [], childNodes: [],
          classList: { add: function () { }, toggle: function () { } },
          appendChild: function (c) { this.children.push(c); this.childNodes.push(c); return c; }
        };
      },
      createTextNode: function (t) { return { nodeValue: String(t) }; }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__api = { statusHours: statusHours, dayDelta: dayDelta, fmtDate: fmtDate, firstVal: firstVal, moneyAmt: moneyAmt, fmtMoney: fmtMoney, heatOf: heatOf, heatCount: heatCount, prioClass: prioClass, expectedOf: expectedOf, nameList: nameList, snapAgeMin: snapAgeMin };', sandbox);
  return sandbox.__api;
}

function publishCtx(src, storage) {
  var warns = [];
  var sandbox = {
    console: { warn: function (m) { warns.push(String(m)); }, info: function () { }, log: function () { } },
    Date: Date, JSON: JSON, Object: Object, parseFloat: parseFloat,
    sessionStorage: storage
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__pub = heatPublishVerdicts;', sandbox);
  return { pub: sandbox.__pub, warns: warns };
}

// =============================================================================================
console.log('\n--- 1. statusHours: the 60x fault, against the shipped reader ---');
// =============================================================================================
var R = readersCtx(S_READERS);

// The live row, as measured. 12930 minutes is what the card printed as "12930h".
A.eq('timeInStatus is read as MINUTES: the live 12930 becomes 215.5h',
  Math.round(R.statusHours({ timeInStatus: 12930 }) * 10) / 10, 215.5);
A.eq('which rounds to 216h on the card', Math.round(R.statusHours({ timeInStatus: 12930 })), 216);
// The published verdict read "215h" a few minutes EARLIER in the same session, when the field
// was ~12900 - the clock ticks a minute at a time, so the two readings are the same fact at two
// moments, not a disagreement. Pinned as its own case because getting this wrong is how a
// fixture ends up agreeing with whatever the code happens to do.
A.eq('and 12900, the reading behind the 215h List Heat published, gives exactly that',
  Math.round(R.statusHours({ timeInStatus: 12900 })), 215);
A.eq('W-326991: 78995 -> 1317h, not 78995h',
  Math.round(R.statusHours({ timeInStatus: 78995 })), 1317);
A.eq('and 1317h is 54.9 days, which fits inside that WO\'s 202-day age - 78995h would not',
  Math.round(R.statusHours({ timeInStatus: 78995 }) / 24), 55);
A.eq('W-378642: 1308 -> 22h, the case that looks plausible as hours and is not',
  Math.round(R.statusHours({ timeInStatus: 1308 })), 22);
A.ok('the raw field value is never what is shown',
  R.statusHours({ timeInStatus: 12930 }) !== 12930);
// An hours-named field is trusted as hours, never converted twice - same rule as
// heatApiRowToEntry, so a schema that starts emitting one needs no guess here.
A.eq('an hours-named field is taken as hours', R.statusHours({ hoursInStatus: 215 }), 215);
A.eq('and it WINS over the minutes field rather than being divided again',
  R.statusHours({ hoursInStatus: 215, timeInStatus: 12930 }), 215);
A.eq('hrsInStatus is the same fact under another name', R.statusHours({ hrsInStatus: 40 }), 40);
// Absent is absent: no clock line, not a zero-hour claim.
A.eq('no time field at all -> null, so the card prints no clock', R.statusHours({ number: 1 }), null);
A.eq('an empty string is absent, not zero', R.statusHours({ timeInStatus: '' }), null);
A.eq('a non-numeric value is absent', R.statusHours({ timeInStatus: 'n/a' }), null);
A.eq('zero minutes is a real reading and stays 0', R.statusHours({ timeInStatus: 0 }), 0);
A.eq('a string of digits still reads', Math.round(R.statusHours({ timeInStatus: '600' })), 10);

console.log('\n--- 2. dates: past vs future, and the year that used to be dropped ---');
var DAY = 86400000;
function isoAgo(days) { return new Date(Date.now() - days * DAY).toISOString(); }
A.ok('a date 47 days back reads as the past', R.dayDelta(isoAgo(47)) <= -46 && R.dayDelta(isoAgo(47)) >= -48);
A.ok('a date 67 days ahead reads as the future', R.dayDelta(isoAgo(-67)) >= 66 && R.dayDelta(isoAgo(-67)) <= 68);
A.eq('today is 0, not -1 (whole days, not elapsed ms)', R.dayDelta(new Date().toISOString()), 0);
A.eq('an absent date has no delta', R.dayDelta(null), null);
A.eq('an unparseable date has no delta', R.dayDelta('not a date'), null);
// 91 of the 96 onsite dates on the live board were in the past; a month/day-only chip made
// those indistinguishable from the 5 that were still to come.
var lastYear = new Date(); lastYear.setFullYear(lastYear.getFullYear() - 1);
A.ok('a date from another year carries the year', /\/\d\d$/.test(R.fmtDate(lastYear.toISOString())));
var thisYear = new Date(); thisYear.setMonth(0); thisYear.setDate(9);
A.eq('a date in this year stays month/day', R.fmtDate(thisYear.toISOString()), '1/9');

console.log('\n--- 3. money: minor units, and GP needs BOTH numbers ---');
// Measured live: doNotExceed = { amount: 5560948, precision: 2 } = $55,609.48, and the board's
// own money path was already right - this pins it so the reader rewrite did not break it.
A.eq('minor units scale by precision', R.moneyAmt({ amount: 5560948, precision: 2 }), 55609.48);
A.eq('and format to the whole dollars the chip shows', R.fmtMoney(R.moneyAmt({ amount: 5560948, precision: 2 })), '$55,609');
A.eq('precision 0 is not divided', R.moneyAmt({ amount: 42243, precision: 0 }), 42243);
A.eq('a missing precision defaults to 2, the shape the server sends', R.moneyAmt({ amount: 100 }), 1);
A.eq('a plain number is already major units', R.moneyAmt(1500), 1500);
A.eq('absent money is null, so no chip', R.moneyAmt(null), null);
A.eq('an object with no amount is null', R.moneyAmt({ currency: 'USD' }), null);
A.eq('null formats to null rather than "$0"', R.fmtMoney(null), null);

console.log('\n--- 3b. the row shape, captured off the wire 2026-08-05 ---');
// Not an invented fixture: this is W-283834 as `PagedWorkOrders` actually returned it, copied
// from a take:3 replay of the captured request. It is here because three of this version's own
// card lines were WRONG against it before it was measured - the fuller-picture fields exist,
// but not at the paths a schema listing would suggest.
var LIVE_ROW = {
  number: 283834, timeInStatus: 100477, numberOfDays: 391, remainingDays: -4,
  lastNoteDate: '2026-08-04T13:09:19.9627231+00:00',
  nextOnsiteDate: '2026-07-17T16:56:19.8270967+00:00',
  priority: {
    __typename: 'JobPriority', label: 'P2 Next Day',
    firstTripDate: '2025-07-10T11:08:00-04:00',
    expectedCompletionDate: '2026-07-31T15:08:00+00:00', category: 'High'
  },
  totalNTE: { __typename: 'Money', amount: 18206964, currency: 'USD', precision: 2 },
  doNotExceed: { __typename: 'Money', amount: 22972692, currency: 'USD', precision: 2 },
  vendorNames: ['HERITAGE ELECTRICAL SERVICES LLC', 'LSI INDUSTRIES INC', 'WISCONSIN LIGHTING LAB, INC. ',
    'UPS - UNITED PARCEL SERVICE', 'C.H Robinson Company, Inc', 'Murdoch Engineering LLC - Jere Murdoch', 'UNITED HDD LLC'],
  trades: [{ __typename: 'TradeV2', id: '2499dd5f', name: 'Exterior Lighting', systemTradeName: 'Lighting', isSystemTrade: false, hidden: null }],
  phase: 'Open', statusName: 'Pending Materials Supplier', statusId: 41, clientName: 'Pilot Travel Centers'
};
A.eq('the live row has NO top-level expectedCompletionDate', 'expectedCompletionDate' in LIVE_ROW, false);
A.eq('but it does carry one under priority, which is where the card must look',
  R.expectedOf(LIVE_ROW), '2026-07-31T15:08:00+00:00');
A.eq('no complete-by anywhere -> null, and the card falls to remainingDays instead',
  R.expectedOf({ number: 1, priority: { label: 'P2 Next Day' } }), null);
A.eq('a top-level date still wins if a future selection includes one',
  R.expectedOf({ expectedCompletionDate: '2026-01-01', priority: { expectedCompletionDate: '2026-09-09' } }), '2026-01-01');
// remainingDays -4 and a priority.expectedCompletionDate 4 days past agree - that is why one
// can stand in for the other.
//
// Measured against the CAPTURE date, not against today. This assertion used to call
// R.dayDelta(), which measures from Date.now(): the fixture's -4 was Umbrava's own answer on
// 2026-08-04, so the two sides drifted one day further apart with every day that passed and the
// suite went red on 2026-08-06 with no code change behind it. Re-capturing the row would only
// restart the same clock, and widening the tolerance would delete the assertion's meaning - the
// claim being tested is that the two fields AGREED when the row was read, which is a fact about
// that moment. dayDelta's own now-relative behaviour is covered above, on synthetic dates built
// from Date.now() (isoAgo), where drift is impossible by construction.
//
// Whole-day floor on both sides, identical to dayDelta's with today swapped for the reference.
var CAPTURED_ON = '2026-08-05';   // the header date of this fixture; -4 puts Umbrava's read one day earlier, inside the 1-day tolerance
function daysFromCapture(iso) {
  if (!iso) return null;
  var t = new Date(iso);
  if (isNaN(t.getTime())) return null;
  var p = CAPTURED_ON.split('-');
  var ref = new Date(+p[0], +p[1] - 1, +p[2]);
  var a = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((a - ref) / 86400000);
}
A.ok('remainingDays agreed with the nested date it substitutes for, as captured',
  Math.abs(daysFromCapture(R.expectedOf(LIVE_ROW)) - LIVE_ROW.remainingDays) <= 1);
// trades are OBJECTS. Joining them raw is "[object Object]" on nearly every card.
A.eq('trades resolve to their names', R.nameList(LIVE_ROW.trades), 'Exterior Lighting');
A.eq('several trades join', R.nameList([{ name: 'Electrical' }, { name: 'Plumbing' }]), 'Electrical, Plumbing');
A.eq('a trade with only a system name still reads', R.nameList([{ systemTradeName: 'Lighting' }]), 'Lighting');
A.eq('vendorNames really are plain strings and pass through', R.nameList(LIVE_ROW.vendorNames.slice(0, 2)),
  'HERITAGE ELECTRICAL SERVICES LLC, LSI INDUSTRIES INC');
A.eq('an empty trade list prints nothing', R.nameList([]), '');
A.eq('an absent trade field prints nothing', R.nameList(null), '');
A.ok('no rendering path can emit [object Object]', R.nameList(LIVE_ROW.trades).indexOf('[object') === -1);
// The money the card now shows, on the real amounts. CSV export for the same WO the previous
// morning: Client DNE 229726.92, Total Vendor NTE 182069.64.
A.eq('DNE off the wire', R.moneyAmt(LIVE_ROW.doNotExceed), 229726.92);
A.eq('vendor NTE off the wire, which 0.3.0 never showed at all', R.moneyAmt(LIVE_ROW.totalNTE), 182069.64);
A.eq('so GP is computable on the board for the first time',
  Math.round((R.moneyAmt(LIVE_ROW.doNotExceed) - R.moneyAmt(LIVE_ROW.totalNTE)) / R.moneyAmt(LIVE_ROW.doNotExceed) * 100), 21);
A.eq('and the status clock on this row is 1675h, not 100477h',
  Math.round(R.statusHours(LIVE_ROW)), 1675);
A.eq('which is 70 days - inside its 391-day age, where 100477h (11.5 years) is not',
  Math.round(R.statusHours(LIVE_ROW) / 24), 70);

console.log('\n--- 4. firstVal: an absent field prints nothing, it does not print a zero ---');
A.eq('first present key wins', R.firstVal({ b: 2, a: 1 }, ['a', 'b']), 1);
A.eq('falls through to the synonym', R.firstVal({ b: 2 }, ['a', 'b']), 2);
A.eq('empty string counts as absent', R.firstVal({ a: '' }, ['a', 'b']), null);
A.eq('null counts as absent', R.firstVal({ a: null }, ['a']), null);
A.eq('a real zero is NOT absent', R.firstVal({ a: 0 }, ['a']), 0);
A.eq('nothing found -> null', R.firstVal({ z: 1 }, ['a', 'b']), null);

console.log('\n--- 5. heatOf: severity is READ, never computed here (0.5.0: off the snapshot) ---');
var HMAP = {
  '326938': { sev: 2, reasons: ['215h in "Scheduled" (limit 120h)', 'complete-by overdue 5d'], kinds: ['clock'], acked: false, warn: 60, bad: 120, id: '326938' },
  '327076': { sev: 1, reasons: ['c'], kinds: ['note'], acked: true, warn: 60, bad: 120, id: '327076' }
};
var R2 = readersCtx(S_READERS, { heatMap: HMAP, rows: [{ number: 326938 }, { number: 327076 }, { number: 777777 }] });
A.eq('a verdict from the snapshot is read back', R2.heatOf(326938).sev, 2);
A.eq('with the limits the row was judged against', [R2.heatOf(326938).warn, R2.heatOf(326938).bad], [60, 120]);
A.eq('a W-prefixed number resolves to the same entry', R2.heatOf('W-326938').sev, 2);
A.eq('a WO with no record has no severity, which is not sev 0', R2.heatOf(777777), null);
A.eq('heatCount reports only the rows severity is actually known for', R2.heatCount(), 2);
// The staleness read: the board shows the AUTHORITY's scan time, not its own render time.
var R2b = readersCtx(S_READERS, { pullState: { running: false, ok: true, reason: null, ts: Date.now() - 7 * 60000 } });
A.eq('snapshot age is read off the scan timestamp', R2b.snapAgeMin(), 7);
A.eq('no timestamp means no age claim, not "0m ago"',
  readersCtx(S_READERS, { pullState: { running: false, ok: false, reason: 'never scanned', ts: null } }).snapAgeMin(), null);
// 0.5.0 contract: the per-WO bus slot is no longer this file's input. It could never have been
// the board's input - it carries a verdict and no row - so a read of it here would mean rows and
// verdicts came from two different scans.
A.ok('the kanban no longer reads the bwn:heat: slot directly',
  kbFull.indexOf("sessionStorage.getItem('bwn:heat:") === -1);
// Targets the READ, not the word: the op name still appears in comments and in OP, because the
// capture that feeds the status write is keyed on it.
A.ok('and no longer replays a list query of its own',
  !/data\.listWorkOrdersPaginated/.test(kbFull) && !/function\s+replayPage/.test(kbFull));
A.ok('the only /api/graphql fetch left in the board is the status write',
  (kbFull.match(/fetch\('\/api\/graphql'/g) || []).length === 1);
// ...but the CAPTURE must survive, because the drag write's auth headers come from it. This is
// the trap: deleting the scan and the hook together silently kills the only write path.
A.ok('the capture hook is still installed', /function\s+noteRequest/.test(kbFull) && /window\.fetch = function/.test(kbFull));
A.ok('and the patch write still replays the captured headers',
  /headers: lastReq\.headers/.test(kbFull) && /operationName: PATCH_OP/.test(kbFull));
// The architectural guard: the board must not be able to reach its own opinion.
A.ok('the kanban file contains no threshold model at all',
  !/hrsWarn|hrsBad|activeMult|thresholdsFor|PRIO_MULT|RESP_BASE_MIN/.test(kbFull));
A.ok('and no computeVerdict of its own', !/function\s+computeVerdict/.test(kbFull));

console.log('\n--- 6. the core-side publish, on the shipped bytes ---');
var pst = makeStorage();
var P = publishCtx(S_PUBLISH, pst);
var store = {
  '/work-orders/326938': { id: '326938', sev: 2, reasons: ['a', 'b'], acked: false, hrs: '215.5', warn: 60, bad: 120, status: 'Scheduled' },
  '/work-orders/327020': { id: '327020', sev: 0, reasons: [], acked: false, hrs: '356.2', warn: 60, bad: 120, status: 'Scheduled' },
  '/work-orders/327076': { id: '327076', sev: 1, reasons: ['c'], acked: true, hrs: '', warn: null, bad: null, status: 'Pending Schedule' },
  '/work-orders/noid': { sev: 2, reasons: [] }
};
A.eq('every row with an id is published, quiet ones included', P.pub(store), 3);
A.eq('and that is the whole store, not just the flagged rows', pst._n(), 3);
var rec = JSON.parse(pst.getItem('bwn:heat:326938'));
A.eq('the payload version stays 1, because busHeatGet rejects anything else', rec.v, 1);
A.eq('severity rides along', rec.sev, 2);
A.eq('so do the reasons, as the authority worded them', rec.reasons, ['a', 'b']);
A.eq('hours arrive as a number, not the stored string', rec.hrs, 215.5);
A.eq('and so do the limits', [rec.warn, rec.bad], [60, 120]);
A.eq('src marks where the verdict came from', rec.src, 'api');
var rec0 = JSON.parse(pst.getItem('bwn:heat:327020'));
A.eq('a sev-0 row is published as sev 0 - which is a fact, unlike an absent record', rec0.sev, 0);
var recA = JSON.parse(pst.getItem('bwn:heat:327076'));
A.eq('an acked row says so', recA.acked, true);
A.eq('a row with no readable clock publishes hrs null, not 0', recA.hrs, null);
A.eq('and null limits rather than 0h limits', [recA.warn, recA.bad], [null, null]);
A.eq('a store row with no id is skipped', pst.getItem('bwn:heat:undefined'), null);
A.eq('a null store publishes nothing', P.pub(null), 0);

// Quota: the publish must degrade loudly. A silent stop leaves a consumer reading stale heat
// for the unwritten rows with no way to tell.
var qst = makeStorage(2);
var Q = publishCtx(S_PUBLISH, qst);
A.eq('a full quota stops the publish at the row that failed', Q.pub(store), 2);
A.ok('and says so out loud', Q.warns.length === 1 && /stopped after 2 of 4/.test(Q.warns[0]));

console.log('\n--- 6b. the fold: Core hands rows over, and force bypasses the TTL guard ---');
// THE DEFECT THIS SECTION EXISTS FOR. Core's auto-scan early-returns when the filter signature
// is unchanged and its 3-minute TTL has not expired. A status write changes NO filter, so a
// second after a drag both conditions hold: without a force flag Core does nothing, the board
// reads back the PRE-WRITE snapshot, and a write that was never re-read reports as verified.
// On the suite's only Umbrava write mutation.
//
// The guard's own bytes are lifted out of the shipped file and evaluated - not a paraphrase of
// it, because a paraphrase would pass while the file said something else.
// Captures the CONDITION only. 1.76.1 added a diagnostic counter inside each guard block, so a
// pattern that assumed a bare `return;` breaks - and did.
var guardM = coreFull.match(/\n\s*if \((!force && sig && sig === heatAutoSig[^\n]*?)\) \{ heatDiag\.autoNoTtl/);
A.ok('the TTL guard is present and takes a force argument', !!guardM);
var guardCond = guardM[1];
function guardFires(o) {
  var f = new Function('force', 'sig', 'heatAutoSig', 'heatStore', 'heatAutoTs', 'HEAT_AUTO_TTL', 'Date',
    'return !!(' + guardCond + ');');
  return f(o.force, o.sig, o.heatAutoSig, o.heatStore, o.heatAutoTs, 3 * 60 * 1000, Date);
}
var SAME = { sig: 'phase=open|status=all', heatAutoSig: 'phase=open|status=all', heatStore: {}, heatAutoTs: Date.now() - 1000 };
function withForce(f) { var o = JSON.parse(JSON.stringify(SAME)); o.heatStore = {}; o.heatAutoTs = SAME.heatAutoTs; o.force = f; return o; }
A.ok('UNFORCED, same filters, inside the TTL: the guard fires and no scan runs - this is the bug',
  guardFires(withForce(false)) === true);
A.ok('FORCED, all else identical: the guard does NOT fire, so the write gets re-read',
  guardFires(withForce(true)) === false);
A.ok('a changed filter still scans without force, as it always did',
  guardFires({ force: false, sig: 'phase=closed', heatAutoSig: 'phase=open', heatStore: {}, heatAutoTs: Date.now() }) === false);
A.ok('an expired TTL still scans without force',
  guardFires({ force: false, sig: 'a', heatAutoSig: 'a', heatStore: {}, heatAutoTs: Date.now() - 10 * 60000 }) === false);
// And the caller: the drag path must ask for force. This is the line a future edit is most
// likely to "simplify" back into the bug.
A.ok('the kanban drag re-read asks for a FORCED scan', /requestScan\(true\);/.test(kbFull));
A.ok('and it is the post-write path that does so',
  /Always re-read from the API rather than trusting the optimistic move[\s\S]{0,900}?requestScan\(true\);/.test(kbFull));

// Core's row snapshot, on the shipped bytes.
var S_ROWS = sliceCore('    function heatRowsBuild() {', '    // Why there is no clean store to hand over', 'heatRowsBuild');
var S_WHY = sliceCore('    function heatRowsWhy() {', '\n    // ---- Board -> Dashboard dataset push', 'heatRowsWhy');
function rowsCtx(src, env) {
  var sandbox = {
    Object: Object, Date: Date, JSON: JSON, String: String, Number: Number, Array: Array,
    heatStore: env.heatStore, heatRaw: env.heatRaw, heatScanClean: env.heatScanClean,
    heatScanning: !!env.heatScanning,
    heatReplaying: !!env.heatReplaying, heatScanNote: env.heatScanNote || null,
    apiList: env.apiList === undefined ? { query: 'q' } : env.apiList
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__f = typeof heatRowsBuild === "function" ? heatRowsBuild : heatRowsWhy;', sandbox);
  return sandbox.__f;
}
var RAW1 = { number: 326938, statusId: 77, statusName: 'Scheduled', clientName: 'ACME', trades: [{ name: 'HVAC' }] };
var okBuild = rowsCtx(S_ROWS, {
  heatScanClean: true,
  heatStore: { '/work-orders/326938': { id: '326938', wo: 'W-326938', sev: 2, reasons: ['a'], kinds: ['clock'], acked: false, warn: 60, bad: 120, status: 'Scheduled', hrs: '215.5' } },
  heatRaw: { '/work-orders/326938': RAW1 }
})();
A.eq('a clean scan yields a row', okBuild.rows.length, 1);
A.ok('the RAW api row rides along - without it the card has no statusId and the drag is dead',
  okBuild.rows[0].raw === RAW1 && okBuild.rows[0].raw.statusId === 77);
A.eq('the authority\'s verdict rides beside it', [okBuild.rows[0].sev, okBuild.rows[0].bad], [2, 120]);
A.ok('the result is frozen', Object.isFrozen(okBuild) && Object.isFrozen(okBuild.rows) && Object.isFrozen(okBuild.rows[0]));
// Object.freeze is SHALLOW. reasons and kinds are the arrays a consumer is most likely to sort
// or splice in place, so they are frozen individually - asserted, not assumed.
A.ok('and so are the nested reasons/kinds arrays',
  Object.isFrozen(okBuild.rows[0].reasons) && Object.isFrozen(okBuild.rows[0].kinds));
A.eq('a DIRTY scan yields nothing at all, however full the store is', rowsCtx(S_ROWS, {
  heatScanClean: false,
  heatStore: { '/work-orders/1': { id: '1', sev: 2, reasons: [] } },
  heatRaw: { '/work-orders/1': RAW1 }
})(), null);
A.eq('a row with no raw row behind it is dropped rather than rendered half-blank', rowsCtx(S_ROWS, {
  heatScanClean: true,
  heatStore: { '/work-orders/1': { id: '1', sev: 2, reasons: [] } },
  heatRaw: {}
})().rows.length, 0);
// The reasons are distinguishable ON PURPOSE - each names a different operator action.
A.eq('no capture -> reload the list', rowsCtx(S_WHY, { apiList: null, heatStore: null, heatRaw: null, heatScanClean: false })(), 'no capture yet');
A.eq('mid-scan says so rather than "never scanned"', rowsCtx(S_WHY, { heatScanning: true, heatStore: null, heatRaw: null, heatScanClean: false })(), 'scan in progress');
A.eq('a store that never went clean reads as degraded', rowsCtx(S_WHY, { heatStore: {}, heatRaw: {}, heatScanClean: false })(), 'scan degraded to scroll');
A.eq('and nothing at all reads as never scanned', rowsCtx(S_WHY, { heatStore: null, heatRaw: null, heatScanClean: false })(), 'never scanned');
// The board must render the reason, not invent one.
A.ok('the board renders Core\'s reason string', /pullState\.reason/.test(kbFull));
A.ok('and distinguishes an absent Core from an unscanned one',
  /core unavailable/.test(kbFull) && /Reinstall bwn-suite-core/.test(kbFull));
A.ok('an empty board only claims "no work orders" when the pull actually succeeded',
  /!pullState\.running && pullState\.ok\) lanes\.appendChild/.test(kbFull));
// Ack is read LIVE, not off the frozen snapshot - Core does the same for its own rows.
A.ok('the board reads ack state live rather than trusting the snapshot',
  /__bwnHeatAck/.test(kbFull) && /function\s+liveAcked/.test(kbFull));
A.ok('and Core exposes exactly that', /window\.__bwnHeatAck = function/.test(coreFull));
A.ok('Core exposes the row accessor and the scan control', /window\.__bwnHeatRows = function/.test(coreFull) && /window\.__bwnHeatScan = function/.test(coreFull));
// heatRaw must be cleared everywhere heatStore is, or one scan's severity renders against
// another scan's rows.
// Excludes the `var heatStore = null` DECLARATION, which is paired with its own
// `var heatRaw = null` two lines down rather than on the same statement.
A.eq('every heatStore RESET clears heatRaw with it',
  (coreFull.match(/(?<!var )heatStore = null/g) || []).length,
  (coreFull.match(/heatStore = null; heatRaw = null|\{ heatStore = null; heatRaw = null/g) || []).length);
A.ok('and heatRaw is declared alongside heatStore, so the declaration site is covered too',
  /var heatStore = null;[\s\S]{0,1400}?var heatRaw = null;/.test(coreFull));

console.log('\n--- 7. source pins: the two writers on bwn:heat, and the version drift ---');
// Same key, two writers - the v3.20 fault. The DOM tinting pass runs on every virtualizer
// tick, so a leaner payload there would silently overwrite the richer API record for exactly
// the rows on screen. Both literals are extracted and compared key-for-key.
function keysOfLiteral(src, anchor, what) {
  var i = src.indexOf(anchor);
  if (i === -1) throw new Error(what + ': anchor not found');
  var j = src.indexOf('}))', i);
  if (j === -1) throw new Error(what + ': literal end not found');
  var body = src.slice(i, j);
  var out = [];
  body.replace(/(^|[\s{,])([A-Za-z_][A-Za-z0-9_]*)\s*:/g, function (m, p, k) { out.push(k); return m; });
  return out.sort();
}
var domKeys = keysOfLiteral(coreFull, "sessionStorage.setItem('bwn:heat:' + rowId, JSON.stringify({", 'DOM writer');
var apiKeys = keysOfLiteral(coreFull, "sessionStorage.setItem('bwn:heat:' + r.id, JSON.stringify({", 'API writer');
A.eq('the DOM writer and the API writer emit the SAME payload keys', domKeys, apiKeys);
A.ok('and both carry the limits, so neither thins the other out',
  domKeys.indexOf('warn') > -1 && domKeys.indexOf('bad') > -1 && domKeys.indexOf('hrs') > -1);
A.ok('computeVerdict returns the limits it judged with', /v\.warn = th\.warn; v\.bad = th\.bad;/.test(coreFull));
A.ok('and initialises them to null, so a done row claims no limit', /slaScaled: false, warn: null, bad: null/.test(coreFull));
A.ok('the publisher is called on scan finish AND after assignee resolution',
  (coreFull.match(/heatPublishVerdicts\(/g) || []).length === 3);   // 1 definition + 2 call sites

// buildCard cannot regress to the raw field, and cannot grow a second severity source.
var S_CARD = sliceKb('  function buildCard(r) {', '  var dragged = null;', 'buildCard');
A.ok('buildCard reads the clock through statusHours', /statusHours\(r\)/.test(S_CARD));
A.ok('and never touches r.timeInStatus directly', !/r\.timeInStatus/.test(S_CARD));
A.ok('severity on the card comes only from heatOf', /heatOf\(r\.number\)/.test(S_CARD));
A.ok('the status chip is unconditional now, not only when lanes are not status',
  !/group !== 'status' && r\.statusName/.test(S_CARD));
A.ok('the confirm dialog quotes corrected hours too', /statusHours\(row\)/.test(kbFull));

// The 0.3.0 drift: @version said 0.3.0 while the console constant said 0.2.0.
var mVer = kbFull.match(/@version\s+(\S+)/);
var mConst = kbFull.match(/var VER = '([^']+)'/);
A.ok('the metadata @version and the VER constant agree', !!(mVer && mConst) && mVer[1] === mConst[1]);
A.eq('and this is the version under test', mVer && mVer[1], '0.6.0');
// The mirror (Intermu/userscripts-public) is being retired now that the source repo is public
// again; raw URLs must point at the SOURCE repo or auto-update dies with the mirror.
A.ok('the script points at the source repo raw URL, so it can auto-update at all',
  /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/Intermu\/userscripts\/main\/bwn-kanban\.user\.js/.test(kbFull) &&
  /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/Intermu\/userscripts\/main\/bwn-kanban\.user\.js/.test(kbFull));
A.ok('it still runs at document-start, or the capture loses the race with the app',
  /@run-at\s+document-start/.test(kbFull));
A.ok('and still takes no grant, or the fetch hook lands in the sandbox instead of the page',
  /@grant\s+none/.test(kbFull));

console.log('\n--- 8. lane roll-up constants match what was measured ---');
A.ok('lanes of 3 or fewer roll up', /var LANE_ROLL_MAX = 3;/.test(kbFull));
A.ok('but only past 12 lanes, so a small filtered board keeps every drop target',
  /var LANE_ROLL_WHEN = 12;/.test(kbFull));
A.ok('the roll-up lane refuses drops, because it names no single status',
  /if \(mixed\) \{ alert\(/.test(kbFull));
A.ok('cards are sorted worst-first, not by age alone', /function worstFirst/.test(kbFull));

// =============================================================================================
console.log('\n--- MUTATION CONTROLS (each must make the assertions above go red) ---');
// =============================================================================================
function ctlThrows(name, fn) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  A.ok(name, threw);
}

// M1: the fix itself. Stop dividing and the reader returns the raw minutes again.
var m1 = readersCtx(mutate(S_READERS, 'return parseFloat(m) / 60;', 'return parseFloat(m);'));
A.eq('M1 control: without the /60 the card is back to printing minutes as hours',
  m1.statusHours({ timeInStatus: 12930 }), 12930);
A.ok('M1 control: which is 60x the published verdict for the same WO',
  m1.statusHours({ timeInStatus: 12930 }) === 60 * R.statusHours({ timeInStatus: 12930 }));

// M2: trust the name instead of reading the units as separate keys.
var m2 = readersCtx(mutate(S_READERS,
  "var h = firstVal(r, ['hoursInStatus', 'hrsInStatus', 'statusHours', 'statusHrs']);",
  "var h = firstVal(r, ['nothingMatchesThisKey']);"));
A.ok('M2 control: with the hours keys unreadable the hours field is ignored entirely',
  m2.statusHours({ hoursInStatus: 215, timeInStatus: 12930 }) !== 215);
A.ok('M2 control: and an hours-only row falls to null instead of reading',
  m2.statusHours({ hoursInStatus: 215 }) === null);

// M3: drop the year and a last-year onsite date is indistinguishable from an upcoming one.
var m3 = readersCtx(mutate(S_READERS,
  "+ (t.getFullYear() !== now.getFullYear() ? '/' + String(t.getFullYear()).slice(-2) : '')", ''));
A.ok('M3 control: without the year clause a date from another year loses it',
  !/\/\d\d$/.test(m3.fmtDate(lastYear.toISOString())));

// M4: stop scaling minor units and money is 100x, the v3.19 DNE fault.
var m4 = readersCtx(mutate(S_READERS, 'return m.amount / Math.pow(10, p);', 'return m.amount;'));
A.eq('M4 control: unscaled minor units print 100x over',
  m4.fmtMoney(m4.moneyAmt({ amount: 5560948, precision: 2 })), '$5,560,948');

// M5: RETARGETED for 0.5.0. The old control gated the bus slot's `v` field, which this file no
// longer reads at all - it went with the sessionStorage read when rows and verdicts merged into
// one snapshot. mutate() threw rather than silently no-opping when it went, which is the whole
// point of that guard. The equivalent risk now is the digit-normalising key: drop it and a
// 'W-326938' row stops resolving to its own verdict, so every card silently loses severity.
var m5 = readersCtx(mutate(S_READERS,
  "var k = String(num == null ? '' : num).replace(/\\D/g, '');", "var k = String(num == null ? '' : num);"),
  { heatMap: HMAP, rows: [{ number: 'W-326938' }] });
A.eq('M5 control: without digit-normalising, a W-prefixed row loses its verdict', m5.heatOf('W-326938'), null);
A.eq('M5 control: and the board would report severity known for none of its rows', m5.heatCount(), 0);

// M5b: THE FOLD'S OWN CONTROL. Remove the force bypass and the guard fires on a forced call -
// which is the pre-fix behaviour: a drag write verified against the pre-write store.
var guardNoForce = guardCond.replace('!force && ', '');
A.ok('M5b control: the mutation actually changed the guard', guardNoForce !== guardCond);
A.ok('M5b control: without the force bypass, a forced re-read after a write does NOT scan',
  (new Function('force', 'sig', 'heatAutoSig', 'heatStore', 'heatAutoTs', 'HEAT_AUTO_TTL', 'Date',
    'return !!(' + guardNoForce + ');'))(true, 'a', 'a', {}, Date.now() - 1000, 3 * 60 * 1000, Date) === true);

// M6: publish only the flagged rows and the quiet majority loses its record - which is exactly
// the 22-of-219 coverage the DOM-only writer produced before v3.24.
var pst6 = makeStorage();
var P6 = publishCtx(mutate(S_PUBLISH, 'if (!r || !r.id) continue;', 'if (!r || !r.id || !r.sev) continue;'), pst6);
A.eq('M6 control: a sev-gated publish drops the quiet rows', P6.pub(store), 2);
A.eq('M6 control: so a consumer sees no severity for a row that HAS a verdict of sev 0',
  pst6.getItem('bwn:heat:327020'), null);

// M7: thin the DOM writer's payload and the two writers stop agreeing on the key set.
var core7 = mutate(coreFull, 'hrs: isNaN(domHrs) ? null : domHrs, warn: vf.warn, bad: vf.bad,', '');
var dom7 = keysOfLiteral(core7, "sessionStorage.setItem('bwn:heat:' + rowId, JSON.stringify({", 'DOM writer (mutated)');
A.ok('M7 control: a thinned DOM payload no longer matches the API payload',
  JSON.stringify(dom7) !== JSON.stringify(apiKeys));
A.ok('M7 control: and it is the limits that went missing',
  dom7.indexOf('warn') === -1 && dom7.indexOf('bad') === -1);

// M9: look only at the top level for the complete-by date - the shape 0.4.0 was first written
// against - and the live row's real date becomes invisible.
var m9 = readersCtx(mutate(S_READERS,
  "if (r && r.priority) return firstVal(r.priority, ['expectedCompletionDate', 'completeByDate']);", 'return null;'));
A.eq('M9 control: without the priority path the live row has no complete-by at all',
  m9.expectedOf(LIVE_ROW), null);

// M10: join the trade array raw, which is what a plain .join() does to objects.
var m10 = readersCtx(mutate(S_READERS,
  "return (typeof x === 'object') ? String(x.name || x.systemTradeName || '') : String(x);", 'return String(x);'));
A.ok('M10 control: joining trade objects raw prints [object Object] on the card',
  m10.nameList(LIVE_ROW.trades).indexOf('[object') === 0);

// M8: a slice marker that no longer exists must fail loudly, not silently return nothing.
ctlThrows('M8 control: a missing slice marker throws instead of yielding an empty slice',
  function () { sliceKb('  function thisFunctionDoesNotExist(', '  function groupDef() {', 'bogus'); });
ctlThrows('M8 control: and an absent mutation target throws rather than no-opping',
  function () { mutate(S_READERS, 'return parseFloat(m) / 3600;', 'x'); });

A.finish();
