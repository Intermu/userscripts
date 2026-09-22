# Primark PRIMMS – Bulk Acceptance Assistant

A Tampermonkey userscript that helps authorized Broadway National coordinators review a filtered
list of eligible, Umbrava-originated auto-created work orders in Primark's **PRIMMS / Ostara**
tenant and (in a later, owner-enabled phase) accept selected work orders and add the required
acceptance note to each.

- **Host (only):** `https://primark-ostara.ostarasystems.net/`
- **This build ships:** Phase 0 (discovery) + Phase 1 (read-only selection + dry run, fully
  functional). Phase 2 (live write) is scaffolded and **disabled**.
- **Live writes are OFF** (`CONFIG.LIVE_WRITE_ENABLED = false`). No write code path is reachable
  from any control while it is false.

> **Use only with authorization from Primark/Ostara and Broadway National. You are
> responsible for reviewing each batch before submission.**

---

## This script never touches Umbrava

PRIMMS/Ostara is a **different host and a different vendor relationship** from Umbrava. This script
never reads, reuses, harvests, or references any Umbrava bearer token, cookie, DOM, or network
surface. It runs only on the approved PRIMMS host and issues **zero** network requests in Phase 1.

## Purpose and limitations

- Reads the **already-rendered** jobs-list DOM and lets the operator select **visible** eligible
  rows. It does not scrape across pages, change filters, saved views, or column layout.
- The eligibility "column" path is **unverified** against the live grid; the recommended mode is the
  **operator allow-list** (paste job references sourced from Umbrava separately). If the column
  header cannot be resolved, selection is **disabled** with "Unable to determine eligibility" — it
  never defaults to eligible.
- **Accept Job / Add Notes are the only actions ever contemplated**, and only through the platform's
  normal visible workflow — after the exact mechanism is validated in an authorized environment.
  Everything else in the actions panel (Cancel, Stop, Allocate, Set Cost, Request ETA, email, change
  scope, settings) is off-limits and route-denied.

## The navigation / armed-token design decision (owner sign-off required)

PRIMMS is server-rendered. Accepting a work order requires navigating to its detail page, which
**destroys all in-memory script state**. A live batch therefore cannot be a simple in-page loop.

The design:

- Batch state (queue, frozen note text, frozen operator name, delay, index, per-item outcomes)
  persists in `sessionStorage` under `bwn.primms.acceptance.*`, containing **no work-order content
  beyond identifiers**.
- The second confirmation mints a **short-lived armed-batch token**: single tenant, single operator,
  expiry ≤ 15 minutes, invalidated by Stop, by batch completion, by tenant/scope change, and by
  navigation to any non-approved route.
- On page load, if the token is valid and the page is the expected next item, a persistent
  "Batch in progress — N of M" banner shows and processing continues. If the token is absent,
  expired, or mismatched, the script does nothing except show "No active batch. Nothing was
  submitted."

This bounded, operator-armed resume is **the only** permitted continuation across navigation. It is
**not background work**: it cannot start itself, cannot outlive the token, cannot resume after a
browser restart, and uses **no** hidden iframes, background tabs, or window handles.

**Owner decision:** accept or reject this resume model before Phase 2 is enabled. Until then the
live processing loop is a documented `TODO(discovery)` scaffold and does nothing.

## Read-only discovery completed (2026-09-16)

Two authorized read-only sessions compared a pending-acceptance and an already-accepted work order.
**No PRIMMS work order was changed; the action modals were never opened on a live job.** Full
labelled findings (live-confirmed / fixture / inferred / test-record / unsafe) are in
`discovery-checklist.md`. `LIVE_WRITE_ENABLED` **remains `false`** and the two write steps fail closed.

| Area | Known (live-confirmed, in code) | A test record must still prove |
|---|---|---|
| Identity | numeric path id; WO Nº == id; `#panelTitle` holds id | — |
| Accepted-state | Accept-link present=not accepted, absent=skip; "Accepted" event corroborates | — |
| Add Notes availability | remains available **after** acceptance | — |
| Write mechanism | **Confirmed on test record 2689724:** both are plain **POST** forms opened in `#modalDialog`. Accept `/WorkOrderAction/AcceptJob/{id}` (fields Eta/ResourceReference/Notes + hidden WorkOrderId/ActionButtonType/HasInitialEta/TimezoneId/EtaIsMandatory); Add Notes `/WorkOrderAction/AddNotes/{id}` (required `textarea[name=Notes]`). Anti-forgery `__RequestVerificationToken`; submit `input[type=submit]` "Save" | the **POST response / post-submit DOM** (one controlled Save) |
| Note editor | **Plain required `<textarea name="Notes">`** in the Add Notes modal (not jHtmlArea) → set value directly | — |
| Note read-back | `/WorkOrderReadOnly/ViewNoteHistory/{id}`, rich-HTML body; normalized container-contains verify | that a submitted note lands there (needs one test Save) |
| Tenant | host subdomain = fail-closed guard | finer Change-Client marker (optional) |
| Eligibility | allow-list (default) | whether an auto-created/Umbrava column exists |

Implemented and inert until the flag flips: identity, tenant guard, accepted-state, `verifyAccepted`,
`verifyNote` (normalized read-back), the `WorkOrderAdapter` state machine, armed-batch resume, and the
`prepareJHtmlAreaValue` local sync helper. `acceptJob`/`addNote` stay fail-closed pending the test record.

## Installation

1. Install Tampermonkey (Chrome/Edge).
2. Open `primms-bulk-acceptance-assistant.user.js` and install it (Tampermonkey → Utilities →
   Import, or open the raw file).
3. Confirm the metadata: `@match https://primark-ostara.ostarasystems.net/*`, `@grant none`,
   `@noframes`, `@run-at document-idle`. No `@require`, no `@updateURL`/`@downloadURL`.
4. Log in to PRIMMS as usual. The panel appears (floating, draggable, collapsible) only on the jobs
   list and work-order detail routes.

The **discovery reporter** (`discovery-report.user.js`) is a separate, read-only Phase 0 tool.
Install it the same way when mapping the detail page, then remove it — it is not part of the shipped
tool.

## Configuration

All tunables live in the `CONFIG` block at the top of the userscript:

| Key | Default | Meaning |
|---|---|---|
| `LIVE_WRITE_ENABLED` | `false` | Master switch for live writes. Owner-flipped only after validation. |
| `DEFAULT_DELAY_MS` | `2500` | Inter-item delay. |
| `MIN_DELAY_MS` | `1000` | Hard floor, enforced in code. |
| `MAX_BATCH_SIZE` | `25` | Max rows per batch. |
| `ARMED_TOKEN_TTL_MS` | `900000` | Armed-token lifetime (15 min). |
| `ELIGIBILITY_MODE` | `'allowlist'` | `'allowlist'` (recommended) or `'column'`. |
| `ELIGIBILITY_HEADER_CANDIDATES` | see file | Candidate header names for the column path. |
| `ELIGIBILITY_MATCH_VALUES` | see file | Matching values for the column path. |
| `GREETINGS` | 3 values | Fixed greeting list. |
| `NOTE_TEMPLATE` | see file | The exact note template. |
| `AUDIT_MAX_ROWS` | `500` | Audit cap; FIFO purge. |
| `DEBUG` | `false` | Structural console diagnostics only (never record content). |

## Dry-run workflow (this build)

1. Open a jobs-list filter in PRIMMS. The panel shows compatibility status and a **DRY RUN** badge.
2. Enter the **name signing the acceptance note** (required).
3. Pick a **greeting** (defaults to your local clock; a warning shows if you change it away from the
   local-time match).
4. Review the **note preview** — it is character-for-character exactly what would be submitted.
5. Choose eligibility: paste Umbrava job references into the **allow-list** (recommended), or switch
   `ELIGIBILITY_MODE` to `'column'` once that path is validated.
6. Select eligible visible rows (or "Select all eligible visible"). Watch the visible / eligible /
   selected / skipped counts.
7. Click **Dry-run preview**. It lists refs, ids, detail URLs, the exact note, and the intended
   action order (Accept Job → Add Notes). It makes **zero** requests, clicks, or navigations, and
   writes only `dry-run` rows to the audit log.

## Controlled live workflow (Phase 2 — disabled here)

Available only after: the Accept Job and Add Notes flows are manually validated in an authorized
environment; selectors/routes/token fields are confirmed; success verification is implemented; and
the owner sets `LIVE_WRITE_ENABLED = true`. When enabled, the flow is:

review selection → **Dry-run preview** (required) → **Live execution** → second confirmation dialog
(job count, exact identifiers, note preview, delay) → arms the token → navigate to each detail page
in turn → validate id + ref → confirm not already accepted → Accept Job once → verify → Add Notes →
verify saved note → wait the delay → next. **Stop** halts after the in-flight item and clears the
token. Failures are recorded, never retried; the batch continues only if "Continue after individual
failures" was pre-enabled.

## Data handling and audit-log limits

- Browser storage is namespaced `bwn.primms.acceptance.*` only.
- The audit log stores **only**: timestamp, work-order identifier(s), action, outcome
  (`dry-run` / `succeeded` / `failed` / `skipped` / `stopped`), and a non-sensitive reason/code.
- It **never** stores customer details, job descriptions, addresses, contacts, note bodies,
  credentials, HTML snapshots, request payloads, or response bodies.
- Cap 500 rows, FIFO purge. **Clear audit log** button provided. **Export audit CSV** contains only
  the fields above.

## How to disable / uninstall

- Temporary: toggle the script off in Tampermonkey.
- Permanent: delete it from the Tampermonkey dashboard.
- Clear residual state: use **Clear audit log**, or clear site data for the PRIMMS origin (removes
  the `bwn.primms.acceptance.*` keys).

## Troubleshooting

| Symptom | Meaning |
|---|---|
| Panel doesn't appear | You're on a denied/unrecognized route (home, settings, an action page). By design. |
| "Grid not recognized" | The `table.datagrid` markup wasn't found — likely a PRIMMS version change. Selection disabled rather than guessing. |
| "Could not identify the Work Order column" | Header text didn't resolve. Selection disabled. |
| "Unable to determine eligibility" | Column path found no candidate header. Use the allow-list mode. |
| Live button disabled | Expected in this build. Also requires name + selection + a dry-run of the exact selection. |

## CHANGELOG

- **0.2.5** — Mapped the Note History modal (read-only): notes render in a same-origin
  `#notehistoryframe` iframe as `.message`/`.sender`/`.date` blocks, oldest→newest. Implemented
  `verifyNote` to open the History dialog and read the note back from the iframe `.message` nodes
  (`note-readback-verified`/`-not-found`/`-modal-unrecognized`/`-ambiguous`/`-timeout`, plus the
  conservative awaiting fallback); added `noteHistoryFrameDoc`/`matchNoteInMessages`; read-back proven
  live (Boolean) on 2689724. Confirmed the Add Notes field is a plain visible textarea (jHtmlArea case
  B). No PRIMMS mutation; `LIVE_WRITE_ENABLED=false`, caps still 1.
- **0.2.4** — Wired `PrimmsWriteAdapter.acceptJob/verifyAccepted/addNote/verifyNote` from the
  test-record-confirmed modal mechanics (unique action link → AJAX GET modal → validated POST form →
  platform "Save"; No-ETA only when ETA not client-required; note synced into the confirmed backing
  textarea; verifyAccepted uses both link-absent + Accepted-event signals; verifyNote records
  `note-submitted-awaiting-readback-verification` when no unique read-back surface). Added
  `openActionModalForm`/`writeContextOk`/`waitFor`/`hasAcceptedEvent`/`batchCap` and a DOM-injected
  mock-test suite (run `?bwnPbaSelfTest=1` on the jobs list). Lowered `MAX_BATCH_SIZE` to 1 and added
  `MAX_TEST_BATCH_SIZE=1`. **`LIVE_WRITE_ENABLED` stays `false`** — the write path is triple-gated and
  unreachable in this build; no PRIMMS record was changed by this task.
- **0.2.3** — Adaptive signer name: `deriveOperatorName()` / `parseWelcomeName()` read the PRIMMS
  header greeting to prefill the (editable, operator-confirmed) name field, so it adapts to whoever is
  signed in; fixed the prefill button (it referenced a removed selector). One controlled test Save of
  the acceptance note was performed on 2689724 (AJAX POST 200 → "Notes Added" event); recorded the
  finding that full-page `ViewNoteHistory` can render empty (verifyNote should read the modal
  fragment). A controlled Accept Save was then performed by the operator on 2689724 (agent is blocked
  from clicking Save on a live transaction): Accept link dropped 1→0 and a "Website - Accepted - No
  ETA Provided" event landed — the write path is now validated end-to-end on the test record.
  `LIVE_WRITE_ENABLED` unchanged (`false`); `acceptJob`/`addNote` still fail closed pending the code
  wiring + owner decision.
- **0.2.2** — Test-record modal inspection (Umbrava 1324040 / PRIMMS 2689724), read-only, no submit.
  Confirmed both action modals are plain **POST** forms (`AcceptJob`: Eta/ResourceReference/Notes +
  hidden fields; `AddNotes`: required plain `textarea[name=Notes]`, not jHtmlArea; anti-forgery
  `__RequestVerificationToken`; submit "Save"). Recorded as inert `WRITE_FORMS` config + modal
  selectors + a read-only `validateLoadedActionForm()` guard. Writes still fail closed; only the
  post-submit DOM remains, pending one controlled Save. `LIVE_WRITE_ENABLED` unchanged (`false`).
- **0.2.1** — Second read-only discovery pass (pending vs accepted comparison; action-link AJAX/modal
  mechanism; note-history structure). Added `normalizeNoteText`/`noteTextMatches`/
  `noteHistoryContainerText` and wired `verifyNote` to a normalized container-contains read-back; added
  `prepareJHtmlAreaValue` local jHtmlArea sync helper; recorded confirmed action labels/class. Writes
  still fail closed; `LIVE_WRITE_ENABLED` unchanged (`false`).
- **0.2.0** — Interactive discovery applied. Confirmed id/selector/tenant/accepted-state/note-editor
  facts baked in. `WorkOrderAdapter` interface (`validateItem`/`acceptJob`/`verifyAccepted`/
  `addNote`/`verifyNote`), sequential `processItem` state machine, armed-batch resume, 12-point live
  pre-flight, CSV formula-injection guard, selector-uniqueness guards, and a build-id/live-disabled
  banner added. Write steps `acceptJob`/`addNote` fail closed; `LIVE_WRITE_ENABLED` remains `false`
  pending test-record validation of the action-page submit mechanics.
- **0.1.0** — Phase 0 discovery reporter + Phase 1 read-only selection/dry-run complete; Phase 2
  write adapter scaffolded and disabled (`LIVE_WRITE_ENABLED = false`).
