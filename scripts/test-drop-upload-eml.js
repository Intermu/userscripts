// test-drop-upload-eml.js - node harness for parseEml (the .eml reader) in bwn-drop-upload.user.js.
//
// WHY THIS EXISTS - the same bug that bit bwn-wo-intake bit Drop Upload: a real Outlook .eml is a
// MIME multipart TREE, not one flat body. The old parseEml split head/body at the first blank line,
// split on ONE boundary, and grabbed the first part whose text matched /text\/plain/ - but that
// substring ALSO matches the NESTED multipart/alternative block, so the whole subtree (inner
// boundary lines + the base64 attachment) got dumped into the WO note as gibberish. This pins the
// multipart walk so the regression can't come back silently. Drop Upload's parseEml returns a
// DIFFERENT shape than wo-intake's: { from, date, subject, to, cc, body } (its Outlook-style note
// block needs From/Sent/To/Cc), and it does NOT extract attachments - so this harness is separate.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). Same proven pattern: slice
// the REAL shipped block out of the userscript and run it in a vm. The fixture is SYNTHETIC (no
// client data) but reproduces the exact structure of the real email that broke:
//   multipart/mixed
//     +- multipart/alternative
//     |    +- text/plain          (quoted-printable)  <- the body we want
//     |    +- text/html           (quoted-printable)
//     +- application/pdf          (base64, attachment) <- must NOT leak into the note

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

// The MIME walker + parseEml + its decode helpers (deqp/deb64/cleanBody), verbatim. The slice ends
// at the .msg CFB reader, which this harness never invokes.
var BLOCK = slice('function splitHeadBody(', 'function parseCFB(', 'parseEml cluster');
var api = { atob: atob, Uint8Array: Uint8Array, String: String, TextDecoder: TextDecoder, decodeURIComponent: decodeURIComponent };
vm.runInNewContext(BLOCK + '\n;this.parseEml=parseEml;', api);

// ---- Build the synthetic multipart/mixed .eml, CRLF like a real one ---------
var CRLF = '\r\n';
var PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
var PDF_B64 = PDF_BYTES.toString('base64').replace(/(.{76})/g, '$1' + CRLF);  // wrapped like Outlook
var LOGO_BYTES = Buffer.from('\x89PNG\r\n\x1a\nFAKE-SIGNATURE-LOGO', 'latin1');
var LOGO_B64 = LOGO_BYTES.toString('base64');
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
  'Doors =96 exterior glass cracked, needs replacement.',   // =96 QP soft byte
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
  '--' + OUT,
  // The sender's signature logo: disposed INLINE and cited by a Content-ID the HTML part
  // references. Both marks together are what make it a signature graphic rather than a file
  // they attached - a part disposed `attachment` is never dropped, whatever else it carries.
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-ID: <image001.png@01D9>',
  'Content-Transfer-Encoding: base64',
  '',
  LOGO_B64,
  '--' + OUT + '--',
  ''
].join(CRLF);

var p = api.parseEml(eml);

console.log('# parseEml - multipart/mixed with nested alternative + PDF attachment');
A.eq('subject', p.subject, 'FF00000 WO# 0000000-00000000 EMERGENCY');
A.ok('from header preserved', /jwoods@example\.com/.test(p.from), JSON.stringify(p.from));
A.ok('to header preserved', /ops@example\.com/.test(p.to), JSON.stringify(p.to));
A.ok('body is the text/plain part', /Doors .* exterior glass cracked, needs replacement\./.test(p.body), JSON.stringify(p.body.slice(0, 80)));
A.ok('body keeps the second line', /Second line stays intact\./.test(p.body), JSON.stringify(p.body));
A.ok('body does NOT leak MIME boundaries/headers', !/Content-Type|Content-Transfer|boundary=|--_00/.test(p.body), JSON.stringify(p.body));
A.ok('body does NOT leak the base64 attachment (JVBER = "%PDF" b64)', !/JVBER/.test(p.body), JSON.stringify(p.body.slice(0, 200)));
A.ok('=96 quoted-printable was decoded (no literal =96 in body)', !/=96/.test(p.body), JSON.stringify(p.body));

// The attachments must not only stay OUT of the note - they must come back OUT of the email, or the
// drop uploads one file and buries the PDF and the photos inside it (the reported bug: "only being
// read as one file with no attachments").
console.log('# parseEml - attachments come back as bytes, signature graphics do not');
A.eq('two attachment parts were seen (the PDF + the signature logo)', p.attachments.length, 2);
var pdf = p.attachments.filter(function (a) { return a.name === '1135344-00000006.pdf'; })[0];
A.ok('the attached PDF is extracted by name', !!pdf, JSON.stringify(p.attachments.map(function (a) { return a.name; })));
A.eq('its mime is carried', pdf.mime, 'application/pdf');
A.eq('its bytes round-trip byte-for-byte through base64', Buffer.from(pdf.bytes).toString('latin1'), PDF_BYTES.toString('latin1'));
A.eq('a real attachment is NOT marked inline', pdf.inline, false);
var logo = p.attachments.filter(function (a) { return a.name === 'logo.png'; })[0];
A.ok('the signature logo is still parsed', !!logo, 'logo part missing');
A.eq('...but MARKED inline (disposed inline + a cited Content-ID), so describeFile drops it', logo.inline, true);

console.log('# parseEml - plain single-part text/plain (the rewrite must not break the simple path)');
var simple = [
  'From: alerts@corrigo.com',
  'Date: Mon, 18 Aug 2026 09:00:00 -0500',
  'Subject: New Service Request',
  'Content-Type: text/plain; charset="us-ascii"',
  '',
  'Location: Store 305',
  'NTE: $650.00'
].join(CRLF);
var s = api.parseEml(simple);
A.ok('simple from present', /alerts@corrigo\.com/.test(s.from), JSON.stringify(s.from));
A.ok('simple date present', /18 Aug 2026/.test(s.date), JSON.stringify(s.date));
A.ok('simple body present', /Location: Store 305[\s\S]*NTE: \$650\.00/.test(s.body), JSON.stringify(s.body));

console.log('# parseEml - single-part base64 text/plain (Outlook non-ASCII bodies)');
var b64body = [
  'From: dispatch@example.com',
  'Subject: b64 body',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('Unit down - please expedite.', 'utf8').toString('base64')
].join(CRLF);
var b = api.parseEml(b64body);
A.ok('base64 body decoded', /Unit down - please expedite\./.test(b.body), JSON.stringify(b.body));

// ---- emailLead: original leads with SUBJECT, reply leads with BODY ----------
// An original WO-request email often has a body that's just a signature (the real ask is the
// subject: WO#/store/EMERGENCY), so lead with "<Sender>: Sent <Subject>". A reply carries its
// content in the body, so lead with "<Responder>: <reply text>". Slices the real lead cluster.
var LEAD = slice('function smtpAddr(', '// ---- Note Type from the email', 'emailLead cluster');
var lapi = { String: String };
vm.runInNewContext(LEAD + '\n;this.emailLead=emailLead;this.isReplyEmail=isReplyEmail;', lapi);

console.log('# emailLead - original (no RE:) leads with the subject');
var orig = { subject: 'FF62336 WO# 1135344-00000006 EMERGENCY', fromName: 'Jo Woods', fromEmail: 'jwoods@caleres.com', body: 'Thanks,\n\n\nJo Woods\nSpecialist, Store Maintenance | CALERES' };
A.ok('original is NOT a reply', lapi.isReplyEmail(orig) === false);
A.eq('original lead = "<Sender>: Sent <Subject>"', lapi.emailLead(orig), 'Jo Woods: Sent FF62336 WO# 1135344-00000006 EMERGENCY');

console.log('# emailLead - reply (RE:) leads with the body');
var reply = { subject: 'RE: FF62336 WO# 1135344-00000006 EMERGENCY', fromName: 'Lisa Porzelt', fromEmail: 'lporzelt@broadwaynational.com', body: 'We dispatched our crew, ETA tomorrow 8am. Please confirm access.\n\nThanks,\nLisa' };
A.ok('reply IS a reply', lapi.isReplyEmail(reply) === true);
A.ok('reply lead leads with the responder + body (not the subject)',
  /^Lisa Porzelt: We dispatched our crew/.test(lapi.emailLead(reply)) && !/Sent RE:/.test(lapi.emailLead(reply)),
  JSON.stringify(lapi.emailLead(reply)));
A.ok('RE: / Re: / RE : / AW: all detected as replies',
  lapi.isReplyEmail({ subject: 'Re: x' }) && lapi.isReplyEmail({ subject: 'RE : x' }) && lapi.isReplyEmail({ subject: 'AW: x' }));

A.finish();
