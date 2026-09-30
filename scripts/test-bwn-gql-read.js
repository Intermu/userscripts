// test-bwn-gql-read.js - node harness for bwnGqlRead(), the classified GraphQL read envelope added
// beside bwnGql() in bwn-suite-core 1.87.0.
//
// WHAT THIS PROVES, against the REAL shipped bytes (sliced from bwn-suite-core.user.js and run in a vm
// against a stub fetch + authToken):
//   - bwnGqlRead never rejects: every fixture below resolves an envelope { kind status noToken data codes messageLen }.
//   - kind classification: 200 data -> 'ok'; 200 data + errors -> 'partial'; 200 errors only -> 'graphql-error'
//     with extensions.code surfaced in `codes`; 400 JSON with no errors[] -> 'http-400'; tokenless 500 HTML ->
//     'http-5xx-no-json' with noToken:true; 200 malformed JSON -> 'bad-json'; fetch rejection -> 'network'.
//   - the envelope carries error message LENGTHS, never message text (a server-authored message with a
//     fixture marker in it must not appear anywhere in the envelope).
//   - bwnGql()'s own contract is intact: resolves data, throws errors[0].message (the classified read is an
//     ADDITION, not a replacement).
//   - the PO shadow reader (fetchPOs) reads through bwnGqlRead, and the per-script transport copies in the
//     other userscripts do not contain a bwnGqlRead (this stays Core-only until a consumer needs it).
//   - a body stream that dies mid-read (r.text() rejecting) still resolves an envelope (bad-json) - the
//     never-rejects contract holds on BOTH rejection paths, not just the fetch one.
//   - extensions.code is server-authored: it is shape-gated (identifier-shaped or "othercode") and capped at 5.
//   - the one bwnGqlRead call site in Core is handed a document that begins with `query ` - reads only.
//   - three negative controls must turn this harness red: partial collapsed onto ok, codes dropped, network
//     misclassified as ok.
//
// Fixtures are synthetic. Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bwn-gql-read.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return coreFull.slice(a, b);
}
var S_READ = slice('// ===== BWN-GQL-READ START v1', '// ===== BWN-GQL-READ END v1', 'gql-read block');
var GQL_START = coreFull.indexOf('  function bwnGql(query, variables) {');
var S_GQL = coreFull.slice(GQL_START, coreFull.indexOf('// ===== BWN-GQL-READ START v1'));
if (GQL_START === -1 || !/function bwnGql\(/.test(S_GQL)) throw new Error('bwnGql slice not found');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// A fixture is { status, body (string) } or { reject: Error }.
function makeEnv(readSrc, fixture, token) {
  var calls = [];
  var sandbox = {
    Object: Object, Array: Array, String: String, JSON: JSON, Promise: Promise, Error: Error,
    authToken: function () { return token; },
    fetch: function (url, init) {
      calls.push({ url: url, init: init });
      if (fixture.reject) return Promise.reject(fixture.reject);
      return Promise.resolve({ status: fixture.status, text: function () { return fixture.textReject ? Promise.reject(fixture.textReject) : Promise.resolve(fixture.body); } });
    }
  };
  vm.createContext(sandbox);
  var api = vm.runInContext('(function () {\n' + readSrc + '\nreturn { bwnGqlRead: bwnGqlRead, bwnGqlClassify: bwnGqlClassify }; })()', sandbox, { filename: 'gql-read.js' });
  return { read: api.bwnGqlRead, classify: api.bwnGqlClassify, calls: calls };
}
function makeGql(fixture) {
  var sandbox = {
    Object: Object, Array: Array, String: String, JSON: JSON, Promise: Promise, Error: Error,
    authToken: function () { return 'tok'; },
    fetch: function () { return Promise.resolve({ json: function () { return Promise.resolve(JSON.parse(fixture.body)); } }); }
  };
  vm.createContext(sandbox);
  return vm.runInContext('(function () {\n' + S_GQL + '\nreturn bwnGql; })()', sandbox, { filename: 'gql.js' });
}

var MARK = 'ZQX-SERVER-MESSAGE-MARKER';
var FIX = {
  ok: { status: 200, body: JSON.stringify({ data: { workOrder: { number: 100001 } } }) },
  partial: { status: 200, body: JSON.stringify({ data: { workOrder: { number: 100001 } }, errors: [{ message: MARK + ' one', extensions: { code: 'FORBIDDEN' } }] }) },
  errorsOnly: { status: 200, body: JSON.stringify({ data: null, errors: [{ message: MARK, extensions: { code: 'UNAUTHENTICATED' } }, { message: 'x', extensions: { code: 'BAD_USER_INPUT' } }] }) },
  errorsNoCode: { status: 200, body: JSON.stringify({ data: null, errors: [{ message: 'no extensions here' }] }) },
  aspnet400: { status: 400, body: JSON.stringify({ type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1', title: 'One or more validation errors occurred.', status: 400, errors: { Variables: ['bad'] } }) },
  tokenless500: { status: 500, body: '<!DOCTYPE html><html><body>No authentication method provided</body></html>' },
  badJson: { status: 200, body: '{"data": {"workOrder": ' },
  noData: { status: 200, body: JSON.stringify({ data: null }) },
  network: { reject: new TypeError('Failed to fetch ' + MARK) },
  textReject: { status: 200, textReject: new TypeError('stream aborted ' + MARK) },
  weirdCodes: { status: 200, body: JSON.stringify({ data: null, errors: [1, 2, 3, 4, 5, 6, 7].map(function (i) { return { message: 'm' + i, extensions: { code: i === 1 ? 'has space ' + MARK : i === 2 ? 'ok_CODE_2' : 'CODE_' + i } }; }) }) }
};

function run(readSrc, label) {
  var ok = A.ok, eq = A.eq;
  var E = {};
  var seq = Promise.resolve();
  function step(name, fixture, token, check) {
    seq = seq.then(function () {
      var env = makeEnv(readSrc, fixture, token);
      return env.read('query Q($n:Int!){ workOrder(workOrderNumber:$n){ number } }', { n: 100001 }).then(function (r) { E[name] = r; check(r, env); }, function (err) { ok(label + name + ': bwnGqlRead never rejects', false, String(err && err.message)); });
    });
  }
  step('ok', FIX.ok, 'tok', function (r, env) {
    eq(label + 'ok: kind', r.kind, 'ok'); eq(label + 'ok: status', r.status, 200); eq(label + 'ok: data passthrough', r.data && r.data.workOrder && r.data.workOrder.number, 100001);
    eq(label + 'ok: no codes', r.codes, []); eq(label + 'ok: noToken false', r.noToken, false);
    ok(label + 'ok: the request went to /api/graphql as a JSON POST with the bearer', env.calls.length === 1 && env.calls[0].url === '/api/graphql' && env.calls[0].init.method === 'POST' && /^Bearer tok$/.test(env.calls[0].init.headers.Authorization) && JSON.parse(env.calls[0].init.body).variables.n === 100001, JSON.stringify(env.calls[0] && env.calls[0].init && env.calls[0].init.headers));
  });
  step('partial', FIX.partial, 'tok', function (r) {
    eq(label + 'partial: kind', r.kind, 'partial'); eq(label + 'partial: data kept', !!(r.data && r.data.workOrder), true); eq(label + 'partial: codes', r.codes, ['FORBIDDEN']);
    ok(label + 'partial: message text never enters the envelope', JSON.stringify(r).indexOf(MARK) === -1, JSON.stringify(r)); eq(label + 'partial: message length kept', r.messageLen, [(MARK + ' one').length]);
  });
  step('errorsOnly', FIX.errorsOnly, 'tok', function (r) {
    eq(label + 'errors-only: kind', r.kind, 'graphql-error'); eq(label + 'errors-only: data null', r.data, null); eq(label + 'errors-only: codes in order', r.codes, ['UNAUTHENTICATED', 'BAD_USER_INPUT']);
    ok(label + 'errors-only: message text never enters the envelope', JSON.stringify(r).indexOf(MARK) === -1, JSON.stringify(r));
  });
  step('errorsNoCode', FIX.errorsNoCode, 'tok', function (r) { eq(label + 'errors without extensions: code placeholder', r.codes, ['nocode']); eq(label + 'errors without extensions: kind', r.kind, 'graphql-error'); });
  step('aspnet400', FIX.aspnet400, 'tok', function (r) { eq(label + 'ASP.NET 400 JSON without errors[]: kind', r.kind, 'http-400'); eq(label + 'ASP.NET 400: data null', r.data, null); eq(label + 'ASP.NET 400: no codes', r.codes, []); });
  step('tokenless500', FIX.tokenless500, '', function (r) { eq(label + 'tokenless 500 HTML: kind', r.kind, 'http-5xx-no-json'); eq(label + 'tokenless 500: noToken flagged', r.noToken, true); eq(label + 'tokenless 500: status', r.status, 500); eq(label + 'tokenless 500: data null', r.data, null); });
  step('badJson', FIX.badJson, 'tok', function (r) { eq(label + '200 malformed JSON: kind', r.kind, 'bad-json'); eq(label + 'malformed: data null', r.data, null); });
  step('noData', FIX.noData, 'tok', function (r) { eq(label + '200 with data:null and no errors: kind', r.kind, 'no-data'); });
  step('textReject', FIX.textReject, 'tok', function (r) { eq(label + 'r.text() rejecting mid-read: still resolves, kind', r.kind, 'bad-json'); eq(label + 'text-reject: status kept', r.status, 200); eq(label + 'text-reject: data null', r.data, null); ok(label + 'text-reject: stream error text never enters the envelope', JSON.stringify(r).indexOf(MARK) === -1, JSON.stringify(r)); });
  step('weirdCodes', FIX.weirdCodes, 'tok', function (r) { eq(label + 'codes: capped at 5', r.codes.length, 5); eq(label + 'codes: a free-text extensions.code is replaced, identifier-shaped ones pass', r.codes, ['othercode', 'ok_CODE_2', 'CODE_3', 'CODE_4', 'CODE_5']); ok(label + 'codes: the free-text code never enters the envelope', JSON.stringify(r).indexOf(MARK) === -1, JSON.stringify(r)); });
  step('network', FIX.network, 'tok', function (r) { eq(label + 'rejected fetch: kind', r.kind, 'network'); eq(label + 'rejected fetch: status 0', r.status, 0); eq(label + 'rejected fetch: data null', r.data, null); ok(label + 'rejected fetch: rejection text never enters the envelope', JSON.stringify(r).indexOf(MARK) === -1, JSON.stringify(r)); eq(label + 'rejected fetch: message length kept', r.messageLen, [('Failed to fetch ' + MARK).length]); });
  return seq;
}

// ---- the shipped bytes ---------------------------------------------------------
console.log('-- bwnGqlRead: the shipped envelope --');
run(S_READ, '').then(function () {
  console.log('\n-- bwnGql: contract unchanged --');
  var gqlOk = makeGql(FIX.ok), gqlErr = makeGql(FIX.errorsOnly);
  return gqlOk('q', {}).then(function (d) { A.eq('bwnGql still resolves data', d && d.workOrder && d.workOrder.number, 100001); })
    .then(function () { return gqlErr('q', {}).then(function () { A.ok('bwnGql still throws on errors[]', false); }, function (err) { A.ok('bwnGql still throws errors[0].message', String(err && err.message).indexOf(MARK) === 0, String(err && err.message)); }); });
}).then(function () {
  console.log('\n-- source-level pins --');
  A.ok('fetchPOs reads through bwnGqlRead', coreFull.indexOf('bwnGqlRead(PO_API_Q, { n: Number(woNum) })') !== -1);
  A.ok('the PO give-up warn carries the failure class, not a server message', coreFull.indexOf("err && err.bwnKind ? (err.bwnKind") !== -1);
  A.ok('bwnGqlRead is defined exactly once in Core', coreFull.split('function bwnGqlRead(').length === 2);
  var others = fs.readdirSync(path.join(__dirname, '..')).filter(function (f) { return /\.user\.js$/.test(f) && f !== 'bwn-suite-core.user.js'; });
  var leaked = others.filter(function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8').indexOf('bwnGqlRead') !== -1; });
  A.eq('no other userscript carries bwnGqlRead (per-script transport copies untouched)', leaked, []);
  A.ok('the BWN-OPS registry still lists purchaseOrders as a read', /purchaseOrders:\s*\{ kind: 'read'/.test(coreFull));
  var callSites = coreFull.match(/(?<!function )bwnGqlRead\(([A-Za-z_][A-Za-z0-9_]*)/g) || [];
  A.eq('exactly one bwnGqlRead call site in Core (fetchPOs)', callSites, ['bwnGqlRead(PO_API_Q']);
  A.ok('that call site is handed a document beginning with "query " - bwnGqlRead is reads-only (writes stay on the audited bwnGqlOp)', /var PO_API_Q = 'query /.test(coreFull));
}).then(function () {
  console.log('\n-- negative controls: each must turn the envelope cases red --');
  var CONTROLS = [
    { what: 'partial collapsed onto ok (a data+errors body reads as a clean success)', from: "if (errs) return body.data ? 'partial' : 'graphql-error';", to: "if (errs) return body.data ? 'ok' : 'graphql-error';", expectFail: function (E) { return E.partial.kind !== 'partial'; } },
    { what: 'error codes dropped (every error reads nocode)', from: "return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(c) ? c : 'othercode';", to: "return 'nocode';", expectFail: function (E) { return E.errorsOnly.codes[0] !== 'UNAUTHENTICATED'; } },
    { what: 'a rejected fetch misclassified as ok', from: "if (status === 0) return 'network';", to: "if (status === 0) return 'ok';", expectFail: function (E) { return E.network.kind !== 'network'; } }
  ];
  var seq = Promise.resolve();
  CONTROLS.forEach(function (c) {
    seq = seq.then(function () {
      var src = mutate(S_READ, c.from, c.to);
      var E = {};
      function one(name, fixture) { var env = makeEnv(src, fixture, 'tok'); return env.read('q', {}).then(function (r) { E[name] = r; }); }
      return one('partial', FIX.partial).then(function () { return one('errorsOnly', FIX.errorsOnly); }).then(function () { return one('network', FIX.network); }).then(function () {
        A.ok('CAUGHT: ' + c.what, c.expectFail(E), JSON.stringify(E));
      });
    });
  });
  return seq.then(function () { A.eq('control count matches the header claim (3)', CONTROLS.length, 3); });
}).then(function () { A.finish(); }, function (err) { console.error('HARNESS ERROR', err); process.exit(1); });
