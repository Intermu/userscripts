// test-po-approval-clicked-row.js - PO Approval's "which PO row opened this modal" NTE path in
// bwn-suite-core.user.js (module "PO Approval + ETA Builder", v1.14).
//
// The Send Purchase Order modal is opened from one PO row's "..." menu
// ([data-testid="purchase-order-popper-menu"] inside [data-testid="POAccordion-<n>"]). A capture-phase
// click listener remembers that row; clickedRowNTE() then returns its largest positive $ amount, as long
// as the click is under 10 minutes old and the row at that testid still shows the same vendor.
//
// Drives the REAL shipped bytes: slices rowVendor / rowAmounts / clickedRowNTE and the listener block out
// of the PO Approval module region, runs them against a tiny fake DOM, and carries negative controls.
// W-390539 shape: row 1 a canceled $0.00 PO, row 2 the real vendor at $500.00. Synthetic vendor names.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-po-approval-clicked-row.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');

function once(src, needle, where) {
  var a = src.indexOf(needle);
  if (a === -1) throw new Error('not found in ' + where + ': ' + needle);
  if (src.indexOf(needle, a + 1) !== -1) throw new Error('not unique in ' + where + ': ' + needle);
  return a;
}
var REGION = (function () {
  var a = once(SRC, '// MODULE: PO Approval + ETA Builder', 'Core');
  var b = once(SRC, '// MODULE: WO Assist', 'Core');
  return SRC.slice(a, b);
})();
function sliceFn(src, decl) {
  var a = once(src, decl, 'PO Approval module');
  var depth = 0, i = src.indexOf('{', a);
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced braces after ' + decl);
}
var LISTENER = (function () {
  var a = once(REGION, 'var lastPoMenu = null;', 'PO Approval module');
  var b = REGION.indexOf('}, true);', a);
  return REGION.slice(a, b + '}, true);'.length);
})();
var BODY = sliceFn(REGION, 'function rowVendor(') + '\n' + sliceFn(REGION, 'function rowAmounts(') + '\n' +
  LISTENER + '\n' + sliceFn(REGION, 'function clickedRowNTE(');

// Fake DOM: rows with a vendor link and text; menu buttons whose closest() walks to their row.
function mkRow(n, vendor, text) {
  var row = { tid: 'POAccordion-' + n, vendor: vendor, textContent: text };
  row.getAttribute = function () { return row.tid; };
  row.querySelector = function (sel) {
    return sel === '[data-testid="purchase-order-vendor-link"]' ? { textContent: row.vendor } : null;
  };
  row.menu = { closest: function (sel) {
    if (sel === '[data-testid="purchase-order-popper-menu"]') return row.menu;
    if (sel === '[data-testid^="POAccordion-"]') return row;
    return null;
  } };
  return row;
}
function load(src) {
  var env = { now: 1000000, rows: [], click: null };
  var doc = {
    addEventListener: function (type, fn, cap) { if (type === 'click' && cap === true) env.click = fn; },
    querySelector: function (sel) {
      for (var i = 0; i < env.rows.length; i++) if (sel === '[data-testid="' + env.rows[i].tid + '"]') return env.rows[i];
      return null;
    }
  };
  var fmtMoney = function (n) { return '$' + n.toFixed(2); };
  var api = new Function('document', 'Date', 'fmtMoney',
    src + '\nreturn { nte: clickedRowNTE };')(doc, { now: function () { return env.now; } }, fmtMoney);
  api.env = env;
  api.clickMenu = function (row) { env.click({ target: row.menu }); };
  api.clickElsewhere = function () { env.click({ target: { closest: function () { return null; } } }); };
  return api;
}
function scene(src) {
  var S = load(src);
  S.env.rows = [
    mkRow(1, 'Quiet Yard Signs, Inc', '00108/27/2026CanceledQuiet Yard Signs, Inc$0.00Scheduled Date--'),
    mkRow(2, 'The Quiet Yard Electrical Maintenance, Inc.', '00209/02/2026OpenThe Quiet Yard Electrical Maintenance, Inc.$500.00Scheduled Date--')
  ];
  return S;
}

var S = scene(BODY);
A.ok('listener is registered in the capture phase', typeof S.env.click === 'function');
A.eq('no row clicked yet -> null (falls back to recipient matching)', S.nte(), null);
S.clickMenu(S.env.rows[1]);
A.eq('row 2 menu clicked -> row 2 amount', S.nte(), '$500.00');
S.clickElsewhere();
A.eq('a click outside any PO menu keeps the remembered row', S.nte(), '$500.00');
S.clickMenu(S.env.rows[0]);
A.eq('row with only $0.00 -> null, never "$0.00"', S.nte(), null);

var S2 = scene(BODY);
S2.clickMenu(S2.env.rows[1]);
S2.env.now += 10 * 60000 + 1;
A.eq('click older than 10 min -> null', S2.nte(), null);

var S3 = scene(BODY);
S3.clickMenu(S3.env.rows[1]);
S3.env.rows[1].vendor = 'Someone Else LLC';
A.eq('same testid but a different vendor (render index moved) -> null', S3.nte(), null);

var S4 = scene(BODY);
S4.clickMenu(S4.env.rows[1]);
S4.env.rows = [];
A.eq('row no longer rendered -> null', S4.nte(), null);

A.ok('findNTE tries the clicked row before recipient matching',
  sliceFn(REGION, 'function findNTE(').indexOf('clickedRowNTE()') < sliceFn(REGION, 'function findNTE(').indexOf('recipientsRaw(modal)'));

// ---- negative controls --------------------------------------------------------------------------
function mutate(from, to) {
  var i = BODY.indexOf(from);
  if (i === -1 || BODY.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET ABSENT OR NOT UNIQUE: ' + from);
  return BODY.slice(0, i) + to + BODY.slice(i + from.length);
}
var M1 = scene(mutate(' || rowVendor(row) !== lastPoMenu.vendor', ''));
M1.clickMenu(M1.env.rows[1]); M1.env.rows[1].vendor = 'Someone Else LLC';
A.ok('mutant: drop the vendor check -> moved-index probe goes red', M1.nte() !== null);
var M2 = scene(mutate(' || Date.now() - lastPoMenu.t > 10 * 60000', ''));
M2.clickMenu(M2.env.rows[1]); M2.env.now += 10 * 60000 + 1;
A.ok('mutant: drop the age check -> stale-click probe goes red', M2.nte() !== null);

A.finish();
