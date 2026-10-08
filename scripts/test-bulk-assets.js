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
  A.ok('CreateAsset + EditAsset are the only mutation documents', (SRC.match(/'mutation \w+/g) || []).join() === "'mutation CreateAsset,'mutation EditAsset");
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
  // 0.1.3: Pilot's 896 locations share one name, so a Name sort reorders between pages. A fake that
  // serves overlapping pages (each page repeats the previous page's tail) must still lose nothing,
  // and a server that can never return every id must be a loud error, not a short list.
  function overlapRig(total, lose) {
    return rig(function (c) {
      var v = c.body.variables, skip = v.page.skip, take = v.page.take, op = c.body.operationName;
      var start = Math.max(0, skip - 30); // each page repeats the previous page's last 30
      var ids = [];
      for (var i = start; i < Math.min(total, skip + take); i++) ids.push(i);
      if (skip === 0) ids = ids.concat([0, 1, 2]);
      var rows = ids.filter(function (i) { return !lose || i % 50 !== 7; }).map(function (i) { return { id: 'L' + i, locationNumber: 'PFJ ' + i, name: 'Pilot Travel Center' }; });
      if (op === 'PagedLocations') return reply(200, { data: { pagedLocations: { rowCount: total, items: rows } } });
      return reply(200, { data: { listAssets: { rowCount: total, items: rows } } });
    });
  }
  var ov = overlapRig(450, false);
  var ovl = await ov.M.umbravaApi.listClientLocations('C1', false);
  A.ok('overlapping pages: every location exactly once, sorted by Id', ovl.length === 450 &&
    new Set(ovl.map(function (l) { return l.id; })).size === 450 && ov.calls.length === 3 &&
    ov.calls.every(function (c) { return JSON.stringify(c.body.variables.sortBy) === '[{"columnName":"Id","direction":"ASC"}]'; }));
  var ova = overlapRig(1200, false);
  A.ok('overlapping asset pages: every asset exactly once, sorted by Id', (await ova.M.umbravaApi.listLocationAssets('L1')).length === 1200 &&
    ova.calls.every(function (c) { return c.body.variables.sortBy.columnName === 'Id'; }));
  var gap = await settle(overlapRig(450, true).M.umbravaApi.listClientLocations('C1', false));
  A.ok('pages that never return some ids fail loudly naming both counts', gap.error && /reported 450 locations but paging returned 441 distinct/.test(gap.error.message));
  var agap = await settle(overlapRig(450, true).M.umbravaApi.listLocationAssets('L1'));
  A.ok('the same guard covers the asset list', agap.error && /reported 450 assets at this location/.test(agap.error.message));

  var huge = rig(function () { return reply(200, { data: { pagedLocations: { rowCount: 25000, items: [{ id: 'a', locationNumber: 'A' }] } } }); });
  A.ok('a client past the list cap fails loudly instead of loading forever', /more than this tool loads/.test(((await settle(huge.M.umbravaApi.listClientLocations('C1', true))).error || {}).message || ''));

  // ---- 4b. Rename by Tag ID (0.2.0) ----------------------------------------------------------------
  console.log('\n-- 4b. rename by Tag ID --');
  var rh = M.mapHeaders(['Location #', 'Tag ID', 'Current Name', 'New Name', 'Check']);
  A.ok('a "New Name" column switches to rename mode; Asset Name is not required there', rh.mode === 'rename' && rh.missing.length === 0);
  A.eq('rename mode needs Location #, Tag ID and New Name', M.mapHeaders(['New Name']).missing, ['Location #', 'Tag ID']);
  A.ok('a file without New Name stays in create mode', M.mapHeaders(['Location #', 'Asset Name']).mode === 'create');

  var RLOCS = [{ id: 'L1', locationNumber: 'PFJ 0001', name: 'Knoxville' }, { id: 'L2', locationNumber: 'PFJ 0002', name: 'Dallas' }];
  var RASSETS = { L1: [
    { id: 'S1', name: '001 High-Rise', tagId: 'G077' }, { id: 'S2', name: '001 Mid-Rise', tagId: 'G078' },
    { id: 'S3', name: 'High Rise - G079', tagId: 'G079' }, { id: 'S4', name: 'Dup A', tagId: 'X1' }, { id: 'S5', name: 'Dup B', tagId: 'x1' },
    { id: 'S6', name: 'Taken Name', tagId: 'G080' }, { id: 'S7', name: '001 Billboard', tagId: 'G081' }, { id: 'S8', name: '001 Sign', tagId: 'G082' }] };
  function renameApi(log) {
    return {
      listClientLocations: async function () { return RLOCS; },
      listLocationAssets: async function (id) { log.push('assets:' + id); return RASSETS[id] || []; },
      editAsset: async function () { log.push('WRITE'); throw new Error('validation must not write'); }
    };
  }
  var RROWS = [
    rw(2, { locationNumber: 'PFJ 0001', tagId: 'G077', currentName: '001 High-Rise', newName: 'High Rise - G077' }),
    rw(3, { locationNumber: 'PFJ 0001', tagId: 'g078', newName: 'Mid Rise - G078' }),
    rw(4, { locationNumber: 'PFJ 0001', tagId: 'G079', newName: 'High Rise - G079' }),
    rw(5, { locationNumber: 'PFJ 0001', tagId: 'NOPE', newName: 'Ghost' }),
    rw(6, { locationNumber: 'PFJ 0001', tagId: 'X1', newName: 'Either' }),
    rw(7, { locationNumber: 'PFJ 0001', tagId: 'G081', currentName: '001 Monument', newName: 'Billboard - G081' }),
    rw(8, { locationNumber: 'PFJ 0001', tagId: 'G077', newName: 'Again' }),
    rw(9, { locationNumber: 'PFJ 0001', tagId: 'G082', newName: 'taken name' }),
    rw(10, { locationNumber: 'PFJ 0009', tagId: 'G1', newName: 'Nowhere' }),
    rw(11, { locationNumber: 'PFJ 0001', tagId: '', newName: '' }),
    rw(12, { locationNumber: 'PFJ 0001', tagId: 'G080', newName: new Array(102).join('N') }),
    rw(13, { locationNumber: 'PFJ 0001', tagId: 'G078', newName: 'Mid Rise - G078' }, { renamed: true })
  ];
  async function renamed(mod) {
    var log = [];
    var res = await mod.validateRenames(RROWS, { api: renameApi(log), clientId: 'C1', openOnly: true, sleep: function () { } });
    var by = {}; res.rows.forEach(function (r) { by[r.rowNum] = r; });
    return { by: by, log: log, mode: res.mode };
  }
  var RV = await renamed(M), ro = RV.by;
  A.ok('rename validation never writes and reads each store once', RV.log.indexOf('WRITE') === -1 && RV.log.join() === 'assets:L1' && RV.mode === 'rename');
  A.ok('ready row carries the asset id, current and new name', ro[2].status === 'ready' && ro[2].assetId === 'S1' && ro[2].currentName === '001 High-Rise' && ro[2].newName === 'High Rise - G077');
  A.ok('Tag ID matches ignoring case/punctuation; Current Name column is optional', ro[3].status === 'ready' && ro[3].assetId === 'S2');
  A.ok('already carrying the new name = exists, not re-sent', ro[4].status === 'exists' && /Already named/.test(ro[4].note));
  A.ok('no asset with that tag at the store', ro[5].status === 'error' && /No asset with Tag ID "NOPE"/.test(ro[5].issues.join()));
  A.ok('two assets sharing a tag are never guessed between', ro[6].status === 'error' && /2 assets share Tag ID/.test(ro[6].issues.join()));
  A.ok('a stale Current Name is an error naming what Umbrava has', ro[7].status === 'error' && /Name in Umbrava is now "001 Billboard", not "001 Monument"/.test(ro[7].issues.join()));
  A.ok('the same asset twice in the file', ro[8].status === 'error' && /Same asset as row 2/.test(ro[8].issues.join()));
  A.ok('a new name already on another asset at the store (any case)', ro[9].status === 'error' && /already used at this store by another asset \(Tag ID G080\)/.test(ro[9].issues.join()));
  A.ok('unknown store', /not found among open locations/.test(ro[10].issues.join()));
  A.eq('missing tag + new name', ro[11].issues, ['Missing Tag ID', 'Missing New Name']);
  A.ok('New Name over 100 characters', /New Name is 101 characters - Umbrava allows 100/.test(ro[12].issues.join()));
  A.ok('renamed earlier this session stays renamed', ro[13].status === 'renamed');

  // The record as AssetDetails returns it (live shape 2026-10-08: Money objects with __typename,
  // a 04:00 install time, nulls in money fields).
  var REC = { __typename: 'Asset', id: 'S1', locationId: 'L1', name: '001 High-Rise', tagId: 'G077', isActive: true, modelNumber: '', usefulLife: null,
    physicalLocation: '6158 US 223', serialNumber: '', manufacturer: 'Sunshine', tagLocation: '', replacementThreshold: null, owner: '',
    warrantyInstructions: '', purchasePrice: { __typename: 'Money', amount: 0, currency: 'USD', precision: 2 }, bookValue: null,
    replacementCost: null, maintenanceCost: null, repairCost: null, trade: { __typename: 'TradeV2', id: 'T9', name: 'Signage' }, assetTypeId: null,
    orderDate: null, installDate: '2015-10-05T04:00:00', manufactureDate: null, manufacturerWarrantyEnd: '2022-10-05T00:00:00',
    materialWarrantyEnd: '2022-10-05T00:00:00', laborWarrantyEnd: '2022-10-05T00:00:00' };
  var EI = M.toEditInput(REC);
  A.eq('toEditInput sends all 27 EditAssetInput keys', Object.keys(EI).length, 27);
  A.ok('toEditInput: tradeId from trade.id, Money without __typename, nothing extra', EI.tradeId === 'T9' && JSON.stringify(EI.purchasePrice) === '{"amount":0,"currency":"USD","precision":2}' &&
    !('trade' in EI) && JSON.stringify(EI).indexOf('__typename') === -1 && EI.physicalLocation === '6158 US 223');
  var SAVED = JSON.parse(JSON.stringify(REC)); SAVED.name = 'High Rise - G077'; SAVED.installDate = '2015-10-05T00:00:00';
  SAVED.bookValue = { amount: 0, currency: 'USD', precision: 2 }; SAVED.repairCost = { amount: 0, currency: 'USD', precision: 2 };
  A.eq('editDrift: Umbrava\'s own save normalization (null->$0, 04:00->midnight same day) is not drift', M.editDrift(REC, SAVED, 'High Rise - G077'), []);
  var BLANKED = JSON.parse(JSON.stringify(SAVED)); BLANKED.manufacturer = ''; BLANKED.installDate = '2015-10-06T00:00:00'; BLANKED.trade = null;
  A.eq('editDrift flags a blanked field, a moved date and a dropped trade', M.editDrift(REC, BLANKED, 'High Rise - G077'), ['manufacturer', 'tradeId', 'installDate']);
  A.eq('editDrift flags a name that did not take', M.editDrift(REC, REC, 'High Rise - G077'), ['name']);

  function rowApi(after, log) {
    var reads = 0;
    return {
      getAsset: async function () { reads++; log.push('read'); return reads === 1 ? JSON.parse(JSON.stringify(REC)) : after; },
      editAsset: async function (input) { log.push('edit:' + JSON.stringify(input)); return { success: true }; }
    };
  }
  var RR = { assetId: 'S1', currentName: '001 High-Rise', newName: 'High Rise - G077' };
  var rlog = [];
  var rr = await settle(M.renameRow(RR, rowApi(SAVED, rlog)));
  var sentEdit = JSON.parse((rlog.filter(function (x) { return /^edit:/.test(x); })[0] || 'edit:{}').slice(5));
  A.ok('renameRow: read, edit, re-read; only the name differs in what is sent', rr.value === null && rlog.join().replace(/edit:.*?(,read)/, 'edit$1') === 'read,edit,read' &&
    sentEdit.name === 'High Rise - G077' && JSON.stringify(Object.assign({}, sentEdit, { name: REC.name })) === JSON.stringify(M.toEditInput(REC)));
  A.eq('renameRow returns the drift when another field moved', (await M.renameRow(RR, rowApi(BLANKED, []))), ['manufacturer', 'tradeId', 'installDate']);
  var stale = []; var rs = await settle(M.renameRow({ assetId: 'S1', currentName: 'Something else', newName: 'X' }, rowApi(SAVED, stale)));
  A.ok('renameRow refuses (no write) when the name changed since Validate', rs.error && /Name changed since Validate/.test(rs.error.message) && stale.join() === 'read');

  var eok = rig(function (c) { return reply(200, { data: { editAsset: { success: true, message: null, asset: { id: 'S1', name: 'High Rise - G077' } } } }); });
  var e1 = await settle(eok.M.umbravaApi.editAsset(EI));
  A.ok('editAsset sends EditAsset with assetData through bwnGqlOp', e1.value && e1.value.success === true && eok.calls[0].body.operationName === 'EditAsset' &&
    eok.calls[0].body.variables.assetData.id === 'S1');
  var ering = JSON.parse(eok.env.localStorage.getItem('bwn:audit') || '[]');
  A.ok('editAsset audit entry is PII-free (ids only, no names or address)', ering.length === 1 && ering[0].op === 'editAsset' && ering[0].ids.assetId === 'S1' &&
    JSON.stringify(ering[0]).indexOf('High-Rise') === -1 && JSON.stringify(ering[0]).indexOf('6158') === -1);
  var eref = rig(function () { return reply(200, { data: { editAsset: { success: false, message: 'Asset name already in use', asset: null } } }); });
  A.ok('editAsset success:false is a row failure, not a halt', ((await settle(eref.M.umbravaApi.editAsset(EI))).error || {}).message === 'Asset name already in use');
  var ekill = withToken(3600); ekill.setItem('bwn:modules', JSON.stringify({ bulkAssets: false }));
  var ek = rig(function () { return reply(200, { data: { editAsset: { success: true } } }); }, ekill);
  A.ok('the bulkAssets kill switch blocks renames too', (await settle(ek.M.umbravaApi.editAsset(EI))).error && ek.calls.length === 0);

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
  var C3 = load(mutate('feature: FEATURE, confirmed: true, ids: { locationId: input.locationId }', 'confirmed: true, ids: { locationId: input.locationId }'), { localStorage: c3store, fetch: function () { c3calls++; return reply(200, { data: { createAsset: { success: true } } }); } });
  await settle(C3.umbravaApi.createAsset(INPUT));
  A.ok('control: dropping feature: from the call lets a disabled module write', c3calls === 1);
  var C4 = load(mutate("if (res.status === 429) throw haltError(", "if (false) throw haltError("), { localStorage: withToken(3600), fetch: function () { return reply(429); } });
  A.ok('control: without the 429 branch a rate limit is not a halt', !(await settle(C4.umbravaApi.createAsset(INPUT))).error.baHalt);
  var C5 = load(mutate("if (seenName[nameDup]) issues.push(", "if (false) issues.push("), { localStorage: fakeStorage() });
  A.ok('control: without the per-store name check a repeated name goes out as ready', (await nameCheck(C5))[3].status === 'ready');
  var C6 = load(mutate("['tagId', 'Tag ID', 50]", "['tagId', 'Tag ID', 500]"), { localStorage: fakeStorage() });
  A.ok('control: a loose Tag ID limit lets a 51-char tag go out as ready', (await nameCheck(C6))[6].status === 'ready');

  var C7 = load(mutate("got.forEach(function (x) { if (!byId[x.id]) { byId[x.id] = 1; items.push(x); } });", "items = items.concat(got);"), { localStorage: withToken(3600), fetch: overlapRig(450, false).env.fetch });
  var c7 = await settle(C7.umbravaApi.listClientLocations('C1', false));
  A.ok('control: without the id dedupe overlapping pages fail the rowCount check (not a silent pass)', !!c7.error);
  var C8 = load(mutate("    if (items.length !== rowCount) {", "    if (false) {"), { localStorage: withToken(3600), fetch: overlapRig(450, true).env.fetch });
  var c8 = await settle(C8.umbravaApi.listClientLocations('C1', false));
  A.ok('control: without the rowCount assert a short list goes back as if complete', c8.value && c8.value.length === 441);

  var C9 = load(mutate("else if (DATE_KEYS.indexOf(k) !== -1) same = String(x || '').slice(0, 10) === String(y || '').slice(0, 10);", ''), { localStorage: fakeStorage() });
  A.ok('control: comparing dates exactly would halt on Umbrava\'s own 04:00->midnight save', C9.editDrift(REC, SAVED, 'High Rise - G077').indexOf('installDate') !== -1);
  var C10 = load(mutate("      if (v === undefined) v = null;\n", "      if (v === undefined) v = null;\n      if (k === 'physicalLocation') return;\n"), { localStorage: fakeStorage() });
  A.ok('control: an input missing a key is caught by the 27-key check', Object.keys(C10.toEditInput(REC)).length !== 27);
  var C11 = load(mutate("    if (!before || cellText(before.name) !== r.currentName) {", "    if (!before) {"), { localStorage: fakeStorage() });
  var c11log = []; await settle(C11.renameRow({ assetId: 'S1', currentName: 'Something else', newName: 'X' }, rowApi(SAVED, c11log)));
  A.ok('control: without the re-check a stale row would be written', c11log.some(function (x) { return /^edit:/.test(x); }));
  var C12 = load(mutate("        if (other) issues.push(", "        if (false) issues.push("), { localStorage: fakeStorage() });
  A.ok('control: without the store-name check a taken name goes out as ready', (await renamed(C12)).by[9].status === 'ready');

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
