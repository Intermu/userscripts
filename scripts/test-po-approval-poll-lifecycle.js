// test-po-approval-poll-lifecycle.js - characterizes the CURRENT lifecycle of PO Approval's Send-PO-modal
// poller in bwn-suite-core.user.js (module "PO Approval + ETA Builder"): schedule() / stopPoll() /
// pollTimer, plus the document.body observer that drives schedule().
//
// Pinned, each read from the shipped source before it was encoded here:
//   A. single timer   - schedule() with the modal open and buttons not yet mountable starts ONE
//                       setInterval (150ms); a second schedule() while pollTimer is set starts none.
//   B. modal absent   - schedule() checks the modal title FIRST: no modal -> no tryMount() call,
//                       no interval.
//   C. modal gone     - a running poll stops (clearInterval + pollTimer=null) when a tick finds the
//                       modal gone, and schedule() with the modal gone stops it too.
//   D. mounted        - a tick whose tryMount() returns true stops the poll; a schedule() whose first
//                       tryMount() returns true never starts one.
//   E. observer       - module setup builds ONE MutationObserver on document.body with
//                       {childList:true, subtree:true}, calls schedule() once, and the module contains
//                       no disconnect() call (a STATIC source check, not a simulated DOM lifetime):
//                       under the present code the observer lives for the page's lifetime.
//
// This documents behavior; it does not endorse it. E in particular is the baseline for a later,
// MEASURED decision (the observer is how the module sees the modal appear on any SPA route) - it is
// not a claim that the lifetime is right or wrong.
//
// Drives the REAL shipped bytes. `schedule`, `stopPoll` and `tryMount` are ALSO declared inside Email
// Leak Guard, so every slice is scoped to the PO Approval module region (between its "// MODULE:" header
// and WO Assist's) and each declaration must occur exactly once inside that region. Functions are cut by
// brace counting (sliceFn, as in scripts/test-a11y-focus.js). No Core markers, no line numbers.
// tryMount() is stubbed - its DOM work is out of scope; only its boolean return drives the lifecycle.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-po-approval-poll-lifecycle.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');

function once(src, needle, where) {
  var a = src.indexOf(needle);
  if (a === -1) throw new Error('not found in ' + where + ': ' + needle);
  if (src.indexOf(needle, a + 1) !== -1) throw new Error('not unique in ' + where + ': ' + needle);
  return a;
}
var REGION = (function () {
  var a = once(SRC, '// MODULE: PO Approval + ETA Builder', 'Core');
  var b = once(SRC, '// MODULE: WO Assist', 'Core');
  if (b < a) throw new Error('module headers out of order');
  return SRC.slice(a, b);
})();
function sliceFn(decl) {
  var a = once(REGION, decl, 'PO Approval module');
  var depth = 0, i = REGION.indexOf('{', a);
  for (var j = i; j < REGION.length; j++) {
    if (REGION[j] === '{') depth++;
    else if (REGION[j] === '}') { depth--; if (depth === 0) return REGION.slice(a, j + 1); }
  }
  throw new Error('unbalanced braces after ' + decl);
}
function sliceLine(decl) { var a = once(REGION, decl, 'PO Approval module'); return REGION.slice(a, REGION.indexOf('\n', a)); }

var PARTS = {
  vars: sliceLine('var pollTimer = null;') + '\n' + sliceLine('var loggedOpen = false;'),
  stopPoll: sliceFn('function stopPoll('),
  schedule: sliceFn('function schedule('),
  // Module setup tail: observer construction through the first schedule() call.
  setup: (function () {
    var a = once(REGION, 'var obs = new MutationObserver(', 'PO Approval module');
    var b = REGION.indexOf('schedule();', a);
    if (b === -1) throw new Error('setup schedule() call not found');
    return REGION.slice(a, b + 'schedule();'.length);
  })()
};

// env: { modal: bool, mount: bool } drive the stubs; everything observable is recorded.
function load(parts) {
  var env = { modal: false, mount: false };
  var rec = { set: [], clear: [], tryMount: 0, observers: [], nextId: 1 };
  var TITLE = '[data-testid="mail-to-modal-title"]';
  var doc = {
    body: { tag: 'body' },
    querySelector: function (sel) { return (sel === TITLE && env.modal) ? { tag: 'title' } : null; }
  };
  function setIntervalStub(fn, ms) { var id = rec.nextId++; rec.set.push({ id: id, fn: fn, ms: ms }); return id; }
  function clearIntervalStub(id) { rec.clear.push(id); }
  function tryMountStub() { rec.tryMount++; return env.mount; }
  function MO(cb) { this.cb = cb; this.observed = []; this.disconnects = 0; rec.observers.push(this); }
  MO.prototype.observe = function (t, o) { this.observed.push({ target: t, opts: o }); };
  MO.prototype.disconnect = function () { this.disconnects++; };
  var BWN = { guard: function (fn) { return fn; }, beat: function () { } };
  var quiet = { info: function () { }, log: function () { }, warn: function () { }, error: function () { } };

  var body =
    "'use strict';\n" + parts.vars + '\n' + parts.stopPoll + '\n' + parts.schedule + '\n' +
    'return { schedule: schedule, stopPoll: stopPoll, timer: function () { return pollTimer; },\n' +
    '  setup: function () { ' + parts.setup + ' } };';
  var mod = new Function('document', 'setInterval', 'clearInterval', 'tryMount', 'findSubject',
    'MutationObserver', 'BWN', 'console', body)(
    doc, setIntervalStub, clearIntervalStub, tryMountStub, function () { return null; }, MO, BWN, quiet);

  return {
    env: env, rec: rec, doc: doc, schedule: mod.schedule, timer: mod.timer, setup: mod.setup,
    // Run the most recently started interval callback once, the way the browser would.
    tick: function () { var s = rec.set[rec.set.length - 1]; if (s) s.fn(); }
  };
}

// ---- probes: booleans only, so the same code asserts PASS on real source and FAIL on a mutant ----

function probeSingleTimer(parts) {
  var m = load(parts); m.env.modal = true; m.env.mount = false;
  m.schedule();
  var r = { started: m.rec.set.length === 1 && m.rec.set[0].ms === 150 && m.timer() === m.rec.set[0].id };
  m.schedule(); m.schedule();
  r.noSecond = m.rec.set.length === 1 && m.timer() === m.rec.set[0].id && m.rec.clear.length === 0;
  return r;
}
function probeModalAbsent(parts) {
  var m = load(parts); m.env.modal = false; m.env.mount = true;
  m.schedule();
  return { noTimer: m.rec.set.length === 0 && m.timer() === null, noTryMount: m.rec.tryMount === 0 };
}
function probeModalGone(parts) {
  var m = load(parts); m.env.modal = true;
  m.schedule();
  var id = m.timer();
  m.env.modal = false; m.tick();
  var r = { tickStops: m.rec.clear.length === 1 && m.rec.clear[0] === id && m.timer() === null };
  var n = load(parts); n.env.modal = true;
  n.schedule();
  var id2 = n.timer();
  n.env.modal = false; n.schedule();
  r.scheduleStops = n.rec.clear.length === 1 && n.rec.clear[0] === id2 && n.timer() === null;
  return r;
}
function probeMounted(parts) {
  var m = load(parts); m.env.modal = true; m.env.mount = false;
  m.schedule();                       // tryMount #1 -> false, interval starts
  var id = m.timer();
  m.tick();                           // tryMount #2 -> false, keeps polling
  var r = { keepsPolling: m.timer() === id && m.rec.clear.length === 0 && m.rec.tryMount === 2 };
  m.env.mount = true; m.tick();       // tryMount #3 -> true, stops
  r.tickStops = m.rec.clear.length === 1 && m.rec.clear[0] === id && m.timer() === null && m.rec.tryMount === 3;
  var n = load(parts); n.env.modal = true; n.env.mount = true;
  n.schedule();
  r.immediateNoTimer = n.rec.set.length === 0 && n.timer() === null && n.rec.tryMount === 1 && n.rec.clear.length === 0;
  return r;
}
function probeObserver(parts) {
  // Modal open + not mountable during setup, so the setup schedule() call is observable: each call
  // reaches tryMount() exactly once, and the first starts the interval.
  var m = load(parts); m.env.modal = true; m.env.mount = false;
  m.setup();
  var o = m.rec.observers;
  return {
    oneObserver: o.length === 1,
    onBody: o.length === 1 && o[0].observed.length === 1 && o[0].observed[0].target === m.doc.body,
    opts: o.length === 1 && JSON.stringify(o[0].observed[0].opts) === JSON.stringify({ childList: true, subtree: true }),
    callbackIsSchedule: o.length === 1 && o[0].cb === m.schedule,
    setupSchedules: m.rec.tryMount === 1 && m.rec.set.length === 1
  };
}

// ---- real source ----------------------------------------------------------------------------
var a = probeSingleTimer(PARTS), aj = JSON.stringify(a);
A.ok('single timer: modal open + not mountable starts one 150ms interval', a.started === true, aj);
A.ok('single timer: repeat schedule() while polling starts no second interval', a.noSecond === true, aj);

var b = probeModalAbsent(PARTS), bj = JSON.stringify(b);
A.ok('modal absent: no interval starts', b.noTimer === true, bj);
A.ok('modal absent: tryMount() is not called (modal checked first)', b.noTryMount === true, bj);

var c = probeModalGone(PARTS), cj = JSON.stringify(c);
A.ok('modal gone: a poll tick clears the interval and resets pollTimer', c.tickStops === true, cj);
A.ok('modal gone: schedule() clears the interval and resets pollTimer', c.scheduleStops === true, cj);

var d = probeMounted(PARTS), dj = JSON.stringify(d);
A.ok('mounted: ticks keep polling while tryMount() returns false', d.keepsPolling === true, dj);
A.ok('mounted: a tick whose tryMount() returns true clears the interval', d.tickStops === true, dj);
A.ok('mounted: first tryMount() true in schedule() -> no interval at all', d.immediateNoTimer === true, dj);

var e = probeObserver(PARTS), ej = JSON.stringify(e);
A.ok('observer: setup builds exactly one MutationObserver', e.oneObserver === true, ej);
A.ok('observer: it observes document.body', e.onBody === true, ej);
A.ok('observer: options are {childList:true, subtree:true}', e.opts === true, ej);
A.ok('observer: its callback is schedule() (guard-wrapped)', e.callbackIsSchedule === true, ej);
A.ok('observer: setup calls schedule() exactly once', e.setupSchedules === true, ej);
A.ok('observer: static source baseline - PO Approval module text contains no disconnect( call', REGION.indexOf('disconnect(') === -1);

// ---- negative controls: each reverts one pinned rule and must turn its probe red --------------
function mutate(key, from, to) {
  var p = {}; Object.keys(PARTS).forEach(function (k) { p[k] = PARTS[k]; });
  var s = p[key], i = s.indexOf(from);
  if (i === -1 || s.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET ABSENT OR NOT UNIQUE: ' + from);
  p[key] = s.slice(0, i) + to + s.slice(i + from.length);
  return p;
}
var m1 = probeSingleTimer(mutate('schedule', 'if (pollTimer) return;', ''));
A.ok('mutant: drop the one-interval guard -> single-timer probe goes red', m1.noSecond === false, JSON.stringify(m1));
var m2 = probeModalGone(mutate('schedule',
  "if (tryMount() || !document.querySelector('[data-testid=\"mail-to-modal-title\"]')) { stopPoll(); return; }",
  'if (tryMount()) { stopPoll(); return; }'));
A.ok('mutant: tick ignores a vanished modal -> modal-gone tick probe goes red', m2.tickStops === false, JSON.stringify(m2));
var m3 = probeMounted(mutate('schedule',
  "if (tryMount() || !document.querySelector('[data-testid=\"mail-to-modal-title\"]')) { stopPoll(); return; }",
  "if (!document.querySelector('[data-testid=\"mail-to-modal-title\"]')) { stopPoll(); return; }"));
A.ok('mutant: tick ignores a successful mount -> mounted tick probe goes red', m3.tickStops === false, JSON.stringify(m3));
var m4 = probeObserver(mutate('setup', 'schedule();', ''));
A.ok('mutant: setup skips its schedule() call -> setup probe goes red', m4.setupSchedules === false, JSON.stringify(m4));

A.finish();
