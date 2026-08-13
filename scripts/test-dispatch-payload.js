// test-dispatch-payload.js - node harness for the two dispatch-card defects found on the first
// correctly-targeted Teams card (2026-08-03), and the first test bwn-dispatch.user.js has ever had.
//
// THE DEFECTS, both measured live, both predicted in wiki/dispatch-http-template.md on 07-27:
//   1. DEEP LINK. The flow builds `Tracking Link` from Tracking, but Tracking is the CLIENT's
//      tracking number wherever the WO has one - it only falls back to the WO number when it does
//      not, which is why it looked correct in July. Live card: /work-orders/1272451 on WO 383112.
//      The body carried no WO number at all, so the flow had nothing correct to link from.
//   1b. THE FALLBACK FIRED WHEN IT SHOULD NOT HAVE (found 2026-08-03 evening, third defect of
//      the same shape as 2). "Only when the WO has no tracking number" was never true: the
//      fallback keyed off the BUS, not off the WO. Queue row 466 went out as Tracking 383441
//      while Umbrava holds trackingNumber 1273641 for W-383441 - and because the fallback filled
//      the field synchronously, the live read's `setIfEmpty` could never correct it. Every one of
//      100 sampled Pending Dispatch WOs has a distinct tracking number, so the "no tracking
//      number" case the fallback was written for is rare-to-absent on this tenant.
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
  // Ends at the direct-write section added in 0.10.0 (patchWorkOrder status/assign/ECD, covered by
  // test-dispatch-patch.js): the payload builder proper is everything up to `payload.WONumber`, so the
  // slice stops at that section's banner rather than at `var reenable`, which now sits past the writes.
  var S_PAYLOAD = slice(src, '      var payload = { actor:', '      // ---- Direct record writes (patchWorkOrder) selected by the operator ----', 'payload builder');
  var S_HYDRATE = slice(src, '  function hydrateFromUmbrava(woId, inputs, touched) {', '  // Prefill AssigneeEmail from the roster', 'hydrateFromUmbrava');
  var S_SITENUM = slice(src, '  function siteNumberOf(locNum) {', '  // The person who had the last', 'siteNumberOf');
  var S_GUESS = slice(src, '  function guessEmail(name) {', '  function manageRoster()', 'guessEmail');
  var S_FILLEMAIL = slice(src, '  function fillEmailFor(inputs, touched, name, reresolve) {', '  // ---- Shared launcher dock', 'fillEmailFor+markEmailGuess');

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
    gqlFail: false,          // drive hydrate's rejection handler, not just its success path
    gqlUser: null,           // the second read: the assignee GUID -> person
    gqlUserFail: false,
    DISP_WO_Q: '(query text is not under test here)',
    USER_Q: '(query text is not under test here)',
    // Routed by the VARIABLES, not the query text, so the stub does not depend on constants that
    // live outside the sliced regions: {n} is the WO read, {id} is the user read.
    gql: function (q, v) {
      var isUser = !!(v && Object.prototype.hasOwnProperty.call(v, 'id'));
      var r = isUser ? sandbox.gqlUser : sandbox.gqlResult;
      var fail = isUser ? sandbox.gqlUserFail : sandbox.gqlFail;
      return {
        then: function (ok, err) {
          if (fail) { if (err) err(new Error('stub: GraphQL unavailable')); }
          else { ok(r); }
          return { then: function () {} };
        }
      };
    },
    // 0.10.0: hydrate now ALSO populates the direct-write controls (status/user pickers + auto ECD).
    // Those are covered by test-dispatch-patch.js; stub them to no-ops here so this harness keeps
    // testing hydrate's Location / Tracking / assignee behaviour, which is unchanged. ecdEl is null so
    // hydrate's `if (ecdEl)` guard is a safe no-op; the picker fetches return a thenable that ignores
    // its callback.
    fetchStatuses: function () { return { then: function () { return { then: function () {} }; } }; },
    fetchUsers: function () { return { then: function () { return { then: function () {} }; } }; },
    fillStatusOptions: function () {},
    fillAssigneeOptions: function () {},
    showEcd: function () {},
    ecdEl: null,
    EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    S_FIELDS + '\n' +
    // the pre-fill block reads busCoord/bus/woId from its enclosing scope in the real file
    'function buildPre(busCoord, bus, woId) {\n' + S_PRE + '\n  return pre;\n}\n' +
    // the payload block returns early on validation failure, so it is wrapped rather than reshaped
    'function buildPayload(me, inputs, msg, woId) {\n' + S_PAYLOAD + '\n  return payload;\n}\n' +
    S_SITENUM + '\n' +
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

// ---- 2b. the pre-fill no longer stamps the WO number into Tracking -------------------------
// The row-466 defect (2026-08-03). The bus value is a scrape of the header's tracking-number
// element; when the bus entry is missing or stale the field used to be filled with the WO number
// on the spot, which made the live read's `setIfEmpty` a no-op forever after. Measured live:
// W-383441 dispatched as Tracking 383441 when its real client tracking number is 1273641.
// Blank here is correct - hydrate fills it, and only falls back to the WO number afterwards.
function checkPreNoBus(S, label) {
  var pre = S.buildPre('Daniel Russell', { location: SITE_NAME }, '383441');
  A.eq(label + ': no bus tracking -> Tracking is left EMPTY for the live read', pre.Tracking, '');
  A.ok(label + ': the WO number is not stamped into Tracking', pre.Tracking !== '383441',
    'got ' + pre.Tracking);
  var noBus = S.buildPre('', null, '383441');
  A.eq(label + ': no bus entry at all -> still empty', noBus.Tracking, '');
  return pre;
}
checkPreNoBus(S, 'pre-fill/no-bus');

// ---- 3. the live read fills Location with a derived site NUMBER ----------------------------
// Fixture shapes are the REAL ones, read off app.umbrava.com 2026-08-03 (W-383449 / W-383472):
// locationId is a GUID, locationNumber is "PFJ 1177"-shaped, assignedTo is a user GUID with no
// name on it. The previous fixture used `locationId: 343` - a number - which is what the code
// assumed and what the live schema contradicts; it passed for years of sessions because fixture
// and code were wrong the same way (wiki/green-harness-proves-nothing-alone.md).
var LOC_GUID = '771104ef-2ceb-4842-9ed4-08db006b1e34';
var USER_GUID = '980fa5bd-e655-4917-aad7-6d9cd49752e2';
function woFixture(over) {
  var wo = {
    trackingNumber: 1273696,
    locationId: LOC_GUID,
    locationNumber: 'PFJ 1177',
    locationName: 'Flying J',
    assignedTo: USER_GUID,
    priority: { label: 'P2 Next Day' },
  };
  for (var k in (over || {})) wo[k] = over[k];
  return { workOrder: wo };
}
function checkHydrate(S, label) {
  S.gqlFail = false; S.gqlUserFail = false;
  S.gqlResult = woFixture();
  S.gqlUser = { user: { firstName: 'Daniel', lastName: 'Russell', emailAddress: 'DRussell@broadwaynational.com', isInactive: false } };
  var inputs = inputsFor({});
  S.hydrateFromUmbrava('383449', inputs, {});
  A.eq(label + ': Location is the DERIVED bare site number', inputs.Location.value, '1177');
  A.ok(label + ': the location GUID never reaches the field', inputs.Location.value.indexOf('-') === -1,
    'got ' + inputs.Location.value);
  A.ok(label + ': neither does the display name', inputs.Location.value.indexOf('Flying J') === -1,
    'got ' + inputs.Location.value);
  A.eq(label + ': Priority comes from the live read', inputs.Priority.value, 'P2 Next Day');
  return inputs;
}
checkHydrate(S, 'hydrate');

// siteNumberOf is deliberately conservative: derive only when it is unambiguous, because a wrong
// key makes the flow's `Lookup site` miss SILENTLY while an empty required field cannot.
function checkSiteNumber(S, label) {
  A.eq(label + ': a prefixed, zero-padded Pilot site derives', S.siteNumberOf('PFJ 0674'), '674');
  A.eq(label + ': and an unpadded one', S.siteNumberOf('PFJ 1177'), '1177');
  A.eq(label + ': a bare numeric site passes through', S.siteNumberOf('7099'), '7099');
  A.eq(label + ': a long numeric site is not truncated', S.siteNumberOf('10000565'), '10000565');
  A.eq(label + ': an alphanumeric code does NOT derive', S.siteNumberOf('DFW6'), '');
  // The fixture that actually reaches the digits-only guard. Every other rejection above is
  // caught downstream by parseInt returning NaN, so control M20 (drop the regex) stayed GREEN
  // until this line existed - the mutation applied, the claim was right, and no fixture reached
  // the mutated branch. A code that STARTS with digits is the only shape that separates them:
  // parseInt('7099B') is 7099, so without the regex this half-derives into a plausible WRONG site
  // number - the silent `Lookup site` miss, reintroduced. See wiki/negative-control-silent-noop.md.
  A.eq(label + ': a code that STARTS with digits does not half-derive', S.siteNumberOf('7099B'), '');
  A.eq(label + ': nor does a suffixed Pilot-style code', S.siteNumberOf('PFJ 0674A'), '');
  A.eq(label + ': nor does a hyphenated one', S.siteNumberOf('IFM-JAX3'), '');
  A.eq(label + ': nor a trailing-word code', S.siteNumberOf('091 FM'), '');
  A.eq(label + ': the corporate pseudo-site yields nothing', S.siteNumberOf('PFJ 0000'), '');
  A.eq(label + ': N/A yields nothing', S.siteNumberOf('N/A'), '');
  A.eq(label + ': null and empty are safe', [S.siteNumberOf(null), S.siteNumberOf('')], ['', '']);
  return true;
}
checkSiteNumber(S, 'siteNumberOf');

// ---- 3c. the assignee GUID resolves to a person, and to their REAL address -----------------
function checkAssignee(S, label) {
  S.gqlFail = false; S.gqlUserFail = false;
  S.gqlResult = woFixture();
  S.gqlUser = { user: { firstName: 'Daniel', lastName: 'Russell', emailAddress: 'DRussell@broadwaynational.com', isInactive: false } };
  S.roster = {};
  S.emailGuessEl = { textContent: '', style: {} };
  var inputs = inputsFor({});
  S.hydrateFromUmbrava('383449', inputs, {});
  A.eq(label + ': the GUID resolves to a person name', inputs.AssignedToName.value, 'Daniel Russell');
  A.eq(label + ": and to Umbrava's own address for them", inputs.AssigneeEmail.value, 'DRussell@broadwaynational.com');
  A.eq(label + ': a record is not a guess, so nothing is flagged', S.emailGuessEl.textContent, '');
  return inputs;
}
checkAssignee(S, 'assignee');

// An inactive assignee still resolves, but says so - and never claims the address was guessed.
function checkInactiveAssignee(S, label) {
  S.gqlFail = false; S.gqlUserFail = false;
  S.gqlResult = woFixture();
  S.gqlUser = { user: { firstName: 'Erick', lastName: 'Nieves-Cruz', emailAddress: 'ENieves@broadwaynational.com', isInactive: true } };
  S.emailGuessEl = { textContent: '', style: {} };
  var inputs = inputsFor({});
  S.hydrateFromUmbrava('383449', inputs, {});
  A.eq(label + ': the address is still filled', inputs.AssigneeEmail.value, 'ENieves@broadwaynational.com');
  A.ok(label + ': and the INACTIVE state is announced', /inactive/i.test(S.emailGuessEl.textContent),
    'warning read: ' + JSON.stringify(S.emailGuessEl.textContent));
  A.ok(label + ': without claiming it was guessed', !/guessed/i.test(S.emailGuessEl.textContent),
    'warning read: ' + JSON.stringify(S.emailGuessEl.textContent));
  return inputs;
}
checkInactiveAssignee(S, 'assignee/inactive');

// The query text itself is asserted, because the defect was a FIELD NAME: one invalid selector
// 400s the whole document and every downstream fill dies silently.
function checkQuery(src, label) {
  var q = src.slice(src.indexOf('var DISP_WO_Q ='), src.indexOf('var USER_Q ='));
  A.ok(label + ': the WO query no longer asks for assignedToMemberName',
    q.indexOf('assignedToMemberName') === -1, 'the dead field is back in DISP_WO_Q');
  A.ok(label + ': it asks for the assignee GUID instead', /\bassignedTo\b/.test(q), 'assignedTo missing');
  A.ok(label + ': and for locationNumber, which the site number is derived from',
    q.indexOf('locationNumber') !== -1, 'locationNumber missing');
  A.ok(label + ': the roster selection dropped the dead field too',
    src.indexOf("var ROSTER_SEL = 'number assignedTo") !== -1, 'ROSTER_SEL still selects a dead field');
  A.ok(label + ': the user lookup passes ID! - ID alone is a type error',
    src.indexOf('query($id:ID!){ user(id:$id)') !== -1, 'USER_Q is not ID!');
  return true;
}
checkQuery(full, 'query');

// a value the coordinator typed is never overwritten by the live read
S.gqlResult = woFixture({ locationNumber: 'PFJ 0999' });
S.gqlUser = null;
var typedIn = inputsFor({ Location: '402' });
S.hydrateFromUmbrava('383449', typedIn, { Location: true });
A.eq('hydrate: a typed Location wins over the live read', typedIn.Location.value, '402');

// a name the coordinator typed is never overwritten by the resolved assignee either
S.gqlResult = woFixture();
S.gqlUser = { user: { firstName: 'Daniel', lastName: 'Russell', emailAddress: 'DRussell@broadwaynational.com', isInactive: false } };
var typedName = inputsFor({ AssignedToName: 'Someone Else' });
S.hydrateFromUmbrava('383449', typedName, { AssignedToName: true });
A.eq('hydrate: a typed coordinator wins over the resolved assignee', typedName.AssignedToName.value, 'Someone Else');
A.eq('hydrate: and their address is not filled in over it', typedName.AssigneeEmail.value, '');

// ---- 3b. Tracking: the WO record beats the header scrape ----------------------------------
// Real values from W-383441 (the row-466 card): the bus seeded 383441, Umbrava holds 1273641.
function checkTrackingLive(S, label) {
  S.gqlFail = false;
  S.gqlResult = { workOrder: { trackingNumber: 1273641, locationId: 674, locationName: SITE_NAME } };
  var stale = inputsFor({ Tracking: '383441' });     // what a missing/stale bus scrape leaves behind
  S.hydrateFromUmbrava('383441', stale, {});
  A.eq(label + ': the live read OVERWRITES a wrong bus seed', stale.Tracking.value, '1273641');
  var empty = inputsFor({});
  S.hydrateFromUmbrava('383441', empty, {});
  A.eq(label + ': and fills an empty field the same way', empty.Tracking.value, '1273641');
  A.ok(label + ': Tracking and the WO number are now DISTINCT', empty.Tracking.value !== '383441',
    'both read ' + empty.Tracking.value);
  return stale;
}
checkTrackingLive(S, 'hydrate/tracking');

// The fallback still exists - it just runs last. A WO with no client tracking number must still
// produce a value for this required field.
function checkTrackingFallback(S, label) {
  S.gqlFail = false;
  S.gqlResult = { workOrder: { trackingNumber: null, locationId: 674, locationName: SITE_NAME } };
  var inputs = inputsFor({});
  S.hydrateFromUmbrava('383441', inputs, {});
  A.eq(label + ': no client tracking number -> the WO number fills in', inputs.Tracking.value, '383441');
  return inputs;
}
checkTrackingFallback(S, 'hydrate/fallback');

// Losing GraphQL degrades to the old behaviour rather than blocking a required field.
function checkTrackingOffline(S, label) {
  S.gqlFail = true;
  S.gqlResult = null;
  var inputs = inputsFor({});
  S.hydrateFromUmbrava('383441', inputs, {});
  A.eq(label + ': GraphQL down -> the WO number still fills in', inputs.Tracking.value, '383441');
  var seeded = inputsFor({ Tracking: '1273641' });
  S.hydrateFromUmbrava('383441', seeded, {});
  A.eq(label + ': and a bus seed is left alone, not clobbered', seeded.Tracking.value, '1273641');
  S.gqlFail = false;
  return inputs;
}
checkTrackingOffline(S, 'hydrate/offline');

// a typed Tracking outranks both the live read and the fallback
S.gqlResult = { workOrder: { trackingNumber: 1273641, locationId: 674 } };
var typedTrk = inputsFor({ Tracking: '999' });
S.hydrateFromUmbrava('383441', typedTrk, { Tracking: true });
A.eq('hydrate: a typed Tracking wins over the live read', typedTrk.Tracking.value, '999');

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

// ---- 5. RE-RESOLVE on a coordinator name change --------------------------------------------
// Reported live 2026-08-03: the amber "check it before you send" line never appears. Cause: the
// modal pre-fills an address for the coordinator the WO is assigned to, and `fillEmailFor` then
// returned early on `inputs.AssigneeEmail.value.trim()` - so typing a DIFFERENT coordinator's
// name re-resolved nothing. The old address stayed under the new name, unflagged. Worse than a
// missing warning: it is the previous coordinator's mailbox attached to someone else's dispatch.
function checkReresolve(S, label) {
  S.roster = { 'daniel russell': 'drussell@broadwaynational.com' };
  S.emailGuessEl = { textContent: '', style: {} };
  // the modal opened on a WO assigned to Daniel, so his address is already sitting there
  var inputs = inputsFor({ AssignedToName: 'Daniel Russell', AssigneeEmail: 'drussell@broadwaynational.com' });
  // ...and the operator types a coordinator the roster has never met
  inputs.AssignedToName.value = 'Erick Sandoval';
  S.fillEmailFor(inputs, {}, 'Erick Sandoval', true);
  A.eq(label + ': the stale address is replaced, not kept', inputs.AssigneeEmail.value, 'esandoval@broadwaynational.com');
  A.ok(label + ': and the new one is VISIBLY flagged as a guess',
    /check it before you send/i.test(S.emailGuessEl.textContent),
    'warning read: ' + JSON.stringify(S.emailGuessEl.textContent));
  return inputs;
}
checkReresolve(S, 'reresolve');

// A human-typed address still wins, re-resolve or not - that is what `touched` is for.
function checkReresolveRespectsTyped(S, label) {
  S.roster = { 'erick sandoval': 'esandoval@broadwaynational.com' };
  S.emailGuessEl = { textContent: '', style: {} };
  var inputs = inputsFor({ AssignedToName: 'Erick Sandoval', AssigneeEmail: 'erick.sandoval@broadwaynational.com' });
  S.fillEmailFor(inputs, { AssigneeEmail: true }, 'Erick Sandoval', true);
  A.eq(label + ': a typed address survives a re-resolve', inputs.AssigneeEmail.value, 'erick.sandoval@broadwaynational.com');
  A.eq(label + ': and is not flagged', S.emailGuessEl.textContent, '');
  return inputs;
}
checkReresolveRespectsTyped(S, 'reresolve/typed');

// Without the flag, the old behaviour stands: an existing value is left alone. The initial
// prefill and the hydrate path both rely on that.
function checkNoReresolveByDefault(S, label) {
  S.roster = {};
  S.emailGuessEl = { textContent: '', style: {} };
  var inputs = inputsFor({ AssigneeEmail: 'drussell@broadwaynational.com' });
  S.fillEmailFor(inputs, {}, 'Erick Sandoval');
  A.eq(label + ': no flag means no overwrite', inputs.AssigneeEmail.value, 'drussell@broadwaynational.com');
  return inputs;
}
checkNoReresolveByDefault(S, 'reresolve/default');

// A re-resolve that cannot resolve anything leaves the field alone rather than blanking a
// required input mid-edit ("Dan" on the way to "Daniel Russell" resolves to nothing).
function checkReresolveUnresolvable(S, label) {
  S.roster = {};
  S.emailGuessEl = { textContent: '', style: {} };
  var inputs = inputsFor({ AssigneeEmail: 'drussell@broadwaynational.com' });
  S.fillEmailFor(inputs, {}, 'Dan', true);
  A.eq(label + ': a one-token name resolves nothing and clears nothing', inputs.AssigneeEmail.value, 'drussell@broadwaynational.com');
  return inputs;
}
checkReresolveUnresolvable(S, 'reresolve/partial');

// ORDER-of-events property, asserted against the source: `change` alone fires only on BLUR, and
// blur is usually the click on Dispatch - the warning would have appeared for milliseconds
// before the form submitted. The name handler must listen on `input` and pass the re-resolve
// flag; the debounce is what stops a half-typed name resolving to a plausible wrong address.
function checkNameHandler(src, label) {
  A.ok(label + ': the name field is watched on input, not just change',
    src.indexOf("inputs.AssignedToName.addEventListener('input'") !== -1, "no 'input' listener on the name field");
  A.ok(label + ': the name handler asks for a re-resolve',
    src.indexOf('fillEmailFor(inputs, touched, inputs.AssignedToName.value, true);') !== -1,
    'the name handler does not pass reresolve');
  A.ok(label + ': and it is debounced', src.indexOf('setTimeout(resolveEmailFromName, 400)') !== -1,
    'no debounce on the input handler');
  A.ok(label + ': change is kept as a paste/autofill backstop',
    src.indexOf("inputs.AssignedToName.addEventListener('change'") !== -1, "no 'change' backstop");
  return true;
}
checkNameHandler(full, 'name handler');

// ---- negative controls: revert each fix, prove this harness reddens ------------------------
// `useSource` hands the probe the mutated SOURCE TEXT instead of a built sandbox, for the
// assertions that are about where code sits rather than what it computes (the name handler's
// event and its re-resolve flag live in buildModal, which this harness never executes).
function redUnder(name, mutated, probe, useSource) {
  var before = A.counts().fail;
  var S2;
  try { S2 = useSource ? mutated : build(mutated); }
  catch (e) { console.log('  ok  - ' + name + ' threw at build: ' + e.message); return; }
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
// M1 used to revert the fill to `wo.locationId`. That string no longer exists, and mutate() threw
// rather than quietly matching nothing - the guard doing its job. Retargeted to the equivalent
// mistake against the current shape: derive the site number from the display NAME.
redUnder('M1 hydrate derives the site number from locationName',
  mutate(full, "setIfEmpty('Location', siteNumberOf(wo.locationNumber));", "setIfEmpty('Location', siteNumberOf(wo.locationName));", 'M1'),
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
redUnder('M9 pre-fill stamps the WO number into Tracking again',
  mutate(full, "      Tracking: (bus && bus.tracking) ? String(bus.tracking).trim() : '',",
    "      Tracking: (bus && bus.tracking) ? String(bus.tracking).trim() : (woId || ''),", 'M9'),
  checkPreNoBus);
redUnder('M10 hydrate goes back to fill-only-if-empty for Tracking',
  mutate(full, "      setTracking(wo.trackingNumber);", "      setIfEmpty('Tracking', wo.trackingNumber);", 'M10'),
  checkTrackingLive);
redUnder('M11 the fallback is dropped from the success path',
  mutate(full, "      setTracking(wo.trackingNumber);\n      trackingFallback();",
    "      setTracking(wo.trackingNumber);", 'M11'),
  checkTrackingFallback);
redUnder('M12 the fallback is dropped from the GraphQL failure path',
  mutate(full, "so it is not written. */\n      trackingFallback();",
    "so it is not written. */", 'M12'),
  checkTrackingOffline);
redUnder('M13 the value guard is restored unconditionally (the reported defect)',
  mutate(full, "    if (!reresolve && inputs.AssigneeEmail.value.trim()) return;",
    "    if (inputs.AssigneeEmail.value.trim()) return;", 'M13'),
  checkReresolve);
redUnder('M14 a typed address loses its protection',
  mutate(full, "    if (touched.AssigneeEmail) return;\n    if (!reresolve", "    if (false) return;\n    if (!reresolve", 'M14'),
  checkReresolveRespectsTyped);
redUnder('M15 re-resolve becomes the default, so the prefill path overwrites too',
  mutate(full, "    if (!reresolve && inputs.AssigneeEmail.value.trim()) return;",
    "    if (false && inputs.AssigneeEmail.value.trim()) return;", 'M15'),
  checkNoReresolveByDefault);
redUnder('M16 the name handler goes back to change-only',
  mutate(full, "    inputs.AssignedToName.addEventListener('input', function () {\n      if (nameTimer) clearTimeout(nameTimer);\n      nameTimer = setTimeout(resolveEmailFromName, 400);\n    });\n",
    "", 'M16'),
  checkNameHandler, true);
redUnder('M18 Location goes back to the raw locationId (a GUID)',
  mutate(full, "      setIfEmpty('Location', siteNumberOf(wo.locationNumber));",
    "      setIfEmpty('Location', wo.locationId);", 'M18'),
  checkHydrate);
redUnder('M19 the site number is sent unparsed, prefix and all',
  mutate(full, "    var tok = s.split(/\\s+/).pop();\n    if (!/^\\d+$/.test(tok)) return '';",
    "    var tok = s.split(/\\s+/).pop();\n    if (!/^\\d+$/.test(tok)) return s;", 'M19'),
  checkSiteNumber);
redUnder('M20 siteNumberOf drops the digits-only guard',
  mutate(full, "    if (!/^\\d+$/.test(tok)) return '';", "    if (false) return '';", 'M20'),
  checkSiteNumber);
redUnder('M21 setName ignores the address Umbrava supplied',
  mutate(full, "      if (email && !touched.AssigneeEmail) {", "      if (false) {", 'M21'),
  checkAssignee);
redUnder('M22 the inactive assignee is filled in silently',
  mutate(full, "        markEmailGuess(!!inactive, inactive ?", "        markEmailGuess(false, inactive ?", 'M22'),
  checkInactiveAssignee);
redUnder('M23 the dead field comes back into the WO query',
  mutate(full, 'assignedTo statusId statusName serviceLevelAgreementId', 'assignedToMemberName statusId statusName serviceLevelAgreementId', 'M23'),
  checkQuery, true);
redUnder('M24 the user lookup goes back to a nullable ID',
  mutate(full, "query($id:ID!){ user(id:$id)", "query($id:ID){ user(id:$id)", 'M24'),
  checkQuery, true);
redUnder('M17 the name handler stops asking for a re-resolve',
  mutate(full, "      fillEmailFor(inputs, touched, inputs.AssignedToName.value, true);",
    "      fillEmailFor(inputs, touched, inputs.AssignedToName.value);", 'M17'),
  checkNameHandler, true);

// The controls above deliberately register FAILING assertions, so report the REAL run only -
// in the same shape the other harnesses print, and fail the process if either half misbehaved.
var after = A.counts();
console.log('\n' + (REAL.cases - REAL.fail) + '/' + REAL.cases + ' assertions passed' +
  (REAL.fail ? (', ' + REAL.fail + ' FAILED') : '') +
  '  (plus ' + (after.fail - REAL.fail) + ' expected failures from the 24 negative controls)');
process.exit((REAL.fail || process.exitCode) ? 1 : 0);
