// test-swa-reads-post.js - the key-gated SWA reads go out as a vouched POST with a GET fallback.
//
// Slices the REAL swaRead helper out of bwn-suite-ai.user.js (callback shape) and bwn-bid-out.user.js
// (promise shape) and drives it against a stubbed GM_xmlhttpRequest. Asserts per helper:
//   - first request is POST to the url WITHOUT a query string, Content-Type + x-bwn-key kept,
//     body { op:'read', userToken, query:{string values} } matching the old GET params
//   - 404 / 405 / any 400 (incl. the deployed server's JSON 400s) / network error => ONE retry as the old GET
//   - 401 / 403 / 500 / timeout => no retry, surfaced to the caller as-is
// Then structural asserts over the full files: every changed read goes through swaRead and the
// governance reads stay plain GETs.
// Run: node scripts/test-swa-reads-post.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n'); }
function slice(text, start, end) {
  var a = text.indexOf(start); var b = text.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('marker missing: ' + start);
  return text.slice(a, b);
}

var AI = readLF('bwn-suite-ai.user.js');
var BID = readLF('bwn-bid-out.user.js');
var AI_HELPER = slice(AI, 'function swaRead(', 'function swaSync()');

// ---- suite-ai (callback shape) ----------------------------------------------------------------
function aiRun(respond, query) {
  var calls = [];
  var ctx = {
    authToken: function () { return 'TOK'; },
    GM_xmlhttpRequest: function (o) { calls.push(o); }
  };
  vm.createContext(ctx);
  vm.runInContext(AI_HELPER + '\nthis.swaRead = swaRead;', ctx);
  var out = { loads: [], errs: 0, tos: 0 };
  ctx.swaRead('https://h/api/wo-ingest', query || { client: 'pilot', target: '123' }, {
    headers: { 'x-bwn-key': 'K' }, timeout: 15000,
    onload: function (r) { out.loads.push(r); }, onerror: function () { out.errs++; }, ontimeout: function () { out.tos++; }
  });
  var post = calls[0];
  respond(post);
  return { calls: calls, post: post, out: out };
}

(function () {
  var q = { client: 'pilot', o30: '1,2,3' };
  var t = aiRun(function (p) { p.onload({ status: 200, responseText: '{"ok":true}' }); }, q);
  A.eq('ai: POST first', t.post.method, 'POST');
  A.eq('ai: POST url has no query string', t.post.url, 'https://h/api/wo-ingest');
  A.eq('ai: key + content-type', [t.post.headers['x-bwn-key'], t.post.headers['Content-Type']], ['K', 'application/json']);
  A.eq('ai: body op/userToken/query', JSON.parse(t.post.data), { op: 'read', userToken: 'TOK', query: { client: 'pilot', o30: '1,2,3' } });
  A.eq('ai: 200 delivered, no GET', [t.out.loads.length, t.calls.length], [1, 1]);

  [404, 405].forEach(function (s) {
    var r = aiRun(function (p) { p.onload({ status: s, responseText: '' }); }, q);
    A.eq('ai: ' + s + ' falls back to GET once', [r.calls.length, r.calls[1].method], [2, 'GET']);
    A.eq('ai: fallback url is the old GET', r.calls[1].url, 'https://h/api/wo-ingest?client=pilot&o30=1%2C2%2C3');
    A.eq('ai: fallback keeps key, no token/body', [r.calls[1].headers['x-bwn-key'], r.calls[1].data], ['K', undefined]);
    r.calls[1].onload({ status: 200, responseText: '{}' });
    A.eq('ai: GET answer reaches caller', r.out.loads.length, 1);
  });
  ['<html>bad</html>', '{"error":"no events"}', '{"error":"upsert[] or outcome{} required"}'].forEach(function (body) {
    var b = aiRun(function (p) { p.onload({ status: 400, responseText: body }); });
    A.eq('ai: 400 ' + body + ' falls back to GET', [b.calls.length, b.calls[1].method], [2, 'GET']);
  });
  var ne = aiRun(function (p) { p.onerror(); });
  A.eq('ai: network error falls back to GET', [ne.calls.length, ne.calls[1].method, ne.out.errs], [2, 'GET', 0]);
  ne.calls[1].onerror();
  A.eq('ai: GET network error reaches caller (no loop)', [ne.calls.length, ne.out.errs], [2, 1]);
  [401, 403, 500].forEach(function (s) {
    var r = aiRun(function (p) { p.onload({ status: s, responseText: '{"ok":false}' }); });
    A.eq('ai: ' + s + ' NOT retried, surfaced', [r.calls.length, r.out.loads[0].status], [1, s]);
  });
  var to = aiRun(function (p) { p.ontimeout(); });
  A.eq('ai: timeout surfaces, no fallback', [to.calls.length, to.out.tos], [1, 1]);
})();

// ---- bid-out (promise shape) -------------------------------------------------------------------
var jobs = [];
function bidCase(name, plan, query, getUrl, check) {
  var calls = [];
  var ctx = {
    authToken: function () { return 'TOK'; },
    GM_xmlhttpRequest: function (o) {
      calls.push(o);
      var step = plan[calls.length - 1] || { status: 200, body: '{}' };
      if (step.err) o.onerror(); else if (step.to) o.ontimeout(); else o.onload({ status: step.status, responseText: step.body });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(slice(BID, 'function gmPost(', 'function cyrb53(') + '\nthis.swaRead = swaRead;', ctx);
  jobs.push(ctx.swaRead('https://h/api/bid-status', query, { 'x-bwn-key': 'K' }, 30000, getUrl).then(
    function (r) { check(calls, r); },
    function (e) { check(calls, null, e); }
  ).catch(function (e) { A.ok('bid: ' + name + ' threw ' + e.message, false); }));
}

bidCase('200', [{ status: 200, body: '{"ok":true,"sends":[]}' }], { tracking: '98765' }, null, function (c, r) {
  A.eq('bid: POST first, no query string', [c[0].method, c[0].url], ['POST', 'https://h/api/bid-status']);
  A.eq('bid: key + content-type', [c[0].headers['x-bwn-key'], c[0].headers['Content-Type']], ['K', 'application/json']);
  A.eq('bid: body op/userToken/query', JSON.parse(c[0].data), { op: 'read', userToken: 'TOK', query: { tracking: '98765' } });
  A.eq('bid: 200 no GET', [c.length, r.status], [1, 200]);
});
[404, 405].forEach(function (s) {
  bidCase(String(s), [{ status: s, body: '' }, { status: 200, body: '{"ok":true}' }], { tracking: '98765' }, null, function (c, r) {
    A.eq('bid: ' + s + ' falls back to old GET once', [c.length, c[1].method, c[1].url], [2, 'GET', 'https://h/api/bid-status?tracking=98765']);
    A.eq('bid: GET result returned', r.status, 200);
  });
});
['nope', '{"error":"no events"}', '{"error":"upsert[] or outcome{} required"}'].forEach(function (body) {
  bidCase('400 ' + body, [{ status: 400, body: body }, { status: 200, body: '{}' }], { tracking: '1' }, null, function (c, r) {
    A.eq('bid: 400 ' + body + ' falls back to GET', [c.length, c[1].method, r.status], [2, 'GET', 200]);
  });
});
bidCase('400 twice', [{ status: 400, body: '{"error":"x"}' }, { status: 400, body: '{"error":"x"}' }], { tracking: '1' }, null, function (c, r) {
  A.eq('bid: genuine 400 repeats as one GET then surfaces', [c.length, r.status], [2, 400]);
});
bidCase('500', [{ status: 500, body: '{}' }], { tracking: '1' }, null, function (c, r) {
  A.eq('bid: 500 NOT retried', [c.length, r.status], [1, 500]);
});
bidCase('timeout', [{ to: true }], { tracking: '1' }, null, function (c, r, e) {
  A.eq('bid: timeout NOT retried, rejects', [c.length, !!e && e.message], [1, 'timed out']);
});
bidCase('net', [{ err: true }, { status: 200, body: '{"ok":true}' }], { tracking: '1' }, null, function (c, r) {
  A.eq('bid: network error falls back to GET', [c.length, c[1].method, r.status], [2, 'GET', 200]);
});
bidCase('net twice', [{ err: true }, { err: true }], { tracking: '1' }, null, function (c, r, e) {
  A.eq('bid: GET network error rejects (no loop)', [c.length, !!e && e.message], [2, 'network error']);
});
[401, 403].forEach(function (s) {
  bidCase(String(s), [{ status: s, body: '{"ok":false,"error":"no"}' }], { tracking: '1' }, null, function (c, r) {
    A.eq('bid: ' + s + ' NOT retried, surfaced', [c.length, r.status], [1, s]);
  });
});
bidCase('near', [{ status: 404, body: '' }, { status: 200, body: '{}' }], { near: '40.1,-73.2', mi: 50, kind: 'contractor' },
  'https://h/api/vendor-prospects?near=40.1,-73.2&mi=50&kind=contractor', function (c) {
    A.eq('bid: pipeline query values are strings', JSON.parse(c[0].data).query, { near: '40.1,-73.2', mi: '50', kind: 'contractor' });
    A.eq('bid: explicit getUrl used verbatim on fallback', c[1].url, 'https://h/api/vendor-prospects?near=40.1,-73.2&mi=50&kind=contractor');
  });

// ---- structure over the full files ---------------------------------------------------------------
function count(text, s) { return text.split(s).length - 1; }
A.eq('ai: 5 call sites + 1 def use swaRead', count(AI, 'swaRead('), 6);
A.ok('ai: swaSync via swaRead', /swaRead\(INGEST_URL, \{ client: INGEST_CLIENT, target: tr \}/.test(AI));
A.ok('ai: loadPrevLines chunk via swaRead', /swaRead\(INGEST_URL, \{ client: INGEST_CLIENT, o30: targets\.slice/.test(AI));
A.ok('ai: fetchAuthored target + o30 via swaRead',
  /swaRead\(INGEST_URL, \{ client: INGEST_CLIENT, target: digits \}/.test(AI) && /swaRead\(INGEST_URL, \{ client: INGEST_CLIENT, o30: digits \}/.test(AI));
A.ok('ai: vpFetchCity via swaRead', /swaRead\(PROSPECTS_URL, \{ city: cs\.city, state: cs\.state, kind: kind \}/.test(AI));
A.ok('ai: no raw GET left on wo-ingest/vendor-prospects reads',
  !/method: 'GET'[\s\S]{0,80}url: (INGEST_URL|PROSPECTS_URL)/.test(AI.replace(AI_HELPER, '')));
A.ok('ai: govFetch left alone (no swaRead on GOV_URL)', !/swaRead\(GOV_URL/.test(AI));
A.eq('bid: 2 call sites + 1 def use swaRead', count(BID, 'swaRead('), 3);
A.ok('bid: pipelineFetch + bidStatus via swaRead',
  /swaRead\(PROSPECTS_URL, \{ near: near/.test(BID) && /swaRead\(STATUS_URL, \{ tracking: tracking \}/.test(BID));
A.ok('bid: vsGovernance left alone', /gmGet\(GOV_URL/.test(BID));
A.ok('versions bumped', /@version\s+1\.48\.4/.test(AI) && /@version\s+0\.29\.2/.test(BID) && BID.indexOf("var VER = '0.29.4'") > 0);

Promise.all(jobs).then(function () { A.finish(); });
