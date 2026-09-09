// userscript-meta.js - the ONE metadata-block parser for the BWN suite.
//
// WHY THIS EXISTS (US-0):
//   Five harnesses each grew their own narrow `@version`-only check - test-kanban-card.js,
//   test-proposal-actions.js, test-write-queue-drain.js, test-wq-catalog-push.js and
//   test-assist-roundtrip.js all re-derive the version by hand (regex or a literal indexOf on
//   `// @version      1.80.2`). Nothing in the repo ever parsed @name / @namespace / @match /
//   @updateURL / @require as structured fields, so nothing could answer "does the installed copy
//   match what we shipped, and is it even governed by auto-update". This module is that parser,
//   written once, and it is the only place the ==UserScript== block gets interpreted.
//
// TRUST BOUNDARY:
//   parseMeta() is fed BOTH repo files (trusted bytes, in git) and the contents of a Tampermonkey
//   export the user hands over (UNTRUSTED - a source-less side-load names itself whatever it wants,
//   including `__proto__` or a string full of markup). So:
//     - the key map is Object.create(null): a `@__proto__` line can never reach Object.prototype,
//       and can never vanish from Object.keys() and thereby hide a row from the report;
//     - directive keys are charset-validated, and anything unrecognised is kept as data, never
//       executed, never interpolated into markup (this module returns data only - no rendering);
//     - a missing or malformed block returns null instead of throwing, so ONE bad file in an export
//       directory cannot abort the whole run;
//     - the block scan is capped, so a multi-megabyte file cannot be walked line by line forever.
//
// Run (bundled node, no node on PATH):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-manifest-ledger.js
// No network, no filesystem writes: this module reads strings and returns objects.

var crypto = require('crypto');

var BLOCK_START = '// ==UserScript==';
var BLOCK_END = '// ==/UserScript==';

// A metadata block lives at the top of the file. 256 KB of leading slack is far more than any real
// header (Core's is ~200 lines) and bounds the search on a pasted multi-megabyte body.
var HEAD_SCAN = 256 * 1024;

// Every directive is collected as an ordered array; the accessors below take the FIRST occurrence
// for the single-valued ones, which is what Tampermonkey itself honours.
//
// Conservative directive-name charset. Tampermonkey directives are ASCII words with optional
// `-` / `:` (e.g. run-at, name:de). A line whose key falls outside this is recorded under the
// synthetic key `_malformed` rather than trusted as a directive.
var KEY_OK = /^[A-Za-z][A-Za-z0-9:_-]*$/;

function normalize(text) {
  return String(text).replace(/\r\n/g, '\n');
}

// SHA-256 of EOL-normalized text. Same normalization the other ledger harnesses use, so a CRLF
// checkout and an LF checkout of identical content hash identically.
function sha256(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex');
}

// Parse the ==UserScript== block. Returns null when there is no usable block.
//
// Shape:
//   { raw, name, namespace, version, description, updateURL, downloadURL, runAt, noframes,
//     match[], include[], exclude[], grant[], connect[], require[], resource[], malformed[] }
// `raw` is a null-prototype map of directive -> array of values (every occurrence, in order).
function parseMeta(src) {
  var text = normalize(src);
  var head = text.length > HEAD_SCAN ? text.slice(0, HEAD_SCAN) : text;

  var a = head.indexOf(BLOCK_START);
  if (a === -1) return null;
  var b = head.indexOf(BLOCK_END, a);
  if (b === -1) return null;

  var body = head.slice(a + BLOCK_START.length, b);
  var lines = body.split('\n');
  var raw = Object.create(null);
  var malformed = [];

  for (var i = 0; i < lines.length; i++) {
    // Tampermonkey requires each directive line to start with `//` inside the block.
    var m = /^\s*\/\/\s*@(\S+)\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    var key = m[1];
    var value = m[2].replace(/\s+$/, '');
    if (!KEY_OK.test(key)) { malformed.push(lines[i].trim()); continue; }
    if (!Object.prototype.hasOwnProperty.call(raw, key)) raw[key] = [];
    raw[key].push(value);
  }

  // No directive at all inside the markers is not a header, it is noise that happens to contain
  // the marker text. Fail closed.
  var keys = Object.keys(raw);
  if (!keys.length) return null;

  function one(key) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return null;
    return raw[key][0];
  }
  function all(key) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return [];
    return raw[key].slice();
  }

  return {
    raw: raw,
    malformed: malformed,
    name: one('name'),
    namespace: one('namespace'),
    version: one('version'),
    description: one('description'),
    updateURL: one('updateURL'),
    downloadURL: one('downloadURL'),
    runAt: one('run-at'),
    noframes: Object.prototype.hasOwnProperty.call(raw, 'noframes'),
    match: all('match'),
    include: all('include'),
    exclude: all('exclude').concat(all('exclude-match')),
    grant: all('grant'),
    connect: all('connect'),
    require: all('require'),
    resource: all('resource')
  };
}

// The in-body version const a script prints in its own console banner: `var VER = '0.7.6';`
// (also VERSION / BWN_VER). Returns null when the script keeps no such const - 5 of the 21 do not.
// This is a SEPARATE number from the shared-block version (`var VERSION = 7` inside BWN SHARED
// CORE); callers must not conflate the two, so this deliberately only matches a dotted semver-ish
// string literal and never a bare integer.
function bodyVersion(src) {
  var text = normalize(src);
  var m = /^[ \t]*var[ \t]+(?:VER|VERSION|BWN_VER)[ \t]*=[ \t]*'([0-9]+(?:\.[0-9]+)+)'/m.exec(text);
  return m ? m[1] : null;
}

// Tampermonkey's identity key for an installed script is (@namespace, @name) - NOT the filename.
// Renaming @name mints a NEW script in Tampermonkey and leaves the old one installed, which is how
// the em-dash-era copies became shadow installs no @updateURL will ever reach. Every cross-side
// match in the self-check goes through this.
function identity(meta) {
  if (!meta) return null;
  // JSON-encoded pair, not a joined string: a hostile @name could otherwise be crafted
  // so that (namespace, name) joins to the same key as a real script, turning a source-less
  // install into a false MATCH. Encoding the pair keeps the two fields separable.
  return JSON.stringify([meta.namespace || '', meta.name || '']);
}

// A directive value MAY carry a subresource-integrity fragment (`...#sha384=...`). Unpinned remote
// code executes in the Umbrava origin, so the manifest harness requires the pin.
function integrityPin(value) {
  var m = /#(sha256|sha384|sha512)=([A-Za-z0-9+/=_-]+)/.exec(String(value || ''));
  return m ? { algo: m[1], hash: m[2] } : null;
}

module.exports = {
  parseMeta: parseMeta,
  bodyVersion: bodyVersion,
  identity: identity,
  integrityPin: integrityPin,
  sha256: sha256,
  normalize: normalize,
  BLOCK_START: BLOCK_START,
  BLOCK_END: BLOCK_END
};
