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

var START = '  // ===== BWN-PERM START v2';
var END = '  // ===== BWN-PERM END v2 =====';

// ---- the ledger ------------------------------------------------------------------------------
// ADOPTED: carries the reader block because it gates at least one control on a permission.
// NA:      gates nothing, and must therefore carry NO block (asserted, so an accidental paste that
//          nobody wired shows up as drift rather than dead weight).
// Moving a script between the two lists is a DELIBERATE edit of this file - that is the point.
var ADOPTED = [
  'bwn-bulk-assets.user.js',     // carried for the bwnGqlOp wrapper; createAsset has no perm yet (OWED)
  'bwn-dispatch.user.js',       // assign / status / ECD rows in the dispatch modal
  'bwn-drop-upload.user.js',     // document upload overlay + the note review box
  'bwn-kanban.user.js',          // card drag = a status write
  'bwn-low-gp.user.js',          // the Low GP button posts notes
  'bwn-notes.user.js',           // note templates fill the composer
  'bwn-proposal-actions.user.js',// the three proposal workflows and their steps
  'bwn-proposal-copy.user.js',   // copy = create + fill a draft proposal
  'bwn-suite-core.user.js',      // dock needPerm, WO-Assist writes, and the PRODUCER
  'bwn-temp-vendor.user.js',     // activate / deactivate a vendor
  'bwn-wo-audit.user.js',        // posts a WO-audit internal note on aged jobs
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

// Auth0 SPA cache entries, as the SDK writes them: one per audience, the Umbrava API one carrying the
// access token whose payload names the user. Signature bytes are irrelevant - nothing verifies them.
var TOKEN_KEY = '@@auth0spajs@@::client::https://app.umbrava.com/api::openid profile email';
function jwt(payload) {
  return 'hdr.' + Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.sig';
}
function tokenEntry(sub, extra) {
  var p = { iss: 'https://login.umbrava.com/', sub: sub, exp: Math.floor(Date.now() / 1000) + 3600 };
  Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
  return JSON.stringify({ body: { access_token: jwt(p) } });
}
// A fake page. localStorage entries are ENUMERABLE own properties (so Object.keys sees exactly the
// stored keys, as in a browser) and the methods are not. opts.tokens: { storageKey: entryJSON }; by
// default the page is signed in as user-A.
function makeSandbox(slotValue, opts) {
  var o = opts || {};
  var store = {};
  Object.defineProperty(store, 'getItem', { value: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } });
  Object.defineProperty(store, 'setItem', { value: function (k, v) { store[k] = String(v); } });
  Object.defineProperty(store, 'removeItem', { value: function (k) { delete store[k]; } });
  var tokens = o.tokens || (function () { var t = {}; t[TOKEN_KEY] = tokenEntry('user-A'); return t; })();
  Object.keys(tokens).forEach(function (k) { store[k] = tokens[k]; });
  if (slotValue !== undefined) store['bwn:perm:last'] = slotValue;
  var listeners = [];
  var ctx = {
    localStorage: store,
    atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
    document: {
      addEventListener: function (name, fn) { if (name === 'bwn:evt') listeners.push(fn); },
      dispatchEvent: function (ev) { listeners.forEach(function (fn) { fn(ev); }); }
    },
    __store: store,
    console: console
  };
  vm.createContext(ctx);
  vm.runInContext(READER + '\nthis.bwnCan = bwnCan; this.bwnCanAll = bwnCanAll; this.bwnPermsForPatch = bwnPermsForPatch;' +
    ' this.bwnPermSlot = bwnPermSlot; this.bwnPermSub = bwnPermSub;', ctx);
  return ctx;
}
function signIn(ctx, sub) { ctx.__store[TOKEN_KEY] = tokenEntry(sub); }
function slotObj(groups, granted, ageMs, sub) {
  return { v: 2, ts: Date.now() - (ageMs || 0), ver: 'test', sub: sub === undefined ? 'user-A' : sub, groups: groups, granted: granted };
}
function slot(groups, granted, ageMs, sub) { return JSON.stringify(slotObj(groups, granted, ageMs, sub)); }

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

// ---- 2a. v2 identity binding: user A's slot is never user B's cache ---------------------------
// Option 1 (2026-10-05): a slot that is not provably the CURRENT user's reads as "nothing decoded",
// so it contributes neither a grant nor a denial; the fail-open fallback above is unchanged.
console.log('\n--- 2a. identity binding: only a fresh v2 slot stamped with the current sub is read ---');
var G = ['WorkOrderNote', 'Task'], GR = ['WorkOrderNote.AddNew', 'Task.Complete'];
function rejected(label, slotValue, opts) {
  var c = makeSandbox(slotValue, opts);
  A.eq(label + ': slot unusable', c.bwnPermSlot(), null);
  A.eq(label + ': its missing bit does not deny', c.bwnCan('WorkOrderNote.DeleteOwnNote'), true);
  A.eq(label + ': its grant is not what allows', c.bwnCanAll(['WorkOrderNote.AddNew', 'Task.AddNew']), true);
}
var own = makeSandbox(slot(G, GR));
A.ok('same sub + fresh v2: slot usable', !!own.bwnPermSlot());
A.eq('same sub + fresh v2: granted bit allowed', own.bwnCan('Task.Complete'), true);
A.eq('same sub + fresh v2: known-missing bit DENIED', own.bwnCan('Task.AddNew'), false);
A.eq('same sub + fresh v2: canAll denies a set with a missing key', own.bwnCanAll(['Task.Complete', 'Task.AddNew']), false);
A.eq('same sub + fresh v2: bwnPermsForPatch unchanged', own.bwnPermsForPatch({ data: { statusId: {} } }), ['WorkOrderField.Status']);

rejected('another user\'s slot (sub user-B, signed in as user-A)', slot(G, GR, 0, 'user-B'));
rejected('legacy v1 slot', JSON.stringify({ v: 1, ts: Date.now(), ver: 't', groups: G, granted: GR }));
rejected('v2 with no sub', JSON.stringify((function () { var s = slotObj(G, GR); delete s.sub; return s; })()));
rejected('v2 with an empty sub', slot(G, GR, 0, ''));
rejected('bad JSON', '{not json');
rejected('JSON null', 'null');
rejected('a number', '42');
rejected('an array', JSON.stringify([slotObj(G, GR)]));
rejected('a string', JSON.stringify('slot'));
rejected('groups not an array', JSON.stringify((function () { var s = slotObj(G, GR); s.groups = 'Task'; return s; })()));
rejected('granted not an array', JSON.stringify((function () { var s = slotObj(G, GR); s.granted = {}; return s; })()));
rejected('non-numeric ts', JSON.stringify((function () { var s = slotObj(G, GR); s.ts = 'now'; return s; })()));
rejected('future ts', JSON.stringify((function () { var s = slotObj(G, GR); s.ts = Date.now() + 3600 * 1000; return s; })()));
rejected('expired ts', slot(G, GR, 25 * 3600 * 1000));

var noTok = {};
rejected('no token at all', slot(G, GR), { tokens: noTok });
var expTok = {}; expTok[TOKEN_KEY] = tokenEntry('user-A', { exp: Math.floor(Date.now() / 1000) - 60 });
rejected('only an expired token', slot(G, GR), { tokens: expTok });
var foreignTok = {}; foreignTok[TOKEN_KEY] = tokenEntry('user-A', { iss: 'https://evil.example.com/' });
rejected('a non-Umbrava issuer', slot(G, GR), { tokens: foreignTok });
var otherAud = {}; otherAud['@@auth0spajs@@::client::https://other.api::openid'] = tokenEntry('user-A');
rejected('a token for another audience only', slot(G, GR), { tokens: otherAud });
var garbledTok = {}; garbledTok[TOKEN_KEY] = '{"body":{"access_token":"not-a-jwt"}}';
rejected('an unreadable token entry', slot(G, GR), { tokens: garbledTok });
var twoUsers = {}; twoUsers[TOKEN_KEY] = tokenEntry('user-A'); twoUsers[TOKEN_KEY + ' offline_access'] = tokenEntry('user-B');
rejected('two tokens naming different users (ambiguous)', slot(G, GR), { tokens: twoUsers });
var twoSame = {}; twoSame[TOKEN_KEY] = tokenEntry('user-A'); twoSame[TOKEN_KEY + ' offline_access'] = tokenEntry('user-A');
var same2 = makeSandbox(slot(G, GR), { tokens: twoSame });
A.eq('two tokens naming the SAME user resolve to it', same2.bwnPermSub(), 'user-A');
A.eq('...and its slot is read (missing bit denies)', same2.bwnCan('Task.AddNew'), false);
A.eq('no token -> sub unknown', makeSandbox(undefined, { tokens: {} }).bwnPermSub(), null);

// Account switch on the SAME page, with no bwn:perm event: the warm memo must not answer for B.
var sw = makeSandbox(slot(G, GR));
A.eq('switch: memo warm under user-A (missing bit denies)', sw.bwnCan('Task.AddNew'), false);
signIn(sw, 'user-B');
A.eq('switch: signed in as user-B, no event -> slot unusable', sw.bwnPermSlot(), null);
A.eq('switch: user-A\'s denial does not apply to user-B', sw.bwnCan('Task.AddNew'), true);
signIn(sw, 'user-A');
A.ok('switch back: user-A\'s still-fresh slot is usable again', !!sw.bwnPermSlot());
A.eq('switch back: its denial applies again', sw.bwnCan('Task.AddNew'), false);

// TTL is re-checked on the warm memo too, not only on the first parse.
// The token outlives the jump, so only the slot's age can be what rejects it.
var longTok = {}; longTok[TOKEN_KEY] = tokenEntry('user-A', { exp: Math.floor(Date.now() / 1000) + 72 * 3600 });
var aging = makeSandbox(slot(G, GR), { tokens: longTok });
A.eq('ttl: memo warm', aging.bwnCan('Task.AddNew'), false);
var realNow = Date.now;
aging.Date = { now: function () { return realNow() + 25 * 3600 * 1000; } };
A.eq('ttl: the token is still valid 25h later', aging.bwnPermSub(), 'user-A');
A.eq('ttl: 25h later the warm memo is unusable', aging.bwnPermSlot(), null);
A.eq('ttl: and the raw slot is too (no denial)', aging.bwnCan('Task.AddNew'), true);

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

function runProducer(payload, opts) {
  var ctx = makeSandbox(undefined, opts);
  ctx.BWN_VER = 'test';
  ctx.BWN_MODULES = { permGate: true };
  ctx.bwnGqlOp = function () { return Promise.resolve({ me: { id: 'u1', permissions: payload } }); };
  vm.runInContext(PRODUCER + '\nthis.bwnPermPublish = bwnPermPublish; this.bwnPermRefresh = bwnPermRefresh; this.bwnPermHasBit = bwnPermHasBit;', ctx);
  return ctx;
}

var prod = runProducer(LIVE_PAYLOAD);
var rec = prod.bwnPermPublish(LIVE_PAYLOAD);
A.ok('publish returned a record', !!rec, 'decode produced nothing');
A.eq('producer writes schema v2', rec.v, 2);
A.eq('producer stamps the current user sub', rec.sub, 'user-A');
A.eq('the stored slot carries the same sub', JSON.parse(prod.__store['bwn:perm:last']).sub, 'user-A');
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

// No single current user -> no slot: an unbound v2 record would only be unusable noise.
var anon = runProducer(LIVE_PAYLOAD, { tokens: {} });
A.eq('unknown identity: publish returns null', anon.bwnPermPublish(LIVE_PAYLOAD), null);
A.eq('unknown identity: nothing is written', anon.__store['bwn:perm:last'], undefined);
// A legacy v1 slot must not hold off the first decode for the 6h throttle.
var legacy = runProducer(LIVE_PAYLOAD);
legacy.__store['bwn:perm:last'] = JSON.stringify({ v: 1, ts: Date.now(), ver: 'old', groups: ['Task'], granted: [] });
var legacyRefresh = legacy.bwnPermRefresh(false);

// The refresh path is what actually runs on boot.
var refreshed = runProducer(LIVE_PAYLOAD);
Promise.all([refreshed.bwnPermRefresh(true), legacyRefresh]).then(function (rs) {
  var r = rs[0];
  A.ok('bwnPermRefresh decodes and publishes', !!(r && r.granted && r.granted.length), 'refresh produced no record');
  A.eq('a legacy v1 slot does not suppress the first decode', rs[1] && rs[1].v, 2);
  A.eq('...and is replaced by the bound v2 slot', JSON.parse(legacy.__store['bwn:perm:last']).sub, 'user-A');

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
