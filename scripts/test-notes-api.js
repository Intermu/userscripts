// test-notes-api.js - node harness for the bwnNotesApi block: notes WITHOUT scraping.
//
// WHAT SHIPPED, and why. Both the AI drafts' collect and WO Assist's Deep Scan read the
// note history by SCROLLING the virtualized notes list end to end. Measured on the live
// board 2026-08-04, W-283834:
//   - workOrderNotes(workOrderNumber: 283834) returned ALL 308 notes in ONE call while
//     the DOM had 17 mounted;
//   - all 17 bodies were byte-identical to the rendered text (17/17 exact, `===`);
//   - `content` is PLAIN TEXT: a naive tag strip silently ate "<someone@example.com>"
//     out of an email note, which is how this harness's angle-bracket case got written;
//   - the note TYPE arrives as an int, and noteTypesV2 (82 rows) mapped all 17 mounted
//     notes to the same label the card shows;
//   - createdDate is an absolute ISO stamp, replacing the relative strings ("2 hours
//     ago") the scrape has to parse.
//
// Drives the REAL shipped bytes: slices the bwnNotesApi block out of bwn-suite-core and
// runs it against stubbed localStorage/fetch/DOM. Also gates the block SHA across
// bwn-suite-core and bwn-suite-ai, the same rule as the bwnAI transport block (PAT-002) -
// two copies that drift are two behaviours.
//
// NOT proven here: that a real draft or Deep Scan calls it (live gate), and nothing about
// Umbrava's schema staying put - the block rejects and the callers fall back to the sweep.
//
// Every mutation reverts one piece of the block and asserts this harness goes red.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-notes-api.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var AI_SRC = path.join(__dirname, '..', 'bwn-suite-ai.user.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

var BEGIN = '  // ===== BEGIN bwnNotesApi =====';
var END = '  // ===== END bwnNotesApi =====';

function blockOf(text, what) {
  var a = text.indexOf(BEGIN);
  if (a === -1) throw new Error(what + ': BEGIN marker not found');
  if (text.indexOf(BEGIN, a + 1) !== -1) throw new Error(what + ': BEGIN marker not unique');
  var b = text.indexOf(END, a);
  if (b === -1) throw new Error(what + ': END marker not found');
  return text.slice(a, b + END.length);
}

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var coreFull = readLF(CORE_SRC);
var aiFull = readLF(AI_SRC);
var BLOCK = blockOf(coreFull, 'core');

// ---- Fixtures ------------------------------------------------------------------------
// A live-shaped WorkOrderNote. The angle-bracket body is the real note that exposed the
// "content is not HTML" trap.
function note(over) {
  var n = {
    id: 13818494, type: 36, content: 'Next Actions Required\n\nGlenn to confirm pole ETA',
    createdDate: '2026-06-24T13:52:17.8385718+00:00',
    lastModifiedDate: '2026-06-24T13:52:17.8385718+00:00', isDeleted: false
  };
  Object.keys(over || {}).forEach(function (k) { n[k] = over[k]; });
  return n;
}
var EMAIL_BODY = 'pole shipping 8/14\n\nFrom: Wisconsin Lighting Lab Quotes <quotes@willbrands.com> \nSent: Tuesday, August 4';
var TYPES = [{ id: 36, name: 'Action' }, { id: 13, name: 'Internal' }, { id: 18, name: 'Vendor' }];

// A JWT the block will accept: Umbrava issuer, not expired.
function jwt(over) {
  var p = { iss: 'https://login.umbrava.com', exp: Math.floor(Date.now() / 1000) + 3600 };
  Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
  var b64 = Buffer.from(JSON.stringify(p), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return 'h.' + b64 + '.s';
}

// Build a context around the real block. opts:
//   token        - false for none, or a payload override object
//   notes        - rows workOrderNotes returns (or 'notList' / 'error')
//   types        - 'error' to make noteTypesV2 fail, else the rows
//   typeCache    - preseed the localStorage type cache
//   mounted      - note ids the DOM has on screen
//   mutations    - [[from, to], ...]
function build(opts) {
  var o = opts || {};
  var src = BLOCK;
  (o.mutations || []).forEach(function (m) { src = mutate(src, m[0], m[1]); });

  var store = {};
  if (o.token !== false) {
    store['@@auth0spajs@@::abc::https://app.umbrava.com/api::openid'] =
      JSON.stringify({ body: { access_token: jwt(o.token || {}) } });
  }
  if (o.typeCache) store['bwn:noteTypes'] = JSON.stringify(o.typeCache);

  var calls = [];
  var sandbox = {
    Promise: Promise, JSON: JSON, Math: Math, Date: Date, RegExp: RegExp, Error: Error,
    Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean, Buffer: Buffer,
    isNaN: isNaN, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
    console: { info: function () { }, warn: function () { } },
    atob: function (s) { return Buffer.from(String(s), 'base64').toString('binary'); },
    localStorage: {
      _s: store,
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
      setItem: function (k, v) { this._s[k] = String(v); },
      removeItem: function (k) { delete this._s[k]; }
    },
    document: {
      querySelectorAll: function () {
        return (o.mounted || []).map(function (id) {
          return { getAttribute: function () { return 'wo-note-' + id + '-summary'; } };
        });
      }
    },
    fetch: function (url, init) {
      var body = JSON.parse(init.body);
      calls.push({ url: url, op: body.operationName || null, query: body.query, variables: body.variables, auth: (init.headers || {})['Authorization'] });
      var isTypes = /noteTypesV2/.test(body.query);
      if (isTypes) {
        if (o.types === 'error') return Promise.resolve({ json: function () { return Promise.resolve({ errors: [{ message: 'noteTypesV2 blew up' }] }); } });
        return Promise.resolve({ json: function () { return Promise.resolve({ data: { noteTypesV2: o.types || TYPES } }); } });
      }
      if (o.notes === 'error') return Promise.resolve({ json: function () { return Promise.resolve({ errors: [{ message: 'Cannot query field "content"' }] }); } });
      if (o.notes === 'notList') return Promise.resolve({ json: function () { return Promise.resolve({ data: { workOrderNotes: { items: [] } } }); } });
      if (o.notes === 'nodata') return Promise.resolve({ json: function () { return Promise.resolve({}); } });
      return Promise.resolve({ json: function () { return Promise.resolve({ data: { workOrderNotes: o.notes || [note()] } }); } });
    }
  };
  // Object.keys(localStorage) must see the auth0 slot: contextify a real object.
  sandbox.localStorage = Object.assign(Object.create(null), store, {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); sandbox.localStorage[k] = String(v); },
    removeItem: function (k) { delete store[k]; delete sandbox.localStorage[k]; }
  });
  vm.runInNewContext(src, sandbox, { filename: 'notes-block.js' });
  sandbox.__calls = calls;
  return sandbox;
}

function fails(p, name, re) {
  return p.then(function (v) {
    A.ok(name, false, 'resolved with ' + JSON.stringify(v && v.length !== undefined ? v.length + ' rows' : v));
  }, function (err) {
    var msg = String((err && err.message) || err);
    A.ok(name, re ? re.test(msg) : true, msg);
  });
}

// ============================================================================
console.log('\n-- the two copies of the block are byte-identical --');
(function () {
  var aiBlock = blockOf(aiFull, 'ai');
  var sha = function (s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); };
  A.eq('same length', aiBlock.length, BLOCK.length);
  A.ok('same SHA (drift here = two behaviours)', sha(aiBlock) === sha(BLOCK), sha(BLOCK).slice(0, 16) + ' vs ' + sha(aiBlock).slice(0, 16));
  console.log('  ... block SHA: ' + sha(BLOCK).slice(0, 16));
  A.ok('the query asks the schema field that was measured live',
    /workOrderNotes\(workOrderNumber: \$n\)/.test(BLOCK), 'query drift');
  A.ok('and selects content, not contentHtml', /\bcontent\b/.test(BLOCK) && !/contentHtml/.test(BLOCK.replace(/\/\/[^\n]*/g, '')), 'selection drift');
})();

console.log('\n-- ISO stamp rendered the way the notes list renders it --');
(function () {
  var s = build({});
  var out = s.bwnNotesTsText('2026-06-24T13:52:17.8385718+00:00');
  A.ok('shaped like a note timestamp (M/D/YYYY, h:mm AM)', /^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2} (AM|PM)$/.test(out), out);
  // TZ-independent invariant: the rendered text must parse back to the same minute.
  var back = new Date(out);
  var want = new Date('2026-06-24T13:52:17.8385718+00:00');
  A.eq('parses back to the same instant (to the minute)',
    Math.round(back.getTime() / 60000), Math.round((want.getTime() - want.getSeconds() * 1000 - want.getMilliseconds()) / 60000));
  A.eq('empty in, empty out', s.bwnNotesTsText(''), '');
  A.eq('garbage in, empty out', s.bwnNotesTsText('not a date'), '');
})();

function main() {
  console.log('\n-- happy path: one call, mapped to the scrape\'s shape --');
  var s = build({ notes: [note(), note({ id: 2, type: 13, content: EMAIL_BODY }), note({ id: 3, type: 18, isDeleted: true })] });
  return s.bwnNotesApi('283834').then(function (list) {
    A.eq('deleted notes are dropped, like the list does', list.length, 2);
    A.eq('ids are strings, as the bus cache stores them', typeof list[0].id, 'string');
    A.eq('id', list[0].id, '13818494');
    A.eq('label comes from the type map', list[0].label, 'Action');
    A.eq('second label', list[1].label, 'Internal');
    A.eq('body is verbatim - angle brackets are NOT tags', list[1].body, EMAIL_BODY);
    A.ok('tsAbs is the exact epoch', list[0].tsAbs === +new Date('2026-06-24T13:52:17.8385718+00:00'), String(list[0].tsAbs));
    A.ok('ts is the display string', /^\d{1,2}\/\d{1,2}\/\d{4}, /.test(list[0].ts), list[0].ts);
    A.eq('exactly the keys the scrape produces', Object.keys(list[0]).sort(), ['body', 'id', 'label', 'ts', 'tsAbs']);

    var calls = s.__calls;
    A.eq('two calls: types then notes', calls.length, 2);
    A.ok('the notes call is authorized with the app bearer', /^Bearer h\./.test(calls[1].auth), String(calls[1].auth));
    A.eq('the WO number is sent as an int', calls[1].variables.n, 283834);
    A.ok('same-origin graphql endpoint', calls[1].url === '/api/graphql', calls[1].url);
  }).then(function () {
    console.log('\n-- the WO number is taken from anything WO-shaped --');
    var s2 = build({});
    return s2.bwnNotesApi('W-283834').then(function () {
      A.eq('digits pulled out of a W- prefixed id', s2.__calls[1].variables.n, 283834);
    });
  }).then(function () {
    console.log('\n-- the type map is cached, and never fatal --');
    var s3 = build({ typeCache: { v: 1, ts: Date.now(), map: { '36': 'Action' } } });
    return s3.bwnNotesApi(283834).then(function (list) {
      A.eq('a fresh cache means ONE call - no types round trip', s3.__calls.length, 1);
      A.eq('label still resolved from the cache', list[0].label, 'Action');
    });
  }).then(function () {
    var s4 = build({ typeCache: { v: 1, ts: Date.now() - 48 * 3600000, map: { '36': 'Stale' } } });
    return s4.bwnNotesApi(283834).then(function (list) {
      A.eq('a day-old cache is refetched', s4.__calls.length, 2);
      A.eq('and the fresh name wins', list[0].label, 'Action');
    });
  }).then(function () {
    var s5 = build({ types: 'error' });
    return s5.bwnNotesApi(283834).then(function (list) {
      A.eq('a failed type read still returns the notes', list.length, 1);
      A.eq('with an empty label (widens a keep-list; never invents)', list[0].label, '');
      A.ok('the body survives', list[0].body.length > 0);
    });
  }).then(function () {
    var s6 = build({ notes: [note({ type: 999 })] });
    return s6.bwnNotesApi(283834).then(function (list) {
      A.eq('an unknown type id degrades to no label', list[0].label, '');
    });
  }).then(function () {
    console.log('\n-- every failure REJECTS so the caller falls back to the sweep --');
    return fails(build({ token: false }).bwnNotesApi(283834), 'no token rejects', /token/i);
  }).then(function () {
    return fails(build({ token: { iss: 'https://evil.example.com' } }).bwnNotesApi(283834),
      'a token from another issuer is not used', /token/i);
  }).then(function () {
    return fails(build({ token: { exp: Math.floor(Date.now() / 1000) - 60 } }).bwnNotesApi(283834),
      'an expired token is not used', /token/i);
  }).then(function () {
    return fails(build({ notes: 'error' }).bwnNotesApi(283834), 'GraphQL errors[] rejects', /Cannot query field/);
  }).then(function () {
    return fails(build({ notes: 'notList' }).bwnNotesApi(283834), 'a non-list payload rejects', /did not return a list/);
  }).then(function () {
    return fails(build({ notes: 'nodata' }).bwnNotesApi(283834), 'an empty response rejects', /empty GraphQL response/);
  }).then(function () {
    return fails(build({}).bwnNotesApi(''), 'no WO number rejects', /WO number/);
  }).then(function () {
    return fails(build({}).bwnNotesApi('notes'), 'a non-numeric WO id rejects', /WO number/);
  }).then(function () {
    console.log('\n-- coverage gate: what is on screen must be in the answer --');
    return fails(build({ notes: [note()], mounted: ['13818494', '99999999'] }).bwnNotesApi(283834),
      'a mounted note missing from the read rejects', /every note on screen/);
  }).then(function () {
    var s = build({ notes: [note(), note({ id: 2, type: 13 })], mounted: ['13818494', '2'] });
    return s.bwnNotesApi(283834).then(function (list) {
      A.eq('when the read covers the screen it is accepted', list.length, 2);
    });
  }).then(function () {
    var s = build({ notes: [], mounted: [] });
    return s.bwnNotesApi(283834).then(function (list) {
      A.eq('a WO with genuinely no notes resolves empty', list.length, 0);
    });
  }).then(function () {
    // A deleted note that is still mounted must not fail the gate... it is not in `out`,
    // so it WOULD. Deleted notes are not rendered by the list, so this asserts the real
    // combination instead: deleted in the payload, absent from the DOM.
    var s = build({ notes: [note(), note({ id: 77, isDeleted: true })], mounted: ['13818494'] });
    return s.bwnNotesApi(283834).then(function (list) {
      A.eq('deleted-and-not-rendered is fine', list.length, 1);
    });
  }).then(function () {
    // ========================================================================
    console.log('\n-- mutation controls (each must FAIL an assertion above) --');
    var m1 = [['        if (!r || r.isDeleted) return;               // the list does not show deleted notes', '        if (!r) return;']];
    var s = build({ notes: [note(), note({ id: 3, type: 18, isDeleted: true })], mutations: m1 });
    return s.bwnNotesApi(283834).then(function (list) {
      A.ok('M1 control: without the isDeleted filter a deleted note comes back', list.length === 2, 'got ' + list.length);
    });
  }).then(function () {
    var m2 = [['      if (!bwnNotesApiCovers(out)) throw new Error(\'API notes did not include every note on screen - not trusting it\');', '']];
    var s = build({ notes: [note()], mounted: ['13818494', '99999999'], mutations: m2 });
    return s.bwnNotesApi(283834).then(function (list) {
      A.ok('M2 control: without the coverage gate a read that misses on-screen notes is accepted',
        list.length === 1, 'got ' + list.length);
    });
  }).then(function () {
    // M3: the naive tag strip that ate an email address in the live probe.
    var m3 = [['          body: String(r.content == null ? \'\' : r.content).trim()',
      '          body: String(r.content == null ? \'\' : r.content).replace(/<[^>]*>/g, \'\').trim()']];
    var s = build({ notes: [note({ content: EMAIL_BODY })], mutations: m3 });
    return s.bwnNotesApi(283834).then(function (list) {
      A.ok('M3 control: stripping "tags" deletes <quotes@willbrands.com> from the note',
        list[0].body.indexOf('quotes@willbrands.com') === -1 && list[0].body.length < EMAIL_BODY.length,
        JSON.stringify(list[0].body.slice(0, 80)));
    });
  }).then(function () {
    // M4: accept any token in the slot (the audience slot transiently holds others).
    var m4 = [['        if (iss !== \'https://login.umbrava.com\' && iss !== \'https://umbrava.us.auth0.com\') continue;', '']];
    var s = build({ token: { iss: 'https://evil.example.com' }, mutations: m4 });
    return s.bwnNotesApi(283834).then(function (list) {
      A.ok('M4 control: without the issuer check a foreign token is used', list.length === 1, 'got ' + list.length);
    });
  }).then(function () {
    A.finish();
  }, function (err) {
    console.log('HARNESS ERROR: ' + ((err && err.stack) || err));
    process.exit(1);
  });
}

main();
