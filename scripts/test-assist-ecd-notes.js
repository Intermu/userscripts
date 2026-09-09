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
//     - the signal suppressor (removed in 1.81.1) - "is a completion date already promised?" -> always false,
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
// Drives the REAL shipped bytes: five slices of bwn-suite-core.user.js, concatenated and run
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

// The write echo + dueStatus, which decides `state.due` - the input maybeAutoECD's
// missing-or-overdue gate turns on. Sliced too because the ECD write is an API patch that
// the page never re-renders from (Core 1.81.8).
var S_DUE = slice(coreFull,
  '    // ---- ECD write echo (the DOM does not re-render after our patch)',
  '    function staleness(notes) {', 'ECD write echo + dueStatus');

var SOURCE = [S_WARM, S_PARSE, S_ECD, S_POP, S_DUE].join('\n');

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
  // Umbrava moved the WO form fields onto name="<api.field.path>" (2026-09-03); ecdFieldInput
  // now goes through these, so the picker presence flag drives woFieldInput, not querySelector.
  'function woFieldInput(n) { return H.ecdField ? { tagName: "INPUT", value: H.ecdValue } : null; }',
  'function woFieldVal(n) { var e = woFieldInput(n); return e ? (e.value || "") : ""; }',
  'function onWO() { return true; }',
  'function getNotes() { lastNotesSrc = H.notesSrc; return H.notes; }',
  'function busNotesGet() { return H.busNotes; }',
  'function busNotesPut(list) { H.published.push(list); H.busNotes = list; }',
  'function currentWOId() { return H.woId; }',
  'function refresh() { H.refreshes++; }',
  'function bwnNotesApi(n) { return H.apiCall(n); }',
  'function ecdHelperOpen(state) { H.opened.push(state); }',
  'function daysUntil(ts) { return Math.ceil((ts - Date.now()) / 86400000); }',
  // Key-aware now: the auto-pop gate reads bwn:trips, the write echo reads bwn:ecdset.
  'var BWN = { ssGetJSON: function (k) { return /^bwn:ecdset:/.test(String(k)) ? H.ecdSet : H.trips; } };',
  'var sessionStorage = { removeItem: function (k) { H.removed.push(k); H.ecdSet = null; } };'
].join('\n');

var EPILOGUE = 'H.api = { fetchNotesApi: fetchNotesApi, notesReadState: notesReadState, notesOnRead: notesOnRead,' +
  ' latestNotedEta: latestNotedEta, proposeECD: proposeECD, dueStatus: dueStatus, ecdEcho: ecdEcho,' +
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
    ecdField: o.ecdField !== false,
    ecdValue: o.ecdValue || '',
    ecdSet: o.ecdSet || null,      // the bwn:ecdset:<wo> write echo, as sessionStorage would hold it
    published: [], opened: [], refreshes: 0, apiCalls: [], removed: [],
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
      querySelector: function () { return null; },   // the ECD field is reached via woFieldInput now
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

  // ---- The signals are the REASON to pop, not a reason to stay silent (1.81.1) --------
  // Until 1.81.1 each of the three below returned early out of maybeAutoECD. That left the
  // auto-pop able to fire ONLY on a WO it had nothing to propose from, which is the exact
  // shape of "the ECD popup stopped appearing": the WOs a coordinator actually meets - a
  // scheduled tech, a PO date, a noted ETA - were the silent ones.
  var p3 = build({ notes: [note('ECD 8/20 per vendor', '2026-08-04T09:00:00Z', 5)], notesSrc: 'api' });
  p3.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.eq('a completion date in the notes POPS (it is the proposal, not a silencer)', p3.H.opened.length, 1);
  A.eq('and the date proposed is the noted one, not the Friday fallback',
    ymd(+p3.api.proposeECD(state()).date), '2026-8-20');

  var p4 = build({ notes: [], notesSrc: 'api' });
  p4.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '08/20/2026' }] }));
  A.eq('a PO line with a scheduled date pops', p4.H.opened.length, 1);

  var p5 = build({ notes: [], notesSrc: 'api', trips: { latestScheduled: +new RealDate(2026, 7, 20) } });
  p5.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.eq('a cached scheduled trip pops', p5.H.opened.length, 1);

  // The guards that are NOT about signals must still hold - this fix removed one early
  // return, not the gate. A WO whose ECD is set and in the future is simply correct.
  var p6 = build({ notes: [note('ECD 8/20', '2026-08-04T09:00:00Z', 5)], notesSrc: 'api' });
  p6.api.maybeAutoECD(state({ due: { kind: 'ok', raw: '12/31/2026' }, pos: [{ done: false, amount: 500, schedDate: '08/20/2026' }] }));
  A.eq('a healthy future ECD still never pops, signal or not', p6.H.opened.length, 0);
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

  // M5: put the pre-1.81.1 signal suppressor back, inline and verbatim in behaviour. This is
  // the control for the fix itself: with it restored, every one of p3/p4/p5 goes silent again,
  // which is the reported symptom. Anchored on the line the suppressor used to sit under, so
  // a future edit that moves that gate reddens here rather than passing on a stale anchor.
  var OLD_SUPPRESSOR =
    '      if (state.pos.some(function (p) { return !p.done && p.amount > 0 && p.schedDate; })) return;\n' +
    '      if (latestNotedEta(state)) return;\n' +
    '      try { var _tb = BWN.ssGetJSON(\'bwn:trips:\' + currentWOId(), null); if (_tb && _tb.latestScheduled && _tb.latestScheduled >= ecdToday()) return; } catch (e) { }\n';
  var ANCHOR = '      if (!state.due && !hasActivePO) return;';
  var m5src = mutate(SOURCE, ANCHOR, ANCHOR + '\n' + OLD_SUPPRESSOR);
  [
    ['a noted completion date', { notes: [note('ECD 8/20 per vendor', '2026-08-04T09:00:00Z', 5)], notesSrc: 'api' }, { done: false, amount: 500, schedDate: '' }],
    ['a PO scheduled date', { notes: [], notesSrc: 'api' }, { done: false, amount: 500, schedDate: '08/20/2026' }]
  ].forEach(function (c) {
    var m = build({ notes: c[1].notes, notesSrc: c[1].notesSrc, src: m5src });
    m.api.maybeAutoECD(state({ pos: [c[2]] }));
    A.ok('M5 the old suppressor silences the popup on ' + c[0], m.H.opened.length === 0, 'opened=' + m.H.opened.length);
  });
  var m5t = build({ notes: [], notesSrc: 'api', trips: { latestScheduled: +new RealDate(2026, 7, 20) }, src: m5src });
  m5t.api.maybeAutoECD(state({ pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.ok('M5 ...and on a cached scheduled trip', m5t.H.opened.length === 0, 'opened=' + m5t.H.opened.length);

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

// ---- 6. The write echo: the page does not re-render from our patch -------------------
// Reported live 2026-09-04: the ECD had been set, and clicking through to /notes on the SAME
// WO re-popped the prompt - "it has been updated but needs a refresh to reflect the data".
// Two causes, both closed here. (a) The write is an API patch and Umbrava's form does not
// re-render from it, so dueStatus kept reading the PRE-write date and every consumer read the
// WO as overdue. (b) The once-per-WO guard was re-armed on ANY path change, so a tab hop
// within one WO re-armed it. The echo is trusted only while the field still shows `before`.
var t7b = t7.then(function () {
  console.log('\nthe write echo covers the page until it catches up - real source');
  var C = { dueWarnDays: 3 };
  // Built the way waSetEcd stores them: local 11:59 PM, serialized ISO. TZ-independent.
  var beforeIso = new RealDate(2026, 6, 15, 23, 59, 0).toISOString();   // 07/15/2026 - overdue at the frozen now
  var afterIso = new RealDate(2026, 7, 20, 23, 59, 0).toISOString();    // 08/20/2026 - 15d out
  var echo = { v: 1, ts: NOW, before: beforeIso, after: afterIso };
  var DOM_BEFORE = '07/15/2026, 11:59 PM';

  var noEcho = build({ ecdValue: DOM_BEFORE }).api.dueStatus(C);
  A.eq('without the echo the stale field still reads overdue (the reported symptom)', noEcho.kind, 'bad');

  var b6 = build({ ecdValue: DOM_BEFORE, ecdSet: echo });
  var d6 = b6.api.dueStatus(C);
  A.eq('the echoed date is used while the field still shows the pre-write value', d6.kind, 'ok');
  A.eq('...and it is the date that is reported', d6.raw, '08/20/2026');
  A.eq('nothing is discarded while the echo still matches', b6.H.removed, []);

  // The field moved on: a reload (it now shows the written date) or an edit in Umbrava's own
  // UI. Either way the page is authoritative again and the echo must be dropped, not believed.
  var b7 = build({ ecdValue: '09/01/2026, 11:59 PM', ecdSet: echo });
  var d7 = b7.api.dueStatus(C);
  A.eq('once the field moves on, the page wins', d7.raw, '09/01/2026, 11:59 PM');
  A.eq('...and the echo is discarded, not left to shadow it', b7.H.removed, ['bwn:ecdset:283834']);
  A.eq('...permanently: a second read has nothing to fall back on', b7.api.dueStatus(C).raw, '09/01/2026, 11:59 PM');

  // First ECD on a WO that had none: `before` is null and the field is empty.
  var b8 = build({ ecdValue: '', ecdSet: { v: 1, ts: NOW, before: null, after: afterIso } });
  A.eq('a first-ever ECD echoes over an empty field', b8.api.dueStatus(C).raw, '08/20/2026');
  var b9 = build({ ecdValue: DOM_BEFORE, ecdSet: { v: 1, ts: NOW, before: null, after: afterIso } });
  A.eq('...but an empty-field echo does not override a field that holds a date', b9.api.dueStatus(C).raw, '07/15/2026, 11:59 PM');

  // A deliberately backdated ECD stays overdue - the echo reports the record, it does not
  // launder it. The auto-pop is held off a second time by its own once-per-WO guard, which
  // is now keyed on the WO number and no longer cleared by a tab hop (see the structural
  // check below).
  var b10 = build({ notesSrc: 'api', ecdValue: DOM_BEFORE, ecdSet: { v: 1, ts: NOW, before: beforeIso, after: new RealDate(2026, 7, 1, 23, 59, 0).toISOString() } });
  var d10 = b10.api.dueStatus(C);
  A.eq('a backdated ECD is still reported overdue', d10.kind, 'bad');
  A.eq('...as the date that was actually written', d10.raw, '08/01/2026');
  b10.api.maybeAutoECD(state({ due: d10, pos: [{ done: false, amount: 500, schedDate: '' }] }));
  b10.api.maybeAutoECD(state({ due: d10, pos: [{ done: false, amount: 500, schedDate: '' }] }));
  A.eq('and the popup fires once per WO, not once per tab hop', b10.H.opened.length, 1);

  // M6: drop the substitution - the stale field wins and the fixed WO reads overdue again.
  var m6 = build({
    ecdValue: DOM_BEFORE, ecdSet: echo,
    src: mutate(SOURCE, '      if (echo) v = ecdFmtUS(new Date(echo));', '      ')
  });
  A.eq('M6 without the substitution the just-written ECD reads overdue', m6.api.dueStatus(C).kind, 'bad');

  // M7: trust the echo unconditionally - it then shadows a date the coordinator set in
  // Umbrava's own UI, which is worse than the bug being fixed.
  var m7 = build({
    ecdValue: '09/01/2026, 11:59 PM', ecdSet: echo,
    src: mutate(SOURCE, '      if (domTs !== beforeTs) {', '      if (false) {')
  });
  A.eq('M7 an unconditional echo shadows a newer date on the page', m7.api.dueStatus(C).raw, '08/20/2026');
});

// ---- Structural: the call sites the slices cannot see ---------------------------------
var t8 = t7b.then(function () {
  console.log('\nstructural (call sites outside the sliced regions)');
  A.ok('the engine warms the notes each refresh', coreFull.indexOf('fetchNotesApi(woIdent);') !== -1, 'refresh() call site missing');
  A.ok('the manual "Set ECD..." path warms them too', coreFull.indexOf('fetchNotesApi(currentWOId());') !== -1, 'ecdHelperOpen call site missing');
  A.ok('a dialog opened mid-read re-proposes when the history lands', coreFull.indexOf('notesOnRead(ecdWoNum, function () {') !== -1, 're-propose wiring missing');
  A.ok('...but never over an edit the coordinator made', coreFull.indexOf('if (touched || document.getElementById(\'bwn-ecd-overlay\') !== ov') !== -1, 'touched guard missing');
  A.ok('the shared bwnNotesApi block is still the one Deep Scan uses', coreFull.indexOf('  // ===== BEGIN bwnNotesApi =====') !== -1, 'transport block missing');

  // ---- The field moved off data-testid, and the write moved off the DOM (2026-09-03) --------
  // Umbrava rebuilt the WO form: the header holds no inputs, the pickers lost their testids for
  // a `name` equal to their API field path, and no button on the page reads "Save". Reading by
  // the old testid returned nothing, which is why maybeAutoECD's `if (!ecdFieldInput()) return;`
  // kept the popup silent no matter what the suppressor did.
  A.ok('the ECD field is addressed by its form NAME, not the retired testid',
    coreFull.indexOf("var ECD_FIELD = 'priority.expectedCompletionDate';") !== -1, 'ECD_FIELD is not the name');
  A.ok('no reader anywhere still queries the retired date-picker testids',
    coreFull.indexOf('work-order-expected-completion-date-picker') === -1 &&
    coreFull.indexOf('work-order-first-trip-date-picker') === -1, 'a retired testid is still queried');
  A.ok('the first-trip read moved with it', coreFull.indexOf("woFieldVal('priority.firstTripDate')") !== -1, 'first-trip read not remapped');
  A.ok('a PO accordion cannot shadow the WO field (a PO form carries the same names)',
    coreFull.indexOf('[data-testid^="POAccordion-"]') !== -1 &&
    /woFieldInput[\s\S]{0,400}POAccordion/.test(coreFull), 'woFieldInput does not exclude PO rows');
  A.ok('Apply writes through the audited API, not by typing into the page',
    coreFull.indexOf('waEcdSubmit(apply, woNum, dt.toISOString()') !== -1, 'the Apply handler is not on waEcdSubmit');
  A.ok('...and the DOM writer is gone with the Save button it depended on',
    coreFull.indexOf('ecdFlagSave') === -1 && coreFull.indexOf('ecdSaveButton') === -1, 'the dead Save machinery survives');
  A.ok('the ECD write is a whole-object priority replace (siblings blank if dropped)',
    coreFull.indexOf('function waPriorityWriteValue(readPriority, newEcd)') !== -1, 'waPriorityWriteValue missing');

  // ---- The 2026-09-04 re-pop, whose two halves sit outside every slice ----------------
  A.ok('a successful write leaves the echo dueStatus reads',
    coreFull.indexOf("BWN.ssSetJSON('bwn:ecdset:' + wo,") !== -1, 'waSetEcd does not record the echo - the page stays stale');
  // The guard holds the WO NUMBER it fired for, so it re-arms by itself on a WO change.
  // Nulling it on a path change re-armed it on a TAB HOP inside one WO (/details -> /notes),
  // which is exactly how the prompt came back on a WO whose ECD had just been set. The only
  // `= null` left must be the declaration.
  // The guard is cleared in exactly two places: its declaration, and on LEAVING the WO.
  // A tab hop inside one WO must not re-arm it - that was the 1.81.8 re-pop, when any path
  // change cleared it. But a route with no WO at all (the board, a client, a vendor) ends the
  // visit, and coming back must ask again if the date is still missing or overdue: without
  // that, the popup fired on a first visit and never on a return, because on a warm revisit
  // the note read short-circuits on the cached history and its refresh - the one that carried
  // the cold path - never happens.
  A.eq('the auto-pop guard is cleared in exactly one place besides its declaration',
    (coreFull.match(/ecdAutoShownFor = null/g) || []).length, 2);
  A.ok('...its declaration', coreFull.indexOf('var ecdAutoShownFor = null;') !== -1, 'the guard declaration moved');
  A.ok('...and the other is gated on having left the WO, not on the path changing',
    coreFull.indexOf('if (!currentWOId()) ecdAutoShownFor = null;') !== -1,
    'the re-arm is not gated on leaving the WO');
  A.ok('the route handler still does that reset (it is inside the path-change block)',
    /location\.pathname !== lastPath[\s\S]{0,1600}if \(!currentWOId\(\)\) ecdAutoShownFor = null;/.test(coreFull),
    'the reset is not in the route-change block');

  // ---- BWN-SHARED export/import contract ----------------------------------------------
  // The shared block is an IIFE that hangs its helpers off BWN; every module then re-imports
  // them (`var inputVal = BWN.inputVal;`). Defining a helper there is NOT enough to make it
  // reachable, and neither `node --check` nor a harness that stubs the helper can tell -
  // both were green while woFieldVal was undefined at all six of its call sites. CI's eslint
  // caught it as no-undef. This probe is the local version of that catch.
  ['bwn-suite-core.user.js', 'bwn-suite-ai.user.js'].forEach(function (f) {
    var src = readLF(path.join(__dirname, '..', f));
    // Everything before the export line is the shared block's own scope, where the helpers
    // see each other directly (woFieldVal calls woFieldInput there). Only a call in MODULE
    // code - after that line - needs an import.
    var exportAt = src.indexOf('inputVal: inputVal');
    A.ok(f + ': the BWN-SHARED export list is where it was', exportAt !== -1, 'export block moved');
    var moduleCode = src.slice(exportAt);
    ['woFieldInput', 'woFieldVal'].forEach(function (name) {
      var usedBare = new RegExp('[^.\\w]' + name + '\\s*\\(').test(moduleCode);
      if (!usedBare) return;
      A.ok(f + ': ' + name + ' is exported on BWN',
        src.indexOf(name + ': ' + name) !== -1, 'defined but never exported - unreachable from any module');
      A.ok(f + ': ' + name + ' is imported into the module scope that calls it',
        new RegExp('=\\s*BWN\\.' + name + '\\b').test(src), 'exported but never imported - no-undef at every call site');
    });
  });

  console.log('\n(auto-warm x auto-pop gate x proposal x write echo, real source, 7 mutations. Nothing here proves');
  console.log(' the popup renders, that Umbrava answers in a real tab, or that the proposed date is');
  console.log(' the one the coordinator wanted - the live test on a WO with a noted ETA covers that.)');
  A.finish();
});

t8.catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
