// test-assist-roundtrip.js - node harness for queue-spec step 3's client half: the
// escalation state round-trip onto the WO checklist.
//
// WHAT SHIPPED, as sliced from source:
//   bwn-wo-assist 0.2.0 owns the READ side (Core is @grant none and cannot ask the
//   server): queryState() POSTs op:'status' for the current WO and publishes the answer
//   two ways - sessionStorage bwn:assist:state:<woId> and a bwn:assist:state bus event.
//   Core 1.66.18 (WO Assist 2.66) CONSUMES: waEscState() returns the current WO's ACTIVE
//   (open|ack) record with a staleness gate, waEscStripText() words the strip
//   ("Escalated - awaiting mgmt" is the queue-spec literal), waEscToolLabel() relabels
//   the checklist's assist button to "View escalation…" while an item is active.
//   verbPost() drives ack/resolve and treats applied:false as a sync, not an error.
//
// Drives the REAL shipped bytes: slices the Phase-2 block out of bwn-suite-core.user.js
// and the state block out of bwn-wo-assist.user.js, runs both against stub buses.
// Nothing here proves the checklist RENDERS the strip or that the server flips records -
// the route side is scripts/test-wo-assist.js in broadway-internal-ops (28/28) and the
// browser side is the step 3 live-test items in wiki/wo-assist-queue-spec.md.
//
// Every mutation below reverts one piece in the sliced source and asserts THIS harness
// goes red. mutate() throws if its target string is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-roundtrip.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var ASSIST_SRC = path.join(__dirname, '..', 'bwn-wo-assist.user.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}

var coreFull = readLF(CORE_SRC);
var assistFull = readLF(ASSIST_SRC);
// Same region test-assist-due slices - ACT_TOOL_LABEL and the dock liveness live in it,
// and the round-trip block was added inside it on purpose so one slice serves both.
var CORE_SECTION = slice(coreFull,
  '    // PINNED against the live registrant table',
  '    // IN-PAGE NAVIGATION.',
  'core ACT_TOOL/round-trip block');
var ASSIST_SECTION = slice(assistFull,
  '  // ---- Assist state round-trip (queue-spec step 3)',
  '  // ---- Drawer ',
  'assist state block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function makeBusDoc() {
  var listeners = {};
  var log = [];
  return {
    log: log,
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: function (t, fn) {
      var arr = listeners[t] || [];
      var i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    dispatchEvent: function (ev) {
      log.push({ type: ev.type, detail: ev.detail });
      (listeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); });
      return true;
    }
  };
}
function CustomEventStub(type, init) { this.type = type; this.detail = init && init.detail; }
function busEmit(doc, detail) { doc.dispatchEvent(new CustomEventStub('bwn:evt', { detail: detail })); }
function tick() { return new Promise(function (r) { setImmediate(r); }); }

var OPEN_REC = {
  id: 'r-open-1', kind: 'mgmt-assist', woNumber: '381367', requester: 'mnajarro@broadwaynational.com',
  tier: 'management', recipient: 'mgmt@example.com', reason: 'SLA breach', ask: 'Need a call.',
  status: 'open', openedAt: '2026-08-01T15:00:00.000Z', dueAt: '2026-08-02T15:00:00.000Z', ackAt: '', assignee: ''
};

// ---- core side: waEscState / waEscStripText / waEscToolLabel ---------------------------
function coreCtx(src) {
  var doc = makeBusDoc();
  var ss = {};
  var ctx = {
    document: doc, CustomEvent: CustomEventStub, Date: Date, console: console,
    location: { pathname: '/work-orders/381367' },
    BWN: { ssGetJSON: function (k, def) { return Object.prototype.hasOwnProperty.call(ss, k) ? ss[k] : def; } },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx: ctx, doc: doc, ss: ss };
}

function probeCore(src) {
  var r = {};
  var c = coreCtx(src);

  r.nullWithNoState = c.ctx.waEscState() === null;
  busEmit(c.doc, { id: 'bwn:assist:state', wo: '381367', found: true, record: OPEN_REC });
  var got = c.ctx.waEscState();
  r.openViaEvent = !!got && got.id === 'r-open-1';
  busEmit(c.doc, { id: 'bwn:assist:state', wo: '381367', found: true, record: Object.assign({}, OPEN_REC, { status: 'ack', assignee: 'gkeller@broadwaynational.com', ackAt: '2026-08-02T16:00:00.000Z' }) });
  got = c.ctx.waEscState();
  r.ackCounts = !!got && got.status === 'ack';
  busEmit(c.doc, { id: 'bwn:assist:state', wo: '381367', found: true, record: Object.assign({}, OPEN_REC, { status: 'resolved' }) });
  r.resolvedInvisible = c.ctx.waEscState() === null;
  busEmit(c.doc, { id: 'bwn:assist:state', wo: '381367', found: false, record: null });
  r.foundFalseClears = c.ctx.waEscState() === null;

  // Off-WO paths and other WOs never leak state.
  busEmit(c.doc, { id: 'bwn:assist:state', wo: '381367', found: true, record: OPEN_REC });
  c.ctx.location.pathname = '/work-orders/999999';
  r.otherWoNull = c.ctx.waEscState() === null;
  c.ctx.location.pathname = '/dashboard';
  r.nonWoPathNull = c.ctx.waEscState() === null;
  c.ctx.location.pathname = '/work-orders/381367';

  // sessionStorage fallback (a reload before any event) + its guards.
  var c2 = coreCtx(src);
  c2.ss['bwn:assist:state:381367'] = { v: 1, ts: Date.now(), found: true, record: OPEN_REC };
  var g2 = c2.ctx.waEscState();
  r.ssFallback = !!g2 && g2.id === 'r-open-1';
  var c3 = coreCtx(src);
  c3.ss['bwn:assist:state:381367'] = { v: 2, ts: Date.now(), found: true, record: OPEN_REC };
  r.ssWrongVersionNull = c3.ctx.waEscState() === null;
  var c4 = coreCtx(src);
  c4.ss['bwn:assist:state:381367'] = { v: 1, ts: Date.now() - 31 * 60000, found: true, record: OPEN_REC };
  r.staleAgesOut = c4.ctx.waEscState() === null;

  // Strip wording - the queue-spec literal for open, honest variants for ack/own-call.
  var t = c.ctx.waEscStripText(OPEN_REC);
  r.stripOpenLiteral = t.indexOf('Escalated - awaiting mgmt') === 0;
  r.stripOpenNames = t.indexOf('by mnajarro') !== -1 && t.indexOf('opened 8/1') !== -1 && t.indexOf('due 8/2') !== -1;
  t = c.ctx.waEscStripText(Object.assign({}, OPEN_REC, { status: 'ack', assignee: 'gkeller@broadwaynational.com', ackAt: '2026-08-02T16:00:00.000Z' }));
  r.stripAck = t.indexOf('mgmt has it') !== -1 && t.indexOf('acknowledged by gkeller 8/2') !== -1 && t.indexOf('due') === -1;
  t = c.ctx.waEscStripText(Object.assign({}, OPEN_REC, { tier: 'own-call' }));
  r.stripOwnCall = t.indexOf('own call') !== -1 && t.indexOf('awaiting mgmt') === -1;

  // Tool label relabels ONLY the assist button, and only while state is active.
  r.labelActive = c.ctx.waEscToolLabel('assist', OPEN_REC) === 'View escalation…';
  r.labelIdle = c.ctx.waEscToolLabel('assist', null) === 'Escalate…';
  r.labelOtherTool = c.ctx.waEscToolLabel('dispatch', OPEN_REC) === 'Dispatch…';
  return r;
}

// ---- assist side: publishState / queryState / verbPost ---------------------------------
function assistCtx(src) {
  var doc = makeBusDoc();
  var ssMap = {};
  var posts = [];
  var holder = { key: 'k1', tok: 'tok1', resp: { status: 200, json: { ok: true, found: false } }, toasts: [], closed: 0 };
  var ctx = {
    document: doc, CustomEvent: CustomEventStub, Date: Date, console: console, JSON: JSON,
    sessionStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(ssMap, k) ? ssMap[k] : null; },
      setItem: function (k, v) { ssMap[k] = String(v); },
    },
    GM_getValue: function (name, def) { return holder.key === null ? def : holder.key; },
    authToken: function () { return holder.tok; },
    gmPost: function (url, headers, body) { posts.push({ url: url, headers: headers, body: body }); return Promise.resolve(holder.resp); },
    PROXY_URL: 'https://swa.example/api/wo-assist',
    toast: function (m) { holder.toasts.push(m); },
    closeModal: function () { holder.closed++; },
    woIdFromUrl: function () { return '381367'; },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx: ctx, doc: doc, ss: ssMap, posts: posts, holder: holder };
}
function stateEvents(doc, wo) {
  return doc.log.filter(function (e) { return e.type === 'bwn:evt' && e.detail && e.detail.id === 'bwn:assist:state' && (!wo || e.detail.wo === wo); });
}

async function probeAssist(src) {
  var r = {};

  // Gates: no key / no token = no chatter at all.
  var a = assistCtx(src);
  a.holder.key = null;
  a.ctx.queryState('381367');
  await tick();
  r.noKeyNoPost = a.posts.length === 0;
  a.holder.key = 'k1'; a.holder.tok = '';
  a.ctx.queryState('381367');
  await tick();
  r.noTokenNoPost = a.posts.length === 0;

  // The status POST carries exactly the contract fields; the answer publishes both ways.
  a = assistCtx(src);
  a.holder.resp = { status: 200, json: { ok: true, found: true, record: OPEN_REC } };
  a.ctx.queryState('381367');
  await tick(); await tick();
  r.postShape = a.posts.length === 1
    && a.posts[0].body.op === 'status' && a.posts[0].body.woNumber === '381367'
    && a.posts[0].body.userToken === 'tok1' && a.posts[0].headers['x-bwn-key'] === 'k1';
  var ssRec = null;
  try { ssRec = JSON.parse(a.ss['bwn:assist:state:381367']); } catch (e) { }
  r.publishesSession = !!ssRec && ssRec.v === 1 && ssRec.found === true && ssRec.record && ssRec.record.id === 'r-open-1' && typeof ssRec.ts === 'number';
  var evs = stateEvents(a.doc, '381367');
  r.publishesBus = evs.length === 1 && evs[0].detail.found === true && evs[0].detail.record.id === 'r-open-1';

  // TTL cache: same WO inside the window is quiet; force and a different WO re-query.
  a.ctx.queryState('381367');
  await tick();
  r.ttlQuiet = a.posts.length === 1;
  a.ctx.queryState('381367', true);
  await tick();
  r.forceBypasses = a.posts.length === 2;
  a.ctx.queryState('999999');
  await tick();
  r.navBypasses = a.posts.length === 3;

  // A pre-step-3 route 400s the op (no ok in the body): publish NOTHING.
  a = assistCtx(src);
  a.holder.resp = { status: 400, json: { error: 'reason must be one of: SLA breach' } };
  a.ctx.queryState('381367');
  await tick(); await tick();
  r.oldRouteSilent = stateEvents(a.doc).length === 0 && !('bwn:assist:state:381367' in a.ss);

  // found:false is published too - it is what CLEARS a stale strip.
  a = assistCtx(src);
  a.holder.resp = { status: 200, json: { ok: true, found: false } };
  a.ctx.queryState('381367');
  await tick(); await tick();
  evs = stateEvents(a.doc, '381367');
  r.foundFalsePublished = evs.length === 1 && evs[0].detail.found === false;

  // verbPost: ack applied -> publish the ack'd record; resolve -> publish clear + close.
  a = assistCtx(src);
  var ackRec = Object.assign({}, OPEN_REC, { status: 'ack', assignee: 'gkeller@broadwaynational.com', ackAt: '2026-08-02T16:00:00.000Z' });
  a.holder.resp = { status: 200, json: { ok: true, applied: true, record: ackRec } };
  var msg = { textContent: '' };
  a.ctx.verbPost('ack', OPEN_REC, msg, []);
  await tick(); await tick();
  r.ackPosts = a.posts.length === 1 && a.posts[0].body.op === 'ack' && a.posts[0].body.id === 'r-open-1';
  evs = stateEvents(a.doc, '381367');
  r.ackPublishesAck = evs.length === 1 && evs[0].detail.found === true && evs[0].detail.record.status === 'ack';

  a = assistCtx(src);
  a.holder.resp = { status: 200, json: { ok: true, applied: true, record: Object.assign({}, OPEN_REC, { status: 'resolved' }) } };
  a.ctx.verbPost('resolve', OPEN_REC, { textContent: '' }, []);
  await tick(); await tick();
  evs = stateEvents(a.doc, '381367');
  r.resolvePublishesClear = evs.length === 1 && evs[0].detail.found === false && evs[0].detail.record === null;
  r.resolveCloses = a.holder.closed === 1;

  // applied:false = a sync: publish the server's record, no error message.
  a = assistCtx(src);
  a.holder.resp = { status: 200, json: { ok: true, applied: false, record: ackRec } };
  msg = { textContent: '' };
  a.ctx.verbPost('ack', OPEN_REC, msg, []);
  await tick(); await tick();
  r.noopSyncs = stateEvents(a.doc, '381367').length === 1 && msg.textContent === '';

  // 404 clears; the old-route 400 fingerprint gets its own message.
  a = assistCtx(src);
  a.holder.resp = { status: 404, json: { error: 'no such item' } };
  a.ctx.verbPost('resolve', OPEN_REC, { textContent: '' }, []);
  await tick(); await tick();
  evs = stateEvents(a.doc, '381367');
  r.missing404Clears = evs.length === 1 && evs[0].detail.found === false;
  a = assistCtx(src);
  a.holder.resp = { status: 400, json: { error: 'missing required field: woNumber' } };
  msg = { textContent: '' };
  a.ctx.verbPost('ack', OPEN_REC, msg, []);
  await tick(); await tick();
  r.oldRouteVerbNamed = msg.textContent.indexOf('route update not deployed') !== -1 && stateEvents(a.doc).length === 0;
  return r;
}

// ---- run: real source -------------------------------------------------------------------
(async function main() {
  console.log('assist state round-trip - real source, core side');
  var p = probeCore(CORE_SECTION);
  A.ok('no published state -> no strip record', p.nullWithNoState, JSON.stringify(p));
  A.ok('an open record published on the bus surfaces', p.openViaEvent, JSON.stringify(p));
  A.ok('an ack record still counts as active', p.ackCounts, JSON.stringify(p));
  A.ok('a resolved record is invisible (the strip clears)', p.resolvedInvisible, JSON.stringify(p));
  A.ok('found:false clears the latch', p.foundFalseClears, JSON.stringify(p));
  A.ok('state never leaks onto another WO', p.otherWoNull, JSON.stringify(p));
  A.ok('state never renders off a WO page', p.nonWoPathNull, JSON.stringify(p));
  A.ok('sessionStorage fallback works after a reload', p.ssFallback, JSON.stringify(p));
  A.ok('a version-drifted sessionStorage record is ignored', p.ssWrongVersionNull, JSON.stringify(p));
  A.ok('stale published state ages out (never lies forever)', p.staleAgesOut, JSON.stringify(p));
  A.ok('strip opens with the queue-spec literal "Escalated - awaiting mgmt"', p.stripOpenLiteral, JSON.stringify(p));
  A.ok('strip names requester, opened and due', p.stripOpenNames, JSON.stringify(p));
  A.ok('ack strip says mgmt has it, names the acker, drops the due', p.stripAck, JSON.stringify(p));
  A.ok('own-call strip never claims "awaiting mgmt"', p.stripOwnCall, JSON.stringify(p));
  A.ok('assist button relabels to "View escalation…" while active', p.labelActive, JSON.stringify(p));
  A.ok('assist button stays "Escalate…" with no active item', p.labelIdle, JSON.stringify(p));
  A.ok('other tool buttons are never relabelled', p.labelOtherTool, JSON.stringify(p));

  console.log('\nassist state round-trip - real source, assist side');
  var q = await probeAssist(ASSIST_SECTION);
  A.ok('no ingest key -> no status chatter', q.noKeyNoPost, JSON.stringify(q));
  A.ok('no usable token -> no status chatter', q.noTokenNoPost, JSON.stringify(q));
  A.ok('status POST carries op/woNumber/token/key exactly', q.postShape, JSON.stringify(q));
  A.ok('answer publishes to sessionStorage (v:1, ts, found, record)', q.publishesSession, JSON.stringify(q));
  A.ok('answer publishes the bwn:assist:state bus event', q.publishesBus, JSON.stringify(q));
  A.ok('TTL cache: same WO inside 5min is quiet', q.ttlQuiet, JSON.stringify(q));
  A.ok('force bypasses the cache', q.forceBypasses, JSON.stringify(q));
  A.ok('a different WO bypasses the cache', q.navBypasses, JSON.stringify(q));
  A.ok('a pre-step-3 route (400, no ok) publishes NOTHING', q.oldRouteSilent, JSON.stringify(q));
  A.ok('found:false is published - it clears a stale strip', q.foundFalsePublished, JSON.stringify(q));
  A.ok('verbPost ack POSTs op+id', q.ackPosts, JSON.stringify(q));
  A.ok('applied ack publishes the ack record', q.ackPublishesAck, JSON.stringify(q));
  A.ok('applied resolve publishes a clear', q.resolvePublishesClear, JSON.stringify(q));
  A.ok('applied resolve closes the drawer', q.resolveCloses, JSON.stringify(q));
  A.ok('applied:false is a quiet sync, not an error', q.noopSyncs, JSON.stringify(q));
  A.ok('404 clears the published state', q.missing404Clears, JSON.stringify(q));
  A.ok('the old-route 400 fingerprint names the real problem', q.oldRouteVerbNamed, JSON.stringify(q));

  // Structural: the render layer consumes what this harness proved, versions are bumped
  // in lockstep, and the ping tick actually queries.
  console.log('\nstructural');
  A.ok('checklist style ships .bwn-act-esc', coreFull.indexOf('.bwn-act-esc{') !== -1, 'style rule missing');
  A.ok('render builds the strip from waEscStripText(escSt)', coreFull.indexOf('waEscStripText(escSt)') !== -1, 'call site missing');
  A.ok('tool label rides waEscToolLabel(dk, escSt)', coreFull.indexOf('waEscToolLabel(dk, escSt)') !== -1, 'call site missing');
  A.ok('escalation state is part of the render signature', coreFull.indexOf("escSt.status + '|' + escSt.id") !== -1, 'signature term missing');
  // Bumped to 1.66.37: the List Heat board->dashboard dataset push now also carries Last Note Date
  // (paired with the route's DATE_MAP entry). 1.66.36 added the push; 1.66.35 added the closure
  // auto-advance step. The pin is deliberate: it forces a conscious
  // update whenever Core moves, so a version bump cannot ride out unnoticed alongside an
  // unrelated change. The step-3 contract itself is untouched.
  // The assist @version and its internal `var VER` banner (shown in support triage) MUST agree.
  // VER had drifted to 0.3.0 while @version read 0.3.3; the 2026-08-18 surgical-fix pass set them
  // in lockstep at 0.3.4, and these pins keep them from drifting apart again.
  A.ok('core @version is 1.78.39', coreFull.indexOf('// @version      1.78.39') !== -1, 'core version drift');
  A.ok('core banner says WO Assist 2.71', coreFull.indexOf('WO Assist 2.71') !== -1, 'module banner drift');
  A.ok('assist @version is 0.3.5', assistFull.indexOf('// @version      0.3.5') !== -1, 'assist version drift');
  A.ok("assist VER is '0.3.5'", assistFull.indexOf("var VER = '0.3.5';") !== -1, 'assist VER drift');
  // Step 4 hangs the client-response state read off the SAME tick, deliberately: two queues on
  // one refresh cadence is one thing to reason about, and a second timer would be a second
  // thing to drift. Both calls are pinned so dropping either is a red test, not a quiet loss.
  A.ok('the dock ping tick re-queries state', assistFull.indexOf("{ dockRegister(); queryState(woIdFromUrl()); queryCrState(woIdFromUrl()); }") !== -1, 'ping tick missing');
  A.ok('a fresh submit publishes synthesized state', assistFull.indexOf('publishState(woId, true, {') !== -1, 'submit publish missing');

  // ---- mutations: revert one piece each, assert the harness goes red --------------------
  console.log('\nmutations (each must redden its probe)');

  // M1: the open|ack guard dropped - a resolved record keeps the strip lit forever.
  var m1 = probeCore(mutate(CORE_SECTION,
    "      return (st === 'open' || st === 'ack') ? s.record : null;",
    '      return s.record || null;'));
  A.ok('M1 dropping the open|ack guard breaks the resolved-invisible probe', m1.resolvedInvisible === false, JSON.stringify(m1));

  // M2: the staleness gate dropped - dead published state lies forever.
  var m2 = probeCore(mutate(CORE_SECTION,
    '      if (!s.ts || (Date.now() - s.ts) > WA_ESC_TTL_MS) return null;',
    '      '));
  A.ok('M2 dropping the staleness gate breaks the ages-out probe', m2.staleAgesOut === false, JSON.stringify(m2));

  // M3: the TTL cache dropped - every ping tick hits the route.
  var m3 = await probeAssist(mutate(ASSIST_SECTION,
    '    if (!force && _lastQ.wo === woId && (Date.now() - _lastQ.ts) < QUERY_TTL_MS) return;',
    '    '));
  A.ok('M3 dropping the TTL cache breaks the quiet-repeat probe', m3.ttlQuiet === false, JSON.stringify(m3));

  // M4: the ok gate dropped - a pre-step-3 route's 400 would publish garbage state.
  var m4 = await probeAssist(mutate(ASSIST_SECTION,
    '        if (r.json && r.json.ok) publishState(woId, !!r.json.found, r.json.record || null);',
    '        publishState(woId, !!(r.json && r.json.found), (r.json && r.json.record) || null);'));
  A.ok('M4 dropping the ok gate breaks the old-route-silent probe', m4.oldRouteSilent === false, JSON.stringify(m4));

  console.log('\n(state/wording/labels/publish x real source, 4 mutations. Nothing here proves the');
  console.log(' checklist renders the strip - the step 3 live-test items in the queue spec cover that.)');
  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
