// test-temp-vendor.js - node harness for bwn-temp-vendor's vendor activate/deactivate writes,
// after they were routed through bwnGqlOp (Core's BWN-OPS wrapper) in 0.3.0.
//
// THE CHANGE, as found in source:
//   temp-vendor activates an inactive vendor (so it can be assigned to a PO) then re-deactivates
//   it. Both are Umbrava mutations (activateVendor / deactivateVendor). 0.3.0 routes them through
//   bwnGqlOp: activateVendor is risk:'high' (it makes a non-compliant vendor assignable), so it
//   passes the wrapper's high-risk confirm gate - temp-vendor confirms in its own panel (vendor +
//   reason spelled out), so it passes confirmed:true. deactivateVendor is moderate. Both now carry
//   a correlation id + a shared audit entry, and the wrapper owns the success:false rejection.
//
// WHAT THIS PROVES, against the REAL shipped bytes (the BWN-SHARED..write block is sliced out of
// bwn-temp-vendor.user.js and run in a vm with a fake fetch + localStorage - the REAL bwnGqlOp
// runs, not a stub, so the confirm gate is genuinely exercised):
//   - activate resolves the reason id BY NAME (not the hardcoded floor) then fires activateVendor
//     with { vendorId, activationReasonId, notes }, and records an audit entry outcome:ok with the
//     vendorId + before/after + a corrId;
//   - deactivate fires deactivateVendor and audits it;
//   - a success:false envelope REJECTS (bwnGqlOp owns it) and audits outcome:'error';
//   - the high-risk confirm gate is load-bearing: with confirmed:true dropped, activate is refused
//     before any activateVendor call goes out.
//
// WHAT IT DOES NOT PROVE:
//   - that activateVendor/deactivateVendor exist on the live schema (only a real vendor does; the
//     live gate is one temp-activate + re-deactivate). The panel DOM lives outside the slice.
//
// The wrapper's own contract (retry, kill switch, audit shape) is proven in test-bwn-ops.js, which
// also SHA-gates this file's BWN-OPS-WRAP byte-identical to Core.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-temp-vendor.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-temp-vendor.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var START = '  // ===== BWN-SHARED START v1';
var END = '  // ===== Pending state';

function slice(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error('START marker not found - the write block is gone from bwn-temp-vendor.user.js');
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error('END marker not found after start');
  return src.slice(a, b);
}
var S_BLOCK = slice(full);

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- Environment ------------------------------------------------------------
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
var GOOD_TOKEN = 'h.' + b64url({ iss: 'https://login.umbrava.com', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

function makeEnv(opts) {
  opts = opts || {};
  var replies = opts.replies || {};
  var env = { calls: [], store: {} };
  if (opts.withToken !== false) env.store['@@auth0spajs@@::c::https://app.umbrava.com/api::openid'] = JSON.stringify({ body: { access_token: GOOD_TOKEN } });
  // authToken() enumerates Object.keys(localStorage) to find the @@auth0spajs@@ slot, so the store
  // keys must be ENUMERABLE own properties; the methods are non-enumerable.
  var localStorage = {};
  Object.keys(env.store).forEach(function (k) { localStorage[k] = env.store[k]; });
  Object.defineProperty(localStorage, 'getItem', { value: function (k) { return Object.prototype.hasOwnProperty.call(env.store, k) ? env.store[k] : null; }, enumerable: false });
  Object.defineProperty(localStorage, 'setItem', { value: function (k, v) { env.store[k] = String(v); localStorage[k] = String(v); }, enumerable: false });
  Object.defineProperty(localStorage, 'removeItem', { value: function (k) { delete env.store[k]; delete localStorage[k]; }, enumerable: false });
  env.fetch = function (url, o) {
    o = o || {};
    var parsed = JSON.parse(o.body);
    var rec = { op: parsed.operationName, vars: parsed.variables };
    env.calls.push(rec);
    var r = replies[parsed.operationName];
    var reply = (typeof r === 'function') ? r(rec) : r;
    if (reply && reply.__throw) return Promise.reject(new Error('network'));
    var body = (reply && reply.errors) ? reply : { data: reply };
    return Promise.resolve({ json: function () { return Promise.resolve(body); } });
  };
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, JSON: JSON, Promise: Promise,
    Error: Error, RegExp: RegExp, Date: Date, Math: Math, parseInt: parseInt,
    console: { info: function () {}, warn: function () {}, log: function () {} },
    atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
    setTimeout: function (fn) { return setTimeout(fn, 0); }, window: {},
    fetch: env.fetch, localStorage: localStorage,
    // constants the write block references but that live above the sliced region
    ACT_REASON_NAME: 'Temporary Activation', DEACT_REASON_NAME: 'Pending Compliance',
    ACT_REASON_FLOOR: 3, DEACT_REASON_FLOOR: 2,
    ACT_NOTE: 'act note', DEACT_NOTE: 'deact note'
  };
  vm.createContext(sandbox);
  env.api = vm.runInContext(
    '(function () {\n' + (opts.src || S_BLOCK) + '\n' +
    'return { tvActivate: tvActivate, tvDeactivate: tvDeactivate, tvReasonId: tvReasonId,\n' +
    '  M_ACTIVATE: M_ACTIVATE, M_DEACTIVATE: M_DEACTIVATE, audit: bwnAuditAll };\n})()',
    sandbox, { filename: 'temp-vendor.js' });
  return env;
}
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
function actReasons() { return { vendorActivationReasons: { success: true, value: [{ id: 0, value: 'Insurance Updated' }, { id: 7, value: 'Temporary Activation' }] } }; }
function deactReasons() { return { vendorDeactivationReasons: { success: true, value: [{ id: 2, value: 'Pending Compliance' }] } }; }

function main() {
  var VENDOR = { id: 'vend-guid-1', number: '27606', companyName: 'OEM Laundry' };

  // ---- activate: reason-by-name, activateVendor fires, audited ok ----
  var e1 = makeEnv({ replies: {
    TvActReasons: actReasons(),
    TvActivateVendor: { activateVendor: { success: true, message: '' } }
  } });
  return e1.api.tvActivate(VENDOR).then(function (r) {
    var act = e1.calls.filter(function (c) { return c.op === 'TvActivateVendor'; });
    A.eq('exactly one activateVendor fired', act.length, 1);
    A.eq('activate carries the vendor GUID', act[0].vars.data.vendorId, 'vend-guid-1');
    A.eq('activation reason resolved BY NAME (7), not the floor (3)', act[0].vars.data.activationReasonId, 7);
    A.ok('activate resolves to the mutation result', r && r.success === true, JSON.stringify(r));
    var log = e1.api.audit();
    var a = log[log.length - 1];
    A.ok('the activate is audited outcome:ok', a && a.op === 'activateVendor' && a.outcome === 'ok' && a.risk === 'high', JSON.stringify(a));
    A.ok('the audit carries the vendorId + a corrId', a && a.ids && a.ids.vendorId === 'vend-guid-1' && /^bwn-/.test(String(a.corrId)), JSON.stringify(a && a.ids));
    A.eq('the audit before/after are the scalar status change', [a.before, a.after], [{ status: 'Inactive' }, { status: 'Active' }]);
  }).then(function () {
    // ---- deactivate: deactivateVendor fires, audited ----
    var e2 = makeEnv({ replies: {
      TvDeactReasons: deactReasons(),
      TvDeactivateVendor: { deactivateVendor: { success: true, message: '' } }
    } });
    return e2.api.tvDeactivate(VENDOR).then(function () {
      var de = e2.calls.filter(function (c) { return c.op === 'TvDeactivateVendor'; });
      A.eq('exactly one deactivateVendor fired', de.length, 1);
      A.eq('deactivate carries the vendor GUID', de[0].vars.data.vendorId, 'vend-guid-1');
      var log = e2.api.audit();
      A.ok('the deactivate is audited (moderate)', log.some(function (x) { return x.op === 'deactivateVendor' && x.outcome === 'ok'; }), JSON.stringify(log));
    });
  }).then(function () {
    // ---- success:false rejects (bwnGqlOp owns it) + audits error ----
    var e3 = makeEnv({ replies: {
      TvActReasons: actReasons(),
      TvActivateVendor: { activateVendor: { success: false, message: 'compliance hold' } }
    } });
    var rejected = false, msg = '';
    return e3.api.tvActivate(VENDOR).then(function () {}, function (err) { rejected = true; msg = err && err.message; }).then(function () {
      A.ok('a success:false activate REJECTS', rejected, 'resolved but should reject');
      A.eq('the server message surfaces', msg, 'compliance hold');
      var log = e3.api.audit();
      A.ok('the failed activate is audited outcome:error', log.some(function (x) { return x.op === 'activateVendor' && x.outcome === 'error'; }), JSON.stringify(log));
    });
  }).then(function () {
    // ---- control: drop confirmed:true -> the high-risk gate refuses BEFORE any activate call ----
    var mutated = mutate(S_BLOCK, 'confirmed: true,', 'confirmed: false,');
    var e4 = makeEnv({ src: mutated, replies: {
      TvActReasons: actReasons(),
      TvActivateVendor: { activateVendor: { success: true } }
    } });
    var refused = false;
    return e4.api.tvActivate(VENDOR).then(function () {}, function () { refused = true; }).then(function () {
      A.ok('CONTROL: without confirmed:true the high-risk activate is refused', refused);
      A.eq('CONTROL: and no activateVendor call went out', e4.calls.filter(function (c) { return c.op === 'TvActivateVendor'; }).length, 0);
    });
  }).then(function () {
    // ---- control: rename the op -> unregistered -> bwnGqlOp rejects, no call ----
    var mutated = mutate(S_BLOCK, "bwnGqlOp('activateVendor'", "bwnGqlOp('activateVendorX'");
    var e5 = makeEnv({ src: mutated, replies: { TvActReasons: actReasons(), TvActivateVendor: { activateVendor: { success: true } } } });
    var refused = false;
    return e5.api.tvActivate(VENDOR).then(function () {}, function () { refused = true; }).then(function () {
      A.ok('CONTROL: an unregistered op is refused', refused);
      A.eq('CONTROL: and nothing was sent', e5.calls.filter(function (c) { return c.op === 'TvActivateVendor'; }).length, 0);
    });
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
