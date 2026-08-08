// test-domproj-parity.js - the DOM handle protocol's two shared blocks are PASTE-IDENTICAL
// across two repositories, and this is what makes that true rather than intended.
//
// sync-theme.js keeps the SWA tool pages in step with bwn-domproj.js / bwn-domcollect.js, but it
// targets SWA files only - it cannot reach this repo. So Core carries the same bytes as a pasted
// block, and a paste has no mechanism behind it. Two copies of a projector that drift produce
// handles that disagree about which control is @b1, on two surfaces the same model is driving.
// That is the [[store-key-two-writers-drift]] shape with a repo boundary in the middle.
//
// Precedent: scripts/test-assist-roundtrip.js slices real shipped bytes rather than a fixture.
//
// THIS HARNESS FAILS LOUDLY WHEN IT CANNOT CHECK. If the broadway-internal-ops checkout is not
// found it exits NON-ZERO instead of skipping. A parity test that goes green because it could not
// locate one of the two things it compares is worse than no parity test: it reports agreement it
// never looked for ([[negative-control-silent-noop]]).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-domproj-parity.js
//   Override the sibling repo location with BWN_OPS_REPO=<path> if the checkout moves.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var CORE = path.join(__dirname, '..', 'bwn-suite-core.user.js');

var CANDIDATES = [
  process.env.BWN_OPS_REPO,
  path.join(process.env.USERPROFILE || process.env.HOME || '', 'OneDrive - Broadway National', 'Documents', 'GitHub', 'broadway-internal-ops'),
  path.join(__dirname, '..', '..', 'broadway-internal-ops'),
].filter(Boolean);

var OPS = null;
for (var i = 0; i < CANDIDATES.length; i++) {
  if (fs.existsSync(path.join(CANDIDATES[i], 'bwn-domproj.js'))) { OPS = CANDIDATES[i]; break; }
}
if (!OPS) {
  console.error('CANNOT VERIFY PARITY: no broadway-internal-ops checkout found. Looked in:');
  CANDIDATES.forEach(function (c) { console.error('  ' + c); });
  console.error('Set BWN_OPS_REPO to the checkout path. Exiting non-zero - this is a failure to');
  console.error('CHECK, not a pass. The pasted blocks in Core are unverified against their source.');
  process.exit(1);
}
console.log('comparing against: ' + OPS + '\n');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

// The canonical form sync-theme.js inlines: the whole file with one trailing blank line trimmed.
// Reproduced here rather than imported, because the point is to check the RESULT of that rule,
// and a shared implementation would agree with itself by construction.
function sourceBody(p) {
  var lines = readLF(p).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function region(text, label) {
  var startRe = new RegExp('^/\\* ' + label + ':START\\b[\\s\\S]*?\\*/$', 'm');
  var lines = text.split('\n');
  var si = -1, ei = -1;
  for (var i = 0; i < lines.length; i++) {
    if (si === -1 && lines[i].indexOf('/* ' + label + ':START') === 0) si = i;
    else if (lines[i].indexOf('/* ' + label + ':END') === 0) { ei = i; break; }
  }
  if (si === -1) throw new Error(label + ': START sentinel not found in Core');
  if (ei === -1) throw new Error(label + ': END sentinel not found after START');
  // The START sentinel is a multi-line block comment; the payload begins after its closing */.
  var j = si;
  while (j < ei && lines[j].indexOf('*/') === -1) j++;
  void startRe;
  return { lines: lines.slice(j + 1, ei), si: si, ei: ei };
}

var core = readLF(CORE);

// ---- 1. byte identity ---------------------------------------------------------------------
[['BWN-DOM', 'bwn-domproj.js'], ['BWN-DOMC', 'bwn-domcollect.js']].forEach(function (pair) {
  var label = pair[0], file = pair[1];
  var got, want = sourceBody(path.join(OPS, file));
  try { got = region(core, label).lines.join('\n'); }
  catch (e) { A.ok(label + ': region present in Core', false, e.message); return; }
  A.ok(label + ': region present in Core', true);
  if (got === want) { A.ok(label + ': byte-identical to ' + file, true); return; }
  // Name the FIRST differing line. "not identical" sends the next reader diffing 600 lines by eye.
  var g = got.split('\n'), w = want.split('\n'), n = Math.max(g.length, w.length), at = -1;
  for (var k = 0; k < n; k++) { if (g[k] !== w[k]) { at = k; break; } }
  A.ok(label + ': byte-identical to ' + file, false,
    'first difference at block line ' + (at + 1) + ' of ' + g.length + '/' + w.length +
    '\n      core: ' + JSON.stringify((g[at] || '(missing)').slice(0, 90)) +
    '\n      ops : ' + JSON.stringify((w[at] || '(missing)').slice(0, 90)));
});

// ---- 2. load order ------------------------------------------------------------------------
// The collector reads window.BWNDOM at load. Reversed, it binds null and every verb throws on
// first use rather than at load, which is the worst place to discover it.
var domS = core.indexOf('/* BWN-DOM:START'), domcS = core.indexOf('/* BWN-DOMC:START');
A.ok('BWN-DOM is defined before BWN-DOMC', domS >= 0 && domcS >= 0 && domS < domcS,
  'BWN-DOM at ' + domS + ', BWN-DOMC at ' + domcS);

// ---- 3. the SWA copy is in the same state -------------------------------------------------
// Three copies exist, not two: the source, Core's paste, and the sentinel region sync-theme
// inlines into the Watchtower. Checking Core against the source while the SWA page silently
// lagged would still leave two surfaces disagreeing.
var WT = path.join(OPS, 'Broadway_Ops_Watchtower.html');
if (!fs.existsSync(WT)) {
  A.ok('Watchtower page found for the third-copy check', false, WT + ' missing');
} else {
  var wt = readLF(WT);
  [['BWN-DOM', 'bwn-domproj.js'], ['BWN-DOMC', 'bwn-domcollect.js']].forEach(function (pair) {
    var got;
    try { got = region(wt, pair[0]).lines.join('\n'); }
    catch (e) { A.ok('Watchtower ' + pair[0] + ' region present', false, e.message); return; }
    A.ok('Watchtower ' + pair[0] + ' matches ' + pair[1], got === sourceBody(path.join(OPS, pair[1])),
      'the SWA copy has drifted from the source - run node sync-theme.js in broadway-internal-ops');
  });
}

// ---- 4. the paste really is a paste --------------------------------------------------------
// Byte identity would also hold if someone re-indented BOTH copies. These pin the properties the
// no-edit rule depends on: the block starts at column 0 in Core, and Core does not define the
// globals a second time somewhere else.
var coreLines = core.split('\n');
var dom = region(core, 'BWN-DOM');
A.ok('the pasted block sits at column 0 (no re-indent)',
  coreLines[dom.si + 4] === undefined || !/^\s+\(function \(root\)/.test(coreLines[dom.si + 4] || ''),
  'a re-indented paste passes byte identity only until the next sync');
A.ok('window.BWNDOM is assigned exactly once in Core',
  (core.match(/root\.BWNDOM = DP;/g) || []).length === 1);
A.ok('window.BWNDOMC is assigned exactly once in Core',
  (core.match(/root\.BWNDOMC = DC;/g) || []).length === 1);

// ---- 5. the no-edit rule is stated where an editor will see it -----------------------------
A.ok('BWN-DOM sentinel warns against editing in place', /never edit this region/i.test(core.slice(domS, domS + 600)));

// ---- 6. mutation controls: this harness bites ----------------------------------------------
// A parity check is exactly the kind of test that passes forever after it stops working - it has
// no behaviour of its own to go wrong. These re-run the real comparison against a mutated copy of
// Core held in memory (nothing is written to disk) and assert it goes RED.
function compareOne(coreText, label, file) {
  try { return region(coreText, label).lines.join('\n') === sourceBody(path.join(OPS, file)); }
  catch (e) { return false; }
}
function mutateCore(from, to) {
  var i = core.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 60)));
  if (core.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 60)));
  return core.slice(0, i) + to + core.slice(i + from.length);
}

A.ok('M1 a one-character drift inside BWN-DOM is caught',
  compareOne(mutateCore('DP.KINDS = {', 'DP.KINDS  = {'), 'BWN-DOM', 'bwn-domproj.js') === false);

A.ok('M2 a dropped line inside BWN-DOMC is caught',
  compareOne(mutateCore('  DC.ERROR = {\n', ''), 'BWN-DOMC', 'bwn-domcollect.js') === false);

A.ok('M3 re-indenting the pasted block is caught',
  compareOne(mutateCore('\n(function (root) {\n  "use strict";\n\n  var DP = { VERSION: "0.1.0" };',
    '\n  (function (root) {\n    "use strict";\n\n    var DP = { VERSION: "0.1.0" };'),
    'BWN-DOM', 'bwn-domproj.js') === false);

A.ok('M4 a missing END sentinel fails rather than comparing a truncated block',
  compareOne(mutateCore('/* BWN-DOM:END */', '/* nothing to see here */'), 'BWN-DOM', 'bwn-domproj.js') === false);

var threw = false;
try { mutateCore('this string is not in Core', 'x'); } catch (e) { threw = /ABSENT/.test(e.message); }
A.ok('M5 mutateCore throws on a missing target (a control cannot silently no-op)', threw);

A.finish();
