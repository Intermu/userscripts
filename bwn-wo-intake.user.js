// ==UserScript==
// @name         BWN WO Intake (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.9.5
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-intake.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-intake.user.js
// @description  Drop a client PO/WO email (.msg or .eml) onto the Create Work Order modal and it prefills the fields. Pilot Travel Centers: from the email body. Caleres (Famous Footwear / Corrigo): reads the attached WO PDF on-device for Trade, Scope, Priority, Due-By, Store, NTE. If a Caleres request has no WO PDF (image-only), it reads Store, City/State and Trade from the subject and the scope from the body (NTE + Priority stay manual - they live only in the images). Amazon (Fairmarkit RFQ): the buyer is Amazon.com, Inc. but the sender is the Fairmarkit e-bidding platform - reads the RFQ body (no PDF) for Site (matched by the Amazon site code e.g. PIT2/STL3, else the shipping address), RFQ #, Trade, Scope + line items; NTE and Priority stay manual because an RFQ carries no ceiling yet (we are the quoting supplier). The email carries no attachment - the full scope / any 'see attached file' lives on the Fairmarkit bid page - so it surfaces that RFQ link and warns you when the body defers to it. Selects Client, Location (address-verified), Trade and Priority by clicking the real dropdown option; fills Client DNE, Source Job # and Source PO #; warns you if the WO PDF shows a cancel/flag note. Then, after you Create the WO, it hands the email to BWN Drop Upload to attach it to the new WO's Documents. Reads everything in the browser; nothing is uploaded to any server. Best-effort: review every field before you click Create.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  var VER = '0.9.5';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  console.info('[BWN WO INTAKE] v' + VER + ' - drop a PO / Amazon RFQ email (.msg/.eml) on Create Work Order to prefill + auto-attach to the new WO Documents (via Drop Upload); reads locally, nothing leaves the browser');

  function toast(msg, ms, bg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translate(-50%,10px);opacity:0;background:' + (bg || '#0d3d26') + ';color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:74vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.5;';
    document.body.appendChild(t);
    // The suite's shared toast motion (animation review 2026-08-10, five identical copies - the
    // sandboxes cannot share one). It used to pop in and fade out; it now enters the way it
    // leaves, on transitions so a replacement retargets, with reduced motion keeping the fade
    // and dropping the travel. Full rationale sits at the same block in bwn-dispatch.user.js.
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    void t.offsetHeight;                                   // flush the start state or the transition never runs
    t.style.transition = reduce ? 'opacity .3s ease' : 'opacity .3s ease, transform .3s ease';
    t.style.opacity = '1';
    t.style.transform = 'translate(-50%,0)';
    setTimeout(function () {
      t.style.transition = reduce ? 'opacity .4s ease' : 'opacity .4s ease, transform .4s ease';
      t.style.opacity = '0';
      if (!reduce) t.style.transform = 'translate(-50%,10px)';
      setTimeout(function () { t.remove(); }, 420);
    }, ms || 6000);
  }
  function setNativeValue(el, val) {
    var proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ---- Outlook .msg reader (OLE2/CFBF, local) -----------------------------
  // A .msg is a compound binary file; the body/subject/sender live in named streams (some in
  // scattered mini-FAT sectors, so string-scraping only gets fragments) and each embedded
  // attachment is its own `__attach_version1.0_#N` STORAGE with child streams. This reader follows
  // the FAT / mini-FAT chains AND walks the directory red-black tree so we can pull both. In-browser.
  function parseCFBF(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, false) !== 0xD0CF11E0) return null;   // not a compound file
    var u32 = function (o) { return dv.getUint32(o, true); };
    var secSz = 1 << dv.getUint16(30, true), miniSz = 1 << dv.getUint16(32, true);
    var dirStart = u32(48), miniCut = u32(56), miniFatStart = u32(60), difatStart = u32(68);
    var secOff = function (s) { return 512 + s * secSz; };
    var fatSecs = []; for (var i = 0; i < 109; i++) { var s = u32(76 + i * 4); if (s !== 0xFFFFFFFF) fatSecs.push(s); }
    var dsx = difatStart, g = 0; while (dsx !== 0xFFFFFFFE && dsx !== 0xFFFFFFFF && g++ < 1000) { var b = secOff(dsx); for (var j = 0; j < secSz / 4 - 1; j++) { var s2 = u32(b + j * 4); if (s2 !== 0xFFFFFFFF) fatSecs.push(s2); } dsx = u32(b + secSz - 4); }
    var fat = []; fatSecs.forEach(function (f) { var base = secOff(f); for (var k = 0; k < secSz / 4; k++) fat.push(u32(base + k * 4)); });
    function chain(start, arr) { var o = [], s = start, gg = 0; while (s !== 0xFFFFFFFE && s !== 0xFFFFFFFF && gg++ < 1e6) { o.push(s); s = arr[s]; if (s == null) break; } return o; }
    function readFAT(start) { var secs = chain(start, fat), out = new Uint8Array(secs.length * secSz); secs.forEach(function (s, i) { out.set(u8.subarray(secOff(s), secOff(s) + secSz), i * secSz); }); return out; }
    var dir = readFAT(dirStart), entries = [];
    // Keep EVERY 128-byte slot so entries[did] is addressable by directory-id - the tree's
    // left/right/child pointers are DIDs, so skipping empty slots would shift every index.
    for (var o2 = 0; o2 + 128 <= dir.length; o2 += 128) {
      var nameLen = dir[o2 + 64] | (dir[o2 + 65] << 8);
      var name = ''; for (var q = 0; q < Math.max(0, nameLen - 2); q += 2) { var c = dir[o2 + q] | (dir[o2 + q + 1] << 8); if (c) name += String.fromCharCode(c); }
      entries.push({
        did: entries.length, name: name, type: dir[o2 + 66],
        left: dir[o2 + 68] | (dir[o2 + 69] << 8) | (dir[o2 + 70] << 16) | (dir[o2 + 71] * 16777216),
        right: dir[o2 + 72] | (dir[o2 + 73] << 8) | (dir[o2 + 74] << 16) | (dir[o2 + 75] * 16777216),
        child: dir[o2 + 76] | (dir[o2 + 77] << 8) | (dir[o2 + 78] << 16) | (dir[o2 + 79] * 16777216),
        startSec: dir[o2 + 116] | (dir[o2 + 117] << 8) | (dir[o2 + 118] << 16) | (dir[o2 + 119] * 16777216),
        size: (dir[o2 + 120] | (dir[o2 + 121] << 8) | (dir[o2 + 122] << 16) | (dir[o2 + 123] * 16777216))
      });
    }
    var root = entries.filter(function (e) { return e.type === 5; })[0];
    var mini = root ? readFAT(root.startSec).subarray(0, root.size) : new Uint8Array(0);
    var mfBuf = miniFatStart === 0xFFFFFFFE ? new Uint8Array(0) : readFAT(miniFatStart), miniFat = [];
    for (var mm = 0; mm + 4 <= mfBuf.length; mm += 4) miniFat.push(mfBuf[mm] | (mfBuf[mm + 1] << 8) | (mfBuf[mm + 2] << 16) | (mfBuf[mm + 3] * 16777216));
    function readStream(e) {
      if (e.size >= miniCut) return readFAT(e.startSec).subarray(0, e.size);
      var secs = chain(e.startSec, miniFat), out = new Uint8Array(secs.length * miniSz);
      secs.forEach(function (s, i) { out.set(mini.subarray(s * miniSz, s * miniSz + miniSz), i * miniSz); });
      return out.subarray(0, e.size);
    }
    var NIL = 0xFFFFFFFF;
    function childrenOf(did) {   // in-order walk of the red-black tree hanging off entries[did].child
      var out = [], e = entries[did]; if (!e || e.child === NIL) return out;
      (function walk(d) { if (d === NIL || d == null) return; var n = entries[d]; if (!n) return; walk(n.left); out.push(n); walk(n.right); })(e.child);
      return out;
    }
    var topByName = {}; if (root) childrenOf(root.did).forEach(function (e) { topByName[e.name] = e; });
    return {
      // message-level property streams live directly under the root storage
      get: function (tag) { var e = topByName['__substg1.0_' + tag]; return e ? readStream(e) : null; },
      // each embedded attachment is a `__attach_version1.0_#N` storage under the root; pull its
      // filename (3707 long / 3704 short) + mime (370E) + data (37010102 = PR_ATTACH_DATA_BIN)
      attachments: function () {
        if (!root) return [];
        var out = [];
        childrenOf(root.did).forEach(function (e) {
          if (e.type !== 1 || !/^__attach_version1\.0_/i.test(e.name)) return;
          var byName = {}; childrenOf(e.did).forEach(function (k) { byName[k.name] = k; });
          function s(tag) { var x = byName['__substg1.0_' + tag]; return x ? readStream(x) : null; }
          var nm = utf16(s('3707001F')) || latin1(s('3707001E')) || utf16(s('3704001F')) || latin1(s('3704001E')) || '';
          var mime = utf16(s('370E001F')) || latin1(s('370E001E')) || '';
          var data = s('37010102');
          if (data && data.length) out.push({ name: (nm || ('attachment' + (out.length + 1))).replace(/[\r\n\/\\]/g, '_').trim(), mime: mime, bytes: data });
        });
        return out;
      }
    };
  }
  function utf16(b) { if (!b) return ''; var s = ''; for (var i = 0; i + 1 < b.length; i += 2) { var c = b[i] | (b[i + 1] << 8); if (c) s += String.fromCharCode(c); } return s; }
  function latin1(b) { if (!b) return ''; var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  function stripHtml(h) { return String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); }); }

  function parseMsg(u8) {
    var m = parseCFBF(u8);
    if (!m) return { subject: '', body: '', senderEmail: '', attachments: [] };
    var subject = utf16(m.get('0037001F'));
    var body = utf16(m.get('1000001F'));
    if (!body) { var html = m.get('10130102'); if (html) body = stripHtml(latin1(html)); }
    var sender = utf16(m.get('0C1F001F')) || utf16(m.get('0065001F'));
    if (!/@/.test(sender)) { var em = String(sender).match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/); sender = em ? em[0] : (String(latin1(m.get('0C1F001F') || new Uint8Array(0))).match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/) || [''])[0]; }
    var attachments = []; try { attachments = m.attachments(); } catch (e) { }
    return { subject: subject, body: body, senderEmail: (sender || '').toLowerCase(), attachments: attachments };
  }
  function parseEml(text) {
    var he = text.search(/\r?\n\r?\n/);
    var head = he >= 0 ? text.slice(0, he) : text;
    function h(name) { var mm = head.match(new RegExp('^' + name + ':\\s*(.*(?:\\r?\\n[ \\t].*)*)', 'im')); return mm ? mm[1].replace(/\r?\n[ \t]+/g, ' ').trim() : ''; }
    var from = h('From');
    var em = (from.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/) || [''])[0].toLowerCase();
    var body = he >= 0 ? text.slice(he) : '';
    if (/<[a-z!]/i.test(body)) body = stripHtml(body);
    body = body.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    return { subject: h('Subject'), body: body, senderEmail: em, attachments: [] };   // .eml MIME-part attachments not yet extracted
  }

  // ---- Email -> Work Order field mapping ----------------------------------
  var CLIENT_BY_DOMAIN = { 'pilottravelcenters.com': 'Pilot Travel Centers', 'staples.com': 'Staples', 'caleres.com': 'Caleres Inc' };
  function clientFromDomain(email) { var d = String(email || '').split('@')[1] || ''; return CLIENT_BY_DOMAIN[d] || d.replace(/\.(com|net|org|us|co)$/i, '').replace(/[.\-]/g, ' '); }

  // ---- PDF text reader (pure browser, on-device, no library) --------------
  // Some clients (Caleres/Corrigo) put the real WO detail in an attached PDF, not the email body.
  // These PDFs are TEXT with ToUnicode maps (not scans), so we inflate the content streams with the
  // native DecompressionStream, map glyph codes through the ToUnicode CMaps, and read the text ops -
  // no pdf.js, so the script stays @grant none (its post-create attach handoff needs page context).
  function inflate(bytes) {
    // FlateDecode is zlib; a few streams are raw deflate. DecompressionStream is STRICT about the
    // trailing bytes PDFs leave between the deflate data and "endstream" (it throws "trailing junk"),
    // so read the decompressed chunks manually and KEEP them when that end-of-stream error fires -
    // all valid output has already been delivered by then (byte-verified against zlib).
    function attempt(fmt) {
      return new Promise(function (resolve) {
        var d; try { d = new DecompressionStream(fmt); } catch (e) { resolve(null); return; }
        var chunks = [], total = 0;
        var w = d.writable.getWriter(); w.write(bytes).catch(function () { }); w.close().catch(function () { });
        var r = d.readable.getReader();
        (function pump() {
          r.read().then(function (x) { if (x.done) { fin(); return; } chunks.push(x.value); total += x.value.length; pump(); }).catch(function () { fin(); });
        })();
        function fin() { if (!chunks.length) { resolve(null); return; } var out = new Uint8Array(total), o = 0; chunks.forEach(function (c) { out.set(c, o); o += c.length; }); resolve(out); }
      });
    }
    return attempt('deflate').then(function (r) { return r || attempt('deflate-raw'); });
  }
  function latin1Of(u8) {   // byte -> code point 1:1, chunked so a multi-MB font stream doesn't stall
    var CH = 0x8000, parts = [];
    for (var i = 0; i < u8.length; i += CH) parts.push(String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length))));
    return parts.join('');
  }
  function hexToStr(h) { var o = ''; for (var k = 0; k + 4 <= h.length; k += 4) o += String.fromCharCode(parseInt(h.substr(k, 4), 16)); return o; }
  // Extract readable text from a PDF's bytes. Resolves to a spaced string ('' if not text-based).
  function pdfToText(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // 1) collect every stream's raw (compressed) bytes
    var raws = [], i = 0;
    var STREAM = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d], ENDS = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];
    function indexOfSeq(hay, seq, from) {
      outer: for (var p = from; p <= hay.length - seq.length; p++) { for (var q = 0; q < seq.length; q++) if (hay[p + q] !== seq[q]) continue outer; return p; } return -1;
    }
    while (true) {
      var s = indexOfSeq(u8, STREAM, i); if (s < 0) break;
      var ds = s + 6; if (u8[ds] === 0x0d) ds++; if (u8[ds] === 0x0a) ds++;
      var e = indexOfSeq(u8, ENDS, ds); if (e < 0) break;
      raws.push(u8.subarray(ds, e)); i = e + 9;
    }
    // 2) inflate them all
    return Promise.all(raws.map(inflate)).then(function (streams) {
      streams = streams.filter(Boolean);
      // 3) union ToUnicode map (code -> char) from every CMap stream
      var uni = {};
      streams.forEach(function (d) {
        var t = latin1Of(d);
        if (t.indexOf('beginbfchar') < 0 && t.indexOf('beginbfrange') < 0) return;
        var m, re;
        var bc = /beginbfchar([\s\S]*?)endbfchar/g;
        while ((m = bc.exec(t))) { re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g; var mm; while ((mm = re.exec(m[1]))) uni[parseInt(mm[1], 16)] = hexToStr(mm[2]); }
        var br = /beginbfrange([\s\S]*?)endbfrange/g;
        while ((m = br.exec(t))) {
          re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g; var m2;
          while ((m2 = re.exec(m[1]))) {
            var lo = parseInt(m2[1], 16), hi = parseInt(m2[2], 16);
            if (m2[4]) { var base = m2[4]; for (var c = lo; c <= hi; c++) uni[c] = hexToStr((parseInt(base, 16) + (c - lo)).toString(16).padStart(base.length, '0')); }
            else if (m2[5]) { (m2[5].match(/<([0-9A-Fa-f]+)>/g) || []).forEach(function (a, idx) { uni[lo + idx] = hexToStr(a.replace(/[<>]/g, '')); }); }
          }
        }
      });
      function mapHex(h) { var o = ''; for (var k = 0; k + 4 <= h.length; k += 4) { var cc = parseInt(h.substr(k, 4), 16); o += (uni[cc] != null) ? uni[cc] : ''; } return o; }
      // 4) content streams -> text; a vertical move = newline, a wide horizontal move = space
      // (threshold self-calibrated from the median glyph advance so words don't split).
      var out = [];
      streams.forEach(function (d) {
        var t = latin1Of(d);
        if (t.indexOf('beginbfchar') >= 0 || t.indexOf('beginbfrange') >= 0) return;
        if (t.indexOf('BT') < 0 || (t.indexOf('Tj') < 0 && t.indexOf('TJ') < 0)) return;
        var toks = [], m, advances = [];
        var re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(?:Td|TD)|T\*|<([0-9A-Fa-f]+)>\s*Tj|\[([\s\S]*?)\]\s*TJ/g;
        while ((m = re.exec(t))) {
          if (m[3] != null) { toks.push({ s: mapHex(m[3]) }); continue; }
          if (m[4] != null) { (m[4].match(/<([0-9A-Fa-f]+)>|(-?[\d.]+)/g) || []).forEach(function (a) { if (a.charAt(0) === '<') toks.push({ s: mapHex(a.replace(/[<>]/g, '')) }); else if (parseFloat(a) < -120) toks.push({ s: ' ' }); }); continue; }
          if (m[0] === 'T*') { toks.push({ nl: true }); continue; }
          var tx = parseFloat(m[1]), ty = parseFloat(m[2]);
          if (Math.abs(ty) > 0.5) toks.push({ nl: true }); else { toks.push({ tx: tx }); if (tx > 0) advances.push(tx); }
        }
        advances.sort(function (a, b) { return a - b; });
        var med = advances.length ? advances[Math.floor(advances.length / 2)] : 3;
        var spaceAt = Math.max(3, med * 1.6);
        var buf = '';
        toks.forEach(function (k) { if (k.nl != null) buf += '\n'; else if (k.tx != null) { if (k.tx > spaceAt) buf += ' '; } else buf += k.s; });
        if (buf.replace(/\s/g, '').length > 20) out.push(buf);
      });
      return out.join('\n');
    });
  }

  // ---- Caleres (Famous Footwear / Corrigo) WO extractor --------------------
  // The PDF is the source of truth (the email is often a reply/forward with no detail block).
  // Field anchors run on a whitespace-removed COPY so they are immune to PDF spacing quirks; the
  // scope uses an index map back to the readable text. Verified 32/32 vs 4 real WOs + live Umbrava.
  function calCompactify(spaced) {
    var compact = '', map = [];
    for (var i = 0; i < spaced.length; i++) { if (!/\s/.test(spaced[i])) { compact += spaced[i]; map.push(i); } }
    return { compact: compact, map: map };
  }
  // Client priority level -> the closest of Umbrava's 4 Caleres tiers (Emergency/Urgent/Normal/Routine).
  function calPriorityTarget(label, etaDays) {
    var L = String(label || '').toUpperCase();
    if (/EMERG/.test(L) || (etaDays != null && etaDays <= 0.4)) return 'Priority 1';
    if (/URGENT|IMPORTANT/.test(L)) return 'Priority 2';
    if (/NORMAL|STANDARD|MEDIUM/.test(L)) return 'Priority 3';
    if (/ROUTINE|\bLOW\b/.test(L)) return 'Priority 4';
    if (etaDays == null) return '';
    return etaDays <= 1 ? 'Priority 2' : etaDays <= 7 ? 'Priority 3' : 'Priority 4';
  }
  // Best-trade from the "ON DEMAND WORK <category>" wording (never blank - Handyman is the catch-all).
  function calTrade(cat) {
    var s = String(cat || '').toLowerCase();
    if (/hvac|heat|cool|air ?handler|thermostat|\brtu\b|furnace|condenser|damper|duct/.test(s)) return 'HVAC';
    if (/refriger|freezer|cooler|ice ?machine/.test(s)) return 'Refrigeration';
    if (/floor|vct|\btile\b|carpet|\bseal\b/.test(s)) return 'Flooring';
    if (/door|panic ?bar|\bframe|detex|overhead|\bdock\b/.test(s)) return 'Doors and Hardware';
    if (/\block\b|padlock|deadbolt|keyed/.test(s)) return 'Locks';
    if (/plumb|toilet|drain|water ?heater|sink|faucet|urinal|sewer|grease/.test(s)) return 'Plumbing';
    if (/electric|breaker|panel|wiring|outlet|transformer|generator|ballast/.test(s)) return 'Electrical';
    if (/light|lamp|bulb|fixture|luminaire/.test(s)) return /exterior|parking|out.?side|canopy|pole/.test(s) ? 'Exterior Lighting' : 'Lighting';
    if (/\bsign|signage|marquee|reader ?board/.test(s)) return 'Signage';
    if (/roof|gutter|fascia|soffit|siding|skylight/.test(s)) return 'Roofing and Siding';
    if (/window|glass|mirror|tint/.test(s)) return 'Windows and Glass';
    if (/gate|fence/.test(s)) return 'Gates and Fences';
    if (/camera|access ?control|alarm|\bcctv\b|security/.test(s)) return 'Security';
    if (/paint/.test(s)) return 'Painting';
    if (/concrete|asphalt|parking ?lot|bollard/.test(s)) return 'Concrete and Asphalt';
    return 'Handyman';
  }
  function extractCaleres(pdfSpaced, subject) {
    var spaced = String(pdfSpaced || ''), cm = calCompactify(spaced), C = cm.compact, out = {}, m;
    m = C.match(/Caleres\/(\d{4,6})\/[A-Z]{2}/i) || String(subject || '').match(/\bFF\s*(\d{4,6})/i);
    out.store = m ? m[1] : '';
    out.locationNum = /^6\d{4}$/.test(out.store) ? out.store.slice(1) : out.store;   // "drop the leading 6"
    m = C.match(/NOTTOEXCEED\$?([\d,]+\.\d{2})/i); out.dne = m ? m[1].replace(/,/g, '') : '';
    m = C.match(/WO#\s*([0-9]{6,}-[0-9]{6,})/i) || String(subject || '').match(/([0-9]{6,}-[0-9]{6,})/); out.sourceNum = m ? m[1] : '';
    m = C.match(/P\d+([A-Za-z]+)-?(\d+)(DAY|HOUR)ETA/i);
    if (m) { out.priorityLabel = m[1]; out.etaDays = m[3].toUpperCase() === 'HOUR' ? parseInt(m[2], 10) / 24 : parseInt(m[2], 10); }
    else if (/EMERGENCY/i.test(C)) { out.priorityLabel = 'EMERGENCY'; out.etaDays = 0.33; }
    out.priorityTarget = calPriorityTarget(out.priorityLabel, out.etaDays);
    m = C.match(/DUEBY(\d{1,2}\/\d{1,2}\/\d{4})/i); out.dueBy = m ? m[1] : '';
    var wIdx = C.search(/ONDEMANDWORK/i), regionCompact = '', scope = '';
    if (wIdx >= 0) {
      var startC = wIdx + 'ONDEMANDWORK'.length;
      var endRel = C.slice(startC).search(/ASSIGNMENT/i); var endC = endRel < 0 ? C.length : startC + endRel;
      regionCompact = C.slice(startC, endC);
      var sStart = cm.map[startC] != null ? cm.map[startC] : 0;
      var sEnd = cm.map[endC - 1] != null ? cm.map[endC - 1] + 1 : spaced.length;
      scope = spaced.slice(sStart, sEnd).replace(/\s+/g, ' ').trim();
      scope = scope.replace(/^[A-Za-z][A-Za-z0-9 &\/\-]*?\(Broadway[^)]*\)\s*/i, '');   // strip "Name (Broadway...)" requester tag
    }
    out.trade = calTrade(regionCompact.slice(0, 60));
    out.scope = scope.slice(0, 600);
    out.warn = /FLAGGED:|cancel/i.test(C) ? 'the WO PDF has a cancel / flag note - verify this WO is still live before you Create it' : '';
    // Site ADDRESS - used to DISAMBIGUATE the Location dropdown. Searching the bare store number
    // ("3699") also substring-hits stores whose STREET begins with those digits (e.g. "3699 South
    // Highway 95", Bullhead City AZ; "3699 McKinney Avenue", Dallas TX), so the number alone is not
    // unique and the wrong one can render first. Street#, state and ZIP are unambiguous tokens the
    // Location option also shows, so selectLocation() cross-checks them.
    var maddr = spaced.match(/,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/);
    var mstreet = spaced.match(/Caleres\/\d+\/[A-Z]{2}\s*-\s*(\d{1,6})\b[^\r\n]*/i);
    out.addr = {
      streetNum: mstreet ? mstreet[1] : '',
      street: mstreet ? mstreet[0].replace(/^Caleres\/\d+\/[A-Z]{2}\s*-\s*/i, '').trim() : '',
      state: maddr ? maddr[1] : '',
      zip: maddr ? maddr[2] : ''
    };
    return out;
  }
  // Is this a Caleres email? Sender domain, or the body/PDF has the Corrigo "Caleres/<store>/XX"
  // property line. (A bare "FF ####" subject token is NOT enough - too easy to false-positive.)
  function isCaleres(senderEmail, body, pdfText) {
    var d = String(senderEmail || '').split('@')[1] || '';
    return d === 'caleres.com' || /Caleres\/\d+\/[A-Z]{2}/i.test(String(pdfText || '') + String(body || ''));
  }
  // The asset name describes the work, so it drives the Trade. Keyword map; unknown -> '' so
  // the user picks (logic takeover). Extend as new asset wordings show up.
  function assetToTrade(asset) {
    var s = String(asset || '').toLowerCase();
    if (/light|lamp|pole|fixture|bulb|luminaire/.test(s)) return /out.?side|exterior|parking|canopy|pole|lot|yard|site/.test(s) ? 'Exterior Lighting' : 'Lighting';
    if (/hvac|heat|cool|\bac\b|air cond|\brtu\b|furnace|condenser|refriger|freezer|cooler|chiller/.test(s)) return 'HVAC';
    if (/plumb|toilet|drain|water heater|sink|faucet|urinal|sewer|grease/.test(s)) return 'Plumbing';
    if (/electric|breaker|panel|wiring|outlet|transformer|generator/.test(s)) return 'Electrical';
    if (/door|hardware|overhead|dock/.test(s)) return 'Doors and Hardware';
    if (/\block\b|padlock|deadbolt|keyed/.test(s)) return 'Locks';
    if (/\bsign|signage|reader board|monument|marquee/.test(s)) return 'Signage';
    if (/roof|\bleak\b|gutter|fascia|soffit|siding|skylight/.test(s)) return 'Roofing and Siding';
    if (/window|glass|mirror|tint/.test(s)) return 'Windows and Glass';
    if (/gate|fence/.test(s)) return 'Gates and Fences';
    if (/camera|access control|security alarm|\bcctv\b/.test(s)) return 'Security';
    // Umbrava has no fuel/dispenser trade, so fuel assets fall through to '' (user picks).
    return '';
  }
  function extractWo(subject, body, senderEmail) {
    subject = subject || ''; body = body || '';
    var out = { po: '', sourceJob: '', client: '', location: '', trade: '', scope: '', clientDne: '', priorityLevel: '', assetName: '' };
    var mpo = (body.match(/\bPO\s*#?\s*:?\s*(\d{6,})/i) || subject.match(/(?:purchase order)\s*:?\s*(\d{6,})/i) || subject.match(/\b(\d{9,})\b/)); if (mpo) out.po = mpo[1];
    var mnte = body.match(/NTE\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i); if (mnte) out.clientDne = mnte[1].replace(/,/g, '');
    var mp = body.match(/Priority\s*:?\s*(P\d)/i) || subject.match(/\b(P\d)\b/); if (mp) out.priorityLevel = mp[1].toUpperCase();
    var mstore = body.match(/PFJ#?\s*:?\s*(\d{1,5})/i) || subject.match(/store\s*:?\s*(\d{1,5})/i); if (mstore) out.location = 'PFJ ' + String(mstore[1]).padStart(4, '0');
    var masset = body.match(/Asset Name\s*:?\s*([^\r\n]+)/i); if (masset) { out.assetName = masset[1].trim(); out.trade = assetToTrade(out.assetName); }
    var mdesc = body.match(/Description\s*:?\s*([\s\S]*?)(?:[\r\n]+\s*(?:Dispatcher|Vendor|Model\s*:|Serial|Parts Warranty|Labor Warranty)\b|$)/i);
    if (mdesc) out.scope = mdesc[1].replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!out.scope) out.scope = subject.replace(/purchase order\s*:?\s*\d+/i, '').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
    out.client = clientFromDomain(senderEmail);
    return out;
  }
  // Image-based Caleres/Corrigo request: NO WO PDF - the detail is in the email SUBJECT + body
  // (e.g. subject "39089 Birmingham, MI - Allen Edmonds Lighting", body "...has 8 lights out").
  // Parse the subject for store / city / state / trade and the body for the scope. NTE, Priority and
  // any exact street address live only inside the attached IMAGES (not machine-readable here), so
  // those stay manual. Store number is enough to pin the Location (it is unique in the dropdown);
  // city + state corroborate it (see selectLocation).
  function firstBodyScope(body) {
    var b = String(body || '').replace(/\r/g, '');
    var cut = b.search(/\n\s*(From:|Sent:|On .+wrote:|-----Original|________|Get Outlook|Sent from|Thanks|Regards|Best[, ]|Sincerely)/i);
    if (cut > 0) b = b.slice(0, cut);
    return b.replace(/\s+/g, ' ').trim().slice(0, 600);
  }
  function extractCaleresSubject(subject, body) {
    var s = String(subject || '').replace(/\s+/g, ' ').trim();
    // "<store> <City>, <ST> - <Brand + Trade>"
    var m = s.match(/^(\d{4,6})\s+(.+?),\s*([A-Z]{2})\s*[-–—]\s*(.+)$/);
    if (!m) return null;
    var tail = m[4].trim();
    return {
      store: m[1], city: m[2].trim(), state: m[3], trade: assetToTrade(tail),
      scope: firstBodyScope(body) || tail,
      addr: { streetNum: '', street: '', city: m[2].trim(), state: m[3], zip: '' }
    };
  }

  // ---- Amazon (Fairmarkit RFQ) extractor -----------------------------------
  // These arrive from the Fairmarkit e-bidding platform (sender info@m.fairmarkit.com), NOT from
  // Amazon directly - the buyer named in the body is "Amazon.com, Inc.". Broadway is the QUOTING
  // supplier here, so the RFQ carries no NTE/ceiling and no work priority: Client DNE and Priority
  // are left blank on purpose (see fillWo - they stay manual). The detail is a clean plain-text
  // body block (stream 1000001F), so there is no PDF to read. Grounded on 10 real RFQs 2026-08.
  function isAmazon(senderEmail, subject, body) {
    var d = String(senderEmail || '').split('@')[1] || '';
    var fromFairmarkit = /(^|\.)fairmarkit\.com$/i.test(d);   // m.fairmarkit.com etc.
    var mentionsAmazon = /Amazon\.com,?\s*Inc\.?/i.test(String(subject || '') + ' ' + String(body || ''));
    return (fromFairmarkit && mentionsAmazon) ||
      /Amazon\.com,?\s*Inc\.?\s*-\s*Request for Quote\s*#\d+/i.test(String(subject || ''));
  }
  // Parse the RFQ "Shipping address:" line into scoring tokens. Formats vary across the corpus:
  //  "3200 E. Sawyer Road, Republic, MO, 65738, US"
  //  "Amazon.com Services LLC (PIT2), 1200 Westport Rd, Imperial, PA, 15126, US"  (company + code prefix)
  //  "1610 Van Buren Rd, Easton, PA 18045, Easton, PA, 18045, US"                 (duplicated segments)
  //  "3500 Wilson Road, Bakersfield, 93309, US"                                    (NO state)
  // We only rely on street # + city + state for the Location match - the ZIP is deliberately NOT
  // used, because the RFQ ZIP and Umbrava's ZIP disagree for real sites (e.g. STL3: RFQ 65738 vs
  // Umbrava 65619). Street # is the strongest disambiguator when a city holds two Amazon sites.
  function parseAmazonAddr(a) {
    a = String(a || '').replace(/\s+/g, ' ').trim().replace(/,?\s*US\.?$/i, '').replace(/,\s*$/, '');
    a = a.replace(/^[^,]*\([A-Z]{3}\d\)\s*,\s*/, '');           // strip leading "Company (CODE), "
    var streetNum = ''; var mS = a.match(/^\s*(\d{1,6})\b/); if (mS) streetNum = mS[1];
    var street = ''; var mStr = a.match(/^[^,]+/); if (mStr) street = mStr[0].trim();
    var zip = ''; var mZ = a.match(/(\d{5})(?:-\d{4})?(?!.*\d{5})/); if (mZ) zip = mZ[1];   // last 5-digit run
    var state = ''; var reSt = /[,\s]([A-Z]{2})[,\s]+\d{5}\b/g, ms2, lastSt = null;
    while ((ms2 = reSt.exec(a))) lastSt = ms2; if (lastSt) state = lastSt[1];
    var parts = a.split(',').map(function (s) { return s.trim(); }).filter(Boolean), city = '';
    for (var i = parts.length - 1; i >= 1; i--) {               // scan from the end; skip zip/state/US
      var p = parts[i];
      if (/^\d{5}(-\d{4})?$/.test(p) || /^[A-Z]{2}$/.test(p) || /^US$/i.test(p)) continue;
      if (/[A-Za-z]/.test(p)) { city = p.replace(/\s+\d{5}(-\d{4})?$/, '').replace(/\s+[A-Z]{2}$/, '').trim(); break; }
    }
    return { streetNum: streetNum, street: street, city: city, state: state, zip: zip };
  }
  // Best-effort Trade from the RFQ wording; blank when unsure so the user picks (many Amazon RFQs are
  // sweeping / janitorial / low-voltage AV / IT work, which have no confident Umbrava trade). Kept
  // self-contained with WORD-BOUNDARIED keywords rather than delegating to the shared assetToTrade
  // map, whose unanchored terms substring-false-positive on Amazon's noisier text (e.g. "beam clamps"
  // -> "lamp" -> Lighting). A wrong confident trade is worse than a blank one here.
  function amazonTrade(text) {
    var s = ' ' + String(text || '').toLowerCase() + ' ';
    if (/concrete|asphalt|\bcurb\b|\bslab\b|sidewalk|bollard/.test(s)) return 'Concrete and Asphalt';
    if (/\blvp\b|carpet|\bvct\b|\btile\b|\bfloor(ing)?\b/.test(s)) return 'Flooring';
    if (/\bpaint(ing)?\b/.test(s)) return 'Painting';
    if (/\bhvac\b|\brtu\b|rooftop unit|furnace|condenser|air handler|\bac unit\b/.test(s)) return 'HVAC';
    if (/plumb|toilet|\bdrain\b|water heater|faucet|urinal|\bsewer\b/.test(s)) return 'Plumbing';
    if (/electric|conduit|\bwiring\b|breaker|\bpanel\b|\boutlet\b|receptacle|transformer|generator|power drop/.test(s)) return 'Electrical';
    if (/\broof|gutter|downspout|fascia|soffit|siding/.test(s)) return 'Roofing and Siding';
    if (/overhead door|dock door|roll-?up door|\bman door\b|door hardware/.test(s)) return 'Doors and Hardware';
    if (/\bsignage\b|\bsigns?\b|marquee|reader ?board/.test(s)) return 'Signage';
    if (/\blight\b|\blamp\b|luminaire|\bbulb\b|light fixture/.test(s)) return 'Lighting';
    return '';   // sweeping / janitorial / AV / IT cage etc. - no confident trade, user picks
  }
  function extractAmazon(subject, body) {
    subject = String(subject || ''); body = String(body || '');
    var B = body.replace(/\s+/g, ' ').trim();
    var out = { po: '', location: '', trade: '', scope: '', _siteCode: '', _addr: null, _dueBy: '', _note: '', _bidUrl: '', _seeAttached: false };
    // RFQ ID -> Source PO # (7-8 digits; do not assume length). Body first, subject as fallback.
    var mid = B.match(/RFQ ID:\s*(\d+)/i) || subject.match(/#\s*(\d+)/); if (mid) out.po = mid[1];
    // Title sits between "Invitation to Quote" and "You have been invited".
    var mt = B.match(/Invitation to Quote\s+(.+?)\s+You have been invited/i);
    var title = mt ? mt[1].trim() : '';
    // Site code = 3 letters + 1 digit. Read it ONLY from the (short) title - the body has decoys like
    // "AFE1"/"AF2". Fall back to the shipping-address parenthetical "(PIT2)".
    var mc = title.match(/\b([A-Z]{3}\d)\b/);
    var maddr = B.match(/Shipping address:\s*(.+?)(?:\s*Preferred delivery date:|$)/i);
    var addrStr = maddr ? maddr[1].trim().replace(/,\s*$/, '') : '';
    if (!mc) { var mcp = addrStr.match(/\(([A-Z]{3}\d)\)/); if (mcp) mc = [null, mcp[1]]; }
    out._siteCode = mc ? mc[1].toUpperCase() : '';
    out._addr = parseAmazonAddr(addrStr);
    out.location = out._siteCode || (out._addr && out._addr.city) || '';   // search term for the Location field
    // Line items: between the table header ("Internal part # QTY") and the Notes/actions that follow.
    // Each row is "<n>. <desc> <qty>.00"; a lone item may be a long spec block (RDU9) - the scope cap
    // handles that, and the full text still rides along as the attached email.
    var itemList = [];
    var mi = B.match(/Internal part #\s*QTY\s*(.+?)\s*(?:Notes to supplier:|View more|Quote Message Buyer)/i);
    if (mi) {
      var region = mi[1], reItem = /(\d+)\.\s+([\s\S]*?)\s+(\d+)\.\d{2}(?=\s+\d+\.\s|\s*$)/g, mm;
      while ((mm = reItem.exec(region))) {
        var desc = mm[2].replace(/\s+/g, ' ').trim(), q = parseInt(mm[3], 10);
        if (desc) itemList.push(desc + (q > 1 ? (' (x' + q + ')') : ''));
      }
      if (!itemList.length) itemList.push(region.replace(/\s+\d+\.\d{2}\b/g, '').replace(/\s+/g, ' ').trim());
    }
    var mnotes = B.match(/Notes to supplier:\s*(.+?)\s*(?:View more|Quote Message Buyer|Quote\b|$)/i);
    var notes = mnotes ? mnotes[1].replace(/\s+/g, ' ').trim() : '';
    out.trade = amazonTrade(title + ' ' + itemList.join(' ') + ' ' + notes);
    var scope = title;
    if (itemList.length) scope += '\n' + itemList.map(function (d, i) { return (i + 1) + '. ' + d; }).join('\n');
    if (notes) scope += '\nNotes: ' + notes;
    out.scope = scope.replace(/\n{2,}/g, '\n').trim().slice(0, 600);
    // Preferred delivery date (rare) is the closest thing to a work due date -> Complete-By hint.
    var mpd = B.match(/Preferred delivery date:\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})/i);
    if (mpd) out._dueBy = mpd[1].replace(/\s+/g, ' ').trim();
    // Buyer + close date are reference only. The Close date is the QUOTE deadline, NOT the work due
    // date - label it so nobody sets Complete-By to it by mistake.
    // The full scope / any "attached file" lives on the Fairmarkit BID PAGE, not in this email - the
    // .msg carries no attachment (verified across the sample corpus). Reconstruct the clean bid URL
    // from bid_uuid (the JSON tail's uuid == the uuid inside the Quote-button link, 10/10) so the
    // estimator can open the real RFQ, and flag the RFQs whose body defers to that page.
    var mu = B.match(/"bid_uuid":\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i)
      || B.match(/bid(?:%252F|%2F|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    out._bidUrl = mu ? 'https://app.fairmarkit.com/bid/' + mu[1] : '';
    out._seeAttached = /see\s+(the\s+)?attach|attach(ed|ment)?\s+(file|document|drawing|scope|sow|spec|pdf)|see\s+rfq|full scope of work|refer to the attach|see drawing|per attach/i.test(body);
    var refs = [], mbuy = B.match(/Buyer:\s*(.+?)\s*Close date:/i), mclose = B.match(/Close date:\s*(.+?)\s*RFQ ID:/i);
    if (mbuy) refs.push('Buyer ' + mbuy[1].replace(/\s+/g, ' ').trim());
    if (mclose) refs.push('RFQ closes ' + mclose[1].replace(/\s+/g, ' ').trim() + ' (quote deadline, not the work due date)');
    if (out.po) refs.push('RFQ #' + out.po);
    if (out._bidUrl) refs.push('Fairmarkit RFQ: ' + out._bidUrl);
    out._note = refs.join(' · ');
    return out;
  }

  // ---- Create WO modal --------------------------------------------------------
  function woModal() {
    var s = document.querySelector('textarea#scopeOfWork') || document.querySelector('input#client-dropdown');
    return s ? (s.closest('.MuiDialog-container, [role="dialog"], .MuiPaper-root') || null) : null;
  }
  function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  // Find an input by its field label - for fields with a dynamic id (Priority) or no id (Client DNE).
  function inputByLabel(root, re) {
    var labs = [].slice.call(root.querySelectorAll('label, .MuiInputLabel-root'));
    var lab = labs.filter(function (l) { return re.test(normText(l.textContent)); })[0];
    if (!lab) return null;
    var fc = lab.closest('.MuiFormControl-root, .MuiTextField-root') || lab.parentElement;
    return fc ? fc.querySelector('input, textarea') : null;
  }
  function waitEnabled(root, sel, timeoutMs) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function poll() {
        var el = root.querySelector(sel);
        if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') return res(el);
        if (Date.now() - t0 > (timeoutMs || 2500)) return res(el || null);
        setTimeout(poll, 120);
      })();
    });
  }
  // Poll until getter() returns a truthy element (or timeout). Used to wait for a field that only
  // renders after a cascade (e.g. Client DNE appears once a client is selected).
  function waitForEl(getter, timeoutMs) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function poll() {
        var el = getter();
        if (el) return res(el);
        if (Date.now() - t0 > (timeoutMs || 2500)) return res(null);
        setTimeout(poll, 100);
      })();
    });
  }
  // Best option for a target string: exact, then starts-with, then contains (case-insensitive).
  function bestOption(opts, target) {
    var t = normText(target).toLowerCase(); if (!t) return null;
    var txt = opts.map(function (o) { return normText(o.textContent).toLowerCase(); });
    var i;
    for (i = 0; i < opts.length; i++) if (txt[i] === t) return opts[i];
    for (i = 0; i < opts.length; i++) if (txt[i].indexOf(t) === 0) return opts[i];
    for (i = 0; i < opts.length; i++) if (txt[i].indexOf(t) >= 0) return opts[i];
    return null;
  }
  // Type into an autocomplete WITHOUT blurring - a blur closes the option list before we can click.
  function acType(el, val) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }
  // Umbrava's Client / Location / Trade / Priority are custom autocompletes (aria-autocomplete=
  // "list"): pre-typing does NOT select - you must click an option in the listbox, and that click
  // is what cascades (Client unlocks Location + reveals Client DNE; Location unlocks Asset). Open,
  // filter by searchTerm, then POLL until the MATCHING option renders and click it. The Client list
  // is network-fetched and can take >1.5s, and a stray/transient option may flash first - so we must
  // wait for a real match, not resolve on the first option that appears. Returns
  // 'selected' | 'typed' | 'disabled' | 'skip'.
  function selectAC(el, searchTerm, matchTarget) {
    return new Promise(function (resolve) {
      if (!el) return resolve('skip');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return resolve('disabled');
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      if (searchTerm) acType(el, searchTerm);
      var target = matchTarget || searchTerm, t0 = Date.now();
      (function poll() {
        var pick = bestOption([].slice.call(document.querySelectorAll('[role="option"]')), target);
        if (pick) {
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { pick.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
          return resolve('selected');
        }
        if (Date.now() - t0 > 2500) return resolve(searchTerm ? 'typed' : 'skip');
        setTimeout(poll, 70);
      })();
    });
  }
  // Location picker for feeds that carry the site ADDRESS (Caleres). The bare store number is NOT
  // unique in the Location list - it substring-hits stores whose street begins with the same digits
  // (e.g. searching "3699" also returns "3699 South Highway 95", Bullhead City AZ) - and options
  // stream in over the network, so the wrong one can render first and get clicked. So: keep polling,
  // score every rendered option by store number + address tokens (street #, state, ZIP), and click
  // only once an option corroborates the WO address. If none does within the window, resolve
  // 'ambiguous' so the caller leaves it for a manual pick instead of guessing a wrong-state store.
  function selectLocation(el, storeNum, addr) {
    return new Promise(function (resolve) {
      if (!el) return resolve('skip');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return resolve('disabled');
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      var num = String(storeNum || '').replace(/\D/g, '');
      if (num) acType(el, num);
      var reNum = num ? new RegExp('\\b' + num + '\\b') : null;
      var streetNum = addr && addr.streetNum ? String(addr.streetNum) : '';
      var city = addr && addr.city ? String(addr.city).toLowerCase() : '';
      var state = addr && addr.state ? String(addr.state) : '';
      var zip = addr && addr.zip ? String(addr.zip) : '';
      function addrScore(txt) {
        var s = 0, lo = txt.toLowerCase();
        if (streetNum && new RegExp('\\b' + streetNum + '\\b').test(txt)) s++;
        if (city && lo.indexOf(city) >= 0) s++;
        if (state && new RegExp(',\\s*' + state + '\\b', 'i').test(txt)) s++;
        if (zip && txt.indexOf(zip) >= 0) s++;
        return s;
      }
      var t0 = Date.now();
      (function poll() {
        var opts = [].slice.call(document.querySelectorAll('[role="option"]'));
        var best = null, bestScore = 0;
        for (var i = 0; i < opts.length; i++) {
          var txt = normText(opts[i].textContent);
          if (reNum && !reNum.test(txt)) continue;          // option must show the store number
          var sc = addrScore(txt);
          if (sc > bestScore) { bestScore = sc; best = opts[i]; }
        }
        if (best && bestScore >= 2) {                        // store # + >=2 address tokens agree
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { best.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
          return resolve('selected');
        }
        if (Date.now() - t0 > 3500) return resolve('ambiguous');
        setTimeout(poll, 70);
      })();
    });
  }
  // Location picker for Amazon RFQs. Amazon's Umbrava Locations are keyed by the SITE CODE
  // (locationNumber, e.g. "PIT2") - locationName is just "AMAZON" and there are 100+ of them, so the
  // code is the unique key. Type the code and click the option that shows it. When the RFQ carried no
  // code (title had none, e.g. "Parking Lot/Trailer Yard Sweeping"), fall back to the shipping
  // ADDRESS: type the city, then score options by street # + city + state (NOT ZIP - RFQ vs Umbrava
  // ZIPs disagree). A city can hold two Amazon sites (ALB1 and ALB5 are both in Castleton NY); the
  // street # disambiguates, and we need >=2 tokens before clicking so a same-city sibling isn't
  // picked. Returns 'selected' | 'typed' | 'ambiguous' | 'disabled' | 'skip'.
  function selectAmazonLocation(el, code, addr) {
    return new Promise(function (resolve) {
      if (!el) return resolve('skip');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return resolve('disabled');
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      var cd = String(code || '').toUpperCase();
      var streetNum = addr && addr.streetNum ? String(addr.streetNum) : '';
      var city = addr && addr.city ? String(addr.city).toLowerCase() : '';
      var state = addr && addr.state ? String(addr.state) : '';
      if (cd) acType(el, cd); else if (city) acType(el, addr.city); else if (streetNum) acType(el, streetNum);
      var reCode = cd ? new RegExp('\\b' + cd + '\\b', 'i') : null;
      function score(txt) {
        var s = 0, lo = txt.toLowerCase();
        if (reCode && reCode.test(txt)) s += 2;                                        // the code alone is decisive
        if (streetNum && new RegExp('\\b' + streetNum + '\\b').test(txt)) s++;
        if (city && lo.indexOf(city) >= 0) s++;
        if (state && new RegExp(',\\s*' + state + '\\b', 'i').test(txt)) s++;
        return s;
      }
      var t0 = Date.now();
      (function poll() {
        var opts = [].slice.call(document.querySelectorAll('[role="option"]'));
        var best = null, bestScore = 0;
        for (var i = 0; i < opts.length; i++) { var sc = score(normText(opts[i].textContent)); if (sc > bestScore) { bestScore = sc; best = opts[i]; } }
        if (best && bestScore >= 2) {
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { best.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
          return resolve('selected');
        }
        if (Date.now() - t0 > 3500) return resolve(cd ? 'typed' : 'ambiguous');
        setTimeout(poll, 70);
      })();
    });
  }
  function fillWo(root, wo) {
    var done = [], picked = [], hint = [];
    if (wo._warn) toast('⚠ Heads up: ' + wo._warn, 18000, '#8b1a1a');   // cancel/flag on the WO PDF - warn before Create
    function setV(sel, v, label) { var el = root.querySelector(sel); if (el && v) { setNativeValue(el, v); done.push(label); } }
    setV('textarea#scopeOfWork', wo.scope, 'Scope');
    setV('input#sourcePurchaseOrderNumber', wo.po, 'Source PO #');
    setV('input#sourceJobNumber', wo.sourceJob, 'Source Job #');
    try { PENDING = wo._file ? { files: [wo._file].concat(wo._attachments || []), po: wo.po, client: wo.client } : null; } catch (e) { }

    // The dropdowns cascade, so select in order and wait for each dependent field to appear/enable:
    // Client -> (Location unlocks + Client DNE appears) -> Location -> Trade -> Priority.
    (async function () {
      if (wo.client) {
        var rc = await selectAC(root.querySelector('input#client-dropdown'), wo.client, wo.client);
        if (rc === 'selected') picked.push('Client "' + wo.client + '"');
        else hint.push('Client: pick "' + wo.client + '"');
      }
      // Client DNE = the PO NTE (the CLIENT ceiling, never the vendor NTE). The field only EXISTS
      // once a client is selected (that is why it was blank before), so WAIT for it to render.
      if (wo.clientDne) {
        var dne = await waitForEl(function () { return inputByLabel(root, /^client dne/i); }, 2500);
        if (dne) { setNativeValue(dne, wo.clientDne); done.push('Client DNE $' + wo.clientDne); }
        else hint.push('Client DNE: $' + wo.clientDne);
      }
      if (wo.location) {
        await waitEnabled(root, 'input#location-dropdown', 3000);
        var locEl = root.querySelector('input#location-dropdown');
        if (wo._amazon) {
          // Amazon: match by SITE CODE (locationNumber), else by the shipping address. See selectAmazonLocation.
          var ra = await selectAmazonLocation(locEl, wo._siteCode, wo._addr);
          var label = wo._siteCode || wo.location;
          if (ra === 'selected') picked.push('Location ' + label + (wo._addr && wo._addr.city ? ' (' + [wo._addr.streetNum, wo._addr.city, wo._addr.state].filter(Boolean).join(' ') + ')' : ''));
          else if (ra === 'ambiguous') {
            var whereA = wo._addr ? [wo._addr.street || wo._addr.streetNum, wo._addr.city, wo._addr.state].filter(Boolean).join(' ') : '';
            hint.push('Location: no site code in the RFQ - pick the Amazon site at ' + whereA + ' manually');
          } else hint.push('Location: pick the Amazon site ' + label);
        } else {
          var store = wo.location.replace(/\D/g, '') || wo.location;   // search by the store number
          var addrHas = wo._addr && (wo._addr.streetNum || wo._addr.city || wo._addr.state || wo._addr.zip);
          // Address-verified pick when the feed carries the site address (Caleres); the bare store
          // number is not unique. Pilot / generic keep the simple "match the option" behaviour.
          var rl = addrHas
            ? await selectLocation(locEl, store, wo._addr)
            : await selectAC(locEl, store, wo.location);
          if (rl === 'selected') {
            picked.push('Location ' + store + (addrHas ? ' (' + [wo._addr.streetNum, wo._addr.city, wo._addr.state, wo._addr.zip].filter(Boolean).join(' ') + ')' : ''));
          } else if (rl === 'ambiguous') {
            var where = wo._addr ? [wo._addr.street || wo._addr.streetNum, wo._addr.city, wo._addr.state, wo._addr.zip].filter(Boolean).join(' ') : '';
            hint.push('Location: store ' + store + ' has multiple matches - pick the one at ' + where + ' manually');
          } else {
            hint.push('Location: pick ' + (wo.location || store));
          }
        }
      }
      if (wo.trade) {
        var rt = await selectAC(root.querySelector('input#trades'), wo.trade, wo.trade);
        if (rt === 'selected') picked.push('Trade "' + wo.trade + '"'); else hint.push('Trade: ' + wo.trade + ' (pick the closest)');
      }
      if (wo.priorityLevel) {
        var rp = await selectAC(inputByLabel(root, /^priority/i), wo.priorityLevel, wo.priorityLevel);
        if (rp === 'selected') picked.push('Priority ' + wo.priorityLevel); else hint.push('Priority: set ' + wo.priorityLevel);
      }
      var parts = [];
      if (done.length) parts.push('Filled ' + done.join(', '));
      if (picked.length) parts.push('selected ' + picked.join(' / '));
      if (hint.length) parts.push('check: ' + hint.join(' · '));
      if (wo._dueBy) parts.push('Complete-By (DUE BY ' + wo._dueBy + ') - set it on the WO header after Create');
      if (wo._note) parts.push(wo._note);
      var nAtt = (wo._attachments || []).length;
      if (nAtt) parts.push('the email + ' + nAtt + ' attachment' + (nAtt === 1 ? '' : 's') + ' will attach to Documents after Create');
      parts.push('review before Create');
      toast('From the PO email - ' + parts.join(' · '), 15000);
    })();
  }

  // ---- Stage 2: carry the dropped email to the new WO, then auto-attach to Documents ------
  // On Create, stash the file(s) in IndexedDB (survives the create->WO-page hop, SPA nav OR a
  // reload). On the new WO page, hand them to BWN Drop Upload via bwn:cmd - it uploads them to
  // Documents AND drafts the email as a WO note (its existing flow). All local; no egress.
  var PENDING = null;   // { files:[emailFile, ...attachmentFiles], po, client } - set on a successful drop
  function idbReq(mode, fn) {
    return new Promise(function (res, rej) {
      var o = indexedDB.open('bwn-wo-intake', 1);
      o.onupgradeneeded = function () { o.result.createObjectStore('pending'); };
      o.onerror = function () { rej(o.error); };
      o.onsuccess = function () {
        var db = o.result, tx = db.transaction('pending', mode), st = tx.objectStore('pending'), rq;
        try { rq = fn(st); } catch (e) { rej(e); return; }
        tx.oncomplete = function () { res(rq ? rq.result : undefined); };
        tx.onerror = function () { rej(tx.error); };
      };
    });
  }
  function idbPut(k, v) { return idbReq('readwrite', function (st) { st.put(v, k); }); }
  function idbGet(k) { return idbReq('readonly', function (st) { return st.get(k); }); }
  function idbDel(k) { return idbReq('readwrite', function (st) { st.delete(k); }).catch(function () { }); }

  // On the modal's Create click (with a dropped email pending), persist for the new WO page.
  // fromPath lets the new page tell a real create-navigation from a validation failure (modal
  // stays -> same path -> we don't consume). Scoped to the modal's own Create button.
  document.addEventListener('click', function (e) {
    if (!PENDING || !PENDING.files || !PENDING.files.length) return;
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn || !/^create\b/i.test((btn.textContent || '').trim())) return;
    var m = woModal(); if (!m || !m.contains(btn)) return;
    idbPut('current', { ts: Date.now(), fromPath: location.pathname, files: PENDING.files, po: PENDING.po || '', client: PENDING.client || '' }).catch(function () { });
  }, true);

  function waitWoReady(timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        if (document.querySelector('[role="tab"]') || document.querySelector('[data-testid^="documents-"]')) return resolve(true);
        if (Date.now() - t0 > (timeoutMs || 9000)) return resolve(false);
        setTimeout(poll, 250);
      })();
    });
  }
  var _consuming = false;
  function maybeConsumePending() {
    if (_consuming || !/\/work-orders\/\d+/.test(location.pathname)) return;
    idbGet('current').then(function (p) {
      if (!p || !p.files || !p.files.length) return;
      if (Date.now() - p.ts > 3 * 60 * 1000) { idbDel('current'); return; }   // stale
      if (p.fromPath === location.pathname) return;                            // create failed / not navigated yet - wait
      _consuming = true;
      idbDel('current');   // consume-once: delete before dispatch so a re-check can't double-fire
      waitWoReady(9000).then(function () {
        var acked = false;
        function onAck(ev) { if (ev && ev.detail && ev.detail.id === 'dropupload:accepted') acked = true; }
        document.addEventListener('bwn:evt', onAck, false);
        try { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'dropupload:files', files: p.files } })); } catch (e) { }
        setTimeout(function () {
          document.removeEventListener('bwn:evt', onAck, false);
          if (acked) toast('Handed the PO email to Drop Upload - attaching to this WO\'s Documents + drafting the note. Review + Save.', 11000);
          else toast('Could not auto-attach: BWN Drop Upload not detected (install/update it). Drag the .msg onto the Work Order to attach it.', 13000);
          _consuming = false;
        }, 1800);
      });
    }).catch(function () { });
  }

  async function handleDrop(file, root) {
    try {
      var name = (file.name || '').toLowerCase(), parsed;
      if (/\.eml$/.test(name) || file.type === 'message/rfc822') parsed = parseEml(await file.text());
      else parsed = parseMsg(new Uint8Array(await file.arrayBuffer()));
      if (!parsed.subject && !parsed.body && !parsed.senderEmail) { toast('Could not read that email. Save it as a .msg or .eml file and drop the file (dragging straight from Outlook often gives the browser nothing).', 12000); return; }
      // Embedded attachments -> File objects (carry to the new WO's Documents; also read for the WO PDF).
      var attFiles = [];
      (parsed.attachments || []).forEach(function (a) {
        try { attFiles.push(new File([a.bytes], a.name, { type: a.mime || 'application/octet-stream' })); } catch (e) { }
      });
      var wo = null;
      // Caleres (Famous Footwear / Corrigo): the WO detail lives in the attached PDF, not the email.
      var pdfAtt = (parsed.attachments || []).filter(function (a) { return /\.pdf$/i.test(a.name || '') || /pdf/i.test(a.mime || ''); })[0];
      if (isCaleres(parsed.senderEmail, parsed.body, '') && pdfAtt) {
        toast('Caleres WO - reading the attached PDF on-device...', 4000);
        var pdfText = '';
        try { pdfText = await pdfToText(pdfAtt.bytes); } catch (e) { toast('Could not read the WO PDF (' + ((e && e.message) || e) + ') - filling what the email has.', 10000, '#8b1a1a'); }
        var cx = pdfText ? extractCaleres(pdfText, parsed.subject) : null;
        // Commit to the Caleres mapping only if this really is a Caleres/Corrigo WO PDF AND extraction
        // anchored to a real WO - otherwise fall through to the generic path (no wrong hardcoded client).
        if (cx && (cx.sourceNum || cx.store) && /caleres\/\d+\//i.test(pdfText.replace(/\s+/g, ''))) {
          wo = {
            client: 'Caleres Inc', location: cx.locationNum, clientDne: cx.dne,
            po: cx.sourceNum, sourceJob: cx.sourceNum, trade: cx.trade,
            priorityLevel: cx.priorityTarget, scope: cx.scope, _warn: cx.warn, _dueBy: cx.dueBy,
            _addr: cx.addr
          };
        }
      }
      // Image-based Caleres request (no WO PDF): the detail is in the subject + body, not an attachment.
      if (!wo && isCaleres(parsed.senderEmail, parsed.body, '') && !pdfAtt) {
        var cs = extractCaleresSubject(parsed.subject, parsed.body);
        if (cs && cs.store) {
          wo = {
            client: 'Caleres Inc', location: cs.store, trade: cs.trade, scope: cs.scope, _addr: cs.addr,
            _note: 'image WO - NTE + Priority are in the attached image(s), enter them manually'
          };
        }
      }
      // Amazon (Fairmarkit RFQ): buyer is Amazon.com, Inc. but the sender is Fairmarkit. Detail is a
      // clean plain-text body block (no PDF). We are the quoting supplier, so Client DNE + Priority
      // stay manual (an RFQ has no ceiling/priority yet - see extractAmazon).
      if (!wo && isAmazon(parsed.senderEmail, parsed.subject, parsed.body)) {
        var ax = extractAmazon(parsed.subject, parsed.body);
        if (ax && (ax.po || ax._siteCode || ax.location)) {
          wo = {
            client: 'Amazon', location: ax.location, po: ax.po, sourceJob: '',
            trade: ax.trade, scope: ax.scope,
            _amazon: true, _siteCode: ax._siteCode, _addr: ax._addr, _dueBy: ax._dueBy, _note: ax._note,
            // No attachment in the email - if the RFQ defers to one, warn and point at the bid page.
            _warn: ax._seeAttached ? 'this Amazon RFQ defers to an attached file / full scope that is NOT in the email - open the Fairmarkit RFQ link (in the details below) to get it' : ''
          };
        }
      }
      if (!wo) wo = extractWo(parsed.subject, parsed.body, parsed.senderEmail);   // Pilot / generic path
      wo._file = file;
      wo._attachments = attFiles;
      fillWo(root, wo);
    } catch (e) { toast('Could not read the email: ' + ((e && e.message) || e), 10000, '#8b1a1a'); }
  }

  // ---- Drop zone injected into the Create WO modal ----------------------------
  function injectDropZone() {
    var root = woModal();
    if (!root || root.querySelector('#bwn-wo-drop')) return;
    var dz = document.createElement('div');
    dz.id = 'bwn-wo-drop';
    dz.style.cssText = 'margin:14px 0 0;padding:16px;border:2px dashed #1a5f3e;border-radius:10px;background:#f3f7f5;color:#0d3d26;font:500 14px ' + FONT + ';text-align:center;cursor:pointer;line-height:1.5;';
    dz.innerHTML = '📧 Drop the PO email here to prefill<div style="font:400 12px ' + FONT + ';color:#5a6b62;margin-top:4px;">saved .msg or .eml file - read locally, nothing leaves your browser</div>';
    var file = document.createElement('input'); file.type = 'file'; file.accept = '.msg,.eml,message/rfc822,application/vnd.ms-outlook'; file.style.display = 'none';
    dz.appendChild(file);
    dz.addEventListener('click', function (e) { if (e.target !== file) { file.value = ''; file.click(); } });
    file.addEventListener('change', function () { if (file.files && file.files[0]) handleDrop(file.files[0], woModal() || root); });
    function stop(e) { e.preventDefault(); e.stopPropagation(); }
    dz.addEventListener('dragover', function (e) { stop(e); dz.style.background = '#e2efe9'; });
    dz.addEventListener('dragleave', function (e) { stop(e); dz.style.background = '#f3f7f5'; });
    dz.addEventListener('drop', function (e) {
      stop(e); dz.style.background = '#f3f7f5';
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleDrop(f, woModal() || root);
      else toast('No file came through. Dragging directly from Outlook often does not - save the email as a .msg first, then drag that file (or click the box to pick it).', 12000);
    });
    var anchor = root.querySelector('input#vendorNotToExceed');
    var col = anchor ? (anchor.closest('.MuiGrid-item, .MuiGrid-root, [class*="col"]') || anchor.parentElement) : null;
    if (col && col.parentElement) col.parentElement.appendChild(dz);
    else { (root.querySelector('.MuiDialogContent-root') || root.querySelector('form') || root).appendChild(dz); }
  }

  var obs = new MutationObserver(function () { injectDropZone(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(injectDropZone, 900);
  injectDropZone();
  // Stage-2 consumer: on SPA path change to a new WO, and on direct load/reload onto one.
  var _lastPath = location.pathname;
  setInterval(function () { if (location.pathname !== _lastPath) { _lastPath = location.pathname; maybeConsumePending(); } }, 700);
  maybeConsumePending();
})();
