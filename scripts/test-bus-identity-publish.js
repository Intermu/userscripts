// test-bus-identity-publish.js - node harness for the split bus publish (Core 1.66.19).
//
// THE DEFECT, diagnosed 2026-08-03 after dispatch queue row 466 went out carrying the WO number
// as its Tracking #:
//   Core's `refresh()` published the WO bus payload only at the very END of the function, behind
//   a gate that returns early unless a PO accordion or a rendered note summary is in the DOM. A
//   WO in Pending Dispatch has NO POs at all, and a brand-new one has no notes either for the
//   first seconds of its life (W-383441: created 14:55:59, first note +11s). A tab loaded inside
//   that window satisfies neither anchor, and then never publishes - republishing is event-driven
//   rather than on a timer (measured: gaps of 18.0s then 1.0s) and sessionStorage is per-tab.
//   The dispatch modal's synchronous `busGet` therefore read nothing, and its pre-fill fallback
//   stamped the WO number into the Tracking field.
//
// Measured, read-only, in the live app on four WOs (383443 / 383441 / 383452 / 383450): the
// header testid is intact and correct on all four, and the publish DOES run on a 0-PO WO because
// the client's intake note supplies the second anchor. So the gate is not always fatal - it is
// fatal only inside the window. This harness pins the fix, not the window.
//
// THE FIX: header identity does not depend on POs or notes, so it publishes above the gate via
// `busPatch` (merge, skipping blanks); the full computed payload still publishes below via
// `busPut` (replace, authoritative, and free to write blanks).
//
// Two kinds of assertion here, deliberately:
//   1. BEHAVIOUR - busPatch is sliced out of the shipped bytes and run against a fake
//      sessionStorage. Merge, blank-skip, and version handling are executed, not read.
//   2. ORDER - the identity publish must sit ABOVE the anchor gate. That is a property of where
//      the code is, not of what it computes, so it is asserted against the source text. A fix
//      that is correct but in the wrong place is exactly the failure being prevented.
//
// Every mutation reverts one piece and asserts THIS harness goes red. mutate() throws if its
// target is absent or not unique, so a mutation cannot silently no-op (see
// wiki/negative-control-silent-noop.md).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bus-identity-publish.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(src, start, end, what) {
  var a = src.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (src.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = src.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return src.slice(a, b);
}
function mutate(src, from, to, what) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET NOT FOUND (' + what + '): ' + from);
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE (' + what + '): ' + from);
  return src.replace(from, to);
}

// ---- 1. BEHAVIOUR: busPut + busPatch against a fake sessionStorage -------------------------
function build(src) {
  var S_PUT = slice(src, '    function busPut(id, data) {', '    function busHeatGet', 'busPut+busPatch');
  var store = {};
  var events = [];
  var sandbox = {
    console: console,
    sessionStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); }
    },
    document: { dispatchEvent: function (e) { events.push(e); } },
    CustomEvent: function (name, init) { this.type = name; this.detail = init && init.detail; },
    JSON: JSON, Date: Date, Object: Object,
    __store: store, __events: events
  };
  vm.createContext(sandbox);
  vm.runInContext(S_PUT, sandbox);
  return sandbox;
}

var IDENT = {
  tracking: '1273641', wo: 'W-383441', location: 'Flying J PFJ 0674',
  client: 'Pilot Travel Centers', addr: '1 campbranch rd, Warrenton, MO 63383',
  coordinator: 'Lisa Porzelt', sourceJob: '02170146', sourcePo: '170101426797',
  priority: 'P2 Next Day', trade: 'Roofing and Siding'
};

function checkFirstPublish(S, label) {
  S.busPatch('383441', IDENT);
  var d = JSON.parse(S.__store['bwn:wo:383441']);
  A.eq(label + ': identity reaches an EMPTY bus', d.tracking, '1273641');
  A.eq(label + ': and it is the client tracking number, not the WO number', d.tracking !== '383441', true);
  A.eq(label + ': the rest of the identity rides with it', [d.wo, d.coordinator, d.client],
    ['W-383441', 'Lisa Porzelt', 'Pilot Travel Centers']);
  A.eq(label + ': the entry is stamped v1 so busGet accepts it', d.v, 1);
  A.ok(label + ': and carries a timestamp', typeof d.ts === 'number' && d.ts > 0);
  return d;
}
var S = build(full);
checkFirstPublish(S, 'patch/first');

// The whole point of a PATCH: computed state published earlier must survive it.
function checkMergeKeepsComputed(S, label) {
  S.busPut('383112', { tracking: '1272451', wo: 'W-383112', gp: 111116, gpPct: 23.7, status: 'Scheduled', pos: [{ vendor: 'EVOLUTION' }] });
  S.busPatch('383112', { tracking: '1272451', wo: 'W-383112', coordinator: 'Mike Najarro' });
  var d = JSON.parse(S.__store['bwn:wo:383112']);
  A.eq(label + ': computed GP survives an identity patch', d.gp, 111116);
  A.eq(label + ': so does the PO list', d.pos && d.pos.length, 1);
  A.eq(label + ': and the patch still applies its own field', d.coordinator, 'Mike Najarro');
  return d;
}
checkMergeKeepsComputed(S, 'patch/merge');

// A field the header has not rendered yet must never overwrite a good earlier value.
function checkBlankSkip(S, label) {
  S.busPut('383443', { tracking: '1273665', wo: 'W-383443', coordinator: 'Daniel Russell', client: 'Bridgestone Americas' });
  S.busPatch('383443', { tracking: '1273665', wo: 'W-383443', coordinator: '', client: null, location: 'Silver Spring' });
  var d = JSON.parse(S.__store['bwn:wo:383443']);
  A.eq(label + ': a blank never clobbers a known coordinator', d.coordinator, 'Daniel Russell');
  A.eq(label + ': null never clobbers a known client', d.client, 'Bridgestone Americas');
  A.eq(label + ': a real value in the same patch still lands', d.location, 'Silver Spring');
  return d;
}
checkBlankSkip(S, 'patch/blank');

// A stale entry from an older contract version is replaced, not merged into.
function checkVersionGuard(S, label) {
  S.__store['bwn:wo:999999'] = JSON.stringify({ v: 0, tracking: 'STALE', junk: true });
  S.busPatch('999999', { tracking: '1111111' });
  var d = JSON.parse(S.__store['bwn:wo:999999']);
  A.eq(label + ': a v0 entry is discarded, not merged', d.junk, undefined);
  A.eq(label + ': and the new value stands', d.tracking, '1111111');
  return d;
}
checkVersionGuard(S, 'patch/version');

// Unparseable storage must not throw - the bus is best-effort.
function checkCorrupt(S, label) {
  S.__store['bwn:wo:888888'] = '{not json';
  S.busPatch('888888', { tracking: '2222222' });
  var d = JSON.parse(S.__store['bwn:wo:888888']);
  A.eq(label + ': corrupt storage is replaced rather than thrown on', d.tracking, '2222222');
  return d;
}
checkCorrupt(S, 'patch/corrupt');

// The full publish stays authoritative: it REPLACES, so it can clear a field the patch preserved.
function checkFullPublishWins(S, label) {
  S.busPatch('383450', { tracking: '1273698', coordinator: 'Team M' });
  S.busPut('383450', { tracking: '1273698', wo: 'W-383450', coordinator: '', status: 'Pending Dispatch' });
  var d = JSON.parse(S.__store['bwn:wo:383450']);
  A.eq(label + ': the full publish CAN write a field back to blank', d.coordinator, '');
  A.eq(label + ': and nothing from the patch lingers', d.status, 'Pending Dispatch');
  return d;
}
checkFullPublishWins(S, 'publish/authoritative');

// ---- 2. ORDER: the identity publish must sit ABOVE the anchor gate -------------------------
// The defect was never that identity was computed wrong - it was that the publish sat behind a
// gate identity does not depend on. A correct busPatch placed below the gate fixes nothing, and
// no behavioural assertion above would notice, so the position is asserted directly.
// The gate is identified by its beat string, NOT by the '[data-testid^="POAccordion-"]'
// selector: that selector also appears in the NTE detection ~250k chars earlier, so an indexOf
// on it silently measured the wrong position and the order assertion failed against correct
// code. The harness caught it; the marker below is asserted unique so it cannot happen again.
var GATE = "BWN.beat('woAssist', 'waiting', 'WO anchors not rendered')";
var PATCH_CALL = 'busPatch(woIdent, {';
var FULL_CALL = 'busPut(woId, {';
// Same trap as GATE, hit a second time: `var woId = currentWOId();` is not unique in Core, so
// slicing from its FIRST occurrence swept in unrelated headerInfo() calls and failed against
// correct code. Anchor on the publish comment, and assert uniqueness rather than assume it.
var PUB_BLOCK = '      // Publish the canonical WO state for the rest of the suite.';
function checkOrder(src, label) {
  var gate = src.indexOf(GATE);
  var patch = src.indexOf(PATCH_CALL);
  var fullPub = src.indexOf(FULL_CALL);
  A.ok(label + ': the gate marker is unique, so these positions mean something',
    gate !== -1 && gate === src.lastIndexOf(GATE), 'gate marker missing or not unique');
  A.ok(label + ': the identity publish exists at all', patch !== -1, 'busPatch(woIdent, ...) not found');
  A.ok(label + ': identity publishes BEFORE the anchor gate', patch !== -1 && gate !== -1 && patch < gate,
    'patch@' + patch + ' gate@' + gate);
  A.ok(label + ': the full computed publish still runs after it', fullPub !== -1 && fullPub > patch,
    'full@' + fullPub + ' patch@' + patch);
  A.ok(label + ': identity is guarded on having read a header', src.indexOf('if (woIdent && (hd.tracking || hd.wo))') !== -1,
    'the woIdent/header guard is missing - an empty patch would stamp a bare {v,ts} entry');
  // The header read is hoisted above the gate and SHARED; the full publish must not re-run the
  // full-label DOM sweep. (Core has other headerInfo() callers - Copy Row has its own - so this
  // is scoped to the publish block rather than counted file-wide.)
  var pubStart = src.indexOf(PUB_BLOCK);
  A.ok(label + ': the publish-block marker is unique too',
    pubStart !== -1 && pubStart === src.lastIndexOf(PUB_BLOCK), 'publish marker missing or not unique');
  A.ok(label + ': the full publish reuses the hoisted header read',
    pubStart !== -1 && fullPub > pubStart && src.slice(pubStart, fullPub).indexOf('headerInfo(') === -1,
    'the full publish calls headerInfo() again');
  return true;
}
checkOrder(full, 'order');

// ---- negative controls ---------------------------------------------------------------------
function redUnder(name, mutated, probe, useSource) {
  var before = A.counts().fail;
  var subject;
  try { subject = useSource ? mutated : build(mutated); }
  catch (e) { console.log('  ok  - ' + name + ' threw at build: ' + e.message); return; }
  try { probe(subject, 'MUTANT ' + name); }
  catch (e) { console.log('  ok  - ' + name + ' threw: ' + e.message); return; }
  var after = A.counts().fail;
  console.log(after > before
    ? '  ---- control OK: ' + name + ' reddened ' + (after - before) + ' assertion(s)'
    : '  ---- CONTROL FAILED: ' + name + ' left the suite GREEN');
  if (after <= before) process.exitCode = 1;
}

var REAL = A.counts();
console.log('\nnegative controls (each reverts one piece; failures below are EXPECTED):');

redUnder('M1 the identity publish is deleted entirely',
  mutate(full, '        busPatch(woIdent, {', '        if (false) busPatchDISABLED(woIdent, {', 'M1'),
  checkOrder, true);

redUnder('M2 the identity publish is moved BELOW the anchor gate',
  (function () {
    // lift the whole identity block and re-insert it after the gate's closing brace
    var blockStart = full.indexOf('      var hd = headerInfo();');
    var blockEnd = full.indexOf('      if (!document.querySelector(\'[data-testid^="POAccordion-"]\')');
    if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) throw new Error('M2: block markers not found');
    var block = full.slice(blockStart, blockEnd);
    var rest = full.slice(0, blockStart) + full.slice(blockEnd);
    var anchor = "        BWN.beat('woAssist', 'waiting', 'WO anchors not rendered');\n        return;\n      }\n";
    var at = rest.indexOf(anchor);
    if (at === -1) throw new Error('M2: gate tail not found');
    return rest.slice(0, at + anchor.length) + block + rest.slice(at + anchor.length);
  })(),
  checkOrder, true);

redUnder('M3 busPatch clobbers with blanks instead of skipping them',
  mutate(full, "          if (data[k] === '' || data[k] == null) continue;", "          if (false) continue;", 'M3'),
  checkBlankSkip);

redUnder('M4 busPatch replaces instead of merging',
  mutate(full, "        if (!cur || typeof cur !== 'object' || cur.v !== 1) cur = {};", "        cur = {};", 'M4'),
  checkMergeKeepsComputed);

redUnder('M5 busPatch trusts a stale contract version',
  mutate(full, "        if (!cur || typeof cur !== 'object' || cur.v !== 1) cur = {};", "        if (!cur || typeof cur !== 'object') cur = {};", 'M5'),
  checkVersionGuard);

// M6 targets busPut ITSELF, not its call site. An earlier version of this control rewrote the
// `busPut(woId, {` call in refresh() and left the suite GREEN - the probe drives the sliced
// module directly and never executes refresh(), so the mutation could not reach it. Textbook
// silent no-op: see wiki/negative-control-silent-noop.md.
redUnder('M6 busPut merges instead of replacing, so it can never clear a field',
  mutate(full,
    "        sessionStorage.setItem('bwn:wo:' + id, JSON.stringify(data));\n        document.dispatchEvent",
    "        var prev = null; try { prev = JSON.parse(sessionStorage.getItem('bwn:wo:' + id) || 'null'); } catch (e) { }\n" +
    "        if (prev) { for (var pk in prev) if (data[pk] === '' || data[pk] == null) data[pk] = prev[pk]; }\n" +
    "        sessionStorage.setItem('bwn:wo:' + id, JSON.stringify(data));\n        document.dispatchEvent", 'M6'),
  checkFullPublishWins);

redUnder('M7 the full publish re-reads the header instead of reusing it',
  mutate(full, '      var woId = currentWOId();\n      if (woId) {\n        busPut(woId, {',
    '      var woId = currentWOId();\n      if (woId) {\n        var hd2 = headerInfo();\n        busPut(woId, {', 'M7'),
  checkOrder, true);

var after = A.counts();
console.log('\n' + (REAL.cases - REAL.fail) + '/' + REAL.cases + ' assertions passed' +
  (REAL.fail ? (', ' + REAL.fail + ' FAILED') : '') +
  '  (plus ' + (after.fail - REAL.fail) + ' expected failures from the 7 negative controls)');
process.exit((REAL.fail || process.exitCode) ? 1 : 0);
