// test-wo-audit-client-reply.js - node harness for the WO Audit Client Update Reply (0.19.0, 0.20.0).
//
// Pilot FMs (FM = Store Analyst = the Pilot PO owner) email a list of POs asking for updates. The
// pure CLIENT REPLY block turns that paste into one reviewed reply table per FM; since 0.20.0 each
// update runs through the Ops Suite Client Update pipeline. This drives the SHIPPED bytes (sliced
// TIMELINE + STATE + CU PIPELINE + CLIENT REPLY + MAP) and covers:
//   1. paste parsing - the FM's tab table (Outlook wraps cells onto new lines), a reply thread that
//      repeats its PO, the "UPDATE NEEDED" template, and the safety/incident hold,
//   2. the FM rule - audit FM column, else Client Open POs owner, conflicts and gaps surfaced,
//   3. grouping by FM (Unassigned last),
//   4. the pipeline glue - status sentences (each must pass cuSafetyCheck with no appointment),
//      note scrubbing, the safe fallback led by the live status, and the final check (cuSafetyCheck
//      plus lapsed / ungrounded dates and internal wording),
//   5. reply table escaping and line breaks, and
//   6. PARITY: the CU-TRIPS / CU-PIPELINE blocks and the four stage prompts are byte-identical to
//      bwn-suite-ai.user.js, the client pipeline of record.
// Fixtures are SYNTHETIC (made-up names and POs in the real Pilot shapes); no client data is stored.
// The clock is injected. Every rejecting rule has a negative control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-client-reply.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

function read(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n'); }
var TEXT = read('bwn-wo-audit.user.js');
function slice(startMark, endMark) {
  var a = TEXT.indexOf(startMark), b = TEXT.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error(startMark + ' / ' + endMark + ' markers not found');
  if (TEXT.indexOf(startMark, a + 1) !== -1) throw new Error('non-unique marker: ' + startMark);
  return TEXT.slice(a, b);
}
var SECTION =
  slice('// ===== BWN WO-AUDIT TIMELINE START', '// ===== BWN WO-AUDIT TIMELINE END') + '\n' +
  slice('// ===== BWN WO-AUDIT STATE START', '// ===== BWN WO-AUDIT STATE END') + '\n' +
  slice('// ===== BWN WO-AUDIT CU PIPELINE START', '// ===== BWN WO-AUDIT CU PIPELINE END') + '\n' +
  slice('// ===== BWN WO-AUDIT CLIENT REPLY START', '// ===== BWN WO-AUDIT CLIENT REPLY END') + '\n' +
  slice('// ===== BWN WO-AUDIT MAP START', '// ===== BWN WO-AUDIT MAP END');

var MS_DAY = 86400000;
function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
function auditCfg(key, def) { return def; }
var STALE_DAYS = 7;
var T = (new Function('MS_DAY', '_date', 'auditCfg', 'STALE_DAYS', 'XLSX',
  SECTION + '\n;return { curParsePaste: curParsePaste, curBuildIndex: curBuildIndex, curResolve: curResolve,' +
  ' curGroup: curGroup, curStatusSentence: curStatusSentence, curScrub: curScrub, curPipelineNotes: curPipelineNotes,' +
  ' curFallbackDraft: curFallbackDraft, curFinalCheck: curFinalCheck, curReplyHtml: curReplyHtml, curReplyTsv: curReplyTsv,' +
  ' curFmtDate: curFmtDate, deriveState: deriveState, CUR_STAGE: CUR_STAGE, CUR_PARTS: CUR_PARTS, CUR_UNASSIGNED: CUR_UNASSIGNED,' +
  ' cuSafetyCheck: cuSafetyCheck, cuMergeFacts: cuMergeFacts, cuBuildExtractionInput: cuBuildExtractionInput };'))(MS_DAY, _date, auditCfg, STALE_DAYS, null);

// Local noon on 10/5/2026 - "today" is 10/5 in any US time zone.
var NOW = new Date(2026, 9, 5, 12, 0, 0).getTime();

// ---- 1. paste parsing ------------------------------------------------------------------------
// The FM's table as Outlook copies it: tab-separated, the store/city/vendor cells wrapped.
var FM_TABLE =
  '7\tFm Alpha\t170101000001\t101-Travel Center\nTowna\tStatea\tBroadway National Group\n7/16/2026\n' +
  '8\tFm Alpha\t170101000002\t102-Travel Center\nTownb\tStateb\tBroadway National Group\n9/3/2026\n' +
  '9\tFm Alpha\t170101000003\t103-Travel Center\nTownc\tStatec\tBroadway National Group\n9/14/2026\n';
var p1 = T.curParsePaste(FM_TABLE);
A.eq('table: three POs in the FM order', p1.pos.map(function (x) { return x.po; }), ['170101000001', '170101000002', '170101000003']);
A.eq('table: the FM row # is kept', p1.pos.map(function (x) { return x.rowNo; }), ['7', '8', '9']);
A.eq('table: the FM name is read', p1.pos[0].fmName, 'Fm Alpha');
A.eq('table: no hold on plain requests', p1.hold, '');

var THREAD = 'Good morning,\nIs there an update on this?\n\nFrom: Someone\nSubject: RE: Purchase Order: 170101000009 PFJ Store: 4649-Travel Center\n' +
  'Subject: Purchase Order: 170101000009 PFJ Store: 4649-Travel Center\nPO: 170101000009\t NTE:$1,000.00';
var p2 = T.curParsePaste(THREAD);
A.eq('thread: a PO repeated in every quoted header is one row', p2.pos.length, 1);
A.eq('thread: no row # outside a table', p2.pos[0].rowNo, '');

var TEMPLATE = 'Store: **UPDATE NEEDED**612-Travel Center - WO# 02203780 - PO: 170101000010 - washer leaking\nWhat is the status of this PO?';
A.eq('template: the PO is read, not the 8-digit client WO#', T.curParsePaste(TEMPLATE).pos.map(function (x) { return x.po; }), ['170101000010']);

var INCIDENT = 'Broadway team,\nAre you able to provide an update on the condition of the technician involved in the incident at the site?\nPO: 170101000011';
A.eq('hold: incident wording is surfaced for a person', T.curParsePaste(INCIDENT).hold.toLowerCase(), 'incident');
A.eq('hold: no PO-shaped noise is invented', T.curParsePaste('call 865-474-2482 or WO# 02215716').pos.length, 0);

// ---- 2. the FM rule ----------------------------------------------------------------------------
var AUDIT = [
  ['WO #', 'FM', 'Source PO #', 'Location #', 'City', 'State'],
  ['W-1', 'Fm Alpha', '170101000001', 'PFJ 0101', 'Towna', 'AA'],
  ['W-2', 'Fm Alpha', '170101000002-TS', 'PFJ 0102', 'Townb', 'BB'],   // suffix normalizes
  ['W-3', 'Fm Beta', '170101000003', 'PFJ 0103', 'Townc', 'CC'],        // conflicts with client list
  ['W-4', '', '170101000004', 'PFJ 0104', 'Townd', 'DD'],               // blank FM
  ['W-5', 'Fm Alpha', '170101000005', 'PFJ 0105', 'Towne', 'EE'],
  ['W-6', 'Fm Alpha', '170101000005', 'PFJ 0105', 'Towne', 'EE']        // same PO twice
];
var AMAP = { headerRow: 0, key: 0, fm: 1, po: 2, location: 3, city: 4, state: 5 };
var CLIENT = [
  ['Work Order', 'PO #', 'WO / PO Owner', 'Account', 'Status', 'Asset', 'Store City', 'Store State', 'Total PO Value/NTE', 'Dispatch Vendor', 'Created Date'],
  ['02200001', '170101000001', 'Fm Alpha', '101-Travel Center', 'Open', '', 'Towna', 'Statea', '$500.00', 'x', 46219.4],
  ['02200003', '170101000003', 'Fm Gamma', '103-Travel Center', 'Open', '', 'Townc', 'Statec', '', 'x', '9/14/2026 8:00'],
  ['02200004', '170101000004', 'Fm Delta', '104-Travel Center', 'Open', '', 'Townd', 'Stated', '', 'x', ''],
  ['02200007', '170101000007', 'Fm Epsilon', '107-Travel Center', 'Open', '', 'Towng', 'Stateg', '', 'x', '']
];
var IDX = T.curBuildIndex(AUDIT, AMAP, CLIENT);
function res(po) { return T.curResolve({ po: po, rowNo: '' }, IDX); }

var r1 = res('170101000001');
A.eq('fm: audit FM column wins', [r1.fm, r1.fmSource, r1.wo], ['Fm Alpha', 'audit', 'W-1']);
A.eq('fm: store/city/state/date come from the client list', [r1.store, r1.city, r1.state, r1.date], ['101-Travel Center', 'Towna', 'Statea', '7/16/2026']);
A.eq('fm: a clean match carries no review reason', r1.review, []);
A.eq('fm: a "-TS" suffixed audit PO still matches', res('170101000002').wo, 'W-2');
A.ok('fm: an audit/client-list disagreement is shown, not resolved', /FM conflict: audit says Fm Beta, Client Open POs says Fm Gamma/.test(res('170101000003').review.join('|')));
A.eq('fm: the audit FM still names the group on a conflict', res('170101000003').fm, 'Fm Beta');
var r4 = res('170101000004');
A.eq('fm: blank audit FM falls back to the client owner', [r4.fm, r4.fmSource], ['Fm Delta', 'client list']);
A.ok('fm: ...and says so', /blank in the audit/.test(r4.review.join('|')));
A.ok('fm: a PO on two audit rows is flagged', /on 2 audit rows/.test(res('170101000005').review.join('|')));
var r7 = res('170101000007');
A.eq('fm: not in the audit -> client owner, no WO to read', [r7.fm, r7.wo], ['Fm Epsilon', '']);
A.ok('fm: ...and the row must be written by hand', /not in the audit workbook/.test(r7.review.join('|')));
var r8 = res('170101000008');
A.eq('fm: in neither sheet -> Unassigned', r8.fm, T.CUR_UNASSIGNED);
A.ok('fm: ...with the reason', /neither the audit nor the Client Open POs/.test(r8.review.join('|')));
A.eq('fm: no client sheet still resolves from the audit', T.curResolve({ po: '170101000001' }, T.curBuildIndex(AUDIT, AMAP, null)).fm, 'Fm Alpha');

// ---- 3. grouping ---------------------------------------------------------------------------------
var G = T.curGroup([r8, res('170101000003'), r1, r4]);
A.eq('group: FMs alphabetical, Unassigned last', G.map(function (g) { return g.fm; }), ['Fm Alpha', 'Fm Beta', 'Fm Delta', T.CUR_UNASSIGNED]);

A.eq('date: Excel serial -> M/D/YYYY', T.curFmtDate(46297.38), '10/2/2026');
A.eq('date: text keeps its date part', T.curFmtDate('10/2/2026 9:21'), '10/2/2026');

// ---- 4. pipeline glue ------------------------------------------------------------------------------
function st(f, h) { return T.curStatusSentence(f, h); }
A.eq('status: materials', st({ phase: 'materials' }, { statusName: 'Material Ordered' }), 'Parts/materials for this repair are on order.');
A.eq('status: a backorder blocker is named in client terms', st({ phase: 'materials', primaryBlocker: 'parts on backorder' }, { statusName: 'Need Material' }), 'Parts for this repair are on backorder.');
A.eq('status: cancelled is not "complete"', st({ phase: 'terminal' }, { statusName: 'Canceled' }), 'This work order has been cancelled.');
A.eq('status: closed', st({ phase: 'terminal' }, { statusName: 'Invoiced' }), 'The work is complete.');
A.eq('status: unmapped status -> nothing invented', st({ phase: null }, { statusName: 'Some New Status' }), '');
A.eq('status: no live record -> nothing invented', st({ phase: 'materials' }, null), '');
// Every status sentence must pass the suite's blocking checker WITHOUT a confirmed appointment:
// only a trip record may say "service is scheduled", and "awaiting approval" reads as internal.
[].concat(Object.keys(T.CUR_STAGE).map(function (k) { return T.CUR_STAGE[k]; }),
  Object.keys(T.CUR_PARTS).map(function (k) { return T.CUR_PARTS[k]; }),
  ['This work order has been cancelled.', 'The work is complete.']).forEach(function (s) {
  var c = T.cuSafetyCheck(s, [], false);
  A.ok('status: passes cuSafetyCheck with no appointment - "' + s + '"', c.safe, c.violations.join(', '));
});
var fLive = T.deriveState({ statusName: 'Pending Materials Supplier', priority: {} }, [], NOW);
A.eq('status: live header -> materials wording', st(fLive, { statusName: 'Pending Materials Supplier' }), 'Parts/materials for this repair are on order.');

// Scrub: nothing internal leaves the browser in the extraction input.
var SCRUBBED = T.curScrub('ACME Signs quoted $1,350.00 - call 631-555-0100 or ops@example.com', ['ACME Signs']);
A.eq('scrub: amount, phone, email and vendor name redacted', SCRUBBED, '[vendor] quoted [redacted] - call [phone] or [contact]');
var PN = T.curPipelineNotes([{ content: 'Tech onsite, ACME Signs needs a lift. $900 quote.', createdDate: '2026-10-03T10:00:00' }], ['ACME Signs']);
A.eq('scrub: notes shaped for the pipeline', PN, [{ ts: '10/3', body: 'Tech onsite, [vendor] needs a lift. [redacted] quote.' }]);
var XIN = T.cuBuildExtractionInput({ wo: 1, status: 'Material Ordered', confirmedAppointment: null }, PN);
A.ok('scrub: the extraction input carries no vendor name or amount', !/ACME|\$\d/.test(XIN));

// Safe fallback: led by the live status, date line from the structured context only.
var CTX_T = { targetCompletionDate: 'October 20, 2026' };
var FB = T.curFallbackDraft(null, CTX_T, 'Parts/materials for this repair are on order.', []);
A.ok('fallback: leads with the live status', /^Parts\/materials for this repair are on order\./.test(FB), FB);
A.ok('fallback: a target date is labelled a target, never a booking', /target completion date of October 20, 2026/.test(FB) && !/scheduled for/i.test(FB), FB);
A.ok('fallback: passes cuSafetyCheck', T.cuSafetyCheck(FB, [], false).safe);
var FB_A = T.curFallbackDraft(null, { confirmedAppointment: { date: '2026-10-09T14:00:00.000Z', startTime: null }, completedTrip: false }, 'The service visit is being finalized.', []);
A.ok('fallback: a trip-record appointment may say "scheduled"', /Service is scheduled for October 9, 2026\./.test(FB_A), FB_A);
var FB_N = T.curFallbackDraft(null, {}, '', []);
A.ok('fallback: no status, no date -> the neutral lines', /We are actively managing/.test(FB_N) && /finalizing the required service arrangements/.test(FB_N), FB_N);
// Facts that would leak are dropped for the facts-free version.
var LEAKY = { currentStatusPlain: 'ACME Signs declined the job.', verifiedFindings: [], completedActions: [], remainingScope: [], accessOrSafetyRequirements: [], materialsOrDependencies: [], clientSafeCurrentActions: [] };
var FB_L = T.curFallbackDraft(LEAKY, CTX_T, 'Parts/materials for this repair are on order.', ['ACME Signs']);
A.ok('fallback: a fact that trips the checker is not shipped', !/ACME|declined/.test(FB_L) && T.cuSafetyCheck(FB_L, ['ACME Signs'], false).safe, FB_L);

// Final check on a rendered draft: cuSafetyCheck + the batch extras.
var ground = 'NOTES <<<[10/3] Parts confirmed, compressor ships 10/8. Tech onsite 10/3.>>> Today 10/5';
var GOOD = 'Parts for this repair are on order and are expected to ship 10/8.\n\nWe are finalizing the required service arrangements and will provide the confirmed service date once it is available.';
A.eq('final: a grounded, clean render passes (negative control)', T.curFinalCheck(GOOD, [], false, ground, NOW), '');
[
  ['dollar amount', 'Parts are on order; the repair is approved at $1,350.00 total.'],
  ['vendor reference', 'Parts are on order and the contractor will return to finish the work.'],
  ['vendor name', 'Parts are on order and Acme Signs will return to finish the work.'],
  ['unconfirmed appointment', 'Parts are on order. Service is scheduled for 10/8 at the site.'],
  ['internal approval', 'Parts are on order pending internal approval of the repair.'],
  ['internal wording', 'Parts are on order; the coordinator is tracking the delivery.'],
  ['ungrounded date', 'Parts are on order and the visit is set for 10/12 this month.'],
  ['ordinal ungrounded date', 'Parts are on order and the visit is on October 12th this month.']
].forEach(function (c) {
  A.ok('final: rejects ' + c[0], T.curFinalCheck(c[1], ['ACME Signs'], false, ground, NOW) !== '', c[1]);
});
A.eq('final: a confirmed appointment may say "scheduled for" (negative control)',
  T.curFinalCheck('Parts have arrived. Service is scheduled for 10/8 at the site.', [], true, ground, NOW), '');
A.ok('final: a past date written as upcoming is rejected',
  /past date \(10\/3\) as upcoming/.test(T.curFinalCheck('Parts for this repair are expected to arrive by October 3rd at the site.', [], false, ground, NOW)));
A.eq('final: a past date stated as past is fine',
  T.curFinalCheck('A technician was on site 10/3 and confirmed parts are needed for the repair.', [], false, ground, NOW), '');
var JAN4 = new Date(2027, 0, 4, 12).getTime(), groundJan = ground + ' 1/8 12/30';
A.eq('final: across New Year, 1/8 is upcoming', T.curFinalCheck('Parts for this repair are expected to arrive 1/8.', [], false, groundJan, JAN4), '');
A.ok('final: across New Year, 12/30 is last year - rejected as upcoming',
  /past date \(12\/30\)/.test(T.curFinalCheck('Parts for this repair are expected to arrive 12/30.', [], false, groundJan, JAN4)));
A.eq('final: a clause without future wording is not judged by its neighbour',
  T.curFinalCheck('The repair plan was set 10/3; work will follow once parts arrive.', [], false, ground, NOW), '');

// ---- 5. reply table ---------------------------------------------------------------------------------
var row = { rowNo: '7', fm: 'Fm Alpha', po: '170101000001', store: '101-Travel Center', city: 'Towna', state: 'Statea', date: '7/16/2026', update: 'Scheduled <b>10/9</b>\tline2\nline3' };
// The shipped `esc` lives in the modal closure and is pinned by test-esc-canonical.js; an
// equivalent stand-in here proves curReplyHtml routes every cell through it.
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var html = T.curReplyHtml([row], esc);
A.ok('reply: header row in the FM column order + Update', /<th[^>]*>#<\/th><th[^>]*>FM<\/th><th[^>]*>PO<\/th>.*<th[^>]*>Update<\/th>/.test(html));
A.ok('reply: update text is escaped', /Scheduled &lt;b&gt;10\/9&lt;\/b&gt;/.test(html) && !/<b>10/.test(html));
A.ok('reply: paragraph breaks survive into the email table', /line2<br>line3/.test(html));
var tsv = T.curReplyTsv([row]).split('\n');
A.eq('reply: TSV is one line per row, tabs/newlines flattened', [tsv.length, tsv[1].split('\t').length], [2, 8]);

// ---- 6. PARITY with the Ops Suite Client Update pipeline ---------------------------------------------
var AI = read('bwn-suite-ai.user.js');
function block(src, a, b) {
  var i = src.indexOf(a), j = src.indexOf(b, i);
  if (i === -1 || j === -1) throw new Error(a + ' not found');
  return src.slice(i, j + b.length);
}
[
  ['CU-TRIPS', '// ===== CU-TRIPS:START =====', '// ===== CU-TRIPS:END ====='],
  ['CU-PIPELINE', '// ===== CU-PIPELINE:START =====', '// ===== CU-PIPELINE:END ====='],
  ['stage prompts', 'var SYSTEM_PROMPT_EXTRACT = [', "Keep only approved, client-safe facts.';"]
].forEach(function (p) {
  A.ok('parity: ' + p[0] + ' is byte-identical to bwn-suite-ai', block(TEXT, p[1], p[2]) === block(AI, p[1], p[2]));
});
A.ok('parity: the pipeline really is the client pipeline', /function cuSafetyCheck\(/.test(TEXT) && /Write a concise client-facing work-order update/.test(TEXT));

A.finish();
