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
//     rejected fetch are UNKNOWN (null), NEVER empty; a rejection logs exactly one warning that
//     names the WO but never a row value.
//   - poFromApi() classifies done/poStatus/costOpen off phase/statusName alone, verified against
//     all 27 live Umbrava PO statuses, with Closed as an INTENTIONAL divergence from the DOM regex.
//   - two POs sharing a number get distinct sids (the row id breaks the tie).
//   - the parity log joins on sid, reports mismatches by FIELD NAME only, and never leaks a vendor
//     string, a date, or an amount into its (redacted) summary.
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
  var env = { fetches: [], refreshes: 0, wo: null, domRows: [], domNodes: [], infos: [], warns: [], win: {} };
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
    document: { querySelectorAll: function () { return env.domNodes; } },
    window: env.win,
    bwnGql: function (query, variables) {
      var rec = { query: query, vars: variables };
      rec.p = new Promise(function (res, rej) { rec.resolve = res; rec.reject = rej; });
      env.fetches.push(rec);
      return rec.p;
    }
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
    // Three DOM rows: ln001 will match an API row with a deliberate amount mismatch; the
    // guid-fallback row is excluded from the join entirely (ln-prefixed sids only); ln002 is
    // ln-prefixed but has no API counterpart, so it must count as unjoined.
    e.wo = '100005';
    e.domRows = [
      makeDomRow({ vendor: 'Vendor A', num: '1', sid: 'ln001', amount: 250, schedDate: '3/5/30', done: false, poStatus: '', costOpen: true }),
      makeDomRow({ vendor: 'Vendor C', num: '2', sid: 'v-guid-fallback', amount: 40, schedDate: undefined, done: false, poStatus: '', costOpen: true }),
      makeDomRow({ vendor: 'Vendor D', num: '3', sid: 'ln002', amount: 75, schedDate: '4/1/30', done: false, poStatus: '', costOpen: true })
    ];
    e.domNodes = [{ textContent: 'Vendor A $250.00' }, { textContent: 'Vendor C $40.00 $12.00' }];
    e.readPOsApi();   // kicks the fetch
    eq('one fetch fired for the parity WO', e.fetches.length, 5);
    // Deliberate amount mismatch against the DOM row above (250 DOM vs 300 API) on the same sid.
    // Noon UTC keeps the calendar day stable across the local timezone the harness runs under.
    e.fetches[4].resolve({ purchaseOrders: [
      makeRow({ id: 10, number: 1, statusId: -4, statusName: 'Scheduled', phase: 'Open', notToExceed: { amount: 30000, currency: 'USD', precision: 2 }, nextOnsiteDate: '2030-03-05T12:00:00Z' })
    ] });
    return tick();
  }).then(function () {
    e.poParityTick();
    var summary = e.win.__bwnPoParity;
    ok('parity summary was published', !!summary, JSON.stringify(summary));
    eq('parity joins the DOM and API rows on sid', summary.joined, 1);
    eq('an ln-prefixed DOM row with no API match counts as unjoined', summary.unjoinedDom, 1);
    eq('a deliberate amount mismatch is reported by FIELD NAME', summary.mismatches, [{ sid: 'ln001', fields: ['amount'] }]);
    eq('the multi-$ DOM row is counted', summary.domMultiAmount, 1);
    eq('the label-absent DOM row is counted', summary.domLabelAbsent, 1);
    var blob = JSON.stringify(summary);
    ok('the parity summary carries no vendor string', blob.indexOf('Vendor') === -1, blob);
    ok('the parity summary carries no amount', blob.indexOf('250') === -1 && blob.indexOf('300') === -1 && blob.indexOf('75') === -1, blob);
    ok('the parity summary carries no date string', blob.indexOf('3/5') === -1 && blob.indexOf('4/1') === -1, blob);

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
    reader: function (s) { return mutate(s, 'WorkComplete: 1, ', ''); } }
];

// The query-shape pin, driven directly (not via the vm-sliced reader) with synthetic query text.
var QUERY_MUTATIONS = [
  { what: 'a nested workOrder { purchaseOrders } document fails the pin',
    query: 'query X($n: Int!) { workOrder(number: $n) { purchaseOrders { id number } } }' },
  { what: 'purchaseOrders(jobId: in place of workOrderNumber: fails the pin',
    query: mutate('query BwnWOPOs($n: Int!) { purchaseOrders(workOrderNumber: $n) { id } }', 'workOrderNumber:', 'jobId:') }
];

function main() {
  console.log('\n-- the shipped PO API route --');
  return runCases(S_READER).then(function (results) {
    results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

    QUERY_MUTATIONS.forEach(function (m) {
      A.ok('CAUGHT: ' + m.what, checkQueryShape(m.query).length > 0, 'query pin did not fire on: ' + m.query);
    });

    console.log('\n-- negative controls: each must turn the cases above red --');
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
