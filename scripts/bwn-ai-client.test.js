// bwn-ai-client.test.js - Vitest suite for the Phase 2 client AI transport (TEST-003).
//
// Verifies the CLIENT half of the unified AI transport built into bwn-suite-ai.user.js:
// the tool registry (TASK-007), the tool-loop driver (TASK-008), and the injected proxy
// sender (TASK-009). It loads the REAL shipped code - it slices the "BWN AI TRANSPORT"
// section out of the .user.js by its markers and evaluates it in a stubbed sandbox
// (fetch / GM_xmlhttpRequest / GM_getValue / connectorEnabled / localStorage / atob /
// document injected as params). The code under test is NOT rewritten; only stubs and a
// trailing `return {...}` (test scaffolding) are added around the extracted bytes.
//
// Run: npm test   (or: npx vitest run scripts/bwn-ai-client.test.js)
//
// Covers: registry happy/edge/error paths, tool DEFS shape, the follow-up POST body
// (messages + toolResults with matching tool_use_id + tools + userToken), a scripted
// 2-tool conversation reaching status:'final', is_error propagation, unknown tool, a
// server miss (null), the client round cap terminating (never hangs), fresh-token re-read
// per round (RISK-001), and the sender's connector/key/bearer guards.

import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'bwn-suite-ai.user.js');

// ---- load + extract the transport section from the real file --------------------------
function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var startMark = '// ===== BWN AI TRANSPORT';
  var endMark = '// ===== END BWN AI TRANSPORT';
  var a = t.indexOf(startMark);
  var b = t.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error('transport markers not found in ' + SRC);
  // include through the end-marker line
  var end = t.indexOf('\n', b);
  return t.slice(a, end === -1 ? t.length : end);
}

// ---- sandbox stubs --------------------------------------------------------------------
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeUmbravaJwt() {
  var payload = { iss: 'https://login.umbrava.com/', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u1' };
  return 'h.' + b64url(payload) + '.s';
}
function atobStub(s) { return Buffer.from(s, 'base64').toString('binary'); }

function makeLocalStorage(token, seed) {
  var ls = {};
  if (token) ls['@@auth0spajs@@::client::https://app.umbrava.com/api::openid'] = JSON.stringify({ body: { access_token: token } });
  if (seed) Object.keys(seed).forEach(function (k) { ls[k] = seed[k]; });
  Object.defineProperty(ls, 'getItem', { enumerable: false, value: function (k) { return Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null; } });
  Object.defineProperty(ls, 'setItem', { enumerable: false, value: function (k, v) { ls[k] = String(v); } });
  Object.defineProperty(ls, 'removeItem', { enumerable: false, value: function (k) { delete ls[k]; } });
  Object.defineProperty(ls, '__setToken', { enumerable: false, value: function (tok) { ls['@@auth0spajs@@::client::https://app.umbrava.com/api::openid'] = JSON.stringify({ body: { access_token: tok } }); } });
  return ls;
}

var docStub = { addEventListener: function () {} };

// A GM_xmlhttpRequest stub driven by a scripted list of responses. Each response is a
// parsed JSON object (what the SWA would return) or a {status, json} pair, or a function
// (parsedRequestBody) -> response. Records every parsed request body it was handed.
function makeGM(script) {
  var i = 0;
  var sent = [];
  function fn(opts) {
    var body = null; try { body = JSON.parse(opts.data); } catch (e) {}
    sent.push(body);
    var r = script[i++];
    if (typeof r === 'function') r = r(body);
    var status = (r && typeof r.status === 'number') ? r.status : 200;
    var json = (r && r.json !== undefined) ? r.json : r;
    Promise.resolve().then(function () {
      try { opts.onload({ status: status, responseText: JSON.stringify(json) }); }
      catch (e) { if (opts.onerror) opts.onerror(e); }
    });
  }
  return { fn: fn, sent: sent };
}

// fetch stub for aiGql: returns a fixed GraphQL response body (data or errors).
function makeFetch(responseBody) {
  return function () {
    return Promise.resolve({ json: function () { return Promise.resolve(responseBody); } });
  };
}

// Build a fresh transport instance with the given stubs.
function loadTransport(opts) {
  opts = opts || {};
  var section = extractSection();
  var factory = new Function(
    'connectorEnabled', 'GM_getValue', 'GM_xmlhttpRequest', 'fetch', 'atob', 'localStorage', 'document', 'setTimeout', 'clearTimeout', 'console',
    section + '\n;return { bwnAI: bwnAI, AI_TOOLS: AI_TOOLS, AI_TOOL_DEFS: AI_TOOL_DEFS, aiUserToken: aiUserToken, aiGql: aiGql, aiPost: aiPost, aiExecTool: aiExecTool, aiDriveLoop: aiDriveLoop, aiProxySend: aiProxySend };'
  );
  return factory(
    opts.connectorEnabled || function () { return true; },
    opts.GM_getValue || function (k, d) { return (k === 'ingest_key') ? (opts.ingestKey !== undefined ? opts.ingestKey : 'test-key') : d; },
    opts.GM_xmlhttpRequest || function () {},
    opts.fetch || makeFetch({ data: {} }),
    atobStub,
    opts.localStorage || makeLocalStorage(makeUmbravaJwt()),
    docStub,
    setTimeout,     // real timers: only the frozen bwnAI block's withTimeout uses them
    clearTimeout,
    console
  );
}

// === Registry (TASK-007) =============================================================
describe('registry (TASK-007)', () => {
  test('getWorkOrder happy path shapes the WO (trades nulls dropped, nte flattened)', async () => {
    var T = loadTransport({ fetch: makeFetch({ data: { workOrder: {
      number: 375038, statusName: 'Pending Dispatch', locationId: 'loc-9', locationName: 'PFJ #123',
      scopeOfWork: 'HVAC unit down', serviceInstructions: 'Call on arrival',
      priority: { label: 'P2' }, trades: [{ id: 't1', name: 'HVAC' }, { id: 't2', name: null }], doNotExceed: { amount: 1500 }
    } } }) });
    var r = await T.AI_TOOLS.getWorkOrder({ workOrderNumber: 'W-375038' });
    expect(r.ok).toBe(true);
    expect(r.content.number).toBe(375038);
    expect(r.content.statusName).toBe('Pending Dispatch');
    expect(r.content.trades).toEqual(['HVAC']);
    expect(r.content.nte).toBe(1500);
  });

  test('getWorkOrder not-found -> ok:false', async () => {
    var T = loadTransport({ fetch: makeFetch({ data: { workOrder: null } }) });
    var r = await T.AI_TOOLS.getWorkOrder({ workOrderNumber: '999' });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/not found/);
  });

  test('getWorkOrder bad number -> ok:false', async () => {
    var T = loadTransport();  // default fetch returns {data:{}}
    var r = await T.AI_TOOLS.getWorkOrder({ workOrderNumber: 'not-a-number' });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/workOrderNumber/);
  });

  test('getWorkOrder gql error -> ok:false (no throw)', async () => {
    var T = loadTransport({ fetch: makeFetch({ errors: [{ message: 'boom' }] }) });
    var r = await T.AI_TOOLS.getWorkOrder({ workOrderNumber: '375038' });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/boom|read failed/);
  });

  test('getJobNotes: newest first, html stripped, author joined, pinned flag', async () => {
    var notes = [
      { id: 'a', type: 'note', content: 'older', createdDate: '2026-07-20T10:00:00Z', isPinned: false, isCompletion: false, workOrderNoteSource: 'app', createdBy: { firstName: 'Lisa', lastName: 'P' } },
      { id: 'b', type: 'note', content: '', contentHtml: '<p>newer html</p>', createdDate: '2026-07-22T10:00:00Z', isPinned: true, isCompletion: false, workOrderNoteSource: 'email', createdBy: { firstName: 'Erick', lastName: null } }
    ];
    var T = loadTransport({ fetch: makeFetch({ data: { jobNotes: notes } }) });
    var r = await T.AI_TOOLS.getJobNotes({ workOrderNumber: '375038' });
    expect(r.ok).toBe(true);
    expect(r.content.count).toBe(2);
    expect(r.content.notes[0].content).toBe('newer html');
    expect(r.content.notes[0].by).toBe('Erick');
    expect(r.content.notes[0].isPinned).toBe(true);
  });

  test('getLocationWorkOrders stub -> ok:false + not-wired notice', async () => {
    var T = loadTransport();
    var r = await T.AI_TOOLS.getLocationWorkOrders({ locationId: 'loc-9' });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/not yet wired/);
  });

  test('AI_TOOL_DEFS shape: 3 defs, names, every def maps to a registry fn with object schema', () => {
    var T = loadTransport();
    var defs = T.AI_TOOL_DEFS;
    expect(defs.length).toBe(3);
    var names = defs.map(function (d) { return d.name; }).sort();
    expect(names).toEqual(['getJobNotes', 'getLocationWorkOrders', 'getWorkOrder']);
    expect(defs.every(function (d) { return typeof T.AI_TOOLS[d.name] === 'function'; })).toBe(true);
    expect(defs.every(function (d) {
      return d.input_schema && d.input_schema.type === 'object' && Array.isArray(d.input_schema.required);
    })).toBe(true);
  });
});

// === Driver (TASK-008) ===============================================================
describe('driver (TASK-008)', () => {
  // A single tool round then final. Assert the follow-up POST body is correct.
  test('single tool round -> final; follow-up POST body is correct', async () => {
    var T = loadTransport({ fetch: makeFetch({ data: { workOrder: { number: 375038, statusName: 'Recall' } } }) });
    var serverMessages = [
      { role: 'user', content: 'status of 375038?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'getWorkOrder', input: { workOrderNumber: '375038' } }] }
    ];
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'tu_1', name: 'getWorkOrder', input: { workOrderNumber: '375038' } }], messages: serverMessages, rounds: 1 },
      { ok: true, status: 'final', text: 'WO 375038 is in Recall.', rounds: 1 }
    ];
    var TOOLS = T.AI_TOOL_DEFS;
    var initial = { task: 'ask', prompt: 'status of 375038?', tools: TOOLS, userToken: 'tok-A' };
    var posts = [];
    function post(body) { posts.push(body); return Promise.resolve(script[posts.length - 1]); }
    var text = await T.aiDriveLoop(initial, post);
    expect(text).toBe('WO 375038 is in Recall.');
    expect(posts.length).toBe(2);
    var f = posts[1];
    expect(f.messages).toBe(serverMessages);       // follow-up carries returned messages (same ref)
    expect(f.tools).toBe(TOOLS);                    // follow-up carries tools (same ref)
    expect(f.task).toBe('ask');
    expect(f.toolResults.length).toBe(1);
    expect(f.toolResults[0].tool_use_id).toBe('tu_1');
    var trContent = JSON.parse(f.toolResults[0].content);
    expect(trContent.ok).toBe(true);
    expect(trContent.content.statusName).toBe('Recall');
    expect(typeof f.userToken).toBe('string');      // fresh userToken (RISK-001)
    expect(f.userToken.length).toBeGreaterThan(0);
  });

  // Scripted 2-tool conversation reaches final (TEST-003 core).
  test('2-tool conversation reaches final', async () => {
    var T = loadTransport({ fetch: makeFetch({ data: { workOrder: { number: 1, statusName: 'Open' }, jobNotes: [{ id: 'n1', content: 'hi', createdDate: '2026-07-22T00:00:00Z', createdBy: { firstName: 'A', lastName: 'B' } }] } }) });
    var m1 = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'getWorkOrder', input: { workOrderNumber: '1' } }] }];
    var m2 = m1.concat([{ role: 'user', content: 'tr1' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'getJobNotes', input: { workOrderNumber: '1' } }] }]);
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 't1', name: 'getWorkOrder', input: { workOrderNumber: '1' } }], messages: m1 },
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 't2', name: 'getJobNotes', input: { workOrderNumber: '1' } }], messages: m2 },
      { ok: true, status: 'final', text: 'Done after two tools.' }
    ];
    var posts = [];
    function post(body) { posts.push(body); return Promise.resolve(script[posts.length - 1]); }
    var text = await T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post);
    expect(text).toBe('Done after two tools.');
    expect(posts.length).toBe(3);
    expect(posts[1].toolResults[0].tool_use_id).toBe('t1');
    expect(posts[2].toolResults[0].tool_use_id).toBe('t2');
  });

  // is_error propagation: a failing tool -> toolResults entry flagged is_error.
  test('failing tool -> toolResults is_error:true', async () => {
    var T = loadTransport();  // default fetch -> getWorkOrder returns not-found (ok:false)
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'e1', name: 'getLocationWorkOrders', input: { locationId: 'x' } }], messages: [{ role: 'user', content: 'q' }] },
      { ok: true, status: 'final', text: 'ok' }
    ];
    var posts = [];
    function post(body) { posts.push(body); return Promise.resolve(script[posts.length - 1]); }
    await T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post);
    expect(posts[1].toolResults[0].is_error).toBe(true);
  });

  // unknown tool name from the server -> is_error, never throws.
  test('unknown tool name -> is_error + still reaches final', async () => {
    var T = loadTransport();
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'u1', name: 'noSuchTool', input: {} }], messages: [{ role: 'user', content: 'q' }] },
      { ok: true, status: 'final', text: 'ok' }
    ];
    var posts = [];
    function post(body) { posts.push(body); return Promise.resolve(script[posts.length - 1]); }
    var text = await T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post);
    expect(posts[1].toolResults[0].is_error).toBe(true);
    expect(JSON.parse(posts[1].toolResults[0].content).content).toMatch(/unknown tool/);
    expect(text).toBe('ok');
  });

  // server miss (null) -> resolve '' (fall through).
  test('server miss (null) -> empty (fall through)', async () => {
    var T = loadTransport();
    var text = await T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, function () { return Promise.resolve(null); });
    expect(text).toBe('');
  });

  // client round cap: server never finalizes -> loop terminates, never hangs.
  test('client round cap terminates (never hangs)', async () => {
    var T = loadTransport();
    var posts = 0;
    function post() {
      posts++;
      return Promise.resolve({ ok: true, status: 'tool_calls', toolCalls: [{ id: 'c' + posts, name: 'getLocationWorkOrders', input: { locationId: 'x' } }], messages: [{ role: 'user', content: 'q' }] });
    }
    var text = await T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post);
    expect(text).toBe('');
    expect(posts).toBeLessThanOrEqual(7);
    expect(posts).toBeGreaterThanOrEqual(6);
  });

  // fresh-token re-read each round (RISK-001): rotate the bearer between rounds.
  test('follow-up userToken re-read after bearer rotation (RISK-001)', async () => {
    var ls = makeLocalStorage(makeUmbravaJwt());
    var T = loadTransport({ localStorage: ls });
    var tokRound2 = 'h.' + b64url({ iss: 'https://login.umbrava.com/', exp: Math.floor(Date.now() / 1000) + 7200, sub: 'u1', jti: 'rotated' }) + '.s';
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'r1', name: 'getLocationWorkOrders', input: { locationId: 'x' } }], messages: [{ role: 'user', content: 'q' }] },
      { ok: true, status: 'final', text: 'ok' }
    ];
    var posts = [];
    function post(body) {
      posts.push(body);
      if (posts.length === 1) ls.__setToken(tokRound2);  // rotate the bearer after the first POST
      return Promise.resolve(script[posts.length - 1]);
    }
    await T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'initial' }, post);
    expect(posts[1].userToken).toBe(tokRound2);
  });
});

// === Sender (TASK-009) end-to-end via the GM_xmlhttpRequest stub ======================
describe('sender (TASK-009)', () => {
  test('sender end-to-end reaches final; bodies carry task/prompt/tools/userToken/toolResults', async () => {
    var serverMessages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tu', name: 'getLocationWorkOrders', input: { locationId: 'l' } }] }];
    var gm = makeGM([
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'tu', name: 'getLocationWorkOrders', input: { locationId: 'l' } }], messages: serverMessages },
      { ok: true, status: 'final', text: 'Final answer from sender.' }
    ]);
    var T = loadTransport({ GM_xmlhttpRequest: gm.fn });
    var text = await T.aiProxySend({ task: 'ask', prompt: 'what WOs at loc l?', system: 'IGNORED' });
    expect(text).toBe('Final answer from sender.');
    expect(gm.sent[0].task).toBe('ask');
    expect(gm.sent[0].prompt).toBe('what WOs at loc l?');
    expect(Array.isArray(gm.sent[0].tools)).toBe(true);
    expect(gm.sent[0].tools.length).toBe(3);
    expect(typeof gm.sent[0].userToken).toBe('string');       // userToken in BODY (SEC-002)
    expect(gm.sent[0].userToken.length).toBeGreaterThan(0);
    expect(gm.sent[1].toolResults[0].tool_use_id).toBe('tu');
  });

  test('connector-off -> empty miss (never POSTs)', async () => {
    var T = loadTransport({ connectorEnabled: function () { return false; }, GM_xmlhttpRequest: function () { throw new Error('should not POST'); } });
    var text = await T.aiProxySend({ task: 'ask', prompt: 'q' });
    expect(text).toBe('');
  });

  test('no ingest key -> empty miss (never POSTs)', async () => {
    var T = loadTransport({ ingestKey: '', GM_xmlhttpRequest: function () { throw new Error('should not POST'); } });
    var text = await T.aiProxySend({ task: 'ask', prompt: 'q' });
    expect(text).toBe('');
  });

  test('no bearer -> empty miss (never POSTs)', async () => {
    var T = loadTransport({ localStorage: makeLocalStorage(null), GM_xmlhttpRequest: function () { throw new Error('should not POST'); } });
    var text = await T.aiProxySend({ task: 'ask', prompt: 'q' });
    expect(text).toBe('');
  });

  test('403 ROLE_REQUIRED -> empty miss (fall through)', async () => {
    var gm = makeGM([{ status: 403, json: { ok: false, error: 'ROLE_REQUIRED', code: 'ROLE_REQUIRED' } }]);
    var T = loadTransport({ GM_xmlhttpRequest: gm.fn });
    var text = await T.aiProxySend({ task: 'draft', prompt: 'q' });
    expect(text).toBe('');
  });
});

// === setProxy wiring (TASK-009/010): route through the FROZEN bwnAI block end-to-end ===
describe('setProxy wiring (TASK-009/010)', () => {
  // A rank>=minRank draft call must take the proxy tier -> _proxySend (== our aiProxySend)
  // -> GM stub -> final. Proves bwnAI.setProxy connected the router to the injected sender.
  test('bwnAI proxy tier routes a draft through the injected sender', async () => {
    var roleSlot = JSON.stringify({ ok: true, rank: 4, ts: Date.now() });
    var ls = makeLocalStorage(makeUmbravaJwt(), { 'bwn:role:last': roleSlot });
    var gm = makeGM([{ ok: true, status: 'final', text: 'Draft via router proxy tier.' }]);
    var T = loadTransport({ localStorage: ls, GM_xmlhttpRequest: gm.fn });
    var text = await T.bwnAI({ task: 'draft', prompt: 'draft a vendor note', minRank: 1, timeoutMs: 60000 });
    expect(text).toBe('Draft via router proxy tier.');
    expect(gm.sent.length).toBe(1);
    expect(gm.sent[0].task).toBe('draft');
  });

  // Fail-closed: rank unknown -> proxy tier is skipped, sender is never called (no POST).
  test('rank unknown -> proxy skipped, no POST (fail-closed)', async () => {
    var gm = makeGM([{ ok: true, status: 'final', text: 'should not be reached' }]);
    var T = loadTransport({ localStorage: makeLocalStorage(makeUmbravaJwt()), GM_xmlhttpRequest: gm.fn });
    var text = await T.bwnAI({ task: 'draft', prompt: 'x', timeoutMs: 5000 });
    expect(gm.sent.length).toBe(0);
    expect(text).toBe('');
  });
});
