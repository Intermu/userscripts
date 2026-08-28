// test-drawerdismiss-ledger.js - byte-identical paste ledger for the ONE canonical drawerDismiss(el).
//
// WHY THIS EXISTS (RM-B1):
//   Six drawer modules close their overlay through the same helper - `drawerDismiss(el)`: honour
//   prefers-reduced-motion with an immediate remove, else free the id, mark aria-hidden, add the
//   `.bwn-closing` class that drives Core's exit keyframes, and remove after a 170ms delay. Each
//   userscript runs in its own Tampermonkey sandbox and cannot share a runtime object (see
//   test-shared-block-ledger.js), so "one drawerDismiss" means ONE canonical BODY pasted
//   byte-identical into every adopter. Before RM-B1 five copies were already identical and
//   bwn-inventory's had dropped the `// id freed` comment; RM-B1 re-unified them and this harness
//   SHA-gates the paste so a copy can never drift again.
//
//   THE EXIT CONTRACT IS LOAD-BEARING. `.bwn-closing` and the 170ms delay ARE the drawer close
//   sequence; the CSS @keyframes bwn-drawer-in that Job View references by name is NOT touched by
//   this helper and must never be renamed. Section 3 pins both `.bwn-closing` and the delay directly
//   so a "cleanup" that quietly changes the timing or drops the class goes red here.
//
//   COMPLEMENTS test-drawer-motion.js: that harness RUNS each module's drawerDismiss in a vm and
//   proves the exit BEHAVIOUR (immediate under reduced motion, 170ms otherwise, .bwn-closing added).
//   This one gates the BYTES, catching a behaviour-preserving drift the motion probes would pass.
//
// STATUS VOCABULARY (per script):
//   CANONICAL - carries exactly one `function drawerDismiss(el)` whose EOL-normalized body SHA == CANON_SHA.
//   VARIANT   - carries a DIFFERENT drawerDismiss on purpose (bwn-suite-core's Core-owned
//               drawerDismiss(node, fader) superset + a deeper-nested bulk drawerDismiss(el)),
//               with a recorded reason. Asserted to carry NO body that equals the canonical, so an
//               unpinned canonical copy cannot hide under VARIANT.
//   NONE      - carries no drawerDismiss definition at all. Asserted absent.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-drawerdismiss-ledger.js
// No pixels, no network: this reads the shipped bytes only.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n'); }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

var CANON_SIG = 'function drawerDismiss(el)';
var CANON_SHA = 'c85e6960c3c4723e1b587c577d0f0d018c01f9fcae8befb1038452a6f4f21b85';
// Any drawerDismiss DEFINITION in any arity (el / node,fader).
var DRAWER_ANY_DEF = /function\s+drawerDismiss\s*\(/;

// Brace-match the function starting at `idx` (which points at 'function'). Returns the text, or null
// if the braces do not balance (e.g. a commented-out sketch), in which case the caller treats it as
// "not a canonical body" - which is correct, a comment is never a real definition.
function sliceFnAt(src, idx) {
  var b = src.indexOf('{', idx);
  if (b === -1) return null;
  var depth = 0, i = b;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return depth === 0 ? src.slice(idx, i) : null;
}
// Every `function drawerDismiss(el)` occurrence, sliced. Multiple/garbage occurrences are fine here:
// the judge only asks whether any of them hashes to the canonical.
function sliceAllEl(src) {
  var out = [], from = 0, idx;
  while ((idx = src.indexOf(CANON_SIG, from)) !== -1) {
    var t = sliceFnAt(src, idx);
    if (t) out.push(t);
    from = idx + CANON_SIG.length;
  }
  return out;
}
function hasCanonBody(src) { return sliceAllEl(src).some(function (t) { return sha(t) === CANON_SHA; }); }

// ---- one pure judge, used by both the real assertions and every negative control -------------
function judge(src, status) {
  if (status === 'CANONICAL') {
    var bodies = sliceAllEl(src);
    if (bodies.length === 0) return { ok: false, why: 'ledger says CANONICAL but no drawerDismiss(el) is found' };
    if (bodies.length > 1) return { ok: false, why: 'more than one drawerDismiss(el) in a CANONICAL script - fold to one' };
    if (sha(bodies[0]) !== CANON_SHA) return { ok: false, why: 'drawerDismiss body SHA != canonical (a byte drifted: reject the paste, do not re-pin)' };
    return { ok: true, why: 'canonical drawerDismiss body present, hash matches' };
  }
  if (status === 'VARIANT') {
    if (!DRAWER_ANY_DEF.test(src)) return { ok: false, why: 'ledger says VARIANT (a distinct drawerDismiss) but no drawerDismiss definition is found' };
    if (hasCanonBody(src)) return { ok: false, why: 'a VARIANT script carries an exact canonical drawerDismiss body - reclassify it CANONICAL' };
    return { ok: true, why: 'a distinct drawerDismiss, deliberately not part of the canonical family' };
  }
  if (status === 'NONE') {
    if (DRAWER_ANY_DEF.test(src)) return { ok: false, why: 'a NONE script grew a drawerDismiss - classify it (CANONICAL or VARIANT)' };
    return { ok: true, why: 'no drawerDismiss definition, as declared' };
  }
  return { ok: false, why: 'unknown status ' + status };
}

// ---- THE LEDGER: measured suite state, RM-B1 -------------------------------------------------
var LEDGER = {
  'bwn-ask.user.js':              { status: 'NONE' },
  'bwn-bid-out.user.js':          { status: 'NONE' },
  'bwn-cc-auth.user.js':          { status: 'CANONICAL' },
  'bwn-cc-purchase.user.js':      { status: 'CANONICAL' },
  'bwn-dispatch.user.js':         { status: 'CANONICAL' },
  'bwn-drop-upload.user.js':      { status: 'NONE' },
  'bwn-inventory.user.js':        { status: 'CANONICAL' },
  'bwn-kanban.user.js':           { status: 'NONE' },
  'bwn-low-gp.user.js':           { status: 'NONE' },
  'bwn-notes.user.js':            { status: 'NONE' },
  'bwn-proposal-actions.user.js': { status: 'NONE' },
  'bwn-proposal-copy.user.js':    { status: 'NONE' },
  'bwn-suite-ai.user.js':         { status: 'NONE' },
  'bwn-suite-core.user.js':       { status: 'VARIANT', reason: 'Core owns drawerDismiss(node, fader) (fader + DRAWER_EXIT_MS superset) and a deeper-nested bulk drawerDismiss(el); folded separately, gated by test-drawer-motion.js' },
  'bwn-temp-vendor.user.js':      { status: 'NONE' },
  'bwn-vendor-intake.user.js':    { status: 'NONE' },
  'bwn-wide-list.user.js':        { status: 'NONE' },
  'bwn-wo-assist.user.js':        { status: 'CANONICAL' },
  'bwn-wo-audit.user.js':         { status: 'CANONICAL' },
  'bwn-wo-intake.user.js':        { status: 'NONE' },
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
// 3. AGGREGATE + EXIT CONTRACT: the counts RM-B1 committed to, one canonical SHA, and the close
// sequence the canonical MUST preserve (.bwn-closing + the 170ms delay).
// =============================================================================================
console.log('\n-- 3. aggregate counts + one canonical SHA + exit contract --');
A.ok('CANONICAL count is 6', ledgerWith('CANONICAL').length === 6, 'got ' + ledgerWith('CANONICAL').length);
A.ok('VARIANT count is 1', ledgerWith('VARIANT').length === 1, 'got ' + ledgerWith('VARIANT').length);
A.ok('NONE count is 14', ledgerWith('NONE').length === 14, 'got ' + ledgerWith('NONE').length);
var shas = {};
ledgerWith('CANONICAL').forEach(function (f) { shas[sha(sliceAllEl(SRC[f])[0])] = true; });
A.ok('all CANONICAL adopters share ONE drawerDismiss SHA', Object.keys(shas).length === 1, 'distinct: ' + Object.keys(shas).join(','));
A.ok('that SHA is CANON_SHA', Object.keys(shas)[0] === CANON_SHA, Object.keys(shas)[0]);
// The guardrail, pinned on the actual canonical bytes of one adopter.
var canonBody = sliceAllEl(SRC['bwn-cc-auth.user.js'])[0];
A.ok('canonical preserves the .bwn-closing close class', /classList\.add\('bwn-closing'\)/.test(canonBody), canonBody.slice(0, 120));
A.ok('canonical preserves the 170ms dismiss delay', /\},\s*170\)/.test(canonBody), canonBody.slice(-120));
A.ok('canonical still removes immediately under reduced motion', /if \(reduce\) \{ el\.remove\(\); return; \}/.test(canonBody));

// =============================================================================================
// 4. NEGATIVE CONTROLS: each reproduces a specific drift and requires the pure judge (or a guard)
// to catch it. A control that no-ops would let the guard rot.
// =============================================================================================
console.log('\n-- 4. negative controls (each must flip RED) --');
var anAdopter = 'bwn-cc-auth.user.js';

// C1: mutate the dismiss delay inside an adopter's body -> SHA no longer matches CANON_SHA.
var c1 = SRC[anAdopter].replace('}, 170);', '}, 200);');
A.ok('C1: a changed dismiss delay is caught', c1 !== SRC[anAdopter] && judge(c1, 'CANONICAL').ok === false);

// C1b: dropping the .bwn-closing class inside an adopter -> SHA drift (and the exit contract breaks).
var c1b = SRC[anAdopter].replace("el.classList.add('bwn-closing');", "");
A.ok('C1b: dropping the .bwn-closing class is caught', c1b !== SRC[anAdopter] && judge(c1b, 'CANONICAL').ok === false);

// C2: the VARIANT (suite-core) grows an EXACT canonical copy -> the "no canon body" guard trips.
var c2 = SRC['bwn-suite-core.user.js'] + '\n  ' + canonBody + '\n';
A.ok('C2: an exact canonical body pasted into the VARIANT is caught', judge(c2, 'VARIANT').ok === false);

// C3: a NONE script grows a drawerDismiss -> the NONE guard refuses to keep calling it NONE.
var c3 = SRC['bwn-kanban.user.js'] + '\n  function drawerDismiss(el) { el.remove(); }\n';
A.ok('C3: a drawerDismiss appearing in a NONE script trips the NONE guard', judge(c3, 'NONE').ok === false);

// C4: the canonical body itself is accepted (positive anchor for the judge).
A.ok('C4: an unperturbed adopter is accepted', judge(SRC[anAdopter], 'CANONICAL').ok === true);

// C5: the VARIANT is load-bearing, not a free pass: suite-core really does carry a drawerDismiss,
// and it is genuinely NOT the canonical body.
A.ok('C5a: the VARIANT does carry a drawerDismiss', DRAWER_ANY_DEF.test(SRC['bwn-suite-core.user.js']) === true);
A.ok('C5b: ...and none of its bodies equals the canonical', hasCanonBody(SRC['bwn-suite-core.user.js']) === false);

// C6: a disk file with no ledger row / a ledger row with no file.
A.ok('C6a: a disk script with no ledger row is caught',
  onDisk.concat(['bwn-phantom.user.js']).every(function (f) { return inLedger.indexOf(f) !== -1; }) === false);
A.ok('C6b: a ledger row with no file on disk is caught',
  inLedger.concat(['bwn-ghost.user.js']).every(function (f) { return onDisk.indexOf(f) !== -1; }) === false);

console.log('\n(ledger: ' + onDisk.length + ' scripts, one canonical drawerDismiss(el) across ' + ledgerWith('CANONICAL').length +
  ' adopters, exit contract pinned. A red here is drift from the RM-B1 scope, named by script.)');
A.finish();
