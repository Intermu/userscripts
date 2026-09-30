// test-dispatch-api.js - node harness for bwn-dispatch's authoritative API inventory (DISPATCH_API)
// and the empty-body / status-aware gql() diagnostics, added in 0.13.0.
//
// THE CHANGE, as found in source:
//   0.13.0 adds DISPATCH_API - one entry per network operation the dispatch feature can execute
//   (the direct reads, the two best-effort fallbacks, the WO write, and the SWA notify POST), as
//   metadata that never duplicates a selector (the query/mutation TEXT stays in its own `const:`-named
//   constant). It also hardens gql(): the REST backend behind the GraphQL gateway rejects a bad patch
//   with a 400 and an EMPTY body (measured on WO 396636), and r.json() turned that into a bare
//   "Unexpected end of JSON input"; gql() now reads the body as text and degrades an empty/non-JSON
//   body to a status-named error the operator can forward.
//
// WHAT THIS PROVES, against the REAL shipped bytes (DISPATCH_API and gqlErrText+gql are sliced out of
// bwn-dispatch.user.js and run in a vm - nothing below is a restatement of a stub):
//   - every DISPATCH_API entry carries the full metadata contract, and its stage/kind/safeRetry are
//     internally consistent (writes + notify are never auto-retried; fallbacks can never be required);
//   - THE UNREGISTERED-OP GUARD: every named GraphQL constant in the source (var X = 'query|mutation...)
//     has an entry here, and every entry's `const` resolves to a real symbol - so a new network op
//     cannot enter the dispatch path without a registry row (a BUILD gate; the WRITE op is ALSO refused
//     at runtime by bwnGqlOp + test-registry-authoritative.js);
//   - the notify POST is registered and its timeout is sourced FROM the registry;
//   - gql() reports empty-body and non-JSON HTTP failures with the status (not a parser error), keeps
//     the GraphQL error-envelope message, and resolves data on a clean 2xx.
//
// WHAT IT DOES NOT PROVE:
//   - which envelope a live patchWorkOrder refusal uses, or that any selector/mutation exists on the
//     live schema. Only a real dispatch answers that (the manual scratch-WO checklist).
//
// Synthetic controls prove the checker itself can go red (an unregistered constant is caught; the
// empty-body guard, when reverted, stops throwing).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dispatch-api.js
// CI runs: node scripts/test-dispatch-api.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-dispatch.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

// ---- Slice + load DISPATCH_API --------------------------------------------------------------
function sliceBalanced(src, start) {
  var a = src.indexOf(start);
  if (a === -1) throw new Error('START marker not found: ' + start);
  if (src.indexOf(start, a + 1) !== -1) throw new Error('START marker not unique: ' + start);
  // brace-match from the first '{' of Object.freeze({ ... }) to its close, then include the ')' + ';'
  var i = src.indexOf('{', a), depth = 0;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, src.indexOf(';', j) + 1); }
  }
  throw new Error('unbalanced braces after ' + start);
}
function loadRegistry(src) {
  var sandbox = { Object: Object, console: console };
  vm.createContext(sandbox);
  vm.runInContext(sliceBalanced(src, '  var DISPATCH_API = Object.freeze({') + '\nthis.DISPATCH_API = DISPATCH_API;', sandbox);
  return sandbox.DISPATCH_API;
}
var API = loadRegistry(full);

// ---- 1. metadata contract -------------------------------------------------------------------
var REQUIRED_FIELDS = ['key', 'name', 'transport', 'method', 'endpoint', 'operation', 'kind', 'required', 'stage', 'timeoutMs', 'retry', 'safeRetry', 'fail'];
var KINDS = ['read', 'write', 'fallback', 'notification'];
var STAGES = ['prefill', 'write-gate', 'notify'];
var keys = Object.keys(API);
A.ok('DISPATCH_API has entries', keys.length >= 9, 'got ' + keys.length);
keys.forEach(function (k) {
  var e = API[k];
  A.eq('[' + k + '] key matches the map key', e.key, k);
  REQUIRED_FIELDS.forEach(function (f) {
    A.ok('[' + k + '] declares ' + f, Object.prototype.hasOwnProperty.call(e, f) && e[f] !== undefined,
      'missing field ' + f);
  });
  A.ok('[' + k + '] kind is one of ' + KINDS.join('/'), KINDS.indexOf(e.kind) !== -1, e.kind);
  A.ok('[' + k + '] stage is one of ' + STAGES.join('/'), STAGES.indexOf(e.stage) !== -1, e.stage);
  // Writes + the notify POST are NEVER auto-retried (no idempotency key). Reads/fallbacks are safe.
  if (e.kind === 'write' || e.kind === 'notification') A.eq('[' + k + '] non-idempotent op is not safe-retried', e.safeRetry, false);
  else A.eq('[' + k + '] idempotent read/fallback is safe-retried', e.safeRetry, true);
});

// ---- 2. fallbacks can never become a blocking required condition -----------------------------
['schemaIntrospect', 'locationRoster'].forEach(function (k) {
  A.ok('fallback ' + k + ' exists', !!API[k]);
  A.eq('fallback ' + k + ' kind is fallback', API[k].kind, 'fallback');
  A.eq('fallback ' + k + ' is NOT required', API[k].required, false);
});

// ---- 3. the write + the notify POST are registered with the right shape ----------------------
A.ok('the WO write is registered', !!API.patchWorkOrder);
A.eq('write is a graphql write', [API.patchWorkOrder.kind, API.patchWorkOrder.transport], ['write', 'graphql']);
A.eq('write points at PATCH_M', API.patchWorkOrder.const, 'PATCH_M');
A.eq('write is required + write-gate stage', [API.patchWorkOrder.required, API.patchWorkOrder.stage], [true, 'write-gate']);

A.ok('the notify POST is registered', !!API.dispatchNotify);
A.eq('notify is an swa-proxy notification', [API.dispatchNotify.kind, API.dispatchNotify.transport], ['notification', 'swa-proxy']);
A.eq('notify targets /api/dispatch', API.dispatchNotify.endpoint, '/api/dispatch');
A.eq('notify is required + notify stage', [API.dispatchNotify.required, API.dispatchNotify.stage], [true, 'notify']);
A.eq('notify has a bounded timeout', API.dispatchNotify.timeoutMs, 30000);

// ---- 4. dependency ordering (what cannot run in parallel) ------------------------------------
A.eq('notify runs AFTER the write (never before the gate)', API.dispatchNotify.after, 'patchWorkOrder');
A.eq('the user read depends on the WO read (needs its GUID)', API.userRead.after, 'workOrderRead');

// ---- 5. THE UNREGISTERED-OP GUARD -----------------------------------------------------------
// Every named GraphQL constant defined at module scope (var X = 'query...'|'mutation...') must have a
// DISPATCH_API entry. Add a new query and pass it to gql() without registering -> this reddens.
function graphqlConstants(src) {
  var out = [], re = /\n  var ([A-Z][A-Z0-9_]*) = '(?:query|mutation)/g, m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}
var registeredConsts = keys.map(function (k) { return API[k].const; }).filter(Boolean);
var gqlConsts = graphqlConstants(full);
A.ok('the guard found the known GraphQL constants', gqlConsts.length >= 6, gqlConsts.join(','));
gqlConsts.forEach(function (c) {
  A.ok('GraphQL constant ' + c + ' is REGISTERED in DISPATCH_API', registeredConsts.indexOf(c) !== -1,
    'unregistered network op: add a DISPATCH_API entry with const:' + c);
});
// Reverse: every non-null `const` names a symbol that really exists in source.
registeredConsts.forEach(function (c) {
  A.ok('registry const ' + c + ' resolves to a real symbol', new RegExp('\\bvar ' + c + '\\b').test(full),
    'DISPATCH_API references ' + c + ' but no such constant exists');
});
// The write + notify are actually WIRED to their registered transports.
A.ok('the write is wired through bwnGqlOp(patchWorkOrder)', /bwnGqlOp\(\s*'patchWorkOrder'/.test(full));
A.ok('the notify POST is wired through gmPost(PROXY_URL)', full.indexOf('gmPost(PROXY_URL') !== -1);
A.ok('the notify timeout is sourced FROM the registry', full.indexOf('DISPATCH_API.dispatchNotify.timeoutMs') !== -1);

// ---- 6. the confirm->notify ordering + fail-closed gate (source structure) -------------------
// The proxy POST is inside writeStep.then (never before the gate resolves), a write failure aborts in
// .catch (no card), and there is exactly ONE gmPost(PROXY_URL) in the submit path.
A.ok('the proxy POST runs only inside writeStep.then', /writeStep\.then\(function \(\) \{[\s\S]*?return postCard\(\);/.test(full));
A.ok('a write failure aborts before any card', /\.catch\(function \(err\) \{[\s\S]*?No card was sent\./.test(full));
A.eq('exactly one proxy POST in the submit path', (full.match(/gmPost\(PROXY_URL/g) || []).length, 1);

// ---- 7. the confirm->notify STAGE TIMINGS are present ----------------------------------------
['confirm: perfNow()', 'perf.writeStart = perfNow', 'perf.writeEnd = perfNow', 'perf.proxyStart = perfNow']
  .forEach(function (m) { A.ok('timing checkpoint present: ' + m, full.indexOf(m) !== -1, 'missing ' + m); });
A.ok('timings are logged with op keys', /logDispatchTimings\(/.test(full) && full.indexOf('DISPATCH_API.dispatchNotify.key') !== -1);

// ---- 8. gql() empty-body / non-JSON / status diagnostics ------------------------------------
function loadGql(src) {
  var body = src.slice(src.indexOf('  function gqlErrText(j) {'), src.indexOf('  var GATE_Q ='));
  var sandbox = { console: console, authToken: function () { return ''; }, fetch: null, Object: Object, Error: Error, JSON: JSON, Promise: Promise, performance: { now: function () { return 0; } } };
  vm.createContext(sandbox);
  vm.runInContext(body + '\nthis.gql = gql; this.gqlErrText = gqlErrText;', sandbox);
  return sandbox;
}
function fakeFetch(status, bodyText) {
  return function () { return Promise.resolve({ status: status, text: function () { return Promise.resolve(bodyText); } }); };
}
var G = loadGql(full);

async function gqlCases() {
  G.fetch = fakeFetch(400, '');   // the WO 396636 case: 400 + empty body
  var caught = null;
  try { await G.gql('q', {}); } catch (e) { caught = e; }
  A.ok('empty-body 400 throws a status-named error', caught && /HTTP 400/.test(caught.message), caught && caught.message);
  A.eq('empty-body 400 carries the status', caught && caught.bwnStatus, 400);
  A.eq('empty-body 4xx is non-transient (no auto-retry)', caught && caught.bwnNonTransient, true);

  G.fetch = fakeFetch(400, '<html>gateway</html>');   // non-JSON body
  caught = null;
  try { await G.gql('q', {}); } catch (e) { caught = e; }
  A.ok('non-JSON 400 throws a status-named error', caught && /HTTP 400/.test(caught.message), caught && caught.message);

  G.fetch = fakeFetch(500, '');   // 5xx empty body: transient-ish, not marked non-transient
  caught = null;
  try { await G.gql('q', {}); } catch (e) { caught = e; }
  A.ok('empty-body 500 throws a status-named error', caught && /HTTP 500/.test(caught.message), caught && caught.message);
  A.ok('empty-body 5xx is NOT marked non-transient', !(caught && caught.bwnNonTransient));

  G.fetch = fakeFetch(200, JSON.stringify({ errors: [{ message: 'boom' }] }));   // error envelope on 200
  caught = null;
  try { await G.gql('q', {}); } catch (e) { caught = e; }
  A.eq('a GraphQL error envelope still reports its message', caught && caught.message, 'boom');
  A.eq('and carries the HTTP status', caught && caught.bwnStatus, 200);

  G.fetch = fakeFetch(200, JSON.stringify({ data: { workOrder: { statusName: 'Pending Dispatch' } } }));   // clean
  var data = await G.gql('q', {});
  A.eq('a clean 2xx resolves data', data, { workOrder: { statusName: 'Pending Dispatch' } });

  G.fetch = fakeFetch(200, '');   // 2xx empty body: no data, no throw
  A.eq('a 2xx empty body resolves null (no false failure)', await G.gql('q', {}), null);
}

// ---- 9. synthetic controls: the checker must be able to go red -------------------------------
async function controls() {
  // Control A: an unregistered GraphQL constant is caught by the guard.
  var fixture = "\n  var NEW_LEAK_Q = 'query{ leak }';\n";
  var found = graphqlConstants(full + fixture);
  A.ok('CONTROL: the guard catches a NEW unregistered constant', found.indexOf('NEW_LEAK_Q') !== -1 && registeredConsts.indexOf('NEW_LEAK_Q') === -1);

  // Control B: revert the empty-body guard -> empty-body 400 stops throwing (returns null).
  var mutated = full.replace('if (status < 200 || status >= 300) {', 'if (false) {');
  A.ok('CONTROL fixture mutated the guard', mutated !== full);
  var GM = loadGql(mutated);
  GM.fetch = fakeFetch(400, '');
  var broke = false;
  try { var r = await GM.gql('q', {}); if (r === null) broke = true; } catch (e) { /* still throws = control failed */ }
  A.ok('CONTROL: without the empty-body guard, an empty 400 no longer throws', broke);
}

gqlCases().then(controls).then(function () { A.finish(); }).catch(function (e) { console.error(e); process.exit(1); });
