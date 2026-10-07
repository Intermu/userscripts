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
    var pm = /perm:\s*(?:'([^']+)'|\[([^\]]*)\]|([A-Za-z_$][\w$]*))/.exec(inner);
    out[name] = {
      kind: km ? km[1] : null, risk: rm ? rm[1] : null,
      // The Umbrava permission this write needs: a quoted key, an array of them, or the name of a
      // function (patchWorkOrder's per-field resolver). null = the entry declares none.
      perm: pm ? (pm[1] || pm[2] || pm[3]) : null
    };
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

// ---- CHECK D: every GraphQL mutation DOCUMENT is sent only through bwnGqlOp ----
// CHECK A/B only see `bwnGqlOp('<op>'` call-sites, so a raw `gql(PATCH_M)` or a mutation in a file
// with no registry stayed green. D scans the documents themselves. A mutation document is a string
// literal that STARTS with `mutation` (after optional GraphQL `#` comment lines) and then a name, `(`
// or `{` - so MutationObserver, 'Mutation failed', `mutationFailed` and prose never match.
// ponytail: static scan of literal documents only. A mutation assembled by concatenation
// ('muta' + 'tion') or a template with ${} before the keyword is invisible here; the suite has none.
function stripLineComments(src) {
  // Whole-line `//` and ` * ` comment lines only. Block-comment stripping would eat code after a
  // string like '*/*' (an Accept header), so it is deliberately not attempted.
  return src.split('\n').map(function (l) { return /^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l; }).join('\n');
}
var MUT_DOC_RE = /(['"`])\s*(?:#[^\n'"`\\]*(?:\\n|\n)\s*)*mutation\b(?:\s+[A-Za-z_]\w*)?\s*[({]/g;
function mutationDocs(src) {
  var out = [], m;
  MUT_DOC_RE.lastIndex = 0;
  while ((m = MUT_DOC_RE.exec(src)) !== null) {
    // Two lines back, so an array-joined document whose first element sits under `var X = [` is named.
    var lineStart = src.lastIndexOf('\n', src.lastIndexOf('\n', m.index) - 1) + 1;
    var before = src.slice(lineStart, m.index);
    var decl = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\[?\s*$/.exec(before);
    var inline = /bwnGqlOp\(\s*'([A-Za-z_$][\w$]*)'\s*,\s*$/.exec(before);
    // Root field = first selection after the operation's opening `{` (alias-aware). JS quoting,
    // `+`, `,` and escaped newlines are blanked so an array-joined or concatenated document reads
    // the same as a one-line one.
    var body = src.slice(m.index + 1, m.index + 800).replace(/\\n/g, ' ').replace(/['"`+,\n]/g, ' ');
    body = body.replace(/#[^\n]*/g, ' ');
    var rf = /\{\s*(?:[A-Za-z_]\w*\s*:\s*)?([A-Za-z_]\w*)/.exec(body);
    out.push({ name: decl ? decl[1] : null, inlineOp: inline ? inline[1] : null, field: rf ? rf[1] : null,
      line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}
// Pure so the synthetic controls below drive the SAME code as the real scan.
// files: { name: src }, regs: { name: parsedRegistry }. Returns violation strings, D1/D2/D3-prefixed.
function checkD(files, regs) {
  var v = [];
  Object.keys(files).forEach(function (f) {
    var src = stripLineComments(files[f]);
    var docs = mutationDocs(src);
    if (!docs.length) return;
    var reg = regs[f];
    // D1: a mutation document can only live in a file whose sandbox has a registry + wrapper.
    if (!reg) { v.push('D1: [' + f + '] has ' + docs.length + ' mutation document(s) and no BWN_OPS registry (line ' + docs[0].line + ')'); return; }
    var fieldsByName = {};
    docs.forEach(function (d) {
      if (d.name) { (fieldsByName[d.name] = fieldsByName[d.name] || []).push(d.field); return; }
      if (d.inlineOp) { checkOp(f, d.inlineOp, [d.field], 'inline document line ' + d.line); return; }
      v.push('D2: [' + f + '] line ' + d.line + ': anonymous mutation document not passed straight to bwnGqlOp');
    });
    Object.keys(fieldsByName).forEach(function (name) {
      // Full RegExp escape (names are identifiers today, so only `$` occurs - but escape everything).
      var safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Bare identifier uses only: a quoted 'PATCH_M' (dispatch's DISPATCH_API `const:` label) is data, not a send.
      var re = new RegExp('(?<![\'"\\w$])' + safe + '(?![\\w$\'"])', 'g');
      var total = (src.match(re) || []).length;
      var decls = (src.match(new RegExp('(?:var|let|const)\\s+' + safe + '\\s*=', 'g')) || []).length;
      var sendRe = new RegExp("bwnGqlOp\\(\\s*'([A-Za-z_$][\\w$]*)'\\s*,\\s*" + safe + '\\b', 'g'), s, sends = 0;
      while ((s = sendRe.exec(src)) !== null) { sends++; checkOp(f, s[1], fieldsByName[name], name); }
      // D2: every use of the document constant other than its declaration is a bwnGqlOp send.
      if (sends === 0 || total - decls !== sends) {
        v.push('D2: [' + f + '] ' + name + ' used ' + (total - decls) + 'x but sent via bwnGqlOp ' + sends + 'x (raw send / bypass)');
      }
    });
    // D3: the op sent must be a registered WRITE, and the document's root field must BE that op.
    function checkOp(file, op, fields, what) {
      if (!reg[op] || reg[op].kind !== 'write') v.push('D3: [' + file + '] ' + what + ' sent as ' + op + ', which is not a registered write');
      if (fields.indexOf(op) === -1) v.push('D3: [' + file + '] ' + what + ' sent as ' + op + ' but its root field is ' + fields.join('|'));
    }
  });
  return v;
}

// ---- Scan the real files ---------------------------------------------------
var FILES = fs.readdirSync(ROOT).filter(function (f) { return /\.user\.js$/.test(f); });
var registries = {};   // file -> parsed registry
var calls = {};        // file -> [op, ...]
var suiteCalls = {};   // op -> true (called anywhere)
var sources = {};      // file -> src (CHECK D)

FILES.forEach(function (f) {
  var src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  sources[f] = src;
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

// CHECK C (G7): the permission gate can only enforce what the registry declares. An entry with no
// `perm` is a write that bypasses the gate for every user - which is correct for exactly one thing
// (a personal UI preference, which Umbrava does not gate) and a hole for anything else. The exempt
// list is deliberately tiny and lives here, so adding a write without a permission is an EDIT to
// this file rather than an omission nobody notices.
console.log('\n-- CHECK C: every registry WRITE declares the Umbrava permission it needs --');
var PERM_EXEMPT = {
  // Umbrava's own column chooser writes this same preference for any user; there is no checkbox
  // for it, and gating it would break saved layouts for people who may not edit work orders.
  putUserPreference: 'personal UI state - Umbrava has no permission for it',
  // NOT "by design" like the row above: OWED. Umbrava's asset permission flags have not been read out
  // of the SPA bundle yet, so BWN_PERM_MAP (Core) has no Asset group and any key named here would be
  // a guess that fails OPEN anyway. Replace this exemption with the real perm once the flags are
  // captured. Until then the server is the only gate; the dock row is rank-4-only (BWN_DOCK_POLICY).
  createAsset: 'OWED - Umbrava asset permission flags not captured yet; server is the gate'
};
Object.keys(registries).forEach(function (f) {
  var reg = registries[f];
  Object.keys(reg).forEach(function (op) {
    if (reg[op].kind !== 'write') return;
    if (PERM_EXEMPT[op]) {
      A.ok('[' + f + '] ' + op + ' is EXEMPT by design (' + PERM_EXEMPT[op] + ')', reg[op].perm === null,
        'an exempt op declared a perm - drop it from PERM_EXEMPT or from the entry');
      return;
    }
    A.ok('[' + f + '] write ' + op + ' declares perm (' + (reg[op].perm || 'MISSING') + ')', !!reg[op].perm,
      'ungated write: add perm:, or add it to PERM_EXEMPT with a reason');
  });
});
// The same op must ask for the SAME permission in every sandbox that registers it - a per-file
// registry is exactly where a mapping can drift.
console.log('\n-- CHECK C2: an op asks for the same permission in every registry --');
(function () {
  var byOp = {};
  Object.keys(registries).forEach(function (f) {
    var reg = registries[f];
    Object.keys(reg).forEach(function (op) {
      if (reg[op].kind !== 'write') return;
      (byOp[op] = byOp[op] || []).push({ f: f, perm: reg[op].perm });
    });
  });
  Object.keys(byOp).filter(function (op) { return byOp[op].length > 1; }).forEach(function (op) {
    var perms = uniq(byOp[op].map(function (x) { return String(x.perm); }));
    A.ok('write ' + op + ' asks for one permission across ' + byOp[op].length + ' registries (' + perms.join(' | ') + ')',
      perms.length === 1, JSON.stringify(byOp[op]));
  });
})();

console.log('\n-- CHECK D: every mutation document lives in a registry file and is sent only via bwnGqlOp --');
(function () {
  var inv = 0;
  Object.keys(sources).forEach(function (f) { inv += mutationDocs(stripLineComments(sources[f])).length; });
  A.ok('found the suite\'s mutation documents (' + inv + ')', inv >= 25, 'scanner went blind - fewer documents than the 28 inventoried 2026-10-05');
  var dv = checkD(sources, registries);
  A.eq('CHECK D: no raw mutation, no registry-less mutation, no op/document mismatch', dv, []);
})();

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

  // CHECK C over a fixture: ghostWrite declares no perm and is not exempt -> caught. The two
  // declared forms (quoted key, function name) must both parse, or "declares perm" would be
  // satisfied by nothing at all.
  var FIX_C = "  var BWN_OPS = {\n" +
    "    patchWorkOrder: { kind: 'write', perm: bwnPermsForPatch, risk: 'high' },\n" +
    "    addEditJobNote: { kind: 'write', perm: 'WorkOrderNote.AddNew', risk: 'moderate' },\n" +
    "    listPerms: { kind: 'write', perm: ['A.b', 'C.d'], risk: 'moderate' },\n" +
    "    ghostWrite: { kind: 'write', target: 'x', risk: 'moderate' }\n" +
    "  };";
  var regC = parseRegistry(registryBody(FIX_C));
  A.eq('CONTROL C: a function-valued perm parses', regC.patchWorkOrder.perm, 'bwnPermsForPatch');
  A.eq('CONTROL C: a quoted perm parses', regC.addEditJobNote.perm, 'WorkOrderNote.AddNew');
  A.ok('CONTROL C: an array perm parses', /A\.b/.test(String(regC.listPerms.perm)), String(regC.listPerms.perm));
  var cViol = Object.keys(regC).filter(function (op) { return regC[op].kind === 'write' && !regC[op].perm && !PERM_EXEMPT[op]; });
  A.eq('CONTROL C: an ungated write is caught', cViol, ['ghostWrite']);

  // CHECK D over fixtures: each red case must produce exactly its own code; the green controls none.
  var REG_D = { 'r.user.js': parseRegistry(registryBody(FIX_REG)) };
  function codes(src, withReg) {
    return checkD({ 'r.user.js': src }, withReg ? REG_D : {}).map(function (s) { return s.slice(0, 2); });
  }
  var RAW = "var RAW_M = 'mutation Foo($d: I!) { patchWorkOrder(data: $d) { success } }';\nfetch('/api/graphql', { body: JSON.stringify({ query: RAW_M }) });";
  A.eq('CONTROL D1: a mutation in a file with no registry is caught', codes(RAW, false), ['D1']);
  A.eq('CONTROL D2: a mutation constant sent by raw fetch is caught', codes(RAW, true), ['D2']);
  A.eq('CONTROL D2: a mutation constant sent via gql() is caught',
    codes("var P_M = 'mutation P($d: I!) { patchWorkOrder(data: $d) { success } }';\ngql(P_M, {});", true), ['D2']);
  A.eq('CONTROL D2: an anonymous inline mutation in a raw body is caught',
    codes("fetch(u, { body: JSON.stringify({ query: 'mutation { patchWorkOrder(data: {}) { success } }' }) });", true), ['D2']);
  A.eq('CONTROL D2: a #-commented document is still seen',
    codes("var C_M = '# note\\nmutation P($d: I!) { patchWorkOrder(data: $d) { success } }';\ngql(C_M);", true), ['D2']);
  A.eq('CONTROL D3: a mutation sent under a READ op is caught',
    codes("var P_M = 'mutation P($d: I!) { patchWorkOrder(data: $d) { success } }';\nbwnGqlOp('workOrder', P_M, {});", true), ['D3', 'D3']);
  A.eq('CONTROL D3: a document whose root field is not the op is caught',
    codes("var N_M = 'mutation N($d: I!) { addEditJobNote(data: $d) { success } }';\nbwnGqlOp('patchWorkOrder', N_M, {});", true), ['D3']);
  A.eq('CONTROL green: a correct pair (one-line and array-joined, aliased, quoted const label) passes',
    codes("var API = { patch: { const: 'PATCH_M' } };\nvar PATCH_M = 'mutation PatchWorkOrder($data: X!) { patchWorkOrder(data: $data) { success } }';\nbwnGqlOp('patchWorkOrder', PATCH_M, v);\n" +
      "var J_M = [\n  'mutation J($d: X!) {',\n  '  r: patchWorkOrder(data: $d) { success }',\n  '}'\n].join('\\n');\nbwnGqlOp('patchWorkOrder', J_M, v);", true), []);
  A.eq('CONTROL green: prose, comments, MutationObserver, error strings and reads never match',
    codes("// var X = 'mutation PatchWorkOrder($d: X!) { patchWorkOrder }'; gql(X);\n" +
      " * 'mutation Foo { bar }' in a block comment\nnew MutationObserver(f); var s = 'Mutation failed'; var t = 'mutation failed: ' + e;\n" +
      "var m = /mutation/; var mutationCount = 0; var Q = 'query Q { workOrder(id: 1) { id } }'; gql(Q);", false), []);
})();

A.finish();
