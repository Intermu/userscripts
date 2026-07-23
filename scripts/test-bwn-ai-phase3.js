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
    gsent.push({ url: url, headers: headers, body: bodyObj });
    var r = gmScript[gi++];
    if (r && r.reject) return Promise.reject(new Error('network'));
    // Only a NUMERIC status is the HTTP status; otherwise the script entry IS the json body
    // (mirrors the Phase 2 makeGM stub so {ok,status:'final',text} maps to a 200 with json).
    var status = (r && typeof r.status === 'number') ? r.status : 200;
    var json = (r && r.json !== undefined) ? r.json : r;
    return Promise.resolve({ status: status, json: json });
  }
  var factory = new Function(
    'SWA_BASE', 'getKey', 'authToken', 'gmPost', 'sleep', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'console',
    section + '\n;return { bwnAI: bwnAI, aiProxySend: aiProxySend, summarize: summarize, buildAuditInput: buildAuditInput, WO_AUDIT_SYSTEM: WO_AUDIT_SYSTEM };'
  );
  var api = factory(
    'https://swa.example',
    function () { return opts.key !== undefined ? opts.key : 'test-key'; },
    function () { return opts.token !== undefined ? opts.token : 'umbrava-bearer'; },
    gmPost,
    function () { return Promise.resolve(); },   // sleep: instant
    docStub, makeLS(opts.seed), setTimeout, clearTimeout, console
  );
  api._gsent = gsent;
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

  // proxy miss -> summarize throws (batch pool marks the row / Retry Errors still works).
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [{ status: 500, json: { ok: false } }, { status: 500, json: { ok: false } }, { status: 500, json: { ok: false } }] });
    return T.summarize({ raw: '1' }, [], 'claude-sonnet-5').then(function () {
      ok('wo-audit miss should have thrown', false);
    }, function (e) {
      ok('wo-audit proxy miss -> summarize throws', /unavailable/i.test((e && e.message) || ''));
    });
  });

  // no ingest key -> sender misses -> summarize throws (never hangs).
  chain = chain.then(function () {
    var T = loadWoAudit({ seed: roleSlot(), key: '', gmScript: [] });
    return T.summarize({ raw: '1' }, [], 'claude-haiku-4-5').then(function () {
      ok('wo-audit no-key should have thrown', false);
    }, function (e) {
      ok('wo-audit no ingest key -> summarize throws (no POST)', T._gsent.length === 0 && /unavailable/i.test((e && e.message) || ''));
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
  var si = wo.indexOf('function summarize(woFacts, notes, model) {');
  var sseg = wo.slice(si, si + 700);
  ok('wo-audit summarize() routes through bwnAI', /bwnAI\(\{/.test(sseg));
  ok("wo-audit uses task:'summarize'", /task:\s*'summarize'/.test(sseg));
  ok("wo-audit forces tier:'proxy'", /tier:\s*'proxy'/.test(sseg));
  ok('wo-audit passes timeoutMs 60000', /timeoutMs:\s*60000/.test(sseg));

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
