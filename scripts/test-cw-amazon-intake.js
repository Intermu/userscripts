// test-cw-amazon-intake.js - node harness for the CW-Amazon (Cushman & Wakefield / FAMIS 360)
// intake path added to bwn-wo-intake.user.js 0.9.10.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). It follows the proven
// pattern: slice the REAL shipped block out of the userscript and run it in a vm, here against
// the five real FAMIS "Case Summary" email bodies this path was built from. The extractor is a
// pure function of (subject, body), so no DOM is needed - this covers exactly the code I wrote.
//
// WHAT IS UNDER TEST - extractCwAmazon + its helpers (isCwAmazon / cwAmazonWoType /
// cwAmazonPriority / cwAmazonDne / cwAmazonTrade), the mapping from a FAMIS email to the Create
// WO fields:
//   - Location  -> the exact SITE CODE (Umbrava locationNumber), read from "AMAZON - <code> - ..."
//   - Source Job # = the FAMIS Request ID; Source PO # blank
//   - WO Type from Type | Sub-Type: Request-for-Proposal -> Proposal, preventive -> Preventative,
//     else Reactive (all three verified live as CW-Amazon workOrderTypeName values)
//   - Priority: the FAMIS P-code -> the "P<n>" prefix (or Scheduled PPM)
//   - Client DNE: the PO/NTE amount in the Statement of Work, else 0.00
//   - Trade: best-effort from the Type token, falling back to SOW keywords
//
// The five bodies are the ground truth the design was checked against; the expectations below are
// the values a human confirmed correct for each real request (site code, request id, wo type,
// trade, priority prefix, dne, complete-by). A slice miss or a regex regression turns this red.

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

// The whole CW-Amazon helper cluster, verbatim from the userscript.
var BLOCK = slice('function isCwAmazon(', '// ---- Create WO modal', 'CW-Amazon extractor');
var exportLine = '\n;this.isCwAmazon=isCwAmazon;this.extractCwAmazon=extractCwAmazon;' +
  'this.cwAmazonPriority=cwAmazonPriority;this.cwAmazonWoType=cwAmazonWoType;' +
  'this.cwAmazonDne=cwAmazonDne;this.cwAmazonTrade=cwAmazonTrade;';
var api = {};
vm.runInNewContext(BLOCK + exportLine, api);

var SENDER = 'amazon@ilrs.360facility.net';

// SANITIZED fixtures. Each reproduces the SHAPE of a FAMIS Case Summary email - subject plus the
// plain-text body, every anchor the extractor keys on - with the field values
// a human confirmed for that request. Tabs/newlines are kept realistic; the extractor flattens
// whitespace, so exact spacing does not matter.
var CASES = [
  {
    name: '990001 Blauvelt dock door (Reactive, PO Amount)',
    subject: 'NEW AMAZON - PKG_EXAMPLE1_DXX4 - 200 Example Drive - Dock Door Maintenance - ',
    body: [
      'Request ID: \t990001\t ',
      'Location\t AMAZON - PKG_EXAMPLE1_DXX4 - 200 Example Drive \t',
      'Address\t 200 Example Drive\n\nBlauvelt, NY 10999\n',
      'Type | Sub-Type\t Dock Door | Dock Door Maintenance \t',
      'Statement of Work\t Description of the required work: Per onsite Ops Mgr Rae 555-0110, there is no power to the controls for overhead speed door #501 PO required (Y/N): y PO Amount: 2000.00 GL Account/Code: Dock Repair and Maintenance 610-000-01 R&M - Struc/Roof: Gates/Docks/Loading/Overhead Contract \t',
      'Priority\t P5-Low - Minor Issues - 2D/30D\t ',
      'Assigned To\t VNDR BROADWAY NATIONAL GROUP LLC\t ',
      'Complete By\t 10 Sep 2026\t ',
      'Requested By\t Jane Doe, Cushman & Wakefield - 555-0111\t ',
      'URL\t https://amazon.famis360.com/LB_Request_Update.asp?RequestID=990001\t '
    ].join('\n'),
    expect: { requestId: '990001', siteCode: 'PKG_EXAMPLE1_DXX4', woType: 'Reactive',
      trade: 'Doors and Hardware', priority: 'P5', dne: '2000.00', completeBy: '10 Sep 2026', warnAttach: false }
  },
  {
    name: '990002 Sterling plumbing (Reactive, PO/NTE Amount, report attached)',
    subject: 'NEW AMAZON - IAX228D - 45965 Example Blvd  - Repair and Maintenance - P5-Low - M',
    body: [
      'Request ID: \t990002\t ',
      'Location\t AMAZON - IAX228D - 45965 Example Blvd \t',
      'Address\t 45965 Example Blvd \n\nSterling, VA 20199\n',
      'Type | Sub-Type\t Plumbing | Repair and Maintenance \t',
      'Statement of Work\t 1 backflow failed during inspection, failed report attached. Please contact property engineer, Sam Roe, for access; contact number is 555-0112. PO Required: Y PO/NTE Amount: $2000 GL Account/Code: 610-000-02 If this work requires an increase to the initial PO NTE, Vendor must request a change order for the increase through this work order. \t',
      'Priority\t P5-Low - Minor Issues - 2D/30D\t ',
      'Assigned To\t VNDR BROADWAY NATIONAL GROUP LLC\t ',
      'Complete By\t 01 Aug 2026\t ',
      'Requested By\t Alex Poe, Cushman and Wakefield-Asset Services - 555.0113\t ',
      'URL\t https://amazon.famis360.com/LB_Request_Update.asp?RequestID=990002\t '
    ].join('\n'),
    expect: { requestId: '990002', siteCode: 'IAX228D', woType: 'Reactive',
      trade: 'Plumbing', priority: 'P5', dne: '2000', completeBy: '01 Aug 2026', warnAttach: true }
  },
  {
    name: '990003 Acworth plumbing (Reactive, NTE $1,414.71, "Proposal #1" is not an RFP)',
    subject: 'NEW AMAZON - FTX4 - 5663 Example Rd - Repair and Maintenance - P5-Low - Min',
    body: [
      'Request ID: \t990003\t ',
      'Location\t AMAZON - FTX4 - 5663 Example Rd \t',
      'Address\t 5663 Example Rd\n\nAcworth, GA 30199\n',
      'Type | Sub-Type\t Plumbing | Repair and Maintenance \t',
      'Statement of Work\t Proposal # 1 remove and dispose of existing shut off valve and supply and install new shut off valve. We will test to ensure proper function once repaired. PO: YES NTE: $1,414.71 coding: 610-000-03 \t',
      'Priority\t P5-Low - Minor Issues - 2D/30D\t ',
      'Assigned To\t VNDR BROADWAY NATIONAL GROUP LLC\t ',
      'Complete By\t 27 Jul 2026\t ',
      'Requested By\t Robin Loe, Cushman & Wakefield - 555-0114\t ',
      'URL\t https://amazon.famis360.com/LB_Request_Update.asp?RequestID=990003\t '
    ].join('\n'),
    expect: { requestId: '990003', siteCode: 'FTX4', woType: 'Reactive',
      trade: 'Plumbing', priority: 'P5', dne: '1414.71', completeBy: '27 Jul 2026', warnAttach: false }
  },
  {
    name: '990004 La Vergne RFP (Proposal, no NTE -> 0.00, backflow->Plumbing)',
    subject: 'NEW AMAZON - PNX1 - 242 Example Road - Corrective Work Proposal - P4-Scheduled -',
    body: [
      'Request ID: \t990004\t ',
      'Location\t AMAZON - PNX1 - 242 Example Road \t',
      'Address\t 242 Example Road\n\nLa Vergne, TN 37099\n',
      'Type | Sub-Type\t Request for Proposal | Corrective Work Proposal \t',
      'Statement of Work\t Failed backflow repair - need quote to fully replace the backflow - irrigation backflow Please provide quote \t',
      'Priority\t P4-Scheduled - 2D/15D\t ',
      'Assigned To\t VNDR BROADWAY NATIONAL GROUP LLC\t ',
      'Complete By\t 28 Jul 2026\t ',
      'Requested By\t Robin Loe, Cushman & Wakefield - 555-0114\t ',
      'URL\t https://amazon.famis360.com/LB_Request_Update.asp?RequestID=990004\t '
    ].join('\n'),
    expect: { requestId: '990004', siteCode: 'PNX1', woType: 'Proposal',
      trade: 'Plumbing', priority: 'P4', dne: '0.00', completeBy: '28 Jul 2026', warnAttach: false }
  },
  {
    name: '990005 La Vergne RFP (Proposal, no NTE -> 0.00, attached unit)',
    subject: 'NEW AMAZON - PNX1 - 242 Example Road - Corrective Work Proposal - P4-Scheduled -',
    body: [
      'Request ID: \t990005\t ',
      'Location\t AMAZON - PNX1 - 242 Example Road \t',
      'Address\t 242 Example Road\n\nLa Vergne, TN 37099\n',
      'Type | Sub-Type\t Request for Proposal | Corrective Work Proposal \t',
      'Statement of Work\t From backflow w/o 990009 - Failed backflow - leaking - please provide quote for repairs. Attached failed unit - documentation is fuzzy Please provide quote. \t',
      'Priority\t P4-Scheduled - 2D/15D\t ',
      'Assigned To\t VNDR BROADWAY NATIONAL GROUP LLC\t ',
      'Complete By\t 05 Jun 2026\t ',
      'Requested By\t Robin Loe, Cushman & Wakefield - 555-0114\t ',
      'URL\t https://amazon.famis360.com/LB_Request_Update.asp?RequestID=990005\t '
    ].join('\n'),
    expect: { requestId: '990005', siteCode: 'PNX1', woType: 'Proposal',
      trade: 'Plumbing', priority: 'P4', dne: '0.00', completeBy: '05 Jun 2026', warnAttach: true }
  }
];

console.log('CW-Amazon intake - extractCwAmazon over 5 real FAMIS emails\n');

CASES.forEach(function (c) {
  console.log('# ' + c.name);
  A.ok('  detected as CW-Amazon', api.isCwAmazon(SENDER, c.subject, c.body) === true);
  var out = api.extractCwAmazon(c.subject, c.body);
  A.ok('  Request ID -> Source Job # ' + c.expect.requestId, out.requestId === c.expect.requestId, 'got ' + out.requestId);
  A.ok('  Site code = ' + c.expect.siteCode, out.siteCode === c.expect.siteCode, 'got ' + out.siteCode);
  A.ok('  WO Type = ' + c.expect.woType, out.woType === c.expect.woType, 'got ' + out.woType);
  A.ok('  Trade = ' + c.expect.trade, out.trade === c.expect.trade, 'got ' + JSON.stringify(out.trade));
  A.ok('  Priority prefix = ' + c.expect.priority, api.cwAmazonPriority(out.priorityRaw) === c.expect.priority, 'got ' + api.cwAmazonPriority(out.priorityRaw) + ' from ' + JSON.stringify(out.priorityRaw));
  A.ok('  Client DNE = ' + c.expect.dne, out.dne === c.expect.dne, 'got ' + out.dne);
  A.ok('  Complete By = ' + c.expect.completeBy, out.completeBy === c.expect.completeBy, 'got ' + JSON.stringify(out.completeBy));
  A.ok('  URL carries the request id', out.url.indexOf(c.expect.requestId) >= 0, 'got ' + out.url);
  A.ok('  scope non-empty + capped', out.scope.length > 0 && out.scope.length <= 600, 'len ' + out.scope.length);
  // "attached report/document not in this email" is the handleDrop warn condition (SOW mentions an
  // attachment). Recompute it here the same way the branch does.
  var refAttach = /attach|see report|failed report/i.test(out.sow);
  A.ok('  attachment-reference warn = ' + c.expect.warnAttach, refAttach === c.expect.warnAttach, 'sow=' + JSON.stringify(out.sow.slice(0, 40)));
  console.log('');
});

// Negative controls: the detector must NOT swallow the Fairmarkit "Amazon" feed or a plain PO.
console.log('# detection boundaries');
A.ok('Fairmarkit Amazon RFQ is NOT CW-Amazon',
  api.isCwAmazon('info@m.fairmarkit.com', 'Amazon.com, Inc. - Request for Quote #2905000',
    'You have been invited ... Amazon.com, Inc. ... RFQ ID: 2905000 ...') === false);
A.ok('a Pilot PO email is NOT CW-Amazon',
  api.isCwAmazon('orders@pilottravelcenters.com', 'Purchase Order 12345678', 'PO # 12345678 store 0421') === false);
A.ok('CW-Amazon detected by body markers even without the famis sender',
  api.isCwAmazon('someone@example.com', 'NEW AMAZON - PNX1', 'Case Summary Request ID: 999 amazon.famis360.com') === true);

// WO-type mapping unit checks (the rule the user asked for).
console.log('\n# WO Type rule (Type | Sub-Type)');
A.ok('Request for Proposal -> Proposal', api.cwAmazonWoType('Request for Proposal', 'Corrective Work Proposal', 'P4-Scheduled', '') === 'Proposal');
A.ok('preventive sub-type -> Preventative', api.cwAmazonWoType('Plumbing', 'Preventive Maintenance', 'Scheduled PPM', '') === 'Preventative');
A.ok('PPM priority backstop -> Preventative', api.cwAmazonWoType('Plumbing', 'Inspection', 'Scheduled PPM', 'preventive maintenance task') === 'Preventative');
A.ok('repair & maintenance -> Reactive', api.cwAmazonWoType('Plumbing', 'Repair and Maintenance', 'P5-Low', 'Proposal # 1 replace valve') === 'Reactive');
A.ok('dock door maintenance -> Reactive', api.cwAmazonWoType('Dock Door', 'Dock Door Maintenance', 'P5-Low', '') === 'Reactive');

// DNE parsing unit checks.
console.log('\n# Client DNE parsing');
A.ok('PO Amount: 2000.00', api.cwAmazonDne('... PO Amount: 2000.00 GL ...') === '2000.00');
A.ok('PO/NTE Amount: $2000', api.cwAmazonDne('... PO/NTE Amount: $2000 GL ...') === '2000');
A.ok('NTE: $1,414.71', api.cwAmazonDne('... PO: YES NTE: $1,414.71 coding ...') === '1414.71');
A.ok('no ceiling -> 0.00', api.cwAmazonDne('Failed backflow repair - need quote') === '0.00');
A.ok('does not grab the GL code digits', api.cwAmazonDne('GL Account/Code: 610-000-01') === '0.00');

A.finish();
