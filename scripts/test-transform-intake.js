// test-transform-intake.js - node harness for the Transform SR Brands LLC (TransformCo / Sears /
// Kmart) intake path added to bwn-wo-intake.user.js 0.9.22.
//
// Same proven pattern as the sibling intake harnesses (no npm on this machine): slice the REAL
// shipped blocks out of the userscript and run them in a vm. extractTransform is a pure function of
// (subject, body); it reuses genericBodyScope for the scope, so the generic cluster is sliced too.
//
// Grounded on the real 10-email corpus, cross-checked against the live client WO history (Umbrava
// client "Transform SR Brands LLC" #23914). What is under test - isTransform + extractTransform +
// helpers (transformDne / transformStore / transformRef / transformTrade), mapping to Create-WO fields:
//   - Location   -> the STORE NUMBER in the subject = the Umbrava locationNumber (unique 1:1)
//   - Source Job # AND Source PO # = the TransformCo WO/PO reference number, BOTH (per Mike)
//   - Client DNE = the NTE ($1K/$2K expanded, "NTE - $400" hyphen handled), else 0.00
//   - WO Type    = Reactive (fixed - asserted at the handleDrop wiring level)
//   - Priority   = left blank (SLA tier is a manual coordinator pick)

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

// genericBodyScope (+ the rest of the generic cluster) is what extractTransform builds the scope
// from, so slice it too - same boundaries the pilot harness proves eval cleanly in node.
var BLOCK_GENERIC = slice('var CLIENT_BY_DOMAIN = {', '// Image-based Caleres/Corrigo request', 'generic cluster (genericBodyScope)');
var BLOCK_TX = slice('function isTransform(', '// ---- Create WO modal', 'Transform extractor cluster');
var exportLine = '\n;this.isTransform=isTransform;this.extractTransform=extractTransform;' +
  'this.transformDne=transformDne;this.transformStore=transformStore;this.transformRef=transformRef;' +
  'this.transformTrade=transformTrade;';
var api = {};
vm.runInNewContext(BLOCK_GENERIC + '\n' + BLOCK_TX + exportLine, api);

var SENDER = 'Alex.Poe@transformco.com';

// ---- Corpus fixtures, SANITIZED --------------------------------------------------------------
// Layout and anchors reproduce the corpus this path was built against; every person, work email
// local-part, phone number, street address, store number, serial and client PO reference is
// synthetic. The transformco.com sender DOMAIN survives because isTransform keys on it. Do NOT
// paste a real client email here: this repo is anonymously readable, and assert.js prints got/want
// into public CI logs on failure.
var C = {
  wo8001: {
    sender: SENDER,
    subject: 'RE: 8001 - Griffith: Power Loss   URGENT',
    body: [
      'Our alarm system is down. Please see if you can dispatch an electrician to this location today to check the power supply and advise. Restore if possible, Could be just a tripped breaker.',
      '',
      'Ref. WO #7001. NTE $1K authorized.',
      '',
      'Please confirm ASAP if this can be done.',
      '', 'Thanks,', 'Alex', 'Facility Services', 'TRANSFORMCO', '555-0130'
    ].join('\n'),
    store: '8001', ref: '7001', dne: '1000.00', trade: 'Electrical', scopeHas: 'alarm system is down'
  },
  wo8002: {
    sender: SENDER,
    subject: '8002 - Castleton: Parking Lot Lights',
    body: [
      'Mall reports that the parking lot lights are down and very dark at night behind Primark and Hobby Lobby.',
      '',
      'Please dispatch a tech right away to troubleshoot and restore the parking lot lights. Boom lift may be required.',
      '',
      'Ref. WO #7002. NTE $2K authorized.',
      '', 'Advise ETA ASAP, please!', '', 'Thanks,', 'Alex'
    ].join('\n'),
    store: '8002', ref: '7002', dne: '2000.00', trade: 'Electrical', scopeHas: 'parking lot lights'
  },
  wo8003: {
    sender: 'Robin.Loe@transformco.com',
    subject: '8003 St Peters, MO - Back Flow Inspection - Emergency WO# 7003',
    body: [
      'Broadway,', '',
      'We need Backflow inspection completed for 8003 St Peters, MO.',
      'We completed ASAP, or face fines from local authorities.',
      '', 'Serial # - BF-TF0000', 'Manufacturer - Wilkins', 'Model - 957 - Domestic Water.',
      '', 'Work Order# 7003', 'NTE - $400',
      '', 'Robin M Loe', 'TRANSFORMCO'
    ].join('\n'),
    store: '8003', ref: '7003', dne: '400.00', trade: 'Plumbing', scopeHas: 'Backflow'
  },
  wo8004: {
    sender: 'Robin.Loe@transformco.com',
    subject: '8004 Schaumburg, IL - Dock Drains are Clogged WO-7004',
    body: [
      'Broadway,', '',
      'Not sure if sent this already but need to investigate the dock drains as last heavy rain storm filled the docks with water. Can we get someone out to look into the drain issue ASAP',
      '', 'Work Order# 7004',
      '', 'Robin M Loe', 'TRANSFORMCO'
    ].join('\n'),
    store: '8004', ref: '7004', dne: '0.00', trade: 'Plumbing', scopeHas: 'dock drains'
  },
  wo8005: {
    sender: 'Sam.Roe@Transformco.com',
    subject: 'Kmart 8005 Mc Allen, TX - One Parking Lot Lights',
    body: [
      'Broadway,', '',
      'We just received a complaint from the Property Manager that we have several parking lot poles that are out. We dispatched an electrician and he found a major short that caused all of the wires to be damaged.',
      '',
      'Are you able to provide a proposal for this? When on site he will need to call Dana Quinn at 555-0131.',
      '', 'P.O. #7005', 'NTE: $750.00',
      '', 'This is a closed/vacant location and below is a reminder on how to gain access to the building.',
      'STEP 1 (CALL ADT):', 'Sam Roe', 'TRANSFORMCO'
    ].join('\n'),
    store: '8005', ref: '7005', dne: '750.00', trade: 'Electrical', scopeHas: 'parking lot poles'
  },
  wo8006: {
    sender: 'Sam.Roe@Transformco.com',
    subject: 'Former Kmart 8006 (tenant At Home) Long Beach, CA - Electrical Vandalism Proposal',
    body: [
      'Broadway,', '',
      'September of last year (2025) after At Home vacated our location in Long Beach, CA, the majority of the electrical was heavily vandalized. We would like for you to provide a proposal to restore partial electrical.',
      '', 'Unit #8006', '2900 Example Blvd', 'Long Beach, CA  90899',
      '', 'Sam Roe', 'TRANSFORMCO'
    ].join('\n'),
    store: '8006', ref: '', dne: '0.00', trade: 'Electrical', scopeHas: 'vandalized'
  }
};

console.log('Transform SR Brands intake - extractTransform over the real corpus (client #23914)\n');

console.log('# detection');
A.ok('a transformco.com sender is Transform', api.isTransform(SENDER, C.wo8002.subject, C.wo8002.body) === true);
A.ok('Transformco.com (mixed case) is Transform', api.isTransform('Sam.Roe@Transformco.com', C.wo8005.subject, C.wo8005.body) === true);
// Dropped from a Broadway reply: sender is broadwaynational.com, but the quoted TransformCo request
// carries a transformco.com address + the TRANSFORMCO signature (the 8007 .eml shape).
A.ok('a Broadway reply quoting a TransformCo request is Transform',
  api.isTransform('employee1@broadwaynational.com', 'Re: 8007 -Spokane: Site Access',
    'Please dispatch a tech ... Alex.Poe@transformco.com Facility Services TRANSFORMCO 555-0130') === true);
A.ok('a plain Broadway note (no TransformCo content) is NOT Transform',
  api.isTransform('employee2@broadwaynational.com', 'internal note', 'just a heads up to the team') === false);
A.ok('a Pilot PO is NOT Transform', api.isTransform('orders@pilottravelcenters.com', 'Store 399', 'PO 12345678 store 399') === false);
A.ok('a Fairmarkit Amazon RFQ is NOT Transform', api.isTransform('info@m.fairmarkit.com', 'Amazon.com, Inc. - Request for Quote #4100888', 'RFQ ID: 4100888') === false);

console.log('\n# field mapping over the corpus (store# = locationNumber, ref = both source fields, NTE = DNE)');
Object.keys(C).forEach(function (k) {
  var e = C[k];
  var out = api.extractTransform(e.subject, e.body);
  A.eq('  [' + k + '] Location = store number ' + e.store, out.store, e.store);
  A.eq('  [' + k + '] ref (-> Source Job # AND Source PO #) = ' + JSON.stringify(e.ref), out.ref, e.ref);
  A.eq('  [' + k + '] Client DNE = ' + e.dne + ' (from the NTE)', out.dne, e.dne);
  A.eq('  [' + k + '] Trade = ' + e.trade, out.trade, e.trade);
  A.ok('  [' + k + '] scope carries "' + e.scopeHas + '"', out.scope.indexOf(e.scopeHas) >= 0, 'got ' + JSON.stringify(out.scope));
  A.ok('  [' + k + '] scope <= 600', out.scope.length <= 600, 'len ' + out.scope.length);
});

console.log('\n# store number and ref number never collide (both ~4 digits, both in one subject)');
A.ok('  [8003] store 8003 != ref 7003', api.extractTransform(C.wo8003.subject, C.wo8003.body).store !== api.extractTransform(C.wo8003.subject, C.wo8003.body).ref);
A.ok('  [8004] store 8004 != ref 7004', C.wo8004.store !== C.wo8004.ref);

console.log('\n# transformDne unit checks (the two forms the generic NTE regex misses)');
A.eq('  "NTE $1K" -> 1000.00', api.transformDne('Ref. WO #1. NTE $1K authorized.'), '1000.00');
A.eq('  "NTE $2K" -> 2000.00', api.transformDne('NTE $2K authorized'), '2000.00');
A.eq('  "NTE - $400" (hyphen) -> 400.00', api.transformDne('Work Order# 7003\nNTE - $400'), '400.00');
A.eq('  "NTE: $750.00" -> 750.00', api.transformDne('P.O. #7005\nNTE: $750.00'), '750.00');
A.eq('  "NTE $1,500" -> 1500.00', api.transformDne('NTE $1,500'), '1500.00');
A.eq('  "$1.5M" -> 1500000.00', api.transformDne('NTE $1.5M'), '1500000.00');
A.eq('  no NTE -> 0.00', api.transformDne('Work Order# 7004'), '0.00');

console.log('\n# transformStore unit checks (subject first, RE:/FW: stripped; body only via Unit#/Store#)');
A.eq('  "RE: 8001 - Griffith" -> 8001', api.transformStore('RE: 8001 - Griffith: Power Loss', ''), '8001');
A.eq('  "Kmart 8005 Mc Allen, TX" -> 8005', api.transformStore('Kmart 8005 Mc Allen, TX - One Parking Lot Lights', ''), '8005');
A.eq('  "Fwd: 1306 Hattiesburg MS" -> 1306', api.transformStore('Fwd: 1306 Hattiesburg MS - Alarms', ''), '1306');
A.eq('  subject has no store, body "Unit #8006" -> 8006', api.transformStore('Electrical Vandalism Proposal', 'Unit #8006'), '8006');
A.eq('  a bare body number is NOT taken as the store', api.transformStore('Vandalism Proposal', 'Work Order# 7003 phone 555-0150'), '');

console.log('\n# transformRef unit checks (label-anchored, never a bare digit run)');
A.eq('  "WO# 7003" -> 7003', api.transformRef('Emergency WO# 7003', ''), '7003');
A.eq('  "WO-7004" -> 7004', api.transformRef('Dock Drains are Clogged WO-7004', ''), '7004');
A.eq('  "Ref. WO #7001" -> 7001', api.transformRef('', 'Ref. WO #7001. NTE $1K authorized.'), '7001');
A.eq('  "P.O. #7005" -> 7005', api.transformRef('', 'P.O. #7005\nNTE: $750.00'), '7005');
A.eq('  "Work Order coming soon" (no number) -> blank', api.transformRef('', 'Work Order coming soon. NTE $1500'), '');

console.log('\n# transformTrade spot checks (best-effort, blank when ambiguous)');
A.eq('  parking lot lights -> Electrical', api.transformTrade('the parking lot lights are out'), 'Electrical');
A.eq('  Backflow -> Plumbing', api.transformTrade('Backflow inspection completed'), 'Plumbing');
A.eq('  Back Flow (two words) -> Plumbing', api.transformTrade('Back Flow Inspection'), 'Plumbing');
A.eq('  dock drains -> Plumbing', api.transformTrade('dock drains are clogged'), 'Plumbing');
A.eq('  carpet -> Flooring', api.transformTrade('carpet replacement in certain areas'), 'Flooring');
A.eq('  alarms -> blank (created Handyman by hand; no confident trade)', api.transformTrade('alarms going off all day'), '');

console.log('\n# handleDrop wiring (source-level: fixed Reactive, both source fields, checked before generic)');
A.ok('  WO Type is fixed Reactive for Transform', full.indexOf("_transform: true, _woType: 'Reactive'") >= 0);
A.ok('  Source PO # = the ref', full.indexOf('po: tx.ref,') >= 0);
A.ok('  Source Job # = the same ref (both)', full.indexOf('sourceJob: tx.ref,') >= 0);
A.ok('  isTransform is checked BEFORE the generic extractWo fallback',
  full.indexOf('isTransform(parsed.senderEmail') < full.indexOf('if (!wo) wo = extractWo('),
  'detection order drifted');
A.ok('  Location routes through the site-code picker (selectAmazonLocation) via _transform',
  full.indexOf('wo._cwCorrigo || wo._transform') >= 0);

A.finish();
