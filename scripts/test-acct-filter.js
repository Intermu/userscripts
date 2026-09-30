// test-acct-filter.js - node harness for the BWN-ACCT-FILTER block in bwn-suite-core
// (Core 1.84.0): the standing account scope a coordinator sets in the Ops Suite panel >
// Preferences, stored at bwn:config.filters.accounts and read by List Heat on every list pass.
//
// WHAT THIS PROVES, against the REAL shipped bytes (both blocks are sliced out of
// bwn-suite-core.user.js and are pure, so they run bare with no DOM or storage):
//   - acctList: absent / empty / all-commas / all-blank -> [] (no scope at all, the pre-1.84.0
//     behaviour); entries are trimmed and lowercased; interior blanks are dropped.
//   - acctInScope: an empty scope admits everything; matching is case-insensitive SUBSTRING
//     ("dollar" matches "Dollar General"); a row whose client cannot be read is IN scope - fail
//     open, because the Client column can be hidden by the column chooser and a scope that blanks
//     the whole board is worse than one that quietly does nothing.
//   - the panel and the reader agree end to end: the spec exists as a text field with an empty
//     default, and the string bwnCfgPartial (BWN-SETTINGS) actually STORES is the string acctList
//     parses back - a blank clears the key, which is what "no scope" is made of.
//   - source pins: the list pass dims through acctInScope, the Audit panel scopes its entry set,
//     and the whole-board numbers stay whole-board - heatSnapshot, myDayCounts and the Over-30
//     batch never see the scope, and the panel drops its day-over-day delta while one is on
//     (a scoped count minus a whole-board snapshot day is not a delta).
//
// Mutation controls: dropping the fail-open blank-client branch hides rows with no readable
// client; dropping the empty-scope early return makes an unset preference hide the entire board.
// mutate() throws if its target is absent or not unique, so a silent no-op cannot pass for one.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-acct-filter.js

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
// Slice a function body by its opening line up to the opening line of the next one. Used only for
// the "this function does NOT read the scope" pins, where the boundary just has to be honest.
function fnSlice(startLine, endLine, what) {
  var a = coreFull.indexOf(startLine);
  if (a === -1) throw new Error(what + ': start line not found: ' + startLine);
  if (coreFull.indexOf(startLine, a + 1) !== -1) throw new Error(what + ': start line not unique: ' + startLine);
  var b = coreFull.indexOf(endLine, a);
  if (b === -1) throw new Error(what + ': end line not found after start: ' + endLine);
  return coreFull.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('mutate: target absent: ' + from);
  if (src.indexOf(from, i + 1) !== -1) throw new Error('mutate: target not unique: ' + from);
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S_ACCT = slice('    // ===== BWN-ACCT-FILTER START v1', '    // ===== BWN-ACCT-FILTER END v1 =====', 'BWN-ACCT-FILTER block');
var S_SET = slice('    // ===== BWN-SETTINGS START v1', '    // ===== BWN-SETTINGS END v1 =====', 'BWN-SETTINGS block');
function build(src) { return (new Function(src + '\n;return { acctList: acctList, acctInScope: acctInScope };'))(); }
var T = build(S_ACCT);
var SET = (new Function(S_SET + '\n;return { fields: OPS_PREF_FIELDS, partial: bwnCfgPartial, get: bwnCfgGet };'))();
var SPEC = SET.fields.filter(function (f) { return f.k === 'filters.accounts'; })[0];

console.log('1. acctList - parsing the stored string');
(function () {
  A.eq('undefined -> no scope', T.acctList(undefined), []);
  A.eq('null -> no scope', T.acctList(null), []);
  A.eq('empty string -> no scope', T.acctList(''), []);
  A.eq('whitespace only -> no scope', T.acctList('   '), []);
  A.eq('commas only -> no scope', T.acctList(',,,'), []);
  A.eq('single name, trimmed + lowercased', T.acctList('  Dollar General '), ['dollar general']);
  A.eq('several names', T.acctList('Dollar General, Wawa,ALDI'), ['dollar general', 'wawa', 'aldi']);
  A.eq('interior blanks dropped, order kept', T.acctList('Wawa, ,, ALDI'), ['wawa', 'aldi']);
  A.eq('a number is read as text, not coerced away', T.acctList(367), ['367']);
})();

console.log('\n2. acctInScope - who is in the scope');
(function () {
  A.ok('empty scope admits a client', T.acctInScope([], 'Dollar General'));
  A.ok('empty scope admits a blank client', T.acctInScope([], ''));
  A.ok('null scope admits everything (no scope configured)', T.acctInScope(null, 'Wawa'));
  var s = T.acctList('dollar, wawa');
  A.ok('exact entry matches', T.acctInScope(s, 'wawa'));
  A.ok('substring matches - "dollar" catches "Dollar General"', T.acctInScope(s, 'Dollar General'));
  A.ok('case-insensitive both ways', T.acctInScope(T.acctList('DOLLAR'), 'dollar tree'));
  A.ok('client is trimmed before the compare', T.acctInScope(s, '  Wawa  '));
  A.ok('second entry matches as readily as the first', T.acctInScope(s, 'Wawa Inc'));
  A.ok('a client in no entry is OUT of scope', !T.acctInScope(s, 'Sheetz'));
  A.ok('a near miss is still out', !T.acctInScope(T.acctList('wawa'), 'Sheetz'));
  A.ok('blank client is IN scope - fail open (the Client column can be hidden)', T.acctInScope(s, ''));
  A.ok('null client is IN scope for the same reason', T.acctInScope(s, null));
  A.ok('whitespace-only client is IN scope', T.acctInScope(s, '   '));
})();

console.log('\n3. the panel stores what the reader parses');
(function () {
  A.ok('filters.accounts spec exists in OPS_PREF_FIELDS', !!SPEC);
  A.eq('it is a text field', SPEC && SPEC.type, 'text');
  A.eq('its default is empty - unset means no scope', SPEC && SPEC.def, '');
  // Save "Dollar General, Wawa" through the REAL panel writer, then read it back with the REAL
  // reader. This is the whole contract in two calls: anything that breaks either side breaks here.
  // The panel submits EVERY field on Save, so the raw map carries them all - a select left out
  // would be rejected as an unknown option, which is the writer working, not a scope failure.
  function raw(accounts) {
    var m = {};
    SET.fields.forEach(function (f) { m[f.k] = f.type === 'select' ? f.def : ''; });
    m['filters.accounts'] = accounts;
    return m;
  }
  var r = SET.partial(SET.fields, raw(' Dollar General, Wawa '), {});
  A.ok('save is accepted', r.ok);
  A.eq('stored under filters.accounts', SET.get(r.partial, 'filters.accounts'), 'Dollar General, Wawa');
  A.eq('the reader parses the stored string', T.acctList(SET.get(r.partial, 'filters.accounts')), ['dollar general', 'wawa']);
  A.ok('a WO for a scoped client is in scope after the round trip',
    T.acctInScope(T.acctList(SET.get(r.partial, 'filters.accounts')), 'WAWA'));
  // Blank clears the nested key, so the reader sees undefined and reports no scope.
  var cleared = SET.partial(SET.fields, raw(''), { filters: { accounts: 'Wawa' } });
  A.ok('clearing is accepted', cleared.ok);
  A.eq('blank removes the key entirely', SET.get(cleared.partial, 'filters.accounts'), undefined);
  A.eq('and the reader reports no scope', T.acctList(SET.get(cleared.partial, 'filters.accounts')), []);
  // A sibling preference in the same group must survive a scope edit (BWN-SETTINGS' own rule,
  // pinned here because filters.* is the only group whose second key would be a future one).
  var sib = SET.partial(SET.fields, raw('Wawa'), { filters: { accounts: '', someFutureKey: 1 } });
  A.eq('a sibling key in filters survives', sib.partial.filters.someFutureKey, 1);
})();

console.log('\n4. source pins - where the scope is applied, and where it must not be');
(function () {
  A.ok('the list pass reads the preference once per pass',
    /var acct = acctList\(C\.filters && C\.filters\.accounts\);/.test(coreFull));
  A.ok('a hidden Client column is reported on the strip instead of dimming nothing silently',
    /if \(acct\.length && H\.client < 0\) missing\.push\('"Client" → account scope off'\);/.test(coreFull));
  A.ok('the list pass DIMS out-of-scope rows (never hides - the virtualizer)',
    /if \(!dimmed && !acctInScope\(acct, client\)\) dimmed = true;/.test(coreFull));
  A.ok('the scope is reported separately from the session filters, not inside them',
    /var scopeTxt = acct\.length \? ' · account scope: '/.test(coreFull) && !/filtBits\.push\('accounts/.test(coreFull));
  A.ok('the Audit panel scopes its entry set once, so every section inherits it',
    /\.filter\(function \(e\) \{ return acctInScope\(acctP, e\.client\); \}\)/.test(coreFull));
  A.ok('the Audit panel drops the day-over-day delta while a scope is on',
    /var pS = \(priorKey && !acctP\.length\) \? snaps\[priorKey\] : null;/.test(coreFull));
  A.ok('a scan that matched nothing is not reported as "no scan yet"',
    /none match your account scope/.test(coreFull));
  // Whole-board numbers stay whole-board. These four write or publish figures that outlive one
  // user's preference (a daily snapshot, the over-30 trend, an AI batch, the SWA dataset), so a
  // scoped count reaching any of them would be silently compared against whole-board days later.
  [['    function heatSnapshot() {', '    // ---- Is this row finished?', 'heatSnapshot'],
   ['    function myDayCounts() {', '    function renderMyDay() {', 'myDayCounts'],
   ['    function o30BatchStart() {', '    function myDayCounts() {', 'o30BatchStart']].forEach(function (f) {
    A.ok(f[2] + '() stays whole-board (never reads the scope)', !/acct/.test(fnSlice(f[0], f[1], f[2])));
  });
})();

console.log('\n5. mutation controls');
(function () {
  var noFailOpen = build(mutate(S_ACCT, "      if (!c) return true;   // no readable client - fail open, never hide work on a hidden column\n", ''));
  A.ok('control: without the fail-open branch a blank client falls out of scope',
    !noFailOpen.acctInScope(noFailOpen.acctList('wawa'), ''));
  A.ok('control: the mutation leaves real matching alone',
    noFailOpen.acctInScope(noFailOpen.acctList('wawa'), 'Wawa'));
  var noEmpty = build(mutate(S_ACCT, '      if (!list || !list.length) return true;\n', ''));
  A.ok('control: without the empty-scope return an UNSET preference hides the whole board',
    !noEmpty.acctInScope(noEmpty.acctList(''), 'Dollar General'));
})();

A.finish();
