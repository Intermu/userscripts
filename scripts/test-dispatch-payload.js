// test-dispatch-payload.js - node harness for the two dispatch-card defects found on the first
// correctly-targeted Teams card (2026-08-03), and the first test bwn-dispatch.user.js has ever had.
//
// THE DEFECTS, both measured live, both predicted in wiki/dispatch-http-template.md on 07-27:
//   1. DEEP LINK. The flow builds `Tracking Link` from Tracking, but Tracking is the CLIENT's
//      tracking number wherever the WO has one - it only falls back to the WO number when it does
//      not, which is why it looked correct in July. Live card: /work-orders/1272451 on WO 383112.
//      The body carried no WO number at all, so the flow had nothing correct to link from.
//   2. LOCATION. The modal seeded Location from the bus, which carries the location DISPLAY NAME
//      ("Flying J PFJ 0722 (865) 531-7400"), and the live read's fallback used `locationName` too.
//      The flow's `Lookup site` keys on the bare site NUMBER, so every dispatch both rendered an
//      unreadable card line AND silently resolved no site address.
//
// THE FIX, as sliced from source: `payload.WONumber = woId` (the /work-orders/<n> URL segment,
// never typed); the pre-fill no longer seeds Location at all; `hydrateFromUmbrava` fills it from
// `wo.locationId`. The site name is rendered as a hint under the field instead of being sent.
//
// Drives the REAL shipped bytes: slices the FIELDS spec, the pre-fill object, the submit payload
// builder and hydrateFromUmbrava out of bwn-dispatch.user.js and runs them against stub inputs.
// Nothing here proves the modal RENDERS, and nothing here can prove the CARD is fixed - the flow
// still has to map WONumber into Tracking Link, which is a Power Automate edit. This pins the
// client's half of the contract only.
//
// Every mutation below reverts one piece in the sliced source and asserts THIS harness goes red.
// mutate() throws if its target string is absent or not unique, so a mutation cannot silently
// no-op (see wiki/negative-control-silent-noop.md).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dispatch-payload.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-dispatch.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(src, start, end, what) {
  var a = src.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (src.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = src.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return src.slice(a, b);
}
function mutate(src, from, to, what) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET NOT FOUND (' + what + '): ' + from);
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE (' + what + '): ' + from);
  return src.replace(from, to);
}

// ---- build a runnable context out of the shipped slices -----------------------------------
function build(src) {
  var S_FIELDS = slice(src, '  var FIELDS = [', '  var EMAIL_RE', 'FIELDS');
  var S_PRE = slice(src, '    var pre = {', '    // Suite drawer:', 'pre-fill');
  var S_PAYLOAD = slice(src, '      var payload = { actor:', '      var reenable = function ()', 'payload builder');
  var S_HYDRATE = slice(src, '  function hydrateFromUmbrava(woId, inputs, touched) {', '  // Prefill AssigneeEmail from the roster', 'hydrateFromUmbrava');
  var S_GUESS = slice(src, '  function guessEmail(name) {', '  function manageRoster()', 'guessEmail');
  var S_FILLEMAIL = slice(src, '  function fillEmailFor(inputs, touched, name) {', '  // ---- Shared launcher dock', 'fillEmailFor+markEmailGuess');

  var sandbox = {
    console: console,
    // stubs for what the slices reach outside themselves
    roster: {},
    rosterKey: function (n) { return String(n || '').trim().toLowerCase().replace(/\s+/g, ' '); },
    rosterLookup: function (n) { return sandbox.roster[sandbox.rosterKey(n)] || ''; },
    isPerson: function (n) { return !!n && !/^\s*team\b/i.test(n); },
    signedIn: { name: 'Mike Najarro', email: 'mnajarro@broadwaynational.com' },
    actor: function () { return sandbox.signedIn; },
    siteCoordinator: function () { return { then: function () {} }; },
    gqlResult: null,
    DISP_WO_Q: '(query text is not under test here)',
    gql: function () {
      var r = sandbox.gqlResult;
      return { then: function (ok) { ok(r); return { then: function () {} }; } };
    },
    EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    S_FIELDS + '\n' +
    // the pre-fill block reads busCoord/bus/woId from its enclosing scope in the real file
    'function buildPre(busCoord, bus, woId) {\n' + S_PRE + '\n  return pre;\n}\n' +
    // the payload block returns early on validation failure, so it is wrapped rather than reshaped
    'function buildPayload(me, inputs, msg, woId) {\n' + S_PAYLOAD + '\n  return payload;\n}\n' +
    S_GUESS + '\n' +
    S_FILLEMAIL + '\n' +
    S_HYDRATE + '\n',
    sandbox
  );
  return sandbox;
}

function inputsFor(vals) {
  var o = {};
  ['AssignedToName', 'AssigneeEmail', 'Tracking', 'Location', 'Priority'].forEach(function (k) {
    o[k] = { value: (vals && vals[k]) || '' };
  });
  return o;
}
var TYPED = {
  AssignedToName: 'Daniel Russell',
  AssigneeEmail: 'drussell@broadwaynational.com',
  Tracking: '1272451',
  Location: '343',
  Priority: 'P2',
};
var SITE_NAME = 'Flying J PFJ 0722 (865) 531-7400';

// ---- 1. the payload carries the WO number, and it is not Tracking -------------------------
function checkPayload(S, label) {
  var p = S.buildPayload({ email: 'me@broadwaynational.com' }, inputsFor(TYPED), { textContent: '' }, '383112');
  A.eq(label + ': WONumber is the WO number from the URL', p && p.WONumber, '383112');
  A.eq(label + ': Tracking is untouched and still the client tracking number', p && p.Tracking, '1272451');
  A.ok(label + ': WONumber and Tracking are DISTINCT values', !!p && p.WONumber !== p.Tracking,
    'both were ' + (p && p.WONumber));
  return p;
}
var S = build(full);
var p = checkPayload(S, 'payload');
A.eq('payload: the five typed fields still ride along', [p.AssignedToName, p.AssigneeEmail, p.Location, p.Priority],
  ['Daniel Russell', 'drussell@broadwaynational.com', '343', 'P2']);
A.ok('payload: actor is the signed-in user, not a field', p.actor === 'me@broadwaynational.com');

// a blank required field must still short-circuit BEFORE WONumber is attached
var bad = S.buildPayload({ email: 'me@broadwaynational.com' }, inputsFor({ AssignedToName: '', AssigneeEmail: 'a@b.co', Tracking: '1', Location: '2' }), { textContent: '' }, '383112');
A.eq('payload: a missing required field still refuses to build', bad, undefined);

// ---- 2. the pre-fill never seeds Location from the bus display name ------------------------
function checkPre(S, label) {
  var pre = S.buildPre('Daniel Russell', { tracking: '1272451', location: SITE_NAME }, '383112');
  A.eq(label + ': Location is NOT seeded from the bus display name', pre.Location, '');
  A.eq(label + ': Tracking is still seeded from the bus', pre.Tracking, '1272451');
  return pre;
}
checkPre(S, 'pre-fill');

// ---- 3. the live read fills Location from locationId, never locationName -------------------
function checkHydrate(S, label) {
  S.gqlResult = {
    workOrder: {
      trackingNumber: '1272451',
      locationId: 343,
      locationName: SITE_NAME,
      assignedToMemberName: 'Daniel Russell',
      priority: { label: 'P2' },
    },
  };
  var inputs = inputsFor({});
  S.hydrateFromUmbrava('383112', inputs, {});
  A.eq(label + ': Location is the site NUMBER', inputs.Location.value, '343');
  A.ok(label + ': the display name never reaches the field', inputs.Location.value.indexOf('Flying J') === -1,
    'got ' + inputs.Location.value);
  return inputs;
}
checkHydrate(S, 'hydrate');

// a value the coordinator typed is never overwritten by the live read
S.gqlResult = { workOrder: { locationId: 999, locationName: SITE_NAME } };
var typedIn = inputsFor({ Location: '402' });
S.hydrateFromUmbrava('383112', typedIn, { Location: true });
A.eq('hydrate: a typed Location wins over the live read', typedIn.Location.value, '402');

// ---- 4. the derived email SUGGESTION -------------------------------------------------------
// Last resort only, and flagged: Umbrava exposes no assignee email, so before this the field was
// blank for any coordinator the roster had never met. The pattern rests on two observed
// addresses, so a wrong-but-plausible guess is the failure mode that matters - these pin that it
// never outranks better evidence and never fires where it cannot know.
function checkGuess(S, label) {
  S.roster = {};
  S.signedIn = { name: 'Mike Najarro', email: 'mnajarro@broadwaynational.com' };
  A.eq(label + ': first initial + last name at the signed-in domain',
    S.guessEmail('Daniel Russell'), 'drussell@broadwaynational.com');
  A.eq(label + ': matches the signed-in user\'s own address shape',
    S.guessEmail('Mike Najarro'), 'mnajarro@broadwaynational.com');
  A.eq(label + ': a TEAM is never guessed at', S.guessEmail('Team J'), '');
  // "Team J" alone does NOT exercise the team guard - its last token is one character, so the
  // short-name rule refuses it either way. Control M5 caught that: dropping the guard left the
  // suite green. A named team is the fixture that actually reaches the guard, and without it
  // "Team Pilot" would have produced a plausible tpilot@ address for a mailbox that is not a
  // person. See wiki/negative-control-silent-noop.md.
  A.eq(label + ': a NAMED team is never guessed at either', S.guessEmail('Team Pilot'), '');
  A.eq(label + ': one token is not a name', S.guessEmail('Erick'), '');
  A.eq(label + ': punctuation is normalised, not passed through',
    S.guessEmail("Mary O'Brien-Smith"), 'mobriensmith@broadwaynational.com');
  A.eq(label + ': a middle name still keys off the LAST token',
    S.guessEmail('Mary Jo Smith'), 'msmith@broadwaynational.com');
  return true;
}
checkGuess(S, 'guess');

// fails closed when there is no signed-in address to take a domain from
S.signedIn = { name: '', email: '' };
A.eq('guess: no signed-in domain -> no guess at all', S.guessEmail('Daniel Russell'), '');
S.signedIn = { name: 'Mike Najarro', email: 'mnajarro@broadwaynational.com' };

function checkPrecedence(S, label) {
  S.roster = { 'daniel russell': 'daniel.russell@broadwaynational.com' };
  S.emailGuessEl = { textContent: '', style: {} };
  var inputs = inputsFor({});
  S.fillEmailFor(inputs, {}, 'Daniel Russell');
  A.eq(label + ': a roster hit BEATS the guess', inputs.AssigneeEmail.value, 'daniel.russell@broadwaynational.com');
  A.eq(label + ': and is not flagged as guessed', S.emailGuessEl.textContent, '');
  return inputs;
}
checkPrecedence(S, 'precedence');

function checkFlag(S, label) {
  S.roster = {};
  S.emailGuessEl = { textContent: '', style: {} };
  var inputs = inputsFor({});
  S.fillEmailFor(inputs, {}, 'Erick Sandoval');
  A.eq(label + ': an unknown coordinator gets the guess', inputs.AssigneeEmail.value, 'esandoval@broadwaynational.com');
  A.ok(label + ': and it is VISIBLY flagged as a guess', /check it before you send/i.test(S.emailGuessEl.textContent),
    'warning read: ' + JSON.stringify(S.emailGuessEl.textContent));
  return inputs;
}
checkFlag(S, 'flag');

// never overwrites what a human typed, and never re-fills a field that already has a value
S.roster = {};
S.emailGuessEl = { textContent: '', style: {} };
var typedEmail = inputsFor({ AssigneeEmail: 'someone.else@broadwaynational.com' });
S.fillEmailFor(typedEmail, { AssigneeEmail: true }, 'Daniel Russell');
A.eq('guess: a typed address is never overwritten', typedEmail.AssigneeEmail.value, 'someone.else@broadwaynational.com');
A.eq('guess: and no warning is raised over it', S.emailGuessEl.textContent, '');

// ---- negative controls: revert each fix, prove this harness reddens ------------------------
function redUnder(name, mutated, probe) {
  var before = A.counts().fail;
  var S2 = build(mutated);
  try { probe(S2, 'MUTANT ' + name); } catch (e) { console.log('  ok  - ' + name + ' threw: ' + e.message); return; }
  var after = A.counts().fail;
  console.log(after > before
    ? '  ---- control OK: ' + name + ' reddened ' + (after - before) + ' assertion(s)'
    : '  ---- CONTROL FAILED: ' + name + ' left the suite GREEN');
  if (after <= before) process.exitCode = 1;
}

// Snapshot the REAL-source result before the controls run, since the controls deliberately
// register failing assertions into the same counters.
var REAL = A.counts();

console.log('\nnegative controls (each reverts one fix; failures below are EXPECTED):');
redUnder('M1 hydrate falls back to locationName',
  mutate(full, "setIfEmpty('Location', wo.locationId);", "setIfEmpty('Location', wo.locationName);", 'M1'),
  checkHydrate);
redUnder('M2 pre-fill seeds Location from the bus again',
  mutate(full, "      Location: '',", "      Location: (bus && bus.location) ? String(bus.location).trim() : '',", 'M2'),
  checkPre);
redUnder('M3 payload drops WONumber',
  mutate(full, "      payload.WONumber = woId || '';", "", 'M3'),
  checkPayload);
redUnder('M4 payload sets WONumber from Tracking',
  mutate(full, "      payload.WONumber = woId || '';", "      payload.WONumber = payload.Tracking;", 'M4'),
  checkPayload);
redUnder('M5 guess drops the team guard',
  mutate(full, "    if (!isPerson(name)) return '';", "    if (false) return '';", 'M5'),
  checkGuess);
redUnder('M6 guess uses the whole first name, not the initial',
  mutate(full, "    return first.charAt(0) + last + '@' + dom;", "    return first + last + '@' + dom;", 'M6'),
  checkGuess);
redUnder('M7 guess outranks the roster',
  mutate(full, "    if (!em) { em = guessEmail(name); guessed = !!em; }",
    "    { em = guessEmail(name) || em; guessed = !!em; }", 'M7'),
  checkPrecedence);
redUnder('M8 the guess is filled but never flagged',
  mutate(full, "    if (em) { inputs.AssigneeEmail.value = em; markEmailGuess(guessed); }",
    "    if (em) { inputs.AssigneeEmail.value = em; }", 'M8'),
  checkFlag);

// The controls above deliberately register FAILING assertions, so report the REAL run only -
// in the same shape the other harnesses print, and fail the process if either half misbehaved.
var after = A.counts();
console.log('\n' + (REAL.cases - REAL.fail) + '/' + REAL.cases + ' assertions passed' +
  (REAL.fail ? (', ' + REAL.fail + ' FAILED') : '') +
  '  (plus ' + (after.fail - REAL.fail) + ' expected failures from the 8 negative controls)');
process.exit((REAL.fail || process.exitCode) ? 1 : 0);
