// test-views-api.js - node harness for BWN Views v2.x's API column apply
// (userPreference read + putUserPreference write on tables/masterWOListTable/settings)
// and its mount lifecycle. Built into bwn-suite-core 1.66.38-1.66.40 on 2026-08-07.
//
// LIFECYCLE (v2.1/v2.2): the v2.0 clear-and-reset debounce NEVER fired on the live
// list (every mutation reset the pending timer; throttling stretched the windows),
// so the pill never left its boot fallback. The set-once schedule is the fix. The
// lifecycle block is EXECUTED here in a vm with stubbed timers - the adversarial
// review (2026-08-07) proved shape-only regex pins let the nearest-neighbor bug
// (deleting the `tick = null` re-arm) ship green, so liveness is now behavioral:
// set-once (1 registration, 0 clears), re-arm after fire, ladder + nav wiring.
//
// WHAT THE OVERHAUL REPLACED:
//   Views v1.0 applied a column set by 50 passes of column-chooser checkbox
//   choreography (open the popover, re-query fresh <li> rows, toggle ONE mismatch,
//   repeat) plus timing sleeps. v2.0 writes Umbrava's own column preference and
//   reloads; the chooser path survives only as the fallback.
//
// THE CONTRACT, measured live 2026-08-07 (see wiki/umbrava-graphql-operations.md):
//   read : userPreference(applicationId,key,isTenantSpecific) -> {key,version,value}
//   write: putUserPreference(data:PutUserPreferenceInput!) -> {success,message}
//          - the response does NOT echo the pref; selecting key/version/value on it
//            is a validation error that rejects the whole document (hit live).
//   value: stringified JSON {hiddenColumnNames,columnWidths,columnSorting} - the
//          HIDDEN set drives the layout, so a column set = hide everything unwanted.
//   version: a schema stamp ("2026-07-31-f6c090d"), echoed from the read. Hardcoding
//          it would break on Umbrava's next deploy.
//
// WHAT THIS PROVES against the REAL shipped bytes (sliced from bwn-suite-core.user.js,
// run in a vm against a deferred-promise bwnGql stub):
//   - NAME_MAP carries all 30 measured chooser columns, including the traps: the row
//     titled "Label" is workOrderCategory (a stray `label` id is silently ignored by
//     the grid - the phantom this session itself wrote once), Status is statusId,
//     Client is clientTenantProfileId, City/State/money are dotted paths.
//   - an unmapped title THROWS (never guess an id) and nothing is written.
//   - hidden = all mapped ids minus the wanted ids; unknown ids already hidden are
//     PRESERVED (a future Umbrava column must not silently appear); widths and
//     sorting pass through verbatim.
//   - the write echoes the READ's version, sends isTenantSpecific:true, and selects
//     only {success message}; success:false rejects; a null read rejects with NO write.
//   - the reload continuation stash is consumed BEFORE applying (no reload loops)
//     and goes stale after 90s.
//   - applyView orders API-first-then-chooser-fallback, and location.reload() happens
//     only after stashPending.
//   - the dock keeps the menu-then-pill child order the command palette depends on,
//     and the toolbar discovery excludes header/nav (the global "Search Work Orders"
//     box must never anchor it).
//
// WHAT IT DOES NOT PROVE:
//   - that the live pref write lands (proven once by hand 2026-08-07, and gated on
//     the TM reinstall) or how DevExpress renders the resulting column set.
//
// Every case re-runs against mutated copies of the source; each mutation MUST turn
// this harness red. mutate() throws if its target is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-views-api.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

// Parameterized so mutation controls can slice a CHURNED copy with the same loud
// failure contract - a raw indexOf with no -1 guard goes silently vacuous on marker
// drift (review 2026-08-07).
function slice(src, start, end, what) {
  var a = src.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (src.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = src.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return src.slice(a, b);
}

var S_API = slice(coreFull, "    var PREF_APP = 'bn-web-spa';", '    function sleep(ms)', 'Views API block');
var S_APPLY = slice(coreFull, '    var applying = false;', '    // ---- Post-reload continuation', 'applyView');
var S_DOCK = slice(coreFull, '    // ---- Dock UI (v2.0: left of the list', '    // ---- Views lifecycle ---', 'ensureDock');
var S_LIFE = slice(coreFull, '    // ---- Views lifecycle ---', '    resumePending().catch', 'lifecycle');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- Environment ------------------------------------------------------------
function makeApi(apiSrc) {
  var env = { calls: [], store: {}, modules: { viewManager: true } };
  function gql(query, variables) {
    var rec = { query: query, vars: variables };
    rec.p = new Promise(function (res, rej) { rec.resolve = res; rec.reject = rej; });
    env.calls.push(rec);
    return rec.p;
  }
  var sandbox = {
    Object: Object, Array: Array, Number: Number, JSON: JSON, Promise: Promise,
    Error: Error, Date: Date, console: { info: function () { }, warn: function () { }, error: function () { } },
    sessionStorage: {
      getItem: function (k) { return (k in env.store) ? env.store[k] : null; },
      setItem: function (k, v) { env.store[k] = String(v); },
      removeItem: function (k) { delete env.store[k]; }
    },
    bwnGql: gql,
    // The Views write now routes through bwnGqlOp (Core 1.78.29). bwnGqlOp is proven
    // against the real bytes in test-bwn-ops.js; here a faithful stub reproduces its
    // caller-visible contract - feature kill switch, pre-send validate, delegate to
    // bwnGql, reject a success:false envelope - so this harness stays focused on Views.
    bwnGqlOp: function (op, query, variables, opts) {
      opts = opts || {};
      if (opts.feature && env.modules[opts.feature] === false) return Promise.reject(new Error('feature "' + opts.feature + '" is disabled'));
      if (typeof opts.validate === 'function') { var vr = opts.validate(variables); if (vr !== true) return Promise.reject(new Error('validation: ' + vr)); }
      return gql(query, variables).then(function (data) {
        var envd = data && data[op];
        if (envd && envd.success === false) return Promise.reject(new Error(envd.message || (op + ' was refused')));
        return data;
      });
    }
  };
  sandbox.localStorage = {
    getItem: function (k) { return (k in env.ls) ? env.ls[k] : null; },
    setItem: function (k, v) { env.ls[k] = String(v); },
    removeItem: function (k) { delete env.ls[k]; }
  };
  env.ls = {};
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + apiSrc + '\n' +
    'return { NAME_MAP: NAME_MAP, TITLE_BY_ID: TITLE_BY_ID, buildColumnsValue: buildColumnsValue,\n' +
    '         apiApplyColumns: apiApplyColumns, apiApplyValue: apiApplyValue, titlesFromValue: titlesFromValue,\n' +
    '         loadViews: loadViews, saveViews: saveViews, addView: addView, deleteView: deleteView,\n' +
    '         captureCurrent: captureCurrent,\n' +
    '         stashPending: stashPending, takePending: takePending,\n' +
    '         PREF_READ_Q: PREF_READ_Q, PREF_WRITE_Q: PREF_WRITE_Q, PREF_KEY: PREF_KEY, PREF_APP: PREF_APP };\n})()',
    sandbox, { filename: 'views-api.js' });
  env.api = api;
  return env;
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

// ---- Lifecycle runner ---------------------------------------------------------
// Executes the lifecycle block with stubbed timers so liveness is PROVEN, not
// pattern-matched (headless harness cannot time, and does not need to - the
// registrations and clears ARE the behavior).
function makeLife(lifeSrc) {
  var env = { timeouts: [], clears: 0, ensureDockCalls: 0, listeners: [] };
  var idc = 0;
  var sandbox = {
    Object: Object, Array: Array, Error: Error, console: console,
    BWN: { guard: function (fn) { return fn; } },
    MutationObserver: function (cb) { this.observe = function () { env.observedBody = true; }; },
    window: { addEventListener: function (ev, fn) { env.listeners.push(ev); } },
    history: { pushState: function () { }, replaceState: function () { } },
    document: { body: {} },
    setTimeout: function (fn, ms) { env.timeouts.push({ fn: fn, ms: ms, id: ++idc }); return idc; },
    clearTimeout: function () { env.clears++; },
    ensureDock: function () { env.ensureDockCalls++; },
    resumePending: function () { return { catch: function () { } }; }
  };
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + lifeSrc + '\nreturn { schedule: schedule };\n})()',
    sandbox, { filename: 'views-lifecycle.js' });
  env.schedule = api.schedule;
  env.history = sandbox.history;
  env.at = function (ms) { return env.timeouts.filter(function (t) { return t.ms === ms; }); };
  return env;
}

function runLifeCases(lifeSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  var e;
  try { e = makeLife(lifeSrc); }
  catch (err) { out.push({ name: 'lifecycle loads', ok: false, detail: String(err && err.message || err) }); return out; }

  var ladder = e.timeouts.filter(function (t) { return t.ms !== 250; });
  ok('boot ladder registers all six one-shots (0..20000ms)',
    ladder.length === 6 && e.at(0).length === 1 && e.at(1000).length === 1 && e.at(2500).length === 1 &&
    e.at(5000).length === 1 && e.at(10000).length === 1 && e.at(20000).length === 1,
    'got ' + ladder.length + ' ladder registrations');
  var edBefore = e.ensureDockCalls;
  ladder[0].fn();
  ok('a ladder one-shot actually runs ensureDock (not a no-op)', e.ensureDockCalls === edBefore + 1);
  ok('nav + resize listeners wired',
    e.listeners.indexOf('popstate') !== -1 && e.listeners.indexOf('resize') !== -1, e.listeners.join(','));
  ok('the body observer is observing', e.observedBody === true);

  // set-once: two schedules, ONE registration, ZERO clears
  e.schedule(); e.schedule();
  var s1 = e.at(250);
  ok('schedule is set-once: two calls, one registration', s1.length === 1, s1.length + ' registrations');
  ok('and it never clears a pending timer', e.clears === 0, e.clears + ' clears');

  // re-arm after fire: THE liveness property. Deleting `tick = null` kills every
  // reschedule after the first - the dead-dock class that shipped twice.
  // A mutant can leave later steps unreachable - record red, never crash.
  try {
    var before = e.ensureDockCalls;
    if (s1.length) s1[0].fn();
    ok('the fired check runs ensureDock', e.ensureDockCalls === before + 1);
    e.schedule();
    var s2 = e.at(250);
    ok('schedule RE-ARMS after firing (tick reset)', s2.length === 2, s2.length + ' total 250ms registrations');

    // SPA nav wiring: a pushState after the fire must reschedule
    if (s2.length >= 2) s2[1].fn();
    e.history.pushState();
    ok('a history.pushState reschedules the mount check', e.at(250).length === 3, e.at(250).length + ' total');
  } catch (err) {
    ok('lifecycle cases completed without crashing', false, String(err && err.message || err));
  }
  return out;
}

var ALL_TITLES = ['Label', 'Phase', 'WO #', 'Tracking #', 'Status', 'Asset', 'Priority', 'City',
  'State', 'Location #', 'Trades', 'Scope Of Work', 'Time in Status (hrs.)', 'Last Note Date',
  'Client DNE', 'First Trip Date', '# Days', 'Expected Completion Date', 'Latest Update',
  'Remaining Days', 'WO Date', 'Vendor(s)', 'Client', 'Created By', 'Assigned To',
  'Scheduled Date', 'Type', 'Source Job #', 'Source PO #', 'Total Vendor NTE'];

// ---- The cases ----------------------------------------------------------------
async function runCases(apiSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }

  var e;
  try { e = makeApi(apiSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }
  var A = e.api;

  // --- NAME_MAP completeness + the measured traps
  eq('NAME_MAP carries all 30 chooser columns', Object.keys(A.NAME_MAP).length, 30);
  eq('the chooser row "Label" is workOrderCategory, never `label`', A.NAME_MAP['Label'], 'workOrderCategory');
  eq('Status is statusId (not statusName)', A.NAME_MAP['Status'], 'statusId');
  eq('Client is the tenant-profile ID column', A.NAME_MAP['Client'], 'clientTenantProfileId');
  eq('City is a dotted path', A.NAME_MAP['City'], 'address.city');
  eq('money columns are dotted .amount paths', A.NAME_MAP['Total Vendor NTE'], 'totalNTE.amount');
  ok('no mapped id is the phantom `label`',
    Object.keys(A.NAME_MAP).every(function (k) { return A.NAME_MAP[k] !== 'label'; }));

  // --- buildColumnsValue
  var cur = {
    hiddenColumnNames: ['phase', 'future.unknownColumn'],
    columnWidths: [{ columnName: 'scopeOfWork', width: 189 }],
    columnSorting: [{ columnName: 'phase', direction: 'desc' }]
  };
  var v = A.buildColumnsValue(cur, ALL_TITLES);
  eq('wanting every column hides only the preserved unknown id', v.hiddenColumnNames, ['future.unknownColumn']);
  eq('widths pass through verbatim', v.columnWidths, cur.columnWidths);
  eq('sorting passes through verbatim', v.columnSorting, cur.columnSorting);

  var v2 = A.buildColumnsValue(cur, ['Tracking #', 'Status']);
  eq('want-2 hides the other 28 mapped ids + 1 preserved unknown', v2.hiddenColumnNames.length, 29);
  ok('wanted ids are not hidden', v2.hiddenColumnNames.indexOf('trackingNumber') === -1 && v2.hiddenColumnNames.indexOf('statusId') === -1);
  ok('the Label trap id IS hidden when Label is unwanted', v2.hiddenColumnNames.indexOf('workOrderCategory') !== -1);
  ok('the unknown already-hidden id is preserved', v2.hiddenColumnNames.indexOf('future.unknownColumn') !== -1);

  var threw = null;
  try { A.buildColumnsValue(cur, ['Tracking #', 'No Such Column']); } catch (err) { threw = String(err.message); }
  ok('an unmapped title throws rather than guessing', /unmapped column title/.test(threw || ''), threw);

  // --- apiApplyColumns: full happy path
  var done = null, failed = null;
  A.apiApplyColumns(['Tracking #', 'Status']).then(function (r) { done = r; }, function (err) { failed = String(err && err.message); });
  await tick();
  eq('one read fired first', e.calls.length, 1);
  ok('the read targets the measured key', e.calls[0].vars.k === 'tables/masterWOListTable/settings', JSON.stringify(e.calls[0].vars));
  ok('the read is tenant-specific', e.calls[0].vars.t === true);
  ok('the read app id is bn-web-spa', e.calls[0].vars.a === 'bn-web-spa');
  e.calls[0].resolve({ userPreference: { key: 'tables/masterWOListTable/settings', version: '2027-01-15-deadbee', value: JSON.stringify(cur) } });
  await tick(); await tick();
  eq('the write fired after the read', e.calls.length, 2);
  var wd = e.calls[1].vars.d;
  ok('the write echoes the READ version, not a hardcoded stamp', wd.version === '2027-01-15-deadbee', wd.version);
  ok('the write is tenant-specific', wd.isTenantSpecific === true);
  ok('the write value round-trips as the computed JSON', JSON.parse(wd.value).hiddenColumnNames.length === 29, wd.value.slice(0, 80));
  ok('the write selects only success+message (the response does NOT echo the pref)',
    /putUserPreference\(data:\$d\)\{\s*success\s+message\s*\}/.test(A.PREF_WRITE_Q), A.PREF_WRITE_Q);
  e.calls[1].resolve({ putUserPreference: { success: true, message: 'ok' } });
  await tick(); await tick();
  eq('the apply resolves true on a verified write', done, true);
  eq('and did not reject', failed, null);

  // --- null read -> reject, and NO write
  var e2 = makeApi(apiSrc);
  var fail2 = null;
  e2.api.apiApplyColumns(['Tracking #']).then(null, function (err) { fail2 = String(err && err.message); });
  await tick();
  e2.calls[0].resolve({ userPreference: null });
  await tick(); await tick();
  ok('a never-customized pref rejects (DOM fallback)', /no existing column pref/.test(fail2 || ''), fail2);
  eq('and no write fired on the null read', e2.calls.length, 1);

  // --- success:false -> reject
  var e3 = makeApi(apiSrc);
  var fail3 = null;
  e3.api.apiApplyColumns(['Tracking #']).then(null, function (err) { fail3 = String(err && err.message); });
  await tick();
  e3.calls[0].resolve({ userPreference: { key: 'k', version: 'v', value: JSON.stringify(cur) } });
  await tick(); await tick();
  e3.calls[1].resolve({ putUserPreference: { success: false, message: 'nope' } });
  await tick(); await tick();
  ok('a success:false write rejects (surfaced by bwnGqlOp, not swallowed)', /nope/.test(fail3 || ''), fail3);

  // --- viewManager kill switch: a disabled module refuses the WRITE (read still runs) ---
  var eKill = makeApi(apiSrc);
  eKill.modules = { viewManager: false };
  var killErr = null;
  eKill.api.apiApplyColumns(['Tracking #']).then(null, function (err) { killErr = String(err && err.message); });
  await tick();
  eKill.calls[0].resolve({ userPreference: { key: 'k', version: 'v', value: JSON.stringify(cur) } });
  await tick(); await tick();
  ok('a disabled viewManager refuses the pref WRITE (kill switch)', /disabled/.test(killErr || ''), killErr);
  eq('only the read fired - the write was blocked before send', eKill.calls.length, 1);

  // --- continuation stash
  var e4 = makeApi(apiSrc);
  e4.api.stashPending({ name: 'Triage', assignee: { mode: 'me' }, woDateToday: false, reloadAfter: true });
  var p1 = e4.api.takePending();
  ok('a fresh stash comes back intact', p1 && p1.name === 'Triage' && p1.assignee.mode === 'me' && p1.reloadAfter === true, JSON.stringify(p1));
  eq('the stash is consumed BEFORE applying - a second take is null', e4.api.takePending(), null);
  e4.store['bwn:views:pending'] = JSON.stringify({ name: 'Old', ts: Date.now() - 120000 });
  eq('a stale stash (>90s) is ignored', e4.api.takePending(), null);

  // ---- v3.0: unknown-key preservation (the v2.x defect) --------------------
  // MEASURED 2026-08-07 off the bundle's own settings literal: the payload the SPA
  // writes is FOUR keys - {hiddenColumnNames, columnWidths, columnOrder,
  // columnSorting}. `columnOrder` only exists once the user drags a column, so the
  // first live capture showed three keys and v2.x rebuilt from exactly those three -
  // meaning the first view applied after any reorder would have WIPED the order.
  // The value must be copied, not reconstructed.
  var curPlus = {
    hiddenColumnNames: ['phase'],
    columnWidths: [{ columnName: 'scopeOfWork', width: 189 }],
    columnSorting: [{ columnName: 'phase', direction: 'desc' }],
    columnOrder: ['statusId', 'trackingNumber', 'address.city'],
    someFutureUmbravaKey: { nested: true }
  };
  var vp = A.buildColumnsValue(curPlus, ['Status', 'Tracking #']);
  eq('a stored column order survives a view apply', vp.columnOrder, curPlus.columnOrder);
  eq('an uncatalogued future key survives too', vp.someFutureUmbravaKey, curPlus.someFutureUmbravaKey);
  eq('widths still survive', vp.columnWidths, curPlus.columnWidths);
  eq('sorting still survives', vp.columnSorting, curPlus.columnSorting);
  ok('and the hidden set is still recomputed', vp.hiddenColumnNames.indexOf('workOrderCategory') !== -1);

  // ---- v3.0: the saved-views store ----------------------------------------
  var e5 = makeApi(apiSrc);
  eq('NO built-in presets - an untouched install starts empty', e5.api.loadViews(), []);
  e5.ls['bwn:config'] = JSON.stringify({ over30Days: 30, views: [] });   // a real config with other keys
  e5.api.addView({ id: 'v1', name: 'Triage', value: '{"hiddenColumnNames":["phase"]}', assignee: { mode: 'me' }, savedAt: 1 });
  var cfg = JSON.parse(e5.ls['bwn:config']);
  eq('saving a view preserves other bwn:config keys', cfg.over30Days, 30);
  eq('the view is stored', cfg.views.length, 1);
  e5.api.addView({ id: 'v2', name: 'triage', value: '{"hiddenColumnNames":["asset"]}', assignee: null, savedAt: 2 });
  eq('the same name (any case) OVERWRITES rather than making a twin', e5.api.loadViews().length, 1);
  eq('and the overwrite keeps the newer value', JSON.parse(e5.ls['bwn:config']).views[0].value, '{"hiddenColumnNames":["asset"]}');
  e5.api.addView({ id: 'v3', name: 'Dispatch', value: '{}', assignee: null, savedAt: 3 });
  eq('a different name appends', e5.api.loadViews().length, 2);
  e5.api.deleteView('v3');
  var names = e5.api.loadViews().map(function (v) { return v.name; });
  eq('delete removes only its own view', names, ['triage']);

  // ---- v3.0: capture stores the pref value VERBATIM ------------------------
  var e6 = makeApi(apiSrc);
  var liveValue = '{"hiddenColumnNames":["phase"],"columnWidths":[{"columnName":"scopeOfWork","width":189}],"columnOrder":["statusId"]}';
  var capDone = null, capErr = null;
  e6.api.captureCurrent('My layout', 'me', 12345).then(function (r) { capDone = r; }, function (err) { capErr = String(err && err.message); });
  await tick();
  eq('capture reads the live pref first', e6.calls.length, 1);
  e6.calls[0].resolve({ userPreference: { key: 'k', version: 'ver-1', value: liveValue } });
  await tick(); await tick();
  eq('capture performs NO write', e6.calls.length, 1);
  var savedView = e6.api.loadViews()[0];
  ok('the saved view exists', !!savedView, JSON.stringify(capErr));
  eq('the pref value is stored byte-for-byte', savedView && savedView.value, liveValue);
  eq('the chosen assignee mode rides along', savedView && savedView.assignee, { mode: 'me' });

  var e7 = makeApi(apiSrc);
  e7.api.captureCurrent('keeper', 'keep', 7);
  await tick();
  e7.calls[0].resolve({ userPreference: { key: 'k', version: 'v', value: '{}' } });
  await tick(); await tick();
  eq('keep-mode saves assignee null so filters are untouched', e7.api.loadViews()[0].assignee, null);

  // ---- v3.0: applying a saved value ---------------------------------------
  var e8 = makeApi(apiSrc);
  var applyDone = null;
  e8.api.apiApplyValue(liveValue).then(function (r) { applyDone = r; });
  await tick();
  eq('apply reads the pref for a FRESH version', e8.calls.length, 1);
  e8.calls[0].resolve({ userPreference: { key: 'k', version: 'ver-CURRENT', value: '{"hiddenColumnNames":[]}' } });
  await tick(); await tick();
  eq('then writes exactly once', e8.calls.length, 2);
  eq('the saved value is replayed byte-for-byte', e8.calls[1].vars.d.value, liveValue);
  eq('with the FRESH version, never the saved one', e8.calls[1].vars.d.version, 'ver-CURRENT');
  e8.calls[1].resolve({ putUserPreference: { success: true, message: 'ok' } });
  await tick(); await tick();
  eq('and resolves true', applyDone, true);

  // reverse map for the chooser fallback
  var titles = A.titlesFromValue({ hiddenColumnNames: ['phase', 'asset', 'workOrderCategory'] });
  ok('titlesFromValue omits hidden columns', titles.indexOf('Phase') === -1 && titles.indexOf('Asset') === -1 && titles.indexOf('Label') === -1);
  ok('and keeps the visible ones', titles.indexOf('Status') !== -1 && titles.indexOf('Priority') !== -1);
  eq('every mapped id resolves back to a title', Object.keys(A.NAME_MAP).length, Object.keys(A.TITLE_BY_ID).length);

  return out;
}

// ---- Static pins on the surrounding source (order + contracts) ----------------
function staticPins() {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }

  var iApi = S_APPLY.indexOf('apiApplyColumns');
  var iDom = S_APPLY.indexOf('await applyColumns(');
  ok('applyView tries the API before the chooser fallback', iApi !== -1 && iDom !== -1 && iApi < iDom, iApi + ' vs ' + iDom);
  var iStash = S_APPLY.indexOf('stashPending(');
  var iReload = S_APPLY.indexOf('location.reload()');
  ok('the continuation is stashed BEFORE the reload', iStash !== -1 && iReload !== -1 && iStash < iReload, iStash + ' vs ' + iReload);

  var iMenu = S_DOCK.indexOf('wrap.appendChild(menu)');
  var iPill = S_DOCK.indexOf('wrap.appendChild(pill)');
  ok('dock keeps menu-then-pill child order (palette contract)', iMenu !== -1 && iPill !== -1 && iMenu < iPill, iMenu + ' vs ' + iPill);
  ok('toolbar discovery excludes header/nav (global search box must never anchor)',
    /closest\('header,nav'\)/.test(coreFull.slice(coreFull.indexOf('function pageSearchInput'), coreFull.indexOf('function searchMountRef'))));
  ok('banner carries Views 3.1', coreFull.indexOf('Views 3.1') !== -1);
  ok('the hardcoded presets are GONE - views are the user\'s own',
    coreFull.indexOf('DEFAULT_VIEWS') === -1 && coreFull.indexOf("name: 'Triage (heat overlay)'") === -1);
  ok('the stale "column ORDER is NOT controllable" claim is gone with them',
    coreFull.indexOf('column ORDER is NOT controllable') === -1);
  ok('the dock offers a save-current-layout control',
    S_DOCK.indexOf('Save current layout as') !== -1 && /captureCurrent\(nm, who\.value/.test(S_DOCK));
  ok('delete is two-click armed, not a single stray click',
    /if \(!armed\)/.test(S_DOCK) && S_DOCK.indexOf("del.textContent = 'sure?'") !== -1);
  ok('a saved view applies its verbatim value, legacy title lists still work',
    /if \(v\.value\) await apiApplyValue\(v\.value\);/.test(S_APPLY) && /else await apiApplyColumns\(v\.columns\);/.test(S_APPLY));
  ok('the chooser fallback admits it cannot restore widths/order',
    S_APPLY.indexOf('widths/order not restored') !== -1);

  // Lifecycle shape pins. Liveness itself is proven behaviorally in runLifeCases -
  // these only keep the measured v2.0 starvation pattern (clear-and-reset churn)
  // from being pasted back in a form the vm cases might not reach.
  ok('schedule is SET-ONCE - a pending check is never reset',
    /if \(tick\) return;/.test(S_LIFE), S_LIFE.slice(0, 120));
  ok('no clearTimeout in the lifecycle - clear-and-reset is the measured starvation bug',
    S_LIFE.indexOf('clearTimeout') === -1);
  ok('ladder one-shots are WIRED to ensureDock, not just present as a literal',
    /forEach\(function \(ms\) \{\s*setTimeout\(BWN\.guard\(ensureDock, 'views:dock'\), ms\);/.test(S_LIFE));
  ok('history patches call through, reschedule, AND return the result',
    /var r = orig\.apply\(this, arguments\); schedule\(\); return r;/.test(S_LIFE));
  ok('resize reschedules - the mount predicate reads layout, which childList observers are blind to',
    /addEventListener\('resize', BWN\.guard\(schedule/.test(S_LIFE));

  // Dock re-anchor pins (v2.2 review fixes).
  ok('the health beat reports ACTUAL placement, so a stuck fallback cannot read as mounted',
    S_DOCK.indexOf("existing.parentElement === document.body ? 'views dock fallback (fixed)' : 'views dock in toolbar'") !== -1);
  ok('re-anchor defers while applying or while the menu is open',
    /if \(!needsMove \|\| applying \|\| menuOpen\)/.test(S_DOCK));
  ok('in-row ordering drift is detected via the fresh insertBefore anchor',
    /existing\.nextElementSibling !== mount\.before/.test(S_DOCK));
  ok('the palette re-resolves the dock node at execution time (re-anchors rebuild it)',
    coreFull.indexOf("var d = el('bwn-views-dock') || vd;") !== -1);
  return out;
}

// ---- Runner -------------------------------------------------------------------
function report(label, results) {
  var bad = results.filter(function (r) { return !r.ok; });
  bad.forEach(function (r) { console.error('  FAIL: ' + r.name + (r.detail ? ' [' + r.detail + ']' : '')); });
  console.log(label + ': ' + (results.length - bad.length) + '/' + results.length + (bad.length ? ' <-- RED' : ''));
  return bad.length;
}

function expectRed(label, results) {
  var bad = results.filter(function (r) { return !r.ok; });
  if (bad.length === 0) { console.error('  MUTATION NOT CAUGHT: ' + label); return 1; }
  console.log('control ' + label + ': red as required (' + bad.length + ' failing)');
  return 0;
}

(async function main() {
  var failures = 0;
  failures += report('shipped source', await runCases(S_API));
  failures += report('lifecycle behavior', runLifeCases(S_LIFE));
  failures += report('static pins', staticPins());

  // Mutation controls - each MUST turn the harness red.
  failures += expectRed('Label mapped to the phantom `label` id',
    await runCases(mutate(S_API, "'Label': 'workOrderCategory'", "'Label': 'label'")));
  failures += expectRed('version hardcoded instead of echoed from a fresh read',
    await runCases(mutate(S_API, 'writePref(up.version, valueStr)', "writePref('2026-07-31-f6c090d', valueStr)")));
  failures += expectRed('v2.x three-key rebuild restored - drops a stored column order',
    await runCases(mutate(S_API,
      'var out = {};\n      Object.keys(cur).forEach(function (k) { out[k] = cur[k]; });\n      out.hiddenColumnNames = hidden;',
      'var out = { hiddenColumnNames: hidden };')));
  failures += expectRed('capture re-derives the value instead of storing it verbatim',
    await runCases(mutate(S_API, 'value: up.value,', 'value: JSON.stringify(JSON.parse(up.value).hiddenColumnNames),')));
  failures += expectRed('addView appends duplicates instead of overwriting by name',
    await runCases(mutate(S_API, 'if (at >= 0) list[at] = v; else list.push(v);', 'list.push(v);')));
  failures += expectRed('saveViews clobbers the rest of bwn:config',
    await runCases(mutate(S_API, 'try { c = JSON.parse(localStorage.getItem(\'bwn:config\') || \'{}\') || {}; } catch (e) { c = {}; }', 'c = {};')));
  // The old inline `res.success !== true` throw is gone - bwnGqlOp owns success:false
  // rejection now (its own control is in test-bwn-ops.js). This control proves the
  // migration wired the viewManager kill switch onto the write.
  failures += expectRed('the write kill switch removed - a disabled viewManager writes anyway',
    await runCases(mutate(S_API, "feature: 'viewManager'", "feature: 'viewManagerX'")));
  failures += expectRed('stash not consumed before applying',
    await runCases(mutate(S_API, 'sessionStorage.removeItem(PENDING_KEY);   // remove BEFORE applying - no retry loops', '')));
  failures += expectRed('unmapped titles silently dropped',
    await runCases(mutate(S_API, "if (!id) throw new Error('unmapped column title: ' + t);", 'if (!id) return;')));

  // Lifecycle mutation controls - BEHAVIORAL, run through the vm, because the
  // review proved shape pins alone let the nearest-neighbor bug (deleting the
  // `tick = null` re-arm) ship green. Both target the shipped bytes via mutate(),
  // which throws loudly on marker drift.
  failures += expectRed('tick re-arm deleted - schedule fires once per page load, dead dock returns',
    runLifeCases(mutate(S_LIFE, 'tick = null; ', '')));
  failures += expectRed('clear-and-reset debounce reintroduced - the measured v2.0 starvation',
    runLifeCases(mutate(S_LIFE, 'if (tick) return;', 'clearTimeout(tick);')));

  if (failures) { console.error('\nRED: ' + failures + ' problem(s).'); process.exit(1); }
  console.log('\nGREEN: shipped source passes and every mutation control turns red.');
})().catch(function (e) { console.error('HARNESS CRASH:', e && e.stack || e); process.exit(1); });
