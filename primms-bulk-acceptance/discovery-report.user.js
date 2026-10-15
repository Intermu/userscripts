// ==UserScript==
// @name         PRIMMS Discovery Report (read-only, redacted)
// @namespace    broadwaynational.com/primms
// @version      0.1.0
// @description  Phase 0. Read-only structural reporter for one PRIMMS work-order detail page. Emits selector presence, form action/method shapes with VALUES STRIPPED, input NAME attributes only, normalized action-label text, and acceptance-status label candidates. No values, no customer data, no tokens. Makes zero network requests. Never touches Umbrava.
// @author       Broadway National
// @match        https://primark-ostara.ostarasystems.net/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==
//
// WHAT THIS DOES / DOES NOT DO
//  - Reads ONLY the already-rendered DOM. No fetch/XHR/GM_xmlhttpRequest/etc.
//  - Records the SHAPE of the page (selectors, form action paths, input NAMES,
//    button LABELS). It never records input VALUES, cookies, tokens, CSRF
//    fields, customer data, addresses, contacts, or note bodies.
//  - Anti-forgery INPUT NAMES may be reported (e.g. "__RequestVerificationToken")
//    because a name is a shape, not a secret — the VALUE is never read.
//  - Adds a small floating box with a "Copy report" button. Copies redacted
//    JSON to the clipboard on an explicit click only.
//
(function () {
  'use strict';
  if (location.hostname !== 'primark-ostara.ostarasystems.net') return;

  // Never run on mutating / session / settings routes.
  if (/^\/(WorkOrderAction|Authentication|Settings)(\/|$)|^\/WorkOrder\/Create/i.test(location.pathname)) return;

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function present(sel) { return !!document.querySelector(sel); }

  // Strip anything that could be a value/id from a URL: keep controller/action,
  // replace path ids and all query values with placeholders.
  function redactUrl(u) {
    if (!u) return '';
    try {
      const url = new URL(u, location.origin);
      let path = url.pathname
        .replace(/\/\d+(?=\/|$)/g, '/{id}')
        .replace(/\/[0-9a-fA-F-]{20,}(?=\/|$)/g, '/{id}');
      const params = [];
      url.searchParams.forEach(function (_v, k) { params.push(k + '={v}'); });
      return path + (params.length ? '?' + params.join('&') : '');
    } catch (e) {
      // Relative or odd action attribute — strip after the first ? and mask ids.
      return String(u).split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}');
    }
  }

  const SELECTORS_TO_CHECK = [
    '#workOrderDetailLayoutTable', '#details', '#actions', '#workOrderActionsList',
    '.panel', '.panelheader', '#panelTitle', '#headerTable', '#workOrderLocationDetail',
    'table.additionalinfotable', 'td.label', 'td.value', '#breadcrumbsLinks',
    '#workOrderNextPreviousDetail', '#workOrderNoteHistoryLink',
    '#workOrderBuildingContactsLink', '#workOrderContactDetailsLink', '#workOrderDetailRefreshLink',
  ];

  const ACTION_LABEL_HINTS = ['accept', 'add note', 'notes', 'set fixed cost', 'allocate', 'schedule', 'cancel', 'work not required', 'request eta', 'stop job'];
  const ACCEPT_STATE_HINTS = ['accepted', 'acceptance', 'status', 'pending acceptance', 'awaiting'];

  function buildReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      route: redactUrl(location.pathname),
      note: 'Redacted structural report. No values, tokens, or customer data. Input NAMES only.',
      selectorsPresent: {},
      forms: [],
      actionLabels: [],
      acceptanceStateCandidates: [],
      headerTableShape: null,
    };

    SELECTORS_TO_CHECK.forEach(function (sel) { report.selectorsPresent[sel] = present(sel); });

    // Forms: action (redacted) + method + input NAMES only.
    Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
      const names = [];
      Array.prototype.forEach.call(f.querySelectorAll('input,select,textarea,button'), function (el) {
        const n = el.getAttribute('name');
        if (n) names.push({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: n });
      });
      report.forms.push({
        action: redactUrl(f.getAttribute('action') || ''),
        method: (f.getAttribute('method') || 'get').toLowerCase(),
        dataAjax: f.getAttribute('data-ajax') || null,        // unobtrusive-ajax marker
        dataAjaxMethod: f.getAttribute('data-ajax-method') || null,
        fieldNames: names,
      });
    });

    // Action labels: from the actions region, normalized text of clickable items.
    const actionsRoot = document.querySelector('#workOrderActionsList, #actions') || document;
    Array.prototype.forEach.call(actionsRoot.querySelectorAll('a,button,input[type=submit],input[type=button]'), function (el) {
      const label = norm(el.textContent || el.value || el.getAttribute('aria-label') || '');
      if (!label) return;
      const low = label.toLowerCase();
      if (ACTION_LABEL_HINTS.some(function (h) { return low.indexOf(h) !== -1; })) {
        report.actionLabels.push({
          label: label,
          tag: el.tagName.toLowerCase(),
          href: redactUrl(el.getAttribute('href') || ''),
          dataAjax: el.getAttribute('data-ajax') || null,
          dataAjaxMethod: el.getAttribute('data-ajax-method') || null,
        });
      }
    });

    // Acceptance-status label candidates: elements whose LABEL/text hints at status.
    // Report the label text and where it lives, NOT the value beside it.
    Array.prototype.forEach.call(document.querySelectorAll('td.label, th, .panelheader, #panelTitle, label'), function (el) {
      const t = norm(el.textContent).toLowerCase();
      if (t && ACCEPT_STATE_HINTS.some(function (h) { return t.indexOf(h) !== -1; })) {
        report.acceptanceStateCandidates.push({ labelText: norm(el.textContent).slice(0, 60), selectorHint: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\s+/)[0] : '') });
      }
    });

    // #headerTable shape (the mapping gap): report row count + per-row cell tag
    // pattern + any label-ish text, WITHOUT values. Helps map label/value layout.
    const ht = document.querySelector('#headerTable');
    if (ht) {
      const rows = [];
      Array.prototype.forEach.call(ht.querySelectorAll('tr'), function (tr) {
        const cells = Array.prototype.map.call(tr.children, function (c) {
          // Report only the tag + class + whether it LOOKS like a label (short, ends with ':').
          const txt = norm(c.textContent);
          const looksLabel = txt.length <= 40 && /[:：]$/.test(txt);
          return { tag: c.tagName.toLowerCase(), cls: String(c.className || '').split(/\s+/)[0] || '', looksLikeLabel: looksLabel, labelTextIfLabel: looksLabel ? txt.slice(0, 40) : null };
        });
        rows.push({ cellCount: cells.length, cells: cells });
      });
      report.headerTableShape = { rowCount: rows.length, rows: rows };
    }

    return report;
  }

  function show() {
    const report = buildReport();
    const json = JSON.stringify(report, null, 2);

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:60px;right:16px;width:380px;max-height:80vh;overflow:auto;z-index:2147483200;'
      + 'background:#f0f4f8;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 12px 34px rgba(13,38,26,.22);'
      + "font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:12px;color:#0f172a;";
    const hd = document.createElement('div');
    hd.style.cssText = 'background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;padding:10px 12px;border-radius:12px 12px 0 0;font-weight:700;';
    hd.textContent = 'PRIMMS Discovery Report (redacted)';
    const pre = document.createElement('pre');
    pre.style.cssText = "margin:0;padding:10px 12px;white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,Consolas,monospace;";
    pre.textContent = json;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;padding:10px 12px;';
    const copy = document.createElement('button');
    copy.textContent = 'Copy report';
    copy.style.cssText = 'background:#2ECC71;color:#08331d;border:none;border-radius:8px;cursor:pointer;font:700 12px sans-serif;padding:7px 12px;';
    copy.addEventListener('click', function () {
      // Explicit user gesture. Clipboard only, no network.
      try { navigator.clipboard.writeText(json); copy.textContent = 'Copied'; }
      catch (e) { pre.focus(); copy.textContent = 'Copy failed — select the text'; }
    });
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.style.cssText = 'background:#e2e8f0;color:#334155;border:none;border-radius:8px;cursor:pointer;font:700 12px sans-serif;padding:7px 12px;';
    close.addEventListener('click', function () { box.remove(); });
    bar.appendChild(copy); bar.appendChild(close);
    box.appendChild(hd); box.appendChild(pre); box.appendChild(bar);
    document.body.appendChild(box);
  }

  show();
})();
