# Umbrava Coordinator Note Report - API Recon

Recon date: 2026-09-30. Read-only. Five live requests total (one session test, four operation
checks), each returning a single minimal page. No note content, client data, headers, cookies or
tokens are recorded here.

## Purpose

Document the Umbrava GraphQL operations the Note Report userscript needs: who the user is, which
work orders they touched in a date range, the notes on those work orders, and the work-order fields
used by the export and the flags.

## Authentication

| Finding | Detail |
|---|---|
| Cookie/session only | **Insufficient.** `POST /api/graphql` with `credentials: 'include'` and no `Authorization` header returned HTTP **500**, GraphQL error code `UNAUTHENTICATED`, message `No authentication method provided.` |
| Required | A Bearer access token from the active page session, sent as `Authorization: Bearer <token>` to the same-origin endpoint only. |
| Retry rule | `UNAUTHENTICATED` arrives as HTTP 500. The client must inspect the GraphQL error code before treating a 5xx as transient. `UNAUTHENTICATED` / `UNAUTHORIZED` / validation errors are never retried. |

## Operations

All operations: endpoint `https://app.umbrava.com/api/graphql`, method `POST`, body
`{ operationName, query, variables }`, `Content-Type: application/json`. Every call below
returned HTTP 200 with no GraphQL errors on its first attempt.

### 1. Member search - `searchMembers`

| Item | Value |
|---|---|
| Operation name (ours) | `NrMemberSearch` |
| Arguments | `search: String` (starts-with on first/last name, or team name), `searchType: BOTH \| USERS \| TEAMS`, `skip: Int`, `take: Int` |
| Pagination | `skip`/`take`; response `rowCount` |
| Sorting | None required |
| Response | `rowCount`, `items { id displayName firstName lastName memberType roleName isInactive isTechnician }` |
| User vs team | `memberType` (`"User"` observed). Typeahead uses `searchType: USERS`; `BOTH` is not needed. |
| GUID | `items.id` - the same value used as task `assignedTo`, WO `assignedTo`, and note `createdBy_UserProfileId` (verified: test user's id matched in all three). |
| Report use | Typeahead: `displayName` label, `id` value. Hide `isInactive` unless asked. |

### 2. Tasks by assignee - `tasks`

| Item | Value |
|---|---|
| Operation name (ours) | `NrTasksByAssignee` |
| Arguments | `assignedTo: [ID]`, `includeComplete: Boolean`, `skip: Int`, `take: Int` |
| Pagination | `skip`/`take`; response `total`. Max page size 100 per prior MCP facts - **not re-verified live** (only `take: 1` was sent). |
| Sorting | **Not required** - the call succeeded with no sort argument. |
| Response | `total`, `tasks { id entityType entityId description createdDate completionDate targetStartDate isComplete formattedJobNumber assignedTo }` |
| Notes | `entityType` is a number (`1` = WorkOrder). `entityId` is a **string** holding the WO number. `includeComplete: true` works. `assignedTo` filter confirmed (returned task's assignee = requested id). |
| Report use | Scope rules (created / completed in range, or open with target start <= range end); Tasks tab. |

Test user total at recon time: **249** tasks (baseline said 243; see Unresolved).

### 3. Work-order notes - `workOrderNotes`

| Item | Value |
|---|---|
| Operation name (ours) | `NrWorkOrderNotes` |
| Arguments | `workOrderNumber: Int!` (numeric part of `W-397856` = `397856`), `includeDeleted: Boolean` |
| Pagination | **None.** The full list returns in one response. |
| Sorting | None |
| Response | `id` (number), `type` (number), `content`, `createdDate`, `createdBy_UserProfileId`, `isPinned`, `isDeleted` |
| Filtering | No author or date arguments. **All filtering is client-side** (author id + ET date range). |
| Timestamps | ISO 8601 **with explicit offset** (`YYYY-MM-DDTHH:MM:SS.fffffff+HH:MM`), 7 fractional digits. Parse with `Date`, render in `America/New_York`. |
| Payload | W-397856: 36 notes, ~12.7 KB, ~50 ms. The largest note was ~870 chars. Payload size is not a concern at ~60 WOs. |
| Report use | Notes tab, summary counts, gap flags. `type` is a numeric enum (5 distinct values seen) - display the raw number unless a label map is confirmed. |

### 4. Coordinator work orders - `listWorkOrdersPaginated`

| Item | Value |
|---|---|
| Operation name (ours) | `NrCoordinatorWOs` |
| Arguments used | `page: PageInput!` (`{ skip, take }`), `sortBy: [SortInput!]!` (`[{ columnName, direction }]`), `assignedTo: [ID]` |
| Other arguments available (from suite query text, not exercised) | `WorkOrderNumbers: [Int]`, `phase`, `statuses`, `search`, `filter` |
| Pagination | `page { skip take }`; response `rowCount take firstRowOnPage lastRowOnPage` |
| Sorting | **`sortBy` mandatory.** `[{ columnName: "lastNoteDate", direction: "DESC" }]` accepted. |
| Response | `number` (Int), `formattedJobNumber`, `lastNoteDate`, `assignedTo`, `assignedToMemberName`, `statusName`, `systemStatusName`, `phase`, `locationNumber`, `locationName`, `clientName`, `priority { expectedCompletionDate }` |
| Report use | Default-on "assigned coordinator + LastNoteDate in range" rule, and the export's WO # / Location # / Client / Status / Coordinator / expected completion columns. |

With no `phase` filter the test user's coordinator set was **3** WOs. This is sufficient for the
default-on rule: page with `lastNoteDate DESC` and stop once a row falls before the range start.

## Confirmed data-flow changes vs. the spec

1. **No number-to-internal-id lookup.** `workOrderNotes` takes the WO number directly. The id
   resolution step and its cache are dropped.
2. **All notes need client-side filtering** by `createdBy_UserProfileId` and ET date range.
3. **WO detail fields** (location #, client, status, coordinator name, expected completion) come from
   `listWorkOrdersPaginated`. `assignedToMemberName` removes the separate user-name lookup.
   Batch fetch via `WorkOrderNumbers: [Int]` is **confirmed** (2026-09-30 check: two requested
   numbers, both returned, every field above non-null, `sortBy` still required, no `phase` filter).
   No single-WO fallback query is needed.
4. **Task search needs no `sortBy`.** WO list does.

## Request budget (per run, typical ~60 WOs)

| Phase | Calls |
|---|---|
| Member typeahead | 1 per debounced keystroke (>= 2 chars, 300 ms debounce) |
| Tasks | ceil(total / 100) - ~3 for 249 tasks |
| Coordinator WOs (checkbox on) | 1-2 pages until `lastNoteDate` < range start |
| WO details | ~1 if `WorkOrderNumbers` batch works (take >= WO count), else 1 per WO |
| Notes | 1 per in-scope WO (~60) |
| **Total** | ~65-70 (batch path), ~125 (fallback) |

- Concurrency: max **4** in flight (simple promise pool).
- Retry: HTTP 429 or 5xx **only when** the GraphQL error code is absent or transient; up to 3 attempts,
  backoff 1 s / 2 s / 4 s + jitter, honour `Retry-After` on 429.
- Never retried: `UNAUTHENTICATED`, `UNAUTHORIZED`/`FORBIDDEN`, validation or parse errors, 4xx other than 429.
- `UNAUTHENTICATED` mid-run aborts the remaining queue with a visible "session expired - reload
  Umbrava" message. Other failures mark that WO row with its error and the run continues.

## GraphQL operation allowlist (final userscript)

| Operation name | Root field | Kind |
|---|---|---|
| `NrMemberSearch` | `searchMembers` | query |
| `NrTasksByAssignee` | `tasks` | query |
| `NrWorkOrderNotes` | `workOrderNotes` | query |
| `NrCoordinatorWOs` | `listWorkOrdersPaginated` | query |
| `NrWorkOrderDetails` | `listWorkOrdersPaginated` (by `WorkOrderNumbers`) | query |

The guard enforces all of these:
- exact URL `https://app.umbrava.com/api/graphql`
- method `POST`
- operation name in the allowlist
- query text must be `query <ThatName>` and must be one of the script's constant query strings
- any `mutation` / `subscription` definition is rejected
- anything else throws with a visible error

## Known limitations / unresolved

1. **Task total 249 vs. baseline 243.** The 6 extra are most likely tasks assigned after the manual
   pull. Step 2 acceptance compares WOs in scope (~61), not the raw total. If the in-scope count
   differs, it gets explained before any logic changes.
2. **Max task page size 100** - carried from prior MCP facts, not re-verified (recon used `take: 1`).
3. **`WorkOrderNumbers` batch lookup** - confirmed for open WOs. Whether closed WOs are returned
   without a `phase` filter is untested; a WO that is not returned is flagged, not dropped.
4. **Note `type` labels** - numeric enum; no label map confirmed.
5. **`formattedJobNumber` may carry a suffix** (e.g. `W-######-001`) while `entityId` is the base
   number. Dedup is by `entityId` (WO number).
6. **Server-side `lastNoteDate` filtering** not tested; sort-and-stop is used instead.
7. Author = the user who logged the note in Umbrava (per spec). Quoted emails from others stay
   attributed to the logger.

## Step 2 plan

1. Userscript skeleton: metadata (`@match https://app.umbrava.com/*`, ExcelJS `@require` from
   cdnjs, `@grant none`), guarded `gql()` with allowlist, 4-slot pool, retry classifier.
2. Data layer: member search, paged tasks, scope filter, optional coordinator WOs, dedup, WO
   details (verify `WorkOrderNumbers` once), notes pull + client-side filter.
3. UI: `bwn-nr-` namespaced launcher + modal, typeahead, ET dates, checkboxes, progress, sortable
   preview, per-WO error rows.
4. Excel: Summary / Notes / Tasks / Flags tabs per spec.
5. Self-check script for the date-range, scope and retry-classifier logic.
6. Acceptance run: Anthony Laterza, 2026-09-23 to 2026-09-30, compared with the baseline. Stop on any mismatch.
7. `README.md`.
