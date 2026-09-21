// test-wo-audit-evidence.js - node harness for the 0.13.0 evidence layer.
//
// Covers the four things 0.13.0 added or hardened:
//   1. the claim gate (what an AI line may assert, and what the evidence must show for it),
//   2. the widened GROUNDING date tokenizer (ISO / hyphen / month-name no longer walk past),
//   3. strict work-order key normalization (a compound cell is refused, never guessed),
//   4. read-only WOA_PHASE status coverage.
//
// Slices the PURE blocks out of the .user.js and runs the SHIPPED bytes - TIMELINE (fmtMD/ecdInfo),
// STATE (everything above) and POST (hasPriorAuditNote, for the evidence-exclusion-vs-idempotency
// pair that only makes sense when both are driven together).
//
// The clock is INJECTED on every call ([[fixture-clock-time-day-age]] / [[headless-harness-cannot-time]]).
// The claim and coverage cases are TABLE-DRIVEN so a newly observed phrasing is one row.
// Every rule carries a NEGATIVE control: a gate that rejects everything is not a gate.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-evidence.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');
var TEXT = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startMark, endMark) {
  var a = TEXT.indexOf(startMark);
  var b = TEXT.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error(startMark + ' / ' + endMark + ' markers not found in ' + SRC);
  if (TEXT.indexOf(startMark, a + 1) !== -1) throw new Error('non-unique marker: ' + startMark);
  return TEXT.slice(a, b);
}
var SECTION =
  slice('// ===== BWN WO-AUDIT TIMELINE START', '// ===== BWN WO-AUDIT TIMELINE END') + '\n' +
  slice('// ===== BWN WO-AUDIT STATE START', '// ===== BWN WO-AUDIT STATE END') + '\n' +
  slice('// ===== BWN WO-AUDIT POST START', '// ===== BWN WO-AUDIT POST END');

var MS_DAY = 86400000;
function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
function auditCfg(key, def) { return def; }          // no localStorage in node - the shipped default
var STALE_DAYS = 7;

var T = (new Function('MS_DAY', '_date', 'auditCfg', 'STALE_DAYS',
  SECTION + '\n;return { deriveState: deriveState, composeAuditStatusNote: composeAuditStatusNote,' +
  ' validateAiNote: validateAiNote, validateTimelineChain: validateTimelineChain,' +
  ' woaClaimIssue: woaClaimIssue, woaGroundTokens: woaGroundTokens, ungroundedDates: ungroundedDates,' +
  ' woaNormalizeKey: woaNormalizeKey, statusCoverage: statusCoverage, meaningfulNotes: meaningfulNotes,' +
  ' woaStripQuotedEmail: woaStripQuotedEmail,' +
  ' hasPriorAuditNote: hasPriorAuditNote, postEligible: postEligible, AUDIT_MARKER: AUDIT_MARKER,' +
  ' composeTimelineNote: composeTimelineNote, fallbackChain: fallbackChain, WOA_PHASE: WOA_PHASE,' +
  ' WOA_CLAIM_RULES: WOA_CLAIM_RULES };'
))(MS_DAY, _date, auditCfg, STALE_DAYS);

// Fixed clock: 2026-09-17 local noon (same as test-wo-audit-state.js).
var NOW = +new Date(2026, 8, 17, 12, 0, 0);
function daysAgo(d) { return new Date(NOW - d * MS_DAY).toISOString(); }
function note(body, ageDays, extra) {
  var n = { content: body, createdDate: daysAgo(ageDays) };
  for (var k in (extra || {})) n[k] = extra[k];
  return n;
}
function H(status, over) {
  var h = {
    statusName: status, phase: 'Open', remainingDays: 5, nextOnsiteDate: null,
    priority: { label: 'P3', expectedCompletionDate: null },
    doNotExceed: null, totalNTE: null, grossProfitInfo: null,
    hasNonTerminatedPurchaseOrders: true, purchaseOrders: [{ id: 1 }], trades: [{ name: 'Service' }]
  };
  for (var k in (over || {})) h[k] = over[k];
  return h;
}
function st(h, notes) { return T.deriveState(h, notes, NOW); }

console.log('WO Audit evidence layer (0.13.0) - ' + path.basename(SRC));

// ---------------------------------------------------------------------------------------------
console.log('\n1. Grounding tokenizer: the three formats that used to walk past the date gate');
var tokCases = [
  { text: 'ECD 9/30', want: ['9/30'], why: 'slash (the format that always worked)' },
  { text: 'target 2026-09-30', want: ['9/30'], why: 'ISO normalizes to the same token' },
  { text: 'complete by Sept 30', want: ['9/30'], why: 'month-name, abbreviated' },
  { text: 'complete by November 30, 2026', want: ['11/30'], why: 'month-name, full + year' },
  { text: 'parts due 9/15 and 9/20', want: ['9/15', '9/20'], why: 'several tokens, order preserved' },
  // MEASURED against the 09/18 workbook (282 shipped notes): every date-shaped bare hyphen pair in
  // it was a range, never a date - either slash-date spillover or a lead time. Reading them as
  // dates would let "4-6 weeks" in the evidence ground an invented "4/6" in the output.
  { text: 'rack ordered with 4-6 weeks shipping', want: [], why: 'a lead-time range is NOT a date' },
  { text: 'Strous Electric 3-4 months out', want: [], why: 'neither is a duration range' },
  { text: 'revised proposal 5/4-5/5', want: ['5/4', '5/5'], why: 'a slash-date RANGE still yields both real dates' },
  { text: 'install sched 7/11-7/13 pending', want: ['7/11', '7/13'], why: '...and the spillover pair adds no phantom' },
  // A permissive month regex read these as December dates in that same workbook.
  { text: 'Heritage declined 4/23', want: ['4/23'], why: '"declined 4" is not December 4' },
  { text: 'vendor decline 8 days later', want: [], why: '"decline 8" is not December 8 either' },
  { text: 'no dates at all here', want: [], why: 'control: prose with no date yields nothing' },
  { text: 'call 555-1234 x4', want: [], why: 'control: a phone number is not a date' },
  { text: 'invoice 99/99', want: [], why: 'control: an out-of-range pair is not a date' }
];
tokCases.forEach(function (c) {
  A.eq(c.why, T.woaGroundTokens(c.text), c.want);
});
// The ISO pass must consume its own inner "09-30" so the hyphen pass cannot re-read it as 9/30 of
// some other month, and a 4-digit year must never become a token.
A.eq('an ISO date yields exactly one token', T.woaGroundTokens('2026-09-30').length, 1);
// The bypass this widening exists to close, end to end.
var gBypass = 'Note 1 (9/14): Proposal submitted to the client.';
var fBypass = st(H('Proposed'), [note('Proposal submitted to the client.', 3)]);
[
  ['ECD-shaped ISO date', 'Awaiting client approval - client to respond by 2026-11-30 - ECD TBD'],
  ['month-name date', 'Awaiting client approval - client to respond by Nov 30 - ECD TBD'],
  ['full month-name date', 'Awaiting client approval - client to respond by November 30 - ECD TBD']
].forEach(function (row) {
  var bad = T.validateAiNote(row[1], fBypass, gBypass);
  A.ok('an invented ' + row[0] + ' is REJECTED', !!bad, row[1] + ' -> ' + bad);
});
// A hyphen-shaped ECD is refused by the TAIL rule before grounding is even consulted, which is why
// the tokenizer does not need to read bare hyphen pairs as dates.
var hyTail = T.validateAiNote('Awaiting client approval - Client to approve the proposal - ECD 9-30', fBypass, gBypass);
A.ok('a hyphen-shaped ECD is rejected by the tail rule', !!hyTail, hyTail);
A.ok('...and the reason names the ECD clause, not a date', /ECD clause/.test(hyTail), hyTail);
// negative control: the same date IS allowed once the evidence carries it, in any of the formats.
A.eq('control: an ISO date present in the evidence is allowed',
  T.validateAiNote('Awaiting client approval - client to respond by 11/30 - ECD TBD', fBypass, gBypass + ' follow up 2026-11-30'), '');
A.eq('control: a month-name date in the evidence grounds a slash date in the output',
  T.validateAiNote('Awaiting client approval - client to respond by 11/30 - ECD TBD', fBypass, gBypass + ' follow up Nov 30'), '');

// ---------------------------------------------------------------------------------------------
console.log('\n2. Claim gate: an unevidenced assertion is refused (table-driven)');
// One fixture, one line, one expectation. `ev` is what the model was shown.
var fProp = st(H('Proposed'), [note('Proposal submitted to the client for pricing review.', 3)]);
var evProp = 'Note 1 (9/14): Proposal submitted to the client for pricing review.';
var claimCases = [
  { id: 'completion', line: 'Awaiting client approval - work complete - ECD TBD', ev: evProp, reject: true, why: 'completion claimed with no completion evidence' },
  { id: 'completion', line: 'Awaiting client approval - the job is done on site - ECD TBD', ev: evProp, reject: true, why: 'a second completion phrasing is caught too' },
  { id: 'approval', line: 'Awaiting client approval - the client approved it - ECD TBD', ev: evProp, reject: true, why: 'approval claimed with no approval evidence' },
  { id: 'financial', line: 'Awaiting client approval - vendor quoted the repair at cost - ECD TBD', ev: 'Note 1 (9/14): Proposal submitted to the client.', reject: true, why: 'pricing cited with no pricing evidence' },
  { id: 'operational', line: 'Awaiting client approval - vendor assigned and visit scheduled - ECD TBD', ev: evProp, reject: true, why: 'scheduling/assignment claimed with no evidence' },
  { id: 'operational', line: 'Awaiting client approval - technician is on-site now - ECD TBD', ev: evProp, reject: true, why: 'on-site attendance claimed with no evidence' },
  { id: 'client-contact', line: 'Awaiting client approval - the client was notified today - ECD TBD', ev: evProp, reject: true, why: 'client contact claimed with no evidence' },
  { id: 'blame', line: 'Awaiting client approval - the vendor has been unresponsive - ECD TBD', ev: evProp, reject: true, why: 'fault attributed with no evidence' },
  { id: 'owner', line: 'Awaiting client approval - Supplier to release the order - ECD TBD', ev: evProp, reject: true, why: 'the next move assigned to a party nothing puts on the hook' },
  { id: 'internal-wording', line: 'Awaiting client approval - Umbrava shows no further updates here - ECD TBD', ev: evProp, reject: true, why: 'names the source system' },
  { id: 'internal-wording', line: 'Awaiting client approval - AI could not determine the next step here - ECD TBD', ev: evProp, reject: true, why: 'names the model' },
  { id: 'internal-wording', line: 'Awaiting client approval - low confidence in this reading of the job - ECD TBD', ev: evProp, reject: true, why: 'leaks the internal confidence signal' },
  // ---- the licences: the SAME claims, now carried by the evidence ----
  { id: 'completion', line: 'Work complete - closeout pending - Coordinator to obtain the documentation - ECD TBD', ev: 'Note 1 (9/14): Tech completed the repair and cleared the site.', facts: st(H('Confirm Complete'), [note('Tech completed the repair and cleared the site.', 3)]), reject: false, why: 'control: completion evidenced in a note is allowed' },
  { id: 'approval', line: 'Approved - awaiting PO release - Coordinator to issue the purchase order - ECD TBD', ev: 'Note 1 (9/14): Client approved the proposal this morning.', facts: st(H('Proposal Approved'), [note('Client approved the proposal this morning.', 3)]), reject: false, why: 'control: approval evidenced in a note is allowed' },
  { id: 'financial', line: 'Quote/proposal in preparation - vendor quoted the work - Coordinator to submit the proposal - ECD TBD', ev: 'Note 1 (9/14): Vendor quoted the work at the agreed rate.', facts: st(H('Vendor Proposal Received'), [note('Vendor quoted the work at the agreed rate.', 3)]), reject: false, why: 'control: pricing evidenced in a note is allowed' },
  { id: 'operational', line: 'Scheduled - Vendor to attend the scheduled visit and report the outcome - ECD TBD', ev: 'Note 1 (9/14): Vendor confirmed the visit.', facts: st(H('Scheduled'), [note('Vendor confirmed the visit for next week.', 3)]), reject: false, why: 'control: the live status licenses the scheduling claim' },
  { id: 'client-contact', line: 'Awaiting client response - client response outstanding (Client) - Client to provide direction - ECD TBD', ev: 'Note 1 (9/14): Client was notified of the revised scope and has not replied.', facts: st(H('Client Action Required'), [note('Client was notified of the revised scope and has not replied.', 3)]), reject: false, why: 'control: an evidenced client contact is allowed' },
  { id: 'blame', line: 'Recalled - return visit required - vendor no-show recorded - Vendor to confirm the return date - ECD TBD', ev: 'Note 1 (9/14): Vendor no-show on the booked visit.', facts: st(H('Recall'), [note('Vendor no-show on the booked visit, rebooking needed.', 3)]), reject: false, why: 'control: an evidenced no-show may be reported' }
];
claimCases.forEach(function (c) {
  var f = c.facts || fProp;
  var got = T.validateAiNote(c.line, f, c.ev);
  if (c.reject) A.ok('[' + c.id + '] ' + c.why, !!got, c.line + ' -> ' + (got || '(ACCEPTED)'));
  else A.eq('[' + c.id + '] ' + c.why, got, '');
});
// The gate must not be a blanket refusal: a plain, grounded line still passes.
A.eq('control: a grounded, well-formed line is still ACCEPTED',
  T.validateAiNote('Awaiting client approval - submitted proposal not yet approved (Client) - Client to approve the submitted proposal - ECD TBD', fProp, evProp), '');

console.log('\n3. Negation never reads as a claim (the clause splitter)');
// The house format joins segments with " - " and carries no full stops, so a single "not" used to
// veto every check on the line. Each pair below is the same rule seen from both sides.
A.eq('"not yet approved" is not an approval claim',
  T.woaClaimIssue('Awaiting client approval - submitted proposal not yet approved - Client to approve', fProp, evProp), '');
A.ok('...but "approved" in a clean clause still is',
  !!T.woaClaimIssue('Awaiting client approval - the proposal was approved - Client to proceed', fProp, evProp));
A.eq('"no confirmed on-site date on file" is not an on-site claim',
  T.woaClaimIssue('Vendor scheduling pending - no confirmed on-site date on file - Vendor to confirm a date', st(H('Pending Dispatch'), []), 'Note 1: nothing scheduled yet'), '');
A.ok('...but "technician is on-site" still is',
  !!T.woaClaimIssue('Vendor scheduling pending - technician is on-site - Vendor to report', st(H('Pending Dispatch'), []), 'Note 1: nothing scheduled yet'));

console.log('\n4. Contradicting the live status');
var fClosed = st(H('Closed'), []);
A.ok('open work asserted on a closed work order is REJECTED',
  !!T.validateAiNote('Closed - awaiting vendor parts before the return visit can happen - ECD TBD', fClosed, 'Note 1: nothing outstanding'));
A.eq('control: a closed work order stated as closed is accepted',
  T.validateAiNote('Closed - no further action required on this work order - ECD TBD', fClosed, ''), '');

console.log('\n5. The deterministic fallback passes its own gate');
// The gate must never be so strict that the note the tool falls back to would itself be refused -
// that is the failure mode that would leave a row with nothing usable at all.
var fbBad = [];
Object.keys(T.WOA_PHASE).forEach(function (s) {
  var f = st(H(s), []);
  var n = T.composeAuditStatusNote(f);
  var why = T.validateAiNote(n, f, '');
  if (why) fbBad.push(s + ': ' + why + '  [' + n + ']');
});
A.eq('every stage\'s zero-note fallback note survives validateAiNote', fbBad, []);
// ...and with an ordinary evidenced note in play.
var fbBad2 = [];
Object.keys(T.WOA_PHASE).forEach(function (s) {
  var nts = [note('Vendor confirmed the parts order with the supplier.', 2)];
  var f = st(H(s), nts);
  var n = T.composeAuditStatusNote(f);
  var why = T.validateAiNote(n, f, 'Note 1 (9/15): Vendor confirmed the parts order with the supplier.');
  if (why) fbBad2.push(s + ': ' + why + '  [' + n + ']');
});
A.eq('...and so does the fallback with a real note behind it', fbBad2, []);

console.log('\n6. The timeline chain gets the SAME gate (it is the line that gets POSTED)');
var fTl = st(H('Material Ordered'), [note('Parts on backorder, supplier confirmed the order.', 4)]);
var evTl = '9/13: Parts on backorder, supplier confirmed the order.';
A.ok('an unevidenced completion claim in the chain is REJECTED',
  !!T.validateTimelineChain('parts ordered 9/13 - work complete', fTl, evTl));
A.ok('an unevidenced date in the chain is REJECTED',
  !!T.validateTimelineChain('parts ordered 9/13 - reship 12/24', fTl, evTl));
A.ok('vague filler in the chain is REJECTED',
  !!T.validateTimelineChain('parts ordered 9/13 - being handled', fTl, evTl));
A.ok('internal wording in the chain is REJECTED',
  !!T.validateTimelineChain('parts ordered 9/13 - Umbrava shows no further notes', fTl, evTl));
A.ok('an empty chain is REJECTED', !!T.validateTimelineChain('   ', fTl, evTl));
// negative control: a real, grounded chain passes and is NOT required to carry an ECD (the
// deterministic wrapper owns that end).
A.eq('control: a grounded chain with no ECD passes',
  T.validateTimelineChain('parts ordered 9/13 - supplier confirmed - awaiting delivery', fTl, evTl), '');

console.log('\n7. Over-30 tails are byte-for-byte what production reads (108/108 convention)');
var hTl = { priority: { expectedCompletionDate: '2026-09-25' }, trades: [{ name: 'Service' }] };
A.eq('future ECD tail', T.composeTimelineNote('reorder pending', hTl, NOW), 'Over 30 - Service - reorder pending - ECD 9/25');
A.eq('lapsed ECD tail',
  T.composeTimelineNote('reorder pending', { priority: { expectedCompletionDate: '2026-08-25' }, trades: [{ name: 'Service' }] }, NOW),
  'Over 30 - Service - reorder pending - ECD 8/25 PAST - awaiting new ECD');
A.eq('absent ECD tail',
  T.composeTimelineNote('reorder pending', { priority: null, trades: [{ name: 'Service' }] }, NOW),
  'Over 30 - Service - reorder pending - ECD not set - needs ECD');
// The AI-less path must land on the identical tails.
A.ok('the deterministic over-30 fallback lands on the same tail',
  / - ECD 9\/25$/.test(T.composeTimelineNote(T.fallbackChain(fTl), hTl, NOW)));

console.log('\n8. Dates that are NOT a completion commitment still cannot become an ECD');
var nonEcd = [
  ['appointment', 'Tech appointment held 9/30 with the store.'],
  ['arrival', 'Crew will arrive 9/30 to assess.'],
  ['delivery', 'Parts delivery is 9/30 per the supplier.'],
  ['dispatch', 'Dispatching the vendor 9/30.'],
  ['part ETA', 'Part ETA 9/30 from the manufacturer.'],
  ['schedule', 'Visit scheduled 9/30 with the site contact.'],
  ['ISO delivery', 'Parts delivery is 2026-09-30 per the supplier.'],
  ['month-name delivery', 'Parts delivery is Sept 30 per the supplier.']
];
var becameEcd = [];
nonEcd.forEach(function (row) {
  var f = st(H('Material Ordered'), [note(row[1], 2)]);
  if (f.ecdText !== 'TBD') becameEcd.push(row[0] + ' -> ' + f.ecdText);
});
A.eq('no arrival/delivery/appointment/dispatch/ETA/schedule date becomes an ECD', becameEcd, []);
// positive control: an EXPLICIT completion commitment still supplies one, so the rule is a filter
// and not a blanket refusal.
A.eq('control: an explicit completion commitment still supplies the ECD',
  st(H('Scheduled'), [note('Vendor confirms complete by 9/26.', 1)]).ecdText, '9/26');
A.eq('control: and it is labelled as note-sourced',
  st(H('Scheduled'), [note('Vendor confirms complete by 9/26.', 1)]).ecdSource, 'note.vendorCommitment');

console.log('\n9. This tool\'s own posts: excluded from evidence, still block a duplicate post');
var selfNotes = [
  { content: 'Over 30 - Service - parts ordered 8/2 - ECD 9/30\n\n[bwn:wo-audit]', createdDate: daysAgo(1) },
  { content: 'Vendor confirmed the parts order with the supplier.', createdDate: daysAgo(4) }
];
var mnSelf = T.meaningfulNotes(selfNotes, NOW);
A.eq('the tool\'s own post is dropped from evidence', mnSelf.length, 1);
A.ok('...and the surviving note is the real one', /Vendor confirmed the parts order/.test(mnSelf[0].content));
A.eq('...while idempotency still sees it', T.hasPriorAuditNote(selfNotes), true);
// The laundering path end to end: a date that exists ONLY in the tool's own prior post must not
// ground an AI line, because that post is no longer part of the evidence the model is given.
var evFiltered = mnSelf.map(function (n) { return n.content; }).join('\n');
A.ok('a date carried only by the prior audit note does NOT ground an AI line',
  !!T.ungroundedDates('Materials pending - parts due 9/30 - ECD TBD', evFiltered));
// negative control: with the raw history as the ground text it WOULD have passed - which is
// precisely the hole 0.13.0 closes. This asserts the fix is load-bearing, not cosmetic.
var evRaw = selfNotes.map(function (n) { return n.content; }).join('\n');
A.eq('control: the unfiltered history would have grounded it (the old behaviour)',
  T.ungroundedDates('Materials pending - parts due 9/30 - ECD TBD', evRaw), '');
A.ok('control: a WO with no prior audit note does not block posting',
  T.hasPriorAuditNote([{ content: 'Vendor confirmed the parts order.', createdDate: daysAgo(2) }]) === false);

console.log('\n10. NO VENDOR is a coordinator gap, never vendor fault');
var fNoVendor = st(H('Pending Dispatch', { hasNonTerminatedPurchaseOrders: false, purchaseOrders: [] }), []);
A.eq('the blocker is the missing assignment', fNoVendor.primaryBlocker, 'no vendor assigned yet');
A.eq('...owned by the Coordinator, not the Vendor', fNoVendor.blockerOwner, 'Coordinator');
A.eq('...and the next action is the Coordinator\'s', fNoVendor.nextActionOwner, 'Coordinator');
var nNoVendor = T.composeAuditStatusNote(fNoVendor);
A.ok('the note carries no vendor blame',
  !/vendor (failed|has not|never|unresponsive|at fault|neglect)/i.test(nNoVendor), nNoVendor);
A.ok('...and does not put the next move on the vendor', !/\bVendor to\b/.test(nNoVendor), nNoVendor);
// negative control: with a vendor on the job the coordinator-gap wording is gone.
A.ok('control: a vendor on the job removes the dispatch-gap blocker',
  st(H('Pending Dispatch'), []).primaryBlocker !== 'no vendor assigned yet');

console.log('\n11. Age and silence alone assign nobody');
var fSilent = st(H('Some Unmapped Status', { remainingDays: -180 }), []);
A.eq('180 days overdue with no notes assigns no owner', fSilent.blockerOwner, 'Unknown');
A.eq('...and invents no blocker', fSilent.primaryBlocker, null);
var fStale = st(H('Material Ordered'), [note('Parts on backorder, supplier confirmed.', 60)]);
A.eq('a 60-day-silent job puts the chase on the Coordinator, not the vendor', fStale.nextActionOwner, 'Coordinator');
A.ok('...and the note blames nobody for the silence',
  !/(failed|unresponsive|ignored|neglect|at fault)/i.test(T.composeAuditStatusNote(fStale)), T.composeAuditStatusNote(fStale));

console.log('\n12. Work-order key normalization: refuse, never guess');
var keyCases = [
  { raw: '386564', n: 386564, conf: 'high', why: 'a plain number' },
  { raw: 'W-386564', n: 386564, conf: 'high', why: 'the house W- prefix' },
  { raw: 'W386564', n: 386564, conf: 'high', why: 'the prefix with no dash' },
  { raw: '  386564  ', n: 386564, conf: 'high', why: 'surrounding whitespace' },
  { raw: '#386564', n: 386564, conf: 'high', why: 'a hash prefix' },
  { raw: '386564.0', n: 386564, conf: 'high', why: 'an Excel numeric round-trip' },
  { raw: '386564 (dup)', n: 386564, conf: 'medium', why: 'one number plus stray text -> medium, still read' },
  { raw: '386564-2', n: null, conf: 'low', why: 'THE BUG: a compound key must not become 3865642' },
  { raw: '386564/386565', n: null, conf: 'low', why: 'THE BUG: two numbers must not concatenate' },
  { raw: '386564, 386565', n: null, conf: 'low', why: 'a comma-separated pair is refused too' },
  { raw: '', n: null, conf: 'low', why: 'an empty cell' },
  { raw: 'N/A', n: null, conf: 'low', why: 'a non-numeric cell' }
];
keyCases.forEach(function (c) {
  var k = T.woaNormalizeKey(c.raw);
  A.eq('"' + c.raw + '" - ' + c.why, k.n, c.n);
  A.eq('..."' + c.raw + '" confidence', k.confidence, c.conf);
});
A.ok('a refused compound key explains itself', /more than one number/.test(T.woaNormalizeKey('386564-2').reason));
A.ok('...and says it was not guessed at', /NOT guessed/.test(T.woaNormalizeKey('386564-2').reason));
A.eq('control: a clean key carries no complaint', T.woaNormalizeKey('386564').reason, null);

console.log('\n13. WOA_PHASE coverage: measured, never auto-mapped');
var covRows = [
  { sourceStatusName: 'Scheduled' },
  { sourceStatusName: 'scheduled' },                 // same status, different casing
  { sourceStatusName: ' Material Ordered ' },        // and with stray whitespace
  { sourceStatusName: 'Pending Landlord Approval' }, // not in the table
  { sourceStatusName: 'Pending Landlord Approval' },
  { sourceStatusName: '' },                          // header unread - contributes nothing
  null                                               // a skipped row - contributes nothing
];
var cov = T.statusCoverage(covRows);
A.eq('three distinct statuses observed', cov.observed.length, 3);
A.eq('casing and whitespace collapse for COMPARISON', cov.observed[0].count, 2);
A.eq('...while the RAW name is what is reported', cov.observed[0].status, 'Scheduled');
A.eq('exactly one unmapped status is surfaced', cov.unmapped.length, 1);
A.eq('...named verbatim', cov.unmapped[0].status, 'Pending Landlord Approval');
A.eq('...with its occurrence count', cov.unmapped[0].count, 2);
A.eq('a mapped status is not reported as a gap', cov.observed[0].mapped, 'scheduled');
// negative control: a run that met only known statuses reports no gap at all.
A.eq('control: all-known run reports nothing unmapped',
  T.statusCoverage([{ sourceStatusName: 'Scheduled' }, { sourceStatusName: 'Closed' }]).unmapped.length, 0);
A.eq('control: an empty run does not crash', T.statusCoverage([]).observed.length, 0);
A.eq('control: undefined input does not crash', T.statusCoverage(undefined).observed.length, 0);

console.log('\n14. An unmapped status degrades safely - it is never mapped to a guessed stage');
var fUnmapped = st(H('Pending Landlord Approval'), [note('Landlord has the paperwork.', 2)]);
A.ok('the raw status is printed verbatim', /Pending Landlord Approval/.test(fUnmapped.currentStage), fUnmapped.currentStage);
A.eq('no stage was guessed', fUnmapped.phase, null);
A.eq('confidence is low', fUnmapped.confidence, 'low');
A.eq('no blocker is invented', fUnmapped.primaryBlocker, null);
A.eq('no owner is assigned', fUnmapped.blockerOwner, 'Unknown');
A.ok('the fallback note still ends on an ECD token', / - ECD TBD$/.test(T.composeAuditStatusNote(fUnmapped)));
// Every KNOWN status must still map exactly as it does today - the coverage work must not have
// disturbed the table it measures.
var drift = [];
Object.keys(T.WOA_PHASE).forEach(function (s) {
  var f = st(H(s), []);
  if (f.phase !== T.WOA_PHASE[s]) drift.push(s + ': ' + f.phase + ' != ' + T.WOA_PHASE[s]);
});
A.eq('every known status maps exactly as before', drift, []);
A.eq('the table still carries every status it shipped with', Object.keys(T.WOA_PHASE).length, 55);

console.log('\n15. Post eligibility is still the strict >30 gate');
A.eq('31 days is eligible', T.postEligible(31, false), true);
A.eq('30 days is NOT (strictly greater)', T.postEligible(30, false), false);
A.eq('29 days is not', T.postEligible(29, false), false);
A.eq('no days column -> over-30 by construction', T.postEligible(null, true), true);
A.eq('control: a null age with a days column present is not eligible', T.postEligible(null, false), false);

console.log('\n16. Source-level pins the slice cannot execute');
// These live in buildModal's closure or in the run wiring, so they are asserted on the shipped
// SOURCE. Weaker than execution, and labelled as such - they catch a reversion, not a logic error.
A.ok('the prompts are built from the FILTERED evidence, not the raw history',
  /summarizeTimeline\(woFacts, evidenceNotes, h, model/.test(TEXT) &&
  /summarize\(woFacts, evidenceNotes\.slice\(0, 5\), model/.test(TEXT));
A.ok('...and the raw history is gone from both prompt calls',
  !/summarize\(woFacts, data\.notes/.test(TEXT) && !/summarizeTimeline\(woFacts, data\.notes/.test(TEXT));
A.ok('idempotency still reads the RAW notes', /hasPriorAuditNote\(data\.notes\)/.test(TEXT));
A.ok('the timeline output runs the full gate, not just the date check',
  /validateTimelineChain\(chain, facts, prompt\)/.test(TEXT));
A.ok('a retained row is never written to the sheet',
  /if \(!out\.retained\) \{\n\s*ws\[XLSX\.utils\.encode_cell/.test(TEXT));
A.ok('a retained row is review-required and unchanged',
  /noteMode: out\.retained \? 'retained'/.test(TEXT) && /changed: !out\.retained &&/.test(TEXT));
A.ok('retention fires only on a header miss with NO usable notes',
  /if \(!h && !evidenceNotes\.length\) \{/.test(TEXT));
A.ok('the tally shape is untouched',
  /return \{ ok: ok, errs: errs, skipped: total - ok - errs \};/.test(TEXT));
A.ok('...and nothing else is added to it', !/return \{ ok: ok, errs: errs, skipped: total - ok - errs, /.test(TEXT));
A.ok('the post floor is still internal-only', /WOA_TYPE_FLOOR = \{ internal: 13 \}/.test(TEXT));
A.ok('there is still no bulk post action', !/post all/i.test(TEXT) || /NO bulk/i.test(TEXT));
A.ok('the kill switch is the first posting block shown',
  /function postBlockReason\(r\) \{\n\s*if \(BWN_MODULES\.woAuditNotes === false\)/.test(TEXT));
A.ok('...the permission is the second', /if \(!bwnCan\('WorkOrderNote\.AddNew'\)\) return/.test(TEXT));
A.ok('...and the >30 gate and the idempotency marker are still both in it',
  /if \(!r\.eligible\) return 'not aged over 30 days';/.test(TEXT) &&
  /if \(r\.priorAudit\) return 'this work order already carries a ' \+ AUDIT_MARKER/.test(TEXT));
A.ok('the post button is display-gated on the same reason',
  /r\.postIneligibleReason = block;/.test(TEXT) && /\} else if \(block\) \{/.test(TEXT));
// Every worksheet write is either a Notes/Audit Flags DATA cell or the header cell of a column
// this tool appended. A third kind of write would break the workbook contract.
var writes = TEXT.match(/ws\[XLSX\.utils\.encode_cell\([^\]]+\]/g) || [];
var strayWrites = writes.filter(function (w) {
  return !/c: session\.map\.(note|flag)/.test(w) && !/c: col, r: map\.headerRow/.test(w);
});
A.eq('only Notes/Audit Flags cells and appended headers are written', strayWrites, []);
A.ok('control: the scan actually sees the writes', writes.length >= 4, writes.length);
A.ok('the SheetJS fidelity limit is stated to the operator',
  /charts, conditional formatting, or validation rules, may not be retained/.test(TEXT));
A.ok('per-row diagnostics do NOT go into the shared bwn:audit trail',
  /deliberately do NOT go into the shared bwn:audit/.test(TEXT));
A.ok('the unmapped-status diagnostic is rendered and copyable',
  /function renderDiagnostics\(\)/.test(TEXT) && /Copy diagnostics/.test(TEXT));
A.ok('a degraded row is still surfaced to the operator',
  /fell back to the deterministic audit note/.test(TEXT));
A.ok('a retained row is surfaced too', /KEPT the workbook..s existing note/.test(TEXT));
A.ok('the version was bumped (an unbumped push reaches nobody)', /@version\s+0\.15\.0/.test(TEXT));

// ---------------------------------------------------------------------------------------------
console.log('\n17. Quoted-email furniture never reaches a client-facing note (D3)');
// Every fixture below is taken from the shipped 09/18 workbook, where 64 of 282 notes carried
// pasted email furniture and 32 carried live email addresses - client, vendor, internal and
// app@umbrava.com - in a column that goes to the client.
var S = T.woaStripQuotedEmail;

console.log('  a) the boundaries');
A.eq('"-----Original Message-----" cuts the thread',
  S('9/18 req service from PAC -----Original Message----- From: Erick Nieves-Cruz Sent: Friday'),
  '9/18 req service from PAC');
A.eq('a bare "From:" header cuts the thread',
  S('9/16 vendor to return Monday From: Aleisha Bryant Sent: Wednesday, September 16, 2026 10:50 AM'),
  '9/16 vendor to return Monday');
A.eq('a dash-prefixed "-From:" cuts it too (the measured W-324535 shape)',
  S('9/17 Email attempted to be sent: -Type: Purchase Order (W-324535) -From: rsharp@broadwaynational.com -To: amir@sb-signs.com'),
  '9/17 Email attempted to be sent: -Type: Purchase Order (W-324535)');
A.eq('a "Sent:" header with no From: is a boundary as well',
  S('Parts confirmed. Sent: Thursday, September 17, 2026 11:59 AM'), 'Parts confirmed.');

console.log('  b) ordinary prose is NOT a boundary');
var prose = [
  'Awaiting update from vendor.',
  'Received findings from technician.',
  'Parts are expected from the supplier.',
  'Escalated from site after the second visit.',
  'Email attempted to be sent: no reply yet from the vendor.'
];
var cut = prose.filter(function (p) { return S(p) !== p; });
A.eq('no ordinary "from"/"sent" prose is truncated', cut, []);
A.ok('control: the same words WITH a header colon are cut',
  S('Awaiting update. From: Bob Smith') === 'Awaiting update.');

console.log('  c) addresses are removed, not marked');
A.eq('a bare address is removed',
  S('Vendor contact is service@heritageelectrical.com for scheduling'),
  'Vendor contact is for scheduling');
A.eq('an angle-bracketed address leaves no empty pair',
  S('Spoke with Matthew Zozimo <MZozimo@broadwaynational.com> about the quote'),
  'Spoke with Matthew Zozimo about the quote');
A.ok('no "[email]" placeholder ever reaches the text',
  S('ping penny@clesales.com and tonia.paz@pilottravelcenters.com').indexOf('[email]') === -1);
// The four address families that actually shipped.
['aleisha.bryant@pilottravelcenters.com', 'service@summitstatemechanical.com',
  'MZozimo@broadwaynational.com', 'app@umbrava.com'].forEach(function (a) {
    A.ok('address removed: ' + a, S('note mentioning ' + a + ' inline').indexOf('@') === -1);
  });

console.log('  d) defensive input handling');
A.eq('null', S(null), '');
A.eq('undefined', S(undefined), '');
A.eq('a number', S(12345), '12345');
A.eq('an object does not throw', typeof S({}), 'string');
A.eq('an all-thread note sanitizes to nothing', S('From: a@b.com Sent: Monday To: c@d.com'), '');
A.ok('a long hyphen run alone is NOT a marker', S('cost split 50/50 ---- pending sign-off').length > 20);

console.log('  e) the deterministic pipeline end to end');
var emailNote = note('9/16 vendor to return Monday From: Aleisha Bryant <aleisha.bryant@pilottravelcenters.com> Sent: Wednesday, September 16, 2026 10:50 AM To: Erick Nieves-Cruz Subject: RE: dryer', 2);
var fMail = st(H('Material Ordered'), [emailNote]);
var nMail = T.composeAuditStatusNote(fMail);
A.ok('the composed note carries the real event', /9\/16 vendor to return Monday/.test(nMail), nMail);
A.ok('...and no address', nMail.indexOf('@') === -1, nMail);
A.ok('...and no header furniture', !/From:|Sent:|To:|Subject:/.test(nMail), nMail);
A.ok('...and still ends on the ECD token', / - ECD TBD$/.test(nMail), nMail);
// An email header date must not become source evidence, and above all not an ECD.
A.eq('a "Sent:" header date supplies no ECD', fMail.ecdText, 'TBD');
A.eq('...and no date token survives from the header',
  T.woaGroundTokens(fMail.latestMeaningfulEvent).indexOf('9/16') !== -1 &&
  T.woaGroundTokens(fMail.latestMeaningfulEvent).length, 1);
// Quoted email BODY filler must not ride into the note just because it was pasted.
var fFiller = st(H('Material Ordered'), [note('9/17 awaiting fabrication date From: Tahir Diwan Sent: Wednesday STILL WORKING ON IT the designer will provide ETA asap', 2)]);
var nFiller = T.composeAuditStatusNote(fFiller);
A.ok('quoted-body filler does not reach the note', !/STILL WORKING ON IT|provide ETA asap/i.test(nFiller), nFiller);
A.ok('...while the real pre-boundary event is kept', /awaiting fabrication date/.test(nFiller), nFiller);

console.log('  f) a note that is ONLY a thread reads as no evidence');
var onlyThread = [{ content: '-----Original Message----- From: a@b.com Sent: Monday To: c@d.com Subject: RE: WO', createdDate: daysAgo(2) }];
A.eq('it is dropped from the evidence set', T.meaningfulNotes(onlyThread, NOW).length, 0);
var fEmpty = st(H('Material Ordered'), onlyThread);
A.eq('...so the state layer reports no usable notes', fEmpty.noteCount, 0);
A.ok('...and the note says so honestly rather than inventing progress',
  /no documented update available/.test(T.composeAuditStatusNote(fEmpty)), T.composeAuditStatusNote(fEmpty));
A.eq('...and invents no ECD', fEmpty.ecdText, 'TBD');
// The blocker it DOES carry comes from the live status, not from the thread - which is the point:
// the header still speaks, the pasted email does not.
A.eq('the blocker is the header-derived one', fEmpty.primaryBlocker, 'parts/materials not yet delivered');
A.eq('...and no note-derived refinement was applied',
  st(H('Material Ordered'), [{ content: '-----Original Message----- backordered per the supplier thread', createdDate: daysAgo(2) }], NOW).primaryBlocker,
  'parts/materials not yet delivered');
A.eq('control: a REAL note still refines it',
  st(H('Material Ordered'), [note('Parts are on backorder, supplier confirmed.', 2)]).primaryBlocker,
  'parts on backorder');

console.log('  g) the marker exclusion still wins over sanitization');
// The [bwn:wo-audit] marker sits at the END of a posted note. If sanitization ran first it could
// cut the marker off and this tool would stop recognizing its own post - reopening the hole.
var ourPost = [{ content: 'Over 30 - Service - parts ordered 8/2 - ECD 9/30\n\nFrom: someone\n\n[bwn:wo-audit]', createdDate: daysAgo(1) }];
A.eq('our own post is still excluded from evidence even when it contains a From: line',
  T.meaningfulNotes(ourPost, NOW).length, 0);
A.eq('...and idempotency still sees it', T.hasPriorAuditNote(ourPost), true);

console.log('  h) sanitization is idempotent (it is applied at three points)');
var dirty = '9/17 update pending From: Bob <bob@x.com> Sent: Monday';
A.eq('strip(strip(x)) === strip(x)', S(S(dirty)), S(dirty));

A.finish();
