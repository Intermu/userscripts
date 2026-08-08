// test-ask-tools.js - BWN Ask reaches the page tools, and reports failure instead of eating it.
//
// Ask used to POST /api/ask, a route that runs ONE plain Messages call with no tools by design.
// So "what buttons are on this page" was unanswerable from the UI coordinators actually open,
// even though the page tools had shipped in bwn-suite-ai. This drives the wiring that fixed it.
//
// REAL SHIPPED BYTES on the client side: the BWN-ASK-DOMP block and the tool loop are sliced out
// of bwn-ask.user.js, not re-typed here. A harness that re-implements the thing it is judging
// agrees with itself by construction ([[green-harness-proves-nothing-alone]]).
//
// WHAT THIS DOES NOT COVER: the real Core responder and the real collector. scripts/test-domp-bus.js
// already drives those against suite-ai's client, and this file's first assertion is that Ask's
// copy of the tool DEFINITIONS is byte-identical to suite-ai's - so the two clients cannot teach
// one model two different things about the same three verbs.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ask-tools.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var ASK = fs.readFileSync(path.join(__dirname, '..', 'bwn-ask.user.js'), 'utf8').replace(/\r\n/g, '\n');
var AI = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-ai.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error('slice start not found (' + what + '): ' + start);
  var b = text.indexOf(end, a + start.length);
  if (b === -1) throw new Error('slice end not found (' + what + '): ' + end);
  return text.slice(a, b);
}

/* ============================ 1. the two copies agree ============================ */

console.log('tool definition parity (Ask vs suite-ai)');

// Normalising whitespace would let a re-indent through, and a re-indent is how a paste starts
// drifting. Compare the bytes.
var askDefs = slice(ASK, "    { name: 'page_snapshot',", "\n  ];", 'ask page tool defs');
var aiDefs = slice(AI, "    { name: 'page_snapshot',", "\n  ];", 'ai page tool defs');
A.ok('the three page tool defs are byte-identical to bwn-suite-ai', askDefs === aiDefs,
  askDefs === aiDefs ? '' : ('first difference at char ' + (function () {
    for (var i = 0; i < Math.max(askDefs.length, aiDefs.length); i++) if (askDefs[i] !== aiDefs[i]) return i;
    return -1;
  })()));

A.ok('Ask advertises ONLY tools it can execute (no getWorkOrder etc.)',
  askDefs.indexOf('getWorkOrder') === -1 && askDefs.indexOf('getJobNotes') === -1,
  'Ask has no GraphQL executors; advertising one returns "unknown tool" every time');

/* ============================ 2. the harness world ============================ */

var DOMP_BLOCK = slice(ASK, '  var DOMP_TIMEOUT_MS =', '  /* ===== BWN-ASK-DOMP:END', 'ask domp block');
var LOOP_BLOCK = slice(ASK, '  var ASK_MIN_TOOL_ROUNDS =', '\n  function askServer(', 'ask tool loop');

// A document that delivers CustomEvents synchronously, like the real one does for a page-context
// listener, plus controllable timers so the timeout path can be reached without waiting.
function makeWorld(o) {
  o = o || {};
  var listeners = {};
  var timers = [];
  var store = o.coreStamp === null ? {} : { 'bwn:status:core': JSON.stringify(o.coreStamp || { ver: '1.67.1', ts: 1 }) };
  var sandbox = {
    console: console,
    JSON: JSON,
    Promise: Promise,
    Date: Date,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }
    },
    setTimeout: function (fn, ms) { var t = { fn: fn, ms: ms }; timers.push(t); return t; },
    clearTimeout: function (t) { var i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    document: {
      addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener: function (t, fn) {
        var arr = listeners[t] || []; var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
      },
      dispatchEvent: function (ev) {
        if (o.onCmd && ev.type === 'bwn:cmd') o.onCmd(ev.detail, function (result) {
          (listeners['bwn:evt'] || []).slice().forEach(function (fn) { fn({ type: 'bwn:evt', detail: result }); });
        });
        return true;
      }
    },
    authToken: function () { return o.token || 'tok-fresh'; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('(function(){\n' + DOMP_BLOCK + '\n' + LOOP_BLOCK +
    '\nthis.ASK_TOOLS = ASK_TOOLS; this.ASK_TOOL_DEFS = ASK_TOOL_DEFS;' +
    '\nthis.askDriveLoop = askDriveLoop; this.askExecTool = askExecTool;' +
    '\n}).call(this)', sandbox, { filename: 'bwn-ask.slice.js' });
  return {
    sandbox: sandbox,
    fireTimers: function () { var due = timers.slice(); timers.length = 0; due.forEach(function (t) { t.fn(); }); },
    pendingTimers: function () { return timers.length; }
  };
}

/* ============================ 3. the bus client ============================ */

console.log('\nbus client');

(function () {
  var seenRids = [];
  var w = makeWorld({
    onCmd: function (detail, reply) {
      seenRids.push(detail.rid);
      reply({ id: 'domp:result', rid: detail.rid, result: { ok: true, snapshot: { elements: [{ h: '@b1' }], page: { revision: 'e1.r1' } } } });
    }
  });
  return w.sandbox.ASK_TOOLS.page_snapshot({}).then(function (res) {
    A.ok('page_snapshot returns the responder payload', res.ok === true && !!res.snapshot, JSON.stringify(res).slice(0, 120));
    A.ok('the request carried an addressable rid', seenRids.length === 1 && !!seenRids[0], String(seenRids[0]));
  });
})()

/* ---- a reply addressed to someone else must not settle our call ---- */
.then(function () {
  var w = makeWorld({
    onCmd: function (detail, reply) {
      reply({ id: 'domp:result', rid: 'SOMEONE-ELSE', result: { ok: false, poison: true } });
      reply({ id: 'domp:result', rid: detail.rid, result: { ok: true, snapshot: { elements: [], page: { revision: 'e1.r1' } } } });
    }
  });
  return w.sandbox.ASK_TOOLS.page_snapshot({}).then(function (res) {
    A.ok('a foreign rid is ignored', res.ok === true && !res.poison, JSON.stringify(res).slice(0, 120));
  });
})

/* ---- Core absent is named, not timed out ---- */
.then(function () {
  var w = makeWorld({ coreStamp: null, onCmd: function () { throw new Error('must not dispatch'); } });
  return w.sandbox.ASK_TOOLS.page_snapshot({}).then(function (res) {
    A.ok('an absent Core is reported BY NAME', res.ok === false && res.code === 'CORE_ABSENT', JSON.stringify(res));
    A.ok('naming it costs no timer', w.pendingTimers() === 0, String(w.pendingTimers()));
  });
})

/* ---- silence becomes a bounded, named timeout ---- */
.then(function () {
  var w = makeWorld({ onCmd: function () { /* never replies */ } });
  var p = w.sandbox.ASK_TOOLS.page_snapshot({});
  w.fireTimers();
  return p.then(function (res) {
    A.ok('silence times out rather than hanging', res.ok === false && res.code === 'TIMEOUT', JSON.stringify(res));
  });
})

/* ---- handle-less calls are refused before they reach the bus ---- */
.then(function () {
  var dispatched = 0;
  var w = makeWorld({ onCmd: function (d, reply) { dispatched++; reply({ id: 'domp:result', rid: d.rid, result: { ok: true } }); } });
  return Promise.all([
    w.sandbox.ASK_TOOLS.page_inspect({}),
    w.sandbox.ASK_TOOLS.page_extract({})
  ]).then(function (r) {
    A.ok('page_inspect without a handle is refused locally', r[0].ok === false && /needs a handle/.test(r[0].content), JSON.stringify(r[0]));
    A.ok('page_extract without a handle is refused locally', r[1].ok === false && /needs a handle/.test(r[1].content), JSON.stringify(r[1]));
    A.ok('neither reached the bus', dispatched === 0, String(dispatched));
  });
})

/* ============================ 4. the tool loop ============================ */

.then(function () {
  console.log('\ntool loop');
  var w = makeWorld({});
  var posts = [];
  var post = function (body) {
    posts.push(body);
    if (posts.length === 1) {
      return Promise.resolve({ status: 200, json: {
        ok: true, status: 'tool_calls', maxRounds: 12,
        toolCalls: [{ id: 'tu_1', name: 'page_snapshot', input: {} }],
        messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'calling' }]
      } });
    }
    return Promise.resolve({ status: 200, json: { ok: true, status: 'final', text: 'there are 3 buttons' } });
  };
  // The tool has to actually run, so give the world a responder.
  var w2 = makeWorld({ onCmd: function (d, reply) { reply({ id: 'domp:result', rid: d.rid, result: { ok: true, snapshot: { elements: [], page: { revision: 'e1.r1' } } } }); } });
  return w2.sandbox.askDriveLoop({ task: 'ask', prompt: 'q', tools: w2.sandbox.ASK_TOOL_DEFS, userToken: 'tok-initial', model: 'm' }, post)
    .then(function (r) {
      A.ok('a tool round is executed and the loop reaches a final answer',
        r.status === 200 && r.json.ok === true && r.json.answer === 'there are 3 buttons', JSON.stringify(r).slice(0, 160));
      A.ok('two POSTs were made', posts.length === 2, String(posts.length));
      A.ok('the second POST returns the server messages', Array.isArray(posts[1].messages) && posts[1].messages.length === 2);
      A.ok('the second POST carries toolResults', Array.isArray(posts[1].toolResults) && posts[1].toolResults[0].tool_use_id === 'tu_1',
        JSON.stringify(posts[1].toolResults || null).slice(0, 140));
      A.ok('the second POST re-sends the tools', posts[1].tools === w2.sandbox.ASK_TOOL_DEFS);
      // RISK-001: a long tool session can outlive the token the first round used.
      A.ok('the second POST carries a FRESH token, not the initial one',
        posts[1].userToken === 'tok-fresh' && posts[0].userToken === 'tok-initial',
        posts[1].userToken + ' / ' + posts[0].userToken);
      A.ok('the model choice survives the round trip', posts[1].model === 'm');
    });
})

/* ---- the difference from suite-ai: failures are SURFACED ---- */
.then(function () {
  var w = makeWorld({});
  var r403 = { status: 403, json: { ok: false, code: 'ROLE_REQUIRED', tier: 'coordinator' } };
  return w.sandbox.askDriveLoop({ task: 'ask', prompt: 'q', tools: [], userToken: 't' }, function () { return Promise.resolve(r403); })
    .then(function (r) {
      // suite-ai's aiDriveLoop resolves '' here so bwnAI can fall through to another tier. Ask has
      // no other tier: swallowing this renders "(no answer returned)" and hides a fixable cause.
      A.ok('a 403 is handed back intact, not swallowed', r === r403 || (r.status === 403 && r.json.code === 'ROLE_REQUIRED'), JSON.stringify(r));
    });
})

.then(function () {
  var w = makeWorld({});
  return w.sandbox.askDriveLoop({ task: 'ask', prompt: 'q', tools: [], userToken: 't' }, function () { return Promise.resolve({ status: 429, json: { ok: false } }); })
    .then(function (r) { A.ok('a 429 is handed back intact', r.status === 429, JSON.stringify(r)); });
})

/* ---- an assistant that never stops calling tools is capped ---- */
.then(function () {
  var w = makeWorld({ onCmd: function (d, reply) { reply({ id: 'domp:result', rid: d.rid, result: { ok: true } }); } });
  var posts = 0;
  var post = function () {
    posts++;
    return Promise.resolve({ status: 200, json: {
      ok: true, status: 'tool_calls', maxRounds: 6,
      toolCalls: [{ id: 'tu_x', name: 'page_snapshot', input: {} }],
      messages: [{ role: 'user', content: 'q' }]
    } });
  };
  return w.sandbox.askDriveLoop({ task: 'ask', prompt: 'q', tools: [], userToken: 't' }, post).then(function (r) {
    A.ok('a never-finishing tool loop is capped, with a readable reason',
      r.json.ok === false && /round cap/.test(r.json.error), JSON.stringify(r).slice(0, 140));
    A.ok('the cap bounded the POSTs', posts <= 8, String(posts));
  });
})

/* ---- an unknown tool is an is_error result, not a throw ---- */
.then(function () {
  var w = makeWorld({});
  return w.sandbox.askExecTool({ id: 'tu_9', name: 'delete_everything', input: {} }).then(function (tr) {
    A.ok('an unknown tool becomes an is_error tool result', tr.is_error === true && tr.tool_use_id === 'tu_9', JSON.stringify(tr));
    A.ok('and it never reaches a verb', /unknown tool/.test(tr.content), tr.content);
  });
})

/* ============================ 5. controls ============================ */

.then(function () {
  console.log('\ncontrols (the harness bites)');
  // If the slices stopped matching the file, every assertion above would be testing nothing.
  A.ok('the DOMP block slice is non-trivial', DOMP_BLOCK.length > 1500, String(DOMP_BLOCK.length));
  A.ok('the loop slice is non-trivial', LOOP_BLOCK.length > 800, String(LOOP_BLOCK.length));
  A.ok('the loop slice really contains the re-post', /toolResults: toolResults/.test(LOOP_BLOCK));

  // A drift control: prove the parity assertion can FAIL. If mutating one copy still compares
  // equal, the comparison is not looking at what it claims to.
  var mutated = askDefs.replace('READ-ONLY', 'READ-WRITE');
  A.ok('control: a one-word drift in the defs is caught', mutated !== aiDefs && mutated !== askDefs);

  // Ask must not have kept a second, toolless path to the old route for live traffic.
  A.ok('askServer posts to /api/ai, not /api/ask', /askDriveLoop\(body, post\)/.test(ASK) && /var post = function \(b\) \{ return gmPost\(AI_URL/.test(ASK));

  /* ---- the status stamp ---- */
  var stamp = slice(ASK, "    localStorage.setItem('bwn:status:ask'", '\n  } catch (e) {', 'status stamp');
  A.ok('a bwn:status:ask stamp is written', stamp.length > 40);
  A.ok('the stamp carries the version', /ver:/.test(stamp) && /GM_info\.script\.version/.test(stamp));
  // The two facts that were unanswerable on 2026-08-08. A stamp with only a version would have
  // told me the build number and still not whether the tools were wired.
  A.ok('the stamp names the ROUTE this build posts to', /route: 'ai'/.test(stamp));
  A.ok('the stamp reports whether the page tools are wired', /pageTools: ASK_TOOL_DEFS\.length/.test(stamp));

  // The ingest key is a shared secret; localStorage is readable by any page script. This is the
  // same rule the vault enforces on settings.json - a boolean, never the value.
  A.ok('the stamp records the key as a BOOLEAN, never the key itself',
    /ingest: !!GM_getValue\('ingest_key', ''\)/.test(stamp) && !/ingest: GM_getValue/.test(stamp), stamp.slice(0, 200));

  // A storage refusal (private mode, quota) must not take the panel down with it.
  A.ok('the stamp write is wrapped so a storage refusal cannot stop the panel loading',
    /try \{\s*\n\s*localStorage\.setItem\('bwn:status:ask'/.test(ASK));

  A.finish();
})

.catch(function (e) {
  console.error('\nHARNESS THREW - this is a failure to CHECK, not a pass:\n', e && e.stack || e);
  process.exit(1);
});
