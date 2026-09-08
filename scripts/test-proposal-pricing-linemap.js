// test-proposal-pricing-linemap.js - node harness for the PURE vendor-line mapper.
//
// Slices the `PP-LINEMAP` block out of bwn-proposal-pricing.user.js and runs the REAL shipped
// bytes, injecting the two externals it closes over (ppMoney, CAT_LABEL) from the PP-ENGINE
// block so both slices are the shipped ones rather than retyped copies.
//
// What this exists to stop: `l.unitOfMeasurement || 'ea'`. Live vendor lines carry an
// EMPTY-STRING unit, and that one default invented a unit which then satisfied the rate
// matcher's own unit check and priced a $3,360 labour line at $90 and an $8,300 material line at
// $98. A `||` default on a field read off a record IS fabrication. Fixtures below are the two
// real quote shapes, measured 2026-09-08:
//   W-380026 (FACE N SON'S) - 7 lines, no item text, no uom, quantity "0"/"1", unitCost==totalCost
//   W-390640 (MAKO)         - 4 lines, item text + real uom, quantities 5/30/1/2
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-proposal-pricing-linemap.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-proposal-pricing.user.js');
var TEXT = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startMark, endMark) {
  var a = TEXT.indexOf(startMark), b = TEXT.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error(startMark + ' markers not found in ' + SRC);
  return TEXT.slice(a, b);
}
// Both slices are shipped bytes: the mapper closes over ppMoney/CAT_LABEL from the engine.
var ENGINE = slice('// ===== PP-ENGINE START', '// ===== PP-ENGINE END');
var LINEMAP = slice('// ===== PP-LINEMAP START', '// ===== PP-LINEMAP END');

var M = (new Function(
  ENGINE + '\n' + LINEMAP +
  '\n;return { ppMapQuoteLine: ppMapQuoteLine, ppMapQuoteLines: ppMapQuoteLines, ppItemFromLine: ppItemFromLine };'
))();

// Find fixtures by what they ARE, not by position: the placeholder filter shifts indices,
// which is exactly the kind of silent drift a positional fixture hides.
function pick(list, cat, cost) {
  for (var k = 0; k < list.length; k++) { if (list[k].category === cat && Math.abs(list[k].totalCost - cost) < 0.001) return list[k]; }
  throw new Error('fixture not found: ' + cat + ' @ ' + cost);
}

function money(amount, precision) { return { amount: amount, currency: 'USD', precision: precision == null ? 2 : precision }; }

// ---- the live W-380026 quote, verbatim in shape --------------------------------------------
var LUMP_QUOTE = [
  { category: 4, categoryObject: { name: 'Travel' }, item: '', description: '', quantity: '0', unitOfMeasurement: '', unitCost: money(0), totalCost: money(0), totalCharge: money(0), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'Manual' },
  { category: 0, categoryObject: { name: 'Labor' }, item: '', description: '', quantity: '1', unitOfMeasurement: '', unitCost: money(30000), totalCost: money(30000), totalCharge: money(30000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'Manual' },
  { category: 4, categoryObject: { name: 'Travel' }, item: '', description: '', quantity: '1', unitOfMeasurement: '', unitCost: money(30000), totalCost: money(30000), totalCharge: money(30000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'Manual' },
  { category: 0, categoryObject: { name: 'Labor' }, item: '', description: '', quantity: '1', unitOfMeasurement: '', unitCost: money(336000), totalCost: money(336000), totalCharge: money(336000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'Manual' },
  { category: 7, categoryObject: { name: 'Other' }, item: '', description: '', quantity: '1', unitOfMeasurement: '', unitCost: money(40000), totalCost: money(40000), totalCharge: money(40000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'NotApplicable' },
  { category: 1, categoryObject: { name: 'Material' }, item: '', description: '', quantity: '1', unitOfMeasurement: '', unitCost: money(830000), totalCost: money(830000), totalCharge: money(830000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'NotApplicable' },
  { category: 2, categoryObject: { name: 'Equipment' }, item: '', description: '', quantity: '0', unitOfMeasurement: '', unitCost: money(0), totalCost: money(0), totalCharge: money(0), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'NotApplicable' }
];

// ---- the live W-390640 quote (itemized) ----------------------------------------------------
var ITEMIZED_QUOTE = [
  { category: 0, categoryObject: { name: 'Labor' }, item: 'labor - 2 techs', description: '', quantity: '5', unitOfMeasurement: 'hr', unitCost: money(14400), totalCost: money(72000), totalCharge: money(72000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'Manual' },
  { category: 0, categoryObject: { name: 'Labor' }, item: 'labor - 2 techs', description: '', quantity: '30', unitOfMeasurement: 'hr', unitCost: money(14400), totalCost: money(432000), totalCharge: money(432000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'Manual' },
  { category: 1, categoryObject: { name: 'Material' }, item: 'material', description: 'bell boxes, connectors, thhn', quantity: '1', unitOfMeasurement: 'total', unitCost: money(142610), totalCost: money(142610), totalCharge: money(142610), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'NotApplicable' },
  { category: 7, categoryObject: { name: 'Other' }, item: 'accomodations', description: '', quantity: '2', unitOfMeasurement: 'day', unitCost: money(50000), totalCost: money(100000), totalCharge: money(100000), isTaxable: false, taxRate: '0', rateId: null, rateDiscrepancy: 'NotApplicable' }
];

// =============================================================================================
console.log('-- 1. NO unit is ever invented --');
// =============================================================================================
var lump = M.ppMapQuoteLines(LUMP_QUOTE);
var invented = 0, i;
for (i = 0; i < lump.length; i++) { if (lump[i].uom !== '') invented++; }
A.eq('every live lump-sum line keeps an EMPTY unit', invented, 0);
// C1: the exact defect - a `|| 'ea'` default.
A.eq('C1 control: the old default would have produced "ea"', ('' || 'ea'), 'ea');
A.ok('an empty unit is falsy, so downstream unitKnown is false', !pick(lump, 'Labor', 300).uom);
// A stated unit is preserved exactly, including the odd ones.
var item = M.ppMapQuoteLines(ITEMIZED_QUOTE);
A.eq('a stated "hr" survives', item[0].uom, 'hr');
A.eq('a stated "day" survives', item[3].uom, 'day');
A.eq('"total" survives - some vendors express a lump sum AS a unit', item[2].uom, 'total');

// =============================================================================================
console.log('\n-- 2. placeholder rows are dropped --');
// =============================================================================================
A.eq('7 raw lines become 5', lump.length, 5);
A.eq('the two zero-cost/zero-quantity rows are gone', LUMP_QUOTE.length - lump.length, 2);
var zeros = 0;
for (i = 0; i < lump.length; i++) { if (lump[i].totalCost === 0 && !lump[i].qty) zeros++; }
A.eq('no surviving row is an empty placeholder', zeros, 0);
A.eq('the itemized quote loses nothing', item.length, 4);
// C2: a mapper without the filter would keep all seven.
A.ok('C2 control: the unfiltered map is 7 long', LUMP_QUOTE.length === 7);

// =============================================================================================
console.log('\n-- 3. the lump-sum verdict --');
// =============================================================================================
var allLump = true;
for (i = 0; i < lump.length; i++) { if (!lump[i].isLumpSum) allLump = false; }
A.ok('every W-380026 line is flagged a lump sum', allLump);
A.ok('5 hr @ 144 with unitCost != totalCost is NOT a lump sum', item[0].isLumpSum === false);
A.ok('30 hr likewise', item[1].isLumpSum === false);
A.ok('"1 total" IS a lump sum even though a unit is stated', item[2].isLumpSum === true);
A.ok('2 day @ 500 is NOT a lump sum', item[3].isLumpSum === false);
// C3: each of the three clauses must be load-bearing.
A.ok('C3a control: no unit alone makes it a lump sum',
  M.ppMapQuoteLine({ category: 0, quantity: '5', unitOfMeasurement: '', unitCost: money(100), totalCost: money(500) }).isLumpSum === true);
A.ok('C3b control: quantity 1 alone makes it a lump sum',
  M.ppMapQuoteLine({ category: 0, quantity: '1', unitOfMeasurement: 'hr', unitCost: money(100), totalCost: money(500) }).isLumpSum === true);
A.ok('C3c control: unitCost == totalCost alone makes it a lump sum',
  M.ppMapQuoteLine({ category: 0, quantity: '5', unitOfMeasurement: 'hr', unitCost: money(500), totalCost: money(500) }).isLumpSum === true);
A.ok('C3d positive control: none of the three -> NOT a lump sum',
  M.ppMapQuoteLine({ category: 0, quantity: '5', unitOfMeasurement: 'hr', unitCost: money(100), totalCost: money(500) }).isLumpSum === false);

// =============================================================================================
console.log('\n-- 4. money, quantity and category come off the record --');
// =============================================================================================
A.ok('totalCost is dollars, not minor units', Math.abs(pick(lump, 'Labor', 3360).totalCost - 3360) < 0.001);
A.ok('the material line is $8,300', Math.abs(pick(lump, 'Material', 8300).totalCost - 8300) < 0.001);
A.eq('quantity "0" becomes null, not 0', M.ppMapQuoteLine(LUMP_QUOTE[0]).qty, null);
A.eq('quantity "30" becomes the number 30', item[1].qty, 30);
A.eq('a string quantity is coerced, not passed through', typeof item[1].qty, 'number');
A.eq('taxRate "0" becomes 0 percent', item[0].taxPct, 0);
A.ok('a taxRate of "0.08" becomes 8 percent',
  Math.abs(M.ppMapQuoteLine({ category: 0, quantity: '1', taxRate: '0.08', unitCost: money(100), totalCost: money(100) }).taxPct - 8) < 0.001);
A.eq('the category name comes from the id map', pick(lump, 'Labor', 300).category, 'Labor');
A.eq('Recycling maps (the id-3 case)', M.ppMapQuoteLine({ category: 3, quantity: '1', unitCost: money(1), totalCost: money(1) }).category, 'Recycling');
A.eq('Shipping maps to Shipping, not Other', M.ppMapQuoteLine({ category: 6, quantity: '1', unitCost: money(1), totalCost: money(1) }).category, 'Shipping');
A.eq('an unknown id falls back to the record\'s own object name',
  M.ppMapQuoteLine({ category: 99, categoryObject: { name: 'Something New' }, quantity: '1', unitCost: money(1), totalCost: money(1) }).category, 'Something New');

// =============================================================================================
console.log('\n-- 5. line -> internal item --');
// =============================================================================================
var it0 = M.ppItemFromLine(pick(lump, 'Labor', 300), 'Electrical', null);   // a lump-sum labour line
A.eq('vendorTotal carries the cost', it0.vendorTotal, 300);
A.eq('qty falls back to 1 so the arithmetic is defined', it0.qty, 1);
A.ok('but _umbQtyKnown records that the vendor did NOT state it', it0._umbQtyKnown === false);
A.eq('the unit stays empty', it0.unit, '');
A.eq('the WO trade is the fallback when the line has none', it0.trade, 'Electrical');
A.ok('a blank description is synthesized so the row is identifiable', it0.clientDescription.length > 0);
A.ok('and it names the category and amount', it0.clientDescription.indexOf('Labor') === 0);

var it1 = M.ppItemFromLine(item[1], 'Electrical', null);   // 30 hr @ 144, itemized
A.eq('a stated quantity is carried', it1.qty, 30);
A.ok('and _umbQtyKnown is true', it1._umbQtyKnown === true);
A.eq('the stated unit is carried', it1.unit, 'hr');
A.eq('the line item text rides along for the crew parser', it1._umbItem, 'labor - 2 techs');
// The labour/material split is READ from the category, never estimated.
A.eq('a Labor line puts its cost in labor', it1.labor, 4320);
A.eq('and nothing in materials', it1.materials, 0);
var it2 = M.ppItemFromLine(item[2], 'Electrical', null);
A.eq('a Material line puts its cost in materials', it2.materials, 1426.1);
A.eq('and nothing in labor', it2.labor, 0);
var it3 = M.ppItemFromLine(item[3], 'Electrical', null);
A.eq('an Other line splits into neither', it3.labor, 0);
A.eq('nor materials', it3.materials, 0);
// C4: the trade ratio this replaced would have split an Other line by guesswork.
A.ok('C4 control: no ratio was applied to the Other line', it3.labor === 0 && it3.materials === 0);
A.ok('every imported item is tagged as coming from a real quote', it1._fromUmbravaQuote === true);

// =============================================================================================
console.log('\n-- 6. the rateDiscrepancy caveat --');
// =============================================================================================
// Across 15 live quotes ZERO lines carried a rateId, so this verdict is a weak signal on this
// tenant. The mapper must still carry it verbatim rather than inferring anything from it.
A.eq('the verdict is carried verbatim', pick(lump, 'Labor', 300).rateVerdict, 'Manual');
A.eq('NotApplicable is carried too', pick(lump, 'Material', 8300).rateVerdict, 'NotApplicable');
A.eq('a null rateId stays null - never defaulted', pick(lump, 'Labor', 300).rateId, null);
A.eq('an absent verdict becomes null, not a guess',
  M.ppMapQuoteLine({ category: 0, quantity: '1', unitCost: money(1), totalCost: money(1) }).rateVerdict, null);

A.finish();
