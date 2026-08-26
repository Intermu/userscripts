// ==UserScript==
// @name         BWN Suite - Core (Broadway National)
// @namespace    broadwaynational.bwn
// @version      1.78.36
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-suite-core.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-suite-core.user.js
// @description  Runs several Umbrava helpers for BWN coordinators, in the browser with no privileged grants. Includes: PO Approval + ETA Builder; WO Assist (GP/ETA, a stall watchdog, DNE calculator, and a next-action playbook); Email Leak Guard (checks recipients against vendor names, PO amounts, and client budget references before an outbound email sends); WO List Heat (a triage overlay + My Day strip on the work-order list, with an optional same-origin Umbrava API scan for deterministic full-board coverage); and the BWN Launcher (opens the Azure Static Web App tools with the current WO's context). Modules share state through sessionStorage/localStorage. The only network calls are same-origin Umbrava GraphQL requests (app.umbrava.com/api/graphql, the app's own session): List Heat's full-board scan and WO Assist's work-order / trip / clock-in / document reads, plus ONE write - BWN Views saves the column layout through Umbrava's own putUserPreference, the same preference the column chooser writes; everything else is offline. Toggle modules in BWN_MODULES below.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---- Module kill switches (edit here) ----------------------------------
  var BWN_MODULES = {
    poApproval: true,    // approval/ETA text buttons in the Send PO modal
    woAssist: true,      // side-docked GP + ETA watchdog + playbook on WO pages
    leakGuard: true,     // outbound email cross-contamination guard
    listHeat: true,      // heat overlay + audit on the Work Orders list
    launcher: true,      // BWN tools dock (left edge)
    viewManager: true,   // your own saved column layouts on the WO list
    palette: true,       // Ctrl/Cmd-K command palette for the whole suite
    visitLog: true,      // per-WO "what changed" watch strip + end-of-day digest
    reminders: true,     // local time-based follow-up nudges for a WO
    notesTimeline: true, // read-only chronological notes overlay with gap markers
    tripCal: true,       // export a WO's scheduled trips to .ics (Trips tab)
    domHandle: true      // read-only page snapshots for Ask, over the bwn:cmd/bwn:evt bus
  };

  var BWN_VER = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.51.2';

  // Module overrides set by the Ops Suite panel; reload to apply. Both scripts
  // read the shared bwn:modules blob and honor only their own keys.
  try {
    var _mp = JSON.parse(localStorage.getItem('bwn:modules') || '{}');
    if (_mp && typeof _mp === 'object') Object.keys(_mp).forEach(function (k) {
      if (typeof _mp[k] === 'boolean' && k in BWN_MODULES) BWN_MODULES[k] = _mp[k];
    });
  } catch (e) { /* defaults */ }

  // Publish version for the Ops Suite panel status readout.
  try { localStorage.setItem('bwn:status:core', JSON.stringify({ ver: BWN_VER, ts: Date.now() })); } catch (e) { /* best-effort */ }

  console.info('[BWN SUITE CORE] v' + BWN_VER + ' |',
    'Shared Core 7 \u00b7 DOM Handles 1.0 \u00b7 PO Approval 1.13 \u00b7 WO Assist 2.71 \u00b7 Leak Guard 2.0 \u00b7 List Heat 3.28 \u00b7 Launcher 2.0 \u00b7 Views 3.1 \u00b7 Palette 1.1 \u00b7 Visit 1.2 \u00b7 Reminders 1.1 \u00b7 Timeline 1.1 \u00b7 TripCal 1.4 \u00b7 Connector 1.2 |',
    'enabled:', Object.keys(BWN_MODULES).filter(function (k) { return BWN_MODULES[k]; }).join(', '));

  // ===== BWN SHARED CORE v7 - KEEP IN SYNC across both suite scripts =====
  // Single source of truth for the bus, suite config, parsing, brand tokens, and
  // the shared UI primitives. Both userscripts carry an IDENTICAL copy: they run in
  // separate Tampermonkey scopes (Core @grant none vs AI's GM_* grants) and cannot
  // share a runtime object across that boundary - they share DATA via sessionStorage
  // /localStorage instead. When you edit this block: bump the version below and paste
  // it into BOTH files. Pure helpers + storage only; never put credentials here.
  var BWN = (function () {
    var VERSION = 7;

    // ---- BWN bus (suite data contract v1; per-origin sessionStorage) ----------
    // WO Assist (Core) is the PRODUCER of bwn:wo:{id}; everyone else consumes with
    // DOM as truth and the bus as fallback. List Heat publishes bwn:heat:{id}.
    function woId() {
      var m = location.pathname.match(/work-orders\/(\d+)/);
      return m ? m[1] : null;
    }
    function busGet(id, maxAgeMs) {
      try {
        var raw = sessionStorage.getItem('bwn:wo:' + id);
        if (!raw) return null;
        var d = JSON.parse(raw);
        if (d.v !== 1 || (maxAgeMs && Date.now() - d.ts > maxAgeMs)) return null;
        return d;
      } catch (e) { return null; }
    }
    function busPut(id, data) {
      try {
        data.v = 1; data.ts = Date.now();
        sessionStorage.setItem('bwn:wo:' + id, JSON.stringify(data));
        document.dispatchEvent(new CustomEvent('bwn:update', { detail: { id: id } }));
      } catch (e) { /* storage full or blocked: bus is best-effort */ }
    }
    // MERGE a partial payload over whatever is already on the bus, instead of replacing it.
    // For publishing header identity before the full WO state is computable: a consumer that
    // reads early gets the real Tracking # rather than nothing, and a later full busPut still
    // overwrites everything. BLANKS ARE SKIPPED - a field the header has not rendered yet must
    // never clobber a good value from an earlier pass. Clearing a field is the full publish's
    // job, since only it knows the difference between "not read yet" and "genuinely empty".
    function busPatch(id, data) {
      try {
        var cur = null;
        try { var raw = sessionStorage.getItem('bwn:wo:' + id); cur = raw ? JSON.parse(raw) : null; } catch (e) { cur = null; }
        if (!cur || typeof cur !== 'object' || cur.v !== 1) cur = {};
        for (var k in data) {
          if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
          if (data[k] === '' || data[k] == null) continue;
          cur[k] = data[k];
        }
        busPut(id, cur);
      } catch (e) { /* bus is best-effort */ }
    }
    function busHeatGet(id, maxAgeMs) {
      try {
        var raw = sessionStorage.getItem('bwn:heat:' + id);
        if (!raw) return null;
        var d = JSON.parse(raw);
        if (d.v !== 1 || (maxAgeMs && Date.now() - d.ts > maxAgeMs)) return null;
        return d;
      } catch (e) { return null; }
    }
    function busVendors(maxAgeMs) {
      var d = busGet(woId(), maxAgeMs || 12 * 3600000);
      if (!d || !Array.isArray(d.pos)) return [];
      return d.pos.map(function (p) { return (p && p.vendor) ? String(p.vendor).trim() : ''; }).filter(Boolean);
    }

    // ---- Suite config (localStorage bwn:config, versioned, merged over defaults) ----
    // Read-modify-write PRESERVES unknown keys (e.g. Views presets) so any module can
    // stash its own data in the same blob. A missing/malformed key falls back to default.
    var CFG_DEFAULTS = {
      targetGP: 35,
      gpWarn: 30, gpBad: 20,
      hrsWarn: 72, hrsBad: 240,
      activeMult: 0.5,
      dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7,
      unbilledStaleDays: 3   // T8-B1: days a Work-Complete WO may sit before an "advance to invoicing" row
    };
    function cfg() {
      var out = {};
      try {
        var raw = localStorage.getItem('bwn:config');
        var d = raw ? JSON.parse(raw) : null;
        if (d && typeof d === 'object' && d.v === 1) out = d;   // preserve unknown keys for read-modify-write
      } catch (e) { out = {}; }
      Object.keys(CFG_DEFAULTS).forEach(function (k) {
        if (!(typeof out[k] === 'number' && isFinite(out[k]))) out[k] = CFG_DEFAULTS[k];
      });
      return out;
    }
    function cfgSave(partial) {
      try {
        var cur = cfg();
        Object.keys(partial).forEach(function (k) { cur[k] = partial[k]; });
        cur.v = 1;
        localStorage.setItem('bwn:config', JSON.stringify(cur));
        document.dispatchEvent(new CustomEvent('bwn:config'));   // WO Assist + List Heat live-refresh on this
      } catch (e) { /* best-effort */ }
    }

    // ---- Per-client status/closeout config layer (T10) ------------------------
    // An empty `clients` table is a NO-OP: bwnClientProfile falls back to
    // CLIENT_DEFAULTS_SEED, so every consumer that reads a default value behaves
    // exactly as before. Overrides live in bwn:config under `clients` (and an optional
    // `clientDefaults`), preserved through cfg()/cfgSave like any other unknown key -
    // cfg()'s numeric-coercion loop only touches CFG_DEFAULTS keys, never `clients`.
    var CLIENT_DEFAULTS_SEED = {
      requiredStatuses: [],
      closeout: { docs: ['signed ticket', 'sign-in/out', 'before/after photos'], enforce: true },
      refFields: { sourceJob: false, sourcePo: false },
      cadenceDays: null
    };
    // Seed profiles keyed by alpha-only-lowercased client name (bwnClientKey). clientId is
    // recorded for cross-checking against the live clientTenantProfileId; the resolver still
    // matches by NAME. refFields opt a client into the intake source-ref gate.
    var CLIENT_PROFILE_SEED = {
      'amazon': { clientId: '20321', refFields: { sourceJob: true } },
      'cwamazon': { clientId: '20432', refFields: { sourceJob: true, sourcePo: false } },
      'jllamazon': { clientId: '20394', refFields: { sourceJob: true } },
      'caleresinc': { clientId: null },
      'transformsrbrandsllc': { clientId: '23914', refFields: { sourceJob: true, sourcePo: true } }
    };
    // Shallow merge with ONE level of depth over the two nested config objects (closeout,
    // refFields) so a partial override (e.g. {refFields:{sourceJob:true}}) keeps its sibling
    // defaults. Every other key is replaced wholesale. Nested objects are cloned so a merge
    // never mutates CLIENT_DEFAULTS_SEED.
    function deepMerge() {
      var out = {};
      for (var i = 0; i < arguments.length; i++) {
        var src = arguments[i];
        if (!src || typeof src !== 'object') continue;
        Object.keys(src).forEach(function (k) {
          var v = src[k];
          if ((k === 'closeout' || k === 'refFields') && v && typeof v === 'object') {
            out[k] = Object.assign({}, out[k] || {}, v);
          } else {
            out[k] = v;
          }
        });
      }
      return out;
    }
    // Client name -> profile-table key: alpha-only, lowercased (reuses alphaOnly / BWN.alphaOnly).
    function bwnClientKey(name) { return alphaOnly(name).toLowerCase(); }
    // Resolved per-WO client profile: defaults <- optional cfg().clientDefaults <- the client's
    // own row from cfg().clients (or the seed table when none is stored). Unknown client ->
    // CLIENT_DEFAULTS_SEED unchanged.
    function bwnClientProfile(state) {
      var c = cfg();
      var table = c.clients || CLIENT_PROFILE_SEED;
      var over = table[bwnClientKey((state && state.hd && state.hd.client) || '')] || {};
      return deepMerge(CLIENT_DEFAULTS_SEED, c.clientDefaults || {}, over);
    }

    // ---- Money / date / vendor-name parsing -----------------------------------
    function money(n) {
      return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function parseMoney(s) {
      var m = (s || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    }
    function parseBare(s) {
      var n = parseFloat(String(s || '').replace(/[$,\s]/g, ''));
      return isNaN(n) ? null : n;
    }
    function parseUSDate(s) {
      var m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (!m) return null;
      var y = parseInt(m[3], 10); if (y < 100) y += 2000;
      var d = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    function alphaOnly(s) { return (s || '').toUpperCase().replace(/[^A-Z]/g, ''); }
    // Longest common substring length between two strings.
    function lcsLen(a, b) {
      if (!a || !b) return 0;
      var n = b.length, prev = new Array(n + 1).fill(0), best = 0;
      for (var i = 1; i <= a.length; i++) {
        var cur = new Array(n + 1).fill(0);
        for (var j = 1; j <= n; j++) {
          if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
        }
        prev = cur;
      }
      return best;
    }

    // ---- Field readers / React-safe setter ------------------------------------
    function inputVal(testid) {
      var el = document.querySelector('[data-testid="' + testid + '"]');
      if (!el) return '';
      if (el.tagName === 'INPUT') return el.value || '';
      var inp = el.querySelector('input');
      return inp ? (inp.value || '') : (el.textContent || '').trim();
    }
    function setNativeValue(el, value) {
      var proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ---- Brand tokens + gradient ----------------------------------------------
    var GREEN = 'linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk))';
    function injectTokens() {
      if (document.getElementById('bwn-suite-tokens')) return;
      var st = document.createElement('style');
      st.id = 'bwn-suite-tokens';
      st.textContent =
        ':root{' +
          /* brand (theme-independent) */
          '--bwn-green:#1a5f3e;--bwn-green-dk:#0d3d26;--bwn-accent:#2ECC71;--bwn-bad:#c0392b;--bwn-warn:#e67e22;' +
          /* role tokens - LIGHT (surfaces / text / borders) */
          '--bwn-surface:#ffffff;--bwn-surface-2:#f7faf8;--bwn-surface-3:#eef3f0;--bwn-tint:#e8f3ed;' +
          '--bwn-text:#1f2a24;--bwn-text-strong:#0d3d26;--bwn-text-muted:#5a6b62;--bwn-text-faint:#66786e;' +
          '--bwn-border:#dde6e1;--bwn-border-2:#eef2f4;' +
          '--bwn-ok-bg:#e8f3ed;--bwn-ok-fg:#0d3d26;--bwn-bad-bg:#fdecea;--bwn-bad-fg:#7b241c;--bwn-warn-bg:#fff4e8;--bwn-warn-fg:#8a4b12;' +
          '--bwn-shadow:0 18px 60px rgba(13,38,26,.18);' +
        '}' +
        '[data-bwn-theme="dark"]{' +
          '--bwn-surface:#15201b;--bwn-surface-2:#1b2823;--bwn-surface-3:#243029;--bwn-tint:#1d3528;' +
          '--bwn-text:#e8efe9;--bwn-text-strong:#9fe3b8;--bwn-text-muted:#a3b3aa;--bwn-text-faint:#7d8f86;' +
          '--bwn-border:#2c3a33;--bwn-border-2:#243029;' +
          '--bwn-ok-bg:#173026;--bwn-ok-fg:#8fe0ab;--bwn-bad-bg:#3a1d1a;--bwn-bad-fg:#f2a99f;--bwn-warn-bg:#3a2a14;--bwn-warn-fg:#f0c48a;' +
          '--bwn-shadow:0 18px 60px rgba(0,0,0,.5);' +
        '}' +
        /* shared focus ring for the dropdown menu items (inline styles can't do :focus-visible) */
        '[role="menuitem"]:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--bwn-accent);}';
      (document.head || document.documentElement).appendChild(st);
    }
    // Manual theme (Light default). Persisted in localStorage['bwn:theme']; applied as
    // data-bwn-theme on <html> so every BWN panel re-themes. Only BWN UI is affected.
    function getTheme() { try { return localStorage.getItem('bwn:theme') === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
    function applyTheme(t) { try { document.documentElement.setAttribute('data-bwn-theme', t === 'dark' ? 'dark' : 'light'); } catch (e) { } }
    function setTheme(t) { try { localStorage.setItem('bwn:theme', t === 'dark' ? 'dark' : 'light'); } catch (e) { } applyTheme(t); try { document.dispatchEvent(new CustomEvent('bwn:theme')); } catch (e) { } }

    // ---- Shared dropdown menu (ARIA menu-button + keyboard nav) ---------------
    // Trigger is a menu-button (aria-haspopup/expanded); the menu is role=menu with
    // roving focus: open with Enter/Space/Down, move with Up/Down/Home/End, close with
    // Esc/Tab (restoring focus to the trigger). Built on open, removed on close,
    // positioned fixed at the trigger so no parent overflow can clip it.
    function makeDropdown(label, items) {
      var wrap = document.createElement('span');
      wrap.style.cssText = 'display:inline-flex;vertical-align:middle;';
      var trig = document.createElement('button');
      trig.type = 'button';
      trig.setAttribute('aria-haspopup', 'menu');
      trig.setAttribute('aria-expanded', 'false');
      trig.style.cssText = 'min-width:104px;padding:6px 12px;font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;color:#fff;border:none;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;background:' + GREEN + ';';
      var lab = document.createElement('span'); lab.textContent = label;
      var car = document.createElement('span'); car.textContent = '▾'; car.setAttribute('aria-hidden', 'true'); car.style.cssText = 'font-size:10px;opacity:.85;transition:transform .15s;';
      trig.appendChild(lab); trig.appendChild(car);
      wrap.appendChild(trig);

      var menu = null, rows = [];
      var sub = null, subRows = [], subOwner = null, subCloseT = null;
      var MENU_CSS = 'position:fixed;z-index:99998;min-width:212px;background:var(--bwn-surface);border:1px solid var(--bwn-border);border-radius:10px;box-shadow:var(--bwn-shadow);padding:6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;';
      var ITEM_CSS = 'display:block;width:100%;box-sizing:border-box;text-align:left;padding:9px 12px;border:none;background:transparent;border-radius:7px;cursor:pointer;font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;color:var(--bwn-text);';
      var HEAD_CSS = 'padding:8px 12px 4px;font:700 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:.6px;text-transform:uppercase;color:var(--bwn-text-faint);';
      var DESC_CSS = 'display:block;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-top:2px;';
      function focusList(list, i) { if (list.length) list[(i + list.length) % list.length].focus(); }
      function focusAt(i) { focusList(rows, i); }
      // Build one menu entry. `{header}` renders a non-interactive label; `{children}` renders a row
      // that opens a flyout (▸); otherwise a plain menuitem. `sink` collects the focusable rows.
      function makeItem(it, sink) {
        if (it.header) {
          var h = document.createElement('div');
          h.textContent = it.header; h.style.cssText = HEAD_CSS;
          return h;
        }
        var row = document.createElement('button');
        row.type = 'button'; row.setAttribute('role', 'menuitem'); row.tabIndex = -1;
        row.style.cssText = ITEM_CSS;
        row.textContent = it.label;
        if (it.desc) { var d = document.createElement('span'); d.textContent = it.desc; d.style.cssText = DESC_CSS; row.appendChild(d); }
        var kids = (it.children && it.children.length) ? it.children : null;
        if (kids) {
          row._kids = kids;
          row.setAttribute('aria-haspopup', 'menu');
          var car2 = document.createElement('span');
          car2.textContent = '▸'; car2.setAttribute('aria-hidden', 'true');
          car2.style.cssText = 'float:right;opacity:.6;font-size:11px;margin-left:10px;';
          row.appendChild(car2);
        }
        // Hovering a childless sibling must NOT close an open flyout - that killed diagonal travel from
        // the parent row to its submenu (cursor crosses siblings / pauses on one). The flyout closes only
        // when the pointer leaves BOTH the parent menu and the submenu (see openMenu + the sub listeners).
        row.addEventListener('mouseenter', function () { row.style.background = 'var(--bwn-tint)'; if (kids) openSub(row, kids); });
        row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });
        row.addEventListener('click', function (e) {
          e.preventDefault();
          if (kids) { openSub(row, kids); focusList(subRows, 0); return; }   // reveal the flyout, don't close
          removeMenu(true); it.fn();
        });
        sink.push(row);
        return row;
      }
      function closeSub() {
        if (subCloseT) { clearTimeout(subCloseT); subCloseT = null; }
        if (sub) { sub.remove(); sub = null; subRows = []; subOwner = null; }
      }
      function scheduleSubClose() { if (subCloseT) clearTimeout(subCloseT); subCloseT = setTimeout(closeSub, 180); }
      function openSub(owner, kids) {
        if (subCloseT) { clearTimeout(subCloseT); subCloseT = null; }
        if (subOwner === owner && sub) return;
        closeSub();
        subOwner = owner;
        sub = document.createElement('div');
        sub.setAttribute('role', 'menu');
        sub.style.cssText = MENU_CSS + 'z-index:99999;';
        subRows = [];
        kids.forEach(function (k) { sub.appendChild(makeItem(k, subRows)); });
        sub.addEventListener('mouseenter', function () { if (subCloseT) { clearTimeout(subCloseT); subCloseT = null; } });
        sub.addEventListener('mouseleave', scheduleSubClose);
        document.body.appendChild(sub);
        var rr = owner.getBoundingClientRect();
        var sw = sub.offsetWidth || 240, sh = sub.offsetHeight || 240;
        var left = rr.right + 4;
        if (left + sw > window.innerWidth - 8) left = rr.left - sw - 4;   // flip left if no room to the right
        var top = Math.min(rr.top, window.innerHeight - sh - 8);
        sub.style.left = Math.max(8, Math.round(left)) + 'px';
        sub.style.top = Math.max(8, Math.round(top)) + 'px';
      }
      function removeMenu(restore) {
        if (!menu) return;
        closeSub();
        menu.remove(); menu = null; rows = [];
        car.style.transform = 'none';
        trig.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll, true);
        if (restore) { try { trig.focus(); } catch (e) { } }
      }
      function onDoc(e) { if (menu && !menu.contains(e.target) && !trig.contains(e.target) && !(sub && sub.contains(e.target))) removeMenu(false); }
      function onScroll() { removeMenu(false); }
      function onKey(e) {
        if (!menu) return;
        var inSub = !!(sub && subRows.indexOf(document.activeElement) !== -1);
        var list = inSub ? subRows : rows;
        var i = list.indexOf(document.activeElement);
        var act = document.activeElement;
        if (e.key === 'Escape') { e.preventDefault(); if (inSub) { var o = subOwner; closeSub(); if (o) o.focus(); } else removeMenu(true); }
        else if (e.key === 'Tab') { removeMenu(false); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); focusList(list, i + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusList(list, i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusList(list, 0); }
        else if (e.key === 'End') { e.preventDefault(); focusList(list, list.length - 1); }
        else if (e.key === 'ArrowRight' && !inSub && act && act._kids) { e.preventDefault(); openSub(act, act._kids); focusList(subRows, 0); }
        else if (e.key === 'ArrowLeft' && inSub) { e.preventDefault(); var ow = subOwner; closeSub(); if (ow) ow.focus(); }
      }
      function openMenu() {
        menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', label);
        menu.style.cssText = MENU_CSS;
        rows = [];
        items.forEach(function (it) { menu.appendChild(makeItem(it, rows)); });
        document.body.appendChild(menu);
        // Keep the flyout open while the pointer is anywhere in the parent menu; only arm the close
        // when it leaves the menu entirely. Re-entering the menu (or the submenu) cancels it, so a
        // menu<->submenu round trip never flickers.
        menu.addEventListener('mouseenter', function () { if (subCloseT) { clearTimeout(subCloseT); subCloseT = null; } });
        menu.addEventListener('mouseleave', scheduleSubClose);
        var r = trig.getBoundingClientRect();
        var left = Math.min(Math.round(r.left), window.innerWidth - menu.offsetWidth - 8);   // keep on-screen
        menu.style.left = Math.max(8, left) + 'px';
        menu.style.top = Math.round(r.bottom + 4) + 'px';
        car.style.transform = 'rotate(180deg)';
        trig.setAttribute('aria-expanded', 'true');
        focusAt(0);
        setTimeout(function () {
          document.addEventListener('mousedown', onDoc, true);
          document.addEventListener('keydown', onKey, true);
          window.addEventListener('scroll', onScroll, true);
          window.addEventListener('resize', onScroll, true);
        }, 0);
      }
      trig.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (menu) removeMenu(false); else openMenu();   // Enter/Space activate the button natively → this fires
      });
      trig.addEventListener('keydown', function (e) {
        if (!menu && e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
      });
      return wrap;
    }

    // ---- Accessible-dialog helper ---------------------------------------------
    // Adds role/aria, traps Tab focus, restores focus on release. {modal:true}
    // (default) also pulls focus back if it escapes a swapped-out body.
    function a11yDialog(dialogEl, opts) {
      opts = opts || {};
      var modal = opts.modal !== false;
      var prevFocus = document.activeElement;
      dialogEl.setAttribute('role', 'dialog');
      if (modal) dialogEl.setAttribute('aria-modal', 'true');
      if (opts.label) dialogEl.setAttribute('aria-label', opts.label);
      if (!dialogEl.hasAttribute('tabindex')) dialogEl.setAttribute('tabindex', '-1');
      var SEL = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
      function focusables() {
        return Array.prototype.filter.call(dialogEl.querySelectorAll(SEL), function (el) {
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        });
      }
      function onTrapKey(e) {
        if (e.key !== 'Tab' || !dialogEl.isConnected) return;
        var f = focusables(), act = document.activeElement;
        if (!f.length) { e.preventDefault(); try { dialogEl.focus(); } catch (_) {} return; }
        var first = f[0], last = f[f.length - 1];
        if (!dialogEl.contains(act)) { e.preventDefault(); first.focus(); return; }   // focus escaped (content swapped): pull it back
        if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
      }
      document.addEventListener('keydown', onTrapKey, true);
      var mo = null;
      if (modal && typeof MutationObserver === 'function') {
        mo = new MutationObserver(function (records) {
          if (!dialogEl.isConnected || dialogEl.contains(document.activeElement)) return;
          var structural = false;
          for (var i = 0; i < records.length && !structural; i++) {
            var rm = records[i].removedNodes;
            for (var j = 0; j < rm.length; j++) { if (rm[j].nodeType === 1) { structural = true; break; } }
          }
          if (!structural) return;
          try { (focusables()[0] || dialogEl).focus(); } catch (_) {}
        });
        mo.observe(dialogEl, { childList: true, subtree: true });
      }
      setTimeout(function () { try { (opts.initial || focusables()[0] || dialogEl).focus(); } catch (_) {} }, 0);
      return function release() {
        document.removeEventListener('keydown', onTrapKey, true);
        if (mo) { mo.disconnect(); mo = null; }
        try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus(); } catch (_) {}
      };
    }

    // ---- Shared utility helpers (Shared Core v3) --------------------------------
    // Canonical DOM event names for the suite bus (use these, not string literals).
    var EVENTS = { update: 'bwn:update', config: 'bwn:config', theme: 'bwn:theme' };
    function debounce(fn, ms) {
      var t = null;
      return function () { clearTimeout(t); t = setTimeout(fn, ms); };
    }
    // Clipboard write + standard button feedback; falls back to a copyable prompt.
    function copyText(text, btn, idleLabel) {
      navigator.clipboard.writeText(text).then(function () {
        if (btn) {
          btn.textContent = 'Copied ✓';
          setTimeout(function () { btn.textContent = idleLabel || 'Copy'; }, 1500);
        }
      }, function () { prompt('Copy manually:', text); });
    }
    // JSON storage wrappers: parse/stringify + quota/privacy try-catch in one place.
    function lsGetJSON(key, def) { try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : def; } catch (e) { return def; } }
    function lsSetJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } }
    function ssGetJSON(key, def) { try { var r = sessionStorage.getItem(key); return r ? JSON.parse(r) : def; } catch (e) { return def; } }
    function ssSetJSON(key, val) { try { sessionStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } }
    // ---- Failure containment (Shared Core v4) -----------------------------------
    // Modules are inline IIFEs: without containment, one module's init throw kills
    // every module declared after it - including the Ops panel that hosts the kill
    // switches. safeModule wraps module init; guard wraps long-lived callbacks
    // (observers, timers). Errors log to console AND to a capped localStorage list
    // (bwn:err:core / bwn:err:ai) for the Ops panel to surface. Never rethrown.
    var ERR_KEY = null;   // set by announceCore (needs the script name)
    function pushErr(tag, e) {
      var msg = e && e.message ? e.message : String(e);
      console.error('[BWN] ' + tag + ':', e);
      if (!ERR_KEY) return;
      var list = lsGetJSON(ERR_KEY, []);
      if (!Array.isArray(list)) list = [];
      list.push({ tag: String(tag), msg: String(msg).slice(0, 200), ts: Date.now() });
      while (list.length > 10) list.shift();
      lsSetJSON(ERR_KEY, list);
    }
    var guardMuted = {};   // record one error per tag per minute; repeats are swallowed
    function guard(fn, tag) {
      return function () {
        try { return fn.apply(this, arguments); }
        catch (e) {
          var now = Date.now();
          if (!guardMuted[tag] || now - guardMuted[tag] > 60000) {
            guardMuted[tag] = now;
            pushErr(tag || 'guard', e);
          }
        }
      };
    }
    function safeModule(id, fn) {
      try { fn(); }
      catch (e) { pushErr('module:' + id, e); }
    }

    // ---- Note-metadata resolver (Shared Core v5) ---------------------------------
    // Both scripts read note timestamps/labels off Umbrava's note cards. The
    // timestamp span's class (TocUIq_lastModifiedDate) is a hashed CSS-module name -
    // the most rename-prone selector in the suite - and a rebuild would silently
    // blank note ages (stale-note chips, Recent Update windows, audit timelines).
    // Resolution order: pinned class → session-memoized rediscovered class →
    // content heuristic (a short header-row leaf span whose text parses as a date).
    // A fallback hit is recorded once per session so drift is visible, not silent.
    var NOTE_SUMMARY_SEL = '[data-testid^="wo-note-"][data-testid$="-summary"]';
    var NOTE_TS_CLS = 'TocUIq_lastModifiedDate';   // pinned; re-pin here when Umbrava rebuilds
    function noteCard(summaryEl) {
      // Tightest ancestor that still maps to exactly one note. BOUNDED: with a
      // single note mounted, an unbounded walk would climb to <html> and make
      // label/timestamp resolution page-wide.
      var node = summaryEl;
      for (var hop = 0; hop < 8; hop++) {
        var p = node.parentElement;
        if (!p || p === document.body || p.querySelectorAll(NOTE_SUMMARY_SEL).length !== 1) break;
        node = p;
      }
      return node;
    }
    // Tolerant note-timestamp parser: absolute ("6/12/2026, 10:04 AM"), relative
    // ("2 hours ago", "yesterday"), or anything Date.parse accepts. Returns Date|null.
    function parseNoteDateLoose(ts) {
      if (!ts) return null;
      var s = String(ts).trim(), low = s.toLowerCase(), now = new Date();
      if (/\btoday\b|just now|moments? ago|\bnow\b/.test(low)) return now;
      if (/\byesterday\b/.test(low)) { var y = new Date(now); y.setDate(y.getDate() - 1); return y; }
      var rel = low.match(/(\d+)\s*(minute|min|hour|hr|day|week|month)s?\s+ago/);
      if (rel) {
        var n = parseInt(rel[1], 10), u = rel[2], d = new Date(now);
        if (/^min/.test(u)) d.setMinutes(d.getMinutes() - n);
        else if (/^h/.test(u)) d.setHours(d.getHours() - n);
        else if (/^day/.test(u)) d.setDate(d.getDate() - n);
        else if (/^week/.test(u)) d.setDate(d.getDate() - n * 7);
        else if (/^month/.test(u)) d.setMonth(d.getMonth() - n);
        return d;
      }
      var md = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
      if (md) {
        var mo = parseInt(md[1], 10), da = parseInt(md[2], 10);
        if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;   // "13/13", "12/45": not a date
        if (md[3]) {
          // Full date: prefer Date.parse so a trailing time ("6/12/2026, 10:04 AM")
          // keeps its time-of-day - day-boundary math (staleness, tie-breaks) stays
          // exact. Fall back to constructing from the matched tokens.
          var full = Date.parse(s);
          if (!isNaN(full)) return new Date(full);
          var yr = parseInt(md[3], 10); if (yr < 100) yr += 2000;
          var dtY = new Date(yr, mo - 1, da);
          return (dtY.getMonth() === mo - 1 && dtY.getDate() === da) ? dtY : null;
        }
        var dt = new Date(now.getFullYear(), mo - 1, da);
        if (dt.getMonth() !== mo - 1 || dt.getDate() !== da) return null;   // 2/30-style rollover
        if (dt.getTime() - now.getTime() > 86400000) dt.setFullYear(dt.getFullYear() - 1);   // bare M/D in the future = last year
        return dt;
      }
      var nat = Date.parse(s);
      return isNaN(nat) ? null : new Date(nat);
    }
    // Strict "is this a note TIMESTAMP" test for the fallback paths: only shapes a
    // real timestamp takes (relative, today/yesterday, M/D[/Y], month-name+day) and
    // only plausible ages - never the bare Date.parse fallback, which swallows
    // store/PO numbers ("0491" parses as the year 491).
    function looksLikeNoteTimestamp(s) {
      if (!s) return false;
      var t = String(s).trim(), low = t.toLowerCase();
      if (/^\d+$/.test(t)) return false;                       // bare number: note id, store #, PO #
      var shaped = /\btoday\b|just now|moments? ago|\bnow\b|\byesterday\b/.test(low) ||
        /\d+\s*(minute|min|hour|hr|day|week|month)s?\s+ago/.test(low) ||
        /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(t) ||
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(low);
      if (!shaped) return false;
      var d = parseNoteDateLoose(t);
      if (!d) return false;
      var age = (Date.now() - d.getTime()) / 86400000;
      return age > -2 && age < 3700;                           // plausible note age (~10 years)
    }
    function noteMetaFallbackNote(how) {
      try {
        if (sessionStorage.getItem('bwn:sel:notets:warned')) return;
        sessionStorage.setItem('bwn:sel:notets:warned', '1');
        pushErr('selector:note-ts', 'pinned note-timestamp class missing - using ' + how + ' (Umbrava rebuilt? re-pin NOTE_TS_CLS)');
      } catch (e) { /* best-effort */ }
    }
    function noteMeta(card) {
      if (!card) return { ts: '', label: '' };
      // Label: the type chip (Client/Vendor/Internal/…) - a span.ellipsis outside
      // the author/timestamp cluster AND outside the note text, and not itself a
      // timestamp-shaped string.
      var label = '';
      var spans = card.querySelectorAll('span.ellipsis');
      for (var i = 0; i < spans.length; i++) {
        if ((spans[i].className || '').indexOf('TocUIq') !== -1) continue;
        if (spans[i].closest('[data-testid$="-summary"], [data-testid$="-description"]')) continue;
        var t = (spans[i].textContent || '').trim();
        if (t && t.length <= 40 && !looksLikeNoteTimestamp(t)) { label = t; break; }
      }
      // Timestamp 1: pinned class (zero extra work while Umbrava is unchanged).
      var el = card.querySelector('span.' + NOTE_TS_CLS);
      if (el) return { ts: (el.textContent || '').trim(), label: label };
      // Which note is this card for (memoization is keyed by DISTINCT notes)?
      var sumEl = card.querySelector(NOTE_SUMMARY_SEL);
      var noteId = sumEl ? (sumEl.getAttribute('data-testid') || '').replace(/\D+/g, '') : '';
      // Timestamp 2: session-memoized rediscovered class - trusted only after it
      // matched on 3+ DISTINCT notes, and only when its text still looks like a
      // real timestamp (a generic layout class must not hijack resolution).
      var memo = ssGetJSON('bwn:sel:notets', null);
      if (memo && memo.cls && Array.isArray(memo.ids) && memo.ids.length >= 3) {
        el = card.querySelector('span[class="' + memo.cls + '"]');
        if (el && looksLikeNoteTimestamp(el.textContent)) {
          noteMetaFallbackNote('memoized class "' + memo.cls + '"');
          return { ts: (el.textContent || '').trim(), label: label };
        }
      }
      // Timestamp 3: content heuristic - the LAST short leaf span in the card's
      // header (never inside the note text itself) that is timestamp-shaped.
      var best = null;
      var leaves = card.querySelectorAll('span');
      for (var j = 0; j < leaves.length; j++) {
        var lf = leaves[j];
        if (lf.children.length) continue;
        if (lf.closest('[data-testid$="-summary"], [data-testid$="-description"]')) continue;
        var tx = (lf.textContent || '').trim();
        if (!tx || tx.length > 40) continue;
        if (looksLikeNoteTimestamp(tx)) best = lf;
      }
      if (!best) return { ts: '', label: label };
      try {
        var cls = best.getAttribute('class') || '';
        if (cls && noteId) {
          var cur = ssGetJSON('bwn:sel:notets', null);
          if (!cur || cur.cls !== cls || !Array.isArray(cur.ids)) cur = { cls: cls, ids: [] };
          if (cur.ids.indexOf(noteId) === -1) { cur.ids.push(noteId); if (cur.ids.length > 6) cur.ids.shift(); }
          ssSetJSON('bwn:sel:notets', cur);
        }
      } catch (e2) { /* best-effort */ }
      noteMetaFallbackNote('content heuristic');
      return { ts: (best.textContent || '').trim(), label: label };
    }

    // ---- Module health beacons (Shared Core v5) ----------------------------------
    // Modules report their mount lifecycle to bwn:health:{core|ai} so a module that
    // silently stopped mounting (selector drift after an Umbrava deploy) shows in
    // the Ops panel instead of just being… absent. States: 'ok' (mounted/active),
    // 'waiting' (page doesn't apply / anchors absent - normal), 'miss' (anchors
    // present but the module UI failed to appear - investigate). Use STABLE detail
    // strings: writes happen on state+detail CHANGE only. Stored in sessionStorage -
    // health is PER TAB (the Ops panel reports the tab it's opened in), so one tab's
    // page load can never wipe or misrepresent another tab's module states.
    var HEALTH_KEY = null;                        // set by announceCore
    var beatLast = {};                            // moduleId -> "state|detail"
    function beat(moduleId, state, detail) {
      var sig = state + '|' + (detail || '');
      if (beatLast[moduleId] === sig) return;
      beatLast[moduleId] = sig;
      if (!HEALTH_KEY) return;
      var blob = ssGetJSON(HEALTH_KEY, {});
      if (!blob || typeof blob !== 'object') blob = {};
      blob[moduleId] = { state: state, detail: String(detail || '').slice(0, 120), ts: Date.now() };
      ssSetJSON(HEALTH_KEY, blob);
    }

    // ---- Scroll-harvest engine (Shared Core v7) -----------------------------------
    // One implementation of the virtualized-list sweep both scripts previously
    // duplicated (WO Assist Deep Scan; AI note collection): walk the scroller in
    // 85%-viewport strides every 220ms, capturing each tick, until the item count
    // is stable at the bottom (3 quiet ticks) or the step cap (120). Lifecycle
    // rules - hard-won in the v1.8/v1.5 fixes - are the contract:
    //  - cancelled() true  → abort SILENTLY: restore scroll, call nothing;
    //  - scroller unmounted but not cancelled → re-resolve via rescroller() and
    //    continue; if none can be found, COMMIT what was captured - done(false);
    //  - stable-bottom completion → done(true); step-cap exit → done(false).
    // done(complete): true ONLY for a converged full sweep (v7). Callers publishing
    // to the shared note cache MUST respect it - a truncated top-of-list prefix
    // passes every validity check and would poison both scripts for the TTL.
    function findScroller(anchorEl) {
      var node = anchorEl ? anchorEl.parentElement : null;
      while (node && node !== document.body) {
        var st = getComputedStyle(node);
        if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 20) return node;
        node = node.parentElement;
      }
      return null;
    }
    // opts: { scroller, rescroller(), capture(), count(), cancelled(), progress(n), done(complete) }
    function harvest(opts) {
      var box = opts.scroller;
      opts.capture();
      if (!box) { opts.done(true); return; }   // not scrollable: what's mounted is ALL of it - complete
      var lastCount = -1, stable = 0, steps = 0, MAX = 120;
      box.scrollTop = 0;
      function tick() {
        if (opts.cancelled && opts.cancelled()) {
          if (box && box.isConnected) { try { box.scrollTop = 0; } catch (e) { } }
          return;
        }
        if (!box.isConnected) {
          box = opts.rescroller ? opts.rescroller() : null;
          if (!box) { opts.done(false); return; }   // list gone entirely: commit what we captured - PARTIAL
        }
        opts.capture();
        var n = opts.count();
        if (opts.progress) opts.progress(n);
        var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 5;
        stable = (n === lastCount) ? stable + 1 : 0;
        lastCount = n;
        var full = atBottom && stable >= 3;
        if (full || steps++ > MAX) {
          box.scrollTop = 0;
          opts.done(full);   // step-cap exit is PARTIAL
          return;
        }
        box.scrollTop = Math.min(box.scrollTop + box.clientHeight * 0.85, box.scrollHeight);
        setTimeout(tick, 220);
      }
      tick();
    }

    // Shared-core drift guard: each script announces the core version AND export
    // manifest it carries (bwn:corever:core / bwn:corever:ai). Because this block
    // must be pasted into BOTH files on every edit, a version mismatch means one
    // file was missed - and an export-list mismatch at the SAME version means a
    // paste dropped part of the block. Both warn loudly and show in the Ops panel.
    function announceCore(script) {
      ERR_KEY = 'bwn:err:' + script;
      HEALTH_KEY = 'bwn:health:' + script;
      ssSetJSON(HEALTH_KEY, {});                  // per-tab health; modules re-report below
      var exp = [];
      try { exp = Object.keys(BWN || {}).sort(); } catch (e) { /* called pre-assignment */ }
      lsSetJSON('bwn:corever:' + script, { v: VERSION, ts: Date.now(), exports: exp });
      // Drift check runs DEFERRED so the peer script (loading in this same page) has
      // announced its CURRENT blob first - otherwise the first load after a correct
      // both-files update would read the peer's stale pre-update blob and cry wolf.
      // A peer that did not announce recently (uninstalled/disabled) is skipped: the
      // Ops panel status row already reports it as not loaded.
      setTimeout(function () {
        var other = script === 'core' ? 'ai' : 'core';
        var peer = lsGetJSON('bwn:corever:' + other, null);
        if (!peer || Date.now() - (peer.ts || 0) > 120000) return;   // peer not live this session
        if (typeof peer.v === 'number' && peer.v !== VERSION) {
          console.warn('[BWN] SHARED CORE DRIFT: this script carries v' + VERSION + ' but the ' + other.toUpperCase() +
            ' script announced v' + peer.v + '. Paste the newer BWN SHARED CORE block into both files and re-import.');
        } else if (Array.isArray(peer.exports) && peer.exports.length && exp.length) {
          var diffs = exp.filter(function (k) { return peer.exports.indexOf(k) === -1; })
            .concat(peer.exports.filter(function (k) { return exp.indexOf(k) === -1; }));
          if (diffs.length) {
            console.warn('[BWN] SHARED CORE DRIFT: same version (v' + VERSION + ') but the export lists differ (' +
              diffs.join(', ') + ') - a paste dropped part of the block. Re-paste it into both files.');
          }
        }
      }, 2500);
    }

    return {
      VERSION: VERSION,
      woId: woId, busGet: busGet, busPut: busPut, busPatch: busPatch, busHeatGet: busHeatGet, busVendors: busVendors,
      CFG_DEFAULTS: CFG_DEFAULTS, cfg: cfg, cfgSave: cfgSave,
      CLIENT_DEFAULTS_SEED: CLIENT_DEFAULTS_SEED, CLIENT_PROFILE_SEED: CLIENT_PROFILE_SEED, bwnClientProfile: bwnClientProfile,
      money: money, parseMoney: parseMoney, parseBare: parseBare, parseUSDate: parseUSDate,
      alphaOnly: alphaOnly, lcsLen: lcsLen,
      inputVal: inputVal, setNativeValue: setNativeValue,
      GREEN: GREEN, injectTokens: injectTokens,
      getTheme: getTheme, setTheme: setTheme, applyTheme: applyTheme,
      makeDropdown: makeDropdown, a11yDialog: a11yDialog,
      EVENTS: EVENTS, debounce: debounce, copyText: copyText,
      lsGetJSON: lsGetJSON, lsSetJSON: lsSetJSON, ssGetJSON: ssGetJSON, ssSetJSON: ssSetJSON,
      safeModule: safeModule, guard: guard,
      noteCard: noteCard, noteMeta: noteMeta, parseNoteDateLoose: parseNoteDateLoose,
      NOTE_SUMMARY_SEL: NOTE_SUMMARY_SEL,
      beat: beat,
      findScroller: findScroller, harvest: harvest,
      announceCore: announceCore
    };
  })();
  BWN.injectTokens();
  BWN.applyTheme(BWN.getTheme());
  BWN.announceCore('core');
  // ===== END BWN SHARED CORE =====

  // ---- Unified toast (Task 2) -------------------------------------------------
  // BWN.toast(level, msg, opts). Deliberately OUTSIDE the byte-identical shared
  // block above (so those bytes stay paste-identical across scripts). Levels:
  // success (house green - the default look) | warning | error | info. opts:
  //   undo:    fn        -> renders an "Undo" button that runs fn() then dismisses
  //   action:  {label,onClick(dismiss)} -> a labeled button (Save/Open/etc.)
  //   timeout: ms        -> auto-dismiss (default 6000; 0 = sticky)
  //   id:      token     -> single-instance: a new toast with the same id replaces
  // Returns a dismiss() the caller can invoke. Exposed on window.bwnToast so the
  // @grant'd AI sandbox can reach it via unsafeWindow (else it uses its own).
  var BWN_TOAST_LEVELS = { success: '', warning: 'warn', error: 'error', info: 'info' };
  function bwnEnsureToastStyle() {
    if (document.getElementById('bwn-toast-css')) return;
    var s = document.createElement('style'); s.id = 'bwn-toast-css';
    s.textContent =
      '.bwn-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:100003;display:flex;align-items:center;gap:10px;max-width:90vw;background:var(--bwn-green-dk,#0d3d26);color:#fff;border-radius:10px;padding:10px 14px;box-shadow:0 12px 40px rgba(0,0,0,.4);font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
      '.bwn-toast span{flex:1;line-height:1.4;}' +
      '.bwn-toast.warn{background:var(--bwn-warn,#e67e22);}' +
      '.bwn-toast.error{background:var(--bwn-bad,#c0392b);}' +
      '.bwn-toast.info{background:#245e8a;}' +
      '.bwn-toast button{border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:7px;padding:4px 10px;font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;white-space:nowrap;}' +
      '.bwn-toast button.x{border:none;background:transparent;font-size:15px;padding:2px 4px;opacity:.85;}';
    (document.head || document.documentElement).appendChild(s);
  }
  BWN.toast = function (level, msg, opts) {
    opts = opts || {};
    try { bwnEnsureToastStyle(); } catch (e) { }
    var lvl = BWN_TOAST_LEVELS.hasOwnProperty(level) ? level : 'info';
    if (opts.id) { var prev = document.getElementById('bwn-toast-' + opts.id); if (prev) prev.remove(); }
    var t = document.createElement('div');
    t.className = 'bwn-toast' + (BWN_TOAST_LEVELS[lvl] ? ' ' + BWN_TOAST_LEVELS[lvl] : '');
    if (opts.id) t.id = 'bwn-toast-' + opts.id;
    t.setAttribute('role', (lvl === 'error' || lvl === 'warning') ? 'alert' : 'status');
    var span = document.createElement('span'); span.textContent = String(msg == null ? '' : msg); t.appendChild(span);
    var done = false;
    function dismiss() { if (done) return; done = true; if (t.parentNode) t.remove(); }
    if (typeof opts.undo === 'function') {
      var ub = document.createElement('button'); ub.type = 'button'; ub.textContent = 'Undo';
      ub.addEventListener('click', function () { try { opts.undo(); } catch (e) { } dismiss(); });
      t.appendChild(ub);
    }
    if (opts.action && opts.action.label && typeof opts.action.onClick === 'function') {
      var ab = document.createElement('button'); ab.type = 'button'; ab.textContent = String(opts.action.label);
      ab.addEventListener('click', function () { try { opts.action.onClick(dismiss); } catch (e) { } });
      t.appendChild(ab);
    }
    var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '✕';
    x.addEventListener('click', dismiss); t.appendChild(x);
    (document.body || document.documentElement).appendChild(t);
    var ms = typeof opts.timeout === 'number' ? opts.timeout : 6000;
    if (ms > 0) setTimeout(dismiss, ms);
    return dismiss;
  };
  try { window.bwnToast = BWN.toast; } catch (e) { }

  // ==========================================================================
  // BOOT: document-start for the network hook, load event for the modules
  // ==========================================================================
  // This script ran at `@run-at document-idle` until 1.66.28. Measured on the live
  // Work Orders list 2026-08-04, four reloads of the same page:
  //
  //   core script starts | GraphQL calls landing after it | List Heat auto-scan
  //   4015 ms            | 0 of 17                        | never ran
  //   1464 ms            | 15 of 18                       | ran
  //   3466 ms            | 0 of 17                        | never ran
  //   1822 ms            | 14 of 18                       | ran
  //
  // The app's FIRST GraphQL request starts at ~1240 ms (domContentLoaded 1068 ms,
  // load 1253 ms). List Heat's capture is passive - it can only latch a board query
  // that fires AFTER its hook is installed - so a late injection means `apiList`
  // stays null, the v3.17 auto-scan returns on its first guard, and the coordinator
  // silently gets viewport-only numbers until they press Scan All. Correlation over
  // those four loads was exact: calls-after-script > 0 iff the scan ran.
  //
  // document-start fixes it because our whole script runs before any page script.
  // The cost is that NOTHING page-related exists yet, so the modules are deferred
  // back to the load event - which is where document-idle put them anyway. The three
  // boot calls above are safe there already: injectTokens falls back to
  // documentElement when there is no head, applyTheme only touches documentElement,
  // and announceCore is storage + a timer.
  //
  // Umbrava exposes no client cache to read the query out of instead - checked live
  // for __APOLLO_CLIENT__ and the Apollo / React Query / Relay devtools hooks.

  // ---- The hook itself. Installed NOW; consumers attach later. ---------------
  // Buffers request bodies until List Heat is alive to receive them, then becomes a
  // straight pass-through. Deliberately dumb: it knows nothing about WO rows, so the
  // whole capture decision (route gate, board-shape gate, anti-downgrade) stays in
  // heatRecordCapture where it is tested. The response clone is a BONUS on the same
  // path - v3.18 measured that clone reads lose races, so nothing may depend on it.
  var BWN_GQL_SINK = null;
  var BWN_GQL_BUF = [];
  var BWN_GQL_BUF_MAX = 40;   // bounded: a page that never attaches a sink must not grow forever
  function bwnGqlSeen(body, data) {
    if (BWN_GQL_SINK) { try { BWN_GQL_SINK(body, data); } catch (e) { /* consumer's problem */ } return; }
    if (BWN_GQL_BUF.length < BWN_GQL_BUF_MAX) BWN_GQL_BUF.push([body, data]);
  }
  // Attach a consumer and hand it everything seen so far, oldest first. Idempotent in
  // the sense that matters: the buffer is emptied before the replay, so a second call
  // cannot re-deliver the same request twice.
  function bwnGqlSetSink(fn) {
    BWN_GQL_SINK = fn;
    var buf = BWN_GQL_BUF;
    BWN_GQL_BUF = [];
    for (var i = 0; i < buf.length; i++) {
      try { fn(buf[i][0], buf[i][1]); } catch (e) { /* one bad frame must not stop the drain */ }
    }
    return buf.length;
  }
  (function installGqlHook() {
    if (window.__bwnHeatNetHook) return;
    window.__bwnHeatNetHook = true;
    function isGqlUrl(u) { return typeof u === 'string' && /\/api\/graphql\b/.test(u); }
    try {
      var of = window.fetch;
      if (typeof of === 'function') {
        window.fetch = function (input, init) {
          var url = (typeof input === 'string') ? input : (input && input.url) || '';
          var body = (init && init.body) || (input && input.body) || null;
          var p = of.apply(this, arguments);
          if (isGqlUrl(url) && body) {
            try { bwnGqlSeen(body, null); } catch (e) { }
            try {
              p.then(function (res) {
                try { res.clone().json().then(function (j) { if (j && j.data) bwnGqlSeen(body, j.data); }, function () { }); } catch (e) { }
                return res;
              }, function () { });
            } catch (e) { }
          }
          return p;
        };
      }
    } catch (e) { }
    try {
      var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__bwnUrl = u; return oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function (body) {
        var xhr = this;
        if (isGqlUrl(xhr.__bwnUrl) && body) {
          try { bwnGqlSeen(body, null); } catch (e) { }
          xhr.addEventListener('load', function () {
            try { var j = JSON.parse(xhr.responseText); if (j && j.data) bwnGqlSeen(body, j.data); } catch (e) { }
          });
        }
        return oSend.apply(this, arguments);
      };
    } catch (e) { }
    console.info('[BWN] GraphQL hook installed at document-start - waiting for a consumer.');
  })();

  // ---- Module dispatch, deferred to the load event ---------------------------
  // Every module below is registered through bwnBoot instead of running inline, so a
  // module body still sees the same page state it saw at document-idle: body present,
  // subresources done. A module registered after the flush (there are none today)
  // still runs immediately rather than being dropped.
  var BWN_BOOTED = false;
  var BWN_BOOT_Q = [];
  function bwnBoot(id, on, fn) {
    if (!on) return;
    if (BWN_BOOTED) { BWN.safeModule(id, fn); return; }
    BWN_BOOT_Q.push([id, fn]);
  }
  function bwnBootAll() {
    if (BWN_BOOTED) return;
    BWN_BOOTED = true;
    var q = BWN_BOOT_Q;
    BWN_BOOT_Q = [];
    for (var i = 0; i < q.length; i++) BWN.safeModule(q[i][0], q[i][1]);
  }

  // ===== BEGIN bwnNotesApi =====
  // Notes WITHOUT scraping the list (2026-08-04). Both the AI drafts' collect and WO
  // Assist's Deep Scan used to walk the VIRTUALIZED notes list by scrolling it: slow,
  // and only ever as complete as the sweep managed to see. Umbrava's own API answers
  // the same question in ONE call. Measured on W-283834:
  //   workOrderNotes(workOrderNumber: 283834) -> 308 notes, while the DOM had 17
  //   mounted; all 17 bodies byte-identical to the rendered text (`content` is PLAIN
  //   TEXT - do not strip "tags", it eats <someone@example.com>); createdDate is an
  //   absolute ISO stamp instead of the relative strings a scrape has to guess at.
  // The note TYPE comes back as an int, so noteTypesV2 supplies the label map (82 rows,
  // cached for a day) - all 17 mounted labels matched their type name.
  // Same-origin fetch on the app's own bearer, so @grant none still holds.
  // EVERY failure path REJECTS so the caller falls back to the scroll sweep: no token,
  // schema drift, a non-list payload, or a read that does not even contain the notes
  // currently on screen. Degrading to the old behaviour is fine; silently handing a
  // draft a partial history is not.
  // Byte-identical in bwn-suite-core and bwn-suite-ai - scripts/test-notes-api.js gates
  // that with a SHA, the same rule as the bwnAI transport block.
  var BWN_NOTES_TYPES_KEY = 'bwn:noteTypes';
  var BWN_NOTES_TYPES_TTL = 24 * 3600000;
  var BWN_NOTES_QUERY = 'query BwnWorkOrderNotes($n: Int!) { workOrderNotes(workOrderNumber: $n) { id type content createdDate lastModifiedDate isDeleted } }';
  // Auth0 access token from the SPA's own cache, picked by CONTENT: the audience slot
  // transiently holds non-Umbrava tokens, so the issuer and expiry are checked.
  function bwnNotesToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (!tok) continue;
        var parts = String(tok).split('.');
        if (parts.length !== 3) continue;
        var p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        var iss = String(p.iss || '').replace(/\/+$/, '');
        if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') continue;
        if (typeof p.exp === 'number' && (Date.now() / 1000) > p.exp) continue;
        return tok;
      }
    } catch (e) { }
    return '';
  }
  function bwnNotesGql(query, variables) {
    var tok = bwnNotesToken();
    if (!tok) return Promise.reject(new Error('no live Umbrava token in this tab'));
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      if (!j || !j.data) throw new Error('empty GraphQL response');
      return j.data;
    });
  }
  // type id -> label. A failure here must NOT fail the notes read: labels degrade to '',
  // which only widens a keep-list filter. It can never invent or drop a note.
  function bwnNoteTypeMap() {
    try {
      var c = JSON.parse(localStorage.getItem(BWN_NOTES_TYPES_KEY) || 'null');
      if (c && c.v === 1 && c.map && (Date.now() - (c.ts || 0)) < BWN_NOTES_TYPES_TTL) return Promise.resolve(c.map);
    } catch (e) { }
    return bwnNotesGql('{ noteTypesV2 { id name } }').then(function (d) {
      var map = {};
      (d.noteTypesV2 || []).forEach(function (t) { if (t && t.id != null) map[String(t.id)] = String(t.name == null ? '' : t.name); });
      try { localStorage.setItem(BWN_NOTES_TYPES_KEY, JSON.stringify({ v: 1, ts: Date.now(), map: map })); } catch (e2) { }
      return map;
    }, function () { return {}; });
  }
  // Render the ISO stamp the way the notes list renders it ("6/24/2026, 9:52 AM") so
  // every existing consumer - parseNoteDateLoose, looksLikeNoteTimestamp, the staleness
  // math - reads an API note exactly as it read a scraped one. tsAbs carries the exact
  // epoch beside it, so nothing has to re-parse to be precise.
  function bwnNotesTsText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(+d)) return '';
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    var mm = d.getMinutes(); mm = (mm < 10 ? '0' : '') + mm;
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ', ' + h + ':' + mm + ' ' + ap;
  }
  // Coverage gate: if the notes list is on screen, every note MOUNTED in it must be in
  // the API result. That is the one check that catches a read of the wrong thing without
  // trusting counts. Nothing mounted = nothing to check (the API is then the only source).
  function bwnNotesApiCovers(list) {
    var have = {};
    (list || []).forEach(function (n) { have[String(n.id)] = 1; });
    var mounted = document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]');
    for (var i = 0; i < mounted.length; i++) {
      var m = (mounted[i].getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/);
      if (m && !have[m[1]]) return false;
    }
    return true;
  }
  // Resolves [{id, label, ts, tsAbs, body}] - the SAME shape the scrape produces and the
  // shared bwn:notes bus stores, so no consumer downstream can tell the difference.
  function bwnNotesApi(woNumber) {
    var n = parseInt(String(woNumber == null ? '' : woNumber).replace(/\D/g, ''), 10);
    if (!n) return Promise.reject(new Error('no WO number for the notes read'));
    return bwnNoteTypeMap().then(function (types) {
      return bwnNotesGql(BWN_NOTES_QUERY, { n: n });
    }, function () { return bwnNotesGql(BWN_NOTES_QUERY, { n: n }); }).then(function (d) {
      var rows = d && d.workOrderNotes;
      if (!Array.isArray(rows)) throw new Error('workOrderNotes did not return a list');
      var types = {};
      try { var c = JSON.parse(localStorage.getItem(BWN_NOTES_TYPES_KEY) || 'null'); if (c && c.map) types = c.map; } catch (e) { }
      var out = [];
      rows.forEach(function (r) {
        if (!r || r.isDeleted) return;               // the list does not show deleted notes
        var iso = r.createdDate || r.lastModifiedDate || '';
        var dt = iso ? new Date(iso) : null;
        out.push({
          id: String(r.id),
          label: (r.type != null && types[String(r.type)]) || '',
          ts: bwnNotesTsText(iso),
          tsAbs: (dt && !isNaN(+dt)) ? +dt : null,
          body: String(r.content == null ? '' : r.content).trim()
        });
      });
      if (!bwnNotesApiCovers(out)) throw new Error('API notes did not include every note on screen - not trusting it');
      return out;
    });
  }
  // ===== END bwnNotesApi =====

  // ---- Shared status-clock engine (single source of truth) -------------------
  // ONE priority-scaled per-status time budget, used by BOTH List Heat (row
  // verdicts + offender ranking) AND WO Assist (stuck / escalate judgement) so the
  // two engines can never disagree about when a WO is "past its limit". Deliberately
  // NOT in the BWN shared-core block above (that must stay byte-identical across the
  // suite scripts); this is file-local to bwn-suite-core, where both modules live in
  // the same outer IIFE. Formula is unchanged from List Heat's original thresholdsFor
  // - only its home moved, so the mature/live-tested behavior is preserved.
  //   bwnThresholdsFor(status, prioText, C) -> { warn, bad } hours. Status class
  //   (active/blocked) and priority (P1..P4) scale the base hrsWarn/hrsBad from config.
  //   Unknown class/priority -> neutral 1.0 (never harsher by guessing).
  var BWN_HEAT_CFG = {
    ACTIVE_RE: /scheduled|in progress|dispatch|on[\s-]?site/i,
    BLOCKED_RE: /pending materials|awaiting 3rd|third party|client action|awaiting proposal|awaiting po|on hold/i,
    BLOCKED_MULT: 1.0,
    PRIO_MULT: { 1: 0.25, 2: 0.5, 3: 1.0, 4: 1.5 },
    // Normalized priority tier off the row's own `priority.category` - measured live
    // 2026-08-04 as "Emergency" | "High" | "Standard". This matters because the P1..P4
    // parse below only fires on a "P<n>"-shaped label, and MOST clients do not use one:
    // "SEV 4", "STANDARD-2 BUSINESS DAYS", "Normal", "Unknown", "High (within 4-24 hrs)"
    // and "Emergency Life/Safety/Operations: Same Day Service" are all real live labels
    // and every one of them fell through to a neutral 1.0. Priority scaling was silently
    // inert for most of the board; only Pilot's "P2 Next Day"-style labels ever scaled.
    CAT_MULT: { emergency: 0.25, high: 0.5, standard: 1.0 },
    // Response-clock basis: `priority.responseMinutes` IS the client's own promise, in
    // minutes, per WO. Scaled against a 24h day, then clamped - one absurd SLA must not
    // pin a row permanently red (floor) or permanently quiet (ceiling).
    RESP_BASE_MIN: 1440, RESP_MULT_MIN: 0.25, RESP_MULT_MAX: 2.0
  };
  function bwnPrioNum(prioText) { var m = String(prioText || '').match(/p\s*([1-4])/i); return m ? +m[1] : null; }
  function bwnPrioMult(prioText) { var pn = bwnPrioNum(prioText); return (pn && BWN_HEAT_CFG.PRIO_MULT[pn]) || 1; }
  // The multiplier the row's OWN SLA facts imply, or null when there are none. Best
  // evidence first: a real response clock in minutes, then the normalized category, then
  // nothing (so the caller falls back to the label parse). Never guesses harsher.
  function bwnSlaMult(sla) {
    if (!sla) return null;
    var rm = Number(sla.responseMinutes);
    if (isFinite(rm) && rm > 0) {
      return Math.max(BWN_HEAT_CFG.RESP_MULT_MIN,
        Math.min(BWN_HEAT_CFG.RESP_MULT_MAX, rm / BWN_HEAT_CFG.RESP_BASE_MIN));
    }
    var cat = String(sla.category || '').trim().toLowerCase();
    if (BWN_HEAT_CFG.CAT_MULT[cat] !== undefined) return BWN_HEAT_CFG.CAT_MULT[cat];
    return null;
  }
  // `sla` is OPTIONAL and purely additive: { responseMinutes, category } straight off the
  // row's `priority` object. Every existing caller passes three args and behaves exactly
  // as before - WO Assist's header read and List Heat's DOM scan have no SLA facts, so the
  // mature live-tested path is untouched. Only the API scan, which does have them, scales
  // off the client's real clock instead of a string parsed out of a display label.
  function bwnThresholdsFor(status, prioText, C, sla) {
    C = C || BWN.cfg();
    var mult = 1.0;
    if (BWN_HEAT_CFG.ACTIVE_RE.test(status)) mult *= C.activeMult;
    else if (BWN_HEAT_CFG.BLOCKED_RE.test(status)) mult *= BWN_HEAT_CFG.BLOCKED_MULT;
    var sm = bwnSlaMult(sla);
    if (sm !== null) mult *= sm;
    else {
      var pn = bwnPrioNum(prioText);
      if (pn && BWN_HEAT_CFG.PRIO_MULT[pn]) mult *= BWN_HEAT_CFG.PRIO_MULT[pn];
    }
    return { warn: C.hrsWarn * mult, bad: C.hrsBad * mult, sla: sm !== null };
  }

  // ---- Next-actions engine, published across module closures -------------------
  // `computeNextActions` is a PURE fn but it lives inside the WO Assist module's IIFE
  // together with its taxonomy (WO_PHASE, scoreAct, ACT_*), and List Heat is a separate
  // IIFE - so the audit could not reach it. The engine registers itself here at its point
  // of definition rather than being moved: moving a mature, live-tested engine (and its
  // dependency graph) to file level is a far bigger change than publishing a reference.
  // Stays null if the WO Assist module is disabled by config, and every consumer must
  // null-guard - the audit then simply shows no next step instead of a wrong one.
  var bwnActsEngine = null;

  // ---- File-level same-origin GraphQL (shared by WO Assist reads + List Heat) --
  // @grant none: a plain SAME-ORIGIN POST to /api/graphql carries the app's Auth0
  // bearer; token content-picked from the SPA's @@auth0spajs@@ cache (the audience
  // slot transiently holds non-Umbrava tokens), the same rule List Heat's heatGql
  // uses. Resolves to `data`, throws on errors[]. Lifted to file level so the WO
  // Assist closure can read the WO too (heatGql stays List-Heat-local; converge later).
  // ===== BWN-SHARED START v1 (paste-identical; pinned by scripts/test-shared-block-ledger.js) =====
  function isUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function authToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (tok && isUmbravaToken(tok)) return tok;
      }
      return '';
    } catch (e) { return ''; }
  }
  // ===== BWN-SHARED END v1 =====
  function bwnGql(query, variables) {
    var tok = authToken();
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      return j && j.data;
    });
  }

  // ===== BWN-OPS START v1 (operation registry + audited GraphQL wrapper; sliced by scripts/test-bwn-ops.js) =====
  // The suite's safety spine for /api/graphql. bwnGqlOp() classifies an operation against
  // BWN_OPS, stamps a correlation id, applies a conservative retry policy, and - for writes -
  // records a structured audit entry (before/after, outcome, corrId) in a bounded local ring
  // buffer. ADDITIVE: bwnGql() above stays the raw transport and every existing caller is
  // untouched; a module opts in by routing its write through bwnGqlOp(). Nothing here invents a
  // selector - the caller always passes the CAPTURED query text (Hard Rule 6; the op catalog is
  // wiki/umbrava-graphql-operations.md). The registry is metadata, never a query store.
  // ponytail: Core-only for now (bwnGql is Core-only). Duplicate into the suite-ai sandbox,
  // SHA-gated like BWN-SHARED, only once a suite-ai writer adopts it.
  //
  // Registry entry fields:
  //   kind       'read' | 'write'
  //   target     the object type touched (for the audit trail)
  //   risk       'low' | 'moderate' | 'high' (writes only) - drives the confirm UI in a later slice
  //   idempotent same call, same end state - safe to repeat
  //   retry      'safe' | 'none'. 'safe' auto-retries a TRANSIENT failure, and ONLY when
  //              kind==='read' OR idempotent===true. A non-idempotent write is NEVER auto-retried
  //              (there is no idempotency key for these Umbrava mutations).
  //   metered    a paid / server-side-LLM call - never retried, never looped over a board
  //   ok / fail  user-facing toast text a caller may surface
  var BWN_OPS = {
    // ---- reads (idempotent; a transient failure may be retried) ----
    workOrder:               { kind: 'read', target: 'workOrder',  retry: 'safe' },
    jobNotes:                { kind: 'read', target: 'note',       retry: 'safe' },
    workOrderNotes:          { kind: 'read', target: 'note',       retry: 'safe' },
    jobDocuments:            { kind: 'read', target: 'document',   retry: 'safe' },
    purchaseOrders:          { kind: 'read', target: 'po',         retry: 'safe' },
    workOrderTrips:          { kind: 'read', target: 'trip',       retry: 'safe' },
    purchaseOrderTrips:      { kind: 'read', target: 'trip',       retry: 'safe' },
    jobIVRs:                 { kind: 'read', target: 'ivr',        retry: 'safe' },
    listWorkOrdersPaginated: { kind: 'read', target: 'workOrder',  retry: 'safe' },
    lookupJob:               { kind: 'read', target: 'workOrder',  retry: 'safe' },
    lookupVendors:           { kind: 'read', target: 'vendor',     retry: 'safe' },
    getAssignableVendors:    { kind: 'read', target: 'vendor',     retry: 'safe' },
    tasks:                   { kind: 'read', target: 'task',       retry: 'safe' },
    tasksByEntityTypeAndId:  { kind: 'read', target: 'task',       retry: 'safe' },
    user:                    { kind: 'read', target: 'user',       retry: 'safe' },
    userPreference:          { kind: 'read', target: 'preference', retry: 'safe' },
    listVendorProposals:     { kind: 'read', target: 'proposal',   retry: 'safe' },
    listClientProposals:     { kind: 'read', target: 'proposal',   retry: 'safe' },
    // metered server-side LLM summary, keyed by INTERNAL jobId - do NOT loop it over a board
    workOrderNotesSummary:   { kind: 'read', target: 'note', retry: 'none', metered: true },

    // ---- low-risk writes (personal UI state) ----
    putUserPreference: { kind: 'write', target: 'preference', risk: 'low', idempotent: true, retry: 'safe',
      ok: 'View saved.', fail: 'Could not save the view.' },

    // ---- moderate-risk writes ----
    addEditJobNote: { kind: 'write', target: 'note', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Note posted.', fail: 'The note was not posted.' },
    addClientProposalNote: { kind: 'write', target: 'proposal', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Proposal note posted.', fail: 'The proposal note was not posted.' },
    addVendorProposalNote: { kind: 'write', target: 'proposal', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Vendor-proposal note posted.', fail: 'The note was not posted.' },
    initializeJobDocument: { kind: 'write', target: 'document', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Document upload started.', fail: 'The upload could not start.' },
    bulkAddWorkOrderDocuments: { kind: 'write', target: 'document', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Documents attached.', fail: 'The documents were not attached.' },
    addTask: { kind: 'write', target: 'task', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Task created.', fail: 'The task was not created.' },
    completeTask: { kind: 'write', target: 'task', risk: 'moderate', idempotent: true, retry: 'none',
      ok: 'Task completed.', fail: 'The task was not completed.' },
    deactivateVendor: { kind: 'write', target: 'vendor', risk: 'moderate', idempotent: true, retry: 'none',
      ok: 'Vendor deactivated.', fail: 'The vendor was not deactivated.' },

    // ---- high-risk writes (dispatch, status/ECD, create, activation) ----
    patchWorkOrder: { kind: 'write', target: 'workOrder', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Work order updated.', fail: 'The work order was not updated.' },
    addWorkOrder: { kind: 'write', target: 'workOrder', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Work order created.', fail: 'The work order was not created.' },
    addDependentVendor: { kind: 'write', target: 'vendor', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Vendor created.', fail: 'The vendor was not created.' },
    activateVendor: { kind: 'write', target: 'vendor', risk: 'high', idempotent: true, retry: 'none',
      ok: 'Vendor activated.', fail: 'The vendor was not activated.' }
  };

  // ===== BWN-OPS-WRAP START v2 (paste-identical across adopters; SHA-gated by scripts/test-bwn-ops.js) =====
  // Generic machinery only - NO registry, NO window hook - so it is byte-identical in every
  // sandbox that adopts it (Core, drop-upload, ...). It closes over four things each sandbox
  // supplies on its own: BWN_OPS (that file's registry), BWN_MODULES (kill switches), BWN_VER,
  // and bwnGql(query, variables) (that file's same-origin transport). The audit ring buffer
  // writes to the shared localStorage key, so every sandbox's writes land in ONE audit trail.
  function bwnCorrId() {
    try { if (window.crypto && window.crypto.randomUUID) return 'bwn-' + window.crypto.randomUUID(); }
    catch (e) { /* fall through to the timestamp form */ }
    return 'bwn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Bounded, PII-free audit ring buffer in localStorage. Records ONLY what the caller passes
  // (ids + scalar before/after) plus operation metadata - NEVER the raw variables or the
  // response, which can carry note text, addresses, or vendor identity.
  var BWN_AUDIT_KEY = 'bwn:audit', BWN_AUDIT_MAX = 200, BWN_AUDIT_SCHEMA = 1;
  function bwnAuditAll() {
    try { var a = JSON.parse(localStorage.getItem(BWN_AUDIT_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function bwnAuditRecord(entry) {
    try {
      var a = bwnAuditAll();
      a.push(entry);
      if (a.length > BWN_AUDIT_MAX) a = a.slice(a.length - BWN_AUDIT_MAX);
      localStorage.setItem(BWN_AUDIT_KEY, JSON.stringify(a));
    } catch (e) { /* audit is best-effort - it must never block or fail a write */ }
    return entry;
  }
  function bwnAuditExport() {
    return JSON.stringify({ schema: BWN_AUDIT_SCHEMA, ver: BWN_VER, exportedTs: Date.now(), entries: bwnAuditAll() }, null, 2);
  }
  function bwnAuditClear() { try { localStorage.removeItem(BWN_AUDIT_KEY); } catch (e) { /* best-effort */ } }
  function bwnAuditActor() {
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      return (r && (r.label || r.role)) || 'unknown';
    } catch (e) { return 'unknown'; }
  }

  // Only a network-level failure is transient. A GraphQL validation error comes back through
  // bwnGql as a thrown Error carrying the server's message (deterministic - retrying just
  // repeats it), and a write refused with success:false is flagged bwnNonTransient below.
  // ponytail: bwnGql does not surface the HTTP status, so 429/5xx are not distinguished here;
  // attach r.status in bwnGql and widen this test if status-aware backoff is ever needed.
  function bwnIsTransient(err) {
    if (err && err.bwnNonTransient) return false;
    return /network|failed to fetch|load failed|timeout|timed out/i.test(String(err && err.message || err));
  }
  function bwnBackoff(tryNo) { return Math.min(4000, 400 * Math.pow(2, tryNo - 1)); }
  function bwnDelay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // bwnGqlOp(op, query, variables, opts) -> Promise(data)
  //   op        BWN_OPS key. THROWS if unregistered - a captured op must be classified before
  //             it can be sent, which is what keeps guessed selectors out of the suite.
  //   query     the captured GraphQL document TEXT - the caller owns it, never invented here.
  //   variables the variables object (sent as-is to bwnGql; never copied into the audit).
  //   opts      { feature, validate, ids, before, after, actor } - all optional:
  //     feature   BWN_MODULES key; if that module is switched off the op is REFUSED and, for a
  //               write, audited outcome:'denied' - this is the per-feature kill switch.
  //     validate  fn(variables) -> true | 'message'; a write is blocked before it is sent.
  //     ids       { wo, po, vendorId, ... } scalar identifiers for the audit trail (NO PII).
  //     before    scalar snapshot of the value(s) about to change (NO PII, NO bulk data).
  //     after     scalar snapshot of the intended new value(s).
  //     actor     who initiated; defaults to the last-known rank label, else 'unknown'.
  // Reads resolve to `data`. A write whose {success,message} envelope says success:false is
  // REJECTED (never a silent false - the exact bug class the op-catalog warns about) and
  // audited outcome:'error'.
  // Injected per-sandbox by a caller that owns a high-risk write's confirmation UI, via
  // bwnGqlOp.setConfirm(fn). A risk:'high' write is refused unless the caller either passes
  // opts.confirmed===true (it confirmed through its own UI) OR a confirm handler returns truthy.
  var _confirmFn = null;
  function bwnGqlOp(op, query, variables, opts) {
    opts = opts || {};
    var meta = BWN_OPS[op];
    if (!meta) return Promise.reject(new Error('bwnGqlOp: unregistered operation "' + op + '"'));
    var isWrite = meta.kind === 'write';
    var corrId = bwnCorrId();
    var t0 = Date.now();
    var actor = opts.actor || bwnAuditActor();

    function writeAudit(outcome, extra) {
      if (!isWrite) return;
      var e = {
        ts: Date.now(), corrId: corrId, op: op, kind: meta.kind, target: meta.target,
        risk: meta.risk || null, actor: actor, ids: opts.ids || null,
        before: (opts.before === undefined ? null : opts.before),
        after: (opts.after === undefined ? null : opts.after),
        outcome: outcome, ms: Date.now() - t0, ver: BWN_VER
      };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]; } }
      bwnAuditRecord(e);
    }

    // Per-feature kill switch: a disabled module must not mutate even if its UI leaked in.
    if (opts.feature && BWN_MODULES[opts.feature] === false) {
      writeAudit('denied', { reason: 'feature-off:' + opts.feature });
      return Promise.reject(new Error('bwnGqlOp: feature "' + opts.feature + '" is disabled'));
    }
    // Validate a write BEFORE it leaves the browser.
    if (isWrite && typeof opts.validate === 'function') {
      var vr = opts.validate(variables);
      if (vr !== true) {
        writeAudit('denied', { reason: 'validation:' + vr });
        return Promise.reject(new Error('bwnGqlOp: validation failed for "' + op + '": ' + vr));
      }
    }

    var maxTries = (meta.retry === 'safe' && (meta.kind === 'read' || meta.idempotent === true)) ? 3 : 1;
    function attempt(tryNo) {
      return bwnGql(query, variables).then(function (data) {
        if (isWrite) {
          var env = data && data[op];
          if (env && env.success === false) {
            var refused = new Error(env.message || (op + ' was refused'));
            refused.bwnNonTransient = true;
            writeAudit('error', { tries: tryNo, reason: refused.message });
            throw refused;
          }
          writeAudit('ok', { tries: tryNo });
        }
        return data;
      }, function (err) {
        if (bwnIsTransient(err) && tryNo < maxTries) {
          return bwnDelay(bwnBackoff(tryNo)).then(function () { return attempt(tryNo + 1); });
        }
        writeAudit('error', { tries: tryNo, reason: String(err && err.message || err) });
        throw err;
      });
    }
    // High-risk confirmation gate (fail-closed). A risk:'high' write must be proven confirmed:
    // either the caller passes opts.confirmed===true (it ran its own confirm UI, e.g. dispatch's
    // modal) OR an injected _confirmFn returns truthy. Neither -> refused, never a silent send.
    if (isWrite && meta.risk === 'high' && opts.confirmed !== true) {
      if (typeof _confirmFn !== 'function') {
        writeAudit('denied', { reason: 'confirm-required' });
        return Promise.reject(new Error('bwnGqlOp: "' + op + '" is high-risk and needs confirmation (no confirm handler set)'));
      }
      var details = {
        op: op, target: meta.target, risk: meta.risk, ids: opts.ids || null,
        current: (opts.current === undefined ? null : opts.current),
        proposed: (opts.proposed === undefined ? null : opts.proposed),
        count: (opts.count === undefined ? null : opts.count),
        reason: opts.reason || null, irreversible: !!opts.irreversible
      };
      return Promise.resolve().then(function () { return _confirmFn(details); }).then(function (okd) {
        if (!okd) {
          writeAudit('denied', { reason: 'user-cancelled' });
          throw new Error('bwnGqlOp: "' + op + '" cancelled at confirmation');
        }
        return attempt(1);
      });
    }
    return attempt(1);
  }
  bwnGqlOp.setConfirm = function (fn) { _confirmFn = (typeof fn === 'function') ? fn : null; };
  // ===== BWN-OPS-WRAP END v2 =====

  // Console diagnostics/export hook - lets a coordinator or admin read and export the local
  // audit trail today, before any writer adopts the wrapper. Read-only; carries no PII beyond
  // what a write chose to record. (Same shape as the suite's other window.__bwn* dev hooks.)
  // Core-only: NOT part of the paste-identical WRAP block above.
  try {
    window.__bwnOps = {
      registry: BWN_OPS, run: bwnGqlOp, corrId: bwnCorrId,
      audit: { all: bwnAuditAll, export: bwnAuditExport, clear: bwnAuditClear }
    };
  } catch (e) { /* non-fatal */ }
  // ===== BWN-OPS END v1 =====

  // ---- Core-local shared helpers (PO Approval + Leak Guard) --------------------
  // Distinctive-token vendor matching: "does this recipient text belong to this
  // vendor?" Raw LCS overlap mis-identified vendors through shared trade words -
  // lcs('JONES ELECTRIC', 'smithelectric…') = ELECTRIC (8) cleared the old ≥6 bar.
  // Only tokens DISTINCTIVE of the vendor count; a vendor whose name has no
  // distinctive token keeps the legacy LCS overlap so it still matches somehow.
  var BWN_GENERIC_WORDS = ['LLC', 'INC', 'CO', 'CORP', 'COMPANY', 'THE', 'SERVICE', 'SERVICES', 'PROVIDER',
    'ELECTRIC', 'ELECTRICAL', 'PLUMBING', 'HVAC', 'MECHANICAL', 'CONSTRUCTION', 'CONTRACTOR',
    'CONTRACTORS', 'CONTRACTING', 'GROUP', 'SOLUTIONS', 'NATIONAL', 'AND', 'OF'];
  function bwnVendorTokens(name) {
    return (name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length >= 4 && BWN_GENERIC_WORDS.indexOf(w) === -1; });
  }
  // recipientRaw = the recipient field's raw text. Returns {hit, token}; token is
  // null when the match came from an overlap fallback. Matching rules:
  //  - tokens must START a word ("GRID" must not hit inside "INGRID"); tokens of
  //    6+ letters may also match mid-word ("johnvirtue@…");
  //  - spelling variants match via LCS over the DISTINCTIVE letters only, so a
  //    generic trade word (ELECTRIC = 8) can never clear the bar by itself;
  //  - names with no distinctive token keep the legacy full-name LCS >= 6;
  //  - names whose distinctive letters are too short to test ("AB24 Electric")
  //    require nearly the WHOLE compressed name in the recipient.
  function bwnVendorMatch(vendorName, recipientRaw) {
    if (!vendorName || !recipientRaw) return { hit: false, token: null };
    var key = '|' + String(recipientRaw).toUpperCase().split(/[^A-Z0-9]+/)
      .map(function (w) { return w.replace(/[^A-Z]/g, ''); }).filter(Boolean).join('|') + '|';
    var alpha = BWN.alphaOnly(recipientRaw);
    var toks = bwnVendorTokens(vendorName);
    for (var i = 0; i < toks.length; i++) {
      var alphaTok = toks[i].replace(/[^A-Z]/g, '');
      if (alphaTok.length < 4) continue;
      if (key.indexOf('|' + alphaTok) !== -1) return { hit: true, token: toks[i] };
      if (alphaTok.length >= 6 && alpha.indexOf(alphaTok) !== -1) return { hit: true, token: toks[i] };
    }
    var distinct = toks.map(function (t2) { return t2.replace(/[^A-Z]/g, ''); }).join('');
    if (distinct.length >= 6 && BWN.lcsLen(distinct, alpha) >= 6) return { hit: true, token: null };
    var fullAlpha = BWN.alphaOnly(vendorName);
    if (!toks.length) {
      if (BWN.lcsLen(fullAlpha, alpha) >= 6) return { hit: true, token: null };
    } else if (distinct.length < 6) {
      if (fullAlpha.length >= 6 && BWN.lcsLen(fullAlpha, alpha) >= Math.max(9, fullAlpha.length - 2)) return { hit: true, token: null };
    }
    return { hit: false, token: null };
  }


  // ==========================================================================
  // MODULE: PO Approval + ETA Builder v1.12
  // ==========================================================================
  bwnBoot('poApproval', BWN_MODULES.poApproval, function () {
    'use strict';

    console.info('[BWN PO] userscript loaded on', location.href);

    var BTN_ID = 'bwn-po-approval-btn';

    // --- React-safe value setter (shared via BWN core) ---
    var setNativeValue = BWN.setNativeValue;

    // --- Find the Subject field within the modal (value contains "Tracking #") ---
    function findSubject(root) {
      var all = root.querySelectorAll('input, textarea');
      for (var i = 0; i < all.length; i++) {
        if (/tracking\s*#/i.test(all[i].value || '')) return all[i];
      }
      return null;
    }

    // --- Find the Body field within the modal (long textarea that isn't the subject) ---
    function findBody(root, subjectEl) {
      var tas = root.querySelectorAll('textarea');
      var best = null;
      for (var i = 0; i < tas.length; i++) {
        if (tas[i] === subjectEl) continue;
        var v = tas[i].value || '';
        if (/purchase order|broadway national|please find/i.test(v)) return tas[i];
        if (!best || v.length > (best.value || '').length) best = tas[i];
      }
      return best;
    }

    // --- Parse Subject -> { tracking, desc } ---
    function parseSubject(subjectVal) {
      var parts = subjectVal.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
      var rest = [], tracking = '';
      parts.forEach(function (p) {
        if (/tracking/i.test(p)) {
          var m = p.match(/#?\s*(\d+)/);
          tracking = m ? m[1] : '';
        } else { rest.push(p); }
      });
      var client = rest[0] || '', location = rest[1] || '', type = rest[2] || '';
      var desc = client;
      if (location) desc += ' \u2013 ' + location;
      if (type) desc += ' (' + type + ')';
      return { tracking: tracking, desc: desc };
    }

    // ---- BWN bus + money (shared via BWN core) ------------------------------
    var currentWOId = BWN.woId;
    var busGet = BWN.busGet;
    var fmtMoney = BWN.money;

    // --- NTE detection ----------------------------------------------------
    // The PO amount isn't in the modal and has no testid of its own. But each PO
    // row is a stable [data-testid="POAccordion-{n}"] accordion that contains the
    // vendor name and the amount text. The email goes to gmail addresses, so we
    // match recipients to the PO row whose vendor name overlaps them (order-proof),
    // then regex the amount out of that one row. If the PO rows aren't readable
    // (collapsed/unmounted), fall back to WO Assist's published bus state.
    var alphaOnly = BWN.alphaOnly;
    var lcsLen = BWN.lcsLen;

    function recipientsRaw(modal) {
      var to = modal.querySelector('[data-testid="Mail-To-Form-recipient-textfield-autocomplete"]');
      return to ? (to.textContent || '') : '';
    }

    function findNTE(modal) {
      var recRaw = recipientsRaw(modal);
      var recipients = alphaOnly(recRaw);
      if (!recipients) return null;

      var rows = document.querySelectorAll('[data-testid^="POAccordion-"]');
      var best = null, bestScore = 0;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        // Prefer the dedicated vendor-name element; fall back to the row's text.
        var vEl = row.querySelector('[data-testid="purchase-order-vendor-name"]');
        var vendorRaw = (vEl ? vEl.textContent : row.textContent) || '';
        // v1.10: same amount semantics as WO Assist/Leak Guard - every $ figure in
        // the row, cents optional, largest wins. The old cents-required first-match
        // regex made "$4,500" invisible and could pick a smaller line item.
        // v1.12: zero amounts dropped - a drafted "$0.00" PO row must never win and
        // put "a not-to-exceed of $0.00" in the vendor's approval email.
        var amts = [];
        var re = /\$\s*([\d,]+(?:\.\d{1,2})?)/g, m;
        while ((m = re.exec(row.textContent || '')) !== null) {
          var a9 = parseFloat(m[1].replace(/,/g, ''));
          if (a9 > 0) amts.push(a9);
        }
        if (!amts.length) continue;
        // v1.12: tiered scoring - a distinctive-token hit (tier 1000) beats any
        // overlap; within a tier, LCS breaks ties so two token-hitting rows rank by
        // real similarity. A token-bearing vendor whose tokens all MISS scores 0:
        // no raw-LCS fallback, so a shared trade word (ELECTRIC) can no longer pull
        // the wrong row's amount into the email.
        var vm = bwnVendorMatch(vendorRaw, recRaw);
        var score = vm.hit ? (vm.token ? 1000 : 6) + lcsLen(alphaOnly(vendorRaw), recipients) : 0;
        if (score > bestScore) { bestScore = score; best = fmtMoney(Math.max.apply(null, amts)); }
      }
      if (bestScore >= 6) return best;

      // Bus fallback: match the recipient against WO Assist's published PO list.
      var bus = busGet(currentWOId(), 12 * 3600000);
      if (bus && bus.pos && bus.pos.length) {
        var bBest = null, bScore = 0;
        bus.pos.forEach(function (p) {
          if (!(p.amount > 0)) return;
          var vmB = bwnVendorMatch(p.vendor, recRaw);
          var sc = vmB.hit ? (vmB.token ? 1000 : 6) + lcsLen(alphaOnly(p.vendor), recipients) : 0;
          if (sc > bScore) { bScore = sc; bBest = p.amount; }
        });
        if (bScore >= 6 && bBest !== null) {
          console.info('[BWN PO] NTE via suite bus:', bBest);
          return fmtMoney(bBest);
        }
      }
      // No solid vendor-name overlap anywhere; leave it to "the NTE shown".
      return null;
    }

    // --- Build the approval + ETA block ---
    function buildApproval(s, nte) {
      var amt = nte ? 'a not-to-exceed of ' + nte : 'the NTE shown';
      var lead = s.desc
        ? 'This PO approves your submitted quote for ' + s.desc + ' at ' + amt + '.'
        : 'This PO approves your submitted quote at ' + amt + '.';
      return lead +
        ' This approval covers the quoted scope only; anything beyond it requires a revised quote before any work proceeds.\n\n' +
        'Please reply to confirm:\n' +
        '\u2022 ETA / scheduled date:\n' +
        '\u2022 On-site tech & cell #:\n' +
        '\u2022 Parts, permit, or access lead times affecting the date:\n\n' +
        'On completion, upload to the WO: before/after photos, sign in/out times, and the signed work ticket.';
    }

    // --- Build the ETA reminder / follow-up block ---
    function buildReminder(s) {
      var ref = s.desc || 'your approved PO';
      var trk = s.tracking ? ' (Tracking #' + s.tracking + ')' : '';
      return 'Following up on the approved PO for ' + ref + trk +
        ' \u2014 I have not received your ETA yet.\n\n' +
        'Please reply today with:\n' +
        '\u2022 ETA / scheduled date:\n' +
        '\u2022 On-site tech & cell #:\n\n' +
        'If anything is holding up scheduling (parts, permits, or site access), let me know so I can update the client. Thanks.';
    }

    // --- Insert text after the intro line, keeping signature intact ---
    function insertIntoBody(root, builder, label) {
      var subjectEl = findSubject(root);
      if (!subjectEl) { alert('Subject not found \u2014 the PO modal may still be loading.'); return; }
      var bodyEl = findBody(root, subjectEl);
      if (!bodyEl) { alert('Body field not found.'); return; }

      var nte = (builder === buildApproval) ? findNTE(root) : null;
      if (builder === buildApproval) console.info('[BWN PO] NTE detected:', nte || '(none \u2014 using "NTE shown")');
      var text = builder(parseSubject(subjectEl.value || ''), nte);
      var val = bodyEl.value || '';

      if (val.indexOf(text.slice(0, 40)) !== -1) {
        alert(label + ' text is already in the body.');
        return;
      }

      var firstBreak = val.indexOf('\n');
      var newVal;
      if (firstBreak !== -1) {
        newVal = val.slice(0, firstBreak + 1) + '\n' + text + '\n' + val.slice(firstBreak + 1);
      } else {
        newVal = (val ? val + '\n\n' : '') + text;
      }
      setNativeValue(bodyEl, newVal);
      bodyEl.focus();
    }

    function makeBtn(text, handler) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.style.cssText = [
        'padding:8px 14px',
        'font:500 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif',
        'color:#fff', 'border:none', 'border-radius:6px', 'cursor:pointer',
        'background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk))'
      ].join(';');
      btn.addEventListener('click', function (e) { e.preventDefault(); handler(); });
      return btn;
    }

    // Smallest common ancestor of two elements, or null.
    function commonAncestor(a, b) {
      for (var n = a; n; n = n.parentElement) { if (n.contains(b)) return n; }
      return null;
    }

    // --- Build / position the buttons inside the modal ---
    function ensureButton(modal) {
      if (modal.querySelector('#' + BTN_ID)) return;   // already added to this modal
      var subjectEl = findSubject(modal);
      var bodyEl = subjectEl ? findBody(modal, subjectEl) : null;
      if (!bodyEl) return;                              // fields not rendered yet; retry next tick

      var bar = document.createElement('div');
      bar.id = BTN_ID;
      bar.appendChild(makeBtn('Insert Approval + ETA', function () { insertIntoBody(modal, buildApproval, 'Approval'); }));
      bar.appendChild(makeBtn('Insert ETA Reminder', function () { insertIntoBody(modal, buildReminder, 'Reminder'); }));

      // Preferred: the footer action bar holding Cancel + Send, pinned to the left.
      var send = modal.querySelector('[data-testid="mail-to-modal-send-button"]');
      var cancel = modal.querySelector('[data-testid="mail-to-modal-cancel-button"]');
      var footer = (send && cancel) ? commonAncestor(send, cancel) : null;

      if (footer) {
        bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-right:auto;';
        if (getComputedStyle(footer).display.indexOf('flex') === -1) {
          footer.style.display = 'flex';
          footer.style.alignItems = 'center';
        }
        footer.insertBefore(bar, footer.firstChild);   // left side; margin-right:auto keeps Cancel/Send right
      } else {
        // Fallback: original spot in the Body gutter.
        bar.style.cssText = 'display:flex;gap:8px;margin:6px 0;flex-wrap:wrap;';
        bodyEl.parentNode.insertBefore(bar, bodyEl);
      }
    }

    // --- Resolve the modal, mount buttons if fields are ready; return true once mounted ---
    function tryMount() {
      var title = document.querySelector('[data-testid="mail-to-modal-title"]');
      if (!title) return false;
      var modal = title.closest('[role="dialog"]') || document.querySelector('.MuiDialog-root');
      if (!modal) return false;
      if (modal.querySelector('#' + BTN_ID)) return true;   // already mounted
      ensureButton(modal);                                  // inserts only if subject/body values present
      var mounted = !!modal.querySelector('#' + BTN_ID);
      if (mounted) { console.info('[BWN PO] buttons mounted'); BWN.beat('poApproval', 'ok', 'buttons mounted'); }
      return mounted;                                       // true only if it actually mounted
    }

    // --- Single shared poller: React fills field values without a DOM mutation,
    //     so after the portal mounts we poll briefly until the values appear. ---
    var pollTimer = null;
    var loggedOpen = false;
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    function schedule() {
      // Only engage while the PO modal is actually present; avoids background polling on normal page churn.
      if (!document.querySelector('[data-testid="mail-to-modal-title"]')) {
        loggedOpen = false; stopPoll();
        // Gating-anchor drift check: a dialog that LOOKS like the PO mail modal
        // (Tracking # subject) but lacks the title testid this module keys on.
        var dlg0 = document.querySelector('[role="dialog"]');
        if (dlg0 && findSubject(dlg0)) BWN.beat('poApproval', 'miss', 'mail-like dialog open but mail-to-modal-title is missing - gating anchor drifted');
        else BWN.beat('poApproval', 'waiting', 'no PO modal open');
        return;
      }
      if (!loggedOpen) { loggedOpen = true; console.info('[BWN PO] Send PO modal detected'); }
      if (tryMount()) { stopPoll(); return; }
      if (pollTimer) return;                                // one interval at a time
      var ticks = 0;
      pollTimer = setInterval(BWN.guard(function () {
        // Stop only when mounted OR the modal goes away - no fixed try cap.
        if (tryMount() || !document.querySelector('[data-testid="mail-to-modal-title"]')) { stopPoll(); return; }
        // Watchdog: only a modal that IS a PO email (Tracking # subject) counts as a
        // miss - other mail flows legitimately never mount these buttons.
        if (++ticks === 66) {
          var t2 = document.querySelector('[data-testid="mail-to-modal-title"]');
          var root2 = t2 ? (t2.closest('[role="dialog"]') || document.querySelector('.MuiDialog-root')) : null;
          if (root2 && findSubject(root2)) BWN.beat('poApproval', 'miss', 'PO modal open 10s but buttons never mounted - selector drift?');
          else BWN.beat('poApproval', 'waiting', 'mail modal without a Tracking # subject - not a PO email');
        }
      }, 'poApproval:poll'), 150);
    }

    var obs = new MutationObserver(BWN.guard(schedule, 'poApproval:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    schedule();
  });

  // ==========================================================================
  // MODULE: WO Assist: GP + ETA Watchdog + Playbook v2.71 (Connector 1.2)
  // ==========================================================================
  bwnBoot('woAssist', BWN_MODULES.woAssist, function () {
    'use strict';

    // ---- Config (edit here) ----------------------------------------------
    var CFG = {
      DOCK_SIDE: 'left',      // 'left' (clear of Umbrava's Tasks sidebar) or 'right'
      DOCK_TOP_PCT: 34,       // vertical position of the side tab (% from top)
      ETA_WORDS: /\b(eta|scheduled?|sched|dispatch(ed)?|on[\s-]?site\s+(date|for|on))\b/i,
      DATE_RE: /\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i
    };

    // ---- BWN suite config (Phase 3): thresholds shared with WO List Heat. -----
    // Defaults + read/save now live in the BWN core; aliased here so all call
    // sites (and the one-time migration below) are unchanged.
    var bwnConfig = BWN.cfg;
    var bwnConfigSave = BWN.cfgSave;
    // One-time migration from the old per-key target GP storage.
    try {
      if (!localStorage.getItem('bwn:config') && localStorage.getItem('bwn-gp-target')) {
        var oldT = parseFloat(localStorage.getItem('bwn-gp-target'));
        if (!isNaN(oldT)) bwnConfigSave({ targetGP: oldT });
      }
    } catch (e) { }

    var PILL_ID = 'bwn-gp-pill';
    var PANEL_ID = 'bwn-gp-panel';
    var GREEN = BWN.GREEN;

    console.info('[BWN GP] WO Assist v2.71 loaded on', location.href);

    // ---- Parsing helpers (shared via BWN core) -----------------------------
    var parseMoney = BWN.parseMoney;
    var parseBare = BWN.parseBare;
    var fmt = BWN.money;
    var parseUSDate = BWN.parseUSDate;
    function daysUntil(ts) { return Math.ceil((ts - Date.now()) / 86400000); }
    function daysSince(ts) { return Math.floor((Date.now() - ts) / 86400000); }
    var inputVal = BWN.inputVal;

    // ---- BWN bus (suite data contract v1; shared via BWN core) -------------
    // WO Assist is the PRODUCER of bwn:wo:{id}; others consume DOM-first, bus-fallback.
    var currentWOId = BWN.woId;
    var busPut = BWN.busPut;
    var busPatch = BWN.busPatch;
    var busHeatGet = BWN.busHeatGet;

    // ---- PO rows: vendor, amount, scheduled date, state --------------------
    function vendorOf(row) {
      var el = row.querySelector('[data-testid="purchase-order-vendor-name"]') ||
               row.querySelector('[data-testid="purchase-order-vendor-link"]') ||
               row.querySelector('a');
      var v = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (v) return v;
      var firstLine = (row.textContent || '').split('\n').map(function (s) { return s.trim(); })
        .filter(function (s) { return s && !/\$/.test(s); })[0] || '';
      return firstLine.length > 2 && firstLine.length <= 60 ? firstLine : '(vendor n/a)';
    }
    function nvVendor(s) { return (s || '').replace(/\s+/g, ' ').trim().toUpperCase(); }   // normalize for cross-page (trips vs PO rows) vendor comparison
    function readPOs() {
      var out = [], seenSids = {};
      document.querySelectorAll('[data-testid^="POAccordion-"]').forEach(function (row) {
        var txt2 = row.textContent || '';
        var amts = [];
        var re = /\$\s*([\d,]+(?:\.\d{1,2})?)/g, m;
        while ((m = re.exec(txt2)) !== null) amts.push(parseFloat(m[1].replace(/,/g, '')));
        if (!amts.length) return;
        var amt = Math.max.apply(null, amts);
        if (amts.length > 1) console.info('[BWN GP] PO row has multiple amounts', amts, '- using largest:', amt);
        // Per-PO scheduled date (verified on WO 361563): a date or "--".
        var sd = txt2.match(/Scheduled\s*Date\s*:?[\s\u00a0]*((\d{1,2}\/\d{1,2}\/\d{2,4})|--|\u2014)/i);
        var schedDate; // undefined when the label isn't in this row at all
        if (sd) schedDate = sd[2] || null;
        // Umbrava PO end-states: "Confirm Complete", "Work Complete", "Completed",
        // "Cancelled". ("Work Complete" was missed originally - a completed PO kept
        // demanding an ETA, user-reported.) The "Revoke" BUTTON on pending rows is
        // why /revoked?/ must NOT be matched loosely.
        var vend = vendorOf(row);
        var num = (row.getAttribute('data-testid') || '').replace('POAccordion-', '') || (out.length + 1) + '';
        // Stable per-PO identity for act KEYS (poKeyOf ladder, defined below in this same
        // module: Umbrava's assigned line number -> vendor GUID -> render index). The
        // POAccordion-<n> render index in `num` re-sequences when a PO is added or
        // cancelled, which orphaned checked state AND let structConvergeReason read the
        // WRONG PO's done flag. `num` stays for display + the POAccordion-<n> nav lookup.
        var sid = poKeyOf(row);
        if (seenSids[sid]) sid = sid + '-' + num;   // two POs can share a vendor (GUID fallback) - keys must stay distinct
        seenSids[sid] = 1;
        // Isolate the PO's OWN status: the text between the leading {num}{date} and the
        // vendor name, so status keywords never collide with the Description. Rows read
        // e.g. "001 03/03/2026 Confirm Complete VENDOR $…" / "003 05/08/2026 Open
        // Material Ordered VENDOR $…" (recon-verified WO 339766). Then classify + set done.
        // Normalize whitespace first so the vendor lookup is not defeated by nbsp /
        // double-spaces (review: a miss fell through to the "$"-cut, pulling the vendor
        // name into the status region and mis-classifying vendors like "Fabrication…").
        var ntxt = txt2.replace(/\s+/g, ' ');
        var head = ntxt, vi = (vend && vend !== '(vendor n/a)') ? ntxt.indexOf(vend) : -1;
        if (vi > 0) head = ntxt.slice(0, vi); else { var di = ntxt.indexOf('$'); if (di > 0) head = ntxt.slice(0, di); }
        var dmr = head.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
        var statusRegion = (dmr ? head.slice(head.indexOf(dmr[0]) + dmr[0].length) : head.replace(/^\s*\d+/, '')).replace(/\s+/g, ' ').trim();
        var done, poStatus = '';
        if (statusRegion) {
          // "paid"/"invoiced" now count as done - a Paid PO was mis-read as active,
          // firing phantom ETA/stall chases on invoiced WOs (review MAJOR).
          done = /confirm\s*complete|work\s*complete|completed|cancell?ed|paid|invoiced|revoked|declined/i.test(statusRegion);
          if (/confirm\s*complete/i.test(statusRegion)) poStatus = 'confirm';
          else if (/material\s*ordered|pending\s*materials|need\s*material|fabricat|rma|awaiting\s*supplier/i.test(statusRegion)) poStatus = 'materials';
          else if (/pending\s*acceptance/i.test(statusRegion)) poStatus = 'accept';
        } else {
          done = /confirm\s+complete|work\s+complete|completed|cancell?ed|paid|invoiced/i.test(txt2);   // legacy fallback if the region could not be isolated
        }
        // "Cost-open" = a PO that was USED (not cancelled/declined/revoked/void) and
        // isn't finalized on the billing side yet (not paid/invoiced). At Clocked Out:
        // Complete the coordinator confirms the final cost of each such PO before the WO
        // can be marked Work Complete. A "Work Complete" PO is cost-open (work done, cost
        // not yet locked); a Cancelled or Paid/Invoiced PO is not.
        var costRegion = statusRegion || txt2;
        // Word-boundaried so a Description word ("avoid"/"prepaid") can't false-match and
        // drop a genuinely cost-open PO (parity with the terminal safety-net regex).
        var costOpen = amt > 0 && !/\b(cancell?ed|declined|revoked|void)\b/i.test(costRegion) && !/\b(paid|invoiced)\b/i.test(costRegion);
        out.push({ vendor: vend, num: num, sid: sid, amount: amt, schedDate: schedDate, done: done, poStatus: poStatus, statusText: statusRegion, costOpen: costOpen });
      });
      return out;
    }

    // Open tasks - surfaced directly on the WO details page as "Open Tasks N" plus a
    // card per task (task text, "Assigned To" {name}, "Date" {due}). Read in place -
    // no Tasks-tab visit or cache needed. Recon-verified WO 364504.
    function readOpenTasks() {
      var host = null, best = Infinity, els = document.querySelectorAll('div,span,section,h4,h5,p');
      for (var i = 0; i < els.length; i++) { var t = (els[i].textContent || '').replace(/\s+/g, ' ').trim(); if (/^open tasks\s*\d+$/i.test(t) && t.length < best) { host = els[i]; best = t.length; } }
      if (!host) return null;
      var count = parseInt((host.textContent.match(/\d+/) || ['0'])[0], 10) || 0;
      if (!count) return { count: 0, first: null };
      var sec = host, cards = [];
      for (var j = 0; j < 6 && sec.parentElement; j++) { sec = sec.parentElement; cards = sec.querySelectorAll('[data-testid="unlabeled-ds-card"]'); if (cards.length) break; }
      function leavesOf(el) { var out = []; el.querySelectorAll('*').forEach(function (n) { if (n.children.length === 0) { var tx = (n.textContent || '').trim(); if (tx) out.push(tx); } }); return out; }
      // Prefer the card that IS a task (has an "Assigned To" leaf) over the first generic
      // unlabeled-ds-card, which may be an unrelated panel card (review).
      var card = null;
      for (var k = 0; k < cards.length; k++) { if (leavesOf(cards[k]).indexOf('Assigned To') !== -1) { card = cards[k]; break; } }
      if (!card) card = cards[0];
      var first = null;
      if (card) {
        var leaves = leavesOf(card);
        var ai = leaves.indexOf('Assigned To'), di = leaves.indexOf('Date');
        var assignee = ai >= 0 ? (leaves[ai + 1] || '') : '', date = di >= 0 ? (leaves[di + 1] || '') : '';
        // Task text = the longest leaf that is NOT a label, the count, the assignee value,
        // or the date value (so a short task text is not replaced by the name/date).
        var cand = leaves.filter(function (x) { return x !== assignee && x !== date && !/^(open tasks|assigned to|date)$/i.test(x) && !/^\d+$/.test(x); })
          .sort(function (a, b) { return b.length - a.length; });
        first = { text: cand[0] || '', assignee: assignee, date: date };
      }
      return { count: count, first: first };
    }

    // ---- Client DNE detection (Tier 0 verified on WO 364055) ---------------
    function woKey() {
      var m = location.pathname.match(/work-orders\/(\d+)/);
      return 'bwn-nte-' + (m ? m[1] : location.pathname);
    }
    function detectNTE() {
      var dne = document.querySelector('input[name="doNotExceed"]');
      if (dne) {
        var amt0 = parseBare(dne.value);
        if (amt0 !== null && amt0 > 0) return { amount: amt0, source: 'DNE field' };
      }
      var els = document.querySelectorAll('[data-testid*="nte" i], [data-testid*="dne" i], [data-testid*="not-to-exceed" i]');
      for (var i = 0; i < els.length; i++) {
        var v = els[i].tagName === 'INPUT' ? els[i].value : (els[i].textContent || '');
        var inp = els[i].querySelector && els[i].querySelector('input');
        if (!parseMoney(v) && inp) v = inp.value;
        var amt = parseMoney(v) !== null ? parseMoney(v) : parseBare(v);
        if (amt !== null && amt > 0) return { amount: amt, source: 'field' };
      }
      var all = document.querySelectorAll('label, span, div, p, h6');
      for (var j = 0; j < all.length; j++) {
        var t = (all[j].textContent || '').trim();
        if (t.length > 40) continue;
        if (!/\b(NTE|DNE)\b|do\s+not\s+exceed|not\s+to\s+exceed/i.test(t)) continue;
        var scope = all[j].parentElement || all[j];
        for (var hop = 0; hop < 3 && scope; hop++) {
          var inp2 = scope.querySelector && scope.querySelector('input');
          var amt2 = parseMoney(scope.textContent || '');
          if (amt2 === null && inp2) amt2 = parseBare(inp2.value);
          if (amt2 !== null && amt2 > 0) return { amount: amt2, source: 'label' };
          scope = scope.parentElement;
        }
      }
      var saved = parseFloat(sessionStorage.getItem(woKey()) || '');
      if (!isNaN(saved)) return { amount: saved, source: 'manual' };
      return null;
    }
    function setManualNTE() {
      var cur = sessionStorage.getItem(woKey()) || '';
      var v = prompt('Client DNE for this WO (number only - kept in this browser tab only):', cur);
      if (v === null) return;
      var n = parseFloat(String(v).replace(/[$,]/g, ''));
      if (isNaN(n)) { alert('Not a number.'); return; }
      sessionStorage.setItem(woKey(), String(n));
      refresh();
    }

    // ---- Target GP% (persists across WOs; just a percentage, no sensitive data) ----
    function getTargetGP() { return bwnConfig().targetGP; }
    function setTargetGP(n) {
      if (!isNaN(n) && n >= 0 && n < 100) bwnConfigSave({ targetGP: n });
    }  // DNE required so that (DNE - vendorTotal) / DNE = target%.
    function requiredDNE(vendorTotal, targetPct) {
      if (targetPct >= 100 || targetPct < 0) return null;
      return vendorTotal / (1 - targetPct / 100);
    }

    // ---- Notes: mounted read + on-demand deep scroll ------------------------
    var deepNotes = null;   // populated by Deep Scan; cleared on route change
    var deepNotesTs = 0;    // when it was scanned - ages out with NOTES_TTL like the bus cache
    var deepNotesViaApi = false;   // true when the API read filled it, so the meta line can say so

    function readMountedNotes() {
      var notes = [];
      document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]').forEach(function (sEl) {
        var m = (sEl.getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/);
        if (!m) return;
        var id = m[1];
        var bodyEl = document.querySelector('[data-testid="wo-note-' + id + '-description"]');
        var body = bodyEl ? (bodyEl.textContent || '') : (sEl.textContent || '');
        // Meta via the shared self-healing resolver (pinned class → memoized →
        // content heuristic) so an Umbrava rebuild can't silently blank note ages.
        // Label is captured too so a Deep Scan published to the bus carries the
        // note types the AI drafts want.
        var meta = BWN.noteMeta(BWN.noteCard(sEl));
        notes.push({ id: id, label: meta.label || '', body: body, ts: meta.ts });
      });
      return notes;
    }

    // ---- Shared deep-scan cache (bus: bwn:notes:{woId}) -----------------------
    // ONE full note collection - from EITHER script (this Deep Scan or an AI
    // draft's collect) - serves every tool on the WO. Sandboxes can't share
    // objects, so the notes ride the sessionStorage bus. Validity: a TTL, plus
    // "no mounted note id the cache has never seen" (a new note → stale), plus
    // per-note last-modified comparison (an edit → stale). A DELETED note is
    // undetectable by design (absence ≠ deletion in a virtualized list) - bounded
    // by the TTL and the AI drafts' Shift-Regenerate fresh-collect lever. At
    // most 3 WOs kept (quota hygiene). IDENTICAL logic lives in the AI script.
    var NOTES_TTL = 30 * 60000;
    function busNotesKey() { return 'bwn:notes:' + (currentWOId() || location.pathname); }
    function busNotesGet() {
      try {
        var d = JSON.parse(sessionStorage.getItem(busNotesKey()) || 'null');
        if (!d || d.v !== 1 || !Array.isArray(d.notes)) return null;
        if (Date.now() - (d.ts || 0) > NOTES_TTL) return null;
        var byId = {};
        d.notes.forEach(function (n) { byId[n.id] = n; });
        var mounted = document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]');
        for (var i = 0; i < mounted.length; i++) {
          var m = (mounted[i].getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/);
          if (!m) continue;
          var cn = byId[m[1]];
          if (!cn) return null;                                  // new note since the scan → stale
          // Edited-in-place detection: an edit bumps the note's last-modified stamp,
          // and the editor is almost certainly LOOKING at the note (= mounted here).
          var liveTs = BWN.noteMeta(BWN.noteCard(mounted[i])).ts || '';
          if (liveTs && (cn.ts || '') && liveTs !== cn.ts) return null;   // edited → stale
        }
        return d.notes;
      } catch (e) { return null; }
    }
    function busNotesPut(notesArr) {
      try {
        // Slim before publish: cap monster note bodies (visible "…[truncated]" marker
        // the model can see; Deep Scan / fresh collects always work from full bodies)
        // and refuse payloads that would crowd the sessionStorage quota (review m5).
        // The size check runs BEFORE pruning so a refused publish never evicts
        // another WO's good cache.
        var slim = notesArr.map(function (n) {
          var b = String(n.body || '');
          if (b.length > 6000) b = b.slice(0, 6000) + ' …[truncated]';
          // Freeze an absolute epoch NOW so a relative ts ("2 hours ago") captured at
          // scan time doesn't drift when a consumer re-parses it later (timeline M1).
          var da = n.ts ? BWN.parseNoteDateLoose(n.ts) : null;
          return { id: n.id, label: n.label || '', ts: n.ts || '', tsAbs: da ? +da : null, body: b };
        });
        var blob = JSON.stringify({ v: 1, ts: Date.now(), notes: slim });
        if (blob.length > 2000000) { console.info('[BWN GP] note cache skipped - payload too large (' + Math.round(blob.length / 1024) + 'KB)'); return; }
        var keys = [];
        for (var i = 0; i < sessionStorage.length; i++) {
          var k = sessionStorage.key(i);
          if (k && k.indexOf('bwn:notes:') === 0 && k !== busNotesKey()) {
            var d = null; try { d = JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e2) { }
            keys.push({ k: k, ts: (d && d.ts) || 0 });
          }
        }
        keys.sort(function (a, b) { return b.ts - a.ts; });
        for (var j = 2; j < keys.length; j++) sessionStorage.removeItem(keys[j].k);
        sessionStorage.setItem(busNotesKey(), blob);
      } catch (e) { /* quota - cache is best-effort */ }
    }

    var lastNotesSrc = 'view';   // 'api' | 'deep' | 'cache' | 'view' - for the meta line
    function getNotes() {
      if (deepNotes && Date.now() - deepNotesTs > NOTES_TTL) deepNotes = null;   // a deep scan ages out like the bus cache (review m4)
      if (deepNotes) { lastNotesSrc = deepNotesViaApi ? 'api' : 'deep'; return deepNotes; }
      var b = busNotesGet();
      if (b) { lastNotesSrc = 'cache'; return b; }
      lastNotesSrc = 'view';
      return readMountedNotes();
    }

    // ---- Note history WITHOUT waiting for a Deep Scan (2026-08-05) --------------
    // getNotes()'s last resort is readMountedNotes(), and the notes list is VIRTUALIZED
    // AND lives on its own tab. On the WO details route - the only route where the
    // Complete-By picker exists, so the only route the ECD helper ever runs on - that
    // fallback returns ZERO notes. Every engine read phrased as "what do the notes say"
    // was therefore judging the WO on nothing at all unless the coordinator had opened
    // the Notes tab and run a Deep Scan first. The ECD proposal is the sharpest case: it
    // asks the notes for the promised date, found none, and defaulted to "the 2nd
    // upcoming Friday" on a WO whose notes carried a real ETA.
    // Deep Scan has read the whole history in ONE call since 2026-08-04 (bwnNotesApi:
    // 308 notes on W-283834 where the DOM had 17 mounted). This makes that read happen on
    // its own, once per WO, and publishes it to the SAME bus, so getNotes() hands the full
    // history to every consumer - ECD, staleness, the ETA watchdog, action convergence -
    // without any of them changing how they ask.
    // Failure is a no-op by design: the caches are left untouched and getNotes() degrades
    // to exactly what it did before. A partial history is never published.
    var NOTES_RETRY = 2 * 60000;            // a failed read re-arms sooner than a good one
    var NOTES_FETCH = Object.create(null);  // woNum -> { s: 'pending'|'ok'|'error', ts }
    var NOTES_WAIT = Object.create(null);   // woNum -> [cb] fired once, on settle either way
    function notesReadState(woNum) {
      var r = woNum && NOTES_FETCH[woNum];
      if (!r) return null;
      if (r.s === 'pending') return 'pending';
      if (Date.now() - r.ts > (r.s === 'error' ? NOTES_RETRY : NOTES_TTL)) return null;   // aged out - re-armable
      return r.s;
    }
    function notesSettle(woNum) {
      var cbs = NOTES_WAIT[woNum]; delete NOTES_WAIT[woNum];
      (cbs || []).forEach(function (cb) { try { cb(); } catch (e) { } });
    }
    // Fire cb once the read for this WO has settled (or immediately, if it already has).
    function notesOnRead(woNum, cb) {
      if (notesReadState(woNum) !== 'pending') { cb(); return; }
      (NOTES_WAIT[woNum] = NOTES_WAIT[woNum] || []).push(cb);
    }
    function fetchNotesApi(woNum) {
      if (!woNum) return;
      var s = notesReadState(woNum);
      if (s === 'pending' || s === 'error') return;   // in flight, or a fresh failure still cooling off
      // 'ok' only counts while the history is still IN HAND. An SPA nav clears deepNotes and
      // busNotesPut keeps at most 3 WOs, so a success flag can outlive the notes it stands
      // for - which would strand the WO on the mounted slice behind an 'ok'.
      if (s === 'ok' && (deepNotes || busNotesGet())) return;
      NOTES_FETCH[woNum] = { s: 'pending', ts: Date.now() };
      bwnNotesApi(woNum).then(function (list) {
        // Navigated away mid-read: drop the result rather than hang another WO's history
        // off this one, and clear the slot so revisiting refetches instead of sitting on
        // an 'ok' that never cached anything.
        if (currentWOId() !== woNum) { delete NOTES_FETCH[woNum]; notesSettle(woNum); return; }
        NOTES_FETCH[woNum] = { s: 'ok', ts: Date.now() };
        deepNotes = list; deepNotesTs = Date.now(); deepNotesViaApi = true;
        busNotesPut(list);
        console.info('[BWN GP] note history read from the API:', list.length, 'notes - no Deep Scan needed (published to the suite cache)');
        notesSettle(woNum);
        try { refresh(); } catch (e) { }
      }, function (err) {
        NOTES_FETCH[woNum] = { s: 'error', ts: Date.now() };
        console.info('[BWN GP] auto note read unavailable (' + ((err && err.message) || err) + ') - the engine falls back to the notes on screen');
        notesSettle(woNum);
        try { refresh(); } catch (e) { }
      });
    }

    function notesScroller() { return BWN.findScroller(document.querySelector(BWN.NOTE_SUMMARY_SEL)); }
    function deepScan(progress, doneCb) {
      var store = {};
      // Sweep runs on the shared BWN.harvest engine (v2.14). Lifecycle: a route
      // change or panel dismissal aborts - nothing committed, doneCb never fires -
      // so the ticker can't harvest the NEXT WO's notes onto this WO's bus or pop
      // the panel back open after the user closed it. A same-WO list remount
      // re-attaches; a vanished list commits what was captured.
      var epoch = currentWOId();
      var panelEl = document.getElementById(PANEL_ID);   // the panel instance that started this scan
      // The API read gets there in one call and does not need the notes list open at
      // all; the sweep below stays as the fallback. Same abort identity either way.
      bwnNotesApi(epoch).then(function (list) {
        if (currentWOId() !== epoch || document.getElementById(PANEL_ID) !== panelEl) {
          console.info('[BWN GP] API notes read discarded - page or panel changed mid-read');
          return;
        }
        deepNotes = list;
        deepNotesTs = Date.now();
        deepNotesViaApi = true;
        busNotesPut(list);
        if (progress) progress(list.length);
        console.info('[BWN GP] notes read from the API:', list.length, 'notes - no scrolling (published to the suite cache)');
        doneCb();
      }, function (err) {
        console.info('[BWN GP] API notes read unavailable (' + ((err && err.message) || err) + ') - falling back to the scroll sweep');
        if (currentWOId() !== epoch || document.getElementById(PANEL_ID) !== panelEl) return;
        sweepNotes();
      });
      function sweepNotes() {
      BWN.harvest({
        scroller: notesScroller(),
        rescroller: notesScroller,
        capture: function () {
          readMountedNotes().forEach(function (n) { if (!store[n.id] || !store[n.id].body) store[n.id] = n; });
        },
        count: function () { return Object.keys(store).length; },
        cancelled: function () {
          if (currentWOId() === epoch && document.getElementById(PANEL_ID) === panelEl) return false;
          console.info('[BWN GP] deep scan aborted - page or panel changed mid-scan');
          return true;
        },
        progress: progress,
        done: function (complete) {
          deepNotes = Object.keys(store).map(function (k) { return store[k]; });
          deepNotesTs = Date.now();
          deepNotesViaApi = false;
          // Publish ONLY a converged full sweep - a truncated top-of-list prefix passes
          // every validity check and would poison both scripts for the TTL (review M1).
          if (complete) busNotesPut(deepNotes);
          console.info('[BWN GP] deep scan complete:', deepNotes.length, 'notes' + (complete ? ' (published to the suite cache)' : ' - PARTIAL sweep, kept local only'));
          doneCb();
        }
      });
      }
    }

    // ---- Documents: the DOM reader is RETIRED (see fetchDocs/readDocs below) ---
    // The old readDocs() scanned for a "Documents (N)" header or document-row
    // testids. Neither exists on a real WO - the Documents DOM was never pinned -
    // so it returned null on EVERY read and the docs:none closure gate has never
    // once fired in production. Replaced by the jobDocuments API read in the
    // readWO/fetchTrips cluster below: no selectors, nothing left to pin.

    // ---- WO header via workOrder API (enriches headerInfo's DOM scrape) --------
    // Cache-backed so compute()/the pure engine stay synchronous (mirrors the trips
    // cache). readWO returns the cached WO object or null (null while pending / on
    // error / off-WO - never a wrong guess); a cache miss fires the fetch and
    // re-renders when it lands. Gives the exact priority label (the DOM read can
    // silently fall back to neutral) and the internal job id (the DOM can't).
    var WO_CACHE = Object.create(null);   // woNum -> wo | 'pending' | 'error'
    var WORKORDER_Q = 'query WorkOrderHeader($n: Int!) { workOrder(workOrderNumber: $n) { id number statusName systemStatusName phase priority { label category } doNotExceed { amount currency precision } totalNTE { amount currency precision } grossProfitInfo { estimatedGrossProfitPercent trueGrossProfitPercent grossProfitPercentType } trades { id name } locationNumber locationName } }';
    function fetchWO(woNum) {
      if (!woNum) return;
      var c = WO_CACHE[woNum];
      if (c === 'pending' || (c && c !== 'error')) return;
      WO_CACHE[woNum] = 'pending';
      bwnGql(WORKORDER_Q, { n: Number(woNum) }).then(function (d) {
        var wo = d && d.workOrder;
        if (!wo || wo.number == null) { WO_CACHE[woNum] = 'error'; return; }
        WO_CACHE[woNum] = wo;
        try { refresh(); } catch (e) { }
      }).catch(function () { WO_CACHE[woNum] = 'error'; });
    }
    function readWO(woNum) {
      if (!woNum) return null;
      var c = WO_CACHE[woNum];
      if (c && c !== 'pending' && c !== 'error') return c;
      fetchWO(woNum);
      return null;
    }
    // Money helper: the workOrder API returns amounts as MINOR UNITS with a precision
    // (amount 22972692 / precision 2 = $229,726.92). Returns DOLLARS - the convention
    // detectNTE()/readPOs() already use - or null when the field is absent/malformed.
    function bwnMoney(m) { return (m && typeof m.amount === 'number') ? m.amount / Math.pow(10, (m.precision || 0)) : null; }

    // ---- No-show via purchaseOrderTrips(jobId) + jobIVRs clock-in check --------
    // The Trip Calendar module writes bwn:trips:<wo> from DOM cards, but only on the
    // /trips tab - so on the details page (where WO Assist runs) state.noShow is
    // usually absent. This populates the SAME cache/shape ({ms,vendor,trip}) from the
    // API using state.jobId (now available via readWO), and REFINES the signal: a trip
    // is only a no-show if it is Scheduled, its onSiteDate is before today, and there
    // is NO non-cancelled clock-in (jobIVRs) for its PO - so a vendor who showed but
    // whose trip status was never updated no longer false-flags. Runs once per WO per
    // session; only overwrites the cache on a SUCCESSFUL trips read (never nulls out a
    // DOM-written cache on a failed fetch). status is matched by word (/scheduled/i);
    // if Umbrava encodes it as an enum int the flag simply won't fire - a safe miss,
    // not a false no-show (pin the enum from a captured trips response to extend).
    var TRIPS_DONE = Object.create(null);   // woNum -> 'pending' | true (once per session)
    var PO_TRIPS_Q = 'query POTripsNoShow($jobId: Int!) { purchaseOrderTrips(jobId: $jobId) { number vendorName trips { number onSiteDate status } } }';
    var WO_IVRS_Q = 'query WOIVRsNoShow($n: Int) { jobIVRs(workOrderNumber: $n) { purchaseOrderNumber clockInDate startTime isCanceled numberOfHours travelNumberOfHours } }';
    function fetchTrips(woNum, jobId) {
      if (!woNum || !jobId || TRIPS_DONE[woNum]) return;
      TRIPS_DONE[woNum] = 'pending';
      Promise.all([
        bwnGql(PO_TRIPS_Q, { jobId: Number(jobId) }).catch(function () { return null; }),
        bwnGql(WO_IVRS_Q, { n: Number(woNum) }).catch(function () { return null; })
      ]).then(function (res) {
        TRIPS_DONE[woNum] = true;
        var poTrips = res[0] && res[0].purchaseOrderTrips;
        if (!Array.isArray(poTrips)) return;   // read failed - leave any existing cache intact
        var ivrs = (res[1] && res[1].jobIVRs) || [];
        var clockedPO = Object.create(null);
        ivrs.forEach(function (v) {
          if (v && !v.isCanceled && (v.clockInDate || v.startTime) && v.purchaseOrderNumber != null) clockedPO[String(v.purchaseOrderNumber)] = true;
        });
        var d = new Date(), today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        var latest = null, noShow = null;
        poTrips.forEach(function (po) {
          var poNum = String(po.number == null ? '' : po.number), vendor = po.vendorName || '';
          (po.trips || []).forEach(function (t) {
            var ms = t.onSiteDate ? +new Date(t.onSiteDate) : NaN;
            if (isNaN(ms)) return;
            var st = String(t.status == null ? '' : t.status);
            var done = /complete|cancel|progress|route|dispatch/i.test(st);
            if (!done && ms >= today && (latest === null || ms > latest)) latest = ms;
            if (/scheduled/i.test(st) && !done && ms < today && !clockedPO[poNum] && vendor && (!noShow || ms < noShow.ms)) {
              noShow = { ms: ms, vendor: vendor, trip: (t.number != null ? String(t.number) : '') };
            }
          });
        });
        var payload = { v: 1, ts: Date.now(), src: 'api', latestScheduled: latest };
        if (noShow) payload.noShow = noShow;
        // Track A IVR hours: total labor + travel hours from the jobIVRs ledger (the SAME read the
        // no-show check already uses). Only when the jobIVRs read SUCCEEDED (an array) - a failed read
        // leaves them absent (unknown), never a guessed 0. Sum per-record hours across non-canceled records.
        if (res[1] && Array.isArray(res[1].jobIVRs)) {
          var labor = 0, travel = 0;
          ivrs.forEach(function (v) {
            if (!v || v.isCanceled) return;
            if (typeof v.numberOfHours === 'number') labor += v.numberOfHours;
            if (typeof v.travelNumberOfHours === 'number') travel += v.travelNumberOfHours;
          });
          payload.laborHours = Math.round(labor * 10) / 10;
          payload.travelHours = Math.round(travel * 10) / 10;
        }
        try { BWN.ssSetJSON('bwn:trips:' + woNum, payload); } catch (e) { }
        try { refresh(); } catch (e) { }
      });
    }

    // ---- Client proposals via listClientProposals(jobId) -----------------------
    // Fourth reader in this cluster (Track A proposals+GP slice). Counts OPEN client
    // proposals - those with NO terminal date (approved/rejected/canceled) - and caches the
    // count to bwn:props:<wo> for the live-jobs push (AI carries it as openProposals). Cache
    // keyed by the WO NUMBER; read by the internal jobId (listClientProposals takes jobId).
    // Confident reads only: a failed/absent read leaves bwn:props absent (unknown), never a
    // guessed 0 - same unknown-vs-empty contract as the docs reader.
    var PROPS_DONE = Object.create(null);
    var CLIENT_PROPS_Q = 'query WOClientProposals($jobId: Int!) { listClientProposals(jobId: $jobId, page: { skip: 0, take: 50 }) { rowCount items { id approvedDate rejectedDate canceledDate } } }';
    function fetchProposals(woNum, jobId) {
      if (!woNum || !jobId || PROPS_DONE[woNum]) return;
      PROPS_DONE[woNum] = 'pending';
      bwnGql(CLIENT_PROPS_Q, { jobId: Number(jobId) }).then(function (d) {
        var r = d && d.listClientProposals;
        if (!r || !Array.isArray(r.items)) { PROPS_DONE[woNum] = 'error'; return; }   // schema drift = unknown, NEVER a guessed 0
        var open = r.items.filter(function (p) { return p && !p.approvedDate && !p.rejectedDate && !p.canceledDate; }).length;
        PROPS_DONE[woNum] = true;
        try { BWN.lsSetJSON('bwn:props:' + woNum, { open: open, ts: new Date().toISOString() }); } catch (e) { }
        try { refresh(); } catch (e) { }
      }).catch(function () { PROPS_DONE[woNum] = 'error'; });
    }

    // ---- Open tasks via tasksByEntityTypeAndId(entityType:1, entityId:<woNumber>) --------
    // Fifth reader in this cluster (Track A tasks slice). readOpenTasks() above is a DOM SCRAPE of
    // the "Open Tasks N" panel - fragile (needs the panel rendered); this is the deterministic API
    // count for the live-jobs push. entityType 1 = work order; entityId is the WO NUMBER as a String.
    // Counts INCOMPLETE tasks client-side (don't trust includeComplete alone - same discipline as the
    // docs reader's !isArchived). Confident reads only -> bwn:tasks:<wo>; a failed read stays absent
    // (unknown), never a guessed 0.
    var TASKS_DONE = Object.create(null);
    var OPEN_TASKS_Q = 'query WOOpenTasks($id: String!) { tasksByEntityTypeAndId(entityType: 1, entityId: $id, includeComplete: false) { tasks { id isComplete } } }';
    function fetchTasks(woNum) {
      if (!woNum || TASKS_DONE[woNum]) return;
      TASKS_DONE[woNum] = 'pending';
      bwnGql(OPEN_TASKS_Q, { id: String(woNum) }).then(function (d) {
        var r = d && d.tasksByEntityTypeAndId;
        if (!r || !Array.isArray(r.tasks)) { TASKS_DONE[woNum] = 'error'; return; }   // schema drift = unknown, NEVER a guessed 0
        var open = r.tasks.filter(function (t) { return t && !t.isComplete; }).length;
        TASKS_DONE[woNum] = true;
        try { BWN.lsSetJSON('bwn:tasks:' + woNum, { open: open, ts: new Date().toISOString() }); } catch (e) { }
        try { refresh(); } catch (e) { }
      }).catch(function () { TASKS_DONE[woNum] = 'error'; });
    }

    // ---- Documents via jobDocuments(workOrderNumber) ---------------------------
    // Third reader in this cluster, same cache shape as readWO/fetchTrips: async
    // fetch fills DOCS_CACHE, readDocs() is a SYNC cache read so compute() and the
    // pure engine stay synchronous, and the fetch landing triggers a re-render.
    //
    // Keyed by the WO NUMBER, not jobId - the two are different identifiers and
    // jobDocuments accepts either, so passing the wrong one is a silent wrong
    // answer rather than an error. workOrderNumber is the confirmed-live arg
    // (W-370534 returned 21 documents through it, no jobId needed).
    //
    // GATE CONTRACT UNCHANGED - the null/value split is the whole point:
    //   null (off-WO, fetch pending, or the read failed) = UNKNOWN -> docs:none
    //     stays quiet. A false zero would nag a coordinator who has the package.
    //   {count:0, docs:[]} = CONFIDENT empty -> docs:none fires.
    //   docs present still never auto-completes a step: a count can be intake
    //     paperwork, not the completion package. Per-doc `label` and
    //     `workOrderDocumentSource` make that refinement possible later; it is
    //     deliberately NOT in this pass.
    // A failed read parks at 'error' and is retried on the next render - the same
    // self-heal readWO/fetchWO use. The cost of a persistent failure is a dormant
    // gate, which is exactly the behaviour that shipped before this route existed.
    var DOCS_CACHE = Object.create(null);   // woNum -> {count,docs} | 'pending' | 'error'
    var JOB_DOCUMENTS_Q = 'query WODocuments($n: Int!) { jobDocuments(workOrderNumber: $n, includeArchived: false) { id label displayFileName description uploadDate fileSize isArchived workOrderDocumentSource purchaseOrderNumber } }';
    function fetchDocs(woNum) {
      if (!woNum) return;
      var c = DOCS_CACHE[woNum];
      if (c === 'pending' || (c && c !== 'error')) return;
      DOCS_CACHE[woNum] = 'pending';
      bwnGql(JOB_DOCUMENTS_Q, { n: Number(woNum) }).then(function (d) {
        var rows = d && d.jobDocuments;
        if (!Array.isArray(rows)) { DOCS_CACHE[woNum] = 'error'; return; }   // schema drift = unknown, NEVER empty
        // includeArchived:false is both ASKED FOR and enforced here - the live
        // count must not depend on the server honouring the argument.
        var live = rows.filter(function (r) { return r && !r.isArchived; });
        DOCS_CACHE[woNum] = { count: live.length, docs: live };
        // Track A docs-closure: publish the confident count for the live-jobs push - AI's
        // pushJobFacts reads bwn:docs:<wo> and sends it as docCount to the Ops Dashboard.
        // CONFIDENT reads ONLY: the 'error'/'pending' branches never write here, so an
        // unknown WO stays ABSENT from bwn:docs (never a guessed 0), preserving the same
        // unknown-vs-empty contract the docs gate relies on. Keyed by WO number (not tracking).
        try { BWN.lsSetJSON('bwn:docs:' + woNum, { count: live.length, ts: new Date().toISOString() }); } catch (e) { }
        try { refresh(); } catch (e) { }
      }).catch(function () { DOCS_CACHE[woNum] = 'error'; });
    }
    function readDocs() {
      var woNum = currentWOId();
      if (!woNum) return null;
      var c = DOCS_CACHE[woNum];
      if (c && c !== 'pending' && c !== 'error') return c;
      fetchDocs(woNum);
      return null;   // pending / errored / just-fired - unknown, never a guessed zero
    }

    // ---- Signals --------------------------------------------------------------
    // Tolerant (shared, v5): absolute, relative ("2 hours ago"), or Date.parse-able -
    // relative timestamps previously read as "no date" and hid stale-note ages.
    function parseNoteDate(s) { var d = BWN.parseNoteDateLoose(s); return d ? d.getTime() : null; }

    // Promised-date parser for note bodies: "6/12", "6/12/26", "jun 12" (the shapes
    // CFG.DATE_RE matches). Yearless dates are resolved against the NOTE's own
    // timestamp (anchorTs), not today: a date well before the note was written is
    // read as next year's (promises look forward), so an aged note's "12/20" stays
    // in its own December instead of drifting to a future year. When a body holds
    // several dates ("called 6/20, ETA 7/15") the LATEST one is taken as the
    // promise. Impossible dates (2/31, day 99) are rejected. Returns ts or null.
    function parseBodyDate(s, anchorTs) {
      var anchor = anchorTs ? new Date(anchorTs) : new Date();
      if (isNaN(anchor.getTime())) anchor = new Date();
      var out = null;
      function consider(d) { if (d && !isNaN(d.getTime()) && (out === null || d.getTime() > out)) out = d.getTime(); }
      function anchored(mo, da, yr) {          // mo 1-12; yr null = infer from the anchor
        if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
        var y = yr !== null ? yr : anchor.getFullYear();
        var d = new Date(y, mo - 1, da);
        if (d.getMonth() !== mo - 1 || d.getDate() !== da) return null;   // 2/31-style rollover
        if (yr === null && anchor.getTime() - d.getTime() > 45 * 86400000) {
          d = new Date(y + 1, mo - 1, da);     // well before the note date: forward-looking promise
          if (d.getMonth() !== mo - 1) return null;
        }
        return d;
      }
      var re = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g, m;
      while ((m = re.exec(s || '')) !== null) {
        var yr = null;
        if (m[3]) { yr = parseInt(m[3], 10); if (yr < 100) yr += 2000; }
        consider(anchored(parseInt(m[1], 10), parseInt(m[2], 10), yr));
      }
      var MO = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      var re2 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/ig, m2;
      while ((m2 = re2.exec(s || '')) !== null) {
        consider(anchored(MO.indexOf(m2[1].slice(0, 3).toLowerCase()) + 1, parseInt(m2[2], 10), null));
      }
      return out;
    }

    function woStatus() { return (inputVal('statusId-autocomplete-input') || '').trim(); }

    // Header identifiers (same testids the Client Update script uses).
    function headerInfo() {
      function txt(testid) {
        var el = document.querySelector('[data-testid="' + testid + '"]');
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }
      function clientName() {
        var a = document.querySelector('a[href*="/clients/"]');
        return a ? (a.textContent || '').replace(/\s+/g, ' ').trim() : '';
      }
      function siteAddr() {
        var node = document.querySelector('[data-testid="wo-location-dropdown-input-label"]');
        for (var i = 0; i < 4 && node; i++, node = node.parentElement) {
          var m = (node.textContent || '').match(/\d+[^,\n]+,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?/);
          if (m) return m[0].replace(/\s+/g, ' ').trim();
        }
        return '';
      }
      // Read a WO-header field by its visible LABEL (MUI TextField / Select). Robust to unknown
      // testids: match the <label>, then take the Select's display text or the input value.
      // Returns '' when not found so callers degrade cleanly (never guesses a wrong field).
      function fieldByLabel(labelRe) {
        // Strip zero-width space / BOM (empty MUI Selects render a U+200B, which trim() keeps)
        // so an UNASSIGNED field reads as '' - not a phantom truthy value.
        function clean(s) { return String(s == null ? '' : s).replace(/[​﻿]/g, '').replace(/\s+/g, ' ').trim(); }
        var labels = document.querySelectorAll('label');
        for (var i = 0; i < labels.length; i++) {
          var lt = (labels[i].textContent || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();
          if (!labelRe.test(lt)) continue;
          var fc = labels[i].closest('.MuiFormControl-root, .MuiTextField-root') || labels[i].parentElement;
          if (!fc) continue;
          // This label IS the field: return ITS value authoritatively (empty -> '') rather than
          // falling through to a later label or the Select's hidden native <input> (an option id).
          var selDisp = fc.querySelector('.MuiSelect-select');
          if (selDisp) return clean(selDisp.textContent);
          var inp = fc.querySelector('input:not([type="hidden"]):not(.MuiSelect-nativeInput), textarea');
          if (inp) return String(inp.value == null ? '' : inp.value).trim();
          // no recognizable value control in this container -> keep looking
        }
        return '';
      }
      return {
        tracking: txt('work-order-header-tracking-number').replace(/\D+/g, ''),
        wo: txt('work-order-header-number-formatted'),
        location: txt('wo-location-dropdown-input-label'),
        client: clientName(),
        addr: siteAddr(),
        coordinator: fieldByLabel(/^assigned to$/i),
        sourceJob: fieldByLabel(/^source job\s*#/i),
        sourcePo: fieldByLabel(/^source po\s*#/i),
        // Priority drives the shared status-clock (bwnThresholdsFor): P1..P4 scale how
        // fast a status is "past its limit". Read the WO-header Priority field; the
        // raw text (e.g. "P2 - Normal (24 hrs)") is passed through - bwnPrioNum pulls
        // the P#. Empty -> neutral 1.0 multiplier (never guesses a harsher clock).
        priority: fieldByLabel(/^(?:wo )?priority\b/i),
        // Intake actionability fields (Phase 2). Empty '' when the field is unset OR
        // not present as a labeled field - the intake gate treats '' as "verify", not
        // a hard assertion, so a mis-read only over-surfaces (the safe direction).
        trade: fieldByLabel(/^trades?\b/i),
        scope: fieldByLabel(/scope of work|^scope\b/i)
      };
    }

    // "335.00 Hrs in Status" badge in the WO header.
    function hrsInStatus() {
      var m = (document.body.textContent || '').match(/([\d,]+(?:\.\d+)?)\s*Hrs?\.?\s+in\s+Status/i);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    }

    // STALLED: an active (not complete) PO whose scheduled date has passed.
    function stalled(pos, C) {
      var worst = null;
      pos.forEach(function (p) {
        if (!(p.amount > 0) || p.done || !p.schedDate) return;
        var ts = parseUSDate(p.schedDate);
        if (!ts) return;
        var over = daysSince(ts);
        if (over > C.schedGraceDays && (!worst || over > worst.days)) {
          worst = { days: over, vendor: p.vendor, date: p.schedDate };
        }
      });
      return worst;
    }

    function etaStatus(pos, notes, stall) {
      var active = pos.filter(function (p) { return p.amount > 0 && !p.done; });
      var labeled = active.filter(function (p) { return p.schedDate !== undefined; });
      if (labeled.length) {
        var missing = labeled.filter(function (p) { return !p.schedDate; });
        if (missing.length) {
          var names = missing.map(function (p) { return p.vendor; }).join(', ');
          return { ok: false, label: missing.length + ' PO unsched', detail: 'No scheduled date on: ' + names + '. Send the ETA reminder.' };
        }
        if (stall) {
          return { ok: false, label: 'Sched passed ' + stall.days + 'd', detail: stall.vendor + ' was scheduled ' + stall.date + ' and is still not complete.' };
        }
        var dates = labeled.map(function (p) { return p.schedDate; }).join(', ');
        return { ok: true, label: 'POs sched: ' + dates, detail: 'Every active PO shows a scheduled date.' };
      }
      var ftEl = document.querySelector('[data-testid="work-order-first-trip-date-picker"]');
      var ft = ftEl ? (ftEl.tagName === 'INPUT' ? ftEl.value : (ftEl.querySelector('input') ? ftEl.querySelector('input').value : '')) : '';
      if (ft && ft.trim()) return { ok: true, label: 'Trip: ' + ft.trim(), detail: 'First-trip date set on the WO (no per-PO dates found).' };
      var hit = null;
      notes.forEach(function (n) {
        if (CFG.ETA_WORDS.test(n.body) && CFG.DATE_RE.test(n.body)) {
          var d = parseNoteDate(n.ts);
          if (!hit || (d && (!hit.d || d > hit.d))) hit = { d: d, ts: n.ts, body: n.body };
        }
      });
      if (hit) {
        // v2.12: parse the promised date \u2014 a blown promise must not read as green.
        // Amber (kind:'warn'), one severity below a per-PO stall, since a date in a
        // note is a weaker signal than a structured scheduled date.
        var promised = parseBodyDate(hit.body, hit.d);
        var anyOpen = pos.some(function (p) { return p.amount > 0 && !p.done; });
        if (promised !== null && anyOpen && daysSince(promised) > bwnConfig().schedGraceDays) {
          return { ok: false, kind: 'warn', label: 'Noted ETA passed ' + daysSince(promised) + 'd',
            detail: 'A note promised an ETA around ' + new Date(promised).toLocaleDateString() + ' \u2014 that date has passed with a PO still open. Re-confirm the date with the vendor.' };
        }
        return { ok: true, label: 'ETA noted \u2713' + (hit.ts ? ' (' + hit.ts + ')' : ''), detail: 'A note pairs an ETA word with a date.' };
      }
      return { ok: false, label: 'No ETA found', detail: 'No per-PO scheduled dates, no first-trip date, and no note pairs an ETA word with a date. Use Deep Scan to cover the full note history.' };
    }

    function dueStatus(C) {
      var v = inputVal('work-order-expected-completion-date-picker');
      var ts = parseUSDate(v);
      if (!ts) return null;
      var d = daysUntil(ts);
      if (d < 0) return { kind: 'bad', label: 'Overdue ' + Math.abs(d) + 'd', detail: 'Complete-by date (' + v.trim() + ') has passed.', raw: v.trim() };
      if (d <= C.dueWarnDays) return { kind: 'warn', label: 'Due ' + d + 'd', detail: 'Complete by ' + v.trim() + '.', raw: v.trim() };
      return { kind: 'ok', label: 'Due ' + d + 'd', detail: 'Complete by ' + v.trim() + '.', raw: v.trim() };
    }

    function staleness(notes) {
      var newest = null;
      notes.forEach(function (n) {
        var d = parseNoteDate(n.ts);
        if (d && (!newest || d > newest)) newest = d;
      });
      if (!newest) return null;
      return daysSince(newest);
    }

    function compute() {
      var C = bwnConfig();
      // Header read ONCE per compute (was an inline IIFE just for priority) - reused for
      // priority AND published on state.hd so the pure computeNextActions engine reads the
      // WO's identity/intake fields (tracking/location/trade/scope) from STATE, not the DOM.
      var hd = (function () { try { return headerInfo(); } catch (e) { return {}; } })();
      var woApi = readWO(currentWOId());   // async WO-header read (cached); null until it lands
      try { if (woApi && woApi.id) fetchTrips(currentWOId(), woApi.id); } catch (e) { }   // async: populates bwn:trips no-show from the API (needs jobId)
      try { if (woApi && woApi.id) fetchProposals(currentWOId(), woApi.id); } catch (e) { }   // async: populates bwn:props open-count for the live-jobs push (needs jobId)
      try { fetchTasks(currentWOId()); } catch (e) { }   // async: populates bwn:tasks open-count for the live-jobs push (needs only the WO number)
      var pos = readPOs();
      var vendorTotal = pos.reduce(function (a, p) { return a + (p.amount > 0 ? p.amount : 0); }, 0);
      var nte = detectNTE();
      // WO-header override: when the workOrder API has landed, trust its exact money over the
      // DOM scrape. doNotExceed (NOT totalNTE) is the suite's NTE - detectNTE()'s primary
      // selector is input[name="doNotExceed"], so the API doNotExceed is the identical field,
      // just authoritative. Money is MINOR UNITS (amount 22972692 / precision 2 = $229,726.92);
      // bwnMoney() converts to DOLLARS so nte.amount stays in the same convention detectNTE()
      // returns, and the GP math, the intake gate (state.nte.amount), and renderPill all keep
      // working. Falls back to the DOM read when the API is absent (no regression).
      // LIVE-PINNED 2026-07-28 (WO 364040): doNotExceed 468584/p2 rendered exactly as the DOM
      // input's 4,685.84, and totalNTE is the VENDOR-cost NTE total (page "Total NTE",
      // $4,845.08) - the cost side of the API GP fraction, not an alternate client DNE.
      if (woApi) {
        var apiNte = bwnMoney(woApi.doNotExceed);
        if (apiNte !== null && apiNte > 0) nte = { amount: apiNte, source: 'WO API' };
      }
      var gp = null, gpPct = null;
      if (nte && vendorTotal > 0) {
        gp = nte.amount - vendorTotal;
        gpPct = nte.amount > 0 ? (gp / nte.amount) * 100 : null;
      }
      // GP% override: prefer the API GP% (trueGrossProfitPercent, else
      // estimatedGrossProfitPercent) over the computed NTE-minus-PO-sum %. state.gpPct is the
      // single value the pill %, the panel %, and the gpBad/gpWarn color bucket all read, so
      // setting it here moves them together; the computed % remains the fallback when the API
      // GP is absent or unparseable.
      // LIVE-PINNED 2026-07-28 on WOs 364040 / 381367 / 381085 (type "EstimatedTaxed"):
      //   - the API returns STRINGS ("-0.03398323", "1"), so the old typeof-number guards
      //     rejected every live value and this override silently never fired;
      //   - the value is a FRACTION of DNE revenue, not a 0-100 percent:
      //     estimatedGrossProfitPercent === (doNotExceed - totalNTE) / doNotExceed exactly
      //     (364040: (4685.84 - 4845.08) / 4685.84 = -0.03398323), so Number() * 100 lands it
      //     on the 0-100 scale everything downstream reads;
      //   - Umbrava's own header chip is a DIFFERENT basis (364040 showed -12.39% vs the API
      //     -3.40%; delta consistent with ~8.75% NY sales tax), and the API fraction matches
      //     the computed fallback's arithmetic, so no display jump when this override engages.
      // (state.gp dollars stays computed: grossProfitInfo carries no GP amount, so deriving one
      // from a percent whose revenue base is unconfirmed would fabricate a figure.)
      if (woApi && woApi.grossProfitInfo) {
        var gi = woApi.grossProfitInfo;
        var giRaw = (gi.trueGrossProfitPercent !== null && gi.trueGrossProfitPercent !== undefined && gi.trueGrossProfitPercent !== '') ? gi.trueGrossProfitPercent
          : (gi.estimatedGrossProfitPercent !== null && gi.estimatedGrossProfitPercent !== undefined && gi.estimatedGrossProfitPercent !== '') ? gi.estimatedGrossProfitPercent
            : null;
        var apiGpFrac = (giRaw === null) ? NaN : Number(giRaw);   // strings live; Number() passes real numbers too
        if (isFinite(apiGpFrac)) gpPct = apiGpFrac * 100;         // fraction -> the percent scale
      }
      var notes = getNotes();
      // Newest note timestamp -> published on the bus so the Job View can show a real
      // "Latest update" / "Since last note" (GraphQL's notes selector is a guess and usually
      // comes back empty). Prefer the precomputed epoch (tsAbs); fall back to a loose parse.
      var lastNoteTs = 0;
      // Newest CLIENT-facing note (its type chip reads Client/Customer) - a STRUCTURED
      // signal (the real note-type field, not note wording) that drives the client-update
      // cadence step, distinct from generic note staleness (which counts ANY note, incl.
      // internal/vendor). A client-typed note posted later self-clears the cadence step.
      var lastClientTs = 0;
      (notes || []).forEach(function (n) {
        var t = (n && n.tsAbs) || 0;
        if (!t && n && n.ts) { try { var dd = BWN.parseNoteDateLoose(n.ts); if (dd) t = +dd; } catch (e) { } }
        if (t > lastNoteTs) lastNoteTs = t;
        if (t && n && /\b(client|customer)\b/i.test(n.label || '') && t > lastClientTs) lastClientTs = t;
      });
      var stall = stalled(pos, C);
      return {
        pos: pos, vendorTotal: vendorTotal, nte: nte, gp: gp, gpPct: gpPct,
        eta: pos.length ? etaStatus(pos, notes, stall) : null,
        stall: stall, status: woStatus(), hrs: hrsInStatus(),
        priority: (woApi && woApi.priority && woApi.priority.label) || hd.priority || '',
        due: dueStatus(C),
        staleDays: staleness(notes), noteCount: notes.length, lastNote: lastNoteTs ? new Date(lastNoteTs).toISOString() : null, deep: !!deepNotes, notesSrc: lastNotesSrc,
        lastClientNoteDays: lastClientTs ? Math.floor((Date.now() - lastClientTs) / 86400000) : null,   // null = no client-labeled note among the loaded notes
        lastClientNote: lastClientTs ? new Date(lastClientTs).toISOString() : null,   // same signal, full precision - published on the bus for queue convergence
        noShow: (function () { try { var tb = BWN.ssGetJSON('bwn:trips:' + (currentWOId() || ''), null); return (tb && tb.noShow && (Date.now() - (tb.ts || 0)) < 12 * 3600000) ? tb.noShow : null; } catch (e) { return null; } })(),   // 12h TTL bounds a stale phantom in a long-lived tab
        openTasks: readOpenTasks(),
        // Phase 4: the DOM/store inputs the pure computeNextActions engine needs, assembled
        // HERE so state fully determines the playbook (mirrors the computeVerdict refactor -
        // facts in, verdict out). Each is fail-safe so compute() never throws.
        hd: hd,
        jobId: (woApi && woApi.id) || null,   // internal job id (the DOM can't give it) - unblocks the trips/no-show route
        woApi: woApi || null,
        authoredPlan: (function () { try { return readAuthoredPlan(); } catch (e) { return null; } })(),
        docs: (function () { try { return readDocs(); } catch (e) { return null; } })(),
        escRank: (function () { try { return bwnEscRank(); } catch (e) { return null; } })(),
        nudges: (function () { try { return nudgedPrefixes(); } catch (e) { return {}; } })(),
        cfg: C
      };
    }

    // ---- Side-docked tab --------------------------------------------------------
    function chip(text, kind) {
      var c = document.createElement('span');
      c.textContent = text;
      var bg = kind === 'bad' ? 'var(--bwn-bad)' : kind === 'warn' ? 'var(--bwn-warn)' : kind === 'ok' ? 'var(--bwn-accent)' : 'rgba(255,255,255,.18)';
      var col = kind === 'ok' ? 'var(--bwn-green-dk)' : '#fff';
      c.style.cssText = 'display:block;padding:3px 8px;border-radius:8px;font:600 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;background:' + bg + ';color:' + col + ';white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;text-align:center;';
      return c;
    }

    function renderPill(state) {
      var pill = document.getElementById(PILL_ID);
      if (!pill) {
        var left = CFG.DOCK_SIDE === 'left';
        pill = document.createElement('div');
        pill.id = PILL_ID;
        pill.style.cssText = 'position:fixed;' + (left ? 'left:0;' : 'right:0;') + 'top:' + CFG.DOCK_TOP_PCT + '%;z-index:99998;display:flex;flex-direction:column;gap:5px;align-items:stretch;' +
          'padding:' + (left ? '9px 10px 9px 8px' : '9px 8px 9px 10px') + ';border-radius:' + (left ? '0 12px 12px 0' : '12px 0 0 12px') + ';background:' + GREEN + ';' +
          'box-shadow:' + (left ? '3px' : '-3px') + ' 3px 14px rgba(0,0,0,.3);cursor:pointer;' +
          'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;';
        pill.addEventListener('click', function () { openPanel(); });
        document.body.appendChild(pill);
      }
      // Cross-page continuity: surface the WO-list heat verdict in the tab tooltip.
      var lh = busHeatGet(currentWOId(), 12 * 3600000);
      pill.title = 'WO Assist - click for breakdown' +
        (lh && lh.sev > 0 && lh.reasons && lh.reasons.length
          ? '\n' + (lh.acked ? 'Snoozed on WO list: ' : 'Flagged on WO list: ') + lh.reasons.join(' · ') : '');
      pill.textContent = '';
      var tag = document.createElement('span');
      tag.textContent = 'WO';
      tag.style.cssText = 'font:600 10px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#fff;letter-spacing:1px;text-align:center;';
      pill.appendChild(tag);

      if (!state.pos.length) {
        pill.appendChild(chip('No POs', null));
      } else {
        if (state.gpPct !== null) {
          var kind = state.gpPct < state.cfg.gpBad ? 'bad' : state.gpPct < state.cfg.gpWarn ? 'warn' : 'ok';
          pill.appendChild(chip('GP ' + state.gpPct.toFixed(0) + '%', kind));
        } else {
          pill.appendChild(chip('Set DNE', 'warn'));
        }
        if (state.stall) {
          pill.appendChild(chip('STALLED ' + state.stall.days + 'd', 'bad'));
        } else if (state.eta) {
          pill.appendChild(chip(state.eta.ok ? 'ETA \u2713' : state.eta.label, state.eta.ok ? 'ok' : (state.eta.kind === 'warn' ? 'warn' : 'bad')));
        }
      }
      if (state.hrs !== null && state.hrs >= state.cfg.hrsWarn) {
        pill.appendChild(chip(Math.round(state.hrs) + 'h status', state.stall ? 'bad' : 'warn'));
      }
      if (state.due && state.due.kind !== 'ok') pill.appendChild(chip(state.due.label, state.due.kind));
      if (state.staleDays !== null && state.staleDays > state.cfg.noteStaleDays) {
        pill.appendChild(chip('Note ' + state.staleDays + 'd', 'warn'));
      }
    }

    // ---- Breakdown panel (BWN house style) ----------------------------------
    var WA_STYLE_ID = 'bwn-wa-style';
    function ensureWAStyle() {
      if (document.getElementById(WA_STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = WA_STYLE_ID;
      st.textContent =
        // RETIRED SURFACE - read before changing this (animation review 2026-08-10).
        // openPanel() is reachable only from renderPill()'s click handler and from its own
        // Set DNE / Rescan buttons, and renderPill runs only behind `SHOW_WO_DOCK`, which is
        // hardcoded false; the else branch removes both the pill and this panel on every engine
        // pass. So nothing can open it today and no motion here is observable.
        //
        // Two safe things were done anyway, so a flag flip inherits correct motion: the built-in
        // ease-out became the strong curve the rest of the suite uses, and reduced motion is
        // honoured (it was covered by no query at all).
        //
        // NOT done, deliberately: this panel did not get the .bwn-drawer exit treatment. Its
        // close() is called as `close(); openPanel();` from two of its own footer buttons, so a
        // deferred removal would leave the old node under the same id and the toggle at the top
        // of openPanel would then close the fresh panel instead of opening it. Wiring an exit
        // here needs that reentry fixed first, and it cannot be tested while the surface is dark.
        '@keyframes bwnWaIn{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}' +
        '.bwn-wa-card{background:var(--bwn-surface);border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;box-shadow:0 18px 60px rgba(0,0,0,.35);animation:bwnWaIn .18s cubic-bezier(.23,1,.32,1);display:flex;flex-direction:column;}' +
        '@media (prefers-reduced-motion:reduce){.bwn-wa-card{animation:none;}}' +
        '.bwn-wa-head{background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:14px 18px;display:flex;align-items:center;gap:12px;}' +
        '.bwn-wa-head .t{font-weight:500;font-size:15px;line-height:1.2;}' +
        '.bwn-wa-head .s{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.75);margin-top:3px;}' +
        '.bwn-wa-tag{margin-left:auto;padding:4px 11px;border-radius:12px;font:600 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:.6px;white-space:nowrap;background:rgba(255,255,255,.18);color:#fff;}' +
        '.bwn-wa-tag.bad{background:var(--bwn-bad);}' +
        '.bwn-wa-body{padding:12px 16px;max-height:62vh;overflow:auto;}' +
        '.bwn-wa-sec{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);text-transform:none;letter-spacing:normal;margin:10px 2px 4px;}' +
        '.bwn-wa-sec:first-child{margin-top:0;}' +
        '.bwn-wa-group{border:1px solid var(--bwn-border-2);border-radius:10px;padding:2px 12px;background:var(--bwn-surface-2);}' +
        '.bwn-wa-line{display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid var(--bwn-surface-3);font-size:13px;}' +
        '.bwn-wa-line:last-child{border-bottom:none;}' +
        '.bwn-wa-line .l{color:var(--bwn-text-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.bwn-wa-line .v{font-weight:500;white-space:nowrap;color:var(--bwn-text);}' +
        '.bwn-wa-line .v.strong{font-weight:500;}' +
        '.bwn-wa-calc{margin-top:10px;padding:11px 14px;border-radius:10px;background:var(--bwn-tint);border-left:3px solid var(--bwn-accent);}' +
        '.bwn-wa-calc .crow{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--bwn-text-muted);font-weight:500;}' +
        '.bwn-wa-calc input{width:62px;padding:5px 7px;border:1px solid var(--bwn-border);border-radius:8px;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-align:right;outline:none;}' +
        '.bwn-wa-calc input:focus{border-color:var(--bwn-accent);box-shadow:0 0 0 3px rgba(46,204,113,.15);}' +
        '.bwn-wa-calc .cout{margin-top:7px;font-size:13px;line-height:1.55;color:var(--bwn-text);}' +
        '.bwn-wa-alert{margin-top:10px;padding:10px 13px;border-radius:10px;font-size:13px;line-height:1.5;}' +
        '.bwn-wa-alert.ok{background:var(--bwn-tint);color:var(--bwn-green-dk);}' +
        '.bwn-wa-alert.bad{background:var(--bwn-bad-bg);color:var(--bwn-bad-fg);border-left:3px solid var(--bwn-bad);}' +
        '.bwn-wa-alert.warn{background:var(--bwn-warn-bg);color:var(--bwn-warn-fg);border-left:3px solid var(--bwn-warn);}' +
        '.bwn-wa-meta{margin-top:9px;font:11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-wa-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:11px 16px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);flex-wrap:wrap;}' +
        '.bwn-wa-btn{padding:8px 15px;border:none;border-radius:8px;cursor:pointer;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;transition:filter .12s;}' +
        '.bwn-wa-btn:hover{filter:brightness(1.06);}' +
        '.bwn-wa-btn:disabled{opacity:.55;cursor:default;}' +
        '.bwn-wa-btn.primary{color:#fff;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));}' +
        '.bwn-wa-btn.ghost{color:var(--bwn-green);background:var(--bwn-tint);}' +
        '.bwn-act-row{display:flex;gap:9px;align-items:flex-start;padding:9px 2px;border-bottom:1px solid var(--bwn-surface-3);}' +
        '.bwn-act-row input[type=checkbox]{width:15px;height:15px;margin-top:2px;accent-color:var(--bwn-green);cursor:pointer;flex:none;}' +
        '.bwn-act-main{flex:1;min-width:0;}' +
        '.bwn-act-lbl{font-size:13px;color:var(--bwn-text);line-height:1.35;}' +
        '.bwn-act-lbl.done{text-decoration:line-through;color:var(--bwn-text-faint);}' +
        '.bwn-act-why{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-top:2px;}' +
        '.bwn-act-log{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-strong);margin-top:3px;}' +
        '.bwn-act-row.nudge{box-shadow:inset 3px 0 0 var(--bwn-bad);padding-left:8px;}' +
        '.bwn-act-dis{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-warn);margin-top:3px;}' +
        '.bwn-act-btns{display:flex;flex-direction:column;gap:4px;flex:none;align-items:stretch;}' +
        '.bwn-act-lbl.nav{cursor:pointer;}' +
        '.bwn-act-lbl.nav:hover{text-decoration:underline;text-underline-offset:2px;}' +
        '.bwn-act-lbl.nav:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;border-radius:4px;}' +
        '.bwn-act-help-t{display:inline-block;margin-left:6px;padding:0;width:15px;height:15px;line-height:14px;vertical-align:1px;border:1px solid var(--bwn-border);border-radius:999px;background:var(--bwn-surface-2);color:var(--bwn-text-faint);font:600 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;cursor:pointer;flex:none;}' +
        '.bwn-act-help-t:hover{color:var(--bwn-green);border-color:var(--bwn-green);}' +
        '.bwn-act-help{margin-top:5px;padding:7px 9px;border-left:2px solid var(--bwn-green);border-radius:0 6px 6px 0;background:var(--bwn-surface-2);font-size:11.5px;line-height:1.45;color:var(--bwn-text-strong);}' +
        '.bwn-act-help div + div{margin-top:3px;}' +
        '.bwn-act-flash{outline:2px solid var(--bwn-green)!important;outline-offset:3px;border-radius:6px;}' +
        '.bwn-act-anchor{background:var(--bwn-surface-2);border-bottom:none;border-radius:8px;margin-top:3px;}' +
        '.bwn-act-anchor .bwn-act-lbl{font-style:italic;color:var(--bwn-text-faint);}' +
        '.bwn-act-anchor-mk{flex:none;width:15px;text-align:center;color:var(--bwn-warn);margin-top:1px;font-size:13px;}' +
        '.bwn-act-esc{padding:7px 12px;font:500 11.5px ui-monospace,"Segoe UI Mono","SF Mono",monospace;background:var(--bwn-warn-bg);color:var(--bwn-warn-fg);border-top:1px solid var(--bwn-border-2);line-height:1.4;}' +
        '.bwn-act-esc:last-child{border-radius:0 0 9px 9px;}' +
        '.bwn-actc{display:block;width:100%;align-self:stretch;box-sizing:border-box;margin:6px 0 14px;border:1px solid var(--bwn-border);border-left:3px solid var(--bwn-green);border-radius:10px;background:var(--bwn-surface);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;box-shadow:0 1px 4px rgba(13,38,26,.06);}' +
        '.bwn-actc-hd{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;user-select:none;}' +
        '.bwn-actc-hd:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:-2px;}' +
        '.bwn-actc-t{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);letter-spacing:.08em;}' +
        '.bwn-actc-n{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:#fff;background:var(--bwn-warn);border-radius:999px;padding:2px 9px;white-space:nowrap;}' +
        '.bwn-actc-n.ok{background:var(--bwn-accent);color:var(--bwn-green-dk);}' +
        '.bwn-actc-n.anchor{background:var(--bwn-surface-3);color:var(--bwn-text-faint);}' +
        '.bwn-actc-s{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-left:auto;}' +
        '.bwn-actc-x{color:var(--bwn-text-faint);font-size:11px;}' +
        '.bwn-actc-body{padding:2px 12px 9px;}';
      document.head.appendChild(st);
    }

    function waLine(parent, label, value, strong, color, titleText) {
      var row = document.createElement('div'); row.className = 'bwn-wa-line';
      var l = document.createElement('span'); l.className = 'l'; l.textContent = label;
      var v = document.createElement('span'); v.className = 'v' + (strong ? ' strong' : ''); v.textContent = value;
      if (color) v.style.color = color;
      if (titleText) row.title = titleText;
      row.appendChild(l); row.appendChild(v); parent.appendChild(row);
    }
    function waSection(parent, label) {
      var h = document.createElement('div'); h.className = 'bwn-wa-sec'; h.textContent = label;
      parent.appendChild(h);
      var g = document.createElement('div'); g.className = 'bwn-wa-group';
      parent.appendChild(g);
      return g;
    }
    function waAlert(parent, text, kind) {
      var e = document.createElement('div');
      e.className = 'bwn-wa-alert ' + (kind === 'warn' ? 'warn' : kind ? 'bad' : 'ok');
      e.textContent = text;
      parent.appendChild(e);
    }

    // ---- Next-Action playbook (Phase: playbook) ------------------------------
    // Maps the computed WO state to the most valuable next moves, each with a
    // ready-to-send chase text. Ordered by operational priority. Returns ALL
    // applicable actions; the WO Assist panel shows the top 3 and the Action
    // Checklist shows the full list. Each action carries a stable `key` that
    // encodes its COMPOSITION (vendors/status/date), so a checked-off item
    // automatically REOPENS if the underlying situation changes.
    // Conservative per-step "a note shows this was handled" signals, keyed by the
    // action's key-prefix. Matched only against RECENT notes (autoDetectActioned
    // gates by date) and only ever AUTO-CHECK a step (reversible), never hard-drop.
    // Polarity matters (review): a signal is evaluated PER CLAUSE and vetoed if that
    // clause is negated - so "hasn't completed", "no ETA", "haven't received the
    // quote" do NOT converge. Positives require done/received framing, not bare
    // vocabulary or future intent ("will complete", "need to request"). Over-vetoing
    // is the safe direction (coordinator just checks it by hand); false-checking an
    // open step is the harm we're avoiding.
    var ACT_NEG = /\b(no|nothing|none|not|never|without|cannot|can'?t|couldn'?t|won'?t|wouldn'?t|didn'?t|doesn'?t|don'?t|haven'?t|hasn'?t|hadn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|shouldn'?t|unable)\b/i;
    function actClauses(b) { return String(b || '').split(/[.!?;\n•]+/); }
    function actAffirm(b, posRe) {
      var cl = actClauses(b);
      for (var i = 0; i < cl.length; i++) { if (posRe.test(cl[i]) && !ACT_NEG.test(cl[i])) return true; }
      return false;
    }
    // ETA: same ETA-word + date pairing etaStatus uses, per clause, negation-vetoed,
    // PLUS etaStatus's blown-promise guard - a clause whose date is already well past
    // isn't a forward ETA, so it can't converge the "Get ETA" step.
    function actAffirmEta(b) {
      var cl = actClauses(b), grace = (bwnConfig().schedGraceDays || 3);
      for (var i = 0; i < cl.length; i++) {
        var c = cl[i];
        if (!(CFG.ETA_WORDS.test(c) && CFG.DATE_RE.test(c)) || ACT_NEG.test(c)) continue;
        var pd = parseNoteDate(c);
        if (pd !== null && (Date.now() - pd) / 86400000 > grace) continue;   // blown/past promise
        return true;
      }
      return false;
    }
    var ACT_SIGNALS = {
      stall: function (b) { return actAffirm(b, /\b(completed|finished|wrapped up|signed[- ]?off|sign(ed)?[- ]?off|signed the (ticket|paperwork|report)|completion\s+(doc|report|ticket)|docs?\s+(uploaded|attached|received)|photos?\s+(uploaded|attached)|(re-?scheduled|rebooked|pushed)\s+(to|for)|new date (is|of|:|-))\b/i); },
      eta: function (b) { return actAffirmEta(b); },
      quote: function (b) { return actAffirm(b, /\b(proposal|quote|estimate|bid)\s+(received|in|attached|approved|submitted)\b/i) || actAffirm(b, /\b(received|got|have)\s+(the\s+|your\s+|their\s+|a\s+)?(proposal|quote|estimate|bid)\b/i) || actAffirm(b, /\bpo\s+(issued|approved|created|cut|sent)\b/i) || actAffirm(b, /\breassigned\b/i); },
      parts: function (b) { return actAffirm(b, /\b(tracking\s*#|tracking\s*(number|no)|delivered|deliver(y|ing)|arriv(e|ed|ing|al)|ship(ped|ping|ment)|back[- ]?order(ed)?|parts?\s+(in|arrived|ordered|delivered|eta)|materials?\s+(in|arrived|ordered|delivered|eta|delivery))\b/i); },
      client: function (b) { return actAffirm(b, /\b(client\s+(approved|responded|confirmed|advised|authoriz|declin|said|replied|gave|asked us)|approved by (the )?client|per (the )?client|authoriz(ed|ation)|got (a )?(response|answer|direction|approval) from)\b/i); },
      ecd: function (b) { return actAffirm(b, /\b(updated?\s+(the )?(expected )?completion|new\s+(completion|ecd|complete-?by)\s+date|reset\s+(the )?(date|completion|ecd)|expected completion\s+(updated|changed|reset)|revised\s+(the )?completion)\b/i); },   // completion-date phrases only - a generic "client update" note must not converge an ECD step whose field is still empty (the field getting a date self-converges via state)
      dne: function (b) { return actAffirm(b, /\b((requested|submitted)\s+(a |an |the )?(dne|nte|change[- ]?order|increase)|(dne|nte|change[- ]?order)\s+(submitted|requested|sent|approved)|revised\s+(costs?|nte|dne|pricing)|price increase\s+(requested|submitted))\b/i); }
    };

    // WO status NAME -> canonical action phase. Built from Umbrava's live status
    // taxonomy (50+ statuses across ~12 system phases) so EVERY status maps to a
    // real next step - not the 5 literal-string regexes the old logic matched.
    // Unknown/custom statuses (not here) fall through to the generic PO/ECD/note
    // steps. Keys are lowercased status display names (what woStatus() reads).
    var ESCALATE_DAYS = 14;   // stuck past this (in a waiting phase, or a vendor miss) → it's a management call, not another coordinator chase
    var WO_PHASE = {
      'new': 'intake', 'pending service request': 'schedule', 'pending dispatch': 'schedule',
      'pending schedule': 'schedule', 'recruiting vendor': 'schedule', 'vendor compliance': 'schedule',
      'vendor proposal required': 'proposal', 'vendor proposal received': 'proposal', 'supplier proposal pending': 'proposal',
      'preparing client proposal': 'proposal', 'pending proposal review': 'proposal', 'internal proposal rejected': 'proposal',
      'proposal rejected': 'proposal', 'pending trade specialist': 'proposal', 'atf prep': 'proposal', 'atf rejected': 'proposal',
      'proposed': 'proposal-sent', 'atf submitted': 'proposal-sent',
      'internal proposal approved': 'proposal-approved', 'proposal approved': 'proposal-approved', 'atf approved': 'proposal-approved',
      'need material': 'materials', 'material ordered': 'materials', 'pending materials supplier': 'materials',
      'awaiting supplier': 'materials', 'rma': 'materials', 'fabrication': 'materials',
      'pending materials client': 'materials-client',
      'scheduled': 'scheduled', 'on the way': 'onsite', 'on-site': 'onsite', 'equipment rental': 'materials',
      'clocked out: in progress': 'inprogress', 'awaiting 3rd party': 'inprogress',
      'client action required': 'client', 'on hold': 'onhold', 'pending acceptance': 'accept',
      'confirm complete': 'confirmcomplete', 'confirm reopen': 'recall',
      // Work-complete → invoiced → paid is BILLING's job (they do not use this tool),
      // so the coordinator has NO next actions once work is complete → 'terminal'.
      // EXCEPTION: 'clocked out: complete' is NOT terminal - it's the cost-review stage
      // ('costreview'): the tech has finished, so the coordinator confirms the final cost
      // on each used PO before marking the WO Work Complete. (The 'workcomplete'/'billing'/
      // 'invoiced' entries in woActionForStatus are unreachable behind the terminal guard.)
      'clocked out: complete': 'costreview', 'work complete': 'terminal', 'recall': 'recall', 'resolved': 'terminal',
      'pending ability to bill': 'terminal', 'invoice created': 'terminal', 'invoice rejected': 'terminal',
      'invoiced': 'terminal', 'invoice approved': 'terminal',
      'paid': 'terminal', 'closed': 'terminal', 'canceled': 'terminal', 'cancelled': 'terminal',
      'declined': 'terminal', 'revoked': 'terminal', 'confirm cancel': 'terminal'
    };
    // phase -> WO-level action. sig names an ACT_SIGNALS key for note-convergence
    // (state change on the next status move is the primary converger regardless).
    function woActionForStatus(state, ref, phase) {
      if (!phase || phase === 'terminal') return null;
      var status = (state.status || '').trim();
      // Priority-scaled status budget (shared engine). When the WO is past its limit,
      // the "h in status" note carries the ratio so the coordinator sees WHY it is
      // hot (a P1 3x over its limit reads very differently from a P4 just past warn).
      var th = bwnThresholdsFor(status, state.priority, state.cfg || bwnConfig());
      var pn = bwnPrioNum(state.priority);
      var overRatio = (state.hrs !== null && th.bad > 0) ? state.hrs / th.bad : 0;
      var hb = state.hrs !== null
        ? ' (' + Math.round(state.hrs) + 'h in status' + (overRatio >= 1 ? ', ' + overRatio.toFixed(1) + 'x the ' + Math.round(th.bad) + 'h limit' + (pn ? ' for P' + pn : '') : '') + ')'
        : '';
      // "Way past its clock" - replaces the old flat 720h. 3x the priority-scaled bad
      // limit reproduces the original 720h at P3 (240h base) and now scales with
      // priority (P1 escalates far sooner, P4 later).
      var stale720 = overRatio >= 3;
      var A = {
        intake: ['Dispatch or scope this WO', 'Status "' + status + '" - not yet assigned', 'Re: ' + ref + '. New work order - assign a vendor (or scope it) and get it moving today.', null],
        schedule: ['Recruit / dispatch a vendor and get a date', 'Status "' + status + '"' + hb + ' - no vendor scheduled', 'Hi - re: ' + ref + '. We need coverage on this. Please confirm you can take it with a scheduled date + on-site tech, or tell me today so I can reassign.', 'quote'],
        proposal: ['Move the proposal forward', 'Status "' + status + '"' + hb, 'Hi - re: ' + ref + '. We are waiting on the proposal to advance this work order. Please send scope + price + lead time by end of day, or advise if you cannot quote so I can reassign.', 'quote'],
        'proposal-sent': ['Chase the client for proposal approval', 'Proposal sent - status "' + status + '"' + hb, 'Hi - following up on the proposal for ' + ref + '. Are we approved to proceed? Happy to walk through scope/price; we cannot schedule the work until it is signed off.', 'client'],
        'proposal-approved': ['Send approved proposal to client / issue the vendor PO', 'Proposal approved internally - status "' + status + '"', 'Re: ' + ref + '. Proposal is approved internally - send it to the client for sign-off, and once approved issue the vendor PO so work can start.', 'client'],
        materials: ['Chase material delivery ETA + tracking', 'Status "' + status + '"' + hb, 'Hi - re: ' + ref + '. Please confirm the materials: supplier, expected delivery date, and tracking #. Once they land, reply with the return-visit date so I can update the client.', 'parts'],
        'materials-client': ['Chase the client for their materials', 'Client-supplied materials - status "' + status + '"' + hb, 'Hi - re: ' + ref + '. This is waiting on client-provided materials. Please advise the delivery date so we can schedule the return visit.', 'client'],
        scheduled: ['Confirm the scheduled visit + prep', 'Status "Scheduled"' + hb + ' - a visit is booked', 'Hi - confirming the scheduled visit for ' + ref + '. Please reply with the tech + arrival window and flag any parts/access needs so the trip is not wasted.', 'eta'],
        onsite: ['Confirm on-site progress + ETA to complete', 'Status "' + status + '"' + hb, 'Hi - re: ' + ref + '. Your tech is on-site - please send a quick status and the ETA to completion (or the next step + return date).', null],
        recall: ['Reschedule the return visit (recalled/reopened)', 'Status "' + status + '" - completed work was rejected/reopened', 'Hi - re: ' + ref + '. This was recalled/reopened - the prior visit did not resolve it. Please schedule a return trip and advise the date so I can update the client.', 'eta'],
        inprogress: ['Follow up on in-progress work', 'Status "' + status + '"' + hb, 'Hi - re: ' + ref + '. Checking on progress - where does this stand and what is the ETA to completion? Flag any 3rd-party/supplier blocker so I can help.', null],
        client: ['Escalate to client for direction' + (stale720 ? ' (close-or-escalate)' : ''), 'Waiting on client' + hb, 'Hi - re: ' + ref + '. This is on hold pending your direction (see the last note). Please advise how to proceed; if we do not hear back by end of week we will follow up by phone.' + (stale720 ? ' Pending ' + Math.round(state.hrs / 24) + ' days - flag for close-or-escalate review.' : ''), 'client'],
        onhold: ['Review the hold - release or confirm', 'Status "On Hold"' + hb, 'Re: ' + ref + '. This WO is on hold - confirm the blocker, whether it can be released, and reset the expected date + client note accordingly.', null],
        accept: ['Accept / assign or decline the WO', 'Status "Pending Acceptance"' + hb, 'Re: ' + ref + '. Pending acceptance - accept and assign coverage, or decline so it can be rerouted.', null],
        confirmcomplete: ['Confirm completion + collect sign-off/photos', 'Status "' + status + '" - vendor marked complete', 'Hi - re: ' + ref + '. Please upload the completion package (signed ticket, sign-in/out, before/after photos) so we can confirm complete and invoice.', 'stall'],
        workcomplete: ['Collect docs + create the client invoice', 'Status "' + status + '" - work done, not yet invoiced', 'Re: ' + ref + '. Work is complete - verify the completion docs are attached, then create/submit the client invoice.', null],
        billing: ['Advance the invoice', 'Status "' + status + '"' + hb, 'Re: ' + ref + '. Invoice stage ("' + status + '") - clear any billing hold and get the invoice approved/submitted.', null],
        invoiced: ['Confirm payment / close out', 'Status "' + status + '" - invoiced', 'Re: ' + ref + '. Invoiced - confirm payment status and close the WO when paid.', null]
      };
      var d = A[phase]; if (!d) return null;
      var act = { key: 'phase:' + phase, label: d[0], why: d[1], text: d[2] };
      if (d[3] && ACT_SIGNALS[d[3]]) act.resolve = ACT_SIGNALS[d[3]];
      return act;
    }

    // Objective urgency score (higher = more urgent = sorts first). Deterministic -
    // driven by real signals (overdue days, GP depth, stall/no-show age), NEVER by
    // coordinator habit. Worst-first ordering keeps the hard steps on top; it never
    // hides or de-lists anything.
    function scoreAct(a, state) {
      // Authored plan items keep their AUTHORED order among themselves (fractional
      // decrement, stable sort), ranked WITH the generated steps since the Phase 1 merge:
      // 88 = the human-authored to-do shelf (same as `task`), so live emergencies and hard
      // gates (noshow 100+, stall 96+, escalate 94, docs 92, intake 90) sort above the
      // plan, and routine chases (dne 82 base, ecd, po*, phase) sort below it - a
      // badly-underwater dne or a long-running no-show still climbs past on its boost.
      // (Pre-Phase-1 this was 1000 - ord: the takeover pin above every generated step.)
      if (a.authored) return 88 - Math.min(30, a.ord || 0) * 0.01;
      var p = a.key.split(':')[0];
      // Phase 2: docs (missing completion package at closure) sorts just under escalate
      // - closing without the signed ticket/photos is a hard block. intake (unactionable
      // WO at inception) sorts above the generic phase chase so "fix the WO" leads.
      var base = { noshow: 100, stall: 96, ecdrisk: 95, escalate: 94, docs: 92, intake: 90, task: 88, unbilled: 84, dne: 82, ecd: 78, pocost: 72, poacc: 68, pomat: 66, poconf: 64, eta: 60, advance: 58, phase: 50, clientcad: 46, note: 44, anchor: 12 };
      var s = base[p]; if (s === undefined) s = 50;
      var cap = function (n) { return Math.max(0, Math.min(30, n || 0)); };
      if (p === 'noshow' && state.noShow) s += cap(Math.round((Date.now() - state.noShow.ms) / 86400000));
      else if (p === 'stall' && state.stall) s += cap(state.stall.days);
      else if (p === 'ecd') { if (a.key === 'ecd:none') s = 58; else if (state.due && state.due.label) s += cap(parseInt((state.due.label.match(/\d+/) || [0])[0], 10)); }
      else if (p === 'dne' && state.gpPct !== null) s += cap(Math.round(state.cfg.gpBad - state.gpPct));
      else if (p === 'note') s += cap(state.staleDays);
      else if (p === 'clientcad' && state.lastClientNoteDays !== null) s += cap(state.lastClientNoteDays);   // older client silence sorts higher; capped so it never outranks a real chase
      else if (p === 'task' && /overdue/i.test(a.why || '')) s += 10;   // capped so an overdue task (→98) stays just under a no-show (100) - a client-visible vendor miss outranks an internal to-do
      else if (p === 'phase') s += ({ client: 30, accept: 22, onhold: 20, 'materials-client': 18, 'proposal-approved': 12, 'proposal-sent': 10, schedule: 8 }[a.key.split(':')[1]] || 0);
      // Nudge boost (Increment B): habitually-dismissed types sort HIGHER - but capped
      // at 99 so a nudge can never outrank a live no-show (a client-visible vendor miss
      // stays the top of the list regardless of habits).
      if (a.nudge && s < 99) s = Math.min(s + 8, 99);
      return s;
    }

    // Parse a coordinator/AI-authored "Next Actions Required" list out of a note body.
    // Resilient to newline collapse (readMountedNotes uses textContent, which can drop
    // line breaks): after the header, split on the numbered markers ("1." / "2)")
    // regardless of newlines. Returns the item strings in authored order, or null when
    // the note has no structured plan. Zero-egress - pure text parsing of a note we
    // already read via getNotes().
    function parseAuthoredItems(body) {
      var b = String(body || '').replace(/ /g, ' ');
      var hm = b.match(/next\s*actions?\s*required|next\s*actions?\b|next\s*steps?\b|action\s*items?\b/i);
      if (!hm) return null;
      var strong = /required/i.test(hm[0]);   // the exact "Next Actions Required" template (AI + coordinator) is a strong signal
      var seg = b.slice(hm.index + hm[0].length);
      // A list marker = a 1–2 digit number + "." or ")" + space, positioned at the START
      // of an item: at seg start, or right after a newline or the previous item's sentence
      // punctuation (. ; :). Robust to newline collapse ("…deadline.2.") yet it won't fire
      // inside "(submitted 5/18)" (the "18" follows "/") or "$4,173.77" (no marker
      // punctuation+space after). mstart is the DIGIT position, so the delimiter char stays
      // with the previous item's text.
      var re = /(^|[.\n;:])[ \t]*(\d{1,2})[.)]\s+/g, mm, marks = [];
      while ((mm = re.exec(seg)) !== null) marks.push({ mstart: mm.index + mm[0].indexOf(mm[2]), tstart: mm.index + mm[0].length });
      if (!marks.length) return null;
      var items = [];
      for (var i = 0; i < marks.length; i++) {
        var end = (i + 1 < marks.length) ? marks[i + 1].mstart : seg.length;
        var txt = seg.slice(marks[i].tstart, end).replace(/\s+/g, ' ').trim();
        // Strip a trailing footer/section tail that ran into the last item.
        txt = txt.replace(/\s*(tracking\s*#|wo\s*#|status\s*:|risk\s*flag|done\s*so\s*far)\b.*$/i, '').trim();
        if (txt) items.push(txt);
      }
      if (!items.length) return null;
      if (items.length < 2 && !strong) return null;   // a casual "next step: …" mention must not hijack the checklist
      return items;
    }
    // Stable per-item key hash (over the whitespace-normalized label, so it is identical
    // across the three getNotes() sources; it changes only if the author edits the item
    // text → that one item reopens for re-review).
    function authoredKeyHash(s) { var h = 0, x = String(s); for (var i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
    // Newest note carrying an authored plan. Ranked by Umbrava's monotonic note id
    // (highest = newest) - stable across the deep/cache/view sources and immune to
    // relative-timestamp drift ("1 hour ago"). Never rank or key by the display ts.
    // Phase 0 plan hysteresis - PURE decision: given the freshly-computed winning plan
    // (note-vs-dashboard, from readAuthoredPlan), the remembered `_plan` meta from the acts
    // store, and how the notes were read ('deep'|'cache'|'view'), decide what the checklist
    // builds from. A candidate OLDER than the remembered plan is accepted only from an
    // AUTHORITATIVE notes read (deep/cache) - on a partial DOM read ('view') the newer plan
    // note has likely just not mounted yet, and dethroning it flips labels/convergence back
    // to a stale source (the check-off-revert repro). While held, the newer plan rebuilds
    // from the cached _plan items so the card neither flaps nor goes blank; no cache =
    // degrade to the candidate (pre-Phase-0 behavior). Returns { plan, meta, clear }:
    // meta = new _plan record to persist (null = leave as is), clear = drop _plan
    // (authoritative read proved the plan is gone). _plan is underscore-prefixed so it can
    // never collide with an act key; nothing iterates the store except actsMigrate (regex-
    // gated), so the meta record is invisible to every act path.
    function planHysteresis(best, pm, notesSrc) {
      var authoritative = notesSrc !== 'view';
      function cacheOf(b, ms) { return { ref: String(b.id || ''), ms: ms, ts: b.ts || null, dash: !!b.dash, items: (b.items || []).slice(0, 40) }; }
      function rebuild(p) { return { items: (p.items || []).slice(), id: p.ref, ts: p.ts, dash: !!p.dash, when: p.dash ? new Date(p.ms) : undefined, held: true }; }
      var candMs = null, candRef = '';
      if (best) {
        candRef = String(best.id || '');
        if (best.dash) candMs = best.when ? +best.when : 0;
        else { try { var pd = BWN.parseNoteDateLoose(best.ts); if (pd) candMs = +pd; } catch (e) { } }
      }
      if (!best) {
        if (!pm) return { plan: null, meta: null, clear: false };
        if (authoritative) return { plan: null, meta: null, clear: true };
        return { plan: (pm.items && pm.items.length) ? rebuild(pm) : null, meta: null, clear: false };
      }
      var eff = (candMs === null) ? Infinity : candMs;   // undatable NOTE plan = live surface, wins (mirrors the dash winner test)
      var persistMs = (candMs === null) ? Date.now() : candMs;   // JSON cannot hold Infinity - persist first-seen time
      if (!pm || candRef === String(pm.ref || '') || eff >= pm.ms) {
        return { plan: best, meta: cacheOf(best, (pm && candRef === String(pm.ref || '') && candMs === null) ? pm.ms : persistMs), clear: false };
      }
      if (authoritative) return { plan: best, meta: cacheOf(best, persistMs), clear: false };   // real rollback (newer note deleted)
      return { plan: (pm.items && pm.items.length) ? rebuild(pm) : best, meta: null, clear: false };
    }
    function readAuthoredPlan() {
      var notes = getNotes(), best = null, bestRank = -1;
      for (var i = 0; i < notes.length; i++) {
        var items = parseAuthoredItems(notes[i].body);
        if (!items) continue;
        var rank = parseInt(notes[i].id, 10) || 0;
        if (rank > bestRank) { bestRank = rank; best = { items: items, id: notes[i].id || '', ts: notes[i].ts }; }
      }
      // The DASHBOARD case file is a second plan source: the AI script pulls it from the
      // SWA (key-gated GET, cached on the bus per tracking #) and the NEWER of the two
      // plans wins - so a plan authored on the dashboard drives this checklist too, and a
      // newer Umbrava note supersedes a stale dashboard record.
      //
      // The case file is an ACCUMULATING document - Recent Updates PREPEND
      // "## YYYY-MM-DD - Update" blocks and superseded NEXT ACTIONS stay in the older
      // blocks' text. So: parse per block, newest first, first block with items wins
      // (mirrors the dashboard's own hoist), never across blocks (review MAJOR - parsing
      // the whole note resurrected superseded plans and glued heading prose onto items).
      //
      // Recency comes from the WINNING BLOCK's own date stamp - NOT updatedAt, which
      // bumps on every unrelated save (action pill, AI summary) and would let a stale
      // plan hijack a newer Umbrava note (review MAJOR). It also keys the plan, so
      // unrelated saves can't orphan checked state. Day-granularity rules:
      //   winner test  - dash wins only from a strictly LATER instant than the Umbrava
      //                  plan (block start-of-day vs note instant → Umbrava wins ties);
      //   convergence  - the key carries the block's END-of-day, so only later-day notes
      //                  can auto-check dash items (same-day facts may predate the plan).
      try {
        var tr = headerInfo().tracking;
        var rec = tr ? BWN.ssGetJSON('bwn:swa:' + tr, null) : null;
        if (rec && rec.job && rec.job.note) {
          var blocks = String(rec.job.note).split(/(?=##\s*\d{4}-\d{2}-\d{2}\s*-\s*Update)/);
          var dItems = null, blockMs = 0;
          for (var b = 0; b < blocks.length && !dItems; b++) {
            var items2 = parseAuthoredItems(blocks[b]);
            if (items2 && items2.length) {
              dItems = items2;
              var hm2 = blocks[b].match(/##\s*(\d{4})-(\d{2})-(\d{2})\s*-\s*Update/);
              if (hm2) blockMs = +new Date(parseInt(hm2[1], 10), parseInt(hm2[2], 10) - 1, parseInt(hm2[3], 10));   // LOCAL midnight
              else blockMs = Date.parse(rec.job.updatedAt || '') || 0;   // headerless base case file - updatedAt fallback
            }
          }
          if (dItems && blockMs) {
            var uMs = Infinity;   // unparseable Umbrava ts → keep the Umbrava plan (live surface wins ties)
            if (best) { try { var ud = BWN.parseNoteDateLoose(best.ts); if (ud) uMs = +ud; } catch (e) { } }
            if (!best || blockMs > uMs) {
              var cutoff = blockMs + 86399999;   // end of the block's day - the convergence gate
              best = { items: dItems, id: 'dash' + cutoff, ts: rec.job.updatedAt, when: new Date(blockMs), dash: true };
            }
          }
        }
      } catch (e) { /* bus record optional - Umbrava-only behavior stands */ }
      // Phase 0 hysteresis: the store write stays HERE in the assembly layer - the pure
      // engine never touches localStorage. See planHysteresis for the decision table.
      try {
        var st = actsLoad();
        var hz = planHysteresis(best, st._plan || null, lastNotesSrc);
        if (hz.clear && st._plan) { delete st._plan; actsSave(st); }
        else if (hz.meta && JSON.stringify(st._plan || null) !== JSON.stringify(hz.meta)) { st._plan = hz.meta; actsSave(st); }
        return hz.plan;
      } catch (e) { return best; }
    }

    // ---- Role rank (read-only, for tiered escalation wording) ------------------
    // The suite gates escalation WORDING (never access) on the SERVER-computed rank
    // from [[umbrava-role-auth]] (bwn-suite-ai: 1 staff .. 5 director), published on
    // the `bwn:role` bus event + the `bwn:role:last` localStorage slot. Core is
    // @grant none, so it CANNOT fetch /api/user-role itself (that is a cross-origin
    // SWA call needing GM_*/@connect) - it only CONSUMES what the AI script already
    // resolved. A live bus event is trusted directly (it was fetched for THIS user,
    // this session); the localStorage slot is the cross-refresh fallback, trusted
    // only when marked ok + fresh. Unknown rank -> the generic pre-Phase-3
    // "Escalate to management" wording, so nothing regresses when the AI script is
    // absent or has not resolved yet. This is UX phrasing only; no access boundary.
    var _bwnEscRank = null;   // number when known this session, else null
    var BWN_ROLE_TTL_MS = 6 * 3600 * 1000;
    function bwnEscRank() {
      if (typeof _bwnEscRank === 'number') return _bwnEscRank;
      try {
        var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
        if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < BWN_ROLE_TTL_MS) return r.rank;
      } catch (e) { }
      return null;
    }
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _bwnEscRank = d.rank;
    });

    // Tiered, role-aware escalation target. Two independent inputs:
    //  - SEVERITY (sev >= 1 when past the escalate clock; higher = further past) and
    //    PRIORITY decide the TIER: level 2 (supervisor) for a fresh escalation,
    //    level 3 (management decision) once it is >=2x past the clock or a P1 emergency
    //    or GP underwater (caller forces sev high).
    //  - The reader's own RANK decides the RECIPIENT: a coordinator (rank <=2 or
    //    unknown) escalates UP to a supervisor then management; a supervisor (3-4) has
    //    no supervisor above, so both levels route to management; a director (>=5) owns
    //    the call - there is nobody to escalate to, so the row becomes "make the call".
    // The routine chase steps (stall/no-show/PO) ARE the pre-escalation "chase" tier;
    // this row only ever escalates OWNERSHIP beyond the coordinator.
    function bwnEscalationTier(sev, prioNum, rank) {
      var level = (sev >= 2 || prioNum === 1) ? 3 : 2;
      var owner, label, lead;
      if (rank !== null && rank >= 5) {
        owner = 'director'; label = 'Own the call - decide next steps'; lead = 'This one is yours to decide: ';
      } else if (rank !== null && rank >= 3) {
        owner = 'management'; label = 'Escalate to management'; lead = 'Escalating to management: ';
      } else if (level >= 3) {
        owner = 'management'; label = 'Escalate to management'; lead = 'Escalating to management: ';
      } else {
        owner = 'supervisor'; label = 'Escalate to your supervisor'; lead = 'Flagging to my supervisor: ';
      }
      return { tier: level, owner: owner, label: label, lead: lead, tierName: (owner === 'director' ? 'decision' : owner) };
    }

    // Impure wrapper: assembles the DOM/store inputs the PURE engine needs (when a caller
    // passes a bare state, not one from compute()), performs the ONE side effect - staging a
    // note-authored plan to the dashboard - then delegates. Kept thin so the checklist, the
    // WO Assist top-3, the bus nextSteps, and any My Day surface all run the SAME pure engine
    // and cannot drift (mirrors thresholdsFor -> computeVerdict).
    function nextActions(state) {
      if (state.hd === undefined) { try { state.hd = headerInfo(); } catch (e) { state.hd = {}; } }
      if (state.authoredPlan === undefined) { try { state.authoredPlan = readAuthoredPlan(); } catch (e) { state.authoredPlan = null; } }
      if (state.docs === undefined) { try { state.docs = readDocs(); } catch (e) { state.docs = null; } }
      if (state.escRank === undefined) { try { state.escRank = bwnEscRank(); } catch (e) { state.escRank = null; } }
      if (state.nudges === undefined) { try { state.nudges = nudgedPrefixes(); } catch (e) { state.nudges = {}; } }
      // Round-trip a NOTE-authored plan to the dashboard (side effect kept OUT of the pure
      // engine). Skip plan.dash - that plan already lives on the dashboard, so pushing it
      // back would echo. Zero-egress here: Core only queues to localStorage; the AI script
      // drains + POSTs it. Deduped by content, so unchanged plans do not re-enqueue.
      var plan = state.authoredPlan;
      if (plan && plan.items && plan.items.length && !plan.dash) {
        try { stagePlanPush((state.hd || {}).tracking, plan.items, 'note'); } catch (e) { }
      }
      // Push the live WO-page state (PO/trips/docs/tasks) to the dashboard's job-acts overlay
      // (#42), same zero-egress queue-then-drain pattern as the plan push above.
      try { stageActsPush(state); } catch (e) { }
      return computeNextActions(state, state.cfg || bwnConfig());
    }

    // PURE engine: (state, C) in -> ranked action list out. No DOM reads, no store writes,
    // no side effects - deterministic given `state` (its DOM/store inputs were assembled in
    // compute()/the wrapper above) and `C`. This is the single source of truth the spec
    // asked for so the on-page checklist, the top-3, and My Day cannot disagree.
    function computeNextActions(state, C) {
      var hd = state.hd || {};
      var ref = (hd.tracking ? 'Tracking #' + hd.tracking : hd.wo) + (hd.location ? ' \u2014 ' + hd.location : '');
      var acts = [];

      // Map the WO status to its canonical phase (full taxonomy). A terminal phase
      // (closed/canceled/declined/revoked/paid) has nothing to chase → no actions.
      var woPhase = WO_PHASE[(state.status || '').trim().toLowerCase()] || null;

      // ---- Unbilled: work complete but no billing movement (T8-B1, NO WRITE) ----
      // Work Complete is terminal for this tool (billing owns invoice -> paid), so it would
      // otherwise return no actions below. But a WO that sits Work Complete past unbilledStaleDays
      // with no movement is unbilled revenue the coordinator still owns. Surface ONE row to
      // advance it to invoicing plus the standing completion anchor, then RETURN - the full
      // playbook is NOT opened for a finished WO. Shown to all coordinators (no manager gate).
      // Read-only. The terminal early-return just below is unchanged and still catches every
      // other terminal status (closed / canceled / invoiced / paid).
      var isWorkComplete = /\bwork\s*complete\b/i.test(state.status || '');
      var unbilledStaleDays = (C && C.unbilledStaleDays != null) ? C.unbilledStaleDays : 3;
      if (isWorkComplete && state.hrs != null && state.hrs > unbilledStaleDays * 24) {
        var ubDays = Math.round(state.hrs / 24);
        acts.push({
          key: 'unbilled:' + ubDays,
          label: 'Advance to invoicing - work complete ' + ubDays + 'd with no billing movement',
          why: 'Status "' + (state.status || '') + '" for ' + ubDays + 'd (' + Math.round(state.hrs) + 'h) - a completed WO not moving to invoice is unbilled revenue; verify the completion package, then create/submit the client invoice',
          text: 'Re: ' + ref + '. This WO has been Work Complete for ' + ubDays + ' days with no billing movement. Please verify the completion documents are attached, then create/submit the client invoice so it does not sit unbilled.'
        });
        acts.push({
          key: 'anchor:unbilled',
          label: 'Not closed until the WO is invoiced and paid',
          why: 'Work is complete but the WO is not yet invoiced/paid - advance it to billing',
          text: null, anchor: true
        });
        return acts;
      }

      // Terminal phase, OR an unmapped/custom status that reads as terminal (regex
      // safety net so a future "Cancelled - Duplicate"-type status cannot leak chases).
      if (woPhase === 'terminal' || (!woPhase && /\b(closed|cancell?ed|declined|revoked|void)\b/i.test(state.status || ''))) return acts;

      // Per-client profile (T10): resolved from bwn:config. An unconfigured client returns
      // CLIENT_DEFAULTS_SEED, so the refField / closeout-doc-type / cadence consumers below
      // are inert (byte-identical output) until a client is actually configured.
      var profile = BWN.bwnClientProfile(state);

      // AUTHORED PLAN merges into the playbook (Phase 1 - the takeover early-return is
      // gone). When the coordinator (or the AI 'Recent Update') has posted a specific
      // "Next Actions Required" list, those items join the generated steps in ONE
      // worst-first list: live emergencies and hard gates (no-show, stall, escalate,
      // docs, intake) sort above the plan, routine chases below it (see scoreAct's
      // authored shelf). Each row keeps its source tag + date in `why` so plan age
      // stays visible. No dedup between authored and generated items - over-surface
      // is the safe direction (decided). Zero-egress - we only READ the note. The
      // completion anchor is appended ONCE by the shared tail below.
      var plan = state.authoredPlan;
      if (plan && plan.items.length) {
        // (The round-trip stage-to-dashboard side effect now lives in the nextActions
        // wrapper - the pure engine only READS the plan to build the checklist.)
        var pd = null;
        if (plan.dash) { pd = plan.when || null; }   // the winning block's own date stamp
        else { try { pd = BWN.parseNoteDateLoose(plan.ts); } catch (e) { } }
        var planWhen = pd ? (' (' + (pd.getMonth() + 1) + '/' + pd.getDate() + ')') : '';   // display only - never used in the key
        var planSrc = plan.dash ? 'From the dashboard case file' : 'From the Next Actions Required note';
        // Phase 0: content-hashed keys - stable across plan-source flaps (the old key
        // carried plan.id, so a dash->note flip re-keyed every item and orphaned checked
        // state). Repeated labels disambiguate per-hash (:2, :3...), never by global index;
        // the plan ref rides as a.planRef for convergence + the header label.
        var occ = {};
        plan.items.forEach(function (t, i) {
          var h = authoredKeyHash(t);
          occ[h] = (occ[h] || 0) + 1;
          acts.push({ key: 'authored:' + h + (occ[h] > 1 ? ':' + occ[h] : ''), planRef: String(plan.id || ''), label: t, why: planSrc + planWhen, text: null, authored: true, ord: i });
        });
      }

      // ---- Escalation / ownership ------------------------------------------------
      // Some situations are past what routine chasing can fix and are OUT of the
      // coordinator's hands - they belong to MANAGEMENT (a decision), not another chase.
      // Surface a distinct, high-priority "Escalate to management" step so it reads as an
      // escalation, not business-as-usual. (Billing-owned phases - work complete /
      // invoiced / paid - are already terminal, so the coordinator gets no actions there.)
      var waitOnClient = (woPhase === 'client' || woPhase === 'materials-client' || woPhase === 'proposal-sent' || woPhase === 'onhold');
      // Escalation is now PRIORITY-SCALED off the shared status-clock, not a flat 14d.
      //  - Vendor miss (stall): escalate after ESCALATE_DAYS scaled by priority - a P1
      //    emergency escalates in ~4d, a P3 at the old 14d, a P4 at ~21d (floor 2d).
      //  - Waiting on an outside party: escalate once the status is 2x past its own
      //    priority-scaled hours limit (follow-ups demonstrably have not moved it),
      //    instead of a flat 14 calendar days regardless of status class or priority.
      var escTh = bwnThresholdsFor(state.status, state.priority, C);
      var escPn = bwnPrioNum(state.priority);
      var escDays = Math.max(2, Math.round(ESCALATE_DAYS * bwnPrioMult(state.priority)));
      var overLimit = (state.hrs !== null && escTh.bad > 0 && state.hrs >= 2 * escTh.bad);
      var escReason = null, escSev = 0;   // escSev: how far past the escalate threshold (>=1 at fire) - drives the tier
      if (state.stall && state.stall.days > escDays) {
        escReason = state.stall.vendor + ' still unresolved ' + state.stall.days + 'd after the scheduled visit' + (escPn ? ' (P' + escPn + ' escalates at ' + escDays + 'd)' : '') + ' - chasing has not worked';
        escSev = state.stall.days / escDays;
      } else if (waitOnClient && overLimit) {
        escReason = 'Status "' + (state.status || '') + '" ' + Math.round(state.hrs) + 'h - ' + (state.hrs / escTh.bad).toFixed(1) + 'x its ' + Math.round(escTh.bad) + 'h limit' + (escPn ? ' for P' + escPn : '') + '; waiting on an outside party and follow-ups have not moved it';
        escSev = state.hrs / (2 * escTh.bad);   // fires at 2x the limit, so sev=1 at fire
      } else if (state.gpPct !== null && state.gpPct < 0 && state.nte) {
        escReason = 'GP is underwater (' + state.gpPct.toFixed(1) + '%) - a price concession / write-down is a management decision';
        escSev = 3;   // a money write-down is a management call regardless of clock -> top tier
      }
      if (escReason) {
        // Phase 3: tiered + role-aware. Tier scales with how far past the clock AND
        // priority; the recipient is relative to the reader's own rank (see
        // bwnEscalationTier). Key carries the tier so a heavier escalation re-opens a
        // step that was checked at a lighter tier (reopening early is the safe direction).
        var esc = bwnEscalationTier(escSev, escPn, state.escRank);
        acts.push({
          key: 'escalate:' + woPhase + ':' + esc.tier,
          label: esc.label,
          why: escReason + ' · ' + esc.tierName + ' tier',
          text: 'Re: ' + ref + '. ' + esc.lead + escReason + '. Routine follow-up has not resolved this - need a decision on next steps (extend / re-source / price / close).',
          owner: esc.owner,
          // Carried for the render layer only: armAssistDue emits bwn:assist:due with this
          // value so the assist drawer POSTs the engine's own severity (the server can bump
          // the tier on it). Not part of the key, the label, or any stored state.
          sev: escSev
        });
      }

      // ---- Intake actionability gate (Phase 2) -----------------------------------
      // A WO created without the fields it needs to be worked will stall downstream
      // (unassignable, mis-scheduled, wrong vendor). At the earliest phases, surface
      // exactly what is missing so it gets fixed before it is dispatched, not after.
      // Only fires pre-dispatch (intake / schedule / accept); a job already in flight
      // is not re-litigated. RELIABLE fields (NTE, priority, site) drive the trigger;
      // trade/scope are advisory (the label read can be absent even when set), so an
      // empty read only ADDS a "verify" item - it never blocks or false-completes.
      if (woPhase === 'intake' || woPhase === 'schedule' || woPhase === 'accept') {
        var miss = [], softMiss = [];
        if (!(state.nte && state.nte.amount > 0)) miss.push('NTE / client budget');
        if (!bwnPrioNum(state.priority)) miss.push('priority (P1-P4)');
        if (!(hd.location || hd.addr)) miss.push('site / location');
        // Per-client required source refs (T10): a client that files WOs against its own job/PO
        // numbers needs them at intake for downstream matching. Blocking (joins miss[]); off by
        // default (refFields all false) so an unconfigured client is unaffected.
        if (profile.refFields.sourceJob && !String(hd.sourceJob || '').trim()) miss.push('source job #');
        if (profile.refFields.sourcePo && !String(hd.sourcePo || '').trim()) miss.push('source PO #');
        if (!String(hd.trade || '').trim()) softMiss.push('trade');
        if (!String(hd.scope || '').trim()) softMiss.push('scope of work');
        var allMiss = miss.concat(softMiss);
        if (allMiss.length) {
          acts.push({
            key: 'intake:' + allMiss.join(','),   // reopens if a different field goes missing; self-clears when all are set
            label: 'Complete the WO intake - missing: ' + allMiss.join(', '),
            why: (miss.length ? 'Required field(s) not set (' + miss.join(', ') + ') - the WO cannot be dispatched cleanly. ' : '') +
              (softMiss.length ? 'Verify: ' + softMiss.join(', ') + '. ' : '') + 'Fix at intake so it does not stall downstream.',
            text: 'Re: ' + ref + '. Before this WO is dispatched, please confirm the missing details: ' + allMiss.join(', ') + '. Complete these so the job can be scoped, priced, and assigned to the right vendor.'
          });
        }
      }

      if (state.stall) {
        acts.push({
          key: 'stall:' + state.stall.vendor + ':' + state.stall.date,
          label: 'Confirm visit outcome with ' + state.stall.vendor,
          why: 'Scheduled ' + state.stall.date + ', ' + state.stall.days + 'd ago, PO not complete',
          text: 'Hi \u2014 following up on ' + ref + '. Your tech was scheduled for ' + state.stall.date +
            ' (' + state.stall.days + ' days ago) and we have no completion docs or update on file. ' +
            'Please confirm today: was the visit completed? If yes, upload sign-in/out, photos, and the signed ticket. ' +
            'If not, give me the new date and the reason for the miss so I can update the client.'
        });
      }

      // Vendors that already have a PO-specific action (used to de-dup the no-show).
      var poThemes = {}, poVendors = {};
      state.pos.forEach(function (p) { if (p.amount > 0 && p.poStatus) poVendors[nvVendor(p.vendor)] = 1; });

      // Trip no-show (from the trips cache - populated when the Trips tab was viewed):
      // a scheduled trip whose date passed with no completion. Catches what the per-PO
      // stall check misses (e.g. a PO marked Confirm Complete but a later trip was
      // booked and never completed). Skipped if the same vendor already has a stall or
      // a PO-specific action (avoids two rows for the same vendor's visit).
      if (state.noShow && !(state.stall && nvVendor(state.stall.vendor) === nvVendor(state.noShow.vendor)) && !poVendors[nvVendor(state.noShow.vendor)]) {
        var ns = state.noShow, nd = new Date(ns.ms), nw = (nd.getMonth() + 1) + '/' + nd.getDate();
        var nDays = Math.max(1, Math.round((Date.now() - ns.ms) / 86400000));
        acts.push({
          key: 'noshow:' + ns.trip + ':' + ns.ms,
          label: 'Confirm the ' + nw + ' visit outcome with ' + ns.vendor,
          why: 'Trip ' + ns.trip + ' scheduled ' + nw + ' (' + nDays + 'd ago) - no completion on file',
          text: 'Hi - re: ' + ref + '. Trip ' + ns.trip + ' was scheduled for ' + nw + ' (' + nDays + ' days ago) and I have no completion or update on file. Please confirm today: was the visit completed? If yes, upload sign-in/out, photos, and the signed ticket. If not, give me the new date and the reason for the miss.',
          resolve: ACT_SIGNALS.stall
        });
      }

      // Open tasks assigned on the WO are explicit human to-dos - surface them directly
      // (read from the details page; overdue flagged). A closed task drops the count →
      // the action self-clears on the next refresh.
      if (state.openTasks && state.openTasks.count > 0) {
        var ot = state.openTasks, f = ot.first || {}, od = false;
        if (f.date) { var td = new Date(String(f.date).replace(/,(\s+\d{1,2}:\d{2})/, ' $1')); if (!isNaN(td.getTime()) && +td < Date.now()) od = true; }
        var tShort = (f.text || '').replace(/\s+/g, ' ').trim();
        acts.push({
          key: 'task:' + ot.count + ':' + (f.date || '') + ':' + tShort.slice(0, 24),
          label: (ot.count > 1 ? 'Action ' + ot.count + ' open tasks' : 'Open task' + (od ? ' (OVERDUE)' : '')) + (tShort ? ' - ' + tShort.slice(0, 90) + (tShort.length > 90 ? '…' : '') : ''),
          why: (f.assignee ? 'Assigned ' + f.assignee : 'Open task on the WO') + (f.date ? ' · due ' + f.date : '') + (od ? ' · OVERDUE' : ''),
          text: null
        });
      }

      // Per-PO status actions - each PO row exposes its OWN status (recon 339766):
      // Material Ordered → chase delivery; Confirm Complete → collect docs + confirm;
      // Pending Acceptance → vendor has not accepted. More specific than the generic
      // "Get ETA" below, which now excludes any PO that has one of these.
      state.pos.forEach(function (p) {
        if (!(p.amount > 0)) return;
        if (p.poStatus === 'materials' && !p.done) {
          poThemes.materials = 1;
          acts.push({ key: 'pomat:' + p.sid + ':' + p.vendor, poNum: p.num, label: 'Chase ' + p.vendor + ' for material delivery ETA + tracking', why: 'PO ' + p.num + (p.statusText ? ' - ' + p.statusText : ' - materials ordered'), text: 'Hi - re: ' + ref + '. On PO ' + p.num + ': please confirm the materials - supplier, expected delivery date, and tracking #. Once they land, reply with the return-visit date so I can update the client.', resolve: ACT_SIGNALS.parts });
        } else if (p.poStatus === 'accept') {
          poThemes.accept = 1;
          acts.push({ key: 'poacc:' + p.sid + ':' + p.vendor, poNum: p.num, label: p.vendor + ' has not accepted PO ' + p.num, why: 'PO ' + p.num + ' pending vendor acceptance', text: 'Hi - re: ' + ref + '. PO ' + p.num + ' is still pending your acceptance. Please accept with a scheduled date, or decline today so I can reassign coverage.', resolve: ACT_SIGNALS.quote });
        } else if (p.poStatus === 'confirm') {
          poThemes.confirm = 1;
          acts.push({ key: 'poconf:' + p.sid + ':' + p.vendor, poNum: p.num, label: 'Confirm ' + p.vendor + ' completion + collect docs', why: 'PO ' + p.num + ' marked Confirm Complete', text: 'Hi - re: ' + ref + '. PO ' + p.num + ' is marked complete - please upload the completion package (signed ticket, sign-in/out, before/after photos) so we can confirm and invoice.', resolve: ACT_SIGNALS.stall });
        }
      });

      // ---- ECD imminent + vendor unconfirmed + no completion (T8-A1, NO WRITE) ----
      // A composite live-risk rule: the expected completion date is within 24h, active PO work
      // exists, but no vendor visit is CONFIRMED (a structured schedDate on a non-'accept' PO)
      // and nothing marks the job complete - so the ECD will blow unless the vendor is chased
      // NOW. Read-only. Deliberately has NO ACT_SIGNALS entry: a note must not fake-clear it -
      // it self-clears structurally when the ECD moves out of the window, a visit is confirmed,
      // or the WO advances. Scores just under a stall (see scoreAct's ecdrisk base).
      var ecdRiskMs = (state.due && state.due.raw) ? parseUSDate(state.due.raw) : null;
      if (ecdRiskMs !== null) {
        var hrsToEcd = (ecdRiskMs - Date.now()) / 3.6e6;
        var ecdImminent = hrsToEcd > 0 && hrsToEcd <= 24;
        var activeWork = state.pos.some(function (p) { return !p.done && p.amount > 0; });
        var vendorConfirmed = state.pos.some(function (p) { return !p.done && p.amount > 0 && p.schedDate && p.poStatus !== 'accept'; });
        var noCompletion = activeWork && woPhase !== 'confirmcomplete' && woPhase !== 'costreview' && !state.pos.some(function (p) { return p.poStatus === 'confirm'; });
        if (ecdImminent && activeWork && !vendorConfirmed && noCompletion) {
          acts.push({
            key: 'ecdrisk:' + (state.due.raw || ''),
            label: 'Chase vendor NOW - completion date within 24h and no visit confirmed',
            why: 'Complete-by ' + state.due.raw + ' is ' + Math.round(hrsToEcd) + 'h away with active PO work but no confirmed visit - the ECD will blow without a scheduled tech on site',
            text: 'Hi - URGENT re: ' + ref + '. The expected completion date (' + state.due.raw + ') is under 24 hours away and I have no confirmed visit on file. Please confirm today whether a tech is scheduled and on track to complete by then; if not, I need the real date immediately so I can update the client.'
          });
        }
      }

      // Clocked Out: Complete = the tech has finished on-site. Before this WO can be
      // marked Work Complete, the coordinator confirms the FINAL cost on each PO line
      // that was USED and isn't yet finalized (user request). One row per cost-open PO;
      // Cancelled and already Paid/Invoiced POs are skipped (not "used and open").
      if (woPhase === 'costreview') {
        state.pos.forEach(function (p) {
          if (!p.costOpen) return;
          acts.push({
            key: 'pocost:' + p.sid + ':' + p.vendor,
            poNum: p.num,
            label: 'Confirm the final cost on PO ' + p.num + ' (' + p.vendor + ') is correct',
            why: 'PO ' + p.num + (p.statusText ? ' - ' + p.statusText : '') + ' · ' + fmt(p.amount) + ' - verify the billed total before marking Work Complete',
            text: 'Hi - re: ' + ref + '. Before we close out PO ' + p.num + ', please confirm your final cost is ' + fmt(p.amount) + ' (or send the corrected final total) so billing matches the work performed.'
          });
        });
      }

      // ---- Closure gate: completion package present? (Phase 2) -------------------
      // A WO must not be marked Work Complete without its completion package (signed
      // ticket, sign-in/out, before/after photos). At confirm-complete / cost-review,
      // if we can read the Documents section and it is CONFIDENTLY empty, surface a
      // blocking step. readDocs() returns null when it cannot tell (off-WO, the
      // jobDocuments read still pending, or it failed - see readDocs) and we do NOT
      // fire on null: a false zero would nag, and we never auto-complete on a "docs
      // present" read. A "docs uploaded" note converges it via ACT_SIGNALS.stall
      // (the same signal the confirm steps use).
      if (woPhase === 'confirmcomplete' || woPhase === 'costreview') {
        var docs = state.docs;
        // Doc-TYPE advisory (T10): when the client profile lists required closeout doc types
        // and docs ARE on file, flag any required type not matched (case-insensitive substring)
        // against a document's label/displayFileName. ADVISORY only - it never blocks the advance
        // gate; ships soft (per approval) until validated on real docs, because matching by OCR'd
        // labels is unproven. The confident-empty docs:none block below is UNCHANGED and stays the
        // blocking signal; the `docs === null` unknown guard is preserved by the `docs &&` tests.
        var coDocs = (profile.closeout && profile.closeout.docs) || [];
        if (docs && docs.count > 0 && coDocs.length && profile.closeout.enforce) {
          var coLabels = (docs.docs || []).map(function (d) { return ((d.label || '') + ' ' + (d.displayFileName || '')).toLowerCase(); });
          var coMiss = coDocs.filter(function (t) { var tl = String(t).toLowerCase(); return !coLabels.some(function (L) { return L.indexOf(tl) !== -1; }); });
          if (coMiss.length) {
            acts.push({
              key: 'docsverify:' + coMiss.join(','),
              label: 'Verify closeout docs (' + coMiss.join(', ') + ')',
              why: 'Documents are on file but these required closeout types were not matched: ' + coMiss.join(', ') + '. Advisory only - confirm they are attached before closing (does not block advancing).',
              text: 'Hi - re: ' + ref + '. Before we close out, please confirm these closeout documents are attached: ' + coMiss.join(', ') + '.'
            });
          }
        }
        if (docs && docs.count === 0) {
          acts.push({
            key: 'docs:none',
            label: 'Collect the completion package before closing - no documents on file',
            why: 'The Documents section is empty - the WO cannot be verified complete or invoiced without the signed ticket, sign-in/out, and before/after photos',
            text: 'Hi - re: ' + ref + '. This WO shows the work done but no completion documents are attached. Please upload the completion package (signed work ticket, sign-in/out times, before/after photos) so we can confirm complete and invoice.',
            resolve: ACT_SIGNALS.stall
          });
        }
      }

      // ---- Closure auto-advance: docs collected, so move it out of confirm-complete ---
      // The mirror image of the docs:none gate. At confirm-complete, when the completion
      // package IS confidently on file (jobDocuments returned a non-empty list) and no PO
      // is still pending confirmation, the WO is ready to be marked Work Complete. Surfacing
      // this stops jobs ROTTING in confirm-complete after everything needed to close them is
      // already attached (the lifecycle-gap-map "advance to Work Complete" gate). It is a
      // SUGGESTION, never an auto-check and never an auto-advance: a "docs present" read must
      // never move the WO on its own (the docs:none rule, inverted). Self-clears structurally
      // - once advanced, the phase is no longer confirm-complete so the step stops generating.
      if (woPhase === 'confirmcomplete' && state.docs && state.docs.count > 0 && !poThemes.confirm) {
        acts.push({
          key: 'advance:workcomplete',
          label: 'Advance to Work Complete - the completion package is on file',
          why: 'Documents attached (' + state.docs.count + ' on file) and no PO left to confirm' + (state.hrs !== null ? ' - ' + Math.round(state.hrs) + 'h in confirm-complete' : '') + ' - mark the WO Work Complete so it can be invoiced instead of sitting here',
          text: null
        });
      }

      var noSched = state.pos.filter(function (p) { return !p.done && p.amount > 0 && !p.schedDate && !p.poStatus; });
      if (noSched.length) {
        acts.push({
          key: 'eta:' + noSched.map(function (p) { return p.vendor; }).sort().join('|'),
          label: 'Get ETA from ' + noSched.map(function (p) { return p.vendor; }).join(', '),
          why: 'Open PO with no scheduled date',
          text: 'Hi \u2014 re: ' + ref + '. I show your PO approved but no scheduled date on file. ' +
            'Please reply today with: ETA / scheduled date, on-site tech & cell #, and any parts or access lead times affecting the date.'
        });
      }

      // WO-level action driven by the status PHASE (covers all ~50 statuses). Skipped
      // when a per-PO action already covers the same theme (avoids a duplicate materials/
      // confirm/accept ask), or when a stall makes the "scheduled" copy contradictory.
      var wa = woActionForStatus(state, ref, woPhase);
      var waTheme = { materials: 'materials', 'materials-client': 'materials', confirmcomplete: 'confirm', accept: 'accept' }[woPhase];
      if (wa && !((waTheme && poThemes[waTheme]) || (woPhase === 'scheduled' && (state.stall || state.noShow)) || (woPhase === 'confirmcomplete' && state.docs && state.docs.count > 0))) acts.push(wa);

      if (woPhase !== 'costreview' && state.due && state.due.kind === 'bad') {   // at Clocked Out: Complete the work is done - confirm costs + complete, don't reset the ECD
        acts.push({
          key: 'ecd:' + ((state.due && state.due.raw) || ''),
          label: 'Reset expected completion + update client',
          why: 'Complete-by date is past',
          text: 'Re: ' + ref + ' \u2014 the expected completion date has passed. After confirming the real schedule with the vendor, ' +
            'update the WO expected-completion date and post a client-facing status note covering: current stage, cause of delay, and the new date.'
        });
      }

      // GP below floor = the client's DNE is too low for the vendor cost. When a proposal
      // is PENDING (being prepared, or submitted and awaiting client approval), that
      // proposal IS the ask to the client for the higher price \u2014 so "Request DNE increase"
      // and "Chase proposal approval" are the SAME action on this WO. Don't show both:
      // fold the GP context into the proposal chase and skip the standalone DNE row.
      // Standalone DNE only stands when no pending proposal already covers the ask.
      var gpBad = woPhase !== 'costreview' && state.gpPct !== null && state.gpPct < state.cfg.gpBad && state.nte;
      var proposalPending = (woPhase === 'proposal' || woPhase === 'proposal-sent');
      if (gpBad && proposalPending && wa && acts.indexOf(wa) !== -1) {
        wa.why += ' \u00b7 GP ' + state.gpPct.toFixed(1) + '% \u2014 the approval must cover the cost (use the calculator above)';
      } else if (gpBad) {
        acts.push({
          key: 'dne:' + state.vendorTotal.toFixed(2),   // reopens when a new PO changes the cost base
          label: 'Request DNE increase (GP ' + state.gpPct.toFixed(1) + '%)',
          why: 'Below ' + state.cfg.gpBad + '% floor \u2014 use the calculator above for the exact ask',
          text: null
        });
      }

      if (state.staleDays !== null && state.staleDays > state.cfg.noteStaleDays) {
        acts.push({
          // Keyed to the newest-note date so each staleness EPISODE is its own item -
          // a record checked last month can't resurface pre-checked when notes go
          // stale again. (Day-boundary jitter can only reopen early - safe direction.)
          key: 'note:' + new Date(Date.now() - state.staleDays * 86400000).toISOString().slice(0, 10),
          label: 'Post a status note (:jn)',
          why: 'Newest note is ' + state.staleDays + 'd old \u2014 the WO reads as unworked',
          text: null
        });
      }

      // Client-facing cadence (Phase 3): distinct from vendor chasing and from the
      // generic note-staleness step above (which resets on ANY note, incl. internal /
      // vendor). On an ACTIVE job (live vendor work in flight) the client is owed a
      // proactive status update on a cadence, priority-scaled off the shared clock:
      // P1 ~2d, P3 7d, P4 ~11d. Skipped when we are already WAITING ON the client for
      // direction (that phase has its own client-contact step). Self-converges: a
      // client-typed note resets state.lastClientNoteDays, dropping this on next
      // refresh - a structured field signal, not note-wording matching. Fires only
      // when notes are actually loaded (noteCount > 0) so an unscanned WO is not nagged.
      if (!waitOnClient && state.noteCount > 0 && state.pos.some(function (p) { return p.amount > 0 && !p.done; })) {
        // Base cadence: the client profile's override when set, else the default 7d (T10).
        var cadBase = profile.cadenceDays != null ? profile.cadenceDays : 7;
        var cad = Math.max(2, Math.round(cadBase * bwnPrioMult(state.priority)));
        var ccd = state.lastClientNoteDays;
        if (ccd === null || ccd > cad) {
          acts.push({
            key: 'clientcad:' + (ccd === null ? 'none' : new Date(Date.now() - ccd * 86400000).toISOString().slice(0, 10)),
            label: 'Send the client a proactive status update',
            why: (ccd === null ? 'No client-facing note on file' : 'Last client update ' + ccd + 'd ago') + ' - cadence for an active job is ' + cad + 'd' + (escPn ? ' (P' + escPn + ')' : ''),
            text: 'Re: ' + ref + '. Proactive status update: current stage, what is happening next, and the expected completion date. (No action needed on your end - keeping you posted.)'
          });
        }
      }

      // No ECD at all + active work = an audit gap → a settable step. (The overdue
      // case is the existing 'Reset expected completion' push above.)
      if (woPhase !== 'costreview' && !state.due && state.pos.some(function (p) { return !p.done && p.amount > 0; })) {
        acts.push({
          key: 'ecd:none',
          label: 'Set expected completion date',
          why: 'No expected-completion date on the WO - set a target',
          text: 'Re: ' + ref + '. No expected completion date is on file. Confirm the schedule with the vendor, set the WO target date, and post a client status note with the date.'
        });
      }

      // Completion anchor - once a WO has ANY tracked step, the checklist must never
      // read "all done" until the STATUS itself is a completion state (Work Complete /
      // Invoiced / Paid; those are terminal and returned [] above, so the card simply
      // disappears). This uncheckable gate row keeps the list open otherwise -
      // coordinators advance the job, they do not tick a box to fake completion. Added
      // only when there is already ≥1 real step, so a genuinely clean WO still shows no
      // card. Non-convergeable (see autoDetectActioned) - a note can't fake-complete it.
      if (acts.length) {
        acts.push({
          key: 'anchor:' + (woPhase || 'active'),
          label: 'Not complete until the WO status is Work Complete, Invoiced, or Paid',
          why: 'Current status "' + (state.status || '') + '" is not a completion state - advance the WO when the work is truly done',
          text: null, anchor: true
        });
      }

      // Attach each step's note-convergence signal by key-prefix (stall/eta/quote/
      // parts/client/ecd/dne). 'note:' has none - it self-converges (any posted note
      // resets staleDays, dropping it from state on the next refresh). ecd-prefixed
      // steps also get the interactive "Set ECD…" button (openEcd).
      acts.forEach(function (a) { var p = a.key.split(':')[0]; if (!a.resolve && ACT_SIGNALS[p]) a.resolve = ACT_SIGNALS[p]; if (p === 'ecd') a.openEcd = true; });
      // Adaptive nudge (Increment B): a step TYPE dismissed on ≥3 distinct recent jobs
      // gets flagged HARDER - marker, why suffix, urgency boost. Pressure only; nothing
      // is ever hidden or demoted by habit.
      try {
        var nd = state.nudges || {};
        acts.forEach(function (a) {
          var sp = statPrefix(a);
          if (sp && nd[sp]) { a.nudge = nd[sp]; a.why += ' · ⚠ dismissed on ' + nd[sp] + ' recent jobs - needs real action, not another dismissal'; }
        });
      } catch (e) { /* nudges are best-effort */ }
      acts.sort(function (x, y) { return scoreAct(y, state) - scoreAct(x, state); });   // worst-first (stable); objective + nudge pressure, never habit-softened
      return acts;   // callers cap the display; the checklist wants the full list
    }
    // Publish the pure engine to file level so List Heat's audit can rank a board row's
    // next step with the SAME playbook the WO page uses (see bwnActsEngine's comment).
    // The PURE fn only - never the `nextActions` wrapper, which has DOM reads and a
    // localStorage side effect (stagePlanPush) that must not fire 200 times per scan.
    bwnActsEngine = computeNextActions;

    // ---- Action Checklist (inline card above Purchase Orders) -----------------
    // The playbook as a WORKING surface: a card embedded in the WO page directly
    // above the Purchase Orders section. Each row: a checkbox, the chase text
    // (copy), and "Actioned…" - which prefills Umbrava's Add Note composer with
    // what you did. The POSTED NOTE is the real record (Umbrava attributes it to
    // you); checklist state is a per-browser convenience in localStorage. The
    // card SELF-UPDATES on the module's refresh cycle: steps disappear when the
    // WO state resolves them (PO scheduled, note posted…), keys encode
    // composition so a checked item reopens when the situation changes, and a
    // note containing an action's exact label auto-checks it (that's exactly
    // what our inserted notes look like). Rebuilds are signature-gated so an
    // unchanged card is never re-rendered under the user's cursor. Zero-egress
    // preserved: the note save stays manual, in Umbrava's own composer.
    var ACT_CARD_ID = 'bwn-act-card';
    function actsKey() { var id = currentWOId(); return 'bwn:acts:' + (id || location.pathname); }
    // Phase 0 one-time key migration: authored:<ref>:<i>:<hash> -> authored:<hash>[:<occ>].
    // Old keys carried the plan ref, so every plan-source flap re-keyed the whole list and
    // orphaned checked state (the check-off-revert repro). Occurrence numbering is per-hash
    // among the SAVED entries in (hash, index) order; an existing new-shape record is a
    // decision and is never overwritten (same rule as autoDetectActioned). Pure: returns
    // null when nothing to migrate, else the rewritten store object.
    function actsMigrate(d) {
      var olds = [], k, m;
      for (k in d) { m = /^authored:([^:]+):(\d+):([a-z0-9]+)$/.exec(k); if (m) olds.push({ k: k, i: parseInt(m[2], 10), h: m[3] }); }
      if (!olds.length) return null;
      olds.sort(function (x, y) { return x.h < y.h ? -1 : x.h > y.h ? 1 : x.i - y.i; });
      var occ = {};
      olds.forEach(function (o) {
        occ[o.h] = (occ[o.h] || 0) + 1;
        var nk = 'authored:' + o.h + (occ[o.h] > 1 ? ':' + occ[o.h] : '');
        if (!d[nk]) d[nk] = d[o.k];
        delete d[o.k];
      });
      return d;
    }
    function actsLoad() {
      try {
        var d = JSON.parse(localStorage.getItem(actsKey()) || '{}');
        d = (d && typeof d === 'object') ? d : {};
        var mig = actsMigrate(d);
        if (mig) { d = mig; actsSave(d); }
        return d;
      } catch (e) { return {}; }
    }
    function actsSave(d) { try { localStorage.setItem(actsKey(), JSON.stringify(d)); } catch (e) { /* best-effort */ } }
    // ONE-TIME per-WO store migration for the PO act re-key (render index -> stable sid,
    // 2026-08-02). Old keys look like 'pomat:2:ACME' - a BARE-DIGITS middle, which the new
    // form never produces (the poKeyOf ladder yields 'ln001' / 'v<guid>' / 'ix2', plus a
    // '-<num>' collision suffix). An old record maps to a new key only when exactly ONE
    // current PO carries that vendor; an ambiguous or vanished vendor leaves the record in
    // place, inert - a step re-appearing unchecked is the safe direction, false-checking
    // via a guessed mapping is not. Mirrors actsMigrate above (mutates d; returns d when
    // changed, null when not). Cannot live in actsLoad like the authored-key migration -
    // it needs state.pos - so renderActsInline runs it once per WO page-load.
    function actsMigratePO(d, pos) {
      var changed = false, k, m;
      var byVendor = {};
      (pos || []).forEach(function (p) {
        if (!p || !p.sid) return;
        var v = String(p.vendor || '');
        byVendor[v] = Object.prototype.hasOwnProperty.call(byVendor, v) ? null : p;   // null = ambiguous
      });
      for (k in d) {
        m = /^(pomat|poacc|poconf|pocost):(\d+):(.+)$/.exec(k);
        if (!m) continue;
        var p2 = byVendor[m[3]];
        if (!p2) continue;                          // vendor gone or ambiguous - leave the record inert
        var nk = m[1] + ':' + p2.sid + ':' + m[3];
        if (!d[nk]) d[nk] = d[k];
        delete d[k];
        changed = true;
      }
      return changed ? d : null;
    }
    var actsMigratedPOFor = '';   // latch: once per WO page-load (the store is per-WO)

    function findAddNoteBtn() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (/add note/i.test((btns[i].textContent || '').trim())) return btns[i];
      }
      return null;
    }
    // Best-effort: set the Add Note composer's note-type control to `label` (e.g. "Internal").
    // Scoped to the just-opened composer. No-ops safely (the note still posts) when the control
    // isn't found. Umbrava's CURRENT note-type control is a custom autocomplete (an
    // aria-autocomplete="list" input labelled "Type"); pre-typing does NOT select it - you must
    // CLICK the option - so branch 0 handles that. The legacy branches (native <select>, a visible
    // tab/chip, a MUI Select whose listbox portals to <body>) are kept as fallbacks for other UIs
    // and are gated on a note-type vocabulary so they never touch an unrelated dropdown.
    var NOTE_TYPE_VOCAB = /^(internal|vendor|client|billing|general|public|private|customer|recap)$/i;
    function setNoteType(label, scope) {
      if (!label) return false;
      scope = scope || document;
      var esc = String(label).replace(/[.*+?^${}()|[\]\\]/g, function (m) { return '\\' + m; });
      var want = new RegExp('^\\s*' + esc + '\\s*$', 'i');
      // 0) the current Umbrava UI: a custom autocomplete (aria-autocomplete="list") labelled
      //    "Type". Find it by its label inside the composer, open + filter, then CLICK the option
      //    (typing alone never registers the pick). Async - options render a tick after opening.
      var flabs = scope.querySelectorAll('label'), acInput = null;
      for (var a = 0; a < flabs.length; a++) {
        if (!/^\s*type\b/i.test((flabs[a].textContent || '').trim())) continue;
        var afc = flabs[a].closest('.MuiFormControl-root') || flabs[a].parentElement;
        var ai = afc ? afc.querySelector('input[aria-autocomplete="list"]') : null;
        if (ai) { acInput = ai; break; }
      }
      if (acInput) {
        try {
          acInput.focus();
          acInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          var vset = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          vset.call(acInput, label); acInput.dispatchEvent(new Event('input', { bubbles: true })); acInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          var contain = new RegExp(esc, 'i'), nn = 0;
          (function pickAC() {
            var os = document.querySelectorAll('[role="option"]'), exact = null, part = null;
            for (var q = 0; q < os.length; q++) {
              var tx = (os[q].textContent || '').replace(/\s+/g, ' ').trim();
              if (want.test(tx)) { exact = os[q]; break; }
              if (!part && contain.test(tx)) part = os[q];
            }
            var opt = exact || part;
            if (opt) { ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); return; }
            if (++nn < 12) setTimeout(pickAC, 70);
          })();
        } catch (e) { }
        return true;
      }
      // 1) native <select> whose options read like note types
      var sels = scope.querySelectorAll('select');
      for (var i = 0; i < sels.length; i++) {
        var opts = Array.prototype.slice.call(sels[i].options);
        if (!opts.some(function (o) { return NOTE_TYPE_VOCAB.test((o.textContent || '').trim()); })) continue;
        var m1 = opts.filter(function (o) { return want.test((o.textContent || '').trim()); })[0];
        if (m1) { try { BWN.setNativeValue(sels[i], m1.value); } catch (e) { } return true; }
      }
      // 2) a visible type tab / chip / radio already in the composer
      var direct = scope.querySelectorAll('[role="tab"],[role="radio"],[role="option"],button,.MuiChip-root,label');
      for (var j = 0; j < direct.length; j++) {
        if (want.test((direct[j].textContent || '').trim()) && direct[j].offsetParent) { try { direct[j].click(); } catch (e) { } return true; }
      }
      // 3) a MUI Select trigger currently showing a note-type value - open it, then click the
      //    matching option (the listbox is portaled to <body>, so search the whole document).
      var trig = scope.querySelectorAll('[role="button"][aria-haspopup="listbox"],[role="combobox"]');
      for (var k = 0; k < trig.length; k++) {
        if (!NOTE_TYPE_VOCAB.test((trig[k].textContent || '').trim())) continue;
        (function (t) {
          try { t.click(); } catch (e) { return; }
          var n = 0;
          (function pick() {
            var os = document.querySelectorAll('[role="option"],[role="listbox"] li,.MuiMenuItem-root');
            for (var q = 0; q < os.length; q++) { if (want.test((os[q].textContent || '').trim())) { try { os[q].click(); } catch (e) { } return; } }
            if (++n < 8) setTimeout(pick, 60); else { try { t.click(); } catch (e) { } }   // give up: close the menu
          })();
        })(trig[k]);
        return true;
      }
      return false;
    }

    // Open the Add Note composer prefilled with the actioned text. The SAVE stays
    // manual - the coordinator reviews and posts as themselves, so Umbrava's own
    // attribution is the audit record. Fallback: clipboard + tell the user. When
    // `noteType` is passed (the ECD flow passes "Internal"), the composer's note-type
    // control is set to it once the composer opens.
    // Insert multi-line text into Umbrava's rich Add Note editor (TipTap / ProseMirror) so line
    // breaks + blank lines become real paragraphs - a plain textContent set collapses them into
    // one jumbled run. A synthetic paste (text/html) drives the editor's own paste handler,
    // exactly like a manual Ctrl+V. Verified live on the composer. Falls back to execCommand /
    // textContent only if the ClipboardEvent APIs are unavailable (the caller also copies to the
    // clipboard, so a manual Ctrl+V is always the final recovery).
    function pasteRichEditor(ed, text) {
      function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      var html = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
      try { ed.focus(); var sel = window.getSelection(); var rg = document.createRange(); rg.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(rg); } catch (e) { }
      try {
        var dt = new DataTransfer(); dt.setData('text/html', html); dt.setData('text/plain', String(text));
        ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch (e2) {
        try { document.execCommand('insertHTML', false, html); } catch (e3) { try { ed.textContent = String(text); ed.dispatchEvent(new Event('input', { bubbles: true })); } catch (e4) { } }
      }
    }
    function insertWONote(text, cb, noteType) {
      var btn = findAddNoteBtn();
      if (!btn) { noteFallback(text); if (cb) cb(false); return; }
      var beforeEls = Array.prototype.slice.call(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]'));
      btn.click();
      var tries = 0;
      (function poll() {
        var all = Array.prototype.slice.call(document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]'));
        var fresh = null;
        for (var i = 0; i < all.length; i++) { if (beforeEls.indexOf(all[i]) === -1) { fresh = all[i]; break; } }
        if (fresh) {
          if (fresh.tagName === 'TEXTAREA') BWN.setNativeValue(fresh, text);
          else pasteRichEditor(fresh, text);
          try { fresh.focus(); fresh.scrollIntoView({ block: 'center' }); } catch (e) { }
          if (noteType) { try { var comp = (fresh.closest && fresh.closest('[role="dialog"],.MuiDialog-root,form,.MuiPaper-root')) || document; setTimeout(function () { setNoteType(noteType, comp); }, 60); } catch (e) { } }
          if (cb) cb(true); return;
        }
        if (++tries > 12) { noteFallback(text); if (cb) cb(false); return; }
        setTimeout(poll, 250);
      })();
    }
    function noteFallback(text) {
      // Non-blocking: a native alert()/prompt() here freezes the whole page (and hangs
      // the flow when the clipboard write rejects, e.g. the tab isn't focused). Copy
      // best-effort and surface a dismissible toast instead.
      try { navigator.clipboard.writeText(text).catch(function () { }); } catch (e) { }
      ecdToast('Add Note composer not found - the note text was copied to your clipboard. Open a new note and paste it.', null);
    }

    // The FULL-WIDTH block to insert the card before, derived STRUCTURALLY (never
    // by fixed parent-depth - that guess once landed the card inside the header
    // flex row, squeezed next to the "Purchase Orders" title). Method: take the
    // lowest common ancestor of the header's + button and a PO accordion row;
    // the LCA's direct child containing the header IS the full-width header
    // block, and by the LCA property it cannot also contain the PO rows.
    function lcaContaining(seed, other) {
      var n = seed;
      while (n && n !== document.body) { if (n.contains(other)) return n; n = n.parentElement; }
      return null;
    }
    function poAnchorBlock() {
      var seed = document.querySelector('[data-testid="purchase-order-add-button"]');
      if (!seed) {
        var els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span');
        for (var i = 0; i < els.length; i++) {
          if ((els[i].textContent || '').trim() === 'Purchase Orders' && els[i].children.length === 0) { seed = els[i]; break; }
        }
      }
      if (!seed) return null;
      var acc = document.querySelector('[data-testid^="POAccordion-"]');
      if (acc) {
        var lca = lcaContaining(seed, acc);
        if (lca) {
          var child = seed;
          while (child.parentElement && child.parentElement !== lca) child = child.parentElement;
          if (child.parentElement === lca) return child;
        }
      }
      // No PO rows yet: the header row itself = lowest ancestor of the + button
      // that also holds the "Total NTE" label (both live in that one flex row).
      var cands = document.querySelectorAll('div,span,p,h6');
      for (var j = 0; j < cands.length; j++) {
        if ((cands[j].textContent || '').replace(/\s+/g, ' ').trim() === 'Total NTE' && cands[j].querySelectorAll('*').length <= 2) {
          var row = lcaContaining(seed, cands[j]);
          if (row && row !== document.body) return row;
        }
      }
      return null;
    }

    // Where the NEXT ACTIONS card mounts: directly above Umbrava's own "Open Tasks"
    // section in the right-hand column, so the coordinator's to-dos and ours read as
    // one stack instead of sitting a column apart. Same heuristic style as the PO
    // anchor - find the heading, then climb to the outermost node that is still only
    // this section. Falls back to the old spot above Purchase Orders when the WO has
    // no tasks section mounted (it only appears once tasks exist).
    // Section text with OUR card discounted. The card is still mounted when the next
    // anchor is computed, so an undiscounted read returns "NEXT ACTIONS..." for the very
    // container we are trying to identify - the anchor then poisons itself and every
    // later render re-confirms the wrong spot.
    function sectionTxt(el, skip) {
      var t = el.textContent || '';
      if (skip && el.contains(skip)) t = t.replace(skip.textContent || '', '');
      return t.replace(/\s+/g, ' ').trim();
    }
    function tasksAnchorBlock() {
      var head = null;
      var els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p');
      for (var i = 0; i < els.length; i++) {
        var tx = (els[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (/^open tasks/i.test(tx) && els[i].querySelectorAll('*').length <= 2) { head = els[i]; break; }
      }
      if (!head) return null;
      // Prefix match, NOT /^open tasks\b/: the heading sits in a flex row with its count
      // badge, so that row reads "Open Tasks0" - and there is no word boundary between
      // "s" and "0". A \b test fails there, stops the climb at the heading, and the card
      // gets inserted INTO the heading row, rendering beside "Open Tasks" instead of
      // above the section (seen live on WO 364040).
      var own = document.getElementById(ACT_CARD_ID);
      var node = head, hops = 0;
      while (node.parentElement && node.parentElement !== document.body && hops++ < 8) {
        if (!/^open tasks/i.test(sectionTxt(node.parentElement, own))) break;   // parent holds more than this section
        node = node.parentElement;
      }
      return node.parentElement ? node : null;
    }
    function actsAnchorBlock() { return tasksAnchorBlock() || poAnchorBlock(); }

    // ---- PO vendor/supplier grouping (CSS-order, non-destructive) --------------
    // The PO list container is a flex COLUMN whose direct children each wrap one PO
    // accordion (recon 339766). We GROUP by setting CSS `order` on those children - never
    // moving React nodes - and inject two group headers + a per-PO Vendor/Supplier toggle
    // (all re-applied idempotently, write-on-change, so React re-renders can't fight it).
    // Classification is by the COMPANY the PO is TO (user: no type field): a seeded/learned
    // global supplier list, overridable per-PO per-WO (some vendors also fabricate/supply
    // on a given job). Only activates when the container is flex (where `order` works).
    var PO_SUP_KEY = 'bwn:po:suppliers';
    var PO_SEED_SUPPLIERS = ['LSI', 'SUNBELT', 'SIGNS.COM'];   // starter set the user named; grows via the toggle's "remember" - matched as a substring of the normalized vendor name
    function poSuppliers() {
      var d = BWN.lsGetJSON(PO_SUP_KEY, null);
      if (!Array.isArray(d)) { d = PO_SEED_SUPPLIERS.slice(); BWN.lsSetJSON(PO_SUP_KEY, d); }
      return d;
    }
    function poOvKey() { return 'bwn:po:ov:' + (currentWOId() || location.pathname); }
    function poOverrides() { return BWN.lsGetJSON(poOvKey(), {}) || {}; }
    function poSetOverride(num, cls) { var o = poOverrides(); o[num] = cls; BWN.lsSetJSON(poOvKey(), o); }
    // A STABLE per-PO identity for the override key. The POAccordion-<n> testid is a RENDER INDEX
    // that re-sequences when a PO is added/cancelled, so keying the Vendor/Supplier override by it
    // made the classification "revert" (or jump to the wrong PO) after the PO list changed. Umbrava's
    // assigned line number (the "001" <h6> label) is stable per PO, so key by that; fall back to the
    // vendor GUID (per-vendor, stable), then the render index (legacy last resort).
    function poKeyOf(row) {
      var hs = row.querySelectorAll('h6');
      for (var i = 0; i < hs.length; i++) { var t = (hs[i].textContent || '').trim(); if (/^\d{2,4}$/.test(t)) return 'ln' + t; }
      var all = row.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) { if (!all[j].children.length) { var tt = (all[j].textContent || '').trim(); if (/^\d{2,4}$/.test(tt)) return 'ln' + tt; } }
      var a = row.querySelector('a[href*="/vendors/"]');
      var m = a && (a.getAttribute('href') || '').match(/vendors\/([0-9a-f\-]{8,})/i);
      if (m) return 'v' + m[1];
      return 'ix' + ((row.getAttribute('data-testid') || '').replace('POAccordion-', ''));
    }
    function poIsSupplier(vendor, num) {
      var ov = poOverrides();
      if (ov[num] === 'S') return true;
      if (ov[num] === 'V') return false;
      var nv = nvVendor(vendor);
      return poSuppliers().some(function (t) { return t && nv.indexOf(nvVendor(t)) !== -1; });
    }
    function poLca(a, b) { var anc = []; var x = a; while (x) { anc.push(x); x = x.parentElement; } var y = b; while (y) { if (anc.indexOf(y) !== -1) return y; y = y.parentElement; } return null; }
    function poFindContainer() {
      var rows = document.querySelectorAll('[data-testid^="POAccordion-"]');
      if (rows.length < 2) return null;   // nothing to group with 0–1 POs
      var c = rows[0];
      for (var i = 1; i < rows.length; i++) { c = poLca(c, rows[i]); if (!c) return null; }
      var cs = getComputedStyle(c);
      if (cs.display !== 'flex' || cs.flexDirection.indexOf('column') !== 0) return null;   // grouping-by-order only works on a flex column
      return c;
    }
    function poUnitOf(row, container) { var c = row; while (c.parentElement && c.parentElement !== container) c = c.parentElement; return c.parentElement === container ? c : null; }
    function ensurePoGroupStyle() {
      if (document.getElementById('bwn-po-style')) return;
      var st = document.createElement('style'); st.id = 'bwn-po-style';
      st.textContent =
        '.bwn-po-hdr{width:100%;box-sizing:border-box;font:600 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:.06em;color:var(--bwn-green);padding:9px 4px 3px;border-top:1px solid var(--bwn-border-2);margin-top:6px;}' +
        '.bwn-po-tgl{flex:none;align-self:center;margin:0 8px 0 2px;border:1px solid var(--bwn-border);border-radius:999px;padding:3px 10px;font:500 9px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:.03em;cursor:pointer;white-space:nowrap;height:fit-content;}' +
        '.bwn-po-tgl.ven{color:var(--bwn-green-dk);background:var(--bwn-tint);border-color:var(--bwn-green);}' +
        '.bwn-po-tgl.sup{color:#fff;background:var(--bwn-warn);border-color:var(--bwn-warn);}';
      document.head.appendChild(st);
    }
    function ensurePoHeader(container, id, text, order, count) {
      var h = document.getElementById(id);
      if (!count) { if (h) h.style.display = 'none'; return; }
      if (!h) { h = document.createElement('div'); h.id = id; h.className = 'bwn-po-hdr'; container.appendChild(h); }
      if (h.style.display === 'none') h.style.display = '';
      if (h.style.order !== String(order)) h.style.order = String(order);
      if (h.textContent !== text) h.textContent = text;
    }
    function ensurePoToggle(unit, num, sup) {
      var id = 'bwn-po-tgl-' + num, pill = document.getElementById(id);
      if (!pill) {
        pill = document.createElement('button');
        pill.id = id; pill.type = 'button'; pill.className = 'bwn-po-tgl';
        pill.addEventListener('click', function (e) {
          e.stopPropagation(); e.preventDefault();
          poSetOverride(num, pill.getAttribute('data-cls') === 'S' ? 'V' : 'S');   // flip THIS PO on THIS WO
          renderPOGroups();
        });
        unit.insertBefore(pill, unit.firstChild);   // a flex SIBLING of the accordion - its own space, never overlaps Umbrava's row controls
      } else if (pill.parentElement !== unit) {
        unit.insertBefore(pill, unit.firstChild);    // React re-rendered the unit → re-attach
      }
      var cls = sup ? 'S' : 'V';
      if (pill.getAttribute('data-cls') !== cls) {
        pill.setAttribute('data-cls', cls);
        pill.className = 'bwn-po-tgl ' + (sup ? 'sup' : 'ven');
        pill.textContent = sup ? 'Supplier ⇄' : 'Vendor ⇄';
        pill.title = 'Classified as ' + (sup ? 'Supplier' : 'Vendor') + ' - click to move to ' + (sup ? 'Vendors' : 'Suppliers') + ' for this WO';
      }
    }
    function renderPOGroups() {
      if (!onWO()) return;
      var container = poFindContainer();
      if (!container) { ['bwn-po-hV', 'bwn-po-hS'].forEach(function (id) { var e = document.getElementById(id); if (e) e.remove(); }); return; }
      ensurePoGroupStyle();
      var items = [];
      document.querySelectorAll('[data-testid^="POAccordion-"]').forEach(function (row) {
        var unit = poUnitOf(row, container); if (!unit) return;
        var num = poKeyOf(row);   // stable per-PO key (line number) - survives PO add/cancel reorder
        var vend = vendorOf(row);
        items.push({ row: row, unit: unit, num: num, vendor: vend, sup: poIsSupplier(vend, num) });
      });
      // Publish the resolved Vendor/Supplier classification per vendor to a decoupled
      // per-WO key so OTHER suite scripts (e.g. bwn-cc-purchase) can default the
      // "Supplier" field to whatever line the user flipped to Supplier - WITHOUT the PO
      // `num` (which the bus `pos` drops). Write-on-change to avoid storage churn.
      try {
        var woIdC = currentWOId();
        if (woIdC) {
          var cls = items
            .map(function (x) { return { vendor: String(x.vendor || '').trim(), sup: !!x.sup }; })
            .filter(function (c) { return c.vendor && c.vendor !== '(vendor n/a)'; });
          var clsKey = 'bwn:po:cls:' + woIdC;
          var prevRaw = localStorage.getItem(clsKey);
          var prevItems = null; try { prevItems = prevRaw ? (JSON.parse(prevRaw).items || null) : null; } catch (e) { prevItems = null; }
          if (JSON.stringify(prevItems) !== JSON.stringify(cls)) {
            localStorage.setItem(clsKey, JSON.stringify({ v: 1, ts: Date.now(), items: cls }));
          }
        }
      } catch (e) { /* best-effort; classification publish is non-critical */ }
      var vN = items.filter(function (x) { return !x.sup; }).length, sN = items.length - vN;
      var vi = 0, si = 0;
      items.forEach(function (x) {
        var ord = String((x.sup ? 200 : 100) + (x.sup ? si++ : vi++));
        if (x.unit.style.order !== ord) x.unit.style.order = ord;   // write-on-change so the mutation observer settles
        ensurePoToggle(x.unit, x.num, x.sup);
      });
      var split = vN > 0 && sN > 0;   // only label the sections when there is an actual split
      ensurePoHeader(container, 'bwn-po-hV', 'VENDOR POs · ' + vN, 50, split ? vN : 0);
      ensurePoHeader(container, 'bwn-po-hS', 'SUPPLIER POs · ' + sN, 150, split ? sN : 0);
    }

    // Enqueue a coordinator action for the SWA connector (drained + POSTed by the AI
    // script). Core STAYS ZERO-EGRESS - this only writes localStorage `bwn:ingestq`.
    // FIFO, capped; the AI script removes from the front after a successful POST.
    var ingestSeq = 0;
    function ingestPush(action, detail) {
      try {
        var q = BWN.lsGetJSON('bwn:ingestq', []); if (!Array.isArray(q)) q = [];
        // Unique id → the AI drain clears by id (not position, which the 200-cap breaks)
        // and the server dedups by id (so a teardown-before-clear can't duplicate).
        var id = Date.now().toString(36) + (ingestSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
        // Target = the TRACKING # (digits) - that's the dashboard's job id, so these events
        // line up with its jobs/rollup. The Umbrava URL id is a different number; fallback only.
        var tgt = ''; try { tgt = headerInfo().tracking; } catch (e) { }
        q.push({ id: id, action: action, target: tgt || currentWOId() || null, detail: (detail || '').slice(0, 300), ts: Date.now() });
        if (q.length > 200) q = q.slice(-200);
        BWN.lsSetJSON('bwn:ingestq', q);
      } catch (e) { /* best-effort */ }
    }
    // Stage a job → dashboard plan push. Zero-egress: enqueues to localStorage
    // 'bwn:planq'; the AI script drains it (key-gated POST {plans}) into the SWA
    // 'job-plans' store, which the dashboard mirrors. Deduped by content hash per
    // tracking # (the AI-confirmed 'bwn:plansent') so an unchanged plan doesn't re-enqueue on every
    // refresh; one pending entry per tracking (latest wins).
    function stagePlanPush(tracking, items, src) {
      try {
        tracking = String(tracking || '');
        if (!/^\d+$/.test(tracking) || !items || !items.length) return;
        var norm = items.map(function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean).slice(0, 25);
        if (!norm.length) return;
        var h = authoredKeyHash(norm.join('\u0001'));
        // Dedup on 'bwn:plansent' -- the content the AI has CONFIRMED handled (sent ok, or
        // 400-dropped as invalid) -- NOT a local marker set at enqueue, which would
        // permanently block a plan the server never accepted (silent loss). Keying off the
        // sender's terminal result re-queues an unsent plan until it actually lands (review).
        var sent = BWN.lsGetJSON('bwn:plansent', null); if (!sent || typeof sent !== 'object') sent = {};
        if (sent[tracking] === h) return;   // this exact content already handled by the AI
        var q = BWN.lsGetJSON('bwn:planq', []); if (!Array.isArray(q)) q = [];
        var existing = null;
        q = q.filter(function (e) { if (e && e.target === tracking) { existing = e; return false; } return true; });   // one pending per tracking
        if (existing && existing.h === h) { q.push(existing); BWN.lsSetJSON('bwn:planq', q); return; }   // identical entry already queued -> don't churn its id
        var id = Date.now().toString(36) + (ingestSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
        q.push({ id: id, target: tracking, items: norm, src: src || 'note', h: h, ts: Date.now() });
        if (q.length > 100) q = q.slice(-100);
        BWN.lsSetJSON('bwn:planq', q);
      } catch (e) { /* best-effort */ }
    }
    // Stage a job -> dashboard ACTS overlay (board item #42). Zero-egress: enqueues to
    // localStorage 'bwn:actsq'; the AI script drains it (key-gated POST {acts}) into the SWA
    // 'job-acts' store, which the dashboard overlays onto stateFromRow via opts.over so the SAME
    // engine yields the PO/stall/no-show/docs/task steps a workbook row cannot reach. The overlay
    // is exactly the fields the dashboard adapter defaults empty (pos:[], stall/noShow/docs/
    // openTasks null). Keyed by BOTH the tracking # and the WO # (the header carries both) so the
    // dashboard join resolves regardless of board item 43. Deduped by content hash per key
    // ('bwn:actssent', the AI-confirmed marker) so an unchanged overlay doesn't re-enqueue every
    // refresh; one pending entry per key. Only stages when a detail-page-only signal exists.
    function stageActsPush(state) {
      try {
        if (!state) return;
        var hd = state.hd || {};
        var tracking = String(hd.tracking || '').replace(/\D+/g, '');
        var woNum = String(hd.wo || '').replace(/\D+/g, '');
        if (!/^\d+$/.test(tracking) && !/^\d+$/.test(woNum)) return;   // no key the dashboard could join on
        var over = {
          pos: Array.isArray(state.pos) ? state.pos : [],
          stall: state.stall || null,
          noShow: state.noShow || null,
          docs: state.docs || null,
          openTasks: state.openTasks || null,
          gpPct: (typeof state.gpPct === 'number') ? state.gpPct : null,
          nte: state.nte || null,
          vendorTotal: (typeof state.vendorTotal === 'number') ? state.vendorTotal : null,
          noteCount: (typeof state.noteCount === 'number') ? state.noteCount : 0,
          lastClientNoteDays: (typeof state.lastClientNoteDays === 'number') ? state.lastClientNoteDays : null,
          staleDays: (typeof state.staleDays === 'number') ? state.staleDays : null,
          eta: state.eta || null
        };
        // Only worth a push if it carries something the workbook row lacks - else the dashboard's
        // default (workbook-only) state is already equivalent, so pushing an empty overlay is noise.
        var hasSignal = (over.pos && over.pos.length) || over.stall || over.noShow || over.docs || over.openTasks;
        if (!hasSignal) return;
        var key = tracking || woNum;
        var h = authoredKeyHash(JSON.stringify(over));
        var sent = BWN.lsGetJSON('bwn:actssent', null); if (!sent || typeof sent !== 'object') sent = {};
        if (sent[key] === h) return;   // this exact overlay already handled by the AI
        var q = BWN.lsGetJSON('bwn:actsq', []); if (!Array.isArray(q)) q = [];
        var existing = null;
        q = q.filter(function (e) { if (e && e.key === key) { existing = e; return false; } return true; });   // one pending per key
        if (existing && existing.h === h) { q.push(existing); BWN.lsSetJSON('bwn:actsq', q); return; }   // identical entry already queued -> keep its id
        var id = Date.now().toString(36) + (ingestSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
        q.push({ id: id, key: key, target: tracking || null, wo: woNum || null, over: over, h: h, ts: Date.now() });
        if (q.length > 100) q = q.slice(-100);
        BWN.lsSetJSON('bwn:actsq', q);
      } catch (e) { /* best-effort, zero-egress */ }
    }
    // ---- Usage stats + adaptive NUDGING (Increment B) --------------------------
    // INVERTED learning, per the operating rule: habits only ever ADD pressure, they
    // never hide, soften, or reorder a step downward. A step TYPE that keeps getting
    // dismissed without being done across distinct recent jobs gets flagged HARDER
    // (marker + why suffix + urgency boost). Stats are per key-prefix in localStorage
    // 'bwn:actstats' - a rolling event log {w: woId, t, a: 'd'|'s'} capped per prefix.
    var ACT_CRITICAL = { noshow: 1, stall: 1, dne: 1, ecd: 1, poconf: 1, pocost: 1, task: 1, escalate: 1 };
    function actIsCritical(a) { return !!ACT_CRITICAL[(a.key || '').split(':')[0]] || (a.key || '').indexOf('phase:client') === 0; }
    // Stats prefix: phase steps keep their sub-phase ('phase:client' ≠ 'phase:schedule');
    // authored items and the anchor carry no habit signal (free text / uncheckable).
    function statPrefix(a) {
      if (!a || a.anchor || a.authored) return null;
      var k = a.key || '';
      return k.indexOf('phase:') === 0 ? k.split(':').slice(0, 2).join(':') : k.split(':')[0];
    }
    var STATS_KEY = 'bwn:actstats', NUDGE_MIN_JOBS = 3, NUDGE_WINDOW = 8, STATS_CAP = 20;
    function actStatsLoad() { var d = BWN.lsGetJSON(STATS_KEY, null); return (d && d.v === 1 && d.p) ? d : { v: 1, p: {} }; }
    function statRecord(a, kind) {
      var p = statPrefix(a); if (!p) return;
      try {
        var s = actStatsLoad(); var arr = s.p[p] = (s.p[p] || []);
        arr.push({ w: currentWOId() || '?', t: Date.now(), a: kind });
        if (arr.length > STATS_CAP) arr.splice(0, arr.length - STATS_CAP);
        BWN.lsSetJSON(STATS_KEY, s);
      } catch (e) { /* stats are best-effort */ }
    }
    // A prefix is NUDGED when, among its most recent NUDGE_WINDOW distinct jobs, the
    // LATEST event on ≥ NUDGE_MIN_JOBS of them was a dismissal (a later done on the
    // same job clears that job's skip - doing the work always wins).
    function nudgedPrefixes() {
      var s = actStatsLoad(), out = {};
      Object.keys(s.p || {}).forEach(function (p) {
        var latest = {}, order = [], arr = s.p[p] || [];
        for (var i = arr.length - 1; i >= 0 && order.length < NUDGE_WINDOW; i--) {
          var e = arr[i]; if (!e || !e.w) continue;
          if (!(e.w in latest)) { latest[e.w] = e.a; order.push(e.w); }
        }
        var skips = 0; order.forEach(function (w) { if (latest[w] === 's') skips++; });
        if (skips >= NUDGE_MIN_JOBS) out[p] = skips;
      });
      return out;
    }
    function actsMarkDone(a, noteTyped) {
      var s = actsLoad(); s[a.key] = { done: 1, ts: Date.now(), note: noteTyped || '' }; actsSave(s);
      statRecord(a, 'd');
      var p = (a.key || '').split(':')[0];   // deliberate action only (checkbox / Actioned button) - auto-detect writes the store directly and is NOT logged
      ingestPush(p === 'escalate' ? 'escalate' : p === 'pocost' ? 'po-cost-confirm' : 'na-done', a.label);
    }
    // Uncheck = TOMBSTONE, not delete: the auto-detect below re-marks any keyless
    // action whose label sits in a (permanent) note, which would make unchecking
    // impossible. A {dismissed} record renders unchecked AND is skipped by the
    // detector; re-checking simply overwrites it with a done record.
    // reason: required for CRITICAL steps (accountability friction - becomes a WO note
    // + rides to the activity log). isAuto: the uncheck is a CORRECTION of a wrong
    // auto-check - frictionless, and it must NOT count as a skip (punishing the
    // coordinator for fixing the machine's mistake would teach them to leave it wrong).
    function actsMarkUndone(a, reason, isAuto) {
      var s = actsLoad(); s[a.key] = { dismissed: Date.now(), reason: (reason || '').slice(0, 200) }; actsSave(s);
      if (!isAuto) statRecord(a, 's');
      ingestPush('na-undone', a.label + (reason ? ' - ' + reason : (isAuto ? ' (correction)' : '')));
    }

    // Two ways a WO note converges a step (both auto-CHECK, reversibly - a tombstone
    // via uncheck is never overwritten, so nothing the coordinator decides is undone):
    //  1) EXACT LABEL, any age - our "Actioned…" notes start with the label, so a step
    //     logged on another machine (or by hand quoting the label) syncs on sight.
    //  2) CONSERVATIVE SIGNAL in a RECENT note - a coordinator's own words ("got ETA
    //     7/15", "tech completed, docs uploaded") match the step's resolve() signal,
    //     but ONLY within the recency window so an old note can't converge a step that
    //     has since reopened. Undated notes never trigger #2 (fail-safe).
    var CONVERGE_DAYS = 21;
    function recentConvergeNotes(notes) {
      var now = Date.now(), out = [];
      for (var i = 0; i < notes.length; i++) {
        var t = parseNoteDate(notes[i].ts);
        if (t !== null && (now - t) <= CONVERGE_DAYS * 86400000) out.push(notes[i]);
      }
      return out;
    }
    function noteConvergeReason(a, notes, recent) {
      for (var i = 0; i < notes.length; i++) {
        var b = notes[i].body || '';
        // A DISMISSAL note ('Dismissed step: <label> - <reason>') contains the label
        // verbatim - it must NEVER converge the step it dismissed. Without this guard
        // the dismissal inverts into a completion on any browser lacking the local
        // tombstone, and on every FUTURE episode of steps whose labels are stable
        // across re-keys (stall/ecd/escalate) - review MAJOR, both lenses.
        if (b.indexOf('Dismissed step:') !== -1) continue;
        if (b.indexOf(a.label) !== -1) return 'logged in a WO note';
      }
      if (a.resolve) {
        for (var j = 0; j < recent.length; j++) {
          var rb = recent[j].body || '';
          if (rb.indexOf('Dismissed step:') !== -1) continue;   // a dismissal's free-text reason ("vendor rescheduled to 7/20") must not trip resolve signals either
          try { if (a.resolve(rb)) return 'a recent note looks like this was handled - uncheck if not'; } catch (e) { }
        }
      }
      return null;
    }
    // ---- Authored-item convergence (newer-notes-only) --------------------------
    // Authored items may converge ONLY from notes STRICTLY NEWER than their plan source -
    // every item is a verbatim slice of the plan note, so matching against the plan itself
    // (or anything older) would instantly self-check the whole list (review M1). The plan
    // ref rides on a.planRef (Phase 0 - formerly parsed from the key, which now carries the
    // content hash): a note plan's ref is its note id → newer = higher id (Umbrava ids are
    // monotonic); dash<epochMs> → newer = a note DATED after the dashboard case-file save
    // (undated notes never qualify - fail-safe). No ref at all → NOTHING converges: a hash
    // would parseInt to garbage and self-check the whole list.
    function authoredNewerNotes(a, notes) {
      var ref = String((a && a.planRef) || ''), out = [], i;
      if (!ref) return out;
      if (/^dash\d+$/.test(ref)) {
        // The dash ref carries the plan block's END-OF-DAY epoch, so only LATER-day notes
        // qualify - same-day notes can predate the afternoon the plan was authored (facts
        // the author already knew) and must not converge it. Prefer the frozen tsAbs
        // (bus-cached notes) over re-parsing a relative "2 hours ago" label against NOW.
        var ms = parseInt(ref.slice(4), 10) || 0;
        for (i = 0; i < notes.length; i++) {
          var t = (typeof notes[i].tsAbs === 'number') ? notes[i].tsAbs : parseNoteDate(notes[i].ts);
          if (t !== null && t > ms) out.push(notes[i]);
        }
      } else {
        var pid = parseInt(ref, 10) || 0;
        for (i = 0; i < notes.length; i++) { if ((parseInt(notes[i].id, 10) || 0) > pid) out.push(notes[i]); }
      }
      return out;
    }
    // Salient terms of an authored item = its distinct 5+-letter words minus stopwords and
    // minus the leading assignee name ("Erick Nieves-Cruz - …"), which would otherwise
    // match every email note's From:/To: lines. Directive verbs (confirm/obtain/…) and
    // days/months are stopworded - they describe the ASK, not the completed fact.
    var AUTHORED_STOP = /^(about|after|again|against|answer|approval|around|before|being|between|broadway|cannot|client|communicate|complete|completed|confirm|confirmed|could|definitive|determine|documentation|during|ensure|escalate|every|first|follow|following|further|however|immediately|management|moment|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|august|september|october|november|december|needs|needed|obtain|order|orders|other|please|provide|really|relay|required|schedule|should|status|their|there|these|those|through|today|tomorrow|under|until|update|vendor|whether|which|while|without|would)$/;
    function authoredTerms(label) {
      var t = String(label || '');
      // Strip the leading assignee whatever the separator (em-dash, en-dash, "-", "--") -
      // the name appears in every email note's From:/To: lines and must not be evidence.
      var sep = t.search(/\s+[-–-]{1,2}\s+/); if (sep > 0 && sep < 40) t = t.slice(sep).replace(/^\s+[-–-]{1,2}\s+/, '');
      var words = (t.toLowerCase().match(/[a-z][a-z'-]{4,}/g) || []), out = [], seen = {};
      for (var i = 0; i < words.length; i++) { var w = words[i]; if (!AUTHORED_STOP.test(w) && !seen[w]) { seen[w] = 1; out.push(w); } }
      return out;
    }
    // No 'sent'/'attached'/'provided': those are structural furniture in every forwarded
    // email ("Sent: Monday…", "Attachments:") and would affirm from headers alone.
    var AUTHORED_AFFIRM = /\b(done|completed?|finished|passed|received|obtained|got|confirmed|resolved|scheduled|booked|approved|issued|submitted|uploaded|documented|reconciled|secured|delivered|arrived|squared away|in hand|took care|handled)\b/i;
    // Only the text BEFORE the first email-header marker counts as evidence - that's the
    // coordinator's own summary ("inspection done - pending date for concrete From: Ben…").
    // A forwarded Subject: line repeating the item's words must never converge it.
    function authoredEvidence(body) {
      var s = String(body || '');
      var m = s.search(/\b(from|sent|to|cc|subject)\s*:/i);
      return m >= 0 ? s.slice(0, m) : s;
    }
    function authoredResolveReason(a, newer, recent) {
      // 1) Exact label at the START of a strictly-newer note - the "Actioned…" log shape
      //    (label + " - " + what was done). Start-anchored so a quoted reply that embeds
      //    the item text mid-body ("> 2. Obtain the report - we could NOT reach…") can't
      //    converge an item its surrounding text negates.
      for (var i = 0; i < newer.length; i++) {
        var nb = (newer[i].body || '').replace(/\s+/g, ' ').trim();
        if (nb.indexOf(a.label) === 0) return 'logged in a WO note';
      }
      // 2) Subject + resolution: a newer AND recent (CONVERGE_DAYS) clause naming ≥2 of the
      //    item's own terms with a resolution verb, negation-vetoed ("rebar inspection
      //    passed", "inspection done - pending date for concrete"). Conservative by
      //    construction; the auto-check stays reversible ("uncheck if not").
      var terms = authoredTerms(a.label);
      if (terms.length < 2) return null;                    // not enough subject to match safely
      var recentIds = {}; for (var r = 0; r < recent.length; r++) recentIds[recent[r].id] = 1;
      for (var j = 0; j < newer.length; j++) {
        if (!recentIds[newer[j].id]) continue;              // stale/undated notes never converge
        var cl = actClauses(authoredEvidence(newer[j].body));
        for (var k = 0; k < cl.length; k++) {
          var c = cl[k]; if (!AUTHORED_AFFIRM.test(c) || ACT_NEG.test(c)) continue;
          var lc = c.toLowerCase(), hits = 0;
          for (var t2 = 0; t2 < terms.length && hits < 2; t2++) { if (lc.indexOf(terms[t2]) !== -1) hits++; }
          if (hits >= 2) return 'a recent note looks like this was handled - uncheck if not';
        }
      }
      return null;
    }
    // ---- Structured convergence (Phase 4) --------------------------------------
    // A step converges on a REAL STATE FIELD, not note wording, when state proves it
    // handled. Checked BEFORE the brittle note-regex pass below, so the text match is only
    // a fallback. Only UNAMBIGUOUS facts converge here - a PO's OWN `done` / status field.
    // Ambiguous reads deliberately do NOT converge (honoring "never false-check an open
    // step"): a bare Documents COUNT can be intake docs rather than the completion package
    // (see readDocs / Phase 2), so docs-present never auto-completes a step. Most steps
    // already converge structurally by NON-GENERATION (their key encodes the resolving
    // field, so the step stops being produced when that field moves); this handles the
    // note-only remainder the spec named - materials/completion tied to a PO, and the trip
    // no-show, which is fed by the trips cache INDEPENDENT of PO state (so a PO that
    // completed with no per-PO status would otherwise keep nagging until a note matched).
    // Sid lookup, NOT render-index lookup (2026-08-02 re-key): matching parts[1] against
    // p.num was the false-CHECK half of the render-index defect - after a PO add/cancel
    // re-sequenced the list, this read the WRONG PO's done flag and could auto-check an
    // open step. A sid that matches nothing returns null, which converges NOTHING.
    function poBySid(state, sid) {
      var ps = (state && state.pos) || [];
      for (var i = 0; i < ps.length; i++) if (String(ps[i].sid) === String(sid)) return ps[i];
      return null;
    }
    function structConvergeReason(a, state) {
      if (!a || !state) return null;
      var parts = (a.key || '').split(':'), pfx = parts[0];
      if (pfx === 'pomat' || pfx === 'poconf') {          // materials / completion, per PO
        var p = poBySid(state, parts[1]);
        if (p && p.done) return 'PO ' + p.num + ' is marked done';
        if (pfx === 'pomat' && p && p.poStatus && p.poStatus !== 'materials') return 'PO ' + p.num + ' is no longer awaiting materials';
      }
      if (pfx === 'noshow' && state.noShow) {              // trips-cache no-show vs. the real PO ledger
        var nv = nvVendor(state.noShow.vendor);
        if ((state.pos || []).some(function (p2) { return p2.done && nvVendor(p2.vendor) === nv; })) return state.noShow.vendor + ' has a completed PO on this WO';
      }
      return null;
    }
    function autoDetectActioned(acts, state) {
      var store = actsLoad(), dirty = false;
      var notes = getNotes();
      var recent = recentConvergeNotes(notes);
      acts.forEach(function (a) {
        // The completion gate and the status-advancement step clear ONLY when the WO
        // STATUS itself moves (their key changes), never from a note - a note must not
        // fake-complete "recruit a vendor" and let the list read "all done" on an open WO.
        if (a.anchor || a.key.indexOf('phase:') === 0) return;
        if (store[a.key]) return;   // any existing record - done OR dismissed tombstone - is a decision; never overwrite
        // Structured state field (real, unambiguous) wins over the note-regex fallback.
        var reason = structConvergeReason(a, state)
          || (a.authored
            ? authoredResolveReason(a, authoredNewerNotes(a, notes), recent)   // newer-than-plan only (self-check guard)
            : noteConvergeReason(a, notes, recent));
        // auto:1 → unchecking this is a frictionless correction, not a skip. NO statRecord:
        // machine convergence is not a coordinator habit signal - counting it let passive
        // WO viewing dilute an earned nudge, and a corrected wrong auto-check would have
        // left a phantom "done" standing in the stats (review). Stats track DELIBERATE
        // checkbox/Actioned/dismiss decisions only.
        if (reason) { store[a.key] = { done: 1, ts: Date.now(), note: reason, auto: 1 }; dirty = true; }
      });
      if (dirty) actsSave(store);
    }

    // ---- Phase 2 row assist: tool launch, in-page navigation, training -------
    // Three annotation layers over the SAME acts the pure engine produced. All three are
    // render-time only - the engine stays side-effect free and its output is unchanged.
    //
    // TOOL LAUNCH. A step whose work is done by another suite tool gets a button that
    // opens that tool's drawer over the existing dock bus. It renders ONLY when the
    // registrant is currently registered, so a disabled module or a WO the tool does not
    // apply to yields no button rather than a dead control.
    // PINNED against the live registrant table ([[bwn-launcher-dock]]): dispatch / cc /
    // wo-audit / assist / ask, plus `bidout` (bwn-bid-out 0.26.0, registered 2026-08-02
    // exactly so this mapping could exist - it is dynamic on WO detail pages the way
    // dispatch is dynamic on Pending Dispatch). A step key maps to the tools that DO
    // that step: "Recruit / dispatch a vendor" (phase:schedule) and the intake scoping
    // step offer BOTH paths to coverage - the Dispatch drawer (network vendor; its
    // registrant self-gates to Pending Dispatch WOs, so presence does the status gating
    // for free) and Email RFP (outside / net-new vendors). AI Draft (suite-ai) is still
    // NOT a dock registrant (it answers bwn:cmd only), so it stays deliberately absent.
    // `escalate` -> the assist drawer (bwn-wo-assist), added once /api/wo-assist went live:
    // the escalation step is the one row whose whole point is handing the job to someone
    // else, and the assist tool is what actually routes it. Presence gating does the rest -
    // a button only exists where its registrant is installed and registered, so a
    // coordinator without the script sees the row exactly as before.
    var ACT_TOOL = { 'phase:schedule': ['dispatch', 'bidout'], 'phase:intake': ['dispatch', 'bidout'], escalate: ['assist'] };
    var ACT_TOOL_LABEL = { dispatch: 'Dispatch\u2026', cc: 'CC Request\u2026', 'wo-audit': 'WO Audit\u2026', ask: 'Ask BWN\u2026', assist: 'Escalate\u2026', bidout: 'Email RFP\u2026' };
    function actTool(a) {
      if (!a || a.anchor || a.authored) return null;   // authored items are free text - no reliable tool to infer
      var d = ACT_TOOL[a.key] || ACT_TOOL[(a.key || '').split(':')[0]];
      return d ? { docks: d } : null;
    }
    // Dock presence, WO Assist side. The Launcher module owns dockRoster but lives in its
    // own IIFE, so this listens to the same bus independently: registrants re-announce on
    // every host ping (20s), and an entry ages out on the launcher's own TTL. Worst case
    // after a fresh load is one ping of delay before a button appears - late is fine,
    // wrong is not.
    var WA_DOCK_TTL_MS = 65000;   // mirrors the launcher's DOCK_TTL_MS (3 pings + slack)
    var waDockSeen = {};
    function waDockAlive(k) { var t = waDockSeen[k]; return !!t && (Date.now() - t) < WA_DOCK_TTL_MS; }
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail; if (!d || !d.key) return;
      if (d.id === 'bwn:dock:register' || d.id === 'bwn:dock:update') waDockSeen[d.key] = Date.now();
      else if (d.id === 'bwn:dock:unregister') delete waDockSeen[d.key];
    }, false);

    // ESCALATE SEVERITY HANDOFF. The engine computes escSev (how far past the escalate
    // clock, >=1 at fire) but the assist drawer runs in its own sandbox and only hears the
    // bus: bwn:assist:due {escSev} arms bwn-wo-assist's _pendingSev, which rides the POST
    // as escSev so the SERVER can bump the tier (supervisor -> management) for a WO far
    // past its clock. Fired at render time - the engine stays pure. Latched per
    // path+key per page load (re-arming would be harmless, _pendingSev is consumed on
    // open, but the bus stays quiet), and gated on the assist registrant being LIVE so
    // the event cannot fire before a listener exists: the checklist signature includes
    // the live-dock set, so assist coming online re-renders the card and this re-runs.
    var assistDueSent = {};
    function armAssistDue(a, isDone) {
      if (isDone || !a || typeof a.sev !== 'number') return;
      if ((a.key || '').split(':')[0] !== 'escalate') return;
      if (!waDockAlive('assist')) return;
      var k = location.pathname + '|' + a.key;
      if (assistDueSent[k]) return;
      assistDueSent[k] = 1;
      try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:assist:due', escSev: a.sev } })); } catch (e) { }
    }

    // ASSIST STATE ROUND-TRIP (queue-spec step 3). The queue's lifecycle lives on the
    // server and Core is @grant none, so it cannot ask. bwn-wo-assist (which can) queries
    // op:'status' and publishes the current WO's ACTIVE escalation two ways: a
    // bwn:assist:state bus event (live re-render) and sessionStorage
    // bwn:assist:state:<woId> (render-time reads after a reload). Core only CONSUMES -
    // the same one-way pattern as bwn:role. Render-layer only: the pure engine never
    // sees any of it, so engine output stays byte-identical.
    var WA_ESC_TTL_MS = 30 * 60000;   // assist refreshes ~5-minutely; a dead install ages out
    var waAssistState = {};
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:assist:state' && d.wo) waAssistState[d.wo] = { v: 1, ts: Date.now(), found: !!d.found, record: d.record || null };
    }, false);
    // The current WO's active escalation record, or null. Only open/ack count - a
    // resolved item must clear the strip the moment anyone resolves it, and stale
    // published state ages out rather than lying forever.
    function waEscState() {
      var m = location.pathname.match(/work-orders\/(\d+)/);
      if (!m) return null;
      var s = waAssistState[m[1]];
      if (!s) {
        s = BWN.ssGetJSON('bwn:assist:state:' + m[1], null);
        if (!s || s.v !== 1) return null;
      }
      if (!s.found || !s.record) return null;
      if (!s.ts || (Date.now() - s.ts) > WA_ESC_TTL_MS) return null;
      var st = s.record.status;
      return (st === 'open' || st === 'ack') ? s.record : null;
    }
    // Strip wording, pure. "Escalated - awaiting mgmt" is the queue-spec's literal
    // round-trip phrase; ack and own-call get their own honest variants.
    function waEscStripText(rec) {
      function md(iso) { var d = new Date(iso); return isNaN(+d) ? '' : ((d.getMonth() + 1) + '/' + d.getDate()); }
      function nm(s) { s = String(s || ''); var i = s.indexOf('@'); return i > 0 ? s.slice(0, i) : s; }
      if (!rec) return '';
      var p;
      if (rec.status === 'ack') {
        p = ['Escalated - mgmt has it (acknowledged' + (nm(rec.assignee) ? ' by ' + nm(rec.assignee) : '') + (md(rec.ackAt) ? ' ' + md(rec.ackAt) : '') + ')'];
      } else if (rec.tier === 'own-call') {
        p = ['Escalation recorded - own call, yours to decide'];
      } else {
        p = ['Escalated - awaiting mgmt'];
        if (nm(rec.requester)) p.push('by ' + nm(rec.requester));
      }
      if (md(rec.openedAt)) p.push('opened ' + md(rec.openedAt));
      if (rec.status !== 'ack' && md(rec.dueAt)) p.push('due ' + md(rec.dueAt));
      return p.join(' · ');
    }
    // Tool-button label: an already-escalated WO's assist button opens the SAME drawer,
    // which shows the ack/resolve panel instead of a form the server would dedup-refuse
    // anyway - so say what it does.
    function waEscToolLabel(dk, esc) {
      return (dk === 'assist' && esc) ? 'View escalation…' : (ACT_TOOL_LABEL[dk] || 'Open tool…');
    }

    // IN-PAGE NAVIGATION. Clicking a step label walks the page to the thing it is about.
    // Only targets with a PROVEN selector are offered (the same ones the engine already
    // reads): PO rows by their own testid, the ECD picker, the DNE/NTE input. Anything
    // else returns null so the label stays plain text - a heuristic that silently lands
    // on the wrong element is worse than no navigation (the NEXT ACTIONS anchor bug).
    function actNav(a) {
      if (!a || a.anchor) return null;
      var parts = (a.key || '').split(':'), p = parts[0];
      // PO keys carry a STABLE sid in parts[1] (2026-08-02 re-key), which is not the
      // POAccordion-<n> testid value - navigation rides the act's own poNum (the render
      // index, refreshed every render). parts[1] stays as a last-resort fallback only.
      if ((p === 'pomat' || p === 'poacc' || p === 'poconf' || p === 'pocost') && parts[1]) return { kind: 'po', num: a.poNum != null ? a.poNum : parts[1] };
      if (p === 'ecd') return { kind: 'ecd' };
      if (p === 'intake' && /\bNTE\b/.test(a.why || '')) return { kind: 'nte' };
      return null;
    }
    function actNavTarget(nav) {
      if (!nav) return null;
      if (nav.kind === 'po') return document.querySelector('[data-testid="POAccordion-' + String(nav.num).replace(/["\\]/g, '') + '"]');
      if (nav.kind === 'ecd') return ecdFieldInput();
      if (nav.kind === 'nte') return document.querySelector('input[name="doNotExceed"]');
      return null;
    }
    function actNavGo(nav) {
      var el = actNavTarget(nav);
      if (!el) return;   // best-effort by contract: a missing target is a silent no-op
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) { } }
      // Outline-only highlight (no layout shift), self-clearing - we are decorating
      // Umbrava's own element, so it must leave no trace.
      try {
        var flash = (el.tagName === 'INPUT' && el.parentNode) ? el.parentNode : el;
        flash.classList.add('bwn-act-flash');
        setTimeout(function () { try { flash.classList.remove('bwn-act-flash'); } catch (e3) { } }, 1600);
      } catch (e4) { }
    }

    // TRAINING LAYER. Three static lines per step type - what it means, where in Umbrava
    // to do it, what done looks like - behind a "?" toggle. For a new coordinator the
    // checklist becomes self-explaining. Deliberately static: zero egress, deterministic,
    // no AI dependency, nothing to go stale on a network call.
    var ACT_HELP = {
      noshow: ['The vendor missed a scheduled visit - the trip is logged but no work happened.', 'Purchase Orders section: open the PO for that vendor and check its scheduled date and status.', 'The vendor confirms a new date in writing and you log it as a WO note.'],
      stall: ['A vendor has gone quiet past the scheduled visit and chasing has not moved it.', 'Purchase Orders section for the vendor, then the Notes tab for your chase history.', 'Either the vendor commits to a date, or the job is reassigned / escalated.'],
      escalate: ['This is past what routine chasing fixes - ownership moves up, it is not another chase.', 'Post the escalation as a WO note so it is attributed to you and visible to the next person.', 'The named tier (supervisor / management) has the job and the note records the handoff.'],
      docs: ['The completion package is missing - a WO should not close without its proof of work.', 'Documents tab on this work order.', 'Signed ticket, sign-in/out, and before/after photos are attached.'],
      advance: ['Everything needed to close this WO is on file - it just has not been marked Work Complete yet.', 'The status field in the WO header - advance it to Work Complete.', 'The WO is marked Work Complete and can move to billing.'],
      intake: ['The WO is missing fields it needs before it can be scoped, priced, or dispatched.', 'The header fields at the top of this work order (NTE, priority, site, trade).', 'Every required field is filled in, so the job can be assigned cleanly.'],
      task: ['An Umbrava task on this WO is open or overdue.', 'The Open Tasks block on this work order.', 'The task is completed in Umbrava, not just noted.'],
      dne: ['Gross profit is under target for this job - the cost side needs a decision.', 'Compare the Client DNE against the PO totals in the Purchase Orders section.', 'Either the cost comes down, the DNE is increased with client approval, or management accepts the write-down.'],
      ecd: ['The expected completion date is missing or already past.', 'The Expected Completion Date field in the WO header - the "Set ECD..." button proposes one.', 'A realistic date is set and the client has been told.'],
      pocost: ['A PO is done working but its final cost is not locked yet.', 'Purchase Orders section: open that PO and confirm the final amount.', 'The final cost is confirmed so the WO can move to billing.'],
      poacc: ['A vendor has not accepted the PO you issued, so nobody is committed to the work.', 'Purchase Orders section: the PO shows Pending Acceptance.', 'The vendor accepts with a scheduled date, or declines so you can reassign.'],
      pomat: ['Work is waiting on materials for this PO.', 'Purchase Orders section: the PO shows a materials status.', 'You have the supplier, delivery date, and tracking, plus the return-visit date.'],
      poconf: ['A vendor marked work complete and the completion package needs collecting.', 'Purchase Orders section: the PO shows Confirm Complete.', 'Documents are attached and the PO is confirmed.'],
      eta: ['There is no credible ETA on record for the next step.', 'Notes tab - look for the last vendor commitment.', 'A specific date from the vendor is logged as a WO note.'],
      phase: ['The WO status itself is what needs to move - the job is sitting in this state.', 'The status field in the WO header, plus whatever that status is waiting on.', 'The status advances to the next real state.'],
      clientcad: ['The client has not had an update in longer than this job priority allows.', 'Notes tab: post a Client-typed note (the "Actioned..." button types it for you).', 'A client-facing note is posted, which resets the cadence automatically.'],
      note: ['This WO has gone quiet - no notes for long enough that nobody can tell what is happening.', 'Notes tab on this work order.', 'Any real note is posted describing the current state.'],
      authored: ['A step somebody wrote for this job by hand (a Next Actions note, or the dashboard case file).', 'Wherever the item says - it is a written instruction, not a generated step.', 'The item is done and you log it, or you uncheck it if it no longer applies.']
    };
    var ACT_HELP_PFX = ['What it means: ', 'Where: ', 'Done when: '];
    function actHelp(a) {
      if (!a || a.anchor) return null;   // the anchor explains itself in its own why line
      return ACT_HELP[a.authored ? 'authored' : (a.key || '').split(':')[0]] || null;
    }
    var actHelpOpen = {};   // key -> 1 while its help block is expanded (render state only)

    function renderActsInline(state) {
      var card = document.getElementById(ACT_CARD_ID);
      var acts = nextActions(state);
      var row = actsAnchorBlock();
      if (!acts.length || !row) { if (card) card.remove(); return; }
      ensureWAStyle();
      // PO-key store migration runs BEFORE anything reads or writes the store this
      // page-load (autoDetectActioned loads it next line-ish) - see actsMigratePO.
      if (actsMigratedPOFor !== actsKey()) {
        actsMigratedPOFor = actsKey();
        var mig0 = actsMigratePO(actsLoad(), state.pos);
        if (mig0) actsSave(mig0);
      }
      autoDetectActioned(acts, state);
      var store = actsLoad();
      // Open steps first (already worst-first from nextActions), done steps sink to the
      // bottom - a stable partition, so the urgency order is preserved within each group.
      acts = acts.filter(function (a) { return !(store[a.key] && store[a.key].done); }).concat(acts.filter(function (a) { return store[a.key] && store[a.key].done; }));
      var open = acts.filter(function (a) { return !(store[a.key] && store[a.key].done); }).length;
      // "Real" open = open steps excluding the completion anchor. The anchor is never
      // "done", so it keeps `open` ≥ 1 on any non-terminal WO; realOpen tells us whether
      // there is actual work left vs. just the "advance the status" gate.
      var realOpen = acts.filter(function (a) { return !a.anchor && !(store[a.key] && store[a.key].done); }).length;
      var collapsed = false;
      try { collapsed = localStorage.getItem('bwn:acts:collapsed') === '1'; } catch (e) { }
      // Live escalation state (render-layer only; see waEscState). Part of the signature
      // so the strip appears, flips and clears the moment the assist script publishes.
      var escSt = null;
      try { escSt = waEscState(); } catch (e) { }
      // Signature gate: rebuild only when content or placement actually changed, so
      // the steady-state refresh loop never re-renders the card under the cursor.
      var sig = JSON.stringify([collapsed, escSt ? escSt.status + '|' + escSt.id + '|' + (escSt.ackAt || '') : '', acts.map(function (a) {
        var r = store[a.key];
        // Phase 2 additions to the signature: a tool button appearing when its registrant
        // comes online (or vanishing when it drops) and a help block toggling are both
        // real content changes - without them the gate would hold a stale card.
        var tl = actTool(a);
        return a.key + '|' + a.label + '|' + (r && r.done ? 1 : 0) + '|' + ((r && r.note) || '') + '|' + (a.nudge || 0) + '|' + ((r && r.reason) || '') +
          '|' + (tl ? tl.docks.filter(waDockAlive).join(',') : '') + '|' + (actHelpOpen[a.key] ? 1 : 0);
      })]);
      if (card && card.isConnected && card.nextElementSibling === row && card.dataset.sig === sig) return;
      if (card) card.remove();
      card = document.createElement('div');
      card.id = ACT_CARD_ID;
      card.className = 'bwn-actc';
      card.dataset.sig = sig;

      var hd = document.createElement('div'); hd.className = 'bwn-actc-hd';
      hd.setAttribute('role', 'button'); hd.tabIndex = 0;
      hd.title = collapsed ? 'Expand the checklist' : 'Collapse to one line';
      var ht = document.createElement('span'); ht.className = 'bwn-actc-t'; ht.textContent = 'NEXT ACTIONS';
      var hc = document.createElement('span'); hc.className = 'bwn-actc-n' + (realOpen ? '' : (open ? ' anchor' : ' ok'));
      // realOpen===0 but the anchor keeps open≥1: no actionable steps remain, but the WO
      // is NOT complete (that's only terminal, which shows no card). Phase-neutral wording -
      // the anchor row carries the "not complete until Work Complete/Invoiced/Paid" message,
      // so this must NOT imply the job is ready to close (it can be mid-lifecycle).
      hc.textContent = realOpen ? realOpen + ' open' : (open ? 'no open steps' : 'all done ✓');
      var hs = document.createElement('span'); hs.className = 'bwn-actc-s';
      // Phase 1: the card is a MERGE now, so claiming one source for the whole list would
      // mislabel live generated steps as plan items - the exact confusion the merge exists
      // to fix. A single source is stated only when every step came from the plan; a mixed
      // card counts each side, and per-row `why` tags carry the individual sources.
      var nAuth = 0, nGen = 0;
      acts.forEach(function (a) { if (a.authored) nAuth++; else if (!a.anchor) nGen++; });
      var planSrcLbl = acts.some(function (a) { return a.authored && String(a.planRef || '').indexOf('dash') === 0; })
        ? 'the dashboard case file' : 'your Next Actions Required note';
      hs.textContent = !nAuth ? 'chase → do it → log it as a WO note'
        : (nGen ? nAuth + ' from ' + planSrcLbl + ' · ' + nGen + ' from the playbook' : 'from ' + planSrcLbl);
      var hx = document.createElement('span'); hx.className = 'bwn-actc-x'; hx.textContent = collapsed ? '▸' : '▾';
      hd.appendChild(ht); hd.appendChild(hc); hd.appendChild(hs); hd.appendChild(hx);
      function toggleCollapse() {
        try { localStorage.setItem('bwn:acts:collapsed', collapsed ? '' : '1'); } catch (e) { }
        renderActsInline(state);
      }
      hd.addEventListener('click', toggleCollapse);
      hd.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(); } });
      card.appendChild(hd);

      // The round-trip strip: "Escalated - awaiting mgmt" while the queue holds an
      // ACTIVE item for this WO. Deliberately outside the collapsed gate - an open
      // escalation is exactly what a one-line glance is for.
      if (escSt) {
        var esb = document.createElement('div');
        esb.className = 'bwn-act-esc';
        esb.textContent = '🚩 ' + waEscStripText(escSt);
        esb.title = 'Live from the assist queue' + (escSt.requester ? ' · requested by ' + escSt.requester : '') + (escSt.reason ? ' · ' + escSt.reason : '') + ' · acknowledge or resolve from the Escalate drawer or the dashboard';
        card.appendChild(esb);
      }

      if (!collapsed) {
        var body = document.createElement('div'); body.className = 'bwn-actc-body';
        acts.forEach(function (a) {
          if (a.anchor) {
            // Uncheckable completion gate - a flag + label, no checkbox/buttons. It sits
            // at the bottom of the open group and can only clear by the status advancing.
            var ra = document.createElement('div'); ra.className = 'bwn-act-row bwn-act-anchor';
            var mka = document.createElement('div'); mka.className = 'bwn-act-anchor-mk'; mka.textContent = '⚑';
            var maa = document.createElement('div'); maa.className = 'bwn-act-main';
            var lba = document.createElement('div'); lba.className = 'bwn-act-lbl'; lba.textContent = a.label;
            var wya = document.createElement('div'); wya.className = 'bwn-act-why'; wya.textContent = a.why;
            maa.appendChild(lba); maa.appendChild(wya);
            ra.appendChild(mka); ra.appendChild(maa); body.appendChild(ra);
            return;
          }
          var rec = store[a.key];
          var isDone = !!(rec && rec.done);
          var r = document.createElement('div'); r.className = 'bwn-act-row' + (a.nudge && !isDone ? ' nudge' : '');
          var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isDone;
          cb.setAttribute('aria-label', a.label);
          cb.title = isDone ? 'Uncheck to reopen' : 'Mark done without posting a note';
          cb.addEventListener('change', function () {
            if (cb.checked) { actsMarkDone(a, ''); renderActsInline(state); return; }
            // Unchecking: three cases.
            //  1. Correcting a wrong AUTO-check → frictionless (never punish fixing the machine).
            //  2. Dismissing a CRITICAL step → a reason is REQUIRED; it becomes a WO note
            //     (manual save = Umbrava attribution) and rides to the activity log.
            //     Empty/cancelled reason = NOT dismissed - the box stays checked.
            //  3. Anything else → plain reopen, counted in the usage stats.
            var rec2 = actsLoad()[a.key];
            if (rec2 && rec2.done && rec2.auto) { actsMarkUndone(a, '', true); renderActsInline(state); return; }
            // Undo grace: a bare manual check (no note typed) unchecked within 2 minutes
            // is a misclick correction, not a dismissal - frictionless and NOT a skip.
            // Without this, Cancel leaves a live critical step falsely "done" and the only
            // exit fabricates a dismissal + a skip stat for fixing a fat-finger (review).
            if (rec2 && rec2.done && !rec2.note && rec2.ts && Date.now() - rec2.ts < 120000) { actsMarkUndone(a, '', true); renderActsInline(state); return; }
            if (actIsCritical(a)) {
              var why2 = prompt('"' + a.label + '" is a critical step.\nWhy is it being dismissed? (required - this becomes the WO note)', '');
              if (why2 === null || !why2.trim()) { cb.checked = true; return; }   // not dismissed
              actsMarkUndone(a, why2.trim());
              var disNote = 'Dismissed step: ' + a.label + ' - ' + why2.trim();
              try { navigator.clipboard.writeText(disNote).catch(function () { }); } catch (e2) { }
              renderActsInline(state);
              insertWONote(disNote, function () { /* posted manually by the coordinator */ });
              return;
            }
            actsMarkUndone(a, '');
            renderActsInline(state);
          });
          var main = document.createElement('div'); main.className = 'bwn-act-main';
          var lbl = document.createElement('div'); lbl.className = 'bwn-act-lbl' + (isDone ? ' done' : '');
          lbl.textContent = a.label;
          // Phase 2 navigation: the label walks the page to the thing the step is about,
          // but only where a proven target exists (actNav). Elsewhere it stays plain text.
          var nav = actNav(a);
          if (nav) {
            lbl.className += ' nav';
            lbl.setAttribute('role', 'button'); lbl.tabIndex = 0;
            lbl.title = 'Show this on the page';
            lbl.addEventListener('click', function () { actNavGo(nav); });
            lbl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); actNavGo(nav); } });
          }
          // Phase 2 training layer: "?" opens three static lines explaining the step.
          var helpTxt = actHelp(a);
          if (helpTxt) {
            var ht = document.createElement('button');
            ht.type = 'button'; ht.className = 'bwn-act-help-t'; ht.textContent = '?';
            ht.title = 'What this step means, where to do it, and what done looks like';
            ht.setAttribute('aria-expanded', actHelpOpen[a.key] ? 'true' : 'false');
            ht.addEventListener('click', function (ev) {
              ev.stopPropagation();   // the label may itself be a nav control
              if (actHelpOpen[a.key]) delete actHelpOpen[a.key]; else actHelpOpen[a.key] = 1;
              renderActsInline(state);
            });
            lbl.appendChild(ht);
          }
          var why = document.createElement('div'); why.className = 'bwn-act-why'; why.textContent = a.why;
          main.appendChild(lbl); main.appendChild(why);
          if (helpTxt && actHelpOpen[a.key]) {
            var hbx = document.createElement('div'); hbx.className = 'bwn-act-help';
            for (var hi = 0; hi < ACT_HELP_PFX.length; hi++) {
              var hln = document.createElement('div');
              hln.textContent = ACT_HELP_PFX[hi] + helpTxt[hi];
              hbx.appendChild(hln);
            }
            main.appendChild(hbx);
          }
          // A dismissed-with-reason step stays OPEN and shows its logged reason - the
          // dismissal is visible and reversible, never a silent deletion.
          if (!isDone && rec && rec.dismissed && rec.reason) {
            var dis = document.createElement('div'); dis.className = 'bwn-act-dis';
            var dd = new Date(rec.dismissed);
            dis.textContent = '✗ dismissed ' + (dd.getMonth() + 1) + '/' + dd.getDate() + ': ' + rec.reason;
            main.appendChild(dis);
          }
          if (isDone && rec.note) {
            var lg = document.createElement('div'); lg.className = 'bwn-act-log';
            var d = new Date(rec.ts || Date.now());
            lg.textContent = '✓ ' + (d.getMonth() + 1) + '/' + d.getDate() + ' - ' + rec.note;
            main.appendChild(lg);
          }
          var btns = document.createElement('div'); btns.className = 'bwn-act-btns';
          armAssistDue(a, isDone);
          // Phase 2 tool launch - rendered only while the owning dock registrant is live,
          // so this is never a dead control. The click is the same bwn:dock:open the rail
          // itself emits, so the tool opens exactly as if launched from the dock. A step
          // can map to more than one tool (recruit = Dispatch OR Email RFP); each button
          // gates on its OWN registrant, so only installed-and-live tools render.
          var tool = actTool(a);
          if (tool && !isDone) {
            tool.docks.forEach(function (dk) {
              if (!waDockAlive(dk)) return;
              var tb = document.createElement('button');
              tb.type = 'button'; tb.className = 'bwn-wa-btn ghost'; tb.textContent = waEscToolLabel(dk, escSt);
              tb.style.cssText = 'padding:3px 9px;font-size:10px;';
              tb.title = (dk === 'assist' && escSt)
                ? 'An escalation is already open on this work order - view, acknowledge or resolve it'
                : 'Open the ' + (ACT_TOOL_LABEL[dk] || 'tool').replace(/…$/, '') + ' drawer for this work order';
              tb.addEventListener('click', function () {
                try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:dock:open', key: dk } })); } catch (e) { }
              });
              btns.appendChild(tb);
            });
          }
          if (a.text) {
            var cp = document.createElement('button');
            cp.type = 'button'; cp.className = 'bwn-wa-btn ghost'; cp.textContent = 'Chase';
            cp.style.cssText = 'padding:3px 9px;font-size:10px;';
            cp.title = a.text;
            cp.addEventListener('click', function () {
              navigator.clipboard.writeText(a.text).then(function () {
                cp.textContent = 'Copied ✓';
                setTimeout(function () { cp.textContent = 'Chase'; }, 1500);
              }, function () { prompt('Copy manually:', a.text); });
            });
            btns.appendChild(cp);
          }
          var ab = document.createElement('button');
          ab.type = 'button'; ab.className = 'bwn-wa-btn primary'; ab.textContent = isDone ? 'Re-log' : 'Actioned…';
          ab.style.cssText = 'padding:3px 9px;font-size:10px;';
          ab.title = 'Log what you did - prefills a WO note for you to review and post';
          ab.addEventListener('click', function () {
            var typed = prompt('What did you do? (one line - becomes the WO note)\n\n' + a.label, '');
            if (typed === null) return;
            var noteText = a.label + (typed.trim() ? ' - ' + typed.trim() : '');
            actsMarkDone(a, typed.trim());
            renderActsInline(state);
            // Silent clipboard backup first: some rich editors re-render from their own
            // state and swallow programmatic text - paste is then the instant recovery.
            try { navigator.clipboard.writeText(noteText).catch(function () { }); } catch (e) { }
            // ECD-related actions log an internal audit note - default the type to Internal.
            // The client-cadence step IS a client-facing update - default it to Client so the
            // posted note both reads correctly AND resets lastClientNoteDays (self-converges).
            var actNoteType = (a.openEcd || /^ecd/.test(a.key || '')) ? 'Internal'
              : /^clientcad/.test(a.key || '') ? 'Client' : undefined;
            insertWONote(noteText, function () { /* posted manually by the coordinator */ }, actNoteType);
          });
          btns.appendChild(ab);
          if (a.openEcd) {
            var eb = document.createElement('button');
            eb.type = 'button'; eb.className = 'bwn-wa-btn ghost'; eb.textContent = 'Set ECD…';
            eb.style.cssText = 'padding:3px 9px;font-size:10px;';
            eb.title = 'Propose + set the expected completion date, and draft the client note';
            eb.addEventListener('click', function () { ecdHelperOpen(state); });
            btns.appendChild(eb);
          }
          r.appendChild(cb); r.appendChild(main); r.appendChild(btns);
          body.appendChild(r);
        });
        var meta = document.createElement('div'); meta.className = 'bwn-wa-meta';
        meta.textContent = 'Auto-updates with the WO - steps clear when the job state resolves them or a note logs them; the posted note is the real record.';
        body.appendChild(meta);
        card.appendChild(body);
      }

      row.parentNode.insertBefore(card, row);
    }

    // ---- ECD helper: propose + set the expected-completion date ---------------
    // When a WO has no expected-completion date (or it's overdue), propose one from
    // the best available signal - the latest FUTURE PO scheduled date, else a noted
    // ETA (same ETA-word+date heuristic etaStatus uses), else the 2nd upcoming
    // Friday - and let the coordinator confirm + capture the reason. On Apply it
    // TYPES the date into the WO's own field (never clicks a separate Save - Umbrava
    // persists per its normal flow) and prefills a client-facing note for manual
    // posting. (Scheduled-trip reading is a future add, pending a Trips-tab recon.)
    var ECD_FIELD = 'work-order-expected-completion-date-picker';
    function ecdToday() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    function ecdSecondFriday() { var d = new Date(); d.setHours(0, 0, 0, 0); var add = (5 - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add + 7); return d; }   // upcoming Friday + 1 week
    function ecdFmtUS(dt) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(dt.getMonth() + 1) + '/' + p(dt.getDate()) + '/' + dt.getFullYear(); }   // MM/DD/YYYY - mask-safe for the picker
    function ecdFmtISO(dt) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()); }
    function ecdFieldInput() { var el = document.querySelector('[data-testid="' + ECD_FIELD + '"]'); if (!el) return null; return el.tagName === 'INPUT' ? el : el.querySelector('input'); }
    // CFG.ETA_WORDS is the watchdog's vocabulary and it is about a vendor ARRIVING. A
    // completion promise is written in different words - "ECD 8/20", "complete by 8/20",
    // "done by Friday" - and those notes are precisely what a coordinator means when they
    // say the date is in the notes. Superset, used ONLY by the ECD proposer, so the
    // watchdog's own judgement is untouched. Deliberately NOT bare "complete"/"completed":
    // "work completed 7/15" is a past-tense record, not a promise.
    var ECD_NOTE_WORDS = /\becd\b|\bcomplet(?:e|ed|ion)\s+(?:by|date)\b|\bfinish(?:ed)?\s+by\b|\bdone\s+by\b/i;
    function latestNotedEta(state) {
      var notes = getNotes(), today = ecdToday(), best = null;
      for (var i = 0; i < notes.length; i++) {
        var b = notes[i].body || '';
        if (!((CFG.ETA_WORDS.test(b) || ECD_NOTE_WORDS.test(b)) && CFG.DATE_RE.test(b))) continue;
        // parseBodyDate (NOT the note-timestamp parser): scans ALL dates in the body,
        // takes the latest, and resolves a yearless "7/15" FORWARD relative to the
        // note - an ETA is a future promise, so bare M/D must look forward, not back.
        // API notes carry an exact epoch (tsAbs); scraped ones only a rendered string.
        var when = (notes[i].tsAbs != null) ? notes[i].tsAbs : parseNoteDate(notes[i].ts);
        var dm = parseBodyDate(b, when);
        if (dm === null || dm < today) continue;   // forward-looking ETAs only - a blown promise isn't a completion date
        // The note written LAST is the promise that stands. Ranking by furthest-future
        // date instead was harmless while this only ever saw the handful of notes the
        // virtualized list had mounted; against a 300-note history it lets one stale
        // over-promise from months ago outrank today's revision.
        var w = (when != null) ? when : 0;
        if (!best || w > best.when || (w === best.when && dm > best.date)) best = { date: dm, ts: notes[i].ts, when: w };
      }
      return best;
    }
    function proposeECD(state) {
      var today = ecdToday(), poCand = null;
      state.pos.forEach(function (p) {
        if (p.done || !(p.amount > 0) || !p.schedDate) return;
        var d = parseUSDate(p.schedDate);
        if (d && d >= today && (!poCand || d > poCand.d)) poCand = { d: d, raw: p.schedDate, vendor: p.vendor };
      });
      var eta = latestNotedEta(state);
      // What the note read actually saw, so the dialog can SAY it instead of the
      // coordinator having to trust that "no noted ETA" means the notes were read.
      var notes = getNotes();
      var srcLabel = { api: 'full note history, read from the API', deep: 'full note history, from a Deep Scan', cache: 'full note history, from the suite cache', view: 'ONLY the notes rendered on screen - the API read did not land' }[lastNotesSrc] || lastNotesSrc;
      var meta = { noteCount: notes.length, noteSrc: lastNotesSrc, noteSrcLabel: srcLabel };
      // Scheduled trip signal (cached to the bus by tripCal when the Trips tab was viewed).
      var trip = null;
      try { var tb = BWN.ssGetJSON('bwn:trips:' + currentWOId(), null); if (tb && tb.latestScheduled && tb.latestScheduled >= today) trip = tb.latestScheduled; } catch (e) { }
      var cands = [];
      if (trip) cands.push({ ms: trip, why: 'latest scheduled trip (from the Trips tab)' });
      if (poCand) cands.push({ ms: poCand.d, why: 'PO scheduled ' + poCand.raw + ' (' + poCand.vendor + ')' });
      if (eta) cands.push({ ms: eta.date, why: 'the completion date in the latest note that gives one' + (eta.ts ? ' (' + eta.ts + ')' : '') });
      if (cands.length) { cands.sort(function (a, b) { return b.ms - a.ms; }); return { date: new Date(cands[0].ms), from: 'signal', why: cands[0].why, noteCount: meta.noteCount, noteSrc: meta.noteSrc, noteSrcLabel: meta.noteSrcLabel }; }   // latest of trip/PO/ETA = complete-by ≥ last scheduled work
      return { date: ecdSecondFriday(), from: 'default', why: 'no scheduled trip, PO date, or noted completion date - defaulted to the 2nd upcoming Friday', noteCount: meta.noteCount, noteSrc: meta.noteSrc, noteSrcLabel: meta.noteSrcLabel };
    }
    // True when the WO already carries the ETA info the helper would ask for - used
    // to SUPPRESS the auto-pop (don't nag when a PO date or a noted ETA is on file).
    function ecdHasEtaSignal(state) {
      if (state.pos.some(function (p) { return !p.done && p.amount > 0 && p.schedDate; })) return true;
      if (latestNotedEta(state)) return true;
      try { var tb = BWN.ssGetJSON('bwn:trips:' + currentWOId(), null); if (tb && tb.latestScheduled && tb.latestScheduled >= ecdToday()) return true; } catch (e) { }
      return false;
    }

    function ensureEcdStyle() {
      if (document.getElementById('bwn-ecd-style')) return;
      var st = document.createElement('style'); st.id = 'bwn-ecd-style';
      st.textContent =
        '#bwn-ecd-overlay{position:fixed;inset:0;z-index:100000;background:rgba(13,38,26,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-ecd{width:460px;max-width:94vw;background:var(--bwn-surface);border-radius:16px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.35);}' +
        '.bwn-ecd-hd{background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:14px 18px;font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-ecd-body{padding:14px 16px;}' +
        '.bwn-ecd-cur{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-bottom:6px;}' +
        '.bwn-ecd-basis{font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);margin-bottom:12px;}' +
        '.bwn-ecd-lbl{display:block;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin:8px 0 4px;}' +
        '.bwn-ecd-date,.bwn-ecd-reason{width:100%;box-sizing:border-box;border:1px solid var(--bwn-border);border-radius:8px;padding:8px 10px;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);background:var(--bwn-surface);}' +
        '.bwn-ecd-reason{resize:vertical;}' +
        '.bwn-ecd-ft{display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-ecd-ft .sp{margin-right:auto;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-ecd-ft button{border:1px solid var(--bwn-border);background:var(--bwn-surface-2);color:var(--bwn-text);border-radius:8px;padding:7px 14px;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;}' +
        '.bwn-ecd-ft button.pri{background:var(--bwn-green);border-color:var(--bwn-green);color:#fff;}' +
        '.bwn-ecd-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:100001;max-width:540px;background:var(--bwn-surface);color:var(--bwn-text);border:1px solid var(--bwn-border);border-left:4px solid var(--bwn-green);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.32);padding:12px 14px;font:500 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;display:flex;gap:10px;align-items:flex-start;}' +
        '.bwn-ecd-toast span{flex:1;line-height:1.4;}' +
        '.bwn-ecd-toast button{border:1px solid var(--bwn-green);background:var(--bwn-green);color:#fff;border-radius:7px;padding:6px 10px;font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;white-space:nowrap;}' +
        '.bwn-ecd-toast button.x{background:transparent;border:none;color:var(--bwn-text-faint);font-size:15px;padding:2px 4px;}' +
        // Attention ring on Umbrava's OWN Save button: the Complete-By date does not autosave,
        // so this is a data-loss guard, not decoration. That is why it is allowed to run longer
        // than the 300ms a transition gets, and why it pulses twice rather than once - the
        // coordinator may not be looking at a 60x30 button when it starts (animation review
        // 2026-08-10; was 1.2s x 4 = 4.8s of continuous repaint).
        //
        // The static outline is the real affordance and it stays for the full 5.5s the class is
        // on. The pulse only buys the first glance, so reduced motion drops the pulse and keeps
        // the outline: gentler, not gone.
        //
        // box-shadow is a paint property and the GPU rule says transform/opacity only. Kept
        // deliberately: the alternative is a ::after ring, which needs position:relative on a
        // VENDOR button and can move anything absolutely positioned inside it. Two 420ms passes
        // repainting one small button is the cheaper risk. Do not extend this pattern to
        // anything larger or more frequent.
        '@keyframes bwnEcdPulse{from{box-shadow:0 0 0 0 rgba(46,160,90,.75);}to{box-shadow:0 0 0 9px rgba(46,160,90,0);}}' +
        '.bwn-ecd-savepulse{animation:bwnEcdPulse .42s cubic-bezier(.23,1,.32,1) 2;outline:2px solid var(--bwn-green)!important;outline-offset:2px;border-radius:6px;}' +
        '@media (prefers-reduced-motion:reduce){.bwn-ecd-savepulse{animation:none;}}';
      document.head.appendChild(st);
    }

    // The WO header's Save (submit) button - persisting an edited Complete-By date
    // requires clicking it (Umbrava does NOT autosave the field on blur, verified
    // 2026-07-13). Scoped to the header wrapper; prefer the submit button, fall back
    // to text so a markup tweak can't blind it.
    function ecdSaveButton() {
      var scope = document.querySelector('[data-testid="work-order-header-wrapper"]') || document;
      var subs = scope.querySelectorAll('button[type="submit"]');
      for (var i = 0; i < subs.length; i++) { if (/^\s*save\s*$/i.test(subs[i].textContent || '')) return subs[i]; }
      var all = scope.querySelectorAll('button');
      for (var j = 0; j < all.length; j++) { if (/^\s*save\s*$/i.test(all[j].textContent || '')) return all[j]; }
      return null;
    }
    function ecdPulse(el) {
      try { el.classList.add('bwn-ecd-savepulse'); setTimeout(function () { try { el.classList.remove('bwn-ecd-savepulse'); } catch (e) { } }, 5500); } catch (e2) { }
    }
    // Dismissible, non-blocking toast (the module has no shared toast - the reminders
    // module's is out of scope). Optional Save button gets a "Show Save" jump.
    function ecdToast(msg, saveBtn) {
      // Routed through the unified BWN.toast (Task 2). Extra preserved: the "Show Save"
      // button that scrolls to + pulses the WO-header Save. id keeps it single-instance
      // (a follow-up toast replaces the prior one, as the old getElementById did).
      var opts = { id: 'ecd', timeout: 16000 };
      if (saveBtn) opts.action = { label: 'Show Save', onClick: function () { try { saveBtn.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { } ecdPulse(saveBtn); } };
      BWN.toast('success', msg, opts);
    }
    // Auto-persist (coordinator opted in 2026-07-13): Umbrava doesn't autosave the
    // Complete-By field on blur, so click the WO header Save ourselves. React marks the
    // header form dirty a tick after the write, so give it a moment then poll for the
    // Save button to enable. If it never does, fall back to pointing them at Save
    // (with pulse) so the filled date is never silently lost.
    function ecdFlagSave(usDT) {
      var tries = 0;
      function poll() {
        var save = ecdSaveButton();
        if (save && !save.disabled && save.offsetWidth > 0) {
          try { save.click(); ecdToast('Completion date saved: ' + usDT + '.', null); }
          catch (e) { ecdToast('Completion date filled: ' + usDT + ' - click “Save” in the WO header to persist it.', save); if (save) ecdPulse(save); }
          return;
        }
        if (++tries > 16) {   // ~4s: Save never enabled - hand it back to the coordinator
          ecdToast('Completion date filled: ' + usDT + ' - click “Save” in the WO header to persist it.' + (save ? '' : ' (Save button not found on this view.)'), save);
          if (save) ecdPulse(save);
          return;
        }
        setTimeout(poll, 250);
      }
      setTimeout(poll, 200);   // let React commit the write before reading Save's state
    }

    function ecdHelperOpen(state) {
      if (!onWO() || !currentWOId()) { alert('Open a work order to set its expected completion date.'); return; }
      fetchNotesApi(currentWOId());   // no-op if the engine already warmed it; arms the re-propose below otherwise
      ensureEcdStyle();
      var old = document.getElementById('bwn-ecd-overlay'); if (old) old.remove();
      var prop = proposeECD(state);
      var curRaw = inputVal(ECD_FIELD);
      var ov = document.createElement('div'); ov.id = 'bwn-ecd-overlay';
      var card = document.createElement('div'); card.className = 'bwn-ecd';
      var releaseA11y = null;
      function close() { document.removeEventListener('keydown', onKey); if (releaseA11y) { releaseA11y(); releaseA11y = null; } ov.remove(); }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

      var hd = document.createElement('div'); hd.className = 'bwn-ecd-hd'; hd.textContent = 'Set expected completion'; card.appendChild(hd);
      var body = document.createElement('div'); body.className = 'bwn-ecd-body';
      var cur = document.createElement('div'); cur.className = 'bwn-ecd-cur';
      cur.textContent = (curRaw && curRaw.trim()) ? ('Current ECD: ' + curRaw.trim() + (state.due && state.due.kind === 'bad' ? ' - overdue' : '')) : 'No expected completion date set.';
      body.appendChild(cur);
      // Say what the proposal was computed FROM. "No noted completion date" is only
      // worth anything if the coordinator can see that the notes were actually read -
      // before this fix the line would have said "0 notes" on every details-tab popup.
      var srcLine = document.createElement('div'); srcLine.className = 'bwn-ecd-cur';
      function paintSrc(p) { srcLine.textContent = p.noteCount + ' note' + (p.noteCount === 1 ? '' : 's') + ' read - ' + p.noteSrcLabel + '.'; }
      paintSrc(prop); body.appendChild(srcLine);
      var pr = document.createElement('div'); pr.className = 'bwn-ecd-basis'; pr.textContent = 'Proposed from: ' + prop.why; body.appendChild(pr);
      var dl = document.createElement('label'); dl.className = 'bwn-ecd-lbl'; dl.textContent = 'New expected completion date (time set to 11:59 PM)'; body.appendChild(dl);
      var di = document.createElement('input'); di.type = 'date'; di.className = 'bwn-ecd-date'; di.value = ecdFmtISO(prop.date); body.appendChild(di);
      var rl = document.createElement('label'); rl.className = 'bwn-ecd-lbl'; rl.textContent = 'Reason for the date (goes into the client note)'; body.appendChild(rl);
      var ri = document.createElement('textarea'); ri.className = 'bwn-ecd-reason'; ri.rows = 2;
      ri.placeholder = prop.from === 'default' ? 'e.g. awaiting vendor scheduling - targeting end of next week' : 'e.g. vendor scheduled; completion expected by this date';
      body.appendChild(ri);

      // Opened by hand (the "Set ECD…" button / core:ecd) while the note read is still in
      // flight: the proposal above came from whatever was mounted. Re-propose when the full
      // history lands - but NEVER over an edit the coordinator has already made, and never
      // into a dialog they have since closed. The auto-pop can't reach this path; it waits
      // for the read instead (maybeAutoECD).
      var ecdWoNum = currentWOId();
      if (notesReadState(ecdWoNum) === 'pending') {
        var touched = false;
        di.addEventListener('input', function () { touched = true; });
        ri.addEventListener('input', function () { touched = true; });
        notesOnRead(ecdWoNum, function () {
          if (touched || document.getElementById('bwn-ecd-overlay') !== ov || currentWOId() !== ecdWoNum) return;
          var p2 = proposeECD(state);
          di.value = ecdFmtISO(p2.date);
          pr.textContent = 'Proposed from: ' + p2.why;
          paintSrc(p2);
        });
      }
      card.appendChild(body);

      var ft = document.createElement('div'); ft.className = 'bwn-ecd-ft';
      var note = document.createElement('span'); note.className = 'sp'; note.textContent = 'Fills the date and saves it to the WO for you.'; ft.appendChild(note);
      var apply = document.createElement('button'); apply.type = 'button'; apply.className = 'pri'; apply.textContent = 'Apply + draft note';
      apply.addEventListener('click', function () {
        var iso = di.value; if (!iso) { alert('Pick a date.'); return; }
        var pp = iso.split('-'); var dt = new Date(parseInt(pp[0], 10), parseInt(pp[1], 10) - 1, parseInt(pp[2], 10));
        if (isNaN(dt.getTime())) { alert('That date is not valid.'); return; }
        // The Complete-By field is a DATETIME (e.g. "07/01/2026, 11:59 PM") - a bare
        // date is rejected. Always stamp 11:59 PM (end of the target day).
        var us = ecdFmtUS(dt), usDT = us + ', 11:59 PM';
        var f = ecdFieldInput();
        var wrote = false;
        if (f) { try { BWN.setNativeValue(f, usDT); f.dispatchEvent(new Event('blur', { bubbles: true })); wrote = true; } catch (e) { } }
        try { navigator.clipboard.writeText(usDT).catch(function () { }); } catch (e) { }   // backup if the picker rejects the typed value
        ingestPush('ecd-set', usDT);   // connector: log the ECD set (drained + POSTed by the AI script)
        var reason = ri.value.trim();
        var noteText = 'Expected completion date set to ' + usDT + '.' + (reason ? ' ' + reason : '') + (state.status ? ' Current status: ' + state.status + '.' : '');
        close();
        // Umbrava no longer persists the Complete-By field on blur - it needs the WO
        // header Save. Per the coordinator's choice we DON'T auto-submit; instead point
        // them straight at Save so the filled date can't silently revert (verified: a
        // write+blur without Save reverts on reload).
        if (wrote) ecdFlagSave(usDT); else ecdToast('Couldn’t find the Complete-By field to fill - set it manually in the WO header.', null);
        // ECD notes are internal audit records - label the composer's note type accordingly.
        insertWONote(noteText, function () { /* posted manually by the coordinator */ }, 'Internal');
      });
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', close);
      ft.appendChild(apply); ft.appendChild(cancel); card.appendChild(ft);

      ov.appendChild(card); document.body.appendChild(ov);
      document.addEventListener('keydown', onKey);
      releaseA11y = BWN.a11yDialog(card, { label: 'Set expected completion', modal: true });
    }

    // Auto-pop once per WO visit when the ECD is missing/overdue AND the info the
    // helper needs isn't already on the WO (no PO date, no noted ETA) - so it asks
    // exactly when the coordinator has to decide, and never nags otherwise.
    var ecdAutoShownFor = null;
    // Is an Umbrava-native modal open? BWN overlays use #bwn-* ids + custom styling, never
    // MUI's dialog classes, so this catches only Umbrava's own dialogs (Create WO / Create
    // Vendor / Build Requests / Edit Billing, etc.).
    function umbravaModalOpen() {
      var mods = document.querySelectorAll('.MuiModal-root, .MuiDialog-container');
      for (var i = 0; i < mods.length; i++) {
        var m = mods[i];
        if (m.id && /^bwn-/.test(m.id)) continue;
        var r = m.getBoundingClientRect ? m.getBoundingClientRect() : null;
        if ((r && r.width > 0 && r.height > 0) || m.offsetParent !== null) return true;
      }
      return false;
    }
    function maybeAutoECD(state) {
      var woId = currentWOId();
      if (!woId || ecdAutoShownFor === woId || document.getElementById('bwn-ecd-overlay')) return;
      if (!ecdFieldInput()) return;   // ECD field not mounted yet (hydration) - don't misjudge it as missing and burn the once-per-WO guard
      // Completed / invoiced / paid / closed = billing's, not the coordinator's - never
      // auto-prompt to reset the ECD (same terminal set as nextActions). This is a
      // SEPARATE trigger from the checklist, so it needs its own guard.
      var ecdPhase = WO_PHASE[(state.status || '').trim().toLowerCase()] || null;
      if (ecdPhase === 'terminal' || ecdPhase === 'costreview' || (!ecdPhase && /\b(closed|cancell?ed|declined|revoked|void)\b/i.test(state.status || ''))) return;   // + Clocked Out: Complete (work done → cost-review) → never auto-prompt the ECD
      var missingOrPast = !state.due || state.due.kind === 'bad';
      if (!missingOrPast) return;
      var hasActivePO = state.pos.some(function (p) { return !p.done && p.amount > 0; });
      if (!state.due && !hasActivePO) return;   // no ECD and no active work → nothing to target yet
      if (ecdHasEtaSignal(state)) return;        // ETA is on file → the ecd action + "Set ECD…" button cover it without a popup
      // Defer while an Umbrava modal is open (Create WO / Vendor / Build Requests, etc.): the
      // ECD overlay would sit on top and block it. Do NOT burn the once-per-WO guard - the
      // refresh loop re-checks, so the popup opens once the modal closes.
      if (umbravaModalOpen()) return;
      // Wait for the note read. Both questions this popup answers - "is a completion date
      // already promised somewhere?" (the suppressor above) and "what date should we
      // propose?" - are answered FROM the notes, and on this route there are none mounted
      // to read. Popping first would nag past a real ETA, propose the default Friday, and
      // burn the once-per-WO guard doing it. The guard is NOT burned here: the read calls
      // refresh() when it settles, and this re-runs with the real history. An errored read
      // falls through and behaves exactly as it did before.
      if (notesReadState(woId) === 'pending') return;
      ecdAutoShownFor = woId;
      ecdHelperOpen(state);
    }

    // ---- Status-change preflight (warn-only) ----------------------------------
    // When the WO status flips to a terminal one (Work Complete / Completed /
    // Invoiced / Closed …), a NON-blocking checklist banner appears listing the
    // closing gaps: stale notes, open POs, no photos in Documents, no invoice on
    // file. It can't block the save (Umbrava auto-commits the field), so it just
    // makes the miss visible - Leak-Guard philosophy. Photo/invoice counts come
    // from the bus, cached by cacheDocsInv when those tabs were last viewed.
    var PREFLIGHT_TERMINAL = /\b(work\s+complete|completed|confirm\s+complete|invoiced|closed)\b/i;
    // "Hit Complete" moves the WO into Work Complete - that specific transition gets the
    // billing-note prompt instead of the generic closing preflight (they'd otherwise
    // double up). Other terminal transitions (Invoiced / Closed / Confirm Complete) keep
    // the preflight.
    var BILL_TRIGGER = /\bwork\s*complete\b/i;
    var prevStatus = null, lastDocSig = '';
    function cacheDocsInv() {
      var woId = currentWOId(); if (!woId) return;
      var path = location.pathname;
      if (/\/documents/.test(path)) {
        if (!document.querySelector('[data-testid="File-table-header-cell"]')) return;   // table not rendered yet (hydration)
        // Recon fix: File-Cell-title is the COLUMN HEADER, not per-row. Documents are
        // the table-row-{uuid} rows; photos = the "Label" category cell == "Photo"
        // (Umbrava categorizes docs - reliable, unlike guessing by file extension).
        var rows = document.querySelectorAll('tbody tr[id^="table-row-"]');
        if (!rows.length) return;   // header present but rows not mounted yet
        var docs = rows.length, photos = 0;
        Array.prototype.forEach.call(rows, function (r) {
          var tds = r.querySelectorAll('td');
          for (var i = 0; i < tds.length; i++) { if (/^\s*(site\s+)?photos?\s*$/i.test(tds[i].textContent || '')) { photos++; break; } }
        });
        var sig = 'd:' + woId + ':' + docs + ':' + photos;
        if (sig !== lastDocSig) { lastDocSig = sig; BWN.ssSetJSON('bwn:docs:' + woId, { v: 1, ts: Date.now(), docs: docs, photos: photos }); }
      } else if (/\/billing/.test(path)) {
        if (!document.querySelector('[data-testid="#-table-header-cell"]')) return;
        var n = document.querySelectorAll('[data-testid="#-Cell-title"]').length;
        var sig2 = 'i:' + woId + ':' + n;
        if (sig2 !== lastDocSig) { lastDocSig = sig2; BWN.ssSetJSON('bwn:inv:' + woId, { v: 1, ts: Date.now(), invoices: n }); }
      }
    }
    function preflightItems(state) {
      var woId = currentWOId(), items = [];
      if (state.staleDays !== null) items.push({ ok: state.staleDays <= state.cfg.noteStaleDays, t: 'Newest note ' + state.staleDays + 'd old' });
      else items.push({ ok: false, t: 'No dated notes found' });
      var openPO = state.pos.filter(function (p) { return !p.done && p.amount > 0; }).length;
      items.push({ ok: openPO === 0, t: openPO ? openPO + ' PO' + (openPO === 1 ? '' : 's') + ' not marked complete' : 'All POs marked complete' });
      var docs = null, inv = null;
      try { docs = BWN.ssGetJSON('bwn:docs:' + woId, null); } catch (e) { }
      try { inv = BWN.ssGetJSON('bwn:inv:' + woId, null); } catch (e) { }
      if (docs) { if (!docs.docs) items.push({ ok: false, t: 'No documents uploaded' }); else if (!docs.photos) items.push({ ok: false, t: 'No photo/image in Documents (' + docs.docs + ' file' + (docs.docs === 1 ? '' : 's') + ')' }); else items.push({ ok: true, t: docs.photos + ' photo' + (docs.photos === 1 ? '' : 's') + ' in Documents' }); }
      else items.push({ ok: null, t: 'Documents not checked this session - open the Documents tab' });
      if (inv) items.push({ ok: inv.invoices > 0, t: inv.invoices > 0 ? inv.invoices + ' invoice' + (inv.invoices === 1 ? '' : 's') + ' on file' : 'No invoice on file' });
      else items.push({ ok: null, t: 'Invoices not checked this session - open the Invoices tab' });
      return items;
    }
    function ensurePfStyle() {
      if (document.getElementById('bwn-pf-style')) return;
      var st = document.createElement('style'); st.id = 'bwn-pf-style';
      st.textContent =
        '#bwn-pf-banner{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100001;width:470px;max-width:92vw;background:var(--bwn-surface);border:1px solid var(--bwn-border);border-left:4px solid var(--bwn-warn);border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.34);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;overflow:hidden;}' +
        '#bwn-pf-banner .h{background:var(--bwn-warn);color:#fff;padding:9px 14px;font:500 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;display:flex;align-items:center;gap:8px;}' +
        '#bwn-pf-banner .h .x{margin-left:auto;cursor:pointer;font:500 16px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;background:none;border:none;color:#fff;line-height:1;}' +
        '#bwn-pf-banner .body{padding:8px 14px 4px;}' +
        '.bwn-pf-row{display:flex;gap:8px;align-items:flex-start;font:500 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);padding:4px 0;}' +
        '.bwn-pf-row .mk{flex:none;width:15px;text-align:center;font-weight:500;}' +
        '.bwn-pf-row.ok .mk{color:var(--bwn-green);}' +
        '.bwn-pf-row.bad .mk{color:var(--bwn-bad);}' +
        '.bwn-pf-row.na{color:var(--bwn-text-faint);}' +
        '.bwn-pf-row.na .mk{color:var(--bwn-text-faint);}' +
        '#bwn-pf-banner .ft{padding:8px 14px 12px;display:flex;gap:8px;}' +
        '#bwn-pf-banner .ft button{border:1px solid var(--bwn-border);background:var(--bwn-surface-2);color:var(--bwn-text);border-radius:8px;padding:6px 13px;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;}';
      document.head.appendChild(st);
    }
    function showPreflight(state) {
      ensurePfStyle();
      var old = document.getElementById('bwn-pf-banner'); if (old) old.remove();
      var bn = document.createElement('div'); bn.id = 'bwn-pf-banner'; bn.setAttribute('role', 'status');
      function close() { bn.remove(); }
      var h = document.createElement('div'); h.className = 'h';
      var ht = document.createElement('span'); ht.textContent = '⚠ Closing to “' + (state.status || 'terminal') + '” - before it’s final:';
      var x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.title = 'Dismiss'; x.addEventListener('click', close);
      h.appendChild(ht); h.appendChild(x); bn.appendChild(h);
      var body = document.createElement('div'); body.className = 'body';
      preflightItems(state).forEach(function (it) {
        var r = document.createElement('div'); r.className = 'bwn-pf-row ' + (it.ok === true ? 'ok' : it.ok === false ? 'bad' : 'na');
        var mk = document.createElement('span'); mk.className = 'mk'; mk.textContent = it.ok === true ? '✓' : it.ok === false ? '!' : '·';
        var tx = document.createElement('span'); tx.textContent = it.t;
        r.appendChild(mk); r.appendChild(tx); body.appendChild(r);
      });
      bn.appendChild(body);
      var ft = document.createElement('div'); ft.className = 'ft';
      var okb = document.createElement('button'); okb.type = 'button'; okb.textContent = 'Got it'; okb.addEventListener('click', close);
      ft.appendChild(okb); bn.appendChild(ft);
      document.body.appendChild(bn);
    }
    // The status field is a typeable MUI autocomplete - its .value reflects filter
    // KEYSTROKES, not just the committed pick (review MAJOR). Suppress the preflight
    // while it's being edited, and - critically - do NOT advance prevStatus then, so
    // a transient typed "completed" can't (a) fire the banner or (b) poison the
    // baseline for the real committed change.
    function statusBeingEdited() {
      var el = document.querySelector('[data-testid="statusId-autocomplete-input"]');
      if (!el) return false;
      if (document.activeElement === el) return true;
      if (el.getAttribute('aria-expanded') === 'true') return true;
      var cb = el.closest && el.closest('[role="combobox"]');
      return !!(cb && cb.getAttribute('aria-expanded') === 'true');
    }
    // Billing-note prompt - fires when the WO transitions INTO Work Complete ("hit
    // Complete"). Advises that a billing note will be added and offers the two standard
    // instructions; the pick drafts a WO note (manual save, per Umbrava attribution).
    // Reuses the ECD dialog's styling.
    function billingPromptOpen(state) {
      if (!onWO() || !currentWOId()) return;
      ensureEcdStyle();
      var old = document.getElementById('bwn-ecd-overlay'); if (old) old.remove();
      var ov = document.createElement('div'); ov.id = 'bwn-ecd-overlay';
      var card = document.createElement('div'); card.className = 'bwn-ecd';
      var releaseA11y = null;
      function close() { document.removeEventListener('keydown', onKey); if (releaseA11y) { releaseA11y(); releaseA11y = null; } ov.remove(); }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
      var hd = document.createElement('div'); hd.className = 'bwn-ecd-hd'; hd.textContent = 'Completing - add a billing note'; card.appendChild(hd);
      var body = document.createElement('div'); body.className = 'bwn-ecd-body';
      var p = document.createElement('div'); p.className = 'bwn-ecd-basis';
      p.textContent = 'This WO is being completed. Tell billing how to invoice - pick one and it drafts the note for you to review and post.';
      body.appendChild(p);
      function draft(kind) {
        var noteText = kind === 'approved' ? 'Bill per approved proposal.' : 'Bill per open proposal.';
        close();
        try { navigator.clipboard.writeText(noteText).catch(function () { }); } catch (e) { }
        insertWONote(noteText, function () { /* posted manually by the coordinator */ });
      }
      var wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:4px;';
      var b1 = document.createElement('button'); b1.type = 'button'; b1.className = 'bwn-wa-btn primary'; b1.textContent = 'Bill per approved proposal'; b1.style.cssText = 'padding:11px;font-size:13px;'; b1.addEventListener('click', function () { draft('approved'); });
      var b2 = document.createElement('button'); b2.type = 'button'; b2.className = 'bwn-wa-btn ghost'; b2.textContent = 'Bill per open proposal'; b2.style.cssText = 'padding:11px;font-size:13px;'; b2.addEventListener('click', function () { draft('open'); });
      wrap.appendChild(b1); wrap.appendChild(b2); body.appendChild(wrap);
      card.appendChild(body);
      var ft = document.createElement('div'); ft.className = 'bwn-ecd-ft';
      var note = document.createElement('span'); note.className = 'sp'; note.textContent = 'Drafts a WO note - save stays in Umbrava.'; ft.appendChild(note);
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Not now'; cancel.addEventListener('click', close);
      ft.appendChild(cancel); card.appendChild(ft);
      ov.appendChild(card); document.body.appendChild(ov);
      document.addEventListener('keydown', onKey);
      releaseA11y = BWN.a11yDialog(card, { label: 'Add a billing note', modal: true });
    }
    function maybePreflight(state) {
      if (statusBeingEdited()) return;                                          // wait for a committed selection
      var s = state.status || '', was = prevStatus;
      prevStatus = s;
      if (was === null || was === s) return;                                    // first sight this WO / no change
      if (BILL_TRIGGER.test(s) && !BILL_TRIGGER.test(was)) { billingPromptOpen(state); return; }   // → Work Complete owns this transition; generic preflight stands down
      if (!PREFLIGHT_TERMINAL.test(s) || PREFLIGHT_TERMINAL.test(was)) return;   // only a transition INTO terminal from a non-terminal status
      showPreflight(state);
    }

    function openPanel() {
      var old = document.getElementById(PANEL_ID);
      if (old) { old.remove(); return; }
      ensureWAStyle();
      var state = compute();

      var wrap = document.createElement('div');
      wrap.id = PANEL_ID;
      wrap.className = 'bwn-wa-card';
      wrap.style.cssText = 'position:fixed;' + (CFG.DOCK_SIDE === 'left' ? 'left:58px;' : 'right:58px;') +
        'top:' + Math.max(CFG.DOCK_TOP_PCT - 14, 6) + '%;z-index:99999;width:500px;max-width:92vw;';

      var prevFocus = document.activeElement;
      function close() {
        document.removeEventListener('keydown', onKey);
        wrap.remove();
        try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus(); } catch (e) { }
      }
      function onKey(e) { if (e.key === 'Escape' && document.getElementById(PANEL_ID) === wrap) close(); }   // identity guard: a listener orphaned by SPA nav / toggle becomes inert
      document.addEventListener('keydown', onKey);
      // Non-modal popover: label it and move focus in on open, but do NOT trap focus
      // (the WO page stays interactive behind it, so a hard trap would be an a11y
      // anti-pattern). Esc and the Close button dismiss it.
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-label', 'WO Assist breakdown');
      if (!wrap.hasAttribute('tabindex')) wrap.setAttribute('tabindex', '-1');

      // Header
      var head = document.createElement('div'); head.className = 'bwn-wa-head';
      var hl = document.createElement('div');
      var t = document.createElement('div'); t.className = 't'; t.textContent = 'WO Assist';
      var sub = document.createElement('div'); sub.className = 's'; sub.textContent = 'GP + ETA watchdog \u00b7 local only';
      hl.appendChild(t); hl.appendChild(sub);
      head.appendChild(hl);
      if (state.status) {
        var tag = document.createElement('span');
        tag.className = 'bwn-wa-tag' + (state.stall ? ' bad' : '');
        tag.textContent = state.status.toUpperCase() + (state.hrs !== null ? ' \u00b7 ' + Math.round(state.hrs) + 'H' : '');
        head.appendChild(tag);
      }

      var body = document.createElement('div'); body.className = 'bwn-wa-body';

      // Financials
      var fin = waSection(body, 'Financials');
      if (state.nte) waLine(fin, 'Client DNE (' + state.nte.source + ')', fmt(state.nte.amount));
      else waLine(fin, 'Client DNE', 'not detected');
      state.pos.forEach(function (p2) {
        var label = p2.vendor;
        if (p2.done) label += ' \u00b7 complete';
        else if (p2.schedDate) label += ' \u00b7 sched ' + p2.schedDate;
        else if (p2.schedDate === null) label += ' \u00b7 NO SCHED DATE';
        var isStallRow = state.stall && p2.vendor === state.stall.vendor;
        if (p2.amount > 0) waLine(fin, label, '\u2212 ' + fmt(p2.amount), false, (p2.schedDate === null && !p2.done) || isStallRow ? 'var(--bwn-bad)' : null);
        else waLine(fin, label, fmt(0) + ' (excluded)');
      });
      if (state.pos.length) waLine(fin, 'Vendor total', fmt(state.vendorTotal));
      if (state.gp !== null) waLine(fin, 'Gross profit', fmt(state.gp) + ' (' + state.gpPct.toFixed(1) + '%)', true,
        state.gpPct < state.cfg.gpBad ? 'var(--bwn-bad)' : state.gpPct < state.cfg.gpWarn ? 'var(--bwn-warn)' : 'var(--bwn-green)');

      // Schedule
      if (state.due || state.status) {
        var sch = waSection(body, 'Schedule');
        if (state.status) waLine(sch, 'WO status', state.status + (state.hrs !== null ? ' \u00b7 ' + Math.round(state.hrs) + 'h (' + Math.round(state.hrs / 24) + 'd) in status' : ''),
          false, state.stall ? 'var(--bwn-bad)' : null);
        if (state.due) waLine(sch, 'Complete by', state.due.label, false,
          state.due.kind === 'bad' ? 'var(--bwn-bad)' : state.due.kind === 'warn' ? 'var(--bwn-warn)' : null);
        // Cross-page seam: heat verdict from the WO LIST follows you into the WO.
        // A snoozed flag renders neutral \u2014 the list and the WO page must agree.
        var lh = busHeatGet(currentWOId(), 12 * 3600000);
        if (lh && lh.sev > 0) {
          waLine(sch, lh.acked ? 'Snoozed on WO list' : 'Flagged on WO list',
            (lh.sev === 2 ? 'RED' : 'AMBER') + (lh.reasons && lh.reasons.length ? ' \u00b7 ' + lh.reasons[0] : ''),
            false, lh.acked ? null : (lh.sev === 2 ? 'var(--bwn-bad)' : 'var(--bwn-warn)'),
            lh.reasons ? lh.reasons.join(' \u00b7 ') : '');
        }
      }

      // ---- DNE-increase calculator -------------------------------------
      if (state.vendorTotal > 0) {
        var calc = document.createElement('div');
        calc.className = 'bwn-wa-calc';
        var crow = document.createElement('div');
        crow.className = 'crow';
        var clab = document.createElement('span');
        clab.textContent = 'DNE needed at target GP';
        var cin = document.createElement('input');
        cin.type = 'number'; cin.min = '0'; cin.max = '95'; cin.step = '1';
        cin.value = String(getTargetGP());
        var cpct = document.createElement('span'); cpct.textContent = '%';
        crow.appendChild(clab); crow.appendChild(cin); crow.appendChild(cpct);
        var cout = document.createElement('div');
        cout.className = 'cout';
        var copyBtn = document.createElement('button');
        copyBtn.type = 'button'; copyBtn.textContent = 'Copy ask';
        copyBtn.className = 'bwn-wa-btn ghost';
        copyBtn.style.marginTop = '7px';

        var askText = '';
        function recalcDNE() {
          var tv = parseFloat(cin.value);
          if (isNaN(tv) || tv < 0 || tv >= 100) { cout.textContent = 'Enter a target GP% between 0 and 95.'; askText = ''; return; }
          setTargetGP(tv);
          var need = requiredDNE(state.vendorTotal, tv);
          var cur = state.nte ? state.nte.amount : 0;
          var inc = need - cur;
          cout.textContent = '';
          var l1 = document.createElement('div');
          l1.appendChild(document.createTextNode('Required DNE: '));
          var s1 = document.createElement('strong'); s1.textContent = fmt(need); l1.appendChild(s1);
          cout.appendChild(l1);
          var l2 = document.createElement('div');
          if (cur <= 0) {
            l2.textContent = 'No current DNE on record \u2014 request ' + fmt(need) + '.';
            askText = 'Requesting a DNE of ' + fmt(need) + ' to cover vendor costs of ' + fmt(state.vendorTotal) + ' at a ' + tv + '% target GP.';
          } else if (inc > 0.005) {
            l2.appendChild(document.createTextNode('Increase to request: '));
            var s2 = document.createElement('strong'); s2.textContent = '+' + fmt(inc); s2.style.color = 'var(--bwn-bad)'; l2.appendChild(s2);
            l2.appendChild(document.createTextNode(' (current ' + fmt(cur) + ')'));
            askText = 'Requesting a DNE increase from ' + fmt(cur) + ' to ' + fmt(need) + ' (+' + fmt(inc) + ') to cover vendor costs of ' + fmt(state.vendorTotal) + ' at a ' + tv + '% target GP.';
          } else {
            l2.textContent = 'Current DNE (' + fmt(cur) + ') already meets the ' + tv + '% target.';
            l2.style.color = 'var(--bwn-green)';
            askText = '';
          }
          cout.appendChild(l2);
          copyBtn.style.display = askText ? 'inline-block' : 'none';
        }
        cin.addEventListener('input', recalcDNE);
        copyBtn.addEventListener('click', function () {
          if (!askText) return;
          navigator.clipboard.writeText(askText).then(function () {
            copyBtn.textContent = 'Copied \u2713';
            setTimeout(function () { copyBtn.textContent = 'Copy ask'; }, 1500);
          }, function () { prompt('Copy manually:', askText); });
        });
        recalcDNE();
        calc.appendChild(crow); calc.appendChild(cout); calc.appendChild(copyBtn);
        body.appendChild(calc);
      }

      if (state.stall) {
        waAlert(body,
          'STALLED: ' + state.stall.vendor + ' was scheduled ' + state.stall.date + ' \u2014 ' + state.stall.days + ' days ago \u2014 and the PO is not complete.' +
          (state.status ? ' WO status is still "' + state.status + '"' + (state.hrs !== null ? ' (' + Math.round(state.hrs) + ' hrs in status)' : '') + '.' : '') +
          ' No movement since the visit date: chase the vendor for completion docs or a new date, then correct the WO status.', true);
      } else if (state.eta) {
        waAlert(body, state.eta.label + ' \u2014 ' + state.eta.detail, state.eta.ok ? false : (state.eta.kind === 'warn' ? 'warn' : true));
      }

      // ---- Next actions (playbook) ----
      // Summary view: top 3, with ✓ marks synced from the Action Checklist store.
      var allActs = nextActions(state);
      var actStore = actsLoad();
      var acts = allActs.slice(0, 3);
      if (acts.length) {
        var pb = waSection(body, 'Next actions');
        acts.forEach(function (a, idx) {
          var aDone = !!(actStore[a.key] && actStore[a.key].done);
          var row = document.createElement('div'); row.className = 'bwn-wa-line';
          var l = document.createElement('span'); l.className = 'l';
          l.textContent = (idx + 1) + '. ' + (aDone ? '✓ ' : '') + a.label;
          l.title = aDone ? ('Actioned' + (actStore[a.key].note ? ': ' + actStore[a.key].note : '')) : a.why;
          if (aDone) { l.style.textDecoration = 'line-through'; l.style.color = '#90a4ae'; }
          l.style.whiteSpace = 'normal';
          row.appendChild(l);
          if (a.text) {
            var cp = document.createElement('button');
            cp.type = 'button'; cp.className = 'bwn-wa-btn ghost'; cp.textContent = 'Copy chase';
            cp.style.cssText = 'padding:3px 9px;font-size:10px;flex:none;';
            cp.title = a.text;
            cp.addEventListener('click', function () {
              navigator.clipboard.writeText(a.text).then(function () {
                cp.textContent = 'Copied \u2713';
                setTimeout(function () { cp.textContent = 'Copy chase'; }, 1500);
              }, function () { prompt('Copy manually:', a.text); });
            });
            row.appendChild(cp);
          } else {
            var v = document.createElement('span'); v.className = 'v'; v.textContent = a.why;
            v.style.cssText = 'white-space:normal;text-align:right;max-width:45%;';
            row.appendChild(v);
          }
          pb.appendChild(row);
        });
        if (allActs.length > acts.length) {
          var more = document.createElement('div'); more.className = 'bwn-wa-line';
          var ml = document.createElement('span'); ml.className = 'l';
          ml.textContent = '… +' + (allActs.length - acts.length) + ' more - full checklist above Purchase Orders';
          ml.style.cssText = 'white-space:normal;color:#90a4ae;font-size:12px;';
          more.appendChild(ml); pb.appendChild(more);
        }
      }

      var meta = document.createElement('div');
      meta.className = 'bwn-wa-meta';
      meta.textContent = state.noteCount + ' note(s) ' + (state.notesSrc === 'api' ? 'read from the Umbrava API' : state.notesSrc === 'deep' ? 'deep-scanned' : state.notesSrc === 'cache' ? 'from the shared scan cache' : 'loaded in view') +
        (state.staleDays !== null ? ' \u00b7 newest ' + state.staleDays + 'd ago' : '');
      body.appendChild(meta);

      var foot = document.createElement('div'); foot.className = 'bwn-wa-foot';
      function fbtn(label, primary, fn) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        b.className = 'bwn-wa-btn ' + (primary ? 'primary' : 'ghost');
        b.addEventListener('click', fn); return b;
      }
      foot.appendChild(fbtn('Set DNE', false, function () { setManualNTE(); close(); openPanel(); }));

      // Copy a tracker-ready TSV row. Shift+click also includes the header row.
      var COLS = ['Tracking', 'WO', 'Location', 'Status', 'Hrs In Status', 'DNE', 'Vendor Total', 'GP $', 'GP %', 'ETA / Sched', 'Stall', 'Complete By', 'Last Note (d)', 'Notes Seen'];
      var rowBtn = fbtn('Copy Row', false, function (e) {
        var hd = headerInfo();
        var row = [
          hd.tracking, hd.wo, hd.location,
          state.status || '',
          state.hrs !== null ? Math.round(state.hrs) : '',
          state.nte ? state.nte.amount.toFixed(2) : '',
          state.vendorTotal ? state.vendorTotal.toFixed(2) : '',
          state.gp !== null ? state.gp.toFixed(2) : '',
          state.gpPct !== null ? state.gpPct.toFixed(1) : '',
          state.eta ? state.eta.label : '',
          state.stall ? 'STALLED ' + state.stall.days + 'd' : '',
          state.due ? state.due.raw : '',
          state.staleDays !== null ? state.staleDays : '',
          state.noteCount + (state.notesSrc === 'api' ? ' (api)' : state.notesSrc === 'deep' ? ' (deep)' : state.notesSrc === 'cache' ? ' (cached)' : ' (in view)')
        ].map(function (v) { return String(v).replace(/[\t\n]/g, ' '); }).join('\t');
        var out = (e && e.shiftKey ? COLS.join('\t') + '\n' : '') + row;
        navigator.clipboard.writeText(out).then(function () {
          rowBtn.textContent = 'Copied \u2713';
          setTimeout(function () { rowBtn.textContent = 'Copy Row'; }, 1500);
        }, function () { prompt('Copy manually:', out); });
      });
      rowBtn.title = 'Copies a tab-separated tracker row. Shift+click to include the header row.\nColumns: ' + COLS.join(' | ');
      foot.appendChild(rowBtn);
      var deepBtn = fbtn('Deep Scan', true, function () {
        deepBtn.disabled = true;
        deepBtn.textContent = 'Scanning\u2026';
        deepScan(function (n) { deepBtn.textContent = 'Scanning\u2026 ' + n; }, function () {
          close(); refresh(); openPanel();
        });
      });
      foot.appendChild(deepBtn);
      foot.appendChild(fbtn('Rescan', false, function () { close(); refresh(); openPanel(); }));
      foot.appendChild(fbtn('Close', false, close));

      wrap.appendChild(head); wrap.appendChild(body); wrap.appendChild(foot);
      document.body.appendChild(wrap);
      setTimeout(function () { try { wrap.focus(); } catch (e) { } }, 0);   // move focus into the panel so a screen reader announces the dialog
    }

    // ---- Lifecycle -------------------------------------------------------------------
    function onWO() { return /\/work-orders\//.test(location.pathname); }

    function refresh() {
      // The NEXT ACTIONS checklist card renders on the WO page (its original location, above
      // the PO block) AND the same steps show as pills at the top of the AI Job View, both fed
      // by the bus payload published below. Only the floating GP/ETA pill + the legacy breakdown
      // panel stay retired behind SHOW_WO_DOCK (flip to true to bring the full side-dock back).
      // The ENGINE always runs: compute, actioned auto-detect, PO grouping, ECD auto-pop,
      // preflight, and the bus publish.
      var SHOW_WO_DOCK = false;
      cacheDocsInv();   // runs on /documents + /billing (before the WO-anchor guards below return early there)
      if (!onWO()) {
        var p = document.getElementById(PILL_ID); if (p) p.remove();
        var pn = document.getElementById(PANEL_ID); if (pn) pn.remove();
        var ac = document.getElementById(ACT_CARD_ID); if (ac) ac.remove();
        BWN.beat('woAssist', 'waiting', 'not a WO page');
        return;
      }
      // ---- Identity publishes FIRST, ahead of the anchor gate below --------------------------
      // The gate waits for a PO accordion or a rendered note summary before anything is
      // published. A WO in Pending Dispatch has no POs at all, and a brand-new one has no notes
      // either for the first seconds of its life (W-383441: created 14:55:59, first note
      // +11s). A tab loaded inside that window satisfies neither anchor and then never
      // publishes, because republishing is event-driven rather than on a timer (measured
      // 2026-08-03: gaps of 18.0s then 1.0s) and sessionStorage is per-tab. That is how the
      // dispatch modal read an empty bus and sent the WO number as the Tracking # on queue row
      // 466. Header identity does not depend on POs or notes, so it must not wait for them.
      // Computed state (GP, POs, next actions) still publishes below and merges over this.
      // busPatch skips blanks, so a not-yet-rendered field never clobbers a good earlier value;
      // the full publish below stays authoritative and does write blanks.
      var hd = headerInfo();
      var woIdent = currentWOId();
      if (woIdent && (hd.tracking || hd.wo)) {
        busPatch(woIdent, {
          tracking: hd.tracking, wo: hd.wo, location: hd.location,
          client: hd.client || '', addr: hd.addr || '',
          coordinator: hd.coordinator || '', sourceJob: hd.sourceJob || '', sourcePo: hd.sourcePo || '',
          priority: hd.priority || '', trade: hd.trade || ''
        });
      }
      if (!document.querySelector('[data-testid^="POAccordion-"]') &&
          !document.querySelector('[data-testid^="wo-note-"][data-testid$="-summary"]')) {
        var p2 = document.getElementById(PILL_ID); if (p2) p2.remove();
        var ac2 = document.getElementById(ACT_CARD_ID); if (ac2) ac2.remove();
        BWN.beat('woAssist', 'waiting', 'WO anchors not rendered');
        return;
      }
      // Warm the full note history before the engine reads it. First pass on a WO runs on
      // whatever is mounted (usually nothing on the details route); the read calls refresh()
      // again when it lands, and every notes-derived judgement recomputes off the real
      // history. Same once-per-WO shape as fetchWO / fetchTrips above.
      fetchNotesApi(woIdent);
      var st = compute();
      // Keep the acts store honest whether or not the dock renders: auto-detect actioned
      // steps from posted notes (idempotent - renderActsInline re-runs it when the dock shows).
      var waActs = []; try { waActs = nextActions(st); } catch (e) { }
      try { if (waActs.length) autoDetectActioned(waActs, st); } catch (e) { }
      // NEXT ACTIONS list is restored to its original on-page location (the checklist card
      // above the PO block). The Job View pills (fed by the bus publish below) stay too, so the
      // same next-steps show in BOTH places, in unison. Only the floating GP/ETA pill + the
      // legacy breakdown panel remain gated behind SHOW_WO_DOCK.
      if (SHOW_WO_DOCK) renderPill(st);
      else {
        var _pl = document.getElementById(PILL_ID); if (_pl) _pl.remove();
        var _pn = document.getElementById(PANEL_ID); if (_pn) _pn.remove();
      }
      renderActsInline(st);
      try { renderPOGroups(); } catch (e) { /* PO grouping is best-effort - never break the engine */ }
      maybeAutoECD(st);
      maybePreflight(st);
      BWN.beat('woAssist', 'ok', 'pill active');
      // Publish the canonical WO state for the rest of the suite. This one REPLACES: it carries
      // every identity field as well, so it stays authoritative over the early patch above -
      // including writing a field back to blank when the header genuinely clears it. `hd` is the
      // same read taken before the gate; re-reading it here would only cost another full label
      // sweep of the DOM.
      var woId = currentWOId();
      if (woId) {
        busPut(woId, {
          tracking: hd.tracking, wo: hd.wo, location: hd.location,
          client: hd.client || '', addr: hd.addr || '',
          coordinator: hd.coordinator || '', sourceJob: hd.sourceJob || '', sourcePo: hd.sourcePo || '',
          status: st.status, hrs: st.hrs,
          // bwn-wo-assist prefills its escalation POST from bus.priority / bus.trade - the
          // drawer read these keys from day one, but the publish never carried them, so the
          // first live escalation (W-371126, 2026-08-03) rendered '-' for both.
          priority: st.priority || '',
          trade: ((st.woApi && st.woApi.trades && st.woApi.trades.map) ? st.woApi.trades.map(function (t) { return t && t.name; }).filter(Boolean).join(', ') : '') || hd.trade || '',
          staleDays: (st.staleDays != null ? st.staleDays : null), noteCount: (st.noteCount != null ? st.noteCount : null), lastNote: st.lastNote || null,
          // The newest CLIENT-typed note, as a full timestamp. `lastClientNoteDays` has been on
          // state for the cadence step since Phase 3, but day granularity cannot answer "did we
          // reply AFTER this item opened" on the day it opened - which is exactly the question
          // the queue's client-response convergence asks (bwn-wo-assist, queue-spec step 4).
          lastClientNote: st.lastClientNote || null,
          vendorTotal: (st.vendorTotal != null ? st.vendorTotal : null),
          dne: st.nte ? st.nte.amount : null, dneSource: st.nte ? st.nte.source : null,
          pos: st.pos.map(function (p) { return { vendor: p.vendor, amount: p.amount, sched: p.schedDate || null, done: !!p.done }; }),
          gp: st.gp, gpPct: st.gpPct,
          stall: st.stall ? { days: st.stall.days, vendor: st.stall.vendor, date: st.stall.date } : null,
          // Computed pills + ranked next-steps for the Job View header (dock retired). Each
          // step carries its store `done` flag so Job View can strike/collapse completed ones.
          due: st.due || null,
          eta: st.eta || null,
          nextSteps: (function () { try { var store = actsLoad(); return waActs.slice(0, 6).map(function (a) { return { key: a.key, label: a.label, why: a.why, text: a.text || null, owner: a.owner || null, authored: !!a.authored, anchor: !!a.anchor, done: !!(store[a.key] && store[a.key].done) }; }); } catch (e) { return []; } })()
        });
      }
    }

    var lastPath = location.pathname;
    var debounce = null;
    var obs = new MutationObserver(BWN.guard(function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        deepNotes = null;
        deepNotesViaApi = false;
        var pn = document.getElementById(PANEL_ID); if (pn) pn.remove();
        var acn = document.getElementById(ACT_CARD_ID); if (acn) acn.remove();   // checklist is per-WO; never carry it across
        var eo = document.getElementById('bwn-ecd-overlay'); if (eo) eo.remove();
        var pfb = document.getElementById('bwn-pf-banner'); if (pfb) pfb.remove();
        ecdAutoShownFor = null;   // re-arm the once-per-WO ECD auto-pop for the new WO
        prevStatus = null;        // don't treat an already-terminal WO opened fresh as a "change"
      }
      clearTimeout(debounce);
      debounce = setTimeout(BWN.guard(refresh, 'woAssist:refresh'), 400);
    }, 'woAssist:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('bwn:config', BWN.guard(refresh, 'woAssist:refresh'));
    // Command bus: the AI Job View (dock retired) triggers WO Assist's interactions here so
    // the engine keeps owning them. core:ecd opens the completion-date helper; core:act logs a
    // next-step done in the acts store + drafts its note (Internal for ECD-family steps).
    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail; if (!d) return;
      if (d.id === 'core:ecd') { ecdHelperOpen(compute()); return; }
      if (d.id === 'core:act' && d.key) {
        try {
          var a = nextActions(compute()).filter(function (x) { return x.key === d.key; })[0];
          if (!a) return;
          actsMarkDone(a, (d.note || '').trim());
          var noteText = a.label + ((d.note || '').trim() ? ' - ' + d.note.trim() : '');
          try { navigator.clipboard.writeText(noteText).catch(function () { }); } catch (e2) { }
          var nt = (a.openEcd || /^ecd/.test(a.key || '')) ? 'Internal'
            : /^clientcad/.test(a.key || '') ? 'Client' : undefined;
          insertWONote(noteText, function () { /* posted manually by the coordinator */ }, nt);
        } catch (e3) { }
        return;
      }
      if (d.id === 'core:insertnote' && d.text) {
        // Generic "prefill the Add Note composer with this text + set this Type" command, driven by
        // the AI Draft buttons (e.g. Over-30 -> Type "Recap"). Reuses the same DOM-verified composer
        // flow as core:act; the coordinator still reviews + saves the note manually.
        try { navigator.clipboard.writeText(String(d.text)).catch(function () { }); } catch (e4) { }
        insertWONote(String(d.text), function () { /* posted manually by the coordinator */ }, d.noteType || undefined);
        return;
      }
    }, 'woAssist:cmd'));
    refresh();
  });

  // ==========================================================================
  // MODULE: Email Leak Guard v2.0
  // ==========================================================================
  bwnBoot('leakGuard', BWN_MODULES.leakGuard, function () {
    'use strict';

    var STRIP_ID = 'bwn-eg-strip';
    var STYLE_ID = 'bwn-eg-style';

    console.info('[BWN EG] email leak guard v2.0 loaded on', location.href);

    // ---- Config (edit here) ----------------------------------------------
    var CFG = {
      // v1.4: "margin of error" and "non-profit"/"nonprofit" are not pricing talk;
      // plurals ("margins", "profits") and hyphenated forms ("gross-profit") are.
      GP_WORDS: /\b(margins?(?!\s+of\s+error)|mark[\s-]?ups?|gross[\s-]+profits?|gp|our\s+costs?)\b|(?<!\w)(?<!non-)profits?\b/i,
      // v2.0: recipients on this domain are Broadway-internal - no leak direction.
      // (Vendor identification moved to bwnVendorTokens/bwnVendorMatch, Core scope.)
      INTERNAL_DOMAIN: 'broadwaynational.com'
    };

    // ---- Small helpers (parsing shared via BWN core) ------------------------
    var alphaOnly = BWN.alphaOnly;
    var lcsLen = BWN.lcsLen;
    var fmt = BWN.money;
    function near(a, b) { return Math.abs(a - b) < 0.005; }

    // ---- BWN bus (shared via BWN core) --------------------------------------
    var currentWOId = BWN.woId;
    var busGet = BWN.busGet;

    // ---- WO context (read from the page under the modal) ---------------------
    function getDNE() {
      var el = document.querySelector('input[name="doNotExceed"]');
      if (!el) return null;
      var n = parseFloat(String(el.value || '').replace(/[$,\s]/g, ''));
      return (!isNaN(n) && n > 0) ? n : null;
    }
    function getPOs() {
      var out = [];
      document.querySelectorAll('[data-testid^="POAccordion-"]').forEach(function (row) {
        var vEl = row.querySelector('[data-testid="purchase-order-vendor-name"]') ||
                  row.querySelector('[data-testid="purchase-order-vendor-link"]') ||
                  row.querySelector('a');
        var vendor = vEl ? (vEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (!vendor) return;
        var amts = [];
        var re = /\$\s*([\d,]+(?:\.\d{1,2})?)/g, m, txt2 = row.textContent || '';
        while ((m = re.exec(txt2)) !== null) amts.push(parseFloat(m[1].replace(/,/g, '')));
        out.push({ vendor: vendor, amount: amts.length ? Math.max.apply(null, amts) : null });
      });
      return out;
    }
    // Distinctive tokens of a vendor name (e.g. "VIRTUE" from "VIRTUE ELECTRIC, LLC").
    var vendorTokens = bwnVendorTokens;   // promoted to Core scope (shared with PO Approval)
    // Client token from the location label (e.g. "Staples 0491 ..." -> STAPLES).
    // v1.4: the first word is not always distinctive - "The UPS Store" must yield
    // UPS, not THE (alphaOnly of a recipient like "Matthew…" contains THE, which
    // misclassified vendor mail as client-bound). Skip articles/generics and take
    // the first real token instead.
    var CLIENT_SKIP = ['THE', 'AND', 'OF', 'A', 'AN', 'NEW', 'STORE', 'SHOP', 'INC', 'LLC', 'CO', 'CORP'];
    function clientToken() {
      var el = document.querySelector('[data-testid="wo-location-dropdown-input-label"]');
      var words = el ? (el.textContent || '').trim().toUpperCase().split(/\s+/) : [];
      for (var i = 0; i < words.length; i++) {
        var w = words[i].replace(/[^A-Z]/g, '');
        if (w.length >= 3 && CLIENT_SKIP.indexOf(w) === -1) return w;
      }
      return '';
    }

    // ---- Modal field discovery (same approach as the PO Approval script) -----
    function findSubject(root) {
      var all = root.querySelectorAll('input, textarea');
      for (var i = 0; i < all.length; i++) {
        if (/tracking\s*#/i.test(all[i].value || '')) return all[i];
      }
      return null;
    }
    function findBody(root, subjectEl) {
      var tas = root.querySelectorAll('textarea');
      var best = null;
      for (var i = 0; i < tas.length; i++) {
        if (tas[i] === subjectEl) continue;
        var v = tas[i].value || '';
        if (/purchase order|broadway national|please find/i.test(v)) return tas[i];
        if (!best || v.length > (best.value || '').length) best = tas[i];
      }
      return best;
    }
    function recipientsText(modal) {
      var to = modal.querySelector('[data-testid="Mail-To-Form-recipient-textfield-autocomplete"]');
      return to ? (to.textContent || '') : '';
    }

    // ---- Direction: who is this going to? --------------------------------------
    // v2.0: vendors are identified by DISTINCTIVE name tokens (bwnVendorMatch - a
    // shared trade word like ELECTRIC can no longer identify the wrong vendor), by
    // LEARNED address bindings (bwn:eg:contacts - a personal gmail confirmed as a
    // vendor once is recognized from then on), and Broadway-internal recipients are
    // recognized by domain (internal mail carries no leak direction at all).
    function classify(modal, pos) {
      var rawText = recipientsText(modal);
      var rec = alphaOnly(rawText);
      var emails = [];
      var em0, emRe0 = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
      while ((em0 = emRe0.exec(rawText)) !== null) {
        emails.push({ full: em0[0].toLowerCase(), local: em0[1].toLowerCase(), domain: em0[2].toLowerCase() });
      }
      // Internal is only a CANDIDATE here: it must never suppress a positively
      // identified vendor/client (a name-only vendor chip has no email for the
      // regex to see, so "all extracted emails are internal" alone proves little).
      var internalCandidate = emails.length > 0 && emails.every(function (e) { return e.domain === CFG.INTERNAL_DOMAIN; });
      var toVendors = [], evidence = {};
      pos.forEach(function (p) {
        var vm = bwnVendorMatch(p.vendor, rawText);
        if (vm.hit) { toVendors.push(p.vendor); evidence[p.vendor] = vm.token ? 'matched ' + vm.token : 'name overlap'; }
      });
      // Learned bindings (expired after ~6 months). A remembered name is mapped
      // back onto this WO's PO vendor only when there is a UNIQUE best token
      // overlap - on a tie (two sibling companies), the stored name is kept
      // unmapped so neither WO vendor gets the own-PO exemption (fails safe).
      var contacts = BWN.lsGetJSON('bwn:eg:contacts', {}) || {};
      emails.forEach(function (e) {
        var c = contacts[e.full];
        if (!c || c.kind !== 'vendor' || !c.name) return;
        if (Date.now() - (c.ts || 0) > 180 * 86400000) return;   // stale binding
        var cToks = bwnVendorTokens(c.name);
        var bestV = null, bestShared = 0, tie = false;
        for (var pi = 0; pi < pos.length; pi++) {
          if (pos[pi].vendor === c.name) { bestV = c.name; bestShared = 99; tie = false; break; }   // exact name wins outright
          var shared = bwnVendorTokens(pos[pi].vendor).filter(function (tk) { return cToks.indexOf(tk) !== -1; }).length;
          if (shared > bestShared) { bestShared = shared; bestV = pos[pi].vendor; tie = false; }
          else if (shared === bestShared && shared > 0 && pos[pi].vendor !== bestV) tie = true;
        }
        var mapped = (bestV && !tie) ? bestV : c.name;
        if (toVendors.indexOf(mapped) === -1) { toVendors.push(mapped); evidence[mapped] = 'remembered ' + e.full; }
      });
      var ct = clientToken();
      // Long tokens (4+ letters) keep the alpha-stream substring match. 3-letter
      // tokens (UPS, CVS, BJS) are too short for that (the THE-in-MATTHEW class of
      // false hit), so they must appear as a standalone word in the raw recipient
      // text (apostrophes/periods stripped, so "BJ's" reads as BJS) OR inside an
      // email's own local-part prefix / domain - brand-controlled strings that a
      // person's display name can't fake ("mgr0100@clientbrand.com" is client mail).
      var toClient = false;
      if (ct && !internalCandidate) {
        if (ct.length >= 4) {
          toClient = rec.indexOf(ct) !== -1;
        } else {
          var raw = rawText.replace(/['’.]/g, '');
          toClient = new RegExp('(^|[^A-Za-z])' + ct + '([^A-Za-z]|$)', 'i').test(raw);
          if (!toClient) {
            var em, emRe = /([A-Za-z0-9_%+-]+)@([A-Za-z0-9-]+)/g;
            while (!toClient && (em = emRe.exec(raw)) !== null) {
              if (em[1].toUpperCase().indexOf(ct) === 0 || em[2].toUpperCase().indexOf(ct) !== -1) toClient = true;
            }
          }
        }
      }
      // Final internal verdict: a matched vendor/client always overrides it.
      var internal = internalCandidate && !toVendors.length && !toClient;
      return { toVendors: toVendors, toClient: toClient, internal: internal, emails: emails, evidence: evidence,
               known: internal || toVendors.length > 0 || toClient };
    }

    // ---- The scan -----------------------------------------------------------------
    // Each finding carries `find`: the exact matched text, so the strip can locate
    // and select it in the field on click. v2.0: a sensitive amount is caught in
    // every form it leaks in \u2014 "$4,500.00", the bare "4500"/"4,500", and "4.5k" \u2014
    // and the WO's gross-profit figure is guarded in every direction. Bare numbers
    // only flag when they COINCIDE with a known sensitive amount (never
    // generically), and the WO's tracking/WO numbers are excluded so ids can't
    // false-match.
    function scanBody(text, dir, pos, dne, excludeIds, gpAmt) {
      var findings = [];
      var t = text || '';
      excludeIds = excludeIds || [];

      // Broadway-internal email: amounts, vendor names, and GP talk are fine.
      if (dir.internal) return findings;

      // Internal pricing language: never appropriate in any outbound email.
      var gpHit = t.match(CFG.GP_WORDS);
      if (gpHit) findings.push({ sev: 'bad', msg: 'Internal pricing language in the body: "' + gpHit[0] + '"', find: gpHit[0] });

      // Dollar amounts present in the body (raw matched text kept for click-to-locate).
      var amts = [];
      var re = /\$\s*([\d,]+(?:\.\d{1,2})?)/g, m;
      while ((m = re.exec(t)) !== null) amts.push({ val: parseFloat(m[1].replace(/,/g, '')), raw: m[0] });
      function amtHit(target) {
        for (var i = 0; i < amts.length; i++) { if (near(amts[i].val, target)) return amts[i].raw; }
        // Same-dollar band: "$4,500" must still flag when the real DNE is $4,500.75 -
        // the $ form cannot be MORE lenient than the bare form of the same leak.
        for (var i2 = 0; i2 < amts.length; i2++) { if (Math.abs(amts[i2].val - target) < 1) return amts[i2].raw; }
        return null;
      }
      // Bare or k-suffix forms of a KNOWN sensitive amount ("4500", "4,500", "4.5k",
      // and "$4.5k" - the $ regex above reads that as $4.50, so the k loop must
      // NOT skip $-prefixed candidates).
      function bareHit(target) {
        if (!(target > 0)) return null;
        var reK = /\b(\d{1,4}(?:\.\d{1,2})?)\s*[kK]\b/g, mk;
        while ((mk = reK.exec(t)) !== null) {
          var kval = parseFloat(mk[1]) * 1000;
          if (Math.abs(kval - target) <= Math.max(50, target * 0.05)) return mk[0].trim();
        }
        var reB = /\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{3,7}(?:\.\d{1,2})?)\b/g, mb;
        while ((mb = reB.exec(t)) !== null) {
          if (t.slice(Math.max(0, mb.index - 2), mb.index).indexOf('$') !== -1) continue;   // $-form: handled by amtHit
          var pre = t.charAt(mb.index - 1) || '', post = t.charAt(mb.index + mb[0].length) || '';
          if (pre === '/' || post === '/') continue;                     // date fragment
          // Hyphens: skip only PHONE-shaped neighbors (a 1-3 digit group on the far
          // side, e.g. "555-4500"); a range like "4500-5000" still discloses the
          // amount and must flag.
          if (pre === '-') {
            var befD = (t.slice(0, mb.index - 1).match(/(\d+)$/) || [])[1] || '';
            if (befD.length > 0 && befD.length <= 3) continue;
          }
          if (post === '-') {
            var aftD = (t.slice(mb.index + mb[0].length + 1).match(/^(\d+)/) || [])[1] || '';
            if (aftD.length > 0 && aftD.length <= 3) continue;
          }
          if (excludeIds.indexOf(mb[1].replace(/[^0-9]/g, '')) !== -1) continue;   // tracking / WO number
          var val = parseFloat(mb[1].replace(/,/g, ''));
          if (isNaN(val)) continue;
          if (!/[,.]/.test(mb[1]) && val >= 1900 && val <= 2099) continue;   // bare year ("since 2025")
          if (Math.abs(val - target) < 1) return mb[0].trim();               // same dollar
        }
        return null;
      }
      // One finding per sensitive amount, preferring the exact $ form.
      function pushAmt(sev0, target, msgFn) {
        if (!(target > 0)) return;
        var hd = amtHit(target);
        if (hd) { findings.push({ sev: sev0, msg: msgFn(hd, false), find: hd }); return; }
        var hb = bareHit(target);
        if (hb) findings.push({ sev: sev0, msg: msgFn(hb, true), find: hb });
      }
      function noDollar(raw) { return ' \u2014 written as "' + raw + '"; no $ needed to leak it'; }

      var up = t.toUpperCase();

      // The WO's gross-profit figure is internal math in EVERY outbound direction.
      if (gpAmt !== null && gpAmt !== undefined && gpAmt > 0) {
        pushAmt(dir.known ? 'bad' : 'warn', gpAmt, function (raw, bare) {
          return 'This WO\u2019s gross-profit figure (' + fmt(gpAmt) + ') appears' + (bare ? noDollar(raw) : '') + ' \u2014 margin math never goes out';
        });
      }

      if (dir.toVendors.length) {
        // To a vendor: the client's budget and OTHER vendors' info must not appear.
        pushAmt('bad', dne !== null ? dne : 0, function (raw, bare) {
          return 'Client DNE (' + fmt(dne) + ') appears' + (bare ? noDollar(raw) : '') + ' \u2014 vendors should not see the client\u2019s budget';
        });
        pos.forEach(function (p) {
          if (dir.toVendors.indexOf(p.vendor) !== -1) return;   // their own PO is fine
          pushAmt('bad', p.amount !== null ? p.amount : 0, function (raw, bare) {
            return 'Another vendor\u2019s PO amount (' + fmt(p.amount) + ' \u2014 ' + p.vendor + ') appears' + (bare ? noDollar(raw) : '');
          });
          vendorTokens(p.vendor).forEach(function (tok) {
            if (up.indexOf(tok) !== -1) findings.push({ sev: 'bad', msg: 'Mentions another vendor: ' + p.vendor, find: tok });
          });
        });
      }

      if (dir.toClient) {
        // To the client: vendor names and vendor costs must not appear.
        pos.forEach(function (p) {
          pushAmt('bad', p.amount !== null ? p.amount : 0, function (raw, bare) {
            return 'Vendor cost (' + fmt(p.amount) + ' \u2014 ' + p.vendor + ') in a client email' + (bare ? noDollar(raw) : '');
          });
          vendorTokens(p.vendor).forEach(function (tok) {
            if (up.indexOf(tok) !== -1) findings.push({ sev: 'bad', msg: 'Vendor name "' + p.vendor + '" in a client email', find: tok });
          });
        });
      }

      if (!dir.known) {
        // Recipient not recognized: soft-flag anything sensitive so you double-check.
        pushAmt('warn', dne !== null ? dne : 0, function (raw, bare) {
          return 'Client DNE (' + fmt(dne) + ') in body' + (bare ? noDollar(raw) : '') + ' \u2014 recipient not recognized, verify who this goes to';
        });
        pos.forEach(function (p) {
          pushAmt('warn', p.amount !== null ? p.amount : 0, function (raw, bare) {
            return 'PO amount (' + fmt(p.amount) + ' \u2014 ' + p.vendor + ') in body' + (bare ? noDollar(raw) : '') + ' \u2014 verify recipient';
          });
        });
      }

      // De-duplicate messages.
      var seen = {};
      return findings.filter(function (f) { if (seen[f.msg]) return false; seen[f.msg] = true; return true; });
    }

    // ---- Strip UI -------------------------------------------------------------------
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        '.bwn-eg{margin:6px 0;border-radius:10px;padding:8px 12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;font-size:12px;line-height:1.5;}' +
        '.bwn-eg.ok{background:var(--bwn-tint);color:var(--bwn-green-dk);}' +
        '.bwn-eg.warn{background:var(--bwn-warn-bg);color:var(--bwn-warn-fg);border-left:3px solid var(--bwn-warn);}' +
        '.bwn-eg.bad{background:var(--bwn-bad-bg);color:var(--bwn-bad-fg);border-left:3px solid var(--bwn-bad);}' +
        '.bwn-eg .hd{font-weight:500;font-size:11px;letter-spacing:.4px;font-family:ui-monospace,"Segoe UI Mono","SF Mono",monospace;}' +
        '.bwn-eg .it{margin-top:3px;}' +
        '.bwn-eg .it[role="button"]{cursor:pointer;}' +
        '.bwn-eg .it[role="button"]:hover{text-decoration:underline;}' +
        '.bwn-eg .it[role="button"]:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:1px;}';
        // There is no `.bwn-eg.flash` any more. It pulsed the strip when a send was blocked
        // (bwnEgFlash, 1.2s of brightness dips originally, trimmed to 240ms, then removed at
        // Mike's call 2026-08-10). It was redundant: confirmSend() opens a dialog in the SAME
        // tick that names the bad recipients, and the strip already carries its warn/bad colour
        // and left border from the scan that found them - both of those are on screen before the
        // click. The flash only animated behind a dialog that had already taken the screen.
        // Do not add it back without a reason the dialog cannot serve.
      document.head.appendChild(st);
    }

    function renderStrip(strip, dir, findings, onLocate) {
      while (strip.firstChild) strip.removeChild(strip.firstChild);
      var worst = findings.some(function (f) { return f.sev === 'bad'; }) ? 'bad'
        : findings.length ? 'warn' : 'ok';
      strip.className = 'bwn-eg ' + worst;
      var hd = document.createElement('div'); hd.className = 'hd';
      // v2.0: say WHY a recipient was classified (matched token / remembered
      // address), so a wrong call is obvious and correctable at a glance.
      var to = dir.internal ? 'INTERNAL (Broadway National)'
        : dir.toVendors.length ? 'VENDOR (' + dir.toVendors.map(function (v) {
            var ev = dir.evidence && dir.evidence[v];
            return v + (ev ? ' · ' + ev : '');
          }).join(', ') + ')'
        : dir.toClient ? 'CLIENT' : 'UNRECOGNIZED RECIPIENT';
      hd.textContent = 'LEAK GUARD \u00b7 TO: ' + to + ' \u00b7 ' +
        (findings.length ? findings.length + ' FINDING' + (findings.length === 1 ? '' : 'S') : 'CLEAN');
      strip.appendChild(hd);
      findings.forEach(function (f) {
        var d = document.createElement('div'); d.className = 'it';
        d.textContent = (f.sev === 'bad' ? '\u26a0 ' : '\u25cb ') + f.msg;
        // Actionable finding: click (or Enter/Space) selects the matched text in the field.
        if (f.find && onLocate) {
          d.setAttribute('role', 'button');
          d.setAttribute('tabindex', '0');
          d.title = 'Click to highlight "' + f.find + '" in the ' + (f.loc === 'subject' ? 'subject' : 'body');
          d.addEventListener('click', function () { onLocate(f); });
          d.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLocate(f); } });
        }
        strip.appendChild(d);
      });
      strip.dataset.bad = findings.some(function (f) { return f.sev === 'bad'; }) ? '1' : '';
      return findings;
    }

    // ---- Branded send-confirmation dialog (v1.4) ------------------------------
    // Replaces window.confirm: Chrome's "prevent this page from creating additional
    // dialogs" checkbox can permanently suppress native confirms, silently turning
    // the DLP gate OFF. This dialog cannot be suppressed, lists the findings, and
    // overridden sends are recorded to a local audit trail (bwn:eg:overrides,
    // capped at 50 entries - never leaves the browser).
    function confirmSend(modal, hard, onSend) {
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(13,38,26,.55);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;';
      var card = document.createElement('div');
      card.style.cssText = 'width:480px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:14px;overflow:hidden;box-shadow:var(--bwn-shadow);';
      var hd = document.createElement('div');
      hd.style.cssText = 'background:var(--bwn-bad);color:#fff;padding:13px 18px;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;flex:none;';
      hd.textContent = 'Leak Guard - ' + hard.length + ' finding' + (hard.length === 1 ? '' : 's') + ' blocking this send';
      var bd = document.createElement('div');
      bd.style.cssText = 'padding:12px 18px;overflow:auto;';
      hard.forEach(function (f) {
        var d = document.createElement('div');
        d.style.cssText = 'padding:7px 10px;margin:4px 0;border-radius:8px;background:var(--bwn-bad-bg);color:var(--bwn-bad-fg);font-size:13px;line-height:1.45;';
        d.textContent = '⚠ ' + f.msg;
        bd.appendChild(d);
      });
      var ft = document.createElement('div');
      ft.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);flex:none;';
      function mkBtn(label, primary) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.style.cssText = 'padding:8px 15px;border:none;border-radius:8px;cursor:pointer;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;' +
          (primary ? 'color:#fff;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));' : 'color:var(--bwn-bad-fg);background:var(--bwn-bad-bg);');
        return b;
      }
      var backBtn = mkBtn('Go back and fix', true);
      var sendBtn = mkBtn('Send anyway', false);
      ft.appendChild(backBtn); ft.appendChild(sendBtn);
      card.appendChild(hd); card.appendChild(bd); card.appendChild(ft);
      ov.appendChild(card);
      // In-tree: MUI's dialog focus trap (enforceFocus) only tolerates focus inside
      // its own subtree - a body-appended dialog loses that focus war for keyboard
      // users. Appending inside the mail modal keeps both traps in agreement.
      modal.appendChild(ov);
      var release = BWN.a11yDialog(card, { label: 'Leak Guard send confirmation', modal: true, initial: backBtn });
      function done(proceed) {
        document.removeEventListener('keydown', onEsc, true);
        release();
        ov.remove();
        if (proceed) onSend();
      }
      function onEsc(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();   // keep Esc from also closing the mail modal underneath
        done(false);
      }
      document.addEventListener('keydown', onEsc, true);
      backBtn.addEventListener('click', function () { done(false); });
      sendBtn.addEventListener('click', function () { done(true); });
      ov.addEventListener('click', function (e) { if (e.target === ov) done(false); });
    }

    // ---- Wire-up per modal --------------------------------------------------------
    function arm(modal) {
      if (modal.querySelector('#' + STRIP_ID)) return true;
      var subjectEl = findSubject(modal);
      var bodyEl = subjectEl ? findBody(modal, subjectEl) : null;
      if (!bodyEl) return false;                        // fields not rendered yet; retry

      ensureStyle();
      var strip = document.createElement('div');
      strip.id = STRIP_ID;
      bodyEl.parentNode.insertBefore(strip, bodyEl);

      var pos = getPOs();
      var dne = getDNE();
      // Bus fallback: if the PO section / DNE field is not rendered right now
      // (collapsed, scrolled out, different tab), use WO Assist's published state.
      var srcNote = 'dom';
      if (!pos.length || dne === null) {
        var bus = busGet(currentWOId(), 12 * 3600000);
        if (bus) {
          if (!pos.length && bus.pos && bus.pos.length) {
            pos = bus.pos.map(function (p) { return { vendor: p.vendor, amount: p.amount }; });
            srcNote = 'bus';
          }
          if (dne === null && typeof bus.dne === 'number') { dne = bus.dne; srcNote = 'bus'; }
        }
      }
      var current = [], currentDir = null;

      // Numbers that are identifiers, not amounts (tracking + WO id): never flagged.
      var excludeIds = [];
      try {
        var sv0 = subjectEl ? (subjectEl.value || '') : '';
        var tm0 = sv0.match(/#\s*(\d{5,})/); if (tm0) excludeIds.push(tm0[1]);
        var wid0 = currentWOId(); if (wid0 && excludeIds.indexOf(wid0) === -1) excludeIds.push(wid0);
      } catch (eI) { /* best-effort */ }
      // This WO's gross-profit (or loss) figure, from WO Assist's published bus
      // state. Collision guard: on a common 50%-GP WO the GP EQUALS the vendor's
      // own PO amount - the one figure a Send PO email must contain - so when GP
      // coincides with any PO amount, stand down and let the PO/DNE checks own it.
      var gpAmt = null;
      function gpFromBus() {
        var busGp = busGet(currentWOId(), 12 * 3600000);
        if (!busGp || typeof busGp.gp !== 'number' || busGp.gp === 0) return null;
        var g = Math.abs(busGp.gp);
        for (var gi = 0; gi < pos.length; gi++) {
          if (pos[gi].amount !== null && Math.abs(pos[gi].amount - g) < 1) return null;
        }
        return g;
      }
      try { gpAmt = gpFromBus(); } catch (eG) { /* best-effort */ }
      // The modal can arm before WO Assist publishes (fresh tab, collapsed PO
      // section): top up missing context on each rescan - cheap sessionStorage
      // reads, already debounced.
      function refreshContext() {
        if (pos.length && dne !== null && gpAmt !== null) return;
        try {
          var bus2 = busGet(currentWOId(), 12 * 3600000);
          if (!bus2) return;
          if (!pos.length && bus2.pos && bus2.pos.length) {
            pos = bus2.pos.map(function (p) { return { vendor: p.vendor, amount: p.amount }; });
          }
          if (dne === null && typeof bus2.dne === 'number') dne = bus2.dne;
          if (gpAmt === null) gpAmt = gpFromBus();
        } catch (eR) { /* best-effort */ }
      }

      // Click a finding → select the matched text in the subject/body field.
      // Numeric finds land on a STANDALONE number (the scan's boundary semantics),
      // not on digits inside a tracking/WO id earlier in the text.
      function locateFinding(f) {
        var el = f.loc === 'subject' ? subjectEl : bodyEl;
        if (!el || !f.find) return;
        var hay = el.value || '';
        var needle = String(f.find);
        var idx = -1;
        if (/^[\d,.\s]+[kK]?$/.test(needle)) {
          var esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          var mres = new RegExp('(^|[^0-9])(' + esc + ')(?![0-9])', 'i').exec(hay);
          if (mres) idx = mres.index + mres[1].length;
        }
        if (idx === -1) idx = hay.toUpperCase().indexOf(needle.toUpperCase());
        if (idx === -1) return;
        try { el.focus(); el.setSelectionRange(idx, idx + needle.length); } catch (e) { /* selection unsupported on this field */ }
      }

      function rescan() {
        refreshContext();
        var dir = classify(modal, pos);
        currentDir = dir;
        var bodyHits = scanBody(bodyEl.value || '', dir, pos, dne, excludeIds, gpAmt);
        var subjHits = subjectEl ? scanBody(subjectEl.value || '', dir, pos, dne, excludeIds, gpAmt).map(function (f) { return { sev: f.sev, msg: 'Subject - ' + f.msg, find: f.find, loc: 'subject' }; }) : [];
        current = renderStrip(strip, dir, subjHits.concat(bodyHits), locateFinding);   // subject leaks listed first
      }

      // Contact learning (v2.0): a single-recipient CLEAN send that classified as
      // exactly one vendor binds that address to the vendor (bwn:eg:contacts,
      // capped, ~6-month expiry) - next time the same personal gmail is recognized
      // even without the vendor's name in the display text. Guards against
      // poisoning: the matched token must sit in the EMAIL ADDRESS itself (a
      // display-name hit like "Maria Rodriguez <maria@client.com>" proves nothing
      // about the address), never learned from an overridden send (classification
      // was just disputed), never from a 'remembered' match (no self-reinforcement),
      // and at most once per modal. Bindings are viewable/clearable in the Ops panel.
      var learnedThisModal = false;
      function learnContacts(dir) {
        try {
          if (learnedThisModal) return;
          if (!dir || dir.internal || dir.toClient || dir.toVendors.length !== 1 || !dir.emails || dir.emails.length !== 1) return;
          var vName = dir.toVendors[0];
          var evM = String((dir.evidence && dir.evidence[vName]) || '').match(/^matched (.+)$/);
          if (!evM) return;                                       // direct token evidence only
          var tok = evM[1].replace(/[^A-Za-z]/g, '').toLowerCase();
          var addr = dir.emails[0];
          if (tok.length < 4 || (addr.local.indexOf(tok) === -1 && addr.domain.indexOf(tok) === -1)) return;
          var c = BWN.lsGetJSON('bwn:eg:contacts', {}) || {};
          c[addr.full] = { kind: 'vendor', name: vName, ts: Date.now() };
          var keys = Object.keys(c);
          if (keys.length > 200) {
            keys.sort(function (a, b) { return (c[a].ts || 0) - (c[b].ts || 0); });
            while (keys.length > 200) delete c[keys.shift()];
          }
          BWN.lsSetJSON('bwn:eg:contacts', c);
          learnedThisModal = true;
        } catch (eL) { /* best-effort */ }
      }
      var deb = null;
      bodyEl.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(rescan, 350); });
      if (subjectEl) subjectEl.addEventListener('input', function () { clearTimeout(deb); deb = setTimeout(rescan, 350); });
      // Recipients can change after mount; re-check on focus changes inside the modal.
      modal.addEventListener('focusout', function () { clearTimeout(deb); deb = setTimeout(rescan, 350); });
      rescan();

      // Send guard: one confirmation when hard findings exist. The override latch
      // lives ON the modal element, not in this closure: if a body remount re-arms
      // the strip and stacks a second click listener, per-closure latches would
      // deadlock each other's async confirmations \u2014 a shared latch lets one
      // confirmed send pass every listener.
      modal.addEventListener('click', function (e) {
        var send = modal.querySelector('[data-testid="mail-to-modal-send-button"]');
        if (!send || !(e.target === send || send.contains(e.target))) return;
        rescan();
        var hard = current.filter(function (f) { return f.sev === 'bad'; });
        if (!hard.length || modal.__bwnEgOverride) {
          if (!hard.length && !modal.__bwnEgOverride) learnContacts(currentDir);   // clean send: remember who this address belongs to
          return;                                       // clean (or already confirmed): let it through
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        // No visual cue fires here on purpose: confirmSend() below opens a dialog naming the bad
        // recipients in this same tick, and the strip is already coloured from the scan.
        confirmSend(modal, hard, function () {
          // Re-query first: React may have remounted (or torn down) the button
          // while the dialog was open \u2014 never log an override that didn't send.
          var sendNow = modal.querySelector('[data-testid="mail-to-modal-send-button"]');
          if (!sendNow) return;
          // Local audit trail of overridden sends \u2014 reviewable, never transmitted.
          try {
            var lg = BWN.lsGetJSON('bwn:eg:overrides', []);
            if (!Array.isArray(lg)) lg = [];
            lg.push({
              ts: Date.now(), wo: currentWOId(),
              to: currentDir ? (currentDir.toVendors.length ? 'vendor: ' + currentDir.toVendors.join(', ') : currentDir.toClient ? 'client' : 'unrecognized') : '',
              findings: hard.map(function (f) { return f.msg; })
            });
            while (lg.length > 50) lg.shift();
            BWN.lsSetJSON('bwn:eg:overrides', lg);
          } catch (eA) { /* audit is best-effort */ }
          // No learning here: an override means the classification was just disputed.
          modal.__bwnEgOverride = true;                 // allow exactly the next click through
          sendNow.click();
          modal.__bwnEgOverride = false;
        });
      }, true);                                          // capture: runs before React's handler

      console.info('[BWN EG] armed on mail modal |', pos.length, 'PO vendor(s) known | DNE:', dne, '| source:', srcNote);
      BWN.beat('leakGuard', 'ok', 'DLP strip armed');
      return true;
    }

    // ---- Mount lifecycle (same pattern as the PO Approval script) -------------------
    function tryMount() {
      var title = document.querySelector('[data-testid="mail-to-modal-title"]');
      if (!title) return false;
      var modal = title.closest('[role="dialog"]') || document.querySelector('.MuiDialog-root');
      if (!modal) return false;
      return arm(modal);
    }

    var pollTimer = null;
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function schedule() {
      if (!document.querySelector('[data-testid="mail-to-modal-title"]')) {
        stopPoll();
        // Gating-anchor drift check: a dialog that LOOKS like the PO mail modal
        // (Tracking # subject) but lacks the title testid this module keys on -
        // without this, a renamed title anchor reads as a benign idle state while
        // outbound email goes UNCHECKED.
        var dlg0 = document.querySelector('[role="dialog"]');
        if (dlg0 && findSubject(dlg0)) BWN.beat('leakGuard', 'miss', 'mail-like dialog open but mail-to-modal-title is missing - gating anchor drifted; DLP not armed');
        else BWN.beat('leakGuard', 'waiting', 'no mail modal open');
        return;
      }
      if (tryMount()) { stopPoll(); return; }
      if (pollTimer) return;
      var ticks = 0;
      pollTimer = setInterval(BWN.guard(function () {
        if (tryMount() || !document.querySelector('[data-testid="mail-to-modal-title"]')) { stopPoll(); return; }
        // Watchdog: only a modal that IS a PO email (Tracking # subject) counts as a
        // miss; a mail flow without one legitimately never arms - but say so, since
        // either way this email is going out without the DLP strip.
        if (++ticks === 66) {
          var t2 = document.querySelector('[data-testid="mail-to-modal-title"]');
          var root2 = t2 ? (t2.closest('[role="dialog"]') || document.querySelector('.MuiDialog-root')) : null;
          if (root2 && findSubject(root2)) BWN.beat('leakGuard', 'miss', 'mail modal open 10s but the DLP strip never armed - selector drift?');
          else BWN.beat('leakGuard', 'waiting', 'mail modal without a Tracking # subject - DLP heuristics idle for this email');
        }
      }, 'leakGuard:poll'), 150);
    }
    var obs = new MutationObserver(BWN.guard(schedule, 'leakGuard:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    schedule();
  });

  // ==========================================================================
  // MODULE: WO List Heat v3.23
  // ==========================================================================
  bwnBoot('listHeat', BWN_MODULES.listHeat, function () {
    'use strict';

    if (window.__bwnWoHeat) {
      console.warn('[BWN HEAT] duplicate instance detected \u2014 another copy is already running. Remove extra installs in Tampermonkey.');
      return;
    }
    window.__bwnWoHeat = true;

    console.info('[BWN HEAT] v3.28 loaded on', location.href);

    // ---- Config (edit here) ----------------------------------------------
    // Advanced knobs (status-class regexes + priority multipliers) now live in the
    // file-shared BWN_HEAT_CFG / bwnThresholdsFor engine above, so List Heat and WO
    // Assist judge "past its limit" identically. Aliased here so call sites below are
    // unchanged; edit the knobs in the shared block, not here.
    var HEAT_CFG = BWN_HEAT_CFG;

    // ---- BWN suite config (Phase 3): one blob, tuned once, honored everywhere.
    // Defaults + read/save now live in the BWN core (single source of truth);
    // aliased here so all call sites are unchanged. Edited via the Settings button.
    var bwnConfig = BWN.cfg;
    var bwnConfigSave = BWN.cfgSave;
    var SUM_ID = 'bwn-heat-sum';
    var PANEL_ID = 'bwn-heat-panel';
    var STYLE_ID = 'bwn-heat-style';

    // ==========================================================================
    // Umbrava API data layer + list-query CAPTURE (v3.15)
    // ==========================================================================
    // The scroll-based Scan All (below) is timing-heuristic and breaks whenever
    // Umbrava's virtualizer changes. This layer gives a DETERMINISTIC full-board
    // read instead: the SPA already fires exactly the right list GraphQL query, so
    // we PASSIVELY CAPTURE it off the wire (fetch + XHR hook) and REPLAY it with an
    // enlarged page size / cursor walk. We never hardcode Umbrava's schema - we
    // send back whatever the app sent, so schema drift is inherited for free.
    //   - Core is @grant none: a plain SAME-ORIGIN fetch to /api/graphql carries the
    //     app's own Auth0 bearer + cookies, so no new @grant / @connect is needed.
    //   - Everything degrades to the scroll Scan All: no capture, a throw, a wrong
    //     total, or a low-confidence row map all fall back and warn - never a silent
    //     partial board.
    var apiList = null;   // captured shape: { query, variables, path[], conn, ts, sample, proven }
    var apiCapTs = 0;
    var heatApiTotal = null;   // list total read off the API container (rowCount) - see umbravaTotal()
    var heatReplaying = false;   // true during our own API scan - so the hook never captures our replay pages as a "new" query

    // ---- Auto API scan (v3.17) -------------------------------------------------------
    // The board-wide numbers used to need a Scan All click even when the API scan was
    // available and instant, so My Day and the audit panel sat on "of N open loaded" -
    // the viewport - until someone remembered to press it. The capture already tells us
    // the exact query AND the filters in its variables, so when the API path is available
    // the scan can just run. Deliberate limits:
    //   - AUTO NEVER FALLS BACK TO THE SCROLL SCAN. The scroll sweep moves the user's list
    //     under them; that is fine as a deliberate click, unacceptable unannounced. No
    //     capture, no token, or a failed replay simply leaves the manual button to do it.
    //   - One scan per filter set, then a TTL, so paging around the list does not re-scan
    //     the book every few seconds for every coordinator on the suite.
    //   - Killable per browser: localStorage['bwn:heat:autoscan'] = '0'.
    var heatAutoSig = null, heatAutoTs = 0, heatAutoTimer = null;
    var HEAT_AUTO_TTL = 3 * 60 * 1000;
    function heatAutoOn() {
      try { return localStorage.getItem('bwn:heat:autoscan') !== '0'; } catch (e) { return true; }
    }
    // Filter identity = the captured variables minus whatever paging key they carry, so a
    // page/cursor move is not mistaken for a new filter set.
    function heatFilterSig(vars) {
      try {
        var c = {}, PAGING = /^(page|pagenumber|pageindex|first|limit|pagesize|take|perpage|pagelength|count|after|cursor|skip|offset|start)$/i;
        Object.keys(vars || {}).forEach(function (k) { if (!PAGING.test(k)) c[k] = vars[k]; });
        return JSON.stringify(c);
      } catch (e) { return null; }
    }

    // ---- Paging-argument discovery (v3.18) -------------------------------------------
    // Umbrava's board query takes `page: PageInput!` - an OBJECT, {skip, take} - not the
    // flat first/after/skip shape the original replay assumed. Measured against the live
    // board on 2026-08-04: writing `page: 1` makes the server reject the entire call
    // ("Variable \"$page\" got invalid value 1; Expected type \"PageInput\" to be an
    // object"), so EVERY API scan threw and fell back to the scroll sweep. Discovery now
    // looks INSIDE object-valued variables first and never coerces one to a number.
    // Returns null when nothing pages, else
    //   { host, nested, size, skip, page, cursor, pageSize }
    // where `host` is the variable holding the paging keys when nested.
    var PG_SIZE = /^(take|limit|first|pagesize|size|perpage|pagelength)$/i;
    var PG_SKIP = /^(skip|offset|start|from)$/i;
    var PG_PAGE = /^(page|pagenumber|pageindex|pagenum)$/i;
    var PG_CURSOR = /^(after|cursor)$/i;
    function heatPagingVars(vars) {
      var v = vars || {}, ks = Object.keys(v), i, j;
      for (i = 0; i < ks.length; i++) {                     // 1. nested paging object
        var val = v[ks[i]];
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        var sub = Object.keys(val), n = { host: ks[i], nested: true, size: null, skip: null, page: null, cursor: null, pageSize: 0 };
        for (j = 0; j < sub.length; j++) {
          if (n.size === null && PG_SIZE.test(sub[j])) n.size = sub[j];
          else if (n.skip === null && PG_SKIP.test(sub[j])) n.skip = sub[j];
          else if (n.page === null && PG_PAGE.test(sub[j])) n.page = sub[j];
          else if (n.cursor === null && PG_CURSOR.test(sub[j])) n.cursor = sub[j];
        }
        if (n.size !== null || n.skip !== null || n.page !== null || n.cursor !== null) {
          n.pageSize = n.size ? (Number(val[n.size]) || 0) : 0;
          return n;
        }
      }
      var f = { host: null, nested: false, size: null, skip: null, page: null, cursor: null, pageSize: 0 };
      for (i = 0; i < ks.length; i++) {                     // 2. flat paging args
        var raw = v[ks[i]];
        if (raw && typeof raw === 'object') continue;        // never coerce an object arg
        if (f.size === null && PG_SIZE.test(ks[i])) f.size = ks[i];
        else if (f.cursor === null && PG_CURSOR.test(ks[i])) f.cursor = ks[i];
        else if (f.skip === null && PG_SKIP.test(ks[i])) f.skip = ks[i];
        else if (f.page === null && PG_PAGE.test(ks[i])) f.page = ks[i];
      }
      if (f.size === null && f.cursor === null && f.skip === null && f.page === null) return null;
      f.pageSize = f.size ? (Number(v[f.size]) || 0) : 0;
      return f;
    }
    // Coverage denominator straight off the list container. The DOM badge read is not
    // always reachable (the live list logged "list badge total: not found" on 2026-08-04),
    // and rowCount is the server's own answer for the SAME filters we replayed.
    function heatContainerTotal(c) {
      if (!c || typeof c !== 'object') return null;
      var ks = ['rowCount', 'totalCount', 'totalRecords', 'total'];
      for (var i = 0; i < ks.length; i++) {
        var v = c[ks[i]];
        if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
      }
      return null;
    }
    // Board-shaped from the REQUEST alone: a work-order-named operation that pages.
    // Used when no response body is readable (the normal case - see heatRecordCapture).
    function heatQueryIsWOList(body) {
      if (!body || !body.query) return false;
      var name = String(body.operationName || '');
      if (/^(get)?workorder(details|byid)?$/i.test(name)) return false;   // single-WO reads
      var head = String(body.query).slice(0, 600);
      if (!/work\s*_?order/i.test(name) && !/work\s*_?order/i.test(head)) return false;
      return !!heatPagingVars(body.variables);
    }

    // Umbrava access token: the file-level authToken() from the BWN-SHARED block (US-1 1b);
    // the old List-Heat-local heatIsUmbravaToken/heatAuthToken were folded into it.
    // Same-origin GraphQL POST → resolves to `data`, throws on errors[].
    function heatGql(query, variables) {
      var tok = authToken();
      // Serialised ONCE and remembered, so the hook's response leg can recognise this exact
      // body as ours rather than as a fresh list query - see heatNoteOwnBody.
      var payload = JSON.stringify({ query: query, variables: variables || {} });
      heatNoteOwnBody(payload);
      return fetch('/api/graphql', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: payload
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
        return j && j.data;
      });
    }

    // A row "looks like a WO" if it carries a numeric WO number key.
    function heatLooksLikeWO(o) {
      if (!o || typeof o !== 'object') return false;
      var ks = Object.keys(o);
      for (var i = 0; i < ks.length; i++) {
        if (/(^|_)number$|workordernumber/i.test(ks[i]) && (typeof o[ks[i]] === 'number' || /^\d{3,}$/.test(String(o[ks[i]])))) return true;
      }
      return false;
    }
    // Locate the biggest WO-row array (plain array OR relay connection) inside a
    // GraphQL `data` object. Returns { path[], conn:false|'nodes'|'edges', rows[], container }.
    function heatFindWOList(data) {
      var best = null;
      (function walk(node, path, depth) {
        if (!node || typeof node !== 'object' || depth > 5) return;
        if (Array.isArray(node)) {
          var hits = 0; for (var i = 0; i < node.length; i++) if (heatLooksLikeWO(node[i])) hits++;
          if (hits >= 1 && (!best || node.length > best.rows.length)) best = { path: path.slice(), conn: false, rows: node, container: null };
          return;
        }
        if (Array.isArray(node.nodes) && node.nodes.some(heatLooksLikeWO)) {
          if (!best || node.nodes.length > best.rows.length) best = { path: path.concat('nodes'), conn: 'nodes', rows: node.nodes, container: node };
        } else if (Array.isArray(node.edges)) {
          var ns = node.edges.map(function (e) { return e && e.node; });
          if (ns.some(heatLooksLikeWO) && (!best || ns.length > best.rows.length)) best = { path: path.concat('edges'), conn: 'edges', rows: ns, container: node };
        }
        Object.keys(node).forEach(function (k) { walk(node[k], path.concat(k), depth + 1); });
      })(data, [], 0);
      return best;
    }
    // Re-walk a fresh response to the SAME list path so a replay page reads the same slot.
    function heatRowsAtPath(data, found) {
      var node = data;
      for (var i = 0; i < found.path.length; i++) { if (!node) return []; node = node[found.path[i]]; }
      if (!node) return [];
      if (found.conn === 'edges') return node.map(function (e) { return e && e.node; }).filter(Boolean);
      return Array.isArray(node) ? node : [];
    }
    // Container (the connection object) at the path's parent - carries pageInfo/totalCount.
    function heatContainerAtPath(data, found) {
      var node = data;
      for (var i = 0; i < found.path.length - 1; i++) { if (!node) return null; node = node[found.path[i]]; }
      return node || null;
    }

    // Flatten a row one level (nested objects/arrays → dotted scalar keys) then pull
    // the fields the heat model needs by key-name regex, tolerant of list-vs-detail
    // naming differences. Dates → M/D/YYYY strings so BWN.parseUSDate reads them; the
    // rest → the same string shape the DOM path stores, so every downstream consumer
    // (audit, TSV, over-30, snapshot) is unchanged.
    // `__typename` is dropped at BOTH levels (v3.18). GraphQL adds it to every object,
    // and g() below takes the FIRST key its regex matches: with __typename kept,
    // `priority.__typename` beat `priority.label` and `doNotExceed.__typename` beat
    // `doNotExceed.amount` (measured on the live board 2026-08-04), so the API scan read
    // the type name as the PRIORITY - and priority scales the status time limits, so
    // every API-scanned row got the wrong warn/bad thresholds.
    function heatFlatten(row) {
      var flat = {};
      Object.keys(row || {}).forEach(function (k) {
        if (k === '__typename') return;
        var val = row[k];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          Object.keys(val).forEach(function (k2) { if (k2 !== '__typename' && (val[k2] == null || typeof val[k2] !== 'object')) flat[k + '.' + k2] = val[k2]; });
        } else if (Array.isArray(val)) {
          if (val.length && val[0] && typeof val[0] === 'object' && 'name' in val[0]) flat[k + '.name'] = val.map(function (x) { return x && x.name; }).filter(Boolean).join(', ');
          // A list of PLAIN STRINGS was dropped entirely - the branch above only handled
          // arrays of objects, so `vendorNames` (measured live: ["FACE N SON'S LLC", ...])
          // never reached the row at all and "scheduled, but nobody assigned to it" was
          // unreadable. The key is set even for an EMPTY array, because the difference
          // between "no vendor" and "vendor list not selected" is the whole signal - the
          // reader below tests key PRESENCE, not truthiness.
          else if (val.every(function (x) { return x == null || typeof x !== 'object'; })) {
            flat[k] = val.map(function (x) { return x == null ? '' : String(x); }).filter(Boolean).join(', ');
          } else flat[k] = '';
        } else { flat[k] = val; }
      });
      return flat;
    }
    function heatDateStr(v) {
      if (v == null || v === '') return '';
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(v))) return String(v);
      var d = new Date(v); if (isNaN(+d)) return '';
      return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
    }
    // A GUID is an ID. It is never a display name, whatever its key is called.
    // Umbrava's list row carries BOTH `assignedTo` (an ID scalar) AND
    // `assignedToMemberName` ("Daniel Russell") - measured live 2026-08-04 - and g()
    // returns the FIRST key its regex matches, so the ID key won the assignee slot and
    // every audit bucket, every heat-dim filter and every TSV row was labelled with a
    // GUID. Exactly the v3.18 `priority.__typename` lesson again: match on the VALUE's
    // shape, not on the key name alone. Kept as a value test rather than a key blocklist
    // because the next id-shaped field to appear will have a name nobody predicted.
    var HEAT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function heatIsGuid(v) { return HEAT_GUID_RE.test(String(v == null ? '' : v).trim()); }
    // Money arrives in MINOR UNITS carrying its own `precision`: live 2026-08-04,
    // doNotExceed = { amount: 1448564, currency: 'USD', precision: 2 } = $14,485.64.
    // BWN.money() only FORMATS a number - it does not scale - so the API scan rendered
    // every DNE 100x over ("$1,448,564.00"), on every row, in the panel and the TSV both.
    // The old harness fixture used a FRACTIONAL amount (89871.1), which is not a shape the
    // server can emit, so the test agreed with the bug instead of catching it. The DOM path
    // was never wrong here: it reads the cell text the SPA already formatted.
    // Returns a number in major units, or null when there is nothing readable.
    function moneyNum(amt, prec) {
      if (amt === '' || amt == null) return null;
      if (typeof amt === 'string' && /[$,]/.test(amt)) {   // already formatted upstream
        var pm = BWN.parseMoney(amt); return pm === null ? BWN.parseBare(amt) : pm;
      }
      var n = parseFloat(amt);
      if (isNaN(n)) return null;
      var p = parseInt(prec, 10);
      if (!isFinite(p) || p < 0 || p > 6) p = 0;   // no precision key -> already major units
      return n / Math.pow(10, p);
    }
    function heatApiRowToEntry(row) {
      var flat = heatFlatten(row);
      var keys = Object.keys(flat);
      function g(re) { for (var i = 0; i < keys.length; i++) if (re.test(keys[i])) { var v = flat[keys[i]]; if (v != null && v !== '') return v; } return ''; }
      // g() returns the first matching KEY, so with one combined pattern the row's field
      // order decides which synonym wins. Where two synonyms mean different things - a
      // scheduled/next-onsite date is the heat model's clock, a First Trip Date is not -
      // gPref tries the patterns in PREFERENCE order instead (v3.18). Umbrava happens to
      // emit nextOnsiteDate before priority.firstTripDate today; that is luck, not a
      // contract, and getting it wrong silently moves the "sched date passed" verdict.
      function gPref(list) { for (var i = 0; i < list.length; i++) { var v = g(list[i]); if (v !== '') return v; } return ''; }
      // Like g(), but refuses a GUID value outright, and like gPref() tries the patterns
      // in preference order. Used for anything that must be HUMAN-READABLE.
      function gName(list) {
        for (var i = 0; i < list.length; i++) {
          for (var j = 0; j < keys.length; j++) {
            if (!list[i].test(keys[j])) continue;
            var v = flat[keys[j]];
            if (v != null && v !== '' && !heatIsGuid(v)) return v;
          }
        }
        return '';
      }
      // Key PRESENCE, regardless of value. An empty `vendorNames: []` is a fact ("no
      // vendor on this WO"); an absent key is the absence of a fact ("column not read").
      function has(re) { for (var i = 0; i < keys.length; i++) if (re.test(keys[i])) return true; return false; }
      var numRaw = g(/(^|\.)(workordernumber|number)$/i);
      var num = String(numRaw).replace(/\D/g, '');
      if (!num) return null;
      var status = String(g(/statusname|(^|\.)status(\.(name|label))?$|workorderstatus/i) || '');
      var prio = String(g(/priority.*(label|name)|(^|\.)priority$/i) || '');
      var client = String(g(/(^|\.)(clientname|customername|client|customer)(\.(name))?$|accountname/i) || g(/locationname/i) || '');
      // Name-shaped keys first, then the old broad pattern (now GUID-proof), then the
      // two-part case: `assignedTo { firstName lastName }` flattens to two keys and
      // neither one is the whole name, so g() would have returned just the first name.
      // WHOLE-name keys, anchored and spelled out. An unanchored `assigned.*to.*name` reads
      // as "assignedToMemberName" to a human but it also matches `assignedTo.firstName`, so
      // it took the first name and the join below never got a turn.
      var assignee = gName([/(^|\.)(assignedtomembername|assignedtoname|assigneename|assigneedisplayname|coordinatorname|coordinatormembername|ownername|membername|displayname|fullname)$/i]);
      // The two-part case comes BEFORE the broad fallback, not after it: the broad pattern
      // matches `assignedTo.firstName` on its own, so trying it first returned "Daniel" -
      // truthy, so the join never ran, and the surname was silently dropped. Caught by the
      // harness, not by reading the code.
      if (!assignee) {
        var fn = gName([/(first|given)name$/i]), ln = gName([/(last|family|sur)name$/i]);
        assignee = (fn + ' ' + ln).replace(/\s+/g, ' ').trim();
      }
      if (!assignee) assignee = gName([/assigned.*(to|user|name)|assignee|coordinator/i]);
      // The GUID is still worth keeping: it is what resolves a name (and `isInactive`)
      // through the proven user(id:) query when the board query carries no name field -
      // which is what happens whenever the Assigned To column is not in view.
      var assigneeId = String(g(/(^|\.)assigned(to|touserid|tomemberid|userid|memberid)$|(^|\.)assigneeid$|(^|\.)coordinatorid$/i) || '');
      if (!heatIsGuid(assigneeId)) assigneeId = '';
      // `doNotExceed` flattens to `doNotExceed.amount` + `doNotExceed.precision`, so the
      // amount patterns are anchored: an unanchored `.*amount` would be fine but
      // `notexceed` alone also matched the PRECISION key, and dropping the bare-object case
      // broke a board that returns a plain number. Both shapes are matched explicitly and
      // neither pattern can reach a `.precision` key. DNE and NTE are read SEPARATELY now -
      // conflating them (the old regex let a totalNTE key fill the DNE slot) would make the
      // "vendor NTE over DNE" comparison compare a number with itself.
      var dne = g(/donotexceed\.amount$|(^|\.)donotexceed$|(^|\.)dne$|notexceed\.amount$/i);
      var nte = g(/totalnte\.amount$|(^|\.)totalnte$|(^|\.)nte$/i);
      // `timeInStatus` is MINUTES. Measured against the live board 2026-08-04, three ways,
      // none of them inferred from a name:
      //   - it returned 81001 for a WO created 137 days earlier. Total age is 3288 hours,
      //     so the value cannot BE hours - 81001h is 9.2 years.
      //   - 311 of the 340 zero-day-old open WOs read above 24. Hours is impossible again.
      //   - not one WO tenant-wide exceeds 1,000,000, which rules out seconds too: a WO
      //     75 days in one status would be 6.5M.
      //   81001/60 = 1350h = 56d, which agrees with that row's own dates.
      // The DOM column is hours and the whole threshold model (hrsWarn/hrsBad -> 60/120/240)
      // is in hours, so every API-scanned row was judged against a 60x-inflated clock. That
      // is what "red 217 of 242" was: 90% of the board red, the audit's counts, the offender
      // ranking, the My Day pills and the daily trend snapshot all wrong together.
      // Units are read as SEPARATE keys rather than converted by a heuristic: a key that
      // says "hours" is trusted as hours, so if the schema ever emits an hours field no
      // guess is needed and nothing silently double-converts.
      var hrsHours = g(/hours?instatus|hrsinstatus|statushours|statushrs/i);
      var hrsMinutes = g(/timeinstatus|minutesinstatus|statusminutes/i);
      var hrs = '';
      if (hrsHours !== '' && !isNaN(parseFloat(hrsHours))) hrs = String(Math.round(parseFloat(hrsHours) * 10) / 10);
      else if (hrsMinutes !== '' && !isNaN(parseFloat(hrsMinutes))) hrs = String(Math.round(parseFloat(hrsMinutes) / 6) / 10);
      var days = g(/(^|\.)(age|days|daysopen|daysold|numberofdays)$|agedays/i);
      var created = g(/workorderdate|creationdate|createddate|datecreated|createdon/i);
      var exp = g(/expectedcompletion|completeby|completiondate/i);
      var sched = gPref([/scheduleddate|scheduledate|nextonsite|scheduledstart/i, /firsttripdate/i]);
      var lastNote = g(/lastnote.*date|lastnotedate|lastactivity|lastnoteon/i);
      var ageStr = '';
      if (days !== '' && !isNaN(parseFloat(String(days).replace(/,/g, '')))) ageStr = String(Math.round(parseFloat(String(days).replace(/,/g, ''))));
      else if (created) { var ct = BWN.parseUSDate(heatDateStr(created)); if (ct !== null) ageStr = String(dSince(ct)); }
      // The server's OWN overdue clock, in days, signed (live: remainingDays -88 on a WO
      // whose expectedCompletionDate had passed 88 days earlier - they agree exactly). It
      // is the fallback for the overdue verdict when the Expected Completion column is not
      // in view, which today turns the whole overdue check off for the entire board.
      var remRaw = g(/remainingdays|(^|\.)daysremaining$/i);
      var remDays = (remRaw !== '' && !isNaN(parseFloat(remRaw))) ? parseFloat(remRaw) : null;
      var phase = String(g(/(^|\.)phase$|lifecyclephase|systemstatusname/i) || '');
      // Vendors: the value AND whether the field was read at all (see has()).
      var vendorsKnown = has(/vendornames?$|(^|\.)vendors$|vendor\.name$/i);
      var vendors = String(g(/vendornames?$|(^|\.)vendors$|vendor\.name$/i) || '');
      // Address (in-house dispatch feed): city/state drive the coverage rule. `state` is anchored
      // to address.state - a bare top-level `state` is the INTEGER WO-state (live: state:0), never
      // the 2-letter postal code. city has only the one key after heatFlatten (address.city).
      var city = String(g(/address\.city$|(^|\.)city$/i) || '');
      var state = String(g(/address\.state$/i) || '').toUpperCase();
      // Street + zip (In-House Dispatch geocode feed). The scan already SELECTS
      // address{addressLine1 addressLine2 postalCode}; lift them onto the record so the SWA can
      // geocode a real pin, not a city centroid. Anchored to the address.* dotted keys heatFlatten
      // produces - a bare top-level key would risk the alias-orphan trap (silent '').
      var street1 = String(g(/address\.addressline1$/i) || '');
      var street2 = String(g(/address\.addressline2$/i) || '');
      var zip = String(g(/address\.postalcode$/i) || '');
      // SLA facts, straight off the row's own priority object - no parsing of display text.
      var respMin = g(/responseminutes/i);
      var slaMin = g(/servicelevelagreementminutes|slaminutes/i);
      var prioCat = String(g(/priority.*category|(^|\.)prioritycategory$/i) || '');
      // v2 dataset fields (board push -> dashboard): identity + type. Column/field-dependent like
      // assignee/lastNote - captured when the wire carries them, omitted (honest) otherwise.
      var sourceJob = String(g(/(^|\.)sourcejobnumber$|(^|\.)sourcejob$|(^|\.)jobid$|(^|\.)jobnumber$/i) || '');
      var sourcePo = String(g(/(^|\.)sourcepurchaseordernumber$|(^|\.)sourcepo$|(^|\.)purchaseordernumber$|(^|\.)ponumber$/i) || '');
      var projectType = String(g(/(^|\.)projecttypename$|(^|\.)projecttype$|(^|\.)project\.type$/i) || '');
      var dneAmt = moneyNum(dne, g(/donotexceed.*precision/i));
      var nteAmt = moneyNum(nte, g(/totalnte.*precision/i));
      // In-House Dispatch upgrade (window + trade coverage + location). locationNumber is a
      // top-level scalar. Trade names come straight off the RAW row.trades array: heatFlatten
      // collapses an array-of-objects to a single comma-joined `.name` and drops
      // systemTradeName entirely, so the flattened keys can't give both. Joined with "; ".
      var locationNumber = String(g(/(^|\.)locationnumber$/i) || '');
      var tradeArr = (row && Array.isArray(row.trades)) ? row.trades : [];
      var trade = tradeArr.map(function (t) { return t && t.name; }).filter(Boolean).join('; ');
      var tradeSys = tradeArr.map(function (t) { return t && t.systemTradeName; }).filter(Boolean).join('; ');
      return {
        // Through heatKey so the API writer and the DOM writer cannot drift apart again.
        href: heatKey('/work-orders/' + num),
        entry: {
          id: num, wo: String(numRaw), tracking: String(g(/trackingnumber|(^|\.)tracking$/i) || '').replace(/\D+/g, ''),
          status: status, prio: prio, client: client, assignee: cleanName(assignee),
          assigneeId: assigneeId,
          hrs: hrs, days: ageStr,
          dne: (dneAmt === null ? '' : BWN.money(dneAmt)),
          nte: (nteAmt === null ? '' : BWN.money(nteAmt)),
          dneAmt: dneAmt, nteAmt: nteAmt,
          phase: phase, vendors: vendors, vendorsKnown: vendorsKnown, remDays: remDays,
          city: city, state: state, street1: street1, street2: street2, zip: zip,
          sla: {
            responseMinutes: (respMin !== '' && !isNaN(parseFloat(respMin))) ? parseFloat(respMin) : null,
            slaMinutes: (slaMin !== '' && !isNaN(parseFloat(slaMin))) ? parseFloat(slaMin) : null,
            category: prioCat
          },
          sched: heatDateStr(sched), lastNote: heatDateStr(lastNote), exp: heatDateStr(exp),
          // v2 dataset fields - carried into heatStore by absorb() and emitted by heatDatasetRows.
          sourceJob: sourceJob, sourcePo: sourcePo, projectType: projectType, woDate: heatDateStr(created),
          // In-House Dispatch upgrade: raw created timestamp (woDate truncates the time), location #, trades.
          woCreatedAt: (created == null ? '' : String(created)), locationNumber: locationNumber, trade: trade, tradeSys: tradeSys,
          // T10: the client's tenant profile id (the query already selects it) - carried so the
          // next-step engine can record it alongside the resolved client profile.
          clientTenantProfileId: String(g(/(^|\.)clienttenantprofileid$/i) || '')
        }
      };
    }

    // Record a captured list query. THE REQUEST ALONE IS ENOUGH (v3.18).
    // v3.15-3.17 only latched when the RESPONSE body could be read, via the
    // `res.clone().json()` in the hook. That is a RACE, not a read: the app aborts
    // its own fetches on teardown, and a clone only buffers while someone is still
    // reading it. Measured 2026-08-04 - with one more clone reader on the same responses,
    // EVERY clone read of EVERY operation rejected with AbortError and apiList stayed
    // null for the whole session, so nothing could scan; alone, the same read usually
    // wins. A latch that works only when nothing else is listening is not a latch. The
    // request body carries the query text and the filters, which is everything the replay
    // needs, and it is ours synchronously; a response, when one does survive, only
    // UPGRADES the capture with the row path and a sample. The replay validates the shape
    // either way, so a wrong guess falls back honestly instead of reporting a partial board.
    function heatRecordCapture(reqBody, data) {
      heatDiag.seen++;
      if (heatReplaying) { heatDiag.replaySkip++; return; }   // don't re-capture our own enlarged replay pages
      // ...and the same again by IDENTITY, because the line above is not enough: the hook
      // fires a second time when the response resolves, by which point finishApi has already
      // set heatReplaying = false. That second call is what closed the retry loop.
      if (heatIsOwnBody(typeof reqBody === 'string' ? reqBody : null)) { heatDiag.ownSkip++; return; }
      // (v3.16) The board query only fires on the WO-list route. A WO-details page fires
      // reads like purchaseOrders(workOrderNumber) whose PO rows carry a numeric `number`
      // and so masquerade as WO rows; gate to the list route so a details read can never
      // latch (real board content is also required below).
      if (!isListPage()) return;
      try {
        var body = (typeof reqBody === 'string') ? JSON.parse(reqBody) : reqBody;
        if (!body || !body.query) return;
        // A response, if we got one, still earns the stronger latch: only accept an
        // operation whose rows genuinely map to WOs - a real WO number AND at least one
        // substantive board field (status/prio/client/assignee/age/hrs/dne/dates). A
        // details-page purchaseOrders read maps its PO `number` into the WO slot but
        // leaves every board field blank, so that check keeps it from mis-latching.
        var found = data ? heatFindWOList(data) : null;
        if (found && !found.rows.length) found = null;
        var probe = found ? heatApiRowToEntry(found.rows[0]) : null;
        var pe = probe ? probe.entry : null;
        var respProves = !!(pe && (pe.status || pe.prio || pe.client || pe.assignee || pe.days || pe.hrs || pe.dne || pe.sched || pe.lastNote || pe.exp));
        // Same query text = the same operation the board already latched, so this is a
        // filter change, not a rival query: refresh the variables (and re-scan) instead of
        // letting the anti-downgrade guard below drop it. Without this, filtering to a
        // SMALLER set within 60s left the captured variables stale, so a scan - manual or
        // auto - replayed the previous filter set (v3.17).
        if (apiList && body.query === apiList.query) {
          var sameVars = heatFilterSig(body.variables) === heatFilterSig(apiList.variables);
          apiList.variables = body.variables || {};
          apiList.seeded = false;   // a real request carrying the same query text upgrades the pinned seed to a live capture
          apiCapTs = Date.now();
          if (respProves) {
            apiList.path = found.path; apiList.conn = found.conn;
            apiList.sample = pe; apiList._rows = found.rows.length; apiList.proven = true;
          } else if (!sameVars) apiList._rows = 0;
          heatDiag.rearm++;
          heatAutoScanSoon(apiList.variables);
          return;
        }
        if (!respProves && !heatQueryIsWOList(body)) return;
        // Anti-downgrade: a capture the replay has already PROVEN (or one a response
        // verified) is never displaced by a request-only guess from another operation,
        // and a fresh request-only latch holds for a minute so two board-shaped
        // operations on one page cannot fight over the slot every few seconds.
        if (apiList && !apiList.seeded && !respProves && (apiList.proven || (Date.now() - apiCapTs) < 60000)) return;
        if (apiList && respProves && apiList.proven && found.rows.length < (apiList._rows || 0) && (Date.now() - apiCapTs) < 60000) return;
        apiList = {
          query: body.query, variables: body.variables || {},
          path: found ? found.path : null, conn: found ? found.conn : false,
          _rows: found ? found.rows.length : 0, sample: pe || null, proven: respProves
        };
        apiCapTs = Date.now();
        console.info('[BWN HEAT] captured list query (' + (body.operationName || 'anonymous') + ': ' +
          (respProves ? found.rows.length + ' rows, path ' + found.path.join('.') + (found.conn ? '/' + found.conn : '')
            : 'request-only, row path resolved on the first replay page') + ') - API scan available.');
        // A capture is also the moment a filter change lands, so this is the one trigger
        // that keeps the book-wide numbers in step with the list without a click (v3.17).
        heatDiag.rearm++;
        heatAutoScanSoon(apiList.variables);
      } catch (e) { /* capture is best-effort */ }
    }

    // ---- Requests this module put on the wire (2026-08-09) --------------------------
    // WHY THIS EXISTS. The document-start hook calls its sink TWICE per request: once with
    // the request body, and again when the response resolves. `heatReplaying` gates only the
    // first - by the time the RESPONSE call arrives, finishApi has already cleared it. So the
    // scan's own replay came back through heatRecordCapture, matched
    // `body.query === apiList.query`, and re-armed heatAutoScanSoon. Paired with a dirty
    // finish (which nulls heatStore, the thing the auto-scan guard used to suppress on) that
    // is an unbounded retry loop: MEASURED live 2026-08-09 at one replay every ~770ms,
    // indefinitely, with no visible symptom on the page. See wiki/dirty-scan-retry-loop.md.
    //
    // A flag cannot fix this, because the flag is legitimately false by then. Identity can:
    // remember the exact bodies we sent and never treat one as a new list query.
    // Read-only instrumentation for the auto-scan trigger path (2026-08-09). Exists because
    // black-box testing could eliminate stuck flags and a lost capture, but could NOT separate
    // "the capture never fired" from "the guard suppressed the scan" - and the failure is
    // intermittent, so guessing was not going to settle it. Counters only; see __bwnHeatDiag.
    var heatDiag = { seen: 0, replaySkip: 0, ownSkip: 0, rearm: 0, autoRan: 0, autoNoBackoff: 0, autoNoTtl: 0, autoNoGate: 0 };
    var heatOwnBodies = Object.create(null), heatOwnBodyQ = [];
    var HEAT_OWN_BODIES_MAX = 64;   // a few pages per scan; bounded so a long-lived tab cannot grow it
    function heatNoteOwnBody(s) {
      if (typeof s !== 'string' || heatOwnBodies[s]) return;
      heatOwnBodies[s] = 1;
      heatOwnBodyQ.push(s);
      while (heatOwnBodyQ.length > HEAT_OWN_BODIES_MAX) delete heatOwnBodies[heatOwnBodyQ.shift()];
    }
    function heatIsOwnBody(s) { return typeof s === 'string' && !!heatOwnBodies[s]; }

    // Attach to the hook (v3.21). The fetch/XHR wrap itself moved to the top of this
    // file and runs at document-start, because installing it here - at module-init
    // time - lost a straight race with the SPA's own boot queries on roughly half of
    // page loads, and a capture that never happens is an auto-scan that never runs.
    // See the BOOT block for the four-reload measurement. Everything that DECIDES
    // whether a request is the board query still lives in heatRecordCapture; the hook
    // is deliberately ignorant. The drain replays whatever the app fired before this
    // module existed, which on a normal arrival is the board query itself.
    (function attachNetHook() {
      var replayed = bwnGqlSetSink(function (body, data) { heatRecordCapture(body, data); });
      console.info('[BWN HEAT] attached to the document-start GraphQL hook' +
        (replayed ? ' - replayed ' + replayed + ' request(s) captured before this module loaded.' : ' - no earlier requests buffered.'));
    })();

    // ---- Helpers ------------------------------------------------------------
    function todayMid() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    var parseUSDate = BWN.parseUSDate;
    function dUntil(ts) { return Math.ceil((ts - todayMid()) / 86400000); }
    function dSince(ts) { return Math.floor((todayMid() - ts) / 86400000); }
    function rowWOLink(el) {
      var as = el.querySelectorAll('a[href^="/work-orders/"]');
      for (var i = 0; i < as.length; i++) {
        if (/\/work-orders\/\d+/.test(as[i].getAttribute('href') || '')) return as[i];
      }
      return null;
    }
    // heatStore's KEY, and the ONE place that decides its shape (v3.20). Two writers fill
    // that store - the API scan and the DOM tinting pass - and they were producing
    // DIFFERENT strings for the same WO, so every row on screen was stored TWICE and the
    // board count grew as the virtualizer rendered more. Measured live 2026-08-04: the
    // list row's link is "/work-orders/371126/details" (a route suffix), the API path built
    // "/work-orders/371126", and a ONE-row board announced "of 2 open - full board".
    // The bare route redirects to /details, so the canonical key is still a working href
    // for the audit panel's links. Returns null when there is no WO id to key on.
    function heatKey(href) {
      var m = String(href || '').match(/\/work-orders\/(\d+)/);
      return m ? '/work-orders/' + m[1] : null;
    }
    function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        'tr.bwn-heat-bad>td{background:rgba(176,58,46,.16)!important;}' +
        'tr.bwn-heat-bad>td:first-child{box-shadow:inset 4px 0 0 var(--bwn-bad-fg);}' +
        'tr.bwn-heat-warn>td{background:rgba(230,126,34,.10)!important;}' +
        'tr.bwn-heat-warn>td:first-child{box-shadow:inset 3px 0 0 var(--bwn-warn);}' +
        'tr.bwn-heat-dim>td{opacity:.18;filter:grayscale(.8);}' +
        'tr.bwn-heat-acked>td{background:transparent!important;}' +
        'tr.bwn-heat-acked>td:first-child{box-shadow:inset 3px 0 0 var(--bwn-border);}' +
        '#bwn-heat-panel .dl{padding:8px 14px;border-bottom:1px solid var(--bwn-border-2);font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-muted);display:flex;gap:14px;flex-wrap:wrap;}' +
        '#bwn-heat-panel .dl .up{color:var(--bwn-bad);}#bwn-heat-panel .dl .down{color:var(--bwn-green);}' +
        '#bwn-heat-panel .orow .sz{flex:none;margin-left:auto;padding:2px 8px;border:1px solid var(--bwn-border);border-radius:6px;background:var(--bwn-surface-2);color:var(--bwn-text-muted);font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;cursor:pointer;}' +
        '#bwn-heat-panel .orow .sz:hover{background:var(--bwn-tint);color:var(--bwn-green);}' +
        'td.bwn-note-age::after{content:" \u00b7 " attr(data-bwn-age) "d";font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-left:2px;white-space:nowrap;}' +
        'td.bwn-note-age.bwn-note-stale::after{color:var(--bwn-bad-fg);font-weight:500;}' +
        '#bwn-heat-sum{display:flex;gap:8px;align-items:center;margin:6px 0;padding:8px 12px;border-radius:10px;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;flex-wrap:wrap;}' +
        '#bwn-heat-sum .t{font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#fff;letter-spacing:.5px;}' +
        '#bwn-heat-sum .c{padding:3px 10px;border-radius:10px;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;cursor:pointer;border:1px solid transparent;}' +
        '#bwn-heat-sum .c.bad{background:var(--bwn-bad);color:#fff;}' +
        '#bwn-heat-sum .c.warn{background:var(--bwn-warn);color:#fff;}' +
        '#bwn-heat-sum .c.ok{background:var(--bwn-accent);color:var(--bwn-green-dk);cursor:default;}' +
        '#bwn-heat-sum .c.filt{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35);}' +
        '#bwn-heat-sum .lg{margin-left:auto;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.7);}' +
        '#bwn-heat-sum button{padding:5px 12px;border:none;border-radius:8px;cursor:pointer;font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);background:var(--bwn-tint);}' +
        '#bwn-heat-sum button:hover{filter:brightness(1.05);}' +
        '#bwn-heat-sum button:disabled{opacity:.6;cursor:default;}' +
        '#bwn-heat-panel{margin:0 0 8px;border:1px solid var(--bwn-border);border-radius:12px;background:var(--bwn-surface);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.12);}' +
        '#bwn-heat-panel .ph{background:var(--bwn-tint);padding:9px 14px;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);letter-spacing:.6px;border-bottom:1px solid var(--bwn-tint);}' +
        '#bwn-heat-panel .cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;border-bottom:1px solid var(--bwn-border-2);}' +
        '#bwn-heat-panel .col{padding:10px 14px;border-right:1px solid var(--bwn-border-2);min-width:0;}' +
        '#bwn-heat-panel .col:last-child{border-right:none;}' +
        '#bwn-heat-panel .col h4{margin:0 0 6px;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);text-transform:none;letter-spacing:normal;}' +
        '#bwn-heat-panel .kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;color:var(--bwn-text-muted);}' +
        '#bwn-heat-panel .kv .k{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '#bwn-heat-panel .kv .v{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;white-space:nowrap;}' +
        '#bwn-heat-panel .kv .v.bad{color:var(--bwn-bad);}' +
        '#bwn-heat-panel .kv.click{cursor:pointer;border-radius:6px;padding-left:5px;padding-right:5px;margin:0 -5px;}' +
        '#bwn-heat-panel .kv.click:hover{background:var(--bwn-tint);}' +
        '#bwn-heat-panel .kv.on{background:var(--bwn-tint);box-shadow:inset 2px 0 0 var(--bwn-accent);}' +
        '#bwn-heat-panel .off{padding:8px 14px 12px;}' +
        '#bwn-heat-panel .off h4{margin:2px 0 6px;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);text-transform:none;letter-spacing:normal;}' +
        '#bwn-heat-panel .orow{display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--bwn-surface-3);font-size:12px;}' +
        '#bwn-heat-panel .orow a{font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);text-decoration:none;white-space:nowrap;}' +
        '#bwn-heat-panel .orow .cl{color:var(--bwn-text-muted);white-space:nowrap;}' +
        '#bwn-heat-panel .orow .rs{color:var(--bwn-bad-fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        // The next step is the prescription, not the symptom: green, and it must not
        // compete with .rs for the flexible width (the reasons stay the truncating one).
        '#bwn-heat-panel .orow .ns{flex:none;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bwn-green);font-weight:500;}' +
        '#bwn-heat-panel .pf{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;background:var(--bwn-surface-2);border-top:1px solid var(--bwn-border-2);}' +
        '#bwn-heat-panel .pf .hint{margin-right:auto;font:10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);align-self:center;}' +
        '#bwn-heat-panel button{padding:7px 14px;border:none;border-radius:8px;cursor:pointer;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);background:var(--bwn-tint);}' +
        '#bwn-heat-panel button.primary{color:#fff;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));}' +
        '#bwn-heat-panel button:hover{filter:brightness(1.05);}' +
        '#bwn-heat-sum .c:focus-visible,#bwn-heat-sum button:focus-visible,#bwn-heat-panel button:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}' +
        '#bwn-heat-sum .ratio{display:flex;width:150px;height:8px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.15);}' +
        '#bwn-heat-sum .ratio span{height:100%;transition:width .35s ease;}' +
        '#bwn-heat-sum .ratio .rb{background:var(--bwn-bad);}#bwn-heat-sum .ratio .rw{background:var(--bwn-warn);}#bwn-heat-sum .ratio .rg{background:var(--bwn-accent);}' +
        '#bwn-heat-prog{flex-basis:100%;height:3px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden;display:none;}' +
        '#bwn-heat-prog .fill{height:100%;width:0;background:var(--bwn-accent);transition:width .25s ease;}' +
        '#bwn-heat-prog.indet .fill{width:30%;animation:bwnIndet 1.1s linear infinite;}' +
        '@keyframes bwnIndet{from{transform:translateX(-100%)}to{transform:translateX(400%)}}' +
        '#bwn-heat-panel{animation:bwnPanelIn .18s ease-out;}' +
        '@keyframes bwnPanelIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}' +
        '#bwn-heat-panel .empty{padding:22px 16px;text-align:center;}' +
        '#bwn-heat-panel .empty p{margin:0 0 12px;font-size:13px;color:var(--bwn-text-muted);}' +
        '#bwn-heat-set{margin:0 0 8px;border:1px solid var(--bwn-border);border-radius:12px;background:var(--bwn-surface);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.12);animation:bwnPanelIn .18s ease-out;}' +
        '#bwn-heat-set .ph{background:var(--bwn-tint);padding:9px 14px;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);letter-spacing:.6px;border-bottom:1px solid var(--bwn-tint);}' +
        '#bwn-heat-set .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:14px 16px;}' +
        '#bwn-heat-set label{display:block;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);margin-bottom:4px;}' +
        '#bwn-heat-set input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--bwn-border);border-radius:8px;font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-align:right;outline:none;}' +
        '#bwn-heat-set input:focus{border-color:var(--bwn-accent);box-shadow:0 0 0 3px rgba(46,204,113,.15);}' +
        '#bwn-heat-set .pf{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;background:var(--bwn-surface-2);border-top:1px solid var(--bwn-border-2);}' +
        '#bwn-heat-set .pf .hint{margin-right:auto;font:10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);align-self:center;}' +
        '#bwn-heat-set button{padding:7px 14px;border:none;border-radius:8px;cursor:pointer;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);background:var(--bwn-tint);}' +
        '#bwn-heat-set button.primary{color:#fff;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));}' +
        // #bwn-heat-set was added 2026-08-10: it runs the SAME bwnPanelIn entrance as
        // #bwn-heat-panel and this query had only ever named the panel, so the settings card
        // animated for a reduced-motion user. Found by enumerating every animation: declaration
        // in this file rather than by looking - the same hole had shipped in three other places.
        '@media (prefers-reduced-motion: reduce){#bwn-heat-sum .ratio span,#bwn-heat-prog .fill{transition:none;}#bwn-heat-panel,#bwn-heat-set{animation:none;}#bwn-heat-prog.indet .fill{animation:none;width:100%;}}' +
        '#bwn-myday{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 8px;padding:8px 12px;border:1px solid var(--bwn-border);border-radius:10px;background:var(--bwn-surface);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '#bwn-myday .md-t{font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);letter-spacing:.5px;}' +
        '#bwn-myday .md-c{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:10px;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;}' +
        '#bwn-myday .md-c.bad{background:var(--bwn-bad-fg);color:#fff;}' +
        '#bwn-myday .md-c.warn{background:var(--bwn-warn-bg);color:var(--bwn-warn-fg);}' +
        '#bwn-myday .md-c.zero{background:var(--bwn-tint);color:var(--bwn-green);}' +
        '#bwn-myday .md-c[role="button"]{cursor:pointer;}' +
        '#bwn-myday .md-c.filt{box-shadow:0 0 0 2px rgba(26,95,62,.55);}' +
        '#bwn-myday .md-d{font:500 9px ui-monospace,"Segoe UI Mono","SF Mono",monospace;padding:1px 5px;border-radius:6px;}' +
        '#bwn-myday .md-d.up{background:rgba(255,255,255,.22);color:var(--bwn-bad-bg);}' +
        '#bwn-myday .md-d.down{background:rgba(255,255,255,.22);color:var(--bwn-accent);}' +
        '#bwn-myday .md-d.flat{background:rgba(255,255,255,.18);color:#fff;}' +
        '#bwn-myday .md-m{margin-left:auto;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}';
      document.head.appendChild(st);
    }

    // ---- Page + table discovery -------------------------------------------------
    function isListPage() {
      var p = location.pathname;
      return p.indexOf('/work-orders') === 0 && !/\/work-orders\/\d/.test(p);
    }
    function findBodyTable() {
      var tables = document.querySelectorAll('table');
      for (var i = 0; i < tables.length; i++) {
        if (rowWOLink(tables[i])) return tables[i];
      }
      return null;
    }
    // ---- Header discovery (column-layout-agnostic, v3.11 overhaul) -----------
    // Umbrava renders the WO list as TWO tables - a header-only table (whose thead
    // also holds an empty filter row) and a separate body table carrying the WO
    // links, with NO thead of its own (recon 2026-07-10; no data-testids anywhere).
    // Columns are user-configurable (chooser + drag), so nothing here may assume a
    // fixed set, order, or a sentinel column - v3.10 required "Time in Status" just
    // to FIND the header, so hiding that one column killed the whole overlay even
    // though # Days / Last Note Date were still on screen (user-reported). Now:
    //   1. header row = the body table's own thead row when present, else the ROW
    //      (any table, first few rows) matching the most known column names -
    //      row-scoped, so the flattened filter-row empties can never pad the map;
    //   2. names match by SYNONYM predicates, so variants ("Time in Status (hrs.)",
    //      "Days", "Assigned To") all land regardless of order;
    //   3. indices are re-anchored to the BODY rows via the WO-link cell (alignMap)
    //      - a leading checkbox column on one side but not the other shifts every
    //      index by the measured delta instead of silently misreading columns.
    // A missing column disables ONLY its own signal (reported via diag/beat and the
    // banner tooltip) - the overlay always does its best with what's on screen.
    var HDR_KNOWN = /^(wo #?|wo number|tracking #|status|wo status|priority|# ?days|days|age|client|trades|city|state|dne|nte|created)$|time in status|hrs in status|hours in status|last note|assigned to|assignee|coordinator|expected completion|complete by|completion date|scheduled date|schedule date|next onsite|client dne|source job|scope of work|location #|wo date|date created/;
    function headerRowCells() {
      var bt = findBodyTable();
      if (bt) {
        var own = bt.querySelector('thead tr');
        if (own && own.cells && own.cells.length) return own.cells;
      }
      function score(cells) {
        var n = 0;
        for (var i = 0; i < cells.length; i++) {
          if (HDR_KNOWN.test((cells[i].textContent || '').replace(/\s+/g, ' ').trim().toLowerCase())) n++;
        }
        return n;
      }
      var best = null, bestN = 1;   // ≥2 known names to qualify as the header row
      var tables = document.querySelectorAll('table');
      for (var t = 0; t < tables.length; t++) {
        var rmax = Math.min(tables[t].rows.length, 4);   // headers live in the first rows
        for (var r = 0; r < rmax; r++) {
          var cells = tables[t].rows[r].cells;
          if (!cells || !cells.length) continue;
          var s = score(cells);
          if (s > bestN) { bestN = s; best = cells; }
        }
      }
      if (best) return best;
      var chs = document.querySelectorAll('[role="columnheader"]');
      return (chs.length && score(chs) >= 2) ? chs : null;
    }
    function headerMap() {
      var cells = headerRowCells();
      if (!cells) return null;
      var names = [];
      for (var i = 0; i < cells.length; i++) {
        names.push((cells[i].textContent || '').replace(/\s+/g, ' ').trim().toLowerCase());
      }
      function find(pred) { for (var j = 0; j < names.length; j++) { if (names[j] && pred(names[j])) return j; } return -1; }
      return {
        wo: find(function (n) { return n === 'wo #' || n === 'wo#' || n === 'wo number' || n === 'wo'; }),
        tracking: find(function (n) { return n === 'tracking #' || n === 'tracking'; }),
        status: find(function (n) { return n === 'status' || n === 'wo status'; }),
        client: find(function (n) { return n === 'client'; }),
        assignee: find(function (n) { return n.indexOf('assigned to') !== -1 || n === 'assignee' || n === 'coordinator'; }),
        days: find(function (n) { return n === '# days' || n === 'days' || n === 'age' || n.indexOf('# day') === 0; }),
        hrs: find(function (n) { return n.indexOf('time in status') !== -1 || n.indexOf('hrs in status') !== -1 || n.indexOf('hours in status') !== -1; }),
        dne: find(function (n) { return n.indexOf('client dne') !== -1 || n === 'dne' || n === 'nte'; }),
        prio: find(function (n) { return n === 'priority'; }),
        exp: find(function (n) { return n.indexOf('expected completion') !== -1 || n.indexOf('complete by') !== -1 || n.indexOf('completion date') !== -1; }),
        sched: find(function (n) { return n.indexOf('scheduled date') !== -1 || n.indexOf('schedule date') !== -1 || n.indexOf('next onsite') !== -1; }),
        lastNote: find(function (n) { return n.indexOf('last note') !== -1; }),
        created: find(function (n) { return n === 'wo date' || n === 'created' || n.indexOf('date created') !== -1; }),
        // v2 dataset columns (board push -> dashboard). WO Date reuses `created`.
        sourceJob: find(function (n) { return n === 'job id' || n === 'job #' || n.indexOf('source job') !== -1; }),
        sourcePo: find(function (n) { return n.indexOf('source po') !== -1 || n === 'po #' || n.indexOf('purchase order') !== -1; }),
        projectType: find(function (n) { return n === 'project type' || n === 'service type'; }),
        names: names
      };
    }
    // Anchor the header indices to the BODY rows: the cell that holds the WO link is
    // ground truth for where "WO #" actually renders; shift every index by the delta.
    var HDR_FIELDS = ['wo', 'tracking', 'status', 'client', 'assignee', 'days', 'hrs', 'dne', 'prio', 'exp', 'sched', 'lastNote', 'created', 'sourceJob', 'sourcePo', 'projectType'];
    function alignMap(H, table) {
      if (!H || !table || H.wo < 0) return H;
      var delta = 0, rows = table.querySelectorAll('tbody tr');
      if (!rows.length) rows = table.rows;
      for (var i = 0; i < rows.length; i++) {
        var link = rowWOLink(rows[i]);
        if (!link) continue;
        var td = link.closest ? link.closest('td') : null;
        if (td && td.cellIndex >= 0) delta = td.cellIndex - H.wo;
        break;
      }
      if (!delta) return H;
      var out = { names: H.names };
      HDR_FIELDS.forEach(function (k) { out[k] = H[k] >= 0 ? H[k] + delta : -1; });
      return out;
    }
    function cellText(tr, i) {
      return (i >= 0 && tr.cells && tr.cells[i]) ? (tr.cells[i].textContent || '').replace(/\s+/g, ' ').trim() : '';
    }
    // Umbrava's avatar chip leaks its initials into the cell text ("MZMatthew
    // Zozimo"). Strip a leading 2-3 capital run when a capitalized name follows.
    function cleanName(s) {
      return (s || '').replace(/^[A-Z]{2,3}(?=[A-Z][a-z])/, '').trim();
    }

    // Umbrava's own total badge next to the "Work Orders" title = ground truth
    // for how many WOs the list holds. Used to judge scan coverage honestly.
    var totCache = { path: '', v: null };
    function umbravaTotal() {
      if (totCache.path === location.pathname && totCache.v !== null) return totCache.v;
      function digitNear(el) {
        var scope = el.parentElement;
        for (var hop = 0; hop < 2 && scope; hop++) {
          var cands = scope.querySelectorAll('span,div');
          for (var j = 0; j < cands.length; j++) {
            var t = (cands[j].textContent || '').trim();
            if (cands[j] !== el && cands[j].children.length === 0 && /^\d{1,5}$/.test(t)) return parseInt(t, 10);
          }
          scope = scope.parentElement;
        }
        return null;
      }
      var v = null;
      // Prefer the page TITLE (a real heading) over nav items or anything else.
      var heads = document.querySelectorAll('h1,h2,h3,h4');
      for (var i = 0; i < heads.length && v === null; i++) {
        if ((heads[i].textContent || '').trim() === 'Work Orders') v = digitNear(heads[i]);
      }
      if (v === null) {
        // Fallback: any 'Work Orders' element; take the LARGEST nearby digit so a
        // stray small counter cannot masquerade as the list total.
        var best = null;
        var els = document.querySelectorAll('div,span');
        for (var k = 0; k < els.length; k++) {
          if ((els[k].textContent || '').trim() !== 'Work Orders') continue;
          var d = digitNear(els[k]);
          if (d !== null && (best === null || d > best)) best = d;
        }
        v = best;
      }
      // Last resort: the total the API scan read off the list container. The live list
      // logged "list badge total: not found" on 2026-08-04, and a scan with no denominator
      // cannot tell a full board from a partial one.
      if (v === null && heatApiTotal !== null) v = heatApiTotal;
      totCache = { path: location.pathname, v: v };
      return v;
    }

    // ---- Acknowledge / snooze (v3.8) -------------------------------------------
    // A coordinator can snooze a flagged WO's CURRENT problem set for 3 days from
    // the Audit panel. The snooze is keyed to the stable problem KINDS (limitbad,
    // overdue, schedpassed, stale, …) - never to display strings, whose embedded
    // counters change hourly - so it survives re-renders but clears itself the
    // moment a NEW kind of problem appears. Fails alarming, never silent.
    var ACK_KEY = 'bwn:ack';
    var ACK_DAYS = 3;
    function ackSig(kinds) { return kinds.slice().sort().join('|'); }
    function ackGet(id, kinds) {
      if (!id || !kinds.length) return false;
      var a = (BWN.lsGetJSON(ACK_KEY, {}) || {})[id];
      return !!(a && a.exp > Date.now() && a.k === ackSig(kinds));
    }
    function ackSet(id, kinds) {
      var all = BWN.lsGetJSON(ACK_KEY, {}) || {};
      all[id] = { k: ackSig(kinds), exp: Date.now() + ACK_DAYS * 86400000 };
      Object.keys(all).forEach(function (k2) { if (!(all[k2].exp > Date.now())) delete all[k2]; });
      var ks = Object.keys(all);
      if (ks.length > 300) { ks.sort(function (x, y) { return all[x].exp - all[y].exp; }); while (ks.length > 300) delete all[ks.shift()]; }
      BWN.lsSetJSON(ACK_KEY, all);
    }
    function ackClear(id) { var all = BWN.lsGetJSON(ACK_KEY, {}) || {}; delete all[id]; BWN.lsSetJSON(ACK_KEY, all); }

    // ---- Daily full-scan snapshots (v3.8) ----------------------------------------
    // Written only on a CLEAN Scan All convergence, so a partial sweep can never
    // masquerade as the day's board state. Read by the Audit panel's delta strip.
    var SNAP_KEY = 'bwn:heat:snap';
    function heatSnapshot() {
      try {
        if (!heatStore) return;
        var s = { bad: 0, warn: 0, open: 0, over30: 0 };
        Object.keys(heatStore).forEach(function (k) {
          var e = heatStore[k];
          if (heatDone(e.status, e.phase)) return;
          s.open++;
          if (e.sev === 2) s.bad++; else if (e.sev === 1) s.warn++;
          var age = parseFloat(String(e.days || '').replace(/,/g, ''));
          if (!isNaN(age) && age > 30) s.over30++;
        });
        var snaps = BWN.lsGetJSON(SNAP_KEY, {}) || {};
        snaps[mydayDateKey()] = s;
        var ks = Object.keys(snaps).sort();
        while (ks.length > 14) delete snaps[ks.shift()];
        BWN.lsSetJSON(SNAP_KEY, snaps);
      } catch (e) { /* best-effort */ }
    }

    // ---- Is this row finished? ONE place (v3.22) ------------------------------------
    // Every "open" count in this module, and the verdict engine itself, asks this. Two
    // signals, in a deliberate order of authority:
    //   1. `phase` - Umbrava's own lifecycle field. A terminal phase means over, full stop.
    //   2. `phase` again - an explicitly ACTIVE phase VETOES the status-name guess below.
    //   3. the status NAME - free text, and a guess. Only reachable when no phase was read.
    //
    // Step 2 is the fix. Measured on the live board 2026-08-05: 218 rows, every one
    // phase "Open", and the strip announced "of 199 open". The 19 missing rows all sat in
    // status "Clocked Out: Complete" - the tech has clocked out saying their visit is done,
    // the WO is still Open and still owes cost review and close-out. The name regex matched
    // the word "Complete" and muted all 19 everywhere at once: out of the open denominator,
    // never tinted, absent from the My Day pills, the audit table, the offender ranking, the
    // over-30 batch and the daily snapshot. 5 of them were over 30 days old and 10 were past
    // their complete-by date, so they were the LAST rows that should have been silent.
    // Core's own action taxonomy already knew better - WO_PHASE maps 'clocked out: complete'
    // to 'costreview', explicitly NOT terminal - so the two halves of this file disagreed.
    //
    // The active list is a WHITELIST, not "anything that is not terminal", and it stays
    // targeted. ConfirmComplete was ADDED 2026-08-18 after measuring it: 5 live WOs, all
    // status "Confirm Complete", 3 of 5 over 30 days and 3 of 5 past complete-by, every one
    // silenced by the name regex matching "complete" - and WO_PHASE already maps
    // 'confirm complete' to a non-terminal 'confirmcomplete', so this file had been
    // contradicting Core (its sibling ConfirmReopen was already whitelisted). WorkComplete
    // stays name-based ON PURPOSE: it holds ~300k terminal billing WOs (Paid / Invoiced), so
    // whitelisting it would surface the whole archive as open. This change can only ever
    // REMOVE silence, and only on a row the server itself calls active.
    var HEAT_DONE_STATUS_RE = /complete|invoiced|closed|cancel/i;
    var HEAT_TERMINAL_PHASE_RE = /^(closed|cancel|canceled|cancelled|declined|revoked)/i;
    var HEAT_ACTIVE_PHASE_RE = /^(open|on[\s-]?hold|pending\s?acceptance|confirm\s?reopen|confirm\s?complete)$/i;
    function heatDone(status, phase) {
      var ph = String(phase == null ? '' : phase).trim();
      if (HEAT_TERMINAL_PHASE_RE.test(ph)) return true;    // the server says it is over
      if (HEAT_ACTIVE_PHASE_RE.test(ph)) return false;     // the server says it is NOT - beats the name
      return HEAT_DONE_STATUS_RE.test(String(status == null ? '' : status));
    }

    // ---- Audit panel: open-row tally (v3.28) ----------------------------------------
    // The "since last scan" counts the Audit panel's delta strip shows - open, red, amber,
    // over-30 and the age buckets - over the OPEN rows only. Factored out of toggleAuditPanel
    // (~250 lines of DOM building) so the heatDone gate that decides "open" HERE is testable
    // without a fake DOM; test-heat-open-count.js slices it, the same way it already slices the
    // other four callers. This is the FIFTH heatDone site (v3.22): a done row is excluded from
    // every count, applied once more at DISPLAY time because heatStore caches a row's
    // last-scanned sev and a row can converge to done after it was stored. `days`/`hrs`/
    // `lastNote` are the stored strings off the row (commas tolerated), not numbers; sev is the
    // stored verdict, so bad/warn read what the scan judged, not a recomputation.
    function auditOpenTally(entries) {
      var t = { open: 0, bad: 0, warn: 0, over30: 0, bkt: { a: 0, b: 0, c: 0, d: 0 }, noHrs: 0, noNote: 0 };
      (entries || []).forEach(function (e) {
        if (heatDone(e.status, e.phase)) return;
        t.open++;
        if (e.sev === 2) t.bad++; else if (e.sev === 1) t.warn++;
        var ag = parseFloat(String(e.days || '').replace(/,/g, ''));
        if (!isNaN(ag)) {
          if (ag > 30) t.over30++;
          if (ag <= 7) t.bkt.a++; else if (ag <= 30) t.bkt.b++; else if (ag <= 60) t.bkt.c++; else t.bkt.d++;
        }
        if (!String(e.hrs || '').trim()) t.noHrs++;
        if (!String(e.lastNote || '').trim()) t.noNote++;
      });
      return t;
    }

    // ---- Threshold model -----------------------------------------------------------
    // Delegates to the file-shared engine (single source of truth with WO Assist).
    // THE 4th PARAMETER IS LOAD-BEARING (v3.23). This alias declared only three while both
    // of its call sites already passed four - computeVerdict passes `f.sla`, the offender
    // ranking passes `e.sla` - so the row's own { responseMinutes, category } was dropped
    // here and bwnSlaMult never ran for List Heat at all. `slaScaled` was false on every
    // row, which is why the Audit panel's "status limits: N of M scaled by the client SLA"
    // line never appeared on a scan that HAD captured responseMinutes, and the whole v3.19
    // client-SLA clock was inert on the board while the shared engine passed its own tests
    // (those tests called bwnThresholdsFor directly, and the harness stub for this alias
    // took four args - so 287 assertions ran green over a dead path).
    // Measured on the shipped 1.66.29 bytes, status "Scheduled" / label "P2 Next Day" /
    // sla { responseMinutes: 480 }: through this alias warn 15 / bad 30 / sla false, into
    // the engine direct warn 10 / bad 20 / sla true.
    function thresholdsFor(status, prioText, C, sla) { return bwnThresholdsFor(status, prioText, C, sla); }

    // ---- Per-row verdict: ONE source of truth (v3.15) ------------------------------
    // Pure fn - facts in, verdict out - so the DOM tinting pass, the API scan, and the
    // My Day counts can never disagree about what makes a row red/amber. facts:
    //   { status, prio, ageDays (number|NaN), hrs (number|NaN),
    //     expTs, schedTs, lastNoteTs (epoch ms | null) }
    // Returns { sev 0|1|2, reasons[], kinds[], over30, limitBad, limitWatch, stale,
    //           noteAge (days | null), warn, bad }. A done/closed status is always sev 0.
    // `warn`/`bad` are the hours limits this row was actually judged against, returned so a
    // consumer can SHOW the limit without owning a second copy of the threshold model -
    // bwnThresholdsFor is deliberately file-local to this script (see its header), so any
    // limit computed elsewhere would be a copy that drifts. They stay null on a done row,
    // which has no clock at all: absent, not zero.
    function computeVerdict(f, C) {
      var reasons = [], kinds = [], sev = 0;
      var v = { sev: 0, reasons: reasons, kinds: kinds, over30: false, limitBad: false, limitWatch: false, stale: false, noteAge: null, slaScaled: false, warn: null, bad: null };
      function bump(level, msg, kind) {
        if (level > sev) sev = level;
        reasons.push(msg);
        if (kind && kinds.indexOf(kind) === -1) kinds.push(kind);
      }
      // Both signals, in one place (heatDone): a terminal phase silences a row whatever its
      // status is called, an ACTIVE phase silences the status-name guess instead, and a row
      // with no phase read (the DOM tinting pass has no phase column) judges on the name
      // exactly as it always did.
      if (heatDone(f.status, f.phase)) return v;
      v.over30 = !isNaN(f.ageDays) && f.ageDays > 30;
      var th = thresholdsFor(f.status, f.prio, C, f.sla);
      v.slaScaled = !!th.sla;
      v.warn = th.warn; v.bad = th.bad;
      if (!isNaN(f.hrs)) {
        if (f.hrs >= th.bad) { bump(2, Math.round(f.hrs) + 'h in "' + (f.status || '?') + '" (limit ' + Math.round(th.bad) + 'h)', 'limitbad'); v.limitBad = true; }
        else if (f.hrs >= th.warn) { bump(1, Math.round(f.hrs) + 'h in "' + (f.status || '?') + '" (watch from ' + Math.round(th.warn) + 'h)', 'limitwatch'); v.limitWatch = true; }
      }
      if (f.expTs !== null && f.expTs !== undefined) {
        var dd = dUntil(f.expTs);
        if (dd < 0) bump(2, 'complete-by overdue ' + Math.abs(dd) + 'd', 'overdue');
        else if (dd <= C.dueWarnDays) bump(1, 'due in ' + dd + 'd', 'duesoon');
      } else if (typeof f.remDays === 'number' && isFinite(f.remDays)) {
        // No complete-by date to read - use the server's signed day count instead, so the
        // overdue check survives the Expected Completion column being out of view. Same
        // kinds, so a snooze taken on one basis still holds on the other.
        if (f.remDays < 0) bump(2, 'complete-by overdue ' + Math.abs(Math.round(f.remDays)) + 'd', 'overdue');
        else if (f.remDays <= C.dueWarnDays) bump(1, 'due in ' + Math.round(f.remDays) + 'd', 'duesoon');
      }
      if (f.schedTs !== null && f.schedTs !== undefined) {
        var over = dSince(f.schedTs);
        if (over > C.schedGraceDays) bump(2, 'sched date passed ' + over + 'd', 'schedpassed');
      }
      if (f.lastNoteTs !== null && f.lastNoteTs !== undefined) {
        var quiet = dSince(f.lastNoteTs);
        v.noteAge = quiet;
        if (quiet > C.noteStaleDays) { bump(1, 'last note ' + quiet + 'd ago', 'stale'); v.stale = true; }
      }
      // ---- Signals the board already returned and the audit ignored -----------------
      // Each one needs a fact the DOM scan does not have, so each is skipped (never
      // guessed) when its input is absent - the same do-its-best rule the column checks use.
      //
      // 1. Nobody assigned to do the work. Only fires on a status that means a vendor is
      //    already COMMITTED - scheduled, on site, materials moving. "Pending Dispatch" and
      //    "Pending Schedule" are excluded on purpose: having no vendor yet is their normal
      //    resting state, and flagging them would put a third of the board in amber.
      if (f.vendorsKnown && !String(f.vendors || '').trim() &&
        /scheduled|in progress|on[\s-]?site|material (ordered|received)|vendor (proposal|invoice)/i.test(f.status || '') &&
        !/^pending\s/i.test(String(f.status || '').trim())) {
        bump(1, 'no vendor on a "' + f.status + '" WO', 'novendor');
        v.noVendor = true;
      }
      // 2. Committed vendor cost above what the client authorized. DNE is the client's
      //    not-to-exceed; totalNTE is the vendor-cost total (both minor units, scaled by
      //    heatApiRowToEntry). Over it is a money-control breach, not a timing problem, so
      //    it is red on its own. Requires BOTH numbers - never inferred from one.
      if (typeof f.dneAmt === 'number' && typeof f.nteAmt === 'number' && f.dneAmt > 0 && f.nteAmt > f.dneAmt) {
        bump(2, 'vendor NTE ' + BWN.money(f.nteAmt) + ' over DNE ' + BWN.money(f.dneAmt), 'nteover');
        v.nteOver = true;
      }
      // 3. Assigned to a deactivated account - an orphaned WO nobody is actually working.
      //    Resolved from the assignee GUID after the scan (heatResolveAssignees), so it can
      //    only ever be true, never a guess: unknown stays silent.
      if (f.assigneeInactive === true) {
        bump(1, 'assigned to an inactive user' + (f.assignee ? ' (' + f.assignee + ')' : ''), 'orphan');
        v.orphan = true;
      }
      v.sev = sev;
      return v;
    }

    // One place that turns a STORED row (API-mapped or DOM-scraped) into verdict facts, so
    // the scan, the post-resolution re-judge, and any later consumer cannot drift apart on
    // which fields feed the engine. Absent fields stay absent: `undefined` reaches
    // computeVerdict as undefined and each check skips itself.
    function heatVerdictFor(e, C) {
      return computeVerdict({
        status: e.status, prio: e.prio, phase: e.phase,
        ageDays: parseFloat(String(e.days || '').replace(/,/g, '')),
        hrs: parseFloat(String(e.hrs || '').replace(/,/g, '')),
        expTs: BWN.parseUSDate(e.exp), schedTs: BWN.parseUSDate(e.sched), lastNoteTs: BWN.parseUSDate(e.lastNote),
        remDays: e.remDays, sla: e.sla,
        vendors: e.vendors, vendorsKnown: e.vendorsKnown,
        dneAmt: e.dneAmt, nteAmt: e.nteAmt,
        assignee: e.assignee, assigneeInactive: e.assigneeInactive
      }, C || bwnConfig());
    }

    // Publish EVERY stored row's verdict to the per-WO bus slot (v3.24). `bwn:heat:{id}` is an
    // existing contract, already read through BWN.busHeatGet for WO Assist's "Flagged on WO
    // list", so this is that contract at full-board coverage rather than a new one. Measured
    // 2026-08-05 on a 219-row board: only 22 keys existed, because the ONLY writer was the DOM
    // tinting pass - which writes just the rows the virtualizer currently renders. Any second
    // consumer therefore saw heat on a tenth of the board and no severity at all on the rest.
    // The board view (bwn-kanban) is that consumer, and it must not judge rows itself:
    // bwnThresholdsFor is deliberately file-local to this script, so a limit computed in
    // another file would be a copy that drifts (the exact failure computeVerdict exists to
    // prevent). Fields are additive and `v` stays 1 - busHeatGet rejects any other version.
    // Same payload shape as the DOM writer, deliberately: two writers on one key must agree.
    function heatPublishVerdicts(store) {
      if (!store) return 0;
      var keys = Object.keys(store), n = 0, ts = Date.now(), err = null;
      for (var i = 0; i < keys.length; i++) {
        var r = store[keys[i]];
        if (!r || !r.id) continue;
        try {
          sessionStorage.setItem('bwn:heat:' + r.id, JSON.stringify({
            v: 1, ts: ts, sev: r.sev || 0,
            reasons: (r.reasons || []).slice(), acked: !!r.acked,
            hrs: (r.hrs === '' || r.hrs == null) ? null : parseFloat(r.hrs),
            warn: (typeof r.warn === 'number') ? r.warn : null,
            bad: (typeof r.bad === 'number') ? r.bad : null,
            status: r.status || '', src: 'api'
          }));
          n++;
        } catch (e) {
          // A full quota must not fail the scan - and must not fail SILENTLY either, or a
          // consumer reads stale heat for the unwritten rows and cannot tell.
          err = (e && e.name) || 'write failed';
          break;
        }
      }
      if (err) console.warn('[BWN HEAT] verdict publish stopped after ' + n + ' of ' + keys.length + ' rows (' + err + ')');
      return n;
    }

    // ---- Row snapshot for out-of-module renderers (kanban fold) ----------------------
    // Built ONCE per API scan and cached; every reader gets the same frozen object. Rebuilding
    // per read was rejected because the board asks from several call sites, and handing out the
    // live store was rejected outright - a mutable handle on the authority's own state is the
    // two-writers-drift shape this module already carries scars from.
    //
    //   __bwnHeatRows() -> { ok:true, ts, rows:[ {raw, id, wo, sev, reasons, kinds, acked,
    //                        warn, bad, status, hrs} ] }   (frozen)
    //                   -> { ok:false, reason, ts }        (no clean store)
    //
    // `raw` is the API row exactly as the wire returned it, so a renderer keeps reading the
    // field names it already reads. Everything beside it is the AUTHORITY's judgement, so a
    // consumer never computes a verdict.
    //
    // `acked` is a SNAPSHOT-TIME value and goes stale the moment anyone snoozes from the audit
    // panel. A live consumer should call __bwnHeatAck instead.
    function heatRowsBuild() {
      if (!heatStore || !heatScanClean) return null;
      var keys = Object.keys(heatStore), out = [];
      for (var i = 0; i < keys.length; i++) {
        var r = heatStore[keys[i]];
        if (!r || !r.id) { continue; }   // braced: keeps the heatPublishVerdicts skip-line unique for its harness
        var raw = heatRaw ? heatRaw[keys[i]] : null;
        if (!raw) continue;            // no raw row = nothing an out-of-module renderer can draw
        out.push(Object.freeze({
          raw: raw,
          id: r.id, wo: r.wo, status: r.status, hrs: r.hrs,
          sev: r.sev || 0,
          reasons: Object.freeze((r.reasons || []).slice()),
          kinds: Object.freeze((r.kinds || []).slice()),
          acked: !!r.acked,
          warn: (typeof r.warn === 'number') ? r.warn : null,
          bad: (typeof r.bad === 'number') ? r.bad : null
        }));
      }
      // Object.freeze is SHALLOW, which is why reasons and kinds are frozen individually above
      // and the array itself below. `raw` is deliberately NOT frozen: it is the wire's own
      // nested object graph, a deep freeze would cost a walk per scan, and no consumer writes
      // to it. No filter signature rides on the payload - heatAutoSig is in a different scope,
      // and reaching across for a field nobody reads is how a cheap nicety became a
      // ReferenceError at scan time on the first attempt at this.
      return Object.freeze({ ok: true, ts: Date.now(), rows: Object.freeze(out) });
    }
    // Why there is no clean store to hand over. The caller RENDERS this string, so the reasons
    // are distinguishable on purpose: each implies a different operator action.
    function heatRowsWhy() {
      if (!apiList || !apiList.query) return 'no capture yet';
      if (heatScanning || heatReplaying) return 'scan in progress';
      if (heatStore && !heatScanClean) return 'scan degraded to scroll';
      if (!heatStore) return heatScanNote ? ('last scan failed: ' + heatScanNote) : 'never scanned';
      return 'no rows mapped';
    }
    // Rebuild the cache and announce that a scan FINISHED - clean or not.
    //
    // The first version of this only announced on a CLEAN finish, and that was a real defect:
    // a consumer that had pulled mid-scan sat on `running: true` forever, because the only
    // event that could correct it never fired. Measured live - the board showed a stale card
    // from the previous filter while claiming to be scanning. A finish is a finish; whether it
    // produced rows is what __bwnHeatRows reports, not what decides who gets told.
    //
    // Fire-and-forget with NO payload, so a listener that misses it loses nothing - it pulls on
    // its next render. Push is for timing only; __bwnHeatRows is the only way to get data.
    function heatRowsAnnounce() {
      heatRowsCache = heatRowsBuild();
      try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:heat:rows' } })); } catch (e) { }
      return heatRowsCache ? heatRowsCache.rows.length : 0;
    }

    // ---- Board -> Dashboard dataset push (freshness path, swa-dataset-ingest) --------
    // After a clean full-board scan, publish the whole board to a localStorage queue the
    // bwn-suite-ai connector drains to /api/dataset-ingest, which overwrites the Dashboard's
    // wo-dataset slot - so the Dashboard shows live board data on a COLD load with no
    // spreadsheet upload. Pure reader over heatStore: no new scan, no schema guess. Values
    // are ALREADY in the Dashboard's units - hrs in HOURS (v3.19), dneAmt/nteAmt in DOLLARS
    // (moneyNum) - so the SWA route only RENAMES these wire keys to canonical df columns and
    // re-scales nothing. The wire keys are the api/wo-ingest live-jobs allowlist plus
    // lastNoteDate; keep them a subset of the route's STR/DATE/NUM maps or the route drops them.
    var HEAT_DATASET_MAX = 5000;
    function heatDatasetRows(store) {
      var out = [], keys = Object.keys(store || {});
      for (var i = 0; i < keys.length && out.length < HEAT_DATASET_MAX; i++) {
        var r = store[keys[i]];
        if (!r || !r.id) { continue; }   // braced: keeps the heatPublishVerdicts skip-line unique for its harness
        var row = { target: r.tracking || '', woNumber: r.wo || '' };
        if (!row.target && !row.woNumber) continue;   // no identity the Dashboard could key a job on
        if (r.status) row.status = r.status;
        if (r.prio) row.priority = r.prio;
        if (r.client) row.client = r.client;
        // A resolved human name only - never a GUID, never the "(unresolved member)" placeholder,
        // which means "could not read who owns this", a different fact from "nobody owns this".
        if (r.assignee && r.assignee !== '(unresolved member)') row.coordinator = r.assignee;
        if (r.hrs !== '' && r.hrs != null) row.statusHrs = r.hrs;   // HOURS already (v3.19)
        if (r.days !== '' && r.days != null) row.aged = r.days;
        if (r.dneAmt != null) row.amount = r.dneAmt;               // DOLLARS already (moneyNum)
        if (r.nteAmt != null) row.vendorNte = r.nteAmt;
        if (r.vendorsKnown && r.vendors) row.vendors = r.vendors;
        if (r.sched) row.nextOnsiteDate = r.sched;
        if (r.exp) row.expectedCompletion = r.exp;
        if (r.lastNote) row.lastNoteDate = r.lastNote;   // the primary staleness signal; paired with the route's DATE_MAP entry
        // v2 dataset fields - emitted when the scan captured them (column/field dependent); the
        // route maps sourceJob/sourcePo/projectType (STR_MAP) and woDate (DATE_MAP).
        if (r.sourceJob) row.sourceJob = r.sourceJob;
        if (r.sourcePo) row.sourcePo = r.sourcePo;
        if (r.projectType) row.projectType = r.projectType;
        if (r.woDate) row.woDate = r.woDate;
        out.push(row);
      }
      return out;
    }
    // END heatDatasetRows
    function heatQueueDataset(store) {
      try {
        var rows = heatDatasetRows(store);
        if (!rows.length) return;
        if (Object.keys(store || {}).length > HEAT_DATASET_MAX)
          console.warn('[BWN HEAT] board over ' + HEAT_DATASET_MAX + ' rows - dataset push capped, some rows omitted');
        BWN.lsSetJSON('bwn:datasetq', { generatedAt: new Date().toISOString(), rows: rows, by: 'listHeat' });
      } catch (e) { console.warn('[BWN HEAT] dataset queue failed:', (e && e.message) || e); }
    }

    // ---- In-House Dispatch Report feed (dedicated whole-open-book push) --------------
    // Fed ONLY by the tenant-wide OPEN (seeded) scan, so it is the WHOLE open book, not a
    // coordinator's filtered board. Its own queue (bwn:dispatchq) + SWA route, separate from
    // the Dashboard dataset above, so the two never collide and the Dashboard guard is untouched.
    // The report page (broadway-internal-ops) classifies OFFER / POSSIBLE-BYPASS / ALREADY-IN-HOUSE
    // from {city, state, vendors} against in-house vendor #19378 "Broadway National Maintenance LLC".
    // Units are already normalized upstream (dneAmt in DOLLARS via moneyNum); this only renames.
    var DISPATCH_DATASET_MAX = 8000;   // > the ~5,241 tenant open book, with headroom
    function dispatchDatasetRows(store) {
      var out = [], keys = Object.keys(store || {});
      for (var i = 0; i < keys.length && out.length < DISPATCH_DATASET_MAX; i++) {
        var r = store[keys[i]];
        if (!r || !r.id) { continue; }   // braced to keep this skip-line unique for the harness
        var row = { woNumber: r.wo || '', tracking: r.tracking || '' };
        if (!row.woNumber && !row.tracking) continue;   // no identity the report could key a job on
        if (r.status) row.status = r.status;
        if (r.prio) row.priority = r.prio;
        if (r.client) row.client = r.client;
        // A resolved human name only - never a GUID, never "(unresolved member)". Split a pod
        // owner ("Team P") into row.team from a person into row.coordinator. No person->team
        // roster exists, so a person-assigned WO carries a coordinator but no team - known ceiling.
        if (r.assignee && r.assignee !== '(unresolved member)') {
          if (/^team\b/i.test(r.assignee)) row.team = r.assignee;
          else row.coordinator = r.assignee;
        }
        if (r.city) row.city = r.city;
        if (r.state) row.state = r.state;
        // In-House Dispatch upgrade: created window + trade coverage + location #. Guarded like the
        // other column-dependent fields - omitted (not blanked) when a scan path never read them.
        if (r.woCreatedAt) row.woCreatedAt = r.woCreatedAt;
        if (r.trade) row.trade = r.trade;
        if (r.tradeSys) row.tradeSys = r.tradeSys;
        if (r.locationNumber) row.locationNumber = r.locationNumber;
        // Street + zip for the geocode step (SWA composes the geocodable address from these).
        if (r.street1) row.street1 = r.street1;
        if (r.street2) row.street2 = r.street2;
        if (r.zip) row.zip = r.zip;
        // vendorsKnown separates "no vendor yet" (an OFFER candidate) from "column not read".
        // Only a KNOWN read is emitted - as '' when empty - so the report never reads an unread
        // field as "no vendor" and mis-bucket an already-dispatched job as offerable.
        if (r.vendorsKnown) row.vendors = r.vendors || '';
        if (r.dneAmt != null) row.dne = r.dneAmt;
        out.push(row);
      }
      return out;
    }
    // END dispatchDatasetRows
    function dispatchQueueDataset(store) {
      try {
        var rows = dispatchDatasetRows(store);
        if (!rows.length) return;
        BWN.lsSetJSON('bwn:dispatchq', { generatedAt: new Date().toISOString(), rows: rows, by: 'dispatchScan', scope: 'tenant-open' });
        console.info('[BWN DISPATCH] queued ' + rows.length + ' open WOs for the In-House Dispatch Report (bwn:dispatchq).');
      } catch (e) { console.warn('[BWN DISPATCH] dispatch queue failed:', (e && e.message) || e); }
    }

    // ---- Assignee names from GUIDs ------------------------------------------------
    // The board row carries `assignedToMemberName` only when the Assigned To column is in
    // view - the captured query selects what the column chooser asked for. When it is not,
    // all we have is the `assignedTo` GUID, and a GUID must never reach the panel. So:
    // resolve the DISTINCT ids through user(id:) - the same query bwn-dispatch proved live
    // on 2026-08-03, which also carries `isInactive` and so pays for a second signal.
    // A board has a handful of coordinators, not hundreds, and the result is cached for the
    // tab, so a rescan costs nothing. Aliased into ONE document per chunk; a chunk that
    // errors degrades to single reads; an id that cannot be read is remembered as
    // unresolvable so it is not retried all session.
    var HEAT_USER_Q_MAX = 20;
    var heatUserCache = {};        // guid -> { name, inactive } | null (tried, unreadable)
    function heatUserCacheLoad() {
      try {
        var raw = sessionStorage.getItem('bwn:heat:users');
        var o = raw ? JSON.parse(raw) : null;
        if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { if (!(k in heatUserCache)) heatUserCache[k] = o[k]; });
      } catch (e) { /* best-effort */ }
    }
    function heatUserCacheSave() {
      try { sessionStorage.setItem('bwn:heat:users', JSON.stringify(heatUserCache)); } catch (e) { /* best-effort */ }
    }
    function heatUserChunk(ids) {
      var decl = ids.map(function (_, i) { return '$i' + i + ':ID!'; }).join(',');
      var sel = ids.map(function (_, i) { return 'u' + i + ': user(id:$i' + i + '){ firstName lastName isInactive }'; }).join(' ');
      var vars = {};
      ids.forEach(function (id, i) { vars['i' + i] = id; });
      return heatGql('query(' + decl + '){ ' + sel + ' }', vars).then(function (d) {
        ids.forEach(function (id, i) { heatUserCache[id] = heatUserRec((d || {})['u' + i]); });
      }, function () {
        // One bad id rejects the whole GraphQL document, so fall back to single reads
        // rather than writing off every coordinator in the chunk.
        return Promise.all(ids.map(function (id) {
          return heatGql('query($id:ID!){ user(id:$id){ firstName lastName isInactive } }', { id: id })
            .then(function (d) { heatUserCache[id] = heatUserRec(d && d.user); },
              function () { heatUserCache[id] = null; });
        }));
      });
    }
    function heatUserRec(u) {
      if (!u) return null;
      var nm = ((u.firstName || '') + ' ' + (u.lastName || '')).replace(/\s+/g, ' ').trim();
      if (!nm) return null;
      return { name: nm, inactive: u.isInactive === true };
    }
    // Fills in `assignee` / `assigneeInactive` on every row that has an id but no name, then
    // RE-JUDGES those rows - the inactive-user signal is a verdict input, so a name arriving
    // late must be able to change sev. Resolves to the number of rows changed.
    function heatResolveAssignees(store) {
      if (!store) return Promise.resolve(0);
      heatUserCacheLoad();
      var hrefs = Object.keys(store), need = {}, ids = [];
      hrefs.forEach(function (h) {
        var e = store[h];
        if (!e || !e.assigneeId || e.assignee) return;
        need[h] = e.assigneeId;
        if (heatUserCache[e.assigneeId] === undefined && ids.indexOf(e.assigneeId) === -1) ids.push(e.assigneeId);
      });
      var pending = Object.keys(need);
      if (!pending.length) return Promise.resolve(0);
      if (!authToken()) return Promise.resolve(heatApplyUsers(store, need));
      var chunks = [];
      for (var i = 0; i < ids.length; i += HEAT_USER_Q_MAX) chunks.push(ids.slice(i, i + HEAT_USER_Q_MAX));
      return chunks.reduce(function (p, c) {
        return p.then(function () { return heatUserChunk(c); });
      }, Promise.resolve()).then(function () {
        heatUserCacheSave();
        var n = heatApplyUsers(store, need);
        var unres = 0;
        Object.keys(need).forEach(function (h) { if (store[h] && !store[h].assignee) unres++; });
        console.info('[BWN HEAT] assignee names: ' + (pending.length - unres) + ' of ' + pending.length +
          ' resolved from ' + ids.length + ' distinct id(s)' + (unres ? ' | ' + unres + ' unresolved' : ''));
        return n;
      }, function (err) {
        console.warn('[BWN HEAT] assignee name resolution failed - buckets will read "(unresolved member)":', (err && err.message) || err);
        return heatApplyUsers(store, need);
      });
    }
    function heatApplyUsers(store, need) {
      var C = bwnConfig(), n = 0;
      Object.keys(need).forEach(function (h) {
        var e = store[h]; if (!e) return;
        var rec = heatUserCache[need[h]];
        if (rec && rec.name) { e.assignee = cleanName(rec.name); e.assigneeInactive = rec.inactive; }
        // A GUID must not reach the panel even when the read failed. This label is
        // deliberately NOT "(blank)": "we could not read who owns this" and "nobody owns
        // this" are different facts and an audit that conflates them is lying quietly.
        else e.assignee = '(unresolved member)';
        var vf = heatVerdictFor(e, C);
        e.sev = vf.sev; e.reasons = vf.reasons.slice(); e.kinds = vf.kinds.slice();
        e.acked = vf.sev > 0 ? ackGet(e.id, vf.kinds) : false;
        n++;
      });
      return n;
    }

    // ---- Next step per row (the playbook, run over board fields only) -------------
    // Ranks the SAME playbook the WO page uses, from the only facts a board row has. The
    // engine's PO / trip / IVR / document / note steps cannot fire here - there is no such
    // data in a list row - so this answers "what does the playbook say from status, priority,
    // clock and dates alone", which is exactly the top of the list for a stuck WO.
    //
    // WHAT EACH ABSENT INPUT IS PASSED AS, and why it is not one blanket rule. The engine was
    // written for a WO page where every field is present, so this was audited branch by branch:
    //   pos: []      - the ONLY field the engine dereferences unguarded (`state.pos.forEach`).
    //                  `null` throws, and because the call is wrapped in a try/catch that
    //                  throw would be silent - a dead column that still looked green. `[]` is
    //                  safe HERE specifically: no branch treats "no POs" as EVIDENCE for a
    //                  step. The four PO steps are emitted from inside forEach/filter, so an
    //                  empty list emits none, and the two `some()` branches only SUPPRESS.
    //   docs: null   - NOT `{count: 0}`. The docs branch fires on `docs.count === 0`, so a
    //                  zero count would fabricate "no documents on file" on every WO at
    //                  closure. Unread must not read as empty. `null` is guarded and silent.
    //   openTasks    - null; guarded (`state.openTasks && .count > 0`), and it is an object,
    //                  not an array.
    //   noShow/stall - null; both guarded, and both are trip-derived facts a row cannot have.
    //   money        - null, never 0: `gpPct: 0` would read as 0% GP and fire a red DNE step.
    function heatNextStep(e, C) {
      if (typeof bwnActsEngine !== 'function') return null;
      var expTs = BWN.parseUSDate(e.exp);
      var due = null;
      if (expTs !== null) {
        var dd = dUntil(expTs);
        due = dd < 0
          ? { kind: 'bad', label: 'Overdue ' + Math.abs(dd) + 'd', detail: 'Complete-by date (' + e.exp + ') has passed.', raw: e.exp }
          : { kind: dd <= C.dueWarnDays ? 'warn' : 'ok', label: 'Due ' + dd + 'd', detail: 'Complete by ' + e.exp + '.', raw: e.exp };
      }
      var hrs = parseFloat(String(e.hrs || '').replace(/,/g, ''));
      var noteTs = BWN.parseUSDate(e.lastNote);
      try {
        var acts = bwnActsEngine({
          // T10: hd.client feeds the per-client profile resolver; sourceJob/sourcePo are carried
          // from the row so the intake ref-gate does not false-positive when the refs ARE set.
          hd: { wo: e.wo ? 'W-' + e.wo : '', tracking: e.tracking || '', location: e.client || '', client: e.client || '', sourceJob: e.sourceJob || '', sourcePo: e.sourcePo || '' },
          clientId: e.clientTenantProfileId || '',
          status: e.status || '', priority: e.prio || '',
          hrs: isNaN(hrs) ? null : hrs,
          due: due,
          staleDays: noteTs === null ? null : dSince(noteTs),
          noteCount: null, lastClientNoteDays: null,
          pos: [], docs: null, openTasks: null, noShow: null, stall: null,
          gpPct: null, nte: null, vendorTotal: null,
          authoredPlan: null, nudges: {}, escRank: null,
          cfg: C
        }, C);
        if (!acts || !acts.length) return null;
        // The engine appends a standing completion anchor to every list; it is a reference,
        // not a step, so it must never be reported as "the next thing to do".
        for (var i = 0; i < acts.length; i++) if (acts[i] && !acts[i].anchor) return acts[i];
        return null;
      } catch (err) {
        // A board row is a thinner state than the engine was written for. If it ever throws,
        // say so once and drop the column - never let the audit die with it.
        if (!heatActsWarned) { heatActsWarned = true; console.warn('[BWN HEAT] next-step engine declined a board row - column omitted:', (err && err.message) || err); }
        return null;
      }
    }
    var heatActsWarned = false;

    // ---- Heat pass ----------------------------------------------------------------
    var heatStore = null;     // { heatKey(href): {sev, reasons[], wo, client, status, assignee, prio, hrs, days, dne, sched, lastNote, exp, sourceJob, sourcePo, projectType, woDate} }
    // The RAW API rows behind an API scan, parallel to heatStore and keyed the same way.
    // Kept SEPARATE from heatStore on purpose: heatStore entries are consumed by
    // heatPublishVerdicts, heatDatasetRows and the audit panel, all of which read named fields,
    // and hanging an unbounded row off each entry puts a payload nobody asked for in front of
    // three consumers - one of which posts to the SWA. This map has one consumer, heatRowsBuild.
    //
    // WHY the raw row is kept at all: heatApiRowToEntry NORMALIZES (it flattens the row and
    // picks fields by regex synonym, keeping no reference to the original), so an entry has no
    // statusId, locationName, locationNumber, scopeOfWork, numberOfDays, priority object or
    // vendorNames. The kanban board renders all of those, and without statusId it cannot resolve
    // a drop target and its drag write refuses every card. Measured 2026-08-09.
    var heatRaw = null;
    // Frozen row snapshot for out-of-module consumers, rebuilt once per API scan and cached -
    // never rebuilt per read, because the board asks from several call sites.
    var heatRowsCache = null;
    // The DOM tinting pass's write into heatStore. Two rules, both learned the hard way:
    //   - the key comes from heatKey, never from the raw href (see there);
    //   - a row the API scan already read is NOT overwritten. The API record carries facts
    //     no board row can supply - assigneeId, NTE, phase, vendors, remainingDays, the SLA
    //     minutes - and clobbering it with the DOM read would blank those for exactly the
    //     rows currently on screen, which is the subset a coordinator is looking at.
    //     Only `acked` is refreshed, because a snooze can be toggled while the store stands.
    function heatStoreDomPut(key, rec) {
      if (!heatStore || !key) return;
      var prev = heatStore[key];
      if (prev && prev.src === 'api') { prev.acked = rec.acked; return; }
      heatStore[key] = rec;
    }
    var heatScanning = false;
    var heatScanAbort = false;   // set by the route-change observer so an in-flight API scan bails cleanly
    var heatScanClean = false;   // true only after a clean Scan All convergence - gates trend/snapshot writes
    var heatScanNote = null;     // WHY the last scan was dirty (shown in the Over-30 confirm so the user isn't guessing)
    var heatDim = null;       // null | {field:'status'|'assignee'|'client', value:string}
    var mydayFilter = null;   // null | 'over30' | 'limitbad' | 'limitwatch' | 'nonote'  (My Day pill filters)
    var diagFor = '';

    function diag(table, H, rowCount) {
      if (diagFor === location.href) return;
      diagFor = location.href;
      console.info('[BWN HEAT] DIAG \u2014 tables:', document.querySelectorAll('table').length,
        '| body table:', !!table, '| header:', !!H,
        '| indexes:', H ? JSON.stringify({ wo: H.wo, status: H.status, hrs: H.hrs, prio: H.prio, exp: H.exp, sched: H.sched, lastNote: H.lastNote, days: H.days, created: H.created }) : 'n/a',
        H && H.wo < 0 ? '| align: no WO # anchor - assuming header/body column parity' : '',
        '| WO rows:', rowCount);
    }

    function woListHeat() {
      var sum = document.getElementById(SUM_ID);
      if (!isListPage()) {
        if (sum) sum.remove();
        var pn0 = document.getElementById(PANEL_ID); if (pn0) pn0.remove();
        var md0 = document.getElementById('bwn-myday'); if (md0) md0.remove();
        BWN.beat('listHeat', 'waiting', 'not the WO list');
        return;
      }
      // On the list route: arm the pinned-query seed fallback (SET-ONCE) so the API scan is
      // available even if the passive capture lost the boot race - independent of whether the
      // DOM table below is detected. A live capture, if one fires, always displaces the seed.
      heatArmSeedFallback();
      var table = findBodyTable();
      var H = table ? alignMap(headerMap(), table) : null;
      if (!table || !H) { diag(table, H, 0); BWN.beat('listHeat', 'waiting', 'list table/header not detected'); return; }
      // Do-its-best gate: run with whatever signal columns ARE on screen; each
      // missing column disables only its own signal (v3.10 demanded hrs/exp/sched
      // or shut everything off - over-30 and stale-note died with them).
      var missing = [];
      if (H.hrs < 0) missing.push('"Time in Status" → status-limit checks off');
      if (H.exp < 0) missing.push('"Expected Completion" → overdue checks off');
      if (H.sched < 0) missing.push('"Scheduled Date" → missed-visit checks off');
      if (H.days < 0 && H.created < 0) missing.push('"# Days" → over-30 off');
      if (H.lastNote < 0) missing.push('"Last Note Date" → stale-note checks off');
      var anySignal = (H.hrs >= 0 || H.exp >= 0 || H.sched >= 0 || H.days >= 0 || H.created >= 0 || H.lastNote >= 0);
      if (!anySignal) { diag(table, H, 0); BWN.beat('listHeat', 'waiting', 'no heat columns in view - add "Time in Status" / "# Days" / "Last Note Date" via the column chooser'); return; }
      ensureStyle();
      var C = bwnConfig();

      var rows = table.querySelectorAll('tbody tr');
      if (!rows.length) rows = table.rows;
      var nBad = 0, nWarn = 0, nRows = 0, nAcked = 0;
      Array.prototype.forEach.call(rows, function (tr) {
        var link = rowWOLink(tr);
        if (!link) return;
        nRows++;
        var idm = (link.getAttribute('href') || '').match(/work-orders\/(\d+)/);
        var rowId = idm ? idm[1] : null;
        var status = cellText(tr, H.status);
        var prio = cellText(tr, H.prio);
        var ageDays = parseFloat(cellText(tr, H.days).replace(/,/g, ''));
        if (isNaN(ageDays) && H.created >= 0) {   // no "# Days" column - derive age from the WO Date column instead
          var crd = parseUSDate(cellText(tr, H.created));
          if (crd !== null) ageDays = dSince(crd);
        }
        // The board has no phase column, so the tint borrows the phase the API scan already
        // read for THIS row (v3.22). Not a guess and not fabrication - same WO, same store
        // record, a fact the row itself cannot show. Without it the counts would judge the
        // row on its phase while the tint judged it on its status name, and a
        // "Clocked Out: Complete" row would sit untinted inside a red count - the drift the
        // one shared computeVerdict exists to make impossible. No API record (DOM-only scan)
        // -> undefined -> the name regex decides, exactly as before.
        var rowKey = heatKey(link.getAttribute('href'));
        var apiRec = (heatStore && heatStore[rowKey] && heatStore[rowKey].src === 'api') ? heatStore[rowKey] : null;
        // Verdict via the shared computeVerdict (same fn the API scan + My Day use),
        // so row tint, audit counts, and My Day can never disagree. `sla` rides along for
        // the same reason `phase` does (v3.23): the board has no responseMinutes column,
        // and once thresholdsFor actually honours the 4th arg, a tint that omitted it would
        // judge the row on the label clock while the stored sev beside it came from the
        // client's. Same WO, same store record - undefined on a DOM-only scan, as before.
        var domHrs = parseFloat(cellText(tr, H.hrs).replace(/,/g, ''));
        var vf = computeVerdict({
          status: status, prio: prio, phase: apiRec ? apiRec.phase : undefined, ageDays: ageDays,
          sla: apiRec ? apiRec.sla : undefined,
          hrs: domHrs,
          expTs: parseUSDate(cellText(tr, H.exp)),
          schedTs: parseUSDate(cellText(tr, H.sched)),
          lastNoteTs: parseUSDate(cellText(tr, H.lastNote))
        }, C);
        var sev = vf.sev;
        var reasons = vf.reasons.slice(), kinds = vf.kinds.slice();
        var rOver30 = vf.over30, rLimitBad = vf.limitBad, rLimitWatch = vf.limitWatch, rStale = vf.stale;
        // Last-note age badge (DOM-only decoration; ::after via a data attr so it
        // neither trips the childList observer nor gets clobbered by the virtualizer).
        var lnCell = (H.lastNote >= 0 && tr.cells) ? tr.cells[H.lastNote] : null;
        if (lnCell) {
          if (vf.noteAge !== null) {
            if (lnCell.getAttribute('data-bwn-age') !== String(vf.noteAge)) lnCell.setAttribute('data-bwn-age', vf.noteAge);
            if (!lnCell.classList.contains('bwn-note-age')) lnCell.classList.add('bwn-note-age');
            if (vf.noteAge > C.noteStaleDays) { if (!lnCell.classList.contains('bwn-note-stale')) lnCell.classList.add('bwn-note-stale'); }
            else if (lnCell.classList.contains('bwn-note-stale')) lnCell.classList.remove('bwn-note-stale');
          } else if (lnCell.classList.contains('bwn-note-age')) {
            lnCell.classList.remove('bwn-note-age', 'bwn-note-stale');
            lnCell.removeAttribute('data-bwn-age');
          }
        }

        var assignee = cleanName(cellText(tr, H.assignee));
        var client = cellText(tr, H.client);
        // Snoozed: the user acknowledged exactly THIS problem set - show a quiet
        // grey edge instead of tint and keep it out of the alarm counts. A new
        // problem kind (or expiry) re-alarms automatically.
        var acked = sev > 0 && rowId ? ackGet(rowId, kinds) : false;
        tr.classList.remove('bwn-heat-bad', 'bwn-heat-warn', 'bwn-heat-dim', 'bwn-heat-acked');
        if (acked) { tr.classList.add('bwn-heat-acked'); nAcked++; }
        else if (sev === 2) { tr.classList.add('bwn-heat-bad'); nBad++; }
        else if (sev === 1) { tr.classList.add('bwn-heat-warn'); nWarn++; }
        // Filters DIM non-matching rows instead of hiding them: hiding rows breaks
        // the virtualizer's layout math and it falls back to skeleton placeholders.
        var dimmed = false;
        if (mydayFilter === 'over30' && !rOver30) dimmed = true;
        if (mydayFilter === 'limitbad' && !rLimitBad) dimmed = true;
        if (mydayFilter === 'limitwatch' && !rLimitWatch) dimmed = true;
        if (mydayFilter === 'nonote' && !rStale) dimmed = true;
        if (!dimmed && heatDim) {
          var dimVal = heatDim.field === 'status' ? status : heatDim.field === 'assignee' ? assignee : client;
          if (dimVal !== heatDim.value) dimmed = true;
        }
        if (dimmed) tr.classList.add('bwn-heat-dim');
        if (reasons.length) { tr.title = (acked ? 'Snoozed \u00b7 ' : '') + reasons.join(' \u00b7 '); tr.dataset.bwnHt = '1'; }
        else if (tr.dataset.bwnHt === '1') { tr.removeAttribute('title'); delete tr.dataset.bwnHt; }

        // Phase 2 seam: persist this row's verdict so WO Assist can show
        // "Flagged on WO list" when the user opens the WO. Best-effort.
        // v3.24: carries the SAME extra fields the API publisher writes (hrs + the limits the
        // row was judged against). Both writers must emit one shape: this pass runs on every
        // virtualizer tick, so a leaner DOM payload would silently overwrite the richer
        // API-published record for exactly the rows currently on screen - the v3.20
        // two-writers-one-key fault in a different store.
        try {
          if (rowId) sessionStorage.setItem('bwn:heat:' + rowId, JSON.stringify({
            v: 1, ts: Date.now(), sev: sev, reasons: reasons, acked: acked,
            hrs: isNaN(domHrs) ? null : domHrs, warn: vf.warn, bad: vf.bad,
            status: status, src: 'dom'
          }));
        } catch (eS) { /* best-effort */ }

        if (heatStore) {
          heatStoreDomPut(rowKey, {
            id: rowId, kinds: kinds.slice(), acked: acked,
            sev: sev, reasons: reasons.slice(),
            wo: (link.textContent || '').trim() || cellText(tr, H.wo),
            tracking: cellText(tr, H.tracking).replace(/\D+/g, ''),   // the dashboard's job id - the ecosystem key for the Over-30 sync
            status: status, prio: prio,
            client: client,
            assignee: assignee,
            // days carries the DERIVED age when the # Days column is hidden (WO-Date
            // fallback) - every downstream consumer (My Day chip, audit buckets, snapshot,
            // over-30 batch, trend) re-parses this string, so persisting the raw empty
            // cell would zero the over-30 signal everywhere except the row tint (review).
            hrs: cellText(tr, H.hrs), days: cellText(tr, H.days) || (!isNaN(ageDays) ? String(Math.round(ageDays)) : ''), dne: cellText(tr, H.dne),
            sched: cellText(tr, H.sched), lastNote: cellText(tr, H.lastNote), exp: cellText(tr, H.exp),
            // v2 dataset fields - same shape as the API writer emits (drift guard, v3.24).
            sourceJob: cellText(tr, H.sourceJob), sourcePo: cellText(tr, H.sourcePo), projectType: cellText(tr, H.projectType), woDate: cellText(tr, H.created)
          });
        }
      });
      diag(table, H, nRows);

      // ---- Banner ----
      if (!sum) {
        sum = document.createElement('div');
        sum.id = SUM_ID;
        var t = document.createElement('span'); t.className = 't'; t.textContent = 'WO HEAT';
        sum.appendChild(t);
        function chipify(el, label, fn) {
          el.title = label;
          el.setAttribute('role', 'button');
          el.setAttribute('tabindex', '0');
          el.addEventListener('click', fn);
          el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
        }
        function refreshPanelIfOpen() {
          var pn = document.getElementById(PANEL_ID); if (pn) { pn.remove(); toggleAuditPanel(); }
        }
        var lg = document.createElement('span'); lg.className = 'lg';
        sum.appendChild(lg);
        var clearBtn = document.createElement('button');
        clearBtn.type = 'button'; clearBtn.id = 'bwn-heat-clear'; clearBtn.textContent = 'Clear filters';
        clearBtn.addEventListener('click', function () {
          heatDim = null; mydayFilter = null; woListHeat();
          var pn = document.getElementById(PANEL_ID); if (pn) { pn.remove(); toggleAuditPanel(); }
        });
        sum.appendChild(clearBtn);
        var setBtn = document.createElement('button');
        setBtn.type = 'button'; setBtn.textContent = '\u2699 Settings';
        setBtn.title = 'Suite-wide thresholds \u2014 shared with WO Assist via bwn:config';
        setBtn.addEventListener('click', toggleSettings);
        sum.appendChild(setBtn);
        var auditBtn = document.createElement('button');
        auditBtn.type = 'button'; auditBtn.textContent = 'Audit';
        auditBtn.title = 'Breakdown by status, assignee, and client, top offenders, and TSV export. Best after Scan All.';
        auditBtn.addEventListener('click', toggleAuditPanel);
        sum.appendChild(auditBtn);
        var scanBtn = document.createElement('button');
        scanBtn.type = 'button'; scanBtn.id = 'bwn-heat-scan'; scanBtn.textContent = 'Scan All';
        scanBtn.title = 'Reads the whole board. Uses the Umbrava API when available (instant, exact); otherwise scrolls the list in converging passes.';
        scanBtn.addEventListener('click', function () { runScan(scanBtn); });
        sum.appendChild(scanBtn);
        // Batch Over-30 lines - only when the AI script ran this session with its
        // Client Update module enabled (otherwise the handoff would go nowhere).
        if (o30AiReady()) {
          var o30Btn = document.createElement('button');
          o30Btn.type = 'button'; o30Btn.textContent = 'Over-30 Lines';
          o30Btn.title = 'Draft an "OVER 30 -" audit line for every aged open job in one AI pass. Run Scan All first.';
          o30Btn.addEventListener('click', BWN.guard(o30BatchStart, 'heat:o30batch'));
          sum.appendChild(o30Btn);
        }
        var prog = document.createElement('div');
        prog.id = 'bwn-heat-prog';
        prog.appendChild(document.createElement('div')).className = 'fill';
        sum.appendChild(prog);
        table.parentNode.insertBefore(sum, table);
      } else if (!document.getElementById(PANEL_ID) && sum.nextSibling !== table) {
        table.parentNode.insertBefore(sum, table);
      }
      // Missing-column signals: visible on the strip (tooltip) + the health beat, so a
      // coordinator knows WHY a check is quiet instead of assuming the board is clean.
      var missTitle = missing.length ? 'Signals off (columns hidden): ' + missing.join(' · ') + ' - add them via the column chooser' : '';
      if (sum.getAttribute('data-bwn-miss') !== missTitle) {
        sum.setAttribute('data-bwn-miss', missTitle);
        if (missTitle) sum.title = missTitle; else sum.removeAttribute('title');
      }
      BWN.beat('listHeat', 'ok', missing.length ? 'overlay active - ' + missing.length + ' signal(s) off (columns hidden)' : 'overlay active');
      var filtBits = [];
      var mfLabel = { over30: 'over 30d', limitbad: 'past status limit', limitwatch: 'watch', nonote: 'stale notes' };
      if (mydayFilter) filtBits.push(mfLabel[mydayFilter] + ' only');
      if (heatDim) filtBits.push(heatDim.field + ' = ' + heatDim.value);
      var lgEl = sum.querySelector('.lg');
      if (lgEl) lgEl.textContent = (filtBits.length ? 'highlighting: ' + filtBits.join(' · ') + ' · full match list in Audit' : 'hover a tinted row for the why · click a pill or audit row to filter') +
        (nAcked ? ' · ' + nAcked + ' snoozed' : '');
      var clearEl = document.getElementById('bwn-heat-clear');
      if (clearEl) clearEl.style.display = filtBits.length ? '' : 'none';
      renderMyDay();
    }

    // ---- Audit panel -----------------------------------------------------------------
    function toggleAuditPanel() {
      var old = document.getElementById(PANEL_ID);
      if (old) { old.remove(); return; }
      var sum = document.getElementById(SUM_ID);
      if (!sum || !sum.parentNode) return;
      var entries = heatStore ? Object.keys(heatStore).map(function (k) { var e = heatStore[k]; e._href = k; return e; }) : [];
      var panel = document.createElement('div');
      panel.id = PANEL_ID;
      function closePanel() { document.removeEventListener('keydown', onPanelKey); panel.remove(); }
      function onPanelKey(e) { if (e.key === 'Escape') closePanel(); }
      document.addEventListener('keydown', onPanelKey);

      var ph = document.createElement('div'); ph.className = 'ph';
      ph.textContent = entries.length
        ? 'AUDIT \u00b7 ' + entries.length + ' WOs SCANNED'
        : 'AUDIT';
      panel.appendChild(ph);

      if (entries.length) {
        // Since-last-scan delta (v3.8): daily snapshots written on clean Scan All
        // convergence; red/amber/open/over-30 vs the most recent prior day.
        var snaps = BWN.lsGetJSON(SNAP_KEY, {}) || {};
        var todayK = mydayDateKey();
        var priorKey = Object.keys(snaps).filter(function (k) { return k < todayK; }).sort().pop();
        // The open-row tally is a pure function now (auditOpenTally, sliced by
        // test-heat-open-count.js) - it, not this DOM builder, owns the heatDone gate.
        var curS = auditOpenTally(entries);
        var bkt = curS.bkt, noHrs = curS.noHrs, noNote = curS.noNote;
        var dl = document.createElement('div'); dl.className = 'dl';
        var pS = priorKey ? snaps[priorKey] : null;
        function dseg(label, nowV, thenV) {
          var sp = document.createElement('span');
          sp.appendChild(document.createTextNode(label + ' ' + nowV));
          if (thenV !== undefined) {
            var dv = nowV - thenV;
            sp.appendChild(document.createTextNode(' ('));
            var em = document.createElement('span');
            em.className = dv > 0 ? 'up' : dv < 0 ? 'down' : '';
            em.textContent = (dv > 0 ? '+' : '') + dv;
            sp.appendChild(em);
            sp.appendChild(document.createTextNode(')'));
          }
          dl.appendChild(sp);
        }
        dseg('red', curS.bad, pS ? pS.bad : undefined);
        dseg('amber', curS.warn, pS ? pS.warn : undefined);
        dseg('open', curS.open, pS ? pS.open : undefined);
        dseg('over-30', curS.over30, pS ? pS.over30 : undefined);
        var dTail = document.createElement('span');
        dTail.textContent = pS ? 'vs ' + priorKey : 'no prior full scan on record yet';
        dl.appendChild(dTail);
        panel.appendChild(dl);
        var ql = document.createElement('div'); ql.className = 'dl';
        var q1 = document.createElement('span');
        q1.textContent = 'age: 0-7d ' + bkt.a + ' \u00b7 8-30d ' + bkt.b + ' \u00b7 31-60d ' + bkt.c + ' \u00b7 60d+ ' + bkt.d;
        ql.appendChild(q1);
        if (noHrs || noNote) {
          var q2 = document.createElement('span');
          q2.textContent = 'data gaps: ' + noHrs + ' w/o time-in-status \u00b7 ' + noNote + ' w/o last note';
          q2.title = 'Rows the heat/staleness rules cannot judge \u2014 usually a column not in view during the scan.';
          ql.appendChild(q2);
        }
        // Say WHICH clock judged the board. The two bases give different limits for the
        // same row, so a number with no stated basis is not a readable audit.
        var nSla = entries.filter(function (e) { return e.slaScaled; }).length;
        if (nSla) {
          var q3 = document.createElement('span');
          q3.textContent = 'status limits: ' + nSla + ' of ' + entries.length + ' scaled by the client SLA';
          q3.title = 'Scaled by the WO\u2019s own priority.responseMinutes / category rather than by parsing "P1".."P4" out of the priority label \u2014 most clients do not use a P-number, so those rows used to fall through to a neutral 1.0x.';
          ql.appendChild(q3);
        }
        var nUnres = entries.filter(function (e) { return e.assignee === '(unresolved member)'; }).length;
        if (nUnres) {
          var q4 = document.createElement('span');
          q4.textContent = nUnres + ' assignee' + (nUnres === 1 ? '' : 's') + ' unresolved';
          q4.title = 'The board returned only an id for these and the user(id:) lookup did not answer. Shown as "(unresolved member)" rather than folded into "(blank)" \u2014 unreadable is not the same as unassigned.';
          ql.appendChild(q4);
        }
        panel.appendChild(ql);
      }

      if (!entries.length) {
        var empty = document.createElement('div'); empty.className = 'empty';
        var p1 = document.createElement('p');
        p1.textContent = 'No scan yet \u2014 the audit needs a full sweep of the list to give book-wide numbers.';
        var runBtn = document.createElement('button');
        runBtn.type = 'button'; runBtn.className = 'primary'; runBtn.textContent = 'Run Scan All now';
        runBtn.addEventListener('click', function () {
          closePanel();
          var sumEl = document.getElementById(SUM_ID);
          var btns = sumEl ? sumEl.querySelectorAll('button') : [];
          for (var b = 0; b < btns.length; b++) {
            if (/scan/i.test(btns[b].textContent)) { btns[b].click(); break; }
          }
        });
        empty.appendChild(p1); empty.appendChild(runBtn);
        panel.appendChild(empty);
      }

      if (entries.length) {
        function groupTinted(field) {
          var g = {}, denom = {};
          entries.forEach(function (e) {
            var k = e[field] || '(blank)';
            denom[k] = (denom[k] || 0) + 1;              // v3.8: denominator = all scanned rows in the group
            if (e.sev === 0) return;
            if (!g[k]) g[k] = { bad: 0, warn: 0 };
            if (e.sev === 2) g[k].bad++; else g[k].warn++;
          });
          return Object.keys(g).map(function (k) { return { k: k, bad: g[k].bad, warn: g[k].warn, tot: g[k].bad + g[k].warn, all: denom[k] || 0 }; })
            .sort(function (a, b) { return b.bad - a.bad || b.tot - a.tot; });
        }
        var cols = document.createElement('div'); cols.className = 'cols';
        // "By phase" only appears when the scan actually READ a phase - a fourth column of
        // "(blank)" off a DOM scan would be worse than no column.
        var dims = [['By status', 'status'], ['By assignee', 'assignee'], ['By client', 'client']];
        if (entries.some(function (e) { return !!e.phase; })) dims.push(['By phase', 'phase']);
        dims.forEach(function (def) {
          var col = document.createElement('div'); col.className = 'col';
          var h4 = document.createElement('h4'); h4.textContent = def[0]; col.appendChild(h4);
          var groups = groupTinted(def[1]).slice(0, 6);
          var maxTot = groups.reduce(function (m, g) { return Math.max(m, g.tot); }, 1);
          groups.forEach(function (g) {
            var active = heatDim && heatDim.field === def[1] && heatDim.value === g.k;
            var kv = document.createElement('div'); kv.className = 'kv click' + (active ? ' on' : '');
            kv.title = (active ? 'Click to clear this filter' : 'Click to show only "' + g.k + '" rows in the list') +
              ' - ' + g.tot + ' of ' + g.all + ' scanned rows flagged';
            var k = document.createElement('span'); k.className = 'k'; k.textContent = g.k;
            var v = document.createElement('span'); v.className = 'v' + (g.bad ? ' bad' : '');
            v.textContent = g.bad + 'R/' + g.warn + 'A of ' + g.all;
            if (!active) {
              var pct = Math.round(g.tot / maxTot * 100);
              kv.style.background = 'linear-gradient(90deg, rgba(192,57,43,.07) ' + pct + '%, transparent ' + pct + '%)';
            }
            kv.appendChild(k); kv.appendChild(v);
            kv.addEventListener('click', function () {
              heatDim = active ? null : { field: def[1], value: g.k };
              woListHeat();
              var pn = document.getElementById(PANEL_ID);
              if (pn) { pn.remove(); toggleAuditPanel(); }
            });
            col.appendChild(kv);
          });
          cols.appendChild(col);
        });
        panel.appendChild(cols);

        if (heatDim) {
          var matches = entries.filter(function (e) {
            if (e[heatDim.field] !== heatDim.value) return false;
            return true;
          }).sort(function (a, b) { return b.sev - a.sev || (parseFloat(b.hrs.replace(/,/g, '')) || 0) - (parseFloat(a.hrs.replace(/,/g, '')) || 0); });
          var mt = document.createElement('div'); mt.className = 'off';
          var h4m = document.createElement('h4');
          h4m.textContent = 'Matching WOs (' + matches.length + ')';
          mt.appendChild(h4m);
          var Cm = bwnConfig();   // Cn is declared below (hoisted, still undefined here)
          matches.slice(0, 40).forEach(function (e) {
            var row = document.createElement('div'); row.className = 'orow';
            var a = document.createElement('a'); a.href = e._href; a.textContent = e.wo || e._href;
            var cl = document.createElement('span'); cl.className = 'cl'; cl.textContent = e.client + ' \u00b7 ' + e.status + ' \u00b7 ' + e.assignee;
            var rs = document.createElement('span'); rs.className = 'rs';
            rs.textContent = e.reasons.length ? e.reasons.join(' \u00b7 ') : (e.hrs ? e.hrs + 'h in status' : '');
            rs.title = rs.textContent;
            row.appendChild(a); row.appendChild(cl); row.appendChild(rs);
            addNextStep(row, e, Cm);
            addSnooze(row, e);
            mt.appendChild(row);
          });
          if (matches.length > 40) {
            var more = document.createElement('div'); more.className = 'orow';
            var sp = document.createElement('span'); sp.className = 'cl';
            sp.textContent = '\u2026 and ' + (matches.length - 40) + ' more \u2014 Copy Audit TSV for the full set';
            more.appendChild(sp); mt.appendChild(more);
          }
          panel.appendChild(mt);
        }

        // The playbook's own top step for this row, next to the symptom. "What is wrong"
        // and "what to do about it" were two different tools until now: the reasons came
        // from the heat model, the step from the WO page. Same engine, one line.
        // Silent when the engine cannot rank the row from board fields alone - an audit
        // that invents a next step is worse than one that shows none.
        function addNextStep(row, e, C) {
          var act = null;
          try { act = heatNextStep(e, C); } catch (eN) { act = null; }
          if (!act || !act.label) return;
          var ns = document.createElement('span');
          ns.className = 'ns';
          ns.textContent = '→ ' + act.label;
          ns.title = 'Next step from the WO Assist playbook, ranked from this row’s status, priority, clock and dates only'
            + (act.why ? ' - ' + act.why : '')
            + '. A board row carries no POs, trips, notes or documents, so PO / no-show / docs / note steps cannot be judged here.';
          row.appendChild(ns);
        }

        // Snooze/unsnooze on any listed WO (v3.8): acts on the kind-based ack store.
        function addSnooze(row, e) {
          if (!(e.sev > 0) || !e.id) return;
          // LIVE state from the ack store \u2014 heatStore's cached flag only refreshes
          // for virtualizer-rendered rows, so an off-screen WO's cached value goes
          // stale the moment it is toggled from this panel.
          var isAcked = ackGet(e.id, e.kinds || []);
          var sz = document.createElement('button');
          sz.type = 'button'; sz.className = 'sz';
          sz.textContent = isAcked ? 'Unsnooze' : 'Snooze ' + ACK_DAYS + 'd';
          sz.title = isAcked
            ? 'Re-alarm this WO now'
            : 'Acknowledge this exact problem set for ' + ACK_DAYS + ' days \u2014 a NEW kind of problem re-alarms immediately';
          sz.addEventListener('click', function () {
            if (isAcked) ackClear(e.id); else ackSet(e.id, e.kinds || []);
            if (heatStore && heatStore[e._href]) heatStore[e._href].acked = !isAcked;   // keep the store honest for off-screen rows
            woListHeat();
            var pnS = document.getElementById(PANEL_ID); if (pnS) { pnS.remove(); toggleAuditPanel(); }
          });
          row.appendChild(sz);
        }

        var off = document.createElement('div'); off.className = 'off';
        if (heatDim) off.style.display = 'none';   // Matching WOs supersedes it
        var h4o = document.createElement('h4'); h4o.textContent = 'Top offenders (vs. their own status limit)'; off.appendChild(h4o);
        // v3.8: rank by hours RELATIVE to the row's own threshold (status class \u00d7
        // priority), not raw hours \u2014 a P1 active job 3\u00d7 over its limit outranks a
        // blocked P4 job with more absolute hours.
        var Cn = bwnConfig();
        function loadRatio(e) {
          var h2 = parseFloat(String(e.hrs || '').replace(/,/g, ''));
          if (isNaN(h2)) return 0;
          // Rank against the SAME limit the row was JUDGED by, SLA included. Without the
          // 4th arg an API row would be ranked on the label-parsed limit while its red/amber
          // came from the SLA one, so the ordering would disagree with the reasons beside it.
          var th2 = thresholdsFor(e.status, e.prio, Cn, e.sla);
          return th2.bad > 0 ? h2 / th2.bad : 0;
        }
        entries.filter(function (e) { return e.sev > 0; })
          .sort(function (a, b) { return b.sev - a.sev || loadRatio(b) - loadRatio(a); })
          .slice(0, 10)
          .forEach(function (e) {
            var row = document.createElement('div'); row.className = 'orow';
            var a = document.createElement('a'); a.href = e._href; a.textContent = e.wo || e._href;
            var cl = document.createElement('span'); cl.className = 'cl';
            var lr = loadRatio(e);
            cl.textContent = e.client + (lr >= 1 ? ' \u00b7 ' + lr.toFixed(1) + '\u00d7 limit' : '');
            var rs = document.createElement('span'); rs.className = 'rs'; rs.textContent = e.reasons.join(' \u00b7 '); rs.title = e.reasons.join(' \u00b7 ');
            row.appendChild(a); row.appendChild(cl); row.appendChild(rs);
            addNextStep(row, e, Cn);
            addSnooze(row, e);
            off.appendChild(row);
          });
        panel.appendChild(off);
      }

      var pf = document.createElement('div'); pf.className = 'pf';
      var hint = document.createElement('span'); hint.className = 'hint';
      hint.textContent = 'TSV pastes straight into Excel \u00b7 worst first';
      pf.appendChild(hint);
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button'; copyBtn.className = 'primary'; copyBtn.textContent = 'Copy Audit TSV';
      copyBtn.addEventListener('click', function () {
        if (!entries.length) { copyBtn.textContent = 'Run Scan All first'; setTimeout(function () { copyBtn.textContent = 'Copy Audit TSV'; }, 1800); return; }
        // New trailing columns only - anything already pasting this into a sheet keeps its
        // existing column positions, and the four API-only fields are simply blank on a
        // DOM scan rather than shifting everything right.
        var COLS = ['WO', 'Client', 'Status', 'Priority', 'Assigned To', 'Hrs In Status', '# Days', 'DNE', 'Scheduled', 'Last Note', 'Complete By', 'Heat', 'Reasons',
          'Phase', 'Vendor NTE', 'Vendors', 'Next Step'];
        var Ct = bwnConfig();
        var lines = [COLS.join('\t')];
        entries.slice().sort(function (a, b) { return b.sev - a.sev || (parseFloat(b.hrs.replace(/,/g, '')) || 0) - (parseFloat(a.hrs.replace(/,/g, '')) || 0); })
          .forEach(function (e) {
            var act = null;
            try { act = heatNextStep(e, Ct); } catch (eT) { act = null; }
            lines.push([e.wo, e.client, e.status, e.prio, e.assignee, e.hrs, e.days, e.dne, e.sched, e.lastNote, e.exp,
              e.sev === 2 ? 'RED' : e.sev === 1 ? 'AMBER' : '', e.reasons.join(' | '),
              e.phase, e.nte, e.vendors, act && act.label]
              .map(function (v) { return String(v || '').replace(/[\t\n]/g, ' '); }).join('\t'));
          });
        navigator.clipboard.writeText(lines.join('\n')).then(function () {
          copyBtn.textContent = 'Copied \u2713';
          setTimeout(function () { copyBtn.textContent = 'Copy Audit TSV'; }, 1500);
        }, function () { prompt('Copy manually:', lines.join('\n').slice(0, 2000) + '\u2026'); });
      });
      pf.appendChild(copyBtn);
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button'; closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', closePanel);
      pf.appendChild(closeBtn);
      panel.appendChild(pf);

      sum.parentNode.insertBefore(panel, sum.nextSibling);
    }

    // ---- Settings panel (Phase 3: suite-wide config editor) ---------------------
    var SET_FIELDS = [
      ['targetGP', 'Target GP %'], ['gpWarn', 'GP warn %'], ['gpBad', 'GP red %'],
      ['hrsWarn', 'Hours warn'], ['hrsBad', 'Hours red'], ['activeMult', 'Active status \u00d7'],
      ['dueWarnDays', 'Due warn (days)'], ['schedGraceDays', 'Sched grace (days)'], ['noteStaleDays', 'Note stale (days)']
    ];
    function toggleSettings() {
      var oldP = document.getElementById('bwn-heat-set');
      if (oldP) { oldP.remove(); return; }
      var ap = document.getElementById(PANEL_ID); if (ap) ap.remove();   // one panel at a time
      var sum = document.getElementById(SUM_ID);
      if (!sum || !sum.parentNode) return;
      var C = bwnConfig();
      var panel = document.createElement('div');
      panel.id = 'bwn-heat-set';
      var ph = document.createElement('div'); ph.className = 'ph';
      ph.textContent = 'SUITE SETTINGS \u00b7 SHARED BY WO ASSIST + WO LIST HEAT';
      panel.appendChild(ph);
      var grid = document.createElement('div'); grid.className = 'grid';
      var inputs = {};
      SET_FIELDS.forEach(function (f) {
        var w = document.createElement('div');
        var l = document.createElement('label'); l.textContent = f[1];
        var inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any';
        inp.value = String(C[f[0]]);
        inputs[f[0]] = inp;
        w.appendChild(l); w.appendChild(inp); grid.appendChild(w);
      });
      panel.appendChild(grid);
      // Per-client profiles (T10): a JSON override table for bwn:config `clients`. Empty/unset
      // falls back to the seed table. Prefilled from the live value; parsed + validated on Save.
      var cw = document.createElement('div'); cw.className = 'jsonw';
      cw.style.marginTop = '8px';
      var cl2 = document.createElement('label');
      cl2.textContent = 'Per-client profiles (JSON) — closeout docs, ref-field gates, cadence';
      cl2.style.display = 'block';
      var cta = document.createElement('textarea');
      cta.rows = 10; cta.spellcheck = false;
      cta.style.width = '100%'; cta.style.boxSizing = 'border-box';
      cta.style.fontFamily = 'var(--bwn-mono, ui-monospace, monospace)'; cta.style.fontSize = '11px';
      try { cta.value = JSON.stringify(C.clients || BWN.CLIENT_PROFILE_SEED, null, 2); } catch (eJ) { cta.value = '{}'; }
      cw.appendChild(cl2); cw.appendChild(cta);
      panel.appendChild(cw);
      var pf = document.createElement('div'); pf.className = 'pf';
      var hint = document.createElement('span'); hint.className = 'hint';
      hint.textContent = 'saving invalidates scan results \u2014 rescan after';
      pf.appendChild(hint);
      var resetBtn = document.createElement('button');
      resetBtn.type = 'button'; resetBtn.textContent = 'Reset to defaults';
      resetBtn.addEventListener('click', function () {
        try { localStorage.removeItem('bwn:config'); } catch (e) { }
        document.dispatchEvent(new CustomEvent('bwn:config'));
        panel.remove(); toggleSettings();
      });
      pf.appendChild(resetBtn);
      var saveBtn = document.createElement('button');
      saveBtn.type = 'button'; saveBtn.className = 'primary'; saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', function () {
        var partial = {}, ok = true;
        SET_FIELDS.forEach(function (f) {
          var n = parseFloat(inputs[f[0]].value);
          if (isNaN(n) || n < 0) { inputs[f[0]].style.borderColor = 'var(--bwn-bad)'; ok = false; }
          else { inputs[f[0]].style.borderColor = ''; partial[f[0]] = n; }
        });
        // Per-client profiles (T10): parse the JSON; red-border on a parse error, same as the
        // numeric fields. An object is saved under `clients`; cfgSave preserves the rest.
        var parsedClients;
        try { parsedClients = JSON.parse(cta.value); cta.style.borderColor = ''; }
        catch (eP) { cta.style.borderColor = 'var(--bwn-bad)'; ok = false; }
        if (ok && parsedClients && typeof parsedClients === 'object') partial.clients = parsedClients;
        if (!ok) return;
        bwnConfigSave(partial);
        saveBtn.textContent = 'Saved \u2713';
        setTimeout(function () { panel.remove(); }, 600);
      });
      pf.appendChild(saveBtn);
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button'; closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', function () { panel.remove(); });
      pf.appendChild(closeBtn);
      panel.appendChild(pf);
      sum.parentNode.insertBefore(panel, sum.nextSibling);
    }

    // Config changes invalidate scan results \u2014 but only when a HEAT-RELEVANT
    // threshold actually moved. AI-knob saves ride the same bwn:config event and
    // must not throw away a book-wide scan they cannot affect.
    function heatCfgSignature() {
      var C9 = bwnConfig();
      return [C9.hrsWarn, C9.hrsBad, C9.activeMult, C9.dueWarnDays, C9.schedGraceDays, C9.noteStaleDays].join('|');
    }
    var heatCfgSig = heatCfgSignature();
    document.addEventListener('bwn:config', BWN.guard(function () {
      if (heatScanning) return;
      var sig9 = heatCfgSignature();
      if (sig9 === heatCfgSig) { woListHeat(); return; }   // nothing heat-relevant changed
      heatCfgSig = sig9;
      if (heatStore) {
        heatStore = null; heatRaw = null; heatRowsCache = null;
        console.info('[BWN HEAT] config changed \u2014 scan results invalidated, run Scan All for fresh book-wide numbers');
      }
      woListHeat();
    }, 'listHeat:config'));

    // ---- Scan dispatcher: API first, scroll as the safety net ----------------------
    // The button calls this. If a list query was captured off the wire, do the exact
    // API scan; anything short of a clean, high-confidence full board falls through to
    // the proven scroll sweep so the user is never left with a silent partial.
    function runScan(btn) {
      if (heatScanning) return;
      if (apiList && authToken()) {
        apiScanAll(btn).then(function (ok) {
          if (!ok) { console.info('[BWN HEAT] API scan unavailable/low-confidence - falling back to scroll scan.'); scanAll(btn); }
        }, function (err) {
          console.warn('[BWN HEAT] API scan errored - falling back to scroll scan:', err && err.message || err);
          heatScanning = false; heatReplaying = false; btn.disabled = false; scanAll(btn);
        });
      } else {
        scanAll(btn);
      }
    }

    // Auto-run of the API scan only (v3.17). Called when a board query is captured, which
    // is also exactly when a filter change lands, so the board-wide numbers follow the
    // filters the same way the list does. Silent on every refusal - this must never nag.
    // Failure backoff for the auto scan (2026-08-09). The guard below used to suppress a
    // repeat on `heatStore` - which a DIRTY finish had just nulled. So a scan that kept
    // failing kept retrying, at the debounce interval, forever: a retry whose suppression
    // depends on the success it never achieves. Measured live at one replay every ~770ms
    // until the user changed the filter. See wiki/dirty-scan-retry-loop.md.
    //
    // `heatStore &&` STAYS, because it does a different and still-correct job: a route change
    // nulls the store without any failure, and coming back to the same filter must rescan
    // rather than sit on a store that no longer exists. What was missing is a record of the
    // last failed ATTEMPT, which is what actually bounds a failing retry.
    var heatAutoFailSig = null, heatAutoFailTs = 0, heatAutoFailN = 0;
    var HEAT_FAIL_BACKOFF_MIN = 2000, HEAT_FAIL_BACKOFF_MAX = 60000;
    function heatAutoBackoffMs() {
      // 2s, 4s, 8s, ... capped at 60s. Capped rather than unbounded so a filter that is
      // permanently dirty (a search matching nothing, left open) still re-checks occasionally
      // instead of going silent for the rest of the session.
      return Math.min(HEAT_FAIL_BACKOFF_MAX, HEAT_FAIL_BACKOFF_MIN * Math.pow(2, Math.max(0, heatAutoFailN - 1)));
    }
    function heatAutoScan(vars, force) {
      if (!heatAutoOn() || heatScanning || heatReplaying || !isListPage()) { heatDiag.autoNoGate++; return; }
      if (!apiList || !apiList.query || !authToken()) { heatDiag.autoNoGate++; return; }   // manual button still covers these
      var sig = heatFilterSig(vars || (apiList && apiList.variables));
      // `force` bypasses BOTH throttles below and nothing else. It is for a caller that must
      // READ BACK A WRITE it just made: a status change alters no filter, so the signature is
      // unchanged and neither throttle would let a scan through - and the caller would then
      // read the PRE-WRITE store and call the write verified. The gates above still apply,
      // because they are correctness conditions (no token, wrong route, scan already running),
      // not throttles.
      if (!force && sig && sig === heatAutoFailSig && (Date.now() - heatAutoFailTs) < heatAutoBackoffMs()) { heatDiag.autoNoBackoff++; return; }
      if (!force && sig && sig === heatAutoSig && heatStore && (Date.now() - heatAutoTs) < HEAT_AUTO_TTL) { heatDiag.autoNoTtl++; return; }
      heatDiag.autoRan++;
      heatAutoSig = sig;
      heatAutoTs = Date.now();
      // Use the real Scan All button when the strip is up so the user sees "Scanning (API)…"
      // rather than numbers changing on their own; a bare object keeps apiScanAll happy if
      // the strip has not rendered yet.
      var btn = document.getElementById('bwn-heat-scan') || { };
      // Returned so a FORCED caller can await the finish rather than poll for it.
      return apiScanAll(btn).then(function (ok) {
        if (!ok) console.info('[BWN HEAT] auto API scan was low-confidence - press Scan All for the scroll sweep.');
        return !!ok;
      }, function (err) {
        // heatReplaying MUST be cleared here: left true, the net hook ignores every later
        // request and capture is dead for the rest of the page's life.
        heatScanning = false; heatReplaying = false; heatStore = null; heatRaw = null; heatRowsCache = null;
        try { btn.disabled = false; btn.textContent = 'Scan All'; } catch (e) { }
        console.warn('[BWN HEAT] auto API scan errored - press Scan All to sweep manually:', (err && err.message) || err);
        // An errored scan still ENDED. Tell the consumers, or one that pulled mid-scan sits on
        // "scan in progress" for the rest of the page's life.
        heatRowsAnnounce();
        return false;
      });
    }
    // Forced scan for a caller that must READ BACK a write it just made. Resolves when the
    // scan has finished and the row snapshot has been rebuilt, so an awaiting caller cannot
    // observe the pre-write store.
    //
    // An in-flight scan is AWAITED, never duplicated: two concurrent replays writing one store
    // is the drift shape, and the running scan is already going to produce the fresh read the
    // caller wants. Resolves false when no scan is possible at all (no capture, not a list
    // page, auto-heat off) so the caller can say so rather than hang.
    var heatForceWait = null;
    function heatForceScan() {
      if (heatScanning || heatReplaying) {
        if (heatForceWait) return heatForceWait;
        // A scan started by someone else, with no promise to join: poll the flags rather than
        // duplicate it. Bounded, because a wedged scan must not hang the caller.
        return new Promise(function (resolve) {
          var tries = 0;
          var iv = setInterval(function () {
            if (!heatScanning && !heatReplaying) { clearInterval(iv); resolve(!!heatScanClean); return; }
            if (++tries > 120) { clearInterval(iv); resolve(false); }   // ~60s ceiling
          }, 500);
        });
      }
      var p = heatAutoScan(null, true);
      // heatAutoScan returns undefined when it refuses outright (not a list page, no capture,
      // auto-heat off). Normalising here keeps every caller on one promise contract.
      heatForceWait = Promise.resolve(p === undefined ? false : p).then(function (ok) {
        heatForceWait = null;
        return !!ok;
      }, function () { heatForceWait = null; return false; });
      return heatForceWait;
    }
    function heatAutoScanSoon(vars) {
      if (heatAutoTimer) clearTimeout(heatAutoTimer);
      heatAutoTimer = setTimeout(function () { heatAutoTimer = null; heatAutoScan(vars); }, 700);
    }

    // ---- Seed fallback: the pinned board query when nothing latched (2026-08-13) -----
    // WHY. The API scan replays a captured PagedWorkOrders query. Capture is PASSIVE: the
    // document-start hook only sees the board query if it wins the race with the app's own
    // boot overwrite of window.fetch (the app grabs its transport reference at boot - see
    // installGqlHook). When the hook loses that race, apiList stays null for the page's whole
    // life: every scan path reports 'no capture yet', the manual button falls to the slow
    // scroll sweep, and the book-wide numbers never arrive without a click.
    //
    // The board op is now PINNED (captured off the wire 2026-08-13; see
    // wiki/umbrava-graphql-operations.md): op PagedWorkOrders, and the ONLY two REQUIRED,
    // non-null args are `page: PageInput!` and `sortBy: [SortInput!]!`. So Core carries the
    // exact query and seeds apiList itself, and the API scan runs whether or not the passive
    // capture ever fired.
    //
    // The seed is DELIBERATELY WEAK and always loses to a real capture:
    //   - marked seeded:true / proven:false, and heatRecordCapture's anti-downgrade guard
    //     lets ANY real board request displace a seed - a real capture carries the user's
    //     actual filters, the seed only knows the tenant-wide open book (phase:Open).
    //   - the query text is BYTE-IDENTICAL to what the SPA sends, so when the app's own board
    //     query fires, heatRecordCapture's `body.query === apiList.query` branch simply swaps
    //     in the real variables and re-scans - the seed converts to a live capture with no
    //     churn. If Umbrava ever changes the query text, the seed is displaced instead.
    //   - it is armed on a GRACE TIMER, not immediately, so in the normal case (the passive
    //     capture wins within the grace window) the seed never fires and behaviour is
    //     unchanged. Killable per browser via the existing localStorage['bwn:heat:autoscan']='0'.
    var HEAT_SEED_GRACE_MS = 3500;
    var heatSeedTimer = null;
    var HEAT_DEFAULT_QUERY = [
      'query PagedWorkOrders($page: PageInput!, $sortBy: [SortInput!]!, $search: String, $filter: [ColumnFilterInput!], $statuses: [Int], $statusesInclusive: Boolean = true, $onlyUnassigned: Boolean = false, $assignedTo: [ID], $clientId: ID, $vendorId: ID, $locationId: ID, $assetId: ID, $WorkOrderNumbers: [Int], $phase: SystemPhaseValue, $locationIds: [ID!], $regionIds: [ID!], $regionPrefixes: [String!]) {',
      '  __typename',
      '  listWorkOrdersPaginated(',
      '    page: $page',
      '    sortBy: $sortBy',
      '    search: $search',
      '    filter: $filter',
      '    statuses: $statuses',
      '    statusesInclusive: $statusesInclusive',
      '    onlyUnassigned: $onlyUnassigned',
      '    assignedTo: $assignedTo',
      '    clientId: $clientId',
      '    vendorId: $vendorId',
      '    locationId: $locationId',
      '    assetId: $assetId',
      '    WorkOrderNumbers: $WorkOrderNumbers',
      '    phase: $phase',
      '    locationIds: $locationIds',
      '    regionIds: $regionIds',
      '    regionPrefixes: $regionPrefixes',
      '  ) {',
      '    __typename',
      '    rowCount',
      '    take',
      '    firstRowOnPage',
      '    lastRowOnPage',
      '    items {',
      '      __typename',
      '      address {',
      '        __typename',
      '        addressLine1',
      '        addressLine2',
      '        city',
      '        state',
      '        postalCode',
      '      }',
      '      trackingNumber',
      '      timeInStatus',
      '      assetName',
      '      assetTagId',
      '      assignedTo',
      '      assignedToMemberName',
      '      clientName',
      '      clientTenantProfileId',
      '      createdByMemberName',
      '      createdBy_UserProfileId',
      '      doNotExceed {',
      '        __typename',
      '        amount',
      '        currency',
      '        precision',
      '      }',
      '      formattedJobNumber',
      '      id',
      '      lastModifiedDate',
      '      lastNoteDate',
      '      locationName',
      '      locationNumber',
      '      nextOnsiteDate',
      '      number',
      '      numberOfDays',
      '      priority {',
      '        __typename',
      '        label',
      '        firstTripDate',
      '        expectedCompletionDate',
      '        category',
      '      }',
      '      remainingDays',
      '      scopeOfWork',
      '      state',
      '      statusName',
      '      statusId',
      '      trades {',
      '        __typename',
      '        id',
      '        name',
      '        systemTradeId',
      '        systemTradeName',
      '        isSystemTrade',
      '        hidden',
      '      }',
      '      vendorNames',
      '      workOrderDate',
      '      workOrderTypeName',
      '      workOrderTypeId',
      '      sourceJobNumber',
      '      sourcePurchaseOrderNumber',
      '      totalNTE {',
      '        __typename',
      '        amount',
      '        currency',
      '        precision',
      '      }',
      '      flag',
      '      workOrderCategory {',
      '        __typename',
      '        id',
      '        name',
      '        isActive',
      '        colorHex',
      '      }',
      '      phase',
      '      systemStatusId',
      '      systemStatusName',
      '    }',
      '  }',
      '}',
      ''
    ].join('\n');
    // Seed apiList with the pinned query IF nothing has latched. Returns false (no-op) when a
    // real capture or a prior seed already holds the slot, or when we are off the list route.
    function heatSeedCapture() {
      if (apiList && apiList.query) return false;
      if (!isListPage()) return false;
      apiList = {
        query: HEAT_DEFAULT_QUERY,
        // Scoped to phase Open on PURPOSE. The strip reports "of N open", and the whole
        // unfiltered book is every WO ever (373,657 on this tenant 2026-08-13) - far past the
        // 60-page x 200 scan cap, so an unscoped seed finishes 'incomplete' and drops the store.
        // phase:'Open' is the app's OWN default board scope (measured: the SPA sends phase:"Open")
        // and the open book is small enough to sweep clean (5,241 rows -> ~27 pages). SystemPhaseValue
        // enum literal 'Open' confirmed by introspection. No assignee/client filter: this is the
        // tenant-wide open book, which a real (filtered) capture replaces the moment one fires.
        variables: { page: { skip: 0, take: 200 }, sortBy: [{ columnName: 'formattedJobNumber', direction: 'DESC' }], phase: 'Open' },
        path: null, conn: false, _rows: 0, sample: null, proven: false, seeded: true
      };
      apiCapTs = Date.now();
      console.info('[BWN HEAT] no board query captured off the wire; seeding the pinned PagedWorkOrders fallback (phase:Open) for a book-wide open scan.');
      return true;
    }
    // SET-ONCE arm (never clear-and-reset). woListHeat runs on every list mutation, and a
    // timer cleared+re-armed on each call never fires on a busy SPA (wiki/observer-debounce-
    // starves). The route-change handler clears heatSeedTimer, so leaving the list cancels a
    // pending seed and returning re-arms fresh.
    function heatArmSeedFallback() {
      if (heatSeedTimer) return;
      heatSeedTimer = setTimeout(function () {
        heatSeedTimer = null;
        if (!isListPage()) return;
        if (apiList && apiList.query) return;   // the passive capture won the race - leave it
        if (!authToken()) return;           // no bearer to replay with; the scroll button still covers it
        if (heatSeedCapture()) heatAutoScan(apiList.variables);
      }, HEAT_SEED_GRACE_MS);
    }

    // ---- API scan: replay the captured list query across the whole board ------------
    // Deterministic and virtualizer-free. Resolves true on a clean, confident full
    // board (heatStore filled, snapshot written); false to hand off to the scroll scan.
    function apiScanAll(btn) {
      if (!apiList || !apiList.query) return Promise.resolve(false);
      // Captured NOW, not read in finishApi: a real capture can displace the seed during the async
      // name-resolution step, but the dataset decision must reflect the scan that actually ran.
      var seededScan = !!apiList.seeded;
      heatScanning = true; heatScanClean = false; heatScanAbort = false; heatStore = {}; heatRaw = {}; heatRowsCache = null; heatReplaying = true;
      btn.disabled = true; btn.textContent = 'Scanning (API)…';
      var progEl = document.getElementById('bwn-heat-prog');
      var target = umbravaTotal();
      if (progEl) { progEl.style.display = 'block'; progEl.classList.add('indet'); }

      // Discover the paging argument(s) - nested object (Umbrava's PageInput) or flat.
      var vars0 = apiList.variables || {};
      var pg = heatPagingVars(vars0);
      var PAGE = 200, CAP = 60;
      if (pg && pg.pageSize > PAGE) PAGE = Math.min(pg.pageSize, 500);

      var seen = {}, pages = 0, badRows = 0, totalRows = 0, lastHave = 0;
      var vars = JSON.parse(JSON.stringify(vars0));
      // Where the paging keys live: inside the captured object for a nested arg, else
      // alongside the other variables. Writing a NUMBER over a nested object is what the
      // server rejected outright before v3.18, so the object is edited in place.
      var pgHost = (pg && pg.nested) ? vars[pg.host] : vars;
      if (pg && pgHost) {
        if (pg.size) pgHost[pg.size] = PAGE;
        if (pg.cursor) pgHost[pg.cursor] = null;
        if (pg.skip) pgHost[pg.skip] = 0;
        else if (pg.page) pgHost[pg.page] = (typeof pgHost[pg.page] === 'number' && pgHost[pg.page] === 0) ? 0 : 1;
      }

      function absorb(rows) {
        for (var i = 0; i < rows.length; i++) {
          var mapped = heatApiRowToEntry(rows[i]);
          totalRows++;
          if (!mapped) { badRows++; continue; }
          if (seen[mapped.href]) continue;
          seen[mapped.href] = 1;
          // Raw row kept beside the mapped entry - see the heatRaw declaration for why the
          // normalized entry is not enough for an out-of-module renderer.
          if (heatRaw) heatRaw[mapped.href] = rows[i];
          // Compute the verdict now so heatStore carries sev/reasons/kinds like the DOM path.
          var C = bwnConfig();
          var e = mapped.entry;
          var vf = heatVerdictFor(e, C);
          var acked = vf.sev > 0 ? ackGet(e.id, vf.kinds) : false;
          heatStore[mapped.href] = {
            id: e.id, kinds: vf.kinds.slice(), acked: acked, sev: vf.sev, reasons: vf.reasons.slice(),
            wo: e.wo, tracking: e.tracking, status: e.status, prio: e.prio, client: e.client,
            assignee: e.assignee, hrs: e.hrs, days: e.days, dne: e.dne, sched: e.sched, lastNote: e.lastNote, exp: e.exp,
            // v2 dataset fields - present from BOTH scan paths (DOM columns or wire), so they sit in
            // the shared block, not the API-only one below.
            sourceJob: e.sourceJob, sourcePo: e.sourcePo, projectType: e.projectType, woDate: e.woDate,
            // In-House Dispatch upgrade: window/trade/location facts (present from the API scan).
            woCreatedAt: e.woCreatedAt, locationNumber: e.locationNumber, trade: e.trade, tradeSys: e.tradeSys,
            // API-only facts. The DOM scan leaves these undefined and every consumer
            // treats undefined as "not read" rather than as a zero.
            assigneeId: e.assigneeId, nte: e.nte, dneAmt: e.dneAmt, nteAmt: e.nteAmt,
            phase: e.phase, vendors: e.vendors, vendorsKnown: e.vendorsKnown, city: e.city, state: e.state,
            street1: e.street1, street2: e.street2, zip: e.zip,
            remDays: e.remDays, sla: e.sla, slaScaled: vf.slaScaled, src: 'api',
            // The limits this row was judged against, so a consumer can print "1.8x the
            // 120h limit" without a second threshold model (see computeVerdict's header).
            warn: vf.warn, bad: vf.bad
          };
        }
      }

      function finishApi(clean, note) {
        heatScanning = false; heatReplaying = false; btn.disabled = false; btn.textContent = 'Rescan All';
        if (progEl) { progEl.style.display = 'none'; progEl.classList.remove('indet'); progEl.firstChild.style.width = '0'; }
        heatScanClean = !!clean; heatScanNote = note || null;
        var n = heatStore ? Object.keys(heatStore).length : 0;
        // A dirty API finish drops the store (v3.18). `scanned` in the banner is just
        // `!!heatStore`, so an empty-but-present store would have the strip announce
        // "of 0 open - full board" off a scan that actually failed. No store = the strip
        // falls back to the loaded rows and still says "Scan All for full board".
        if (!clean) { heatStore = null; heatRaw = null; }
        // Arm (or clear) the failure backoff. This is the record the auto-scan guard needs:
        // WHICH filter failed and WHEN, kept separately from the success bookkeeping above,
        // because the failure is exactly the case where the success record is unavailable.
        if (clean) { heatAutoFailSig = null; heatAutoFailN = 0; }
        else { heatAutoFailSig = heatAutoSig; heatAutoFailTs = Date.now(); heatAutoFailN++; }
        // v3.24: publish EVERY scanned row's verdict to the per-WO bus slot, not just the rows
        // the virtualizer happened to render. `bwn:heat:{id}` is an existing contract already
        // read through BWN.busHeatGet (WO Assist's "Flagged on WO list"), so this is the same
        // contract at full-board coverage rather than a new one. Measured 2026-08-05 on a
        // 219-row board: 22 keys existed, because the ONLY writer was the DOM tinting pass -
        // so any second consumer saw heat on a tenth of the board and no severity on the rest.
        // Additive fields only and `v` stays 1: busHeatGet rejects any other version outright.
        // Only on a clean finish - a dirty scan drops the store above, and publishing a
        // partial board as if it were the board is the mistake `heatScanClean` exists to stop.
        // heatPublishVerdicts feeds the per-WO bus (uncapped, benefits from full open coverage);
        // heatQueueDataset feeds the Dashboard and is SKIPPED for a seeded scan - the seed is the
        // transient tenant-wide OPEN book, not the user's real board (a real capture re-scans and
        // pushes the proper per-user dataset), which also sidesteps the HEAT_DATASET_MAX cap.
        if (clean && heatStore) { heatPublishVerdicts(heatStore); if (!seededScan) heatQueueDataset(heatStore); else dispatchQueueDataset(heatStore); }
        // Announce on EVERY finish, clean or dirty - see heatRowsAnnounce for why. A consumer
        // that pulled mid-scan is stuck on "scan in progress" until something tells it the scan
        // ended, and a dirty finish is exactly when that matters most.
        heatRowsAnnounce();
        console.info('[BWN HEAT] API scan ' + (clean ? 'complete' : 'incomplete') + ':', n, 'WOs in', pages, 'page(s)' + (note ? ' | ' + note : '') + (target != null ? ' | list total ' + target : ''));
        woListHeat();
        if (clean) heatSnapshot();
        var pn = document.getElementById(PANEL_ID); if (pn) { pn.remove(); toggleAuditPanel(); }
        // Names, and with them the inactive-user signal, land a beat later: the scan itself
        // must not block on a second round trip, so the strip and panel render immediately
        // off the ids and then re-render once. Deliberately AFTER the snapshot above - the
        // snapshot counts sev, and re-judging can only ever ADD an orphan amber, so a name
        // arriving late must not retro-edit the day's recorded numbers. The re-render is
        // skipped entirely when nothing changed.
        if (clean && heatStore) {
          var store = heatStore;
          heatResolveAssignees(store).then(function (changed) {
            if (!changed || heatStore !== store) return;   // navigated away, or nothing to fill
            // Re-publish: resolution can only ADD an orphan amber, and a row the virtualizer
            // is not rendering has no other writer, so without this the bus would hold a
            // verdict one signal out of date for most of the board.
            heatPublishVerdicts(store);
            if (!seededScan) heatQueueDataset(store); else dispatchQueueDataset(store);
            // Rebuild and re-announce for the same reason the bus is re-published: name
            // resolution can ADD an orphan amber, so a consumer holding the first snapshot
            // would render a verdict one signal out of date for most of the board.
            heatRowsAnnounce();
            woListHeat();
            var pn2 = document.getElementById(PANEL_ID); if (pn2) { pn2.remove(); toggleAuditPanel(); }
          }, function () { /* resolution is best-effort; the ids never reach the panel either way */ });
        }
      }

      // A route change mid-scan nulls heatStore under us; absorbing into it would throw
      // and leave heatReplaying stuck true, which silently kills capture for the rest of
      // the page's life. Bail cleanly instead.
      function aborted() { return heatScanAbort || !heatStore; }

      function step() {
        if (aborted()) { finishApi(false, 'navigated away mid-scan'); return Promise.resolve(false); }
        return heatGql(apiList.query, vars).then(function (data) {
          if (aborted()) { finishApi(false, 'navigated away mid-scan'); return false; }
          pages++;
          var found = heatFindWOList(data) || (apiList.path ? { path: apiList.path, conn: apiList.conn } : null);
          if (!found || !found.path) { finishApi(false, 'could not locate the WO rows in the API response'); return false; }
          var rows = heatRowsAtPath(data, found);
          if (!rows.length && pages === 1) { finishApi(false, 'first API page returned no rows'); return false; }
          absorb(rows);
          var have = Object.keys(heatStore).length;
          // The replay proved the shape: remember the row path so a later scan does not
          // have to rediscover it, and stop treating the capture as a guess.
          if (have) { apiList.proven = true; apiList.path = found.path; apiList.conn = found.conn; }

          // The server's own count for these filters beats the DOM badge, which is not
          // always findable on the list header.
          var container = heatContainerAtPath(data, found);
          var ct = heatContainerTotal(container);
          if (ct !== null) { target = ct; heatApiTotal = ct; }

          btn.textContent = 'Scanning (API)… ' + have + (target ? '/' + target : '');
          if (progEl && target) { progEl.classList.remove('indet'); progEl.firstChild.style.width = Math.min(100, Math.round(have / target * 100)) + '%'; }

          // Advance. Cursor > skip/offset > page number; else single-shot. `room` prefers
          // the known total, and a page that added nothing new is always a stop - without
          // that a server which ignores the offset would page forever against the cap.
          var pageInfo = container && container.pageInfo;
          var grew = have > lastHave;
          lastHave = have;
          var room = grew && (target == null ? rows.length > 0 : have < target);
          if (pg && pg.cursor && pageInfo) {
            if (pageInfo.hasNextPage && pageInfo.endCursor && pages < CAP) { pgHost[pg.cursor] = pageInfo.endCursor; return step(); }
            return doneCheck();
          }
          if (pg && pg.skip) {
            // Advance by the rows the server ACTUALLY returned, not by the size we asked
            // for: a server free to cap `take` below our page size (Umbrava honors 200, but
            // nothing promises that) would otherwise leave a hole between every page.
            if (rows.length && room && pages < CAP) { pgHost[pg.skip] = (Number(pgHost[pg.skip]) || 0) + rows.length; return step(); }
            return doneCheck();
          }
          if (pg && pg.page) {
            if (rows.length && room && pages < CAP) { pgHost[pg.page] = (Number(pgHost[pg.page]) || 0) + 1; return step(); }
            return doneCheck();
          }
          // No pagination arg we recognize: the enlarged single call is all we get.
          return doneCheck();
        });
      }

      function doneCheck() {
        var have = Object.keys(heatStore).length;
        // Confidence gate: if too many rows failed to map to a real WO, the captured
        // query is the wrong shape for the heat model - hand back to the scroll scan.
        if (totalRows > 0 && badRows / totalRows > 0.5) { finishApi(false, 'row mapping low-confidence (' + badRows + '/' + totalRows + ' unmapped)'); return false; }
        // Honesty about coverage vs the list's own total (same rule the scroll scan uses).
        if (target != null && have < target * 0.9) { finishApi(false, 'API returned ' + have + ' of ' + target + ' - likely a filtered/paginated query'); return false; }
        finishApi(true, target != null && have < target ? 'below list total ' + target + ' - filtered view accepted as clean' : null);
        return true;
      }

      return step();
    }

    // ---- In-House Dispatch sync trigger --------------------------------------------
    // Runs the tenant-wide OPEN seed scan on demand and pushes bwn:dispatchq (drained by the
    // connector to the SWA). The seeded scan is otherwise a passive fallback a real per-user
    // board capture pre-empts, so the dispatch feed needs an explicit runner. Two entry points:
    // the console global below, and the bwn:cmd bus so the connector's one-click menu can drive
    // the SCAN (it lives in bwn-suite-ai, a separate @grant sandbox, and cannot call this global).
    // Side effect: the live heat strip shows whole-open-book numbers until the next real board
    // capture displaces the seed (self-heals, same as the seed fallback). Resolves apiScanAll's
    // promise (true on a clean scan).
    function dispatchSyncNow() {
      if (!isListPage()) { console.warn('[BWN DISPATCH] open the Work Orders LIST first.'); return Promise.resolve(false); }
      if (!authToken()) { console.warn('[BWN DISPATCH] no auth bearer captured yet - load the WO list once, then retry.'); return Promise.resolve(false); }
      apiList = null;   // drop any per-user capture so the tenant-wide OPEN seed is what runs
      if (!heatSeedCapture()) { console.warn('[BWN DISPATCH] could not seed the open-book query.'); return Promise.resolve(false); }
      var btn = document.getElementById('bwn-heat-scan') || { disabled: false, textContent: '' };
      console.info('[BWN DISPATCH] syncing the whole open book for the In-House Dispatch Report...');
      return apiScanAll(btn);
    }
    if (typeof window !== 'undefined') window.__bwnDispatchSyncNow = dispatchSyncNow;
    // One-click sync from the connector: bwn-suite-ai dispatches bwn:cmd 'bwn:dispatch:sync' (it can't
    // reach the page global from its sandbox), we run the scan, and on finish emit bwn:evt
    // 'bwn:dispatch:synced' {ok, rows} so the connector drains bwn:dispatchq. A clean scan has already
    // rewritten bwn:dispatchq (dispatchQueueDataset); rows is that fresh count, 0 on a failed scan.
    var dispatchBusRunning = false;
    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail; if (!d || d.id !== 'bwn:dispatch:sync') return;
      if (dispatchBusRunning) return;   // one scan at a time
      dispatchBusRunning = true;
      function announce(ok) {
        dispatchBusRunning = false;
        var ds = ok ? BWN.lsGetJSON('bwn:dispatchq', null) : null;
        var rows = (ds && Array.isArray(ds.rows)) ? ds.rows.length : 0;
        try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:dispatch:synced', ok: !!ok, rows: rows } })); } catch (e2) { }
      }
      Promise.resolve(dispatchSyncNow()).then(function (ok) { announce(!!ok); }, function () { announce(false); });
    }, 'dispatch:cmd'));

    // ---- Scan All (scroll fallback) -------------------------------------------------
    function listScroller() {
      var table = findBodyTable();
      var anchor = table ? rowWOLink(table) : null;
      var node = anchor ? anchor.parentElement : (table ? table.parentElement : null);
      while (node && node !== document.body) {
        var st2 = getComputedStyle(node);
        if (/(auto|scroll)/.test(st2.overflowY) && node.scrollHeight > node.clientHeight + 20) return node;
        node = node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }
    function scanAll(btn) {
      if (heatScanning) return;
      heatScanning = true;
      heatScanClean = false;   // trend/snapshot writes unlock only on a clean finish
      heatStore = {};
      // The scroll sweep reads the DOM, so there are no raw API rows behind it. Null rather than
      // left over: joining heatStore to a PREVIOUS scan's raw rows would render one scan's
      // severity against another scan's row data.
      heatRaw = null; heatRowsCache = null;
      btn.disabled = true;
      // Coverage-driven sweep: passes alternate direction (down, then up) because
      // virtualizers can systematically skip the same offsets in one direction.
      // Keeps sweeping until the store matches Umbrava's own total badge, the
      // gain hits zero (min 2 passes), or the pass cap is reached.
      var STEP = 0.5, TICK_MS = 320, MID_MS = 110, MID2_MS = 220, MAX = 900, PASS_MAX = 5;
      var steps = 0, stable = 0, lastCount = -1, zeroGain = 0, edgeStable = 0;
      var lastTop = -1, stuck = 0, forcedWindow = false, forcedWindowCount = -1;
      var pass = 1, passStartCount = 0, down = true;
      var target = umbravaTotal();
      var box = listScroller();
      box.scrollTop = 0;
      console.info('[BWN HEAT] scan start | scroller:', box === document.scrollingElement || box === document.documentElement ? 'window' : (box.className || box.tagName), '| h:', box.scrollHeight + '/' + box.clientHeight, '| list badge total:', target === null ? 'not found' : target);
      var progEl = document.getElementById('bwn-heat-prog');
      function setProg(n) {
        if (!progEl) return;
        progEl.style.display = 'block';
        if (target) {
          progEl.classList.remove('indet');
          progEl.firstChild.style.width = Math.min(100, Math.round(n / target * 100)) + '%';
        } else {
          progEl.classList.add('indet');
        }
      }
      function clearProg() {
        if (!progEl) return;
        progEl.style.display = 'none';
        progEl.classList.remove('indet');
        progEl.firstChild.style.width = '0';
      }
      function capture() { woListHeat(); return heatStore ? Object.keys(heatStore).length : 0; }
      function atEdge() {
        return down
          ? box.scrollTop + box.clientHeight >= box.scrollHeight - 5
          : box.scrollTop <= 5;
      }
      function move() {
        var delta = box.clientHeight * STEP;
        box.scrollTop = down
          ? Math.min(box.scrollTop + delta, box.scrollHeight)
          : Math.max(box.scrollTop - delta, 0);
      }
      function tick() {
        box = forcedWindow ? (document.scrollingElement || document.documentElement) : listScroller();
        var n = capture();
        setProg(n);
        btn.textContent = 'Scanning\u2026 ' + n + (target ? '/' + target : '') + ' (pass ' + pass + (down ? '\u2193' : '\u2191') + ')';
        if (steps < 3 || steps % 10 === 0) {
          console.info('[BWN HEAT] scan tick', steps, '| pass', pass, down ? 'down' : 'up', '| top:', Math.round(box.scrollTop) + '/' + box.scrollHeight, '| store:', n);
        }
        if (target !== null && n > target) {
          console.info('[BWN HEAT] store (' + n + ') exceeded badge total (' + target + ') \u2014 badge was wrong, ignoring it');
          target = null;                                   // wrong hint: fall back to gain-based convergence
        }
        if (target !== null && n === target) { finish(null); return; }   // exact full coverage: done
        if (Math.round(box.scrollTop) === lastTop) stuck++; else stuck = 0;
        lastTop = Math.round(box.scrollTop);
        if (stuck >= 4 && !forcedWindow) {
          forcedWindow = true; stuck = 0; forcedWindowCount = n;   // remember coverage at the switch, to judge gain
          console.info('[BWN HEAT] scroller not moving \u2014 falling back to window scrolling');
        } else if (stuck >= 6 && forcedWindow) {
          // A frozen scrollTop is ALSO the normal terminal state of a fully-loaded list, so do NOT
          // declare the scan dirty on that alone (that false positive nagged Over-30 Lines after a
          // good Scan All). Judge by GAIN, matching the zero-gain principle below: dirty only if we
          // are demonstrably short of a trusted badge total, or rows were still arriving when the
          // scroll froze (we out-ran a lazy loader); otherwise the loaded view is exhausted = full
          // coverage = CLEAN.
          var gainedSinceForced = (forcedWindowCount >= 0) ? (n - forcedWindowCount) : 0;
          if (target !== null && n < target) { finish('short of list total ' + target + ' (' + n + ') - it may paginate instead of lazy-load'); return; }
          if (gainedSinceForced > 0) { finish('list did not load more rows under scroll - it may paginate instead of lazy-load'); return; }
          finish(null);   // frozen, no new rows, and not short of a trusted total = exhausted = clean
          return;
        }
        stable = (n === lastCount) ? stable + 1 : 0;
        lastCount = n;
        // Stability must be EARNED AT THE EDGE, not inherited from a flat mid-sweep:
        // otherwise a pass ends the instant it touches the edge (~0-320ms), a lazy
        // bottom-load never gets to fire, and two such passes would read as zero-gain
        // convergence → a lagging loader marked CLEAN and written into the day's
        // snapshot/trend (review MAJOR). ~2s of edge dwell per pass gives the fetch a
        // real window; loading rows change n → stable resets → the pass continues.
        edgeStable = atEdge() ? edgeStable + 1 : 0;
        if (steps++ > MAX) { finish('step cap reached'); return; }
        if (atEdge() && stable >= 6 && edgeStable >= 6) {
          var gained = n - passStartCount;
          zeroGain = gained === 0 ? zeroGain + 1 : 0;
          console.info('[BWN HEAT] pass', pass, 'done | store:', n, '| new this pass:', gained, target !== null ? '| target: ' + target : '');
          // Two consecutive full passes (opposite directions) with ZERO new rows = the
          // loaded view is exhausted - that IS full coverage of what this view can render.
          // Treat as CLEAN even below the badge total: the badge can count rows a filtered
          // (e.g. my-team) view never loads, which used to leave every team scan
          // permanently "dirty" and nag on Over-30 Lines (user-reported).
          if (zeroGain >= 2 && pass >= 2) {
            if (target !== null && n < target) console.info('[BWN HEAT] converged at', n, 'below badge total', target, '- badge likely counts rows outside this filtered view; accepting as clean');
            finish(null);
            return;
          }
          var needMore = (target !== null && n < target) || gained > 0 || pass < 2;
          if (needMore && pass < PASS_MAX) {
            pass++; passStartCount = n; stable = 0; edgeStable = 0; lastCount = -1; lastTop = -1; stuck = 0;
            down = !down;                                  // sweep back the other way
            setTimeout(tick, TICK_MS);
            return;
          }
          // A pass-cap exit while rows were STILL LOADING is not a clean sweep:
          // it must not write the day's snapshot or trend numbers.
          finish(target !== null && n < target ? 'short of list total ' + target + ' after ' + pass + ' passes'
            : (gained > 0 ? 'pass cap reached while rows were still loading' : null));
          return;
        }
        move();
        setTimeout(capture, MID_MS);
        setTimeout(capture, MID2_MS);
        setTimeout(tick, TICK_MS);
      }
      function finish(note) {
        var sc = listScroller();
        sc.scrollTop = 0;
        heatScanning = false;
        btn.disabled = false;
        btn.textContent = 'Rescan All';
        clearProg();
        heatScanClean = !note;       // gates the My Day trend write in renderMyDay too
        heatScanNote = note || null; // surfaced in the Over-30 confirm when dirty
        woListHeat();
        if (!note) heatSnapshot();   // clean convergence only - a partial sweep must not become the day's record
        var total = heatStore ? Object.keys(heatStore).length : 0;
        console.info('[BWN HEAT] scan complete:', total, 'WO rows counted | passes:', pass + (note ? ' | ' + note : ''));
        // Refresh the Audit panel if it is open so it never shows a stale snapshot.
        var pn = document.getElementById(PANEL_ID);
        if (pn) { pn.remove(); toggleAuditPanel(); }
      }
      tick();
    }

    // ---- My Day strip (pilot: additive, task-independent) ---------------------------
    // A glance at what needs the coordinator today, drawn from the board they
    // already scan. Counts EMPTY as work advances and a re-scan runs. Over-30
    // here = OPEN jobs past 30 days (the Orange tag) - what you can still act on,
    // not the completed-jobs incentive metric.
    var MYDAY_O30_KEY = 'bwn:myday:o30hist';
    function mydayDateKey(d) {
      d = d || new Date();
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
    function mydayO30Load() {
      try { return JSON.parse(localStorage.getItem(MYDAY_O30_KEY) || '{}') || {}; }
      catch (e) { return {}; }
    }
    // Record today's full-board over-30 count and return the delta vs the most
    // recent EARLIER day on record. Call only with a full-board (scanned) count
    // so a partial pre-scan can't overwrite the day's real number. Returns
    // { delta, since } or null when there's no earlier day to compare against.
    function mydayO30Track(count) {
      var hist = mydayO30Load();
      var today = mydayDateKey();
      var priorDays = Object.keys(hist).filter(function (k) { return k < today; }).sort();
      var ref = priorDays.length ? priorDays[priorDays.length - 1] : null;
      hist[today] = count;
      var allDays = Object.keys(hist).sort();
      while (allDays.length > 30) { delete hist[allDays.shift()]; }
      try { localStorage.setItem(MYDAY_O30_KEY, JSON.stringify(hist)); } catch (e) { /* quota - non-fatal */ }
      if (ref === null) return null;
      return { delta: count - hist[ref], since: ref };
    }
    // ---- Batch Over-30 lines (bridge to the AI script) ------------------------
    // Stages the aged-open-job rows from the FULL-BOARD scan into sessionStorage
    // and hands off over bwn:cmd; the AI script drafts one "OVER 30 -" line per
    // job from these structured facts (no note history - that's the single-WO
    // mode) and shows the results panel. Requires Scan All so coverage is honest.
    function o30AiReady() {
      try {
        var mp = JSON.parse(localStorage.getItem('bwn:modules') || '{}');
        if (mp && typeof mp.clientUpdate === 'boolean' && !mp.clientUpdate) return false;
      } catch (e) { }
      try {
        var ai = JSON.parse(localStorage.getItem('bwn:status:ai') || 'null');
        var core = JSON.parse(localStorage.getItem('bwn:status:core') || 'null');
        // No ai.anthropic (key) requirement anymore: the batch panel now renders
        // deterministic fact-lines instantly and uses the API only to polish them,
        // so it is fully useful without a key.
        return !!(ai && ai.ver && core && Math.abs((core.ts || 0) - (ai.ts || 0)) < 60000);
      } catch (e) { return false; }
    }
    function o30BatchStart() {
      // Coverage honesty (review-caught): scanAll() creates heatStore EMPTY at sweep
      // start, so "store exists" is not "scan finished". Reject mid-sweep, and warn
      // on a dirty/aborted sweep - same flags that gate the My Day trend write.
      if (heatScanning) { alert('Scan in progress - let it finish, then run Over-30 Lines.'); return; }
      if (!heatStore) { alert('Run Scan All first - the batch drafts from the full-board scan data.'); return; }
      if (!heatScanClean && !window.confirm('The last scan did not finish cleanly' + (heatScanNote ? ' (' + heatScanNote + ')' : '') + ' - coverage may be partial. Draft lines anyway?')) return;
      var jobs = [];
      Object.keys(heatStore).forEach(function (k) {
        var o = heatStore[k];
        var days = parseFloat(String(o.days || '').replace(/,/g, ''));
        if (isNaN(days) || days <= 30) return;
        if (heatDone(o.status, o.phase)) return;
        jobs.push({
          href: k, wo: o.wo || '', tracking: o.tracking || '', client: o.client || '', status: o.status || '',
          prio: o.prio || '', days: Math.round(days), hrs: o.hrs || '', dne: o.dne || '',
          sched: o.sched || '', lastNote: o.lastNote || '', exp: o.exp || '',
          reasons: (o.reasons || []).slice(0, 4)
        });
      });
      if (!jobs.length) { alert('No open over-30 jobs in the scan.'); return; }
      try { sessionStorage.setItem('bwn:o30batch', JSON.stringify({ v: 1, ts: Date.now(), jobs: jobs })); }
      catch (e) { alert('Could not stage the batch data (storage full?).'); return; }
      document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'ai:over30batch' } }));
    }

    function myDayCounts() {
      var C = bwnConfig();
      var open = 0, over30 = 0, limitBad = 0, limitWatch = 0, stale = 0, total = 0, scanned = !!heatStore;
      function tally(o) {
        total++;
        if (heatDone(o.status, o.phase)) return;
        open++;
        // `phase` must travel with the row (v3.22). Without it the row passes the heatDone
        // gate above on its phase and is then judged silent by the name regex INSIDE the
        // engine - counted as open, but contributing nothing to any pill. That reads as
        // "19 more open jobs and not one of them has a problem", which is worse than the
        // bug it replaces.
        // `sla` travels for the same reason (v3.23) - a stored API row carries the client's
        // response clock, and the pills have to be counted against the SAME limit the row was
        // tinted and ranked by. A DOM-built row has no sla key -> undefined -> the label parse.
        var vf = computeVerdict({
          status: o.status, prio: o.prio, phase: o.phase, sla: o.sla,
          ageDays: parseFloat(String(o.days || '').replace(/,/g, '')),
          hrs: parseFloat(String(o.hrs || '').replace(/,/g, '')),
          expTs: parseUSDate(o.exp), schedTs: parseUSDate(o.sched), lastNoteTs: parseUSDate(o.lastNote)
        }, C);
        if (vf.over30) over30++;
        if (vf.limitBad) limitBad++; else if (vf.limitWatch) limitWatch++;
        if (vf.stale) stale++;
      }
      if (heatStore) {
        Object.keys(heatStore).forEach(function (k) { tally(heatStore[k]); });
      } else {
        var table = findBodyTable(), H = table ? alignMap(headerMap(), table) : null;
        if (table && H) {
          var rows = table.querySelectorAll('tbody tr'); if (!rows.length) rows = table.rows;
          Array.prototype.forEach.call(rows, function (tr) {
            if (!rowWOLink(tr)) return;
            var dTxt = cellText(tr, H.days);
            if (!dTxt && H.created >= 0) {   // same WO-Date age fallback as the main sweep
              var cr2 = parseUSDate(cellText(tr, H.created));
              if (cr2 !== null) dTxt = String(dSince(cr2));
            }
            tally({ status: cellText(tr, H.status), prio: cellText(tr, H.prio), days: dTxt, hrs: cellText(tr, H.hrs), lastNote: cellText(tr, H.lastNote) });
          });
        }
      }
      return { open: open, over30: over30, limitBad: limitBad, limitWatch: limitWatch, stale: stale, total: total, scanned: scanned };
    }
    function renderMyDay() {
      var sum = document.getElementById(SUM_ID);
      if (!sum || !sum.parentNode) { var ex0 = document.getElementById('bwn-myday'); if (ex0) ex0.remove(); return; }
      var d = myDayCounts();
      var el = document.getElementById('bwn-myday');
      if (!el) {
        el = document.createElement('div');
        el.id = 'bwn-myday';
        sum.parentNode.insertBefore(el, sum.nextSibling);   // sits directly under the heat banner
      }
      while (el.firstChild) el.removeChild(el.firstChild);
      var tag = document.createElement('span'); tag.className = 'md-t'; tag.textContent = 'MY DAY';
      el.appendChild(tag);
      function applyMydayFilter(fkey) {
        mydayFilter = (mydayFilter === fkey) ? null : fkey;
        woListHeat();
        var pn = document.getElementById(PANEL_ID); if (pn) { pn.remove(); toggleAuditPanel(); }
      }
      function chip(label, n, kind, title, fkey) {
        var c = document.createElement('span');
        c.className = 'md-c ' + (n > 0 ? kind : 'zero') + (n > 0 && mydayFilter === fkey ? ' filt' : '');
        var t = document.createElement('span'); t.textContent = n + ' ' + label;
        c.appendChild(t);
        c.title = title + (n > 0 && fkey ? ' - click to filter the list to these (click again to clear).' : '');
        if (n > 0 && fkey) {
          c.setAttribute('role', 'button');
          c.setAttribute('tabindex', '0');
          c.setAttribute('aria-pressed', mydayFilter === fkey ? 'true' : 'false');
          c.addEventListener('click', function () { applyMydayFilter(fkey); });
          c.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyMydayFilter(fkey); } });
        }
        el.appendChild(c);
        return c;
      }
      var o30chip = chip('over 30d', d.over30, 'bad', 'Open jobs older than 30 days (the Orange tag). Open jobs you can still act on - not the completed-jobs scorecard metric.', 'over30');
      // Over-30 day-over-day trend. Trustworthy only on a CLEAN full-board scan -
      // mid-sweep repaints and partial/aborted scans must not overwrite the day's
      // real number (mirrors the bwn:heat:snap gating).
      if (d.scanned && heatScanClean && !heatScanning) {
        var tk = mydayO30Track(d.over30);
        if (tk) {
          var dv = document.createElement('span');
          var up = tk.delta > 0, dn = tk.delta < 0;
          dv.className = 'md-d ' + (up ? 'up' : dn ? 'down' : 'flat');
          dv.textContent = (up ? '▲' : dn ? '▼' : '±') + Math.abs(tk.delta);
          dv.title = 'Change in open over-30 count since ' + tk.since + ' (last full scan on record). Down is good.';
          o30chip.appendChild(dv);
        }
      }
      chip('past status limit', d.limitBad, 'bad', 'Open jobs past the time limit for their current status. The status sets the clock (active vs. blocked statuses and priority scale it); Time in Status is the trigger.', 'limitbad');
      chip('watch', d.limitWatch, 'warn', 'Open jobs approaching their status time limit - not over yet, but getting close.', 'limitwatch');
      if (d.stale > 0) chip('no note ' + bwnConfig().noteStaleDays + 'd+', d.stale, 'warn', 'No note in over ' + bwnConfig().noteStaleDays + ' days - the job reads as unworked.', 'nonote');
      var meta = document.createElement('span'); meta.className = 'md-m';
      meta.textContent = d.scanned ? 'of ' + d.open + ' open · full board' : 'of ' + d.open + ' open loaded · Scan All for full board';
      el.appendChild(meta);
    }

    // ---- Lifecycle ------------------------------------------------------------------
    // Cross-module refresh hook: BWN Views calls this after switching column sets
    // so the overlay re-detects the heat columns in place (no page reload needed).
    window.__bwnHeatRefresh = function () { diagFor = ''; woListHeat(); };

    // ---- Row surface for out-of-module renderers -------------------------------------
    // Consumers are in OTHER Tampermonkey scripts, which is only possible because every
    // participant is `@grant none` and therefore shares the page's window - a GM_* grant on
    // either side puts it in a sandbox where these are invisible.
    //
    // Pull, never push: the bwn:heat:rows event carries no payload, so a consumer that loads
    // late, misses it, or re-renders for its own reasons always gets the current answer by
    // asking.
    window.__bwnHeatRows = function () {
      if (heatRowsCache) return heatRowsCache;
      // No cache does not always mean no data - a caller can arrive between a clean scan and
      // the announce. Build once on demand rather than reporting empty.
      var built = heatRowsBuild();
      if (built) { heatRowsCache = built; return built; }
      return { ok: false, reason: heatRowsWhy(), ts: Date.now() };
    };
    // Force a fresh scan and resolve when its snapshot is ready. For READ-BACK AFTER A WRITE.
    // Do not call this to refresh a view - that is what the auto-scan TTL is for, and forcing
    // on every render would put a duplicate full-board scan straight back.
    window.__bwnHeatScan = function (opts) {
      if (opts && opts.force) return heatForceScan();
      var p = heatAutoScan(null, false);
      return Promise.resolve(p === undefined ? false : p);
    };
    // LIVE ack state. The snapshot's `acked` is a scan-time value; this reads the ack store
    // itself, which is what this module does for its own rows (see addSnooze). A consumer that
    // renders `acked` off the snapshot will disagree with the list the moment anyone snoozes.
    window.__bwnHeatAck = function (id, kinds) {
      try { return ackGet(id, kinds || []); } catch (e) { return false; }
    };

    // Read-only diagnostic for the auto-scan trigger path (2026-08-09). Answers exactly one
    // question that black-box testing could not: when a filter change does NOT scan, is it
    // because the capture never reached the re-arm, or because a guard refused it?
    //
    // DELIBERATELY carries no signatures, variables or query text. A filter signature encodes
    // the list's search box and filter values, which on this tenant can be client-identifying,
    // and this is a page-context global any script on the origin can read. Booleans, counts and
    // ages only - enough to attribute a fault, useless to an onlooker.
    window.__bwnHeatDiag = function () {
      var v = null;
      try { v = apiList && apiList.variables; } catch (e) { }
      return {
        counts: {
          captureSeen: heatDiag.seen,          // heatRecordCapture entered
          skippedAsReplay: heatDiag.replaySkip, // ...refused by the heatReplaying flag
          skippedAsOwnBody: heatDiag.ownSkip,   // ...refused by replay identity (the 1.76.0 fix)
          reArmed: heatDiag.rearm,              // ...reached heatAutoScanSoon
          autoScanRan: heatDiag.autoRan,
          autoRefusedByBackoff: heatDiag.autoNoBackoff,
          autoRefusedByTtl: heatDiag.autoNoTtl,
          autoRefusedByGate: heatDiag.autoNoGate
        },
        flags: {
          scanning: !!heatScanning, replaying: !!heatReplaying, abort: !!heatScanAbort,
          lastScanClean: !!heatScanClean, hasStore: !!heatStore,
          storeRows: heatStore ? Object.keys(heatStore).length : 0,
          hasCapture: !!(apiList && apiList.query), captureProven: !!(apiList && apiList.proven),
          captureSeeded: !!(apiList && apiList.seeded),
          autoOn: (function () { try { return !!heatAutoOn(); } catch (e) { return null; } })(),
          onListRoute: (function () { try { return !!isListPage(); } catch (e) { return null; } })()
        },
        backoff: {
          armed: !!heatAutoFailSig,
          // Whether the ARMED failure is for the filter currently on screen - the thing that
          // decides if this backoff is the reason a rescan is not happening right now.
          matchesCurrentFilter: !!(heatAutoFailSig && v && heatAutoFailSig === heatFilterSig(v)),
          ageMs: heatAutoFailTs ? (Date.now() - heatAutoFailTs) : null,
          windowMs: heatAutoBackoffMs(),
          consecutiveFailures: heatAutoFailN
        },
        ownBodiesRemembered: heatOwnBodyQ.length
      };
    };

    var debounce = null;
    var lastPath = location.pathname;
    var obs = new MutationObserver(BWN.guard(function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        if (heatSeedTimer) { clearTimeout(heatSeedTimer); heatSeedTimer = null; }   // cancel a pending seed; woListHeat re-arms on the list route
        if (heatScanning) heatScanAbort = true;   // an in-flight scan must not write into a nulled store
        heatStore = null; heatRaw = null; heatRowsCache = null;
        heatScanClean = false;
        heatDim = null;
        diagFor = '';
        totCache = { path: '', v: null };
        var hs = document.getElementById(SUM_ID); if (hs) hs.remove();
        var pn = document.getElementById(PANEL_ID); if (pn) pn.remove();
      }
      clearTimeout(debounce);
      debounce = setTimeout(BWN.guard(woListHeat, 'listHeat:refresh'), 500);
    }, 'listHeat:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    woListHeat();
  });

  // ==========================================================================
  // MODULE: BWN Launcher v2.0  (+ shared bwn:dock:* host for suite launchers)
  // ==========================================================================
  bwnBoot('launcher', BWN_MODULES.launcher, function () {
    'use strict';

    if (window.__bwnLauncher) return;
    window.__bwnLauncher = true;

    console.info('[BWN LAUNCH] v2.0.4 loaded (dock host, edge rail + tools on the rail)');

    // ---- App registry (EDIT PATHS HERE) --------------------------------------
    // All BWN tools live on one Azure Static Web App. Set each tool's path
    // (e.g. '/jobboard.html' or '/pricing'). Entries with an empty path are
    // hidden. The Home entry always shows. context:true appends WO params when
    // launched from a WO page:
    //   ?tracking=&wo=&woId=&client=&location=&status=&dne=&gpPct=
    var LAUNCHER_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
    var LAUNCHER_APPS = [
      // NOTE: link straight to the tool file. The splash at '/' redirects to the
      // tracker and DROPS the query string, killing the context handoff.
      // `short` is what the rail shows - the full label does not fit a 158px row.
      { id: 'jobBoard',  label: 'Projects Job Board',    short: 'Job Board', path: '/Broadway_Projects_Tracker.html', context: true },
      // Not yet deployed on this host (verified 404) - set paths when published:
      { id: 'pricing',   label: 'Pricing Assistant',     path: '',   context: true },
      { id: 'intake',    label: 'Client Profile Intake', path: '',   context: false },
      { id: 'agenda',    label: 'Daily Ops Agenda',      path: '',   context: false }
    ];

      var DOCK_ID = 'bwn-launch-dock';
    var DOCK_STACK_ID = 'bwn-dock-stack';   // shared launcher dock: one dark rail card (logo + icon rows) on the left edge

    // ---- Bus + page context (shared via BWN core) -----------------------------
    var currentWOId = BWN.woId;
    var busGet = BWN.busGet;
    function woContext() {
      var id = currentWOId();
      if (!id) return null;
      var b = busGet(id, 12 * 3600000) || {};
      return {
        woId: id,
        tracking: (b.tracking || '').replace(/\D+/g, ''),
        wo: b.wo || '',
        client: b.client || '',
        addr: b.addr || '',
        location: b.location || '',
        status: b.status || '',
        dne: typeof b.dne === 'number' ? String(b.dne) : '',
        gpPct: typeof b.gpPct === 'number' ? b.gpPct.toFixed(1) : ''
      };
    }
    // Copy the WO as a RICH clipboard entry (text/html + text/plain) so pasting into
    // Teams/Outlook yields a clickable label, not a bare URL. @grant none: uses the
    // native async Clipboard API under the menu-click gesture; degrades to plain text.
    function copyWOLink(ctx, labelNode) {
      function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
      var label = 'WO ' + (ctx.wo || ctx.tracking || '?') + (ctx.tracking ? ' · #' + ctx.tracking : '') +
        (ctx.client ? ' · ' + ctx.client : '') + (ctx.location ? ' · ' + ctx.location : '');
      var url = location.href;
      var plain = label + ' - ' + url;
      var html = '<a href="' + esc(url) + '">' + esc(label) + '</a>';
      function done() { flashLabel(labelNode, 'Copied ✓'); }   // rail row acknowledges in place; nothing to close
      function plainCopy() { navigator.clipboard.writeText(plain).then(done, function () { prompt('Copy manually:', plain); }); }
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          var item = new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) });
          navigator.clipboard.write([item]).then(done, plainCopy);
        } else plainCopy();
      } catch (e) { plainCopy(); }
    }
    function isSafeHttpUrl(u) {
      try { var p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:'; }
      catch (e) { return false; }
    }
    function buildUrl(app) {
      if (!app.path) return null;
      var full = LAUNCHER_BASE.replace(/\/$/, '') + (app.path.charAt(0) === '/' ? app.path : '/' + app.path);
      if (!isSafeHttpUrl(full)) return null;
      if (!app.context) return full;
      var ctx = woContext();
      if (!ctx) return full;
      var u = new URL(full);
      Object.keys(ctx).forEach(function (k) { if (ctx[k]) u.searchParams.set(k, ctx[k]); });
      return u.toString();
    }

    // ---- Ops Suite panel: modules + thresholds + status (overhaul #2) ----------
    function lsGet(key, def) { try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : def; } catch (e) { return def; } }
    var SUITE_MODULES = [
      { k: 'clientUpdate', script: 'AI', label: 'AI Draft (Client Update / Audit)' },
      { k: 'findTechs', script: 'AI', label: 'Find Techs / Suppliers' },
      // Kill-switch honored LIVE by every connector tick in the AI script (no reload
      // needed) - off disables ALL SWA egress: activity events, checklist merge,
      // Over-30 line sync, and the daily trend relay.
      { k: 'connector', script: 'AI', label: 'SWA connector (dashboard sync + reporting)' },
      { k: 'poApproval', script: 'Core', label: 'PO Approval + ETA' },
      { k: 'woAssist', script: 'Core', label: 'WO Assist (GP/ETA watchdog)' },
      { k: 'leakGuard', script: 'Core', label: 'Email Leak Guard' },
      { k: 'listHeat', script: 'Core', label: 'WO List Heat + My Day' },
      { k: 'launcher', script: 'Core', label: 'Tools launcher - hosts this panel' },
      { k: 'viewManager', script: 'Core', label: 'Saved Views' },
      { k: 'palette', script: 'Core', label: 'Command palette (Ctrl/Cmd-K)' },
      { k: 'visitLog', script: 'Core', label: 'Visit memory - watch strip + EOD digest' },
      { k: 'reminders', script: 'Core', label: 'Follow-up reminders' },
      { k: 'notesTimeline', script: 'Core', label: 'Notes timeline (chronological read)' },
      { k: 'tripCal', script: 'Core', label: 'Trips → calendar (.ics export)' }
    ];
    var OPS_CFG_FIELDS = [['targetGP', 'Target GP %'], ['gpWarn', 'GP warn %'], ['gpBad', 'GP red %'], ['hrsWarn', 'Hours warn'], ['hrsBad', 'Hours red'], ['activeMult', 'Active ×'], ['dueWarnDays', 'Due warn (d)'], ['schedGraceDays', 'Sched grace (d)'], ['noteStaleDays', 'Note stale (d)']];
    var opsConfig = BWN.cfg;        // defaults + read/save now in the BWN core (single source of truth)
    var opsConfigSave = BWN.cfgSave;

    function openSuitePanel() {
      if (document.getElementById('bwn-ops-overlay')) return;
      ensureStyle();
      // Suite settings is a drawer like every other tool - it was the last centred
      // overlay Core still owned. Claim the shared slot so an open panel folds away.
      try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: 'settings' } })); } catch (e) { }
      var prevFocus = document.activeElement;
      var ov = document.createElement('div'); ov.id = 'bwn-ops-overlay'; ov.className = 'bwn-ops-overlay';
      var card = document.createElement('div'); card.className = 'bwn-ops-card';
      card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Ops Suite settings'); card.tabIndex = -1;

      var hd = document.createElement('div'); hd.className = 'bwn-ops-hd';
      var ht = document.createElement('div'); ht.className = 't'; ht.textContent = 'Ops Suite';
      var hs = document.createElement('div'); hs.className = 's'; hs.textContent = 'settings · stored in this browser';
      hd.appendChild(ht); hd.appendChild(hs); card.appendChild(hd);
      var body = document.createElement('div'); body.className = 'bwn-ops-body'; card.appendChild(body);

      function section(title, desc) {
        var s = document.createElement('div'); s.className = 'bwn-ops-sec'; s.appendChild(document.createTextNode(title));
        if (desc) { var d = document.createElement('span'); d.className = 'd'; d.textContent = desc; s.appendChild(d); }
        body.appendChild(s);
      }

      // Appearance - manual Light/Dark theme for BWN panels (persists to localStorage['bwn:theme'])
      section('Appearance', 'panel theme · this browser');
      (function () {
        var row = document.createElement('div'); row.className = 'bwn-ops-row';
        var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'Theme';
        var seg = document.createElement('span');
        seg.style.cssText = 'display:inline-flex;gap:2px;background:var(--bwn-surface-3);border:1px solid var(--bwn-border);border-radius:9px;padding:2px;flex:none;';
        function mk(val, text) {
          var b = document.createElement('button'); b.type = 'button'; b.textContent = text;
          b.setAttribute('aria-label', text.replace(/^\W+\s*/, '') + ' theme');
          b.style.cssText = 'border:none;background:transparent;color:var(--bwn-text-muted);font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;padding:5px 12px;border-radius:7px;cursor:pointer;';
          b.addEventListener('click', function () { BWN.setTheme(val); paintSeg(); });
          b._val = val; return b;
        }
        var bl = mk('light', '☀ Light'), bd = mk('dark', '☾ Dark');
        function paintSeg() {
          [bl, bd].forEach(function (b) {
            var on = BWN.getTheme() === b._val;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.style.background = on ? 'var(--bwn-surface)' : 'transparent';
            b.style.color = on ? 'var(--bwn-text-strong)' : 'var(--bwn-text-muted)';
            b.style.boxShadow = on ? '0 1px 3px rgba(13,38,26,.14)' : 'none';
          });
        }
        seg.appendChild(bl); seg.appendChild(bd); paintSeg();
        row.appendChild(lbl); row.appendChild(seg);
        body.appendChild(row);
      })();

      // Modules
      section('Modules', 'turn a tool on/off · reload to apply');
      var modPref = lsGet('bwn:modules', {}); if (!modPref || typeof modPref !== 'object') modPref = {};
      var reloadNote = null;
      var modCbs = {};   // k -> checkbox, so the master kill/restore can reflect state live

      // Master kill switch (Task 5): one emergency control that turns EVERY module off
      // (the SWA connector included). Connector-off is honored LIVE by the AI script each
      // tick; the rest of the modules gate at boot, so they apply on the next reload (the
      // reloadNote below says so). Restore returns the modules to their PRE-KILL state
      // (snapshotted once into bwn:modules:prekill), or to all-default-on if none was saved.
      (function () {
        var PREKILL = 'bwn:modules:prekill';
        function applyChecks() { SUITE_MODULES.forEach(function (m) { var c = modCbs[m.k]; if (c) c.checked = (m.k in modPref) ? !!modPref[m.k] : true; }); }
        var row = document.createElement('div'); row.className = 'bwn-ops-row';
        var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'Emergency';
        var wrap = document.createElement('span'); wrap.style.cssText = 'display:inline-flex;gap:6px;flex:none;';
        var kill = document.createElement('button'); kill.type = 'button'; kill.className = 'bwn-ops-btn'; kill.textContent = 'ALL BWN FEATURES OFF';
        kill.style.cssText = 'background:var(--bwn-bad,#c0392b);border-color:var(--bwn-bad,#c0392b);color:#fff;';
        var restore = document.createElement('button'); restore.type = 'button'; restore.className = 'bwn-ops-btn ghost'; restore.textContent = 'Restore';
        kill.addEventListener('click', function () {
          if (!window.confirm('Turn OFF every BWN feature (all modules + the SWA connector)?\n\nThe connector stops immediately; the rest apply after a page reload. Use Restore to bring them back.')) return;
          try { if (!localStorage.getItem(PREKILL)) localStorage.setItem(PREKILL, JSON.stringify(modPref)); } catch (e) { }   // snapshot the pre-kill state once
          SUITE_MODULES.forEach(function (m) { modPref[m.k] = false; });
          try { localStorage.setItem('bwn:modules', JSON.stringify(modPref)); } catch (e) { }
          applyChecks(); if (reloadNote) reloadNote.style.display = '';
          try { BWN.toast('warning', 'All BWN features off. Connector stopped now; reload to fully apply.', { timeout: 8000 }); } catch (e) { }
        });
        restore.addEventListener('click', function () {
          var snap = null; try { snap = JSON.parse(localStorage.getItem(PREKILL) || 'null'); } catch (e) { }
          if (snap && typeof snap === 'object') { modPref = snap; try { localStorage.setItem('bwn:modules', JSON.stringify(modPref)); localStorage.removeItem(PREKILL); } catch (e) { } }
          else { modPref = {}; try { localStorage.removeItem('bwn:modules'); } catch (e) { } }
          applyChecks(); if (reloadNote) reloadNote.style.display = '';
          try { BWN.toast('success', 'BWN features restored. Reload to fully apply.', { timeout: 6000 }); } catch (e) { }
        });
        wrap.appendChild(kill); wrap.appendChild(restore);
        row.appendChild(lbl); row.appendChild(wrap); body.appendChild(row);
      })();

      SUITE_MODULES.forEach(function (mod) {
        var on = (mod.k in modPref) ? !!modPref[mod.k] : true;
        var row = document.createElement('div'); row.className = 'bwn-ops-row';
        var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = mod.label;
        var scr = document.createElement('span'); scr.className = 'scr'; scr.textContent = mod.script;
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = on; cb.setAttribute('aria-label', mod.label + ' enabled');
        modCbs[mod.k] = cb;   // ref for the master kill/restore (Task 5)
        cb.addEventListener('change', function () {
          if (mod.k === 'launcher' && !cb.checked &&
              !window.confirm('Disabling the Tools launcher hides this settings panel after reload (recover by clearing the "bwn:modules" localStorage key). Continue?')) {
            cb.checked = true; return;
          }
          modPref[mod.k] = cb.checked;
          try { localStorage.setItem('bwn:modules', JSON.stringify(modPref)); } catch (e) { }
          if (reloadNote) reloadNote.style.display = '';
        });
        row.appendChild(lbl); row.appendChild(scr); row.appendChild(cb);
        body.appendChild(row);
      });
      reloadNote = document.createElement('div'); reloadNote.className = 'bwn-ops-note'; reloadNote.style.display = 'none';
      reloadNote.textContent = 'Reload the page to apply module changes.';
      body.appendChild(reloadNote);

      // Shortcuts (Task 6): edit the command-palette hotkey (bwn:config.keys.palette).
      // Saved via cfgSave, which fires bwn:config so the palette rebinds live (no reload).
      section('Shortcuts', 'command palette hotkey · applies live');
      (function () {
        var row = document.createElement('div'); row.className = 'bwn-ops-row';
        var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'Command palette';
        var inp = document.createElement('input'); inp.type = 'text'; inp.style.cssText = 'flex:none;width:140px;';
        var keysCur = (lsGet('bwn:config', {}) || {}).keys;
        inp.value = (keysCur && keysCur.palette) || 'mod+k';
        inp.setAttribute('aria-label', 'Command palette hotkey');
        inp.title = 'Needs a modifier. e.g. mod+k (mod = Ctrl on Windows, Cmd on Mac), ctrl+shift+p, alt+k';
        inp.addEventListener('change', function () {
          var v = inp.value.trim() || 'mod+k'; inp.value = v;
          var keys = Object.assign({}, keysCur || {}); keys.palette = v;
          opsConfigSave({ keys: keys });   // dispatches bwn:config -> the palette rebinds live
        });
        row.appendChild(lbl); row.appendChild(inp); body.appendChild(row);
      })();

      // Thresholds
      section('Thresholds', 'shared by WO Assist + List Heat');
      var grid = document.createElement('div'); grid.className = 'bwn-ops-grid';
      var cfg = opsConfig(); var inputs = {};
      OPS_CFG_FIELDS.forEach(function (f) {
        var w = document.createElement('div');
        var l = document.createElement('label'); l.textContent = f[1];
        var inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.value = String(cfg[f[0]]);
        inputs[f[0]] = inp; w.appendChild(l); w.appendChild(inp); grid.appendChild(w);
      });
      body.appendChild(grid);

      // AI drafting knobs (consumed by the AI script via bwn:config.ai; blank = default).
      section('AI drafting', 'model · recent window · preflight');
      var aiCur = (lsGet('bwn:config', {}) || {}).ai;
      if (!aiCur || typeof aiCur !== 'object') aiCur = {};
      var aiGrid = document.createElement('div'); aiGrid.className = 'bwn-ops-grid';
      function aiField(labelTx, val, ph, numeric) {
        var w = document.createElement('div');
        var l = document.createElement('label'); l.textContent = labelTx;
        var inp = document.createElement('input');
        inp.type = numeric ? 'number' : 'text';
        if (numeric) inp.step = '1'; else inp.style.textAlign = 'left';
        inp.value = (val === undefined || val === null) ? '' : String(val);
        if (ph) inp.placeholder = ph;
        w.appendChild(l); w.appendChild(inp); aiGrid.appendChild(w);
        return inp;
      }
      var aiModel = aiField('Model', aiCur.model || '', 'default');
      var aiWin = aiField('Recent window (d)', typeof aiCur.windowDays === 'number' ? aiCur.windowDays : '', '7', true);
      var wPf = document.createElement('div');
      var lPf = document.createElement('label'); lPf.textContent = 'Preflight pane';
      var selPf = document.createElement('select');
      selPf.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid var(--bwn-border);border-radius:7px;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;background:var(--bwn-surface);color:var(--bwn-text);';
      [['auto', 'Auto (large drafts)'], ['always', 'Always'], ['never', 'Never']].forEach(function (o) {
        var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; selPf.appendChild(op);
      });
      selPf.value = (aiCur.preflight === 'always' || aiCur.preflight === 'never') ? aiCur.preflight : 'auto';
      wPf.appendChild(lPf); wPf.appendChild(selPf); aiGrid.appendChild(wPf);
      body.appendChild(aiGrid);

      // Status
      section('Status', 'versions · API keys');
      var status = { core: lsGet('bwn:status:core', {}) || {}, ai: lsGet('bwn:status:ai', {}) || {}, ask: lsGet('bwn:status:ask', {}) || {} };
      function kv(k, v, cls) {
        var r = document.createElement('div'); r.className = 'bwn-ops-kv';
        var a = document.createElement('span'); a.textContent = k;
        var b = document.createElement('span'); b.className = 'v' + (cls ? ' ' + cls : ''); b.textContent = v;
        r.appendChild(a); r.appendChild(b); body.appendChild(r);
      }
      kv('Core script', status.core.ver ? 'v' + status.core.ver : 'not detected');
      // Both scripts republish status on every page load; if AI's timestamp is far
      // from Core's, the AI script did not load this session (disabled/uninstalled).
      var aiFresh = !!status.ai.ver && !!status.core.ts && Math.abs((status.core.ts || 0) - (status.ai.ts || 0)) < 60000;
      kv('AI script', status.ai.ver ? ('v' + status.ai.ver + (aiFresh ? '' : ' · stale (not loaded this session)')) : 'not loaded');
      if (aiFresh) {
        kv('Anthropic key', status.ai.anthropic ? 'set' : 'not set', status.ai.anthropic ? 'ok' : 'no');
        kv('Google Places key', status.ai.places ? 'set' : 'not set', status.ai.places ? 'ok' : 'no');
        kv('SWA ingest key', status.ai.ingest ? 'set' : 'not set', status.ai.ingest ? 'ok' : 'no');
      }
      // Ask is its own script and can be disabled on its own, so it gets the same freshness
      // treatment as AI rather than being assumed present.
      var askFresh = !!status.ask.ver && !!status.core.ts && Math.abs((status.core.ts || 0) - (status.ask.ts || 0)) < 60000;
      kv('Ask script', status.ask.ver ? ('v' + status.ask.ver + (askFresh ? '' : ' · stale (not loaded this session)')) : 'not loaded');
      if (askFresh) {
        // The line that would have saved a verification cycle on 2026-08-08. Ask shipped for
        // months posting a route with no tools, and a toolless build is indistinguishable from a
        // wired one until you ask it a question about the screen and read the answer.
        var askWired = status.ask.route === 'ai' && status.ask.pageTools > 0;
        kv('Ask page tools', askWired
          ? (status.ask.pageTools + ' wired · /api/ai')
          : ('NOT wired · /api/' + (status.ask.route || '?') + ' · ' + (status.ask.pageTools || 0) + ' tools'),
          askWired ? 'ok' : 'no');
      }
      // AI usage ledger (bwn:ai:usage, written by the AI script per generation).
      // Tokens are the real number; the $ figure is a list-price estimate.
      var led = lsGet('bwn:ai:usage', {}) || {};
      var mNow = new Date();
      var mKey = mNow.getFullYear() + '-' + ('0' + (mNow.getMonth() + 1)).slice(-2);
      if (led[mKey] && led[mKey].calls) {
        var lu = led[mKey];
        // Rate follows the configured model tier; still an estimate (a mid-month
        // model switch mixes rates), hence the ~ prefix - tokens are the real number.
        var mdl = String(((lsGet('bwn:config', {}) || {}).ai || {}).model || 'sonnet').toLowerCase();
        var rIn = mdl.indexOf('haiku') !== -1 ? 0.8 : mdl.indexOf('opus') !== -1 ? 15 : 3;
        var rOut = mdl.indexOf('haiku') !== -1 ? 4 : mdl.indexOf('opus') !== -1 ? 75 : 15;
        var estUsd = (lu.input / 1e6) * rIn + (lu.output / 1e6) * rOut;
        kv('AI usage · ' + mKey,
          lu.calls + ' draft' + (lu.calls === 1 ? '' : 's') + ' · ' + Math.round(lu.input / 1000) + 'k in / ' +
          Math.round(lu.output / 1000) + 'k out · ~$' + estUsd.toFixed(2), '');
      }

      // Shared-core drift: both scripts announce the BWN block version AND export
      // manifest they carry. A version mismatch means one file missed the last
      // core-block paste; an export diff at the SAME version means a paste dropped
      // part of the block. Only a peer that announced in this session counts -
      // an uninstalled script's stale blob must not raise a permanent red row.
      var cvC = lsGet('bwn:corever:core', null), cvA = lsGet('bwn:corever:ai', null);
      if (cvC || cvA) {
        var peerFresh = !!(cvC && cvA && Math.abs((cvC.ts || 0) - (cvA.ts || 0)) < 120000);
        var expDiff = [];
        if (peerFresh && cvC.v === cvA.v && Array.isArray(cvC.exports) && Array.isArray(cvA.exports)) {
          expDiff = cvC.exports.filter(function (k5) { return cvA.exports.indexOf(k5) === -1; })
            .concat(cvA.exports.filter(function (k5) { return cvC.exports.indexOf(k5) === -1; }));
        }
        var drift = peerFresh && (cvC.v !== cvA.v || expDiff.length > 0);
        kv('Shared core',
          (cvC ? 'Core v' + cvC.v : 'Core n/a') + (cvA ? ' · AI v' + cvA.v + (peerFresh ? '' : ' · stale') : ''),
          drift ? 'no' : (peerFresh || !cvA ? 'ok' : ''));
        if (drift) {
          var driftNote = document.createElement('div'); driftNote.className = 'bwn-ops-note';
          driftNote.textContent = cvC.v !== cvA.v
            ? 'Shared-core version mismatch - paste the newer BWN SHARED CORE block into both scripts and re-import.'
            : 'Same core version but the export lists differ (' + expDiff.join(', ') + ') - a paste dropped part of the block. Re-paste it into both files.';
          body.appendChild(driftNote);
        }
      }
      // Per-module health (bwn:health:{core|ai}, reported via BWN.beat): green ok,
      // plain waiting, red miss - a red row names the drifted anchor to fix.
      // sessionStorage: health is per tab, describing THIS tab's modules.
      var health = { Core: BWN.ssGetJSON('bwn:health:core', {}) || {}, AI: BWN.ssGetJSON('bwn:health:ai', {}) || {} };
      SUITE_MODULES.forEach(function (mod) {
        var hb = (health[mod.script] || {})[mod.k];
        if (!hb || !hb.state) return;              // disabled or never reported this session
        kv(mod.label, hb.state + (hb.detail ? ' · ' + hb.detail : ''),
          hb.state === 'ok' ? 'ok' : hb.state === 'miss' ? 'no' : '');
      });

      // Contained errors: safeModule/guard record failures to bwn:err:{core|ai} so a
      // module that died no longer fails silently - surface the recent ones here.
      var errRows = [];
      [['Core', 'bwn:err:core'], ['AI', 'bwn:err:ai']].forEach(function (src) {
        (lsGet(src[1], []) || []).forEach(function (e2) {
          if (e2 && e2.tag) errRows.push({ s: src[0], e: e2 });
        });
      });
      if (errRows.length) {
        errRows.sort(function (a, b) { return (b.e.ts || 0) - (a.e.ts || 0); });
        errRows.slice(0, 5).forEach(function (r) {
          var mins = Math.max(0, Math.round((Date.now() - (r.e.ts || 0)) / 60000));
          var age = mins < 60 ? mins + 'm ago' : mins < 1440 ? Math.round(mins / 60) + 'h ago' : Math.round(mins / 1440) + 'd ago';
          kv(r.s + ' error · ' + r.e.tag, (r.e.msg || '').slice(0, 56) + ' · ' + age, 'no');
        });
        var errNote = document.createElement('div'); errNote.className = 'bwn-ops-note';
        errNote.textContent = 'A module hit an error but the rest of the suite kept running. If a tool is missing, reload; if it keeps happening, check the console.';
        body.appendChild(errNote);
        var clearErr = document.createElement('button');
        clearErr.type = 'button'; clearErr.className = 'bwn-ops-btn ghost'; clearErr.textContent = 'Clear error log';
        clearErr.style.cssText = 'margin-top:7px;';
        clearErr.addEventListener('click', function () {
          try { localStorage.removeItem('bwn:err:core'); localStorage.removeItem('bwn:err:ai'); } catch (e3) { }
          close(); openSuitePanel();
        });
        body.appendChild(clearErr);
      }
      // Leak Guard learned contacts (bwn:eg:contacts): show the count and offer the
      // only supported way to correct a bad binding - forget them all.
      var lcAll = lsGet('bwn:eg:contacts', {}) || {};
      var lcCount = Object.keys(lcAll).length;
      if (lcCount) {
        kv('Leak Guard learned contacts', lcCount + ' address binding' + (lcCount === 1 ? '' : 's'), '');
        var forgetBtn = document.createElement('button');
        forgetBtn.type = 'button'; forgetBtn.className = 'bwn-ops-btn ghost'; forgetBtn.textContent = 'Forget learned contacts';
        forgetBtn.style.cssText = 'margin-top:7px;margin-right:8px;';
        forgetBtn.addEventListener('click', function () {
          try { localStorage.removeItem('bwn:eg:contacts'); } catch (eF) { }
          close(); openSuitePanel();
        });
        body.appendChild(forgetBtn);
      }

      // One-click diagnostics export: versions, manifests, toggles, health, errors,
      // config, and bwn-storage usage. No WO/vendor/client data, no keys, no drafts.
      var reportBtn = document.createElement('button');
      reportBtn.type = 'button'; reportBtn.className = 'bwn-ops-btn ghost'; reportBtn.textContent = 'Copy health report';
      reportBtn.style.cssText = 'margin-top:7px;';
      reportBtn.addEventListener('click', function () {
        var rep = [];
        rep.push('BWN SUITE HEALTH REPORT · ' + new Date().toString());
        rep.push('Core status: ' + JSON.stringify(lsGet('bwn:status:core', {})) + ' | AI status: ' + JSON.stringify(lsGet('bwn:status:ai', {})));
        rep.push('Ask status: ' + JSON.stringify(lsGet('bwn:status:ask', {})));
        rep.push('Shared core: core=' + JSON.stringify(lsGet('bwn:corever:core', null)));
        rep.push('             ai=' + JSON.stringify(lsGet('bwn:corever:ai', null)));
        rep.push('Module toggles: ' + JSON.stringify(lsGet('bwn:modules', {})));
        rep.push('Health core (this tab): ' + JSON.stringify(BWN.ssGetJSON('bwn:health:core', {})));
        rep.push('Health ai (this tab): ' + JSON.stringify(BWN.ssGetJSON('bwn:health:ai', {})));
        rep.push('Errors core: ' + JSON.stringify(lsGet('bwn:err:core', [])));
        rep.push('Errors ai: ' + JSON.stringify(lsGet('bwn:err:ai', [])));
        // Config: whitelist the numeric thresholds only - extension keys (e.g. Views
        // presets) can carry coordinator names and don't belong in a shareable report.
        var cfgAll = lsGet('bwn:config', {}) || {};
        var cfgOut = {};
        Object.keys(BWN.CFG_DEFAULTS).forEach(function (kc) { if (kc in cfgAll) cfgOut[kc] = cfgAll[kc]; });
        var cfgExtras = Object.keys(cfgAll).filter(function (ke) { return !(ke in BWN.CFG_DEFAULTS) && ke !== 'v'; })
          .map(function (ke) {
            var ve = cfgAll[ke];
            return ke + (Array.isArray(ve) ? '[' + ve.length + ']' : (ve && typeof ve === 'object') ? '{…}' : '=' + String(ve).slice(0, 20));
          });
        rep.push('Config: ' + JSON.stringify(cfgOut) + (cfgExtras.length ? ' | extension keys: ' + cfgExtras.join(', ') : ''));
        rep.push('Theme: ' + BWN.getTheme() + ' | Page: ' + location.pathname);
        var usage = { local: 0, session: 0, keys: 0 };
        try {
          for (var iL = 0; iL < localStorage.length; iL++) { var kL = localStorage.key(iL); if (/^bwn[:_-]/.test(kL)) { usage.local += (localStorage.getItem(kL) || '').length; usage.keys++; } }
          for (var iS = 0; iS < sessionStorage.length; iS++) { var kS = sessionStorage.key(iS); if (/^bwn[:_-]/.test(kS)) { usage.session += (sessionStorage.getItem(kS) || '').length; usage.keys++; } }
        } catch (eU) { /* blocked storage: report without usage */ }
        rep.push('Storage (bwn keys): ' + usage.keys + ' keys · ' + usage.local + 'B local · ' + usage.session + 'B session');
        // Audit-ring digest (Task 3): the shared bwn:audit trail already records a corrId +
        // per-write latency (ms) + outcome per op. Fold a SANITIZED summary in - only corrId,
        // op NAME (a fixed registry key, not WO/vendor data), outcome, and latency. NEVER
        // ids/before/after/actor/target (those can carry WO/vendor/client scalars), never keys.
        // Keeps the "No WO/vendor/client data, no keys" promise on the report above.
        try {
          var aud = bwnAuditAll();
          rep.push('Audit ring (bwn:audit): ' + aud.length + ' entr' + (aud.length === 1 ? 'y' : 'ies') + ' (max ' + BWN_AUDIT_MAX + ', schema ' + BWN_AUDIT_SCHEMA + ')');
          if (aud.length) {
            var byOut = {}, lat = [];
            aud.forEach(function (e) {
              var o = String((e && e.outcome) || '?'); byOut[o] = (byOut[o] || 0) + 1;
              if (e && typeof e.ms === 'number') lat.push(e.ms);
            });
            rep.push('  outcomes: ' + (Object.keys(byOut).sort().map(function (k) { return k + ':' + byOut[k]; }).join(' ') || 'none'));
            if (lat.length) {
              lat.sort(function (a, b) { return a - b; });
              rep.push('  latency ms: p50 ' + lat[Math.floor((lat.length - 1) * 0.5)] + ' · max ' + lat[lat.length - 1] + ' (n=' + lat.length + ')');
            }
            rep.push('  recent (corrId · op · outcome · ms · age):');
            aud.slice(-8).reverse().forEach(function (e) {
              var age = (e && e.ts) ? Math.round((Date.now() - e.ts) / 1000) + 's' : '?';
              rep.push('    ' + ((e && e.corrId) || '?') + ' · ' + ((e && e.op) || '?') + ' · ' + ((e && e.outcome) || '?') + ' · ' + ((e && typeof e.ms === 'number') ? e.ms + 'ms' : '?') + ' · ' + age);
            });
          }
        } catch (eA) { rep.push('Audit ring: unavailable'); }
        BWN.copyText(rep.join('\n'), reportBtn, 'Copy health report');
      });
      body.appendChild(reportBtn);

      var keyNote = document.createElement('div'); keyNote.className = 'bwn-ops-note';
      keyNote.textContent = 'Set API keys from the Tampermonkey menu (AI script): "Set Anthropic API key" / "Set Google Places key".';
      body.appendChild(keyNote);

      // Footer + lifecycle
      function close() {
        document.removeEventListener('keydown', onKeyP, true);
        document.removeEventListener('bwn:evt', onSlotTaken);
        // Fade out instead of vanishing. Listeners come off FIRST, so the 170ms the node is
        // still in the DOM cannot answer a key or a bus event. Focus returns immediately -
        // waiting for the fade would leave the keyboard on a dying node.
        drawerDismiss(ov, card);
        try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus(); } catch (e) { }
      }
      // Announcing on open is only half of the shared slot - without this we sat there
      // while another tool opened alongside us (seen live: Suite settings + Ask BWN both up).
      function onSlotTaken(e) {
        var d = e && e.detail;
        if (d && d.id === 'bwn:drawer:open' && d.key !== 'settings') close();
      }
      document.addEventListener('bwn:evt', onSlotTaken);
      function onKeyP(e) {
        if (e.key === 'Escape') { close(); return; }
        if (e.key !== 'Tab') return;
        var f = Array.prototype.filter.call(card.querySelectorAll('button,input,[tabindex]:not([tabindex="-1"])'),
          function (el) { return el.offsetWidth || el.offsetHeight || el.getClientRects().length; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1], act = document.activeElement;
        if (!card.contains(act)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
      }
      var ft = document.createElement('div'); ft.className = 'bwn-ops-ft';
      var saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'bwn-ops-btn primary'; saveBtn.textContent = 'Save settings';
      saveBtn.addEventListener('click', function () {
        var partial = {}, ok = true;
        OPS_CFG_FIELDS.forEach(function (f) {
          var n = parseFloat(inputs[f[0]].value);
          if (isNaN(n) || n < 0) { inputs[f[0]].style.borderColor = 'var(--bwn-bad)'; ok = false; }
          else { inputs[f[0]].style.borderColor = ''; partial[f[0]] = n; }
        });
        // AI knobs ride along in bwn:config.ai. Start from the STORED object so
        // non-panel keys (e.g. a hand-set includeVendor) survive; panel-owned keys
        // are then set-or-cleared explicitly. Invalid window values block the save
        // with a red border - never silently dropped while destroying the old value.
        var aiP = {};
        Object.keys(aiCur).forEach(function (k9) { aiP[k9] = aiCur[k9]; });
        delete aiP.model; delete aiP.windowDays; delete aiP.preflight;
        if (aiModel.value.trim()) aiP.model = aiModel.value.trim();
        var wvRaw = aiWin.value.trim();
        if (wvRaw !== '') {
          var wv = parseFloat(wvRaw);
          if (!isNaN(wv) && wv >= 1 && wv <= 60) { aiWin.style.borderColor = ''; aiP.windowDays = Math.round(wv); }
          else { aiWin.style.borderColor = 'var(--bwn-bad)'; ok = false; }
        } else { aiWin.style.borderColor = ''; }
        if (selPf.value !== 'auto') aiP.preflight = selPf.value;
        if (!ok) return;
        // Only write ai when it actually changed - an untouched panel save must not
        // fire scan-invalidating churn for the AI section.
        if (JSON.stringify(aiP) !== JSON.stringify(aiCur)) partial.ai = aiP;
        opsConfigSave(partial);
        saveBtn.textContent = 'Saved ✓';
        setTimeout(function () { saveBtn.textContent = 'Save settings'; }, 1200);
      });
      var closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'bwn-ops-btn ghost'; closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', close);
      ft.appendChild(saveBtn); ft.appendChild(closeBtn); card.appendChild(ft);

      ov.appendChild(card);
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      document.addEventListener('keydown', onKeyP, true);
      document.body.appendChild(ov);
      setTimeout(function () { try { card.focus(); } catch (e) { } }, 0);
    }

    // ---- Styles ----------------------------------------------------------------
    function ensureStyle() {
      if (document.getElementById('bwn-launch-style')) return;
      var st = document.createElement('style');
      st.id = 'bwn-launch-style';
      st.textContent =
        '#' + DOCK_ID + '{position:fixed;left:0;bottom:18px;z-index:99998;' +
        'background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;' +
        'padding:8px 10px 8px 8px;border-radius:0 10px 10px 0;cursor:pointer;' +
        'font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:.5px;box-shadow:2px 2px 10px rgba(0,0,0,.25);' +
        'user-select:none;display:flex;align-items:center;gap:6px;}' +
        '#' + DOCK_ID + ':hover{filter:brightness(1.12);}' +
        '#' + DOCK_ID + ' .dot{width:8px;height:8px;border-radius:50%;background:var(--bwn-accent);}' +
        // Shared launcher dock: one dark rail card flush to the left edge (wireframe-deck
        // style) - logo header, registrant rows, a TOOLS section, collapse chevron.
        // Vertically centred so the collapsed pull tab sits level with Umbrava's own
        // right-edge Tasks tabs; the rail then opens from where the tab was, no jump.
        '#' + DOCK_STACK_ID + '{position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:99998;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '#' + DOCK_STACK_ID + '.bwn-dock-rail{width:' + DOCK_RAIL_W + 'px;background:var(--bwn-green-dk);border-radius:0 14px 14px 0;' +
        'box-shadow:2px 4px 22px rgba(0,0,0,.28);overflow:hidden;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-hd{padding:13px 13px 11px;border-bottom:1px solid rgba(255,255,255,.14);}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-hd img{display:block;width:100%;height:auto;user-select:none;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-hd-txt{font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#fff;letter-spacing:.4px;}' +
        // The rail now carries the tool rows too, so it grows with its contents and scrolls
        // inside itself on a short window rather than running off the top and bottom.
        '#' + DOCK_STACK_ID + '.bwn-dock-rail{max-height:calc(100vh - 24px);display:flex;flex-direction:column;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-hd,#' + DOCK_STACK_ID + ' .bwn-dock-collapse{flex:none;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-body{padding:5px 0;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-sec{padding:9px 14px 4px;font:600 9px ui-monospace,"Segoe UI Mono","SF Mono",monospace;' +
        'letter-spacing:.9px;color:rgba(255,255,255,.45);border-top:1px solid rgba(255,255,255,.14);margin-top:4px;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;' +
        'padding:10px 14px;border:none;background:transparent;color:rgba(255,255,255,.85);cursor:pointer;text-align:left;' +
        'font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;white-space:nowrap;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-row:hover{background:rgba(255,255,255,.1);color:#fff;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-row:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:-2px;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-row svg{flex:none;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-emoji{font-size:14px;line-height:1;flex:none;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-badge{background:var(--bwn-accent);color:#08301d;border-radius:9px;padding:1px 6px;' +
        'font:700 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;min-width:14px;text-align:center;' +
        'flex:none;box-sizing:border-box;max-width:34px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-collapse{display:flex;align-items:center;justify-content:center;width:100%;box-sizing:border-box;' +
        'padding:6px;border:none;background:transparent;color:rgba(255,255,255,.5);cursor:pointer;border-top:1px solid rgba(255,255,255,.14);}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-collapse:hover{color:#fff;background:rgba(255,255,255,.08);}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-collapse:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:-2px;}' +
        // Collapsed: an edge-flush pull tab (same handle shape Umbrava uses for its Tasks
        // pull-out) carrying the company logo mark. The mark is cropped out of the shared
        // wordmark PNG so there is one logo asset, not a second cut kept in sync by hand.
        '#' + DOCK_STACK_ID + ' .bwn-dock-tab{display:flex;align-items:center;justify-content:center;' +
        'width:' + DOCK_TAB_W + 'px;height:72px;border:none;padding:0;background:var(--bwn-green-dk);cursor:pointer;' +
        'border-radius:0 12px 12px 0;box-shadow:2px 3px 14px rgba(0,0,0,.28);overflow:hidden;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-tab:hover{filter:brightness(1.14);}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-tab:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}' +
        // 24px window over a 24px-tall wordmark: the mark runs x 0-229 of the 2000x240 PNG,
        // i.e. 22.9px at this scale, so the window ends in the gap before "broadway".
        '#' + DOCK_STACK_ID + ' .bwn-dock-mark{position:relative;display:block;width:24px;height:24px;overflow:hidden;flex:none;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-mark img{position:absolute;left:0;top:0;height:24px;width:auto;max-width:none;' +
        'user-select:none;display:block;}' +
        '#' + DOCK_STACK_ID + ' .bwn-dock-tab-txt{font:700 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;' +
        'color:#fff;letter-spacing:1px;transform:rotate(-90deg);white-space:nowrap;}' +
        // ---- Shared drawer shell (the suite's one panel surface) -----------------
        // Every suite tool opens HERE: a panel that slides out from the rail, the way
        // Umbrava's Tasks tab slides out from its own edge. Modules build their own DOM
        // (most of them are sandboxed and cannot call into this scope) but style it with
        // these classes, so one stylesheet governs the look. Body content keeps using the
        // existing .bwn-ops-* rows/sections/buttons below.
        //
        // Contract for a module drawer:
        //   <aside class="bwn-drawer" id="bwn-drawer-<key>" role="dialog" aria-label="...">
        //     <div class="bwn-drawer-hd"><div><div class="t">Title</div><div class="s">sub</div></div>
        //       <button class="bwn-drawer-x" aria-label="Close">x</button></div>
        //     <div class="bwn-drawer-body">...</div>
        //     <div class="bwn-drawer-ft">...</div>
        //   </aside>
        // Announce with bwn:drawer:open {key} before mounting; every other module drops
        // its own drawer when it sees a key that is not its own (see the bus below).
        //
        // Dropping it means FADING it, not removing it. A bare .remove() is what made a tool
        // swap read as two objects - one panel popped out of existence while the next faded in.
        // Modules are in their own sandboxes and cannot call Core's helper, so each carries:
        //
        //   function drawerDismiss(el) {
        //     var reduce = false;
        //     try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
        //     if (reduce) { el.remove(); return; }
        //     el.removeAttribute('id'); el.setAttribute('aria-hidden', 'true');
        //     el.classList.add('bwn-closing');
        //     setTimeout(function () { el.remove(); }, 170);
        //   }
        //
        // Detach key and bus listeners BEFORE calling it - the node lives 170ms longer than the
        // tool does and must not answer anything during the fade.
        // Motion, three deliberate choices (animation review 2026-08-10):
        //  - `left` is PINNED to the expanded rail width and the rail's real position arrives as
        //    a transform. Collapsing the rail used to retarget `left` and `max-width` from
        //    --bwn-dock-w, which teleported an open drawer 126px sideways and reflowed it.
        //    Transform and opacity only; nothing here touches layout.
        //  - Entry and exit are TRANSITIONS, not keyframes. Opening one tool closes another
        //    (see the bwn:drawer:open contract above), so the two panels cross in the same slot
        //    and a transition retargets from wherever it is - a keyframe restarts from zero.
        //  - The entry is an honest fade. The old keyframe slid 14px on a 420px panel, which
        //    read as a fade with a twitch rather than the slide its comment claimed; the
        //    transform axis now belongs to the rail shift alone.
        '.bwn-drawer{position:fixed;top:0;bottom:0;left:' + DOCK_RAIL_W + 'px;z-index:99997;' +
        'width:420px;max-width:calc(100vw - ' + (DOCK_RAIL_W + 8) + 'px);display:flex;flex-direction:column;' +
        'background:var(--bwn-surface);border-radius:0 14px 14px 0;box-shadow:10px 0 34px rgba(0,0,0,.2);' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;' +
        'opacity:1;transform:translateX(var(--bwn-dock-shift,0px));' +
        'transition:opacity .16s cubic-bezier(.23,1,.32,1),transform .2s cubic-bezier(.23,1,.32,1);}' +
        '@starting-style{.bwn-drawer{opacity:.4;}}' +
        // Exit contract for modules: strip the id, add .bwn-closing, remove after DRAWER_EXIT_MS
        // (170). Sits UNDER the incoming panel and stops taking clicks the moment it starts to go.
        '.bwn-drawer.bwn-closing{opacity:0;z-index:99996;pointer-events:none;}' +
        // Kept, but NOT for the reason first written here. The claim was that bwn-suite-ai's Job
        // View card depends on this definition across the sandbox boundary; it does not -
        // bwn-suite-ai declares its own identical @keyframes bwn-drawer-in three lines under the
        // rule that uses it, deliberately, "so the slide-in survives when Core is off" (its
        // comment). Nothing in this file references this keyframe any more, so it is inert CSS.
        // It stays because the two copies are a documented no-host fallback pair and removing
        // either half buys nothing; do not cite it as a dependency.
        '@keyframes bwn-drawer-in{from{transform:translateX(-14px);opacity:.4;}to{transform:none;opacity:1;}}' +
        // Gentler, not zero: the panel still appears and disappears, it just does not move or
        // fade. Covers the settings card too - it rides the same motion and was NOT covered
        // before, so a reduced-motion user got an animation they had asked not to have.
        '@media (prefers-reduced-motion:reduce){.bwn-drawer,.bwn-drawer.bwn-closing,.bwn-ops-overlay,.bwn-ops-card{animation:none;transition:none;}' +
        '.bwn-drawer{opacity:1;}}' +
        '.bwn-drawer-hd{display:flex;align-items:flex-start;gap:10px;padding:15px 16px 14px 18px;' +
        'background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;border-radius:0 14px 0 0;}' +
        '.bwn-drawer-hd .t{font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-drawer-hd .s{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.72);margin-top:3px;}' +
        '.bwn-drawer-hd>div:first-child{flex:1;min-width:0;}' +
        '.bwn-drawer-x{flex:none;width:26px;height:26px;border:none;border-radius:7px;cursor:pointer;' +
        'background:rgba(255,255,255,.14);color:#fff;font:400 17px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;}' +
        '.bwn-drawer-x:hover{background:rgba(255,255,255,.26);}' +
        '.bwn-drawer-x:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}' +
        '.bwn-drawer-body{flex:1;overflow:auto;padding:14px 18px;}' +
        '.bwn-drawer-ft{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:12px 18px;' +
        'border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);border-radius:0 0 14px 0;}' +
        // Suite settings rides the same drawer geometry as the rest of the tools.
        // Same geometry and the same motion split as .bwn-drawer: the overlay owns the rail
        // shift (transform), the card owns the fade (opacity). Two elements here, so the two
        // never contend for one transform.
        '.bwn-ops-overlay{position:fixed;top:0;bottom:0;left:' + DOCK_RAIL_W + 'px;z-index:100001;display:flex;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;' +
        'transform:translateX(var(--bwn-dock-shift,0px));transition:transform .2s cubic-bezier(.23,1,.32,1);}' +
        '.bwn-ops-overlay.bwn-closing{pointer-events:none;}' +
        '.bwn-ops-card{width:540px;max-width:calc(100vw - ' + (DOCK_RAIL_W + 8) + 'px);height:100%;display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:0 14px 14px 0;overflow:hidden;box-shadow:10px 0 34px rgba(0,0,0,.2);' +
        'opacity:1;transition:opacity .16s cubic-bezier(.23,1,.32,1);}' +
        '@starting-style{.bwn-ops-card{opacity:.4;}}' +
        '.bwn-ops-card.bwn-closing{opacity:0;}' +
        '.bwn-ops-hd{background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:16px 20px;border-radius:0 14px 0 0;}' +
        '.bwn-ops-hd .t{font:600 16px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-ops-hd .s{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.7);margin-top:3px;}' +
        '.bwn-ops-body{padding:14px 18px;overflow:auto;flex:1;}' +
        '.bwn-ops-sec{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);text-transform:none;letter-spacing:normal;margin:16px 2px 7px;}' +
        '.bwn-ops-sec:first-child{margin-top:2px;}' +
        '.bwn-ops-sec .d{display:block;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);text-transform:none;letter-spacing:0;margin-top:2px;}' +
        '.bwn-ops-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--bwn-border-2);border-radius:9px;margin:5px 0;background:var(--bwn-surface-2);}' +
        '.bwn-ops-row .lbl{flex:1;font-size:13px;color:var(--bwn-text);min-width:0;}' +
        '.bwn-ops-row .scr{font:500 9px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);border:1px solid var(--bwn-border);border-radius:5px;padding:1px 5px;}' +
        '.bwn-ops-row input[type=checkbox]{width:16px;height:16px;accent-color:var(--bwn-green);cursor:pointer;flex:none;}' +
        '.bwn-ops-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;}' +
        '.bwn-ops-grid label{display:block;font:500 9px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);margin-bottom:3px;}' +
        '.bwn-ops-grid input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--bwn-border);border-radius:7px;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-align:right;outline:none;background:var(--bwn-surface);color:var(--bwn-text);}' +
        '.bwn-ops-grid input:focus{border-color:var(--bwn-accent);box-shadow:0 0 0 3px rgba(46,204,113,.15);}' +
        '.bwn-ops-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:5px 2px;border-bottom:1px solid var(--bwn-surface-3);color:var(--bwn-text-muted);}' +
        '.bwn-ops-kv .v{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;}' +
        '.bwn-ops-kv .v.ok{color:var(--bwn-green);}' +
        '.bwn-ops-kv .v.no{color:var(--bwn-bad);}' +
        '.bwn-ops-note{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-warn-fg);background:var(--bwn-warn-bg);border-radius:8px;padding:8px 11px;margin:8px 0 0;}' +
        '.bwn-ops-ft{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:12px 18px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-ops-btn{padding:8px 15px;border:none;border-radius:8px;cursor:pointer;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-ops-btn.primary{color:#fff;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));}' +
        '.bwn-ops-btn.ghost{color:var(--bwn-green);background:var(--bwn-tint);}' +
        '.bwn-ops-btn:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}';
      document.head.appendChild(st);
    }

    // ---- Tools list (rendered in the shared drawer) -------------------------------

    // The Ops Tools list. These used to sit behind a "Tools" row that opened a drawer
    // containing nothing but links - a whole surface just to show a menu. They are rows on
    // the rail itself now, so the rail is the nav and a drawer only ever holds a real tool UI.
    // Returns [{key,label,title,icon,run(labelEl)}]; renderDock draws them.
    function toolItems() {
      var ctx = woContext();
      var items = [];

      LAUNCHER_APPS.forEach(function (app) {
        var url = buildUrl(app);
        if (!url) return;
        items.push({
          key: 'app:' + app.label, label: app.short || app.label, icon: 'board',
          title: (app.context && ctx) ? (app.label + ' - opens with this WO\u2019s context') : app.label,
          run: function () { window.open(url, '_blank', 'noopener'); }
        });
      });

      if (ctx) {
        // Copy Context: for tools (or chats) without URL-param support.
        items.push({
          key: 'copyctx', label: 'Copy context', icon: 'copy',
          title: 'tracking \u00b7 WO \u00b7 client/location \u00b7 status \u00b7 DNE \u00b7 GP%',
          run: function (labelEl) {
            var lines = [
              'Tracking #' + (ctx.tracking || '?'),
              'WO ' + (ctx.wo || '?'),
              ctx.location, 'Status: ' + (ctx.status || '?'),
              ctx.dne ? 'DNE: $' + ctx.dne : '',
              ctx.gpPct ? 'GP: ' + ctx.gpPct + '%' : '',
              location.href
            ].filter(Boolean).join('\n');
            navigator.clipboard.writeText(lines).then(function () {
              flashLabel(labelEl, 'Copied \u2713');
            }, function () { prompt('Copy manually:', lines); });
          }
        });
        items.push({
          key: 'copylink', label: 'Copy link', icon: 'link',
          title: 'clickable rich link for Teams / Outlook',
          run: function (labelEl) { copyWOLink(ctx, labelEl); }
        });
      }

      // End-of-day digest - cross-module via bwn:cmd (Visit Memory owns the log).
      if (BWN_MODULES.visitLog) {
        items.push({
          key: 'eod', label: 'EOD digest', icon: 'digest',
          title: 'today\u2019s touched WOs, grouped & paste-ready',
          run: function () { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'core:eoddigest' } })); }
        });
      }
      if (BWN_MODULES.reminders) {
        items.push({
          key: 'remind', label: 'Reminders', icon: 'bell',
          title: 'nudge me about this WO \u00b7 view pending',
          run: function () { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'core:remind' } })); }
        });
      }
      if (BWN_MODULES.notesTimeline && ctx) {
        items.push({
          key: 'timeline', label: 'Notes timeline', icon: 'timeline',
          title: 'chronological read \u00b7 day + quiet-gap markers',
          run: function () { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'core:notestimeline' } })); }
        });
      }
      items.push({
        key: 'settings', label: 'Suite settings', icon: 'settings',
        title: 'modules \u00b7 thresholds \u00b7 status',
        run: function () { openSuitePanel(); }
      });
      return items;
    }
    // Row-label acknowledgement, restored on a timer. The rail re-renders on its own
    // signature, so the restore is guarded on the node still being mounted.
    function flashLabel(el, text) {
      if (!el) return;
      var old = el.textContent;
      el.textContent = text;
      setTimeout(function () { if (el.isConnected) el.textContent = old; }, 1200);
    }

    // NOTE: Core no longer builds drawers itself - its one panel (Suite settings) owns its
    // own markup, and the Ops Tools list became rows on the rail. The .bwn-drawer styles in
    // ensureStyle() stay: the sandboxed modules build that markup and rely on them, and the
    // bwn:drawer:open contract documented above the CSS is what keeps one panel up at a time.
    // ---- Dock ---------------------------------------------------------------------
    function ensureDock() {
      if (document.getElementById(DOCK_ID)) { BWN.beat('launcher', 'ok', 'dock mounted'); return; }
      ensureStyle();
      var dock = document.createElement('div');
      dock.id = DOCK_ID;
      dock.setAttribute('role', 'button');
      dock.setAttribute('tabindex', '0');
      dock.title = 'BWN Suite settings \u2014 no tools have registered on this page';
      var dot = document.createElement('span'); dot.className = 'dot';
      var label = document.createElement('span'); label.textContent = 'BWN';
      dock.appendChild(dot); dock.appendChild(label);
      // No-registrant fallback: the rail is the tools UI now, so this pill opens Suite
      // settings (the one tool that is always available) rather than a menu that no
      // longer exists.
      dock.addEventListener('click', openSuitePanel);
      dock.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSuitePanel(); } });
      document.body.appendChild(dock);
      BWN.beat('launcher', 'ok', 'dock mounted');
    }

    // ---- Shared launcher dock (bwn:dock:* host) --------------------------------
    // Geometry constants live INSIDE this marker on purpose: scripts/test-dock-latent-fixes.js
    // slices from here to the command-palette bridge and runs the shipped bytes in a vm, so a
    // constant declared above the marker is `not defined` in the harness. `var` hoists to the
    // module either way, so ensureStyle above still sees these.
    //   DOCK_RAIL_W  - the expanded rail width, in ONE place. The drawer pins `left` to it and
    //                  rides a transform to wherever the rail actually is; the stylesheet and
    //                  publishDockWidth must agree or a collapsed rail leaves the drawer 126px off.
    var DOCK_RAIL_W = 158;
    var DOCK_TAB_W = 32;        // collapsed pull tab, .bwn-dock-tab
    var DRAWER_EXIT_MS = 170;   // .bwn-closing fade (160ms) + 10ms slack before removal
    // Generalizes the CC pair's two-party bwn:cc:* coordination into an N-party dock:
    // any suite module registers ONE launcher over the document-level bwn:evt bus and
    // this host renders them as ONE dark rail card on the left edge (logo header,
    // line-icon rows, Tools footer row, collapse-to-chip), killing the old
    // hand-picked-corner launchers. Modules never touch the dock DOM - only
    // serializable events cross the bus (sandbox-safe, @grant none). The dock owns the
    // button; a click just emits bwn:dock:open back to the owner, which opens its own UI.
    //
    // Bus (bwn:evt detail.id namespaced bwn:dock:*). NOTE: detail.id is the EVENT name,
    // so an entry's stable key rides as detail.key (not detail.id):
    //   bwn:dock:host      host->all  {hostId,priority,ts}          "I am the host" (announce + heartbeat)
    //   bwn:dock:ping      host->all  {hostId}                      "all modules (re)register now"
    //   bwn:dock:register  mod->host  {key,label,icon,weight,badge?,minRank?,title?}  add/replace (idempotent by key)
    //   bwn:dock:update    mod->host  {key,label?,icon?,badge?,minRank?}              live-patch an entry
    //   bwn:dock:unregister mod->host {key}                         remove an entry
    //   bwn:dock:open      host->mod  {key}                         user clicked; module opens its drawer
    //   bwn:drawer:open    any->all   {key}                         "my drawer is opening" - everyone else closes theirs
    var HOST_PRIORITY = 100;                      // Core is the always-present, high-priority host
    var DOCK_PING_MS = 20000;                     // heartbeat: re-announce + pull registrations
    var DOCK_TTL_MS = DOCK_PING_MS * 3 + 5000;    // an entry drops if not re-registered within ~3 pings
    var DOCK_COLLAPSED_KEY = 'bwn:dock:collapsed'; // user pref: rail folded to the brand chip
    var dockBornTs = Date.now();
    var dockHostId = 'h' + Math.random().toString(36).slice(2) + dockBornTs.toString(36);
    var dockAmHost = true;
    var dockOtherSeen = 0;                         // last bwn:dock:host/ping heard from a FOREIGN host
    // Null prototype on purpose. `dockRoster[d.key] = {...}` with the key '__proto__' otherwise
    // hits the inherited setter instead of creating an own property: Object.keys never sees it, so
    // no row and no diagnostic - and worse, the entry is then INHERITED, after which any of its
    // truthy-valued keys ('seen' is always a timestamp; also 'weight', 'minRank', 'key') satisfies
    // the `dockRoster[d.key]` gates on update and unregister. With no
    // prototype there is nothing to pollute and nothing to inherit, and a '__proto__' key renders
    // as an ordinary row like 'constructor' already does.
    var dockRoster = Object.create(null);          // key -> {key,label,icon,weight,badge,minRank,title,order,seen}
    var dockOrderSeq = 0;
    var dockRank = null;                           // reader's rank (UX gating only; server is the real boundary)
    var dockRenderT = null;

    function dockEmit(id, extra) {
      try {
        var detail = { id: id };
        if (extra) Object.keys(extra).forEach(function (k) { detail[k] = extra[k]; });
        document.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail }));
      } catch (e) { }
    }
    function dockAnnounce() { if (dockAmHost) dockEmit('bwn:dock:host', { hostId: dockHostId, priority: HOST_PRIORITY, ts: dockBornTs }); }
    function dockPing() { if (dockAmHost) dockEmit('bwn:dock:ping', { hostId: dockHostId }); }
    // Total order so exactly one host survives: higher priority wins, then earlier ts, then hostId string.
    function dockOtherWins(o) {
      if (!o || o.hostId === dockHostId) return false;
      var op = typeof o.priority === 'number' ? o.priority : 0;
      if (op !== HOST_PRIORITY) return op > HOST_PRIORITY;
      var ot = typeof o.ts === 'number' ? o.ts : Infinity;
      if (ot !== dockBornTs) return ot < dockBornTs;
      return String(o.hostId) < String(dockHostId);
    }
    function scheduleDockRender() { clearTimeout(dockRenderT); dockRenderT = setTimeout(BWN.guard(renderDock, 'launcher:dockrender'), 120); }
    // Restore the standalone Tools pill on the way out - renderDock hides it while the rail
    // renders, so tearing the rail down without this strands the launcher entirely.
    function removeDockStack() {
      var s = document.getElementById(DOCK_STACK_ID); if (s) s.remove();
      var p = document.getElementById(DOCK_ID); if (p) p.style.display = '';
      dockSig = '';   // next render must rebuild, not match a signature whose DOM is gone
    }
    function dockVisible() {
      var arr = Object.keys(dockRoster).map(function (k) { return dockRoster[k]; });
      // Fail-OPEN when rank is unknown (show the entry; the server rejects if truly unauthorized).
      arr = arr.filter(function (en) { return en.minRank == null || dockRank == null || dockRank >= en.minRank; });
      arr.sort(function (a, b) { return (a.weight - b.weight) || (a.order - b.order); });
      return arr;
    }
    function pruneDock() {
      var now = Date.now();
      Object.keys(dockRoster).forEach(function (k) { if (now - dockRoster[k].seen > DOCK_TTL_MS) delete dockRoster[k]; });
    }
    // Line icons (stroke=currentColor) for the rail rows. Registrant keys map to a
    // built-in glyph so the rail stays consistent; unknown keys fall back to whatever
    // emoji the registrant sent over the bus.
    var DOCK_ICONS = {
      cc: ['M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2-3 2', 'M9 7h6', 'M9 11h6'],
      'wo-audit': ['M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2',
        'M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z', 'M9 14l2 2 4-4'],
      ask: ['M8 9h8', 'M8 13h6', 'M9 18H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-3l-3 3-3-3'],
      // Escalate + Email RFP were the two registrants with no entry here, so the rail fell back
      // to their emoji (a RED flag and a blue envelope) beside eleven monochrome line icons -
      // the only two rows that did not match, reported 2026-08-03. The fallback is deliberate for
      // an UNKNOWN tool; these two are not unknown.
      assist: ['M6 3v18', 'M6 4h13l-3 4 3 4H6z'],
      bidout: ['M4 6h16v12H4z', 'M4 7l8 6 8-6'],
      dispatch: ['M7 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0z', 'M15 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0z',
        'M5 17H3V6a1 1 0 0 1 1-1h9v12m-2 0h4m4 0h2v-6h-8m0-5h5l3 5'],
      // A 3D box (📦): the front silhouette, the top edges meeting at centre, and the seam down.
      // Added WITH the bwn-inventory rail registrant, per this map's own rule (see test-dock-latent-fixes).
      inventory: ['M3 8l9-4 9 4v8l-9 4-9-4z', 'M3 8l9 4 9-4', 'M12 12v8'],
      tools: ['M4 6h16', 'M4 12h16', 'M4 18h16', 'M14 4v4', 'M8 10v4', 'M16 16v4'],
      // Operate: a page frame with a run mark in it. Added with the registrant rather than after
      // it - test-dock-latent-fixes caught the missing entry the moment the entry existed, which
      // is the whole point of that check: a new tool on the rail with no icon falls back to an
      // emoji and is the one row that does not match the other twelve.
      operate: ['M4 5h16v14H4z', 'M4 9h16', 'M10 12l4 2.5-4 2.5z'],
      // Ops Tools rows (they render on the rail now, so they each need a mark)
      board: ['M4 5h16v14H4z', 'M4 10h16', 'M10 10v9'],
      copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
      link: ['M10 13a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 1 0-5.66-5.66L11.5 5.5',
        'M14 11a4 4 0 0 0-5.66 0L5.5 13.84a4 4 0 1 0 5.66 5.66L12.5 18.5'],
      settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
        'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 2.6 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 7 4.6h.09A1.7 1.7 0 0 0 8 3V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z'],
      digest: ['M5 4h11l3 3v13H5z', 'M9 10h7', 'M9 14h7', 'M9 18h4'],
      bell: ['M18 15v-4a6 6 0 1 0-12 0v4l-2 3h16z', 'M10 21h4'],
      timeline: ['M6 4v16', 'M6 8h13', 'M6 14h9', 'M6 19h11'],
      chevronLeft: ['M15 6l-6 6 6 6']
    };
    function dockIcon(name) {
      // Own-property only: a registrant key like 'constructor' would otherwise pull a truthy
      // non-array off Object.prototype and throw mid-render.
      var paths = Object.prototype.hasOwnProperty.call(DOCK_ICONS, name) ? DOCK_ICONS[name] : null;
      if (!paths) return null;
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
      svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      paths.forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
      return svg;
    }
    function dockRowEl(en, iconName, onClick) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'bwn-dock-row';
      if (en.title) b.title = en.title;
      var ic = iconName ? dockIcon(iconName) : null;
      if (ic) b.appendChild(ic);
      else if (en.icon) { var sp = document.createElement('span'); sp.className = 'bwn-dock-emoji'; sp.textContent = en.icon; b.appendChild(sp); }
      var lb = document.createElement('span'); lb.className = 'bwn-dock-lbl'; lb.textContent = en.label; b.appendChild(lb);
      if (en.badge) { var bd = document.createElement('span'); bd.className = 'bwn-dock-badge'; bd.textContent = en.badge; b.appendChild(bd); }
      // The label node is handed to the handler so a row can acknowledge in place
      // ("Copied ✓") now that there is no menu to close as the confirmation.
      b.addEventListener('click', BWN.guard(function () { onClick(lb); }, 'launcher:dockclick'));
      return b;
    }
    function dockLogoUrl() { return 'https://raw.githubusercontent.com/Intermu/userscripts/main/assets/bwn-logo.png'; } // logo now lives with the scripts (source repo), not the SWA host
    function dockIsCollapsed() { try { return localStorage.getItem(DOCK_COLLAPSED_KEY) === '1'; } catch (e) { return false; } }
    function dockSetCollapsed(v) {
      try { if (v) localStorage.setItem(DOCK_COLLAPSED_KEY, '1'); else localStorage.removeItem(DOCK_COLLAPSED_KEY); } catch (e) { }
    }
    // What the rail would draw, as a string. renderDock rebuilds only when this changes:
    // its unconditional rebuild otherwise feeds the MutationObserver below, which reschedules
    // renderDock, and the rail rebuilds itself forever on a completely idle page.
    var dockSig = '';
    // The tool rows live on the rail now, and which of them exist changes with the page
    // (Copy WO context / link and Notes timeline are WO-only). Their keys have to be in the
    // signature, or navigating list -> WO would leave the rail stale until some registrant
    // happened to change. See the tail of this function.
    function dockSignature(vis, collapsed) {
      return (collapsed ? 'c|' : 'e|') + dockToolSig(collapsed) + vis.map(function (en) {
        return [en.key, en.label, en.icon, en.badge == null ? '' : en.badge,
        en.title == null ? '' : en.title].join('\u0001');
      }).join('\u0002');
    }
    function dockToolSig(collapsed) {
      if (collapsed) return '';   // collapsed draws only the tab; tool rows are irrelevant
      try {
        return toolItems().map(function (it) { return it.key + '=' + it.label; }).join(',') + '|';
      } catch (e) { return '|'; }
    }
    // Collapse/expand rebuilds the rail, which destroys the very button that was
    // activated - keyboard focus would land on <body> and a keyboard user would lose
    // their place. Hand it to the control that replaced it. Ring only shows for
    // keyboard users (the dock styles :focus-visible), so a mouse click stays quiet.
    function dockToggle(collapsed, sel) {
      dockSetCollapsed(collapsed);
      renderDock();
      var stack = document.getElementById(DOCK_STACK_ID);
      var next = stack ? stack.querySelector(sel) : null;
      if (next) { try { next.focus(); } catch (e) { } }
    }
    // Drawers open flush against whatever the dock is currently showing, so the rail's
    // own width is published as a CSS variable rather than hard-coded in every module.
    // Shared drawer exit. Modules cannot call this (separate Tampermonkey sandboxes - only the
    // bus crosses), so each one carries the same five lines; the CSS that does the actual work
    // lives in ensureStyle above and IS shared. Keep the two in step.
    //   node  - the element to remove (the overlay, if there is one)
    //   fader - the element that carries .bwn-closing's opacity (the card); defaults to node
    function drawerDismiss(node, fader) {
      if (!node) return;
      var reduce = false;
      try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
      if (reduce) { node.remove(); return; }   // no transition to wait for, so do not leave it up for 170ms
      try {
        node.removeAttribute('id');            // frees the id immediately - reopening the same tool must not duplicate it
        node.setAttribute('aria-hidden', 'true');
        node.classList.add('bwn-closing');
        if (fader && fader !== node) fader.classList.add('bwn-closing');
      } catch (e) { node.remove(); return; }
      setTimeout(function () { try { node.remove(); } catch (e) { } }, DRAWER_EXIT_MS);
    }
    function publishDockWidth(px) {
      try {
        var d = document.documentElement.style;
        d.setProperty('--bwn-dock-w', px + 'px');
        // --bwn-dock-shift is the SAME fact expressed as a delta from the expanded rail, so a
        // drawer can follow the rail on the compositor instead of having its `left` retargeted.
        // --bwn-dock-w stays published unchanged: bwn-bid-out and bwn-suite-ai pin their own
        // overlays to it and would break if it vanished.
        d.setProperty('--bwn-dock-shift', (px - DOCK_RAIL_W) + 'px');
      } catch (e) { }
    }
    function renderDock() {
      // Above EVERY early return, not just the signature check. The stylesheet is what makes the
      // fallback pill visible too, so a demoted page and a zero-registrant page have to repair a
      // deleted #bwn-launch-style exactly as much as a rendering rail does - and those are the two
      // states Core sits in when it runs alone. Idempotent, and it appends to document.head while
      // the observer watches document.body, so it cannot restart the rebuild loop.
      ensureStyle();
      if (!dockAmHost) { removeDockStack(); return; }
      var vis = dockVisible();
      var pill = document.getElementById(DOCK_ID);
      var stack = document.getElementById(DOCK_STACK_ID);
      // Zero registrants: no rail; the standalone Tools pill stays as the fallback launcher.
      if (!vis.length) { if (stack) stack.remove(); if (pill) pill.style.display = ''; dockSig = ''; publishDockWidth(0); return; }
      // Runs BEFORE the signature check on purpose: idempotent, does not write into the rail
      // subtree (an attribute write against a childList-only observer), and it is a repair - behind
      // the early return an ensureDock-recreated pill would never be re-hidden. It stays BELOW the
      // zero-registrant branch so it cannot fight that branch's pill restore.
      if (pill) pill.style.display = 'none';   // Tools folds into the rail's footer row
      var sig = dockSignature(vis, dockIsCollapsed());
      // Unchanged roster AND the rail is still intact: touch nothing. The firstChild test keeps
      // the self-heal - if the SPA empties the node, the signature match is ignored and we rebuild.
      // Known gap: a PARTIAL child wipe still matches and is not repaired.
      if (stack && stack.firstChild && sig === dockSig) return;
      dockSig = sig;
      if (!stack) { stack = document.createElement('div'); stack.id = DOCK_STACK_ID; document.body.appendChild(stack); }
      stack.textContent = '';
      if (dockIsCollapsed()) {
        stack.className = '';
        publishDockWidth(DOCK_TAB_W);
        var tab = document.createElement('button');
        tab.type = 'button'; tab.className = 'bwn-dock-tab';
        tab.title = 'BWN tools'; tab.setAttribute('aria-label', 'Expand BWN tools');
        // Logo mark: the wordmark PNG shifted left inside a narrow window so only the
        // brand mark shows. Falls back to a rotated "BWN" if the page blocks the image.
        var mark = document.createElement('span'); mark.className = 'bwn-dock-mark';
        var mimg = document.createElement('img');
        mimg.alt = 'Broadway National'; mimg.draggable = false;
        mimg.addEventListener('error', function () {
          var t = document.createElement('span'); t.className = 'bwn-dock-tab-txt'; t.textContent = 'BWN';
          tab.textContent = ''; tab.appendChild(t);
        });
        mimg.src = dockLogoUrl();
        mark.appendChild(mimg); tab.appendChild(mark);
        tab.addEventListener('click', BWN.guard(function () { dockToggle(false, '.bwn-dock-collapse'); }, 'launcher:dockexpand'));
        stack.appendChild(tab);
        return;
      }
      stack.className = 'bwn-dock-rail';
      publishDockWidth(DOCK_RAIL_W);
      // Header: company logo (white wordmark, built for the dark rail). Text fallback if
      // the page blocks the cross-origin image.
      var hd = document.createElement('div'); hd.className = 'bwn-dock-hd';
      var img = document.createElement('img');
      img.alt = 'Broadway National'; img.draggable = false;
      img.addEventListener('error', function () {
        var t = document.createElement('span'); t.className = 'bwn-dock-hd-txt'; t.textContent = 'broadway national';
        hd.textContent = ''; hd.appendChild(t);
      });
      img.src = dockLogoUrl();
      hd.appendChild(img); stack.appendChild(hd);
      var body = document.createElement('div'); body.className = 'bwn-dock-body';
      vis.forEach(function (en) {
        body.appendChild(dockRowEl(en, Object.prototype.hasOwnProperty.call(DOCK_ICONS, en.key) ? en.key : null,
          function () { dockEmit('bwn:dock:open', { key: en.key }); }));
      });
      // Ops Tools, as rows on the rail rather than a "Tools" row that opened a drawer of
      // links. The rail grows to fit and scrolls if the window is short (see .bwn-dock-body).
      var tools = toolItems();
      if (tools.length) {
        var sec = document.createElement('div');
        sec.className = 'bwn-dock-sec'; sec.textContent = 'TOOLS';
        body.appendChild(sec);
        tools.forEach(function (it) {
          body.appendChild(dockRowEl(it, it.icon, function (labelEl) { it.run(labelEl); }));
        });
      }
      stack.appendChild(body);
      var col = document.createElement('button');
      col.type = 'button'; col.className = 'bwn-dock-collapse';
      col.title = 'Collapse'; col.setAttribute('aria-label', 'Collapse BWN tools');
      col.appendChild(dockIcon('chevronLeft'));
      col.addEventListener('click', BWN.guard(function () { dockToggle(true, '.bwn-dock-tab'); }, 'launcher:dockcollapse'));
      stack.appendChild(col);
    }

    document.addEventListener('bwn:evt', BWN.guard(function (e) {
      var d = e && e.detail; if (!d || !d.id) return;
      if (d.id === 'bwn:role' && typeof d.rank === 'number') { dockRank = d.rank; scheduleDockRender(); return; }
      if (d.id === 'bwn:dock:host') { if (dockOtherWins(d)) { dockAmHost = false; dockOtherSeen = Date.now(); removeDockStack(); } return; }
      // A host that is still alive re-announces AND pings every DOCK_PING_MS; that traffic is what
      // holds off the reclaim in the heartbeat. Guarded on hostId so our own ping - same document,
      // same listener - never counts as somebody else's.
      if (d.id === 'bwn:dock:ping' && d.hostId && d.hostId !== dockHostId) { dockOtherSeen = Date.now(); return; }
      if (!dockAmHost) return;
      if (d.id === 'bwn:dock:register' && d.key) {
        var ex = dockRoster[d.key];
        dockRoster[d.key] = {
          key: d.key,
          label: String(d.label || d.key),
          icon: d.icon ? String(d.icon) : '',
          weight: typeof d.weight === 'number' ? d.weight : 50,
          badge: (d.badge != null && d.badge !== '') ? String(d.badge) : '',
          minRank: typeof d.minRank === 'number' ? d.minRank : null,
          title: d.title ? String(d.title) : '',
          order: ex ? ex.order : (++dockOrderSeq),
          seen: Date.now()
        };
        scheduleDockRender();
      } else if (d.id === 'bwn:dock:update' && d.key && dockRoster[d.key]) {
        var en = dockRoster[d.key];
        if (d.label != null) en.label = String(d.label);
        if (d.icon != null) en.icon = String(d.icon);
        if (d.badge != null) en.badge = d.badge === '' ? '' : String(d.badge);
        if (typeof d.minRank === 'number') en.minRank = d.minRank;
        en.seen = Date.now();
        scheduleDockRender();
      } else if (d.id === 'bwn:dock:unregister' && d.key) {
        if (dockRoster[d.key]) { delete dockRoster[d.key]; scheduleDockRender(); }
      }
    }, 'launcher:dockbus'));

    // Seed rank from the persisted slot (same grant-none-safe read the rest of the suite uses).
    try {
      var _dr = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      if (_dr && _dr.ok && typeof _dr.rank === 'number' && _dr.ts && (Date.now() - _dr.ts) < 6 * 3600 * 1000) dockRank = _dr.rank;
    } catch (e) { }

    // Heartbeat: re-announce (registrants re-register on it) + ping + drop stale entries.
    setInterval(BWN.guard(function () {
      // Reclaim. dockAmHost used to be a one-way latch: ONE bwn:dock:host from anything on the page
      // - a real second host that then closed, or a spoofed priority:999 - demoted this dock for the
      // rest of the page's life, with no path back. A live winner re-announces and pings every
      // DOCK_PING_MS, so silence past the same TTL an entry gets means it is gone. If it is in fact
      // alive, our announce loses to it again on the same total order and we demote right back, so
      // the worst case is one wasted render, not two rails.
      if (!dockAmHost) {
        if (Date.now() - dockOtherSeen <= DOCK_TTL_MS) return;
        dockAmHost = true; dockSig = '';   // roster went stale while demoted; the announce refills it
      }
      dockAnnounce(); dockPing(); pruneDock(); scheduleDockRender();
    }, 'launcher:dockbeat'), DOCK_PING_MS);

    // Command-palette bridge: lets the palette module open Suite settings without
    // reaching into this module's scope (modules only share DOM + storage).
    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail;
      if (d && d.id === 'core:settings') openSuitePanel();
    }, 'launcher:cmd'));

    var debounce = null;
    var obs = new MutationObserver(BWN.guard(function () {
      clearTimeout(debounce);
      debounce = setTimeout(BWN.guard(function () { ensureDock(); if (dockAmHost) renderDock(); }, 'launcher:dock'), 600);
    }, 'launcher:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    ensureDock();
    // Announce host + pull registrations so modules (loaded before or after us) sync now.
    dockAnnounce(); dockPing();
  });


  // ==========================================================================
  // MODULE: BWN Views v3.0  - the user's OWN saved layouts on the WO list
  // ==========================================================================
  // v2.0 (2026-08-07): columns + sort apply through Umbrava's OWN persistence
  // (userPreference / putUserPreference on tables/masterWOListTable/settings) instead
  // of 50 passes of column-chooser checkbox choreography. One write, one reload,
  // deterministic columns. Filters (assignee / WO date) are NOT pref-backed - measured:
  // a live 8-assignee selection coexists with a null masterWOListTable/state - so they
  // stay DOM-applied, resumed AFTER the reload via a sessionStorage continuation.
  // The old chooser choreography is kept verbatim as the fallback for when the API
  // path cannot run (no token, pref never created, write rejected).
  //
  // v3.0 (2026-08-07): the three hardcoded presets are GONE. A view is now whatever
  // the user arranged and named - "Save current layout as" captures the live pref
  // value VERBATIM, so a view carries every part of the layout Umbrava persists for
  // that table, including any key this module does not catalogue. That also fixed a
  // v2.x defect: buildColumnsValue rebuilt the value from three known keys and threw
  // the rest away, so applying a view could silently discard a stored column
  // arrangement. It now copies the current value and overrides only the hidden set.
  // Filters remain deliberately opt-in per view (leave alone / My Work / everyone),
  // because they are session state, not layout.
  bwnBoot('viewManager', BWN_MODULES.viewManager, function () {
    'use strict';
    console.info('[BWN VIEWS] loaded on', location.href);

    var WRAP_ID = 'bwn-views-dock';
    var GREEN = BWN.GREEN;

    function isListPage() { return /\/work-orders\/?$/.test(location.pathname); }

    // ---- Column preference API (v2.0) ----------------------------------------
    // Umbrava persists the WO list's column layout server-side per user:
    //   read : userPreference(applicationId,key,isTenantSpecific) -> {key,version,value}
    //   write: putUserPreference(data:PutUserPreferenceInput!) -> {success,message}
    // value is STRINGIFIED JSON. The FULL payload the SPA writes is four keys -
    // {hiddenColumnNames, columnWidths, columnOrder, columnSorting} - read off the
    // bundle's own settings literal 2026-08-07. `columnOrder` is absent from a pref
    // until the user actually drags a column, which is why the first capture showed
    // only three keys; a view must therefore COPY the value rather than rebuild it
    // from the keys it happens to know. Columns are driven by the HIDDEN set, so a
    // column set = hide everything unwanted.
    // `version` is a schema stamp ("2026-07-31-f6c090d"), echoed from the read, never
    // hardcoded. The SPA reads this pref at FULL LOAD only, so applying = write + reload.
    // All of this measured live 2026-08-07; the map below was read off the DevExpress
    // grid's React columns prop the same day (30/30 chooser columns).
    var PREF_APP = 'bn-web-spa';
    var PREF_KEY = 'tables/masterWOListTable/settings';
    var PENDING_KEY = 'bwn:views:pending';   // sessionStorage continuation across the reload
    // Chooser TITLE -> pref column id. Traps pinned by measurement: the row titled
    // "Label" is workOrderCategory (a stray `label` id is accepted and silently
    // ignored); Status is statusId; Client is the tenant-profile ID column; City/
    // State/money columns are dotted paths.
    var NAME_MAP = {
      'Label': 'workOrderCategory', 'Phase': 'phase', 'WO #': 'formattedJobNumber',
      'Tracking #': 'trackingNumber', 'Status': 'statusId', 'Asset': 'asset',
      'Priority': 'priority.label', 'City': 'address.city', 'State': 'address.state',
      'Location #': 'location', 'Trades': 'trades', 'Scope Of Work': 'scopeOfWork',
      'Time in Status (hrs.)': 'timeInStatus', 'Last Note Date': 'lastNoteDate',
      'Client DNE': 'doNotExceed.amount', 'First Trip Date': 'priority.firstTripDate',
      '# Days': 'numberOfDays', 'Expected Completion Date': 'priority.expectedCompletionDate',
      'Latest Update': 'lastModifiedDate', 'Remaining Days': 'remainingDays',
      'WO Date': 'workOrderDate', 'Vendor(s)': 'vendorNames', 'Client': 'clientTenantProfileId',
      'Created By': 'createdBy_UserProfileId', 'Assigned To': 'assignedTo',
      'Scheduled Date': 'nextOnsiteDate', 'Type': 'workOrderTypeId',
      'Source Job #': 'sourceJobNumber', 'Source PO #': 'sourcePurchaseOrderNumber',
      'Total Vendor NTE': 'totalNTE.amount'
    };
    var PREF_READ_Q = 'query($a:String!,$k:String!,$t:Boolean!){ userPreference(applicationId:$a,key:$k,isTenantSpecific:$t){ key version value } }';
    var PREF_WRITE_Q = 'mutation($d:PutUserPreferenceInput!){ putUserPreference(data:$d){ success message } }';
    // Reverse map for the chooser fallback: a saved pref value carries column IDs,
    // but the fallback drives the chooser, which only knows TITLES.
    var TITLE_BY_ID = {};
    Object.keys(NAME_MAP).forEach(function (t) { TITLE_BY_ID[NAME_MAP[t]] = t; });

    // ---- Saved views store (v3.0) ---------------------------------------------
    // A saved view is the user's OWN captured layout, not a preset:
    //   { id, name, value: <the pref value string, VERBATIM>, assignee, savedAt }
    // Storing the pref value verbatim is what makes a view carry everything
    // Umbrava persists for that table - hidden columns, widths, sorting, and any
    // key we have not catalogued (a dragged column ORDER included, if the app
    // stores one). Nothing is re-derived, so nothing is silently dropped.
    // Legacy `columns: [titles]` views still apply through buildColumnsValue.
    // Read-modify-write on bwn:config so other modules' keys survive.
    function loadViews() {
      try {
        var c = JSON.parse(localStorage.getItem('bwn:config') || '{}');
        if (c && Array.isArray(c.views)) return c.views;
      } catch (e) { }
      return [];
    }
    function saveViews(list) {
      var c = {};
      try { c = JSON.parse(localStorage.getItem('bwn:config') || '{}') || {}; } catch (e) { c = {}; }
      c.views = list;
      localStorage.setItem('bwn:config', JSON.stringify(c));
      return list;
    }
    function addView(v) {
      var list = loadViews();
      // Same name overwrites rather than silently creating a twin.
      var at = -1;
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].name).toLowerCase() === String(v.name).toLowerCase()) { at = i; break; }
      }
      if (at >= 0) list[at] = v; else list.push(v);
      return saveViews(list);
    }
    function deleteView(id) {
      return saveViews(loadViews().filter(function (v) { return v.id !== id; }));
    }

    // Compute the pref value for a wanted title list (LEGACY title-based views).
    // Throws on an unmapped title - never guess an id. Starts from a COPY of the
    // current value and overrides only hiddenColumnNames, so widths, sorting and
    // any uncatalogued key (e.g. a stored column order) survive the write; the
    // v2.x version rebuilt the object from three known keys and dropped the rest.
    function buildColumnsValue(cur, wantTitles) {
      var wantIds = {};
      wantTitles.forEach(function (t) {
        var id = NAME_MAP[t];
        if (!id) throw new Error('unmapped column title: ' + t);
        wantIds[id] = true;
      });
      var allIds = Object.keys(NAME_MAP).map(function (k) { return NAME_MAP[k]; });
      var hidden = allIds.filter(function (id) { return !wantIds[id]; });
      (cur.hiddenColumnNames || []).forEach(function (id) {
        if (allIds.indexOf(id) === -1 && hidden.indexOf(id) === -1) hidden.push(id);
      });
      var out = {};
      Object.keys(cur).forEach(function (k) { out[k] = cur[k]; });
      out.hiddenColumnNames = hidden;
      if (!out.columnWidths) out.columnWidths = [];
      if (!out.columnSorting) out.columnSorting = [];
      return out;
    }

    // Titles a saved pref value leaves VISIBLE - the chooser fallback's input.
    function titlesFromValue(parsed) {
      var hidden = (parsed && parsed.hiddenColumnNames) || [];
      return Object.keys(NAME_MAP).filter(function (t) { return hidden.indexOf(NAME_MAP[t]) === -1; });
    }

    function readPref() {
      return bwnGql(PREF_READ_Q, { a: PREF_APP, k: PREF_KEY, t: true }).then(function (d) {
        var up = d && d.userPreference;
        if (!up || !up.value) throw new Error('no existing column pref (never customized?) - DOM fallback');
        return up;
      });
    }

    // FIRST adopter of bwnGqlOp (the BWN-OPS registry + audited wrapper). Routing this
    // one write through it gives the column-layout save a correlation id, a structured
    // audit entry, a pre-send validate(), the viewManager kill switch, and centralized
    // success:false rejection - the wrapper rejects a refused write itself, so the old
    // inline `res.success !== true` throw is gone. Behaviour is otherwise identical: the
    // same PutUserPreferenceInput, resolving true on a verified write.
    function writePref(version, valueStr) {
      return bwnGqlOp('putUserPreference', PREF_WRITE_Q, {
        d: { applicationId: PREF_APP, key: PREF_KEY, version: version, value: valueStr, isTenantSpecific: true }
      }, {
        feature: 'viewManager',
        ids: { key: PREF_KEY },
        validate: function (v) {
          var d = v && v.d;
          if (!d || !d.key || !d.version || typeof d.value !== 'string') return 'missing key/version/value';
          return true;
        }
      }).then(function () { return true; });
    }

    // Apply a SAVED value byte-for-byte. The version comes from a FRESH read, never
    // from the saved copy - it is Umbrava's schema stamp, and replaying a stale one
    // would be writing against a schema that may have moved.
    function apiApplyValue(valueStr) {
      return readPref().then(function (up) { return writePref(up.version, valueStr); });
    }

    // Legacy title-list path.
    function apiApplyColumns(wantTitles) {
      return readPref().then(function (up) {
        return writePref(up.version, JSON.stringify(buildColumnsValue(JSON.parse(up.value), wantTitles)));
      });
    }

    // Capture what is on screen right now as a named view. Rejects when the pref
    // cannot be read - saving a view that would apply nothing is worse than
    // refusing, so the caller reports it.
    function captureCurrent(name, assigneeMode, idNow) {
      return readPref().then(function (up) {
        return addView({
          id: 'v' + idNow,
          name: name,
          value: up.value,
          assignee: (assigneeMode === 'me' || assigneeMode === 'all') ? { mode: assigneeMode } : null,
          savedAt: idNow
        });
      });
    }

    function stashPending(v) {
      try {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify({
          name: v.name, assignee: v.assignee || null, woDateToday: !!v.woDateToday,
          reloadAfter: !!v.reloadAfter, ts: Date.now()
        }));
      } catch (e) { /* private mode - filters just won't resume */ }
    }

    function takePending() {
      try {
        var raw = sessionStorage.getItem(PENDING_KEY);
        if (!raw) return null;
        sessionStorage.removeItem(PENDING_KEY);   // remove BEFORE applying - no retry loops
        var p = JSON.parse(raw);
        if (!p || typeof p.ts !== 'number' || Date.now() - p.ts > 90000) return null;
        return p;
      } catch (e) { return null; }
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function clickReal(el) {
      if (!el) return false;
      try { el.click(); } catch (e) { }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }

    // A leaf element (no children) whose exact trimmed text equals t and is visible.
    function leafWithText(t) {
      var els = document.querySelectorAll('li,div,span,p,a,label,button');
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        if (e.children.length === 0 && (e.textContent || '').trim() === t && e.getBoundingClientRect().width > 0) return e;
      }
      return null;
    }

    function closePopovers() {
      // Umbrava's chooser/filter use MUI clickaway (no backdrop); a real pointer
      // sequence dispatched on <body> dismisses them. Escape / body.click() do not.
      ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
        document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      });
    }

    function setNativeValue(el, val) {
      try { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val); }
      catch (e) { el.value = val; }
    }

    function todayStr() {
      var d = new Date();
      var mm = ('0' + (d.getMonth() + 1)).slice(-2);
      var dd = ('0' + d.getDate()).slice(-2);
      return mm + '/' + dd + '/' + d.getFullYear();
    }

    // The WO Date column's inline filter input, located by aligning to its header
    // cell. Works even when the column is scrolled off-screen.
    // Header cells carry NO data-testids on the WO list (recon 2026-07-10 - the old
    // '[data-testid$="-table-header-cell"]' selector matched nothing here, so the
    // date filter silently never applied). Locate the "WO Date" header CELL by TEXT
    // among the first rows of every table - same discovery style as List Heat -
    // keeping the testid lookup as a fallback for list pages that still carry them.
    function woDateFilterInput() {
      var hc = null;
      var tables = document.querySelectorAll('table');
      for (var t = 0; t < tables.length && !hc; t++) {
        var rmax = Math.min(tables[t].rows.length, 4);
        for (var r = 0; r < rmax && !hc; r++) {
          var cells = tables[t].rows[r].cells;
          for (var c = 0; c < cells.length; c++) {
            if ((cells[c].textContent || '').replace(/\s+/g, ' ').trim() === 'WO Date') { hc = cells[c]; break; }
          }
        }
      }
      if (!hc) {
        hc = Array.prototype.slice.call(document.querySelectorAll('[data-testid$="-table-header-cell"]'))
          .filter(function (h) { return (h.textContent || '').trim() === 'WO Date'; })[0];
      }
      if (!hc) return null;
      var hr = hc.getBoundingClientRect();
      var cands = Array.prototype.slice.call(document.querySelectorAll('input[type="text"]')).filter(function (i) {
        var r = i.getBoundingClientRect();
        return r.width > 0 && Math.abs(r.left - hr.left) < 90 && r.top >= hr.top && r.top < hr.bottom + 120;
      });
      cands.sort(function (a, b) {
        return Math.abs(a.getBoundingClientRect().left - hr.left) - Math.abs(b.getBoundingClientRect().left - hr.left);
      });
      return cands[0] || null;
    }

    // Turn on the inline column-filter row (funnel) if it isn't already showing.
    async function ensureFilterRow() {
      if (woDateFilterInput()) return;
      var fb = document.querySelector('[aria-label="filter list"]');
      if (fb) { fb.click(); await sleep(700); }
    }

    // Set the WO Date column filter to today's date and commit it (Enter).
    async function applyDateFilterToday() {
      await ensureFilterRow();
      var inp = woDateFilterInput();
      if (!inp) return;
      var today = todayStr();
      inp.focus();
      setNativeValue(inp, '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(inp, today);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await sleep(800);
    }

    // ---- Apply the column set via the column chooser ------------------------
    async function applyColumns(want) {
      var wantSet = {};
      want.forEach(function (c) { wantSet[c] = true; });
      var btn = document.querySelector('[data-testid="show-column-chooser-button"]');
      if (!btn) return;
      btn.click();
      await sleep(550);
      // Chooser rows are <li> items each holding a checkbox + a column-name label.
      // Two gotchas: clicking the <li> does NOT flip the box (must click the checkbox
      // itself), and the list re-renders after each toggle (cached refs go stale).
      // So: re-query fresh and toggle ONE mismatch per pass until everything matches.
      function freshRows() {
        return Array.prototype.slice.call(document.querySelectorAll('li')).filter(function (li) {
          var cb = li.querySelector('input[type="checkbox"]');
          return cb && (li.textContent || '').trim() && li.getBoundingClientRect().width > 0;
        });
      }
      for (var pass = 0; pass < 50; pass++) {
        var rows = freshRows();
        var toggled = false;
        for (var i = 0; i < rows.length; i++) {
          var cb = rows[i].querySelector('input[type="checkbox"]');
          var desired = !!wantSet[(rows[i].textContent || '').trim()];
          if (cb.checked !== desired) { cb.click(); toggled = true; await sleep(150); break; }
        }
        if (!toggled) break;
      }
      closePopovers();
      await sleep(200);
    }

    // ---- Apply the assignee filter via the global filter --------------------
    async function applyAssignee(spec) {
      if (!spec) return;
      var gf = document.querySelector('[data-testid="global-filter"]');
      if (!gf) return;
      gf.click();
      await sleep(650);
      if (spec.mode === 'me') {
        clickReal(leafWithText('My Work'));
      } else if (spec.mode === 'all') {
        // "Clear All" removes any assignee restriction -> every coordinator shows.
        // (More reliable than "Select All", which does not latch in this UI.)
        clickReal(leafWithText('Clear All'));
      } else if (spec.mode === 'users' && Array.isArray(spec.names)) {
        clickReal(leafWithText('Clear All'));
        await sleep(250);
        spec.names.forEach(function (nm) {
          var leaf = leafWithText(nm);
          if (leaf) clickReal(leaf.closest('li') || leaf);
        });
      }
      await sleep(350);
      closePopovers();
      await sleep(200);
    }

    var statusEl = null;
    function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ''; }

    var applying = false;
    async function applyView(v) {
      if (applying) return;
      applying = true;
      setStatus('Applying \u201c' + v.name + '\u201d\u2026');
      try {
        // v3.0: a saved view carries the pref value VERBATIM (`v.value`); legacy
        // views carry a title list (`v.columns`). Either way the API path writes
        // once and reloads - the SPA reads the pref at load - and assignee/date
        // resume after the reload via the sessionStorage continuation. Any API
        // shortfall falls back LOUDLY to the chooser choreography.
        if (v.value || v.columns) {
          var wrote = false;
          try {
            if (v.value) await apiApplyValue(v.value);
            else await apiApplyColumns(v.columns);
            wrote = true;
          } catch (apiErr) {
            console.warn('[BWN VIEWS] API column apply unavailable (' + (apiErr && apiErr.message) + ') - falling back to the chooser.');
          }
          if (wrote) {
            stashPending(v);
            setStatus('Columns saved \u00b7 reloading\u2026');
            await sleep(250);
            location.reload();
            return;   // page is going away; the continuation finishes the job
          }
          // Chooser fallback: visibility only. A saved view's widths, sorting and
          // any stored column order CANNOT be replayed through the chooser - say so
          // rather than let a partial apply pass for the real thing.
          var titles = v.columns || titlesFromValue(JSON.parse(v.value));
          await applyColumns(titles);
          if (v.value) setStatus('Applied columns only (no API) \u2014 widths/order not restored');
        }
        if (v.assignee) await applyAssignee(v.assignee);
        if (v.woDateToday) await applyDateFilterToday();
        if (v.reloadAfter) {
          // DOM-fallback path only: re-mount the heat overlay in place instead of
          // reloading. A reload would drop a chooser-applied column set (client
          // state) - the API path above has no such problem because the columns
          // are persisted BEFORE its reload. Nudging the overlay re-detects the
          // Triage columns in place.
          setStatus('Refreshing heat overlay\u2026');
          await sleep(700);
          if (typeof window.__bwnHeatRefresh === 'function') window.__bwnHeatRefresh();
          await sleep(450);
          if (typeof window.__bwnHeatRefresh === 'function') window.__bwnHeatRefresh();
        }
        setStatus('Applied \u201c' + v.name + '\u201d');
      } catch (e) {
        setStatus('Error \u2014 see console');
        console.error('[BWN VIEWS] apply failed', e);
      }
      applying = false;
      setTimeout(function () { setStatus(''); }, 2600);
    }

    // ---- Post-reload continuation (v2.0) -------------------------------------
    // The API path persists columns then reloads; filters are session-only and
    // cannot ride a pref, so they re-apply here through the same DOM paths as
    // before. The pending stash is consumed BEFORE applying - a failed resume
    // logs and stops rather than looping the reload.
    async function resumePending() {
      var p = takePending();
      if (!p || !isListPage()) return;
      for (var i = 0; i < 30; i++) {   // wait for the list toolbar to mount
        if (document.querySelector('[data-testid="global-filter"]')) break;
        await sleep(500);
      }
      setStatus('Resuming \u201c' + p.name + '\u201d\u2026');
      try {
        if (p.assignee) await applyAssignee(p.assignee);
        if (p.woDateToday) await applyDateFilterToday();
        if (p.reloadAfter) {
          await sleep(700);
          if (typeof window.__bwnHeatRefresh === 'function') window.__bwnHeatRefresh();
        }
        setStatus('Applied \u201c' + p.name + '\u201d');
      } catch (e) {
        setStatus('Error \u2014 see console');
        console.error('[BWN VIEWS] pending apply failed', e);
      }
      setTimeout(function () { setStatus(''); }, 2600);
    }

    // ---- Dock UI (v2.0: left of the list's own search box) --------------------
    // The list toolbar's search box has placeholder exactly "Search" (the global
    // nav's is "Search Work Orders") - the same discovery bwn-kanban's Board toggle
    // uses, live-proven. The pill mounts just BEFORE the toolbar child holding that
    // box, so it reads Views | Search | ... ; the menu drops DOWN from the pill.
    // No toolbar found (layout change) -> the old fixed bottom-right pill, so the
    // feature degrades instead of disappearing.
    function pageSearchInput() {
      var ins = document.querySelectorAll('input[placeholder]');
      for (var i = 0; i < ins.length; i++) {
        var ph = ins[i].getAttribute('placeholder') || '';
        if (ph.trim().toLowerCase() !== 'search') continue;
        if (ins[i].closest('header,nav')) continue;
        if (ins[i].getBoundingClientRect().width === 0) continue;
        return ins[i];
      }
      return null;
    }

    // The toolbar row and the row-child that contains the search box: walking up
    // from the input, the first ancestor wider than 300px with siblings is the row;
    // the node we stopped at is the search box's own subtree - insert before it.
    function searchMountRef() {
      var input = pageSearchInput();
      if (!input) return null;
      var el = input, hops = 0;
      while (el.parentElement && hops < 6) {
        var parent = el.parentElement;
        if (parent.getBoundingClientRect().width > 300 && parent.children.length > 1) {
          return { row: parent, before: el };
        }
        el = parent; hops++;
      }
      return null;
    }

    // Rebuild in place after the saved-view list changes, and leave the menu OPEN -
    // a save whose result vanished behind a closed menu reads as a failure.
    function rebuildDock() {
      var old = document.getElementById(WRAP_ID);
      if (old) old.remove();
      ensureDock();
      var fresh = document.getElementById(WRAP_ID);
      if (fresh && fresh.firstElementChild) fresh.firstElementChild.style.display = 'flex';
    }

    function ensureDock() {
      if (!isListPage()) { var g = document.getElementById(WRAP_ID); if (g) g.remove(); BWN.beat('viewManager', 'waiting', 'not the WO list'); return; }
      var mount = searchMountRef();
      var existing = document.getElementById(WRAP_ID);
      if (existing) {
        // Re-anchor a fixed-fallback pill once the toolbar appears, re-mount when
        // React re-renders the row out from under us, and repair in-row ordering
        // drift (React can replace the search subtree while reusing the row, which
        // strands the pill on the wrong side - the fresh mount.before detects it).
        // NEVER move the dock mid-apply or under an open menu: a rebuild destroys
        // the open-menu state and hides the status line; the set-once schedule +
        // this page's mutation stream retry the move soon after. The beat reports
        // the dock's ACTUAL placement - a generic detail here would let a stuck
        // fallback read as healthy forever (review 2026-08-07).
        var menuOpen = existing.firstElementChild && existing.firstElementChild.style.display === 'flex';
        var needsMove = mount && (existing.parentElement !== mount.row || existing.nextElementSibling !== mount.before);
        if (!needsMove || applying || menuOpen) {
          BWN.beat('viewManager', 'ok', existing.parentElement === document.body ? 'views dock fallback (fixed)' : 'views dock in toolbar');
          return;
        }
        existing.remove();
      }

      var wrap = document.createElement('div');
      wrap.id = WRAP_ID;

      var menu = document.createElement('div');
      menu.style.cssText = 'display:none;flex-direction:column;gap:6px;background:var(--bwn-surface);border:1px solid var(--bwn-border);border-radius:9px;padding:8px;box-shadow:0 8px 24px rgba(13,61,38,.18);min-width:210px;';

      var title = document.createElement('div');
      title.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:normal;text-transform:none;color:var(--bwn-text-muted);padding:2px 4px 4px;';
      menu.appendChild(title);

      var saved = loadViews();
      title.textContent = saved.length ? 'Apply a view' : 'No saved views yet';

      if (!saved.length) {
        var hint = document.createElement('div');
        hint.textContent = 'Arrange the list how you like it - columns, widths, sorting - then save it below.';
        hint.style.cssText = 'font-size:11px;line-height:1.4;color:var(--bwn-text-muted);padding:0 4px 4px;max-width:230px;';
        menu.appendChild(hint);
      }

      saved.forEach(function (v) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:stretch;gap:4px;';
        var b = document.createElement('button');
        b.textContent = v.name;
        b.title = v.assignee ? ('Applies columns + ' + (v.assignee.mode === 'me' ? 'My Work' : 'all coordinators')) : 'Applies the saved columns; leaves your filters alone';
        b.style.cssText = 'flex:1;text-align:left;border:1px solid var(--bwn-border);background:var(--bwn-surface-2);color:var(--bwn-green-dk);border-radius:7px;padding:7px 10px;font-size:13px;font-weight:500;cursor:pointer;';
        b.addEventListener('mouseenter', function () { b.style.background = 'var(--bwn-surface-3)'; });
        b.addEventListener('mouseleave', function () { b.style.background = 'var(--bwn-surface-2)'; });
        b.addEventListener('click', function () { applyView(v); });
        // Two-click delete: the first click arms, the second removes. No modal, and
        // no single stray click can drop a view the user spent time arranging.
        var del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Delete this view';
        del.style.cssText = 'border:1px solid var(--bwn-border);background:var(--bwn-surface-2);color:var(--bwn-text-muted);border-radius:7px;padding:0 9px;font-size:14px;line-height:1;cursor:pointer;';
        var armed = false;
        del.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!armed) {
            armed = true;
            del.textContent = 'sure?';
            del.style.color = '#a11';
            del.style.fontSize = '10px';
            del.style.fontWeight = '700';
            setTimeout(function () {
              if (!armed) return;
              armed = false; del.textContent = '×'; del.style.color = 'var(--bwn-text-muted)'; del.style.fontSize = '14px'; del.style.fontWeight = '';
            }, 2600);
            return;
          }
          deleteView(v.id);
          row.remove();
          setStatus('Deleted “' + v.name + '”');
          if (!loadViews().length) title.textContent = 'No saved views yet';
        });
        row.appendChild(b);
        row.appendChild(del);
        menu.appendChild(row);
      });

      // ---- Save the current layout ------------------------------------------
      var sep = document.createElement('div');
      sep.style.cssText = 'border-top:1px solid var(--bwn-border-2);margin:4px 0 2px;';
      menu.appendChild(sep);

      var saveLabel = document.createElement('div');
      saveLabel.textContent = 'Save current layout as';
      saveLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--bwn-text-muted);padding:2px 4px;';
      menu.appendChild(saveLabel);

      var nameIn = document.createElement('input');
      nameIn.type = 'text';
      nameIn.placeholder = 'view name';
      nameIn.style.cssText = 'border:1px solid var(--bwn-border);border-radius:7px;padding:6px 8px;font-size:12.5px;background:var(--bwn-surface);color:var(--bwn-text);';
      menu.appendChild(nameIn);

      var who = document.createElement('select');
      [['keep', 'Leave my filters alone'], ['me', 'Also set: My Work'], ['all', 'Also set: all coordinators']].forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        who.appendChild(op);
      });
      who.style.cssText = 'border:1px solid var(--bwn-border);border-radius:7px;padding:5px 6px;font-size:12px;background:var(--bwn-surface);color:var(--bwn-text);';
      menu.appendChild(who);

      var saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save this layout';
      saveBtn.style.cssText = 'border:1px solid ' + GREEN + ';background:' + GREEN + ';color:#fff;border-radius:7px;padding:7px 10px;font-size:12.5px;font-weight:600;cursor:pointer;';
      saveBtn.addEventListener('click', function () {
        var nm = (nameIn.value || '').trim();
        if (!nm) { setStatus('Name it first'); nameIn.focus(); return; }
        saveBtn.disabled = true;
        setStatus('Saving “' + nm + '”…');
        captureCurrent(nm, who.value, Date.now()).then(function () {
          setStatus('Saved “' + nm + '”');
          nameIn.value = '';
          rebuildDock();   // show it in the list immediately
        }).catch(function (e) {
          saveBtn.disabled = false;
          setStatus('Could not read the layout - see console');
          console.error('[BWN VIEWS] save failed', e);
        });
      });
      menu.appendChild(saveBtn);

      statusEl = document.createElement('div');
      statusEl.style.cssText = 'font-size:11px;color:var(--bwn-green);min-height:14px;padding:0 4px;';
      menu.appendChild(statusEl);

      var pill = document.createElement('button');
      pill.textContent = 'Views\u25be';
      pill.addEventListener('click', function () {
        menu.style.display = (menu.style.display === 'none') ? 'flex' : 'none';
      });

      // Child order menu-then-pill is a CONTRACT: the command palette reads
      // firstElementChild as the menu and lastElementChild as the pill.
      wrap.appendChild(menu);
      wrap.appendChild(pill);

      if (mount) {
        // NO z-index on the docked wrap: position:relative + a high z-index made the
        // whole pill its own stacking context painting ABOVE Umbrava's own popovers
        // (the WO search autocomplete and the "who's visible" assignee filter), so the
        // green pill showed through on top of them. With z-index auto the wrap is not a
        // stacking context: the closed pill sits in normal flow UNDER native dropdowns,
        // while the menu keeps its own z-index:99999 (root level now) and still opens on
        // top when the user actually clicks Views.
        wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;margin-right:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;';
        menu.style.position = 'absolute';
        menu.style.top = 'calc(100% + 6px)';
        menu.style.left = '0';
        menu.style.zIndex = '99999';
        pill.style.cssText = 'background:' + GREEN + ';color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(13,61,38,.22);white-space:nowrap;';
        mount.row.insertBefore(wrap, mount.before);
      } else {
        wrap.style.cssText = 'position:fixed;right:18px;bottom:70px;z-index:99997;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:6px;';
        pill.style.cssText = 'background:' + GREEN + ';color:#fff;border:none;border-radius:9px;padding:9px 14px;font-size:13px;font-weight:500;cursor:pointer;box-shadow:0 4px 14px rgba(13,61,38,.28);';
        document.body.appendChild(wrap);
      }
      BWN.beat('viewManager', 'ok', mount ? 'views dock in toolbar' : 'views dock fallback (fixed)');
    }

    // ---- Views lifecycle -------------------------------------------------------
    // v2.0 used a clear-and-reset 700ms debounce here and it NEVER fired on the
    // live list: every mutation reset the pending timer, and tab timer throttling
    // stretches each window so the next mutation always won the race. Measured
    // 2026-08-07: the dock sat in its boot fallback for minutes while an identical
    // SET-ONCE timer fired fine - and v1 shipped the same dead debounce all along,
    // invisible only because a body-fixed pill never needs a re-run. This is
    // bwn-kanban's live-proven lifecycle: a set-once schedule (a pending check is
    // never reset, so it always lands), history hooks for SPA nav, a resize hook
    // (the mount predicate reads LAYOUT - widths - which a childList observer is
    // blind to), and a boot retry ladder of INDEPENDENT one-shots - modules boot
    // at window load but the toolbar renders seconds later, and unreset one-shots
    // are the only timers measured to fire reliably on this page.
    var tick = null;
    function schedule() {
      if (tick) return;
      tick = setTimeout(BWN.guard(function () { tick = null; ensureDock(); }, 'views:dock'), 250);
    }
    new MutationObserver(BWN.guard(schedule, 'views:observe'))
      .observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', BWN.guard(schedule, 'views:nav'));
    window.addEventListener('resize', BWN.guard(schedule, 'views:nav'));
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      history[m] = function () { var r = orig.apply(this, arguments); schedule(); return r; };
    });
    [0, 1000, 2500, 5000, 10000, 20000].forEach(function (ms) {
      setTimeout(BWN.guard(ensureDock, 'views:dock'), ms);
    });
    resumePending().catch(function (e) { console.error('[BWN VIEWS] resume crashed', e); });
  });


  // ==========================================================================
  // MODULE: Command Palette v1.1 - Ctrl/Cmd-K quick-launch for the whole suite
  // ==========================================================================
  // One keystroke anywhere on Umbrava → type-to-filter → fire any suite action.
  // Core actions run by clicking their module's own affordance, so a command is
  // offered only when its affordance is on the page (existence = context gating).
  // AI-script actions cross the sandbox boundary via bwn:cmd DOM events; each AI
  // module listens for its own ids, so the kill switches keep working.
  bwnBoot('palette', BWN_MODULES.palette, function () {
    'use strict';

    var OV_ID = 'bwn-pal-overlay';
    var STYLE_ID = 'bwn-pal-style';

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        '#bwn-pal-overlay{position:fixed;inset:0;z-index:100002;background:rgba(13,38,26,.42);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;padding-top:14vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-pal{width:560px;max-width:92vw;background:var(--bwn-surface);border:1px solid var(--bwn-border);border-radius:14px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.35);}' +
        '.bwn-pal input{width:100%;box-sizing:border-box;border:none;outline:none;padding:14px 16px;font:500 15px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);background:transparent;border-bottom:1px solid var(--bwn-border-2);}' +
        '.bwn-pal-list{max-height:46vh;overflow:auto;padding:6px;}' +
        '.bwn-pal-it{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:none;background:transparent;padding:9px 11px;border-radius:8px;cursor:pointer;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);}' +
        '.bwn-pal-it .h{margin-left:auto;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);white-space:nowrap;}' +
        '.bwn-pal-it.on{background:var(--bwn-tint);color:var(--bwn-green);}' +
        '.bwn-pal-empty{padding:16px 14px;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-pal-ft{padding:7px 14px;border-top:1px solid var(--bwn-border-2);font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);display:flex;gap:14px;}';
      document.head.appendChild(st);
    }

    // Is an AI-script module able to answer a bwn:cmd right now? Core can't call
    // into the sandbox, but it can read the shared blobs: the bwn:modules kill
    // switch, and bwn:status:ai stamped at page load (compared to Core's own
    // stamp - same load, so a matching ts means the AI script ran this session).
    function aiEnabled(key) {
      try {
        var mp = JSON.parse(localStorage.getItem('bwn:modules') || '{}');
        if (mp && typeof mp[key] === 'boolean' && !mp[key]) return false;
      } catch (e) { }
      try {
        var ai = JSON.parse(localStorage.getItem('bwn:status:ai') || 'null');
        var core = JSON.parse(localStorage.getItem('bwn:status:core') || 'null');
        return !!(ai && ai.ver && core && Math.abs((core.ts || 0) - (ai.ts || 0)) < 60000);
      } catch (e) { return false; }
    }

    // Built at OPEN time so availability always reflects the current page.
    function commands() {
      var list = [];
      function el(id) { return document.getElementById(id); }
      function send(id) { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: id } })); }
      var gp = el('bwn-gp-pill');
      if (gp) list.push({ label: 'WO Assist - GP / ETA breakdown', hint: 'WO', fn: function () { if (!el('bwn-gp-panel')) gp.click(); } });   // open-only: never closes an open panel
      var act = el('bwn-act-card');
      if (act) list.push({
        label: 'Next Actions - jump to checklist', hint: 'WO', fn: function () {
          act.scrollIntoView({ behavior: 'smooth', block: 'center' });
          act.style.outline = '2px solid var(--bwn-accent)';
          setTimeout(function () { act.style.outline = ''; }, 1600);
        }
      });
      if (/\/work-orders\/\d+/.test(location.pathname)) {
        if (aiEnabled('clientUpdate')) [['ai:client', 'AI Draft - Client Update'], ['ai:audit', 'AI Draft - WO Audit'],
         ['ai:recent', 'AI Draft - Recent Update'], ['ai:next', 'AI Draft - Next Steps'],
         ['ai:over30', 'AI Draft - Over 30']
        ].forEach(function (c) { list.push({ label: c[1], hint: 'AI', fn: function () { send(c[0]); } }); });
        if (aiEnabled('findTechs')) [['ai:findtechs', 'Find Techs - contractors near this WO'],
         ['ai:findsup', 'Find Suppliers - supply houses near this WO']
        ].forEach(function (c) { list.push({ label: c[1], hint: 'AI', fn: function () { send(c[0]); } }); });
        if (BWN_MODULES.notesTimeline) list.push({ label: 'Notes timeline - this WO', hint: 'WO', fn: function () { send('core:notestimeline'); } });
        if (BWN_MODULES.woAssist) list.push({ label: 'Set / push expected completion (ECD)', hint: 'WO', fn: function () { send('core:ecd'); } });
      }
      var hs = el('bwn-heat-sum');
      if (hs) Array.prototype.forEach.call(hs.querySelectorAll('button'), function (b) {
        if (b.disabled) return;   // e.g. mid-scan the button reads "Scanning… 34/120" and is inert
        var t = (b.textContent || '').trim();
        if (/scan/i.test(t)) list.push({ label: 'List Heat - ' + t, hint: 'list', fn: function () { b.click(); } });
        else if (/^audit$/i.test(t)) list.push({ label: 'List Heat - Audit breakdown', hint: 'list', fn: function () { b.click(); } });
      });
      var vd = el('bwn-views-dock');
      if (vd && vd.lastElementChild) list.push({
        label: 'Views - apply a preset', hint: 'list', fn: function () {
          // Re-resolve at execution time: Views v2+ re-anchors REBUILD the dock, so
          // the node captured at palette-open can be detached by the time fn runs -
          // clicking the detached pill toggles a detached menu, a silent no-op.
          var d = el('bwn-views-dock') || vd;
          var m = d.firstElementChild;   // menu is built before the pill; open-only
          if (!m || m.style.display === 'none' || !m.childElementCount) d.lastElementChild.click();
        }
      });
      var dock = el('bwn-launch-dock');
      if (dock) {
        list.push({ label: 'Tools - open launcher', hint: 'suite', fn: function () { if (!el('bwn-launch-menu')) dock.click(); } });
        list.push({ label: 'Suite settings - modules · thresholds · status', hint: 'suite', fn: function () { send('core:settings'); } });
      }
      if (BWN_MODULES.visitLog) list.push({ label: 'End-of-day digest - today’s touched WOs', hint: 'suite', fn: function () { send('core:eoddigest'); } });
      if (BWN_MODULES.reminders) list.push({ label: 'Follow-up reminders - set / view', hint: 'suite', fn: function () { send('core:remind'); } });
      return list;
    }

    var navState = null;   // { items, idx, listEl } while the palette is open

    function closePal() {
      var ov = document.getElementById(OV_ID);
      if (!ov) return;
      window.removeEventListener('keydown', onNavKey, true);
      navState = null;
      var prev = ov._bwnPrevFocus;
      ov.remove();
      try { if (prev && prev.focus && prev.isConnected) prev.focus(); } catch (e) { }
    }

    function onNavKey(e) {
      if (!document.getElementById(OV_ID)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePal(); return; }
      if (!navState) return;
      // Swallow Tab while open: the suite's own capture-phase focus traps (AI
      // dialogs, Ops panel) sit beneath the palette and would steal focus into
      // covered UI. Arrows are the palette's navigation; focus stays on the input.
      if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        if (!navState.items.length) return;
        navState.idx = (navState.idx + (e.key === 'ArrowDown' ? 1 : -1) + navState.items.length) % navState.items.length;
        paintSel();
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        var it = navState.items[navState.idx];
        if (it) { closePal(); it.fn(); }
      }
    }
    function paintSel() {
      if (!navState) return;
      Array.prototype.forEach.call(navState.listEl.children, function (c, i) {
        c.classList.toggle('on', i === navState.idx);
        if (i === navState.idx && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' });
      });
    }

    function openPal() {
      if (document.getElementById(OV_ID)) { closePal(); return; }   // hotkey toggles
      ensureStyle();
      var all = commands();
      var ov = document.createElement('div');
      ov.id = OV_ID;
      ov._bwnPrevFocus = document.activeElement;
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) closePal(); });

      var card = document.createElement('div'); card.className = 'bwn-pal';
      card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', 'Suite command palette');
      var inp = document.createElement('input');
      inp.type = 'text'; inp.placeholder = 'Type a command… (Esc to close)';
      inp.setAttribute('aria-label', 'Filter commands');
      var listEl = document.createElement('div'); listEl.className = 'bwn-pal-list';
      var ft = document.createElement('div'); ft.className = 'bwn-pal-ft';
      ft.textContent = '↑↓ navigate · Enter run · Esc close';

      navState = { items: [], idx: 0, listEl: listEl };
      function renderList() {
        var q = inp.value.trim().toLowerCase();
        navState.items = q ? all.filter(function (c) { return c.label.toLowerCase().indexOf(q) !== -1; }) : all;
        navState.idx = 0;
        listEl.textContent = '';
        if (!navState.items.length) {
          var em = document.createElement('div'); em.className = 'bwn-pal-empty';
          em.textContent = all.length ? 'No matching command.' : 'No suite actions on this page.';
          listEl.appendChild(em);
          return;
        }
        navState.items.forEach(function (c, i) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'bwn-pal-it' + (i === 0 ? ' on' : '');
          b.appendChild(document.createTextNode(c.label));
          var h = document.createElement('span'); h.className = 'h'; h.textContent = c.hint;
          b.appendChild(h);
          b.addEventListener('click', function () { closePal(); c.fn(); });
          b.addEventListener('mousemove', function () { if (navState && navState.idx !== i) { navState.idx = i; paintSel(); } });
          listEl.appendChild(b);
        });
      }
      inp.addEventListener('input', renderList);
      renderList();

      card.appendChild(inp); card.appendChild(listEl); card.appendChild(ft);
      ov.appendChild(card);
      document.body.appendChild(ov);
      window.addEventListener('keydown', onNavKey, true);
      setTimeout(function () { try { inp.focus(); } catch (e) { } }, 0);
    }

    // Configurable hotkey (Task 6). bwn:config.keys.palette (default 'mod+k') sets the
    // binding; 'mod' = Ctrl on Windows / Cmd on macOS. Read once, then refreshed on the
    // bwn:config change event (live rebind, no reload) rather than per-keystroke. A
    // binding with no modifier (mod/ctrl/meta/alt) is rejected back to mod+k so a stray
    // config can never make a plain key open the palette on every keystroke.
    // WINDOW capture fires before document-capture handlers (the suite's own dialog traps
    // and panel Esc handlers register on document), so the palette's stopPropagation
    // cleanly shields everything beneath it - one Esc closes only the palette.
    function parseHotkey(str) {
      var spec = { mod: false, ctrl: false, meta: false, shift: false, alt: false, key: '' };
      String(str || '').toLowerCase().split('+').forEach(function (p) {
        p = p.trim(); if (!p) return;
        if (p === 'mod') spec.mod = true;
        else if (p === 'ctrl' || p === 'control') spec.ctrl = true;
        else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'win') spec.meta = true;
        else if (p === 'shift') spec.shift = true;
        else if (p === 'alt' || p === 'option' || p === 'opt') spec.alt = true;
        else spec.key = p;
      });
      return spec.key ? spec : null;
    }
    function matchHotkey(e, spec) {
      if (!spec || String(e.key || '').toLowerCase() !== spec.key) return false;
      var modOk = spec.mod ? (e.ctrlKey || e.metaKey) : (!!e.ctrlKey === spec.ctrl && !!e.metaKey === spec.meta);
      return modOk && !!e.shiftKey === spec.shift && !!e.altKey === spec.alt;
    }
    function readPaletteSpec() {
      var cfgKeys = BWN.cfg().keys, raw = (cfgKeys && cfgKeys.palette) || 'mod+k';
      var s = parseHotkey(raw);
      if (!s || (!s.mod && !s.ctrl && !s.meta && !s.alt)) s = parseHotkey('mod+k');   // must carry a modifier
      return s;
    }
    var paletteSpec = readPaletteSpec();
    document.addEventListener('bwn:config', BWN.guard(function () { paletteSpec = readPaletteSpec(); }, 'palette:rebind'));
    window.addEventListener('keydown', BWN.guard(function (e) {
      if (matchHotkey(e, paletteSpec)) {
        e.preventDefault(); e.stopPropagation();
        openPal();
      }
    }, 'palette:hotkey'), true);
    BWN.beat('palette', 'ok', 'hotkey armed (' + ((BWN.cfg().keys && BWN.cfg().keys.palette) || 'mod+k') + ')');
  });


  // ==========================================================================
  // MODULE: Visit Memory v1.2 - watch strip ("what moved since you last looked")
  //         + end-of-day digest, from a local per-WO visit log. Zero egress.
  // ==========================================================================
  // Every WO view records a lightweight snapshot (status, PO count, newest-note
  // id, GP) in localStorage. On the next visit a slim strip at the top of the
  // notes feed diffs the WO against how it looked when you personally last left
  // it - the per-WO complement to List Heat's board-wide triage. The same log
  // feeds a paste-ready "touched N WOs today" digest from the Tools menu.
  bwnBoot('visitLog', BWN_MODULES.visitLog, function () {
    'use strict';

    var STRIP_ID = 'bwn-watch-strip';
    var STYLE_ID = 'bwn-watch-style';
    var currentWOId = BWN.woId;
    function onWO() { return /\/work-orders\//.test(location.pathname); }

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function dayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    function relLabel(ts) {
      var d = new Date(ts), now = new Date();
      var days = Math.round((midnight(now) - midnight(d)) / 86400000);
      var md = (d.getMonth() + 1) + '/' + d.getDate();
      var wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
      if (days <= 0) return 'earlier today';
      if (days === 1) return 'yesterday (' + md + ')';
      if (days < 7) return wd + ' ' + md;
      return md;
    }

    function txt(testid) {
      var el = document.querySelector('[data-testid="' + testid + '"]');
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }
    // A snapshot leans on WO Assist's published bus state when present, and falls
    // back to the SAME stable header testids so it works even with woAssist off.
    function snap() {
      var wid = currentWOId();
      var bus = wid ? BWN.busGet(wid) : null;
      // Newest note = MAX numeric id among mounted summaries (ids are monotonic).
      // NOT DOM-position-first: the notes list is virtualized, so the first mounted
      // row changes as you scroll - that produced false "new note" diffs and
      // corrupted the stored baseline (review M1). tick() further high-waters this
      // across the visit so scrolling away from the newest can't lower it.
      var topId = '', topTs = '', maxN = -1;
      var sums = document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]');
      for (var si = 0; si < sums.length; si++) {
        var mm = (sums[si].getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/);
        if (!mm) continue;
        var idn = parseInt(mm[1], 10);
        if (idn > maxN) { maxN = idn; topId = mm[1]; try { topTs = BWN.noteMeta(BWN.noteCard(sums[si])).ts || ''; } catch (e) { topTs = ''; } }
      }
      var clientA = document.querySelector('a[href*="/clients/"]');
      return {
        ts: Date.now(),
        tracking: (bus && bus.tracking) || txt('work-order-header-tracking-number').replace(/\D+/g, ''),
        wo: (bus && bus.wo) || txt('work-order-header-number-formatted'),
        client: (bus && bus.client) || (clientA ? (clientA.textContent || '').replace(/\s+/g, ' ').trim() : ''),
        location: (bus && bus.location) || txt('wo-location-dropdown-input-label'),
        status: (bus && bus.status) || (BWN.inputVal('statusId-autocomplete-input') || '').trim(),
        poCount: document.querySelectorAll('[data-testid^="POAccordion-"]').length,
        topNoteId: topId, topNoteTs: topTs,
        gpPct: (bus && typeof bus.gpPct === 'number') ? bus.gpPct : null
      };
    }

    // ---- storage: per-WO baseline + per-day touched log --------------------
    function loadBase(wid) { return BWN.lsGetJSON('bwn:visit:snap:' + wid, null); }
    function saveBase(wid, s) {
      BWN.lsSetJSON('bwn:visit:snap:' + wid, s);
      try {   // cap to the 80 most-recent snapshots so the log can't grow unbounded
        var arr = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf('bwn:visit:snap:') === 0) { var v = BWN.lsGetJSON(k, null); arr.push({ k: k, ts: (v && v.ts) || 0 }); }
        }
        if (arr.length > 80) { arr.sort(function (a, b) { return b.ts - a.ts; }); for (var j = 80; j < arr.length; j++) localStorage.removeItem(arr[j].k); }
      } catch (e) { }
    }
    function logToday(s) {
      var wid = currentWOId(); if (!wid || (!s.tracking && !s.wo)) return;
      var key = 'bwn:visit:day:' + dayKey();
      var log = BWN.lsGetJSON(key, {}) || {};
      var prev = log[wid];
      log[wid] = {
        tracking: s.tracking, wo: s.wo, client: s.client, location: s.location,
        status: s.status, gpPct: s.gpPct, href: location.pathname,
        firstTs: prev ? prev.firstTs : s.ts, lastTs: s.ts
      };
      BWN.lsSetJSON(key, log);
      try {   // keep today + the two prior days only
        var dk = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('bwn:visit:day:') === 0) dk.push(k); }
        dk.sort();
        for (var j = 0; j < dk.length - 3; j++) localStorage.removeItem(dk[j]);
      } catch (e) { }
    }

    // ---- site history index (client + location) ----------------------------
    // Durable, NOT day-scoped: one localStorage entry per client|site so a hover
    // reads a single key (no giant blob parse). Feeds the client-name history peek.
    function siteStoreKey(client, location) { return 'bwn:site:' + encodeURIComponent((client || '') + '|||' + (location || '')); }
    function indexSite(s) {
      if (!s.client) return;
      var wid = currentWOId(); if (!wid) return;
      var key = siteStoreKey(s.client, s.location);
      var site = BWN.lsGetJSON(key, null) || { client: s.client, location: s.location || '', wos: {}, lastTs: 0 };
      site.wos[wid] = { tracking: s.tracking, wo: s.wo, status: s.status, ts: s.ts };
      site.lastTs = s.ts;
      var wids = Object.keys(site.wos);   // cap 30 WOs/site (newest by ts)
      if (wids.length > 30) { wids.sort(function (a, b) { return site.wos[b].ts - site.wos[a].ts; }); for (var i = 30; i < wids.length; i++) delete site.wos[wids[i]]; }
      BWN.lsSetJSON(key, site);
      try {   // cap 250 sites total (newest by lastTs)
        var arr = [];
        for (var j = 0; j < localStorage.length; j++) { var kk = localStorage.key(j); if (kk && kk.indexOf('bwn:site:') === 0) { var v = BWN.lsGetJSON(kk, null); arr.push({ k: kk, ts: (v && v.lastTs) || 0 }); } }
        if (arr.length > 250) { arr.sort(function (a, b) { return b.ts - a.ts; }); for (var m = 250; m < arr.length; m++) localStorage.removeItem(arr[m].k); }
      } catch (e) { }
    }

    // ---- watch strip -------------------------------------------------------
    function diffs(base, cur) {
      var out = [];
      if ((base.status || '') !== (cur.status || '') && (base.status || cur.status))
        out.push('Status: ' + (base.status || '-') + ' → ' + (cur.status || '-'));
      if (typeof base.poCount === 'number' && base.poCount !== cur.poCount) {
        var d = cur.poCount - base.poCount;
        out.push((d > 0 ? '+' : '') + d + ' PO' + (Math.abs(d) === 1 ? '' : 's'));
      }
      var bN = base.topNoteId ? parseInt(base.topNoteId, 10) : -1;
      var cN = cur.topNoteId ? parseInt(cur.topNoteId, 10) : -1;
      if (cN >= 0 && cN > bN)   // strictly newer id only - a deleted top note (cur<base) is not "new activity"
        out.push('New note activity' + (cur.topNoteTs ? ' · ' + cur.topNoteTs : ''));
      if (base.gpPct != null && cur.gpPct != null && Math.abs(cur.gpPct - base.gpPct) >= 1)
        out.push('GP ' + base.gpPct + '% → ' + cur.gpPct + '%');
      return out;
    }
    var stripWO = null, baseFrozen = null, lastSig = null, visitMaxId = '', visitMaxTs = '';
    function renderStrip(base, cur) {
      var top = document.querySelector('[data-testid^="wo-note-"][data-testid$="-summary"]');
      var ex = document.getElementById(STRIP_ID);
      if (!base || !top) { if (ex) ex.remove(); return; }
      var card = BWN.noteCard(top);
      if (!card || !card.parentNode) { if (ex) ex.remove(); return; }
      var ds = diffs(base, cur);
      var sig = 'v1|' + relLabel(base.ts) + '|' + (cur.status || '') + '|' + ds.join('¦');
      if (ex && ex.dataset.sig === sig && ex.parentNode === card.parentNode && ex.nextSibling === card) return;
      if (ex) ex.remove();
      ensureStyle();
      var strip = document.createElement('div');
      strip.id = STRIP_ID; strip.className = 'bwn-watch' + (ds.length ? '' : ' quiet'); strip.dataset.sig = sig;
      var lab = document.createElement('span'); lab.className = 'bwn-watch-lab';
      lab.textContent = 'Since you last viewed · ' + relLabel(base.ts);
      strip.appendChild(lab);
      if (ds.length) {
        ds.forEach(function (t) {
          var chip = document.createElement('span'); chip.className = 'bwn-watch-chip'; chip.textContent = t;
          strip.appendChild(chip);
        });
      } else {
        var none = document.createElement('span'); none.className = 'bwn-watch-none';
        none.textContent = 'No change' + (cur.status ? ' - still ' + cur.status : '');
        strip.appendChild(none);
      }
      card.parentNode.insertBefore(strip, card);
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style'); st.id = STYLE_ID;
      st.textContent =
        '.bwn-watch{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px;padding:8px 12px;border:1px solid var(--bwn-border);border-left:3px solid var(--bwn-accent);border-radius:9px;background:var(--bwn-surface);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-watch.quiet{border-left-color:var(--bwn-border-2);}' +
        '.bwn-watch-lab{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:normal;text-transform:none;color:var(--bwn-text-faint);}' +
        '.bwn-watch-chip{font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);background:var(--bwn-tint);border-radius:20px;padding:3px 10px;}' +
        '.bwn-watch-none{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-hist{position:fixed;z-index:100001;max-width:340px;background:var(--bwn-surface);border:1px solid var(--bwn-border);border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.28);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;overflow:hidden;}' +
        '.bwn-hist-hd{background:var(--bwn-tint);color:var(--bwn-green);font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;padding:8px 12px;border-bottom:1px solid var(--bwn-border-2);}' +
        '.bwn-hist-body{padding:6px 12px;max-height:220px;overflow:auto;}' +
        '.bwn-hist-row{font:500 11.5px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text);padding:3px 0;}' +
        '.bwn-hist-empty{font:500 11.5px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);padding:3px 0;}' +
        '.bwn-hist-ft{padding:6px 12px;border-top:1px solid var(--bwn-border-2);font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '#bwn-eod-overlay{position:fixed;inset:0;z-index:100000;background:rgba(13,38,26,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-eod{width:620px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:16px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.35);}' +
        '.bwn-eod-hd{background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:14px 18px;font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-eod textarea{flex:1;margin:0;border:none;outline:none;resize:none;padding:14px 16px;font:500 12.5px ui-monospace,"Segoe UI Mono","SF Mono",monospace;line-height:1.5;color:var(--bwn-text);background:var(--bwn-surface);min-height:240px;}' +
        '.bwn-eod-ft{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-eod-ft button{border:1px solid var(--bwn-border);background:var(--bwn-surface-2);color:var(--bwn-text);border-radius:8px;padding:7px 16px;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;}' +
        '.bwn-eod-ft button.pri{background:var(--bwn-green);border-color:var(--bwn-green);color:#fff;}' +
        '.bwn-eod-ft button:disabled{opacity:.5;cursor:default;}' +
        '.bwn-eod-ft .sp{margin-right:auto;}';
      document.head.appendChild(st);
    }

    // ---- client-name history peek (hover) ----------------------------------
    var HIST_ID = 'bwn-hist-pop';
    var histHideT = null;
    function hideHist(now) {
      clearTimeout(histHideT);
      var go = function () { var p = document.getElementById(HIST_ID); if (p) p.remove(); };
      if (now) go(); else histHideT = setTimeout(go, 180);
    }
    function showHist(anchor) {
      clearTimeout(histHideT);
      var s = snap(); if (!s.client) return;
      var wid = currentWOId();
      var site = BWN.lsGetJSON(siteStoreKey(s.client, s.location), null);
      var entries = [];
      if (site && site.wos) Object.keys(site.wos).forEach(function (id) {
        var w = site.wos[id]; entries.push({ id: id, tracking: w.tracking, status: w.status, ts: w.ts, cur: id === wid });
      });
      entries.sort(function (a, b) { return b.ts - a.ts; });
      var count = entries.length;
      var otherSites = 0;   // other sites viewed for the SAME client (shared key prefix)
      try {
        var pref = 'bwn:site:' + encodeURIComponent(s.client + '|||'), self = siteStoreKey(s.client, s.location);
        for (var i = 0; i < localStorage.length; i++) { var kk = localStorage.key(i); if (kk && kk.indexOf(pref) === 0 && kk !== self) otherSites++; }
      } catch (e) { }

      ensureStyle();
      var old = document.getElementById(HIST_ID); if (old) old.remove();
      var pop = document.createElement('div'); pop.id = HIST_ID; pop.className = 'bwn-hist';
      var hd = document.createElement('div'); hd.className = 'bwn-hist-hd';
      hd.textContent = (count <= 1 ? 'First visit here' : count + ' WOs viewed here') + ' · ' + s.client + (s.location ? ' · ' + s.location : '');
      pop.appendChild(hd);
      var body = document.createElement('div'); body.className = 'bwn-hist-body';
      var shown = entries.slice(0, 6);
      if (!shown.length || (shown.length === 1 && shown[0].cur)) {
        var em = document.createElement('div'); em.className = 'bwn-hist-empty';
        em.textContent = 'No earlier visits recorded for this site.';
        body.appendChild(em);
      } else {
        shown.forEach(function (e) {
          var row = document.createElement('div'); row.className = 'bwn-hist-row';
          row.textContent = (e.tracking ? '#' + e.tracking : 'WO') + (e.status ? ' · ' + e.status : '') + ' · ' + relLabel(e.ts) + (e.cur ? '  (current)' : '');
          body.appendChild(row);
        });
      }
      pop.appendChild(body);
      if (otherSites > 0) {
        var ft = document.createElement('div'); ft.className = 'bwn-hist-ft';
        ft.textContent = '+ ' + otherSites + ' other site' + (otherSites === 1 ? '' : 's') + ' viewed for this client';
        pop.appendChild(ft);
      }
      pop.addEventListener('mouseenter', function () { clearTimeout(histHideT); });
      pop.addEventListener('mouseleave', function () { hideHist(false); });
      document.body.appendChild(pop);
      var r = anchor.getBoundingClientRect();
      var left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 12);
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.left = Math.max(8, left) + 'px';
    }
    function bindClientHover() {
      var a = document.querySelector('a[href*="/clients/"]');
      if (!a || a.__bwnHist) return;   // JS-prop flag: invisible to observers, re-binds if React swaps the node
      a.__bwnHist = true;
      a.addEventListener('mouseenter', function () { showHist(a); });
      a.addEventListener('mouseleave', function () { hideHist(false); });
    }

    // ---- end-of-day digest -------------------------------------------------
    function buildDigest() {
      var log = BWN.lsGetJSON('bwn:visit:day:' + dayKey(), {}) || {};
      var ids = Object.keys(log);
      if (!ids.length) return null;
      ids.sort(function (a, b) { return (log[b].lastTs || 0) - (log[a].lastTs || 0); });
      var groups = {};
      ids.forEach(function (id) { var g = log[id].status || '(no status)'; (groups[g] = groups[g] || []).push(log[id]); });
      var lines = ['Touched ' + ids.length + ' WO' + (ids.length === 1 ? '' : 's') + ' today (' + dayKey() + '):', ''];
      Object.keys(groups).sort().forEach(function (g) {
        var arr = groups[g];
        lines.push(g + ' (' + arr.length + '):');
        arr.forEach(function (w) {
          lines.push('  • ' + (w.tracking ? '#' + w.tracking : (w.wo || 'WO')) +
            (w.client ? ' · ' + w.client : '') + (w.location ? ' · ' + w.location : ''));
        });
        lines.push('');
      });
      return lines.join('\n').trim();
    }
    function showDigest() {
      var text = buildDigest();
      ensureStyle();
      var old = document.getElementById('bwn-eod-overlay'); if (old) old.remove();
      var ov = document.createElement('div'); ov.id = 'bwn-eod-overlay';
      var prevFocus = document.activeElement;
      var card = document.createElement('div'); card.className = 'bwn-eod';
      card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', 'End-of-day digest');
      function close() { document.removeEventListener('keydown', onKey); ov.remove(); try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus(); } catch (e) { } }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
      var hd = document.createElement('div'); hd.className = 'bwn-eod-hd'; hd.textContent = 'End-of-day digest';
      card.appendChild(hd);
      var ta = document.createElement('textarea');
      ta.value = text || 'No WOs recorded today yet. Open a few work orders and this will fill in.';
      ta.readOnly = !text;
      card.appendChild(ta);
      var ft = document.createElement('div'); ft.className = 'bwn-eod-ft';
      var sp = document.createElement('span'); sp.className = 'sp'; ft.appendChild(sp);
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'pri'; copy.textContent = 'Copy';
      copy.disabled = !text;
      copy.addEventListener('click', function () {
        navigator.clipboard.writeText(ta.value).then(function () {
          copy.textContent = 'Copied ✓'; setTimeout(function () { copy.textContent = 'Copy'; }, 1300);
        }, function () { ta.focus(); ta.select(); });
      });
      var cl = document.createElement('button'); cl.type = 'button'; cl.textContent = 'Close';
      cl.addEventListener('click', close);
      ft.appendChild(copy); ft.appendChild(cl); card.appendChild(ft);
      ov.appendChild(card); document.body.appendChild(ov);
      document.addEventListener('keydown', onKey);
      if (text) setTimeout(function () { try { ta.focus(); ta.select(); } catch (e) { } }, 0);
    }
    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail; if (d && d.id === 'core:eoddigest') showDigest();
    }, 'visitLog:cmd'));

    // ---- lifecycle ---------------------------------------------------------
    function tick() {
      if (!onWO()) {
        var s0 = document.getElementById(STRIP_ID); if (s0) s0.remove();
        hideHist(true);
        stripWO = null; baseFrozen = null; lastSig = null;
        BWN.beat('visitLog', 'waiting', 'not a WO page');
        return;
      }
      if (!document.querySelector('[data-testid^="POAccordion-"]') &&
          !document.querySelector('[data-testid^="wo-note-"][data-testid$="-summary"]')) {
        BWN.beat('visitLog', 'waiting', 'WO anchors not rendered');
        return;
      }
      var wid = currentWOId(); if (!wid) return;
      var cur = snap();
      // First sight of this WO this visit: freeze the PRIOR visit's snapshot for the
      // diff, THEN let the write below advance the stored baseline to "now".
      if (stripWO !== wid) { baseFrozen = loadBase(wid); stripWO = wid; lastSig = null; visitMaxId = ''; visitMaxTs = ''; }
      // High-water the newest note id across the visit - scrolling away from the top
      // unmounts the newest row, so the per-tick max can dip; this only ever climbs.
      if (cur.topNoteId && (!visitMaxId || parseInt(cur.topNoteId, 10) > parseInt(visitMaxId, 10))) { visitMaxId = cur.topNoteId; visitMaxTs = cur.topNoteTs; }
      if (visitMaxId) { cur.topNoteId = visitMaxId; cur.topNoteTs = visitMaxTs; }
      var contentSig = wid + '|' + cur.status + '|' + cur.poCount + '|' + cur.topNoteId + '|' + cur.gpPct;
      // Write only when the WO's content actually changed (or first sight) - never
      // on idle DOM churn - so the stored baseline tracks my latest view for NEXT time.
      if (contentSig !== lastSig) { saveBase(wid, cur); logToday(cur); indexSite(cur); lastSig = contentSig; }
      renderStrip(baseFrozen, cur);
      bindClientHover();
      BWN.beat('visitLog', 'ok', 'watch strip active');
    }

    var lastPath = location.pathname, deb = null;
    var obs = new MutationObserver(BWN.guard(function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        var s = document.getElementById(STRIP_ID); if (s) s.remove();
        hideHist(true);
        stripWO = null; baseFrozen = null; lastSig = null;
      }
      clearTimeout(deb);
      deb = setTimeout(BWN.guard(tick, 'visitLog:tick'), 500);
    }, 'visitLog:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('bwn:update', BWN.guard(function () {
      clearTimeout(deb); deb = setTimeout(BWN.guard(tick, 'visitLog:tick'), 300);
    }, 'visitLog:update'));
    tick();
  });


  // ==========================================================================
  // MODULE: Follow-up Reminders v1.1 - local "nudge me about this WO" alerts
  // ==========================================================================
  // Set a time-based reminder for the current WO; a browser Notification (or an
  // in-page toast if notifications are blocked) fires at that time with a link
  // back. Pure localStorage + Notification API - zero egress, no server. The
  // ticker only runs while an Umbrava tab is open (which is the point: the nudge
  // reaches you wherever you are IN Umbrava). Opened from the Tools menu / palette.
  bwnBoot('reminders', BWN_MODULES.reminders, function () {
    'use strict';

    var currentWOId = BWN.woId;
    function onWO() { return /\/work-orders\//.test(location.pathname); }
    var STORE = 'bwn:reminders';
    var STYLE_ID = 'bwn-rem-style';
    var OV_ID = 'bwn-rem-overlay';

    function load() { var a = BWN.lsGetJSON(STORE, []); return Array.isArray(a) ? a : []; }
    function save(a) { BWN.lsSetJSON(STORE, a); }
    function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function reqPerm() { try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { } }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function fmtWhen(ts) {
      var d = new Date(ts), now = new Date();
      var t = pad(d.getHours()) + ':' + pad(d.getMinutes());
      if (d.toDateString() === now.toDateString()) return 'today ' + t;
      if (d.toDateString() === new Date(now.getTime() + 86400000).toDateString()) return 'tomorrow ' + t;
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + t;
    }

    // ---- firing ------------------------------------------------------------
    function notify(r) {
      var title = 'WO follow-up' + (r.tracking ? ' · #' + r.tracking : '');
      var body = (r.note ? r.note + ' - ' : '') + (r.client || '') + (r.location ? ' · ' + r.location : '');
      try {
        if (window.Notification && Notification.permission === 'granted') {
          var n = new Notification(title, { body: body || 'Time to follow up.', tag: 'bwn-rem-' + r.id });
          n.onclick = function () { try { window.focus(); } catch (e) { } if (r.url) location.href = r.url; try { n.close(); } catch (e2) { } };
          return;
        }
      } catch (e) { }
      toast(title + (body ? ' - ' + body : ''), r.url);   // notifications blocked → in-page fallback
    }
    function fireDue() {
      var arr = load(), now = Date.now(), changed = false;
      for (var i = 0; i < arr.length; i++) {
        if (!arr[i].fired && arr[i].fireAt <= now) { arr[i].fired = true; changed = true; notify(arr[i]); }
      }
      if (changed) save(arr.filter(function (r) { return !r.fired || (now - r.fireAt) < 86400000; }));   // keep fired 24h, then drop
    }
    function toast(msg, url) {
      // In-page fallback when desktop Notifications are blocked (notify() owns the
      // Notification API path and still calls this). Routed through the unified
      // BWN.toast (Task 2); green preserved. Extra: the "Open" button -> the WO url.
      // (The legacy .bwn-rem-toast CSS rule is now unused but left inert.)
      BWN.toast('success', msg, {
        timeout: 20000,
        action: url ? { label: 'Open', onClick: function () { try { location.href = url; } catch (e) { } } } : undefined
      });
    }

    // ---- set / manage ------------------------------------------------------
    function addReminder(fireAt, note) {
      if (!(fireAt > Date.now())) { alert('Pick a time in the future.'); return false; }
      var b = onWO() ? (BWN.busGet(currentWOId()) || {}) : {};
      var arr = load();
      arr.push({
        id: rid(), woId: currentWOId(), tracking: (b.tracking || '').replace(/\D+/g, ''),
        client: b.client || '', location: b.location || '', url: location.href,
        note: note || '', fireAt: fireAt, fired: false, createdAt: Date.now()
      });
      if (arr.length > 100) arr = arr.slice(-100);
      save(arr); reqPerm();
      return true;
    }
    function cancelReminder(id) { save(load().filter(function (r) { return r.id !== id; })); }

    function openDialog() {
      ensureStyle();
      var old = document.getElementById(OV_ID); if (old) old.remove();
      var ov = document.createElement('div'); ov.id = OV_ID;
      var card = document.createElement('div'); card.className = 'bwn-rem';
      var releaseA11y = null;   // Tab-trap + focus-restore via the shared core (parity with Ops/AI dialogs)
      function close() { document.removeEventListener('keydown', onKey); if (releaseA11y) { releaseA11y(); releaseA11y = null; } ov.remove(); }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

      var hd = document.createElement('div'); hd.className = 'bwn-rem-hd'; hd.textContent = 'Follow-up reminders';
      card.appendChild(hd);
      var body = document.createElement('div'); body.className = 'bwn-rem-body';
      var pend = document.createElement('div'); pend.className = 'bwn-rem-pend';

      function flash(btn) { var t = btn.textContent; btn.textContent = 'Added ✓'; setTimeout(function () { btn.textContent = t; }, 900); }
      function renderPending() {
        pend.textContent = '';
        var arr = load().filter(function (r) { return !r.fired; }).sort(function (a, b) { return a.fireAt - b.fireAt; });
        var h = document.createElement('div'); h.className = 'bwn-rem-pend-h';
        h.textContent = arr.length ? 'Pending (' + arr.length + ')' : 'No pending reminders'; pend.appendChild(h);
        arr.forEach(function (r) {
          var rr = document.createElement('div'); rr.className = 'bwn-rem-row';
          var tx = document.createElement('span'); tx.className = 'tx';
          tx.textContent = fmtWhen(r.fireAt) + ' · ' + (r.tracking ? '#' + r.tracking : 'WO') + (r.client ? ' · ' + r.client : '') + (r.note ? ' - ' + r.note : '');
          rr.appendChild(tx);
          if (r.url) { var go = document.createElement('button'); go.type = 'button'; go.textContent = 'Go'; go.addEventListener('click', function () { location.href = r.url; }); rr.appendChild(go); }
          var xb = document.createElement('button'); xb.type = 'button'; xb.textContent = '✕'; xb.title = 'Cancel'; xb.addEventListener('click', function () { cancelReminder(r.id); renderPending(); }); rr.appendChild(xb);
          pend.appendChild(rr);
        });
      }

      if (onWO()) {
        var b = BWN.busGet(currentWOId()) || {};
        var ctxLine = document.createElement('div'); ctxLine.className = 'bwn-rem-ctx';
        ctxLine.textContent = 'This WO: ' + (b.tracking ? '#' + b.tracking : (b.wo || currentWOId())) + (b.client ? ' · ' + b.client : '');
        body.appendChild(ctxLine);
        var noteIn = document.createElement('input'); noteIn.type = 'text'; noteIn.className = 'bwn-rem-note'; noteIn.placeholder = 'Optional note - what to chase';
        body.appendChild(noteIn);
        var row = document.createElement('div'); row.className = 'bwn-rem-presets';
        function preset(label, when) {
          var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label;
          btn.addEventListener('click', function () { if (addReminder(when(), noteIn.value.trim())) { renderPending(); flash(btn); } });
          row.appendChild(btn);
        }
        preset('in 1 hour', function () { return Date.now() + 3600000; });
        preset('in 3 hours', function () { return Date.now() + 3 * 3600000; });
        preset('tomorrow 8am', function () { var d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); });
        body.appendChild(row);
        var customRow = document.createElement('div'); customRow.className = 'bwn-rem-custom';
        var dt = document.createElement('input'); dt.type = 'datetime-local';
        var def = new Date(Date.now() + 3600000);
        dt.value = def.getFullYear() + '-' + pad(def.getMonth() + 1) + '-' + pad(def.getDate()) + 'T' + pad(def.getHours()) + ':' + pad(def.getMinutes());
        var setB = document.createElement('button'); setB.type = 'button'; setB.className = 'pri'; setB.textContent = 'Set';
        setB.addEventListener('click', function () { var ts = dt.value ? new Date(dt.value).getTime() : NaN; if (addReminder(ts, noteIn.value.trim())) { renderPending(); flash(setB); } });
        customRow.appendChild(dt); customRow.appendChild(setB);
        body.appendChild(customRow);
      } else {
        var msg = document.createElement('div'); msg.className = 'bwn-rem-ctx';
        msg.textContent = 'Open a work order to set a reminder for it. Pending reminders are below.';
        body.appendChild(msg);
      }

      body.appendChild(pend);
      renderPending();
      card.appendChild(body);

      var ft = document.createElement('div'); ft.className = 'bwn-rem-ft';
      var perm = document.createElement('span'); perm.className = 'sp';
      perm.textContent = (window.Notification && Notification.permission === 'denied') ? 'Notifications blocked - reminders show as an in-page banner instead.' :
        (window.Notification && Notification.permission === 'granted') ? '' : 'First reminder will ask to allow notifications.';
      ft.appendChild(perm);
      var closeB = document.createElement('button'); closeB.type = 'button'; closeB.textContent = 'Close'; closeB.addEventListener('click', close);
      ft.appendChild(closeB); card.appendChild(ft);

      ov.appendChild(card); document.body.appendChild(ov);
      document.addEventListener('keydown', onKey);
      releaseA11y = BWN.a11yDialog(card, { label: 'Follow-up reminders', modal: true });
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style'); st.id = STYLE_ID;
      st.textContent =
        '#bwn-rem-overlay{position:fixed;inset:0;z-index:100000;background:rgba(13,38,26,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-rem{width:520px;max-width:94vw;max-height:88vh;display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:16px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.35);}' +
        '.bwn-rem-hd{background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:14px 18px;font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-rem-body{flex:1;overflow:auto;padding:14px 16px;}' +
        '.bwn-rem-ctx{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-bottom:10px;}' +
        '.bwn-rem-note{width:100%;box-sizing:border-box;border:1px solid var(--bwn-border);border-radius:8px;padding:8px 10px;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);background:var(--bwn-surface);margin-bottom:10px;}' +
        '.bwn-rem-presets{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;}' +
        '.bwn-rem-custom{display:flex;gap:8px;align-items:center;margin-bottom:6px;}' +
        '.bwn-rem-custom input{flex:1;border:1px solid var(--bwn-border);border-radius:8px;padding:7px 9px;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);background:var(--bwn-surface);}' +
        '.bwn-rem button{border:1px solid var(--bwn-border);background:var(--bwn-surface-2);color:var(--bwn-text);border-radius:8px;padding:6px 12px;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;}' +
        '.bwn-rem button.pri{background:var(--bwn-green);border-color:var(--bwn-green);color:#fff;}' +
        '.bwn-rem-pend{margin-top:8px;border-top:1px solid var(--bwn-border-2);padding-top:8px;}' +
        '.bwn-rem-pend-h{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;text-transform:none;letter-spacing:normal;color:var(--bwn-text-faint);margin-bottom:6px;}' +
        '.bwn-rem-row{display:flex;align-items:center;gap:8px;padding:5px 0;}' +
        '.bwn-rem-row .tx{flex:1;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text);}' +
        '.bwn-rem-ft{display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-rem-ft .sp{margin-right:auto;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-rem-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:100003;display:flex;align-items:center;gap:10px;max-width:90vw;background:var(--bwn-green-dk);color:#fff;border-radius:10px;padding:10px 14px;box-shadow:0 12px 40px rgba(0,0,0,.4);font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-rem-toast button{border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:7px;padding:4px 10px;font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;}';
      document.head.appendChild(st);
    }

    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail; if (d && d.id === 'core:remind') openDialog();
    }, 'reminders:cmd'));

    fireDue();
    setInterval(BWN.guard(fireDue, 'reminders:tick'), 30000);
    BWN.beat('reminders', 'ok', 'ticker armed');
  });


  // ==========================================================================
  // MODULE: Notes Timeline v1.1 - compact chronological read of a WO's notes
  // ==========================================================================
  // A read-only OVERLAY (never a re-render of Umbrava's virtualized list - that
  // would fight React) laying the notes out newest-first with day headers and
  // "- N days quiet -" gap markers, so the shape of an aged WO's conversation is
  // visible at a glance. Sources the shared note cache (populated by a Deep Scan
  // / AI draft) for full history, merged with whatever is mounted now. Opened
  // from the Tools menu / palette.
  bwnBoot('notesTimeline', BWN_MODULES.notesTimeline, function () {
    'use strict';
    var currentWOId = BWN.woId;
    function onWO() { return /\/work-orders\//.test(location.pathname); }
    var OV_ID = 'bwn-tl-overlay';
    var STYLE_ID = 'bwn-tl-style';
    var GAP_DAYS = 5;   // fixed "quiet stretch" threshold
    var activeClose = null;   // teardown of the currently-open overlay (re-open safety)

    var WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function dayHeader(d) { return WD[d.getDay()] + ' · ' + MO[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
    function timeStr(d) { var h = d.getHours(), ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12; return h12 + ':' + pad(d.getMinutes()) + ' ' + ap; }
    function dayKeyOf(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
    function midnight(ms) { var x = new Date(ms); return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); }
    function absOf(ts) { var d = ts ? BWN.parseNoteDateLoose(ts) : null; return d ? +d : null; }

    // Merge the shared note cache (full history, if a Deep Scan ran) with the notes
    // mounted right now. Date precedence (review M1): a mounted note's LIVE ts always
    // wins - a cached relative string ("2 hours ago") was frozen at scan time and
    // drifts if re-parsed now. Cache-only notes prefer the frozen absolute `tsAbs`
    // the producer now stores, falling back to parsing the (possibly relative) string.
    function collectNotes() {
      var woId = currentWOId(), map = {}, cacheUsed = false;
      var c = woId ? BWN.ssGetJSON('bwn:notes:' + woId, null) : null;
      if (c && Array.isArray(c.notes)) {
        c.notes.forEach(function (n) {
          if (n && n.id) map[n.id] = { id: n.id, label: n.label || '', ts: n.ts || '', abs: (typeof n.tsAbs === 'number' ? n.tsAbs : null), body: n.body || '' };
        });
        cacheUsed = c.notes.length > 0;
      }
      document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]').forEach(function (sm) {
        var m = (sm.getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/); if (!m) return;
        var id = m[1], bodyEl = document.querySelector('[data-testid="wo-note-' + id + '-description"]');
        var body = bodyEl ? (bodyEl.textContent || '').trim() : '';
        var meta = { label: '', ts: '' }; try { meta = BWN.noteMeta(BWN.noteCard(sm)); } catch (e) { }
        var ex = map[id] || { id: id, label: '', ts: '', abs: null, body: '' };
        if (meta.label) ex.label = meta.label;
        if (meta.ts) { ex.ts = meta.ts; ex.abs = absOf(meta.ts); }   // live parse = correct for a mounted note
        if (body) ex.body = body;                                    // reflect edits
        map[id] = ex;
      });
      var arr = [];
      Object.keys(map).forEach(function (k) {
        var n = map[k];
        var t = (typeof n.abs === 'number' && isFinite(n.abs)) ? n.abs : absOf(n.ts);
        arr.push({ n: n, date: (t != null) ? new Date(t) : null });
      });
      arr.sort(function (a, b) { if (!a.date && !b.date) return 0; if (!a.date) return 1; if (!b.date) return -1; return (+b.date) - (+a.date); });
      return { rows: arr, cacheUsed: cacheUsed };
    }

    function openTimeline() {
      if (!onWO() || !currentWOId()) { alert('Open a work order to see its notes timeline.'); return; }
      ensureStyle();
      if (activeClose) { try { activeClose(); } catch (e) { } }   // tear down a prior overlay (listener + a11y trap) before rebuilding
      var res = collectNotes();
      var old = document.getElementById(OV_ID); if (old) old.remove();
      var ov = document.createElement('div'); ov.id = OV_ID;
      var card = document.createElement('div'); card.className = 'bwn-tl';
      var releaseA11y = null;
      function close() { document.removeEventListener('keydown', onKey); if (releaseA11y) { releaseA11y(); releaseA11y = null; } activeClose = null; ov.remove(); }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

      var b = BWN.busGet(currentWOId()) || {};
      var hd = document.createElement('div'); hd.className = 'bwn-tl-hd';
      var t = document.createElement('div'); t.className = 'tl-t';
      t.textContent = 'Notes timeline' + (b.tracking ? ' · #' + b.tracking : '') + ' · ' + res.rows.length + ' note' + (res.rows.length === 1 ? '' : 's');
      var s = document.createElement('div'); s.className = 'tl-s';
      s.textContent = res.cacheUsed ? 'from the last Deep Scan · live notes merged' : 'mounted notes only - run WO Assist → Deep Scan, then reopen for full history';
      hd.appendChild(t); hd.appendChild(s); card.appendChild(hd);

      var bd = document.createElement('div'); bd.className = 'bwn-tl-body';
      if (!res.rows.length) {
        var em = document.createElement('div'); em.className = 'bwn-tl-empty'; em.textContent = 'No notes found for this WO.'; bd.appendChild(em);
      } else {
        var prevT = null, prevDay = null;
        res.rows.forEach(function (item) {
          var d = item.date;
          if (d) {
            if (prevT != null) { var gap = Math.round((midnight(prevT) - midnight(+d)) / 86400000); if (gap >= GAP_DAYS) { var g = document.createElement('div'); g.className = 'bwn-tl-gap'; g.textContent = '- ' + gap + ' days quiet -'; bd.appendChild(g); } }
            var dk = dayKeyOf(d);
            if (dk !== prevDay) { var dh = document.createElement('div'); dh.className = 'bwn-tl-day'; dh.textContent = dayHeader(d); bd.appendChild(dh); prevDay = dk; }
            prevT = +d;
          } else if (prevDay !== 'UNDATED') { var uh = document.createElement('div'); uh.className = 'bwn-tl-day'; uh.textContent = 'Undated'; bd.appendChild(uh); prevDay = 'UNDATED'; }
          var row = document.createElement('div'); row.className = 'bwn-tl-row';
          var meta = document.createElement('div'); meta.className = 'tl-meta';
          if (d) { var tm = document.createElement('span'); tm.className = 'tl-time'; tm.textContent = timeStr(d); meta.appendChild(tm); }
          if (item.n.label) { var lb = document.createElement('span'); lb.className = 'tl-label'; lb.textContent = item.n.label; meta.appendChild(lb); }
          row.appendChild(meta);
          var body = document.createElement('div'); body.className = 'tl-body';
          var snip = (item.n.body || '').replace(/\s+/g, ' ').trim();
          body.textContent = snip ? (snip.length > 200 ? snip.slice(0, 200) + '…' : snip) : '(no text)';
          row.appendChild(body);
          bd.appendChild(row);
        });
      }
      card.appendChild(bd);

      var ft = document.createElement('div'); ft.className = 'bwn-tl-ft';
      var sp = document.createElement('span'); sp.className = 'sp'; sp.textContent = 'quiet stretches ≥ ' + GAP_DAYS + ' days are flagged'; ft.appendChild(sp);
      var cl = document.createElement('button'); cl.type = 'button'; cl.textContent = 'Close'; cl.addEventListener('click', close); ft.appendChild(cl);
      card.appendChild(ft);

      ov.appendChild(card); document.body.appendChild(ov);
      document.addEventListener('keydown', onKey);
      releaseA11y = BWN.a11yDialog(card, { label: 'Notes timeline', modal: true });
      activeClose = close;
    }

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style'); st.id = STYLE_ID;
      st.textContent =
        '#bwn-tl-overlay{position:fixed;inset:0;z-index:100000;background:rgba(13,38,26,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-tl{width:640px;max-width:94vw;max-height:88vh;display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:16px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.35);}' +
        '.bwn-tl-hd{background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:14px 18px;}' +
        '.bwn-tl-hd .tl-t{font:600 15px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-tl-hd .tl-s{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.72);margin-top:3px;}' +
        '.bwn-tl-body{flex:1;overflow:auto;padding:10px 16px;}' +
        '.bwn-tl-day{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;text-transform:none;letter-spacing:normal;color:var(--bwn-green);margin:12px 0 6px;padding-bottom:3px;border-bottom:1px solid var(--bwn-border-2);}' +
        '.bwn-tl-gap{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-warn);text-align:center;margin:8px 0;}' +
        '.bwn-tl-row{padding:6px 0 8px;border-bottom:1px solid var(--bwn-surface-3);}' +
        '.bwn-tl-row .tl-meta{display:flex;gap:8px;align-items:center;margin-bottom:2px;}' +
        '.bwn-tl-row .tl-time{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-tl-row .tl-label{font:500 9px ui-monospace,"Segoe UI Mono","SF Mono",monospace;text-transform:none;letter-spacing:normal;color:var(--bwn-green);background:var(--bwn-tint);border-radius:10px;padding:1px 7px;}' +
        '.bwn-tl-row .tl-body{font:500 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);line-height:1.5;}' +
        '.bwn-tl-empty{padding:16px;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-tl-ft{display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-tl-ft .sp{margin-right:auto;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-tl-ft button{border:1px solid var(--bwn-border);background:var(--bwn-surface-2);color:var(--bwn-text);border-radius:8px;padding:7px 16px;font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;}';
      document.head.appendChild(st);
    }

    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail; if (d && d.id === 'core:notestimeline') openTimeline();
    }, 'notesTimeline:cmd'));
    BWN.beat('notesTimeline', 'ok', 'ready');
  });


  // ==========================================================================
  // MODULE: Trip Calendar v1.4 - export a WO's scheduled trips to .ics
  // ==========================================================================
  // On the WO Trips tab, a button anchored into Umbrava's own "Schedule Trip"
  // split-button group (v1.4; it used to float bottom-right, underneath the help
  // bubble) downloads the UPCOMING (non-completed,
  // non-cancelled) trips as an .ics file - one VEVENT per trip - so coordinators
  // can drop them straight onto Outlook. Pure client-side Blob download (zero
  // egress). Also caches the latest scheduled trip date to the bus (bwn:trips:{id})
  // so the ECD helper on the details tab can use it as a completion signal.
  // Field extraction is per-SPAN (Umbrava concatenates trip fields with no
  // separators, so regex-on-joined-text fails - recon-verified WO 339766/trips).
  bwnBoot('tripCal', BWN_MODULES.tripCal, function () {
    'use strict';
    var currentWOId = BWN.woId;
    var BTN_ID = 'bwn-tripcal-btn';
    function onTrips() { return /\/work-orders\/\d+\/trips/.test(location.pathname); }
    var DATE_RE = /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}\s*(AM|PM)$/;
    var STATUS_RE = /^(Scheduled|Completed|Cancelled|Canceled|In Progress|En\s?Route|Dispatched|Pending)$/;

    function parseTrips() {
      var cards = document.querySelectorAll('[data-testid="purchase-order-trip-card"]'), out = [];
      Array.prototype.forEach.call(cards, function (c) {
        var leaves = [];
        c.querySelectorAll('*').forEach(function (el) { if (el.children.length === 0) { var tx = (el.textContent || '').trim(); if (tx) leaves.push(tx); } });
        var when = null, dur = null, status = '', trip = '', vendor = '';
        for (var i = 0; i < leaves.length; i++) {
          var t = leaves[i];
          if (!when && DATE_RE.test(t)) when = t.replace(/,(\s+\d{1,2}:\d{2})/, '$1');   // "Jul 7, 2026, 4:15 PM" → "Jul 7, 2026 4:15 PM" (Date-parseable)
          else if (!dur && /^\d+h(\s*\d+m)?$/.test(t)) dur = t;
          else if (!status && STATUS_RE.test(t)) status = t;
          else if (!trip && /^Trip #\s*\d+$/.test(t)) trip = (t.match(/\d+/) || [''])[0];
        }
        for (var j = 0; j < leaves.length; j++) { var s = leaves[j], up = s.replace(/[^A-Za-z]/g, ''); if (up.length >= 6 && up === up.toUpperCase()) { vendor = s; break; } }
        var d = when ? new Date(when) : null;
        if (!d || isNaN(d.getTime())) return;
        var mins = 60, dm = dur && dur.match(/(\d+)h(?:\s*(\d+)m)?/);
        if (dm) mins = parseInt(dm[1], 10) * 60 + (dm[2] ? parseInt(dm[2], 10) : 0);
        else if (dur && /^(\d+)m$/.test(dur)) mins = parseInt(dur, 10);
        out.push({ start: d, mins: mins, status: status, trip: trip, vendor: vendor });
      });
      return out;
    }

    // "Live" trips worth mirroring to a calendar: not completed, not cancelled.
    function exportable(trips) { return trips.filter(function (t) { return !/complete|cancel/i.test(t.status); }); }

    function ecdTodayMs() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    var lastPub = '';
    function publishTripSignal(trips) {
      var wo = currentWOId(); if (!wo) return;
      var today = ecdTodayMs(), latest = null, noShow = null;
      trips.forEach(function (t) {
        var ms = +t.start;
        if (!/complete|cancel/i.test(t.status)) { if (ms >= today && (latest === null || ms > latest)) latest = ms; }
        // No-show: a still-"Scheduled" trip whose date is before TODAY (day boundary - a
        // same-day afternoon visit is not flagged prematurely), not completed/canceled.
        // Keep the OLDEST such. Feeds a WO Assist action the PO-schedDate stall can't see.
        if (t.vendor && /scheduled/i.test(t.status) && !/complete|cancel/i.test(t.status) && ms < today && (!noShow || ms < noShow.ms)) noShow = { ms: ms, vendor: t.vendor, trip: t.trip };
      });
      var sig = wo + ':' + latest + ':' + (noShow ? noShow.ms + '/' + noShow.trip : '');
      if (sig === lastPub) return;   // no change → skip the write (avoids churn every observer tick)
      lastPub = sig;
      var payload = { v: 1, ts: Date.now(), latestScheduled: latest };
      if (noShow) payload.noShow = noShow;
      try { BWN.ssSetJSON('bwn:trips:' + wo, payload); } catch (e) { }
    }

    function woMeta() {
      function txt(id) { var el = document.querySelector('[data-testid="' + id + '"]'); return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
      var a = document.querySelector('a[href*="/clients/"]');
      return {
        tracking: txt('work-order-header-tracking-number').replace(/\D+/g, ''),
        client: a ? (a.textContent || '').replace(/\s+/g, ' ').trim() : '',
        url: location.origin + '/work-orders/' + (currentWOId() || '')
      };
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function icsUTC(d) { return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z'; }
    function icsEsc(s) { return String(s || '').replace(/([\\,;])/g, '\\$1').replace(/\r?\n/g, '\\n'); }
    function buildICS(trips, meta) {
      var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BWN Suite//Trips//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
      var stamp = icsUTC(new Date());
      trips.forEach(function (t) {
        var end = new Date(t.start.getTime() + t.mins * 60000);
        var summary = 'WO' + (meta.tracking ? ' #' + meta.tracking : '') + (meta.client ? ' · ' + meta.client : '') + (t.trip ? ' · Trip ' + t.trip : '');
        var desc = [];
        if (t.vendor) desc.push('Vendor: ' + t.vendor);
        if (t.status) desc.push('Status: ' + t.status);
        if (meta.url) desc.push('Work order: ' + meta.url);
        L.push('BEGIN:VEVENT', 'UID:bwn-trip-' + (meta.tracking || 'wo') + '-' + (t.trip || icsUTC(t.start)) + '@umbrava',
          'DTSTAMP:' + stamp, 'DTSTART:' + icsUTC(t.start), 'DTEND:' + icsUTC(end),
          'SUMMARY:' + icsEsc(summary), 'DESCRIPTION:' + icsEsc(desc.join('\n')));
        if (t.vendor) L.push('LOCATION:' + icsEsc(t.vendor));
        L.push('STATUS:CONFIRMED', 'END:VEVENT');
      });
      L.push('END:VCALENDAR');
      return L.join('\r\n');
    }
    function download(text, fn) {
      try {
        var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = fn; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      } catch (e) { alert('Could not generate the .ics file.'); }
    }

    function ensureStyle() {
      if (document.getElementById('bwn-tc-style')) return;
      var st = document.createElement('style'); st.id = 'bwn-tc-style';
      st.textContent =
        // Inline (anchored) is the DEFAULT shape: a 32px pill sized to sit inside Umbrava's
        // split-button group, so it reads as one row with "Schedule Trip".
        // `position:static` is declared, not left to default: a stale cached copy of the pre-1.4
        // stylesheet (which set position:fixed on this same id) would otherwise still win, and the
        // button would sit bottom-right while LOOKING correctly anchored in the DOM tree.
        // `gap` replaces the label span's trailing space: as flex items the two spans collapse
        // it, and the count read as "calendar(2)".
        '#bwn-tripcal-btn{position:static;display:inline-flex;align-items:center;gap:5px;height:32px;padding:0 12px;margin-right:8px;border:none;border-radius:6px;background:' + BWN.GREEN + ';color:#fff;font:500 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;cursor:pointer;white-space:nowrap;vertical-align:middle;}' +
        // Fallback shape only. bottom is 78px, NOT 18px: Umbrava's Zendesk help-widget launcher
        // iframe occupies bottom 15px..71px of the right edge (measured 2026-08-04), so the old
        // pill sat fully behind it and read as a missing button. 78px clears its top edge by 7px.
        '#bwn-tripcal-btn[data-bwn-float="1"]{position:fixed;right:18px;bottom:78px;z-index:99997;height:auto;margin-right:0;border-radius:11px;padding:10px 15px;box-shadow:0 8px 26px rgba(0,0,0,.3);}' +
        '#bwn-tripcal-btn:disabled{opacity:.55;cursor:default;}' +
        '#bwn-tripcal-btn .bwn-tc-n{font-family:ui-monospace,"Segoe UI Mono","SF Mono",monospace;}';
      document.head.appendChild(st);
    }

    // The Trips tab's split-button group ("Schedule Trip") - the SAME MuiButtonGroup the AI
    // script's AI Draft bar injects into on the Notes tab, which is why anchoring here puts the
    // export button immediately left of it. Measured live on /work-orders/380320/trips
    // (2026-08-04): wrapper > div > .MuiButtonGroup-root > [trips-split-left|right-button], and
    // the AI Draft bar survives the tab switch as that group's first child.
    function tripsAnchor() { return document.querySelector('[data-testid="trips-split-left-button"]'); }

    // Anchor if we can, float if we cannot, and UPGRADE a floating button the moment the anchor
    // shows up. Every DOM write here is guarded by a position check - an unconditional
    // insertBefore is a mutation that re-fires our own observer forever.
    function placeBtn(btn) {
      var a = tripsAnchor();
      if (a && a.parentNode) {
        if (btn.parentNode !== a.parentNode || btn.nextSibling !== a) a.parentNode.insertBefore(btn, a);
        if (btn.dataset.bwnFloat === '1') {
          delete btn.dataset.bwnFloat;
          BWN.beat('tripCal', 'ok', 'floating fallback re-anchored to the Trips split-button group');
        }
        return;
      }
      if (btn.dataset.bwnFloat !== '1') {
        btn.dataset.bwnFloat = '1';
        document.body.appendChild(btn);
        BWN.beat('tripCal', 'miss', 'Trips split-button anchor absent - floating fallback');
      } else if (btn.parentNode !== document.body) document.body.appendChild(btn);
    }

    function ensureBtn() {
      var ex = document.getElementById(BTN_ID);
      if (!onTrips()) { if (ex) ex.remove(); return; }
      var cards = document.querySelectorAll('[data-testid="purchase-order-trip-card"]');
      if (!cards.length) { if (ex) ex.remove(); return; }
      var trips = parseTrips();
      publishTripSignal(trips);
      var exp = exportable(trips);
      ensureStyle();
      var btn = ex;
      if (!btn) {
        btn = document.createElement('button'); btn.id = BTN_ID; btn.type = 'button';
        var lbl = document.createElement('span'); lbl.textContent = '📅 Trips → calendar ';
        var n = document.createElement('span'); n.className = 'bwn-tc-n';
        btn.appendChild(lbl); btn.appendChild(n);
        btn.addEventListener('click', function () {
          var t2 = exportable(parseTrips());
          if (!t2.length) { alert('No upcoming trips to export (completed and cancelled trips are skipped).'); return; }
          var meta = woMeta();
          download(buildICS(t2, meta), 'WO-' + (meta.tracking || currentWOId() || 'trips') + '-trips.ics');
        });
        placeBtn(btn);
        BWN.beat('tripCal', 'ok', 'export button mounted');
      } else placeBtn(btn);   // React re-renders the split group on a tab switch, and a fallback must upgrade
      // Write only on CHANGE - a blind textContent write is a DOM mutation that
      // re-fires our own observer, an endless 500ms parse/write tick (review).
      var nTxt = '(' + exp.length + ')', nEl = btn.querySelector('.bwn-tc-n');
      if (nEl.textContent !== nTxt) nEl.textContent = nTxt;
      if (btn.disabled !== !exp.length) btn.disabled = !exp.length;
      var tt = exp.length ? 'Download ' + exp.length + ' upcoming trip' + (exp.length === 1 ? '' : 's') + ' as .ics for Outlook' : 'No upcoming trips (completed/cancelled skipped)';
      if (btn.title !== tt) btn.title = tt;
    }

    var deb = null;
    var obs = new MutationObserver(BWN.guard(function () { clearTimeout(deb); deb = setTimeout(BWN.guard(ensureBtn, 'tripCal:btn'), 500); }, 'tripCal:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    ensureBtn();
  });

  // The two pasted blocks below run at Core's TOP LEVEL, not inside a bwnBoot module, because
  // they must define their globals before any module asks for them. That places them outside
  // BWN.safeModule's net: a load-time throw in either one would take down PO Approval, WO Assist,
  // List Heat, the launcher and everything else on the page, for a feature that is read-only and
  // optional. This try/catch is that net. It sits OUTSIDE the sentinels on purpose - the bytes
  // between them are paste-identical with the other repo and scripts/test-domproj-parity.js
  // asserts it, so nothing inside may be touched, including to add a guard.
  try {

/* BWN-DOM:START | DOM handle protocol L0, PASTE-IDENTICAL with bwn-domproj.js in broadway-internal-ops.
   Column 0 and unindented on purpose: scripts/test-domproj-parity.js asserts these bytes against that
   repo, and re-indenting to match Core would break the check that keeps the two copies honest. Edit the
   source there, run node sync-theme.js, then re-paste - never edit this region. */
/* bwn-domproj.js -- DOM handle protocol, layer L0: the pure projector.
 *
 * SINGLE SOURCE OF TRUTH for everything between "node records" (plain objects the L1 collector
 * reads out of a live DOM) and the compact payload a text-only model acts on: inclusion rules,
 * accessible names, handle minting, ordering, masking, truncation, revisions, and deltas.
 * Spec: outputs/specs/2026-08-08-dom-handle-protocol-architecture.md in the vault.
 *
 * PURE ON PURPOSE. This file never touches a DOM API, never reads a clock, never draws a random
 * number. Everything a browser must answer (visibility, geometry, labels) arrives already
 * answered inside the node records, because there is no jsdom on this machine and a hand-written
 * DOM shim cannot compute layout - the [hidden]-vs-class-display bug shipped through 130 green
 * headless tests exactly that way. Purity is what makes every rule below unit-testable with
 * plain fixtures on the bundled node.
 *
 * Loaded the same three ways as watchtower-rules.js:
 *   1. scripts/test-domproj.js and scripts/bench-domproj.js  ->  require() the real file
 *   2. SWA tool pages, inlined by sync-theme.js into a BWN-DOM sentinel region (phase 3)
 *   3. bwn-suite-core.user.js, as a paste-identical block (phase 3/4)
 *
 * NODE RECORD CONTRACT (what L1 must supply; L0 treats absent fields as empty):
 *   tag, type, role, ariaLabel, labelText, placeholder, title, text, value, name, id, testid,
 *   href, external, download, autocomplete,
 *   disabled, checked, required, expanded, msgType ('error'|'status'|'alert'),
 *   visible, interactable   (COMPUTED by the browser - checkVisibility + elementFromPoint),
 *   rect {x,y,w,h}, domIndex (unique, document order), groupPath [landmark, section, ...],
 *   options [{value,label}] (selects), table {rows, cols, headers[]} (tables), level (headings)
 */
(function (root) {
  "use strict";

  var DP = { VERSION: "0.1.0" };

  /* ============================ vocabulary ============================ */

  // Handle kind letters. One letter per kind so a handle stays 3-4 chars.
  DP.KINDS = {
    a: "link", b: "button", i: "textbox", s: "select", c: "checkable",
    d: "dialog", t: "table", h: "heading", m: "message",
  };

  // Emitted roles per kind (what the model reads). checkable emits its concrete role.
  var EMIT_ROLE = { a: "link", b: "button", i: "textbox", s: "select", d: "dialog", t: "table", h: "heading" };

  DP.ERROR = {
    STALE: "HANDLE_STALE",
    AMBIGUOUS: "HANDLE_AMBIGUOUS",
  };

  /* ============================ small helpers ============================ */

  function str(v) { return (v == null) ? "" : String(v); }
  function trimText(v, max) {
    var out = str(v).replace(/\s+/g, " ").trim();
    if (max && out.length > max) out = out.slice(0, max);
    return out;
  }

  // Deterministic JSON: keys sorted at every level. This is the hashing form AND the byte form
  // the determinism tests compare, so "same content" always means "same bytes".
  function stableStringify(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(stableStringify(v[i] === undefined ? null : v[i]));
      return "[" + parts.join(",") + "]";
    }
    var keys = Object.keys(v).sort();
    var kv = [];
    for (var k = 0; k < keys.length; k++) {
      if (v[keys[k]] === undefined) continue;
      kv.push(JSON.stringify(keys[k]) + ":" + stableStringify(v[keys[k]]));
    }
    return "{" + kv.join(",") + "}";
  }
  DP.stableStringify = stableStringify;

  // FNV-1a 32-bit. Not cryptographic and does not need to be: it detects "did the projected
  // content change between rounds", nothing adversarial rides on it.
  function fnv1a(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  DP.hash = function (payload) { return fnv1a(stableStringify(payload)); };

  // chars/4 is an ESTIMATE and is labelled as one everywhere it surfaces. The real numbers are
  // the `usage` fields api/ai now forwards; this exists only for offline benchmarks.
  DP.estimateTokens = function (chars) { return Math.ceil(Math.max(0, chars | 0) / 4); };

  /* ============================ accessible name ============================ */

  // A documented, constrained SUBSET of the accname algorithm - not the spec algorithm, and the
  // README says so. Order: aria-labelledby (L1 resolves it into ariaLabel), aria-label, bound
  // <label>, placeholder, title, trimmed text content. Claiming full accname compliance we have
  // not implemented is how a projection quietly disagrees with what the operator sees.
  DP.accName = function (rec) {
    return trimText(rec.ariaLabel, 120) || trimText(rec.labelText, 120)
      || trimText(rec.placeholder, 120) || trimText(rec.title, 120)
      || trimText(rec.text, 120);
  };

  /* ============================ kind classification ============================ */

  var INPUT_TEXT_TYPES = { text: 1, search: 1, email: 1, tel: 1, url: 1, number: 1, password: 1, date: 1, time: 1, "datetime-local": 1, month: 1, week: 1, "": 1 };

  DP.kindOf = function (rec) {
    var tag = str(rec.tag).toLowerCase();
    var role = str(rec.role).toLowerCase();
    var type = str(rec.type).toLowerCase();
    if (rec.msgType || role === "alert" || role === "status") return "m";
    if (role === "dialog" || role === "alertdialog") return "d";
    if (tag === "table" || role === "table" || role === "grid") return "t";
    if (tag === "h1" || tag === "h2" || tag === "h3" || (role === "heading" && (rec.level == null || rec.level <= 3))) return "h";
    if (tag === "select" || role === "listbox" || role === "combobox") return "s";
    if (role === "checkbox" || role === "radio" || role === "switch") return "c";
    if (tag === "input" && (type === "checkbox" || type === "radio")) return "c";
    if (role === "button") return "b";
    if (tag === "button") return "b";
    if (tag === "input" && (type === "button" || type === "submit" || type === "reset")) return "b";
    if (tag === "input" && type === "file") return "b";     // acted on like a button; policy denies it
    if (role === "link") return "a";
    if (tag === "a" && (rec.href != null && rec.href !== "")) return "a";
    if (tag === "textarea" || role === "textbox" || role === "searchbox" || role === "spinbutton") return "i";
    if (tag === "input" && INPUT_TEXT_TYPES[type] === 1) return "i";
    return null;                                            // everything else never projects
  };

  // Which kinds require interactability vs mere visibility. `disabled` is deliberately NOT an
  // exclusion: a disabled Save button is exactly the state a model must see (and the delta's
  // {enabled:false} could not exist if disabling removed the element). Interactability excludes
  // the OTHER cases - obscured, pointer-events:none, inert subtree - which L1 folds into
  // rec.interactable.
  var ACTIONABLE = { a: 1, b: 1, i: 1, s: 1, c: 1 };
  DP.includeRec = function (rec, opts) {
    var kind = DP.kindOf(rec);
    if (!kind) return false;
    if (!rec.visible) return false;
    if (ACTIONABLE[kind] === 1 && !rec.interactable && !rec.disabled && !(opts && opts.includeInert)) return false;
    return true;
  };

  /* ============================ policy classification ============================ */

  // Classified at PROJECTION time so the model is told up front which handles will demand a
  // human confirm and which are refused outright - it must not plan a route through a denied
  // handle. Enforcement is L4's job, in Core, outside the model's reach; this is the label.
  // Matched against a NORMALIZED haystack (camelCase split, _/- to space, lowercased), because
  // the real spellings of a card field are `cardNumber`, `card_number` and `cardnumber` far more
  // often than `card number`. A bare `card\b` alternative matched none of those three: `_` and
  // letters are word characters, so the trailing boundary never landed. Each keyword therefore
  // carries its own optional num/no tail rather than relying on a separator being present.
  var SENSITIVE_RE = /\b(card(?:num(?:ber)?|no)?|cc(?:num(?:ber)?|no)?|cvv|cvc|routing|account(?:num(?:ber)?|no)?|ssn|social security|tin|tax id|passport|iban|sort code)\b/;
  var DESTRUCTIVE_RE = /\b(delete|remove|void|cancel|submit|approve|dispatch|send|pay|reject|close)\b/i;

  function normalizeHay(parts) {
    return parts.map(str).join(" ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")     // cardNumber -> card Number
      .replace(/[_\-]+/g, " ")                    // card_number / card-number -> card number
      .toLowerCase();
  }

  // Any run of 4+ digits, separators allowed inside. Used to strip a secret that arrived in the
  // LABEL rather than the value ("SSN 123-45-6789"), which masking the value alone left exposed.
  var DIGIT_RUN_RE = /[0-9](?:[0-9 \-\/.]*[0-9]){3,}/g;
  DP.redactDigits = function (s) { return str(s).replace(DIGIT_RUN_RE, "[redacted]"); };

  DP.policyOf = function (rec) {
    var kind = DP.kindOf(rec);
    var type = str(rec.type).toLowerCase();
    if (type === "password" || type === "file") return "deny";
    if (rec.download || rec.external) return "deny";
    // placeholder/title/text are IN the haystack because accName already treats them as label
    // sources: a field the model is shown as "Card number" must not be classified allow just
    // because that string arrived via placeholder instead of labelText.
    if (SENSITIVE_RE.test(normalizeHay([rec.name, rec.id, rec.autocomplete, rec.labelText, rec.ariaLabel, rec.placeholder, rec.title, rec.text]))) return "deny";
    if ((kind === "b" || kind === "a") && DESTRUCTIVE_RE.test(DP.accName(rec))) return "confirm";
    return "allow";
  };

  /* ============================ fingerprint - ONE producer ============================ */

  // The stable identity a handle is minted from and re-resolved against. There is exactly one
  // function computing it, called by minting and by resolution alike: two writers computing a
  // key from the same input and drifting is how a 217-row board opened at 221 rows.
  //
  // Locator ladder: data-testid, then a non-volatile id, then role + accessible name + name
  // attribute + group path. Checkables add their value (a radio group shares everything else).
  // Volatile ids (React useId ':r1:', uuids, long digit runs) are skipped so a re-render that
  // regenerates them does not churn every handle on the page.
  function volatileId(id) {
    return /^:r|[0-9a-f]{8}-[0-9a-f]{4}-|\d{4,}/i.test(id);
  }
  DP.fingerprint = function (rec) {
    if (rec.testid) return "tid:" + trimText(rec.testid, 80);
    if (rec.id && !volatileId(str(rec.id))) return "id:" + trimText(rec.id, 80);
    var kind = DP.kindOf(rec) || "x";
    var fp = "k:" + kind
      + "|r:" + (str(rec.role).toLowerCase() || str(rec.tag).toLowerCase())
      + "|n:" + DP.accName(rec).toLowerCase()
      + "|nm:" + trimText(rec.name, 40)
      + "|g:" + (Array.isArray(rec.groupPath) ? rec.groupPath.join(">") : "");
    if (kind === "c") fp += "|v:" + trimText(rec.value, 40);
    return fp;
  };

  /* ============================ handle registry ============================ */

  // The registry is DATA, not live element references (those are L2's, in the browser). It
  // carries everything L0 needs to keep handles stable across re-projections and to answer
  // staleness/ambiguity without touching a DOM: epoch, per-kind counters, fingerprint->handle.
  DP.newRegistry = function (epoch) {
    return { epoch: (epoch >= 1 ? epoch : 1), counters: {}, byFp: {}, byHandle: {}, ambiguous: {} };
  };

  // Navigation / SPA route change: every handle from the old epoch is invalid, no exceptions,
  // and the registry starts clean. Counters reset too - the epoch prefix in the revision is
  // what prevents an @b1 from the old page acting on the new one.
  DP.newEpoch = function (registry) {
    return DP.newRegistry((registry && registry.epoch ? registry.epoch : 0) + 1);
  };

  // Carries handle identity forward; starts `ambiguous` EMPTY on purpose.
  //
  // Ambiguity is a property of ONE round's projection, not of the epoch. Carrying it forward
  // made a handle permanently unresolvable: two "Remove" buttons in round 1, one of them gone
  // by round 2, and resolve() still refused the survivor - citing a candidate handle that no
  // longer existed. It also shared the {count,handles} objects by reference, so minting round 2
  // rewrote round 1's registry under a client holding it. Rebuilding per round fixes both.
  function cloneRegistry(reg) {
    var out = DP.newRegistry(reg.epoch);
    var k;
    for (k in reg.counters) out.counters[k] = reg.counters[k];
    for (k in reg.byFp) out.byFp[k] = reg.byFp[k];
    for (k in reg.byHandle) out.byHandle[k] = { fp: reg.byHandle[k].fp, baseFp: reg.byHandle[k].baseFp, kind: reg.byHandle[k].kind };
    return out;
  }

  // Registry key for the Nth record sharing one fingerprint.
  //
  // NOT string concatenation with an in-band marker. '#' was used here and it is legal INSIDE a
  // fingerprint - accessible names on these very pages read "Store #4412" and "PO #118871", and
  // a testid may contain anything. Two failures came out of that: slicing at the first '#'
  // truncated a genuine name and orphaned the ambiguity marker (so resolve() happily returned a
  // guess between two identical buttons), and a testid of literally "row#2" aliased onto the
  // suffixed key of a DIFFERENT element, putting one handle on two elements in one snapshot.
  //
  // Ordinal-first is provably disjoint: every fingerprint starts with "tid:", "id:" or "k:", so
  // no genuine fingerprint can begin with a digit. The base is also stored on the entry, so no
  // code path ever parses it back out of the key.
  function collisionKey(baseFp, ord) {
    return ord === 1 ? baseFp : (ord + " " + baseFp);
  }

  // Mint handles for this round's included records, reusing the handle of every fingerprint the
  // registry has seen this epoch (that continuity is what makes a delta meaningful - the same
  // Save button is @b1 in round 1 and round 9). Counters only ever grow, so a retired handle is
  // never reissued to a different element within an epoch.
  //
  // COLLISIONS: two records with the same fingerprint get distinct handles via a deterministic
  // '#2' suffix on the fingerprint (assigned in the caller's sorted order), and the base
  // fingerprint is marked ambiguous. Resolution against an ambiguous fingerprint refuses with
  // HANDLE_AMBIGUOUS and both candidates - it never picks the first.
  DP.mintHandles = function (records, prevRegistry) {
    var reg = cloneRegistry(prevRegistry || DP.newRegistry(1));
    var seenThisRound = {};
    var handles = [];
    var byBase = {};                 // baseFp -> handles minted for it THIS round
    var i;
    for (i = 0; i < records.length; i++) {
      var rec = records[i];
      var kind = DP.kindOf(rec) || "x";
      var baseFp = DP.fingerprint(rec);
      var ord = (seenThisRound[baseFp] = (seenThisRound[baseFp] || 0) + 1);
      var key = collisionKey(baseFp, ord);
      var h = reg.byFp[key];
      if (!h) {
        var n = (reg.counters[kind] || 0) + 1;
        reg.counters[kind] = n;
        h = "@" + kind + n;
        reg.byFp[key] = h;
        reg.byHandle[h] = { fp: key, baseFp: baseFp, kind: kind };
      }
      (byBase[baseFp] = byBase[baseFp] || []).push(h);
      handles.push(h);
    }
    // Ambiguity is recomputed from THIS round only: a fingerprint that matched 2+ records now.
    for (var b in byBase) {
      if (byBase[b].length > 1) reg.ambiguous[b] = { count: byBase[b].length, handles: byBase[b].slice() };
    }
    return { registry: reg, handles: handles };
  };

  /* ============================ staleness + ambiguity (pure halves) ============================ */

  DP.parseRevision = function (rev) {
    var m = /^e(\d+)\.r(\d+)$/.exec(str(rev));
    return m ? { epoch: parseInt(m[1], 10), r: parseInt(m[2], 10) } : null;
  };

  // Resolve a handle presented with the revision it came from. An epoch mismatch is STALE
  // before the registry is even consulted; an unknown handle is STALE; a handle whose base
  // fingerprint matched 2+ elements is AMBIGUOUS with every candidate listed. The browser-side
  // half (does the element still exist, is it still unique in the live DOM) is L2's; this half
  // is everything that can be answered from data alone.
  DP.resolve = function (registry, handle, fromRevision) {
    var rev = DP.parseRevision(fromRevision);
    if (!rev || rev.epoch !== registry.epoch) {
      return { ok: false, code: DP.ERROR.STALE, recovery: "refresh_snapshot" };
    }
    var entry = registry.byHandle[handle];
    if (!entry) return { ok: false, code: DP.ERROR.STALE, recovery: "refresh_snapshot" };
    // entry.baseFp is STORED, never parsed back out of the key - see collisionKey.
    var amb = registry.ambiguous[entry.baseFp];
    if (amb && amb.count > 1) {
      // A recovery string, because there now IS one. L2 overrides this refusal whenever it still
      // holds the bound element, so reaching a caller at all means the element is gone - and a
      // fresh snapshot re-mints the collision and re-binds every handle to a live element, which
      // resolves it. Before L2 deferred to its binding this path had no recovery field, and the
      // advice would have been a loop: refreshing reproduced the same ambiguity every time.
      return { ok: false, code: DP.ERROR.AMBIGUOUS, candidates: amb.handles.slice(), recovery: "refresh_snapshot" };
    }
    return { ok: true, fp: entry.fp, kind: entry.kind };
  };

  /* ============================ ordering ============================ */

  // Deterministic or nothing: a payload that reorders between rounds destroys the prompt cache
  // and makes deltas meaningless. Landmark group (ranked by the group's first appearance in
  // document order), then reading order - rect.y banded to 8px so sub-pixel jitter cannot
  // reorder, then rect.x - then domIndex, which is unique, as the total tiebreak.
  var Y_BAND = 8;

  // Every comparison below is subtraction-free where an Infinity could meet an Infinity.
  // `Infinity - Infinity` is NaN, V8 reads a NaN comparator result as "equal", and the sort
  // silently falls back to INPUT ORDER - which is the one thing this function exists to remove.
  // It fired whenever two groups both contained only records with no domIndex, and the
  // determinism test never saw it because its fixtures always carry one.
  function cmpNum(a, b) { return a === b ? 0 : (a < b ? -1 : 1); }
  function cmpStr(a, b) { return a === b ? 0 : (a < b ? -1 : 1); }

  DP.orderRecords = function (records) {
    var groupFirst = {};
    var i, g;
    for (i = 0; i < records.length; i++) {
      g = Array.isArray(records[i].groupPath) && records[i].groupPath.length ? str(records[i].groupPath[0]) : "";
      var d = records[i].domIndex == null ? Infinity : records[i].domIndex;
      if (groupFirst[g] == null || d < groupFirst[g]) groupFirst[g] = d;
    }
    var sorted = records.slice();
    sorted.sort(function (p, q) {
      var gp = Array.isArray(p.groupPath) && p.groupPath.length ? str(p.groupPath[0]) : "";
      var gq = Array.isArray(q.groupPath) && q.groupPath.length ? str(q.groupPath[0]) : "";
      if (gp !== gq) {
        // Group rank, then the group NAME as a total tiebreak so two ranks of Infinity
        // (both groups made of records with no domIndex) still order deterministically.
        var c = cmpNum(groupFirst[gp], groupFirst[gq]);
        return c !== 0 ? c : cmpStr(gp, gq);
      }
      var yp = p.rect ? Math.floor(p.rect.y / Y_BAND) : Infinity;
      var yq = q.rect ? Math.floor(q.rect.y / Y_BAND) : Infinity;
      if (yp !== yq) return cmpNum(yp, yq);
      var xp = p.rect ? p.rect.x : Infinity, xq = q.rect ? q.rect.x : Infinity;
      if (xp !== xq) return cmpNum(xp, xq);
      var dp = p.domIndex == null ? Infinity : p.domIndex;
      var dq = q.domIndex == null ? Infinity : q.domIndex;
      if (dp !== dq) return cmpNum(dp, dq);
      // Last resort when a record carries no geometry AND no domIndex: order by projected
      // identity. Without it two such records sort "equal" and input order leaks back in.
      return cmpStr(DP.fingerprint(p), DP.fingerprint(q));
    });
    return sorted;
  };

  /* ============================ emission ============================ */

  // Fixed field order per kind (JSON.stringify preserves insertion order; determinism tests
  // compare bytes). Only fields that carry signal are emitted - absent is absent, not null.
  function emitElement(rec, h, policy) {
    var kind = DP.kindOf(rec);
    var name = DP.accName(rec);
    // A deny field's LABEL is a leak path too. Masking only rec.value left an aria-label of
    // "SSN 123-45-6789" flowing straight through on a field the payload simultaneously reported
    // as masked. The label still reads "SSN [redacted]", so the model knows what the field is.
    if (policy === "deny") name = DP.redactDigits(name);
    var el = { h: h };
    if (kind === "c") {
      el.role = str(rec.role).toLowerCase() || (str(rec.type).toLowerCase() === "radio" ? "radio" : "checkbox");
    } else {
      el.role = EMIT_ROLE[kind];
    }
    if (kind === "h") {
      el.level = rec.level || ({ h1: 1, h2: 2, h3: 3 })[str(rec.tag).toLowerCase()] || 2;
      el.text = name;
      return el;
    }
    if (kind === "t") {
      if (name) el.name = name;
      if (rec.table) {
        el.shape = { rows: rec.table.rows | 0, cols: rec.table.cols | 0 };
        if (Array.isArray(rec.table.headers) && rec.table.headers.length) {
          el.headers = rec.table.headers.map(function (x) { return trimText(x, 40); });
        }
      }
      return el;
    }
    if (kind === "i" || kind === "s") el.label = name;
    else el.name = name;
    if (kind === "i") {
      // MASKING: a deny-classified field's value never leaves the projector - not here, not in
      // a delta, not in a log line. The element itself stays (empty and hidden are different
      // facts) and its handle is announced in masked[], which is how the model learns the field
      // exists and is off limits.
      if (policy !== "deny") { if (rec.value != null && rec.value !== "") el.value = trimText(rec.value, 200); }
      if (rec.placeholder && !rec.value) el.placeholder = policy === "deny" ? DP.redactDigits(trimText(rec.placeholder, 80)) : trimText(rec.placeholder, 80);
      if (rec.required) el.required = true;
    }
    if (kind === "s") {
      if (policy !== "deny" && rec.value != null && rec.value !== "") el.value = trimText(rec.value, 120);
      // Options are withheld on a deny select for the same reason its value is: the option
      // labels of a "pay from account" dropdown ARE the account numbers. Withholding the value
      // while listing every option was masking in name only. The count still ships, so the
      // model can see a choice exists and report that it cannot make it.
      if (Array.isArray(rec.options) && rec.options.length) {
        if (policy === "deny") {
          el.optionsWithheld = rec.options.length;
        } else {
          el.options = rec.options.slice(0, 30).map(function (o) { return trimText(o && (o.label != null ? o.label : o.value), 60); });
          if (rec.options.length > 30) el.optionsTruncated = rec.options.length - 30;
        }
      }
    }
    if (kind === "c") el.checked = !!rec.checked;
    if (ACTIONABLE[kind] === 1) el.enabled = !rec.disabled;
    if (rec.expanded != null && kind !== "i") el.expanded = !!rec.expanded;
    return el;
  }

  /* ============================ projection ============================ */

  var DEFAULT_MAX_ELEMENTS = 150;
  var DEFAULT_MAX_MESSAGES = 20;

  // project(records, page, opts, prev) -> { snapshot, registry, hash, bindings }
  //   records: node records from L1 (order irrelevant - ordering is ours)
  //   page:    { url, title }
  //   opts:    { maxElements?, maxMessages?, includeInert? }
  //   prev:    { registry, revision, hash } from the previous projection, or null for the first
  //
  // The registry rides OUTSIDE the snapshot: the snapshot is what the model sees, the registry
  // is what the client keeps. Never send the registry to the model - it carries fingerprints,
  // and fingerprints carry field names the masking rules may have hidden.
  DP.project = function (records, page, opts, prev) {
    opts = opts || {};
    var maxEl = opts.maxElements >= 1 ? opts.maxElements : DEFAULT_MAX_ELEMENTS;
    var maxMsg = opts.maxMessages >= 1 ? opts.maxMessages : DEFAULT_MAX_MESSAGES;
    var prevReg = prev && prev.registry ? prev.registry : DP.newRegistry(1);

    // 1. include + order (deterministically) over ALL candidates, then truncate.
    var included = [];
    for (var i = 0; i < (records || []).length; i++) {
      var rec = records[i];
      if (rec && typeof rec === "object" && DP.includeRec(rec, opts)) included.push(rec);
    }
    included = DP.orderRecords(included);

    var msgs = [], els = [];
    for (var j = 0; j < included.length; j++) {
      (DP.kindOf(included[j]) === "m" ? msgs : els).push(included[j]);
    }

    var truncated = null;
    if (els.length > maxEl) { truncated = truncated || {}; truncated.elements = els.length - maxEl; els = els.slice(0, maxEl); }
    if (msgs.length > maxMsg) { truncated = truncated || {}; truncated.messages = msgs.length - maxMsg; msgs = msgs.slice(0, maxMsg); }
    if (truncated) truncated.reason = "cap";

    // 2. mint handles over the SURVIVING records (elements first, then messages, one counter
    //    space) so a capped-away record spends no handle.
    var mint = DP.mintHandles(els.concat(msgs), prevReg);
    var registry = mint.registry;

    // 3. emit.
    //
    // `bindings` pairs each EMITTED handle with the record it came from. It is how L2 binds a
    // handle to a live element without recomputing the include/order/mint chain - a second
    // producer of that ordering is exactly the two-writers-drift shape, and it would drift
    // silently because both copies would look right in isolation. It never enters the snapshot
    // (the record carries locator metadata masking may have hidden) and never enters the hash.
    var policy = {}, masked = [], elements = [], bindings = [];
    for (var e = 0; e < els.length; e++) {
      var pol = DP.policyOf(els[e]);
      var h = mint.handles[e];
      elements.push(emitElement(els[e], h, pol));
      bindings.push({ h: h, rec: els[e], policy: pol });
      if (pol !== "allow") policy[h] = pol;
      var kind = DP.kindOf(els[e]);
      if (pol === "deny" && (kind === "i" || kind === "s") && els[e].value != null && els[e].value !== "") masked.push(h);
    }

    var seenMsg = {}, messages = [];
    for (var m = 0; m < msgs.length; m++) {
      var mt = str(msgs[m].msgType) || (str(msgs[m].role).toLowerCase() === "alert" ? "alert" : "status");
      var text = trimText(msgs[m].text, 300);
      var dk = mt + "|" + text;
      if (seenMsg[dk]) continue;               // exact duplicates carry no extra signal
      seenMsg[dk] = 1;
      var mh = mint.handles[els.length + m];
      messages.push({ h: mh, type: mt, text: text });
      bindings.push({ h: mh, rec: msgs[m], policy: "allow" });
    }

    // 4. landmarks: unique top-level groups in rank order; text = the group's first heading.
    var landmarks = [], seenG = {};
    for (var g = 0; g < els.concat(msgs).length; g++) {
      var r2 = g < els.length ? els[g] : msgs[g - els.length];
      var gname = Array.isArray(r2.groupPath) && r2.groupPath.length ? str(r2.groupPath[0]) : "";
      if (!gname || seenG[gname]) continue;
      seenG[gname] = 1;
      var lm = { role: gname };
      for (var hh = 0; hh < els.length; hh++) {
        if (DP.kindOf(els[hh]) === "h" && Array.isArray(els[hh].groupPath) && str(els[hh].groupPath[0]) === gname) {
          lm.text = DP.accName(els[hh]); break;
        }
      }
      landmarks.push(lm);
    }

    // 5. hash EVERYTHING the payload carries, then bump r only when it really changed.
    //    `page` is in the hash: url and title are part of the payload, so leaving them out let a
    //    title change ship a different snapshot under an unchanged revision - and a client that
    //    caches by revision would keep serving the old one.
    // UNEXPLORED: regions L1 reached but could not walk into - closed/open shadow roots, custom
    // elements. Reported for the same reason `truncated` is: a projection that silently omits
    // part of the page reads to the model as "that is everything", which is how an agent
    // concludes a control does not exist and starts inventing a workaround. L1 counts them; L0
    // only decides whether the counts are worth carrying, so it stays pure.
    var unexplored = null;
    if (page && page.unexplored) {
      var uk = ["shadowRoots", "customElements"], ui;
      for (ui = 0; ui < uk.length; ui++) {
        var uv = page.unexplored[uk[ui]] | 0;
        if (uv > 0) { unexplored = unexplored || {}; unexplored[uk[ui]] = uv; }
      }
    }

    var body = {
      page: { url: trimText(page && page.url, 300), title: trimText(page && page.title, 120) },
      landmarks: landmarks, elements: elements, messages: messages, policy: policy, masked: masked,
    };
    if (truncated) body.truncated = truncated;
    // In the HASH, so a page that grows a shadow root bumps the revision instead of changing
    // what the model is looking at under an unchanged one.
    if (unexplored) body.unexplored = unexplored;
    var hash = DP.hash(body);
    var revision;
    // `prev` is normally the previous project() RESULT, whose revision lives on the snapshot;
    // a hand-built {registry, revision, hash} (the epoch-bump path) carries it top-level.
    var prevRevStr = prev ? (prev.revision != null ? prev.revision
      : (prev.snapshot && prev.snapshot.page ? prev.snapshot.page.revision : null)) : null;
    var prevRev = DP.parseRevision(prevRevStr);
    if (prev && prev.hash === hash && prevRev && prevRev.epoch === registry.epoch) {
      revision = prevRevStr;
    } else if (prevRev && prevRev.epoch === registry.epoch) {
      revision = "e" + registry.epoch + ".r" + (prevRev.r + 1);
    } else {
      revision = "e" + registry.epoch + ".r1";
    }

    var snapshot = {
      page: { url: trimText(page && page.url, 300), title: trimText(page && page.title, 120), revision: revision },
      landmarks: landmarks,
      elements: elements,
      messages: messages,
    };
    if (truncated) snapshot.truncated = truncated;   // NEVER truncate silently - an unreported
    if (unexplored) snapshot.unexplored = unexplored;          // cap reads as "that is the whole page",
    if (Object.keys(policy).length) snapshot.policy = policy;  // and so does an unreported shadow root
    if (masked.length) snapshot.masked = masked;

    return { snapshot: snapshot, registry: registry, hash: hash, bindings: bindings };
  };

  /* ============================ deltas ============================ */

  function indexByHandle(snap) {
    var map = {};
    var i;
    for (i = 0; i < snap.elements.length; i++) map[snap.elements[i].h] = snap.elements[i];
    for (i = 0; i < snap.messages.length; i++) map[snap.messages[i].h] = snap.messages[i];
    return map;
  }

  // diff(prevSnapshot, nextSnapshot) -> delta, or { full: nextSnapshot } when the epochs differ
  // (a delta over an epoch boundary would describe changes to handles that no longer exist).
  // A delta is only ever emitted against the immediately preceding revision; the CLIENT enforces
  // that (REVISION_GAP -> ask for a full snapshot) - this function just refuses the epoch case.
  DP.diff = function (prevSnap, nextSnap) {
    var pe = DP.parseRevision(prevSnap.page.revision), ne = DP.parseRevision(nextSnap.page.revision);
    if (!pe || !ne || pe.epoch !== ne.epoch) return { full: nextSnap };
    var prevMap = indexByHandle(prevSnap), nextMap = indexByHandle(nextSnap);
    var changed = [], removed = [], added = [];
    var h;
    for (h in prevMap) { if (!nextMap[h]) removed.push(h); }
    removed.sort();
    // added in NEXT order (elements then messages), so the model reads them in reading order.
    var nextAll = nextSnap.elements.concat(nextSnap.messages);
    for (var i = 0; i < nextAll.length; i++) {
      h = nextAll[i].h;
      if (!prevMap[h]) { added.push(nextAll[i]); continue; }
      var was = prevMap[h], is = nextAll[i];
      var ch = null, k;
      for (k in is) {
        if (k === "h") continue;
        if (stableStringify(is[k]) !== stableStringify(was[k])) { ch = ch || { h: h }; ch[k] = is[k]; }
      }
      for (k in was) {
        if (k === "h" || is[k] !== undefined) continue;
        ch = ch || { h: h }; ch[k] = null;                 // field disappeared -> explicit null
      }
      if (ch) changed.push(ch);
    }

    var delta = { page_revision: nextSnap.page.revision, changed: changed, removed: removed, added: added };

    // Carry policy and masked forward for every handle the delta introduces or re-labels.
    // Without this a newly appeared password field arrived in `added` with no policy entry and
    // no masked entry, so a model reading deltas saw an unrestricted textbox - the snapshot's
    // safety labels applied only to the round that happened to be a full snapshot.
    var nextPolicy = nextSnap.policy || {}, prevPolicy = prevSnap.policy || {};
    var polDelta = {}, polChanged = false, hh;
    for (hh in nextPolicy) {
      if (nextPolicy[hh] !== prevPolicy[hh]) { polDelta[hh] = nextPolicy[hh]; polChanged = true; }
    }
    for (hh in prevPolicy) {
      if (!(hh in nextPolicy) && nextMap[hh]) { polDelta[hh] = "allow"; polChanged = true; }
    }
    if (polChanged) delta.policy = polDelta;

    var nextMasked = nextSnap.masked || [], prevMasked = prevSnap.masked || [];
    if (stableStringify(nextMasked.slice().sort()) !== stableStringify(prevMasked.slice().sort())) {
      delta.masked = nextMasked.slice();
    }
    return delta;
  };

  // Rebuild the handle->object maps a delta implies, for round-trip verification: applying
  // diff(prev, next) onto prev must yield exactly next's content. This is the test's tool, but
  // it ships in the module because the client-side delta consumer (phase 4) is the same code.
  DP.applyDelta = function (prevSnap, delta) {
    if (delta.full) return { revision: delta.full.page.revision, byHandle: indexByHandle(delta.full) };
    var map = indexByHandle(prevSnap);
    var out = {}, h, k;
    for (h in map) out[h] = map[h];
    for (var r = 0; r < delta.removed.length; r++) delete out[delta.removed[r]];
    for (var a = 0; a < delta.added.length; a++) out[delta.added[a].h] = delta.added[a];
    for (var c = 0; c < delta.changed.length; c++) {
      var ch = delta.changed[c];
      var base = {};
      for (k in out[ch.h]) base[k] = out[ch.h][k];
      for (k in ch) {
        if (k === "h") continue;
        if (ch[k] === null) delete base[k]; else base[k] = ch[k];
      }
      out[ch.h] = base;
    }
    return { revision: delta.page_revision, byHandle: out };
  };

  /* ============================ exports ============================ */

  if (typeof module !== "undefined" && module.exports) module.exports = DP;
  if (root) {
    root.BWNDOM = DP;
    if (root.BN) root.BN.domproj = DP;   // when inlined after a BN-CORE region
  }
})(typeof window !== "undefined" ? window : null);
/* BWN-DOM:END */
/* BWN-DOMC:START | DOM handle protocol L1/L2/L3/L4, PASTE-IDENTICAL with bwn-domcollect.js. Reads
   window.BWNDOM at load, so it MUST stay after BWN-DOM. Same no-edit rule. The write verbs it now
   carries are inert on this surface: DC.WRITE_SURFACES holds the SWA only, so on app.umbrava.com
   these same bytes refuse with SURFACE_NOT_ARMED. Arming Umbrava is phase 6. */
/* bwn-domcollect.js -- DOM handle protocol, layers L1 (collector), L2 (handle registry),
 * L3 (action executor) and L4 (policy gate).
 *
 * The browser half. It walks a live DOM into the plain node records bwn-domproj.js (L0) projects,
 * binds each minted handle to the live element it came from, re-resolves a handle whose element
 * was replaced by a re-render, answers the read-only verbs, and - phase 5 - executes the write
 * verbs behind three independent gates.
 * Spec: outputs/specs/2026-08-08-dom-handle-protocol-architecture.md in the vault (phases 3+5).
 *
 * WRITE ACCESS IS OFF UNLESS THREE SEPARATE THINGS ARE TRUE, and no single edit turns it on:
 *   1. the session was built with `write:true` - a caller opting in by name, not a default;
 *   2. the page's origin is in DC.WRITE_SURFACES, which holds this suite's own SWA and nothing
 *      else. Core pastes this file byte-identically onto app.umbrava.com, where the same bytes
 *      therefore refuse. Umbrava write verbs are phase 6 and need this list edited deliberately;
 *   3. every MUTATING verb needs a grant the operator minted by clicking a confirm strip, and
 *      DC.grant refuses any event whose isTrusted is not true - so a click the protocol itself
 *      synthesized can never approve anything. The model cannot satisfy its own confirm.
 * Core's bus responder carries a fourth gate of its own (BUS_VERBS), still read-only in phase 5.
 *
 * IMPURE ON PURPOSE, and thin for exactly that reason. Everything a hand-written DOM shim cannot
 * answer - layout, cascade, stacking, hit-testing - is asked of the real browser HERE and nowhere
 * else, so L0 stays unit-testable and this file's own headless tests never pretend to have
 * measured a rendered page. What the headless suite does and does not prove is written down in
 * scripts/test-domcollect.js and in docs/dom-handle-protocol.md; the rest is a live-browser gate.
 *
 * Loaded three ways, like bwn-domproj.js:
 *   1. scripts/test-domcollect.js  ->  require() the real file, against a DOM shim
 *   2. SWA tool pages, inlined by sync-theme.js into a BWN-DOMC region (must follow BWN-DOM)
 *   3. bwn-suite-core.user.js, as a paste-identical block (phase 4 - @grant none, page context)
 *
 * NEVER READS: localStorage, sessionStorage, cookies, or data-* in bulk. `data-testid` is read by
 * name, never by sweeping the dataset - a swept dataset is how a bearer token or a client id ends
 * up in a fingerprint, and a fingerprint is not covered by the masking rules.
 */
(function (root) {
  "use strict";

  var DP = (root && root.BWNDOM)
    || ((typeof module !== "undefined" && module.exports && typeof require === "function") ? require("./bwn-domproj.js") : null);

  var DC = { VERSION: "0.2.0" };

  DC.ERROR = {
    STALE: "HANDLE_STALE",
    AMBIGUOUS: "HANDLE_AMBIGUOUS",
    POLICY_DENIED: "POLICY_DENIED",
    REVISION_GAP: "REVISION_GAP",
    VERB_DISABLED: "VERB_DISABLED",
    UNKNOWN_VERB: "UNKNOWN_VERB",
    NO_DOCUMENT: "NO_DOCUMENT",
    // phase 5
    SURFACE_NOT_ARMED: "SURFACE_NOT_ARMED",
    CONFIRM_REQUIRED: "CONFIRM_REQUIRED",
    ELEMENT_DISABLED: "ELEMENT_DISABLED",
    ELEMENT_OBSCURED: "ELEMENT_OBSCURED",
    NOT_A_SELECT: "NOT_A_SELECT",
    OPTION_NOT_FOUND: "OPTION_NOT_FOUND",
    WRONG_KIND: "WRONG_KIND",
    UNKNOWN_KEY: "UNKNOWN_KEY",
    ASYNC_VERB: "ASYNC_VERB",
    EVENTS_UNSUPPORTED: "EVENTS_UNSUPPORTED",
    TIMEOUT: "TIMEOUT",
    // phase 6
    NO_WORKFLOW: "NO_WORKFLOW",
    OUT_OF_WORKFLOW_SCOPE: "OUT_OF_WORKFLOW_SCOPE",
    RANK_TOO_LOW: "RANK_TOO_LOW",
    RANK_UNKNOWN: "RANK_UNKNOWN",
  };

  // Gate 2. The origins where write verbs may run at all, hard-coded in the SHARED source rather
  // than left to the caller, because this file is pasted byte-identically into bwn-suite-core
  // (which runs on app.umbrava.com) and inlined into the SWA's own tools. Phase 5 is "SWA pages
  // only": a live work order is a live FSM, and a wrong click there is a real edit to a real
  // record. Frozen so a stray page script cannot widen it at runtime; widening it for phase 6 is
  // a source edit, reviewed with the rest of the diff.
  DC.WRITE_SURFACES = { "https://green-stone-0717dab0f.7.azurestaticapps.net": 1 };
  if (Object.freeze) Object.freeze(DC.WRITE_SURFACES);

  /* ---------------------------- phase 6: the workflow registry ----------------------------
   *
   * A surface that is NOT in WRITE_SURFACES gets in only one way: a named workflow that is
   * enabled, matches this exact route, clears a rank floor, and names the controls it is allowed
   * to touch. `app.umbrava.com` is deliberately NOT in the allowlist above and never will be -
   * a blanket write on a live work order is the thing this whole design exists to avoid. That is
   * what the spec's "one workflow at a time" means: each entry below is a separate reviewed
   * capability, and turning one on is a one-line diff someone signs off.
   *
   * A workflow is NARROWER than the surface allowlist in three ways at once:
   *   route     - the pathname it applies to, so a WO-notes workflow is inert on the board;
   *   controls  - the accessible names and kinds it may act on. Anything else on the page is
   *               OUT_OF_WORKFLOW_SCOPE even mid-workflow. The failure direction is "refuses too
   *               much", which on a live FSM is the only acceptable direction to be wrong in;
   *   minRank   - who may drive it at all.
   *
   * RANK IS A POLICY GATE, NOT A SECURITY BOUNDARY, and calling it one would be a lie worth
   * catching here. The number arrives over a document CustomEvent and a localStorage slot, both
   * of which any script on the page can write. It decides which humans may point the agent at a
   * workflow; it does not decide what Umbrava will accept. The things actually holding the line
   * are the closed verb set, the control scope, the operator's own confirm (isTrusted), and
   * Umbrava's server-side permissions against the operator's own bearer token.
   *
   * SHIPPED DISABLED. Every entry below has enabled:false, so the deployed bytes refuse every
   * write on Umbrava exactly as they did in phase 5. Phase 5 has not yet been verified in a
   * browser; arming a live FSM on top of an executor no browser has run is not a thing to do by
   * momentum. Flipping a flag here is the deliberate act, and it is reviewable on its own.
   */
  DC.WORKFLOWS = [
    {
      id: "wo-add-note",
      title: "Add a note to a work order",
      // ON, by Mike's decision, 2026-08-08. The first workflow this protocol has ever armed on a
      // live record.
      //
      // WHAT THIS DOES AND DOES NOT TURN ON, because the distinction matters more than the flag:
      //   IT DOES  let a page-context caller holding an ARMED session drive the add-note flow on a
      //            real work order - the console path, and the one the phase-6 gate uses. Every
      //            mutating step still raises a confirm strip the operator has to approve, and the
      //            scope still refuses every control the entry does not name.
      //   IT DOES NOT reach the Ask window, the bus, or anything the model drives on its own. Two
      //            further gates are untouched and both live in Core: BUS_VERBS exposes no write
      //            verb, and the responder's session is not armed. Turning THOSE on is a separate
      //            decision, and it is the one that hands the capability to an agent rather than
      //            to a person at a keyboard.
      //
      // The pair is still the point. `enabled` is a DECISION; `controlsVerified` is a MEASUREMENT.
      // Neither alone arms anything, and each is wrong in a way the other cannot cover.
      enabled: true,
      origin: "https://app.umbrava.com",
      // NO `$` anchor. The live route measured 2026-08-08 is `/work-orders/371126/details`, not
      // `/work-orders/371126` - an anchored pattern would have matched nothing, forever, and the
      // failure would have looked like "the workflow is off" rather than "the route is wrong".
      route: /^\/work-orders\/\d+/,
      // Rank 1 (staff) on purpose. The coordinator who lives on this page all day is the person
      // this is for, and a floor above them would ship a feature nobody holds the rank to use -
      // which is how the SWA's ops_* gates ended up deny-for-all for every signed-in user.
      // (The one rank measured so far is 4, on 2026-08-08. That is one user, not the population,
      // and it is a reason the floor is not load-bearing rather than a reason to raise it.)
      minRank: 1,
      // MEASURED on WO #371126, 2026-08-08, with the editor open. Twenty addressable controls,
      // down from 74 - an open dialog excludes the page behind it. The first version of this list
      // was written from the shape such a flow usually has and was wrong where it mattered: it
      // named a `Note` textbox and a `Save`/`Post` button, neither of which exists.
      //
      //   @i1  textbox  no name, no testid   the note body. Addressable ONLY by containment.
      //   @b13 button   "Add", no testid     submit. Not "Save", not "Post".
      //   @b12 button   "Cancel"             + testid add-project-note-modal-cancel-button
      //   groupPath on all three: ["Add Note", "form"]
      //
      // DELIBERATELY OUT OF SCOPE, and the reasons matter more than the list:
      //   @s2  share-with-field-autocomplete   WHO THE NOTE IS SHARED WITH. This is the highest
      //        blast radius in the dialog by a distance: it decides whether an internal note is
      //        visible to a client or a vendor. An agent must not be able to touch it, and the
      //        fact that it sits one control away from the field the agent DOES need is the best
      //        argument in this file for scoping per control rather than per dialog.
      //   @s1  add-wo-note-modal-type-field    the note's TYPE. Categorisation is a judgement
      //        with downstream effects on who reads it; the UI default is fine.
      //   @b1..@b11  the rich-text toolbar     bold/italic/lists are not part of writing a note.
      //        Two of them are worse than merely useless: -link-button and -mention-button, and a
      //        mention notifies a human.
      //
      // Fourteen of the twenty carry no accessible name. That is a finding about the page rather
      // than about this list, and it is the same root cause as the August fingerprint collisions.
      // Fourteen DO carry a data-testid, which is why scoping grew a `testid` matcher.
      controls: [
        // The opener, on the WO page with the dialog closed. `kind: "b"` matters: with the dialog
        // open there is also a HEADING and a DIALOG both named "Add Note".
        { name: /^add note$/i, kind: "b" },
        // The note body. No name and no testid, so containment is the only handle on it. Matched
        // per groupPath SEGMENT, which is what makes this work - the innermost segment is the
        // generic "form", and only "Add Note" identifies anything.
        { kind: "i", group: /^Add Note$/ },
        // Submit. Pinned to the group so an "Add" button elsewhere on a work order - and there are
        // several - can never satisfy this workflow.
        { name: /^Add$/, kind: "b", group: /^Add Note$/ },
        // Cancel, by name+group rather than by its testid: that testid reads
        // `add-project-note-modal-cancel-button`, which is a shared component from a different
        // modal and so is the likelier of the two to be renamed out from under us.
        { name: /^Cancel$/, kind: "b", group: /^Add Note$/ },
      ],
      // TRUE as of 2026-08-08: every matcher above was checked against a probe of the real page
      // with the editor open, including the groupPath the `group` matchers depend on. What this
      // flag asserts is only that - that the controls are real and reachable. It says nothing
      // about whether the flow should be switched on, which is `enabled`, and which is a decision
      // rather than a measurement.
      controlsVerified: true,
      // Why a note and not something larger: it is additive, it is visible to the humans who
      // read the WO, and a wrong one is corrected by writing another. Nothing in this workflow
      // changes a status, an amount, or a vendor assignment.
      rationale: "additive, human-visible, and wrong is fixed by writing another",
    },
  ];

  // Marks the confirm strip's own subtree. The walk skips it, so the operator's Approve button is
  // never projected, never gets a handle, and can never be the target of a verb. Belt and braces
  // with the isTrusted check in DC.grant - either alone would do, and neither is load-bearing on
  // the other. A data-* marker rather than aria-hidden: the strip is a real control a real screen
  // reader user has to be able to reach.
  DC.UI_MARK = "data-bwn-domp-ui";

  /* ============================ small helpers ============================ */

  function str(v) { return (v == null) ? "" : String(v); }
  function trimText(v, max) {
    var out = str(v).replace(/\s+/g, " ").trim();
    if (max && out.length > max) out = out.slice(0, max);
    return out;
  }
  function attr(el, name) {
    try { return el.getAttribute ? el.getAttribute(name) : null; } catch (e) { return null; }
  }
  function lower(v) { return str(v).toLowerCase(); }

  /* ============================ the walk ============================ */

  // Never entered at all. `svg` and `template` are pruned WITH their subtrees: svg internals are
  // hundreds of nodes carrying no accessible control, and a template's contents are not rendered.
  var PRUNE_TAGS = {
    script: 1, style: 1, noscript: 1, template: 1, svg: 1, head: 1, link: 1, meta: 1,
    iframe: 1, object: 1, embed: 1, datalist: 1,
  };

  // Landmark containers open a group. The group NAME prefers the accessible label, because a page
  // with three <section>s all named "region" collapses into one landmark and the model loses the
  // only structure it had.
  var LANDMARK_TAGS = {
    main: "main", nav: "nav", header: "banner", footer: "contentinfo",
    aside: "complementary", form: "form", section: "region", dialog: "dialog",
  };
  var LANDMARK_ROLES = {
    main: 1, navigation: 1, banner: 1, contentinfo: 1, complementary: 1, form: 1,
    region: 1, search: 1, dialog: 1, alertdialog: 1,
  };

  // Kinds whose own text is their name. A dialog is deliberately NOT here: its textContent is the
  // whole modal body, which would put the entire page back into the payload one level down.
  var TEXT_KINDS = { b: 1, a: 1, h: 1, m: 1 };

  // Kinds that are leaves for the purposes of the walk. Descending into a button to find the span
  // inside it produces two records for one control; descending into a table or a dialog is
  // mandatory, because the controls the model needs live inside them.
  var LEAF_KINDS = { b: 1, a: 1, h: 1, m: 1, s: 1, c: 1, i: 1 };

  function accessibleLabelOf(el, doc) {
    var lb = attr(el, "aria-labelledby");
    if (lb) {
      var parts = [], ids = lb.split(/\s+/), i, ref;
      for (i = 0; i < ids.length; i++) {
        ref = doc.getElementById ? doc.getElementById(ids[i]) : null;
        if (ref) parts.push(trimText(ref.textContent, 120));
      }
      var joined = trimText(parts.join(" "), 120);
      if (joined) return joined;            // resolved here so L0 stays DOM-free
    }
    return trimText(attr(el, "aria-label"), 120);
  }

  function boundLabelText(el, doc) {
    // The real DOM gives HTMLInputElement.labels; the shim path and exotic elements fall back to
    // label[for=id] and then an ancestor <label>.
    try {
      if (el.labels && el.labels.length) return trimText(el.labels[0].textContent, 120);
    } catch (e) { /* not a labelable element */ }
    var id = attr(el, "id");
    if (id && doc.querySelector) {
      var lab = null;
      try { lab = doc.querySelector('label[for="' + String(id).replace(/"/g, '\\"') + '"]'); } catch (e2) { lab = null; }
      if (lab) return trimText(lab.textContent, 120);
    }
    if (el.closest) {
      var anc = null;
      try { anc = el.closest("label"); } catch (e3) { anc = null; }
      if (anc) return trimText(anc.textContent, 120);
    }
    return "";
  }

  var ERROR_CLASS_RE = /(^|[\s_-])(error|invalid|danger|validation)([\s_-]|$)/i;

  function msgTypeOf(el, role) {
    if (role === "alert") return "alert";
    var live = lower(attr(el, "aria-live"));
    if (role === "status" || live === "polite" || live === "assertive") return "status";
    var cls = str(el.className && el.className.baseVal != null ? el.className.baseVal : el.className);
    if (ERROR_CLASS_RE.test(cls)) {
      // A class alone is weak evidence. Require it to read like a message rather than a wrapper:
      // short text, and not a container full of other elements. An "error-boundary" div wrapping
      // half the page is not a message and must not be projected as one.
      var t = trimText(el.textContent, 400);
      if (t && t.length <= 300) return "error";
    }
    return null;
  }

  function optionsOf(el) {
    var out = [], opts = el.options, i;
    if (!opts) return null;
    for (i = 0; i < opts.length; i++) {
      out.push({ value: str(opts[i].value), label: trimText(opts[i].label || opts[i].textContent, 60) });
    }
    return out.length ? out : null;
  }

  function tableShapeOf(el) {
    var rows = [], i;
    try { rows = el.querySelectorAll ? el.querySelectorAll("tr") : []; } catch (e) { rows = []; }
    var nRows = rows.length || 0;
    var headers = [], nCols = 0;
    var ths = [];
    try { ths = el.querySelectorAll ? el.querySelectorAll("th") : []; } catch (e2) { ths = []; }
    for (i = 0; i < ths.length && i < 20; i++) headers.push(trimText(ths[i].textContent, 40));
    if (nRows) {
      var first = rows[0];
      var cells = [];
      try { cells = first.querySelectorAll ? first.querySelectorAll("td,th") : []; } catch (e3) { cells = []; }
      nCols = cells.length;
    }
    return { rows: nRows, cols: nCols, headers: headers };
  }

  function rectOf(el) {
    var r = null;
    try { r = el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (e) { r = null; }
    if (!r) return null;
    return { x: r.left || 0, y: r.top || 0, w: r.width || 0, h: r.height || 0 };
  }

  // VISIBILITY IS COMPUTED. `el.hidden` is never read, anywhere in this file, on purpose: a
  // class-level `display:flex` beats the UA `[hidden]{display:none}` rule, so an element carrying
  // the attribute can be plainly on screen. The projection reports what the operator SEES - which
  // means such an element is visible:true, not visible:false. Reporting it hidden would hide a
  // real, clickable modal from the agent, which is the same failure wearing the other hat.
  DC.isVisible = function (el, rect, win) {
    if (typeof el.checkVisibility === "function") {
      var ok;
      try { ok = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); }
      catch (e) { ok = el.checkVisibility(); }
      if (!ok) return false;
    } else if (win && typeof win.getComputedStyle === "function") {
      var cs = win.getComputedStyle(el);
      if (!cs) return false;
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
      if (cs.opacity !== "" && parseFloat(cs.opacity) === 0) return false;
    } else {
      return false;                 // no way to compute it: refuse rather than guess visible
    }
    return !!rect && rect.w > 0 && rect.h > 0;
  };

  // Interactability, with an explicit "could not test" answer.
  //
  // The topmost check needs document.elementFromPoint, which only answers for points inside the
  // VIEWPORT and returns null outside it. Rows below the fold - the 219-card board, the queue's
  // 30th row - have centres far outside it, and reading that null as "obscured" would report every
  // one of them non-interactable and drop them from the projection entirely. A miss is therefore
  // ok:true, tested:false, and the record SAYS it was never tested; L3 re-tests at execution time,
  // when it can scroll first. The viewport bounds check above the call is the same answer reached
  // without paying for thousands of hit tests on a long board; the null guard is the correctness
  // half and must not be folded into it.
  DC.interactabilityOf = function (el, rect, win, doc) {
    if (win && typeof win.getComputedStyle === "function") {
      var cs = win.getComputedStyle(el);
      if (cs && cs.pointerEvents === "none") return { ok: false, tested: true };
    }
    if (el.closest) {
      var inert = null;
      try { inert = el.closest("[inert]"); } catch (e) { inert = null; }
      if (inert) return { ok: false, tested: true };
    }
    if (!rect || !doc || typeof doc.elementFromPoint !== "function") return { ok: true, tested: false };
    var cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    var vw = (win && win.innerWidth) || 0, vh = (win && win.innerHeight) || 0;
    if (!vw || !vh || cx < 0 || cy < 0 || cx >= vw || cy >= vh) return { ok: true, tested: false };
    var top = doc.elementFromPoint(cx, cy);
    if (!top) return { ok: true, tested: false };
    if (top === el) return { ok: true, tested: true };
    if (el.contains && el.contains(top)) return { ok: true, tested: true };   // own child took the hit
    if (top.contains && top.contains(el)) return { ok: true, tested: true };  // wrapping <label>
    return { ok: false, tested: true };
  };

  // collect(doc, win, opts) -> { records, page }
  //
  // opts: { root?: Element, maxNodes?: number }
  DC.collect = function (doc, win, opts) {
    opts = opts || {};
    if (!doc) return { records: [], page: { url: "", title: "" } };
    var start = opts.root || doc.body || doc.documentElement;
    var records = [];
    var domIndex = 0;
    var maxNodes = opts.maxNodes >= 1 ? opts.maxNodes : 20000;
    var nodes = 0;
    // Regions the walk reached but could not enter. This walk does not cross shadow boundaries,
    // and it never will for a CLOSED root - `el.shadowRoot` reads null for those exactly as it
    // does for an element with no root at all, which is why custom-element tags are counted
    // separately: they are the usual carrier of a closed root, so "0 open roots" cannot quietly
    // mean "every root is closed". The counts ride in the payload; see the note in L0.
    var unexplored = { shadowRoots: 0, customElements: 0 };

    function visit(el, groupPath) {
      if (!el || el.nodeType !== 1) return;
      if (++nodes > maxNodes) return;
      var tag = lower(el.tagName);
      if (PRUNE_TAGS[tag] === 1) return;
      if (lower(attr(el, "aria-hidden")) === "true") return;   // subtree too: it is hidden from AT
      if (attr(el, DC.UI_MARK) != null) return;                // the protocol's own confirm strip

      var idx = domIndex++;
      try { if (el.shadowRoot) unexplored.shadowRoots++; } catch (e) { /* not a host */ }
      if (tag.indexOf("-") > 0) unexplored.customElements++;
      var role = lower(attr(el, "role"));
      var type = lower(attr(el, "type"));
      var href = attr(el, "href");
      var level = (tag === "h1" ? 1 : tag === "h2" ? 2 : tag === "h3" ? 3
        : tag === "h4" ? 4 : tag === "h5" ? 5 : tag === "h6" ? 6 : null);
      if (level == null) {
        var al = attr(el, "aria-level");
        if (al != null && al !== "") level = parseInt(al, 10) || null;
      }
      var msgType = msgTypeOf(el, role);

      // Cheap candidacy probe first. Everything below this line costs layout, and a 219-card
      // board has thousands of nodes that are never projected.
      var probe = { tag: tag, type: type, role: role, href: href, level: level, msgType: msgType };
      var kind = DP.kindOf(probe);

      var childGroup = groupPath;
      if (LANDMARK_TAGS[tag] || LANDMARK_ROLES[role] === 1) {
        var gname = accessibleLabelOf(el, doc) || LANDMARK_TAGS[tag] || role || tag;
        childGroup = groupPath.concat([trimText(gname, 60)]);
      }

      if (kind) {
        var rect = rectOf(el);
        var visible = DC.isVisible(el, rect, win);
        var inter = DC.interactabilityOf(el, rect, win, doc);
        var ariaLabel = accessibleLabelOf(el, doc);
        var labelText = (kind === "i" || kind === "s" || kind === "c") ? boundLabelText(el, doc) : "";
        var rec = {
          tag: tag, type: type, role: role,
          ariaLabel: ariaLabel,
          labelText: labelText,
          placeholder: trimText(attr(el, "placeholder"), 120),
          title: trimText(attr(el, "title"), 120),
          text: TEXT_KINDS[kind] === 1 ? trimText(el.textContent, 300) : "",
          value: (kind === "i" || kind === "s" || kind === "c") ? str(el.value) : "",
          name: attr(el, "name"),
          id: attr(el, "id"),
          testid: attr(el, "data-testid"),          // BY NAME. The dataset is never swept.
          href: href,
          external: false,
          download: attr(el, "download") != null,
          autocomplete: attr(el, "autocomplete"),
          disabled: !!el.disabled || lower(attr(el, "aria-disabled")) === "true",
          checked: (kind === "c") ? (el.checked != null ? !!el.checked : lower(attr(el, "aria-checked")) === "true") : null,
          required: !!el.required || lower(attr(el, "aria-required")) === "true",
          expanded: attr(el, "aria-expanded") == null ? null : lower(attr(el, "aria-expanded")) === "true",
          msgType: msgType,
          visible: visible,
          interactable: inter.ok,
          obscuredTested: inter.tested,             // honesty flag; L0 ignores unknown fields
          rect: rect,
          domIndex: idx,
          depth: groupPath.length,
          groupPath: groupPath.slice(),
          level: level,
        };
        if (kind === "a" && href) {
          var origin = (win && win.location && win.location.origin) || "";
          try {
            var abs = el.href != null ? String(el.href) : String(href);
            rec.external = /^[a-z]+:\/\//i.test(abs) && origin !== "" && abs.indexOf(origin) !== 0;
          } catch (e) { rec.external = false; }
        }
        if (kind === "s") rec.options = optionsOf(el);
        if (kind === "t") rec.table = tableShapeOf(el);
        rec._el = el;                                // L2's binding. NEVER serialized - see below.
        records.push(rec);
        if (LEAF_KINDS[kind] === 1) return;          // a button's inner span is not a second control
      }

      var kids = el.children || [];
      for (var i = 0; i < kids.length; i++) visit(kids[i], childGroup);
    }

    visit(start, []);

    // The query string is dropped from the projected url. Ids and tokens ride in query params on
    // these apps, and a url is the one field that goes to the model verbatim. Epoch detection
    // still uses the FULL href internally, where it never leaves the browser.
    var loc = (win && win.location) || {};
    var url = str(loc.pathname) + str(loc.hash);
    return {
      records: records,
      page: { url: url || str(loc.href), title: trimText(doc.title, 120), unexplored: unexplored },
    };
  };

  /* ============================ L2: session + handle binding ============================ */

  // A session is the client-side state the model never sees: the registry, the live element for
  // each handle, and the revision trail. `byHandle[h].rec` carries raw values - including the ones
  // masking withheld from the payload - so it is never logged, never posted, never serialized.
  DC.createSession = function (o) {
    o = o || {};
    var win = o.window || root;
    var doc = o.document || (win && win.document) || null;
    return {
      doc: doc, win: win,
      opts: { maxElements: o.maxElements, maxMessages: o.maxMessages, includeInert: !!o.includeInert, root: o.root },
      registry: DP.newRegistry(1),
      prev: null,           // previous project() result, handed straight back to project()
      snapshot: null,
      byHandle: {},
      lastHref: null,
      epochChanged: false,
      mutations: 0,
      _quiet: null,
      _obs: null,
      // ---- phase 5 -------------------------------------------------------------------------
      // Gate 1. Absent means read-only, which is what every caller written before phase 5 gets
      // without changing a line: Core's responder, the phase-3 gate, every existing test.
      write: !!o.write,
      // A clock, injectable so the headless suite can drive expiry by node identity and explicit
      // ticks instead of by elapsed milliseconds - a hidden pane clamps setTimeout and a harness
      // that measures a real rate measures the harness.
      now: typeof o.now === "function" ? o.now : function () { return Date.now(); },
      // Replaceable so a host page can style its own strip. It does NOT replace the isTrusted
      // check: whatever draws the strip still has to hand DC.grant a real user event.
      confirmUI: typeof o.confirmUI === "function" ? o.confirmUI : null,
      // The caller's rank on the ladder /api/user-role computes (1 staff .. 5 director), as a
      // number or a function returning one. Core reads it off the `bwn:role` bus; the SWA has no
      // use for it and passes nothing. Unknown is RANK_UNKNOWN and refuses - a workflow gate that
      // waves through the case it could not evaluate is not a gate.
      rank: (typeof o.rank === "function" || typeof o.rank === "number") ? o.rank : null,
      pending: {},          // confirmId -> the request awaiting an operator
      grants: {},           // grant key -> { exp, epoch }, single use
      confirmSeq: 0,
    };
  };

  function hrefOf(s) {
    return (s.win && s.win.location) ? str(s.win.location.href) : "";
  }

  // Full re-projection. Bumps the epoch first when the location changed, which invalidates every
  // handle from the old page before a single one can be rebound to a same-looking element on the
  // new one.
  DC.refresh = function (s, o) {
    if (!s.doc) return { ok: false, code: DC.ERROR.NO_DOCUMENT };
    o = o || {};
    var href = hrefOf(s);
    s.epochChanged = false;
    if (s.lastHref !== null && href !== s.lastHref) {
      s.registry = DP.newEpoch(s.registry);
      s.prev = { registry: s.registry, revision: null, hash: null };
      s.snapshot = null;
      s.byHandle = {};
      s.epochChanged = true;
      // An approval was given for a control on the page the operator was looking at. That page is
      // gone, and every handle with it, so the approval goes too rather than waiting to be spent
      // on a same-looking button somewhere else.
      DC.clearConfirms(s);
    }
    s.lastHref = href;

    var projOpts = {
      maxElements: s.opts.maxElements, maxMessages: s.opts.maxMessages,
      includeInert: o.includeInert != null ? !!o.includeInert : s.opts.includeInert,
    };
    var got = DC.collect(s.doc, s.win, { root: s.opts.root });
    var res = DP.project(got.records, got.page, projOpts, s.prev);

    s.registry = res.registry;
    s.prev = res;
    s.byHandle = {};
    for (var i = 0; i < res.bindings.length; i++) {
      var b = res.bindings[i];
      var entry = res.registry.byHandle[b.h];
      s.byHandle[b.h] = {
        el: b.rec._el || null,
        rec: b.rec,
        policy: b.policy,
        // The fingerprint is READ off the registry entry the minting pass stored, not recomputed.
        // One producer: a second call site computing the same key from the same input is how a
        // 217-row board opened at 221.
        fp: entry ? entry.baseFp : null,
      };
    }
    var prevSnap = s.snapshot;
    s.snapshot = res.snapshot;
    return { ok: true, snapshot: res.snapshot, prevSnapshot: prevSnap, epochChanged: s.epochChanged };
  };

  // Snapshot, or a delta when the caller can prove which revision it is holding.
  //
  // `since` must be the revision of the IMMEDIATELY preceding projection. Anything else is a gap
  // over an unknown base: a delta computed against it would describe changes the caller cannot
  // apply, so the full snapshot ships instead and the gap is reported rather than papered over.
  DC.snapshotOrDelta = function (s, since, o) {
    var prevSnap = s.snapshot;
    var r = DC.refresh(s, o);
    if (!r.ok) return r;
    if (!since) return { ok: true, revision: r.snapshot.page.revision, snapshot: r.snapshot };
    if (!prevSnap || prevSnap.page.revision !== since) {
      return { ok: true, code: DC.ERROR.REVISION_GAP, revision: r.snapshot.page.revision, snapshot: r.snapshot };
    }
    var d = DP.diff(prevSnap, r.snapshot);
    if (d.full) return { ok: true, revision: d.full.page.revision, snapshot: d.full, epochChanged: true };
    return { ok: true, revision: d.page_revision, delta: d };
  };

  // Handle -> live element, in two halves. The pure half (epoch, unknown, ambiguous) is L0's and
  // is asked first - with ONE exception, below: L0 cannot settle ambiguity, but L2 usually can.
  // The browser half is: is the bound element still in the document, and if not, does its
  // fingerprint still match exactly one element on the page?
  DC.resolve = function (s, handle, fromRevision) {
    var pure = DP.resolve(s.registry, handle, fromRevision);
    // STALE is final. A wrong epoch or an unknown handle is not something a live binding can
    // rescue - the handle does not belong to this projection at all.
    if (!pure.ok && pure.code !== DP.ERROR.AMBIGUOUS) return pure;

    var bound = s.byHandle[handle];
    if (!bound) return { ok: false, code: DC.ERROR.STALE, recovery: "refresh_snapshot" };

    // AMBIGUOUS from L0 means "this FINGERPRINT matched several records this round". It does not
    // mean this HANDLE is unidentified: minting already separated the collision into distinct
    // handles (collisionKey ordinals) and L2 bound each one to its own element. While that element
    // is still in the document, identity is a fact we hold, not a guess we would be making.
    //
    // Refusing here anyway cost 6 of 85 handles on a live WO page (measured 2026-08-08) - every
    // one a nameless control, on a page where nothing had re-rendered in 25s - and the candidate
    // list it offered instead was a closed loop, since every candidate shares the colliding
    // fingerprint and failed identically. Read-only verbs had no way forward at all.
    if (bound.el && bound.el.isConnected) return { ok: true, el: bound.el, rec: bound.rec, policy: bound.policy };

    // The element is gone, so the collision is now REAL: re-finding it would mean choosing among
    // identical fingerprints, which is the one thing this must never do. Hand back L0's refusal
    // with its candidate list rather than the sweep below, which would only reach the same answer.
    if (!pure.ok) return pure;

    // Re-render replaced the node. Re-resolve by the fingerprint that minted the handle.
    var got = DC.collect(s.doc, s.win, { root: s.opts.root });
    var matches = [], i;
    for (i = 0; i < got.records.length; i++) {
      if (!DP.includeRec(got.records[i], s.opts)) continue;
      if (DP.fingerprint(got.records[i]) === bound.fp) matches.push(got.records[i]);
    }
    if (matches.length === 0) return { ok: false, code: DC.ERROR.STALE, recovery: "refresh_snapshot" };
    if (matches.length > 1) {
      // NEVER pick one. These matches carry no handles yet (they are from an unprojected
      // collection), so the honest answer names the count and sends the caller back for a
      // snapshot in which the collision is minted and labelled.
      return { ok: false, code: DC.ERROR.AMBIGUOUS, candidates: [], matched: matches.length, recovery: "refresh_snapshot" };
    }
    bound.el = matches[0]._el;
    bound.rec = matches[0];
    return { ok: true, el: bound.el, rec: bound.rec, policy: bound.policy, rebound: true };
  };

  /* ============================ verbs ============================ */

  // The closed verb set, and the whole security boundary: handles only, no selector parameter, no
  // JavaScript execution, no `evaluate`. A verb that is not here does not exist.
  //
  //   readonly  answerable without touching the page. Always available.
  //   mutates   changes the record the operator is looking at, so it needs an operator's approval
  //             on top of arming. `scroll` and `wait_for` are write-gated but NOT mutating: they
  //             move the viewport and watch the clock. Asking a human to approve a scroll trains
  //             them to approve without reading, which is how a confirm strip stops working.
  //   async     settles over time, so it cannot be answered by the synchronous DC.act.
  DC.VERBS = {
    inspect: { readonly: true },
    extract: { readonly: true },
    refresh_snapshot: { readonly: true },
    click: { readonly: false, mutates: true },
    fill: { readonly: false, mutates: true },
    select: { readonly: false, mutates: true },
    check: { readonly: false, mutates: true },
    press: { readonly: false, mutates: true },
    scroll: { readonly: false, mutates: false },
    wait_for: { readonly: false, mutates: false, async: true },
  };

  // The keys `press` will send. Closed on purpose: printable characters are `fill`'s job, and a
  // press verb that forwards any string is a text-injection channel wearing a keyboard's clothes.
  DC.PRESS_KEYS = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
  };

  var EXTRACT_MAX_CHARS = 4000;
  var EXTRACT_MAX_ROWS = 50;
  var EXTRACT_MAX_COLS = 12;

  function extractTable(el) {
    var rows = [];
    var trs = [];
    try { trs = el.querySelectorAll ? el.querySelectorAll("tr") : []; } catch (e) { trs = []; }
    for (var i = 0; i < trs.length && i < EXTRACT_MAX_ROWS; i++) {
      var cells = [];
      try { cells = trs[i].querySelectorAll ? trs[i].querySelectorAll("td,th") : []; } catch (e2) { cells = []; }
      var row = [];
      for (var j = 0; j < cells.length && j < EXTRACT_MAX_COLS; j++) row.push(trimText(cells[j].textContent, 120));
      rows.push(row);
    }
    var out = { rows: rows };
    if (trs.length > EXTRACT_MAX_ROWS) out.rowsTruncated = trs.length - EXTRACT_MAX_ROWS;
    return out;
  }

  function originOf(s) {
    return (s.win && s.win.location) ? str(s.win.location.origin) : "";
  }
  function routeOf(s) {
    return (s.win && s.win.location) ? str(s.win.location.pathname) : "";
  }

  // The caller's rank on the ladder /api/user-role computes (1 staff .. 5 director). A reader
  // that throws yields an unknown rank, never a pass.
  DC.rankOf = function (s) {
    var r = s.rank;
    if (typeof r === "function") { try { r = r(); } catch (e) { return null; } }
    return (typeof r === "number" && isFinite(r)) ? r : null;
  };

  // Every ENABLED workflow whose origin and route match where we are standing.
  DC.workflowsHere = function (s) {
    var origin = originOf(s), route = routeOf(s), out = [], i, w;
    for (i = 0; i < DC.WORKFLOWS.length; i++) {
      w = DC.WORKFLOWS[i];
      if (!w.enabled) continue;
      // A workflow whose control list nobody has checked against the real page is not usable, even
      // switched on. Measured on 2026-08-08: wo-add-note declared four controls and one of them
      // existed, so arming it would have approved the opening click and then refused every control
      // in the editor that click opened. `enabled` is a decision; this is a measurement; requiring
      // both means one flag cannot arm a flow nobody has looked at.
      //
      // `!== true`, not `=== false`: a new entry that simply forgets the field is unverified, not
      // trusted. Every other unknown in this file refuses (RANK_UNKNOWN, an untested topmost, an
      // unresolvable handle) and this one does too.
      if (w.controlsVerified !== true) continue;
      if (w.origin !== origin) continue;
      if (w.route && !w.route.test(route)) continue;
      out.push(w);
    }
    return out;
  };

  // A matcher may constrain any combination of kind, accessible name, data-testid and enclosing
  // group. ALL the constraints it states must hold; a matcher that states none matches anything.
  //
  // `group` exists because name-only scoping does not survive contact with a real page. Measured
  // on WO #371126 with the Add Note editor open: 14 of 20 addressable controls carry NO accessible
  // name, and one of them is the note body itself - the single field the workflow has to type
  // into. There is no name to scope it by, and putting a handle in a registry is meaningless
  // (handles are minted per session). "The textbox inside the Add Note dialog" is precise, stable
  // and readable, and it is expressible from data the collector already produces.
  //
  // `group` is tested against EACH SEGMENT of groupPath, so it matches on containment at any
  // depth rather than only on the innermost landmark. That is the more permissive reading, which
  // is why it is meant to be paired with `kind` - and why a matcher that is only `{group: ...}`
  // gives a whole dialog away.
  function controlAllowed(w, rec, name, kind) {
    var path = Array.isArray(rec.groupPath) ? rec.groupPath : [];
    for (var i = 0; i < w.controls.length; i++) {
      var c = w.controls[i];
      if (c.kind && c.kind !== kind) continue;
      if (c.name && !c.name.test(name)) continue;
      if (c.testid && !c.testid.test(str(rec.testid))) continue;
      if (c.group) {
        var hit = false;
        for (var j = 0; j < path.length; j++) { if (c.group.test(str(path[j]))) { hit = true; break; } }
        if (!hit) continue;
      }
      return true;
    }
    return false;
  }

  // The control scope, asked once the element is resolved. On a WRITE_SURFACES page there is
  // nothing to ask - those are our own tools. On a workflow surface, a control the workflow did
  // not name is refused even in the middle of that workflow: the registry entry is the boundary,
  // not a hint about where to start.
  DC.scopeGate = function (s, fresh) {
    if (DC.WRITE_SURFACES[originOf(s)] === 1) return null;
    var here = DC.workflowsHere(s);
    var rank = DC.rankOf(s);
    var name = DP.accName(fresh), kind = DP.kindOf(fresh);
    var considered = [];
    for (var i = 0; i < here.length; i++) {
      if (rank === null || rank < here[i].minRank) continue;
      if (controlAllowed(here[i], fresh, name, kind)) return { workflow: here[i] };
      considered.push(here[i].id);
    }
    return {
      refusal: {
        ok: false, code: DC.ERROR.OUT_OF_WORKFLOW_SCOPE,
        workflows: considered,
        recovery: "this control is not one the workflow named" + (considered.length ? " (" + considered.join(", ") + ")" : "")
          + "; write access on this surface is scoped to the controls the workflow declares",
      },
    };
  };

  // Gates 1 and 2, in that order on purpose. An unarmed session gets exactly the answer it got
  // before phase 5 existed - VERB_DISABLED - on every surface, so nothing that never opted in can
  // notice this release at all. Only a caller that DID opt in can reach the surface refusal, and
  // it wants to know which of the two stopped it.
  DC.writeGate = function (s, verb) {
    if (!s.write) {
      return {
        ok: false, code: DC.ERROR.VERB_DISABLED,
        recovery: "read-only session: " + verb + " exists but this session was not armed for writes",
      };
    }
    var origin = originOf(s);
    if (DC.WRITE_SURFACES[origin] === 1) return null;

    // Phase 6 widens this gate by exactly one route and no more: an origin also qualifies if at
    // least one ENABLED workflow matches this pathname. That route then owes two further answers
    // - the rank floor here, and whether the specific control is in scope, which DC.execute asks
    // once it has resolved an element.
    var here = DC.workflowsHere(s);
    if (!here.length) {
      // Two different facts, kept apart: "this surface is never writable" and "this surface is
      // writable but not on this page" send a caller to different places.
      var known = false, i;
      for (i = 0; i < DC.WORKFLOWS.length; i++) if (DC.WORKFLOWS[i].origin === origin) known = true;
      if (!known) {
        return {
          ok: false, code: DC.ERROR.SURFACE_NOT_ARMED,
          recovery: "write verbs are armed on this suite's own pages only; this page is "
            + (origin || "(no origin)"),
        };
      }
      return {
        ok: false, code: DC.ERROR.NO_WORKFLOW,
        recovery: "no enabled workflow covers " + (routeOf(s) || "this route") + " on this surface;"
          + " write access here is granted one named workflow at a time",
      };
    }
    var rank = DC.rankOf(s);
    if (rank === null) {
      return {
        ok: false, code: DC.ERROR.RANK_UNKNOWN,
        recovery: "the workflows on this page are rank-gated and no rank has been resolved for the"
          + " current user, so nothing is permitted",
      };
    }
    var floor = null;
    for (var j = 0; j < here.length; j++) {
      if (rank >= here[j].minRank) return null;
      if (floor === null || here[j].minRank < floor) floor = here[j].minRank;
    }
    return {
      ok: false, code: DC.ERROR.RANK_TOO_LOW,
      recovery: "the workflows on this page need rank " + floor + " and this user is " + rank,
    };
  };

  // act(session, req) -> result, synchronously.
  //   req: { verb, handle?, revision?, since?, includeInert?, value?, option?, checked?, key?, ... }
  DC.act = function (s, req) {
    req = req || {};
    var verb = str(req.verb);
    var def = DC.VERBS[verb];
    if (!def) return { ok: false, code: DC.ERROR.UNKNOWN_VERB, verbs: Object.keys(DC.VERBS) };
    if (!def.readonly) {
      // The write gates come FIRST, ahead of the async complaint. An unarmed session must hear
      // exactly what it heard before phase 5 existed - VERB_DISABLED - for every write verb
      // including wait_for; telling it to go and call actAsync instead would describe a door it
      // is not allowed through.
      var gate = DC.writeGate(s, verb);
      if (gate) return gate;
      if (def.async) {
        return {
          ok: false, code: DC.ERROR.ASYNC_VERB,
          recovery: verb + " settles over time and cannot be answered synchronously; call actAsync",
        };
      }
      if (!s.doc) return { ok: false, code: DC.ERROR.NO_DOCUMENT };
      return DC.execute(s, verb, def, req);
    }
    if (!s.doc) return { ok: false, code: DC.ERROR.NO_DOCUMENT };

    if (verb === "refresh_snapshot") return DC.snapshotOrDelta(s, req.since, { includeInert: req.includeInert });

    if (verb === "inspect") {
      if (!req.handle) return DC.snapshotOrDelta(s, req.since, { includeInert: req.includeInert });
      var ri = DC.resolve(s, req.handle, req.revision || (s.snapshot && s.snapshot.page.revision));
      if (!ri.ok) return ri;
      var rec = ri.rec, kind = DP.kindOf(rec);
      var detail = {
        h: req.handle, kind: kind, role: rec.role || rec.tag, policy: ri.policy,
        name: ri.policy === "deny" ? DP.redactDigits(DP.accName(rec)) : DP.accName(rec),
        enabled: !rec.disabled, visible: !!rec.visible, interactable: !!rec.interactable,
        obscuredTested: !!rec.obscuredTested,
        groupPath: rec.groupPath || [],
      };
      // A deny field's value is withheld here for the same reason it is withheld from the
      // snapshot. `inspect` would otherwise be the hole in masking: same field, same session,
      // different verb.
      if (ri.policy !== "deny" && rec.value != null && rec.value !== "") detail.value = trimText(rec.value, 200);
      if (ri.policy === "deny") detail.masked = true;
      return { ok: true, revision: s.snapshot ? s.snapshot.page.revision : null, detail: detail };
    }

    if (verb === "extract") {
      if (!req.handle) return { ok: false, code: DC.ERROR.UNKNOWN_VERB, recovery: "extract requires a handle" };
      var re = DC.resolve(s, req.handle, req.revision || (s.snapshot && s.snapshot.page.revision));
      if (!re.ok) return re;
      if (re.policy === "deny") {
        return { ok: false, code: DC.ERROR.POLICY_DENIED, recovery: null, reason: "handle is policy-denied; its content never leaves the page" };
      }
      var k = DP.kindOf(re.rec);
      var payload = (k === "t")
        ? extractTable(re.el)
        : { text: trimText(re.el && re.el.textContent, EXTRACT_MAX_CHARS) };
      payload.h = req.handle;
      return { ok: true, revision: s.snapshot ? s.snapshot.page.revision : null, extract: payload };
    }

    return { ok: false, code: DC.ERROR.UNKNOWN_VERB, verbs: Object.keys(DC.VERBS) };
  };

  /* ============================ L4: confirm grants ============================ */

  DC.CONFIRM_TTL_MS = 120000;
  DC.MAX_PENDING = 3;

  // The arguments go into the grant key VERBATIM, not as a hash of themselves. An operator who
  // approved `fill @i2 with 250` must not have approved `fill @i2 with 25000`, and a 32-bit hash
  // is a small space to be careless in when the only cost of exactness is a longer string sitting
  // in memory that never leaves the page.
  function grantKeyOf(verb, handle, args) {
    return verb + "|" + str(handle) + "|" + DP.stableStringify(args);
  }

  function argsOf(verb, req) {
    if (verb === "fill") return { value: str(req.value) };
    if (verb === "select") return { option: str(req.option != null ? req.option : req.value) };
    if (verb === "check") return { checked: req.checked === false ? false : true };
    if (verb === "press") return { key: str(req.key) };
    return {};
  }

  // What the operator reads on the strip. It has to name the actual change, including the text
  // that will be typed - a strip that says "the agent wants to do something" trains people to
  // approve without reading, and then the gate is decoration. Deny-classified handles never reach
  // here (POLICY_DENIED fires first), so no masked value can be spelled out on screen.
  // How the operator is told what they are approving.
  //
  // The fallback is not cosmetic. Measured on WO #371126: 14 of 20 controls inside the Add Note
  // editor have no accessible name, the note body among them - so on the page this workflow is
  // FOR, the strip would have read `type "..." into @i1`. Asking a human to approve a handle is
  // asking them to approve nothing they can check against the screen, and a confirm nobody can
  // evaluate is a click-through by another name. Falling back to the role and the enclosing group
  // gives them "the textbox in Add Note", which they can.
  // Landmark names that identify NOTHING. They come from the tag when an element carries no
  // accessible label, so they say "this is a form" rather than which form. Measured case: the note
  // body's groupPath is ["Add Note", "form"], and naming its innermost segment would tell the
  // operator "the unnamed textbox in form" - true, useless, and indistinguishable from every other
  // form on the page.
  var GENERIC_GROUPS = {
    form: 1, region: 1, main: 1, nav: 1, banner: 1, contentinfo: 1, complementary: 1,
    search: 1, group: 1, dialog: 1, section: 1, div: 1,
  };
  DC.distinctiveGroup = function (path) {
    if (!Array.isArray(path)) return "";
    for (var i = path.length - 1; i >= 0; i--) {
      if (!GENERIC_GROUPS[lower(path[i])]) return str(path[i]);
    }
    return path.length ? path.join(" > ") : "";
  };

  function describeTarget(rec, handle) {
    var name = DP.accName(rec);
    if (name) return name;
    var kind = DP.kindOf(rec);
    var what = DP.KINDS[kind] || "control";
    // Innermost DISTINCTIVE segment, not innermost segment.
    var where = DC.distinctiveGroup(rec.groupPath);
    return where ? ("the unnamed " + what + " in " + where + " (" + handle + ")")
      : ("an unnamed " + what + " (" + handle + ")");
  }

  function describeAction(verb, handle, args, rec) {
    var name = describeTarget(rec, handle);
    if (verb === "fill") return 'type "' + trimText(args.value, 120) + '" into ' + name;
    if (verb === "select") return 'choose "' + trimText(args.option, 80) + '" in ' + name;
    if (verb === "check") return (args.checked ? "tick " : "untick ") + name;
    if (verb === "press") return "press " + args.key + " on " + name;
    return "click " + name;
  }

  function takeDownUI(p) {
    var el = p && p.el;
    if (el && el.parentNode && el.parentNode.removeChild) {
      try { el.parentNode.removeChild(el); } catch (e) { /* already gone */ }
    }
    if (p) p.el = null;
  }

  DC.clearConfirms = function (s) {
    var id;
    for (id in s.pending) takeDownUI(s.pending[id]);
    s.pending = {};
    s.grants = {};
  };

  // GATE 3, and the whole of "the model can never satisfy its own confirm".
  //
  // A click this protocol dispatched - including one its own `click` verb just fired - carries
  // isTrusted:false. Only a gesture the user agent itself generated carries true, and no page
  // script can forge it. That is why the check lives HERE, on the grant, rather than inside the
  // default strip: a host page may draw its own confirm UI, and it still cannot approve anything
  // without a real human event in its hand.
  DC.grant = function (s, confirmId, ev) {
    if (!ev || ev.isTrusted !== true) {
      return {
        ok: false, code: DC.ERROR.CONFIRM_REQUIRED,
        recovery: "a confirm is granted by an operator's own click; a synthesized event cannot",
      };
    }
    var p = s.pending[str(confirmId)];
    if (!p) {
      return {
        ok: false, code: DC.ERROR.CONFIRM_REQUIRED,
        recovery: "no such pending confirm - it was already answered, or the page navigated",
      };
    }
    delete s.pending[p.id];
    takeDownUI(p);
    s.grants[p.key] = { exp: s.now() + DC.CONFIRM_TTL_MS, epoch: s.registry.epoch };
    return { ok: true, verb: p.verb, handle: p.handle };
  };

  // Deliberately NOT isTrusted-gated. Withdrawing permission is the safe direction, and a reject
  // that could itself be refused would leave a strip on screen with no way to dismiss it.
  DC.reject = function (s, confirmId) {
    var p = s.pending[str(confirmId)];
    if (!p) return { ok: false };
    delete s.pending[p.id];
    takeDownUI(p);
    return { ok: true };
  };

  function takeGrant(s, key) {
    var g = s.grants[key];
    if (!g) return false;
    // Deleted BEFORE the action runs, not after: single use has to survive an action that throws
    // half way, or a failure leaves a spendable approval lying about.
    delete s.grants[key];
    if (g.epoch !== s.registry.epoch) return false;
    if (s.now() > g.exp) return false;
    return true;
  }

  DC.defaultConfirmUI = function (s, p) {
    var doc = s.doc;
    if (!doc || typeof doc.createElement !== "function") return;   // no DOM: no strip, no approval
    var host = doc.createElement("div");
    host.setAttribute(DC.UI_MARK, "confirm");
    host.setAttribute("role", "alertdialog");
    host.setAttribute("aria-label", "Approve an agent action");
    host.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;"
      + "background:#191919;color:#fff;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;"
      + "padding:12px 14px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.38);"
      + "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
    var text = doc.createElement("span");
    text.style.cssText = "flex:1 1 260px";
    // textContent, never innerHTML. The summary carries the page's own accessible names, which on
    // these surfaces are written by vendors and clients and are untrusted input.
    text.textContent = "The agent wants to " + p.summary + ".";
    var no = doc.createElement("button");
    no.textContent = "Reject";
    no.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #666;background:transparent;color:#fff;cursor:pointer";
    var yes = doc.createElement("button");
    yes.textContent = "Approve";
    yes.style.cssText = "padding:6px 14px;border-radius:6px;border:0;background:#2ECC71;color:#0d3d26;font-weight:600;cursor:pointer";
    if (yes.addEventListener) {
      yes.addEventListener("click", function (ev) { DC.grant(s, p.id, ev); });
      no.addEventListener("click", function (ev) { DC.reject(s, p.id, ev); });
    }
    host.appendChild(text);
    host.appendChild(no);
    host.appendChild(yes);
    var mount = doc.body || doc.documentElement;
    if (mount && mount.appendChild) mount.appendChild(host);
    p.el = host;
  };

  function requestConfirm(s, verb, handle, args, rec, wf) {
    // A model that keeps asking must not paper the screen with strips. Oldest out first, so the
    // one the operator is currently reading is the newest.
    var ids = Object.keys(s.pending);
    while (ids.length >= DC.MAX_PENDING) {
      var oldest = ids.shift();
      takeDownUI(s.pending[oldest]);
      delete s.pending[oldest];
    }
    var p = {
      id: "c" + (++s.confirmSeq), key: grantKeyOf(verb, handle, args),
      verb: verb, handle: handle, args: args, workflow: wf ? wf.id : null,
      // On a workflow surface the strip names the capability as well as the action. "Click Save"
      // on a live work order is not enough for an operator to judge; "click Save, for Add a note
      // to a work order" is, and it is also how they notice if the agent has wandered.
      summary: describeAction(verb, handle, args, rec) + (wf ? " - for: " + wf.title : ""),
      el: null,
    };
    s.pending[p.id] = p;
    try { (s.confirmUI || DC.defaultConfirmUI)(s, p); }
    catch (e) { /* a strip that fails to draw must not turn a refusal into a throw */ }
    return {
      ok: false, code: DC.ERROR.CONFIRM_REQUIRED, confirmId: p.id,
      verb: verb, handle: handle, summary: p.summary,
      recovery: "the operator has to approve this on the page, then you retry the identical action;"
        + " you cannot approve it yourself",
    };
  }

  /* ============================ L3: the action executor ============================ */

  // A shallow copy of the bound record with every field that can change between the snapshot and
  // the click re-read off the live element. Policy and executability are decided from THIS, never
  // from the projection: a snapshot is a photograph, and between the photograph and the click an
  // input's type can flip to password or a link can grow a download attribute.
  function readVolatile(s, el, rec) {
    var out = {}, k;
    for (k in rec) { if (k !== "_el") out[k] = rec[k]; }
    out._el = el;
    out.tag = lower(el.tagName) || rec.tag;
    out.type = lower(attr(el, "type"));
    out.role = lower(attr(el, "role"));
    out.name = attr(el, "name");
    out.id = attr(el, "id");
    out.testid = attr(el, "data-testid");
    out.href = attr(el, "href");
    out.download = attr(el, "download") != null;
    out.autocomplete = attr(el, "autocomplete");
    out.placeholder = trimText(attr(el, "placeholder"), 120);
    out.title = trimText(attr(el, "title"), 120);
    out.ariaLabel = accessibleLabelOf(el, s.doc);
    out.disabled = !!el.disabled || lower(attr(el, "aria-disabled")) === "true";
    out.rect = rectOf(el);
    var kind = DP.kindOf(out);
    out.text = TEXT_KINDS[kind] === 1 ? trimText(el.textContent, 300) : "";
    if (kind === "i" || kind === "s" || kind === "c") {
      out.labelText = boundLabelText(el, s.doc);
      out.value = str(el.value);
    }
    if (kind === "c") {
      out.checked = (el.checked != null) ? !!el.checked : lower(attr(el, "aria-checked")) === "true";
    }
    if (kind === "s") out.options = optionsOf(el);
    if (kind === "a" && out.href) {
      var origin = (s.win && s.win.location && s.win.location.origin) || "";
      try {
        var abs = el.href != null ? String(el.href) : String(out.href);
        out.external = /^[a-z]+:\/\//i.test(abs) && origin !== "" && abs.indexOf(origin) !== 0;
      } catch (e) { out.external = false; }
    }
    return out;
  }

  function fireEvent(s, el, type) {
    if (!el.dispatchEvent) return false;
    var win = s.win || {};
    var ev = null;
    if (typeof win.Event === "function") {
      try { ev = new win.Event(type, { bubbles: true, cancelable: true }); } catch (e) { ev = null; }
    }
    if (!ev && s.doc && typeof s.doc.createEvent === "function") {
      try { ev = s.doc.createEvent("Event"); ev.initEvent(type, true, true); } catch (e2) { ev = null; }
    }
    if (!ev) return false;
    try { el.dispatchEvent(ev); } catch (e3) { return false; }
    return true;
  }

  // The PROTOTYPE's value setter, not the element's own.
  //
  // React installs its own setter on the DOM node and tracks the last value it wrote there. An
  // ordinary `el.value = x` goes through that setter, so React believes it already knows the
  // value, ignores the input event as a no-change, and reverts the write on the next render - the
  // fill silently no-ops and the page keeps whatever was there before. Going through the
  // prototype descriptor writes underneath React's tracker, and the input event it then sees
  // carries a value it does not recognise, which is what makes the state update happen.
  function nativeValueSetter(s, el) {
    if (typeof Object.getOwnPropertyDescriptor !== "function") return null;
    var win = s.win || {};
    var names = ["HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"], i, ctor, proto, d;
    for (i = 0; i < names.length; i++) {
      ctor = win[names[i]];
      proto = ctor && ctor.prototype;
      if (!proto) continue;
      // Only the prototype this element actually inherits from. Calling a setter lifted off an
      // unrelated interface throws (illegal invocation) on a real element.
      try { if (typeof proto.isPrototypeOf !== "function" || !proto.isPrototypeOf(el)) continue; }
      catch (e) { continue; }
      d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && typeof d.set === "function") return d.set;
    }
    return null;
  }

  // The topmost re-test, at execution time, with ONE scroll.
  //
  // The collector's answer was measured when the snapshot was taken and may be several seconds
  // old; more importantly it is `tested:false` for everything below the fold, because
  // elementFromPoint only answers inside the viewport. Scrolling the element into view is what
  // converts "could not test" into an answer, so it happens before the verdict rather than being
  // offered to the model as a recovery it would have to spend a round on.
  function ensureTopmost(s, el) {
    var first = DC.interactabilityOf(el, rectOf(el), s.win, s.doc);
    if (first.ok && first.tested) return { ok: true, tested: true, scrolled: false };
    var scrolled = false;
    if (typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "center", inline: "nearest" }); scrolled = true; }
      catch (e) { try { el.scrollIntoView(); scrolled = true; } catch (e2) { scrolled = false; } }
    }
    if (!scrolled) return { ok: first.ok, tested: first.tested, scrolled: false };
    var again = DC.interactabilityOf(el, rectOf(el), s.win, s.doc);
    return { ok: again.ok, tested: again.tested, scrolled: true };
  }

  function optionLabel(o) { return trimText(o && (o.label != null ? o.label : o.textContent), 120); }

  // Per-verb static checks: the wrong kind of element, an option that is not there, a key that is
  // not in the closed set. All of them run BEFORE the operator is asked to approve anything -
  // asking a human to sign off on something that was going to be refused anyway is how a confirm
  // strip becomes noise.
  function validateVerb(s, verb, kind, fresh, el, args) {
    if (verb === "fill") {
      if (kind !== "i") {
        return { ok: false, code: DC.ERROR.WRONG_KIND, kind: kind,
          recovery: "fill needs a textbox; this handle is a " + (DP.KINDS[kind] || "non-input") };
      }
      return null;
    }
    if (verb === "select") {
      if (kind !== "s") {
        return { ok: false, code: DC.ERROR.WRONG_KIND, kind: kind,
          recovery: "select needs a select control; this handle is a " + (DP.KINDS[kind] || "non-select") };
      }
      if (str(fresh.tag) !== "select" || !el.options) {
        // A role=combobox built out of divs has no options to set. Say so and name the route that
        // does work, rather than firing events at it and reporting a success nothing happened for.
        return { ok: false, code: DC.ERROR.NOT_A_SELECT,
          recovery: "this is a custom listbox, not a <select>: click it to open, then click the option" };
      }
      if (findOption(el, args.option) < 0) {
        var labels = [], i;
        for (i = 0; i < el.options.length && i < 30; i++) labels.push(optionLabel(el.options[i]));
        return { ok: false, code: DC.ERROR.OPTION_NOT_FOUND, options: labels,
          recovery: "choose one of the listed options" };
      }
      return null;
    }
    if (verb === "check") {
      if (kind !== "c") {
        return { ok: false, code: DC.ERROR.WRONG_KIND, kind: kind,
          recovery: "check needs a checkbox or radio; this handle is a " + (DP.KINDS[kind] || "non-checkable") };
      }
      var isRadio = str(fresh.type) === "radio" || str(fresh.role) === "radio";
      if (isRadio && args.checked === false) {
        return { ok: false, code: DC.ERROR.WRONG_KIND,
          recovery: "a radio is not cleared directly; check another option in the same group" };
      }
      return null;
    }
    if (verb === "press") {
      if (!DC.PRESS_KEYS[args.key]) {
        return { ok: false, code: DC.ERROR.UNKNOWN_KEY, keys: Object.keys(DC.PRESS_KEYS),
          recovery: "press sends only the listed navigation keys; use fill to enter text" };
      }
      return null;
    }
    return null;
  }

  function findOption(el, wanted) {
    var opts = el.options || [], i, w = str(wanted), lw = w.toLowerCase();
    for (i = 0; i < opts.length; i++) { if (str(opts[i].value) === w) return i; }
    for (i = 0; i < opts.length; i++) { if (optionLabel(opts[i]) === w) return i; }
    for (i = 0; i < opts.length; i++) { if (optionLabel(opts[i]).toLowerCase() === lw) return i; }
    return -1;
  }

  // Already in the requested state? Answer without touching the page and without spending an
  // operator's attention on a confirm for a change that is not one.
  function noopReason(verb, kind, fresh, args) {
    if (verb === "check" && (fresh.checked === true) === (args.checked === true)) {
      return "the control was already " + (args.checked ? "checked" : "unchecked");
    }
    if (verb === "fill" && str(fresh.value) === str(args.value)) {
      return "the field already held that value";
    }
    return null;
  }

  function perform(s, verb, el, fresh, args) {
    if (verb === "click") {
      if (typeof el.click === "function") { el.click(); return { ok: true }; }
      if (fireEvent(s, el, "click")) return { ok: true };
      return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED,
        recovery: "this element has no click() and the page has no Event constructor" };
    }
    if (verb === "check") {
      // A click, not a checked= assignment. React wires a checkbox's onChange to the click event,
      // so setting the property directly updates the box and never tells the app.
      if (typeof el.click === "function") { el.click(); return { ok: true }; }
      if (fireEvent(s, el, "click")) return { ok: true };
      return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED, recovery: "this element cannot be clicked" };
    }
    if (verb === "fill") {
      var setter = nativeValueSetter(s, el);
      if (setter) { try { setter.call(el, args.value); } catch (e) { el.value = args.value; } }
      else el.value = args.value;
      if (!fireEvent(s, el, "input") || !fireEvent(s, el, "change")) {
        return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED,
          recovery: "the value was written but no input/change event could be dispatched, so the app was not told" };
      }
      return { ok: true, nativeSetter: !!setter };
    }
    if (verb === "select") {
      var idx = findOption(el, args.option);
      var value = str(el.options[idx].value);
      var setter2 = nativeValueSetter(s, el);
      if (setter2) { try { setter2.call(el, value); } catch (e) { el.value = value; } }
      else el.value = value;
      if (el.selectedIndex != null) { try { el.selectedIndex = idx; } catch (e2) { /* read-only shim */ } }
      if (!fireEvent(s, el, "input") || !fireEvent(s, el, "change")) {
        return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED,
          recovery: "the option was set but no input/change event could be dispatched" };
      }
      return { ok: true, nativeSetter: !!setter2 };
    }
    if (verb === "press") {
      var spec = DC.PRESS_KEYS[args.key];
      var win = s.win || {};
      if (typeof win.KeyboardEvent !== "function" || !el.dispatchEvent) {
        return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED,
          recovery: "this page has no KeyboardEvent constructor" };
      }
      if (typeof el.focus === "function") { try { el.focus(); } catch (e) { /* not focusable */ } }
      var init = { key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode, bubbles: true, cancelable: true };
      try {
        el.dispatchEvent(new win.KeyboardEvent("keydown", init));
        el.dispatchEvent(new win.KeyboardEvent("keyup", init));
      } catch (e3) {
        return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED, recovery: String((e3 && e3.message) || e3) };
      }
      return { ok: true };
    }
    if (verb === "scroll") {
      if (typeof el.scrollIntoView === "function") {
        try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { el.scrollIntoView(); }
        return { ok: true };
      }
      return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED, recovery: "this element cannot be scrolled into view" };
    }
    return { ok: false, code: DC.ERROR.UNKNOWN_VERB, verbs: Object.keys(DC.VERBS) };
  }

  function pageScroll(s, req) {
    var win = s.win, doc = s.doc;
    var dir = lower(req.direction) || "down";
    var vh = (win && win.innerHeight) || 0;
    var step = Math.max(1, Math.round(vh * 0.8));
    var body = (doc && (doc.scrollingElement || doc.documentElement || doc.body)) || null;
    var height = (body && body.scrollHeight) || 0;
    if (dir === "top" && win.scrollTo) win.scrollTo(0, 0);
    else if (dir === "bottom" && win.scrollTo) win.scrollTo(0, height);
    else if (dir === "up" && win.scrollBy) win.scrollBy(0, -step);
    else if (dir === "down" && win.scrollBy) win.scrollBy(0, step);
    else {
      return { ok: false, code: DC.ERROR.EVENTS_UNSUPPORTED,
        recovery: "this page exposes no scroll method; scroll a handle into view instead" };
    }
    return afterAction(s, { verb: "scroll", direction: dir });
  }

  // Every successful action answers with the delta, per the protocol's one-shape rule.
  //
  // HONESTY: the delta is measured the instant the event was dispatched. A React app re-renders in
  // a microtask or on the next frame, so the consequence of a click is usually NOT in it. An empty
  // delta therefore says "nothing had changed yet", never "nothing happened", and it says so in
  // the payload rather than in this comment - a model that reads an empty delta as failure retries
  // the click, and a retried click is a second real edit.
  function afterAction(s, extra) {
    var since = s.snapshot ? s.snapshot.page.revision : null;
    var r = DC.snapshotOrDelta(s, since);
    var out = { ok: true, code: null, recovery: null, revision: r.revision || null };
    if (r.delta) {
      out.delta = r.delta;
      if (!r.delta.changed.length && !r.delta.removed.length && !r.delta.added.length) {
        out.note = "the page had not changed yet when this was measured, which is normal for an "
          + "app that re-renders asynchronously; take another snapshot before concluding anything";
      }
    } else if (r.snapshot) {
      out.snapshot = r.snapshot;
    }
    if (r.code) out.deltaCode = r.code;
    for (var k in extra) out[k] = extra[k];
    return out;
  }

  // execute(session, verb, def, req) -> result. Reached only after both write gates passed.
  //
  // Order matters and is not arbitrary: everything that can refuse for a mechanical reason runs
  // before the operator is asked for anything, so a confirm strip only ever appears for an action
  // that was actually going to run.
  DC.execute = function (s, verb, def, req) {
    if (verb === "scroll" && !req.handle) return pageScroll(s, req);
    if (!req.handle) {
      return { ok: false, code: DC.ERROR.UNKNOWN_VERB,
        recovery: verb + " needs a handle from a page snapshot" };
    }

    var r = DC.resolve(s, req.handle, req.revision || (s.snapshot && s.snapshot.page.revision));
    if (!r.ok) return r;

    var el = r.el;
    var fresh = readVolatile(s, el, r.rec);
    var kind = DP.kindOf(fresh);

    // L4 against the element as it is NOW, not against the label the snapshot carried.
    if (DP.policyOf(fresh) === "deny") {
      return { ok: false, code: DC.ERROR.POLICY_DENIED, recovery: null,
        reason: "this handle is policy-denied; explain that to the operator rather than routing around it" };
    }

    // Phase 6's control scope. Only for a verb that actually changes something: `scroll` moves
    // the viewport and refusing it would leave a workflow unable to reach its own controls, so it
    // is bounded by the route gate above and no further.
    var wf = null;
    if (def.mutates) {
      var scoped = DC.scopeGate(s, fresh);
      if (scoped && scoped.refusal) return scoped.refusal;
      wf = scoped && scoped.workflow;
    }

    var args = argsOf(verb, req);
    var bad = validateVerb(s, verb, kind, fresh, el, args);
    if (bad) return bad;

    if (fresh.disabled) {
      return { ok: false, code: DC.ERROR.ELEMENT_DISABLED,
        recovery: "wait_for this handle to become enabled, then retry" };
    }

    var noop = noopReason(verb, kind, fresh, args);
    if (noop) return afterAction(s, { verb: verb, handle: req.handle, noop: true, note: noop });

    var top = { ok: true, tested: false, scrolled: false };
    if (def.mutates) {
      top = ensureTopmost(s, el);
      if (top.tested && !top.ok) {
        return { ok: false, code: DC.ERROR.ELEMENT_OBSCURED, scrolled: !!top.scrolled,
          recovery: "something is drawn on top of it; close the overlay or scroll, then retry once" };
      }
      if (!takeGrant(s, grantKeyOf(verb, req.handle, args))) {
        return requestConfirm(s, verb, req.handle, args, fresh, wf);
      }
    }

    var done = perform(s, verb, el, fresh, args);
    if (!done.ok) return done;
    var extra = {
      verb: verb, handle: req.handle,
      // Carried because an untested topmost check is a real gap, not a pass: it means the browser
      // could not answer, which is the same honesty rule the collector's records carry.
      obscuredTested: !!top.tested, scrolled: !!top.scrolled,
    };
    // Whether the prototype value setter was actually found. On a page where it is missing the
    // fill fell back to a plain assignment, which a React-controlled input silently reverts - so
    // this is the difference between "typed" and "appeared to type", and the live gate reads it.
    if (done.nativeSetter != null) extra.nativeSetter = done.nativeSetter;
    // Which named capability authorised this, so an audit of what the agent did on a live record
    // reads as a workflow rather than as a list of loose clicks.
    if (wf) extra.workflow = wf.id;
    return afterAction(s, extra);
  };

  /* ============================ wait_for (the one asynchronous verb) ============================ */

  DC.WAIT_DEFAULT_MS = 5000;
  DC.WAIT_MAX_MS = 15000;
  DC.WAIT_POLL_MS = 150;

  DC.WAIT_CONDITIONS = { enabled: 1, disabled: 1, visible: 1, gone: 1, text: 1 };

  function waitSatisfied(s, req, cond) {
    var r = DC.resolve(s, req.handle, req.revision || (s.snapshot && s.snapshot.page.revision));
    if (!r.ok) {
      // A handle that stopped resolving IS the answer for `gone`. For every other condition it is
      // still a refusal, and it is returned as one rather than being retried until the timeout.
      if (cond === "gone" && r.code === DC.ERROR.STALE) return { done: true, result: null };
      if (cond === "gone") return { done: false };
      return { done: true, result: r };
    }
    var fresh = readVolatile(s, r.el, r.rec);
    var visible = DC.isVisible(r.el, fresh.rect, s.win);
    if (cond === "enabled" && !fresh.disabled) return { done: true, result: null };
    if (cond === "disabled" && fresh.disabled) return { done: true, result: null };
    if (cond === "visible" && visible) return { done: true, result: null };
    if (cond === "gone" && (!r.el.isConnected || !visible)) return { done: true, result: null };
    if (cond === "text") {
      var hay = trimText(r.el.textContent, 4000).toLowerCase();
      if (hay.indexOf(trimText(req.text, 200).toLowerCase()) >= 0) return { done: true, result: null };
    }
    return { done: false };
  }

  // actAsync(session, req, cb) -> void. Every non-async verb is handed straight to DC.act and its
  // answer passed on, so a caller can route everything through one entry point.
  //
  // The callback fires EXACTLY ONCE on every path - satisfied, refused, or timed out. A tool that
  // never settles wedges the whole server tool loop, which is worse than any wrong answer.
  DC.actAsync = function (s, req, cb) {
    req = req || {};
    var done = false;
    var finish = function (res) { if (done) return; done = true; try { cb(res); } catch (e) { /* consumer's problem */ } };
    if (typeof cb !== "function") return;

    var verb = str(req.verb);
    var def = DC.VERBS[verb];
    if (!def || !def.async) { finish(DC.act(s, req)); return; }

    var gate = DC.writeGate(s, verb);
    if (gate) { finish(gate); return; }
    if (!s.doc) { finish({ ok: false, code: DC.ERROR.NO_DOCUMENT }); return; }

    var cond = lower(req.condition) || "enabled";
    if (DC.WAIT_CONDITIONS[cond] !== 1) {
      finish({ ok: false, code: DC.ERROR.UNKNOWN_VERB, conditions: Object.keys(DC.WAIT_CONDITIONS),
        recovery: "wait_for takes one of the listed conditions" });
      return;
    }
    if (!req.handle) {
      finish({ ok: false, code: DC.ERROR.UNKNOWN_VERB, recovery: "wait_for needs a handle" });
      return;
    }
    if (cond === "text" && !str(req.text)) {
      finish({ ok: false, code: DC.ERROR.UNKNOWN_VERB, recovery: "wait_for text needs the text to wait for" });
      return;
    }

    var budget = req.timeoutMs >= 1 ? Math.min(req.timeoutMs | 0, DC.WAIT_MAX_MS) : DC.WAIT_DEFAULT_MS;
    var deadline = s.now() + budget;
    var setT = (s.win && s.win.setTimeout) || (typeof setTimeout === "function" ? setTimeout : null);

    function poll() {
      var got;
      try { got = waitSatisfied(s, req, cond); }
      catch (e) { finish({ ok: false, code: "RESPONDER_THREW", recovery: String((e && e.message) || e) }); return; }
      if (got.done) {
        finish(got.result || afterAction(s, { verb: "wait_for", handle: req.handle, condition: cond, waited: true }));
        return;
      }
      if (s.now() >= deadline || !setT) {
        // The delta ships anyway. The model asked what the page is doing, and "it did not reach
        // that state" plus the current state is a far more useful answer than a bare TIMEOUT.
        var out = afterAction(s, { verb: "wait_for", handle: req.handle, condition: cond });
        out.ok = false;
        out.code = DC.ERROR.TIMEOUT;
        out.recovery = "the condition was not met within " + budget + "ms; the state as it stands is attached";
        finish(out);
        return;
      }
      setT(poll, DC.WAIT_POLL_MS);
    }
    poll();
  };

  /* ============================ revision-bump watcher ============================ */

  var DEFAULT_QUIET_MS = 250;

  // SET-ONCE TRAILING TIMER, never clear-and-reset.
  //
  // A clear-and-reset debounce inside a MutationObserver measurably NEVER fires on a busy SPA -
  // the next mutation always lands before the window elapses, so the timer is cancelled forever
  // and the snapshot silently stops refreshing. A stale snapshot the model believes is current is
  // worse than no snapshot: it acts on a page that has moved. The `if (s._quiet) return` below is
  // the whole difference and must not be "improved" into a reset.
  DC.watch = function (s, onChange, quietMs) {
    if (s._obs) return false;
    if (!s.win || typeof s.win.MutationObserver !== "function" || !s.doc) return false;
    var quiet = quietMs >= 1 ? quietMs : DEFAULT_QUIET_MS;
    var setT = (s.win.setTimeout || setTimeout);
    s._obs = new s.win.MutationObserver(function () {
      s.mutations++;
      if (s._quiet) return;                       // SET ONCE. Do not clearTimeout here. Ever.
      s._quiet = setT(function () {
        s._quiet = null;
        try { onChange(); } catch (e) { /* a consumer throw must not kill the watcher */ }
      }, quiet);
    });
    s._obs.observe(s.doc.body || s.doc, { subtree: true, childList: true, attributes: true, characterData: true });
    return true;
  };

  DC.unwatch = function (s) {
    if (s._obs && s._obs.disconnect) s._obs.disconnect();
    s._obs = null;
    if (s._quiet && s.win && s.win.clearTimeout) s.win.clearTimeout(s._quiet);
    s._quiet = null;
  };

  /* ============================ exports ============================ */

  if (typeof module !== "undefined" && module.exports) module.exports = DC;
  if (root) {
    root.BWNDOMC = DC;
    if (root.BN) root.BN.domcollect = DC;
  }
})(typeof window !== "undefined" ? window : null);
/* BWN-DOMC:END */

  } catch (e) {
    // The responder module checks for the globals and beats 'fail' when they are absent, so the
    // page ends up with the rest of the suite working and DOM handles reported as unavailable -
    // which is what the AI script's NO_RESPONDER path is for.
    try { console.error('[BWN SUITE CORE] DOM handle protocol blocks failed to load:', e); } catch (e2) { }
  }

  // ==========================================================================
  // MODULE: DOM handle protocol responder 1.0  (phase 4, READ-ONLY)
  // ==========================================================================
  // Core is the only realm that can do this. It is @grant none, so it runs in PAGE context and
  // sees the real window and the real DOM; the AI script is GM-granted and lives in the
  // Tampermonkey sandbox, where the page's globals are invisible to it. So the collector lives
  // here and the transport lives there, and they speak only over document CustomEvents.
  //
  // BUS CONTRACT (new - bwn:cmd was fire-and-forget with no reply channel):
  //   request   bwn:cmd  { id:'domp:snapshot'|'domp:act', rid:'<unique>', ... }
  //   response  bwn:evt  { id:'domp:result',              rid:'<same>', result:{...} }
  // The caller resolves on the rid match and gives up on its own bounded timeout. Every detail
  // that crosses is plain JSON: the session holds live element references and raw field values -
  // including ones masking withheld - and none of that is ever put on the bus.
  bwnBoot('domHandle', BWN_MODULES.domHandle, function () {
    'use strict';

    var DC = window.BWNDOMC, DP = window.BWNDOM;
    if (!DC || !DP) { BWN.beat('domHandle', 'fail', 'BWN-DOM / BWN-DOMC block missing'); return; }

    // A SECOND read-only gate, deliberately redundant with the one inside DC.act. That one is a
    // property of the collector; this one is a property of what Umbrava is willing to expose over
    // the bus.
    //
    // PHASE 5 HAS SHIPPED AND THIS LINE IS UNCHANGED, on purpose. The pasted block above now
    // carries a working action executor, and on this surface it is inert three times over: the
    // list below does not name a write verb, the session below is not armed, and the block's own
    // WRITE_SURFACES allowlist holds the SWA and not app.umbrava.com. Arming Umbrava is phase 6
    // and takes three separate deliberate edits, which is the whole point of there being three.
    var BUS_VERBS = { inspect: 1, extract: 1, refresh_snapshot: 1 };

    // ---- Rank, for phase 6's workflow gate -------------------------------------------------
    // The same server-computed ladder the escalation wording already uses (bwn-suite-ai resolves
    // it against /api/user-role, which vouches the operator's Umbrava token; 1 staff .. 5
    // director). Core is @grant none and cannot fetch it, so it only CONSUMES: a live `bwn:role`
    // bus event, or the `bwn:role:last` slot when it is marked ok and still fresh.
    //
    // THIS IS NOT A SECURITY BOUNDARY and phase 6 does not pretend it is. Both the event and the
    // slot are writable by any script on the page. It decides which humans may point the agent at
    // a workflow; what Umbrava will actually accept is decided by Umbrava, server-side, against
    // the operator's own bearer. Unknown rank is RANK_UNKNOWN and refuses.
    //
    // Supplied as a FUNCTION, not a number: the session is built once and the rank often arrives
    // later, when the AI script finishes resolving it. A number captured at session-build time
    // would pin "unknown" for the life of the page.
    var _dompRank = null;
    var DOMP_ROLE_TTL_MS = 6 * 3600 * 1000;
    document.addEventListener('bwn:evt', BWN.guard(function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _dompRank = d.rank;
    }, 'domHandle:role'));
    function dompRank() {
      if (typeof _dompRank === 'number') return _dompRank;
      try {
        var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
        if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < DOMP_ROLE_TTL_MS) return r.rank;
      } catch (e) { }
      return null;
    }

    var session = null;
    function ensure() {
      // No `write: true`. A live work order is a live FSM and a wrong click there is a real edit
      // to a real record; the read-only default is what keeps that off the table here. The rank
      // reader is wired anyway, so that arming this is one flag rather than a flag plus a piece
      // of plumbing nobody remembers is missing.
      if (!session) session = DC.createSession({ window: window, document: document, rank: dompRank });
      return session;
    }

    function reply(rid, result) {
      try {
        document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'domp:result', rid: rid, result: result } }));
      } catch (e) { /* a failed reply is indistinguishable from silence; the caller times out */ }
    }

    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail;
      if (!d || (d.id !== 'domp:snapshot' && d.id !== 'domp:act')) return;
      if (!d.rid) return;                       // unaddressed request: nothing to answer to
      var verb = (d.id === 'domp:snapshot') ? 'refresh_snapshot' : String(d.verb || '');
      if (BUS_VERBS[verb] !== 1) {
        reply(d.rid, { ok: false, code: 'VERB_DISABLED',
          recovery: 'read-only release: ' + (verb || '(none)') + ' is not exposed over the bus' });
        return;
      }
      var res;
      try {
        res = DC.act(ensure(), {
          verb: verb, handle: d.handle, revision: d.revision, since: d.since,
          includeInert: !!d.includeInert
        });
      } catch (x) {
        // A throw here would leave the caller waiting out its whole timeout for nothing. Answer
        // with the fault instead - a named failure the model can report beats a silent stall.
        res = { ok: false, code: 'RESPONDER_THREW', recovery: String((x && x.message) || x) };
      }
      reply(d.rid, res);
    }, 'domHandle:cmd'));

    BWN.beat('domHandle', 'ok', 'read-only responder listening');
  });

  // ---- Flush the module queue -------------------------------------------------
  // Every registration above is queued, so this line is what actually starts the
  // suite. `complete` covers a Tampermonkey that injected late anyway (and any future
  // @run-at change) - without it the load event has already fired and nothing boots.
  if (document.readyState === 'complete') bwnBootAll();
  else window.addEventListener('load', bwnBootAll);

})();