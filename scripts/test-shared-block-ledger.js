// test-shared-block-ledger.js - completeness ledger over the ONE shared Auth0 token-picker block.
//
// WHY THIS EXISTS (same discipline as test-ui-contract-ledger.js, different primitive):
//   Every BWN userscript runs in its own Tampermonkey sandbox and cannot share a runtime object, so
//   the Umbrava access-token picker (isUmbravaToken + authToken) used to live as a hand-copied local
//   helper in a dozen scripts - a security-sensitive credential read, duplicated and free to drift.
//   US-1 step 1 consolidated it into ONE canonical block, pasted BYTE-IDENTICAL (after EOL
//   normalization, exactly as read() below normalizes) between the two markers into every adopter.
//   This harness is the stop-drift-by-hand half: it enumerates EVERY bwn-*.user.js on disk, forces
//   each into a classified row, and goes RED the moment reality drifts from the ledger in either
//   direction - a paste that is one byte off, a rival copy sneaking back in beside the block, a new
//   script that grows a picker nobody classified, a deferred script that quietly adopts (or drops)
//   its local copy, or a script appearing/disappearing from disk.
//
// STATUS VOCABULARY (per script):
//   ADOPTED - carries the canonical block (SHA == CANON_SHA) and NO rival picker outside it.
//   PENDING - deliberately NOT yet folded: the block is ABSENT and a local picker copy is PRESENT,
//             with a recorded reason. Only bwn-suite-core / bwn-suite-ai today (each has multiple
//             copies near sentinel / SHA-gated regions; folded in a separate careful pass).
//   NA      - the script carries no token picker at all. Asserted absent in BOTH senses (no block,
//             no picker declaration), so a script that grows one can never sit silently under NA.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-shared-block-ledger.js
// No pixels, no network: this reads the shipped bytes only.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n'); }

// ---- the canonical block ---------------------------------------------------------------------
// The markers bracket the paste. CANON_SHA is the SHA-256 of the EOL-normalized bytes from the START
// marker text through the END marker text inclusive; every ADOPTED script must hash to exactly this.
// Regenerate (after a DELIBERATE v-bump of the block) with scripts/print-shared-block-sha.js-style:
//   node -e "var s=require('fs').readFileSync('bwn-ask.user.js','utf8').replace(/\r\n/g,'\n');
//            var a=s.indexOf('// ===== BWN-SHARED START v1'),b=s.indexOf('// ===== BWN-SHARED END v1 =====');
//            console.log(require('crypto').createHash('sha256').update(s.slice(a,b+31)).digest('hex'))"
var START = '// ===== BWN-SHARED START v1';
var END = '// ===== BWN-SHARED END v1 =====';
var CANON_SHA = '7749d97c1effb9d9541495d815c736396b4812a12ce1d6330a37ecbe6fe72635';

// A picker FUNCTION declaration in any prefixed form seen in the suite (isUmbravaToken /
// duIsUmbravaToken / authToken / duAuthToken / rawAuthToken / bwnAuthToken / heatAuthToken ...).
// The canonical block itself carries exactly two of these (isUmbravaToken + authToken) INSIDE the
// markers; a "rival" is any such declaration that survives OUTSIDE the block. NOTE this deliberately
// does NOT match the session-USER readers (bwnNotesToken / clientToken / actor) - they read a
// different JWT field and are out of scope for this consolidation.
var PICKER_DECL = /function\s+\w*(?:[Ii]sUmbravaToken|[Aa]uthToken)\s*\(/g;
// A tail unique to the ACCESS-TOKEN slot filter, used only to catch a rival picker BODY that was
// pasted back under a name PICKER_DECL would miss. Matches the literal REGEX-SOURCE form as it
// appears in the code (`umbrava\.com\/api`, backslashes and all), which occurs ONLY inside a
// picker's localStorage filter - never in the @match/@connect headers (real slashes, no backslashes)
// nor in the session-USER `@@user@@` reader the consolidation deliberately leaves alone. Stateless.
var SLOT_BODY = /umbrava\\\.com\\\/api/;

function findBlock(src) {
  var a = src.indexOf(START);
  if (a === -1) return { present: false };
  var b = src.indexOf(END, a);
  if (b === -1) return { present: false, malformed: true };
  var dup = src.indexOf(START, a + START.length) !== -1;
  return { present: true, dup: dup, text: src.slice(a, b + END.length) };
}
function stripBlock(src) {
  var a = src.indexOf(START);
  if (a === -1) return src;
  var b = src.indexOf(END, a);
  if (b === -1) return src;
  return src.slice(0, a) + src.slice(b + END.length);
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function pickerDecls(src) { return (src.match(PICKER_DECL) || []).length; }

// ---- one pure judge, used by both the real assertions and every negative control -------------
// Returns { ok, why }. Pure so a control can feed it a mutated source and require the SAME judge to
// flip, never a parallel check that could agree with the bug by construction.
function judge(src, status) {
  var fb = findBlock(src);
  if (status === 'ADOPTED') {
    if (!fb.present) return { ok: false, why: fb.malformed ? 'START marker without a matching END' : 'ledger says ADOPTED but the block is MISSING' };
    if (fb.dup) return { ok: false, why: 'a second BWN-SHARED START - the block is duplicated' };
    if (sha(fb.text) !== CANON_SHA) return { ok: false, why: 'block SHA != canonical (a byte drifted: reject the paste, do not re-pin)' };
    var outside = stripBlock(src);
    if (pickerDecls(outside) !== 0) return { ok: false, why: 'a rival picker declaration survives OUTSIDE the block' };
    if (SLOT_BODY.test(outside)) return { ok: false, why: 'a rival picker BODY (Auth0 slot read) survives outside the block' };
    return { ok: true, why: 'canonical block present, no rival outside it' };
  }
  if (status === 'PENDING') {
    if (fb.present) return { ok: false, why: 'a PENDING script adopted the block - reclassify to ADOPTED and confirm the SHA' };
    if (pickerDecls(src) < 1) return { ok: false, why: 'ledger says PENDING (local copy present) but no picker declaration is found' };
    return { ok: true, why: 'not yet folded; local copy present, block absent' };
  }
  if (status === 'NA') {
    if (fb.present) return { ok: false, why: 'an NA script carries the shared block - it must be classified ADOPTED' };
    if (pickerDecls(src) !== 0) return { ok: false, why: 'an NA script grew a token picker - classify it (ADOPTED or PENDING)' };
    return { ok: true, why: 'no token picker, as declared' };
  }
  return { ok: false, why: 'unknown status ' + status };
}

// ---- THE LEDGER: measured suite state, US-1 step 1 -------------------------------------------
// Every bwn-*.user.js in the repo root MUST appear here (Section 1 enforces both directions). Adding
// a script forces a row; CI then keeps that row honest.
var LEDGER = {
  'bwn-ask.user.js':              { status: 'ADOPTED' },
  'bwn-bid-out.user.js':          { status: 'ADOPTED' },
  'bwn-cc-auth.user.js':          { status: 'ADOPTED' },
  'bwn-cc-purchase.user.js':      { status: 'ADOPTED' },
  'bwn-dispatch.user.js':         { status: 'ADOPTED' },
  'bwn-drop-upload.user.js':      { status: 'ADOPTED' },
  'bwn-kanban.user.js':           { status: 'NA' },
  'bwn-low-gp.user.js':           { status: 'ADOPTED' },
  'bwn-notes.user.js':            { status: 'NA' },   // reads only the @@user@@ session slot, not the access-token picker
  'bwn-proposal-actions.user.js': { status: 'ADOPTED' },
  'bwn-proposal-copy.user.js':    { status: 'ADOPTED' },
  'bwn-suite-ai.user.js':         { status: 'PENDING', reason: 'Local isUmbravaToken/aiIsUmbravaToken/rawAuthToken/authToken near the sentinel + PAT-002 regions; folded in a separate careful pass (US-1 defers the two mega scripts).' },
  'bwn-suite-core.user.js':       { status: 'PENDING', reason: 'Two local pickers (bwnAuthToken + heatAuthToken, each with its own isUmbravaToken) near sentinel / SHA-gated regions; folded in a separate careful pass (US-1 defers the two mega scripts).' },
  'bwn-vendor-intake.user.js':    { status: 'NA' },
  'bwn-wide-list.user.js':        { status: 'NA' },
  'bwn-wo-assist.user.js':        { status: 'ADOPTED' },
  'bwn-wo-audit.user.js':         { status: 'ADOPTED' },
  'bwn-wo-intake.user.js':        { status: 'NA' },
  'bwn-write-queue.user.js':      { status: 'ADOPTED' }
};

function ledgerWith(status) { return Object.keys(LEDGER).filter(function (f) { return LEDGER[f].status === status; }); }

// =============================================================================================
// 1. MANIFEST COMPLETENESS: every *.user.js on disk is in the ledger, and vice versa. The ledger's
// authority comes from the filesystem, not a hand-list that could itself be quietly short.
// =============================================================================================
console.log('-- 1. manifest: disk <-> ledger --');
var onDisk = fs.readdirSync(ROOT).filter(function (f) { return /^bwn-.*\.user\.js$/.test(f); });
var inLedger = Object.keys(LEDGER);
onDisk.forEach(function (f) {
  A.ok('on disk and in the ledger: ' + f, inLedger.indexOf(f) !== -1, 'a new script must be given a row before it ships');
});
inLedger.forEach(function (f) {
  A.ok('in the ledger and still on disk: ' + f, onDisk.indexOf(f) !== -1, 'a removed script must be dropped from the ledger');
});
A.ok('ledger row count equals the ' + onDisk.length + ' scripts on disk', inLedger.length === onDisk.length,
  'ledger ' + inLedger.length + ' vs disk ' + onDisk.length);

// =============================================================================================
// 2. PER-SCRIPT: detected reality agrees with the ledger classification, for all scripts on disk.
// =============================================================================================
console.log('\n-- 2. per-script classification (' + onDisk.length + ' scripts) --');
var SRC = {};
onDisk.forEach(function (f) { SRC[f] = read(f); });
onDisk.slice().sort().forEach(function (f) {
  var status = LEDGER[f].status;
  var r = judge(SRC[f], status);
  A.ok(f.replace(/^bwn-|\.user\.js$/g, '') + ' = ' + status, r.ok, r.why);
  if (status === 'PENDING') {
    A.ok('  ^ ' + f + ' PENDING has a recorded reason', typeof LEDGER[f].reason === 'string' && LEDGER[f].reason.length > 0,
      'a deferral must be named so it is not silently forgotten');
  }
});

// =============================================================================================
// 3. AGGREGATE: the counts are the ones US-1 step 1 committed to, and every ADOPTED block is the
// SAME canonical bytes (one distinct SHA across all adopters, equal to CANON_SHA).
// =============================================================================================
console.log('\n-- 3. aggregate counts + one canonical SHA --');
A.ok('ADOPTED count is 12', ledgerWith('ADOPTED').length === 12, 'got ' + ledgerWith('ADOPTED').length);
A.ok('PENDING count is 2', ledgerWith('PENDING').length === 2, 'got ' + ledgerWith('PENDING').length);
A.ok('NA count is 5', ledgerWith('NA').length === 5, 'got ' + ledgerWith('NA').length);
A.ok('PENDING is exactly suite-core + suite-ai',
  ledgerWith('PENDING').slice().sort().join('|') === 'bwn-suite-ai.user.js|bwn-suite-core.user.js',
  ledgerWith('PENDING').join(','));
var adoptedShas = {};
ledgerWith('ADOPTED').forEach(function (f) { adoptedShas[sha(findBlock(SRC[f]).text)] = true; });
A.ok('all adopters share ONE block SHA', Object.keys(adoptedShas).length === 1, 'distinct: ' + Object.keys(adoptedShas).join(','));
A.ok('that SHA is CANON_SHA', Object.keys(adoptedShas)[0] === CANON_SHA, Object.keys(adoptedShas)[0]);

// =============================================================================================
// 4. NEGATIVE CONTROLS: each reproduces a specific drift and requires the pure judge (or the
// manifest guard) to catch it. A control that no-ops would let the guard rot.
// =============================================================================================
console.log('\n-- 4. negative controls (each must flip RED) --');

// C1: mutate ONE byte inside an adopter's block -> SHA no longer matches CANON_SHA.
var anAdopter = 'bwn-ask.user.js';
var c1 = SRC[anAdopter].replace("iss !== 'https://login.umbrava.com'", "iss !== 'https://login-EVIL.umbrava.com'");
A.ok('C1: a one-byte edit inside the block is caught', c1 !== SRC[anAdopter] && judge(c1, 'ADOPTED').ok === false);

// C2: a rival local copy is pasted back into an adopter, OUTSIDE the block.
var c2 = SRC[anAdopter] + '\n  function duAuthToken() { return authToken(); }\n';
A.ok('C2: a rival picker declaration outside the block is caught', judge(c2, 'ADOPTED').ok === false);

// C2b: a rival copy that reuses the Auth0 slot read but under a non-matching name is still caught by the body guard.
var c2b = SRC[anAdopter] + "\n  var _sneak = /@@auth0spajs@@::.*::https:\\/\\/app\\.umbrava\\.com\\/api::/;\n";
A.ok('C2b: a rival Auth0-slot body outside the block is caught', judge(c2b, 'ADOPTED').ok === false);

// C3: an NA script grows a picker -> the NA guard must refuse to keep calling it NA.
var c3 = SRC['bwn-kanban.user.js'] + '\n  function authToken() { return ""; }\n';
A.ok('C3: a picker appearing in an NA script trips the NA guard', judge(c3, 'NA').ok === false);

// C4: a PENDING script adopts the block without being reclassified -> the PENDING guard flips.
var c4 = read('bwn-suite-core.user.js') + '\n' + START + '\n' + END + '\n';
A.ok('C4: a PENDING script that grew the block is caught', judge(c4, 'PENDING').ok === false);

// C5: a disk file with no ledger row (dropped/forgotten row).
var c5disk = onDisk.concat(['bwn-phantom.user.js']);
A.ok('C5: a disk script with no ledger row is caught',
  c5disk.every(function (f) { return inLedger.indexOf(f) !== -1; }) === false);

// C6: a ledger row whose file is gone from disk (duplicated/stale row).
var c6ledger = inLedger.concat(['bwn-ghost.user.js']);
A.ok('C6: a ledger row with no file on disk is caught',
  c6ledger.every(function (f) { return onDisk.indexOf(f) !== -1; }) === false);

// C7: the block present but with a corrupted END marker (START without END) reads as absent, not adopted.
var c7 = SRC[anAdopter].replace(END, '// ===== BWN-SHARED END v1 CORRUPT');
A.ok('C7: a block missing its END marker fails ADOPTED', judge(c7, 'ADOPTED').ok === false);

console.log('\n(ledger: ' + onDisk.length + ' scripts, one canonical token-picker block. Green == the recorded US-1');
console.log(' step-1 scope; a red here is drift from it, named by script, never a silent duplicate.)');
A.finish();
