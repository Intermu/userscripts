// bwn-ai-phase3.test.js - Vitest suite for the Phase 3 consumer migration (TASK-011/013/014).
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
// Run: npm test   (or: npx vitest run scripts/bwn-ai-phase3.test.js)

import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n'); }

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

// === suite-ai: sender tool-gating (TASK-013 safety) =================================
describe('suite-ai sender tool-gating (TASK-013)', () => {
  test('draft goes tool-free, single round-trip, passes system + userToken', async () => {
    var gm = makeGM([{ ok: true, status: 'final', text: 'drafted body' }]);
    var T = loadSuiteTransport({ GM_xmlhttpRequest: gm.fn });
    var text = await T.aiProxySend({ task: 'draft', prompt: 'draft a vendor note', system: 'SYS' });
    expect(text).toBe('drafted body');
    expect(gm.sent[0].tools).toBeUndefined();       // draft carries NO tools
    expect(gm.sent[0].task).toBe('draft');
    expect(gm.sent[0].system).toBe('SYS');
    expect(typeof gm.sent[0].userToken).toBe('string');
    expect(gm.sent[0].userToken.length).toBeGreaterThan(0);
  });

  test('ask DOES carry the tool registry', async () => {
    var gm = makeGM([{ ok: true, status: 'final', text: 'answer' }]);
    var T = loadSuiteTransport({ GM_xmlhttpRequest: gm.fn });
    await T.aiProxySend({ task: 'ask', prompt: 'what WOs?', system: 'IGNORED' });
    expect(Array.isArray(gm.sent[0].tools)).toBe(true);
    expect(gm.sent[0].tools.length).toBe(3);
  });
});

// === wo-audit: minimal sender + summarize (TASK-011) ================================
describe('wo-audit minimal sender + summarize (TASK-011)', () => {
  test('summarize returns final text and builds the correct /api/ai POST', async () => {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [{ ok: true, status: 'final', text: 'WO 375038 is scheduled for Tuesday.' }] });
    var woFacts = { raw: 'W-375038', status: 'Pending Dispatch', city: 'Tampa', state: 'FL', location: 'PFJ #123', days: '12', assignedTo: 'Lisa P' };
    var notes = [{ content: 'Vendor confirmed Tuesday.', createdDate: '2026-07-22', type: 'client' }, { content: 'Parts arrived.', createdDate: '2026-07-21', type: 'internal' }];
    var note = await T.summarize(woFacts, notes, 'claude-sonnet-5');
    expect(note).toBe('WO 375038 is scheduled for Tuesday.');
    var body = T._gsent[0].body;
    expect(T._gsent[0].url).toMatch(/\/api\/ai$/);
    expect(body.task).toBe('summarize');
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.userToken).toBe('umbrava-bearer');
    expect(body.system).toBe(T.WO_AUDIT_SYSTEM);
    expect(body.input).toMatch(/W-375038/);
    expect(body.input).toMatch(/Vendor confirmed Tuesday/);
    expect(T._gsent[0].headers['x-bwn-key']).toBe('test-key');
    expect(body.tools).toBeUndefined();             // summarize sends NO tools
  });

  // proxy miss -> summarize throws (batch pool marks the row / Retry Errors still works).
  test('proxy miss -> summarize throws', async () => {
    var T = loadWoAudit({ seed: roleSlot(), gmScript: [{ status: 500, json: { ok: false } }, { status: 500, json: { ok: false } }, { status: 500, json: { ok: false } }] });
    await expect(T.summarize({ raw: '1' }, [], 'claude-sonnet-5')).rejects.toThrow(/unavailable/i);
  });

  // no ingest key -> sender misses -> summarize throws (never hangs).
  test('no ingest key -> summarize throws, no POST', async () => {
    var T = loadWoAudit({ seed: roleSlot(), key: '', gmScript: [] });
    await expect(T.summarize({ raw: '1' }, [], 'claude-haiku-4-5')).rejects.toThrow(/unavailable/i);
    expect(T._gsent.length).toBe(0);
  });
});

// === static assertions (source-level; no eval) ========================================
describe('static consumer wiring (TASK-011/013/014)', () => {
  test('suite-ai generate() routes through bwnAI with task:draft + timeoutMs 60000', () => {
    var ai = read('bwn-suite-ai.user.js');
    var gi = ai.indexOf('function generate(systemPrompt, userContent, maxTokens, cb, onStream) {');
    var gseg = ai.slice(gi, gi + 800);
    expect(gseg).toMatch(/bwnAI\(\{/);
    expect(gseg).toMatch(/task:\s*'draft'/);
    expect(gseg).toMatch(/timeoutMs:\s*60000/);
  });

  test('wo-audit summarize() routes through bwnAI with task:summarize, tier:proxy, timeoutMs 60000', () => {
    var wo = read('bwn-wo-audit.user.js');
    var si = wo.indexOf('function summarize(woFacts, notes, model) {');
    var sseg = wo.slice(si, si + 700);
    expect(sseg).toMatch(/bwnAI\(\{/);
    expect(sseg).toMatch(/task:\s*'summarize'/);
    expect(sseg).toMatch(/tier:\s*'proxy'/);
    expect(sseg).toMatch(/timeoutMs:\s*60000/);
  });

  // TASK-014: NO direct Anthropic path anywhere in the suite.
  test('no api.anthropic.com and no anthropic_key anywhere in the suite (TASK-014)', () => {
    var scripts = fs.readdirSync(DIR).filter(function (f) { return /\.user\.js$/.test(f); });
    var badAnthropic = [], badKey = [];
    scripts.forEach(function (f) {
      var s = read(f);
      if (s.indexOf('api.anthropic.com') !== -1) badAnthropic.push(f);
      if (s.indexOf('anthropic_key') !== -1) badKey.push(f);
    });
    expect(badAnthropic).toEqual([]);
    expect(badKey).toEqual([]);
  });

  // PAT-002: byte-identical bwnAI block across the carrying scripts (bid-out carries none - deferred).
  test('PAT-002: bwnAI block byte-identical across drop-upload/suite-ai/wo-audit; bid-out carries none', () => {
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
    expect(shas.every(function (h) { return h && h === shas[0]; })).toBe(true);
    console.log('  ... bwnAI block SHA: ' + shas[0]);
    expect(blockSha('bwn-bid-out.user.js')).toBe(null);
  });
});
