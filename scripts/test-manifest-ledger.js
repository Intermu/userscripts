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
//   GRANT     - every @grant names a real API, and `none` is never mixed with real grants. A
//               misspelled grant (`GM.getValuez`) is accepted by the manager and then resolves to
//               nothing, forever, silently - the same defect class as an orphaned field alias.
//   VMPORT    - every @grant is implemented by Violentmonkey too, so the suite stays runnable on a
//               second, non-proprietary manager. Waivable per script with a reason.
//   CONNECT   - @connect and GM_xmlhttpRequest imply each other, every declared host is a literal
//               (no `*` anywhere), and any host hard-coded in a `url:` is declared. Measured
//               2026-09-03: the suite reaches exactly two hosts and wildcards nothing, so this
//               pins a posture that is currently discipline only. Waivable with a reason.
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

// ---- the @grant vocabulary ---------------------------------------------------------------------
// Two managers, two vocabularies, and the union is the only safe validator. Sourced 2026-09-03:
//
//   VM_GRANTS      = Violentmonkey's GM_API_NAMES, src/common/consts.js (MIT, current shipping
//                    source). Machine-readable, so this half can be re-derived from a raw URL.
//   TM_ONLY_GRANTS = what tampermonkey.net/documentation.php lists and Violentmonkey does not
//                    implement. TM >= 3.0 is closed, so this half is transcribed from the docs
//                    page and is the half to re-check when TM ships new APIs.
//
// Checking against EITHER list alone reproduces the bug this rule exists to catch: VM's array
// misses 11 valid Tampermonkey names, so it would red-flag working scripts, and TM's list misses
// the bare `GM` object. See wiki/violentmonkey-assessment.md in the vault.
var VM_GRANTS = [
  'GM', 'GM_addElement', 'GM_addStyle', 'GM_addValueChangeListener', 'GM_cookie',
  'GM_deleteValue', 'GM_deleteValues', 'GM_download', 'GM_getResourceText', 'GM_getResourceURL',
  'GM_getValue', 'GM_getValues', 'GM_info', 'GM_listValues', 'GM_log', 'GM_notification',
  'GM_openInTab', 'GM_registerMenuCommand', 'GM_removeValueChangeListener', 'GM_setClipboard',
  'GM_setValue', 'GM_setValues', 'GM_unregisterMenuCommand', 'GM_xmlhttpRequest', 'unsafeWindow'
];
var TM_ONLY_GRANTS = [
  'GM_getTab', 'GM_saveTab', 'GM_getTabs', 'GM_webRequest',
  'GM_audio.setMute', 'GM_audio.getState',
  'GM_audio.addStateChangeListener', 'GM_audio.removeStateChangeListener',
  // TM grants the cookie API per-operation; Violentmonkey grants the bare `GM_cookie` object.
  'GM_cookie.list', 'GM_cookie.set', 'GM_cookie.delete',
  'window.onurlchange', 'window.close', 'window.focus'
];

function grantSet(list) {
  var s = Object.create(null);
  for (var i = 0; i < list.length; i++) s[list[i]] = true;
  return s;
}
var VM_OK = grantSet(VM_GRANTS);
var TM_OK = grantSet(VM_GRANTS.concat(TM_ONLY_GRANTS));

// Lowercased index of the union, used ONLY to resolve the GM4 promise-style spellings, which are
// not a straight case-preserving rewrite of the GM_ names: `GM.getResourceUrl` is `GM_getResourceURL`
// and `GM.xmlHttpRequest` is `GM_xmlhttpRequest`. Everything else stays case-sensitive, because
// `gm_setvalue` is not a real grant and must go red.
var UNION_LC = Object.create(null);
var UNION_ALL = VM_GRANTS.concat(TM_ONLY_GRANTS);
for (var u = 0; u < UNION_ALL.length; u++) UNION_LC[UNION_ALL[u].toLowerCase()] = UNION_ALL[u];

// ---- @connect ----------------------------------------------------------------------------------
// GM_xmlhttpRequest bypasses same-origin, so @connect is the only thing bounding where a script may
// send Umbrava data. Measured across origin/main on 2026-09-03: 10 scripts grant the API, the same
// 10 declare hosts, there is not one wildcard, and the whole suite reaches exactly two hosts (the
// SWA and places.googleapis.com). That is posture, not enforcement - nothing stopped a later
// `@connect *`. These rules make it enforcement.
//
// Tampermonkey also accepts the non-host keywords below. They are bounded (own origin / loopback),
// so they stay legal here; only `*` and wildcard patterns are refused. Listing them rather than
// refusing everything non-hostname avoids the subset-vocabulary trap the GRANT rule exists to catch.
var CONNECT_KEYWORDS = grantSet(['self', 'localhost']);

var XHR_GRANT_RE = /^(GM_xmlhttpRequest|GM\.xmlHttpRequest)$/;

// A host hard-coded straight into a request, e.g. `url: 'https://places.googleapis.com/v1/...'`.
// ponytail: literals only. A URL assembled from a constant (`SWA_BASE + '/api/x'`) is invisible
// here, which is most of the suite - widen to constant tracing only if a real miss shows up.
var LITERAL_URL_RE = /\burl\s*:\s*['"]https?:\/\/([A-Za-z0-9._-]+)/g;

function literalRequestHosts(src) {
  var hosts = Object.create(null);
  var m;
  LITERAL_URL_RE.lastIndex = 0;
  while ((m = LITERAL_URL_RE.exec(src))) hosts[m[1].toLowerCase()] = true;
  return Object.keys(hosts);
}

// -> 'none' | 'both' | 'tm-only' | 'unknown'
function classifyGrant(name) {
  if (name === 'none') return 'none';
  var key = name;
  if (name.indexOf('GM.') === 0) {
    key = UNION_LC[('GM_' + name.slice(3)).toLowerCase()];
    if (!key) return 'unknown';
  }
  if (VM_OK[key]) return 'both';
  if (TM_OK[key]) return 'tm-only';
  return 'unknown';
}

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

  var sawNone = false;
  var sawReal = false;
  for (var g = 0; g < meta.grant.length; g++) {
    var name = String(meta.grant[g]).trim();
    if (!name) continue;
    var kind = classifyGrant(name);
    if (kind === 'none') { sawNone = true; continue; }
    sawReal = true;
    if (kind === 'unknown') {
      if (!waived(row, 'grant')) {
        problems.push('GRANT: @grant ' + name + ' is not an API in either Tampermonkey or Violentmonkey');
      }
    } else if (kind === 'tm-only' && !waived(row, 'vmport')) {
      problems.push('VMPORT: @grant ' + name + ' is Tampermonkey-only, so this script cannot run under Violentmonkey');
    }
  }
  // `none` alongside a real grant is not additive: the manager honours `none` and the script gets
  // no GM APIs at all, with no error anywhere.
  if (sawNone && sawReal && !waived(row, 'grant')) {
    problems.push('GRANT: @grant none is mixed with real grants, which grants NOTHING');
  }

  if (!waived(row, 'connect')) {
    var grantsXhr = false;
    for (var x = 0; x < meta.grant.length; x++) {
      if (XHR_GRANT_RE.test(String(meta.grant[x]).trim())) { grantsXhr = true; break; }
    }
    var declared = Object.create(null);
    for (var c = 0; c < meta.connect.length; c++) {
      var host = String(meta.connect[c]).trim();
      if (!host) continue;
      declared[host.toLowerCase()] = true;
      // `*` is the whole point of the rule: it turns a bounded egress list back into "anywhere",
      // and `*.example.com` quietly widens to every subdomain someone can register.
      if (host.indexOf('*') !== -1) {
        problems.push('CONNECT: @connect ' + host + ' is a wildcard, which un-bounds egress');
      } else if (!CONNECT_KEYWORDS[host] && !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(host)) {
        problems.push('CONNECT: @connect ' + host + ' is not a literal hostname');
      }
    }
    var declaredCount = Object.keys(declared).length;

    // The two directions imply each other. XHR with no @connect prompts the user on first use and
    // is a deploy-time surprise; @connect with no XHR is a dead directive that usually means the
    // grant was dropped and the egress list was left behind.
    if (grantsXhr && !declaredCount) {
      problems.push('CONNECT: @grant GM_xmlhttpRequest with no @connect host declared');
    }
    if (!grantsXhr && declaredCount) {
      problems.push('CONNECT: @connect declared but GM_xmlhttpRequest is not granted');
    }

    var reached = literalRequestHosts(src);
    for (var h = 0; h < reached.length; h++) {
      if (!declared[reached[h]]) {
        problems.push('CONNECT: request to ' + reached[h] + ' is hard-coded but not in @connect');
      }
    }
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

// GRANT / VMPORT controls. The probe ships `@grant none`, so each mutation swaps that one line.
var GRANT_NONE = '// @grant        none';

A.ok('C11 a misspelled grant goes red',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE, '// @grant        GM.getValuez'), probeRow), 'GRANT'),
  'GRANT guard did not fire on a grant that names no real API');

A.ok('C12 a Tampermonkey-only grant goes red on portability',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE, '// @grant        GM_getTab'), probeRow), 'VMPORT'),
  'VMPORT guard did not fire on an API Violentmonkey does not implement');

A.ok('C13 `none` mixed with a real grant goes red',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE, GRANT_NONE + '\n// @grant        GM_setValue'), probeRow), 'GRANT'),
  'GRANT guard did not fire on `none` alongside a real grant');

A.ok('C14 a vmport waiver does not silence GRANT',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE, '// @grant        GM_nonesuch'),
    { expectedInstalled: true, waived: { vmport: 'unrelated waiver, long enough to pass the reason check' } }), 'GRANT'),
  'a vmport waiver wrongly suppressed the GRANT guard');

// Positive control: the GM4 promise-style spellings must NOT be flagged. These two are the only
// names whose GM. form is not a case-preserving rewrite of the GM_ form, so they are exactly where
// a naive validator would red-flag a working script.
A.eq('C15 GM4 spellings are accepted, not red-flagged',
  ['GM.getResourceUrl', 'GM.xmlHttpRequest', 'GM.setValue'].map(classifyGrant),
  ['both', 'both', 'both']);

// CONNECT controls. The probe ships `@grant none` and no @connect, so the mutations build the
// header state each case needs rather than editing an existing directive.
var XHR_HEADER = '// @grant        GM_xmlhttpRequest\n// @connect      green-stone-0717dab0f.7.azurestaticapps.net';

A.ok('C16 a wildcard @connect goes red',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE,
    '// @grant        GM_xmlhttpRequest\n// @connect      *'), probeRow), 'CONNECT'),
  'CONNECT guard did not fire on @connect *');

A.ok('C17 a subdomain-wildcard @connect goes red',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE,
    '// @grant        GM_xmlhttpRequest\n// @connect      *.azurestaticapps.net'), probeRow), 'CONNECT'),
  'CONNECT guard did not fire on a *.domain pattern');

A.ok('C18 GM_xmlhttpRequest with no @connect goes red',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE, '// @grant        GM_xmlhttpRequest'), probeRow), 'CONNECT'),
  'CONNECT guard did not fire on an XHR grant with no declared host');

A.ok('C19 @connect with no GM_xmlhttpRequest goes red',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE,
    GRANT_NONE + '\n// @connect      green-stone-0717dab0f.7.azurestaticapps.net'), probeRow), 'CONNECT'),
  'CONNECT guard did not fire on an orphaned @connect');

A.ok('C20 a hard-coded request host outside @connect goes red',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE, XHR_HEADER)
    .replace(M.BLOCK_END, M.BLOCK_END + "\n  var leak = { url: 'https://evil.example.com/collect' };"), probeRow), 'CONNECT'),
  'CONNECT guard did not fire on a request to an undeclared host');

A.ok('C21 a declared host is accepted, so C20 is not just "any url: literal goes red"',
  !fired(auditScript(probe, probeSrc.replace(GRANT_NONE, XHR_HEADER)
    .replace(M.BLOCK_END, M.BLOCK_END + "\n  var ok = { url: 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/x' };"), probeRow), 'CONNECT'),
  'CONNECT guard fired on a host that IS declared - the check is matching nothing');

// C20/C21 drive the literal-host check with a synthetic line. This one drives it with real shipped
// bytes: bwn-suite-ai hard-codes places.googleapis.com in a GM_xmlhttpRequest and declares it, so
// deleting the declaration must go red. Without this the check could be matching nothing on any
// file that actually ships.
var aiFile = 'bwn-suite-ai.user.js';
var aiSrc = sources[aiFile];
A.ok('C23 dropping a real declared host from @connect goes red on real shipped bytes',
  aiSrc && fired(auditScript(aiFile, aiSrc.replace(/^\/\/ @connect\s+places\.googleapis\.com$/m, '// @noframes'),
    manifest.scripts[aiFile]), 'CONNECT'),
  'CONNECT guard did not fire when a hard-coded host lost its declaration');

A.ok('C22 a connect waiver does not silence GRANT',
  fired(auditScript(probe, probeSrc.replace(GRANT_NONE, '// @grant        GM_nonesuch'),
    { expectedInstalled: true, waived: { connect: 'unrelated waiver, long enough to pass the reason check' } }), 'GRANT'),
  'a connect waiver wrongly suppressed the GRANT guard');

A.finish();
