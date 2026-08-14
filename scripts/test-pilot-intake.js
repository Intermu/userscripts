// test-pilot-intake.js - node harness for the Pilot Travel Centers / generic free-text intake
// path in bwn-wo-intake.user.js (extractWo). Locks the 0.9.16 scope fix:
//
//   Scope of Work comes from the email BODY (the actual work description), NOT the email SUBJECT.
//   The subject ("Store 305, Jamestown NM, PO 170101430655, P2 dispatch") is a routing header and
//   is only the LAST resort when the body yields nothing (image-only requests).
//
// Grounded on the REAL dropped email (.msg) Mike used:
//   subject: "Store 305, Jamestown NM, PO 170101430655, P2 dispatch"
//   body:    "Pump sign on light pole on pump 13 and 14 staring to fall off the pole please
//             inspect and resolve this issue." then "NTE 800.00" then the sender's signature.
//
// Same proven pattern as the sibling intake harnesses (no npm on this machine): slice the REAL
// shipped extractor cluster out of the userscript and run it in a vm. extractWo is a pure function
// of (subject, body, senderEmail), so no DOM is needed.

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

// CLIENT_BY_DOMAIN + clientFromDomain + calTrade + extractCaleres + assetToTrade + genericBodyScope
// + extractWo, verbatim. Only function declarations and the CLIENT_BY_DOMAIN literal execute at load.
var BLOCK = slice('var CLIENT_BY_DOMAIN = {', '// Image-based Caleres/Corrigo request', 'Pilot/generic extractor cluster');
var exportLine = '\n;this.extractWo=extractWo;this.genericBodyScope=genericBodyScope;' +
  'this.assetToTrade=assetToTrade;this.clientFromDomain=clientFromDomain;';
var api = {};
vm.runInNewContext(BLOCK + exportLine, api);

// The real email, reconstructed with the same line structure the .msg carries (description, then a
// blank line, then the NTE amount, then the signature block).
var SENDER = 'tiff.ogle@pilottravelcenters.com';
var SUBJECT = 'Store 305, Jamestown NM, PO 170101430655, P2 dispatch';
var BODY = [
  'Pump sign on light pole on pump 13 and 14 staring to fall off the pole please inspect and resolve this issue.',
  '',
  'NTE 800.00',
  '',
  'Tiffany Tolliver',
  'Sr Technician, Maintenance Call Center',
  'Tiff.Ogle@pilottravelcenters.com <mailto:Tiff.Ogle@pilottravelcenters.com>',
  'office: (865) 474.5548 <tel:5548>',
  '5508 Lonas Drive / Knoxville, TN 37909'
].join('\r\n');

console.log('Pilot Travel Centers / generic intake - extractWo scope-from-body fix (0.9.16 -> 0.9.17 real-label + asset block)\n');

var wo = api.extractWo(SUBJECT, BODY, SENDER);

console.log('# the fix: Scope of Work = the body description, NOT the subject');
A.eq('  Scope = body description',
  wo.scope,
  'Pump sign on light pole on pump 13 and 14 staring to fall off the pole please inspect and resolve this issue.');
A.ok('  Scope is NOT the subject line', wo.scope.indexOf('Jamestown') === -1 && wo.scope.indexOf('dispatch') === -1, 'got ' + JSON.stringify(wo.scope));
A.ok('  Scope excludes the NTE line + signature', wo.scope.indexOf('NTE') === -1 && wo.scope.indexOf('Tiffany') === -1, 'got ' + JSON.stringify(wo.scope));

console.log('\n# the other fields still map correctly');
A.eq('  Source PO # = the 12-digit PO from the subject', wo.po, '170101430655');
A.eq('  Client DNE = the body NTE amount', wo.clientDne, '800.00');
A.eq('  Priority = P2 (from the subject)', wo.priorityLevel, 'P2');
A.eq('  Location search = PFJ 0305 (store 305)', wo.location, 'PFJ 0305');
A.eq('  Client = Pilot Travel Centers (by sender domain)', wo.client, 'Pilot Travel Centers');
A.eq('  Trade = blank (let the scope-driven suggester + user pick; never a wrong confident guess)', wo.trade, '');

console.log('\n# genericBodyScope unit checks');
A.eq('  cuts at NTE',
  api.genericBodyScope('The sign is broken.\r\n\r\nNTE 500.00\r\nJohn Doe'),
  'The sign is broken.');
A.eq('  cuts at a signature email',
  api.genericBodyScope('Fix the leak under sink 3.\r\njdoe@client.com'),
  'Fix the leak under sink 3.');
A.eq('  cuts at a quoted reply chain',
  api.genericBodyScope('Please replace the door closer.\r\n\r\nFrom: someone\r\nSent: yesterday\r\nold text'),
  'Please replace the door closer.');
A.eq('  skips a lone salutation',
  api.genericBodyScope('Hi team,\r\nThe canopy light is out.\r\njdoe@client.com'),
  'The canopy light is out.');
A.eq('  empty body -> empty (extractWo then falls back to the subject)', api.genericBodyScope(''), '');

// --- Second real format: the ASSET/LABELED Pilot email (0.9.17) ---------------------------------
// Grounded on Mike's dropped .msg "Pilot Store: 114 ... PO 170101431647 ... P2 - Normal (24 hrs)".
// This format carries a real "Description:" FIELD LABEL near the BOTTOM, under a routing/asset block.
// The intro line "Need service for per description below." is a DECOY - a loose /Description/ match
// latched onto it and produced the boilerplate block instead of the request. The scope must be the
// real Description value, with the Asset Information block kept under it.
var SENDER2 = 'bradley.crockett@pilottravelcenters.com';
var SUBJECT2 = 'Pilot Store: 114-Travel Center Purchase Order: 170101431647 Priority: P2 - Normal (24 hrs)';
var BODY2 = [
  'Hello Broadway National Group,',
  'Need service for per description below.',
  '**Please respond with an ETA on the Purchase Order**',
  'Priority: P2 - Normal (24 hrs)',
  'Created: 8/14/2026',
  'PO: 170101431647',
  'NTE:$500.00',
  'Store Information:',
  'PFJ#: 114 Pilot',
  '2449 Genesis Road',
  'Crossville, Tennessee 38571',
  '(931) 450-3018',
  'Asset Information:',
  'Asset Name: DRYER',
  'Model: MLG26PRBWW1',
  'Serial#: M94402946',
  'Parts Warranty End Date: 5/27/2026',
  'Labor Warranty End Date: 5/27/2026',
  'Description:',
  'Left dryer needs new drum and belt strip. When running the lip of the drum came off in metal shavings.',
  'Dispatcher',
  'Bradley Crockett',
  'bradley.crockett@pilottravelcenters.com'
].join('\r\n');

console.log('\n# the asset/labeled Pilot format - scope from the REAL "Description:" label, not the decoy');
var wo2 = api.extractWo(SUBJECT2, BODY2, SENDER2);
A.eq('  Scope = the real Description value + the Asset Information block',
  wo2.scope,
  'Left dryer needs new drum and belt strip. When running the lip of the drum came off in metal shavings.\n\n' +
  'Asset Information:\nAsset Name: DRYER\nModel: MLG26PRBWW1\nSerial#: M94402946\n' +
  'Parts Warranty End Date: 5/27/2026\nLabor Warranty End Date: 5/27/2026');
A.ok('  Scope does NOT start with the decoy "below." block', wo2.scope.indexOf('below.') === -1 && wo2.scope.indexOf('respond with an ETA') === -1, 'got ' + JSON.stringify(wo2.scope));
A.ok('  Scope excludes the routing block (Priority/PO/NTE/Store)', wo2.scope.indexOf('NTE') === -1 && wo2.scope.indexOf('Store Information') === -1 && wo2.scope.indexOf('PO: 1701') === -1, 'got ' + JSON.stringify(wo2.scope));
A.ok('  Scope excludes the Dispatcher/signature trailer', wo2.scope.indexOf('Dispatcher') === -1 && wo2.scope.indexOf('Bradley') === -1, 'got ' + JSON.stringify(wo2.scope));
A.eq('  Source PO # = 170101431647', wo2.po, '170101431647');
A.eq('  Client DNE = 500.00 (body NTE)', wo2.clientDne, '500.00');
A.eq('  Priority = P2', wo2.priorityLevel, 'P2');
A.eq('  Location = PFJ 0114', wo2.location, 'PFJ 0114');
A.eq('  Asset Name = DRYER', wo2.assetName, 'DRYER');
A.eq('  Trade = Appliances (DRYER -> Appliances auto-trade)', wo2.trade, 'Appliances');

console.log('\n# assetToTrade Appliances mapping + anti-collision guards');
A.eq('  DRYER -> Appliances', api.assetToTrade('DRYER'), 'Appliances');
A.eq('  Washer -> Appliances', api.assetToTrade('Washer'), 'Appliances');
A.eq('  Dishwasher -> Appliances', api.assetToTrade('Dishwasher'), 'Appliances');
A.eq('  Ice Machine -> Appliances', api.assetToTrade('Ice Machine'), 'Appliances');
A.ok('  Water Heater is NOT stolen by Appliances (pre-existing "heat" -> HVAC wins)', api.assetToTrade('Water Heater') !== 'Appliances', 'got ' + api.assetToTrade('Water Heater'));
A.eq('  Walk-in Freezer stays HVAC (not Appliances)', api.assetToTrade('Walk-in Freezer'), 'HVAC');
A.eq('  Reach-in Cooler stays HVAC (not Appliances)', api.assetToTrade('Reach-in Cooler'), 'HVAC');
A.eq('  Medium Range LSI fixture stays Lighting (bare "range" not an appliance)', api.assetToTrade('Medium Range LSI V-locity fixture'), 'Lighting');

console.log('\n# regression guard: the subject stays the LAST resort in extractWo source');
A.ok('  genericBodyScope is tried before the subject fallback',
  full.indexOf("out.scope = genericBodyScope(body)") < full.indexOf("out.scope = subject.replace(/purchase order"),
  'ordering of the two fallbacks drifted');
A.ok('  image-only path still keeps the subject fallback',
  full.indexOf("last resort: the routing subject") >= 0);

A.finish();
