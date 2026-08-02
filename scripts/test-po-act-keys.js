// test-po-act-keys.js - node harness for the PO act re-key (render index -> stable sid,
// the "PO act keys embed RENDER INDEX" board item, built 2026-08-02).
//
// THE DEFECT, both halves, as found in source:
//   PO act keys were 'pomat:<renderIndex>:<vendor>' where renderIndex came from the
//   POAccordion-<n> testid, which RE-SEQUENCES when a PO is added or cancelled. Half 1:
//   checked state stored under the old index orphans (the authored-item defect class
//   Phase 0 fixed). Half 2, worse: structConvergeReason looked the PO up BY that index to
//   auto-check steps, so after a re-sequence it read the WRONG PO's done flag - a
//   false-CHECK path, violating the fail-safe contract (never false-check an open step).
//
// THE FIX, as sliced from source:
//   readPOs() computes a stable per-PO `sid` via the same ladder the PO Approval override
//   key already proved (poKeyOf: Umbrava line number 'ln001' -> vendor GUID 'v<guid>' ->
//   render index 'ix<n>'), with a '-<num>' suffix when two POs collide on the GUID
//   fallback. Act keys carry the sid; display + navigation keep the render index via the
//   act's own `poNum`; poBySid replaces the render-index lookup; actsMigratePO migrates
//   old bare-digit store keys once per WO (exactly-one-vendor-match rule; ambiguous or
//   vanished vendors leave the record inert - unchecked-reappears is the safe direction).
//
// Drives the REAL shipped bytes: slices vendorOf/readPOs, poKeyOf, actsMigratePO,
// poBySid/structConvergeReason and actNav out of bwn-suite-core.user.js and runs them
// against fake PO rows. Nothing here proves the checklist RENDERS - the live Phase 2 dock
// test covers that.
//
// Every mutation below reverts one piece in the sliced source and asserts THIS harness
// goes red. mutate() throws if its target string is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-po-act-keys.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return coreFull.slice(a, b);
}

var S_READPOS = slice('    function vendorOf(row) {', '    // Open tasks - surfaced', 'vendorOf+readPOs');
var S_POKEYOF = slice('    function poKeyOf(row) {', '    function poIsSupplier', 'poKeyOf');
var S_MIGRATE = slice('    // ONE-TIME per-WO store migration', '    var actsMigratedPOFor', 'actsMigratePO');
var S_CONVERGE = slice('    // Sid lookup, NOT render-index lookup', '    function autoDetectActioned', 'poBySid+structConvergeReason');
var S_ACTNAV = slice('    function actNav(a) {', '    function actNavTarget', 'actNav');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- fake PO rows -------------------------------------------------------------------------
// Just enough DOM for vendorOf/readPOs/poKeyOf: textContent, getAttribute('data-testid'),
// querySelectorAll('h6' | '*'), querySelector('a[href*="/vendors/"]').
function makeRow(o) {
  var h6s = (o.lineNo ? [o.lineNo] : []).map(function (t) { return { textContent: t, children: [] }; });
  var leaves = h6s.slice();
  return {
    getAttribute: function (k) { return k === 'data-testid' ? 'POAccordion-' + o.idx : null; },
    textContent: o.text,
    querySelectorAll: function (sel) {
      if (sel === 'h6') return h6s;
      if (sel === '*') return leaves;
      return [];
    },
    querySelector: function (sel) {
      if (sel.indexOf('/vendors/') !== -1 && o.guid) return { getAttribute: function () { return '/vendors/' + o.guid; } };
      return null;
    }
  };
}
function rowText(vendor, status, amt) {
  // vendorOf takes the first \n-line without a '$' (len>2), so the vendor leads; the
  // status region is isolated behind the date exactly like a real accordion row reads.
  return vendor + '\n01/15/2026 ' + status + ' $' + amt;
}
function makeCtx(rows) {
  var ctx = {
    console: { info: function () { } },
    document: { querySelectorAll: function (sel) { return sel.indexOf('POAccordion') !== -1 ? rows.slice() : []; } }
  };
  vm.createContext(ctx);
  vm.runInContext(S_POKEYOF + '\n' + S_READPOS, ctx);
  return ctx;
}

// ---- probes ---------------------------------------------------------------------------------
function probeSidLadder(readSrc) {
  var rows = [
    makeRow({ idx: 1, lineNo: '001', guid: 'aaaa1111-2222', vendor: 'ACME A', text: rowText('ACME FACILITIES', 'Material Ordered', '1,200.00') }),
    makeRow({ idx: 2, guid: 'bbbb3333-4444', text: rowText('BRAVO SIGNS LLC', 'Pending Acceptance', '900.00') }),
    makeRow({ idx: 3, text: rowText('CHARLIE HVAC CORP', 'Confirm Complete', '2,500.00') }),
    makeRow({ idx: 4, guid: 'bbbb3333-4444', text: rowText('BRAVO SIGNS LLC', 'Material Ordered', '450.00') })
  ];
  var ctx = {
    console: { info: function () { } },
    document: { querySelectorAll: function (sel) { return sel.indexOf('POAccordion') !== -1 ? rows.slice() : []; } }
  };
  vm.createContext(ctx);
  vm.runInContext(S_POKEYOF + '\n' + (readSrc || S_READPOS), ctx);
  var pos = ctx.readPOs();
  var r = { sids: pos.map(function (p) { return p.sid; }), nums: pos.map(function (p) { return p.num; }) };
  r.lineNoWins = pos[0].sid === 'ln001';
  r.guidFallback = pos[1].sid === 'vbbbb3333-4444';
  r.indexLastResort = pos[2].sid === 'ix3';
  r.collisionSuffixed = pos[3].sid === 'vbbbb3333-4444-4';
  r.numStaysRenderIndex = pos.map(function (p) { return p.num; }).join(',') === '1,2,3,4';
  r.statusStillClassified = pos[0].poStatus === 'materials' && pos[1].poStatus === 'accept' && pos[2].poStatus === 'confirm';
  return r;
}

// The survival property the whole re-key exists for: the SAME PO keeps the SAME sid after
// the list re-sequences (a PO above it cancelled and vanished), while the render index moves.
function probeSidStability(readSrc) {
  var mk = function (idx) { return makeRow({ idx: idx, lineNo: '002', guid: 'cccc5555', text: rowText('DELTA ELECTRIC INC', 'Material Ordered', '700.00') }); };
  var before = makeCtx([makeRow({ idx: 1, lineNo: '001', text: rowText('ACME FACILITIES', 'Pending Acceptance', '100.00') }), mk(2)]);
  var after = { rows: [mk(1)] };
  var ctxA = {
    console: { info: function () { } },
    document: { querySelectorAll: function (sel) { return sel.indexOf('POAccordion') !== -1 ? after.rows.slice() : []; } }
  };
  vm.createContext(ctxA);
  vm.runInContext(S_POKEYOF + '\n' + (readSrc || S_READPOS), ctxA);
  var pB = before.readPOs(), pA = ctxA.readPOs();
  var delta = pB[1], same = pA[0];
  return {
    sidStableAcrossResequence: delta.sid === same.sid,
    renderIndexMoved: delta.num !== same.num,
    keyWouldSurvive: ('pomat:' + delta.sid + ':DELTA ELECTRIC INC') === ('pomat:' + same.sid + ':DELTA ELECTRIC INC')
  };
}

function probeConverge(src) {
  var ctx = { nvVendor: function (s) { return String(s || '').toUpperCase(); }, console: console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  var state = {
    pos: [
      { sid: 'ln001', num: '1', vendor: 'ACME', done: true, poStatus: '' },
      { sid: 'ln002', num: '2', vendor: 'DELTA', done: false, poStatus: 'materials' }
    ]
  };
  var r = {};
  // The false-check shape: DELTA's step, DELTA open - but after a re-sequence DELTA renders
  // at index 1 while ACME (done) holds the OLD index the key used to carry. A sid lookup
  // stays on DELTA and converges nothing.
  r.openStepStaysOpen = ctx.structConvergeReason({ key: 'pomat:ln002:DELTA' }, state) === null;
  r.doneStepConverges = ctx.structConvergeReason({ key: 'poconf:ln001:ACME' }, state) === 'PO 1 is marked done';
  r.reasonShowsRenderIndex = /PO 1 /.test(ctx.structConvergeReason({ key: 'poconf:ln001:ACME' }, state) || '');
  r.vanishedPoConvergesNothing = ctx.structConvergeReason({ key: 'pomat:ln999:GONE' }, state) === null;
  r.statusMoveConverges = ctx.structConvergeReason({ key: 'pomat:ln001:ACME' }, state) !== null;
  return r;
}

function probeMigrate(src) {
  var ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  var pos = [
    { sid: 'ln005', num: '1', vendor: 'ACME FACILITIES' },
    { sid: 'ln007', num: '2', vendor: 'BRAVO SIGNS LLC' },
    { sid: 'ln008', num: '3', vendor: 'BRAVO SIGNS LLC' },
    { sid: 'ln009', num: '4', vendor: 'ACME: EAST DIVISION' }
  ];
  var r = {};

  var d1 = { 'pomat:2:ACME FACILITIES': { done: 1, note: 'chased' }, 'ecd': { done: 1 }, 'phase:client': { done: 1 }, 'authored:ab3': { done: 1 } };
  var out1 = ctx.actsMigratePO(d1, pos);
  r.mapsUniqueVendor = !!out1 && !!d1['pomat:ln005:ACME FACILITIES'] && d1['pomat:ln005:ACME FACILITIES'].note === 'chased' && !d1['pomat:2:ACME FACILITIES'];
  r.nonPoKeysUntouched = !!d1['ecd'] && !!d1['phase:client'] && !!d1['authored:ab3'];

  var d2 = { 'poacc:1:BRAVO SIGNS LLC': { done: 1 } };
  r.ambiguousVendorLeftInert = ctx.actsMigratePO(d2, pos) === null && !!d2['poacc:1:BRAVO SIGNS LLC'];

  var d3 = { 'pocost:3:VANISHED CORP': { done: 1 } };
  r.vanishedVendorLeftInert = ctx.actsMigratePO(d3, pos) === null && !!d3['pocost:3:VANISHED CORP'];

  var d4 = { 'pomat:2:ACME FACILITIES': { done: 1, note: 'old' }, 'pomat:ln005:ACME FACILITIES': { done: 1, note: 'new' } };
  ctx.actsMigratePO(d4, pos);
  r.existingNewKeyNotClobbered = d4['pomat:ln005:ACME FACILITIES'].note === 'new' && !d4['pomat:2:ACME FACILITIES'];

  var d5 = { 'pomat:ln005:ACME FACILITIES': { done: 1 } };
  r.newFormAlreadyMigrated = ctx.actsMigratePO(d5, pos) === null;

  var d6 = { 'poconf:7:ACME: EAST DIVISION': { done: 1 } };
  ctx.actsMigratePO(d6, pos);
  r.colonVendorMaps = !!d6['poconf:ln009:ACME: EAST DIVISION'];
  return r;
}

function probeActNav() {
  var ctx = {};
  vm.createContext(ctx);
  vm.runInContext(S_ACTNAV, ctx);
  var r = {};
  var n1 = ctx.actNav({ key: 'pomat:ln001:ACME', poNum: '2' });
  r.navRidesPoNum = !!n1 && n1.kind === 'po' && n1.num === '2';
  var n2 = ctx.actNav({ key: 'pocost:ln009:ACME' });
  r.fallsBackToKeyPart = !!n2 && n2.num === 'ln009';
  r.ecdUnchanged = (ctx.actNav({ key: 'ecd' }) || {}).kind === 'ecd';
  r.anchorNull = ctx.actNav({ key: 'pomat:ln001:A', anchor: true }) === null;
  return r;
}

// ---- run: real source -------------------------------------------------------------------
console.log('PO act re-key (render index -> stable sid) - real source');

var l = probeSidLadder();
A.ok('line number wins the ladder (ln001)', l.lineNoWins, JSON.stringify(l));
A.ok('vendor GUID is the fallback (v<guid>)', l.guidFallback, JSON.stringify(l));
A.ok('render index is the last resort (ix3)', l.indexLastResort, JSON.stringify(l));
A.ok('GUID collision gets the -<num> suffix', l.collisionSuffixed, JSON.stringify(l));
A.ok('p.num still carries the render index', l.numStaysRenderIndex, JSON.stringify(l));
A.ok('status classification unchanged by the re-key', l.statusStillClassified, JSON.stringify(l));

var s = probeSidStability();
A.ok('SAME PO keeps SAME sid after a re-sequence', s.sidStableAcrossResequence, JSON.stringify(s));
A.ok('...while the render index moved', s.renderIndexMoved, JSON.stringify(s));
A.ok('so the act key survives the re-sequence', s.keyWouldSurvive, JSON.stringify(s));

var c = probeConverge(S_CONVERGE);
A.ok('open step stays open (no false-check)', c.openStepStaysOpen, JSON.stringify(c));
A.ok('done PO still auto-converges its step', c.doneStepConverges, JSON.stringify(c));
A.ok('converge reason shows the render index, not the sid', c.reasonShowsRenderIndex, JSON.stringify(c));
A.ok('vanished PO converges NOTHING (fail-safe)', c.vanishedPoConvergesNothing, JSON.stringify(c));
A.ok('pomat converges when the PO left materials', c.statusMoveConverges, JSON.stringify(c));

var m = probeMigrate(S_MIGRATE);
A.ok('old key maps when exactly one vendor matches', m.mapsUniqueVendor, JSON.stringify(m));
A.ok('non-PO keys untouched', m.nonPoKeysUntouched, JSON.stringify(m));
A.ok('ambiguous vendor leaves the record inert', m.ambiguousVendorLeftInert, JSON.stringify(m));
A.ok('vanished vendor leaves the record inert', m.vanishedVendorLeftInert, JSON.stringify(m));
A.ok('an existing new-key record is not clobbered', m.existingNewKeyNotClobbered, JSON.stringify(m));
A.ok('already-migrated stores return null (no churn)', m.newFormAlreadyMigrated, JSON.stringify(m));
A.ok('a vendor name containing a colon still maps', m.colonVendorMaps, JSON.stringify(m));

var n = probeActNav();
A.ok('navigation rides act.poNum (render index)', n.navRidesPoNum, JSON.stringify(n));
A.ok('nav falls back to the key part when poNum absent', n.fallsBackToKeyPart, JSON.stringify(n));
A.ok('ecd nav unchanged', n.ecdUnchanged, JSON.stringify(n));
A.ok('anchor act navs nowhere', n.anchorNull, JSON.stringify(n));

// Structural: the four engine act keys ride p.sid + carry poNum, and the render layer
// runs the migration before the store is read.
A.ok('all four PO act keys ride p.sid', (coreFull.match(/'(?:pomat|poacc|poconf|pocost):' \+ p\.sid \+ ':' \+ p\.vendor/g) || []).length === 4, 'expected 4 sid-keyed acts.push');
A.ok('all four PO acts carry poNum: p.num', (coreFull.match(/poNum: p\.num/g) || []).length === 4, 'expected 4 poNum properties');
A.ok('no PO act key still rides p.num', (coreFull.match(/'(?:pomat|poacc|poconf|pocost):' \+ p\.num/g) || []).length === 0, 'a render-index key survives');
A.ok('renderActsInline runs the migration', coreFull.indexOf('actsMigratePO(actsLoad(), state.pos)') !== -1, 'hook missing');
A.ok('the three WO Assist version strings all read 2.65', /WO Assist 2\.65/.test(coreFull) && /Playbook v2\.65/.test(coreFull) && /WO Assist v2\.65 loaded/.test(coreFull), 'version strings drifted');

// ---- mutations: revert one piece each, assert the harness goes red -------------------------
console.log('\nmutations (each must redden its probe)');

// M1: sid degraded back to the render index - the survival property dies.
var m1 = probeSidStability(mutate(S_READPOS,
  '        var sid = poKeyOf(row);',
  '        var sid = num;'));
A.ok('M1 sid=renderIndex breaks sid stability across a re-sequence', m1.sidStableAcrossResequence === false, JSON.stringify(m1));

// M2: converge lookup reverted to num-match - the sid-keyed acts stop converging at all
// (and on the original bare-digit keys this exact shape was the false-check).
var m2 = probeConverge(mutate(S_CONVERGE,
  'if (String(ps[i].sid) === String(sid)) return ps[i];',
  'if (String(ps[i].num) === String(sid)) return ps[i];'));
A.ok('M2 num-match lookup breaks done-PO convergence', m2.doneStepConverges === false, JSON.stringify(m2));

// M3: ambiguity guard dropped - a two-PO vendor migrates onto whichever PO scanned last.
var m3 = probeMigrate(mutate(S_MIGRATE,
  'byVendor[v] = Object.prototype.hasOwnProperty.call(byVendor, v) ? null : p;',
  'byVendor[v] = p;'));
A.ok('M3 dropping the ambiguity guard breaks the inert-record probe', m3.ambiguousVendorLeftInert === false, JSON.stringify(m3));

// M4: collision suffix dropped - two same-GUID POs share one key again.
var m4 = probeSidLadder(mutate(S_READPOS,
  "        if (seenSids[sid]) sid = sid + '-' + num;",
  '        if (false) sid = sid + \'-\' + num;'));
A.ok('M4 dropping the collision suffix breaks key distinctness', m4.collisionSuffixed === false, JSON.stringify(m4));

console.log('\n(ladder/stability/converge/migration/nav x real source, 4 mutations. Nothing here');
console.log(' proves the checklist renders - the live Phase 2 dock test on the board covers that.)');
A.finish();
