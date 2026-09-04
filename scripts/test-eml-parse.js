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
// isInlineAttach sits ABOVE stripHtml (it belongs to the .msg reader), so it needs its own slice.
var INLINE = slice('function isInlineAttach(', 'function utf16(', 'inline-attachment mark reader');
var api = { atob: atob, Uint8Array: Uint8Array, String: String };
vm.runInNewContext(INLINE + '\n' + BLOCK + '\n;this.parseEml=parseEml;this.isInlineAttach=isInlineAttach;', api);

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

// ---- The sender's HTML SIGNATURE is not an attachment the requester sent -----------------------
// Outlook ships signature graphics (logo, social icons) as real MAPI attachments. On the Pilot
// store 258 painting request that meant four of the ten "attachments" were a logo and three social
// icons, and all four were uploaded to the WO's Documents alongside the six site photos.
//
// The marks below are the ones MEASURED on that email: the four signature images each carried
// PR_ATTACHMENT_HIDDEN (0x7FFE, PT_BOOLEAN) = true AND PR_ATTACH_FLAGS (0x3714, PT_LONG) with bit
// ATT_MHTML_REF (0x4) set; the six real photos carried NEITHER property. PR_RENDERING_POSITION was
// -1 on ALL TEN, real photos included - the last case below pins that, because a rendering-position
// rule looks right in the docs and would have dropped every photo.
//
// Property stream layout (MS-OXMSG 2.4): 8-byte header, then 16-byte entries of
//   [4B tag: bytes 0-1 = property type LE, bytes 2-3 = property id LE][4B flags][8B value].
console.log('# isInlineAttach - the MAPI marks that separate a signature graphic from a real file');
function propStream(entries) {
  var b = new Uint8Array(8 + entries.length * 16);            // 8-byte header, then the entries
  entries.forEach(function (e, i) {
    var o = 8 + i * 16;
    b[o] = e.type & 0xFF; b[o + 1] = (e.type >> 8) & 0xFF;    // property TYPE (low half of the tag)
    b[o + 2] = e.id & 0xFF; b[o + 3] = (e.id >> 8) & 0xFF;    // property ID   (high half of the tag)
    b[o + 8] = e.value & 0xFF; b[o + 9] = (e.value >>> 8) & 0xFF;
    b[o + 10] = (e.value >>> 16) & 0xFF; b[o + 11] = (e.value >>> 24) & 0xFF;
  });
  return b;
}
var METHOD = { id: 0x3705, type: 0x0003, value: 1 };            // PR_ATTACH_METHOD, on every attachment
var RENDER_NONE = { id: 0x370B, type: 0x0003, value: 0xFFFFFFFF };   // PR_RENDERING_POSITION = -1
var HIDDEN = { id: 0x7FFE, type: 0x000B, value: 1 };
var MHTML_REF = { id: 0x3714, type: 0x0003, value: 4 };

A.eq('a signature graphic (hidden + ATT_MHTML_REF) is inline',
  api.isInlineAttach(propStream([METHOD, RENDER_NONE, HIDDEN, MHTML_REF])), true);
A.eq('PR_ATTACHMENT_HIDDEN alone is enough', api.isInlineAttach(propStream([METHOD, HIDDEN])), true);
A.eq('PR_ATTACH_FLAGS ATT_MHTML_REF alone is enough', api.isInlineAttach(propStream([METHOD, MHTML_REF])), true);
A.eq('a real site photo (neither property) is NOT inline',
  api.isInlineAttach(propStream([METHOD, RENDER_NONE])), false);
A.eq('PR_RENDERING_POSITION -1 does NOT by itself mean inline (it was -1 on the real photos too)',
  api.isInlineAttach(propStream([RENDER_NONE])), false);
A.eq('PR_ATTACH_FLAGS without the MHTML_REF bit is not inline',
  api.isInlineAttach(propStream([{ id: 0x3714, type: 0x0003, value: 1 }])), false);
A.eq('PR_ATTACHMENT_HIDDEN false is not inline',
  api.isInlineAttach(propStream([{ id: 0x7FFE, type: 0x000B, value: 0 }])), false);
A.eq('the id is not confused with the type (0x000B as an ID must not read as HIDDEN)',
  api.isInlineAttach(propStream([{ id: 0x000B, type: 0x7FFE, value: 1 }])), false);
A.eq('no properties stream -> not inline (never drop what we cannot classify)', api.isInlineAttach(null), false);
A.eq('an empty properties stream -> not inline', api.isInlineAttach(new Uint8Array(8)), false);

// ---- The .eml analogue: inline disposition + a Content-ID -------------------------------------
// NOT measured against a real signature .eml (only this synthetic fixture), so the rule is written
// to need BOTH marks: a part disposed `attachment` is never dropped, whatever else it carries.
console.log('# parseEml - an inline signature image is marked, a real attachment is not');
var IMG = Buffer.from('\x89PNG\r\n\x1a\nfake-logo-bytes', 'latin1');
var PHOTO = Buffer.from('\xff\xd8\xff\xe0fake-site-photo-bytes', 'latin1');
var B = '_005_SYNTHsig_';
var sigEml = [
  'From: Alex Roe <alex.roe@example.com>',
  'Subject: 299 store Painting',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed;',
  '\tboundary="' + B + '"',
  '',
  '--' + B,
  'Content-Type: text/plain; charset="us-ascii"',
  '',
  'See attached store. I need a quote to paint this location.',
  '',
  '--' + B,
  'Content-Type: image/png; name="image485826.png"',
  'Content-Disposition: inline; filename="image485826.png"',
  'Content-ID: <image485826.png@70259B92.2165DC4D>',
  'Content-Transfer-Encoding: base64',
  '',
  IMG.toString('base64'),
  '--' + B,
  'Content-Type: image/jpeg; name="original-site.jpeg"',
  'Content-Disposition: attachment; filename="original-site.jpeg"',
  'Content-Transfer-Encoding: base64',
  '',
  PHOTO.toString('base64'),
  '--' + B + '--',
  ''
].join(CRLF);
var sp = api.parseEml(sigEml);
A.eq('both parts are still parsed out (the filter is the caller\'s job, not the parser\'s)', sp.attachments.length, 2);
A.eq('the inline signature image is marked inline', sp.attachments[0].inline, true);
A.eq('the attached site photo is NOT marked inline', sp.attachments[1].inline, false);
A.ok('the site photo bytes survive intact', Buffer.from(sp.attachments[1].bytes).equals(PHOTO));
A.eq('filtering by the mark leaves exactly the real attachment',
  sp.attachments.filter(function (a) { return !a.inline; }).map(function (a) { return a.name; }),
  ['original-site.jpeg']);
// A Content-ID on a part that is disposed `attachment` must NOT drop it - Outlook gives a cid to
// real attachments too (all ten on the Pilot request had one), so the disposition is load-bearing.
A.eq('the earlier PDF attachment is still not inline', p.attachments[0].inline, false);

A.finish();
