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
var builders = slice('  function buildBidEmail(', '  function openDraft(') + slice('  var BID_TEMPLATE =', '  // One-click send via') +
slice('  function esc(s)', String.fromCharCode(10)) + slice('  function hvacMoney(', String.fromCharCode(10)) + slice('  function hvacXlsxAvailable', String.fromCharCode(10)) +
  slice('  function attachExtOf(', '  function attachHumanSize');

function load(netImpl) {
  var calls = [];
  var ctx = {
    console: { info: function () { ctx._info = (ctx._info || 0) + 1; } },
    GM_getValue: function (k) { return k === 'ingest_key' ? 'KEY' : ''; },
    authToken: function () { return 'TOK'; },
    gmPost: function (url, headers, body) { calls.push({ url: url, headers: headers, body: JSON.parse(JSON.stringify(body)) }); return netImpl(url, body); },
    actor: function () { return { name: 'Me', email: 'me@bwn.com' }; },
    hvacPriceLineText: function () { return ''; }, hvacFullListText: function () { return ''; },
    COMPANY_ADDR: 'BWN', COMPANY_PHONE: '1', LOGO_SRC: 'x', XLSX: undefined,
    Promise: Promise, Array: Array, JSON: JSON,
    URL: URL   // browser-native in the TM sandbox; not an ECMAScript built-in, so a vm needs it passed in
  };
  ctx._calls = calls;
  vm.createContext(ctx);
  // suppressedSet is a top-level var in the slice; expose it via a getter on the context.
  vm.runInContext(consts + parse + block + builders, ctx);
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
  // every vendor-facing free-text field, in BOTH bodies + the subject (real builders, run in the vm)
  var NL = String.fromCharCode(10);
  var BAD = ['Flying J sign', 'CALL NEXREV 866-601-5520 now', 'keep this line'].join(NL);
  var wo2 = { trackingNumber: 'T1', scopeOfWork: BAD, serviceInstructions: BAD, priority: null,
    trades: [{ name: 'Electrical Flying J' }], address: WO.address };
  var req = { scope: BAD, addl: BAD, asset: BAD, history: BAD, subject: 'Pricing for Pilot Flying J (Ref #T1)', include: {} };
  var txt = c.buildBidEmail(wo2, [{ email: 'a@x.com' }], req);
  var html = c.buildBidHtml(wo2, req, 'me@bwn.com');
  A.ok('plain text: no brand / NexRev in any field', !/flyings*j|nexrev|866-601/i.test(txt.body), txt.body);
  A.ok('HTML: no brand / NexRev in any field', !/flyings*j|nexrev|866-601/i.test(html));
  A.ok('both bodies keep the clean line in each field', (txt.body.match(/keep this line/g) || []).length >= 5 && (html.match(/keep this line/g) || []).length >= 5);
  A.eq('subject scrubbed, reads naturally', txt.subject, 'Pricing for [site] (Ref #T1)');
  A.ok('default subject built from trade name is scrubbed', !/flying/i.test(c.bidSubject(wo2, { include: {} })) && c.bidSubject(wo2, { include: {} }).indexOf('Electrical [site]') > -1);
  A.ok('caller req not mutated (raw text kept for the editor)', req.addl === BAD);
  A.ok('send-time subject edit is scrubbed', src.indexOf('mail.subject = scrubVendorText(s.trim(), wo) || mail.subject') > -1);
  A.ok('textareas default to scrubbed text', ['history', 'asset', 'addl'].every(function (k) { return src.indexOf('esc(scrubVendorText(openState.' + k + ', wo))') > -1; }));
  A.ok('net-new outcome dropdown DNC also calls suppressAdd', /if \(status === 'do-not-contact'\) \{[^}]*suppressAdd\(l\.email\)/.test(src));
  A.eq('street removal leaves no stray comma (screenshot style)', c.scrubVendorText('Light out at 1234 Interstate Dr, Dallas, TX 75201 near gate', WO), 'Light out at Dallas, TX near gate');
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

  // ---- review round: brand variants (each one scrubbed, bare words untouched)
  var NBSP = String.fromCharCode(0xa0), EN = String.fromCharCode(0x2013), HY = String.fromCharCode(0x2010);
  ['FlyingJ', 'Flying-J', 'Flying' + NBSP + 'J', 'Flying' + EN + 'J', 'Flying' + HY + 'J', 'FLYING   J', 'flying_j'].forEach(function (v) {
    A.eq('variant scrubbed: ' + JSON.stringify(v), c.scrubVendorText('at ' + v + ' #9', WO), 'at [site] #9');
  });
  A.eq('Pilot-Flying-J once', c.scrubVendorText('Pilot-Flying-J', WO), '[site]');
  A.eq('PilotFlyingJ once', c.scrubVendorText('PilotFlyingJ', WO), '[site]');
  A.eq('Cross-America', c.scrubVendorText('Cross-America Partners store', WO), '[site] store');
  A.eq('Cross America', c.scrubVendorText('Cross America store', WO), '[site] store');
  A.eq('bare flying / pilot untouched', c.scrubVendorText('flying debris near pilot light, Flying Jack', WO), 'flying debris near pilot light, Flying Jack');
  ['NexRev', 'NEXREV', 'Nex Rev', 'Nex-Rev', 'nex' + NBSP + 'rev'].forEach(function (v) {
    A.eq('NexRev line dropped: ' + JSON.stringify(v), c.scrubVendorText('keep\nphone ' + v + ' 866-601-5520\nkeep2', WO), 'keep\nkeep2');
  });

  // ---- override rule: either order, and wrapped across two lines
  A.eq('CALL ... TO OVERRIDE dropped', c.scrubVendorText('ok\nPLEASE CALL DISPATCH TO OVERRIDE LIGHTING\nok2', WO), 'ok\nok2');
  A.eq('wrapped override instruction dropped', c.scrubVendorText('ok\nTO OVERRIDE EXTERIOR\nLIGHTING PLEASE CALL 866-601-5520\nok2', WO), 'ok\nok2');
  A.eq('override alone kept', c.scrubVendorText('manual override switch', WO), 'manual override switch');
  A.eq('call alone kept', c.scrubVendorText('call before arrival', WO), 'call before arrival');

  // ---- street removal does not eat newlines
  A.eq('multi-line street removal keeps the next line', c.scrubVendorText('Light out at 1234 Interstate Dr,\nDallas, TX 75201\nnext line', WO), 'Light out at\nDallas, TX\nnext line');

  // ---- attachment filenames
  A.eq('attachment name scrubbed, ext kept', c.attachSafeName('Flying J store 12 photos.PDF'), 'site store 12 photos.pdf');
  A.eq('attachment underscore variant', c.attachSafeName('Pilot_Flying_J_site.jpg'), 'site_site.jpg');
  A.eq('attachment clean name untouched', c.attachSafeName('pilot light.png'), 'pilot light.png');
  A.eq('attachment empty base -> attachment', c.attachSafeName('.pdf'), 'attachment.pdf');

  // ---- draft-path filtering + fail-closed signal
  var c5 = load(function () { return Promise.resolve({ status: 200, json: { suppressed: ['Bad@x.com'] } }); });
  var v5 = await c5.suppressVerify(['bad@x.com', 'good@x.com']);
  A.ok('verify ok when list consulted', v5.ok === true && v5.suppressed[0] === 'bad@x.com');
  A.eq('dropSuppressed filters bcc after verify', c5.dropSuppressed(['Bad@x.com', 'good@x.com']), ['good@x.com']);
  var v404 = await c.suppressVerify(['a@x.com']);
  A.ok('verify NOT ok on 404 (draft path fails closed)', v404.ok === false);
  var vNet = await c3.suppressVerify(['a@x.com']);
  A.ok('verify NOT ok on network error', vNet.ok === false);
  // ---- canonical matching (0.29.3): the server returns NORMALIZED addresses (trim + NFC + lowercase +
  // punycode domain - api/shared/bid-suppress.js normEmail). The client must match them against the
  // RAW recipient however it is spelled, or a suppressed address survives into the mailto draft.
  // Non-ASCII built via fromCharCode so no editor round-trip can rewrite the bytes.
  var e_ACUTE = String.fromCharCode(0xe9), u_UML = String.fromCharCode(0xfc), COMB_ACUTE = String.fromCharCode(0x301);
  var CANON = [
    ['ASCII baseline', 'Vendor@Example.COM', 'vendor@example.com'],
    ['NFC local part (raw NFD)', 'vendor-e' + COMB_ACUTE + '@example.com', 'vendor-' + e_ACUTE + '@example.com'],
    ['IDN Unicode domain', 'vendor@b' + u_UML + 'cher.de', 'vendor@xn--bcher-kva.de'],
    ['already punycoded domain', 'vendor@xn--bcher-kva.de', 'vendor@xn--bcher-kva.de'],
    ['whitespace', '  Vendor@Example.COM  ', 'vendor@example.com']
  ];
  CANON.forEach(function (t) { A.eq('canonEmail ' + t[0], c.canonEmail(t[1]), t[2]); });
  for (var ci = 0; ci < CANON.length; ci++) {
    var t = CANON[ci];
    var cx = load(function () { return Promise.resolve({ status: 200, json: { ok: true, suppressed: [t[2]], details: {} } }); });
    var vx = await cx.suppressVerify([t[1], 'keep@example.com']);
    A.ok('verify ok: ' + t[0], vx.ok === true);
    A.eq('draft drop removes ' + t[0], cx.dropSuppressed([t[1], 'keep@example.com']), ['keep@example.com']);
    A.eq('recipientList excludes ' + t[0], emails(cx.recipientList({ rowVendors: [{ email: t[1] }, { email: 'keep@example.com' }] }, vm.runInContext('suppressedSet', cx))), ['keep@example.com']);
  }
  // The server's canonical form must be what canonEmail produces - checked against the backend's own
  // algorithm (Node url.domainToASCII), not a copy of the client helper.
  var nodeUrl = require('url');
  function serverNorm(v) { var s = String(v).trim().normalize('NFC').toLowerCase(); var i = s.lastIndexOf('@'); return i > 0 ? s.slice(0, i + 1) + nodeUrl.domainToASCII(s.slice(i + 1)) : s; }
  CANON.forEach(function (t) { A.eq('server normEmail agrees: ' + t[0], serverNorm(t[1]), t[2]); });

  // ---- non-removal + safety
  var cs = load(function () { return Promise.resolve({ status: 200, json: { ok: true, suppressed: ['vendor@xn--bcher-kva.de'], details: {} } }); });
  await cs.suppressVerify(['vendor@b' + u_UML + 'cher.de']);
  var rawU = 'Other@B' + u_UML + 'cher.DE';
  A.eq('different valid address (same IDN domain) kept, raw spelling untouched', cs.dropSuppressed(['vendor@b' + u_UML + 'cher.de', rawU, 'Mixed.Case@Example.com']), [rawU, 'Mixed.Case@Example.com']);
  // Contract-robust: if a reply ever carries a NON-canonical spelling (older backend, a Send-path
  // r.suppressed echo), noteSuppressed must still key it canonically.
  var cn = load(function () { return Promise.resolve({ status: 200, json: { ok: true, suppressed: [' Vendor@B' + u_UML + 'CHER.de '], details: {} } }); });
  await cn.suppressVerify(['vendor@xn--bcher-kva.de']);
  A.eq('non-canonical server spelling still suppresses the punycoded raw', cn.dropSuppressed(['vendor@xn--bcher-kva.de', 'k@x.com']), ['k@x.com']);
  A.eq('Unicode-domain raw cannot survive a punycoded server entry', cs.dropSuppressed(['VENDOR@B' + u_UML.toUpperCase() + 'CHER.de']), []);
  [null, undefined, 42, {}, '', '   ', 'no-at-sign', '@example.com', 'a@', 'a@ex.com:80', 'a@ex.com/p', 'a@ex.com?q', 'a@ex.com#f', 'a@[1.2.3.4]', 'a@ex com', 'a@ex%41.com', 'a@ex.com:', 'a@ex.com' + String.fromCharCode(92) + 'x'].forEach(function (bad) {
    var r; try { r = cs.canonEmail(bad); } catch (e) { r = 'THREW ' + e.message; }
    A.eq('canonEmail rejects ' + JSON.stringify(bad) + ' with the empty sentinel', r, '');
  });
  var badIn = ['no-at-sign', 'a@ex.com:80', 'x@'];
  var outBad;
  try { outBad = cs.dropSuppressed(badIn); } catch (e) { outBad = 'THREW'; }
  A.eq('malformed addresses do not throw and are passed through unchanged (nothing added)', outBad, badIn);
  A.eq('recipientList adds nothing for malformed input beyond what was given',
    emails(cs.recipientList({ rowVendors: [{ email: 'a@ex.com:80' }, { email: 'a@ex.com:80' }] }, vm.runInContext('suppressedSet', cs))), ['a@ex.com:80']);
  var cAdd = load(function () { return Promise.resolve({ status: 200, json: { ok: true, added: 1, already: 0, invalid: 0 } }); });
  A.ok('suppressAdd (Unicode domain) ok', (await cAdd.suppressAdd('Z@B' + u_UML + 'cher.de')) === true);
  A.eq('a just-marked Unicode address is excluded however it is spelled', emails(cAdd.recipientList({ rowVendors: [{ email: 'z@xn--bcher-kva.de' }, { email: 'y@x.com' }] }, vm.runInContext('suppressedSet', cAdd))), ['y@x.com']);

  // ---- existing behavior
  var cEmpty = load(function () { return Promise.resolve({ status: 200, json: { ok: true, suppressed: [], details: {} } }); });
  var vEmpty = await cEmpty.suppressVerify(['a@x.com', 'b@x.com']);
  A.ok('valid empty list: verify ok, nothing suppressed', vEmpty.ok === true && vEmpty.suppressed.length === 0);
  A.eq('valid empty list changes nothing', cEmpty.dropSuppressed(['a@x.com', 'B@x.com']), ['a@x.com', 'B@x.com']);

  // ---- draft toast removed-count phrase
  A.eq('no removed phrase at 0', cs.draftRemovedNote(0), '');
  A.eq('singular at 1', cs.draftRemovedNote(1), '; 1 suppressed address removed');
  A.eq('plural at 3', cs.draftRemovedNote(3), '; 3 suppressed addresses removed');
  A.ok('draft toast carries the removed phrase in the SAME toast',
    /toast\('Draft opened for ' \+ mail\.bcc\.length \+ ' recipient' \+ \(mail\.bcc\.length === 1 \? '' : 's'\) \+ ' \(BCC\)' \+ draftRemovedNote\(removedN\) \+ '\. Review/.test(src));
  A.ok('removed count measured around the draft-time drop', /var preN = mail\.bcc\.length;\s*mail\.bcc = dropSuppressed\(mail\.bcc\);\s*removedN = preN - mail\.bcc\.length;/.test(src));
  A.ok('all-suppressed draft message unchanged and distinct',
    src.indexOf("if (!mail.bcc.length) { toast('All recipients are on the do-not-contact list - nothing sent.'); return; }\n          doDraft();") > -1);
  A.ok('removed phrase never names an address', !/draftRemovedNote\([^)]*bcc\[/.test(src) && cs.draftRemovedNote(2).indexOf('@') === -1);

  A.ok('draft handler fails closed + filters before opening',
    /suppressVerify\(mail\.bcc\)[\s\S]*if \(!v\.ok\) \{ toast\([^\n]*use Send instead[^\n]*return; \}[\s\S]*dropSuppressed\(mail\.bcc\)[\s\S]*doDraft\(\);/.test(src));
  A.ok('Next disabled during check, re-enabled on catch', /nextBtn\.disabled = true;[\s\S]*\.catch\(function \(\) \{ nextBtn\.disabled = false; \}\)/.test(src));
  A.ok('send re-enabled on check failure', /\.catch\(function \(\) \{ sendBtn\.disabled = false;/.test(src));
  A.ok('bid-sent outcomes skip server-suppressed', src.indexOf('delete sentSet[String(e2).toLowerCase()]') > -1);
  A.ok('trade chips preview scrubbed', src.indexOf('esc(scrubVendorText(t.name, wo))') > -1);

  A.finish();
})();
