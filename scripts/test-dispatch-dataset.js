// test-dispatch-dataset.js - the In-House Dispatch Report feed producer.
//
// Slices dispatchDatasetRows out of the SHIPPED bwn-suite-core.user.js bytes and runs it in a
// vm against a fixture store shaped exactly like apiScanAll writes each heatStore row. Proves:
//   - the heat-record -> dispatch wire-row mapping (wo->woNumber, tracking->tracking, prio->
//     priority, assignee->coordinator, dneAmt->dne, plus status/client/city/state passthrough);
//   - CITY + STATE ride the row - they are what the report's coverage rule keys on, and were the
//     fields the heat scan fetched (address{city state}) but never carried until this feed;
//   - vendorsKnown gates `vendors`: emitted (even as '') ONLY when the column was read, so the
//     report never mistakes an unread vendor field for "no vendor" and offer-buckets a dispatched job;
//   - a GUID / "(unresolved member)" assignee is NEVER sent as a coordinator;
//   - a row with no woNumber AND no tracking is dropped (nothing the report could key a job on);
//   - the row cap.
// Mutations revert each guarantee and assert the harness goes red. Nothing here proves the browser
// scan fires or the connector POST lands - that is the live gate (a real __bwnDispatchSyncNow run).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dispatch-dataset.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

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
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 60)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 60)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var core = readLF(path.join(__dirname, '..', 'bwn-suite-core.user.js'));
var SRC = slice(core, '    var DISPATCH_DATASET_MAX = 8000;', '    // END dispatchDatasetRows', 'dispatchDatasetRows');

function build(src) {
  var ctx = vm.createContext({ console: console });
  vm.runInContext(src + '\nthis.dispatchDatasetRows = dispatchDatasetRows; this.DISPATCH_DATASET_MAX = DISPATCH_DATASET_MAX;', ctx);
  return ctx;
}
var env = build(SRC);
var dispatchDatasetRows = env.dispatchDatasetRows;

// A fixture record with the fields apiScanAll writes into heatStore (the shared + API-only block):
// vendorsKnown true with a real vendor list, city/state present, dneAmt in DOLLARS.
function rec(over) {
  return Object.assign({
    id: '386559', wo: '386559', tracking: '1286108', status: 'Pending Dispatch', prio: 'STANDARD-2',
    client: 'Best Buy', assignee: 'Michelle Black', city: 'Baldwin', state: 'NY',
    vendors: 'Broadway National Maintenance LLC', vendorsKnown: true, dneAmt: 750
  }, over || {});
}
function store(recs) { var s = {}; recs.forEach(function (r, i) { s['/work-orders/' + (r.wo || ('x' + i))] = r; }); return s; }

// ---- mapping + city/state + passthrough --------------------------------------------------
var w = dispatchDatasetRows(store([rec()]))[0];
A.eq('woNumber = wo', w.woNumber, '386559');
A.eq('tracking carried', w.tracking, '1286108');
A.eq('status', w.status, 'Pending Dispatch');
A.eq('priority = prio', w.priority, 'STANDARD-2');
A.eq('client', w.client, 'Best Buy');
A.eq('coordinator = assignee', w.coordinator, 'Michelle Black');
A.eq('city carried (coverage key)', w.city, 'Baldwin');
A.eq('state carried (coverage key)', w.state, 'NY');
A.eq('vendors carried when known', w.vendors, 'Broadway National Maintenance LLC');
A.eq('dne = dneAmt (already dollars)', w.dne, 750);

// ---- vendorsKnown gate -------------------------------------------------------------------
A.ok('vendors OMITTED when the column was not read', !('vendors' in dispatchDatasetRows(store([rec({ vendorsKnown: false, vendors: '' })]))[0]));
A.eq('vendors sent as "" when read but empty (an OFFER candidate)', dispatchDatasetRows(store([rec({ vendorsKnown: true, vendors: '' })]))[0].vendors, '');

// ---- coordinator skips -------------------------------------------------------------------
A.ok('"(unresolved member)" is NOT a coordinator', !('coordinator' in dispatchDatasetRows(store([rec({ assignee: '(unresolved member)' })]))[0]));
A.ok('empty assignee omits coordinator', !('coordinator' in dispatchDatasetRows(store([rec({ assignee: '' })]))[0]));

// ---- empty optional fields omitted -------------------------------------------------------
A.ok('empty city omitted', !('city' in dispatchDatasetRows(store([rec({ city: '' })]))[0]));
A.ok('empty state omitted', !('state' in dispatchDatasetRows(store([rec({ state: '' })]))[0]));

// ---- identity drops ----------------------------------------------------------------------
A.eq('row with neither woNumber nor tracking is dropped', dispatchDatasetRows(store([rec({ wo: '', tracking: '' })])).length, 0);
A.eq('a record with no id is skipped', dispatchDatasetRows({ '/x': { wo: '1', tracking: '2' } }).length, 0);

// ---- row cap -----------------------------------------------------------------------------
var many = {};
for (var i = 0; i < env.DISPATCH_DATASET_MAX + 500; i++) many['/work-orders/' + (500000 + i)] = rec({ id: String(500000 + i), wo: String(500000 + i), tracking: String(9000000 + i) });
A.eq('row cap enforced at DISPATCH_DATASET_MAX', dispatchDatasetRows(many).length, env.DISPATCH_DATASET_MAX);

// ---- negative controls: revert a guarantee, assert red -----------------------------------
var g1 = build(mutate(SRC, "if (r.assignee && r.assignee !== '(unresolved member)') row.coordinator = r.assignee;", "row.coordinator = r.assignee;"));
A.ok('[neg] without the guard, "(unresolved member)" leaks as coordinator',
  g1.dispatchDatasetRows(store([rec({ assignee: '(unresolved member)' })]))[0].coordinator === '(unresolved member)');

var g2 = build(mutate(SRC, "if (!row.woNumber && !row.tracking) continue;", ""));
A.eq('[neg] without the identity check, an id-less-key row is not dropped',
  g2.dispatchDatasetRows(store([rec({ wo: '', tracking: '' })])).length, 1);

var g3 = build(mutate(SRC, "if (r.vendorsKnown) row.vendors = r.vendors || '';", "row.vendors = r.vendors || '';"));
A.ok('[neg] without the vendorsKnown gate, an unread vendor field leaks as ""',
  'vendors' in g3.dispatchDatasetRows(store([rec({ vendorsKnown: false, vendors: '' })]))[0]);

A.finish();
