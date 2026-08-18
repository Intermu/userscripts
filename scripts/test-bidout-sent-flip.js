// test-bidout-sent-flip.js - node harness for the bid-out "sent-state flip" (open-work #15).
//
// WHAT SHIPPED, as sliced from source (bwn-bid-out.user.js v0.27.0):
//   1. A "Bid-sent state flip" block: on a CONFIRMED send it persists a small per-WO record
//      ({status,ts,sent,from,channel,tracking,wo,gm}) into the GM store (SENT_KEY), the same
//      GM_setValue store the HVAC benchmark uses. bidStatus (server opens) + this local flag are
//      the two halves of the WO's "bid sent" state.
//   2. applySendFlip(wo, r, opts) is the GATE: it flips to "sent" ONLY when r.ok is truthy. A
//      failed / maybe-sent resolve writes NOTHING, so the un-bid state survives a failed send.
//   3. bidGm(benchmark) captures a gross-margin BASELINE (the HVAC PM target annual price) when a
//      priced benchmark was attached. No margin percent is computed (vendor price is unknown until
//      they bid); a zero / negative / non-finite annual is NOT a baseline.
//   4. The wizard gained a 4th "Sent" step: on send success it advances (openState.step = 4) to a
//      confirmation panel instead of close()-ing, so the coordinator sees the WO flip to bid-sent.
//
// Drives the REAL shipped bytes: slices the flip block out of the userscript and runs it against a
// stubbed GM store + woNumber, exactly as the sibling test-bidout-dock.js slices the dock block.
// Structural asserts over the FULL file then prove the DOM-bound wiring (send handler, drawSent,
// stepper, draft path) still calls into the tested helpers - a unit-green helper with the wiring
// removed must still redden here.
//
// Every mutation reverts one piece and asserts THIS harness goes red. mutate() throws if its
// target string is absent or not unique, so a mutation that silently fails to apply cannot
// masquerade as a passing negative control.
//
// NOT RUN LOCALLY: this machine has no node/npm. CI runs it (node scripts/test-bidout-sent-flip.js).
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bidout-sent-flip.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var BID_SRC = path.join(__dirname, '..', 'bwn-bid-out.user.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}

// Fails loudly rather than silently no-opping - a mutation that does not apply would otherwise
// read as "the negative control passed".
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var bidFull = readLF(BID_SRC);

var FLIP_SECTION = slice(bidFull,
  '  // ---- Bid-sent state flip: persist',
  '  // ---- end bid-sent state flip',
  'bid-out sent-state flip block');

// ---- vm harness ------------------------------------------------------------------------------
// A backing object stands in for the Tampermonkey GM store; woNumber() is stubbed to the WO the
// probe is "on". Run the slice once, then drive its top-level functions off the context.
function loadFlip(src, woN) {
  var store = {};
  var ctx = {
    console: console, Date: Date,
    GM_getValue: function (k, d) { return (k in store) ? store[k] : d; },
    GM_setValue: function (k, v) { store[k] = v; },
    woNumber: function () { return woN; }
  };
  ctx._store = store;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

// ---- probe: the flip GATE (only a confirmed send flips; a failed send must not) ---------------
function probeGate(src) {
  var wo = { trackingNumber: 'TRK-100' };
  var ctx = loadFlip(src, 381367);
  var r = {};

  r.emptyBefore = ctx.bidSentRec(wo) === null;                          // un-bid state at start

  // Server-confirmed send flips: record written, status 'sent', count carried, channel graph.
  var okRec = ctx.applySendFlip(wo, { ok: true, sent: 3 }, { from: 'me@bwn.com' });
  r.okReturnsRec = !!okRec && okRec.status === 'sent';
  var read = ctx.bidSentRec(wo);
  r.okPersists = !!read && read.status === 'sent' && read.sent === 3 && read.channel === 'graph' && read.from === 'me@bwn.com';
  r.okKeyedByTracking = read && read.tracking === 'TRK-100' && read.wo === '381367';

  // NEGATIVE CONTROL: a failed send returns null AND writes nothing - the un-bid state survives.
  var wo2 = { trackingNumber: 'TRK-FAIL' };
  var failRec = ctx.applySendFlip(wo2, { ok: false, code: 'NET' }, { from: 'me@bwn.com' });
  r.failReturnsNull = failRec === null;
  r.failWritesNothing = ctx.bidSentRec(wo2) === null;

  // A missing / maybe-sent resolve also does not flip.
  r.nullResolveNoFlip = ctx.applySendFlip(wo2, null, {}) === null && ctx.bidSentRec(wo2) === null;
  r.inProgressNoFlip = ctx.applySendFlip(wo2, { ok: false, code: 'IN_PROGRESS' }, {}) === null && ctx.bidSentRec(wo2) === null;

  // ok with no count -> sent 0 (never undefined).
  var wo3 = { trackingNumber: 'TRK-Z' };
  var z = ctx.applySendFlip(wo3, { ok: true }, {});
  r.okNoCountIsZero = !!z && z.sent === 0;

  // Idempotent duplicate: a second confirmed send overwrites in place (still one record, 'sent').
  ctx.applySendFlip(wo, { ok: true, sent: 5 }, { from: 'other@bwn.com' });
  var again = ctx.bidSentRec(wo);
  r.duplicateReaffirms = again.status === 'sent' && again.sent === 5 && again.from === 'other@bwn.com';
  r.oneRecordPerWo = Object.keys(JSON.parse(ctx._store['bwn:bidout:sent'])).length === 2; // TRK-100 + TRK-Z; the failed WO wrote nothing

  return r;
}

// ---- probe: the GM (gross-margin) baseline guard ---------------------------------------------
function probeGm(src) {
  var ctx = loadFlip(src, 1);
  var r = {};
  r.pricedIsBaseline = JSON.stringify(ctx.bidGm({ annual: 12000 })) === JSON.stringify({ known: true, targetAnnual: 12000, source: 'hvac-benchmark' });
  r.numericStringCoerced = ctx.bidGm({ annual: '9000' }).targetAnnual === 9000;            // + coercion
  r.zeroNotBaseline = ctx.bidGm({ annual: 0 }).known === false;                            // money guard
  r.negativeNotBaseline = ctx.bidGm({ annual: -5 }).known === false;                       // money guard
  r.nanNotBaseline = ctx.bidGm({ annual: 'abc' }).known === false;                         // money guard
  r.missingAnnualNotBaseline = ctx.bidGm({}).known === false;
  r.nullBenchmarkNotBaseline = ctx.bidGm(null).known === false;
  r.baselineNullsWhenUnknown = ctx.bidGm({ annual: 0 }).targetAnnual === null && ctx.bidGm(null).source === null;
  // bidGmFlag reads the record's gm.known.
  r.flagBenchmarked = ctx.bidGmFlag({ gm: { known: true, targetAnnual: 9000 } }) === 'benchmarked';
  r.flagPending = ctx.bidGmFlag({ gm: { known: false } }) === 'pending' && ctx.bidGmFlag(null) === 'pending';
  return r;
}

// ---- probe: markBidSent record shape (draft channel, key fallback) ----------------------------
function probeRecord(src) {
  var r = {};
  // Draft channel -> softer 'draft-opened' status; GM baseline still captured from the benchmark.
  var ctxA = loadFlip(src, 555);
  var d = ctxA.markBidSent({ trackingNumber: 'TRK-D' }, { channel: 'draft', sent: 5, from: 'you@bwn.com', benchmark: { annual: 9000 } });
  r.draftStatus = d.status === 'draft-opened' && d.channel === 'draft' && d.sent === 5;
  r.draftKeepsGmBaseline = d.gm.known === true && d.gm.targetAnnual === 9000;

  // No trackingNumber -> the key falls back to woNumber() (so it still persists, not silently lost).
  var ctxB = loadFlip(src, 777);
  var f = ctxB.markBidSent({}, { channel: 'graph', sent: 1 });
  r.keyFallsBackToWo = !!f && ctxB.bidSentRec({}) !== null && JSON.parse(ctxB._store['bwn:bidout:sent'])['777'].sent === 1;

  // Two different WOs do not collide in the store.
  var ctxC = loadFlip(src, 111);
  ctxC.markBidSent({ trackingNumber: 'A' }, { sent: 1 });
  ctxC.markBidSent({ trackingNumber: 'B' }, { sent: 2 });
  var map = JSON.parse(ctxC._store['bwn:bidout:sent']);
  r.distinctWosDistinctKeys = map['A'].sent === 1 && map['B'].sent === 2;

  // No key at all (no tracking, no woNumber) -> returns null, writes nothing.
  var ctxD = loadFlip(src, null);
  r.noKeyNoWrite = ctxD.markBidSent({}, { sent: 9 }) === null && ctxD._store['bwn:bidout:sent'] === undefined;
  return r;
}

// ---- probe: the DOM-bound wiring calls into the tested helpers (full file, structural) --------
// Single-line fragments only, so the asserts are indentation-agnostic (indexOf finds them wherever
// they sit in the nested closures). Each fragment is the exact call the tested helper is wired to.
function probeWiring(full) {
  function has(s) { return full.indexOf(s) !== -1; }
  var r = {};
  r.gateWiredIntoSend = has('var rec = applySendFlip(wo, r, { from: from, benchmark: openState.benchmark });');
  r.graphRecordsSentInfo = has('openState.sentInfo = { rec: rec, sent: r.sent, from: from, tracked: !!r.tracked, failed: r.failed || 0 };');
  r.graphAdvancesToSent = has('openState.step = 4; draw(); return;');
  r.draftFlips = has("var drec = markBidSent(wo, { sent: mail.bcc.length, from: fromDefault, channel: 'draft', benchmark: openState.benchmark });");
  r.draftRecordsSentInfo = has("openState.sentInfo = { rec: drec, sent: mail.bcc.length, from: fromDefault, channel: 'draft' };");
  r.draftAdvancesToSent = has('openState.step = 4; draw();');
  r.drawDispatchesStep4 = has('if (openState.step === 4) return drawSent();');
  r.drawSentDefined = has('function drawSent()');
  r.stepperHasSent = has("var labels = ['Work Order Details', 'Select Vendors', 'Review', 'Sent'];");
  r.reviewReflectsPriorSend = has('var prevSent = bidSentRec(wo);');
  return r;
}

// ---- run: real source ------------------------------------------------------------------------
console.log('bid-out sent-state flip (open-work #15) - real source');

var g = probeGate(FLIP_SECTION);
A.ok('un-bid before any send (bidSentRec null)', g.emptyBefore, JSON.stringify(g));
A.ok('confirmed send returns a "sent" record', g.okReturnsRec, JSON.stringify(g));
A.ok('confirmed send persists status/sent/channel/from', g.okPersists, JSON.stringify(g));
A.ok('record keyed by tracking # + carries woNumber', g.okKeyedByTracking, JSON.stringify(g));
A.ok('NEG CONTROL: failed send returns null', g.failReturnsNull, JSON.stringify(g));
A.ok('NEG CONTROL: failed send writes nothing (un-bid survives)', g.failWritesNothing, JSON.stringify(g));
A.ok('null resolve does not flip', g.nullResolveNoFlip, JSON.stringify(g));
A.ok('in-progress resolve does not flip', g.inProgressNoFlip, JSON.stringify(g));
A.ok('ok with no count -> sent 0', g.okNoCountIsZero, JSON.stringify(g));
A.ok('duplicate confirmed send re-affirms in place', g.duplicateReaffirms, JSON.stringify(g));
A.ok('one record per WO (failed WO absent)', g.oneRecordPerWo, JSON.stringify(g));

var m = probeGm(FLIP_SECTION);
A.ok('priced benchmark -> GM baseline captured', m.pricedIsBaseline, JSON.stringify(m));
A.ok('numeric-string annual coerced to number', m.numericStringCoerced, JSON.stringify(m));
A.ok('MONEY GUARD: zero annual is not a baseline', m.zeroNotBaseline, JSON.stringify(m));
A.ok('MONEY GUARD: negative annual is not a baseline', m.negativeNotBaseline, JSON.stringify(m));
A.ok('MONEY GUARD: non-finite annual is not a baseline', m.nanNotBaseline, JSON.stringify(m));
A.ok('missing annual is not a baseline', m.missingAnnualNotBaseline, JSON.stringify(m));
A.ok('null benchmark is not a baseline', m.nullBenchmarkNotBaseline, JSON.stringify(m));
A.ok('targetAnnual/source null when unknown', m.baselineNullsWhenUnknown, JSON.stringify(m));
A.ok('bidGmFlag = benchmarked when known', m.flagBenchmarked, JSON.stringify(m));
A.ok('bidGmFlag = pending when unknown/absent', m.flagPending, JSON.stringify(m));

var rec = probeRecord(FLIP_SECTION);
A.ok('draft channel -> draft-opened status', rec.draftStatus, JSON.stringify(rec));
A.ok('draft still captures the GM baseline', rec.draftKeepsGmBaseline, JSON.stringify(rec));
A.ok('key falls back to woNumber when no tracking #', rec.keyFallsBackToWo, JSON.stringify(rec));
A.ok('distinct WOs keep distinct records', rec.distinctWosDistinctKeys, JSON.stringify(rec));
A.ok('no key at all -> null, no write', rec.noKeyNoWrite, JSON.stringify(rec));

var w = probeWiring(bidFull);
A.ok('send handler calls applySendFlip(wo, r, ...)', w.gateWiredIntoSend, JSON.stringify(w));
A.ok('graph success records sentInfo (rec)', w.graphRecordsSentInfo, JSON.stringify(w));
A.ok('a success path advances the wizard to step 4', w.graphAdvancesToSent, JSON.stringify(w));
A.ok('draft path flips via markBidSent (channel draft)', w.draftFlips, JSON.stringify(w));
A.ok('draft path records sentInfo (drec)', w.draftRecordsSentInfo, JSON.stringify(w));
A.ok('draft path advances the wizard to step 4', w.draftAdvancesToSent, JSON.stringify(w));
A.ok('draw() dispatches step 4 -> drawSent', w.drawDispatchesStep4, JSON.stringify(w));
A.ok('drawSent() defined', w.drawSentDefined, JSON.stringify(w));
A.ok("stepper carries a 4th 'Sent' step", w.stepperHasSent, JSON.stringify(w));
A.ok('review step reflects a prior send', w.reviewReflectsPriorSend, JSON.stringify(w));

// ---- mutations: revert one piece each, assert the harness goes red ---------------------------
console.log('\nmutations (each must redden its probe)');

// M1: the flip gate drops its r.ok check -> a FAILED send would flip. Negative control reddens.
var m1 = probeGate(mutate(FLIP_SECTION,
  'if (!r || !r.ok) return null;',
  'if (!r) return null;'));
A.ok('M1 dropping the r.ok gate lets a failed send flip', m1.failWritesNothing === false, JSON.stringify(m1));

// M2: the money guard accepts any benchmark -> a zero/negative annual reads as a baseline.
var m2 = probeGm(mutate(FLIP_SECTION,
  'var known = !!(benchmark && isFinite(a) && a > 0);',
  'var known = !!(benchmark);'));
A.ok('M2 removing the money guard makes zero annual a baseline', m2.zeroNotBaseline === false, JSON.stringify(m2));

// M3: the key loses its woNumber fallback -> a WO with no tracking # is silently lost.
var m3 = probeRecord(mutate(FLIP_SECTION,
  "return String((wo && wo.trackingNumber) || woNumber() || '');",
  "return String((wo && wo.trackingNumber) || '');"));
A.ok('M3 dropping the woNumber fallback loses a no-tracking WO', m3.keyFallsBackToWo === false, JSON.stringify(m3));

// M4: draft sends record as 'sent' -> the softer draft state is lost.
var m4 = probeRecord(mutate(FLIP_SECTION,
  "status: (info && info.channel === 'draft') ? 'draft-opened' : 'sent',",
  "status: 'sent',"));
A.ok('M4 collapsing the draft status breaks draft-opened', m4.draftStatus === false, JSON.stringify(m4));

console.log('\n(flip gate + GM baseline guard + record keying x real source, 4 mutations, plus');
console.log(' structural wiring asserts. Nothing here proves the Sent PANEL renders or that a real');
console.log(' Graph send resolves - those are the live gate on the open-work board.)');
A.finish();
