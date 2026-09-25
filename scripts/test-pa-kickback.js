// test-pa-kickback.js - Kickback reliability in bwn-proposal-actions.user.js (0.7.12).
// Slices the REAL PA-KICKBACK block (on-device AI helpers, proposal-context read, reason gate) plus the
// real kickbackNote template into a vm with an injected paGql and a fake LanguageModel, and pins:
//   - every AI draft uses its OWN session (a session keeps conversation history, so a reused one would
//     carry one proposal's scope into the next draft), disposed after use when destroy() exists,
//   - a FAILED proposal-context read is never shown to the AI (no draft, read-failure placeholder), while
//     a SUCCESSFUL read with an empty scope / no lines says so, and a field the server did not return
//     reads "not reported" - never the old "(none)",
//   - the reason gate: the Summary / Total block, the change-since-review line and the placeholders are
//     not a reason; any other line with a letter or digit is, whatever its wording.
// The Confirm wiring (paConfirmController refusing a kickback with no reason) is pinned in
// test-pa-multi-proposal.js, where the controller harness lives.
// Negative controls (mutate()) prove each assertion is load-bearing.
//
// Run with the Adobe-bundled node (system node is quarantined on this machine):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-pa-kickback.js
// CI runs: node scripts/test-pa-kickback.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var full = fs.readFileSync(path.join(__dirname, '..', 'bwn-proposal-actions.user.js'), 'utf8').replace(/\r\n/g, '\n');
function between(a0, b0) {
  var a = full.indexOf(a0); if (a === -1) throw new Error('missing marker ' + a0);
  if (full.indexOf(a0, a + 1) !== -1) throw new Error('marker not unique ' + a0);
  var b = full.indexOf(b0, a); if (b === -1) throw new Error('missing marker ' + b0);
  return full.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}
var KB = between('  // ===== PA-KICKBACK START', '  // ===== PA-KICKBACK END');
var NOTE = full.match(/^  function kickbackNote\(reason, total\) \{.*\}$/m);
if (!NOTE) throw new Error('kickbackNote template not found');
NOTE = NOTE[0];

// Fake Prompt API. Each session keeps its own history the way the real one does; `opts` shapes it.
function mkLM(opts) {
  opts = opts || {};
  var LM = {
    created: [], createCalls: 0,
    availability: function () { return opts.availability || 'available'; },
    create: function (cfg) {
      LM.createCalls++;
      if (opts.refuseSystem && cfg && cfg.initialPrompts) return Promise.reject(new Error('initialPrompts unsupported'));
      var s = {
        history: (cfg && cfg.initialPrompts ? cfg.initialPrompts.map(function (p) { return p.content; }) : []),
        destroyed: 0,
        prompt: function (t) {
          if (s.destroyed) return Promise.reject(new Error('session destroyed'));
          s.history.push(t);
          if (opts.fail) return Promise.reject(new Error('model error'));
          return Promise.resolve(opts.reply ? opts.reply(t, s) : 'Drafted reason.');
        }
      };
      if (!opts.noDestroy) s.destroy = function () { s.destroyed++; };
      LM.created.push(s);
      return Promise.resolve(s);
    }
  };
  return LM;
}
// handler(variables) -> data, or throws to make the read fail.
function load(src, LM, handler) {
  var calls = [];
  var box = {
    console: console,
    LanguageModel: LM || undefined,
    paGql: function (op, q, v) {
      calls.push({ op: op, q: q, v: v });
      try { return Promise.resolve(handler ? handler(v) : {}); } catch (e) { return Promise.reject(e); }
    }
  };
  vm.createContext(box);
  vm.runInContext(src + '\n' + NOTE, box);
  box.calls = calls;
  return box;
}
function ctxOk(scope, items) {
  return { ok: true, scope: scope, items: items, scopeReported: true, itemsReported: true };
}

(async function () {
  // ---- 1. one isolated session per draft ------------------------------------------------------
  var lm = mkLM();
  var b = load(KB, lm);
  var r1 = await b.draftKickbackReason(ctxOk('ALPHA scope: replace 9 canopy fixtures', '- Fixture x9'), '$3,282.50', '33.00%');
  var r2 = await b.draftKickbackReason(ctxOk('BETA scope: backflow install', '- RP assembly x1'), '$22,916.21', '16.19%');
  A.eq('each draft returns the model text', [r1, r2], ['Drafted reason.', 'Drafted reason.']);
  A.eq('two drafts -> two separate sessions', lm.created.length, 2);
  A.ok("the second draft's session never saw the first proposal", lm.created[1].history.join('\n').indexOf('ALPHA') === -1 && lm.created[1].history.join('\n').indexOf('BETA') !== -1);
  A.eq('each session is disposed after its draft', lm.created.map(function (s) { return s.destroyed; }), [1, 1]);

  var lmF = mkLM({ fail: true });
  var bF = load(KB, lmF);
  A.eq('a model error returns no draft (never throws)', await bF.draftKickbackReason(ctxOk('x', '- a x1'), '$1.00', '1%'), '');
  A.eq('the failed session is still disposed', lmF.created[0].destroyed, 1);

  var lmN = mkLM({ noDestroy: true });
  var bN = load(KB, lmN);
  await bN.draftKickbackReason(ctxOk('ALPHA', ''), '$1.00', '1%');
  var rN = await bN.draftKickbackReason(ctxOk('BETA', ''), '$1.00', '1%');
  A.ok('an API without destroy() still drafts, still one session per draft', rN === 'Drafted reason.' && lmN.created.length === 2 && lmN.created[1].history.join('\n').indexOf('ALPHA') === -1);

  var lmS = mkLM({ refuseSystem: true });
  var bS = load(KB, lmS);
  await bS.draftKickbackReason(ctxOk('ALPHA', ''), '$1.00', '1%');
  await bS.draftKickbackReason(ctxOk('BETA', ''), '$1.00', '1%');
  A.ok('initialPrompts refused: the fallback session gets the system text inline and is still per-draft',
    lmS.created.length === 2 && /internal operations reviewer/.test(lmS.created[1].history[0]) && lmS.created[1].history.join('\n').indexOf('ALPHA') === -1);

  // CONTROL: the old per-prompt session cache makes the second draft reuse (and see) the first.
  var KB_CACHE = mutate(mutate(KB,
    '  function aiSession(api, sys) {\n',
    '  var _C = null;\n  function aiSession(api, sys) {\n    if (_C) return Promise.resolve(_C);\n'),
    'try { s._bwnSystem = hasSystem; } catch (e) { } return s;',
    'try { s._bwnSystem = hasSystem; } catch (e) { } _C = s; return s;');
  KB_CACHE = mutate(KB_CACHE, '.then(function (t) { aiDispose(s); return t; }', '.then(function (t) { return t; }');
  var lmC = mkLM();
  var bC = load(KB_CACHE, lmC);
  await bC.draftKickbackReason(ctxOk('ALPHA', ''), '$1.00', '1%');
  await bC.draftKickbackReason(ctxOk('BETA', ''), '$1.00', '1%');
  A.ok('CONTROL: a cached session leaks the first proposal into the second draft', lmC.created.length === 1 && lmC.created[0].history.join('\n').indexOf('ALPHA') !== -1);

  // ---- 2. failed read vs successful read with empty fields ---------------------------------
  var lmR = mkLM({ reply: function (t) { return 'PROMPT<<' + t + '>>'; } });
  var bFail = load(KB, lmR, function () { throw new Error('HTTP 502'); });
  var pcFail = await bFail.readProposalContext(901);
  A.eq('network / GraphQL failure -> { ok:false }', pcFail, { ok: false });
  A.eq('failed read: no draft', await bFail.draftKickbackReason(pcFail, '$1.00', '1%'), '');
  A.eq('failed read: the AI is never asked', lmR.createCalls, 0);
  A.ok('failed read: the seed is the read-failure placeholder', /could not be read/.test(bFail.kickbackReasonSeed(pcFail, '')));

  var bNull = load(KB, lmR, function () { return { proposal: null }; });
  A.eq('no proposal returned -> { ok:false } (not an empty proposal)', await bNull.readProposalContext(901), { ok: false });

  var bEmpty = load(KB, lmR, function () { return { proposal: { scopeOfWork: '', proposalLineItems: [] } }; });
  var pcEmpty = await bEmpty.readProposalContext(901);
  A.eq('empty scope + no lines -> ok:true, both reported, empty values kept',
    pcEmpty, { ok: true, scope: '', items: '', scopeReported: true, itemsReported: true });
  var pEmpty = await bEmpty.draftKickbackReason(pcEmpty, '$1.00', '1%');
  A.ok('empty scope is told to the AI as a real finding', pEmpty.indexOf('(empty - the proposal has no scope text)') !== -1);
  A.ok('no lines is told to the AI as a real finding', pEmpty.indexOf('(no line items on the proposal)') !== -1);
  A.ok('empty read never says "not reported" or the old "(none)"', pEmpty.indexOf('(not reported)') === -1 && pEmpty.indexOf('(none)') === -1);

  var bAbsent = load(KB, lmR, function () { return { proposal: { scopeOfWork: null } }; });
  var pcAbsent = await bAbsent.readProposalContext(901);
  A.ok('fields the server did not return are flagged not reported', pcAbsent.ok === true && pcAbsent.scopeReported === false && pcAbsent.itemsReported === false);
  var pAbsent = await bAbsent.draftKickbackReason(pcAbsent, '$1.00', '1%');
  A.eq('not-reported fields read "(not reported)" to the AI', (pAbsent.match(/\(not reported\)/g) || []).length, 2);

  var bReal = load(KB, lmR, function () { return { proposal: { scopeOfWork: 'Replace nine fixtures', proposalLineItems: [{ item: 'LSI Canopy Fixtures', quantity: '0' }, { item: '', quantity: null }] } }; });
  var pReal = await bReal.draftKickbackReason(await bReal.readProposalContext(901), '$1,911.00', '-16.62%');
  A.ok('a real read passes scope and lines through', pReal.indexOf('Replace nine fixtures') !== -1 && pReal.indexOf('- LSI Canopy Fixtures x0') !== -1 && pReal.indexOf('- item x?') !== -1);

  var lmU = mkLM({ availability: 'unavailable' });
  var bU = load(KB, lmU);
  var dU = await bU.draftKickbackReason(ctxOk('scope', ''), '$1.00', '1%');
  A.ok('AI unavailable on a good read -> no draft, AI-unavailable placeholder', dU === '' && lmU.createCalls === 0 && /AI draft unavailable/.test(bU.kickbackReasonSeed(ctxOk('s', ''), dU)));
  A.eq('a real draft is used as the seed as-is', bU.kickbackReasonSeed(ctxOk('s', ''), 'Need photos.'), 'Need photos.');

  // CONTROL: the old catch (failure -> empty scope + items) hands the AI "nothing found".
  var KB_OLDCATCH = mutate(KB, '}, function () { return { ok: false }; });',
    "}, function () { return { ok: true, scope: '', items: '', scopeReported: true, itemsReported: true }; });");
  var lmO = mkLM({ reply: function (t) { return t; } });
  var bO = load(KB_OLDCATCH, lmO, function () { throw new Error('HTTP 502'); });
  var pO = await bO.draftKickbackReason(await bO.readProposalContext(901), '$1.00', '1%');
  A.ok('CONTROL: without the ok:false result a failed read is sent to the AI as an empty proposal', lmO.createCalls === 1 && pO.indexOf('(empty - the proposal has no scope text)') !== -1);

  // ---- 3. the reason gate -----------------------------------------------------------------
  var g = load(KB);
  var T = '$3,282.50';
  var DELTA = 'Changes since review opened: raised total $269.05, GP 8.1% -> 11.0%.';
  function gap(s) { return g.paKickbackReasonGap(s); }
  var blocked = {
    'empty': '',
    'whitespace only': '  \n\t ',
    'Summary/Total block only': g.kickbackNote('', T),
    'negative-total Summary block only': g.kickbackNote('', '$-310.00'),
    'change-since-review line + Summary block': DELTA + '\n\n' + g.kickbackNote('', T),
    'punctuation only': '- - ...\n\nSummary\nTotal\n' + T,
    'a lone dollar amount': '$450.00\n\nSummary\nTotal\n' + T
  };
  Object.keys(blocked).forEach(function (k) { A.ok('gate blocks: ' + k, gap(blocked[k]) !== '', 'got empty gap'); });
  A.ok('gate blocks: untouched AI-unavailable placeholder, with a replace-the-placeholder message',
    /Replace the placeholder/.test(gap(g.kickbackNote(g.kickbackReasonSeed(ctxOk('', ''), ''), T))));
  A.ok('gate blocks: untouched read-failure placeholder',
    /Replace the placeholder/.test(gap(DELTA + '\n\n' + g.kickbackNote(g.kickbackReasonSeed({ ok: false }, ''), T))));
  A.ok('gate blocks: reason typed onto the placeholder line (the instruction would be posted)',
    gap(g.kickbackNote(g.kickbackReasonSeed({ ok: false }, '') + ' Need photos', T)) !== '');

  var passes = {
    'plain reason': 'Need photos of the mixing valve.',
    'one word': 'no',
    'a WO reference': 'see WO-1328468',
    'symbols and prices in a sentence': 'Vendor $$ way off – redo',
    'an amount with words': '$450 too high',
    'non-English': '¿Fotos?',
    'non-Latin script': '写真が必要',
    'digits only reference': '1328468',
    'lower-case summary word used in a sentence': 'summary of trip 1 is missing'
  };
  Object.keys(passes).forEach(function (k) { A.eq('gate passes: ' + k, gap(g.kickbackNote(passes[k], T)), ''); });
  A.eq('gate passes: an AI draft kept as the seed', gap(DELTA + '\n\n' + g.kickbackNote('Margin is negative after the lift cost; confirm the rental rate.', T)), '');
  A.eq('gate passes: reason written BELOW the Summary block', gap(g.kickbackNote('', T) + '\nNeed part numbers for the valve.'), '');
  A.eq('gate passes: placeholder replaced by the reviewer', gap(g.kickbackNote('Need the trench map before this goes out.', T)), '');

  // CONTROL: counting any non-blank line as a reason lets the bare template through.
  var KB_ANY = mutate(KB, 'return !paIsMachineLine(l) && /[\\p{L}\\p{N}]/u.test(l);', 'return /\\S/.test(l);');
  var gA = load(KB_ANY);
  A.ok('CONTROL: without the machine-line strip the Summary block alone passes', gA.paKickbackReasonGap(g.kickbackNote('', T)) === '');
  // CONTROL: without the placeholder check the untouched placeholder would count as a reason.
  var KB_NOPH = mutate(KB, "if (lines.some(function (l) { return phHead.some(function (h) { return l.indexOf(h) !== -1; }); })) {", 'if (false) {');
  var gP = load(KB_NOPH);
  A.ok('CONTROL: without the placeholder check the untouched placeholder passes', gP.paKickbackReasonGap(g.kickbackNote(g.kickbackReasonSeed({ ok: false }, ''), T)) === '');

  // ---- source-level wiring ------------------------------------------------------------------
  A.ok('the kickback flow drafts from the context read result (not a flattened scope)', /draftKickbackReason\(pc, ctx\.total, ctx\.gpText\)/.test(full));
  A.ok('the kickback seed goes through kickbackReasonSeed', /kickbackNote\(kickbackReasonSeed\(pc, reason\), ctx\.total\)/.test(full));
  A.ok('no module-level AI session cache remains', !/_AI_SESSIONS/.test(full));

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
