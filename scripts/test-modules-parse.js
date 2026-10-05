// test-modules-parse.js - the bwn:modules kill-switch blob, as each consumer script parses it.
//
// THE DEFECT (2026-10-05): six consumers parsed the blob with `JSON.parse(raw || '{}') || {}`. A
// stored primitive (5, "x", true) survived that, and the next line of four of them -
// `if (!('dispatch' in BWN_MODULES))` - threw a TypeError at load, killing the whole script. Core
// writes only booleans, so this needs a hand-edited or foreign value, but a dead script is a bad
// failure for a bad cache entry.
//
// THE CONTRACT now shipped, byte-identical in all six: the result is always a plain object holding
// only the stored object's own keys whose values are real booleans. Anything else (missing, bad
// JSON, null, a primitive, an array, a non-boolean value) contributes nothing - never coerced.
// Defaults, the bwn:gov one-way kill and the strict `=== false` / `=== true` readers are unchanged.
//
// Runs the REAL shipped bytes (sliced) in a vm with a fake localStorage. No regex source analysis.
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-modules-parse.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'); }

var START = '  var BWN_MODULES = (function';
var PARSE_END = '})();';
var GOV_END = "  try { document.addEventListener('bwn:gov'";

// own: the module key the script seeds a default for (null = it seeds none).
var SCRIPTS = [
  { f: 'bwn-dispatch.user.js', own: ['dispatch'], gov: true },
  { f: 'bwn-drop-upload.user.js', own: ['dropUpload', 'dropUploadWoDedupe'], gov: true },
  { f: 'bwn-kanban.user.js', own: ['kanban'], gov: true },
  { f: 'bwn-low-gp.user.js', own: ['lowGp'], gov: true },
  { f: 'bwn-notes.user.js', own: null, gov: false },
  { f: 'bwn-proposal-copy.user.js', own: null, gov: false }
];

function parserOf(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error('parser declaration not found');
  var b = src.indexOf(PARSE_END, a);
  return src.slice(a, b + PARSE_END.length);
}
function govBlockOf(src) {
  var a = src.indexOf(START), b = src.indexOf(GOV_END, a);
  if (a === -1 || b === -1) throw new Error('gov block not found');
  return src.slice(a, b);
}
// Runs a slice against a fake page and returns { mods, store } (or { err }).
function run(code, store) {
  var s = {};
  Object.keys(store || {}).forEach(function (k) { s[k] = store[k]; });
  var before = JSON.stringify(s);
  var ctx = {
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; },
      setItem: function (k, v) { s[k] = String(v); }
    }
  };
  try {
    var mods = vm.runInNewContext(code + '\n;BWN_MODULES;', ctx);
    return { mods: JSON.parse(JSON.stringify(mods)), untouched: JSON.stringify(s) === before };
  } catch (e) { return { err: e }; }
}

var SRC = {};
SCRIPTS.forEach(function (x) { SRC[x.f] = read(x.f); });

console.log('--- 1. one parser, byte-identical in all six consumers ---');
var parsers = SCRIPTS.map(function (x) { return parserOf(SRC[x.f]); });
parsers.forEach(function (p, i) {
  A.eq('identical parser: ' + SCRIPTS[i].f, p, parsers[0]);
});

console.log('\n--- 2. an invalid blob never throws and contributes nothing ---');
var INVALID = [
  ['missing key', undefined], ['bad JSON', '{not json'], ['null', 'null'], ['a number', '5'],
  ['a string', '"x"'], ['a boolean', 'true'], ['an empty array', '[]'], ['a non-empty array', '[false, true]']
];
SCRIPTS.forEach(function (x) {
  INVALID.forEach(function (c) {
    var store = c[1] === undefined ? {} : { 'bwn:modules': c[1] };
    var r = run(parserOf(SRC[x.f]), store);
    A.ok(x.f + ' / ' + c[0] + ': parse does not throw', !r.err, r.err && String(r.err));
    if (!r.err) A.eq(x.f + ' / ' + c[0] + ': parses to {}', r.mods, {});
    if (x.gov) {
      var g = run(govBlockOf(SRC[x.f]), store);
      A.ok(x.f + ' / ' + c[0] + ': the script\'s load path (defaults + gov) does not throw', !g.err, g.err && String(g.err));
      if (!g.err) x.own.forEach(function (k) { A.eq(x.f + ' / ' + c[0] + ': default ' + k + ' still applies', g.mods[k], true); });
    }
  });
});

console.log('\n--- 3. real booleans pass through; everything else is dropped, never coerced ---');
SCRIPTS.forEach(function (x) {
  var key = x.own ? x.own[0] : 'someFlag';
  var p = parserOf(SRC[x.f]);
  A.eq(x.f + ': ' + key + ':false kept', run(p, { 'bwn:modules': JSON.stringify(obj(key, false)) }).mods, obj(key, false));
  A.eq(x.f + ': ' + key + ':true kept', run(p, { 'bwn:modules': JSON.stringify(obj(key, true)) }).mods, obj(key, true));
  A.eq(x.f + ': routeHelper:true kept', run(p, { 'bwn:modules': '{"routeHelper":true}' }).mods, { routeHelper: true });
  var mixed = run(p, { 'bwn:modules': JSON.stringify({ a: 'false', b: 0, c: null, d: {}, e: [], f: 'true', g: 1, ok: false }) });
  A.eq(x.f + ': "false" / 0 / null / {} / [] / "true" / 1 dropped, the real boolean kept', mixed.mods, { ok: false });
  A.ok(x.f + ': no other storage key is touched', mixed.untouched);
  if (x.gov) {
    var s = run(govBlockOf(SRC[x.f]), { 'bwn:modules': JSON.stringify(obj(key, 'false')) });
    A.eq(x.f + ': a string "false" leaves the default on (same as before: readers are strict)', s.mods[key], true);
    var off = run(govBlockOf(SRC[x.f]), { 'bwn:modules': JSON.stringify(obj(key, false)) });
    A.eq(x.f + ': a real false still turns it off', off.mods[key], false);
  }
});
function obj(k, v) { var o = {}; o[k] = v; return o; }

console.log('\n--- 4. bwn:gov stays a one-way disable over the parsed blob ---');
SCRIPTS.filter(function (x) { return x.gov; }).forEach(function (x) {
  var k = x.own[0], g = govBlockOf(SRC[x.f]);
  var killed = run(g, { 'bwn:modules': JSON.stringify(obj(k, true)), 'bwn:gov': JSON.stringify({ v: 1, etag: 'e', flags: obj(k, false) }) });
  A.eq(x.f + ': gov flags.' + k + ':false disables a locally-on module', killed.mods[k], false);
  var cannot = run(g, { 'bwn:modules': JSON.stringify(obj(k, false)), 'bwn:gov': JSON.stringify({ v: 1, etag: 'e', flags: obj(k, true) }) });
  A.eq(x.f + ': gov can never enable a locally-off module', cannot.mods[k], false);
  var corrupt = run(g, { 'bwn:modules': '5', 'bwn:gov': JSON.stringify({ v: 1, etag: 'e', flags: { globalKillSwitch: true } }) });
  A.ok(x.f + ': a primitive blob + a global kill still loads', !corrupt.err, corrupt.err && String(corrupt.err));
  if (!corrupt.err) A.eq(x.f + ': and the kill applies', corrupt.mods[k], false);
});

console.log('\n--- 5. control: the old raw parser crashes the load path on a primitive ---');
var OLD = "  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();";
var dispGov = govBlockOf(SRC['bwn-dispatch.user.js']);
var oldGov = OLD + dispGov.slice(parserOf(SRC['bwn-dispatch.user.js']).length);
var crash = run(oldGov, { 'bwn:modules': '5' });
A.ok('control: with the old parser a stored 5 throws a TypeError at load', !!crash.err && crash.err.name === 'TypeError', crash.err ? String(crash.err) : 'did not throw');
A.ok('control: and the shipped parser is not the old one', parsers[0] !== OLD);

A.finish();
