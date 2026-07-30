// test-bwn-ai-phase3.js - node harness for the Phase 3 consumer migration (TASK-011/013/014).
//
// Verifies, against the REAL shipped code (sliced out by markers + evaluated with stubs,
// never rewritten):
//   - suite-ai: the injected proxy sender attaches the tool registry ONLY for task:'ask';
//     draft/render go single round-trip, tool-free (TASK-013 safety).
//   - wo-audit: the pasted bwnAI block is BYTE-IDENTICAL to the suite copy; the minimal
//     sender builds the correct /api/ai POST ({task:'summarize', input, model, userToken,
//     system}) and returns the `final` text; summarize() routes through bwnAI and a proxy
//     miss surfaces as a thrown error so the batch pool marks the row (TASK-011).
//   - static: each migrated consumer calls bwnAI with the right task + a generous timeoutMs.
//   - static (TASK-014): NO api.anthropic.com / anthropic_key anywhere in the suite.
//   - PAT-002: the bwnAI block SHA matches across drop-upload, suite-ai, wo-audit.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bwn-ai-phase3.js

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var DIR = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n'); }

// ---- assert harness (shared: scripts/assert.js) ---------------------------------------
var assert = require('./assert.js');
var ok = assert.ok, eq = assert.eq;

// ---- shared stubs ---------------------------------------------------------------------
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function umbravaJwt() { return 'h.' + b64url({ iss: 'https://login.umbrava.com/', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u1' }) + '.s'; }
function atobStub(s) { return Buffer.from(s, 'base64').toString('binary'); }
function makeLS(seed) {
  var ls = {};
  ls['@@auth0spajs@@::client::https://app.umbrava.com/api::openid'] = JSON.stringify({ body: { access_token: umbravaJwt() } });
  if (seed) Object.keys(seed).forEach(function (k) { ls[k] = seed[k]; });
  Object.defineProperty(ls, 'getItem', { value: function (k) { return Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null; } });
  Object.defineProperty(ls, 'setItem', { value: function (k, v) { ls[k] = String(v); } });
  return ls;
}
var docStub = { addEventListener: function () {} };
var roleSlot = function () { return { 'bwn:role:last': JSON.stringify({ ok: true, rank: 4, ts: Date.now() }) }; };

// ============================================================================
// suite-ai transport (slice the BWN AI TRANSPORT section, like the Phase 2 harness)
// ============================================================================
function loadSuiteTransport(opts) {
  opts = opts || {};
  var t = read('bwn-suite-ai.user.js');
  var a = t.indexOf('// ===== BWN AI TRANSPORT');
  var b = t.indexOf('// ===== END BWN AI TRANSPORT');
  if (a === -1 || b === -1) throw new Error('suite-ai transport markers not found');
  var section = t.slice(a, t.indexOf('\n', b));
  var factory = new Function(
    'connectorEnabled', 'GM_getValue', 'GM_xmlhttpRequest', 'fetch', 'atob', 'localStorage', 'document', 'setTimeout', 'clearTimeout', 'console',
    section + '\n;return { bwnAI: bwnAI, AI_TOOL_DEFS: AI_TOOL_DEFS, aiProxySend: aiProxySend };'
  );
  return factory(
    opts.connectorEnabled || function () { return true; },
    function (k, d) { return (k === 'ingest_key') ? 'test-key' : d; },
    opts.GM_xmlhttpRequest || function () {},
    function () { return Promise.resolve({ json: function () { return Promise.resolve({ data: {} }); } }); },
    atobStub, makeLS(opts.seed), docStub, setTimeout, clearTimeout, console
  );
}

// A GM_xmlhttpRequest stub driven by a scripted list; records parsed request bodies.
function makeGM(script) {
  var i = 0, sent = [];
  function fn(o) {
    var body = null; try { body = JSON.parse(o.data); } catch (e) {}
    sent.push(body);
    var r = script[i++]; var status = (r && typeof r.status === 'number') ? r.status : 200;
    var json = (r && r.json !== undefined) ? r.json : r;
    Promise.resolve().then(function () { try { o.onload({ status: status, responseText: JSON.stringify(json) }); } catch (e) { if (o.onerror) o.onerror(e); } });
  }
  return { fn: fn, sent: sent };
}

// ============================================================================
// wo-audit transport (slice from its BWN AI TRANSPORT marker to the runner)
// ============================================================================
function loadWoAudit(opts) {
  opts = opts || {};
  var t = read('bwn-wo-audit.user.js');
  var a = t.indexOf('// ===== BWN AI TRANSPORT (Phase 3, TASK-011)');
  var b = t.indexOf('// ---- Bounded-concurrency runner ----');
  if (a === -1 || b === -1) throw new Error('wo-audit transport markers not found');
  var section = t.slice(a, b);
  var gmScript = opts.gmScript || [];
  var gi = 0, gsent = [];
  function gmPost(url, headers, bodyObj, timeoutMs) {
    gsent.push({ url: url, headers: headers, body: bodyObj, timeoutMs: timeoutMs });
    var r = gmScript[gi++];
    // `takesMs` burns virtual wire time, so a slow attempt counts against the row budget the
    // same way it does live - the pathological all-slow case is otherwise untestable.
    var wire = (r && r.takesMs) || 0;
    // Honor timeoutMs the way GM_xmlhttpRequest does: a wire time past the cap fires ontimeout
    // at the cap, it does NOT run long. Ignoring this made the stub blow through budgets no
    // real request could blow through, and reported it as a product bug.
    var cap = timeoutMs || 60000;
    if (wire > cap) return vAdvance(cap).then(function () { return Promise.reject(new Error('timed out')); });
    return (wire ? vAdvance(wire) : Promise.resolve()).then(function () {
      if (r && r.reject) return Promise.reject(new Error(r.reject === true ? 'network error' : String(r.reject)));
      // Only a NUMERIC status is the HTTP status; otherwise the script entry IS the json body
      // (mirrors the Phase 2 makeGM stub so {ok,status:'final',text} maps to a 200 with json).
      var status = (r && typeof r.status === 'number') ? r.status : 200;
      var json = (r && r.json !== undefined) ? r.json : r;
      // `resHeaders` becomes the raw CRLF blob the real gmPost hands back from
      // GM_xmlhttpRequest's responseHeaders, so retry-after parsing is exercised for real.
      return { status: status, json: json, headers: (r && r.resHeaders) || '' };
    });
  }
  // ONE virtual clock drives sleep, setTimeout AND Date.now, because the thing that has to be
  // observable is the RACE between the sender's backoff and the frozen router's
  // withTimeout(run, timeoutMs). A merely-instant sleep stub cannot see that race at all: it
  // was why a 15s+45s schedule inside a 60s router budget tested green while being a guaranteed
  // row failure in production. Timers fire in due order as the clock is advanced by sleeps, so
  // tests stay fast and deterministic while the arithmetic is real.
  var slept = [];
  var RealDate = Date;
  var T0 = RealDate.now();          // anchor to real time so the seeded role-cache ts stays valid
  var clock = { now: T0, timers: [], seq: 0 };
  function vSetTimeout(fn, ms) {
    var t = { at: clock.now + (ms || 0), fn: fn, id: ++clock.seq };
    clock.timers.push(t);
    return t.id;
  }
  function vClearTimeout(id) { clock.timers = clock.timers.filter(function (t) { return t.id !== id; }); }
  // Fire every timer due at or before the target, in time order, letting each one's microtasks
  // settle before the next - that is what makes a withTimeout abort land in the correct place
  // relative to a resuming sleep.
  function vAdvance(ms) {
    var target = clock.now + ms;
    return (function step() {
      var due = clock.timers
        .filter(function (t) { return t.at <= target; })
        .sort(function (a, b) { return a.at - b.at || a.id - b.id; });
      if (!due.length) { clock.now = target; return Promise.resolve(); }
      var t = due[0];
      clock.timers = clock.timers.filter(function (x) { return x !== t; });
      clock.now = t.at;
      try { t.fn(); } catch (e) { /* a timer throwing must not wedge the clock */ }
      return new Promise(function (r) { process.nextTick(r); }).then(step);
    })();
  }
  function vSleep(ms) { slept.push(ms); return vAdvance(ms); }
  var factory = new Function(
    'SWA_BASE', 'getKey', 'authToken', 'gmPost', 'sleep', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'console', 'Date',
    section + '\n;return { bwnAI: bwnAI, aiProxySend: aiProxySend, summarize: summarize, buildAuditInput: buildAuditInput, WO_AUDIT_SYSTEM: WO_AUDIT_SYSTEM, retryAfterMs: retryAfterMs, AI_ROW_BUDGET_MS: AI_ROW_BUDGET_MS, AI_ROUTER_TIMEOUT_MS: AI_ROUTER_TIMEOUT_MS, causeText: causeText, isThrottle: isThrottle };'
  );
  // Date.now is virtual; everything else on Date stays real (retryAfterMs parses HTTP-dates).
  function vDate(a) { return a === undefined ? new RealDate(clock.now) : new RealDate(a); }
  vDate.now = function () { return clock.now; };
  vDate.parse = function (s) { return RealDate.parse(s); };
  vDate.UTC = function () { return RealDate.UTC.apply(RealDate, arguments); };
  vDate.prototype = RealDate.prototype;
  var api = factory(
    'https://swa.example',
    function () { return opts.key !== undefined ? opts.key : 'test-key'; },
    function () { return opts.token !== undefined ? opts.token : 'umbrava-bearer'; },
    gmPost,
    vSleep,
    docStub, makeLS(opts.seed), vSetTimeout, vClearTimeout, console, vDate
  );
  api._gsent = gsent;
  api._slept = slept;
  api._clock = clock;
  api._advance = vAdvance;
  api._elapsed = function () { return clock.now - T0; };
  return api;
}

// ---- run ------------------------------------------------------------------------------
function run() {
  var chain = Promise.resolve();

  // === suite-ai: sender tool-gating (TASK-013 safety) =================================
  chain = chain.then(function () {
    var gm = makeGM([{ ok: true, status: 'final', text: 'drafted body' }]);
    var T = loadSuiteTransport({ GM_xmlhttpRequest: gm.fn });
    return T.aiProxySend({ task: 'draft', prompt: 'draft a vendor note', system: 'SYS' }).then(function (text) {
      eq('draft sender reaches final', text, 'drafted body');
      ok('draft POST carries NO tools (tool-free)', gm.sent[0].tools === undefined, JSON.stringify(gm.sent[0]));
      ok('draft POST task=draft', gm.sent[0].task === 'draft');
      ok('draft POST passes caller system through', gm.sent[0].system === 'SYS');
      ok('draft POST carries userToken in BODY', typeof gm.sent[0].userToken === 'string' && gm.sent[0].userToken.length > 0);
    });
  });
  chain = chain.then(function () {
    var gm = makeGM([{ ok: true, status: 'final', text: 'answer' }]);
    var T = loadSuiteTransport({ GM_xmlhttpRequest: gm.fn });
    return T.aiProxySend({ task: 'ask', prompt: 'what WOs?', system: 'IGNORED' }).then(function () {
      ok('ask POST DOES carry the tool registry', Array.isArray(gm.sent[0].tools) && gm.sent[0].tools.length === 3);
    });
  });

  // === wo-audit: minimal sender + summarize (TASK-011) ================================
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [{ ok: true, status: 'final', text: 'WO 375038 is scheduled for Tuesday.' }] });
    var woFacts = { raw: 'W-375038', status: 'Pending Dispatch', city: 'Tampa', state: 'FL', location: 'PFJ #123', days: '12', assignedTo: 'Lisa P' };
    var notes = [{ content: 'Vendor confirmed Tuesday.', createdDate: '2026-07-22', type: 'client' }, { content: 'Parts arrived.', createdDate: '2026-07-21', type: 'internal' }];
    return T.summarize(woFacts, notes, 'claude-sonnet-5').then(function (note) {
      eq('wo-audit summarize returns final text', note, 'WO 375038 is scheduled for Tuesday.');
      var body = T._gsent[0].body;
      ok('wo-audit POST hits /api/ai', /\/api\/ai$/.test(T._gsent[0].url), T._gsent[0].url);
      ok('wo-audit POST task=summarize', body.task === 'summarize');
      ok('wo-audit POST model forwarded', body.model === 'claude-sonnet-5');
      ok('wo-audit POST carries userToken', body.userToken === 'umbrava-bearer');
      ok('wo-audit POST system = the audit prompt', body.system === T.WO_AUDIT_SYSTEM);
      ok('wo-audit POST input carries WO # + notes', /W-375038/.test(body.input) && /Vendor confirmed Tuesday/.test(body.input));
      ok('wo-audit POST input is x-bwn-key gated', T._gsent[0].headers['x-bwn-key'] === 'test-key');
      ok('wo-audit POST sends NO tools (summarize)', body.tools === undefined);
    });
  });

  // proxy miss -> summarize throws (batch pool marks the row / Retry Errors still works), and
  // the thrown message names the REAL cause in words, not the old canned key/role guess.
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [{ status: 500, json: { ok: false, error: 'ai error' } }, { status: 500, json: { ok: false, error: 'ai error' } }, { status: 500, json: { ok: false, error: 'ai error' } }] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function () {
      ok('wo-audit miss should have thrown', false);
    }, function (e) {
      var m = (e && e.message) || '';
      ok('wo-audit leads with a plain-language cause', /^the AI service errored/.test(m), m);
      ok('wo-audit keeps the wire detail for support', /HTTP 500/.test(m) && /ai error/.test(m), m);
      ok('wo-audit reports the try count', /after 3 tries/.test(m), m);
      ok('wo-audit no longer repeats the key/role guidance per row', !/ingest key/i.test(m) && !/Retry Errors/.test(m), m);
      eq('5xx uses the transient backoff table (was 600/1200ms)', JSON.stringify(T._slept), '[2000,6000]');
      eq('per-attempt HTTP timeout is the budgeted one', T._gsent[0].timeoutMs, 45000);
    });
  });

  // THE REGRESSION THIS SUITE PREVIOUSLY COULD NOT SEE. A 429 is a 60s sliding window on both
  // sides of the wire, so the schedule must span it - but the frozen bwnAI router wraps the
  // whole run in withTimeout(run, timeoutMs). With the old 60000ms budget the schedule summed
  // to exactly the budget and attempt 3 could never land: the row failed after waiting a full
  // minute AND lost its reason. The virtual clock makes that race observable.
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [
      { status: 429, json: { ok: false, error: 'rate limited; slow down' } },
      { status: 429, json: { ok: false, error: 'rate limited; slow down' } },
      { ok: true, status: 'final', text: 'Recovered after the throttle cleared.' },
    ] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function (note) {
      eq('429 x2 then success -> row still writes', note, 'Recovered after the throttle cleared.');
      eq('429 backoff spans the full 60s window', JSON.stringify(T._slept), '[15000,45000]');
      eq('all three attempts actually reached the wire', T._gsent.length, 3);
      ok('the row settled INSIDE the router budget', T._elapsed() < T.AI_ROUTER_TIMEOUT_MS,
        'elapsed ' + T._elapsed() + ' vs router budget ' + T.AI_ROUTER_TIMEOUT_MS);
      ok('the backoff schedule fits the row budget', 60000 < T.AI_ROW_BUDGET_MS,
        'schedule 60000 vs row budget ' + T.AI_ROW_BUDGET_MS);
    });
  });

  // The sender must always report before the router aborts, even when every attempt is slow:
  // a router win resolves '' with no reason and reintroduces the generic rank/key message.
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [
      { status: 429, json: { ok: false }, takesMs: 44000 },
      { status: 429, json: { ok: false }, takesMs: 44000 },
      { status: 429, json: { ok: false }, takesMs: 44000 },
    ] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function () {
      ok('slow-throttle row should have thrown', false);
    }, function (e) {
      var m = (e && e.message) || '';
      ok('a slow throttled row still reports a real cause', /rate limit|busy/i.test(m), m);
      ok('it never falls through to the rank/key fallback', !/rank not resolved/i.test(m), m);
      ok('the sender reported before the router budget', T._elapsed() < T.AI_ROUTER_TIMEOUT_MS,
        'elapsed ' + T._elapsed() + ' vs ' + T.AI_ROUTER_TIMEOUT_MS);
      ok('no POST was issued past the row budget', T._gsent.length <= 3, 'posts ' + T._gsent.length);
    });
  });

  // An upstream Anthropic throttle arrives as a GENERIC 502 naming the status in the body.
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [
      { status: 502, json: { ok: false, error: 'Anthropic API error (429)' } },
      { ok: true, status: 'final', text: 'ok' },
    ] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function () {
      eq('502-carrying-429 uses the THROTTLE table, not the fast one', JSON.stringify(T._slept), '[15000]');
    });
  });
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [] });
    ok('isThrottle: bare 429', T.isThrottle({ status: 429 }));
    ok('isThrottle: bare 529', T.isThrottle({ status: 529 }));
    ok('isThrottle: 502 wrapping 429', T.isThrottle({ status: 502, json: { error: 'Anthropic API error (429)' } }));
    ok('isThrottle: 502 wrapping 529', T.isThrottle({ status: 502, json: { error: 'Anthropic API error (529)' } }));
    ok('isThrottle: plain 502 is NOT a throttle', !T.isThrottle({ status: 502, json: { error: 'Anthropic API error (500)' } }));
    ok('isThrottle: 500 is NOT a throttle', !T.isThrottle({ status: 500, json: {} }));
    // The load-bearing invariant of the whole rework.
    ok('router backstop strictly exceeds the row budget',
      T.AI_ROUTER_TIMEOUT_MS > T.AI_ROW_BUDGET_MS, T.AI_ROUTER_TIMEOUT_MS + ' vs ' + T.AI_ROW_BUDGET_MS);
    ok('row budget leaves room for a full 60s throttle wait plus two attempts',
      T.AI_ROW_BUDGET_MS >= 60000 + 2 * 45000, String(T.AI_ROW_BUDGET_MS));
  });

  // A 403/400/413 is a verdict, not weather - retrying it only burns the row budget.
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [{ status: 403, json: { ok: false, error: 'unauthorized' } }] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function () {
      ok('403 row should have thrown', false);
    }, function (e) {
      eq('403 is not retried', T._gsent.length, 1);
      eq('403 costs no backoff', JSON.stringify(T._slept), '[]');
      ok('403 names the key, not a generic error', /ingest key/i.test((e && e.message) || ''), (e && e.message) || '');
    });
  });

  // retry-after wins over the built-in table, in both units RFC 9110 allows, and is clamped.
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [
      { status: 429, json: { ok: false }, resHeaders: 'content-type: application/json\r\nRetry-After: 30\r\n' },
      { ok: true, status: 'final', text: 'ok' },
    ] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function () {
      eq('server retry-after overrides the table', JSON.stringify(T._slept), '[30000]');
    });
  });
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [
      { status: 429, json: { ok: false }, resHeaders: 'retry-after: 9999\r\n' },
      { ok: true, status: 'final', text: 'ok' },
    ] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function () {
      eq('a wild retry-after is clamped to 120s', JSON.stringify(T._slept), '[120000]');
    });
  });
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [] });
    var f = T.retryAfterMs;
    eq('retryAfterMs: delay-seconds', f('retry-after: 42\r\n'), 42000);
    eq('retryAfterMs: case/space insensitive', f('  RETRY-AFTER :  7 \r\n'), 7000);
    eq('retryAfterMs: absent -> 0', f('content-type: text/plain\r\n'), 0);
    eq('retryAfterMs: garbage -> 0', f('retry-after: soon\r\n'), 0);
    eq('retryAfterMs: empty blob -> 0', f(''), 0);
    eq('retryAfterMs: past HTTP-date -> 0', f('retry-after: Wed, 21 Oct 2015 07:28:00 GMT\r\n'), 0);
    ok('retryAfterMs: future HTTP-date -> ms', f('retry-after: ' + new Date(Date.now() + 20000).toUTCString() + '\r\n') > 15000);
  });

  // no ingest key -> sender misses -> summarize throws (never hangs), and says so precisely.
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), key: '', gmScript: [] });
    return T.summarize({ raw: '1' }, [], 'claude-haiku-4-5').then(function () {
      ok('wo-audit no-key should have thrown', false);
    }, function (e) {
      ok('wo-audit no ingest key -> summarize throws (no POST)', T._gsent.length === 0);
      ok('wo-audit names the missing ingest key', /no ingest key set/.test((e && e.message) || ''), (e && e.message) || '');
    });
  });

  return chain;
}

// === static assertions (source-level; no eval) ========================================
function staticChecks() {
  // Each migrated consumer calls bwnAI with the right task + a generous timeoutMs.
  var ai = read('bwn-suite-ai.user.js');
  var gi = ai.indexOf('function generate(systemPrompt, userContent, maxTokens, cb, onStream) {');
  var gseg = ai.slice(gi, gi + 800);
  ok('suite-ai generate() routes through bwnAI', /bwnAI\(\{/.test(gseg));
  ok("suite-ai draft uses task:'draft'", /task:\s*'draft'/.test(gseg));
  ok('suite-ai draft passes timeoutMs 60000', /timeoutMs:\s*60000/.test(gseg));

  var wo = read('bwn-wo-audit.user.js');
  var si = wo.indexOf('function summarize(woFacts, notes, model, onWait) {');
  ok('wo-audit summarize signature is findable', si !== -1);
  var sseg = wo.slice(si, si + 1100);
  ok('wo-audit summarize() routes through bwnAI', /bwnAI\(\{/.test(sseg));
  ok("wo-audit uses task:'summarize'", /task:\s*'summarize'/.test(sseg));
  ok("wo-audit forces tier:'proxy'", /tier:\s*'proxy'/.test(sseg));
  // The invariant is not a magic number: the router budget must EXCEED the sender's own row
  // budget, or a router win resolves '' and discards the reason - the bug this rework fixes.
  ok('wo-audit hands bwnAI the router-backstop budget', /timeoutMs:\s*AI_ROUTER_TIMEOUT_MS/.test(sseg));
  ok('router budget is derived from the row budget, not hardcoded',
    /AI_ROUTER_TIMEOUT_MS\s*=\s*AI_ROW_BUDGET_MS\s*\+/.test(wo));

  // TASK-014: NO direct Anthropic path anywhere in the suite.
  var scripts = fs.readdirSync(DIR).filter(function (f) { return /\.user\.js$/.test(f); });
  var badAnthropic = [], badKey = [];
  scripts.forEach(function (f) {
    var s = read(f);
    if (s.indexOf('api.anthropic.com') !== -1) badAnthropic.push(f);
    if (s.indexOf('anthropic_key') !== -1) badKey.push(f);
  });
  ok('no api.anthropic.com anywhere in the suite (TASK-014)', badAnthropic.length === 0, badAnthropic.join(','));
  ok('no anthropic_key anywhere in the suite (TASK-014)', badKey.length === 0, badKey.join(','));

  // PAT-002: byte-identical bwnAI block across the carrying scripts (bid-out carries none - deferred).
  function blockSha(f) {
    var s = read(f).replace(/\x00/g, '');
    var a = s.indexOf('// ===== bwnAI v1');
    var b = s.indexOf('// ===== END bwnAI =====');
    if (a === -1 || b === -1) return null;
    var end = s.indexOf('\n', b);
    return crypto.createHash('sha256').update(s.slice(a, end), 'utf8').digest('hex');
  }
  var carriers = ['bwn-drop-upload.user.js', 'bwn-suite-ai.user.js', 'bwn-wo-audit.user.js'];
  var shas = carriers.map(blockSha);
  var allEq = shas.every(function (h) { return h && h === shas[0]; });
  ok('bwnAI block byte-identical across drop-upload/suite-ai/wo-audit', allEq, carriers.map(function (f, i) { return f + '=' + (shas[i] || 'MISSING'); }).join(' '));
  console.log('  ... block SHA: ' + shas[0]);
  ok('bid-out carries NO bwnAI block (migration deferred)', blockSha('bwn-bid-out.user.js') === null);
}

console.log('BWN AI Phase 3 consumer-migration harness (TASK-011/013/014)\n');
run().then(function () {
  staticChecks();
  assert.finish();
}).catch(function (e) {
  console.error('\nHARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
