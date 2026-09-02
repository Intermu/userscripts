// test-selfcheck-installed.js - US-0 installed half: drives the real self-check, not a copy of it.
//
// WHY THIS EXISTS:
//   selfcheck-installed.js reads a Tampermonkey export, which is USER-SUPPLIED input describing
//   possibly-hostile installed scripts. Three properties have to hold every build, and none of them
//   is visible by reading the happy path:
//     1. the GM storage sidecar (<Name>.storage.json - shared ingest key, audit key, Places key,
//        cached coordinator emails, card labels) is NEVER opened, and no value from it can appear in
//        either output mode;
//     2. a hostile @name cannot pollute Object.prototype, cannot vanish from the report, and cannot
//        repaint the terminal with escape sequences;
//     3. the tool has no way to change anything or to phone home - no write, no network primitive.
//   Plus the verdicts themselves: version drift, content drift, ungoverned copies, and the em-dash
//   shadow duplicates the real export on the work machine actually contains.
//
// HOW: the fixtures are synthesised into a temp directory at run time rather than committed.
//   Committed fixture .user.js files under scripts/ would be swept up by the repo's eslint glob
//   (scripts/**/*.js, --max-warnings 0), and a deliberately malformed fixture is exactly what that
//   gate is designed to reject. Temp fixtures also let the 8 MB cap be tested without committing
//   8 MB. The repo side of every comparison is the REAL shipped bytes via loadRepo().
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-selfcheck-installed.js

var fs = require('fs');
var os = require('os');
var path = require('path');
var A = require('./assert.js');
var S = require('./selfcheck-installed.js');
var M = require('./userscript-meta.js');

var ROOT = path.join(__dirname, '..');
var ESC = String.fromCharCode(27);
var SECRET = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.THIS-IS-A-FAKE-TEST-TOKEN-NOT-A-REAL-KEY';

// The real shipped bytes of a small, stable script, used as the base for the installed fixtures.
var PROBE = 'bwn-kanban.user.js';
var probeSrc = fs.readFileSync(path.join(ROOT, PROBE), 'utf8').replace(/\r\n/g, '\n');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwn-us0-'));
process.on('exit', function () {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

function write(name, text) { fs.writeFileSync(path.join(tmp, name), text); }
function opts(name, obj) { fs.writeFileSync(path.join(tmp, name + '.options.json'), JSON.stringify(obj)); }

function header(fields) {
  var lines = [M.BLOCK_START];
  for (var i = 0; i < fields.length; i++) lines.push('// @' + fields[i]);
  lines.push(M.BLOCK_END);
  return lines.join('\n') + '\n(function(){ "use strict"; })();\n';
}

var RAW = 'https://raw.githubusercontent.com/Intermu/userscripts/main/';

// ---- fixtures ----------------------------------------------------------------------------------

// 1. A clean, current install of the probe: byte-identical to the shipped file.
write('BWN Kanban (Broadway National).user.js', probeSrc);
opts('BWN Kanban (Broadway National)', { enabled: true, check_for_updates: true, user_modified: false, uuid: 'u-1' });

// 2. The em-dash shadow copy: an older @name, so a DIFFERENT Tampermonkey identity, still pointing
//    at the same repo file through @downloadURL. This is the real-world case from the work machine.
write('BWN Kanban ' + String.fromCharCode(0x2014) + ' old (Broadway National).user.js',
  probeSrc.replace(/^\/\/ @name(\s+).*$/m, '// @name$1BWN Kanban ' + String.fromCharCode(0x2014) + ' old (Broadway National)')
    .replace(/^\/\/ @version(\s+)\S+$/m, '// @version$10.0.9'));
opts('BWN Kanban ' + String.fromCharCode(0x2014) + ' old (Broadway National)',
  { enabled: true, check_for_updates: false, user_modified: true, uuid: 'u-2' });

// 3. Ungoverned: a BWN script with no @updateURL and no @downloadURL at all, frozen far back. This
//    is the shape of the real Drop Upload v1.3.0 found in the export on disk.
write('BWN Drop Upload (Broadway National).user.js', header([
  'name         BWN Drop Upload (Broadway National)',
  'namespace    broadwaynational.bwn',
  'version      1.3.0',
  'match        https://app.umbrava.com/*',
  'grant        none'
]));
opts('BWN Drop Upload (Broadway National)', { enabled: true, check_for_updates: true, user_modified: false });

// 4. Source-less: claims to be BWN, matches no repo file by identity or by URL.
write('BWN Mystery Helper.user.js', header([
  'name         BWN Mystery Helper',
  'namespace    broadwaynational.bwn',
  'version      9.9.9',
  'match        https://app.umbrava.com/*'
]));

// 5. Third-party: not ours, listed for completeness, never an alarm.
write('Some Third Party Thing.user.js', header([
  'name         Some Third Party Thing',
  'namespace    example.org',
  'version      2.0.0',
  'match        https://example.org/*'
]));

// 6. Hostile names: prototype-pollution attempt, markup, and a terminal escape sequence. Each is a
//    script that claims to be BWN so it lands in the report rather than being filtered out.
write('proto.user.js', header([
  'name         __proto__',
  'namespace    broadwaynational.bwn',
  'version      1.0.0'
]));
write('markup.user.js', header([
  'name         BWN <img onerror=alert(1) src=x>',
  'namespace    broadwaynational.bwn',
  'version      1.0.0'
]));
write('ansi.user.js', header([
  'name         BWN ' + ESC + '[31mFAKE VERDICT: MATCH' + ESC + '[0m',
  'namespace    broadwaynational.bwn',
  'version      1.0.0'
]));

// 7. A token-shaped value in a metadata field: must be redacted on the output path.
write('tokenish.user.js', header([
  'name         BWN ' + SECRET,
  'namespace    broadwaynational.bwn',
  'version      1.0.0'
]));

// 8. The GM storage sidecar, carrying a fake secret. Must never be opened, never rendered.
write('BWN Kanban (Broadway National).storage.json', JSON.stringify({ ingest_key: SECRET, places_key: SECRET }));

// 9. Over the byte cap: must be skipped with a reason, not read into memory as a script.
write('BWN Huge (Broadway National).user.js', header([
  'name         BWN Huge (Broadway National)',
  'namespace    broadwaynational.bwn',
  'version      1.0.0'
]) + new Array(S.MAX_FILE + 64).join('x'));

// 10. Not a userscript at all: ignored silently.
write('readme.txt', 'not a script');

// ---- run the real comparison -------------------------------------------------------------------

var repo = S.loadRepo();
var installed = S.loadInstalled(tmp);
var report = S.compare(repo, installed);
var text = S.render(report);
var json = JSON.stringify(report);

function row(pred) {
  for (var i = 0; i < report.rows.length; i++) if (pred(report.rows[i])) return report.rows[i];
  return null;
}
function byInstalled(fragment) {
  return row(function (r) { return r.installedName && r.installedName.indexOf(fragment) !== -1; });
}
function has(r, code) { return !!r && r.verdicts.indexOf(code) !== -1; }

console.log('US-0 self-check: ' + repo.files.length + ' repo scripts, ' +
  installed.entries.length + ' installed fixtures read, ' + report.rows.length + ' rows');

// ---- secrets ------------------------------------------------------------------------------------

A.ok('the GM storage sidecar is never treated as a script',
  !byInstalled('storage.json'), 'a *.storage.json file reached the report as an installed script');

A.ok('no storage-file secret appears in the human report', text.indexOf(SECRET) === -1, 'secret leaked into stdout');
A.ok('no storage-file secret appears in the JSON report', json.indexOf(SECRET) === -1, 'secret leaked into JSON');

A.ok('a token-shaped metadata value is redacted',
  byInstalled('tokenish') && byInstalled('tokenish').name === '[redacted]',
  'expected [redacted], got ' + (byInstalled('tokenish') || {}).name);

A.ok('the deny suffix is exactly the GM storage sidecar', S.DENY_SUFFIX === '.storage.json', S.DENY_SUFFIX);

A.eq('only whitelisted option keys are ever read', S.OPTION_KEYS,
  ['enabled', 'check_for_updates', 'user_modified', 'uuid', 'position', 'modified']);

// ---- hostile input -----------------------------------------------------------------------------

A.ok('a script named __proto__ does not pollute Object.prototype', !({}).polluted && !('__proto__x' in {}),
  'prototype was touched');
A.ok('a script named __proto__ still appears in the report',
  !!row(function (r) { return r.name === '__proto__'; }), 'the __proto__ row vanished');

A.ok('terminal escapes are stripped from rendered names',
  text.indexOf(ESC) === -1 && json.indexOf(ESC) === -1, 'an ESC byte survived into the output');

A.ok('markup in a name is carried as inert text, not interpreted',
  byInstalled('markup') && byInstalled('markup').name.indexOf('img onerror') !== -1,
  'the markup name was dropped or mangled beyond recognition');

A.ok('an oversized file is skipped with a reason, not parsed',
  report.skipped.some(function (s) { return s.name.indexOf('Huge') !== -1 && s.why.indexOf('cap') !== -1; }),
  'the over-cap file was not reported as skipped');
A.ok('an oversized file never becomes a row',
  !byInstalled('Huge'), 'the over-cap file reached the report as an installed script');

A.ok('a non-userscript file is ignored', !byInstalled('readme.txt'), 'readme.txt reached the report');

// ---- verdicts ----------------------------------------------------------------------------------

// A byte-identical current install, alone in its export, is a plain MATCH.
var solo = S.compare(repo, {
  entries: [{
    name: 'solo.user.js', meta: M.parseMeta(probeSrc), sha: repo.byFile[PROBE].sha,
    options: { enabled: true, check_for_updates: true, user_modified: false }
  }],
  skipped: [], truncated: false
});
var soloRow = solo.rows.filter(function (r) { return r.installedName === 'solo.user.js'; })[0];
A.eq('a byte-identical current install is MATCH', soloRow ? soloRow.verdicts : null, ['MATCH']);
A.ok('a MATCH row is matched by identity, not by URL fallback', soloRow && soloRow.matchedBy === 'identity',
  'matchedBy was ' + (soloRow || {}).matchedBy);

// In the full fixture set the same clean copy sits beside its em-dash shadow, so BOTH copies carry
// SHADOW_DUPLICATE: a duplicate is a property of the pair, and hiding it on the good copy would let
// the shadow look like an isolated oddity rather than a split install.
var clean = row(function (r) { return r.installedName === 'BWN Kanban (Broadway National).user.js'; });
A.eq('the clean copy is flagged too when a shadow exists beside it',
  clean ? clean.verdicts : null, ['SHADOW_DUPLICATE']);

var shadow = byInstalled(String.fromCharCode(0x2014));
A.ok('the em-dash copy is flagged SHADOW_DUPLICATE', has(shadow, 'SHADOW_DUPLICATE'),
  'verdicts were ' + JSON.stringify((shadow || {}).verdicts));
A.ok('the em-dash copy is flagged VERSION_MISMATCH', has(shadow, 'VERSION_MISMATCH'), 'version drift missed');
A.ok('the em-dash copy is flagged METADATA_MISMATCH (separate Tampermonkey identity)',
  has(shadow, 'METADATA_MISMATCH'), 'identity divergence missed');
A.ok('update checking switched off is UNGOVERNED', has(shadow, 'UNGOVERNED'), 'check_for_updates:false missed');
A.ok('both copies claiming one repo file produce two rows, not a silent overwrite',
  report.rows.filter(function (r) { return r.repoFile === PROBE; }).length === 2,
  'expected exactly two rows claiming ' + PROBE);

var drop = byInstalled('Drop Upload');
A.ok('a copy with no @updateURL / @downloadURL is UNGOVERNED', has(drop, 'UNGOVERNED'),
  'verdicts were ' + JSON.stringify((drop || {}).verdicts));
A.ok('that copy is also VERSION_MISMATCH against the shipped file', has(drop, 'VERSION_MISMATCH'),
  'the 1.3.0-vs-shipped drift was missed');

A.ok('a BWN script with no repo counterpart is SOURCE_LESS', has(byInstalled('Mystery'), 'SOURCE_LESS'),
  'verdicts were ' + JSON.stringify((byInstalled('Mystery') || {}).verdicts));

A.ok('a third-party script is EXTRA, never SOURCE_LESS',
  has(byInstalled('Third Party'), 'EXTRA') && !has(byInstalled('Third Party'), 'SOURCE_LESS'),
  'verdicts were ' + JSON.stringify((byInstalled('Third Party') || {}).verdicts));

A.ok('a missing options.json yields UNKNOWN, never a governance verdict',
  has(byInstalled('Mystery'), 'UNKNOWN'), 'absent options did not degrade to UNKNOWN');

var expectedButAbsent = row(function (r) { return r.repoFile === 'bwn-bid-out.user.js'; });
A.ok('a roster script with nothing installed is MISSING', has(expectedButAbsent, 'MISSING'),
  'verdicts were ' + JSON.stringify((expectedButAbsent || {}).verdicts));

// Content drift at the same version: a hand-edited copy. Hash pair only, never a body byte.
var edited = S.compare(repo, {
  entries: [{
    name: 'edited.user.js',
    meta: M.parseMeta(probeSrc),
    sha: 'deadbeef'.repeat(8),
    options: { enabled: true, check_for_updates: true, user_modified: false }
  }],
  skipped: [], truncated: false
});
var editedRow = edited.rows.filter(function (r) { return r.installedName === 'edited.user.js'; })[0];
A.ok('same @version with different bytes is HASH_MISMATCH', has(editedRow, 'HASH_MISMATCH'),
  'verdicts were ' + JSON.stringify((editedRow || {}).verdicts));
A.ok('a HASH_MISMATCH reports hashes only, never source', S.render(edited).indexOf('function') === -1,
  'rendered output contains script source');

// A locally edited copy in Tampermonkey never auto-updates cleanly, so it is UNGOVERNED even when
// its version and bytes happen to line up.
var modified = S.compare(repo, {
  entries: [{
    name: 'usermod.user.js', meta: M.parseMeta(probeSrc), sha: S.loadRepo().byFile[PROBE].sha,
    options: { enabled: false, check_for_updates: true, user_modified: true }
  }],
  skipped: [], truncated: false
});
var modRow = modified.rows.filter(function (r) { return r.installedName === 'usermod.user.js'; })[0];
A.ok('user_modified is UNGOVERNED', has(modRow, 'UNGOVERNED'), JSON.stringify((modRow || {}).verdicts));
A.ok('enabled:false is DISABLED', has(modRow, 'DISABLED'), JSON.stringify((modRow || {}).verdicts));

// A governed copy pointing at the wrong raw host.
var foreign = S.compare(repo, {
  entries: [{
    name: 'foreign.user.js',
    meta: M.parseMeta(probeSrc.replace(new RegExp(RAW + PROBE, 'g'),
      'https://raw.githubusercontent.com/someone-else/userscripts/main/' + PROBE)),
    sha: S.loadRepo().byFile[PROBE].sha,
    options: { enabled: true, check_for_updates: true, user_modified: false }
  }],
  skipped: [], truncated: false
});
var foreignRow = foreign.rows.filter(function (r) { return r.installedName === 'foreign.user.js'; })[0];
A.ok('a foreign @downloadURL host is UPDATEURL_MISMATCH', has(foreignRow, 'UPDATEURL_MISMATCH'),
  JSON.stringify((foreignRow || {}).verdicts));

// ---- the read-only / no-egress guarantee, asserted statically ----------------------------------
// The tool's whole justification is that it cannot change or transmit anything. Reading the source
// is the only way to keep that true as the file grows.

var toolSrc = fs.readFileSync(path.join(__dirname, 'selfcheck-installed.js'), 'utf8');
var metaSrc = fs.readFileSync(path.join(__dirname, 'userscript-meta.js'), 'utf8');

// Comment lines are stripped before the scan: both files DOCUMENT the primitives they refuse to
// use, and a scan that cannot tell prose from code would either fail on the documentation or force
// the documentation to go vague. Code lines only, so the guarantee is about what executes.
function codeOnly(src) {
  return src.split('\n').filter(function (line) {
    var t = line.replace(/^\s+/, '');
    return t.indexOf('//') !== 0 && t.indexOf('*') !== 0 && t.indexOf('/*') !== 0;
  }).join('\n');
}
var both = codeOnly(toolSrc) + '\n' + codeOnly(metaSrc);

var EGRESS = ['fetch(', 'XMLHttpRequest', 'GM_xmlhttpRequest', 'http.request', 'https.request',
  'net.connect', 'child_process', 'require(\'https\')', 'require("https")'];
for (var e = 0; e < EGRESS.length; e++) {
  A.ok('no egress primitive: ' + EGRESS[e], both.indexOf(EGRESS[e]) === -1,
    EGRESS[e] + ' appears in the diagnostic source');
}

var MUTATORS = ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'renameSync',
  'createWriteStream', 'GM_setValue', 'localStorage', 'bwn:audit', 'bwnAuditRecord', 'corrId'];
for (var m = 0; m < MUTATORS.length; m++) {
  A.ok('no mutation or audit path: ' + MUTATORS[m], both.indexOf(MUTATORS[m]) === -1,
    MUTATORS[m] + ' appears in the diagnostic source');
}

A.ok('the storage sidecar is never read by name',
  toolSrc.indexOf('storage.json\'') === -1 || toolSrc.indexOf('readFileSync(path.join(dir, base + \'.storage') === -1,
  'the tool builds a path to a storage.json file');

A.ok('house style: no em-dash in the diagnostic sources',
  both.indexOf(String.fromCharCode(0x2014)) === -1, 'U+2014 found');

// ---- negative controls -------------------------------------------------------------------------
// Each proves a guard above is load-bearing rather than vacuously green.

A.ok('N1 safe() actually redacts (not just absent input)', S.safe('bearer ' + SECRET) === '[redacted]',
  'safe() returned ' + S.safe('bearer ' + SECRET));
A.ok('N2 safe() actually strips ESC', S.safe('a' + ESC + '[31mb').indexOf(ESC) === -1, 'ESC survived safe()');
A.ok('N3 safe() caps length', S.safe(new Array(500).join('z')).length <= 120, 'length cap not applied');
A.ok('N4 the matcher really can fail', S.matchRepo(repo, { meta: M.parseMeta(header([
  'name         Nothing Like Ours', 'namespace    nope.example', 'version      1.0.0'
])) }) === null, 'matchRepo returned a match for an unrelated script');
A.ok('N5 the matcher really can match by URL alone', (function () {
  var m = S.matchRepo(repo, { meta: M.parseMeta(header([
    'name         Renamed', 'namespace    nope.example', 'version      1.0.0',
    'downloadURL  ' + RAW + PROBE
  ])) });
  return m && m.entry.file === PROBE && m.how === 'downloadURL';
})(), 'the @downloadURL fallback did not fire');

// N6: the identity key must not be forgeable. If (namespace, name) were joined with a separator,
// a side-load could split the same joined string differently - namespace "<ns> <name>" with an
// empty name - and be matched to a real repo file, so a SOURCE_LESS script would report as a
// version mismatch on a script it is not. Two different pairs must never key the same.
var realNs = 'broadwaynational.bwn';
var realName = 'BWN Kanban (Broadway National)';
A.ok('N6 the (namespace, name) identity key cannot be forged by shifting the separator',
  M.identity({ namespace: realNs, name: realName }) !==
  M.identity({ namespace: realNs + ' ' + realName, name: '' }),
  'two distinct (namespace, name) pairs produced the same identity key');

A.ok('N7 a forged-separator script is SOURCE_LESS, not matched to the real file', (function () {
  var forged = S.compare(repo, {
    entries: [{
      name: 'forged.user.js',
      meta: M.parseMeta(header([
        'name         ',
        'namespace    ' + realNs + ' ' + realName,
        'version      9.9.9'
      ])),
      sha: 'ff'.repeat(32),
      options: { enabled: true, check_for_updates: true, user_modified: false }
    }],
    skipped: [], truncated: false
  });
  var r = forged.rows.filter(function (x) { return x.installedName === 'forged.user.js'; })[0];
  return has(r, 'SOURCE_LESS') && r.repoFile === null;
})(), 'a forged identity was matched to a real repo file');

A.finish();
