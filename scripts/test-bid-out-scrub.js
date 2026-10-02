// test-bid-out-scrub.js - node harness for bid-out 0.29.0: vendor-facing scrub + do-not-contact.
//
// Slices the REAL shipped block ("Vendor-facing scrub + do-not-contact") plus parseEmails out of
// bwn-bid-out.user.js and runs it in a vm with stubbed GM / network. Structural asserts over the
// full file prove both body builders and the send path call into the tested helpers.
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bid-out-scrub.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var src = fs.readFileSync(path.join(__dirname, '..', 'bwn-bid-out.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(start, end) {
  var a = src.indexOf(start); if (a < 0) throw new Error('start not found: ' + start);
  var b = src.indexOf(end, a); if (b < 0) throw new Error('end not found: ' + end);
  return src.slice(a, b);
}
var consts = slice('  var SEND_URL = ', '  var STATUS_URL') + slice('  var SUPPRESS_URL', '  // ---- Umbrava in-page');
var parse = slice('  function parseEmails(', '  // ---- Vendor-facing scrub');
var block = slice('  // ---- Vendor-facing scrub', '  // ---- end vendor-facing scrub');

function load(netImpl) {
  var calls = [];
  var ctx = {
    console: { info: function () { ctx._info = (ctx._info || 0) + 1; } },
    GM_getValue: function (k) { return k === 'ingest_key' ? 'KEY' : ''; },
    authToken: function () { return 'TOK'; },
    gmPost: function (url, headers, body) { calls.push({ url: url, headers: headers, body: JSON.parse(JSON.stringify(body)) }); return netImpl(url, body); },
    Promise: Promise, Array: Array, JSON: JSON
  };
  ctx._calls = calls;
  vm.createContext(ctx);
  // suppressedSet is a top-level var in the slice; expose it via a getter on the context.
  vm.runInContext(consts + parse + block, ctx);
  return ctx;
}

var WO = { address: { addressLine1: '1234 Interstate Dr', city: 'Dallas', state: 'TX', postalCode: '75201' } };

(async function () {
  var c = load(function () { return Promise.resolve({ status: 404, json: null }); });

  // ---- the real screenshot text
  var shot = 'Replace photocell on our tall sign out front that says Flying J, Southern Tire Mart and IHOP.\nTO OVERRIDE EXTERIOR LIGHTING PLEASE CALL NEXREV 866-601-5520\nSite at 1234 Interstate Dr, Dallas, TX 75201';
  var out = c.scrubVendorText(shot, WO);
  A.ok('screenshot: no Flying J', !/flying\s*j/i.test(out), out);
  A.ok('screenshot: no NexRev / override line', !/nexrev|override|866-601/i.test(out), out);
  A.ok('screenshot: brand became [site]', out.indexOf('says [site], Southern') > -1, out);
  A.ok('screenshot: street + zip gone, city/state kept', !/1234|Interstate|75201/.test(out) && /Dallas, TX/.test(out), out);
  console.log('  before: ' + JSON.stringify(shot) + '\n  after : ' + JSON.stringify(out));

  // ---- false positives / ordering
  A.eq('pilot light untouched', c.scrubVendorText('Replace the pilot light and CAP the line', WO), 'Replace the pilot light and CAP the line');
  A.eq('Pilot Flying J once', c.scrubVendorText('Pilot Flying J #123', WO), '[site] #123');
  A.eq('case-insensitive + all terms', c.scrubVendorText('pfj and CROSSAMERICA partners and primark, Pilot Travel Centers', WO), '[site] and [site] and [site], [site]');
  A.eq('whole-word only (PFJX kept)', c.scrubVendorText('PFJX', WO), 'PFJX');
  A.eq('override-call line dropped, others kept', c.scrubVendorText('Fix door\nto override call dispatch\nthanks', WO), 'Fix door\nthanks');
  A.eq('blank lines collapsed', c.scrubVendorText('a\n\n\n\nb', WO), 'a\n\nb');
  A.eq('empty/null safe', c.scrubVendorText(null, WO), '');
  A.eq('no wo safe', c.scrubVendorText('Flying J', null), '[site]');

  // ---- both bodies are scrubbed (structural: builders call scrubVendorText on the scope)
  A.ok('plain-text builder scrubs scope', src.indexOf("L.push('Scope: ' + scrubVendorText(req.scope || wo.scopeOfWork || '', wo))") > -1);
  A.ok('HTML builder scrubs scope', src.indexOf("nl2br(scrubVendorText(req.scope || wo.scopeOfWork || '', wo))") > -1);
  A.ok('Scope default is scrubbed', src.indexOf("openState.scope = scrubVendorText(wo.scopeOfWork || '', wo)") > -1);
  A.ok('send handler re-checks then rebuilds html', /suppressCheck\(mail\.bcc\)[\s\S]*function doSend\(\) \{\s*var html = htmlFor\(from\);/.test(src));
  A.ok('scope note present', src.indexOf('Client names, street address and internal instructions are removed before sending.') > -1);
  A.ok('no em-dash in file', src.indexOf(String.fromCharCode(0x2014)) === -1);

  // ---- recipients: all three sources honour the suppressed set
  var state = {
    rowVendors: [{ email: 'Umb@v.com' }, { email: 'ok1@v.com' }],
    netNew: [{ email: 'nn@v.com' }, { email: 'flag@v.com', dnc: true }, { email: 'ok2@v.com' }],
    inviteText: 'Name <paste@v.com>, ok3@v.com', picked: {}
  };
  function emails(list) { return list.map(function (x) { return x.email; }); }
  A.eq('no suppression: all but flagged dnc', emails(c.recipientList(state, {})),
    ['Umb@v.com', 'ok1@v.com', 'nn@v.com', 'ok2@v.com', 'paste@v.com', 'ok3@v.com']);
  A.eq('suppressed excluded from all three sources (case-insensitive)',
    emails(c.recipientList(state, { 'umb@v.com': 1, 'nn@v.com': 1, 'paste@v.com': 1 })),
    ['ok1@v.com', 'ok2@v.com', 'ok3@v.com']);

  // ---- suppressCheck: wire shape + populates set
  var c2 = load(function () { return Promise.resolve({ status: 200, json: { suppressed: ['A@x.com'] } }); });
  var sup = await c2.suppressCheck(['a@x.com', 'b@x.com']);
  A.eq('check returns suppressed', sup, ['a@x.com']);
  A.ok('check hits bid-suppress on the SWA host', c2._calls[0].url === 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/bid-suppress');
  A.ok('check sends key + token + action', c2._calls[0].headers['x-bwn-key'] === 'KEY' && c2._calls[0].body.userToken === 'TOK' && c2._calls[0].body.action === 'check');
  A.eq('local set drives recipientList', emails(c2.recipientList({ inviteText: 'a@x.com b@x.com' }, vm.runInContext('suppressedSet', c2))), ['b@x.com']);

  // ---- 404 / network error = no filtering, console.info, no throw
  var r404 = await c.suppressCheck(['a@x.com']);
  A.ok('404 -> [] and logged', Array.isArray(r404) && r404.length === 0 && c._info === 1);
  var c3 = load(function () { return Promise.reject(new Error('boom')); });
  A.eq('network error -> []', await c3.suppressCheck(['a@x.com']), []);

  // ---- suppressAdd
  var c4 = load(function () { return Promise.resolve({ status: 200, json: { ok: true } }); });
  A.ok('add ok', (await c4.suppressAdd('Z@x.com')) === true);
  A.eq('added address is excluded', emails(c4.recipientList({ inviteText: 'z@x.com y@x.com' }, vm.runInContext('suppressedSet', c4))), ['y@x.com']);
  A.ok('add body shape', c4._calls[0].body.action === 'add' && c4._calls[0].body.note === 'marked in Bid-Out' && c4._calls[0].body.emails[0] === 'Z@x.com');
  A.ok('add on 404 -> false, not suppressed locally', (await c.suppressAdd('q@x.com')) === false && !vm.runInContext('suppressedSet', c)['q@x.com']);

  A.finish();
})();
