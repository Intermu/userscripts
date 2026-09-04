// test-drop-upload-response-ladder.js - node harness for the "needs a response" action note +
// the 15-minute prompt ladder in bwn-drop-upload.user.js.
//
// WHY THIS EXISTS - the toggle used to do one thing (open a tracked queue item). It now posts an
// Action note that @-mentions the WO's assignee and then CHASES them: a prompt every 15 minutes
// until they log a Client note, and after 5 unanswered prompts an Escalation note @-mentioning
// their supervisor and manager. Three things in there are silent when they break:
//   1. the @-mention wire format. The notify rides ENTIRELY inside contentHtml as a TipTap span
//      (captured live 2026-08-17, proven by bwn-low-gp); actionNoteEmails stays null. A span with
//      one attribute wrong posts a note that reads fine and notifies NOBODY.
//   2. "answered". The ladder stops on the next CLIENT-type note by the ASSIGNEE after it opened.
//      Loosen any of those three and the ladder closes itself on somebody else's internal note.
//   3. the escalation trigger. Off by one and the team is told a prompt early, or never.
// Plus the two-tab claim: both tabs run the ticker, and a claim taken AFTER the async read is two
// prompts for one interval.
//
// NOT jsdom (no npm on this machine - see the repo's other harnesses). Same proven pattern: slice
// the REAL shipped block out of the userscript and run it in a vm with stubbed transport, storage,
// clock and notifications. No client data anywhere in here.

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-drop-upload.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startNeedle, endNeedle, what) {
  var a = full.indexOf(startNeedle);
  if (a === -1) throw new Error('SLICE START ABSENT (' + what + '): ' + JSON.stringify(startNeedle.slice(0, 60)));
  var b = full.indexOf(endNeedle, a);
  if (b === -1) throw new Error('SLICE END ABSENT (' + what + '): ' + JSON.stringify(endNeedle.slice(0, 60)));
  return full.slice(a, b);
}

var BLOCK = slice('// ---- Action note: @-mention', 'var noteBox = null', 'action note + ladder');

// ---- The sandbox -----------------------------------------------------------
// Everything the block closes over that lives elsewhere in the script: the GraphQL transport, the
// note writers, the note-type resolver, the toast, storage, the clock and the Notification API.
function build(opts, blockSrc) {
  opts = opts || {};
  var store = Object.assign({ tenantId: '"11111111-2222-3333-4444-555555555555"' }, opts.storage || {});
  var state = {
    now: opts.now || 1000000000000,
    notes: opts.notes || [],
    users: opts.users || [],
    assignee: ('assignee' in opts) ? opts.assignee : { assignedTo: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', assignedToMemberName: 'Dana Coordinator' },
    posted: [], toasts: [], notified: [], ticker: null, gqlFail: opts.gqlFail || false
  };
  var ctx = {
    Promise: Promise, JSON: JSON, String: String, Number: Number, Math: Math, Object: Object, Date: Date,
    console: console,
    Date_: Date,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    window: {},                                    // no Notification -> the in-page toast floor
    setInterval: function (fn) { state.ticker = fn; return 1; },
    location: { href: 'https://app.umbrava.com/work-orders/371126' },
    toast: function (m) { state.toasts.push(String(m)); },
    noteTypeId: function (n) { return ({ Client: 55, Internal: 13, Vendor: 18, Action: 41, Escalation: 27 })[n]; },
    duGql: function (op) {
      if (state.gqlFail) return Promise.reject(new Error('boom'));
      if (op === 'BwnDuAssignee') return Promise.resolve({ listWorkOrdersPaginated: { items: state.assignee ? [state.assignee] : [] } });
      if (op === 'BwnDuUsers') return Promise.resolve({ users: state.users });
      if (op === 'BwnDuNotes') return Promise.resolve({ jobNotes: state.notes });
      return Promise.reject(new Error('unexpected op ' + op));
    },
    postNoteViaApi: function (text, type, wo) { state.posted.push({ text: text, html: null, type: type, wo: wo }); return Promise.resolve({ id: 1 }); },
    postNoteHtmlViaApi: function (text, html, type, wo) { state.posted.push({ text: text, html: html, type: type, wo: wo }); return Promise.resolve({ id: 1 }); }
  };
  // A controllable clock: the block calls Date.now() directly, so shadow just that.
  ctx.Date = function () { }; ctx.Date.now = function () { return state.now; }; ctx.Date.parse = Date.parse;
  vm.runInNewContext((blockSrc || BLOCK) + '\n;' + [
    'this.mentionNoteHtml=mentionNoteHtml', 'this.mentionNoteText=mentionNoteText', 'this.duTenant=duTenant',
    'this.escTeamFor=escTeamFor', 'this.escalationPeople=escalationPeople', 'this.answeredSince=answeredSince',
    'this.assigneeOf=assigneeOf', 'this.postActionNote=postActionNote', 'this.ladderTick=ladderTick',
    'this.ladderLoad=ladderLoad', 'this.ladderPut=ladderPut', 'this.LADDER_MAX=LADDER_MAX',
    'this.LADDER_EVERY=LADDER_EVERY', 'this.ACTION_MSG=ACTION_MSG'
  ].join(';') + ';', ctx);
  return { api: ctx, state: state, store: store };
}

// A drained microtask queue, so an assertion never races the promise chain it is checking.
function settle() { return new Promise(function (r) { setTimeout(r, 0); }); }

function run() {
  // ---- 1. The @-mention wire format ---------------------------------------
  console.log('# the @-mention span - the whole notify rides in contentHtml');
  var b = build();
  A.eq('tenantId is UNWRAPPED from its JSON quoting (a quoted GUID pings nobody)',
    b.api.duTenant(), '11111111-2222-3333-4444-555555555555');
  var html = b.api.mentionNoteHtml([{ name: 'Dana Coordinator', id: 'user-guid-1' }], 'please reply');
  A.ok('span carries data-type="mention"', /data-type="mention"/.test(html), html);
  A.ok('span carries the captured class', /class="rich-text-editor-mention"/.test(html), html);
  A.ok('data-id is the user GUID', /data-id="user-guid-1"/.test(html), html);
  A.ok('data-label is the display name', /data-label="Dana Coordinator"/.test(html), html);
  A.ok('data-tenant is the unwrapped tenant GUID', /data-tenant="11111111-2222-3333-4444-555555555555"/.test(html), html);
  A.ok('the visible text is @Name', />@Dana Coordinator<\/span>/.test(html), html);
  A.ok('the paragraph carries the captured inline style', /<p style="font-size: 14px; line-height: 1\.4">/.test(html), html);
  A.eq('plain content mirrors the wire', b.api.mentionNoteText([{ name: 'Dana Coordinator', id: 'x' }], 'please reply'),
    '@Dana Coordinator please reply');
  var two = b.api.mentionNoteHtml([{ name: 'Sam Sup', id: 's1' }, { name: 'Mo Mgr', id: 'm1' }], 'step in');
  A.eq('an escalation pings BOTH people (two spans)', (two.match(/data-type="mention"/g) || []).length, 2);
  var unresolved = b.api.mentionNoteHtml([{ name: 'Ghost Person', id: '' }], 'step in');
  A.ok('an unresolved name is NAMED but not spanned (no fake ping)',
    !/data-type="mention"/.test(unresolved) && /@Ghost Person/.test(unresolved), unresolved);
  A.ok('a hostile display name cannot inject markup',
    b.api.mentionNoteHtml([{ name: '<img src=x onerror=1>', id: 'i' }], 'x').indexOf('<img') === -1,
    b.api.mentionNoteHtml([{ name: '<img src=x onerror=1>', id: 'i' }], 'x'));

  // ---- 2. The escalation team ---------------------------------------------
  console.log('# the escalation team - localStorage, never a name baked into a pushed repo');
  var teams = JSON.stringify({
    'Dana Coordinator': { supervisor: 'Sam Sup', manager: 'Mo Mgr' },
    'Solo Coordinator': { manager: 'Mo Mgr' },
    '*': { supervisor: 'Default Sup' }
  });
  var users = [
    { id: 's-guid', firstName: 'Sam', lastName: 'Sup', emailAddress: 'sam@example.com' },
    { id: 'm-guid', firstName: 'Mo', lastName: 'Mgr', emailAddress: 'mo@example.com' }
  ];
  var t = build({ storage: { 'bwn:escTeams': teams }, users: users });
  A.eq('a listed coordinator resolves their own team', t.api.escTeamFor('Dana Coordinator'), { supervisor: 'Sam Sup', manager: 'Mo Mgr' });
  A.eq('an unlisted coordinator falls back to the "*" team', t.api.escTeamFor('Nobody At All'), { supervisor: 'Default Sup' });
  A.eq('no roster at all -> null (and the caller posts unaddressed, loudly)', build().api.escTeamFor('Dana Coordinator'), null);

  return t.api.escalationPeople('Dana Coordinator').then(function (ps) {
    A.eq('supervisor FIRST, then manager', ps.map(function (p) { return p.name; }), ['Sam Sup', 'Mo Mgr']);
    A.eq('both resolve to real user GUIDs', ps.map(function (p) { return p.id; }), ['s-guid', 'm-guid']);
    return t.api.escalationPeople('Solo Coordinator');
  }).then(function (ps) {
    A.eq('a team with ONLY a manager escalates to one person', ps.map(function (p) { return p.name; }), ['Mo Mgr']);
    var u = build({ storage: { 'bwn:escTeams': JSON.stringify({ '*': { manager: 'Typo Name' } }) }, users: users });
    return u.api.escalationPeople('anyone');
  }).then(function (ps) {
    A.eq('a name the roster does not know is still NAMED', ps.map(function (p) { return p.name; }), ['Typo Name']);
    A.eq('...with no id, so the note names them without a fake ping', ps[0].id, '');

    // ---- 3. "Answered" -----------------------------------------------------
    console.log('# answered = the next CLIENT note by the ASSIGNEE, after the ladder opened');
    var T0 = 1000000000000;
    var entry = { woNum: 371126, assigneeName: 'Dana Coordinator', startedAt: T0 };
    function withNotes(notes) { return build({ notes: notes }).api.answeredSince(entry); }
    var iso = function (ms) { return new Date(ms).toISOString(); };
    return withNotes([{ type: 55, createdDate: iso(T0 + 60000), createdBy: { firstName: 'Dana', lastName: 'Coordinator' } }])
      .then(function (r) {
        A.eq('a Client note by the assignee after the start -> answered', r, true);
        return withNotes([{ type: 13, createdDate: iso(T0 + 60000), createdBy: { firstName: 'Dana', lastName: 'Coordinator' } }]);
      }).then(function (r) {
        A.eq('an INTERNAL note by the assignee does NOT close it', r, false);
        return withNotes([{ type: 55, createdDate: iso(T0 + 60000), createdBy: { firstName: 'Someone', lastName: 'Else' } }]);
      }).then(function (r) {
        A.eq('a Client note by SOMEONE ELSE does not close it', r, false);
        return withNotes([{ type: 55, createdDate: iso(T0 - 60000), createdBy: { firstName: 'Dana', lastName: 'Coordinator' } }]);
      }).then(function (r) {
        A.eq('a Client note from BEFORE the ladder opened does not close it', r, false);
        return build({ notes: [], gqlFail: true }).api.answeredSince(entry);
      }).then(function (r) {
        A.eq('a FAILED notes read is not "answered" (silence must not close a chase)', r, false);
      });
  }).then(function () {
    // ---- 4. The action note --------------------------------------------------
    console.log('# the action note - posted, typed, and it arms the ladder');
    var a = build();
    return a.api.postActionNote(371126, { email: { subject: 'Store 305 - please advise' } }).then(function () {
      A.eq('one note posted', a.state.posted.length, 1);
      A.eq('typed Action', a.state.posted[0].type, 'Action');
      A.ok('it @-mentions the assignee by GUID',
        /data-id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"/.test(a.state.posted[0].html), a.state.posted[0].html);
      A.ok('the ask names the client email', /Store 305 - please advise/.test(a.state.posted[0].text), a.state.posted[0].text);
      var led = a.api.ladderLoad();
      A.eq('the ladder is armed with exactly one entry', led.length, 1);
      A.eq('...counting from zero prompts', led[0].count, 0);
      A.eq('...first prompt due in 15 minutes', led[0].nextAt - led[0].startedAt, a.api.LADDER_EVERY);

      var noAssignee = build({ assignee: null });
      return noAssignee.api.postActionNote(371126, null).then(function () {
        A.eq('an UNASSIGNED work order posts no action note', noAssignee.state.posted.length, 0);
        A.ok('...and says so rather than failing silently',
          /no assignee/i.test(noAssignee.state.toasts.join(' ')), JSON.stringify(noAssignee.state.toasts));
        A.eq('...and arms no ladder (nobody to chase)', noAssignee.api.ladderLoad().length, 0);
      });
    });
  }).then(function () {
    // ---- 5. The ladder, driven end to end -----------------------------------
    console.log('# the ladder - 5 prompts, then the supervisor and manager');
    var L = build({ storage: { 'bwn:escTeams': teams }, users: users, notes: [] });
    var T0 = L.state.now;
    L.api.ladderPut({
      id: 'L1', woNum: 371126,
      assigneeId: 'a-guid', assigneeName: 'Dana Coordinator', subject: 'Store 305',
      startedAt: T0, nextAt: T0 + L.api.LADDER_EVERY, count: 0
    });
    A.ok('the ticker is armed at load (a ladder nobody ticks is a ladder nobody climbs)', !!L.state.ticker, 'no interval registered');

    // Not yet due: a tick before the interval must do nothing at all.
    L.api.ladderTick();
    return settle().then(function () {
      A.eq('a tick BEFORE the 15 minutes prompts nobody', L.state.toasts.length, 0);
      A.eq('...and does not advance the count', L.api.ladderLoad()[0].count, 0);

      // Prompts 1..4: due, unanswered, no escalation yet.
      var chain = Promise.resolve();
      [1, 2, 3, 4].forEach(function (n) {
        chain = chain.then(function () {
          L.state.now = T0 + n * L.api.LADDER_EVERY;
          L.api.ladderTick();
          return settle().then(function () {
            var cur = L.api.ladderLoad()[0];
            A.eq('prompt ' + n + ' fired and counted', cur && cur.count, n);
            A.eq('prompt ' + n + ' told the person', L.state.toasts.length, n);
            A.eq('prompt ' + n + ' escalated to nobody', L.state.posted.length, 0);
          });
        });
      });
      return chain;
    }).then(function () {
      // The 5th unanswered prompt is the escalation, not a 5th nudge.
      L.state.now = T0 + 5 * L.api.LADDER_EVERY;
      L.api.ladderTick();
      return settle().then(settle).then(function () {
        A.ok('the 5th prompt still PROMPTS the person', /Prompt 5 of 5/.test(L.state.toasts[4]), L.state.toasts[4]);
        A.ok('...and warns them it is escalating now', /Escalating to your supervisor and manager/.test(L.state.toasts[4]), L.state.toasts[4]);
        A.eq('the 5th unanswered prompt escalates', L.state.posted.length, 1);
        A.eq('...as an Escalation note', L.state.posted[0].type, 'Escalation');
        A.ok('...@-mentioning the supervisor', /data-id="s-guid"/.test(L.state.posted[0].html), L.state.posted[0].html);
        A.ok('...and the manager', /data-id="m-guid"/.test(L.state.posted[0].html), L.state.posted[0].html);
        A.ok('...naming the assignee who did not answer', /Dana Coordinator/.test(L.state.posted[0].text), L.state.posted[0].text);
        A.eq('the ladder is closed after escalating (it does not nag forever)', L.api.ladderLoad().length, 0);
      });
    });
  }).then(function () {
    // Answering stops it, at any rung.
    console.log('# answering closes the ladder');
    var T0 = 1000000000000;
    var Ok = build({
      notes: [{ type: 55, createdDate: new Date(T0 + 60000).toISOString(), createdBy: { firstName: 'Dana', lastName: 'Coordinator' } }]
    });
    Ok.api.ladderPut({ id: 'L2', woNum: 371126, assigneeName: 'Dana Coordinator', startedAt: T0, nextAt: T0 + 1, count: 2 });
    Ok.state.now = T0 + 60 * 60000;
    Ok.api.ladderTick();
    return settle().then(function () {
      A.eq('an answered ladder is dropped', Ok.api.ladderLoad().length, 0);
      A.eq('...and nothing is escalated', Ok.state.posted.length, 0);
      A.ok('...and the chase is reported closed', /answered/i.test(Ok.state.toasts.join(' ')), JSON.stringify(Ok.state.toasts));
    });
  }).then(function () {
    // The two-tab claim. Both tabs run the ticker; the slot must be claimed BEFORE the async read.
    console.log('# two tabs, one interval - the claim is taken before the await');
    var T0 = 1000000000000;
    var C = build({ notes: [] });
    C.api.ladderPut({ id: 'L3', woNum: 371126, assigneeName: 'Dana Coordinator', startedAt: T0, nextAt: T0 + 1, count: 0 });
    C.state.now = T0 + 60000;
    C.api.ladderTick();
    A.eq('nextAt is pushed forward SYNCHRONOUSLY, before any read resolves',
      C.api.ladderLoad()[0].nextAt, C.state.now + C.api.LADDER_EVERY);
    C.api.ladderTick();                       // the second tab's tick, same instant
    return settle().then(settle).then(function () {
      A.eq('the second tick prompts nobody a second time', C.state.toasts.length, 1);
      A.eq('...and the count advanced exactly once', C.api.ladderLoad()[0].count, 1);
    });
  }).then(function () {
    // ---- Negative controls: prove these assertions can FAIL ------------------
    // Each control MUTATES the real block, re-runs it, and asserts the check above goes RED. A
    // control that only greps for a line is a no-op that reads green forever.
    console.log('# negative controls - the block is mutated and the checks must break');
    function mutate(name, find, replace) {
      if (BLOCK.indexOf(find) === -1) { A.ok('control "' + name + '" found its target line', false, 'PATTERN ABSENT - the control is a no-op: ' + find.slice(0, 60)); return null; }
      return BLOCK.split(find).join(replace);
    }
    var T0 = 1000000000000;
    var isoAt = function (ms) { return new Date(ms).toISOString(); };
    var entry = { woNum: 371126, assigneeName: 'Dana Coordinator', startedAt: T0 };

    var mNoType = mutate('drop the note-TYPE check',
      'if (clientType != null && Number(nt.type) !== Number(clientType)) continue;', '');
    var mNoWho = mutate('drop the author check',
      'if (!want || by === want) return true;', 'return true;');
    var mNoClaim = mutate('take the claim after the read', '      r.nextAt = now + LADDER_EVERY;\n', '');

    return build({ notes: [{ type: 13, createdDate: isoAt(T0 + 60000), createdBy: { firstName: 'Dana', lastName: 'Coordinator' } }] }, mNoType)
      .api.answeredSince(entry).then(function (r) {
        A.eq('CAUGHT: without the type check, an Internal note falsely closes the chase', r, true);
        return build({ notes: [{ type: 55, createdDate: isoAt(T0 + 60000), createdBy: { firstName: 'Someone', lastName: 'Else' } }] }, mNoWho)
          .api.answeredSince(entry);
      }).then(function (r) {
        A.eq('CAUGHT: without the author check, ANYONE\'s client note closes the chase', r, true);
        var C = build({ notes: [] }, mNoClaim);
        C.api.ladderPut({ id: 'L4', woNum: 371126, assigneeName: 'Dana Coordinator', startedAt: T0, nextAt: T0 + 1, count: 0 });
        C.state.now = T0 + 60000;
        C.api.ladderTick(); C.api.ladderTick();      // two tabs, same instant
        return settle().then(settle).then(function () {
          A.eq('CAUGHT: with the claim removed, two tabs prompt twice for one interval', C.state.toasts.length, 2);
        });
      }).then(function () {
        var mNoTenant = mutate('drop data-tenant from the span', ' data-tenant="\' + duEsc(tenantId) + \'"', '');
        var h = build({}, mNoTenant).api.mentionNoteHtml([{ name: 'Dana Coordinator', id: 'g' }], 'x');
        A.ok('CAUGHT: a span without data-tenant no longer matches the captured wire format',
          !/data-tenant=/.test(h), h);
      });
  });
}

run().then(function () { A.finish(); }, function (e) { console.error('THREW:', (e && e.stack) || e); process.exit(2); });
