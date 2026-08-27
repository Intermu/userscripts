// test-vp-upsert-governance.js - RM-D3 / G3: govern the silent bulk vpUpsert in bwn-suite-ai.
//
// THE FINDING (roadmap G3): every paid Find Techs / Find Suppliers search fired vpUpsert - up to 120
// prospect upserts to the shared SWA pipeline - with NO kill-switch check, NO audit, and NO debounce.
// A burst of searches re-POSTed the whole batch each time, silently, with no record and no way to stop
// it short of pulling the ingest key.
//
// WHAT THIS PROVES, against the REAL shipped bytes (the BWN-VP-UPSERT slice is cut out of
// bwn-suite-ai.user.js and run in a vm with injected fakes - no restatement of a stub):
//   - KILL SWITCH: connector off (connectorEnabled()===false) => NO SWA POST, audited outcome:'denied'
//     reason connector-off. This is the same switch (bwn:modules.connector) every other SWA egress honors.
//   - AUDIT: a bulk records exactly ONE bwn:audit entry (op:'vpUpsert', kind:'write', the COUNT + kind
//     + outcome) and it is PII-FREE - no prospect name / website / phone / address reaches the log.
//   - DEBOUNCE: an identical batch re-fired inside the window POSTs once, not twice (a re-search does
//     not re-blast); a genuinely different batch is NOT debounced.
//   - the 120-record cap still holds; a missing key is a silent no-op (no audit, no post).
//
// Each negative control mutates the SAME source and MUST turn a check red; mutate() throws if its
// target is absent or not unique, so a silent no-op cannot pass for a control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-vp-upsert-governance.js
// CI runs: node scripts/test-vp-upsert-governance.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-suite-ai.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var START = '// BWN-VP-UPSERT-SLICE-START';
var END = '// BWN-VP-UPSERT-SLICE-END';
function slice(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error('START marker not found - the vpUpsert slice is gone from bwn-suite-ai.user.js');
  if (src.indexOf(START, a + 1) !== -1) throw new Error('START marker not unique');
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error('END marker not found after start');
  return src.slice(a, b);
}
var S_SLICE = slice(full);

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function load(engineSrc, opts) {
  opts = opts || {};
  var store = Object.create(null);
  if (opts.role) store['bwn:role:last'] = JSON.stringify(opts.role);
  var posts = [];
  var sandbox = {
    console: console, Date: Date, JSON: JSON, Math: Math, String: String, Number: Number, Array: Array, Object: Object,
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    // records every SWA POST and drives onload so the recursive batcher advances.
    GM_xmlhttpRequest: function (cfg) { posts.push(cfg); if (cfg.onload) cfg.onload({ status: 200, responseText: '{"ok":true}' }); },
    vpKey: function () { return (opts.key === undefined) ? 'KEY' : opts.key; },
    connectorEnabled: function () { return opts.connector !== false; },
    PROSPECTS_URL: 'https://swa.example/api/vendor-prospects',
    // a deterministic stand-in for the real vpKeyOf (its keying is proven elsewhere); enough for the sig.
    vpKeyOf: function (r) { return String((r && (r.site || r.name)) || '').toLowerCase(); },
    BWN_VER: '1.45.21'
  };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox);
  return {
    vpUpsert: sandbox.vpUpsert,
    posts: posts,
    audit: function () { try { return JSON.parse(store['bwn:audit'] || '[]'); } catch (e) { return []; } },
    postedRecs: function () {
      return posts.reduce(function (acc, p) { try { return acc.concat(JSON.parse(p.data).upsert || []); } catch (e) { return acc; } }, []);
    }
  };
}

var MODE = { kind: 'contractor', title: 'Find Techs' };
function mkList(n, tag) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ name: (tag || 'V') + i, site: (tag || 'v') + i + '.example', phone: '555-000' + i, addr: i + ' Main St, Town, ST' });
  return out;
}

// ---- 1. happy path: connector on, key set -> POSTs + one PII-free 'ok' audit entry ----
console.log('\n-- happy path: a paid search saves the batch AND audits it (PII-free) --');
(function () {
  var S = load(S_SLICE);
  S.vpUpsert(mkList(3), MODE, 'HVAC');
  A.eq('a 3-record bulk POSTs once (<=40 per batch)', S.posts.length, 1);
  A.eq('all 3 records were sent', S.postedRecs().length, 3);
  var log = S.audit();
  A.eq('exactly one audit entry per bulk', log.length, 1);
  var e = log[0];
  A.ok('the entry names the op + kind + target', e.op === 'vpUpsert' && e.kind === 'write' && e.target === 'prospect', JSON.stringify(e));
  A.ok('outcome ok with a corrId + count', e.outcome === 'ok' && /^bwn-/.test(String(e.corrId)) && e.count === 3, JSON.stringify(e));
  var blob = JSON.stringify(e);
  A.ok('the audit entry leaks NO prospect name', blob.indexOf('V0') === -1 && blob.indexOf('V1') === -1, blob);
  A.ok('the audit entry leaks NO website / phone / address', blob.indexOf('.example') === -1 && blob.indexOf('555-') === -1 && blob.indexOf('Main St') === -1, blob);
})();

// ---- 2. kill switch: connector off -> no POST, audited denied ----
console.log('\n-- kill switch: connector off stops every SWA POST, audited denied --');
(function () {
  var S = load(S_SLICE, { connector: false });
  S.vpUpsert(mkList(5), MODE, 'HVAC');
  A.eq('connector off => NO SWA POST', S.posts.length, 0);
  var log = S.audit();
  A.ok('the refusal is audited denied (connector-off)', log.length === 1 && log[0].outcome === 'denied' && /connector-off/.test(String(log[0].reason)), JSON.stringify(log[0]));
})();

// ---- 3. debounce: identical re-fire within the window POSTs once ----
console.log('\n-- debounce: an identical re-search does not re-blast the pipeline --');
(function () {
  var S = load(S_SLICE);
  var list = mkList(4);
  S.vpUpsert(list, MODE, 'HVAC');
  var firstPosts = S.posts.length;
  S.vpUpsert(list, MODE, 'HVAC');   // same batch, immediately
  A.eq('the identical re-fire adds NO new POST', S.posts.length, firstPosts);
  var log = S.audit();
  A.eq('two audit entries (ok then debounced)', log.length, 2);
  A.ok('the second is outcome:debounced', log[1].outcome === 'debounced' && /duplicate-within/.test(String(log[1].reason)), JSON.stringify(log[1]));
  // a genuinely different batch is NOT debounced
  S.vpUpsert(mkList(4, 'OTHER'), MODE, 'HVAC');
  A.ok('a different batch DOES post again', S.posts.length > firstPosts, 'posts=' + S.posts.length);
})();

// ---- 4. the 120-cap and the no-key no-op still hold ----
console.log('\n-- 120-record cap + no-key no-op --');
(function () {
  var S = load(S_SLICE);
  S.vpUpsert(mkList(200), MODE, 'HVAC');
  A.eq('the batch is capped at 120 records', S.postedRecs().length, 120);
  A.eq('120 records => 3 POSTs of 40', S.posts.length, 3);
  A.eq('the audit count reflects the cap', S.audit()[0].count, 120);

  var S2 = load(S_SLICE, { key: '' });
  S2.vpUpsert(mkList(3), MODE, 'HVAC');
  A.eq('no key => no POST', S2.posts.length, 0);
  A.eq('no key => no audit entry (not a governance event)', S2.audit().length, 0);
})();

// ---- 5. negative controls: each MUST break a guarantee above ----
console.log('\n-- negative controls --');
(function () {
  // remove the kill-switch check: connector off now POSTs
  var M = mutate(S_SLICE, 'if (!connectorEnabled()) {', 'if (false && !connectorEnabled()) {');
  var S = load(M, { connector: false });
  S.vpUpsert(mkList(3), MODE, 'HVAC');
  A.ok('CONTROL: without the kill-switch check, connector-off POSTs (so the check is load-bearing)', S.posts.length === 1, 'posts=' + S.posts.length);
})();
(function () {
  // remove the debounce: an identical re-fire POSTs again
  var M = mutate(S_SLICE, 'if (sig === vpLastUpsert.sig && (now - vpLastUpsert.ts) < VP_UPSERT_DEBOUNCE_MS) {', 'if (false && sig === vpLastUpsert.sig && (now - vpLastUpsert.ts) < VP_UPSERT_DEBOUNCE_MS) {');
  var S = load(M);
  var list = mkList(4);
  S.vpUpsert(list, MODE, 'HVAC');
  S.vpUpsert(list, MODE, 'HVAC');
  A.eq('CONTROL: without the debounce, the identical re-fire POSTs twice', S.posts.length, 2);
})();
(function () {
  // leak a prospect NAME into the audit entry (via the reason field, in scope at the call site):
  // the PII check must then go red. This proves scenario 1's PII assertion is load-bearing. The
  // real code passes reason:null here precisely so no prospect data reaches the log.
  var M = mutate(S_SLICE, "vpAudit('ok', recs.length, mode, null)", "vpAudit('ok', recs.length, mode, recs[0].name)");
  var S = load(M);
  S.vpUpsert(mkList(2), MODE, 'HVAC');
  var blob = JSON.stringify(S.audit()[0] || {});
  A.ok('CONTROL: leaking a prospect name into the entry DOES expose it (so the PII check is load-bearing)', blob.indexOf('V0') !== -1, blob);
})();

A.finish();
