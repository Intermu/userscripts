// test-perm-block-ledger.js - the BWN-PERM permission gate: paste ledger + behaviour.
//
// WHY THIS EXISTS
//   The suite now hides controls the signed-in user's own Umbrava permissions do not cover
//   (wiki/umbrava-permission-gate.md). Two things can rot:
//     1. The READER block. Every userscript runs in its own Tampermonkey sandbox and cannot share a
//        runtime object, so bwnCan/bwnCanAll is a paste - byte-identical between the markers, the
//        same discipline test-shared-block-ledger.js enforces for the Auth0 token picker. This
//        harness enumerates EVERY bwn-*.user.js, forces each into a classified row, and goes RED
//        when reality drifts from the ledger in either direction: a paste one byte off, a new
//        adopter nobody classified, or an adopter that quietly dropped the block.
//     2. The DECODE. Umbrava hands back one bitmask per permission group. A decode that silently
//        returns "nothing granted" would hide every gated control; one that silently returns
//        "everything granted" would gate nothing. Both look like a green test suite unless the
//        real numbers are asserted, so the fixtures below are REAL masks captured from a live user
//        (2026-09-02) and checked against the counts the permissions page itself renders.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-perm-block-ledger.js
// No pixels, no network: this reads the shipped bytes and runs slices of them in a vm.

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n'); }

var START = '  // ===== BWN-PERM START v1';
var END = '  // ===== BWN-PERM END v1 =====';

// ---- the ledger ------------------------------------------------------------------------------
// ADOPTED: carries the reader block because it gates at least one control on a permission.
// NA:      gates nothing, and must therefore carry NO block (asserted, so an accidental paste that
//          nobody wired shows up as drift rather than dead weight).
// Moving a script between the two lists is a DELIBERATE edit of this file - that is the point.
var ADOPTED = [
  'bwn-dispatch.user.js',        // assign / status / ECD rows in the dispatch modal
  'bwn-drop-upload.user.js',     // document upload overlay + the note review box
  'bwn-kanban.user.js',          // card drag = a status write
  'bwn-low-gp.user.js',          // the Low GP button posts notes
  'bwn-notes.user.js',           // note templates fill the composer
  'bwn-proposal-actions.user.js',// the three proposal workflows and their steps
  'bwn-proposal-copy.user.js',   // copy = create + fill a draft proposal
  'bwn-suite-core.user.js',      // dock needPerm, WO-Assist writes, and the PRODUCER
  'bwn-temp-vendor.user.js',     // activate / deactivate a vendor
  'bwn-write-queue.user.js'      // per-verb gate on the queue drain
];

console.log('--- 1. paste ledger: every bwn-*.user.js is classified, and the paste is byte-identical ---');

var onDisk = fs.readdirSync(ROOT).filter(function (f) { return /^bwn-.*\.user\.js$/.test(f); }).sort();
var adoptedSet = {};
ADOPTED.forEach(function (f) { adoptedSet[f] = true; });

// Every ADOPTED row must still exist on disk (a renamed/removed script cannot sit in the ledger).
ADOPTED.forEach(function (f) {
  A.ok('ledger row exists on disk: ' + f, onDisk.indexOf(f) !== -1, 'not found in the repo root');
});

var shas = {};
onDisk.forEach(function (f) {
  var src = read(f);
  var a = src.indexOf(START), b = src.indexOf(END);
  var has = a !== -1 && b !== -1;
  if (adoptedSet[f]) {
    A.ok('ADOPTED carries the block: ' + f, has, 'markers missing');
    if (has) shas[f] = crypto.createHash('sha256').update(src.slice(a, b + END.length)).digest('hex');
  } else {
    A.ok('NA carries no block: ' + f, !has, 'unclassified adopter - add it to ADOPTED or remove the paste');
    // A rival bwnCan outside the markers is the drift this ledger exists to catch.
    A.ok('NA declares no rival bwnCan: ' + f, !/function\s+bwnCan\s*\(/.test(src), 'a hand-rolled copy crept in');
  }
});

var uniq = Object.keys(shas).map(function (k) { return shas[k]; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; });
A.eq('all adopters hash to ONE block', uniq.length, 1);
A.eq('every adopter is hashed', Object.keys(shas).length, ADOPTED.length);

// ---- 2. reader behaviour ----------------------------------------------------------------------
console.log('\n--- 2. bwnCan / bwnCanAll: fail-open on unknown, fail-closed on a known-missing bit ---');

var coreSrc = read('bwn-suite-core.user.js');
var ra = coreSrc.indexOf(START), rb = coreSrc.indexOf(END);
var READER = coreSrc.slice(ra, rb + END.length);

// A fake page: one localStorage key and a document that only has to carry the bwn:evt listener.
function makeSandbox(slotValue) {
  var store = {};
  if (slotValue !== undefined) store['bwn:perm:last'] = slotValue;
  var listeners = [];
  var ctx = {
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); }
    },
    document: {
      addEventListener: function (name, fn) { if (name === 'bwn:evt') listeners.push(fn); },
      dispatchEvent: function (ev) { listeners.forEach(function (fn) { fn(ev); }); }
    },
    __store: store,
    console: console
  };
  vm.createContext(ctx);
  vm.runInContext(READER + '\nthis.bwnCan = bwnCan; this.bwnCanAll = bwnCanAll; this.bwnPermsForPatch = bwnPermsForPatch;', ctx);
  return ctx;
}
function slot(groups, granted, ageMs) {
  return JSON.stringify({ v: 1, ts: Date.now() - (ageMs || 0), ver: 'test', groups: groups, granted: granted });
}

var noSlot = makeSandbox(undefined);
A.eq('no slot at all -> allowed', noSlot.bwnCan('WorkOrderNote.AddNew'), true);

var garbage = makeSandbox('{not json');
A.eq('unparseable slot -> allowed', garbage.bwnCan('WorkOrderNote.AddNew'), true);

var stale = makeSandbox(slot(['WorkOrderNote'], [], 25 * 3600 * 1000));
A.eq('slot older than the 24h TTL -> allowed', stale.bwnCan('WorkOrderNote.AddNew'), true);

var live = makeSandbox(slot(['WorkOrderNote', 'Task'], ['WorkOrderNote.AddNew', 'Task.Complete']));
A.eq('granted bit -> allowed', live.bwnCan('WorkOrderNote.AddNew'), true);
A.eq('KNOWN-MISSING bit -> DENIED', live.bwnCan('WorkOrderNote.DeleteOwnNote'), false);
A.eq('group the producer never mapped -> allowed', live.bwnCan('Inventory.ManageStock'), true);
A.eq('canAll: every key granted', live.bwnCanAll(['WorkOrderNote.AddNew', 'Task.Complete']), true);
A.eq('canAll: one key missing denies the set', live.bwnCanAll(['WorkOrderNote.AddNew', 'Task.AddNew']), false);
A.eq('canAll: null spec means no requirement', live.bwnCanAll(null), true);
A.eq('canAll: a bare string is accepted', live.bwnCanAll('Task.Complete'), true);

// The memo must not outlive a fresh decode, or a permission change needs a page reload to bite.
var reval = makeSandbox(slot(['Task'], ['Task.AddNew']));
A.eq('memo warm: granted', reval.bwnCan('Task.AddNew'), true);
reval.__store['bwn:perm:last'] = slot(['Task'], []);
A.eq('slot swapped, memo still warm -> stale answer', reval.bwnCan('Task.AddNew'), true);
reval.document.dispatchEvent({ detail: { id: 'bwn:perm' } });
A.eq('bwn:perm invalidates the memo -> re-read denies', reval.bwnCan('Task.AddNew'), false);

// ---- 2b. bwnPermsForPatch: one mutation, one permission per FIELD ----------------------------
// patchWorkOrder is the only write whose permission depends on its variables, and it is the write
// with the widest blast radius, so the field map is asserted directly rather than only through the
// wrapper. Keys are the wire-proven data fields ([[dispatch-patchworkorder-pin]]).
console.log('\n--- 2b. bwnPermsForPatch: the permission set follows the fields in the payload ---');
var pf = makeSandbox(undefined);
A.eq('status -> the Status field', pf.bwnPermsForPatch({ data: { workOrderNumber: 1, statusId: {} } }), ['WorkOrderField.Status']);
A.eq('assign -> the AssignedTo field', pf.bwnPermsForPatch({ data: { assignedTo: {} } }), ['WorkOrderField.AssignedTo']);
A.eq('ECD rides in priority -> CompletionSLA', pf.bwnPermsForPatch({ data: { priority: {} } }), ['WorkOrderField.CompletionSLA']);
A.eq('priority + the SLA id the SPA bundles with it asks ONCE',
  pf.bwnPermsForPatch({ data: { priority: {}, serviceLevelAgreementId: {} } }), ['WorkOrderField.CompletionSLA']);
A.eq('the bulk Source Job#/PO# columns', pf.bwnPermsForPatch({ data: { sourceJobNumber: {}, sourcePurchaseOrderNumber: {} } }),
  ['WorkOrderField.SourceJobNumber', 'WorkOrderField.SourcePurchaseOrderNumber']);
A.eq('a bundle asks for every field it touches',
  pf.bwnPermsForPatch({ data: { statusId: {}, assignedTo: {}, priority: {} } }).sort(),
  ['WorkOrderField.AssignedTo', 'WorkOrderField.CompletionSLA', 'WorkOrderField.Status']);
A.eq('workOrderNumber is the identifier, not a field write', pf.bwnPermsForPatch({ data: { workOrderNumber: 283834 } }), []);
A.eq('an unmapped field asks for nothing (unknown -> allow)', pf.bwnPermsForPatch({ data: { someFutureField: {} } }), []);
A.eq('no variables at all', pf.bwnPermsForPatch(undefined), []);

// ---- 3. producer decode -----------------------------------------------------------------------
console.log('\n--- 3. producer: real masks decode to the boxes the permissions page renders ---');

var pStart = coreSrc.indexOf('  // ---- Permission PRODUCER');
var pEnd = coreSrc.indexOf("  bwnBoot('permGate'");
A.ok('the producer slice is findable', pStart !== -1 && pEnd > pStart, 'core markers moved');
var PRODUCER = coreSrc.slice(pStart, pEnd);

// Captured live 2026-09-02 from a real National Account Manager's me.permissions. The page rendered
// "Note 5/9" for this user, which is exactly the five names asserted below.
var LIVE_PAYLOAD = JSON.stringify({
  WorkOrderNoteActionPermissions: '242',
  WorkOrderActionPermissions: '7421651',
  WorkOrderFieldPermissions: '4095'
});

function runProducer(payload) {
  var ctx = makeSandbox(undefined);
  ctx.BWN_VER = 'test';
  ctx.BWN_MODULES = { permGate: true };
  ctx.bwnGqlOp = function () { return Promise.resolve({ me: { id: 'u1', permissions: payload } }); };
  vm.runInContext(PRODUCER + '\nthis.bwnPermPublish = bwnPermPublish; this.bwnPermRefresh = bwnPermRefresh; this.bwnPermHasBit = bwnPermHasBit;', ctx);
  return ctx;
}

var prod = runProducer(LIVE_PAYLOAD);
var rec = prod.bwnPermPublish(LIVE_PAYLOAD);
A.ok('publish returned a record', !!rec, 'decode produced nothing');
A.eq('only the groups Umbrava sent are reported',
  rec.groups.sort(), ['WorkOrder', 'WorkOrderField', 'WorkOrderNote']);
A.eq('Note mask 242 decodes to the 5 boxes the page shows ticked',
  rec.granted.filter(function (k) { return k.indexOf('WorkOrderNote.') === 0; }).sort(),
  ['WorkOrderNote.AddNew', 'WorkOrderNote.ExportAllNotes', 'WorkOrderNote.ExportSelectionOfNotes',
    'WorkOrderNote.Share', 'WorkOrderNote.ViewAudit']);
A.eq('an unticked box is absent, not merely falsy',
  rec.granted.indexOf('WorkOrderNote.DeleteOwnNote'), -1);
A.eq('WorkOrderField 4095 = all twelve fields', rec.granted.filter(function (k) { return k.indexOf('WorkOrderField.') === 0; }).length, 12);

// The published slot is what every other sandbox reads, so it must be readable BY the reader block.
var reader = makeSandbox(prod.__store['bwn:perm:last']);
A.eq('the published slot drives the reader: granted', reader.bwnCan('WorkOrderNote.AddNew'), true);
A.eq('the published slot drives the reader: denied', reader.bwnCan('WorkOrderNote.DeleteOwnNote'), false);

// Bits past 2^25 are already in use and the masks keep growing; the decode must not be doing 32-bit
// arithmetic. 33554432 = ManageExpense (2^25); 7421651 does NOT carry it.
A.eq('a high bit that is OFF stays off', rec.granted.indexOf('WorkOrder.ManageExpense'), -1);
var hi = prod.bwnPermPublish(JSON.stringify({ WorkOrderActionPermissions: String(Math.pow(2, 25) + 1) }));
A.eq('a high bit that is ON is decoded', hi.granted.indexOf('WorkOrder.ManageExpense') !== -1, true);
A.eq('and the low bit alongside it', hi.granted.indexOf('WorkOrder.View') !== -1, true);

// Drift, not "no permissions": a payload naming no group we map publishes NOTHING, so the reader
// keeps answering unknown (allow) instead of hiding every gated control at once.
var drifted = runProducer('{}');
A.eq('an unrecognized payload publishes nothing', drifted.bwnPermPublish('{"SomethingElsePermissions":"7"}'), null);
A.eq('and a non-JSON payload publishes nothing', drifted.bwnPermPublish('nope'), null);

// The refresh path is what actually runs on boot.
var refreshed = runProducer(LIVE_PAYLOAD);
refreshed.bwnPermRefresh(true).then(function (r) {
  A.ok('bwnPermRefresh decodes and publishes', !!(r && r.granted && r.granted.length), 'refresh produced no record');

  // ---- 4. negative controls ---------------------------------------------------------------
  // Each one proves an assertion above would actually FAIL if the guard it covers were removed.
  console.log('\n--- 4. negative controls ---');

  // (a) If the reader fell back to "deny when unknown", the fail-open cases would flip.
  var flipped = READER.replace('if (!p) return true;', 'if (!p) return false;');
  A.ok('control: the fail-open line exists to be flipped', flipped !== READER, 'the guard text moved - re-point this control');
  var ctxN = { localStorage: { getItem: function () { return null; }, setItem: function () { } }, document: { addEventListener: function () { } }, console: console };
  vm.createContext(ctxN);
  vm.runInContext(flipped + '\nthis.bwnCan = bwnCan;', ctxN);
  A.eq('control: with the guard flipped, no slot would DENY', ctxN.bwnCan('WorkOrderNote.AddNew'), false);

  // (b) If the bit test regressed to `&`, the >2^31 case would silently go wrong. Prove the two
  //     disagree on a real-sized mask, so the high-bit assertion above is load-bearing.
  // 2^32 is the first bit `&` cannot see at all: both operands truncate to 0, so the operator
  // reports "not granted" for a bit that IS set. Umbrava is at 2^25 today with room above it.
  var bigFlag = Math.pow(2, 32), bigMask = Math.pow(2, 32) + 1;
  A.eq('control: 32-bit & cannot see a 2^32 flag', (bigMask & bigFlag) !== 0, false);
  A.eq('control: the shipped division test can', prod.bwnPermHasBit(bigMask, bigFlag), true);

  A.finish();
});
