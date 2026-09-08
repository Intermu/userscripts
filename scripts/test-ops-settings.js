// test-ops-settings.js - node harness for the BWN-SETTINGS block in bwn-suite-core (Core 1.82.0):
// the typed field specs behind the Ops Suite panel and the pure validate-and-nest step Save runs.
//
// WHAT THIS PROVES, against the REAL shipped bytes (the block sliced out of bwn-suite-core.user.js;
// it has no DOM or storage dependency, so it runs bare):
//   - every spec is well-formed: known type, dotted keys nest exactly one level, select specs
//     carry options that include their default, and no nested group collides with a top-level
//     object the blob already owns (ai, keys, clients, clientDefaults, v) - a collision would let
//     the panel overwrite another module's data.
//   - the nine top-level thresholds are the same nine keys as before (no rename rode the bump).
//   - number validation: NaN and below-min are rejected as before, and ABOVE-MAX is now rejected
//     (the gap the GM_config scan found - a gpWarn of 250 used to save).
//   - nested writes preserve sibling keys the panel does not own; blank or default clears the key;
//     two fields in one group accumulate on one object; an unchanged group is dropped from the
//     partial so an untouched Save writes nothing.
//   - select rejects a value outside its options; text is trimmed and blank clears.
//
// Two mutation controls re-run against altered source and MUST turn red: dropping the max check
// lets 250 through; dropping the sibling preserve loses a key the panel never rendered.
// mutate() throws if its target is absent or not unique, so a silent no-op cannot pass for a control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ops-settings.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  if (coreFull.indexOf(end, b + 1) !== -1) throw new Error(what + ': END marker not unique');
  return coreFull.slice(a, b);
}
var SECTION = slice('    // ===== BWN-SETTINGS START v1', '    // ===== BWN-SETTINGS END v1 =====', 'BWN-SETTINGS block');

function build(src) {
  return (new Function(src + '\n;return { OPS_CFG_FIELDS: OPS_CFG_FIELDS, OPS_PREF_FIELDS: OPS_PREF_FIELDS, bwnCfgGet: bwnCfgGet, bwnCfgPartial: bwnCfgPartial };'))();
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('mutate: target absent: ' + from);
  if (src.indexOf(from, i + 1) !== -1) throw new Error('mutate: target not unique: ' + from);
  return src.slice(0, i) + to + src.slice(i + from.length);
}
var T = build(SECTION);
var ALL = T.OPS_CFG_FIELDS.concat(T.OPS_PREF_FIELDS);
// Raw values as the panel would hand them over: every field present, defaults filled in.
function rawFrom(cfg, over) {
  var r = {};
  ALL.forEach(function (f) {
    var v = T.bwnCfgGet(cfg, f.k);
    r[f.k] = (v === undefined || v === null) ? (f.def === undefined ? '' : String(f.def)) : String(v);
  });
  Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
  return r;
}
var DEFAULTS = { targetGP: 35, gpWarn: 30, gpBad: 20, hrsWarn: 72, hrsBad: 240, activeMult: 0.5, dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7 };

console.log('1. spec shape');
(function () {
  var RESERVED = ['ai', 'keys', 'clients', 'clientDefaults', 'v'];
  var types = { number: 1, select: 1, text: 1 };
  ALL.forEach(function (f) {
    A.ok(f.k + ': known type', !!types[f.type], f.type);
    A.ok(f.k + ': label', typeof f.label === 'string' && f.label.length > 0);
    var p = f.k.split('.');
    A.ok(f.k + ': at most one level of nesting', p.length <= 2);
    if (p.length === 2) A.ok(f.k + ': group does not collide with a reserved top-level object', RESERVED.indexOf(p[0]) === -1);
    if (f.type === 'select') {
      A.ok(f.k + ': select has options', Array.isArray(f.options) && f.options.length > 1);
      A.ok(f.k + ': select default is one of its options', f.options.some(function (o) { return o[0] === f.def; }));
    }
    if (f.type === 'number' && typeof f.min === 'number' && typeof f.max === 'number') A.ok(f.k + ': min < max', f.min < f.max);
  });
  A.eq('the nine top-level thresholds are unchanged', T.OPS_CFG_FIELDS.map(function (f) { return f.k; }), Object.keys(DEFAULTS));
  A.ok('every top-level threshold is a number spec with min 0', T.OPS_CFG_FIELDS.every(function (f) { return f.type === 'number' && f.min === 0 && typeof f.max === 'number'; }));
  A.ok('every preference key is nested (per-user overrides live in a group)', T.OPS_PREF_FIELDS.every(function (f) { return f.k.indexOf('.') !== -1; }));
})();

console.log('\n2. bwnCfgGet');
(function () {
  var c = { targetGP: 40, audit: { gpLow: 20 }, notify: 'not-an-object' };
  A.eq('top-level', T.bwnCfgGet(c, 'targetGP'), 40);
  A.eq('nested', T.bwnCfgGet(c, 'audit.gpLow'), 20);
  A.eq('missing group -> undefined', T.bwnCfgGet(c, 'view.defaultWO'), undefined);
  A.eq('group that is not an object -> undefined, no throw', T.bwnCfgGet(c, 'notify.channel'), undefined);
  A.eq('null cfg -> undefined', T.bwnCfgGet(null, 'targetGP'), undefined);
})();

console.log('\n3. number validation (top-level thresholds)');
(function () {
  var r = T.bwnCfgPartial(ALL, rawFrom(DEFAULTS), DEFAULTS);
  A.ok('defaults round-trip: ok', r.ok);
  A.eq('defaults round-trip: nine thresholds stored, no groups', Object.keys(r.partial).sort(), Object.keys(DEFAULTS).sort());
  A.eq('NaN rejected', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { gpWarn: 'abc' }), DEFAULTS).bad, ['gpWarn']);
  A.eq('blank top-level rejected (was NaN before too)', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { hrsBad: '' }), DEFAULTS).bad, ['hrsBad']);
  A.eq('below min rejected', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { targetGP: '-1' }), DEFAULTS).bad, ['targetGP']);
  A.eq('ABOVE MAX rejected (new): gpWarn 250', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { gpWarn: '250' }), DEFAULTS).bad, ['gpWarn']);
  A.ok('at max accepted: gpWarn 100', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { gpWarn: '100' }), DEFAULTS).ok);
  A.eq('at max stored as a number', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { gpWarn: '100' }), DEFAULTS).partial.gpWarn, 100);
  var multi = T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { gpWarn: '250', hrsWarn: 'x' }), DEFAULTS);
  A.eq('two bad fields both reported', multi.bad.sort(), ['gpWarn', 'hrsWarn']);
  A.ok('a bad field blocks the save', !multi.ok);
  A.eq('float kept', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { activeMult: '0.75' }), DEFAULTS).partial.activeMult, 0.75);
})();

console.log('\n4. nested preferences');
(function () {
  var stored = Object.assign({ v: 1, audit: { gpLow: 20, handSet: true } }, DEFAULTS);
  var r = T.bwnCfgPartial(ALL, rawFrom(stored, { 'audit.staleDays': '3' }), stored);
  A.ok('ok', r.ok);
  A.eq('nested write lands under its group', r.partial.audit.staleDays, 3);
  A.eq('sibling the panel rendered survives', r.partial.audit.gpLow, 20);
  A.eq('sibling the panel NEVER rendered survives (handSet)', r.partial.audit.handSet, true);
  var clr = T.bwnCfgPartial(ALL, rawFrom(stored, { 'audit.gpLow': '' }), stored);
  A.ok('blank nested clears the key', !('gpLow' in clr.partial.audit));
  A.eq('clearing keeps the hand-set sibling', clr.partial.audit.handSet, true);
  var def = T.bwnCfgPartial(ALL, rawFrom(stored, { 'audit.gpLow': '15' }), stored);
  A.ok('nested equal to its default clears the key (consumer default applies)', !('gpLow' in def.partial.audit));
  var two = T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { 'audit.gpLow': '25', 'audit.staleDays': '10' }), DEFAULTS);
  A.eq('two fields in one group accumulate on one object', two.partial.audit, { gpLow: 25, staleDays: 10 });
  var untouched = T.bwnCfgPartial(ALL, rawFrom(stored), stored);
  A.ok('untouched save: unchanged group dropped from the partial', !('audit' in untouched.partial));
  A.ok('untouched save: groups with nothing stored and nothing set are absent', !('notify' in untouched.partial) && !('view' in untouched.partial) && !('filters' in untouched.partial));
  A.eq('nested above max rejected', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { 'audit.gpLow': '101' }), DEFAULTS).bad, ['audit.gpLow']);
  A.eq('nested NaN rejected (blank clears, garbage does not)', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { 'audit.gpLow': 'zz' }), DEFAULTS).bad, ['audit.gpLow']);
})();

console.log('\n5. select + text');
(function () {
  var r = T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { 'notify.channel': 'quiet', 'view.defaultWO': 'board' }), DEFAULTS);
  A.ok('ok', r.ok);
  A.eq('select stored', r.partial.notify.channel, 'quiet');
  A.eq('second select stored under its own group', r.partial.view.defaultWO, 'board');
  A.eq('select outside its options rejected', T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { 'notify.channel': 'email' }), DEFAULTS).bad, ['notify.channel']);
  var d = T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { 'notify.channel': 'toast' }), DEFAULTS);
  A.ok('select at its default writes no group', !('notify' in d.partial));
  var t = T.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { 'filters.accounts': '  Amazon, Caleres ' }), DEFAULTS);
  A.eq('text trimmed and stored', t.partial.filters.accounts, 'Amazon, Caleres');
  var storedT = Object.assign({ filters: { accounts: 'Amazon' } }, DEFAULTS);
  var tc = T.bwnCfgPartial(ALL, rawFrom(storedT, { 'filters.accounts': '   ' }), storedT);
  A.ok('blank text clears a stored value', 'filters' in tc.partial && !('accounts' in tc.partial.filters));
})();

console.log('\n6. mutation controls (each must turn the guarantee red)');
(function () {
  var noMax = build(mutate(SECTION, '(typeof f.max === \'number\' && n > f.max)', 'false'));
  A.ok('control: dropping the max check lets gpWarn 250 through', noMax.bwnCfgPartial(ALL, rawFrom(DEFAULTS, { gpWarn: '250' }), DEFAULTS).ok);
  var noSib = build(mutate(SECTION, 'Object.assign({}, (stored && stored[g] && typeof stored[g] === \'object\') ? stored[g] : {})', '{}'));
  var stored = Object.assign({ audit: { gpLow: 20, handSet: true } }, DEFAULTS);
  var r = noSib.bwnCfgPartial(ALL, rawFrom(stored, { 'audit.staleDays': '3' }), stored);
  A.ok('control: dropping the sibling preserve loses the hand-set key', !('handSet' in r.partial.audit));
})();

A.finish();
