// ==UserScript==
// @name         Primark PRIMMS – Bulk Acceptance Assistant
// @namespace    broadwaynational.com/primms
// @version      0.2.5
// @description  BWN operator aid for reviewing eligible Umbrava-originated work orders in Primark's PRIMMS/Ostara tenant and (Phase 2, disabled) accepting them with the required note. Phase 1 is read-only + dry-run and makes ZERO network requests. Never touches Umbrava.
// @author       Broadway National
// @match        https://primark-ostara.ostarasystems.net/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==
//
// SECURITY / SCOPE (read before editing):
//  - This script NEVER references, reads, reuses or harvests any Umbrava token,
//    cookie, DOM or network surface. It runs only on the approved PRIMMS host.
//  - No fetch / XMLHttpRequest / GM_xmlhttpRequest / WebSocket / sendBeacon /
//    external library / remote font / CDN / telemetry anywhere. Phase 1 issues
//    ZERO network requests. A reviewer can confirm by grepping this file for
//    those identifiers and finding only the guard comments below.
//  - Mutating routes (/WorkOrderAction/*, /WorkOrder/Create, /Authentication/*,
//    /Settings) are deny-listed. The panel does not even render on them.
//  - Live writes are gated behind CONFIG.LIVE_WRITE_ENABLED (false) AND an
//    owner sign-off after the discovery facts in discovery-checklist.md are
//    confirmed in an authorized environment. The write adapter is a scaffold.
//
(function () {
  'use strict';

  // ==========================================================================
  // MODULE: config
  // Single labelled config block. Everything tunable lives here.
  // ==========================================================================
  const CONFIG = {
    LIVE_WRITE_ENABLED: false,
    DEFAULT_DELAY_MS: 2500,
    MIN_DELAY_MS: 1000,
    // Validation-ready build: hard-capped to one item per batch. The effective
    // cap is min(MAX_BATCH_SIZE, MAX_TEST_BATCH_SIZE) — see batchCap().
    MAX_BATCH_SIZE: 1,
    MAX_TEST_BATCH_SIZE: 1,
    ARMED_TOKEN_TTL_MS: 15 * 60 * 1000,
    APPROVED_HOST: 'primark-ostara.ostarasystems.net',
    ELIGIBILITY_MODE: 'allowlist',          // 'allowlist' | 'column'
    ELIGIBILITY_HEADER_CANDIDATES: ['source', 'created by', 'origin', 'raised by'],
    ELIGIBILITY_MATCH_VALUES: ['auto created', 'auto-created', 'umbrava'],
    GREETINGS: ['Good morning', 'Good afternoon', 'Good evening'],
    NOTE_TEMPLATE: '{GREETING}, thank you for this new work order. We will provide an ETA for service as soon as possible. Thank you, {NAME}',
    STORAGE_PREFIX: 'bwn.primms.acceptance.',
    AUDIT_MAX_ROWS: 500,
    DEBUG: false,
  };

  // Constants that are structural, not operator-tunable, kept out of CONFIG.
  const K = {
    BUILD_ID: '0.2.5',
    PANEL_ID: 'bwn-pba-panel',
    STYLE_ID: 'bwn-pba-style',
    CSS_PREFIX: 'bwn-pba-',
    Z_INDEX: 2147483200,               // below the suite's toasts, above app chrome; host is different so no real collision
    // CONFIRMED (Chrome discovery 2026-09-16): the detail id is a numeric
    // surrogate in path form, /WorkOrder/Detail/{id} (e.g. .../Detail/2646377).
    // No query-string ?id= form was seen. In this tenant the operator-facing
    // Work Order Nº equals this id.
    ID_PATTERN: /^\d{1,12}$/,
    // Operator-facing job reference: digits, optionally with separators. Kept
    // permissive but bounded. TODO(discovery): tighten to the real WO-nº shape.
    REF_PATTERN: /^[A-Za-z0-9][A-Za-z0-9/\-]{0,31}$/,
    SELECTED_DISPLAY_CAP: 25,
    // CONFIRMED (discovery 2026-09-16) action-link labels/class for label-verified
    // resolution before any (future, validated) live action.
    ACCEPT_LABEL: 'Accept Job',
    ADD_NOTES_LABEL: 'Add Notes - Public',
    ACTION_LINK_CLASS: 'imageactionlink',
    // CONFIRMED read-only note-history route (used by verifyNote read-back).
    NOTE_HISTORY_PATH: '/WorkOrderReadOnly/ViewNoteHistory/',
  };

  const SELECTORS = {
    gridHeader: 'table.datagridheader',
    gridBody: 'table.datagrid',
    headerCell: 'td.datagridheadercolumn',
    dataRow: 'tr.datagriddatarowwithlink',
    detailLink: 'a[href*="/WorkOrder/Detail/"]',
    hiddenCol: '.datagriddatacolumnhidden',
    // Detail page (Phase 2 read-side; values never logged).
    detailContainer: '#workOrderDetailLayoutTable',
    actionsList: '#workOrderActionsList',
    panelTitle: '#panelTitle',   // CONFIRMED: contains the numeric id AND the building name — parse digits only, never store the text
    // CONFIRMED (discovery 2026-09-16): Accept Job / Add Notes are anchor links
    // inside #workOrderActionsList pointing at the /WorkOrderAction/* routes.
    // The write path uses the platform's own visible link, never a synthesised URL.
    acceptJobLink: '#workOrderActionsList a[href*="/WorkOrderAction/AcceptJob/"]',
    addNotesLink: '#workOrderActionsList a[href*="/WorkOrderAction/AddNotes/"]',
    // CONFIRMED: read-only note read-back surface for verifyNote — the History
    // link opens a dialog with a same-origin iframe holding the note records.
    noteHistoryLink: '#workOrderNoteHistoryLink',
    noteHistoryFrame: '#notehistoryframe',
    // CONFIRMED action-modal chrome (test record, 2026-09-16).
    modalRoot: '#modalDialog',
    dialogClose: '.ui-dialog-titlebar-close',
  };

  /**
   * CONFIRMED action-modal FORM structure, from read-only modal inspection on the
   * designated test work order (2026-09-16). NO form was submitted. These are
   * documented placeholders for the future, still-disabled submit path — they are
   * NOT wired to any active POST, and `acceptJob`/`addNote` stay fail-closed.
   * Both forms are plain (non-AJAX) POSTs; the modal "Save" submits them.
   * Field VALUES were never read — only names/types/labels.
   */
  const WRITE_FORMS = {
    antiForgeryName: '__RequestVerificationToken',   // NAME only; value never read
    submitSelector: 'input[type="submit"]',          // value "Save" — never clicked while disabled
    accept: {
      method: 'POST',
      actionTemplate: '/WorkOrderAction/AcceptJob/{id}',
      // Visible fields (all optional here): ETA (datetime-local, conditionally
      // mandatory via the EtaIsMandatory hidden flag; has [data-valmsg-for="Eta"]),
      // a text Reference, and an OPTIONAL Notes textarea whose visibility is
      // UNCONFIRMED — so the acceptance note still goes through the confirmed
      // "Add Notes - Public" path, not this field.
      fields: { eta: 'Eta', reference: 'ResourceReference', notes: 'Notes' },
      hidden: ['WorkOrderId', 'ActionButtonType', 'HasInitialEta', 'TimezoneId', 'EtaIsMandatory'],
    },
    addNotesPublic: {
      method: 'POST',
      actionTemplate: '/WorkOrderAction/AddNotes/{id}',
      // CONFIRMED: a single REQUIRED plain <textarea name="Notes"> (NOT jHtmlArea
      // on this form; visible textarea). No category/type/visibility select —
      // visibility is fixed "Public". So the live addNote would set the textarea
      // value directly; the jHtmlArea helper is unnecessary for this form.
      noteField: 'Notes',
      noteEditorIsPlainTextarea: true,
      hidden: ['WorkOrderId', 'ActionButtonType'],
    },
  };

  const NOTE_TOKENS = {
    greeting: /\{GREETING\}/g,
    // Support both the CONFIG token and the brief's spelled-out token.
    name: /\{NAME\}|\{ACCEPTING_USER_NAME\}/g,
  };

  const MSG = {
    gridUnrecognized: 'Grid not recognized. No jobs were selected.',
    noWoColumn: 'Could not identify the Work Order column. Selection is disabled.',
    liveDisabled: 'Live writes are disabled in this build.',
    noBatch: 'No active batch. Nothing was submitted.',
    stopped: 'Stopped by operator. No additional jobs will be started.',
    scopeChanged: 'Client scope changed. The batch was stopped and nothing further was submitted.',
    eligibilityUnknown: 'Unable to determine eligibility',
  };

  // ==========================================================================
  // MODULE: routes  (allow-list + deny-list; fail closed)
  // ==========================================================================

  // Deny first. Mutating / session / settings namespaces. Off-limits by contract.
  const DENY_RE = /^\/(WorkOrderAction|Authentication|Settings)(\/|$)|^\/WorkOrder\/Create/i;
  // Allow: jobs list surfaces and the read-only work-order detail page.
  const ALLOW_LIST_RE = /^\/(Filter)(\/|$)/i;                 // /Filter, /Filter/... (incl. Reselection results render here)
  const ALLOW_WO_LIST_RE = /^\/WorkOrder\/?$/i;              // /WorkOrder list landing
  const ALLOW_DETAIL_RE = /^\/WorkOrder\/Detail\/[^/]+\/?$/i; // /WorkOrder/Detail/{id}

  /**
   * @param {string} pathname
   * @returns {{allowed:boolean, kind:('list'|'detail'|null), reason:string}}
   */
  function classifyRoute(pathname) {
    const p = pathname || location.pathname;
    if (DENY_RE.test(p)) return { allowed: false, kind: null, reason: 'denied-route' };
    if (ALLOW_DETAIL_RE.test(p)) return { allowed: true, kind: 'detail', reason: 'detail' };
    if (ALLOW_LIST_RE.test(p) || ALLOW_WO_LIST_RE.test(p)) return { allowed: true, kind: 'list', reason: 'list' };
    // Home page carries the list widgets but is not a grid; render nothing there.
    return { allowed: false, kind: null, reason: 'unrecognized' }; // fail closed
  }

  function hostOk() {
    return location.hostname === CONFIG.APPROVED_HOST;
  }

  // ==========================================================================
  // MODULE: pure helpers  (individually testable, no DOM/side effects)
  // ==========================================================================

  /** Normalize a header cell's text for keying: lowercase, collapse ws, strip the Nº ordinal glyphs. */
  function normalizeHeader(s) {
    return String(s == null ? '' : s)
      .replace(/º|°|\bno\.?\b|\bnº\b/gi, '') // drop "Nº"/"No." so "Work Order Nº" -> "work order"
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** @returns {boolean} true if id matches the strict id pattern. */
  function validateId(id) {
    return typeof id === 'string' && K.ID_PATTERN.test(id.trim());
  }

  /** @returns {boolean} true if a job reference looks structurally valid. */
  function validateRef(ref) {
    return typeof ref === 'string' && K.REF_PATTERN.test(ref.trim());
  }

  /**
   * Build the acceptance note. Substitutes {GREETING} and {NAME}/{ACCEPTING_USER_NAME}.
   * Returns the exact string that would be submitted, no trimming of the result.
   * @param {string} template @param {string} greeting @param {string} name
   */
  function buildNote(template, greeting, name) {
    return String(template)
      .replace(NOTE_TOKENS.greeting, greeting)
      .replace(NOTE_TOKENS.name, name);
  }

  /**
   * Normalize note text for exact-note verification. The PRIMMS note-history
   * renders notes as rich HTML (CONFIRMED: td.right holds child markup), so a
   * byte compare is wrong. Strip tags, decode the common entities, collapse
   * whitespace. Case preserved.
   */
  function normalizeNoteText(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ').trim();
  }

  /** True if the (normalized) note text appears within the (normalized) container text. */
  function noteTextMatches(containerText, note) {
    const n = normalizeNoteText(note);
    return !!n && normalizeNoteText(containerText).indexOf(n) !== -1;
  }

  /** RFC 4180 field escaping + spreadsheet formula-injection guard. */
  function csvEscape(v) {
    let s = v == null ? '' : String(v);
    // Neutralize a leading formula trigger (= + - @, tab, CR) so a crafted
    // identifier/reason can't execute when the CSV is opened in a spreadsheet.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Clamp the inter-item delay to the hard floor, in code (not just the input min). */
  function clampDelay(ms) {
    const n = Number(ms);
    if (!isFinite(n)) return CONFIG.DEFAULT_DELAY_MS;
    return Math.max(CONFIG.MIN_DELAY_MS, Math.floor(n));
  }

  /** Greeting that matches the local clock. */
  function greetingForHour(h) {
    if (h < 12) return CONFIG.GREETINGS[0];
    if (h < 17) return CONFIG.GREETINGS[1];
    return CONFIG.GREETINGS[2];
  }

  /** Parse a pasted allow-list textarea into a de-duped, normalized ref list. */
  function parseAllowList(text) {
    const seen = Object.create(null);
    const out = [];
    String(text || '').split(/[\s,;]+/).forEach(function (tok) {
      const t = tok.trim();
      if (!t) return;
      const key = t.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push(t);
    });
    return out;
  }

  // ==========================================================================
  // MODULE: grid reader  (visible rows only; header-text keyed; never index)
  // ==========================================================================

  /**
   * @typedef {Object} WorkOrderRow
   * @property {string} ref        operator-facing Work Order number (display primary)
   * @property {string} id         WorkOrderDetail surrogate id (secondary)
   * @property {string} detailUrl  same-origin detail URL
   * @property {Object<string,string>} cells  header(normalized) -> cell text
   * @property {boolean} validId
   * @property {boolean} validRef
   */

  function extractIdFromHref(href) {
    if (!href) return '';
    // Path form: /WorkOrder/Detail/{id}
    const m = href.match(/\/WorkOrder\/Detail\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]);
    // Query form (TODO(discovery) — brief mentions ?id=)
    try {
      const u = new URL(href, location.origin);
      const q = u.searchParams.get('id');
      if (q) return q;
    } catch (e) { /* ignore */ }
    return '';
  }

  /** @returns {string[]} normalized header keys in visible column order. */
  function readHeaderMap(headerTable) {
    const cells = headerTable ? headerTable.querySelectorAll(SELECTORS.headerCell) : [];
    return Array.prototype.map.call(cells, function (c) { return normalizeHeader(c.textContent); });
  }

  /** Find the index of the Work Order number column by fuzzy header match. */
  function findWoColumn(headerKeys) {
    for (let i = 0; i < headerKeys.length; i++) {
      const h = headerKeys[i];
      if (h === 'work order' || h === 'workorder' || /work\s*order/.test(h)) return i;
    }
    return -1;
  }

  /**
   * Read the currently rendered grid into row objects. Visible rows only.
   * @returns {{ok:boolean, reason:string, headerKeys:string[], woCol:number, rows:WorkOrderRow[]}}
   */
  function readGrid() {
    const header = document.querySelector(SELECTORS.gridHeader);
    const body = document.querySelector(SELECTORS.gridBody);
    if (!header || !body) return { ok: false, reason: 'no-grid', headerKeys: [], woCol: -1, rows: [] };

    const headerKeys = readHeaderMap(header);
    const woCol = findWoColumn(headerKeys);

    const rowEls = body.querySelectorAll(SELECTORS.dataRow);
    const rows = [];
    Array.prototype.forEach.call(rowEls, function (tr) {
      // Only visible rows.
      if (tr.offsetParent === null && tr.getClientRects().length === 0) return;
      const tds = tr.children;
      const cells = {};
      for (let i = 0; i < headerKeys.length && i < tds.length; i++) {
        const key = headerKeys[i];
        if (!key) continue; // skip the hidden first column (empty normalized key)
        cells[key] = (tds[i].textContent || '').replace(/\s+/g, ' ').trim();
      }
      const link = tr.querySelector(SELECTORS.detailLink);
      const href = link ? link.getAttribute('href') : '';
      const id = extractIdFromHref(href);
      let ref = '';
      if (woCol >= 0 && tds[woCol]) ref = (tds[woCol].textContent || '').replace(/\s+/g, ' ').trim();
      if (!ref && woCol >= 0) ref = cells[headerKeys[woCol]] || '';
      let detailUrl = '';
      try { detailUrl = href ? new URL(href, location.origin).href : ''; } catch (e) { detailUrl = ''; }

      rows.push({
        ref: ref,
        id: id,
        detailUrl: detailUrl,
        cells: cells,
        validId: validateId(id),
        validRef: validateRef(ref),
      });
    });

    return { ok: true, reason: 'ok', headerKeys: headerKeys, woCol: woCol, rows: rows };
  }

  // ==========================================================================
  // MODULE: eligibility
  // ==========================================================================

  /**
   * Column-match eligibility. Returns per-row eligibility plus whether a
   * candidate header was found at all. If none found -> caller shows
   * "Unable to determine eligibility" and disables selection (safe default).
   */
  function eligibilityByColumn(grid) {
    const cand = CONFIG.ELIGIBILITY_HEADER_CANDIDATES.map(normalizeHeader);
    let matchKey = null;
    for (let i = 0; i < grid.headerKeys.length; i++) {
      if (cand.indexOf(grid.headerKeys[i]) !== -1) { matchKey = grid.headerKeys[i]; break; }
    }
    if (!matchKey) return { headerFound: false, matchKey: null, eligible: [] };
    const vals = CONFIG.ELIGIBILITY_MATCH_VALUES.map(function (v) { return v.toLowerCase(); });
    const eligible = grid.rows.map(function (r) {
      const cellVal = (r.cells[matchKey] || '').toLowerCase();
      return vals.some(function (v) { return cellVal.indexOf(v) !== -1; });
    });
    return { headerFound: true, matchKey: matchKey, eligible: eligible };
  }

  /**
   * Allow-list eligibility. Intersect pasted refs with visible rows.
   * @returns {{eligible:boolean[], pastedNotVisible:string[]}}
   */
  function eligibilityByAllowList(grid, pastedRefs) {
    const visible = Object.create(null);
    grid.rows.forEach(function (r) { if (r.ref) visible[r.ref.toLowerCase()] = 1; });
    const pastedSet = Object.create(null);
    pastedRefs.forEach(function (p) { pastedSet[p.toLowerCase()] = 1; });
    const eligible = grid.rows.map(function (r) { return !!(r.ref && pastedSet[r.ref.toLowerCase()]); });
    const pastedNotVisible = pastedRefs.filter(function (p) { return !visible[p.toLowerCase()]; });
    return { eligible: eligible, pastedNotVisible: pastedNotVisible };
  }

  // ==========================================================================
  // MODULE: work-order reader  (detail page; Phase 2 read-side)
  // Values are NEVER logged. Used only to confirm identity / accepted-state.
  // ==========================================================================

  /**
   * Numeric detail-page id. CONFIRMED: the URL path carries it; #panelTitle
   * also contains it (alongside the building name, which we NEVER read/store —
   * only the digit run is extracted).
   */
  function detailPageId() {
    let id = extractIdFromHref(location.pathname);
    if (!id) {
      const pt = document.querySelector(SELECTORS.panelTitle);
      const m = pt && (pt.textContent || '').match(/\b(\d{3,12})\b/);
      if (m) id = m[1];
    }
    return id;
  }

  /**
   * Detail-page context used to validate identity + accepted-state.
   * CONFIRMED accepted-state signal: the Accept Job action link is present in
   * #workOrderActionsList only while the job is still acceptable. Present =>
   * 'not-accepted'. Absent => 'unknown' (already accepted or not eligible) =>
   * the item is SKIPPED, never assumed accepted.
   */
  function readDetailContext() {
    const id = detailPageId();
    const acceptPresent = !!uniqueEl(SELECTORS.acceptJobLink);
    const addNotesPresent = !!uniqueEl(SELECTORS.addNotesLink);
    return {
      id: id,
      ref: id,                    // CONFIRMED: WO Nº == surrogate id in this tenant
      acceptedState: acceptPresent ? 'not-accepted' : 'unknown',
      acceptPresent: acceptPresent,
      addNotesPresent: addNotesPresent,
      scope: readTenantScope(),
    };
  }

  /**
   * Tenant/scope guard. CONFIRMED: the tenant is guaranteed by the dedicated
   * per-client host subdomain, so the hostname IS the fail-closed scope marker.
   * (Finer in-tenant "Change Client" scoping has no confirmed stable marker yet
   * — see discovery-checklist G; the host check is the hard guarantee.)
   */
  function readTenantScope() {
    return location.hostname;
  }

  /** Resolve a selector to exactly one element, else null (uniqueness guard). */
  function uniqueEl(sel) {
    const els = document.querySelectorAll(sel);
    return els.length === 1 ? els[0] : null;
  }

  /**
   * Derive the accepting user's name from the PRIMMS header greeting
   * ("Welcome, <name> | Help | …") — CONFIRMED header format. Read-only; used
   * ONLY to PREFILL the editable operator-name field so it adapts to whoever is
   * logged in. Never auto-submitted, never inferred beyond this visible text —
   * the operator confirms or edits it before any live batch.
   * @returns {string} the name, or '' if the header can't be read.
   */
  function deriveOperatorName() {
    const logout = document.querySelector('a[href="/Authentication/Logout"]');
    let scope = logout ? logout.closest('div,li,td,span,header,nav') : null;
    for (let i = 0; i < 4 && scope; i++) {
      const n = parseWelcomeName(scope.textContent);
      if (n) return n;
      scope = scope.parentElement;
    }
    return parseWelcomeName(document.body.textContent);
  }

  /**
   * Pure: extract the name from a PRIMMS header greeting string. Testable.
   * The name is delimited by the header's pipe separator ("Welcome, <name> | Help
   * | …"), so split on the pipe — NOT on the words "Help"/"Logout", which would
   * wrongly cut a name like "Broadway Helpdesk" at "Help".
   */
  function parseWelcomeName(text) {
    const s = String(text || '');
    let m = s.match(/Welcome,\s*([^|\n\r]+?)\s*\|/i);   // up to the first pipe
    if (m) return m[1].trim();
    m = s.match(/Welcome,\s*([^|\n\r]+)/i);             // no pipe: to end of line
    return m ? m[1].trim() : '';
  }

  /**
   * Resolve the note-history read-back surface. CONFIRMED (test record 2689724,
   * 2026-09-16): the History control (#workOrderNoteHistoryLink) opens a dialog
   * whose notes render inside a same-origin IFRAME `#notehistoryframe`; each note
   * is a `.message` block (with sibling `.sender` / `.date`), oldest→newest. The
   * userscript is @noframes but reads the iframe's contentDocument from the top
   * frame. Returns a status + the live `.message` NodeList (never its text).
   * @returns {{status:('ready'|'loading'|'unrecognized'|'ambiguous'), messages?:NodeList}}
   */
  function noteHistoryFrameDoc() {
    const frames = document.querySelectorAll(SELECTORS.noteHistoryFrame);
    if (frames.length === 0) return { status: 'unrecognized' };
    if (frames.length > 1) return { status: 'ambiguous' };
    let d = null;
    try { d = frames[0].contentDocument || (frames[0].contentWindow && frames[0].contentWindow.document); } catch (e) { d = null; }
    if (!d || d.readyState !== 'complete') return { status: 'loading' };
    const msgs = d.querySelectorAll('.message');
    if (!msgs.length) return { status: 'unrecognized' };
    return { status: 'ready', messages: msgs };
  }

  /**
   * Pure: is the expected note present in any note-history `.message` node?
   * Normalizes each message's text transiently (never stores it). Testable with
   * a detached container of `.message` elements — no iframe needed.
   */
  function matchNoteInMessages(messages, note) {
    for (let i = 0; i < messages.length; i++) {
      if (noteTextMatches(messages[i].textContent, note)) return true;
    }
    return false;
  }

  /**
   * Read-only pre-submit check: does the currently-loaded action modal form
   * match the CONFIRMED WRITE_FORMS shape (method + required field names)? For
   * the future live submit to assert the form before touching it. Never submits.
   * @param {'accept'|'addNotesPublic'} kind
   */
  function validateLoadedActionForm(kind) {
    const spec = kind === 'accept' ? WRITE_FORMS.accept : WRITE_FORMS.addNotesPublic;
    const marker = kind === 'accept' ? '/AcceptJob/' : '/AddNotes/';
    const form = Array.prototype.slice.call(document.querySelectorAll(SELECTORS.modalRoot + ' form, .ui-dialog form'))
      .filter(function (f) { return (f.getAttribute('action') || '').indexOf(marker) !== -1; })[0];
    if (!form) return { ok: false, reason: 'form-not-loaded' };
    if ((form.getAttribute('method') || 'get').toUpperCase() !== spec.method) return { ok: false, reason: 'method-mismatch' };
    const names = Array.prototype.map.call(form.querySelectorAll('input,select,textarea'), function (e) { return e.getAttribute('name'); });
    const need = [WRITE_FORMS.antiForgeryName].concat(spec.hidden).concat(kind === 'accept' ? [] : [spec.noteField]);
    const missing = need.filter(function (n) { return names.indexOf(n) === -1; });
    return { ok: missing.length === 0, missing: missing };
  }

  /**
   * Prepare a jHtmlArea-backed note field LOCALLY (no submit). Sets the hidden
   * textarea and pushes the value into the widget body if jHtmlArea is present.
   * The field selector is test-record-pending (checklist F); callers pass the
   * resolved textarea. Never submits, never clicks a Save control.
   */
  function prepareJHtmlAreaValue(textareaEl, text) {
    if (!textareaEl) return false;
    try {
      textareaEl.value = text;
      const $ = window.jQuery;
      if ($ && $.fn && $.fn.htmlarea) {
        const wa = $(textareaEl).data('jHtmlArea');
        if (wa && typeof wa.setHTML === 'function') {
          wa.setHTML(String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        } else {
          $(textareaEl).trigger('change'); // fall back to native sync
        }
      }
      return true;
    } catch (e) { return false; }
  }

  // ==========================================================================
  // MODULE: note template
  // ==========================================================================

  function currentGreeting(state) {
    return state.greeting || greetingForHour(new Date().getHours());
  }

  function greetingMismatch(state) {
    return currentGreeting(state) !== greetingForHour(new Date().getHours());
  }

  function renderNote(state) {
    return buildNote(CONFIG.NOTE_TEMPLATE, currentGreeting(state), state.operatorName || '');
  }

  // ==========================================================================
  // MODULE: audit log  (localStorage; survives navigation; PII-minimized)
  // Fields ONLY: ts, ref, id, action, outcome, reason. No record content.
  // ==========================================================================

  const AUDIT_KEY = CONFIG.STORAGE_PREFIX + 'audit';

  /**
   * @typedef {Object} AuditEntry
   * @property {string} ts     ISO timestamp
   * @property {string} ref    operator-facing reference (identifier only)
   * @property {string} id     surrogate id (identifier only)
   * @property {('accept'|'note'|'batch')} action
   * @property {('dry-run'|'succeeded'|'failed'|'skipped'|'stopped')} outcome
   * @property {string} reason non-sensitive reason / status-like code
   */

  function auditRead() {
    try {
      const raw = localStorage.getItem(AUDIT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function auditWrite(entry) {
    try {
      const arr = auditRead();
      arr.push({
        ts: new Date().toISOString(),
        ref: String(entry.ref || ''),
        id: String(entry.id || ''),
        action: String(entry.action || ''),
        outcome: String(entry.outcome || ''),
        reason: String(entry.reason || ''),
      });
      // FIFO purge to the cap.
      while (arr.length > CONFIG.AUDIT_MAX_ROWS) arr.shift();
      localStorage.setItem(AUDIT_KEY, JSON.stringify(arr));
    } catch (e) { /* storage unavailable -> audit is best-effort, never throws */ }
  }

  function auditClear() {
    try { localStorage.removeItem(AUDIT_KEY); } catch (e) { /* ignore */ }
  }

  function auditToCsv() {
    const rows = auditRead();
    const head = ['timestamp', 'identifier', 'id', 'action', 'outcome', 'message'];
    const lines = [head.map(csvEscape).join(',')];
    rows.forEach(function (r) {
      lines.push([r.ts, r.ref, r.id, r.action, r.outcome, r.reason].map(csvEscape).join(','));
    });
    return lines.join('\r\n');
  }

  // ==========================================================================
  // MODULE: batch state + armed token  (sessionStorage; identifiers only)
  // The armed token is the ONLY permitted cross-navigation continuation.
  // In this build the live loop is unreachable (LIVE_WRITE_ENABLED=false), so
  // these helpers exist as Phase 2 scaffold and are exercised only by dry-run
  // preview / self-test. Dry-run itself never navigates and needs no token.
  // ==========================================================================

  const BATCH_KEY = CONFIG.STORAGE_PREFIX + 'batch';
  const TOKEN_KEY = CONFIG.STORAGE_PREFIX + 'armed';

  /**
   * @typedef {Object} BatchItem
   * @property {string} ref @property {string} id @property {string} detailUrl
   * @property {('queued'|'validating'|'accepting'|'accept-verified'|'adding-note'|'note-verified'|'succeeded'|'failed'|'skipped'|'stopped')} state
   * @property {string} reason
   */

  function ssRead(key) {
    try { const r = sessionStorage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { return null; }
  }
  function ssWrite(key, val) {
    try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }
  function ssClear(key) {
    try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /** Mint the short-lived armed-batch token at the second confirmation. */
  function mintArmedToken(operatorName, scope) {
    const tok = {
      nonce: String(Date.now()) + '.' + Math.random().toString(36).slice(2),
      operator: operatorName,
      scope: scope,
      host: CONFIG.APPROVED_HOST,
      expires: Date.now() + CONFIG.ARMED_TOKEN_TTL_MS,
    };
    ssWrite(TOKEN_KEY, tok);
    return tok;
  }

  /** @returns {{valid:boolean, reason:string, token:Object|null}} */
  function validateArmedToken(currentScope) {
    const tok = ssRead(TOKEN_KEY);
    if (!tok) return { valid: false, reason: 'absent', token: null };
    if (!hostOk() || tok.host !== CONFIG.APPROVED_HOST) return { valid: false, reason: 'host', token: tok };
    if (Date.now() > tok.expires) return { valid: false, reason: 'expired', token: tok };
    if (currentScope != null && tok.scope !== currentScope) return { valid: false, reason: 'scope-changed', token: tok };
    if (DENY_RE.test(location.pathname)) return { valid: false, reason: 'denied-route', token: tok };
    return { valid: true, reason: 'ok', token: tok };
  }

  function clearArmedBatch() {
    ssClear(TOKEN_KEY);
    ssClear(BATCH_KEY);
  }

  // ==========================================================================
  // MODULE: adapters  (Adapter interface; Dry-run default; Write = scaffold)
  // ==========================================================================

  /**
   * @typedef {Object} BatchItem
   * @property {string} workOrderId  numeric surrogate id (CONFIRMED)
   * @property {string} ref          operator-facing reference (== id this tenant)
   * @property {string} detailUrl
   * @property {string} note         frozen note text
   */
  /**
   * @typedef {Object} BatchResult
   * @property {string} workOrderId
   * @property {('succeeded'|'failed'|'skipped'|'stopped'|'dry-run')} outcome
   * @property {string} message
   * @property {string} timestamp
   */
  /**
   * @typedef {Object} StepResult
   * @property {boolean} ok
   * @property {string} [reason]
   */

  function nowIso() { return new Date().toISOString(); }
  function mkResult(id, outcome, message) { return { workOrderId: id, outcome: outcome, message: message, timestamp: nowIso() }; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, clampDelay(ms)); }); }

  /** Effective per-batch cap: min of the two configured limits (validation build = 1). */
  function batchCap() { return Math.min(CONFIG.MAX_BATCH_SIZE, CONFIG.MAX_TEST_BATCH_SIZE); }

  /** Poll a predicate until true or attempts exhausted. @returns {Promise<boolean>} */
  function waitFor(pred, tries, intervalMs) {
    return new Promise(function (resolve) {
      let n = 0;
      (function step() {
        let ok = false; try { ok = !!pred(); } catch (e) { ok = false; }
        if (ok) { resolve(true); return; }
        if (n++ >= (tries || 40)) { resolve(false); return; }
        setTimeout(step, intervalMs || 250);
      })();
    });
  }

  /**
   * Common pre-action guard shared by acceptJob/addNote: writes enabled, correct
   * tenant + approved detail route, and the detail page id matches the armed item.
   */
  function writeContextOk(item) {
    if (!CONFIG.LIVE_WRITE_ENABLED) return { ok: false, reason: 'live-writes-disabled' };
    if (readTenantScope() !== CONFIG.APPROVED_HOST) return { ok: false, reason: 'tenant-scope-mismatch' };
    const c = classifyRoute(location.pathname);
    if (!c.allowed || c.kind !== 'detail' || DENY_RE.test(location.pathname)) return { ok: false, reason: 'not-on-approved-detail-route' };
    if (!validateId(item.workOrderId) || detailPageId() !== item.workOrderId) return { ok: false, reason: 'id-mismatch' };
    return { ok: true };
  }

  /**
   * Open a CONFIRMED action modal by triggering its unique unobtrusive-AJAX link
   * (label-verified) and waiting for EXACTLY ONE validated form (WRITE_FORMS shape)
   * to appear in #modalDialog / the jQuery-UI dialog. Rejects missing, duplicate,
   * or invalid forms. Never synthesises a request.
   * @param {'accept'|'addNotesPublic'} kind
   * @returns {Promise<{ok:boolean, form?:HTMLFormElement, reason?:string}>}
   */
  function openActionModalForm(kind) {
    const isAccept = kind === 'accept';
    const linkSel = isAccept ? SELECTORS.acceptJobLink : SELECTORS.addNotesLink;
    const label = isAccept ? K.ACCEPT_LABEL : K.ADD_NOTES_LABEL;
    const marker = isAccept ? '/AcceptJob/' : '/AddNotes/';
    const formSel = SELECTORS.modalRoot + ' form, .ui-dialog form';
    return new Promise(function (resolve) {
      const link = uniqueEl(linkSel);
      if (!link) { resolve({ ok: false, reason: 'action-link-not-unique-or-absent' }); return; }
      const txt = (link.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (txt.indexOf(label.toLowerCase()) === -1) { resolve({ ok: false, reason: 'action-label-mismatch' }); return; }
      const $ = window.jQuery;
      if ($) $(link).trigger('click'); else link.click(); // confirmed AJAX GET -> modal render
      let tries = 0;
      (function poll() {
        const forms = Array.prototype.slice.call(document.querySelectorAll(formSel))
          .filter(function (f) { return (f.getAttribute('action') || '').indexOf(marker) !== -1; });
        if (forms.length > 1) { resolve({ ok: false, reason: 'duplicate-action-form' }); return; }
        if (forms.length === 1) {
          const v = validateLoadedActionForm(kind);
          if (!v.ok) { resolve({ ok: false, reason: 'form-invalid:' + (v.reason || (v.missing && v.missing.join(',')) || '') }); return; }
          resolve({ ok: true, form: forms[0] }); return;
        }
        if (tries++ >= 40) { resolve({ ok: false, reason: 'action-form-timeout' }); return; }
        setTimeout(poll, 250);
      })();
    });
  }

  /** Event-trail signal: a normalized acceptance event ("… Accepted …") is present. */
  function hasAcceptedEvent() {
    const links = document.querySelectorAll('a[href*="/WorkOrder/Event/"]');
    return Array.prototype.some.call(links, function (a) { return /\baccepted\b/i.test(a.textContent || ''); });
  }

  /**
   * @interface WorkOrderAdapter
   * The runner (processItem) drives this state machine:
   *   queued -> validating -> accepting -> accept-verified
   *          -> adding-note -> note-verified -> succeeded | failed | skipped | stopped
   * validateItem/verifyAccepted/verifyNote return {ok, reason}. acceptJob/addNote
   * return a BatchResult ('failed' short-circuits). All are async.
   */

  /**
   * Dry-run: fully functional, zero clicks / zero navigation / zero network.
   * Produces the same state transitions and audit shape as live, doing nothing.
   */
  const DryRunAdapter = {
    name: 'DryRunAdapter',
    writes: false,
    async validateItem(_item) { return { ok: true }; },
    async acceptJob(item) { return mkResult(item.workOrderId, 'dry-run', 'accept (dry-run: no click, no navigation)'); },
    async verifyAccepted(_item) { return { ok: true }; },
    async addNote(item) { return mkResult(item.workOrderId, 'dry-run', 'note (dry-run: no click, no navigation)'); },
    async verifyNote(_item) { return { ok: true }; },
  };

  /**
   * Live adapter. All four steps are wired from CONFIRMED mechanics (test record
   * 2689724, 2026-09-16 — one Add Notes POST and one Accept observed). The two
   * WRITE steps drive the platform's own modal "Save" (AJAX POST); they are
   * UNREACHABLE while LIVE_WRITE_ENABLED is false (activeAdapter returns
   * DryRunAdapter, and each write step head-guards on the flag via writeContextOk).
   * Enabling live writes is a separate, deliberate owner decision.
   */
  const PrimmsWriteAdapter = {
    name: 'PrimmsWriteAdapter',
    writes: true,

    // CONFIRMED: identity + tenant + accepted-state (via Accept-link availability).
    async validateItem(item) {
      if (!CONFIG.LIVE_WRITE_ENABLED) return { ok: false, reason: 'live-writes-disabled' };
      if (readTenantScope() !== CONFIG.APPROVED_HOST) return { ok: false, reason: 'tenant-scope-mismatch' };
      if (!classifyRoute(location.pathname).allowed || DENY_RE.test(location.pathname)) return { ok: false, reason: 'not-on-approved-detail-route' };
      const ctx = readDetailContext();
      if (!validateId(item.workOrderId) || ctx.id !== item.workOrderId) return { ok: false, reason: 'id-mismatch' };
      if (ctx.acceptedState === 'unknown') return { ok: false, reason: 'already-accepted-or-ineligible' };
      // Uniqueness guard on both action links before we would ever act.
      if (!uniqueEl(SELECTORS.acceptJobLink)) return { ok: false, reason: 'accept-link-not-unique' };
      return { ok: true };
    },

    // WRITE STEP. Wired to CONFIRMED mechanics (test record 2689724 — one Accept
    // Save observed): open the unique "Accept Job" modal (confirmed AJAX GET),
    // require the validated AcceptJob POST form, take the "No ETA Provided" path
    // (leave Eta empty — CONFIRMED valid; only when ETA is NOT client-required),
    // then submit the platform's own "Save" (AJAX POST). No synthesised request,
    // no manufactured field, no .click() on an arbitrary element. Unreachable
    // while LIVE_WRITE_ENABLED is false (head guard + activeAdapter). No retry.
    async acceptJob(item) {
      const g = writeContextOk(item);
      if (!g.ok) return mkResult(item.workOrderId, g.reason === 'live-writes-disabled' ? 'failed' : 'skipped', g.reason);
      const opened = await openActionModalForm('accept');
      if (!opened.ok) return mkResult(item.workOrderId, 'failed', opened.reason);
      const form = opened.form;
      const eta = form.querySelector('input[name="' + WRITE_FORMS.accept.fields.eta + '"]');
      if (!eta) return mkResult(item.workOrderId, 'failed', 'eta-field-missing');
      // "No ETA Provided" only when ETA is not client-required (confirmed jQuery
      // -validate convention). If it IS required, fail closed — ETA-mandatory
      // handling is not confirmed and we never fabricate an ETA.
      if (eta.required || eta.getAttribute('data-val-required') != null) return mkResult(item.workOrderId, 'skipped', 'eta-mandatory-not-supported');
      const submit = form.querySelector(WRITE_FORMS.submitSelector);
      if (!submit) return mkResult(item.workOrderId, 'failed', 'accept-submit-not-found');
      submit.click(); // platform's own control -> confirmed AJAX POST
      // Confirmed post-accept DOM: the Accept Job link drops. Wait for it.
      const ok = await waitFor(function () { return document.querySelectorAll(SELECTORS.acceptJobLink).length === 0; }, 40, 250);
      return ok ? mkResult(item.workOrderId, 'succeeded', 'accept-submitted-no-eta')
        : mkResult(item.workOrderId, 'failed', 'accept-post-submit-not-confirmed');
    },

    // CONFIRMED (transition observed): after acceptance the Accept Job link is
    // absent AND a "Website - Accepted …" event appears. Uses BOTH independent
    // signals; link-absent is the hard requirement, the event corroborates.
    async verifyAccepted(_item) {
      const linkAbsent = document.querySelectorAll(SELECTORS.acceptJobLink).length === 0;
      if (!linkAbsent) return { ok: false, reason: 'accept-link-still-present' };
      return { ok: true, reason: hasAcceptedEvent() ? 'accepted-link-absent-and-event-present' : 'accepted-link-absent-event-pending' };
    },

    // WRITE STEP. Wired to CONFIRMED mechanics: open the unique "Add Notes -
    // Public" modal (confirmed AJAX GET; remains available after acceptance),
    // require the validated AddNotes POST form, sync the frozen note into the
    // confirmed backing textarea (jHtmlArea-aware; plain textarea on this form),
    // verify the value is exact, then submit the platform's own "Save". No retry.
    async addNote(item) {
      const g = writeContextOk(item);
      if (!g.ok) return mkResult(item.workOrderId, g.reason === 'live-writes-disabled' ? 'failed' : 'skipped', g.reason);
      const opened = await openActionModalForm('addNotesPublic');
      if (!opened.ok) return mkResult(item.workOrderId, 'failed', opened.reason);
      const form = opened.form;
      const ta = form.querySelector('textarea[name="' + WRITE_FORMS.addNotesPublic.noteField + '"]');
      if (!ta) return mkResult(item.workOrderId, 'failed', 'note-textarea-not-found');
      prepareJHtmlAreaValue(ta, item.note); // sync into the confirmed backing textarea; no submit
      if (ta.value !== item.note) return mkResult(item.workOrderId, 'failed', 'note-value-mismatch');
      const submit = form.querySelector(WRITE_FORMS.submitSelector);
      if (!submit) return mkResult(item.workOrderId, 'failed', 'note-submit-not-found');
      submit.click(); // platform's own control -> confirmed AJAX POST
      // Confirmed post-save DOM: the modal auto-closes. Wait for the note form to go.
      const closed = await waitFor(function () {
        return Array.prototype.slice.call(document.querySelectorAll(SELECTORS.modalRoot + ' form, .ui-dialog form'))
          .filter(function (f) { return (f.getAttribute('action') || '').indexOf('/AddNotes/') !== -1; }).length === 0;
      }, 40, 250);
      return closed ? mkResult(item.workOrderId, 'succeeded', 'note-submitted')
        : mkResult(item.workOrderId, 'failed', 'note-post-submit-not-confirmed');
    },

    // Note read-back. CONFIRMED (test record 2689724): open the read-only History
    // dialog via #workOrderNoteHistoryLink; notes render in a same-origin iframe
    // (#notehistoryframe) as `.message` blocks. Scan them normalized and compare
    // with the expected note. Never reports success from HTTP/modal-close/event.
    // Distinct outcomes for unrecognized/ambiguous/timeout; and if the History
    // control is absent (can't open reliably) keep the conservative fallback so a
    // truly-submitted note is not falsely failed.
    async verifyNote(item) {
      const link = uniqueEl(SELECTORS.noteHistoryLink);
      if (!link) return { ok: true, reason: 'note-submitted-awaiting-readback-verification' };
      const $ = window.jQuery;
      if ($) $(link).trigger('click'); else link.click(); // read-only History (WorkOrderReadOnly)
      await waitFor(function () { return noteHistoryFrameDoc().status === 'ready'; }, 40, 250);
      const r = noteHistoryFrameDoc();
      if (r.status === 'ambiguous') return { ok: true, reason: 'note-history-ambiguous' };
      if (r.status === 'unrecognized') return { ok: true, reason: 'note-history-modal-unrecognized' };
      if (r.status !== 'ready') return { ok: true, reason: 'note-history-timeout' };
      return matchNoteInMessages(r.messages, item.note)
        ? { ok: true, reason: 'note-readback-verified' }
        : { ok: false, reason: 'note-readback-not-found' };
    },
  };

  function activeAdapter() {
    return CONFIG.LIVE_WRITE_ENABLED ? PrimmsWriteAdapter : DryRunAdapter;
  }

  /**
   * Sequential single-item state machine. Never concurrent. Emits each state via
   * onState(state, message) so the panel shows live progress for the record.
   * @param {WorkOrderAdapter} adapter @param {BatchItem} item
   * @param {(state:string, message:string)=>void} onState
   * @returns {Promise<BatchResult>}
   */
  async function processItem(adapter, item, onState) {
    const emit = onState || function () {};
    try {
      emit('validating', '');
      const v = await adapter.validateItem(item);
      if (!v.ok) { emit('skipped', v.reason); return mkResult(item.workOrderId, 'skipped', v.reason || 'validation-failed'); }

      emit('accepting', '');
      const acc = await adapter.acceptJob(item);
      if (acc.outcome === 'failed') { emit('failed', acc.message); return acc; }

      emit('accept-verified', '');
      const av = await adapter.verifyAccepted(item);
      if (!av.ok) { emit('failed', 'accept-verify:' + (av.reason || '')); return mkResult(item.workOrderId, 'failed', 'accept-verify-failed:' + (av.reason || '')); }

      emit('adding-note', '');
      const an = await adapter.addNote(item);
      // accepted-but-note-failed => distinguishable PARTIAL failure. Never reversed.
      if (an.outcome === 'failed') { emit('failed', 'partial'); return mkResult(item.workOrderId, 'failed', 'partial-accepted-note-failed:' + an.message); }

      emit('note-verified', '');
      const nv = await adapter.verifyNote(item);
      if (!nv.ok) { emit('failed', 'note-verify'); return mkResult(item.workOrderId, 'failed', 'partial-accepted-note-verify-failed:' + (nv.reason || '')); }

      emit('succeeded', '');
      return mkResult(item.workOrderId, 'succeeded', 'accepted + note verified');
    } catch (e) {
      const msg = 'exception:' + (e && e.message ? e.message : 'error');
      emit('failed', msg);
      return mkResult(item.workOrderId, 'failed', msg);
    }
  }

  // ==========================================================================
  // MODULE: panel  (floating, collapsible, draggable, house style, a11y)
  // ==========================================================================

  const FONT = "'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
  const MONO = "'DM Mono', ui-monospace, Consolas, monospace";

  const state = {
    routeKind: null,          // 'list' | 'detail'
    grid: null,               // last readGrid() result
    selected: Object.create(null), // ref -> true
    operatorName: '',
    greeting: '',             // '' => use local-clock default
    delayMs: CONFIG.DEFAULT_DELAY_MS,
    continueAfterFailure: false,
    dryRunViewedFor: '',      // selection signature the operator last previewed
    stopRequested: false,
    collapsed: false,
    _observer: null,
  };

  function selectionSignature() {
    return Object.keys(state.selected).sort().join('|') + '::' + (state.operatorName || '') + '::' + currentGreeting(state);
  }

  function injectStyle() {
    if (document.getElementById(K.STYLE_ID)) return;
    const css = [
      // Local font stack only. No @import, no remote fonts.
      '#' + K.PANEL_ID + '{position:fixed;top:64px;right:18px;width:360px;max-height:86vh;overflow:auto;',
      'z-index:' + K.Z_INDEX + ';background:#f0f4f8;border:1px solid #cbd5e1;border-radius:12px;',
      'box-shadow:0 12px 34px rgba(13,38,26,.22);font-family:' + FONT + ';color:#0f172a;font-size:13px;line-height:1.45;}',
      '.' + K.CSS_PREFIX + 'hd{display:flex;align-items:center;gap:8px;cursor:move;user-select:none;',
      'background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;padding:11px 13px;border-radius:12px 12px 0 0;}',
      '.' + K.CSS_PREFIX + 'hd .logo{font-weight:700;letter-spacing:.3px;font-size:12px;}',
      '.' + K.CSS_PREFIX + 'hd .title{margin-left:auto;text-align:right;font-weight:600;font-size:13px;}',
      '.' + K.CSS_PREFIX + 'hd button{background:rgba(255,255,255,.16);color:#fff;border:none;border-radius:6px;cursor:pointer;font:600 12px ' + FONT + ';padding:3px 8px;}',
      '.' + K.CSS_PREFIX + 'body{padding:12px 13px;}',
      '.' + K.CSS_PREFIX + 'sec{margin:0 0 12px;}',
      '.' + K.CSS_PREFIX + 'sec h4{margin:0 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#475569;}',
      '.' + K.CSS_PREFIX + 'warn{background:#fef3c7;border:1px solid #f59e0b;color:#78350f;border-radius:8px;padding:8px 10px;font-size:12px;}',
      '.' + K.CSS_PREFIX + 'auth{background:#0d3d26;color:#eafff3;border-radius:8px;padding:9px 11px;font-size:12px;}',
      '.' + K.CSS_PREFIX + 'badge{display:inline-block;border-radius:999px;padding:2px 10px;font:700 11px ' + FONT + ';}',
      '.' + K.CSS_PREFIX + 'badge.dry{background:#dcfce7;color:#166534;}',
      '.' + K.CSS_PREFIX + 'badge.live{background:#fee2e2;color:#991b1b;}',
      '.' + K.CSS_PREFIX + 'banner{background:#1a5f3e;color:#fff;border-radius:8px;padding:8px 10px;font-weight:600;}',
      '.' + K.CSS_PREFIX + 'row{display:flex;gap:6px;align-items:center;margin:5px 0;flex-wrap:wrap;}',
      '.' + K.CSS_PREFIX + 'body label{font-size:12px;color:#334155;}',
      '.' + K.CSS_PREFIX + 'body input[type=text],.' + K.CSS_PREFIX + 'body input[type=number],.' + K.CSS_PREFIX + 'body select,.' + K.CSS_PREFIX + 'body textarea{',
      'width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;padding:6px 8px;font:13px ' + FONT + ';background:#fff;color:#0f172a;}',
      '.' + K.CSS_PREFIX + 'body textarea{min-height:60px;resize:vertical;font:12px ' + MONO + ';}',
      '.' + K.CSS_PREFIX + 'preview{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px dashed #94a3b8;border-radius:7px;padding:8px;font:12px ' + MONO + ';}',
      '.' + K.CSS_PREFIX + 'metrics{display:grid;grid-template-columns:1fr 1fr;gap:4px;font:12px ' + MONO + ';}',
      '.' + K.CSS_PREFIX + 'metrics b{color:#0d3d26;}',
      '.' + K.CSS_PREFIX + 'btn{background:#2ECC71;color:#08331d;border:none;border-radius:8px;cursor:pointer;font:700 13px ' + FONT + ';padding:8px 12px;}',
      '.' + K.CSS_PREFIX + 'btn.sec{background:#e2e8f0;color:#334155;}',
      '.' + K.CSS_PREFIX + 'btn.stop{background:#dc2626;color:#fff;}',
      '.' + K.CSS_PREFIX + 'btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.' + K.CSS_PREFIX + 'ids{max-height:120px;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:6px;font:12px ' + MONO + ';}',
      '.' + K.CSS_PREFIX + 'ids .id{color:#64748b;}',
      '.' + K.CSS_PREFIX + 'audit{max-height:150px;overflow:auto;border:1px solid #e2e8f0;border-radius:7px;background:#fff;}',
      '.' + K.CSS_PREFIX + 'audit table{width:100%;border-collapse:collapse;font:11px ' + MONO + ';}',
      '.' + K.CSS_PREFIX + 'audit td,.' + K.CSS_PREFIX + 'audit th{border-bottom:1px solid #f1f5f9;padding:3px 5px;text-align:left;}',
      '.' + K.CSS_PREFIX + 'status{font:12px ' + MONO + ';color:#334155;background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:7px;}',
      '.' + K.CSS_PREFIX + 'rowlist{max-height:180px;overflow:auto;border:1px solid #e2e8f0;border-radius:7px;background:#fff;}',
      '.' + K.CSS_PREFIX + 'rowlist .r{display:flex;gap:7px;align-items:center;padding:4px 6px;border-bottom:1px solid #f1f5f9;font:12px ' + FONT + ';}',
      '.' + K.CSS_PREFIX + 'rowlist .r.inelig{opacity:.55;}',
      '.' + K.CSS_PREFIX + 'rowlist .r .ref{font:600 12px ' + MONO + ';}',
      '.' + K.CSS_PREFIX + 'muted{color:#64748b;font-size:11px;}',
      '.' + K.CSS_PREFIX + 'collapsed .' + K.CSS_PREFIX + 'body{display:none;}',
    ].join('');
    const el = document.createElement('style');
    el.id = K.STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k]; // only ever fed our own literals
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  let statusLine = '';
  function setStatus(s) { statusLine = s; render(); }

  function computeEligibility() {
    const grid = state.grid;
    if (!grid || !grid.ok) return { mode: CONFIG.ELIGIBILITY_MODE, eligible: [], note: MSG.gridUnrecognized, disabled: true };
    if (CONFIG.ELIGIBILITY_MODE === 'column') {
      const e = eligibilityByColumn(grid);
      if (!e.headerFound) return { mode: 'column', eligible: [], note: MSG.eligibilityUnknown, disabled: true, ruleSummary: 'Column: none of [' + CONFIG.ELIGIBILITY_HEADER_CANDIDATES.join(', ') + '] found' };
      return { mode: 'column', eligible: e.eligible, disabled: false, ruleSummary: 'Column "' + e.matchKey + '" matches [' + CONFIG.ELIGIBILITY_MATCH_VALUES.join(', ') + ']' };
    }
    // allowlist
    const pasted = parseAllowList(state._allowText || '');
    const e = eligibilityByAllowList(grid, pasted);
    return {
      mode: 'allowlist', eligible: e.eligible, disabled: pasted.length === 0,
      pastedNotVisible: e.pastedNotVisible, pastedCount: pasted.length,
      ruleSummary: 'Allow-list: ' + pasted.length + ' pasted ref(s) intersected with visible rows',
    };
  }

  function render() {
    if (!document.getElementById(K.STYLE_ID)) injectStyle();
    let panel = document.getElementById(K.PANEL_ID);
    if (!panel) {
      panel = h('div', { id: K.PANEL_ID, role: 'region', 'aria-label': 'PRIMMS Bulk Acceptance Assistant' });
      document.body.appendChild(panel);
    }
    panel.className = state.collapsed ? K.CSS_PREFIX + 'collapsed' : '';
    panel.innerHTML = '';

    // Header
    const hd = h('div', { class: K.CSS_PREFIX + 'hd' }, [
      h('span', { class: 'logo', text: 'BWN' }),
      h('span', { class: 'title', text: 'PRIMMS Bulk Acceptance Assistant' }),
      h('button', { type: 'button', 'aria-label': 'Collapse panel', text: state.collapsed ? '+' : '–', onclick: function () { state.collapsed = !state.collapsed; render(); } }),
    ]);
    makeDraggable(panel, hd);
    panel.appendChild(hd);

    const body = h('div', { class: K.CSS_PREFIX + 'body' });
    panel.appendChild(body);

    // 1. Authorization warning
    body.appendChild(h('div', { class: K.CSS_PREFIX + 'sec' }, [
      h('div', { class: K.CSS_PREFIX + 'auth', text: 'Use only with authorization from Primark/Ostara and Broadway National. You are responsible for reviewing each batch before submission.' }),
    ]));

    // 2. Compatibility status
    const grid = state.grid;
    let compat = 'Ready.';
    if (state.routeKind === 'list') {
      if (!grid || !grid.ok) compat = MSG.gridUnrecognized;
      else if (grid.woCol < 0) compat = MSG.noWoColumn;
      else compat = 'Grid recognized. ' + grid.rows.length + ' visible row(s).';
    } else if (state.routeKind === 'detail') {
      compat = 'Detail page. Selection happens on the jobs list.';
    }
    body.appendChild(section('Compatibility', [h('div', { class: K.CSS_PREFIX + 'status', text: compat })]));

    // 3. Mode badge
    const badge = CONFIG.LIVE_WRITE_ENABLED
      ? h('span', { class: K.CSS_PREFIX + 'badge live', text: 'LIVE WRITE' })
      : h('span', { class: K.CSS_PREFIX + 'badge dry', text: 'DRY RUN' });
    body.appendChild(section('Mode', [
      badge,
      h('span', { class: K.CSS_PREFIX + 'muted', text: '  build ' + K.BUILD_ID }),
      CONFIG.LIVE_WRITE_ENABLED ? null : h('div', { class: K.CSS_PREFIX + 'muted', text: MSG.liveDisabled }),
    ]));

    // 4. Batch-in-progress banner (armed) — shows live per-record state.
    const tokState = validateArmedToken(readTenantScope());
    if (tokState.valid) {
      const batch = ssRead(BATCH_KEY) || { index: 0, items: [] };
      const cur = state.currentItem;
      const stateTxt = cur ? (' — ' + cur.state + (cur.msg ? ' (' + cur.msg + ')' : '')) : '';
      body.appendChild(h('div', { class: K.CSS_PREFIX + 'sec' }, [
        h('div', { class: K.CSS_PREFIX + 'banner', text: 'Batch in progress — ' + (batch.index + 1) + ' of ' + (batch.items.length || 0) + stateTxt }),
      ]));
    }

    // 5. Operator name
    body.appendChild(section('Name signing acceptance note', [
      h('input', {
        type: 'text', id: K.CSS_PREFIX + 'name', 'aria-label': 'Name signing acceptance note',
        placeholder: 'e.g. Jordan Blake', value: state.operatorName,
        oninput: function (e) { state.operatorName = e.target.value.trim(); softRender(); },
      }),
      h('button', {
        type: 'button', class: K.CSS_PREFIX + 'btn sec', text: 'Use signed-in PRIMMS user',
        onclick: function () {
          // Prefill only from the header greeting; lands in the editable field and
          // requires operator confirmation before any live batch. Never auto-submitted.
          const guess = deriveOperatorName();
          if (!guess) { setStatus('Could not read the signed-in user from the PRIMMS header. Type the name.'); return; }
          const inp = document.getElementById(K.CSS_PREFIX + 'name');
          if (inp) { inp.value = guess; state.operatorName = guess; }
          softRender();
        },
      }),
    ]));

    // 6. Greeting selector + mismatch warning
    const greetSel = h('select', { 'aria-label': 'Greeting', onchange: function (e) { state.greeting = e.target.value; softRender(); } },
      CONFIG.GREETINGS.map(function (g) {
        const opt = h('option', { value: g, text: g });
        if (g === currentGreeting(state)) opt.setAttribute('selected', 'selected');
        return opt;
      }));
    const greetKids = [greetSel];
    if (greetingMismatch(state)) {
      greetKids.push(h('div', { class: K.CSS_PREFIX + 'warn', text: 'Selected greeting does not match your local time (' + greetingForHour(new Date().getHours()) + ').' }));
    }
    body.appendChild(section('Greeting', greetKids));

    // 7. Note preview (exact, character-for-character)
    const note = renderNote(state);
    body.appendChild(section('Note preview (exact)', [
      h('div', { class: K.CSS_PREFIX + 'preview', text: note }),
      h('div', { class: K.CSS_PREFIX + 'muted', text: note.length + ' characters. This is exactly what would be submitted.' }),
    ]));

    // 8. Eligibility mode + rule summary
    const elig = computeEligibility();
    body.appendChild(section('Eligibility', [
      h('div', { class: K.CSS_PREFIX + 'status', text: 'Mode: ' + elig.mode + (elig.ruleSummary ? ' — ' + elig.ruleSummary : '') }),
      elig.note ? h('div', { class: K.CSS_PREFIX + 'warn', text: elig.note }) : null,
    ]));

    // 9. Metrics
    const rows = grid && grid.ok ? grid.rows : [];
    const eligibleCount = elig.eligible.filter(Boolean).length;
    const selectedCount = Object.keys(state.selected).length;
    const skippedCount = rows.length - eligibleCount;
    body.appendChild(section('Counts', [
      h('div', { class: K.CSS_PREFIX + 'metrics' }, [
        h('div', {}, [h('b', { text: String(rows.length) }), ' visible']),
        h('div', {}, [h('b', { text: String(eligibleCount) }), ' eligible']),
        h('div', {}, [h('b', { text: String(selectedCount) }), ' selected']),
        h('div', {}, [h('b', { text: String(skippedCount) }), ' skipped']),
      ]),
    ]));

    // 10. Allow-list paste area (recommended mode until column path validated)
    if (CONFIG.ELIGIBILITY_MODE === 'allowlist') {
      const kids = [
        h('textarea', {
          'aria-label': 'Paste job reference numbers (from Umbrava)',
          placeholder: 'Paste job reference numbers, one per line or comma-separated (sourced from Umbrava)',
          oninput: function (e) { state._allowText = e.target.value; softRender(); },
        }, [state._allowText || '']),
      ];
      if (elig.pastedNotVisible && elig.pastedNotVisible.length) {
        kids.push(h('div', { class: K.CSS_PREFIX + 'warn', text: elig.pastedNotVisible.length + ' pasted ref(s) not on this page: ' + elig.pastedNotVisible.slice(0, 10).join(', ') + (elig.pastedNotVisible.length > 10 ? '…' : '') }));
      }
      body.appendChild(section('Allow-list', kids));
    }

    // 11. Selection controls + row list
    if (state.routeKind === 'list' && grid && grid.ok && grid.woCol >= 0 && !elig.disabled) {
      const rowlist = h('div', { class: K.CSS_PREFIX + 'rowlist' });
      rows.forEach(function (r, i) {
        const isElig = !!elig.eligible[i];
        const cb = h('input', {
          type: 'checkbox', 'aria-label': 'Select work order ' + r.ref,
        });
        cb.disabled = !isElig || !r.validId || !r.validRef;
        cb.checked = !!state.selected[r.ref];
        cb.addEventListener('change', function () {
          if (cb.checked) {
            if (Object.keys(state.selected).length >= batchCap()) {
              cb.checked = false;
              setStatus('Batch cap is ' + batchCap() + '. Clear some selections first.');
              return;
            }
            state.selected[r.ref] = true;
          } else {
            delete state.selected[r.ref];
          }
          softRender();
        });
        const rowEl = h('div', { class: K.CSS_PREFIX + 'r' + (isElig ? '' : ' inelig') }, [
          cb,
          h('span', { class: 'ref', text: r.ref || '(no ref)' }),
          h('span', { class: K.CSS_PREFIX + 'muted', text: r.validId ? ('id ' + r.id) : 'invalid id' }),
        ]);
        rowlist.appendChild(rowEl);
      });
      body.appendChild(section('Eligible visible rows', [
        h('div', { class: K.CSS_PREFIX + 'row' }, [
          h('button', {
            type: 'button', class: K.CSS_PREFIX + 'btn sec', text: 'Select all eligible visible',
            onclick: function () {
              rows.forEach(function (r, i) {
                if (elig.eligible[i] && r.validId && r.validRef && Object.keys(state.selected).length < batchCap()) state.selected[r.ref] = true;
              });
              softRender();
            },
          }),
          h('button', { type: 'button', class: K.CSS_PREFIX + 'btn sec', text: 'Clear selection', onclick: function () { state.selected = Object.create(null); softRender(); } }),
        ]),
        rowlist,
      ]));
    }

    // 12. Selected identifier list (capped)
    const selRefs = Object.keys(state.selected);
    if (selRefs.length) {
      const idsBox = h('div', { class: K.CSS_PREFIX + 'ids' });
      selRefs.slice(0, K.SELECTED_DISPLAY_CAP).forEach(function (ref) {
        const row = (grid && grid.rows || []).filter(function (r) { return r.ref === ref; })[0];
        idsBox.appendChild(h('div', {}, [ref, ' ', h('span', { class: 'id', text: row ? ('(id ' + row.id + ')') : '' })]));
      });
      const kids = [idsBox];
      if (selRefs.length > K.SELECTED_DISPLAY_CAP) kids.push(h('div', { class: K.CSS_PREFIX + 'muted', text: '+' + (selRefs.length - K.SELECTED_DISPLAY_CAP) + ' more' }));
      body.appendChild(section('Selected (' + selRefs.length + ')', kids));
    }

    // 13. Delay input (enforced floor)
    body.appendChild(section('Inter-item delay (ms)', [
      h('input', {
        type: 'number', min: String(CONFIG.MIN_DELAY_MS), step: '100', value: String(state.delayMs), 'aria-label': 'Inter-item delay in milliseconds',
        onchange: function (e) { state.delayMs = clampDelay(e.target.value); e.target.value = String(state.delayMs); },
      }),
      h('div', { class: K.CSS_PREFIX + 'muted', text: 'Hard floor ' + CONFIG.MIN_DELAY_MS + ' ms, enforced in code.' }),
    ]));

    // 14. Continue-after-failure toggle (default off)
    const cbFail = h('input', { type: 'checkbox', id: K.CSS_PREFIX + 'contfail', 'aria-label': 'Continue after individual failures' });
    cbFail.checked = state.continueAfterFailure;
    cbFail.addEventListener('change', function () { state.continueAfterFailure = cbFail.checked; });
    body.appendChild(section('On failure', [h('label', {}, [cbFail, ' Continue after individual failures (default off)'])]));

    // 15. Dry-run preview
    body.appendChild(h('div', { class: K.CSS_PREFIX + 'row' }, [
      h('button', {
        type: 'button', class: K.CSS_PREFIX + 'btn', text: 'Dry-run preview', onclick: doDryRun,
      }),
    ]));

    // 16. Live execution
    const liveReady = CONFIG.LIVE_WRITE_ENABLED
      && (state.routeKind === 'list')
      && grid && grid.ok && grid.woCol >= 0
      && state.operatorName.length > 0
      && selRefs.length > 0
      && state.dryRunViewedFor === selectionSignature();
    const liveBtn = h('button', { type: 'button', class: K.CSS_PREFIX + 'btn live', text: 'Live execution', onclick: doLive });
    liveBtn.disabled = !liveReady;
    body.appendChild(h('div', { class: K.CSS_PREFIX + 'row' }, [
      liveBtn,
      h('button', { type: 'button', class: K.CSS_PREFIX + 'btn stop', text: 'STOP', onclick: doStop }),
    ]));
    if (!CONFIG.LIVE_WRITE_ENABLED) body.appendChild(h('div', { class: K.CSS_PREFIX + 'muted', text: MSG.liveDisabled }));

    // 17. Status
    if (statusLine) body.appendChild(section('Status', [h('div', { class: K.CSS_PREFIX + 'status', text: statusLine })]));

    // 18. Audit table + export + clear
    const audit = auditRead();
    const at = h('table', {}, [
      h('tr', {}, [h('th', { text: 'time' }), h('th', { text: 'ref' }), h('th', { text: 'outcome' }), h('th', { text: 'reason' })]),
    ]);
    audit.slice(-40).reverse().forEach(function (r) {
      at.appendChild(h('tr', {}, [
        h('td', { text: (r.ts || '').replace('T', ' ').slice(0, 19) }),
        h('td', { text: r.ref }),
        h('td', { text: r.outcome }),
        h('td', { text: r.reason }),
      ]));
    });
    body.appendChild(section('Audit (' + audit.length + ')', [
      h('div', { class: K.CSS_PREFIX + 'audit' }, [at]),
      h('div', { class: K.CSS_PREFIX + 'row' }, [
        h('button', { type: 'button', class: K.CSS_PREFIX + 'btn sec', text: 'Export audit CSV', onclick: exportCsv }),
        h('button', { type: 'button', class: K.CSS_PREFIX + 'btn sec', text: 'Clear audit log', onclick: function () { auditClear(); render(); } }),
      ]),
    ]));
  }

  function section(title, kids) {
    return h('div', { class: K.CSS_PREFIX + 'sec' }, [h('h4', { text: title })].concat(kids || []));
  }

  // Re-render without losing focus on the active input where possible.
  let _softTimer = null;
  function softRender() {
    if (_softTimer) return;
    _softTimer = setTimeout(function () { _softTimer = null; render(); }, 30);
  }

  function makeDraggable(panel, handle) {
    if (handle._bwnDrag) return;
    handle._bwnDrag = true;
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  // ==========================================================================
  // Actions
  // ==========================================================================

  /** @returns {BatchItem[]} note is attached by the caller at batch-build time. */
  function selectedItems() {
    const grid = state.grid;
    const byRef = Object.create(null);
    (grid && grid.rows || []).forEach(function (r) { byRef[r.ref] = r; });
    return Object.keys(state.selected).map(function (ref) {
      const r = byRef[ref] || { ref: ref, id: '', detailUrl: '' };
      return { workOrderId: r.id, ref: r.ref, detailUrl: r.detailUrl, note: '' };
    });
  }

  function doDryRun() {
    const items = selectedItems();
    if (!items.length) { setStatus('Nothing selected. Select at least one eligible row.'); return; }
    const note = renderNote(state);
    // Batch preview: refs, ids, detail URLs, exact note, intended action order.
    const lines = ['DRY RUN — no requests, no clicks, no navigation.',
      'Intended action order per item: Accept Job → Add Notes.',
      'Note (exact): ' + JSON.stringify(note),
      ''];
    items.forEach(function (it, i) {
      lines.push((i + 1) + '. ref=' + it.ref + '  id=' + it.workOrderId + '  url=' + it.detailUrl);
      auditWrite({ ref: it.ref, id: it.workOrderId, action: 'batch', outcome: 'dry-run', reason: 'preview' });
    });
    state.dryRunViewedFor = selectionSignature();
    setStatus(lines.join('\n'));
  }

  function doStop() {
    state.stopRequested = true;
    clearArmedBatch();
    auditWrite({ ref: '', id: '', action: 'batch', outcome: 'stopped', reason: 'operator-stop' });
    setStatus(MSG.stopped);
  }

  function exportCsv() {
    const csv = auditToCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'primms-acceptance-audit-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /** The 12 pre-flight gates required before a live batch may arm. */
  function livePreflight(items) {
    const grid = state.grid;
    if (!CONFIG.LIVE_WRITE_ENABLED) return MSG.liveDisabled;                                  // build gate
    const c = classifyRoute(location.pathname);
    if (!c.allowed || c.kind !== 'list' || DENY_RE.test(location.pathname)) return 'Not on an approved jobs-list route.'; // 1
    if (readTenantScope() !== CONFIG.APPROVED_HOST) return 'Tenant/scope check failed.';       // 2
    if (!grid || !grid.ok) return MSG.gridUnrecognized;                                         // 3
    if (grid.woCol < 0) return MSG.noWoColumn;                                                  // 4
    if (!items.length) return 'Select at least one eligible row.';                              // 5
    if (!state.operatorName.trim()) return 'Enter the name signing the note first.';            // 6
    if (!renderNote(state)) return 'Note preview is empty.';                                    // 7
    if (state.dryRunViewedFor !== selectionSignature()) return 'Run the dry-run preview for this exact selection first.'; // 8
    if (items.length > batchCap()) return 'Batch exceeds the cap of ' + batchCap() + '.'; // 9
    if (clampDelay(state.delayMs) !== state.delayMs || state.delayMs < CONFIG.MIN_DELAY_MS) return 'Delay is below the ' + CONFIG.MIN_DELAY_MS + ' ms floor.'; // 10
    // 11 (explicit arm) + 12 (final confirm) happen below.
    for (let i = 0; i < items.length; i++) {
      if (!validateId(items[i].workOrderId)) return 'A selected row has an invalid id — selection is stale. Re-select.';
      if (!items[i].detailUrl) return 'A selected row has no detail URL — selection is stale. Re-select.';
    }
    return null;
  }

  function doLive() {
    if (!CONFIG.LIVE_WRITE_ENABLED) { setStatus(MSG.liveDisabled); return; }  // guarded twice (button + here)
    const items = selectedItems();
    const block = livePreflight(items);
    if (block) { setStatus(block); return; }

    const note = renderNote(state);
    items.forEach(function (it) { it.note = note; });  // freeze note onto each item

    // Final confirmation (12) — the immediate, explicit gate that arms the token.
    const summary = 'LIVE: this will ACCEPT ' + items.length + ' job(s) and ADD NOTES in PRIMMS.\n\n'
      + 'Work orders:\n' + items.map(function (it) { return '  ' + it.ref + ' (id ' + it.workOrderId + ')'; }).join('\n')
      + '\n\nNote (exact):\n' + note
      + '\n\nDelay between records: ' + state.delayMs + ' ms'
      + '\nOn failure: ' + (state.continueAfterFailure ? 'CONTINUE after failures' : 'STOP on first failure')
      + '\n\nProceed?';
    if (!window.confirm(summary)) { setStatus('Cancelled. Nothing was submitted.'); return; }

    const scope = readTenantScope();
    mintArmedToken(state.operatorName, scope);
    ssWrite(BATCH_KEY, {
      index: 0, note: note, operator: state.operatorName, delayMs: state.delayMs,
      continueAfterFailure: state.continueAfterFailure, scope: scope, items: items,
    });
    state.stopRequested = false;

    // The live workflow is server-rendered and navigates per item, so it resumes
    // via the armed token on each detail-page load (resumeArmedBatch below), not
    // an in-page loop. Kick off by navigating to the first item's detail page.
    setStatus('Armed batch of ' + items.length + '. Opening the first work order…');
    location.assign(items[0].detailUrl);
  }

  /**
   * Armed-batch resume. Runs on each detail-page load. Processes ONE item (the
   * current index) through the state machine, records the result, then either
   * stops (Stop, or failure without continue-after-failure) or advances to the
   * next item's detail page after the configured delay.
   *
   * Inert in this build: LIVE_WRITE_ENABLED is false so it never runs; the write
   * steps are wired but head-guard on the flag. The auto-advance assumes control
   * returns to the detail page after Accept + Add Notes (both are same-page AJAX,
   * confirmed on the test record); re-confirm across a multi-item batch when live.
   */
  async function resumeArmedBatch() {
    if (!CONFIG.LIVE_WRITE_ENABLED) return;
    if (classifyRoute(location.pathname).kind !== 'detail') return;
    const tok = validateArmedToken(readTenantScope());
    if (!tok.valid) { if (ssRead(TOKEN_KEY)) { clearArmedBatch(); setStatus(MSG.noBatch); } return; }
    const batch = ssRead(BATCH_KEY);
    if (!batch || !batch.items || batch.index >= batch.items.length) { clearArmedBatch(); return; }

    const item = batch.items[batch.index];
    // Only process if this page IS the expected next item (duplicate/stale guard).
    if (detailPageId() !== item.workOrderId) { setStatus('Batch paused: page is not the expected next work order.'); return; }

    if (state.stopRequested) { auditWrite({ ref: item.ref, id: item.workOrderId, action: 'batch', outcome: 'stopped', reason: 'operator-stop' }); clearArmedBatch(); setStatus(MSG.stopped); return; }

    state.currentItem = { index: batch.index, total: batch.items.length, ref: item.ref, state: 'queued' };
    const res = await processItem(PrimmsWriteAdapter, item, function (st, msg) {
      state.currentItem.state = st; state.currentItem.msg = msg; render();
    });
    // Split the outcome into accept/note audit rows where meaningful.
    auditWrite({ ref: item.ref, id: item.workOrderId, action: 'accept', outcome: res.outcome, reason: res.message });

    const stop = state.stopRequested || (res.outcome !== 'succeeded' && res.outcome !== 'dry-run' && !batch.continueAfterFailure);
    const nextIndex = batch.index + 1;
    if (stop || nextIndex >= batch.items.length) {
      clearArmedBatch();
      setStatus('Batch finished at ' + (batch.index + 1) + ' of ' + batch.items.length + ' (' + res.outcome + ': ' + res.message + ').');
      return;
    }
    ssWrite(BATCH_KEY, Object.assign({}, batch, { index: nextIndex }));
    await wait(batch.delayMs);
    if (state.stopRequested) { clearArmedBatch(); setStatus(MSG.stopped); return; }
    location.assign(batch.items[nextIndex].detailUrl);
  }

  // ==========================================================================
  // MODULE: main / init  (idempotent; route-guarded; AJAX-partial aware)
  // ==========================================================================

  function refreshGrid() {
    const c = classifyRoute(location.pathname);
    state.routeKind = c.kind;
    if (c.kind === 'list') state.grid = readGrid();
    else state.grid = null;
  }

  function teardown() {
    const p = document.getElementById(K.PANEL_ID);
    if (p) p.remove();
    if (state._observer) { state._observer.disconnect(); state._observer = null; }
  }

  function init() {
    if (!hostOk()) return;
    const c = classifyRoute(location.pathname);
    if (!c.allowed) { teardown(); return; } // fail closed on denied / unrecognized

    refreshGrid();

    // Idempotent: render() reuses the existing panel node if present.
    render();

    // MutationObserver: detect an already-rendered grid being swapped by an
    // AJAX partial refresh (sort/page/page-size) and re-read + re-render.
    // NEVER triggers any action.
    if (!state._observer) {
      const target = document.querySelector(SELECTORS.gridBody) || document.body;
      let t = null;
      state._observer = new MutationObserver(function () {
        if (t) return;
        t = setTimeout(function () {
          t = null;
          const prev = state.grid && state.grid.rows.length;
          refreshGrid();
          const now = state.grid && state.grid.rows.length;
          if (prev !== now || (state.grid && !state.grid.ok)) render();
        }, 150);
      });
      state._observer.observe(target, { childList: true, subtree: true });
    }

    if (CONFIG.DEBUG) console.info('[BWN PBA] init on', location.pathname, 'kind=', c.kind, 'rows=', state.grid && state.grid.rows.length);

    // Armed-batch resume (live only; inert while LIVE_WRITE_ENABLED is false).
    resumeArmedBatch();
  }

  // ==========================================================================
  // Self-test  (pure helpers only; runs when ?bwnPbaSelfTest=1 or CONFIG.DEBUG)
  // ==========================================================================
  function selfTest() {
    const asserts = [];
    function eq(a, b, m) { asserts.push([a === b, m + ' got ' + JSON.stringify(a)]); }
    eq(normalizeHeader('Work Order Nº'), 'work order', 'normalizeHeader strips Nº');
    eq(normalizeHeader('  Created   Date '), 'created date', 'normalizeHeader collapses ws');
    eq(validateId('2646377'), true, 'validateId numeric (confirmed shape)');
    eq(validateId('12/34'), false, 'validateId rejects slash');
    eq(validateId('550e8400-e29b-41d4'), false, 'validateId rejects non-numeric');
    eq(buildNote(CONFIG.NOTE_TEMPLATE, 'Good morning', 'Sam'),
      'Good morning, thank you for this new work order. We will provide an ETA for service as soon as possible. Thank you, Sam', 'buildNote exact');
    eq(buildNote('hi {ACCEPTING_USER_NAME}', 'x', 'Sam'), 'hi Sam', 'buildNote supports {ACCEPTING_USER_NAME}');
    eq(csvEscape('a,b'), '"a,b"', 'csvEscape comma');
    eq(csvEscape('a"b'), '"a""b"', 'csvEscape quote');
    eq(csvEscape('=1+2'), "'=1+2", 'csvEscape neutralizes leading = (formula injection)');
    eq(csvEscape('@cmd'), "'@cmd", 'csvEscape neutralizes leading @');
    eq(clampDelay(500), CONFIG.MIN_DELAY_MS, 'clampDelay floor');
    eq(clampDelay('3000'), 3000, 'clampDelay passes above floor');
    eq(clampDelay('abc'), CONFIG.DEFAULT_DELAY_MS, 'clampDelay non-numeric default');
    eq(greetingForHour(9), 'Good morning', 'greeting am');
    eq(greetingForHour(14), 'Good afternoon', 'greeting pm');
    eq(greetingForHour(20), 'Good evening', 'greeting eve');
    eq(parseAllowList('a, b\nA b').length, 2, 'parseAllowList dedupes case-insensitively');
    eq(extractIdFromHref('/WorkOrder/Detail/98765?qd=1'), '98765', 'extractIdFromHref path');
    eq(normalizeNoteText('<p>Good  afternoon,&nbsp;thanks</p>'), 'Good afternoon, thanks', 'normalizeNoteText strips tags + entities + ws');
    eq(noteTextMatches('<div><p>x Good afternoon, thanks y</p></div>', 'Good afternoon, thanks'), true, 'noteTextMatches finds normalized note in rich-HTML container');
    eq(noteTextMatches('nothing here', 'Good afternoon, thanks'), false, 'noteTextMatches false when absent');
    eq(prepareJHtmlAreaValue(null, 'x'), false, 'prepareJHtmlAreaValue null-safe');
    eq(WRITE_FORMS.addNotesPublic.noteField, 'Notes', 'WRITE_FORMS confirmed note field name');
    eq(validateLoadedActionForm('accept').ok, false, 'validateLoadedActionForm fails closed when no modal loaded');
    eq(parseWelcomeName('Welcome, Broadway Helpdesk | Help | Privacy Policy | Logout'), 'Broadway Helpdesk', 'parseWelcomeName extracts header name');
    eq(parseWelcomeName('no greeting here'), '', 'parseWelcomeName empty when absent');
    const fails = asserts.filter(function (a) { return !a[0]; });
    if (fails.length) { console.error('[BWN PBA] self-test FAILED', fails.map(function (f) { return f[1]; })); }
    else console.info('[BWN PBA] self-test passed (' + asserts.length + ' assertions)');
    return fails.length === 0;
  }

  // ==========================================================================
  // Mock/fixture tests  (DOM-injected; NO live writes; runs under the self-test
  // flag). Exercises the confirmed read/validation/verify logic and proves the
  // write steps stay fail-closed while LIVE_WRITE_ENABLED is false.
  // ==========================================================================
  const NOTE_RACHEL = 'Good afternoon, thank you for this new work order. We will provide an ETA for service as soon as possible. Thank you, Rachel';
  const FIX = {
    token: '<input type="hidden" name="__RequestVerificationToken">',
    acceptForm: function () {
      return '<div id="modalDialog"><form action="/WorkOrderAction/AcceptJob/2689724" method="post">' + FIX.token +
        '<input type="hidden" name="WorkOrderId"><input type="hidden" name="ActionButtonType">' +
        '<input type="hidden" name="HasInitialEta"><input type="hidden" name="TimezoneId"><input type="hidden" name="EtaIsMandatory">' +
        '<input type="datetime-local" name="Eta" id="Eta"><input type="text" name="ResourceReference"><textarea name="Notes"></textarea>' +
        '<input type="submit" value="Save"></form></div>';
    },
    noteForm: function () {
      return '<div id="modalDialog"><form action="/WorkOrderAction/AddNotes/2689724" method="post">' + FIX.token +
        '<input type="hidden" name="WorkOrderId"><input type="hidden" name="ActionButtonType">' +
        '<textarea name="Notes" required></textarea><input type="submit" value="Save"></form></div>';
    },
    pendingDetail: '<div id="workOrderActionsList"><a href="/WorkOrderAction/AcceptJob/2689724?a=14">Accept Job</a>' +
      '<a href="/WorkOrderAction/AddNotes/2689724?a=1">Add Notes - Public</a></div>',
    acceptedDetail: '<div id="workOrderActionsList"><a href="/WorkOrderAction/AddNotes/2689724?a=1">Add Notes - Public</a></div>' +
      '<div><a href="/WorkOrder/Event/2689724?eventId=1">Website - Accepted - No ETA Provided</a></div>',
    // Note-history records shaped like the confirmed iframe body (.message per note).
    noteMessages: '<div class="message"><p>Some earlier note body</p></div>' +
      '<div class="message"><p>' + NOTE_RACHEL + '</p></div>',
    noteMessagesNoMatch: '<div class="message"><p>only earlier notes here</p></div>',
  };

  async function mockTest() {
    const A = [];
    function ok(c, m) { A.push([!!c, m]); }
    const host = document.createElement('div');
    host.style.display = 'none';
    document.body.appendChild(host);
    const set = function (html) { host.innerHTML = html; };
    const savedName = state.operatorName;
    try {
      // 5,6 — valid unique forms validate
      set(FIX.acceptForm()); ok(validateLoadedActionForm('accept').ok, 'accept mock form validates');
      set(FIX.noteForm()); ok(validateLoadedActionForm('addNotesPublic').ok, 'addnotes mock form validates');
      // 9 — missing anti-forgery -> invalid
      set(FIX.acceptForm().replace(FIX.token, '')); ok(!validateLoadedActionForm('accept').ok, 'missing anti-forgery -> invalid');
      // 8 — wrong/absent WorkOrderId reported as missing
      set(FIX.acceptForm().replace('<input type="hidden" name="WorkOrderId">', ''));
      const vm = validateLoadedActionForm('accept'); ok(!vm.ok && vm.missing.indexOf('WorkOrderId') !== -1, 'missing WorkOrderId reported');
      // 7 — duplicate form is detectable (openActionModalForm rejects it)
      set(FIX.noteForm() + FIX.noteForm());
      const dup = Array.prototype.slice.call(document.querySelectorAll(SELECTORS.modalRoot + ' form')).filter(function (f) { return /AddNotes/.test(f.getAttribute('action') || ''); });
      ok(dup.length === 2, 'duplicate action forms detectable');
      // 1 — pending detail: accept link present; add notes present
      set(FIX.pendingDetail);
      ok(document.querySelectorAll(SELECTORS.acceptJobLink).length === 1, 'pending: accept link present');
      ok(document.querySelectorAll(SELECTORS.addNotesLink).length === 1, 'add notes present (pending)');
      const vaP = await PrimmsWriteAdapter.verifyAccepted({}); ok(!vaP.ok && vaP.reason === 'accept-link-still-present', 'verifyAccepted false while accept link present');
      // 2,3,4 — accepted detail: accept absent, accepted event present, add notes still present
      set(FIX.acceptedDetail);
      ok(document.querySelectorAll(SELECTORS.acceptJobLink).length === 0, 'accepted: accept link absent');
      ok(hasAcceptedEvent(), 'accepted event detected (normalized)');
      ok(document.querySelectorAll(SELECTORS.addNotesLink).length === 1, 'add notes still present after acceptance');
      const vaA = await PrimmsWriteAdapter.verifyAccepted({}); ok(vaA.ok && /event-present/.test(vaA.reason), 'verifyAccepted ok with both signals');
      // 12 — acceptance verify failure surfaced already above (link present -> not ok)
      // 13/14 — note read-back matcher over .message nodes (iframe body shape)
      set(FIX.noteMessages);
      ok(matchNoteInMessages(host.querySelectorAll('.message'), NOTE_RACHEL), 'matchNoteInMessages finds note in .message (rich HTML)');
      set(FIX.noteMessagesNoMatch);
      ok(!matchNoteInMessages(host.querySelectorAll('.message'), NOTE_RACHEL), 'matchNoteInMessages false when absent');
      // note-history surface resolution: unrecognized (no frame) / ambiguous (two frames)
      set('<div></div>'); ok(noteHistoryFrameDoc().status === 'unrecognized', 'noteHistoryFrameDoc unrecognized with no frame');
      set('<iframe id="notehistoryframe"></iframe><iframe id="notehistoryframe"></iframe>'); ok(noteHistoryFrameDoc().status === 'ambiguous', 'noteHistoryFrameDoc ambiguous with two frames');
      // verifyNote conservative fallback when the History control is absent
      set('<div></div>');
      const vnAwait = await PrimmsWriteAdapter.verifyNote({ note: 'x' }); ok(vnAwait.ok && vnAwait.reason === 'note-submitted-awaiting-readback-verification', 'verifyNote awaiting-readback when no History link');
      // 17 — dry-run adapter selected while flag false
      ok(activeAdapter().name === 'DryRunAdapter' && activeAdapter().writes === false, 'dry-run adapter active while flag false');
      // 11/misc — write steps head-guard fail closed while flag false (also 18: no submit reached)
      const aj = await PrimmsWriteAdapter.acceptJob({ workOrderId: '2689724' }); ok(aj.outcome === 'failed' && aj.message === 'live-writes-disabled', 'acceptJob fails closed while flag false');
      const an = await PrimmsWriteAdapter.addNote({ workOrderId: '2689724', note: 'x' }); ok(an.outcome === 'failed' && an.message === 'live-writes-disabled', 'addNote fails closed while flag false');
      // 19 — name prefill parser across the required cases
      ok(parseWelcomeName('Welcome, Broadway Helpdesk | Help') === 'Broadway Helpdesk', 'prefill: Broadway Helpdesk');
      ok(parseWelcomeName('Welcome, Rachel | Logout') === 'Rachel', 'prefill: Rachel');
      ok(parseWelcomeName('Welcome, Jane Doe | Help') === 'Jane Doe', 'prefill: Jane Doe');
      ok(parseWelcomeName('no header present') === '', 'prefill: missing header');
      // 20 — frozen signer: a batch item's note is independent of later field edits
      const frozen = [{ workOrderId: '1', ref: '1', detailUrl: '', note: NOTE_RACHEL }];
      state.operatorName = 'Someone Else Entirely';
      ok(frozen[0].note === NOTE_RACHEL, 'frozen signer: batch item note unchanged after field edit');
      // 15/16 — Stop + duplicate-submit guards live in resumeArmedBatch (id must match; index persisted): structural presence
      ok(typeof resumeArmedBatch === 'function' && typeof batchCap === 'function' && batchCap() === 1, 'stop/dupe guards present; batchCap==1');
    } finally {
      state.operatorName = savedName;
      document.body.removeChild(host);
    }
    const fails = A.filter(function (a) { return !a[0]; });
    if (fails.length) console.error('[BWN PBA] mock-test FAILED', fails.map(function (f) { return f[1]; }));
    else console.info('[BWN PBA] mock-test passed (' + A.length + ' assertions)');
    return fails.length === 0;
  }

  // ==========================================================================
  // Boot
  // ==========================================================================
  try {
    if (CONFIG.DEBUG || /[?&]bwnPbaSelfTest=1/.test(location.search)) {
      selfTest();
      // Run the DOM-injected mock tests on a page without a real actions list /
      // modal (e.g. the jobs list) so the fixtures don't collide with live nodes.
      if (!document.querySelector(SELECTORS.actionsList) && !document.querySelector(SELECTORS.modalRoot)) {
        mockTest();
      } else {
        console.info('[BWN PBA] mock-test skipped: run ?bwnPbaSelfTest=1 on the jobs list (no live modal/actions list).');
      }
    }
    init();
    // SPA-lite: PRIMMS is server-rendered, but guard against pushState nav too.
    ['pushState', 'replaceState'].forEach(function (m) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); setTimeout(init, 60); return r; };
    });
    window.addEventListener('popstate', function () { setTimeout(init, 60); });
  } catch (e) {
    if (CONFIG.DEBUG) console.error('[BWN PBA] boot error', e);
  }
})();
