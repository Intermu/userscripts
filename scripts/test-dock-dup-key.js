// test-dock-dup-key.js - pins the CURRENT behavior of the shared launcher dock (bwn:dock:* host in
// bwn-suite-core.user.js) for two roster edge cases, so a later change to either is deliberate:
//
//   1. DUPLICATE REGISTER. A second `bwn:dock:register` with a key already on the roster REPLACES the
//      entry wholesale - every field is rebuilt from the new payload (absent fields fall back to their
//      defaults, they are NOT merged from the old entry) - EXCEPT `order`, which is carried over so a
//      re-register (every registrant re-registers on each host/ping heartbeat) never reorders the rail.
//      No owner is recorded or checked, nothing warns, nothing is rejected.
//   2. UNKNOWN UPDATE. A `bwn:dock:update` for a key that is not on the roster is ignored: no entry is
//      created, no render is scheduled, nothing is emitted, nothing throws.
//
// This documents behavior; it does not endorse it. docs/core-compatibility-inventory.md (3.2) records
// the silent overwrite as a known cross-script collision risk. Change the behavior on purpose, then
// update this harness in the same change.
//
// Drives the REAL shipped bytes: slices the same dock section, with the same markers and injection
// signature, as scripts/test-dock-latent-fixes.js. The 120ms render debounce is captured, never run,
// so no fake DOM is needed - this harness asserts on roster state, never on markup. Every negative
// control reverts one behavior in the sliced source and asserts this harness goes red.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dock-dup-key.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var START = '// ---- Shared launcher dock (bwn:dock:* host)';
var END = '// Command-palette bridge';

var SECTION = (function () {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf(START);
  var b = t.indexOf(END, a);
  if (a === -1 || b === -1) throw new Error('dock markers not found in ' + SRC);
  return t.slice(a, b);
})();

// Throws if the target is absent or not unique, so a mutation that fails to apply cannot pass as a
// green negative control.
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function load(section) {
  var now = 1700000000000;
  var listeners = [];
  var emitted = [];
  var renders = 0;
  var guardErrors = [];
  var warns = [];
  // Known rank 5 so the classified keys used below clear dockVisible's fail-closed rank floor.
  var store = { 'bwn:role:last': JSON.stringify({ ok: true, rank: 5, ts: now }) };
  var doc = {
    addEventListener: function (t, fn) { if (t === 'bwn:evt') listeners.push(fn); },
    dispatchEvent: function (ev) { listeners.slice().forEach(function (fn) { fn(ev); }); return true; },
    getElementById: function () { return null; }
  };
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
        try { return fn.apply(this, arguments); } catch (e) { guardErrors.push(String(e && e.message || e)); }
      };
    },
    beat: function () { }
  };
  var fakeConsole = { warn: function () { warns.push([].slice.call(arguments).join(' ')); }, log: function () { }, info: function () { }, error: function () { } };

  var pre =
    "'use strict';\n" +
    'var DOCK_ID = "bwn-launch", DOCK_STACK_ID = "bwn-launch-dock-stack";\n' +
    "var LAUNCHER_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';\n" +
    'function ensureStyle() { }\n' +
    'function bwnCanAll() { return true; }\n' +
    'function bwnPermSlot() { return null; }\n' +
    'function toolItems() { return []; }\n' +
    'function openSuitePanel() { }\n' +
    'function ensureDock() { }\n';
  var post =
    '\nreturn {\n' +
    '  roster: function () { return dockRoster; },\n' +
    '  visKeys: function () { return dockVisible().map(function (e) { return e.key; }); }\n' +
    '};\n';

  var fn = new Function(
    'document', 'localStorage', 'CustomEvent', 'Date', 'setTimeout', 'clearTimeout', 'setInterval',
    'BWN', 'console',
    pre + section + post
  );
  var mod = fn(doc, localStorage, CustomEvent, VDate,
    function () { renders++; return 0; },   // scheduleDockRender's debounce: counted, never run
    function () { }, function () { return 0; }, BWN, fakeConsole);

  // Watch the bus from outside, after boot, so only reactions to this harness's events are seen.
  doc.addEventListener('bwn:evt', function (ev) { emitted.push(ev.detail); });

  var api = {
    emit: function (detail) { doc.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail })); return api; },
    advance: function (ms) { now += ms; return api; },
    reset: function () { renders = 0; emitted.length = 0; warns.length = 0; guardErrors.length = 0; return api; },
    renders: function () { return renders; },
    // Everything on the bus minus the harness's own inputs.
    emittedByDock: function () { return emitted.filter(function (d) { return d.id !== 'bwn:dock:register' && d.id !== 'bwn:dock:update'; }); },
    warns: function () { return warns.slice(); },
    guardErrors: function () { return guardErrors.slice(); },
    entry: function (k) { var r = mod.roster(); return Object.prototype.hasOwnProperty.call(r, k) ? r[k] : undefined; },
    keys: function () { return Object.keys(mod.roster()); },
    visKeys: mod.visKeys,
    now: function () { return now; }
  };
  return api;
}

// ---- probes: booleans only, so the same code asserts PASS on real source and FAIL on a mutant ----

function probeDuplicate(section) {
  var r = {};
  try {
    var m = load(section);
    m.emit({ id: 'bwn:dock:register', key: 'cc', label: 'CC Request', icon: 'card', weight: 40, badge: '3', minRank: 1, title: 'first', needPerm: 'Job.View' });
    m.emit({ id: 'bwn:dock:register', key: 'ask', label: 'Ask', weight: 40 });
    var first = m.entry('cc');
    var firstOrder = first.order, askOrder = m.entry('ask').order;
    m.advance(5000).reset();

    // Same key, different payload, from "another script" - the bus carries no owner to tell them apart.
    m.emit({ id: 'bwn:dock:register', key: 'cc', label: 'Impostor', weight: 40, title: 'second' });
    var e = m.entry('cc');

    r.stillOneEntry = m.keys().length === 2 && m.keys().filter(function (k) { return k === 'cc'; }).length === 1;
    r.labelReplaced = e.label === 'Impostor';
    r.titleReplaced = e.title === 'second';
    // Absent fields reset to defaults - replaced, not merged.
    r.iconCleared = e.icon === '';
    r.badgeCleared = e.badge === '';
    r.minRankCleared = e.minRank === null;
    r.needPermCleared = e.needPerm === null;
    r.orderKept = e.order === firstOrder && firstOrder < askOrder;
    r.seenRefreshed = e.seen === m.now();
    // Equal weights, so position is decided by order: cc still ahead of the later-registered ask.
    r.positionKept = JSON.stringify(m.visKeys()) === JSON.stringify(['cc', 'ask']);
    r.silent = m.warns().length === 0 && m.guardErrors().length === 0 && m.emittedByDock().length === 0;
    r.renderScheduled = m.renders() === 1;

    // Omitted weight falls back to the default 50 rather than keeping the old 40.
    m.emit({ id: 'bwn:dock:register', key: 'cc', label: 'Impostor' });
    r.weightDefaulted = m.entry('cc').weight === 50 && m.entry('cc').order === firstOrder;
  } catch (err) { r.threw = String(err && err.message || err); }
  return r;
}

function probeUnknownUpdate(section) {
  var r = {};
  try {
    var m = load(section);
    m.emit({ id: 'bwn:dock:register', key: 'cc', label: 'CC Request' });
    var before = JSON.stringify(m.entry('cc'));
    m.reset();

    m.emit({ id: 'bwn:dock:update', key: 'ask', label: 'Ghost', badge: '9' });

    r.noEntryCreated = m.entry('ask') === undefined && m.keys().length === 1;
    r.otherEntryUntouched = JSON.stringify(m.entry('cc')) === before;
    r.noRender = m.renders() === 0;
    r.silent = m.warns().length === 0 && m.guardErrors().length === 0 && m.emittedByDock().length === 0;
  } catch (err) { r.threw = String(err && err.message || err); }
  return r;
}

function allTrue(r, keys) { return keys.every(function (k) { return r[k] === true; }); }

// ---- real source ----------------------------------------------------------------------------
var d = probeDuplicate(SECTION);
var dj = JSON.stringify(d);
A.ok('duplicate register: no crash', !d.threw, dj);
A.ok('duplicate register: still one entry for the key', d.stillOneEntry === true, dj);
A.ok('duplicate register: label replaced by the second payload', d.labelReplaced === true, dj);
A.ok('duplicate register: title replaced by the second payload', d.titleReplaced === true, dj);
A.ok('duplicate register: omitted icon reset to empty (replace, not merge)', d.iconCleared === true, dj);
A.ok('duplicate register: omitted badge reset to empty', d.badgeCleared === true, dj);
A.ok('duplicate register: omitted minRank reset to null', d.minRankCleared === true, dj);
A.ok('duplicate register: omitted needPerm reset to null', d.needPermCleared === true, dj);
A.ok('duplicate register: omitted weight reset to default 50', d.weightDefaulted === true, dj);
A.ok('duplicate register: original order retained', d.orderKept === true, dj);
A.ok('duplicate register: rail position retained', d.positionKept === true, dj);
A.ok('duplicate register: seen timestamp refreshed', d.seenRefreshed === true, dj);
A.ok('duplicate register: no warning, rejection, error, or bus reply', d.silent === true, dj);
A.ok('duplicate register: one render scheduled', d.renderScheduled === true, dj);

var u = probeUnknownUpdate(SECTION);
var uj = JSON.stringify(u);
A.ok('unknown update: no crash', !u.threw, uj);
A.ok('unknown update: no entry created', u.noEntryCreated === true, uj);
A.ok('unknown update: registered entry untouched', u.otherEntryUntouched === true, uj);
A.ok('unknown update: no render scheduled', u.noRender === true, uj);
A.ok('unknown update: no warning, error, or bus reply', u.silent === true, uj);

// ---- negative controls: each reverts one pinned behavior and must turn the probe red ---------
var m1 = probeDuplicate(mutate(SECTION,
  'order: ex ? ex.order : (++dockOrderSeq)', 'order: (++dockOrderSeq)'));
A.ok('mutant: re-register takes a new order -> order/position probes go red',
  m1.orderKept === false && m1.positionKept === false, JSON.stringify(m1));

var m2 = probeDuplicate(mutate(SECTION,
  "icon: d.icon ? String(d.icon) : '',", "icon: d.icon ? String(d.icon) : (ex ? ex.icon : ''),"));
A.ok('mutant: register merges the old icon -> replace-not-merge probe goes red',
  m2.iconCleared === false && allTrue(m2, ['labelReplaced', 'orderKept']), JSON.stringify(m2));

var m3 = probeDuplicate(mutate(SECTION,
  "if (d.id === 'bwn:dock:register' && d.key) {",
  "if (d.id === 'bwn:dock:register' && d.key && !dockRoster[d.key]) {"));
A.ok('mutant: duplicate key rejected -> replacement probes go red',
  m3.labelReplaced === false && m3.titleReplaced === false, JSON.stringify(m3));

var m4 = probeUnknownUpdate(mutate(SECTION,
  "} else if (d.id === 'bwn:dock:update' && d.key && dockRoster[d.key]) {\n        var en = dockRoster[d.key];",
  "} else if (d.id === 'bwn:dock:update' && d.key) {\n        var en = dockRoster[d.key] || (dockRoster[d.key] = { key: d.key, order: ++dockOrderSeq });"));
A.ok('mutant: update upserts an unknown key -> no-entry probe goes red',
  m4.noEntryCreated === false, JSON.stringify(m4));

A.finish();
