// test-registry-authoritative.js - G4 / RM-D4: make the BWN_OPS registry authoritative.
//
// THE FINDING (roadmap G4): the write registry drifted from reality - dead entries were registered
// with no caller (addWorkOrder / addDependentVendor / addVendorProposalNote), while the live raw
// writers were not routed through the wrapper at all. A registry that does not match the wired
// call-sites cannot be trusted as "the list of mutations this suite can perform".
//
// WHAT THIS PROVES, against the REAL shipped bytes of every *.user.js that carries a `var BWN_OPS`
// registry (Core + each adopter). Two directions, statically:
//   CHECK A (registration): every wired `bwnGqlOp('<op>', ...)` call-site in a file has an entry for
//     <op> in THAT file's registry. A call to an unregistered op is refused at runtime by the wrapper;
//     this makes it a BUILD gate so it cannot ship.
//   CHECK B (no dead writes): every registry entry with kind:'write' is CALLED via bwnGqlOp somewhere
//     in the suite. Reads are exempt (by design no read routes through the wrapper - they are catalog
//     metadata). A write entry with no caller anywhere is a dead entry and fails here.
//
// Plus regression guards: the 3 dropped dead ops must not reappear in any registry; write-queue must
// register AND call both of its writes. Finally, two synthetic fixtures prove the checker itself
// catches a dead entry (CHECK B) and an unregistered call-site (CHECK A) - a checker that cannot go
// red proves nothing.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-registry-authoritative.js
// CI runs: node scripts/test-registry-authoritative.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');

// ---- Parsers ---------------------------------------------------------------
// Brace-match the BWN_OPS object literal. The registry entries carry no `{`/`}` inside their string
// values, so a plain brace counter is exact here (no need for a JS parser - Hard Rule: laziest correct).
function registryBody(src) {
  var a = src.indexOf('var BWN_OPS = {');
  if (a === -1) return null;
  var i = src.indexOf('{', a);
  var depth = 0;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}

// Parse top-level entries: `    <name>: { ...inner... }` at 4-space indent. Comment lines (`    // ..`)
// never match because `/` is not an identifier start. Entries carry no nested braces.
function parseRegistry(body) {
  var out = {};
  var re = /\n {4}([A-Za-z_$][\w$]*):\s*\{([^}]*)\}/g, m;
  while ((m = re.exec(body)) !== null) {
    var name = m[1], inner = m[2];
    var km = /kind:\s*'(read|write)'/.exec(inner);
    var rm = /risk:\s*'([a-z]+)'/.exec(inner);
    out[name] = { kind: km ? km[1] : null, risk: rm ? rm[1] : null };
  }
  return out;
}

// Every wired call-site: bwnGqlOp('<op>', ...). The function DEFINITION (`function bwnGqlOp(op,`) and
// `bwnGqlOp.setConfirm` do not carry a quoted first arg, so they never match.
function callSites(src) {
  var out = [], re = /bwnGqlOp\(\s*'([A-Za-z_$][\w$]*)'/g, m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

// ---- Scan the real files ---------------------------------------------------
var FILES = fs.readdirSync(ROOT).filter(function (f) { return /\.user\.js$/.test(f); });
var registries = {};   // file -> parsed registry
var calls = {};        // file -> [op, ...]
var suiteCalls = {};   // op -> true (called anywhere)

FILES.forEach(function (f) {
  var src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  var body = registryBody(src);
  if (body) registries[f] = parseRegistry(body);
  var cs = callSites(src);
  if (cs.length) { calls[f] = cs; cs.forEach(function (op) { suiteCalls[op] = true; }); }
});

console.log('\n-- inventory --');
Object.keys(registries).forEach(function (f) {
  var writes = Object.keys(registries[f]).filter(function (op) { return registries[f][op].kind === 'write'; });
  console.log('  ' + f + ': ' + Object.keys(registries[f]).length + ' entries (' + writes.length + ' writes), ' + ((calls[f] || []).length) + ' call-sites');
});

// A call-site can only exist in a file whose sandbox defines bwnGqlOp, i.e. a file WITH a registry.
console.log('\n-- CHECK A: every bwnGqlOp call-site is registered in its OWN file --');
Object.keys(calls).forEach(function (f) {
  var reg = registries[f] || {};
  uniq(calls[f]).forEach(function (op) {
    A.ok('[' + f + '] calls bwnGqlOp(' + op + ') and registers ' + op, !!reg[op],
      reg[op] ? '' : 'call-site with NO registry entry (would be refused at runtime)');
  });
});

console.log('\n-- CHECK B: every registry WRITE entry has a real call-site somewhere in the suite --');
Object.keys(registries).forEach(function (f) {
  var reg = registries[f];
  Object.keys(reg).forEach(function (op) {
    if (reg[op].kind !== 'write') return;   // reads are catalog metadata, exempt by design
    A.ok('[' + f + '] registers write ' + op + ' AND it is called via bwnGqlOp somewhere', !!suiteCalls[op],
      suiteCalls[op] ? '' : 'DEAD registry entry: no bwnGqlOp call-site anywhere');
  });
});

console.log('\n-- regression guards (RM-D4 specifics) --');
var DEAD = ['addWorkOrder', 'addDependentVendor', 'addVendorProposalNote'];
DEAD.forEach(function (op) {
  var where = Object.keys(registries).filter(function (f) { return registries[f][op]; });
  A.ok('dropped dead op "' + op + '" is absent from every registry', where.length === 0, where.join(','));
  A.ok('dropped dead op "' + op + '" has no call-site anywhere', !suiteCalls[op]);
});
var wq = registries['bwn-write-queue.user.js'] || {};
A.ok('write-queue registers patchWorkOrder (high) + addEditJobNote (moderate)',
  wq.patchWorkOrder && wq.patchWorkOrder.risk === 'high' && wq.addEditJobNote && wq.addEditJobNote.risk === 'moderate', JSON.stringify(wq));
A.ok('write-queue actually calls both ops it registers',
  (calls['bwn-write-queue.user.js'] || []).indexOf('patchWorkOrder') !== -1 && (calls['bwn-write-queue.user.js'] || []).indexOf('addEditJobNote') !== -1);
A.ok('Core registry still classifies patchWorkOrder high + addEditJobNote moderate',
  registries['bwn-suite-core.user.js'].patchWorkOrder.risk === 'high' && registries['bwn-suite-core.user.js'].addEditJobNote.risk === 'moderate');

// ---- Synthetic controls: the checker itself must be able to go red ----------
console.log('\n-- synthetic controls: the checker catches a dead entry and an unregistered call --');
(function () {
  var FIX_REG = "  var BWN_OPS = {\n" +
    "    patchWorkOrder: { kind: 'write', target: 'workOrder', risk: 'high', idempotent: false, retry: 'none' },\n" +
    "    ghostWrite: { kind: 'write', target: 'x', risk: 'moderate', idempotent: false, retry: 'none' },\n" +
    "    workOrder: { kind: 'read', target: 'workOrder', retry: 'safe' }\n" +
    "  };";
  var reg = parseRegistry(registryBody(FIX_REG));
  A.ok('fixture parses 2 writes + 1 read', reg.patchWorkOrder.kind === 'write' && reg.ghostWrite.kind === 'write' && reg.workOrder.kind === 'read');
  // fixture call-sites: only patchWorkOrder is called; ghostWrite is dead; unregisteredOp is called but absent.
  var fixSrc = "x(); bwnGqlOp('patchWorkOrder', Q, V, O); bwnGqlOp('unregisteredOp', Q, V, O);";
  var cs = callSites(fixSrc);
  var fixSuite = {}; cs.forEach(function (op) { fixSuite[op] = true; });
  // CHECK A over the fixture: unregisteredOp is a call with no entry -> caught.
  var aViol = uniq(cs).filter(function (op) { return !reg[op]; });
  A.eq('CONTROL A: an unregistered call-site is caught', aViol, ['unregisteredOp']);
  // CHECK B over the fixture: ghostWrite is a registered write with no call-site -> caught.
  var bViol = Object.keys(reg).filter(function (op) { return reg[op].kind === 'write' && !fixSuite[op]; });
  A.eq('CONTROL B: a dead registry write is caught', bViol, ['ghostWrite']);
  // reads are never flagged as dead even with no call-site.
  A.ok('CONTROL: a read with no call-site is NOT flagged', bViol.indexOf('workOrder') === -1);
})();

A.finish();
