# Test plan — Umbrava Primark Reactive Intake

Three layers: (1) an in-script self-test (pure + mock-DOM), (2) a read-only live-browser validation
checklist, (3) a no-network verification. All layers are **read-only** for Umbrava and have **no**
contact with PRIMMS.

---

## 1. Self-test (pure + mock-DOM) and its host gate

**Gate (important):**

- **On `app.umbrava.com`:** `?bwnUpricSelfTest=1` runs the self-test.
- **Off the Umbrava host:** the self-test runs **only** with **both** `?bwnUpricSelfTest=1&bwnUpricTestHarness=1`.
  `?bwnUpricSelfTest=1` alone off-host renders **nothing** (verified: page shows only the harness `<h1>`).
- The **production panel never renders off `app.umbrava.com`** (host-bound). Off-host self-test mode touches
  only its own isolated mock fixtures + result panel; it does not read/observe/mutate the host page.

**Run:** the self-test renders a pass/fail panel and logs `[BWN UPRIC] self-test N/N OK|FAIL` to the console.

**Local harness (no live tenant needed):**

1. Copy `umbrava-primark-reactive-intake-companion.user.js` next to a one-line HTML file:
   `<script src="umbrava-primark-reactive-intake-companion.user.js"></script>`.
2. Serve the folder over http (local `file://` is sandboxed and will not execute the script in a browser
   preview) and open `…/harness.html?bwnUpricSelfTest=1&bwnUpricTestHarness=1` (the harness flag is required
   off-host).
3. Expect **all checks passed**.

**Covered checks (39):** numeric id extraction; prefixed `Reactive {id}` / `Work Order Number:` forms;
no id; multiple candidates; invalid id length; label normalization; Primark client classification;
Reactive type classification; email-origin confirmed/AI-note/unconfirmed/unavailable; deadline parsing
for each confirmed format + parse-fail; deadline states overdue/today/soon/week/future/unavailable; list
parsing after column reorder; missing required headers; non-Primark row; detail reference one/none/
ambiguous; dedupe preserving order; allow-list numeric-only; dispatch brief omits blanks; CSV three
approved columns; CSV formula-injection guard; copy/download exist but do not auto-fire; denied vs
allowed routes; storage-key discipline; no network API used; **self-test host gate (on-host / off-host /
harness / none); production host-bound; route transitions detail→detail / detail→denied / denied→detail;
single-panel / old-state-cleared / render-key set+cleared (no duplicates, no stale record); list
fail-closed notice naming Client + Source PO #; WO-Scope Reason/Location labelled inferred + omitted when
absent; PRIMMS id independent of scope digits.**

**Last run:** 59/59 passed in a real browser, 2026-09-16 (off-host, harness mode). Off-host without the
harness flag correctly rendered nothing.

## 2. Mock-fixture plan

Mock tables are built in-memory (`buildMockList(headers, rows)`) and parsed with `parseListFromTable`.
Fixtures deliberately use **no** production values — synthetic `W-#` numbers, `Primark` / `Finish Line`
clients, `2693750` / `2689724`-shaped ids, and dates relative to a fixed `now`. Add a fixture per new
column layout you want to guarantee (e.g. a view that includes `Source PO #` before `Client`, or one
that omits `First Trip Date`) and assert the coverage flags + per-row `idState`/`primark`/`deadline`.

## 3. Read-only browser validation checklist

Perform on the live tenant with an **authorized** session. **Do not** submit any form, edit any field,
change status, add a note, or dispatch. Do not open create/edit/dispatch routes.

- [ ] Open a Primark Reactive WO detail (`/work-orders/{number}/details`). Panel appears bottom-right,
      titled **Primark Reactive Intake**, compatibility **OK**.
- [ ] Classification reads **Confirmed Primark Reactive**; email origin **Email-created/source confirmed**.
- [ ] PRIMMS reference shows `PRIMMS WO: {number}` matching the `Source PO #` field.
- [ ] Dispatch brief lines match the visible fields; unavailable fields are omitted (no `—` guesses in the copy).
- [ ] Deadline badge matches `First Trip By`; priority reflects proximity only; disclaimer present.
- [ ] **Copy PRIMMS WO number** / **Copy allow-list entry** / **Copy dispatch brief** each copy on click and
      show a status line. Nothing copies without a click.
- [ ] Open a WO with an empty `Source PO #` → **No PRIMMS WO reference found**, copy buttons disabled.
- [ ] Open the Work Orders list (`/work-orders`). Panel shows **Visible rows only**, correct visible count.
- [ ] With the default layout (no `Client` / `Source PO #` columns) the panel says to add those columns and
      disables the id/queue/CSV actions (fail closed, no guessing).
- [ ] Add a `Source PO #` (and `Client`) column via a saved view → counts populate; **Copy visible allow-list**
      yields one numeric id per line, deduped, visible order; **Download reference-only CSV** has exactly
      `PRIMMS Work Order ID,Match State,Deadline State`.
- [ ] Navigate to a denied route (`/settings`, `/work-orders/{n}/notes`, a create/edit page) → **no panel**.
- [ ] Break-glass: on any recognized route where the expected markers never settle, the panel stays on
      *Loading…* and (after a bounded retry) a compatibility warning; it never shows another record's data.
- [ ] **Route transition:** open WO A, then navigate to WO B. The panel clears immediately and re-renders
      B; A's PRIMMS ID / deadline / brief never appear on B.
- [ ] **Detail → denied/non-detail:** from a WO, go to a notes/documents/settings/create route → the panel
      is removed.
- [ ] **Denied → detail:** return to a WO detail → the panel initializes exactly once (no duplicate panel
      or buttons after repeated DOM mutations).
- [ ] **Off-host gate:** on a non-Umbrava page, `?bwnUpricSelfTest=1` alone shows nothing; adding
      `&bwnUpricTestHarness=1` runs the tests; the production panel never appears off `app.umbrava.com`.
- [ ] Confirm afterward that **no** Umbrava field, status, note, or record changed.

## 4. No-network verification

- **Static grep:** `grep -nE '\b(fetch\(|XMLHttpRequest|GM_xmlhttpRequest|sendBeacon|new WebSocket|EventSource|\bimport\()'`
  over the `.user.js` returns **no** call sites (comments and the `typeof window.fetch` presence-check in the
  self-test excluded). Metadata has `@grant none`, no `@require`, no `@connect`, no `@resource`.
- **Live network tab:** with the panel active on a WO detail and on the list, and after clicking every
  button, the browser DevTools Network tab shows **no** request originating from the script (clipboard and
  the `blob:` CSV download are local, not network).

## 5. Regression checks

- Re-run the self-test after any `CONFIG` label/route change; expect all checks pass.
- After an Umbrava UI update, re-run the read-only browser checklist §3; if a field/label moved, update the
  matching `CONFIG` entry (no logic change) and re-run.
- Confirm the deny-list still blocks `notes`/`documents`/create/edit/dispatch/financial routes.

## 6. Umbrava (read-only) vs PRIMMS (write-enabled) — keep separate

This script is **read-only** and lives entirely on `app.umbrava.com`. The **PRIMMS Bulk Acceptance
Assistant** is a *separate* userscript on the PRIMMS/Ostara host that performs the accept + acceptance-note
**writes**. The only thing that crosses between them is a numeric work-order number the coordinator copies
and pastes. Never test the two against each other, never let this script reach PRIMMS, and never let the
PRIMMS tool reach Umbrava.
