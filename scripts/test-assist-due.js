// test-assist-due.js - node harness for the bwn:assist:due severity handoff (the "Core
// does not emit bwn:assist:due" board item, closed 2026-08-02).
//
// WHAT SHIPPED, as sliced from source:
//   Core's engine already computed escSev (how far past the escalate clock, >=1 at fire)
//   but nothing carried it to bwn-wo-assist, whose listener + _pendingSev seam had been
//   waiting since Phase 3 step 1 ("the listener is the seam so it works the day it does").
//   Now: the escalate act carries `sev` (engine field, not part of the key or any stored
//   state), and a render-time armAssistDue() emits bwn:assist:due {escSev} - latched per
//   path+key per page load, gated on the assist registrant being LIVE so the event cannot
//   fire before a listener exists. The assist drawer consumes _pendingSev on open and
//   POSTs it as escSev, where the server owns the tier bump.
//
// Drives the REAL shipped bytes: slices the ACT_TOOL/waDock/armAssistDue block out of
// bwn-suite-core.user.js and runs it against a stub bus. Nothing here proves the checklist
// RENDERS or that the server bumps a tier - the live Phase 3 test on the open-work board
// covers the wire.
//
// Every mutation below reverts one piece in the sliced source and asserts THIS harness
// goes red. mutate() throws if its target string is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-due.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var ASSIST_SRC = path.join(__dirname, '..', 'bwn-wo-assist.user.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}

var coreFull = readLF(CORE_SRC);
var assistFull = readLF(ASSIST_SRC);
var CORE_SECTION = slice(coreFull,
  '    // PINNED against the live registrant table',
  '    // IN-PAGE NAVIGATION.',
  'core ACT_TOOL/armAssistDue block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function makeBusDoc() {
  var listeners = {};
  var log = [];
  return {
    log: log,
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: function (ev) {
      log.push({ type: ev.type, detail: ev.detail });
      (listeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); });
      return true;
    }
  };
}
function CustomEventStub(type, init) { this.type = type; this.detail = init && init.detail; }
function busEmit(doc, detail) { doc.dispatchEvent(new CustomEventStub('bwn:evt', { detail: detail })); }
function dues(doc) {
  return doc.log.filter(function (e) { return e.type === 'bwn:evt' && e.detail && e.detail.id === 'bwn:assist:due'; });
}

function probeArm(src) {
  var doc = makeBusDoc();
  var loc = { pathname: '/work-orders/381367' };
  var ctx = { document: doc, CustomEvent: CustomEventStub, Date: Date, console: console, location: loc };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  var act = { key: 'escalate:client:2', sev: 2.4 };
  var r = {};

  // Assist not registered yet: no emit, and the miss must NOT latch - the whole point of
  // the liveness gate is that assist coming online later still gets armed.
  ctx.armAssistDue(act, false);
  r.quietWhileAssistDead = dues(doc).length === 0;
  busEmit(doc, { id: 'bwn:dock:register', key: 'assist', label: 'Escalate' });
  ctx.armAssistDue(act, false);
  var d1 = dues(doc);
  r.armsOnceAssistLive = d1.length === 1;
  r.carriesEngineSev = d1.length === 1 && d1[0].detail.escSev === 2.4;
  r.doesNotForceOpen = d1.length === 1 && !d1[0].detail.open;

  // Latched per path+key: render runs constantly, the bus must not churn.
  ctx.armAssistDue(act, false);
  ctx.armAssistDue(act, false);
  r.latchedSamePage = dues(doc).length === 1;

  // A different WO (SPA nav) re-arms; the latch key includes the path.
  loc.pathname = '/work-orders/364040';
  ctx.armAssistDue(act, false);
  r.rearmsOnNav = dues(doc).length === 2;

  // A done row arms nothing (and must not latch a later not-done render out).
  loc.pathname = '/work-orders/999001';
  ctx.armAssistDue(act, true);
  r.doneRowQuiet = dues(doc).length === 2;
  ctx.armAssistDue(act, false);
  r.doneDidNotLatch = dues(doc).length === 3;

  // Only escalate rows with an engine sev arm.
  loc.pathname = '/work-orders/999002';
  ctx.armAssistDue({ key: 'stall:VENDOR', sev: 2 }, false);
  ctx.armAssistDue({ key: 'escalate:client:2' }, false);   // no sev field
  r.nonEscalateQuiet = dues(doc).length === 3;
  return r;
}

// ---- run: real source ----------------------------------------------------------------
console.log('bwn:assist:due severity handoff - real source');

var p = probeArm(CORE_SECTION);
A.ok('quiet while the assist registrant is dead', p.quietWhileAssistDead, JSON.stringify(p));
A.ok('arms once when assist is live', p.armsOnceAssistLive, JSON.stringify(p));
A.ok('carries the engine sev as escSev', p.carriesEngineSev, JSON.stringify(p));
A.ok('does not force the drawer open', p.doesNotForceOpen, JSON.stringify(p));
A.ok('latched per path+key (no bus churn on re-render)', p.latchedSamePage, JSON.stringify(p));
A.ok('SPA nav to another WO re-arms', p.rearmsOnNav, JSON.stringify(p));
A.ok('a done row arms nothing', p.doneRowQuiet, JSON.stringify(p));
A.ok('a done-row miss does not latch a later render out', p.doneDidNotLatch, JSON.stringify(p));
A.ok('non-escalate keys and sev-less acts arm nothing', p.nonEscalateQuiet, JSON.stringify(p));

// Structural: the engine writes the field, the render loop makes the call, the assist
// side still speaks the same contract.
A.ok('engine escalate act carries sev: escSev', coreFull.indexOf('sev: escSev') !== -1, 'field missing from acts.push');
A.ok('render loop calls armAssistDue(a, isDone)', coreFull.indexOf('armAssistDue(a, isDone);') !== -1, 'call site missing');
A.ok('wo-assist listens for bwn:assist:due', assistFull.indexOf("d.id === 'bwn:assist:due'") !== -1, 'listener missing');
A.ok('wo-assist consumes d.escSev into _pendingSev', assistFull.indexOf('_pendingSev = d.escSev') !== -1, 'consumption missing');
A.ok('wo-assist POSTs escSev', assistFull.indexOf('escSev: sev') !== -1, 'payload field missing');

// ---- mutations: revert one piece each, assert the harness goes red ----------------------
console.log('\nmutations (each must redden its probe)');

// M1: liveness gate dropped - the event fires into a page with no listener and the miss
// latches, so assist coming online later never hears it.
var m1 = probeArm(mutate(CORE_SECTION,
  "      if (!waDockAlive('assist')) return;",
  '      '));
A.ok('M1 dropping the liveness gate breaks the assist-dead probe', m1.quietWhileAssistDead === false, JSON.stringify(m1));

// M2: latch dropped - every render re-emits and the bus churns.
var m2 = probeArm(mutate(CORE_SECTION,
  '      if (assistDueSent[k]) return;',
  '      '));
A.ok('M2 dropping the latch breaks the no-churn probe', m2.latchedSamePage === false, JSON.stringify(m2));

// M3: event id drifts - the assist listener never matches.
var m3 = probeArm(mutate(CORE_SECTION,
  "detail: { id: 'bwn:assist:due', escSev: a.sev }",
  "detail: { id: 'bwn:assist:duee', escSev: a.sev }"));
A.ok('M3 a drifted event id emits nothing the contract recognises', m3.armsOnceAssistLive === false, JSON.stringify(m3));

console.log('\n(arm/latch/liveness x real source, 3 mutations. Nothing here proves the checklist');
console.log(' renders or the server bumps a tier - the live Phase 3 test covers the wire.)');
A.finish();
