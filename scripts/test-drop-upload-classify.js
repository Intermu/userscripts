// test-drop-upload-classify.js - node harness for the party/label classifier in bwn-drop-upload.user.js.
//
// WHY THIS EXISTS - the script used to assume every external domain that was not one of three
// hardcoded client domains was a VENDOR, so all client work arriving through a broker/CMMS
// (Corrigo, Fairmarkit, ServiceChannel) was mislabeled "Vendor Correspondence" (v1.16.0 fix).
// This pins:
//   - classifyDomain / partyByDomain: client-side (client OR broker) vs internal vs unknown-external,
//     by sender AND by recipients (direction), with no wrong Vendor guess.
//   - noteTypeForEmail: an unknown external types the NOTE as Vendor (there is no Supplier note type).
//   - classifyEmail / docLabelForFiles: an unknown external asks the AI vendor-vs-supplier, and a
//     MISS falls back to Vendor. Client/internal/non-email never call the AI.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). Same pattern: slice the REAL
// shipped blocks out of the userscript and run them in a vm, with a stub bwnAI whose answer we flip.

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

// Deterministic layer: CLIENT_DOMAINS + classifyDomain + partyByDomain + noteTypeForEmail/ForFiles.
var DET = slice('var CLIENT_DOMAINS = {', 'function inboundClientEmail(', 'domain classifier');
// Label layer: DEFAULT_DOC_LABEL + PARTY_LABEL + vendorOrSupplier + classifyEmail + docLabelForFiles.
var LBL = slice('var DEFAULT_DOC_LABEL =', 'var noteBox = null', 'label classifier');

// Prelude: the module-level helpers the label slice leans on, plus a stub bwnAI whose reply we flip.
var prelude = [
  'function smtpAddr(s){ s=String(s||"").trim(); return (s.indexOf("@")!==-1 && s.charAt(0)!=="/") ? s : ""; }',
  'function tidyBody(raw){ return String(raw||""); }',
  'var __ai = "";',                                   // what the on-device model "returns"
  'function bwnAI(opts){ return Promise.resolve(__ai); }',
  'function setAI(v){ __ai = v; }'
].join('\n');

var ctx = { Promise: Promise, JSON: JSON, String: String };
vm.runInNewContext(
  prelude + '\n' + DET + '\n' + LBL + '\n' +
  ';this.classifyDomain=classifyDomain;this.partyByDomain=partyByDomain;' +
  'this.noteTypeForEmail=noteTypeForEmail;this.classifyEmail=classifyEmail;' +
  'this.docLabelForFiles=docLabelForFiles;this.setAI=setAI;',
  ctx
);

function inbound(from) { return { fromEmail: from, to: [{ email: 'coord@broadwaynational.com' }], cc: [], body: 'x', subject: 's' }; }
function outbound(toEmail) { return { fromEmail: 'coord@broadwaynational.com', to: [{ email: toEmail }], cc: [], body: 'x', subject: 's' }; }
function emailFile(m) { return { isEmail: true, email: m }; }

// ---- deterministic: partyByDomain + noteTypeForEmail -------------------------
A.eq('inbound client domain -> party Client', ctx.partyByDomain(inbound('fm@caleres.com')), 'Client');
A.eq('inbound broker (Corrigo) -> party Client (THE FIX)', ctx.partyByDomain(inbound('do-not-reply@corrigo.com')), 'Client');
A.eq('inbound broker (Fairmarkit) -> party Client', ctx.partyByDomain(inbound('rfq@fairmarkit.com')), 'Client');
A.eq('inbound unknown external -> party External', ctx.partyByDomain(inbound('tech@acmehvac.com')), 'External');
A.eq('outbound to unknown external -> party External', ctx.partyByDomain(outbound('tech@acmehvac.com')), 'External');
A.eq('outbound to client domain -> party Client', ctx.partyByDomain(outbound('facilities@staples.com')), 'Client');
A.eq('internal <-> internal -> party Internal', ctx.partyByDomain(outbound('boss@broadwaynational.com')), 'Internal');
A.eq('no address anywhere -> party ""', ctx.partyByDomain({ to: [], cc: [] }), '');

A.eq('note type: client -> Client', ctx.noteTypeForEmail(inbound('fm@caleres.com')), 'Client');
A.eq('note type: broker -> Client', ctx.noteTypeForEmail(inbound('x@servicechannel.com')), 'Client');
A.eq('note type: unknown external -> Vendor (no Supplier note type)', ctx.noteTypeForEmail(inbound('tech@acmehvac.com')), 'Vendor');
A.eq('note type: internal -> Internal', ctx.noteTypeForEmail(outbound('boss@broadwaynational.com')), 'Internal');
A.eq('note type: nothing parseable -> Client default', ctx.noteTypeForEmail({ to: [], cc: [] }), 'Client');

// ---- label: docLabelForFiles (async; AI only for unknown external) -----------
function run() {
  return Promise.resolve()
    .then(function () { return ctx.docLabelForFiles([emailFile(inbound('fm@caleres.com'))]); })
    .then(function (l) { A.eq('label: client email -> Client Correspondence', l, 'Client Correspondence'); })
    .then(function () { return ctx.docLabelForFiles([emailFile(inbound('do-not-reply@corrigopro.com'))]); })
    .then(function (l) { A.eq('label: broker email -> Client Correspondence (THE FIX)', l, 'Client Correspondence'); })
    .then(function () { ctx.setAI('supplier'); return ctx.docLabelForFiles([emailFile(inbound('sales@partsdepot.com'))]); })
    .then(function (l) { A.eq('label: unknown external + AI "supplier" -> Supplier Correspondence', l, 'Supplier Correspondence'); })
    .then(function () { ctx.setAI('vendor'); return ctx.docLabelForFiles([emailFile(inbound('tech@acmehvac.com'))]); })
    .then(function (l) { A.eq('label: unknown external + AI "vendor" -> Vendor Correspondence', l, 'Vendor Correspondence'); })
    .then(function () { ctx.setAI(''); return ctx.docLabelForFiles([emailFile(inbound('who@mystery.com'))]); })
    .then(function (l) { A.eq('label: unknown external + AI MISS -> Vendor Correspondence (fallback)', l, 'Vendor Correspondence'); })
    .then(function () { ctx.setAI('supplier'); return ctx.docLabelForFiles([emailFile(outbound('boss@broadwaynational.com'))]); })
    .then(function (l) { A.eq('label: internal email -> Internal (no AI; not a client Work Order Request)', l, 'Internal'); })
    .then(function () { return ctx.docLabelForFiles([{ isEmail: false }]); })
    .then(function (l) { A.eq('label: no email (photo/PDF) -> Work Order Request', l, 'Work Order Request'); })
    .then(handoffLabels);
}

// ---- WO-intake handoff: the request email and its photos get DIFFERENT doc labels -------------
// The handoff forced "Work Order Request" on EVERY file it uploaded, so the site photos a client
// attaches to a request were filed as Work Order Requests too (reported 2026-09-03 on the Pilot
// store 258 painting request - six photos, all mislabeled). It now resolves the label PER FILE.
// Both halves below are the REAL shipped bytes: fileKind is sliced out, and the resolver's own
// expression is lifted from the handoff call and run against it - not a restatement.
function handoffLabels() {
  var KIND = slice('function fileKind(', 'function humanSize(', 'file kind sniffer');
  var kctx = {};
  vm.runInNewContext(KIND + ';this.fileKind=fileKind;', kctx);
  A.eq('fileKind: the dropped request email -> Email', kctx.fileKind({ name: 'store Painting.msg', type: '' }), 'Email');
  // Outlook hands embedded photos over with mime application/octet-stream, so the NAME is what
  // classifies them - a mime-only sniffer would have missed every one of them.
  A.eq('fileKind: a photo attachment (octet-stream mime, .jpeg name) -> Photo',
    kctx.fileKind({ name: 'original-C2383B61.jpeg', type: 'application/octet-stream' }), 'Photo');

  var handoff = slice('runApiUpload(raw, described, dt, ctx,', '}, false);', 'WO-intake handoff upload call');
  var m = /return (fileKind\(f\)[\s\S]*?);/.exec(handoff);
  A.ok('the handoff passes a per-file label resolver, not one fixed name', !!m, handoff.slice(0, 200));
  var resolve = new Function('fileKind', 'f', 'return ' + m[1] + ';');
  A.eq('handoff: the request email itself -> Work Order Request',
    resolve(kctx.fileKind, { name: 'store Painting.msg', type: '' }), 'Work Order Request');
  A.eq('handoff: an image attachment -> Photo (THE FIX)',
    resolve(kctx.fileKind, { name: 'original-C2383B61.jpeg', type: 'application/octet-stream' }), 'Photo');
  A.eq('handoff: an attached PDF is still a Work Order Request',
    resolve(kctx.fileKind, { name: 'scope.pdf', type: 'application/pdf' }), 'Work Order Request');
}
run().then(function () { A.finish(); }, function (e) { console.error('THREW:', e && e.stack || e); process.exit(2); });
