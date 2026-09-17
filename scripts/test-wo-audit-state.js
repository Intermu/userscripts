// test-wo-audit-state.js - node harness for the normalized operational-state layer (0.12.0).
//
// Slices the PURE `BWN WO-AUDIT STATE` block out of the .user.js and runs the real shipped bytes,
// concatenated with the `BWN WO-AUDIT TIMELINE` block it depends on (fmtMD / ecdInfo), plus the
// small externals both need (MS_DAY, _date, auditCfg, STALE_DAYS). Two slices because the ECD and
// date helpers deliberately live with the timeline note they were written for and are REUSED here
// rather than reimplemented - a second ECD reader would silently defeat test-wo-audit-timeline.js.
//
// The clock is INJECTED on every call (never Date.now()), so stage/staleness/ECD-expiry assertions
// are exact on any machine ([[fixture-clock-time-day-age]] / [[headless-harness-cannot-time]]).
//
// Every rule carries a NEGATIVE control: a rule that fires unconditionally is the failure mode
// these harnesses exist to catch.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-state.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');

function slice(t, startMark, endMark) {
  var a = t.indexOf(startMark);
  var b = t.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error(startMark + ' / ' + endMark + ' markers not found in ' + SRC);
  if (t.indexOf(startMark, a + 1) !== -1) throw new Error('non-unique marker: ' + startMark);
  return t.slice(a, b);
}
var TEXT = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
var SECTION = slice(TEXT, '// ===== BWN WO-AUDIT TIMELINE START', '// ===== BWN WO-AUDIT TIMELINE END') +
  '\n' + slice(TEXT, '// ===== BWN WO-AUDIT STATE START', '// ===== BWN WO-AUDIT STATE END');

var MS_DAY = 86400000;
function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
// The node harness has no localStorage, so the shipped auditCfg's catch-branch default is what
// runs in the app for a user with no override. Mirror it rather than stubbing new thresholds in.
function auditCfg(key, def) { return def; }
var STALE_DAYS = 7;

var T = (new Function('MS_DAY', '_date', 'auditCfg', 'STALE_DAYS',
  SECTION + '\n;return { deriveState: deriveState, composeAuditStatusNote: composeAuditStatusNote,' +
  ' validateAiNote: validateAiNote, meaningfulNotes: meaningfulNotes, woaAffirm: woaAffirm,' +
  ' woaDateTokens: woaDateTokens, woaDropHyphenRanges: woaDropHyphenRanges,' +
  ' composeTimelineNote: composeTimelineNote, fallbackChain: fallbackChain, ungroundedDates: ungroundedDates, WOA_PHASE: WOA_PHASE };'
))(MS_DAY, _date, auditCfg, STALE_DAYS);

// Fixed clock: 2026-09-17 local noon.
var NOW = +new Date(2026, 8, 17, 12, 0, 0);
function daysAgo(d) { return new Date(NOW - d * MS_DAY).toISOString(); }
function note(body, ageDays, extra) {
  var n = { content: body, createdDate: daysAgo(ageDays) };
  for (var k in (extra || {})) n[k] = extra[k];
  return n;
}
// A header with the given status; everything else benign unless overridden.
function H(status, over) {
  var h = {
    statusName: status, phase: 'Open', remainingDays: 5, nextOnsiteDate: null,
    priority: { label: 'P3', expectedCompletionDate: null },
    doNotExceed: { amount: 100000, precision: 2 }, totalNTE: { amount: 50000, precision: 2 },
    grossProfitInfo: { estimatedGrossProfitPercent: '0.5' },
    hasNonTerminatedPurchaseOrders: true, purchaseOrders: [{ id: 1 }], trades: [{ name: 'Electrical' }]
  };
  for (var k in (over || {})) h[k] = over[k];
  return h;
}
function st(h, notes) { return T.deriveState(h, notes, NOW); }
function endsEcd(s) { return / - ECD (\d{1,2}\/\d{1,2}|TBD)$/.test(s); }

console.log('WO Audit normalized operational state (0.12.0) - ' + path.basename(SRC));

// ---------------------------------------------------------------------------
console.log('\n1. Required scenario: client approval delay');
var f1 = st(H('Proposed'), [note('Proposal submitted to the client for approval, quote attached.', 3)]);
A.eq('stage = awaiting client approval', f1.currentStage, 'Awaiting client approval');
A.eq('owner = Client', f1.blockerOwner, 'Client');
A.eq('blocker named', f1.primaryBlocker, 'submitted proposal not yet approved');
A.ok('next action names the client and the artifact', /Client to approve the submitted proposal/.test(f1.nextAction), f1.nextAction);
A.eq('no ECD is invented for an approval gate', f1.ecdText, 'TBD');
A.eq('ecdSource says none', f1.ecdSource, 'none');
A.ok('note ends with the ECD clause', endsEcd(T.composeAuditStatusNote(f1)), T.composeAuditStatusNote(f1));
// negative control: a different status must NOT produce the client-approval reading.
A.ok('control: Scheduled is not awaiting-client', st(H('Scheduled'), []).currentStage !== 'Awaiting client approval');

console.log('\n2. Required scenario: vendor scheduling delay (accepted, no date)');
var f2 = st(H('Pending Dispatch', { nextOnsiteDate: null }), [note('Vendor accepted the assignment, working on a date.', 2)]);
A.eq('stage = vendor scheduling pending', f2.currentStage, 'Vendor scheduling pending');
A.eq('owner = Vendor', f2.blockerOwner, 'Vendor');
A.ok('next action = vendor confirms appointment', /Vendor to confirm an on-site date/.test(f2.nextAction), f2.nextAction);
A.eq('ECD TBD with no committed date', f2.ecdText, 'TBD');
// negative control: with NO vendor on the job the gap is internal, never the vendor's.
var f2b = st(H('Pending Dispatch', { hasNonTerminatedPurchaseOrders: false, purchaseOrders: [] }), []);
A.eq('control: no vendor -> Coordinator owns it, not Vendor', f2b.blockerOwner, 'Coordinator');
A.eq('control: blocker says no vendor assigned', f2b.primaryBlocker, 'no vendor assigned yet');

console.log('\n3. Required scenario: materials delay');
var f3 = st(H('Material Ordered', { priority: { expectedCompletionDate: '2026-10-02' } }),
  [note('Parts are on backorder, supplier lead time quoted through 9/29.', 4)]);
A.eq('stage = materials pending', f3.currentStage, 'Materials pending');
A.eq('owner = Materials', f3.blockerOwner, 'Materials');
A.eq('backorder refines the blocker', f3.primaryBlocker, 'parts on backorder');
A.ok('next action = return visit after receipt', /schedule the return visit on receipt/.test(f3.nextAction), f3.nextAction);
A.eq('ECD comes from the WO field, NOT the 9/29 delivery date', f3.ecdText, '10/2');
A.eq('ecdSource = the WO field', f3.ecdSource, 'wo.expectedCompletionDate');
// negative control: a NEGATED backorder clause must not set the backorder blocker.
var f3b = st(H('Material Ordered'), [note('Parts are not on backorder, they ship this week.', 4)]);
A.ok('control: negated backorder does not set the backorder blocker', f3b.primaryBlocker !== 'parts on backorder', f3b.primaryBlocker);
// negative control: client-supplied materials flip the owner to Client, not Materials.
A.eq('control: client-supplied materials -> Client', st(H('Pending Materials Client'), []).blockerOwner, 'Client');

console.log('\n4. Required scenario: internal PO / NTE approval delay');
var f4 = st(H('Proposal Approved'), [note('Client approved the proposal 9/14, PO not yet cut.', 2)]);
A.eq('stage = approved, awaiting PO release', f4.currentStage, 'Approved - awaiting PO release');
A.eq('owner = PO/Approval', f4.blockerOwner, 'PO/Approval');
A.ok('next action = issue the PO and release the vendor', /issue the purchase order and release the vendor/.test(f4.nextAction), f4.nextAction);
// NTE refinement on a hold, only when the note actually says so.
var f4b = st(H('On Hold'), [note('Submitted an NTE increase for the added scope.', 1)]);
A.eq('NTE note on a hold -> PO/Approval', f4b.blockerOwner, 'PO/Approval');
A.ok('NTE next action names the authorization', /NTE increase required before further work is authorized/.test(f4b.nextAction), f4b.nextAction);
// negative control: a plain hold with no NTE note stays Coordinator-owned.
A.eq('control: plain hold -> Coordinator', st(H('On Hold'), [note('Placed on hold at the store request.', 1)]).blockerOwner, 'Coordinator');

console.log('\n5. Required scenario: access delay');
var f5 = st(H('Scheduled', { nextOnsiteDate: '2026-09-14' }), [note('Tech could not get access, the site was closed on arrival.', 3)]);
A.eq('access refines the blocker', f5.primaryBlocker, 'site access/appointment window not confirmed');
A.eq('owner = Scheduling/Access, NOT Client', f5.blockerOwner, 'Scheduling/Access');
A.ok('next action = confirm access window before rebooking', /Site access window and site contact to be confirmed/.test(f5.nextAction), f5.nextAction);
// negative control: access wording does NOT invent a client fault.
A.ok('control: access delay never assigns Client', f5.blockerOwner !== 'Client');
// negative control: a negated access clause is not an access blocker.
var f5b = st(H('Scheduled', { nextOnsiteDate: '2026-09-14' }), [note('No access issues, tech got in fine.', 3)]);
A.ok('control: negated access clause does not set the access blocker', f5b.primaryBlocker !== 'site access/appointment window not confirmed', String(f5b.primaryBlocker));

console.log('\n6. Required scenario: completion / closeout delay');
var f6 = st(H('Confirm Complete'), [note('Vendor reports the work is finished, ticket signed on site.', 2, { isCompletion: true })]);
A.eq('stage = work complete, closeout pending', f6.currentStage, 'Work complete - closeout pending');
A.eq('blocker = documentation outstanding', f6.primaryBlocker, 'completion documentation outstanding');
A.ok('next action = obtain documentation and close', /obtain the completion documentation and close the work order/.test(f6.nextAction), f6.nextAction);
A.ok('does NOT read as plainly "complete"', f6.currentStage.indexOf('closeout pending') !== -1);
// cost-review is a DIFFERENT closeout stage, not the same one.
A.eq('control: clocked out complete -> cost review', st(H('Clocked Out: Complete'), []).currentStage, 'Work complete - final cost review pending');
// negative control: a terminal status carries no chase action.
var f6t = st(H('Closed'), []);
A.eq('control: terminal stage', f6t.currentStage, 'Closed');
A.eq('control: terminal has no invented blocker', f6t.primaryBlocker, null);

console.log('\n7. Required scenario: stale WO');
var f7 = st(H('Scheduled', { nextOnsiteDate: '2026-08-20' }), [note('Scheduled for next week, vendor confirmed.', 49)]);
A.eq('staleDays measured on the injected clock', f7.staleDays, 49);
A.ok('confidence demoted by staleness', f7.confidence !== 'high', f7.confidence);
var n7 = T.composeAuditStatusNote(f7);
A.ok('note states the update gap', /no meaningful update in 49d/.test(n7), n7);
A.ok('note supplies a safe status-chase action', /obtain a current status from the assigned party/.test(n7), n7);
A.ok('note still ends in an ECD clause', endsEcd(n7), n7);
// negative control: a FRESH note on the same header does not trip the stale wording.
var n7b = T.composeAuditStatusNote(st(H('Scheduled', { nextOnsiteDate: '2026-09-20' }), [note('Scheduled, vendor confirmed.', 1)]));
A.ok('control: a fresh note does not report a stale gap', !/no meaningful update in/.test(n7b), n7b);

console.log('\n8. Required scenario: ambiguous / sparse notes');
var f8 = st(H('Some Custom Client Status'), []);
A.ok('unmapped status is quoted verbatim, not guessed', /Some Custom Client Status/.test(f8.currentStage), f8.currentStage);
A.eq('no owner invented', f8.blockerOwner, 'Unknown');
A.eq('no blocker invented', f8.primaryBlocker, null);
A.eq('no ECD invented', f8.ecdText, 'TBD');
A.eq('confidence low', f8.confidence, 'low');
var n8 = T.composeAuditStatusNote(f8);
A.ok('note admits the absence of updates', /no documented update available/.test(n8), n8);
A.ok('low confidence SHORTENS: no owner parenthetical', !/\((Client|Vendor|Coordinator|Materials)\)/.test(n8), n8);
A.ok('still ends in ECD TBD', / - ECD TBD$/.test(n8), n8);
// A mapped status with a low-confidence read must still drop the blocker rather than hedge it.
var f8b = st(H('Proposed'), []);
A.ok('control: mapped status with no notes keeps its stage', f8b.currentStage === 'Awaiting client approval');

console.log('\n9. Required scenario: AI failure -> deterministic note is usable');
// The row worker substitutes composeAuditStatusNote(facts) on any summarize rejection; assert the
// fallback is a real operational note, not a stub, for every stage the table can produce.
var stages = Object.keys(T.WOA_PHASE).map(function (k) { return k; });
var bad = [];
for (var i = 0; i < stages.length; i++) {
  var fx = st(H(stages[i]), [note('Vendor advised they are still working the issue on site.', 2)]);
  var nx = T.composeAuditStatusNote(fx);
  if (!endsEcd(nx)) bad.push(stages[i] + ' -> ' + nx);
  if (!fx.currentStage) bad.push(stages[i] + ' -> no stage');
}
A.eq('every mapped status yields a note ending in an ECD clause', bad, []);
A.ok('fallback never emits ECD undefined/null/Invalid Date',
  !/ECD\s*(undefined|null|NaN|Invalid)/i.test(stages.map(function (s) { return T.composeAuditStatusNote(st(H(s), [])); }).join('\n')));
// A null header (read failed) must say so rather than fabricate a clean bill of health.
var fNull = st(null, []);
A.eq('null header -> says the header is unavailable', fNull.currentStage, 'Live work-order header unavailable');
A.ok('null header still ends in ECD TBD', / - ECD TBD$/.test(T.composeAuditStatusNote(fNull)));
A.eq('null header records absence evidence', fNull.evidence[0].kind, 'absence');

console.log('\n10. Required scenario: over-30 timeline note is unchanged');
// The deterministic wrapper is the SAME shipped function; this pins that the state layer did not
// alter it. (Full tail coverage lives in test-wo-audit-timeline.js - this is the anti-drift check.)
A.eq('over-30 prefix + clean ECD tail intact',
  T.composeTimelineNote('received 8/13 - install pending', { priority: { expectedCompletionDate: '2026-09-20' }, trades: [{ name: 'Service' }] }, NOW),
  'Over 30 - Service - received 8/13 - install pending - ECD 9/20');
A.eq('over-30 PAST tail intact (the established 44-occurrence production form)',
  T.composeTimelineNote('reorder pending', { priority: { expectedCompletionDate: '2026-08-25' }, trades: [{ name: 'Service' }] }, NOW),
  'Over 30 - Service - reorder pending - ECD 8/25 PAST - awaiting new ECD');
A.eq('over-30 needs-ECD tail intact',
  T.composeTimelineNote('reorder pending', { priority: null, trades: [{ name: 'Service' }] }, NOW),
  'Over 30 - Service - reorder pending - ECD not set - needs ECD');

// ---------------------------------------------------------------------------
console.log('\n11. ECD derivation: only two sources may ever produce one');
A.eq('future WO ECD is used', st(H('Scheduled', { priority: { expectedCompletionDate: '2026-09-25' } }), []).ecdText, '9/25');
var fExp = st(H('Scheduled', { priority: { expectedCompletionDate: '2026-09-01' } }), []);
A.eq('lapsed WO ECD -> TBD, never a stale forward promise', fExp.ecdText, 'TBD');
A.eq('lapsed is labelled in ecdSource', fExp.ecdSource, 'wo.expectedCompletionDate.expired');
A.ok('lapse and the owed reset are still stated', /prior ECD 9\/1 lapsed/.test(T.composeAuditStatusNote(fExp)), T.composeAuditStatusNote(fExp));
A.ok('lapsed note still ENDS on the ECD token', / - ECD TBD$/.test(T.composeAuditStatusNote(fExp)));
// A note that commits to a COMPLETION date may supply one.
var fCommit = st(H('Scheduled'), [note('Vendor confirms complete by 9/26.', 1)]);
A.eq('completion commitment in a note supplies the ECD', fCommit.ecdText, '9/26');
A.eq('and is labelled as note-sourced', fCommit.ecdSource, 'note.vendorCommitment');
// negative control: an ARRIVAL/DELIVERY date is NOT a completion date.
var fArr = st(H('Scheduled', { nextOnsiteDate: '2026-09-22' }), [note('Parts arrive 9/30, tech on site 9/22.', 1)]);
A.eq('control: arrival/delivery dates never become the ECD', fArr.ecdText, 'TBD');
// negative control: the measured hyphen-range trap (W-386564: "1-5" once produced 2027-01-05).
A.ok('control: a hyphenated range is stripped before any date parse',
  T.woaDropHyphenRanges('need 1-5 units').indexOf('1-5') === -1, T.woaDropHyphenRanges('need 1-5 units'));
A.ok('control: an ISO date survives the range strip',
  T.woaDropHyphenRanges('due 2026-09-03').indexOf('2026-09-03') !== -1);
var fRange = st(H('Scheduled'), [note('Completion by end of week, need 1-5 replacement units.', 1)]);
A.ok('control: "1-5" does not become a January ECD', fRange.ecdText !== '1/5', fRange.ecdText);

console.log('\n12. Meaningful-note filter');
var mn = T.meaningfulNotes([
  note('Vendor confirmed the appointment for next Tuesday.', 1),
  note('ok', 2),
  note('Status update drafted.\n\n[bwn:wo-audit]', 3),
  note('This note is dated in the future relative to the audit clock.', -5)
], NOW);
A.eq('keeps only the real operational note', mn.length, 1);
A.ok('kept the right one', /Vendor confirmed the appointment/.test(mn[0].content), mn[0].content);
// negative control: the filter is not simply dropping everything.
A.eq('control: two real notes both survive', T.meaningfulNotes([note('Vendor confirmed the appointment.', 1), note('Client approved the revised scope.', 2)], NOW).length, 2);
// A WO whose ONLY note is this tool's own prior post must read as having no usable evidence -
// reading yesterday's draft back as today's fact would launder a guess into a fact.
var fSelf = st(H('Some Unmapped Status'), [note('Awaiting client approval - ECD TBD\n\n[bwn:wo-audit]', 2)]);
A.eq('own prior audit note is not usable evidence', fSelf.noteCount, 0);
A.ok('and the note says so honestly', /no documented update available/.test(T.composeAuditStatusNote(fSelf)), T.composeAuditStatusNote(fSelf));

console.log('\n13. Strict AI output validation');
var fv = st(H('Proposed'), [note('Proposal submitted to the client 9/14 for approval.', 3)]);
var ground = 'Note 1 (9/14): Proposal submitted to the client 9/14 for approval.';
A.eq('a grounded, well-formed line is ACCEPTED',
  T.validateAiNote('Awaiting client approval - submitted proposal not yet approved (Client) - 9/14: proposal submitted - Client to approve - ECD TBD', fv, ground), '');
A.ok('empty output rejected', !!T.validateAiNote('', fv, ground));
A.ok('missing ECD clause rejected', !!T.validateAiNote('Awaiting client approval on the submitted proposal, client must respond.', fv, ground));
A.ok('vague filler rejected', !!T.validateAiNote('Awaiting client approval - being handled by the team - ECD TBD', fv, ground));
A.ok('too-short output rejected', !!T.validateAiNote('Pending - ECD TBD', fv, ground));
// The real hallucination gate: a date nobody wrote.
var invented = T.validateAiNote('Awaiting client approval - client to respond by 11/30 - ECD TBD', fv, ground);
A.ok('an invented date is rejected', !!invented, invented);
A.ok('...and the reason names the offending date', /11\/30/.test(invented), invented);
// negative control: a date that IS in the evidence passes.
A.eq('control: a date present in the evidence is allowed',
  T.validateAiNote('Awaiting client approval - 9/14: proposal submitted to the client - Client to approve the proposal - ECD TBD', fv, ground), '');
// negative control: the ECD token itself is always allowed.
var fv2 = st(H('Scheduled', { priority: { expectedCompletionDate: '2026-09-25' } }), []);
A.eq('control: the derived ECD date is allowed in the line',
  T.validateAiNote('Scheduled - Vendor to attend the visit and report the outcome - ECD 9/25', fv2, ''), '');

console.log('\n14. Anti-rules: age and absence never assign blame');
// A very old WO with no notes must not acquire an owner.
var fOld = st(H('Some Unmapped Status', { remainingDays: -200 }), []);
A.eq('200 days overdue assigns no owner', fOld.blockerOwner, 'Unknown');
A.eq('...and invents no blocker', fOld.primaryBlocker, null);
var nOld = T.composeAuditStatusNote(fOld);
A.ok('no blame language in the fallback note', !/(failed|unresponsive|neglect|ignored|delayed by)/i.test(nOld), nOld);
// No path may emit a compound owner.
var owners = ['Coordinator', 'Client', 'Vendor', 'Materials', 'PO/Approval', 'Scheduling/Access', 'Unknown'];
var badOwner = [];
Object.keys(T.WOA_PHASE).forEach(function (s) {
  var o = st(H(s), [note('Vendor advised the parts are on backorder.', 2)]).blockerOwner;
  if (owners.indexOf(o) === -1) badOwner.push(s + ' -> ' + o);
});
A.eq('every stage emits exactly one label from the fixed owner set', badOwner, []);

console.log('\n15. Separator + house style');
var styleNote = T.composeAuditStatusNote(st(H('Material Ordered'), [note('Parts on backorder, supplier confirmed.', 2)]));
A.ok('segments joined by " - " (hyphen, not em dash)', styleNote.indexOf(' - ') !== -1, styleNote);
A.ok('no em dash anywhere in the composed note', styleNote.indexOf('—') === -1, styleNote);
A.ok('no empty " -  - " runs from omitted clauses', styleNote.indexOf(' -  - ') === -1, styleNote);
// negative control: the source file itself carries no em dash in the new block.
A.ok('control: the STATE block ships no em dash', SECTION.indexOf('—') === -1);

// ---------------------------------------------------------------------------
// The blocks below were added after an adversarial review found four defects that the first pass
// of this harness did not catch. Each one pins the FIXED behaviour and carries the exact input that
// failed before the fix, so a regression re-opens the same hole loudly.

console.log('\n16. The ECD strip must not eat the timeline (B2 regression)');
// An over-30 chain routinely NAMES a lapsed ECD mid-history. A greedy /- ECD[\s\S]*$/ strip deleted
// every segment after the first such mention - three of four dated events, the richest part of the
// note, silently gone. This pins the anchored strip.
var STRIP = /\s*-\s*ECD\s+(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|TBD|not set)\b[^-]*$/i;
A.eq('a mid-chain ECD mention is PRESERVED in full',
  'received 7/1 - ECD 8/15 committed - 8/20 vendor no-show - 9/2 awaiting reschedule'.replace(STRIP, '').trim(),
  'received 7/1 - ECD 8/15 committed - 8/20 vendor no-show - 9/2 awaiting reschedule');
A.eq('a genuinely ECHOED trailing ECD is still stripped',
  'received 7/1 - 8/20 no-show - ECD 9/30'.replace(STRIP, '').trim(), 'received 7/1 - 8/20 no-show');
A.eq('a trailing "ECD TBD" echo is stripped too',
  'parts ordered 8/2 - ECD TBD'.replace(STRIP, '').trim(), 'parts ordered 8/2');
// negative control: the strip is targeted - an ordinary chain is untouched.
A.eq('control: a chain with no ECD token is left alone',
  'received 7/1 - installed 8/3'.replace(STRIP, '').trim(), 'received 7/1 - installed 8/3');
A.ok('control: the SHIPPED regex is the anchored one, not a greedy strip',
  /ECD\\s\+\(\?:/.test(TEXT.replace(/\\/g, '\\')) || TEXT.indexOf("ECD\\s+(?:\\d{1,2}\\/\\d{1,2}") !== -1,
  'the greedy [\\s\\S]*$ form must not return');
A.ok('control: the greedy strip form is gone from the source',
  TEXT.indexOf("/\\s*-\\s*ECD\\b[\\s\\S]*$/i") === -1);

console.log('\n17. The printed ECD must be the DERIVED ECD (B3)');
// The generic "is this date in the evidence" check is not enough: a parts-delivery or appointment
// date IS in the evidence, so the model could lift it and print it as a completion commitment.
var fB3 = st(H('Material Ordered'), [note('Parts are on backorder; supplier says they arrive 9/30. Tech appointment held 9/22.', 2)]);
var groundB3 = 'Note 1 (9/15): Parts are on backorder; supplier says they arrive 9/30. Tech appointment held 9/22.';
A.eq('derived ECD is TBD for this fixture', fB3.ecdText, 'TBD');
var lifted = T.validateAiNote('Materials pending - parts on backorder (Materials) - Vendor to confirm delivery and rebook - ECD 9/30', fB3, groundB3);
A.ok('a delivery date printed as the ECD is REJECTED', !!lifted, lifted);
A.ok('...and the reason names the substitution', /9\/30/.test(lifted) && /derived facts did not supply/.test(lifted), lifted);
A.ok('an appointment date printed as the ECD is REJECTED',
  !!T.validateAiNote('Materials pending - parts on backorder (Materials) - Vendor to rebook the visit - ECD 9/22', fB3, groundB3));
// negative control: the CORRECT ECD passes, so the rule is a pin and not a blanket refusal.
A.eq('control: the derived ECD TBD is accepted',
  T.validateAiNote('Materials pending - parts on backorder (Materials) - Vendor to confirm the delivery date - ECD TBD', fB3, groundB3), '');
var fB3b = st(H('Scheduled', { priority: { expectedCompletionDate: '2026-09-25' } }), []);
A.eq('control: a real derived date is accepted when printed exactly',
  T.validateAiNote('Scheduled - Vendor to attend the visit and report the outcome - ECD 9/25', fB3b, ''), '');
A.ok('control: a DIFFERENT date is rejected even when a derived ECD exists',
  !!T.validateAiNote('Scheduled - Vendor to attend the visit and report the outcome - ECD 9/26', fB3b, 'note mentions 9/26'));

console.log('\n18. Access vocabulary must not fire on ordinary notes (B4)');
// Every line below is a note where the job is going RIGHT, or where "access" is the TRADE rather
// than a problem. All five used to produce "site access not confirmed (Scheduling/Access)".
var benign = [
  'Replaced the badge reader at the main entrance, unit tested OK.',
  'Site contact is Bob Smith 555-1234, tech has the number.',
  'Access window confirmed for Monday 8-4.',
  'Escort required per store policy - handled, no delay.',
  'Badge access granted by the store manager without issue.',
  'No access issues, tech got in fine.',
  'Locked in pricing with the supplier for the panel.'
];
var wrong = [];
benign.forEach(function (b) {
  var fb = st(H('Scheduled', { nextOnsiteDate: '2026-09-20' }), [note(b, 2)]);
  if (fb.primaryBlocker === 'site access/appointment window not confirmed') wrong.push(b);
});
A.eq('no benign note produces an access blocker', wrong, []);
// positive control: a REAL access failure still fires - the tightening did not just disable the rule.
var real = [
  'Tech could not get access, the site was closed on arrival.',
  'Vendor was denied access by the store manager.',
  'Crew turned away, no one on site to let them in.'
];
var missed = [];
real.forEach(function (b) {
  var fr = st(H('Scheduled', { nextOnsiteDate: '2026-09-14' }), [note(b, 2)]);
  if (fr.primaryBlocker !== 'site access/appointment window not confirmed') missed.push(b);
});
A.eq('every real access failure still fires', missed, []);

console.log('\n19. Low confidence drops an INFERRED blocker but keeps a CERTAIN one (M10)');
// The first pass of this harness could not catch a regression here: its only low-confidence fixture
// had no blocker at all, so deleting the guard changed nothing.
var fInf = st(H('Material Ordered'), [note('Parts are on backorder, supplier confirmed.', 40)]);
A.eq('a stale materials row is low/medium confidence', fInf.confidence !== 'high', true);
A.eq('...and its blocker is INFERRED, not header-certain', fInf.blockerCertain, false);
var fLow = { currentStage: 'Materials pending', primaryBlocker: 'parts on backorder', blockerOwner: 'Materials', confidence: 'low', blockerCertain: false, ecdText: 'TBD', noteCount: 1, terminal: false };
A.ok('an inferred blocker is SUPPRESSED at low confidence',
  T.composeAuditStatusNote(fLow).indexOf('parts on backorder') === -1, T.composeAuditStatusNote(fLow));
var fCert = { currentStage: 'Vendor scheduling pending', primaryBlocker: 'no vendor assigned yet', blockerOwner: 'Coordinator', confidence: 'low', blockerCertain: true, ecdText: 'TBD', noteCount: 0, terminal: false };
A.ok('a header-CERTAIN blocker survives low confidence',
  T.composeAuditStatusNote(fCert).indexOf('no vendor assigned yet') !== -1, T.composeAuditStatusNote(fCert));
// negative control: the certain blocker still prints its owner, so the clause is whole.
A.ok('control: the certain blocker keeps its owner label',
  /no vendor assigned yet \(Coordinator\)/.test(T.composeAuditStatusNote(fCert)), T.composeAuditStatusNote(fCert));

console.log('\n20. Deterministic over-30 fallback keeps the house format (N4)');
var fOv = st(H('Material Ordered', { trades: [{ name: 'Exterior Lighting' }], priority: { expectedCompletionDate: '2026-09-25' } }),
  [note('Parts on backorder, supplier lead time confirmed.', 3)]);
var ovNote = T.composeTimelineNote(T.fallbackChain(fOv), H('Material Ordered', { trades: [{ name: 'Exterior Lighting' }], priority: { expectedCompletionDate: '2026-09-25' } }), NOW);
A.ok('an AI-less over-30 row still opens "Over 30 - <trade>"', /^Over 30 - Exterior Lighting - /.test(ovNote), ovNote);
A.ok('...and still closes on a shipped ECD tail', / - ECD 9\/25$/.test(ovNote), ovNote);
A.ok('...and carries the stage and the blocker', /Materials pending/.test(ovNote) && /parts on backorder/.test(ovNote), ovNote);
// negative control: the fallback chain is not empty filler.
A.ok('control: the fallback chain has real content', T.fallbackChain(fOv).length > 30, T.fallbackChain(fOv));

console.log('\n21. Internal money/margin detail never reaches the workbook note (N3)');
var fMoney = st(H('Vendor Proposal Received'), [note('Vendor quoted $4,200 for the replacement, our GP is thin so push back on price.', 2)]);
var mNote = T.composeAuditStatusNote(fMoney);
A.ok('a dollar amount is redacted from the event clause', mNote.indexOf('$4,200') === -1, mNote);
A.ok('margin talk is redacted too', !/GP is thin/.test(mNote), mNote);
// negative control: the rest of the event survives - this is a redaction, not a deletion.
A.ok('control: the non-money part of the note is still reported', /Vendor quoted/.test(mNote), mNote);

console.log('\n22. Vague-filler gate covers the phrasings review found');
var fV = st(H('Scheduled'), []);
A.ok('"monitoring this closely" rejected', !!T.validateAiNote('Scheduled - the team is monitoring this closely - ECD TBD', fV, ''));
A.ok('"no update available" rejected', !!T.validateAiNote('Scheduled - no update available at this time for this work order - ECD TBD', fV, ''));
// negative control: a specific, named dependency is NOT filler.
A.eq('control: a concrete blocker + owner is accepted',
  T.validateAiNote('Scheduled - Vendor to attend the visit and report the outcome - ECD TBD', fV, ''), '');

A.finish();
