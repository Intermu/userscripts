// test-client-profile.js - node harness for the T10 per-client status/closeout config layer
// (bwn-suite-core). Slices the REAL shipped bytes and runs them in a vm; nothing here restates
// the logic.
//
// WHAT THIS PROVES, against the sliced source:
//   - the resolver bwnClientProfile: an UNKNOWN client resolves to CLIENT_DEFAULTS_SEED
//     unchanged; a SEEDED client (amazon) resolves to defaults with its own row merged over
//     (clientId + refFields.sourceJob), keeping the sibling default (refFields.sourcePo=false);
//   - deepMerge keeps sibling nested keys on a partial override instead of wiping them;
//   - the SAFETY GUARANTEE: an EMPTY `clients` table (stored as {}) makes even a seeded client
//     resolve to CLIENT_DEFAULTS_SEED - so the engine's refField / cadence consumers are inert
//     and its output is byte-identical to before the layer existed;
//   - cfg()'s numeric-coercion loop preserves the nested `clients` object round-trip (the store
//     is the same read-modify-write blob the rest of the suite shares);
//   - the closeout doc-TYPE advisory (consumer a): a required type NOT matched by any document
//     label/displayFileName surfaces a soft 'docsverify' row; all matched -> silent; and the
//     confident-empty docs:none path plus the docs===null unknown guard are BYTE-IDENTICAL.
//
// Every mutation reverts one piece of the fix in the sliced source and asserts a case goes red.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-client-profile.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var core = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = core.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (core.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = core.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return core.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S_ALPHA = slice('    function alphaOnly(s)', '    // Longest common substring', 'alphaOnly');
var S_CFGBLOCK = slice('    var CFG_DEFAULTS = {', '    // ---- Per-client status/closeout config layer (T10)', 'CFG_DEFAULTS + cfg + cfgSave');
var S_T10 = slice('    // ---- Per-client status/closeout config layer (T10)', '    // ---- Money / date / vendor-name parsing', 'client-profile seeds + resolver');
var S_GATE = slice("      if (woPhase === 'confirmcomplete' || woPhase === 'costreview') {", '      // ---- Closure auto-advance:', 'closeout gate');

// ---- Resolver harness -------------------------------------------------------
// The real cfg()/cfgSave over a localStorage stub, plus the T10 seeds + resolver.
function buildResolver(mutations) {
  var t10 = S_T10;
  (mutations || []).forEach(function (m) { t10 = mutate(t10, m[0], m[1]); });
  var store = {};
  var sandbox = {
    JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    isFinite: isFinite, console: console,
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    document: { dispatchEvent: function () { } },
    CustomEvent: function () { }
  };
  var src = [S_ALPHA, S_CFGBLOCK, t10].join('\n') +
    '\nthis.__api = { cfg: cfg, cfgSave: cfgSave, bwnClientProfile: bwnClientProfile, ' +
    'bwnClientKey: bwnClientKey, deepMerge: deepMerge, ' +
    'CLIENT_DEFAULTS_SEED: CLIENT_DEFAULTS_SEED, CLIENT_PROFILE_SEED: CLIENT_PROFILE_SEED };\n';
  vm.runInNewContext(src, sandbox, { filename: 'resolver.js' });
  return sandbox.__api;
}

// ---- Closeout gate harness --------------------------------------------------
function buildGate(mutations) {
  var g = S_GATE;
  (mutations || []).forEach(function (m) { g = mutate(g, m[0], m[1]); });
  return vm.runInNewContext(
    '(function (woPhase, docs, profile) {\n' +
    '  var acts = [], ref = "W-1", ACT_SIGNALS = { stall: "stall" };\n' +
    '  var state = { docs: docs };\n' +
    g + '\n' +
    '  return acts;\n})',
    { String: String, Array: Array, Object: Object }, { filename: 'closeout-gate.js' });
}

function runResolverCases(mutations) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eqJSON(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

  var api;
  try { api = buildResolver(mutations); }
  catch (err) { out.push({ name: 'resolver source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  // unknown client -> defaults, deep-equal
  var unk = api.bwnClientProfile({ hd: { client: 'Some Unknown Co, LLC' } });
  eqJSON('an unknown client resolves to CLIENT_DEFAULTS_SEED', unk, api.CLIENT_DEFAULTS_SEED);

  // no hd / no client name -> defaults too (never throws)
  eqJSON('a WO with no client name resolves to defaults', api.bwnClientProfile({}), api.CLIENT_DEFAULTS_SEED);

  // seeded client (name -> alpha-only-lowercased key) -> defaults merged with its own row
  var amz = api.bwnClientProfile({ hd: { client: 'Amazon' } });
  ok('a seeded client carries its clientId', amz.clientId === '20321', JSON.stringify(amz));
  ok('and its refFields.sourceJob is turned on', amz.refFields.sourceJob === true, JSON.stringify(amz.refFields));
  ok('while the sibling refFields.sourcePo keeps the default (deepMerge did not wipe it)', amz.refFields.sourcePo === false, JSON.stringify(amz.refFields));
  ok('and closeout is inherited from the defaults', JSON.stringify(amz.closeout) === JSON.stringify(api.CLIENT_DEFAULTS_SEED.closeout), JSON.stringify(amz.closeout));

  // punctuation/case in the client name still keys the same seed row
  ok('the client key ignores case and punctuation', api.bwnClientKey('Transform SR Brands, LLC') === 'transformsrbrandsllc', api.bwnClientKey('Transform SR Brands, LLC'));
  ok('and that keys the SR seed (both source refs required)',
    api.bwnClientProfile({ hd: { client: 'Transform SR Brands LLC' } }).refFields.sourcePo === true, 'sr sourcePo');

  // SAFETY: an EMPTY clients table disables the seed entirely -> defaults, byte-identical engine
  api.cfgSave({ clients: {} });
  eqJSON('an EMPTY clients table makes a seeded client resolve to defaults (the safety guarantee)',
    api.bwnClientProfile({ hd: { client: 'Amazon' } }), api.CLIENT_DEFAULTS_SEED);

  // a STORED override table takes over from the seed
  api.cfgSave({ clients: { amazon: { clientId: '999', cadenceDays: 2 } } });
  var amz2 = api.bwnClientProfile({ hd: { client: 'Amazon' } });
  ok('a stored clients row overrides the seed clientId', amz2.clientId === '999', JSON.stringify(amz2));
  ok('and carries a stored cadenceDays', amz2.cadenceDays === 2, JSON.stringify(amz2));
  ok('an override with no refFields falls back to the default (off)', amz2.refFields.sourceJob === false, JSON.stringify(amz2.refFields));

  // cfg() round-trip: the nested clients object survives the numeric-coercion loop, and the
  // numeric defaults are still present.
  var c = api.cfg();
  eqJSON('cfg() preserves the nested clients object through its numeric loop', c.clients, { amazon: { clientId: '999', cadenceDays: 2 } });
  ok('and the numeric defaults are intact alongside it', c.targetGP === 35 && c.noteStaleDays === 7, JSON.stringify({ targetGP: c.targetGP, noteStaleDays: c.noteStaleDays }));

  // clientDefaults layer: a book-wide default merges UNDER a per-client row
  api.cfgSave({ clients: {}, clientDefaults: { cadenceDays: 5, refFields: { sourceJob: true } } });
  var dfl = api.bwnClientProfile({ hd: { client: 'Whoever' } });
  ok('clientDefaults raises the book-wide cadence', dfl.cadenceDays === 5, JSON.stringify(dfl));
  ok('and its refFields merge over the seed defaults', dfl.refFields.sourceJob === true, JSON.stringify(dfl.refFields));

  return out;
}

function runGateCases(mutations) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

  var gate;
  try { gate = buildGate(mutations); }
  catch (err) { out.push({ name: 'gate source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  var SEED = { closeout: { docs: ['signed ticket', 'sign-in/out', 'before/after photos'], enforce: true } };
  var EMPTY = { closeout: { docs: [], enforce: true } };

  // doc-TYPE advisory: docs present, some required types not matched
  var partial = gate('confirmcomplete', { count: 2, docs: [{ label: 'random file' }, { label: 'Signed Ticket', displayFileName: 't.pdf' }] }, SEED);
  eq('a partial completion package surfaces exactly one advisory row', partial.length, 1);
  eq('keyed as an advisory docsverify, never the blocking docs:none', partial[0].key, 'docsverify:sign-in/out,before/after photos');
  ok('the label names the missing types', (partial[0].label || '').indexOf('sign-in/out') !== -1, partial[0].label);
  ok('and it is phrased as advisory, not a block', (partial[0].why || '').indexOf('Advisory only') !== -1, partial[0].why);

  // all types matched -> silent
  var full = gate('confirmcomplete', { count: 3, docs: [{ label: 'signed ticket' }, { label: 'sign-in/out sheet' }, { label: 'before/after photos' }] }, SEED);
  eq('a complete package (all types matched) is silent', full.length, 0);

  // matching is case-insensitive across label + displayFileName
  var byName = gate('confirmcomplete', { count: 3, docs: [{ displayFileName: 'SIGNED TICKET.pdf' }, { label: 'Sign-In/Out' }, { label: 'Before/After Photos' }] }, SEED);
  eq('matching is case-insensitive and reads displayFileName too', byName.length, 0);

  // BYTE-IDENTICAL: a confident zero still fires docs:none, never the advisory
  var zero = gate('confirmcomplete', { count: 0, docs: [] }, SEED);
  eq('a confident-empty package still fires exactly the blocking docs:none', zero.length, 1);
  eq('and its key is the unchanged docs:none', zero[0].key, 'docs:none');

  // BYTE-IDENTICAL: docs===null is unknown -> nothing (advisory guard preserved)
  eq('an unknown (null) docs read fires nothing', gate('confirmcomplete', null, SEED).length, 0);

  // an empty closeout.docs profile -> only the docs:none path (verbatim fallback)
  eq('empty closeout.docs never advises on present docs', gate('confirmcomplete', { count: 2, docs: [{ label: 'x' }] }, EMPTY).length, 0);
  eq('empty closeout.docs still blocks on a confident zero', gate('confirmcomplete', { count: 0, docs: [] }, EMPTY).length, 1);

  // never outside the closing phases
  eq('the whole gate is silent outside confirm-complete / cost-review', gate('intake', { count: 0, docs: [] }, SEED).length, 0);

  // advisory does NOT block: it never fires docs:none, so the advance gate elsewhere is free
  ok('the advisory row is not the blocking docs:none', partial[0].key.indexOf('docsverify') === 0, partial[0].key);

  return out;
}

// ---- Negative controls ------------------------------------------------------
var RESOLVER_MUTATIONS = [
  { what: 'deepMerge replacing (wiping) a nested object instead of merging one level',
    m: ["if ((k === 'closeout' || k === 'refFields') && v && typeof v === 'object') {", 'if (false) {'] },
  { what: 'the resolver ignoring the stored clients table (always the seed)',
    m: ['var table = c.clients || CLIENT_PROFILE_SEED;', 'var table = CLIENT_PROFILE_SEED;'] },
  { what: 'the client-key case-fold dropped (seed rows never match a real name)',
    m: ['return alphaOnly(name).toLowerCase();', 'return alphaOnly(name);'] }
];
var GATE_MUTATIONS = [
  { what: 'the advisory firing on a matched type too (substring test inverted)',
    m: ['return !coLabels.some(function (L) { return L.indexOf(tl) !== -1; });', 'return coLabels.some(function (L) { return L.indexOf(tl) !== -1; });'] },
  { what: 'the docs-present guard dropped, so the advisory fires on a confident zero',
    m: ['if (docs && docs.count > 0 && coDocs.length && profile.closeout.enforce) {', 'if (docs && docs.count >= 0 && coDocs.length && profile.closeout.enforce) {'] },
  { what: 'the blocking docs:none path removed',
    m: ['if (docs && docs.count === 0) {', 'if (false) {'] }
];

function main() {
  console.log('\n-- the T10 per-client profile resolver --');
  runResolverCases(null).forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

  console.log('\n-- the T10 closeout doc-type advisory (consumer a) --');
  runGateCases(null).forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

  console.log('\n-- negative controls: each must turn a case above red --');
  RESOLVER_MUTATIONS.forEach(function (mm) {
    var rs;
    try { rs = runResolverCases([mm.m]); }
    catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case');
  });
  GATE_MUTATIONS.forEach(function (mm) {
    var rs;
    try { rs = runGateCases([mm.m]); }
    catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case');
  });

  A.finish();
}

main();
