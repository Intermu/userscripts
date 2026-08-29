// test-error-reporter.js - node harness for Core's shared error reporter (RM-B2).
//
// WHAT THIS PROVES:
//   ~half the suite's catches are silent, so real failures are invisible. BWN.report
//   (window.bwnReport) gives one place a user-facing failure both SURFACES (a toast) and leaves a
//   bounded, PII-FREE breadcrumb in the bwn:errlog ring - a SEPARATE localStorage key from the
//   bwn:audit write-governance ring, which the reporter never touches. This harness slices the
//   SHIPPED bytes of the reporter out of bwn-suite-core.user.js and runs them against a fake
//   localStorage + a fake BWN.toast, then asserts:
//     - with the reporter ON, a simulated user-facing failure produces EXACTLY ONE ring entry AND
//       exactly one toast, and the entry carries only ids + a short fixed tag;
//     - NOTHING sensitive leaks: the free-text toast message, a long client-name string, a nested
//       object, and non-whitelisted keys (token/note) never appear in the stored entry;
//     - the ring is bounded (never grows past its cap);
//     - with the reporter OFF the toast STILL shows but NOTHING is logged (fail-safe);
//     - the reporter writes bwn:errlog, never bwn:audit.
//
//   Every negative control reverts ONE guarantee in the sliced source and asserts THIS harness goes
//   red; mutate() throws if its target is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-error-reporter.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var CORE = path.join(__dirname, '..', 'bwn-suite-core.user.js');
function coreSrc() { return fs.readFileSync(CORE, 'utf8').replace(/\r\n/g, '\n'); }

var START = '// BWN-REPORT START (RM-B2;';
var END = '// BWN-REPORT END (RM-B2)';
function sliceReporter(src) {
  var a = src.indexOf(START), b = src.indexOf(END, a === -1 ? 0 : a);
  if (a === -1 || b === -1) throw new Error('BWN-REPORT markers not found in Core');
  return src.slice(a, b + END.length);
}

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- fake environment ------------------------------------------------------------------------
function makeEnv(reporterOn) {
  var store = {};
  var localStorage_ = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  var toasts = [];
  var BWN = { toast: function (level, msg, opts) { toasts.push({ level: level, msg: msg, opts: opts }); } };
  var BWN_MODULES = { errorReporter: !!reporterOn };
  return { store: store, localStorage: localStorage_, BWN: BWN, BWN_MODULES: BWN_MODULES, toasts: toasts };
}

function buildReporter(src, env) {
  var body = src + '\n; return { report: BWN.report, errlog: BWN.errlog };';
  var f = new Function('BWN', 'BWN_MODULES', 'localStorage', 'BWN_VER', 'window', body);
  return f(env.BWN, env.BWN_MODULES, env.localStorage, '1.78.40', {});
}

var SRC = sliceReporter(coreSrc());

// ---- reporter ON: one entry + one toast, ids + tag only --------------------------------------
(function () {
  var env = makeEnv(true), R = buildReporter(SRC, env);
  var entry = R.report({ level: 'error', tag: 'woAssist.taskCreate.fail', feature: 'woAssist', ids: { wo: 123 }, toast: 'Task not created: boom' });
  A.eq('one toast shown', env.toasts.length, 1);
  A.eq('toast is error-level', env.toasts[0].level, 'error');
  A.eq('toast carries the user-facing message', env.toasts[0].msg, 'Task not created: boom');
  A.eq('exactly one ring entry', R.errlog.all().length, 1);
  A.eq('entry tag', entry.tag, 'woAssist.taskCreate.fail');
  A.eq('entry feature', entry.feature, 'woAssist');
  A.eq('entry ids are scalar only', entry.ids, { wo: 123 });
  A.eq('entry level', entry.level, 'error');
  A.eq('entry carries the ver', entry.ver, '1.78.40');
  A.ok('the reporter writes bwn:errlog', Object.prototype.hasOwnProperty.call(env.store, 'bwn:errlog'));
  A.ok('the reporter NEVER writes bwn:audit', env.localStorage.getItem('bwn:audit') === null);
})();

// ---- PII: nothing sensitive reaches the ring -------------------------------------------------
function noPII(R, env) {
  env.toasts.length = 0;
  R.errlog.clear();
  R.report({
    level: 'error',
    tag: 'woAssist.statusChange.fail',
    feature: 'woAssist',
    // free text in the toast (shown, never logged):
    toast: 'Could not update for client ACME Corporation - balance $9,999 secret',
    // ids salted with things that MUST be dropped: a long client-name string, a nested object:
    ids: { wo: 5, clientName: 'ACME Corporation Holdings LLC of Greater Metroville', profile: { ssn: '000-00-0000' } },
    // non-whitelisted keys that must never be copied:
    token: 'sk-live-abcdef0123456789',
    note: 'internal note body text'
  });
  var blob = JSON.stringify(R.errlog.all());
  return blob.indexOf('ACME') === -1 && blob.indexOf('secret') === -1 && blob.indexOf('9,999') === -1 &&
    blob.indexOf('sk-live') === -1 && blob.indexOf('note body') === -1 && blob.indexOf('000-00-0000') === -1;
}
(function () {
  var env = makeEnv(true), R = buildReporter(SRC, env);
  A.ok('no free text, name, token, note, or nested object leaks into the entry', noPII(R, env));
  // and the wo scalar id DID survive (the entry is still useful):
  A.eq('the scalar wo id survives', R.errlog.all()[0].ids, { wo: 5 });
})();

// ---- ring is bounded -------------------------------------------------------------------------
function ringLen(R) {
  R.errlog.clear();
  for (var i = 0; i < 150; i++) R.report({ tag: 't' + i });
  return R.errlog.all();
}
(function () {
  var env = makeEnv(true), R = buildReporter(SRC, env);
  var all = ringLen(R);
  A.eq('ring is capped at 100', all.length, 100);
  A.eq('the newest entry is kept', all[99].tag, 't149');
  A.eq('the oldest overflow is dropped', all[0].tag, 't50');
})();

// ---- reporter OFF: fail-safe (toast shows, nothing logged) ------------------------------------
(function () {
  var env = makeEnv(false), R = buildReporter(SRC, env);
  var ret = R.report({ level: 'error', tag: 'x.fail', toast: 'msg' });
  A.eq('with the flag off, the toast still shows', env.toasts.length, 1);
  A.eq('with the flag off, NOTHING is logged', R.errlog.all().length, 0);
  A.ok('with the flag off, report returns null', ret === null);
  A.ok('with the flag off, no bwn:errlog key is created', env.localStorage.getItem('bwn:errlog') === null);
})();

// ---- negative controls -----------------------------------------------------------------------
// NC1: leak the free-text toast into the entry -> the PII check must catch it.
var NC1 = mutate(SRC, 'ids: bwnErrlogIds(o.ids),', 'ids: bwnErrlogIds(o.ids), raw: o.toast,');
(function () {
  var env = makeEnv(true), R = buildReporter(NC1, env);
  A.ok('NC1 red: leaking the toast free-text is caught by the PII check', noPII(R, env) === false);
})();

// NC2: remove the ring cap -> the bounded-ring check must catch it.
var NC2 = mutate(SRC, 'if (a.length > BWN_ERRLOG_MAX) a = a.slice(a.length - BWN_ERRLOG_MAX);', '/* cap removed */');
(function () {
  var env = makeEnv(true), R = buildReporter(NC2, env);
  A.ok('NC2 red: without the cap, the ring grows unbounded', ringLen(R).length === 150);
})();

// NC3: remove the flag gate -> the fail-safe (off => no log) check must catch it.
var NC3 = mutate(SRC, 'if (BWN_MODULES.errorReporter !== true) return null;', '/* gate removed */');
(function () {
  var env = makeEnv(false), R = buildReporter(NC3, env);
  R.report({ tag: 'x.fail', toast: 'msg' });
  A.ok('NC3 red: without the gate, an entry is logged even with the flag off', R.errlog.all().length === 1);
})();

A.finish();
