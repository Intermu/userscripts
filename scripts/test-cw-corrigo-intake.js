// test-cw-corrigo-intake.js - node harness for the CW-Amazon-via-CorrigoPro (C&W Services on the
// CorrigoPro Work Order Network) intake path added to bwn-wo-intake.user.js 0.9.15.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). It follows the proven
// pattern: slice the REAL shipped block out of the userscript and run it in a vm, here against the
// real CorrigoPro "WORK ORDER #..." email body this path was built from (WO #AMNJFK8000762, the
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
//   - Location -> site code from "Requested By: AMAZON <code>" = IFM-JFK8 (Umbrava locationNumber)
//   - Source Job # AND Source PO # = the CorrigoPro WO number AMNJFK8000762 (both)
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
var SUBJECT = 'The new PM work order #AMNJFK8000762 received from C&W Services';

// The real CorrigoPro body (WO #AMNJFK8000762), reproduced from the actual parsed .msg. Tabs and
// blank lines are kept realistic; the extractor flattens whitespace for the label fields and reads
// the raw newlines only for the Problem block, so both shapes are exercised.
var BODY = [
  '  <https://login.corrigo.com/Content/Images/connection_center_email_logo.png?v=2> ',
  '',
  '  <https://am-desktop.corrigopro.com//ServiceChat/Chat/Barcode?code=43509177_c091105e> \t',
  'Broadway National - CW Amazon',
  '',
  '100 Davids Drive, Hauppauge, NY 11788, US',
  '',
  '+1 631-737-3140',
  '',
  'For C&W Services',
  '',
  'Fax this back to (800) 476-8004',
  '',
  'Click here to accept/reject this work order in CorrigoPro.',
  '',
  'WORK ORDER #AMNJFK8000762 ',
  'Date Created: \tNTE: $0.00 USD \t',
  '8/12/2026 11:23 AM \tIf you believe you will go over this amount, please submit a quote in CorrigoPro. \t',
  'Customer ',
  '  _____  ',
  '',
  'Name:\t C&W Services\t ',
  'Requested By:\t AMAZON IFM-JFK8 - Staten Island ',
  '',
  '546 Gulf Ave ',
  'Site Address:\t 546 Gulf Ave, Staten Island, NY 10314-7120, US\t ',
  'Service Contact Manager:\t Facility 88 Admin 88 Placeholder88@placeholder.com\t ',
  'Problem ',
  '  _____  ',
  '',
  'Interior > Electrical Issues \t',
  'Preventive Maintenance Task\t ',
  '12 MONTHLY MEDIUM AMAZON LOW VOLTAGE CABINETS\t ',
  'Details ',
  '  _____  ',
  '',
  'Priority:',
  'PM',
  'Type:',
  'Reactive',
  'Accept/Reject By:',
  '8/13/2026 11:30 AM',
  'On-Site By:',
  '8/14/2026 11:30 AM',
  'Complete By:',
  '9/23/2026 11:30 PM',
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
].join('\n');

console.log('CW-Amazon via CorrigoPro intake - extractCwCorrigo over the real WO #AMNJFK8000762 email\n');

// Detection: the C&W CorrigoPro email is CW-Corrigo, and NOT any sibling feed.
console.log('# detection');
A.ok('detected as CW-Corrigo', api.isCwCorrigo(SENDER, SUBJECT, BODY) === true);

var out = api.extractCwCorrigo(SUBJECT, BODY);

console.log('\n# field mapping (screenshot ground truth)');
A.ok('WO # -> Source Job # AND Source PO # = AMNJFK8000762', out.woNumber === 'AMNJFK8000762', 'got ' + out.woNumber);
A.ok('Site code = IFM-JFK8 (the full code, not bare JFK8)', out.siteCode === 'IFM-JFK8', 'got ' + out.siteCode);
A.ok('WO Type = Preventative (PM job - Details "Type:" ridealong ignored)', out.woType === 'Preventative', 'got ' + out.woType);
A.ok('Priority = Scheduled PPM (from "PM")', out.priority === 'Scheduled PPM', 'got ' + JSON.stringify(out.priority) + ' from ' + JSON.stringify(out.priorityRaw));
A.ok('Trade = Electrical', out.trade === 'Electrical', 'got ' + JSON.stringify(out.trade));
A.ok('Client DNE = 0.00', out.dne === '0.00', 'got ' + out.dne);
A.ok('Complete By = 9/23/2026 11:30 PM', out.completeBy === '9/23/2026 11:30 PM', 'got ' + JSON.stringify(out.completeBy));
A.ok('Scope is the 3-line Problem block', out.scope ===
  'Interior > Electrical Issues\nPreventive Maintenance Task\n12 MONTHLY MEDIUM AMAZON LOW VOLTAGE CABINETS',
  'got ' + JSON.stringify(out.scope));
A.ok('scope capped <= 600', out.scope.length <= 600, 'len ' + out.scope.length);
A.ok('references the CorrigoPro WO in the note', out._note.indexOf('AMNJFK8000762') >= 0, 'got ' + out._note);
A.ok('warns that procedures/JHA live in CorrigoPro', /procedure|JHA|attach/i.test(out._warn), 'got ' + JSON.stringify(out._warn));

// Address parse (secondary Location score / toast) - matches the site's street/city/state.
console.log('\n# address parse (secondary Location score)');
A.ok('street # 546', out._addr.streetNum === '546', 'got ' + out._addr.streetNum);
A.ok('city Staten Island', out._addr.city === 'Staten Island', 'got ' + JSON.stringify(out._addr.city));
A.ok('state NY', out._addr.state === 'NY', 'got ' + out._addr.state);

// Detection boundaries: CW-Corrigo must NOT swallow the sibling feeds, and they must NOT swallow it.
console.log('\n# detection boundaries');
var JLL_SUBJECT = 'The new work order #BNA1233423 received from JLL Amazon';
var JLL_BODY = 'Broadway National - JLL Amazon For JLL Amazon WORK ORDER #BNA1233423 Property: BNA12';
A.ok('a JLL-Amazon email is NOT CW-Corrigo', api.isCwCorrigo('alerts@am.corrigopro.com', JLL_SUBJECT, JLL_BODY) === false);
A.ok('a Fairmarkit Amazon RFQ is NOT CW-Corrigo',
  api.isCwCorrigo('info@m.fairmarkit.com', 'Amazon.com, Inc. - Request for Quote #2905000', 'RFQ ID: 2905000') === false);
A.ok('a FAMIS CW-Amazon email is NOT CW-Corrigo (different channel, different detector)',
  api.isCwCorrigo('amazon@ilrs.360facility.net', 'NEW AMAZON - FTY4 - ...', 'Case Summary Request ID: 542498 amazon.famis360.com') === false);
A.ok('a plain Pilot PO is NOT CW-Corrigo',
  api.isCwCorrigo('orders@pilottravelcenters.com', 'Purchase Order 12345678', 'PO # 12345678 store 0421') === false);

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

A.finish();
