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
vm.runInNewContext(LEAD + '\n;this.emailLead=emailLead;this.isReplyEmail=isReplyEmail;this.isForward=isForward;this.tidyBody=tidyBody;', lapi);

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

console.log('# emailLead - FORWARD summarizes the forwarded content, not the "FW:" subject');
// A forward's own text is empty; its point is the forwarded message below the quoted-thread cut.
// The lead must read that content, never echo "Sent FW: <subject>" (the Outlook block shows it).
var fwd = {
  subject: 'FW: SHIPMENT NOTIFICATION | 4278378 | SO | BROADWAY NATIONAL SIGN & LIGHTING LLC | PILOT 436 AMARILLO TX',
  fromName: 'Power Play Service', fromEmail: 'PowerPlayService@lsicorp.com',
  body: '\n\nFrom: Power Play Service <PowerPlayService@lsicorp.com>\nSent: Wednesday, September 16, 2026 8:12 AM\nTo: Pilot <Pilot@broadwaynational.com>\nSubject: SHIPMENT NOTIFICATION\n\nYour order has shipped. Tracking information is below: FedEx 771234567890, ETA Friday.'
};
A.ok('FW: is detected as a forward, not an original', lapi.isForward(fwd) === true && lapi.isReplyEmail(fwd) === false);
var fl = lapi.emailLead(fwd);
A.ok('forward lead does NOT echo "Sent FW:"', !/Sent FW:/i.test(fl), JSON.stringify(fl));
A.ok('forward lead reads the forwarded content (sender + tracking prose)',
  /^Power Play Service: /.test(fl) && /Tracking information is below/.test(fl) && !/^\s*From:/m.test(fl),
  JSON.stringify(fl));

// ---- Thread cut: the note carries ONLY the dragged email, never the prior thread -----------
// Reported live: a dropped reply put the whole chain into the WO note. Two causes, both pinned:
//   1. an internal Outlook reply header reads "From: Name" with NO address, and the cut used to
//      require one;
//   2. cleanBody stripped every <...> from a text/plain .eml body, erasing "<addr>" from the quoted
//      From: line, so even an external reply never cut.
console.log('# tidyBody - cuts the quoted thread in every common shape');
var NEW = 'We will be onsite Thursday at 9am.\n\nThanks,\nLisa';
function cutOk(label, quoted) {
  var out = lapi.tidyBody(NEW + '\n\n' + quoted);
  A.ok(label + ': keeps the new message', /onsite Thursday at 9am\.[\s\S]*Lisa$/.test(out), JSON.stringify(out));
  A.ok(label + ': drops the prior thread', !/OLD-THREAD/.test(out), JSON.stringify(out));
}
cutOk('internal Outlook header, no address',
  '________________________________\nFrom: Najarro, Mike\nSent: Tuesday, September 23, 2026 3:14 PM\nTo: Porzelt, Lisa\nSubject: RE: WO 1135344\n\nOLD-THREAD can you confirm the ETA?');
cutOk('external Outlook header with address',
  'From: Jo Woods <jwoods@caleres.com>\nSent: Tuesday, September 23, 2026 3:14 PM\nTo: ops@broadwaynational.com\nSubject: WO 1135344\n\nOLD-THREAD original request');
cutOk('bold *From:* header (HTML->text)',
  '*From:* Jo Woods\n*Sent:* Tuesday, September 23, 2026 3:14 PM\n*To:* Ops\n*Subject:* WO 1135344\n\nOLD-THREAD');
cutOk('-----Original Message-----', '-----Original Message-----\nOLD-THREAD from Jo');
cutOk('Gmail "On ... wrote:"', 'On Tue, Sep 23, 2026 at 3:14 PM Jo Woods <jwoods@caleres.com> wrote:\n> OLD-THREAD');
cutOk('Gmail "On ... wrote:" wrapped', 'On Tue, Sep 23, 2026 at 3:14 PM Jo Woods <\njwoods@caleres.com> wrote:\n> OLD-THREAD');
var prose = 'Parts ship from: the Dallas warehouse.\nFrom: our side, nothing is outstanding.\nThanks';
A.eq('prose starting a line with "From:" does NOT cut', lapi.tidyBody(prose), prose);
A.ok('keepThread=true still keeps the thread (forward summaries)',
  /OLD-THREAD/.test(lapi.tidyBody(NEW + '\n\nFrom: Najarro, Mike\nSent: Tue\nTo: Lisa\n\nOLD-THREAD', true)));

console.log('# parseEml - a text/plain reply keeps the quoted <address> so the cut can see it');
var threaded = api.parseEml([
  'From: Lisa Porzelt <lporzelt@broadwaynational.com>', 'Subject: RE: WO 1135344',
  'Content-Type: text/plain; charset="us-ascii"', '',
  'Crew is booked for Thursday.', '', 'From: Jo Woods <jwoods@caleres.com>',
  'Sent: Tuesday, September 23, 2026 3:14 PM', 'Subject: WO 1135344', '', 'OLD-THREAD request'
].join(CRLF));
A.ok('plain body keeps <jwoods@caleres.com>', /<jwoods@caleres\.com>/.test(threaded.body), JSON.stringify(threaded.body));
A.eq('...and tidyBody cuts at it', lapi.tidyBody(threaded.body), 'Crew is booked for Thursday.');
var htmlOnly = api.parseEml([
  'From: Lisa <l@x.com>', 'Subject: RE: x', 'Content-Type: text/html; charset="us-ascii"', '',
  '<html><body><p>Crew is booked.</p><div><b>From:</b> Jo Woods<br><b>Sent:</b> Tue<br><b>To:</b> Ops<br><b>Subject:</b> x</div><p>OLD-THREAD</p></body></html>'
].join(CRLF));
A.eq('an HTML-only reply keeps its lines, so the cut still fires', lapi.tidyBody(htmlOnly.body), 'Crew is booked.');

console.log('# buildNoteText - capped at Umbrava\'s 4,000-character note limit');
var NOTE = slice('var NOTE_CAP = 4000;', '  var MUT_ADD_NOTE', 'note cap') + slice('function buildNoteText(', '// ---- Umbrava upload dialog plumbing', 'buildNoteText');
var napi = { String: String };
vm.runInNewContext('function shortDate(){return "9/24";}\n' + NOTE + '\n;this.buildNoteText=buildNoteText;this.NOTE_CAP=NOTE_CAP;', napi);
A.eq('cap is 4000', napi.NOTE_CAP, 4000);
var big = napi.buildNoteText([{ isEmail: true, noteBlock: new Array(5001).join('x') }]);
A.eq('a long note is cut to exactly 4000 incl. the ellipsis', big.length, 4000);
A.ok('...ending in the ellipsis', /…$/.test(big));
var small = napi.buildNoteText([{ isEmail: true, noteBlock: 'short note' }]);
A.eq('a short note is untouched', small, 'short note');

// ---- .msg HTML body: the note keeps the spacing the sender saw ------------------------------
// Outlook's plain-text body (PR_BODY) puts a blank line after EVERY paragraph, so a single-spaced
// signature landed double-spaced. The .msg's HTML body (usually only inside PR_RTF_COMPRESSED) is
// the real layout. The end-to-end check ran by hand on a live Outlook .msg; these pin the pieces.
var RTF = slice('  function asciiStr(', "  // The message's OWN body", 'rtf readers');
var rapi = { Uint8Array: Uint8Array, DataView: DataView, String: String, TextDecoder: TextDecoder };
vm.runInNewContext(RTF + '\n;this.rtfDecompress=rtfDecompress;this.rtfToHtml=rtfToHtml;', rapi);
var HT = slice('function cleanBody(', '// .msg = OLE2/CFB', 'cleanBody');
var hapi = { String: String, parseInt: parseInt };
vm.runInNewContext(HT + '\n;this.cleanBody=cleanBody;', hapi);

console.log('# rtfDecompress - MS-OXRTFCP LZFu + MELA');
function hdr16(raw, type) { var h = Buffer.alloc(16); h.writeUInt32LE(0, 0); h.writeUInt32LE(raw, 4); h.write(type, 8, 'latin1'); return h; }
// Hand-built per the spec: one back-reference into the 207-byte preamble ("{\rtf1" = offset 0,
// length 6), four literals, then the end marker (a reference whose offset is the write position,
// 207 + 10 = 217). Flag bits, low first: ref, lit, lit, lit, lit, ref = 0x21.
var lz = Buffer.concat([hdr16(10, 'LZFu'), Buffer.from([0x21, 0x00, 0x04]), Buffer.from(' hi}', 'latin1'), Buffer.from([0x0D, 0x90])]);
A.eq('LZFu: dictionary reference + literals + end marker', rapi.rtfDecompress(new Uint8Array(lz)), String.raw`{\rtf1 hi}`);
var mela = Buffer.concat([hdr16(5, 'MELA'), Buffer.from('{abc}', 'latin1')]);
A.eq('MELA: stored uncompressed', rapi.rtfDecompress(new Uint8Array(mela)), '{abc}');
A.eq('an unknown compression type reads as nothing (PR_BODY fallback)', rapi.rtfDecompress(new Uint8Array(hdr16(4, 'XXXX'))), '');

console.log('# rtfToHtml - RTF-encapsulated HTML (fromhtml1) back to the original HTML');
var enc = String.raw`{\rtf1\ansi\ansicpg1252\fromhtml1 \deff0{\fonttbl{\f0\fswiss Arial;}}` +
  String.raw`{\*\htmltag19 <html>}{\*\htmltag64 <p class=MsoNormal>}\htmlrtf {\htmlrtf0 Hey Martin,` +
  String.raw`{\*\htmltag116 <br>}\htmlrtf \line\htmlrtf0 Caf\'e9 \{ok\}{\*\htmltag72 </p>}\htmlrtf \par}\htmlrtf0 ` +
  String.raw`{\*\htmltag64 <p>}\u8212?done{\*\htmltag72 </p>}{\*\mhtmltag1 <img src="cid:x">}}`;
A.eq('markup + text come back; RTF-only runs and mhtmltag dropped', rapi.rtfToHtml(enc),
  '<html><p class=MsoNormal>Hey Martin,<br>Café {ok}</p><p>—done</p>');
A.eq('a native RTF body (no fromhtml1) reads as nothing', rapi.rtfToHtml(String.raw`{\rtf1\ansi hello\par}`), '');

console.log('# cleanBody(html) - Outlook HTML keeps its real line spacing');
var outlook = '<html><head><style>p.MsoNormal{margin:0}</style></head><body><!--[if gte mso 9]><xml>junk</xml><![endif]-->\r\n' +
  '<div class=WordSection1><p class=MsoNormal>Hey Martin,<br>\r\n<br>\r\nHope all is well.<o:p></o:p></p>' +
  '<p class=MsoNormal><o:p>&nbsp;</o:p></p><div><div><p class=MsoNormal><b>Kind Regards,</b></p>' +
  '<p class=MsoNormal><b>Mike Najarro</b></p><p class=MsoNormal>Operations Manager</p></div></div>' +
  '<table><tr><td>Phone:</td><td>1.631.737.3140</td></tr></table><p>Tom &amp; Jerry&#39;s &lt;shop&gt;</p></div></body></html>';
A.eq('<br><br> and an empty paragraph keep their blank line; the signature stays single-spaced',
  hapi.cleanBody(outlook, true),
  "Hey Martin,\n\nHope all is well.\n\nKind Regards,\nMike Najarro\nOperations Manager\nPhone: 1.631.737.3140\nTom & Jerry's <shop>");
A.ok('a tag rebuilt from nested input is stripped too (fixed-point strip)',
  !/<\s*script/i.test(hapi.cleanBody('<<b>script>alert(1)<</b>/script><p>ok</p>', true)),
  JSON.stringify(hapi.cleanBody('<<b>script>alert(1)<</b>/script><p>ok</p>', true)));
A.eq('two empty paragraphs keep two blank lines', hapi.cleanBody('<p>a</p><p>&nbsp;</p><p>&nbsp;</p><p>b</p>', true), 'a\n\n\nb');

// ---- .msg: new Outlook signature logo is only marked by a body-cited Content-ID --------------
// A real Pilot .msg carried its logo ("Outlook-vuspxaoz", svg) with NO hidden / ATT_MHTML_REF flag;
// the only tell is <img src="cid:..."> inside the compressed RTF body. parseMsg decompresses it with
// rtfDecompress - pinned here on the MS-OXRTFCP 3.1.1 spec sample (real encoder output).
var SPEC = Uint8Array.from([0x2d,0,0,0,0x2b,0,0,0,0x4c,0x5a,0x46,0x75,0xf1,0xc5,0xc7,0xa7,0x03,0x00,0x0a,0x00,0x72,0x63,0x70,0x67,
  0x31,0x32,0x35,0x42,0x32,0x0a,0xf3,0x20,0x68,0x65,0x6c,0x09,0x00,0x20,0x62,0x77,0x05,0xb0,0x6c,0x64,0x7d,0x0a,0x80,0x0f,0xa0]);
var BS = String.fromCharCode(92);
A.eq('LZFu spec sample decompresses', rapi.rtfDecompress(SPEC),
  '{' + BS + 'rtf1' + BS + 'ansi' + BS + 'ansicpg1252' + BS + 'pard hello world}\r\n');

A.finish();
