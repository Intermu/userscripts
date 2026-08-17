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
  vm.runInNewContext(src + '\nthis.__api = { lgIsGuid: lgIsGuid, lgEsc: lgEsc, lgTypeId: lgTypeId, lgSimpleHtml: lgSimpleHtml, lgMentionHtml: lgMentionHtml, lgPingContent: lgPingContent, lgNoteInput: lgNoteInput, lgRow: lgRow, lgUnwrap: lgUnwrap };', sandbox, { filename: 'low-gp-slice.js' });
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

console.log('\n-- mutation controls (each MUST make an assertion above go red) --');
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

A.finish();
