// test-cc-purchase.js - behavioral write harness for bwn-cc-purchase.user.js (the Log CC Purchase modal).
//
// RM-B6 (finding M4): cc-purchase is a WRITE-path userscript (SUPERVISOR+ logs a completed credit-card
// purchase; it POSTs to the broadway-internal-ops SWA proxy, which re-checks rank with Umbrava and
// forwards to a Power Automate flow that writes Credit Card Tracker.xlsx + emails). An optional receipt
// is uploaded FIRST via /api/cc-receipt and its link folded into the purchase POST. It had NO behavioral
// test. This pins the submit path incl. the receipt-first ordering.
//
// HOW (the repo's slice-real-bytes convention, same as test-temp-vendor.js / test-cc-auth.js): the REAL
// FIELDS spec + cleanMoney and the REAL `form.addEventListener('submit', ...)` handler are sliced verbatim
// out of bwn-cc-purchase.user.js and run in a vm. A fake `form.addEventListener` CAPTURES the shipped
// handler; we invoke it with a fake DOM, a controllable authToken + GM_getValue, a fake receiptInput +
// readFileB64, and a SPY gmPost - so the real gate + payload bytes run, not a restatement. The script is
// never edited (another agent owns the write-logic); we import its bytes read-only.
//
// WHAT THIS PROVES:
//   - PAYLOAD: a fully-valid submit with no receipt sends exactly one POST to /api/cc-purchase, x-bwn-key
//     header set, every FIELDS key mapped, TotalAmount money-cleaned, actor = the signed-in email, the
//     Umbrava userToken attached, and NO ReceiptLink. The "+ Add / manage cards" select sentinel resolves
//     to '' (never sent as a card value).
//   - RECEIPT-FIRST: with a receipt attached, the receipt uploads to /api/cc-receipt BEFORE the purchase
//     POST; the returned link rides the purchase body as ReceiptLink, and the receipt body carries the
//     file bytes + userToken.
//   - THE GATES (each a NO-OP: zero purchase POSTs unless the gate passes):
//       * ingest key absent  -> no POST  (client-side kill switch: no key = the script cannot write)
//       * Umbrava token absent -> no POST
//       * a required field blank -> no POST
//       * an oversized receipt (> 10 MB) -> no POST
//       * a FAILED receipt upload -> no purchase POST (the receipt failure blocks the log, by design)
//
// NEGATIVE CONTROLS (prove the no-op assertions have teeth):
//   - remove the `if (!key)` kill-switch guard -> a keyless submit DOES fire a purchase POST.
//   - remove the `if (missing.length)` required guard -> a blank-required submit DOES fire a POST.
//   mutate() throws if its target is absent or non-unique, so a control can never silently no-op.
//
// WHAT IT DOES NOT PROVE: the server-side rank re-check / Graph receipt upload / tracker write (SWA repo),
// nor the modal DOM. authToken correctness is pinned by test-shared-block-ledger.js; here it is injected.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-cc-purchase.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-cc-purchase.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
var PROXY_URL = BASE + '/api/cc-purchase';
var RECEIPT_URL = BASE + '/api/cc-receipt';
var MAX_RECEIPT = 10 * 1024 * 1024;
var ADD_CARD = '__add_card__';

// ---- slice the real bytes ---------------------------------------------------
function sliceRange(src, startAnchor, endAnchor, includeEnd) {
  var a = src.indexOf(startAnchor);
  if (a === -1) throw new Error('START anchor gone from bwn-cc-purchase.user.js: ' + JSON.stringify(startAnchor.slice(0, 60)));
  var b = src.indexOf(endAnchor, a + startAnchor.length);
  if (b === -1) throw new Error('END anchor gone from bwn-cc-purchase.user.js: ' + JSON.stringify(endAnchor.slice(0, 60)));
  return src.slice(a, includeEnd ? b + endAnchor.length : b);
}
var CLEANMONEY_LINE = "function cleanMoney(v) { return String(v || '').replace(/[^0-9.\\-]/g, ''); }";
var FIELDS_BLOCK = sliceRange(full, 'var FIELDS = [', CLEANMONEY_LINE, true);
var HANDLER_BLOCK = sliceRange(full, "form.addEventListener('submit', function (e) {", 'card.appendChild(head)', false);
var BLOCK = FIELDS_BLOCK + '\n' + HANDLER_BLOCK;

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- environment ------------------------------------------------------------
// opts: { key, token, values, file, receiptReply, src }
function makeEnv(opts) {
  opts = opts || {};
  var env = { posts: [] };
  var captured = null;

  var defaults = {
    Date: '2026-08-27', CardUser: 'Jane Coordinator', CardUsed: 'Amex ...1007',
    SupplierName: 'Acme Supply Co', Subtotal: '$100.00', TaxAmount: '$8.00',
    TotalAmount: '$108.00', LineItemDescription: 'Two T8 ballasts', PurchaseLink: '',
    WorkOrderNumber: '371126'
  };
  var vals = Object.assign({}, defaults, opts.values || {});
  var inputs = {};
  Object.keys(vals).forEach(function (k) { inputs[k] = { value: vals[k] }; });

  var msg = { textContent: '' };
  var submit = { disabled: false, textContent: 'Submit purchase' };
  var receiptInput = { files: opts.file ? [opts.file] : [] };

  var sandbox = {
    Object: Object, Array: Array, String: String, Number: Number, JSON: JSON,
    Promise: Promise, Error: Error, RegExp: RegExp, Date: Date, Math: Math,
    parseInt: parseInt, parseFloat: parseFloat,
    console: { info: function () {}, warn: function () {}, log: function () {} },
    form: { addEventListener: function (type, cb) { if (type === 'submit') captured = cb; } },
    msg: msg, inputs: inputs, submit: submit, receiptInput: receiptInput,
    me: { email: 'jane@broadwaynational.com', name: 'Jane Coordinator' },
    ADD_CARD: ADD_CARD,
    MAX_RECEIPT: MAX_RECEIPT, RECEIPT_URL: RECEIPT_URL, PROXY_URL: PROXY_URL,
    authToken: function () { return opts.token === undefined ? 'TOK.umbrava.good' : opts.token; },
    GM_getValue: function (k, d) { if (k === 'ingest_key') return opts.key === undefined ? 'the-swa-key' : opts.key; return d; },
    GM_setValue: function () {},
    readFileB64: function () { return Promise.resolve({ filename: 'receipt.pdf', contentType: 'application/pdf', dataB64: 'QUJD' }); },
    gmPost: function (url, headers, body, timeout) {
      env.posts.push({ url: url, headers: headers, body: body, timeout: timeout });
      if (url === RECEIPT_URL) return Promise.resolve(opts.receiptReply || { status: 200, json: { ok: true, link: 'https://sharepoint/receipt.pdf' } });
      return Promise.resolve({ status: 200, json: { ok: true } });
    },
    closeModal: function () {}, toast: function () {}
  };
  vm.createContext(sandbox);
  vm.runInContext('(function () {\n' + (opts.src || BLOCK) + '\n})()', sandbox, { filename: 'cc-purchase-slice.js' });
  if (typeof captured !== 'function') throw new Error('the submit handler was not captured - the slice anchors have drifted');
  env.msg = msg; env.submit = submit;
  env.fire = function () { captured({ preventDefault: function () {} }); };
  return env;
}
// two ticks: the purchase POST rides a Promise .then chain (receipt promise -> purchase gmPost).
function settle() { return new Promise(function (r) { setTimeout(r, 0); }).then(function () { return new Promise(function (r) { setTimeout(r, 0); }); }); }

function main() {
  return Promise.resolve().then(function () {
    // ---- happy path, no receipt: one correct POST ---------------------------
    var e = makeEnv({});
    e.fire();
    return settle().then(function () {
      A.eq('happy: exactly one POST fired', e.posts.length, 1);
      var p = e.posts[0];
      A.eq('POST goes to /api/cc-purchase', p.url, PROXY_URL);
      A.eq('x-bwn-key header carries the ingest key', p.headers['x-bwn-key'], 'the-swa-key');
      A.eq('timeout is 30000', p.timeout, 30000);
      A.eq('TotalAmount is money-cleaned', p.body.TotalAmount, '108.00');
      A.eq('actor is the signed-in email', p.body.actor, 'jane@broadwaynational.com');
      A.eq('the Umbrava userToken is attached in the body', p.body.userToken, 'TOK.umbrava.good');
      A.ok('no ReceiptLink when no receipt', !('ReceiptLink' in p.body), JSON.stringify(Object.keys(p.body)));
      A.eq('submit button disabled once the write commits', e.submit.disabled, true);
    });
  }).then(function () {
    // ---- the "+ Add / manage cards" sentinel never rides as a card value ----
    var e = makeEnv({ values: { CardUsed: ADD_CARD } });
    e.fire();
    return settle().then(function () {
      A.eq('sentinel: still one POST', e.posts.length, 1);
      A.eq('sentinel: ADD_CARD resolves to empty CardUsed', e.posts[0].body.CardUsed, '');
    });
  }).then(function () {
    // ---- receipt-first: upload then purchase, link folded in ----------------
    var e = makeEnv({ file: { name: 'receipt.pdf', size: 2048, type: 'application/pdf' } });
    e.fire();
    return settle().then(function () {
      A.eq('receipt: two POSTs fired', e.posts.length, 2);
      A.eq('receipt uploads FIRST', e.posts[0].url, RECEIPT_URL);
      A.eq('then the purchase POST', e.posts[1].url, PROXY_URL);
      A.eq('receipt body carries the filename', e.posts[0].body.filename, 'receipt.pdf');
      A.eq('receipt body carries the base64 bytes', e.posts[0].body.dataB64, 'QUJD');
      A.eq('receipt body carries the userToken', e.posts[0].body.userToken, 'TOK.umbrava.good');
      A.eq('receipt timeout is 60000', e.posts[0].timeout, 60000);
      A.eq('the returned link rides the purchase as ReceiptLink', e.posts[1].body.ReceiptLink, 'https://sharepoint/receipt.pdf');
    });
  }).then(function () {
    // ---- oversized receipt -> NO POST ---------------------------------------
    var e = makeEnv({ file: { name: 'big.pdf', size: MAX_RECEIPT + 1, type: 'application/pdf' } });
    e.fire();
    return settle().then(function () {
      A.eq('oversized receipt -> zero POSTs', e.posts.length, 0);
      A.ok('oversized receipt: user is told the 10 MB limit', /10 MB/.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- a failed receipt upload BLOCKS the purchase POST -------------------
    var e = makeEnv({ file: { name: 'r.pdf', size: 2048, type: 'application/pdf' }, receiptReply: { status: 500, json: { ok: false, error: 'graph down' } } });
    e.fire();
    return settle().then(function () {
      A.eq('failed receipt: only the receipt attempt went out, NOT the purchase', e.posts.length, 1);
      A.eq('failed receipt: the one POST was the receipt', e.posts[0].url, RECEIPT_URL);
      A.ok('failed receipt: user sees the upload failure', /Receipt upload failed/.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- kill switch: no ingest key -> NO POST ------------------------------
    var e = makeEnv({ key: '' });
    e.fire();
    return settle().then(function () {
      A.eq('kill switch: no ingest key -> zero POSTs', e.posts.length, 0);
      A.ok('kill switch: user is told to set the key', /ingest key/i.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- token gate: no token -> NO POST ------------------------------------
    var e = makeEnv({ token: '' });
    e.fire();
    return settle().then(function () {
      A.eq('token gate: no session token -> zero POSTs', e.posts.length, 0);
    });
  }).then(function () {
    // ---- required gate: blank TotalAmount -> NO POST ------------------------
    var e = makeEnv({ values: { TotalAmount: '' } });
    e.fire();
    return settle().then(function () {
      A.eq('required gate: blank TotalAmount -> zero POSTs', e.posts.length, 0);
      A.ok('required gate: names the missing field', /Total Amount/.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- NEGATIVE CONTROL 1: remove the kill-switch guard -> keyless fires ---
    var mutated = mutate(BLOCK, 'if (!key) {', 'if (false) {');
    var e = makeEnv({ key: '', src: mutated });
    e.fire();
    return settle().then(function () {
      A.eq('CONTROL: with the kill-switch guard removed, a keyless submit DOES POST', e.posts.length, 1);
      A.eq('CONTROL: and it went out with an empty x-bwn-key', e.posts[0].headers['x-bwn-key'], '');
    });
  }).then(function () {
    // ---- NEGATIVE CONTROL 2: remove the required guard -> missing fires ------
    var mutated = mutate(BLOCK, 'if (missing.length) {', 'if (false) {');
    var e = makeEnv({ values: { TotalAmount: '' }, src: mutated });
    e.fire();
    return settle().then(function () {
      A.eq('CONTROL: with the required guard removed, a blank-required submit DOES POST', e.posts.length, 1);
      A.eq('CONTROL: the blank field is sent through', e.posts[0].body.TotalAmount, '');
    });
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
