// test-route-helper.js - node harness for Core's central route/lifecycle helper (RM-B4).
//
// WHAT THIS PROVES:
//   The suite had ~12 body-observers + a dozen hand-pasted history.pushState/popstate trios, each
//   re-deriving "did location.pathname change" on its own. BWN.onRoute (window.bwnOnRoute) folds the
//   history/pushState/replaceState/popstate hook into ONE patch with a trailing debounce and a
//   pathname diff, shared by every consumer. This harness slices the SHIPPED bytes of that helper
//   out of bwn-suite-core.user.js and runs them against a fake window/history/location with a
//   CONTROLLABLE fake timer (a headless harness cannot trust real setTimeout timing - see
//   wiki/headless-harness-cannot-time.md), then asserts:
//     - a route change fires each subscriber exactly once (to, from);
//     - a burst of pushStates coalesces to ONE trailing fire (debounce);
//     - a same-pathname change fires NOTHING (the diff dedup => no double-inject);
//     - the history patch is installed EXACTLY once no matter how many subscribers (the "observer
//       count drops" win: one popstate listener + one wrap, not one per consumer);
//     - unsubscribe stops delivery (no listener leak);
//     - one throwing subscriber never blocks the others;
//     - popstate is wired, not just pushState.
//
//   Every negative control reverts ONE guarantee in the sliced source and asserts THIS harness goes
//   red; mutate() throws if its target is absent or not unique, so a control that silently fails to
//   apply cannot masquerade as green.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-route-helper.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var CORE = path.join(__dirname, '..', 'bwn-suite-core.user.js');
function coreSrc() { return fs.readFileSync(CORE, 'utf8').replace(/\r\n/g, '\n'); }

// ---- slice the shipped helper out of Core ---------------------------------------------------
var START = '// BWN-ROUTE START (RM-B4;';
var END = '// BWN-ROUTE END (RM-B4)';
function sliceHelper(src) {
  var a = src.indexOf(START), b = src.indexOf(END, a === -1 ? 0 : a);
  if (a === -1 || b === -1) throw new Error('BWN-ROUTE markers not found in Core');
  return src.slice(a, b + END.length);
}

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- fake environment (controllable timer) --------------------------------------------------
function makeEnv(startPath) {
  var loc = { pathname: startPath || '/a' };
  var timers = [], nextId = 1, timerCalls = 0;
  var popstateCbs = [], popstateListeners = 0;
  function setTimeout_(fn) { timerCalls++; var id = nextId++; timers.push({ id: id, fn: fn }); return id; }
  function clearTimeout_(id) { for (var i = 0; i < timers.length; i++) { if (timers[i].id === id) { timers.splice(i, 1); return; } } }
  function flush() { var t = timers.slice(); timers.length = 0; t.forEach(function (x) { x.fn(); }); }
  var history_ = {
    pushState: function (s, t, url) { if (url != null) loc.pathname = String(url); },
    replaceState: function (s, t, url) { if (url != null) loc.pathname = String(url); }
  };
  var window_ = { addEventListener: function (type, cb) { if (type === 'popstate') { popstateCbs.push(cb); popstateListeners++; } } };
  var BWN = {};
  return {
    BWN: BWN, location: loc, history: history_, window: window_,
    setTimeout: setTimeout_, clearTimeout: clearTimeout_,
    flush: flush,
    nav: function (p) { history_.pushState({}, '', p); },       // a pushState navigation (goes through the patch)
    popstate: function (p) { loc.pathname = p; popstateCbs.forEach(function (cb) { cb(); }); },
    stats: function () { return { timerCalls: timerCalls, popstateListeners: popstateListeners }; }
  };
}

function buildOnRoute(src, env) {
  var body = src + '\n; return BWN.onRoute;';
  var f = new Function('BWN', 'location', 'history', 'window', 'setTimeout', 'clearTimeout', body);
  return f(env.BWN, env.location, env.history, env.window, env.setTimeout, env.clearTimeout);
}

// ---- property probes (return true when the guarantee holds) ----------------------------------
function propFiresOnce(src) {
  var env = makeEnv('/a'), onRoute = buildOnRoute(src, env), calls = [];
  onRoute(function (to, from) { calls.push([to, from]); });
  env.nav('/b'); env.flush();
  return calls.length === 1 && calls[0][0] === '/b' && calls[0][1] === '/a';
}
function propBurstCoalesces(src) {
  var env = makeEnv('/a'), onRoute = buildOnRoute(src, env), calls = [];
  onRoute(function (to, from) { calls.push([to, from]); });
  env.nav('/b'); env.nav('/c'); env.nav('/d');   // three pushStates before any flush
  env.flush();
  return calls.length === 1 && calls[0][0] === '/d' && calls[0][1] === '/a';
}
function propNoFireSamePath(src) {
  var env = makeEnv('/a'), onRoute = buildOnRoute(src, env), n = 0;
  onRoute(function () { n++; });
  env.nav('/b'); env.flush();            // n -> 1
  env.nav('/b'); env.flush();            // SAME pathname: must not fire again
  return n === 1;
}
function propSinglePatch(src) {
  var env = makeEnv('/a'), onRoute = buildOnRoute(src, env);
  onRoute(function () { }); onRoute(function () { });   // two subscribers
  var s = env.stats();
  return s.popstateListeners === 1;      // ONE popstate listener regardless of subscriber count
}
function propUnsubStops(src) {
  var env = makeEnv('/a'), onRoute = buildOnRoute(src, env), n = 0;
  var unsub = onRoute(function () { n++; });
  unsub();
  env.nav('/b'); env.flush();
  return n === 0;
}
function propThrowerIsolated(src) {
  var env = makeEnv('/a'), onRoute = buildOnRoute(src, env), good = 0;
  onRoute(function () { throw new Error('bad subscriber'); });
  onRoute(function () { good++; });
  env.nav('/b'); env.flush();
  return good === 1;
}
function propPopstateWired(src) {
  var env = makeEnv('/a'), onRoute = buildOnRoute(src, env), n = 0;
  onRoute(function () { n++; });
  env.popstate('/b'); env.flush();
  return n === 1;
}

// ---- clean build: every guarantee holds ------------------------------------------------------
var SRC = sliceHelper(coreSrc());
A.ok('a route change fires each subscriber once (to, from)', propFiresOnce(SRC));
A.ok('a burst of pushStates coalesces to one trailing fire', propBurstCoalesces(SRC));
A.ok('a same-pathname change fires nothing (dedup / no double-inject)', propNoFireSamePath(SRC));
A.ok('history is patched exactly once (one popstate listener for N subscribers)', propSinglePatch(SRC));
A.ok('unsubscribe stops delivery (no listener leak)', propUnsubStops(SRC));
A.ok('one throwing subscriber never blocks the others', propThrowerIsolated(SRC));
A.ok('popstate is wired, not only pushState', propPopstateWired(SRC));

// timerCalls sanity: two subscribers, then ONE nav => exactly one debounce schedule (proves the
// wrap is not nested). Used as the measurable core of the NC below.
(function () {
  var env = makeEnv('/a'), onRoute = buildOnRoute(SRC, env);
  onRoute(function () { }); onRoute(function () { });
  A.eq('no timer scheduled just by subscribing', env.stats().timerCalls, 0);
  env.nav('/x');
  A.eq('one nav schedules exactly one debounce (single wrap)', env.stats().timerCalls, 1);
})();

// ---- negative controls: revert a guarantee, prove the harness catches it ----------------------
// NC1: remove the pathname-diff dedup -> a same-path change now fires (double-inject risk).
var NC1 = mutate(SRC, 'if (to === from) return;', '/* dedup removed */');
A.ok('NC1 red: without the dedup, a same-path change fires again', propNoFireSamePath(NC1) === false);

// NC2: remove the idempotent-install guard -> a second subscriber re-patches history (nested wrap,
// a second popstate listener) - the exact per-consumer duplication this slice removes.
var NC2 = mutate(SRC, 'if (_routePatched) return;', '/* guard removed */');
A.ok('NC2 red: without the guard, two subscribers install two popstate listeners', propSinglePatch(NC2) === false);
(function () {
  var env = makeEnv('/a'), onRoute = buildOnRoute(NC2, env);
  onRoute(function () { }); onRoute(function () { });
  env.nav('/x');
  A.ok('NC2 red: without the guard, one nav double-schedules (nested wrap)', env.stats().timerCalls === 2);
})();

// NC3: neuter unsubscribe -> a removed subscriber still fires (listener leak).
var NC3 = mutate(SRC,
  'var i = _routeSubs.indexOf(cb);\n      if (i !== -1) _routeSubs.splice(i, 1);',
  '/* leak: unsubscribe does nothing */');
A.ok('NC3 red: with a no-op unsubscribe, a removed subscriber still fires', propUnsubStops(NC3) === false);

// ---- proof consumer: bwn-kanban's kbRouteHooks (the migrated route detection) -----------------
// Slices kanban's flag-gated route-hook helper and proves: flag ON + Core's helper present => it
// subscribes to the central helper and does NOT patch history itself (the "observer count drops"
// win for the migrated consumer); flag OFF, helper absent, or helper throwing => it installs the
// legacy popstate + pushState/replaceState trio, byte-for-byte the old behavior (fail-safe).
var KANBAN = path.join(__dirname, '..', 'bwn-kanban.user.js');
function kanbanKbRouteHooks() {
  var t = fs.readFileSync(KANBAN, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf('function kbRouteHooks(onChange) {');
  var b = t.indexOf('function boot()', a);
  if (a === -1 || b === -1) throw new Error('kbRouteHooks not found in bwn-kanban.user.js');
  return t.slice(a, b);
}
function buildKb(src, env) {
  var body = src + '\n; return kbRouteHooks;';
  var f = new Function('BWN_MODULES', 'window', 'history', body);
  return f(env.BWN_MODULES, env.window, env.history);
}
function kbEnv(flag, opts) {
  opts = opts || {};
  var calls = { central: 0, addEventListener: 0 };
  var win = { addEventListener: function (type) { if (type === 'popstate') calls.addEventListener++; } };
  if (opts.helper === 'present') win.bwnOnRoute = function () { calls.central++; };
  else if (opts.helper === 'throws') win.bwnOnRoute = function () { throw new Error('helper boom'); };
  var origPush = function orig_push() { };
  var hist = { pushState: origPush, replaceState: function orig_repl() { } };
  return {
    BWN_MODULES: { routeHelper: flag }, window: win, history: hist,
    calls: calls, origPush: origPush,
    patchedHistory: function () { return hist.pushState !== origPush; }
  };
}
var KBSRC = kanbanKbRouteHooks();
(function () {
  var env = kbEnv(true, { helper: 'present' }), fn = buildKb(KBSRC, env);
  fn(function () { });
  A.eq('flag ON + helper present: subscribes to the central helper once', env.calls.central, 1);
  A.ok('flag ON + helper present: kanban does NOT patch history itself', env.patchedHistory() === false);
  A.eq('flag ON + helper present: kanban adds no popstate listener of its own', env.calls.addEventListener, 0);
})();
(function () {
  var env = kbEnv(false, { helper: 'present' }), fn = buildKb(KBSRC, env);
  fn(function () { });
  A.eq('flag OFF: does not call the central helper', env.calls.central, 0);
  A.ok('flag OFF: installs the legacy history patch (current behavior)', env.patchedHistory() === true);
  A.eq('flag OFF: installs the legacy popstate listener', env.calls.addEventListener, 1);
})();
(function () {
  var env = kbEnv(true, {}), fn = buildKb(KBSRC, env);   // flag ON but Core helper absent
  fn(function () { });
  A.ok('flag ON but helper absent: fails safe to the legacy patch', env.patchedHistory() === true);
})();
(function () {
  var env = kbEnv(true, { helper: 'throws' }), fn = buildKb(KBSRC, env);
  fn(function () { });
  A.ok('flag ON but helper throws: fails safe to the legacy patch', env.patchedHistory() === true);
})();
// NC4: break the flag gate so kanban always uses the central helper -> the flag-OFF (legacy) check
// must catch it.
var KBNC = mutate(KBSRC,
  "if (BWN_MODULES.routeHelper === true && typeof window.bwnOnRoute === 'function') {",
  "if (typeof window.bwnOnRoute === 'function') {");
(function () {
  var env = kbEnv(false, { helper: 'present' }), fn = buildKb(KBNC, env);
  fn(function () { });
  A.ok('NC4 red: ungated, kanban skips the legacy patch even with the flag off', env.patchedHistory() === false);
})();

// ---- phased follow-on consumers: low-gp / notes / proposal-actions ----------------------------
// The RM-B4 phased follow-up migrates three MORE @grant-none, route-scoped consumers off their own
// per-mutation body observer onto Core's window.bwnOnRoute (behind the same routeHelper flag). Each
// exposes a flag-gated `<xx>RouteHooks(onChange)`; this section slices each one and proves the same
// contract as kanban above PLUS the observer-count-drop and recovery-net specifics:
//   flag ON + helper present => subscribes to the central helper ONCE and creates NO body observer
//     (the "fewer body observers" win); low-gp/notes also start ONE steady recovery-poll interval,
//     proposal-actions starts none (its permanent 900ms poll lives outside the helper);
//   flag OFF / helper absent / helper throws => installs the legacy body observer, no central call,
//     no recovery interval (byte-for-byte the old behavior; fail-safe);
//   NC: break the flag gate => the flag-OFF check sees NO observer and goes red.
function sliceFn(file, startNeedle, endNeedle) {
  var t = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf(startNeedle), b = t.indexOf(endNeedle, a === -1 ? 0 : a);
  if (a === -1 || b === -1) throw new Error(startNeedle + ' not found in ' + file);
  return t.slice(a, b);
}
function consumerEnv(flag, opts) {
  opts = opts || {};
  var calls = { central: 0, popstate: 0, observers: 0, intervals: 0 };
  var win = { addEventListener: function (type) { if (type === 'popstate') calls.popstate++; } };
  if (opts.helper === 'present') win.bwnOnRoute = function () { calls.central++; };
  else if (opts.helper === 'throws') win.bwnOnRoute = function () { throw new Error('helper boom'); };
  function FakeMO() { calls.observers++; this.observe = function () { }; this.disconnect = function () { }; }
  return {
    BWN_MODULES: { routeHelper: flag }, window: win, MutationObserver: FakeMO, document: { body: {} },
    setInterval: function () { calls.intervals++; return 0; }, setTimeout: function () { return 0; }, clearTimeout: function () { },
    calls: calls
  };
}
function buildConsumer(src, fnName, env) {
  var body = src + '\n; return ' + fnName + ';';
  var f = new Function('BWN_MODULES', 'window', 'MutationObserver', 'document', 'setInterval', 'setTimeout', 'clearTimeout', 'mount', 'tick', 'injectDropdown', body);
  var noop = function () { };
  return f(env.BWN_MODULES, env.window, env.MutationObserver, env.document, env.setInterval, env.setTimeout, env.clearTimeout, noop, noop, noop);
}
// name, file, fn name, slice-end needle, expected recovery-interval count when flag ON
var CONSUMERS = [
  { name: 'low-gp', file: 'bwn-low-gp.user.js', fn: 'lowgpRouteHooks', end: 'lowgpRouteHooks(schedule);', recoveryIntervals: 1 },
  { name: 'notes', file: 'bwn-notes.user.js', fn: 'notesRouteHooks', end: 'notesRouteHooks(schedule);', recoveryIntervals: 1 },
  { name: 'proposal-actions', file: 'bwn-proposal-actions.user.js', fn: 'paRouteHooks', end: 'paRouteHooks(injectDropdown);', recoveryIntervals: 0 }
];
CONSUMERS.forEach(function (c) {
  var SRC = sliceFn(c.file, 'function ' + c.fn + '(onChange) {', c.end);
  // flag ON + helper present
  (function () {
    var env = consumerEnv(true, { helper: 'present' }), fn = buildConsumer(SRC, c.fn, env);
    fn(function () { });
    A.eq(c.name + ' flag ON + helper present: subscribes to the central helper once', env.calls.central, 1);
    A.eq(c.name + ' flag ON + helper present: creates NO body observer (fewer observers)', env.calls.observers, 0);
    A.eq(c.name + ' flag ON + helper present: starts the expected recovery-poll count', env.calls.intervals, c.recoveryIntervals);
    A.eq(c.name + ' flag ON + helper present: adds no popstate listener of its own', env.calls.popstate, 0);
  })();
  // flag OFF => legacy observer, no central, no recovery interval
  (function () {
    var env = consumerEnv(false, { helper: 'present' }), fn = buildConsumer(SRC, c.fn, env);
    fn(function () { });
    A.eq(c.name + ' flag OFF: does not call the central helper', env.calls.central, 0);
    A.eq(c.name + ' flag OFF: installs exactly one legacy body observer', env.calls.observers, 1);
    A.eq(c.name + ' flag OFF: starts no recovery interval (legacy)', env.calls.intervals, 0);
  })();
  // flag ON but helper absent => fail-safe to legacy observer
  (function () {
    var env = consumerEnv(true, {}), fn = buildConsumer(SRC, c.fn, env);
    fn(function () { });
    A.eq(c.name + ' flag ON but helper absent: fails safe to the legacy observer', env.calls.observers, 1);
    A.eq(c.name + ' flag ON but helper absent: no central call', env.calls.central, 0);
  })();
  // flag ON but helper throws => fail-safe to legacy observer
  (function () {
    var env = consumerEnv(true, { helper: 'throws' }), fn = buildConsumer(SRC, c.fn, env);
    fn(function () { });
    A.eq(c.name + ' flag ON but helper throws: fails safe to the legacy observer', env.calls.observers, 1);
  })();
  // NC: break the flag gate => ungated, the flag-OFF path must skip the observer (goes red here).
  var NC = mutate(SRC,
    "if (BWN_MODULES.routeHelper === true && typeof window.bwnOnRoute === 'function') {",
    "if (typeof window.bwnOnRoute === 'function') {");
  (function () {
    var env = consumerEnv(false, { helper: 'present' }), fn = buildConsumer(NC, c.fn, env);
    fn(function () { });
    A.ok(c.name + ' NC red: ungated, skips the legacy observer even with the flag off', env.calls.observers === 0);
  })();
});

A.finish();
