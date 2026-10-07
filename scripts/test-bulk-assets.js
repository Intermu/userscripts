// test-bulk-assets.js - node harness for bwn-bulk-assets.user.js (BWN Bulk Asset Uploader).
//
// Loads the SHIPPED file through its `module.exports` test hook (Tampermonkey has no `module`, so the
// hook never fires in the browser) and drives the real functions: header aliasing, date parsing,
// location # matching, the three Umbrava error envelopes, validateRows end to end against a fake
// API, and the transport + write path against a fake fetch - halt classes (401/403/429/expired
// token/network/5xx-on-write/UNAUTHENTICATED-as-500), success:false as a row failure, the bulkAssets
// kill switch, and a PII-free audit entry. Negative controls re-run the same checks against mutated
// copies of the shipped bytes, so each guard is shown to be load-bearing.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bulk-assets.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var FILE = path.join(__dirname, '..', 'bwn-bulk-assets.user.js');
var SRC = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

// ---- fake browser surface -------------------------------------------------------------------
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function jwt(expInSec) { return b64url({ alg: 'RS256' }) + '.' + b64url({ iss: 'https://login.umbrava.com/', sub: 'auth0|u1', exp: Math.floor(Date.now() / 1000) + expInSec }) + '.sig'; }
var TOKEN_KEY = '@@auth0spajs@@::cid::https://app.umbrava.com/api::openid profile';
function fakeStorage(init) {
  var s = {};
  Object.keys(init || {}).forEach(function (k) { s[k] = init[k]; });
  Object.defineProperty(s, 'getItem', { value: function (k) { return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null; } });
  Object.defineProperty(s, 'setItem', { value: function (k, v) { s[k] = String(v); } });
  Object.defineProperty(s, 'removeItem', { value: function (k) { delete s[k]; } });
  return s;
}
function withToken(expInSec) { return fakeStorage({ [TOKEN_KEY]: JSON.stringify({ body: { access_token: jwt(expInSec) }, expiresAt: 0 }) }); }

// Fresh copy of the shipped bytes (or a mutation of them) in its own context.
function load(src, env) {
  var module = { exports: {} };
  var ctx = Object.assign({ module: module, console: console, setTimeout: setTimeout, atob: atob, Buffer: Buffer }, env || {});
  vm.runInNewContext(src, ctx, { filename: 'bwn-bulk-assets.user.js' });
  return module.exports;
}
function mutate(from, to) {
  if (SRC.split(from).length !== 2) throw new Error('mutation anchor not unique/absent: ' + from);
  return SRC.replace(from, function () { return to; });
}
function reply(status, body) {
  return Promise.resolve({ status: status, ok: status >= 200 && status < 300, text: function () { return Promise.resolve(body == null ? '' : JSON.stringify(body)); } });
}
function rig(handler, storage) {
  var calls = [];
  var env = {
    localStorage: storage || withToken(3600),
    fetch: function (url, init) { calls.push({ url: url, init: init, body: JSON.parse(init.body) }); return handler(calls[calls.length - 1]); }
  };
  return { M: load(SRC, env), calls: calls, env: env };
}
async function settle(p) { try { return { value: await p }; } catch (e) { return { error: e }; } }

(async function () {
  // ---- 1. Header + metadata ---------------------------------------------------------------------
  console.log('-- 1. shipped header --');
  var head = SRC.split('// ==/UserScript==')[0];
  A.ok('@grant none, no @connect', /^\/\/ @grant\s+none\s*$/m.test(head) && !/^\/\/ @connect/m.test(head));
  A.ok('@match app.umbrava.com only', (head.match(/@match/g) || []).length === 1 && /@match\s+https:\/\/app\.umbrava\.com\/\*/.test(head));
  A.ok('SheetJS 0.18.5 pinned by sha384', /@require\s+https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.full\.min\.js#sha384=[0-9a-f]{96}/.test(head));
  A.ok('in-body VER matches @version', (/@version\s+(\S+)/.exec(head) || [])[1] === (/var VER = '([^']+)'/.exec(SRC) || [])[1]);
  A.ok('createAsset is the only mutation document', (SRC.match(/'mutation \w+/g) || []).join() === "'mutation CreateAsset");
  A.ok('no .click() on anything', !/\.click\(\)/.test(SRC));

  // ---- 2. Pure helpers ----------------------------------------------------------------------------
  console.log('\n-- 2. pure helpers --');
  var M = load(SRC, { localStorage: fakeStorage() });
  var mh = M.mapHeaders(['Notes', 'S/N', 'location #', 'ASSET NAME', 'Install Date']);
  A.eq('mapHeaders matches by alias', mh.cols, { serialNumber: 1, locationNumber: 2, name: 3, installDate: 4 });
  A.eq('mapHeaders lists ignored', mh.ignored, ['Notes']);
  var bad = M.mapHeaders(['Store #', 'Location', 'Serial']);
  A.ok('mapHeaders flags duplicate + missing', JSON.stringify(bad.duplicate) === '["Location"]' && JSON.stringify(bad.missing) === '["Asset Name"]');
  A.eq('rowsFromAoa: sheet row numbers, blank rows skipped', M.rowsFromAoa([['Asset Name', 'Location #'], ['RTU', '1'], ['', ''], ['Fan', '2']]).rows.map(function (r) { return r.rowNum; }), [2, 4]);

  function localIso(y, m, d) { return new Date(y, m - 1, d).toISOString(); }
  A.eq('parseDate Excel serial', M.parseDate(43831).iso, localIso(2020, 1, 1));
  A.eq('parseDate 1904 serial', M.parseDate(43831, true).iso, localIso(2024, 1, 2));
  A.eq('parseDate MM/DD/YYYY', M.parseDate('1/15/2020').iso, localIso(2020, 1, 15));
  A.eq('parseDate ISO with time', M.parseDate('2020-01-15T22:00:00Z').iso, localIso(2020, 1, 15));
  A.eq('parseDate blank is null', M.parseDate('  '), { iso: null });
  A.ok('parseDate rejects nonsense', ['02/30/2020', '13/01/2020', 'Jan 5 2020', '15-01-2020', 0, '45123'].every(function (v) { return M.parseDate(v).bad === true; }));

  A.ok('location: "1" == PFJ 0001', M.locationMatches('1', 'PFJ 0001') && M.locationMatches(1, '0001'));
  A.ok('location: "1" != PFJ 0011 (never endsWith)', !M.locationMatches('1', 'PFJ 0011') && !M.locationMatches('11', 'PFJ 0001'));
  A.ok('location: punctuation/case ignored, otherwise exact', M.locationMatches('pfj-0001', 'PFJ 0001') && !M.locationMatches('PFJ 1', 'PFJ 0001'));

  A.eq('gqlErrText [{message}]', M.gqlErrText({ errors: [{ message: 'bad' }] }), 'bad');
  A.eq('gqlErrText ["text"]', M.gqlErrText({ errors: ['plain'] }), 'plain');
  A.eq('gqlErrText ASP.NET object', M.gqlErrText({ errors: { Name: ['required'] } }), 'Name: required');
  A.eq('gqlErrText empty message -> code', M.gqlErrText({ errors: [{ message: '', extensions: { code: 'BAD_USER_INPUT', stacktrace: ['x'] } }] }), 'BAD_USER_INPUT');
  A.ok('clientIdFromPath', M.clientIdFromPath('/clients/abc-1/locations') === 'abc-1' && M.clientIdFromPath('/work-orders/1') === null);
  A.eq('template: headers + one EXAMPLE row', M.templateAoa().map(function (r) { return r.length; }), [16, 16]);

  // ---- 3. validateRows against a fake API ---------------------------------------------------------
  console.log('\n-- 3. validateRows (read-only) --');
  var LOCS = [
    { id: 'L1', locationNumber: 'PFJ 0001', name: 'Knoxville' }, { id: 'L2', locationNumber: 'PFJ 0002', name: 'Dallas' },
    { id: 'L3', locationNumber: '0012', name: 'A' }, { id: 'L4', locationNumber: 'PFJ-12', name: 'B' }];
  var ASSETS = { L1: [{ id: 'A1', name: 'RTU-1', serialNumber: 'SER-100', tagId: 'TAG-1' }, { id: 'A2', name: 'Walk-in Cooler', serialNumber: 'N/A', tagId: '' }] };
  function fakeApi(log) {
    return {
      listClientLocations: async function (c, openOnly) { log.push('list:' + c + ':' + openOnly); return LOCS; },
      listTrades: async function () { return [{ id: 'T1', name: 'HVAC' }]; },
      listAssetTypes: async function () { return []; },
      listLocationAssets: async function (id) { log.push('assets:' + id); return ASSETS[id] || []; },
      createAsset: async function () { log.push('WRITE'); throw new Error('validation must not write'); }
    };
  }
  function rw(n, raw, extra) { return Object.assign({ rowNum: n, raw: raw }, extra || {}); }
  var ROWS = [
    rw(2, { locationNumber: 'PFJ 0001', name: 'RTU-9', serialNumber: 'SER-999', trade: 'hvac', installDate: '01/15/2020' }),
    rw(3, { locationNumber: 'pfj-0001', name: 'RTU-1 again', serialNumber: 'ser100' }),
    rw(4, { locationNumber: '2', name: 'Ice machine' }),
    rw(5, { locationNumber: 1, name: 'RTU-9 copy', serialNumber: 'SER 999' }),
    rw(6, { locationNumber: '12', name: 'Ambiguous' }),
    rw(7, { locationNumber: 'ZZZ 9', name: 'Nowhere' }),
    rw(8, { locationNumber: 'PFJ 0001', name: 'walk-in  cooler', serialNumber: 'N/A' }),
    rw(9, { locationNumber: 'PFJ 0001', name: 'Fan', trade: 'Electric', installDate: '02/30/2020' }),
    rw(10, { locationNumber: '', name: '' }),
    rw(11, { locationNumber: 'PFJ 0002', name: 'Made earlier' }, { created: true, assetId: 'NEW1' }),
    rw(12, { locationNumber: 'PFJ 0001', name: 'Typed', assetType: 'Rooftop' }),
    rw(13, { locationNumber: 'PFJ 0001', name: 'Tagged', tagId: 'tag 1' }),
    rw(14, { locationNumber: 'PFJ 0002', name: 'Made, no id back' }, { created: true, assetId: '' })
  ];
  async function validated(mod) {
    var log = [];
    var res = await mod.validateRows(ROWS, { api: fakeApi(log), clientId: 'C1', openOnly: true, sleep: function () { } });
    var by = {};
    res.rows.forEach(function (r) { by[r.rowNum] = r; });
    return { by: by, log: log };
  }
  var V = await validated(M), out = V.by;
  A.ok('validation never writes', V.log.indexOf('WRITE') === -1);
  A.ok('client location list loaded once (open only), no per-row search', V.log.filter(function (x) { return /^list:/.test(x); }).join() === 'list:C1:true');
  A.eq('ready row carries the exact CreateAssetInput', out[2].input, {
    name: 'RTU-9', manufacturer: null, manufactureDate: null, orderDate: null, installDate: localIso(2020, 1, 15),
    modelNumber: null, serialNumber: 'SER-999', manufacturerWarrantyEnd: null, materialWarrantyEnd: null, laborWarrantyEnd: null,
    locationId: 'L1', tagLocation: null, assetTypeId: null, PhysicalLocation: null, tradeId: 'T1', tagId: null });
  A.ok('digits-only location resolves', out[4].status === 'ready' && out[4].input.locationId === 'L2');
  A.ok('exists by serial', out[3].status === 'exists' && /serial match/.test(out[3].note));
  A.ok('exists by tag', out[13].status === 'exists' && /tag match/.test(out[13].note));
  A.ok('exists by name when serial is a placeholder', out[8].status === 'exists' && /name match/.test(out[8].note));
  A.ok('in-file duplicate across location # formats', out[5].status === 'error' && /Duplicate of row 2/.test(out[5].issues.join()));
  A.ok('ambiguous location', /Ambiguous location: 2 match "12"/.test(out[6].issues.join()));
  A.ok('location not found (open only)', /not found among open locations/.test(out[7].issues.join()));
  A.ok('unknown trade + bad date', /Unknown Trade "Electric"/.test(out[9].issues.join('|')) && /Bad Install Date: "02\/30\/2020"/.test(out[9].issues.join('|')));
  A.ok('unknown asset type', /Unknown Asset Type "Rooftop"/.test(out[12].issues.join('|')));
  A.eq('missing required', out[10].issues, ['Missing Location #', 'Missing Asset Name']);
  A.ok('created earlier stays created (even with no id back)', out[11].status === 'created' && out[11].assetId === 'NEW1' && out[14].status === 'created');

  // 0.1.2: what the live Pilot run taught - Umbrava refuses a repeated asset NAME at one store and a
  // Tag ID over 50 characters. Both must be row errors at Validate, before anything is sent.
  var NAME_ROWS = [
    rw(2, { locationNumber: 'PFJ 0001', name: 'Washer', serialNumber: 'S-1' }),
    rw(3, { locationNumber: 'PFJ 0001', name: 'washer', serialNumber: 'S-2' }),
    rw(4, { locationNumber: 'PFJ 0002', name: 'Washer', serialNumber: 'S-3' }),
    rw(5, { locationNumber: 'PFJ 0001', name: 'RTU-1', serialNumber: 'S-4' }),
    rw(6, { locationNumber: 'PFJ 0001', name: 'Long tag', serialNumber: 'S-5', tagId: new Array(52).join('T') }),
    rw(7, { locationNumber: 'PFJ 0001', name: new Array(102).join('N'), serialNumber: 'S-6' }),
    rw(8, { locationNumber: 'PFJ 0001', name: 'Fifty tag', serialNumber: 'S-7', tagId: new Array(51).join('T') })
  ];
  async function nameCheck(mod) {
    var res = await mod.validateRows(NAME_ROWS, { api: fakeApi([]), clientId: 'C1', openOnly: true, sleep: function () { } });
    var by = {}; res.rows.forEach(function (r) { by[r.rowNum] = r; }); return by;
  }
  var N = await nameCheck(M);
  A.ok('a name repeated at the same store (any case) is an error naming the first row', N[2].status === 'ready' && N[3].status === 'error' && /also used by row 2/.test(N[3].issues.join()));
  A.ok('the same name at a different store is fine', N[4].status === 'ready');
  A.ok('a name already on an existing asset at the store (different serial) is an error', N[5].status === 'error' && /already used at this store by an existing asset \(serial SER-100\)/.test(N[5].issues.join()));
  A.ok('Tag ID over 50 characters is an error; exactly 50 is fine', /Tag ID is 51 characters - Umbrava allows 50/.test(N[6].issues.join()) && N[8].status === 'ready');
  A.ok('Asset Name over 100 characters is an error', /Asset Name is 101 characters - Umbrava allows 100/.test(N[7].issues.join()));

  // ---- 4. Transport + the one write ---------------------------------------------------------------
  console.log('\n-- 4. transport + createAsset --');
  var INPUT = out[2].input;
  var ok = rig(function () { return reply(200, { data: { createAsset: { success: true, message: null, asset: { id: 'NEW-9', name: 'RTU-9' } } } }); });
  var r1 = await settle(ok.M.umbravaApi.createAsset(INPUT));
  var sent = ok.calls[0];
  A.ok('create resolves the envelope', r1.value && r1.value.asset && r1.value.asset.id === 'NEW-9');
  A.ok('create sends CreateAsset with newAssetData + bearer', sent && sent.body.operationName === 'CreateAsset' && sent.body.variables.newAssetData.name === 'RTU-9' &&
    /^Bearer \S+/.test(sent.init.headers.Authorization) && sent.url === '/api/graphql');
  var ring = JSON.parse(ok.env.localStorage.getItem('bwn:audit') || '[]');
  A.ok('one audit entry, outcome ok, PII-free (no variables, no asset name)', ring.length === 1 && ring[0].op === 'createAsset' && ring[0].outcome === 'ok' &&
    JSON.stringify(ring[0]).indexOf('RTU-9') === -1 && ring[0].ids.locationId === 'L1');

  var refused = rig(function () { return reply(200, { data: { createAsset: { success: false, message: 'Name rejected', asset: null } } }); });
  var r2 = await settle(refused.M.umbravaApi.createAsset(INPUT));
  A.ok('success:false = row failure with the message, not a halt', r2.error && r2.error.message === 'Name rejected' && !r2.error.baHalt);

  var badInput = rig(function () { return reply(400, { errors: [{ message: '', extensions: { code: 'BAD_USER_INPUT' } }] }); });
  var r3 = await settle(badInput.M.umbravaApi.createAsset(INPUT));
  A.ok('400 BAD_USER_INPUT with empty message = row failure naming the code', r3.error && /BAD_USER_INPUT/.test(r3.error.message) && !r3.error.baHalt);

  async function haltKind(status, body, storage) {
    var t = rig(function () { return status === 'throw' ? Promise.reject(new TypeError('Failed to fetch')) : reply(status, body); }, storage);
    var r = await settle(t.M.umbravaApi.createAsset(INPUT));
    return { kind: r.error && r.error.baHalt, calls: t.calls.length };
  }
  A.eq('401 halts (auth)', (await haltKind(401)).kind, 'auth');
  A.eq('403 halts (auth)', (await haltKind(403)).kind, 'auth');
  A.eq('UNAUTHENTICATED as HTTP 500 halts as auth, not server error', (await haltKind(500, { errors: [{ message: 'x', extensions: { code: 'UNAUTHENTICATED' } }] })).kind, 'auth');
  A.eq('429 halts (rate)', (await haltKind(429)).kind, 'rate');
  A.eq('network failure on a write halts (network = maybe landed)', (await haltKind('throw')).kind, 'network');
  A.eq('5xx on a write halts (network = maybe landed)', (await haltKind(502)).kind, 'network');
  var exp = await haltKind(200, {}, withToken(30));
  A.ok('token within 2 min of expiry halts BEFORE sending', exp.kind === 'auth' && exp.calls === 0);
  var none = await haltKind(200, {}, fakeStorage());
  A.ok('no session halts before sending', none.kind === 'auth' && none.calls === 0);

  var killStore = withToken(3600); killStore.setItem('bwn:modules', JSON.stringify({ bulkAssets: false }));
  var killed = rig(function () { return reply(200, { data: { createAsset: { success: true } } }); }, killStore);
  var r4 = await settle(killed.M.umbravaApi.createAsset(INPUT));
  A.ok('bwn:modules.bulkAssets=false blocks the write before it is sent', r4.error && /bulkAssets" is disabled/.test(r4.error.message) && killed.calls.length === 0);
  var govStore = withToken(3600); govStore.setItem('bwn:gov', JSON.stringify({ flags: { globalKillSwitch: true } }));
  var gov = rig(function () { return reply(200, { data: { createAsset: { success: true } } }); }, govStore);
  A.ok('central globalKillSwitch blocks the write', (await settle(gov.M.umbravaApi.createAsset(INPUT))).error && gov.calls.length === 0);

  var reads = rig(function (c) {
    if (c.body.operationName === 'PagedLocations') return reply(200, { data: { pagedLocations: { rowCount: 226, items: c.body.variables.page.skip === 0 ? new Array(200).fill(0).map(function (_, i) { return { id: 'x' + i, locationNumber: 'Z' + i }; }) : new Array(26).fill(0).map(function (_, i) { return { id: 'y' + i, locationNumber: 'Y' + i }; }) } } });
    return reply(200, { data: {} });
  });
  var pl = await reads.M.umbravaApi.listClientLocations('C1', true);
  A.ok('location list pages of 200 until rowCount, blank search, open-only filter', pl.length === 226 && reads.calls.length === 2 &&
    reads.calls[0].body.variables.search === '' && reads.calls[1].body.variables.page.skip === 200 &&
    reads.calls[0].body.variables.filters[0].searchTerm === '["Open"]' && reads.calls[0].body.variables.clientTenantProfileId === 'C1');
  var huge = rig(function () { return reply(200, { data: { pagedLocations: { rowCount: 25000, items: [{ id: 'a', locationNumber: 'A' }] } } }); });
  A.ok('a client past the list cap fails loudly instead of loading forever', /more than this tool loads/.test(((await settle(huge.M.umbravaApi.listClientLocations('C1', true))).error || {}).message || ''));

  // ---- 5. Negative controls (mutated shipped bytes; each must turn its check red) ------------------
  console.log('\n-- 5. negative controls --');
  var C1 = load(mutate('return digits !== \'\' && stripZeros(digits) === stripZeros(s);', 'return digits !== \'\' && digits.slice(-s.length) === s;'), { localStorage: fakeStorage() });
  A.ok('control: an endsWith matcher would match "1" to PFJ 0011', C1.locationMatches('1', 'PFJ 0011') === true);
  var C2 = load(mutate("    return { kind: 'name', key: nameKey(raw.name) };", "    return { kind: 'name', key: '' };"), { localStorage: fakeStorage() });
  // Since 0.1.2 the per-store name check backstops this (the row becomes an error, not a silent
  // create), so the control asserts what the fallback itself guarantees: recognition as "exists".
  A.ok('control: without the name fallback a re-run no longer recognizes a no-serial row as existing', (await validated(C2)).by[8].status !== 'exists');
  var c3store = withToken(3600); c3store.setItem('bwn:modules', JSON.stringify({ bulkAssets: false }));
  var c3calls = 0;
  var C3 = load(mutate('feature: FEATURE, confirmed: true,', 'confirmed: true,'), { localStorage: c3store, fetch: function () { c3calls++; return reply(200, { data: { createAsset: { success: true } } }); } });
  await settle(C3.umbravaApi.createAsset(INPUT));
  A.ok('control: dropping feature: from the call lets a disabled module write', c3calls === 1);
  var C4 = load(mutate("if (res.status === 429) throw haltError(", "if (false) throw haltError("), { localStorage: withToken(3600), fetch: function () { return reply(429); } });
  A.ok('control: without the 429 branch a rate limit is not a halt', !(await settle(C4.umbravaApi.createAsset(INPUT))).error.baHalt);
  var C5 = load(mutate("if (seenName[nameDup]) issues.push(", "if (false) issues.push("), { localStorage: fakeStorage() });
  A.ok('control: without the per-store name check a repeated name goes out as ready', (await nameCheck(C5))[3].status === 'ready');
  var C6 = load(mutate("['tagId', 'Tag ID', 50]", "['tagId', 'Tag ID', 500]"), { localStorage: fakeStorage() });
  A.ok('control: a loose Tag ID limit lets a 51-char tag go out as ready', (await nameCheck(C6))[6].status === 'ready');

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
