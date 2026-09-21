// test-wo-audit-dashboard.js - node harness for the Dashboard / Audit Rules sheets + column mapping
// (0.17.0, Commit 2).
//
// Two independent slices, both run over the real shipped bytes:
//   BWN WO-AUDIT DASHBOARD  - the pure aggregation + sheet builders (dashboardCounts / dashRollup /
//                             dashTop20 / buildDashboardAoa / buildAuditRulesAoa + RULE_CATALOG).
//   BWN WO-AUDIT MAP        - findCol / mapSheet header-alias detection, driven with a stubbed
//                             XLSX.utils.sheet_to_json so no real spreadsheet library is needed.
//
// Negative controls throughout: a rollup that ignores its key, a top-20 that does not cap, and the
// "Last Note Date" trap that must NOT be mistaken for the note-content column.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-dashboard.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');
function slice(t, startMark, endMark) {
  var a = t.indexOf(startMark);
  var b = t.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error(startMark + ' / ' + endMark + ' markers not found in ' + SRC);
  if (t.indexOf(startMark, a + 1) !== -1) throw new Error('non-unique marker: ' + startMark);
  return t.slice(a, b);
}
var TEXT = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var D = (new Function(
  slice(TEXT, '// ===== BWN WO-AUDIT DASHBOARD START', '// ===== BWN WO-AUDIT DASHBOARD END') +
  '\n;return { dashboardCounts: dashboardCounts, dashRollup: dashRollup, dashTop20: dashTop20,' +
  ' buildDashboardAoa: buildDashboardAoa, buildAuditRulesAoa: buildAuditRulesAoa,' +
  ' RULE_CATALOG: RULE_CATALOG, DASH_INTERPRETATION: DASH_INTERPRETATION };'
))();

// actionRow-shaped fixtures (only the fields the dashboard reads).
function R(o) {
  var r = { priorityKey: 'P2', priority: 'P2 – This Week', bucket: 'Vendor Scheduling', owner: 'Jane', fm: 'Bill', riskFlags: '', managerReviewBool: false, dueRank: 2, sourceRow: 2, wo: 'W1', actionDue: 'Next 2 business days', primaryIssue: 'x' };
  for (var k in (o || {})) r[k] = o[k];
  return r;
}
var rows = [
  R({ priorityKey: 'P0', priority: 'P0 – Immediate', bucket: 'Vendor Scheduling', owner: 'Jane', fm: 'Bill', riskFlags: 'OVERDUE ECD | NO VENDOR', managerReviewBool: true, dueRank: 0, sourceRow: 5, wo: 'W-P0' }),
  R({ priorityKey: 'P1', priority: 'P1 – Today', bucket: 'Material Delay', owner: 'Jane', fm: 'Bill', riskFlags: 'OVERDUE ECD', managerReviewBool: true, dueRank: 0, sourceRow: 9, wo: 'W-P1' }),
  R({ priorityKey: 'P2', priority: 'P2 – This Week', bucket: 'Client Approval', owner: 'Mo', fm: 'Pat', riskFlags: '', managerReviewBool: false, dueRank: 2, sourceRow: 3, wo: 'W-P2' }),
  R({ priorityKey: 'MON', priority: 'Monitor', bucket: 'Monitor', owner: 'Mo', fm: 'Pat', riskFlags: '', managerReviewBool: false, dueRank: 4, sourceRow: 7, wo: 'W-MON' })
];

// ---- 1. counts -------------------------------------------------------------------------------
var c = D.dashboardCounts(rows, 4);
A.eq('total', c.total, 4);
A.eq('actionable', c.actionable, 3);
A.eq('monitor', c.monitor, 1);
A.eq('p0', c.p0, 1); A.eq('p1', c.p1, 1); A.eq('p2', c.p2, 1);
A.eq('overdue ECD counted from risk flags', c.overdueEcd, 2);
A.eq('manager review counted', c.managerReview, 2);
A.eq('bucket count: Vendor Scheduling', c.byBucket['Vendor Scheduling'], 1);
A.eq('bucket count: Material Delay', c.byBucket['Material Delay'], 1);
A.eq('bucket count: Closeout (none)', c.byBucket['Closeout / Cost Review'], 0);

// ---- 2. rollups sorted by count desc then key asc --------------------------------------------
var byOwner = D.dashRollup(rows, function (r) { return r.owner; });
A.eq('owner rollup top is Jane (2)', byOwner[0], { key: 'Jane', count: 2 });
A.eq('owner rollup has Mo (2)', byOwner[1], { key: 'Mo', count: 2 });   // tie -> key asc (Jane before Mo)
var blank = D.dashRollup([R({ fm: '' }), R({ fm: '' })], function (r) { return r.fm; });
A.eq('blank key folds to (none)', blank[0], { key: '(none)', count: 2 });
// NEGATIVE control: a rollup that ignored its key would collapse everything into one bucket.
A.ok('control: rollup actually splits on the key', D.dashRollup(rows, function (r) { return r.owner; }).length === 2);

// ---- 3. top-20 sort + cap --------------------------------------------------------------------
var t20 = D.dashTop20(rows);
A.eq('top20 keeps only manager-review rows', t20.length, 2);
A.eq('top20 sorts P0 before P1', t20[0].wo, 'W-P0');
var many = [];
for (var i = 0; i < 25; i++) many.push(R({ managerReviewBool: true, priorityKey: 'P2', sourceRow: i + 1, wo: 'W' + i }));
var capped = D.dashTop20(many);
A.eq('top20 caps at 20', capped.length, 20);
A.eq('top20 orders by source row within a tier', capped[0].wo, 'W0');

// ---- 4. Dashboard sheet aoa ------------------------------------------------------------------
var daoa = D.buildDashboardAoa(rows, { sheetTitle: 'WO Audit Dashboard - 2026.09.21', runStamp: '2026-09-21 10:00', sourceSheet: 'Sheet1', mode: 'hybrid', includeMonitor: false, total: 4 });
var flat = daoa.map(function (r) { return (r[0] == null ? '' : r[0]); });
A.ok('dashboard has the title', flat[0].indexOf('WO Audit Dashboard') === 0, flat[0]);
A.ok('dashboard has the priority legend', flat.indexOf('PRIORITY LEGEND') !== -1);
A.ok('dashboard has P0 legend row', flat.some(function (x) { return /^P0 – Immediate/.test(x); }));
A.ok('dashboard has the run summary', flat.indexOf('RUN SUMMARY') !== -1);
A.ok('dashboard has Total work orders reviewed', flat.indexOf('Total work orders reviewed') !== -1);
A.ok('dashboard has the bucket rollup', flat.indexOf('BY ACTION BUCKET') !== -1);
A.ok('dashboard has the owner rollup', flat.indexOf('BY ACTION OWNER') !== -1);
A.ok('dashboard has the FM rollup', flat.indexOf('BY FM') !== -1);
A.ok('dashboard has the top-20 section', flat.indexOf('TOP 20 MANAGER REVIEW') !== -1);
// the Total value sits in column B of its row
var totRow = daoa.filter(function (r) { return r[0] === 'Total work orders reviewed'; })[0];
A.eq('total value is in column B', totRow[1], 4);

// ---- 5. Audit Rules sheet aoa ----------------------------------------------------------------
var raoa = D.buildAuditRulesAoa({ sheetTitle: 'Audit Rules - 2026.09.21', runStamp: '2026-09-21 10:00', mode: 'hybrid', includeMonitor: true, checks: 'aged, notes', clientDays: 2, sourceSheet: 'Sheet1', woCol: 'WO #', noteCol: 'Notes' });
var rflat = raoa.map(function (r) { return String(r[0] == null ? '' : r[0]); });
var ids = ['ECD_OVERDUE', 'VENDOR_SCHEDULING', 'PROPOSAL_OR_QUOTE', 'CLIENT_APPROVAL', 'PO_RELEASE', 'MATERIALS', 'ON_SITE_OR_SCHEDULED_FOLLOWUP', 'CLOSEOUT', 'STALE_UPDATE', 'DATA_QUALITY', 'SAFETY_OR_CRITICAL_SCOPE'];
ids.forEach(function (id) { A.ok('rules sheet documents ' + id, rflat.indexOf(id) !== -1); });
A.eq('rule catalog has 11 rules', D.RULE_CATALOG.length, 11);
A.ok('rules sheet carries the interpretation statement', raoa.some(function (r) { return String(r[0]).indexOf('rules-based operational triage tool') !== -1; }));
A.ok('rules sheet has the run configuration', rflat.indexOf('RUN CONFIGURATION') !== -1);
A.ok('run config records the mode', raoa.some(function (r) { return r[0] === 'Output mode' && r[1] === 'hybrid'; }));
A.ok('run config records include-monitor', raoa.some(function (r) { return r[0] === 'Include Monitor items' && r[1] === 'yes'; }));
A.ok('run config records the WO column', raoa.some(function (r) { return r[0] === 'WO # column' && r[1] === 'WO #'; }));

// ---- 6. mapSheet header-alias detection (stubbed XLSX) ---------------------------------------
var HEADER = ['WO #', 'Status', 'Location', 'City', 'State', 'Days', 'Assigned To', 'FM', 'Priority', 'Trades', 'Vendors', 'Scope Of Work', 'Expected Completion Date', 'Next Onsite Date', 'Last Note Date', 'Status hrs.', 'Source PO', 'Total Vendor NTE', 'Type', 'Notes', 'Audit Flags'];
var AOA = [HEADER, ['386564', 'Scheduled', 'Store 1', 'Dallas', 'TX', '40', 'Jane', 'Bill', 'P1', 'Electrical', 'Acme', 'fix light', '2026-10-02', '2026-09-20', '2026-09-10', '55', 'PO-9', '1200', 'Reactive', 'on the way', '']];
var XLSXStub = { utils: { sheet_to_json: function () { return AOA; } } };
var M = (new Function('XLSX',
  slice(TEXT, '// ===== BWN WO-AUDIT MAP START', '// ===== BWN WO-AUDIT MAP END') +
  '\n;return { mapSheet: mapSheet };'
))(XLSXStub);
var map = M.mapSheet({});
A.eq('key col', map.key, 0);
A.eq('status col', map.status, 1);
A.eq('location col', map.location, 2);
A.eq('city col', map.city, 3);
A.eq('state col', map.state, 4);
A.eq('days col', map.days, 5);
A.eq('assigned col', map.assigned, 6);
A.eq('fm col', map.fm, 7);
A.eq('priority col', map.priority, 8);
A.eq('trade col', map.trade, 9);
A.eq('vendor col', map.vendor, 10);
A.eq('scope col', map.scope, 11);
A.eq('ecd col', map.ecd, 12);
A.eq('next-onsite col', map.nextOnsite, 13);
A.eq('last-note col', map.lastNote, 14);
A.eq('status-hours col', map.statusHours, 15);
A.eq('po col', map.po, 16);
A.eq('nte col', map.nte, 17);
A.eq('type col', map.type, 18);
A.eq('flag col', map.flag, 20);
// NEGATIVE control: the note-CONTENT column is "Notes" (19), NOT "Last Note Date" (14).
A.eq('note col is Notes, not Last Note Date', map.note, 19);
A.ok('last-note date is distinct from the note-content column', map.lastNote !== map.note);
// A workbook missing an optional field records -1 (a gap), not a wrong guess.
var AOA2 = [['WO #', 'Status', 'Notes'], ['1', 'x', 'y']];
XLSXStub.utils.sheet_to_json = function () { return AOA2; };
var map2 = M.mapSheet({});
A.eq('absent FM -> -1', map2.fm, -1);
A.eq('absent vendor -> -1', map2.vendor, -1);
A.eq('present WO # still found', map2.key, 0);

A.finish();
