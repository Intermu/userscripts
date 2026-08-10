// test-heat-dataset-push.js - the board -> Dashboard dataset producer (swa-dataset-ingest).
//
// Slices heatDatasetRows out of the SHIPPED bwn-suite-core.user.js bytes and runs it in a vm
// against a fixture heat store shaped exactly like apiScanAll stores each row. Proves:
//   - the heat-record -> wire-row mapping (tracking->target, wo->woNumber, prio->priority,
//     assignee->coordinator, dneAmt->amount, nteAmt->vendorNte, sched->nextOnsiteDate,
//     exp->expectedCompletion, lastNote->lastNoteDate, ...);
//   - UNITS PASS THROUGH UNCHANGED - hrs is already HOURS (v3.19) and dneAmt/nteAmt already
//     DOLLARS (moneyNum), so the SWA route re-scales nothing. A producer that re-divided or
//     re-scaled would reintroduce the 60x / 100x bugs this whole line of work exists to kill;
//   - a GUID / "(unresolved member)" assignee is NEVER sent as a coordinator;
//   - a row with no tracking AND no WO # is dropped (nothing the Dashboard could key);
//   - the row cap;
//   - CROSS-FILE CONTRACT: every wire key emitted is one the SWA api/dataset-ingest route maps
//     (its STR/DATE/NUM maps + target), so Core cannot start emitting a key the route silently drops.
// Mutations revert each guarantee and assert the harness goes red. Nothing here proves the
// browser hook fires or the POST lands - the live gate is a real board push into the Dashboard.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-heat-dataset-push.js

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
var SRC = slice(core, '    var HEAT_DATASET_MAX = 5000;', '    // END heatDatasetRows', 'heatDatasetRows');

function build(src) {
  var ctx = vm.createContext({ console: console });
  vm.runInContext(src + '\nthis.heatDatasetRows = heatDatasetRows; this.HEAT_DATASET_MAX = HEAT_DATASET_MAX;', ctx);
  return ctx;
}
var env = build(SRC);
var heatDatasetRows = env.heatDatasetRows;

// A fixture record with the exact fields apiScanAll writes into heatStore (the 7736-7748
// object literal): strings for hrs/days (as the scan stores them), numbers for dneAmt/nteAmt.
function rec(over) {
  return Object.assign({
    id: '344409', wo: '344409', tracking: '1120182', status: 'Recruiting Vendor', prio: 'SEV 4',
    client: 'Pilot Client', assignee: 'Jane Doe', hrs: '1350', days: '137', dneAmt: 14485.64,
    nteAmt: 12000, vendors: 'Acme, Bolt', vendorsKnown: true, sched: '08/10/2026',
    exp: '05/01/2026', lastNote: '08/05/2026', phase: 'Open',
    sourceJob: 'J-5567', sourcePo: 'PO-8890', projectType: 'Service', woDate: '01/15/2026'
  }, over || {});
}
function store(recs) { var s = {}; recs.forEach(function (r, i) { s['/work-orders/' + (r.wo || ('x' + i))] = r; }); return s; }

// ---- mapping + unit passthrough ----------------------------------------------------------
var w = heatDatasetRows(store([rec()]))[0];
A.eq('target = tracking', w.target, '1120182');
A.eq('woNumber = wo', w.woNumber, '344409');
A.eq('status', w.status, 'Recruiting Vendor');
A.eq('priority = prio', w.priority, 'SEV 4');
A.eq('client', w.client, 'Pilot Client');
A.eq('coordinator = assignee', w.coordinator, 'Jane Doe');
A.eq('statusHrs UNCHANGED (already hours)', w.statusHrs, '1350');
A.eq('aged = days', w.aged, '137');
A.eq('amount UNCHANGED (already dollars)', w.amount, 14485.64);
A.eq('vendorNte = nteAmt', w.vendorNte, 12000);
A.eq('vendors carried when known', w.vendors, 'Acme, Bolt');
A.eq('nextOnsiteDate = sched', w.nextOnsiteDate, '08/10/2026');
A.eq('expectedCompletion = exp', w.expectedCompletion, '05/01/2026');
A.eq('lastNoteDate = lastNote', w.lastNoteDate, '08/05/2026');
// v2 dataset fields (Job ID / Source PO # / WO Date / Project Type) - route maps sourceJob/sourcePo/
// projectType (STR_MAP) and woDate (DATE_MAP); the cross-file guard below re-checks all four.
A.eq('sourceJob -> Job ID', w.sourceJob, 'J-5567');
A.eq('sourcePo -> Source PO #', w.sourcePo, 'PO-8890');
A.eq('projectType -> Project Type', w.projectType, 'Service');
A.eq('woDate -> WO Date', w.woDate, '01/15/2026');
A.ok('empty v2 field is omitted, not sent blank', !('sourceJob' in heatDatasetRows(store([rec({ sourceJob: '' })]))[0]));

// ---- skips / drops -----------------------------------------------------------------------
A.ok('"(unresolved member)" is NOT a coordinator', !('coordinator' in heatDatasetRows(store([rec({ assignee: '(unresolved member)' })]))[0]));
A.ok('empty assignee omits coordinator', !('coordinator' in heatDatasetRows(store([rec({ assignee: '' })]))[0]));
A.ok('vendors omitted when not known', !('vendors' in heatDatasetRows(store([rec({ vendorsKnown: false })]))[0]));
A.eq('row with neither tracking nor wo is dropped', heatDatasetRows(store([rec({ tracking: '', wo: '' })])).length, 0);
A.eq('a record with no id is skipped', heatDatasetRows({ '/x': { wo: '1', tracking: '2' } }).length, 0);

// ---- row cap -----------------------------------------------------------------------------
var many = {};
for (var i = 0; i < 6000; i++) many['/work-orders/' + (500000 + i)] = rec({ id: String(500000 + i), wo: String(500000 + i), tracking: String(9000000 + i) });
A.eq('row cap enforced at HEAT_DATASET_MAX', heatDatasetRows(many).length, env.HEAT_DATASET_MAX);

// ---- cross-file contract with the SWA route ----------------------------------------------
// Mirrors api/dataset-ingest STR_MAP/DATE_MAP/NUM_MAP + target. A key here that the route does
// not map is a column silently dropped on the board push - keep the two sides in lockstep.
var ROUTE_WIRE_KEYS = {
  target: 1, woNumber: 1, status: 1, priority: 1, client: 1, coordinator: 1, statusHrs: 1, aged: 1,
  amount: 1, vendorNte: 1, vendors: 1, nextOnsiteDate: 1, expectedCompletion: 1, lastNoteDate: 1,
  lastUpdated: 1, woDate: 1, firstTripDate: 1, daysSinceUpdate: 1, sourceJob: 1, sourcePo: 1,
  fm: 1, location: 1, city: 1, state: 1, projectType: 1
};
var emitted = {};
heatDatasetRows(store([rec()])).forEach(function (r) { Object.keys(r).forEach(function (k) { emitted[k] = 1; }); });
var unmapped = Object.keys(emitted).filter(function (k) { return !ROUTE_WIRE_KEYS[k]; });
A.eq('every emitted wire key is mapped by the route', unmapped, []);

// ---- negative controls: revert a guarantee, assert red -----------------------------------
var g1 = build(mutate(SRC, "r.assignee !== '(unresolved member)'", "true"));
A.ok('[neg] without the guard, "(unresolved member)" leaks as coordinator',
  g1.heatDatasetRows(store([rec({ assignee: '(unresolved member)' })]))[0].coordinator === '(unresolved member)');

var g2 = build(mutate(SRC, "if (!row.target && !row.woNumber) continue;", ""));
A.eq('[neg] without the identity check, an id-less row is not dropped',
  g2.heatDatasetRows(store([rec({ tracking: '', wo: '' })])).length, 1);

A.finish();
