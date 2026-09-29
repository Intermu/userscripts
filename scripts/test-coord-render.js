// test-coord-render.js - contract harness for the Coordinator Action Queue RENDER layer after the
// BWN Operations Design System pass (bwn-suite-core 1.89.0 / WO Assist 2.76). The pure queue
// layer has its own harnesses (test-coord-{classify,queue,waits}); this one pins the UI
// contracts that pass fixed, so a later edit cannot quietly walk them back:
//
//   1. SEMANTIC COLOUR. No white text on the amber fill (was ~2.9:1 at 10px); "Upcoming" and
//      "One-click" badges no longer wear green (green = confirmed only); the DO NOW box is amber
//      with work in it and green only when clear; focus rings in the card use --bwn-text-strong,
//      not the accent (#2ECC71 on white is ~2.1:1, under the 3:1 indicator floor).
//   2. SEMANTICS. The card header is a real <button aria-expanded> (was a div role=button); the
//      step label that scrolls the page is a real <button> and the "?" is its SIBLING (it used to
//      sit INSIDE a role=button - nested interactive controls); the "?" has an accessible name.
//   3. HONEST STATE. Mark waiting is an inline form of native <select>s - no prompt(), so a typo can
//      no longer silently become "vendor" / "2 days"; a missed nav target is announced instead of a
//      dead click; a classifier throw degrades to an unsorted list under a warning and the header
//      says "queue unavailable" (never a green "nothing needs attention").
//   4. FOCUS. Every rebuild restores focus by data-bwn-fk (the card is torn down on each change).
//   5. BEHAVIOUR. coordFmtDay and the Mark-waiting default party are run in a vm.
//   6. NEGATIVE CONTROLS. Each static probe is re-run against a mutated source that reintroduces
//      the old defect and must go red, so a green run means the probes bite.
//
// What this does NOT prove: pixels, real Tab order, or screen-reader output. Those were checked
// in a live browser against a fixture that runs the sliced render code (see the PR notes).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-coord-render.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var coreFull = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(src, start, end, what) {
  var a = src.indexOf(start);
  if (a === -1) throw new Error(what + ': START not found');
  if (src.indexOf(start, a + 1) !== -1) throw new Error(what + ': START not unique');
  var b = src.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END not found');
  return src.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// Static probes over one source text. Returns [{name, ok}].
function probes(src) {
  var css = slice(src, "    var WA_STYLE_ID = 'bwn-wa-style';", '    function waLine(', 'WA style');
  var render = slice(src, '    // ---- Coordinator Action Queue render helpers', '    // ---- ECD helper: propose', 'render layer');
  var rai = render.slice(render.indexOf('    function renderActsInline(state) {'));   // render ends where the ECD helper starts
  var waitForm = slice(render, '    function buildWaitForm(', '    // Full interactive action row.', 'buildWaitForm');
  var out = [];
  function p(name, cond) { out.push({ name: name, ok: !!cond }); }
  p('no white text on the amber fill in the card CSS', !/color:#fff;background:var\(--bwn-warn\)/.test(css));
  p('Upcoming badge is not accent green', !/u-upcoming\{background:var\(--bwn-accent\)/.test(css));
  p('One-click badge is not green', !/\.bwn-cq-badge\.fric\{[^}]*var\(--bwn-green\)/.test(css));
  p('DO NOW box is amber, green only when clear',
    /\.bwn-cq-donow\{[^}]*border-left:3px solid var\(--bwn-warn\)/.test(css) && /\.bwn-cq-donow\.is-clear\{[^}]*var\(--bwn-green\)/.test(css));
  p('card focus rings use --bwn-text-strong, not the accent',
    /\.bwn-actc-hd:focus-visible\{outline:2px solid var\(--bwn-text-strong\)/.test(css) &&
    /\.bwn-cq-sec-hd:focus-visible\{outline:2px solid var\(--bwn-text-strong\)/.test(css) &&
    !/\.bwn-cq-sec-hd:focus-visible\{[^}]*--bwn-accent/.test(css));
  p('row buttons meet the 32px target (scoped to the card)', /\.bwn-actc \.bwn-wa-btn\{min-height:32px;/.test(css));
  p('no inline 10px/3px button styles left in the row builders', render.indexOf("style.cssText = 'padding:3px 9px;font-size:10px;'") === -1);
  p('card header is a <button> with aria-expanded',
    /coordFk\(document\.createElement\('button'\), 'hd'\)/.test(rai) && /hd\.setAttribute\('aria-expanded'/.test(rai) && rai.indexOf("setAttribute('role', 'button')") === -1);
  p('nav label is a real button; "?" is a sibling with an accessible name',
    render.indexOf("nb.className = 'bwn-cq-nav'") !== -1 && render.indexOf("lbl.setAttribute('role', 'button')") === -1 &&
    render.indexOf("ht.setAttribute('aria-label', 'Explain this step: '") !== -1);
  p('Mark waiting uses no prompt() and writes via coordWaitSet from <select> values',
    waitForm.indexOf('prompt(') === -1 && /coordWaitSet\(a, state, f\.party, /.test(waitForm) && waitForm.indexOf("createElement('select')") !== -1 &&
    render.indexOf('function coordMarkWaiting') === -1);
  p('a missed nav target is announced, not a dead click', /if \(!actNavGo\(nav\)\) coordAnnounce\(/.test(render) && src.indexOf('if (!el) return false;   // best-effort by contract') !== -1);
  p('classifier throw degrades honestly (warning + "queue unavailable")',
    /try \{ q = buildCoordinatorQueue\(liveActs, state, C, now\); \} catch/.test(rai) && rai.indexOf("'queue unavailable'") !== -1 && rai.indexOf("'bwn-cq-warn'") !== -1);
  p('rebuild restores focus by data-bwn-fk', rai.indexOf('var fkGo = coordFocusNext || fkWas;') !== -1 && rai.indexOf(".closest('[data-bwn-fk]')") !== -1);
  p('wait-form state is part of the rebuild signature', rai.indexOf("(coordWaitForm[c.key] ? 1 : 0)") !== -1);
  return out;
}

// ---- 1-4: the shipped source passes every probe -------------------------------
var real = probes(coreFull);
real.forEach(function (r) { A.ok(r.name, r.ok); });

// ---- 5: behaviour, run in a vm --------------------------------------------------
var helpers = slice(coreFull, '    function coordFmtDay(ms)', '    function coordBtn(', 'coordFmtDay') +
  slice(coreFull, "    var COORD_WAIT_PARTIES = [", '    function buildWaitForm(', 'wait-form state');
var sb = { Date: Date, String: String };
vm.createContext(sb);
var H = vm.runInContext('(function(){' + helpers + '; return { coordFmtDay: coordFmtDay, coordWaitFormOpen: coordWaitFormOpen, coordWaitForm: coordWaitForm, coordWaitFormId: coordWaitFormId, DAYS: COORD_WAIT_DAYS }; })()', sb);
A.eq('coordFmtDay renders weekday + M/D (local)', H.coordFmtDay(new Date(2026, 8, 24, 15, 0).getTime()), 'Thu 9/24');
H.coordWaitFormOpen({ key: 'phase:proposal-sent', ownership: 'client' });
A.eq('Mark waiting defaults to the action owner when it is a known party', H.coordWaitForm['phase:proposal-sent'], { party: 'client', days: 2 });
H.coordWaitFormOpen({ key: 'ecd:past', ownership: 'coordinator' });
A.eq('Mark waiting defaults to vendor when the owner is the coordinator', H.coordWaitForm['ecd:past'], { party: 'vendor', days: 2 });
A.ok('every revisit option is a positive whole day', H.DAYS.length > 0 && H.DAYS.every(function (d) { return d > 0 && d === Math.floor(d); }));
A.ok('wait-form id is a safe DOM id', /^bwn-cq-wait-[\w-]+$/.test(H.coordWaitFormId({ key: 'pocost:ln001:ACME Electric' })));

// ---- 6: negative controls - reintroduce each old defect, the matching probe must go red
var MUT = [
  ['no white text on the amber fill in the card CSS', ".bwn-cq-badge.u-due{background:var(--bwn-warn-bg);color:var(--bwn-warn-fg);", ".bwn-cq-badge.u-due{color:#fff;background:var(--bwn-warn);"],
  ['Upcoming badge is not accent green', ".bwn-cq-badge.sched,", ".bwn-cq-badge.u-upcoming{background:var(--bwn-accent);}' + '.bwn-cq-badge.sched,"],
  ['card focus rings use --bwn-text-strong, not the accent', ".bwn-cq-sec-hd:focus-visible{outline:2px solid var(--bwn-text-strong)", ".bwn-cq-sec-hd:focus-visible{outline:2px solid var(--bwn-accent)"],
  ['no inline 10px/3px button styles left in the row builders', "var cp = coordBtn('Chase', 'ghost', fk + 'chase:' + a.key, a.text);", "var cp = coordBtn('Chase', 'ghost', fk + 'chase:' + a.key, a.text); cp.style.cssText = 'padding:3px 9px;font-size:10px;';"],
  ['card header is a <button> with aria-expanded', "hd.setAttribute('aria-expanded', collapsed ? 'false' : 'true');", "hd.setAttribute('role', 'button');"],
  ['Mark waiting uses no prompt() and writes via coordWaitSet from <select> values', "var until = Date.now() + f.days * 86400000;", "var until = Date.now() + parseInt(prompt('days'), 10) * 86400000;"],
  ['a missed nav target is announced, not a dead click', "if (!el) return false;   // best-effort by contract", "if (!el) return;   // best-effort by contract"],
  ['classifier throw degrades honestly (warning + "queue unavailable")', "'queue unavailable'", "'nothing needs attention'"],
  ['rebuild restores focus by data-bwn-fk', 'var fkGo = coordFocusNext || fkWas;', 'var fkGo = null;'],
  ['wait-form state is part of the rebuild signature', "(coordWaitForm[c.key] ? 1 : 0)", "0"]
];
MUT.forEach(function (m) {
  var res = probes(mutate(coreFull, m[1], m[2]));
  var hit = res.filter(function (r) { return r.name === m[0]; })[0];
  A.ok('negative control bites: ' + m[0], hit && !hit.ok);
});

A.finish();
