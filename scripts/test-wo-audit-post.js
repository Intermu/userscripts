// test-wo-audit-post.js - node harness for the WO-audit note-POST helpers (0.10.0).
//
// Slices the PURE `BWN WO-AUDIT POST` block out of the .user.js and runs the real shipped bytes in
// a plain Function (no DOM, no network - same technique as test-wo-audit-flags.js). Covers the
// post-eligibility rule (aged STRICTLY >30d), the WorkOrderNoteInput shape, the idempotency marker
// detection, and the marker embed. Every case carries at least one NEGATIVE control so a rule that
// fired unconditionally (or never) is caught.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-post.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');

function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf('// ===== BWN WO-AUDIT POST START');
  var b = t.indexOf('// ===== BWN WO-AUDIT POST END');
  if (a === -1 || b === -1) throw new Error('BWN WO-AUDIT POST markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = extractSection();

// Build the module from the sliced bytes. The block reads `localStorage` inside noteTypesRaw via a
// try/catch; there is none in this VM, so the read throws, is caught, and noteTypeId falls to its
// floor ({ internal: 13 }) - which is exactly the id these tests assert.
var T = (new Function(
  SECTION + '\n;return { postEligible: postEligible, parseAgeDays: parseAgeDays, noteInput: noteInput,' +
  ' noteTypeId: noteTypeId, simpleHtml: simpleHtml, postBody: postBody, hasPriorAuditNote: hasPriorAuditNote,' +
  ' AUDIT_MARKER: AUDIT_MARKER };'
))();

console.log('WO Audit note-post helpers (0.10.0) - ' + path.basename(SRC));

// 1. eligibility: aged STRICTLY over 30 days, exact boundary excluded.
console.log('\n1. post-eligibility (age > 30, strict)');
A.eq('age 31 -> eligible', T.postEligible(31, false), true);
A.eq('age 30 -> NOT eligible (boundary is >, not >=)', T.postEligible(30, false), false);
A.eq('age 29 -> NOT eligible', T.postEligible(29, false), false);
A.eq('age 100 -> eligible', T.postEligible(100, false), true);
// negative control: with a real days column, a null/blank age cannot be eligible.
A.eq('control: null age with a days column -> NOT eligible', T.postEligible(null, false), false);
// days column ABSENT -> the export is over-30 by construction, so every row qualifies.
A.eq('no days column -> eligible regardless of age', T.postEligible(null, true), true);
A.eq('no days column -> eligible even when the (ignored) age is 5', T.postEligible(5, true), true);

// 1b. parseAgeDays feeds eligibility from the workbook cell.
console.log('\n1b. parseAgeDays');
A.eq('"45" -> 45', T.parseAgeDays('45'), 45);
A.eq('"45 days" -> 45', T.parseAgeDays('45 days'), 45);
A.eq('blank -> null', T.parseAgeDays(''), null);
A.eq('non-numeric -> null', T.parseAgeDays('n/a'), null);
A.eq('null cell -> null', T.parseAgeDays(null), null);
// end-to-end: a 31-day cell string is eligible, a 30-day one is not.
A.eq('cell "31" -> eligible', T.postEligible(T.parseAgeDays('31'), false), true);
A.eq('cell "30" -> NOT eligible', T.postEligible(T.parseAgeDays('30'), false), false);

// 2. noteInput: Internal type id + the fixed flags.
console.log('\n2. noteInput shape');
(function () {
  var t = T.noteTypeId('internal');
  A.eq('Internal note type resolves to the floor id 13', t, 13);
  A.eq('an unknown type name -> null', T.noteTypeId('does-not-exist'), null);
  var body = 'hello';
  var inp = T.noteInput(283834, t, body, T.simpleHtml(body));
  A.eq('workOrderNumber carried', inp.workOrderNumber, 283834);
  A.eq('type is the resolved Internal id', inp.type, 13);
  A.eq('content is the string body', inp.content, 'hello');
  A.eq('isCompletion false', inp.isCompletion, false);
  A.eq('isInvoice false', inp.isInvoice, false);
  A.eq('isPinned false', inp.isPinned, false);
  A.eq('actionNoteEmails null', inp.actionNoteEmails, null);
  A.eq('targetPurchaseOrderNumbers empty', inp.targetPurchaseOrderNumbers, []);
  // negative control: the fixed flags are literally false, not merely falsy/absent.
  A.ok('control: isPinned is present and === false', inp.isPinned === false);
})();

// 2b. simpleHtml escapes and wraps.
console.log('\n2b. simpleHtml');
A.eq('wraps in <p> and escapes <', T.simpleHtml('a < b & c'), '<p>a &lt; b &amp; c</p>');
A.eq('newlines become <br>', T.simpleHtml('one\ntwo'), '<p>one<br>two</p>');

// 3. hasPriorAuditNote: idempotency marker detection.
console.log('\n3. hasPriorAuditNote');
(function () {
  var withMarker = [{ content: 'status update ' + T.AUDIT_MARKER }, { content: 'unrelated' }];
  var without = [{ content: 'unrelated one' }, { content: 'unrelated two' }];
  A.eq('a notes list containing the marker -> true', T.hasPriorAuditNote(withMarker), true);
  A.eq('a notes list without the marker -> false', T.hasPriorAuditNote(without), false);
  A.eq('empty notes -> false', T.hasPriorAuditNote([]), false);
  A.eq('null notes -> false, no crash', T.hasPriorAuditNote(null), false);
  // negative control: a note with no content field must not throw or false-positive.
  A.eq('control: a note missing .content -> false', T.hasPriorAuditNote([{ type: 'x' }]), false);
})();

// 4. postBody embeds the marker (so the posted note is detectable on a re-run).
console.log('\n4. postBody embeds AUDIT_MARKER');
(function () {
  var body = T.postBody('the drafted status note');
  A.ok('postBody contains the marker', body.indexOf(T.AUDIT_MARKER) !== -1, body);
  A.ok('the drafted text is preserved', body.indexOf('the drafted status note') === 0);
  // round-trip: a note built from postBody is seen by hasPriorAuditNote.
  A.eq('control: round-trip - postBody output is detected as a prior audit note',
    T.hasPriorAuditNote([{ content: body }]), true);
  // negative control: the raw drafted text (no postBody) is NOT detected.
  A.eq('control: raw text without postBody is NOT detected',
    T.hasPriorAuditNote([{ content: 'the drafted status note' }]), false);
})();

// 5. days-column detector recognizes the coordinator export's "# Days" header (and safe variants),
// without grabbing an unrelated "... Days" column (SLA/response/completion).
console.log('\n5. days-column header detection ("# Days")');
(function () {
  var src = fs.readFileSync(SRC, 'utf8');
  var m = src.match(/days:\s*findCol\(hdr,\s*\[(\/[^\]]+\/i)\]\)/);
  A.ok('found the days findCol pattern in source', !!m, m && m[0]);
  var re = eval(m[1]);   // the literal regex from the shipped bytes
  A.ok('matches "# Days" (the real coordinator export header)', re.test('# Days'));
  A.ok('matches "#Days" (no space)', re.test('#Days'));
  A.ok('matches "Days"', re.test('Days'));
  A.ok('matches "Days Open"', re.test('Days Open'));
  A.ok('matches "Aged"', re.test('Aged'));
  // negative controls: a non-aging "... Days" column must NOT be grabbed as the age column.
  A.eq('control: "SLA Days" -> not matched', re.test('SLA Days'), false);
  A.eq('control: "Response Days" -> not matched', re.test('Response Days'), false);
  A.eq('control: "Days to Complete" -> not matched', re.test('Days to Complete'), false);
})();

A.finish();
