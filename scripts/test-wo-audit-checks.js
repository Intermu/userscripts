// test-wo-audit-checks.js - node harness for the redesign-added audit checks.
//
// Slices the PURE `BWN AUDIT CHECKS` block out of the .user.js and runs the real shipped bytes,
// injecting the one external it uses (_stripHtml). Covers the cancellation note scan, the
// flag->category map, and applyChecks gating (including the safe "missing key = enabled" default,
// per-category mutation controls, and the unknown-flag-never-dropped guarantee).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-checks.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');

function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf('// ===== BWN AUDIT CHECKS START');
  var b = t.indexOf('// ===== BWN AUDIT CHECKS END');
  if (a === -1 || b === -1) throw new Error('BWN AUDIT CHECKS markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = extractSection();
function _stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

var T = (new Function('_stripHtml',
  SECTION + '\n;return { cancelScan: cancelScan, flagCatKey: flagCatKey, applyChecks: applyChecks,' +
  ' woaDefaultChecks: woaDefaultChecks, WOA_CHECKS: WOA_CHECKS };'
))(_stripHtml);

function note(txt) { return { content: txt, createdDate: '2026-09-01T00:00:00Z' }; }
console.log('WO Audit checks (redesign) - ' + path.basename(SRC));

// 1. cancellation scan -----------------------------------------------------------------------
['cancelled by store', 'Work order cancellation received', 'tech had no access to site',
 'NO-SHOW - customer not present', 'customer refused service', 'unable to complete, site closed',
 'do not service this location'].forEach(function (t) {
  A.ok('cancel language matches: "' + t + '"', T.cancelScan([note(t)]) === true);
});
['tech completed repair', 'parts ordered, ETA Friday', 'awaiting client approval',
 'scheduled for next week'].forEach(function (t) {
  A.ok('benign note does NOT match: "' + t + '"', T.cancelScan([note(t)]) === false);
});
A.ok('empty note list -> false', T.cancelScan([]) === false);
A.ok('null notes -> false', T.cancelScan(null) === false);
A.ok('strips HTML before matching', T.cancelScan([note('<p>job <b>cancelled</b> today</p>')]) === true);
// only the newest 4 are scanned - a cancel buried at index 5 is treated as stale/resolved
A.ok('scans newest 4 only (index 5 cancel ignored)',
  T.cancelScan([note('ok'), note('ok'), note('ok'), note('ok'), note('ok'), note('cancelled')]) === false);
A.ok('cancel at index 3 is still seen',
  T.cancelScan([note('ok'), note('ok'), note('ok'), note('cancelled')]) === true);

// 2. flag -> category map --------------------------------------------------------------------
var MAP = { 'OVERDUE 5d': 'aged', 'STALE 12d': 'aged', 'NO NOTES': 'notes', 'NEG GP': 'pricing',
  'LOW GP 8%': 'pricing', 'NTE>DNE': 'pricing', 'NO VENDOR': 'vendor', 'UNSCHEDULED': 'scheduling' };
Object.keys(MAP).forEach(function (fl) {
  A.eq('flagCatKey("' + fl + '")', T.flagCatKey(fl), MAP[fl]);
});
A.ok('unknown flag -> null (kept, never dropped)', T.flagCatKey('SOMETHING NEW') === null);

// 3. applyChecks gating ----------------------------------------------------------------------
var ALL = ['OVERDUE 5d', 'NO NOTES', 'NEG GP', 'NO VENDOR', 'UNSCHEDULED'];
// empty cfg = every category enabled (safe default that reproduces today's full output)
A.eq('empty cfg keeps every header flag', T.applyChecks(ALL, [], {}).join(','), ALL.join(','));
A.ok('empty cfg appends CANCEL? when a note trips the scan',
  T.applyChecks([], [note('cancelled')], {}).join(',') === 'CANCEL?');
// per-category mutation controls: turning one off drops exactly its flags
A.ok('aged off drops OVERDUE', T.applyChecks(ALL, [], { aged: false }).indexOf('OVERDUE 5d') === -1);
A.ok('aged off keeps the others', T.applyChecks(ALL, [], { aged: false }).indexOf('NO VENDOR') !== -1);
A.ok('pricing off drops NEG GP', T.applyChecks(ALL, [], { pricing: false }).indexOf('NEG GP') === -1);
A.ok('vendor off drops NO VENDOR', T.applyChecks(ALL, [], { vendor: false }).indexOf('NO VENDOR') === -1);
A.ok('scheduling off drops UNSCHEDULED', T.applyChecks(ALL, [], { scheduling: false }).indexOf('UNSCHEDULED') === -1);
A.ok('notes off drops NO NOTES', T.applyChecks(ALL, [], { notes: false }).indexOf('NO NOTES') === -1);
// cancel toggle
A.ok('cancel on + cancel note -> CANCEL? appended',
  T.applyChecks([], [note('no access')], { cancel: true }).indexOf('CANCEL?') !== -1);
A.ok('cancel OFF suppresses CANCEL? even with a cancel note',
  T.applyChecks([], [note('no access')], { cancel: false }).indexOf('CANCEL?') === -1);
// unknown flag survives any gating
A.ok('unknown flag is never dropped', T.applyChecks(['MYSTERY'], [], { aged: false, pricing: false }).join(',') === 'MYSTERY');
// healthy baseline: no header flags + benign note -> nothing
A.ok('healthy baseline trips nothing', T.applyChecks([], [note('all good')], T.woaDefaultChecks()).length === 0);

// 4. defaults --------------------------------------------------------------------------------
var d = T.woaDefaultChecks();
T.WOA_CHECKS.forEach(function (k) { A.ok('default check ON: ' + k, d[k] === true); });
A.ok('repeat-dispatch default OFF (no data source yet)', d.repeat === false);

A.finish();
