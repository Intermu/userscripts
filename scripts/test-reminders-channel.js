// test-reminders-channel.js - node harness for the BWN-REM-CHANNEL block in bwn-suite-core
// (Core 1.83.0): how a due Follow-up reminder picks its delivery path from the per-user
// preference the Ops Suite panel stores at bwn:config.notify.channel.
//
// WHAT THIS PROVES, against the REAL shipped bytes (the block sliced out of bwn-suite-core.user.js;
// it has no DOM or storage dependency, so it runs bare):
//   - remChannel: unset, malformed, unknown -> 'desktop' (the 1.82.0 behaviour, so an unset key
//     changes nothing); 'toast' and 'quiet' pass through.
//   - remPlan: quiet -> 'none' whatever the permission; toast -> 'toast' even when permission is
//     granted (the toast-only user never gets a desktop popup); desktop -> 'desktop' only when
//     granted, else 'toast' (denied, default, or no Notification API at all).
//   - the spec in OPS_PREF_FIELDS carries exactly the three values the reader accepts, and its
//     default is 'desktop' - a select default the reader would treat as unknown would silently be
//     the desktop path under a different name.
//   - source pins: notify() routes through remPlan(channel(), permState()); reqPerm() is gated on
//     the desktop channel so a toast-only or quiet user is never prompted.
//
// Mutation control: dropping the quiet branch in remPlan makes quiet toast. mutate() throws if
// its target is absent or not unique, so a silent no-op cannot pass for a control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-reminders-channel.js

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
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('mutate: target absent: ' + from);
  if (src.indexOf(from, i + 1) !== -1) throw new Error('mutate: target not unique: ' + from);
  return src.slice(0, i) + to + src.slice(i + from.length);
}
var S_REM = slice('    // ===== BWN-REM-CHANNEL START v1', '    // ===== BWN-REM-CHANNEL END v1 =====', 'BWN-REM-CHANNEL block');
var S_SET = slice('    // ===== BWN-SETTINGS START v1', '    // ===== BWN-SETTINGS END v1 =====', 'BWN-SETTINGS block');
function build(src) { return (new Function(src + '\n;return { remChannel: remChannel, remPlan: remPlan };'))(); }
var T = build(S_REM);
var SPEC = (new Function(S_SET + '\n;return OPS_PREF_FIELDS;'))().filter(function (f) { return f.k === 'notify.channel'; })[0];

function blob(ch) { return JSON.stringify({ v: 1, notify: { channel: ch } }); }

console.log('1. remChannel - reading the preference');
(function () {
  A.eq('unset blob -> desktop (1.82.0 behaviour)', T.remChannel(null), 'desktop');
  A.eq('empty string -> desktop', T.remChannel(''), 'desktop');
  A.eq('malformed blob -> desktop, no throw', T.remChannel('{not json'), 'desktop');
  A.eq('blob without notify group -> desktop', T.remChannel(JSON.stringify({ v: 1, audit: { gpLow: 20 } })), 'desktop');
  A.eq('notify group not an object -> desktop', T.remChannel(JSON.stringify({ v: 1, notify: 'quiet' })), 'desktop');
  A.eq('explicit desktop -> desktop', T.remChannel(blob('desktop')), 'desktop');
  A.eq('toast -> toast', T.remChannel(blob('toast')), 'toast');
  A.eq('quiet -> quiet', T.remChannel(blob('quiet')), 'quiet');
  A.eq('unknown value (email) -> desktop, never a silent third path', T.remChannel(blob('email')), 'desktop');
})();

console.log('\n2. remPlan - channel x permission');
(function () {
  ['granted', 'denied', 'default', null].forEach(function (p) {
    A.eq('quiet + ' + p + ' -> none', T.remPlan('quiet', p), 'none');
    A.eq('toast + ' + p + ' -> toast (never desktop)', T.remPlan('toast', p), 'toast');
  });
  A.eq('desktop + granted -> desktop', T.remPlan('desktop', 'granted'), 'desktop');
  A.eq('desktop + denied -> toast fallback', T.remPlan('desktop', 'denied'), 'toast');
  A.eq('desktop + default (not yet asked) -> toast fallback', T.remPlan('desktop', 'default'), 'toast');
  A.eq('desktop + no Notification API -> toast fallback', T.remPlan('desktop', null), 'toast');
  A.eq('garbage channel + granted -> toast, not desktop (only the named channel earns the popup)', T.remPlan('bogus', 'granted'), 'toast');
})();

console.log('\n3. the spec and the reader agree');
(function () {
  A.ok('notify.channel spec exists in OPS_PREF_FIELDS', !!SPEC);
  var vals = SPEC ? SPEC.options.map(function (o) { return o[0]; }).sort() : [];
  A.eq('spec offers exactly desktop / quiet / toast', vals, ['desktop', 'quiet', 'toast']);
  A.eq('spec default is desktop (the unset behaviour)', SPEC && SPEC.def, 'desktop');
  vals.forEach(function (v) { A.eq('reader accepts spec value ' + v + ' as itself', T.remChannel(blob(v)), v); });
})();

console.log('\n4. source pins - the module actually routes through the block');
(function () {
  var a = coreFull.indexOf('    function notify(r) {');
  var b = coreFull.indexOf('    function fireDue() {', a);
  A.ok('notify() found before fireDue()', a !== -1 && b > a);
  var S_NOTIFY = coreFull.slice(a, b);
  A.ok('notify() decides through remPlan(channel(), permState())', /remPlan\(channel\(\), permState\(\)\)/.test(S_NOTIFY));
  A.ok('notify() returns before any UI when the plan is none', /if \(plan === 'none'\) return;/.test(S_NOTIFY));
  A.ok('notify() no longer reads Notification.permission directly', !/Notification\.permission/.test(S_NOTIFY));
  A.ok('reqPerm() asks only on the desktop channel', /function reqPerm\(\) \{ try \{ if \(channel\(\) === 'desktop' && window\.Notification/.test(coreFull));
})();

console.log('\n5. mutation control');
(function () {
  var noQuiet = build(mutate(S_REM, "if (channel === 'quiet') return 'none';", ''));
  A.eq('control: without the quiet branch, quiet toasts (so the guarantee above is real)', noQuiet.remPlan('quiet', 'denied'), 'toast');
  A.eq('control: the desktop path is untouched by the mutation', noQuiet.remPlan('desktop', 'granted'), 'desktop');
})();

A.finish();
