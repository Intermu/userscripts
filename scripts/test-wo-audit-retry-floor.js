// test-wo-audit-retry-floor.js - node harness for the retry-floor blocker (council QA-1a).
//
// THE DEFECT (live across c4e0aea + 97ce909): `pause(hinted || table[...])` gave the server's
// `retry-after` ABSOLUTE priority with no floor. Commit 97ce909 then made the server emit the
// REAL remaining rate-limit window - which is the wait for ONE slot to free (~1s under a steady
// batch), not the wait until this caller is admitted. So a throttled row slept 1s, 1s, and
// errored: three tries inside about two seconds, out of a 150-second budget. That is the exact
// sub-2s burn c4e0aea exists to remove, reintroduced by making the server honest. Neither commit
// is wrong on its own, which is why no single-repo review caught it.
//
// Two further defects in the same function, fixed and covered here:
//   QA-6a  `hadHeader` was inferred as `hinted > 0`, so a header the server DID send but which
//          clamps to 0 logged "(no retry-after header)" - the one string designated as the live
//          proof that the SWA edge forwards the header at all.
//   QA-4a  `pause` abandoned the row whenever the wait did not fit, reporting "the 150s limit
//          ran out" with tens of seconds unspent, instead of trimming the wait.
//
// Drives the REAL shipped bytes: slices the transport section out of the .user.js and runs it
// on a virtual clock, reusing the injection signature of scripts/test-bwn-ai-phase3.js. Assert
// on the SCHEDULE the code chose, never on wall-clock elapsed - see the vault's
// headless-harness-timing-trap note.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-retry-floor.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');
var RealDate = Date;

function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf('// ===== BWN AI TRANSPORT');
  var b = t.indexOf('bwnAI.setProxy(aiProxySend);');
  if (a === -1 || b === -1) throw new Error('transport markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = extractSection();

// `script` entries: { status, json, retryAfter (string|number|undefined), attemptMs }
function load(script) {
  var now = 1700000000000, start = now;
  var slept = [], posts = [];

  function sleep(ms) { slept.push(ms); now += ms; return Promise.resolve(); }

  function gmPost(url, headers, bodyObj, timeoutMs) {
    var i = posts.length;
    var r = script[Math.min(i, script.length - 1)];
    posts.push({ at: now - start, timeoutMs: timeoutMs });
    if (r.attemptMs) now += r.attemptMs;      // an attempt is not instantaneous
    if (r.networkError) return Promise.reject(new Error('network error'));
    if (r.timedOut) return Promise.reject(new Error('timed out'));
    var hdr = 'content-type: application/json\r\n';
    if (r.retryAfter !== undefined) hdr = 'retry-after: ' + r.retryAfter + '\r\n' + hdr;
    return Promise.resolve({ status: r.status, json: r.json || { ok: false, error: 'rate limited' }, headers: hdr });
  }

  function vDate(a) { return a === undefined ? new RealDate(now) : new RealDate(a); }
  vDate.now = function () { return now; };
  vDate.parse = function (s) { return RealDate.parse(s); };
  vDate.UTC = function () { return RealDate.UTC.apply(RealDate, arguments); };
  vDate.prototype = RealDate.prototype;

  var factory = new Function(
    'SWA_BASE', 'getKey', 'authToken', 'gmPost', 'sleep', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'console', 'Date',
    SECTION + '\n;return { aiProxySend: aiProxySend, retryAfterMs: retryAfterMs, hasRetryAfter: hasRetryAfter,' +
    ' THROTTLE_BACKOFF_MS: THROTTLE_BACKOFF_MS, TRANSIENT_BACKOFF_MS: TRANSIENT_BACKOFF_MS,' +
    ' AI_ROW_BUDGET_MS: AI_ROW_BUDGET_MS, AI_MIN_ATTEMPT_MS: AI_MIN_ATTEMPT_MS };'
  );
  var T = factory(
    'https://swa.example',
    function () { return 'test-key'; },
    function () { return 'umbrava-bearer'; },
    gmPost, sleep,
    { addEventListener: function () {} },
    { getItem: function () { return null; } },
    setTimeout, clearTimeout, console, vDate
  );
  return {
    T: T, slept: slept, posts: posts,
    elapsed: function () { return now - start; }
  };
}

function run(script) {
  var h = load(script);
  var waits = [];
  var ctx = { onWait: function (ms, throttled, hadHeader) { waits.push({ ms: ms, throttled: throttled, hadHeader: hadHeader }); } };
  return h.T.aiProxySend({ task: 'summarize', prompt: 'x' }, ctx).then(function (text) {
    return { text: text, reason: ctx.reason, slept: h.slept, posts: h.posts.length, waits: waits, elapsed: h.elapsed(), T: h.T };
  });
}

function thr(retryAfter, attemptMs) {
  return { status: 429, json: { ok: false, error: 'rate limited' }, retryAfter: retryAfter, attemptMs: attemptMs === undefined ? 200 : attemptMs };
}

// ---- 1. the blocker ---------------------------------------------------------------------
function section1() {
  console.log('\n1. a truthful 1s retry-after must NOT shorten the schedule');
  return run([thr(1), thr(1), thr(1)]).then(function (o) {
    A.eq('sleeps use the class table, not the 1s hint', o.slept, [15000, 45000]);
    A.eq('all 3 attempts were made', o.posts, 3);
    A.ok('this is a real backoff, not a ~2s burn', o.elapsed >= 60000, 'elapsed=' + o.elapsed);
    A.ok('reason names rate limiting', /rate limited/.test(o.reason || ''), o.reason);
  });
}

// ---- 2. a LONGER hint still wins ---------------------------------------------------------
function section2() {
  console.log('\n2. flooring must not become ignoring');
  return run([thr(90), thr(1), thr(1)]).then(function (o) {
    A.eq('90s hint beats the 15s first step', o.slept[0], 90000);
    return run([thr(30), thr(30), thr(30)]);
  }).then(function (o) {
    A.eq('30s beats the 15s step, loses to the 45s step', o.slept, [30000, 45000]);
    return run([{ status: 502, json: { ok: false, error: 'upstream' }, attemptMs: 200 }, { status: 502, json: { ok: false }, attemptMs: 200 }, { status: 502, json: { ok: false }, attemptMs: 200 }]);
  }).then(function (o) {
    A.eq('non-throttle 5xx uses the transient table', o.slept, [2000, 6000]);
  });
}

// ---- 3. hadHeader is presence, not value -------------------------------------------------
function section3() {
  console.log('\n3. hadHeader reports the HEADER, not the parsed value');
  return run([thr(0), thr(0), thr(0)]).then(function (o) {
    A.ok('retry-after: 0 still reports hadHeader true', o.waits[0].hadHeader === true, JSON.stringify(o.waits[0]));
    A.eq('and the wait falls back to the table', o.slept[0], 15000);
    return run([thr('soon'), thr('soon'), thr('soon')]);
  }).then(function (o) {
    A.ok('unparseable retry-after still reports hadHeader true', o.waits[0].hadHeader === true, JSON.stringify(o.waits[0]));
    return run([thr(undefined), thr(undefined), thr(undefined)]);
  }).then(function (o) {
    A.ok('genuinely absent header reports hadHeader false', o.waits[0].hadHeader === false, JSON.stringify(o.waits[0]));
  });
}

// ---- 4. budget trimmed, not abandoned ----------------------------------------------------
function section4() {
  console.log('\n4. an over-long wait is trimmed, and only a real deadline says so');
  return run([thr(100), thr(100), thr(1)]).then(function (o) {
    A.ok('row was not abandoned after the first wait', o.slept.length >= 2, JSON.stringify(o.slept));
    A.eq('three attempts still made', o.posts, 3);
    A.ok('second wait was TRIMMED, not the full 100s', o.slept[1] < 100000, JSON.stringify(o.slept));
    var total = o.slept.reduce(function (a, b) { return a + b; }, 0);
    A.ok('total sleep stays inside the row budget', total < o.T.AI_ROW_BUDGET_MS, 'total=' + total);
    A.ok('never runs past the budget', o.elapsed <= o.T.AI_ROW_BUDGET_MS, 'elapsed=' + o.elapsed);
  });
}

// ---- 5. constants pinned ------------------------------------------------------------------
function section5() {
  console.log('\n5. constants are pinned');
  var h = load([thr(1)]);
  A.eq('THROTTLE_BACKOFF_MS', h.T.THROTTLE_BACKOFF_MS, [15000, 45000]);
  A.eq('TRANSIENT_BACKOFF_MS', h.T.TRANSIENT_BACKOFF_MS, [2000, 6000]);
  A.eq('AI_ROW_BUDGET_MS', h.T.AI_ROW_BUDGET_MS, 150000);
  A.eq('AI_MIN_ATTEMPT_MS', h.T.AI_MIN_ATTEMPT_MS, 8000);
  A.ok('throttle table clears a 60s window cumulatively',
    h.T.THROTTLE_BACKOFF_MS.reduce(function (a, c) { return a + c; }, 0) >= 60000);
  A.eq('hasRetryAfter: present-but-zero', h.T.hasRetryAfter('retry-after: 0\r\n'), true);
  A.eq('hasRetryAfter: absent', h.T.hasRetryAfter('content-type: x\r\n'), false);
  A.eq('retryAfterMs contract unchanged (phase3 depends on it)', h.T.retryAfterMs('retry-after: 42\r\n'), 42000);
  return Promise.resolve();
}

console.log('WO Audit retry floor (council QA-1a) - ' + path.basename(SRC));
section1().then(section2).then(section3).then(section4).then(section5)
  .then(function () { A.finish(); })
  .catch(function (e) { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
