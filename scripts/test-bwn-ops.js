// test-bwn-ops.js - node harness for the BWN-OPS block in bwn-suite-core: the operation
// registry, the audited GraphQL wrapper (bwnGqlOp), the correlation id, and the bounded
// PII-free audit ring buffer. Added with Core 1.78.28.
//
// WHAT THIS IS. bwnGqlOp() is the suite's safety spine for /api/graphql writes: it classifies
// an op against BWN_OPS, applies a retry policy that NEVER auto-retries a non-idempotent write,
// enforces the per-feature kill switch, validates before sending, rejects a success:false
// envelope instead of swallowing it, and records a structured audit entry with a correlation
// id. It is ADDITIVE - bwnGql() stays the raw transport and no existing caller is changed yet -
// so this harness is the only thing exercising it until a module adopts it.
//
// WHAT THIS PROVES, against the REAL shipped bytes (the BWN-OPS region sliced out of
// bwn-suite-core.user.js and run in a vm with a fake localStorage and an injectable transport):
//   - an unregistered op is refused (no guessed selectors can be sent).
//   - a read passes through and writes NO audit entry; a write records exactly one.
//   - a write's {success,message} envelope with success:false REJECTS and audits 'error' -
//     the swallow-to-a-fact bug the op catalog warns about cannot happen through this path.
//   - a non-idempotent write is NEVER auto-retried; a read (and an idempotent+retry:safe write)
//     is retried up to 3 times on a TRANSIENT failure only; a deterministic error is not.
//   - the per-feature kill switch refuses a write from a disabled module before it is sent.
//   - validate() blocks a write before it leaves the browser.
//   - the audit entry carries ONLY ids + scalar before/after + metadata - never the variables
//     or the response (no note text / address / vendor identity leaks into the log).
//   - the ring buffer is bounded and keeps the most recent entries; export round-trips.
//
// WHAT IT DOES NOT PROVE:
//   - that any of these ops exist on the live schema for this tenant (the op catalog + a live
//     write prove that; see wiki/umbrava-graphql-operations.md).
//   - that any module actually routes through bwnGqlOp yet (nothing does - that is the next slice).
//
// Every case is re-run against mutated copies of the same source; each mutation MUST turn this
// harness red. mutate() throws if its target is absent or not unique, so a silent no-op cannot
// pass for a control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bwn-ops.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  if (coreFull.indexOf(end, b + 1) !== -1) throw new Error(what + ': END marker not unique');
  return coreFull.slice(a, b);
}

var S_OPS = slice('  // ===== BWN-OPS START v1', '  // ===== BWN-OPS END v1 =====', 'BWN-OPS block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- Environment ------------------------------------------------------------
// A fresh instance per build: fake localStorage, an injectable transport whose per-call
// result comes off env.plan, and setTimeout collapsed to a microtask so retry backoff does
// not slow the run.
function makeOps(opsSrc, modules) {
  var store = Object.create(null);
  var localStorage = {
    getItem: function (k) { return (k in store) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  var env = { calls: [], plan: [], store: store };
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, JSON: JSON,
    Promise: Promise, Error: Error, RegExp: RegExp, Math: Math, Date: Date, console: console,
    window: {},                              // no crypto -> corrId uses the timestamp form
    localStorage: localStorage,
    setTimeout: function (fn) { return setTimeout(fn, 0); },
    BWN_VER: '1.78.28',
    BWN_MODULES: modules || { launcher: true, dispatch: true, woAssist: true },
    bwnGql: function (query, variables) {
      env.calls.push({ query: query, variables: variables });
      var step = env.plan.shift();
      if (!step) return Promise.reject(new Error('test plan exhausted'));
      if (step.err) return Promise.reject(step.err);
      return Promise.resolve(step.data);
    }
  };
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + opsSrc + '\n' +
    'return { OPS: BWN_OPS, run: bwnGqlOp, corrId: bwnCorrId, MAX: BWN_AUDIT_MAX,\n' +
    '  auditAll: bwnAuditAll, auditExport: bwnAuditExport, auditRecord: bwnAuditRecord,\n' +
    '  isTransient: bwnIsTransient, backoff: bwnBackoff, hook: window.__bwnOps };\n})()',
    sandbox, { filename: 'bwn-ops.js' });
  env.api = api;
  return env;
}

function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 5); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}

// ---- The cases --------------------------------------------------------------
// Returns a results list rather than asserting directly, so the same cases can be re-run
// against a mutant and checked for redness.
function runCases(opsSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
  function settle(p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); }

  var e;
  try { e = makeOps(opsSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return Promise.resolve(out); }
  var api = e.api;
  // A mutated block can throw synchronously from run() (e.g. the unregistered-op guard
  // removed). A control must REDDEN a case, not crash the harness, so normalize a sync
  // throw into a rejected promise.
  function callRun() { try { return api.run.apply(null, arguments); } catch (err) { return Promise.reject(err); } }

  // --- registry sanity (data grounded in the op catalog) ---
  ok('registry classifies patchWorkOrder as a high-risk write', api.OPS.patchWorkOrder &&
    api.OPS.patchWorkOrder.kind === 'write' && api.OPS.patchWorkOrder.risk === 'high');
  ok('a read carries no risk tier', api.OPS.workOrder && api.OPS.workOrder.kind === 'read' && api.OPS.workOrder.risk === undefined);
  ok('the console hook exposes the registry + audit', e.api.hook && e.api.hook.registry && e.api.hook.audit && typeof e.api.hook.audit.export === 'function');

  // --- corrId ---
  var c1 = api.corrId(), c2 = api.corrId();
  ok('corrId is a non-empty bwn- string', typeof c1 === 'string' && /^bwn-/.test(c1), c1);
  ok('two corrIds differ', c1 !== c2, c1 + ' / ' + c2);

  // --- transient classifier ---
  ok('a network error is transient', api.isTransient(new Error('NetworkError when attempting to fetch')) === true);
  ok('a GraphQL validation error is NOT transient', api.isTransient(new Error('Cannot query field xyz')) === false);
  var refused = new Error('refused'); refused.bwnNonTransient = true;
  ok('a bwnNonTransient error is never transient', api.isTransient(refused) === false);
  ok('backoff grows and is capped', api.backoff(1) === 400 && api.backoff(2) === 800 && api.backoff(20) === 4000);

  // --- unregistered op ---
  return settle(callRun('notARealOp', 'query{x}', {})).then(function (r) {
    ok('an unregistered op is refused', !r.ok && /unregistered/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));

    // --- a read passes through and audits nothing ---
    e.plan = [{ data: { workOrder: { id: 1 } } }];
    e.calls = [];
    return settle(callRun('workOrder', 'query{workOrder{id}}', { n: 1 }));
  }).then(function (r) {
    eq('a read resolves to data', r.ok && r.v, { workOrder: { id: 1 } });
    eq('a read fired exactly one transport call', e.calls.length, 1);
    eq('a read writes NO audit entry', api.auditAll().length, 0);

    // --- a successful write audits exactly one ok entry, PII-free ---
    e.plan = [{ data: { addEditJobNote: { success: true, message: 'ok' } } }];
    e.calls = [];
    return settle(callRun('addEditJobNote', 'mutation($d:X){addEditJobNote(data:$d){success message}}',
      { d: { content: 'SECRET NOTE TEXT', workOrderNumber: 5 } },
      { ids: { wo: 5 }, before: { noteCount: 3 }, after: { noteCount: 4 }, feature: 'woAssist' }));
  }).then(function (r) {
    ok('a successful write resolves', r.ok, r.ok ? '' : String(r.e && r.e.message));
    var log = api.auditAll();
    eq('the write recorded exactly one audit entry', log.length, 1);
    var a0 = log[0] || {};
    ok('the entry names the op + kind + risk', a0.op === 'addEditJobNote' && a0.kind === 'write' && a0.risk === 'moderate', JSON.stringify(a0));
    ok('the entry outcome is ok with a corrId', a0.outcome === 'ok' && /^bwn-/.test(String(a0.corrId)), JSON.stringify(a0));
    eq('the entry carries the caller ids', a0.ids, { wo: 5 });
    eq('the entry carries the scalar before/after', [a0.before, a0.after], [{ noteCount: 3 }, { noteCount: 4 }]);
    // The PII guard: the note text lives in the variables and must NEVER reach the log.
    var blob = JSON.stringify(a0);
    ok('the entry does NOT leak the variables/note text', blob.indexOf('SECRET NOTE TEXT') === -1, blob);
    var allowed = { ts: 1, corrId: 1, op: 1, kind: 1, target: 1, risk: 1, actor: 1, ids: 1, before: 1, after: 1, outcome: 1, ms: 1, ver: 1, tries: 1, reason: 1 };
    var extra = Object.keys(a0).filter(function (k) { return !allowed[k]; });
    eq('the entry has no unexpected keys (no query/response)', extra, []);

    // --- a success:false envelope REJECTS and audits error, and is not retried ---
    // (moderate op; the success:false path is independent of the high-risk confirm gate)
    e.plan = [{ data: { addEditJobNote: { success: false, message: 'not allowed' } } }];
    e.calls = [];
    return settle(callRun('addEditJobNote', 'mutation($d:X){addEditJobNote(data:$d){success message}}',
      { d: {} }, { ids: { wo: 9 } }));
  }).then(function (r) {
    ok('a success:false write REJECTS (never a silent false)', !r.ok && /not allowed/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    eq('a success:false write is not retried', e.calls.length, 1);
    var log = api.auditAll();
    eq('the audit now has two entries', log.length, 2);
    ok('the second entry is an error outcome', log[1] && log[1].outcome === 'error', JSON.stringify(log[1]));
    // F5: the error audit reason is a fixed category, NOT the raw server message text.
    ok('F5: the success:false audit reason is a scrubbed category (write-refused)', log[1] && log[1].reason === 'write-refused', JSON.stringify(log[1]));
    ok('F5: the server message text never enters the audit trail', JSON.stringify(log[1] || {}).indexOf('not allowed') === -1, JSON.stringify(log[1]));

    // --- F3: an unrecognized write response fails CLOSED (never a silent ok) ---
    // data['addEditJobNote'] is undefined here - the name-coupling hole: a future op whose
    // field name differs from its key, or whose envelope omits success, must NOT be classified
    // as success. (Verified separately that every CURRENT adopter returns {success} under its
    // own field name, so this fail-closed change touches no live caller.)
    e.plan = [{ data: { notTheOpField: { success: true } } }];
    e.calls = [];
    return settle(callRun('addEditJobNote', 'mutation($d:X){addEditJobNote(data:$d){success message}}', { d: {} }, { ids: { wo: 7 } }));
  }).then(function (r) {
    ok('F3: a write with no {success} under data[op] REJECTS (not a silent ok)', !r.ok && /unrecognized write response/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    var log = api.auditAll();
    ok('F3: the unrecognized-shape write is audited error (unexpected-response-shape)', (function () { var la = log[log.length - 1]; return la && la.outcome === 'error' && la.reason === 'unexpected-response-shape'; })(), JSON.stringify(log[log.length - 1]));

    // F3 second sub-case: data[op] present but success is not a boolean also fails closed.
    e.plan = [{ data: { addEditJobNote: { note: { id: 1 } } } }];
    e.calls = [];
    return settle(callRun('addEditJobNote', 'mutation($d:X){addEditJobNote(data:$d){success message}}', { d: {} }, { ids: { wo: 8 } }));
  }).then(function (r) {
    ok('F3: a write whose data[op] carries no boolean success REJECTS', !r.ok && /unrecognized write response/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));

    // --- F4: a high-risk write with OMITTED opts (pure omission) is fail-closed refused ---
    // Locks the "cannot skip the gate by omission" invariant the by-construction restructure gives.
    e.plan = [{ data: { patchWorkOrder: { success: true } } }];
    e.calls = [];
    return settle(callRun('patchWorkOrder', 'mutation{patchWorkOrder}'));
  }).then(function (r) {
    ok('F4: a high-risk write with omitted opts is refused (gate not skippable by omission)', !r.ok && /confirmation/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    eq('F4: and nothing was sent on omission', e.calls.length, 0);

    // --- a non-idempotent write is NOT retried on a transient failure ---
    e.plan = [{ err: new Error('network down') }];
    e.calls = [];
    return settle(callRun('addTask', 'mutation{addTask}', {}, { ids: { wo: 1 } }));
  }).then(function (r) {
    ok('a non-idempotent write rejects on transient failure', !r.ok);
    eq('and is tried exactly once (no auto-retry of a non-idempotent write)', e.calls.length, 1);

    // --- a read IS retried up to 3 times on transient failure, then rejects ---
    e.plan = [{ err: new Error('network') }, { err: new Error('network') }, { err: new Error('network') }];
    e.calls = [];
    return settle(callRun('jobNotes', 'query{jobNotes}', {})).then(function (rr) { return tick().then(function () { return rr; }); });
  }).then(function (r) {
    ok('a read that keeps failing transiently eventually rejects', !r.ok);
    eq('a read is retried to 3 total attempts', e.calls.length, 3);

    // --- a read recovers on a later attempt ---
    e.plan = [{ err: new Error('network') }, { data: { jobNotes: [] } }];
    e.calls = [];
    return settle(callRun('jobNotes', 'query{jobNotes}', {})).then(function (rr) { return tick().then(function () { return rr; }); });
  }).then(function (r) {
    ok('a transient read recovers on retry', r.ok, r.ok ? '' : String(r.e && r.e.message));
    eq('it took two attempts', e.calls.length, 2);

    // --- an idempotent + retry:safe write (putUserPreference) IS retried; completeTask (retry:none) is NOT ---
    e.plan = [{ err: new Error('network') }, { data: { putUserPreference: { success: true, message: '' } } }];
    e.calls = [];
    return settle(callRun('putUserPreference', 'mutation{putUserPreference}', {}, {})).then(function (rr) { return tick().then(function () { return rr; }); });
  }).then(function (r) {
    ok('an idempotent retry:safe write recovers on retry', r.ok, r.ok ? '' : String(r.e && r.e.message));
    eq('it took two attempts', e.calls.length, 2);

    e.plan = [{ err: new Error('network') }];
    e.calls = [];
    return settle(callRun('completeTask', 'mutation{completeTask}', {}, {}));
  }).then(function (r) {
    ok('an idempotent write with retry:none is NOT retried', !r.ok);
    eq('completeTask is tried once despite being idempotent', e.calls.length, 1);

    // --- the per-feature kill switch refuses a write, before any transport call ---
    var off = makeOps(opsSrc, { woAssist: false, launcher: true });
    off.plan = [{ data: { addEditJobNote: { success: true } } }];
    return settle(off.api.run('addEditJobNote', 'mutation{addEditJobNote}', {}, { feature: 'woAssist' })).then(function (rr) {
      return { rr: rr, off: off };
    });
  }).then(function (o) {
    ok('a disabled feature refuses the write', !o.rr.ok && /disabled/.test(String(o.rr.e && o.rr.e.message)), o.rr.ok ? 'resolved' : String(o.rr.e && o.rr.e.message));
    eq('and no transport call was made', o.off.calls.length, 0);
    var log = o.off.api.auditAll();
    ok('the refusal is audited as denied (feature-off)', log.length === 1 && log[0].outcome === 'denied' && /feature-off/.test(String(log[0].reason)), JSON.stringify(log[0]));

    // --- validate() blocks a write before it is sent (moderate op; independent of the confirm gate) ---
    e.plan = [{ data: { addEditJobNote: { success: true } } }];
    e.calls = [];
    return settle(callRun('addEditJobNote', 'mutation{addEditJobNote}', { d: {} },
      { validate: function () { return 'content is required'; } }));
  }).then(function (r) {
    ok('validate() failing blocks the write', !r.ok && /content is required/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    eq('and nothing was sent', e.calls.length, 0);

    // validate() passing lets it through
    e.plan = [{ data: { addEditJobNote: { success: true } } }];
    e.calls = [];
    return settle(callRun('addEditJobNote', 'mutation{addEditJobNote}', { d: {} }, { validate: function () { return true; } }));
  }).then(function (r) {
    ok('validate() returning true lets the write proceed', r.ok, r.ok ? '' : String(r.e && r.e.message));
    eq('and it was sent once', e.calls.length, 1);

    // --- high-risk confirm gate (WRAP v2): fail-closed without proof of confirmation ---
    e.plan = [{ data: { patchWorkOrder: { success: true } } }];
    e.calls = [];
    return settle(callRun('patchWorkOrder', 'mutation{patchWorkOrder}', { d: {} }, { ids: { wo: 9 } }));
  }).then(function (r) {
    ok('a high-risk write with NO confirmation is refused', !r.ok && /confirmation/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    eq('and nothing was sent', e.calls.length, 0);
    ok('the refusal is audited denied (confirm-required)', (function () { var l = api.auditAll(); var last = l[l.length - 1]; return last && last.outcome === 'denied' && /confirm-required/.test(String(last.reason)); })());

    // confirmed:true (caller confirmed via its own UI, e.g. dispatch's modal) lets it through
    e.plan = [{ data: { patchWorkOrder: { success: true } } }];
    e.calls = [];
    return settle(callRun('patchWorkOrder', 'mutation{patchWorkOrder}', { d: {} }, { confirmed: true, ids: { wo: 9 } }));
  }).then(function (r) {
    ok('confirmed:true lets a high-risk write proceed', r.ok, r.ok ? '' : String(r.e && r.e.message));
    eq('and confirmed:true sent once', e.calls.length, 1);

    // an injected confirm handler returning true also proceeds, and receives the write details
    e.plan = [{ data: { patchWorkOrder: { success: true } } }];
    e.calls = [];
    var seen = null;
    api.run.setConfirm(function (d) { seen = d; return true; });
    return settle(callRun('patchWorkOrder', 'mutation{patchWorkOrder}', { d: {} }, { ids: { wo: 42 }, current: { s: 1 }, proposed: { s: 2 }, count: 1 })).then(function (rr) { return { rr: rr, seen: seen }; });
  }).then(function (o) {
    ok('an injected confirm returning true lets it proceed', o.rr.ok, o.rr.ok ? '' : String(o.rr.e && o.rr.e.message));
    ok('the confirm handler received the write details', o.seen && o.seen.op === 'patchWorkOrder' && o.seen.risk === 'high' && o.seen.count === 1 && o.seen.proposed && o.seen.proposed.s === 2, JSON.stringify(o.seen));

    // an injected confirm returning false aborts, audits denied, sends nothing
    e.plan = [{ data: { patchWorkOrder: { success: true } } }];
    e.calls = [];
    api.run.setConfirm(function () { return false; });
    return settle(callRun('patchWorkOrder', 'mutation{patchWorkOrder}', { d: {} }, { ids: { wo: 42 } }));
  }).then(function (r) {
    ok('an injected confirm returning false aborts the write', !r.ok && /cancelled/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    eq('and nothing was sent on cancel', e.calls.length, 0);
    ok('the cancel is audited denied (user-cancelled)', (function () { var l = api.auditAll(); var last = l[l.length - 1]; return last && last.outcome === 'denied' && /user-cancelled/.test(String(last.reason)); })());
    api.run.setConfirm(null);

    // a MODERATE write still needs no confirmation
    e.plan = [{ data: { addEditJobNote: { success: true } } }];
    e.calls = [];
    return settle(callRun('addEditJobNote', 'mutation{addEditJobNote}', {}, {}));
  }).then(function (r) {
    ok('a moderate write needs no confirmation', r.ok, r.ok ? '' : String(r.e && r.e.message));
    eq('and the moderate write sent once', e.calls.length, 1);

    // --- the audit ring buffer is bounded and keeps the most recent entries ---
    var rb = makeOps(opsSrc);
    var N = rb.api.MAX + 5;
    for (var i = 0; i < N; i++) rb.api.auditRecord({ seq: i });
    var log = rb.api.auditAll();
    eq('the ring buffer is capped at BWN_AUDIT_MAX', log.length, rb.api.MAX);
    eq('it kept the MOST RECENT entries', [log[0].seq, log[log.length - 1].seq], [N - rb.api.MAX, N - 1]);

    // --- export round-trips ---
    var exp = JSON.parse(rb.api.auditExport());
    ok('export carries schema + ver + entries', exp.schema === 1 && exp.ver === '1.78.28' && Array.isArray(exp.entries) && exp.entries.length === rb.api.MAX, JSON.stringify({ schema: exp.schema, ver: exp.ver, n: exp.entries.length }));

    return out;
  }, function (err) {
    out.push({ name: 'cases ran without throwing', ok: false, detail: String(err && err.stack || err) });
    return out;
  });
}

// ---- Negative controls ------------------------------------------------------
// Each reverts one guarantee. A control that cannot go red is worse than none, so every entry
// is asserted to produce at least one failing case.
var MUTATIONS = [
  { what: 'the unregistered-op guard removed',
    m: function (s) { return mutate(s, 'if (!meta) return Promise.reject(new Error(\'bwnGqlOp: unregistered operation "\' + op + \'"\'));', 'if (false) { void op; }'); } },
  { what: 'the success:false envelope no longer rejected',
    m: function (s) { return mutate(s, 'if (env && env.success === false) {', 'if (false) {'); } },
  { what: 'the retry gate widened to non-idempotent writes',
    m: function (s) { return mutate(s, "meta.retry === 'safe'", "meta.retry !== 'never'"); } },
  { what: 'the feature kill switch removed',
    m: function (s) { return mutate(s, 'if (opts.feature && BWN_MODULES[opts.feature] === false) {', 'if (false) {'); } },
  { what: 'validate() no longer blocks',
    m: function (s) { return mutate(s, 'if (vr !== true) {', 'if (false) {'); } },
  { what: 'the audit before-field slurps the whole variables (PII leak)',
    m: function (s) { return mutate(s, 'before: (opts.before === undefined ? null : opts.before),', 'before: variables,'); } },
  { what: 'the ring buffer cap removed (unbounded log)',
    m: function (s) { return mutate(s, 'if (a.length > BWN_AUDIT_MAX) a = a.slice(a.length - BWN_AUDIT_MAX);', 'if (false) { void a; }'); } },
  { what: 'the transient classifier inverted',
    m: function (s) { return mutate(s, 'return /network|failed to fetch|load failed|timeout|timed out/i.test(', 'return !/network|failed to fetch|load failed|timeout|timed out/i.test('); } },
  { what: 'the high-risk confirm gate removed (high-risk sends unconfirmed)',
    m: function (s) { return mutate(s, "meta.risk === 'high'", "meta.risk === 'nope'"); } },
  { what: 'a cancelled confirm proceeds anyway',
    m: function (s) { return mutate(s, 'if (!okd) {', 'if (false) {'); } },
  { what: 'F3: the unrecognized-write-envelope guard removed (silent ok on a no-success response)',
    m: function (s) { return mutate(s, "if (!env || typeof env.success !== 'boolean') {", "if (false) {"); } },
  { what: 'F5: the audit reason copies the raw server message back in (PII leak)',
    m: function (s) { return mutate(s, "writeAudit('error', { tries: tryNo, reason: 'write-refused' });", "writeAudit('error', { tries: tryNo, reason: refused.message });"); } }
];

// Confirm-gate coverage for the writes newly adopted in F2. createDraftProposal + editProposal
// are registered high-risk in bwn-proposal-copy's OWN registry; load that registry over the same
// (SHA-gated) WRAP via makeOps and prove the gate applies to them: fail-closed with no
// confirmation, through with confirmed:true. (kanban's patchWorkOrder + low-gp's addEditJobNote
// reuse ops already covered above via Core's registry.)
function runProposalGateCases() {
  console.log('\n-- newly high-risk proposal writes are gated (bwn-proposal-copy registry) --');
  var PC = fs.readFileSync(path.join(__dirname, '..', 'bwn-proposal-copy.user.js'), 'utf8').replace(/\r\n/g, '\n');
  var a = PC.indexOf('  var BWN_OPS = {'), b = PC.indexOf('  // ===== BWN-OPS-WRAP END v2 =====');
  if (a === -1 || b === -1 || b < a) { A.ok('proposal-copy BWN-OPS block is sliceable', false, 'markers not found'); return Promise.resolve(); }
  var pc = makeOps(PC.slice(a, b));
  function settle(p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); }
  var cdp = pc.api.OPS.createDraftProposal, edp = pc.api.OPS.editProposal;
  A.ok('proposal-copy registers createDraftProposal as a high-risk write', cdp && cdp.kind === 'write' && cdp.risk === 'high', JSON.stringify(cdp));
  A.ok('proposal-copy registers editProposal as a high-risk write', edp && edp.kind === 'write' && edp.risk === 'high', JSON.stringify(edp));
  var Q_C = 'mutation CreateDraftProposal { createDraftProposal { success } }';
  var Q_E = 'mutation EditProposal { editProposal { success } }';
  pc.plan = [{ data: { createDraftProposal: { success: true } } }]; pc.calls = [];
  return settle(pc.api.run('createDraftProposal', Q_C, {}, { ids: { wo: 1 } })).then(function (r) {
    A.ok('createDraftProposal with NO confirmation is refused', !r.ok && /confirmation/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    A.eq('and nothing was sent for the unconfirmed create', pc.calls.length, 0);
    var la = pc.api.auditAll(); A.ok('the unconfirmed create is audited denied (confirm-required)', la.length > 0 && la[la.length - 1].outcome === 'denied' && /confirm-required/.test(String(la[la.length - 1].reason)), JSON.stringify(la[la.length - 1]));
    pc.plan = [{ data: { createDraftProposal: { success: true } } }]; pc.calls = [];
    return settle(pc.api.run('createDraftProposal', Q_C, {}, { confirmed: true, ids: { wo: 1 } }));
  }).then(function (r) {
    A.ok('createDraftProposal with confirmed:true proceeds', r.ok, r.ok ? '' : String(r.e && r.e.message));
    A.eq('and the confirmed create sent exactly once', pc.calls.length, 1);
    pc.plan = [{ data: { editProposal: { success: true } } }]; pc.calls = [];
    return settle(pc.api.run('editProposal', Q_E, {}, { ids: { proposalId: 9 } }));
  }).then(function (r) {
    A.ok('editProposal with NO confirmation is refused', !r.ok && /confirmation/.test(String(r.e && r.e.message)), r.ok ? 'resolved' : String(r.e && r.e.message));
    A.eq('and nothing was sent for the unconfirmed edit', pc.calls.length, 0);
    pc.plan = [{ data: { editProposal: { success: true } } }]; pc.calls = [];
    return settle(pc.api.run('editProposal', Q_E, {}, { confirmed: true, ids: { proposalId: 9 } }));
  }).then(function (r) {
    A.ok('editProposal with confirmed:true proceeds', r.ok, r.ok ? '' : String(r.e && r.e.message));
    A.eq('and the confirmed edit sent exactly once', pc.calls.length, 1);
  });
}

function main() {
  console.log('\n-- the shipped BWN-OPS block --');
  return runCases(S_OPS).then(function (results) {
    results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

    console.log('\n-- negative controls: each must turn the cases above red --');
    return MUTATIONS.reduce(function (chain, mut) {
      return chain.then(function () {
        var mutated;
        try { mutated = mut.m(S_OPS); }
        catch (err) { A.ok('CAUGHT: ' + mut.what, false, 'mutate() failed: ' + (err && err.message)); return; }
        return runCases(mutated).then(function (rs) {
          var reds = rs.filter(function (r) { return !r.ok; });
          A.ok('CAUGHT: ' + mut.what, reds.length > 0,
            reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
        });
      });
    }, Promise.resolve());
  }).then(function () {
    // BWN-OPS-WRAP is the generic machinery, pasted byte-identical into every sandbox that
    // adopts bwnGqlOp (the registry + transport differ per file; the wrapper must not). A
    // paste has no mechanism behind it, so this gate goes red if a fix lands in one copy and
    // not the other - same discipline as the bwnAI and BWN-SHARED SHA gates.
    console.log('\n-- BWN-OPS-WRAP paste-identical across adopters --');
    var ADOPTERS = ['bwn-suite-core.user.js', 'bwn-drop-upload.user.js', 'bwn-dispatch.user.js', 'bwn-temp-vendor.user.js', 'bwn-proposal-actions.user.js', 'bwn-kanban.user.js', 'bwn-proposal-copy.user.js', 'bwn-low-gp.user.js'];
    var wraps = ADOPTERS.map(function (f) {
      var s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
      var a = s.indexOf('// ===== BWN-OPS-WRAP START v2');
      var b = s.indexOf('// ===== BWN-OPS-WRAP END v2 =====');
      return { f: f, w: (a !== -1 && b !== -1 && b > a) ? s.slice(a, b) : null };
    });
    var haveAll = wraps.every(function (x) { return x.w !== null; });
    A.ok('every listed adopter carries the BWN-OPS-WRAP block', haveAll,
      wraps.filter(function (x) { return !x.w; }).map(function (x) { return x.f; }).join(','));
    if (haveAll) {
      wraps.slice(1).forEach(function (x) {
        A.ok('BWN-OPS-WRAP is byte-identical in ' + x.f + ' (drift = a fix in one sandbox not the other)', x.w === wraps[0].w);
      });
    }
    return runProposalGateCases();
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
