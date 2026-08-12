// test-amazon-rfq-intake.js - node harness for the Amazon (Fairmarkit RFQ) intake path in
// bwn-wo-intake.user.js. Locks the CORRECTED Source-field mapping (0.9.14):
//
//   - Source Job # = the RFQ ID suffixed " (FM-AMZ)"   e.g. 2956102 -> "2956102 (FM-AMZ)"
//   - Source PO #  = the literal string "Quote Request"
//
// This replaces the earlier (wrong) convention where Source PO # was "N/A" and Source Job # was
// a "Q/R (<tracking>)" value stamped on the new WO page after Create. That post-Create stamp is
// gone: both values are known from the email, so they fill in the create modal in one pass.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). Same proven pattern as
// test-cw-amazon-intake.js / test-jll-amazon-intake.js: slice the REAL shipped Amazon block out
// of the userscript and run it in a vm. The extractor is a pure function of (subject, body), so
// no DOM is needed. Grounded on the real RFQ #2956102 email (site DLI9, Fenton MO).
//
// Two layers of protection:
//   1) VALUE checks - run extractAmazon over the fixture and recompute the modal mapping the same
//      way handleDrop does, asserting the corrected Source Job # / Source PO # values.
//   2) SOURCE-TEXT guards - assert the shipped handleDrop mapping literally carries the new
//      expressions AND that the retired convention (Q/R, po: 'N/A', the stamp fn) is fully gone,
//      so a future edit that reintroduces either turns this red.

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

// The whole Amazon (Fairmarkit) helper cluster, verbatim from the userscript.
var BLOCK = slice('function isAmazon(', '// ---- CW-Amazon', 'Amazon RFQ extractor');
var exportLine = '\n;this.isAmazon=isAmazon;this.parseAmazonAddr=parseAmazonAddr;' +
  'this.amazonTrade=amazonTrade;this.extractAmazon=extractAmazon;';
var api = {};
vm.runInNewContext(BLOCK + exportLine, api);

// The exact mapping handleDrop applies to build the create-modal `wo` for an Amazon RFQ. Kept in
// sync with the source by the SOURCE-TEXT guards below - if the source expression drifts, guard 2
// fails; if this copy drifts, the value checks and the source guard disagree.
function modalMapping(ax) {
  return {
    po: 'Quote Request',
    sourceJob: ax.rfqId ? (ax.rfqId + ' (FM-AMZ)') : ''
  };
}

var SENDER = 'info@m.fairmarkit.com';
var SUBJECT = 'Amazon.com, Inc. - Request for Quote #2956102';
// A realistic RFQ body in the Fairmarkit shape, grounded on the real #2956102 email: site DLI9,
// shipping to 655 Assembly Parkway, Fenton, MO. Ordered so each parse terminator is present
// (Notes -> "View more", Shipping -> "Preferred delivery date:").
var BODY = [
  'Amazon.com, Inc. - Request for Quote',
  'Invitation to Quote DLI9 You have been invited to quote on the following request.',
  'Internal part # QTY 1. Replace damaged dock bumper 2.00 Notes to supplier: Access via the receiving dock. View more',
  'Buyer: Erin (Erinnewb) Newberry Close date: Aug 14, 2026 at 10:00 AM (GMT-08:00) Pacific Time - Los Angeles RFQ ID: 2956102',
  'Shipping address: 655 Assembly Parkway, Fenton, MO, 63026, US Preferred delivery date: Aug 20, 2026',
  '"bid_uuid": "12345678-1234-1234-1234-1234567890ab"'
].join('\n');

console.log('Amazon (Fairmarkit RFQ) intake - extractAmazon + corrected Source mapping\n');

console.log('# real RFQ #2956102 (site DLI9, Fenton MO)');
A.ok('  detected as Amazon (Fairmarkit + "Amazon.com, Inc.")', api.isAmazon(SENDER, SUBJECT, BODY) === true);
var ax = api.extractAmazon(SUBJECT, BODY);
A.ok('  RFQ ID captured = 2956102', ax.rfqId === '2956102', 'got ' + JSON.stringify(ax.rfqId));
A.ok('  Site code = DLI9', ax._siteCode === 'DLI9', 'got ' + JSON.stringify(ax._siteCode));
A.ok('  Location search term = DLI9', ax.location === 'DLI9', 'got ' + JSON.stringify(ax.location));
A.ok('  Address city = Fenton', ax._addr && ax._addr.city === 'Fenton', 'got ' + JSON.stringify(ax._addr));
A.ok('  Address state = MO', ax._addr && ax._addr.state === 'MO', 'got ' + JSON.stringify(ax._addr && ax._addr.state));
A.ok('  Address street # = 655', ax._addr && ax._addr.streetNum === '655', 'got ' + JSON.stringify(ax._addr && ax._addr.streetNum));
A.ok('  Preferred delivery date -> _dueBy', /Aug\s+20,?\s*2026/.test(ax._dueBy || ''), 'got ' + JSON.stringify(ax._dueBy));
A.ok('  refs note carries "RFQ #2956102"', (ax._note || '').indexOf('RFQ #2956102') >= 0, 'got ' + JSON.stringify(ax._note));
A.ok('  refs note carries the Fairmarkit bid link', (ax._note || '').indexOf('app.fairmarkit.com/bid/') >= 0, 'got ' + JSON.stringify(ax._note));
A.ok('  scope non-empty + capped', ax.scope.length > 0 && ax.scope.length <= 600, 'len ' + ax.scope.length);

console.log('\n# corrected modal mapping (the fix)');
var m = modalMapping(ax);
A.eq('  Source Job # = "2956102 (FM-AMZ)"', m.sourceJob, '2956102 (FM-AMZ)');
A.eq('  Source PO # = literal "Quote Request"', m.po, 'Quote Request');

console.log('\n# mapping edge: no RFQ ID -> empty Source Job # (never "undefined (FM-AMZ)")');
A.eq('  rfqId "" -> sourceJob ""', modalMapping({ rfqId: '' }).sourceJob, '');

console.log('\n# detection boundaries');
A.ok('subject-only path (buyer named, non-Fairmarkit sender) still detects',
  api.isAmazon('procurement@example.com', 'Amazon.com, Inc. - Request for Quote #2956102', '') === true);
A.ok('Fairmarkit sender but NOT an Amazon buyer -> not Amazon',
  api.isAmazon('info@m.fairmarkit.com', 'Home Depot RFQ', 'You have been invited to quote for Home Depot') === false);

console.log('\n# source-text guards (retired Q/R convention must stay gone)');
var buildObj = slice("client: 'Amazon', location: ax.location", 'clientDne', 'Amazon create-modal mapping');
A.ok("source builds Source PO # = 'Quote Request'", buildObj.indexOf("po: 'Quote Request'") >= 0, buildObj.replace(/\s+/g, ' ').slice(0, 120));
A.ok('source builds Source Job # = ax.rfqId + " (FM-AMZ)"',
  buildObj.indexOf("sourceJob: ax.rfqId ? (ax.rfqId + ' (FM-AMZ)')") >= 0, buildObj.replace(/\s+/g, ' ').slice(0, 160));
A.ok('no "Q/R" convention text anywhere in the script', full.indexOf('Q/R') === -1);
A.ok("no Amazon po: 'N/A' anywhere in the script", full.indexOf("po: 'N/A'") === -1);
A.ok('post-Create tracking stamp fully removed', full.indexOf('amazonStampSourceJob') === -1 && full.indexOf('amazonReadTracking') === -1);

A.finish();
