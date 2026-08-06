// ==UserScript==
// @name         BWN Wide List (Broadway National)
// @namespace    broadwaynational.bwn
// @version      1.2.0
// @description  Runs Umbrava border to border instead of the app shell's centered 86% / 2048px column - Work Orders, Projects, Clients, Vendors, Invoices, Proposals, Analytics and the detail pages alike. The shell caps every page's content at `width:86%; max-width:2048px` and centres it with `justify-content:space-around`, so on a wide monitor a third of the screen is empty gutter while the tables inside scroll sideways. This script measures the page column - the tall, near-full-height block that is narrower than its own full-width parent - and stamps it so a width rule applies. It matches on measurement, never on a class name, so a JSS or styled-components rebuild cannot break it; it finds nothing and does nothing on a page that is already full width (Umbrava itself drops the cap below 1670px). v1.2.0 keeps a measured gutter clear on each side for the edge furniture that used to float in the dead space - Umbrava's right-hand drawer tab rail and the BWN launcher dock - and no longer widens one half of a two-column layout. Dialogs, overlays, toolbars and anything short are left alone. A Tampermonkey menu item toggles it, and the choice sticks.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  var VER = '1.2.0';
  var ATTR = 'data-bwn-wide';
  var STYLE_ID = 'bwn-wide-list-css';

  // Measured on the live board 2026-08-04 (innerWidth 3402): the shell's flex box
  // `.MuiBox-root.jss184.jss1` is full width with `justify-content:space-around`, and its
  // single child is capped by `.jss1 > * { width:86%; max-width:2048px }`. That leaves a
  // 677px gutter each side and squeezes the visible WO table to 2028px while the table
  // itself is 3539px wide. Widening the child takes the visible area to 3383px (+67%).
  // The app already does exactly this below 1670px (`width:100%; max-width:100%` in a media
  // query), so this is Umbrava's own narrow-screen rule applied at every width.
  //
  // The jss* class names are build-generated and WILL change on an Umbrava deploy, so
  // nothing below matches on them - the column is found by measurement instead. The shell
  // is shared by every route, so the same search covers the whole suite; the guards below
  // are what keep it off the things that are MEANT to be narrow.
  var MIN_GUTTER = 24;        // px of unused width before it counts as a gutter worth killing
  var MIN_WIDTH = 400;        // narrower than this is a control or a card, not the page column
  var MIN_HEIGHT_FRAC = 0.4;  // the page column is nearly viewport-tall; a toolbar is not
  var MIN_PARENT_FRAC = 0.9;  // only widen against a parent that already spans the viewport
  var MAX_DEPTH = 10;         // body -> column is 3 hops today; 10 is slack, not a search

  // ---- edge furniture (v1.2.0) ------------------------------------------------
  // Measured live 2026-08-04 on both the WO list and a WO detail page: nothing about
  // widening MOVES the viewport-anchored furniture, but it deletes the empty gutter the
  // furniture used to float in, so it lands on top of real content instead:
  //   - left  x0..32   `#bwn-dock-stack`, the BWN launcher pill, was over the Purchase
  //                    Orders card and the first column of every list row;
  //   - right 2801..2836 Umbrava's own collapsed right drawer - a `position:absolute` tab
  //                    rail at `left:-35px` inside a zero-width `position:fixed` strip -
  //                    was over the Notes column's row menus and the last table column.
  // So the fix is not to stop widening, it is to stop widening INTO the furniture: measure
  // what is parked against each edge and hold that much back. Measured, not hardcoded, so
  // the gutter is 0 on a page with no furniture and follows the dock if it changes size.
  var FURN_MAX_W = 160;       // wider than this is a panel or a nav bar, not edge furniture
  var FURN_MIN_H = 24;        // smaller than this is a badge, and cheap to sit under
  var FURN_EDGE_BAND = 6;     // px from the viewport edge before it counts as parked there
  var FURN_TOP_FRAC = 0.10;   // ignore furniture whose centre is in the top strip (nav)
  var FURN_BOT_FRAC = 0.85;   // ...or in the bottom corners (Help bubble, Views pill) -
  //                             a floating corner button over the last row is the price of
  //                             a floating corner button; a mid-height rail over the notes
  //                             is the regression this release fixes.
  var FURN_PAD = 8;           // breathing room between the content edge and the furniture
  var FURN_MAX_GUTTER = 160;  // never hand back more than this, whatever the measurement says
  var FURN_SCAN_DEPTH = 6;    // fixed frames live shallow; this is a bound, not a search
  var FURN_FRAME_BUDGET = 400; // nodes examined inside one fixed frame
  var FURN_MIN_VISIBLE = 0.5;  // a box mostly off-screen is parked content, not furniture

  console.info('[BWN WIDE LIST] v' + VER + ' - suite-wide: Umbrava runs full width (shell 86%/2048px cap neutralised by measurement, not by class name), edge furniture kept clear');

  // ---- persistence -----------------------------------------------------------
  function getOn() {
    try { return GM_getValue('bwn:wideList', true) !== false; } catch (e) { return true; }
  }
  function setOn(v) {
    try { GM_setValue('bwn:wideList', !!v); } catch (e) { /* storage denied - session only */ }
  }
  var enabled = getOn();

  // ---- the rules -------------------------------------------------------------
  // Applied through an attribute rather than inline styles so a React re-render that
  // rewrites the style attribute cannot silently undo it. Two values: `edge` is the
  // outermost column found on the page and carries the gutters; `fill` is a column nested
  // inside one that already has them, and must not inset a second time.
  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      ':root{--bwn-wide-l:0px;--bwn-wide-r:0px;}' +
      '[' + ATTR + '="edge"]{' +
        'width:calc(100% - var(--bwn-wide-l) - var(--bwn-wide-r)) !important;' +
        'max-width:calc(100% - var(--bwn-wide-l) - var(--bwn-wide-r)) !important;' +
        'margin-left:var(--bwn-wide-l) !important;margin-right:var(--bwn-wide-r) !important;}' +
      '[' + ATTR + '="fill"]{width:100% !important;max-width:100% !important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- target discovery ------------------------------------------------------
  // Element children that actually take part in the layout. Absolutely positioned and
  // fixed siblings are furniture, not columns, and must not make a sole child look shared.
  function laidOutChildren(el) {
    var out = [];
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.tagName === 'STYLE' || c.tagName === 'SCRIPT' || c.tagName === 'LINK') continue;
      var cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue;
      var r = c.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue;
      out.push(c);
    }
    return out;
  }

  // A centred content column is exactly: an element materially narrower than a parent that
  // itself spans the viewport. Everything else in the checks is a guard against widening
  // something that is deliberately narrow.
  function qualifies(el, parent) {
    var pw = parent.clientWidth;
    if (pw < window.innerWidth * MIN_PARENT_FRAC) return false;
    var r = el.getBoundingClientRect();
    if (r.width < MIN_WIDTH) return false;
    if (pw - r.width <= MIN_GUTTER) return false;          // already full width - no-op
    if (r.height < window.innerHeight * MIN_HEIGHT_FRAC) return false;
    var pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'absolute') return false;  // overlay, drawer, popper
    if (el.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) return false;
    // v1.2.0: the page column is its parent's ONLY laid-out child - that is what the shell
    // rule `.jss1 > *` describes. Without this, a WO detail page's left half (the WO form
    // beside the Notes column) reads as a capped column too: measured live, widening it
    // took the form from 1045px to 1900px and SHRANK the Notes column from 979px to 911px,
    // pushing its row menus under the drawer rail. A column with a sibling beside it is
    // sharing the row on purpose; leave the split alone and widen their container instead.
    if (laidOutChildren(parent).length !== 1) return false;
    return true;
  }

  // Descend only through blocks big enough to still CONTAIN the page column. That prunes
  // the walk to a handful of nodes, so this can run on every mutation without being felt.
  function findCappedColumns() {
    var out = [], stack = [[document.body, 0]];
    while (stack.length) {
      var frame = stack.pop(), el = frame[0], depth = frame[1];
      if (depth > MAX_DEPTH) continue;
      for (var i = 0; i < el.children.length; i++) {
        var child = el.children[i];
        if (child.nodeType !== 1 || child.tagName === 'STYLE' || child.tagName === 'SCRIPT') continue;
        var cr = child.getBoundingClientRect();
        if (cr.width < window.innerWidth * 0.5 || cr.height < window.innerHeight * MIN_HEIGHT_FRAC) continue;
        if (qualifies(child, el)) out.push(child);
        stack.push([child, depth + 1]);
      }
    }
    return out;
  }

  // ---- edge furniture measurement --------------------------------------------
  // Viewport-anchored furniture is a `position:fixed` frame plus whatever hangs off it -
  // Umbrava's drawer rail is an absolutely positioned child of a ZERO-WIDTH fixed strip, so
  // measuring the fixed elements alone finds nothing. Walk each fixed frame's subtree under
  // a hard node budget and take the boxes that are small, tall enough to matter, and parked
  // against an edge at a height where content actually lives.
  // BREADTH first, deliberately. Umbrava's rail is three hops inside its frame while the
  // frame's other branch is the collapsed drawer's whole panel; a depth-first walk spent the
  // node budget in that panel and never reached the rail - measured, the right gutter came
  // back 16px instead of 43px and the rail still covered the Notes column.
  function collectFurnBoxes(root, boxes) {
    var q = [root], i = 0;
    while (i < q.length && i < FURN_FRAME_BUDGET) {
      var el = q[i++];
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) boxes.push(r);
      for (var k = 0; k < el.children.length; k++) q.push(el.children[k]);
    }
  }

  function findFixedFrames() {
    var frames = [], stack = [[document.body, 0]];
    while (stack.length) {
      var f = stack.pop(), el = f[0], depth = f[1];
      if (depth > FURN_SCAN_DEPTH) continue;
      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i];
        if (c.tagName === 'STYLE' || c.tagName === 'SCRIPT' || c.tagName === 'LINK') continue;
        var cs = getComputedStyle(c);
        if (cs.display === 'none') continue;
        if (cs.position === 'fixed') {
          // A dialog or a modal backdrop is transient and is allowed to cover things.
          if (!c.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) frames.push(c);
          continue;                       // its subtree is scanned by collectFurnBoxes
        }
        stack.push([c, depth + 1]);
      }
    }
    return frames;
  }

  function measureGutters() {
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight;
    var boxes = [], frames = findFixedFrames();
    for (var i = 0; i < frames.length; i++) collectFurnBoxes(frames[i], boxes);
    var L = 0, R = 0;
    for (var j = 0; j < boxes.length; j++) {
      var r = boxes[j];
      if (r.width > FURN_MAX_W || r.height < FURN_MIN_H) continue;
      var cy = r.top + r.height / 2;
      if (cy < vh * FURN_TOP_FRAC || cy > vh * FURN_BOT_FRAC) continue;
      // A collapsed drawer parks its panel just off the right edge. Those boxes touch the
      // edge but are barely on screen, and counting them handed back a gutter sized to the
      // sliver rather than to the rail that is actually visible.
      var vis = (Math.min(vw, r.right) - Math.max(0, r.left)) / r.width;
      if (vis < FURN_MIN_VISIBLE) continue;
      if (r.left <= FURN_EDGE_BAND && r.right > 0) L = Math.max(L, r.right);
      if (r.right >= vw - FURN_EDGE_BAND && r.left < vw) R = Math.max(R, vw - r.left);
    }
    return {
      l: Math.min(L > 0 ? Math.ceil(L) + FURN_PAD : 0, FURN_MAX_GUTTER),
      r: Math.min(R > 0 ? Math.ceil(R) + FURN_PAD : 0, FURN_MAX_GUTTER)
    };
  }

  var lastGut = { l: -1, r: -1 };
  function setGutters(g) {
    if (g.l === lastGut.l && g.r === lastGut.r) return;
    lastGut = g;
    document.documentElement.style.setProperty('--bwn-wide-l', g.l + 'px');
    document.documentElement.style.setProperty('--bwn-wide-r', g.r + 'px');
  }

  function clear() {
    var marked = document.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(ATTR);
    setGutters({ l: 0, r: 0 });
  }

  function apply() {
    if (!enabled) { clear(); return; }
    var targets = findCappedColumns();
    // Gutters are measured BEFORE stamping so the furniture scan cannot see a column that
    // is mid-resize, and re-measured on the next tick anyway.
    setGutters(targets.length ? measureGutters() : { l: 0, r: 0 });
    var stale = document.querySelectorAll('[' + ATTR + ']');
    for (var s = 0; s < stale.length; s++) {
      if (targets.indexOf(stale[s]) === -1) stale[s].removeAttribute(ATTR);
    }
    for (var i = 0; i < targets.length; i++) {
      // Only the outermost column carries the gutters; a column nested inside one that is
      // already inset just fills it, or the page would be inset twice.
      var nested = false;
      for (var k = 0; k < targets.length; k++) {
        if (k !== i && targets[k].contains(targets[i])) { nested = true; break; }
      }
      targets[i].setAttribute(ATTR, nested ? 'fill' : 'edge');
    }
  }

  // ---- keep it applied across SPA renders ------------------------------------
  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; apply(); }, 150);
  }

  injectCSS();
  apply();

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  window.addEventListener('resize', schedule);

  // The SPA navigates without popstate, so the history methods get a passive tap. They are
  // called through to unchanged - this only adds a re-check afterwards.
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== 'function') return;
    history[m] = function () {
      var r = orig.apply(this, arguments);
      schedule();
      return r;
    };
  });

  // ---- toggle ----------------------------------------------------------------
  try {
    GM_registerMenuCommand('Wide layout: ' + (enabled ? 'ON (click to turn off)' : 'OFF (click to turn on)'), function () {
      enabled = !enabled;
      setOn(enabled);
      apply();
      alert('Wide layout is now ' + (enabled ? 'ON' : 'OFF') + '.\n\nThe menu label updates on the next page load.');
    });
  } catch (e) { /* no menu API - the default (ON) still applies */ }

  // Diagnostics for a live session: what it decided and why, without a rebuild.
  try {
    window.__bwnWide = function () {
      return {
        ver: VER, enabled: enabled, gutters: lastGut, measured: measureGutters(),
        marked: [].map.call(document.querySelectorAll('[' + ATTR + ']'), function (el) {
          var r = el.getBoundingClientRect();
          return { mode: el.getAttribute(ATTR), cls: String(el.className).slice(0, 40), x: Math.round(r.x), w: Math.round(r.width) };
        })
      };
    };
  } catch (e) { /* diagnostics are optional */ }
})();
