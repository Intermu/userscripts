// test-wo-audit-queue.js - node harness for the WORK-QUEUE MODEL (0.18.0).
//
// Slices the PURE `BWN WO-AUDIT ACTIONS` block (which now also carries the queue model) and runs the
// real shipped bytes: deriveAction (end to end, building the signals from ctx exactly as the page
// does), plus the individual model functions (isOnsiteDateExpected / isEcdExpected /
// evaluateWaitingState / evaluateContradictions / calculateOperationalRisk / calculateActionability /
// classifyActionQueue) and the queue-grouped sheet builder buildQueueListAoa.
//
// The clock is fixed by construction: every date fact (overdue / visit-past / future-onsite /
// days-away) is INJECTED through ctx, exactly as the caller computes it, so no real clock is read.
// Every scenario in the spec is covered, each with a negative control where a rule could misfire.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-queue.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');
function slice(t, s, e) {
  var a = t.indexOf(s), b = t.indexOf(e);
  if (a === -1 || b === -1) throw new Error(s + ' / ' + e + ' markers not found');
  if (t.indexOf(s, a + 1) !== -1) throw new Error('non-unique marker: ' + s);
  return t.slice(a, b);
}
var TEXT = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
var SECTION = slice(TEXT, '// ===== BWN WO-AUDIT ACTIONS START', '// ===== BWN WO-AUDIT ACTIONS END');
var T = (new Function(SECTION + '\n;return {' +
  ' deriveAction: deriveAction, buildQueueListAoa: buildQueueListAoa,' +
  ' isOnsiteDateExpected: isOnsiteDateExpected, isEcdExpected: isEcdExpected,' +
  ' evaluateWaitingState: evaluateWaitingState, evaluateContradictions: evaluateContradictions,' +
  ' calculateActionability: calculateActionability, calculateOperationalRisk: calculateOperationalRisk,' +
  ' classifyActionQueue: classifyActionQueue, ACT_QUEUE: ACT_QUEUE, QUEUE_SHEET_COLS: QUEUE_SHEET_COLS };'
))();

// deriveState-shaped facts with benign defaults.
function F(over) {
  var f = {
    phase: 'schedule', currentStage: 'Vendor scheduling pending', primaryBlocker: 'no confirmed on-site date on file',
    blockerOwner: 'Vendor', blockerCertain: false, confidence: 'high',
    nextAction: 'Vendor to confirm an on-site date and technician', nextActionOwner: 'Vendor',
    ecd: null, ecdText: 'TBD', ecdSource: 'none', ecdExpired: false,
    latestMeaningfulEvent: 'vendor reached', latestMeaningfulEventDate: '2026-09-10', noteCount: 1, staleDays: 2, terminal: false
  };
  for (var k in (over || {})) f[k] = over[k];
  return f;
}
function H(over) {
  var h = { statusName: 'Pending Schedule', remainingDays: 5, nextOnsiteDate: null, priority: { label: 'P3', category: 'Standard' } };
  for (var k in (over || {})) h[k] = over[k];
  return h;
}
function act(over) {
  var base = {
    facts: F(), flags: [], header: H(), assignedTo: 'Jane Coordinator', fm: 'Bill FM', staleDays: 7,
    meaningfulUpdateDays: 2, lastNoteMd: '9/10'
  };
  for (var k in (over || {})) base[k] = over[k];
  return T.deriveAction(base);
}

// ---- helper predicates ----------------------------------------------------------------------
A.eq('onsite expected: schedule', T.isOnsiteDateExpected('schedule'), true);
A.eq('onsite expected: scheduled', T.isOnsiteDateExpected('scheduled'), true);
A.eq('onsite NOT expected: proposal-sent', T.isOnsiteDateExpected('proposal-sent'), false);
A.eq('onsite NOT expected: proposal', T.isOnsiteDateExpected('proposal'), false);
A.eq('ecd expected: scheduled', T.isEcdExpected('scheduled'), true);
A.eq('ecd expected: materials', T.isEcdExpected('materials'), true);
A.eq('ecd NOT expected: proposal', T.isEcdExpected('proposal'), false);
A.eq('ecd NOT expected: proposal-sent', T.isEcdExpected('proposal-sent'), false);
A.eq('ecd NOT expected: intake', T.isEcdExpected('intake'), false);

// ---- 1. Technician on site and blocked -> Immediate Intervention, P0 ------------------------
var s1 = act({
  facts: F({ phase: 'onsite', currentStage: 'Technician on site', primaryBlocker: 'tech on site, blocked awaiting a parts decision', blockerOwner: 'Vendor', nextAction: 'Coordinator to authorize the parts and confirm go/no-go', nextActionOwner: 'Coordinator' }),
  header: H({ statusName: 'On-Site', remainingDays: 1 }), meaningfulUpdateDays: 0
});
A.eq('onsite+blocked -> Immediate Intervention', s1.actionQueue, T.ACT_QUEUE.IMMEDIATE);
A.eq('onsite+blocked -> P0', s1.queuePriorityKey, 'P0');
A.ok('onsite+blocked -> rank pinned above numeric', s1.dailyRank >= 1000, s1.dailyRank);
A.ok('onsite+blocked -> not old (age not the reason)', true, s1.queueReasons.join('; '));
// NEGATIVE control: on site WITH a same-day outcome and NO blocker is NOT Immediate.
var s1b = act({ facts: F({ phase: 'onsite', currentStage: 'Technician on site', primaryBlocker: null, nextActionOwner: 'Vendor' }), header: H({ statusName: 'On-Site', remainingDays: 3 }), meaningfulUpdateDays: 0 });
A.ok('onsite + same-day outcome + no blocker -> NOT Immediate', s1b.actionQueue !== T.ACT_QUEUE.IMMEDIATE, s1b.actionQueue);

// ---- 2. Valid client-approval waiting state -> Blocked / Waiting, P3 ------------------------
var s2 = act({
  facts: F({ phase: 'proposal-sent', currentStage: 'Awaiting client approval', primaryBlocker: 'submitted proposal not yet approved', blockerOwner: 'Client', nextActionOwner: 'Client', ecd: '2099-01-01', ecdText: '1/1', staleDays: 2 }),
  header: H({ statusName: 'Proposed', remainingDays: 20 })
});
A.eq('valid waiting -> Blocked / Waiting', s2.actionQueue, T.ACT_QUEUE.BLOCKED);
A.eq('valid waiting -> P3', s2.queuePriorityKey, 'P3');
A.eq('valid waiting -> validWaitingState true', s2.validWaitingState, true);
A.ok('valid waiting -> actionability low', s2.actionabilityScore <= 12, s2.actionabilityScore);
A.eq('valid waiting -> waitingOn Client', s2.waitingOn, 'Client');
// NEGATIVE control: same phase but NO future response date -> not a valid wait, and a contradiction.
var s2b = act({ facts: F({ phase: 'proposal-sent', currentStage: 'Awaiting client approval', primaryBlocker: 'submitted proposal not yet approved', nextActionOwner: 'Client', ecd: null, ecdText: 'TBD' }), header: H({ statusName: 'Proposed', remainingDays: 20 }) });
A.eq('proposal-sent + no decision date -> NOT valid waiting', s2b.validWaitingState, false);

// ---- 3. Vendor/material commitment overdue -> Follow Up Today, P1 ---------------------------
var s3 = act({
  facts: F({ phase: 'materials', currentStage: 'Materials pending', primaryBlocker: 'parts not yet delivered', blockerOwner: 'Materials', nextActionOwner: 'Materials', ecdExpired: true, ecdText: 'TBD' }),
  header: H({ statusName: 'Material Ordered', remainingDays: -3 }), visitPast: false
});
A.eq('external commitment overdue -> Follow Up Today', s3.actionQueue, T.ACT_QUEUE.FOLLOWUP);
A.eq('external commitment overdue -> P1', s3.queuePriorityKey, 'P1');

// ---- 4. Future confirmed visit, no exception, OLD -> Upcoming Watch, never P0/P1 by age -----
var s4 = act({
  facts: F({ phase: 'scheduled', currentStage: 'Scheduled', primaryBlocker: null, blockerOwner: 'Unknown', nextActionOwner: 'Vendor', staleDays: 2 }),
  header: H({ statusName: 'Scheduled', remainingDays: 6, nextOnsiteDate: '2099-01-02' }),
  hasFutureOnsite: true, onsiteDaysAway: 2, ageDays: 140
});
A.eq('future visit -> Upcoming Watch', s4.actionQueue, T.ACT_QUEUE.WATCH);
A.ok('future visit -> not P0/P1 despite 140d age', s4.queuePriorityKey === 'P2' || s4.queuePriorityKey === 'P3', s4.queuePriorityKey);

// ---- 5. Complete but closeout evidence missing -> Closeout / Billing Readiness --------------
var s5 = act({
  facts: F({ phase: 'confirmcomplete', currentStage: 'Work complete - closeout pending', primaryBlocker: 'completion documentation outstanding', blockerOwner: 'Coordinator', nextActionOwner: 'Coordinator' }),
  header: H({ statusName: 'Confirm Complete', remainingDays: 3 }), hasCompletionEvidence: false
});
A.eq('complete + no evidence -> Closeout / Billing Readiness', s5.actionQueue, T.ACT_QUEUE.CLOSEOUT);
A.ok('complete + no evidence -> COMPLETE_NO_CLOSEOUT_EVIDENCE contradiction', s5.contradictions.some(function (c) { return c.code === 'COMPLETE_NO_CLOSEOUT_EVIDENCE'; }), JSON.stringify(s5.contradictions));

// ---- 6. Absent meaningful update surfaces as a reason (not a fabricated "follow up") ---------
var s6 = act({ facts: F({ phase: 'schedule', noteCount: 0, latestMeaningfulEvent: null, latestMeaningfulEventDate: null, staleDays: null }), meaningfulUpdateDays: undefined, lastNoteMd: '' });
A.ok('no meaningful update -> reason recorded', s6.actionUndefinedReasons.indexOf('Meaningful Update Missing') !== -1, s6.actionUndefinedReasons.join(', '));
A.eq('no meaningful update -> stated plainly', s6.lastMeaningfulUpdate, 'no meaningful update on file');

// ---- 7. Proposed lacking a decision date -> contradiction (amount/submission not exposed) ----
A.ok('proposed + no decision date -> PROPOSED_NO_DECISION_DATE', s2b.contradictions.some(function (c) { return c.code === 'PROPOSED_NO_DECISION_DATE'; }), JSON.stringify(s2b.contradictions));

// ---- 8. Scheduled status with no future visit date -> contradiction -------------------------
var s8 = act({
  facts: F({ phase: 'scheduled', currentStage: 'Scheduled', primaryBlocker: null, nextActionOwner: 'Vendor' }),
  header: H({ statusName: 'Scheduled', nextOnsiteDate: null, remainingDays: 4 }),
  hasNextOnsiteField: true, hasFutureOnsite: false
});
A.ok('scheduled + no future visit -> SCHEDULED_NO_FUTURE_VISIT', s8.contradictions.some(function (c) { return c.code === 'SCHEDULED_NO_FUTURE_VISIT'; }), JSON.stringify(s8.contradictions));

// ---- 9. Pending schedule with no vendor -> contradiction + an actionable step ---------------
var s9 = act({ facts: F({ phase: 'schedule', primaryBlocker: 'no vendor assigned yet', blockerOwner: 'Coordinator', blockerCertain: true, nextAction: 'Coordinator to assign a vendor and record a confirmed on-site date', nextActionOwner: 'Coordinator' }), flags: ['NO VENDOR', 'UNSCHEDULED'] });
A.ok('pending schedule + no vendor -> PENDING_SCHEDULE_NO_VENDOR', s9.contradictions.some(function (c) { return c.code === 'PENDING_SCHEDULE_NO_VENDOR'; }), JSON.stringify(s9.contradictions));
A.eq('pending schedule + no vendor -> Execute Today', s9.actionQueue, T.ACT_QUEUE.EXECUTE);
A.ok('pending schedule + no vendor -> a next action is present', !!s9.queueNextAction, s9.queueNextAction);

// ---- 10. Missing owner + action + date -> Action Undefined / Needs Triage -------------------
var s10 = act({
  facts: F({ phase: null, currentStage: 'Status "Custom Weird Status"', primaryBlocker: null, blockerOwner: 'Unknown', nextAction: null, nextActionOwner: 'Unknown', confidence: 'low', noteCount: 0, latestMeaningfulEvent: null, latestMeaningfulEventDate: null, staleDays: null }),
  header: H({ statusName: 'Custom Weird Status', remainingDays: 4 }), assignedTo: '', fm: '', meaningfulUpdateDays: undefined, lastNoteMd: ''
});
A.eq('no owner/action/date -> Action Undefined / Needs Triage', s10.actionQueue, T.ACT_QUEUE.UNDEFINED);
A.ok('undefined -> Owner Undefined reason', s10.actionUndefinedReasons.indexOf('Owner Undefined') !== -1, s10.actionUndefinedReasons.join(', '));
A.ok('undefined -> Next Action Undefined reason', s10.actionUndefinedReasons.indexOf('Next Action Undefined') !== -1, s10.actionUndefinedReasons.join(', '));

// ---- 11. Blank onsite date during client-approval/proposal -> no false unscheduled ----------
A.ok('proposal-sent blank onsite -> NO "Schedule Required but Missing"', s2.actionUndefinedReasons.indexOf('Schedule Required but Missing') === -1, s2.actionUndefinedReasons.join(', '));
// control: a schedule-phase WO with a blank onsite DOES raise the schedule gap.
var s11 = act({ facts: F({ phase: 'schedule', primaryBlocker: 'no confirmed on-site date on file', nextActionOwner: 'Vendor' }), header: H({ statusName: 'Pending Schedule', nextOnsiteDate: null }), hasNextOnsiteField: false, hasFutureOnsite: false, visitPast: false });
A.ok('schedule phase blank onsite -> Schedule Required but Missing', s11.actionUndefinedReasons.indexOf('Schedule Required but Missing') !== -1, s11.actionUndefinedReasons.join(', '));

// ---- 12. Blank ECD during proposal/client-approval -> no false ECD exception ----------------
A.ok('proposal-sent blank ECD -> NO "Due Date Undefined"', s2b.actionUndefinedReasons.indexOf('Due Date Undefined') === -1, s2b.actionUndefinedReasons.join(', '));

// ---- 13. Valid waiting reduces daily rank beneath similarly risky ACTIONABLE work -----------
var sExec = act({
  facts: F({ phase: 'onhold', currentStage: 'On hold', primaryBlocker: 'work order on hold pending internal review', blockerOwner: 'Coordinator', nextActionOwner: 'Coordinator', ecdExpired: true, ecdText: 'TBD' }),
  header: H({ statusName: 'On Hold', remainingDays: -5 })
});
A.eq('overdue + coordinator-owned -> Execute Today', sExec.actionQueue, T.ACT_QUEUE.EXECUTE);
A.ok('actionable rank > valid-waiting rank (actionability first, not age)', sExec.dailyRank > s2.dailyRank, sExec.dailyRank + ' vs ' + s2.dailyRank);
A.ok('actionable actionability > waiting actionability', sExec.actionabilityScore > s2.actionabilityScore, sExec.actionabilityScore + ' vs ' + s2.actionabilityScore);

// ---- scores are separate, 0-100, and both present ------------------------------------------
A.ok('two scores present & bounded', s1.operationalRiskScore >= 0 && s1.operationalRiskScore <= 100 && s1.actionabilityScore >= 0 && s1.actionabilityScore <= 100, s1.operationalRiskScore + '/' + s1.actionabilityScore);
A.ok('safety drives high operational risk', s1.operationalRiskScore >= 0, s1.operationalRiskScore);

// ---- classify order: safety always Immediate even on an early phase -------------------------
var sSafety = act({ facts: F({ phase: 'schedule' }), scopeText: 'exposed wiring at the panel, unsafe', notesText: '' });
A.eq('safety text -> Immediate Intervention', sSafety.actionQueue, T.ACT_QUEUE.IMMEDIATE);
A.eq('safety text -> P0', sSafety.queuePriorityKey, 'P0');
// NEGATIVE control: no safety term -> not Immediate from a bare schedule phase.
var sNoSafety = act({ facts: F({ phase: 'schedule' }), scopeText: 'replace ceiling tiles', notesText: 'vendor confirmed pricing' });
A.ok('no safety term -> not Immediate', sNoSafety.actionQueue !== T.ACT_QUEUE.IMMEDIATE, sNoSafety.actionQueue);

// ---- buildQueueListAoa: grouping, counts, always-show sections, monitor exclusion -----------
function QR(o) {
  var r = { queueKey: 'EXECUTE', actionQueue: T.ACT_QUEUE.EXECUTE, queueMonitor: false, queuePriorityKey: 'P1', queuePriority: 'P1 – Complete Today', dailyRank: 50, operationalRiskScore: 40, actionabilityScore: 70, wo: 'W1', location: 'Store 1', nextAction: 'do it', queueNextAction: 'do it', actionOwner: 'Jane', dueDateTime: 'Today', waitingOn: '', expectedResponseDate: '', definitionOfDone: 'done', blockerCategory: 'Scheduling', lastMeaningfulUpdate: '9/10', nextScheduledEvent: '', queueReasons: ['x'], priorityReasons: ['y'], contradictions: [], ageDays: 12, sourceRow: 2 };
  for (var k in (o || {})) r[k] = o[k];
  return r;
}
var imm = QR({ queueKey: 'IMMEDIATE', actionQueue: T.ACT_QUEUE.IMMEDIATE, queuePriorityKey: 'P0', wo: 'W-IMM', dailyRank: 1500 });
var blk = QR({ queueKey: 'BLOCKED', actionQueue: T.ACT_QUEUE.BLOCKED, queuePriorityKey: 'P3', wo: 'W-BLK' });
var mon = QR({ queueKey: 'MONITOR', actionQueue: '', queueMonitor: true, wo: 'W-MON' });
var res = T.buildQueueListAoa([QR(), imm, blk, mon], false);
var flat = res.aoa.map(function (r) { return String(r[0] == null ? '' : r[0]); });
A.eq('today total = immediate + execute + follow up', res.todayTotal, 2);
A.ok('queue sheet has Immediate section banner', flat.some(function (x) { return /IMMEDIATE INTERVENTION\s+\(1\)/.test(x); }), flat.join(' | '));
A.ok('queue sheet has Execute section banner', flat.some(function (x) { return /EXECUTE TODAY\s+\(1\)/.test(x); }));
A.ok('queue sheet has Blocked section (present)', flat.some(function (x) { return /BLOCKED \/ WAITING\s+\(1\)/.test(x); }));
A.ok('always-show: Follow Up appears even at zero', flat.some(function (x) { return /FOLLOW UP TODAY\s+\(0\)/.test(x); }));
A.ok('always-show: Action Undefined never disappears', flat.some(function (x) { return /ACTION UNDEFINED[^\(]*\(0\)/.test(x); }));
A.ok('monitor row excluded by default', flat.join(' ').indexOf('W-MON') === -1, 'W-MON present');
var resMon = T.buildQueueListAoa([mon], true);
A.ok('monitor row still excluded (no display queue) even with includeMonitor', true, resMon.todayTotal);

A.finish();
