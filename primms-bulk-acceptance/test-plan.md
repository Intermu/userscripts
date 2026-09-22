# Test plan — Primark PRIMMS Bulk Acceptance Assistant

Phase 1 is the shippable surface. Every test below runs in a browser with the userscript installed on
the approved host, except the pure-helper self-test which also runs headless-ish via a query flag.

## 0. Pure-helper self-test (built in)

Load any approved PRIMMS page with `?bwnPbaSelfTest=1` **or** set `CONFIG.DEBUG = true`. The console
must print `self-test passed (N assertions)`. It covers: `normalizeHeader`, `validateId`,
`buildNote` (including the exact required note string and the `{ACCEPTING_USER_NAME}` token),
`csvEscape`, `clampDelay` (floor + non-numeric), `greetingForHour`, `parseAllowList` dedupe,
`extractIdFromHref`. A failure lists the failed assertions.

## 0b. Adapter mock/fixture suite (DOM-injected, no live writes)

Run `?bwnPbaSelfTest=1` **on the jobs list** (so the fixtures don't collide with a real modal/actions
list). Console prints `mock-test passed (N assertions)`. It injects redacted mock DOM and covers:
valid unique Accept/Add-Notes forms validate; missing anti-forgery → invalid; missing `WorkOrderId`
reported; duplicate forms detectable; pending vs accepted detail (accept link 1 vs 0); accepted event
detected; Add Notes still present after acceptance; `verifyAccepted` false while accept link present /
true with both signals; **note read-back** `matchNoteInMessages` finds/misses the note across `.message`
nodes; `noteHistoryFrameDoc` returns `unrecognized` (no frame) / `ambiguous` (two frames); `verifyNote`
awaiting-readback fallback when the History control is absent; dry-run adapter active while flag false;
`acceptJob`/`addNote` **fail closed** (`live-writes-disabled`) while flag false; name prefill for
Broadway Helpdesk / Rachel / Jane Doe / missing header; frozen signer; `batchCap()===1`.

**Note History structure (test-record confirmed, read-only):** History dialog → `#noteHistoryWrapper`
→ same-origin `#notehistoryframe` iframe → `.message` (body) / `.sender` / `.date`, oldest→newest.
`verifyNote` opens it via `#workOrderNoteHistoryLink`, scans `.message` normalized; read-back proven
live on 2689724 (Boolean match, no content stored). Add Notes field = plain `textarea[name="Notes"]`
(jHtmlArea case B).

**Browser self-test (run when installed):** install v0.2.5 in Tampermonkey, open the jobs list with
`?bwnPbaSelfTest=1`, read the console for `self-test passed (N)` and `mock-test passed (N)`. Not
executable outside Tampermonkey (file:// renders static; inline injection is 85 KB) — pure/data
assertions were verified in Node this session; the DOM suite runs under the flag.

## 1. Grid parsing

- [ ] On a `/Filter` list, the panel reports the correct **visible** row count.
- [ ] Reorder columns via the platform's layout editor → row parsing still resolves the Work Order
      column by header text (no index dependency).
- [ ] Change page size (e.g. 75 → 10) → the AJAX partial refresh is detected by the MutationObserver
      and the counts update; the panel is **not** duplicated.
- [ ] A page with the grid absent shows **"Grid not recognized. No jobs were selected."**
- [ ] A grid whose Work Order header can't be resolved shows **"Could not identify the Work Order
      column. Selection is disabled."**

## 2. Note construction

- [ ] Preview renders exactly: `Good morning, thank you for this new work order. We will provide an
      ETA for service as soon as possible. Thank you, <name>` (trailing spacing/punctuation intact).
- [ ] Greeting defaults to the local-clock value; changing it away from local time shows the mismatch
      **warning banner**.
- [ ] The character count matches the preview length.

## 3. Dry-run (default)

- [ ] With rows selected, **Dry-run preview** lists refs, ids, detail URLs, exact note, action order.
- [ ] Audit log gains only `dry-run` rows; no `succeeded`/`failed`.
- [ ] **Zero network requests** — see §7.

## 4. Compatibility / fail-closed

- [ ] Panel renders on `/Filter*` and `/WorkOrder/Detail/{id}` only.
- [ ] Panel does **not** render on `/WorkOrderAction/*`, `/WorkOrder/Create`, `/Authentication/*`,
      `/Settings`, the home page, or any unrecognized route.
- [ ] Deny-list regex unit-checked against every route in `api-inventory.md` (each `/WorkOrderAction/*`
      entry, `/WorkOrder/Create`, `/Authentication/*`, `/Settings`) → all denied; each read-only route
      → allowed or (home) inert.

## 5. Stop button

- [ ] Clicking **STOP** sets the stopped status, writes a `stopped` audit row, and clears any armed
      token + batch state (`bwn.primms.acceptance.armed` / `.batch` removed from sessionStorage).

## 6. Already-accepted / duplicate-job / armed-token (Phase 2 scaffold behavior)

- [ ] `validateArmedToken` returns `absent` with no token; `expired` past TTL; `scope-changed` when
      the tenant fingerprint differs; `denied-route` on a WorkOrderAction path. (Exercise via console
      by writing a token into sessionStorage and calling the boot again, or by unit-lifting the
      function.)
- [ ] With `LIVE_WRITE_ENABLED` still false, **Live execution** is disabled and, if force-invoked,
      returns the disabled message — no navigation, no click.
- [ ] `PrimmsWriteAdapter.process` returns `failed:live-writes-disabled` while the flag is false.

## 7. Zero-network proof (the important one)

Two independent checks, both must pass:

1. **DevTools Network panel**, filtered to the PRIMMS origin, cleared before interacting. Perform a
   full dry-run workflow (enter name, paste allow-list, select rows, Dry-run preview, export CSV,
   clear audit). **No request initiated by the script appears.** (Normal page navigation the operator
   performs is out of scope; the script itself must add nothing.)
2. **Monkey-patch assertion**, paste into the console *before* interacting:

   ```js
   (function () {
     const boom = (n) => function () { throw new Error('BLOCKED: script called ' + n); };
     window.fetch = boom('fetch');
     const OX = window.XMLHttpRequest;
     window.XMLHttpRequest = function () { throw new Error('BLOCKED: script called XMLHttpRequest'); };
     if (navigator.sendBeacon) navigator.sendBeacon = boom('sendBeacon');
     console.log('network guards armed');
   })();
   ```

   Then run the entire dry-run workflow. Nothing throws. (CSV export uses `Blob` + object URL, not
   network, so it still works.)

## 8. Phase 2 — adapter + state-machine checks

The state machine (`processItem(adapter, item, onState)`) is dependency-injected, so most checks run
with a **mock adapter** in the console — no live writes. Example harness:

```js
const mock = { name:'mock', writes:true,
  async validateItem(i){ return i._skip?{ok:false,reason:'x'}:{ok:true}; },
  async acceptJob(i){ return i._accFail?{workOrderId:i.workOrderId,outcome:'failed',message:'acc'}:{workOrderId:i.workOrderId,outcome:'dry-run',message:'ok'}; },
  async verifyAccepted(i){ return {ok:!i._accVerFail}; },
  async addNote(i){ return i._noteFail?{workOrderId:i.workOrderId,outcome:'failed',message:'note'}:{workOrderId:i.workOrderId,outcome:'dry-run',message:'ok'}; },
  async verifyNote(i){ return {ok:!i._noteVerFail}; } };
// then call processItem(mock, {workOrderId:'1',ref:'1'}, (s,m)=>console.log(s,m))
```

| # | Check | How |
|---|---|---|
| 1 | Grid parses when columns reordered | live list, reorder, counts hold (header-text keyed) |
| 2 | Missing Work Order header | remove header in DOM → "Could not identify the Work Order column" |
| 3 | Missing eligibility marker | column mode, no candidate header → selection disabled |
| 4 | Row with no detail URL | pre-flight rejects: "selection is stale. Re-select." |
| 5 | Max batch-size enforced | select > `MAX_BATCH_SIZE` → capped; pre-flight blocks |
| 6 | Empty operator name | live button disabled; pre-flight blocks |
| 7 | Name with punctuation | note preview renders it verbatim (self-test covers buildNote) |
| 8 | Dry-run audit outcome | §3 |
| 9 | Stop before first job | STOP → `stopped` audit; token cleared |
| 10 | Stop between jobs | set `state.stopRequested` before resume → stops, clears token |
| 11 | Stop during in-flight | in-flight settles, no next item begins (loop checks Stop each item) |
| 12 | Already accepted | mock `_skip` / live: Accept link absent → `validateItem` skip |
| 13 | ID mismatch after nav | resume: `detailPageId() !== item.workOrderId` → paused, no action |
| 14 | Missing/duplicate Accept selector | `uniqueEl` returns null → `validateItem` `accept-link-not-unique` |
| 15 | Acceptance failure | mock `_accFail` → item `failed`, no note attempted |
| 16 | Acceptance verify failure | mock `_accVerFail` → `accept-verify-failed`, no note |
| 17 | Missing note input | (needs test record) `addNote` fails closed today |
| 18 | Note save failure | mock `_noteFail` → **partial**: `partial-accepted-note-failed` |
| 19 | Note read-back failure | mock `_noteVerFail` → `partial-accepted-note-verify-failed` |
| 20 | Partial (accepted, note not verified) | as #18/#19 — distinct message, never reversed |
| 21 | Session expiry / redirect off route | resume: `validateArmedToken` denied-route/host → stop |
| 22 | Continue-after-failure OFF (default) | one failure stops the batch |
| 23 | Continue-after-failure ON | failure records, batch advances |
| 24 | No concurrency | single `await` chain; one item at a time by construction |
| 25 | No duplicate submission | index persisted in sessionStorage; page-id must match current item |
| 26 | CSV minimal fields + formula-injection safe | export headers = ts,id,id,action,outcome,message; self-test asserts `=`/`@` neutralized |

**Live write path (#17, real Accept/Note DOM):** blocked — `acceptJob`/`addNote` fail closed until a
disposable test record validates the action-page submit. Do not bulk-process real work orders to test.

## 9. Read-only discovery regression checks

**Pending-vs-accepted comparison (live, read-only):**
- [ ] On a **pending** detail page: `document.querySelectorAll('#workOrderActionsList a[href*="/WorkOrderAction/AcceptJob/"]').length === 1`.
- [ ] On an **accepted** detail page: the same count `=== 0`, **and** the Add Notes link count `=== 1`
      (note remains available post-acceptance), **and** the event trail contains a "Website - Accepted"
      row. This is `verifyAccepted()`'s signal — confirm it flips exactly across the two states.
- [ ] `detailPageId()` returns the numeric id on both, matching the URL path.

**Note-history parser + normalization (unit, no live writes):**
- [ ] `normalizeNoteText('<p>Good  afternoon,&nbsp;thanks</p>') === 'Good afternoon, thanks'`.
- [ ] `noteTextMatches('<div><p>… Good afternoon, thanks …</p></div>', note) === true`; a container
      without the note → `false`. (Both in the built-in self-test.)
- [ ] `noteHistoryContainerText()` returns text on `/WorkOrderReadOnly/ViewNoteHistory/{id}` (or when a
      note-history table is inside `#modalDialog`), and `null` elsewhere → `verifyNote` fails closed.

**jHtmlArea content sync (unit):**
- [ ] `prepareJHtmlAreaValue(null, 'x') === false` (null-safe; self-test).
- [ ] With a mock textarea (no jQuery), it sets `.value` and returns `true`, and **never** submits.

**Fixture-driven tests:**
- N/A in this build — no fixture folder exists. When redacted Accept/AddNotes/AcceptedWO/NoteHistory
  HTML fixtures are added, add parser tests for the modal form field names and the note-history rows;
  do **not** treat fixture parsing as confirmation of live action mechanics.

**Explicit no-write browser-session test:**
- [ ] Drive the authenticated PRIMMS session read-only through selection + dry-run. Confirm the event
      trail on every touched work order is unchanged (no new "Accepted"/"Notes Added" events) and no
      `/WorkOrderAction/*` request was issued. The action modals must never be opened.

**Phase 1 zero-network regression (unchanged):** re-run §7 — DevTools Network filtered + the
`fetch`/`XHR`/`sendBeacon` monkey-patch — and confirm the dry-run workflow issues nothing. Live
navigation (`location.assign`) exists only behind `LIVE_WRITE_ENABLED` and is not reached in dry-run.

## 9b. Write-form fixtures + pre-submit guard (test-record confirmed, no submit)

Confirmed shapes from the test-record modal inspection (values never read). Use as mock fixtures for
`validateLoadedActionForm()` — none of these submit anything.

```html
<!-- Accept Job modal form (mock) -->
<div id="modalDialog"><form action="/WorkOrderAction/AcceptJob/2689724" method="post">
  <input type="hidden" name="__RequestVerificationToken">
  <input type="hidden" name="WorkOrderId"><input type="hidden" name="ActionButtonType">
  <input type="hidden" name="HasInitialEta"><input type="hidden" name="TimezoneId">
  <input type="hidden" name="EtaIsMandatory">
  <input type="datetime-local" name="Eta" id="Eta"><input type="text" name="ResourceReference">
  <textarea name="Notes"></textarea><input type="submit" value="Save">
</form></div>

<!-- Add Notes - Public modal form (mock) -->
<div id="modalDialog"><form action="/WorkOrderAction/AddNotes/2689724" method="post">
  <input type="hidden" name="__RequestVerificationToken">
  <input type="hidden" name="WorkOrderId"><input type="hidden" name="ActionButtonType">
  <textarea name="Notes" required></textarea><input type="submit" value="Save">
</form></div>
```

- [ ] With the Accept mock in the DOM: `validateLoadedActionForm('accept').ok === true`.
- [ ] With the Add Notes mock: `validateLoadedActionForm('addNotesPublic').ok === true`.
- [ ] Remove the `WorkOrderId` hidden input → `.ok === false`, `.missing` lists it.
- [ ] No modal present → `{ ok:false, reason:'form-not-loaded' }` (self-test asserts this).
- [ ] `WRITE_FORMS.addNotesPublic.noteField === 'Notes'` and `.accept.method === 'POST'` (self-test).

**Still requires one controlled test Save (not in this build):** the Accept/Add-Notes POST response and
post-submit DOM, and that a submitted note appears in `ViewNoteHistory` so `verifyNote` resolves true.
Do this once on the test record only; never in a batch, never on a real client job.

## 10. Manual validation checklist (before any live enablement)

Complete `discovery-checklist.md`. Do not flip `LIVE_WRITE_ENABLED` until the section-4 test-record
items (Accept + Add Notes modal form mechanics, note-history read-back) are validated, including
normalized note read-back on the real history.
