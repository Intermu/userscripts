// ==UserScript==
// @name         BWN Vendor Intake (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-vendor-intake.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-vendor-intake.user.js
// @description  Prefills Umbrava's Create Vendor form from a Prospect Set-Up Form. Adds a "Prefill from document" button to the modal: you pick the filled PDF, it reads the fields in the browser and fills Company, contact name/email/phone, Type, and the address, then opens the Trade(s) list for you to pick. It flags when Umbrava already has a matching vendor. Entity is left for you (the W-9 says C vs S corp, and that file is a scanned image). Runs entirely in the browser - no network access, no keys, nothing leaves your machine.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.1.0';
  console.info('[BWN VENDOR INTAKE] v' + VER + ' - prefill Create Vendor from the Prospect Set-Up Form (local PDF parse, zero egress)');

  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";

  // ---- Toast --------------------------------------------------------------
  function toast(msg, ms) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;right:18px;z-index:2147483647;background:#0d3d26;color:#fff;padding:11px 16px;border-radius:8px;font:400 14px ' + FONT + ';box-shadow:0 6px 24px rgba(13,38,26,.3);max-width:440px;line-height:1.45;';
    t.textContent = 'Vendor Intake: ' + msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 8000);
  }

  // ---- PDF field read (local; fillable AcroForm /T name /V value) ---------
  // The Prospect Set-Up Form is a fillable PDF, so its values live in the form
  // fields. Read the raw bytes and pull /T(name) .. /V(value) pairs; if the form
  // was saved compressed, inflate the FlateDecode streams and read those too.
  function latin1(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; }
  function unesc(x) { return String(x).replace(/\\([()\\])/g, '$1').replace(/\\([0-7]{1,3})/g, function (_, o) { return String.fromCharCode(parseInt(o, 8)); }); }
  function fieldsFromStr(s) {
    var out = {}, re = /\/T\s*\(((?:\\.|[^)\\])*)\)[\s\S]{0,900}?\/V\s*\(((?:\\.|[^)\\])*)\)/g, m;
    while ((m = re.exec(s))) { var k = unesc(m[1]).trim(), v = unesc(m[2]).trim(); if (k && v && !(k in out)) out[k] = v; }
    return out;
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') return null;
    var fmts = ['deflate', 'deflate-raw'];
    for (var i = 0; i < fmts.length; i++) {
      try {
        var ds = new DecompressionStream(fmts[i]);
        var ab = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
        return new Uint8Array(ab);
      } catch (e) { /* try next */ }
    }
    return null;
  }
  async function inflateAll(u8) {
    var s = latin1(u8), re = /stream\r?\n/g, m, chunks = [];
    while ((m = re.exec(s))) {
      var start = m.index + m[0].length, end = s.indexOf('endstream', start);
      if (end < 0) continue;
      var inf = await inflate(u8.subarray(start, end));
      if (inf) chunks.push(inf);
    }
    if (!chunks.length) return null;
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0), all = new Uint8Array(total), off = 0;
    chunks.forEach(function (c) { all.set(c, off); off += c.length; });
    return all;
  }
  async function parseProspect(file) {
    var u8 = new Uint8Array(await file.arrayBuffer());
    var f = fieldsFromStr(latin1(u8));
    if (!f.company_name && !f.email && !f.contact_names) {
      var infl = await inflateAll(u8);
      if (infl) Object.assign(f, fieldsFromStr(latin1(infl)));
    }
    return f;
  }

  // ---- Field mapping ------------------------------------------------------
  function firstEmail(s) { var m = String(s || '').match(/[^\s,;<>]+@[^\s,;<>]+\.[A-Za-z]{2,}/); return m ? m[0] : ''; }
  function firstName(s) { return String(s || '').split(/[,;\/]|\band\b/i)[0].trim(); }
  function firstTrade(s) { return String(s || '').split(/[,;\/]/)[0].trim(); }
  function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }
  function splitAddr(a) {
    a = String(a || '').trim();
    var out = { street: '', city: '', state: '', zip: '' };
    if (!a) return out;
    var parts = a.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    var last = parts[parts.length - 1] || '';
    var mz = last.match(/\b([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b/);
    if (mz) { out.state = mz[1].toUpperCase(); out.zip = mz[2]; }
    if (parts.length >= 3) { out.street = parts[0]; out.city = parts[1]; }
    else if (parts.length === 2) { out.street = parts[0]; out.city = parts[1].replace(/\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\s*$/, '').trim(); }
    else { out.street = parts[0] || ''; }
    return out;
  }

  // ---- Form fill helpers (validated live 2026-07-14) ----------------------
  function setNativeValue(el, val) {
    var proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function modalRoot() {
    var c = document.querySelector('input[name="details.companyName"]');
    return c ? (c.closest('.MuiDialog-container, [role="dialog"], .MuiPaper-root') || document) : null;
  }
  function fieldByLabel(root, re) {
    var lbls = [...root.querySelectorAll('label')];
    var lbl = lbls.find(function (l) { return re.test((l.textContent || '').trim()); });
    if (!lbl) return null;
    var fc = lbl.closest('.MuiFormControl-root') || lbl.parentElement;
    return fc ? fc.querySelector('input,select,textarea') : null;
  }
  function setSelectByText(sel, txt) {
    var t = String(txt || '').toLowerCase();
    if (!t) return false;
    var opt = [...sel.options].find(function (o) {
      var ov = (o.value || '').toLowerCase(), ot = (o.textContent || '').trim().toLowerCase();
      return ov === t || ot === t || ot.indexOf(t) === 0;
    });
    if (opt) { setNativeValue(sel, opt.value); return true; }
    return false;
  }
  // Type is a MUI multi-select: open, click the option, close with Escape (never
  // click the backdrop - that can close the whole dialog).
  function setType(label) {
    try {
      var trig = document.getElementById('mui-component-select-details.vendorTypes');
      if (!trig || new RegExp(label, 'i').test(trig.textContent || '')) return;
      trig.click();
      setTimeout(function () {
        var menu = document.querySelector('ul[role="listbox"]');
        var opt = menu ? [...menu.querySelectorAll('[role="option"],li')].find(function (o) { return new RegExp('^' + label + '$', 'i').test((o.textContent || '').trim()); }) : null;
        if (opt) opt.click();
        (menu || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      }, 200);
    } catch (e) { /* Type stays for manual pick */ }
  }
  // Trade(s) is a MUI Autocomplete with a nested taxonomy; a programmatic pick is
  // unreliable, so type the value to open the filtered list and let the user pick.
  function pretypeTrade(root, trade) {
    if (!trade) return false;
    var input = fieldByLabel(root, /^Trade\(s\)/) || (root.querySelector('.MuiAutocomplete-root input'));
    if (!input) return false;
    input.focus();
    setNativeValue(input, trade);
    return true;
  }

  function fillStep1(root, f) {
    var done = [];
    var q = function (n) { return root.querySelector('input[name="' + n + '"]'); };
    var set = function (n, v, lbl) { var el = q(n); if (el && v) { setNativeValue(el, v); done.push(lbl); } };
    set('details.companyName', f.company_name, 'Company');
    set('details.contactName', firstName(f.contact_names), 'Name');
    set('details.contactEmail', firstEmail(f.email), 'Email');
    var tel = root.querySelector('input[type="tel"]');
    if (tel && f.phone) { setNativeValue(tel, digits(f.phone)); done.push('Phone'); }
    setType('Contractor');
    return done;
  }

  // Step 2 (Address) renders after Next. Watch for its fields, fill once.
  function watchStep2(addr) {
    if (!addr.street && !addr.city && !addr.zip) return;
    var filled = false;
    var obs = new MutationObserver(function () {
      if (filled) return;
      var root = document.querySelector('.MuiDialog-container, [role="dialog"]');
      if (!root) return;
      var street = fieldByLabel(root, /^Street/);
      if (!street) return;
      filled = true; obs.disconnect();
      var setL = function (re, v) { var el = fieldByLabel(root, re); if (el && v) { if (el.tagName === 'SELECT') setSelectByText(el, v); else setNativeValue(el, v); } };
      setL(/^Street/, addr.street);
      setL(/^City/, addr.city);
      setL(/^Postal Code|^Zip/, addr.zip);
      var st = fieldByLabel(root, /^State\/Province|^State/);
      if (st && addr.state) { if (st.tagName === 'SELECT') setSelectByText(st, addr.state); else setNativeValue(st, addr.state); }
      var nm = fieldByLabel(root, /^Name/); if (nm && !nm.value) setNativeValue(nm, 'Business');
      toast('Filled the address on step 2. Check State/Province and Country, then Validate.', 9000);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { obs.disconnect(); }, 300000);
  }

  // Umbrava shows its own "Vendor may already exist" banner; surface it so a dup
  // isn't created by accident.
  function surfaceDup(root) {
    setTimeout(function () {
      var hit = [...root.querySelectorAll('*')].find(function (e) { return /may already exist/i.test(e.textContent || '') && e.children.length < 6; });
      if (hit) toast('Umbrava flags a possible existing vendor - check the banner before saving.', 10000);
    }, 400);
  }

  async function handleFile(file) {
    try {
      toast('Reading ' + file.name + ' ...', 4000);
      var f = await parseProspect(file);
      if (!f.company_name && !f.email && !f.contact_names) {
        toast('Could not read fields from that PDF. Use the filled Prospect Set-Up Form (a fillable PDF), not a scan or the W-9.', 11000);
        return;
      }
      var root = modalRoot();
      if (!root) { toast('Open the Create Vendor form first, then use Prefill.', 8000); return; }
      var addr = splitAddr(f.mailing_addr);
      var done = fillStep1(root, f);
      var trade = firstTrade(f.trades);
      var typed = pretypeTrade(root, trade);
      watchStep2(addr);
      surfaceDup(root);
      var notes = [];
      if (done.length) notes.push('Filled ' + done.join(', ') + ', Type=Contractor');
      if (typed) notes.push('typed Trade(s) "' + trade + '" - pick it from the list');
      notes.push('set Entity yourself (C vs S corp)');
      if (addr.street) notes.push('address fills on step 2');
      toast(notes.join(' · '), 12000);
    } catch (e) { toast('Prefill failed: ' + ((e && e.message) || e), 10000); }
  }

  // ---- Inject the button into the Create Vendor modal ---------------------
  function injectButton() {
    var company = document.querySelector('input[name="details.companyName"]');
    if (!company) return;
    var modal = company.closest('.MuiPaper-root') || company.closest('.MuiDialog-container, [role="dialog"]');
    if (!modal || modal.querySelector('#bwn-vi-bar')) return;
    var bar = document.createElement('div'); bar.id = 'bwn-vi-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 0 10px;';
    var btn = document.createElement('button'); btn.id = 'bwn-vi-btn'; btn.type = 'button';
    btn.textContent = '📄 Prefill from document';
    btn.style.cssText = 'background:#1a5f3e;color:#fff;border:none;border-radius:8px;padding:8px 14px;font:500 14px ' + FONT + ';cursor:pointer;';
    var hint = document.createElement('span');
    hint.textContent = 'Prospect Set-Up Form (PDF)';
    hint.style.cssText = 'font:400 12px ' + FONT + ';color:#5a6b62;';
    var file = document.createElement('input'); file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.style.display = 'none';
    btn.addEventListener('click', function () { file.value = ''; file.click(); });
    file.addEventListener('change', function () { if (file.files && file.files[0]) handleFile(file.files[0]); });
    bar.appendChild(btn); bar.appendChild(hint); bar.appendChild(file);
    // Put it just above the first field row.
    var row = company.closest('.MuiGrid-container') || company.closest('form') || company.parentElement;
    if (row && row.parentElement) row.parentElement.insertBefore(bar, row);
    else modal.insertBefore(bar, modal.firstChild);
  }

  var obs = new MutationObserver(function () { injectButton(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(injectButton, 800);
  injectButton();
})();
