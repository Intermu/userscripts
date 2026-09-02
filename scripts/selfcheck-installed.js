// selfcheck-installed.js - US-0 installed half: what is actually in Tampermonkey vs what we shipped.
//
// WHY THIS EXISTS:
//   The suite auto-updates from GitHub Raw, but nothing ever verified the other end of that chain.
//   A real export taken off a work machine held "BWN Drop Upload" v1.3.0 with NO @updateURL and no
//   @downloadURL at all, while main shipped 1.22.0 - a source-less install frozen 19 minor versions
//   back, invisible to everyone. The same export named the scripts with an em-dash where the repo
//   now uses a hyphen; since Tampermonkey's identity key is (@namespace, @name), that rename minted
//   NEW scripts and left the old ones installed as shadow copies no @updateURL will ever reach.
//   This tool finds both classes, plus plain version/content drift and locally-modified copies.
//
// HOW TO USE (the one manual step, by design):
//   1. Tampermonkey Dashboard -> Utilities -> Export. Save the zip.
//   2. Unzip it (the OS already does this; this tool deliberately does not parse zips).
//   3. node scripts/selfcheck-installed.js <that-folder> [--json]
//
// WHAT IT IS NOT:
//   Diagnostic only. It never installs, updates, enables, disables, deletes or rewrites a script,
//   and it has no network primitive in it at all - no fetch, no XHR, no GM_xmlhttpRequest, no
//   http.request. It writes nothing anywhere. scripts/test-selfcheck-installed.js asserts all of
//   that statically, so the guarantee cannot rot.
//
// SECRETS:
//   A Tampermonkey export contains a THIRD file per script, `<Name>.storage.json`, holding that
//   script's GM storage VALUES - which in this suite means the shared SWA ingest key, the audit
//   key, the Google Places key, cached coordinator emails and card labels. This tool never opens
//   those files (DENY_SUFFIX below) and never reads GM storage in any form. On top of that, every
//   string that reaches either output mode goes through safe(): control characters and terminal
//   escapes stripped, length capped, and anything token-shaped replaced with [redacted] - so a
//   secret pasted by hand into a script body still cannot ride the report into a terminal, a
//   screenshot, or a JSON file. Content comparison is hash-only: no body bytes, no diff hunks.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/selfcheck-installed.js <dir>

var fs = require('fs');
var path = require('path');
var M = require('./userscript-meta.js');

var ROOT = path.join(__dirname, '..');
var MANIFEST_PATH = path.join(__dirname, 'userscript-manifest.json');
var SCRIPT_RE = /^bwn-.*\.user\.js$/;
var CANON_NS = 'broadwaynational.bwn';

// Bounds. An export is user-supplied input: a single pathological file must not be walked forever,
// and a directory of thousands of entries must not be enumerated into memory.
var MAX_FILE = 8 * 1024 * 1024;   // Core is ~1.1 MB; 8 MB is generous and still bounded.
var MAX_ENTRIES = 500;
var MAX_STR = 120;                // display cap per field

// Never opened. The GM storage sidecar is where the secrets live.
var DENY_SUFFIX = '.storage.json';

// ---- output safety -----------------------------------------------------------------------------

// Token-shaped strings, refused on the OUTPUT path (belt and suspenders: the input is whitelisted
// too, but a redaction miss must not become a rendered secret).
var TOKENISH = [
  /eyJ[A-Za-z0-9_-]{10,}/,            // JWT
  /sk-ant-[A-Za-z0-9_-]{8,}/,         // Anthropic
  /AIza[A-Za-z0-9_-]{20,}/,           // Google
  /\b[A-Fa-f0-9]{40,}\b/,             // long hex
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/      // long base64
];

// Every string that reaches stdout or the JSON goes through this: strip C0/C1 controls and ANSI
// escapes (a hostile script name must not be able to repaint the terminal or forge a verdict line),
// collapse whitespace, cap length, and redact anything token-shaped.
function safe(value) {
  if (value === null || value === undefined) return null;
  var s = String(value);
  // Map every C0/C1 control point (and DEL) to a space by code point, so no control character
  // regex literal is needed here: a hostile @name carrying ESC could otherwise repaint the
  // terminal or forge a verdict line in the rendered report.
  var out = [];
  for (var c = 0; c < s.length; c++) {
    var code = s.charCodeAt(c);
    out.push((code < 32 || (code >= 127 && code <= 159)) ? ' ' : s.charAt(c));
  }
  s = out.join('').replace(/  +/g, ' ').trim();
  for (var i = 0; i < TOKENISH.length; i++) if (TOKENISH[i].test(s)) return '[redacted]';
  if (s.length > MAX_STR) s = s.slice(0, MAX_STR - 3) + '...';
  return s;
}

// ---- repo side ---------------------------------------------------------------------------------

function loadRepo() {
  var manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  var byIdentity = Object.create(null);
  var byFile = Object.create(null);
  var files = fs.readdirSync(ROOT).filter(function (f) { return SCRIPT_RE.test(f); }).sort();

  for (var i = 0; i < files.length; i++) {
    var src = fs.readFileSync(path.join(ROOT, files[i]), 'utf8');
    var meta = M.parseMeta(src);
    var row = Object.prototype.hasOwnProperty.call(manifest.scripts, files[i]) ? manifest.scripts[files[i]] : null;
    var entry = {
      file: files[i],
      meta: meta,
      sha: M.sha256(src),
      expectedInstalled: !!(row && row.expectedInstalled)
    };
    byFile[files[i]] = entry;
    if (meta) byIdentity[M.identity(meta)] = entry;
  }
  return { manifest: manifest, files: files, byFile: byFile, byIdentity: byIdentity };
}

// ---- installed side ----------------------------------------------------------------------------

// Only these keys are ever read out of an options.json. Everything else in that file - including
// `settings` and anything a future Tampermonkey adds - is dropped before it can reach a verdict,
// a renderer or the JSON.
var OPTION_KEYS = ['enabled', 'check_for_updates', 'user_modified', 'uuid', 'position', 'modified'];

function readOptions(dir, base) {
  var file = path.join(dir, base + '.options.json');
  var out = Object.create(null);
  var stat;
  try { stat = fs.statSync(file); } catch (e) { return null; }
  if (!stat.isFile() || stat.size > MAX_FILE) return null;
  var parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { _unparseable: true }; }
  if (!parsed || typeof parsed !== 'object') return { _unparseable: true };
  for (var i = 0; i < OPTION_KEYS.length; i++) {
    var k = OPTION_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(parsed, k)) out[k] = parsed[k];
  }
  return out;
}

function loadInstalled(dir) {
  var names = fs.readdirSync(dir);
  var truncated = names.length > MAX_ENTRIES;
  if (truncated) names = names.slice(0, MAX_ENTRIES);

  var entries = [];
  var skipped = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    // The GM storage sidecar is denied before anything else can look at it.
    if (name.length >= DENY_SUFFIX.length && name.slice(-DENY_SUFFIX.length) === DENY_SUFFIX) continue;
    if (!/\.user\.js$/.test(name)) continue;

    var full = path.join(dir, name);
    var stat;
    try { stat = fs.statSync(full); } catch (e) { skipped.push({ name: name, why: 'unreadable' }); continue; }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE) { skipped.push({ name: name, why: 'over the ' + MAX_FILE + ' byte cap' }); continue; }

    var src = fs.readFileSync(full, 'utf8');
    var meta = M.parseMeta(src);
    if (!meta) { skipped.push({ name: name, why: 'no parseable ==UserScript== block' }); continue; }

    entries.push({
      name: name,
      meta: meta,
      sha: M.sha256(src),
      options: readOptions(dir, name.replace(/\.user\.js$/, ''))
    });
  }
  return { entries: entries, skipped: skipped, truncated: truncated };
}

// ---- matching and verdicts ---------------------------------------------------------------------

// Which repo file does this installed script claim to be? Identity (namespace + name) is what
// Tampermonkey itself keys on, so it wins. @downloadURL basename is the fallback that catches a
// renamed-but-still-governed copy, which is exactly the em-dash shadow case.
function matchRepo(repo, inst) {
  var id = M.identity(inst.meta);
  if (Object.prototype.hasOwnProperty.call(repo.byIdentity, id)) {
    return { entry: repo.byIdentity[id], how: 'identity' };
  }
  var url = inst.meta.downloadURL || inst.meta.updateURL;
  if (url) {
    var base = String(url).split('#')[0].split('?')[0].split('/').pop();
    if (Object.prototype.hasOwnProperty.call(repo.byFile, base)) {
      return { entry: repo.byFile[base], how: 'downloadURL' };
    }
  }
  return null;
}

function looksBwn(meta) {
  if (meta.namespace === CANON_NS) return true;
  if (/broadwaynational/i.test(String(meta.namespace || ''))) return true;
  if (/^BWN\b/.test(String(meta.name || ''))) return true;
  var url = String(meta.downloadURL || meta.updateURL || '');
  return url.indexOf('Intermu/userscripts') !== -1;
}

// One installed script -> verdict codes + the evidence each rests on. UNKNOWN is used wherever the
// export cannot support a call; a false "source-less" reads as a security incident, so absence of
// evidence never becomes evidence of absence.
function judgeInstalled(repo, inst, claimCounts) {
  var codes = [];
  var evidence = [];
  var match = matchRepo(repo, inst);

  if (!match) {
    codes.push(looksBwn(inst.meta) ? 'SOURCE_LESS' : 'EXTRA');
    evidence.push(looksBwn(inst.meta)
      ? 'claims to be a BWN script but matches no file in the repo, by identity or by downloadURL'
      : 'not a BWN script; listed for completeness only');
  }

  if (!inst.meta.updateURL && !inst.meta.downloadURL) {
    codes.push('UNGOVERNED');
    evidence.push('no @updateURL and no @downloadURL: this copy can never auto-update');
  } else if (match && inst.meta.downloadURL !== repo.manifest.expectedRawBase + match.entry.file) {
    codes.push('UPDATEURL_MISMATCH');
    evidence.push('@downloadURL is ' + safe(inst.meta.downloadURL) + ', shipped is ' +
      repo.manifest.expectedRawBase + match.entry.file);
  }

  var opts = inst.options;
  if (!opts) {
    evidence.push('no options.json beside this script: enabled / check_for_updates / user_modified are UNKNOWN');
    codes.push('UNKNOWN');
  } else if (opts._unparseable) {
    evidence.push('options.json did not parse: governance flags are UNKNOWN');
    codes.push('UNKNOWN');
  } else {
    if (opts.enabled === false) { codes.push('DISABLED'); evidence.push('Tampermonkey has this script disabled'); }
    if (opts.check_for_updates === false) {
      codes.push('UNGOVERNED');
      evidence.push('update checking is switched off for this script in Tampermonkey');
    }
    if (opts.user_modified === true) {
      codes.push('UNGOVERNED');
      evidence.push('locally edited in the Tampermonkey editor: auto-update will not cleanly replace it');
    }
  }

  if (match) {
    var repoMeta = match.entry.meta;
    if (repoMeta && repoMeta.version !== inst.meta.version) {
      codes.push('VERSION_MISMATCH');
      evidence.push('installed ' + safe(inst.meta.version) + ', shipped ' + safe(repoMeta.version));
    } else if (match.entry.sha !== inst.sha) {
      // Same version, different bytes: a hand-edited copy, or a stale fetch. Hash pair only, never
      // a diff hunk - the installed body may be hostile or may carry a pasted secret.
      codes.push('HASH_MISMATCH');
      evidence.push('same @version but different content: installed sha256 ' + inst.sha.slice(0, 12) +
        ', shipped ' + match.entry.sha.slice(0, 12));
    }

    if (repoMeta && repoMeta.match.join('|') !== inst.meta.match.join('|')) {
      codes.push('METADATA_MISMATCH');
      evidence.push('@match set differs from the shipped file');
    }

    if (match.how === 'downloadURL' && repoMeta && M.identity(repoMeta) !== M.identity(inst.meta)) {
      codes.push('METADATA_MISMATCH');
      evidence.push('matched only by @downloadURL: its (namespace, name) identity differs from the ' +
        'shipped file, so Tampermonkey treats it as a separate script');
    }

    if (claimCounts[match.entry.file] > 1) {
      codes.push('SHADOW_DUPLICATE');
      evidence.push(claimCounts[match.entry.file] + ' installed scripts claim to be ' + match.entry.file);
    }
  }

  if (!codes.length) codes.push('MATCH');

  return {
    installedName: safe(inst.name),
    name: safe(inst.meta.name),
    namespace: safe(inst.meta.namespace),
    installedVersion: safe(inst.meta.version),
    repoFile: match ? match.entry.file : null,
    repoVersion: match && match.entry.meta ? safe(match.entry.meta.version) : null,
    matchedBy: match ? match.how : null,
    verdicts: dedupe(codes),
    evidence: evidence.map(safe)
  };
}

function dedupe(list) {
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (Object.prototype.hasOwnProperty.call(seen, list[i])) continue;
    seen[list[i]] = true;
    out.push(list[i]);
  }
  return out;
}

// The whole comparison, as one pure function of (repo, installed) so tests can drive it directly.
function compare(repo, installed) {
  // Count how many installed scripts claim each repo file, so shadow duplicates are visible on
  // every copy rather than only on the second one.
  var claimCounts = Object.create(null);
  for (var i = 0; i < installed.entries.length; i++) {
    var m = matchRepo(repo, installed.entries[i]);
    if (!m) continue;
    claimCounts[m.entry.file] = (claimCounts[m.entry.file] || 0) + 1;
  }

  var rows = [];
  var claimed = Object.create(null);
  for (var j = 0; j < installed.entries.length; j++) {
    var row = judgeInstalled(repo, installed.entries[j], claimCounts);
    if (row.repoFile) claimed[row.repoFile] = true;
    rows.push(row);
  }

  // Repo side with nothing installed against it.
  for (var k = 0; k < repo.files.length; k++) {
    var file = repo.files[k];
    if (Object.prototype.hasOwnProperty.call(claimed, file)) continue;
    var entry = repo.byFile[file];
    rows.push({
      installedName: null,
      name: entry.meta ? safe(entry.meta.name) : null,
      namespace: entry.meta ? safe(entry.meta.namespace) : null,
      installedVersion: null,
      repoFile: file,
      repoVersion: entry.meta ? safe(entry.meta.version) : null,
      matchedBy: null,
      verdicts: [entry.expectedInstalled ? 'MISSING' : 'NOT_INSTALLED'],
      evidence: [entry.expectedInstalled
        ? 'expected to be installed per the roster, but no installed script claims it'
        : 'not expected to be installed; nothing found, which is fine']
    });
  }

  return {
    generated: new Date().toISOString(),
    note: 'Point-in-time self-report from a Tampermonkey export. Not audit evidence: the export is ' +
      'produced by the user and reflects one machine at one moment.',
    repoScripts: repo.files.length,
    installedScripts: installed.entries.length,
    truncated: !!installed.truncated,
    skipped: installed.skipped.map(function (s) { return { name: safe(s.name), why: safe(s.why) }; }),
    rows: rows
  };
}

// ---- rendering ---------------------------------------------------------------------------------

// Everything below MATCH / NOT_INSTALLED needs a human. Ordered worst first.
var SEVERITY = ['SOURCE_LESS', 'SHADOW_DUPLICATE', 'UNGOVERNED', 'UPDATEURL_MISMATCH',
  'HASH_MISMATCH', 'VERSION_MISMATCH', 'METADATA_MISMATCH', 'MISSING', 'DISABLED', 'EXTRA',
  'UNKNOWN', 'NOT_INSTALLED', 'MATCH'];

function rank(row) {
  var best = SEVERITY.length;
  for (var i = 0; i < row.verdicts.length; i++) {
    var at = SEVERITY.indexOf(row.verdicts[i]);
    if (at !== -1 && at < best) best = at;
  }
  return best;
}

// Fixed-width column. Truncates as well as pads: an installed @name is arbitrary user data and a
// long one would shear the table apart, which is how a real finding gets missed in a wide report.
function pad(s, n) {
  s = s === null || s === undefined ? '-' : String(s);
  if (s.length > n - 1) s = s.slice(0, n - 2) + '~';
  while (s.length < n) s += ' ';
  return s;
}

function render(report) {
  var lines = [];
  lines.push('BWN installed-vs-repository self-check  ' + report.generated);
  lines.push(report.repoScripts + ' scripts in the repo, ' + report.installedScripts + ' installed scripts read');
  lines.push('');

  var sorted = report.rows.slice().sort(function (a, b) {
    var d = rank(a) - rank(b);
    if (d) return d;
    return String(a.repoFile || a.name).localeCompare(String(b.repoFile || b.name));
  });

  var counts = Object.create(null);
  for (var c = 0; c < sorted.length; c++) {
    for (var v = 0; v < sorted[c].verdicts.length; v++) {
      var code = sorted[c].verdicts[v];
      counts[code] = (counts[code] || 0) + 1;
    }
  }

  lines.push(pad('SCRIPT', 34) + pad('INSTALLED', 11) + pad('SHIPPED', 11) + 'VERDICT');
  lines.push(new Array(90).join('-'));
  for (var i = 0; i < sorted.length; i++) {
    var r = sorted[i];
    lines.push(pad(r.repoFile || r.name, 34) + pad(r.installedVersion, 11) + pad(r.repoVersion, 11) +
      r.verdicts.join(' + '));
  }
  lines.push('');

  var flagged = sorted.filter(function (r) { return rank(r) < SEVERITY.indexOf('NOT_INSTALLED'); });

  // MISSING is collapsed to one line. A partial export (one script exported, or a coordinator who
  // only runs a few modules) produces a wall of MISSING rows that would bury the drift findings -
  // which are the reason to run this at all.
  var missing = flagged.filter(function (r) { return r.verdicts.length === 1 && r.verdicts[0] === 'MISSING'; });
  var detail = flagged.filter(function (r) { return missing.indexOf(r) === -1; });

  if (detail.length) {
    lines.push('Needs attention:');
    for (var f = 0; f < detail.length; f++) {
      lines.push('  ' + (detail[f].repoFile || detail[f].name) + '  [' + detail[f].verdicts.join(' + ') + ']');
      if (detail[f].installedName) lines.push('    installed as: ' + detail[f].installedName);
      for (var e = 0; e < detail[f].evidence.length; e++) lines.push('    - ' + detail[f].evidence[e]);
    }
    lines.push('');
  }
  if (missing.length) {
    lines.push('Expected but not present in this export (' + missing.length + '):');
    lines.push('  ' + missing.map(function (r) { return r.repoFile; }).join(', '));
    lines.push('  A partial export looks identical to a genuinely missing install: confirm the export');
    lines.push('  covered every script before treating these as absent.');
    lines.push('');
  }

  if (report.skipped.length) {
    lines.push('Skipped files:');
    for (var s = 0; s < report.skipped.length; s++) {
      lines.push('  ' + report.skipped[s].name + ' - ' + report.skipped[s].why);
    }
    lines.push('');
  }
  if (report.truncated) {
    lines.push('NOTE: the export directory held more than ' + MAX_ENTRIES + ' entries; the list was capped.');
    lines.push('');
  }

  var codes = Object.keys(counts).sort(function (a, b) { return SEVERITY.indexOf(a) - SEVERITY.indexOf(b); });
  lines.push('Totals: ' + codes.map(function (k) { return k + ' ' + counts[k]; }).join(', '));
  lines.push(report.note);
  return lines.join('\n');
}

// ---- cli ---------------------------------------------------------------------------------------

function main(argv) {
  var args = argv.filter(function (a) { return a !== '--json'; });
  var asJson = argv.indexOf('--json') !== -1;
  var dir = args[0];

  if (!dir) {
    console.error('usage: node scripts/selfcheck-installed.js <unzipped-tampermonkey-export-dir> [--json]');
    console.error('');
    console.error('Tampermonkey Dashboard -> Utilities -> Export, then unzip, then point here.');
    console.error('The <Name>.storage.json files in that export hold GM storage values (keys, emails);');
    console.error('this tool never opens them.');
    return 2;
  }
  var stat;
  try { stat = fs.statSync(dir); } catch (e) { console.error('cannot read ' + dir); return 2; }
  if (!stat.isDirectory()) {
    console.error(dir + ' is not a directory. Unzip the export first: this tool does not read zips.');
    return 2;
  }

  var report = compare(loadRepo(), loadInstalled(dir));
  console.log(asJson ? JSON.stringify(report, null, 2) : render(report));

  // Exit code is advisory for a human running this by hand: 1 when something needs attention.
  for (var i = 0; i < report.rows.length; i++) {
    if (rank(report.rows[i]) < SEVERITY.indexOf('NOT_INSTALLED')) return 1;
  }
  return 0;
}

module.exports = {
  loadRepo: loadRepo,
  loadInstalled: loadInstalled,
  compare: compare,
  render: render,
  safe: safe,
  matchRepo: matchRepo,
  main: main,
  MAX_FILE: MAX_FILE,
  MAX_ENTRIES: MAX_ENTRIES,
  DENY_SUFFIX: DENY_SUFFIX,
  OPTION_KEYS: OPTION_KEYS
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
