// test-manifest-ledger.js - US-0 repo half: the canonical roster vs the shipped bytes.
//
// WHY THIS EXISTS:
//   The suite auto-updates from GitHub Raw: Tampermonkey re-fetches @updateURL, sees a higher
//   @version, and installs. Every link in that chain was unverified. A script could ship with a
//   stale @updateURL, a header whose @version disagreed with the version the script prints about
//   itself, an unpinned @require pulling third-party code into the Umbrava origin, or simply not
//   exist in any roster - and CI would stay green. Two real drifts were sitting on main when this
//   harness was written (bwn-cc-auth @version 0.4.6 vs VER '0.4.1', bwn-cc-purchase 0.7.6 vs
//   '0.7.1'), because only 3 of 21 scripts had any version-pin coverage at all.
//
//   Same discipline as test-ui-contract-ledger.js and test-shared-block-ledger.js: enumerate EVERY
//   bwn-*.user.js on disk, force each into a roster row, and go RED when reality drifts from the
//   roster in EITHER direction. The roster (scripts/userscript-manifest.json) declares only what
//   disk cannot say - expected-installed, and per-check waivers with a reason. Versions, URLs and
//   hashes are derived from the shipped file every run, so the roster cannot drift on them.
//
// CHECKS (per script)
//   META      - the ==UserScript== block parses at all.
//   UPDATEURL - @updateURL == @downloadURL == expectedRawBase + <own filename>. A mismatch means
//               the file either never auto-updates or updates from someone else's bytes.
//   BODYVER   - @version == the in-body VER/VERSION/BWN_VER const, where the script keeps one.
//   NS        - @namespace is the canonical one (identity key half; see the bwn-ask waiver).
//   PIN       - every @require / @resource URL carries a #sha384= (or sha256/sha512) integrity pin.
//   IDENT     - (@namespace, @name) is unique across the suite: two scripts sharing an identity
//               would collide in Tampermonkey and in the self-check's matching.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-manifest-ledger.js
// No network, no writes: reads the shipped bytes and the roster JSON only.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');
var M = require('./userscript-meta.js');

var ROOT = path.join(__dirname, '..');
var MANIFEST_PATH = path.join(__dirname, 'userscript-manifest.json');

// The one canonical namespace. Half of Tampermonkey's identity key, so a change here is a reinstall
// for every user - it is a constant on purpose, waived per script in the roster when it differs.
var CANON_NS = 'broadwaynational.bwn';

var SCRIPT_RE = /^bwn-.*\.user\.js$/;

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

var manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
var RAW_BASE = manifest.expectedRawBase;

// ---- the checks, as pure functions over (file, src, row) ---------------------------------------
// Pure so the negative controls below can drive them with mutated bytes and prove each guard fires.
// Returns an array of problem codes; empty means clean.

function waived(row, check) {
  return !!(row && row.waived && Object.prototype.hasOwnProperty.call(row.waived, check) && row.waived[check]);
}

function auditScript(file, src, row) {
  var problems = [];
  var meta = M.parseMeta(src);
  if (!meta) return ['META: no parseable ==UserScript== block'];

  var want = RAW_BASE + file;
  if (meta.updateURL !== want) problems.push('UPDATEURL: @updateURL is ' + meta.updateURL + ', want ' + want);
  if (meta.downloadURL !== want) problems.push('UPDATEURL: @downloadURL is ' + meta.downloadURL + ', want ' + want);

  if (!meta.version) problems.push('META: no @version');

  var body = M.bodyVersion(src);
  if (body && meta.version && body !== meta.version && !waived(row, 'bodyver')) {
    problems.push('BODYVER: @version ' + meta.version + ' but in-body const ' + body);
  }

  if (meta.namespace !== CANON_NS && !waived(row, 'namespace')) {
    problems.push('NS: @namespace is ' + meta.namespace + ', want ' + CANON_NS);
  }

  var remote = meta.require.concat(meta.resource);
  for (var i = 0; i < remote.length; i++) {
    // @resource is `NAME url`; @require is a bare url. Take the last whitespace-separated token.
    var parts = String(remote[i]).trim().split(/\s+/);
    var url = parts[parts.length - 1];
    if (!/^https:\/\//.test(url)) { problems.push('PIN: non-https remote artifact ' + url); continue; }
    if (!M.integrityPin(url) && !waived(row, 'pin')) problems.push('PIN: unpinned remote artifact ' + url);
  }

  if (meta.malformed.length) problems.push('META: malformed directive line ' + JSON.stringify(meta.malformed[0]));

  return problems;
}

// Bidirectional roster completeness: disk -> roster and roster -> disk.
function auditRoster(files, rosterKeys) {
  var problems = [];
  var inRoster = Object.create(null);
  for (var i = 0; i < rosterKeys.length; i++) inRoster[rosterKeys[i]] = true;
  var onDisk = Object.create(null);
  for (var j = 0; j < files.length; j++) onDisk[files[j]] = true;

  for (var k = 0; k < files.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(inRoster, files[k])) {
      problems.push('ROSTER: ' + files[k] + ' is on disk with no roster row');
    }
  }
  for (var n = 0; n < rosterKeys.length; n++) {
    if (!Object.prototype.hasOwnProperty.call(onDisk, rosterKeys[n])) {
      problems.push('ROSTER: roster row ' + rosterKeys[n] + ' has no file on disk');
    }
  }
  return problems;
}

// ---- the real run ------------------------------------------------------------------------------

var files = fs.readdirSync(ROOT).filter(function (f) { return SCRIPT_RE.test(f); }).sort();
var rosterKeys = Object.keys(manifest.scripts).sort();

console.log('US-0 manifest ledger: ' + files.length + ' scripts on disk, ' + rosterKeys.length + ' roster rows');

A.ok('roster is non-empty', rosterKeys.length > 0, 'no rows in userscript-manifest.json');
A.ok('disk enumeration found scripts', files.length > 0, 'no bwn-*.user.js found under ' + ROOT);
A.ok('expectedRawBase is the Intermu/userscripts main raw base',
  RAW_BASE === 'https://raw.githubusercontent.com/Intermu/userscripts/main/', RAW_BASE);

A.eq('roster and disk agree in both directions', auditRoster(files, rosterKeys), []);

var identities = Object.create(null);
var sources = Object.create(null);

for (var i = 0; i < files.length; i++) {
  var file = files[i];
  var src = read(file);
  sources[file] = src;
  var row = Object.prototype.hasOwnProperty.call(manifest.scripts, file) ? manifest.scripts[file] : null;

  A.eq(file + ' conforms', auditScript(file, src, row), []);

  A.ok(file + ' declares expectedInstalled',
    row && typeof row.expectedInstalled === 'boolean', 'expectedInstalled must be a boolean');

  if (row && row.waived) {
    var checks = Object.keys(row.waived);
    for (var w = 0; w < checks.length; w++) {
      A.ok(file + ' waiver "' + checks[w] + '" carries a reason',
        typeof row.waived[checks[w]] === 'string' && row.waived[checks[w]].length > 20,
        'a waiver without a recorded reason is just silent drift');
    }
  }

  var meta = M.parseMeta(src);
  if (meta) {
    var id = M.identity(meta);
    A.ok(file + ' has a unique (namespace, name) identity',
      !Object.prototype.hasOwnProperty.call(identities, id),
      'identity "' + id + '" already claimed by ' + identities[id]);
    identities[id] = file;
  }
}

// ---- negative controls -------------------------------------------------------------------------
// Each mutates real shipped bytes in memory and asserts the matching guard goes RED. Without these
// the assertions above could be vacuously green (a parser that returns null for everything, a
// comparison that never fires) and nobody would know.

var probe = 'bwn-kanban.user.js';
var probeSrc = sources[probe];
var probeRow = manifest.scripts[probe];

function fired(problems, code) {
  for (var i = 0; i < problems.length; i++) if (problems[i].indexOf(code + ':') === 0) return true;
  return false;
}

A.ok('C1 mutated @version (vs in-body const) goes red',
  fired(auditScript(probe, probeSrc.replace(/^\/\/ @version(\s+)\S+$/m, '// @version$19.9.9'), probeRow), 'BODYVER'),
  'BODYVER guard did not fire on a bumped @version');

A.ok('C2 wrong @updateURL host goes red',
  fired(auditScript(probe, probeSrc.replace('https://raw.githubusercontent.com/Intermu/userscripts/main/' + probe,
    'https://raw.githubusercontent.com/someone-else/userscripts/main/' + probe), probeRow), 'UPDATEURL'),
  'UPDATEURL guard did not fire on a foreign raw host');

A.ok('C3 foreign @namespace goes red',
  fired(auditScript(probe, probeSrc.replace('// @namespace    ' + CANON_NS, '// @namespace    evil.example'), probeRow), 'NS'),
  'NS guard did not fire on a changed namespace');

A.ok('C4 unpinned @require goes red',
  fired(auditScript(probe, probeSrc.replace(M.BLOCK_END,
    '// @require      https://cdn.example.com/thing.js\n' + M.BLOCK_END), probeRow), 'PIN'),
  'PIN guard did not fire on a require with no integrity fragment');

A.ok('C5 a header with no parseable block goes red',
  fired(auditScript(probe, probeSrc.replace(M.BLOCK_START, '// not a userscript header'), probeRow), 'META'),
  'META guard did not fire on a removed start marker');

A.ok('C6 phantom file on disk with no roster row goes red',
  auditRoster(files.concat(['bwn-phantom.user.js']), rosterKeys).length === 1,
  'roster completeness did not fire disk -> roster');

A.ok('C7 ghost roster row with no file goes red',
  auditRoster(files, rosterKeys.concat(['bwn-ghost.user.js'])).length === 1,
  'roster completeness did not fire roster -> disk');

A.ok('C8 a waiver only silences its own check',
  fired(auditScript(probe, probeSrc.replace('// @namespace    ' + CANON_NS, '// @namespace    evil.example'),
    { expectedInstalled: true, waived: { bodyver: 'unrelated waiver, long enough to pass the reason check' } }), 'NS'),
  'a bodyver waiver wrongly suppressed the NS guard');

// Prototype-pollution control: a `@__proto__` directive must never reach Object.prototype, and
// must not be silently swallowed either. The parser's key charset rejects it as a directive name
// (leading underscore), so it lands in `malformed` - visible, inert data - and the META guard fires.
var polluted = M.parseMeta(probeSrc.replace(M.BLOCK_END, '// @__proto__    {"polluted":true}\n' + M.BLOCK_END));
A.ok('C9 @__proto__ directive cannot reach Object.prototype and is not swallowed',
  polluted && !('polluted' in {}) && Object.keys(polluted.raw).indexOf('__proto__') === -1 &&
  polluted.malformed.length === 1 && polluted.malformed[0].indexOf('__proto__') !== -1,
  'a @__proto__ line either polluted the prototype or vanished without a trace');

A.ok('C10 a malformed directive line goes red',
  fired(auditScript(probe, probeSrc.replace(M.BLOCK_END, '// @__proto__    x\n' + M.BLOCK_END), probeRow), 'META'),
  'META guard did not fire on a rejected directive name');

A.finish();
