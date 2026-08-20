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

var SENDER = 'Jorge.Belda@transformco.com';

// ---- The real corpus emails (reproduced from the parsed .msg/.eml bodies) ----------------------
var C = {
  wo9354: {
    sender: SENDER,
    subject: 'RE: 9354 - Griffith: Power Loss   URGENT',
    body: [
      'Our alarm system is down. Please see if you can dispatch an electrician to this location today to check the power supply and advise. Restore if possible, Could be just a tripped breaker.',
      '',
      'Ref. WO #4892. NTE $1K authorized.',
      '',
      'Please confirm ASAP if this can be done.',
      '', 'Thanks,', 'Jorge', 'Facility Services', 'TRANSFORMCO', '916-759-9966'
    ].join('\n'),
    store: '9354', ref: '4892', dne: '1000.00', trade: 'Electrical', scopeHas: 'alarm system is down'
  },
  wo1600: {
    sender: SENDER,
    subject: '1600 - Castleton: Parking Lot Lights',
    body: [
      'Mall reports that the parking lot lights are down and very dark at night behind Primark and Hobby Lobby.',
      '',
      'Please dispatch a tech right away to troubleshoot and restore the parking lot lights. Boom lift may be required.',
      '',
      'Ref. WO #4909. NTE $2K authorized.',
      '', 'Advise ETA ASAP, please!', '', 'Thanks,', 'Jorge'
    ].join('\n'),
    store: '1600', ref: '4909', dne: '2000.00', trade: 'Electrical', scopeHas: 'parking lot lights'
  },
  wo1182: {
    sender: 'Steven.Pruett@transformco.com',
    subject: '1182 St Peters, MO - Back Flow Inspection - Emergency WO# 4874',
    body: [
      'Broadway,', '',
      'We need Backflow inspection completed for 1182 St Peters, MO.',
      'We completed ASAP, or face fines from local authorities.',
      '', 'Serial # - BF-TF1480', 'Manufacturer - Wilkins', 'Model - 957 - Domestic Water.',
      '', 'Work Order# 4874', 'NTE - $400',
      '', 'Steven M Pruett', 'TRANSFORMCO'
    ].join('\n'),
    store: '1182', ref: '4874', dne: '400.00', trade: 'Plumbing', scopeHas: 'Backflow'
  },
  wo1570: {
    sender: 'Steven.Pruett@transformco.com',
    subject: '1570 Schaumburg, IL - Dock Drains are Clogged WO-4833',
    body: [
      'Broadway,', '',
      'Not sure if sent this already but need to investigate the dock drains as last heavy rain storm filled the docks with water. Can we get someone out to look into the drain issue ASAP',
      '', 'Work Order# 4833',
      '', 'Steven M Pruett', 'TRANSFORMCO'
    ].join('\n'),
    store: '1570', ref: '4833', dne: '0.00', trade: 'Plumbing', scopeHas: 'dock drains'
  },
  wo4389: {
    sender: 'William.Lord@Transformco.com',
    subject: 'Kmart 4389 Mc Allen, TX - One Parking Lot Lights',
    body: [
      'Broadway,', '',
      'We just received a complaint from the Property Manager that we have several parking lot poles that are out. We dispatched an electrician and he found a major short that caused all of the wires to be damaged.',
      '',
      'Are you able to provide a proposal for this? When on site he will need to call Kevin Kurtz at 814-771-8023.',
      '', 'P.O. #4885', 'NTE: $750.00',
      '', 'This is a closed/vacant location and below is a reminder on how to gain access to the building.',
      'STEP 1 (CALL ADT):', 'Bill Lord', 'TRANSFORMCO'
    ].join('\n'),
    store: '4389', ref: '4885', dne: '750.00', trade: 'Electrical', scopeHas: 'parking lot poles'
  },
  wo9328: {
    sender: 'William.Lord@Transformco.com',
    subject: 'Former Kmart 9328 (tenant At Home) Long Beach, CA - Electrical Vandalism Proposal',
    body: [
      'Broadway,', '',
      'September of last year (2025) after At Home vacated our location in Long Beach, CA, the majority of the electrical was heavily vandalized. We would like for you to provide a proposal to restore partial electrical.',
      '', 'Unit #9328', '2900 Bellflower Blvd', 'Long Beach, CA  90815',
      '', 'Bill Lord', 'TRANSFORMCO'
    ].join('\n'),
    store: '9328', ref: '', dne: '0.00', trade: 'Electrical', scopeHas: 'vandalized'
  }
};

console.log('Transform SR Brands intake - extractTransform over the real corpus (client #23914)\n');

console.log('# detection');
A.ok('a transformco.com sender is Transform', api.isTransform(SENDER, C.wo1600.subject, C.wo1600.body) === true);
A.ok('Transformco.com (mixed case) is Transform', api.isTransform('William.Lord@Transformco.com', C.wo4389.subject, C.wo4389.body) === true);
// Dropped from a Broadway reply: sender is broadwaynational.com, but the quoted TransformCo request
// carries a transformco.com address + the TRANSFORMCO signature (the 1029 .eml shape).
A.ok('a Broadway reply quoting a TransformCo request is Transform',
  api.isTransform('CSuarez@broadwaynational.com', 'Re: 1029 -Spokane: Site Access',
    'Please dispatch a tech ... Jorge.Belda@transformco.com Facility Services TRANSFORMCO 916-759-9966') === true);
A.ok('a plain Broadway note (no TransformCo content) is NOT Transform',
  api.isTransform('nspataro@broadwaynational.com', 'internal note', 'just a heads up to the team') === false);
A.ok('a Pilot PO is NOT Transform', api.isTransform('orders@pilottravelcenters.com', 'Store 305', 'PO 12345678 store 305') === false);
A.ok('a Fairmarkit Amazon RFQ is NOT Transform', api.isTransform('info@m.fairmarkit.com', 'Amazon.com, Inc. - Request for Quote #2905000', 'RFQ ID: 2905000') === false);

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
A.ok('  [1182] store 1182 != ref 4874', api.extractTransform(C.wo1182.subject, C.wo1182.body).store !== api.extractTransform(C.wo1182.subject, C.wo1182.body).ref);
A.ok('  [1570] store 1570 != ref 4833', C.wo1570.store !== C.wo1570.ref);

console.log('\n# transformDne unit checks (the two forms the generic NTE regex misses)');
A.eq('  "NTE $1K" -> 1000.00', api.transformDne('Ref. WO #1. NTE $1K authorized.'), '1000.00');
A.eq('  "NTE $2K" -> 2000.00', api.transformDne('NTE $2K authorized'), '2000.00');
A.eq('  "NTE - $400" (hyphen) -> 400.00', api.transformDne('Work Order# 4874\nNTE - $400'), '400.00');
A.eq('  "NTE: $750.00" -> 750.00', api.transformDne('P.O. #4885\nNTE: $750.00'), '750.00');
A.eq('  "NTE $1,500" -> 1500.00', api.transformDne('NTE $1,500'), '1500.00');
A.eq('  "$1.5M" -> 1500000.00', api.transformDne('NTE $1.5M'), '1500000.00');
A.eq('  no NTE -> 0.00', api.transformDne('Work Order# 4833'), '0.00');

console.log('\n# transformStore unit checks (subject first, RE:/FW: stripped; body only via Unit#/Store#)');
A.eq('  "RE: 9354 - Griffith" -> 9354', api.transformStore('RE: 9354 - Griffith: Power Loss', ''), '9354');
A.eq('  "Kmart 4389 Mc Allen, TX" -> 4389', api.transformStore('Kmart 4389 Mc Allen, TX - One Parking Lot Lights', ''), '4389');
A.eq('  "Fwd: 1306 Hattiesburg MS" -> 1306', api.transformStore('Fwd: 1306 Hattiesburg MS - Alarms', ''), '1306');
A.eq('  subject has no store, body "Unit #9328" -> 9328', api.transformStore('Electrical Vandalism Proposal', 'Unit #9328'), '9328');
A.eq('  a bare body number is NOT taken as the store', api.transformStore('Vandalism Proposal', 'Work Order# 4874 phone 814-771-8023'), '');

console.log('\n# transformRef unit checks (label-anchored, never a bare digit run)');
A.eq('  "WO# 4874" -> 4874', api.transformRef('Emergency WO# 4874', ''), '4874');
A.eq('  "WO-4833" -> 4833', api.transformRef('Dock Drains are Clogged WO-4833', ''), '4833');
A.eq('  "Ref. WO #4892" -> 4892', api.transformRef('', 'Ref. WO #4892. NTE $1K authorized.'), '4892');
A.eq('  "P.O. #4885" -> 4885', api.transformRef('', 'P.O. #4885\nNTE: $750.00'), '4885');
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
