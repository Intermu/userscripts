// test-bwn-ai-client.js - node harness for the Phase 2 client AI transport (TEST-003).
//
// Verifies the CLIENT half of the unified AI transport built into bwn-suite-ai.user.js:
// the tool registry (TASK-007), the tool-loop driver (TASK-008), and the injected proxy
// sender (TASK-009). It loads the REAL shipped code - it slices the "BWN AI TRANSPORT"
// section out of the .user.js by its markers and evaluates it in a stubbed sandbox
// (fetch / GM_xmlhttpRequest / GM_getValue / connectorEnabled / localStorage / atob /
// document injected as params). The code under test is NOT rewritten; only stubs and a
// trailing `return {...}` (test scaffolding) are added around the extracted bytes.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bwn-ai-client.js
//
// Covers: registry happy/edge/error paths, tool DEFS shape, the follow-up POST body
// (messages + toolResults with matching tool_use_id + tools + userToken), a scripted
// 2-tool conversation reaching status:'final', is_error propagation, unknown tool, a
// server miss (null), the client round cap terminating (never hangs), fresh-token re-read
// per round (RISK-001), and the sender's connector/key/bearer guards.

var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, '..', 'bwn-suite-ai.user.js');

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

// ---- tiny assert harness --------------------------------------------------------------
var pass = 0, fail = 0, cases = 0;
function ok(name, cond, detail) {
  cases++;
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? ('  [' + detail + ']') : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

// ---- run ------------------------------------------------------------------------------
function run() {
  var chain = Promise.resolve();

  // === Registry (TASK-007) =============================================================
  chain = chain.then(function () {
    var T = loadTransport({ fetch: makeFetch({ data: { workOrder: {
      number: 375038, statusName: 'Pending Dispatch', locationId: 'loc-9', locationName: 'PFJ #123',
      scopeOfWork: 'HVAC unit down', serviceInstructions: 'Call on arrival',
      priority: { label: 'P2' }, trades: [{ id: 't1', name: 'HVAC' }, { id: 't2', name: null }], doNotExceed: { amount: 1500 }
    } } }) });
    return T.AI_TOOLS.getWorkOrder({ workOrderNumber: 'W-375038' }).then(function (r) {
      ok('getWorkOrder ok flag', r.ok === true);
      eq('getWorkOrder number', r.content.number, 375038);
      eq('getWorkOrder statusName', r.content.statusName, 'Pending Dispatch');
      eq('getWorkOrder trades (nulls dropped)', r.content.trades, ['HVAC']);
      eq('getWorkOrder nte', r.content.nte, 1500);
    });
  });

  chain = chain.then(function () {
    var T = loadTransport({ fetch: makeFetch({ data: { workOrder: null } }) });
    return T.AI_TOOLS.getWorkOrder({ workOrderNumber: '999' }).then(function (r) {
      ok('getWorkOrder not-found -> ok:false', r.ok === false && /not found/.test(r.content));
    });
  });

  chain = chain.then(function () {
    var T = loadTransport();  // default fetch returns {data:{}}
    return T.AI_TOOLS.getWorkOrder({ workOrderNumber: 'not-a-number' }).then(function (r) {
      ok('getWorkOrder bad number -> ok:false', r.ok === false && /workOrderNumber/.test(r.content));
    });
  });

  chain = chain.then(function () {
    var T = loadTransport({ fetch: makeFetch({ errors: [{ message: 'boom' }] }) });
    return T.AI_TOOLS.getWorkOrder({ workOrderNumber: '375038' }).then(function (r) {
      ok('getWorkOrder gql error -> ok:false (no throw)', r.ok === false && /boom|read failed/.test(r.content));
    });
  });

  chain = chain.then(function () {
    var notes = [
      { id: 'a', type: 'note', content: 'older', createdDate: '2026-07-20T10:00:00Z', isPinned: false, isCompletion: false, workOrderNoteSource: 'app', createdBy: { firstName: 'Lisa', lastName: 'P' } },
      { id: 'b', type: 'note', content: '', contentHtml: '<p>newer html</p>', createdDate: '2026-07-22T10:00:00Z', isPinned: true, isCompletion: false, workOrderNoteSource: 'email', createdBy: { firstName: 'Erick', lastName: null } }
    ];
    var T = loadTransport({ fetch: makeFetch({ data: { jobNotes: notes } }) });
    return T.AI_TOOLS.getJobNotes({ workOrderNumber: '375038' }).then(function (r) {
      ok('getJobNotes ok', r.ok === true && r.content.count === 2);
      eq('getJobNotes newest first', r.content.notes[0].content, 'newer html');
      eq('getJobNotes html stripped', r.content.notes[0].content, 'newer html');
      eq('getJobNotes author joined', r.content.notes[0].by, 'Erick');
      ok('getJobNotes pinned flag', r.content.notes[0].isPinned === true);
    });
  });

  chain = chain.then(function () {
    var T = loadTransport();
    return T.AI_TOOLS.getLocationWorkOrders({ locationId: 'loc-9' }).then(function (r) {
      ok('getLocationWorkOrders stub -> ok:false + not-wired notice', r.ok === false && /not yet wired/.test(r.content));
    });
  });

  chain = chain.then(function () {
    var T = loadTransport();
    var defs = T.AI_TOOL_DEFS;
    ok('AI_TOOL_DEFS count = 3', defs.length === 3);
    var names = defs.map(function (d) { return d.name; }).sort();
    eq('AI_TOOL_DEFS names', names, ['getJobNotes', 'getLocationWorkOrders', 'getWorkOrder']);
    ok('every def matches a registry key', defs.every(function (d) { return typeof T.AI_TOOLS[d.name] === 'function'; }));
    ok('every def has object input_schema + required[]', defs.every(function (d) {
      return d.input_schema && d.input_schema.type === 'object' && Array.isArray(d.input_schema.required);
    }));
  });

  // === Driver (TASK-008) ===============================================================
  // A single tool round then final. Assert the follow-up POST body is correct.
  chain = chain.then(function () {
    var T = loadTransport({ fetch: makeFetch({ data: { workOrder: { number: 375038, statusName: 'Recall' } } }) });
    var serverMessages = [
      { role: 'user', content: 'status of 375038?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'getWorkOrder', input: { workOrderNumber: '375038' } }] }
    ];
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'tu_1', name: 'getWorkOrder', input: { workOrderNumber: '375038' } }], messages: serverMessages, rounds: 1 },
      { ok: true, status: 'final', text: 'WO 375038 is in Recall.', rounds: 1 }
    ];
    var gm = makeGM(script);
    var TOOLS = T.AI_TOOL_DEFS;
    var initial = { task: 'ask', prompt: 'status of 375038?', tools: TOOLS, userToken: 'tok-A' };
    var posts = [];
    function post(body) { posts.push(body); return Promise.resolve(script[posts.length - 1]); }
    return T.aiDriveLoop(initial, post).then(function (text) {
      eq('driver reaches final text', text, 'WO 375038 is in Recall.');
      ok('driver made 2 posts', posts.length === 2);
      var f = posts[1];
      ok('follow-up carries returned messages', f.messages === serverMessages);
      ok('follow-up carries tools (same ref)', f.tools === TOOLS);
      ok('follow-up has task', f.task === 'ask');
      ok('follow-up toolResults tool_use_id matches call', f.toolResults.length === 1 && f.toolResults[0].tool_use_id === 'tu_1');
      var trContent = JSON.parse(f.toolResults[0].content);
      ok('follow-up toolResult content is the tool output', trContent.ok === true && trContent.content.statusName === 'Recall');
      ok('follow-up carries a fresh userToken (RISK-001)', typeof f.userToken === 'string' && f.userToken.length > 0);
    });
  });

  // Scripted 2-tool conversation reaches final (TEST-003 core).
  chain = chain.then(function () {
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
    return T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post).then(function (text) {
      eq('2-tool conversation reaches final', text, 'Done after two tools.');
      ok('2-tool conversation made 3 posts', posts.length === 3);
      ok('round1 toolResult id t1', posts[1].toolResults[0].tool_use_id === 't1');
      ok('round2 toolResult id t2', posts[2].toolResults[0].tool_use_id === 't2');
    });
  });

  // is_error propagation: a failing tool -> toolResults entry flagged is_error.
  chain = chain.then(function () {
    var T = loadTransport();  // default fetch -> getWorkOrder returns not-found (ok:false)
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'e1', name: 'getLocationWorkOrders', input: { locationId: 'x' } }], messages: [{ role: 'user', content: 'q' }] },
      { ok: true, status: 'final', text: 'ok' }
    ];
    var posts = [];
    function post(body) { posts.push(body); return Promise.resolve(script[posts.length - 1]); }
    return T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post).then(function () {
      ok('failing tool -> is_error:true', posts[1].toolResults[0].is_error === true);
    });
  });

  // unknown tool name from the server -> is_error, never throws.
  chain = chain.then(function () {
    var T = loadTransport();
    var script = [
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'u1', name: 'noSuchTool', input: {} }], messages: [{ role: 'user', content: 'q' }] },
      { ok: true, status: 'final', text: 'ok' }
    ];
    var posts = [];
    function post(body) { posts.push(body); return Promise.resolve(script[posts.length - 1]); }
    return T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post).then(function (text) {
      ok('unknown tool -> is_error + content', posts[1].toolResults[0].is_error === true && /unknown tool/.test(JSON.parse(posts[1].toolResults[0].content).content));
      eq('unknown tool still reaches final', text, 'ok');
    });
  });

  // server miss (null) -> resolve '' (fall through).
  chain = chain.then(function () {
    var T = loadTransport();
    return T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, function () { return Promise.resolve(null); }).then(function (text) {
      eq('server miss -> empty (fall through)', text, '');
    });
  });

  // client round cap: server never finalizes -> loop terminates, never hangs.
  chain = chain.then(function () {
    var T = loadTransport();
    var posts = 0;
    function post() {
      posts++;
      return Promise.resolve({ ok: true, status: 'tool_calls', toolCalls: [{ id: 'c' + posts, name: 'getLocationWorkOrders', input: { locationId: 'x' } }], messages: [{ role: 'user', content: 'q' }] });
    }
    return T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'x' }, post).then(function (text) {
      eq('round cap -> empty', text, '');
      ok('round cap bounded posts (<= 7)', posts <= 7 && posts >= 6, 'posts=' + posts);
    });
  });

  // fresh-token re-read each round (RISK-001): rotate the bearer between rounds.
  chain = chain.then(function () {
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
    return T.aiDriveLoop({ task: 'ask', prompt: 'q', tools: T.AI_TOOL_DEFS, userToken: 'initial' }, post).then(function () {
      ok('follow-up userToken re-read after rotation', posts[1].userToken === tokRound2, 'got ' + posts[1].userToken);
    });
  });

  // === Sender (TASK-009) end-to-end via the GM_xmlhttpRequest stub ======================
  chain = chain.then(function () {
    var serverMessages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tu', name: 'getLocationWorkOrders', input: { locationId: 'l' } }] }];
    var gm = makeGM([
      { ok: true, status: 'tool_calls', toolCalls: [{ id: 'tu', name: 'getLocationWorkOrders', input: { locationId: 'l' } }], messages: serverMessages },
      { ok: true, status: 'final', text: 'Final answer from sender.' }
    ]);
    var T = loadTransport({ GM_xmlhttpRequest: gm.fn });
    return T.aiProxySend({ task: 'ask', prompt: 'what WOs at loc l?', system: 'IGNORED' }).then(function (text) {
      eq('sender end-to-end reaches final', text, 'Final answer from sender.');
      ok('sender initial body task', gm.sent[0].task === 'ask');
      ok('sender initial body prompt', gm.sent[0].prompt === 'what WOs at loc l?');
      ok('sender initial body carries tools', Array.isArray(gm.sent[0].tools) && gm.sent[0].tools.length === 3);
      ok('sender initial body carries userToken in BODY (SEC-002)', typeof gm.sent[0].userToken === 'string' && gm.sent[0].userToken.length > 0);
      ok('sender follow-up carries toolResults', Array.isArray(gm.sent[1].toolResults) && gm.sent[1].toolResults[0].tool_use_id === 'tu');
    });
  });

  chain = chain.then(function () {
    var T = loadTransport({ connectorEnabled: function () { return false; }, GM_xmlhttpRequest: function () { throw new Error('should not POST'); } });
    return T.aiProxySend({ task: 'ask', prompt: 'q' }).then(function (text) {
      eq('sender connector-off -> empty miss', text, '');
    });
  });

  chain = chain.then(function () {
    var T = loadTransport({ ingestKey: '', GM_xmlhttpRequest: function () { throw new Error('should not POST'); } });
    return T.aiProxySend({ task: 'ask', prompt: 'q' }).then(function (text) {
      eq('sender no-ingest-key -> empty miss', text, '');
    });
  });

  chain = chain.then(function () {
    var T = loadTransport({ localStorage: makeLocalStorage(null), GM_xmlhttpRequest: function () { throw new Error('should not POST'); } });
    return T.aiProxySend({ task: 'ask', prompt: 'q' }).then(function (text) {
      eq('sender no-bearer -> empty miss', text, '');
    });
  });

  chain = chain.then(function () {
    var gm = makeGM([{ status: 403, json: { ok: false, error: 'ROLE_REQUIRED', code: 'ROLE_REQUIRED' } }]);
    var T = loadTransport({ GM_xmlhttpRequest: gm.fn });
    return T.aiProxySend({ task: 'draft', prompt: 'q' }).then(function (text) {
      eq('sender 403 ROLE_REQUIRED -> empty miss (fall through)', text, '');
    });
  });

  // === setProxy wiring (TASK-009/010): route through the FROZEN bwnAI block end-to-end ===
  // A rank>=minRank draft call must take the proxy tier -> _proxySend (== our aiProxySend)
  // -> GM stub -> final. Proves bwnAI.setProxy connected the router to the injected sender.
  chain = chain.then(function () {
    var roleSlot = JSON.stringify({ ok: true, rank: 4, ts: Date.now() });
    var ls = makeLocalStorage(makeUmbravaJwt(), { 'bwn:role:last': roleSlot });
    var gm = makeGM([{ ok: true, status: 'final', text: 'Draft via router proxy tier.' }]);
    var T = loadTransport({ localStorage: ls, GM_xmlhttpRequest: gm.fn });
    return T.bwnAI({ task: 'draft', prompt: 'draft a vendor note', minRank: 1, timeoutMs: 60000 }).then(function (text) {
      eq('bwnAI proxy tier routes through the injected sender', text, 'Draft via router proxy tier.');
      ok('router POSTed the draft task', gm.sent.length === 1 && gm.sent[0].task === 'draft');
    });
  });

  // Fail-closed: rank unknown -> proxy tier is skipped, sender is never called (no POST).
  chain = chain.then(function () {
    var gm = makeGM([{ ok: true, status: 'final', text: 'should not be reached' }]);
    var T = loadTransport({ localStorage: makeLocalStorage(makeUmbravaJwt()), GM_xmlhttpRequest: gm.fn });
    return T.bwnAI({ task: 'draft', prompt: 'x', timeoutMs: 5000 }).then(function (text) {
      ok('rank unknown -> proxy skipped, no POST (fail-closed)', gm.sent.length === 0);
      eq('rank unknown draft -> empty (no on-device in node)', text, '');
    });
  });

  return chain;
}

console.log('BWN AI client transport harness (TEST-003)\n');
run().then(function () {
  console.log('\n' + pass + '/' + cases + ' assertions passed' + (fail ? (', ' + fail + ' FAILED') : ''));
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.error('\nHARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
