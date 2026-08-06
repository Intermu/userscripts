// test-ai-coordinator-read.js - node harness for the AI drafts' coordinator read.
//
// THE DEFECT, as found in source (fixed 2026-08-06, bwn-suite-ai 1.42.8):
//   woToJob read `workOrder(workOrderNumber){ assignedToMemberName vendorNames }`. Type
//   WorkOrder has 75 fields and NEITHER of those is one of them (introspected the same
//   day), so the query threw on every call and the catch left `coordinator = null`. Every
//   AI draft ever generated attributed its next actions to nobody. Third instance of the
//   swallow-a-schema-error-into-a-fact class found that day, after the docs reader and the
//   trips read.
//
// THE FIX: WorkOrder exposes the assignee only as `assignedTo` (ID, a GUID), so the read
//   is the two-step the rest of the suite uses - read the id, then user(id:){ firstName
//   lastName } and join. Same USER_Q shape and ID! typing as bwn-dispatch. `vendorNames`
//   is dropped entirely (no such field); vendors now come from the PO-trips read.
//
// WHY NOT A STUB-ONLY HARNESS: a stub returns whatever the author believes, so it agrees
//   with the code by construction - which is how the dead query passed review. Section 1
//   validates the SHIPPED query strings against a RECORDED schema (arg names/types that
//   exist, fields that exist on the type being selected). Section 2 stubs gql to prove the
//   two-step logic - name join, the Team filter, isolation, warn-on-failure - which is a
//   pure client-side property.
//
// DOES NOT PROVE: that the live schema still matches SCHEMA below. Re-introspect on drift.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ai-coordinator-read.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var AI_SRC = path.join(__dirname, '..', 'bwn-suite-ai.user.js');
var aiFull = fs.readFileSync(AI_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = aiFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (aiFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = aiFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return aiFull.slice(a, b);
}

var S_COORD = slice('    // --- COORDINATOR via assignedTo', '    // --- NOTES.', 'coordinator block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- Recorded schema (measured 2026-08-06) -----------------------------------
var SCHEMA = {
  roots: {
    workOrder: { args: { workOrderNumber: 'Int' }, returns: 'WorkOrder' },
    user: { args: { id: 'ID!' }, returns: 'User' }
  },
  types: {
    WorkOrder: ['assignedTo', 'owner_TenantProfileId', 'id', 'number', 'trackingNumber', 'statusName', 'priority', 'trades', 'doNotExceed', 'address', 'locationName'],  // partial; the ones this file selects must be in here
    User: ['firstName', 'lastName', 'emailAddress', 'isInactive', 'id']
  }
};

// Shallow parse of `root(args){ fieldA fieldB{ x } }`.
function parseRead(q, root) {
  var re = new RegExp('\\b' + root + '\\(([^)]*)\\)\\s*\\{([\\s\\S]*)', '');
  var m = re.exec(q);
  if (!m) return null;
  var args = {};
  (m[1].match(/([A-Za-z_]\w*)\s*:\s*\$([A-Za-z_]\w*)/g) || []).forEach(function (s) {
    var mm = /([A-Za-z_]\w*)\s*:\s*\$([A-Za-z_]\w*)/.exec(s); args[mm[1]] = mm[2];
  });
  // top-level field names inside the first brace group
  var body = m[2], depth = 1, tok = '', top = [];
  for (var i = 0; i < body.length && depth > 0; i++) {
    var c = body[i];
    if (c === '{') { if (depth === 1 && tok.trim()) { top.push(tok.trim().split(/\s+/).pop()); tok = ''; } depth++; continue; }
    if (c === '}') { depth--; if (depth === 1) tok = ''; continue; }
    if (depth === 1) tok += c;
  }
  tok.trim().split(/\s+/).filter(Boolean).forEach(function (w) { top.push(w); });
  return { args: Object.keys(args), fields: top.filter(function (x, j, a) { return a.indexOf(x) === j; }) };
}
function validate(q, root) {
  var def = SCHEMA.roots[root];
  var r = parseRead(q, root);
  if (!r) return ['root "' + root + '" not found in query'];
  var errs = [];
  r.args.forEach(function (a) { if (!(a in def.args)) errs.push('Unknown argument "' + a + '" on "' + root + '"'); });
  var allowed = SCHEMA.types[def.returns];
  r.fields.forEach(function (f) { if (allowed.indexOf(f) === -1) errs.push('Cannot query field "' + f + '" on type "' + def.returns + '"'); });
  return errs;
}

// ---- Section 1: shipped queries vs the schema --------------------------------
console.log('\n-- the shipped coordinator queries vs the measured schema --');
var CID = (S_COORD.match(/var CID_Q = '([^']+)'/) || [])[1];
var CU = (S_COORD.match(/var CU_Q = '([^']+)'/) || [])[1];
A.ok('an assignee-id query is present', !!CID, 'CID_Q not found');
A.ok('a user-lookup query is present', !!CU, 'CU_Q not found');
A.eq('the assignee-id read validates', validate(CID, 'workOrder'), []);
A.eq('the user lookup validates', validate(CU, 'user'), []);
A.ok('the assignee is read as assignedTo (an id), not a member-name field',
  /assignedTo/.test(CID) && !/assignedToMemberName/.test(CID), CID);
// Scoped to the query strings: the block's comment names vendorNames to explain why it
// is gone, and that prose must not be able to fail this.
A.ok('the dead vendorNames selector is in neither query',
  CID.indexOf('vendorNames') === -1 && CU.indexOf('vendorNames') === -1, 'vendorNames still in a query');
A.ok('the user id is typed ID! (a bare Int type-errors on the real schema)', /\$id:\s*ID!/.test(CU), CU);
// the validator must reject the query that shipped dead
var DEAD = 'query($n:Int!){ workOrder(workOrderNumber:$n){ assignedToMemberName vendorNames } }';
A.ok('the validator rejects the ORIGINAL dead query',
  validate(DEAD, 'workOrder').length === 2, JSON.stringify(validate(DEAD, 'workOrder')));

// ---- Section 2: the two-step logic, gql stubbed ------------------------------
console.log('\n-- resolve, filter, isolate, warn --');
function run(src, opts) {
  var warns = [], calls = [];
  var sandbox = {
    console: { warn: function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); } },
    Array: Array, Promise: Promise, Error: Error,
    gql: function (q, v) {
      calls.push({ q: q, v: v });
      var isId = /assignedTo/.test(q);
      if (isId) {
        if (opts.failId) return Promise.reject(new Error('boom-id'));
        return Promise.resolve({ workOrder: { assignedTo: opts.assignedTo === undefined ? 'guid-1' : opts.assignedTo } });
      }
      if (opts.failUser) return Promise.reject(new Error('boom-user'));
      return Promise.resolve({ user: opts.user === undefined ? { firstName: 'Dana', lastName: 'Lee' } : opts.user });
    }
  };
  vm.createContext(sandbox);
  return vm.runInContext(
    '(async function (n) {\n' + src + '\nreturn coordinator;\n})',
    sandbox, { filename: 'coord-block.js' })(375344).then(function (c) { return { coordinator: c, warns: warns, calls: calls }; });
}

function main() {
  return run(S_COORD, {}).then(function (r) {
    A.eq('a resolvable assignee becomes "First Last"', r.coordinator, 'Dana Lee');
    A.eq('and it took two reads', r.calls.length, 2);
    A.eq('the user lookup was passed the id from the first read', r.calls[1].v.id, 'guid-1');
    A.eq('a clean read logs nothing', r.warns.length, 0);
    return run(S_COORD, { assignedTo: null });
  }).then(function (r) {
    A.eq('no assignee -> null coordinator', r.coordinator, null);
    A.eq('and no user lookup is attempted', r.calls.length, 1);
    A.eq('and it is NOT an error (a real WO can be unassigned)', r.warns.length, 0);
    return run(S_COORD, { user: { firstName: 'Team', lastName: 'J' } });
  }).then(function (r) {
    A.eq('a "Team ..." assignee is not a coordinator', r.coordinator, null);
    return run(S_COORD, { user: { firstName: 'Ada', lastName: null } });
  }).then(function (r) {
    A.eq('a half-populated name still resolves to what exists', r.coordinator, 'Ada');
    return run(S_COORD, { user: null });
  }).then(function (r) {
    A.eq('an unresolvable id -> null, not a crash', r.coordinator, null);
    return run(S_COORD, { failUser: true });
  }).then(function (r) {
    A.eq('a failed user lookup -> null', r.coordinator, null);
    A.eq('and warns once', r.warns.length, 1);
    A.ok('naming the WO', /W-375344/.test(r.warns[0]), r.warns[0]);
    A.ok('and saying no owner, not unassigned', /not "unassigned"/.test(r.warns[0]), r.warns[0]);
    return run(S_COORD, { failId: true });
  }).then(function (r) {
    A.eq('a failed id read -> null + one warn', r.warns.length, 1);

    console.log('\n-- negative controls: each must turn the cases above red --');
    var MUT = [
      { what: 'the dead assignedToMemberName selector returning',
        f: function (s) { return mutate(s, 'workOrder(workOrderNumber:$n){ assignedTo }', 'workOrder(workOrderNumber:$n){ assignedToMemberName }'); } },
      { what: 'the id passed as Int instead of ID!',
        f: function (s) { return mutate(s, 'query($id:ID!){ user(id:$id)', 'query($id:Int!){ user(id:$id)'); } },
      { what: 'the Team filter dropped',
        f: function (s) { return mutate(s, "if (full && !/^team\\b/i.test(full)) coordinator = full;", 'if (full) coordinator = full;'); } },
      { what: 'the failure going silent again',
        f: function (s) { return mutate(s, "console.warn('[BWN SUITE AI] coordinator read FAILED", "void ('[BWN SUITE AI] coordinator read FAILED"); } }
    ];
    return MUT.reduce(function (chain, m) {
      return chain.then(function () {
        var src;
        try { src = m.f(S_COORD); } catch (e) { A.ok('CAUGHT: ' + m.what, false, 'mutation could not be applied: ' + e.message); return; }
        return Promise.all([
          run(src, {}), run(src, { user: { firstName: 'Team', lastName: 'J' } }), run(src, { failUser: true })
        ]).then(function (rs) {
          var clean = rs[0], team = rs[1], fail = rs[2];
          var cuStr = (src.match(/var CU_Q = '([^']+)'/) || [])[1] || '';
          var cidOk = validate((src.match(/var CID_Q = '([^']+)'/) || [])[1] || '', 'workOrder').length === 0;
          var cuOk = validate(cuStr, 'user').length === 0;
          // parseRead checks arg NAMES; the ID! vs Int! typing lives in the var decl, so
          // check it explicitly - it is the whole point of the "passed as Int" control.
          var idTypeOk = /\$id:\s*ID!/.test(cuStr);
          var stillGood = clean.coordinator === 'Dana Lee' && clean.warns.length === 0 &&
            team.coordinator === null && fail.warns.length === 1 && cidOk && cuOk && idTypeOk;
          A.ok('CAUGHT: ' + m.what, !stillGood, 'mutation produced NO observable failure - this control proves nothing');
        }, function () { A.ok('CAUGHT: ' + m.what, true); });
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
