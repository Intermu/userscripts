// test-drop-upload-queue.js - node harness for bwn-drop-upload's queue merge dedup
// (1.26.0, 2026-09-09). Overhaul: the review box now lists every queued file with a ×
// to remove it before Upload, and a second drop of a file already queued (same name +
// size) is skipped so dragging the same thing twice does not upload it twice.
//
// The list + × are DOM (covered by the live gate). The dedup is a pure function
// (dedupNewPairs) sliced out of the real source and run here - nothing below is a stub:
//   - a new file whose name+size is already queued is dropped, and counted;
//   - duplicates WITHIN one drop are also collapsed (the seen set grows as it goes);
//   - the kept raw[] and files[] stay index-aligned (the note pairs raw[i] with files[i]);
//   - dupes counts exactly what was dropped.
//
// The negative control re-runs against a mutated copy with the dedup guard defeated and
// REQUIRES it to stop deduping - a guard that silently no-ops cannot pass.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-drop-upload-queue.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-drop-upload.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var START = '  function fileSig(f)';
var END = '  // ===== end queue merge dedup =====';
function slice(src, what) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error(what + ': START marker (fileSig) not found');
  if (src.indexOf(START, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return src.slice(a, b);
}

function load(src) {
  var code = slice(src, 'queue block') + '\n;({ fileSig: fileSig, dedupNewPairs: dedupNewPairs, woDocSigs: woDocSigs });';
  return vm.runInNewContext(code, {});
}

function F(name, size) { return { name: name, size: size }; }        // fake File
function D(tag) { return { tag: tag }; }                              // fake described

var Q = load(full);

// A file already queued is dropped on merge, and counted.
(function () {
  var r = Q.dedupNewPairs([F('a.pdf', 1)], [F('a.pdf', 1), F('b.pdf', 2)], [D('A'), D('B')]);
  A.eq('one dupe dropped', r.dupes, 1);
  A.eq('kept raw is the new file only', r.raw, [F('b.pdf', 2)]);
  A.eq('kept files stay aligned', r.files, [D('B')]);
})();

// Nothing in common -> nothing dropped.
(function () {
  var r = Q.dedupNewPairs([F('a.pdf', 1)], [F('c.pdf', 3), F('d.pdf', 4)], [D('C'), D('D')]);
  A.eq('no dupes', r.dupes, 0);
  A.eq('both kept', r.files, [D('C'), D('D')]);
})();

// Same name, DIFFERENT size -> not a duplicate (two real files that happen to share a name).
(function () {
  var r = Q.dedupNewPairs([F('a.pdf', 1)], [F('a.pdf', 9)], [D('A2')]);
  A.eq('name match but size differs is kept', r.dupes, 0);
  A.eq('kept', r.files, [D('A2')]);
})();

// Every new file already queued -> all dropped.
(function () {
  var r = Q.dedupNewPairs([F('a', 1), F('b', 2)], [F('a', 1), F('b', 2)], [D('A'), D('B')]);
  A.eq('all dupes', r.dupes, 2);
  A.eq('nothing kept', r.files, []);
})();

// Duplicates WITHIN one drop collapse too (seen grows as the loop runs).
(function () {
  var r = Q.dedupNewPairs([], [F('a', 1), F('a', 1), F('b', 2)], [D('A1'), D('A2'), D('B')]);
  A.eq('intra-drop dupe counted', r.dupes, 1);
  A.eq('first wins, second dropped', r.files, [D('A1'), D('B')]);
})();

// Negative control: defeat the dedup guard in the source and REQUIRE the behaviour to change.
(function () {
  var GUARD = 'if (seen[sig]) { dupes++; return; }';
  if (full.indexOf(GUARD) === -1) throw new Error('negative control: dedup guard line not found - update this harness');
  var mutated = full.replace(GUARD, 'if (false) { dupes++; return; }');
  var r = load(mutated).dedupNewPairs([F('a', 1)], [F('a', 1)], [D('A')]);
  A.ok('guard defeated -> duplicate is NO LONGER dropped', r.files.length === 1 && r.dupes === 0,
    'got dupes=' + r.dupes + ' kept=' + r.files.length);
})();

// 1.33.0: files ALREADY ON THE WO (jobDocuments rows, shapes verified live on W-370534) feed
// dedupNewPairs as prevRaw, so a retry / second drop of the same email is not filed twice.
(function () {
  var rows = [
    { displayFileName: "RE_ Store 81.msg", fileSize: "146432", description: "Sam: on it", isArchived: false },
    { displayFileName: "RE_ Store 81.msg", fileSize: "223232", description: "Sam: done" },
    { displayFileName: "old.pdf", fileSize: "10", isArchived: true },
    null
  ];
  var sigs = Q.woDocSigs(rows);
  A.eq("archived + null rows dropped", sigs.length, 2);
  var r = Q.dedupNewPairs(sigs, [F("RE_ Store 81.msg", 146432), F("RE_ Store 81.msg", 3352064), F("old.pdf", 10)], [E("Sam: on it"), E("Sam: new"), D("archivedName")]);
  A.eq("string fileSize matches numeric File.size", r.dupes, 1);
  A.eq("same-name reply with new size kept; archived doc does not block", r.files, [E("Sam: new"), D("archivedName")]);
  A.eq("off-schema payload = no sigs (fail-open)", Q.woDocSigs(undefined), []);
})();

// 1.33.1: .msg is padded to 512-byte sectors, so a NEW reply in the thread can match an earlier one on
// name AND size (W-381605 holds two different 113152-byte "RE_ Purchase Order..." emails). For .msg the
// body-built Description must match too; a .msg that did not parse is never a dupe. The re-drop case
// below is real: on 2026-10-01 the same 39936-byte reply was re-dragged from Outlook (fresh bytes each
// drag, same parsed email) and must stay skipped.
function E(desc) { return { email: {}, desc: desc }; }                 // fake described, parsed email
(function () {
  var N = "RE QUOTE APPROVEDTracking # 1266826  Pilot Travel Centers  Skippers VA  STANDARD 48 HRS.msg";
  var sigs = Q.woDocSigs([{ displayFileName: N, fileSize: "39936", description: "Lisa Porzelt: Following up on the below. Please advise." }]);
  var r = Q.dedupNewPairs(sigs, [F(N, 39936)], [E("Stuart: Shipping tomorrow.")]);
  A.eq("new reply, same name+size, different body = kept", r.files.length, 1);
  r = Q.dedupNewPairs(sigs, [F(N, 39936)], [E("Lisa Porzelt:  Following up on the below.\nPlease advise.")]);
  A.eq("same email re-dropped = skipped (whitespace-normalised)", r.dupes, 1);
  r = Q.dedupNewPairs(sigs, [F(N, 39936)], [{ desc: "Lisa Porzelt: Following up on the below. Please advise." }]);
  A.eq("unparsed .msg is never a dupe (fail-open)", r.files.length, 1);
  r = Q.dedupNewPairs([F("a.msg", 512)], [F("a.msg", 512), F("a.msg", 512)], [E("x"), E("y")], [E("x")]);
  A.eq("queue merge uses prevFiles desc", r.files, [E("y")]);
  A.eq("non-.msg still name+size only", Q.dedupNewPairs(sigs, [F("p.pdf", 1)], [D("p")], undefined).dupes +
    Q.dedupNewPairs([F("p.pdf", 1)], [F("p.pdf", 1)], [{ desc: "other" }], [{ desc: "one" }]).dupes, 1);
  var G = "return isMsgFile(f) ? fileSig(f) + '|'";
  if (full.indexOf(G) === -1) throw new Error("negative control: .msg desc sig not found - update this harness");
  r = load(full.replace(G, "return false ? fileSig(f) + '|'")).dedupNewPairs(sigs, [F(N, 39936)], [E("Stuart: Shipping tomorrow.")]);
  A.ok("desc guard defeated -> the W-381605 reply is wrongly skipped again", r.dupes === 1, "got dupes=" + r.dupes);
})();

// Negative control: woDocSigs must honour isArchived.
(function () {
  var G = "return r && !r.isArchived && r.displayFileName && ";
  if (full.indexOf(G) === -1) throw new Error("negative control: archived guard not found - update this harness");
  var n = load(full.replace(G, "return r && r.displayFileName && ")).woDocSigs([{ displayFileName: "x", fileSize: "1", isArchived: true }]).length;
  A.ok("archived guard defeated -> archived row now counts", n === 1, "got " + n);
})();

// A missing / malformed fileSize must never become 0 and swallow a same-named zero-byte drop.
(function () {
  var sigs = Q.woDocSigs([{ displayFileName: "z.txt", fileSize: null }, { displayFileName: "z.txt", fileSize: "" }, { displayFileName: "z.txt", fileSize: "1.2 MB" }, { displayFileName: "z.txt" }]);
  A.eq("malformed sizes dropped from the set", sigs, []);
  var r = Q.dedupNewPairs(Q.woDocSigs([{ displayFileName: "z.txt", fileSize: "0" }]), [F("z.txt", 0), F("Z.txt", 0)], [D("zero"), D("case")]);
  A.eq("real zero-byte doc still matches; case differs = kept", r.files, [D("case")]);
  var S = "/^[0-9]+$/.test(String(r.fileSize))";
  if (full.indexOf(S) === -1) throw new Error("negative control: size guard not found - update this harness");
  var n = load(full.replace(S, "true")).woDocSigs([{ displayFileName: "z.txt", fileSize: null }]).length;
  A.ok("size guard defeated -> null size row now counts", n === 1, "got " + n);
})();


// ---- readWoDocSigs + kill-switch seeding, sliced from the real source (async; A.finish waits) ----
function between(src, a, b, what) {
  var i = src.indexOf(a); if (i === -1 || src.indexOf(a, i + 1) !== -1) throw new Error(what + ': start not found/unique');
  var j = src.indexOf(b, i); if (j === -1) throw new Error(what + ': end not found');
  return src.slice(i, j);
}
var READ_SRC = between(full, '  var JOB_DOCS_Q =', '  function describeDrop(raw) {', 'readWoDocSigs');
var GOV_SRC = between(full, '  var BWN_MODULES = (function', "  try { document.addEventListener('bwn:gov'", 'gov block');
function loadRead(modules, gql, timers) {
  var sb = { BWN_MODULES: modules, bwnGql: gql, Promise: Promise, setTimeout: timers || setTimeout, calls: 0 };
  vm.runInNewContext(slice(full, 'queue block') + READ_SRC + ';this.readWoDocSigs = readWoDocSigs;', sb);
  return sb;
}
function loadGov(ls) {
  var sb = { localStorage: { getItem: function (k) { return k in ls ? ls[k] : null; } } };
  return vm.runInNewContext(GOV_SRC + ';BWN_MODULES;', sb);
}
var ROWS = { jobDocuments: [{ displayFileName: 'a.msg', fileSize: '5', isArchived: false }] };
var pend = [];
function t(name, pr, want) { pend.push(pr.then(function (v) { A.eq(name, v, want); }, function (e) { A.ok(name, false, 'rejected: ' + e); })); }
(function () {
  var n = 0, gql = function (q, v) { n++; A.eq('read is WO-scoped Int', v, { n: 370534 }); A.ok('read is a query, not a mutation', /^query /.test(q)); return Promise.resolve(ROWS); };
  t('happy path returns sigs', loadRead({ dropUploadWoDedupe: true }, gql).readWoDocSigs('370534'), [{ name: 'a.msg', size: 5, desc: '' }]);
  t('no WO number -> [] (no read)', loadRead({ dropUploadWoDedupe: true }, gql).readWoDocSigs(0), []);
  t('killed -> [] (no read)', loadRead({ dropUploadWoDedupe: false }, gql).readWoDocSigs('370534'), []);
  pend.push(Promise.resolve().then(function () { A.eq('read skipped for no-WO and killed', n, 1); }));
  t('rejected read fails open', loadRead({}, function () { return Promise.reject(new Error('x')); }).readWoDocSigs('1'), []);
  t('off-schema payload fails open', loadRead({}, function () { return Promise.resolve({ nope: 1 }); }).readWoDocSigs('1'), []);
  var ms = null, fakeTimer = function (fn, d) { ms = d; fn(); };
  t('hung read resolves [] via cap', loadRead({}, function () { return new Promise(function () {}); }, fakeTimer).readWoDocSigs('1'), []);
  pend.push(Promise.resolve().then(function () { A.eq('cap is 4000ms', ms, 4000); }));
})();
(function () {
  A.eq('seeded default is on', loadGov({}).dropUploadWoDedupe, true);
  A.eq('bwn:modules false survives seeding', loadGov({ 'bwn:modules': '{"dropUploadWoDedupe":false}' }).dropUploadWoDedupe, false);
  A.eq('bwn:gov flag disables seeded key', loadGov({ 'bwn:gov': '{"flags":{"dropUploadWoDedupe":false}}' }).dropUploadWoDedupe, false);
  A.eq('bwn:gov globalKillSwitch disables it', loadGov({ 'bwn:gov': '{"flags":{"globalKillSwitch":true}}' }).dropUploadWoDedupe, false);
  A.eq('bwn:gov can never enable it', loadGov({ 'bwn:modules': '{"dropUploadWoDedupe":false}', 'bwn:gov': '{"flags":{"dropUploadWoDedupe":true}}' }).dropUploadWoDedupe, false);
  var SEED = "  if (!('dropUploadWoDedupe' in BWN_MODULES)) BWN_MODULES.dropUploadWoDedupe = true;";
  if (GOV_SRC.indexOf(SEED) === -1) throw new Error('negative control: seed line not found - update this harness');
  var m = vm.runInNewContext(GOV_SRC.replace(SEED, '') + ';BWN_MODULES;', { localStorage: { getItem: function (k) { return k === 'bwn:gov' ? '{"flags":{"dropUploadWoDedupe":false}}' : null; } } });
  A.ok('seed removed -> bwn:gov kill no longer lands (proves the seed is load-bearing)', m.dropUploadWoDedupe !== false);
})();

Promise.all(pend).then(function () { A.finish(); });
