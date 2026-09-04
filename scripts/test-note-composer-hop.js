// test-note-composer-hop.js - node harness for "the drafted note never opened a composer
// on the route the feature actually runs on" (bwn-suite-core.user.js).
//
// THE BUG, as it shipped:
//   insertWONote() opens Umbrava's own Add Note composer and DRAFTS into it - the save stays
//   manual so the coordinator posts under their own attribution. It finds the composer by
//   scanning for a button reading "Add Note". That button only exists on the WO views that
//   host the notes list. The ECD helper, by contrast, only ever runs on the DETAILS route
//   (see test-assist-ecd-notes.js: the Complete-By field lives there), and the next-step
//   note drafts fire from the AI Job View. On those views findAddNoteBtn() returned null and
//   insertWONote gave up on the spot - clipboard + "Add Note composer not found", nothing
//   opened. All EIGHT call sites drafted through it, so the ECD note, the dismissal note, the
//   billing note, the status-change note and the bus commands all failed the same way.
//
// WHAT SHIPPED:
//   No button on this view -> click the Notes tab, wait up to 5s for the button to mount,
//   then run the original open-and-fill once. `_hopped` caps it at one hop, so a view with
//   no notes tab at all still lands on the clipboard fallback instead of looping.
//   Same ladder bwn-drop-upload's triggerNoteComposer already uses live.
//
// Drives the REAL shipped bytes: the composer region of bwn-suite-core.user.js, sliced
// start/end-pinned (non-unique markers throw) and run against a stub DOM with a fake timer
// queue, so the 250ms poll is stepped rather than waited on.
//
// Nothing here proves Umbrava's tab strip carries role="tab", that the button mounts within
// 5s on a real page, or that the editor accepts the text - that is the live test.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-note-composer-hop.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
var coreFull = readLF(CORE_SRC);

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  if (text.indexOf(end, b + 1) !== -1) throw new Error(what + ': END marker not unique');
  return text.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S_COMPOSER = slice(coreFull,
  '    function findAddNoteBtn() {',
  '    // The FULL-WIDTH block to insert the card before', 'note composer block');

// ---- stub DOM -----------------------------------------------------------------------
// Only the three selectors this region queries are answered; anything else returns [] so a
// new query added to the region shows up as a red case rather than as silent nothing.
var SEL_BUTTON = 'button';
var SEL_TAB = '[role="tab"], a[href*="/notes"]';
var SEL_EDITOR = 'textarea, [contenteditable="true"], [contenteditable=""]';

function el(tag, text, onClick) {
  return {
    tagName: tag.toUpperCase(), textContent: text, offsetParent: {}, clicks: 0,
    value: '', focus: function () { }, scrollIntoView: function () { },
    closest: function () { return null; },
    getAttribute: function () { return null; },
    dispatchEvent: function () { return true; },
    click: function () { this.clicks++; if (onClick) onClick(); }
  };
}

// world: what is on the page, and how it changes when a control is clicked.
function makeWorld(opts) {
  var w = { buttons: [], tabs: [], editors: [], toasts: [], timers: [], now: 0 };
  var addBtn = el('BUTTON', 'Add Note', function () {
    // Opening the composer mounts a fresh editor - that is what insertWONote polls for.
    w.editors.push(el('TEXTAREA', ''));
  });
  if (opts.buttonNow) w.buttons.push(addBtn);
  if (opts.tab) {
    w.tabs.push(el('A', 'Notes', function () {
      if (opts.buttonAfterHop) w.buttons.push(addBtn);
    }));
  }
  if (opts.decoyTab) w.tabs.push(el('A', 'Note Templates'));

  var sandbox = {
    console: { info: function () { }, warn: function () { } },
    navigator: { clipboard: { writeText: function () { return { catch: function () { } }; } } },
    Event: function () { },
    document: {
      querySelectorAll: function (sel) {
        if (sel === SEL_BUTTON) {
          var seen = w.buttons.slice();
          // opts.vanish models the real race the hop cap exists for: the tab click remounts
          // the panel, so the button the poll saw can be gone by the time the retry looks.
          if (opts.vanish && seen.length) w.buttons.length = 0;
          return seen;
        }
        if (sel === SEL_TAB) return w.tabs.slice();
        if (sel === SEL_EDITOR) return w.editors.slice();
        return [];
      },
      querySelector: function () { return null; },
      execCommand: function () { return true; }
    },
    // Fake timers: queued, then stepped by drain() so the 250ms poll costs no wall clock.
    setTimeout: function (fn, ms) { w.timers.push({ fn: fn, at: w.now + (ms || 0) }); return w.timers.length; },
    BWN: {
      setNativeValue: function (e2, v) { e2.value = v; },
      toast: function (sev, msg) { w.toasts.push({ sev: sev, msg: msg }); }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // ecdToast lives further down the file (it wraps BWN.toast with the shared 'ecd' toast id);
  // stubbing it to the same BWN.toast call keeps the slice honest without dragging the region in.
  var prologue = "function ecdToast(msg, sev) { BWN.toast(sev || 'success', msg, { id: 'ecd' }); }\n";
  vm.runInContext('(function(){\n' + prologue + (opts.src || S_COMPOSER) + '\nthis.insertWONote = insertWONote;\n})()', sandbox);
  w.insertWONote = sandbox.insertWONote;
  // Run every queued timer, oldest first, up to a cap that must exceed the 20-poll budget
  // of BOTH loops (hop wait + composer poll) or an exhaustion case would read as a hang.
  w.drain = function () {
    for (var n = 0; n < 200 && w.timers.length; n++) {
      var t = w.timers.shift(); w.now = t.at; t.fn();
    }
  };
  return w;
}

function run(opts) {
  var w = makeWorld(opts);
  var res = { called: false, opened: null };
  w.insertWONote('the note text', function (ok) { res.called = true; res.opened = ok; });
  w.drain();
  res.tabClicks = w.tabs.reduce(function (s, t) { return s + t.clicks; }, 0);
  res.filled = w.editors.map(function (e2) { return e2.value; });
  res.toasts = w.toasts;
  return res;
}

console.log('note composer: hop to the Notes tab when this view has no Add Note button\n');

// 1) The button is right here - the original path, unchanged. No hop.
var r1 = run({ buttonNow: true, tab: true });
A.eq('button on this view: the composer opens', r1.opened, true);
A.eq('button on this view: the text lands in the composer', r1.filled, ['the note text']);
A.eq('button on this view: the Notes tab is NOT clicked', r1.tabClicks, 0);

// 2) The reported bug: no button on this view, but a Notes tab that mounts one.
var r2 = run({ tab: true, buttonAfterHop: true });
A.eq('no button: the Notes tab is clicked exactly once', r2.tabClicks, 1);
A.eq('no button: the composer opens after the hop', r2.opened, true);
A.eq('no button: the text lands after the hop', r2.filled, ['the note text']);
A.eq('no button: no "composer not found" toast', r2.toasts.length, 0);

// 3) Nowhere to hop to - the clipboard fallback still has to fire.
var r3 = run({});
A.eq('no button, no tab: reports failure', r3.opened, false);
A.ok('no button, no tab: the clipboard fallback toast fires',
  r3.toasts.length === 1 && /composer not found/i.test(r3.toasts[0].msg), JSON.stringify(r3.toasts));

// 4) Hopped, and the button never mounted. One hop, then fall back - never a second hop.
var r4 = run({ tab: true, buttonAfterHop: false });
A.eq('hop that leads nowhere: exactly ONE tab click, not a loop', r4.tabClicks, 1);
A.eq('hop that leads nowhere: reports failure', r4.opened, false);
A.ok('hop that leads nowhere: falls back to the clipboard',
  r4.toasts.length === 1 && /composer not found/i.test(r4.toasts[0].msg), JSON.stringify(r4.toasts));

// 5) "Notes" is matched EXACTLY - a "Note Templates" control is not a tab to hop to.
var r5 = run({ decoyTab: true });
A.eq('a near-miss label is not mistaken for the Notes tab', r5.tabClicks, 0);
A.eq('...and it falls back rather than clicking the wrong thing', r5.opened, false);

// ---- mutations: each reverts one piece of the fix in the REAL sliced source ------------
// A harness that stays green with the fix removed proves nothing (green-harness-proves-
// nothing-alone). Every case below must go RED.
function mutantRun(from, to, opts) {
  return run(Object.assign({ src: mutate(S_COMPOSER, from, to) }, opts));
}

var m1 = mutantRun('var tab = _hopped ? null : noteTabControl();', 'var tab = null;',
  { tab: true, buttonAfterHop: true });
A.eq('MUTATION - hop removed: case 2 goes red (no composer)', m1.opened, false);

// The cap earns its keep on a remount race: the poll sees the button, the retry does not.
var r6 = run({ tab: true, buttonAfterHop: true, vanish: true });
A.eq('button vanishes between the poll and the retry: still exactly ONE tab click', r6.tabClicks, 1);
A.eq('...and it falls back rather than hopping again', r6.opened, false);
// Uncapped, the same race re-enters the hop forever - so this mutant either hops more than
// once or dies of it. Both are red; catch the blow-up rather than let it kill the harness.
var m2 = null, m2err = null;
try {
  m2 = mutantRun('var tab = _hopped ? null : noteTabControl();', 'var tab = noteTabControl();',
    { tab: true, buttonAfterHop: true, vanish: true });
} catch (e) { m2err = e; }
A.ok('MUTATION - hop cap removed: the remount race hops again (or runs away)',
  !!m2err || (m2 && m2.tabClicks > 1), m2err ? String(m2err) : ('tabClicks=' + (m2 && m2.tabClicks)));

var m3 = mutantRun("if (/^notes?$/i.test((els[i].textContent || '').trim())) return els[i];",
  "if (/notes?/i.test((els[i].textContent || '').trim())) return els[i];",
  { decoyTab: true });
A.eq('MUTATION - loose label match: case 5 goes red (clicks the decoy)', m3.tabClicks, 1);

// ---- source probes ---------------------------------------------------------------------
A.ok('the note is still DRAFTED, never posted - no note mutation on this path',
  S_COMPOSER.indexOf('addEditJobNote') === -1, 'the composer region posts a note itself');
A.ok('the tab finder skips controls that are not visible',
  /noteTabControl[\s\S]{0,400}offsetParent/.test(S_COMPOSER), 'noteTabControl has no visibility guard');

console.log('\n(real source, 3 mutations. Nothing here proves Umbrava\'s tab strip carries role="tab",');
console.log(' that the Add Note button mounts within the 5s budget on a real page, or that the rich');
console.log(' editor keeps the text - the live test on a WO details route covers that.)');
A.finish();
