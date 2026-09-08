// test-drop-upload-doc-summary.js - node harness for the per-document AI 1-line summary added to
// bwn-drop-upload.user.js (v1.25.0). Drop Upload is @grant none / zero-egress, so it asks the
// grant-holding sibling (bwn-suite-ai) to run the CLOUD summary over the shared bwn:cmd/bwn:evt
// bus, falling back to its OWN on-device model only when no sibling answers. This pins:
//   - summarizableDoc / isPlainText: which uploads get a summary (PDF + plain text; NOT photos).
//   - oneLineClip: the model's answer is collapsed to one clean line, leading dash/quote stripped, capped.
//   - busSummarize: dispatches ai:summarize, resolves on the matching ai:summarized reply; a
//     no-reply (sibling absent) resolves answered:false.
//   - summarizeDocText: bus-answered text is FINAL (empty or not); a no-reply falls to on-device bwnAI;
//     too-little text returns '' without asking anyone.
//   - buildNoteText: a document's summary rides UNDER its file line; the single-email attachment list too.
//
// NOT jsdom (no npm on this machine). Same pattern as the sibling harnesses: slice the REAL shipped
// blocks out of the userscript and run them in a vm with a minimal document-bus + bwnAI stub.

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-drop-upload.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startNeedle, endNeedle, what) {
  var a = full.indexOf(startNeedle);
  if (a === -1) throw new Error('SLICE START ABSENT (' + what + '): ' + JSON.stringify(startNeedle.slice(0, 60)));
  var b = full.indexOf(endNeedle, a);
  if (b === -1) throw new Error('SLICE END ABSENT (' + what + '): ' + JSON.stringify(endNeedle.slice(0, 60)));
  return full.slice(a, b);
}

// isPlainText + summarizableDoc + readers + extractDocText + oneLineClip + busSummarize + summarizeDocText
var DOC = slice('function isPlainText(f) {', '  // Build per file: {kind, name, size', 'doc-summary helpers');
// buildNoteText (+ NOTE_CAP).
var NOTE = slice('var NOTE_CAP = 6000;', '// ---- Umbrava upload dialog plumbing', 'buildNoteText');

// --- minimal document bus: synchronous dispatch, add/remove listener ---
function makeDoc() {
  var listeners = {};
  return {
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: function (t, fn) { listeners[t] = (listeners[t] || []).filter(function (f) { return f !== fn; }); },
    dispatchEvent: function (ev) { (listeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); }); return true; }
  };
}
function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }

var doc = makeDoc();
var ondeviceAnswer = '';                 // what the LOCAL bwnAI stub returns (on-device tier)
function bwnAI(opts) { return Promise.resolve(ondeviceAnswer); }

var ctx = {
  Promise: Promise, JSON: JSON, String: String, Math: Math, Date: Date, parseInt: parseInt, parseFloat: parseFloat,
  document: doc, CustomEvent: CustomEvent, bwnAI: bwnAI,
  // fast timers: the real code waits 14s for a bus reply; collapse to a macrotask so the no-reply
  // path resolves promptly in the harness (ordering vs the synchronous reply is preserved).
  setTimeout: function (fn) { return setTimeout(fn, 0); }, clearTimeout: clearTimeout,
  // stubs for refs the slice mentions but these tests never exercise:
  pdfToText: function () { return Promise.resolve(''); }, shortDate: function () { return '9/8'; },
  FileReader: function () { }
};
vm.runInNewContext(
  DOC + '\n' + NOTE + '\n' +
  ';this.isPlainText=isPlainText;this.summarizableDoc=summarizableDoc;this.oneLineClip=oneLineClip;' +
  'this.busSummarize=busSummarize;this.summarizeDocText=summarizeDocText;this.buildNoteText=buildNoteText;',
  ctx
);

// A fake "suite-ai": on ai:summarize, synchronously reply ai:summarized with a fixed text.
// Returns a detach fn. Pass null text to answer EMPTY (cloud+on-device both missed on that side).
function attachSibling(replyText) {
  function onCmd(e) {
    var d = e && e.detail; if (!d || d.id !== 'ai:summarize') return;
    doc.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'ai:summarized', rid: d.rid, text: replyText == null ? '' : replyText } }));
  }
  doc.addEventListener('bwn:cmd', onCmd);
  return function () { doc.removeEventListener('bwn:cmd', onCmd); };
}

var LONG = 'This invoice from Acme HVAC bills 1200 dollars for a compressor replacement on rooftop unit 3, completed 9/2.';

(async function () {
  console.log('# which uploads get a summary (summarizableDoc / isPlainText)');
  A.ok('PDF is summarizable', ctx.summarizableDoc({ name: 'inv.pdf' }, 'PDF'));
  A.ok('.txt is summarizable', ctx.summarizableDoc({ name: 'notes.txt' }, 'Document'));
  A.ok('.csv is summarizable', ctx.summarizableDoc({ name: 'lines.csv' }, 'Spreadsheet'));
  A.ok('a Photo is NOT summarizable', !ctx.summarizableDoc({ name: 'site.jpg' }, 'Photo'));
  A.ok('a .docx is NOT summarizable (binary, no text reader)', !ctx.summarizableDoc({ name: 'scope.docx' }, 'Document'));
  A.ok('text/* mime counts as plain text', ctx.isPlainText({ name: 'x', type: 'text/plain' }));

  console.log('\n# oneLineClip: one clean line, leading dash/quote stripped, capped');
  A.eq('collapses whitespace + newlines', ctx.oneLineClip('  Invoice   for\n  a compressor  '), 'Invoice for a compressor');
  A.eq('strips a leading dash the model adds', ctx.oneLineClip('- Proposal to reseal the lot'), 'Proposal to reseal the lot');
  A.eq('strips a leading quote', ctx.oneLineClip('"Quote for 2 RTUs"'), 'Quote for 2 RTUs');
  A.ok('caps overlong output with an ellipsis', ctx.oneLineClip(new Array(60).join('word '), 60).length <= 61 && /…$/.test(ctx.oneLineClip(new Array(60).join('word '), 60)));

  console.log('\n# summarizeDocText: cloud (bus) primary is FINAL when a sibling answers');
  var detach = attachSibling('Acme HVAC invoice, $1200, RTU-3 compressor replacement.');
  ondeviceAnswer = 'ON-DEVICE SHOULD NOT BE USED';
  var s1 = await ctx.summarizeDocText(LONG);
  A.eq('uses the sibling cloud reply, not on-device', s1, 'Acme HVAC invoice, $1200, RTU-3 compressor replacement.');
  detach();

  console.log('\n# an empty sibling reply is still FINAL (its on-device missed too) - no local retry');
  var detach2 = attachSibling(null);                 // answers, but empty
  ondeviceAnswer = 'LOCAL WOULD BE WRONG HERE';
  var s2 = await ctx.summarizeDocText(LONG);
  A.eq('empty cloud reply -> empty (does not fall to local)', s2, '');
  detach2();

  console.log('\n# no sibling installed -> fall back to our OWN on-device model');
  ondeviceAnswer = 'On-device: invoice for a compressor swap.';
  var s3 = await ctx.summarizeDocText(LONG);
  A.eq('no bus answer -> on-device bwnAI result', s3, 'On-device: invoice for a compressor swap.');

  console.log('\n# too little text -> summarize nobody, return empty');
  var asked = false; var detach3 = attachSibling((asked = true, 'should not be asked'));
  ondeviceAnswer = 'should not be asked';
  var s4 = await ctx.summarizeDocText('too short');
  A.eq('short text yields empty', s4, '');
  detach3();

  console.log('\n# buildNoteText: the summary rides UNDER the document line');
  var note = ctx.buildNoteText([
    { name: 'inv.pdf', kind: 'PDF', size: '120 KB', noteLine: '• inv.pdf - PDF, 120 KB', summaryLine: 'Acme HVAC invoice, $1200.' }
  ]);
  A.ok('doc file line present', note.indexOf('• inv.pdf - PDF, 120 KB') !== -1, note);
  A.ok('summary indented under it', /• inv\.pdf - PDF, 120 KB\n    Acme HVAC invoice, \$1200\./.test(note), note);

  console.log('\n# a doc with no summary is unchanged (photo / scan / model absent)');
  var note2 = ctx.buildNoteText([{ name: 'site.jpg', kind: 'Photo', size: '2.1 MB', noteLine: '• site.jpg - Photo, 2.1 MB' }]);
  A.ok('no trailing summary line', note2.indexOf('• site.jpg - Photo, 2.1 MB') !== -1 && note2.split('\n').length === 2, note2);

  console.log('\n# single email + attachment: the attachment summary shows in the attachment list');
  var note3 = ctx.buildNoteText([
    { name: 'msg.msg', isEmail: true, noteBlock: 'From: a\nSubject: s\n\nbody' },
    { name: 'quote.pdf', kind: 'PDF', size: '80 KB', fromEmail: 'msg.msg', summaryLine: 'Quote for 2 RTUs, $6k.' }
  ]);
  A.ok('email block kept', note3.indexOf('From: a') !== -1, note3);
  A.ok('attachment listed with its summary', /• quote\.pdf - PDF, 80 KB\n    Quote for 2 RTUs, \$6k\./.test(note3), note3);

  A.finish();
})();
