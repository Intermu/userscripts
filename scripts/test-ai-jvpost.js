// test-ai-jvpost.js - Job View write-back (jvPost) must not report success on a response that
// is not the wo-ingest endpoint's own `ok:true` JSON.
//
// THE DEFECT: jvPost's onload treated any 2xx as success. A redirect chased to an AAD login page
// lands as 200 HTML, and a refused write answers {ok:false}; both made saveJvNote toast
// "note saved to the Ops Dashboard" for a note that was never stored. The sibling transports
// (ingest drain, o30SnapPush) already require 2xx + JSON ok===true; jvPost now matches, and also
// requires the parsed body to be a non-null, non-array object.
//
// WHAT THIS DRIVES: the SHIPPED bytes of bwn-suite-ai.user.js - the Job View write-back block
// (jvCanWrite, jvPost, saveJvNote, pushJobFacts) sliced by fixed anchors and run in a vm with
// GM_xmlhttpRequest / GM_getValue / toast stubbed. No network, no writes, no duplicated predicate.
// A missing anchor exits non-zero: a broken extraction must never count as a pass.
//
// RED CONTROL: the same invalid-2xx cases are re-run against the slice with onload swapped back to
// the old status-only predicate, and must be ACCEPTED there - proving these cases catch the bug.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ai-jvpost.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-ai.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(src, startAnchor, endAnchor) {
  var s = src.indexOf(startAnchor), e = s === -1 ? -1 : src.indexOf(endAnchor, s);
  if (s === -1 || e === -1) {
    console.log('FATAL: source anchor missing (' + (s === -1 ? startAnchor : endAnchor) + ') - extraction broken, not a pass');
    process.exit(2);
  }
  return src.slice(s, e);
}
var BLOCK = slice(SRC, "var _jvTarget = '';", '// Freshen the CURRENT WO on the dashboard');
['function jvPost(', 'function saveJvNote(', 'function pushJobFacts('].forEach(function (a) {
  if (BLOCK.indexOf(a) === -1) { console.log('FATAL: ' + a + ' not in sliced block'); process.exit(2); }
});

// The pre-fix onload, verbatim from origin/main d22cb89, for the red control.
var OLD_ONLOAD = "onload:function(r){ var ok=r.status>=200&&r.status<300; if(cb) cb(ok, ok?'':('HTTP '+r.status)); },";
var ONLOAD_RE = /onload:function\(r\)\{[\s\S]*?\},\s*\n?\s*onerror:/;
if (!ONLOAD_RE.test(BLOCK)) { console.log('FATAL: jvPost onload not found in slice'); process.exit(2); }
var OLD_BLOCK = BLOCK.replace(ONLOAD_RE, OLD_ONLOAD + '\n        onerror:');

var TOKEN = 'TOKEN-SENTINEL-7f3a', BODYMARK = 'BODY-SENTINEL-91c2';
var INGEST = 'https://ingest.example/api/wo-ingest';

// Build a sandbox, run the block, then fire the captured request's handler with `resp`.
// resp: { status, text } | { event: 'error' | 'timeout' }
function run(block, resp, act) {
  var reqs = [], toasts = [], calls = [];
  var sb = {
    JSON: JSON, Object: Object, Array: Array, String: String, Date: Date, Math: Math, isNaN: isNaN,
    INGEST_URL: INGEST, INGEST_CLIENT: 'pilot',
    connectorEnabled: function () { return true; },
    GM_getValue: function (k) { return k === 'ingest_key' ? 'KEY-1' : ''; },
    ingestActor: function () { return 'tester'; },
    authToken: function () { return TOKEN; },
    toast: function (m) { toasts.push(m); },
    BWN: { lsGetJSON: function () { return null; }, ssGetJSON: function () { return null; }, busGet: function () { return null; } },
    GM_xmlhttpRequest: function (o) { reqs.push(o); },
    cbRec: function (ok, msg) { calls.push([ok, msg]); }
  };
  vm.createContext(sb);
  vm.runInContext(block + '\n_jvTarget = "4242";\nthis.__api = { jvPost: jvPost, saveJvNote: saveJvNote, pushJobFacts: pushJobFacts };', sb, { filename: 'jv-block.js' });
  var threw = null;
  try {
    act(sb.__api, sb.cbRec);
    var r = reqs[0];
    if (r) {
      if (resp.event === 'error') r.onerror();
      else if (resp.event === 'timeout') r.ontimeout();
      else r.onload({ status: resp.status, responseText: resp.text });
    }
  } catch (e) { threw = e; }
  return { reqs: reqs, toasts: toasts, calls: calls, threw: threw };
}
function note(block, resp) {
  return run(block, resp, function (api) { api.saveJvNote('hello', 'none', null); });
}
function facts(block, resp) {
  return run(block, resp, function (api, cb) { api.jvPost({ jobFacts: { target: '4242', status: 'Open' } }, cb); });
}
var SAVED = /note saved/i;

console.log('-- valid success --');
var n = note(BLOCK, { status: 200, text: '{"ok":true}' });
A.eq('noteWrite 200 {ok:true} toasts "note saved"', n.toasts.length === 1 && SAVED.test(n.toasts[0]), true);
var f = facts(BLOCK, { status: 200, text: '{"ok":true,"stored":1}' });
A.eq('jobFacts 200 {ok:true} -> cb(true, "")', f.calls, [[true, '']]);
var p = run(BLOCK, { status: 200, text: '{"ok":true}' }, function (api) { api.pushJobFacts({ wo: '375344', status: 'Open' }, '4242'); });
A.ok('pushJobFacts (no callback) posts once and is safe on success', p.reqs.length === 1 && !p.threw, String(p.threw));

console.log('\n-- request shape unchanged --');
var q = n.reqs[0], body = JSON.parse(q.data);
A.eq('POST to INGEST_URL?client=pilot', [q.method, q.url], ['POST', INGEST + '?client=pilot']);
A.eq('headers: Content-Type + x-bwn-key only', q.headers, { 'Content-Type': 'application/json', 'x-bwn-key': 'KEY-1' });
A.eq('timeout 20000', q.timeout, 20000);
A.eq('body: actor + userToken + noteWrite', body, { actor: 'tester', userToken: TOKEN, noteWrite: { target: '4242', note: 'hello', action: 'none' } });
A.eq('jobFacts body carries userToken + jobFacts', JSON.parse(f.reqs[0].data).userToken, TOKEN);

console.log('\n-- invalid 2xx -> cb(false, "unexpected response") --');
var BAD2XX = [
  ['200 HTML (AAD redirect)', 200, '<!doctype html><html>' + BODYMARK + '</html>'],
  ['200 malformed JSON', 200, '{"ok":true' + BODYMARK],
  ['200 {ok:false}', 200, '{"ok":false,"error":"' + BODYMARK + '"}'],
  ['200 null', 200, 'null'],
  ['200 array', 200, '[{"ok":true}]'],
  ['200 scalar true', 200, 'true'],
  ['200 scalar string', 200, '"ok"'],
  ['200 missing ok', 200, '{"stored":1}'],
  ['200 ok:"true" (string)', 200, '{"ok":"true"}'],
  ['204 empty body', 204, '']
];
BAD2XX.forEach(function (c) {
  var r = note(BLOCK, { status: c[1], text: c[2] });
  A.ok(c[0] + ': never "note saved"', r.toasts.length === 1 && !SAVED.test(r.toasts[0]), JSON.stringify(r.toasts));
  A.eq(c[0] + ': toast names the fixed reason', r.toasts[0], 'Job View: save failed - unexpected response');
  A.eq(c[0] + ': jobFacts cb', facts(BLOCK, { status: c[1], text: c[2] }).calls, [[false, 'unexpected response']]);
});

console.log('\n-- non-2xx -> cb(false, "HTTP <status>"), even with ok:true --');
[[500, '{"ok":true}'], [403, '{"ok":true}'], [302, '<html>' + BODYMARK + '</html>'], [400, '{"error":"' + BODYMARK + '"}']].forEach(function (c) {
  var r = note(BLOCK, { status: c[0], text: c[1] });
  A.eq(c[0] + ' ' + c[1].slice(0, 12) + ': toast', r.toasts, ['Job View: save failed - HTTP ' + c[0]]);
  A.eq(c[0] + ': jobFacts cb', facts(BLOCK, { status: c[0], text: c[1] }).calls, [[false, 'HTTP ' + c[0]]]);
});

console.log('\n-- network / timeout unchanged --');
A.eq('onerror -> cb(false, "network")', facts(BLOCK, { event: 'error' }).calls, [[false, 'network']]);
A.eq('ontimeout -> cb(false, "timeout")', facts(BLOCK, { event: 'timeout' }).calls, [[false, 'timeout']]);
A.eq('onerror note toast', note(BLOCK, { event: 'error' }).toasts, ['Job View: save failed - network']);

console.log('\n-- fire-and-forget pushJobFacts never throws on a rejected response --');
[[200, '<html></html>'], [200, 'null'], [500, '{"ok":true}'], { event: 'error' }, { event: 'timeout' }].forEach(function (c) {
  var resp = Array.isArray(c) ? { status: c[0], text: c[1] } : c;
  var r = run(BLOCK, resp, function (api) { api.pushJobFacts({ wo: '375344' }, '4242'); });
  A.ok('pushJobFacts safe on ' + JSON.stringify(resp).slice(0, 40), r.reqs.length === 1 && !r.threw && r.toasts.length === 0, String(r.threw));
});

console.log('\n-- no sentinel leaks into any message --');
var all = [];
BAD2XX.concat([['500', 500, '{"error":"' + BODYMARK + '"}']]).forEach(function (c) {
  var r = note(BLOCK, { status: c[1], text: c[2] }); all = all.concat(r.toasts);
  all = all.concat(facts(BLOCK, { status: c[1], text: c[2] }).calls.map(function (x) { return x[1]; }));
});
A.ok('no message contains the body sentinel', all.every(function (m) { return m.indexOf(BODYMARK) === -1; }), all.join(' | '));
A.ok('no message contains the token sentinel', all.every(function (m) { return m.indexOf(TOKEN) === -1; }), all.join(' | '));

console.log('\n-- red control: the old status-only predicate accepts the invalid 2xx cases --');
var oldAccepted = BAD2XX.filter(function (c) { return SAVED.test(note(OLD_BLOCK, { status: c[1], text: c[2] }).toasts[0] || ''); });
A.eq('old predicate toasts "note saved" for every invalid-2xx case', oldAccepted.length, BAD2XX.length);
A.ok('...and the shipped block does not contain the old predicate', BLOCK.indexOf(OLD_ONLOAD) === -1);

A.finish();
