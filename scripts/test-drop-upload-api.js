// test-drop-upload-api.js - node harness for bwn-drop-upload's API write path
// (note + document upload), added in 1.11.0 on 2026-08-12.
//
// THE CHANGE, as found in source:
//   drop-upload used to drive Umbrava's own Add-Note composer and upload dialog by
//   clicking react-aria/MUI comboboxes - brittle, and it could not fill the locked
//   Description field at all. 1.11.0 writes via the REAL mutations the SPA fires,
//   captured live 2026-08-12 on a scratch WO (see [[umbrava-graphql-operations]]
//   "Mutations (the WRITE surface)"):
//     - note:   addEditJobNote(data: WorkOrderNoteInput!)          (human-gated: Post button)
//     - upload: initializeJobDocument -> Azure blob PUT -> bulkAddWorkOrderDocuments
//
// WHAT THIS PROVES, against the REAL shipped bytes (the API block is sliced out of
// bwn-drop-upload.user.js and run in a vm with a fake fetch + localStorage - nothing
// below is a restatement of a stub):
//   - the three mutations keep their captured operation names, arg names and shapes;
//   - a note goes out as addEditJobNote with the party-typed numeric `type` id
//     (Client=55/Vendor=18/Internal=13), workOrderNumber as a NUMBER, content +
//     paragraph contentHtml, and the isCompletion/isInvoice/isPinned/targetPO flags;
//   - an upload does init -> PUT(x-ms-blob-type:BlockBlob) -> ONE bulkAdd carrying each
//     file's documentInfoId, description and the numeric doc-label id (Work Order
//     Request=17), keyed by workOrderNumber;
//   - the doc-label and note-type NAME->id resolvers (DOC_LABELS map, bwn:noteTypes
//     cache with the 3-id fallback) return the ids the mutations send, and null on an
//     unknown name rather than a wrong id;
//   - every write REJECTS (so the caller can fall back to the DOM path) on: no Auth0
//     token, a GraphQL errors[], success:false, or a non-2xx blob PUT.
//
// WHAT IT DOES NOT PROVE:
//   - that these mutations exist on the live schema / that the storage CORS allows the
//     blob PUT for this origin. Only a real WO answers that - the live gate is one drop
//     on a scratch WO (upload lands, note posts on the Post click). See the vault note.
//   - anything about the review-box DOM or runApiUpload's dialog fallback wiring (those
//     live outside the sliced block; covered by the live gate).
//
// Every case is re-run against mutated copies of the same source; each mutation MUST
// turn this harness red. mutate() throws if its target is absent or not unique, so a
// control that silently no-ops cannot pass.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-drop-upload-api.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-drop-upload.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = full.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found - the API write block is gone from bwn-drop-upload.user.js');
  if (full.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = full.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return full.slice(a, b);
}

// The whole API layer, from its banner to the bwnAI section that follows it.
var S_API = slice('  // ===== API write path (note + document upload)', '  // ===== bwnAI v1', 'API write block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- Environment ------------------------------------------------------------
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function mkJwt(payload) { return 'h.' + b64url(payload) + '.s'; }
var GOOD_TOKEN = mkJwt({ iss: 'https://login.umbrava.com', exp: Math.floor(Date.now() / 1000) + 3600 });

function makeLS(entries) {
  var store = {};
  Object.keys(entries).forEach(function (k) { store[k] = entries[k]; });
  var ls = {};
  Object.keys(store).forEach(function (k) { ls[k] = store[k]; });
  Object.defineProperty(ls, 'getItem', { value: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, enumerable: false });
  return ls;
}

// Fake fetch: routes /api/graphql by operationName to a programmable reply, and the
// blob host to a 201. Records every call so a case can inspect what was actually sent.
function makeEnv(opts) {
  opts = opts || {};
  var replies = opts.replies || {};
  var withToken = opts.withToken !== false;
  var noteCache = opts.noteCache; // object or undefined
  var env = { calls: [] };
  var lsEntries = {};
  if (withToken) lsEntries['@@auth0spajs@@::spa-client::https://app.umbrava.com/api::openid profile'] = JSON.stringify({ body: { access_token: GOOD_TOKEN } });
  if (noteCache) lsEntries['bwn:noteTypes'] = JSON.stringify(noteCache);
  env.ls = makeLS(lsEntries);

  env.fetch = function (url, o) {
    o = o || {};
    var rec = { url: url, method: o.method, headers: o.headers, body: o.body };
    if (/\/api\/graphql/.test(url)) {
      var parsed = JSON.parse(o.body);
      rec.op = parsed.operationName; rec.vars = parsed.variables; rec.query = parsed.query;
      env.calls.push(rec);
      var r = replies[parsed.operationName];
      var reply = (typeof r === 'function') ? r(rec) : r;
      if (reply && reply.__throw) return Promise.reject(new Error('gql-network'));
      // Real /api/graphql wraps the payload as { data: {...} } (or { errors: [...] });
      // duGql reads j.data, so mirror that envelope rather than returning bare data.
      var body = (reply && reply.errors) ? reply : { data: reply };
      return Promise.resolve({ json: function () { return Promise.resolve(body); } });
    }
    rec.op = 'BLOB_PUT';
    env.calls.push(rec);
    var b = replies.blob;
    b = (typeof b === 'function') ? b(rec) : b;
    if (b && b.__throw) return Promise.reject(new Error('blob-network'));
    return Promise.resolve({ ok: b ? b.ok !== false : true, status: (b && b.status) || 201 });
  };
  return env;
}

function loadApi(src, env) {
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, JSON: JSON,
    Promise: Promise, Error: Error, RegExp: RegExp, Date: Date, parseInt: parseInt,
    console: { info: function () {}, warn: function () {}, log: function () {} },
    atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
    fetch: env.fetch,
    localStorage: env.ls
  };
  vm.createContext(sandbox);
  return vm.runInContext(
    '(function () {\n' + src + '\n' +
    'return { postNoteViaApi: postNoteViaApi, uploadViaApi: uploadViaApi, docLabelId: docLabelId,' +
    ' noteTypeId: noteTypeId, textToHtml: textToHtml, duAuthToken: duAuthToken,' +
    ' MUT_ADD_NOTE: MUT_ADD_NOTE, MUT_INIT_DOC: MUT_INIT_DOC, MUT_BULK_ADD: MUT_BULK_ADD, DOC_LABELS: DOC_LABELS };\n})()',
    sandbox, { filename: 'drop-upload-api.js' });
}

function initReply() {
  var n = 0;
  return function () {
    n++;
    return { initializeJobDocument: { success: true, message: '', sasToken: { documentInfoId: 'sas' + n, uriWithSas: 'https://umbravadocuments.blob.core.windows.net/documents/ctr/' + n + '-file', displayFileName: 'f' + n } } };
  };
}

// ---- The cases --------------------------------------------------------------
// Collect results (not asserting) so the same body can be re-run against a mutant.
function runCases(src) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
  function rejects(name, p) { return p.then(function () { ok(name, false, 'resolved but should have rejected'); }, function () { ok(name, true); }); }

  var WO = 386473;
  var noteCache = { v: 1, map: { '13': 'Internal', '18': 'Vendor', '55': 'Client' } };

  // ---- static contract: the captured mutation strings survived edits
  var probe = loadApi(src, makeEnv({}));
  ok('AddEditWONote keeps its captured shape', /addEditJobNote\(data:\s*\$addEditInput\)/.test(probe.MUT_ADD_NOTE) && /\$addEditInput:\s*WorkOrderNoteInput!/.test(probe.MUT_ADD_NOTE), probe.MUT_ADD_NOTE);
  ok('InitializeJobDocument keeps its captured shape', /initializeJobDocument\(workOrderNumber:\s*\$workOrderNumber,\s*data:\s*\$data\)/.test(probe.MUT_INIT_DOC) && /\$data:\s*NewFileInput!/.test(probe.MUT_INIT_DOC) && /sasToken\s*\{[^}]*uriWithSas/.test(probe.MUT_INIT_DOC), probe.MUT_INIT_DOC);
  ok('BulkAddWorkOrderDocuments keeps its captured shape', /bulkAddWorkOrderDocuments\(data:\s*\$data\)/.test(probe.MUT_BULK_ADD) && /documentIds/.test(probe.MUT_BULK_ADD), probe.MUT_BULK_ADD);

  // ---- name -> id resolvers
  eq('doc label Work Order Request resolves to 17', probe.docLabelId('Work Order Request'), 17);
  eq('doc label Internal is the DOC enum (23), not the note enum', probe.docLabelId('Internal'), 23);
  eq('an unknown doc label is null, never a wrong id', probe.docLabelId('Nope'), null);
  var probeCache = loadApi(src, makeEnv({ noteCache: noteCache }));
  eq('note type Client resolves to 55 from the cache', probeCache.noteTypeId('Client'), 55);
  eq('note type Vendor resolves to 18', probeCache.noteTypeId('Vendor'), 18);
  eq('note type Internal resolves to 13', probeCache.noteTypeId('Internal'), 13);
  var probeNoCache = loadApi(src, makeEnv({}));
  eq('with no cache, Client falls back to 55', probeNoCache.noteTypeId('Client'), 55);
  eq('an unknown note type is null', probeNoCache.noteTypeId('Bogus'), null);

  // ---- textToHtml
  eq('blank line starts a new <p>, single newline is a <br>', probe.textToHtml('a\n\nb\nc'), '<p>a</p><p>b<br>c</p>');
  eq('html is escaped', probe.textToHtml('x < y & z'), '<p>x &lt; y &amp; z</p>');

  // ---- note post: one AddEditWONote with the captured variable shape
  var e1 = makeEnv({ noteCache: noteCache, replies: { AddEditWONote: { addEditJobNote: { success: true, message: '', note: { id: 'n1', type: 55 } } } } });
  var api1 = loadApi(src, e1);
  var chain = api1.postNoteViaApi('Line one\n\nLine two', 'Client', WO).then(function (note) {
    var c = e1.calls.filter(function (x) { return x.op === 'AddEditWONote'; });
    eq('exactly one AddEditWONote fired', c.length, 1);
    var inp = c[0] && c[0].vars && c[0].vars.addEditInput;
    eq('workOrderNumber goes out as a NUMBER', inp && inp.workOrderNumber, WO);
    eq('the note type is the numeric Client id (55), not the name', inp && inp.type, 55);
    eq('content is the plain text', inp && inp.content, 'Line one\n\nLine two');
    ok('contentHtml is paragraph-wrapped', /^<p>Line one<\/p><p>Line two<\/p>$/.test(inp && inp.contentHtml), inp && inp.contentHtml);
    eq('the not-a-completion / not-invoice / not-pinned flags are sent false', [inp.isCompletion, inp.isInvoice, inp.isPinned], [false, false, false]);
    eq('targetPurchaseOrderNumbers is an empty array', inp && inp.targetPurchaseOrderNumbers, []);
    ok('the Authorization header carries a bearer', /^Bearer /.test(c[0].headers.Authorization), c[0].headers.Authorization);
    eq('resolves to the created note', note && note.id, 'n1');
  });

  // ---- note post failure modes all REJECT (so the caller can fall back)
  chain = chain.then(function () {
    var eNoTok = loadApi(src, makeEnv({ withToken: false, noteCache: noteCache }));
    return rejects('a missing Auth0 token rejects', eNoTok.postNoteViaApi('x', 'Client', WO));
  }).then(function () {
    var eErr = loadApi(src, makeEnv({ noteCache: noteCache, replies: { AddEditWONote: { errors: [{ message: 'boom' }] } } }));
    return rejects('a GraphQL errors[] rejects', eErr.postNoteViaApi('x', 'Client', WO));
  }).then(function () {
    var eFalse = loadApi(src, makeEnv({ noteCache: noteCache, replies: { AddEditWONote: { addEditJobNote: { success: false, message: 'nope' } } } }));
    return rejects('success:false rejects', eFalse.postNoteViaApi('x', 'Client', WO));
  });

  // ---- upload: init x2 -> PUT x2 -> ONE bulkAdd
  chain = chain.then(function () {
    var e2 = makeEnv({ replies: { InitializeJobDocument: initReply(), BulkAddWorkOrderDocuments: { bulkAddWorkOrderDocuments: { success: true, message: '', documentIds: ['id1', 'id2'] } } } });
    var api2 = loadApi(src, e2);
    var files = [{ name: 'a.msg', size: 100 }, { name: 'b.pdf', size: 200 }];
    var described = [{ desc: 'first' }, { desc: 'second' }];
    return api2.uploadViaApi(files, described, 'Work Order Request', WO).then(function (ids) {
      var inits = e2.calls.filter(function (x) { return x.op === 'InitializeJobDocument'; });
      var puts = e2.calls.filter(function (x) { return x.op === 'BLOB_PUT'; });
      var bulk = e2.calls.filter(function (x) { return x.op === 'BulkAddWorkOrderDocuments'; });
      eq('two files initialize two documents', inits.length, 2);
      eq('init sends fileName + fileSize', inits[0].vars && inits[0].vars.data, { fileName: 'a.msg', fileSize: 100 });
      eq('init is keyed by workOrderNumber', inits[0].vars && inits[0].vars.workOrderNumber, WO);
      eq('each file is PUT to the blob store', puts.length, 2);
      eq('the blob PUT uses method PUT', puts[0].method, 'PUT');
      eq('the blob PUT sets x-ms-blob-type BlockBlob', puts[0].headers && puts[0].headers['x-ms-blob-type'], 'BlockBlob');
      ok('the blob PUT targets the SAS uri from init', /umbravadocuments\.blob\.core\.windows\.net/.test(puts[0].url), puts[0].url);
      ok('the PUT body is the real File, not a copy', puts[0].body === files[0] || puts[0].body === files[1]);
      eq('exactly one bulkAdd registers all files', bulk.length, 1);
      var docs = bulk[0].vars && bulk[0].vars.data && bulk[0].vars.data.documents;
      eq('bulkAdd carries one entry per file', docs && docs.length, 2);
      eq('each entry carries its documentInfoId from init', docs && [docs[0].documentInfoId, docs[1].documentInfoId], ['sas1', 'sas2']);
      eq('each entry carries the numeric label id (Work Order Request = 17)', docs && [docs[0].label, docs[1].label], [17, 17]);
      eq('each entry carries the file description', docs && [docs[0].description, docs[1].description], ['first', 'second']);
      eq('bulkAdd is keyed by workOrderNumber', bulk[0].vars.data.workOrderNumber, WO);
      eq('uploadViaApi resolves to the new documentIds', ids, ['id1', 'id2']);
    });
  });

  // ---- upload failure modes all REJECT (so runApiUpload can fall back to the dialog)
  chain = chain.then(function () {
    var eBad = loadApi(src, makeEnv({ replies: { InitializeJobDocument: initReply(), BulkAddWorkOrderDocuments: { bulkAddWorkOrderDocuments: { success: true, documentIds: [] } }, blob: { ok: false, status: 403 } } }));
    return rejects('a non-2xx blob PUT rejects', eBad.uploadViaApi([{ name: 'a', size: 1 }], [{ desc: 'd' }], 'Work Order Request', WO));
  }).then(function () {
    var eInit = loadApi(src, makeEnv({ replies: { InitializeJobDocument: { initializeJobDocument: { success: false, message: 'no' } } } }));
    return rejects('initialize success:false rejects', eInit.uploadViaApi([{ name: 'a', size: 1 }], [{ desc: 'd' }], 'Work Order Request', WO));
  }).then(function () {
    var eB = loadApi(src, makeEnv({ replies: { InitializeJobDocument: initReply(), BulkAddWorkOrderDocuments: { bulkAddWorkOrderDocuments: { success: false, message: 'no' } } } }));
    return rejects('bulkAdd success:false rejects', eB.uploadViaApi([{ name: 'a', size: 1 }], [{ desc: 'd' }], 'Work Order Request', WO));
  }).then(function () {
    var eW = loadApi(src, makeEnv({ replies: { InitializeJobDocument: initReply() } }));
    return rejects('a missing WO number rejects', eW.uploadViaApi([{ name: 'a', size: 1 }], [{ desc: 'd' }], 'Work Order Request', 0));
  });

  return chain.then(function () { return out; }, function (err) {
    out.push({ name: 'cases ran without throwing', ok: false, detail: String(err && err.message || err) });
    return out;
  });
}

// ---- Negative controls ------------------------------------------------------
// Each reverts one piece of the real behaviour; every one MUST turn a case red.
var MUTATIONS = [
  { what: 'the note type sent as 0 instead of the resolved id',
    m: function (s) { return mutate(s, 'type: typeId,', 'type: 0,'); } },
  { what: 'the note content replaced',
    m: function (s) { return mutate(s, 'content: String(text),', "content: 'X',"); } },
  { what: 'contentHtml sent flat (no paragraph split)',
    m: function (s) { return mutate(s, "split(/\\n{2,}/)\n      .map", "split(/\\nNEVER/)\n      .map"); } },
  { what: 'the note success gate inverted',
    m: function (s) { return mutate(s, "res.success !== true) throw new Error((res && res.message) || 'addEditJobNote", "res.success === true) throw new Error((res && res.message) || 'addEditJobNote"); } },
  { what: 'the doc label hardcoded wrong',
    m: function (s) { return mutate(s, 'entry.label = labelId;', 'entry.label = 99;'); } },
  { what: 'the documentInfoId dropped from the bulkAdd entry',
    m: function (s) { return mutate(s, 'documentInfoId: sas.documentInfoId,', "documentInfoId: 'X',"); } },
  { what: 'the blob-type header corrupted',
    m: function (s) { return mutate(s, "'x-ms-blob-type': 'BlockBlob'", "'x-ms-blob-type': 'Wrong'"); } },
  { what: 'a non-2xx blob PUT accepted as success',
    m: function (s) { return mutate(s, "if (!r.ok) throw new Error('blob PUT ' + r.status);", 'if (false) throw new Error(0);'); } },
  { what: 'the note mutation renamed',
    m: function (s) { return mutate(s, 'addEditJobNote(data: $addEditInput)', 'wrongNote(data: $addEditInput)'); } },
  { what: 'the doc-label map broken for Work Order Request',
    m: function (s) { return mutate(s, "'Work Order Request': 17,", "'Work Order Request': 999,"); } }
];

function main() {
  console.log('\n-- the shipped drop-upload API write path --');
  runCases(S_API).then(function (results) {
    results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

    console.log('\n-- negative controls: each must turn the cases above red --');
    return MUTATIONS.reduce(function (chain, mu) {
      return chain.then(function () {
        return runCases(mu.m(S_API)).then(function (rs) {
          var reds = rs.filter(function (r) { return !r.ok; });
          A.ok('CAUGHT: ' + mu.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
        });
      });
    }, Promise.resolve());
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
