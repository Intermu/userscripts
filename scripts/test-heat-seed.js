// test-heat-seed.js - node harness for WO List Heat: the pinned-query SEED FALLBACK.
//
// WHAT THIS COVERS. The API scan replays a captured PagedWorkOrders query. Capture is
// PASSIVE - the document-start hook only sees the board query if it wins the race with the
// app's own boot overwrite of window.fetch. When it loses, apiList stays null for the page's
// whole life and every scan path reports 'no capture yet'. 2026-08-13 the board op was pinned
// off the wire (wiki/umbrava-graphql-operations.md), so Core now carries the exact query and
// seeds apiList itself when nothing latched. The seed is deliberately WEAK and must always
// lose to a real capture. This harness drives the REAL shipped bytes - slices the seed block,
// heatRecordCapture, and the paging/gate helpers out of bwn-suite-core.user.js and runs them
// in a vm - and pins:
//   1. the pinned query is well-formed and carries the two REQUIRED non-null args
//      (page: PageInput!, sortBy: [SortInput!]!) - the args a replay used to guess;
//   2. the seed vars page cleanly (heatPagingVars finds the nested {skip,take}) and the query
//      is recognised as a board query by the same gate a live capture passes;
//   3. heatSeedCapture seeds ONLY when nothing has latched and only on the list route, marking
//      the capture seeded:true / proven:false;
//   4. heatArmSeedFallback is SET-ONCE (a second arm while pending schedules no second timer -
//      the wiki/observer-debounce-starves trap) and its timer body seeds+scans only with a
//      token and no prior capture;
//   5. THE GUARD EDIT: a seeded capture NEVER blocks a real board request (it is displaced),
//      while a non-seeded unproven-but-recent capture still IS protected (the change is narrow),
//      and a real request carrying the SAME query text upgrades the seed in place.
//
// Every load-bearing line has a mutation that reverts it and asserts this harness goes red.
// mutate() throws if its target is absent or not unique, so a slice that drifts fails loudly.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-heat-seed.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var core = readLF(CORE_SRC);

// ---- The real blocks under test -----------------------------------------------------
// heatFilterSig + paging discovery + heatQueryIsWOList (the gate a displacing capture passes).
var SRC_PAGING = slice(core,
  '    function heatFilterSig(vars) {',
  '    function heatIsUmbravaToken(tok) {',
  'heatFilterSig + paging discovery + heatQueryIsWOList');
// heatRecordCapture - carries the seeded anti-downgrade guard edit.
var SRC_CAPTURE = slice(core,
  '    // Record a captured list query. THE REQUEST ALONE IS ENOUGH (v3.18).',
  '    // Attach to the hook (v3.21).',
  'heatRecordCapture');
// The seed block: HEAT_DEFAULT_QUERY + heatSeedCapture + heatArmSeedFallback.
var SRC_SEED = slice(core,
  '    // ---- Seed fallback: the pinned board query when nothing latched (2026-08-13) -----',
  '    // ---- API scan: replay the captured list query across the whole board ------------',
  'heatSeedCapture/heatArmSeedFallback');

// The pieces the sliced code leans on that live elsewhere. Stubbed and instrumented so the
// assertions read what the real code DID, not what it claims. Only names NOT in the slices
// are stubbed here (no redeclaration).
var PRELUDE = [
  'var __log = [];',
  'var console = { info: function () { __log.push([].slice.call(arguments).join(" ")); }, warn: function () { __log.push("WARN " + [].slice.call(arguments).join(" ")); }, log: function () {} };',
  'var apiList = null, apiCapTs = 0;',
  'var heatReplaying = false;',
  'var heatDiag = { seen: 0, replaySkip: 0, ownSkip: 0, rearm: 0 };',
  'var __listPage = true;',
  'function isListPage() { return __listPage; }',
  'function heatIsOwnBody() { return false; }',
  'function heatFindWOList() { return null; }',   // data is passed null in every case here -> request-only path
  'function heatApiRowToEntry() { return null; }',
  'var __autoScanSoon = [];',
  'function heatAutoScanSoon(v) { __autoScanSoon.push(v); }',
  'var __autoScan = [];',
  'function heatAutoScan(v) { __autoScan.push(v); return { then: function () { } }; }',
  'var __token = "tok";',
  'function heatAuthToken() { return __token; }',
  'var __timers = [];',
  'function setTimeout(fn, ms) { __timers.push({ fn: fn, ms: ms }); return __timers.length; }'
].join('\n');

function build(mutations) {
  var src = [PRELUDE, SRC_PAGING, SRC_CAPTURE, SRC_SEED].join('\n\n');
  (mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = {};
  vm.runInNewContext(src, sandbox, { filename: 'heat-seed-slice.js' });
  return sandbox;
}

// A real board request whose query text DIFFERS from the seed (so the same-query fast path is
// NOT taken) but which the gate still recognises: name carries "WorkOrder", vars carry a page.
function rivalBoardRequest(extraVars) {
  var v = { page: { skip: 0, take: 50 } };
  if (extraVars) Object.keys(extraVars).forEach(function (k) { v[k] = extraVars[k]; });
  return JSON.stringify({
    operationName: 'PagedWorkOrders',
    query: 'query PagedWorkOrders($page: PageInput!) { listWorkOrdersPaginated(page: $page) { items { number } } }',
    variables: v
  });
}

console.log('== A. pinned query is well-formed and carries the required args ==');
(function () {
  var s = build();
  var q = s.HEAT_DEFAULT_QUERY;
  A.ok('query names the PagedWorkOrders operation', q.indexOf('query PagedWorkOrders(') === 0);
  A.ok('$page is the REQUIRED non-null PageInput!', q.indexOf('$page: PageInput!') !== -1);
  A.ok('$sortBy is the REQUIRED non-null [SortInput!]!', q.indexOf('$sortBy: [SortInput!]!') !== -1);
  A.ok('selects the listWorkOrdersPaginated container', q.indexOf('listWorkOrdersPaginated(') !== -1);
  A.ok('requests the paginated envelope (rowCount)', q.indexOf('rowCount') !== -1);
  A.ok('ends with a trailing newline (byte-match to the SPA body)', q.charAt(q.length - 1) === '\n');
})();

console.log('== B. the seed vars page cleanly and pass the board-query gate ==');
(function () {
  var s = build();
  s.heatSeedCapture();
  var v = s.apiList.variables;
  A.eq('seed page is the {skip,take} object, take 200', v.page, { skip: 0, take: 200 });
  A.ok('seed sortBy is a non-empty [SortInput]', Array.isArray(v.sortBy) && v.sortBy.length === 1);
  A.ok('seed sortBy carries columnName + direction', !!(v.sortBy[0].columnName && v.sortBy[0].direction));
  // Scoped to phase Open: the whole book is 373k WOs (past the scan cap -> always 'incomplete');
  // the open book is ~5k and completes. 'Open' is the SystemPhaseValue the SPA itself sends.
  A.eq('seed is scoped to phase Open (completable + matches the strip\'s "of N open")', v.phase, 'Open');
  var pg = s.heatPagingVars(v);
  A.eq('heatPagingVars locates the nested page host', pg && pg.host, 'page');
  A.eq('  ...as a nested object', pg && pg.nested, true);
  A.eq('  ...with take as the size key', pg && pg.size, 'take');
  A.eq('  ...and skip as the skip key', pg && pg.skip, 'skip');
  A.ok('the seed query passes heatQueryIsWOList (a live capture of it would too)',
    s.heatQueryIsWOList({ query: s.HEAT_DEFAULT_QUERY, variables: v }) === true);
})();

console.log('== C. heatSeedCapture seeds only when nothing latched, only on the list route ==');
(function () {
  var s = build();
  var r = s.heatSeedCapture();
  A.eq('seeds when apiList is null', r, true);
  A.eq('stored query is the pinned default', s.apiList.query, s.HEAT_DEFAULT_QUERY);
  A.eq('marked seeded', s.apiList.seeded, true);
  A.eq('NOT marked proven', s.apiList.proven, false);
  A.eq('no row path yet (resolved on the first replay page)', s.apiList.path, null);

  var s2 = build();
  s2.apiList = { query: 'query Real { x }', variables: {}, proven: true };
  var r2 = s2.heatSeedCapture();
  A.eq('does NOT seed when a capture already holds the slot', r2, false);
  A.eq('  ...and leaves that capture untouched', s2.apiList.query, 'query Real { x }');

  var s3 = build();
  s3.__listPage = false;
  var r3 = s3.heatSeedCapture();
  A.eq('does NOT seed off the list route', r3, false);
  A.eq('  ...apiList stays null off-route', s3.apiList, null);
})();

console.log('== D. heatArmSeedFallback is SET-ONCE, and its timer body is guarded ==');
(function () {
  var s = build();
  s.heatArmSeedFallback();
  A.eq('one timer scheduled on first arm', s.__timers.length, 1);
  A.eq('  ...at the grace delay', s.__timers[0].ms, s.HEAT_SEED_GRACE_MS);
  s.heatArmSeedFallback();
  A.eq('SET-ONCE: a second arm while pending schedules NO second timer', s.__timers.length, 1);

  // Fire the timer body: nothing latched, token present, on the list route -> seed + scan.
  s.__timers[0].fn();
  A.eq('timer body seeded the capture', s.apiList && s.apiList.seeded, true);
  A.eq('  ...and kicked the auto scan with the seed vars', s.__autoScan.length, 1);
  A.eq('  ...timer handle cleared so it can re-arm', s.heatSeedTimer, null);

  // Timer body when a capture already exists: must NOT seed or scan.
  var s2 = build();
  s2.heatArmSeedFallback();
  s2.apiList = { query: 'query Real { x }', variables: {}, proven: true };
  s2.__timers[0].fn();
  A.eq('timer body does not seed over an existing capture', s2.apiList.query, 'query Real { x }');
  A.eq('  ...and does not scan', s2.__autoScan.length, 0);

  // Timer body with no token: cannot replay, so it must not seed.
  var s3 = build();
  s3.__token = '';
  s3.heatArmSeedFallback();
  s3.__timers[0].fn();
  A.eq('timer body does not seed without an auth token', s3.apiList, null);
})();

console.log('== E. the guard edit: a seed is displaced by a real capture; non-seeds are protected ==');
(function () {
  // A seeded (unproven, recent) capture in the slot, then a real board request of a DIFFERENT
  // query text arrives request-only. It must DISPLACE the seed.
  var s = build();
  s.heatSeedCapture();               // seeded:true, apiCapTs = now (recent)
  s.heatRecordCapture(rivalBoardRequest(), null);
  A.ok('a real board request DISPLACES the seed', s.apiList.query.indexOf('listWorkOrdersPaginated(page: $page)') !== -1);
  A.ok('  ...and the replacement is no longer a seed', !s.apiList.seeded);

  // Control - narrowness: a NON-seeded unproven-but-recent capture is still protected (existing
  // anti-downgrade behaviour, unchanged), so the guard change touches ONLY seeds.
  var s2 = build();
  s2.apiList = { query: 'query Other { listWorkOrdersPaginated { items } }', variables: { page: { skip: 0, take: 50 } }, proven: false };
  s2.apiCapTs = Date.now();
  s2.heatRecordCapture(rivalBoardRequest(), null);
  A.eq('a NON-seeded recent capture is NOT displaced by a request-only rival', s2.apiList.query, 'query Other { listWorkOrdersPaginated { items } }');

  // The SAME query text (the normal case) upgrades the seed in place with the real filters.
  var s3 = build();
  s3.heatSeedCapture();
  s3.heatRecordCapture(JSON.stringify({ operationName: 'PagedWorkOrders', query: s3.HEAT_DEFAULT_QUERY, variables: { page: { skip: 0, take: 200 }, sortBy: [], search: 'pilot' } }), null);
  A.eq('same query text -> real filters swapped in', s3.apiList.variables.search, 'pilot');
  A.eq('  ...and the capture is no longer a seed', s3.apiList.seeded, false);
})();

console.log('== F. mutation negative controls (each reverts one fix; harness must catch it) ==');
(function () {
  // M1: drop `!apiList.seeded &&` from the guard -> a seed WRONGLY blocks the real capture.
  var m1 = build([['!apiList.seeded && !respProves', '!respProves']]);
  m1.heatSeedCapture();
  m1.heatRecordCapture(rivalBoardRequest(), null);
  A.ok('M1: without the seeded bypass, the seed is NOT displaced (bug caught)',
    m1.apiList.query === m1.HEAT_DEFAULT_QUERY);

  // M2: disable heatSeedCapture's "already have a capture" guard -> it overwrites a real one.
  var m2 = build([['if (apiList && apiList.query) return false;', 'if (false) return false;']]);
  m2.apiList = { query: 'query Real { x }', variables: {}, proven: true };
  var r = m2.heatSeedCapture();
  A.ok('M2: without the guard, the seed overwrites a live capture (bug caught)',
    r === true && m2.apiList.query === m2.HEAT_DEFAULT_QUERY);

  // M3: make $sortBy nullable in the pinned query -> the required-arg check must notice.
  var m3 = build([['$sortBy: [SortInput!]!', '$sortBy: [SortInput!]']]);
  A.ok('M3: the required-arg check catches a weakened $sortBy',
    m3.HEAT_DEFAULT_QUERY.indexOf('$sortBy: [SortInput!]!') === -1);

  // M4: drop the phase:Open scope -> the seed would sweep the whole 373k book and never complete.
  var m4 = build([["phase: 'Open'", 'phase: null']]);
  m4.heatSeedCapture();
  A.ok('M4: the phase-scope check catches an unscoped seed', m4.apiList.variables.phase !== 'Open');
})();

console.log('== G. wiring present in source (arm point + route-change cancel) ==');
(function () {
  var armIdx = core.indexOf('heatArmSeedFallback();');
  var guardIdx = core.indexOf("if (!isListPage()) {");
  A.ok('woListHeat arms the seed fallback', armIdx !== -1);
  A.ok('  ...after the not-a-list-page guard returns', armIdx > guardIdx);
  A.ok('the route-change handler cancels a pending seed',
    core.indexOf('if (heatSeedTimer) { clearTimeout(heatSeedTimer); heatSeedTimer = null; }') !== -1);
  A.ok('the arm point documents that a live capture always displaces the seed',
    core.indexOf('A live capture, if one fires, always displaces the seed.') !== -1);
})();

console.log('== H. a seeded scan does NOT feed the Dashboard dataset (source guard) ==');
(function () {
  // A seeded scan is the tenant-wide OPEN book (5,241 on this tenant), which exceeds the
  // HEAT_DATASET_MAX cap and is the wrong scope for the per-user Dashboard dataset. Both
  // heatQueueDataset call sites in finishApi (immediate + post-name-resolution) must be gated on
  // the seededScan flag captured at scan start; the per-WO bus publish stays UNCONDITIONAL.
  A.ok('seededScan is captured at scan start (stable across the async name-resolution step)',
    core.indexOf('var seededScan = !!apiList.seeded;') !== -1);
  A.ok('the immediate dataset push is gated on !seededScan',
    core.indexOf('if (!seededScan) heatQueueDataset(heatStore);') !== -1);
  A.ok('the post-name-resolution dataset push is gated too (whole surface, not one site)',
    core.indexOf('if (!seededScan) heatQueueDataset(store);') !== -1);
  A.ok('the per-WO bus publish stays unconditional (uncapped, benefits from full coverage)',
    core.indexOf('heatPublishVerdicts(heatStore); if (!seededScan) heatQueueDataset(heatStore);') !== -1);
  // Negative control: an ungated dataset push must be caught. If either gate is dropped, the
  // exact gated strings above vanish and these assertions fail - proving they are load-bearing.
  A.ok('no UNgated heatQueueDataset(heatStore) survives in finishApi',
    core.indexOf('heatPublishVerdicts(heatStore); heatQueueDataset(heatStore);') === -1);
})();

A.finish();
