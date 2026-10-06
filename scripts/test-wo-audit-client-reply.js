// test-wo-audit-client-reply.js - node harness for the 0.19.0 Client Update Reply.
//
// Pilot FMs (FM = Store Analyst = the Pilot PO owner) email a list of POs asking for updates. The
// pure CLIENT REPLY block turns that paste into one reviewed reply table per FM. This drives the
// SHIPPED bytes (sliced TIMELINE + STATE + CLIENT REPLY + MAP) and covers:
//   1. paste parsing - the FM's tab table (Outlook wraps cells onto new lines), a reply thread that
//      repeats its PO, the "UPDATE NEEDED" template, and the safety/incident hold,
//   2. the FM rule - audit FM column, else Client Open POs owner, conflicts and gaps surfaced,
//   3. grouping by FM (Unassigned last), deterministic client wording, the client draft gate,
//   4. reply table escaping, and
//   5. PARITY: WOA_CLIENT_SYSTEM must equal bwn-suite-ai's SYSTEM_PROMPT_CLIENT, the client-facing
//      note rules of record.
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
  slice('// ===== BWN WO-AUDIT CLIENT REPLY START', '// ===== BWN WO-AUDIT CLIENT REPLY END') + '\n' +
  slice('// ===== BWN WO-AUDIT MAP START', '// ===== BWN WO-AUDIT MAP END');

var MS_DAY = 86400000;
function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
function auditCfg(key, def) { return def; }
var STALE_DAYS = 7;
var T = (new Function('MS_DAY', '_date', 'auditCfg', 'STALE_DAYS', 'XLSX',
  SECTION + '\n;return { curParsePaste: curParsePaste, curBuildIndex: curBuildIndex, curResolve: curResolve,' +
  ' curGroup: curGroup, curComposeClientNote: curComposeClientNote, curBuildClientInput: curBuildClientInput,' +
  ' curValidateClientNote: curValidateClientNote, curReplyHtml: curReplyHtml, curReplyTsv: curReplyTsv,' +
  ' curFmtDate: curFmtDate, deriveState: deriveState, CUR_STAGE: CUR_STAGE, CUR_UNASSIGNED: CUR_UNASSIGNED,' +
  ' WOA_CLIENT_SYSTEM: WOA_CLIENT_SYSTEM };'))(MS_DAY, _date, auditCfg, STALE_DAYS, null);

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

// ---- 4. deterministic client wording -------------------------------------------------------------
function note(f, h) { return T.curComposeClientNote(f, h, NOW); }
A.eq('wording: materials with no visit states the gap plainly (rule 2)',
  note({ phase: 'materials', ecdText: 'TBD' }, { statusName: 'Material Ordered' }),
  'Parts/materials for this repair are on order. No confirmed scheduling date yet as of 10/5. An expected completion date is not yet confirmed.');
A.eq('wording: a backorder blocker is named in client terms',
  note({ phase: 'materials', primaryBlocker: 'parts on backorder', ecdText: '10/20' }, { statusName: 'Need Material' }),
  'Parts for this repair are on backorder. No confirmed scheduling date yet as of 10/5. Expected completion is 10/20.');
A.eq('wording: scheduled with a future visit gives the date',
  note({ phase: 'scheduled', ecdText: 'TBD' }, { statusName: 'Scheduled', nextOnsiteDate: '2026-10-09T14:00:00' }),
  'Service is scheduled for 10/9. An expected completion date is not yet confirmed.');
A.eq('wording: a past visit date is not promised', /scheduled for/.test(note({ phase: 'scheduled', ecdText: 'TBD' }, { statusName: 'Scheduled', nextOnsiteDate: '2026-09-01T14:00:00' })), false);
A.eq('wording: proposal sent', note({ phase: 'proposal-sent', ecdText: 'TBD' }, { statusName: 'Proposed' }), 'A proposal has been submitted and is awaiting approval.');
A.eq('wording: cancelled is not "complete"', note({ phase: 'terminal' }, { statusName: 'Canceled' }), 'This work order has been cancelled.');
A.eq('wording: closed', note({ phase: 'terminal' }, { statusName: 'Invoiced' }), 'The work is complete.');
A.eq('wording: unmapped status -> nothing invented', note({ phase: null }, { statusName: 'Some New Status' }), '');
A.eq('wording: no live record -> nothing invented', note({ phase: 'materials' }, null), '');
// Every phase's fallback must itself be clean under the client rules - no owners, money or jargon.
Object.keys(T.CUR_STAGE).forEach(function (ph) {
  var s = note({ phase: ph, ecdText: '10/20' }, { statusName: 'x' });
  A.ok('wording: ' + ph + ' fallback carries no internal wording', s && !/coordinator|vendor|purchase order|PO\b|\$|GP|margin/i.test(s), s);
});
// End to end through deriveState: the live header drives the phase.
var fLive = T.deriveState({ statusName: 'Pending Materials Supplier', priority: {} }, [], NOW);
A.ok('wording: live header -> materials wording', /^Parts\/materials for this repair are on order\./.test(note(fLive, { statusName: 'Pending Materials Supplier' })));

// ---- 5. the client draft gate ---------------------------------------------------------------------
var f = { phase: 'materials', currentStage: 'Materials pending', ecdText: 'TBD', terminal: false };
var ground = T.curBuildClientInput({ statusName: 'Material Ordered' }, [{ content: 'Supplier confirmed the compressor ships 10/8.', createdDate: '2026-10-03T10:00:00' }], f, NOW);
var GOOD = 'Parts for this repair are on order and are expected to ship 10/8. No confirmed scheduling date yet as of 10/5.';
A.eq('gate: a grounded, clean update passes (negative control)', T.curValidateClientNote(GOOD, f, ground), '');
A.ok('gate: prompt carries today for rule 2', /^Today: 10\/5/.test(ground));
A.ok('gate: prompt never carries the assignee', !/Assigned/i.test(ground));
[
  ['dollar amount', 'Parts are on order; the repair is approved at $1,350.00 total.'],
  ['email address', 'Parts are on order. Questions to ops@example.com please.'],
  ['phone number', 'Parts are on order. Call 631-555-0100 for details today.'],
  ['internal wording', 'Parts are on order; the coordinator is chasing the supplier.'],
  ['vague filler', 'Parts are on order and this is being handled right now.'],
  ['ungrounded date', 'Parts are on order and the visit is set for 10/12 this month.']
].forEach(function (c) {
  A.ok('gate: rejects ' + c[0], T.curValidateClientNote(c[1], f, ground) !== '', c[1]);
});
A.ok('gate: rejects an empty draft', T.curValidateClientNote('   ', f, ground) !== '');

// A lapsed promise (the 10/06 live run: "expected to arrive by October 5th" shipped on 10/6). The
// date IS grounded, so only the clock can catch it. NOW is 10/5; the evidence carries 10/3 and 10/8.
var groundPast = ground + '\nNote: parts were due 10/3; tech onsite 10/3.';
A.eq('gate: an upcoming grounded date passes with the clock (negative control)',
  T.curValidateClientNote(GOOD, f, groundPast, NOW), '');
A.ok('gate: a past date written as upcoming is rejected',
  /past date \(10\/3\) as upcoming/.test(T.curValidateClientNote('Parts for this repair are expected to arrive by October 3rd. No visit is booked yet.', f, groundPast, NOW)));
A.eq('gate: a past date stated as past is fine',
  T.curValidateClientNote('A technician was on site 10/3 and confirmed parts are needed. No confirmed scheduling date yet as of 10/5.', f, groundPast, NOW), '');
var JAN4 = new Date(2027, 0, 4, 12).getTime(), groundJan = ground + ' 1/8 12/30';
A.eq('gate: across New Year, 1/8 is upcoming', T.curValidateClientNote('Parts for this repair are expected to arrive 1/8.', f, groundJan, JAN4), '');
A.ok('gate: across New Year, 12/30 is last year - rejected as upcoming',
  /past date \(12\/30\)/.test(T.curValidateClientNote('Parts for this repair are expected to arrive 12/30.', f, groundJan, JAN4)));
A.eq('gate: a clause without future wording is not judged by its neighbour',
  T.curValidateClientNote('The proposal was submitted 10/3; work will follow approval.', f, groundPast, NOW), '');
A.ok('gate: an ordinal date is still grounding-checked',
  T.curValidateClientNote('Parts were confirmed and the visit is on October 12th this month.', f, ground, NOW) !== '');

// ---- 6. reply table ---------------------------------------------------------------------------------
var row = { rowNo: '7', fm: 'Fm Alpha', po: '170101000001', store: '101-Travel Center', city: 'Towna', state: 'Statea', date: '7/16/2026', update: 'Scheduled <b>10/9</b>\tline2\nline3' };
// The shipped `esc` lives in the modal closure and is pinned by test-esc-canonical.js; an
// equivalent stand-in here proves curReplyHtml routes every cell through it.
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var html = T.curReplyHtml([row], esc);
A.ok('reply: header row in the FM column order + Update', /<th[^>]*>#<\/th><th[^>]*>FM<\/th><th[^>]*>PO<\/th>.*<th[^>]*>Update<\/th>/.test(html));
A.ok('reply: update text is escaped', /Scheduled &lt;b&gt;10\/9&lt;\/b&gt;/.test(html) && !/<b>10/.test(html));
var tsv = T.curReplyTsv([row]).split('\n');
A.eq('reply: TSV is one line per row, tabs/newlines flattened', [tsv.length, tsv[1].split('\t').length], [2, 8]);

// ---- 7. PARITY with the Ops Suite Client Update rules ------------------------------------------------
function promptOf(src, name) {
  var a = src.indexOf('var ' + name + ' = [');
  var b = src.indexOf('].join(', a);
  if (a === -1 || b === -1) throw new Error(name + ' not found');
  return (new Function('return [' + src.slice(src.indexOf('[', a) + 1, b) + '].join("\\n");'))();
}
var AI = read('bwn-suite-ai.user.js');
A.eq('parity: WOA_CLIENT_SYSTEM == bwn-suite-ai SYSTEM_PROMPT_CLIENT', T.WOA_CLIENT_SYSTEM, promptOf(AI, 'SYSTEM_PROMPT_CLIENT'));
A.ok('parity: the rules really are the client rules', /Never output dollar amounts/.test(T.WOA_CLIENT_SYSTEM));

A.finish();
