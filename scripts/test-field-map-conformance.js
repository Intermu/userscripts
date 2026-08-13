// test-field-map-conformance.js - the userscript half of the B.1 shared field map.
//
// scripts/field-map.json here is a byte-identical MIRROR of the CANONICAL copy in the SWA
// repo (broadway-internal-ops/api/shared/field-map.json). The SWA routes require it at
// runtime; a Tampermonkey @grant-none script cannot require a file in the browser, so on
// this side the map is a test-time contract only. This test asserts that the SHIPPED
// bwn-suite-core.user.js board producer (heatDatasetRows) emits only wire keys the map
// declares with the "board" producer - so Core can never start sending a field the map
// (and therefore the SWA route + Dashboard) doesn't know about, the drift that
// store-key-two-writers-drift and getfield-alias-orphan both are.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-field-map-conformance.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}

var MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'field-map.json'), 'utf8'));
var byWire = {};
MAP.fields.forEach(function (f) { byWire[f.wire] = f; });

// --- Board producer wire keys, read out of the shipped heatDatasetRows -------------------
var core = readLF(path.join(__dirname, '..', 'bwn-suite-core.user.js'));
var SRC = slice(core, '    var HEAT_DATASET_MAX = 5000;', '    // END heatDatasetRows', 'heatDatasetRows');

// keys set two ways: the `var row = { target:..., woNumber:... }` literal, and every
// `row.<key> = ...` assignment after it (excluding `==` comparisons and read-only refs).
var emitted = {};
var lit = SRC.match(/var row = \{([^}]*)\}/);
if (lit) { (lit[1].match(/(\w+)\s*:/g) || []).forEach(function (m) { emitted[m.replace(/\s*:$/, '')] = true; }); }
var re = /row\.(\w+)\s*=(?!=)/g, m;
while ((m = re.exec(SRC)) !== null) { emitted[m[1]] = true; }
var emittedKeys = Object.keys(emitted);

A.ok('heatDatasetRows emits at least the core identity + several fields', emittedKeys.length >= 10, 'got ' + emittedKeys.length);

emittedKeys.forEach(function (k) {
  var f = byWire[k];
  A.ok('board producer key "' + k + '" is a declared field-map wire', !!f, 'not in field-map.json');
  if (f) {
    A.ok('board producer key "' + k + '" is tagged with the board producer', f.producers.indexOf('board') !== -1,
      'field-map lists producers=' + JSON.stringify(f.producers) + ' - board push emits a field the map does not attribute to the board');
  }
});

// --- Best-effort cross-repo byte check (local dev only; skipped in CI) --------------------
var CANON = 'C:/Users/mnajarro/OneDrive - Broadway National/Documents/GitHub/broadway-internal-ops/api/shared/field-map.json';
if (fs.existsSync(CANON)) {
  // Compare EOL-normalized text, never raw bytes: `* text=auto` in both repos means a
  // checkout on a core.autocrlf machine can hand back CRLF, and a raw-byte compare would
  // false-alarm on line endings alone (byte-compare-fails-on-eol). Real content drift
  // still fails; only EOL is ignored.
  var norm = function (p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); };
  A.ok('mirror content matches the SWA canonical field-map.json (EOL-normalized)',
    norm(path.join(__dirname, 'field-map.json')) === norm(CANON),
    'the two copies have drifted - re-copy the canonical (see field-map.json _comment)');
} else {
  console.log('  ..  - cross-repo byte check SKIPPED (SWA canonical not on this machine; CI-expected)');
}

A.finish();
