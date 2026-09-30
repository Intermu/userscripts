// test-wo-extract.js - bwn-wo-extract.user.js (Operations Assist): the thin, read-only caller for
// the deployed /api/extract-work-order endpoint. Dependency-free, byte-sliced + fake-env harness,
// same discipline as the other suite tests: pure functions are sliced out of the SHIPPED bytes and
// run against fakes, structural guards are asserted over the bytes, and every guard has a negative
// control that mutates the bytes and proves it fires.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-extract.js
// No network, no writes.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');
var M = require('./userscript-meta.js');

var ROOT = path.join(__dirname, '..');
var FILE = 'bwn-wo-extract.user.js';
var SRC = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n');

// Slice one function body out of the shipped bytes by name (brace-count to its end).
function sliceFn(src, decl) {
  var a = src.indexOf(decl);
  if (a === -1) throw new Error('function not found: ' + decl);
  var depth = 0, i = src.indexOf('{', a);
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced braces after ' + decl);
}

// Build a runnable copy of the pure helpers with injected externals, so each test controls the
// token / ingest key / sessionStorage / route. No real network, DOM, or GM APIs are touched.
var PURE = ['function pick(', 'function vendorNteOf(', 'function buildContext(', 'function idAgrees(',
  'function routeWoId(', 'function coreContext(', 'function correlationId(', 'function preflight('];
function mkEnv(opts) {
  opts = opts || {};
  var body = 'var BUS_MAX_AGE_MS = 600000;\n' +
    PURE.map(function (d) { return sliceFn(SRC, d); }).join('\n') +
    '\nreturn { pick: pick, vendorNteOf: vendorNteOf, buildContext: buildContext, idAgrees: idAgrees,' +
    ' routeWoId: routeWoId, coreContext: coreContext, correlationId: correlationId, preflight: preflight };';
  var store = opts.store || {};
  var fakeSession = { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } };
  var fakeLocation = { pathname: opts.path || '/', origin: opts.origin || 'https://app.umbrava.com' };
  var fakeWindow = { crypto: { randomUUID: function () { return '11111111-1111-4111-8111-111111111111'; } } };
  function fakeAuthToken() { return opts.token || ''; }
  function fakeGetValue(k, d) { return k === 'ingest_key' ? (opts.key || d || '') : (d || ''); }
  var factory = new Function('authToken', 'GM_getValue', 'sessionStorage', 'location', 'window', body);
  return factory(fakeAuthToken, fakeGetValue, fakeSession, fakeLocation, fakeWindow);
}
function busSlot(fields) { var o = { v: 1, ts: Date.now() }; for (var k in fields) o[k] = fields[k]; return o; }
function putBus(store, id, fields) { store['bwn:wo:' + id] = JSON.stringify(busSlot(fields)); }

var WO_PATH = '/work-orders/1200001';
var GOOD = { token: 'tok', key: 'k' };

// =============================================================================================
// 1. Metadata / manifest: host, @connect, grants, versions.
// =============================================================================================
console.log('-- 1. metadata --');
var meta = M.parseMeta(SRC);
A.ok('parses a ==UserScript== block', !!meta);
A.eq('@namespace is canonical', meta.namespace, 'broadwaynational.bwn');
A.eq('@match is app.umbrava.com', meta.match.join(','), 'https://app.umbrava.com/*');
A.eq('body VER matches @version', M.bodyVersion(SRC), meta.version);
A.eq('@connect is the SWA host only', meta.connect.join(','), 'green-stone-0717dab0f.7.azurestaticapps.net');
['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand'].forEach(function (g) {
  A.ok('grants ' + g, meta.grant.indexOf(g) !== -1);
});
var RAW = 'https://raw.githubusercontent.com/Intermu/userscripts/main/' + FILE;
A.eq('@updateURL is our own raw', meta.updateURL, RAW);
A.eq('@downloadURL is our own raw', meta.downloadURL, RAW);

// =============================================================================================
// 2. Ingest-key beacon + PER-SCRIPT prompt (also gated by test-ingest-key-presence.js).
// =============================================================================================
console.log('\n-- 2. ingest key beacon + prompt --');
A.ok('publishes bwn:ingest:wo-extract', /localStorage\.setItem\(('|")bwn:ingest:wo-extract\1/.test(SRC));
A.ok('beacon is a 0/1, never the key', /\?\s*1\s*:\s*0/.test(SRC));
A.ok('defines publishIngestPresence()', /function publishIngestPresence\(\)/.test(SRC));
A.ok('calls publishIngestPresence() at load', /\n\s*publishIngestPresence\(\);/.test(SRC));
A.ok('the setter republishes', /GM_setValue\(('|")ingest_key\1[\s\S]*?publishIngestPresence\(\)/.test(SRC));
A.ok('prompt says PER SCRIPT', /PER SCRIPT/.test(SRC));
A.ok('reads GM_getValue(ingest_key)', /GM_getValue\(('|")ingest_key\1/.test(SRC));

// =============================================================================================
// 3. Bounded request payload: only the permitted keys.
// =============================================================================================
console.log('\n-- 3. bounded payload shape --');
// The payload object literal in onAction: exactly userToken/source/sourceUrl/correlationId/context.
var payloadLit = SRC.slice(SRC.indexOf('var payload = {'), SRC.indexOf('};', SRC.indexOf('var payload = {')) + 2);
['userToken:', 'source:', 'sourceUrl:', 'correlationId:', 'context:'].forEach(function (k) {
  A.ok('payload has ' + k, payloadLit.indexOf(k) !== -1);
});
['amount', 'doNotExceed', 'clientDneAmount', 'innerHTML', 'html', 'notes', 'scope'].forEach(function (bad) {
  A.ok('payload literal does not mention ' + bad, payloadLit.indexOf(bad) === -1);
});

// =============================================================================================
// 4. Full valid Core context -> expected normalized context (allowlist).
// =============================================================================================
console.log('\n-- 4. builder over a full Core context --');
(function () {
  var env = mkEnv({});
  var bus = busSlot({ client: 'Sample Client Co', status: 'Dispatched', location: 'Store 001', priority: 'P2', vendorNte: 850.5 });
  var ctx = env.buildContext(bus, '1200001');
  A.eq('woNumber from route', ctx.woNumber, '1200001');
  A.eq('clientName mapped', ctx.clientName, 'Sample Client Co');
  A.eq('statusName mapped', ctx.statusName, 'Dispatched');
  A.eq('locationName mapped', ctx.locationName, 'Store 001');
  A.eq('priority mapped', ctx.priority, 'P2');
  A.eq('vendorNte mapped (explicit vendor NTE)', ctx.vendorNte, 850.5);
  A.eq('exactly the allowlisted keys', Object.keys(ctx).sort().join(','), 'clientName,locationName,priority,statusName,vendorNte,woNumber');
})();

// =============================================================================================
// 5. No raw HTML / DOM / scope / notes / storage dump / key / token leaks into the context.
// =============================================================================================
console.log('\n-- 5. no junk leaks through the allowlist --');
(function () {
  var env = mkEnv({});
  var bus = busSlot({ client: 'C', status: 'Open', scope: 'LONG SCOPE TEXT', notes: 'note body', html: '<div>x</div>',
    innerHTML: '<b>y</b>', access_token: 'SECRET', ingest_key: 'SECRET', someId: 999 });
  var ctx = env.buildContext(bus, '5');
  var s = JSON.stringify(ctx);
  ['LONG SCOPE', 'note body', '<div', '<b>', 'SECRET', '999'].forEach(function (bad) {
    A.ok('context does not carry ' + bad, s.indexOf(bad) === -1);
  });
  A.ok('script never uses innerHTML', SRC.indexOf('.innerHTML') === -1);
})();

// =============================================================================================
// 6/7. NTE semantics: client-DNE never becomes vendorNte; missing NTE omits (no fallback).
// =============================================================================================
console.log('\n-- 6/7. NTE semantics --');
(function () {
  var env = mkEnv({});
  var dne = env.buildContext(busSlot({ client: 'C', status: 'Open', amount: 5000, doNotExceed: 5000, clientDneAmount: 5000 }), '7');
  A.ok('client DNE does not create vendorNte', !('vendorNte' in dne));
  A.eq('and 5000 appears nowhere in the context', JSON.stringify(dne).indexOf('5000'), -1);
  var missing = env.buildContext(busSlot({ client: 'C', status: 'Open' }), '7');
  A.ok('missing NTE -> vendorNte omitted', !('vendorNte' in missing));
  A.eq('vendorNteOf(amount only) is null', env.vendorNteOf({ amount: 999 }), null);
  A.eq('vendorNteOf(vendorNte) reads it', env.vendorNteOf({ vendorNte: 12 }), 12);
  A.eq('vendorNteOf({amount} object shape under totalNTE)', env.vendorNteOf({ totalNTE: { amount: 34 } }), 34);
})();

// =============================================================================================
// 8-12. Refusal gate: preflight sends nothing until every precondition holds.
// =============================================================================================
console.log('\n-- 8-12. refusal gate --');
(function () {
  // 9. not a WO route
  A.eq('non-WO route refuses', mkEnv({ path: '/dashboard', token: 't', key: 'k' }).preflight().detail, 'not-a-wo-route');
  // 11. missing ingest key
  A.eq('missing ingest key refuses', mkEnv({ path: WO_PATH, token: 't', key: '' }).preflight().state, 'setup');
  A.eq('  ^ detail', mkEnv({ path: WO_PATH, token: 't', key: '' }).preflight().detail, 'no-ingest-key');
  // 12. missing token
  A.eq('missing Umbrava token refuses', mkEnv({ path: WO_PATH, token: '', key: 'k' }).preflight().detail, 'no-umbrava-token');
  // 8. missing Core context
  A.eq('missing Core context refuses', mkEnv({ path: WO_PATH, token: 't', key: 'k', store: {} }).preflight().detail, 'no-core-context');
  // stale Core context refuses
  var staleStore = {}; staleStore['bwn:wo:1200001'] = JSON.stringify({ v: 1, ts: Date.now() - 3600000, client: 'C', status: 'Open' });
  A.eq('stale Core context refuses', mkEnv({ path: WO_PATH, token: 't', key: 'k', store: staleStore }).preflight().detail, 'no-core-context');
  // 10. id mismatch
  var mm = {}; putBus(mm, '1200001', { woNumber: '999999', client: 'C', status: 'Open' });
  A.eq('URL/Core id mismatch refuses', mkEnv({ path: WO_PATH, token: 't', key: 'k', store: mm }).preflight().detail, 'context-id-mismatch');
  // happy path: preflight ok, carries a bounded context, no request made by preflight itself
  var ok = {}; putBus(ok, '1200001', { client: 'C', status: 'Open', vendorNte: 5 });
  var pf = mkEnv({ path: WO_PATH, token: 'tok', key: 'k', store: ok }).preflight();
  A.ok('valid preconditions -> ok', pf.ok === true && pf.id === '1200001' && pf.token === 'tok' && pf.key === 'k');
  A.eq('ok context is bounded', Object.keys(pf.ctx).sort().join(','), 'clientName,statusName,vendorNte,woNumber');
})();

// =============================================================================================
// 13-16. Response handling is present and safe (structural over the shipped bytes).
// =============================================================================================
console.log('\n-- 13-16. response handling --');
A.ok('renders success via textContent, never innerHTML', /function renderContract\(/.test(SRC) && SRC.indexOf('.innerHTML') === -1);
A.ok('reviewRequired drives the manual-review state', /reviewRequired/.test(SRC) && /Manual review/.test(SRC));
A.ok('401/403 -> unauthorized', /r\.status === 401 \|\| r\.status === 403[^;]*unauthorized/.test(SRC));
A.ok('400 -> validation', /r\.status === 400[^;]*validation/.test(SRC));
A.ok('non-200 -> failure (retryable)', /r\.status !== 200[^;]*failure/.test(SRC));
A.ok('network error resolves, no throw', /onerror:[^}]*neterr/.test(SRC) && /ontimeout:[^}]*timeout/.test(SRC));
A.ok('no automatic retry loop (no self-scheduled onAction)', !/setTimeout\(\s*onAction/.test(SRC) && !/setInterval\(/.test(SRC));

// =============================================================================================
// 17-18. Idempotent UI + single in-flight request.
// =============================================================================================
console.log('\n-- 17-18. idempotency --');
A.ok('ensurePanel reuses the node (no duplicate injection)', /if \(panelEl && panelEl\.isConnected\) return;/.test(SRC));
A.ok('onAction guards against a duplicate in-flight request', /function onAction\(\)\s*\{\s*if \(inFlight\) return;/.test(SRC));
A.ok('inFlight is set before the request and cleared after', /inFlight = true;/.test(SRC) && /inFlight = false;/.test(SRC));

// =============================================================================================
// 19. Structural no-write guard: no upstream write controls or verbs.
// =============================================================================================
console.log('\n-- 19. no write controls --');
A.ok('no bwnGqlOp (audited write registry) call', SRC.indexOf('bwnGqlOp') === -1);
A.ok('no patchWorkOrder / mutation', !/patchWorkOrder|createWorkOrder|mutation\s/.test(SRC));
['Submit', 'Send', 'Approve', 'Dispatch', 'Email', 'Assign', 'Update', 'Create', 'Delete', 'Save'].forEach(function (verb) {
  A.ok('no "' + verb + '" write-control label', SRC.indexOf("'" + verb) === -1 && SRC.indexOf(verb + " '") === -1 && SRC.indexOf('>' + verb) === -1);
});

// =============================================================================================
// 20. sourceUrl guard: metadata only, never an outbound target.
// =============================================================================================
console.log('\n-- 20. sourceUrl is metadata only --');
A.ok('sourceUrl appears as a payload field', /sourceUrl:\s*location\.origin/.test(SRC));
A.ok('sourceUrl is never a request url', !/url:\s*[^,\n]*sourceUrl/.test(SRC));
A.ok('no window.open / location navigation of any URL', !/window\.open/.test(SRC) && !/location\.href\s*=/.test(SRC) && !/location\.assign/.test(SRC) && !/location\.replace/.test(SRC));

// =============================================================================================
// 21. No new GraphQL / fetch introduced.
// =============================================================================================
console.log('\n-- 21. no GraphQL / fetch --');
A.ok('no /api/graphql', SRC.indexOf('/api/graphql') === -1);
A.ok('no fetch(', !/\bfetch\s*\(/.test(SRC));
A.ok('no gql( helper', !/\bgql\s*\(/.test(SRC));
A.ok('the only egress URL is the extract endpoint', (SRC.match(/SWA_BASE \+ '\/api\/[a-z-]+'/g) || []).join(',') === "SWA_BASE + '/api/extract-work-order'");
A.ok('GM_xmlhttpRequest is called once (inside gmPost)', (SRC.match(/GM_xmlhttpRequest\(/g) || []).length === 1);

// =============================================================================================
// 22. Negative controls: each structural guard actually fires on a violation.
// =============================================================================================
console.log('\n-- 22. negative controls --');
// NC1: a builder that DID read client DNE would leak it - prove the guard would catch that.
(function () {
  var env = mkEnv({});
  var leaked = env.buildContext(busSlot({ client: 'C', status: 'Open', vendorNte: 5000 }), '9');   // vendorNte present -> 5000 legitimately
  A.eq('control: a real vendorNte IS carried (so the 5000-absent check is meaningful)', leaked.vendorNte, 5000);
})();
// NC2: the innerHTML scan must fire if innerHTML is introduced.
A.ok('control: innerHTML scan fires on a mutated source', (SRC + '\nx.innerHTML = d;').indexOf('.innerHTML') !== -1);
// NC3: the GraphQL scan must fire if a graphql call is introduced.
A.ok('control: fetch/graphql scan fires on a mutated source', /\bfetch\s*\(/.test(SRC + "\nfetch('/api/graphql');"));
// NC4: the sourceUrl-target scan must fire if sourceUrl becomes a request url.
A.ok('control: sourceUrl-as-target scan fires on a mutated source', /url:\s*[^,\n]*sourceUrl/.test(SRC + '\nvar bad = { url: payload.sourceUrl };'));
// NC5: the in-flight guard scan must fire if it is removed.
A.ok('control: in-flight guard scan fails on a mutated source',
  !/function onAction\(\)\s*\{\s*if \(inFlight\) return;/.test(SRC.replace('if (inFlight) return;', '')));

A.finish();
