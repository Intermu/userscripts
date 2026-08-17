// test-eml-parse.js - node harness for parseEml (the .eml reader) in bwn-wo-intake.user.js.
//
// WHY THIS EXISTS - a real Outlook .eml is a MIME multipart TREE, not one flat body. The old
// parseEml split head/body at the first blank line and dumped the entire remainder as the body,
// with no boundary handling: a multipart email therefore fed the boundary lines and per-part
// headers ("Content-Type: text/plain; charset=...", "Content-Transfer-Encoding: quoted-printable")
// straight into the Scope of Work field, and never extracted the attached PDF that carries the real
// WO detail for Caleres/Corrigo. The .msg path worked because it reads a clean body stream + the
// attachment directly; .eml did not. This harness pins the multipart walk so that regression can't
// come back silently.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). Same proven pattern: slice
// the REAL shipped block out of the userscript and run it in a vm. The fixture below is SYNTHETIC
// (no client data committed) but reproduces the exact structure of the real email that broke:
//   multipart/mixed
//     +- multipart/alternative
//     |    +- text/plain          (quoted-printable)  <- the body we want
//     |    +- text/html           (quoted-printable)
//     +- application/pdf          (base64, attachment) <- the bytes we must extract for pdfToText
//
// WHAT IS UNDER TEST - parseEml returns { subject, body, senderEmail, attachments:[{name,bytes,mime}] }:
//   - body is the decoded text/plain part only (no boundary/header leakage)
//   - the PDF is decoded from base64 to the exact original bytes (%PDF magic, byte-for-byte)
//   - a plain single-part text/plain .eml still yields its body (the rewrite must not break it)

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-intake.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startNeedle, endNeedle, what) {
  var a = full.indexOf(startNeedle);
  if (a === -1) throw new Error('SLICE START ABSENT (' + what + '): ' + JSON.stringify(startNeedle.slice(0, 60)));
  var b = full.indexOf(endNeedle, a);
  if (b === -1) throw new Error('SLICE END ABSENT (' + what + '): ' + JSON.stringify(endNeedle.slice(0, 60)));
  return full.slice(a, b);
}

// stripHtml + latin1Of + the MIME helpers + parseEml, verbatim. The slice is a superset (it also
// pulls parseMsg + a few map helpers); their bodies are never invoked, so undefined refs are inert.
var BLOCK = slice('function stripHtml(', 'function pdfToText(', 'parseEml cluster');
var api = { atob: atob, Uint8Array: Uint8Array, String: String };
vm.runInNewContext(BLOCK + '\n;this.parseEml=parseEml;', api);

// ---- Build the synthetic multipart/mixed .eml, CRLF like a real one ---------
var CRLF = '\r\n';
var PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
var PDF_B64 = PDF_BYTES.toString('base64').replace(/(.{76})/g, '$1' + CRLF);  // wrapped like Outlook
var OUT = '_004_SYNTHmixed_';
var INN = '_000_SYNTHalt_';
var eml = [
  'From: Jo Woods <jwoods@example.com>',
  'To: "ops@example.com" <ops@example.com>',
  'Subject: FF00000 WO# 0000000-00000000 EMERGENCY',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed;',
  '\tboundary="' + OUT + '"',
  '',
  'This is a multipart message preamble - must be ignored.',
  '',
  '--' + OUT,
  'Content-Type: multipart/alternative;',
  '\tboundary="' + INN + '"',
  '',
  '--' + INN,
  'Content-Type: text/plain; charset="us-ascii"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Doors =96 exterior glass cracked, needs replacement.',   // =96 QP -> byte 0x96
  'Second line stays intact.',
  '',
  '--' + INN,
  'Content-Type: text/html; charset="us-ascii"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body><p>Doors =96 exterior glass cracked.</p></body></html>',
  '',
  '--' + INN + '--',
  '',
  '--' + OUT,
  'Content-Type: application/pdf; name="1135344-00000006.pdf"',
  'Content-Description: 1135344-00000006.pdf',
  'Content-Disposition: attachment; filename="1135344-00000006.pdf"; size=' + PDF_BYTES.length + ';',
  'Content-Transfer-Encoding: base64',
  '',
  PDF_B64,
  '--' + OUT + '--',
  ''
].join(CRLF);

var p = api.parseEml(eml);

console.log('# parseEml - multipart/mixed with nested alternative + PDF attachment');
A.eq('subject', p.subject, 'FF00000 WO# 0000000-00000000 EMERGENCY');
A.eq('senderEmail', p.senderEmail, 'jwoods@example.com');
A.ok('body is the text/plain part', /Doors .* exterior glass cracked, needs replacement\./.test(p.body), JSON.stringify(p.body.slice(0, 80)));
A.ok('body keeps the second line', /Second line stays intact\./.test(p.body), JSON.stringify(p.body));
A.ok('body does NOT leak MIME boundaries/headers', !/Content-Type|Content-Transfer|boundary=|--_00/.test(p.body), JSON.stringify(p.body));
A.ok('=96 quoted-printable was decoded (no literal =96 in body)', !/=96/.test(p.body), JSON.stringify(p.body));
A.eq('exactly one attachment', p.attachments.length, 1);
A.eq('attachment name', p.attachments[0].name, '1135344-00000006.pdf');
A.eq('attachment mime', p.attachments[0].mime, 'application/pdf');
A.ok('attachment bytes are the exact PDF, byte-for-byte',
  Buffer.from(p.attachments[0].bytes).equals(PDF_BYTES),
  'got ' + p.attachments[0].bytes.length + 'B want ' + PDF_BYTES.length + 'B');
A.ok('attachment starts with %PDF magic',
  String.fromCharCode.apply(null, p.attachments[0].bytes.subarray(0, 4)) === '%PDF');

console.log('# parseEml - plain single-part text/plain (the rewrite must not break the simple path)');
var simple = [
  'From: alerts@corrigo.com',
  'Subject: New Service Request',
  'Content-Type: text/plain; charset="us-ascii"',
  '',
  'Location: Store 305',
  'NTE: $650.00'
].join(CRLF);
var s = api.parseEml(simple);
A.eq('simple senderEmail', s.senderEmail, 'alerts@corrigo.com');
A.ok('simple body present', /Location: Store 305[\s\S]*NTE: \$650\.00/.test(s.body), JSON.stringify(s.body));
A.eq('simple has no attachments', s.attachments.length, 0);

A.finish();
