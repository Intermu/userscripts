// ==UserScript==
// @name         BWN AI Proposal Assist (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @description  Read-only helper around Umbrava's AI client-proposal generator. Three opt-in panels, all OFF until switched on: (1) Pre-flight on a vendor proposal's details page reads the line grid by header text and flags line shapes the AI cannot fix later - travel/labor not named "N Man Travel" / "N Man", one line covering several trips, a single lumped Material line, equipment or removal filed under Material/Other, missing $0 Shipping and Disposal, blank Trip #, numeric UOM, vendor total over the client NTE - with a recommended-lines table; (2) a prompt builder on the AI preview page that assembles the Generate prompt from form fields in a fixed order with a live 1,000-character hard stop, Copy and Insert buttons, and saved per-client templates; (3) a post-generate checker that passively reads the GenerateAIProposalPreview / ReworkAIProposal responses the app already receives and shows pass/fail (charge below cost, negative or >35% materials markup, travel quantity, non-rate-card ranges, total vs NTE, banned headings, verbatim lines, Materials/Equipment section) plus the server's validationErrors text when Generate fails. Never calls the API itself, never reads auth headers, never edits the grid, never clicks anything it did not create, never saves, submits or approves.
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-ai-proposal-assist.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-ai-proposal-assist.user.js
// @match        https://app.umbrava.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

// WHY @grant none + document-start: the checker has to see the SPA's own /api/graphql responses.
// With any GM_* grant Tampermonkey sandboxes the script and `window.fetch` is the sandbox's copy,
// so the app's calls go straight past the tap (bwn-kanban 0.3.0 shipped that bug). document-start
// puts the tap in place before the app can capture its own fetch reference. Persistence is
// therefore localStorage, which is fine: nothing stored here is a secret.
//
// READ-ONLY CONTRACT (pinned by scripts/test-ai-proposal-assist.js):
//   - the fetch/XHR taps only READ a clone of responses the app already asked for; the request is
//     passed through untouched and no header is ever read;
//   - the script issues no request of its own;
//   - the only write into the page is Insert, which fills the Generate prompt textarea on an
//     explicit click and never presses Generate.

(function () {
  'use strict';

  var VER = '0.1.0';   // keep in step with @version
  // Duplicate-init guard: @grant none shares the page window, so a second install (two copies, a
  // reinstall without reload) sees the first one's stamp and stands down instead of double-tapping.
  if (window.__bwnApaInit) { console.warn('[BWN APA] already initialised (v' + window.__bwnApaInit + ') - second copy inert'); return; }
  window.__bwnApaInit = VER;

  // ===== APA-LOGIC START (pure; sliced and run by scripts/test-ai-proposal-assist.js) =====
  var PROMPT_MAX = 1000;     // server limit on userPrompt; over it the UI shows only "Something went wrong"
  var PROMPT_WARN = 950;
  var MATERIAL_MARKUP_MAX = 35;
  var WATCH_OPS = { GenerateAIProposalPreview: 1, ReworkAIProposal: 1 };
  var RX_VP = /^\/work-orders\/[^/]+\/proposals\/vendor-proposals\/([^/]+)\/details\/?$/;
  var RX_AI = /^\/work-orders\/[^/]+\/proposals\/([^/]+)\/ai-preview\/?$/;
  // Deny-list first, allow-list second: anything account/admin/auth shaped is inert even if a
  // future route happened to match the allow patterns.
  var DENY = [/^\/(login|logout|callback|signup|account|settings|company|admin|billing|users?)(\/|$)/i, /permission/i];
  var NEEDED_HEADERS = ['category', 'item', 'trip #', 'uom', 'quantity', 'unit cost'];
  var DEFAULT_SCOPE_LINE = 'Pilot scope: plain technician text, no Problem/Solution/Work Summary headings.';

  function routeOf(path) {
    path = String(path || '');
    for (var i = 0; i < DENY.length; i++) if (DENY[i].test(path)) return null;
    var m = RX_VP.exec(path);
    if (m) return { kind: 'vp', quoteId: m[1] };
    m = RX_AI.exec(path);
    if (m) return { kind: 'ai', quoteId: m[1] };
    return null;
  }

  function esc(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // "$1,234.56" / "(12.00)" / "-$5" -> integer cents, or null.
  function moneyToCents(s) {
    if (s == null) return null;
    var t = String(s).trim(), neg = /^\(.*\)$/.test(t) || /^-/.test(t);
    var m = t.replace(/[,$\s()]/g, '').replace(/^-/, '').match(/^\d+(?:\.\d+)?$/);
    if (!m) return null;
    var c = Math.round(parseFloat(m[0]) * 100);
    return neg ? -c : c;
  }

  // GraphQL money: {amount, precision} is amount / 10^precision dollars; a bare number is cents.
  function gqlCents(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && typeof v.amount === 'number') {
      var p = typeof v.precision === 'number' ? v.precision : 2;
      return Math.round(v.amount * 100 / Math.pow(10, p));
    }
    return null;
  }

  function fmt(c) { return c == null ? '-' : (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2); }

  // headers: array of header strings in display order; cells: array of rows (arrays of strings).
  // Keyed by header TEXT, never by a fixed column index.
  function rowsFromGrid(headers, cells) {
    var idx = {};
    headers.forEach(function (h, i) { var k = norm(h).toLowerCase(); if (!(k in idx)) idx[k] = i; });
    for (var n = 0; n < NEEDED_HEADERS.length; n++) if (!(NEEDED_HEADERS[n] in idx)) return null;
    function get(r, k) { return k in idx ? norm(r[idx[k]]) : ''; }
    return cells.map(function (r) {
      return {
        category: get(r, 'category'), trade: get(r, 'trade'), item: get(r, 'item'),
        trip: get(r, 'trip #'), uom: get(r, 'uom'), qty: parseFloat(get(r, 'quantity').replace(/,/g, '')),
        unitCost: moneyToCents(get(r, 'unit cost')), totalCost: moneyToCents(get(r, 'total cost'))
      };
    }).filter(function (r) { return r.item || r.category; });
  }

  var RX_TRAVEL = /travel|trip charge|mileage/i;
  var RX_GENERIC_MAT = /^(materials?|parts?|supplies|misc\.?|miscellaneous)\b/i;
  var RX_EQUIP = /equipment|lift|rental|removal|remove|haul|demo/i;
  function isTravel(r) { return RX_TRAVEL.test(r.category) || RX_TRAVEL.test(r.item); }
  function isLabor(r) { return !isTravel(r) && (/labor|labour/i.test(r.category) || /\blabor\b|technician|\bhelper\b/i.test(r.item)); }
  function isMaterial(r) { return /material/i.test(r.category); }

  function distinctTrips(rows) {
    var s = {};
    rows.forEach(function (r) { if (/^\d+$/.test(r.trip)) s[r.trip] = 1; });
    return Object.keys(s).map(Number).sort(function (a, b) { return a - b; });
  }

  // -> [{level:'fail'|'warn'|'ok', msg}]
  function preflight(rows, nte, vendorTotal) {
    var out = [];
    function f(level, msg) { out.push({ level: level, msg: msg }); }
    var trips = distinctTrips(rows), nTrips = Math.max(trips.length, 1);
    var travel = rows.filter(isTravel), labor = rows.filter(isLabor);
    // Real materials only: equipment filed under Material and the $0 Shipping/Disposal lines do not count.
    var mats = rows.filter(function (r) { return isMaterial(r) && !RX_EQUIP.test(r.item) && !/shipping|disposal/i.test(r.item); });

    travel.forEach(function (r) {
      if (!/^\d+\s*man travel$/i.test(r.item)) f('fail', 'Travel line "' + r.item + '" is not named "N Man Travel".');
      if (r.qty > 1) f('warn', 'Travel line "' + r.item + '" has quantity ' + r.qty + ' - one line per trip.');
    });
    if (travel.length && travel.length < nTrips) f('fail', travel.length + ' travel line(s) cover ' + nTrips + ' trips - one travel line per trip.');

    labor.forEach(function (r) {
      if (!/^\d+\s*man$/i.test(r.item)) f('fail', 'Labor line "' + r.item + '" is not named "N Man".');
      if (!/^(hr|hrs|hour|hours)$/i.test(r.uom)) f('fail', 'Labor line "' + r.item + '" UOM is "' + r.uom + '", not per hour.');
    });
    if (labor.length && labor.length < nTrips) f('fail', labor.length + ' labor line(s) cover ' + nTrips + ' trips - one labor line per trip.');

    if (mats.length === 1 && (RX_GENERIC_MAT.test(mats[0].item) || /^(lot|ls|lump sum)$/i.test(mats[0].uom)))
      f('fail', 'Single lumped Material line "' + mats[0].item + '" - itemise each material.');

    rows.forEach(function (r) {
      if (/material|other/i.test(r.category) && RX_EQUIP.test(r.item))
        f('warn', '"' + r.item + '" is filed under ' + r.category + ' - equipment/removal belongs in its own category.');
    });

    var ship = rows.some(function (r) { return /shipping/i.test(r.item); });
    var disp = rows.some(function (r) { return /disposal/i.test(r.item); });
    if (!ship) f('fail', 'No Shipping line - add a $0 Shipping line.');
    if (!disp) f('fail', 'No Disposal line - add a $0 Disposal line.');

    rows.forEach(function (r) {
      if (!r.trip) f('fail', '"' + r.item + '" has a blank Trip #.');
      if (/^\d+(\.\d+)?$/.test(r.uom)) f('fail', '"' + r.item + '" has a numeric UOM "' + r.uom + '".');
    });

    var total = vendorTotal;
    if (total == null) total = rows.reduce(function (s, r) { return s + (r.totalCost || 0); }, 0);
    if (nte == null) f('warn', 'Client NTE not found on the page - total not compared.');
    else if (total > nte) f('fail', 'Vendor total ' + fmt(total) + ' is over the client NTE ' + fmt(nte) + '.');
    else f('ok', 'Vendor total ' + fmt(total) + ' is within the client NTE ' + fmt(nte) + '.');

    if (!out.some(function (o) { return o.level === 'fail'; })) f('ok', 'No line-shape problems found.');
    return out;
  }

  // Guidance only - the shape the AI needs, built from what the vendor already entered.
  function recommendedLines(rows) {
    var trips = distinctTrips(rows);
    if (!trips.length) trips = [1];
    var men = 1;
    rows.forEach(function (r) { var m = /^(\d+)\s*man/i.exec(r.item); if (m) men = Math.max(men, +m[1]); });
    var out = [];
    trips.forEach(function (t) {
      out.push({ category: 'Travel', item: men + ' Man Travel', trip: t, uom: 'Trip', qty: 1 });
      var hrs = rows.filter(function (r) { return isLabor(r) && String(r.trip) === String(t); })
        .reduce(function (s, r) { return s + (r.qty || 0); }, 0);
      out.push({ category: 'Labor', item: men + ' Man', trip: t, uom: 'Hr', qty: hrs || '' });
    });
    var t0 = trips[trips.length - 1];
    rows.forEach(function (r) {
      if (isTravel(r) || isLabor(r) || /shipping|disposal/i.test(r.item)) return;
      var cat = RX_EQUIP.test(r.item) && /material|other/i.test(r.category) ? 'Equipment' : r.category;
      out.push({ category: cat, item: r.item, trip: r.trip || t0, uom: /^\d/.test(r.uom) ? 'Each' : r.uom, qty: r.qty });
    });
    out.push({ category: 'Material', item: 'Shipping', trip: t0, uom: 'Each', qty: 1, note: '$0' });
    out.push({ category: 'Other', item: 'Disposal', trip: t0, uom: 'Each', qty: 1, note: '$0' });
    return out;
  }

  // "Item name: 50-120" / "Item: $50 - $120" -> [{name, min, max}] in cents.
  function parseRanges(text) {
    var out = [];
    String(text || '').split(/\n/).forEach(function (line) {
      var m = /^\s*(.+?)\s*:\s*\$?([\d,]+(?:\.\d+)?)\s*-\s*\$?([\d,]+(?:\.\d+)?)\s*$/.exec(line);
      if (m) out.push({ name: m[1], min: moneyToCents(m[2]), max: moneyToCents(m[3]) });
    });
    return out;
  }

  function lines(text) { return String(text || '').split(/\n/).map(norm).filter(Boolean); }

  // f: {pricingRules, ranges, scopeLine, issue, verbatim, materials, trip1Status, trip1, trip2}
  function buildPrompt(f) {
    var p = [];
    if (norm(f.pricingRules)) p.push(norm(f.pricingRules));
    var rg = parseRanges(f.ranges);
    if (rg.length) p.push('Non-rate-card ranges: ' + rg.map(function (r) { return r.name + ' ' + fmt(r.min) + '-' + fmt(r.max); }).join('; ') + '.');
    p.push(norm(f.scopeLine) || DEFAULT_SCOPE_LINE);
    p.push('1. ' + norm(f.issue));
    var vb = lines(f.verbatim);
    if (vb.length) p.push('2. Include verbatim: ' + vb.map(function (v) { return '"' + v + '"'; }).join(' '));
    var mats = lines(String(f.materials || '').replace(/,/g, '\n'))
      .filter(function (m) { return !/^(shipping|disposal)$/i.test(m); });
    p.push('3. Materials/Equipment: ' + mats.concat(['Shipping', 'Disposal']).join(', ') + '.');
    if (lines(f.trip1).length) p.push('4. Trip 1 (' + (f.trip1Status || 'Proposed') + '): ' + lines(f.trip1).join('; ') + '.');
    if (lines(f.trip2).length) p.push('5. Trip 2: ' + lines(f.trip2).join('; ') + '.');
    p.push('Bullets under 12 words.');
    return p.join('\n');
  }

  function promptState(text) {
    var n = text.length;
    return { n: n, over: n > PROMPT_MAX, warn: n >= PROMPT_WARN && n <= PROMPT_MAX };
  }

  // GraphQL op name from a request body string, or null.
  function opNameOf(body) {
    if (typeof body !== 'string' || body.indexOf('AIProposal') < 0) return null;
    try {
      var j = JSON.parse(body);
      var name = j && (j.operationName || (/(?:query|mutation)\s+(\w+)/.exec(j.query || '') || [])[1]);
      return name && WATCH_OPS[name] ? name : null;
    } catch (e) { return null; }
  }

  // Every human-readable error string in a GraphQL response: errors[].message plus any
  // validationErrors array found anywhere (strings or {message|errorMessage|propertyName}).
  function errorsOf(json) {
    var out = [];
    (json && json.errors || []).forEach(function (e) { if (e && e.message) out.push(String(e.message)); });
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 6) return;
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (/^validationErrors$/i.test(k) && Array.isArray(v)) {
          v.forEach(function (x) {
            if (typeof x === 'string') out.push(x);
            else if (x) out.push(norm((x.propertyName ? x.propertyName + ': ' : '') + (x.message || x.errorMessage || JSON.stringify(x))));
          });
        } else walk(v, d + 1);
      });
    })(json, 0);
    var payload = payloadOf(json);
    if (payload && payload.success === false && payload.message) out.push(String(payload.message));
    return out.filter(function (s, i) { return out.indexOf(s) === i; });
  }

  // data.<firstField> - the field name is not hard-coded (inferred, see discovery notes).
  function payloadOf(json) {
    var d = json && json.data;
    if (!d || typeof d !== 'object') return null;
    var k = Object.keys(d)[0];
    return k ? d[k] : null;
  }

  // ctx: {nte (cents|null), ranges:[{name,min,max}], verbatim:[str], trips (int|null)}
  // -> [{level:'pass'|'fail'|'warn', msg}]
  function checkPreview(pv, ctx) {
    var out = [];
    function r(level, msg) { out.push({ level: level, msg: msg }); }
    var items = (pv && pv.lineItems) || [];
    var scope = String((pv && pv.scopeOfWork) || '');

    var below = items.filter(function (li) {
      var c = gqlCents(li.unitCost), ch = gqlCents(li.unitCharge);
      return c != null && ch != null && ch < c;
    });
    if (below.length) below.forEach(function (li) { r('fail', '"' + li.item + '" charges ' + fmt(gqlCents(li.unitCharge)) + ', below cost ' + fmt(gqlCents(li.unitCost)) + '.'); });
    else r('pass', 'No line charges below cost.');

    var neg = items.filter(function (li) { return typeof li.markUpPercent === 'number' && li.markUpPercent < 0; });
    neg.forEach(function (li) { r('fail', '"' + li.item + '" has negative markup ' + li.markUpPercent + '%.'); });

    var travel = items.filter(function (li) { return RX_TRAVEL.test(li.item || '') || RX_TRAVEL.test(li.categoryName || ''); });
    if (travel.length) {
      var q = travel.reduce(function (s, li) { return s + (+li.chargeQuantity || 0); }, 0);
      var want = ctx.trips || travel.length;
      if (q !== want) r('fail', 'Travel charge quantity totals ' + q + ' for ' + want + ' trip(s) / ' + travel.length + ' travel line(s).');
      else r('pass', 'Travel charge quantity matches ' + want + ' trip(s).');
    }

    var hi = items.filter(function (li) { return /material/i.test(li.categoryName || '') && li.markUpPercent > MATERIAL_MARKUP_MAX; });
    if (hi.length) hi.forEach(function (li) { r('fail', 'Material "' + li.item + '" markup ' + li.markUpPercent + '% is over ' + MATERIAL_MARKUP_MAX + '%.'); });
    else r('pass', 'Materials markup within ' + MATERIAL_MARKUP_MAX + '%.');

    items.filter(function (li) { return li.rateId == null; }).forEach(function (li) {
      var name = String(li.item || '').toLowerCase();
      var rg = (ctx.ranges || []).filter(function (x) { var n = x.name.toLowerCase(); return name.indexOf(n) >= 0 || n.indexOf(name) >= 0; })[0];
      var ch = gqlCents(li.unitCharge);
      if (!rg) r('warn', 'Non-rate-card line "' + li.item + '" has no range set.');
      else if (ch == null || ch < rg.min || ch > rg.max) r('fail', 'Non-rate-card "' + li.item + '" at ' + fmt(ch) + ' is outside ' + fmt(rg.min) + '-' + fmt(rg.max) + '.');
      else r('pass', 'Non-rate-card "' + li.item + '" within range.');
    });

    var total = gqlCents(pv && pv.estimatedTotal);
    if (ctx.nte == null) r('warn', 'Client NTE not known - total not compared.');
    else if (total != null && total > ctx.nte) r('fail', 'Estimated total ' + fmt(total) + ' is over NTE ' + fmt(ctx.nte) + '.');
    else r('pass', 'Estimated total ' + fmt(total) + ' within NTE ' + fmt(ctx.nte) + '.');

    if (/the problem|the solution/i.test(scope)) r('fail', 'Scope contains "The Problem" / "The Solution" headings.');
    else r('pass', 'No Problem/Solution headings.');

    var ns = norm(scope).toLowerCase();
    (ctx.verbatim || []).forEach(function (v) {
      if (ns.indexOf(norm(v).toLowerCase()) >= 0) r('pass', 'Verbatim line present: "' + v + '".');
      else r('fail', 'Verbatim line missing: "' + v + '".');
    });

    if (/materials\s*\/\s*equipment/i.test(scope)) r('pass', 'Materials/Equipment section present.');
    else r('fail', 'Materials/Equipment section missing.');
    return out;
  }

  // Passive response tap. Calls onResp(opName, json) for watched ops; the request is passed
  // through untouched, the app gets the ORIGINAL response, and no header is read.
  function installTap(win, onResp) {
    var of = win.fetch;
    if (typeof of === 'function') {
      win.fetch = function (input, init) {
        var p = of.apply(this, arguments);
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var op = /\/api\/graphql/.test(url) ? opNameOf(init && init.body) : null;
          if (op) p.then(function (res) {
            try { res.clone().json().then(function (j) { onResp(op, j); }, function () { }); } catch (e) { }
          }, function () { });
        } catch (e) { /* never break the app's own request */ }
        return p;
      };
    }
    var X = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (X) {
      var oOpen = X.open, oSend = X.send;
      X.open = function (m, u) { this.__bwnApaUrl = u; return oOpen.apply(this, arguments); };
      X.send = function (b) {
        try {
          var op = /\/api\/graphql/.test(this.__bwnApaUrl || '') ? opNameOf(b) : null;
          if (op) this.addEventListener('load', function () {
            try { onResp(op, JSON.parse(this.responseText)); } catch (e) { }
          });
        } catch (e) { }
        return oSend.apply(this, arguments);
      };
    }
  }
  // ===== APA-LOGIC END =====

  // ---- storage (localStorage: @grant none) ----------------------------------------------------
  var LS_SET = 'bwn:apa:settings', LS_TPL = 'bwn:apa:templates', LS_LOG = 'bwn:apa:log', SS_CTX = 'bwn:apa:ctx:';
  function lsGet(k, d, store) { try { var v = (store || localStorage).getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v, store) { try { (store || localStorage).setItem(k, JSON.stringify(v)); } catch (e) { /* storage denied */ } }

  var settings = lsGet(LS_SET, {});   // {preflight, builder, checker, open} - all absent = OFF
  function on(k) { return settings[k] === true; }

  // Activity log: action label + timestamp ONLY - never record content, amounts or ids.
  function logAction(label) {
    var l = lsGet(LS_LOG, []);
    l.unshift({ a: label, t: new Date().toISOString() });
    lsSet(LS_LOG, l.slice(0, 50));
  }

  var SEED_TEMPLATES = [
    { name: 'Pilot Travel Centers', pricingRules: 'Pricing: rate card first. Never charge any line below vendor unit cost. Materials markup 35% max.', ranges: '', scopeLine: DEFAULT_SCOPE_LINE, verbatim: '' },
    { name: 'Generic', pricingRules: 'Pricing: rate card first. Never charge any line below vendor unit cost. Materials markup 35% max.', ranges: '', scopeLine: 'Scope: plain technician text, no Problem/Solution/Work Summary headings.', verbatim: '' }
  ];
  function templates() {
    var t = lsGet(LS_TPL, null);
    if (!Array.isArray(t) || !t.length) t = SEED_TEMPLATES.slice();
    // Pilot Travel Centers always first.
    t.sort(function (a, b) { return (b.name === 'Pilot Travel Centers') - (a.name === 'Pilot Travel Centers'); });
    return t;
  }

  // Per-quote context carried from the vendor-proposal page to the AI preview page (same tab).
  // Item names + trip count + NTE only; sessionStorage so it dies with the tab.
  function ctxGet(q) { return lsGet(SS_CTX + q, {}, sessionStorage); }
  function ctxSet(q, v) { lsSet(SS_CTX + q, v, sessionStorage); }

  // ---- tap: installed now (document-start), acts only when the checker is on + AI route --------
  var lastCheck = null;
  try {
    installTap(window, function (op, json) {
      var rt = routeOf(location.pathname);
      if (!on('checker') || !rt || rt.kind !== 'ai') return;
      logAction('checker: ' + op + ' response read');
      lastCheck = { op: op, json: json, quoteId: rt.quoteId };
      render();
    });
  } catch (e) { console.warn('[BWN APA] response tap failed to install:', e); }

  // ---- DOM readers --------------------------------------------------------------------------
  var PANEL_ID = 'bwn-apa';
  function panelEl() { return document.getElementById(PANEL_ID); }
  function inPanel(n) { var p = panelEl(); return !!(p && n && p.contains(n)); }
  function txt(el) { return norm(el && (el.innerText || el.textContent)); }

  // Line grid: any table/grid whose header cells (by TEXT) include every needed header.
  function readGrid() {
    var boxes = document.querySelectorAll('table, [role="grid"], [role="table"], [role="treegrid"]');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (inPanel(box)) continue;
      var hs = Array.prototype.map.call(box.querySelectorAll('th, [role="columnheader"]'), txt);
      var low = hs.map(function (h) { return h.toLowerCase(); });
      if (NEEDED_HEADERS.some(function (h) { return low.indexOf(h) < 0; })) continue;
      var rowEls = box.querySelectorAll('tbody tr, [role="row"]');
      var cells = [];
      Array.prototype.forEach.call(rowEls, function (tr) {
        if (tr.querySelector('th, [role="columnheader"]')) return;
        var cs = tr.querySelectorAll('td, [role="cell"], [role="gridcell"]');
        if (cs.length) cells.push(Array.prototype.map.call(cs, txt));
      });
      return rowsFromGrid(hs, cells);
    }
    return null;
  }

  // WO header strip value: first $ amount next to a label text node ("Client DNE", "Total Vendor Cost").
  function stripMoney(labelRx) {
    if (!document.body) return null;
    var w = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */), n;
    while ((n = w.nextNode())) {
      if (inPanel(n) || !labelRx.test(norm(n.nodeValue))) continue;
      var el = n.parentElement;
      for (var i = 0; i < 3 && el; i++, el = el.parentElement) {
        var m = (el.textContent || '').replace(n.nodeValue, '').match(/-?\$\s?[\d,]+(?:\.\d{1,2})?/);
        if (m) return moneyToCents(m[0].replace(/\s/g, ''));
      }
    }
    return null;
  }
  function readNte() { return stripMoney(/^client\s+dne\b|^nte\b/i); }
  function readVendorTotal() { return stripMoney(/^total vendor cost\b/i); }

  // The Generate prompt textarea: the one textarea sharing a close ancestor with a "Generate" button.
  function findPromptBox() {
    var btns = Array.prototype.filter.call(document.querySelectorAll('button'), function (b) {
      return !inPanel(b) && /^\s*generate\b/i.test(b.textContent || '');
    });
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i];
      for (var d = 0; d < 6 && el; d++, el = el.parentElement) {
        var tas = Array.prototype.filter.call(el.querySelectorAll('textarea'), function (t) { return !inPanel(t); });
        if (tas.length === 1) return tas[0];
        if (tas.length > 1) break;
      }
    }
    return null;
  }

  // ---- UI -----------------------------------------------------------------------------------
  var CSS =
    '#bwn-apa{position:fixed;right:16px;bottom:16px;z-index:2147482000;width:min(440px,calc(100vw - 32px));max-height:80vh;display:flex;flex-direction:column;' +
    'background:#f0f4f8;color:#1d2b24;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:13px/1.45 "DM Sans",system-ui,sans-serif;overflow:hidden}' +
    '#bwn-apa .h{background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;border-bottom:3px solid #2ECC71;padding:8px 12px;display:flex;align-items:center;gap:8px}' +
    '#bwn-apa .h b{flex:1;font-size:14px}' +
    '#bwn-apa .b{padding:10px 12px;overflow:auto}' +
    '#bwn-apa button{font:600 12px "DM Sans",system-ui,sans-serif;border:1px solid #1a5f3e;background:#fff;color:#1a5f3e;border-radius:6px;padding:4px 10px;cursor:pointer}' +
    '#bwn-apa button.p{background:#1a5f3e;color:#fff}#bwn-apa button:disabled{opacity:.45;cursor:not-allowed}' +
    '#bwn-apa .h button{background:transparent;color:#fff;border-color:rgba(255,255,255,.6)}' +
    '#bwn-apa button:focus-visible,#bwn-apa input:focus-visible,#bwn-apa textarea:focus-visible,#bwn-apa select:focus-visible{outline:2px solid #2ECC71;outline-offset:1px}' +
    '#bwn-apa h4{margin:10px 0 4px;font-size:12px;color:#1a5f3e;text-transform:uppercase;letter-spacing:.04em}' +
    '#bwn-apa label{display:block;font-size:12px;font-weight:600;color:#1a5f3e;margin:6px 0 2px}' +
    '#bwn-apa textarea,#bwn-apa input[type=text],#bwn-apa select{box-sizing:border-box;width:100%;font:12px "DM Sans",system-ui,sans-serif;border:1px solid #b9c7d3;border-radius:5px;padding:4px 6px;background:#fff}' +
    '#bwn-apa textarea{min-height:44px;resize:vertical}' +
    '#bwn-apa .mono,#bwn-apa pre{font-family:"DM Mono",ui-monospace,monospace;font-size:11px}' +
    '#bwn-apa pre{white-space:pre-wrap;background:#fff;border:1px solid #dbe3ea;border-radius:5px;padding:6px;margin:4px 0}' +
    '#bwn-apa ul{list-style:none;margin:4px 0;padding:0}#bwn-apa li{padding:2px 0 2px 18px;position:relative}' +
    '#bwn-apa li:before{position:absolute;left:0;font-weight:700}' +
    '#bwn-apa li.fail:before{content:"\\2717";color:#b3261e}#bwn-apa li.warn:before{content:"!";color:#9a6700}' +
    '#bwn-apa li.ok:before,#bwn-apa li.pass:before{content:"\\2713";color:#1a5f3e}' +
    '#bwn-apa table{border-collapse:collapse;width:100%;font-size:11px}#bwn-apa td,#bwn-apa th{border-bottom:1px solid #dbe3ea;padding:2px 4px;text-align:left}' +
    '#bwn-apa .row{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}' +
    '#bwn-apa .ctr{margin-left:auto}#bwn-apa .ctr.warn{color:#9a6700}#bwn-apa .ctr.over{color:#b3261e;font-weight:700}' +
    '#bwn-apa .off{color:#5b6b78;font-style:italic}';

  var form = null;          // builder field values survive re-renders within a page
  var gridSig = '';

  function ensurePanel() {
    var p = panelEl();
    if (p) return p;
    if (!document.getElementById('bwn-apa-css')) {
      var st = document.createElement('style');
      st.id = 'bwn-apa-css';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    p = document.createElement('section');
    p.id = PANEL_ID;
    p.setAttribute('role', 'region');
    p.setAttribute('aria-label', 'BWN AI Proposal Assist');
    document.body.appendChild(p);
    p.addEventListener('click', onClick);
    p.addEventListener('input', onInput);
    p.addEventListener('change', onInput);
    return p;
  }

  function removePanel() { var p = panelEl(); if (p) p.remove(); }

  function list(items) {
    return '<ul>' + items.map(function (o) { return '<li class="' + esc(o.level) + '">' + esc(o.msg) + '</li>'; }).join('') + '</ul>';
  }

  function toggles() {
    return '<h4>Features (off until switched on)</h4>' +
      ['preflight:Pre-flight (vendor proposal page)', 'builder:Prompt builder (AI preview page)', 'checker:Post-generate checker (AI preview page)'].map(function (s) {
        var k = s.split(':')[0];
        return '<label><input type="checkbox" data-set="' + k + '"' + (on(k) ? ' checked' : '') + '> ' + esc(s.slice(k.length + 1)) + '</label>';
      }).join('');
  }

  function preflightHtml(rt) {
    if (!on('preflight')) return '';
    var rows = readGrid();
    if (!rows) return '<h4>Pre-flight</h4><p class="off">Line grid layout not recognised — disabled.</p>';
    var nte = readNte(), vt = readVendorTotal();
    var trips = distinctTrips(rows);
    var prev = ctxGet(rt.quoteId);
    var items = rows.filter(function (r) { return !isTravel(r) && !isLabor(r) && !/shipping|disposal/i.test(r.item); }).map(function (r) { return r.item; });
    if (JSON.stringify(prev.items) !== JSON.stringify(items) || prev.nte !== nte || prev.trips !== trips.length) {
      ctxSet(rt.quoteId, { items: items, nte: nte, trips: trips.length });
      logAction('pre-flight run');
    }
    var rec = recommendedLines(rows);
    return '<h4>Pre-flight</h4>' + list(preflight(rows, nte, vt)) +
      '<h4>Recommended lines</h4><table><tr><th>Category</th><th>Item</th><th>Trip #</th><th>UOM</th><th>Qty</th></tr>' +
      rec.map(function (r) {
        return '<tr><td>' + esc(r.category) + '</td><td>' + esc(r.item) + (r.note ? ' <span class="mono">' + esc(r.note) + '</span>' : '') + '</td><td>' + esc(r.trip) + '</td><td>' + esc(r.uom) + '</td><td>' + esc(r.qty) + '</td></tr>';
      }).join('') + '</table><p class="off">Guidance only - edit the vendor proposal yourself; this panel never changes the grid.</p>';
  }

  function defaultForm(rt) {
    var t = templates()[0], c = ctxGet(rt.quoteId);
    return {
      tpl: t.name, pricingRules: t.pricingRules, ranges: t.ranges, scopeLine: t.scopeLine, verbatim: t.verbatim,
      issue: '', materials: (c.items || []).join('\n'), trip1Status: 'Incurred', trip1: '', trip2: ''
    };
  }

  function field(k, label, area) {
    var v = esc(form[k]);
    return '<label for="bwn-apa-' + k + '">' + esc(label) + '</label>' + (area
      ? '<textarea id="bwn-apa-' + k + '" data-f="' + k + '">' + v + '</textarea>'
      : '<input type="text" id="bwn-apa-' + k + '" data-f="' + k + '" value="' + v + '">');
  }

  function builderHtml(rt) {
    if (!on('builder')) return '';
    if (!form || form.quoteId !== rt.quoteId) { form = defaultForm(rt); form.quoteId = rt.quoteId; }
    var compat = findPromptBox() ? '' : '<p class="off">Generate prompt box: layout not recognised — disabled. Copy still works.</p>';
    return '<h4>Prompt builder</h4>' + compat +
      '<label for="bwn-apa-tpl">Client template</label><select id="bwn-apa-tpl" data-tpl="1">' +
      templates().map(function (t) { return '<option' + (t.name === form.tpl ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
      '</select><div class="row"><button data-act="tpl-save">Save template</button><button data-act="tpl-del">Delete template</button></div>' +
      field('pricingRules', 'Pricing rules', true) +
      field('ranges', 'Non-rate-card ranges (one per line: Item: 50-120)', true) +
      field('scopeLine', 'Scope style line', false) +
      field('issue', '1. Issue sentence', false) +
      field('verbatim', '2. Required verbatim lines (one per line; save NEXREV override wording in the template)', true) +
      field('materials', '3. Materials/Equipment (one per line; Shipping, Disposal are added)', true) +
      '<label for="bwn-apa-trip1Status">4. Trip 1 status</label><select id="bwn-apa-trip1Status" data-f="trip1Status">' +
      ['Incurred', 'Proposed'].map(function (s) { return '<option' + (form.trip1Status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      field('trip1', 'Trip 1 steps (one per line)', true) +
      field('trip2', '5. Trip 2 steps (one per line)', true) +
      '<pre id="bwn-apa-out" aria-label="Assembled prompt"></pre>' +
      '<div class="row"><button class="p" data-act="copy">Copy</button><button data-act="insert"' + (compat ? ' disabled' : '') + '>Insert</button>' +
      '<span class="ctr mono" id="bwn-apa-ctr" aria-live="polite"></span></div>';
  }

  function updatePrompt() {
    var out = document.getElementById('bwn-apa-out'), ctr = document.getElementById('bwn-apa-ctr');
    if (!out || !form) return;
    var text = buildPrompt(form), st = promptState(text);
    out.textContent = text;
    ctr.textContent = st.n + ' / ' + PROMPT_MAX + (st.over ? ' - over limit, shorten' : st.warn ? ' - near limit' : '');
    ctr.className = 'ctr mono' + (st.over ? ' over' : st.warn ? ' warn' : '');
    var p = panelEl();
    p.querySelector('[data-act="copy"]').disabled = st.over;
    p.querySelector('[data-act="insert"]').disabled = st.over || !findPromptBox();
  }

  function checkerHtml(rt) {
    if (!on('checker')) return '';
    if (!lastCheck || lastCheck.quoteId !== rt.quoteId) return '<h4>Post-generate check</h4><p class="off">Waiting for Generate or Revise - nothing is sent by this panel.</p>';
    var j = lastCheck.json, pl = payloadOf(j), errs = errorsOf(j);
    var pv = pl && (pl.preview || pl.result || (pl.lineItems ? pl : null));
    var h = '<h4>Post-generate check (' + esc(lastCheck.op) + ')</h4>';
    if (errs.length || !pv) return h + list([{ level: 'fail', msg: 'Generate failed. Server said:' }].concat(
      (errs.length ? errs : ['(no error text in the response)']).map(function (e) { return { level: 'warn', msg: e }; })));
    var c = ctxGet(rt.quoteId), f = form || {};
    var res = checkPreview(pv, {
      nte: readNte() != null ? readNte() : (c.nte == null ? null : c.nte),
      ranges: parseRanges(f.ranges), verbatim: lines(f.verbatim), trips: c.trips || null
    });
    return h + list(res) + (pv.reasoning ? '<details><summary>AI reasoning</summary><pre>' + esc(pv.reasoning) + '</pre></details>' : '');
  }

  function render() {
    var rt = routeOf(location.pathname);
    if (!rt || !document.body) { removePanel(); return; }
    var p = ensurePanel();
    var open = settings.open === true;
    var body = rt.kind === 'vp' ? preflightHtml(rt) : builderHtml(rt) + checkerHtml(rt);
    var focusId = document.activeElement && inPanel(document.activeElement) ? document.activeElement.id : null;
    p.innerHTML = '<div class="h"><b>AI Proposal Assist</b><span class="mono">v' + esc(VER) + '</span>' +
      '<button data-act="toggle" aria-expanded="' + open + '">' + (open ? 'Hide' : 'Show') + '</button></div>' +
      (open ? '<div class="b">' + (body || '<p class="off">No feature on for this page.</p>') + toggles() + '</div>' : '');
    updatePrompt();
    if (focusId) { var f = document.getElementById(focusId); if (f) f.focus(); }
  }

  function onInput(ev) {
    var t = ev.target;
    if (t.dataset.set && ev.type === 'change') {
      settings[t.dataset.set] = t.checked;
      lsSet(LS_SET, settings);
      logAction('feature ' + t.dataset.set + (t.checked ? ' on' : ' off'));
      render();
    } else if (t.dataset.tpl && ev.type === 'change') {
      var tp = templates().filter(function (x) { return x.name === t.value; })[0];
      if (tp) ['pricingRules', 'ranges', 'scopeLine', 'verbatim'].forEach(function (k) { form[k] = tp[k] || ''; });
      form.tpl = t.value;
      render();
    } else if (t.dataset.f && form) {
      form[t.dataset.f] = t.value;
      updatePrompt();
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text;
    panelEl().appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }

  function onClick(ev) {
    var b = ev.target.closest && ev.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    var act = b.dataset.act;
    if (act === 'toggle') { settings.open = !(settings.open === true); lsSet(LS_SET, settings); render(); return; }
    if (!form) return;
    var text = buildPrompt(form);
    if (act === 'copy' && !promptState(text).over) {
      copyText(text).then(function () { b.textContent = 'Copied'; logAction('prompt copied'); }, function () { b.textContent = 'Copy failed'; });
    } else if (act === 'insert' && !promptState(text).over) {
      var ta = findPromptBox();
      if (!ta) { render(); return; }
      // React tracks the value through the prototype setter; a plain .value= is overwritten on the next render.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      b.textContent = 'Inserted';
      logAction('prompt inserted');
    } else if (act === 'tpl-save') {
      var name = window.prompt('Template name', form.tpl || '');
      if (!name) return;
      var all = templates().filter(function (x) { return x.name !== name; });
      all.push({ name: name, pricingRules: form.pricingRules, ranges: form.ranges, scopeLine: form.scopeLine, verbatim: form.verbatim });
      lsSet(LS_TPL, all);
      form.tpl = name;
      logAction('template saved');
      render();
    } else if (act === 'tpl-del') {
      lsSet(LS_TPL, templates().filter(function (x) { return x.name !== form.tpl; }));
      form.tpl = templates()[0].name;
      logAction('template deleted');
      render();
    }
  }

  // ---- lifecycle: route check on init and on every SPA route change; grid via observer --------
  var mo = null, moTimer = null;
  function onRoute() {
    var rt = routeOf(location.pathname);
    if (mo) { mo.disconnect(); mo = null; }
    gridSig = '';
    if (!rt) { removePanel(); return; }
    render();
    if (rt.kind === 'vp' || rt.kind === 'ai') {
      // The grid / Generate box mount after the route; re-render when the page (not our panel) changes.
      mo = new MutationObserver(function (muts) {
        if (muts.every(function (m) { return inPanel(m.target); })) return;
        clearTimeout(moTimer);
        moTimer = setTimeout(function () {
          var g = rt.kind === 'vp' ? JSON.stringify(readGrid()) + readNte() : String(!!findPromptBox());
          if (g !== gridSig || !panelEl()) { gridSig = g; render(); }
        }, 300);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  function boot() {
    var last = location.pathname;
    function ping() { if (location.pathname !== last) { last = location.pathname; onRoute(); } }
    window.addEventListener('popstate', ping);
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      history[m] = function () { var r = orig.apply(this, arguments); setTimeout(ping, 0); return r; };
    });
    onRoute();
  }

  console.info('[BWN APA] v' + VER + ' - read-only AI proposal assist; features off until enabled in the panel');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
