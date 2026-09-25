// test-pa-multi-proposal.js - the multiple-proposals-per-job review of bwn-proposal-actions.user.js.
// Slices the REAL PA-SIBLINGS block (plus readTotals and the money / toGpNumber helpers it leans on)
// into a vm with an injected paGql, and pins:
//   - proposalRow maps the list item, derives a status from the terminal dates, and leaves every
//     field it could not read EMPTY (the UI labels empty as "not available"; nothing is guessed),
//   - readJobProposals falls back to the live-proven minimal field set when the extended read is
//     refused, and flags the result partial,
//   - canceled proposals are listed but not counted as options,
//   - siblingContext demands the explicit acknowledgement whenever the reviewer could be on the
//     wrong alternative (several options, acted-on id missing, list truncated, list unreadable),
//   - readTotals never borrows a SIBLING's total when the acted-on id is missing from the list,
//   - PA-HISTORY (0.7.1): the browser-local action history writes ONE record only after a fully
//     completed run (driven through the REAL runSteps), dedups by run id, survives corrupt / blocked
//     / full storage without affecting the action, prunes by count + age without touching other keys,
//     and renders as a "Local record" line in Compare and a non-blocking warning in confirm.
// Negative controls (mutate()) prove each assertion is load-bearing.
//
// Run with the Adobe-bundled node (system node is quarantined on this machine):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-pa-multi-proposal.js
// CI runs: node scripts/test-pa-multi-proposal.js

process.env.TZ = 'America/New_York';   // BWN reviewers' zone; pins the fmtDate local-day assertions
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var full = fs.readFileSync(path.join(__dirname, '..', 'bwn-proposal-actions.user.js'), 'utf8').replace(/\r\n/g, '\n');
function between(a0, b0) {
  var a = full.indexOf(a0); if (a === -1) throw new Error('missing marker ' + a0);
  if (full.indexOf(a0, a + 1) !== -1) throw new Error('marker not unique ' + a0);
  var b = full.indexOf(b0, a); if (b === -1) throw new Error('missing marker ' + b0);
  return full.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}
var MONEY = between('  function escapeHtml(s)', '  // ===== PA-GPLABEL START');   // escapeHtml + money
var READS = between("  var Q_PROP = 'query PA_Prop", "  var Q_TASKS = ");   // toGpNumber + readTotals + PA-SIBLINGS + PA-HISTORY
var RUNNER = between('  function mark(li, cls, icon, note)', '  // ===== "what changed" delta');   // runSteps + mark
var KICKBACK = between('  // ===== PA-KICKBACK START', '  // ===== PA-KICKBACK END');   // reason gate (0.7.12)
var DISPLAY = between('  // ===== multi-proposal display helpers', '  // ===== confirm modal');     // fmtDate, confirmSummaryHtml, ...

// handlers: { opName: function (variables) -> data | throws }
function load(reads, handlers, extra) {
  var calls = [];
  function paGql(op, q, v) {
    calls.push({ op: op, q: q, v: v });
    var h = handlers[op];
    if (!h) return Promise.reject(new Error('unexpected op ' + op));
    try { return Promise.resolve(h(v)); } catch (e) { return Promise.reject(e); }
  }
  var box = { paGql: paGql, console: console };
  Object.keys(extra || {}).forEach(function (k) { box[k] = extra[k]; });
  vm.createContext(box);
  vm.runInContext(MONEY + reads, box);
  box.calls = calls;
  return box;
}
function list(items, rowCount) { return { listClientProposals: { rowCount: rowCount == null ? items.length : rowCount, items: items } }; }
function money$(cents) { return { amount: cents, currency: 'USD', precision: 2 }; }

// Anonymized LIVE PA_Siblings responses (read-only validation 2026-09-25; number added and re-read live the
// same day: 560948=#1, 561841=#2, 561850=#3, 563072=#1, each matched to Umbrava's visible '#' column). Shape, types, ids, money
// and GP strings are exactly as returned; description / createdByMemberName are placeholders of the
// same kind (the single-proposal job really returned an EMPTY description). No canceled proposal was
// present live, so the canceled path stays on the synthetic RICH fixture below.
var LIVE_MULTI = { listClientProposals: { rowCount: 3, items: [
  { id: 560948, number: 1, description: 'Option A placeholder', created: '2026-09-22T17:57:32.5739342+00:00', submittedDate: null, approvedDate: null, rejectedDate: null, canceledDate: null, isSubmitted: false, createdByMemberName: 'Member Placeholder', status: { name: 'Prep' }, type: null, total: { amount: 127589, currency: 'USD', precision: 2 }, vendorCost: { amount: 88000, currency: 'USD', precision: 2 }, grossProfitPercent: '0.26372155' },
  { id: 561841, number: 2, description: 'Option B placeholder', created: '2026-09-23T20:48:48.5344037+00:00', submittedDate: null, approvedDate: null, rejectedDate: null, canceledDate: null, isSubmitted: false, createdByMemberName: 'Member Placeholder', status: { name: 'Prep' }, type: { name: 'Original' }, total: { amount: 249818, currency: 'USD', precision: 2 }, vendorCost: { amount: 176000, currency: 'USD', precision: 2 }, grossProfitPercent: '0.24792753' },
  { id: 561850, number: 3, description: 'Option C placeholder', created: '2026-09-23T20:53:42.9003633+00:00', submittedDate: null, approvedDate: null, rejectedDate: null, canceledDate: null, isSubmitted: false, createdByMemberName: 'Member Placeholder', status: { name: 'Prep' }, type: { name: 'Original' }, total: { amount: 113797, currency: 'USD', precision: 2 }, vendorCost: { amount: 96000, currency: 'USD', precision: 2 }, grossProfitPercent: '0.09943715' }
] } };
var LIVE_SINGLE = { listClientProposals: { rowCount: 1, items: [
  { id: 563072, number: 1, description: '', created: '2026-09-24T14:56:36.7417804+00:00', submittedDate: null, approvedDate: null, rejectedDate: null, canceledDate: null, isSubmitted: false, createdByMemberName: 'Member Placeholder', status: { name: 'Prep' }, type: { name: 'ATF' }, total: { amount: 224932, currency: 'USD', precision: 2 }, vendorCost: { amount: 132500, currency: 'USD', precision: 2 }, grossProfitPercent: '0.38906589' }
] } };

var RICH = [
  { id: 901, description: 'Replace RTU compressor', created: '2026-09-20T14:00:00.0000000+00:00', submittedDate: '2026-09-21T09:00:00.0000000+00:00',
    isSubmitted: true, createdByMemberName: 'Ana', status: { name: 'Submitted' }, type: { name: 'Repair' },
    total: money$(1234500), vendorCost: money$(800000), grossProfitPercent: '0.3519' },
  { id: 902, description: 'Replace full RTU', isSubmitted: false, total: money$(2500000), grossProfitPercent: '0.41' },
  { id: 903, canceledDate: '2026-09-19T00:00:00Z', total: money$(100) }
];

(async function () {
  // ---- proposalRow -------------------------------------------------------------------------
  var b = load(READS, {});
  var r0 = b.proposalRow(RICH[0]);
  A.eq('row id', r0.id, 901);
  A.eq('row total formatted from minor units', r0.total, '$12,345.00');
  A.eq('row vendor cost formatted', r0.vendorCost, '$8,000.00');
  A.eq('row GP parsed from the API string', r0.gpPct, 0.3519);
  A.eq('row status prefers status.name', r0.status, 'Submitted');
  A.eq('row type name', r0.type, 'Repair');
  A.eq('draft derived from isSubmitted=false', b.proposalRow(RICH[1]).status, 'Draft');
  A.eq('canceled derived from canceledDate', b.proposalRow(RICH[2]).status, 'Canceled');
  A.ok('canceled flag set', b.proposalRow(RICH[2]).canceled === true);
  var bare = b.proposalRow({ id: 5 });
  A.eq('unreadable fields stay EMPTY, never guessed', [bare.title, bare.status, bare.total, bare.vendorCost, bare.created, bare.submitted], ['', '', '', '', '', '']);
  A.eq('unreadable GP is null (not 0)', bare.gpPct, null);
  var bM = load(mutate(READS, "(it.isSubmitted === false ? 'Draft' : '')", "'Draft'"), {});
  A.ok('CONTROL: guessing Draft for an unknown submit state is caught', bM.proposalRow({ id: 5 }).status === 'Draft');

  // ---- readJobProposals: rich, then fallback ------------------------------------------------
  var bR = load(READS, { PA_Siblings: function (v) { return list(RICH); } });
  var sib = await bR.readJobProposals(77);
  A.eq('rich read keyed by jobId', bR.calls[0].v, { j: 77 });
  A.ok('rich read sends sortBy (server 400s without it)', /sortBy: \[\{ columnName: "id", direction: DESC \}\]/.test(bR.calls[0].q));
  A.eq('rich read not partial', sib.partial, false);
  A.eq('rich read row count', sib.rows.length, 3);
  var bF = load(READS, {
    PA_Siblings: function () { throw new Error('Cannot query field "vendorCost"'); },
    PA_SiblingsMin: function () { return list([{ id: 901, total: money$(100) }, { id: 902, total: money$(200) }], 60); }
  });
  var sibF = await bF.readJobProposals(77);
  A.eq('fallback runs after the extended read is refused', bF.calls.map(function (c) { return c.op; }), ['PA_Siblings', 'PA_SiblingsMin']);
  A.ok('fallback also sends sortBy', /sortBy:/.test(bF.calls[1].q));
  A.eq('fallback result is flagged partial', sibF.partial, true);
  A.eq('rowCount carried for truncation notice', sibF.rowCount, 60);
  var bBoth = load(READS, { PA_Siblings: function () { throw new Error('x'); }, PA_SiblingsMin: function () { throw new Error('y'); } });
  var rejected = false; try { await bBoth.readJobProposals(77); } catch (e) { rejected = true; }
  A.ok('both reads failing rejects (the caller turns that into "cannot rule out")', rejected);

  // ---- liveOptions + siblingContext ----------------------------------------------------------
  A.eq('canceled proposals are not counted as options', b.liveOptions(sib.rows).length, 2);
  var sc = b.siblingContext(sib, 901);
  A.eq('selected is the acted-on id', sc.selected && sc.selected.id, 901);
  A.eq('others exclude the selected one', sc.others.map(function (r) { return r.id; }), [902, 903]);
  A.ok('two live options -> acknowledgement required', sc.needsAck === true);
  var one = { rows: [b.proposalRow(RICH[0]), b.proposalRow(RICH[2])], rowCount: 2, partial: false };
  A.ok('one live option (+ a canceled one) -> no acknowledgement, single-proposal flow unchanged', b.siblingContext(one, 901).needsAck === false);
  A.ok('acted-on id missing from the list -> acknowledgement required', b.siblingContext(one, 999).needsAck === true);
  A.ok('truncated list -> acknowledgement required', b.siblingContext({ rows: one.rows, rowCount: 80, partial: false }, 901).needsAck === true);
  var unk = b.siblingContext(null, 901);
  A.ok('unreadable siblings -> acknowledgement required (fail toward the check)', unk.needsAck === true && unk.known === false);
  var bA = load(mutate(READS, 'needsAck: count > 1 || ', 'needsAck: '), {});
  A.ok('CONTROL: dropping the count rule lets a multi-option job through', bA.siblingContext(sib, 901).needsAck === false);

  // ---- readTotals never borrows a sibling --------------------------------------------------
  var bT = load(READS, {
    PA_Prop: function () { throw new Error('node read failed'); },
    PA_List: function () { return list([{ id: 902, total: money$(2500000), grossProfitPercent: '0.41' }]); }
  });
  var tErr = null; try { await bT.readTotals(77, 901); } catch (e) { tErr = e; }
  A.ok('readTotals rejects when the acted-on id is not in the list', !!tErr && /proposal #901/.test(tErr.message));
  var bT2 = load(READS, {
    PA_Prop: function () { throw new Error('node read failed'); },
    PA_List: function () { return list([{ id: 902, total: money$(1) }, { id: 901, total: money$(12345), grossProfitPercent: '0.5' }]); }
  });
  var t2 = await bT2.readTotals(77, 901);
  A.eq('readTotals picks the matching id from the list', t2.total.amount, 12345);
  var bTM = load(mutate(READS, 'return x.id === proposalId; })[0];', 'return x.id === proposalId; })[0] || items[0];'), {
    PA_Prop: function () { throw new Error('node read failed'); },
    PA_List: function () { return list([{ id: 902, total: money$(2500000) }]); }
  });
  var borrowed = await bTM.readTotals(77, 901).then(function (t) { return t.total.amount; }, function () { return null; });
  A.ok('CONTROL: restoring the items[0] fallback borrows the sibling total', borrowed === 2500000);

  // ---- live response shapes (0.7.2) --------------------------------------------------------
  var bL = load(READS, { PA_Siblings: function () { return LIVE_MULTI; } });
  var live = await bL.readJobProposals(1329644);
  A.eq('live multi: extended read accepted, not partial', live.partial, false);
  A.eq('live multi: rowCount is a number and matches items', [live.rowCount, live.rows.length], [3, 3]);
  A.eq('live multi: all three are live options (none canceled)', bL.liveOptions(live.rows).length, 3);
  A.eq('live: status.name "Prep" wins over the derived Draft', live.rows[0].status, 'Prep');
  A.eq('live: type null -> empty (labelled n/a), not a guess', live.rows[0].type, '');
  A.eq('live: type name read when present', live.rows[1].type, 'Original');
  A.eq('live: total minor units -> dollars', live.rows[0].total, '$1,275.89');
  A.eq('live: GP string -> fraction', live.rows[2].gpPct, 0.09943715);
  A.eq('live: submittedDate null -> empty', live.rows[0].submitted, '');
  A.ok('live multi: acknowledgement required on the acted-on option', bL.siblingContext(live, 561841).needsAck === true);
  var bS = load(READS, { PA_Siblings: function () { return LIVE_SINGLE; } });
  var liveOne = await bS.readJobProposals(1323426);
  A.ok('live single: no acknowledgement (single-proposal flow unchanged)', bS.siblingContext(liveOne, 563072).needsAck === false);
  A.eq('live single: empty description stays empty (UI says "no description")', liveOne.rows[0].title, '');
  var bD = hload(mkStore());
  A.eq('fmtDate parses the live 7-digit-fraction offset format', bD.fmtDate('2026-09-22T17:57:32.5739342+00:00'), '09/22/2026');
  A.eq('fmtDate shows the LOCAL day (02:30 UTC = previous evening Eastern)', bD.fmtDate('2026-09-24T02:30:00.0000000+00:00'), '09/23/2026');
  A.eq('fmtDate: empty in -> empty out', bD.fmtDate(null), '');
  var bDM = load(READS + RUNNER + mutate(DISPLAY, 'var t = Date.parse(String(s));', 'var t = NaN;'), {}, { localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 1; }, proposalIdFromUrl: function () { return 1; } });
  A.ok('CONTROL: the old UTC-slice formatting shows the wrong (next) day', bDM.fmtDate('2026-09-24T02:30:00.0000000+00:00') === '09/24/2026');

  // ---- PA-HISTORY: local action history (0.7.1) --------------------------------------------
  var HKEY = 'bwn:pa:history';
  var NOW = Date.parse('2026-09-25T13:42:00Z');
  function mkStore(init, knobs) {
    knobs = knobs || {};
    var m = Object.assign({}, init || {});
    return {
      map: m, sets: 0,
      getItem: function (k) { if (knobs.throwGet) throw new Error('SecurityError'); return m.hasOwnProperty(k) ? m[k] : null; },
      setItem: function (k, v) { if (knobs.throwSet) throw new Error('QuotaExceededError'); this.sets++; m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }
  function hload(store) {
    var toasts = [];
    var timers = [];
    var bx = load(READS + RUNNER + DISPLAY, {}, {
      localStorage: store,
      paToast: function (msg) { toasts.push(msg); },
      woNumberFromUrl: function () { return 123; },
      proposalIdFromUrl: function () { return 901; },
      setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); }
    });
    bx.toasts = toasts;
    bx.timers = timers;
    return bx;
  }
  function stored(store) { return store.map[HKEY] == null ? [] : JSON.parse(store.map[HKEY]); }
  function fakeLi() {
    var ic = { textContent: '' }, lb = { innerHTML: 'step' };
    return { className: '', querySelector: function (s) { return s === '.ic' ? ic : lb; } };
  }
  function mkPlan(bx, kind, runId, stepOutcomes) {
    // stepOutcomes: array of functions returning a promise; shared across attempts so a Retry resumes.
    return {
      kind: kind, runId: runId,
      ctx: { n: 123, pid: 901, total: '$12,345.00', gpPct: 0.3519, gp: 'Good GP', gpText: '35.19%', wo: { statusName: 'Proposal Review' },
        siblings: { rows: [bx.proposalRow(RICH[0]), bx.proposalRow(RICH[1])], rowCount: 2, partial: false } },
      steps: stepOutcomes.map(function (fn, i) { return { label: 'step ' + i, run: fn }; })
    };
  }
  // Mirrors the Confirm handler: run the REAL runSteps, then hand its result to paHistOnResult.
  function complete(bx, plan, els, note) {
    return bx.runSteps(plan.steps, note, els).then(function (res) { return { res: res, h: bx.paHistOnResult(plan, note, res, NOW) }; });
  }
  function okStep() { return Promise.resolve(true); }

  var s1 = mkStore({ 'bwn:audit': '[1]', 'other:key': 'keep' });
  var h1 = hload(s1);
  var pA = mkPlan(h1, 'approval', 'pa-run-a', [okStep, okStep]);
  h1.confirmSummaryHtml(pA);
  A.eq('no history record before completion (rendering the confirm dialog writes nothing)', s1.sets, 0);
  var elsA = [fakeLi(), fakeLi()];
  var outA = await complete(h1, pA, elsA, 'Good to submit - Good GP');
  A.eq('successful Approval -> ok', outA.h, 'ok');
  var recA = stored(s1);
  A.eq('successful Approval -> exactly one record', recA.length, 1);
  A.eq('record identity: job + proposal + kind + run id', [recA[0].n, recA[0].pid, recA[0].kind, recA[0].id], [123, 901, 'approval', 'pa-run-a']);
  A.eq('record carries schema + localOnly', [recA[0].schema, recA[0].localOnly], [1, true]);
  A.eq('record ts is ISO', recA[0].ts, '2026-09-25T13:42:00.000Z');
  A.eq('record keeps only the acted-on proposal title / amount / GP', [recA[0].title, recA[0].total, recA[0].gpPct], ['Replace RTU compressor', '$12,345.00', 0.3519]);
  A.eq('record keeps the submitted note', recA[0].note, 'Good to submit - Good GP');
  A.ok('record holds no sibling data', JSON.stringify(recA[0]).indexOf('Replace full RTU') === -1 && JSON.stringify(recA[0]).indexOf('25,000') === -1);
  A.eq('unrelated keys untouched by the write', [s1.map['bwn:audit'], s1.map['other:key']], ['[1]', 'keep']);
  A.eq('duplicate completion callback for the same run -> dup', h1.paHistOnResult(pA, 'x', outA.res, NOW + 5), 'dup');
  A.eq('duplicate completion does not add a record', stored(s1).length, 1);

  var pK = mkPlan(h1, 'kickback', 'pa-run-k', [okStep]);
  A.eq('successful Kickback -> ok', (await complete(h1, pK, [fakeLi()], 'Missing labor hours')).h, 'ok');
  var pT = mkPlan(h1, 'tsp', 'pa-run-t', [okStep]);
  A.eq('successful TSP -> ok', (await complete(h1, pT, [fakeLi()], 'TSP Review')).h, 'ok');
  var kinds = stored(s1).map(function (r) { return r.kind; }).sort();
  A.eq('one record each for Approval / Kickback / TSP (same proposal, different actions are NOT deduped)', kinds, ['approval', 'kickback', 'tsp']);

  // failed sequence, then Retry in the same dialog (same run id, same step elements)
  var s2 = mkStore();
  var h2 = hload(s2);
  var failOnce = true;
  var pR = mkPlan(h2, 'tsp', 'pa-run-r', [okStep, function () {
    if (failOnce) { failOnce = false; return Promise.reject(new Error('HTTP 500')); }
    return Promise.resolve(true);
  }, okStep]);
  var elsR = [fakeLi(), fakeLi(), fakeLi()];
  var first = await complete(h2, pR, elsR, 'TSP Review');
  A.ok('first attempt fails mid-sequence', first.res.ok === false);
  A.eq('failed / partial sequence -> no record', [first.h, stored(s2).length], ['none', 0]);
  var retry = await complete(h2, pR, elsR, 'TSP Review');
  A.ok('Retry resumes and completes (existing retry behavior preserved)', retry.res.ok === true);
  A.eq('successful Retry writes exactly one record', stored(s2).length, 1);
  await complete(h2, pR, elsR, 'TSP Review');
  A.eq('re-running an already-complete run does not duplicate', stored(s2).length, 1);
  A.eq('skipped (pending) steps are not a completed action', h2.paHistOnResult(mkPlan(h2, 'tsp', 'pa-run-s', []), 'n', { ok: true, skipped: 1 }, NOW), 'none');
  var hM = hload(mkStore());
  var hMsrc = mutate(READS, 'if (!res || !res.ok || res.skipped ||', 'if (');
  var hMb = load(hMsrc + RUNNER + DISPLAY, {}, { localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; } });
  A.eq('CONTROL: without the ok check a FAILED run is recorded', hMb.paHistOnResult(mkPlan(hM, 'tsp', 'pa-c', []), 'n', { ok: false }, NOW), 'ok');

  // storage failures never affect the action
  var s3 = mkStore({}, { throwSet: true });
  var h3 = hload(s3);
  var out3 = await complete(h3, mkPlan(h3, 'approval', 'pa-q', [okStep]), [fakeLi()], 'note');
  A.ok('quota / write failure: the action still completes', out3.res.ok === true);
  A.eq('quota / write failure is reported as fail (for the one truthful toast), not thrown', out3.h, 'fail');
  var s4 = mkStore({}, { throwGet: true });
  var h4 = hload(s4);
  A.eq('blocked storage read -> unavailable, empty', [h4.paHistLoad().error, h4.paHistLoad().records.length], ['unavailable', 0]);
  A.eq('blocked storage -> append fails safely', h4.paHistOnResult(mkPlan(h4, 'approval', 'pa-b', []), 'n', { ok: true, skipped: 0 }, NOW), 'fail');

  // corrupt / stale / hostile stored data
  var s5 = mkStore({ 'bwn:pa:history': '{not json' });
  var h5 = hload(s5);
  A.eq('invalid JSON -> corrupt, empty', [h5.paHistLoad().error, h5.paHistLoad().records.length], ['corrupt', 0]);
  h5.confirmSummaryHtml(mkPlan(h5, 'approval', 'pa-z', []));
  h5.confirmSummaryHtml(mkPlan(h5, 'approval', 'pa-z2', []));
  A.eq('corrupt history is reported once per page session, not on every render', h5.toasts.length, 1);
  var mixed = [
    { schema: 1, localOnly: true, id: 'good', ts: '2026-09-24T10:00:00Z', kind: 'kickback', n: 123, pid: 901, title: '<img src=x onerror=alert(1)>' },
    { schema: 0, localOnly: true, id: 'old', ts: '2026-09-24T10:00:00Z', kind: 'kickback', n: 123, pid: 901 },
    { schema: 1, localOnly: true, id: 'badkind', ts: '2026-09-24T10:00:00Z', kind: 'delete', n: 123, pid: 901 },
    { schema: 1, localOnly: true, id: 'badts', ts: 'yesterday', kind: 'tsp', n: 123, pid: 901 },
    'string', null, 42
  ];
  var h6 = hload(mkStore({ 'bwn:pa:history': JSON.stringify(mixed) }));
  A.eq('stale schema / unknown kind / bad ts / junk entries dropped', h6.paHistLoad().records.map(function (r) { return r.id; }), ['good']);
  var cell = h6.paHistCellHtml([{ schema: 1, localOnly: true, id: 'x', ts: '2026-09-24T10:00:00Z', kind: 'tsp', n: 1, pid: 2, total: '<b>$1</b>' }, h6.paHistLoad().records[0]]);
  A.ok('persisted text is escaped when rendered', cell.indexOf('<b>') === -1 && cell.indexOf('&lt;b&gt;') !== -1);

  // retention
  var many = [];
  for (var i = 0; i < 310; i++) many.push({ schema: 1, localOnly: true, id: 'r' + i, ts: new Date(NOW - (i + 1) * 3600 * 1000).toISOString(), kind: 'tsp', n: 1, pid: 2 });
  many.push({ schema: 1, localOnly: true, id: 'ancient', ts: new Date(NOW - 200 * 86400 * 1000).toISOString(), kind: 'tsp', n: 1, pid: 3 });
  var s7 = mkStore({ 'bwn:pa:history': JSON.stringify(many), 'bwn:audit': '[9]', 'bwn:modules': '{}' });
  var h7 = hload(s7);
  await complete(h7, mkPlan(h7, 'approval', 'pa-new', [okStep]), [fakeLi()], 'n');
  var kept = stored(s7);
  A.eq('retention caps at PA_HIST_MAX', kept.length, 300);
  A.eq('retention keeps the newest (the new record first)', kept[0].id, 'pa-new');
  A.ok('retention drops the oldest', kept.every(function (r) { return r.id !== 'r309' && r.id !== 'r299'; }) && kept.some(function (r) { return r.id === 'r298'; }));
  A.ok('retention drops records past the max age', kept.every(function (r) { return r.id !== 'ancient'; }));
  A.eq('retention does not touch unrelated keys', [s7.map['bwn:audit'], s7.map['bwn:modules']], ['[9]', '{}']);

  // rendering: Compare row + confirm warning
  var recs = h1.paHistFor(stored(s1), 123, 901);
  A.eq('history for a proposal is newest first', recs.length, 3);
  var older = { schema: 1, localOnly: true, id: 'o', ts: '2026-09-20T10:00:00Z', kind: 'approval', n: 123, pid: 901 };
  var newer = { schema: 1, localOnly: true, id: 'w', ts: '2026-09-25T13:42:00Z', kind: 'tsp', n: 123, pid: 901 };
  var two = h1.paHistFor([older, newer], 123, 901);
  var row = h1.paHistCellHtml(two);
  A.ok('Compare row carries the "Local record" qualifier', /^Local record: /.test(row));
  A.ok('Compare row shows the NEWEST action first', row.indexOf('Local record: Sent to TSP') === 0);
  A.ok('several records -> a disclosure lists them all', /<details><summary>2 local records<\/summary>/.test(row) && row.indexOf('Marked good to submit') !== -1);
  A.ok('no history -> labelled, not blank', /none in this browser/.test(h1.paHistCellHtml([])));
  A.ok('other proposals on the job get none of this proposal\'s history', h1.paHistFor([older, newer], 123, 902).length === 0);
  var single = mkPlan(h1, 'approval', 'pa-v', []);
  single.ctx.siblings = { rows: [h1.proposalRow(RICH[0])], rowCount: 1, partial: false };
  var hs = hload(mkStore({ 'bwn:pa:history': JSON.stringify([newer]) }));
  var dlg = hs.confirmSummaryHtml(single);
  A.ok('confirm shows the local-history warning', dlg.indexOf('Local history shows this proposal was previously sent to TSP on') !== -1 && dlg.indexOf('not an authoritative Umbrava status') !== -1);
  A.ok('the warning does not block Confirm (no acknowledgement checkbox on a single-option job)', dlg.indexOf('bwn-pa-ack') === -1);
  var hNone = hload(mkStore());
  A.ok('no history -> no warning (single-proposal dialog unchanged)', hNone.confirmSummaryHtml(single).indexOf('Local history') === -1);

  // ---- confirm run lifecycle: single-flight + no dismissal mid-run (0.7.4) --------------------
  function flush() { return new Promise(function (r) { setImmediate(r); }); }
  function deferred() { var d = {}; d.p = new Promise(function (res, rej) { d.resolve = res; d.reject = rej; }); return d; }
  function el(extra) { return Object.assign({ disabled: false, textContent: 'Confirm', value: '', checked: false }, extra || {}); }
  function mkDialog(bx, kind, runs, withAck) {
    // runs: one function per step returning a promise; counted so a re-sent step is visible.
    var calls = runs.map(function () { return 0; });
    var plan = mkPlan(bx, kind, 'pa-life-' + kind, runs.map(function (fn, i) { return function () { calls[i]++; return fn(); }; }));
    var d = {
      plan: plan, calls: calls, closed: 0,
      goBtn: el(), cancelBtn: el({ textContent: 'Cancel' }), noteTa: el({ value: 'TSP Review - Low GP' }),
      ack: withAck ? el({ checked: true }) : null,
      stepEls: runs.map(function () { return fakeLi(); })
    };
    d.ctl = bx.paConfirmController(plan, d, function () { d.closed++; });
    return d;
  }

  // pre-run Cancel still closes
  var hc = hload(mkStore());
  var dc = mkDialog(hc, 'tsp', [okStep], true);
  A.ok('pre-run: Cancel / Escape / backdrop close the dialog as before', dc.ctl.requestClose() === true && dc.closed === 1);

  // a held-pending run: repeated clicks + acknowledgement toggles start ONE run, and nothing closes it
  var sL = mkStore();
  var hl = hload(sL);
  var hold = deferred();
  var failOnce2 = true;
  var dl = mkDialog(hl, 'tsp', [function () { return hold.p; }, function () {
    if (failOnce2) { failOnce2 = false; return Promise.reject(new Error('HTTP 500')); }
    return Promise.resolve(true);
  }, okStep], true);
  var firstRun = dl.ctl.go();
  A.ok('Confirm starts a run', !!firstRun && dl.ctl.state() === 'running');
  for (var k = 0; k < 5; k++) dl.ctl.go();
  dl.ack.checked = false; dl.ctl.ackChanged();
  dl.ack.checked = true; dl.ctl.ackChanged();
  A.ok('acknowledgement toggles mid-run do not re-enable Confirm', dl.goBtn.disabled === true);
  dl.ctl.go(); dl.ctl.go();
  await flush();
  A.eq('repeated Confirm clicks + ack toggles while pending -> step 1 sent exactly once', dl.calls, [1, 0, 0]);
  A.ok('acknowledgement checkbox is disabled during the run', dl.ack.disabled === true);
  A.ok('Cancel, note and Confirm are disabled during the run', dl.cancelBtn.disabled && dl.noteTa.disabled && dl.goBtn.disabled);
  A.ok('Escape / backdrop / Cancel cannot close a running dialog', dl.ctl.requestClose() === false && dl.ctl.requestClose() === false && dl.closed === 0);

  // the run fails at step 2 -> retryable, closeable, nothing overlapping
  hold.resolve(true);
  await firstRun;
  A.ok('failed run -> idle and retryable', dl.ctl.state() === 'idle' && dl.goBtn.textContent === 'Retry' && dl.goBtn.disabled === false);
  A.ok('failed run -> Cancel and acknowledgement re-enabled', dl.cancelBtn.disabled === false && dl.ack.disabled === false);
  A.eq('failed run -> no local history record', stored(sL).length, 0);
  A.eq('failed run sent step 1 and step 2 once each, step 3 not at all', dl.calls, [1, 1, 0]);
  A.ok('failure is reported', hl.toasts.some(function (t) { return /Stopped at "step 1": HTTP 500/.test(t); }));

  // Retry resumes from the first unfinished step, once, even with repeated clicks
  var retryRun = dl.ctl.go();
  dl.ctl.go(); dl.ctl.go();
  A.ok('Retry -> running again, closing refused', dl.ctl.state() === 'running' && dl.ctl.requestClose() === false);
  await retryRun;
  A.eq('Retry resumed from the failed step (step 1 not re-sent), each remaining step once', dl.calls, [1, 2, 1]);
  A.ok('successful Retry -> done', dl.ctl.state() === 'done' && dl.goBtn.textContent === 'Done');
  A.eq('successful completion writes exactly one local history record', stored(sL).length, 1);
  dl.ack.checked = false; dl.ctl.ackChanged(); dl.ack.checked = true; dl.ctl.ackChanged();
  A.ok('after Done the acknowledgement cannot re-enable Confirm', dl.goBtn.disabled === true);
  A.ok('after Done a further Confirm is ignored', dl.ctl.go() === null);
  await flush();
  A.eq('after Done nothing is re-sent and no second record is written', [dl.calls, stored(sL).length], [[1, 2, 1], 1]);
  A.ok('auto-close after success is still scheduled', hl.timers.some(function (t) { return t.ms === 2200; }));
  A.ok('a finished dialog closes normally', dl.ctl.requestClose() === true && dl.closed === 1);

  // single-proposal dialog (no acknowledgement) keeps the same guard
  var hs1 = hload(mkStore());
  var hold1 = deferred();
  var ds = mkDialog(hs1, 'approval', [function () { return hold1.p; }], false);
  var runS = ds.ctl.go(); ds.ctl.go(); ds.ctl.go();
  await flush();
  A.eq('single-proposal: repeated Confirm while pending -> one send', ds.calls, [1]);
  A.ok('single-proposal: cannot close while pending', ds.ctl.requestClose() === false);
  hold1.resolve(true); await runS;
  A.ok('single-proposal: completes normally', ds.ctl.state() === 'done');

  // unchanged pre-run gates
  var hg = hload(mkStore());
  var dg = mkDialog(hg, 'tsp', [okStep], true);
  dg.ack.checked = false;
  A.ok('unticked acknowledgement still blocks Confirm', dg.ctl.go() === null && dg.calls[0] === 0 && dg.ctl.state() === 'idle');
  var dn = mkDialog(hg, 'tsp', [okStep], false);
  dn.noteTa.value = '   ';
  A.ok('empty note still blocks Confirm with the same message', dn.ctl.go() === null && hg.toasts.indexOf('Enter a note first.') !== -1 && dn.ctl.state() === 'idle');

  // kickback reason gate (0.7.12): Confirm refuses a kickback whose note carries no reason. The gate
  // itself (what counts as a reason) is pinned in test-pa-kickback.js; this pins the wiring.
  function kload(runnerSrc) {
    var t = [];
    var bx = load(READS + (runnerSrc || RUNNER) + DISPLAY + KICKBACK, {}, { localStorage: mkStore(), paToast: function (m) { t.push(m); }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { } });
    bx.toasts = t;
    return bx;
  }
  var SUMMARY_ONLY = '\n\nSummary\nTotal\n$12,345.00';
  var hk = kload();
  var dk1 = mkDialog(hk, 'kickback', [okStep], false);
  dk1.noteTa.value = SUMMARY_ONLY;
  A.ok('kickback: Summary/Total only -> Confirm refused, nothing runs, reviewer told why',
    dk1.ctl.go() === null && dk1.calls[0] === 0 && dk1.ctl.state() === 'idle' && hk.toasts.some(function (m) { return /Write the reason for the kickback first/.test(m); }));
  var dk2 = mkDialog(hk, 'kickback', [okStep], false);
  dk2.noteTa.value = 'Changes since review opened: lowered total $520.00, GP 39.4% -> 19.1%.\n\n' + hk.PA_KB_PH_READ + SUMMARY_ONLY;
  A.ok('kickback: untouched placeholder -> Confirm refused with the replace-the-placeholder message',
    dk2.ctl.go() === null && dk2.calls[0] === 0 && hk.toasts.some(function (m) { return /Replace the placeholder/.test(m); }));
  var dk3 = mkDialog(hk, 'kickback', [okStep], false);
  dk3.noteTa.value = 'Need photos of the mixing valve.' + SUMMARY_ONLY;
  await dk3.ctl.go();
  A.ok('kickback: a reviewer-written reason -> Confirm runs', dk3.calls[0] === 1 && dk3.ctl.state() === 'done');
  var dk4 = mkDialog(hk, 'tsp', [okStep], false);
  dk4.noteTa.value = SUMMARY_ONLY;
  await dk4.ctl.go();
  A.ok('TSP (and Approval) are not gated: a Summary-only note still runs', dk4.calls[0] === 1 && dk4.ctl.state() === 'done');
  var hkN = kload(mutate(RUNNER, "var kbGap = plan.kind === 'kickback' ? paKickbackReasonGap(noteText) : '';", "var kbGap = '';"));
  var dkN = mkDialog(hkN, 'kickback', [okStep], false);
  dkN.noteTa.value = SUMMARY_ONLY;
  await dkN.ctl.go();
  A.ok('CONTROL: without the gate a Summary-only kickback goes out', dkN.calls[0] === 1);

  // negative controls: each guard is load-bearing
  var RUN_NOSF = mutate(RUNNER, "if (state !== 'idle') return null;   // a run is in flight or already done", '');
  var hN = load(READS + RUN_NOSF + DISPLAY, {}, { localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { } });
  var holdN = deferred();
  var dN = mkDialog(hN, 'tsp', [function () { return holdN.p; }], false);
  dN.ctl.go(); dN.ctl.go();
  await flush();
  A.ok('CONTROL: without the state check a second click starts an overlapping run', dN.calls[0] === 2);
  holdN.resolve(true);
  var RUN_NOCLOSE = mutate(RUNNER, "if (state === 'running') return false;\n      closeFn();", 'closeFn();');
  var hN2 = load(READS + RUN_NOCLOSE + DISPLAY, {}, { localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { } });
  var holdN2 = deferred();
  var dN2 = mkDialog(hN2, 'tsp', [function () { return holdN2.p; }], false);
  dN2.ctl.go();
  A.ok('CONTROL: without the close guard a running dialog can be dismissed', dN2.ctl.requestClose() === true && dN2.closed === 1);
  holdN2.resolve(true);
  var RUN_NOACK = mutate(RUNNER, "if (state === 'idle' && acks.length) goBtn.disabled = !allAcked();", 'if (acks.length) goBtn.disabled = !allAcked();');
  var hN3 = load(READS + RUN_NOACK + DISPLAY, {}, { localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { } });
  var holdN3 = deferred();
  var dN3 = mkDialog(hN3, 'tsp', [function () { return holdN3.p; }], true);
  dN3.ctl.go(); dN3.ack.checked = true; dN3.ctl.ackChanged();
  A.ok('CONTROL: without the idle check the acknowledgement re-enables Confirm mid-run', dN3.goBtn.disabled === false);
  holdN3.resolve(true);

  // wiring: every dismissal path and Confirm route through the controller
  A.ok('Escape routes through requestClose', /function onKey\(e\) \{ if \(e\.key === 'Escape'\) ctl\.requestClose\(\); \}/.test(full));
  A.ok('backdrop routes through requestClose', /if \(e\.target === overlay\) ctl\.requestClose\(\);/.test(full));
  A.ok('Cancel routes through requestClose', /cancelBtn\.addEventListener\('click', ctl\.requestClose\);/.test(full));
  A.ok('Confirm routes through the controller', /goBtn\.addEventListener\('click', ctl\.go\);/.test(full));
  A.ok('both acknowledgement checkboxes route their change through the controller', /\[ack, ackStopped\]\.forEach\(function \(a\) \{\n      if \(!a\) return;\n      goBtn\.disabled = true;\n      a\.addEventListener\('change', ctl\.ackChanged\);/.test(full));
  var confirmBody = full.slice(full.indexOf('  function openConfirm(plan) {'), full.indexOf('  function mark(li, cls, icon, note)'));
  A.ok('openConfirm no longer calls runSteps or close() directly from a handler', confirmBody.indexOf('runSteps(') === -1 && !/addEventListener\([^)]*\bclose\)/.test(confirmBody));

  // ---- active-run overlay guard + focus trap (0.7.5) ---------------------------------------------
  // Loads the REAL entry points (openConfirm, startWorkflow, openCompare, renderCompare, buildMenu)
  // and the REAL paste-identical bwnFocusTrap alongside the controller/guard, with stub collaborators
  // that COUNT: any read (gatherContext / readWO), any DOM build (ensureStyle is the first DOM step of
  // both overlays), any menu build (closeMenu is buildMenu's first step), any prior-overlay removal.
  function sliceFn(src, decl) {
    var a = src.indexOf(decl); if (a === -1) throw new Error('function not found: ' + decl);
    var depth = 0, i = src.indexOf('{', a);
    for (var j = i; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); } }
    throw new Error('unbalanced ' + decl);
  }
  var ENTRY = [
    between('  // ===== confirm modal', '  function mark(li, cls, icon, note)'),
    sliceFn(full, 'function startWorkflow(kind)'),
    sliceFn(full, 'function openCompare()'),
    sliceFn(full, 'function renderCompare(n, pid, wo, sib)'),
    sliceFn(full, 'function buildMenu(trigger)'),
    sliceFn(full, 'function bwnFocusTrap(modalEl)')
  ].join('\n');
  function eload(runnerSrc) {
    var c = { built: 0, reads: 0, menus: 0, toasts: [] };
    var trigger = { _name: 'trigger', isConnected: true, focus: function () { doc.activeElement = this; } };
    var doc = {
      activeElement: null, _overlay: null,
      getElementById: function (id) { return id === 'bwn-pa-overlay' ? this._overlay : null; },
      querySelector: function (s) { return s === '#bwn-pa-dropdown .bwn-pa-trigger' ? trigger : null; },
      createElement: function () { c.built++; throw new Error('DOM_BUILD'); },
      addEventListener: function () { }, removeEventListener: function () { }
    };
    function FakeMO() { } FakeMO.prototype.observe = function () { }; FakeMO.prototype.disconnect = function () { };
    var bx = load(READS + (runnerSrc || RUNNER) + DISPLAY + ENTRY, {}, {
      localStorage: mkStore(), document: doc, MutationObserver: FakeMO,
      paToast: function (m) { c.toasts.push(m); },
      woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; },
      setTimeout: function () { },
      ensureStyle: function () { c.built++; throw new Error('DOM_BUILD'); },
      closeMenu: function () { c.menus++; throw new Error('MENU_BUILD'); },
      gatherContext: function () { c.reads++; return new Promise(function () { }); },
      readWO: function () { c.reads++; return new Promise(function () { }); }
    });
    bx.c = c; bx.doc = doc; bx.trigger = trigger;
    return bx;
  }
  function fakeOverlay() {
    return { closed: 0, removed: 0, _paClose: function () { this.closed++; }, remove: function () { this.removed++; } };
  }
  function attempt(fn) { try { fn(); return 'returned'; } catch (e) { return String(e.message); } }
  // What openConfirm does on open: register the controller + give the overlay its close path.
  function showRunning(bx, hold) {
    var d = mkDialog(bx, 'tsp', [function () { return hold.p; }, okStep], true);
    var ov = fakeOverlay();
    bx.doc._overlay = ov;
    bx._paActiveCtl = d.ctl;
    var run = d.ctl.go();
    return { d: d, ov: ov, run: run };
  }
  var otherPlan = function (bx) { return mkPlan(bx, 'approval', 'pa-other', [okStep]); };

  var eb = eload();
  var holdE = deferred();
  var R = showRunning(eb, holdE);
  A.ok('guard sees the in-flight run', eb.paRunBusy() === true);
  var tries = [
    ['menu (trigger click / keyboard Enter)', function () { eb.buildMenu({}); }],
    ['Compare menu item', function () { eb.openCompare(); }],
    ['Compare render (late read result)', function () { eb.renderCompare(123, 901, { statusName: 'x' }, { rows: [], rowCount: 0, partial: false }); }],
    ['Approval / TSP / Kickback menu item', function () { eb.startWorkflow('approval'); }],
    ['a new confirmation (late gatherContext result)', function () { eb.openConfirm(otherPlan(eb)); }]
  ];
  tries.forEach(function (t) { A.eq('blocked while running: ' + t[0], attempt(t[1]), 'returned'); });
  await flush();
  A.eq('blocked attempts built no overlay, no menu, and issued no read', [eb.c.built, eb.c.menus, eb.c.reads], [0, 0, 0]);
  A.eq('the running dialog was neither closed nor removed', [R.ov.closed, R.ov.removed], [0, 0]);
  A.ok('the running dialog is still the one on screen', eb.doc.getElementById('bwn-pa-overlay') === R.ov && eb._paActiveCtl === R.d.ctl);
  A.eq('five blocked attempts -> one "still running" notice (no toast storm)', eb.c.toasts.filter(function (m) { return /still running/.test(m); }).length, 1);
  A.eq('only the original run proceeds (its first step sent once, nothing else started)', R.d.calls, [1, 0]);

  // original run fails -> dialog stays, retryable; with no run in flight, navigation works again
  holdE.reject(new Error('HTTP 502'));
  await R.run;
  A.ok('failed run: dialog still on screen and retryable', eb.doc.getElementById('bwn-pa-overlay') === R.ov && R.d.ctl.state() === 'idle' && R.d.goBtn.textContent === 'Retry');
  A.ok('failed run: guard releases (not busy)', eb.paRunBusy() === false);
  A.eq('idle: menu opens again', attempt(function () { eb.buildMenu({}); }), 'MENU_BUILD');
  A.eq('idle: Compare reads again', [attempt(function () { eb.openCompare(); }), eb.c.reads], ['returned', 1]);
  A.eq('idle: a new action starts its reads again', [attempt(function () { eb.startWorkflow('tsp'); }), eb.c.reads], ['returned', 2]);
  A.eq('idle: a new confirmation replaces the failed dialog through its own close path', [attempt(function () { eb.openConfirm(otherPlan(eb)); }), R.ov.closed], ['DOM_BUILD', 1]);

  // Retry of the original still single-flights and blocks replacement again
  eb.doc._overlay = R.ov; eb._paActiveCtl = R.d.ctl;
  var holdR = deferred();
  R.d.plan.steps[0].run = function () { R.d.calls[0]++; return holdR.p; };
  var retryE = R.d.ctl.go();
  A.ok('Retry -> busy again, replacement refused', eb.paRunBusy() === true && attempt(function () { eb.openConfirm(otherPlan(eb)); }) === 'returned' && R.ov.closed === 1);
  holdR.resolve(true);
  await retryE;
  A.ok('Retry completes', R.d.ctl.state() === 'done' && eb.paRunBusy() === false);

  // negative control: remove the shared guard, keep the focus trap -> replacement becomes possible
  var RUN_NOGUARD = mutate(RUNNER, 'function paRefuseWhileRunning() {\n    if (!paRunBusy()) return false;', 'function paRefuseWhileRunning() {\n    return false;');
  var nb = eload(RUN_NOGUARD);
  var holdNB = deferred();
  var RN = showRunning(nb, holdNB);
  var nbRes = attempt(function () { nb.openConfirm(otherPlan(nb)); });
  A.ok('CONTROL: without the entry-point guard a new confirmation closes the RUNNING dialog', RN.ov.closed === 1 && nbRes === 'DOM_BUILD' && RN.d.ctl.state() === 'running');
  A.ok('CONTROL: ...and a new action starts reading mid-run', attempt(function () { nb.startWorkflow('approval'); }) === 'returned' && nb.c.reads === 1);
  holdNB.resolve(true);

  // focus: the REAL bwnFocusTrap armed by paArmTrap, on a fake confirmation overlay
  var fb = eload();
  function focusable(name) { return { _name: name, offsetWidth: 10, offsetHeight: 10, isConnected: true, getClientRects: function () { return [{}]; }, focus: function () { fb.doc.activeElement = this; } }; }
  var kids = [focusable('ack'), focusable('note'), focusable('cancel'), focusable('confirm')];
  var keyHandlers = [];
  var fov = {
    _attrs: {}, parentNode: {}, classList: { contains: function () { return false; } },
    addEventListener: function (t, fn) { if (t === 'keydown') keyHandlers.push(fn); },
    removeEventListener: function (t, fn) { keyHandlers = keyHandlers.filter(function (h) { return h !== fn; }); },
    querySelectorAll: function () { return kids.slice(); },
    contains: function (n) { return kids.indexOf(n) !== -1; },
    hasAttribute: function (k) { return k in this._attrs; }, setAttribute: function (k, v) { this._attrs[k] = v; }, focus: function () { fb.doc.activeElement = this; }
  };
  function key(shift) { var ev = { key: 'Tab', shiftKey: shift, _pd: false, preventDefault: function () { this._pd = true; } }; keyHandlers.forEach(function (h) { h(ev); }); return ev; }
  fb.doc.activeElement = null;   // the menu item that started the action has already been removed
  var release = fb.paArmTrap(fov);
  A.eq('open: focus moves into the dialog (first control)', fb.doc.activeElement && fb.doc.activeElement._name, 'ack');
  fb.doc.activeElement = kids[3];
  var evT = key(false);
  A.ok('Tab on the last control wraps to the first', evT._pd === true && fb.doc.activeElement === kids[0]);
  var evS = key(true);
  A.ok('Shift+Tab on the first control wraps to the last', evS._pd === true && fb.doc.activeElement === kids[3]);
  fb.doc.activeElement = kids[1];
  var evMid = key(false);
  A.ok('Tab in the middle is left to the browser (not swallowed)', evMid._pd === false);
  release();
  A.ok('ordinary close returns focus to the Proposal Actions trigger', fb.doc.activeElement === fb.trigger);
  A.eq('close removes the trap key handler', keyHandlers.length, 0);
  // while running every control is disabled: focus is parked on the card so Tab stays contained
  var cardFocus = { tab: null, focused: 0, setAttribute: function (k, v) { if (k === 'tabindex') this.tab = v; }, focus: function () { this.focused++; } };
  var holdF = deferred();
  var dF = mkDialog(fb, 'tsp', [function () { return holdF.p; }], false);
  dF.card = cardFocus;
  var runF = dF.ctl.go();
  A.ok('run start parks focus on the dialog card (tabindex=-1)', cardFocus.focused === 1 && cardFocus.tab === '-1');
  holdF.resolve(true); await runF;

  // wiring the tests above rely on
  A.ok('openConfirm registers its controller and close path for the guard', /_paActiveCtl = ctl;\n    overlay\._paClose = close;/.test(full));
  A.ok('openConfirm close clears the registration and releases the trap', /if \(_paActiveCtl === ctl\) _paActiveCtl = null;\n      try \{ releaseTrap\(\); \}/.test(full));
  A.ok('openConfirm and renderCompare take the overlay slot instead of removing the prior overlay', (full.match(/if \(!paTakeOverlaySlot\(\)\) return;/g) || []).length === 2 && full.indexOf("if (prior) prior.remove();") === -1);
  A.ok('Compare overlay also exposes its close path', (full.match(/overlay\._paClose = close;/g) || []).length === 2);

  // ---- stopped-attempt warning, C3 (0.7.6) ---------------------------------------------------------
  var SKEY = 'bwn:pa:stopped';
  var STEP_KEYS = ['status', 'proposalNote', 'woNote', 'completeTasks', 'createTask'];
  function stoppedRecs(store) { return store.map[SKEY] == null ? [] : JSON.parse(store.map[SKEY]); }
  // A dialog whose plan has the real step keys; runs[i] returns a promise. calls[i] counts sends.
  function mkStopDialog(bx, kind, pid, runs, stopAck) {
    var calls = runs.map(function () { return 0; });
    var plan = mkPlan(bx, kind, 'pa-stop-' + kind + '-' + pid + '-' + Math.random().toString(36).slice(2, 6), []);
    plan.ctx.pid = pid;
    plan.steps = runs.map(function (fn, i) {
      return { key: STEP_KEYS[i], label: 'Create task for Lisa: SECRET NOTE LINE ' + i, run: function () { calls[i]++; return fn(); } };
    });
    var d = { plan: plan, calls: calls, closed: 0, goBtn: el(), cancelBtn: el({ textContent: 'Cancel' }),
      noteTa: el({ value: 'SECRET NOTE BODY' }), ack: null, ackStopped: stopAck ? el({ checked: false }) : null,
      stepEls: runs.map(function () { return fakeLi(); }) };
    d.ctl = bx.paConfirmController(plan, d, function () { d.closed++; });
    return d;
  }
  function failN(n) { var left = n; return function () { if (left > 0) { left--; return Promise.reject(new Error('HTTP 500')); } return Promise.resolve(true); }; }
  var s9 = mkStore();
  var b9 = hload(s9);
  var woFail = failN(1);
  var dA = mkStopDialog(b9, 'tsp', 901, [okStep, okStep, woFail, okStep, okStep], false);
  var resA = await dA.ctl.go();
  A.ok('run stops at step 3 (WO note)', resA.ok === false && dA.ctl.state() === 'idle');
  var recs9 = stoppedRecs(s9);
  A.eq('stop -> one stopped-attempt record', recs9.length, 1);
  A.eq('record identity: job + proposal + action', [recs9[0].n, recs9[0].pid, recs9[0].kind], [123, 901, 'tsp']);
  A.eq('record lists ONLY the steps the runner saw succeed', recs9[0].done, ['status', 'proposalNote']);
  A.eq('record names the failed step; later steps absent', [recs9[0].failed, recs9[0].done.indexOf('completeTasks'), recs9[0].done.indexOf('createTask')], ['woNote', -1, -1]);
  A.eq('record: schema, localOnly, attempts, ISO time', [recs9[0].schema, recs9[0].localOnly, recs9[0].attempts, !isNaN(Date.parse(recs9[0].ts))], [1, true, 1, true]);
  A.ok('record stores no note text and no step labels', s9.map[SKEY].indexOf('SECRET') === -1 && s9.map[SKEY].indexOf('Create task for') === -1);
  A.eq('a stop is NOT completed-action history', stored(s9).length, 0);

  // Cancel, a page refresh (fresh script instance, same storage) and reopening keep the warning
  A.ok('Cancel after the stop closes the dialog', dA.ctl.requestClose() === true);
  A.eq('Cancel does not erase the record', stoppedRecs(s9).length, 1);
  var b9r = hload(s9);   // refresh: new instance, same localStorage
  var reopen = b9r.confirmSummaryHtml(mkStopDialog(b9r, 'tsp', 901, [okStep], true).plan);
  A.ok('new dialog (same job/proposal/action) shows the stopped-attempt warning', /Stopped attempt \(this browser\)/.test(reopen) && /a previous TSP Review run on this proposal stopped on /.test(reopen));
  A.ok('warning names the steps seen complete and the failed step', reopen.indexOf('saw these steps complete: WO status change, proposal note.') !== -1 && reopen.indexOf('stopped at the WO note; that request may or may not have reached Umbrava') !== -1);
  A.ok('warning says a new run starts at step one and may repeat the note/task', /starts again at the first step/.test(reopen) && /proposal note and the new task are not de-duplicated/.test(reopen));
  A.ok('warning requires its own acknowledgement', reopen.indexOf('id="bwn-pa-ack-stopped"') !== -1);
  A.ok('warning does not claim to be Umbrava status or completed history', reopen.indexOf('Local history shows') === -1);
  A.ok('different proposal on the job -> no stopped warning', b9r.confirmSummaryHtml(mkStopDialog(b9r, 'tsp', 902, [okStep], false).plan).indexOf('Stopped attempt') === -1);
  A.ok('different action on the same proposal -> no stopped warning', b9r.confirmSummaryHtml(mkStopDialog(b9r, 'approval', 901, [okStep], false).plan).indexOf('Stopped attempt') === -1);

  // the new dialog cannot start until the stopped-attempt box is ticked; ticking alone erases nothing
  var dB = mkStopDialog(b9r, 'tsp', 901, [okStep, okStep, okStep, okStep, okStep], true);
  dB.goBtn.disabled = true;
  A.ok('unticked stopped-attempt acknowledgement blocks the fresh run', dB.ctl.go() === null && dB.calls[0] === 0);
  dB.ackStopped.checked = true; dB.ctl.ackChanged();
  A.ok('ticking it enables Confirm', dB.goBtn.disabled === false);
  A.eq('acknowledgement alone does not erase the record', stoppedRecs(s9).length, 1);

  // Retry in the ORIGINAL dialog resumes at the WO note and resolves the warning on success
  var resRetry = await dA.ctl.go();
  A.ok('original-dialog Retry needs no new acknowledgement and completes', resRetry.ok === true && dA.ctl.state() === 'done');
  A.eq('Retry resumed at the failed step (status + proposal note not re-sent)', dA.calls, [1, 1, 2, 1, 1]);
  A.eq('successful Retry resolves the stopped-attempt record', stoppedRecs(s9).length, 0);
  A.eq('successful Retry writes completed-action history exactly once', stored(s9).length, 1);

  // a stop, then a NEW dialog that also stops (merged), then a new dialog that completes (resolves)
  var s10 = mkStore();
  var b10 = hload(s10);
  var d1 = mkStopDialog(b10, 'approval', 901, [okStep, failN(1)], false);
  await d1.ctl.go();
  var d2 = mkStopDialog(b10, 'approval', 901, [okStep, okStep, failN(5)], true);
  d2.ackStopped.checked = true;
  await d2.ctl.go();
  var m10 = stoppedRecs(s10);
  A.eq('second stop of the same action merges: attempts 2, done steps unioned', [m10.length, m10[0].attempts, m10[0].done.sort().join(','), m10[0].failed], [1, 2, 'proposalNote,status', 'woNote']);
  var d3 = mkStopDialog(b10, 'approval', 901, [okStep, okStep, okStep], true);
  d3.ackStopped.checked = true;
  var r3 = await d3.ctl.go();
  A.eq('NEGATIVE-CONTROL premise: a fresh dialog run starts at step one again', d3.calls, [1, 1, 1]);
  A.ok('a later completed run in a new dialog resolves the warning', r3.ok === true && stoppedRecs(s10).length === 0);
  A.eq('...and writes completed-action history exactly once', stored(s10).length, 1);
  var s11b = mkStore(), b11b = hload(s11b);
  // the other proposal's stop (recorded directly: this harness's URL stub is on #901, so a #902 dialog is refused by the wrong-page check)
  var p902 = mkStopDialog(b11b, 'tsp', 902, [failN(1)], false);
  p902.stepEls[0].className = 'err';
  A.eq('a #902 stop records', b11b.paStopOnResult(p902.plan, { ok: false, failedLabel: 'x', error: 'HTTP 500' }, p902.stepEls, NOW), 'recorded');
  await mkStopDialog(b11b, 'tsp', 901, [failN(1)], false).ctl.go();
  var dd11 = mkStopDialog(b11b, 'tsp', 901, [okStep], true); dd11.ackStopped.checked = true;
  await dd11.ctl.go();
  A.eq('resolving one proposal keeps the other proposal\'s stopped record', stoppedRecs(s11b).map(function (r) { return r.pid; }), [902]);

  // corrupt / blocked storage never blocks the action, and says so truthfully (once, inline)
  var s12 = mkStore({ 'bwn:pa:stopped': '{not json' });
  var b12 = hload(s12);
  var d12 = mkStopDialog(b12, 'tsp', 901, [okStep], false);
  var html12 = b12.confirmSummaryHtml(d12.plan);
  A.ok('corrupt store -> inline "could not be checked", no false all-clear', /Earlier stopped attempts could not be checked \(the local record is unreadable\)\. That does not mean no earlier attempt happened\./.test(html12));
  A.ok('corrupt store -> no stopped acknowledgement required', html12.indexOf('bwn-pa-ack-stopped') === -1);
  A.ok('corrupt store -> the action still runs and completes', (await d12.ctl.go()).ok === true);
  var s13 = mkStore({}, { throwGet: true, throwSet: true });
  var b13 = hload(s13);
  A.ok('blocked storage -> inline "browser storage is unavailable"', /browser storage is unavailable/.test(b13.confirmSummaryHtml(mkStopDialog(b13, 'tsp', 901, [okStep], false).plan)));
  var d13 = mkStopDialog(b13, 'tsp', 901, [failN(1)], false);
  var r13 = await d13.ctl.go();
  A.ok('blocked storage -> the stop is still reported to the reviewer, retry still offered', r13.ok === false && d13.goBtn.textContent === 'Retry');
  A.ok('blocked storage -> the toast says the stopped-attempt record could not be saved', b13.toasts.some(function (t) { return /The stopped-attempt record could not be saved in this browser/.test(t); }));
  var d13b = mkStopDialog(b13, 'tsp', 901, [okStep], false);
  A.ok('blocked storage -> a later action still completes', (await d13b.ctl.go()).ok === true);
  A.eq('hostile / stale stored records are dropped, not rendered', (function () {
    var s14 = mkStore({ 'bwn:pa:stopped': JSON.stringify([
      { schema: 1, localOnly: true, n: 123, pid: 901, kind: 'tsp', ts: '2026-09-25T10:00:00Z', attempts: 1, failed: '<img src=x onerror=alert(1)>', done: [] },
      { schema: 0, localOnly: true, n: 123, pid: 901, kind: 'tsp', ts: '2026-09-25T10:00:00Z', attempts: 1, failed: '', done: [] },
      { schema: 1, localOnly: true, n: 123, pid: 901, kind: 'tsp', ts: '2026-09-25T10:00:00Z', attempts: 1, failed: 'woNote', done: ['<b>x</b>', 'status'] }
    ]) });
    var b14 = hload(s14);
    var recs14 = b14.paStopLoad().records;
    var h14 = b14.paStopWarnHtml(recs14[0], '', 'tsp').html;
    return [recs14.length, h14.indexOf('<b>') === -1 && h14.indexOf('&lt;b&gt;') === -1 && h14.indexOf('WO status change') !== -1];
  })(), [1, true]);
  var sKeep = mkStore({ 'bwn:pa:history': '[]', 'bwn:audit': '[7]' });
  var bKeep = hload(sKeep);
  await mkStopDialog(bKeep, 'tsp', 901, [failN(1)], false).ctl.go();
  A.eq('stopped-attempt writes touch only bwn:pa:stopped', [sKeep.map['bwn:pa:history'], sKeep.map['bwn:audit']], ['[]', '[7]']);

  // negative control: without the new-dialog warning a fresh run begins at step one, unwarned
  var DISPLAY_NOSTOP = mutate(DISPLAY, "    html += paStopWarnHtml(paStopFind(stop.records, c.n, c.pid, plan.kind), stop.error, plan.kind).html;\n", '');
  var sNC = mkStore();
  var bNC = load(READS + RUNNER + DISPLAY_NOSTOP, {}, { localStorage: sNC, paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { } });
  await mkStopDialog(bNC, 'tsp', 901, [okStep, okStep, failN(1)], false).ctl.go();
  var planNC = mkStopDialog(bNC, 'tsp', 901, [okStep, okStep, okStep], false);
  var htmlNC = bNC.confirmSummaryHtml(planNC.plan);
  A.ok('CONTROL: without the warning the new dialog renders no stopped acknowledgement', htmlNC.indexOf('bwn-pa-ack-stopped') === -1 && htmlNC.indexOf('Stopped attempt') === -1);
  await planNC.ctl.go();
  A.eq('CONTROL: ...and its fresh run re-sends the already-completed first steps unwarned', planNC.calls, [1, 1, 1]);

  // wiring
  A.eq('stopped-attempt record written/resolved from exactly one place (after every runSteps result)', (full.match(/paStopOnResult\(plan, res, els\.stepEls, Date\.now\(\)\)/g) || []).length, 1);
  A.ok('openConfirm passes the stopped acknowledgement into the controller', /ackStopped: ackStopped/.test(full) && /card\.querySelector\('#bwn-pa-ack-stopped'\)/.test(full));
  A.ok('every step builder carries its stable key', ['status', 'proposalNote', 'woNote', 'completeTasks', 'createTask'].every(function (k) { return full.indexOf("key: '" + k + "'") !== -1; }));

  // ---- visible proposal number (0.7.7) ------------------------------------------------------------
  var bNum = load(READS, { PA_Siblings: function () { return LIVE_MULTI; } });
  var liveN = await bNum.readJobProposals(1329644);
  A.ok('extended read asks for number', /items \{ id number description/.test(bNum.calls[0].q));
  A.eq('live pairs parsed: id -> visible number', liveN.rows.map(function (r) { return [r.id, r.number]; }), [[560948, 1], [561841, 2], [561850, 3]]);
  A.eq('invalid numbers are dropped, never coerced', ['2', 0, -1, 2.5, null, undefined, NaN, {}].map(function (v) { return bNum.proposalRow({ id: 7, number: v }).number; }), [null, null, null, null, null, null, null, null]);
  var bNumF = load(READS, { PA_Siblings: function () { throw new Error('Cannot query field "number"'); }, PA_SiblingsMin: function () { return list([{ id: 561841, total: money$(1) }]); } });
  var sibNF = await bNumF.readJobProposals(1329644);
  A.ok('fallback query stays number-free and unchanged', !/number/.test(bNumF.calls[1].q) && sibNF.partial === true && sibNF.rows[0].number === null);
  var hN = hload(mkStore());
  A.eq('label: proven number -> "#2 (ID 561841)"', hN.propLabel({ number: 2 }, 561841), '#2 (ID 561841)');
  A.eq('label: no number -> id only, exactly as before', [hN.propLabel({ number: null }, 561841), hN.propLabel(null, 561841), hN.propLabel({}, 561841)], ['#561841', '#561841', '#561841']);
  // confirm summary on the live 3-option job, acting on 561841 (visible #2)
  var pNum = mkPlan(hN, 'tsp', 'pa-num', []);
  pNum.ctx.pid = 561841;
  pNum.ctx.siblings = { rows: LIVE_MULTI.listClientProposals.items.map(hN.proposalRow), rowCount: 3, partial: false };
  var htmlNum = hN.confirmSummaryHtml(pNum);
  A.ok('summary names the selected proposal by number AND id', htmlNum.indexOf('<dt>Proposal</dt><dd>#2 (ID 561841) - ') !== -1);
  A.ok('other-options warning: "Only #2 (ID 561841) gets the proposal note"', htmlNum.indexOf('Only #2 (ID 561841) gets the proposal note') !== -1);
  A.ok('other-options list shows each sibling by number AND id', htmlNum.indexOf('<li>#1 (ID 560948) - ') !== -1 && htmlNum.indexOf('<li>#3 (ID 561850) - ') !== -1 && htmlNum.indexOf('<li>#2 (ID 561841)') === -1);
  A.ok('acknowledgement: "I am acting on Proposal #2 (ID 561841)"', htmlNum.indexOf('I am acting on Proposal #2 (ID 561841)</label>') !== -1);
  // the same dialog when the rows carry no number (fallback read): id-only, as before
  var pNoNum = mkPlan(hN, 'tsp', 'pa-nonum', []);
  pNoNum.ctx.pid = 561841;
  pNoNum.ctx.siblings = { rows: LIVE_MULTI.listClientProposals.items.map(function (it) { var o = Object.assign({}, it); delete o.number; return hN.proposalRow(o); }), rowCount: 3, partial: true };
  var htmlNoNum = hN.confirmSummaryHtml(pNoNum);
  A.ok('no number -> summary, warning, list and acknowledgement fall back to the id', htmlNoNum.indexOf('<dd>#561841 - ') !== -1 && htmlNoNum.indexOf('Only #561841 gets') !== -1 && htmlNoNum.indexOf('<li>#560948 - ') !== -1 && htmlNoNum.indexOf('I am acting on Proposal #561841</label>') !== -1 && htmlNoNum.indexOf('(ID ') === -1);
  // targeting stays id-based even when a visible number collides with another row's id
  var clash = { rows: [hN.proposalRow({ id: 5, number: 901 }), hN.proposalRow({ id: 901, number: 1 })], rowCount: 2, partial: false };
  var scClash = hN.siblingContext(clash, 901);
  A.ok('selection matches by id, never by visible number', scClash.selected.id === 901 && scClash.selected.number === 1 && scClash.others[0].id === 5);
  A.eq('readTotals matches by id, not number', await load(READS, { PA_Prop: function () { throw new Error('x'); }, PA_List: function () { return list([{ id: 5, number: 901, total: money$(5) }, { id: 901, number: 1, total: money$(901) }]); } }).readTotals(1, 901).then(function (t) { return t.total.amount; }), 901);
  A.ok('Compare href and every write key off the id', /escapeHtml\(proposalHref\(n, r\.id\)\)/.test(full) && !/proposalHref\([^)]*number/.test(full) && !/\.number\b[^;\n]*(paGql|bwnGqlOp|entityId|proposalId)/.test(full));
  var numberLines = full.split('\n').filter(function (ln) { return /\.number\b/.test(ln); });
  A.ok('number is display-only: read only in proposalRow and propLabel', numberLines.length === 2 && /number: isPosInt\(it\.number\)/.test(numberLines[0]) && /function propLabel\(r, id\)/.test(numberLines[1]));

  // ---- trigger placement: tab strip, never the Submit row (0.7.8) -----------------------------------
  // A tiny fake DOM (tags, children, text, attributes, style, listeners, the handful of selectors the
  // real code uses). Runs the REAL findAnchor / injectDropdown / removeDropdown / buildDropdown /
  // paintTrigger / buildMenu. It cannot compute layout: the live 950px evidence is why Submit's row is
  // avoided; these tests prove WHERE the trigger goes and that native Submit is never touched.
  function mkDom() {
    function El(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.className = ''; this.id = ''; this._text = ''; this._html = null; this.listeners = {}; }
    El.prototype.appendChild = function (c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; };
    El.prototype.insertBefore = function (c, ref) { if (c.parentNode) c.parentNode.removeChild(c); var i = this.children.indexOf(ref); c.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; };
    El.prototype.removeChild = function (c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
    El.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
    Object.defineProperty(El.prototype, 'textContent', {
      get: function () { return this._text + this.children.map(function (c) { return c.textContent; }).join(''); },
      set: function (v) { this._text = String(v); this._html = null; this.children = []; }
    });
    Object.defineProperty(El.prototype, 'innerHTML', {
      get: function () { return this._html == null ? this._text : this._html; },
      set: function (v) { this._html = String(v); this._text = ''; this.children = []; }   // text of HTML-set nodes is not read by these tests
    });
    El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); };
    El.prototype.getAttribute = function (k) { return this.attrs.hasOwnProperty(k) ? this.attrs[k] : null; };
    El.prototype.hasAttribute = function (k) { return this.attrs.hasOwnProperty(k); };
    El.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
    El.prototype.click = function () { var self = this; (this.listeners.click || []).forEach(function (fn) { fn({ target: self, preventDefault: function () { }, stopPropagation: function () { } }); }); };
    El.prototype.getBoundingClientRect = function () { return { left: 100, right: 230, top: 20, bottom: 50 }; };
    El.prototype.offsetWidth = 200;
    El.prototype.contains = function (n) { for (var p = n; p; p = p.parentNode) if (p === this) return true; return false; };
    El.prototype.closest = function (sel) { for (var p = this; p; p = p.parentNode) if (match(p, sel)) return p; return null; };
    Object.defineProperty(El.prototype, 'nextSibling', { get: function () { var p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; } });
    Object.defineProperty(El.prototype, 'nextElementSibling', { get: function () { var p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; } });
    function hasClass(el, c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') !== -1; }
    function match(el, sel) {
      return sel.split(',').some(function (s) {
        s = s.trim();
        if (s[0] === '#') return el.id === s.slice(1);
        if (s[0] === '.') return hasClass(el, s.slice(1));
        if (s === '[role="tab"]') return el.getAttribute('role') === 'tab';
        return el.tagName === s.toUpperCase();
      });
    }
    function walk(root, out) { root.children.forEach(function (c) { out.push(c); walk(c, out); }); return out; }
    El.prototype.querySelectorAll = function (sel) {
      var parts = sel.trim().split(/\s+(?![^\[]*\])/);   // '#id .cls' descendant form, or one compound list
      var all = walk(this, []);
      if (parts.length === 2 && sel.indexOf(',') === -1) {
        var outer = all.filter(function (e) { return match(e, parts[0]); });
        return all.filter(function (e) { return match(e, parts[1]) && outer.some(function (o) { return o !== e && o.contains(e); }); });
      }
      return all.filter(function (e) { return match(e, sel); });
    };
    El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
    var doc = { listeners: [], body: new El('body') };
    doc.createElement = function (t) { return new El(t); };
    doc.getElementById = function (id) { return walk(doc.body, []).filter(function (e) { return e.id === id; })[0] || null; };
    doc.querySelectorAll = function (s) { return doc.body.querySelectorAll(s); };
    doc.querySelector = function (s) { return doc.body.querySelector(s); };
    doc.addEventListener = function (t, fn) { doc.listeners.push(t); };
    doc.removeEventListener = function () { };
    function el(tag, props, kids) { var e = new El(tag); Object.keys(props || {}).forEach(function (k) { if (k === 'text') e._text = props[k]; else if (k === 'role') e.setAttribute('role', props[k]); else e[k] = props[k]; }); (kids || []).forEach(function (k) { e.appendChild(k); }); return e; }
    return { doc: doc, el: el };
  }
  // Umbrava's proposal details page, as far as this script relies on it (live structure 2026-09-25):
  // a flex row (MuiStack) holding ONLY the MUI Tabs component - MuiTabs-root > MuiTabs-scroller >
  // [role=tablist] > Details / Notes tabs, plus the scroller's indicator span - and, separately, the
  // title row (title, "# N", Submit, kebab).
  function buildPage(D, title) {
    var submit = D.el('button', { text: 'Submit', className: 'MuiButton-root host-submit' });
    var kebab = D.el('button', { text: '⋯' });
    var titleRow = D.el('div', { className: 'host-title-row' }, [D.el('h2', { text: title }), D.el('span', { text: '# 2' }), submit, kebab]);
    var details = D.el('a', { text: 'Details', role: 'tab' });
    var notes = D.el('a', { text: 'Notes 0', role: 'tab' });
    var tablist = D.el('div', { role: 'tablist', className: 'MuiTabs-flexContainer' }, [details, notes]);
    var indicator = D.el('span', { className: 'MuiTabs-indicator' });
    var scroller = D.el('div', { className: 'MuiTabs-scroller MuiTabs-fixed' }, [tablist, indicator]);
    var tabsRoot = D.el('div', { className: 'MuiTabs-root css-1imxy09' }, [scroller]);
    var tabRow = D.el('div', { className: 'MuiStack-root css-1v4o1zs' }, [tabsRoot]);
    var page = D.el('div', { className: 'host-page' }, [tabRow, titleRow]);
    D.doc.body.appendChild(page);
    return { submit: submit, kebab: kebab, titleRow: titleRow, tabRow: tabRow, tabsRoot: tabsRoot, scroller: scroller, tablist: tablist, details: details, page: page };
  }
  var PLACE = [
    between('  // ===== dropdown UI', '  // ===== injection lifecycle'),
    sliceFn(full, 'function findAnchor()'), sliceFn(full, 'function removeDropdown()'),
    sliceFn(full, 'function injectDropdown()'), sliceFn(full, 'function paintTrigger()')
  ].join('\n');
  function pload(placeSrc) {
    var D = mkDom();
    var st = { details: true, pid: 561841, count: 3, started: [] };
    var bx = load(MONEY, {}, {});   // escapeHtml
    vm.runInContext(placeSrc || PLACE, bx);
    Object.assign(bx, {
      document: D.doc, window: { innerWidth: 950 }, setTimeout: function (fn) { fn(); },
      onProposalDetailsPage: function () { return st.details; }, gated: function () { return true; }, bwnCan: function () { return true; },
      captureBaseline: function () { }, loadJobProposals: function () { }, ensureStyle: function () { },
      optionCount: function () { return st.count; }, proposalIdFromUrl: function () { return st.pid; }, woNumberFromUrl: function () { return 397334; },
      paRefuseWhileRunning: function () { return false; },
      startApproval: function () { st.started.push('approval:' + st.pid); }, startTsp: function () { }, startKickback: function () { }, openCompare: function () { }
    });
    bx.D = D; bx.st = st;
    return bx;
  }
  function snapshot(node) { return JSON.stringify({ parent: node.parentNode && node.parentNode.className, idx: node.parentNode ? node.parentNode.children.indexOf(node) : -1, cls: node.className, style: node.style, text: node.textContent, attrs: node.attrs }); }
  function tabShape(pg) { return JSON.stringify({ root: pg.tabsRoot.children.map(function (c) { return c.className; }), scroller: pg.scroller.children.map(function (c) { return c.className || c.getAttribute('role'); }), tablist: pg.tablist.children.map(function (c) { return c.textContent; }) }); }
  var SUBMIT_ANCHOR = "function findAnchor() {\n    var btns = [].slice.call(document.querySelectorAll('button'));\n    var submit = btns.filter(function (b) { return /^\\s*Submit\\s*$/i.test(b.textContent || ''); })[0];\n    if (submit && submit.parentNode) return submit;\n    return null;\n  }";
  var TABLIST_ANCHOR_078 = "function findAnchor() {\n    var tab = [].slice.call(document.querySelectorAll('a,button,[role=\"tab\"]'))\n      .filter(function (el) { return /^\\s*Details\\s*$/i.test(el.textContent || ''); })[0];\n    if (tab && tab.parentNode) return tab;\n    return null;\n  }";
  function oldPlace(anchorSrc) {   // an older findAnchor + the older insert-BEFORE-the-anchor call
    return mutate(PLACE.replace(sliceFn(full, 'function findAnchor()'), anchorSrc),
      'anchor.parentNode.insertBefore(dd, anchor.nextSibling);', 'anchor.parentNode.insertBefore(dd, anchor);');
  }

  ['long', 'short'].forEach(function (kind) {
    var pb = pload();
    var pg = buildPage(pb.D, kind === 'long' ? 'Low pad broken up, replaced and re-poured under the fuel island canopy' : 'Grind down concrete');
    var subBefore = snapshot(pg.submit), tabsBefore = tabShape(pg);
    pb.injectDropdown();
    var dd = pb.D.doc.getElementById('bwn-pa-dropdown');
    A.ok(kind + ' title: trigger is the next sibling of the WHOLE tab component, in its row', !!dd && dd.parentNode === pg.tabRow && pg.tabsRoot.nextElementSibling === dd);
    A.ok(kind + ' title: trigger is not inside the tab component, its scroller or the tablist', !pg.tabsRoot.contains(dd) && !pg.scroller.contains(dd) && !pg.tablist.contains(dd));
    A.eq(kind + ' title: tab component children and order unchanged', tabShape(pg), tabsBefore);
    A.ok(kind + ' title: no new sibling in the Submit row', pg.titleRow.children.length === 4 && !pg.titleRow.contains(dd));
    A.eq(kind + ' title: native Submit is not moved, removed or restyled', snapshot(pg.submit), subBefore);
  });
  // negative controls: each earlier placement lands where the live checks found it failing
  var p078 = pload(oldPlace(TABLIST_ANCHOR_078));
  var pg078 = buildPage(p078.D, 'Low pad broken up, replaced and re-poured under the fuel island canopy');
  var shape078 = tabShape(pg078);
  p078.injectDropdown();
  A.ok('CONTROL: the 0.7.8 insertion changes the tab component\'s children (trigger inside the tablist)', tabShape(pg078) !== shape078 && pg078.tablist.contains(p078.D.doc.getElementById('bwn-pa-dropdown')));
  var pSub = pload(oldPlace(SUBMIT_ANCHOR));
  var pgSub = buildPage(pSub.D, 'Low pad broken up, replaced and re-poured under the fuel island canopy');
  pSub.injectDropdown();
  A.ok('CONTROL: the <= 0.7.7 Submit anchor inserts the trigger into the Submit row', pgSub.titleRow.contains(pSub.D.doc.getElementById('bwn-pa-dropdown')));
  // no safe row -> the fixed fallback, never the tablist or Submit's row
  var pNoMui = pload();
  var nm = pNoMui.D;
  var bareTabs = nm.el('div', { role: 'tablist' }, [nm.el('a', { text: 'Details', role: 'tab' }), nm.el('a', { text: 'Notes 0', role: 'tab' })]);
  nm.doc.body.appendChild(nm.el('div', { className: 'host-page' }, [bareTabs]));
  pNoMui.injectDropdown();
  var ddNo = nm.doc.getElementById('bwn-pa-dropdown');
  A.ok('no MUI tab component found -> fixed fallback, tablist untouched', ddNo.parentNode === nm.doc.body && ddNo.style.position === 'fixed' && bareTabs.children.length === 2);
  var pShared = pload();
  var ps = pShared.D;
  var tabsRootS = ps.el('div', { className: 'MuiTabs-root' }, [ps.el('div', { className: 'MuiTabs-scroller' }, [ps.el('div', { role: 'tablist' }, [ps.el('a', { text: 'Details', role: 'tab' })])])]);
  var sharedRow = ps.el('div', { className: 'MuiStack-root' }, [tabsRootS, ps.el('button', { text: 'Submit' })]);
  ps.doc.body.appendChild(sharedRow);
  pShared.injectDropdown();
  A.ok('tab component shares a row with Submit -> fixed fallback, that row untouched', ps.doc.getElementById('bwn-pa-dropdown').parentNode === ps.doc.body && sharedRow.children.length === 2);

  // repeated reinjection, React re-render, in-app navigation -> exactly one trigger
  var pr = pload();
  var pgR = buildPage(pr.D, 'Grind down concrete');
  for (var q = 0; q < 6; q++) pr.injectDropdown();
  A.eq('six injections -> one trigger', pr.D.doc.querySelectorAll('#bwn-pa-dropdown').length, 1);
  pgR.page.remove();   // React replaces the page body, taking the tab row and our node with it
  var pgR2 = buildPage(pr.D, 'Grind down concrete');
  pr.injectDropdown(); pr.injectDropdown();
  A.ok('after the tab row is replaced: one trigger, after the new tab component', pr.D.doc.querySelectorAll('#bwn-pa-dropdown').length === 1 && pgR2.tabsRoot.nextElementSibling === pr.D.doc.getElementById('bwn-pa-dropdown'));
  pr.st.details = false; pr.injectDropdown();
  A.eq('Notes tab (not the details route) removes it', pr.D.doc.querySelectorAll('#bwn-pa-dropdown').length, 0);
  pr.st.details = true; pr.injectDropdown(); pr.injectDropdown();
  A.ok('back to Details re-adds exactly one, after the tab component', pr.D.doc.querySelectorAll('#bwn-pa-dropdown').length === 1 && pgR2.tabsRoot.nextElementSibling === pr.D.doc.getElementById('bwn-pa-dropdown'));
  pr.st.pid = 560948; pr.injectDropdown();
  var trg = pr.D.doc.querySelector('#bwn-pa-dropdown .bwn-pa-trigger');
  A.ok('in-app move to another proposal: still one trigger, badge repainted for the new page', pr.D.doc.querySelectorAll('#bwn-pa-dropdown').length === 1 && trg.getAttribute('data-k') === '560948:3');

  // injected before the tab row rendered: fixed fallback, then the SAME node moves after the component
  var pf = pload();
  var shell = pf.D.el('div', { className: 'host-page' });
  pf.D.doc.body.appendChild(shell);
  pf.injectDropdown();
  var ddF = pf.D.doc.getElementById('bwn-pa-dropdown');
  A.ok('no tab row yet -> fixed fallback on body', ddF && ddF.parentNode === pf.D.doc.body && ddF.style.position === 'fixed');
  shell.remove();
  var pgF = buildPage(pf.D, 'Grind down concrete');
  pf.injectDropdown();
  A.ok('tab row appears -> the SAME node moves after the tab component and loses the fixed styles', pf.D.doc.getElementById('bwn-pa-dropdown') === ddF && pgF.tabsRoot.nextElementSibling === ddF && ddF.style.position === '' && ddF.style.top === '' && ddF.style.zIndex === '');
  A.eq('...still exactly one trigger', pf.D.doc.querySelectorAll('#bwn-pa-dropdown').length, 1);

  // badge + menu + id-based action selection after the move
  var pm = pload();
  buildPage(pm.D, 'Low pad broken up, replaced and re-poured under the fuel island canopy');
  pm.injectDropdown();
  var ddM = pm.D.doc.getElementById('bwn-pa-dropdown');
  var tm = ddM.querySelector('.bwn-pa-trigger');
  A.ok('wrapper centres itself in the flex row (no stretch to row height)', ddM.style.alignSelf === 'center' && ddM.style.display === 'inline-flex');
  A.ok('trigger label unchanged, floating "3 options" chip present', tm.innerHTML === 'Proposal Actions ▾<span class="opts">3 options</span>');
  A.ok('tooltip names the page proposal by id', /Actions apply only to #561841 \(this page\)/.test(tm.title));
  tm.click();
  var menuEl = pm.D.doc.body.children.filter(function (c) { return c.className === 'bwn-pa-menu'; })[0];
  A.ok('trigger click opens the menu with Compare first + the three actions', !!menuEl && menuEl.children.map(function (b) { return b.innerHTML.split('<')[0]; }).join('|') === 'Compare proposals (3 options)|Approval|TSP Review|Kickback');
  menuEl.children[1].click();
  A.eq('Approval from the moved trigger starts the workflow for the URL proposal id', pm.st.started, ['approval:561841']);
  A.eq('choosing an item closes the menu', pm.D.doc.body.children.filter(function (c) { return c.className === 'bwn-pa-menu'; }).length, 0);
  tm.click(); tm.click();
  A.eq('trigger toggles the menu closed', pm.D.doc.body.children.filter(function (c) { return c.className === 'bwn-pa-menu'; }).length, 0);
  pm.st.count = 1; tm.setAttribute('data-k', ''); pm.injectDropdown();
  A.ok('single-proposal page: plain label, no chip', tm.innerHTML === 'Proposal Actions ▾');

  // wiring: Submit is only ever used to REFUSE a row; insertion is always after the anchor
  var faSrc = sliceFn(full, 'function findAnchor()').replace(/\/\/.*$/gm, '');
  var injSrc = sliceFn(full, 'function injectDropdown()').replace(/\/\/.*$/gm, '');
  A.ok('findAnchor mentions Submit only to refuse a row that holds it', (faSrc.match(/\bSubmit\b/g) || []).length === 1 && /return rowHasSubmit \? null : comp;/.test(faSrc));
  A.ok('injectDropdown never references Submit and inserts AFTER the anchor', !/Submit/.test(injSrc) && (injSrc.match(/\.nextSibling\)/g) || []).length === 2 && !/insertBefore\((dd|existing), (anchor|late)\)/.test(injSrc));

  // ---- in-dialog progress + failure status (0.7.10) ----------------------------------------------
  // Drives the REAL runSteps + controller + paRunStatusHtml. The step marks (li.className + its <em>
  // note) are the runner's own record; the status line is rendered from those same marks.
  function stepState(li) { var m = /<em>(.*)<\/em>/.exec(li.querySelector('.lb').innerHTML); return li.className + ':' + (m ? m[1] : ''); }
  function mkProgDialog(bx, runs, opts) {
    opts = opts || {};
    var calls = runs.map(function () { return 0; }), order = [];
    var plan = mkPlan(bx, 'tsp', 'pa-prog-' + Math.random().toString(36).slice(2, 7), []);
    var labels = ['Set WO status → Pending Trade Specialist', 'Add note to Proposal #901 Notes tab', 'Add note to Work Order W-123 notes', 'Complete 1 open task(s)', 'Create task for Ronny Sharp: TSP Review'];
    plan.steps = runs.map(function (fn, i) {
      return { key: STEP_KEYS[i], label: labels[i], run: function () { calls[i]++; order.push(i); return fn(); } };
    });
    var d = { plan: plan, calls: calls, order: order, closed: 0, goBtn: el(), cancelBtn: el({ textContent: 'Cancel' }),
      noteTa: el({ value: 'TSP Review - note' }), ack: null, ackStopped: null, status: { innerHTML: '' },
      stepEls: runs.map(function () { return fakeLi(); }) };
    d.ctl = bx.paConfirmController(plan, d, function () { d.closed++; });
    return d;
  }
  // Visible text of the status HTML: drop everything between '<' and '>' with a plain character walk
  // (no tag-stripping regex; CodeQL flags that pattern even in tests). Test strings contain no entities.
  function statusText(d) {
    var h = d.status.innerHTML, out = '', inTag = false;
    for (var ci = 0; ci < h.length; ci++) {
      var ch = h.charAt(ci);
      if (ch === '<') { inTag = true; out += ' '; } else if (ch === '>') { inTag = false; } else if (!inTag) { out += ch; }
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // before the run
  var sP0 = mkStore(), bP0 = hload(sP0);
  var dP0 = mkProgDialog(bP0, [okStep, okStep, okStep]);
  A.ok('ready: no proposal / work-order CHANGES until Confirm (the dialog\'s own reads are not "nothing sent")', statusText(dP0) === 'No proposal or work-order changes are submitted until you press Confirm. Cancel closes this dialog without submitting any.');
  A.eq('ready: steps carry no progress marks yet', dP0.stepEls.map(stepState), [':', ':', ':']);

  // while running: running / not started, and Cancel is NOT offered
  var holdP = deferred();
  var sP1 = mkStore(), bP1 = hload(sP1);
  var dP1 = mkProgDialog(bP1, [function () { return holdP.p; }, okStep, okStep]);
  var runP1 = dP1.ctl.go();
  await flush();
  A.eq('running: current step "running", later steps "not started"', dP1.stepEls.map(stepState), ['run:running', 'wait:not started', 'wait:not started']);
  A.ok('running: Cancel is stated as unavailable, never as safe', /Cancel is unavailable until this run stops\./.test(statusText(dP1)) && !/Cancel is available/.test(statusText(dP1)));
  holdP.resolve(true);
  await runP1;
  A.eq('success: every step "completed"', dP1.stepEls.map(stepState), ['ok:completed', 'ok:completed', 'ok:completed']);
  A.ok('success: status says all steps completed (made-it-or-found-it, not "sent")', statusText(dP1) === 'All 3 steps completed. A completed step either made its change or found it already in place.');
  A.eq('success: steps sent once each, in plan order', dP1.order, [0, 1, 2]);
  A.eq('success: one completed-history record, no stopped record', [stored(sP1).length, stoppedRecs(sP1).length], [1, 0]);

  // failure before any step completed
  var sP2 = mkStore(), bP2 = hload(sP2);
  var dP2 = mkProgDialog(bP2, [failN(1), okStep, okStep]);
  var resP2 = await dP2.ctl.go();
  var tP2 = statusText(dP2);
  A.ok('first-step failure returns the unchanged runner result', resP2.ok === false && resP2.error === 'HTTP 500' && resP2.failedLabel === 'Set WO status → Pending Trade Specialist');
  A.eq('first-step failure: failed step marked, later steps "not started"', dP2.stepEls.map(stepState), ['err:failed: HTTP 500', 'wait:not started', 'wait:not started']);
  A.ok('names the failed step and its position', tP2.indexOf('This run stopped at step 1 (Set WO status → Pending Trade Specialist), 1 of 3.') === 0);
  A.ok('says no step completed', tP2.indexOf('No step completed.') !== -1);
  A.ok('failed request is uncertain: may or may not have reached Umbrava', tP2.indexOf('The failed request may or may not have reached Umbrava (error: HTTP 500).') !== -1);
  A.ok('says where Retry resumes, and that it re-sends the uncertain failed step', tP2.indexOf('Retry resumes at step 1 and does not repeat completed steps. It sends step 1 again, so if that request did reach Umbrava it may be repeated.') !== -1);
  A.ok('Cancel: available now, stops further steps, does NOT undo completed ones, points to the new-dialog warning', tP2.indexOf('Cancel is available now: it stops this dialog from attempting further steps; it does not undo completed steps. If you start this action again in a new dialog, that dialog warns that it may repeat steps.') !== -1);
  A.ok('Cancel text makes no "safe" / "nothing sent" claim', !/safe|sends nothing|nothing more/i.test(tP2));
  A.ok('failure message is persistent in the dialog, not only a toast', tP2.indexOf('This run stopped at') === 0 && bP2.toasts.some(function (t) { return /^Stopped at/.test(t); }));
  A.ok('failure message carries no nested role (the aria-live="polite" region announces it once)', !/role=/.test(dP2.status.innerHTML));

  // failure after completed steps, then Retry
  var sP3 = mkStore(), bP3 = hload(sP3);
  var dP3 = mkProgDialog(bP3, [okStep, okStep, failN(1)]);
  await dP3.ctl.go();
  var tP3 = statusText(dP3);
  A.eq('later failure: completed / failed marks', dP3.stepEls.map(stepState), ['ok:completed', 'ok:completed', 'err:failed: HTTP 500']);
  A.ok('lists exactly the steps the runner saw complete', tP3.indexOf('Completed: step 1 (Set WO status → Pending Trade Specialist); step 2 (Add note to Proposal #901 Notes tab). A completed step either made its change or found it already in place.') !== -1);
  A.ok('completed steps are not described as successful requests or sent writes', !/requests? succeed|write was sent|writes? sent/i.test(tP3));
  A.ok('completed list and failed step are distinct (failed step not listed as completed)', !/Completed[^.]*step 3/.test(tP3) && tP3.indexOf('This run stopped at step 3 (Add note to Work Order W-123 notes), 3 of 3.') === 0);
  A.ok('never claims the failed request did or did not arrive', !/did not reach|didn't reach|was not sent|definitely|was saved|reached Umbrava\./i.test(tP3.replace('may or may not have reached Umbrava', '')));
  A.ok('Retry resumes at the failed step', tP3.indexOf('Retry resumes at step 3 and does not repeat completed steps. It sends step 3 again, so if that request did reach Umbrava it may be repeated.') !== -1);
  A.eq('stopped-attempt storage unchanged: done = the completed steps, failed = the failed one', [stoppedRecs(sP3)[0].done, stoppedRecs(sP3)[0].failed], [['status', 'proposalNote'], 'woNote']);
  var retryP3 = dP3.ctl.go();
  A.ok('Retry: status switches back to running (Cancel unavailable)', /Cancel is unavailable until this run stops\./.test(statusText(dP3)));
  await retryP3;
  A.eq('Retry re-sends only the failed step, in order', [dP3.calls, dP3.order], [[1, 1, 2], [0, 1, 2, 2]]);
  A.eq('Retry: all steps completed', dP3.stepEls.map(stepState), ['ok:completed', 'ok:completed', 'ok:completed']);
  A.ok('Retry: status replaced by the completion line (no stale failure text)', statusText(dP3) === 'All 3 steps completed. A completed step either made its change or found it already in place.');
  A.eq('Retry: one history record, stopped record resolved', [stored(sP3).length, stoppedRecs(sP3).length], [1, 0]);

  // done with a skipped (not-yet-captured) step: never "All N completed"
  var sP5 = mkStore(), bP5 = hload(sP5);
  var dP5 = mkProgDialog(bP5, [okStep, function () { return Promise.reject(new Error('NOT_PINNED: x')); }, okStep]);
  var resP5 = await dP5.ctl.go();
  A.ok('skip: runner result unchanged (ok, skipped 1)', resP5.ok === true && resP5.skipped === 1);
  A.eq('skip: done text counts only completed steps and names the skip as not sent', statusText(dP5), '2 of 3 steps completed; 1 step(s) skipped (not yet captured, not sent). A completed step either made its change or found it already in place.');

  // stopped-attempt record could NOT be saved: the status must not promise a new-dialog warning
  var sP6 = mkStore(null, { throwSet: true }), bP6 = hload(sP6);
  var dP6 = mkProgDialog(bP6, [okStep, failN(1)]);
  var resP6 = await dP6.ctl.go();
  var tP6 = statusText(dP6);
  A.ok('record-save failure: runner result still unchanged', resP6.ok === false && resP6.error === 'HTTP 500' && !('stopRecord' in resP6));
  A.ok('record-save failure: says a new dialog will NOT warn', tP6.indexOf('This browser could not save a stopped-attempt record, so a new dialog for this action will not warn that it may repeat steps.') !== -1 && tP6.indexOf('that dialog warns that it may repeat steps') === -1);
  A.ok('record-save failure: Cancel still does not undo completed steps', tP6.indexOf('it does not undo completed steps.') !== -1);

  // unexpected stop with a step left in flight ('run'): same uncertainty as a failure
  var liRun = [fakeLi(), fakeLi()]; liRun[0].className = 'ok'; liRun[1].className = 'run';
  var tRun = bP6.paRunStatusHtml('failed', [{ label: 'A' }, { label: 'B' }], liRun, { ok: false, error: 'boom' });
  A.ok('unexpected stop mid-step: names the in-flight step and keeps it uncertain', tRun.indexOf('This run stopped at step 2 (B), 2 of 2.') !== -1 && tRun.indexOf('may or may not have reached Umbrava (error: boom).') !== -1);

  // a throw AFTER Done (post-run bookkeeping) must not replace the completion text with Retry/Cancel text
  var sP7 = mkStore(), bP7 = hload(sP7);
  bP7.paHistOnResult = function () { throw new Error('late'); };
  var dP7 = mkProgDialog(bP7, [okStep]);
  await dP7.ctl.go();
  A.ok('throw after Done: the late throw really reached the catch', bP7.toasts.some(function (t) { return /^Run stopped unexpectedly: late/.test(t); }));
  A.ok('throw after Done: state stays done and the status keeps the completion line', dP7.ctl.state() === 'done' && /^All 1 steps completed\./.test(statusText(dP7)) && statusText(dP7).indexOf('Retry') === -1);

  // a step completed through its already-done re-check: the REAL buildStatusStep finds the WO already
  // at the target status and writes nothing - the runner still marks it completed, and the status line
  // must not claim a write happened
  var reWrites = 0, reReads = 0;
  var bRe = load(READS + RUNNER + DISPLAY + sliceFn(full, 'function buildStatusStep(ctx, statusName)'), {}, {
    localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { },
    readWO: function () { reReads++; return Promise.resolve({ statusName: 'Pending Trade Specialist' }); },
    readStatusId: function () { return Promise.resolve(232); },
    setStatus: function () { reWrites++; return Promise.resolve(true); }
  });
  var dRe = mkProgDialog(bRe, [okStep, failN(1)]);
  var realStatus = bRe.buildStatusStep(dRe.plan.ctx, 'Pending Trade Specialist');
  dRe.plan.steps[0] = { key: 'status', label: realStatus.label, run: function () { dRe.calls[0]++; dRe.order.push(0); return realStatus.run(); } };
  await dRe.ctl.go();
  var tRe = statusText(dRe);
  A.eq('already-done re-check: the status step read the WO and wrote nothing', [reReads, reWrites], [1, 0]);
  A.eq('already-done re-check: the runner still marks it completed', stepState(dRe.stepEls[0]), 'ok:completed');
  A.ok('already-done re-check: listed as completed with the made-it-or-found-it wording, no write claimed', tRe.indexOf('Completed: step 1 (Set WO status → Pending Trade Specialist). A completed step either made its change or found it already in place.') !== -1 && !/requests? succeed|write was sent/i.test(tRe));
  A.ok('...and the next step\'s failure stays uncertain', tRe.indexOf('The failed request may or may not have reached Umbrava (error: HTTP 500).') !== -1);
  var reWrites2 = 0;
  var bRe2 = load(READS + RUNNER + DISPLAY + sliceFn(full, 'function buildStatusStep(ctx, statusName)'), {}, {
    localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { },
    readWO: function () { return Promise.resolve({ statusName: 'Proposal Review' }); },
    readStatusId: function () { return Promise.resolve(232); },
    setStatus: function () { reWrites2++; return Promise.resolve(true); }
  });
  var dRe2 = mkProgDialog(bRe2, [okStep]);
  var realStatus2 = bRe2.buildStatusStep(dRe2.plan.ctx, 'Pending Trade Specialist');
  dRe2.plan.steps[0] = { key: 'status', label: realStatus2.label, run: function () { return realStatus2.run(); } };
  await dRe2.ctl.go();
  A.ok('same step when the status differs: it writes once, and is marked completed the same way', reWrites2 === 1 && stepState(dRe2.stepEls[0]) === 'ok:completed');

  // the current-dialog failure message stays distinct from the stopped-attempt warning
  A.ok('failure message does not reuse the stopped-attempt wording', tP2.indexOf('Stopped attempt (this browser)') === -1 && tP3.indexOf('Stopped attempt (this browser)') === -1);
  var sP4 = mkStore(), bP4 = hload(sP4);
  await mkProgDialog(bP4, [okStep, failN(1)]).ctl.go();
  var nextDialog = mkStopDialog(bP4, 'tsp', 901, [okStep], true);
  var sumP4 = bP4.confirmSummaryHtml(nextDialog.plan);
  A.ok('a NEW dialog still shows the stopped-attempt warning + its own acknowledgement, not the run-status text', /Stopped attempt \(this browser\)/.test(sumP4) && /id="bwn-pa-ack-stopped"/.test(sumP4) && sumP4.indexOf('Retry resumes') === -1 && sumP4.indexOf('This run stopped at') === -1);

  // negative control: the resume point is shared; breaking it re-sends a completed step
  var RUN_NORESUME = mutate(RUNNER, "while (i < n && stepEls[i] && stepEls[i].className === 'ok') i++;", '');
  var bNR = load(READS + RUN_NORESUME + DISPLAY, {}, { localStorage: mkStore(), paToast: function () { }, woNumberFromUrl: function () { return 123; }, proposalIdFromUrl: function () { return 901; }, setTimeout: function () { } });
  var dNR = mkProgDialog(bNR, [okStep, failN(1)]);
  await dNR.ctl.go(); await dNR.ctl.go();
  A.ok('CONTROL: without the shared resume point, Retry re-sends the completed step', dNR.calls[0] === 2);

  // wiring: one status element, written only by the controller from the runner's marks
  A.ok('dialog renders one polite live status element and passes it to the controller', (full.match(/id="bwn-pa-runstat"/g) || []).length === 1 && /status: card\.querySelector\('#bwn-pa-runstat'\)/.test(full));
  A.ok('runSteps and the status line share one resume computation', /var idx = paFirstUnfinished\(stepEls, steps\.length\);/.test(full) && /var resume = paFirstUnfinished\(stepEls, n\);/.test(full) && !/while \(idx < steps\.length && stepEls\[idx\]/.test(full));

  // ---- source-level wiring -----------------------------------------------------------------
  A.eq('history is written from exactly one place (the Confirm success branch)', (full.match(/paHistOnResult\(plan, noteText, res, Date\.now\(\)\)/g) || []).length, 1);
  A.ok('history write sits inside the res.ok branch', /if \(res\.ok\) \{[^}]*paHistOnResult\(/.test(full));
  A.ok('history never feeds an outgoing request', !/paHist[A-Za-z]*\([^)]*\)[^;\n]*(paGql|bwnGqlOp)/.test(full) && !/(paGql|bwnGqlOp)\([^;\n]*paHist/.test(full));
  A.ok('each opened dialog gets its own run id', /plan\.runId = 'pa-' \+ Date\.now\(\)/.test(full));
  A.ok('confirm dialog is bound to the page it was gathered for', /function stillOnPlanPage\(plan\)/.test(full) && (full.match(/stillOnPlanPage\(plan\)/g) || []).length >= 3);
  A.ok('Confirm is gated on the acknowledgement checkbox', /if \(!allAcked\(\)\) return null;/.test(full));
  A.eq('all three workflows pass ctx + kind to the confirm plan', (full.match(/ctx: ctx, kind: '(approval|tsp|kickback)', action: /g) || []).length, 3);
  A.ok('compare selection navigates (URL stays the one source of "selected")', /escapeHtml\(proposalHref\(n, r\.id\)\) \+ '">Open to act on ' \+ escapeHtml\(propLabel\(r, r\.id\)\)/.test(full) && /function proposalHref\(n, id\)/.test(full));
  A.ok('badge repaint is keyed, so the 900ms loop does not rewrite the DOM', /getAttribute\('data-k'\) === key/.test(full));
  // 0.7.3 regression (live 2026-09-25): the 0.7.2 in-flow badge widened the trigger 132px -> 262px and
  // pushed Umbrava's Submit button 113px out of the proposal header row. The trigger label must stay the
  // 0.6.x text, and the count chip must be absolutely positioned so it adds no layout width.
  A.ok('trigger label stays exactly "Proposal Actions ▾" (count chip appended after it)', /t\.innerHTML = 'Proposal Actions ▾' \+ \(c > 1 \? '<span class="opts">' \+ c \+ ' options<\/span>' : ''\);/.test(full));
  var optsRule = (full.match(/'\.bwn-pa-trigger \.opts\{([^}]*)\}'/) || [])[1] || '';
  A.ok('count chip is position:absolute (no layout width)', /position:absolute/.test(optsRule));
  A.ok('trigger is the chip\'s positioning context', /'\.bwn-pa-trigger\{position:relative;\}'/.test(full));
  A.ok('the page id is not in the trigger label (tooltip only), keeping the trigger narrow', !/class="opts">#'/.test(full));

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
