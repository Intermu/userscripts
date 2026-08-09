// test-operate-surface.js - the Operate panel: the surface an agent drives the page from.
//
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-operate-surface.js
//
// WHY IT EXISTS. The DOM handle protocol once had page tools registered on a code path no
// coordinator-facing UI ever invoked - green harnesses on both halves, a seam between them that
// nobody tested, and the tools were dead for a day before a live gate found it. This module IS
// that seam. So it is tested against the SHIPPED BYTES: the block is sliced out of
// bwn-suite-ai.user.js and run in a vm, not reimplemented in a fixture that would agree with
// whatever it was written beside.
//
// WHAT THIS PROVES: the panel is unprojectable, the capability line is derived rather than
// written, the loop posts `operate` and never `ask`, it adopts the SERVER's round cap, it keeps a
// failure's status and body instead of swallowing them, Stop halts before the next round, and
// every tool call reaches the log.
//
// WHAT IT DOES NOT: that any of it renders. The DOM below is a stub - it models identity, events
// and attributes, not layout. Whether a human can actually see and read this panel is a live gate,
// and until one is run the honest status is "built, browser-unverified".

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-suite-ai.user.js');
function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.lastIndexOf(end);
  if (b === -1 || b < a) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var full = readLF(SRC);
var MODULE = slice(full, '  // MODULE: Operate 1.0', '\n})();', 'operate module');

/* ================================ the stub world ================================ */

function El(tag) {
  var self = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, _attrs: {}, _listeners: {},
    style: { cssText: '' }, value: '', disabled: false, rows: 0, placeholder: '', className: '',
    textContent: '', innerHTML: ''
  };
  self.setAttribute = function (n, v) { self._attrs[n] = String(v); };
  self.getAttribute = function (n) { return (n in self._attrs) ? self._attrs[n] : null; };
  self.appendChild = function (c) { c.parentNode = self; self.children.push(c); return c; };
  self.addEventListener = function (t, fn) { (self._listeners[t] = self._listeners[t] || []).push(fn); };
  self.fire = function (t) { (self._listeners[t] || []).forEach(function (fn) { fn({ type: t }); }); };
  return self;
}

function makeWorld(opts) {
  opts = opts || {};
  var docListeners = {};
  var body = El('body');
  var doc = {
    body: body,
    createElement: El,
    addEventListener: function (t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    dispatchEvent: function (ev) {
      (docListeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); });
      world.dispatched.push(ev.detail);
      return true;
    }
  };
  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }

  var world = {
    doc: doc, body: body, dispatched: [], posts: [],
    replies: opts.replies || [],
    open: function () {
      doc.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:dock:open', key: 'operate' } }));
    },
    // Depth-first find, so a test can reach a control the module built without the module
    // exposing anything for testing - the panel under test is the shipped one.
    find: function (pred) {
      var hit = null;
      (function walk(n) { if (hit) return; if (pred(n)) { hit = n; return; } n.children.forEach(walk); })(body);
      return hit;
    },
    logLines: function () {
      var out = [];
      (function walk(n) { if (n.className && String(n.className).indexOf('op-') === 0) out.push(n.textContent); n.children.forEach(walk); })(body);
      return out;
    }
  };

  var sandbox = {
    console: { log: function () { }, warn: function () { }, error: function () { } },
    document: doc, CustomEvent: CustomEvent,
    Promise: Promise, JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    parseInt: parseInt, setTimeout: setTimeout, clearTimeout: clearTimeout,
    BWN_MODULES: { operate: true },
    BWN: { safeModule: function (n, fn) { fn(); }, guard: function (fn) { return fn; } },
    AI_URL: 'https://swa.example/api/ai',
    AI_REQ_TIMEOUT_MS: 30000,
    AI_TOOLS: opts.tools || {
      page_snapshot: function () { return Promise.resolve({ ok: true, content: { revision: 'e1.r1', snapshot: { elements: [] } } }); },
      page_inspect: function () { return Promise.resolve({ ok: true, content: { detail: {} } }); },
      page_extract: function () { return Promise.resolve({ ok: true, content: { extract: {} } }); }
    },
    AI_TOOL_DEFS: [{ name: 'page_snapshot' }],
    aiUserToken: function () { return opts.token === undefined ? 'tok' : opts.token; },
    connectorEnabled: function () { return opts.connector !== false; },
    GM_getValue: function () { return opts.key === undefined ? 'k' : opts.key; },
    GM_xmlhttpRequest: function (o) {
      world.posts.push(JSON.parse(o.data));
      var reply = world.replies.shift();
      setTimeout(function () {
        if (!reply) return o.onload({ status: 200, responseText: JSON.stringify({ ok: true, status: 'final', text: '(default)' }) });
        if (reply.networkError) return o.onerror();
        o.onload({ status: reply.status, responseText: JSON.stringify(reply.json !== undefined ? reply.json : {}) });
      }, 0);
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  world.sandbox = sandbox;
  return world;
}

function run(src, opts) {
  var w = makeWorld(opts);
  vm.runInContext(src, w.sandbox, { filename: 'operate.module.js' });
  return w;
}
function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 12); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}
function start(w, task) {
  w.open();
  w.find(function (n) { return n.tagName === 'TEXTAREA'; }).value = task || 'do the thing';
  w.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Run'; }).fire('click');
  return tick();
}

/* ================================ tests ================================ */

var queue = [];
function test(name, fn) { queue.push([name, fn]); }

test('the module registers a dock entry rather than drawing its own button', function () {
  var w = run(MODULE);
  var reg = w.dispatched.filter(function (d) { return d && d.id === 'bwn:dock:register'; })[0];
  A.ok('registers on load', !!reg, JSON.stringify(w.dispatched));
  A.ok('under its own key', reg && reg.key === 'operate', reg && reg.key);
  A.ok('and is labelled for a human', reg && reg.label === 'Operate' && !!reg.title, JSON.stringify(reg));
});

test('the panel is unprojectable - an agent never sees its own controls', function () {
  var w = run(MODULE);
  w.open();
  var root = w.body.children[0];
  // The same marker the confirm strip carries. Without it a snapshot would hand the model the
  // Run and Stop buttons that are driving it, which is a loop with no floor.
  A.ok('the panel root carries data-bwn-domp-ui',
    root && root.getAttribute('data-bwn-domp-ui') === 'operate', root && JSON.stringify(root._attrs));
});

test('the capability line is DERIVED from the tool registry, not written down', function () {
  var ro = run(MODULE);
  ro.open();
  var line = ro.find(function (n) { return /Read-only/.test(n.textContent || ''); });
  A.ok('read-only today, and it says so', !!line, ro.logLines().join('|'));

  // The same shipped bytes, with a write tool present: the sentence has to change by itself, or
  // it is a claim somebody has to remember to update on the day it stops being true.
  var rw = run(MODULE, { tools: {
    page_snapshot: function () { return Promise.resolve({ ok: true }); },
    page_click: function () { return Promise.resolve({ ok: true }); }
  } });
  rw.open();
  var warn = rw.find(function (n) { return /CAN act on the page/.test(n.textContent || ''); });
  A.ok('and it changes on its own when a write tool exists', !!warn);
  A.ok('naming the verb it gained', warn && /page_click/.test(warn.textContent), warn && warn.textContent);
  A.ok('and promising the approval step', warn && /approve/.test(warn.textContent));
});

test('it posts the operate task, never ask', function () {
  var w = run(MODULE, { replies: [{ status: 200, json: { ok: true, status: 'final', text: 'done' } }] });
  return start(w).then(function () {
    A.ok('one post', w.posts.length === 1, String(w.posts.length));
    A.ok('task is operate', w.posts[0].task === 'operate', w.posts[0].task);
    A.ok('and it carries the tool registry', Array.isArray(w.posts[0].tools));
    A.ok('the answer reaches the log', w.logLines().some(function (l) { return /◆ done/.test(l); }), w.logLines().join('|'));
  });
});

test('every tool call and its result reach the log as they land', function () {
  var w = run(MODULE, { replies: [
    { status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 20, messages: [], toolCalls: [{ id: 't1', name: 'page_snapshot', input: {} }] } },
    { status: 200, json: { ok: true, status: 'final', text: 'read it' } }
  ] });
  return start(w).then(function () {
    var log = w.logLines();
    A.ok('the call is logged', log.some(function (l) { return /▸ page_snapshot/.test(l); }), log.join('|'));
    A.ok('the result is logged', log.some(function (l) { return /✓/.test(l); }), log.join('|'));
    A.ok('and the task heads the log', /^TASK: /.test(log[0]), log[0]);
  });
});

test('a failing tool is logged as failed and still handed back to the model', function () {
  var w = run(MODULE, {
    tools: { page_snapshot: function () { return Promise.resolve({ ok: false, content: { code: 'NO_RESPONDER', recovery: 'Core is not running' } }); } },
    replies: [
      { status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 20, messages: [], toolCalls: [{ id: 't1', name: 'page_snapshot', input: {} }] } },
      { status: 200, json: { ok: true, status: 'final', text: 'could not read it' } }
    ]
  });
  return start(w).then(function () {
    A.ok('logged as a failure', w.logLines().some(function (l) { return /✗.*NO_RESPONDER/.test(l); }), w.logLines().join('|'));
    var second = w.posts[1];
    A.ok('and the model is told', second && second.toolResults[0].is_error === true, JSON.stringify(second && second.toolResults));
  });
});

test('the round cap is the SERVER\'s number, adopted not copied', function () {
  // Twelve tool rounds against a floor of 6. If the client kept its own cap it would give up at
  // 7 posts; adopting maxRounds:20 lets the session finish.
  var replies = [];
  for (var i = 0; i < 12; i++) {
    replies.push({ status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 20, messages: [], toolCalls: [{ id: 't' + i, name: 'page_snapshot', input: {} }] } });
  }
  replies.push({ status: 200, json: { ok: true, status: 'final', text: 'finished' } });
  var w = run(MODULE, { replies: replies });
  return start(w).then(tick).then(tick).then(function () {
    A.ok('it ran past the floor', w.posts.length === 13, String(w.posts.length));
    A.ok('and reached the answer', w.logLines().some(function (l) { return /◆ finished/.test(l); }), w.logLines().slice(-2).join('|'));
  });
});

test('a server that never finishes is cut off at the cap, with an honest line', function () {
  var replies = [];
  for (var i = 0; i < 12; i++) {
    replies.push({ status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 6, messages: [], toolCalls: [{ id: 't' + i, name: 'page_snapshot', input: {} }] } });
  }
  var w = run(MODULE, { replies: replies });
  return start(w).then(tick).then(function () {
    A.ok('stopped at the cap', w.posts.length <= 8, String(w.posts.length));
    A.ok('and said why', w.logLines().some(function (l) { return /round cap/.test(l); }), w.logLines().slice(-1)[0]);
  });
});

test('a failure keeps its status AND its body - the whole reason this loop is not aiDriveLoop', function () {
  var w = run(MODULE, { replies: [{ status: 403, json: { ok: false, error: 'ROLE_REQUIRED' } }] });
  return start(w).then(function () {
    var last = w.logLines().slice(-1)[0];
    A.ok('the status survives', /403/.test(last), last);
    A.ok('and so does what the server said', /ROLE_REQUIRED/.test(last), last);
  });
});

test('a client-side blocker is named, not reported as a server error', function () {
  var w = run(MODULE, { key: '' });
  return start(w).then(function () {
    A.ok('no post was made', w.posts.length === 0, String(w.posts.length));
    A.ok('and the operator is told what to do', w.logLines().some(function (l) { return /ingest key/.test(l); }), w.logLines().join('|'));
  });
});

test('Stop halts before the next round, not after the loop finishes', function () {
  var replies = [];
  for (var i = 0; i < 6; i++) {
    replies.push({ status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 20, messages: [], toolCalls: [{ id: 't' + i, name: 'page_snapshot', input: {} }] } });
  }
  var w = run(MODULE, { replies: replies });
  w.open();
  w.find(function (n) { return n.tagName === 'TEXTAREA'; }).value = 'go';
  w.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Run'; }).fire('click');
  return tick(2).then(function () {
    w.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Stop'; }).fire('click');
    return tick(10);
  }).then(function () {
    A.ok('it did not run every round', w.posts.length < 6, String(w.posts.length));
    A.ok('and says a human stopped it', w.logLines().some(function (l) { return /stopped by you/.test(l); }), w.logLines().slice(-1)[0]);
  });
});

test('an empty task does not post anything', function () {
  var w = run(MODULE);
  w.open();
  w.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Run'; }).fire('click');
  return tick(3).then(function () { A.ok('nothing sent', w.posts.length === 0, String(w.posts.length)); });
});

/* ================================ mutation controls ================================ */

test('M1 dropping the panel marker makes the agent able to see its own controls', function () {
  var M = mutate(MODULE, "      panel.setAttribute('data-bwn-domp-ui', 'operate');", '');
  var w = run(M);
  w.open();
  A.ok('M1 the mutant panel is projectable',
    w.body.children[0].getAttribute('data-bwn-domp-ui') === null);
});

test('M2 dropping the maxRounds adoption truncates a long session at the floor', function () {
  var M = mutate(MODULE, '          if (served >= OP_MIN_ROUNDS && served <= 40) cap = served;', '');
  var replies = [];
  for (var i = 0; i < 12; i++) {
    replies.push({ status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 20, messages: [], toolCalls: [{ id: 't' + i, name: 'page_snapshot', input: {} }] } });
  }
  replies.push({ status: 200, json: { ok: true, status: 'final', text: 'finished' } });
  var w = run(M, { replies: replies });
  return start(w).then(tick).then(function () {
    A.ok('M2 the mutant gives up at its own floor', w.posts.length <= 8, String(w.posts.length));
    A.ok('M2 and never reaches the answer', !w.logLines().some(function (l) { return /◆ finished/.test(l); }));
  });
});

test('M3 Stop is checked in TWO places, and removing one is not enough', function () {
  // Written expecting one removal to disable Stop. It does not: the between-rounds check catches
  // a halt that arrives while waiting on the server, and the post-tools check catches one that
  // arrives while a tool is running. Different timings, both needed - and the harness is what
  // established that rather than the comment. Removing either alone still halts.
  var one = mutate(MODULE, '        if (stopped) return Promise.resolve({ stopped: true });', '');
  var replies1 = [];
  for (var j = 0; j < 6; j++) {
    replies1.push({ status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 20, messages: [], toolCalls: [{ id: 'u' + j, name: 'page_snapshot', input: {} }] } });
  }
  replies1.push({ status: 200, json: { ok: true, status: 'final', text: 'ran anyway' } });
  var w1 = run(one, { replies: replies1 });
  w1.open();
  w1.find(function (n) { return n.tagName === 'TEXTAREA'; }).value = 'go';
  w1.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Run'; }).fire('click');
  return tick(2).then(function () {
    w1.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Stop'; }).fire('click');
    return tick(14);
  }).then(function () {
    A.ok('M3 one removal still halts - the other check catches it',
      !w1.logLines().some(function (l) { return /◆ ran anyway/.test(l); }), w1.logLines().slice(-1)[0]);
  });
});

test('M3b removing BOTH stop checks is what actually takes Stop away', function () {
  var M = mutate(
    mutate(MODULE, '        if (stopped) return Promise.resolve({ stopped: true });', ''),
    '              if (stopped) return { stopped: true };', '');
  var replies = [];
  for (var i = 0; i < 6; i++) {
    replies.push({ status: 200, json: { ok: true, status: 'tool_calls', maxRounds: 20, messages: [], toolCalls: [{ id: 't' + i, name: 'page_snapshot', input: {} }] } });
  }
  replies.push({ status: 200, json: { ok: true, status: 'final', text: 'ran anyway' } });
  var w = run(M, { replies: replies });
  w.open();
  w.find(function (n) { return n.tagName === 'TEXTAREA'; }).value = 'go';
  w.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Run'; }).fire('click');
  return tick(2).then(function () {
    w.find(function (n) { return n.tagName === 'BUTTON' && n.textContent === 'Stop'; }).fire('click');
    return tick(14);
  }).then(function () {
    A.ok('M3b the mutant runs on past the halt', w.posts.length >= 5, String(w.posts.length));
  });
});

test('M4 swallowing the response body loses what the server actually said', function () {
  var M = mutate(MODULE,
    "            return { error: 'the BWN app answered ' + r.status + ': ' + (r.json && r.json.error ? r.json.error : r.body) };",
    "            return { error: 'the BWN app answered' };");
  var w = run(M, { replies: [{ status: 403, json: { ok: false, error: 'ROLE_REQUIRED' } }] });
  return start(w).then(function () {
    A.ok('M4 the mutant hides the cause', !/ROLE_REQUIRED/.test(w.logLines().slice(-1)[0]), w.logLines().slice(-1)[0]);
  });
});

test('M5 mutate() throws on a missing target', function () {
  var threw = false;
  try { mutate(MODULE, 'not present anywhere in this module', 'x'); } catch (e) { threw = /ABSENT/.test(e.message); }
  A.ok('M5 a control cannot silently no-op', threw);
});

/* ================================ run ================================ */

(function run(i) {
  if (i >= queue.length) { A.finish(); return; }
  console.log('\n' + queue[i][0]);
  var r;
  try { r = queue[i][1](); } catch (e) { A.ok(queue[i][0] + ' threw', false, e.message + '\n' + e.stack); }
  Promise.resolve(r).then(function () { run(i + 1); }, function (e) {
    A.ok(queue[i][0] + ' rejected', false, (e && e.message) || String(e));
    run(i + 1);
  });
})(0);
