// test-cc-auth.js - behavioral write harness for bwn-cc-auth.user.js (the CC Request modal).
//
// RM-B6 (finding M4): cc-auth is a WRITE-path userscript (it POSTs a credit-card purchase REQUEST
// to the broadway-internal-ops SWA proxy, which vouches the user with Umbrava and forwards to a
// Power Automate approval flow). It had NO behavioral test. This pins the submit path.
//
// HOW (the repo's slice-real-bytes convention, same as test-temp-vendor.js): the REAL FIELDS spec +
// cleanMoney and the REAL `form.addEventListener('submit', ...)` handler are sliced verbatim out of
// bwn-cc-auth.user.js and run in a vm. A fake `form.addEventListener` CAPTURES the shipped handler;
// we then invoke it with a fake DOM (inputs/msg/submit), a controllable authToken + GM_getValue, and
// a SPY gmPost - so the real gate + payload-assembly bytes run, not a restatement. The script is
// never edited (another agent owns the write-logic); we only import its bytes read-only.
//
// WHAT THIS PROVES:
//   - PAYLOAD: a fully-valid submit sends exactly one POST to /api/cc-auth with the x-bwn-key header,
//     every FIELDS key mapped, TotalCost money-cleaned ($1,250.50 -> 1250.50), the Umbrava userToken
//     attached in the BODY, and NO RequesterEmail (the server injects the verified email).
//   - THE GATES (each a NO-OP: zero POSTs go out unless the gate passes):
//       * ingest key absent  -> no POST  (this is the client-side kill switch: with no key the
//                               script cannot write at all - clearing/rotating WO_INGEST_KEY disables it)
//       * Umbrava token absent -> no POST
//       * a required field blank -> no POST
//       * a malformed PurchaseLink -> no POST
//   - the submit button is disabled once a valid write commits (double-submit guard engages).
//
// NEGATIVE CONTROLS (prove the no-op assertions have teeth, not silent passes):
//   - remove the `if (!key)` kill-switch guard -> a keyless submit now DOES fire a POST.
//   - remove the `if (missing.length)` required guard -> a submit missing a required field fires a POST.
//   Each control asserts behavior FLIPS (0 posts -> 1 post); mutate() throws if its target is absent
//   or non-unique, so a control can never silently no-op against drifted source.
//
// WHAT IT DOES NOT PROVE: the server-side vouch / tenant check / approval flow (those live in the SWA
// repo), nor the modal DOM construction (outside the sliced handler). authToken's own correctness is
// pinned by test-shared-block-ledger.js; here it is injected to drive the token-present/absent gate.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-cc-auth.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-cc-auth.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var PROXY_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/cc-auth';

// ---- slice the real bytes ---------------------------------------------------
function sliceRange(src, startAnchor, endAnchor, includeEnd) {
  var a = src.indexOf(startAnchor);
  if (a === -1) throw new Error('START anchor gone from bwn-cc-auth.user.js: ' + JSON.stringify(startAnchor.slice(0, 60)));
  var b = src.indexOf(endAnchor, a + startAnchor.length);
  if (b === -1) throw new Error('END anchor gone from bwn-cc-auth.user.js: ' + JSON.stringify(endAnchor.slice(0, 60)));
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
// opts: { key, token, values (partial inputs override), src (mutated block) }
function makeEnv(opts) {
  opts = opts || {};
  var env = { posts: [] };
  var captured = null;

  // fake DOM inputs, one per FIELDS key; defaults are a fully-valid request.
  var defaults = {
    Date: '2026-08-27', Tracking: '371126', SupplierName: 'Acme Supply Co',
    LineItemDescription: 'Replace two T8 ballasts', TotalCost: '$1,250.50',
    PurchaseLink: 'https://example.com/item', ShippingAddress: '123 Main St'
  };
  var vals = Object.assign({}, defaults, opts.values || {});
  var inputs = {};
  Object.keys(vals).forEach(function (k) { inputs[k] = { value: vals[k] }; });

  var msg = { textContent: '' };
  var submit = { disabled: false, textContent: 'Submit request' };

  var sandbox = {
    Object: Object, Array: Array, String: String, Number: Number, JSON: JSON,
    Promise: Promise, Error: Error, RegExp: RegExp, Date: Date, Math: Math,
    parseInt: parseInt, parseFloat: parseFloat,
    console: { info: function () {}, warn: function () {}, log: function () {} },
    // the fake form CAPTURES the shipped submit handler (host closure)
    form: { addEventListener: function (type, cb) { if (type === 'submit') captured = cb; } },
    msg: msg, inputs: inputs, submit: submit,
    authToken: function () { return opts.token === undefined ? 'TOK.umbrava.good' : opts.token; },
    GM_getValue: function (k, d) { if (k === 'ingest_key') return opts.key === undefined ? 'the-swa-key' : opts.key; return d; },
    GM_setValue: function () {},
    gmPost: function (url, headers, body, timeout) {
      env.posts.push({ url: url, headers: headers, body: body, timeout: timeout });
      return Promise.resolve({ status: 200, json: { ok: true } });
    },
    PROXY_URL: PROXY_URL,
    closeModal: function () {}, toast: function () {}
  };
  vm.createContext(sandbox);
  vm.runInContext('(function () {\n' + (opts.src || BLOCK) + '\n})()', sandbox, { filename: 'cc-auth-slice.js' });
  if (typeof captured !== 'function') throw new Error('the submit handler was not captured - the slice anchors have drifted');
  env.msg = msg; env.submit = submit;
  env.fire = function () { captured({ preventDefault: function () {} }); };
  return env;
}
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

function main() {
  return Promise.resolve().then(function () {
    // ---- happy path: exactly one correct POST -------------------------------
    var e = makeEnv({});
    e.fire();
    return tick().then(function () {
      A.eq('happy: exactly one POST fired', e.posts.length, 1);
      var p = e.posts[0];
      A.eq('POST goes to /api/cc-auth', p.url, PROXY_URL);
      A.eq('x-bwn-key header carries the ingest key', p.headers['x-bwn-key'], 'the-swa-key');
      A.eq('Content-Type is application/json', p.headers['Content-Type'], 'application/json');
      A.eq('timeout is 30000', p.timeout, 30000);
      A.eq('TotalCost is money-cleaned', p.body.TotalCost, '1250.50');
      A.eq('SupplierName rides verbatim', p.body.SupplierName, 'Acme Supply Co');
      A.eq('the Umbrava userToken is attached in the body', p.body.userToken, 'TOK.umbrava.good');
      A.ok('RequesterEmail is NOT sent (server injects it)', !('RequesterEmail' in p.body), JSON.stringify(Object.keys(p.body)));
      A.eq('submit button disabled once the write commits', e.submit.disabled, true);
    });
  }).then(function () {
    // ---- kill switch: no ingest key -> NO POST ------------------------------
    var e = makeEnv({ key: '' });
    e.fire();
    return tick().then(function () {
      A.eq('kill switch: no ingest key -> zero POSTs', e.posts.length, 0);
      A.ok('kill switch: user is told to set the key', /ingest key/i.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- token gate: no Umbrava token -> NO POST ----------------------------
    var e = makeEnv({ token: '' });
    e.fire();
    return tick().then(function () {
      A.eq('token gate: no session token -> zero POSTs', e.posts.length, 0);
      A.ok('token gate: user is told to reload', /session token/i.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- required gate: a blank required field -> NO POST -------------------
    var e = makeEnv({ values: { SupplierName: '' } });
    e.fire();
    return tick().then(function () {
      A.eq('required gate: blank SupplierName -> zero POSTs', e.posts.length, 0);
      A.ok('required gate: names the missing field', /Supplier Name/.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- link gate: a non-http PurchaseLink -> NO POST ----------------------
    var e = makeEnv({ values: { PurchaseLink: 'ftp://nope/x' } });
    e.fire();
    return tick().then(function () {
      A.eq('link gate: malformed PurchaseLink -> zero POSTs', e.posts.length, 0);
      A.ok('link gate: user is told http/https', /http/i.test(e.msg.textContent), e.msg.textContent);
    });
  }).then(function () {
    // ---- NEGATIVE CONTROL 1: remove the kill-switch guard -> keyless fires ---
    var mutated = mutate(BLOCK, 'if (!key) {', 'if (false) {');
    var e = makeEnv({ key: '', src: mutated });
    e.fire();
    return tick().then(function () {
      A.eq('CONTROL: with the kill-switch guard removed, a keyless submit DOES POST', e.posts.length, 1);
      A.eq('CONTROL: and it went out with an empty x-bwn-key', e.posts[0].headers['x-bwn-key'], '');
    });
  }).then(function () {
    // ---- NEGATIVE CONTROL 2: remove the required guard -> missing fires ------
    var mutated = mutate(BLOCK, 'if (missing.length) {', 'if (false) {');
    var e = makeEnv({ values: { SupplierName: '' }, src: mutated });
    e.fire();
    return tick().then(function () {
      A.eq('CONTROL: with the required guard removed, a blank-required submit DOES POST', e.posts.length, 1);
      A.eq('CONTROL: the blank field is sent through', e.posts[0].body.SupplierName, '');
    });
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
