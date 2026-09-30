# Umbrava – Primark Reactive Intake & Dispatch Companion

A Tampermonkey userscript that helps authorized Broadway National coordinators triage
**Primark Reactive** work orders inside **Umbrava** — the internal operational records that
Umbrava auto-creates from Primark/Ostara assignment emails. It surfaces the PRIMMS/Ostara
work-order number, a plain-text dispatch brief, and a deadline/priority badge, and lets the
coordinator copy the number for hand-off into the separate **PRIMMS Bulk Acceptance Assistant**.

- **Host (only):** `https://app.umbrava.com/`
- **This build ships:** Version 1 (read-only detail + list panels, fully functional).
- **Writes:** none. This script has **no** write path to Umbrava and **no** contact with PRIMMS.

> Read-only companion. It changes nothing in Umbrava and never touches PRIMMS, Outlook, or `.msg`
> files. Review every work order before dispatch or PRIMMS acceptance.

---

## Purpose

On a Primark Reactive work order (or the Work Orders list), the coordinator needs to answer, fast:

1. Is this a Primark Reactive assignment created from an email?
2. What is the PRIMMS/Ostara work-order number, and is it confidently identifiable, missing, or ambiguous?
3. What is the at-a-glance dispatch brief (store, trade, work, location, deadline, reason, attachments, status)?
4. Is the attendance deadline near or overdue?
5. Can I copy the number into the PRIMMS acceptance tool?
6. On a visible list, which rows appear to need PRIMMS acceptance preparation?

The script improves visibility and hand-off. It does not alter Umbrava data.

## Architecture and system boundaries

Primark USA uses **Ostara/PRIMMS** as its CAFM system. When Primark assigns a Reactive work order
to Broadway National, Ostara emails the assignment. **Umbrava auto-creates** a corresponding
internal work order from that email. There is **no** technical integration between Umbrava and PRIMMS.

- The **assignment email** is the source of the original assignment (this script never reads it).
- The **Umbrava record** is Broadway National's internal operational record (this script reads it, read-only).
- **PRIMMS** is where Broadway accepts the work order and adds the acceptance note (a *separate* tool).
- The numeric **PRIMMS/Ostara work-order number is the human correlation key** between the two systems.

Enforced boundaries — this script:

- runs **only** on `app.umbrava.com` and reads the already-rendered DOM;
- issues **zero** network requests (no `fetch`, `XMLHttpRequest`, `GM_xmlhttpRequest`, `WebSocket`,
  `sendBeacon`, `@require`, remote import, external asset, telemetry, or analytics);
- **never writes** to Umbrava (no submit, status/priority/schedule change, note, dispatch, quote,
  invoice, PO, document, or task);
- **never** calls, inspects, navigates to, or controls PRIMMS/Ostara;
- does **not** read Outlook, mailbox data, or `.msg` files, and creates **no** cross-system API or sync;
- copies to the clipboard and downloads a file **only** on an explicit button click;
- persists **no** work-order content (only a local panel collapse preference).

## Operating flow (email → Umbrava → PRIMMS)

1. Primark/Ostara assignment email arrives.
2. Umbrava auto-creates a work order from the email content.
3. Coordinator opens the Umbrava job; **this panel** shows classification, the PRIMMS number, the
   dispatch brief, and the deadline/priority badge.
4. Coordinator clicks **Copy PRIMMS WO number** (or **Copy PRIMMS allow-list entry**).
5. Coordinator switches to the **PRIMMS Bulk Acceptance Assistant** and accepts the work order there,
   adding the acceptance note.
6. Coordinator manages the operational workflow in Umbrava.

## Installation

1. Install **Tampermonkey** in your browser.
2. Create a new script and paste the contents of
   `umbrava-primark-reactive-intake-companion.user.js`, or open the `.user.js` file to let
   Tampermonkey prompt an install.
3. Confirm the metadata `@match https://app.umbrava.com/*` and save.
4. Open a Primark Reactive work order in Umbrava — the **Primark Reactive Intake** panel appears
   bottom-right.

## Discovery status

Field labels, routes, and markers were confirmed by **read-only** observation of the live
`app.umbrava.com` tenant on **2026-09-16**. No Umbrava or PRIMMS record was modified. See
[`discovery-checklist.md`](discovery-checklist.md) for the confirmed / inferred / unknown breakdown.
Key confirmations:

- Detail route `/work-orders/{number}/details`; list route `/work-orders`.
- PRIMMS/Ostara number lives in the **`Source PO #`** field (the `Source Job #` field is a different
  Source WO/Project reference and is not read).
- Email origin is confirmed by a system note authored by **Umbrava**, channel **Email**
  ("created using AI" system note).
- Attendance deadline maps to the **`First Trip By`** field (list column `First Trip Date`).

## Configuration

All tunables live in the `CONFIG` block at the top of the script:

- `UMBRAVA_HOST`, `ROUTE_ALLOWLIST`, `ROUTE_DENYLIST` — where the panel is allowed to run.
- `PRIMARK_CLIENT_VALUES` (`Primark`, `Primark USA`), `REACTIVE_TYPE_VALUES` (`Reactive`).
- `*_FIELD_LABELS` / `*_LIST_COLUMNS` — the visible labels the reader matches (never fixed indexes).
- `PRIMMS_ID_PATTERN` — a valid id is 5–12 digits.
- `DUE_TODAY_HOURS` (24), `DUE_SOON_HOURS` (48), `DUE_THIS_WEEK_HOURS` (168) — deadline thresholds.
- `DEBUG` — structural diagnostics only (selector/row counts), never work-order content.

If Umbrava changes a label or route, update the matching `CONFIG` entry — no logic changes needed.

## Detail-page workflow

On a recognized work-order detail page the panel shows: compatibility status; Primark
classification; email-origin classification; the PRIMMS reference line; a dispatch brief
(store, trade, work summary, location, attendance deadline, reason code, attachments, internal
status); a **deadline badge** (Overdue / Due today / Due within 2 days / Due within 7 days /
Future / Deadline unavailable); and a **local priority** (Critical / Urgent / Attention / Standard)
derived **only** from deadline proximity.

Buttons (explicit click only): **Copy PRIMMS WO number**, **Copy PRIMMS allow-list entry**,
**Copy dispatch brief**. A status line confirms each copy.

## List-page workflow

On the Work Orders list the panel parses **visible rows only**, builds a header map from the visible
column labels, and reports: visible row count; confirmed Primark Reactive rows (only if a `Client`
column is present); rows with one valid PRIMMS ID / missing an ID / ambiguous (only if a
`Source PO #` column is present); and near/overdue deadlines (only if `First Trip Date` is present).
If a needed column is not in the current layout, the panel says so and disables the related action —
it never guesses.

Buttons (explicit click only): **Copy visible PRIMMS allow-list**, **Copy visible dispatch queue**,
**Download visible reference-only CSV**. All are labelled *visible rows only — not a complete
Umbrava search/export*.

## Copy / paste hand-off into the PRIMMS Bulk Acceptance Assistant

- **Copy PRIMMS allow-list entry** (detail) or **Copy visible PRIMMS allow-list** (list) produces one
  numeric id per line, deduplicated, in visible order — the exact format the PRIMMS Bulk Acceptance
  Assistant accepts as its operator allow-list. Paste it there, then accept the selected work orders
  in PRIMMS.
- The two tools **do not** talk to each other. The numeric work-order number is the only thing that
  crosses between them, and only because you copied and pasted it.

## Deadline indicator limits

- Uses the **browser's local timezone** and only the confirmed date formats (`MM/DD/YYYY[, h:mm AM]`,
  `Mon DD, YYYY`, `YYYY-MM-DD`). Unparseable → `Deadline unavailable`.
- The badge reflects **attendance-deadline proximity only**. It is **not** an SLA calculation; the
  script does **not** infer a 7-day/30-day SLA from work type, and it never sets or changes a due date.

## Data handling

- No work-order content is stored or transmitted. `localStorage` holds only `bwn.upric.collapsed`
  (panel collapse preference).
- All platform-derived text is rendered with `textContent`; the script never uses `innerHTML` for
  Umbrava-derived text.
- Clipboard and CSV download happen only from an explicit user click. The CSV carries only the three
  approved columns and is protected against spreadsheet formula injection.

## Troubleshooting

- **No panel** — you are on a route the script does not run on (login, settings, create/edit,
  dispatch, financial, notes/documents write tabs, or any unknown route). This is by design (fail closed).
- **"layout not recognized" warning** — Umbrava changed its DOM; no data was read. Update the
  `CONFIG` labels/routes.
- **PRIMMS reference "unavailable"** — the `Source PO #` field/column is not present in the current view.
- **Self-test** — see below. The production panel only ever renders on `app.umbrava.com`.
- **List batch actions greyed out** — the current view is missing a `Client` and/or `Source PO #`
  column; the panel names exactly which to add. It never scans row text as a fallback.

## Self-test and its host gate

The self-test (pure + mock-DOM) is gated so it can never spin up on an unrelated site by accident:

- **On `app.umbrava.com`:** append `?bwnUpricSelfTest=1`.
- **Off the Umbrava host** (e.g. a local test harness): it runs **only** when **both** flags are present —
  `?bwnUpricSelfTest=1&bwnUpricTestHarness=1`. With just `?bwnUpricSelfTest=1` off-host, nothing renders.
- The **production panel is host-bound** and never renders off `app.umbrava.com`.
- In off-host mode the script touches **only** its own isolated mock fixtures and result panel — it does
  not read, parse, observe, or interact with the host page.

## Route-change safety

The panel tracks SPA route changes (history `pushState`/`replaceState`/`popstate`) and DOM re-renders:

- Leaving a work order (to another WO, a denied route, or a non-detail route) **clears the panel
  immediately** — a prior work order's PRIMMS ID / deadline / brief is never shown on the next page.
- A detail panel renders **only once the DOM actually shows the record named in the URL** (guards against
  the transient where the previous record is still mounted). Until then it shows *Loading…*, not stale data.
- The panel has a single fixed id; repeated mutations never create duplicate panels, buttons, or handlers.

## Changelog

- **0.1.2** (2026-09-16) — Live smoke-test fix: PRIMMS hand-off (the reference line and the copy /
  allow-list / queue / CSV actions) is now gated on Primark classification. `Source PO #` is a generic
  client-reference field other clients also populate (a live Pilot record carried a 12-digit `Source PO #`),
  so a numeric `Source PO #` on a non-Primark record is never presented or copyable as a PRIMMS/Ostara id.
  List batch actions now require both the `Client` and `Source PO #` columns and include only
  confirmed-Primark rows. Self-test at 65 checks.
- **0.1.1** (2026-09-16) — Pre-commit hardening: off-host self-test now requires `&bwnUpricTestHarness=1`;
  route-transition state reset (immediate clear on nav, record-match readiness gate, no duplicate panels);
  explicit list fail-closed notice naming the required `Client` / `Source PO #` columns; WO-Scope-derived
  Reason/Location clearly labelled *inferred — verify* and never used for classification/ID/deadline/
  eligibility. Self-test expanded to 59 checks.
- **0.1.0** (2026-09-16) — Version 1. Read-only detail + list panels, classification, PRIMMS-reference
  resolution, dispatch brief, deadline/priority badges, click-only copy/CSV hand-off, self-test. Built
  after read-only live discovery of the Umbrava tenant.
