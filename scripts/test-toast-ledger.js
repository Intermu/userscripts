// test-toast-ledger.js - byte-identical paste ledger for the ONE canonical bottom-centre toast.
//
// WHY THIS EXISTS (RM-B1):
//   Six userscripts show the same bottom-centre, transition-animated toast - `toast(msg, ms, bg)`.
//   Each runs in its own Tampermonkey sandbox and cannot share a runtime object (see
//   test-shared-block-ledger.js), so "one toast" means ONE canonical BODY pasted byte-identical into
//   every adopter. Before RM-B1 the six had already drifted: three defaulted the background to a
//   `GREEN` constant that only three files even define, three inlined the '#0d3d26' literal, and the
//   inline motion comments had diverged (full rationale / short pointer / none). RM-B1 unified them
//   on the portable literal form and this harness is the stop-drift-by-hand half: it slices the
//   toast body out of every adopter and SHA-gates it to ONE canonical, going RED the instant a byte
//   drifts, a copy disappears, or a NON-adopter grows the canonical signature unclassified.
//
//   COMPLEMENTS test-drawer-motion.js, it does not duplicate it: that harness RUNS each module's
//   toast in a vm and proves the MOTION behaviour (enter-on-transition, 420ms exit, reduced-motion).
//   This one gates the BYTES, so a second, behaviour-preserving drift (a colour, a duration, a
//   comment) that the motion probes would wave through still cannot land silently.
//
// STATUS VOCABULARY (per script):
//   CANONICAL - carries `function toast(msg, ms, bg)` whose EOL-normalized body SHA == CANON_SHA.
//   VARIANT   - carries a DIFFERENT toast on purpose (single-arg, leveled BWN.toast, url-bearing,
//               or a differently-placed/prefixed toast) that is NOT part of this family, with a
//               recorded reason. Asserted to NOT carry the canonical signature, so a half-migration
//               (canonical sig pasted in beside the variant) is caught.
//   NONE      - carries no toast definition at all. Asserted absent, so a script that grows one can
//               never sit silently under NONE.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-toast-ledger.js
// No pixels, no network: this reads the shipped bytes only.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n'); }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// The canonical signature and the SHA of its EOL-normalized body (from 'function' through the
// matching '}'). Regenerate ONLY after a deliberate change to the canonical, by re-running this
// file's slicer over an adopter and pasting the new hash here.
var CANON_SIG = 'function toast(msg, ms, bg)';
var CANON_SHA = 'daae4ee5f50b3a8dacacdd7e17e2b7fbfe85c95579057aaa25b0a23de6b8398d';

// Any toast DEFINITION (not a call): `function toast(...)` or `X.toast = function` / `toast = function`.
var TOAST_ANY_DEF = /function\s+toast\s*\(|(?:\.|\b)toast\s*=\s*function/;

// Brace-match `function ... { ... }` starting at CANON_SIG. The toast bodies carry no braces inside
// string literals that would unbalance a depth count (their strings are css/transition text), so a
// plain depth counter is exact here.
function sliceCanonFn(src) {
  var start = src.indexOf(CANON_SIG);
  if (start === -1) return null;
  var b = src.indexOf('{', start);
  if (b === -1) return null;
  var depth = 0, i = b;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return depth === 0 ? src.slice(start, i) : null;
}
function canonCount(src) { return src.split(CANON_SIG).length - 1; }

// ---- one pure judge, used by both the real assertions and every negative control -------------
function judge(src, status) {
  if (status === 'CANONICAL') {
    if (canonCount(src) === 0) return { ok: false, why: 'ledger says CANONICAL but the canonical toast signature is MISSING' };
    if (canonCount(src) > 1) return { ok: false, why: 'the canonical toast signature appears more than once' };
    var body = sliceCanonFn(src);
    if (!body) return { ok: false, why: 'canonical signature present but the function body could not be sliced' };
    if (sha(body) !== CANON_SHA) return { ok: false, why: 'toast body SHA != canonical (a byte drifted: reject the paste, do not re-pin)' };
    return { ok: true, why: 'canonical toast body present, hash matches' };
  }
  if (status === 'VARIANT') {
    if (canonCount(src) !== 0) return { ok: false, why: 'a VARIANT script carries the canonical toast signature - reclassify it CANONICAL or keep its toast distinct' };
    if (!TOAST_ANY_DEF.test(src)) return { ok: false, why: 'ledger says VARIANT (a distinct toast) but no toast definition is found' };
    return { ok: true, why: 'a distinct toast, deliberately not part of the canonical family' };
  }
  if (status === 'NONE') {
    if (TOAST_ANY_DEF.test(src)) return { ok: false, why: 'an NONE script grew a toast - classify it (CANONICAL or VARIANT)' };
    return { ok: true, why: 'no toast definition, as declared' };
  }
  return { ok: false, why: 'unknown status ' + status };
}

// ---- THE LEDGER: measured suite state, RM-B1 -------------------------------------------------
// Every bwn-*.user.js in the repo root MUST appear here (Section 1 enforces both directions).
var LEDGER = {
  'bwn-ask.user.js':              { status: 'NONE' },
  'bwn-bid-out.user.js':          { status: 'VARIANT', reason: 'toast(msg): bottom-right, "Bid-Out:" prefix, no motion - a distinct placement' },
  'bwn-cc-auth.user.js':          { status: 'CANONICAL' },
  'bwn-cc-purchase.user.js':      { status: 'CANONICAL' },
  'bwn-dispatch.user.js':         { status: 'CANONICAL' },
  'bwn-drop-upload.user.js':      { status: 'VARIANT', reason: 'toast(msg): bottom-centre BLUE (#1b2a4a), "BWN Drop Upload:" prefix - a distinct style' },
  'bwn-inventory.user.js':        { status: 'CANONICAL' },
  'bwn-kanban.user.js':           { status: 'NONE' },
  'bwn-low-gp.user.js':           { status: 'NONE' },
  'bwn-notes.user.js':            { status: 'NONE' },
  'bwn-proposal-actions.user.js': { status: 'NONE' },
  'bwn-proposal-copy.user.js':    { status: 'NONE' },
  'bwn-suite-ai.user.js':         { status: 'VARIANT', reason: 'toast(msg): delegates to Core coreToast, else a bottom-right fallback - a distinct API' },
  'bwn-suite-core.user.js':       { status: 'VARIANT', reason: 'BWN.toast(level,msg,opts) leveled + a separate toast(msg,url) - distinct signatures owned by Core' },
  'bwn-temp-vendor.user.js':      { status: 'NONE' },
  'bwn-vendor-intake.user.js':    { status: 'VARIANT', reason: 'toast(msg, ms): bottom-right, "Vendor Intake:" prefix, no motion - a distinct placement' },
  'bwn-wide-list.user.js':        { status: 'NONE' },
  'bwn-wo-assist.user.js':        { status: 'CANONICAL' },
  'bwn-wo-audit.user.js':         { status: 'VARIANT', reason: 'toast(msg): bottom-centre green, no motion, 3200ms - a distinct (un-animated) toast' },
  'bwn-wo-intake.user.js':        { status: 'CANONICAL' },
  'bwn-write-queue.user.js':      { status: 'NONE' }
};
function ledgerWith(status) { return Object.keys(LEDGER).filter(function (f) { return LEDGER[f].status === status; }); }

// =============================================================================================
// 1. MANIFEST COMPLETENESS: every *.user.js on disk is in the ledger, and vice versa.
// =============================================================================================
console.log('-- 1. manifest: disk <-> ledger --');
var onDisk = fs.readdirSync(ROOT).filter(function (f) { return /^bwn-.*\.user\.js$/.test(f); });
var inLedger = Object.keys(LEDGER);
onDisk.forEach(function (f) { A.ok('on disk and in the ledger: ' + f, inLedger.indexOf(f) !== -1, 'a new script must be given a row before it ships'); });
inLedger.forEach(function (f) { A.ok('in the ledger and still on disk: ' + f, onDisk.indexOf(f) !== -1, 'a removed script must be dropped from the ledger'); });
A.ok('ledger row count equals the ' + onDisk.length + ' scripts on disk', inLedger.length === onDisk.length, 'ledger ' + inLedger.length + ' vs disk ' + onDisk.length);

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
  if (status === 'VARIANT') {
    A.ok('  ^ ' + f + ' VARIANT has a recorded reason', typeof LEDGER[f].reason === 'string' && LEDGER[f].reason.length > 0,
      'a deliberate exclusion must be named so it is not silently forgotten');
  }
});

// =============================================================================================
// 3. AGGREGATE: the counts RM-B1 committed to, and every CANONICAL body is the SAME bytes.
// =============================================================================================
console.log('\n-- 3. aggregate counts + one canonical SHA --');
A.ok('CANONICAL count is 6', ledgerWith('CANONICAL').length === 6, 'got ' + ledgerWith('CANONICAL').length);
A.ok('VARIANT count is 6', ledgerWith('VARIANT').length === 6, 'got ' + ledgerWith('VARIANT').length);
A.ok('NONE count is 9', ledgerWith('NONE').length === 9, 'got ' + ledgerWith('NONE').length);
var shas = {};
ledgerWith('CANONICAL').forEach(function (f) { shas[sha(sliceCanonFn(SRC[f]))] = true; });
A.ok('all CANONICAL adopters share ONE toast SHA', Object.keys(shas).length === 1, 'distinct: ' + Object.keys(shas).join(','));
A.ok('that SHA is CANON_SHA', Object.keys(shas)[0] === CANON_SHA, Object.keys(shas)[0]);

// =============================================================================================
// 4. NEGATIVE CONTROLS: each reproduces a specific drift and requires the pure judge (or the
// manifest guard) to catch it. A control that no-ops would let the guard rot.
// =============================================================================================
console.log('\n-- 4. negative controls (each must flip RED) --');
var anAdopter = 'bwn-cc-auth.user.js';

// C1: mutate ONE byte inside an adopter's toast body -> SHA no longer matches CANON_SHA.
var c1 = SRC[anAdopter].replace("bottom:26px", "bottom:24px");
A.ok('C1: a one-byte edit inside the toast body is caught', c1 !== SRC[anAdopter] && judge(c1, 'CANONICAL').ok === false);

// C2: a VARIANT script grows the canonical signature (half-migration) -> variant guard trips.
var c2 = SRC['bwn-wo-audit.user.js'] + '\n  function toast(msg, ms, bg) { return msg; }\n';
A.ok('C2: the canonical signature appearing in a VARIANT script is caught', judge(c2, 'VARIANT').ok === false);

// C3: a NONE script grows a toast -> the NONE guard refuses to keep calling it NONE.
var c3 = SRC['bwn-kanban.user.js'] + '\n  function toast(msg) { return msg; }\n';
A.ok('C3: a toast appearing in a NONE script trips the NONE guard', judge(c3, 'NONE').ok === false);

// C4: the canonical body itself is accepted (positive anchor for the judge).
A.ok('C4: an unperturbed adopter is accepted', judge(SRC[anAdopter], 'CANONICAL').ok === true);

// C5: a disk file with no ledger row (dropped/forgotten row).
A.ok('C5: a disk script with no ledger row is caught',
  onDisk.concat(['bwn-phantom.user.js']).every(function (f) { return inLedger.indexOf(f) !== -1; }) === false);

// C6: a ledger row whose file is gone from disk (stale row).
A.ok('C6: a ledger row with no file on disk is caught',
  inLedger.concat(['bwn-ghost.user.js']).every(function (f) { return onDisk.indexOf(f) !== -1; }) === false);

console.log('\n(ledger: ' + onDisk.length + ' scripts, one canonical bottom-centre toast across ' + ledgerWith('CANONICAL').length +
  ' adopters. A red here is drift from the RM-B1 scope, named by script.)');
A.finish();
