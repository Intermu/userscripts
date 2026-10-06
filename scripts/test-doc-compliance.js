// test-doc-compliance.js - node harness for the read-only Documentation-compliance engine.
//
// Slices the PURE `BWN DOC-COMPLIANCE` block out of bwn-suite-core.user.js and runs the real
// shipped bytes. The block is self-contained (no injected externals), so `new Function` builds it
// directly. `nowMs` is a computeCompliance ARGUMENT, never Date.now() inside the block - this test
// asserts that at the source level too ([[headless-harness-cannot-time]] /
// [[fixture-clock-time-day-age]]).
//
// Covers: a pinned-rulesVersion score with an injected clock; the UNKNOWN-vs-MISS contract (a
// failed/pending read is 'unknown', NEVER a miss); a per-client override moving total AND score;
// rulesVersion stamped on the result AND on the enqueued rollup; label bucketing (4 -> Photo) with
// the numeric guard; and a NEGATIVE CONTROL - dropping a required label must flip its check to
// 'miss' (a rule that left it 'ok' fails here).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-doc-compliance.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');

function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf('// ===== BWN DOC-COMPLIANCE START');
  var b = t.indexOf('// ===== BWN DOC-COMPLIANCE END');
  if (a === -1 || b === -1) throw new Error('BWN DOC-COMPLIANCE markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = extractSection();

var T = (new Function(
  SECTION + '\n;return {' +
  ' computeCompliance: computeCompliance, complianceRollup: complianceRollup,' +
  ' complianceAgeBucket: complianceAgeBucket, complianceMisses: complianceMisses,' +
  ' complianceUnknowns: complianceUnknowns, complianceChecks: complianceChecks,' +
  ' tradeApplies: tradeApplies, docLabelName: docLabelName,' +
  ' DOC_LABEL_IDS: DOC_LABEL_IDS, DOC_LABEL_NAMES: DOC_LABEL_NAMES,' +
  ' DOC_CHECK_CATALOGUE: DOC_CHECK_CATALOGUE };'
))();

var NOW = Date.parse('2026-08-19T12:00:00Z');   // injected clock - never Date.now()

// Full, confidently-read WO: every evaluable doc + non-doc signal present.
function fullDocs() { return { 17: 1, 3: 1, 4: 2, 12: 1, 20: 1, 29: 1 }; }   // WOReq, Signoff, Photo, Invoice, VendorProposal, Receipt
function fullHeader() { return { trades: [{ name: 'Electrical' }], scopeOfWork: 'Replace ballast and lamps' }; }
function fullNotes() { return { hasCompletion: true, count: 3 }; }
function fullPos() { return [{ amount: 500, vendor: 'Acme' }]; }
function score(profile, rv, docs, header, notes, pos) {
  return T.computeCompliance(
    header === undefined ? fullHeader() : header,
    notes === undefined ? fullNotes() : notes,
    docs === undefined ? fullDocs() : docs,
    null,
    pos === undefined ? fullPos() : pos,
    profile || {},
    rv === undefined ? 1 : rv,
    NOW
  );
}
function checkState(res, id) { var c = res.checks.filter(function (x) { return x.id === id; })[0]; return c ? c.state : '(absent)'; }

console.log('Doc-compliance engine - ' + path.basename(SRC));

// 0. the sliced block must not read the clock itself (nowMs is injected). Strip comments first -
// the block's own header comment MENTIONS "Date.now()" while forbidding it, and a raw scan would
// catch that prose. We only care about a real call in code.
console.log('\n0. injected-clock discipline');
var CODE_ONLY = SECTION.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
A.ok('no Date.now() call in the sliced block (comments stripped)', CODE_ONLY.indexOf('Date.now(') === -1, 'block must take nowMs as an argument');

// 1. a fully-present WO at a pinned rulesVersion, on the injected clock.
console.log('\n1. full WO -> every evaluable check ok');
(function () {
  var r = score({}, 1);
  A.eq('score = total (all evaluable ok)', [r.score, r.total], [8, 8]);
  A.eq('rulesVersion stamped from the arg', r.rulesVersion, 1);
  A.eq('receipt not required by default -> na', checkState(r, 'receipt'), 'na');
  A.eq('salesforce dropped (no data source) -> na', checkState(r, 'salesforceUpdate'), 'na');
  A.eq('na checks are excluded from total', r.checks.filter(function (c) { return c.state === 'ok' || c.state === 'miss'; }).length, r.total);
  A.eq('no misses on a full WO', T.complianceMisses(r), []);
  // determinism: identical inputs, a different injected nowMs -> identical verdict (no clock read).
  var r2 = T.computeCompliance(fullHeader(), fullNotes(), fullDocs(), null, fullPos(), {}, 1, NOW + 999 * 86400000);
  A.eq('deterministic across nowMs (proves no Date.now)', [r2.score, r2.total], [r.score, r.total]);
})();

// 2. THE CRITICAL CONTRACT: a failed/pending read is 'unknown', never a miss.
console.log('\n2. unknown-vs-miss (unread != absent)');
(function () {
  var rUnknown = score({}, 1, null);   // docsByLabel == null => docs unread
  A.eq('unread docs -> photos UNKNOWN, not miss', checkState(rUnknown, 'photos'), 'unknown');
  A.eq('unread docs -> invoice UNKNOWN, not miss', checkState(rUnknown, 'invoice'), 'unknown');
  A.ok('no doc check is a miss when docs are unread', rUnknown.checks.every(function (c) { return !(c.docId) && c.state !== 'miss' || c.state !== 'miss'; }), 'unknown must never count as miss');
  A.eq('unknown checks are excluded from total (not penalised)', rUnknown.total, 3);   // only scope/completion/po are readable
  A.eq('score counts only confident oks', rUnknown.score, 3);
  // 5 REQUIRED doc checks go unknown; receipt (required:false) is na, not unknown - it short-circuits
  // before the docLabels branch, so unread docs never turn a non-required check into an unknown.
  A.eq('exactly the 5 required doc checks are unknown', T.complianceUnknowns(rUnknown), 5);
  // header unread -> scopeOfWork unknown; notes unread -> completion unknown; pos unread -> po unknown.
  var rBlind = T.computeCompliance(null, null, null, null, null, {}, 1, NOW);
  A.eq('all-unread -> total 0 (nothing penalised)', rBlind.total, 0);
  A.eq('all-unread -> score 0', rBlind.score, 0);
  A.eq('scopeOfWork unknown when header unread', checkState(rBlind, 'scopeOfWork'), 'unknown');
  A.eq('completionNote unknown when notes unread', checkState(rBlind, 'completionNote'), 'unknown');
  A.eq('poAttached unknown when pos+header unread', checkState(rBlind, 'poAttached'), 'unknown');
})();

// 3. confident-empty reads -> misses (the mirror image of unknown).
console.log('\n3. confident-empty -> miss');
(function () {
  var rEmpty = score({}, 1, {});   // docsByLabel == {} : read landed, nothing on file
  A.eq('empty docs -> photos MISS', checkState(rEmpty, 'photos'), 'miss');
  A.eq('empty docs -> workOrderRequest MISS', checkState(rEmpty, 'workOrderRequest'), 'miss');
  A.eq('5 doc misses + 3 non-doc oks -> total 8', rEmpty.total, 8);
  A.eq('score = 3 (scope/completion/po still ok)', rEmpty.score, 3);
  var noScope = score({}, 1, fullDocs(), { trades: [{ name: 'Electrical' }], scopeOfWork: '' });
  A.eq('blank scopeOfWork -> scope MISS', checkState(noScope, 'scopeOfWork'), 'miss');
  var noCompletion = score({}, 1, fullDocs(), fullHeader(), { hasCompletion: false, count: 2 });
  A.eq('no completion note -> MISS', checkState(noCompletion, 'completionNote'), 'miss');
  var noPo = score({}, 1, fullDocs(), fullHeader(), fullNotes(), []);
  A.eq('no PO -> poAttached MISS', checkState(noPo, 'poAttached'), 'miss');
})();

// 4. NEGATIVE CONTROL: dropping a required label MUST flip the check to miss.
console.log('\n4. negative control - drop a required label');
(function () {
  var withPhoto = score({}, 1, fullDocs());
  A.eq('photo label present -> photos ok', checkState(withPhoto, 'photos'), 'ok');
  var docs = fullDocs(); delete docs[4];             // remove the Photo label (id 4)
  var withoutPhoto = score({}, 1, docs);
  A.eq('photo label DROPPED -> photos flips to MISS', checkState(withoutPhoto, 'photos'), 'miss');
  A.ok('dropping a required label lowers the score', withoutPhoto.score === withPhoto.score - 1, withoutPhoto.score + ' vs ' + withPhoto.score);
})();

// 5. per-client override changes total AND score.
console.log('\n5. per-client override moves total + score');
(function () {
  var base = score({}, 1);                            // receipt na -> excluded (total 8)
  var over = { compliance: { checks: { receipt: { required: true } } } };
  var withReceipt = score(over, 1);                   // receipt now required, and present (29:1) -> ok
  A.ok('override adds the receipt check to total', withReceipt.total === base.total + 1, withReceipt.total + ' vs ' + base.total);
  A.ok('override adds the passing receipt to score', withReceipt.score === base.score + 1, withReceipt.score + ' vs ' + base.score);
  A.eq('receipt now evaluated as ok', checkState(withReceipt, 'receipt'), 'ok');
  // the other direction: drop a required check to na -> total falls.
  var off = { compliance: { checks: { photos: { required: false } } } };
  var noPhotoReq = score(off, 1);
  A.ok('override to required:false removes a check from total', noPhotoReq.total === base.total - 1, noPhotoReq.total + ' vs ' + base.total);
  A.eq('photos now na', checkState(noPhotoReq, 'photos'), 'na');
  // appliesToTrades: a check gated to a trade the WO does not have -> na.
  var trades = { compliance: { checks: { signoff: { appliesToTrades: ['Plumbing'] } } } };
  A.eq('signoff na when its trade gate misses', checkState(score(trades, 1), 'signoff'), 'na');
  var tradesHit = { compliance: { checks: { signoff: { appliesToTrades: ['Electrical'] } } } };
  A.eq('signoff evaluated when its trade gate hits', checkState(score(tradesHit, 1), 'signoff'), 'ok');
})();

// 6. rulesVersion is recorded on the result AND on the enqueued rollup.
console.log('\n6. rulesVersion on result + rollup');
(function () {
  var r = score({}, 7);
  A.eq('result.rulesVersion is the passed value (not hardcoded)', r.rulesVersion, 7);
  var roll = T.complianceRollup('370534', r, 'Jane Coord', 12);
  A.eq('rollup carries the same rulesVersion', roll.rulesVersion, 7);
  A.eq('rollup shape', Object.keys(roll).sort(), ['ageBucket', 'coordinator', 'rulesVersion', 'score', 'total', 'woNumber']);
  A.eq('rollup woNumber/score/total/coordinator', [roll.woNumber, roll.score, roll.total, roll.coordinator], ['370534', 8, 8, 'Jane Coord']);
  A.eq('ageBucket buckets days (12 -> 8-30d)', roll.ageBucket, '8-30d');
  A.eq('ageBucket boundaries', [T.complianceAgeBucket(null), T.complianceAgeBucket(7), T.complianceAgeBucket(8), T.complianceAgeBucket(31)], ['unknown', '0-7d', '8-30d', '30d+']);
})();

// 7. label bucketing (4 -> Photo) + the numeric guard.
console.log('\n7. label id mapping + numeric guard');
(function () {
  A.eq('DOC_LABEL_IDS Photo -> 4', T.DOC_LABEL_IDS['Photo'], 4);
  A.eq('DOC_LABEL_NAMES 4 -> Photo', T.DOC_LABEL_NAMES[4], 'Photo');
  A.eq('docLabelName(4) -> Photo', T.docLabelName(4), 'Photo');
  A.eq('docLabelName numeric guard: text label -> ""', T.docLabelName('Photo'), '');
  A.eq('docLabelName numeric guard: null -> ""', T.docLabelName(null), '');
  A.eq('docLabelName unknown id -> ""', T.docLabelName(999), '');
  // a docsByLabel built from ONLY the numeric id 4 satisfies the photos check (the 4->Photo bucket).
  var onlyPhoto = T.computeCompliance(fullHeader(), fullNotes(), { 4: 1 }, null, fullPos(), {}, 1, NOW);
  A.eq('numeric label 4 alone -> photos ok', checkState(onlyPhoto, 'photos'), 'ok');
  A.eq('but invoice (12) is then a miss', checkState(onlyPhoto, 'invoice'), 'miss');
})();

A.finish();
