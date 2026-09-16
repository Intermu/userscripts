# Discovery checklist — Umbrava Primark Reactive Intake

Read-only discovery against the live `app.umbrava.com` tenant (authenticated session), **2026-09-16**,
plus the read-only Umbrava work-order API for structural cross-checks. Pages were **only read** —
no form was submitted, no field edited, no status/note/dispatch created. **No Umbrava or PRIMMS record
was changed.** No customer values, cookies, tokens, or request/response bodies were recorded here.

Legend: **[C-live]** confirmed from read-only live observation · **[C-mock]** confirmed from local
fixture/mock (self-test) · **[Inf]** inferred · **[?]** unknown · **[N/G]** non-goal / unsupported.

---

## 1. Routes

- **[C-live]** Detail route form: `/work-orders/{number}/details` (the `{number}` is the WO number,
  e.g. the `W-#####` digits, **not** the internal id — the internal id 404s/errors).
- **[C-live]** List/job-board route: `/work-orders` (optionally with a query string).
- **[C-live]** Sub-tabs of a WO are distinct routes: `/notes`, `/documents`, `/trips`,
  `/billing/...`, `/proposals/...`, `/tasks`, `/work-order-location/...`, `/work-order-history`.
  These are **denied** (notes/documents are read-lists with write controls; kept off-limits, fail closed).
- **[C-live]** Unauthenticated access redirects to `login.umbrava.com` — denied.
- **Denied (allow-list omission + explicit deny):** login/logout/auth/callback, settings, admin,
  company, users/roles, create/new/edit, dispatch/assign, invoices/proposals/POs/quotes, uploads,
  and every unrecognized route. Unknown route ⇒ **no panel**.

## 2. Page recognition

- **[C-live]** Umbrava marker: top nav links `a[href="/work-orders"]` (+ Projects/Clients/Vendors)
  and a brand/company-profile anchor.
- **[C-live]** Detail marker (fail-closed): a `<form>` containing labelled WO fields — required
  markers `Source PO #` and/or `WO Scope`. Header shows `Tracking # {n}`, phase chip, `W-#####`.
- **[C-live]** List marker (fail-closed): a `<table>` containing `a[href^="/work-orders/"]` row links;
  header cells are `Sort` buttons wrapping the column label.
- If markers are absent, the panel renders a **compatibility warning** and reads nothing.

## 3. Primark classification

- **[C-live]** Client: shown as a heading/link to `/clients/{guid}/details` in the WO header. Live
  value observed: **`Primark`**. (`Primark USA` retained as the email-side label variant.)
  `PRIMARK_CLIENT_VALUES = ['Primark','Primark USA']`.
- **[C-live]** Work type: detail field label **`WO Type`**; value **`Reactive`**. `REACTIVE_TYPE_VALUES = ['Reactive']`.
- **[C-live]** Email origin: the inline **Notes** panel carries a system note authored by **`Umbrava`**,
  channel/type **`Email`**, body **"This work order was created using AI. Please review for accuracy."**
  Any of {Umbrava+Email} or {"created using AI"} ⇒ email origin **confirmed**. Absent ⇒ *not confirmed*;
  no notes region ⇒ *source field unavailable*.
- **[C-live]** Classification never keys on the bare word "Primark" in free text — only the CLIENT field
  value and the WO Type field.

## 4. PRIMMS/Ostara identifier

- **[C-live]** The PRIMMS/Ostara work-order number is the Umbrava **`Source PO #`** field (an `<input>`;
  read via `.value`). Cross-checked against the read-only API field `sourcePurchaseOrderNumber` on two
  independent Primark Reactive records — both matched their email's Ostara number.
- **[C-live]** The **`Source Job #`** field is a *different* reference ("Source WO # or Source Project #",
  per its own helper text) and was **empty** on these records — it is intentionally **not** read as the
  PRIMMS reference.
- **[C-live]** Value pattern: a plain 5–12 digit number (live sample: 7 digits). `PRIMMS_ID_PATTERN = /^\d{5,12}$/`.
- **[C-live]** `Source PO #` is a **generic client-reference field**, not Primark-exclusive: a live Pilot
  (non-Primark) record carried a 12-digit `Source PO #`. Therefore the PRIMMS reference/copy is gated on
  Primark classification — a numeric `Source PO #` on a non-Primark record is never treated as a PRIMMS id.
- **[C-live]** Visible on the **detail** page (always, as a field). On the **list** page it is **not** a
  default column — present only if the coordinator adds a `Source PO #` column to their saved view.
- **[C-mock]** One-vs-none-vs-multiple resolution: single valid id ⇒ `one`; zero ⇒ `none`; ≥2 distinct ⇒
  `multiple` (review required). Prefixed forms (`Reactive {id}`, `Work Order Number: Reactive {id}`) parse
  to the id.

## 5. Dispatch-brief fields

- **[C-live]** Store/building: WO header store name links to `/work-order-location/...`; also the
  `Location` field. (List: `Location #`, `City`, `State`.)
- **[C-live]** Trade/area: detail label **`Trade(s)`** (chip value). (List: `Trades`.)
- **[C-live]** Work/symptom: detail label **`WO Scope`** (textarea). The email brief is embedded here,
  sometimes as `... Symptom: ... Reason Code: ... Location: ... Notes: ...` segments. (List: `Scope Of Work`.)
- **[Inf]** Reason code: **no dedicated Umbrava field** — parsed from the `Reason Code:` segment inside
  `WO Scope` when present; otherwise omitted.
- **[Inf]** Work-order area/location within the store: parsed from the `Location:` segment of `WO Scope`
  when present; otherwise the `Location` field.
- **[C-live]** Attendance deadline: detail label **`First Trip By`** (date). (List: `First Trip Date`.)
  API cross-check: `priority.firstTripDate` = the email's attendance-before date.
- **[C-live]** Work type: `WO Type` (see §3).
- **[C-live]** Internal status: detail label **`WO Status`**; header phase chip (`Open`, etc.).
  (List: `Status`.)
- **[Inf]** Attachment/photo indicator: the **Documents** tab presence (with a count if shown). No default
  list column for it.
- **[?]** Availability field: not surfaced as a distinct Umbrava field in the observed layout — omitted.

## 6. Deadline formats

- **[C-live]** List cells render `MM/DD/YYYY, h:mm AM`. Detail date controls render `Mon DD, YYYY`.
- **[C-mock]** Parser accepts `MM/DD/YYYY[, time]`, `Mon DD, YYYY`, `YYYY-MM-DD`; anything else ⇒
  `Deadline unavailable`. Uses the browser's local timezone. No SLA is inferred from work type.

## 7. List parsing

- **[C-live]** Columns are user-configurable (saved views). Default layout observed: `WO #`, `Tracking #`,
  `Status`, `Priority`, `City`, `State`, `Location #`, `Trades`, `Scope Of Work`, `Time in Status (hrs.)`,
  `Last Note Date`, `Client DNE`, `First Trip Date`, `# Days`, `Expected Completion Date`, `Latest Update`,
  `WO Date`. **No `Client` and no `Source PO #` by default.**
- **[C-mock]** Header map is built from visible labels; extraction never uses fixed indexes; missing
  required headers ⇒ related counts/actions disabled, not guessed. Column reorder is tolerated.

## 8. Non-goals (unsupported by design)

- **[N/G]** PRIMMS acceptance / note creation / navigation / control.
- **[N/G]** Outlook / mailbox / `.msg` reading.
- **[N/G]** GraphQL/API calls, `fetch`/XHR/`GM_xmlhttpRequest`/WebSocket/`sendBeacon`/remote import.
- **[N/G]** Any Umbrava write: status/priority/schedule/assignment change, note, dispatch, quote,
  invoice, PO, document, task.
- **[N/G]** Document/photo download or content extraction; background refresh/polling/batching.

## 9. Not modified

No Umbrava field, status, note, or record was changed. No PRIMMS record was touched. Discovery was
navigate + read only; the read-only API cross-check is a read.
