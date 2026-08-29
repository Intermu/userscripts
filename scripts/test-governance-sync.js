// test-governance-sync.js - governance-completion slices (remote flag sync + central audit mirror).
//
// Wires the SHIPPED SWA backend (api/governance + api/audit-ingest) into the suite. This proves the
// SECURITY-critical branch logic against the REAL shipped bytes (the marked slices are cut out of
// bwn-suite-core.user.js / bwn-suite-ai.user.js and run in a vm with injected fakes - no restatement
// of a stub). The GM_xmlhttpRequest transport happy-path is verified live, not here.
//
// WHAT THIS PROVES:
//  Core BWN-GOV-APPLY (bwnApplyGov, one-way reconciliation):
//   - a remote flags[key]===false DISABLES that local module;
//   - a remote flags[key]===true does NOT ENABLE a locally-off module (one-way; only ever disable);
//   - flags.globalKillSwitch===true disables EVERY module;
//   - an absent / corrupt / flagless bundle leaves local defaults untouched (safe).
//  AI BWN-GOV-CONN (connectorEnabled, remote kill gates egress):
//   - local toggle bwn:modules.connector===false => OFF (unchanged behavior);
//   - remote globalKillSwitch / flags.connector===false => OFF (new);
//   - no bundle / corrupt bundle => ON (fail-open to the user toggle, established convention).
//  AI BWN-GOV-SYNC (govFetchAllowed + auditFlush):
//   - DEADLOCK-AVOIDANCE: govFetchAllowed() stays TRUE under a remote kill (so a kill can be LIFTED
//     by a later poll), yet FALSE with no key or the local toggle off;
//   - the audit mirror is gated by connectorEnabled() (a kill holds it), needs the SEPARATE audit_key,
//     dedups against the high-water, batches <=50, and only a real {ok:true} advances the high-water.
//
// Each negative control mutates the SAME source and MUST turn a check red; mutate() throws if its
// target is absent or not unique, so a silent no-op cannot pass for a control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-governance-sync.js
// CI runs: node scripts/test-governance-sync.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');
var AI = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-ai.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(src, start, end) {
  var a = src.indexOf(start);
  if (a === -1) throw new Error('START marker not found: ' + start);
  if (src.indexOf(start, a + 1) !== -1) throw new Error('START marker not unique: ' + start);
  var b = src.indexOf(end, a);
  if (b === -1) throw new Error('END marker not found after start: ' + end);
  return src.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var CORE_APPLY = slice(CORE, '// BWN-GOV-APPLY-SLICE-START', '// BWN-GOV-APPLY-SLICE-END');
var AI_CONN = slice(AI, '// BWN-GOV-CONN-SLICE-START', '// BWN-GOV-CONN-SLICE-END');
var AI_SYNC = slice(AI, '// BWN-GOV-SYNC-SLICE-START', '// BWN-GOV-SYNC-SLICE-END');

// ---- fakes -----------------------------------------------------------------
function fakeStore(seed) {
  var store = Object.create(null);
  if (seed) Object.keys(seed).forEach(function (k) { store[k] = (typeof seed[k] === 'string') ? seed[k] : JSON.stringify(seed[k]); });
  return {
    store: store,
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    }
  };
}
function baseSandbox(fs) {
  return {
    console: console, Date: Date, JSON: JSON, Math: Math, String: String, Number: Number,
    Array: Array, Object: Object, RegExp: RegExp,
    localStorage: fs.localStorage,
    setTimeout: function () { }, setInterval: function () { },
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    BWN: { guard: function (fn) { return fn; } }
  };
}

// ---- Core: bwnApplyGov one-way reconciliation ------------------------------
function runApply(gov, modules, src) {
  var f = fakeStore(gov == null ? {} : { 'bwn:gov': gov });
  if (gov != null && typeof gov === 'string') f.store['bwn:gov'] = gov;   // allow injecting corrupt raw JSON
  var sb = baseSandbox(f);
  sb.BWN_MODULES = JSON.parse(JSON.stringify(modules));
  vm.runInNewContext(src, sb);
  return sb.BWN_MODULES;
}
var DEF = { poApproval: true, woAssist: true, woAssistWrites: false, listHeat: true, bulkOps: false };

(function () {
  var m = runApply({ v: 1, etag: 'x', flags: { woAssist: false } }, DEF, CORE_APPLY);
  A.eq('apply: remote woAssist:false disables it', m.woAssist, false);
  A.eq('apply: untouched module stays on', m.listHeat, true);

  m = runApply({ v: 1, etag: 'x', flags: { woAssistWrites: true, bulkOps: true } }, DEF, CORE_APPLY);
  A.eq('apply: remote true does NOT enable a locally-off write module (woAssistWrites)', m.woAssistWrites, false);
  A.eq('apply: remote true does NOT enable a locally-off module (bulkOps)', m.bulkOps, false);

  m = runApply({ v: 1, etag: 'x', flags: { globalKillSwitch: true } }, DEF, CORE_APPLY);
  A.ok('apply: globalKillSwitch disables EVERY module',
    !m.poApproval && !m.woAssist && !m.listHeat && !m.woAssistWrites && !m.bulkOps,
    JSON.stringify(m));

  A.eq('apply: absent bundle leaves defaults', runApply(null, DEF, CORE_APPLY).poApproval, true);
  A.eq('apply: corrupt bundle leaves defaults', runApply('{not json', DEF, CORE_APPLY).poApproval, true);
  A.eq('apply: flagless bundle leaves defaults', runApply({ v: 1, etag: 'x' }, DEF, CORE_APPLY).listHeat, true);

  // Negative control: break the one-way guard so remote true would ENABLE - the enable test must go red.
  var bad = mutate(CORE_APPLY, 'if (kill || f[k] === false) BWN_MODULES[k] = false;', 'BWN_MODULES[k] = f[k] === undefined ? BWN_MODULES[k] : f[k];');
  var mb = runApply({ v: 1, etag: 'x', flags: { bulkOps: true } }, DEF, bad);
  A.eq('control: two-way apply WOULD enable bulkOps (proves the one-way guard is load-bearing)', mb.bulkOps, true);
})();

// ---- AI: connectorEnabled remote-kill gate ---------------------------------
function runConn(seed) {
  var f = fakeStore(seed);
  var sb = baseSandbox(f);
  vm.runInNewContext(AI_CONN, sb);
  return sb.connectorEnabled();
}
(function () {
  A.eq('conn: no state => ON', runConn({}), true);
  A.eq('conn: local toggle off => OFF', runConn({ 'bwn:modules': { connector: false } }), false);
  A.eq('conn: remote globalKillSwitch => OFF', runConn({ 'bwn:gov': { flags: { globalKillSwitch: true } } }), false);
  A.eq('conn: remote connector:false => OFF', runConn({ 'bwn:gov': { flags: { connector: false } } }), false);
  A.eq('conn: remote flags present but no kill => ON', runConn({ 'bwn:gov': { flags: { woAssist: false } } }), true);
  A.eq('conn: corrupt bwn:gov => ON (fail-open to user toggle)', runConn({ 'bwn:gov': '{bad', 'bwn:modules': {} }), true);
})();

// ---- AI: govFetchAllowed + auditFlush (CONN + SYNC together for the real connectorEnabled) --
function loadSync(seed, opts) {
  opts = opts || {};
  var f = fakeStore(seed);
  var sb = baseSandbox(f);
  sb.INGEST_URL = 'https://swa.example/api/wo-ingest';
  sb.document = { dispatchEvent: function () { }, addEventListener: function () { } };
  sb.GM_getValue = function (k, d) { return (opts.gm && k in opts.gm) ? opts.gm[k] : d; };
  sb.connOk = function () { }; sb.connFail = function () { };
  sb.ingestActor = function () { return 'tester'; };
  var posts = [];
  sb.GM_xmlhttpRequest = function (cfg) {
    posts.push(cfg);
    var resp = opts.resp || { status: 200, responseText: '{"ok":true}' };
    if (cfg.onload) cfg.onload(resp);
  };
  vm.runInNewContext(AI_CONN + '\n' + AI_SYNC, sb);
  return { sb: sb, store: f.store, posts: posts };
}
(function () {
  // deadlock-avoidance: a remote kill must NOT stop the governance poll.
  var r = loadSync({ 'bwn:gov': { flags: { globalKillSwitch: true } }, 'bwn:modules': {} }, { gm: { ingest_key: 'K' } });
  A.eq('govFetchAllowed: TRUE under a remote kill (poll can lift the kill)', r.sb.govFetchAllowed(), true);
  r = loadSync({}, { gm: {} });
  A.eq('govFetchAllowed: FALSE with no ingest key', r.sb.govFetchAllowed(), false);
  r = loadSync({ 'bwn:modules': { connector: false } }, { gm: { ingest_key: 'K' } });
  A.eq('govFetchAllowed: FALSE with the local connector toggle off', r.sb.govFetchAllowed(), false);

  // audit mirror is gated by the kill (it IS egress).
  r = loadSync({ 'bwn:gov': { flags: { globalKillSwitch: true } }, 'bwn:audit': [{ corrId: 'c1', op: 'patchWorkOrder' }] }, { gm: { audit_key: 'A' } });
  r.sb.auditFlush();
  A.eq('auditFlush: NO post under a remote kill', r.posts.length, 0);

  // no audit_key => silent no-op even with a ring + connector on.
  r = loadSync({ 'bwn:audit': [{ corrId: 'c1', op: 'patchWorkOrder' }] }, { gm: {} });
  r.sb.auditFlush();
  A.eq('auditFlush: NO post without the separate audit_key', r.posts.length, 0);

  // happy path: posts the fresh entry and advances the high-water on {ok:true}.
  r = loadSync({ 'bwn:audit': [{ corrId: 'c1', op: 'patchWorkOrder' }, { corrId: 'c2', op: 'addTask' }] }, { gm: { audit_key: 'A' } });
  r.sb.auditFlush();
  A.eq('auditFlush: posts once', r.posts.length, 1);
  var sent = JSON.parse(r.posts[0].data);
  A.eq('auditFlush: batch carries both fresh entries', sent.entries.length, 2);
  A.eq('auditFlush: high-water now holds both corrIds', JSON.parse(r.store['bwn:auditHW']).sort(), ['c1', 'c2']);

  // dedup: an already-flushed corrId is not re-sent.
  r = loadSync({ 'bwn:audit': [{ corrId: 'c1', op: 'x' }, { corrId: 'c2', op: 'y' }], 'bwn:auditHW': ['c1'] }, { gm: { audit_key: 'A' } });
  r.sb.auditFlush();
  A.eq('auditFlush: only the un-flushed corrId is sent', JSON.parse(r.posts[0].data).entries.map(function (e) { return e.corrId; }), ['c2']);

  // a non-ok response (e.g. a chased login page: 200 but not {ok:true}) does NOT advance the high-water.
  r = loadSync({ 'bwn:audit': [{ corrId: 'c9', op: 'x' }] }, { gm: { audit_key: 'A' }, resp: { status: 200, responseText: '<!doctype html>login' } });
  r.sb.auditFlush();
  A.ok('auditFlush: high-water NOT advanced on a non-{ok:true} response', !('bwn:auditHW' in r.store), r.store['bwn:auditHW']);

  // batch cap 50.
  var ring = []; for (var i = 0; i < 60; i++) ring.push({ corrId: 'k' + i, op: 'x' });
  r = loadSync({ 'bwn:audit': ring }, { gm: { audit_key: 'A' } });
  r.sb.auditFlush();
  A.eq('auditFlush: batch capped at 50', JSON.parse(r.posts[0].data).entries.length, 50);

  // govFetch happy path caches the bundle with reach:ok; a 200-HTML (no {v,etag}) does NOT.
  r = loadSync({}, { gm: { ingest_key: 'K' }, resp: { status: 200, responseText: JSON.stringify({ v: 1, etag: '"gov-abc"', flags: { woAssist: false } }) } });
  r.sb.govFetch();
  A.eq('govFetch: valid bundle cached with reach=ok', JSON.parse(r.store['bwn:gov']).reach, 'ok');
  A.eq('govFetch: bundle etag stored for the next conditional GET', JSON.parse(r.store['bwn:gov']).etag, '"gov-abc"');

  r = loadSync({ 'bwn:gov': { v: 1, etag: '"old"', flags: { woAssist: false } } }, { gm: { ingest_key: 'K' }, resp: { status: 200, responseText: '<!doctype html>login' } });
  r.sb.govFetch();
  var g = JSON.parse(r.store['bwn:gov']);
  A.eq('govFetch: 200-HTML marks unreachable, does NOT overwrite flags', g.reach, 'unreachable');
  A.eq('govFetch: 200-HTML keeps the last-known-good flags (no relax)', g.flags.woAssist, false);

  r = loadSync({ 'bwn:gov': { v: 1, etag: '"old"', flags: { woAssist: false } } }, { gm: { ingest_key: 'K' }, resp: { status: 403, responseText: '{"error":"unauthorized"}' } });
  r.sb.govFetch();
  A.eq('govFetch: 403 keeps last-known-good flags', JSON.parse(r.store['bwn:gov']).flags.woAssist, false);
})();

A.finish();
