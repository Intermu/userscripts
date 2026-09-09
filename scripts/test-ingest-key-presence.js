// test-ingest-key-presence.js - the SWA ingest key is PER SCRIPT, and the suite must say so.
//
// WHY THIS EXISTS
// Tampermonkey scopes GM_setValue/GM_getValue per SCRIPT, not per @namespace. Measured live on
// TM 5.x, 2026-09-03: three probe scripts on one page load, and the two readers saw <ABSENT> for
// the writer's value - including the one carrying a byte-identical @namespace. So `ingest_key` is
// not one shared value, it is 10 private copies, and the suite's own code asserted the opposite
// ("shared by 9" at bwn-suite-ai.user.js:53) for months.
//
// The defect that belief causes is silent and DEFERRED, which is why it needs a build gate rather
// than a code review: every script Mike already uses has the key, so everything works. A NEWLY
// shipped script starts blank, its connector calls quietly do nothing, and nothing anywhere says
// why. There is no error, no console line, and no failing request to notice.
//
// Rather than move the credential somewhere shared - localStorage and the bwn:evt bus both cross
// scripts, and both are readable by Umbrava's own page JS, which is exactly why the key lives in
// GM storage - the suite keeps N copies and makes the blanks LOUD: each script publishes a
// BOOLEAN beacon and Core's Ops panel names the scripts still blank. This file pins that contract.
//
//   BEACON     - every script reading ingest_key publishes bwn:ingest:<slug> and calls the
//                publisher at load. A script with no beacon is invisible to the panel, which puts
//                us back at the silent failure this whole mechanism exists to end.
//   BEACONSAFE - the beacon carries a 0/1, never the key. It lands in localStorage, which page JS
//                can read; a beacon that leaked the value would be strictly worse than no beacon.
//   BEACONTS   - ts is a load-time CONST, not an inline Date.now(). Core's "loaded this session"
//                handshake compares ts to Core's own load stamp within 60s, so a save-time
//                Date.now() makes the script read as stale the moment the key is set. bwn-suite-ai
//                shipped exactly that bug in its own status stamp; the fix is documented there.
//   SAVEBEACON - every GM_setValue('ingest_key') is followed by a republish, or the panel keeps
//                showing BLANK after the user has just set the key.
//   PROMPT     - every setter prompt says PER SCRIPT. This is the load-bearing half: the menu
//                commands are not redundant, and copy that calls the key suite-wide is what
//                taught everyone otherwise.
//   COPY       - the retired false claims never come back, in prose or in a comment.
//   ROLLUP     - Core's panel row, driven as SHIPPED BYTES against a fake localStorage: it names
//                the blanks, skips beacons from scripts that did not load this session, and
//                degrades to a neutral row when nothing reported.
//
// Every check is a pure function over the shipped bytes so the negative controls at the bottom can
// drive it with mutated input and prove the guard actually fires ([[green-harness-proves-nothing-alone]]).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ingest-key-presence.js
// No network, no writes.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');

// Normalize CRLF on read: the working tree is CRLF and the index is LF, so a raw-byte regex
// would pass on one machine and fail on the other ([[byte-compare-fails-on-eol]]).
function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

function slugOf(file) {
  return file.replace(/^bwn-/, '').replace(/\.user\.js$/, '');
}

// A script is IN SCOPE when it reads the key. Derived from the bytes, never hand-listed: a new
// script that starts using ingest_key is picked up by this harness on its first commit.
function usesIngestKey(src) {
  return /GM_getValue\((['"])ingest_key\1/.test(src);
}

// ---- the checks, as pure functions over (file, src) ---------------------------------------------

var BANNED = [
  [/used across the BWN Ops Suite/i, 'claims the key is used across the suite'],
  [/shared across the BWN Ops Suite/i, 'claims the key is shared across the suite'],
  [/shared by \d+\s*\n?\s*\/\/\s*scripts|shared by \d+ scripts/i, 'claims the key is shared by N scripts'],
  [/same key the rest of the BWN suite uses/i, 'claims the key is the same one siblings use'],
  [/Shared SWA ingest key/i, 'calls the key shared in the prompt title'],
  [/the shared ingest key/i, 'calls the key shared']
];

function auditScript(file, src) {
  var problems = [];
  if (!usesIngestKey(src)) return problems;
  var slug = slugOf(file);

  // BEACON - the publisher exists, writes this script's own slug, and runs at load.
  var beaconRe = new RegExp('localStorage\\.setItem\\((["\'])bwn:ingest:' + slug + '\\1');
  if (!beaconRe.test(src)) problems.push('BEACON: no localStorage write to bwn:ingest:' + slug);
  if (!/function publishIngestPresence\(\)/.test(src)) problems.push('BEACON: no publishIngestPresence() definition');
  // The bare call at load, not only the one inside the setter. Anchored to a line start so a
  // call nested inside another function body does not satisfy it.
  if (!/\n\s*publishIngestPresence\(\);/.test(src)) problems.push('BEACON: publishIngestPresence() is never called at load');

  // Find the beacon's setItem payload and check its SHAPE, not just its presence.
  var payload = src.match(new RegExp('localStorage\\.setItem\\((["\'])bwn:ingest:' + slug + '\\1,\\s*([^\\n]*)'));
  if (payload) {
    var body = payload[2];
    // BEACONSAFE - a 0/1, never the key itself. localStorage is page-readable.
    if (!/\?\s*1\s*:\s*0/.test(body)) {
      problems.push('BEACONSAFE: the beacon payload is not coerced to 0/1 - it may carry the key: ' + body.trim());
    }
    // BEACONTS - a load-time const, never an inline Date.now().
    if (/ts:\s*Date\.now\(\)/.test(body)) {
      problems.push('BEACONTS: ts is an inline Date.now(); Core reads the script as stale once the key is set mid-session');
    }
    if (!/ts:\s*[A-Z][A-Z0-9_]*\s*[},]/.test(body)) {
      problems.push('BEACONTS: ts is not a load-time const: ' + body.trim());
    }
  }

  // SAVEBEACON - every write of the key republishes the beacon.
  var saveRe = /GM_setValue\((['"])ingest_key\1/g, m;
  while ((m = saveRe.exec(src)) !== null) {
    var after = src.slice(m.index, m.index + 260);
    if (!/publishIngestPresence\(\)/.test(after)) {
      problems.push('SAVEBEACON: a GM_setValue(ingest_key) at offset ' + m.index + ' does not republish the beacon');
    }
  }

  // PROMPT - every prompt that offers to set the key says PER SCRIPT.
  var promptRe = /prompt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g, p;
  while ((p = promptRe.exec(src)) !== null) {
    var text = p[2];
    if (!/ingest key|WO_INGEST_KEY/i.test(text)) continue;
    if (text.indexOf('PER SCRIPT') === -1) {
      problems.push('PROMPT: an ingest-key prompt does not say PER SCRIPT: ' + text.slice(0, 70));
    }
  }

  // COPY - the retired claims stay retired.
  for (var i = 0; i < BANNED.length; i++) {
    if (BANNED[i][0].test(src)) problems.push('COPY: ' + BANNED[i][1]);
  }

  return problems;
}

// ---- Core's roll-up, executed as SHIPPED BYTES ---------------------------------------------------
// Slicing the real function rather than restating its logic: a harness that reimplements the thing
// it tests passes while the shipped code is dead ([[harness-stub-hides-dead-feature]]).

var OPEN = '(function ingestKeyRollup() {';
var CLOSE = '\n      })();';

function extractRollup(coreSrc) {
  var a = coreSrc.indexOf(OPEN);
  if (a === -1) return null;
  var b = coreSrc.indexOf(CLOSE, a);
  if (b === -1) return null;
  return coreSrc.slice(a, b + CLOSE.length);
}

// Drive the sliced source with a fake localStorage + the two Core helpers it closes over,
// and capture the row it renders.
function runRollup(rollupSrc, store, coreTs) {
  var rows = [];
  var keys = Object.keys(store);
  var localStorage = {
    length: keys.length,
    key: function (i) { return keys[i]; },
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }
  };
  function lsGet(k, dflt) {
    try { var raw = localStorage.getItem(k); return raw == null ? dflt : JSON.parse(raw); }
    catch (e) { return dflt; }
  }
  function kv(k, v, cls) { rows.push({ k: k, v: v, cls: cls }); }
  var status = { core: { ts: coreTs } };
  // new Function, not eval: it runs the sliced bytes with ONLY these four names in scope, so the
  // block cannot accidentally satisfy itself from the harness's own variables. (No eslint-disable
  // here - no-new-func is not in eslint.config.mjs, and a dead directive fails --max-warnings 0.)
  var run = new Function('localStorage', 'lsGet', 'kv', 'status', rollupSrc);
  run(localStorage, lsGet, kv, status);
  return rows;
}

function beacon(k, ts) { return JSON.stringify({ k: k, ts: ts }); }

// ---- run -----------------------------------------------------------------------------------------

console.log('SWA ingest key presence contract\n');

var files = fs.readdirSync(ROOT).filter(function (f) { return /^bwn-.*\.user\.js$/.test(f); }).sort();
var inScope = files.filter(function (f) { return usesIngestKey(read(f)); });

A.ok('the harness found the in-scope scripts', inScope.length >= 10,
  'found ' + inScope.length + ': ' + inScope.join(', '));

// Slugs must be unique, or two scripts collide on one beacon key and one of them vanishes
// from the panel while looking healthy.
var seen = {}, dupe = null;
inScope.forEach(function (f) { var s = slugOf(f); if (seen[s]) dupe = s; seen[s] = 1; });
A.ok('every in-scope script has a unique beacon slug', !dupe, 'duplicate slug ' + dupe);

inScope.forEach(function (f) {
  var problems = auditScript(f, read(f));
  A.ok(f + ' publishes a safe, load-stamped presence beacon and says PER SCRIPT',
    problems.length === 0, problems.join(' | '));
});

// Core is not in scope for the beacon (it is @grant none and holds no key) but it owns the row.
var coreSrc = read('bwn-suite-core.user.js');
A.ok('Core no longer reports status.ai.ingest as "the" suite ingest key',
  !/kv\('SWA ingest key', status\.ai\.ingest/.test(coreSrc));

var rollup = extractRollup(coreSrc);
A.ok('Core carries an extractable ingestKeyRollup block', !!rollup);

if (rollup) {
  var NOW = 1756900000000;

  // All set, all fresh.
  var rows = runRollup(rollup, {
    'bwn:ingest:dispatch': beacon(1, NOW),
    'bwn:ingest:wo-audit': beacon(1, NOW - 3000),
    'bwn:other:noise': JSON.stringify({ nope: true })
  }, NOW);
  A.eq('all keys set - one ok row', rows.length, 1);
  A.ok('all keys set - reads as ok', rows[0].cls === 'ok' && /set in all 2/.test(rows[0].v), JSON.stringify(rows[0]));

  // One blank: the row must NAME it. This is the whole point of the feature.
  rows = runRollup(rollup, {
    'bwn:ingest:dispatch': beacon(1, NOW),
    'bwn:ingest:inventory': beacon(0, NOW),
    'bwn:ingest:wo-audit': beacon(0, NOW)
  }, NOW);
  A.ok('a blank key is named, not just counted',
    rows[0].cls === 'no' && /1 of 3 set/.test(rows[0].v) && /BLANK: inventory, wo-audit/.test(rows[0].v),
    JSON.stringify(rows[0]));

  // Stale beacon = a script that did not load this session. It must NOT raise a permanent red
  // row - the exact bug Core's AI/Ask freshness rows already guard against.
  rows = runRollup(rollup, {
    'bwn:ingest:dispatch': beacon(1, NOW),
    'bwn:ingest:retired-script': beacon(0, NOW - 600000)
  }, NOW);
  A.ok('a stale beacon from an uninstalled script is skipped',
    rows[0].cls === 'ok' && !/retired-script/.test(rows[0].v), JSON.stringify(rows[0]));

  // Nothing reported: a neutral row, not a false all-clear and not a false alarm.
  rows = runRollup(rollup, {}, NOW);
  A.ok('no beacons reads as "no script reported", not as ok',
    rows[0].cls !== 'ok' && /no script reported/.test(rows[0].v), JSON.stringify(rows[0]));

  // The row must never print a key. Feed it a beacon that (wrongly) carries one and confirm the
  // rendered row still shows only the slug.
  rows = runRollup(rollup, {
    'bwn:ingest:dispatch': JSON.stringify({ k: 'SUPERSECRETKEYVALUE', ts: NOW })
  }, NOW);
  A.ok('the row never renders a beacon value', !/SUPERSECRET/.test(JSON.stringify(rows)), JSON.stringify(rows));
}

// ---- negative controls -------------------------------------------------------------------------
// Each mutation must make the matching guard fire. A mutation that silently matches nothing would
// leave a control that always "passes" ([[negative-control-silent-noop]]), so every replace() below
// is checked for having actually changed the bytes before its guard is asserted.

var probe = 'bwn-wo-audit.user.js';
var probeSrc = read(probe);

function mutate(name, from, to) {
  var out = probeSrc.replace(from, to);
  A.ok('control mutation "' + name + '" actually changed the probe bytes', out !== probeSrc);
  return out;
}
function fires(problems, code) {
  return problems.some(function (p) { return p.indexOf(code + ':') === 0; });
}

A.ok('the unmutated probe is clean', auditScript(probe, probeSrc).length === 0,
  auditScript(probe, probeSrc).join(' | '));

A.ok('BEACON fires when the load-time publish is removed',
  fires(auditScript(probe, mutate('drop load publish', /\n  publishIngestPresence\(\);/, '')), 'BEACON'));

A.ok('BEACONSAFE fires when the beacon stops coercing to 0/1',
  fires(auditScript(probe, mutate('leak the key', 'k: getKey() ? 1 : 0', 'k: getKey()')), 'BEACONSAFE'));

A.ok('BEACONTS fires on an inline Date.now()',
  fires(auditScript(probe, mutate('save-time ts', 'ts: INGEST_BEACON_TS', 'ts: Date.now()')), 'BEACONTS'));

A.ok('SAVEBEACON fires when a save stops republishing',
  fires(auditScript(probe, mutate('drop save republish', "GM_setValue('ingest_key', v.trim()); publishIngestPresence();", "GM_setValue('ingest_key', v.trim());")), 'SAVEBEACON'));

A.ok('PROMPT fires when a prompt drops the PER SCRIPT wording',
  fires(auditScript(probe, mutate('vague prompt', 'Tampermonkey scopes this PER SCRIPT, so setting it here sets it for WO Audit only - every other suite script needs its own copy:', 'used across the BWN Ops Suite:')), 'PROMPT'));

A.ok('COPY fires when the retired "used across the BWN Ops Suite" claim returns',
  fires(auditScript(probe, mutate('revive the false claim', 'WO_INGEST_KEY). Tampermonkey', 'WO_INGEST_KEY - used across the BWN Ops Suite). PER SCRIPT. Tampermonkey')), 'COPY'));

// A control on the SCOPE derivation itself: a script that does not read the key must audit clean
// even with none of the machinery, or the harness would demand beacons from all 21 scripts.
A.ok('a script that never reads ingest_key is out of scope',
  auditScript('bwn-kanban.user.js', read('bwn-kanban.user.js')).length === 0);

A.finish();
