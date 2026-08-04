// test-heat-api-scan.js - node harness for WO List Heat v3.18: the API scan that never ran.
//
// WHAT WAS BROKEN, measured against the live board on 2026-08-04 (not inferred):
//   1. CAPTURE NEVER LATCHED. v3.15-3.17 only accepted a list query when the RESPONSE body
//      could be read, via res.clone().json() in the fetch/XHR hook. The app aborts its own
//      fetches on teardown, so every clone read rejected with AbortError - measured across
//      every operation on the page, board query included. apiList therefore stayed null,
//      which is why no auto-scan ever ran and why "Scan All" always fell through to the
//      slow scroll sweep: the overlay demanded a full scan on every arrival at the list.
//   2. THE PAGING ARG WAS THE WRONG TYPE. Umbrava's board op is PagedWorkOrders with
//      `page: PageInput!` - an OBJECT, {skip, take}. The replay's key sniffing matched the
//      name "page" and wrote the NUMBER 1 over it, and the server rejects the whole call:
//      'Variable "$page" got invalid value 1; Expected type "PageInput" to be an object.'
//      So even a successful capture could not have produced a full board.
//   3. __typename OUTRANKED THE REAL FIELD. heatApiRowToEntry takes the first key its
//      regex matches; GraphQL adds __typename to every object, so `priority.__typename`
//      beat `priority.label` and `doNotExceed.__typename` beat `doNotExceed.amount`.
//      Priority scales the status time limits, so every API-scanned row would have been
//      judged against the thresholds for a priority named "Priority".
//
// Drives the REAL shipped bytes: slices the paging/capture/replay blocks out of
// bwn-suite-core.user.js and runs them in a vm against a transport that models the live
// contract measured above - PageInput enforced, rowCount 213, take honored, a short final
// page. Nothing here proves the browser hook fires; the live gate is one arrival on the WO
// list where the strip must read "of N open - full board" with no click.
//
// Every mutation reverts one piece of the fix in the sliced source and asserts this harness
// goes red. mutate() throws if its target string is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-heat-api-scan.js

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

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var core = readLF(CORE_SRC);

// ---- The four real blocks under test ------------------------------------------------
var SRC_PAGING = slice(core,
  '    function heatFilterSig(vars) {',
  '    function heatIsUmbravaToken(tok) {',
  'heatFilterSig + paging/total/board-shape discovery');
var SRC_FIND = slice(core,
  '    // A row "looks like a WO" if it carries a numeric WO number key.',
  '    // Flatten a row one level',
  'heatLooksLikeWO/heatFindWOList/heatRowsAtPath/heatContainerAtPath');
var SRC_MAP = slice(core,
  '    // `__typename` is dropped at BOTH levels (v3.18).',
  '    // Record a captured list query. THE REQUEST ALONE IS ENOUGH (v3.18).',
  'heatFlatten/heatDateStr/heatApiRowToEntry');
var SRC_CAPTURE = slice(core,
  '    // Record a captured list query. THE REQUEST ALONE IS ENOUGH (v3.18).',
  '    // Install the fetch + XHR hooks ONCE per page (survives SPA route changes).',
  'heatRecordCapture');
var SRC_SCAN = slice(core,
  '    function apiScanAll(btn) {',
  '    // ---- Scan All (scroll fallback) ---',
  'apiScanAll');
var SRC_TOTAL = slice(core,
  '    function umbravaTotal() {',
  '    // ---- Acknowledge / snooze (v3.8) ---',
  'umbravaTotal');

// The pieces the sliced code leans on that live elsewhere in the file (bus, config,
// DOM, threshold engine). Stubbed, and instrumented so the assertions can see what the
// real code did rather than what it claims.
var PRELUDE = [
  'var __log = [];',
  'var console = {',
  '  info: function () { __log.push(Array.prototype.slice.call(arguments).join(" ")); },',
  '  warn: function () { __log.push("WARN " + Array.prototype.slice.call(arguments).join(" ")); }',
  '};',
  'var apiList = null, apiCapTs = 0, heatApiTotal = null;',
  'var heatReplaying = false, heatScanning = false, heatScanClean = false;',
  'var heatScanNote = null, heatScanAbort = false, heatStore = null;',
  'var PANEL_ID = "bwn-heat-panel";',
  'var __autoScans = [], __renders = 0, __snapshots = 0, __verdictFacts = [];',
  'var location = { pathname: "/work-orders", href: "https://app.umbrava.com/work-orders" };',
  // No DOM badge to read: the live list header logged "list badge total: not found", which
  // is precisely the case where the API total has to carry the coverage gate.
  'var document = { getElementById: function () { return null; }, querySelectorAll: function () { return []; } };',
  'var totCache = { path: "", v: null };',
  'function isListPage() { var p = location.pathname; return p.indexOf("/work-orders") === 0 && !/\\/work-orders\\/\\d/.test(p); }',
  'function heatAutoScanSoon(v) { __autoScans.push(v); }',
  'function heatGql(q, v) { return __transport(q, v); }',
  'function bwnConfig() { return { hrsWarn: 48, hrsBad: 96, activeMult: 1, dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7 }; }',
  'function computeVerdict(f) { __verdictFacts.push(f); return { sev: 1, reasons: ["stub"], kinds: ["limitwatch"], over30: true, limitBad: false, limitWatch: true, stale: false, noteAge: null }; }',
  'function ackGet() { return false; }',
  'function woListHeat() { __renders++; }',
  'function heatSnapshot() { __snapshots++; }',
  'function toggleAuditPanel() { }',
  'function cleanName(s) { return String(s == null ? "" : s).trim(); }',
  'function dSince(ts) { return Math.floor((__today - ts) / 86400000); }',
  'var BWN = {',
  '  parseUSDate: function (s) { var m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(String(s == null ? "" : s)); if (!m) return null; var d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])); d.setHours(0, 0, 0, 0); return d.getTime(); },',
  '  money: function (n) { return "$" + Number(n).toFixed(2); }',
  '};',
  'var parseUSDate = BWN.parseUSDate;'
].join('\n');

// ---- Fixtures modeled on the live rows (shape measured 2026-08-04) -------------------
// KEY ORDER MATTERS and is copied from the live response: the row arrives roughly
// alphabetical, so nextOnsiteDate lands BEFORE the nested priority object. g() returns the
// first matching key, so this ordering is part of the fixture, not decoration - see the
// reversed-order row below, which is the same data a reorder would hand us.
// Timestamps use midday UTC so the date strings are the same in CI (UTC) and here (EDT).
function makeRow(i) {
  return {
    __typename: 'WorkOrderListItem',
    assignedTo: 'Coordinator One',
    clientName: 'Pilot Travel Centers',
    doNotExceed: { __typename: 'Money', amount: 89871.1, currency: 'USD', precision: 2 },
    lastModifiedDate: '2026-08-03T12:00:00Z',
    lastNoteDate: '2026-07-22T12:00:00Z',
    locationName: 'Pilot Travel Center #0017',
    nextOnsiteDate: '2026-08-10T12:00:00Z',
    number: 327000 + i,
    numberOfDays: 201,
    priority: {
      __typename: 'Priority',
      label: 'Yellow - Medium Priority',
      expectedCompletionDate: '2026-08-20T12:00:00Z',
      firstTripDate: '2026-07-01T12:00:00Z'
    },
    statusName: 'Awaiting Client Approval',
    systemStatusName: 'Open',
    timeInStatus: 1293.5,
    trackingNumber: '105' + (2000 + i),
    workOrderDate: '2026-01-15T12:00:00Z'
  };
}
// The same row with the nested priority FIRST - what a schema reorder would produce. Only
// gPref's preference order keeps `sched` on nextOnsiteDate here instead of firstTripDate.
function makeRowPriorityFirst(i) {
  var r = makeRow(i), out = { __typename: r.__typename, priority: r.priority };
  Object.keys(r).forEach(function (k) { if (k !== '__typename' && k !== 'priority') out[k] = r[k]; });
  return out;
}

// The live board query's variables, verbatim in shape: `page` is a PageInput OBJECT.
function boardVars() {
  return {
    statusesInclusive: true,
    onlyUnassigned: false,
    page: { skip: 0, take: 50 },
    sortBy: [{ field: 'number', direction: 'DESC' }],
    search: null,
    assignedTo: [],
    phase: null,
    locationIds: [],
    regionIds: [],
    regionPrefixes: []
  };
}
var BOARD_QUERY = 'query PagedWorkOrders($page: PageInput!, $sortBy: [SortInput!]!, $search: String) {\n  __typename\n  listWorkOrdersPaginated(page: $page, sortBy: $sortBy, search: $search) { rowCount take items { number statusName } }\n}';

function boardRequest(vars) {
  return { operationName: 'PagedWorkOrders', query: BOARD_QUERY, variables: vars || boardVars() };
}

// Transport standing in for heatGql: resolves `data`, rejects the way the real server
// rejects. opts: { total, serverMax, strictPageInput, capAt }
function makeTransport(opts) {
  var o = opts || {};
  var total = o.total == null ? 213 : o.total;
  var calls = [];
  function t(query, vars) {
    calls.push(JSON.parse(JSON.stringify(vars)));
    var page = vars.page;
    if (o.strictPageInput !== false && (!page || typeof page !== 'object' || Array.isArray(page))) {
      return Promise.reject(new Error('Variable "$page" got invalid value ' + JSON.stringify(page === undefined ? null : page) + '; Expected type "PageInput" to be an object.'));
    }
    var skip = Number(page.skip) || 0;
    var take = Number(page.take) || 25;
    if (o.serverMax && take > o.serverMax) take = o.serverMax;
    var reachable = o.capAt == null ? total : o.capAt;   // a query that can only ever see N rows
    var items = [];
    for (var i = skip; i < Math.min(skip + take, reachable); i++) items.push(makeRow(i));
    return Promise.resolve({
      __typename: 'Query',
      listWorkOrdersPaginated: {
        __typename: 'PagedWorkOrders',
        rowCount: total,
        take: take,
        firstRowOnPage: items.length ? skip + 1 : null,
        lastRowOnPage: items.length ? skip + items.length : null,
        items: items
      }
    });
  }
  t.calls = calls;
  return t;
}

// Build a context from the REAL sliced source (optionally mutated) plus the stubs.
function build(opts) {
  var o = opts || {};
  var src = [PRELUDE, SRC_PAGING, SRC_FIND, SRC_MAP, SRC_CAPTURE, SRC_TOTAL, SRC_SCAN].join('\n\n');
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = {
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, RegExp: RegExp, Error: Error,
    Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean,
    isNaN: isNaN, isFinite: isFinite, parseFloat: parseFloat, parseInt: parseInt,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    __transport: o.transport || makeTransport({}),
    __today: new Date(2026, 7, 4).setHours(0, 0, 0, 0)
  };
  vm.runInNewContext(src, sandbox, { filename: 'heat-slice.js' });
  return sandbox;
}

function storeSize(s) { return s.heatStore ? Object.keys(s.heatStore).length : null; }

// A bare stand-in for the Scan All button: apiScanAll only sets disabled/textContent.
function fakeBtn() { return { disabled: false, textContent: 'Scan All' }; }

// ============================================================================
console.log('\n-- paging-argument discovery (the PageInput object) --');
(function () {
  var s = build({});
  var pg = s.heatPagingVars(boardVars());
  A.ok('nested PageInput is found', !!pg && pg.nested === true, JSON.stringify(pg));
  A.eq('nested host is the `page` variable', pg && pg.host, 'page');
  A.eq('nested size key is `take`', pg && pg.size, 'take');
  A.eq('nested skip key is `skip`', pg && pg.skip, 'skip');
  A.eq('captured page size is read from the object', pg && pg.pageSize, 50);

  var relay = s.heatPagingVars({ first: 25, after: null, filter: { q: 'x' } });
  A.ok('flat relay shape still found', !!relay && relay.nested === false, JSON.stringify(relay));
  A.eq('flat size key', relay && relay.size, 'first');
  A.eq('flat cursor key', relay && relay.cursor, 'after');

  var offset = s.heatPagingVars({ limit: 100, skip: 0 });
  A.eq('flat offset: size', offset && offset.size, 'limit');
  A.eq('flat offset: skip', offset && offset.skip, 'skip');

  A.eq('no paging args at all -> null', s.heatPagingVars({ id: '17', includeClosed: true }), null);
  A.eq('array-valued variables are never treated as a paging object',
    s.heatPagingVars({ sortBy: [{ take: 5 }] }), null);
  var strAsPage = s.heatPagingVars({ page: 'second', size: 10 });
  A.ok('a scalar `page` still reads as flat, not nested', strAsPage && strAsPage.nested === false, JSON.stringify(strAsPage));
})();

console.log('\n-- coverage denominator off the list container --');
(function () {
  var s = build({});
  A.eq('rowCount wins', s.heatContainerTotal({ rowCount: 213, take: 200 }), 213);
  A.eq('relay totalCount also read', s.heatContainerTotal({ totalCount: 41 }), 41);
  A.eq('no total present -> null', s.heatContainerTotal({ take: 200, items: [] }), null);
  A.eq('non-numeric total ignored', s.heatContainerTotal({ rowCount: '213' }), null);
})();

console.log('\n-- board-shaped from the REQUEST alone --');
(function () {
  var s = build({});
  A.ok('the live board request is board-shaped', s.heatQueryIsWOList(boardRequest()) === true);
  A.ok('a single-WO details read is not',
    s.heatQueryIsWOList({ operationName: 'WorkOrder', query: 'query WorkOrder($id: ID!) { workOrder(id: $id) { number } }', variables: { id: '283834' } }) === false);
  A.ok('a paged NON-work-order op is not',
    s.heatQueryIsWOList({ operationName: 'WidgetTasks', query: 'query WidgetTasks($skip: Int, $take: Int) { tasks(skip: $skip, take: $take) { id } }', variables: { skip: 0, take: 20 } }) === false);
  A.ok('a work-order op with no paging arg is not',
    s.heatQueryIsWOList({ operationName: 'WorkOrderFlagTypes', query: 'query WorkOrderFlagTypes { workOrderFlagTypes { id } }', variables: {} }) === false);
  A.ok('a request with no query text is not', s.heatQueryIsWOList({ operationName: 'PagedWorkOrders', variables: boardVars() }) === false);
})();

console.log('\n-- capture latches with NO readable response (the AbortError case) --');
(function () {
  var s = build({});
  s.heatRecordCapture(JSON.stringify(boardRequest()), null);
  A.ok('apiList latched from the request alone', !!s.apiList, 'apiList still null');
  A.eq('query text stored', s.apiList && s.apiList.query, BOARD_QUERY);
  A.eq('filters stored verbatim', s.apiList && s.apiList.variables.page, { skip: 0, take: 50 });
  A.eq('a request-only latch is not marked proven', s.apiList && s.apiList.proven, false);
  A.eq('row path deferred to the replay', s.apiList && s.apiList.path, null);
  A.eq('an auto scan was scheduled', s.__autoScans.length, 1);
  A.ok('the log says the path comes from the replay',
    s.__log.join('|').indexOf('request-only') !== -1, s.__log.join('|'));

  // A details-page read on the list route must never take the slot.
  var s2 = build({});
  s2.heatRecordCapture(JSON.stringify({ operationName: 'WorkOrder', query: 'query WorkOrder($id: ID!) { workOrder(id: $id) { number } }', variables: { id: '1' } }), null);
  A.eq('a details read does not latch', s2.apiList, null);
  A.eq('and schedules nothing', s2.__autoScans.length, 0);

  // Off the list route nothing latches at all.
  var s3 = build({});
  s3.location.pathname = '/work-orders/283834/details';
  s3.heatRecordCapture(JSON.stringify(boardRequest()), null);
  A.eq('no latch off the list route', s3.apiList, null);

  // Our own replay pages must not be re-captured.
  var s4 = build({});
  s4.heatReplaying = true;
  s4.heatRecordCapture(JSON.stringify(boardRequest()), null);
  A.eq('replay pages are ignored', s4.apiList, null);
})();

console.log('\n-- capture: same query refreshes filters, rivals do not displace a proven one --');
(function () {
  var s = build({});
  s.heatRecordCapture(JSON.stringify(boardRequest()), null);
  var filtered = boardVars();
  filtered.search = 'pilot';
  filtered.page = { skip: 0, take: 50 };
  s.heatRecordCapture(JSON.stringify(boardRequest(filtered)), null);
  A.eq('same query text -> variables refreshed', s.apiList.variables.search, 'pilot');
  A.eq('and the auto scan re-armed for the new filter set', s.__autoScans.length, 2);

  var s2 = build({});
  s2.apiList = { query: 'query Board { a }', variables: {}, path: ['a'], conn: false, _rows: 50, sample: {}, proven: true };
  s2.apiCapTs = Date.now();
  s2.heatRecordCapture(JSON.stringify(boardRequest()), null);
  A.eq('a request-only rival cannot displace a proven capture', s2.apiList.query, 'query Board { a }');

  // A response that DOES arrive upgrades the same-query capture to proven.
  var s3 = build({});
  s3.heatRecordCapture(JSON.stringify(boardRequest()), null);
  s3.heatRecordCapture(JSON.stringify(boardRequest()), {
    listWorkOrdersPaginated: { rowCount: 213, items: [makeRow(0), makeRow(1)] }
  });
  A.eq('a readable response marks the capture proven', s3.apiList.proven, true);
  A.eq('and records the row path', s3.apiList.path, ['listWorkOrdersPaginated', 'items']);
})();

console.log('\n-- row mapping: __typename must not outrank the real field --');
(function () {
  var s = build({});
  var e = s.heatApiRowToEntry(makeRow(0)).entry;
  A.eq('priority is the label, not the type name', e.prio, 'Yellow - Medium Priority');
  A.eq('DNE is the amount, not the type name', e.dne, '$89871.10');
  A.eq('status', e.status, 'Awaiting Client Approval');
  A.eq('hours in status', e.hrs, '1293.5');
  A.eq('age in days', e.days, '201');
  A.eq('scheduled date is the next onsite date', e.sched, '8/10/2026');
  A.eq('expected completion (nested under priority)', e.exp, '8/20/2026');
  A.eq('last note date', e.lastNote, '7/22/2026');
  A.eq('WO number', e.wo, '327000');
  A.eq('tracking digits only', e.tracking, '1052000');

  // Field precedence must not depend on the row's key order.
  var e2 = s.heatApiRowToEntry(makeRowPriorityFirst(0)).entry;
  A.eq('sched still prefers next-onsite when priority is emitted first', e2.sched, '8/10/2026');
  A.eq('and the rest of the row is unchanged by the reorder', [e2.prio, e2.exp, e2.status], [e.prio, e.exp, e.status]);
})();

// ============================================================================
// The end-to-end replay. Async: apiScanAll returns a promise chain.
// ============================================================================
function runScan(opts) {
  var s = build(opts || {});
  s.heatRecordCapture(JSON.stringify(boardRequest()), null);
  var btn = fakeBtn();
  return s.apiScanAll(btn).then(function (ok) { return { s: s, ok: ok, btn: btn }; });
}

function main() {
  console.log('\n-- full-board replay against the live paging contract --');
  var tx = makeTransport({ total: 213 });
  return runScan({ transport: tx }).then(function (r) {
    A.eq('scan resolved clean', r.ok, true);
    A.eq('every row absorbed', storeSize(r.s), 213);
    A.eq('two pages, not one', tx.calls.length, 2);
    A.ok('page arg stayed an OBJECT on every call',
      tx.calls.every(function (v) { return v.page && typeof v.page === 'object' && !Array.isArray(v.page); }),
      JSON.stringify(tx.calls.map(function (v) { return v.page; })));
    A.eq('page size raised to 200', tx.calls[0].page.take, 200);
    A.eq('first page starts at 0', tx.calls[0].page.skip, 0);
    A.eq('second page advances by the page size', tx.calls[1].page.skip, 200);
    A.eq('the captured filters rode along untouched', tx.calls[1].search, null);
    A.eq('sortBy preserved', tx.calls[1].sortBy, [{ field: 'number', direction: 'DESC' }]);
    A.eq('rowCount adopted as the coverage total', r.s.heatApiTotal, 213);
    A.eq('umbravaTotal falls back to it when the badge is unreadable', r.s.umbravaTotal(), 213);
    A.eq('a clean finish writes the day snapshot', r.s.__snapshots, 1);
    A.eq('the capture is proven after a successful replay', r.s.apiList.proven, true);
    A.eq('and its row path is remembered', r.s.apiList.path, ['listWorkOrdersPaginated', 'items']);
    A.eq('scanning flag cleared', r.s.heatScanning, false);
    A.eq('replay flag cleared, so capture keeps working', r.s.heatReplaying, false);
    A.eq('clean flag set (gates the trend + snapshot)', r.s.heatScanClean, true);
    A.eq('button offers a rescan', r.btn.textContent, 'Rescan All');
    A.ok('every row was judged with the real priority label',
      r.s.__verdictFacts.length === 213 && r.s.__verdictFacts.every(function (f) { return f.prio === 'Yellow - Medium Priority'; }),
      'first: ' + JSON.stringify(r.s.__verdictFacts[0] && r.s.__verdictFacts[0].prio));

    console.log('\n-- a server that caps the page size still converges --');
    var tx2 = makeTransport({ total: 213, serverMax: 50 });
    return runScan({ transport: tx2 }).then(function (r2) {
      A.eq('clean', r2.ok, true);
      A.eq('all rows, no holes between pages', storeSize(r2.s), 213);
      A.ok('walked in server-sized pages', tx2.calls.length >= 5, 'calls ' + tx2.calls.length);
      A.eq('the offset advanced by the rows returned, not by the size asked for',
        tx2.calls.slice(0, 4).map(function (v) { return v.page.skip; }), [0, 50, 100, 150]);
    });
  }).then(function () {
    console.log('\n-- honesty gates --');
    var tx3 = makeTransport({ total: 213, capAt: 100 });   // query can only see 100 of 213
    return runScan({ transport: tx3 }).then(function (r3) {
      A.eq('short coverage is NOT called clean', r3.ok, false);
      A.eq('a dirty finish drops the store entirely', r3.s.heatStore, null);
      A.eq('so no snapshot is written', r3.s.__snapshots, 0);
      A.eq('and heatScanClean stays false', r3.s.heatScanClean, false);
      A.ok('the note says how short it fell', /100 of 213/.test(String(r3.s.heatScanNote)), String(r3.s.heatScanNote));
      A.eq('replay flag cleared even on a dirty finish', r3.s.heatReplaying, false);
    });
  }).then(function () {
    var txEmpty = makeTransport({ total: 0 });
    return runScan({ transport: txEmpty }).then(function (r4) {
      A.eq('an empty first page is not a clean full board', r4.ok, false);
      A.eq('store dropped', r4.s.heatStore, null);
    });
  }).then(function () {
    console.log('\n-- route change mid-scan --');
    var tx5 = makeTransport({ total: 213 });
    var s = build({ transport: tx5 });
    s.heatRecordCapture(JSON.stringify(boardRequest()), null);
    var btn = fakeBtn();
    var p = s.apiScanAll(btn);
    s.heatScanAbort = true;      // what the MutationObserver does on a path change
    s.heatStore = null;
    return p.then(function (ok) {
      A.eq('an aborted scan resolves false', ok, false);
      A.eq('it does not throw into a nulled store', s.heatStore, null);
      A.eq('replay flag cleared, so capture survives the navigation', s.heatReplaying, false);
      A.eq('scanning flag cleared', s.heatScanning, false);
      A.ok('the reason is recorded', /navigated away/.test(String(s.heatScanNote)), String(s.heatScanNote));
    });
  }).then(function () {
    // ========================================================================
    // MUTATION CONTROLS - each reverts one piece of v3.18 and must go red.
    // ========================================================================
    console.log('\n-- mutation controls (each must FAIL the assertion above) --');

    // M1: the v3.17 coercion of the paging arg to a number.
    var m1 = [[
      'if (pg.skip) pgHost[pg.skip] = 0;',
      'if (pg.nested) { vars[pg.host] = 1; } else if (pg.skip) pgHost[pg.skip] = 0;'
    ]];
    var tx = makeTransport({ total: 213 });
    return runScan({ transport: tx, mutations: m1 }).then(function () {
      A.ok('M1 control: writing a number over PageInput must not reach here', false, 'it resolved instead of rejecting');
    }, function (err) {
      A.ok('M1 control: number-for-PageInput is rejected by the server', /Expected type "PageInput"/.test(String(err && err.message)), String(err && err.message));
    });
  }).then(function () {
    // M2: keep __typename in the flattened row (pre-v3.18 behaviour) - BOTH levels, since
    // it is the nested guard that keeps `priority.__typename` out of the priority slot.
    var m2 = [
      ['        if (k === \'__typename\') return;\n', ''],
      ['if (k2 !== \'__typename\' && (val[k2] == null || typeof val[k2] !== \'object\')) flat[k + \'.\' + k2] = val[k2];',
        'if (val[k2] == null || typeof val[k2] !== \'object\') flat[k + \'.\' + k2] = val[k2];']
    ];
    var s = build({ mutations: m2 });
    var e = s.heatApiRowToEntry(makeRow(0)).entry;
    A.ok('M2 control: with __typename kept, priority reads as the type name',
      e.prio === 'Priority', 'got ' + JSON.stringify(e.prio));
    A.ok('M2 control: and the fixed code does NOT read that', e.prio !== 'Yellow - Medium Priority');
  }).then(function () {
    // M3: response-only capture (pre-v3.18): a request with no body data must not latch.
    var m3 = [['        if (!respProves && !heatQueryIsWOList(body)) return;', '        if (!respProves) return;']];
    var s = build({ mutations: m3 });
    s.heatRecordCapture(JSON.stringify(boardRequest()), null);
    A.eq('M3 control: response-only capture leaves apiList null', s.apiList, null);
  }).then(function () {
    // M4: a dirty finish that KEEPS the empty store - the banner would claim "full board".
    var m4 = [['        if (!clean) heatStore = null;', '        if (!clean) { /* kept */ }']];
    var tx = makeTransport({ total: 213, capAt: 100 });
    return runScan({ transport: tx, mutations: m4 }).then(function (r) {
      A.ok('M4 control: without the drop, a failed scan leaves a truthy store',
        !!r.s.heatStore, 'store was ' + JSON.stringify(r.s.heatStore));
      A.ok('M4 control: which is exactly what makes the strip say "full board" off a failed scan',
        storeSize(r.s) !== null && storeSize(r.s) < 213, 'size ' + storeSize(r.s));
    });
  }).then(function () {
    // M5: no abort guard - the in-flight scan writes into a nulled store.
    var m5 = [['      function aborted() { return heatScanAbort || !heatStore; }', '      function aborted() { return false; }']];
    var tx = makeTransport({ total: 213 });
    var s = build({ transport: tx, mutations: m5 });
    s.heatRecordCapture(JSON.stringify(boardRequest()), null);
    var p = s.apiScanAll(fakeBtn());
    s.heatScanAbort = true;
    s.heatStore = null;
    return p.then(function (ok) {
      A.ok('M5 control: without the guard the abort is ignored or throws, never a clean false',
        ok !== false, 'resolved ' + JSON.stringify(ok));
    }, function (err) {
      A.ok('M5 control: without the guard the nulled store throws', /null|undefined/i.test(String(err && err.message)), String(err && err.message));
    });
  }).then(function () {
    A.finish();
  }, function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
