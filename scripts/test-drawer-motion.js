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
  'bwn-inventory.user.js', 'bwn-wo-assist.user.js', 'bwn-wo-audit.user.js'];

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
// Still published even though no panel reads it into `left`/`max-width` any more: it is the
// rail's actual width, other code may want it, and removing a published variable is a contract
// change nothing here needs.
A.ok('--bwn-dock-w is still published', collapsed.set['--bwn-dock-w'] === '32px', JSON.stringify(collapsed.set));

A.ok('.bwn-drawer pins left to the expanded rail rather than the live var',
  CORE.indexOf("'.bwn-drawer{position:fixed;top:0;bottom:0;left:' + DOCK_RAIL_W + 'px;z-index:99997;'") !== -1,
  'left is back on --bwn-dock-w, which reflows on collapse');
A.ok('and moves on transform', CORE.indexOf('transform:translateX(var(--bwn-dock-shift,0px));') !== -1);
A.ok('entry and exit are transitions, not a keyframe', CORE.indexOf("'opacity:1;transform:translateX(var(--bwn-dock-shift,0px));' +\n        'transition:opacity .16s cubic-bezier(.23,1,.32,1),transform .2s cubic-bezier(.23,1,.32,1);}'") !== -1);
A.ok('the exit state sits under the incoming panel and stops taking clicks',
  CORE.indexOf("'.bwn-drawer.bwn-closing{opacity:0;z-index:99996;pointer-events:none;}'") !== -1);
// Corrected 2026-08-10: this used to assert that Core's copy of the keyframe was load-bearing for
// bwn-suite-ai's Job View card. It is not - suite-ai declares its OWN identical copy three lines
// below the rule that uses it, deliberately, so the slide-in survives with Core switched off.
// Both halves are asserted so neither can quietly disappear, but Core's copy is inert CSS and must
// not be cited as a dependency again.
A.ok("Core still carries the bwn-drawer-in keyframe (inert, half of a documented fallback pair)",
  CORE.indexOf('@keyframes bwn-drawer-in{') !== -1);
A.ok('and bwn-suite-ai carries its OWN copy, which is the one #bwn-jv-card actually needs',
  read('bwn-suite-ai.user.js').indexOf('@keyframes bwn-drawer-in{') !== -1,
  'the no-Core fallback is gone: the Job View entrance now depends on Core being installed');

// ---- 3. reduced motion covers the settings card too ------------------------------------------
console.log('\n-- reduced motion --');
var rmQuery = CORE.slice(CORE.indexOf("'@media (prefers-reduced-motion:reduce){.bwn-drawer"));
rmQuery = rmQuery.slice(0, rmQuery.indexOf('\n'));
A.ok('the media query names .bwn-ops-card, the gap this fix closed', rmQuery.indexOf('.bwn-ops-card') !== -1, rmQuery);
A.ok('and .bwn-ops-overlay, so the rail slide stops too', rmQuery.indexOf('.bwn-ops-overlay') !== -1, rmQuery);
A.ok('and it kills the transition, not only the old animation', rmQuery.indexOf('transition:none') !== -1, rmQuery);

// ---- 3b. the shared toast: five identical copies, so drift is the risk ------------------------
// The toast used to POP in and fade out - half an animation, missing the half the eye catches.
// Five modules carry a byte-identical copy (sandboxes cannot share one), so these probes RUN each
// module's toast against a fake element and require all five to behave the same, in both media
// states. A copy that drifts is the failure this section exists to catch.
console.log('\n-- shared toast motion, per module --');
var TOAST_MODULES = ['bwn-dispatch.user.js', 'bwn-cc-auth.user.js', 'bwn-cc-purchase.user.js',
  'bwn-inventory.user.js', 'bwn-wo-assist.user.js', 'bwn-wo-intake.user.js'];

function runToast(src, reduce) {
  var styleWrites = [];
  var el = {
    textContent: '', offsetHeight: 1, removed: false,
    style: {
      _t: '', _o: '', _tr: '',
      set cssText(v) { styleWrites.push(['cssText', v]); this._css = v; },
      get cssText() { return this._css || ''; },
      set transition(v) { styleWrites.push(['transition', v]); this._t = v; },
      get transition() { return this._t; },
      set opacity(v) { styleWrites.push(['opacity', v]); this._o = v; },
      get opacity() { return this._o; },
      set transform(v) { styleWrites.push(['transform', v]); this._tr = v; },
      get transform() { return this._tr; }
    },
    remove: function () { this.removed = true; }
  };
  var timers = [];
  var ctx = {
    document: { createElement: function () { return el; }, body: { appendChild: function () { } } },
    window: { matchMedia: function (q) { return { matches: reduce && /reduced-motion/.test(q) }; } },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    console: console, GREEN: '#0d3d26', FONT: 'sans-serif'
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n__toast = toast;', ctx);
  ctx.__toast('hello');
  return {
    el: el, writes: styleWrites, timers: timers,
    // Fire the dismissal timer, then its nested removal timer.
    dismiss: function () {
      var outer = timers.shift(); if (outer) outer.fn();
      var inner = timers.shift(); if (inner) inner.fn();
      return inner ? inner.ms : null;
    }
  };
}

TOAST_MODULES.forEach(function (m) {
  var src = sliceFn(read(m), 'function toast(');
  var r = runToast(src, false);
  A.ok(m + ': starts hidden and offset, so there is something to animate FROM',
    /opacity:0/.test(r.el.style.cssText) && /translate\(-50%,10px\)/.test(r.el.style.cssText), r.el.style.cssText.slice(0, 90));
  A.ok(m + ': enters on a transition, not a keyframe',
    /opacity \.3s ease, transform \.3s ease/.test(r.el.style.transition) || r.writes.some(function (w) { return w[0] === 'transition' && /transform \.3s/.test(w[1]); }),
    JSON.stringify(r.writes.filter(function (w) { return w[0] === 'transition'; })));
  A.ok(m + ': ends up visible and settled', r.el.style.opacity === '1' || r.writes.some(function (w) { return w[0] === 'opacity' && w[1] === '1'; }));
  A.ok(m + ': the entry composes with the centring translate (both axes in one transform)',
    r.writes.some(function (w) { return w[0] === 'transform' && w[1] === 'translate(-50%,0)'; }),
    'a bare translateY would throw away the -50% centring');
  var removalMs = r.dismiss();
  A.ok(m + ': leaves the way it came - fades AND travels back', r.el.style.opacity === '0' && r.el.style.transform === 'translate(-50%,10px)',
    'opacity=' + r.el.style.opacity + ' transform=' + r.el.style.transform);
  A.ok(m + ': removal waits out the 400ms exit', removalMs === 420, 'got ' + removalMs);
  A.ok(m + ': and the node is gone', r.el.removed === true);

  var rr = runToast(src, true);
  A.ok(m + ': under reduced motion the fade stays', /opacity \.3s ease$/.test(rr.el.style.transition) ||
    rr.writes.some(function (w) { return w[0] === 'transition' && w[1] === 'opacity .3s ease'; }),
    JSON.stringify(rr.writes.filter(function (w) { return w[0] === 'transition'; })));
  A.ok(m + ': ...and no transform is animated', !rr.writes.some(function (w) { return w[0] === 'transition' && /transform/.test(w[1]); }));
  rr.dismiss();
  A.ok(m + ': ...and it does not jerk 10px on the way out', rr.el.style.transform === 'translate(-50%,0)',
    'transform=' + rr.el.style.transform);
});

// Control: revert ONE copy to the old pop-in/fade-out form and require the probes to catch it.
var toastOld = mutate(sliceFn(read('bwn-dispatch.user.js'), 'function toast('),
  "t.style.transition = reduce ? 'opacity .3s ease' : 'opacity .3s ease, transform .3s ease';", '');
var tc = runToast(toastOld, false);
A.ok('control: a copy that never runs the entry transition is caught',
  !tc.writes.some(function (w) { return w[0] === 'transition' && /\.3s/.test(w[1]); }),
  'the entry probe would have passed a toast that pops in');

// ---- 4. suite-wide invariant: every animation answers prefers-reduced-motion ------------------
// This section exists because the same hole shipped FOUR separate times in this one file
// (.bwn-ops-card, .bwn-ecd-savepulse, .bwn-wa-card, #bwn-heat-set) and each was found by hand,
// one at a time. Enumerating the declarations finds them all at once, and the count pin makes a
// NEW animation a conscious edit rather than a silent fifth.
console.log('\n-- every animating selector honours reduced motion --');

// Every non-"none" animation shorthand in the suite's animating files, with the selector that
// carries it. Verified against the shipped files 2026-08-10; add a row when you add an animation,
// and the per-file count assertions below are what force you to.
//   slowed: covered by animation-duration rather than animation:none - correct for a spinner,
//   which reports that work is in flight and is the comprehension aid the rule says to keep.
var ANIMATED_BY_FILE = {
  'bwn-bid-out.user.js': [
    { sel: '.bwn-bo-vsskel', keyframe: 'bwn-bo-vssh' }   // vendor-snapshot skeleton shimmer; off under reduced motion
  ],
  'bwn-suite-core.user.js': [
    { sel: '#bwn-heat-panel', keyframe: 'bwnPanelIn' },
    { sel: '#bwn-heat-set', keyframe: 'bwnPanelIn' },
    { sel: '#bwn-heat-prog.indet .fill', keyframe: 'bwnIndet' },
    { sel: '.bwn-wa-card', keyframe: 'bwnWaIn' },
    { sel: '.bwn-ecd-savepulse', keyframe: 'bwnEcdPulse' }
  ],
  'bwn-suite-ai.user.js': [
    { sel: '#bwn-cu-overlay', keyframe: 'bwnFade' },
    { sel: '#bwn-cu-card', keyframe: 'bwnUp' },
    { sel: '.bwn-cu-spin', keyframe: 'bwnSpin', slowed: true },
    { sel: '#bwn-o30b-overlay', keyframe: 'bwnFade' },
    { sel: '#bwn-jv-card', keyframe: 'bwn-drawer-in' },
    { sel: '.bwn-ft-overlay', keyframe: 'bwnFtFade' },
    { sel: '.bwn-ft-card', keyframe: 'bwnFtUp' }
  ]
};
var ANIMATED = ANIMATED_BY_FILE['bwn-suite-core.user.js'];   // the Core-only probes below still read this

// Panels anchored to the dock rail: `left` must be PINNED and the rail's position must arrive as a
// transform on --bwn-dock-shift. Reading --bwn-dock-w into `left` or `max-width` is what teleported
// and reflowed a panel on every rail collapse, and it shipped in three files.
var RAIL_ANCHORED = {
  'bwn-suite-core.user.js': ['.bwn-drawer', '.bwn-ops-overlay'],
  'bwn-suite-ai.user.js': ['#bwn-cu-overlay', '#bwn-o30b-overlay', '#bwn-jv-overlay', '.bwn-ft-overlay'],
  'bwn-bid-out.user.js': ['#bwn-bidout-ov']
};

// The email-guard strip's flash (.bwn-eg.flash / bwnEgFlash) was DELETED 2026-08-10, not fixed:
// confirmSend() opens a dialog in the same tick and the strip is already coloured, so the pulse
// animated behind a surface that had taken the screen. Asserted gone, both halves, because a
// revert would otherwise quietly reintroduce an animation with no row above and no rule.
// These match the RULE forms, not the bare names: the deletion left a comment explaining why the
// flash is gone, and that comment names it. A probe on the bare token went red against the very
// note that documents the fix - so it asserts the declarations are gone, which is the real claim.
var EG_RULE = '.bwn-eg.flash{';
var EG_KEYFRAME = '@keyframes bwnEgFlash';
var EG_USE = 'animation:bwnEgFlash';
A.ok('the eg strip flash rule is gone from the stylesheet', CORE.indexOf(EG_RULE) === -1,
  'the flash rule is back without a row in ANIMATED');
A.ok('...and its keyframe went with it', CORE.indexOf(EG_KEYFRAME) === -1, 'orphan keyframe left behind');
A.ok('...and nothing declares the animation', CORE.indexOf(EG_USE) === -1);
A.ok('...and nothing still adds the class', CORE.indexOf("classList.add('flash')") === -1,
  'the JS still flashes a class the CSS no longer defines');
// Control: the three probes must actually fire on the bytes that shipped in 1.78.2, or they are
// asserting nothing. Prose mentioning the flash must NOT trip them.
var egOld = "'.bwn-eg.flash{animation:bwnEgFlash .24s cubic-bezier(.23,1,.32,1);}' + '@keyframes bwnEgFlash{from{filter:brightness(.85)}to{filter:none}}'";
var egProse = '// There is no .bwn-eg.flash any more (bwnEgFlash, removed 2026-08-10).';
A.ok('control: the probes catch the 1.78.2 rule',
  egOld.indexOf(EG_RULE) !== -1 && egOld.indexOf(EG_KEYFRAME) !== -1 && egOld.indexOf(EG_USE) !== -1);
A.ok('control: and a comment naming the flash does not trip them',
  egProse.indexOf(EG_RULE) === -1 && egProse.indexOf(EG_KEYFRAME) === -1 && egProse.indexOf(EG_USE) === -1);

// Pull the reduced-motion blocks out of the shipped strings and collect every selector each one
// switches off. Selector lists are split, so `#a,#b{animation:none}` covers both.
var rmBlocks = CORE.match(/@media \(prefers-reduced-motion:\s*reduce\)\{[^']*/g) || [];
var rmCovered = {};
rmBlocks.forEach(function (block) {
  (block.match(/([^{}]+)\{([^{}]*)\}/g) || []).forEach(function (rule) {
    var m = rule.match(/^([^{]+)\{([^}]*)\}$/);
    if (!m || !/animation:\s*none/.test(m[2])) return;
    m[1].split(',').forEach(function (s) { rmCovered[s.trim()] = true; });
  });
});

A.ok('the file still has reduced-motion blocks to read', rmBlocks.length >= 4, 'found ' + rmBlocks.length);
ANIMATED.forEach(function (a) {
  A.ok(a.sel + ' (' + a.keyframe + ') is switched off under reduced motion', rmCovered[a.sel] === true,
    'covered: ' + Object.keys(rmCovered).join(' | '));
  A.ok(a.sel + ' still actually animates ' + a.keyframe + ' (the row is not stale)',
    CORE.indexOf('animation:' + a.keyframe) !== -1);
});

// Count pin, same discipline as this repo's @version pins: a new animation must be added to
// ANIMATED above, which is where somebody notices it needs a reduced-motion rule.
var animDecls = (CORE.match(/animation:(?!none)[a-zA-Z]/g) || []).length;
A.ok('exactly ' + ANIMATED.length + ' animation declarations in Core (add yours to ANIMATED above)',
  animDecls === ANIMATED.length, 'found ' + animDecls);

// ---- 4b. the same sweep across the OTHER animating modules -----------------------------------
// Core is not the only file with animations, and bwn-suite-ai had exactly ONE reduced-motion block
// covering one of its seven. Same map-building code, run per file.
function rmCoverageOf(src) {
  var covered = {}, slowed = {};
  (src.match(/@media \(prefers-reduced-motion:\s*reduce\)\{[^']*/g) || []).forEach(function (block) {
    (block.match(/([^{}]+)\{([^{}]*)\}/g) || []).forEach(function (rule) {
      var m = rule.match(/^([^{]+)\{([^}]*)\}$/);
      if (!m) return;
      var body = m[2];
      m[1].split(',').forEach(function (s) {
        s = s.trim();
        if (/animation:\s*none/.test(body)) covered[s] = true;
        if (/animation-duration:/.test(body)) slowed[s] = true;
      });
    });
  });
  return { covered: covered, slowed: slowed };
}

Object.keys(ANIMATED_BY_FILE).forEach(function (file) {
  if (file === 'bwn-suite-core.user.js') return;             // covered above with its own probes
  var src = read(file);
  var cov = rmCoverageOf(src);
  console.log('\n-- ' + file + ': reduced motion --');
  ANIMATED_BY_FILE[file].forEach(function (a) {
    if (a.slowed) {
      A.ok(file + ' ' + a.sel + ' is SLOWED under reduced motion (a spinner reports work in flight)',
        cov.slowed[a.sel] === true, 'slowed: ' + Object.keys(cov.slowed).join(' | '));
    } else {
      A.ok(file + ' ' + a.sel + ' (' + a.keyframe + ') is switched off under reduced motion',
        cov.covered[a.sel] === true, 'covered: ' + Object.keys(cov.covered).join(' | '));
    }
    A.ok(file + ' ' + a.sel + ' still animates ' + a.keyframe + ' (the row is not stale)',
      src.indexOf('animation:' + a.keyframe) !== -1);
  });
  var n = (src.match(/animation:(?!none)[a-zA-Z]/g) || []).length;
  A.ok(file + ': exactly ' + ANIMATED_BY_FILE[file].length + ' animation declarations',
    n === ANIMATED_BY_FILE[file].length, 'found ' + n);
});

// ---- 4c. rail-anchored geometry: transform, never left ----------------------------------------
// Three files pinned their panels to the LIVE rail width, so collapsing the rail teleported them
// 126px sideways and reflowed max-width. Nothing may read --bwn-dock-w into either property again.
console.log('\n-- rail-anchored panels move on transform, in every module --');
Object.keys(RAIL_ANCHORED).forEach(function (file) {
  var src = read(file);
  A.ok(file + ': nothing reads --bwn-dock-w into `left`',
    !/left:\s*var\(--bwn-dock-w/.test(src), 'a live-width left offset teleports on collapse');
  A.ok(file + ': nothing reads --bwn-dock-w into `max-width`',
    !/max-width:calc\(100vw - var\(--bwn-dock-w/.test(src), 'a live-width max-width reflows on collapse');
  RAIL_ANCHORED[file].forEach(function (sel) {
    var i = src.indexOf(sel + '{');
    A.ok(file + ' ' + sel + ' still exists', i !== -1);
    if (i === -1) return;
    var rule = src.slice(i, i + 900);
    A.ok(file + ' ' + sel + ' rides --bwn-dock-shift on transform',
      /transform:translateX\(var\(--bwn-dock-shift,0px\)\)/.test(rule), rule.slice(0, 120));
    A.ok(file + ' ' + sel + ' transitions that shift rather than jumping',
      /transition:[^;}]*transform \.2s cubic-bezier\(\.23,1,\.32,1\)/.test(rule), rule.slice(0, 200));
  });
  // --bwn-dock-w must still be PUBLISHED by Core and may still be read for other purposes; what
  // must not come back is reading it into the two layout properties above.
  if (file === 'bwn-suite-core.user.js') {
    A.ok(file + ": still publishes --bwn-dock-w for anyone else's use",
      src.indexOf("setProperty('--bwn-dock-w'") !== -1);
  }
});

// No animation may ride on a keyframe that no longer exists - a renamed keyframe leaves the
// selector silently static, which is how a dead entrance hides.
ANIMATED.forEach(function (a) {
  A.ok('@keyframes ' + a.keyframe + ' is defined', CORE.indexOf('@keyframes ' + a.keyframe + '{') !== -1);
});

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

// C8: the reduced-motion sweep must actually catch an uncovered selector. Reverting the
// #bwn-heat-set fix reproduces the exact defect that shipped four times, and the coverage map
// built from the mutated source has to lose that selector.
var c8 = mutate(CORE, '#bwn-heat-panel,#bwn-heat-set{animation:none;}', '#bwn-heat-panel{animation:none;}');
var c8covered = {};
(c8.match(/@media \(prefers-reduced-motion:\s*reduce\)\{[^']*/g) || []).forEach(function (block) {
  (block.match(/([^{}]+)\{([^{}]*)\}/g) || []).forEach(function (rule) {
    var m = rule.match(/^([^{]+)\{([^}]*)\}$/);
    if (!m || !/animation:\s*none/.test(m[2])) return;
    m[1].split(',').forEach(function (s) { c8covered[s.trim()] = true; });
  });
});
A.ok('C8 control: an animating selector missing from the query is caught',
  c8covered['#bwn-heat-set'] !== true && c8covered['#bwn-heat-panel'] === true,
  'the sweep would have passed the defect it exists to find');

// C9: and the count pin must fire when an animation is added without a row in ANIMATED. Anchored
// on the ECD ring because the eg flash this used to hang off no longer exists.
var c9 = mutate(CORE, "'.bwn-ecd-savepulse{animation:bwnEcdPulse",
  "'.bwn-fake{animation:bwnFake 1s linear;}' + '.bwn-ecd-savepulse{animation:bwnEcdPulse");
A.ok('C9 control: a new undeclared animation trips the count pin',
  (c9.match(/animation:(?!none)[a-zA-Z]/g) || []).length === ANIMATED.length + 1,
  'found ' + (c9.match(/animation:(?!none)[a-zA-Z]/g) || []).length + ' want ' + (ANIMATED.length + 1));

console.log('\n(ran ' + (MODULES.length + 1) + ' drawer owners + 5 negative controls. Nothing here renders a pixel:');
console.log(' the fade, the swap crossfade and the collapse slide are owed a live Chrome check.)');

A.finish();
