// test-anchor-mounts.js - node harness for the two buttons that were parking themselves in the
// bottom-right corner of a WO page instead of anchoring into Umbrava's own header rows.
//
// WHAT WAS WRONG, measured live on app.umbrava.com 2026-08-04 (WO 380320 / tracking 1262210):
//   1. Core's tripCal export button was UNCONDITIONALLY `position:fixed;right:18px;bottom:18px`.
//      There was never an anchored path. Umbrava's Zendesk help bubble owns that corner and drew
//      over it, so the button read as missing. The Trips tab does have a natural slot: the
//      .MuiButtonGroup-root holding [trips-split-left-button] ("Schedule Trip") - the SAME group
//      the AI script's AI Draft bar injects into on the Notes tab, and the AI Draft bar survives
//      the tab switch as that group's first child. Anchoring there puts the export button exactly
//      where the user asked for it: next to AI Draft.
//   2. AI's jobView button DID have an anchored path (after
//      [data-testid="work-order-header-tracking-number"]) plus a ~10s floating fallback - but
//      mount() opened with `if (document.getElementById(BTN_ID)) return true`. Both paths use the
//      SAME id, so one slow load that reached the fallback made every later mount() a no-op: the
//      button stayed bottom-right for the whole SPA session even once the header rendered. It is
//      also appended to document.body, which no SPA route change unmounts - it was observed still
//      floating on the /work-orders LIST page.
//
// Drives the REAL shipped bytes: slices each mount region out of the two userscripts and runs it
// against a fake DOM, following the injection signature of scripts/test-dock-latent-fixes.js.
// This proves WHERE the nodes land in a tree and that repeated ticks do not churn it. It does NOT
// prove the live pixels - that gate is one real Trips-tab load, recorded on the open-work board.
//
// Every mutation below reverts one fix in the sliced source and asserts THIS harness goes red.
// mutate() throws if its target string is absent or not unique, so a mutation that silently fails
// to apply cannot masquerade as a passing negative control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-anchor-mounts.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var CORE = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var AI = path.join(__dirname, '..', 'bwn-suite-ai.user.js');

function slice(file, start, end, what) {
  var t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf(start), b = t.indexOf(end, a === -1 ? 0 : a);
  if (a === -1 || b === -1) throw new Error(what + ' markers not found in ' + file);
  return t.slice(a, b);
}

var TRIPCAL = slice(CORE,
  '    // The Trips tab\'s split-button group ("Schedule Trip")',
  '    var deb = null;', 'tripCal placement');
var JOBVIEW = slice(AI,
  '  // `data-bwn-float` is the marker mount() reads',
  '  var pollTimer = null, ticks = 0;', 'jobView mount');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- fake DOM -------------------------------------------------------------------------------
// Richer than the dock harness's: these modules move nodes BETWEEN parents, so parentNode,
// nextSibling and insertBefore all have to behave, and every insertBefore is counted so the
// "does a steady tick churn the DOM" probe has something to measure.
var inserts = 0;

function makeEl(tag) {
  var el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', type: '', title: '', disabled: false,
    style: { cssText: '' }, dataset: {}, attrs: {}, children: [], parentNode: null, listeners: {},
    get textContent() {
      return el.children.map(function (c) { return c.textContent || ''; }).join('') || el._text || '';
    },
    set textContent(v) { el.children = []; el._text = v == null ? '' : String(v); },
    get firstChild() { return el.children.length ? el.children[0] : null; },
    get nextSibling() {
      if (!el.parentNode) return null;
      var i = el.parentNode.children.indexOf(el);
      return i >= 0 && i + 1 < el.parentNode.children.length ? el.parentNode.children[i + 1] : null;
    },
    detach: function () {
      if (!el.parentNode) return;
      var i = el.parentNode.children.indexOf(el);
      if (i >= 0) el.parentNode.children.splice(i, 1);
      el.parentNode = null;
    },
    appendChild: function (c) { c.detach(); c.parentNode = el; el.children.push(c); return c; },
    insertBefore: function (c, ref) {
      inserts++;
      c.detach();
      c.parentNode = el;
      var i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
      return c;
    },
    remove: function () { el.detach(); },
    setAttribute: function (k, v) { el.attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    addEventListener: function (t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    querySelector: function (sel) { return find(el, sel, 1)[0] || null; },
    querySelectorAll: function (sel) { return find(el, sel, 0); }
  };
  return el;
}

// Only the two selector shapes these modules actually use: [data-testid="..."] and .class.
function matches(el, sel) {
  var m = sel.match(/^\[data-testid="([^"]+)"\]$/);
  if (m) return el.getAttribute('data-testid') === m[1];
  m = sel.match(/^\.([\w-]+)$/);
  if (m) return (' ' + (el.className || '') + ' ').indexOf(' ' + m[1] + ' ') !== -1;
  throw new Error('fake DOM: unsupported selector ' + sel);
}
function find(root, sel, limit) {
  var out = [];
  (function walk(n) {
    if (limit && out.length >= limit) return;
    n.children.forEach(function (c) {
      if (!c.children) return;
      if (matches(c, sel)) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

function makeDoc() {
  var doc = {
    body: makeEl('body'), head: makeEl('head'),
    createElement: function (t) { return makeEl(t); },
    getElementById: function (id) {
      var hit = null;
      (function walk(n) {
        if (hit) return;
        n.children.forEach(function (c) {
          if (hit || !c.children) return;
          if (c.id === id) { hit = c; return; }
          walk(c);
        });
      })(doc.body);
      return hit;
    },
    querySelector: function (sel) { return doc.body.querySelector(sel); },
    querySelectorAll: function (sel) { return doc.body.querySelectorAll(sel); }
  };
  return doc;
}

// The Trips tab's real shape, as measured: wrapper > div > MuiButtonGroup > [AI Draft bar,
// Schedule Trip, caret]. The AI Draft bar is present because Umbrava reuses this group across
// rail tabs - that is why "next to AI Draft" and "before trips-split-left-button" are the same
// slot.
function plantTripsAnchor(doc) {
  var row = makeEl('div'); row.className = 'UzzbQW_tabsAndButtonRow';
  var wrap = makeEl('div'); wrap.className = 'UzzbQW_woDetailsAddButtonWrapper';
  var group = makeEl('div'); group.className = 'MuiButtonGroup-root';
  var aiBar = makeEl('div'); aiBar.id = 'bwn-client-update-btn';
  var left = makeEl('button'); left.setAttribute('data-testid', 'trips-split-left-button');
  var right = makeEl('button'); right.setAttribute('data-testid', 'trips-split-right-button');
  group.appendChild(aiBar); group.appendChild(left); group.appendChild(right);
  wrap.appendChild(group); row.appendChild(wrap); doc.body.appendChild(row);
  return { group: group, left: left, aiBar: aiBar };
}
function plantTripCard(doc) {
  var c = makeEl('div'); c.setAttribute('data-testid', 'purchase-order-trip-card');
  doc.body.appendChild(c); return c;
}
function plantWOHeader(doc) {
  var hdr = makeEl('div');
  var h6 = makeEl('h6'); h6.setAttribute('data-testid', 'work-order-header-tracking-number');
  h6.textContent = 'Tracking # 1262210';
  hdr.appendChild(h6); doc.body.appendChild(hdr);
  return { header: hdr, anchor: h6 };
}

// ---- tripCal loader -------------------------------------------------------------------------
function loadTripCal(transform) {
  var section = transform ? transform(TRIPCAL) : TRIPCAL;
  var doc = makeDoc();
  var route = { path: '/work-orders/380320/trips' };
  var beats = [];
  // Two live trips, both exportable, so exp.length is non-zero and the enabled/label writes run.
  var trips = [{ start: new Date(1700000000000), mins: 60, status: 'Scheduled', trip: '1', vendor: 'ACME SIGNS' },
    { start: new Date(1700086400000), mins: 60, status: 'Scheduled', trip: '2', vendor: 'ACME SIGNS' }];

  var pre =
    "'use strict';\n" +
    "var BTN_ID = 'bwn-tripcal-btn';\n" +
    'function onTrips() { return /\\/work-orders\\/\\d+\\/trips/.test(__route.path); }\n' +
    'function parseTrips() { return __trips.slice(); }\n' +
    'function publishTripSignal() { }\n' +
    'function exportable(t) { return t.slice(); }\n' +
    'function ensureStyle() { }\n' +
    'function woMeta() { return { tracking: "1262210", client: "", url: "" }; }\n' +
    'function buildICS() { return "BEGIN:VCALENDAR"; }\n' +
    'function download() { }\n' +
    'function currentWOId() { return "380320"; }\n';
  var post = '\nreturn { ensureBtn: ensureBtn, placeBtn: placeBtn, tripsAnchor: tripsAnchor };\n';

  var BWN = { GREEN: '#1a5f3e', beat: function (m, s, d) { beats.push(s + ':' + d); } };
  var fn = new Function('document', 'BWN', '__route', '__trips', pre + section + post);
  var mod = fn(doc, BWN, route, trips);

  return {
    doc: doc, route: route, mod: mod,
    beats: function () { return beats.slice(); },
    btn: function () { return doc.getElementById('bwn-tripcal-btn'); }
  };
}

// ---- jobView loader -------------------------------------------------------------------------
function loadJobView(transform) {
  var section = transform ? transform(JOBVIEW) : JOBVIEW;
  var doc = makeDoc();
  var route = { pathname: '/work-orders/380320/details' };
  var beats = [];

  var pre =
    "'use strict';\n" +
    "var BTN_ID = 'bwn-jv-launch';\n" +
    'function launch() { }\n';
  var post = '\nreturn { mount: mount, mountFloating: mountFloating, styleLaunchBtn: styleLaunchBtn };\n';

  var BWN = { guard: function (fn) { return fn; }, beat: function (m, s, d) { beats.push(s + ':' + d); } };
  var fn = new Function('document', 'BWN', 'location', pre + section + post);
  var mod = fn(doc, BWN, route);

  return {
    doc: doc, route: route, mod: mod,
    beats: function () { return beats.slice(); },
    btn: function () { return doc.getElementById('bwn-jv-launch'); }
  };
}

// ---- probes ---------------------------------------------------------------------------------
// Booleans only, so the same probe can assert PASS on real source and FAIL under a mutation.

// tripCal, anchor present from the first tick.
function probeTripAnchored(transform) {
  var h = loadTripCal(transform);
  var a = plantTripsAnchor(h.doc);
  plantTripCard(h.doc);
  h.mod.ensureBtn();
  var b = h.btn();
  return {
    mounted: !!b,
    inGroup: !!b && b.parentNode === a.group,
    beforeScheduleTrip: !!b && b.nextSibling === a.left,
    rightOfAIDraft: !!b && a.group.children.indexOf(b) === a.group.children.indexOf(a.aiBar) + 1,
    notFloating: !!b && b.dataset.bwnFloat !== '1',
    notOnBody: !!b && b.parentNode !== h.doc.body,
    count: (b ? 1 : 0) + '/' + h.doc.body.querySelectorAll('.bwn-tc-n').length
  };
}

// tripCal, anchor missing at first (slow rail render) then appearing.
function probeTripUpgrade(transform) {
  var h = loadTripCal(transform);
  plantTripCard(h.doc);
  h.mod.ensureBtn();
  var b1 = h.btn();
  var floatedFirst = !!b1 && b1.dataset.bwnFloat === '1' && b1.parentNode === h.doc.body;
  var a = plantTripsAnchor(h.doc);
  h.mod.ensureBtn();
  var b2 = h.btn();
  return {
    floatedFirst: floatedFirst,
    sameNode: b1 === b2,
    upgraded: !!b2 && b2.parentNode === a.group && b2.nextSibling === a.left,
    floatCleared: !!b2 && b2.dataset.bwnFloat !== '1'
  };
}

// A steady observer tick must not re-insert an already-correct node: that write is itself a
// mutation, and the observer that fires on it is the 500ms parse/write loop this module already
// had to be fixed for once.
function probeTripStable(transform) {
  var h = loadTripCal(transform);
  plantTripsAnchor(h.doc);
  plantTripCard(h.doc);
  h.mod.ensureBtn();
  var base = inserts;
  h.mod.ensureBtn(); h.mod.ensureBtn(); h.mod.ensureBtn();
  return { extraInserts: inserts - base };
}

// Leaving the Trips tab must take the button with it.
function probeTripLeaves(transform) {
  var h = loadTripCal(transform);
  plantTripsAnchor(h.doc);
  plantTripCard(h.doc);
  h.mod.ensureBtn();
  var was = !!h.btn();
  h.route.path = '/work-orders/380320/notes';
  h.mod.ensureBtn();
  return { was: was, gone: !h.btn() };
}

// jobView, header present from the first tick.
function probeJVAnchored(transform) {
  var h = loadJobView(transform);
  var p = plantWOHeader(h.doc);
  var ok = h.mod.mount();
  var b = h.btn();
  return {
    returned: ok === true,
    mounted: !!b,
    afterAnchor: !!b && p.anchor.nextSibling === b,
    inHeader: !!b && b.parentNode === p.header,
    notFixed: !!b && b.style.cssText.indexOf('position:fixed') === -1,
    notFloating: !!b && b.dataset.bwnFloat !== '1'
  };
}

// jobView, header missing long enough to hit the ~10s fallback, then appearing.
function probeJVUpgrade(transform) {
  var h = loadJobView(transform);
  var first = h.mod.mount();
  h.mod.mountFloating();
  var b1 = h.btn();
  var floated = !!b1 && b1.dataset.bwnFloat === '1' && b1.parentNode === h.doc.body
    && b1.style.cssText.indexOf('position:fixed') !== -1;
  // Umbrava's Zendesk help-widget launcher iframe was measured at bottom 15px..71px of the right
  // edge, so anything below 72px is drawn over. bottom:20px (the old value) is squarely inside it.
  var bottom = b1 ? (b1.style.cssText.match(/bottom:(\d+)px/) || [0, '0'])[1] : '0';
  var p = plantWOHeader(h.doc);
  var second = h.mod.mount();
  var b2 = h.btn();
  return {
    firstMountFalse: first === false,
    floated: floated,
    clearsHelpBubble: parseInt(bottom, 10) >= 72,
    secondMountTrue: second === true,
    sameNode: b1 === b2,
    upgraded: !!b2 && b2.parentNode === p.header && p.anchor.nextSibling === b2,
    floatCleared: !!b2 && b2.dataset.bwnFloat !== '1',
    noLongerFixed: !!b2 && b2.style.cssText.indexOf('position:fixed') === -1,
    single: h.doc.body.children.length === 2   // header + the (now empty) body row we never added
  };
}

// A fallback button on document.body outlives an SPA route change; the list page must drop it.
function probeJVListLeak(transform) {
  var h = loadJobView(transform);
  h.mod.mount();
  h.mod.mountFloating();
  var floated = !!h.btn();
  h.route.pathname = '/work-orders';
  var ret = h.mod.mount();
  return { floated: floated, returnedFalse: ret === false, gone: !h.btn() };
}

// An already-anchored button is left exactly where it is.
function probeJVIdempotent(transform) {
  var h = loadJobView(transform);
  var p = plantWOHeader(h.doc);
  h.mod.mount();
  var b1 = h.btn(), base = inserts;
  var ret = h.mod.mount();
  return {
    returnedTrue: ret === true,
    sameNode: b1 === h.btn(),
    stillAfterAnchor: p.anchor.nextSibling === b1,
    extraInserts: inserts - base
  };
}

// ---- real source ----------------------------------------------------------------------------
console.log('\n== tripCal: anchored into the Trips split-button group ==');
var t1 = probeTripAnchored();
A.ok('button mounts on the Trips tab', t1.mounted);
A.ok('lands inside the MuiButtonGroup, not on body', t1.inGroup && t1.notOnBody);
A.ok('sits immediately before "Schedule Trip"', t1.beforeScheduleTrip);
A.ok('sits immediately right of the AI Draft bar', t1.rightOfAIDraft);
A.ok('is not marked as a floating fallback', t1.notFloating);
A.eq('exactly one button in the tree', t1.count, '1/1');

console.log('\n== tripCal: fallback upgrades once the anchor renders ==');
var t2 = probeTripUpgrade();
A.ok('floats on body while the anchor is absent', t2.floatedFirst);
A.ok('reuses the same node (no duplicate button)', t2.sameNode);
A.ok('re-anchors into the group on a later tick', t2.upgraded);
A.ok('clears the floating marker after upgrading', t2.floatCleared);

console.log('\n== tripCal: a steady tick does not churn the DOM ==');
var t3 = probeTripStable();
A.eq('three further ensureBtn calls insert nothing', t3.extraInserts, 0);

console.log('\n== tripCal: button leaves with the tab ==');
var t4 = probeTripLeaves();
A.ok('present on /trips', t4.was);
A.ok('removed once the route is /notes', t4.gone);

console.log('\n== jobView: anchored after the tracking-number header ==');
var j1 = probeJVAnchored();
A.ok('mount() reports success', j1.returned);
A.ok('button inserted directly after the header anchor', j1.mounted && j1.afterAnchor && j1.inHeader);
A.ok('not position:fixed', j1.notFixed);
A.ok('not marked as a floating fallback', j1.notFloating);

console.log('\n== jobView: fallback upgrades instead of latching bottom-right ==');
var j2 = probeJVUpgrade();
A.ok('first mount fails with no header present', j2.firstMountFalse);
A.ok('fallback floats on body, position:fixed', j2.floated);
A.ok('fallback clears Umbrava\'s help widget (bottom >= 72px)', j2.clearsHelpBubble);
A.ok('later mount() succeeds once the header exists', j2.secondMountTrue);
A.ok('reuses the same node (no duplicate button)', j2.sameNode);
A.ok('re-anchors after the header anchor', j2.upgraded);
A.ok('clears the floating marker and the fixed positioning', j2.floatCleared && j2.noLongerFixed);

console.log('\n== jobView: no floating leak onto the WO list ==');
var j3 = probeJVListLeak();
A.ok('floating fallback exists on the WO page', j3.floated);
A.ok('mount() reports false off a WO page', j3.returnedFalse);
A.ok('floating button removed on the list route', j3.gone);

console.log('\n== jobView: re-mount is a no-op ==');
var j4 = probeJVIdempotent();
A.ok('reports success', j4.returnedTrue);
A.ok('same node, same position', j4.sameNode && j4.stillAfterAnchor);
A.eq('no second insert', j4.extraInserts, 0);

// ---- negative controls ----------------------------------------------------------------------
// Each reverts ONE fix in the real sliced source and asserts the probe above goes red. A control
// that stays green means the probe was never testing that fix.
console.log('\n== negative controls (each must make the probe above FAIL) ==');

var M_TC_BODY = function (s) {
  return mutate(s, '        placeBtn(btn);\n        BWN.beat(\'tripCal\', \'ok\', \'export button mounted\');',
    '        document.body.appendChild(btn);\n        BWN.beat(\'tripCal\', \'ok\', \'export button mounted\');');
};
var c1 = probeTripAnchored(M_TC_BODY);
A.ok('C1 tripCal appended to body again -> not anchored', !c1.inGroup && !c1.beforeScheduleTrip);

var M_TC_NO_REPLACE = function (s) { return mutate(s, '      } else placeBtn(btn);', '      }'); };
var c2 = probeTripUpgrade(M_TC_NO_REPLACE);
A.ok('C2 tripCal re-place dropped -> fallback never upgrades', c2.floatedFirst && !c2.upgraded);

var M_TC_UNGUARDED = function (s) {
  return mutate(s, '        if (btn.parentNode !== a.parentNode || btn.nextSibling !== a) a.parentNode.insertBefore(btn, a);',
    '        a.parentNode.insertBefore(btn, a);');
};
var c3 = probeTripStable(M_TC_UNGUARDED);
A.ok('C3 tripCal position guard dropped -> every tick re-inserts', c3.extraInserts === 3);

var M_JV_ANY = function (s) {
  return mutate(s, '      if (ex.dataset.bwnFloat !== \'1\') { BWN.beat(\'jobView\', \'ok\', \'launcher mounted\'); return true; }',
    '      if (ex) { BWN.beat(\'jobView\', \'ok\', \'launcher mounted\'); return true; }');
};
var c4 = probeJVUpgrade(M_JV_ANY);
A.ok('C4 jobView "any existing button wins" restored -> stays bottom-right', c4.floated && !c4.upgraded);

var M_JV_NO_CLEAN = function (s) {
  return mutate(s, '      if (ex && ex.dataset.bwnFloat === \'1\') ex.remove();', '      if (false) ex.remove();');
};
var c5 = probeJVListLeak(M_JV_NO_CLEAN);
A.ok('C5 jobView list-route cleanup dropped -> button leaks onto the list', c5.floated && !c5.gone);

var M_JV_LOW = function (s) { return mutate(s, 'bottom:78px;right:20px', 'bottom:20px;right:20px'); };
var c6 = probeJVUpgrade(M_JV_LOW);
A.ok('C6 jobView fallback back to bottom:20px -> under the help bubble', !c6.clearsHelpBubble);

A.finish();
