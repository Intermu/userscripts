// test-dispatch-gql-errors.js - node harness for bwn-dispatch's GraphQL error reader.
//
// THE CHANGE, as found in source (0.12.3, 2026-09-18):
//   A live ECD dispatch failed with "Work order NOT updated: GraphQL error. No card was sent." -
//   contentless, because gql() read `errors[0].message` and nothing else. Umbrava answers with
//   THREE envelopes and only the first is standard GraphQL:
//     GraphQL      { errors: [ { message: "..." } ] }
//     ASP.NET 400  { errors: { Field: ["The Field field is required."] } }   <- OBJECT, no .length
//     bare strings { errors: [ "..." ] }
//   The ASP.NET form was already a documented trap ([[umbrava-graphql-operations]], listClientRates
//   sortBy) and is the worst case: `.length` is undefined, so the OLD guard never threw at all and
//   gql resolved undefined - the failure then surfaced as bwnGqlOp's generic "unrecognized write
//   response" rather than the field the server rejected.
//
// WHAT THIS PROVES, against the REAL shipped bytes (gqlErrText is sliced out of
// bwn-dispatch.user.js and run in a vm - nothing below is a restatement of a stub):
//   - all three envelopes produce non-empty operator-readable text;
//   - a clean response and an empty errors array produce null (no false failure);
//   - the text is capped so a server string cannot flood the modal.
//
// WHAT IT DOES NOT PROVE:
//   - which envelope the live patchWorkOrder refusal actually used. That needs one live dispatch
//     with the Network tab open, or this build in front of the operator.
//
// Each control mutates the SAME source and MUST turn this harness red; mutate() throws if its
// target is absent or not unique, so a control that silently no-ops cannot pass.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dispatch-gql-errors.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-dispatch.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var START = '  function gqlErrText(j) {';
var END = '  function gql(query, variables) {';

function slice(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error('START marker not found - gqlErrText is gone from bwn-dispatch.user.js');
  if (src.indexOf(START, a + 1) !== -1) throw new Error('START marker not unique');
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error('END marker not found after start');
  return src.slice(a, b);
}
var S = slice(full);

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function load(src) {
  var sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

var M = load(S);

// ---- The three envelopes ------------------------------------------------
A.eq('GraphQL envelope reports the message',
  M.gqlErrText({ errors: [{ message: 'The current user is not authorized.' }] }),
  'The current user is not authorized.');

A.eq('ASP.NET 400 object envelope reports field + reason',
  M.gqlErrText({ errors: { Priority: ['The Priority field is required.'] } }),
  'Priority: The Priority field is required.');

A.eq('bare-string envelope is reported verbatim',
  M.gqlErrText({ errors: ['boom'] }),
  'boom');

// Multi-entry: every reason survives, so a rejection naming two fields is not half-reported.
A.eq('multiple GraphQL errors are joined',
  M.gqlErrText({ errors: [{ message: 'a' }, { message: 'b' }] }),
  'a; b');

A.eq('multiple ASP.NET fields are joined',
  M.gqlErrText({ errors: { A: ['one'], B: ['two', 'three'] } }),
  'A: one; B: two three');

// An error object with no `message` at all is what produced the contentless report. It must now
// carry SOMETHING an operator can forward, not an empty string.
A.ok('messageless error object still yields text',
  (M.gqlErrText({ errors: [{ extensions: { code: 'AUTH_NOT_AUTHORIZED' } }] }) || '').indexOf('AUTH_NOT_AUTHORIZED') !== -1);

// ---- No false failures ---------------------------------------------------
A.eq('clean response is not an error', M.gqlErrText({ data: { workOrder: {} } }), null);
A.eq('empty errors array is not an error', M.gqlErrText({ errors: [] }), null);
A.eq('null response is not an error', M.gqlErrText(null), null);

// ---- Cap ----------------------------------------------------------------
A.ok('long server text is capped at 300 chars',
  M.gqlErrText({ errors: [{ message: new Array(2000).join('x') }] }).length === 300);

// ---- Negative controls ---------------------------------------------------
function ctrl(name, from, to, run) {
  var mutated = load(mutate(S, from, to));
  var broke = false;
  try { if (!run(mutated)) broke = true; } catch (e) { broke = true; }
  A.ok('CONTROL breaks: ' + name, broke);
}

// The regression itself: drop the object branch and the ASP.NET 400 stringifies to "[object
// Object]" - still non-null, which is why this control asserts the READABLE text, not just truthiness.
ctrl('ASP.NET object envelope branch removed',
  "} else if (typeof e === 'object') {",
  '} else if (false) {',
  function (m) { return m.gqlErrText({ errors: { Priority: ['required'] } }) === 'Priority: required'; });

// The original bug: reading only .message drops the bare-string form.
ctrl('bare-string branch removed',
  "if (typeof x === 'string') return x;",
  'if (false) return x;',
  function (m) { return m.gqlErrText({ errors: ['boom'] }) === 'boom'; });

ctrl('messageless object no longer serialized',
  'try { return JSON.stringify(x); } catch (err) { return String(x); }',
  "return '';",
  function (m) { return (m.gqlErrText({ errors: [{ extensions: { code: 'AUTH_NOT_AUTHORIZED' } }] }) || '').indexOf('AUTH_NOT_AUTHORIZED') !== -1; });

ctrl('cap removed',
  'return out ? out.slice(0, 300) : null;',
  'return out ? out : null;',
  function (m) { return m.gqlErrText({ errors: [{ message: new Array(2000).join('x') }] }).length === 300; });

A.finish();
