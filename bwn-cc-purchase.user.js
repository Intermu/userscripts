// ==UserScript==
// @name         BWN CC Purchase (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.4.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-cc-purchase.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-cc-purchase.user.js
// @description  Replaces the "Log Credit Card Purchase Request" Microsoft Form with an in-page modal. Fill the fields and submit; it POSTs to the broadway-internal-ops SWA proxy (x-bwn-key gated) which forwards to the HTTP-triggered Power Automate flow - logging a row to Credit Card Tracker.xlsx and emailing Mike, identically to the old Form. Opened on a work order, it prefills the Work Order # and drops the client/location into the description, and defaults Supplier to whichever PO line you flipped to "Supplier" in the BWN Ops Suite (falling back to the WO's vendors as suggestions). Card Used is a pick-list you maintain. An optional Receipt is uploaded (via /api/cc-receipt -> Graph) to the shared SharePoint folder and linked in the tracker. The flow's secret URL stays server-side; nothing sensitive lives in this script. Open it from the floating button or the Tampermonkey menu.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.4.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/cc-purchase';
  var RECEIPT_URL = SWA_BASE + '/api/cc-receipt';
  var MAX_RECEIPT = 10 * 1024 * 1024;   // 10 MB - keep in sync with api/cc-receipt
  console.info('[BWN CC PURCHASE] v' + VER + ' - modal -> SWA proxy -> Power Automate flow -> Credit Card Tracker.xlsx + email; job prefill + supplier auto-default + card pick-list + receipt upload; flow URL stays server-side');

  // Read a File as base64 (payload for the /api/cc-receipt Graph upload).
  function readFileB64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result || '');
        var i = s.indexOf(',');   // strip the "data:...;base64," prefix
        resolve({ dataB64: i >= 0 ? s.slice(i + 1) : s, contentType: file.type || 'application/octet-stream', filename: file.name || 'receipt' });
      };
      r.onerror = function () { reject(new Error('could not read the file')); };
      r.readAsDataURL(file);
    });
  }

  // ---- BWN Ops Suite bus (read-only consumer of the suite data contract v1) ----
  // bwn-suite-core (WO Assist) PUBLISHES the current WO's facts to sessionStorage
  // key `bwn:wo:{id}` (see its SHARED CORE block). We only READ it, so there is no
  // coupling and no runtime-object sharing needed - just the same per-origin storage.
  // Absent (Core not installed, or the Job View not opened yet) -> graceful blank.
  function woIdFromUrl() {
    var m = location.pathname.match(/work-orders\/(\d+)/);
    return m ? m[1] : null;
  }
  function busGet(id, maxAgeMs) {
    if (!id) return null;
    try {
      var raw = sessionStorage.getItem('bwn:wo:' + id);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d.v !== 1 || (maxAgeMs && Date.now() - d.ts > maxAgeMs)) return null;
      return d;
    } catch (e) { return null; }
  }
  // Per-WO Vendor/Supplier classification published by bwn-suite-core's PO grouping
  // (localStorage `bwn:po:cls:{id}` = {items:[{vendor,sup}]}). Lets us default the
  // Supplier field to the line the user flipped to "Supplier". Absent -> [].
  function poCls(id) {
    if (!id) return [];
    try {
      var raw = localStorage.getItem('bwn:po:cls:' + id);
      if (!raw) return [];
      var d = JSON.parse(raw);
      return Array.isArray(d.items) ? d.items : [];
    } catch (e) { return []; }
  }

  // ---- Saved cards (the "Card Used" pick-list the user maintains) ------------
  // Stored in Tampermonkey (GM), NOT in page storage - it's a per-user preference,
  // not WO data. Store last-4 / friendly labels only; never a full card number.
  function savedCards() {
    try { var a = JSON.parse(GM_getValue('cc_cards', '[]')); return Array.isArray(a) ? a.filter(Boolean) : []; }
    catch (e) { return []; }
  }
  function saveCards(list) {
    var clean = [];
    (list || []).forEach(function (s) { s = String(s || '').trim().slice(0, 60); if (s && clean.indexOf(s) === -1) clean.push(s); });
    GM_setValue('cc_cards', JSON.stringify(clean));
    return clean;
  }
  function manageCards() {
    var cur = savedCards();
    var v = prompt('Saved cards for the "Card Used" pick-list (one per line, last-4 or a friendly label - NEVER a full card number):', cur.join('\n'));
    if (v === null) return null;
    var saved = saveCards(v.split(/\r?\n/));
    toast(saved.length ? 'Saved ' + saved.length + ' card' + (saved.length === 1 ? '' : 's') + '.' : 'Card list cleared.');
    return saved;
  }
  // (Re)build the Card Used <select>: blank, one option per saved card, then an
  // inline "add / manage" entry. `selected` re-selects a value after a rebuild.
  function rebuildCardOptions(sel, selected) {
    sel.innerHTML = '';
    var blank = new Option('- select a card -', '');
    sel.appendChild(blank);
    savedCards().forEach(function (c) { sel.appendChild(new Option(c, c)); });
    sel.appendChild(new Option('+ Add / manage cards…', ADD_CARD));
    sel.value = (selected && Array.prototype.some.call(sel.options, function (o) { return o.value === selected; })) ? selected : '';
  }

  // ---- Toast --------------------------------------------------------------
  function toast(msg, ms, bg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%);background:' + (bg || '#0d3d26') + ';color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:74vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.5;';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 420); }, ms || 6000);
  }

  // ---- Who's signed in (Umbrava Auth0 session) - default for Card User -----
  function actor() {
    try {
      var k = Object.keys(localStorage).find(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); });
      var u = k ? ((JSON.parse(localStorage.getItem(k)) || {}).decodedToken || {}).user : null;
      return { name: (u && u.name) || '', email: (u && u.email) || '' };
    } catch (e) { return { name: '', email: '' }; }
  }

  // ---- SWA POST (GM_xmlhttpRequest bypasses same-origin; @connect authorizes) ----
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 30000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  // ---- Field spec (order = modal layout). Mirrors the flow's 10-prop body ---
  // key      = the JSON prop the flow / proxy expect
  // required = enforced client-side (the proxy re-checks the same minimum)
  var FIELDS = [
    { key: 'Date', label: 'Date', type: 'date', required: true },
    { key: 'CardUser', label: 'Card User', type: 'text', required: true, ph: 'Who used the card' },
    { key: 'CardUsed', label: 'Card Used', type: 'select', ph: 'Card name / last 4' },
    { key: 'SupplierName', label: 'Supplier Name', type: 'text', required: true, list: true, ph: 'Vendor / merchant / store' },
    { key: 'Subtotal', label: 'Subtotal', type: 'money', ph: '0.00' },
    { key: 'TaxAmount', label: 'Tax Amount', type: 'money', ph: '0.00' },
    { key: 'TotalAmount', label: 'Total Amount', type: 'money', required: true, ph: '0.00' },
    { key: 'LineItemDescription', label: 'Line Item Description', type: 'textarea', ph: 'Purpose / what was purchased' },
    { key: 'PurchaseLink', label: 'Purchase Link', type: 'url', ph: 'https:// (optional)' },
    { key: 'WorkOrderNumber', label: 'Work Order / Job #', type: 'text', ph: 'digits only, e.g. 371126' }
  ];

  function todayISO() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function cleanMoney(v) { return String(v || '').replace(/[^0-9.\-]/g, ''); }

  var openEl = null;

  function closeModal() { if (openEl) { openEl.remove(); openEl = null; document.removeEventListener('keydown', onKey); } }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  var ADD_CARD = '__add_card__';

  function buildModal() {
    if (openEl) return;   // one at a time
    var me = actor();

    // Current WO context from the suite bus (may be null - degrade gracefully).
    var woId = woIdFromUrl();
    var bus = busGet(woId, 12 * 3600000);
    var cls = poCls(woId);   // [{vendor, sup}] from Core's PO grouping (if the user opened the PO list)

    // Supplier suggestion order: lines flipped to "Supplier" first, then the WO's other
    // vendors. Merge the classification list (authoritative on S/V) with the bus pos names.
    var busVendorNames = (bus && Array.isArray(bus.pos))
      ? bus.pos.map(function (p) { return (p && p.vendor) ? String(p.vendor).trim() : ''; }).filter(Boolean)
      : [];
    var suppliers = cls.filter(function (c) { return c && c.sup && c.vendor; }).map(function (c) { return c.vendor; });
    var nonSuppliers = cls.filter(function (c) { return c && !c.sup && c.vendor; }).map(function (c) { return c.vendor; });
    var woVendors = [];
    suppliers.concat(nonSuppliers).concat(busVendorNames).forEach(function (v) { if (v && woVendors.indexOf(v) === -1) woVendors.push(v); });
    // Auto-default Supplier to the (single) flipped-to-supplier line; if several, leave
    // blank so the coordinator picks (they're all in the suggestion list, suppliers first).
    var flippedSupplier = (suppliers.length === 1) ? suppliers[0] : '';

    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px;';
    back.addEventListener('click', function (e) { if (e.target === back) closeModal(); });

    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;color:#12241b;font:400 14px ' + FONT + ';width:520px;max-width:100%;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden;';

    var head = document.createElement('div');
    head.style.cssText = 'background:#0d3d26;color:#fff;padding:16px 20px;font-weight:600;font-size:16px;display:flex;justify-content:space-between;align-items:center;';
    head.innerHTML = '<span>Log Credit Card Purchase</span>';
    var x = document.createElement('button');
    x.textContent = '×';
    x.style.cssText = 'background:none;border:none;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0 4px;';
    x.addEventListener('click', closeModal);
    head.appendChild(x);

    var form = document.createElement('form');
    form.style.cssText = 'padding:18px 20px 8px;';
    form.setAttribute('autocomplete', 'off');

    var inputs = {};
    var lblCss = 'display:block;font-weight:600;font-size:12px;margin:0 0 4px;color:#33473d;';
    var inCss = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #c6d2cc;border-radius:8px;font:400 14px ' + FONT + ';background:#fff;color:#12241b;';

    FIELDS.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:13px;';
      var lbl = document.createElement('label');
      lbl.style.cssText = lblCss;
      lbl.textContent = f.label + (f.required ? ' *' : '');
      var el;
      if (f.type === 'textarea') {
        el = document.createElement('textarea');
        el.rows = 3; el.style.cssText = inCss + 'resize:vertical;';
      } else if (f.type === 'select') {
        // Card Used = the user-maintained pick-list + an inline "add a card" option.
        el = document.createElement('select');
        el.style.cssText = inCss;
        rebuildCardOptions(el, GM_getValue('cc_card_last', ''));
        el.addEventListener('change', function () {
          if (el.value === ADD_CARD) {
            var before = GM_getValue('cc_card_last', '');
            var list = manageCards();
            var pick = (list && list.length) ? list[list.length - 1] : '';
            rebuildCardOptions(el, pick || before);
          }
        });
      } else {
        el = document.createElement('input');
        el.type = (f.type === 'date') ? 'date' : (f.type === 'url' ? 'url' : (f.type === 'money' ? 'text' : 'text'));
        if (f.type === 'money') { el.inputMode = 'decimal'; }
        el.style.cssText = inCss;
        // Supplier: offer the WO's vendors as type-ahead suggestions (still free text,
        // since retail buys aren't the dispatched vendor).
        if (f.list && woVendors.length) {
          var dl = document.createElement('datalist');
          dl.id = 'ccp_dl_' + f.key;
          woVendors.forEach(function (v) { var o = document.createElement('option'); o.value = v; dl.appendChild(o); });
          el.setAttribute('list', dl.id);
          wrap.appendChild(dl);
        }
      }
      if (f.ph && f.type !== 'select') el.placeholder = f.ph;
      // Sensible defaults / job prefill
      if (f.key === 'Date') el.value = todayISO();
      if (f.key === 'CardUser') el.value = me.name || '';
      if (f.key === 'SupplierName' && flippedSupplier) el.value = flippedSupplier;   // the PO line flipped to "Supplier"
      if (f.key === 'WorkOrderNumber' && woId) el.value = woId;   // digits from the URL = the W-###### the flow links to
      if (f.key === 'LineItemDescription' && (bus && (bus.client || bus.location))) {
        var ctx = 'For W-' + (woId || (bus.wo || '').replace(/^W-?/i, ''));
        if (bus.client) ctx += ' - ' + bus.client;
        if (bus.location) ctx += ', ' + bus.location;
        el.value = ctx + ': ';
      }
      lbl.setAttribute('for', 'ccp_' + f.key);
      el.id = 'ccp_' + f.key;
      inputs[f.key] = el;
      wrap.appendChild(lbl); wrap.appendChild(el);
      form.appendChild(wrap);
    });

    // Auto-sum Total = Subtotal + Tax unless the user has hand-edited Total.
    var totalTouched = false;
    inputs.TotalAmount.addEventListener('input', function () { totalTouched = true; });
    function recalcTotal() {
      if (totalTouched) return;
      var s = parseFloat(cleanMoney(inputs.Subtotal.value)) || 0;
      var t = parseFloat(cleanMoney(inputs.TaxAmount.value)) || 0;
      if (inputs.Subtotal.value || inputs.TaxAmount.value) inputs.TotalAmount.value = (s + t).toFixed(2);
    }
    inputs.Subtotal.addEventListener('input', recalcTotal);
    inputs.TaxAmount.addEventListener('input', recalcTotal);

    // Receipt (v2): optional file, uploaded to /api/cc-receipt on submit -> a link that the
    // flow writes into the Receipt HYPERLINK cell. Not one of the flow's 10 text props.
    var rWrap = document.createElement('div');
    rWrap.style.cssText = 'margin-bottom:13px;';
    var rLbl = document.createElement('label');
    rLbl.style.cssText = lblCss;
    rLbl.textContent = 'Receipt (optional)';
    var receiptInput = document.createElement('input');
    receiptInput.type = 'file';
    receiptInput.accept = 'image/*,application/pdf';
    receiptInput.id = 'ccp_Receipt';
    receiptInput.style.cssText = 'width:100%;box-sizing:border-box;font:400 13px ' + FONT + ';color:#12241b;';
    rLbl.setAttribute('for', 'ccp_Receipt');
    rWrap.appendChild(rLbl); rWrap.appendChild(receiptInput);
    form.appendChild(rWrap);

    var msg = document.createElement('div');
    msg.style.cssText = 'min-height:18px;color:#b4231f;font-size:12.5px;margin:2px 0 10px;';

    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding:6px 0 14px;';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:9px 16px;border:1px solid #c6d2cc;background:#fff;color:#33473d;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    cancel.addEventListener('click', closeModal);
    var submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = 'Submit purchase';
    submit.style.cssText = 'padding:9px 18px;border:none;background:#0d3d26;color:#fff;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    foot.appendChild(cancel); foot.appendChild(submit);

    form.appendChild(msg);
    form.appendChild(foot);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';

      var key = GM_getValue('ingest_key', '');
      if (!key) { msg.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }

      // Gather + validate.
      var payload = { actor: me.email || me.name || 'unknown' };
      var missing = [];
      FIELDS.forEach(function (f) {
        var v = (inputs[f.key].value || '').trim();
        if (f.type === 'select' && (v === ADD_CARD)) v = '';   // the "add" sentinel is not a value
        if (f.type === 'money') v = cleanMoney(v);
        if (f.required && !v) missing.push(f.label);
        payload[f.key] = v;
      });
      if (payload.CardUsed) GM_setValue('cc_card_last', payload.CardUsed);   // prefill this card next time
      if (missing.length) { msg.textContent = 'Required: ' + missing.join(', '); return; }
      if (payload.PurchaseLink && !/^https?:\/\//i.test(payload.PurchaseLink)) {
        msg.textContent = 'Purchase Link must start with http:// or https:// (or leave it blank).'; return;
      }

      var reenable = function () { submit.disabled = false; submit.textContent = 'Submit purchase'; };
      submit.disabled = true;

      // Optional receipt: upload it FIRST (so a failure blocks the log + tells the user),
      // then include the returned link in the purchase POST.
      var file = receiptInput.files && receiptInput.files[0];
      if (file && file.size > MAX_RECEIPT) { reenable(); msg.textContent = 'Receipt is larger than 10 MB - use a smaller file or skip it.'; return; }
      var getReceiptLink = Promise.resolve('');
      if (file) {
        submit.textContent = 'Uploading receipt…';
        getReceiptLink = readFileB64(file).then(function (f) {
          return gmPost(RECEIPT_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key },
            { actor: payload.actor, filename: f.filename, contentType: f.contentType, dataB64: f.dataB64, woNumber: payload.WorkOrderNumber }, 60000)
            .then(function (r) {
              if (r.status >= 200 && r.status < 300 && r.json && r.json.ok && r.json.link) return r.json.link;
              throw new Error('Receipt upload failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : ''));
            });
        });
      }

      getReceiptLink.then(function (link) {
        if (link) payload.ReceiptLink = link;
        submit.textContent = 'Submitting…';
        return gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 30000);
      }).then(function (r) {
        if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
          closeModal();
          toast('Credit card purchase logged ✓  (' + (payload.SupplierName || '') + ' - $' + (payload.TotalAmount || '0') + ')', 6000);
        } else if (r.status === 403) {
          reenable(); msg.textContent = 'Rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.';
        } else if (r.status === 429) {
          reenable(); msg.textContent = 'Too many submissions in a row - wait a moment and try again.';
        } else {
          reenable(); msg.textContent = 'Submit failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : '') + '.';
        }
      }).catch(function (err) {
        reenable(); msg.textContent = (err && err.message ? err.message : 'could not reach the proxy') + '.';
      });
    });

    card.appendChild(head); card.appendChild(form);
    back.appendChild(card);
    document.body.appendChild(back);
    openEl = back;
    document.addEventListener('keydown', onKey);
    var first = inputs.CardUser && !inputs.CardUser.value ? inputs.CardUser : inputs.SupplierName;
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  // ---- Floating launcher button -------------------------------------------
  function addLauncher() {
    if (document.getElementById('bwn-ccp-launch')) return;
    var b = document.createElement('button');
    b.id = 'bwn-ccp-launch';
    b.title = 'Log a credit card purchase';
    b.textContent = '💳 CC Purchase';
    b.style.cssText = 'position:fixed;z-index:2147483645;right:18px;bottom:18px;background:#0d3d26;color:#fff;border:none;border-radius:24px;padding:11px 16px;font:600 13px ' + FONT + ';cursor:pointer;box-shadow:0 6px 20px rgba(13,38,26,.35);';
    b.addEventListener('click', buildModal);
    document.body.appendChild(b);
  }

  // ---- Tampermonkey menu --------------------------------------------------
  try {
    GM_registerMenuCommand('Log a Credit Card Purchase', buildModal);
    GM_registerMenuCommand('Manage saved cards', manageCards);
    GM_registerMenuCommand('Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', GM_getValue('ingest_key', '') || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { /* menu API absent - launcher button still works */ }

  addLauncher();
})();
