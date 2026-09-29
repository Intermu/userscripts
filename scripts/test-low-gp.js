// test-low-gp.js - node harness for bwn-low-gp's LOW-GP-SLICE pure logic.
//
// The two paths that MUST be exact or the feature lies:
//   - the @-mention contentHtml. The mention span ALONE notifies the assignee (actionNoteEmails
//     stays null); a wrong class/attr = a note that pings nobody. Golden string is byte-for-byte
//     the wire capture from 2026-08-17 (W-371126, @Lisa Porzelt), tenant/user GUIDs substituted.
//   - the note-type resolution. Note #1 must be type "Billing" (id 3); a wrong id mis-files a
//     Billing note on a real WO.
//
// Also pins: HTML escaping at the display/write boundary, the WorkOrderNoteInput shape, and the
// assignee-validity gate (a name with no GUID must NOT be treated as notifiable).
//
// Slices the real shipped block out of bwn-low-gp.user.js and runs it in a vm - no stub of the code
// under test. Mutation controls revert an invariant and assert the harness goes red.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-low-gp.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

// Exit guard: the async section ends in A.finish(). If that never runs - a case that never settles
// drains the event loop, or a throw escapes before it - node would otherwise exit 0 on a partial run.
var finished = false;
var realFinish = A.finish;
A.finish = function () { finished = true; realFinish(); };
process.on('exit', function () {
  if (!finished) { console.log('  FAIL- harness exited before A.finish() ran (an async case never settled, or a throw escaped)'); process.exitCode = 1; }
});

var SRC = path.join(__dirname, '..', 'bwn-low-gp.user.js');
function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

var BEGIN = '  // LOW-GP-SLICE-START';
var END = '  // LOW-GP-SLICE-END';

function blockOf(text) {
  var a = text.indexOf(BEGIN);
  if (a === -1) throw new Error('BEGIN marker not found');
  if (text.indexOf(BEGIN, a + 1) !== -1) throw new Error('BEGIN marker not unique');
  var b = text.indexOf(END, a);
  if (b === -1) throw new Error('END marker not found');
  return text.slice(a, b + END.length);
}

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var BLOCK = blockOf(readLF(SRC));

function load(mutations) {
  var src = BLOCK;
  (mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });
  var sandbox = { JSON: JSON, RegExp: RegExp, String: String, Number: Number, parseInt: parseInt, Object: Object, Array: Array, Boolean: Boolean, Date: Date };
  // export the slice's functions/vars by evaluating then grabbing them off the sandbox
  vm.runInNewContext(src + '\nthis.__api = { lgIsGuid: lgIsGuid, lgEsc: lgEsc, lgTypeId: lgTypeId, lgSimpleHtml: lgSimpleHtml, lgMentionHtml: lgMentionHtml, lgPingContent: lgPingContent, lgNoteInput: lgNoteInput, lgRow: lgRow, lgUnwrap: lgUnwrap, lgRankGate: lgRankGate, LOWGP_MIN_RANK: LOWGP_MIN_RANK, lgNote2Gate: lgNote2Gate, lgNormText: lgNormText, lgIsDupLowGp: lgIsDupLowGp, lgFindDupLowGp: lgFindDupLowGp, lgFmtNoteDate: lgFmtNoteDate, lgIsAbort: lgIsAbort, lgNote1Outcome: lgNote1Outcome, LG_UNCERTAIN_MSG: LG_UNCERTAIN_MSG, lgPostErrorView: lgPostErrorView, lgApplyWith: lgApplyWith, lgSessionCtl: lgSessionCtl, NOTE1_CONTENT: NOTE1_CONTENT, PING_MESSAGE: PING_MESSAGE };', sandbox, { filename: 'low-gp-slice.js' });
  return sandbox.__api;
}

var UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
var TEN = '11111111-2222-3333-4444-555555555555';

// The 2026-08-17 wire capture, GUIDs substituted. If this string drifts, the notify is broken.
var GOLDEN = '<p style="font-size: 14px; line-height: 1.4"><span data-type="mention" class="rich-text-editor-mention" data-id="' + UID + '" data-label="Lisa Porzelt" data-tenant="' + TEN + '">@Lisa Porzelt</span> Low GP note added</p>';

var api = load();

console.log('\n-- the @-mention contentHtml is byte-identical to the wire capture --');
A.eq('mention html matches the captured shape', api.lgMentionHtml('Lisa Porzelt', UID, TEN, 'Low GP note added'), GOLDEN);
A.ok('class is the exact SPA mention class', GOLDEN.indexOf('class="rich-text-editor-mention"') !== -1, 'class drift');
A.ok('data-id carries the assignee user GUID', GOLDEN.indexOf('data-id="' + UID + '"') !== -1);
A.ok('data-tenant carries the org GUID', GOLDEN.indexOf('data-tenant="' + TEN + '"') !== -1);

console.log('\n-- HTML escaping at the write boundary --');
var evil = api.lgMentionHtml('A&B <x> "q"', UID, TEN, 'msg <b>& "z"');
A.ok('ampersand escaped in the label', evil.indexOf('A&amp;B') !== -1, evil);
A.ok('angle brackets escaped', evil.indexOf('&lt;x&gt;') !== -1, evil);
A.ok('double-quote escaped so it cannot break out of the attribute', evil.indexOf('&quot;q&quot;') !== -1, evil);
A.ok('no raw unescaped < survives except the tags we emit', evil.indexOf('<x>') === -1, evil);
A.eq('simple html is one escaped paragraph', api.lgSimpleHtml('Low GP'), '<p>Low GP</p>');
A.eq('simple html escapes its body', api.lgSimpleHtml('a<b>&"'), '<p>a&lt;b&gt;&amp;&quot;</p>');

console.log('\n-- plain content mirrors the wire ("@Name message") --');
A.eq('ping content', api.lgPingContent('Lisa Porzelt', 'Low GP note added'), '@Lisa Porzelt Low GP note added');

console.log('\n-- note-type resolution (cache -> floor -> null) --');
var cache = JSON.stringify({ v: 1, ts: 1, map: { '3': 'Billing', '13': 'Internal', '75': 'Low GP', '18': 'Vendor' } });
A.eq('Billing from a live cache', api.lgTypeId('Billing', cache), 3);
A.eq('case-insensitive', api.lgTypeId('billing', cache), 3);
A.eq('Internal from cache', api.lgTypeId('Internal', cache), 13);
A.eq('missing cache falls back to the floor', api.lgTypeId('Billing', null), 3);
A.eq('Internal floor', api.lgTypeId('Internal', null), 13);
A.eq('an unknown type with no cache is null (never guessed)', api.lgTypeId('Nonesuch', null), null);
A.eq('a live cache wins over the floor if it disagrees', api.lgTypeId('Billing', JSON.stringify({ map: { '9': 'Billing' } })), 9);

console.log('\n-- WorkOrderNoteInput shape (matches the captured AddEditWONote) --');
var inp = api.lgNoteInput(371126, 3, 'Low GP', '<p>Low GP</p>');
A.eq('workOrderNumber', inp.workOrderNumber, 371126);
A.eq('type', inp.type, 3);
A.eq('content', inp.content, 'Low GP');
A.eq('contentHtml', inp.contentHtml, '<p>Low GP</p>');
A.eq('isCompletion/isInvoice/isPinned all false', [inp.isCompletion, inp.isInvoice, inp.isPinned], [false, false, false]);
A.eq('actionNoteEmails stays null (the mention span notifies, not this)', inp.actionNoteEmails, null);
A.eq('targetPurchaseOrderNumbers is an empty array', inp.targetPurchaseOrderNumbers, []);

console.log('\n-- assignee validity gate (only a real GUID is notifiable) --');
var withGuid = api.lgRow({ number: 1, assignedTo: UID, assignedToMemberName: 'Lisa Porzelt' });
A.ok('a GUID assignee is notifiable', withGuid.hasAssignee === true && withGuid.assigneeId === UID);
var noId = api.lgRow({ number: 2, assignedTo: '', assignedToMemberName: 'Ghost Name' });
A.ok('a name with no id is NOT notifiable', noId.hasAssignee === false && noId.assigneeId === '');
var badId = api.lgRow({ number: 3, assignedTo: 'not-a-guid', assignedToMemberName: 'X' });
A.ok('a non-GUID id is rejected', badId.hasAssignee === false && badId.assigneeId === '');
A.eq('row carries the identifiers the UI shows', [withGuid.number, api.lgRow({ number: 9, trackingNumber: 'T9', clientName: 'C', locationName: 'L', statusName: 'S' }).tracking], [1, 'T9']);

console.log('\n-- tenant unwrap (localStorage tenantId is JSON-quoted "<guid>") --');
A.eq('a JSON-quoted guid is unwrapped to the bare value', api.lgUnwrap('"' + TEN + '"'), TEN);
A.eq('a bare (unquoted) guid is returned as-is', api.lgUnwrap(TEN), TEN);
A.eq('null becomes empty string', api.lgUnwrap(null), '');
A.eq('a value with stray wrapping quotes is stripped', api.lgUnwrap('"abc"'), 'abc');
A.ok('the unwrapped tenant would NOT inject escaped quotes into the mention',
  api.lgMentionHtml('N', UID, api.lgUnwrap('"' + TEN + '"'), 'm').indexOf('data-tenant="' + TEN + '"') !== -1, 'tenant not clean in attr');

console.log('\n-- ESC-rank visibility floor (manager+, fail-closed) --');
A.eq('floor is manager (rank 4)', api.LOWGP_MIN_RANK, 4);
A.eq('unresolved rank (null) waits, never shows', api.lgRankGate(null), 'wait');
A.eq('non-numeric rank waits (fail-closed)', api.lgRankGate('4'), 'wait');
A.eq('rank 1 staff (Daniel) is hidden', api.lgRankGate(1), 'hide');
A.eq('rank 3 supervisor is still hidden', api.lgRankGate(3), 'hide');
A.eq('rank 4 manager sees it', api.lgRankGate(4), 'show');
A.eq('rank 5 director sees it', api.lgRankGate(5), 'show');

console.log('\n-- mutation controls (each MUST make an assertion above go red) --');
(function () {
  var m = load([['rk < LOWGP_MIN_RANK', 'rk <= LOWGP_MIN_RANK']]);
  A.ok('M4: an off-by-one floor (<=) would leak the button to rank 4', m.lgRankGate(4) !== 'show', 'floor boundary not observable');
})();
(function () {
  var m = load([["(typeof rk !== 'number') ? 'wait'", "(typeof rk !== 'number') ? 'show'"]]);
  A.ok('M5: fail-OPEN on unknown rank would show it', m.lgRankGate(null) !== 'wait', 'fail-closed on null not observable');
})();
(function () {
  var m = load([['class="rich-text-editor-mention"', 'class="mention"']]);
  A.ok('M1: wrong mention class no longer matches the golden', m.lgMentionHtml('Lisa Porzelt', UID, TEN, 'Low GP note added') !== GOLDEN, 'class change was not observable');
})();
(function () {
  var m = load([['actionNoteEmails: null', 'actionNoteEmails: []']]);
  A.ok('M2: actionNoteEmails changed off null is observable', m.lgNoteInput(1, 3, 'x', 'y').actionNoteEmails !== null, 'actionNoteEmails change not observable');
})();
(function () {
  var m = load([["'billing': 3", "'billing': 999"]]);
  A.ok('M3: a wrong Billing floor id is observable', m.lgTypeId('Billing', null) === 999, 'floor change not observable');
})();

// ===== 0.5.0 redesign: session / lock / gate / duplicate / outcome logic ======================
var FULL = readLF(SRC);
// Slice one shipped function by name, brace-counting to its end (the sliced bodies carry no braces in strings).
function fnBody(decl) {
  var a = FULL.indexOf(decl);
  if (a === -1) throw new Error('function not found: ' + decl);
  if (FULL.indexOf(decl, a + 1) !== -1) throw new Error('function not unique: ' + decl);
  for (var d = 0, j = FULL.indexOf('{', a); j < FULL.length; j++) {
    if (FULL[j] === '{') d++;
    else if (FULL[j] === '}') { d--; if (d === 0) return FULL.slice(a, j + 1); }
  }
  throw new Error('unbalanced braces after ' + decl);
}
var CACHE = JSON.stringify({ v: 1, ts: 1, map: { '3': 'Billing', '13': 'Internal', '18': 'Vendor' } });
function typeIdFrom(apiX) { return function (name) { return apiX.lgTypeId(name, CACHE); }; }
function openAtConfirm(c) { c.open(); c.go('loading'); c.go('results'); return c.go('confirm'); }

console.log('\n-- (1) result selection cannot fire Confirm via a double-click or a carried activation --');
(function () {
  var c = api.lgSessionCtl();
  openAtConfirm(c);
  A.ok('a click that did not start on the freshly rendered Confirm is refused', c.canConfirm({ detail: 1 }) === false);
  c.arm();
  A.ok('the second click of a double-click (detail 2) is refused even when armed', c.canConfirm({ detail: 2 }) === false);
  A.ok('a triple-click (detail 3) is refused', c.canConfirm({ detail: 3 }) === false);
  A.ok('a fresh single click armed on the button is accepted', c.canConfirm({ detail: 1 }) === true);
  A.ok('keyboard activation (detail 0) armed by keydown on the button is accepted', c.canConfirm({ detail: 0 }) === true);
  c.go('results');
  c.arm();
  A.ok('arming outside the confirm view is a no-op', c.canConfirm({ detail: 1 }) === false);
  c.go('confirm');
  A.ok('re-rendering the confirm view clears any earlier arming', c.canConfirm({ detail: 1 }) === false);
  c.arm(); c.disarm();
  A.ok('a rejected activation disarms: a new one must start on the button', c.canConfirm({ detail: 1 }) === false);
})();

console.log('\n-- (2) a second Confirm activation during posting is ignored --');
(function () {
  var c = api.lgSessionCtl();
  openAtConfirm(c);
  c.arm();
  var t = c.beginPosting();
  A.ok('first Confirm takes the posting lock synchronously', !!t && c.isPosting() === true && c.phase() === 'posting');
  A.eq('a second beginPosting while posting is refused', c.beginPosting(), null);
  c.arm();
  A.ok('arming during posting cannot re-enable Confirm', c.canConfirm({ detail: 1 }) === false && c.canConfirm({ detail: 0 }) === false);
  A.eq('no view change is possible while posting', c.go('input'), null);
  A.ok('the lock holds until finish()', c.isPosting() === true && c.finish(t, 'done') === true && c.isPosting() === false);
})();

console.log('\n-- (3) stale lookup / post callbacks cannot touch a new session or another WO --');
(function () {
  var c = api.lgSessionCtl();
  c.open();
  var tLookup = c.go('loading');
  c.go('input');                           // Stop waiting / Back
  A.ok('a lookup token is stale once the view moved on', c.isCurrent(tLookup) === false);
  var tWoA = c.go('confirm');              // duplicate-check token for WO A
  c.go('results');
  var tWoB = c.go('confirm');              // WO B picked instead
  A.ok('WO A duplicate-check result cannot land on WO B', c.isCurrent(tWoA) === false && c.isCurrent(tWoB) === true);
  var tOld = c.token();
  c.close(); c.open();
  A.ok('any token from a closed session is stale in the new one', c.isCurrent(tOld) === false);
  var c2 = api.lgSessionCtl();
  openAtConfirm(c2); c2.arm();
  var tPost = c2.beginPosting();
  A.eq('finish() with a stale token is refused and keeps the lock', [c2.finish(tWoB, 'done'), c2.isPosting()], [false, true]);
  A.ok('finish() with the posting token lands', c2.finish(tPost, 'error') === true && c2.phase() === 'error');
})();

console.log('\n-- (4) close / reopen / route change keep the posting session and its terminal outcome --');
(function () {
  var c = api.lgSessionCtl();
  var sid0 = openAtConfirm(c).sid;
  c.arm();
  var t = c.beginPosting();
  A.ok('close is refused while posting', c.canClose() === false && c.close() === false && c.isPosting() === true);
  var re = c.open();
  A.ok('reopening mid-post resumes the SAME session in the posting view', re.resume === true && re.token.sid === sid0 && c.phase() === 'posting');
  A.ok('the in-flight post callback is still current after the reopen', c.isCurrent(t) === true);
  c.finish(t, 'done');
  var re2 = c.open();
  A.ok('a reopen after the panel vanished shows that session\'s terminal outcome', re2.resume === true && re2.token.sid === sid0 && c.phase() === 'done');
  A.ok('closing the terminal view releases the session', c.close() === true);
  var re3 = c.open();
  A.ok('only then does the launcher start a fresh input session', re3.resume === false && re3.token.sid !== sid0 && c.phase() === 'input');
  var mountBody = FULL.slice(FULL.indexOf('  function mount() {'), FULL.indexOf('  var pollTimer = null;'));
  var hooks = FULL.slice(FULL.indexOf('  function lowgpRouteHooks(onChange) {'), FULL.indexOf('  lowgpRouteHooks(schedule);'));
  A.ok('route re-mount (mount / lowgpRouteHooks) never closes or resets the session',
    mountBody.length > 0 && hooks.length > 0 && !/lgClose|ctl\.|lgRestart|lgFreshState/.test(mountBody + hooks));
  var onDoc = fnBody('  function lgOnDoc(e) {'), onKey = fnBody('  function lgOnKey(e) {');
  var launcher = fnBody('  function buildButton() {');
  A.ok('outside mousedown never closes confirm or posting (M1)', onDoc.indexOf('if (MODAL_VIEWS[ctl.phase()]) return;') !== -1 && onDoc.indexOf('if (MODAL_VIEWS[ctl.phase()]) return;') < onDoc.indexOf('lgClose('));
  A.ok('the launcher never closes confirm or posting (M1)', launcher.indexOf('if (MODAL_VIEWS[ctl.phase()]) { lgFocusFirst(p); return; }') !== -1 && launcher.indexOf('MODAL_VIEWS') < launcher.indexOf('lgClose('));
  A.ok('Escape checks the posting lock before any close / cancel', onKey.indexOf('if (ctl.isPosting()) return;') !== -1 &&
    onKey.indexOf('if (ctl.isPosting()) return;') < onKey.indexOf('lgCancelConfirm()') && onKey.indexOf('if (ctl.isPosting()) return;') < onKey.indexOf('lgClose('));
  A.ok('an Escape aimed at the host page is ignored before preventDefault (m2)',
    onKey.indexOf('if (!inside && !(lb && lb.contains(e.target)) && !(bare && MODAL_VIEWS[ctl.phase()])) return;') !== -1 &&
    onKey.indexOf('if (!inside && !(lb') < onKey.indexOf('e.preventDefault()'));
})();

console.log('\n-- (5) an invalid assignee or tenant GUID skips note 2 --');
A.eq('valid assignee + tenant sends', api.lgNote2Gate({ assigneeId: UID }, TEN), { send: true, reason: '' });
A.eq('no assignee GUID -> no-assignee', api.lgNote2Gate({ assigneeId: '' }, TEN), { send: false, reason: 'no-assignee' });
A.eq('a non-GUID assignee -> no-assignee', api.lgNote2Gate({ assigneeId: 'Lisa' }, TEN), { send: false, reason: 'no-assignee' });
A.eq('empty tenant -> tenant-unknown', api.lgNote2Gate({ assigneeId: UID }, ''), { send: false, reason: 'tenant-unknown' });
A.eq('a JSON-quoted (unwrapped wrong) tenant -> tenant-unknown', api.lgNote2Gate({ assigneeId: UID }, '"' + TEN + '"'), { send: false, reason: 'tenant-unknown' });
A.eq('no row -> no-assignee', api.lgNote2Gate(null, TEN), { send: false, reason: 'no-assignee' });

console.log('\n-- (6) duplicate classification: only an active Billing note that is exactly "Low GP" --');
A.ok('exact active Billing "Low GP" matches', api.lgIsDupLowGp({ type: 3, content: 'Low GP', isDeleted: false }, 3) === true);
A.ok('surrounding / internal whitespace is normalized', api.lgIsDupLowGp({ type: 3, content: '  Low \n GP ' }, 3) === true);
A.ok('an absent isDeleted (not selected on jobNotes) reads as active', api.lgIsDupLowGp({ type: 3, content: 'Low GP' }, 3) === true);
A.ok('a deleted note is rejected (defense in depth when the field is present)',api.lgIsDupLowGp({ type: 3, content: 'Low GP', isDeleted: true }, 3) === false);
A.ok('a non-Billing note is rejected', api.lgIsDupLowGp({ type: 13, content: 'Low GP' }, 3) === false);
A.ok('longer text is rejected', api.lgIsDupLowGp({ type: 3, content: 'Low GP - check vendor cost' }, 3) === false);
A.ok('the @-mention note text is rejected', api.lgIsDupLowGp({ type: 3, content: '@Lisa Porzelt Low GP note added' }, 3) === false);
A.ok('different case is rejected (exact match only)', api.lgIsDupLowGp({ type: 3, content: 'low gp' }, 3) === false);
A.ok('an unrelated note is rejected', api.lgIsDupLowGp({ type: 3, content: 'Called vendor' }, 3) === false);
A.ok('a string type id is not coerced', api.lgIsDupLowGp({ type: '3', content: 'Low GP' }, 3) === false);
A.ok('no Billing id -> never a match', api.lgIsDupLowGp({ type: 3, content: 'Low GP' }, null) === false);
var dupNotes = [{ id: 1, type: 13, content: 'Low GP' }, { id: 2, type: 3, content: 'Low GP', isDeleted: true }, { id: 3, type: 3, content: 'Low GP', createdDate: '2026-08-17T23:30:00Z' }];
A.eq('find returns the first active Billing match', [api.lgFindDupLowGp(dupNotes, 3).status, api.lgFindDupLowGp(dupNotes, 3).note.id], ['found', 3]);
A.eq('no match -> none', api.lgFindDupLowGp([{ type: 3, content: 'x' }], 3).status, 'none');
A.eq('an empty list -> none', api.lgFindDupLowGp([], 3).status, 'none');
A.eq('a failed / missing read -> unknown (never "none")', [api.lgFindDupLowGp(undefined, 3).status, api.lgFindDupLowGp(null, 3).status, api.lgFindDupLowGp({}, 3).status], ['unknown', 'unknown', 'unknown']);
A.eq('an unresolved Billing id -> unknown', api.lgFindDupLowGp([], null).status, 'unknown');
A.eq('date shown from the literal date part (no timezone shift)', api.lgFmtNoteDate('2026-08-17T23:30:00Z'), '8/17/2026');
A.eq('date without a time part', api.lgFmtNoteDate('2026-01-05'), '1/5/2026');
A.eq('an unparseable date is omitted', [api.lgFmtNoteDate(''), api.lgFmtNoteDate(null), api.lgFmtNoteDate('Aug 17'), api.lgFmtNoteDate('2026-13-01')], ['', '', '', '']);
A.ok('the duplicate text is the note 1 body', api.NOTE1_CONTENT === 'Low GP');

console.log('\n-- (7) note 1 failure: uncertain network outcomes get cautious, non-retry copy --');
function errWith(msg, flags) { var e = new Error(msg); Object.keys(flags || {}).forEach(function (k) { e[k] = flags[k]; }); return e; }
A.eq('fetch rejection -> uncertain', api.lgNote1Outcome(new TypeError('Failed to fetch')), 'uncertain');
A.eq('non-JSON 5xx body (SyntaxError) -> uncertain', api.lgNote1Outcome(new SyntaxError('Unexpected token < in JSON at position 0')), 'uncertain');
A.eq('timeout -> uncertain', api.lgNote1Outcome(new Error('Request timed out')), 'uncertain');
A.eq('unrecognized write response -> uncertain', api.lgNote1Outcome(errWith('addEditJobNote: unrecognized write response (no {success} under data.addEditJobNote)', { bwnNonTransient: true })), 'uncertain');
A.eq('nothing thrown / a bare value -> uncertain', [api.lgNote1Outcome(null), api.lgNote1Outcome('x')], ['uncertain', 'uncertain']);
A.eq('success:false refusal -> refused', api.lgNote1Outcome(errWith('Work order is closed', { bwnNonTransient: true })), 'refused');
A.eq('GraphQL errors[] with NO data (rejected pre-execution) -> refused', api.lgNote1Outcome(errWith('Variable "$addEditInput" got invalid value', { lgGqlError: true })), 'refused');
var execErr = errWith('Object reference not set to an instance of an object.', { lgGqlError: true, lgGqlExecuted: true });
A.eq('GraphQL errors[] WITH data (execution ran) -> uncertain', api.lgNote1Outcome(execErr), 'uncertain');
A.eq('errors+data shows the cautious copy with close only', [api.lgPostErrorView(execErr, 1).text, api.lgPostErrorView(execErr, 1).actions], [api.LG_UNCERTAIN_MSG, ['close']]);
A.ok('lgGql flags an errors[] response that carried a data object',
  fnBody('  function lgGql(op, query, variables, signal) {').indexOf("if (j.data && typeof j.data === 'object') ge.lgGqlExecuted = true;") !== -1);
A.eq('kill switch denial -> refused', api.lgNote1Outcome(new Error('bwnGqlOp: feature "lowGp" is disabled')), 'refused');
A.eq('permission denial -> refused', api.lgNote1Outcome(errWith('bwnGqlOp: "addEditJobNote" needs Umbrava permission WorkOrderNote.AddNew - the write was NOT sent.', { bwnNonTransient: true })), 'refused');
A.eq('not signed in (nothing sent) -> refused', api.lgNote1Outcome(errWith('Not signed in to Umbrava (no app token found).', { lgNotSent: true })), 'refused');
var unc = api.lgPostErrorView(new TypeError('Failed to fetch'), 371126);
A.eq('uncertain copy is exact', unc.text, 'We could not confirm whether the Billing note was posted. Check the WO notes before trying again.');
A.eq('uncertain outcome offers ONLY close - no retry, no back-to-repost', unc.actions, ['close']);
A.ok('uncertain outcome never claims "Nothing was posted"', unc.title.indexOf('Nothing') === -1 && unc.text.indexOf('Nothing') === -1);
var ref = api.lgPostErrorView(errWith('Work order is closed', { bwnNonTransient: true }), 371126);
A.eq('refused outcome says nothing was posted, with the reason', [ref.kind, ref.text, ref.detail], ['refused', 'Nothing was posted to WO #371126.', 'Work order is closed']);
A.ok('no outcome carries a retry action', ['retry', 'repost'].every(function (x) { return unc.actions.indexOf(x) === -1 && ref.actions.indexOf(x) === -1; }));
A.ok('the UI has no retry control', !/Retry|Try again'/.test(FULL));

console.log('\n-- (8) no dependency on the dead \'low gp\': 75 floor --');
A.eq('"Low GP" is not a resolvable note type without a cache', api.lgTypeId('Low GP', null), null);
A.ok('the source has no \'low gp\' floor key', !/'low gp'\s*:/i.test(FULL));
A.ok('the source has no 75 literal anywhere', !/\b75\b/.test(FULL));

console.log('\n-- reads abort cleanly; writes never get a signal --');
A.ok('an AbortError is recognized', api.lgIsAbort({ name: 'AbortError' }) === true);
A.ok('an ordinary failure is not an abort', api.lgIsAbort(new TypeError('Failed to fetch')) === false && api.lgIsAbort(null) === false);
var searchFn = FULL.slice(FULL.indexOf('  function lgSearch(text, opts) {'), FULL.indexOf('  var LG_NOTES_Q'));
A.ok('an aborted lookup is re-thrown BEFORE the slow fallback can fire',
  searchFn.indexOf('if (lgIsAbort(err)) throw err;') !== -1 && searchFn.indexOf('if (lgIsAbort(err)) throw err;') < searchFn.indexOf('lgSearchSlow('));
A.ok('the write transport (bwnGql) calls lgGql with no signal', FULL.indexOf('return lgGql(q.slice(i, j) || null, query, variables);') !== -1);
A.ok('the duplicate read does not select the unproven isDeleted field on jobNotes', !/jobNotes\([^)]*\)\{[^}]*isDeleted/.test(FULL));
A.ok('the duplicate read is the named jobNotes query, no page/sortBy',
  FULL.indexOf("query BwnLowGpNotes($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content createdDate } }") !== -1);

console.log('\n-- DOM wiring guards (static: each pins a UI-side guard the pure tests cannot reach) --');
(function () {
  var conf = fnBody('  function lgViewConfirm(b) {');
  var fill = fnBody('  function lgFillDup(el, res) {'), dupChk = fnBody('  function lgStartDupCheck(el, woNumber) {');
  var find = fnBody('  function lgDoFind() {'), apply = fnBody('  function lgDoApply(e) {');
  A.ok('(n) the confirm button arms on Enter/Space keydown',
    conf.indexOf("apply.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') ctl.arm(); });") !== -1);
  A.ok('(n) ... and on pointerdown / mousedown (primary button only)',
    conf.indexOf("apply.addEventListener('pointerdown', function (e) { if (e.button === 0) ctl.arm(); });") !== -1 &&
    conf.indexOf("apply.addEventListener('mousedown', function (e) { if (e.button === 0) ctl.arm(); });") !== -1);
  A.ok('(o) the confirm view focuses Cancel, never Confirm', /return cancel;\s+\/\/ focus lands on Cancel/.test(conf) && conf.indexOf('return apply') === -1);
  A.ok('(r) the duplicate path never disables Confirm', (fill + dupChk).indexOf('disabled') === -1);
  A.ok('(s) the duplicate-check callback captures a token and checks it before painting',
    dupChk.indexOf('var tok = ctl.token();') !== -1 && dupChk.indexOf('if (!ctl.isCurrent(tok) || !el.isConnected) return;') < dupChk.indexOf('lgFillDup(el, res)') &&
    dupChk.indexOf('if (!ctl.isCurrent(tok) || !el.isConnected) return;') !== -1);
  var resolve = find.slice(find.indexOf('}).then(function (rows) {'), find.indexOf('}, function (err) {'));
  var reject = find.slice(find.indexOf('}, function (err) {'));
  A.ok('(t) the lookup-resolve callback checks its token before touching state',
    resolve.indexOf('if (!ctl.isCurrent(tok)) return;') !== -1 && resolve.indexOf('if (!ctl.isCurrent(tok)) return;') < resolve.indexOf('st.rows = rows'));
  A.ok('(t) ... and so does the lookup-reject callback', reject.indexOf('if (!ctl.isCurrent(tok)) return;') !== -1 && reject.indexOf('if (!ctl.isCurrent(tok)) return;') < reject.indexOf('st.error'));
  A.ok('(t) ... and the expanded-phase callback', find.indexOf('if (!ctl.isCurrent(tok)) return;\n        st.lookupPhase = ph;') !== -1);
  A.ok('(b) lgDoApply returns on the posting lock before anything else', /^  function lgDoApply\(e\) \{\n    if \(ctl\.isPosting\(\)\) return;/.test(apply));
  A.ok('(b) ... and takes the lock before the write call', apply.indexOf('ctl.beginPosting()') < apply.indexOf('lgApply('));
  A.ok('(R3) the duplicate answer lands in a height-reserved slot ABOVE the button row',
    conf.indexOf("lgEl('div', 'bwn-lg-dupslot')") !== -1 && conf.indexOf('desc.appendChild(slot)') !== -1 &&
    conf.indexOf('desc.appendChild(slot)') < conf.indexOf('b.appendChild(actions)') &&
    /'\.bwn-lg-dupslot\{min-height:calc\(6em \+ 28px\);\}'/.test(FULL));
  var rend = fnBody('  function render() {');
  A.ok('(m1) a non-modal render only moves focus when it is already ours or nowhere', /var ours = !a \|\| a === document\.body \|\| p\.contains\(a\) \|\| \(lb && lb\.contains\(a\)\);/.test(rend));
  A.ok('(N1) a modal view (confirm / posting) always takes focus; the ours-rule gates only non-modal views',
    rend.indexOf('if ((MODAL_VIEWS[view] || ours) && focusEl && focusEl.focus) focusEl.focus();') !== -1);
  var onKey2 = fnBody('  function lgOnKey(e) {');
  A.ok('(N2) in a modal view an Escape on the bare document (body / html) is still handled',
    onKey2.indexOf('var bare = e.target === document.body || e.target === document.documentElement;') !== -1 &&
    onKey2.indexOf('!(bare && MODAL_VIEWS[ctl.phase()])') !== -1 &&
    onKey2.indexOf('!(bare && MODAL_VIEWS[ctl.phase()])') < onKey2.indexOf('e.preventDefault()'));
  A.ok('(N2) ... and posting stays inert for it (lock checked before cancel / close)',
    onKey2.indexOf('if (ctl.isPosting()) return;') > onKey2.indexOf('e.stopPropagation()') && onKey2.indexOf('if (ctl.isPosting()) return;') < onKey2.indexOf('lgCancelConfirm()'));
  A.ok('(m3) the focusin guard is added for modal views and removed otherwise / on close',
    rend.indexOf("if (MODAL_VIEWS[view]) document.addEventListener('focusin', lgOnFocusIn, true);") !== -1 &&
    rend.indexOf("else document.removeEventListener('focusin', lgOnFocusIn, true);") !== -1 &&
    fnBody('  function lgClose(returnFocus) {').indexOf("document.removeEventListener('focusin', lgOnFocusIn, true);") !== -1 &&
    fnBody('  function lgOnFocusIn(e) {').indexOf("document.removeEventListener('focusin', lgOnFocusIn, true); return;") !== -1);
  var mnt = fnBody('  function mount() {');
  A.ok('(m5) aria-expanded is derived from whether the panel is in the document',
    fnBody('  function lgSyncLauncher(btn) {').indexOf("b.setAttribute('aria-expanded', lgPanel() ? 'true' : 'false');") !== -1);
  A.ok('(m5) the mount poll re-syncs an already-mounted launcher, so a host-removed panel reads collapsed',
    mnt.indexOf('if (existing && existing.isConnected) { lgSyncLauncher(existing); return true; }') !== -1);
  A.ok('(m5) mount gating is unchanged: perm gate, rank wait/hide, then the idempotent existing check',
    mnt.indexOf("if (!bwnCan('WorkOrderNote.AddNew')) return true;") !== -1 && mnt.indexOf("if (lgGate === 'wait') return false;") !== -1 &&
    mnt.indexOf("if (lgGate === 'hide') return true;") < mnt.indexOf('lgSyncLauncher(existing)') &&
    mnt.indexOf("if (lgGate === 'hide') return true;") !== -1);
})();

console.log('\n-- contrast: focus ring + input border tokens --');
(function () {
  var ringLine = FULL.split('\n').filter(function (l) { return l.indexOf(':focus-visible{') !== -1; });
  var inputLine = FULL.split('\n').filter(function (l) { return l.indexOf("'.bwn-lg-input{") !== -1; });
  A.eq('exactly one focus-visible rule and one .bwn-lg-input rule', [ringLine.length, inputLine.length], [1, 1]);
  A.ok('(B1) the focus ring is 2px solid var(--bwn-text-strong,#0d3d26) with a 2px offset',
    ringLine[0].indexOf('{outline:2px solid var(--bwn-text-strong,#0d3d26);outline-offset:2px;}') !== -1);
  A.ok('(B1) the focus ring no longer uses --bwn-green', ringLine[0].indexOf('--bwn-green') === -1);
  A.ok('(B2) the input border is 1px solid var(--bwn-text-muted,#64748b)', inputLine[0].indexOf('border:1px solid var(--bwn-text-muted,#64748b);') !== -1);
  A.ok('(B2) #cbd5e1 no longer appears in the input rule', inputLine[0].indexOf('#cbd5e1') === -1);
})();

console.log('\n-- redesign mutation controls (each MUST make a guard above go red) --');
(function () {
  var m = load([['s.armed === true && ', '']]);
  var c = m.lgSessionCtl(); openAtConfirm(c);
  A.ok('M6: dropping the arming check lets a carried click confirm', c.canConfirm({ detail: 1 }) === true, 'arming not observable');
})();
(function () {
  var m = load([["if (s.posting || s.phase !== 'confirm') return null;", 'if (false) return null;']]);
  var c = m.lgSessionCtl(); openAtConfirm(c); c.arm(); c.beginPosting();
  A.ok('M7: dropping the posting lock lets a second Confirm start', c.beginPosting() !== null, 'lock not observable');
})();
(function () {
  var m = load([['return !!t && t.sid === s.sid && t.gen === s.gen;', 'return !!t && t.gen === s.gen;']]);
  var c = m.lgSessionCtl(); c.open(); var t0 = c.token(); c.close(); c.open();
  // close() bumps gen, open() resets it to 0: without the sid check a session-1 token looks current.
  A.ok('M8: dropping the session id check lets an old session\'s callback land', c.isCurrent(t0) === true, 'sid guard not observable');
})();
(function () {
  var m = load([["    return 'uncertain';\n  }\n  var LG_UNCERTAIN_MSG", "    return 'refused';\n  }\n  var LG_UNCERTAIN_MSG"]]);
  A.ok('M9: defaulting unknown failures to "refused" is observable', m.lgNote1Outcome(new SyntaxError('bad json')) === 'refused', 'default not observable');
})();
(function () {
  var m = load([['if (!lgIsGuid(tenant)) return', 'if (false) return']]);
  A.ok('M10: dropping the tenant GUID gate is observable', m.lgNote2Gate({ assigneeId: UID }, '').send === true, 'tenant gate not observable');
})();

// ---- async: the injected two-note orchestrator (order, gate, no rollback, truthful outcome) ----
function fakePost(plan) {
  var calls = [];
  return {
    calls: calls,
    post: function (input) {
      calls.push(input);
      var step = plan[calls.length - 1];
      return step === 'ok' ? Promise.resolve({ id: calls.length }) : Promise.reject(step);
    }
  };
}
var asyncRan = 0;
var ROW = { number: 371126, assigneeName: 'Lisa Porzelt', assigneeId: UID, hasAssignee: true };
Promise.resolve().then(function () {
  console.log('\n-- (2/4/5) lgApplyWith: Billing first, Internal mention only after, per-note truth --');
  var f = fakePost(['ok', 'ok']), steps = [];
  return api.lgApplyWith(ROW, { post: f.post, typeId: typeIdFrom(api), tenant: TEN, onStep: function (n) { steps.push(n); } }).then(function (r) {
    asyncRan++;
    A.eq('both notes posted -> note1 + note2 true', [r.note1, r.note2, r.note2skipped, r.note2error], [true, true, false, '']);
    A.eq('exactly two writes, Billing (3) then Internal (13)', f.calls.map(function (x) { return x.type; }), [3, 13]);
    A.eq('note 1 body is "Low GP"', [f.calls[0].content, f.calls[0].contentHtml], ['Low GP', '<p>Low GP</p>']);
    A.eq('note 2 carries the golden mention html', f.calls[1].contentHtml, GOLDEN);
    A.eq('note 2 plain content', f.calls[1].content, '@Lisa Porzelt Low GP note added');
    A.eq('actionNoteEmails stays null on both', [f.calls[0].actionNoteEmails, f.calls[1].actionNoteEmails], [null, null]);
    A.eq('progress step 2 is reported only after note 1 resolved', steps, [2]);
  });
}).then(function () {
  var f = fakePost(['ok']);
  return api.lgApplyWith({ number: 5, assigneeName: 'Ghost', assigneeId: '', hasAssignee: false }, { post: f.post, typeId: typeIdFrom(api), tenant: TEN }).then(function (r) {
    asyncRan++;
    A.eq('(5) no assignee GUID: one write, note2skipped no-assignee', [f.calls.length, r.note1, r.note2, r.note2skipped, r.note2skipReason], [1, true, false, true, 'no-assignee']);
  });
}).then(function () {
  var f = fakePost(['ok']);
  return api.lgApplyWith(ROW, { post: f.post, typeId: typeIdFrom(api), tenant: 'not-a-guid' }).then(function (r) {
    asyncRan++;
    A.eq('(5) bad tenant GUID: one write, note2skipped tenant-unknown', [f.calls.length, r.note2skipped, r.note2skipReason], [1, true, 'tenant-unknown']);
  });
}).then(function () {
  var f = fakePost(['ok', new Error('mention refused')]);
  return api.lgApplyWith(ROW, { post: f.post, typeId: typeIdFrom(api), tenant: TEN }).then(function (r) {
    asyncRan++;
    A.eq('note 2 failure keeps note 1 (no rollback, no third write)', [f.calls.length, r.note1, r.note2, r.note2error], [2, true, false, 'mention refused']);
  });
}).then(function () {
  var f = fakePost([new TypeError('Failed to fetch')]);
  return api.lgApplyWith(ROW, { post: f.post, typeId: typeIdFrom(api), tenant: TEN }).then(function () {
    A.ok('(7) a note 1 network failure must reject', false);
  }, function (err) {
    asyncRan++;
    var v = api.lgPostErrorView(err, ROW.number);
    A.eq('(7) note 1 network failure: one attempt, no note 2, cautious copy, close only',
      [f.calls.length, v.kind, v.text, v.actions], [1, 'uncertain', api.LG_UNCERTAIN_MSG, ['close']]);
  });
}).then(function () {
  var f = fakePost([]);
  return api.lgApplyWith(ROW, { post: f.post, typeId: function () { return null; }, tenant: TEN }).then(function () {
    A.ok('an unresolved Billing type must reject', false);
  }, function (err) {
    asyncRan++;
    A.eq('unresolved Billing type: zero writes and a definite "nothing posted"', [f.calls.length, api.lgNote1Outcome(err)], [0, 'refused']);
  });
}).then(function () {
  // (4) the posting session survives a close attempt and renders ITS terminal outcome.
  var c = api.lgSessionCtl(), f = fakePost(['ok', 'ok']), landed = null;
  openAtConfirm(c); c.arm();
  var t = c.beginPosting();
  var p = api.lgApplyWith(ROW, { post: f.post, typeId: typeIdFrom(api), tenant: TEN }).then(function (r) { if (c.finish(t, 'done')) landed = r; });
  c.close(); c.open();                    // user tries to close + reopen mid-post
  return p.then(function () {
    asyncRan++;
    A.ok('(4) the terminal outcome lands in the SAME held session after a close/reopen attempt',
      landed && landed.note1 === true && landed.note2 === true && c.phase() === 'done' && c.open().resume === true);
  });
}).then(function () {
  A.eq('every async case ran (not green by absence)', asyncRan, 7);
  A.finish();
}, function (e) {
  A.ok('async section threw: ' + (e && e.stack || e), false);
  A.finish();
});
