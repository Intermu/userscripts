// test-bidout-dock.js - node harness for the bid-out dock registration + the Core
// multi-tool ACT_TOOL mapping it unlocks (the "one bwn:dock:register line in bid-out"
// board item, closed 2026-08-02).
//
// WHAT SHIPPED, as sliced from source:
//   1. bwn-bid-out.user.js gained a "Dock presence" block: dynamic registration keyed on
//      woNumber() (register on WO detail, unregister once on leaving, re-emit on every
//      host ping as the TTL keepalive), plus a bwn:dock:open handler that opens the RFP
//      wizard (launchPanel({invite:true})) only on a WO page.
//   2. bwn-suite-core.user.js ACT_TOOL went multi-tool: a step key now maps to an ARRAY
//      of dock keys ('phase:schedule' / 'phase:intake' -> dispatch AND bidout), each
//      button gating on its OWN registrant via waDockAlive. Two call sites changed with
//      it: the render loop and the signature gate.
//
// Drives the REAL shipped bytes: slices both blocks out of the userscripts and runs them
// against a shared stub bus (same makeBusDoc for both, so the integration probe proves the
// two scripts interoperate over the real event shape). Nothing here proves a rail row or a
// checklist button RENDERS - that is the live dock test on the open-work board. What it
// proves: registration lifecycle, open gating, the ACT_TOOL shape, and that a bid-out
// registration is visible to Core's presence tracker.
//
// Every mutation below reverts one piece in the sliced source and asserts THIS harness
// goes red. mutate() throws if its target string is absent or not unique, so a mutation
// that silently fails to apply cannot masquerade as a passing negative control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bidout-dock.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var BID_SRC = path.join(__dirname, '..', 'bwn-bid-out.user.js');
var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}

var bidFull = readLF(BID_SRC);
var coreFull = readLF(CORE_SRC);

var BID_SECTION = slice(bidFull,
  '  // ---- Dock presence (bwn:dock:*)',
  '  // ---- Key management',
  'bid-out dock block');
var CORE_SECTION = slice(coreFull,
  '    // PINNED against the live registrant table',
  '    // IN-PAGE NAVIGATION.',
  'core ACT_TOOL block');

// Fails loudly rather than silently no-opping - a mutation that does not apply would
// otherwise read as "the negative control passed".
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- stub bus --------------------------------------------------------------------------
// One document per probe. dispatchEvent both LOGS the emission and DELIVERS it to every
// listener on that type, so the core slice sees what the bid-out slice emits.
function makeBusDoc() {
  var listeners = {};
  var log = [];
  return {
    log: log,
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: function (ev) {
      log.push({ type: ev.type, detail: ev.detail });
      (listeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); });
      return true;
    }
  };
}
function CustomEventStub(type, init) { this.type = type; this.detail = init && init.detail; }

function busEmit(doc, detail) { doc.dispatchEvent(new CustomEventStub('bwn:evt', { detail: detail })); }
function emitted(doc, id) {
  return doc.log.filter(function (e) { return e.type === 'bwn:evt' && e.detail && e.detail.id === id; });
}

// ---- probe: bid-out registration lifecycle ----------------------------------------------
function probeBidLifecycle(src) {
  var doc = makeBusDoc();
  var wo = { n: 381367 };
  var panelCalls = [];
  var ctx = {
    document: doc, CustomEvent: CustomEventStub, Date: Date, console: console,
    woNumber: function () { return wo.n; },
    launchPanel: function (opts) { panelCalls.push(opts || {}); }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  var r = {};

  // Nothing self-fires at load - registration waits for tick (path change) or a ping.
  r.quietAtLoad = emitted(doc, 'bwn:dock:register').length === 0;

  // tick's path-change branch calls dockReeval() directly.
  ctx.dockReeval();
  var regs = emitted(doc, 'bwn:dock:register');
  r.registersOnReeval = regs.length === 1;
  var d = regs[0] && regs[0].detail || {};
  r.registerShape = d.key === 'bidout' && d.label === 'Email RFP' && d.weight === 35 && !!d.icon && !!d.title;

  // Host ping re-emits (the TTL keepalive), idempotent by key.
  busEmit(doc, { id: 'bwn:dock:ping', hostId: 'h1' });
  busEmit(doc, { id: 'bwn:dock:host', hostId: 'h1', priority: 100, ts: 1 });
  r.reregistersOnPing = emitted(doc, 'bwn:dock:register').length === 3;

  // Leaving the WO unregisters ONCE; further pings off-WO stay silent.
  wo.n = null;
  ctx.dockReeval();
  busEmit(doc, { id: 'bwn:dock:ping', hostId: 'h1' });
  busEmit(doc, { id: 'bwn:dock:ping', hostId: 'h1' });
  var unregs = emitted(doc, 'bwn:dock:unregister');
  r.unregistersOnce = unregs.length === 1 && unregs[0].detail.key === 'bidout';
  r.noRegisterOffWo = emitted(doc, 'bwn:dock:register').length === 3;

  // Back onto a WO: presence returns.
  wo.n = 364040;
  busEmit(doc, { id: 'bwn:dock:ping', hostId: 'h1' });
  r.reappearsOnReturn = emitted(doc, 'bwn:dock:register').length === 4;

  // bwn:dock:open opens the invite wizard - own key + on a WO only.
  panelCalls.length = 0;
  busEmit(doc, { id: 'bwn:dock:open', key: 'bidout' });
  r.openOpensInvite = panelCalls.length === 1 && panelCalls[0].invite === true;
  busEmit(doc, { id: 'bwn:dock:open', key: 'ask' });
  r.foreignKeyIgnored = panelCalls.length === 1;
  wo.n = null;
  busEmit(doc, { id: 'bwn:dock:open', key: 'bidout' });
  r.openOffWoIgnored = panelCalls.length === 1;
  return r;
}

// ---- probe: core ACT_TOOL shape ----------------------------------------------------------
function probeCoreActTool(src) {
  var doc = makeBusDoc();
  var ctx = { document: doc, CustomEvent: CustomEventStub, Date: Date, console: console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  var r = {};
  var sched = ctx.actTool({ key: 'phase:schedule' });
  r.scheduleMapsBoth = !!sched && Array.isArray(sched.docks) &&
    sched.docks.indexOf('dispatch') !== -1 && sched.docks.indexOf('bidout') !== -1;
  var intake = ctx.actTool({ key: 'phase:intake' });
  r.intakeMapsBoth = !!intake && Array.isArray(intake.docks) &&
    intake.docks.indexOf('dispatch') !== -1 && intake.docks.indexOf('bidout') !== -1;
  var esc = ctx.actTool({ key: 'escalate' });
  r.escalateMapsAssist = !!esc && Array.isArray(esc.docks) && esc.docks.length === 1 && esc.docks[0] === 'assist';
  r.authoredIsNull = ctx.actTool({ key: 'escalate', authored: true }) === null;
  r.anchorIsNull = ctx.actTool({ key: 'phase:schedule', anchor: true }) === null;
  r.unmappedIsNull = ctx.actTool({ key: 'ecd' }) === null;
  // Every dock key any step can name has a label - a missing one renders 'Open tool…'.
  var allDocks = [];
  Object.keys(ctx.ACT_TOOL).forEach(function (k) { allDocks = allDocks.concat(ctx.ACT_TOOL[k]); });
  r.everyDockLabeled = allDocks.every(function (dk) { return typeof ctx.ACT_TOOL_LABEL[dk] === 'string' && ctx.ACT_TOOL_LABEL[dk].length > 0; });
  // Presence tracker wiring: register marks alive, unregister clears.
  busEmit(doc, { id: 'bwn:dock:register', key: 'bidout', label: 'Email RFP' });
  r.aliveAfterRegister = ctx.waDockAlive('bidout') === true;
  busEmit(doc, { id: 'bwn:dock:unregister', key: 'bidout' });
  r.deadAfterUnregister = ctx.waDockAlive('bidout') === false;
  return r;
}

// ---- probe: the two slices interoperate on one bus ---------------------------------------
function probeIntegration(bidSrc, coreSrc) {
  var doc = makeBusDoc();
  var wo = { n: 381367 };
  var ctxCore = { document: doc, CustomEvent: CustomEventStub, Date: Date, console: console };
  vm.createContext(ctxCore);
  vm.runInContext(coreSrc, ctxCore);
  var ctxBid = {
    document: doc, CustomEvent: CustomEventStub, Date: Date, console: console,
    woNumber: function () { return wo.n; },
    launchPanel: function () { }
  };
  vm.createContext(ctxBid);
  vm.runInContext(bidSrc, ctxBid);
  var r = {};
  r.deadBeforePing = ctxCore.waDockAlive('bidout') === false;
  busEmit(doc, { id: 'bwn:dock:ping', hostId: 'h1' });
  r.aliveAfterPing = ctxCore.waDockAlive('bidout') === true;
  // The exact expression the render loop and signature gate evaluate:
  var tl = ctxCore.actTool({ key: 'phase:schedule' });
  var live = tl.docks.filter(function (dk) { return ctxCore.waDockAlive(dk); });
  r.onlyLiveToolRenders = live.length === 1 && live[0] === 'bidout';   // dispatch never registered here
  wo.n = null;
  ctxBid.dockReeval();
  r.deadAfterLeaving = ctxCore.waDockAlive('bidout') === false;
  return r;
}

// ---- probe: structural asserts on the FULL core file --------------------------------------
function probeCoreStructure(full) {
  var r = {};
  r.renderLoopsDocks = full.indexOf('tool.docks.forEach(function (dk)') !== -1;
  r.renderGatesPerDock = full.indexOf('if (!waDockAlive(dk)) return;') !== -1;
  r.signatureJoinsLiveDocks = full.indexOf("tl.docks.filter(waDockAlive).join(',')") !== -1;
  // No stragglers on the old single-dock shape (`.dock` without the `s`).
  r.noSingleDockRefs = !/\b(?:tool|tl)\.dock\b(?!s)/.test(full);
  return r;
}

// ---- run: real source ---------------------------------------------------------------------
console.log('bid-out dock registration + Core multi-tool ACT_TOOL - real source');

var b = probeBidLifecycle(BID_SECTION);
A.ok('quiet at load (registration waits for tick/ping)', b.quietAtLoad, JSON.stringify(b));
A.ok('dockReeval on a WO emits one register', b.registersOnReeval, JSON.stringify(b));
A.ok('register carries key=bidout label="Email RFP" weight=35 icon title', b.registerShape, JSON.stringify(b));
A.ok('host + ping each re-emit register (TTL keepalive)', b.reregistersOnPing, JSON.stringify(b));
A.ok('leaving the WO unregisters exactly once', b.unregistersOnce, JSON.stringify(b));
A.ok('off-WO pings emit no register', b.noRegisterOffWo, JSON.stringify(b));
A.ok('returning to a WO re-registers', b.reappearsOnReturn, JSON.stringify(b));
A.ok('bwn:dock:open key=bidout opens launchPanel({invite:true})', b.openOpensInvite, JSON.stringify(b));
A.ok('foreign open key ignored', b.foreignKeyIgnored, JSON.stringify(b));
A.ok('open off a WO page ignored', b.openOffWoIgnored, JSON.stringify(b));

var c = probeCoreActTool(CORE_SECTION);
A.ok('phase:schedule maps dispatch AND bidout', c.scheduleMapsBoth, JSON.stringify(c));
A.ok('phase:intake maps dispatch AND bidout', c.intakeMapsBoth, JSON.stringify(c));
A.ok('escalate still maps assist alone', c.escalateMapsAssist, JSON.stringify(c));
A.ok('authored item yields no tool', c.authoredIsNull, JSON.stringify(c));
A.ok('anchor yields no tool', c.anchorIsNull, JSON.stringify(c));
A.ok('unmapped key yields no tool', c.unmappedIsNull, JSON.stringify(c));
A.ok('every mapped dock key has a label', c.everyDockLabeled, JSON.stringify(c));
A.ok('waDockAlive true after a bidout register', c.aliveAfterRegister, JSON.stringify(c));
A.ok('waDockAlive false after unregister', c.deadAfterUnregister, JSON.stringify(c));

var g = probeIntegration(BID_SECTION, CORE_SECTION);
A.ok('integration: dead before any ping', g.deadBeforePing, JSON.stringify(g));
A.ok('integration: one ping makes bidout visible to Core', g.aliveAfterPing, JSON.stringify(g));
A.ok('integration: render expression yields bidout only (dispatch not live)', g.onlyLiveToolRenders, JSON.stringify(g));
A.ok('integration: leaving the WO clears presence in Core', g.deadAfterLeaving, JSON.stringify(g));

var s = probeCoreStructure(coreFull);
A.ok('render site loops tool.docks', s.renderLoopsDocks, JSON.stringify(s));
A.ok('render site gates per dock on waDockAlive', s.renderGatesPerDock, JSON.stringify(s));
A.ok('signature gate joins live docks', s.signatureJoinsLiveDocks, JSON.stringify(s));
A.ok('no leftover single-dock (.dock) references', s.noSingleDockRefs, JSON.stringify(s));

// ---- mutations: revert one piece each, assert the harness goes red -------------------------
console.log('\nmutations (each must redden its probe)');

// M1: unregister branch never fires - the row would linger on the list page until TTL.
var m1 = probeBidLifecycle(mutate(BID_SECTION,
  '    } else if (dockRegistered) {',
  '    } else if (false) {'));
A.ok('M1 killing the unregister branch breaks the once-only unregister', m1.unregistersOnce === false, JSON.stringify(m1));

// M2: open handler loses its WO gate - the wizard would open on the list page.
var m2 = probeBidLifecycle(mutate(BID_SECTION,
  "else if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY && woNumber()) launchPanel({ invite: true });",
  "else if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) launchPanel({ invite: true });"));
A.ok('M2 dropping the woNumber() gate breaks the off-WO open probe', m2.openOffWoIgnored === false, JSON.stringify(m2));

// M3: ACT_TOOL reverted to the old single-string map - every array consumer breaks.
var m3fail = false;
try {
  var m3 = probeCoreActTool(mutate(CORE_SECTION,
    "var ACT_TOOL = { 'phase:schedule': ['dispatch', 'bidout'], 'phase:intake': ['dispatch', 'bidout'], escalate: ['assist'] };",
    "var ACT_TOOL = { 'phase:schedule': 'dispatch', 'phase:intake': 'dispatch', escalate: 'assist' };"));
  m3fail = m3.scheduleMapsBoth === false;
} catch (e) { m3fail = true; }   // a throw is also a red harness
A.ok('M3 reverting ACT_TOOL to single-string breaks the array shape', m3fail, 'probe stayed green');

// M4: registration key drifts - Core stops seeing bid-out entirely.
var m4 = probeIntegration(mutate(BID_SECTION,
  "key: DOCK_KEY, label: 'Email RFP'",
  "key: 'bidout-x', label: 'Email RFP'"), CORE_SECTION);
A.ok('M4 a drifted register key is invisible to Core presence', m4.aliveAfterPing === false, JSON.stringify(m4));

console.log('\n(lifecycle + mapping + integration x real source, 4 mutations. Nothing here proves a rail');
console.log(' row or checklist button RENDERS - that is the live dock test on the open-work board.)');
A.finish();
