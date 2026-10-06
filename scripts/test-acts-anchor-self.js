// test-acts-anchor-self.js - the NEXT ACTIONS card must never anchor to its OWN "OPEN TASKS" strip.
//
// WHAT WAS BROKEN (Core 1.90.0, seen live on a peer's machine): the card carries a read-only
// "OPEN TASKS (n)" strip when the WO has open tasks. tasksAnchorBlock() scans the whole document
// for the first element whose text starts "Open Tasks" - our strip sits earlier in document order
// than Umbrava's section, so it won. renderActsInline then removed the old card and inserted the
// rebuilt one before the strip, i.e. INSIDE the detached old card. The card vanished, the next
// refresh found Umbrava's heading and put it back, and so on - about once a second. The notes
// pane above it (Umbrava gives notes whatever height is left) grew and shrank with it.
//
// THE FIX under test: tasksAnchorBlock skips any element inside #bwn-act-card.
// Slices sectionTxt + tasksAnchorBlock out of the real source and runs them on a tiny fake DOM.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var src = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8');
var start = src.indexOf('    function sectionTxt(');
var end = src.indexOf('    function actsAnchorBlock(');
A.ok('sliced sectionTxt..tasksAnchorBlock from Core', start > 0 && end > start);

// Minimal element: text, children, parent, contains, querySelectorAll('*') (descendants).
function el(tag, text, kids) {
  var n = { tagName: tag, id: '', _text: text || '', children: kids || [], parentElement: null };
  n.children.forEach(function (k) { k.parentElement = n; });
  Object.defineProperty(n, 'textContent', { get: function () { return n._text + n.children.map(function (k) { return k.textContent; }).join(''); } });
  n.descendants = function () { var out = []; n.children.forEach(function (k) { out.push(k); out = out.concat(k.descendants()); }); return out; };
  n.contains = function (x) { return x === n || n.descendants().indexOf(x) !== -1; };
  n.querySelectorAll = function () { return n.descendants(); };
  return n;
}

function build(withCard) {
  var notes = el('div', 'Alison Dean Vendor Edited 09/29/2026 COST BREAKDOWN');
  var strip = el('div', '', [el('div', 'OPEN TASKS (1)'), el('div', 'Call vendor · Created by: X')]);
  var card = el('div', '', [el('button', 'NEXT ACTIONS2 need attention'), strip]);
  card.id = 'bwn-act-card';
  var umbHead = el('h6', 'Open Tasks');
  var umbSection = el('div', '', [el('div', '', [umbHead, el('span', '1')]), el('div', 'Call vendor')]);
  var wrapper = el('div', '', withCard ? [notes, card, umbSection] : [notes, umbSection]);
  var body = el('body', '', [wrapper]);
  var document = {
    body: body,
    getElementById: function (id) { return body.descendants().filter(function (x) { return x.id === id; })[0] || null; },
    querySelectorAll: function () { return body.descendants(); }
  };
  return { document: document, card: card, strip: strip, umbSection: umbSection };
}

function run(dom) {
  var fn = new Function('document', 'ACT_CARD_ID', src.slice(start, end) + '\nreturn tasksAnchorBlock();');
  return fn(dom.document, 'bwn-act-card');
}

var noCard = build(false);
A.ok('no card mounted: anchors to Umbrava\'s Open Tasks section', run(noCard) === noCard.umbSection);

var withCard = build(true);
var got = run(withCard);
A.ok('card mounted with its own OPEN TASKS strip: still anchors to Umbrava\'s section', got === withCard.umbSection);
A.ok('never returns a node inside our own card', !withCard.card.contains(got));

A.finish();
