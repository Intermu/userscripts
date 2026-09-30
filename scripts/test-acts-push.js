// test-acts-push.js - the job-acts PRODUCER (board item #42): Core stages the live WO-page
// overlay to localStorage 'bwn:actsq' (zero-egress), the AI script drains it as a key-gated
// POST {acts:[{target,wo,over}]} to /api/wo-ingest. Slices the REAL shipped functions
// (stageActsPush from bwn-suite-core.user.js, actsDrain from bwn-suite-ai.user.js) and runs
// them in a vm with only the process boundary stubbed, per harness-stub-hides-dead-feature.
//
// What it proves:
//  - the overlay carries exactly the fields the dashboard adapter cannot supply, keyed by BOTH
//    the tracking # and the WO # (the board-item-43 join), one pending entry per key;
//  - the hasSignal gate: an empty overlay never enqueues (a workbook-only WO is already equivalent);
//  - dedup: an AI-confirmed content hash in 'bwn:actssent' suppresses a re-enqueue;
//  - Core is ZERO-EGRESS: stageActsPush touches only localStorage, never a network primitive;
//  - the drain POSTs the {acts:[{target,wo,over}]} contract the route expects, gated on the key +
//    connector, and settles (removes the entry, records the sent hash) on a 2xx-ok.
//  - mutation controls: drop the gate / drop the wo key -> a pinned assertion goes red.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-acts-push.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
var CORE = readLF(path.join(__dirname, '..', 'bwn-suite-core.user.js'));
var AI = readLF(path.join(__dirname, '..', 'bwn-suite-ai.user.js'));

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END not found');
  return text.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 60)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 60)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var SRC_STAGE = slice(CORE,
  '    function stageActsPush(state) {',
  '    // ---- Usage stats + adaptive NUDGING (Increment B) --------------------------',
  'stageActsPush');
var SRC_DRAIN = slice(AI,
  '  var actsBusy = false;',
  "  setTimeout(BWN.guard(actsDrain, 'actsDrain'), 8500);",
  'actsDrain');

// A localStorage-backed BWN.ls*, plus a POST capture. NO network primitive is exposed to the
// Core slice, so a stager that tried to POST would throw ReferenceError - that IS the zero-egress
// assertion (proven by MC: the slice runs clean with no fetch/GM in scope).
function coreCtx(over) {
  var ls = {};
  var sandbox = {
    JSON: JSON, Math: Math, String: String, Number: Number, Array: Array, Object: Object, Date: { now: function () { return 1755300000000; } },
    ingestSeq: 0,
    authoredKeyHash: function (s) { var h = 0, i; for (i = 0; i < String(s).length; i++) { h = (h * 31 + String(s).charCodeAt(i)) | 0; } return 'h' + (h >>> 0).toString(36); },
    // Recovery Playbooks: the overlay calls these file-level fns (proven by test-recovery-sla.js)
    // to precompute the SLA countdown for the engine-less case file. Stubbed here so the WIRING is
    // exercised - the overlay must carry exactly what they return.
    slaCountdown: function () { return { level: 'warn', badHrs: 120 }; },
    breachPredict: function () { return { willBreach: true, dueDays: 4 }; },
    BWN: {
      lsGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(ls, k) ? JSON.parse(ls[k]) : d; },
      lsSetJSON: function (k, v) { ls[k] = JSON.stringify(v); }
    },
    __ls: ls
  };
  Object.keys(over || {}).forEach(function (k) { sandbox[k] = over[k]; });
  vm.runInNewContext(SRC_STAGE + '\nthis.stageActsPush = stageActsPush;', sandbox, { filename: 'stage-slice.js' });
  return sandbox;
}
function q(ctx) { return ctx.BWN.lsGetJSON('bwn:actsq', []); }

var FULL_STATE = {
  hd: { tracking: '1120182', wo: 'W-344409' },
  pos: [{ vendor: 'Acme', num: 'PO1', poStatus: 'confirm', costOpen: true }],
  stall: { days: 12, vendor: 'Acme', date: '01/01/2026' },
  noShow: null, docs: { count: 0, docs: [] }, openTasks: { count: 1, first: { text: 't' } },
  gpPct: 20, nte: { amount: 5000, source: 'live' }, vendorTotal: 4000, noteCount: 3, lastClientNoteDays: 9, staleDays: 5, eta: null
};

console.log('-- stageActsPush: the overlay, keyed by tracking AND wo --');
(function () {
  var ctx = coreCtx();
  ctx.stageActsPush(FULL_STATE);
  var items = q(ctx);
  A.eq('one entry enqueued', items.length, 1);
  var e = items[0];
  A.eq('keyed by the tracking # (dashboard job id primary)', e.key, '1120182');
  A.eq('carries the tracking # as target', e.target, '1120182');
  A.eq('AND carries the WO # so the join resolves under item 43', e.wo, '344409');
  A.eq('the overlay carries the live PO rows', e.over.pos.length, 1);
  A.eq('and the detail-page-only signals', [!!e.over.stall, e.over.openTasks.count, e.over.noteCount], [true, 1, 3]);
  A.ok('the overlay only carries known fields (no state internals leaked)',
    Object.keys(e.over).every(function (k) { return ['pos', 'stall', 'noShow', 'docs', 'openTasks', 'gpPct', 'nte', 'vendorTotal', 'noteCount', 'lastClientNoteDays', 'staleDays', 'eta', 'slaCountdown', 'breachPredict'].indexOf(k) !== -1; }));
  A.eq('the overlay carries the precomputed SLA countdown (for the engine-less case file)', [e.over.slaCountdown.level, e.over.breachPredict.willBreach], ['warn', true]);
  A.eq('nothing was written outside bwn:actsq (zero-egress, localStorage only)',
    Object.keys(ctx.__ls).filter(function (k) { return k !== 'bwn:actsq'; }), []);
})();

console.log('\n-- a WO-only header still stages, keyed on the WO # --');
(function () {
  var ctx = coreCtx();
  ctx.stageActsPush(Object.assign({}, FULL_STATE, { hd: { tracking: '', wo: 'W-344409' } }));
  var e = q(ctx)[0];
  A.eq('key falls back to the WO #', e.key, '344409');
  A.eq('target is null (no tracking)', e.target, null);
  A.eq('wo carries the number', e.wo, '344409');
})();

console.log('\n-- the hasSignal gate: an empty overlay never enqueues --');
(function () {
  var ctx = coreCtx();
  ctx.stageActsPush({ hd: { tracking: '1120182', wo: 'W-344409' }, pos: [], stall: null, noShow: null, docs: null, openTasks: null, gpPct: null, nte: null, vendorTotal: null, noteCount: 0, lastClientNoteDays: null });
  A.eq('a signal-less WO does not enqueue (workbook-only is already equivalent)', q(ctx).length, 0);
  // no key at all -> also nothing
  var ctx2 = coreCtx();
  ctx2.stageActsPush(Object.assign({}, FULL_STATE, { hd: { tracking: 'abc', wo: 'xyz' } }));
  A.eq('a header with no digits key stages nothing', q(ctx2).length, 0);
})();

console.log('\n-- dedup: an AI-confirmed hash suppresses the re-enqueue --');
(function () {
  var ctx = coreCtx();
  ctx.stageActsPush(FULL_STATE);
  var h = q(ctx)[0].h;
  // Simulate the AI having confirmed this exact overlay.
  ctx.BWN.lsSetJSON('bwn:actssent', { '1120182': h });
  ctx.BWN.lsSetJSON('bwn:actsq', []);
  ctx.stageActsPush(FULL_STATE);
  A.eq('an unchanged, already-sent overlay does not re-enqueue', q(ctx).length, 0);
  // but a CHANGED overlay does
  ctx.stageActsPush(Object.assign({}, FULL_STATE, { noteCount: 99 }));
  A.eq('a changed overlay re-enqueues', q(ctx).length, 1);
})();

// The drain: slice actsDrain and run it with the process boundary stubbed.
function drainCtx(seedQueue, opts) {
  opts = opts || {};
  var ls = {}; ls['bwn:actsq'] = JSON.stringify(seedQueue || []);
  var posted = [];
  var sandbox = {
    JSON: JSON, Math: Math, String: String, Number: Number, Array: Array, Object: Object,
    connectorEnabled: function () { return opts.connector !== false; },
    ingestActor: function () { return 'tester'; },
    GM_getValue: function () { return opts.key === undefined ? 'test-key' : opts.key; },
    INGEST_URL: 'https://swa.example/api/wo-ingest', INGEST_CLIENT: 'pilot',
    connOk: function () {}, connFail: function () {},
    BWN: {
      guard: function (fn) { return fn; },
      lsGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(ls, k) ? JSON.parse(ls[k]) : d; },
      lsSetJSON: function (k, v) { ls[k] = JSON.stringify(v); }
    },
    GM_xmlhttpRequest: function (o) { posted.push(o); if (opts.onload) opts.onload(o); },
    __ls: ls, __posted: posted
  };
  vm.runInNewContext(SRC_DRAIN + '\nthis.actsDrain = actsDrain;', sandbox, { filename: 'drain-slice.js' });
  return sandbox;
}
var QENTRY = { id: 'x1', key: '1120182', target: '1120182', wo: '344409', over: { pos: [{ vendor: 'Acme' }], stall: { days: 1 } }, h: 'hAAA', ts: 1 };

console.log('\n-- actsDrain: the POST contract the route expects --');
(function () {
  var ctx = drainCtx([QENTRY]);
  ctx.actsDrain();
  A.eq('one POST issued', ctx.__posted.length, 1);
  var p = ctx.__posted[0];
  A.eq('to the wo-ingest endpoint with the client', p.url, 'https://swa.example/api/wo-ingest?client=pilot');
  A.eq('key-gated on x-bwn-key', p.headers['x-bwn-key'], 'test-key');
  var body = JSON.parse(p.data);
  A.eq('the body is { actor, acts: [...] }', [typeof body.actor, Array.isArray(body.acts)], ['string', true]);
  A.eq('each act carries target + wo + over', { target: body.acts[0].target, wo: body.acts[0].wo, pos: body.acts[0].over.pos.length }, { target: '1120182', wo: '344409', pos: 1 });
})();

console.log('\n-- actsDrain: gates + settle --');
(function () {
  var cOff = drainCtx([QENTRY], { connector: false }); cOff.actsDrain();
  A.eq('connector off -> no POST', cOff.__posted.length, 0);
  var cNoKey = drainCtx([QENTRY], { key: '' }); cNoKey.actsDrain();
  A.eq('no ingest key -> no POST', cNoKey.__posted.length, 0);
  // on a 2xx-ok: settle removes the sent entry and records the content hash for Core's dedup
  var c2 = drainCtx([QENTRY], { onload: function (o) { o.onload({ status: 200, responseText: '{"ok":true}' }); } });
  c2.actsDrain();
  A.eq('a 2xx-ok drains the queue', c2.BWN.lsGetJSON('bwn:actsq', []).length, 0);
  A.eq('and records the sent content hash for Core dedup', c2.BWN.lsGetJSON('bwn:actssent', {})['1120182'], 'hAAA');
})();

console.log('\n-- mutation controls --');
(function () {
  // MC1: drop the hasSignal gate in the stager -> an empty overlay now enqueues.
  var stageNoGate = mutate(SRC_STAGE, '        if (!hasSignal) return;', '        if (false) return;');
  var ls = {};
  var sb = { JSON: JSON, Math: Math, String: String, Number: Number, Array: Array, Object: Object, Date: { now: function () { return 1; } }, ingestSeq: 0, authoredKeyHash: function () { return 'h'; }, BWN: { lsGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(ls, k) ? JSON.parse(ls[k]) : d; }, lsSetJSON: function (k, v) { ls[k] = JSON.stringify(v); } } };
  vm.runInNewContext(stageNoGate + '\nthis.stageActsPush = stageActsPush;', sb, { filename: 'mc1.js' });
  sb.stageActsPush({ hd: { tracking: '1', wo: 'W-2' }, pos: [], stall: null, noShow: null, docs: null, openTasks: null });
  A.eq('MC1: without the gate a signal-less WO enqueues (so the gate is what suppresses it)', (ls['bwn:actsq'] ? JSON.parse(ls['bwn:actsq']).length : 0), 1);

  // MC2: drop the wo from the drain body -> the dual-key join loses its WO-# half.
  var drainNoWo = mutate(SRC_DRAIN, 'return { target: e.target || \'\', wo: e.wo || \'\', over: e.over };', 'return { target: e.target || \'\', wo: \'\', over: e.over };');
  var ls2 = {}; ls2['bwn:actsq'] = JSON.stringify([QENTRY]); var posted = [];
  var sb2 = { JSON: JSON, Math: Math, String: String, Number: Number, Array: Array, Object: Object, connectorEnabled: function () { return true; }, ingestActor: function () { return 't'; }, GM_getValue: function () { return 'k'; }, INGEST_URL: 'u', INGEST_CLIENT: 'pilot', connOk: function () {}, connFail: function () {}, BWN: { guard: function (f) { return f; }, lsGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(ls2, k) ? JSON.parse(ls2[k]) : d; }, lsSetJSON: function (k, v) { ls2[k] = JSON.stringify(v); } }, GM_xmlhttpRequest: function (o) { posted.push(o); } };
  vm.runInNewContext(drainNoWo + '\nthis.actsDrain = actsDrain;', sb2, { filename: 'mc2.js' });
  sb2.actsDrain();
  A.eq('MC2: with the mutation the WO # is dropped from the payload', JSON.parse(posted[0].data).acts[0].wo, '');
  var shipped = drainCtx([QENTRY]); shipped.actsDrain();
  A.eq('MC2: and the shipped drain sends the WO #', JSON.parse(shipped.__posted[0].data).acts[0].wo, '344409');
})();

A.finish();
