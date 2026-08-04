// test-assist-client-response.js - the client half of wo-assist queue-spec build step 4.
//
// TWO SCRIPTS, ONE HANDSHAKE. bwn-drop-upload is @grant none - it has no egress at all - so
// when a coordinator ticks "this client email needs a response" it EMITS bwn:assist:track and
// bwn-wo-assist does the POST, answering with bwn:assist:tracked. This harness runs the REAL
// functions sliced out of both files against a stub bus, a stub GM_xmlhttpRequest and a stub
// DOM, so what is under test is the shipped artifact rather than a retyped copy of it.
//
// The properties worth pinning, in order of what they cost when broken:
//   1. The ack leg. A track that fails silently leaves a coordinator believing the WO is
//      tracked when nothing recorded it - the whole reason the contract is two-way.
//   2. The Internal re-type. A tracked inbound email logged as a CLIENT note would reset the
//      client-cadence clock ("we updated the client" - we did not) and, worse, satisfy the
//      item's own convergence test the instant it opened.
//   3. Convergence firing once, on a client note that is genuinely NEWER than the item.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-client-response.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var ASSIST = path.join(__dirname, '..', 'bwn-wo-assist.user.js');
var DROP = path.join(__dirname, '..', 'bwn-drop-upload.user.js');

function slice(file, startMark, endMark) {
  var t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf(startMark), b = t.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error('marker not found in ' + path.basename(file) + ': ' + (a === -1 ? startMark : endMark));
  return t.slice(a, b);
}
function mutate(text, from, to) {
  if (text.indexOf(from) === -1) throw new Error('MUTATION DID NOT APPLY (source moved?): ' + from);
  return text.replace(from, to);
}

// ---- a bus, a network, a clock ----------------------------------------------------------
function makeWorld(opts) {
  opts = opts || {};
  var w = {
    events: [],            // every CustomEvent detail dispatched
    listeners: [],
    posts: [],             // every GM_xmlhttpRequest
    timers: [],
    session: {},
    toasts: [],
    now: Date.parse('2026-08-04T12:00:00.000Z'),
  };
  w.document = {
    addEventListener: function (name, fn) { if (name === 'bwn:evt') w.listeners.push(fn); },
    dispatchEvent: function (ev) {
      w.events.push(ev.detail);
      w.listeners.slice().forEach(function (fn) { try { fn({ detail: ev.detail }); } catch (e) { w.thrown = e; } });
      return true;
    },
    createElement: function () { return { style: {}, appendChild: function () { }, remove: function () { }, addEventListener: function () { }, setAttribute: function () { } }; },
    body: { appendChild: function () { } },
    querySelector: function () { return null; },
  };
  w.CustomEvent = function (name, init) { this.type = name; this.detail = (init || {}).detail; };
  w.sessionStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(w.session, k) ? w.session[k] : null; },
    setItem: function (k, v) { w.session[k] = String(v); },
  };
  w.location = { pathname: '/work-orders/' + (opts.wo || '383500'), href: 'https://app.umbrava.com/work-orders/' + (opts.wo || '383500') };
  // GM_xmlhttpRequest: record the call, answer from a scripted queue keyed by the body's op/kind.
  w.replies = opts.replies || [];
  w.GM_xmlhttpRequest = function (cfg) {
    var body = JSON.parse(cfg.data);
    w.posts.push(body);
    var reply = w.replies.shift();
    if (!reply) { setTimeout(function () { cfg.onerror && cfg.onerror(); }, 0); return; }
    if (reply.networkError) { setTimeout(function () { cfg.onerror && cfg.onerror(); }, 0); return; }
    setTimeout(function () {
      cfg.onload({ status: reply.status || 200, responseText: reply.text !== undefined ? reply.text : JSON.stringify(reply.json || {}) });
    }, 0);
  };
  w.GM_getValue = function (k, d) { return (opts.gm && Object.prototype.hasOwnProperty.call(opts.gm, k)) ? opts.gm[k] : d; };
  w.setTimeout = function (fn, ms) { var t = { fn: fn, ms: ms, cancelled: false }; w.timers.push(t); return t; };
  w.clearTimeout = function (t) { if (t) t.cancelled = true; };
  w.fireTimers = function () { var due = w.timers.slice(); w.timers = []; due.forEach(function (t) { if (!t.cancelled) t.fn(); }); };
  return w;
}
// Drain the microtask/macrotask queue the stubs schedule with real setTimeout(0).
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

// ---- the assist script's step-4 block ----------------------------------------------------
function loadAssist(world, srcOverride) {
  var src = srcOverride || fs.readFileSync(ASSIST, 'utf8').replace(/\r\n/g, '\n');
  var block = (function (t) {
    var a = t.indexOf('  // ---- Client-response tracking (queue-spec step 4)');
    var b = t.indexOf('  // ---- Drawer ---------');
    if (a === -1 || b === -1) throw new Error('assist step-4 markers not found');
    return t.slice(a, b);
  })(src);
  // The block leans on a handful of the script's own helpers. They are sliced too rather than
  // re-implemented, except the ones that are pure environment (toast, authToken).
  var helpers = slice(ASSIST, '  function busGet(', '  // ---- Toast ---') +
    slice(ASSIST, '  function gmPost(', '  // ---- Suite bus ---');
  // The REAL bus listener, not a re-registration written here. Forgetting to route
  // bwn:assist:track to trackClientResponse would leave every unit below green while the
  // feature does nothing at all, so the wiring is part of what is under test.
  var wiring = (function (t) {
    var a = t.indexOf('  var DOCK_KEY = ');
    var b = t.indexOf('  // ---- Shared launcher dock');
    if (a === -1 || b === -1) throw new Error('assist bus-listener markers not found');
    return t.slice(a, b);
  })(src);
  var prelude = [
    'var PROXY_URL = "https://swa.example/api/wo-assist";',
    'var QUERY_TTL_MS = 5 * 60000;',
    'function woIdFromUrl(){ var m = String(location.pathname||"").match(/\\/work-orders\\/(\\d+)/); return m ? m[1] : ""; }',
    'function authToken(){ return __token; }',
    'function toast(m){ __toasts.push(m); }',
    'function shortWhen(x){ return String(x||""); }',
    'function publishState(wo, found, rec){ __statePublishes.push({wo:wo, found:found, rec:rec}); }',
    // Everything the bus listener touches that is not part of step 4.
    'function dockRegister(){}',
    'function queryState(){}',
    'function openAssist(){}',
    'function closeModal(){}',
  ].join('\n');
  var fn = new Function('document', 'sessionStorage', 'location', 'CustomEvent', 'GM_xmlhttpRequest', 'GM_getValue', 'setTimeout', 'clearTimeout', '__token', '__toasts', '__statePublishes',
    prelude + '\n' + helpers + '\n' + block + '\n' + wiring +
    '\n; return { trackClientResponse: trackClientResponse, queryCrState: queryCrState, maybeConverge: maybeConverge, resolveById: resolveById, publishCr: publishCr };');
  world.toastsArr = [];
  world.statePublishes = [];
  return fn(world.document, world.sessionStorage, world.location, world.CustomEvent, world.GM_xmlhttpRequest, world.GM_getValue,
    world.setTimeout, world.clearTimeout, world.token === undefined ? 'tok-abc' : world.token, world.toastsArr, world.statePublishes);
}

// ---- drop-upload's step-4 helpers --------------------------------------------------------
function loadDrop(world, srcOverride) {
  var src = srcOverride || fs.readFileSync(DROP, 'utf8').replace(/\r\n/g, '\n');
  function cut(startMark, endMark) {
    var a = src.indexOf(startMark), b = src.indexOf(endMark);
    if (a === -1 || b === -1) throw new Error('drop marker not found: ' + (a === -1 ? startMark : endMark));
    return src.slice(a, b);
  }
  var classify = cut('  var CLIENT_DOMAINS', '  // ===== bwnAI v1');
  var chip = cut('  // ---- The needs-a-response chip', '  document.addEventListener(\'click\'');
  var prelude = 'var PENDING_TTL = 120000;\nvar pending = null;\nfunction toast(m){ __toasts.push(m); }\n';
  var fn = new Function('document', 'location', 'CustomEvent', 'setTimeout', 'clearTimeout', 'Math', '__toasts',
    prelude + classify + '\n' + chip +
    '\n; return { inboundClientEmail: inboundClientEmail, woIdFromUrl: woIdFromUrl, requestTrack: requestTrack,' +
    ' classifyDomain: classifyDomain, noteTypeForEmail: noteTypeForEmail, showRespChip: showRespChip,' +
    ' setPending: function(p){ pending = p; }, getPending: function(){ return pending; } };');
  world.dropToasts = [];
  return fn(world.document, world.location, world.CustomEvent, world.setTimeout, world.clearTimeout, Math, world.dropToasts);
}

function emailFile(over) {
  return Object.assign({
    isEmail: true, name: 'RE quote.msg', summary: 'Client asks when the compressor lands.',
    email: { subject: 'RE: cooler quote', fromEmail: 'facilities@pilottravelcenters.com', fromName: 'Facilities', to: [{ email: 'coord@broadwaynational.com' }], cc: [] },
  }, over || {});
}

async function run() {
  console.log('client-response handshake (drop-upload <-> wo-assist)\n');

  // ===== 1. which drops even offer the toggle ==============================================
  console.log('the toggle is offered only where a reply can be owed');
  var w = makeWorld();
  var drop = loadDrop(w);
  A.ok('an inbound CLIENT email qualifies', !!drop.inboundClientEmail([emailFile()]));
  A.ok('an inbound VENDOR email does not',
    !drop.inboundClientEmail([emailFile({ email: { subject: 's', fromEmail: 'rep@somevendor.com', to: [], cc: [] } })]));
  A.ok('an OUTBOUND email does not - it IS the reply',
    !drop.inboundClientEmail([emailFile({ email: { subject: 's', fromEmail: 'me@broadwaynational.com', to: [{ email: 'facilities@pilottravelcenters.com' }], cc: [] } })]));
  A.ok('a non-email attachment does not', !drop.inboundClientEmail([{ name: 'photo.jpg' }]));
  A.ok('the first client email in a mixed drop is the one tracked',
    drop.inboundClientEmail([{ name: 'photo.jpg' }, emailFile({ name: 'second.msg' })]).name === 'second.msg');
  // The re-type only matters because the untouched default really is Client.
  A.eq('control: an inbound client email would otherwise be logged as a Client note',
    drop.noteTypeForEmail(emailFile().email), 'Client');

  // ===== 2. the ack leg ====================================================================
  console.log('\nthe ack leg - a silent failure is the one unacceptable outcome');
  w = makeWorld({ gm: { ingest_key: 'k' }, replies: [{ status: 200, json: { ok: true, id: 'REC1', openedAt: '2026-08-04T12:00:00Z' } }] });
  var assist = loadAssist(w);
  drop = loadDrop(w);
  drop.requestTrack(emailFile(), '383500');
  var track = w.events.filter(function (e) { return e.id === 'bwn:assist:track'; })[0];
  A.ok('the drop emits bwn:assist:track', !!track);
  A.ok('...carrying the sender, the subject, the summary and the file', !!(track.emailFrom && track.emailSubject && track.ask && track.docRef));
  A.ok('...with a request id to correlate the answer', !!track.reqId);
  await tick();
  var post = w.posts[0];
  A.eq('the assist script POSTs kind client-response', post.kind, 'client-response');
  A.eq('...for the WO in the URL', post.woNumber, '383500');
  A.eq('...with the sender', post.emailFrom, 'facilities@pilottravelcenters.com');
  A.ok('...and never invents an op (a create is an absent op)', post.op === undefined);
  await tick();
  var acks = w.events.filter(function (e) { return e.id === 'bwn:assist:tracked'; });
  A.eq('exactly one ack comes back', acks.length, 1);
  A.eq('...it is positive', acks[0].ok, true);
  A.eq('...correlated to the request', acks[0].reqId, track.reqId);
  A.ok('the drop side reported success to the human', w.dropToasts.some(function (t) { return /Tracked as needing a client response/.test(t); }));

  // Every refusal path must still answer. A missing key is the likeliest one in the field.
  var cases = [
    { name: 'no ingest key set', world: { gm: {}, replies: [] }, expect: /ingest key/i },
    { name: 'a 403 from the route', world: { gm: { ingest_key: 'k' }, replies: [{ status: 403, json: { error: 'unauthorized' } }] }, expect: /403/ },
    { name: 'a route that predates step 4', world: { gm: { ingest_key: 'k' }, replies: [{ status: 400, json: { error: 'kind must be one of: mgmt-assist' } }] }, expect: /not deployed/ },
    { name: 'the SPA fallback page (2xx, not JSON)', world: { gm: { ingest_key: 'k' }, replies: [{ status: 200, text: '<!doctype html><html></html>' }] }, expect: /did not answer/ },
    { name: 'a network error', world: { gm: { ingest_key: 'k' }, replies: [{ networkError: true }] }, expect: /./ },
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var wi = makeWorld(c.world);
    loadAssist(wi); var di = loadDrop(wi);
    di.requestTrack(emailFile(), '383500');
    await tick(); await tick();
    var a = wi.events.filter(function (e) { return e.id === 'bwn:assist:tracked'; });
    A.eq(c.name + ': still answers', a.length, 1);
    A.eq(c.name + ': answers with a failure', a[0].ok, false);
    A.ok(c.name + ': says why (' + a[0].why + ')', c.expect.test(a[0].why || ''), a[0].why);
  }

  // A recorded-but-unnotified create is a SUCCESS with a caveat, not a failure: reporting it
  // as failure invites a re-drop the server would dedup-refuse.
  w = makeWorld({ gm: { ingest_key: 'k' }, replies: [{ status: 502, json: { ok: false, recorded: true, id: 'REC2' } }, { status: 200, json: { ok: true, found: true, record: {} } }] });
  loadAssist(w); drop = loadDrop(w);
  drop.requestTrack(emailFile(), '383500');
  await tick(); await tick();
  var ack2 = w.events.filter(function (e) { return e.id === 'bwn:assist:tracked'; })[0];
  A.eq('recorded-but-not-notified acks as OK', ack2.ok, true);
  A.ok('...and names what did not happen', /confirmation email did not send/.test(ack2.why), ack2.why);

  // The drop side must not wait forever on a script that is not installed.
  w = makeWorld({ gm: { ingest_key: 'k' } });
  drop = loadDrop(w);            // NO assist script in this world
  drop.requestTrack(emailFile(), '383500');
  w.fireTimers();
  A.ok('with no assist script listening, the drop side says so rather than going quiet',
    w.dropToasts.some(function (t) { return /nothing tracked it/.test(t); }), w.dropToasts.join(' | '));

  // ===== 3. convergence ====================================================================
  console.log('\nconvergence on an outbound reply');
  function convergeWorld(busClientNote, recOver) {
    var wv = makeWorld({ gm: { ingest_key: 'k' }, replies: [{ status: 200, json: { ok: true, applied: true, record: Object.assign({ id: 'REC1', status: 'resolved' }, recOver || {}) } }] });
    wv.session['bwn:wo:383500'] = JSON.stringify({ v: 1, ts: Date.now(), lastClientNote: busClientNote });
    return wv;
  }
  var rec = { id: 'REC1', status: 'open', openedAt: '2026-08-04T10:00:00.000Z', woNumber: '383500' };
  var wc = convergeWorld('2026-08-04T11:00:00.000Z');
  var ac = loadAssist(wc);
  ac.maybeConverge('383500', rec);
  await tick();
  A.eq('a client note NEWER than the item resolves it', wc.posts.length, 1);
  A.eq('...through the resolve verb', wc.posts[0].op, 'resolve');
  A.eq('...on that record', wc.posts[0].id, 'REC1');

  wc = convergeWorld('2026-08-04T09:00:00.000Z');
  ac = loadAssist(wc);
  ac.maybeConverge('383500', rec);
  await tick();
  A.eq('a client note OLDER than the item does nothing', wc.posts.length, 0);

  wc = convergeWorld('');
  ac = loadAssist(wc);
  ac.maybeConverge('383500', rec);
  await tick();
  A.eq('no client note at all does nothing', wc.posts.length, 0);

  wc = convergeWorld('2026-08-04T11:00:00.000Z');
  ac = loadAssist(wc);
  ac.maybeConverge('383500', rec);
  ac.maybeConverge('383500', rec);
  ac.maybeConverge('383500', rec);
  await tick();
  A.eq('convergence fires ONCE per item, not on every 5-minute tick', wc.posts.length, 1);

  wc = convergeWorld('2026-08-04T11:00:00.000Z');
  ac = loadAssist(wc);
  ac.maybeConverge('383500', { id: 'REC9', status: 'resolved', openedAt: '2026-08-04T10:00:00.000Z' });
  await tick();
  A.eq('an already-resolved item is never re-resolved', wc.posts.length, 0);

  // ===== 4. the state read is per kind =====================================================
  console.log('\nthe client-response state read');
  w = makeWorld({ gm: { ingest_key: 'k' }, replies: [{ status: 200, json: { ok: true, found: true, record: { id: 'R', status: 'open', openedAt: '2026-08-04T10:00:00.000Z' } } }] });
  assist = loadAssist(w);
  assist.queryCrState('383500', true);
  await tick(); await tick();
  A.eq('queryCrState asks for the client-response kind explicitly', w.posts[0].kind, 'client-response');
  A.eq('...via op:status', w.posts[0].op, 'status');
  A.ok('...and publishes on its OWN key, not the escalation strip\'s',
    !!w.session['bwn:assist:cr:383500'] && !w.session['bwn:assist:state:383500']);
  A.ok('...and its own bus event', w.events.some(function (e) { return e.id === 'bwn:assist:cr'; }));

  w = makeWorld({ gm: { ingest_key: 'k' }, replies: [{ status: 400, json: { error: 'kind must be one of: mgmt-assist' } }] });
  assist = loadAssist(w);
  assist.queryCrState('383500', true);
  await tick(); await tick();
  A.ok('a route that predates step 4 publishes NOTHING (the page looks unchanged)',
    !w.session['bwn:assist:cr:383500'] && !w.events.some(function (e) { return e.id === 'bwn:assist:cr'; }));

  // ===== 5. MUTATION CONTROLS ==============================================================
  console.log('\nmutation controls (each must break a case above)');
  var assistSrc = fs.readFileSync(ASSIST, 'utf8').replace(/\r\n/g, '\n');

  // M1: drop the ack on the failure path -> a failed track goes silent.
  var m1 = mutate(assistSrc, "if (!key) { trackAck(reqId, false, 'the SWA ingest key is not set (Tampermonkey menu -> \"Set SWA ingest key\")'); return; }",
    "if (!key) { return; }");
  var w1 = makeWorld({ gm: {}, replies: [] });
  loadAssist(w1, m1); var d1 = loadDrop(w1);
  d1.requestTrack(emailFile(), '383500');
  await tick(); await tick();
  A.eq('M1 ack removed -> the coordinator is told nothing',
    w1.events.filter(function (e) { return e.id === 'bwn:assist:tracked'; }).length, 0);

  // M2: converge on ANY client note rather than a newer one -> the inbound log self-closes it.
  var m2 = mutate(assistSrc, 'if (!lastClient || !rec.openedAt || lastClient <= rec.openedAt) return;', 'if (!lastClient) return;');
  var w2 = convergeWorld('2026-08-04T09:00:00.000Z');
  var a2 = loadAssist(w2, m2);
  a2.maybeConverge('383500', rec);
  await tick();
  A.eq('M2 recency test removed -> an OLDER client note resolves the item', w2.posts.length, 1);

  // M3: forget the once-per-item latch -> every tick re-POSTs a resolve.
  var m3 = mutate(assistSrc, '_crAutoTried[rec.id] = 1;', '');
  var w3 = convergeWorld('2026-08-04T11:00:00.000Z');
  var a3 = loadAssist(w3, m3);
  w3.replies.push({ status: 200, json: { ok: true, applied: false, record: { id: 'REC1', status: 'resolved' } } });
  w3.replies.push({ status: 200, json: { ok: true, applied: false, record: { id: 'REC1', status: 'resolved' } } });
  a3.maybeConverge('383500', rec); a3.maybeConverge('383500', rec); a3.maybeConverge('383500', rec);
  await tick();
  A.ok('M3 latch removed -> the resolve is re-POSTed on every pass', w3.posts.length > 1, 'posts=' + w3.posts.length);

  // M4: query the wrong kind -> the escalation record would drive client-response state.
  var m4 = mutate(assistSrc, "woNumber: woId, client: 'pilot', kind: TRACK_KIND }", "woNumber: woId, client: 'pilot' }");
  var w4 = makeWorld({ gm: { ingest_key: 'k' }, replies: [{ status: 200, json: { ok: true, found: false } }] });
  var a4 = loadAssist(w4, m4);
  a4.queryCrState('383500', true);
  await tick();
  A.ok('M4 kind dropped from the status read -> it asks for the default kind instead',
    w4.posts[0].kind === undefined, JSON.stringify(w4.posts[0]));

  // M5: the drop-side toggle stops discriminating -> it would offer on a vendor email.
  var dropSrc = fs.readFileSync(DROP, 'utf8').replace(/\r\n/g, '\n');
  var m5 = mutate(dropSrc, "if (classifyDomain(f.email.fromEmail) === 'Client') return f;", 'return f;');
  var w5 = makeWorld();
  var d5 = loadDrop(w5, m5);
  A.ok('M5 sender test removed -> a vendor email would offer the toggle',
    !!d5.inboundClientEmail([emailFile({ email: { subject: 's', fromEmail: 'rep@somevendor.com', to: [], cc: [] } })]));

  A.finish();
}

run().catch(function (e) { console.error('HARNESS CRASHED: ' + (e && e.stack || e)); process.exit(1); });
