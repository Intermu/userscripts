// test-pa-live-resolve.js - RM-A3 / R3: de-hardcode STATUS_FALLBACK + RONNY_GUID in bwn-proposal-actions.
//
// THE FINDING (roadmap R3): a status write used a hardcoded STATUS_FALLBACK status-id map, and the TSP
// action assigned the created task to a hardcoded RONNY_GUID. If the tenant reconfigures a status id,
// or Ronny leaves / his user id changes, the hardcoded value silently MISROUTES a live write - a wrong
// status set, or a task filed on a user id that no longer exists.
//
// WHAT THIS PROVES, against the REAL shipped bytes (the PA-RESOLVE slice is cut out of
// bwn-proposal-actions.user.js and run in a vm with an injected paGql / STATUS_FALLBACK / RONNY_GUID):
//   - readStatusId resolves a status NAME to the LIVE tenant id; a name that is NOT in the live
//     workOrderStatuses (or a failed read) FAILS CLOSED to null - never a stale fallback id - unless
//     the rollback flag (bwn:modules.paLegacyFallback) is set, which reinstates STATUS_FALLBACK.
//   - resolveTspAssignee VERIFIES the seed RONNY_GUID resolves to a live user named "Ronny Sharp";
//     a stale/mismatched/absent user FAILS CLOSED to null (so the TSP action aborts), unless the
//     rollback flag reinstates the seed.
//   - the setStatus write-chokepoint guard (a null/NaN id is refused) is proven in test-proposal-actions.js.
//
// Each negative control mutates the SAME source and MUST turn a check red; mutate() throws if its
// target is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-pa-live-resolve.js
// CI runs: node scripts/test-pa-live-resolve.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-proposal-actions.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var START = '// ===== PA-RESOLVE-SLICE-START';
var END = '// ===== PA-RESOLVE-SLICE-END';
function slice(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error('START marker not found - the PA-RESOLVE slice is gone from bwn-proposal-actions.user.js');
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

var RG = 'ff655968-a371-43b9-a199-e66847a54a2a';
function load(engineSrc, opts) {
  opts = opts || {};
  var store = Object.create(null);
  if (opts.legacy) store['bwn:modules'] = JSON.stringify({ paLegacyFallback: true });
  var sandbox = {
    console: console, JSON: JSON, Promise: Promise, Error: Error, String: String, Number: Number, Date: Date, Object: Object, Array: Array,
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    STATUS_FALLBACK: { 'Internal Proposal Approved': 51, 'Pending Trade Specialist': 232, 'Internal Proposal Rejected': 52 },
    RONNY_GUID: RG,
    paGql: opts.gql || function () { return Promise.resolve({}); }
  };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox);
  return { readStatusId: sandbox.readStatusId, resolveTspAssignee: sandbox.resolveTspAssignee };
}

// programmable paGql: statuses list for workOrderStatuses; user object for user(id:)
function gqlWith(statuses, user, opts) {
  opts = opts || {};
  return function (op, query, variables) {
    if (/workOrderStatuses/.test(query)) { return opts.statusThrow ? Promise.reject(new Error('net')) : Promise.resolve({ workOrderStatuses: statuses }); }
    if (/user\s*\(/.test(query)) { return opts.userThrow ? Promise.reject(new Error('net')) : Promise.resolve({ user: user }); }
    return Promise.resolve({});
  };
}

var LIVE_STATUSES = [
  { id: 900, name: 'Internal Proposal Approved', isActive: true },   // note: a DIFFERENT id than the STATUS_FALLBACK 51
  { id: 232, name: 'Pending Trade Specialist', isActive: true }
];

(async function () {
  // ---- readStatusId: live resolution wins over the hardcoded fallback ----
  console.log('\n-- readStatusId resolves LIVE, and fails closed when unresolved --');
  var S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, null) });
  A.eq('a status present live resolves to the LIVE id (not the hardcoded 51)', await S.readStatusId('Internal Proposal Approved'), 900);

  // a name NOT in the live list, flag OFF -> null (fail-closed), NEVER the stale fallback
  S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, null) });
  A.eq('a status NOT in the live list fails closed to null (flag off)', await S.readStatusId('Internal Proposal Rejected'), null);

  // same miss, flag ON -> the rollback fallback id
  S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, null), legacy: true });
  A.eq('with the rollback flag on, a live miss uses STATUS_FALLBACK', await S.readStatusId('Internal Proposal Rejected'), 52);

  // read error, flag OFF -> null; flag ON -> fallback
  S = load(S_SLICE, { gql: gqlWith([], null, { statusThrow: true }) });
  A.eq('a failed statuses read fails closed to null (flag off)', await S.readStatusId('Internal Proposal Approved'), null);
  S = load(S_SLICE, { gql: gqlWith([], null, { statusThrow: true }), legacy: true });
  A.eq('a failed statuses read with the flag on uses STATUS_FALLBACK', await S.readStatusId('Internal Proposal Approved'), 51);

  // ---- resolveTspAssignee: verify the seed live, fail closed on a stale id ----
  console.log('\n-- resolveTspAssignee verifies the seed live, fails closed when it cannot --');
  S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, { firstName: 'Ronny', lastName: 'Sharp' }) });
  var t = await S.resolveTspAssignee();
  A.ok('the seed GUID that resolves to "Ronny Sharp" is accepted', t && t.guid === RG && t.name === 'Ronny Sharp', JSON.stringify(t));

  // seed resolves to a DIFFERENT person (id was reassigned) -> fail closed
  S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, { firstName: 'Someone', lastName: 'Else' }) });
  A.eq('a seed that resolves to a DIFFERENT name fails closed to null (flag off)', await S.resolveTspAssignee(), null);

  // seed resolves to nobody (user id no longer exists) -> fail closed
  S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, null) });
  A.eq('a seed that resolves to no user fails closed to null (flag off)', await S.resolveTspAssignee(), null);

  // read error -> fail closed
  S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, null, { userThrow: true }) });
  A.eq('a failed user read fails closed to null (flag off)', await S.resolveTspAssignee(), null);

  // rollback flag reinstates the seed even when it cannot be verified
  S = load(S_SLICE, { gql: gqlWith(LIVE_STATUSES, null), legacy: true });
  var tl = await S.resolveTspAssignee();
  A.ok('with the rollback flag on, the unverifiable seed is reinstated', tl && tl.guid === RG, JSON.stringify(tl));

  // ---- negative controls ----
  console.log('\n-- negative controls --');
  // remove the flag-gate in readStatusId's pick: a live miss now returns the stale id even flag-off
  var M1 = mutate(S_SLICE,
    'if (hit) return hit.id;\n      return paLegacyFallback() ? STATUS_FALLBACK[name] : null;',
    'if (hit) return hit.id;\n      return STATUS_FALLBACK[name];');
  var C1 = load(M1, { gql: gqlWith(LIVE_STATUSES, null) });
  A.eq('CONTROL: without the fail-closed gate, a live miss returns the stale id (so the gate is load-bearing)', await C1.readStatusId('Internal Proposal Rejected'), 52);

  // drop the NAME check in resolveTspAssignee: a wrong-name user is now accepted
  var M2 = mutate(S_SLICE,
    'if (u && nm.toLowerCase() === TSP_ASSIGNEE_NAME.toLowerCase()) return { guid: RONNY_GUID, name: nm };',
    'if (u) return { guid: RONNY_GUID, name: nm };');
  var C2 = load(M2, { gql: gqlWith(LIVE_STATUSES, { firstName: 'Someone', lastName: 'Else' }) });
  var c2 = await C2.resolveTspAssignee();
  A.ok('CONTROL: without the name check, a WRONG user is accepted (so the check is load-bearing)', c2 && c2.guid === RG, JSON.stringify(c2));

  // ---- source-level guards: the tsp branch routes through the resolver, constants kept for rollback ----
  console.log('\n-- source guards: TSP routes through the live resolver; constants kept for rollback --');
  A.ok('the TSP flow calls resolveTspAssignee()', /resolveTspAssignee\(\)\.then/.test(full));
  A.ok('the TSP flow no longer passes the raw RONNY_GUID to buildCreateTaskStep', !/buildCreateTaskStep\(ctx,\s*RONNY_GUID,/.test(full));
  A.ok('the TSP task uses the RESOLVED guid (tsp.guid)', /buildCreateTaskStep\(ctx,\s*tsp\.guid,/.test(full));
  A.ok('RONNY_GUID + STATUS_FALLBACK are kept as the rollback fallback', /var RONNY_GUID =/.test(full) && /var STATUS_FALLBACK =/.test(full));
  A.ok('setStatus refuses a null/NaN id (fail-closed chokepoint)', /statusId == null \|\| !isFinite\(Number\(statusId\)\)/.test(full));

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
