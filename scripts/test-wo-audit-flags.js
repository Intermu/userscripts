// test-wo-audit-flags.js - node harness for the deterministic Audit Flags (0.8.0 overhaul).
//
// Slices the PURE `BWN AUDIT FLAGS` block out of the .user.js and runs the real shipped bytes,
// injecting _date + MS_DAY and a FIXED clock so note ages are asserted deterministically (never
// Date.now() - see [[fixture-clock-time-day-age]] / [[headless-harness-cannot-time]]). Every flag
// carries a mutation control (flip the field that triggers it -> the flag appears/vanishes) plus a
// "healthy" negative baseline that must trip NOTHING, so a rule that fires unconditionally is caught.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-flags.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');

function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf('// ===== BWN AUDIT FLAGS START');
  var b = t.indexOf('// ===== BWN AUDIT FLAGS END');
  if (a === -1 || b === -1) throw new Error('BWN AUDIT FLAGS markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = extractSection();
var MS_DAY = 86400000;
function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }

// Build the module from the sliced bytes, injecting the two externals it depends on.
var T = (new Function('MS_DAY', '_date',
  SECTION + '\n;return { computeFlags: computeFlags, moneyDollars: moneyDollars, gpPercent: gpPercent,' +
  ' GP_LOW_PCT: GP_LOW_PCT, STALE_DAYS: STALE_DAYS };'
))(MS_DAY, _date);

// Fixed clock so ages are exact.
var NOW = Date.parse('2026-08-19T12:00:00Z');
function noteDaysAgo(d) { return [{ createdDate: new Date(NOW - d * MS_DAY).toISOString() }]; }
function has(flags, prefix) { return flags.some(function (x) { return x.indexOf(prefix) === 0; }); }
function first(flags, prefix) { return flags.filter(function (x) { return x.indexOf(prefix) === 0; })[0]; }
// A header that trips NO flags: not overdue, 50% GP, NTE<DNE, has vendor, Open + scheduled.
function healthy() {
  return {
    phase: 'Open', remainingDays: 5, nextOnsiteDate: '2026-08-25',
    priority: { label: 'P3' },
    doNotExceed: { amount: 100000, precision: 2 },   // $1000
    totalNTE: { amount: 50000, precision: 2 },        // $500
    grossProfitInfo: { estimatedGrossProfitPercent: '0.5' },
    hasNonTerminatedPurchaseOrders: true,
    purchaseOrders: [{ id: 1 }]
  };
}
function flags(h, notes) { return T.computeFlags(h, notes === undefined ? noteDaysAgo(1) : notes, NOW); }

console.log('WO Audit deterministic flags (0.8.0) - ' + path.basename(SRC));

// 1. the negative baseline - a healthy WO must trip nothing (guards against always-on rules).
console.log('\n1. a healthy header trips no flags');
A.eq('healthy = []', flags(healthy()), []);

// 2. OVERDUE
console.log('\n2. OVERDUE off remainingDays<0');
(function () {
  var h = healthy(); h.remainingDays = -12;
  A.ok('fires on negative remainingDays', has(flags(h), 'OVERDUE'), JSON.stringify(flags(h)));
  A.eq('carries the day count', first(flags(h), 'OVERDUE'), 'OVERDUE 12d');
  h.remainingDays = 3;
  A.ok('mutation control: >=0 -> gone', !has(flags(h), 'OVERDUE'));
})();

// 3. GP (fraction x100; true beats estimated; null safe)
console.log('\n3. NEG / LOW GP off the string fraction');
(function () {
  var h = healthy();
  h.grossProfitInfo = { estimatedGrossProfitPercent: '-0.05' };
  A.ok('NEG GP on a negative fraction', has(flags(h), 'NEG GP'));
  h.grossProfitInfo = { estimatedGrossProfitPercent: '0.10' };
  A.ok('LOW GP under 15%', has(flags(h), 'LOW GP'));
  A.eq('LOW GP carries the rounded %', first(flags(h), 'LOW GP'), 'LOW GP 10%');
  h.grossProfitInfo = { estimatedGrossProfitPercent: '0.50' };
  A.ok('mutation control: 50% -> no GP flag', !has(flags(h), 'LOW GP') && !has(flags(h), 'NEG GP'));
  h.grossProfitInfo = { trueGrossProfitPercent: '0.02', estimatedGrossProfitPercent: '0.90' };
  A.ok('true GP wins over estimated (2% -> LOW)', has(flags(h), 'LOW GP'));
  h.grossProfitInfo = null;
  A.ok('null GP -> no flag, no crash', !has(flags(h), 'LOW GP') && !has(flags(h), 'NEG GP'));
  A.eq('gpPercent scales the fraction', T.gpPercent({ grossProfitInfo: { estimatedGrossProfitPercent: '0.734' } }), 73.4);
  A.eq('gpPercent null when absent', T.gpPercent({ grossProfitInfo: {} }), null);
})();

// 4. NTE>DNE (minor units + precision)
console.log('\n4. NTE>DNE and money scaling');
(function () {
  var h = healthy();
  h.totalNTE = { amount: 150000, precision: 2 };
  A.ok('NTE>DNE fires when vendor cost exceeds authorization', has(flags(h), 'NTE>DNE'));
  h.totalNTE = { amount: 90000, precision: 2 };
  A.ok('mutation control: NTE<DNE -> gone', !has(flags(h), 'NTE>DNE'));
  A.eq('moneyDollars minor units + precision', T.moneyDollars({ amount: 1448564, precision: 2 }), 14485.64);
  A.eq('moneyDollars default precision 2', T.moneyDollars({ amount: 1000 }), 10);
  A.eq('moneyDollars null on missing', T.moneyDollars(null), null);
})();

// 5. NO VENDOR (boolean signal, then PO-count fallback)
console.log('\n5. NO VENDOR');
(function () {
  var h = healthy(); h.hasNonTerminatedPurchaseOrders = false;
  A.ok('fires when no non-terminated PO', has(flags(h), 'NO VENDOR'));
  h.hasNonTerminatedPurchaseOrders = true;
  A.ok('mutation control: vendor present -> gone', !has(flags(h), 'NO VENDOR'));
  delete h.hasNonTerminatedPurchaseOrders; h.purchaseOrders = [];
  A.ok('fallback: empty POs -> NO VENDOR', has(flags(h), 'NO VENDOR'));
  h.purchaseOrders = [{ id: 1 }];
  A.ok('fallback: a PO present -> gone', !has(flags(h), 'NO VENDOR'));
})();

// 6. UNSCHEDULED (Open + no onsite date)
console.log('\n6. UNSCHEDULED');
(function () {
  var h = healthy(); h.phase = 'Open'; h.nextOnsiteDate = null;
  A.ok('Open with no onsite date', has(flags(h), 'UNSCHEDULED'));
  h.phase = 'WorkComplete';
  A.ok('mutation control: not Open -> gone', !has(flags(h), 'UNSCHEDULED'));
  h.phase = 'Open'; h.nextOnsiteDate = '2026-09-01';
  A.ok('scheduled -> gone', !has(flags(h), 'UNSCHEDULED'));
})();

// 7. STALE / NO NOTES on the INJECTED clock
console.log('\n7. STALE off the injected clock');
(function () {
  var h = healthy();
  A.ok('30d-old newest note -> STALE', has(flags(h, noteDaysAgo(30)), 'STALE'));
  A.eq('STALE carries the age', first(flags(h, noteDaysAgo(30)), 'STALE'), 'STALE 30d');
  A.ok('mutation control: 2d fresh -> gone', !has(flags(h, noteDaysAgo(2)), 'STALE'));
  A.ok('boundary: exactly 7d is NOT stale (>, not >=)', !has(flags(h, noteDaysAgo(7)), 'STALE'));
  A.ok('empty notes -> NO NOTES', has(flags(h, []), 'NO NOTES'));
  // The clock is injected: same inputs, a later `now` flips STALE - proves it is not Date.now().
  A.ok('t+0: 3d note not stale', !has(T.computeFlags(h, noteDaysAgo(3), NOW), 'STALE'));
  A.ok('t+10d: same note now stale', has(T.computeFlags(h, noteDaysAgo(3), NOW + 10 * MS_DAY), 'STALE'));
})();

// 8. absent inputs (unread is not empty), constants, and a fully-bad WO
console.log('\n8. absent-input safety, constants, multi-flag WO');
(function () {
  A.eq('null header -> [] (say nothing, not a clean bill)', T.computeFlags(null, noteDaysAgo(1), NOW), []);
  A.eq('undefined notes -> no NO NOTES, no crash', T.computeFlags(healthy(), undefined, NOW).indexOf('NO NOTES'), -1);
  A.eq('GP_LOW_PCT pinned', T.GP_LOW_PCT, 15);
  A.eq('STALE_DAYS pinned', T.STALE_DAYS, 7);
  var bad = {
    phase: 'Open', remainingDays: -40, nextOnsiteDate: null,
    doNotExceed: { amount: 100000, precision: 2 }, totalNTE: { amount: 120000, precision: 2 },
    grossProfitInfo: { estimatedGrossProfitPercent: '-0.1667' },
    hasNonTerminatedPurchaseOrders: false, purchaseOrders: []
  };
  var ff = T.computeFlags(bad, [], NOW);
  A.ok('bad WO: OVERDUE', has(ff, 'OVERDUE'));
  A.ok('bad WO: NEG GP', has(ff, 'NEG GP'));
  A.ok('bad WO: NTE>DNE', has(ff, 'NTE>DNE'));
  A.ok('bad WO: NO VENDOR', has(ff, 'NO VENDOR'));
  A.ok('bad WO: UNSCHEDULED', has(ff, 'UNSCHEDULED'));
  A.ok('bad WO: NO NOTES', has(ff, 'NO NOTES'));
})();

A.finish();
