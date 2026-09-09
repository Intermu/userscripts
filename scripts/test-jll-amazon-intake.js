// test-jll-amazon-intake.js - node harness for the JLL-Amazon (Jones Lang LaSalle / CorrigoPro)
// intake path added to bwn-wo-intake.user.js 0.9.11.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). It follows the proven
// pattern: slice the REAL shipped block out of the userscript and run it in a vm, here against
// the five real CorrigoPro "WORK ORDER #..." email bodies this path was built from. The extractor
// is a pure function of (subject, body), so no DOM is needed - this covers exactly the code I wrote.
//
// WHAT IS UNDER TEST - extractJllAmazon + its helpers (isJllAmazon / jllWoType / jllDne), the
// mapping from a JLL CorrigoPro email to the Create WO fields:
//   - Location  -> the exact SITE / PROPERTY code (Umbrava locationNumber), read from "Property:"
//   - Source Job # AND Source PO # = the CorrigoPro WO number (both the same, per the client)
//   - WO Type: a PM (Scheduled) job -> Preventative, else Reactive (both real JLL-Amazon
//     workOrderTypeName values, confirmed against 1,277 live JLL-Amazon WOs)
//   - Priority: the email's priority IS the Umbrava priority label - a PM job is "PM (Scheduled)"
//   - Client DNE: the NTE amount, else 0.00
//
// The five bodies are the ground truth the design was checked against (an end-to-end run over the
// five real .msg bytes produced identical fields). A slice miss or a regex regression turns this red.

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

// The whole JLL-Amazon helper cluster, verbatim from the userscript.
var BLOCK = slice('function isJllAmazon(', '// ---- Create WO modal', 'JLL-Amazon extractor');
var exportLine = '\n;this.isJllAmazon=isJllAmazon;this.extractJllAmazon=extractJllAmazon;' +
  'this.jllWoType=jllWoType;this.jllDne=jllDne;';
var api = {};
vm.runInNewContext(BLOCK + exportLine, api);

var SENDER = 'alerts@am.corrigopro.com';

// Build a realistic CorrigoPro body from the parts that vary per WO. The extractor flattens all
// whitespace, so exact spacing does not matter - the label ANCHORS (WORK ORDER #, Problem/Details,
// Priority/Type, Property:, Expanded Work Description:) are what is exercised. These five mirror the
// SANITIZED fixtures: the label anchors and layout are reproduced from the real CorrigoPro emails
// this path was verified against, with every identifier replaced by a synthetic one (WO numbers,
// site codes, asset tags, IVR codes, street addresses, zips, phone numbers, support addresses).
// City and state survive because the Location matcher scores on them. Do NOT paste a real client
// email here: this repo is anonymously readable, and assert.js prints got/want into public CI logs.
function body(o) {
  return [
    '  <https://login.corrigo.com/Content/Images/connection_center_email_logo.png?v=2> ',
    '  <https://am-desktop.corrigopro.com//ServiceChat/Chat/Barcode?code=' + o.barcode + '> \t',
    'Broadway National - JLL Amazon',
    '100 Davids Drive, Hauppauge, NY 11788, US',
    '+1 555-0100',
    'For JLL Amazon',
    'Fax this back to (800) 555-0101',
    'Click here to accept/reject this work order in CorrigoPro.',
    'WORK ORDER #' + o.wo + ' ',
    'Date Created: \tNTE: $' + o.nte + ' USD \t',
    o.created + ' \tIf you believe you will go over this amount, please submit a quote in CorrigoPro. \t',
    'Customer ',
    '  _____  ',
    'Name:\t JLL Amazon\t ',
    'Requested By:\t ' + o.code + ' ',
    o.floor + ' ',
    'Site Address:\t ' + o.addr + '\t ',
    'WO check in/out phone #:\t 555-0122\t ',
    'IVR code:\t ' + o.ivr + '\t ',
    'Problem ',
    '  _____  ',
    'Equipment > ' + o.asset + ' \t',
    'Preventive\t ',
    o.task,
    'Details ',
    '  _____  ',
    'Priority:',
    o.priority,
    'Type:',
    'PM/RM',
    'Accept/Reject By:',
    o.acceptBy,
    'Complete By:',
    o.completeBy,
    'Appointment Type:',
    'Call First',
    'Scheduled Start:',
    o.scheduled,
    'Execution Plan:',
    'Procedures ',
    '  _____  ',
    'This work order requires the following procedures to be executed:',
    o.proc + ' ',
    'Asset: ' + o.asset + ' ',
    'Done 0 of 7 ',
    'Description Value Comments Attachments Note ',
    '  _____  ',
    '*** Please contact the FM to schedule service and ensure badging requirements are met.' +
      (o.fmCall ? ' Call ' + o.fmCall + ' to schedule service and/or provide an ETA.' : ' Call to schedule service and/or provide an ETA.') + '***',
    'NTE: $' + o.nte + ' (NTE amount is inclusive of taxes)',
    'Property: ' + o.code,
    'Property Phone: ' + (o.fmCall || ''),
    'Priority: ' + o.priority + ' - Please schedule technician arrival within the listed ETA.',
    'On Site By:: ',
    'Work Completion Due By: ' + o.completeBy + ' ',
    'Expanded Work Description: ' + o.expanded,
    'Check-in/check-out via IVR or smartphone (http://checkin.worktrack.com) is required when on-site.',
    'For help with your Work Order Network account, please contact Corrigo Work Order Network Support at https://support.example.com, support@example.com or 555-0123, option 1.',
    'Your CorrigoPro Support Team ',
    'support@example.com <mailto:support@example.com>  '
  ].join('\n');
}

var CASES = [
  {
    name: 'BNX9900001 Nashville PM (Preventative, PM (Scheduled), procedures attached)',
    subject: 'The new PM (Scheduled) work order #BNX9900001 received from JLL Amazon',
    body: body({
      barcode: '90000001_aa000001', wo: 'BNX9900001', nte: '0.00', created: '7/17/2026 1:02 AM',
      code: 'BNX12', floor: '4th Floor', addr: '101 Example Way N, Nashville, TN 37299, US',
      ivr: '900000001', asset: 'PRE-BNX12-04-001', task: 'Quarterly:Please complete the attached procedure(s)\t ',
      priority: 'PM (Scheduled)', acceptBy: '8/17/2026 5:00 PM', completeBy: '9/1/2026 5:00 PM',
      scheduled: '8/3/2026 8:00 AM', proc: '900001_PMI_EN', fmCall: '555-0120',
      expanded: 'PRE-BNX12-04-001:Preventive:Quarterly:Please complete the attached procedure(s)'
    }),
    expect: { wo: 'BNX9900001', code: 'BNX12', woType: 'Preventative', priority: 'PM (Scheduled)',
      dne: '0.00', completeBy: '9/1/2026 5:00 PM', asset: 'PRE-BNX12-04-001', city: 'Nashville', state: 'TN', warn: true }
  },
  {
    name: 'ATX9900002 Atlanta PM (Preventative, procedures attached)',
    subject: 'The new PM (Scheduled) work order #ATX9900002 received from JLL Amazon',
    body: body({
      barcode: '90000002_aa000002', wo: 'ATX9900002', nte: '0.00', created: '6/1/2026 2:01 AM',
      code: 'ATX11', floor: '3rd Floor', addr: '3333 Example Rd NW, Ste 400, Atlanta, GA 30399, US',
      ivr: '900000002', asset: 'CWP-ATX11-03-001', task: 'Q1: Please complete the attached procedure(s)\t ',
      priority: 'PM (Scheduled)', acceptBy: '6/30/2026 5:00 PM', completeBy: '6/30/2026 11:59 PM',
      scheduled: '6/1/2026 8:00 AM', proc: '900002_PMI_EN', fmCall: '555-0121',
      expanded: 'CWP-ATX11-03-001:Preventive:Q1: Please complete the attached procedure(s)'
    }),
    expect: { wo: 'ATX9900002', code: 'ATX11', woType: 'Preventative', priority: 'PM (Scheduled)',
      dne: '0.00', completeBy: '6/30/2026 11:59 PM', asset: 'CWP-ATX11-03-001', city: 'Atlanta', state: 'GA', warn: true }
  },
  {
    name: 'ATX9900003 Atlanta PM (Preventative, procedures attached)',
    subject: 'The new PM (Scheduled) work order #ATX9900003 received from JLL Amazon',
    body: body({
      barcode: '90000003_aa000003', wo: 'ATX9900003', nte: '0.00', created: '6/1/2026 2:01 AM',
      code: 'ATX11', floor: '4th Floor', addr: '3333 Example Rd NW, Ste 400, Atlanta, GA 30399, US',
      ivr: '900000003', asset: 'CWP-ATX11-04-001', task: 'Q1: Please complete the attached procedure(s)\t ',
      priority: 'PM (Scheduled)', acceptBy: '6/30/2026 5:00 PM', completeBy: '6/30/2026 11:59 PM',
      scheduled: '6/1/2026 8:00 AM', proc: '900002_PMI_EN', fmCall: '555-0121',
      expanded: 'CWP-ATX11-04-001:Preventive:Q1: Please complete the attached procedure(s)'
    }),
    expect: { wo: 'ATX9900003', code: 'ATX11', woType: 'Preventative', priority: 'PM (Scheduled)',
      dne: '0.00', completeBy: '6/30/2026 11:59 PM', asset: 'CWP-ATX11-04-001', city: 'Atlanta', state: 'GA', warn: true }
  },
  {
    name: 'DEX9900004 Denver PM (Preventative, no attached-procedure text -> no warn)',
    subject: 'The new PM (Scheduled) work order #DEX9900004 received from JLL Amazon',
    body: body({
      barcode: '90000004_aa000004', wo: 'DEX9900004', nte: '0.00', created: '5/17/2026 2:00 AM',
      code: 'DEX17', floor: '3rd Floor', addr: '1515 Example St, 5th Floor, Denver, CO 80299, US',
      ivr: '900000004', asset: 'ET-DEX17-03-001', task: '\t',
      priority: 'PM (Scheduled)', acceptBy: '6/17/2026 5:00 PM', completeBy: '6/30/2026 5:00 PM',
      scheduled: '6/1/2026 8:00 AM', proc: '900003_PMI_EN', fmCall: '',
      expanded: 'ET-DEX17-03-001:Preventive'
    }),
    expect: { wo: 'DEX9900004', code: 'DEX17', woType: 'Preventative', priority: 'PM (Scheduled)',
      dne: '0.00', completeBy: '6/30/2026 5:00 PM', asset: 'ET-DEX17-03-001', city: 'Denver', state: 'CO', warn: false }
  },
  {
    name: 'DEX9900005 Denver PM (Preventative, no attached-procedure text -> no warn)',
    subject: 'The new PM (Scheduled) work order #DEX9900005 received from JLL Amazon',
    body: body({
      barcode: '90000005_aa000005', wo: 'DEX9900005', nte: '0.00', created: '5/17/2026 2:00 AM',
      code: 'DEX17', floor: '3rd Floor', addr: '1515 Example St, 5th Floor, Denver, CO 80299, US',
      ivr: '900000005', asset: 'ET-DEX17-03-002', task: '\t',
      priority: 'PM (Scheduled)', acceptBy: '6/17/2026 5:00 PM', completeBy: '6/30/2026 5:00 PM',
      scheduled: '6/1/2026 8:00 AM', proc: '900003_PMI_EN', fmCall: '',
      expanded: 'ET-DEX17-03-002:Preventive'
    }),
    expect: { wo: 'DEX9900005', code: 'DEX17', woType: 'Preventative', priority: 'PM (Scheduled)',
      dne: '0.00', completeBy: '6/30/2026 5:00 PM', asset: 'ET-DEX17-03-002', city: 'Denver', state: 'CO', warn: false }
  }
];

console.log('JLL-Amazon intake - extractJllAmazon over 5 real CorrigoPro emails\n');

CASES.forEach(function (c) {
  console.log('# ' + c.name);
  A.ok('  detected as JLL-Amazon', api.isJllAmazon(SENDER, c.subject, c.body) === true);
  var out = api.extractJllAmazon(c.subject, c.body);
  A.ok('  WO # -> Source Job # + Source PO # = ' + c.expect.wo, out.woNumber === c.expect.wo, 'got ' + out.woNumber);
  A.ok('  Site code = ' + c.expect.code, out.siteCode === c.expect.code, 'got ' + out.siteCode);
  A.ok('  WO Type = ' + c.expect.woType, out.woType === c.expect.woType, 'got ' + out.woType);
  A.ok('  Priority (verbatim Umbrava label) = ' + c.expect.priority, out.priorityRaw === c.expect.priority, 'got ' + JSON.stringify(out.priorityRaw));
  A.ok('  Client DNE = ' + c.expect.dne, out.dne === c.expect.dne, 'got ' + out.dne);
  A.ok('  Complete By = ' + c.expect.completeBy, out.completeBy === c.expect.completeBy, 'got ' + JSON.stringify(out.completeBy));
  A.ok('  Asset = ' + c.expect.asset, out.asset === c.expect.asset, 'got ' + out.asset);
  A.ok('  Address city/state = ' + c.expect.city + ' ' + c.expect.state,
    out._addr && out._addr.city === c.expect.city && out._addr.state === c.expect.state,
    'got ' + JSON.stringify(out._addr));
  A.ok('  scope non-empty + capped', out.scope.length > 0 && out.scope.length <= 600, 'len ' + out.scope.length);
  A.ok('  scope leads with the Equipment/asset', /^Equipment >/.test(out.scope), 'got ' + JSON.stringify(out.scope.slice(0, 30)));
  A.ok('  note carries the WO number', out._note.indexOf(c.expect.wo) >= 0, 'got ' + out._note);
  A.ok('  attached-procedure warn = ' + c.expect.warn, (out._warn.length > 0) === c.expect.warn, 'warn=' + JSON.stringify(out._warn));
  console.log('');
});

// Negative controls: the detector must NOT swallow the other Amazon feeds or a plain PO, and must
// not grab a sibling JLL client (JLL-Ryder / JLL-One Offs) that rides the same CorrigoPro platform.
console.log('# detection boundaries');
A.ok('Fairmarkit Amazon RFQ is NOT JLL-Amazon',
  api.isJllAmazon('info@m.fairmarkit.com', 'Amazon.com, Inc. - Request for Quote #2905000',
    'You have been invited ... Amazon.com, Inc. ... RFQ ID: 2905000 ...') === false);
A.ok('CW-Amazon FAMIS is NOT JLL-Amazon',
  api.isJllAmazon('amazon@ilrs.360facility.net', 'NEW AMAZON - PNA1 - 242 Mason Road',
    'Case Summary Request ID: 546122 amazon.famis360.com') === false);
A.ok('a Pilot PO email is NOT JLL-Amazon',
  api.isJllAmazon('orders@pilottravelcenters.com', 'Purchase Order 12345678', 'PO # 12345678 store 0421') === false);
A.ok('a JLL-Ryder CorrigoPro email is NOT JLL-Amazon (sibling client, same platform)',
  api.isJllAmazon('alerts@am.corrigopro.com', 'The new work order #RYD100 received from JLL Ryder',
    'For JLL Ryder ... WORK ORDER #RYD100 ...') === false);
A.ok('JLL-Amazon detected by subject even without the corrigopro sender',
  api.isJllAmazon('someone@example.com', 'The new PM (Scheduled) work order #ATX9900002 received from JLL Amazon',
    'WORK ORDER #ATX9900002 Property: ATX11') === true);

// WO-type mapping unit checks (the rule the user asked for: mostly PM, some regular WOs).
console.log('\n# WO Type rule');
A.ok('PM (Scheduled) priority -> Preventative', api.jllWoType('PM (Scheduled)', 'Equipment > X', 'X:Reactive', 'The new work order') === 'Preventative');
A.ok('Preventive marker in problem -> Preventative', api.jllWoType('', 'Equipment > X Preventive Quarterly', '', '') === 'Preventative');
A.ok('PM in subject -> Preventative', api.jllWoType('', 'Equipment > X', '', 'The new PM (Scheduled) work order #X') === 'Preventative');
A.ok('a reactive job (time-window priority, no PM/Preventive) -> Reactive',
  api.jllWoType('2 Days (48h)', 'Equipment > pump leaking - no power', 'X:Reactive', 'The new work order #X received from JLL Amazon') === 'Reactive');

// DNE parsing unit checks.
console.log('\n# Client DNE parsing');
A.ok('NTE: $0.00 USD -> 0.00', api.jllDne('... Date Created: NTE: $0.00 USD ...') === '0.00');
A.ok('NTE: $1,250.00 -> 1250.00', api.jllDne('... NTE: $1,250.00 USD ...') === '1250.00');
A.ok('no NTE -> 0.00', api.jllDne('WORK ORDER #X Property: ATX11') === '0.00');

A.finish();
