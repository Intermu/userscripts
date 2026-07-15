// ==UserScript==
// @name         BWN Vendor Intake (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.2.0
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

  var VER = '0.2.0';
  console.info('[BWN VENDOR INTAKE] v' + VER + ' - prefill Create Vendor from the Prospect Set-Up Form or a fillable W-9 (local PDF parse, zero egress; TIN stays local)');

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

  // ---- W-9 (best-effort, local) -------------------------------------------
  // A FILLABLE IRS W-9 is an AcroForm too, but its field NAMES are cryptic (f1_01 ...),
  // so we map by each field's TOOLTIP (/TU) - the human description - the way Core reads
  // MUI fields by label. A SIGNED/SCANNED W-9 is an image with no form fields: it yields
  // nothing here and is handled with a manual-entry message (OCR is the separate next stage).
  // Everything stays local; the TIN is never logged, toasted, or sent anywhere.
  function acroFieldsFromStr(s) {
    // For each /T(name), look a short window ahead for its /TU(tooltip) + /V(value) (same
    // dict; key order varies). Best-effort: a miss just leaves that field empty.
    var out = { byTip: [], text: '' }, re = /\/T\s*\(((?:\\.|[^)\\])*)\)/g, m;
    while ((m = re.exec(s))) {
      var win = s.slice(m.index, m.index + 1600);
      var tu = win.match(/\/TU\s*\(((?:\\.|[^)\\])*)\)/);
      var v = win.match(/\/V\s*\(((?:\\.|[^)\\])*)\)/);
      var tip = tu ? unesc(tu[1]).trim() : '';
      var val = v ? unesc(v[1]).trim() : '';
      if (tip) out.byTip.push({ tip: tip, value: val });
      if (val) out.text += ' ' + val;
    }
    return out;
  }
  function looksLikeW9(af) {
    return af.byTip.some(function (t) {
      return /income tax return|employer identification|backup withholding|taxpayer identification|federal tax classification|\bw-?9\b/i.test(t.tip);
    });
  }
  function classToEntity(c) {
    var s = String(c || '').toLowerCase();
    if (!s) return '';
    // Individual / sole-prop / SINGLE-member LLC is its own W-9 box - check BEFORE the
    // generic LLC branch (which is for LLCs taxed as C / S / Partnership).
    if (/individual|sole\s*propriet|single[\s-]*member/.test(s)) return 'Individual_Or_Single_Member_LLC';
    if (/\bllc\b|limited liability/.test(s)) {
      if (/\bc\b|c[\s-]*corp/.test(s)) return 'LLC_C_Corp';
      if (/\bs\b|s[\s-]*corp/.test(s)) return 'LLC_S_Corp';
      if (/\bp\b|partnership/.test(s)) return 'LLC_Partnership';
      return 'LLC';
    }
    if (/c[\s-]*corp/.test(s)) return 'C_Corp';
    if (/s[\s-]*corp/.test(s)) return 'S_Corp';
    if (/partnership/.test(s)) return 'Partnership';
    if (/trust|estate/.test(s)) return 'Trust_Estate';
    if (/other/.test(s)) return 'Other';
    return '';
  }
  function findTIN(text) {
    var s = String(text || '');
    var ein = s.match(/\b(\d{2}-\d{7})\b/); if (ein) return { tin: ein[1], kind: 'ein' };
    var ssn = s.match(/\b(\d{3}-\d{2}-\d{4})\b/); if (ssn) return { tin: ssn[1], kind: 'ssn' };
    var m = s.match(/(?:EIN|employer identification|TIN|tax\s*id)\D{0,12}(\d[\d\s-]{7,}\d)/i);
    if (m) { var d = m[1].replace(/\D/g, ''); if (d.length === 9) return { tin: d.slice(0, 2) + '-' + d.slice(2), kind: 'ein' }; }
    return { tin: '', kind: '' };
  }
  function extractW9(af) {
    var out = { name: '', dba: '', entity: '', street: '', city: '', state: '', zip: '', tin: '', tinKind: '' };
    function byTip(reArr) {
      for (var i = 0; i < reArr.length; i++) {
        var h = af.byTip.filter(function (t) { return reArr[i].test(t.tip) && t.value; });
        if (h.length) return h[0].value;
      }
      return '';
    }
    out.name = byTip([/name.*(income tax|shown on|line 1)/i, /^name\b/i]);
    out.dba = byTip([/business name|disregarded entity|line 2|doing business/i]);
    out.street = byTip([/address.*(number|street|apt|suite)/i, /^address\b/i]);
    var csz = byTip([/city.*state.*zip/i]);
    if (csz) {
      var mz = csz.match(/(.+?),?\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
      if (mz) { out.city = mz[1].replace(/,\s*$/, '').trim(); out.state = mz[2].toUpperCase(); out.zip = mz[3]; }
      else out.city = csz;
    }
    // Classification: a checked box has a set value (not "Off"); read its tooltip/value.
    var cls = af.byTip.filter(function (t) {
      return t.value && !/^off$/i.test(t.value) && /tax classification|c corp|s corp|partnership|sole propriet|single.member|trust|estate|limited liability|individual/i.test(t.tip);
    });
    if (cls.length) out.entity = classToEntity(cls[0].tip) || classToEntity(cls[0].value);
    var tt = findTIN(af.text); out.tin = tt.tin; out.tinKind = tt.kind;
    return out;
  }
  async function readDoc(file) {
    var u8 = new Uint8Array(await file.arrayBuffer());
    var raw = latin1(u8);
    var prospect = fieldsFromStr(raw);
    var af = acroFieldsFromStr(raw);
    if (!prospect.company_name && !looksLikeW9(af)) {
      var infl = await inflateAll(u8);
      if (infl) { var r2 = latin1(infl); Object.assign(prospect, fieldsFromStr(r2)); var af2 = acroFieldsFromStr(r2); af.byTip = af.byTip.concat(af2.byTip); af.text += af2.text; }
    }
    var kind = looksLikeW9(af) ? 'w9' : (prospect.company_name || prospect.email || prospect.contact_names) ? 'prospect' : (af.byTip.length ? 'unknown' : 'scan');
    return { kind: kind, prospect: prospect, w9: extractW9(af) };
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

  // Watch for the Create-flow Billing step (step 3) and fill its Tax ID once. Separate from
  // watchStep2 (address). The TIN is filled straight in and never logged/toasted as a value.
  function watchBillingStep(tin) {
    if (!tin) return;
    var filled = false;
    var obs = new MutationObserver(function () {
      if (filled) return;
      var el = document.querySelector('input[name="billing.taxId"]');
      if (!el) return;
      filled = true; obs.disconnect();
      setNativeValue(el, tin);
      toast('Filled the Tax ID on the Billing step (kept local - not sent anywhere).', 8000);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { obs.disconnect(); }, 300000);
  }

  function fillFromProspect(root, f) {
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
  }

  function fillFromW9(root, w9) {
    var done = [];
    var q = function (n) { return root.querySelector('input[name="' + n + '"]'); };
    if (w9.name) { var c = q('details.companyName'); if (c) { setNativeValue(c, w9.name); done.push('Company'); } }
    if (w9.dba) { var d = q('details.doingBusinessAs'); if (d) { setNativeValue(d, w9.dba); done.push('DBA'); } }
    if (w9.entity) { var e = root.querySelector('select[name="details.entity"]'); if (e) { setNativeValue(e, w9.entity); done.push('Entity'); } }
    surfaceDup(root);
    if (w9.street || w9.city || w9.zip) watchStep2({ street: w9.street, city: w9.city, state: w9.state, zip: w9.zip });
    if (w9.tin) watchBillingStep(w9.tin);   // Billing step, step 3
    var notes = ['From W-9:'];
    if (done.length) notes.push('filled ' + done.join(', '));
    if (w9.street) notes.push('address on step 2');
    if (w9.tin) notes.push('Tax ID on the Billing step (kept local)');  // never the value
    if (!w9.entity) notes.push('confirm Entity');
    notes.push('review before Create');
    toast(notes.join(' · '), 13000);
  }

  async function handleFile(file) {
    try {
      toast('Reading ' + file.name + ' ...', 4000);
      var doc = await readDoc(file);
      var root = modalRoot();
      if (!root) { toast('Open the Create Vendor form first, then use Prefill.', 8000); return; }
      if (doc.kind === 'w9') return fillFromW9(root, doc.w9);
      if (doc.kind === 'prospect') return fillFromProspect(root, doc.prospect);
      if (doc.kind === 'scan') { toast('That looks like a scanned/printed PDF (an image, no form fields). Scanned-W-9 reading (OCR) is the next stage - for now enter the tax fields manually.', 12000); return; }
      toast('Could not read fields from that PDF. Use the filled Prospect Set-Up Form or a fillable IRS W-9 (a form you type into, not a scan).', 12000);
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
    hint.textContent = 'Prospect Form or fillable W-9 (PDF)';
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

  // For an EXISTING vendor: the detail-page "Edit Billing" dialog has input[name="taxId"]
  // (note: no "billing." prefix, unlike the create flow). Inject a button that reads a W-9
  // locally and fills just the Tax ID there. TIN stays local; never persisted or sent.
  function injectBillingButton() {
    var tax = document.querySelector('input[name="taxId"]');
    if (!tax) return;
    var modal = tax.closest('.MuiPaper-root') || tax.closest('.MuiDialog-container, [role="dialog"]');
    if (!modal || modal.querySelector('#bwn-vi-bill-bar')) return;
    var bar = document.createElement('div'); bar.id = 'bwn-vi-bill-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 0 10px;';
    var btn = document.createElement('button'); btn.type = 'button';
    btn.textContent = '📄 Fill Tax ID from W-9';
    btn.style.cssText = 'background:#1a5f3e;color:#fff;border:none;border-radius:8px;padding:6px 12px;font:500 13px ' + FONT + ';cursor:pointer;';
    var hint = document.createElement('span'); hint.textContent = 'reads the W-9 locally'; hint.style.cssText = 'font:400 12px ' + FONT + ';color:#5a6b62;';
    var file = document.createElement('input'); file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.style.display = 'none';
    btn.addEventListener('click', function () { file.value = ''; file.click(); });
    file.addEventListener('change', function () {
      if (!file.files || !file.files[0]) return;
      readDoc(file.files[0]).then(function (doc) {
        var el = document.querySelector('input[name="taxId"]');
        if (doc.w9 && doc.w9.tin && el) { setNativeValue(el, doc.w9.tin); toast('Filled Tax ID from the W-9 (kept local).', 7000); }
        else if (doc.kind === 'scan') toast('Scanned W-9 (image) - OCR support is the next stage; enter the Tax ID manually for now.', 9000);
        else toast('Could not read a Tax ID from that file. Use a fillable IRS W-9.', 9000);
      }).catch(function (e) { toast('Read failed: ' + ((e && e.message) || e), 8000); });
    });
    bar.appendChild(btn); bar.appendChild(hint); bar.appendChild(file);
    var fc = tax.closest('.MuiFormControl-root, .MuiTextField-root') || tax.parentElement;
    if (fc && fc.parentElement) fc.parentElement.insertBefore(bar, fc);
    else modal.insertBefore(bar, modal.firstChild);
  }

  var obs = new MutationObserver(function () { injectButton(); injectBillingButton(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(function () { injectButton(); injectBillingButton(); }, 800);
  injectButton(); injectBillingButton();
})();
