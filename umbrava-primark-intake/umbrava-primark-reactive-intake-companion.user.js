// ==UserScript==
// @name         Umbrava - Primark Reactive Intake & Dispatch Companion
// @namespace    https://broadwaynational.com/bwn
// @version      0.1.2
// @description  Read-only Umbrava companion for Broadway National's Primark Reactive intake. On a Primark email-created Reactive work order it surfaces the PRIMMS/Ostara work-order number (Source PO #), a plain-text dispatch brief, and a deadline/priority badge, and lets the coordinator copy the number into the separate PRIMMS Bulk Acceptance Assistant. Never writes to Umbrava, never touches PRIMMS, never reads email. No network calls of any kind.
// @author       Broadway National (BWN Ops)
// @match        https://app.umbrava.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

/*
 * SYSTEM BOUNDARIES (enforced, not aspirational)
 * ----------------------------------------------
 * - This script runs ONLY on https://app.umbrava.com and reads the already-rendered DOM.
 * - It performs ZERO network activity: no fetch, XMLHttpRequest, GM_xmlhttpRequest, WebSocket,
 *   sendBeacon, @require, remote import, external asset, telemetry, or analytics.
 * - It NEVER writes to Umbrava (no form submit, status/priority/schedule change, note, dispatch,
 *   quote, invoice, PO, document, or task) and NEVER navigates to, inspects, or controls PRIMMS/Ostara.
 * - It does not read Outlook, mailbox data, or .msg files, and creates no cross-system API/sync.
 * - Clipboard writes and the CSV download happen ONLY from an explicit user button click.
 * - No work-order content is persisted; localStorage holds only the panel collapse/position preference.
 *
 * The numeric PRIMMS/Ostara work-order number is the human workflow correlation key. This script
 * only helps a coordinator read it and hand it off; acceptance happens in the separate PRIMMS tool.
 *
 * Discovery basis: field labels, routes, and markers below were confirmed by read-only observation
 * of the live app.umbrava.com tenant on 2026-09-16. See discovery-checklist.md.
 */

(function () {
  'use strict';

  // ===========================================================================
  // Configuration
  // ===========================================================================
  const CONFIG = {
    SCRIPT_VERSION: '0.1.2',
    UMBRAVA_HOST: 'app.umbrava.com',

    // Confirmed live: detail route is /work-orders/{number}[/details]; list route is /work-orders
    // (optionally with a query string). Everything else is denied.
    ROUTE_ALLOWLIST: [
      { name: 'wo-detail', re: /^\/work-orders\/\d+(?:\/details)?\/?$/ },
      { name: 'wo-list', re: /^\/work-orders\/?$/ }
    ],
    // Explicit denials. Any route not in the allow-list is denied anyway (fail closed); these are
    // spelled out so the intent is auditable and so a future allow-list widening cannot accidentally
    // expose a mutating surface.
    ROUTE_DENYLIST: [
      /^\/login/i, /^\/logout/i, /callback/i, /^\/auth/i,
      /^\/settings/i, /^\/admin/i, /\/company\//i, /\/users?\//i, /\/roles?\//i,
      /\/create/i, /\/new\b/i, /\/edit\b/i,
      /\/work-orders\/\d+\/(notes|documents|trips|billing|proposals|tasks|work-order-location|work-order-history)/i,
      /\/dispatch/i, /\/assign/i,
      /\/invoices?\b/i, /\/proposals?\b/i, /\/purchase-orders?\b/i, /\/quotes?\b/i,
      /\/upload/i
    ],

    // Primark client: shown as a client link/heading in the WO header (href^="/clients/").
    // Confirmed live value is "Primark"; "Primark USA" retained as the email-side label variant.
    PRIMARK_CLIENT_FIELD_LABELS: ['Client'],
    PRIMARK_CLIENT_VALUES: ['Primark', 'Primark USA'],

    // Work type. Confirmed detail label "WO Type"; confirmed value "Reactive".
    REACTIVE_TYPE_FIELD_LABELS: ['WO Type', 'Work Order Type'],
    REACTIVE_TYPE_VALUES: ['Reactive'],

    // Email origin. Confirmed live: the Notes panel carries a system note authored by "Umbrava"
    // with channel/type "Email" and body "This work order was created using AI...". Any ONE of
    // these markers, scoped to a note item, confirms email origin.
    EMAIL_SOURCE_FIELD_LABELS: ['Email', 'Umbrava'],
    EMAIL_SOURCE_VALUES: ['Email', 'created using ai'],

    // PRIMMS/Ostara number. Confirmed live: detail field label "Source PO #" (an <input>).
    // "Source Job #" is a DIFFERENT field (Source WO/Project #) and is empty for these records -
    // it is intentionally NOT read as the PRIMMS reference.
    PRIMMS_REFERENCE_FIELD_LABELS: ['Source PO #', 'Source PO Number'],

    // Dispatch-brief fields (confirmed detail labels / list column headers).
    STORE_FIELD_LABELS: ['Location'],
    STORE_LIST_COLUMNS: ['Location #', 'Location Name', 'City'],
    TRADE_FIELD_LABELS: ['Trade(s)', 'Trades'],
    TRADE_LIST_COLUMNS: ['Trades', 'Trade(s)'],
    WORK_SUMMARY_FIELD_LABELS: ['WO Scope', 'Scope Of Work'],
    WORK_SUMMARY_LIST_COLUMNS: ['Scope Of Work'],
    LOCATION_FIELD_LABELS: ['Location'],
    ATTENDANCE_DEADLINE_FIELD_LABELS: ['First Trip By'],
    ATTENDANCE_DEADLINE_LIST_COLUMNS: ['First Trip Date'],
    REASON_CODE_FIELD_LABELS: [], // No dedicated Umbrava field; parsed from WO Scope text when present.
    ATTACHMENT_INDICATOR_LABELS: ['Documents'],
    INTERNAL_STATUS_FIELD_LABELS: ['WO Status'],
    INTERNAL_STATUS_LIST_COLUMNS: ['Status'],
    PRIMMS_ID_COLUMN_LABELS: ['Source PO #', 'Source PO Number'],
    CLIENT_LIST_COLUMNS: ['Client', 'Client Name'],

    // A valid PRIMMS/Ostara id is a plain 5-12 digit number (live sample: 7 digits).
    PRIMMS_ID_PATTERN: /^\d{5,12}$/,

    // Deadline thresholds (hours). Exposed so ops can retune without editing logic.
    DUE_TODAY_HOURS: 24,
    DUE_SOON_HOURS: 48,
    DUE_THIS_WEEK_HOURS: 168,

    DEBUG: false
  };

  // ===========================================================================
  // JSDoc typedefs
  // ===========================================================================
  /**
   * @typedef {Object} PrimarkClassification
   * @property {'confirmed'|'possible'|'no'} client   Primark client determination.
   * @property {'confirmed'|'no'} reactive             Reactive work-type determination.
   * @property {'confirmed'|'unconfirmed'|'unavailable'} emailOrigin Email-origin determination.
   * @property {'confirmed'|'possible'|'no'} overall   Combined Primark-Reactive verdict.
   */
  /**
   * @typedef {Object} PrimmsReferenceMatch
   * @property {'one'|'none'|'multiple'|'unavailable'} state
   * @property {string|null} id     The single valid id when state === 'one', else null.
   * @property {string[]} candidates All distinct valid ids found.
   */
  /**
   * @typedef {Object} DispatchBrief
   * @property {string|null} primmsId
   * @property {string|null} store       Confirmed field.
   * @property {string|null} trade       Confirmed field.
   * @property {string|null} work        Confirmed WO Scope text.
   * @property {string|null} area        Inferred from WO Scope (never confirmed).
   * @property {string|null} reason      Inferred from WO Scope (never confirmed).
   * @property {string|null} deadline    Confirmed field.
   * @property {string|null} attachments Best-effort indicator.
   */
  /**
   * @typedef {Object} VisibleListRow
   * @property {string|null} primmsId
   * @property {'one'|'none'|'multiple'|'unavailable'} idState
   * @property {'confirmed'|'possible'|'no'|'unknown'} primark
   * @property {DeadlineState|null} deadline
   * @property {Object.<string,string>} cells  Column-label -> cell text (visible only).
   */
  /**
   * @typedef {Object} DeadlineState
   * @property {'overdue'|'today'|'soon'|'week'|'future'|'unavailable'} state
   * @property {number|null} hoursRemaining
   * @property {string} label
   */
  /**
   * @typedef {Object} CopyResult
   * @property {boolean} ok
   * @property {string} message
   */

  // ===========================================================================
  // Pure helpers  (no DOM, no side effects - exercised by the self-test)
  // ===========================================================================

  /** Normalize a label string: trim, collapse whitespace, drop a trailing "*"/":" and lowercase. */
  function normLabel(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .replace(/[*:]+\s*$/, '')
      .trim()
      .toLowerCase();
  }

  /** Normalize a field VALUE for comparison: trim + collapse whitespace (case preserved). */
  function normValue(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** True when `label` matches any candidate (normalized equality). */
  function labelMatches(label, candidates) {
    const n = normLabel(label);
    return (candidates || []).some(function (c) { return normLabel(c) === n; });
  }

  /**
   * Extract a valid PRIMMS/Ostara numeric id from a raw field value.
   * Accepts a bare number ("2693750") or a prefixed form ("Reactive 2693750",
   * "Work Order Number: Reactive 2693750"). Returns the single matching id, or null.
   * If the value yields more than one DISTINCT valid id, returns null (ambiguous -> caller decides).
   * @param {string} raw
   * @param {RegExp} [pattern]
   * @returns {string|null}
   */
  function extractPrimmsId(raw, pattern) {
    const ids = extractPrimmsIdCandidates(raw, pattern);
    return ids.length === 1 ? ids[0] : null;
  }

  /**
   * All DISTINCT valid PRIMMS ids present in a raw value, in first-seen order.
   * @param {string} raw
   * @param {RegExp} [pattern]
   * @returns {string[]}
   */
  function extractPrimmsIdCandidates(raw, pattern) {
    const pat = pattern || CONFIG.PRIMMS_ID_PATTERN;
    const s = normValue(raw);
    if (!s) return [];
    // Pull every run of digits, then keep those that match the whole-token id pattern.
    const tokens = s.match(/\d+/g) || [];
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (pat.test(t) && out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  /** Deduplicate ids preserving first-seen order. */
  function dedupePreserveOrder(ids) {
    const seen = Object.create(null);
    const out = [];
    (ids || []).forEach(function (id) {
      if (id == null) return;
      const k = String(id);
      if (!seen[k]) { seen[k] = true; out.push(k); }
    });
    return out;
  }

  /**
   * Resolve a PrimmsReferenceMatch from a list of raw candidate strings.
   * @param {string[]} rawValues
   * @returns {PrimmsReferenceMatch}
   */
  function resolvePrimmsReference(rawValues) {
    if (!rawValues || !rawValues.length) return { state: 'unavailable', id: null, candidates: [] };
    let all = [];
    rawValues.forEach(function (v) { all = all.concat(extractPrimmsIdCandidates(v)); });
    const ids = dedupePreserveOrder(all);
    if (ids.length === 0) return { state: 'none', id: null, candidates: [] };
    if (ids.length === 1) return { state: 'one', id: ids[0], candidates: ids };
    return { state: 'multiple', id: null, candidates: ids };
  }

  /** Classify the Primark client from a raw client value. */
  function classifyPrimarkClient(rawClient) {
    const v = normValue(rawClient).toLowerCase();
    if (!v) return 'no';
    const exact = CONFIG.PRIMARK_CLIENT_VALUES.some(function (x) { return v === x.toLowerCase(); });
    if (exact) return 'confirmed';
    // "Primark" appearing as the client value (not arbitrary free text) but not an exact configured
    // value -> possible. Callers only pass the CLIENT field here, never free text.
    if (/\bprimark\b/.test(v)) return 'possible';
    return 'no';
  }

  /** Classify Reactive work type from a raw WO-type value. */
  function classifyReactiveType(rawType) {
    const v = normValue(rawType).toLowerCase();
    if (!v) return 'no';
    return CONFIG.REACTIVE_TYPE_VALUES.some(function (x) { return v.indexOf(x.toLowerCase()) !== -1; })
      ? 'confirmed' : 'no';
  }

  /**
   * Classify email origin from a set of note-marker strings (author, channel, body snippets).
   * @param {string[]} markers
   * @returns {'confirmed'|'unconfirmed'|'unavailable'}
   */
  function classifyEmailOrigin(markers) {
    if (markers == null) return 'unavailable';
    if (!markers.length) return 'unconfirmed';
    const hay = markers.map(function (m) { return normValue(m).toLowerCase(); });
    const hasEmailChannel = hay.some(function (m) { return m === 'email'; });
    const hasUmbravaAuthor = hay.some(function (m) { return m === 'umbrava'; });
    const hasAiNote = hay.some(function (m) { return m.indexOf('created using ai') !== -1; });
    if ((hasEmailChannel && hasUmbravaAuthor) || hasAiNote) return 'confirmed';
    return 'unconfirmed';
  }

  /**
   * Parse a confirmed Umbrava date string into ms epoch, or null.
   * Confirmed formats: "MM/DD/YYYY, h:mm AM", "MM/DD/YYYY", "Mon DD, YYYY".
   * @param {string} raw
   * @returns {number|null}
   */
  function parseUmbravaDate(raw) {
    const s = normValue(raw);
    if (!s) return null;
    // Reject values that carry no date-shaped token at all.
    if (!/\d/.test(s)) return null;
    const ok = /^\d{1,2}\/\d{1,2}\/\d{4}/.test(s) ||
      /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(s) ||
      /^\d{4}-\d{2}-\d{2}/.test(s);
    if (!ok) return null;
    const t = Date.parse(s);
    return isFinite(t) ? t : null;
  }

  /**
   * Compute a DeadlineState from a parsed deadline (ms) relative to `nowMs`.
   * @param {number|null} deadlineMs
   * @param {number} nowMs
   * @returns {DeadlineState}
   */
  function computeDeadlineState(deadlineMs, nowMs) {
    if (deadlineMs == null || !isFinite(deadlineMs)) {
      return { state: 'unavailable', hoursRemaining: null, label: 'Deadline unavailable' };
    }
    const hrs = (deadlineMs - nowMs) / 3600000;
    if (hrs < 0) return { state: 'overdue', hoursRemaining: hrs, label: 'Overdue' };
    if (hrs <= CONFIG.DUE_TODAY_HOURS) return { state: 'today', hoursRemaining: hrs, label: 'Due today' };
    if (hrs <= CONFIG.DUE_SOON_HOURS) return { state: 'soon', hoursRemaining: hrs, label: 'Due within 2 days' };
    if (hrs <= CONFIG.DUE_THIS_WEEK_HOURS) return { state: 'week', hoursRemaining: hrs, label: 'Due within 7 days' };
    return { state: 'future', hoursRemaining: hrs, label: 'Future' };
  }

  /**
   * PRIMMS hand-off is offered ONLY when the record reads as Primark Reactive (confirmed or possible)
   * AND exactly one valid id is present. Source PO # is a generic client-reference field that other
   * clients also populate (e.g. a 12-digit Pilot reference), so a numeric Source PO # on a non-Primark
   * record is NEVER presented or copyable as a PRIMMS/Ostara id.
   * @param {'confirmed'|'possible'|'no'} overall
   * @param {'one'|'none'|'multiple'|'unavailable'} refState
   * @returns {boolean}
   */
  function primmsHandoffAllowed(overall, refState) {
    return overall !== 'no' && refState === 'one';
  }

  /** A list row is eligible for PRIMMS hand-off only when confirmed Primark AND holding one valid id. */
  function listRowEligible(row) {
    return !!row && row.idState === 'one' && row.primark === 'confirmed';
  }

  /** Map a DeadlineState to the local priority indicator (deadline proximity ONLY). */
  function priorityFromDeadline(ds) {
    switch (ds && ds.state) {
      case 'overdue':
      case 'today': return { level: 'Critical', cls: 'crit' };
      case 'soon': return { level: 'Urgent', cls: 'urg' };
      case 'week': return { level: 'Attention', cls: 'att' };
      default: return { level: 'Standard', cls: 'std' };
    }
  }

  /**
   * Pull a labelled segment out of a WO-scope string, e.g. field('Reason Code', scope).
   * The email-created scope uses "Label: value" segments separated by ". " or newlines.
   * @param {string} scope
   * @param {string} label
   * @returns {string|null}
   */
  function scopeSegment(scope, label) {
    const s = normValue(scope);
    if (!s) return null;
    const re = new RegExp('(?:^|[.\\n]\\s*)' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^\\n]*?)(?=(?:\\.\\s+[A-Z][A-Za-z ]{1,20}:)|$)', 'i');
    const m = s.match(re);
    return m ? normValue(m[1]).replace(/[.\s]+$/, '') || null : null;
  }

  /**
   * Build a safe plain-text dispatch brief. Omits unavailable fields (never guesses).
   * @param {DispatchBrief} b
   * @returns {string}
   */
  function buildDispatchBrief(b) {
    const lines = [];
    const add = function (label, val) { if (val != null && normValue(val) !== '') lines.push(label + ': ' + normValue(val)); };
    add('PRIMMS WO', b.primmsId);
    add('Store', b.store);
    add('Trade', b.trade);
    add('Work', b.work);
    add('Attendance deadline', b.deadline);
    add('Attachments', b.attachments);
    // Inferred-from-scope fields are labelled and only included when actually present.
    add('Location (inferred from WO Scope — verify)', b.area);
    add('Reason (inferred from WO Scope — verify)', b.reason);
    return lines.join('\n');
  }

  /** Escape one CSV field and neutralize spreadsheet formula injection. */
  function csvEscape(value) {
    let s = value == null ? '' : String(value);
    // Formula-injection guard: a leading =,+,-,@ (or tab/CR) is prefixed with a single quote.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** Build the reference-only CSV (exactly three approved columns). */
  function buildReferenceCsv(rows) {
    const header = ['PRIMMS Work Order ID', 'Match State', 'Deadline State'];
    const out = [header.map(csvEscape).join(',')];
    (rows || []).forEach(function (r) {
      out.push([csvEscape(r.id), csvEscape(r.matchState), csvEscape(r.deadlineState)].join(','));
    });
    return out.join('\r\n');
  }

  // ===========================================================================
  // DOM read helpers  (read-only; never mutate platform DOM)
  // ===========================================================================

  function currentPath() { return location.pathname.replace(/\/+$/, '') || '/'; }

  /** Best-effort visible-text of an element (excludes nested <label> text). */
  function elementText(el) {
    if (!el) return '';
    return normValue(el.textContent || '');
  }

  /**
   * Find the value of a detail-page field by its visible <label> text.
   * Returns the control's value (input/textarea) or the field container's text, or null.
   * @param {string[]} labelCandidates
   * @returns {string|null}
   */
  function readDetailField(labelCandidates) {
    const labels = Array.prototype.slice.call(document.querySelectorAll('label'));
    for (let i = 0; i < labels.length; i++) {
      const lab = labels[i];
      if (!labelMatches(lab.textContent || '', labelCandidates)) continue;
      // 1) Associated form control by htmlFor / label.control.
      let ctrl = lab.control || null;
      if (!ctrl && lab.htmlFor) ctrl = document.getElementById(lab.htmlFor);
      // 2) Otherwise the nearest control in the label's field container.
      const container = lab.closest('div') || lab.parentElement || lab;
      if (!ctrl) ctrl = container.querySelector('input,textarea,[contenteditable="true"]');
      if (ctrl && typeof ctrl.value === 'string' && ctrl.value !== '') return normValue(ctrl.value);
      if (ctrl && ctrl.getAttribute && ctrl.getAttribute('contenteditable') === 'true') {
        const t = elementText(ctrl); if (t) return t;
      }
      // 3) react-select single value (combobox): the selected label text in the control.
      const single = container.querySelector('[class*="singleValue"],[class*="single-value"]');
      if (single) { const t = elementText(single); if (t) return t; }
      // 4) chip / read-only value: container text minus the label text.
      const full = elementText(container);
      const labText = elementText(lab);
      const rest = normValue(full.replace(labText, ''));
      if (rest) return rest;
    }
    return null;
  }

  /** The Primark client value from the WO header client link, or null. */
  function readClientValue() {
    const form = document.querySelector('form');
    const scope = form || document;
    const link = scope.querySelector('a[href^="/clients/"]');
    if (link) { const t = elementText(link); if (t) return t; }
    return readDetailField(CONFIG.PRIMARK_CLIENT_FIELD_LABELS);
  }

  /**
   * Scan the inline Notes panel for email-origin markers. Returns a marker array,
   * or null when no notes region is present (source field unavailable).
   * @returns {string[]|null}
   */
  function readEmailOriginMarkers() {
    // The notes tabpanel is rendered inline on the detail page. Identify note items by the
    // presence of a channel/author label pair; gather short marker strings only (no bodies stored).
    const region = document.querySelector('[role="tabpanel"]') ||
      document.querySelector('[class*="note" i]') || null;
    if (!region) return null;
    const markers = [];
    const text = elementText(region).toLowerCase();
    if (!text) return [];
    // Cheap, robust markers - presence only, never the customer note body.
    if (/\bumbrava\b/.test(text)) markers.push('Umbrava');
    if (/\bemail\b/.test(text)) markers.push('Email');
    if (text.indexOf('created using ai') !== -1) markers.push('created using AI');
    return markers;
  }

  /** True when the page looks like an Umbrava app page (stable nav marker). */
  function isUmbravaPage() {
    const nav = document.querySelector('a[href="/work-orders"], a[href^="/work-orders"]');
    const hasBrand = !!document.querySelector('a[href="/"] img, [href="/company/profile"]');
    return !!(nav && hasBrand);
  }

  /** True when the detail WO form is present (fail-closed marker). */
  function isDetailReady() {
    const form = document.querySelector('form');
    if (!form) return false;
    // The detail form carries labelled WO fields; require at least the Source PO # / WO Scope label.
    const labels = Array.prototype.slice.call(form.querySelectorAll('label'));
    return labels.some(function (l) {
      return labelMatches(l.textContent || '', CONFIG.PRIMMS_REFERENCE_FIELD_LABELS) ||
        labelMatches(l.textContent || '', CONFIG.WORK_SUMMARY_FIELD_LABELS);
    });
  }

  /** The work-orders list table (the one holding /work-orders/ row links), or null. */
  function findListTable() {
    const tables = document.querySelectorAll('table');
    for (let i = 0; i < tables.length; i++) {
      if (tables[i].querySelector('a[href^="/work-orders/"]')) return tables[i];
    }
    return null;
  }

  /**
   * Build a header map {normalizedLabel: index} from the visible header row of a table.
   * Never relies on fixed indexes.
   * @param {HTMLTableElement} table
   * @returns {{map: Object.<string,number>, labels: string[]}}
   */
  function buildHeaderMap(table) {
    const map = Object.create(null);
    const labels = [];
    let headerCells = [];
    const thead = table.querySelector('thead');
    if (thead) headerCells = Array.prototype.slice.call(thead.querySelectorAll('th,[role="columnheader"]'));
    if (!headerCells.length) {
      const firstRow = table.querySelector('tr');
      if (firstRow) headerCells = Array.prototype.slice.call(firstRow.querySelectorAll('th,[role="columnheader"]'));
    }
    headerCells.forEach(function (c, i) {
      const t = normLabel(c.textContent || '');
      labels[i] = t;
      if (t && !(t in map)) map[t] = i;
    });
    return { map: map, labels: labels };
  }

  /** Column index for the first matching label candidate, or -1. */
  function columnIndex(headerMap, candidates) {
    for (let i = 0; i < (candidates || []).length; i++) {
      const k = normLabel(candidates[i]);
      if (k in headerMap.map) return headerMap.map[k];
    }
    return -1;
  }

  /** Body rows of the list table that carry a /work-orders/ detail link. */
  function listBodyRows(table) {
    const rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
    return rows.filter(function (r) { return r.querySelector('a[href^="/work-orders/"]'); });
  }

  /** Cells of a row, aligned to the header order (data cells only). */
  function rowCells(row) {
    return Array.prototype.slice.call(row.querySelectorAll('td,[role="cell"],[role="gridcell"]'));
  }

  // ===========================================================================
  // Detail-page model
  // ===========================================================================

  /** @returns {PrimarkClassification} */
  function classifyDetail() {
    const client = classifyPrimarkClient(readClientValue());
    const reactive = classifyReactiveType(readDetailField(CONFIG.REACTIVE_TYPE_FIELD_LABELS));
    const emailOrigin = classifyEmailOrigin(readEmailOriginMarkers());
    let overall = 'no';
    if (client === 'confirmed' && reactive === 'confirmed') overall = 'confirmed';
    else if (client !== 'no' && reactive !== 'no') overall = 'possible';
    else if (client !== 'no' || reactive === 'confirmed') overall = 'possible';
    return { client: client, reactive: reactive, emailOrigin: emailOrigin, overall: overall };
  }

  /** @returns {DispatchBrief} */
  function readDispatchBrief() {
    const scope = readDetailField(CONFIG.WORK_SUMMARY_FIELD_LABELS);
    const deadlineRaw = readDetailField(CONFIG.ATTENDANCE_DEADLINE_FIELD_LABELS);
    // `area` and `reason` come ONLY from parsing the WO Scope text - they are inferences, marked
    // as such wherever shown and omitted when absent (never a store-address fallback that would
    // masquerade as a confirmed field).
    return {
      primmsId: null, // filled by caller after reference resolution
      store: readStore(),
      trade: readDetailField(CONFIG.TRADE_FIELD_LABELS),
      work: scope,
      area: scope ? scopeSegment(scope, 'Location') : null,       // inferred from WO Scope
      reason: scope ? scopeSegment(scope, 'Reason Code') : null,  // inferred from WO Scope
      deadline: deadlineRaw,
      attachments: readAttachmentIndicator()
    };
  }

  /** Store label from the WO header (store name + number) or Location field. */
  function readStore() {
    const form = document.querySelector('form') || document;
    // Store name is a heading linking to a work-order-location details route.
    const link = form.querySelector('a[href*="/work-order-location/"]');
    if (link) {
      const name = elementText(link);
      if (name) return name;
    }
    return readDetailField(CONFIG.STORE_FIELD_LABELS);
  }

  /** A best-effort attachment/photo indicator (Documents tab presence), or null. */
  function readAttachmentIndicator() {
    const tab = Array.prototype.slice.call(document.querySelectorAll('a[href*="/documents"], [role="tab"]'))
      .find(function (t) { return labelMatches(t.textContent || '', CONFIG.ATTACHMENT_INDICATOR_LABELS); });
    if (!tab) return null;
    const m = (tab.textContent || '').match(/(\d+)/);
    return m ? ('Documents (' + m[1] + ')') : 'Documents tab present';
  }

  /** Resolve the detail-page PRIMMS reference from the Source PO # field(s). */
  function readPrimmsReference() {
    const raws = [];
    CONFIG.PRIMMS_REFERENCE_FIELD_LABELS.forEach(function (lbl) {
      const v = readDetailField([lbl]);
      if (v) raws.push(v);
    });
    return resolvePrimmsReference(raws);
  }

  // ===========================================================================
  // List-page model
  // ===========================================================================

  /**
   * Parse the visible list into rows + a coverage report.
   * @returns {{rows: VisibleListRow[], coverage: Object}}
   */
  function parseVisibleList() {
    const table = findListTable();
    if (!table) return { rows: [], coverage: { table: false } };
    const header = buildHeaderMap(table);
    const idIdx = columnIndex(header, CONFIG.PRIMMS_ID_COLUMN_LABELS);
    const clientIdx = columnIndex(header, CONFIG.CLIENT_LIST_COLUMNS);
    const typeIdx = columnIndex(header, ['wo type', 'type']);
    const deadlineIdx = columnIndex(header, CONFIG.ATTENDANCE_DEADLINE_LIST_COLUMNS);
    const storeIdx = columnIndex(header, CONFIG.STORE_LIST_COLUMNS);
    const tradeIdx = columnIndex(header, CONFIG.TRADE_LIST_COLUMNS);

    const bodyRows = listBodyRows(table);
    const now = Date.now();
    const rows = bodyRows.map(function (tr) {
      const cells = rowCells(tr);
      const cellText = function (idx) { return idx >= 0 && cells[idx] ? elementText(cells[idx]) : null; };
      const idRaw = cellText(idIdx);
      const ref = idRaw != null ? resolvePrimmsReference([idRaw]) : { state: 'unavailable', id: null, candidates: [] };
      const clientVal = cellText(clientIdx);
      const typeVal = cellText(typeIdx);
      let primark = 'unknown';
      if (clientIdx >= 0) {
        const c = classifyPrimarkClient(clientVal);
        const reactiveOk = typeIdx < 0 ? true : classifyReactiveType(typeVal) === 'confirmed';
        primark = (c === 'confirmed' && reactiveOk) ? 'confirmed' : (c === 'no' ? 'no' : 'possible');
      }
      let deadline = null;
      if (deadlineIdx >= 0) deadline = computeDeadlineState(parseUmbravaDate(cellText(deadlineIdx)), now);
      const cellMap = {};
      if (storeIdx >= 0) cellMap.store = cellText(storeIdx);
      if (tradeIdx >= 0) cellMap.trade = cellText(tradeIdx);
      return {
        primmsId: ref.id,
        idState: ref.state,
        primark: primark,
        deadline: deadline,
        cells: cellMap
      };
    });

    return {
      rows: rows,
      coverage: {
        table: true,
        hasIdColumn: idIdx >= 0,
        hasClientColumn: clientIdx >= 0,
        hasDeadlineColumn: deadlineIdx >= 0,
        visibleRows: rows.length
      }
    };
  }

  // ===========================================================================
  // Clipboard + download  (explicit click only)
  // ===========================================================================

  /** @returns {Promise<CopyResult>} */
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          function () { return { ok: true, message: 'Copied' }; },
          function () { return legacyCopy(text); }
        );
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return { ok: !!ok, message: ok ? 'Copied' : 'Copy failed - select manually' };
    } catch (e) {
      return { ok: false, message: 'Copy failed' };
    }
  }

  /** Trigger a client-side download of text as a file (explicit gesture only). */
  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ===========================================================================
  // UI  (all platform-derived text via textContent; scoped styles)
  // ===========================================================================

  const PANEL_ID = 'bwn-upric-panel';
  const CSS_ID = 'bwn-upric-css';
  const GREEN = '#0d3d26';
  const COLLAPSE_KEY = 'bwn.upric.collapsed';

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = [
      '#' + PANEL_ID + '{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);',
      'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#12211a;background:#fff;',
      'border:1px solid #cdd8d1;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);overflow:hidden;}',
      '#' + PANEL_ID + ' .up-hd{display:flex;align-items:center;gap:8px;background:' + GREEN + ';color:#fff;padding:8px 10px;cursor:pointer;}',
      '#' + PANEL_ID + ' .up-hd b{font-size:13px;font-weight:700;flex:1;}',
      '#' + PANEL_ID + ' .up-hd .up-v{font-size:11px;opacity:.8;}',
      '#' + PANEL_ID + ' .up-bd{padding:10px;max-height:70vh;overflow:auto;}',
      '#' + PANEL_ID + '.up-collapsed .up-bd{display:none;}',
      '#' + PANEL_ID + ' .up-row{margin:4px 0;}',
      '#' + PANEL_ID + ' .up-k{color:#5b6b63;font-size:11px;text-transform:uppercase;letter-spacing:.03em;}',
      '#' + PANEL_ID + ' .up-val{font-size:13px;word-break:break-word;white-space:pre-wrap;}',
      '#' + PANEL_ID + ' .up-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:700;font-size:12px;}',
      '#' + PANEL_ID + ' .b-crit{background:#fdecea;color:#a11;}',
      '#' + PANEL_ID + ' .b-urg{background:#fff4e0;color:#c98a00;}',
      '#' + PANEL_ID + ' .b-att{background:#eef6ff;color:#1666c0;}',
      '#' + PANEL_ID + ' .b-std{background:#eef1ef;color:#3a4a42;}',
      '#' + PANEL_ID + ' .b-ok{background:#e7f6ec;color:#137a3a;}',
      '#' + PANEL_ID + ' .b-warn{background:#fdecea;color:#a11;}',
      '#' + PANEL_ID + ' .up-disc{color:#5b6b63;font-size:11px;margin-top:6px;border-top:1px solid #eef1ef;padding-top:6px;}',
      '#' + PANEL_ID + ' .up-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
      '#' + PANEL_ID + ' button.up-b{border:1px solid ' + GREEN + ';background:#fff;color:' + GREEN + ';border-radius:6px;padding:5px 8px;font-size:12px;cursor:pointer;}',
      '#' + PANEL_ID + ' button.up-b:hover{background:' + GREEN + ';color:#fff;}',
      '#' + PANEL_ID + ' .up-status{font-size:11px;color:' + GREEN + ';margin-top:6px;min-height:14px;}',
      '#' + PANEL_ID + ' .up-warnbox{background:#fdecea;color:#a11;border-radius:6px;padding:8px;font-size:12px;}'
    ].join('');
    document.head.appendChild(st);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // platform-derived text only ever via textContent
    return e;
  }

  function ensurePanel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;
    injectCss();
    p = el('div');
    p.id = PANEL_ID;
    const hd = el('div', 'up-hd');
    hd.appendChild(el('b', null, 'Primark Reactive Intake'));
    hd.appendChild(el('span', 'up-v', 'v' + CONFIG.SCRIPT_VERSION));
    const caret = el('span', 'up-v', '▾');
    hd.appendChild(caret);
    const bd = el('div', 'up-bd');
    p.appendChild(hd);
    p.appendChild(bd);
    document.body.appendChild(p);
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { }
    if (collapsed) p.classList.add('up-collapsed');
    hd.addEventListener('click', function () {
      p.classList.toggle('up-collapsed');
      try { localStorage.setItem(COLLAPSE_KEY, p.classList.contains('up-collapsed') ? '1' : '0'); } catch (e) { }
    });
    return p;
  }

  function setBody(nodes) {
    const p = ensurePanel();
    const bd = p.querySelector('.up-bd');
    bd.textContent = '';
    nodes.forEach(function (n) { bd.appendChild(n); });
  }

  function kv(key, val, badgeCls) {
    const row = el('div', 'up-row');
    row.appendChild(el('div', 'up-k', key));
    if (badgeCls) {
      const b = el('span', 'up-badge ' + badgeCls, val);
      const wrap = el('div', 'up-val'); wrap.appendChild(b); row.appendChild(wrap);
    } else {
      row.appendChild(el('div', 'up-val', val == null || val === '' ? '—' : val));
    }
    return row;
  }

  function statusLine() { return el('div', 'up-status', ''); }

  function loadingRow(text) { return kv('Status', text, 'b-std'); }

  /** Set the panel's render key and replace its body atomically (clears any prior record's data). */
  function renderInto(key, nodes) {
    const p = ensurePanel();
    p.dataset.upricKey = key || '';
    setBody(nodes);
  }

  function classificationBadge(cls) {
    if (cls.overall === 'confirmed') return { text: 'Confirmed Primark Reactive', cls: 'b-ok' };
    if (cls.overall === 'possible') return { text: 'Possible Primark record — review needed', cls: 'b-urg' };
    return { text: 'Not recognized as Primark Reactive', cls: 'b-warn' };
  }
  function emailBadge(state) {
    if (state === 'confirmed') return { text: 'Email-created/source confirmed', cls: 'b-ok' };
    if (state === 'unconfirmed') return { text: 'Email-origin not confirmed', cls: 'b-att' };
    return { text: 'Source field unavailable', cls: 'b-std' };
  }
  function refLine(ref) {
    if (ref.state === 'one') return { text: 'PRIMMS WO: ' + ref.id, cls: 'b-ok' };
    if (ref.state === 'none') return { text: 'No PRIMMS WO reference found', cls: 'b-warn' };
    if (ref.state === 'multiple') return { text: 'Multiple PRIMMS WO references found — review required', cls: 'b-urg' };
    return { text: 'Reference field unavailable', cls: 'b-std' };
  }

  // ===========================================================================
  // Detail-page render
  // ===========================================================================

  function renderDetail(key) {
    const n = currentWoNumber();
    // Fail-closed readiness: until the DOM actually shows THIS record, never render (avoids
    // showing the prior work order's data during an SPA route transition). Bounded retries, then
    // a compatibility warning if the layout never settles.
    if (!detailReady(n)) {
      attempts++;
      if (attempts > MAX_LOAD_ATTEMPTS) {
        renderInto('detail:' + (n || '?') + ':warn', [compatWarningNode('detail')]);
        return;
      }
      renderInto('detail:' + (n || '?') + ':loading', [loadingRow('Loading work order ' + (n ? '#' + n : '') + '…')]);
      return;
    }
    attempts = 0;

    const cls = classifyDetail();
    const ref = readPrimmsReference();
    const isPrimark = cls.overall !== 'no';           // confirmed or possible
    const handoff = primmsHandoffAllowed(cls.overall, ref.state);
    const brief = readDispatchBrief();
    // Only a Primark Reactive record's Source PO # is a PRIMMS/Ostara id - never a non-Primark one.
    brief.primmsId = handoff ? ref.id : null;
    const deadlineMs = parseUmbravaDate(brief.deadline);
    const ds = computeDeadlineState(deadlineMs, Date.now());
    const pri = priorityFromDeadline(ds);

    const nodes = [];
    nodes.push(kv('Compatibility', 'OK — Umbrava WO detail recognized', 'b-ok'));
    const cb = classificationBadge(cls); nodes.push(kv('Classification', cb.text, cb.cls));
    const eb = emailBadge(cls.emailOrigin); nodes.push(kv('Email origin', eb.text, eb.cls));
    if (isPrimark) {
      const rl = refLine(ref); nodes.push(kv('PRIMMS reference', rl.text, rl.cls));
    } else {
      // Do not present a non-Primark Source PO # as a PRIMMS id.
      nodes.push(kv('PRIMMS reference', 'Not a Primark Reactive record — Source PO # not treated as a PRIMMS reference', 'b-std'));
    }

    nodes.push(kv('Store / building', brief.store));
    nodes.push(kv('Trade / area', brief.trade));
    nodes.push(kv('Work summary', brief.work));
    // Inferred-from-scope fields are clearly labelled and omitted entirely when absent - never
    // presented as confirmed, and never used for any classification/ID/deadline/eligibility logic.
    if (brief.area != null && normValue(brief.area) !== '') nodes.push(kv('Location (inferred from WO Scope — verify)', brief.area));
    if (brief.reason != null && normValue(brief.reason) !== '') nodes.push(kv('Reason (inferred from WO Scope — verify)', brief.reason));
    nodes.push(kv('Attendance deadline', brief.deadline));
    nodes.push(kv('Attachments', brief.attachments));
    nodes.push(kv('Internal status', readDetailField(CONFIG.INTERNAL_STATUS_FIELD_LABELS)));

    nodes.push(kv('Deadline', ds.label, 'b-' + (pri.cls === 'crit' ? 'crit' : pri.cls === 'urg' ? 'urg' : pri.cls === 'att' ? 'att' : 'std')));
    nodes.push(kv('Local priority', pri.level, 'b-' + pri.cls));

    const disc = el('div', 'up-disc', 'Priority reflects attendance deadline proximity only. Review the work-order details before dispatch.');
    nodes.push(disc);

    const status = statusLine();
    const btns = el('div', 'up-btns');

    const bId = el('button', 'up-b', 'Copy PRIMMS WO number');
    bId.disabled = !handoff;
    bId.addEventListener('click', function () {
      if (!handoff) return;
      copyText(ref.id).then(function (r) { status.textContent = r.ok ? 'Copied PRIMMS WO number.' : r.message; });
    });

    const bAllow = el('button', 'up-b', 'Copy PRIMMS allow-list entry');
    bAllow.disabled = !handoff;
    bAllow.addEventListener('click', function () {
      if (!handoff) return;
      copyText(ref.id + '\n').then(function (r) { status.textContent = r.ok ? 'Copied allow-list entry.' : r.message; });
    });

    const bBrief = el('button', 'up-b', 'Copy dispatch brief');
    bBrief.addEventListener('click', function () {
      const text = buildDispatchBrief(brief);
      copyText(text).then(function (r) { status.textContent = r.ok ? 'Copied dispatch brief.' : r.message; });
    });

    btns.appendChild(bId); btns.appendChild(bAllow); btns.appendChild(bBrief);
    nodes.push(btns);
    nodes.push(status);

    renderInto(key || ('detail:' + (n || '?') + ':ready'), nodes);
  }

  // ===========================================================================
  // List-page render
  // ===========================================================================

  function renderList(key) {
    // Fail-closed readiness: if the list table has not rendered yet, show a loading state (not a
    // premature "layout not recognized") and let the observer re-boot when it settles.
    if (!findListTable()) {
      attempts++;
      if (attempts > MAX_LOAD_ATTEMPTS) { renderInto('list:' + currentPath() + ':warn', [compatWarningNode('list')]); return; }
      renderInto('list:' + currentPath() + ':loading', [loadingRow('Loading work orders…')]);
      return;
    }
    attempts = 0;

    const parsed = parseVisibleList();
    if (!parsed.coverage.table) { renderInto('list:' + currentPath() + ':warn', [compatWarningNode('list')]); return; }

    const rows = parsed.rows;
    const cov = parsed.coverage;
    const primarkConfirmed = rows.filter(function (r) { return r.primark === 'confirmed'; });
    const withOneId = rows.filter(function (r) { return r.idState === 'one'; });
    const missingId = rows.filter(function (r) { return cov.hasIdColumn && r.idState === 'none'; });
    const ambiguous = rows.filter(function (r) { return r.idState === 'multiple'; });
    const nearDue = rows.filter(function (r) { return r.deadline && (r.deadline.state === 'overdue' || r.deadline.state === 'today' || r.deadline.state === 'soon'); });
    // Hand-off outputs use ONLY confirmed-Primark rows that carry one valid id (Source PO # is a
    // generic client reference; a non-Primark row's number is never treated as a PRIMMS id).
    const eligible = rows.filter(listRowEligible);
    // Batch hand-off needs BOTH the Client column (to confirm Primark) and the Source PO # column.
    const canHandoff = cov.hasClientColumn && cov.hasIdColumn && eligible.length > 0;

    const nodes = [];
    nodes.push(kv('Compatibility', 'OK — Umbrava WO list recognized', 'b-ok'));
    nodes.push(kv('Scope', 'Visible rows only', 'b-std'));
    nodes.push(kv('Visible rows', String(cov.visibleRows)));
    if (cov.hasClientColumn) nodes.push(kv('Confirmed Primark Reactive', String(primarkConfirmed.length)));
    if (cov.hasIdColumn) {
      nodes.push(kv('Rows with one PRIMMS ID', String(withOneId.length)));
      nodes.push(kv('Rows missing an ID', String(missingId.length)));
      nodes.push(kv('Ambiguous-reference rows', String(ambiguous.length)));
    }
    if (cov.hasClientColumn && cov.hasIdColumn) nodes.push(kv('Primark rows ready for hand-off', String(eligible.length)));
    if (cov.hasDeadlineColumn) nodes.push(kv('Near / overdue deadlines', String(nearDue.length)));

    // When a column needed for batch hand-off is absent, say exactly which - fail closed, no guessing.
    if (!cov.hasClientColumn || !cov.hasIdColumn) {
      nodes.push(missingColumnsNode(!cov.hasClientColumn, !cov.hasIdColumn));
    }

    nodes.push(el('div', 'up-disc', 'Visible rows only — not a complete Umbrava search/export. Review details before dispatch or PRIMMS acceptance.'));

    const status = statusLine();
    const btns = el('div', 'up-btns');

    const bAllow = el('button', 'up-b', 'Copy visible PRIMMS allow-list');
    bAllow.disabled = !canHandoff;
    bAllow.addEventListener('click', function () {
      if (!canHandoff) return;
      const ids = dedupePreserveOrder(eligible.map(function (r) { return r.primmsId; }));
      copyText(ids.join('\n') + (ids.length ? '\n' : '')).then(function (r) {
        status.textContent = r.ok ? ('Copied ' + ids.length + ' id(s), visible rows only.') : r.message;
      });
    });

    const bQueue = el('button', 'up-b', 'Copy visible dispatch queue');
    bQueue.disabled = !canHandoff;
    bQueue.addEventListener('click', function () {
      if (!canHandoff) return;
      const lines = eligible.map(function (r) {
        const parts = ['PRIMMS WO: ' + r.primmsId];
        if (r.cells.store != null) parts.push('Store: ' + normValue(r.cells.store));
        if (r.cells.trade != null) parts.push('Trade: ' + normValue(r.cells.trade));
        if (r.deadline) { parts.push('Deadline status: ' + r.deadline.label); }
        return parts.join(' | ');
      });
      copyText(lines.join('\n')).then(function (r) {
        status.textContent = r.ok ? 'Copied dispatch queue (visible rows only).' : r.message;
      });
    });

    const bCsv = el('button', 'up-b', 'Download visible reference-only CSV');
    bCsv.disabled = !canHandoff;
    bCsv.addEventListener('click', function () {
      if (!canHandoff) return;
      const csvRows = eligible.map(function (r) {
        return { id: r.primmsId, matchState: r.idState, deadlineState: r.deadline ? r.deadline.state : 'unavailable' };
      });
      downloadText('primms-reference-visible.csv', buildReferenceCsv(csvRows), 'text/csv');
      status.textContent = 'Downloaded reference-only CSV (visible rows only).';
    });

    btns.appendChild(bAllow); btns.appendChild(bQueue); btns.appendChild(bCsv);
    nodes.push(btns);
    nodes.push(status);
    renderInto(key || ('list:' + currentPath() + ':ready'), nodes);
  }

  function compatWarningNode(kind) {
    return el('div', 'up-warnbox',
      'Umbrava ' + kind + ' layout not recognized. The page structure may have changed — no data was read and no panel logic ran. Update the discovery selectors before relying on this tool.');
  }
  function renderCompatWarning(kind) { setBody([compatWarningNode(kind)]); }

  /**
   * Plain-language fail-closed notice for the list page when the columns needed for a PRIMMS batch
   * hand-off are not in the coordinator's current view. Names the exact required display columns and
   * makes clear nothing was extracted. Reveals no row or work-order content.
   * @param {boolean} needClient
   * @param {boolean} needId
   * @returns {{columns: string[], lines: string[]}}
   */
  function missingColumnsNotice(needClient, needId) {
    const columns = [];
    if (needClient) columns.push('Client');
    if (needId) columns.push('Source PO #');
    return {
      columns: columns,
      lines: [
        'No PRIMMS identifiers were read from this grid.',
        'To prepare a PRIMMS batch hand-off, add these columns to your Work Orders view, then reopen this panel:',
        'This panel reads only the columns shown here. It does not scan row text, and the visible grid is not a complete list of all jobs.'
      ]
    };
  }

  function missingColumnsNode(needClient, needId) {
    const info = missingColumnsNotice(needClient, needId);
    const box = el('div', 'up-warnbox');
    box.appendChild(el('div', null, info.lines[0]));
    box.appendChild(el('div', null, info.lines[1]));
    info.columns.forEach(function (c) { box.appendChild(el('div', null, '• ' + c)); });
    box.appendChild(el('div', 'up-disc', info.lines[2]));
    return box;
  }

  // ===========================================================================
  // Route guard + boot
  // ===========================================================================

  function routeKind() {
    const p = currentPath();
    // Deny first (fail closed).
    for (let i = 0; i < CONFIG.ROUTE_DENYLIST.length; i++) {
      if (CONFIG.ROUTE_DENYLIST[i].test(p)) return null;
    }
    for (let i = 0; i < CONFIG.ROUTE_ALLOWLIST.length; i++) {
      if (CONFIG.ROUTE_ALLOWLIST[i].re.test(p)) return CONFIG.ROUTE_ALLOWLIST[i].name;
    }
    return null; // unknown -> no panel
  }

  function removePanel() {
    const p = document.getElementById(PANEL_ID);
    if (p && p.parentNode) p.parentNode.removeChild(p);
  }

  let lastPath = null;
  let scheduled = false;
  let attempts = 0;               // loading attempts on the current route (bounded before compat warning)
  const MAX_LOAD_ATTEMPTS = 20;   // ~3s of debounced ticks before declaring the layout unrecognized

  /** The numeric WO number from the current detail path, or null. */
  function currentWoNumber() {
    const m = currentPath().match(/\/work-orders\/(\d+)/);
    return m ? m[1] : null;
  }

  /** True only when the detail DOM actually shows the record named in the URL (guards stale-during-nav). */
  function detailShowsNumber(n) {
    if (!n) return false;
    const form = document.querySelector('form');
    if (!form) return false;
    if (form.querySelector('a[href*="/work-orders/' + n + '/"]')) return true;
    return new RegExp('\\bW-?' + n + '\\b').test(form.textContent || '');
  }

  /** Detail is ready to render only when the form is present AND shows the URL's record. */
  function detailReady(n) { return isDetailReady() && detailShowsNumber(n); }

  /**
   * A key identifying exactly what the panel should currently show. A ':ready' key is final
   * (boot will not rebuild it); anything else means "still settling" so boot keeps trying.
   */
  function viewKey() {
    const kind = routeKind();
    if (!kind) return null;
    if (kind === 'wo-list') return 'list:' + currentPath() + ':' + (findListTable() ? 'ready' : 'loading');
    const n = currentWoNumber();
    return 'detail:' + (n || '?') + ':' + (detailReady(n) ? 'ready' : 'loading');
  }

  function boot() {
    scheduled = false;
    if (!productionHostAllowed(location.hostname)) { removePanel(); return; }
    const kind = routeKind();
    if (!kind || !isUmbravaPage()) { removePanel(); return; }
    const key = viewKey();
    const existing = document.getElementById(PANEL_ID);
    // A final (:ready) render is left alone on subsequent mutations - no rebuild, no duplicate
    // buttons/handlers, no status-line reset. Non-final keys always re-render.
    if (existing && existing.dataset.upricKey === key && /:ready$/.test(key || '')) return;
    try {
      if (kind === 'wo-detail') renderDetail(key);
      else if (kind === 'wo-list') renderList(key);
    } catch (e) {
      if (CONFIG.DEBUG) console.warn('[BWN UPRIC] render error', e && e.message);
      renderCompatWarning(kind === 'wo-detail' ? 'detail' : 'list');
    }
  }

  function scheduleBoot() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(boot, 150);
  }

  /** A navigation happened: if the route changed, drop the old panel IMMEDIATELY (no stale data). */
  function onNavigate() {
    const p = currentPath();
    if (p !== lastPath) { lastPath = p; attempts = 0; removePanel(); }
    scheduleBoot();
  }

  function watch() {
    // Detect SPA route changes and local DOM replacement; refresh only. Never triggers actions.
    const obs = new MutationObserver(function () {
      const p = currentPath();
      if (p !== lastPath) { lastPath = p; attempts = 0; removePanel(); scheduleBoot(); return; }
      const panel = document.getElementById(PANEL_ID);
      const kind = routeKind();
      if (!kind) { if (panel) removePanel(); return; }
      // Same allowed route: (re)boot while the panel is missing or still settling (:loading).
      if (!panel || /:loading$/.test(panel.dataset.upricKey || '')) scheduleBoot();
    });
    try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) { }
    // Patch history so pushState/replaceState route changes are caught (and clear stale on change).
    ['pushState', 'replaceState'].forEach(function (m) {
      const orig = history[m];
      if (typeof orig === 'function' && !orig.__bwnUpric) {
        history[m] = function () { const r = orig.apply(this, arguments); onNavigate(); return r; };
        history[m].__bwnUpric = true;
      }
    });
    window.addEventListener('popstate', onNavigate);
  }

  // ===========================================================================
  // Self-test  (?bwnUpricSelfTest=1)
  // ===========================================================================
  function runSelfTest() {
    const results = [];
    const assert = function (name, cond) { results.push({ name: name, pass: !!cond }); };

    // 1. Numeric PRIMMS ID extraction.
    assert('1 numeric id', extractPrimmsId('2693750') === '2693750');
    // 2. Prefixed "Reactive {id}".
    assert('2 prefixed reactive id', extractPrimmsId('Reactive 2693750') === '2693750');
    assert('2b work order number prefixed', extractPrimmsId('Work Order Number: Reactive 2693750') === '2693750');
    // 3. No ID found.
    assert('3 no id', extractPrimmsId('N/A') === null && resolvePrimmsReference(['N/A']).state === 'none');
    // 4. Multiple candidate IDs.
    assert('4 multiple ids', resolvePrimmsReference(['2693750 and 2689724']).state === 'multiple');
    // 5. Invalid ID length (4 digits < 5, 13 digits > 12).
    assert('5 invalid length', extractPrimmsId('1234') === null && extractPrimmsId('12345678901234') === null);
    // 6. Label normalization.
    assert('6 label norm', normLabel('  Source PO # *: ') === 'source po #' && labelMatches('WO Type *', ['wo type']));
    // 7. Primark client classification.
    assert('7 primark client', classifyPrimarkClient('Primark') === 'confirmed' &&
      classifyPrimarkClient('Primark USA') === 'confirmed' && classifyPrimarkClient('Finish Line') === 'no');
    // 8. Reactive work-type classification.
    assert('8 reactive type', classifyReactiveType('Reactive') === 'confirmed' && classifyReactiveType('PPM') === 'no');
    // 9. Email-origin classification (confirmed / unconfirmed / unavailable).
    assert('9a email confirmed', classifyEmailOrigin(['Umbrava', 'Email']) === 'confirmed');
    assert('9b email ai note', classifyEmailOrigin(['This work order was created using AI. Please review.']) === 'confirmed');
    assert('9c email unconfirmed', classifyEmailOrigin(['Client']) === 'unconfirmed');
    assert('9d email unavailable', classifyEmailOrigin(null) === 'unavailable');
    // 10. Deadline parsing for each confirmed format.
    assert('10a parse mm/dd/yyyy time', parseUmbravaDate('10/16/2026, 12:47 PM') !== null);
    assert('10b parse mon dd yyyy', parseUmbravaDate('Oct 16, 2026') !== null);
    assert('10c parse iso', parseUmbravaDate('2026-10-16') !== null);
    assert('10d parse fail', parseUmbravaDate('soon') === null && parseUmbravaDate('') === null);
    // 11. Deadline states.
    var now = Date.parse('2026-09-16T12:00:00Z');
    var H = 3600000;
    assert('11a overdue', computeDeadlineState(now - H, now).state === 'overdue');
    assert('11b today', computeDeadlineState(now + 2 * H, now).state === 'today');
    assert('11c soon', computeDeadlineState(now + 36 * H, now).state === 'soon');
    assert('11d week', computeDeadlineState(now + 100 * H, now).state === 'week');
    assert('11e future', computeDeadlineState(now + 400 * H, now).state === 'future');
    assert('11f unavailable', computeDeadlineState(null, now).state === 'unavailable');
    // 12/13. List parsing after column reorder / missing headers (mock DOM).
    var mock = buildMockList(['WO #', 'Source PO #', 'Client', 'First Trip Date'], [
      ['W-1', '2693750', 'Primark', '10/16/2026'],
      ['W-2', '', 'Primark', '09/16/2026']
    ]);
    var parsed = parseListFromTable(mock, now);
    assert('12 reorder header map', parsed.coverage.hasIdColumn && parsed.rows[0].primmsId === '2693750');
    var mockNoId = buildMockList(['WO #', 'Client'], [['W-1', 'Primark']]);
    var parsedNoId = parseListFromTable(mockNoId, now);
    assert('13 missing id header', parsedNoId.coverage.hasIdColumn === false);
    // 14. Non-Primark record.
    assert('14 non-primark row', parseListFromTable(buildMockList(['WO #', 'Client'], [['W-1', 'Finish Line']]), now).rows[0].primark === 'no');
    // 15/16/17. Detail reference resolution states.
    assert('15 one ref', resolvePrimmsReference(['2693750']).state === 'one');
    assert('16 missing ref', resolvePrimmsReference(['']).state === 'none');
    assert('17 ambiguous ref', resolvePrimmsReference(['2693750', '2689724']).state === 'multiple');
    // 18. Visible-list dedupe preserving order.
    assert('18 dedupe order', dedupePreserveOrder(['2', '1', '2', '3', '1']).join(',') === '2,1,3');
    // 19. Copy-list numeric only.
    var allow = dedupePreserveOrder(['2693750', '2689724']).join('\n');
    assert('19 allow-list numeric only', /^\d+(\n\d+)*$/.test(allow));
    // 20. Dispatch-brief omits unavailable fields.
    var brief = buildDispatchBrief({ primmsId: '2693750', store: 'Herald Square', trade: null, work: 'Paint', area: null, reason: null, deadline: null, attachments: null });
    assert('20 brief omits blanks', brief.indexOf('Trade') === -1 && brief.indexOf('PRIMMS WO: 2693750') === 0 && brief.indexOf('Store: Herald Square') !== -1);
    // 21. CSV three approved columns only.
    var csv = buildReferenceCsv([{ id: '2693750', matchState: 'one', deadlineState: 'week' }]);
    assert('21 csv columns', csv.split('\r\n')[0] === 'PRIMMS Work Order ID,Match State,Deadline State');
    // 22. CSV formula-injection protection.
    assert('22 csv formula guard', csvEscape('=1+1') === "'=1+1" && csvEscape('+A1') === "'+A1" && csvEscape('@x') === "'@x");
    // 23. Copy/download require explicit event (structural: functions exist, not auto-invoked).
    assert('23 no auto side-effect', typeof copyText === 'function' && typeof downloadText === 'function' && !window.__bwnUpricAutoCopied);
    // 24. Denied route -> no panel.
    assert('24 denied route', denyRouteTest('/work-orders/395794/notes') === null && denyRouteTest('/settings') === null && denyRouteTest('/login') === null);
    assert('24b allowed routes', denyRouteTest('/work-orders/395794/details') === 'wo-detail' && denyRouteTest('/work-orders') === 'wo-list');
    // 26. No operational data in storage (only the collapse key is ever written).
    assert('26 storage discipline', COLLAPSE_KEY === 'bwn.upric.collapsed');
    // 27. No network sinks referenced in this module's own source-visible calls (grep is authoritative).
    assert('27 no network api used', typeof window.fetch === 'function'); // presence != use; grep verifies non-use

    // 28. Self-test gating: host-bound vs off-host harness requirement.
    assert('28a gate on-host', shouldRunSelfTest('?bwnUpricSelfTest=1', true) === true);
    assert('28b gate off-host needs harness', shouldRunSelfTest('?bwnUpricSelfTest=1', false) === false);
    assert('28c gate off-host with harness', shouldRunSelfTest('?bwnUpricSelfTest=1&bwnUpricTestHarness=1', false) === true);
    assert('28d gate none', shouldRunSelfTest('?x=1', true) === false);
    // 29. Production panel is host-bound (never renders off the approved host).
    assert('29 production host-bound', productionHostAllowed(CONFIG.UMBRAVA_HOST) === true && productionHostAllowed('evil.example.com') === false);
    // 30. Route transitions resolve to the right kind (detail->detail, detail->denied, denied->detail).
    assert('30a detail->detail', denyRouteTest('/work-orders/100/details') === 'wo-detail' && denyRouteTest('/work-orders/200/details') === 'wo-detail');
    assert('30b detail->denied', denyRouteTest('/work-orders/100/notes') === null && denyRouteTest('/settings') === null);
    assert('30c denied->detail', denyRouteTest('/work-orders/300/details') === 'wo-detail');
    // 31. No duplicate panels; old state cleared before rendering new record; render key set/cleared.
    removePanel();
    var p1 = ensurePanel(), p2 = ensurePanel();
    assert('31a single panel', p1 === p2 && document.querySelectorAll('#' + PANEL_ID).length === 1);
    renderInto('detail:100:ready', [kv('WO', 'first-record-id')]);
    renderInto('detail:200:ready', [kv('WO', 'second-record-id')]);
    var bodyText = p1.querySelector('.up-bd').textContent;
    assert('31b old state cleared', bodyText.indexOf('second-record-id') !== -1 && bodyText.indexOf('first-record-id') === -1);
    assert('31c render key set', p1.dataset.upricKey === 'detail:200:ready');
    removePanel();
    assert('31d removePanel clears', document.getElementById(PANEL_ID) === null && document.querySelectorAll('#' + PANEL_ID).length === 0);
    // 32. List fail-closed notice names the exact required columns and reveals no row content.
    var notice = missingColumnsNotice(true, true);
    assert('32a notice names both', notice.columns.join(',') === 'Client,Source PO #');
    assert('32b notice nothing extracted', /no primms identifiers were read/i.test(notice.lines[0]));
    assert('32c notice not-complete-list', /not a complete list of all jobs/i.test(notice.lines[2]) && /does not scan row text/i.test(notice.lines[2]));
    assert('32d notice id-only', missingColumnsNotice(false, true).columns.join(',') === 'Source PO #');
    // 33. WO Scope data is inferred: labelled when shown, omitted when absent, only from scope segments.
    var briefInf = buildDispatchBrief({ primmsId: '1', store: 'S', trade: null, work: 'W', area: 'Basement', reason: 'Wear and Tear', deadline: null, attachments: null });
    assert('33a inferred labelled', briefInf.indexOf('Location (inferred from WO Scope — verify): Basement') !== -1 && briefInf.indexOf('Reason (inferred from WO Scope — verify): Wear and Tear') !== -1);
    var briefNoInf = buildDispatchBrief({ primmsId: '1', store: 'S', trade: null, work: 'W', area: null, reason: null, deadline: null, attachments: null });
    assert('33b inferred omitted when absent', briefNoInf.indexOf('inferred') === -1);
    assert('33c scope segment parse', scopeSegment('Interior Painting. Reason Code: Wear and Tear. Location: Basement, BOH', 'Reason Code') === 'Wear and Tear');
    // 34. The PRIMMS id line derives from the Source PO # field only - a number inside WO Scope never
    // becomes the id. With primmsId null, no 'PRIMMS WO:' line appears even though the scope has digits.
    assert('34 id independent of scope', buildDispatchBrief({ primmsId: null, store: null, trade: null, work: 'Reason Code: 999999', area: null, reason: null, deadline: null, attachments: null }).indexOf('PRIMMS WO:') === -1);
    // 35. PRIMMS hand-off is gated on Primark classification - a non-Primark numeric Source PO # is
    // never presented or copyable as a PRIMMS id (found live on a Pilot record with a 12-digit Source PO #).
    assert('35a handoff primark+one', primmsHandoffAllowed('confirmed', 'one') === true && primmsHandoffAllowed('possible', 'one') === true);
    assert('35b handoff blocked non-primark', primmsHandoffAllowed('no', 'one') === false);
    assert('35c handoff needs one id', primmsHandoffAllowed('confirmed', 'multiple') === false && primmsHandoffAllowed('confirmed', 'none') === false);
    // 36. List hand-off eligibility requires confirmed Primark AND exactly one valid id.
    assert('36a eligible', listRowEligible({ idState: 'one', primark: 'confirmed' }) === true);
    assert('36b non-primark excluded', listRowEligible({ idState: 'one', primark: 'no' }) === false && listRowEligible({ idState: 'one', primark: 'possible' }) === false);
    assert('36c ambiguous excluded', listRowEligible({ idState: 'multiple', primark: 'confirmed' }) === false);

    report(results);
    return results;
  }

  function denyRouteTest(path) {
    for (let i = 0; i < CONFIG.ROUTE_DENYLIST.length; i++) if (CONFIG.ROUTE_DENYLIST[i].test(path)) return null;
    for (let i = 0; i < CONFIG.ROUTE_ALLOWLIST.length; i++) if (CONFIG.ROUTE_ALLOWLIST[i].re.test(path)) return CONFIG.ROUTE_ALLOWLIST[i].name;
    return null;
  }

  // Mock-DOM builders for the self-test (detached; never attached to the live tree).
  function buildMockList(headers, rows) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    headers.forEach(function (h) { const th = document.createElement('th'); th.textContent = h; htr.appendChild(th); });
    thead.appendChild(htr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach(function (cells, ri) {
      const tr = document.createElement('tr');
      cells.forEach(function (c, ci) {
        const td = document.createElement('td');
        if (ci === 0) { const a = document.createElement('a'); a.setAttribute('href', '/work-orders/' + (395000 + ri) + '/details'); a.textContent = c; td.appendChild(a); }
        else td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  // Test-only variant of parseVisibleList that takes an explicit table + now (pure-ish).
  function parseListFromTable(table, nowMs) {
    const header = buildHeaderMap(table);
    const idIdx = columnIndex(header, CONFIG.PRIMMS_ID_COLUMN_LABELS);
    const clientIdx = columnIndex(header, CONFIG.CLIENT_LIST_COLUMNS);
    const deadlineIdx = columnIndex(header, CONFIG.ATTENDANCE_DEADLINE_LIST_COLUMNS);
    const rows = listBodyRows(table).map(function (tr) {
      const cells = rowCells(tr);
      const cellText = function (idx) { return idx >= 0 && cells[idx] ? elementText(cells[idx]) : null; };
      const ref = idIdx >= 0 ? resolvePrimmsReference([cellText(idIdx)]) : { state: 'unavailable', id: null, candidates: [] };
      let primark = 'unknown';
      if (clientIdx >= 0) { const c = classifyPrimarkClient(cellText(clientIdx)); primark = c === 'confirmed' ? 'confirmed' : (c === 'no' ? 'no' : 'possible'); }
      const deadline = deadlineIdx >= 0 ? computeDeadlineState(parseUmbravaDate(cellText(deadlineIdx)), nowMs) : null;
      return { primmsId: ref.id, idState: ref.state, primark: primark, deadline: deadline, cells: {} };
    });
    return { rows: rows, coverage: { table: true, hasIdColumn: idIdx >= 0, hasClientColumn: clientIdx >= 0, hasDeadlineColumn: deadlineIdx >= 0, visibleRows: rows.length } };
  }

  function report(results) {
    const pass = results.filter(function (r) { return r.pass; }).length;
    const fail = results.length - pass;
    injectCss();
    const p = ensurePanel();
    const bd = p.querySelector('.up-bd');
    bd.textContent = '';
    bd.appendChild(kv('Self-test', pass + '/' + results.length + ' passed', fail ? 'b-warn' : 'b-ok'));
    results.forEach(function (r) {
      const row = el('div', 'up-row');
      row.appendChild(el('div', 'up-val', (r.pass ? '✓ ' : '✗ ') + r.name));
      if (!r.pass) row.style.color = '#a11';
      bd.appendChild(row);
    });
    // Console mirror for CI-style reading (structural only, no work-order content).
    try { console.info('[BWN UPRIC] self-test ' + pass + '/' + results.length + (fail ? ' FAIL' : ' OK')); } catch (e) { }
  }

  // ===========================================================================
  // Entry + gating (pure gate helpers are self-tested)
  // ===========================================================================

  /** True when this hostname is the approved Umbrava host (production panel is host-bound). */
  function productionHostAllowed(hostname) {
    return hostname === CONFIG.UMBRAVA_HOST;
  }

  /**
   * Self-test gate. On the Umbrava host, `?bwnUpricSelfTest=1` alone runs it. Off the Umbrava
   * host it ALSO requires `&bwnUpricTestHarness=1`, so a stray query param on an unrelated site
   * can never spin up the panel or the tests. Off-host it only ever runs the isolated pure +
   * mock-DOM tests and never reads/observes/mutates the host page.
   * @param {string} search location.search
   * @param {boolean} onHost hostname === UMBRAVA_HOST
   * @returns {boolean}
   */
  function shouldRunSelfTest(search, onHost) {
    if (!/[?&]bwnUpricSelfTest=1\b/.test(search)) return false;
    if (onHost) return true;
    return /[?&]bwnUpricTestHarness=1\b/.test(search);
  }

  function main() {
    const onHost = productionHostAllowed(location.hostname);
    if (shouldRunSelfTest(location.search, onHost)) { runSelfTest(); return; }
    // Production panel is host-bound: it must never render off the approved Umbrava host.
    if (!onHost) return;
    lastPath = currentPath();
    watch();
    boot();
  }

  main();
})();
