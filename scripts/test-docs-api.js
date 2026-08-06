// test-docs-api.js - node harness for the docs-verify API route (jobDocuments),
// rebuilt into bwn-suite-core 1.66.34 / WO Assist 2.68 on 2026-08-06.
//
// THE DEFECT, as found in source:
//   readDocs() scanned the DOM for a "Documents (N)" header or `document-row` testids.
//   Neither exists on a real WO - the Documents DOM was never pinned - so the read
//   returned null on EVERY call, and because the closure gate correctly treats null as
//   "unknown", docs:none has never fired in production since Phase 2 shipped. The gate
//   was not broken; it was starved.
//
//   The API route that replaces it was WRITTEN on 2026-07-23 (worktree
//   claude/elated-maxwell-277600) and never committed. `git log --all -S jobDocuments`
//   was empty, no stash, no worktree, no file - while the vault recorded the route as
//   BUILT and "the DOM scrape is gone". Two sibling routes from the same day (readWO,
//   fetchTrips) survived only because they were edited in the MAIN checkout.
//
// THE FIX, as sliced from source:
//   DOCS_CACHE + JOB_DOCUMENTS_Q + fetchDocs (async, fills the cache, re-renders) and
//   readDocs (SYNC cache read, so compute() and the pure engine stay synchronous) -
//   the third reader in the readWO/fetchTrips cluster, same cache shape as both.
//
// WHAT THIS PROVES, against the REAL shipped bytes (sliced from bwn-suite-core.user.js
// and run in a vm against a stub bwnGql - nothing here is a restatement):
//   - the query is keyed by workOrderNumber. jobId is a DIFFERENT identifier that
//     jobDocuments also accepts, so sending the wrong one is a silent wrong answer
//     rather than an error - the reason it is pinned here.
//   - woId() returns a STRING; the Int! variable must go out as a NUMBER.
//   - a pending read is null and does NOT re-fire once per render.
//   - archived documents never reach the count.
//   - a non-list payload and a rejected fetch are UNKNOWN (null), NEVER empty.
//   - only a confident {count:0} fires docs:none; null and docs-present do not; and
//     the gate stays inside the confirm-complete / cost-review phases.
//
// WHAT IT DOES NOT PROVE:
//   - that `jobDocuments` exists on the live schema for this tenant. Only a real WO
//     answers that. The live gate is one zero-document confirm-complete work order.
//   - anything about how the checklist RENDERS the step.
//
// Every case is re-run against mutated copies of the same source; each mutation MUST
// turn this harness red. mutate() throws if its target is absent or not unique, so a
// mutation that silently no-ops cannot pass for a control.
//
// It is also the tripwire for the route vanishing a second time: the slices below throw
// if the reader or the gate is not in bwn-suite-core.user.js, so a lost or reverted
// route fails CI loudly instead of quietly restoring the dormant gate.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-docs-api.js

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

var S_READER = slice('    var DOCS_CACHE = Object.create(null);', '    // ---- Signals ---', 'DOCS_CACHE+fetchDocs+readDocs');
var S_GATE = slice("      if (woPhase === 'confirmcomplete' || woPhase === 'costreview') {", '      // ---- Closure auto-advance:', 'docs:none gate');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- Environment ------------------------------------------------------------
// bwnGql is stubbed as a DEFERRED promise per call so a test can hold a read
// "pending" - the state the gate has to treat as unknown - and land it later.
function makeReader(readerSrc) {
  var env = { fetches: [], refreshes: 0, wo: null };
  var sandbox = {
    Object: Object, Array: Array, Number: Number, JSON: JSON, Promise: Promise,
    Error: Error, console: console,
    currentWOId: function () { return env.wo; },
    refresh: function () { env.refreshes++; },
    bwnGql: function (query, variables) {
      var rec = { query: query, vars: variables };
      rec.p = new Promise(function (res, rej) { rec.resolve = res; rec.reject = rej; });
      env.fetches.push(rec);
      return rec.p;
    }
  };
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + readerSrc + '\n' +
    'return { readDocs: readDocs, fetchDocs: fetchDocs, cache: DOCS_CACHE, q: JOB_DOCUMENTS_Q };\n})()',
    sandbox, { filename: 'docs-reader.js' });
  env.readDocs = api.readDocs;
  env.cache = api.cache;
  env.q = api.q;
  return env;
}

// The gate block verbatim, given only the state the real caller gives it.
function makeGate(gateSrc) {
  return vm.runInNewContext(
    '(function (woPhase, docs) {\n' +
    '  var acts = [], ref = "W-1", ACT_SIGNALS = { stall: "stall" };\n' +
    '  var state = { docs: docs };\n' +
    gateSrc + '\n' +
    '  return acts.length;\n})',
    { }, { filename: 'docs-gate.js' });
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

// ---- The cases --------------------------------------------------------------
// Returns a result list rather than asserting directly, so the same cases can be
// re-run against a mutant and checked for redness.
function runCases(readerSrc, gateSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }

  var e, gate;
  try { e = makeReader(readerSrc); gate = makeGate(gateSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return Promise.resolve(out); }

  // --- off a work order: no read at all
  e.wo = null;
  eq('off a WO the read is unknown, not empty', e.readDocs(), null);
  eq('and no request is made', e.fetches.length, 0);

  // --- first read on a WO: unknown, one request, correct shape
  e.wo = '370534';                                  // woId() returns a STRING
  eq('the first read is unknown while the fetch is in flight', e.readDocs(), null);
  eq('exactly one request fired', e.fetches.length, 1);
  ok('the query is keyed by workOrderNumber, not jobId',
    /jobDocuments\(\s*workOrderNumber:\s*\$n/.test(e.q), e.q.slice(0, 120));
  ok('archived documents are excluded at the source too',
    /includeArchived:\s*false/.test(e.q), e.q.slice(0, 160));
  ok('isArchived is selected, so the client filter has something to read',
    /\bisArchived\b/.test(e.q), e.q.slice(0, 200));
  ok('the WO number goes out as a NUMBER (Int!), not the string woId returned',
    e.fetches[0].vars.n === 370534, JSON.stringify(e.fetches[0].vars));

  // --- a second render while the first read is pending must NOT re-fire
  eq('a re-render during the pending read is still unknown', e.readDocs(), null);
  eq('and did not fire a second request', e.fetches.length, 1);

  e.fetches[0].resolve({ jobDocuments: [
    { id: 'd1', label: 'Signed Ticket', displayFileName: 'ticket.pdf', isArchived: false },
    { id: 'd2', label: 'Superseded', displayFileName: 'old.pdf', isArchived: true },
    { id: 'd3', label: 'Photos', displayFileName: 'after.jpg', isArchived: false }
  ] });

  return tick().then(function () {
    var got = e.readDocs();
    eq('the landed read counts only the LIVE documents', got && got.count, 2);
    eq('and the archived one is not in the list either',
      (got && got.docs || []).map(function (d) { return d.id; }), ['d1', 'd3']);
    eq('the landing triggered exactly one re-render', e.refreshes, 1);
    eq('a cached read fires no further requests', e.fetches.length, 1);
    ok('a cached read is the same object, not a refetch', e.readDocs() === got);

    // --- confident empty
    e.wo = '400001';
    eq('a fresh WO starts unknown again', e.readDocs(), null);
    eq('and fires its own request', e.fetches.length, 2);
    e.fetches[1].resolve({ jobDocuments: [] });
    return tick();
  }).then(function () {
    var empty = e.readDocs();
    eq('an empty document list is a CONFIDENT zero, not unknown', empty, { count: 0, docs: [] });

    // --- gate semantics, against the real gate block
    eq('docs:none fires on a confident zero at confirm-complete', gate('confirmcomplete', empty), 1);
    eq('and at cost-review', gate('costreview', empty), 1);
    eq('but never on unknown', gate('confirmcomplete', null), 0);
    eq('never when documents are present', gate('confirmcomplete', { count: 2, docs: [{}, {}] }), 0);
    eq('and not outside the closing phases', gate('intake', empty), 0);

    // --- a non-list payload is unknown, and self-heals on the next render
    e.wo = '400002';
    e.readDocs();
    e.fetches[2].resolve({ jobDocuments: null });
    return tick();
  }).then(function () {
    eq('a non-list payload reads as unknown', e.readDocs(), null);
    eq('docs:none stays quiet on it', gate('confirmcomplete', e.readDocs()), 0);
    eq('and the next render retries it', e.fetches.length, 4);
    e.fetches[3].resolve({ jobDocuments: [{ id: 'd9', isArchived: false }] });
    return tick();
  }).then(function () {
    eq('the retry lands normally', e.readDocs(), { count: 1, docs: [{ id: 'd9', isArchived: false }] });

    // --- a rejected fetch is unknown, NEVER empty. This is the one that matters:
    //     a failed read that read as "no documents" would nag every coordinator on
    //     every WO the moment the API had a bad minute.
    e.wo = '400003';
    e.readDocs();
    e.fetches[4].reject(new Error('network'));
    return tick();
  }).then(function () {
    eq('a failed read is unknown', e.readDocs(), null);
    eq('a failed read NEVER fires docs:none', gate('confirmcomplete', e.readDocs()), 0);
    return out;
  }, function (err) {
    out.push({ name: 'cases ran without throwing', ok: false, detail: String(err && err.message || err) });
    return out;
  });
}

// ---- Negative controls ------------------------------------------------------
// Each reverts one piece of the real behaviour. A control that cannot go red is
// worse than no control, so every entry below is asserted to produce failures.
var MUTATIONS = [
  { what: 'archived documents counted as live',
    reader: function (s) { return mutate(s, 'return r && !r.isArchived;', 'return r && r.isArchived;'); } },
  { what: 'the count hardcoded to zero',
    reader: function (s) { return mutate(s, 'DOCS_CACHE[woNum] = { count: live.length, docs: live };', 'DOCS_CACHE[woNum] = { count: 0, docs: live };'); } },
  { what: 'the query keyed by jobId instead of workOrderNumber',
    reader: function (s) { return mutate(s, 'jobDocuments(workOrderNumber: $n', 'jobDocuments(jobId: $n'); } },
  { what: 'the WO number sent as the raw string',
    reader: function (s) { return mutate(s, 'bwnGql(JOB_DOCUMENTS_Q, { n: Number(woNum) })', 'bwnGql(JOB_DOCUMENTS_Q, { n: woNum })'); } },
  { what: 'the in-flight guard dropped (a request per render)',
    reader: function (s) { return mutate(s, "if (c === 'pending' || (c && c !== 'error')) return;", 'if (false) return;'); } },
  { what: 'a failed read treated as a confident empty',
    reader: function (s) { return mutate(s, ".catch(function () { DOCS_CACHE[woNum] = 'error'; });", '.catch(function () { DOCS_CACHE[woNum] = { count: 0, docs: [] }; });'); } },
  { what: 'the gate firing on unknown as well as empty',
    gate: function (s) { return mutate(s, 'if (docs && docs.count === 0) {', 'if (!docs || docs.count === 0) {'); } },
  { what: 'the gate firing whenever it can read at all',
    gate: function (s) { return mutate(s, 'docs.count === 0', 'docs.count >= 0'); } },
  { what: 'the gate escaping its closing phases',
    gate: function (s) { return mutate(s, "if (woPhase === 'confirmcomplete' || woPhase === 'costreview') {", 'if (true) {'); } }
];

function main() {
  console.log('\n-- the shipped docs route --');
  return runCases(S_READER, S_GATE).then(function (results) {
    results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

    console.log('\n-- negative controls: each must turn the cases above red --');
    return MUTATIONS.reduce(function (chain, m) {
      return chain.then(function () {
        var reader = m.reader ? m.reader(S_READER) : S_READER;
        var gate = m.gate ? m.gate(S_GATE) : S_GATE;
        return runCases(reader, gate).then(function (rs) {
          var reds = rs.filter(function (r) { return !r.ok; });
          A.ok('CAUGHT: ' + m.what, reds.length > 0,
            reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
        });
      });
    }, Promise.resolve());
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
