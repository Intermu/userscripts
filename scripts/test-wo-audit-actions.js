// test-wo-audit-actions.js - node harness for the Operations Action List layer (0.17.0).
//
// Slices the PURE `BWN WO-AUDIT ACTIONS` block out of the .user.js and runs the real shipped bytes:
// deriveAction (the deterministic priority / bucket / owner / escalation / due / risk / rule-id
// engine), buildActionListAoa (the actionable-only, sorted sheet builder) and the run-date helpers.
// The block is self-contained - it re-reads the deriveState fact set + the flags it is HANDED and
// never re-derives them, and the caller owns all dates (ecdDueSoon / visitPast / hasFutureOnsite are
// injected) - so no externals are needed and the clock is fixed by construction.
//
// Every rule carries a NEGATIVE control: a rule that fires unconditionally (e.g. safety from a bare
// P1, or Monitor promoted to actionable) is exactly the failure these harnesses exist to catch.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-actions.js

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
var SECTION = slice(TEXT, '// ===== BWN WO-AUDIT ACTIONS START', '// ===== BWN WO-AUDIT ACTIONS END');

var T = (new Function(
  SECTION + '\n;return { deriveAction: deriveAction, buildActionListAoa: buildActionListAoa,' +
  ' actRunDate: actRunDate, actSheetDate: actSheetDate, actValidOwner: actValidOwner,' +
  ' ACTION_SOURCE_COLS: ACTION_SOURCE_COLS, ACTION_SHEET_COLS: ACTION_SHEET_COLS };'
))();

// deriveState-shaped fact set with benign defaults; override per case.
function F(over) {
  var f = {
    phase: 'schedule', currentStage: 'Vendor scheduling pending', primaryBlocker: 'no confirmed on-site date on file',
    blockerOwner: 'Vendor', blockerCertain: false, confidence: 'high',
    nextAction: 'Vendor to confirm an on-site date and technician', nextActionOwner: 'Vendor',
    ecd: null, ecdText: 'TBD', ecdSource: 'none', ecdExpired: false,
    latestMeaningfulEvent: null, latestMeaningfulEventDate: null, noteCount: 1, staleDays: 0, terminal: false
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
  var base = { facts: F(), flags: [], header: H(), assignedTo: 'Jane Coordinator', fm: 'Bill FM', staleDays: 7 };
  for (var k in (over || {})) base[k] = over[k];
  return T.deriveAction(base);
}

// ---- 1. Vendor scheduling, standard priority ------------------------------------------------
var r1 = act({ facts: F({ phase: 'schedule' }), flags: ['NO VENDOR', 'UNSCHEDULED'] });
A.eq('vendor-sched bucket', r1.bucket, 'Vendor Scheduling');
A.eq('vendor-sched priority P2', r1.priorityKey, 'P2');
A.ok('vendor-sched rule id', r1.ruleList.indexOf('VENDOR_SCHEDULING') !== -1, r1.ruleIds);
A.ok('vendor-sched risk NO VENDOR', r1.riskList.indexOf('NO VENDOR') !== -1, r1.riskFlags);
A.eq('vendor-sched owner = assignedTo', r1.owner, 'Jane Coordinator');
A.eq('vendor-sched included', r1.include, true);
A.eq('vendor-sched due', r1.actionDue, 'Next 2 business days');
// NEGATIVE control: critical + overdue promotes the SAME row to P0.
var r1b = act({ facts: F({ phase: 'schedule', ecdExpired: true }), flags: ['NO VENDOR'], header: H({ remainingDays: -3 }), priorityLabel: 'P1 Critical', priorityCategory: 'Critical' });
A.eq('vendor-sched critical+overdue -> P0', r1b.priorityKey, 'P0');
A.eq('vendor-sched P0 due today', r1b.actionDue, 'Today');

// ---- 2. Client approval / PO release / materials --------------------------------------------
var r2 = act({ facts: F({ phase: 'proposal-sent', currentStage: 'Awaiting client approval', primaryBlocker: 'submitted proposal not yet approved', blockerOwner: 'Client' }) });
A.eq('proposal-sent bucket', r2.bucket, 'Client Approval');
A.ok('proposal-sent escalate client', /Client Approval Owner/.test(r2.escalateTo), r2.escalateTo);
var r3 = act({ facts: F({ phase: 'proposal-approved', currentStage: 'Approved - awaiting PO release', primaryBlocker: 'PO not released', blockerOwner: 'PO/Approval' }) });
A.eq('proposal-approved bucket', r3.bucket, 'PO Release');
A.ok('proposal-approved escalate PO', /PO \/ Finance Owner/.test(r3.escalateTo), r3.escalateTo);
var r4 = act({ facts: F({ phase: 'materials', currentStage: 'Materials pending', primaryBlocker: 'parts on backorder', blockerOwner: 'Materials' }) });
A.eq('materials bucket', r4.bucket, 'Material Delay');
A.ok('materials risk', r4.riskList.indexOf('MATERIALS PENDING') !== -1, r4.riskFlags);

// ---- 3. Scheduled with a FUTURE visit is Monitor; a PAST visit is Completion Verification ----
var r5 = act({ facts: F({ phase: 'scheduled', currentStage: 'Scheduled', primaryBlocker: null, blockerOwner: 'Unknown' }), header: H({ statusName: 'Scheduled', nextOnsiteDate: '2099-01-01' }), hasFutureOnsite: true, visitPast: false });
A.eq('scheduled+future = Monitor', r5.priorityKey, 'MON');
A.eq('scheduled+future not included', r5.include, false);
// NEGATIVE control: the visit has passed with no completion outcome -> Completion Verification.
var r5b = act({ facts: F({ phase: 'scheduled', currentStage: 'Scheduled', primaryBlocker: null }), header: H({ statusName: 'Scheduled', nextOnsiteDate: '2020-01-01' }), visitPast: true, hasFutureOnsite: false });
A.eq('scheduled+past = Completion Verification', r5b.bucket, 'Completion Verification');
A.eq('scheduled+past included', r5b.include, true);
A.eq('completion missed-visit due', r5b.actionDue, 'Next business day');
A.ok('scheduled+past manager review (contradiction)', r5b.managerReview === 'YES', 'no future onsite on a Scheduled WO');

// ---- 4. Terminal is Monitor / excluded ------------------------------------------------------
var r6 = act({ facts: F({ phase: 'terminal', currentStage: 'Closed', primaryBlocker: null, terminal: true }), header: H({ statusName: 'Closed' }) });
A.eq('terminal = Monitor', r6.priorityKey, 'MON');
A.eq('terminal excluded', r6.include, false);

// ---- 5. Overdue-ECD overlay seizes the bucket only when the phase gives none -----------------
var r7 = act({ facts: F({ phase: 'onhold', currentStage: 'On hold', primaryBlocker: 'work order on hold', ecdExpired: true }), header: H({ statusName: 'On Hold', remainingDays: -12 }) });
A.eq('onhold+overdue bucket', r7.bucket, 'Overdue ECD');
A.eq('onhold+overdue priority P1', r7.priorityKey, 'P1');
A.ok('overdue rule id', r7.ruleList.indexOf('ECD_OVERDUE') !== -1, r7.ruleIds);
A.ok('overdue risk flag', r7.riskList.indexOf('OVERDUE ECD') !== -1, r7.riskFlags);
A.ok('overdue >7d -> manager review', r7.managerReview === 'YES', 'overdueDays 12');

// ---- 6. Safety language forces P0 - but ONLY on explicit text (the anti-inflation guard) ------
var r8 = act({ facts: F({ phase: 'schedule' }), scopeText: 'exposed wiring at the panel, unsafe', notesText: '' });
A.eq('safety -> P0', r8.priorityKey, 'P0');
A.ok('safety risk flag', r8.riskList.indexOf('SAFETY/CRITICAL RISK') !== -1, r8.riskFlags);
A.ok('safety manager review', r8.managerReview === 'YES', 'safety');
A.ok('safety rule id', r8.ruleList.indexOf('SAFETY_OR_CRITICAL_SCOPE') !== -1, r8.ruleIds);
// NEGATIVE control: an ordinary scope with NO safety term, standard priority, stays P2 (no safety).
var r8b = act({ facts: F({ phase: 'schedule' }), scopeText: 'replace ceiling tiles in the break room', notesText: 'vendor confirmed pricing' });
A.eq('no-safety-term -> not P0', r8b.priorityKey, 'P2');
A.ok('no-safety-term no safety flag', r8b.riskList.indexOf('SAFETY/CRITICAL RISK') === -1, r8b.riskFlags);
// NEGATIVE control: a bare high priority WITHOUT overdue/no-schedule/stale/safety is not P0.
var r8c = act({ facts: F({ phase: 'materials', currentStage: 'Materials pending', primaryBlocker: 'in transit' }), header: H({ statusName: 'Material Ordered' }), priorityLabel: 'P1 Critical', priorityCategory: 'Critical' });
A.eq('critical alone (no exception) -> P1 not P0', r8c.priorityKey, 'P1');

// ---- 7. Data quality: unusable owner + unreadable header -------------------------------------
var r9 = act({ facts: F({ phase: 'schedule' }), assignedTo: 'ERRORNAME?', fm: '' });
A.eq('bad owner -> unassigned', r9.owner, 'Unassigned – Manager Review');
A.ok('bad owner manager review', r9.managerReview === 'YES', 'ownerInvalid');
A.ok('bad owner data-quality rule', r9.ruleList.indexOf('DATA_QUALITY') !== -1, r9.ruleIds);
A.ok('bad owner gap recorded', /internal owner/.test(r9.dataGaps), r9.dataGaps);
var r10 = act({ facts: F({ phase: null, currentStage: 'Current status unavailable', confidence: 'low' }), header: null });
A.eq('null header confidence', r10.confidence, 'Review Needed');
A.eq('null header bucket', r10.bucket, 'Data Quality');
A.ok('null header manager review', r10.managerReview === 'YES', 'severeDq');
// NEGATIVE control: a valid owner is NOT rewritten to Unassigned.
A.eq('valid owner kept', act({}).owner, 'Jane Coordinator');
A.eq('valid owner helper true', T.actValidOwner('Jane Coordinator'), true);
A.eq('errorname helper false', T.actValidOwner('ERRORNAME?'), false);

// ---- 8. Stale overlay ------------------------------------------------------------------------
var r11 = act({ facts: F({ phase: 'schedule', staleDays: 20 }), flags: ['STALE 20d'] });
A.ok('stale risk flag', r11.riskList.indexOf('STALE UPDATE') !== -1, r11.riskFlags);
A.ok('stale rule id', r11.ruleList.indexOf('STALE_UPDATE') !== -1, r11.ruleIds);

// ---- 8b. ECD data-gap fires only where the workflow expects an ECD --------------------------
var gEarly = act({ facts: F({ phase: 'proposal-sent', currentStage: 'Awaiting client approval', primaryBlocker: 'submitted proposal not yet approved', ecdText: 'TBD' }) });
A.ok('no ECD gap on an early phase (no ECD expected yet)', gEarly.dataGaps.indexOf('no valid ECD') === -1, gEarly.dataGaps);
var gLate = act({ facts: F({ phase: 'materials', currentStage: 'Materials pending', primaryBlocker: 'in transit', ecdText: 'TBD' }), header: H({ statusName: 'Material Ordered' }) });
A.ok('ECD gap on a phase that requires one', gLate.dataGaps.indexOf('no valid ECD') !== -1, gLate.dataGaps);

// ---- 9. Include-monitor toggle ---------------------------------------------------------------
var mon = act({ facts: F({ phase: 'scheduled', primaryBlocker: null }), header: H({ statusName: 'Scheduled', nextOnsiteDate: '2099-01-01' }), hasFutureOnsite: true });
A.eq('monitor excluded by default', mon.include, false);
var monInc = act({ facts: F({ phase: 'scheduled', primaryBlocker: null }), header: H({ statusName: 'Scheduled', nextOnsiteDate: '2099-01-01' }), hasFutureOnsite: true, includeMonitor: true });
A.eq('monitor included when opted in', monInc.include, true);

// ---- 10. Closeout due label ------------------------------------------------------------------
var clo = act({ facts: F({ phase: 'costreview', currentStage: 'Work complete - final cost review pending', primaryBlocker: 'final vendor cost not confirmed' }), header: H({ statusName: 'Clocked Out: Complete' }) });
A.eq('closeout bucket', clo.bucket, 'Closeout / Cost Review');
A.eq('closeout due this week', clo.actionDue, 'This week');

// ---- 11. Manager-review prefix on Primary Issue ---------------------------------------------
A.ok('manager-review prefix present', /^\[MANAGER REVIEW\]/.test(r9.primaryIssue), r9.primaryIssue);
A.ok('non-manager no prefix', !/^\[MANAGER REVIEW\]/.test(r1.primaryIssue), r1.primaryIssue);

// ---- 12. buildActionListAoa: header, sort, monitor exclusion --------------------------------
function row(over) {
  var b = { include: true, priorityKey: 'P2', priority: 'P2 – This Week', actionDue: 'Next 2 business days', dueRank: 2, bucket: 'Vendor Scheduling', nextAction: 'x', owner: 'Z', escalateTo: '', managerReview: 'NO', managerReviewBool: false, primaryIssue: 'x', riskFlags: '', evidence: '', confidence: 'High', ruleIds: '', wo: 'W1', status: 's', srcPriority: 'P3', location: 'L', fm: 'F', assignedTo: 'A', trade: 'T', vendor: 'V', ecd: '', nextOnsite: '', lastNoteDate: '', ageDays: 10, sourceRow: 2 };
  for (var k in (over || {})) b[k] = over[k];
  return b;
}
var p0 = row({ priorityKey: 'P0', dueRank: 0, wo: 'W-P0' });
var p2 = row({ priorityKey: 'P2', dueRank: 2, wo: 'W-P2' });
var monRow = row({ priorityKey: 'MON', include: false, wo: 'W-MON' });
var aoa = T.buildActionListAoa([p2, p0, monRow], false);
A.eq('sheet header matches ACTION_SHEET_COLS', aoa[0], T.ACTION_SHEET_COLS);
A.eq('monitor excluded from sheet', aoa.length, 3);          // header + 2 (P0, P2), monitor dropped
A.eq('P0 sorts before P2', aoa[1][7], 'W-P0');               // col 8 (index 7) is WO
A.eq('P2 second', aoa[2][7], 'W-P2');
var aoaMon = T.buildActionListAoa([p2, monRow], true);
A.eq('monitor included when opted in (sheet)', aoaMon.length, 3);
A.eq('source cols count = 16', T.ACTION_SOURCE_COLS.length, 16);
A.eq('sheet cols count = 24', T.ACTION_SHEET_COLS.length, 24);

// ---- 13. Run-date helpers (local date; fixed ms) --------------------------------------------
var ms = +new Date(2026, 8, 7, 9, 30, 0);   // 2026-09-07 local
A.eq('actRunDate zero-pads', T.actRunDate(ms), '2026-09-07');
A.eq('actSheetDate dotted', T.actSheetDate(ms), '2026.09.07');

A.finish();
