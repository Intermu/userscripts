// test-vendor-intake-flow.js - node harness for the vendor-intake FLOW GUARDS, which had no
// test of any kind (the "jsdom harness for the vendor-intake flow guards" board item, 2026-08-02).
//
// NOT jsdom. The board row asked for one; jsdom is an npm package and this machine has no npm
// (see the ainews-skills-pack no-npm rule), so this follows the pattern the repo has already
// proven five times over instead: slice the REAL shipped block out of the userscript and run it
// against a hand-built fake DOM, here with a virtual MutationObserver and a virtual clock. Same
// coverage, no dependency.
//
// WHAT IS UNDER TEST - the cross-vendor data-leak guards:
//   These watchers hold ONE vendor's data in a closure for five minutes and fill the first
//   matching field that appears anywhere in the document. On a single-page app nothing reloads,
//   so an operator who abandons a half-filled vendor and starts another inside those five minutes
//   is the failure case: the next Billing step receives the PREVIOUS vendor's Tax ID. Four pieces
//   defend against that and every one of them is a silent, timing-dependent path a human cannot
//   easily re-test by hand:
//     - armFlow    - caches the flow ON the dialog node, and the UI REUSES that node, which is
//                    exactly why a stale-owner check alone is not enough.
//     - flowStale  - fails CLOSED: no owner, detached owner, or a live Create Vendor form that is
//                    not inside this owner. `isConnected` alone is insufficient (a kept-mounted
//                    dialog stays connected), so the identity of the on-screen form is checked.
//     - claimSlot  - one watcher per field per flow; a null observer RETIRES the slot. The
//                    retire-on-nothing-to-fill call is the actual leak fix: skipping it left
//                    vendor A's Tax ID watcher armed while vendor B used the same dialog node.
//     - standDown  - a stand-down is otherwise silent, and the UI has ALREADY promised the fill.
//   Also covered: modalRoot's deliberate lack of a `|| document` fallback (a document owner makes
//   flowStale permanently false and disables the whole guard), and w9Missing, the "name what did
//   NOT read" list that is the only signal a blank Tax ID is a blank rather than a success.
//
// Nothing here touches OCR, PDF parsing or findTIN - scripts/test-w9-tin-region.js owns those.
//
// Every mutation below reverts one guard in the sliced source and asserts THIS harness goes red.
// mutate() throws if its target string is absent or not unique, so a mutation that silently fails
// to apply cannot masquerade as a passing negative control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-vendor-intake-flow.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-vendor-intake.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = full.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (full.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = full.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return full.slice(a, b);
}

var S_FLOW = slice("  // These watchers hold one vendor's data in a closure",
  '  // Fill the step-2 address.', 'armFlow/flowStale/claimSlot/standDown/watchStep2');
var S_BILLING = slice('  // Watch for the Create-flow Billing step (step 3)',
  '  async function fillFromProspect', 'watchBillingStep');
var S_MODALROOT = slice('  function modalRoot() {', '  function fieldByLabel(root, re) {', 'modalRoot');
var S_W9FIELDS = slice('  function w9Fields(w9) {', '  function prospectFields(p) {', 'w9Fields/w9Missing');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- fake DOM ------------------------------------------------------------------------------
// Only what the sliced code touches: isConnected, contains, querySelector('input[name="..."]'),
// closest('.MuiDialog-container' | '[role="dialog"]' | '.MuiPaper-root'), and an expando slot for
// armFlow's __bwnFlow cache.
function el(spec) {
  spec = spec || {};
  var n = {
    tag: (spec.tag || 'div').toUpperCase(),
    cls: spec.cls || '',
    role: spec.role || '',
    name: spec.name || '',
    value: '',
    children: [],
    parent: null,
    _connected: spec.connected !== false
  };
  n.append = function (c) { c.parent = n; n.children.push(c); return c; };
  Object.defineProperty(n, 'isConnected', {
    get: function () { var x = n; while (x) { if (x._connected === false) return false; x = x.parent; } return true; }
  });
  n.contains = function (other) { var x = other; while (x) { if (x === n) return true; x = x.parent; } return false; };
  n.detach = function () {
    if (!n.parent) return n;
    var i = n.parent.children.indexOf(n);
    if (i >= 0) n.parent.children.splice(i, 1);
    n.parent = null;
    return n;
  };
  n.descendants = function () {
    var out = [];
    (function walk(p) { p.children.forEach(function (c) { out.push(c); walk(c); }); })(n);
    return out;
  };
  n.querySelector = function (sel) {
    var m = /^input\[name="([^"]+)"\]$/.exec(sel);
    if (!m) return null;
    var hit = n.descendants().filter(function (c) { return c.tag === 'INPUT' && c.name === m[1]; });
    return hit.length ? hit[0] : null;
  };
  n.closest = function (sel) {
    var x = n;
    while (x) {
      if (sel.charAt(0) === '.' && (' ' + x.cls + ' ').indexOf(' ' + sel.slice(1) + ' ') !== -1) return x;
      if (sel === '[role="dialog"]' && x.role === 'dialog') return x;
      x = x.parent;
    }
    return null;
  };
  return n;
}

// A dialog shaped like the real one: an outer MuiDialog-container wrapping an inner MuiPaper-root
// that the UI can swap while the dialog stays open - which is why modalRoot prefers the outer.
function makeDialog(opts) {
  opts = opts || {};
  var outer = el({ cls: 'MuiDialog-container', role: 'dialog' });
  var paper = outer.append(el({ cls: 'MuiPaper-root' }));
  if (opts.company !== false) paper.append(el({ tag: 'input', name: 'details.companyName' }));
  return { outer: outer, paper: paper };
}

function makeCtx(flowSrc, billingSrc) {
  var world = {
    toasts: [],
    setValues: [],
    fillAddressCalls: [],
    observers: [],
    timers: [],
    streetPresent: false,
    root: null            // the node document.querySelector searches
  };
  function docQuery(sel) { return world.root ? world.root.querySelector(sel) : null; }
  var body = el({ cls: 'body' });
  function MO(cb) {
    var self = { cb: cb, connected: false, disconnects: 0 };
    self.observe = function () { self.connected = true; world.observers.push(self); };
    self.disconnect = function () { self.connected = false; self.disconnects++; };
    return self;
  }
  var ctx = {
    console: console,
    document: { body: body, querySelector: docQuery },
    MutationObserver: MO,
    setTimeout: function (fn, ms) { world.timers.push({ fn: fn, ms: ms }); return world.timers.length; },
    toast: function (msg) { world.toasts.push(String(msg)); },
    setNativeValue: function (e2, v) { world.setValues.push({ name: e2 && e2.name, value: v }); if (e2) e2.value = v; },
    fillAddress: function (addr) { world.fillAddressCalls.push(addr); },
    fieldByLabel: function (root, re) {
      if (!world.streetPresent) return null;
      return re.test('Street') ? el({ tag: 'input', name: 'street' }) : null;
    }
  };
  vm.createContext(ctx);
  vm.runInContext((flowSrc || S_FLOW) + '\n' + (billingSrc || S_BILLING), ctx);
  world.flush = function () { world.observers.slice().forEach(function (o) { if (o.connected) o.cb(); }); };
  world.fireTimers = function (ms) { world.timers.slice().forEach(function (t) { if (t.ms === ms) t.fn(); }); };
  return { ctx: ctx, world: world };
}

// ---- probes --------------------------------------------------------------------------------
function probeArmFlow(flowSrc) {
  var h = makeCtx(flowSrc), c = h.ctx, r = {};
  var noRoot = c.armFlow(null);
  r.noRootShape = !!noRoot && noRoot.owner === null;
  r.noRootFailsClosed = c.flowStale(noRoot) === true;
  r.nullFlowFailsClosed = c.flowStale(null) === true;
  var d = makeDialog();
  h.world.root = d.outer;
  var f1 = c.armFlow(d.outer), f2 = c.armFlow(d.outer);
  // The dialog-reuse property: the SAME node yields the SAME flow object, which is precisely
  // why a stale-owner check cannot catch vendor B reusing vendor A's dialog.
  r.cachedOnNode = f1 === f2 && d.outer.__bwnFlow === f1;
  r.freshFlowIsLive = c.flowStale(f1) === false;
  return r;
}

function probeFlowStale(flowSrc) {
  var h = makeCtx(flowSrc), c = h.ctx, r = {};
  var d = makeDialog();
  h.world.root = d.outer;
  var f = c.armFlow(d.outer);
  r.liveDialogNotStale = c.flowStale(f) === false;

  // A form on screen that is NOT inside this owner: the operator started a different vendor, so
  // the owner's own form is gone while the UI keeps the old dialog node MOUNTED - isConnected is
  // still true. Identity of the live form is the only thing that catches this.
  d.outer.querySelector('input[name="details.companyName"]').detach();
  var other = makeDialog();
  var world2 = el({ cls: 'root' });
  world2.append(d.outer); world2.append(other.outer);
  h.world.root = world2;
  r.ownerStillConnected = d.outer.isConnected === true;
  r.foreignLiveFormIsStale = c.flowStale(f) === true;

  // No Create Vendor form on screen at all (mid-step): the flow is still ours.
  h.world.root = el({ cls: 'root' });
  r.noLiveFormStaysValid = c.flowStale(f) === false;

  // Detached owner.
  d.outer._connected = false;
  r.detachedIsStale = c.flowStale(f) === true;
  return r;
}

function probeClaimSlot(flowSrc) {
  var h = makeCtx(flowSrc), c = h.ctx, r = {};
  var d = makeDialog();
  h.world.root = d.outer;
  var f = c.armFlow(d.outer);
  var o1 = { disconnected: 0, disconnect: function () { o1.disconnected++; } };
  var o2 = { disconnected: 0, disconnect: function () { o2.disconnected++; } };
  c.claimSlot(f, 'tin', o1);
  r.slotStored = f.slots.tin === o1;
  c.claimSlot(f, 'tin', o2);
  r.replacementDisconnectsPrev = o1.disconnected === 1 && f.slots.tin === o2;
  c.claimSlot(f, 'tin', null);
  r.nullRetires = o2.disconnected === 1 && !('tin' in f.slots);
  var threw = false;
  try { c.claimSlot({ owner: null }, 'tin', o1); } catch (e) { threw = true; }
  r.slotlessFlowSurvives = threw === false;
  return r;
}

// THE defect this whole block exists for: vendor A's Tax ID must never reach vendor B's form when
// the UI hands the same dialog node to both.
function probeCrossVendorLeak(flowSrc, billingSrc) {
  var h = makeCtx(flowSrc, billingSrc), c = h.ctx, w = h.world, r = {};
  var d = makeDialog();
  w.root = d.outer;

  var flowA = c.armFlow(d.outer);
  c.watchBillingStep('11-1111111', flowA);          // vendor A drop, carries a TIN
  r.aArmed = w.observers.length === 1;

  // Operator abandons A and starts B in the SAME dialog node - so armFlow returns A's flow object
  // and flowStale is legitimately false. Only claimSlot can save this.
  var flowB = c.armFlow(d.outer);
  r.sameFlowObject = flowB === flowA;
  c.watchBillingStep('', flowB);                    // vendor B's document has NO Tax ID

  // Vendor B reaches the Billing step.
  d.paper.append(el({ tag: 'input', name: 'billing.taxId' }));
  w.flush();
  r.noLeakWritten = w.setValues.length === 0;
  r.slotRetired = !('tin' in flowA.slots);
  r.noToastPromised = w.toasts.length === 0;
  return r;
}

function probeBillingFill(flowSrc, billingSrc) {
  var h = makeCtx(flowSrc, billingSrc), c = h.ctx, w = h.world, r = {};
  var d = makeDialog();
  w.root = d.outer;
  var f = c.armFlow(d.outer);
  c.watchBillingStep('22-2222222', f);
  w.flush();
  r.quietUntilFieldAppears = w.setValues.length === 0;
  d.paper.append(el({ tag: 'input', name: 'billing.taxId' }));
  w.flush();
  r.filledOnce = w.setValues.length === 1 && w.setValues[0].name === 'billing.taxId' && w.setValues[0].value === '22-2222222';
  w.flush(); w.flush();
  r.neverRefills = w.setValues.length === 1;
  r.observerDisconnected = w.observers[0].disconnects >= 1;
  // Privacy: the Tax ID is filled but must never appear in a toast (nor a log).
  r.tinNeverToasted = w.toasts.every(function (t) { return t.indexOf('22-2222222') === -1 && t.indexOf('222222222') === -1; });
  r.confirmToasted = w.toasts.some(function (t) { return /Tax ID on the Billing step/i.test(t); });
  return r;
}

function probeStandDown(flowSrc, billingSrc) {
  var h = makeCtx(flowSrc, billingSrc), c = h.ctx, w = h.world, r = {};
  var d = makeDialog();
  w.root = d.outer;
  var f = c.armFlow(d.outer);
  c.watchBillingStep('33-3333333', f);
  d.outer._connected = false;                        // operator closed / replaced the form
  d.paper.append(el({ tag: 'input', name: 'billing.taxId' }));
  w.flush();
  r.noFillWhenStale = w.setValues.length === 0;
  r.standDownToasted = w.toasts.some(function (t) { return /Did not fill the Tax ID on the Billing step/i.test(t); });
  r.saysEnterManually = w.toasts.some(function (t) { return /Enter it manually/i.test(t); });
  w.flush();
  r.standsDownOnce = w.toasts.filter(function (t) { return /Did not fill/i.test(t); }).length === 1;
  return r;
}

function probeStep2(flowSrc) {
  var h = makeCtx(flowSrc), c = h.ctx, w = h.world, r = {};
  var d = makeDialog();
  w.root = d.outer;
  var f = c.armFlow(d.outer);

  // Vendor A's address watcher, then vendor B drops a document with no address at all: the
  // address slot must be retired for the same reason the Tax ID slot is.
  c.watchStep2({ street: '1 Old Rd', city: 'Erie', state: 'PA', zip: '16501' }, f);
  r.aArmed = 'addr' in f.slots;
  c.watchStep2({ street: '', city: '', state: '', zip: '' }, f);
  r.emptyAddressRetires = !('addr' in f.slots);
  w.streetPresent = true;
  w.flush();
  r.noLeakedAddress = w.fillAddressCalls.length === 0;

  // A real address fills once the Street field mounts.
  var h2 = makeCtx(flowSrc), c2 = h2.ctx, w2 = h2.world;
  var d2 = makeDialog();
  w2.root = d2.outer;
  var f2 = c2.armFlow(d2.outer);
  c2.watchStep2({ street: '2 New Rd', city: 'Erie', state: 'PA', zip: '16501' }, f2);
  w2.flush();
  r.waitsForStreetField = w2.fillAddressCalls.length === 0;
  w2.streetPresent = true;
  w2.flush(); w2.flush();
  r.fillsOnceOnly = w2.fillAddressCalls.length === 1 && w2.fillAddressCalls[0].street === '2 New Rd';

  // Stale flow stands down with the address wording.
  var h3 = makeCtx(flowSrc), c3 = h3.ctx, w3 = h3.world;
  var d3 = makeDialog();
  w3.root = d3.outer;
  var f3 = c3.armFlow(d3.outer);
  c3.watchStep2({ street: '3 Gone Rd', city: '', state: '', zip: '' }, f3);
  d3.outer._connected = false;
  w3.streetPresent = true;
  w3.flush();
  r.staleStandsDown = w3.fillAddressCalls.length === 0 && w3.toasts.some(function (t) { return /Did not fill the address on step 2/i.test(t); });

  // Both watchers share ONE flow - arming the second must not stale the first.
  var h4 = makeCtx(flowSrc, S_BILLING), c4 = h4.ctx;
  var d4 = makeDialog();
  h4.world.root = d4.outer;
  var f4 = c4.armFlow(d4.outer);
  c4.watchStep2({ street: '4 Both Rd', city: '', state: '', zip: '' }, f4);
  c4.watchBillingStep('44-4444444', f4);
  r.bothSlotsCoexist = ('addr' in f4.slots) && ('tin' in f4.slots) && c4.flowStale(f4) === false;
  return r;
}

function probeTimeout(flowSrc, billingSrc) {
  var h = makeCtx(flowSrc, billingSrc), c = h.ctx, w = h.world, r = {};
  var d = makeDialog();
  w.root = d.outer;
  var f = c.armFlow(d.outer);
  c.watchBillingStep('55-5555555', f);
  r.fiveMinuteTimerSet = w.timers.some(function (t) { return t.ms === 300000; });
  w.fireTimers(300000);
  d.paper.append(el({ tag: 'input', name: 'billing.taxId' }));
  w.flush();
  r.deadAfterTimeout = w.setValues.length === 0;
  return r;
}

function probeModalRoot(src) {
  var world = { root: null };
  var ctx = { document: { querySelector: function (sel) { return world.root ? world.root.querySelector(sel) : null; } } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  var r = {};
  var d = makeDialog();
  var page = el({ cls: 'page' }); page.append(d.outer);
  world.root = page;
  // Outermost container wins: `closest` on a comma-list would return the nearest match (the inner
  // MuiPaper-root), which the UI can swap while the dialog stays open.
  r.prefersOutermost = ctx.modalRoot() === d.outer;
  // No form open at all - the early `if (!c) return null`.
  world.root = el({ cls: 'page' });
  r.nullWhenNoForm = ctx.modalRoot() === null;
  // A form with NO dialog ancestor - this is what the `|| null` TAIL guards (the early return
  // never sees it, since the input does exist). Both paths must yield null rather than a
  // document-ish owner: such an owner is always connected and always contains the live form, so
  // flowStale would be permanently false and the entire cross-vendor guard silently disabled.
  var orphan = el({ cls: 'page' });
  orphan.append(el({ tag: 'input', name: 'details.companyName' }));
  world.root = orphan;
  r.nullWhenFormHasNoDialog = ctx.modalRoot() === null;
  return r;
}

function probeW9Missing(src) {
  var ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  var r = {};
  r.blankNamesAllThree = JSON.stringify(ctx.w9Missing({})) === JSON.stringify(['Company', 'Address', 'Tax ID']);
  r.completeIsEmpty = ctx.w9Missing({ name: 'ACME', street: '1 Rd', tin: '11-1' }).length === 0;
  r.cityAloneSatisfiesAddress = ctx.w9Missing({ name: 'A', city: 'Erie', tin: 't' }).length === 0;
  // DBA and Entity are deliberately never "missing" - a W-9 legitimately has no DBA.
  r.dbaEntityNeverMissing = ctx.w9Missing({ name: 'A', zip: '1', tin: 't' }).join(',').indexOf('DBA') === -1 &&
    ctx.w9Missing({ name: 'A', zip: '1', tin: 't' }).join(',').indexOf('Entity') === -1;
  r.fieldsListsTaxIdAsLocal = ctx.w9Fields({ name: 'A', tin: 't' }).indexOf('Tax ID (local)') !== -1;
  return r;
}

// ---- run: real source -------------------------------------------------------------------
console.log('vendor-intake flow guards (cross-vendor leak) - real source');

var a = probeArmFlow();
A.ok('armFlow(null) yields a null owner', a.noRootShape, JSON.stringify(a));
A.ok('a no-root flow fails CLOSED', a.noRootFailsClosed, JSON.stringify(a));
A.ok('a null flow fails CLOSED', a.nullFlowFailsClosed, JSON.stringify(a));
A.ok('the flow caches on the dialog node (the reuse hazard)', a.cachedOnNode, JSON.stringify(a));
A.ok('a fresh flow is live', a.freshFlowIsLive, JSON.stringify(a));

var s = probeFlowStale();
A.ok('live dialog is not stale', s.liveDialogNotStale, JSON.stringify(s));
A.ok('the replaced dialog is still CONNECTED (so isConnected cannot catch it)', s.ownerStillConnected, JSON.stringify(s));
A.ok('a live form OUTSIDE the owner is stale (isConnected alone is not enough)', s.foreignLiveFormIsStale, JSON.stringify(s));
A.ok('no form on screen keeps the flow valid', s.noLiveFormStaysValid, JSON.stringify(s));
A.ok('a detached owner is stale', s.detachedIsStale, JSON.stringify(s));

var cs = probeClaimSlot();
A.ok('claimSlot stores the observer', cs.slotStored, JSON.stringify(cs));
A.ok('a replacement disconnects the previous watcher', cs.replacementDisconnectsPrev, JSON.stringify(cs));
A.ok('a null observer retires the slot', cs.nullRetires, JSON.stringify(cs));
A.ok('a slotless flow does not throw', cs.slotlessFlowSurvives, JSON.stringify(cs));

var x = probeCrossVendorLeak();
A.ok('vendor A arms a Tax ID watcher', x.aArmed, JSON.stringify(x));
A.ok('vendor B reuses the SAME flow object (the hazard is real)', x.sameFlowObject, JSON.stringify(x));
A.ok("NO LEAK: vendor A's Tax ID never reaches vendor B's form", x.noLeakWritten, JSON.stringify(x));
A.ok("...because vendor B's empty-TIN drop retired the slot", x.slotRetired, JSON.stringify(x));
A.ok('and nothing was promised in a toast', x.noToastPromised, JSON.stringify(x));

var b = probeBillingFill();
A.ok('quiet until the Billing field appears', b.quietUntilFieldAppears, JSON.stringify(b));
A.ok('fills the Tax ID once the field mounts', b.filledOnce, JSON.stringify(b));
A.ok('never refills on later mutations', b.neverRefills, JSON.stringify(b));
A.ok('observer disconnects after filling', b.observerDisconnected, JSON.stringify(b));
A.ok('PRIVACY: the Tax ID value never appears in a toast', b.tinNeverToasted, JSON.stringify(b));
A.ok('but the fill IS announced', b.confirmToasted, JSON.stringify(b));

var sd = probeStandDown();
A.ok('a stale flow fills NOTHING', sd.noFillWhenStale, JSON.stringify(sd));
A.ok('and says so (the UI already promised the fill)', sd.standDownToasted, JSON.stringify(sd));
A.ok('the stand-down tells the operator to enter it manually', sd.saysEnterManually, JSON.stringify(sd));
A.ok('stand-down fires once, not per mutation', sd.standsDownOnce, JSON.stringify(sd));

var st = probeStep2();
A.ok('address watcher arms for vendor A', st.aArmed, JSON.stringify(st));
A.ok("an address-less drop RETIRES the previous vendor's address watcher", st.emptyAddressRetires, JSON.stringify(st));
A.ok("so vendor A's address never lands on vendor B", st.noLeakedAddress, JSON.stringify(st));
A.ok('waits for the Street field to mount', st.waitsForStreetField, JSON.stringify(st));
A.ok('fills the address exactly once', st.fillsOnceOnly, JSON.stringify(st));
A.ok('a stale flow stands down with the address wording', st.staleStandsDown, JSON.stringify(st));
A.ok('addr + tin slots coexist on one shared flow', st.bothSlotsCoexist, JSON.stringify(st));

var t = probeTimeout();
A.ok('a five-minute expiry is scheduled', t.fiveMinuteTimerSet, JSON.stringify(t));
A.ok('the watcher is dead after it fires', t.deadAfterTimeout, JSON.stringify(t));

var mr = probeModalRoot(S_MODALROOT);
A.ok('modalRoot prefers the outermost dialog container', mr.prefersOutermost, JSON.stringify(mr));
A.ok('modalRoot returns null when no form is open', mr.nullWhenNoForm, JSON.stringify(mr));
A.ok('modalRoot returns null (no `|| document`) for a form with no dialog ancestor', mr.nullWhenFormHasNoDialog, JSON.stringify(mr));

var wm = probeW9Missing(S_W9FIELDS);
A.ok('a blank W-9 names Company, Address and Tax ID as NOT read', wm.blankNamesAllThree, JSON.stringify(wm));
A.ok('a complete W-9 names nothing missing', wm.completeIsEmpty, JSON.stringify(wm));
A.ok('city alone satisfies the address check', wm.cityAloneSatisfiesAddress, JSON.stringify(wm));
A.ok('DBA and Entity are never reported missing', wm.dbaEntityNeverMissing, JSON.stringify(wm));
A.ok('w9Fields marks the Tax ID as local', wm.fieldsListsTaxIdAsLocal, JSON.stringify(wm));

// ---- mutations: revert one guard each, assert the harness goes red -------------------------
console.log('\nmutations (each must redden its probe)');

// M1: the leak itself - an empty-TIN drop returns without retiring, leaving vendor A's watcher
// armed against a shared flow.
var m1 = probeCrossVendorLeak(S_FLOW, mutate(S_BILLING,
  "    if (!tin) { claimSlot(flow, 'tin', null); return; }",
  '    if (!tin) return;'));
A.ok("M1 skipping the retire leaks vendor A's Tax ID into vendor B", m1.noLeakWritten === false, JSON.stringify(m1));

// M2: the same shape on the address watcher.
var m2 = probeStep2(mutate(S_FLOW,
  "    if (!addr.street && !addr.city && !addr.zip) { claimSlot(flow, 'addr', null); return; }",
  '    if (!addr.street && !addr.city && !addr.zip) { return; }'));
A.ok('M2 skipping the address retire leaks the previous address', m2.noLeakedAddress === false, JSON.stringify(m2));

// M3: isConnected-only staleness - a replaced-but-mounted dialog reads as live.
var m3 = probeFlowStale(mutate(S_FLOW,
  '    if (live && !flow.owner.contains(live)) return true;',
  '    if (false) return true;'));
A.ok('M3 dropping the form-identity check misses a replaced dialog', m3.foreignLiveFormIsStale === false, JSON.stringify(m3));

// M4: the `|| document` fallback modalRoot deliberately does not have. It reddens the ORPHAN
// case, not the no-form case - the early `if (!c) return null` short-circuits before the tail is
// ever reached, which is why the tail needs its own probe (found by this control refusing to go
// red against the no-form fixture - see [[negative-control-silent-noop]]).
var m4 = probeModalRoot(mutate(S_MODALROOT,
  "c.closest('.MuiPaper-root') || null;",
  "c.closest('.MuiPaper-root') || { isConnected: true, contains: function () { return true; } };"));
A.ok('M4 a document-ish TAIL fallback breaks the orphan-form probe', m4.nullWhenFormHasNoDialog === false, JSON.stringify(m4));
A.ok('M4 leaves the no-form path alone (the early return owns it)', m4.nullWhenNoForm === true, JSON.stringify(m4));

// M6: the early return, the other half of failing closed.
var m6 = probeModalRoot(mutate(S_MODALROOT,
  '    if (!c) return null;',
  '    if (!c) return { isConnected: true, contains: function () { return true; } };'));
A.ok('M6 a document-ish EARLY fallback breaks the no-form probe', m6.nullWhenNoForm === false, JSON.stringify(m6));

// M5: stand-down silence - the operator is told nothing and believes the fill happened.
var m5 = probeStandDown(mutate(S_FLOW,
  "    toast('Did not fill the ' + what + ' - this form was replaced or re-opened. Enter it manually.', 11000);",
  '    void what;'), S_BILLING);
A.ok('M5 a silent stand-down breaks the notification probe', m5.standDownToasted === false, JSON.stringify(m5));

console.log('\n(flow lifecycle x real source, 6 mutations. No jsdom - npm is unavailable here, so this');
console.log(' slices the shipped block against a fake DOM + virtual MutationObserver, as the other');
console.log(' harnesses do. OCR/PDF/findTIN are covered by test-w9-tin-region.js, not here.)');
A.finish();
