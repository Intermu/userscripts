// test-po-api.js - node harness for the API purchase-order read (purchaseOrders(workOrderNumber)),
// added beside the existing DOM readPOs() scrape in bwn-suite-core 1.86.0.
//
// WHAT THIS ADDS (additive only - nothing here changes Next Actions behaviour):
//   PO_CACHE + PO_API_Q + fetchPOs (async, fills the cache, re-renders) and readPOsApi (SYNC cache
//   read, same shape as readDocs/readWO) - a new reader living beside readPOs(), not replacing it.
//   state.pos stays sourced from the DOM reader; poFromApi()/fetchPOs() are additive surface only.
//
//   poParityLog() then compares the two readers per WO (joined by sid) and logs a redacted summary
//   (counts, sids, field NAMES) so real-WO drift between the DOM scrape and the API can be read
//   from the console before anything is switched over.
//
// WHAT THIS PROVES, against the REAL shipped bytes (sliced from bwn-suite-core.user.js and run in a
// vm against a stub bwnGql - nothing here is a restatement):
//   - the query is the ROOT purchaseOrders(workOrderNumber) field, never the deprecated nested
//     workOrder { purchaseOrders } shape, and carries only fields from the captured allowlist.
//   - a pending read is null and does not re-fire once per render; a non-array payload and a
//     rejected fetch are UNKNOWN (null), NEVER empty.
//   - poFromApi() classifies done/poStatus/costOpen off phase/statusName alone, exercised over the
//     27 live Umbrava PO status (id, name, phase) triples with expected done/poStatus/costOpen
//     AUTHORED from the 2026-09-17 ruling - not observed on a live row per status - with Closed as
//     an INTENTIONAL divergence from the DOM regex.
//   - two POs sharing a number get distinct sids (the row id breaks the tie).
//   - the parity log joins on sid, reports mismatches by FIELD NAME only, and never leaks a vendor
//     string, a date, or an amount into its (redacted) summary.
//   - a persistent failure stops re-firing after PO_MAX_TRIES (3) attempts per WO per page load.
//   - a rejected (network) read warns once on its first failure and once more when it gives up -
//     both warnings name the WO only, never a row value.
//   - a schema-drift (non-array) read never warns on first failure, only once when it gives up.
//   - a missing notToExceed reads amount 0 AND is flagged via api.nteAbsent, surfaced in the parity
//     summary as apiAmountAbsent, so parity can tell a real $0 from an absent NTE.
//   - the parity summary also reports hdrSeen (did the header testid resolve), unjoinedDomSids (the
//     DOM-side sid list), and a schedDate mismatch as a fixed category (never a date value).
//   - domBySid only joins a digit line-label sid matching /^ln\d{2,4}(-\d+)?$/; anything else -
//     a non-digit collision suffix, a vendor-GUID sid, or any other sid shape - is counted in
//     domSkipped and never published.
//   - the statusText compare is punctuation-insensitive (containment, both sides normalized), and an
//     empty API status name is always flagged, never vacuously matched.
//   - tzOffsetMin rides along too, so a pasted summary is interpretable for the date-boundary question.
//   - a stale-DOM log is held off by the URL guard (currentWOId()) and, when a header testid resolves
//     via document.querySelector, the header guard too - both must name the same WO.
//   - an empty DOM logs a confident {domCount:0, apiCount:0} summary when the API agrees; it holds off
//     entirely when API rows are cached but the DOM has simply not rendered yet.
//   - fetchPOs reads through bwnGqlRead() (1.87.0): a non-'ok' envelope - including a 'partial' body
//     with data AND errors[] - is unknown, cached as 'error', and the one warn per WO names the failure
//     CLASS + GraphQL error code (never a server message); its rows never reach the parity cache.
//   - every behaviour above is also driven by a negative control that must turn this harness red: 23
//     total (2 query-shape + 21 reader), enforced by mutate()'s absent/non-unique throw.
//
// WHAT IT DOES NOT PROVE:
//   - that `purchaseOrders(workOrderNumber:)` exists on the live schema for this tenant, or that the
//     field set here is complete. Only a real WO, read through the parity log, answers that - this
//     harness is deliberately the reason state.pos has NOT been switched to the API read yet.
//
// Every case is re-run against mutated copies of the same source; each mutation MUST turn this
// harness red. mutate() throws if its target is absent or not unique, so a mutation that silently
// no-ops cannot pass for a control.
//
// Fixtures are entirely synthetic: vendor names like "Vendor A"/"Vendor B", small integer ids,
// dates in 2030, and work-order numbers in the 100001-100005 range (distinct from the real WO
// numbers other harnesses in this repo pin).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-po-api.js

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

var S_READER = slice(
  '    // ===== BWN-PO-API START v1 (API purchase-order read + parity log; sliced by scripts/test-po-api.js) =====',
  '    // ===== BWN-PO-API END v1 =====',
  'BWN-PO-API block'
);

// coreFull with the sliced reader block removed - so a hermeticity pin can prove a shadow-read
// symbol never leaks outside the marked block, over the REAL shipped bytes.
var OUTSIDE_READER = coreFull.split(S_READER).join('');

function countOccurrences(hay, needle) {
  var c = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
  return c;
}

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- Query-shape pin ---------------------------------------------------------
// A pure check over the query STRING (not the vm-sliced reader), so the two controls below can
// drive it with synthetic query text without needing a live schema.
var ALLOWED_FIELDS = {};
[
  'id', 'number', 'formattedPurchaseOrderNumber', 'phase', 'statusId', 'statusName', 'state',
  'notToExceed', 'nextOnsiteDate', 'hasScheduledTrip', 'trips', 'vendorId', 'vendorName',
  'vendorIdentity', 'paidDate', 'vendorAcceptedDate', 'purchaseOrderDate', 'acceptedEmailStatus',
  'amount', 'currency', 'precision',
  'onSiteDate', 'status', 'completedDate', 'canceledDate',
  'companyName', 'isDependent', 'hasActiveUsers'
].forEach(function (f) { ALLOWED_FIELDS[f] = true; });
var NOT_FIELDS = { query: 1, BwnWOPOs: 1, Int: 1, n: 1, purchaseOrders: 1, workOrderNumber: 1 };

function checkQueryShape(q) {
  var problems = [];
  if (!/purchaseOrders\s*\(\s*workOrderNumber\s*:\s*\$n\s*\)/.test(q)) {
    problems.push('root purchaseOrders(workOrderNumber: $n) shape not found');
  }
  if (/workOrder\s*[{(]/.test(q.replace(/workOrderNumber/g, ''))) {
    problems.push('a workOrder{} / workOrder() wrapper was found - the deprecated nested shape');
  }
  var tokens = q.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  tokens.forEach(function (t) {
    if (NOT_FIELDS[t] || ALLOWED_FIELDS[t]) return;
    problems.push('field not in allowlist: ' + t);
  });
  return problems;
}

// ---- Environment --------------------------------------------------------------
// bwnGql is stubbed as a DEFERRED promise per call so a test can hold a read "pending" and land it
// later. readPOs (the DOM reader) and nvVendor are stubbed too - the parity log is exercised
// against controlled fixtures, not a real DOM.
function makeReader(readerSrc) {
  var env = { fetches: [], refreshes: 0, wo: null, domRows: [], domNodes: [], hdr: null, infos: [], warns: [], win: {} };
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, Math: Math, Date: Date,
    JSON: JSON, Promise: Promise, Error: Error, isNaN: isNaN,
    console: {
      info: function () { env.infos.push(Array.prototype.slice.call(arguments)); },
      warn: function () { env.warns.push(Array.prototype.slice.call(arguments)); },
      log: function () { }
    },
    currentWOId: function () { return env.wo; },
    refresh: function () { env.refreshes++; },
    readPOs: function () { return env.domRows; },
    nvVendor: function (s) { return (s || '').replace(/\s+/g, ' ').trim().toUpperCase(); },
    document: {
      querySelector: function () { return env.hdr; },
      querySelectorAll: function () { return env.domNodes; }
    },
    window: env.win,
    bwnGql: function (query, variables) {
      var rec = { query: query, vars: variables };
      rec.p = new Promise(function (res, rej) { rec.resolve = res; rec.reject = rej; });
      env.fetches.push(rec);
      return rec.p;
    }
  };
  // fetchPOs reads through bwnGqlRead() (the classified envelope, 1.87.0). The stub keeps the
  // deferred-per-call contract above: a resolved `data` is an 'ok' envelope, a rejection is a
  // 'network' envelope, and a fixture may resolve a full envelope object directly (kind + codes)
  // to drive the graphql-error / http paths. bwnGqlRead never rejects in production either.
  sandbox.bwnGqlRead = function (query, variables) {
    return sandbox.bwnGql(query, variables).then(function (d) {
      if (d && typeof d === 'object' && typeof d.kind === 'string' && 'status' in d) return d;
      return { kind: 'ok', status: 200, noToken: false, data: d, codes: [], messageLen: [] };
    }, function (err) {
      return { kind: 'network', status: 0, noToken: false, data: null, codes: [], messageLen: [String(err && err.message || err).length] };
    });
  };
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + readerSrc + '\n' +
    'return { readPOsApi: readPOsApi, fetchPOs: fetchPOs, poFromApi: poFromApi, ' +
    'poParityLog: poParityLog, poParityTick: poParityTick, cache: PO_CACHE, parity: PO_PARITY, q: PO_API_Q };\n})()',
    sandbox, { filename: 'po-api-reader.js' });
  env.readPOsApi = api.readPOsApi;
  env.fetchPOs = api.fetchPOs;
  env.poFromApi = api.poFromApi;
  env.poParityLog = api.poParityLog;
  env.poParityTick = api.poParityTick;
  env.cache = api.cache;
  env.parity = api.parity;
  env.q = api.q;
  return env;
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

// A synthetic PurchaseOrder row. Every field the query selects gets a default so a test only
// overrides what it cares about.
function makeRow(over) {
  var base = {
    id: 1, number: 1, formattedPurchaseOrderNumber: '001', phase: 'Open',
    statusId: -1, statusName: 'New', state: 'Active',
    notToExceed: { amount: 10000, currency: 'USD', precision: 2 },   // $100.00
    nextOnsiteDate: '2030-03-05T00:00:00Z', hasScheduledTrip: false, trips: [],
    vendorId: 1, vendorName: 'Vendor A',
    vendorIdentity: { id: 1, companyName: 'Vendor A', isDependent: false, hasActiveUsers: true },
    paidDate: '', vendorAcceptedDate: '', purchaseOrderDate: '2030-01-01T00:00:00Z', acceptedEmailStatus: ''
  };
  var out = {};
  for (var k in base) out[k] = base[k];
  for (var k2 in (over || {})) out[k2] = over[k2];
  return out;
}

// A synthetic DOM row, matching readPOs()'s per-PO output shape.
function makeDomRow(over) {
  var base = { vendor: 'Vendor A', num: '1', sid: 'ln001', amount: 100, schedDate: '3/5/30', done: false, poStatus: '', statusText: 'New', costOpen: true };
  var out = {};
  for (var k in base) out[k] = base[k];
  for (var k2 in (over || {})) out[k2] = over[k2];
  return out;
}

// All 27 live Umbrava PO statuses (id, statusName, phase) with their expected done/poStatus/costOpen
// (amount > 0 in every row via makeRow()'s default notToExceed).
var STATUS_TABLE = [
  [-1, 'New', 'Open', false, '', true],
  [-2, 'Material Ordered', 'Open', false, 'materials', true],
  [-3, 'Pending Schedule', 'Open', false, '', true],
  [-4, 'Scheduled', 'Open', false, '', true],
  [-5, 'On-Site', 'Open', false, '', true],
  [-6, 'Vendor Proposal Required', 'Open', false, '', true],
  [-7, 'Proposed', 'Open', false, '', true],
  [-8, 'Proposal Approved', 'Open', false, '', true],
  [-9, 'Clocked Out: In Progress', 'Open', false, '', true],
  [-10, 'Client Action Required', 'Open', false, '', true],
  [-11, 'Confirm Complete', 'ConfirmComplete', true, 'confirm', true],
  [-12, 'Recall', 'Open', false, '', true],
  [-13, 'Work Complete', 'WorkComplete', true, '', true],
  [-14, 'Invoiced', 'WorkComplete', true, '', false],
  [-15, 'Paid', 'WorkComplete', true, '', false],
  [-16, 'Declined', 'Declined', true, '', false],
  [-17, 'Closed', 'Closed', true, '', true],
  [-18, 'Canceled', 'Canceled', true, '', false],
  [-19, 'On Hold', 'OnHold', false, '', true],
  [-20, 'Pending Acceptance', 'PendingAcceptance', false, 'accept', true],
  [-21, 'Unassigned', 'PendingAcceptance', false, '', true],
  [-22, 'Revoked', 'Revoked', true, '', false],
  [-23, 'Confirm Cancel', 'ConfirmCancel', false, '', true],
  [-24, 'Clocked Out: Complete', 'Open', false, '', true],
  [-25, 'Confirm Reopen', 'ConfirmReopen', false, '', true],
  [-27, 'On The Way', 'Open', false, '', true],
  [-28, 'Need Material', 'Open', false, 'materials', true]
];

// ---- The cases ------------------------------------------------------------
// Returns a result list rather than asserting directly, so the same cases can be re-run against a
// mutant and checked for redness.
function runCases(readerSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }

  var e;
  try { e = makeReader(readerSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return Promise.resolve(out); }

  // --- the classifier table: all 27 live statuses, synchronous via poFromApi ---
  STATUS_TABLE.forEach(function (row) {
    var statusId = row[0], statusName = row[1], phase = row[2], expDone = row[3], expPoStatus = row[4], expCostOpen = row[5];
    var p = e.poFromApi(makeRow({ statusId: statusId, statusName: statusName, phase: phase }));
    eq('status ' + statusId + ' (' + statusName + ') done', p.done, expDone);
    eq('status ' + statusId + ' (' + statusName + ') poStatus', p.poStatus, expPoStatus);
    eq('status ' + statusId + ' (' + statusName + ') costOpen', p.costOpen, expCostOpen);
  });

  // --- named field-shape cases -------------------------------------------------
  var pSched = e.poFromApi(makeRow({ statusId: -4, statusName: 'Scheduled', phase: 'Open', number: 1 }));
  eq('Scheduled sid is the zero-padded line number', pSched.sid, 'ln001');
  ok('Scheduled schedDate is set', !!pSched.schedDate, pSched.schedDate);

  var pPend = e.poFromApi(makeRow({ statusId: -3, statusName: 'Pending Schedule', phase: 'Open', nextOnsiteDate: null }));
  eq('Pending Schedule with no nextOnsiteDate reads schedDate as null, never a guess', pPend.schedDate, null);

  var pPaid = e.poFromApi(makeRow({ statusId: -15, statusName: 'Paid', phase: 'WorkComplete', paidDate: '' }));
  eq('Paid reads api.paid true from statusName alone', pPaid.api.paid, true);

  var pPaidDate = e.poFromApi(makeRow({ statusId: -14, statusName: 'Invoiced', phase: 'WorkComplete', paidDate: '2030-04-01' }));
  ok('a non-empty paidDate reads as paid even when statusName is Invoiced', pPaidDate.api.paid === true);

  var pUnpaid = e.poFromApi(makeRow({ statusId: -13, statusName: 'Work Complete', phase: 'WorkComplete', paidDate: '' }));
  eq('an empty paidDate on a non-Paid status is not paid', pUnpaid.api.paid, false);
  eq('Work Complete costOpen stays TRUE - cost not yet locked', pUnpaid.costOpen, true);

  var pCancel = e.poFromApi(makeRow({ statusId: -18, statusName: 'Canceled', phase: 'Canceled', notToExceed: { amount: 0, currency: 'USD', precision: 2 } }));
  eq('Canceled with a zero amount stays not cost-open', pCancel.costOpen, false);
  eq('Canceled amount reads as 0', pCancel.amount, 0);

  var pClosed = e.poFromApi(makeRow({ statusId: -17, statusName: 'Closed', phase: 'Closed' }));
  eq('Closed reads done=true - the DOM regex has no "Closed" keyword to match, this is API-only', pClosed.done, true);

  var pPrec0 = e.poFromApi(makeRow({ notToExceed: { amount: 500, currency: 'USD', precision: 0 } }));
  eq('precision 0 does not divide the amount', pPrec0.amount, 500);

  // --- off a work order: no read at all ---------------------------------------
  e.wo = null;
  eq('off a WO the read is unknown, not empty', e.readPOsApi(), null);
  eq('and no request is made', e.fetches.length, 0);

  // --- first read on a WO: unknown, one request, correct query shape ----------
  e.wo = '100001';
  eq('the first read is unknown while the fetch is in flight', e.readPOsApi(), null);
  eq('exactly one request fired', e.fetches.length, 1);
  eq('the query pins clean (root purchaseOrders(workOrderNumber:), allowlisted fields)', checkQueryShape(e.q), []);
  eq('the WO number goes out as a NUMBER (Int!), not the string currentWOId() returned',
    typeof e.fetches[0].vars.n, 'number');
  eq('and its VALUE is the URL work-order number, not an internal job/PO id (the wrong-id class this pin exists for)',
    e.fetches[0].vars.n, 100001);

  // --- a second render while the first read is pending must NOT re-fire -------
  eq('a re-render during the pending read is still unknown', e.readPOsApi(), null);
  eq('and did not fire a second request', e.fetches.length, 1);

  e.fetches[0].resolve({ purchaseOrders: [
    makeRow({ id: 1, number: 5, statusId: -4, statusName: 'Scheduled', phase: 'Open' }),
    makeRow({ id: 2, number: 5, statusId: -20, statusName: 'Pending Acceptance', phase: 'PendingAcceptance', vendorName: 'Vendor B' })
  ] });

  return tick().then(function () {
    var got = e.readPOsApi();
    eq('the landed read returns both rows', got.length, 2);
    eq('the first of a colliding pair keeps the plain sid', got[0].sid, 'ln005');
    eq('a duplicate PO number gets a distinct sid via the row id', got[1].sid, 'ln005-2');
    eq('the landing triggered exactly one re-render', e.refreshes, 1);
    eq('a cached read fires no further requests', e.fetches.length, 1);
    ok('a cached read is the same array, not a refetch', e.readPOsApi() === got);

    // --- confident empty ---
    e.wo = '100002';
    eq('a fresh WO starts unknown again', e.readPOsApi(), null);
    eq('and fires its own request', e.fetches.length, 2);
    e.fetches[1].resolve({ purchaseOrders: [] });
    return tick();
  }).then(function () {
    eq('an empty PO list is a CONFIDENT empty, not unknown', e.readPOsApi(), []);

    // --- confident-empty parity: an empty DOM plus a confident-empty API list still logs (this
    // is the stuck-handoff evidence the DOM-not-rendered-yet guard must NOT swallow) ---
    e.domRows = [];
    e.domNodes = [];
    e.poParityLog('100002');
    var emptySummary = e.win.__bwnPoParity;
    ok('a confident-empty API list with an empty DOM published a summary', !!emptySummary, JSON.stringify(emptySummary));
    eq('domCount is 0', emptySummary.domCount, 0);
    eq('apiCount is 0', emptySummary.apiCount, 0);

    // --- the DOM-not-rendered-yet guard: API rows are cached but the DOM is still empty, so wait ---
    e.wo = '100001';   // 2 API rows already landed for this WO earlier
    e.domRows = [];
    e.poParityLog('100001');
    ok('an empty DOM with API rows waiting holds off the log entirely', !e.parity['100001']);

    // --- a non-array payload is unknown, and self-heals on the next render ---
    e.wo = '100003';
    e.readPOsApi();
    e.fetches[2].resolve({ purchaseOrders: null });
    return tick();
  }).then(function () {
    eq('a non-array payload reads as unknown', e.readPOsApi(), null);
    eq('and the next render retries it', e.fetches.length, 4);
    e.fetches[3].resolve({ purchaseOrders: [makeRow({ id: 3, number: 9 })] });
    return tick();
  }).then(function () {
    eq('the retry lands normally', (e.readPOsApi() || []).length, 1);

    // --- parity: joined by sid, mismatches by field name, summary is redacted ---
    // Seven DOM rows: ln001 will match an API row with a deliberate amount mismatch; the
    // guid-fallback row is excluded from the join entirely (ln-prefixed sids only); ln002 is
    // ln-prefixed but has no API counterpart, so it must count as unjoined; ln003 matches an API
    // row with no scheduled-date label of its own (the schedDate:domAbsent category) and no
    // statusText of its own either, so it also mismatches on statusText; ln07 is the 2-digit-label
    // case - its own sid never matches the API's zero-padded ln007, so both sides count as unjoined
    // instead of joining on the PO number they actually share; ln009-zz is the non-digit collision
    // suffix - it must be counted as skipped, never joined or published as unjoined; ln005-2 is a
    // DIGIT collision suffix - it must join the second of two same-numbered API rows, leaving the
    // first API row (ln005, no suffix) unjoined instead.
    e.wo = '100005';
    e.domRows = [
      makeDomRow({ vendor: 'Vendor A', num: '1', sid: 'ln001', amount: 250, schedDate: '3/5/30', done: false, poStatus: '', costOpen: true, statusText: 'Open Scheduled' }),
      makeDomRow({ vendor: 'Vendor C', num: '2', sid: 'v-guid-fallback', amount: 40, schedDate: undefined, done: false, poStatus: '', costOpen: true }),
      makeDomRow({ vendor: 'Vendor D', num: '3', sid: 'ln002', amount: 75, schedDate: '4/1/30', done: false, poStatus: '', costOpen: true }),
      makeDomRow({ vendor: 'Vendor E', num: '4', sid: 'ln003', schedDate: undefined, amount: 60 }),
      makeDomRow({ vendor: 'Vendor F', num: '5', sid: 'ln07', amount: 20, schedDate: '4/2/30', statusText: 'Open Scheduled' }),
      makeDomRow({ vendor: 'Vendor G', num: '6', sid: 'ln009-zz', amount: 15, schedDate: '5/1/30', statusText: 'Open New' }),
      makeDomRow({ vendor: 'Vendor H', num: '8', sid: 'ln005-2', amount: 100, schedDate: '3/5/30', statusText: 'Open Scheduled' })
    ];
    e.domNodes = [{ textContent: 'Vendor A $250.00' }, { textContent: 'Vendor C $40.00 $12.00' }];
    e.readPOsApi();   // kicks the fetch
    eq('one fetch fired for the parity WO', e.fetches.length, 5);
    // Deliberate amount mismatch against the DOM row above (250 DOM vs 300 API) on the same sid.
    // Noon UTC keeps the calendar day stable across the local timezone the harness runs under.
    // vendorName on the ln003 API row matches its DOM counterpart so 'vendor' stays out of that
    // row's mismatch list - the row exists to test the schedDate category, not vendor comparison.
    // The last two rows share number 5: the first keeps the plain sid ln005 (and stays unjoined -
    // no DOM row wears that plain sid), the second collides onto ln005-2 (poFromApi's row-id
    // suffix) and joins the DOM row above with no mismatch.
    e.fetches[4].resolve({ purchaseOrders: [
      makeRow({ id: 10, number: 1, statusId: -4, statusName: 'Scheduled', phase: 'Open', notToExceed: { amount: 30000, currency: 'USD', precision: 2 }, nextOnsiteDate: '2030-03-05T12:00:00Z' }),
      makeRow({ id: 12, number: 3, statusId: -4, statusName: 'Scheduled', phase: 'Open', vendorName: 'Vendor E', notToExceed: { amount: 6000, currency: 'USD', precision: 2 }, nextOnsiteDate: '2030-06-01T12:00:00Z' }),
      makeRow({ id: 11, number: 7, statusId: -4, statusName: 'Scheduled', phase: 'Open', notToExceed: null }),
      makeRow({ id: 30, number: 5, statusId: -4, statusName: 'Scheduled', phase: 'Open', nextOnsiteDate: '2030-03-05T12:00:00Z', vendorName: 'Vendor H' }),
      makeRow({ id: 2, number: 5, statusId: -4, statusName: 'Scheduled', phase: 'Open', nextOnsiteDate: '2030-03-05T12:00:00Z', vendorName: 'Vendor H' })
    ] });
    return tick();
  }).then(function () {
    e.poParityTick();
    var summary = e.win.__bwnPoParity;
    ok('parity summary was published', !!summary, JSON.stringify(summary));
    eq('parity joins the DOM and API rows on sid', summary.joined, 3);
    eq('unjoinedDom counts both ln-prefixed DOM rows with no API match', summary.unjoinedDom, 2);
    ok('unjoinedDomSids names them (ln002 and the 2-digit-label ln07)',
      summary.unjoinedDomSids.indexOf('ln002') !== -1 && summary.unjoinedDomSids.indexOf('ln07') !== -1,
      JSON.stringify(summary.unjoinedDomSids));
    ok('unjoinedDomSids never names the non-digit collision suffix row (it was skipped, not joined)',
      summary.unjoinedDomSids.indexOf('ln009-zz') === -1, JSON.stringify(summary.unjoinedDomSids));
    ok('unjoinedDomSids never names the digit collision suffix row (it joined instead)',
      summary.unjoinedDomSids.indexOf('ln005-2') === -1, JSON.stringify(summary.unjoinedDomSids));
    eq('unjoinedApiSids names the 2-digit-label miss and the plain-sid half of the number-5 collision, in API row order',
      summary.unjoinedApiSids, ['ln007', 'ln005']);
    eq('mismatches report a deliberate amount mismatch and a schedDate:domAbsent + statusText category, by FIELD NAME - the digit-collision join (ln005-2) carries none',
      summary.mismatches, [{ sid: 'ln001', fields: ['amount'] }, { sid: 'ln003', fields: ['schedDate:domAbsent', 'statusText'] }]);
    eq('the multi-$ DOM row is counted', summary.domMultiAmount, 1);
    eq('the label-absent DOM rows are counted (guid-fallback and ln003)', summary.domLabelAbsent, 2);
    eq('the vendor-GUID-fallback row and the non-digit collision suffix row are excluded from the join and counted as skipped', summary.domSkipped, 2);
    eq('the API row with no notToExceed is counted', summary.apiAmountAbsent, 1);
    eq('no header testid was seen', summary.hdrSeen, false);
    ok('tzOffsetMin is an integer within a real UTC-offset range',
      Number.isInteger(summary.tzOffsetMin) && summary.tzOffsetMin >= -840 && summary.tzOffsetMin <= 840, summary.tzOffsetMin);
    // tzOffsetMin is excluded here: it's a real, machine-dependent integer (e.g. 300 on US Eastern,
    // 360 on US Central) that can itself contain a banned digit sequence below by sheer coincidence -
    // that would flake this leak-scan by timezone, which is not what it's checking for.
    var blob = JSON.stringify(summary, function (k, v) { return k === 'tzOffsetMin' ? undefined : v; });
    ok('the parity summary carries no vendor string', blob.indexOf('Vendor') === -1, blob);
    ok('the parity summary carries no amount',
      blob.indexOf('250') === -1 && blob.indexOf('300') === -1 && blob.indexOf('75') === -1 &&
      blob.indexOf('60') === -1 && blob.indexOf('20') === -1 && blob.indexOf('15') === -1, blob);
    ok('the parity summary carries no date string',
      blob.indexOf('3/5') === -1 && blob.indexOf('4/1') === -1 && blob.indexOf('4/2') === -1 && blob.indexOf('6/1') === -1, blob);

    var infosBefore = e.infos.length;
    e.poParityLog('100005');
    eq('a second call for an already-logged WO does not log again', e.infos.length, infosBefore);

    // --- a rejected fetch is unknown, NEVER empty, and warns with no row values ---
    // (last, deliberately: a failed read is retried on the next call, which would otherwise
    // shift every fetch index that followed it)
    e.wo = '100004';
    e.readPOsApi();
    e.fetches[5].reject(new Error('network'));
    return tick();
  }).then(function () {
    eq('a failed read is unknown', e.readPOsApi(), null);
    eq('exactly one warning was logged for the whole run', e.warns.length, 1);
    var warnText = e.warns[0].join(' ');
    ok('the warning names the failing WO but carries no row values',
      warnText.indexOf('100004') !== -1 && warnText.indexOf('Vendor A') === -1 && warnText.indexOf('Vendor B') === -1,
      warnText);

    // --- header guard: a rendered header naming a DIFFERENT WO holds off the log the same way
    // the URL guard does; the URL guard alone is not enough once a header is present ---
    // (DOM stays empty until after the fetch lands, so the auto parity-log inside fetchPOs' own
    // .then bails via the DOM-not-rendered-yet guard instead of consuming the once-per-WO latch
    // before the guard tests below get to run)
    e.wo = '100006';
    e.domRows = [];
    e.readPOsApi();
    e.fetches[e.fetches.length - 1].resolve({ purchaseOrders: [makeRow({ id: 20, number: 1 }), makeRow({ id: 21, number: 2 })] });
    return tick();
  }).then(function () {
    ok('not latched yet - the DOM was still empty when the fetch landed', !e.parity['100006']);
    e.domRows = [makeDomRow({ sid: 'ln001' }), makeDomRow({ sid: 'ln002', num: '2' })];

    var infosBefore6 = e.infos.length;
    e.wo = '100001';   // URL names a different WO than the one we ask about
    e.poParityLog('100006');
    eq('the URL guard holds off a WO that is not the current one', e.infos.length, infosBefore6);
    ok('and nothing was latched for it', !e.parity['100006']);

    e.wo = '100006';
    e.hdr = { textContent: 'W-999999' };
    e.poParityLog('100006');
    eq('a rendered header naming a different WO holds off the log too', e.infos.length, infosBefore6);
    ok('still not latched', !e.parity['100006']);

    e.hdr = { textContent: 'Work Order W-100006' };
    e.poParityLog('100006');
    eq('a header that names this WO logs exactly once', e.infos.length, infosBefore6 + 1);
    ok('and is now latched', !!e.parity['100006']);
    eq('hdrSeen is true when the header resolved', e.win.__bwnPoParity.hdrSeen, true);
    e.hdr = null;

    // --- statusText comparator: an empty API statusName is flagged via the !as guard (never
    // vacuously matched), and a punctuation-only difference ('On-Site' vs 'Open On Site') is not ---
    e.wo = '100008';
    e.domRows = [
      makeDomRow({ sid: 'ln001', num: '1', statusText: 'Open Scheduled' }),
      makeDomRow({ sid: 'ln002', num: '2', vendor: 'Vendor B', statusText: 'Open On Site' })
    ];
    e.readPOsApi();
    e.fetches[e.fetches.length - 1].resolve({ purchaseOrders: [
      makeRow({ id: 20, number: 1, statusId: -4, statusName: '', phase: 'Open', nextOnsiteDate: '2030-03-05T12:00:00Z' }),
      makeRow({ id: 21, number: 2, statusId: -5, statusName: 'On-Site', phase: 'Open', vendorName: 'Vendor B', nextOnsiteDate: '2030-03-05T12:00:00Z' })
    ] });
    return tick();
  }).then(function () {
    e.poParityTick();
    eq('an empty API statusName is flagged and a punctuation-only difference is not',
      e.win.__bwnPoParity.mismatches, [{ sid: 'ln001', fields: ['statusText'] }]);

    // --- retry cap: a persistently-failing WO stops re-firing after PO_MAX_TRIES, warns once on
    // the first failure and once more when it gives up (placed last: like the 100004 case above,
    // it consumes fetch indices) ---
    e.wo = '100007';
    var wo7Idx1 = e.fetches.length;
    e.readPOsApi();
    eq('retry cap attempt 1 fires a request', e.fetches.length, wo7Idx1 + 1);
    e.fetches[wo7Idx1].reject(new Error('network'));
    return tick();
  }).then(function () {
    var wo7Idx2 = e.fetches.length;
    e.readPOsApi();
    eq('retry cap attempt 2 fires a request', e.fetches.length, wo7Idx2 + 1);
    e.fetches[wo7Idx2].reject(new Error('network'));
    return tick();
  }).then(function () {
    var wo7Idx3 = e.fetches.length;
    e.readPOsApi();
    eq('retry cap attempt 3 fires a request', e.fetches.length, wo7Idx3 + 1);
    e.fetches[wo7Idx3].reject(new Error('network'));
    return tick();
  }).then(function () {
    var fetchesBefore = e.fetches.length;
    eq('a 4th read after the cap is still unknown', e.readPOsApi(), null);
    eq('and does not fire another request', e.fetches.length, fetchesBefore);
    eq('exactly three warnings were logged for the whole run (100004 first-failure, 100007 first-failure, 100007 gave-up)', e.warns.length, 3);
    var lastWarn = e.warns[e.warns.length - 1].join(' ');
    ok('the last warning is the give-up warning, names 100007, and carries no vendor value',
      lastWarn.indexOf('100007') !== -1 && lastWarn.indexOf('gave up') !== -1 && lastWarn.indexOf('Vendor') === -1,
      lastWarn);

    // --- schema-drift give-up: a non-array payload never warns on first failure (only a rejected
    // fetch does); it still gives up and warns once after PO_MAX_TRIES, naming the WO only ---
    e.wo = '100009';
    var wo9Idx1 = e.fetches.length;
    e.readPOsApi();
    eq('drift cap attempt 1 fires a request', e.fetches.length, wo9Idx1 + 1);
    e.fetches[wo9Idx1].resolve({ purchaseOrders: null });
    return tick();
  }).then(function () {
    var wo9Idx2 = e.fetches.length;
    e.readPOsApi();
    eq('drift cap attempt 2 fires a request', e.fetches.length, wo9Idx2 + 1);
    e.fetches[wo9Idx2].resolve({ purchaseOrders: null });
    return tick();
  }).then(function () {
    var wo9Idx3 = e.fetches.length;
    e.readPOsApi();
    eq('drift cap attempt 3 fires a request', e.fetches.length, wo9Idx3 + 1);
    e.fetches[wo9Idx3].resolve({ purchaseOrders: null });
    return tick();
  }).then(function () {
    eq('the schema-drift give-up adds exactly one new warning (drift never warns on first failure)', e.warns.length, 4);
    var lastWarn9 = e.warns[e.warns.length - 1].join(' ');
    ok('the drift give-up warning names 100009 and carries no vendor value',
      lastWarn9.indexOf('100009') !== -1 && lastWarn9.indexOf('gave up') !== -1 && lastWarn9.indexOf('Vendor') === -1,
      lastWarn9);
    var fetchesBefore9 = e.fetches.length;
    eq('a 4th read after the drift cap is still unknown', e.readPOsApi(), null);
    eq('and does not fire another request', e.fetches.length, fetchesBefore9);

    // --- positive case: an API sid collision suffixed by a NON-NUMERIC row id (ln005-x1), and a
    // null-number row (lnnull), both fail the publish filter while the plain collision half
    // (ln005) still passes it - proving unjoinedApi (the raw count) can exceed
    // unjoinedApiSids.length (the published, redaction-safe list) without leaking either odd sid
    // into it. One ordinary DOM row keeps the DOM side of the join unaffected. ---
    e.wo = '100010';
    e.domRows = [makeDomRow({ vendor: 'Vendor A', num: '1', sid: 'ln001', amount: 100, schedDate: '3/5/30', statusText: 'New' })];
    e.readPOsApi();
    e.fetches[e.fetches.length - 1].resolve({ purchaseOrders: [
      makeRow({ id: 70, number: 1, statusId: -1, statusName: 'New', phase: 'Open' }),
      makeRow({ id: 71, number: 5, statusId: -4, statusName: 'Scheduled', phase: 'Open' }),
      makeRow({ id: 'x1', number: 5, statusId: -4, statusName: 'Scheduled', phase: 'Open' }),
      makeRow({ id: 72, number: null, statusId: -1, statusName: 'New', phase: 'Open' })
    ] });
    return tick();
  }).then(function () {
    e.poParityTick();
    var s10 = e.win.__bwnPoParity;
    ok('the null-number/non-numeric-id positive case published a summary', !!s10, JSON.stringify(s10));
    eq('the collision sid built from a non-numeric row id (ln005-x1) does not appear in unjoinedApiSids',
      s10.unjoinedApiSids.indexOf('ln005-x1'), -1);
    eq('the null-number sid (lnnull) does not appear in unjoinedApiSids',
      s10.unjoinedApiSids.indexOf('lnnull'), -1);
    eq('the plain collision half (ln005) still passes the publish filter, alone', s10.unjoinedApiSids, ['ln005']);
    eq('unjoinedApi (the raw count) exceeds unjoinedApiSids.length by 2 - the two unpublishable sids',
      s10.unjoinedApi - s10.unjoinedApiSids.length, 2);
    eq('the DOM side is unaffected: the one real DOM row still joins normally', s10.joined, 1);
    eq('and nothing is skipped on the DOM side', s10.domSkipped, 0);

    // --- classified transport failure (1.87.0): a 'graphql-error' envelope is unknown, and the ONE warn
    // names the failure CLASS + code, never a server message (drives the adapter's envelope branch) ---
    e.wo = '100011';
    e.domRows = [];
    var warnsBefore11 = e.warns.length;
    e.readPOsApi();
    e.fetches[e.fetches.length - 1].resolve({ kind: 'graphql-error', status: 200, noToken: false, data: null, codes: ['UNAUTHENTICATED'], messageLen: [40] });
    // The adapter adds a promise hop and the failure path resolves through .then -> throw -> .catch, one
    // microtask deeper than tick() waits for; a macrotask yield lets the catch run before asserting.
    return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
      eq('a graphql-error envelope leaves the read unknown', e.readPOsApi(), null);
      eq('and warns exactly once', e.warns.length, warnsBefore11 + 1);
      var w11 = e.warns[e.warns.length - 1].join(' ');
      ok('the warn carries the WO, the failure class and the error code, never a message',
        w11.indexOf('100011') !== -1 && w11.indexOf('api read failed') !== -1 && w11.indexOf('graphql-error:UNAUTHENTICATED') !== -1 && w11.indexOf('http200') !== -1 && w11.indexOf('Vendor') === -1, w11);
    });
  }).then(function () {
    // --- a 'partial' envelope (data AND errors[]) is a FAILURE for this consumer: its rows never reach
    // the parity cache (bwnGql threw on any errors[]; the classified read keeps that bar here) ---
    e.wo = '100012';
    e.domRows = [];
    var warnsBefore12 = e.warns.length;
    e.readPOsApi();
    e.fetches[e.fetches.length - 1].resolve({ kind: 'partial', status: 200, noToken: false, data: { purchaseOrders: [makeRow({ id: 80, number: 1, statusId: -1, statusName: 'New', phase: 'Open' })] }, codes: ['FORBIDDEN'], messageLen: [9] });
    return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
      eq('the partial read is cached as error (so it is retried), not as rows', e.cache['100012'], 'error');   // read the cache BEFORE readPOsApi(), which re-fires the retry and flips it back to pending
      eq('a partial envelope is unknown - its rows are NOT fed to the parity cache', e.readPOsApi(), null);
      eq('and warns exactly once', e.warns.length, warnsBefore12 + 1);
      var w12 = e.warns[e.warns.length - 1].join(' ');
      ok('the partial warn carries class + code and no row value', w12.indexOf('partial:FORBIDDEN') !== -1 && w12.indexOf('Vendor') === -1, w12);
    });
  }).then(function () {
    return out;
  }, function (err) {
    out.push({ name: 'cases ran without throwing', ok: false, detail: String(err && err.message || err) });
    return out;
  });
}

// ---- Negative controls --------------------------------------------------------
// Each reverts one piece of the real behaviour. A control that cannot go red is worse than no
// control, so every entry below is asserted to produce failures.
var READER_MUTATIONS = [
  { what: 'the Array.isArray guard dropped (the non-array path then throws into the catch and WARNS; the guard is what keeps schema drift a silent unknown)',
    reader: function (s) { return mutate(s, '!Array.isArray(rows)', 'false'); } },
  { what: 'WorkComplete dropped from the terminal phase set',
    reader: function (s) { return mutate(s, 'WorkComplete: 1, ', ''); } },
  { what: 'the WO number goes out as the string currentWOId() returned, not an Int',
    reader: function (s) { return mutate(s, '{ n: Number(woNum) }', '{ n: woNum }'); } },
  { what: 'the query argument renamed off workOrderNumber (the wrong-id class the query-shape pin exists for)',
    reader: function (s) { return mutate(s, 'purchaseOrders(workOrderNumber: $n)', 'purchaseOrders(jobId: $n)'); } },
  { what: 'a mismatch entry carries a raw amount (the redaction the parity summary promises)',
    reader: function (s) { return mutate(s, 'mismatches.push({ sid: sid, fields: fields })', 'mismatches.push({ sid: sid, fields: fields, amount: d.amount })'); } },
  { what: 'the once-per-WO parity latch dropped (a second call for the same WO logs again)',
    reader: function (s) { return mutate(s, 'PO_PARITY[woNum] = true;', ''); } },
  { what: "a failed read caches a guessed empty instead of 'error' (never a guessed empty)",
    reader: function (s) { return mutate(s, "PO_CACHE[woNum] = 'error';   // retried on the next render, like fetchDocs; warn once per WO, not once per retry", "PO_CACHE[woNum] = { pos: [], apiCount: 0, ts: 0 };   // retried on the next render, like fetchDocs; warn once per WO, not once per retry"); } },
  { what: 'the URL guard dropped from poParityLog (a stale route can latch the wrong WO)',
    reader: function (s) { return mutate(s, 'if (String(currentWOId()) !== String(woNum)) return;', ''); } },
  { what: 'the header guard neutralized (a header naming a different WO no longer holds off the log)',
    reader: function (s) { return mutate(s, "(hdr.textContent || '').indexOf(String(woNum)) === -1) return;", "(hdr.textContent || '').indexOf(String(woNum)) === -1 && false) return;"); } },
  { what: 'the retry cap effectively disabled (a persistent failure would re-fire a request every render forever)',
    reader: function (s) { return mutate(s, '>= PO_MAX_TRIES) return;', '>= 999) return;'); } },
  { what: "the schedDate:domAbsent category collapsed onto schedDate:day (a mismatch category, never a value)",
    reader: function (s) { return mutate(s, "'schedDate:domAbsent'", "'schedDate:day'"); } },
  { what: 'the API sid loses its zero-padding (breaks every join against the DOM ln-prefixed sids)',
    reader: function (s) { return mutate(s, "'ln' + num.padStart(3, '0')", "'ln' + num"); } },
  { what: 'the whole statusText comparator dropped (an empty API statusName and a punctuation-only difference both go unflagged)',
    reader: function (s) { return mutate(s, "var as = nvVendor(a.statusText || '').replace(/[^A-Z0-9]+/g, ' ').trim(); if (!as || nvVendor(d.statusText || '').replace(/[^A-Z0-9]+/g, ' ').trim().indexOf(as) === -1) fields.push('statusText');", ''); } },
  { what: 'the empty-needle guard dropped from the statusText comparator (an empty API statusName vacuously matches instead of being flagged)',
    reader: function (s) { return mutate(s, 'if (!as || ', 'if ('); } },
  { what: 'the give-up warning threshold disabled on the rejected-fetch path (a persistent failure never announces that it gave up)',
    reader: function (s) { return mutate(s, "PO_TRIES[woNum] >= PO_MAX_TRIES) console.warn('[BWN PO] api read gave up for this page load', woNum);   // rejected-fetch path", "PO_TRIES[woNum] >= 999) console.warn('[BWN PO] api read gave up for this page load', woNum);   // rejected-fetch path"); } },
  { what: 'the domBySid join filter loosened back to a bare ln-prefix check (a non-digit collision suffix leaks into the join instead of being skipped)',
    reader: function (s) { return mutate(s, "/^ln\\d{2,4}(-\\d+)?$/.test(r.sid)", "r.sid.indexOf('ln') === 0"); } },
  { what: 'the give-up warning threshold disabled on the schema-drift path (a persistent non-array payload never announces that it gave up)',
    reader: function (s) { return mutate(s, "PO_TRIES[woNum] >= PO_MAX_TRIES) console.warn('[BWN PO] api read gave up for this page load', woNum); return; }   // schema drift = unknown, NEVER empty; schema-drift path", "PO_TRIES[woNum] >= 999) console.warn('[BWN PO] api read gave up for this page load', woNum); return; }   // schema drift = unknown, NEVER empty; schema-drift path"); } },
  { what: 'the digit-suffix collision group dropped from the join regex (a valid ln005-2-style collision sid can no longer join)',
    reader: function (s) { return mutate(s, "(-\\d+)?$/.test(r.sid)", "$/.test(r.sid)"); } },
  { what: 'the API-side unjoinedApiSids filter dropped (a non-digit-label API sid, like a null-number or non-numeric-id collision suffix, gets published unfiltered)',
    reader: function (s) { return mutate(s, "if (/^ln\\d{2,4}(-\\d+)?$/.test(sid)) unjoinedApiSids.push(sid);", "unjoinedApiSids.push(sid);"); } },
  { what: 'the classified warn collapsed back onto the server message slice (a transport failure prints text, never its class + code)',
    reader: function (s) { return mutate(s, "err && err.bwnKind ? (err.bwnKind", "false ? (err.bwnKind"); } },
  { what: "a 'partial' envelope accepted as a clean read (degraded rows would feed the parity cache as a success)",
    reader: function (s) { return mutate(s, "if (env.kind !== 'ok') { var fail", "if (env.kind !== 'ok' && env.kind !== 'partial') { var fail"); } }
];

// The query-shape pin, driven directly (not via the vm-sliced reader) with synthetic query text.
var QUERY_MUTATIONS = [
  { what: 'a nested workOrder { purchaseOrders } document fails the pin',
    query: 'query X($n: Int!) { workOrder(number: $n) { purchaseOrders { id number } } }' },
  { what: 'purchaseOrders(jobId: in place of workOrderNumber: fails the pin',
    query: mutate('query BwnWOPOs($n: Int!) { purchaseOrders(workOrderNumber: $n) { id } }', 'workOrderNumber:', 'jobId:') }
];

function main() {
  console.log('\n-- source-level pins, over the REAL shipped bytes --');
  A.ok('the shipped state.pos assignment is untouched by the shadow read (exactly one "var pos = readPOs();")',
    countOccurrences(coreFull, 'var pos = readPOs();') === 1,
    'got ' + countOccurrences(coreFull, 'var pos = readPOs();'));
  A.ok('poParityTick() is fired from exactly one guarded call site',
    countOccurrences(coreFull, 'try { poParityTick(); } catch (e) { }') === 1,
    'got ' + countOccurrences(coreFull, 'try { poParityTick(); } catch (e) { }'));
  // The guarded-site count alone would still pass with a second, UNGUARDED poParityTick() planted
  // elsewhere (post-edit review experiment E3) - so pin the total outside the block to one.
  A.ok('and no unguarded poParityTick( call exists anywhere outside the block',
    countOccurrences(OUTSIDE_READER, 'poParityTick(') === 1,
    'got ' + countOccurrences(OUTSIDE_READER, 'poParityTick(') + ' occurrences outside the block');
  ['readPOsApi(', 'poFromApi(', 'PO_CACHE', 'poParityLog('].forEach(function (needle) {
    A.ok('the shadow read is hermetic: ' + JSON.stringify(needle) + ' never appears outside the sliced block',
      countOccurrences(OUTSIDE_READER, needle) === 0,
      'got ' + countOccurrences(OUTSIDE_READER, needle) + ' occurrences outside the block');
  });
  A.ok('woId() identifies the WO from the URL digits segment, never a jobId',
    coreFull.indexOf('location.pathname.match(/work-orders\\/(\\d+)/)') !== -1);
  A.ok('@description names the purchase-order read', coreFull.indexOf('purchase-order reads') !== -1);
  A.ok('the sid-publish regex literal appears exactly twice in the sliced reader (DOM side + API side)',
    countOccurrences(S_READER, '/^ln\\d{2,4}(-\\d+)?$/.test(') === 2,
    'got ' + countOccurrences(S_READER, '/^ln\\d{2,4}(-\\d+)?$/.test('));

  console.log('\n-- the shipped PO API route --');
  return runCases(S_READER).then(function (results) {
    results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

    QUERY_MUTATIONS.forEach(function (m) {
      A.ok('CAUGHT: ' + m.what, checkQueryShape(m.query).length > 0, 'query pin did not fire on: ' + m.query);
    });

    console.log('\n-- negative controls: each must turn the cases above red --');
    A.ok('READER_MUTATIONS count matches the header claim (21)', READER_MUTATIONS.length === 21, 'got ' + READER_MUTATIONS.length);
    A.ok('QUERY_MUTATIONS count matches the header claim (2)', QUERY_MUTATIONS.length === 2, 'got ' + QUERY_MUTATIONS.length);
    return READER_MUTATIONS.reduce(function (chain, m) {
      return chain.then(function () {
        var reader = m.reader(S_READER);
        return runCases(reader).then(function (rs) {
          var reds = rs.filter(function (r) { return !r.ok; });
          A.ok('CAUGHT: ' + m.what, reds.length > 0,
            reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
        });
      });
    }, Promise.resolve());
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
