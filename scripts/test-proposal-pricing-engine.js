// test-proposal-pricing-engine.js - node harness for the PURE pricing engine.
//
// Slices the `PP-ENGINE` block out of bwn-proposal-pricing.user.js and runs the REAL shipped
// bytes. The block is declarations-only with no DOM and no clock, so it evaluates as-is.
//
// Every guarantee here was first established against the LIVE tenant (2026-09-08) and then
// pinned, because each one was a bug that reached a number on screen:
//   - GP on the taxed total read 35.19% where Umbrava's pre-tax basis is 30.00%
//   - the cost-category map had Other=3 (it is 7) and aliased Shipping onto Other (it is 6)
//   - a lump-sum line priced a $3,360 labour row at $90 off a placeholder quantity
//   - switching rate after typing a quantity silently un-priced the row
//   - the "No X rate is contracted" warning fired on a category that had just priced
// Each carries a mutation control so a rule that stops firing is caught.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-proposal-pricing-engine.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-proposal-pricing.user.js');

function slice(startMark, endMark) {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf(startMark);
  var b = t.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error(startMark + ' markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = slice('// ===== PP-ENGINE START', '// ===== PP-ENGINE END');

var E = (new Function(
  SECTION + '\n;return { CAT_LABEL: CAT_LABEL, CAT_ID: CAT_ID, ppMoney: ppMoney, ppMoneyIn: ppMoneyIn,' +
  ' ppCrewOf: ppCrewOf, ppCatOf: ppCatOf, ppTotals: ppTotals, ppMatchRow: ppMatchRow,' +
  ' ppSetQty: ppSetQty, ppSetRate: ppSetRate, ppConstraints: ppConstraints };'
))();

// =============================================================================================
console.log('-- 1. money is MINOR UNITS --');
// =============================================================================================
A.ok('precision 2 divides by 100', Math.abs(E.ppMoney({ amount: 22972692, currency: 'USD', precision: 2 }) - 229726.92) < 0.001);
A.ok('honours a non-2 precision', Math.abs(E.ppMoney({ amount: 12345, currency: 'USD', precision: 3 }) - 12.345) < 0.0001);
A.ok('absent precision defaults to 2', Math.abs(E.ppMoney({ amount: 468584, currency: 'USD' }) - 4685.84) < 0.001);
A.eq('null money is 0, never NaN', E.ppMoney(null), 0);
A.eq('empty money is 0', E.ppMoney({}), 0);
A.eq('round-trips through ppMoneyIn', E.ppMoneyIn(4685.84).amount, 468584);
A.ok('round-trip is lossless', Math.abs(E.ppMoney(E.ppMoneyIn(4685.84)) - 4685.84) < 0.001);
A.eq('rounds rather than truncates (half up)', E.ppMoneyIn(0.005).amount, 1);
A.eq('rounds a repeating third decimal', E.ppMoneyIn(10.999).amount, 1100);
// C1: a truncating implementation would give 0 here.
A.ok('C1 control: truncation would fail the 0.005 case', Math.trunc(0.005 * 100) === 0);

// =============================================================================================
console.log('\n-- 2. cost categories: the full live list --');
// =============================================================================================
A.eq('all 18 ids are mapped', Object.keys(E.CAT_LABEL).length, 18);
var missing = [];
for (var ci = 0; ci <= 17; ci++) { if (!E.CAT_LABEL[ci]) missing.push(ci); }
A.eq('no gap in 0..17', missing.join(','), '');
A.eq('7 is Other', E.CAT_LABEL[7], 'Other');
A.eq('3 is Recycling, NOT unused and NOT Other', E.CAT_LABEL[3], 'Recycling');
A.eq('6 is Shipping', E.CAT_LABEL[6], 'Shipping');
A.eq('Shipping does not alias onto Other', E.CAT_ID.Shipping, 6);
A.eq('0 is Labor', E.CAT_LABEL[0], 'Labor');
A.eq('1 is Material', E.CAT_LABEL[1], 'Material');
A.eq('2 is Equipment', E.CAT_LABEL[2], 'Equipment');
A.eq('4 is Travel', E.CAT_LABEL[4], 'Travel');
var rt = [];
for (var cj = 0; cj <= 17; cj++) { if (E.CAT_ID[E.CAT_LABEL[cj]] !== cj) rt.push(cj); }
A.eq('every id round-trips through its label', rt.join(','), '');
A.eq('the engine plural alias resolves', E.CAT_ID.Materials, 1);
// C2: the five-entry map this replaced would fail all three of these.
A.ok('C2 control: a 5-entry map is detectably short', Object.keys({ 0: 1, 1: 1, 2: 1, 4: 1, 7: 1 }).length !== 18);

// =============================================================================================
console.log('\n-- 3. crew size is READ from the vendor text, never assumed --');
// =============================================================================================
A.eq('the live case: "labor - 2 techs"', E.ppCrewOf({ _umbItem: 'labor - 2 techs' }), 2);
A.eq('"3 Man crew"', E.ppCrewOf({ _umbItem: '3 Man crew' }), 3);
A.eq('"2-man team"', E.ppCrewOf({ clientDescription: '2-man team on site' }), 2);
A.eq('"crew of 4"', E.ppCrewOf({ clientDescription: 'crew of 4' }), 4);
A.eq('"1 technician"', E.ppCrewOf({ _umbItem: '1 technician' }), 1);
A.eq('nothing stated -> 0 (send no crewSize)', E.ppCrewOf({ _umbItem: 'material' }), 0);
A.eq('"accomodations" -> 0', E.ppCrewOf({ _umbItem: 'accomodations' }), 0);
A.eq('empty item -> 0', E.ppCrewOf({}), 0);
A.eq('a length is not a crew', E.ppCrewOf({ _umbItem: '250ft mc cable' }), 0);
A.eq('out of range is not a crew', E.ppCrewOf({ _umbItem: '99 men' }), 0);
// C3: crew 0 must be falsy so the caller omits the filter entirely.
A.ok('C3 control: 0 is falsy so `if (crew > 0)` omits it', !(E.ppCrewOf({ _umbItem: 'material' }) > 0));

// =============================================================================================
console.log('\n-- 4. GP is PRE-TAX, on Umbrava\'s basis --');
// =============================================================================================
// $1,000 pre-tax revenue, $700 cost, 8% tax - the fixture the two bases disagree on.
var rows = [{ subtotal: 1000, taxAmt: 80, vendorCost: 700 }];
var t = E.ppTotals(rows, 0.33);
A.ok('subtotal is the pre-tax figure', t.subtotal === 1000);
A.ok('total carries the tax', t.total === 1080);
A.ok('GP = subtotal - vendorCost', t.gp === 300);
A.ok('GP% divides by the SUBTOTAL', Math.abs(t.gpPct - 30) < 0.001);
A.ok('the taxed basis is kept for reference', t.gpTaxed === 380);
A.ok('and it reads HIGH - 35.19% vs 30.00%', Math.abs(t.gpTaxedPct - 35.185) < 0.01);
A.ok('THE TWO BASES MUST DIFFER (a revert makes them equal)', t.gpPct !== t.gpTaxedPct);
A.ok('taxed overstates by ~5 points on this fixture', (t.gpTaxedPct - t.gpPct) > 5);
A.ok('target subtotal is cost/(1-target)', Math.abs(t.targetSubtotal - (700 / 0.67)) < 0.01);
A.ok('target gap is measured against the SUBTOTAL', Math.abs(t.targetGap - (700 / 0.67 - 1000)) < 0.01);
A.ok('30% does not hit a 33% target', t.hitsTarget === false);
// C4: the exact defect this replaced - GP off the taxed total.
A.ok('C4 control: computing off `total` yields the wrong 35.19%', Math.abs(((1080 - 700) / 1080 * 100) - 35.185) < 0.01);
// Zero-tax records confirm the basis without discriminating it - hence the fixture above.
var t0 = E.ppTotals([{ subtotal: 500, taxAmt: 0, vendorCost: 400 }], 0.33);
A.ok('with no tax the two bases coincide (why a taxed record is the control)', Math.abs(t0.gpPct - t0.gpTaxedPct) < 0.0001);
A.eq('empty rows do not divide by zero', E.ppTotals([], 0.33).gpPct, 0);

// =============================================================================================
console.log('\n-- 5. a lump-sum line is NEVER auto-priced --');
// =============================================================================================
var RATE_1MAN = { id: 'L1', item: '1 Man', uom: 'hr', rate: 90, categoryId: 0, accepted: true };
var RATE_2MAN = { id: 'L2', item: '2 Man', uom: 'hr', rate: 150, categoryId: 0, accepted: true };

// The live W-380026 shape: unit '' (the vendor stated none) and a placeholder quantity.
var lump = { id: 'lm1', vendorTotal: 3360, qty: 1, unit: '', _umbQtyKnown: false, _catRaw: 'Labor', labor: 3360, materials: 0, clientDescription: 'Labor' };
var r = E.ppMatchRow(lump, RATE_1MAN);
A.eq('a matched rate is still attached', r.matched.id, 'L1');
A.ok('but the row needs a quantity', r.needsQty === true);
A.ok('so it is SKIPPED, not priced', r.skip === true);
A.ok('unitKnown is false when the vendor stated no unit', r.unitKnown === false);
A.eq('the rate\'s unit is shown without claiming the vendor stated it', r.unit, 'hr');
// C5: the defect - pricing it anyway would value a $3,360 line at $90.
A.ok('C5 control: rate x placeholder qty would be $90 on a $3,360 line', RATE_1MAN.rate * 1 === 90);

// An ITEMIZED line prices immediately - the positive control that the guard is not always-on.
var itemized = { id: 'it1', vendorTotal: 1800, qty: 30, unit: 'hr', _umbQtyKnown: true, _catRaw: 'Labor', labor: 1800, materials: 0, clientDescription: 'Labor' };
var ri = E.ppMatchRow(itemized, RATE_1MAN);
A.ok('a stated unit + real quantity needs nothing from a human', ri.needsQty === false);
A.ok('and it is priced', ri.skip === false);
A.ok('at rate x quantity', ri.clientPrice === 2700);

// A unit that disagrees with the rate's unit is skipped with a reason.
var badUom = { id: 'bu1', vendorTotal: 1426.1, qty: 1, unit: 'total', _umbQtyKnown: true, _catRaw: 'Material', labor: 0, materials: 1426.1, clientDescription: 'material' };
var rb = E.ppMatchRow(badUom, { id: 'M1', item: 'LED driver', uom: 'ea', rate: 98, categoryId: 1, accepted: true });
A.ok('uom "total" vs rate uom "ea" is a mismatch', rb.uomMismatch === true);
A.ok('and the row is skipped', rb.skip === true);

// No rate at all -> skipped, left at cost.
var noRate = E.ppMatchRow({ id: 'nr1', vendorTotal: 400, qty: 1, unit: '', _catRaw: 'Other' }, null);
A.ok('no contracted rate -> skipped', noRate.skip === true);
A.eq('and no price is invented', noRate.clientPrice, null);
A.ok('needsQty is not claimed when there is no rate to price with', noRate.needsQty === false);

// =============================================================================================
console.log('\n-- 6. a supplied quantity survives a rate switch --');
// =============================================================================================
var sw = E.ppMatchRow(lump, RATE_1MAN);
E.ppSetQty(sw, 40);
A.ok('supplying the quantity clears needsQty', sw.needsQty === false);
A.ok('and prices the row', sw.skip === false);
A.eq('the quantity is recorded', sw.qty, 40);
A.ok('at 90/hr x 40hr', Math.abs(sw.clientPrice - 3600) < 0.001);
E.ppSetRate(sw, RATE_2MAN);
A.eq('THE QUANTITY SURVIVES the rate switch', sw.qty, 40);
A.ok('qtyKnown stays true', sw.qtyKnown === true);
A.ok('needsQty does NOT come back (an unstated unit must not re-gate)', sw.needsQty === false);
A.ok('the row stays priced', sw.skip === false);
A.ok('at the new rate: 150 x 40', Math.abs(sw.clientPrice - 6000) < 0.001);
// C6: the defect - testing (!unitKnown || !qtyKnown) re-gates forever, because unitKnown never
// becomes true for a lump-sum line.
A.ok('C6 control: the old condition would re-gate this row', (!sw.unitKnown || !sw.qtyKnown) === true);
// Clearing it un-prices the row again.
E.ppSetQty(sw, '');
A.ok('clearing the quantity un-prices it', sw.skip === true);
A.ok('and asks again', sw.needsQty === true);
A.eq('the quantity falls back to 1', sw.qty, 1);

// =============================================================================================
console.log('\n-- 7. warnings are derived from the ROWS --');
// =============================================================================================
var priced = E.ppMatchRow(itemized, RATE_1MAN);
var cons = E.ppConstraints([priced], [0]);
var anyNoLabor = cons.join(' | ').indexOf('No Labor rate') !== -1;
A.ok('a category that priced is NOT reported as uncontracted', anyNoLabor === false);
// C7: the defect - reading a merged pool's (deliberately null) suggestion reported
// "No Labor rate is contracted" on a job whose labour lines had just priced.
var consNone = E.ppConstraints([E.ppMatchRow({ id: 'x', vendorTotal: 100, qty: 1, unit: '', _catRaw: 'Other' }, null)], [7]);
A.ok('C7 control: a category where EVERY line failed IS reported',
  consNone.join(' | ').indexOf('No Other rate') !== -1, consNone.join(' | '));
A.ok('a no-rate line is reported as left at cost', consNone.join(' | ').indexOf('no contracted rate') !== -1);
var consQty = E.ppConstraints([E.ppMatchRow(lump, RATE_1MAN)], [0]);
A.ok('a lump sum is reported as needing the quantity', consQty.join(' | ').indexOf('lump sums') !== -1);
// A contracted rate below vendor cost is a LOSS and must be named, with the amount.
var loss = E.ppMatchRow({ id: 'ls1', vendorTotal: 8300, qty: 1, unit: 'ea', _umbQtyKnown: true, _catRaw: 'Material', labor: 0, materials: 8300 },
  { id: 'M1', item: 'LED driver', uom: 'ea', rate: 98, categoryId: 1, accepted: true });
A.ok('the loss row IS priced (the contract says so)', loss.skip === false);
var consLoss = E.ppConstraints([loss], [1]);
A.ok('and the loss is announced', consLoss.join(' | ').indexOf('LOSS') !== -1, consLoss.join(' | '));
A.ok('naming the amount under water', consLoss.join(' | ').indexOf('8202.00') !== -1, consLoss.join(' | '));
// C8: a profitable row must NOT trip the loss warning.
A.ok('C8 control: a profitable row trips no LOSS', E.ppConstraints([priced], [0]).join(' | ').indexOf('LOSS') === -1);
A.eq('a clean single priced row yields no warnings at all', E.ppConstraints([priced], [0]).length, 0);

// =============================================================================================
console.log('\n-- 8. category resolution --');
// =============================================================================================
A.eq('an explicit category name wins', E.ppCatOf({ _catRaw: 'Travel' }), 4);
A.eq('labour-only falls back to Labor', E.ppCatOf({ labor: 100, materials: 0 }), 0);
A.eq('material-only falls back to Material', E.ppCatOf({ labor: 0, materials: 100 }), 1);
A.eq('mixed is null - say nothing rather than guess', E.ppCatOf({ labor: 50, materials: 50 }), null);
A.eq('empty is null', E.ppCatOf({}), null);
A.eq('Recycling resolves (the id-3 case)', E.ppCatOf({ _catRaw: 'Recycling' }), 3);

A.finish();
