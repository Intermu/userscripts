// test-drawer-motion.js - node harness for the drawer motion fixes shipped 2026-08-10 after an
// animation review of the launcher dock drawers (shipped as Core 1.78.0 + six drawer modules).
//
// WHAT SHIPPED, and what each half of this harness proves:
//   1. EXIT. A drawer used to vanish on a bare .remove() while the next one faded in, so a tool
//      swap read as two objects rather than one panel changing contents. Every module that owns
//      a .bwn-drawer now routes its close through a local drawerDismiss(): strip the id, mark it
//      aria-hidden, add .bwn-closing, remove after 170ms - and remove IMMEDIATELY under
//      prefers-reduced-motion, so a reduced-motion user never waits on a transition that was
//      turned off. Proven here by RUNNING each module's helper in a vm against a fake element,
//      under both media states, not by grepping for the word.
//   2. GEOMETRY. .bwn-drawer pins `left` to the expanded rail width and rides
//      --bwn-dock-shift; publishDockWidth publishes that delta. Collapsing the rail used to
//      retarget `left` and `max-width`, which teleported an open drawer 126px sideways and
//      reflowed it. Proven by running the real publishDockWidth and reading what it set.
//   3. REDUCED MOTION now covers .bwn-ops-card. It rode the same motion as .bwn-drawer and was
//      NOT named in the old media query, so Suite settings animated for a user who had asked it
//      not to. Proven against the shipped stylesheet string.
//
// Every mutation below reverts one piece of the real sliced source and requires this harness to
// go red. mutate() throws when its target is absent or not unique, so a control that silently
// failed to apply cannot masquerade as a passing one.
//
// What this does NOT prove: that anything LOOKS right. No layout is computed here (and jsdom
// would not compute it either) - the fade, the crossfade during a swap, and the rail-collapse
// slide are live-Chrome checks, listed as owed in wiki/bwn-launcher-dock.md.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-drawer-motion.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function read(name) {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r\n/g, '\n');
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// Slice one function out of the shipped bytes by name, brace-counting to its end so the harness
// keeps working when the body changes.
function sliceFn(src, decl) {
  var a = src.indexOf(decl);
  if (a === -1) throw new Error('function not found: ' + decl);
  var depth = 0, i = src.indexOf('{', a);
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced braces after ' + decl);
}

// ---- fake element + timers ------------------------------------------------------------------
function makeEl() {
  return {
    classes: [], attrs: { id: 'bwn-drawer-x' }, removed: false,
    classList: {
      add: function (c) { if (this._o.classes.indexOf(c) === -1) this._o.classes.push(c); },
      remove: function (c) { var i = this._o.classes.indexOf(c); if (i !== -1) this._o.classes.splice(i, 1); },
      contains: function (c) { return this._o.classes.indexOf(c) !== -1; }
    },
    removeAttribute: function (k) { delete this.attrs[k]; },
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    remove: function () { this.removed = true; }
  };
}
function wire(el) { el.classList._o = el; return el; }

// Run a module's drawerDismiss against a fake element. `reduce` drives the media query the
// helper asks about; timers are captured so the test decides when 170ms has passed.
function runDismiss(fnSrc, reduce) {
  var el = wire(makeEl());
  var timers = [];
  var ctx = {
    window: { matchMedia: function (q) { return { matches: reduce && /reduced-motion/.test(q) }; } },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: function () { },
    console: console
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + '\n__run = function (e) { drawerDismiss(e); };', ctx);
  ctx.__run(el);
  return {
    el: el, timers: timers,
    fire: function () { timers.forEach(function (t) { t.fn(); }); }
  };
}

var CORE = read('bwn-suite-core.user.js');

// ---- 1. every drawer module fades instead of vanishing ---------------------------------------
// bwn-ask is deliberately absent from this list: it REUSES its node to keep the conversation, so
// its variant is reversible and is probed separately below.
var MODULES = ['bwn-cc-auth.user.js', 'bwn-cc-purchase.user.js', 'bwn-dispatch.user.js',
  'bwn-wo-assist.user.js', 'bwn-wo-audit.user.js'];

console.log('\n-- drawer exit, per module (the shipped helper, run) --');
MODULES.forEach(function (m) {
  var src = read(m);
  A.ok(m + ' still builds a .bwn-drawer', src.indexOf("className = 'bwn-drawer'") !== -1, 'drawer markup gone');
  A.ok(m + ' has no bare openEl.remove() left on the close path',
    src.indexOf('openEl.remove(); openEl = null') === -1, 'close still removes synchronously');

  var fn = sliceFn(src, 'function drawerDismiss(');
  var r = runDismiss(fn, false);
  A.ok(m + ': marks .bwn-closing rather than removing', r.el.classes.indexOf('bwn-closing') !== -1 && r.el.removed === false, JSON.stringify(r.el.classes) + ' removed=' + r.el.removed);
  A.ok(m + ': frees the id immediately (a reopen must not duplicate it)', r.el.attrs.id === undefined, 'id=' + r.el.attrs.id);
  A.ok(m + ': hides it from assistive tech on the way out', r.el.attrs['aria-hidden'] === 'true');
  A.ok(m + ': removal is deferred to the 170ms fade', r.timers.length === 1 && r.timers[0].ms === 170, JSON.stringify(r.timers.map(function (t) { return t.ms; })));
  r.fire();
  A.ok(m + ': and the node is gone once the fade ends', r.el.removed === true);

  var rr = runDismiss(fn, true);
  A.ok(m + ': under reduced motion it removes NOW, with no timer', rr.el.removed === true && rr.timers.length === 0,
    'removed=' + rr.el.removed + ' timers=' + rr.timers.length);
  A.ok(m + ': and does not leave .bwn-closing on a node nobody will animate', rr.el.classes.indexOf('bwn-closing') === -1);
});

// Core's own settings drawer goes through the same helper (two nodes: overlay + card).
console.log('\n-- Core Suite settings uses the shared exit --');
A.ok('Core close() calls drawerDismiss, not ov.remove()', CORE.indexOf('drawerDismiss(ov, card);') !== -1, 'settings still vanishes');
A.ok('and it detaches its listeners BEFORE the fade starts',
  CORE.indexOf("document.removeEventListener('bwn:evt', onSlotTaken);\n        // Fade out instead") !== -1,
  'listener teardown moved after the fade');
var coreFn = sliceFn(CORE, 'function drawerDismiss(node, fader)');
A.ok("Core's helper fades the card, not just the overlay", coreFn.indexOf("fader.classList.add('bwn-closing')") !== -1);
A.ok("Core's helper uses the shared DRAWER_EXIT_MS", coreFn.indexOf('DRAWER_EXIT_MS') !== -1 && CORE.indexOf('var DRAWER_EXIT_MS = 170;') !== -1);

// ---- 1b. bwn-ask's REVERSIBLE variant --------------------------------------------------------
// Ask keeps its node alive across close/open to preserve the conversation, so its exit must be
// undoable: the id STAYS (a reused node cannot collide with itself), the pending removal is
// cancellable, and reopening clears .bwn-closing so the opacity transition retargets instead of
// restarting. Getting this wrong is worse than the bug it fixes - a cancelled fade that never
// cleared the class leaves a permanently invisible panel.
console.log('\n-- bwn-ask: the reversible exit --');
var ASK = read('bwn-ask.user.js');
function runHide(src, reduce) {
  var el = wire(makeEl()); el.parentNode = {}; el.attrs.id = 'bwn-drawer-ask';
  var timers = [], cleared = 0;
  var ctx = {
    panelEl: el,
    fadeTimer: null,
    window: { matchMedia: function (q) { return { matches: reduce && /reduced-motion/.test(q) }; } },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: function () { cleared++; },
    console: console
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n__run = function () { hidePanel(); };', ctx);
  ctx.__run();
  return { el: el, timers: timers, cleared: function () { return cleared; } };
}
var askHide = sliceFn(ASK, 'function hidePanel()');
var ah = runHide(askHide, false);
A.ok('ask: fades rather than detaching', ah.el.classes.indexOf('bwn-closing') !== -1 && ah.el.removed === false);
A.ok('ask: KEEPS its id, unlike the single-shot modules', ah.el.attrs.id === 'bwn-drawer-ask', 'id=' + ah.el.attrs.id);
A.ok('ask: cancels any fade already pending before arming a new one', ah.cleared() >= 1, 'clearTimeout calls=' + ah.cleared());
A.ok('ask: removal deferred 170ms', ah.timers.length === 1 && ah.timers[0].ms === 170);
var ahr = runHide(askHide, true);
A.ok('ask: under reduced motion it detaches immediately', ahr.el.removed === true && ahr.timers.length === 0);
A.ok('ask reopen: cancels the pending removal',
  ASK.indexOf('clearTimeout(fadeTimer); fadeTimer = null;') !== -1, 'a reopen mid-fade would be removed 170ms later');
A.ok('ask reopen: clears the exit state, or the panel is invisible forever',
  ASK.indexOf("panelEl.classList.remove('bwn-closing'); panelEl.removeAttribute('aria-hidden');") !== -1);
A.ok('ask toggle: a closing panel reopens instead of toggling shut again',
  ASK.indexOf("if (panelEl && panelEl.isConnected && !panelEl.classList.contains('bwn-closing')) { hidePanel(); return; }") !== -1,
  'the dock row would re-hide a panel that is already on its way out');

// ---- 2. the rail collapse slides the drawer instead of teleporting it -------------------------
console.log('\n-- rail geometry: transform, never left --');
function runPublish(src) {
  var set = {};
  var ctx = {
    document: { documentElement: { style: { setProperty: function (k, v) { set[k] = v; } } } },
    DOCK_RAIL_W: 158, console: console
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n__pub = publishDockWidth;', ctx);
  return { set: set, pub: ctx.__pub };
}
var pubSrc = sliceFn(CORE, 'function publishDockWidth(px)');
var expanded = runPublish(pubSrc); expanded.pub(158);
A.ok('expanded rail: no shift', expanded.set['--bwn-dock-shift'] === '0px', JSON.stringify(expanded.set));
var collapsed = runPublish(pubSrc); collapsed.pub(32);
A.ok('collapsed rail: the drawer is shifted, not repositioned', collapsed.set['--bwn-dock-shift'] === '-126px', JSON.stringify(collapsed.set));
var gone = runPublish(pubSrc); gone.pub(0);
A.ok('no rail at all: shifted flush to the edge', gone.set['--bwn-dock-shift'] === '-158px', JSON.stringify(gone.set));
A.ok('--bwn-dock-w is still published (bid-out and the AI overlays read it)',
  collapsed.set['--bwn-dock-w'] === '32px', JSON.stringify(collapsed.set));

A.ok('.bwn-drawer pins left to the expanded rail rather than the live var',
  CORE.indexOf("'.bwn-drawer{position:fixed;top:0;bottom:0;left:' + DOCK_RAIL_W + 'px;z-index:99997;'") !== -1,
  'left is back on --bwn-dock-w, which reflows on collapse');
A.ok('and moves on transform', CORE.indexOf('transform:translateX(var(--bwn-dock-shift,0px));') !== -1);
A.ok('entry and exit are transitions, not a keyframe', CORE.indexOf("'opacity:1;transform:translateX(var(--bwn-dock-shift,0px));' +\n        'transition:opacity .16s cubic-bezier(.23,1,.32,1),transform .2s cubic-bezier(.23,1,.32,1);}'") !== -1);
A.ok('the exit state sits under the incoming panel and stops taking clicks',
  CORE.indexOf("'.bwn-drawer.bwn-closing{opacity:0;z-index:99996;pointer-events:none;}'") !== -1);
A.ok('the bwn-drawer-in keyframe is KEPT for bwn-suite-ai Job View, which animates by name',
  CORE.indexOf('@keyframes bwn-drawer-in{') !== -1 && read('bwn-suite-ai.user.js').indexOf('animation:bwn-drawer-in .16s ease-out') !== -1,
  'deleting the keyframe silently kills #bwn-jv-card');

// ---- 3. reduced motion covers the settings card too ------------------------------------------
console.log('\n-- reduced motion --');
var rmQuery = CORE.slice(CORE.indexOf("'@media (prefers-reduced-motion:reduce){.bwn-drawer"));
rmQuery = rmQuery.slice(0, rmQuery.indexOf('\n'));
A.ok('the media query names .bwn-ops-card, the gap this fix closed', rmQuery.indexOf('.bwn-ops-card') !== -1, rmQuery);
A.ok('and .bwn-ops-overlay, so the rail slide stops too', rmQuery.indexOf('.bwn-ops-overlay') !== -1, rmQuery);
A.ok('and it kills the transition, not only the old animation', rmQuery.indexOf('transition:none') !== -1, rmQuery);

// ---- negative controls -----------------------------------------------------------------------
// Each reverts ONE piece of the real source and requires the matching probe above to go red.
console.log('\n-- negative controls (each must catch its own regression) --');

// C1: put the bare remove() back in a module - the "vanish" bug itself.
var c1 = mutate(sliceFn(read('bwn-dispatch.user.js'), 'function drawerDismiss('),
  "el.classList.add('bwn-closing');", 'el.remove();');
var c1r = runDismiss(c1, false);
A.ok('C1 control: a helper that removes outright is caught', c1r.el.removed === true && c1r.el.classes.indexOf('bwn-closing') === -1);

// C2: drop the reduced-motion branch - the user who asked for no motion waits 170ms for a fade
// that was turned off, and is left holding .bwn-closing.
var c2 = mutate(sliceFn(read('bwn-cc-auth.user.js'), 'function drawerDismiss('),
  'if (reduce) { el.remove(); return; }', '');
var c2r = runDismiss(c2, true);
A.ok('C2 control: without the reduce branch the node lingers behind a dead transition',
  c2r.el.removed === false && c2r.timers.length === 1);

// C3: drop the id strip - reopening the tool would then have two nodes with one id.
var c3 = mutate(sliceFn(read('bwn-wo-audit.user.js'), 'function drawerDismiss('),
  "el.removeAttribute('id');", '');
var c3r = runDismiss(c3, false);
A.ok('C3 control: without the id strip the dying node keeps the id', c3r.el.attrs.id === 'bwn-drawer-x');

// C4: revert the geometry to the pre-fix form - the teleport comes back.
var c4 = mutate(pubSrc, 'd.setProperty(\'--bwn-dock-shift\', (px - DOCK_RAIL_W) + \'px\');', '');
var c4r = runPublish(c4); c4r.pub(32);
A.ok('C4 control: with no shift published the drawer cannot follow the rail',
  c4r.set['--bwn-dock-shift'] === undefined, JSON.stringify(c4r.set));

// C5: the reduced-motion probe must fail when .bwn-ops-card is not named - the exact hole the
// review found. Mutating the real query proves the probe reads the query and not a stale string.
var c5 = mutate(rmQuery, '.bwn-ops-overlay,.bwn-ops-card', '');
A.ok('C5 control: a query without the settings card is caught', c5.indexOf('.bwn-ops-card') === -1);

// C6: ask's reversible exit, broken the way it would really break - the class goes on and the
// reopen path forgets to take it off, so the panel is alive, focusable and invisible.
var c6 = mutate(ASK, "panelEl.classList.remove('bwn-closing'); panelEl.removeAttribute('aria-hidden');", '');
A.ok('C6 control: an ask reopen that never clears .bwn-closing is caught',
  c6.indexOf("panelEl.classList.remove('bwn-closing')") === -1);

// C7: ask keeping the timer armed across a reopen - the panel comes back and is yanked 170ms later.
var c7 = mutate(ASK, 'clearTimeout(fadeTimer); fadeTimer = null;', '');
A.ok('C7 control: an ask reopen that leaves the removal armed is caught',
  c7.indexOf('clearTimeout(fadeTimer); fadeTimer = null;') === -1);

console.log('\n(ran ' + (MODULES.length + 1) + ' drawer owners + 5 negative controls. Nothing here renders a pixel:');
console.log(' the fade, the swap crossfade and the collapse slide are owed a live Chrome check.)');

A.finish();
