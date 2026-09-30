// test-proposal-pricing.js - node harness for bwn-proposal-pricing's pure pricing engine.
// Slices the PP-ENGINE block out of the REAL .user.js and runs it in a vm, then exercises the
// money / GP / rate math the standalone's runSelfTests() covered. This is MONEY code: every
// assertion here is a control against a live-measured trap. Any edit that changes a money path
// must turn this red.
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-proposal-pricing.js
var fs = require('fs'), path = require('path'), vm = require('vm'), A = require('./assert.js');
var SRC = path.join(__dirname, '..', 'bwn-proposal-pricing.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = full.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker missing - ' + start);
  if (full.indexOf(start, a + 1) !== -1) throw new Error(what + ': START not unique');
  var b = full.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker missing after start');
  return full.slice(a, b);
}

// The pure engine, delimited by the PP-ENGINE markers in the userscript.
var ENGINE = slice('//  PP-ENGINE START', '//  PP-ENGINE END', 'engine block');

function loadEngine() {
  var ctx = vm.createContext({});
  vm.runInContext('(function(){' + ENGINE +
    '\n; this.__api = { umbMoney:umbMoney, umbMoneyIn:umbMoneyIn, CAT_LABEL:CAT_LABEL, CAT_ID:CAT_ID,' +
    ' GP_TARGET:GP_TARGET, getGPTarget:getGPTarget, S:S, markDirty:markDirty, calcItem:calcItem,' +
    ' calcT:calcT, getProposalRows:getProposalRows, crewOf:crewOf, catOf:catOf,' +
    ' umbRateMatchInput:umbRateMatchInput, assembleRateMatch:assembleRateMatch,' +
    ' setRateMatchQty:setRateMatchQty, setRateMatchChoice:setRateMatchChoice,' +
    ' recomputeRateMatchProjection:recomputeRateMatchProjection, applyRateMatch:applyRateMatch,' +
    ' calcPricingGuidancePure:calcPricingGuidancePure, calcRiskScorePure:calcRiskScorePure,' +
    ' calcApprovalPure:calcApprovalPure }; }).call(globalThis);', ctx);
  return ctx.__api;
}

var api = loadEngine();
function approx(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.01 : tol); }

// ── Umbrava money: minor units in, dollars out (divide by 10^precision ONCE) ──────────────
A.ok('umbMoney: precision 2 divides by 100', approx(api.umbMoney({amount:22972692, currency:'USD', precision:2}), 229726.92, 0.001));
A.ok('umbMoney: honours a non-2 precision', approx(api.umbMoney({amount:12345, currency:'USD', precision:3}), 12.345, 0.0001));
A.ok('umbMoney: missing precision defaults to 2', approx(api.umbMoney({amount:468584, currency:'USD'}), 4685.84, 0.001));
A.ok('umbMoney: null/undefined/empty is 0, never NaN', api.umbMoney(null) === 0 && api.umbMoney(undefined) === 0 && api.umbMoney({}) === 0);
A.ok('umbMoneyIn: round-trips through umbMoney', approx(api.umbMoney(api.umbMoneyIn(4685.84)), 4685.84, 0.001) && api.umbMoneyIn(4685.84).amount === 468584);
A.ok('umbMoneyIn: rounds, never truncates', api.umbMoneyIn(0.005).amount === 1 && api.umbMoneyIn(10.999).amount === 1100);

// ── Cost categories: the full 18-entry live list, not the 5-entry map ─────────────────────
A.eq('CAT_LABEL: exactly 18 categories mapped', Object.keys(api.CAT_LABEL).length, 18);
(function () { var okAll = true; for (var id = 0; id <= 17; id++) if (!api.CAT_LABEL[id]) okAll = false; A.ok('CAT_LABEL: ids 0..17 all mapped', okAll); })();
A.ok('CAT_LABEL: Other is 7 (not 3) and 3 is Recycling', api.CAT_LABEL[7] === 'Other' && api.CAT_LABEL[3] === 'Recycling');
A.ok('CAT_LABEL: Shipping is 6, not 7', api.CAT_LABEL[6] === 'Shipping' && api.CAT_ID.Shipping === 6);
A.ok('CAT_LABEL: the four common ones', api.CAT_LABEL[0] === 'Labor' && api.CAT_LABEL[1] === 'Material' && api.CAT_LABEL[2] === 'Equipment' && api.CAT_LABEL[4] === 'Travel');
(function () { var okAll = true; for (var id = 0; id <= 17; id++) if (api.CAT_ID[api.CAT_LABEL[id]] !== id) okAll = false; A.ok('CAT_ID: round-trips every id back through its label', okAll); })();
A.ok('CAT_ID: the engine\'s plural alias still resolves', api.CAT_ID.Materials === 1);

// ── GP basis is PRE-TAX: mg = subCharge - vS, mgp = mg/subCharge. The 30.00% (pre-tax) vs
//    35.19% (taxed) fixture discriminates it - if mg ever reverts to the taxed total these differ. ─
(function () {
  var S = api.S, saved = S.items;
  try {
    S.items = [{ id:'t1', vendorTotal:700, qty:10, _clientUnitRate:100, trade:'Electrical', clientDescription:'test', taxPct:8 }];
    api.markDirty();
    var t = api.calcT();
    A.ok('calcT: vendor cost read verbatim', approx(t.vS, 700));
    A.ok('calcT: GP = pre-tax subtotal - vendor cost', approx(t.mg, t.subCharge - t.vS));
    A.ok('calcT: GP% denominator is the pre-tax subtotal (30.00%)', approx(t.mgp, 30.00));
    A.ok('calcT: taxed basis reads 35.19% and is HIGHER', approx(t.mgpTaxed, 35.19, 0.02) && t.mgpTaxed > t.mgp);
    A.ok('calcT: client total = subtotal + tax', approx(t.cT, t.subCharge + t.taxTotal) && t.taxTotal > 0);
    A.ok('calcT: taxed pair kept for reference only', approx(t.mgTaxed, t.cT - t.vS));
  } finally { S.items = saved; api.markDirty(); }
})();
(function () {
  var S = api.S, saved = S.items;
  try {
    S.items = [{ id:'t2', vendorTotal:5000, qty:1, _clientUnitRate:5000, trade:'Electrical', clientDescription:'test', taxPct:0 }];
    api.markDirty();
    var t = api.calcT();
    A.ok('calcT: target is the pre-tax subtotal to hit the GP target', approx(t.targetCT, 5000 / (1 - api.getGPTarget()), 1) && approx(t.targetCT, 7462.69, 1));
    A.ok('calcT: target exceeds vendor cost', t.targetCT > t.vS);
  } finally { S.items = saved; api.markDirty(); }
})();

// ── Crew size is PARSED from the vendor's own text, never assumed. A line stating no crew
//    sends no crewSize (0), the same discipline as never defaulting a missing unit to 'ea'. ──────
A.eq('crewOf: the live "labor - 2 techs" case', api.crewOf({_umbItem:'labor - 2 techs'}), 2);
A.eq('crewOf: "3 Man crew"', api.crewOf({_umbItem:'3 Man crew'}), 3);
A.eq('crewOf: "2-man team on site"', api.crewOf({clientDescription:'2-man team on site'}), 2);
A.eq('crewOf: "crew of 4"', api.crewOf({clientDescription:'crew of 4'}), 4);
A.eq('crewOf: "1 technician"', api.crewOf({_umbItem:'1 technician'}), 1);
A.eq('crewOf: nothing stated -> 0 (send no crewSize)', api.crewOf({_umbItem:'material'}), 0);
A.eq('crewOf: a length is not a crew', api.crewOf({_umbItem:'250ft mc cable'}), 0);
A.eq('crewOf: out of range -> 0', api.crewOf({_umbItem:'99 men'}), 0);

// ── rateMatches INPUT: behavior Ranked, never tradeId, crewSize/search only when present ──────
(function () {
  A.eq('umbRateMatchInput: crew 0 is not sent', 'crewSize' in api.umbRateMatchInput('c', 0, { crewSize:0 }), false);
  A.eq('umbRateMatchInput: crew 2 is sent', api.umbRateMatchInput('c', 0, { crewSize:2 }).crewSize, 2);
  A.eq('umbRateMatchInput: no search by default', 'search' in api.umbRateMatchInput('c', 0, {}), false);
  A.eq('umbRateMatchInput: tradeId is NEVER sent (it zeroes the match)', 'tradeId' in api.umbRateMatchInput('c', 0, { crewSize:2 }), false);
  A.eq('umbRateMatchInput: behavior is Ranked (SingleBest returns nothing)', api.umbRateMatchInput('c', 0, {}).behavior, 'Ranked');
})();

// ── CONTROL 1: applyRateMatch prices IN PLACE and the vendor cost SURVIVES (GP stays real,
//    never the 100% the old vendorTotal:0 rewrite produced). ──────────────────────────────────
(function () {
  var S = api.S, saved = S.items, savedRM = S.rateMatch;
  try {
    S.items = [{ id:'rm1', vendorTotal:2800, qty:16, unit:'hr', _catRaw:'Labor', labor:2800, materials:0, trade:'Electrical', clientDescription:'Journeyman' }];
    S.rateMatch = { rows:[{ itemId:'rm1', description:'Journeyman', categoryId:0, category:'Labor', vendorCost:2800, qty:16, unit:'hr', skip:false, uomMismatch:false, matched:{ id:'r-9', item:'1 Man Standard', uom:'hr', rate:255, categoryId:0, accepted:true }, chosenRateId:'r-9', clientPrice:4080 }], byCat:{} };
    api.applyRateMatch();
    var it = S.items[0];
    A.eq('applyRateMatch: does not add or remove rows', S.items.length, 1);
    A.eq('applyRateMatch: VENDOR COST SURVIVES', it.vendorTotal, 2800);
    A.eq('applyRateMatch: prices via the manual-override path', it._clientUnitRate, 255);
    A.eq('applyRateMatch: keeps provenance of the contracted rate', it._umbRateId, 'r-9');
    var ci = api.calcItem(it);
    A.ok('applyRateMatch: client price is rate*qty', approx(ci.clientPrice, 4080));
    A.ok('applyRateMatch: GP is real (not 100%)', approx(ci.marginPct, ((4080 - 2800) / 4080) * 100) && ci.marginPct < 99);
  } finally { S.items = saved; S.rateMatch = savedRM; api.markDirty(); }
})();
(function () {
  var S = api.S, saved = S.items, savedRM = S.rateMatch;
  try {
    S.items = [{ id:'rm2', vendorTotal:500, qty:1, unit:'ea', _catRaw:'Material', labor:0, materials:500, trade:'Electrical', clientDescription:'Part' }];
    S.rateMatch = { rows:[{ itemId:'rm2', categoryId:1, vendorCost:500, qty:1, unit:'ea', skip:true, uomMismatch:true, matched:{ id:'r-1', item:'X', uom:'hr', rate:99 }, clientPrice:99 }], byCat:{} };
    api.applyRateMatch();
    A.eq('applyRateMatch: a uom-mismatched (skipped) row is NOT priced', S.items[0]._clientUnitRate, undefined);
    A.eq('applyRateMatch: skipped row keeps its vendor cost', S.items[0].vendorTotal, 500);
  } finally { S.items = saved; S.rateMatch = savedRM; api.markDirty(); }
})();

// ── CONTROL 2: a LUMP-SUM line (no stated unit, quantity "1") is NOT auto-priced - no unit
//    invented, no placeholder qty priced. Only a human-supplied real quantity makes it priceable. ─
(function () {
  var S = api.S, saved = S.items, savedRM = S.rateMatch;
  try {
    S.items = [{ id:'lm1', vendorTotal:3360, qty:1, unit:'', _umbQtyKnown:false, _catRaw:'Labor', labor:3360, materials:0, trade:'Electrical', clientDescription:'Labor' }];
    var sug = { id:'L1', item:'1 Man', uom:'hr', rate:90, categoryId:0, accepted:true };
    S.rateMatch = { byCat:{ 0:{ suggested:sug, options:[sug], rowCount:19 } }, rows:[{ itemId:'lm1', description:'Labor', categoryId:0, category:'Labor', vendorCost:3360, qty:1, unit:'hr', unitKnown:false, qtyKnown:false, needsQty:true, matched:sug, chosenRateId:'L1', clientPrice:90, uomMismatch:false, skip:true }] };
    api.applyRateMatch();
    A.eq('lump sum: NOT priced off a placeholder qty', S.items[0]._clientUnitRate, undefined);
    A.eq('lump sum: vendor cost intact', S.items[0].vendorTotal, 3360);
    // Supplying the real quantity makes it priceable, and the price is right.
    api.setRateMatchQty('lm1', 24);
    var row = S.rateMatch.rows[0];
    A.ok('lump sum: supplying the qty makes it priceable', row.needsQty === false && row.skip === false && row.qty === 24);
    A.ok('lump sum: priced 90/hr x 24hr', approx(row.clientPrice, 2160));
    api.applyRateMatch();
    A.eq('lump sum: now priced at the contracted rate', S.items[0]._clientUnitRate, 90);
    A.eq('lump sum: operator quantity written back to the item', S.items[0].qty, 24);
    A.ok('lump sum: calcItem = 90 x 24 = 2160', approx(api.calcItem(S.items[0]).clientPrice, 2160));
  } finally { S.items = saved; S.rateMatch = savedRM; api.markDirty(); }
})();

// ── CONTROL 3: an ITEMIZED line (stated unit + real quantity) auto-prices with NO human input,
//    straight out of assembleRateMatch. This is the positive twin of the lump-sum control. ───────
(function () {
  var S = api.S, saved = S.items, savedRM = S.rateMatch;
  try {
    S.items = [{ id:'it1', vendorTotal:600, qty:8, unit:'hr', _umbQtyKnown:true, _catRaw:'Labor', labor:600, materials:0, trade:'Electrical', clientDescription:'Tech labor' }];
    var sug = { id:'r1', item:'1 Man', uom:'hr', rate:120, categoryId:0, accepted:true };
    var byKey = { '0|0': { suggested:sug, options:[sug], rowCount:1 } };  // catOf=0, crewOf=0 (none stated)
    var rm = api.assembleRateMatch(S.items, byKey);
    var row = rm.rows[0];
    A.ok('itemized: auto-priced with no qty input (not skipped, no needsQty)', row.skip === false && row.needsQty === false);
    A.ok('itemized: client price is rate*qty = 120 x 8 = 960', approx(row.clientPrice, 960));
    S.rateMatch = rm;
    api.applyRateMatch();
    A.eq('itemized: priced in place at the contracted rate', S.items[0]._clientUnitRate, 120);
    A.ok('itemized: calcItem confirms 960', approx(api.calcItem(S.items[0]).clientPrice, 960));
  } finally { S.items = saved; S.rateMatch = savedRM; api.markDirty(); }
})();

// ── A supplied quantity survives switching to a different contracted rate (only the QUANTITY
//    gates pricing; an unstated vendor unit must not re-gate the line). ──────────────────────────
(function () {
  var S = api.S, savedRM = S.rateMatch;
  try {
    var a = { id:'L1', item:'1 Man', uom:'hr', rate:90, categoryId:0, accepted:true };
    var b = { id:'L2', item:'2 Man', uom:'hr', rate:150, categoryId:0, accepted:true };
    S.rateMatch = { byCat:{ 0:{ suggested:a, options:[a, b], rowCount:2 } }, rows:[{ itemId:'sw', categoryId:0, vendorCost:3360, qty:1, unit:'hr', unitKnown:false, qtyKnown:false, needsQty:true, matched:a, chosenRateId:'L1', clientPrice:90, uomMismatch:false, skip:true }] };
    api.setRateMatchQty('sw', 40);
    A.ok('rate switch: priceable once the quantity is supplied', S.rateMatch.rows[0].skip === false && approx(S.rateMatch.rows[0].clientPrice, 3600));
    api.setRateMatchChoice('sw', 'L2');
    var r = S.rateMatch.rows[0];
    A.ok('rate switch: THE QUANTITY SURVIVES the rate switch', r.qty === 40 && r.qtyKnown === true && r.needsQty === false && r.skip === false);
    A.ok('rate switch: repriced at 150/hr x 40hr', approx(r.clientPrice, 6000));
  } finally { S.rateMatch = savedRM; }
})();

// ── Advisory panel math is pure and null-safe (empty items -> null, not a throw). ─────────────
(function () {
  var S = api.S, saved = S.items;
  try {
    S.items = []; api.markDirty();
    A.ok('calcPricingGuidancePure: null on empty items', api.calcPricingGuidancePure() === null);
    A.ok('calcRiskScorePure: null on empty items', api.calcRiskScorePure() === null);
    S.items = [{ id:'g1', vendorTotal:1000, qty:1, _clientUnitRate:1200, trade:'Electrical', clientDescription:'x', taxPct:0 }];
    api.markDirty();
    var g = api.calcPricingGuidancePure();
    A.ok('calcPricingGuidancePure: target uses vendorCost/(1-gpTarget) as its base', g && g.target >= 1000 / (1 - api.getGPTarget()) - 0.01);
    A.ok('calcApprovalPure: returns a label and triggers array', (function () { var ap = api.calcApprovalPure(); return ap && typeof ap.label === 'string' && Array.isArray(ap.triggers); })());
  } finally { S.items = saved; api.markDirty(); }
})();

A.finish();
