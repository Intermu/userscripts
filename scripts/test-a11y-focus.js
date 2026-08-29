// test-a11y-focus.js - node harness for the shared drawer-modal accessibility work
// (RM-A2 Escape-to-close + RM-B3 focus trap / restore), shipped 2026-08-27.
//
// WHAT SHIPPED, and what each section proves:
//   1. DRIFT GUARD. bwnFocusTrap is one helper, but GM sandboxes can't share a runtime object
//      across the @grant boundary (Core's BWN block documents this), so the drawer-modal family
//      each carries a BYTE-IDENTICAL copy. This slices the function out of all seven owners and
//      asserts they are character-for-character identical - the same discipline test-drawer-motion
//      uses for the five toast copies. A copy that drifts is the failure this section exists to
//      catch.
//   2. BEHAVIOUR. The sliced helper is RUN in a vm against a fake DOM (no jsdom in this repo), and
//      proven to: record the opener, move focus inside on open, wrap Tab last->first and
//      Shift-Tab first->last, restore focus to the opener on release, stay idempotent, and
//      self-release both on .bwn-closing (the drawer exit contract) and on removal from the DOM
//      (the reduced-motion path that detaches with no class). The empty-modal case is covered too.
//   3. WIRING. Each family owner actually CALLS bwnFocusTrap at its open site, and bwn-ask routes
//      Escape through the existing hidePanel() close path (RM-A2).
//   4. SCOPE. The three named RM-A2 files that are NOT script-owned modals (wide-list injects a
//      <style> + a menu toggle; wo-intake injects a drop-zone into the app's own MUI dialog;
//      drop-upload's only surfaces are a non-focusable drag hint and a deliberately non-modal note
//      box) were left untouched ON PURPOSE - no fabricated Escape handler bolted onto a non-modal.
//      Asserted, so a later well-meaning edit that "adds the missing modal" trips this test and has
//      to justify itself.
//   5. NEGATIVE CONTROLS. Each breaks one piece of the real helper and requires the matching probe
//      to go red, so a green run means the probes bite.
//
// What this does NOT prove: that focus LOOKS right in a live browser. No layout is computed here
// (visibility is faked), and the real Tab order, the focus ring, and screen-reader announcement are
// owed a live Chrome check. This harness proves the mechanism, not the pixels.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-a11y-focus.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function read(name) {
  return fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r\n/g, '\n');
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

// The seven drawer-modal owners that carry the helper.
var FAMILY = ['bwn-cc-auth.user.js', 'bwn-cc-purchase.user.js', 'bwn-dispatch.user.js',
  'bwn-inventory.user.js', 'bwn-wo-assist.user.js', 'bwn-wo-audit.user.js', 'bwn-ask.user.js'];

// ---- 1. drift guard: every copy is byte-identical -------------------------------------------
console.log('\n-- bwnFocusTrap: one helper, seven identical copies --');
var canonical = sliceFn(read(FAMILY[0]), 'function bwnFocusTrap(');
A.ok(FAMILY[0] + ' defines bwnFocusTrap', canonical.indexOf('function bwnFocusTrap(modalEl)') === 0);
FAMILY.slice(1).forEach(function (f) {
  var copy = sliceFn(read(f), 'function bwnFocusTrap(');
  A.ok(f + ' carries a byte-identical bwnFocusTrap', copy === canonical,
    'copy drifted from ' + FAMILY[0] + ' (len ' + copy.length + ' vs ' + canonical.length + ')');
});

// ---- fake DOM + runner ----------------------------------------------------------------------
// A minimal DOM the helper can drive: focusable stand-ins, a modal that returns a preset focusable
// list from querySelectorAll, a fake MutationObserver whose callbacks the test fires by hand, and a
// document.activeElement that element.focus() moves.
function buildEnv(fnText, opts) {
  opts = opts || {};
  var observers = [];
  var doc = { activeElement: null };
  function setActive(el) { doc.activeElement = el; }

  function makeFocusable(name, invisible) {
    return {
      _name: name,
      offsetWidth: invisible ? 0 : 10, offsetHeight: invisible ? 0 : 10,
      isConnected: true,
      getClientRects: function () { return invisible ? [] : [{}]; },
      focus: function () { setActive(this); }
    };
  }

  var children = [];
  var nFoc = (opts.focusables === undefined) ? 3 : opts.focusables;
  for (var i = 0; i < nFoc; i++) children.push(makeFocusable('f' + i));

  var modalListeners = {};
  var modal = {
    _name: 'modal',
    offsetWidth: 10, offsetHeight: 10, isConnected: true,
    _attrs: {},
    _focused: false,
    getClientRects: function () { return [{}]; },
    hasAttribute: function (k) { return this._attrs[k] !== undefined; },
    setAttribute: function (k, v) { this._attrs[k] = String(v); },
    removeAttribute: function (k) { delete this._attrs[k]; },
    focus: function () { this._focused = true; setActive(this); },
    contains: function (node) { return node === this || children.indexOf(node) !== -1; },
    querySelectorAll: function () { return children.slice(); },
    classList: {
      _c: [],
      add: function (c) { if (this._c.indexOf(c) === -1) this._c.push(c); },
      remove: function (c) { var k = this._c.indexOf(c); if (k !== -1) this._c.splice(k, 1); },
      contains: function (c) { return this._c.indexOf(c) !== -1; }
    },
    addEventListener: function (t, fn) { (modalListeners[t] = modalListeners[t] || []).push(fn); },
    removeEventListener: function (t, fn) { var a = modalListeners[t] || []; var k = a.indexOf(fn); if (k !== -1) a.splice(k, 1); },
    parentNode: null
  };
  var parent = { _name: 'parent' };
  modal.parentNode = parent;

  function FakeMO(cb) { this._cb = cb; }
  FakeMO.prototype.observe = function (target, o) { this._target = target; this._opts = o; this._live = true; observers.push(this); };
  FakeMO.prototype.disconnect = function () { this._live = false; };

  var ctx = { document: doc, MutationObserver: FakeMO, console: console };
  vm.createContext(ctx);
  vm.runInContext(fnText + '\n__trap = bwnFocusTrap;', ctx);

  return {
    modal: modal, children: children, parent: parent, doc: doc,
    setActive: setActive,
    trap: function () { return ctx.__trap(modal); },
    keydown: function (key, shift) {
      var ev = { key: key, shiftKey: !!shift, _pd: false, preventDefault: function () { this._pd = true; } };
      (modalListeners.keydown || []).slice().forEach(function (fn) { fn(ev); });
      return ev;
    },
    keydownCount: function () { return (modalListeners.keydown || []).length; },
    fireClass: function () { observers.forEach(function (o) { if (o._live && o._target === modal && o._opts.attributes) o._cb([]); }); },
    fireRemoval: function () { observers.forEach(function (o) { if (o._live && o._target === parent && o._opts.childList) o._cb([{ removedNodes: [modal] }]); }); }
  };
}

var TRAP = canonical;

// ---- 2. behaviour ---------------------------------------------------------------------------
console.log('\n-- open: records the opener and moves focus inside --');
(function () {
  var env = buildEnv(TRAP);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  env.trap();
  A.ok('focus moved off the opener into the modal', env.doc.activeElement === env.children[0],
    'active=' + (env.doc.activeElement && env.doc.activeElement._name));
  A.ok('a Tab listener is installed on the modal', env.keydownCount() === 1, 'count=' + env.keydownCount());
})();

console.log('\n-- Tab / Shift-Tab wrap within the modal --');
(function () {
  var env = buildEnv(TRAP);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  env.trap();
  var first = env.children[0], last = env.children[env.children.length - 1];
  env.setActive(last);
  var ev1 = env.keydown('Tab', false);
  A.ok('Tab from the last focusable wraps to the first', env.doc.activeElement === first && ev1._pd === true,
    'active=' + (env.doc.activeElement && env.doc.activeElement._name) + ' pd=' + ev1._pd);
  env.setActive(first);
  var ev2 = env.keydown('Tab', true);
  A.ok('Shift-Tab from the first wraps to the last', env.doc.activeElement === last && ev2._pd === true,
    'active=' + (env.doc.activeElement && env.doc.activeElement._name) + ' pd=' + ev2._pd);
  var mid = env.children[1];
  env.setActive(mid);
  var ev3 = env.keydown('Tab', false);
  A.ok('Tab in the middle is left to the browser', env.doc.activeElement === mid && ev3._pd === false);
  var ev4 = env.keydown('a', false);
  A.ok('a non-Tab key is ignored', ev4._pd === false);
})();

console.log('\n-- release restores focus to the opener, and is idempotent --');
(function () {
  var env = buildEnv(TRAP);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  var release = env.trap();
  A.ok('focus is inside before release', env.doc.activeElement === env.children[0]);
  release();
  A.ok('release returns focus to the opener', env.doc.activeElement === opener,
    'active=' + (env.doc.activeElement && env.doc.activeElement._name));
  A.ok('release removes the Tab listener', env.keydownCount() === 0);
  env.setActive(env.children[0]);
  release();
  A.ok('a second release is a no-op (does not re-restore)', env.doc.activeElement === env.children[0]);
})();

console.log('\n-- self-release on .bwn-closing (the animated exit) --');
(function () {
  var env = buildEnv(TRAP);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  env.trap();
  env.modal.classList.add('bwn-closing');
  env.fireClass();
  A.ok('focus is restored to the opener when the modal starts closing', env.doc.activeElement === opener);
  A.ok('and the Tab listener is gone', env.keydownCount() === 0);
})();

console.log('\n-- self-release on removal (the reduced-motion exit, no class) --');
(function () {
  var env = buildEnv(TRAP);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  env.trap();
  env.fireRemoval();
  A.ok('focus is restored when the modal is detached outright', env.doc.activeElement === opener);
  A.ok('and the Tab listener is gone', env.keydownCount() === 0);
})();

console.log('\n-- a modal with no focusables falls back to the modal itself --');
(function () {
  var env = buildEnv(TRAP, { focusables: 0 });
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  env.trap();
  A.ok('focus lands on the modal container', env.doc.activeElement === env.modal && env.modal._focused === true);
  A.ok('and the container was made programmatically focusable', env.modal.getAttribute ? true : env.modal._attrs.tabindex === '-1',
    'tabindex=' + env.modal._attrs.tabindex);
  var ev = env.keydown('Tab', false);
  A.ok('Tab with nothing to move to is swallowed, not thrown', ev._pd === true);
})();

// ---- 3. wiring: each owner calls the trap; ask routes Escape through hidePanel ---------------
console.log('\n-- wiring: every owner arms the trap at its open site --');
var OPEN_CALL = {
  'bwn-cc-auth.user.js': 'bwnFocusTrap(back);',
  'bwn-cc-purchase.user.js': 'bwnFocusTrap(back);',
  'bwn-dispatch.user.js': 'bwnFocusTrap(back);',
  'bwn-inventory.user.js': 'bwnFocusTrap(back);',
  'bwn-wo-assist.user.js': 'bwnFocusTrap(back);',
  'bwn-wo-audit.user.js': 'bwnFocusTrap(ov);',
  'bwn-ask.user.js': 'bwnFocusTrap(panelEl);'
};
FAMILY.forEach(function (f) {
  var src = read(f);
  A.ok(f + ' calls ' + OPEN_CALL[f] + ' after building the modal', src.indexOf(OPEN_CALL[f]) !== -1,
    'the trap is defined but never armed');
  A.ok(f + ' arms the trap after appendChild, not before',
    src.indexOf('appendChild') !== -1 && src.indexOf(OPEN_CALL[f]) > src.indexOf('.appendChild('));
});
// ask reopens a kept node, so its trap is armed on BOTH the reopen and the first-build paths.
A.ok('bwn-ask arms the trap on both show paths (reopen + first build)',
  (read('bwn-ask.user.js').match(/bwnFocusTrap\(panelEl\)/g) || []).length === 2);

console.log('\n-- RM-A2: bwn-ask closes on Escape through the existing hidePanel() --');
var ASK = read('bwn-ask.user.js');
A.ok('bwn-ask has an Escape keydown that calls hidePanel()',
  /e\.key === 'Escape'\)\s*\{\s*e\.preventDefault\(\);\s*hidePanel\(\);/.test(ASK),
  'Escape is not routed through the animated close path');
A.ok('bwn-ask still had NO Escape handler before this work (root-cause check held)',
  (ASK.match(/'Escape'/g) || []).length === 1, 'more than the one Escape handler we added');

// ---- 4. scope: the three non-modal files were left alone on purpose --------------------------
console.log('\n-- scope: non-modal RM-A2 names carry no fabricated modal --');
[['bwn-wide-list.user.js', 'a <style> injector + a Tampermonkey menu toggle'],
['bwn-wo-intake.user.js', "a drop-zone injected into the app's own MUI dialog"],
['bwn-drop-upload.user.js', 'a non-focusable drag hint + a deliberately non-modal note box']].forEach(function (pair) {
  var src = read(pair[0]);
  A.ok(pair[0] + ' was NOT given a focus trap (' + pair[1] + ')', src.indexOf('bwnFocusTrap') === -1);
  A.ok(pair[0] + ' was NOT given a synthetic Escape-to-close', src.indexOf("=== 'Escape'") === -1 && src.indexOf("== 'Escape'") === -1);
});

// ---- 5. negative controls -------------------------------------------------------------------
console.log('\n-- negative controls (each must catch its own regression) --');

// C1: break the Shift-Tab wrap - drop the last.focus() so Shift-Tab from the first goes nowhere.
(function () {
  var broken = TRAP.replace('e.preventDefault(); last.focus();', 'e.preventDefault();');
  A.ok('C1 setup: the mutation changed the helper', broken !== TRAP);
  var env = buildEnv(broken);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  env.trap();
  env.setActive(env.children[0]);
  env.keydown('Tab', true);
  A.ok('C1 control: a helper that forgets to wrap Shift-Tab is caught',
    env.doc.activeElement !== env.children[env.children.length - 1],
    'the wrap probe would have passed a broken trap');
})();

// C2: break restore - drop prev.focus() so release leaves focus stranded inside the modal.
(function () {
  var broken = TRAP.replace('if (prev && prev.focus && prev.isConnected !== false) prev.focus();', 'void 0;');
  A.ok('C2 setup: the mutation changed the helper', broken !== TRAP);
  var env = buildEnv(broken);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  var release = env.trap();
  release();
  A.ok('C2 control: a helper that never restores focus is caught', env.doc.activeElement !== opener,
    'the restore probe would have passed a trap that strands focus');
})();

// C3: break self-release - never act on .bwn-closing, so focus is not returned as the modal fades.
(function () {
  var broken = TRAP.replace("if (modalEl.classList && modalEl.classList.contains('bwn-closing')) release();", 'void 0;');
  A.ok('C3 setup: the mutation changed the helper', broken !== TRAP);
  var env = buildEnv(broken);
  var opener = { _name: 'opener', isConnected: true, focus: function () { env.setActive(this); } };
  env.setActive(opener);
  env.trap();
  env.modal.classList.add('bwn-closing');
  env.fireClass();
  A.ok('C3 control: a helper that ignores .bwn-closing is caught', env.doc.activeElement !== opener,
    'the self-release probe would have passed a trap that never fires on close');
})();

console.log('\n(ran the drift guard over ' + FAMILY.length + ' copies + the behaviour suite + 3 negative controls.');
console.log(' Live Chrome still owes: real Tab order, the focus ring, and SR announcement.)');

A.finish();
