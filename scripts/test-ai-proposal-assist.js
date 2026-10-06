// test-ai-proposal-assist.js - node harness for bwn-ai-proposal-assist.user.js.
//
// WHAT THIS PROVES, against the REAL shipped bytes:
//   - the pure APA-LOGIC block (sliced by marker, run in a vm): route allow/deny, grid keyed by
//     header text (column order shuffled), every pre-flight rule, prompt template order and the
//     1,000-char boundary, every post-generate check incl. negative markup, validationErrors
//     surfacing, and the passive fetch tap (request untouched, app gets the original response).
//   - the read-only contract statically: @match umbrava only, @grant none, no @connect, no
//     .click(), no polling timer, no auth header read, no request of its own, duplicate-init guard.
//   - negative controls: mutated copies of the logic must turn the key checks red.
//
// Fixtures are synthetic. Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ai-proposal-assist.js
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-ai-proposal-assist.user.js'), 'utf8').replace(/\r\n/g, '\n');
var START = '// ===== APA-LOGIC START', END = '// ===== APA-LOGIC END =====';
var LOGIC = SRC.slice(SRC.indexOf(START), SRC.indexOf(END));
A.ok('logic block sliced', SRC.indexOf(START) > 0 && LOGIC.length > 1000);

function load(code) {
  var ctx = {};
  vm.runInNewContext(code + '\nthis.L={routeOf:routeOf,esc:esc,moneyToCents:moneyToCents,gqlCents:gqlCents,rowsFromGrid:rowsFromGrid,gridFromRows:gridFromRows,' +
    'preflight:preflight,recommendedLines:recommendedLines,parseRanges:parseRanges,buildPrompt:buildPrompt,promptState:promptState,' +
    'opNameOf:opNameOf,errorsOf:errorsOf,payloadOf:payloadOf,checkPreview:checkPreview,installTap:installTap,PROMPT_MAX:PROMPT_MAX,' +
    'propStatus:propStatus,tripStatuses:tripStatuses,tripPlan:tripPlan,tripPrefill:tripPrefill,lineSummary:lineSummary,contextFindings:contextFindings,firstSentence:firstSentence};', ctx);
  return ctx.L;
}
var L = load(LOGIC);
function has(list, level, rx) { return list.some(function (o) { return o.level === level && rx.test(o.msg); }); }

// ---- 1. routes --------------------------------------------------------------------------------
A.eq('vp route', L.routeOf('/work-orders/W1/proposals/vendor-proposals/Q9/details'), { kind: 'vp', wo: 'W1', quoteId: 'Q9' });
A.eq('ai route', L.routeOf('/work-orders/W1/proposals/Q9/ai-preview'), { kind: 'ai', wo: 'W1', quoteId: 'Q9' });
A.eq('other route inert', L.routeOf('/work-orders/W1'), null);
A.eq('deny-listed route inert', L.routeOf('/company/users/5/permissions'), null);
A.eq('vp details sub-path not matched', L.routeOf('/work-orders/W1/proposals/vendor-proposals/Q9/details/x'), null);

// ---- 2. grid by header text ----------------------------------------------------------------
var HDR = ['Total Cost', 'Unit Cost', 'Quantity', 'UOM', 'Trip #', 'Item', 'Trade', 'Category'];   // reversed order on purpose
function row(cat, item, trip, uom, qty, unit, total) { return [total, unit, String(qty), uom, trip, item, 'HVAC', cat]; }
var bad = L.rowsFromGrid(HDR, [
  row('Travel', 'Trip Charge', '1', 'Trip', 2, '$85.00', '$170.00'),
  row('Labor', 'Technician', '1', 'Each', 3, '$95.00', '$285.00'),
  row('Material', 'Materials', '1', 'Lot', 1, '$400.00', '$400.00'),
  row('Material', 'Lift rental', '', '2', 1, '$250.00', '$250.00'),
  row('Labor', '1 Man', '2', 'Hr', 2, '$95.00', '$190.00')
]);
A.eq('grid keyed by header text', [bad[0].item, bad[0].qty, bad[0].unitCost, bad[0].trip], ['Trip Charge', 2, 8500, '1']);
A.eq('grid missing a needed header -> null', L.rowsFromGrid(['Category', 'Item'], [['a', 'b']]), null);
var pf = L.preflight(bad, 100000, null);
A.ok('flags travel name', has(pf, 'fail', /Travel line "Trip Charge" is not named/));
A.ok('flags travel covering multiple trips', has(pf, 'fail', /1 travel line\(s\) cover 2 trips/));
A.ok('flags labor name', has(pf, 'fail', /Labor line "Technician" is not named "N Man"/));
A.ok('flags labor not per hour', has(pf, 'fail', /UOM is "Each", not per hour/));
A.ok('flags single lumped material', has(pf, 'fail', /Single lumped Material line "Materials"/));
A.ok('flags equipment under Material', has(pf, 'warn', /"Lift rental" is filed under Material/));
A.ok('flags missing shipping', has(pf, 'fail', /No Shipping line/));
A.ok('flags missing disposal', has(pf, 'fail', /No Disposal line/));
A.ok('flags blank trip', has(pf, 'fail', /"Lift rental" has a blank Trip #/));
A.ok('flags numeric UOM', has(pf, 'fail', /numeric UOM "2"/));
A.ok('vendor total over NTE', has(L.preflight(bad, 100000, 129500), 'fail', /\$1295\.00 is 1\.3x the client NTE \$1000\.00/));
A.ok('vendor total falls back to summed total cost', has(pf, 'fail', /\$1295\.00 is 1\.3x/));
var good = L.rowsFromGrid(HDR, [
  row('Travel', '2 Man Travel', '1', 'Trip', 1, '$85.00', '$85.00'),
  row('Labor', '2 Man', '1', 'Hr', 3, '$95.00', '$285.00'),
  row('Material', 'Contactor', '1', 'Each', 1, '$40.00', '$40.00'),
  row('Material', 'Shipping', '1', 'Each', 1, '$0.00', '$0.00'),
  row('Other', 'Disposal', '1', 'Each', 1, '$0.00', '$0.00')
]);
var pg = L.preflight(good, 100000, null);
A.ok('clean grid -> no fails', !pg.some(function (o) { return o.level === 'fail'; }), JSON.stringify(pg));
A.ok('clean grid -> within NTE', has(pg, 'ok', /within the client NTE/));
var rec = L.recommendedLines(bad);
A.ok('recommends one travel + labor per trip', rec.filter(function (r) { return /Man Travel$/.test(r.item); }).length === 2 && rec.filter(function (r) { return /^\d+ Man$/.test(r.item); }).length === 2);
A.ok('recommends $0 Shipping and Disposal', rec.some(function (r) { return r.item === 'Shipping' && r.note === '$0'; }) && rec.some(function (r) { return r.item === 'Disposal'; }));
A.ok('recommends equipment out of Material', rec.some(function (r) { return r.item === 'Lift rental' && r.category === 'Equipment'; }));


// ---- 2b. the LIVE vendor grid shape (captured 2026-10-06, values replaced) -----------------------
// Three header rows: a Details/Cost/Tax group row ABOVE the column row (colspans expanded), and a
// blank row below it. Empty Trip # / UOM render as "--". 0.1.0 read headers from all three rows as
// one list and mapped every column after the group row to the wrong cell.
var LIVE = [
  ['', 'Details', '', '', '', '', '', '', 'Cost', '', '', 'Tax', '', '', '', ''],
  ['', '', 'Category', 'Trade', 'Item', '', 'Trip #', 'UOM', 'Quantity', 'Unit Cost', 'Total Cost', 'Taxable', 'Tax %', 'Tax Amount', 'Total Charge', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', 'Travel', 'Exterior Lighting', '', '', '--', '--', '0', '$0.00', '$0.00', 'No', '0%', '$0.00', '$0.00', ''],
  ['', '', 'Labor', 'Exterior Lighting', '', '', '--', '--', '1', '$7,500.00', '$7,500.00', 'No', '0%', '$0.00', '$7,500.00', '']
];
var lg = L.gridFromRows(LIVE);
A.eq('live grid: header row found under the group row', lg && lg.length, 2);
A.eq('live grid: columns land on the right cells', lg && [lg[1].category, lg[1].qty, lg[1].unitCost, lg[1].totalCost], ['Labor', 1, 750000, 750000]);
A.eq('live grid: "--" read as blank', lg && [lg[0].trip, lg[0].uom], ['', '']);
A.ok('live grid: blank Trip # flagged', has(L.preflight(lg, null, null, null), 'fail', /blank Trip #/));
A.ok('vendor total over PO NTE warns', has(L.preflight(lg, null, 750000, 20000), 'warn', /over the vendor PO NTE \$200\.00/));
A.eq('no needed header row -> null', L.gridFromRows([['a', 'b'], ['c', 'd']]), null);
// ---- 3. prompt builder ----------------------------------------------------------------------
var F = { pricingRules: 'Pricing: rate card first.', ranges: 'Lift rental: 200-300', scopeLine: '', issue: 'RTU 3 not cooling.',
  verbatim: 'NEXREV override line', materials: 'Contactor\nShipping',
  trips: 'Trip 1 (Incurred): diagnosed, replaced contactor\nTrip 2 (Proposed): return to verify\nTrip 3 (Proposed): ' };
var P = L.buildPrompt(F);
var order = ['Pricing: rate card first.', 'Non-rate-card ranges: Lift rental $200.00-$300.00.', 'Pilot scope: plain technician text',
  '1. RTU 3 not cooling.', '2. Include verbatim: "NEXREV override line"', '3. "Materials/Equipment:" Contactor, Shipping, Disposal.',
  '4. "Trip 1 (Incurred)": diagnosed, replaced contactor', '5. "Trip 2 (Proposed)": return to verify', 'Bullets under 12 words.'];
var pos = order.map(function (s) { return P.indexOf(s); });
A.ok('template order', pos.every(function (p, i) { return p >= 0 && (i === 0 || p > pos[i - 1]); }), P);
A.ok('a prefilled trip label left empty is dropped', P.indexOf('Trip 3') < 0, P);
A.ok('shipping not duplicated', P.split('Shipping').length === 2);
A.eq('999 chars ok', L.promptState(new Array(1000).join('x')), { n: 999, over: false, warn: true });
A.eq('1000 chars ok (limit inclusive)', L.promptState(new Array(1001).join('x')), { n: 1000, over: false, warn: true });
A.eq('1001 chars hard stop', L.promptState(new Array(1002).join('x')), { n: 1001, over: true, warn: false });
A.eq('949 chars no warn', L.promptState(new Array(950).join('x')).warn, false);

// ---- 4. post-generate checker -----------------------------------------------------------------
A.eq('op from operationName', L.opNameOf(JSON.stringify({ operationName: 'GenerateAIProposalPreview', query: 'mutation GenerateAIProposalPreview' })), 'GenerateAIProposalPreview');
A.eq('op from query text', L.opNameOf(JSON.stringify({ query: 'mutation ReworkAIProposal($d: X) { x }' })), 'ReworkAIProposal');
A.eq('unwatched op ignored', L.opNameOf(JSON.stringify({ operationName: 'GetAIProposalStuff' })), null);
function money(c) { return { amount: c, precision: 2 }; }
var PV = {
  scopeOfWork: 'The Problem: no cooling.\nTrip 1: replaced contactor.',
  reasoning: 'r', estimatedTotal: 150000,
  lineItems: [
    { item: '2 Man Travel', categoryName: 'Travel', unitCost: money(8500), unitCharge: 9000, markUpPercent: 5, chargeQuantity: 2, rateId: 'r1' },
    { item: 'Contactor', categoryName: 'Material', unitCost: money(4000), unitCharge: 3000, markUpPercent: -25, chargeQuantity: 1, rateId: 'r2' },
    { item: 'Fan motor', categoryName: 'Material', unitCost: money(10000), unitCharge: 14000, markUpPercent: 40, chargeQuantity: 1, rateId: 'r3' },
    { item: 'Lift rental', categoryName: 'Equipment', unitCost: money(20000), unitCharge: 35000, markUpPercent: 75, chargeQuantity: 1, rateId: null }
  ]
};
var CTX = { nte: 100000, ranges: L.parseRanges('Lift rental: 200-300'), verbatim: ['NEXREV override line'], trips: 1 };
var ck = L.checkPreview(PV, CTX);
A.ok('unitCharge < unitCost', has(ck, 'fail', /"Contactor" charges \$30\.00, below cost \$40\.00/));
A.ok('negative markup', has(ck, 'fail', /"Contactor" has negative markup -25%/));
A.ok('travel qty vs trips', has(ck, 'fail', /Travel charge quantity totals 2 for 1 trip/));
A.ok('materials markup > 35%', has(ck, 'fail', /"Fan motor" markup 40% is over 35%/));
A.ok('non-rate-card outside range', has(ck, 'fail', /"Lift rental" at \$350\.00 is outside \$200\.00-\$300\.00/));
A.ok('total over NTE', has(ck, 'fail', /\$1500\.00 is over NTE \$1000\.00/));
A.ok('Problem/Solution heading', has(ck, 'fail', /The Problem/));
A.ok('verbatim missing', has(ck, 'fail', /Verbatim line missing/));
A.ok('Materials/Equipment missing', has(ck, 'fail', /Materials\/Equipment section missing/));
var PV2 = JSON.parse(JSON.stringify(PV));
PV2.scopeOfWork = 'Replaced contactor.\nNEXREV   override line\nMaterials/Equipment: Contactor, Shipping, Disposal';
PV2.estimatedTotal = 90000;
PV2.lineItems = [PV.lineItems[0]];
PV2.lineItems[0].chargeQuantity = 1;
var ck2 = L.checkPreview(PV2, CTX);
A.ok('clean preview -> no fails', !ck2.some(function (o) { return o.level === 'fail'; }), JSON.stringify(ck2));
A.ok('verbatim match is whitespace-insensitive', has(ck2, 'pass', /Verbatim line present/));
A.ok('no range -> warn', has(L.checkPreview({ lineItems: [{ item: 'Crane', rateId: null, unitCharge: 1 }] }, { ranges: [] }), 'warn', /no range set/));

var VE = { data: { generateAIProposalPreview: { success: false, message: 'Validation failed', preview: null, validationErrors: [{ propertyName: 'UserPrompt', message: 'must be 1000 characters or fewer' }] } } };
var ve = L.errorsOf(VE);
A.ok('validationErrors surfaced', ve.indexOf('UserPrompt: must be 1000 characters or fewer') >= 0, JSON.stringify(ve));
A.ok('success:false message surfaced', ve.indexOf('Validation failed') >= 0);
A.ok('top-level errors surfaced', L.errorsOf({ errors: [{ message: 'boom', extensions: { validationErrors: ['x too long'] } }] }).join('|') === 'boom|x too long');
A.ok('clean response -> no errors', L.errorsOf({ data: { a: { success: true, preview: {} } } }).length === 0);

// ---- 4b. the LIVE response shape (captured 2026-10-06 as keys + types only; values synthetic) ----
// data.__typename comes FIRST (0.1.0 took data's first key and found no preview), money is
// {amount, precision} objects, and markUpPercent / chargeQuantity / estimatedGrossProfitPercent
// are decimal STRINGS (0.1.0's negative-markup check required typeof number and never fired).
function m(c) { return { __typename: 'Money', amount: c, currency: 'USD', precision: 2 }; }
function line(id, item, cat, cost, charge, mu, qty) {
  return { __typename: 'L', item: item, categoryName: cat, categoryId: 1, sourceLineItemId: id, unitOfMeasurement: 'Each',
    isGenerated: false, revisedDescription: null, unitCost: m(cost), unitCharge: m(charge), markUpPercent: mu, chargeQuantity: qty, rateId: String(70 + id) };
}
var LIVE_RESP = { data: { __typename: 'Mutation', generateAIProposalPreview: { __typename: 'X', success: true, message: '', preview: {
  __typename: 'P', scopeOfWork: 'Reset pole.', reasoning: 'r', estimatedGrossProfitPercent: '12.5',
  estimatedGrossProfit: m(100), estimatedTotal: m(90000), estimatedVendorCost: m(80000),
  lineItems: [
    line(1, '1 Man Travel', 'Travel', 8500, 9000, '5.88', '1'),
    line(2, 'Anchor bolts', 'Material', 4000, 3000, '-25', '2'),
    line(3, 'Pole gasket', 'Material', 1000, 1400, '40', '1')
  ] } } }, extensions: { traceId: 't' } };
var lp = L.payloadOf(LIVE_RESP);
A.ok('live: payload found past data.__typename', !!(lp && lp.preview));
A.eq('live: success response has no errors', L.errorsOf(LIVE_RESP), []);
var lck = L.checkPreview(lp.preview, { nte: 150000, ranges: [], verbatim: [], trips: 1 });
A.ok('live: negative markup as a string is caught', has(lck, 'fail', /"Anchor bolts" has negative markup -25%/));
A.ok('live: materials markup as a string over 35% is caught', has(lck, 'fail', /"Pole gasket" markup 40% is over 35%/));
A.ok('live: below cost from money objects', has(lck, 'fail', /"Anchor bolts" charges \$30\.00, below cost \$40\.00/));
A.ok('live: travel quantity as a string', has(lck, 'pass', /Travel charge quantity matches 1 trip/));
A.ok('live: total from a money object', has(lck, 'pass', /Estimated total \$900\.00 within NTE/));

// ---- 4c. work-order context (0.3.0): shaping of the four read results -------------------------
A.eq('ctx: proposal status from dates', [L.propStatus({}), L.propStatus({ submittedDate: 'x' }), L.propStatus({ submittedDate: 'x', approvedDate: 'y' }),
  L.propStatus({ rejectedDate: 'x' }), L.propStatus({ canceledDate: 'x', approvedDate: 'y' })], ['Draft', 'Submitted', 'Approved', 'Rejected', 'Canceled']);
var POT = [
  { number: 1, vendorName: 'V', trips: [{ number: 1, completedDate: '2026-09-17' }, { number: 2, completedDate: '2026-09-20' }, { number: 3 }, { number: 5, canceledDate: 'x' }] },
  { number: 2, vendorName: 'W', trips: [{ number: 3, completedDate: '2026-09-25' }, { number: 4 }] }
];
A.eq('ctx: trips by number, completed=Incurred, open=Proposed, canceled dropped, any PO completing N wins',
  L.tripStatuses(POT), [{ n: 1, status: 'Incurred' }, { n: 2, status: 'Incurred' }, { n: 3, status: 'Incurred' }, { n: 4, status: 'Proposed' }]);
// Live shape (WO 396190, 2026-10-06): POs record only Trip 1 completed; the earlier client proposal labels 1, 2, 3/4.
var LIVE_POT = [{ number: 1, vendorName: 'V', trips: [{ number: 1, completedDate: '2026-09-17' }] }];
var LIVE_LINES = [{ tripLabel: '1' }, { tripLabel: '1' }, { tripLabel: '2' }, { tripLabel: '3/4' }, { tripLabel: '3/4' }];
A.eq('ctx: trip plan merges PO status with the proposal grouping', L.tripPlan(LIVE_POT, LIVE_LINES), [
  { label: 'Trip 1', status: 'Incurred', assumed: false }, { label: 'Trip 2', status: 'Proposed', assumed: true }, { label: 'Trip 3-4', status: 'Proposed', assumed: true }]);
A.eq('ctx: trip prefill lines', L.tripPrefill(L.tripPlan(LIVE_POT, LIVE_LINES)), 'Trip 1 (Incurred): \nTrip 2 (Proposed): \nTrip 3-4 (Proposed): ');
A.eq('ctx: PO trips with no earlier proposal still listed', L.tripPlan(POT, null).map(function (x) { return x.label + ' ' + x.status; }), ['Trip 1 Incurred', 'Trip 2 Incurred', 'Trip 3 Incurred', 'Trip 4 Proposed']);
A.eq('ctx: no trips anywhere -> empty prefill', L.tripPrefill(L.tripPlan([], [])), '');
function mny(c) { return { amount: c, precision: 2 }; }
A.eq('ctx: line summary uses string chargeQuantity and money objects', L.lineSummary({ item: '3 Man', category: 0, unitCharge: mny(250000), chargeQuantity: '2' }), '3 Man $5000.00');
A.eq('ctx: line summary falls back to the category name', L.lineSummary({ item: null, category: 1, unitCharge: mny(250000), chargeQuantity: '1' }), 'Material $2500.00');
var CX = { proposals: [
  { number: 1, status: 'Submitted', total: 1262874, gp: 0.335, submitted: '2026-10-05T14:00:00Z' },
  { number: 2, status: 'Canceled', total: 1, gp: null, submitted: null }],
  prior: { number: 1, lines: [{ item: '3 Man', category: 0, unitCharge: mny(500000), chargeQuantity: '1' }, { item: 'Concrete', category: 1, unitCharge: mny(250000), chargeQuantity: '1' }] } };
var LUMP = [{ category: 'Labor And Material', item: '', trip: '', qty: 1, totalCost: 750000 }];
var cfx = L.contextFindings(CX, LUMP);
A.ok('ctx: vendor total vs the read client NTE: ratio + keep-NTE-out advice, said once', has(L.preflight(LUMP, 150000, 750000, null), 'fail', /\$7500\.00 is 5x the client NTE \$1500\.00 .*out of the prompt/) &&
  L.preflight(LUMP, 150000, 750000, null).filter(function (o) { return /client NTE/.test(o.msg); }).length === 1 && !cfx.some(function (o) { return /NTE/.test(o.msg); }));
A.ok('ctx: an existing live client proposal is flagged with total, status, date and GP', has(cfx, 'warn', /#1 already exists \(\$12628\.74, Submitted 2026-10-05, 33\.5% GP\)/));
A.ok('ctx: a canceled client proposal is not flagged', !has(cfx, 'warn', /#2 already exists/));
A.ok('ctx: a lumped vendor line gets the earlier split, marked as inference', has(cfx, 'warn', /priced it as: 3 Man \$5000\.00; Concrete \$2500\.00\. That split is an inference/));
A.ok('ctx: no lump hint when the vendor lines are already split', !has(L.contextFindings(CX, LUMP.concat(LUMP).map(function (r, i) { return { category: i ? 'Material' : 'Labor', item: 'x' }; })), 'warn', /Lumped/));
A.eq('ctx: issue prefill is the first sentence of the WO scope', L.firstSentence('Just had a storm and the pole fell.  It was fine before.'), 'Just had a storm and the pole fell.');
// ---- 5. passive tap ---------------------------------------------------------------------------
(function () {
  var sent = [], seen = [], original = { clone: function () { return { json: function () { return Promise.resolve({ data: { x: { success: true } } }); } }; } };
  var win = { fetch: function (u, init) { sent.push([u, init]); return Promise.resolve(original); } };
  L.installTap(win, function (op, j) { seen.push([op, j]); });
  var body = JSON.stringify({ operationName: 'GenerateAIProposalPreview', variables: { data: { quoteId: 'Q', userPrompt: 'p' } } });
  var init = { method: 'POST', body: body, headers: { a: 'b' } };
  win.fetch('/api/graphql', init).then(function (res) {
    A.ok('tap returns the original response object', res === original);
    A.ok('tap passes the request through untouched', sent.length === 1 && sent[0][1] === init && init.body === body);
    return win.fetch('/api/graphql', { body: JSON.stringify({ operationName: 'PagedWorkOrders' }) });
  }).then(function () {
    return new Promise(function (r) { setTimeout(r, 10); });
  }).then(function () {
    A.eq('tap fires once, for the watched op only', seen.map(function (s) { return s[0]; }), ['GenerateAIProposalPreview']);
    A.ok('tap made no request of its own', sent.length === 2);
    statics();
  });
})();

// ---- 6. static read-only contract + negative controls ------------------------------------------
function statics() {
  var meta = SRC.slice(0, SRC.indexOf('// ==/UserScript=='));
  var code = SRC.replace(/^\s*\/\/.*$/gm, '');
  A.ok('@match umbrava only', (meta.match(/@match\s+\S+/g) || []).join() === '@match        https://app.umbrava.com/*');
  A.ok('@grant none only', (meta.match(/@grant\s+\S+/g) || []).join() === '@grant        none');
  A.ok('no @connect', !/@connect/.test(meta));
  A.ok('no .click() anywhere', !/\.click\(/.test(code));
  A.ok('no polling timer', !/setInterval/.test(code));
  // 0.3.0 read contract: the token picker is the suite's canonical block (pinned by the shared-block
  // ledger) and the ONLY place a token or Authorization header appears outside it is apaGql.
  var gqlStart = code.indexOf('  function apaGql('), gqlEnd = code.indexOf('\n  }\n', gqlStart);
  var sharedS = code.indexOf('function isUmbravaToken('), sharedE = code.indexOf('  function apaGql(');
  var outside = code.slice(0, sharedS) + code.slice(gqlEnd);
  A.ok('reads: token / Authorization only in the shared picker and apaGql', gqlStart > 0 && sharedS > 0 &&
    !/authorization|bearer|access_token|auth0|document\.cookie/i.test(outside));
  A.ok('reads: exactly one fetch( call, inside apaGql', (code.match(/fetch\(/g) || []).length === 1 &&
    code.slice(gqlStart, gqlEnd).indexOf("fetch('/api/graphql'") > 0);
  A.ok('reads: no other transport', !/new XMLHttpRequest|sendBeacon|\.open\(['"]|GM_xmlhttpRequest/.test(code));
  A.ok('reads: the app request headers are never read by the tap', !/setRequestHeader|init\.headers|\.headers\.get/.test(code));
  // Slice QUERIES + checkDocument and run them: every op is a named read query; a write is refused.
  var qS = SRC.indexOf('  var QUERIES = Object.freeze({'), qE = SRC.indexOf('  // The single request path.');
  var Q = {}; vm.runInNewContext(SRC.slice(qS, qE) + '\nthis.QUERIES = QUERIES; this.checkDocument = checkDocument;', Q);
  var ops = Object.keys(Q.QUERIES);
  A.eq('reads: the allowlist is exactly the four APA_ reads', ops.sort(), ['APA_ClientProposal', 'APA_ClientProposals', 'APA_Trips', 'APA_WorkOrder']);
  A.ok('reads: every allowlisted document is a named query, no mutation', ops.every(function (op) {
    return Q.QUERIES[op].indexOf('query ' + op + '(') === 0 && !/mutation|subscription/i.test(Q.QUERIES[op]);
  }));
  function throws(fn) { try { fn(); return false; } catch (e) { return true; } }
  A.ok('reads: checkDocument refuses an op outside the allowlist', throws(function () { Q.checkDocument('PatchWorkOrder', 'mutation PatchWorkOrder { x }'); }));
  A.ok('reads: checkDocument refuses a mutation smuggled under an allowlisted name',
    throws(function () { Q.checkDocument('APA_Trips', 'query APA_Trips($j: Int!) { a } mutation X { b }'); }));
  A.ok('reads: no page/skip/take VARIABLES (Core List Heat replays those as the board query)',
    ops.every(function (op) { return !/\$(page|skip|take)\b/.test(Q.QUERIES[op]); }));
  A.ok('no submit/save/approve trigger', !/requestSubmit|\.submit\(|dispatchEvent\(new (Mouse|Pointer)Event/.test(code));
  A.ok('duplicate-init guard', /if \(window\.__bwnApaInit\)[^\n]*return;/.test(SRC) && /window\.__bwnApaInit = VER;/.test(SRC));
  A.ok('activity log stores label + time only', /l\.unshift\(\{ a: label, t: new Date\(\)\.toISOString\(\) \}\)/.test(SRC));
  A.ok('compat message present', SRC.indexOf('layout not recognised — disabled') > 0);
  A.ok('no banned green', !/#39b54a/i.test(SRC));
  var verLine = (meta.match(/@version\s+(\S+)/) || [])[1];
  A.ok('@version == VER', SRC.indexOf("var VER = '" + verLine + "'") > 0);

  // dock launcher (0.2.0): row only on the two routes, no floating fallback, Core classifies the key
  A.ok('dock: registers key ai-proposal', /id: 'bwn:dock:register', key: DOCK_KEY/.test(SRC) && /var DOCK_KEY = 'ai-proposal';/.test(SRC));
  A.ok('dock: unregisters off-route', /dockPresence\(!!rt\);/.test(SRC) && /id: 'bwn:dock:unregister', key: DOCK_KEY/.test(SRC));
  A.ok('dock: panel renders only while opened from the dock', /if \(!rt \|\| !document\.body \|\| !isOpen\) \{ removePanel\(\); return; \}/.test(SRC));
  A.ok('dock: no Show/Hide anchored header left', !/data-act="toggle"/.test(SRC));
  var CORE = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8');
  A.ok('dock: Core policy classifies ai-proposal (fail-closed dock would hide it)', /BWN_DOCK_POLICY\['ai-proposal'\] = \{ minRank: 1, perms: \[\] \}/.test(CORE));
  function mutated(from, to) {
    if (LOGIC.split(from).length !== 2) throw new Error('mutation target not unique: ' + from);
    return load(LOGIC.replace(from, to));
  }
  var M1 = mutated('return c != null && ch != null && ch < c;', 'return false;');
  A.ok('NEG: dropping below-cost check goes red', !has(M1.checkPreview(PV, CTX), 'fail', /below cost/));
  var M2 = mutated('over: n > PROMPT_MAX', 'over: n > PROMPT_MAX + 1');
  A.ok('NEG: off-by-one limit goes red', M2.promptState(new Array(1002).join('x')).over === false);
  var M3 = mutated('num(li.markUpPercent) < 0;', 'num(li.markUpPercent) < -100;');
  A.ok('NEG: weakened negative-markup check goes red', !has(M3.checkPreview(PV, CTX), 'fail', /negative markup/));
  A.finish();
}
