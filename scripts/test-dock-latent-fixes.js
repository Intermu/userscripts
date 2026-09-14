// test-dock-latent-fixes.js - node harness for the three latent launcher-dock defects that the
// v2.0.2 multi-lens review left open ("fix on the next push that happens for another reason").
//
// THE THREE DEFECTS, as found in source:
//   1. `ensureStyle()` sat BELOW both of renderDock's early returns (not-host, zero-registrants).
//      Those two states are exactly where Core runs alone, so the one page that most needs a
//      deleted #bwn-launch-style repaired was the one page that never got it. Blast radius is a
//      cosmetically unstyled fallback pill, not a strand.
//   2. `dockAmHost` was a ONE-WAY LATCH - assigned true once at init, false on losing an
//      election, with no reclaim anywhere. Any script on the page can emit
//      `bwn:evt {id:'bwn:dock:host', priority:999}` and permanently demote the dock for that page
//      load. Latent only because Umbrava emits nothing on this bus.
//   3. `dockRoster` was a plain `{}`, so a registrant using the key '__proto__' hit the inherited
//      setter instead of creating an own property: no row, no diagnostic, AND the entry became
//      inherited - after which unregistered keys satisfied the `dockRoster[d.key]` gates on update
//      and unregister. A gate bypass, not just a dropped row. The bypass keys are the ones whose
//      entry value is truthy - 'seen', 'weight', 'minRank', 'key' - NOT 'order', which the vault
//      note names; see the measured correction at the unregister probe below.
//
// Drives the REAL shipped bytes: slices the dock module out of bwn-suite-core.user.js and runs it
// against a fake DOM on a virtual clock, following the injection signature of
// scripts/test-wo-audit-retry-floor.js. Nothing here proves the dock RENDERS - that is the live
// Umbrava test on the open-work board. What it proves is which branches reach ensureStyle, that
// host demotion is now recoverable, and that the roster no longer inherits anything.
//
// Every mutation below reverts one fix in the sliced source and asserts THIS harness goes red.
// mutate() throws if its target string is absent or not unique, so a mutation that silently fails
// to apply cannot masquerade as a passing negative control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dock-latent-fixes.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var START = '// ---- Shared launcher dock (bwn:dock:* host)';
var END = '// Command-palette bridge';

function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf(START);
  var b = t.indexOf(END, a);
  if (a === -1 || b === -1) throw new Error('dock markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = extractSection();

// Fails loudly rather than silently no-opping - a mutation that does not apply would otherwise
// read as "the negative control passed".
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- fake DOM -------------------------------------------------------------------------------
function makeEl(tag) {
  var el = {
    tagName: String(tag).toUpperCase(), id: '', className: '', title: '', type: '', alt: '',
    src: '', draggable: true, tabIndex: 0, style: {}, attrs: {}, children: [], parent: null,
    listeners: {},
    get firstChild() { return this.children.length ? this.children[0] : null; },
    get textContent() { return this.children.map(function (c) { return c.textContent || ''; }).join(''); },
    set textContent(v) { this.children = []; if (v) this.children.push({ textContent: String(v), children: [] }); },
    appendChild: function (c) { c.parent = el; el.children.push(c); return c; },
    remove: function () {
      if (!el.parent) return;
      var i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    setAttribute: function (k, v) { el.attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    addEventListener: function (t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    focus: function () { }
  };
  return el;
}

function makeDoc() {
  var byId = {};
  var doc = {
    body: makeEl('body'), head: makeEl('head'),
    documentElement: { style: { setProperty: function () { } } },
    busListeners: [],
    createElement: function (t) { return makeEl(t); },
    createElementNS: function (ns, t) { var e = makeEl(t); e.ns = ns; return e; },
    getElementById: function (id) {
      // Walk what the module actually appended, so a .remove() really un-finds the node.
      var hit = null;
      (function walk(n) {
        if (hit) return;
        if (n.id === id) { hit = n; return; }
        n.children.forEach(function (c) { if (c.children) walk(c); });
      })(doc.body);
      return hit || (Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null);
    },
    register: function (el) { byId[el.id] = el; },   // for nodes the harness itself plants
    addEventListener: function (t, fn) { if (t === 'bwn:evt') doc.busListeners.push(fn); },
    dispatchEvent: function (ev) { doc.busListeners.slice().forEach(function (fn) { fn(ev); }); return true; }
  };
  return doc;
}

// ---- module loader --------------------------------------------------------------------------
// `transform` lets a negative control revert one fix in the real sliced source.
function load(transform, opts) {
  var section = transform ? transform(SECTION) : SECTION;
  var now = 1700000000000;
  var doc = makeDoc();
  var emitted = [];            // every bwn:evt this module put on the bus
  var ensureStyleCalls = [];   // branch label at each ensureStyle() call
  var beats = [];              // heartbeat callbacks captured instead of run
  var renders = 0;
  var guardErrors = [];

  var store = {};
  // Seed a KNOWN rank (5) so policy-classified rows clear the fail-closed rank floor - the dock's
  // in-section seed block reads exactly this slot. dockVisible now hides every row when the rank is
  // unknown, so a probe that wants the unknown-rank path passes { noRank: true }.
  if (!(opts && opts.noRank)) store['bwn:role:last'] = JSON.stringify({ ok: true, rank: 5, ts: now });
  var localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }
  var VDate = function (a) { return a === undefined ? new Date(now) : new Date(a); };
  VDate.now = function () { return now; };
  var BWN = {
    guard: function (fn) {
      return function () {
        try { return fn.apply(this, arguments); }
        catch (e) { guardErrors.push(String(e && e.message || e)); }
      };
    },
    beat: function () { }
  };
  // scheduleDockRender's 120ms debounce runs inline: this harness asserts on WHICH branch ran,
  // never on a rate, per the vault's headless-harness-cannot-time note.
  function fakeSetTimeout(fn) { fn(); return 0; }
  function fakeClearTimeout() { }
  function fakeSetInterval(fn) { beats.push(fn); return 0; }

  var pre =
    "'use strict';\n" +
    'var DOCK_ID = "bwn-launch", DOCK_STACK_ID = "bwn-launch-dock-stack";\n' +
    // Real value, so the logo <img> src the full render path builds is the shipped one.
    "var LAUNCHER_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';\n" +
    'function ensureStyle() { __ensureStyleCalls.push(1); }\n' +
    // The rail now also filters rows on the reader's Umbrava permissions (BWN-PERM block, ledgered
    // by test-perm-block-ledger.js). __can is injected so a case can deny a specific key; the
    // default allows everything, which is what every pre-existing case below expects.
    'function bwnCanAll(keys) { if (!keys) return true; var a = (typeof keys === "string") ? [keys] : keys; for (var i = 0; i < a.length; i++) { if (!__can(a[i])) return false; } return true; }\n' +
    // dockVisible now reads the decoded permission slot directly for its fail-CLOSED perm branch.
    // __permSlotRef.cur is null (decode not ready) unless a case sets it via api.setPermSlot.
    'function bwnPermSlot() { return __permSlotRef.cur; }\n' +
    'function toolItems() { return []; }\n' +
    'function openSuitePanel() { }\n' +
    'function ensureDock() { }\n';
  var post =
    '\nreturn {\n' +
    '  renderDock: renderDock,\n' +
    '  beat: function () { __beats.forEach(function (f) { f(); }); },\n' +
    '  hostId: dockHostId,\n' +
    '  state: function () { return { amHost: dockAmHost, keys: Object.keys(dockRoster), vis: dockVisible().length, visKeys: dockVisible().map(function (e) { return e.key; }), sig: dockSig }; }\n' +
    '};\n';

  var permDeny = {};   // 'Group.Flag' -> true; set through api.denyPerm below
  function canFn(k) { return !permDeny[k]; }
  var permSlotRef = { cur: null };   // the decoded { groups, granted } dockVisible sees; null = not ready

  var fn = new Function(
    'document', 'localStorage', 'CustomEvent', 'Date', 'setTimeout', 'clearTimeout', 'setInterval',
    'BWN', '__ensureStyleCalls', '__beats', '__can', '__permSlotRef',
    pre + section + post
  );
  var mod = fn(doc, localStorage, CustomEvent, VDate, fakeSetTimeout, fakeClearTimeout,
    fakeSetInterval, BWN, ensureStyleCalls, beats, canFn, permSlotRef);

  // Watch the bus from outside so the module's own emissions are observable.
  doc.addEventListener('bwn:evt', function (ev) { emitted.push(ev.detail); });

  var api = {
    now: function () { return now; },
    advance: function (ms) { now += ms; return api; },
    emit: function (detail) { doc.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail })); return api; },
    // A foreign host that keeps announcing, the way a live second host would.
    foreignHost: function (id, priority) { return api.emit({ id: 'bwn:dock:host', hostId: id || 'other', priority: priority == null ? 999 : priority, ts: now }); },
    foreignPing: function (id) { return api.emit({ id: 'bwn:dock:ping', hostId: id || 'other' }); },
    register: function (key, extra) {
      var d = { id: 'bwn:dock:register', key: key, label: key.toUpperCase() };
      if (extra) Object.keys(extra).forEach(function (k) { d[k] = extra[k]; });
      return api.emit(d);
    },
    denyPerm: function (key) { permDeny[key] = true; return api; },
    setPermSlot: function (groups, granted) { permSlotRef.cur = { groups: groups || [], granted: granted || [] }; return api; },
    render: function () { renders++; mod.renderDock(); return api; },
    beat: function () { mod.beat(); return api; },
    styleCalls: function () { return ensureStyleCalls.length; },
    resetStyleCalls: function () { ensureStyleCalls.length = 0; return api; },
    emittedIds: function () { return emitted.map(function (d) { return d.id; }); },
    resetEmitted: function () { emitted.length = 0; return api; },
    guardErrors: function () { return guardErrors.slice(); },
    state: mod.state,
    hostId: mod.hostId,
    doc: doc,
    // Plant the fallback pill the way ensureDock would, so the pill-hide paths have a node.
    plantPill: function () { var p = makeEl('div'); p.id = 'bwn-launch'; doc.body.appendChild(p); return p; }
  };
  return api;
}

// ---- the three probes -----------------------------------------------------------------------
// Each returns booleans only, so the same code can assert PASS on real source and FAIL on a
// mutant. A probe that throws counts as false rather than killing the run.
function probeStyleHoist() {
  var r = { demoted: false, zeroReg: false, normal: false };
  try {
    var m = load();
    m.plantPill();
    // (a) demoted page: renderDock returns at the not-host branch.
    m.foreignHost('winner', 999);
    m.resetStyleCalls().render();
    r.demoted = m.styleCalls() === 1;
    // (b) zero registrants: Core running alone, the empty-roster branch.
    var z = load();
    z.plantPill();
    z.resetStyleCalls().render();
    r.zeroReg = z.styleCalls() === 1 && z.state().vis === 0;
    // (c) regression guard: the rendering path still ensures the stylesheet.
    var n = load();
    n.plantPill();
    n.register('cc');
    n.resetStyleCalls().render();
    r.normal = n.styleCalls() === 1 && n.state().vis === 1;
  } catch (e) { r.threw = String(e && e.message || e); }
  return r;
}

function probeHostReclaim() {
  var r = { demotes: false, holdsInsideTtl: false, reclaims: false, liveWinnerBlocks: false, ownPingIgnored: false };
  try {
    var m = load();
    m.plantPill();
    m.register('cc');
    m.foreignHost('spoof', 999);
    r.demotes = m.state().amHost === false;

    // Inside the TTL the winner is presumed alive: no reclaim.
    m.advance(20000).beat();
    r.holdsInsideTtl = m.state().amHost === false;

    // Past the TTL with silence: reclaim, and announce so registrants refill the roster.
    m.resetEmitted().advance(50000).beat();
    var ids = m.emittedIds();
    r.reclaims = m.state().amHost === true &&
      ids.indexOf('bwn:dock:host') !== -1 && ids.indexOf('bwn:dock:ping') !== -1;

    // A winner that is genuinely alive pings every DOCK_PING_MS. Total elapsed here is 100s,
    // well past the 65s TTL, but no single gap is - so the dock must stay demoted.
    var live = load();
    live.plantPill();
    live.foreignHost('winner', 999);
    for (var i = 0; i < 5; i++) { live.advance(20000).foreignPing('winner'); live.beat(); }
    r.liveWinnerBlocks = live.state().amHost === false;

    // Our OWN ping must not hold the reclaim off - same document, same listener.
    var own = load();
    own.plantPill();
    own.foreignHost('spoof', 999);
    own.advance(70000).emit({ id: 'bwn:dock:ping', hostId: own.hostId }).beat();
    r.ownPingIgnored = own.state().amHost === true;
  } catch (e) { r.threw = String(e && e.message || e); }
  return r;
}

function probeRosterPollution() {
  var r = { ownProperty: false, rendersRow: false, updateGateShut: false, unregisterGateShut: false, realKeyStillWorks: false };
  try {
    var m = load();
    m.plantPill();
    m.register('__proto__', { weight: -999, minRank: 9999 });
    var st = m.state();
    r.ownProperty = st.keys.indexOf('__proto__') !== -1;
    // '__proto__' is an unclassified key, so the fail-CLOSED policy hides it (the point of Fix 3 is
    // that it becomes a benign OWN property that pollutes nothing - not that it renders a row).
    r.rendersRow = st.vis === 0;

    // The gate bypass, observed through the render each gate triggers rather than through the
    // roster keys - `delete` on an INHERITED property changes no own key, so a key comparison
    // cannot tell the bypass from a shut gate. scheduleDockRender's debounce runs inline here and
    // renderDock's first statement is ensureStyle(), so a style-call bump means the event got in.
    var sBefore = m.styleCalls(), eBefore = m.guardErrors().length;
    m.emit({ id: 'bwn:dock:update', key: 'weight', label: 'pwned' });
    // Pre-fix, dockRoster['weight'] resolved to the inherited entry's NUMBER 50: the gate passed
    // and `en.label = String(...)` then threw TypeError against a primitive under 'use strict'.
    r.updateGateShut = m.styleCalls() === sBefore && m.guardErrors().length === eBefore;

    var sBefore2 = m.styleCalls();
    m.emit({ id: 'bwn:dock:unregister', key: 'seen' });
    // Pre-fix, the inherited 'seen' timestamp satisfied the gate, so a key nobody ever registered
    // triggered a roster delete and a full rebuild.
    //
    // CORRECTION to the finding as written in wiki/bwn-launcher-dock.md, measured by the negative
    // control below: the bypass keys are the ones whose entry value is TRUTHY - 'seen' (always a
    // timestamp), 'weight', 'minRank', 'key'. The note names 'order', which does NOT bypass:
    // `var ex = dockRoster['__proto__']` reads the CURRENT prototype (Object.prototype) before the
    // assignment, so `order: ex ? ex.order : ++dockOrderSeq` takes the `ex.order` branch and
    // stores undefined. 'label', 'icon', 'badge' and 'title' are '' and do not bypass either.
    r.unregisterGateShut = m.styleCalls() === sBefore2;

    // Regression guard: a real key still registers, updates and unregisters.
    var n = load();
    n.plantPill();
    n.register('cc');
    n.emit({ id: 'bwn:dock:update', key: 'cc', label: 'CC v2' });
    var mid = n.state();
    n.emit({ id: 'bwn:dock:unregister', key: 'cc' });
    r.realKeyStillWorks = mid.vis === 1 && n.state().keys.length === 0 && n.guardErrors().length === 0;
  } catch (e) { r.threw = String(e && e.message || e); }
  return r;
}

function allTrue(o) {
  return Object.keys(o).every(function (k) { return o[k] === true; });
}

// ---- real source ----------------------------------------------------------------------------
console.log('\n== FIX 1: ensureStyle() hoisted above both early returns');
var s = probeStyleHoist();
A.ok('demoted page (not-host branch) repairs the stylesheet', s.demoted === true, JSON.stringify(s));
A.ok('zero-registrant page (Core alone) repairs the stylesheet', s.zeroReg === true, JSON.stringify(s));
A.ok('rendering path still repairs it (no regression)', s.normal === true, JSON.stringify(s));

console.log('\n== FIX 2: dockAmHost is no longer a one-way latch');
var h = probeHostReclaim();
A.ok('a higher-priority host still demotes us', h.demotes === true, JSON.stringify(h));
A.ok('no reclaim inside the TTL', h.holdsInsideTtl === true, JSON.stringify(h));
A.ok('reclaim after TTL of silence, and re-announce', h.reclaims === true, JSON.stringify(h));
A.ok('a live winner pinging every 20s blocks the reclaim for 100s', h.liveWinnerBlocks === true, JSON.stringify(h));
A.ok('our own ping does not hold the reclaim off', h.ownPingIgnored === true, JSON.stringify(h));

console.log('\n== FIX 3: dockRoster has no prototype to pollute');
var p = probeRosterPollution();
A.ok("'__proto__' becomes an OWN property", p.ownProperty === true, JSON.stringify(p));
A.ok("'__proto__' is hidden by policy (unclassified), never a phantom row", p.rendersRow === true, JSON.stringify(p));
A.ok("update gate shut against key 'weight'", p.updateGateShut === true, JSON.stringify(p));
A.ok("unregister gate shut against key 'seen'", p.unregisterGateShut === true, JSON.stringify(p));
A.ok('a real key still registers/updates/unregisters', p.realKeyStillWorks === true, JSON.stringify(p));

// ---- negative controls ----------------------------------------------------------------------
// Each reverts ONE fix in the real sliced source and requires the matching probe to go red. If a
// probe stays green here, it is not testing the fix.
console.log('\n== NEGATIVE CONTROLS (each must make the probe above go red)');

var HOISTED =
  '      ensureStyle();\n' +
  '      if (!dockAmHost) { removeDockStack(); return; }';
var ZEROREG_LINE = "if (!vis.length) { if (stack) stack.remove(); if (pill) pill.style.display = ''; dockSig = ''; publishDockWidth(0); return; }";

var m1 = probeStyleHoistWith(function (src) {
  // Put ensureStyle() back where it was: below not-host AND below zero-registrants.
  var s1 = mutate(src, HOISTED, '      if (!dockAmHost) { removeDockStack(); return; }');
  return mutate(s1, ZEROREG_LINE, ZEROREG_LINE + '\n      ensureStyle();');
});
A.ok('un-hoisting ensureStyle breaks the demoted-page probe', m1.demoted === false, JSON.stringify(m1));
A.ok('un-hoisting ensureStyle breaks the zero-registrant probe', m1.zeroReg === false, JSON.stringify(m1));
A.ok('un-hoisting leaves the rendering path green (it always worked)', m1.normal === true, JSON.stringify(m1));

var m2 = probeHostReclaimWith(function (src) {
  return mutate(src,
    '      if (!dockAmHost) {\n        if (Date.now() - dockOtherSeen <= DOCK_TTL_MS) return;\n        dockAmHost = true; dockSig = \'\';   // roster went stale while demoted; the announce refills it\n      }',
    '      if (!dockAmHost) return;');
});
A.ok('restoring the one-way latch breaks the reclaim probe', m2.reclaims === false, JSON.stringify(m2));
A.ok('restoring the latch breaks the own-ping probe', m2.ownPingIgnored === false, JSON.stringify(m2));
A.ok('demotion itself still works with the latch (old behaviour)', m2.demotes === true, JSON.stringify(m2));

var m3 = probeRosterPollutionWith(function (src) {
  return mutate(src, 'var dockRoster = Object.create(null);', 'var dockRoster = {};');
});
A.ok("plain {} roster loses the '__proto__' entry entirely", m3.ownProperty === false, JSON.stringify(m3));
A.ok('plain {} roster reopens the unregister gate bypass', m3.unregisterGateShut === false, JSON.stringify(m3));
A.ok('plain {} roster still handles a real key (the bug was silent)', m3.realKeyStillWorks === true, JSON.stringify(m3));

// Probe variants that take a source transform. Declared last, hoisted by function declaration.
function probeStyleHoistWith(t) { return withSection(t, probeStyleHoist); }
function probeHostReclaimWith(t) { return withSection(t, probeHostReclaim); }
function probeRosterPollutionWith(t) { return withSection(t, probeRosterPollution); }
function withSection(t, probe) {
  var real = SECTION;
  SECTION = t(real);          // mutate() inside t throws if the target is absent or ambiguous
  try { return probe(); } finally { SECTION = real; }
}

// ---- 4. every registrant that can appear on the rail has a line icon -----------------------
// Reported live 2026-08-03: "Escalate" showed a RED flag and "Email RFP" a blue envelope beside
// eleven monochrome line icons. Cause: `DOCK_ICONS` had no entry for the `assist` or `bidout`
// keys, and dockRowEl falls back to whatever emoji the registrant sent. That fallback is right
// for an UNKNOWN tool and wrong for a shipped one - and nothing failed, because a missing icon
// is a silently different-looking row, not an error.
// Derived from the SIBLING SCRIPTS rather than a hardcoded list, so a tool added later that
// registers a new key without an icon fails here instead of shipping mismatched.
function registrantKeys() {
  var dir = path.join(__dirname, '..');
  return fs.readdirSync(dir)
    .filter(function (f) { return /\.user\.js$/.test(f) && f !== 'bwn-suite-core.user.js'; })
    .map(function (f) {
      var t = fs.readFileSync(path.join(dir, f), 'utf8');
      var m = t.match(/var DOCK_KEY = '([^']+)'/);
      // only scripts that actually register a rail row
      return (m && /bwn:dock:register/.test(t)) ? { file: f, key: m[1] } : null;
    })
    .filter(Boolean);
}
// Returns the registrants with no icon entry, so the control can assert on the RESULT rather
// than registering a deliberate failure into the suite counters - the idiom the probes above use.
function missingIcons(section) {
  var map = section.slice(section.indexOf('var DOCK_ICONS = {'), section.indexOf('function dockIcon('));
  return registrantKeys().filter(function (r) {
    return !new RegExp("(^|[\\s,{])'?" + r.key + "'?\\s*:").test(map);
  });
}
var regs = registrantKeys();
A.ok('icons: found the registrants to check', regs.length >= 5, 'only found ' + regs.length);
A.eq('icons: every rail registrant has a built-in line icon, so none falls back to an emoji',
  missingIcons(SECTION).map(function (r) { return r.key + ' (' + r.file + ')'; }), []);

// The two that were actually missing, pinned by name so a future edit cannot quietly drop them.
A.ok('icons: Escalate (assist) is a line icon, not the red flag emoji', /(^|[\s,{])assist\s*:/.test(SECTION));
A.ok('icons: Email RFP (bidout) is a line icon, not the envelope emoji', /(^|[\s,{])bidout\s*:/.test(SECTION));

// Control: drop one entry and the check must SEE it. Without this, "the icon set is complete" is
// an assertion nobody has watched fail.
var m4 = missingIcons(mutate(SECTION, "      bidout: ['M4 6h16v12H4z', 'M4 7l8 6 8-6'],\n", ''));
A.ok('removing the bidout icon is detected by the completeness check',
  m4.length === 1 && m4[0].key === 'bidout', JSON.stringify(m4));

// ---- fail-CLOSED dock visibility policy (BWN_DOCK_POLICY) -----------------------------------
// A row shows ONLY when the reader's rank is KNOWN and >= the tool's minRank, and (when the
// policy lists perms) the decode is ready and every checkbox is granted. Every unknown hides.
// ---- policy completeness: every rail registrant is classified ------------------------------
// The fail-closed gate HIDES any unclassified key, so a registrant added without a
// BWN_DOCK_POLICY entry would silently vanish for everyone (the wo-extract near-miss). Derive the
// keys from the sibling scripts AND core's own internal registrants, so a new tool fails here
// instead of shipping invisible.
console.log('\n--- policy completeness (every registrant has a BWN_DOCK_POLICY entry) ---');
function policyKeys(section) {
  var re = /BWN_DOCK_POLICY\['([^']+)'\]/g, m, out = [];
  while ((m = re.exec(section))) out.push(m[1]);
  return out;
}
function coreInternalKeys() {
  var re = /var DOCK_KEY = '([^']+)'/g, t = fs.readFileSync(SRC, 'utf8'), m, out = [];
  while ((m = re.exec(t))) out.push(m[1]);
  return out;
}
function unclassified(section) {
  var have = policyKeys(section);
  var keys = registrantKeys().map(function (r) { return r.key; }).concat(coreInternalKeys());
  return keys.filter(function (k, i, a) { return a.indexOf(k) === i && have.indexOf(k) === -1; });
}
A.eq('every rail registrant (siblings + core-internal) has a policy entry',
  unclassified(SECTION), []);
// Control: drop wo-extract's entry and the check must see it.
var m5 = unclassified(mutate(SECTION,
  "    BWN_DOCK_POLICY['wo-extract']  = { minRank: 1, perms: [] };  // Ops Assist - read-only WO context\n", ''));
A.ok('removing a policy entry is detected by the completeness check',
  m5.length === 1 && m5[0] === 'wo-extract', JSON.stringify(m5));

// The final shipped policy, asserted per rank tier. dispatch is registered directly here to
// exercise Core's rank floor; live, bwn-dispatch ALSO keeps its Pending-Dispatch context gate
// (registrant-side, additive - not exercised by this Core harness).
console.log('\n--- dock visibility policy (rank floor, fail-closed) ---');
(function () {
  var ALL = ['ask', 'assist', 'inventory', 'cc', 'bidout', 'wo-extract', 'bulk-source', 'wo-audit', 'dispatch', 'operate', 'bulk-ops'];
  var RANK1 = ['ask', 'assist', 'inventory', 'cc', 'bidout', 'wo-extract'];
  function atRank(rank) {
    var m = (rank == null) ? load(null, { noRank: true }) : load();
    if (rank != null) m.emit({ id: 'bwn:role', rank: rank });
    ALL.forEach(function (k) { m.register(k); });
    return m;
  }
  function has(m, k) { return m.state().visKeys.indexOf(k) !== -1; }

  // Rank 1 = a coordinator like Daniel: exactly the six rank-1 rows, by name.
  var r1 = atRank(1);
  A.eq('rank 1 sees exactly six rows', r1.state().vis, 6);
  RANK1.forEach(function (k) { A.ok('rank 1 sees ' + k, has(r1, k)); });
  ['bulk-source', 'wo-audit', 'dispatch', 'operate', 'bulk-ops'].forEach(function (k) {
    A.ok('rank 1 does NOT see ' + k, !has(r1, k));
  });
  A.eq('the hidden higher-rank rows are still registered, not dropped', r1.state().keys.length, 11);

  // Each tier adds exactly the tools at its floor.
  var r2 = atRank(2);
  A.eq('rank 2 adds bulk-source (7 total)', r2.state().vis, 7);
  A.ok('rank 2 sees bulk-source', has(r2, 'bulk-source'));
  A.ok('rank 2 still does NOT see wo-audit', !has(r2, 'wo-audit'));

  var r3 = atRank(3);
  A.eq('rank 3 adds wo-audit + dispatch (9 total)', r3.state().vis, 9);
  A.ok('rank 3 sees wo-audit', has(r3, 'wo-audit'));
  A.ok('rank 3 sees dispatch', has(r3, 'dispatch'));
  A.ok('rank 3 still does NOT see operate', !has(r3, 'operate'));

  var r4 = atRank(4);
  A.eq('rank 4 adds operate + bulk-ops (all 11)', r4.state().vis, 11);
  A.ok('rank 4 sees operate', has(r4, 'operate'));
  A.ok('rank 4 sees bulk-ops', has(r4, 'bulk-ops'));

  // An unclassified key is hidden at any rank - warned, not dropped.
  r4.register('totally-unknown-tool');
  A.eq('an unclassified key stays hidden even at rank 4', r4.state().vis, 11);
  A.ok('...but it is still on the roster, not dropped', r4.state().keys.indexOf('totally-unknown-tool') !== -1);

  // Unknown rank hides EVERYTHING - the pending-state contract - then resolves without re-register.
  var nr = atRank(null);
  A.eq('unknown rank hides every row (nothing flashes before rank resolves)', nr.state().vis, 0);
  nr.emit({ id: 'bwn:role', rank: 1 });
  A.eq('...and the six rank-1 rows appear once rank resolves, no re-register', nr.state().vis, 6);
})();

// ---- permission branch (fail-closed when a policy entry lists perms) ------------------------
// No shipped policy entry lists perms today, so exercise the branch by temporarily giving 'cc' a
// required checkbox in the real sliced source.
console.log('\n--- permission branch (fail-closed) ---');
(function () {
  var withPerm = function (t) {
    return mutate(t, "BWN_DOCK_POLICY['cc']          = { minRank: 1, perms: [] };",
      "BWN_DOCK_POLICY['cc']          = { minRank: 1, perms: ['WorkOrderNote.AddNew'] };");
  };
  var a = load(withPerm);
  a.register('cc');
  A.eq('decode not ready -> the perm-gated row is hidden', a.state().vis, 0);

  var b = load(withPerm);
  b.setPermSlot(['WorkOrderNote'], ['WorkOrderNote.AddNew']).register('cc');
  A.eq('decode ready + checkbox granted -> visible', b.state().vis, 1);

  var c = load(withPerm);
  c.setPermSlot(['WorkOrderNote'], []).register('cc');       // group present, bit OFF
  A.eq('decode ready + checkbox denied -> hidden', c.state().vis, 0);

  var d = load(withPerm);
  d.setPermSlot(['Task'], ['Task.AddNew']).register('cc');   // group absent from the decode
  A.eq('a permission whose group the tenant never sent does not hide the row', d.state().vis, 1);
})();

// Control: revert the fail-closed rank floor and a below-floor row with an unknown rank shows.
var noRankGate = mutate(SECTION,
  'if (dockRank == null || dockRank < pol.minRank) return false;',
  'if (false) return false;');
var cg = load(function () { return noRankGate; }, { noRank: true });
cg.register('operate');   // minRank 4, rank unknown
A.eq('CONTROL: without the rank gate, an unqualified row shows', cg.state().vis, 1);

console.log('\n(3 latent-defect fixes x real source + their mutations, the rail icon-set check, and' +
  ' the fail-closed visibility policy - rank floor + permission branch. Nothing here proves the' +
  ' rail RENDERS - that is the live Umbrava dock test on the open-work board.)');
A.finish();
