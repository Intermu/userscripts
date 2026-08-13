// test-dispatch-patch.js - node harness for bwn-dispatch's direct-write engine
// (patchWorkOrder status/assign/ECD), added in 0.10.0 on 2026-08-12.
//
// THE CHANGE, as found in source:
//   bwn-dispatch used to ONLY post a Teams card (via the SWA proxy -> Power Automate flow);
//   it never touched the Umbrava record. 0.10.0 reuses the patchWorkOrder mutation kanban
//   proved writes status LIVE, and adds assign + ECD, to write the WO record directly. Every
//   shape below was WIRE-PROVEN 2026-08-12, captured off real edits in the SPA on scratch WO
//   386473 (see [[umbrava-graphql-operations]] "patchWorkOrder - the full write contract" and
//   the memory [[dispatch-patchworkorder-pin]]).
//
// WHAT THIS PROVES, against the REAL shipped bytes (the engine block is sliced out of
// bwn-dispatch.user.js and run in a vm with a fake gql - nothing below is a restatement of a stub):
//   - PATCH_M keeps the captured operation name, `PatchWorkOrderInput!` typing and success/message
//     selection;
//   - the Conditional wrapper is exactly { shouldInclude:true, value:<T> };
//   - buildPatchData keys by the bare workOrderNumber and includes ONLY the chosen fields; status is
//     coerced to an Int; assign carries the GUID; ECD bundles the whole priority value AND
//     serviceLevelAgreementId;
//   - priorityWriteValue is a whole-object COPY (the captured hazard): it overrides only
//     expectedCompletionDate, forces the input's hasOverridePriority:true, and NEVER blanks a sibling
//     field (label / responseMinutes / SLA minutes / category / skipWeekends all survive the read);
//   - the auto ECD is now + the priority's SLA minutes, falling back to responseMinutes, null when
//     neither exists (so ECD is never written on a baseless date);
//   - patchWorkOrder resolves true only on success:true, and throws on a GraphQL errors[]/reject or
//     success:false (so a failed write aborts before any card is sent);
//   - fetchStatuses / fetchUsers filter (active / non-inactive non-technician) and fail SOFT to [].
//
// WHAT IT DOES NOT PROVE:
//   - that patchWorkOrder / users / workOrderStatuses exist on the live schema for this tenant, or
//     that the ECD/priority write behaves as captured. Only a real WO answers that - the live gate is
//     one dispatch on scratch WO 386473 (status moves, assignee changes, ECD lands, card posts). See
//     the vault note. The modal DOM + the card POST leg live outside the sliced block.
//
// Each control mutates the SAME source and MUST turn this harness red; mutate() throws if its target
// is absent or not unique, so a control that silently no-ops cannot pass.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dispatch-patch.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-dispatch.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var START = '  // ---- Direct WO record writes: the "gold key" patchWorkOrder engine ---------';
var END = "  // The WO's default assignee is often the CLIENT's team (e.g. \"Team J\"), not a dispatchable";

function slice(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error('START marker not found - the patchWorkOrder engine block is gone from bwn-dispatch.user.js');
  if (src.indexOf(START, a + 1) !== -1) throw new Error('START marker not unique');
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error('END marker not found after start');
  return src.slice(a, b);
}
var S_ENGINE = slice(full);

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// Load an engine block into a fresh vm context. `gql` is injected (settable per test).
function load(engineSrc) {
  var sandbox = { console: console, gql: null };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox);
  return sandbox;
}

// A representative READ priority, in the shape DISP_WO_Q returns (read field hasPriorityOverride).
function readPriority() {
  return {
    label: 'P2 Next Day',
    responseMinutes: 7199,
    firstTripDate: '2026-08-13T00:00:00.000Z',
    serviceLevelAgreementMinutes: 14400,
    expirationMinutes: 120,
    expectedCompletionDate: '2026-08-20T00:00:00.000Z',
    hasPriorityOverride: false,
    category: 'Standard',
    skipWeekends: false
  };
}

async function main() {
  var S = load(S_ENGINE);

  // ---- PATCH_M mutation string --------------------------------------------
  A.ok('PATCH_M names patchWorkOrder(data:$data)', /patchWorkOrder\(data:\s*\$data\)/.test(S.PATCH_M), S.PATCH_M);
  A.ok('PATCH_M types the input PatchWorkOrderInput!', /PatchWorkOrderInput!/.test(S.PATCH_M));
  A.ok('PATCH_M selects success + message', /success\s+message/.test(S.PATCH_M));

  // ---- cond() = the Conditional*Input wrapper -----------------------------
  A.eq('cond wraps {shouldInclude:true, value}', S.cond(41), { shouldInclude: true, value: 41 });
  A.eq('cond passes a GUID string through', S.cond('abc-guid'), { shouldInclude: true, value: 'abc-guid' });

  // ---- buildPatchData: only chosen fields, correct shapes -----------------
  var base = { woNumber: 386473, priority: readPriority(), slaId: 'sla-guid-1' };

  var dStatus = S.buildPatchData(Object.assign({}, base, { statusId: '78', assignedTo: '', ecd: null }));
  A.eq('status-only: keys', Object.keys(dStatus).sort(), ['statusId', 'workOrderNumber']);
  A.eq('status-only: workOrderNumber is the bare key', dStatus.workOrderNumber, 386473);
  A.eq('status-only: statusId is an INT wrapped', dStatus.statusId, { shouldInclude: true, value: 78 });
  A.ok('status value is a number, not a string', typeof dStatus.statusId.value === 'number');

  var dAssign = S.buildPatchData(Object.assign({}, base, { statusId: '', assignedTo: 'user-guid-9', ecd: null }));
  A.eq('assign-only: keys', Object.keys(dAssign).sort(), ['assignedTo', 'workOrderNumber']);
  A.eq('assign-only: assignedTo carries the GUID', dAssign.assignedTo, { shouldInclude: true, value: 'user-guid-9' });

  var ecd = '2026-08-27T15:00:00.000Z';
  var dEcd = S.buildPatchData(Object.assign({}, base, { statusId: '', assignedTo: '', ecd: ecd }));
  A.eq('ecd-only: keys include priority AND serviceLevelAgreementId', Object.keys(dEcd).sort(), ['priority', 'serviceLevelAgreementId', 'workOrderNumber']);
  A.eq('ecd-only: serviceLevelAgreementId bundled', dEcd.serviceLevelAgreementId, { shouldInclude: true, value: 'sla-guid-1' });
  A.ok('ecd-only: priority wrapped shouldInclude', dEcd.priority.shouldInclude === true);
  A.eq('ecd-only: expectedCompletionDate overridden', dEcd.priority.value.expectedCompletionDate, ecd);

  var dAll = S.buildPatchData(Object.assign({}, base, { statusId: '234', assignedTo: 'user-guid-9', ecd: ecd }));
  A.eq('all-three: keys', Object.keys(dAll).sort(), ['assignedTo', 'priority', 'serviceLevelAgreementId', 'statusId', 'workOrderNumber']);

  var dNone = S.buildPatchData(Object.assign({}, base, { statusId: '', assignedTo: '', ecd: null }));
  A.eq('none-chosen: only the WO key (no writes)', Object.keys(dNone), ['workOrderNumber']);

  var dEcdNoSla = S.buildPatchData({ woNumber: 1, priority: readPriority(), slaId: null, statusId: '', assignedTo: '', ecd: ecd });
  A.ok('ecd without slaId: no serviceLevelAgreementId key', !('serviceLevelAgreementId' in dEcdNoSla));
  A.ok('ecd without slaId: priority still written', !!dEcdNoSla.priority);

  // ---- priorityWriteValue: whole-object copy, no sibling blanked ----------
  var pv = S.priorityWriteValue(readPriority(), ecd);
  A.eq('priority copy: label survives', pv.label, 'P2 Next Day');
  A.eq('priority copy: responseMinutes survives', pv.responseMinutes, 7199);
  A.eq('priority copy: SLA minutes survive', pv.serviceLevelAgreementMinutes, 14400);
  A.eq('priority copy: expirationMinutes survive', pv.expirationMinutes, 120);
  A.eq('priority copy: category survives as string', pv.category, 'Standard');
  A.eq('priority copy: skipWeekends survives', pv.skipWeekends, false);
  A.eq('priority copy: firstTripDate survives', pv.firstTripDate, '2026-08-13T00:00:00.000Z');
  A.eq('priority copy: ECD is the new value', pv.expectedCompletionDate, ecd);
  A.eq('priority copy: input field is hasOverridePriority (not hasPriorityOverride)', 'hasOverridePriority' in pv && !('hasPriorityOverride' in pv), true);
  A.eq('priority copy: hasOverridePriority forced true', pv.hasOverridePriority, true);
  A.ok('priority copy: no sibling nulled (all 9 keys present)', Object.keys(pv).length === 9);

  // ---- auto ECD basis -----------------------------------------------------
  A.eq('ecdBasis: SLA preferred over response', S.ecdBasisMinutes({ serviceLevelAgreementMinutes: 14400, responseMinutes: 60 }), { mins: 14400, from: 'SLA' });
  A.eq('ecdBasis: response used when no SLA', S.ecdBasisMinutes({ serviceLevelAgreementMinutes: 0, responseMinutes: 480 }), { mins: 480, from: 'response' });
  A.eq('ecdBasis: null when neither', S.ecdBasisMinutes({}), null);
  var t0 = 1000000000000;
  A.eq('computeEcd: now + SLA minutes', S.computeEcd({ serviceLevelAgreementMinutes: 10 }, t0), new Date(t0 + 10 * 60000).toISOString());
  A.eq('computeEcd: null with no basis', S.computeEcd({}, t0), null);

  // ---- patchWorkOrder resolve/throw semantics -----------------------------
  S.gql = function () { return Promise.resolve({ patchWorkOrder: { success: true } }); };
  var okRes = await S.patchWorkOrder({ workOrderNumber: 1 });
  A.eq('patchWorkOrder resolves true on success', okRes, true);

  S.gql = function () { return Promise.resolve({ patchWorkOrder: { success: false, message: 'nope' } }); };
  var threwFalse = false, msg = '';
  try { await S.patchWorkOrder({ workOrderNumber: 1 }); } catch (e) { threwFalse = true; msg = e.message; }
  A.ok('patchWorkOrder throws on success:false', threwFalse);
  A.eq('patchWorkOrder surfaces the server message', msg, 'nope');

  S.gql = function () { return Promise.reject(new Error('GraphQL error')); };
  var threwReject = false;
  try { await S.patchWorkOrder({ workOrderNumber: 1 }); } catch (e) { threwReject = true; }
  A.ok('patchWorkOrder propagates a gql reject', threwReject);

  // ---- fetchStatuses / fetchUsers: filter + fail-soft ---------------------
  S._statuses = null;
  S.gql = function () { return Promise.resolve({ workOrderStatuses: [{ id: 41, name: 'Pending Dispatch', isActive: true }, { id: 9, name: 'Dead', isActive: false }] }); };
  var st = await S.fetchStatuses();
  A.eq('fetchStatuses drops inactive rows', st.map(function (s) { return s.id; }), [41]);

  S._statuses = null;
  S.gql = function () { return Promise.reject(new Error('x')); };
  var st2 = await S.fetchStatuses();
  A.eq('fetchStatuses fails soft to []', st2, []);

  S._users = null;
  S.gql = function () {
    return Promise.resolve({ users: [
      { id: 'g1', firstName: 'Ann', lastName: 'Zed', emailAddress: 'a@x.com', isInactive: false, isTechnician: false },
      { id: 'g2', firstName: 'Bob', lastName: 'Yew', emailAddress: 'b@x.com', isInactive: true, isTechnician: false },
      { id: 'g3', firstName: 'Cid', lastName: 'Win', emailAddress: 'c@x.com', isInactive: false, isTechnician: true }
    ] });
  };
  var us = await S.fetchUsers();
  A.eq('fetchUsers drops inactive + technician, keeps coordinators', us.map(function (u) { return u.id; }), ['g1']);
  A.eq('fetchUsers maps {id,name,email}', us[0], { id: 'g1', name: 'Ann Zed', email: 'a@x.com' });

  S._users = null;
  S.gql = function () { return Promise.reject(new Error('x')); };
  A.eq('fetchUsers fails soft to []', await S.fetchUsers(), []);

  // ---- Negative controls: each mutation of the SOURCE must break a claim --
  // run(M) returns whether the ORIGINAL claim STILL HOLDS in the mutated copy (may be a Promise); a
  // control passes only when the mutation broke the claim (run falsy) or threw.
  async function ctrl(name, from, to, run) {
    var mutated = load(mutate(S_ENGINE, from, to));
    var broke = false;
    try { var r = await run(mutated); if (!r) broke = true; } catch (e) { broke = true; }
    A.ok('CONTROL breaks: ' + name, broke);
  }

  await ctrl('statusId sent as string not Int',
    'data.statusId = cond(parseInt(sel.statusId, 10));',
    'data.statusId = cond(sel.statusId);',
    function (M) { return typeof M.buildPatchData({ woNumber: 1, statusId: '78', assignedTo: '', ecd: null, priority: readPriority(), slaId: 's' }).statusId.value === 'number'; });

  await ctrl('ECD not overridden (whole-object copy leaves old date)',
    'expectedCompletionDate: newEcd,',
    'expectedCompletionDate: (p.expectedCompletionDate == null ? null : String(p.expectedCompletionDate)),',
    function (M) { return M.priorityWriteValue(readPriority(), ecd).expectedCompletionDate === ecd; });

  await ctrl('hasOverridePriority not forced true',
    'hasOverridePriority: true,',
    'hasOverridePriority: !!p.hasPriorityOverride,',
    function (M) { return M.priorityWriteValue(readPriority(), ecd).hasOverridePriority === true; });

  await ctrl('SLA no longer preferred over responseMinutes',
    'var sla = Number(priority && priority.serviceLevelAgreementMinutes);\n    if (sla > 0) return { mins: sla, from: \'SLA\' };',
    'var sla = Number(priority && priority.serviceLevelAgreementMinutes);\n    if (false) return { mins: sla, from: \'SLA\' };',
    function (M) { var b = M.ecdBasisMinutes({ serviceLevelAgreementMinutes: 14400, responseMinutes: 60 }); return b && b.from === 'SLA'; });

  await ctrl('serviceLevelAgreementId no longer bundled with the ECD write',
    'if (sel.slaId) data.serviceLevelAgreementId = cond(sel.slaId);',
    'if (false) data.serviceLevelAgreementId = cond(sel.slaId);',
    function (M) { return 'serviceLevelAgreementId' in M.buildPatchData({ woNumber: 1, statusId: '', assignedTo: '', ecd: ecd, priority: readPriority(), slaId: 'sla-guid-1' }); });

  await ctrl('patchWorkOrder stops throwing on success:false',
    "if (!p || !p.success) throw new Error((p && p.message) || 'patchWorkOrder reported no success');",
    'if (!p) throw new Error(0);',
    function (M) {
      M.gql = function () { return Promise.resolve({ patchWorkOrder: { success: false, message: 'nope' } }); };
      // synchronous inspection is not possible; return whether it REJECTS by racing a sentinel
      var rejected = false;
      return M.patchWorkOrder({ workOrderNumber: 1 }).then(function () { return false; }, function () { return true; });
    });

  await ctrl('fetchUsers stops filtering technicians',
    '!u.isInactive && !u.isTechnician',
    '!u.isInactive',
    function (M) {
      M._users = null;
      M.gql = function () { return Promise.resolve({ users: [{ id: 'g3', firstName: 'Cid', lastName: 'Win', emailAddress: 'c@x.com', isInactive: false, isTechnician: true }] }); };
      return M.fetchUsers().then(function (r) { return r.length === 0; });
    });

  A.finish();
}

main().catch(function (e) { console.error(e); process.exit(1); });
