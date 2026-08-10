// test-assist-ecd-notes.js - node harness for "the ECD helper judged the notes without
// reading them" (Core 1.66.32 / WO Assist Playbook v2.67).
//
// THE BUG, as it shipped:
//   getNotes()'s last resort is readMountedNotes(). The notes list is VIRTUALIZED and it
//   lives on the Notes TAB - while the Complete-By picker, and therefore the whole ECD
//   helper, only exists on the WO DETAILS route. So on the one route where the popup runs,
//   the note read returned an empty array unless the coordinator had already opened the
//   Notes tab and run a Deep Scan by hand. Both questions the popup answers are answered
//   from the notes:
//     - ecdHasEtaSignal() - "is a completion date already promised?" -> always false,
//       so the popup nagged past a real ETA;
//     - proposeECD()      - "what date should we propose?"           -> no noted date,
//       so it defaulted to "the 2nd upcoming Friday" and burned the once-per-WO guard.
//
// WHAT SHIPPED:
//   1. fetchNotesApi() - the SAME one-call bwnNotesApi read Deep Scan has used since
//      2026-08-04, now fired by the engine once per WO and published to the shared bus, so
//      getNotes() hands the full history to every consumer.
//   2. maybeAutoECD() waits while that read is pending, WITHOUT burning the guard.
//   3. latestNotedEta() ranks by the note written LAST, not by the furthest-future date -
//      harmless over ~17 mounted notes, wrong over a 300-note history.
//   4. ECD_NOTE_WORDS - completion-date phrasing ("ECD 8/20", "complete by 8/20") that the
//      arrival-shaped CFG.ETA_WORDS never matched. Used ONLY here; the watchdog is untouched.
//
// Drives the REAL shipped bytes: four slices of bwn-suite-core.user.js, concatenated and run
// against stubs. Multiple slices (the existing harnesses take one) because the engine's note
// cache, the date parser, the ECD proposer and the auto-pop gate sit far apart in the file;
// each slice is start/end pinned and non-unique markers throw.
//
// Nothing here proves the popup RENDERS, that Umbrava's API answers in a real tab, or that
// the proposed date is the one the coordinator wanted - that is the live test.
//
// Every mutation below reverts one piece in the sliced source and asserts THIS harness goes
// red. mutate() throws if its target string is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-ecd-notes.js

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

var S_WARM = slice(coreFull,
  '    // ---- Note history WITHOUT waiting for a Deep Scan',
  '    function notesScroller()', 'notes auto-warm block');
var S_PARSE = slice(coreFull,
  '    // Promised-date parser for note bodies:',
  '    function woStatus()', 'parseBodyDate');
var S_ECD = slice(coreFull,
  '    // ---- ECD helper: propose + set the expected-completion date',
  '    function ensureEcdStyle()', 'ECD proposer block');
var S_POP = slice(coreFull,
  '    var ecdAutoShownFor = null;',
  '    // ---- Status-change preflight', 'ECD auto-pop gate');

var SOURCE = [S_WARM, S_PARSE, S_ECD, S_POP].join('\n');

// ---- Stubs ---------------------------------------------------------------------------
// Everything the four slices reach for that lives elsewhere in the module. Deliberately
// dumb: the point is to drive the real logic, not to re-simulate Umbrava.
var PRELUDE = [
  'var deepNotes = null, deepNotesTs = 0, deepNotesViaApi = false;',
  'var NOTES_TTL = 30 * 60000;',
  'var lastNotesSrc = "view";',
  'var WO_PHASE = {};',
  'var CFG = { ETA_WORDS: /\\b(eta|scheduled?|sched|dispatch(ed)?|on[\\s-]?site\\s+(date|for|on))\\b/i,',
  '            DATE_RE: /\\b\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?\\b|\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\b/i };',
  'function parseNoteDate(s) { var d = s ? new Date(s) : null; return (d && !isNaN(+d)) ? +d : null; }',
  'function parseUSDate(s) { var m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/.exec(s || ""); return m ? +new Date(+m[3], +m[1] - 1, +m[2]) : null; }',
  'function inputVal() { return ""; }',
  'function onWO() { return true; }',
  'function getNotes() { lastNotesSrc = H.notesSrc; return H.notes; }',
  'function busNotesGet() { return H.busNotes; }',
  'function busNotesPut(list) { H.published.push(list); H.busNotes = list; }',
  'function currentWOId() { return H.woId; }',
  'function refresh() { H.refreshes++; }',
  'function bwnNotesApi(n) { return H.apiCall(n); }',
  'function ecdHelperOpen(state) { H.opened.push(state); }',
  'var BWN = { ssGetJSON: function () { return H.trips; } };'
].join('\n');

var EPILOGUE = 'H.api = { fetchNotesApi: fetchNotesApi, notesReadState: notesReadState, notesOnRead: notesOnRead,' +
  ' latestNotedEta: latestNotedEta, proposeECD: proposeECD, ecdHasEtaSignal: ecdHasEtaSignal,' +
  ' maybeAutoECD: maybeAutoECD, getShownFor: function () { return ecdAutoShownFor; },' +
  ' getDeepNotes: function () { return deepNotes; } };';

// Fixed "now" so the Friday default and the past/future cutoff are deterministic.
// 2026-08-05 is a Wednesday; the 2nd upcoming Friday is 2026-08-14.
// Only the ZERO-arg form is frozen; every other form must reach the real constructor
// untouched. parseBodyDate builds y/m/d dates and ecdToday() truncates one, so a wrapper
// that pads the missing arguments produces Invalid Date and silently reads as "no date".
var NOW = new Date(2026, 7, 5, 10, 0, 0).getTime();
var RealDate = Date;
function FrozenDate() {
  if (arguments.length === 0) return new RealDate(NOW);
  var a = Array.prototype.slice.call(arguments);
  return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
}
FrozenDate.now = function () { return NOW; };
FrozenDate.parse = RealDate.parse;
FrozenDate.prototype = RealDate.prototype;

function build(opts) {
  var o = opts || {};
  var src = PRELUDE + '\n' + (o.src || SOURCE) + '\n' + EPILOGUE;
  var H = {
    woId: o.woId || '283834',
    notes: o.notes || [],
    notesSrc: o.notesSrc || 'view',
    busNotes: o.busNotes || null,
    trips: o.trips || null,
    published: [], opened: [], refreshes: 0, apiCalls: [],
    apiCall: function (n) {
      H.apiCalls.push(n);
      if (o.api === 'never') return new Promise(function () { });          // stays pending
      if (o.api === 'error') return Promise.reject(new Error('no live Umbrava token in this tab'));
      return Promise.resolve(o.apiNotes || []);
    }
  };
  var ctx = {
    H: H, Promise: Promise, JSON: JSON, Math: Math, Date: FrozenDate, RegExp: RegExp, Error: Error,
    Object: Object, Array: Array, String: String, Number: Number, isNaN: isNaN,
    parseInt: parseInt, parseFloat: parseFloat,
    console: { info: function () { } },
    document: {
      // maybeAutoECD bails unless the Complete-By picker is mounted (hydration guard), so
      // the auto-pop probes need it present.
      querySelector: function (sel) {
        if (o.ecdField !== false && /expected-completion-date-picker/.test(sel || '')) return { tagName: 'INPUT' };
        return null;
      },
      querySelectorAll: function () { return []; },
      getElementById: function () { return null; }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { H: H, api: H.api };
}

// A note in the shape both the scrape and the API read produce.
function note(body, whenISO, id) {
  var d = new RealDate(whenISO);
  return { id: String(id || 1), label: '', body: body, ts: whenISO, tsAbs: +d };
}
function ymd(ms) { var d = new RealDate(ms); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

// A WO state the proposer accepts: no POs, no current ECD.
function state(over) {
  var s = { pos: [], status: 'Clocked Out: In Progress', due: null };
  Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
  return s;
}

// ---- 1. The auto-warm read ------------------------------------------------------------
console.log('the engine reads the note history on its own - real source');

var b1 = build({ api: 'never' });
b1.api.fetchNotesApi('283834');
A.eq('one API read fired for the WO', b1.H.apiCalls, ['283834']);
b1.api.fetchNotesApi('283834');
b1.api.fetchNotesApi('283834');
A.eq('an in-flight read is not fired again', b1.H.apiCalls.length, 1);
A.eq('state is pending while in flight', b1.api.notesReadState('283834'), 'pending');

var b2 = build({ apiNotes: [note('vendor confirmed, eta 8/20', '2026-08-01T09:00:00Z', 7)] });
b2.api.fetchNotesApi('283834');
var t2 = Promise.resolve().then(function () { }).then(function () {
  A.eq('a good read publishes to the shared bus', b2.H.published.length, 1);
  A.eq('and lands in deepNotes for getNotes()', b2.api.getDeepNotes().length, 1);
  A.ok('and re-renders the engine so notes-derived judgements recompute', b2.H.refreshes >= 1, 'refreshes=' + b2.H.refreshes);
  A.eq('settled state is ok', b2.api.notesReadState('283834'), 'ok');
  b2.api.fetchNotesApi('283834');
  A.eq('a fresh ok with the history in hand does not refetch', b2.H.apiCalls.length, 1);
});

// Navigated away mid-read: the result belongs to another WO now. Dropping it is the point;
// so is clearing the slot, or revisiting would sit on an ok that cached nothing.
var b3 = build({ apiNotes: [note('eta 8/20', '2026-08-01T09:00:00Z', 7)] });
b3.api.fetchNotesApi('283834');
b3.H.woId = '999999';
var t3 = Promise.resolve().then(function () { }).then(function () {
  A.eq('a read that lands after an SPA nav publishes nothing', b3.H.published.length, 0);
  A.eq('and never hangs one WO\'s history off another', b3.api.getDeepNotes(), null);
  A.eq('and clears the slot so a revisit refetches', b3.api.notesReadState('283834'), null);
});

// A failed read must degrade, not wedge: no cache written, and the engine still re-renders.
var b4 = build({ api: 'error' });
b4.api.fetchNotesApi('283834');
var t4 = Promise.resolve().then(function () { }).then(function () { }).then(function () {
  A.eq('a failed read publishes nothing', b4.H.published.length, 0);
  A.eq('and records the failure', b4.api.notesReadState('283834'), 'error');
  A.ok('and still re-renders so the engine is not left mid-wait', b4.H.refreshes >= 1, 'refreshes=' + b4.H.refreshes);
});

// ---- 2. The auto-pop waits for it -----------------------------------------------------
var t5 = Promise.resolve().then(function () {
  console.log('\nthe auto-pop waits for the read instead of guessing');

  var p1 = build({ api: 'never' });
  p1.api.fetchNotesApi('283834');
  p1.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.eq('nothing pops while the note read is pending', p1.H.opened.length, 0);
  A.eq('and the once-per-WO guard is NOT burned', p1.api.getShownFor(), null);

  // Same WO, read settled, still no completion date anywhere -> this is the case the popup
  // exists for, so it must fire (and now it fires knowing the notes were actually read).
  var p2 = build({ notes: [], notesSrc: 'api' });
  p2.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.eq('with the read settled and no date on file, it pops', p2.H.opened.length, 1);
  A.eq('and burns the guard so it asks once', p2.api.getShownFor(), '283834');

  // The read landed and the notes DO carry a completion date: suppressed, no nag.
  var p3 = build({ notes: [note('ECD 8/20 per vendor', '2026-08-04T09:00:00Z', 5)], notesSrc: 'api' });
  p3.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.eq('a completion date in the notes suppresses the popup', p3.H.opened.length, 0);
});

// ---- 3. What the notes are read FOR ---------------------------------------------------
var t6 = Promise.resolve().then(function () {
  console.log('\nthe proposal comes from the notes');

  // The plain regression: notes carry an ETA, so the proposal is that date - not Friday.
  var n1 = build({ notes: [note('vendor on site, eta 8/20', '2026-08-04T09:00:00Z', 5)], notesSrc: 'api' });
  var r1 = n1.api.proposeECD(state());
  A.eq('a noted ETA is the proposed date', ymd(+r1.date), '2026-8-20');
  A.eq('and the basis says so, not "defaulted"', r1.from, 'signal');

  // With ZERO notes read (the shipped behaviour on the details route) it still defaults -
  // that path is unchanged, which is why the popup had to stop firing during the read.
  var n2 = build({ notes: [], notesSrc: 'view' });
  var r2 = n2.api.proposeECD(state());
  A.eq('no notes at all still defaults to the 2nd upcoming Friday', ymd(+r2.date), '2026-8-14');
  A.eq('and the dialog is told the notes were not really read', r2.noteSrc, 'view');
  A.ok('in words a coordinator can act on', /ONLY the notes rendered on screen/.test(r2.noteSrcLabel), r2.noteSrcLabel);

  var n3 = build({ notes: [note('eta 8/20', '2026-08-04T09:00:00Z', 5)], notesSrc: 'api' });
  var r3 = n3.api.proposeECD(state());
  A.eq('a real read is counted for the dialog', r3.noteCount, 1);
  A.ok('and named as the full history', /full note history/.test(r3.noteSrcLabel), r3.noteSrcLabel);

  // Completion-date phrasing the arrival-shaped ETA_WORDS never matched.
  ['ECD 8/20', 'complete by 8/20', 'completion date 8/20', 'finish by 8/20', 'done by 8/20'].forEach(function (body) {
    var n = build({ notes: [note(body, '2026-08-04T09:00:00Z', 5)], notesSrc: 'api' });
    A.eq('reads a completion promise: "' + body + '"', ymd(+n.api.proposeECD(state()).date), '2026-8-20');
  });
  // ...without swallowing a past-tense record as a promise.
  var n4 = build({ notes: [note('work completed 7/15, invoice to follow', '2026-07-15T09:00:00Z', 5)], notesSrc: 'api' });
  A.eq('a past-tense completion record is not a promise', ymd(+n4.api.proposeECD(state()).date), '2026-8-14');

  // THE full-history regression. Older note over-promises 12/31; today's note revises to
  // 8/20. Furthest-future ranking picks the stale one - invisible while only the newest
  // handful of notes were ever mounted, wrong the moment the API hands over all 300.
  var n5 = build({
    notesSrc: 'api',
    notes: [
      note('eta 12/31 at the latest', '2026-06-01T09:00:00Z', 1),
      note('revised - vendor now scheduled, eta 8/20', '2026-08-04T09:00:00Z', 2)
    ]
  });
  A.eq('the note written LAST wins, not the furthest-future date', ymd(+n5.api.proposeECD(state()).date), '2026-8-20');

  // A promise that has already blown is not a completion date.
  var n6 = build({ notes: [note('eta 7/01', '2026-06-25T09:00:00Z', 1)], notesSrc: 'api' });
  A.eq('a blown ETA is ignored', ymd(+n6.api.proposeECD(state()).date), '2026-8-14');
});

// ---- Mutations: revert one piece each, assert the harness reddens ----------------------
var t7 = Promise.all([t2, t3, t4, t5, t6]).then(function () {
  console.log('\nmutations (each must redden its probe)');

  // M1: the auto-pop stops waiting - back to popping on an unread history and burning the
  // guard, which is the shipped bug itself.
  var m1 = build({
    api: 'never',
    src: mutate(SOURCE, "      if (notesReadState(woId) === 'pending') return;", '      ')
  });
  m1.api.fetchNotesApi('283834');
  m1.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.ok('M1 dropping the pending gate pops mid-read again', m1.H.opened.length === 1, 'opened=' + m1.H.opened.length);
  A.ok('M1 and burns the guard doing it', m1.api.getShownFor() === '283834', String(m1.api.getShownFor()));

  // M2: rank by furthest-future date again.
  var m2 = build({
    notesSrc: 'api',
    notes: [
      note('eta 12/31 at the latest', '2026-06-01T09:00:00Z', 1),
      note('revised - vendor now scheduled, eta 8/20', '2026-08-04T09:00:00Z', 2)
    ],
    src: mutate(SOURCE,
      '        if (!best || w > best.when || (w === best.when && dm > best.date)) best = { date: dm, ts: notes[i].ts, when: w };',
      '        if (!best || dm > best.date) best = { date: dm, ts: notes[i].ts, when: w };')
  });
  A.ok('M2 furthest-future ranking picks the stale over-promise', ymd(+m2.api.proposeECD(state()).date) === '2026-12-31', ymd(+m2.api.proposeECD(state()).date));

  // M3: back to the arrival-only vocabulary - "ECD 8/20" goes unread.
  var m3 = build({
    notes: [note('ECD 8/20', '2026-08-04T09:00:00Z', 5)], notesSrc: 'api',
    src: mutate(SOURCE,
      '        if (!((CFG.ETA_WORDS.test(b) || ECD_NOTE_WORDS.test(b)) && CFG.DATE_RE.test(b))) continue;',
      '        if (!(CFG.ETA_WORDS.test(b) && CFG.DATE_RE.test(b))) continue;')
  });
  A.ok('M3 without ECD_NOTE_WORDS an "ECD 8/20" note is invisible', ymd(+m3.api.proposeECD(state()).date) === '2026-8-14', ymd(+m3.api.proposeECD(state()).date));

  // M4: drop the nav guard - WO A's history gets hung off WO B.
  var m4 = build({
    apiNotes: [note('eta 8/20', '2026-08-01T09:00:00Z', 7)],
    src: mutate(SOURCE,
      "        if (currentWOId() !== woNum) { delete NOTES_FETCH[woNum]; notesSettle(woNum); return; }",
      '        ')
  });
  m4.api.fetchNotesApi('283834');
  m4.H.woId = '999999';
  return Promise.resolve().then(function () { }).then(function () {
    A.ok('M4 dropping the nav guard publishes another WO\'s notes', m4.H.published.length === 1, 'published=' + m4.H.published.length);
  });
});

// ---- Structural: the call sites the slices cannot see ---------------------------------
var t8 = t7.then(function () {
  console.log('\nstructural (call sites outside the sliced regions)');
  A.ok('the engine warms the notes each refresh', coreFull.indexOf('fetchNotesApi(woIdent);') !== -1, 'refresh() call site missing');
  A.ok('the manual "Set ECD..." path warms them too', coreFull.indexOf('fetchNotesApi(currentWOId());') !== -1, 'ecdHelperOpen call site missing');
  A.ok('a dialog opened mid-read re-proposes when the history lands', coreFull.indexOf('notesOnRead(ecdWoNum, function () {') !== -1, 're-propose wiring missing');
  A.ok('...but never over an edit the coordinator made', coreFull.indexOf('if (touched || document.getElementById(\'bwn-ecd-overlay\') !== ov') !== -1, 'touched guard missing');
  A.ok('the shared bwnNotesApi block is still the one Deep Scan uses', coreFull.indexOf('  // ===== BEGIN bwnNotesApi =====') !== -1, 'transport block missing');

  // ---- The Save-button attention ring (animation review 2026-08-10) ---------------------
  // It points at Umbrava's own Save button because the Complete-By date does not autosave, so
  // this is a data-loss guard: the probes are about what it COSTS and whether it respects a
  // reduced-motion user, never about removing it. It ran 1.2s x 4 = 4.8s of continuous repaint
  // and was not covered by any reduced-motion query.
  console.log('\nECD save-button attention ring (cost + accessibility)');
  function pulseRuleOf(src) {
    var i = src.indexOf("'.bwn-ecd-savepulse{animation:");
    if (i === -1) throw new Error('the .bwn-ecd-savepulse rule is gone');
    return src.slice(i, src.indexOf('\n', i));
  }
  // Total motion = one pass x iteration count, read out of the shipped rule rather than assumed.
  function pulseMs(rule) {
    var m = rule.match(/animation:bwnEcdPulse\s+([\d.]+)s\s+[^;]*?\s(\d+);/);
    return m ? Math.round(parseFloat(m[1]) * 1000) * parseInt(m[2], 10) : null;
  }
  var pulseRule = pulseRuleOf(coreFull);
  A.ok('one pass is 420ms', /animation:bwnEcdPulse \.42s /.test(pulseRule), pulseRule);
  A.ok('it pulses twice - enough to catch an eye that was elsewhere, not a loop',
    / 2;/.test(pulseRule), pulseRule);
  A.ok('total motion is under a second (it was 4800ms)', pulseMs(pulseRule) === 840, 'got ' + pulseMs(pulseRule));
  A.ok('the static outline stays, because that is the actual affordance',
    pulseRule.indexOf('outline:2px solid var(--bwn-green)!important') !== -1, pulseRule);
  A.ok('reduced motion drops the pulse',
    coreFull.indexOf("'@media (prefers-reduced-motion:reduce){.bwn-ecd-savepulse{animation:none;}}'") !== -1,
    'the ring animates for a user who asked for no motion');
  A.ok('...and drops ONLY the animation, so the outline still guards the unsaved date',
    coreFull.indexOf('{.bwn-ecd-savepulse{animation:none;}}') !== -1 &&
    coreFull.indexOf('{.bwn-ecd-savepulse{display:none') === -1);
  A.ok('the keyframe no longer holds a dead tail at 0 opacity',
    coreFull.indexOf('@keyframes bwnEcdPulse{from{box-shadow:0 0 0 0 rgba(46,160,90,.75);}to{box-shadow:0 0 0 9px rgba(46,160,90,0);}}') !== -1,
    'the 70%-to-100% hold is back');
  A.ok('the class is still removed on a timer, so nothing outlives the edit',
    coreFull.indexOf("el.classList.remove('bwn-ecd-savepulse');") !== -1);

  // Control: put the 4.8s version back and require the cost probe to go red. Mutating the real
  // rule is the point - a control against a hand-written string would pass on deleted source.
  var oldForm = pulseRule.replace('animation:bwnEcdPulse .42s cubic-bezier(.23,1,.32,1) 2;', 'animation:bwnEcdPulse 1.2s ease-out 4;');
  if (oldForm === pulseRule) throw new Error('MUTATION TARGET ABSENT: the pulse rule did not change');
  A.ok('control: the pre-fix 4.8s form is caught by the cost probe', pulseMs(oldForm) === 4800, 'got ' + pulseMs(oldForm));

  console.log('\n(auto-warm x auto-pop gate x proposal, real source, 4 mutations. Nothing here proves');
  console.log(' the popup renders, that Umbrava answers in a real tab, or that the proposed date is');
  console.log(' the one the coordinator wanted - the live test on a WO with a noted ETA covers that.)');
  A.finish();
});

t8.catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
