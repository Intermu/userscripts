// test-proposal-copy.js - node harness for bwn-proposal-copy's write path.
// Slices the copy-engine + auth blocks out of the REAL .user.js and runs them
// in a vm with a fake fetch + localStorage. Every mutate() must turn this red.
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-proposal-copy.js
var fs = require('fs'), path = require('path'), vm = require('vm'), A = require('./assert.js');
var SRC = path.join(__dirname, '..', 'bwn-proposal-copy.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = full.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker missing - ' + start);
  if (full.indexOf(start, a + 1) !== -1) throw new Error(what + ': START not unique');
  var b = full.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker missing after start');
  return full.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function mkJwt(p) { return 'h.' + b64url(p) + '.s'; }
var GOOD_TOKEN = mkJwt({ iss: 'https://login.umbrava.com', exp: Math.floor(Date.now()/1000) + 3600 });
var FOREIGN_TOKEN = mkJwt({ iss: 'https://example.auth0.com', exp: Math.floor(Date.now()/1000) + 3600 });

function makeLS(entries) {
  var store = Object.assign({}, entries), ls = {};
  Object.defineProperty(ls, 'getItem', { value: function (k) { return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; } });
  Object.defineProperty(ls, 'setItem', { value: function (k,v) { store[k] = String(v); } });
  Object.keys(store).forEach(function (k) { ls[k] = store[k]; });
  return ls;
}
function makeEnv(opts) {
  opts = opts || {};
  var env = { calls: [] };
  var lsEntries = {};
  if (opts.withToken !== false) lsEntries['@@auth0spajs@@::client::https://app.umbrava.com/api::openid'] = JSON.stringify({ body: { access_token: opts.foreign ? FOREIGN_TOKEN : GOOD_TOKEN } });
  if (opts.roleSlot) lsEntries['bwn:role:last'] = JSON.stringify(opts.roleSlot);
  env.localStorage = makeLS(lsEntries);
  env.fetch = function (url, init) {
    var body = init && init.body ? JSON.parse(init.body) : {};
    env.calls.push({ url: url, op: body.operationName, variables: body.variables });
    var reply = (opts.replies || {})[body.operationName];
    var data = typeof reply === 'function' ? reply(body.variables) : reply;
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data || { data: {} }); } });
  };
  env.console = console; env.Date = Date; env.JSON = JSON; env.Promise = Promise;
  env.atob = global.atob; env.btoa = global.btoa;
  env.document = { addEventListener: function () {} };
  return env;
}
// Load the auth + copy-engine blocks into one context.
var S_CORE = slice('  // ===== auth + gql', '  // ===== ui', 'core block');
function loadCore(env) {
  var ctx = vm.createContext(env);
  vm.runInContext('(function(){' + S_CORE + '\n; this.__api = { pcAuthToken: pcAuthToken, pcGql: pcGql, rank: rank, mapLineItem: mapLineItem, buildCreateVars: buildCreateVars, buildEditVars: buildEditVars, copyProposal: copyProposal, pickerFilter: pickerFilter, confirmReady: confirmReady }; }).call(globalThis);', ctx);
  return env.__api;
}

(async function () {
  // --- auth: token pick ---
  var e1 = makeEnv({}); var api1 = loadCore(e1);
  A.ok('pcAuthToken returns the umbrava-issuer token', api1.pcAuthToken() === GOOD_TOKEN);
  var e2 = makeEnv({ foreign: true }); var api2 = loadCore(e2);
  A.ok('pcAuthToken rejects a foreign-issuer token', api2.pcAuthToken() === '');
  var e3 = makeEnv({ withToken: false }); var api3 = loadCore(e3);
  A.ok('pcAuthToken returns empty when no token cached', api3.pcAuthToken() === '');

  // --- pcGql: shape + reject paths ---
  var e4 = makeEnv({ replies: { Ping: { data: { pong: 1 } } } }); var api4 = loadCore(e4);
  var d4 = await api4.pcGql('Ping', 'query Ping { pong }', { a: 1 });
  A.eq('pcGql resolves json.data', d4, { pong: 1 });
  A.eq('pcGql sends operationName+query+variables', { op: e4.calls[0].op, v: e4.calls[0].variables }, { op: 'Ping', v: { a: 1 } });
  var e5 = makeEnv({ withToken: false }); var api5 = loadCore(e5);
  var rejected = false; try { await api5.pcGql('Ping', 'query Ping { pong }', {}); } catch (err) { rejected = /token/.test(err.message); }
  A.ok('pcGql rejects with no token (never sends)', rejected && e5.calls.length === 0);
  var e6 = makeEnv({ replies: { Ping: { errors: [{ message: 'boom' }] } } }); var api6 = loadCore(e6);
  var rejected2 = false; try { await api6.pcGql('Ping', 'query Ping { pong }', {}); } catch (err) { rejected2 = /boom/.test(err.message); }
  A.ok('pcGql rejects on GraphQL errors[]', rejected2);

  // --- rank ---
  var fresh = { ok: true, rank: 4, ts: Date.now() };
  var e7 = makeEnv({ roleSlot: fresh }); var api7 = loadCore(e7);
  A.ok('rank() reads a fresh ok slot', api7.rank() === 4);
  var stale = { ok: true, rank: 4, ts: Date.now() - 7 * 3600 * 1000 };
  var e8 = makeEnv({ roleSlot: stale }); var api8 = loadCore(e8);
  A.ok('rank() ignores a stale slot -> null', api8.rank() === null);
  var e9 = makeEnv({}); var api9 = loadCore(e9);
  A.ok('rank() is null when no slot', api9.rank() === null);

  // --- mapLineItem ---
  var apiM = loadCore(makeEnv({}));
  var SRC_ITEM = {
    id: 999, category: 1, tripLabel: 'T1', quantity: 2, chargeQuantity: 2,
    unitOfMeasurement: 'EA', useMarkUpPercent: true, markUpPercent: '15.00',
    isTaxable: true, taxRate: '8.875', item: 'Widget', itemId: 42, isPrivate: false,
    sortOrder: 0, rateId: 'rate-abc', description: 'A widget', descriptionHtml: '<p>A widget</p>',
    trade: { id: 'trade-xyz' },
    unitCost: { amount: 12345, currency: 'USD', precision: 2 },
    unitCharge: { amount: 14197, currency: 'USD', precision: 2 }
  };
  var mapped = apiM.mapLineItem(SRC_ITEM);
  A.ok('mapLineItem OMITS id (new row)', !('id' in mapped) || mapped.id == null);
  A.ok('mapLineItem maps trade.id -> tradeId', mapped.tradeId === 'trade-xyz');
  A.eq('mapLineItem copies unitCost verbatim (minor units)', mapped.unitCost, { amount: 12345, currency: 'USD', precision: 2 });
  A.eq('mapLineItem copies unitCharge verbatim', mapped.unitCharge, { amount: 14197, currency: 'USD', precision: 2 });
  A.ok('mapLineItem keeps markUpPercent as a STRING', mapped.markUpPercent === '15.00');
  A.ok('mapLineItem keeps taxRate as a STRING', mapped.taxRate === '8.875');
  A.eq('mapLineItem preserves category/sortOrder/itemId/rateId', { c: mapped.category, s: mapped.sortOrder, i: mapped.itemId, r: mapped.rateId }, { c: 1, s: 0, i: 42, r: 'rate-abc' });

  // negative controls: the mapper must never re-key or rescale.
  var CORE_M = slice('  // ===== auth + gql', '  // ===== ui', 'core block');
  function loadMutant(coreSrc) {
    var env = makeEnv({}); var ctx = vm.createContext(env);
    vm.runInContext('(function(){' + coreSrc + '\n; this.__api = { mapLineItem: mapLineItem }; }).call(globalThis);', ctx);
    return env.__api;
  }
  var mutIdKept = loadMutant(mutate(CORE_M, 'delete out.id;', '/* keep id */')).mapLineItem(SRC_ITEM);
  A.ok('CONTROL: keeping id turns a new copy into an edit (red if id present)', mutIdKept.id === undefined || mutIdKept.id == null ? false : true);

  // --- buildCreateVars / buildEditVars ---
  var apiB = loadCore(makeEnv({}));
  var SOURCE = {
    id: 500, number: 7001, type: { id: 3, name: 'Repair' }, status: { id: 1, name: 'Draft' },
    scopeOfWork: 'Fix the thing', scopeOfWorkHtml: '<p>Fix the thing</p>', description: 'desc',
    disclaimer: 'std disclaimer', timeFrameDays: { value: 30 },
    formattedClientPurchaseOrderNumber: 'PO-123',
    subtotal: { amount: 50000, currency: 'USD', precision: 2 },
    proposalLineItems: [SRC_ITEM, Object.assign({}, SRC_ITEM, { sortOrder: 1, id: 1000 })]
  };
  var TARGET = { number: 8002, id: 1200500, locationId: 'loc-1', clientId: 'cli-1' };

  var cv = apiB.buildCreateVars(SOURCE, TARGET).proposalData;
  A.ok('create targets the new WO by workOrderNumber', cv.workOrderNumber === 8002);
  A.ok('create carries typeId from the SOURCE proposal', cv.typeId === 3);
  A.ok('create carries scopeOfWork verbatim', cv.scopeOfWork === 'Fix the thing');
  A.ok('create carries timeFrameDays', cv.timeFrameDays && cv.timeFrameDays.value === 30);
  A.ok('create does NOT carry line items (edit does)', !('proposalLineItems' in cv));

  var ev = apiB.buildEditVars(9003, SOURCE).proposalData;
  A.ok('edit keys off the NEW proposalId', ev.proposalId === 9003);
  A.ok('edit carries typeId', ev.typeId === 3);
  A.ok('edit carries mapped line items, count matches source', Array.isArray(ev.proposalLineItems) && ev.proposalLineItems.length === 2);
  A.ok('edit line items are mapped (no id)', ev.proposalLineItems[0].id == null && ev.proposalLineItems[1].id == null);

  // control: create must send workOrderNumber, not the source's own WO
  var CORE_B = slice('  // ===== auth + gql', '  // ===== ui', 'core block');
  function loadB(coreSrc) { var env = makeEnv({}); var ctx = vm.createContext(env); vm.runInContext('(function(){' + coreSrc + '\n; this.__api = { buildCreateVars: buildCreateVars, mapLineItem: mapLineItem }; }).call(globalThis);', ctx); return env.__api; }
  var mutTarget = loadB(mutate(CORE_B, 'workOrderNumber: target.number', 'workOrderNumber: source.number')).buildCreateVars(SOURCE, TARGET).proposalData;
  A.ok('CONTROL: mis-targeting to source.number is observable', mutTarget.workOrderNumber === 7001);

  // --- copyProposal orchestration ---
  function detailsReply(vars) {
    // ClientProposalDetails(proposalId) -> the source on read, the new draft on read-back
    if (vars.proposalId === 500) return { data: { proposal: SOURCE } };
    if (vars.proposalId === 9003) return { data: { proposal: Object.assign({}, SOURCE, { id: 9003, proposalLineItems: SOURCE.proposalLineItems }) } };
    return { data: { proposal: null } };
  }
  function baseReplies(extra) {
    return Object.assign({
      ClientProposalDetails: detailsReply,
      ProposalWO: function () { return { data: { job: TARGET } }; },
      CreateDraftProposal: function () { return { data: { createDraftProposal: { success: true, message: '', proposal: { id: 9003, number: 8002 } } } }; },
      EditProposal: function () { return { data: { editProposal: { success: true, message: '', proposal: { id: 9003, number: 8002 } } } }; }
    }, extra || {});
  }
  // happy path
  var eH = makeEnv({ replies: baseReplies() }); var apiH = loadCore(eH);
  var rH = await apiH.copyProposal(500, 8002, { dryRun: false });
  A.ok('happy: ok true', rH.ok === true);
  A.ok('happy: returns the new proposal id', rH.newProposalId === 9003);
  var ops = eH.calls.map(function (c) { return c.op; });
  A.ok('happy: creates THEN edits', ops.indexOf('CreateDraftProposal') !== -1 && ops.indexOf('CreateDraftProposal') < ops.indexOf('EditProposal'));
  A.ok('happy: edit was sent with the new proposalId', eH.calls.filter(function (c) { return c.op === 'EditProposal'; })[0].variables.proposalData.proposalId === 9003);
  A.ok('happy: read-back matched', rH.readBack && rH.readBack.match === true);

  // dry-run sends ZERO writes
  var eD = makeEnv({ replies: baseReplies() }); var apiD = loadCore(eD);
  var rD = await apiD.copyProposal(500, 8002, { dryRun: true });
  var writeCalls = eD.calls.filter(function (c) { return c.op === 'CreateDraftProposal' || c.op === 'EditProposal'; });
  A.ok('dry-run: no write mutation sent', writeCalls.length === 0);
  A.ok('dry-run: still returns assembled create+edit', rD.dryRun === true && rD.create && rD.edit);

  // null source = failure, no write
  var eN = makeEnv({ replies: baseReplies({ ClientProposalDetails: function () { return { data: { proposal: null } }; } }) }); var apiN = loadCore(eN);
  var rN = await apiN.copyProposal(500, 8002, { dryRun: false });
  A.ok('null source -> ok false at stage read', rN.ok === false && rN.stage === 'read-source');
  A.ok('null source -> no write attempted', eN.calls.filter(function (c) { return c.op === 'CreateDraftProposal'; }).length === 0);

  // create fails -> stop, no edit
  var eF = makeEnv({ replies: baseReplies({ CreateDraftProposal: function () { return { data: { createDraftProposal: { success: false, message: 'denied' } } }; } }) }); var apiF = loadCore(eF);
  var rF = await apiF.copyProposal(500, 8002, { dryRun: false });
  A.ok('create fail -> ok false at stage create', rF.ok === false && rF.stage === 'create');
  A.ok('create fail -> edit NOT sent', eF.calls.filter(function (c) { return c.op === 'EditProposal'; }).length === 0);

  // read-back mismatch -> ok true but match false (warning)
  var eW = makeEnv({ replies: baseReplies({ ClientProposalDetails: function (vars) { if (vars.proposalId === 9003) return { data: { proposal: Object.assign({}, SOURCE, { proposalLineItems: [SRC_ITEM] }) } }; return detailsReply(vars); } }) }); var apiW = loadCore(eW);
  var rW = await apiW.copyProposal(500, 8002, { dryRun: false });
  A.ok('read-back mismatch -> ok true, match false (warning)', rW.ok === true && rW.readBack.match === false);

  // --- pure UI helpers ---
  var apiU = loadCore(makeEnv({}));
  var OPEN_WOS = [
    { id: 1, number: 8002, statusName: 'Open', locationId: 'loc-1' },
    { id: 2, number: 7001, statusName: 'Open', locationId: 'loc-1' }, // the source WO - excluded
    { id: 3, number: 8003, statusName: 'Open', locationId: 'loc-1' }
  ];
  var filtered = apiU.pickerFilter(OPEN_WOS, 'loc-1', 7001);
  A.ok('pickerFilter drops the source WO', filtered.every(function (w) { return w.number !== 7001; }));
  A.ok('pickerFilter keeps the other same-location WOs', filtered.length === 2);

  A.ok('confirmReady false when no target', apiU.confirmReady({ hasToken: true, source: SOURCE, target: null }) === false);
  A.ok('confirmReady false when source empty', apiU.confirmReady({ hasToken: true, source: { proposalLineItems: [] }, target: TARGET }) === false);
  A.ok('confirmReady false when no token', apiU.confirmReady({ hasToken: false, source: SOURCE, target: TARGET }) === false);
  A.ok('confirmReady true when all present', apiU.confirmReady({ hasToken: true, source: SOURCE, target: TARGET }) === true);

  A.finish();
})();
