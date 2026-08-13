// test-proposal-copy.js - node harness for bwn-proposal-copy's write path.
// Slices the copy-engine + auth blocks out of the REAL .user.js and runs them
// in a vm with a fake fetch + localStorage. Every mutate() must turn this red.
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-proposal-copy.js
var fs = require('fs'), path = require('path'), vm = require('vm'), A = require('./assert.js');
var SRC = path.join(__dirname, '..', 'bwn-proposal-copy.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = full.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker missing - ' + start);
  if (full.indexOf(start, a + 1) !== -1) throw new Error(what + ': START not unique');
  var b = full.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker missing after start');
  return full.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function mkJwt(p) { return 'h.' + b64url(p) + '.s'; }
var GOOD_TOKEN = mkJwt({ iss: 'https://login.umbrava.com', exp: Math.floor(Date.now()/1000) + 3600 });
var FOREIGN_TOKEN = mkJwt({ iss: 'https://example.auth0.com', exp: Math.floor(Date.now()/1000) + 3600 });

function makeLS(entries) {
  var store = Object.assign({}, entries), ls = {};
  Object.defineProperty(ls, 'getItem', { value: function (k) { return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; } });
  Object.defineProperty(ls, 'setItem', { value: function (k,v) { store[k] = String(v); } });
  Object.keys(store).forEach(function (k) { ls[k] = store[k]; });
  return ls;
}
function makeEnv(opts) {
  opts = opts || {};
  var env = { calls: [] };
  var lsEntries = {};
  if (opts.withToken !== false) lsEntries['@@auth0spajs@@::client::https://app.umbrava.com/api::openid'] = JSON.stringify({ body: { access_token: opts.foreign ? FOREIGN_TOKEN : GOOD_TOKEN } });
  if (opts.roleSlot) lsEntries['bwn:role:last'] = JSON.stringify(opts.roleSlot);
  env.localStorage = makeLS(lsEntries);
  env.fetch = function (url, init) {
    var body = init && init.body ? JSON.parse(init.body) : {};
    env.calls.push({ url: url, op: body.operationName, variables: body.variables });
    var reply = (opts.replies || {})[body.operationName];
    var data = typeof reply === 'function' ? reply(body.variables) : reply;
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data || { data: {} }); } });
  };
  env.console = console; env.Date = Date; env.JSON = JSON; env.Promise = Promise;
  env.atob = global.atob; env.btoa = global.btoa;
  env.document = { addEventListener: function () {} };
  return env;
}
// Load the auth + copy-engine blocks into one context.
var S_CORE = slice('  // ===== auth + gql', '  // ===== ui', 'core block');
function loadCore(env) {
  var ctx = vm.createContext(env);
  vm.runInContext('(function(){' + S_CORE + '\n; this.__api = { pcAuthToken: pcAuthToken, pcGql: pcGql, rank: rank, mapLineItem: mapLineItem, buildCreateVars: buildCreateVars, buildEditVars: buildEditVars, copyProposal: copyProposal }; }).call(globalThis);', ctx);
  return env.__api;
}

(async function () {
  // --- auth: token pick ---
  var e1 = makeEnv({}); var api1 = loadCore(e1);
  A.ok('pcAuthToken returns the umbrava-issuer token', api1.pcAuthToken() === GOOD_TOKEN);
  var e2 = makeEnv({ foreign: true }); var api2 = loadCore(e2);
  A.ok('pcAuthToken rejects a foreign-issuer token', api2.pcAuthToken() === '');
  var e3 = makeEnv({ withToken: false }); var api3 = loadCore(e3);
  A.ok('pcAuthToken returns empty when no token cached', api3.pcAuthToken() === '');

  // --- pcGql: shape + reject paths ---
  var e4 = makeEnv({ replies: { Ping: { data: { pong: 1 } } } }); var api4 = loadCore(e4);
  var d4 = await api4.pcGql('Ping', 'query Ping { pong }', { a: 1 });
  A.eq('pcGql resolves json.data', d4, { pong: 1 });
  A.eq('pcGql sends operationName+query+variables', { op: e4.calls[0].op, v: e4.calls[0].variables }, { op: 'Ping', v: { a: 1 } });
  var e5 = makeEnv({ withToken: false }); var api5 = loadCore(e5);
  var rejected = false; try { await api5.pcGql('Ping', 'query Ping { pong }', {}); } catch (err) { rejected = /token/.test(err.message); }
  A.ok('pcGql rejects with no token (never sends)', rejected && e5.calls.length === 0);
  var e6 = makeEnv({ replies: { Ping: { errors: [{ message: 'boom' }] } } }); var api6 = loadCore(e6);
  var rejected2 = false; try { await api6.pcGql('Ping', 'query Ping { pong }', {}); } catch (err) { rejected2 = /boom/.test(err.message); }
  A.ok('pcGql rejects on GraphQL errors[]', rejected2);

  // --- rank ---
  var fresh = { ok: true, rank: 4, ts: Date.now() };
  var e7 = makeEnv({ roleSlot: fresh }); var api7 = loadCore(e7);
  A.ok('rank() reads a fresh ok slot', api7.rank() === 4);
  var stale = { ok: true, rank: 4, ts: Date.now() - 7 * 3600 * 1000 };
  var e8 = makeEnv({ roleSlot: stale }); var api8 = loadCore(e8);
  A.ok('rank() ignores a stale slot -> null', api8.rank() === null);
  var e9 = makeEnv({}); var api9 = loadCore(e9);
  A.ok('rank() is null when no slot', api9.rank() === null);

  A.finish();
})();
