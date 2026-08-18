// test-heat-api-scan.js - node harness for WO List Heat v3.18: the API scan that never ran.
//
// WHAT WAS BROKEN, measured against the live board on 2026-08-04 (not inferred):
//   1. THE PAGING ARG WAS THE WRONG TYPE - the live root cause. Umbrava's board op is
//      PagedWorkOrders with `page: PageInput!` - an OBJECT, {skip, take}. The replay's key
//      sniffing matched the name "page" and wrote the NUMBER 1 over it, and the server
//      rejects the whole call. The live console said it outright:
//      '[BWN HEAT] API scan errored - falling back to scroll scan: Variable "$page" got
//      invalid value 1; Expected type "PageInput" to be an object.'
//      So every arrival at the list fell through to the slow scroll sweep, and the manual
//      button did the same - which is what "still requires a full scan" looked like.
//   2. A FAILED SCAN THEN LIED. The auto path left heatStore as {} - empty but TRUTHY -
//      and the DOM tinting pass fills heatStore when it exists, so the viewport's ~23 rows
//      became the "full board". Live proof: the strip read "of 23 open - full board" on a
//      213-row board, off a scan that had errored seconds earlier.
//   3. CAPTURE RESTED ON A RACE. v3.15-3.17 only latched when the RESPONSE body could be
//      read, via res.clone().json(). Measured: with one more clone reader on the same
//      responses, every clone read of every operation rejected with AbortError and apiList
//      stayed null for the whole session; alone, the same read usually wins. A latch that
//      works only when nothing else is listening is not a latch, so v3.18 latches off the
//      request body and treats a readable response as a bonus.
//   4. __typename OUTRANKED THE REAL FIELD. heatApiRowToEntry takes the first key its
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
  '    function heatGql(query, variables) {',
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
  '    // Attach to the hook (v3.21).',
  'heatRecordCapture');
// v3.21: the hook moved to document-start, so the buffer/sink that carries requests
// from before List Heat exists is file-level code, outside every module.
var SRC_GQLBUF = slice(core,
  '  var BWN_GQL_SINK = null;',
  '  (function installGqlHook() {',
  'bwnGqlSeen + bwnGqlSetSink');
var SRC_BOOTQ = slice(core,
  '  var BWN_BOOTED = false;',
  '  // ===== BEGIN bwnNotesApi =====',
  'bwnBoot + bwnBootAll');
var SRC_BACKOFF = slice(core,
  '    // Failure backoff for the auto scan (2026-08-09).',
  '    function heatAutoScan(vars, force) {',
  'heatAutoBackoff');
var SRC_SCAN = slice(core,
  '    function apiScanAll(btn) {',
  '    // ---- Scan All (scroll fallback) ---',
  'apiScanAll');
var SRC_TOTAL = slice(core,
  '    function umbravaTotal() {',
  '    // ---- Acknowledge / snooze (v3.8) ---',
  'umbravaTotal');
// v3.20: the two heatStore writers and the one function that decides their shared key.
var SRC_KEY = slice(core,
  "    // heatStore's KEY, and the ONE place that decides its shape (v3.20).",
  '    function clearEl(el) {',
  'heatKey');
var SRC_DOMPUT = slice(core,
  "    // The DOM tinting pass's write into heatStore.",
  '    var heatScanning = false;',
  'heatStoreDomPut');
// v3.19 blocks.
var SRC_MARSHAL = slice(core,
  '    // One place that turns a STORED row',
  '    // ---- Assignee names from GUIDs ---',
  'heatVerdictFor');
var SRC_USERS = slice(core,
  '    // ---- Assignee names from GUIDs ---',
  '    // ---- Next step per row',
  'heatResolveAssignees + the user(id:) batch');
var SRC_NEXTSTEP = slice(core,
  '    // ---- Next step per row',
  '    // ---- Heat pass ---',
  'heatNextStep');
// File-level: the shared status-clock engine and the real verdict engine. These are built
// SEPARATELY (buildVerdict) - the scan build stubs computeVerdict on purpose so its
// assertions can read which FACTS reached the engine.
var SRC_THRESH = slice(core,
  '  var BWN_HEAT_CFG = {',
  '  // ---- Next-actions engine, published across module closures',
  'BWN_HEAT_CFG + bwnSlaMult + bwnThresholdsFor');
// v3.22: the one "is this row finished?" test. Sliced as its own block rather than folded
// into SRC_VERDICT so the slice below still starts at computeVerdict.
// computeVerdict CALLS heatDone, so a build without this block throws.
var SRC_DONE = slice(core,
  '    // ---- Is this row finished? ONE place (v3.22) ---',
  '    // ---- Threshold model ---',
  'heatDone');
// v3.23: the module-local thresholdsFor alias, SLICED rather than stubbed. VERDICT_PRELUDE
// used to declare its own `function thresholdsFor(status, prioText, C, sla)` that forwarded
// all four args, while the shipped alias declared three and dropped the 4th on the floor.
// So every assertion below ran against a signature the browser never had: bwnSlaMult never
// ran in List Heat, `slaScaled` was false on every row, the v3.19 client-SLA clock was dead
// on the board - and 287 assertions passed. A stub cannot answer "does the SHIPPED alias
// forward its arguments", so it does not get to be a stub any more.
var SRC_ALIAS = slice(core,
  '    // ---- Threshold model ---',
  '    // ---- Per-row verdict',
  'thresholdsFor alias');
var SRC_VERDICT = slice(core,
  '    function computeVerdict(f, C) {',
  '    // One place that turns a STORED row',
  'computeVerdict');
// The REAL next-actions engine and its taxonomy. Sliced rather than stubbed because the
// question this answers cannot be answered by a stub: does the MATURE engine, written for a
// full WO page, tolerate the much thinner state a board row can supply - and does it produce
// a sensible step rather than throwing or inventing one? heatNextStep has a try/catch, so a
// throw degrades safely, but "safely degraded on every row" is a dead feature shipped green.
var SRC_ENGINE_DEPS = slice(core,
  '    var ACT_SIGNALS = {',
  '    // Newest note carrying an authored plan.',
  'ACT_SIGNALS / ESCALATE_DAYS / WO_PHASE / woActionForStatus / scoreAct / authoredKeyHash');
var SRC_ENGINE = slice(core,
  '    function computeNextActions(state, C) {',
  '    bwnActsEngine = computeNextActions;',
  'computeNextActions');

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
  'var heatAutoSig = null, heatAutoTs = 0;',
  'var heatReplaying = false, heatScanning = false, heatScanClean = false;',
  'var heatScanNote = null, heatScanAbort = false, heatStore = null;',
  'var PANEL_ID = "bwn-heat-panel";',
  'var __autoScans = [], __renders = 0, __snapshots = 0, __verdictFacts = [];',
  'var location = { pathname: "/work-orders", href: "https://app.umbrava.com/work-orders" };',
  // No DOM badge to read: the live list header logged "list badge total: not found", which
  // is precisely the case where the API total has to carry the coverage gate.
  'var __events = [];',
  'function CustomEvent(t, o) { this.type = t; this.detail = o && o.detail; }',
  'var document = { getElementById: function () { return null; }, querySelectorAll: function () { return []; }, dispatchEvent: function (e) { __events.push(e && e.detail && e.detail.id); return true; } };',
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
  'function dUntil(ts) { return Math.ceil((ts - __today) / 86400000); }',
  // v3.19 stubs. authToken now lives at file level (the BWN-SHARED block, US-1 1b), outside
  // these slices, so it is stubbed; __tokenOn lets a test drive the no-token branch
  // (resolution must degrade, never leak an id to the panel).
  'var __tokenOn = true;',
  'function authToken() { return __tokenOn ? "tok" : ""; }',
  'var __ss = {};',
  'var sessionStorage = { getItem: function (k) { return (k in __ss) ? __ss[k] : null; }, setItem: function (k, v) { __ss[k] = String(v); } };',
  // The next-actions engine is published from the WO Assist closure at runtime. Here it is a
  // RECORDER: the contract worth testing is which state List Heat hands it (a fabricated
  // `pos: []` would read as "checked, found no POs" and invent steps), plus that the
  // standing completion anchor is never reported as the next thing to do.
  'var __actStates = [], __actsOut = null, __actsThrow = false;',
  'var bwnActsEngine = function (state, C) { __actStates.push(state); if (__actsThrow) throw new Error("thin state"); return __actsOut; };',
  'var BWN = {',
  '  parseUSDate: function (s) { var m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(String(s == null ? "" : s)); if (!m) return null; var d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])); d.setHours(0, 0, 0, 0); return d.getTime(); },',
  // The REAL formatter, not an approximation: it is what decides whether a minor-unit bug is
  // visible. `toFixed(2)` would have hidden the thousands separators the panel actually shows.
  '  money: function (n) { return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },',
  '  parseMoney: function (s) { var m = (s || "").match(/\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)/); return m ? parseFloat(m[1].replace(/,/g, "")) : null; },',
  '  parseBare: function (s) { var n = parseFloat(String(s || "").replace(/[$,\\s]/g, "")); return isNaN(n) ? null : n; }',
  '};',
  'var parseUSDate = BWN.parseUSDate;'
].join('\n');

// ---- Fixtures modeled on the live rows (shape measured 2026-08-04) -------------------
// KEY ORDER MATTERS and is copied from the live response: the row arrives roughly
// alphabetical, so nextOnsiteDate lands BEFORE the nested priority object. g() returns the
// first matching key, so this ordering is part of the fixture, not decoration - see the
// reversed-order row below, which is the same data a reorder would hand us.
// Timestamps use midday UTC so the date strings are the same in CI (UTC) and here (EDT).
// v3.19: this fixture was REWRITTEN from a live read (search_work_orders / get_work_order
// against the tenant, 2026-08-04) because the v3.18 version was written from assumption and
// therefore agreed with three separate bugs instead of catching them:
//   - `assignedTo: 'Coordinator One'` - the live field is an ID scalar GUID, and the row
//     carries the NAME separately as `assignedToMemberName`. With a name in the id's slot the
//     harness could not see that g() was returning the id.
//   - `timeInStatus: 1293.5` read as hours - the live value is MINUTES (81001 on a WO 137
//     days old, i.e. 3288 hours of total age, so it cannot be hours at all).
//   - `doNotExceed.amount: 89871.1` - a FRACTIONAL minor-unit amount, which the server cannot
//     emit. Real: { amount: 1448564, precision: 2 } = $14,485.64, and BWN.money does not scale.
// KEY ORDER MATTERS and is copied from the live response: roughly alphabetical, so
// `assignedTo` arrives BEFORE `assignedToMemberName` and `nextOnsiteDate` before the nested
// `priority` object. g() returns the first matching key, so this ordering is the bug's cause
// and part of the fixture, not decoration - see the reversed-order row below.
// Timestamps use midday UTC so the date strings are the same in CI (UTC) and here (EDT).
function makeRow(i) {
  return {
    __typename: 'WorkOrderListItem',
    assignedTo: 'ad017f63-30f6-4074-b073-cec166f9aa7b',
    assignedToMemberName: 'Daniel Russell',
    clientName: 'Pilot Travel Centers',
    doNotExceed: { __typename: 'Money', amount: 1448564, currency: 'USD', precision: 2 },
    lastModifiedDate: '2026-08-03T12:00:00Z',
    lastNoteDate: '2026-07-22T12:00:00Z',
    locationName: 'Pilot Travel Center #0017',
    nextOnsiteDate: '2026-08-10T12:00:00Z',
    number: 327000 + i,
    numberOfDays: 201,
    phase: 'Open',
    priority: {
      __typename: 'Priority',
      label: 'Yellow - Medium Priority',
      category: 'High',
      responseMinutes: 4320,
      serviceLevelAgreementMinutes: 201600,
      expectedCompletionDate: '2026-08-20T12:00:00Z',
      firstTripDate: '2026-07-01T12:00:00Z'
    },
    remainingDays: -88,
    statusName: 'Awaiting Client Approval',
    systemStatusName: 'Open',
    timeInStatus: 81001,
    totalNTE: { __typename: 'Money', amount: 1058866, currency: 'USD', precision: 2 },
    trackingNumber: '105' + (2000 + i),
    vendorNames: ['FACE N SON\'S LLC', 'LSI INDUSTRIES INC'],
    workOrderDate: '2026-01-15T12:00:00Z'
  };
}
// Same row, minus every name-shaped assignee key: what the board returns when the Assigned To
// column is NOT in the column chooser. All that is left is the id, and an id must never
// display - this is the row the user(id:) resolver exists for.
function makeRowIdOnly(i) {
  var r = makeRow(i);
  delete r.assignedToMemberName;
  return r;
}
function omitKeys(row, ks) {
  var out = {};
  Object.keys(row).forEach(function (k) { if (ks.indexOf(k) === -1) out[k] = row[k]; });
  return out;
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
// Transport for the user(id:) lookups: records every document it is handed and answers from
// a small roster. The two GUIDs are the ones the live board actually returned.
var USER_ROSTER = {
  'ad017f63-30f6-4074-b073-cec166f9aa7b': { firstName: 'Daniel', lastName: 'Russell', isInactive: false },
  '980fa5bd-e655-4917-aad7-6d9cd49752e2': { firstName: 'Carol', lastName: 'Serra', isInactive: true }
};
function guidN(i) {
  var h = ('0000000' + i).slice(-8);
  return h + '-aaaa-bbbb-cccc-dddddddddddd';
}
function makeUserTransport(opts) {
  var o = opts || {};
  var queries = [];
  function t(q, v) {
    queries.push({ q: q, v: v });
    var single = /^query\(\$id:ID!\)/.test(q);
    if (o.failBatch && !single) return Promise.reject(new Error('Variable "$i1" got invalid value'));
    var data = {};
    Object.keys(v || {}).forEach(function (k) {
      var alias = single ? 'user' : 'u' + k.slice(1);
      var rec = o.unknown ? null : (USER_ROSTER[v[k]] || { firstName: 'Member', lastName: String(v[k]).slice(0, 4), isInactive: false });
      data[alias] = rec;
    });
    return Promise.resolve(data);
  }
  t.queries = queries;
  return t;
}
// A stored row carrying an id but no name - what the board returns with the Assigned To
// column out of view. Built through the REAL mapper so the store shape cannot drift.
function idOnlyRow(s, i, guid) {
  var row = makeRowIdOnly(i);
  row.assignedTo = guid;
  return s.heatApiRowToEntry(row).entry;
}

function sandboxFor(o) {
  return {
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, RegExp: RegExp, Error: Error,
    Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean,
    isNaN: isNaN, isFinite: isFinite, parseFloat: parseFloat, parseInt: parseInt,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    __transport: o.transport || makeTransport({}),
    __today: new Date(2026, 7, 4).setHours(0, 0, 0, 0)
  };
}
function build(opts) {
  var o = opts || {};
  // computeVerdict stays STUBBED here (see PRELUDE): these tests assert which facts the scan
  // hands the engine. The real engine is exercised by buildVerdict() below.
  var src = [PRELUDE, SRC_KEY, SRC_PAGING, SRC_FIND, SRC_MAP, SRC_CAPTURE, SRC_BACKOFF, SRC_TOTAL, SRC_MARSHAL, SRC_USERS, SRC_NEXTSTEP, SRC_SCAN].join('\n\n');
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = sandboxFor(o);
  vm.runInNewContext(src, sandbox, { filename: 'heat-slice.js' });
  return sandbox;
}
// The REAL threshold + verdict engines, with no computeVerdict stub in scope.
var VERDICT_PRELUDE = [
  'var __log = [];',
  'var console = { info: function () { }, warn: function () { } };',
  'function dSince(ts) { return Math.floor((__today - ts) / 86400000); }',
  'function dUntil(ts) { return Math.ceil((ts - __today) / 86400000); }',
  'function cleanName(s) { return String(s == null ? "" : s).trim(); }',
  'function ackGet() { return false; }',
  'function bwnConfig() { return __cfg; }',
  // NO thresholdsFor stub here - SRC_ALIAS supplies the real one. See its slice above.
  'var BWN = {',
  '  cfg: function () { return __cfg; },',
  '  parseUSDate: function (s) { var m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec(String(s == null ? "" : s)); if (!m) return null; var d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])); d.setHours(0, 0, 0, 0); return d.getTime(); },',
  '  money: function (n) { return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },',
  '  parseMoney: function (s) { var m = (s || "").match(/\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)/); return m ? parseFloat(m[1].replace(/,/g, "")) : null; },',
  '  parseBare: function (s) { var n = parseFloat(String(s || "").replace(/[$,\\s]/g, "")); return isNaN(n) ? null : n; },',
  '  parseNoteDateLoose: function () { return null; }',
  '};'
].join('\n');
// Everything the real engine leans on that is NOT the engine: DOM reads, money formatting,
// note-date parsing, the escalation tier. Stubbed as leaves - none of them decides WHETHER a
// step fires, they only decorate one that already did.
var ENGINE_PRELUDE = [
  'function nvVendor(s) { return (s || "").replace(/\\s+/g, " ").trim().toUpperCase(); }',
  'function readDocs() { return null; }',                 // DOM read; a list row has none
  'function statPrefix(a) { return String(a.key || "").split(":")[0]; }',
  'function fmt(n) { return "$" + Number(n || 0).toFixed(2); }',
  'function bwnEscalationTier(sev, prioNum, rank) { return { tier: "mgmt", label: "management" }; }',
  'function nudgedPrefixes() { return {}; }',
  'function stagePlanPush() { }'
].join('\n');
function buildEngine(opts) {
  var o = opts || {};
  var src = [VERDICT_PRELUDE, ENGINE_PRELUDE, SRC_KEY, SRC_MAP, SRC_THRESH, SRC_ENGINE_DEPS, SRC_ENGINE, SRC_DONE, SRC_ALIAS, SRC_VERDICT, SRC_MARSHAL, SRC_NEXTSTEP].join('\n\n')
    // heatNextStep calls the PUBLISHED reference; in the file that assignment is the slice's
    // end marker, so wire it here exactly as the module does at load time.
    + '\nvar bwnActsEngine = computeNextActions;\n';
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = sandboxFor(o);
  sandbox.__cfg = o.cfg || { hrsWarn: 60, hrsBad: 120, activeMult: 0.5, dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7, gpBad: 15, gpWarn: 25, targetGP: 35 };
  sandbox.BWN_PARSE_NOTE = null;
  vm.runInNewContext(src, sandbox, { filename: 'engine-slice.js' });
  return sandbox;
}
function buildVerdict(opts) {
  var o = opts || {};
  var src = [VERDICT_PRELUDE, SRC_THRESH, SRC_DONE, SRC_ALIAS, SRC_VERDICT, SRC_MARSHAL].join('\n\n');
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = sandboxFor(o);
  // The live defaults, so the numbers in these assertions are the numbers on the board.
  sandbox.__cfg = o.cfg || { hrsWarn: 60, hrsBad: 120, activeMult: 0.5, dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7 };
  vm.runInNewContext(src, sandbox, { filename: 'verdict-slice.js' });
  return sandbox;
}

// heatKey + heatStoreDomPut alone, with heatStore as a plain context global so a test can
// seed it the way a finished API scan leaves it. Nothing about the store is stubbed - the
// store IS a plain object in the module too.
function buildStore(opts) {
  var o = opts || {};
  var src = ['var heatStore = null;', SRC_KEY, SRC_DOMPUT].join('\n\n');
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = {};
  vm.runInNewContext(src, sandbox, { filename: 'store-slice.js' });
  return sandbox;
}
// The document-start buffer/sink, standalone - it has no dependencies by design.
function buildGqlBuf(opts) {
  var o = opts || {};
  var src = SRC_GQLBUF;
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = {};
  vm.runInNewContext(src, sandbox, { filename: 'gqlbuf-slice.js' });
  return sandbox;
}
// The module boot queue, with safeModule instrumented so a test can see that modules
// still go through the error-containing wrapper rather than being called raw.
function buildBootQ(opts) {
  var o = opts || {};
  var src = SRC_BOOTQ;
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = { __ran: [], __wrapped: 0 };
  sandbox.BWN = {
    safeModule: function (id, fn) {
      sandbox.__wrapped++;
      try { fn(); } catch (e) { sandbox.__ran.push('THREW:' + id); }
    }
  };
  vm.runInNewContext(src, sandbox, { filename: 'bootq-slice.js' });
  return sandbox;
}

// What the API scan leaves behind for one WO: the rich record, tagged src:'api'.
function apiRec(num) {
  return {
    id: String(num), kinds: [], acked: false, sev: 2, reasons: ['past status limit'],
    wo: String(num), tracking: '1052746', status: 'Pending Schedule', prio: 'Yellow - Medium Priority',
    client: 'Pilot Travel Centers', assignee: 'Matthew Zozimo', hrs: '1299.7', days: '202',
    assigneeId: 'ae7bb143-d386-4a0c-8be6-5a182c0b988f', nte: '$9,752.73', dneAmt: 0, nteAmt: 9752.73,
    phase: 'Open', vendors: 'HERC RENTALS INC', vendorsKnown: true, remDays: -3,
    sla: { responseMinutes: 51840 }, slaScaled: true, src: 'api'
  };
}
// What the DOM tinting pass builds for the same row: everything a <tr> can give, and
// nothing it cannot. No src tag - that is how the store tells the two apart.
function domRec(num) {
  return {
    id: String(num), kinds: [], acked: true, sev: 2, reasons: ['past status limit'],
    wo: 'W-' + num, tracking: '1052746', status: 'Pending Schedule', prio: 'Yellow - Medium Priority',
    client: 'Pilot Travel Centers', assignee: 'Matthew Zozimo', hrs: '1299.65', days: '202',
    dne: '$89,871.10', sched: '', lastNote: '08/04/2026', exp: '05/31/2026'
  };
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

console.log('\n-- capture latches with NO readable response (the clone-read race) --');
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
  A.eq('status', e.status, 'Awaiting Client Approval');
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

console.log('\n-- v3.19 FAULT 1: an id must never be read as a name --');
(function () {
  var s = build({});
  var e = s.heatApiRowToEntry(makeRow(0)).entry;
  A.eq('the assignee is the member NAME, even though the id key sorts first', e.assignee, 'Daniel Russell');
  A.eq('and the id is kept separately for the lookup', e.assigneeId, 'ad017f63-30f6-4074-b073-cec166f9aa7b');
  A.ok('no GUID reaches the assignee slot', !s.heatIsGuid(e.assignee), e.assignee);

  // The column-not-in-view case: only the id is on the row.
  var eIdOnly = s.heatApiRowToEntry(makeRowIdOnly(0)).entry;
  A.eq('with no name field the assignee is BLANK, not the id', eIdOnly.assignee, '');
  A.eq('and the id is carried so it can be resolved', eIdOnly.assigneeId, 'ad017f63-30f6-4074-b073-cec166f9aa7b');

  // A nested member object: two keys, neither of which is the whole name.
  var nested = omitKeys(makeRow(0), ['assignedTo', 'assignedToMemberName']);
  nested.assignedTo = { __typename: 'User', id: 'ad017f63-30f6-4074-b073-cec166f9aa7b', firstName: 'Daniel', lastName: 'Russell' };
  A.eq('first + last are joined, not truncated to the first', s.heatApiRowToEntry(nested).entry.assignee, 'Daniel Russell');

  // Shape test, not a key blocklist: an id under a name nobody predicted still cannot display.
  var odd = omitKeys(makeRow(0), ['assignedTo', 'assignedToMemberName']);
  odd.assigneeName = '498aa8d3-d697-4493-83f1-abaa366bd575';
  A.eq('an id-shaped value under a NAME-shaped key is still refused', s.heatApiRowToEntry(odd).entry.assignee, '');

  A.eq('a GUID is recognised', s.heatIsGuid('980fa5bd-e655-4917-aad7-6d9cd49752e2'), true);
  A.eq('a name is not', s.heatIsGuid('Daniel Russell'), false);
  A.eq('and neither is a WO number', s.heatIsGuid('344409'), false);
})();

console.log('\n-- v3.19 FAULT 2: timeInStatus is MINUTES, the model is HOURS --');
(function () {
  var s = build({});
  // 81001 minutes = 1350.02h = 56d. As hours it would be 9.2 years, on a 201-day-old WO.
  A.eq('minutes are converted to hours', s.heatApiRowToEntry(makeRow(0)).entry.hrs, '1350');

  // A key that SAYS hours is trusted as hours - no double conversion, no heuristic.
  var hoursRow = omitKeys(makeRow(0), ['timeInStatus']);
  hoursRow.hoursInStatus = 1350;
  A.eq('an hours-named key is read as hours', s.heatApiRowToEntry(hoursRow).entry.hrs, '1350');

  // Both present: the explicit hours key wins, whatever the key order.
  var both = omitKeys(makeRow(0), ['timeInStatus']);
  both.hoursInStatus = 1350;
  both.timeInStatus = 81001;
  A.eq('hours beats minutes when the row carries both', s.heatApiRowToEntry(both).entry.hrs, '1350');

  var none = omitKeys(makeRow(0), ['timeInStatus']);
  A.eq('no clock at all stays blank, never zero', s.heatApiRowToEntry(none).entry.hrs, '');
  A.eq('sub-hour values keep one decimal', s.heatApiRowToEntry((function () { var r = omitKeys(makeRow(0), ['timeInStatus']); r.timeInStatus = 45; return r; })()).entry.hrs, '0.8');
})();

console.log('\n-- v3.19 FAULT 3: money is in MINOR UNITS with its own precision --');
(function () {
  var s = build({});
  var e = s.heatApiRowToEntry(makeRow(0)).entry;
  A.eq('DNE is scaled by precision, not printed raw', e.dne, '$14,485.64');
  A.eq('vendor NTE too', e.nte, '$10,588.66');
  A.eq('and the numbers are kept for comparison', [e.dneAmt, e.nteAmt], [14485.64, 10588.66]);

  // No precision key -> the value is already in major units and must not be scaled.
  var plain = omitKeys(makeRow(0), ['doNotExceed']);
  plain.doNotExceed = 500;
  A.eq('a bare number with no precision is left alone', s.heatApiRowToEntry(plain).entry.dne, '$500.00');

  // Already formatted upstream (a DOM-ish shape) -> passed through, not re-scaled.
  var fmt = omitKeys(makeRow(0), ['doNotExceed']);
  fmt.doNotExceed = '$1,448.56';
  A.eq('a pre-formatted string is not double-converted', s.heatApiRowToEntry(fmt).entry.dne, '$1,448.56');

  var noneM = omitKeys(makeRow(0), ['doNotExceed', 'totalNTE']);
  A.eq('absent money stays blank, never $0.00', [s.heatApiRowToEntry(noneM).entry.dne, s.heatApiRowToEntry(noneM).entry.nte], ['', '']);
})();

console.log('\n-- v3.19: fields the board returned and the audit ignored --');
(function () {
  var s = build({});
  var e = s.heatApiRowToEntry(makeRow(0)).entry;
  A.eq('phase is read', e.phase, 'Open');
  A.eq('the server’s own signed overdue clock is read', e.remDays, -88);
  A.eq('SLA facts come off the row, not out of the label text',
    [e.sla.responseMinutes, e.sla.slaMinutes, e.sla.category], [4320, 201600, 'High']);

  // A list of plain strings used to be dropped by heatFlatten entirely.
  A.eq('a string array is joined', e.vendors, 'FACE N SON\'S LLC, LSI INDUSTRIES INC');
  A.eq('and marked as read', e.vendorsKnown, true);

  // The distinction the no-vendor signal rests on: read-and-empty vs never-read.
  var empty = omitKeys(makeRow(0), ['vendorNames']);
  empty.vendorNames = [];
  var eE = s.heatApiRowToEntry(empty).entry;
  A.eq('an EMPTY vendor list is a fact: known, blank', [eE.vendorsKnown, eE.vendors], [true, '']);
  var missing = omitKeys(makeRow(0), ['vendorNames']);
  A.eq('an ABSENT vendor field is not a fact', s.heatApiRowToEntry(missing).entry.vendorsKnown, false);
})();

console.log('\n-- dispatch geocode feed: address extraction (city/state/street/zip) --');
(function () {
  var s = build({});
  // The scan SELECTS address{addressLine1 addressLine2 city state postalCode}; each must be lifted
  // onto the record or the In-House Dispatch geocode feed silently ships blanks (the alias-orphan
  // trap: a getField read with no matching key returns '' forever). `state` is anchored to
  // address.state - the decoy top-level `state: 0` is the INTEGER WO-state and must NOT win.
  var row = omitKeys(makeRow(0), []);
  row.state = 0;
  row.address = { __typename: 'Address', addressLine1: '123 Main St', addressLine2: 'Ste 4',
    city: 'Baldwin', state: 'NY', postalCode: '11510' };
  var e = s.heatApiRowToEntry(row).entry;
  A.eq('addressLine1 -> street1', e.street1, '123 Main St');
  A.eq('addressLine2 -> street2', e.street2, 'Ste 4');
  A.eq('address.city -> city', e.city, 'Baldwin');
  A.eq('address.state -> state (postal code, not the integer WO-state)', e.state, 'NY');
  A.eq('postalCode -> zip', e.zip, '11510');
  // makeRow carries NO address block: every part must read blank, never a stray value.
  var bare = s.heatApiRowToEntry(makeRow(1)).entry;
  A.eq('no address -> all parts blank', [bare.street1, bare.street2, bare.city, bare.state, bare.zip], ['', '', '', '', '']);
})();

console.log('\n-- v3.19: the status clock scales off the client SLA, not a parsed label --');
(function () {
  var s = buildVerdict({});
  // Live labels, verbatim. Only the first of these carries a P-number, so before v3.19
  // every other client on the board fell through to a neutral 1.0x - priority scaling was
  // real only for Pilot.
  A.eq('a P-numbered label still scales when there are no SLA facts',
    s.bwnThresholdsFor('Awaiting Client Approval', 'P1 Emergency', null, null).bad, 30);
  A.eq('"SEV 4" carries no P-number and cannot scale on its own',
    s.bwnThresholdsFor('Awaiting Client Approval', 'SEV 4', null, null).bad, 120);
  A.eq('nor can "Emergency Life/Safety/Operations: Same Day Service"',
    s.bwnThresholdsFor('Awaiting Client Approval', 'Emergency Life/Safety/Operations: Same Day Service', null, null).bad, 120);

  // With the row's own response clock, the same unparseable labels scale correctly.
  A.eq('a same-day response promise (240 min) pulls the limit in',
    s.bwnThresholdsFor('Awaiting Client Approval', 'Emergency Life/Safety/Operations: Same Day Service', null, { responseMinutes: 240 }).bad, 30);
  A.eq('a 3-day promise (4320 min) pushes it out',
    s.bwnThresholdsFor('Awaiting Client Approval', 'P2 Next Day', null, { responseMinutes: 4320 }).bad, 240);
  A.eq('and the clamp stops a 30-day SLA from parking a WO permanently quiet',
    s.bwnThresholdsFor('Awaiting Client Approval', 'P4 Normal', null, { responseMinutes: 43200 }).bad, 240);
  A.eq('the category is the fallback when there is no response clock',
    s.bwnThresholdsFor('Awaiting Client Approval', 'Unknown', null, { category: 'Emergency' }).bad, 30);
  A.eq('"Standard" is neutral', s.bwnThresholdsFor('Awaiting Client Approval', 'Unknown', null, { category: 'Standard' }).bad, 120);
  A.eq('an unrecognised category falls back to the label parse, never harsher',
    s.bwnThresholdsFor('Awaiting Client Approval', 'Unknown', null, { category: 'Whatever' }).bad, 120);

  A.eq('the SLA basis is reported so the panel can say which clock judged the row',
    [s.bwnThresholdsFor('x', 'y', null, { responseMinutes: 240 }).sla, s.bwnThresholdsFor('x', 'y', null, null).sla], [true, false]);

  // Additive: three-arg callers (WO Assist's header read, the DOM scan) are untouched.
  A.eq('the 3-arg call is byte-for-byte the old behaviour',
    [s.bwnThresholdsFor('Scheduled', 'P2 Next Day', null).warn, s.bwnThresholdsFor('Scheduled', 'P2 Next Day', null).bad],
    [15, 30]);
})();

// ============================================================================
// v3.23: THE ALIAS THAT DROPPED THE ARGUMENT.
// Everything above measures bwnThresholdsFor DIRECTLY. Nothing measured the module-local
// `thresholdsFor` that List Heat's two call sites actually go through - it was a 3-parameter
// forwarder, so `f.sla` / `e.sla` were dropped, bwnSlaMult never ran, and the v3.19 clock
// was inert on the board. These assertions go through the REAL alias (SRC_ALIAS), and the
// numbers below are the pair measured in a vm against the shipped 1.66.29 bytes.
console.log('\n-- v3.23: the module alias forwards the row’s SLA facts --');
(function () {
  var s = buildVerdict({});
  var SLA = { responseMinutes: 480, category: 'high' };
  A.eq('the alias returns what the engine returns, argument for argument',
    s.thresholdsFor('Scheduled', 'P2 Next Day', s.__cfg, SLA),
    s.bwnThresholdsFor('Scheduled', 'P2 Next Day', s.__cfg, SLA));
  // The measured "after". The shipped 1.66.29 alias returned {warn:15,bad:30,sla:false} here.
  A.eq('and those are the SLA numbers, not the label-parsed ones',
    s.thresholdsFor('Scheduled', 'P2 Next Day', s.__cfg, SLA), { warn: 10, bad: 20, sla: true });
  A.eq('a 3-arg call through the alias is still the old behaviour, untouched',
    s.thresholdsFor('Scheduled', 'P2 Next Day', s.__cfg), { warn: 15, bad: 30, sla: false });

  // computeVerdict is the consumer that matters: `slaScaled` is exactly what the Audit
  // panel's "status limits: N of M scaled by the client SLA" line counts, and it was false
  // on every row of every scan.
  function V(over) {
    var f = {
      status: 'Scheduled', prio: 'P2 Next Day', phase: 'Open',
      ageDays: 10, hrs: NaN, expTs: null, schedTs: null, lastNoteTs: null, remDays: null, sla: null
    };
    Object.keys(over || {}).forEach(function (k) { f[k] = over[k]; });
    return s.computeVerdict(f, s.__cfg);
  }
  A.eq('an API row with a response clock reports which clock judged it',
    V({ sla: { responseMinutes: 480 } }).slaScaled, true);
  A.eq('the category alone is enough of a basis',
    V({ sla: { responseMinutes: null, slaMinutes: null, category: 'High' } }).slaScaled, true);
  A.eq('a row with no SLA facts says so, and falls back to the label',
    V({ sla: null }).slaScaled, false);
  // The live shape when the priority columns were not in the captured query: heatApiRowToEntry
  // always emits an sla OBJECT, so "truthy object" must not be mistaken for "has facts".
  A.eq('an sla object with nothing usable in it is not a basis',
    V({ sla: { responseMinutes: null, slaMinutes: 201600, category: '' } }).slaScaled, false);

  // And the numbers MOVE - which is why this was kept out of the v3.22 commit. Both
  // directions, on the live config (hrsWarn 60 / hrsBad 120 / activeMult 0.5).
  A.eq('25h in status: past its limit on a 480-minute promise, only watch on the label',
    [V({ hrs: 25, sla: { responseMinutes: 480 } }).sev, V({ hrs: 25, sla: null }).sev], [2, 1]);
  A.ok('and the reason quotes the SLA limit, so the row explains itself',
    /25h in "Scheduled" \(limit 20h\)/.test(V({ hrs: 25, sla: { responseMinutes: 480 } }).reasons.join('|')),
    V({ hrs: 25, sla: { responseMinutes: 480 } }).reasons.join('|'));
  // The direction that will actually move THIS board: the live Pilot rows carry a
  // 51840-minute (36-day) response clock, which clamps to 2.0x and LOOSENS them.
  A.eq('70h on a Pilot row: red on the label clock, amber on the client’s own',
    [V({ prio: 'Yellow - Medium Priority', hrs: 70, sla: null }).sev,
    V({ prio: 'Yellow - Medium Priority', hrs: 70, sla: { responseMinutes: 51840 } }).sev], [2, 1]);
  A.eq('so a red count can fall as well as rise - this change is not one-directional',
    [V({ prio: 'Yellow - Medium Priority', hrs: 70, sla: { responseMinutes: 51840 } }).limitBad,
    V({ prio: 'Yellow - Medium Priority', hrs: 70, sla: null }).limitBad], [false, true]);
})();

console.log('\n-- v3.23: the shipped alias and both call sites (source check) --');
(function () {
  A.ok('the alias declares the 4th parameter and forwards it',
    core.indexOf('function thresholdsFor(status, prioText, C, sla) { return bwnThresholdsFor(status, prioText, C, sla); }') !== -1);
  // 1 definition + 2 call sites. A 3-arg call would silently mean "this row has no SLA facts",
  // so the count is pinned rather than the strings alone: a NEW call site has to be considered.
  A.eq('the alias is defined once and called exactly twice', core.split('thresholdsFor(').length - 1, 3);
  A.ok('computeVerdict passes the row’s own facts',
    core.indexOf('var th = thresholdsFor(f.status, f.prio, C, f.sla);') !== -1);
  A.ok('and the offender ranking ranks on the same limit the row was judged by',
    core.indexOf('var th2 = thresholdsFor(e.status, e.prio, Cn, e.sla);') !== -1);
  // The other half: `sla` has to REACH computeVerdict from all four of its callers, or the
  // pills, the tint and the stored sev are three different clocks. heatVerdictFor already
  // carried it; the DOM tint and My Day did not until v3.23.
  A.ok('the marshal carries it', core.indexOf('remDays: e.remDays, sla: e.sla,') !== -1);
  A.ok('the DOM tint borrows it from the API record for the same row',
    core.indexOf('sla: apiRec ? apiRec.sla : undefined,') !== -1);
  A.ok('and the My Day tally counts against it',
    core.indexOf('status: o.status, prio: o.prio, phase: o.phase, sla: o.sla,') !== -1);
})();

console.log('\n-- v3.19: the new verdict signals --');
(function () {
  var s = buildVerdict({});
  function V(over) {
    var f = {
      status: 'Awaiting Client Approval', prio: 'Yellow - Medium Priority', phase: 'Open',
      ageDays: 201, hrs: NaN, expTs: null, schedTs: null, lastNoteTs: null,
      remDays: null, sla: null, vendors: undefined, vendorsKnown: undefined,
      dneAmt: undefined, nteAmt: undefined, assignee: '', assigneeInactive: undefined
    };
    Object.keys(over || {}).forEach(function (k) { f[k] = over[k]; });
    return s.computeVerdict(f, s.__cfg);
  }
  A.eq('a clean row is sev 0', V({}).sev, 0);

  // THE 60x FAULT, as a verdict: 3000 minutes is 50 hours - inside a 120h limit. Read as
  // hours it is 3000, 25x over, and the row goes red for no reason. This is the assertion
  // that would have caught "red 217 of 242".
  A.eq('50h in status (3000 minutes) is not a problem', V({ hrs: 50 }).sev, 0);
  A.eq('but 3000 "hours" is red', V({ hrs: 3000 }).sev, 2);

  // remainingDays as the overdue fallback when the complete-by column is out of view.
  A.eq('no complete-by date + a negative day count is overdue', V({ remDays: -88 }).sev, 2);
  A.ok('and it says how far', /overdue 88d/.test(V({ remDays: -88 }).reasons.join('|')), V({ remDays: -88 }).reasons.join('|'));
  A.eq('a positive count inside the warn window is amber', V({ remDays: 2 }).sev, 1);
  A.eq('a comfortable count is silent', V({ remDays: 30 }).sev, 0);
  // Never counted twice: a real date wins and the fallback stays out.
  var both = V({ expTs: new Date(2026, 7, 20).setHours(0, 0, 0, 0), remDays: -88 });
  A.eq('a readable date beats the day count, and only one of them fires', both.reasons.length, 0);

  // Phase as a terminal signal for statuses the name regex cannot know about.
  A.eq('a red clock on a Closed-phase WO is silent', V({ hrs: 3000, phase: 'Closed' }).sev, 0);
  A.eq('Canceled too', V({ hrs: 3000, phase: 'Canceled' }).sev, 0);
  A.eq('an Open phase does not suppress anything', V({ hrs: 3000, phase: 'Open' }).sev, 2);

  // No vendor on a WO that implies one is committed.
  var nv = V({ status: 'Scheduled', vendorsKnown: true, vendors: '' });
  A.eq('scheduled with nobody assigned is amber', nv.sev, 1);
  A.ok('and names the status', /no vendor on a "Scheduled" WO/.test(nv.reasons.join('|')), nv.reasons.join('|'));
  A.eq('a vendor present is silent', V({ status: 'Scheduled', vendorsKnown: true, vendors: 'ACME' }).sev, 0);
  A.eq('"Pending Dispatch" with no vendor is its NORMAL state, not a finding',
    V({ status: 'Pending Dispatch', vendorsKnown: true, vendors: '' }).sev, 0);
  A.eq('"Pending Schedule" likewise', V({ status: 'Pending Schedule', vendorsKnown: true, vendors: '' }).sev, 0);
  // Those two are excluded by the status list itself ("Schedule" is not "Scheduled").
  // The `^pending` guard is for the other shape: a WAITING status that does reach the
  // list. Umbrava lets a tenant name its own statuses and the live board already carries
  // "Pending Materials Supplier" and "Vendor Proposal Required", so a "Pending Vendor
  // Proposal" is a status this tenant could add tomorrow - and waiting for a proposal is
  // precisely when there is legitimately no vendor yet.
  A.eq('a "Pending ..." status that DOES reach the list is still not a finding',
    V({ status: 'Pending Vendor Proposal', vendorsKnown: true, vendors: '' }).sev, 0);
  A.eq('while the settled form of the same status IS',
    V({ status: 'Vendor Proposal Approved', vendorsKnown: true, vendors: '' }).sev, 1);
  A.eq('and a field that was never read is never a finding',
    V({ status: 'Scheduled', vendorsKnown: false, vendors: '' }).sev, 0);

  // Committed vendor cost over the client's authorization.
  var ov = V({ dneAmt: 14485.64, nteAmt: 20000 });
  A.eq('vendor NTE over DNE is red', ov.sev, 2);
  A.ok('and shows both numbers', /over DNE \$14,485\.64/.test(ov.reasons.join('|')), ov.reasons.join('|'));
  A.eq('under is silent', V({ dneAmt: 14485.64, nteAmt: 10588.66 }).sev, 0);
  A.eq('equal is not over', V({ dneAmt: 100, nteAmt: 100 }).sev, 0);
  A.eq('a zero DNE is not a breach - it is an unset authorization', V({ dneAmt: 0, nteAmt: 100 }).sev, 0);
  A.eq('one number alone proves nothing', V({ nteAmt: 20000 }).sev, 0);

  // Orphaned WO. Only ever true, never guessed.
  var orph = V({ assigneeInactive: true, assignee: 'Daniel Russell' });
  A.eq('assigned to a deactivated account is amber', orph.sev, 1);
  A.ok('and says who', /inactive user \(Daniel Russell\)/.test(orph.reasons.join('|')), orph.reasons.join('|'));
  A.eq('an active assignee is silent', V({ assigneeInactive: false }).sev, 0);
  A.eq('an unknown assignee state is silent', V({ assigneeInactive: undefined }).sev, 0);

  // Kinds drive the snooze, so a new signal must carry a stable kind.
  A.eq('every new signal has a snoozable kind',
    [V({ status: 'Scheduled', vendorsKnown: true, vendors: '' }).kinds[0],
      V({ dneAmt: 1, nteAmt: 2 }).kinds[0],
      V({ assigneeInactive: true }).kinds[0]],
    ['novendor', 'nteover', 'orphan']);
})();

console.log('\n-- v3.19: the next step comes from the playbook, on board facts only --');
(function () {
  var s = build({});
  var e = s.heatApiRowToEntry(makeRow(0)).entry;
  s.__actsOut = [
    { key: 'anchor:completion', label: 'Completion package reference', anchor: true },
    { key: 'phase:client', label: 'Chase the client for approval', why: 'Waiting on the client 12d' }
  ];
  var act = s.heatNextStep(e, s.bwnConfig());
  A.eq('the standing completion ANCHOR is never reported as the next step', act && act.key, 'phase:client');
  A.eq('and the step is the engine’s own label', act && act.label, 'Chase the client for approval');

  var st = s.__actStates[s.__actStates.length - 1];
  // Per-field, not one blanket rule - see heatNextStep's comment. `pos` MUST be an array
  // (the engine dereferences it unguarded) and an empty one emits no PO steps; `docs` MUST
  // stay null, because `docs.count === 0` is what fires "no documents on file".
  A.eq('pos is an empty array - the one field the engine dereferences unguarded', st.pos, []);
  A.eq('every other absent collection is null, so "unread" cannot read as "empty"',
    [st.docs, st.openTasks, st.noShow, st.stall], [null, null, null, null]);
  A.eq('money the row cannot know is null, not zero', [st.gpPct, st.nte, st.vendorTotal], [null, null, null]);
  A.eq('no authored plan is read from a list row', st.authoredPlan, null);
  A.eq('the clock is passed as a number', st.hrs, 1350);
  A.eq('the complete-by date becomes a due verdict', [st.due.kind, st.due.label], ['ok', 'Due 16d']);
  A.eq('note age is days, from the row’s own last-note date', st.staleDays, 13);
  A.eq('identity rides along for the step text', [st.hd.wo, st.hd.tracking], ['W-327000', '1052000']);

  // An overdue row must reach the engine as overdue.
  var od = s.heatApiRowToEntry(makeRow(1)).entry;
  od.exp = '7/01/2026';
  s.heatNextStep(od, s.bwnConfig());
  var st2 = s.__actStates[s.__actStates.length - 1];
  A.eq('a passed complete-by date is a bad due verdict', [st2.due.kind, st2.due.label], ['bad', 'Overdue 34d']);

  // No date at all -> null, not a fabricated "due today".
  var nd = s.heatApiRowToEntry(makeRow(2)).entry;
  nd.exp = '';
  s.heatNextStep(nd, s.bwnConfig());
  A.eq('no complete-by date means no due verdict', s.__actStates[s.__actStates.length - 1].due, null);

  // Degradation: an engine that returns nothing, throws, or is not published at all.
  s.__actsOut = [{ key: 'anchor:x', label: 'anchor only', anchor: true }];
  A.eq('an anchor-only list yields no next step', s.heatNextStep(e, s.bwnConfig()), null);
  s.__actsOut = [];
  A.eq('an empty list yields no next step', s.heatNextStep(e, s.bwnConfig()), null);
  s.__actsThrow = true;
  A.eq('a thrown engine yields null instead of killing the audit', s.heatNextStep(e, s.bwnConfig()), null);
  A.ok('and says so once', s.__log.join('|').indexOf('next-step engine declined') !== -1, s.__log.join('|'));
  var before = s.__log.length;
  s.heatNextStep(e, s.bwnConfig());
  A.eq('never twice', s.__log.length, before);
  s.__actsThrow = false;
  s.bwnActsEngine = null;
  A.eq('an unpublished engine (WO Assist module off) yields null, not a crash', s.heatNextStep(e, s.bwnConfig()), null);
})();

console.log('\n-- v3.19: the REAL engine against a real board row (no stub) --');
(function () {
  var s = buildEngine({});
  // Mapped by the REAL mapper in the SAME sandbox, so the row handed to the engine is
  // byte-for-byte what a scan would have stored.
  function entryFor(over) {
    var row = makeRow(0);
    Object.keys(over || {}).forEach(function (k) { row[k] = over[k]; });
    return s.heatApiRowToEntry(row).entry;
  }

  // The fixture: 201 days old, waiting on client approval, 1350h in status, complete-by
  // 16 days out. The playbook's answer should be to chase the client.
  var act = s.heatNextStep(entryFor({}), s.__cfg);
  A.ok('the mature engine accepts a board row and returns a step', !!act, 'got ' + JSON.stringify(act));
  A.ok('and the step is a real, labelled action', !!(act && act.label && act.key), JSON.stringify(act));
  A.ok('it is not the standing completion anchor', !(act && act.anchor), JSON.stringify(act && act.key));
  A.ok('a client-waiting status yields an escalate-or-chase step, not a PO/trip step',
    /^(escalate|phase|note|ecd)/.test(String(act && act.key)), String(act && act.key));

  // Terminal statuses must yield nothing - the engine's own early return, reached through
  // heatNextStep with no help from List Heat.
  A.eq('a Closed WO has no next step', s.heatNextStep(entryFor({ statusName: 'Closed' }), s.__cfg), null);
  A.eq('a Cancelled WO likewise', s.heatNextStep(entryFor({ statusName: 'Cancelled' }), s.__cfg), null);
  A.eq('and Paid', s.heatNextStep(entryFor({ statusName: 'Paid' }), s.__cfg), null);

  // The engine must not manufacture PO / no-show / docs steps out of the nulls we pass.
  var keys = [];
  ['Scheduled', 'Pending Dispatch', 'In Progress', 'Pending Materials Supplier',
    'Vendor Proposal Required', 'Awaiting Client Approval', 'Work Complete'].forEach(function (st) {
      var a = s.heatNextStep(entryFor({ statusName: st }), s.__cfg);
      if (a) keys.push(st + ' -> ' + a.key.split(':')[0]);
    });
  A.ok('every live status the board carries is either answered or silent, never a crash',
    keys.length >= 4, keys.join(' | '));
  A.ok('and no step is invented from the PO / trip / document nulls',
    !/(^|\| )\S+ -> (poacc|pocost|pomat|poconf|noshow|docs|task)\b/.test(keys.join(' | ')), keys.join(' | '));

  // An overdue row must escalate harder than a comfortable one - proof the dates we pass
  // actually reach the ranking, not just the state object.
  var overdue = entryFor({});
  overdue.exp = '5/01/2026';
  var aOver = s.heatNextStep(overdue, s.__cfg);
  A.ok('an overdue row still returns a step', !!aOver, JSON.stringify(aOver));
  A.ok('and the overdue date is what it leads with',
    /ecd|escalate/.test(String(aOver && aOver.key)), String(aOver && aOver.key));
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

// ============================================================================
// v3.20: THE TWO WRITERS AND THE ONE KEY.
//
// Measured live 2026-08-04 on the real board: the list row's WO link is
// "/work-orders/371126/details" - a ROUTE SUFFIX - while the API path built the key as
// "/work-orders/371126". Both write into the same heatStore, so every row the DOM pass
// touched was filed a SECOND time and the board count grew as the virtualizer rendered
// more of the list. A one-row board announced "of 2 open - full board"; the user's
// 217-row board opened at 221 and reached 286 after scrolling.
//
// This was latent for as long as the API scan was broken: until v3.18 every replay threw
// and heatStore was DOM-only, so both keys came from the same producer and agreed. Fixing
// the scan is what made the mismatch reachable.
console.log('\n-- heatStore key: the DOM row and the API row must agree (v3.20) --');
(function () {
  var s = build({});
  var LIVE = '/work-orders/371126/details';   // copied off the live DOM, not invented
  A.eq('the live row href canonicalizes to the bare WO route', s.heatKey(LIVE), '/work-orders/371126');
  A.eq('a bare route is already canonical', s.heatKey('/work-orders/371126'), '/work-orders/371126');
  A.eq('an absolute href canonicalizes the same', s.heatKey('https://app.umbrava.com/work-orders/371126/details'), '/work-orders/371126');
  A.eq('a trailing query/hash is not part of the key', s.heatKey('/work-orders/371126?tab=notes#x'), '/work-orders/371126');
  A.eq('a non-numeric route has no key', s.heatKey('/work-orders/new'), null);
  A.eq('empty href has no key', s.heatKey(''), null);
  A.eq('null href has no key', s.heatKey(null), null);

  // The regression itself, real bytes on both sides: the API mapper's href and the DOM
  // row's canonicalized href are the SAME string, so the same WO cannot be stored twice.
  var row = makeRow(0);
  var mapped = s.heatApiRowToEntry(row);
  A.eq('API writer key', mapped.href, '/work-orders/327000');
  A.eq('DOM writer key for the same WO is identical',
    s.heatKey('/work-orders/' + row.number + '/details'), mapped.href);
  A.ok('and the RAW href - the pre-v3.20 key - is not that string, which is the whole bug',
    ('/work-orders/' + row.number + '/details') !== mapped.href);
})();

console.log('\n-- heatStore writes: the DOM pass adds rows, it never doubles or thins them --');
(function () {
  var s = buildStore({});

  // No store yet (no scan has run): the DOM pass must not conjure one.
  s.heatStore = null;
  s.heatStoreDomPut('/work-orders/326991', domRec(326991));
  A.eq('no store -> no write, no throw', s.heatStore, null);

  // Scroll-scan path: the store is DOM-owned, so the DOM record lands and later repaints
  // refresh it (a status edited in place must not be frozen at its first read).
  s.heatStore = {};
  s.heatStoreDomPut(s.heatKey('/work-orders/326991/details'), domRec(326991));
  A.eq('DOM row files under the canonical key', Object.keys(s.heatStore), ['/work-orders/326991']);
  var moved = domRec(326991); moved.status = 'Scheduled';
  s.heatStoreDomPut(s.heatKey('/work-orders/326991/details'), moved);
  A.eq('a DOM-sourced record IS replaced on the next pass', s.heatStore['/work-orders/326991'].status, 'Scheduled');
  A.eq('and it is still one row, not two', Object.keys(s.heatStore).length, 1);

  // A row with no WO id in its href is not a WO row: it must not become a key.
  s.heatStoreDomPut(s.heatKey('/work-orders/new'), domRec(0));
  A.eq('an unkeyable href writes nothing', Object.keys(s.heatStore).length, 1);

  // The reported symptom: an API scan owns the board, then the DOM pass sweeps the rows
  // on screen. Store size must not move.
  s.heatStore = {};
  s.heatStore['/work-orders/326991'] = apiRec(326991);
  s.heatStore['/work-orders/327018'] = apiRec(327018);
  s.heatStoreDomPut(s.heatKey('/work-orders/326991/details'), domRec(326991));
  s.heatStoreDomPut(s.heatKey('/work-orders/327018/details'), domRec(327018));
  A.eq('a DOM sweep over an API-scanned board adds no rows', Object.keys(s.heatStore).length, 2);
  A.eq('and the keys are still the canonical ones',
    Object.keys(s.heatStore).sort(), ['/work-orders/326991', '/work-orders/327018']);

  // ...and the API record is not thinned by the sweep. These are the facts no <tr> carries;
  // blanking them would quietly degrade exactly the rows the coordinator is looking at.
  var kept = s.heatStore['/work-orders/326991'];
  A.eq('API-only assigneeId survives the DOM sweep', kept.assigneeId, 'ae7bb143-d386-4a0c-8be6-5a182c0b988f');
  A.eq('API-only NTE survives', kept.nteAmt, 9752.73);
  A.eq('API-only phase survives', kept.phase, 'Open');
  A.eq('API-only remainingDays survives', kept.remDays, -3);
  A.eq('API-only vendorsKnown survives', kept.vendorsKnown, true);
  A.eq('the record is still tagged as the API read', kept.src, 'api');
  A.eq('the API-converted hours are kept, not overwritten by the column text', kept.hrs, '1299.7');
  // One field DOES cross over: a snooze toggled while the store stands.
  A.eq('acked is refreshed from the row', kept.acked, true);

  // A DOM row the scan never returned (added to the board since, or outside the scanned
  // filter) still has to land - the sweep is additive, it is only non-destructive.
  s.heatStoreDomPut(s.heatKey('/work-orders/399999/details'), domRec(399999));
  A.eq('a genuinely new row is still added', Object.keys(s.heatStore).length, 3);
  A.eq('and it is DOM-sourced', s.heatStore['/work-orders/399999'].src, undefined);
})();

// ============================================================================
// v3.21 / Core 1.66.28: THE HOOK HAS TO BEAT THE APP.
//
// Capture is passive - it can only latch a board query fired AFTER the hook is in place.
// Measured live 2026-08-04, four reloads of the same page, and the correlation was exact:
//
//   core script starts | GraphQL landing after it | auto-scan
//   4015 ms            | 0 of 17                  | never ran
//   1464 ms            | 15 of 18                 | ran
//   3466 ms            | 0 of 17                  | never ran
//   1822 ms            | 14 of 18                 | ran
//
// The app's first GraphQL request starts at ~1240 ms; `@run-at document-idle` landed
// anywhere from 1464 ms to 4015 ms. So the hook moved to document-start and the modules
// were deferred to the load event to keep their old timing. These two slices are the
// seam that makes that safe: a buffer that holds what the app fired before List Heat
// existed, and a queue that holds the modules until there is a page for them.
console.log('\n-- document-start GraphQL buffer: nothing fired before List Heat is lost --');
(function () {
  var s = buildGqlBuf({});
  // Boot-time requests, before any consumer exists.
  s.bwnGqlSeen('{"query":"A"}', null);
  s.bwnGqlSeen('{"query":"B"}', { rows: 1 });
  var got = [];
  var replayed = s.bwnGqlSetSink(function (body, data) { got.push([body, data]); });
  A.eq('both boot-time requests were replayed', replayed, 2);
  A.eq('in the order the app fired them', got.map(function (g) { return g[0]; }), ['{"query":"A"}', '{"query":"B"}']);
  A.eq('the request-only frame arrives with no data', got[0][1], null);
  A.eq('the response bonus rides along when there was one', got[1][1], { rows: 1 });

  // After attach the buffer is out of the picture.
  s.bwnGqlSeen('{"query":"C"}', null);
  A.eq('a later request goes straight to the consumer', got.length, 3);
  A.eq('and the buffer stayed empty', s.BWN_GQL_BUF.length, 0);
  A.eq('so re-attaching replays nothing', s.bwnGqlSetSink(function () { }), 0);

  // Bounded: a page that never attaches a consumer must not grow forever.
  var s2 = buildGqlBuf({});
  for (var i = 0; i < 60; i++) s2.bwnGqlSeen('q' + i, null);
  A.eq('the buffer caps at 40 frames', s2.BWN_GQL_BUF.length, 40);
  var kept = [];
  s2.bwnGqlSetSink(function (b) { kept.push(b); });
  A.eq('and it keeps the EARLIEST frames - the board query fires at boot, not at the end',
    [kept[0], kept[39]], ['q0', 'q39']);

  // One bad frame must not cost the rest: the drain is the only chance they get.
  var s3 = buildGqlBuf({});
  s3.bwnGqlSeen('x1', null); s3.bwnGqlSeen('x2', null); s3.bwnGqlSeen('x3', null);
  var seen3 = [];
  s3.bwnGqlSetSink(function (b) { if (b === 'x2') throw new Error('consumer blew up'); seen3.push(b); });
  A.eq('a throwing consumer does not abort the drain', seen3, ['x1', 'x3']);
  var s4 = buildGqlBuf({});
  var live4 = 0;
  s4.bwnGqlSetSink(function () { live4++; throw new Error('still blowing up'); });
  s4.bwnGqlSeen('later', null);
  A.eq('and a throw on a live frame is swallowed too', live4, 1);
})();

console.log('\n-- module boot queue: document-start must not run module bodies --');
(function () {
  var s = buildBootQ({});
  var order = [];
  s.bwnBoot('alpha', true, function () { order.push('alpha'); });
  s.bwnBoot('beta', false, function () { order.push('beta'); });     // kill switch off
  s.bwnBoot('gamma', true, function () { order.push('gamma'); });
  A.eq('nothing runs at registration time - there is no page yet', order, []);
  A.eq('a disabled module is not even queued', s.BWN_BOOT_Q.length, 2);

  s.bwnBootAll();
  A.eq('the flush runs the enabled modules in registration order', order, ['alpha', 'gamma']);
  A.eq('a module whose kill switch is off never runs', order.indexOf('beta'), -1);
  A.eq('every module went through safeModule, so one throw cannot take the suite down', s.__wrapped, 2);

  s.bwnBootAll();
  A.eq('a second flush is a no-op', order, ['alpha', 'gamma']);

  s.bwnBoot('delta', true, function () { order.push('delta'); });
  A.eq('a module registered after the flush runs immediately rather than being dropped',
    order, ['alpha', 'gamma', 'delta']);

  // Containment survives: a module that throws is recorded, the next one still runs.
  var s2 = buildBootQ({});
  var ran2 = [];
  s2.bwnBoot('bad', true, function () { throw new Error('module init failed'); });
  s2.bwnBoot('good', true, function () { ran2.push('good'); });
  s2.bwnBootAll();
  A.eq('a module that throws does not stop the ones after it', ran2, ['good']);
  A.eq('and the failure is recorded, not swallowed silently', s2.__ran, ['THREW:bad']);
})();

// The call site is not inside any slice above, so it is checked as shipped bytes: the raw
// href must be gone from the writer, and both the key and the merge must go through the
// named functions. This is what stops the mismatch being re-introduced one edit later.
console.log('\n-- the shipped call site --');
(function () {
  A.ok('the DOM writer no longer keys on the raw href',
    core.indexOf("heatStore[link.getAttribute('href')]") === -1);
  // v3.22 moved the key into a local (rowKey) because the tint now also looks the row up in
  // the store to borrow its phase - one key expression, used by BOTH, so a lookup miss and a
  // write can never land on different keys. The intent under test is unchanged: the DOM
  // writer's key comes from heatKey, never from the raw href.
  A.ok('it keys through heatKey and merges through heatStoreDomPut',
    core.indexOf("var rowKey = heatKey(link.getAttribute('href'));") !== -1 &&
    core.indexOf('heatStoreDomPut(rowKey, {') !== -1);
  A.ok('and the phase the tint borrows is read at that same key',
    core.indexOf("heatStore[rowKey] && heatStore[rowKey].src === 'api'") !== -1);
  A.ok('the API mapper builds its href through heatKey too',
    core.indexOf("href: heatKey('/work-orders/' + num),") !== -1);

  // v3.21 entry point. These are the assertions that would catch someone reverting the
  // @run-at, or adding a 12th module the old way and having it run before the page.
  A.ok('the script runs at document-start', core.indexOf('// @run-at       document-start') !== -1);
  // The metadata line specifically - the prose above the boot block still says the word,
  // because it records what this replaced and why.
  A.ok('and the metadata block no longer says document-idle', core.indexOf('// @run-at       document-idle') === -1);
  A.ok('the hook is installed at file level, not inside a module',
    core.indexOf('(function installGqlHook() {') !== -1 && core.indexOf('(function installNetHook() {') === -1);
  A.ok('List Heat attaches to it rather than installing its own',
    core.indexOf('bwnGqlSetSink(function (body, data) { heatRecordCapture(body, data); })') !== -1);
  A.ok('the module queue is flushed on load',
    core.indexOf("if (document.readyState === 'complete') bwnBootAll();") !== -1 &&
    core.indexOf("else window.addEventListener('load', bwnBootAll);") !== -1);
  // EVERY module must go through the queue. A stray inline BWN.safeModule dispatch would
  // run its body at document-start, with no document.body - the exact failure this
  // restructure exists to avoid, and one that shows up as a module silently not mounting.
  var dispatch = core.match(/^  bwnBoot\('\w+', BWN_MODULES\.\w+, function \(\) \{$/gm) || [];
  A.eq('all 12 modules are registered through bwnBoot', dispatch.length, 12);   // +domHandle (phase 4)
  A.eq('and none is dispatched inline', (core.match(/^  if \(BWN_MODULES\.\w+\) BWN\.safeModule\(/gm) || []).length, 0);
  // Cheap proof the ids still line up with their kill switches after a bulk rewrite.
  var mismatched = dispatch.filter(function (d) {
    var m = d.match(/bwnBoot\('(\w+)', BWN_MODULES\.(\w+)/);
    return !m || m[1] !== m[2];
  });
  A.eq('each module id matches its own kill switch', mismatched, []);
})();

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
    console.log('\n-- v3.19: resolving assignee names from ids --');
    var s = build({ transport: makeUserTransport({}) });
    var store = {};
    // Two rows share a coordinator, one has a different one, one already came with a name:
    // the lookup must be per DISTINCT id, and must not re-read a row that needs nothing.
    store['/work-orders/1'] = idOnlyRow(s, 1, 'ad017f63-30f6-4074-b073-cec166f9aa7b');
    store['/work-orders/2'] = idOnlyRow(s, 2, 'ad017f63-30f6-4074-b073-cec166f9aa7b');
    store['/work-orders/3'] = idOnlyRow(s, 3, '980fa5bd-e655-4917-aad7-6d9cd49752e2');
    store['/work-orders/4'] = s.heatApiRowToEntry(makeRow(4)).entry;   // arrived with a name
    return s.heatResolveAssignees(store).then(function (n) {
      A.eq('every id-only row was filled', n, 3);
      A.eq('two rows sharing an id both get the name',
        [store['/work-orders/1'].assignee, store['/work-orders/2'].assignee], ['Daniel Russell', 'Daniel Russell']);
      A.eq('and the other id resolves independently', store['/work-orders/3'].assignee, 'Carol Serra');
      A.eq('a row that already had a name is left alone', store['/work-orders/4'].assignee, 'Daniel Russell');
      A.eq('ONE document, not one per row', s.__transport.queries.length, 1);
      A.eq('with one alias per DISTINCT id', (s.__transport.queries[0].q.match(/user\(id:/g) || []).length, 2);
      A.ok('ids ride as variables, never interpolated into the query text',
        s.__transport.queries[0].q.indexOf('ad017f63') === -1, s.__transport.queries[0].q);
      A.eq('and the variables carry them', s.__transport.queries[0].v.i0, 'ad017f63-30f6-4074-b073-cec166f9aa7b');
      A.ok('isInactive is selected, so the orphan signal costs no extra call',
        /isInactive/.test(s.__transport.queries[0].q), s.__transport.queries[0].q);
      // The inactive flag has to reach the verdict engine, or an orphan can never alarm.
      A.eq('the inactive account is recorded on the row', store['/work-orders/3'].assigneeInactive, true);
      var facts = s.__verdictFacts[s.__verdictFacts.length - 1];
      A.eq('and the row is re-judged with it', facts.assigneeInactive, true);

      // Cached for the tab: a rescan must not re-ask.
      var store2 = { '/work-orders/9': idOnlyRow(s, 9, 'ad017f63-30f6-4074-b073-cec166f9aa7b') };
      return s.heatResolveAssignees(store2).then(function (n2) {
        A.eq('a second scan resolves from cache', [n2, store2['/work-orders/9'].assignee], [1, 'Daniel Russell']);
        A.eq('with no new request', s.__transport.queries.length, 1);
      });
    });
  }).then(function () {
    // An id that does not resolve must still never display as an id.
    var s = build({ transport: makeUserTransport({ unknown: true }) });
    var store = { '/work-orders/1': idOnlyRow(s, 1, 'ad017f63-30f6-4074-b073-cec166f9aa7b') };
    return s.heatResolveAssignees(store).then(function () {
      A.eq('an unreadable id shows as unresolved, NOT as the id', store['/work-orders/1'].assignee, '(unresolved member)');
      A.ok('and it is distinct from "(blank)" so the panel cannot conflate them',
        store['/work-orders/1'].assignee !== '' && store['/work-orders/1'].assignee !== '(blank)');
    });
  }).then(function () {
    // No token: degrade without a request, and still never leak the id.
    var s = build({ transport: makeUserTransport({}) });
    s.__tokenOn = false;
    var store = { '/work-orders/1': idOnlyRow(s, 1, 'ad017f63-30f6-4074-b073-cec166f9aa7b') };
    return s.heatResolveAssignees(store).then(function () {
      A.eq('with no token the row degrades to unresolved', store['/work-orders/1'].assignee, '(unresolved member)');
      A.eq('and nothing was requested', s.__transport.queries.length, 0);
    });
  }).then(function () {
    // 25 distinct ids -> two documents, because one 25-alias document is a bigger blast
    // radius per failure than two.
    var s = build({ transport: makeUserTransport({}) });
    var store = {};
    for (var i = 0; i < 25; i++) store['/work-orders/' + i] = idOnlyRow(s, i, guidN(i));
    return s.heatResolveAssignees(store).then(function (n) {
      A.eq('all 25 filled', n, 25);
      A.eq('chunked into 2 documents at 20 per document', s.__transport.queries.length, 2);
      A.eq('20 aliases then 5', s.__transport.queries.map(function (q) { return (q.q.match(/user\(id:/g) || []).length; }), [20, 5]);
    });
  }).then(function () {
    // One bad id rejects the WHOLE GraphQL document, so a chunk failure must not write off
    // every coordinator in it.
    var s = build({ transport: makeUserTransport({ failBatch: true }) });
    var store = {
      '/work-orders/1': idOnlyRow(s, 1, 'ad017f63-30f6-4074-b073-cec166f9aa7b'),
      '/work-orders/2': idOnlyRow(s, 2, '980fa5bd-e655-4917-aad7-6d9cd49752e2')
    };
    return s.heatResolveAssignees(store).then(function () {
      A.eq('a rejected batch falls back to single reads',
        [store['/work-orders/1'].assignee, store['/work-orders/2'].assignee], ['Daniel Russell', 'Carol Serra']);
      A.eq('one batch attempt plus one read per id', s.__transport.queries.length, 3);
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
    var m4 = [['        if (!clean) { heatStore = null; heatRaw = null; }', '        if (!clean) { /* kept */ }']];
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
    // ---- v3.19 controls. Each reverts ONE fix and must reproduce the live symptom. ----

    // M6: the pre-v3.19 assignee read - one broad pattern through g(), no GUID refusal.
    // This is the reported bug, exactly: the panel labelled its buckets with GUIDs.
    var m6 = [[
      'var assignee = gName([/(^|\\.)(assignedtomembername|assignedtoname|assigneename|assigneedisplayname|coordinatorname|coordinatormembername|ownername|membername|displayname|fullname)$/i]);',
      'var assignee = String(g(/assigned.*(to|user|name)|assignee|coordinator|owner.*name/i) || \'\');'
    ]];
    var s6 = build({ mutations: m6 });
    var e6 = s6.heatApiRowToEntry(makeRow(0)).entry;
    A.eq('M6 control: the old read puts the GUID in the assignee slot', e6.assignee, 'ad017f63-30f6-4074-b073-cec166f9aa7b');
    A.ok('M6 control: which is what the live panel showed', s6.heatIsGuid(e6.assignee));

    // M7: no minutes conversion - the 60x clock.
    var m7 = [['hrs = String(Math.round(parseFloat(hrsMinutes) / 6) / 10);', 'hrs = String(parseFloat(hrsMinutes));']];
    var s7 = build({ mutations: m7 });
    A.eq('M7 control: without the conversion the row reads 81001h', s7.heatApiRowToEntry(makeRow(0)).entry.hrs, '81001');

    // M8: no precision scaling - money 100x over.
    var m8 = [['      return n / Math.pow(10, p);', '      return n;']];
    var s8 = build({ mutations: m8 });
    A.eq('M8 control: unscaled minor units print 100x', s8.heatApiRowToEntry(makeRow(0)).entry.dne, '$1,448,564.00');

    // M9: no SLA scaling - an unparseable label falls back to a neutral limit, so a
    // same-day emergency is judged on the same clock as a 30-day job.
    var m9 = [['    if (sm !== null) mult *= sm;', '    if (false) mult *= sm;']];
    var s9 = buildVerdict({ mutations: m9 });
    A.eq('M9 control: without SLA scaling a same-day promise gets the neutral limit',
      s9.bwnThresholdsFor('Awaiting Client Approval', 'Emergency Life/Safety/Operations: Same Day Service', null, { responseMinutes: 240 }).bad, 120);

    // M10: no "pending" guard - a third of the board goes amber for being at rest.
    var m10 = [['        !/^pending\\s/i.test(String(f.status || \'\').trim())) {', '        true) {']];
    var s10 = buildVerdict({ mutations: m10 });
    A.eq('M10 control: without the guard a WO still WAITING for its proposal is flagged for having no vendor',
      s10.computeVerdict({ status: 'Pending Vendor Proposal', prio: '', ageDays: 1, hrs: NaN, expTs: null, schedTs: null, lastNoteTs: null, vendorsKnown: true, vendors: '' }, s10.__cfg).sev, 1);

    // M11: no anchor skip - the standing completion reference is reported as the next step.
    var m11 = [['        for (var i = 0; i < acts.length; i++) if (acts[i] && !acts[i].anchor) return acts[i];', '        return acts[0];']];
    var s11 = build({ mutations: m11 });
    s11.__actsOut = [
      { key: 'anchor:completion', label: 'Completion package reference', anchor: true },
      { key: 'phase:client', label: 'Chase the client for approval' }
    ];
    A.eq('M11 control: without the skip the anchor is reported as the next step',
      s11.heatNextStep(s11.heatApiRowToEntry(makeRow(0)).entry, s11.bwnConfig()).key, 'anchor:completion');

    // M12: `pos: null` - which is what this code shipped as until the REAL engine was put
    // under test. `state.pos.forEach` is unguarded, so every row threw, the try/catch
    // swallowed it, and the column was silently absent on the entire board while a
    // stub-driven harness reported the feature green. The control proves the array is
    // load-bearing, against the real engine.
    var m12 = [['          pos: [], docs: null, openTasks: null, noShow: null, stall: null,', '          pos: null, docs: null, openTasks: null, noShow: null, stall: null,']];
    var s12 = buildEngine({ mutations: m12 });
    A.eq('M12 control: pos:null makes the real engine throw, so every row loses its step',
      s12.heatNextStep(s12.heatApiRowToEntry ? s12.heatApiRowToEntry(makeRow(0)).entry : null, s12.__cfg), null);

    // M13: `docs: {count: 0}` instead of null - "unread" read as "empty", which fabricates a
    // completion-package chase on every WO at closure off data a board row never carried.
    var m13 = [['          pos: [], docs: null, openTasks: null, noShow: null, stall: null,', '          pos: [], docs: { count: 0 }, openTasks: null, noShow: null, stall: null,']];
    var s13 = buildEngine({ mutations: m13 });
    var e13 = s13.heatApiRowToEntry(makeRow(0)).entry;
    e13.status = 'Confirm Complete';
    var a13 = s13.heatNextStep(e13, s13.__cfg);
    A.eq('M13 control: a zero doc count invents "no documents on file"', a13 && a13.key, 'docs:none');
    // And the shipped code must NOT do that on the same row.
    var s13ok = buildEngine({});
    var e13ok = s13ok.heatApiRowToEntry(makeRow(0)).entry;
    e13ok.status = 'Confirm Complete';
    var a13ok = s13ok.heatNextStep(e13ok, s13ok.__cfg);
    A.ok('and the shipped code does not', !a13ok || a13ok.key !== 'docs:none', String(a13ok && a13ok.key));

    // ---- v3.20 controls. ----

    // M14: heatKey reverted to the raw href - the pre-v3.20 DOM key. This IS the live
    // symptom: two keys for one WO, and a board count that climbs as you scroll.
    var m14 = [["      return m ? '/work-orders/' + m[1] : null;", '      return href || null;']];
    var s14 = buildStore({ mutations: m14 });
    s14.heatStore = {};
    s14.heatStore['/work-orders/326991'] = apiRec(326991);          // as the API scan left it
    s14.heatStoreDomPut(s14.heatKey('/work-orders/326991/details'), domRec(326991));
    A.eq('M14 control: the raw href files the same WO twice', Object.keys(s14.heatStore).length, 2);
    A.eq('M14 control: which is the "of 2 open" a one-row board printed',
      Object.keys(s14.heatStore).sort(), ['/work-orders/326991', '/work-orders/326991/details']);

    // M15: no API guard in the merge - the DOM record clobbers the richer one, so every row
    // on screen silently loses the facts a <tr> cannot carry.
    var m15 = [["      if (prev && prev.src === 'api') { prev.acked = rec.acked; return; }", '']];
    var s15 = buildStore({ mutations: m15 });
    s15.heatStore = {};
    s15.heatStore['/work-orders/326991'] = apiRec(326991);
    s15.heatStoreDomPut(s15.heatKey('/work-orders/326991/details'), domRec(326991));
    A.eq('M15 control: without the guard the API record is thinned', s15.heatStore['/work-orders/326991'].assigneeId, undefined);
    A.eq('M15 control: and it stops reading as an API row', s15.heatStore['/work-orders/326991'].src, undefined);

    // ---- v3.21 controls. ----

    // M16: attach without draining - a document-start hook that throws away what it
    // buffered is worth nothing, because the board query fires during boot. This is the
    // measured live symptom restated: no capture, so the auto-scan never runs.
    var m16 = [['    var buf = BWN_GQL_BUF;', '    var buf = [];']];
    var s16 = buildGqlBuf({ mutations: m16 });
    s16.bwnGqlSeen('{"query":"the board query"}', null);
    var got16 = [];
    var n16 = s16.bwnGqlSetSink(function (b) { got16.push(b); });
    A.eq('M16 control: the boot-time board query is dropped on attach', got16, []);
    A.eq('M16 control: and nothing is reported as replayed', n16, 0);

    // M17: bwnBoot running inline instead of queueing - which is what every module did
    // before this change. At document-start that means a module body runs with no
    // document.body, and safeModule turns the throw into a module that silently never
    // mounted.
    var m17 = [['    BWN_BOOT_Q.push([id, fn]);', '    BWN.safeModule(id, fn);']];
    var s17 = buildBootQ({ mutations: m17 });
    var early17 = [];
    s17.bwnBoot('tripCal', true, function () { early17.push('ran'); });
    A.eq('M17 control: the module body runs at registration, before there is a page', early17, ['ran']);

    // ---- v3.23 controls. ----

    // M18: the alias back to THREE parameters - the shipped 1.66.29 bytes, verbatim. This is
    // the control that could not exist while VERDICT_PRELUDE stubbed the alias with four:
    // the stub WAS the mutation, permanently applied in the harness' favour.
    var m18 = [['    function thresholdsFor(status, prioText, C, sla) { return bwnThresholdsFor(status, prioText, C, sla); }',
      '    function thresholdsFor(status, prioText, C) { return bwnThresholdsFor(status, prioText, C); }']];
    var s18 = buildVerdict({ mutations: m18 });
    A.eq('M18 control: the 3-param alias drops the SLA facts - the measured live numbers',
      s18.thresholdsFor('Scheduled', 'P2 Next Day', s18.__cfg, { responseMinutes: 480, category: 'high' }),
      { warn: 15, bad: 30, sla: false });
    A.eq('M18 control: and the engine it delegates to disagrees with it, which is the bug',
      s18.bwnThresholdsFor('Scheduled', 'P2 Next Day', s18.__cfg, { responseMinutes: 480, category: 'high' }),
      { warn: 10, bad: 20, sla: true });
    A.eq('M18 control: so slaScaled is false on a row that HAS a response clock - which is why the audit panel’s SLA line never printed',
      s18.computeVerdict({ status: 'Scheduled', prio: 'P2 Next Day', phase: 'Open', ageDays: 10, hrs: 25, expTs: null, schedTs: null, lastNoteTs: null, sla: { responseMinutes: 480 } }, s18.__cfg).slaScaled,
      false);
    A.eq('M18 control: and the row that should be red is only amber',
      s18.computeVerdict({ status: 'Scheduled', prio: 'P2 Next Day', phase: 'Open', ageDays: 10, hrs: 25, expTs: null, schedTs: null, lastNoteTs: null, sla: { responseMinutes: 480 } }, s18.__cfg).sev,
      1);
  }).then(function () {
    // =========================================================================================
    // THE DIRTY-SCAN RETRY LOOP (2026-08-09). Measured live: a zero-result filter drove a
    // sustained replay every ~770ms against the vendor API, forever, with no visible symptom.
    // Proven board-independent on the shipped build, with a positive control.
    //
    // Two independent defects, both asserted here. Either one alone closes the loop; both are
    // wrong on their own terms, so both are fixed.
    //
    //   (1) The document-start hook calls its sink TWICE per request - once with the request
    //       body, once when the response resolves. `heatReplaying` gates only the first, and by
    //       the response call finishApi has already cleared it. So Core re-captures its OWN
    //       replay, matches `body.query === apiList.query`, and re-arms heatAutoScanSoon.
    //   (2) The auto-scan guard suppressed on `heatStore`, which a dirty finish had just nulled.
    //       A retry whose suppression depends on the success it never achieves.
    //
    // These run against the REAL heatRecordCapture and apiScanAll slices; heatAutoScanSoon is
    // the prelude's recorder, so "did it re-arm" is observed, not inferred.
    console.log('\n--- dirty-scan retry loop: replay identity + failure backoff ---');

    // ---- (1) a replay's own body must never be treated as a new list query -----------------
    var sOwn = build({});
    sOwn.apiList = { query: 'query PagedWorkOrders { x }', variables: { page: { skip: 0, take: 50 } }, proven: true };
    sOwn.__autoScans.length = 0;
    // Exactly what heatGql puts on the wire.
    var ownBody = JSON.stringify({ query: 'query PagedWorkOrders { x }', variables: { page: { skip: 0, take: 200 } } });
    sOwn.heatNoteOwnBody(ownBody);
    A.ok('a body this module issued is recognised as its own', sOwn.heatIsOwnBody(ownBody));
    A.ok('a body it did not issue is not', !sOwn.heatIsOwnBody(JSON.stringify({ query: 'query Other { y }', variables: {} })));
    // THE LOOP: the response leg, arriving after finishApi cleared heatReplaying.
    sOwn.heatReplaying = false;
    sOwn.heatRecordCapture(ownBody, { listWorkOrdersPaginated: { items: [], rowCount: 0 } });
    A.eq('the replay response does NOT re-arm the auto scan - this is the loop', sOwn.__autoScans.length, 0);
    // ...while a genuine filter change from the SPA still must.
    sOwn.__autoScans.length = 0;
    sOwn.heatRecordCapture(JSON.stringify({ query: 'query PagedWorkOrders { x }', variables: { page: { skip: 0, take: 50 }, search: 'abc' } }), null);
    A.eq('a real SPA filter change still re-arms it', sOwn.__autoScans.length, 1);
    // Bounded: a long-lived page must not grow this registry forever.
    var sCap = build({});
    for (var i = 0; i < 300; i++) sCap.heatNoteOwnBody('body-' + i);
    A.ok('the own-body registry is bounded', sCap.heatOwnBodyQ.length <= 64);
    A.ok('and it evicts oldest-first, so the newest replay is still recognised', sCap.heatIsOwnBody('body-299'));

    // ---- (2) a failed scan must back off, not retry at the debounce interval ---------------
    // The guard's own bytes, lifted from the shipped file rather than paraphrased.
    // Captures the CONDITION only, so the counter that 1.76.1 added inside the block cannot
    // break the match again.
    // The `!force && ` prefix is optional in the pattern because the kanban fold added it. It is
    // captured too, so backoffFires evaluates the guard EXACTLY as shipped rather than a
    // paraphrase of it - and `force` is passed explicitly below.
    var gm = core.match(/\n\s*if \(((?:!force && )?sig && sig === heatAutoFailSig[^\n]*?)\) \{ heatDiag\.autoNoBackoff/);
    A.ok('the failure-backoff guard is present in the shipped file', !!gm);
    function backoffFires(o) {
      var f = new Function('force', 'sig', 'heatAutoFailSig', 'heatAutoFailTs', 'heatAutoBackoffMs', 'Date',
        'return !!(' + gm[1] + ');');
      return f(!!o.force, o.sig, o.failSig, o.failTs, function () { return o.backoff; }, Date);
    }
    A.ok('right after a failure on the same filter, a retry is SUPPRESSED',
      backoffFires({ sig: 'a', failSig: 'a', failTs: Date.now() - 500, backoff: 2000 }) === true);
    A.ok('once the backoff has elapsed it is allowed again',
      backoffFires({ sig: 'a', failSig: 'a', failTs: Date.now() - 5000, backoff: 2000 }) === false);
    A.ok('a DIFFERENT filter is never held back by another filter\'s failure',
      backoffFires({ sig: 'b', failSig: 'a', failTs: Date.now(), backoff: 60000 }) === false);
    // The backoff must actually grow, or "backoff" is just a rename of the debounce.
    var sB = build({});
    sB.heatAutoFailN = 1; var b1 = sB.heatAutoBackoffMs();
    sB.heatAutoFailN = 2; var b2 = sB.heatAutoBackoffMs();
    sB.heatAutoFailN = 3; var b3 = sB.heatAutoBackoffMs();
    sB.heatAutoFailN = 99; var bMax = sB.heatAutoBackoffMs();
    A.ok('the backoff grows with consecutive failures', b2 > b1 && b3 > b2);
    A.ok('and is capped, so a permanently-dirty filter still retries eventually', bMax <= 60000 && bMax >= b3);

    // ---- and the dirty finish must actually ARM that backoff --------------------------------
    // capAt: a query that can only ever see 5 of 213 rows, so the coverage gate finishes it
    // DIRTY - which is the case the backoff exists for.
    var sD = build({ transport: makeTransport({ capAt: 5, total: 213 }) });
    sD.apiList = { query: 'q', variables: boardVars(), proven: true };
    sD.heatAutoSig = 'sig-under-test';
    return sD.apiScanAll({}).then(function () {
      A.ok('a dirty finish records WHICH filter failed', sD.heatAutoFailSig === 'sig-under-test');
      A.ok('and when', sD.heatAutoFailTs > 0);
      A.ok('and counts it, so the next failure waits longer', sD.heatAutoFailN >= 1);

      // ---- the kanban fold's OWN defect: a dirty finish must still announce ------------------
      // The first version of the fold announced only on a CLEAN finish, so a consumer that had
      // pulled mid-scan sat on "scan in progress" forever - measured live as the board showing a
      // stale card from the previous filter while claiming to be scanning. A finish is a finish.
      console.log('\n-- fold: the announce must fire on a DIRTY finish too --');
      var sDirty = build({ transport: makeTransport({ capAt: 5, total: 213 }) });
      sDirty.apiList = { query: 'q', variables: boardVars(), proven: true };
      return sDirty.apiScanAll({}).then(function () {
        A.eq('the dirty scan really did finish dirty', sDirty.heatScanClean, false);
        A.ok('and it STILL announced, so a mid-scan consumer is corrected',
          sDirty.__events.indexOf('bwn:heat:rows') !== -1);
        A.eq('while the row snapshot is empty, because a dirty scan has no rows to hand over',
          sDirty.heatRowsCache, null);

        var sClean = build({ transport: makeTransport({ total: 8 }) });
        sClean.apiList = { query: 'q', variables: boardVars(), proven: true };
        return sClean.apiScanAll({}).then(function () {
          A.eq('a clean scan announces too', sClean.__events.indexOf('bwn:heat:rows') !== -1, true);
          A.ok('and hands over rows', sClean.heatRowsCache && sClean.heatRowsCache.rows.length > 0);
          A.ok('each carrying the RAW api row, without which the board loses statusId',
            !!(sClean.heatRowsCache.rows[0] && sClean.heatRowsCache.rows[0].raw));

          // Control: announce only on clean, which is the defect this rebuild fixed.
          var mA = build({
            transport: makeTransport({ capAt: 5, total: 213 }),
            mutations: [['        heatRowsAnnounce();\n        console.info', '        if (clean) heatRowsAnnounce();\n        console.info']]
          });
          mA.apiList = { query: 'q', variables: boardVars(), proven: true };
          return mA.apiScanAll({}).then(function () {
            A.eq('MLA control: announcing only on clean leaves a dirty finish silent',
              mA.__events.indexOf('bwn:heat:rows'), -1);
          });
        });
      }).then(function () {

      // ---- MUTATION CONTROLS: each reverts one half of the fix and must reopen the loop ----
      // Without these the assertions above are decoration - they would pass just as happily
      // against code that never had the bug. See negative-control-silent-noop.
      console.log('\n-- retry-loop mutation controls (each must REOPEN the loop) --');

      // ML1: drop the identity check and the replay's own response is treated as a new list
      // query again - which is the re-arm that closed the loop.
      var m1 = build({ mutations: [[
        "      if (heatIsOwnBody(typeof reqBody === 'string' ? reqBody : null)) { heatDiag.ownSkip++; return; }", '']] });
      m1.apiList = { query: 'query PagedWorkOrders { x }', variables: { page: { skip: 0, take: 50 } }, proven: true };
      var b1 = JSON.stringify({ query: 'query PagedWorkOrders { x }', variables: { page: { skip: 0, take: 200 } } });
      m1.heatNoteOwnBody(b1);
      m1.heatReplaying = false;
      m1.__autoScans.length = 0;
      m1.heatRecordCapture(b1, { listWorkOrdersPaginated: { items: [], rowCount: 0 } });
      A.eq('ML1 control: without the identity check the replay re-arms the scan', m1.__autoScans.length, 1);

      // ML2: drop the failure arming in finishApi and the guard has nothing to back off from,
      // so a permanently-failing filter is retried at the debounce interval forever.
      var m2 = build({
        transport: makeTransport({ capAt: 5, total: 213 }),
        mutations: [['        else { heatAutoFailSig = heatAutoSig; heatAutoFailTs = Date.now(); heatAutoFailN++; }', '']]
      });
      m2.apiList = { query: 'q', variables: boardVars(), proven: true };
      m2.heatAutoSig = 'sig-under-test';
      return m2.apiScanAll({}).then(function () {
        A.eq('ML2 control: without the arming, a dirty finish leaves no failure record', m2.heatAutoFailSig, null);
        A.ok('ML2 control: so the backoff window is zero and the retry is immediate',
          !(m2.heatAutoFailSig === 'sig-under-test'));

        // ML3: the guard line itself. Strip it from the shipped bytes and the suppression is
        // gone even with a fresh failure recorded.
        var stripped = core.replace(/\n\s*if \((?:!force && )?sig && sig === heatAutoFailSig[^\n]*?\) \{ heatDiag\.autoNoBackoff\+\+; return; \}/, '');
        A.ok('ML3 control: the mutation actually removed the guard',
          stripped.indexOf('heatAutoFailSig && (Date.now()') === -1 && stripped !== core);
        A.ok('ML3 control: and nothing else in the file re-implements it',
          (stripped.match(/heatAutoFailTs\) </g) || []).length === 0);
      });
      });
    });
  }).then(function () {
    A.finish();
  }, function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
