// test-cw-corrigo-intake.js - node harness for the CW-Amazon-via-CorrigoPro (C&W Services on the
// CorrigoPro Work Order Network) intake path added to bwn-wo-intake.user.js 0.9.15.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). It follows the proven
// pattern: slice the REAL shipped block out of the userscript and run it in a vm, here against the
// real CorrigoPro "WORK ORDER #..." email body this path was built from (WO #AMNEXM2000123, the
// email Mike showed mis-mapping). The extractor is a pure function of (subject, body), so no DOM is
// needed - this covers exactly the code that was added.
//
// WHY THIS PATH EXISTS - Cushman & Wakefield ("C&W Services") dispatches Amazon work through TWO
// channels: FAMIS 360 (amazon@ilrs.360facility.net, handled by extractCwAmazon) AND CorrigoPro
// (alerts@am.corrigopro.com, "received from C&W Services"). The CorrigoPro one has the SAME body
// format as JLL-Amazon but a different brand, so before 0.9.15 it matched NO detector and fell
// through to the generic path: client became "am corrigopro" (from the sender domain) and the raw
// body was dumped as the scope. This path routes it to the real "CW-Amazon" client (#20432).
//
// WHAT IS UNDER TEST - extractCwCorrigo + its helpers (isCwCorrigo / cwCorrigoWoType /
// cwCorrigoPriority / cwCorrigoTrade), the mapping to the Create WO fields (screenshot ground truth):
//   - Client   -> "CW-Amazon" (asserted at the handleDrop wiring level; here we assert the inputs)
//   - Location -> site code from "Requested By: AMAZON <code>" = IFM-EXM2 (Umbrava locationNumber)
//   - Source Job # AND Source PO # = the CorrigoPro WO number AMNEXM2000123 (both)
//   - WO Type  = Preventative (this is a PM job); the Details "Type: Reactive" is a CorrigoPro
//                ridealong, NOT the Umbrava WO type, so it is ignored
//   - Priority = the Details "Priority:" value "PM" -> "Scheduled PPM"
//   - Trade    = the Problem "<Area> > <Issue>" head "Electrical Issues" -> Electrical
//   - Client DNE = the NTE "$0.00 USD" -> 0.00
//   - Scope    = the Problem block, newlines preserved (3 lines)

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

// The whole CW-Corrigo helper cluster, verbatim from the userscript (ends at the JLL block).
var BLOCK = slice('function isCwCorrigo(', '// ---- JLL-Amazon', 'CW-Corrigo extractor');
var exportLine = '\n;this.isCwCorrigo=isCwCorrigo;this.extractCwCorrigo=extractCwCorrigo;' +
  'this.cwCorrigoWoType=cwCorrigoWoType;this.cwCorrigoPriority=cwCorrigoPriority;this.cwCorrigoTrade=cwCorrigoTrade;';
var api = {};
vm.runInNewContext(BLOCK + exportLine, api);

var SENDER = 'alerts@am.corrigopro.com';
var SUBJECT = 'The new PM work order #AMNEXM2000123 received from C&W Services';

// SANITIZED fixture. This reproduces the SHAPE of the CorrigoPro body the path was built from -
// every anchor the extractor keys on, with the tabs, blank lines and underscore rules CorrigoPro
// pads with, so the flattened-label path and the newline-preserving Problem path are both
// exercised. The WO number, site code, street address, zip and phone numbers are synthetic; the
// city/state survive because the Location matcher scores on them. Do NOT paste a real client email
// here: this repo is anonymously readable, and assert.js prints got/want into public CI logs.
// Parameterized the way test-jll-amazon-intake.js does it, so the corpus can cover more than one
// shape without a second copy of the boilerplate. Only the fields the extractor's documented rules
// branch on vary: NTE phrasing, Priority, the Problem block, and the WO number. Nothing here
// invents a format variation the shipped corpus does not evidence - Hard Rule 6 forbids guessing a
// document shape, so a genuinely new CorrigoPro layout needs a real sample, not an assumption.
function corrigoBody(o) {
  o = o || {};
  return [
    '  <https://login.corrigo.com/Content/Images/connection_center_email_logo.png?v=2> ',
    '',
    '  <https://am-desktop.corrigopro.com//ServiceChat/Chat/Barcode?code=90000010_aa000010> \t',
    'Broadway National - CW Amazon',
    '',
    '100 Davids Drive, Hauppauge, NY 11788, US',
    '',
    '+1 555-0100',
    '',
    'For C&W Services',
    '',
    'Fax this back to (800) 555-0101',
    '',
    'Click here to accept/reject this work order in CorrigoPro.',
    '',
    'WORK ORDER #' + (o.wo || 'AMNEXM2000123') + ' ',
    'Date Created: \tNTE: $' + (o.nte === undefined ? '0.00' : o.nte) + ' USD \t',
    '8/12/2026 11:23 AM \tIf you believe you will go over this amount, please submit a quote in CorrigoPro. \t',
    'Customer ',
    '  _____  ',
    '',
    'Name:\t C&W Services\t ',
    'Requested By:\t AMAZON ' + (o.code || 'IFM-EXM2') + ' - Staten Island ',
    '',
    '210 Example Ave ',
    'Site Address:\t 210 Example Ave, Staten Island, NY 10399-0001, US\t ',
    'Service Contact Manager:\t Facility 88 Admin 88 Placeholder88@placeholder.com\t ',
    'Problem ',
    '  _____  ',
    ''
  ].concat(o.problem || ['Interior > Electrical Issues \t', 'Preventive Maintenance Task\t ',
    '12 MONTHLY MEDIUM AMAZON LOW VOLTAGE CABINETS\t ']).concat([
    'Details ',
    '  _____  ',
    '',
    'Priority:',
    (o.priority === undefined ? 'PM' : o.priority),
    'Type:',
    'Reactive',
    'Accept/Reject By:',
    '8/13/2026 11:30 AM',
    'On-Site By:',
    '8/14/2026 11:30 AM',
    'Complete By:',
    (o.completeBy || '9/23/2026 11:30 PM'),
    'Appointment Type:',
    'N/A',
    'Execution Plan:',
    'Procedures ',
    '  _____  ',
    '',
    'This work order requires the following procedures to be executed:',
    '',
    'Take 5 ',
    'Asset: Electrical Issues ',
    'Done 0 of 17 '
  ]).join('\n');
}

var BODY = corrigoBody({});

console.log('CW-Amazon via CorrigoPro intake - extractCwCorrigo over the real WO #AMNEXM2000123 email\n');

// Detection: the C&W CorrigoPro email is CW-Corrigo, and NOT any sibling feed.
console.log('# detection');
A.ok('detected as CW-Corrigo', api.isCwCorrigo(SENDER, SUBJECT, BODY) === true);

var out = api.extractCwCorrigo(SUBJECT, BODY);

console.log('\n# field mapping (screenshot ground truth)');
A.ok('WO # -> Source Job # AND Source PO # = AMNEXM2000123', out.woNumber === 'AMNEXM2000123', 'got ' + out.woNumber);
A.ok('Site code = IFM-EXM2 (the full code, not bare JFK8)', out.siteCode === 'IFM-EXM2', 'got ' + out.siteCode);
A.ok('WO Type = Preventative (PM job - Details "Type:" ridealong ignored)', out.woType === 'Preventative', 'got ' + out.woType);
A.ok('Priority = Scheduled PPM (from "PM")', out.priority === 'Scheduled PPM', 'got ' + JSON.stringify(out.priority) + ' from ' + JSON.stringify(out.priorityRaw));
A.ok('Trade = Electrical', out.trade === 'Electrical', 'got ' + JSON.stringify(out.trade));
A.ok('Client DNE = 0.00', out.dne === '0.00', 'got ' + out.dne);
A.ok('Complete By = 9/23/2026 11:30 PM', out.completeBy === '9/23/2026 11:30 PM', 'got ' + JSON.stringify(out.completeBy));
A.ok('Scope is the 3-line Problem block', out.scope ===
  'Interior > Electrical Issues\nPreventive Maintenance Task\n12 MONTHLY MEDIUM AMAZON LOW VOLTAGE CABINETS',
  'got ' + JSON.stringify(out.scope));
A.ok('scope capped <= 600', out.scope.length <= 600, 'len ' + out.scope.length);
A.ok('references the CorrigoPro WO in the note', out._note.indexOf('AMNEXM2000123') >= 0, 'got ' + out._note);
A.ok('warns that procedures/JHA live in CorrigoPro', /procedure|JHA|attach/i.test(out._warn), 'got ' + JSON.stringify(out._warn));

// Address parse (secondary Location score / toast) - matches the site's street/city/state.
console.log('\n# address parse (secondary Location score)');
A.ok('street # 210', out._addr.streetNum === '210', 'got ' + out._addr.streetNum);
A.ok('city Staten Island', out._addr.city === 'Staten Island', 'got ' + JSON.stringify(out._addr.city));
A.ok('state NY', out._addr.state === 'NY', 'got ' + out._addr.state);

// Detection boundaries: CW-Corrigo must NOT swallow the sibling feeds, and they must NOT swallow it.
console.log('\n# detection boundaries');
var JLL_SUBJECT = 'The new work order #BNA9900001 received from JLL Amazon';
var JLL_BODY = 'Broadway National - JLL Amazon For JLL Amazon WORK ORDER #BNA9900001 Property: BNA99';
A.ok('a JLL-Amazon email is NOT CW-Corrigo', api.isCwCorrigo('alerts@am.corrigopro.com', JLL_SUBJECT, JLL_BODY) === false);
A.ok('a Fairmarkit Amazon RFQ is NOT CW-Corrigo',
  api.isCwCorrigo('info@m.fairmarkit.com', 'Amazon.com, Inc. - Request for Quote #4100888', 'RFQ ID: 4100888') === false);
A.ok('a FAMIS CW-Amazon email is NOT CW-Corrigo (different channel, different detector)',
  api.isCwCorrigo('amazon@ilrs.360facility.net', 'NEW AMAZON - FTX4 - ...', 'Case Summary Request ID: 999001 amazon.famis360.com') === false);
A.ok('a plain Pilot PO is NOT CW-Corrigo',
  api.isCwCorrigo('orders@pilottravelcenters.com', 'Purchase Order 12345678', 'PO # 12345678 store 0499') === false);

// WO-type rule unit checks. The Details "Type:" ridealong is IGNORED; the PM/preventive signal
// (Priority "PM" / "Preventive Maintenance Task" problem / "PM work order" subject) drives it.
console.log('\n# WO Type rule (PM signal, NOT the Details "Type:" ridealong)');
A.ok('Priority "PM" -> Preventative (even though Details Type says Reactive)',
  api.cwCorrigoWoType('PM', 'Interior > Electrical Issues Preventive Maintenance Task', 'The new PM work order #X received from C&W Services') === 'Preventative');
A.ok('"Preventive Maintenance Task" problem -> Preventative',
  api.cwCorrigoWoType('', 'Preventive Maintenance Task', '') === 'Preventative');
A.ok('proposal / quote-request problem -> Proposal',
  api.cwCorrigoWoType('P4', 'Please provide quote to replace the backflow', '') === 'Proposal');
A.ok('no PM signal -> Reactive',
  api.cwCorrigoWoType('P5', 'Interior > Electrical Issues no power to overhead door', 'The new work order #Y received from C&W Services') === 'Reactive');

// Priority rule unit checks.
console.log('\n# Priority rule');
A.ok('PM -> Scheduled PPM', api.cwCorrigoPriority('PM') === 'Scheduled PPM');
A.ok('P4-Scheduled -> P4', api.cwCorrigoPriority('P4-Scheduled - 2D/15D') === 'P4');
A.ok('P5-Low -> P5', api.cwCorrigoPriority('P5-Low - Minor Issues') === 'P5');
A.ok('(blank) -> blank', api.cwCorrigoPriority('') === '');

// Trade rule spot checks.
console.log('\n# Trade rule');
A.ok('Electrical Issues -> Electrical', api.cwCorrigoTrade('Electrical Issues') === 'Electrical');
A.ok('Plumbing -> Plumbing', api.cwCorrigoTrade('Plumbing Repair') === 'Plumbing');
A.ok('Dock Door -> Doors and Hardware', api.cwCorrigoTrade('Dock Door Maintenance') === 'Doors and Hardware');
A.ok('unknown -> blank (user picks)', api.cwCorrigoTrade('General Facilities') === '');

// ---- Additional corpus shapes ------------------------------------------------------------------
// The path shipped with a single email, so only the PM/Electrical/$0.00 combination was ever
// exercised end to end; the type, priority, trade and DNE rules were covered by unit checks alone.
// These two drive the whole extractor over the other documented branches, which is where a
// regression would actually reach a coordinator.

console.log('\n# corpus: reactive plumbing, comma-formatted NTE, P5 priority');
var REACT_SUBJECT = 'The new work order #AMNEXM2000456 received from C&W Services';
var REACT_BODY = corrigoBody({
  wo: 'AMNEXM2000456', nte: '1,414.71', priority: 'P5-Low - Minor Issues - 2D/30D',
  completeBy: '10/01/2026 5:00 PM',
  problem: ['Interior > Plumbing \t', 'Water leak under the mop sink\t ']
});
A.ok('detected as CW-Corrigo', api.isCwCorrigo(SENDER, REACT_SUBJECT, REACT_BODY) === true);
var react = api.extractCwCorrigo(REACT_SUBJECT, REACT_BODY);
A.eq('  WO # = AMNEXM2000456', react.woNumber, 'AMNEXM2000456');
A.eq('  WO Type = Reactive (no PM signal in priority, problem or subject)', react.woType, 'Reactive');
A.eq('  Priority = P5', react.priority, 'P5');
A.eq('  Trade = Plumbing', react.trade, 'Plumbing');
A.eq('  Client DNE = 1414.71 (comma stripped)', react.dne, '1414.71');
A.eq('  Complete By carried through', react.completeBy, '10/01/2026 5:00 PM');
A.eq('  Scope is the 2-line Problem block', react.scope, 'Interior > Plumbing\nWater leak under the mop sink');

console.log('\n# corpus: proposal request, P4 priority, no NTE -> 0.00');
var PROP_SUBJECT = 'The new work order #AMNEXM2000789 received from C&W Services';
var PROP_BODY = corrigoBody({
  wo: 'AMNEXM2000789', nte: '', priority: 'P4-Scheduled - 2D/15D',
  problem: ['Exterior > Dock Door \t', 'Please provide quote to replace the dock leveler\t ']
});
A.ok('detected as CW-Corrigo', api.isCwCorrigo(SENDER, PROP_SUBJECT, PROP_BODY) === true);
var prop = api.extractCwCorrigo(PROP_SUBJECT, PROP_BODY);
A.eq('  WO Type = Proposal (quote request in the Problem block)', prop.woType, 'Proposal');
A.eq('  Priority = P4', prop.priority, 'P4');
A.eq('  Trade = Doors and Hardware', prop.trade, 'Doors and Hardware');
A.eq('  Client DNE = 0.00 when the NTE amount is absent', prop.dne, '0.00');

console.log('\n# corpus: the three shapes are genuinely different (guards against a copy-paste corpus)');
A.ok('the three bodies differ', BODY !== REACT_BODY && REACT_BODY !== PROP_BODY && BODY !== PROP_BODY);
A.ok('the three WO types are not all the same',
  !(out.woType === react.woType && react.woType === prop.woType),
  'all three cases resolved to ' + out.woType);

A.finish();
