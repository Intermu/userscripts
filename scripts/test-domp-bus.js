// test-domp-bus.js - the phase-4 bus contract, driven end to end with BOTH real halves.
//
// bwn:cmd was fire-and-forget with no reply channel. Phase 4 adds a request/response pair across
// the realm boundary:
//   out  bwn:cmd  { id:'domp:snapshot'|'domp:act', rid, ... }   (AI script, GM sandbox)
//   in   bwn:evt  { id:'domp:result',              rid, result } (Core, page context)
// Core is @grant none and cannot be called into from the sandbox, and the sandbox's globals are
// invisible to the page, so this event pair is the ONLY thing joining them. If it is wrong there
// is no fallback path that quietly works instead - the tool simply never answers.
//
// WHAT THIS DRIVES. Real shipped bytes on both sides: the responder module sliced out of
// bwn-suite-core.user.js, the bus client and the three page_* tools sliced out of
// bwn-suite-ai.user.js, and the REAL collector and projector - the BWN-DOM / BWN-DOMC blocks
// sliced out of Core, which scripts/test-domproj-parity.js proves are the same bytes as the
// broadway-internal-ops sources. Nothing between the tool call and the payload is stubbed. A
// recording fake in the middle here would prove the two halves agree with the fake rather than
// with each other ([[harness-stub-hides-dead-feature]]).
//
// NOT PROVEN HERE: what a real browser answers for visibility, geometry and hit-testing. The DOM
// below is a hand-written shim. That is the live gate's job, in the vault at
// outputs/bwn-domcollect-live-gate.js - this file is about the WIRE, not the reading.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-domp-bus.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

var CORE = readLF(path.join(__dirname, '..', 'bwn-suite-core.user.js'));
var AI = readLF(path.join(__dirname, '..', 'bwn-suite-ai.user.js'));

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a + 1);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}

// The protocol blocks, taken from Core rather than from the other repo: these are the bytes that
// actually ship inside the userscript, and parity with the source is a separate harness's job.
function region(text, label) {
  var lines = text.split('\n'), si = -1, ei = -1;
  for (var i = 0; i < lines.length; i++) {
    if (si === -1 && lines[i].indexOf('/* ' + label + ':START') === 0) si = i;
    else if (si !== -1 && lines[i].indexOf('/* ' + label + ':END') === 0) { ei = i; break; }
  }
  if (si === -1 || ei === -1) throw new Error(label + ': sentinels not found in Core');
  var j = si;
  while (j < ei && lines[j].indexOf('*/') === -1) j++;
  return lines.slice(j + 1, ei).join('\n');
}

var L0 = region(CORE, 'BWN-DOM');
var L12 = region(CORE, 'BWN-DOMC');
var RESPONDER = slice(CORE, '  bwnBoot(\'domHandle\', BWN_MODULES.domHandle, function () {', '\n  // ---- Flush the module queue', 'core responder');
var AI_CLIENT = slice(AI, '  var DOMP_TIMEOUT_MS =', '\n  var AI_TOOLS = {', 'ai bus client');
var AI_PAGE_TOOLS = slice(AI, '    page_snapshot: function (input) {', '\n  };', 'ai page tools');

/* ================================ a small DOM ================================ */

function E(tag, props, kids) {
  props = props || {}; kids = kids || [];
  var attrs = props.attrs || {};
  var self = {
    nodeType: 1, tagName: String(tag).toUpperCase(), children: kids, parentNode: null,
    isConnected: true, _attrs: attrs, _own: props.text || '',
    _rect: props.rect || { left: 0, top: 0, width: 120, height: 24 },
    _visible: props.visible !== false,
    value: props.value != null ? String(props.value) : '',
    disabled: !!props.disabled, className: attrs.class || '', id: attrs.id || '',
  };
  self.getAttribute = function (n) { return (n in attrs) ? String(attrs[n]) : null; };
  Object.defineProperty(self, 'textContent', {
    get: function () { return self._own + self.children.map(function (c) { return c.textContent; }).join(' '); },
  });
  self.getBoundingClientRect = function () { return self._rect; };
  self.checkVisibility = function () { return self._visible; };
  self.contains = function (o) { var n = o; while (n) { if (n === self) return true; n = n.parentNode; } return false; };
  self.closest = function (sel) {
    var n = self;
    while (n) { if (sel === '[inert]' && n._attrs.inert != null) return n; if (sel === 'label' && n.tagName === 'LABEL') return n; n = n.parentNode; }
    return null;
  };
  self.querySelectorAll = function (sel) {
    var want = sel.split(',').map(function (s) { return s.trim().toUpperCase(); }), out = [];
    (function walk(n) { n.children.forEach(function (c) { if (want.indexOf(c.tagName) >= 0) out.push(c); walk(c); }); })(self);
    return out;
  };
  kids.forEach(function (k) { k.parentNode = self; });
  return self;
}

function flatten(r) { var o = []; (function w(n) { o.push(n); n.children.forEach(w); })(r); return o; }

function page() {
  return E('body', {}, [
    E('main', { attrs: { 'aria-label': 'Work order' }, rect: { left: 0, top: 0, width: 900, height: 500 } }, [
      E('h1', { text: 'W-375038', rect: { left: 8, top: 8, width: 200, height: 30 } }),
      E('button', { attrs: { 'data-testid': 'dispatch' }, text: 'Dispatch', rect: { left: 8, top: 60, width: 100, height: 30 } }),
      E('input', { attrs: { id: 'eta', type: 'text' }, value: '2026-08-14', rect: { left: 8, top: 110, width: 180, height: 26 } }),
      E('input', { attrs: { id: 'cardNumber', type: 'text', name: 'cardNumber' }, value: '4111111111111111', rect: { left: 8, top: 150, width: 180, height: 26 } }),
      E('table', { attrs: { 'data-testid': 'trips' }, rect: { left: 8, top: 200, width: 600, height: 120 } }, [
        E('tr', {}, [E('th', { text: 'Date' }), E('th', { text: 'Tech' })]),
        E('tr', {}, [E('td', { text: '2026-08-12' }), E('td', { text: 'R. Alvarez' })]),
      ]),
    ]),
  ]);
}

/* ================================ the two realms ================================ */
//
// One shared `document` object with a real listener table, standing in for the DOM event bus that
// is the only channel between page context and the Tampermonkey sandbox. Both halves get the same
// object, exactly as they do in the browser.

function makeWorld(o) {
  o = o || {};
  var body = o.body || page();
  var listeners = {};
  var timers = [], now = 0;
  var doc = {
    body: body, title: 'Work Order W-375038',
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: function (t, fn) {
      var a = listeners[t] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatchEvent: function (ev) { (listeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); }); return true; },
    getElementById: function (id) { return flatten(body).filter(function (n) { return n._attrs.id === id; })[0] || null; },
    querySelector: function (sel) {
      var m = /^label\[for="(.*)"\]$/.exec(sel); if (!m) return null;
      return flatten(body).filter(function (n) { return n.tagName === 'LABEL' && n._attrs.for === m[1]; })[0] || null;
    },
    elementFromPoint: function (x, y) {
      if (x < 0 || y < 0 || x >= 1280 || y >= 800) return null;
      var hit = null;
      flatten(body).forEach(function (n) {
        var r = n._rect;
        if (!n._visible) return;
        if (x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height) hit = n;
      });
      return hit;
    },
  };
  var store = o.store || {
    'bwn:status:core': JSON.stringify({ ver: '1.67.0', ts: 1000 }),
    'bwn:status:ai': JSON.stringify({ ver: '1.44.0', ts: 1000 }),
  };
  var win = {
    document: doc, innerWidth: 1280, innerHeight: 800,
    location: { href: 'https://app.umbrava.com/work-orders/375038', pathname: '/work-orders/375038', hash: '', origin: 'https://app.umbrava.com' },
    getComputedStyle: function () { return { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' }; },
  };
  var sandbox = {
    document: doc, console: { log: function () {}, info: function () {}, warn: function () {}, error: function () {} },
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
    },
    Promise: Promise, Date: Date, JSON: JSON, Math: Math, String: String, Object: Object, Array: Array,
    CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || null; },
    // Controllable clock: the harness fires timers itself, so nothing here asserts on elapsed
    // time. A headless harness cannot time, and a hidden pane clamps setTimeout anyway.
    setTimeout: function (fn, ms) { timers.push({ fn: fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout: function (h) { if (h >= 1 && timers[h - 1]) timers[h - 1] = null; },
  };
  sandbox.window = win;
  win.window = win;
  vm.createContext(sandbox);
  // The protocol blocks target `window`, so hand them the page's window object.
  vm.runInContext('(function(){ var window = this.window; ' + L0 + '\n' + L12 + '\n }).call(this)', sandbox, { filename: 'bwn-dom-blocks.js' });
  return {
    sandbox: sandbox, doc: doc, win: win, store: store,
    runTimers: function () { var due = timers.slice(); timers.length = 0; due.forEach(function (t) { if (t) t.fn(); }); },
    listeners: listeners,
    pendingTimers: function () { return timers.filter(Boolean).length; },
  };
}

// Boot Core's responder module into a world (page context).
function bootCore(w, moduleOn) {
  var beats = [];
  var prelude =
    'var BWN_MODULES = { domHandle: ' + (moduleOn === false ? 'false' : 'true') + ' };' +
    'var BWN = { guard: function (fn) { return function (e) { return fn(e); }; },' +
    '            beat: function (m, s, t) { _beats.push([m, s, t]); } };' +
    'function bwnBoot(id, on, fn) { if (on) fn(); }';
  w.sandbox._beats = beats;
  vm.runInContext('(function(){ ' + prelude + '\n' + RESPONDER + '\n})()', w.sandbox, { filename: 'core-responder.js' });
  return beats;
}

// Boot the AI script's bus client + the three page tools into the same world (sandbox side).
function bootAI(w) {
  vm.runInContext(
    '(function(){\n' + AI_CLIENT + '\n' +
    'var PAGE_TOOLS = {\n' + AI_PAGE_TOOLS + '\n};\n' +
    'this.PAGE_TOOLS = PAGE_TOOLS; this.dompReq = dompReq; this.dompCoreLive = dompCoreLive;\n' +
    '}).call(this)', w.sandbox, { filename: 'ai-bus-client.js' });
  return { tools: w.sandbox.PAGE_TOOLS, dompReq: w.sandbox.dompReq, coreLive: w.sandbox.dompCoreLive };
}

/* ================================ tests ================================ */

var queue = [];
function test(name, fn) { queue.push([name, fn]); }

test('a page_snapshot round-trips over the bus and comes back as handles', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    A.ok('the tool reports ok', res.ok === true, JSON.stringify(res).slice(0, 200));
    var snap = res.content && res.content.snapshot;
    A.ok('a snapshot came back', !!snap);
    A.ok('with a revision', /^e1\.r\d+$/.test(snap.page.revision), snap && snap.page.revision);
    A.ok('and real elements', snap.elements.length >= 4, 'got ' + snap.elements.length);
    var names = snap.elements.map(function (e) { return e.name || e.label || e.text; });
    A.ok('the Dispatch button is in there', names.indexOf('Dispatch') >= 0, names.join(' | '));
    A.ok('handles are minted', /^@[abischdtmh]\d+$/.test(snap.elements[0].h), snap.elements[0].h);
  });
});

test('the reply never carries a live element or a masked value', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    var blob = JSON.stringify(res);
    A.ok('the card number never crosses the bus', blob.indexOf('4111111111111111') === -1);
    A.ok('no element reference crosses the bus', blob.indexOf('_el') === -1 && blob.indexOf('tagName') === -1);
    A.ok('the deny field is announced as masked', (res.content.snapshot.masked || []).length === 1,
      JSON.stringify(res.content.snapshot.masked));
    A.ok('and its policy is published up front', JSON.stringify(res.content.snapshot.policy || {}).indexOf('deny') > 0);
  });
});

// Answer every request with a WRONG rid, and do it BEFORE Core can answer with the right one.
// Listener order is registration order, so this must be attached ahead of bootCore - attached
// after, the correct reply lands first, the client settles, and the probe passes without the rid
// check ever having been consulted. The M1 control below is what caught that.
function poisonFirst(w) {
  w.doc.addEventListener('bwn:cmd', function (e) {
    var d = e.detail;
    if (d && (d.id === 'domp:snapshot' || d.id === 'domp:act')) {
      w.doc.dispatchEvent(new w.sandbox.CustomEvent('bwn:evt', { detail: { id: 'domp:result', rid: 'not-yours', result: { ok: true, snapshot: { poisoned: true } } } }));
    }
  });
}

test('replies correlate on rid: a foreign reply is ignored, the real one resolves', function () {
  var w = makeWorld(); poisonFirst(w); bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    A.ok('the mismatched reply was ignored', !(res.content && res.content.snapshot && res.content.snapshot.poisoned),
      JSON.stringify(res).slice(0, 160));
    A.ok('and the correctly addressed one resolved', res.ok === true);
  });
});

test('two concurrent requests do not cross their answers', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  return Promise.all([
    ai.tools.page_snapshot({}),
    ai.tools.page_extract({ handle: '@t1' }),
  ]).then(function (r) {
    A.ok('the snapshot call got a snapshot', !!(r[0].content && r[0].content.snapshot));
    A.ok('the extract call did not get the snapshot', !(r[1].content && r[1].content.snapshot));
  });
});

test('a silent page resolves TIMEOUT - the tool loop can never hang', function () {
  var w = makeWorld(); var ai = bootAI(w);          // NOTE: Core deliberately NOT booted
  // Core is "live" per localStorage but its responder is absent, which is the shape of a Core
  // that loaded and then threw. Nothing will ever answer; the timeout is the only way out.
  var settled = false;
  var p = ai.tools.page_snapshot({}).then(function (res) {
    settled = true;
    A.ok('it settles rather than hanging', true);
    A.ok('and says TIMEOUT', res.content && res.content.code === 'TIMEOUT', JSON.stringify(res.content));
    A.ok('with a recovery the model can act on', !!(res.content && res.content.recovery));
  });
  A.ok('it is genuinely pending until the timer fires', settled === false);
  w.runTimers();
  return p;
});

test('the bus listener is removed on BOTH paths (no leak per tool call)', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  var before = (w.listeners['bwn:evt'] || []).length;
  return ai.tools.page_snapshot({}).then(function () {
    A.ok('answered path leaves no listener behind', (w.listeners['bwn:evt'] || []).length === before,
      'before ' + before + ' after ' + (w.listeners['bwn:evt'] || []).length);
    A.ok('and cancels its timeout', w.pendingTimers() === 0, w.pendingTimers() + ' timers still armed');
    var w2 = makeWorld(); var ai2 = bootAI(w2);
    var b2 = (w2.listeners['bwn:evt'] || []).length;
    var p = ai2.tools.page_snapshot({});
    w2.runTimers();
    return p.then(function () {
      A.ok('timed-out path leaves no listener behind', (w2.listeners['bwn:evt'] || []).length === b2);
    });
  });
});

test('write verbs are refused AT THE BUS, not only inside the collector', function () {
  var w = makeWorld(); bootCore(w); bootAI(w);
  // Straight onto the wire, bypassing the AI script's tool set entirely - this is what a
  // compromised or simply wrong caller looks like.
  var got = null;
  w.doc.addEventListener('bwn:evt', function (e) { if (e.detail && e.detail.id === 'domp:result') got = e.detail.result; });
  ['click', 'fill', 'select', 'check', 'press', 'wait_for', 'scroll'].forEach(function (verb) {
    got = null;
    w.doc.dispatchEvent(new w.sandbox.CustomEvent('bwn:cmd', { detail: { id: 'domp:act', rid: 'r-' + verb, verb: verb, handle: '@b1' } }));
    A.ok(verb + ' is refused over the bus', got && got.ok === false && got.code === 'VERB_DISABLED', JSON.stringify(got));
  });
  got = null;
  w.doc.dispatchEvent(new w.sandbox.CustomEvent('bwn:cmd', { detail: { id: 'domp:act', rid: 'r-eval', verb: 'evaluate', handle: '@b1' } }));
  A.ok('an invented verb is refused too', got && got.code === 'VERB_DISABLED', JSON.stringify(got));
});

test('an unaddressed request is ignored rather than answered to nobody', function () {
  var w = makeWorld(); bootCore(w);
  var replies = 0;
  w.doc.addEventListener('bwn:evt', function (e) { if (e.detail && e.detail.id === 'domp:result') replies++; });
  w.doc.dispatchEvent(new w.sandbox.CustomEvent('bwn:cmd', { detail: { id: 'domp:snapshot' } }));           // no rid
  w.doc.dispatchEvent(new w.sandbox.CustomEvent('bwn:cmd', { detail: { id: 'core:ecd', rid: 'x' } }));      // not ours
  A.ok('neither produced a reply', replies === 0, 'replies=' + replies);
});

test('Core switched off is reported fast and by NAME, not as a timeout', function () {
  var w = makeWorld({ store: {
    'bwn:status:core': JSON.stringify({ ver: '1.67.0', ts: 1000 }),
    'bwn:status:ai': JSON.stringify({ ver: '1.44.0', ts: 1000 }),
    'bwn:modules': JSON.stringify({ domHandle: false }),
  } });
  bootCore(w, false); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    A.ok('NO_RESPONDER, not TIMEOUT', res.content && res.content.code === 'NO_RESPONDER', JSON.stringify(res.content));
    A.ok('the reason names the kill switch', /switched off/.test(res.content.recovery || ''), res.content.recovery);
    A.ok('and it cost no timer at all', w.pendingTimers() === 0);
  });
});

test('Core absent from the page is reported as absent', function () {
  var w = makeWorld({ store: {} });
  var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    A.ok('NO_RESPONDER', res.content && res.content.code === 'NO_RESPONDER');
    A.ok('naming the missing Core script', /not running/.test(res.content.recovery || ''), res.content.recovery);
  });
});

test('a stale Core stamp (previous page load) is not treated as live', function () {
  var w = makeWorld({ store: {
    'bwn:status:core': JSON.stringify({ ver: '1.67.0', ts: 1000 }),
    'bwn:status:ai': JSON.stringify({ ver: '1.44.0', ts: 9000000 }),   // different session
  } });
  bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    A.ok('NO_RESPONDER on a session mismatch', res.content && res.content.code === 'NO_RESPONDER', JSON.stringify(res.content));
    A.ok('naming the session', /session/.test(res.content.recovery || ''), res.content.recovery);
  });
});

test('a responder that throws answers with the fault instead of stalling', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  // Break the collector underneath the responder, the way a browser API change would.
  vm.runInContext('window.BWNDOMC.act = function () { throw new Error("collector exploded"); };', w.sandbox);
  return ai.tools.page_snapshot({}).then(function (res) {
    A.ok('it answered', res.ok === false && res.content.code === 'RESPONDER_THREW', JSON.stringify(res.content));
    A.ok('carrying the reason', /exploded/.test(res.content.recovery || ''), res.content.recovery);
    A.ok('and did not wait out the timeout', w.pendingTimers() === 0);
  });
});

test('page_inspect and page_extract reach real elements; a deny handle refuses', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    var snap = res.content.snapshot;
    var tbl = snap.elements.filter(function (e) { return e.role === 'table'; })[0];
    var denyH = Object.keys(snap.policy || {}).filter(function (h) { return snap.policy[h] === 'deny'; })[0];
    var eta = snap.elements.filter(function (e) { return e.label === 'eta' || e.value === '2026-08-14'; })[0];
    A.ok('the snapshot summarized the table as a shape', !!(tbl && tbl.shape), JSON.stringify(tbl));
    return Promise.all([
      ai.tools.page_extract({ handle: tbl.h, revision: snap.page.revision }),
      ai.tools.page_inspect({ handle: denyH, revision: snap.page.revision }),
      ai.tools.page_extract({ handle: denyH, revision: snap.page.revision }),
      ai.tools.page_inspect({ handle: eta.h, revision: snap.page.revision }),
    ]).then(function (r) {
      A.ok('extract returns the table rows', !!(r[0].ok && r[0].content.extract.rows.length === 2), JSON.stringify(r[0]).slice(0, 160));
      A.ok('inspect on the deny field reports masked', r[1].ok === true && r[1].content.detail.masked === true, JSON.stringify(r[1].content));
      A.ok('and withholds the value', JSON.stringify(r[1]).indexOf('4111') === -1);
      A.ok('extract on the deny field is POLICY_DENIED', r[2].ok === false && r[2].content.code === 'POLICY_DENIED', JSON.stringify(r[2].content));
      A.ok('inspect on an allowed field returns its value', r[3].ok === true && r[3].content.detail.value === '2026-08-14', JSON.stringify(r[3].content));
    });
  });
});

test('a handle from a previous page is HANDLE_STALE, never acted on', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    var h = res.content.snapshot.elements[0].h;
    var oldRev = res.content.snapshot.page.revision;
    w.win.location.href = 'https://app.umbrava.com/work-orders/999999';
    w.win.location.pathname = '/work-orders/999999';
    return ai.tools.page_snapshot({}).then(function (next) {
      A.ok('the epoch bumped on navigation', /^e2\./.test(next.content.snapshot.page.revision), next.content.snapshot.page.revision);
      return ai.tools.page_inspect({ handle: h, revision: oldRev }).then(function (ins) {
        A.ok('the old handle is stale', ins.ok === false && ins.content.code === 'HANDLE_STALE', JSON.stringify(ins.content));
      });
    });
  });
});

test('a since from the immediately preceding round gets a delta; a gap gets a full snapshot', function () {
  var w = makeWorld(); bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (first) {
    var rev = first.content.snapshot.page.revision;
    w.doc.body.children[0].children[1].disabled = true;             // Dispatch goes disabled
    return ai.tools.page_snapshot({ since: rev }).then(function (second) {
      A.ok('a delta came back, not a full snapshot', !!second.content.delta && !second.content.snapshot, Object.keys(second.content).join(','));
      A.ok('and it carries the change', JSON.stringify(second.content.delta).indexOf('"enabled":false') > 0, JSON.stringify(second.content.delta).slice(0, 200));
      return ai.tools.page_snapshot({ since: rev }).then(function (third) {
        A.ok('a stale since reports REVISION_GAP', third.content.notice === 'REVISION_GAP', JSON.stringify(third.content).slice(0, 160));
        A.ok('and ships the full snapshot instead', !!third.content.snapshot);
      });
    });
  });
});

test('a shadow root on the page is reported, not silently skipped', function () {
  var body = page();
  body.children[0].shadowRoot = { closed: false };
  var w = makeWorld({ body: body }); bootCore(w); var ai = bootAI(w);
  return ai.tools.page_snapshot({}).then(function (res) {
    A.ok('unexplored is reported to the model', !!(res.content.snapshot.unexplored && res.content.snapshot.unexplored.shadowRoots === 1),
      JSON.stringify(res.content.snapshot.unexplored));
  });
});

/* ================================ mutation controls ================================ */
// Each reverts one property of the wire in a sliced copy and asserts the matching probe goes red.

function mutate(src, from, to, what) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT (' + what + '): ' + JSON.stringify(from.slice(0, 60)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE (' + what + '): ' + JSON.stringify(from.slice(0, 60)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function withMutatedClient(w, src) {
  vm.runInContext('(function(){\n' + src + '\nvar PAGE_TOOLS = {\n' + AI_PAGE_TOOLS + '\n};\nthis.PAGE_TOOLS = PAGE_TOOLS;\n}).call(this)', w.sandbox, { filename: 'ai-bus-client.mutant.js' });
  return w.sandbox.PAGE_TOOLS;
}

test('a failed protocol load degrades to "unavailable", it does not kill Core', function () {
  // The blocks run at Core's top level, outside BWN.safeModule's net, so a throw in either one
  // would take the whole suite down with it for an optional read-only feature.
  var head = CORE.slice(0, CORE.indexOf('/* BWN-DOM:START'));
  var tail = CORE.slice(CORE.indexOf('/* BWN-DOMC:END */'));
  A.ok('the pasted blocks are wrapped in a try', /\btry \{\s*$/m.test(head.slice(-400)), 'no guard before BWN-DOM');
  A.ok('and the catch follows BWN-DOMC', /\} catch \(e\) \{/.test(tail.slice(0, 400)), 'no catch after BWN-DOMC');
  A.ok('the guard is OUTSIDE the sentinels (bytes stay paste-identical)',
    head.slice(-400).indexOf('BWN-DOM:START') === -1);

  // And the responder handles the aftermath: globals absent -> it beats fail and answers nothing,
  // which is the state the AI client reports as NO_RESPONDER rather than hanging.
  var w = makeWorld();
  vm.runInContext('window.BWNDOMC = null; window.BWNDOM = null;', w.sandbox);
  var beats = bootCore(w);
  A.ok('the responder reports itself unavailable', beats.length === 1 && beats[0][1] === 'fail', JSON.stringify(beats));
  var replies = 0;
  w.doc.addEventListener('bwn:evt', function (e) { if (e.detail && e.detail.id === 'domp:result') replies++; });
  w.doc.dispatchEvent(new w.sandbox.CustomEvent('bwn:cmd', { detail: { id: 'domp:snapshot', rid: 'r1' } }));
  A.ok('and does not answer at all', replies === 0);
});

test('M1 dropping the rid check lets a foreign reply be accepted', function () {
  var w = makeWorld(); poisonFirst(w); bootCore(w);
  var tools = withMutatedClient(w, mutate(AI_CLIENT,
    "if (!d || d.id !== 'domp:result' || d.rid !== rid) return;",
    "if (!d || d.id !== 'domp:result') return;", 'M1'));
  return tools.page_snapshot({}).then(function (res) {
    A.ok('M1 the mutant swallows the wrong answer (so the rid probe bites)',
      !!(res.content && res.content.snapshot && res.content.snapshot.poisoned), JSON.stringify(res).slice(0, 140));
  });
});

test('M2 dropping the timeout makes a silent page hang forever', function () {
  var w = makeWorld();                                   // no Core
  var tools = withMutatedClient(w, mutate(AI_CLIENT,
    "      timer = setTimeout(function () {", "      if (false) setTimeout(function () {", 'M2'));
  var settled = false;
  tools.page_snapshot({}).then(function () { settled = true; });
  w.runTimers();
  return Promise.resolve().then(function () {
    A.ok('M2 the mutant never settles (so the timeout probe bites)', settled === false);
  });
});

test('M3 dropping the bus verb gate lets a write verb through to the collector', function () {
  var w = makeWorld();
  var beats = [];
  w.sandbox._beats = beats;
  var mutant = mutate(RESPONDER, "if (BUS_VERBS[verb] !== 1) {", "if (false) {", 'M3');
  vm.runInContext('(function(){ var BWN_MODULES = { domHandle: true };' +
    'var BWN = { guard: function (fn) { return fn; }, beat: function (m, s, t) { _beats.push([m, s, t]); } };' +
    'function bwnBoot(id, on, fn) { if (on) fn(); }\n' + mutant + '\n})()', w.sandbox, { filename: 'core-responder.mutant.js' });
  var got = null;
  w.doc.addEventListener('bwn:evt', function (e) { if (e.detail && e.detail.id === 'domp:result') got = e.detail.result; });
  w.doc.dispatchEvent(new w.sandbox.CustomEvent('bwn:cmd', { detail: { id: 'domp:act', rid: 'r1', verb: 'click', handle: '@b1' } }));
  // It reaches the collector, which has its OWN gate - so the answer is still a refusal, but it is
  // now the collector's refusal rather than the bus's, which is what makes this a control rather
  // than a coincidence. Phase 5 gave the collector a working executor; what stops it here is that
  // the responder's session was never armed for writes.
  A.ok('M3 the mutant forwards it to the collector (so the bus gate is doing work)',
    got && got.ok === false && got.code === 'VERB_DISABLED' && /not armed for writes/.test(got.recovery || ''),
    JSON.stringify(got));
});

test('M3b even an ARMED session refuses to write on a live WO - the phase-6 registry', function () {
  // The bus gate and the arming gate are both bypassed here: a session built with write:true, on
  // the collector directly, no bus in the way. What is left is phase 6's workflow registry, and
  // this world sits on `/work-orders/375038` - the exact route the shipped wo-add-note entry
  // names. It still refuses, because that entry is disabled. This is the assertion that would go
  // red the day someone flips a flag without meaning to.
  var w = makeWorld();
  var DC = w.sandbox.window.BWNDOMC;
  var s = DC.createSession({ window: w.win, document: w.doc, write: true, rank: 5 });
  var snap = DC.refresh(s).snapshot;
  var h = (snap.elements[0] || {}).h;
  var r = DC.act(s, { verb: 'click', handle: h, revision: snap.page.revision });
  A.ok('M3b an armed rank-5 session on a live WO route is NO_WORKFLOW',
    r && r.ok === false && r.code === 'NO_WORKFLOW', JSON.stringify(r));
  A.ok('M3b and the refusal names the route it refused',
    (r.recovery || '').indexOf('/work-orders/375038') !== -1, r.recovery);
  var on = DC.WORKFLOWS.filter(function (x) { return x.enabled; }).map(function (x) { return x.id; });
  A.ok('M3b nothing in the shipped registry is switched on', on.length === 0, on.join(','));
  A.ok('M3b and app.umbrava.com is not in the blanket surface allowlist',
    DC.WRITE_SURFACES['https://app.umbrava.com'] === undefined);
});

test('M4 mutate() throws on a missing target', function () {
  var threw = false;
  try { mutate(AI_CLIENT, 'not present anywhere', 'x', 'M4'); } catch (e) { threw = /ABSENT/.test(e.message); }
  A.ok('M4 a control cannot silently no-op', threw);
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
