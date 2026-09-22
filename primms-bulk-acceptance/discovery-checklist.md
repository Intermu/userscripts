# Discovery checklist — Phase 2

Read-only discovery across three authorized sessions (Claude in Chrome), **2026-09-16**, including
the designated disposable test work order **Umbrava 1324040 / PRIMMS 2689724**. The Accept Job and
Add Notes action modals were opened (their GET render is confirmed non-mutating) and inspected
**read-only**. **No form was submitted. No PRIMMS work order was changed.** No values, cookies,
tokens, or request/response bodies were recorded.

`LIVE_WRITE_ENABLED` stays **false**; `acceptJob` / `addNote` fail closed and are not callable.

---

## 1. Confirmed through read-only live observation

- id numeric, path form `/WorkOrder/Detail/{id}`; WO Nº == id; `#panelTitle` holds id (+ building
  name → digits only).
- Accept link count: **pending = 1, accepted = 0** → `verifyAccepted` signal. Accepted record also
  shows a positive "Website - Accepted…" event row.
- **Add Notes remains available after acceptance** (present on both).
- Accepted-state read from **action availability**, not a status enum.
- Action links: unobtrusive-AJAX anchors, labels "Accept Job" / "Add Notes - Public", class
  `imageactionlink`, `data-ajax-method="GET"`, `data-ajax-update="#modalDialog"`,
  `data-ajax-success="…showActionDialog"` → GET renders the action FORM into the `#modalDialog` modal.
- Note read-back surface: read-only `/WorkOrderReadOnly/ViewNoteHistory/{id}`; note bodies are
  rich HTML → normalized container-contains verification.
- Tenant guaranteed by the dedicated host subdomain.

## 2. Confirmed through test-record modal inspection (2689724)

**Accept Job modal** (opened, inspected, closed via titlebar-close — never submitted):
- Modal root `#modalDialog` (unique); jQuery UI dialog titled "Accept Job".
- Form: **method POST**, action `/WorkOrderAction/AcceptJob/{id}`; plain form (no data-ajax) — the
  modal "Save" submits it. Submit control `input[type=submit]` value **"Save"** (unique in form).
  Dialog buttonpane: Close / Save / Cancel. Close/cancel = `.ui-dialog-titlebar-close`.
- Anti-forgery field **name** `__RequestVerificationToken` (value never read).
- Hidden field **names**: `WorkOrderId`, `ActionButtonType`, `HasInitialEta`, `TimezoneId`,
  `EtaIsMandatory`.
- Visible fields (all optional on this record): `Eta` (datetime-local, label "ETA", has
  `[data-valmsg-for="Eta"]`, conditionally mandatory via the `EtaIsMandatory` flag),
  `ResourceReference` (text, "Reference"), `Notes` (textarea, "Notes").
- No explicit confirmation checkbox/reason/status choice.

**Add Notes - Public modal** (opened, inspected, closed — never submitted):
- Same modal root; dialog titled "Add Notes - Public".
- Form: **method POST**, action `/WorkOrderAction/AddNotes/{id}`; plain form; submit `input[type=submit]`
  "Save".
- Anti-forgery **name** `__RequestVerificationToken`; hidden **names** `WorkOrderId`, `ActionButtonType`.
- One visible field: **`Notes` — a plain, visible, REQUIRED `<textarea name="Notes">` (NOT jHtmlArea**
  on this form; no `.jHtmlArea` wrapper, textarea `display:inline-block`, rows 2). No category / type /
  visibility select — visibility is fixed "Public".
- ⇒ a live `addNote` sets `textarea[name="Notes"].value` directly; jHtmlArea sync is unnecessary here.

Recorded into code as inert placeholders: `WRITE_FORMS`, `SELECTORS.modalRoot`/`dialogClose`, and the
read-only `validateLoadedActionForm()` pre-submit guard. No submit logic was wired.

## 3. Inferred (plausible, not proven)

- The Accept form's optional `Notes` field is a public note (its visibility is not labelled) — so the
  acceptance note still goes through the confirmed "Add Notes - Public" path, not the Accept field.
- The plain-POST forms redirect back to the detail view on success (standard MVC) — not observed.
- After acceptance the Accept link disappears and an "Accepted" event is written (seen on a different
  already-accepted record; the transition itself not observed on the test record).

## 4. Still unknown

- Whether ETA becomes mandatory (`EtaIsMandatory=true`) for some records and how that gates Save.
- The note-history **per-row** selector (only container-contains is confirmed).
- The auto-created / Umbrava eligibility **column** (none found — allow-list stays default).
- Finer in-tenant Change-Client scope marker.

## 5. Confirmed via one controlled test submission — Add Notes (2689724, 2026-09-16)

An authorized single Save of the acceptance note (signed "Rachel") was performed on the test record:
- **POST `/WorkOrderAction/AddNotes/2689724` → 200.** The submit is an **AJAX POST**
  (`X-Requested-With=XMLHttpRequest`), preceded by the render GET (also 200).
- On success the **modal auto-closes** and a **"Website - Notes Added"** event appears at the top of
  the detail event trail. The job stayed un-accepted (note only). → post-save success signal.
- **verifyNote read-back caveat (NEW):** the **full-page** `/WorkOrderReadOnly/ViewNoteHistory/{id}`
  rendered an **empty shell (~172 chars)** for this record — so `noteHistoryContainerText()` reading
  the full page is unreliable. The reliable read-back surface is the **modal fragment**
  (`showNotesHistoryDialog` into `#modalDialog`) or the event's `EventNotes`. `verifyNote` should
  prefer the modal fragment; confirming the exact-text match on that surface is still open (a further
  read was blocked by the environment's transaction classifier this session).

## 5b. Confirmed via one controlled test submission — Accept Job (2689724, 2026-09-16)

An authorized single Accept Save was performed (by the operator, in-browser; the classifier blocks
the agent from clicking Save on a live transaction). Observed read-only afterward:
- **Accept Job link drops from `#workOrderActionsList` (count 1 → 0)** → this is the confirmed,
  now-transition-observed `verifyAccepted` signal.
- A **"Website - Accepted - No ETA Provided"** event appears at the top of the trail — accepting with
  **no ETA is valid** (ETA was not mandatory on this record; no ETA was entered).
- **Add Notes remains available** after acceptance (count still 1), so accept-then-note ordering is
  fine; here the note was added first, then Accept.

Remaining nuance (not blocking): behavior when `EtaIsMandatory=true` on some other record, and the
exact post-accept navigation timing for the armed-batch resume, are still unobserved — validate if a
mandatory-ETA record is ever batched.

## 6. Unsafe to automate until validated

- Any **Save/POST** to `/WorkOrderAction/*` — one controlled test submission only, by decision, never
  in a batch, until the above is observed.
- Column-based eligibility (no confirmed indicator) — keep the operator allow-list.

## 6. Adapter implementation status (wired from Confirmed mechanics; fail-closed)

`PrimmsWriteAdapter.acceptJob/verifyAccepted/addNote/verifyNote` are now **wired** from the Confirmed
facts above (v0.2.4) — but remain **unreachable** while `LIVE_WRITE_ENABLED=false`:

- **acceptJob** — opens the unique "Accept Job" modal (confirmed AJAX GET), requires the validated
  AcceptJob POST form, takes the **No-ETA path only when the Eta field is not client-required**
  (`required`/`data-val-required` absent — else `skipped:eta-mandatory-not-supported`, never fabricates
  an ETA), submits the form's own **"Save"**, then waits for the confirmed **Accept-link-drops** DOM.
- **verifyAccepted** — requires Accept link absent (hard) + reports the "Accepted" event (corroborating).
- **addNote** — opens the unique "Add Notes - Public" modal, syncs the frozen note into the confirmed
  `textarea[name="Notes"]` (jHtmlArea-aware; plain textarea here), verifies exact value, submits "Save",
  waits for the confirmed **modal-close** DOM.
- **verifyNote** — normalized container-contains on the note-history; when no unique modal-fragment
  read-back surface is present it records **`note-submitted-awaiting-readback-verification`** rather than
  over-claiming (the full-page ViewNoteHistory rendered empty on the test record).

Fail-closed guarantees: `activeAdapter()` returns `DryRunAdapter` while the flag is false; the armed
resume early-returns while false; and every write step head-guards via `writeContextOk` /
`live-writes-disabled`. No retries; accept-then-note ordering; accepted-but-note-failed is a distinct
partial result. Batch cap is 1 (`MAX_BATCH_SIZE=MAX_TEST_BATCH_SIZE=1`).

**Still requires a successful test submission to fully validate:** the `EtaIsMandatory=true` accept
path (unobserved — held fail-closed).

## 6b. Note History modal — CONFIRMED (test record 2689724, read-only, 2026-09-16)

Opened via `#workOrderNoteHistoryLink` (read-only WorkOrderReadOnly route). Structure (mapped by
selector counts + Boolean match only — no note body read/stored):
- Dialog: one `.ui-dialog` titled **"History"** → `.ui-dialog-content` → `#noteHistoryWrapper`.
- Notes render inside a **same-origin `<iframe id="notehistoryframe">`** (nested, two-stage AJAX load;
  `readyState:complete`). The userscript is `@noframes` but reads the iframe's `contentDocument` from
  the top frame.
- Per note (4 records observed): **`.message`** (note body) · **`.sender`** (author) · **`.date`** /
  `.datewrapper` (timestamp). No per-note stable id/class wrapper.
- **Order: oldest→newest** (the just-added note was the **last** `.message`, not the first) — so a full
  `.message` scan is used (order-independent), not a "first row" assumption.
- Body is **rich HTML** → normalized (`normalizeNoteText`) container-contains, never a byte match.
- **Read-back PROVEN live (Boolean):** the expected acceptance note matched a `.message` node.

### verifyNote — now implemented (read-only)
`PrimmsWriteAdapter.verifyNote` opens the History dialog, waits for exactly one `#notehistoryframe`
with a loaded doc + ≥1 `.message`, scans normalized, and returns:
`note-readback-verified` (ok) · `note-readback-not-found` (ok:false) ·
`note-history-modal-unrecognized` · `note-history-ambiguous` · `note-history-timeout` (these three
conservative/ok, never a false fail) · and the fallback `note-submitted-awaiting-readback-verification`
when the History control is absent. Never reports success from HTTP status, modal-close, or an event.

### Add Notes field contract (Part D) — CONFIRMED **case B**
`textarea[name="Notes"]` is a **normal visible textarea with no jHtmlArea binding** (no `.jHtmlArea`
wrapper; `display:inline-block`). It **is** the submission field. Sync = set `.value` directly
(`prepareJHtmlAreaValue` no-ops the jHtmlArea path when absent); pre-submit equality = `ta.value ===
item.note`. `addNote` unchanged.

## What one controlled test submission unblocks

A single deliberate Save on the test record (Add Notes first — lowest impact — then, if desired,
Accept) to observe the post-submit DOM and the note landing in history. Then fill `acceptJob`/`addNote`
to submit the platform's own modal form once via its unique "Save", keep the read-only guards, re-run
the tests, and only then flip `LIVE_WRITE_ENABLED`.
