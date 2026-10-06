// test-endpoint-errors.js - a failed SWA call must never pass for "nothing found" / "queue empty".
//
// Pins the endpoint error-surfacing batch (2026-10-05) against the REAL shipped bytes:
//   Bid-Out   pipelineFetch (vendor-prospects read via swaRead) + enrichContacts (enrich-contacts POST)
//   Write Q   claimOnce + wqClaimStatus + pollTick (wo-write-queue claim)
//   Dispatch  dispatchCardFailMsg (the card leg's failure line)
// Each block is sliced between its markers and run in a vm with a programmable fake transport.
// Success criteria are unchanged (2xx + json.ok); what changed is that every failure class - 401,
// 403, other HTTP, a 2xx HTML page / ok:false, a network error - is reported as such, with a fixed
// phrase that never carries response-body, header or token text.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-endpoint-errors.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n'); }
function between(src, a, b, what) {
  var i = src.indexOf(a), j = src.indexOf(b, i);
  if (i === -1 || j === -1) throw new Error('slice markers not found: ' + what);
  return src.slice(i, j + b.length);
}
var BO = read('bwn-bid-out.user.js'), WQ = read('bwn-write-queue.user.js'), DI = read('bwn-dispatch.user.js');

// Canary strings planted in every failing fixture: none may ever reach a user-facing message.
var SECRET = 'tok-SECRET-123', BODY = 'BODYTEXT-should-not-leak';
// Fixtures: [label, transport answer]. A function answer = network rejection.
function failures() {
  return [
    ['401', { status: 401, json: { ok: false, error: BODY } }],
    ['403', { status: 403, json: { ok: false, error: BODY } }],
    ['500', { status: 500, json: { ok: false, error: BODY } }],
    ['2xx HTML page', { status: 200, json: null }],
    ['2xx ok:false', { status: 200, json: { ok: false, error: BODY } }],
    ['network rejection', 'NETWORK']
  ];
}
function transport(answer) {
  return function () { return answer === 'NETWORK' ? Promise.reject(new Error('network error ' + SECRET)) : Promise.resolve(answer); };
}
function clean(s) { return typeof s === 'string' && s.indexOf(SECRET) === -1 && s.indexOf(BODY) === -1; }
function settle(p) { return p.then(function (v) { return { v: v }; }, function (e) { return { e: e }; }); }

// ---- Bid-Out ------------------------------------------------------------------------------
var BO_READS = between(BO, '  // BO-SWA-READS-BEGIN', '  // BO-SWA-READS-END', 'Bid-Out reads');
function boCtx(answer) {
  var ctx = {
    GM_getValue: function () { return 'ingest-key'; }, authToken: function () { return SECRET; },
    gmPost: transport(answer), gmGet: transport(answer), swaRead: transport(answer),
    ENRICH_URL: 'https://swa/api/enrich-contacts', PROSPECTS_URL: 'https://swa/api/vendor-prospects',
    domainOf: function (u) { return String(u || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]; },
    normName: function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); },
    Promise: Promise, Error: Error, Object: Object, Number: Number, String: String
  };
  vm.runInNewContext(BO_READS + '\nthis.pipelineFetch = pipelineFetch; this.enrichContacts = enrichContacts; this.ziFallback = ziFallback;', ctx);
  return ctx;
}
var WO = { address: { latitude: 30.1, longitude: -97.7 } };

function boTests() {
  console.log('--- Bid-Out: pipelineFetch (vendor-prospects GET) ---');
  var populated = { status: 200, json: { ok: true, prospects: [{ name: 'Acme HVAC', miles: 4, key: 'acme', email: 'a@acme.com' }] } };
  var empty = { status: 200, json: { ok: true, prospects: [] } };
  var chain = settle(boCtx(populated).pipelineFetch(WO, 25)).then(function (r) {
    A.ok('populated success resolves the prospect list', r.v && r.v.length === 1 && r.v[0].name === 'Acme HVAC' && r.v[0].src === 'pipeline', JSON.stringify(r));
    return settle(boCtx(empty).pipelineFetch(WO, 25));
  }).then(function (r) {
    A.eq('legitimate empty success resolves [] (nothing known near here)', r.v, []);
  });
  failures().forEach(function (f) {
    chain = chain.then(function () { return settle(boCtx(f[1]).pipelineFetch(WO, 25)); }).then(function (r) {
      A.ok('pipeline ' + f[0] + ': REJECTS, never a misleading []', !!r.e && !r.v, JSON.stringify(r.v));
      A.ok('pipeline ' + f[0] + ': error is classified for the fallback note', !!(r.e && r.e.bwnPipeline));
      A.ok('pipeline ' + f[0] + ': message names the failure and the fallback', r.e && /BWN pipeline lookup failed \(/.test(r.e.message) && /searching Google instead/.test(r.e.message), r.e && r.e.message);
      A.ok('pipeline ' + f[0] + ': no token/body text leaks', r.e && clean(r.e.message), r.e && r.e.message);
    });
  });
  chain = chain.then(function () { return settle(boCtx(failures()[0][1]).pipelineFetch(WO, 25)); }).then(function (r) {
    A.ok('pipeline 401 says session verification failed', /session verification failed \(401\)/.test(r.e.message), r.e.message);
    return settle(boCtx(failures()[1][1]).pipelineFetch(WO, 25));
  }).then(function (r) {
    A.ok('pipeline 403 says access denied without claiming a rank denial', /access denied \(403\)/.test(r.e.message) && !/rank/i.test(r.e.message), r.e.message);
  });

  // The caller keeps the paid-search fallback and carries the note into the result line.
  chain = chain.then(function () {
    var caller = between(BO, "          }).catch(function (e) {\n            // Same paid-search fallback", 'runPlacesDiscovery();\n          });', 'pipeline caller catch');
    A.ok('caller: a classified pipeline failure is remembered as the note', caller.indexOf('if (e && e.bwnPipeline) openState.pipelineNote = e.message;') !== -1);
    A.ok('caller: the paid-search fallback still runs after a pipeline failure', caller.indexOf('runPlacesDiscovery();') !== -1);
    A.ok('discovery success shows the pipeline note first', BO.indexOf("if (openState.pipelineNote) { openState.netNewMsg = openState.pipelineNote + (openState.netNewMsg ? ' ' + openState.netNewMsg : ''); openState.pipelineNote = ''; }") !== -1);
    A.ok('discovery failure shows the pipeline note too', BO.indexOf("if (openState.pipelineNote) { openState.netNewMsg = openState.pipelineNote + ' ' + openState.netNewMsg; openState.pipelineNote = ''; }") !== -1);
  });

  chain = chain.then(function () { console.log('\n--- Bid-Out: enrichContacts (enrich-contacts POST) ---'); });
  var co = [{ name: 'Acme HVAC', website: 'https://acme.com' }];
  var zPop = { status: 200, json: { ok: true, results: { 'acme.com': { contacts: [{ name: 'Pat', email: 'pat@acme.com', title: 'Owner' }] } } } };
  var zEmpty = { status: 200, json: { ok: true, results: {} } };
  var zUnconf = { status: 503, json: { ok: false, code: 'ZI_UNCONFIGURED' } };
  chain = chain.then(function () { return boCtx(zPop).enrichContacts(co); }).then(function (r) {
    A.eq('populated success maps the contact', r.map['acme.com'] && r.map['acme.com'].email, 'pat@acme.com');
    A.eq('populated success carries no note', r.note, '');
    return boCtx(zEmpty).enrichContacts(co);
  }).then(function (r) {
    A.eq('legitimate empty success: empty map, no note', r, { map: {}, note: '' });
    return boCtx(zUnconf).enrichContacts(co);
  }).then(function (r) {
    A.eq('503 ZI_UNCONFIGURED keeps its exact note', r, { map: {}, note: 'ZoomInfo enrichment pending credentials (ask the ZoomInfo admin).' });
  });
  failures().forEach(function (f) {
    chain = chain.then(function () { return boCtx(f[1]).enrichContacts(co); }).then(function (r) {
      A.ok('enrich ' + f[0] + ': keeps the {map, note} shape with an empty map', r && JSON.stringify(r.map) === '{}');
      A.ok('enrich ' + f[0] + ': note is non-empty and names the failure', /^ZoomInfo lookup issue \(.+\)\.$/.test(r.note), r.note);
      A.ok('enrich ' + f[0] + ': no token/body text leaks', clean(r.note), r.note);
    });
  });
  // ziFallback de-duplicates the note across its 4-company batches.
  chain = chain.then(function () {
    var leads = []; for (var i = 0; i < 9; i++) leads.push({ name: 'Co' + i, website: '' });
    return boCtx(failures()[1][1]).ziFallback(leads);
  }).then(function (zr) {
    A.eq('a failure repeated across 3 batches is reported once', zr.note.split('ZoomInfo lookup issue').length - 1, 1);
  });

  // Controls: the shipped-before lines answered failures as "nothing found".
  chain = chain.then(function () {
    var oldPipe = BO_READS.replace("if (r.status < 200 || r.status >= 300 || !r.json || !r.json.ok) throw pipelineFail(r);", "if (r.status < 200 || r.status >= 300 || !r.json || !r.json.ok) return [];");
    A.ok('control: the old pipeline line is present to swap', oldPipe !== BO_READS);
    var ctx = boCtx(failures()[1][1]);
    vm.runInContext(oldPipe + '\nthis.pipelineFetch = pipelineFetch;', ctx);
    return settle(ctx.pipelineFetch(WO, 25));
  }).then(function (r) {
    A.eq('control: with the old line a 403 read as an empty pipeline', r.v, []);
  });
  return chain;
}

// ---- Write Queue ----------------------------------------------------------------------------
var WQ_CLAIM = between(WQ, '  // WQ-CLAIM-BEGIN', '  // WQ-CLAIM-END', 'WQ claim');
var WQ_POLL = between(WQ, '  var busy = false;\n  function pollTick() {', '\n  }\n', 'pollTick');
function fakeDoc() {
  var shown = [];
  function el(tag) {
    var e = { tag: tag, children: [], attrs: {}, style: {}, textContent: '', parentNode: null, listeners: {},
      setAttribute: function (k, v) { e.attrs[k] = v; },
      appendChild: function (c) { c.parentNode = e; e.children.push(c); return c; },
      removeChild: function (c) { var i = e.children.indexOf(c); if (i !== -1) e.children.splice(i, 1); c.parentNode = null; if (e === body) shown.push('remove'); },
      addEventListener: function (n, fn) { e.listeners[n] = fn; } };
    return e;
  }
  var body = el('body');
  var origAppend = body.appendChild;
  body.appendChild = function (c) { shown.push('show:' + c.children[0].textContent); return origAppend(c); };
  return { document: { createElement: el, body: body, hidden: false }, body: body, log: shown };
}
function wqCtx(answers) {
  var d = fakeDoc(), i = 0, posts = 0;
  var ctx = {
    document: d.document, Error: Error, Number: Number, Promise: Promise, String: String,
    PROXY_URL: 'https://swa/api/wo-write-queue', CLIENT: 'pilot', ingestKey: function () { return 'k'; },
    gmPost: function () { posts++; var a = answers[Math.min(i++, answers.length - 1)]; return a === 'NETWORK' ? Promise.reject(new Error('net ' + SECRET)) : Promise.resolve(a); },
    enabled: function () { return true; }, authToken: function () { return SECRET; },
    confirmStrip: function () { return Promise.resolve('skip'); },
    reportResult: function () { return Promise.resolve({ ok: true }); },
    executeCommand: function () { return Promise.resolve({ outcome: 'done' }); }, classifyError: function () { return false; }
  };
  vm.runInNewContext(WQ_CLAIM + '\n' + WQ_POLL + '\nthis.claimOnce = claimOnce; this.pollTick = pollTick; this.wqClaimStatus = wqClaimStatus; this.isBusy = function () { return busy; };', ctx);
  ctx.__doc = d; ctx.__posts = function () { return posts; };
  return ctx;
}
function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }
function tick(ctx) { ctx.pollTick(); return flush().then(flush).then(flush); }

function wqTests() {
  console.log('\n--- Write Queue: claimOnce + the unavailable strip ---');
  var emptyClaim = { status: 200, json: { ok: true, command: null } };
  var cmdClaim = { status: 200, json: { ok: true, command: { id: 'c1', verb: 'wo.note' } } };
  var chain = settle(wqCtx([emptyClaim]).claimOnce('t')).then(function (r) {
    A.eq('valid empty claim resolves null', r.v, null);
    return settle(wqCtx([cmdClaim]).claimOnce('t'));
  }).then(function (r) {
    A.eq('valid claimed command resolves the command', r.v, { id: 'c1', verb: 'wo.note' });
  });
  var EXPECT = {
    '401': 'Write Queue is unavailable: session verification failed. Reload the tab and try again.',
    '403': 'Write Queue is unavailable: access denied. Check your access, then try again.',
    '500': 'Write Queue is unavailable: request failed (HTTP 500).',
    '2xx HTML page': 'Write Queue is unavailable: invalid response.',
    '2xx ok:false': 'Write Queue is unavailable: invalid response.',
    'network rejection': 'Write Queue is unavailable: network error.'
  };
  failures().forEach(function (f) {
    chain = chain.then(function () { return settle(wqCtx([f[1]]).claimOnce('t')); }).then(function (r) {
      A.ok('claim ' + f[0] + ': REJECTS - never the empty-queue null', !!r.e && r.v === undefined);
      A.eq('claim ' + f[0] + ': exact message', r.e && r.e.message, EXPECT[f[0]]);
      A.ok('claim ' + f[0] + ': classified, no token/body text', !!(r.e && r.e.wqClass) && clean(r.e.message));
    });
  });

  // pollTick drives the strip: show once per class, update on a class change, clear on recovery.
  var c;
  chain = chain.then(function () {
    var r403 = failures()[1][1], r500 = failures()[2][1];
    c = wqCtx([r403, r403, r403, r500, emptyClaim, r403]);
    return tick(c);
  }).then(function () {
    A.eq('first 403 shows the strip', c.__doc.log, ['show:' + EXPECT['403']]);
    return tick(c).then(function () { return tick(c); });
  }).then(function () {
    A.eq('the same failure class does not re-show on later ticks', c.__doc.log.length, 1);
    A.eq('one strip on the page', c.__doc.body.children.length, 1);
    return tick(c);
  }).then(function () {
    A.eq('a changed class (500) replaces the strip', c.__doc.log.slice(1), ['remove', 'show:' + EXPECT['500']]);
    return tick(c);
  }).then(function () {
    A.eq('a valid empty claim clears the strip', c.__doc.body.children.length, 0);
    A.eq('...and the poller is free for the next tick', c.isBusy(), false);
    return tick(c);
  }).then(function () {
    A.eq('a failure after recovery shows again', c.__doc.body.children.length, 1);
    A.eq('one claim POST per tick (no added retries)', c.__posts(), 6);
  });
  chain = chain.then(function () {
    var c2 = wqCtx([failures()[0][1], cmdClaim]);
    return tick(c2).then(function () { return tick(c2); }).then(function () {
      A.eq('a claimed command also clears the strip', c2.__doc.body.children.length, 0);
    });
  });
  chain = chain.then(function () {
    A.ok('poll cadence unchanged: POLL_MS is 20000', WQ.indexOf('  var POLL_MS = 20000;') !== -1);
    A.ok('poll cadence unchanged: one setInterval(pollTick, POLL_MS)', WQ.split('setInterval(pollTick, POLL_MS)').length === 2);
    // Control: the shipped-before claim answered every failure with the empty-queue null.
    var old = WQ_CLAIM.replace('        if (r && r.status >= 200 && r.status < 300 && r.json && r.json.ok) return r.json.command || null;\n        throw wqClaimErr(r);',
      '        return (r.json && r.json.ok) ? (r.json.command || null) : null;');
    A.ok('control: the claim body is present to swap', old !== WQ_CLAIM);
    var ctx = wqCtx([failures()[1][1]]);
    vm.runInContext(old + '\nthis.claimOnce = claimOnce;', ctx);
    return settle(ctx.claimOnce('t'));
  }).then(function (r) {
    A.eq('control: with the old claim a 403 read as an empty queue', r.v, null);
  });
  return chain;
}

// ---- Dispatch -------------------------------------------------------------------------------
function diTests() {
  console.log('\n--- Dispatch: dispatchCardFailMsg ---');
  var ctx = {};
  vm.runInNewContext(between(DI, '  // DISPATCH-CARD-FAIL-BEGIN', '  // DISPATCH-CARD-FAIL-END', 'dispatch msg') + '\nthis.m = dispatchCardFailMsg;', ctx);
  var m = ctx.m;
  A.eq('401 -> session/reload line', m(401, { ok: false }), 'Umbrava could not verify your session. Reload the tab and try again.');
  A.eq('2xx with no JSON -> page-not-result line', m(200, null), 'The dispatch route returned a page instead of a result.');
  A.eq('400 with server error (unchanged)', m(400, { error: 'AssignedToName required' }), 'Card rejected (400): AssignedToName required.');
  A.eq('400 without error (unchanged)', m(400, null), 'Card rejected (400) - check the fields.');
  A.eq('403 (unchanged)', m(403, {}), 'Card rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.');
  A.eq('429 (unchanged)', m(429, {}), 'Too many dispatches in a row - wait a moment and try the card again.');
  A.eq('503 (unchanged)', m(503, {}), 'Dispatch is not fully configured on the server yet (503) - tell Mike the DISPATCH_FLOW_URL app setting is missing.');
  A.eq('generic non-OK (unchanged)', m(500, { error: 'boom' }), 'Card failed (500): boom.');
  A.eq('2xx JSON with ok:false keeps the generic line', m(200, { ok: false }), 'Card failed (200).');
  var call = DI.indexOf('msg.textContent = dispatchCardFailMsg(r.status, r.json) + tail;');
  A.ok('the card leg uses the helper and still appends the tail', call !== -1);
  A.ok('the "WO already updated" tail text is unchanged', DI.indexOf("var tail = (hasWrites ? '  NOTE: the WO record WAS already updated - re-send the card only, do not re-run the writes.' : '') + taskNote;") !== -1);
  A.ok('success still requires 2xx + json.ok before the helper is reached', DI.indexOf('if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {') !== -1 && DI.indexOf('if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {') < call);
}

boTests().then(wqTests).then(function () { diTests(); A.finish(); }, function (err) {
  console.log('HARNESS ERROR: ' + (err && err.stack || err));
  process.exit(1);
});
