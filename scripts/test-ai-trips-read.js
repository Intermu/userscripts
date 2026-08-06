// test-ai-trips-read.js - node harness for the AI drafts' trips read in bwn-suite-ai.
//
// THE DEFECT, as found in source:
//   woToJob()'s trips block carried the comment "(guessed root query + shape)" and the
//   guess was wrong in three ways at once:
//     query($id:Int!){ workOrderTrips(workOrderId:$id){
//       workOrderTrips{ trips{...} } purchaseOrderTrips{ vendorName trips{...} } } }
//   Run against the live schema 2026-08-06 it produced FOUR validation errors and no
//   data, every single time:
//     - Unknown argument "workOrderId" on field "Query.workOrderTrips".
//     - Cannot query field "workOrderTrips" on type "WorkOrderTrip".
//     - Cannot query field "purchaseOrderTrips" on type "WorkOrderTrip".
//     - Field "workOrderTrips" argument "jobId" of type "Int!" is required.
//   gql() throws on errors[], and the block's catch turned that into `trips = []`. So
//   every AI draft ever generated carried zero trips and zero PO vendor names, and read
//   as "this work order has no trips". Same class as the 2026-07-23 notes bug (a6fed23):
//   wrong argument -> throws -> swallowed to empty.
//
// THE MEASURED TRUTH (introspection + live reads, 2026-08-06), recorded as SCHEMA below:
//   workOrderTrips(jobId: Int!) -> WorkOrderTrip { trips clientId clientName hasActiveUsers }
//   purchaseOrderTrips(jobId: Int!) -> [PurchaseOrderTrip] incl. vendorName, trips
//   purchaseOrderTrips is a ROOT field, NOT a child of WorkOrderTrip.
//   Corrected reads on three live WOs returned 3/2/5 PO vendor groups and 4/1/3 PO trips
//   where the old query returned nothing at all.
//
// WHY A STUB-ONLY HARNESS WOULD NOT HAVE CAUGHT IT, and what this does instead:
//   a stubbed fetch returns whatever shape the test author believes in, so it agrees with
//   the code by construction - which is exactly how the original query shipped dead and
//   how scripts/test-notes-api.js's 46 green assertions say nothing about the server. So
//   the first section here validates the SHIPPED QUERY STRINGS against a RECORDED SCHEMA
//   (args that exist, fields that exist on the type actually being selected) rather than
//   against a stub. The second section stubs gql only to prove the block's isolation and
//   logging behaviour, which is a pure client-side property.
//
// WHAT IT DOES NOT PROVE: that the live schema still matches SCHEMA below. If Umbrava
//   renames a field this harness stays green and the read dies. Re-introspect on drift.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ai-trips-read.js

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

var S_TRIPS = slice('    // --- TRIPS. Two SEPARATE root fields', '    // --- derived dates', 'trips block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- The recorded schema (measured, not assumed) -----------------------------
var SCHEMA = {
  workOrderTrips: { args: ['jobId'], returns: 'WorkOrderTrip' },
  purchaseOrderTrips: { args: ['jobId'], returns: 'PurchaseOrderTrip' },
  types: {
    WorkOrderTrip: ['trips', 'clientId', 'clientName', 'hasActiveUsers'],
    PurchaseOrderTrip: ['id', 'trips', 'number', 'phase', 'purchaseOrderDate', 'vendorId', 'vendorName', 'hasActiveUsers'],
    Trip: ['id', 'number', 'lastModifiedDate', 'duration', 'onSiteDate', 'scope', 'status',
      'cancellationReasonId', 'cancellationReasonDetails', 'canceledBy', 'completedDate',
      'rescheduleReasonId', 'previousOnSiteDate', 'rescheduledBy', 'rescheduleReasonDetails', 'technicians']
  }
};

// Pull `root(arg:$v){ a b c{ d } }` out of a query string, shallowly.
function parseRead(q) {
  var m = /\b(workOrderTrips|purchaseOrderTrips)\(([^)]*)\)\s*\{([\s\S]*)\}\s*\}\s*$/.exec(q);
  if (!m) return null;
  var args = (m[2].match(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g) || []).map(function (s) { return s.replace(/\s*:$/, ''); });
  var body = m[3];
  var top = [];
  var depth = 0, tok = '';
  for (var i = 0; i < body.length; i++) {
    var c = body[i];
    if (c === '{') { if (depth === 0 && tok.trim()) { top.push(tok.trim().split(/\s+/).pop()); tok = ''; } depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth === 0) tok += c;
  }
  tok.trim().split(/\s+/).filter(Boolean).forEach(function (w) { top.push(w); });
  return { root: m[1], args: args, fields: top.filter(function (x, j, arr) { return arr.indexOf(x) === j; }) };
}

function validate(q) {
  var r = parseRead(q);
  if (!r) return ['unparseable query'];
  var errs = [];
  var def = SCHEMA[r.root];
  r.args.forEach(function (a) { if (def.args.indexOf(a) === -1) errs.push('Unknown argument "' + a + '" on field "Query.' + r.root + '"'); });
  def.args.forEach(function (a) { if (r.args.indexOf(a) === -1) errs.push('Required argument "' + a + '" not provided to "' + r.root + '"'); });
  var allowed = SCHEMA.types[def.returns];
  r.fields.forEach(function (f) { if (allowed.indexOf(f) === -1) errs.push('Cannot query field "' + f + '" on type "' + def.returns + '"'); });
  return errs;
}

// ---- Section 1: the shipped queries, against the recorded schema -------------
console.log('\n-- the shipped query strings vs the measured schema --');
var WT = (S_TRIPS.match(/var WT_Q = '([^']+)'/) || [])[1];
var PT = (S_TRIPS.match(/var PT_Q = '([^']+)'/) || [])[1];
A.ok('a workOrderTrips query is present', !!WT, 'WT_Q not found in the block');
A.ok('a purchaseOrderTrips query is present', !!PT, 'PT_Q not found in the block');
A.eq('workOrderTrips validates against the real schema', validate(WT), []);
A.eq('purchaseOrderTrips validates against the real schema', validate(PT), []);
A.ok('they are two SEPARATE root reads, not one nested query', WT !== PT && WT.indexOf('purchaseOrderTrips') === -1,
  'purchaseOrderTrips must not be selected inside workOrderTrips - it is a root field');
// Scoped to the QUERY STRINGS on purpose: the block's comment names workOrderId when
// explaining why it is wrong, and that prose must not be able to fail this.
A.ok('the dead workOrderId argument is gone from both queries',
  WT.indexOf('workOrderId') === -1 && PT.indexOf('workOrderId') === -1, 'workOrderId still in a query');
A.ok('both reads are keyed by the internal job id', /workOrderTrips\(jobId:/.test(WT) && /purchaseOrderTrips\(jobId:/.test(PT));
A.ok('the block passes woId (internal), never the WO number n', /\{ id: woId \}/.test(S_TRIPS) && !/\{ id: n \}/.test(S_TRIPS),
  'the id argument must be the internal job id');

// the validator must actually reject the query that shipped broken
var OLD = 'query($id:Int!){ workOrderTrips(workOrderId:$id){ workOrderTrips{ trips{ onSiteDate } } purchaseOrderTrips{ vendorName trips{ onSiteDate } } } }';
var oldErrs = validate(OLD);
A.ok('the validator rejects the ORIGINAL broken query', oldErrs.length >= 3, JSON.stringify(oldErrs));
A.ok('...naming the unknown argument', oldErrs.some(function (e) { return /Unknown argument "workOrderId"/.test(e); }), JSON.stringify(oldErrs));
A.ok('...and the two fields that do not exist on WorkOrderTrip',
  oldErrs.filter(function (e) { return /Cannot query field/.test(e); }).length === 2, JSON.stringify(oldErrs));

// ---- Section 2: isolation + logging, with gql stubbed ------------------------
console.log('\n-- one read failing must not empty the other, and must be LOUD --');
function run(src, opts) {
  var warns = [];
  var sandbox = {
    console: { warn: function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); }, info: function () { } },
    Array: Array, Promise: Promise, Error: Error,
    gql: function (q) {
      var isWT = q.indexOf('workOrderTrips(') !== -1;
      if (isWT && opts.failWT) return Promise.reject(new Error('boom-wt'));
      if (!isWT && opts.failPT) return Promise.reject(new Error('boom-pt'));
      if (isWT) return Promise.resolve({ workOrderTrips: { trips: opts.wtTrips || [] } });
      return Promise.resolve({ purchaseOrderTrips: opts.poGroups || [] });
    }
  };
  vm.createContext(sandbox);
  return vm.runInContext(
    '(async function (n, woId) {\n' + src + '\nreturn { trips: trips, poVendors: poVendors };\n})',
    sandbox, { filename: 'trips-block.js' })(375344, 1242526).then(function (r) { r.warns = warns; return r; });
}
var BOTH = {
  wtTrips: [{ onSiteDate: '2026-07-01', status: 'Complete' }],
  poGroups: [
    { vendorName: 'VENDOR A', trips: [{ onSiteDate: '2026-07-02', status: 'Scheduled' }] },
    { vendorName: 'VENDOR B', trips: [] }
  ]
};

function main() {
  return run(S_TRIPS, BOTH).then(function (r) {
    A.eq('trips come from BOTH reads', r.trips.length, 2);
    A.eq('vendor names come from the PO groups', r.poVendors, ['VENDOR A', 'VENDOR B']);
    A.eq('a clean read logs nothing', r.warns.length, 0);
    return run(S_TRIPS, { failWT: true, poGroups: BOTH.poGroups });
  }).then(function (r) {
    A.eq('a failed workOrderTrips read still yields the PO trips', r.trips.length, 1);
    A.eq('and still yields the PO vendors', r.poVendors.length, 2);
    A.eq('and says so, once', r.warns.length, 1);
    A.ok('naming the WO so it is traceable', /W-375344/.test(r.warns[0]), r.warns[0]);
    A.ok('and saying missing, not absent', /not absent/i.test(r.warns[0]), r.warns[0]);
    return run(S_TRIPS, { failPT: true, wtTrips: BOTH.wtTrips });
  }).then(function (r) {
    A.eq('a failed purchaseOrderTrips read still yields the WO trips', r.trips.length, 1);
    A.eq('and warns once', r.warns.length, 1);
    return run(S_TRIPS, { failWT: true, failPT: true });
  }).then(function (r) {
    A.eq('both failing yields empty', r.trips.length, 0);
    A.eq('with no vendors', r.poVendors.length, 0);
    A.eq('and TWO warnings - never a silent empty', r.warns.length, 2);
    return run(S_TRIPS, { wtTrips: [], poGroups: [] });
  }).then(function (r) {
    A.eq('a genuinely trip-less WO is empty', r.trips.length, 0);
    A.eq('and silent - silence now means "no trips", not "broken"', r.warns.length, 0);

    console.log('\n-- negative controls: each must turn the cases above red --');
    var MUT = [
      { what: 'the dead workOrderId argument coming back',
        f: function (s) { return mutate(s, "workOrderTrips(jobId:$id)", "workOrderTrips(workOrderId:$id)"); } },
      { what: 'purchaseOrderTrips nested back inside WorkOrderTrip',
        f: function (s) { return mutate(s, "var PT_Q = 'query($id:Int!){ purchaseOrderTrips(jobId:$id)", "var PT_Q = 'query($id:Int!){ workOrderTrips(jobId:$id){ purchaseOrderTrips"); } },
      { what: 'the WO number passed where the internal id belongs',
        f: function (s) { return mutate(s, 'try { wtr = await gql(WT_Q, { id: woId }); }', 'try { wtr = await gql(WT_Q, { id: n }); }'); } },
      { what: 'a failed read going silent again',
        f: function (s) { return mutate(s, "catch (e) { console.warn('[BWN SUITE AI] workOrderTrips read FAILED", "catch (e) { void ('[BWN SUITE AI] workOrderTrips read FAILED"); } },
      // The two reads must stay INDEPENDENT. This re-couples them the way the original
      // single-query block was coupled: lose the first, lose everything.
      // (An earlier version of this control cleared poVendors before the PO loop had
      // filled it - a no-op that reported itself as proving nothing. Kept as a reminder
      // that a control must be checked for firing, not assumed to.)
      { what: 'the two reads re-coupled, so one failing loses both',
        f: function (s) { return mutate(s, 'try { ptr = await gql(PT_Q, { id: woId }); }', 'try { if (wtr) ptr = await gql(PT_Q, { id: woId }); }'); } }
    ];
    return MUT.reduce(function (chain, m) {
      return chain.then(function () {
        var src;
        try { src = m.f(S_TRIPS); } catch (e) { A.ok('CAUGHT: ' + m.what, false, 'mutation could not be applied: ' + e.message); return; }
        var before = A.counts().fail;
        // re-run the two cases that matter for each mutation, cheaply: a clean read and a WT failure
        return run(src, BOTH).then(function (a) {
          return run(src, { failWT: true, poGroups: BOTH.poGroups }).then(function (b) {
            var stillGood =
              a.trips.length === 2 && a.poVendors.length === 2 && a.warns.length === 0 &&
              b.trips.length === 1 && b.poVendors.length === 2 && b.warns.length === 1 &&
              validate((src.match(/var WT_Q = '([^']+)'/) || [])[1] || '').length === 0 &&
              validate((src.match(/var PT_Q = '([^']+)'/) || [])[1] || '').length === 0 &&
              /\{ id: woId \}/.test(src) && !/\{ id: n \}/.test(src);
            A.ok('CAUGHT: ' + m.what, !stillGood, 'mutation produced NO observable failure - this control proves nothing');
            void before;
          }, function () { A.ok('CAUGHT: ' + m.what, true); });
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
