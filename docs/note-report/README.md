# BWN Note Report

`bwn-note-report.user.js` (repo root). A read-only Tampermonkey userscript for `app.umbrava.com`. Pick a user and a date range, and it
builds that user's note activity report across every work order they touched, with an Excel export.
It replaces the manual loop of pulling each work order's notes by hand.

## Install

1. Install the Tampermonkey browser extension.
2. Open https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-note-report.user.js and
   click **Install**. It auto-updates from the same URL.
3. If you had the old **Umbrava Coordinator Note Report** (1.0.0 / 1.1.0, installed by paste),
   delete it in the Tampermonkey dashboard. It has a different name and namespace, so Tampermonkey
   treats this as a separate script and both would run.
4. Reload Umbrava. **Note Report** appears as a row in the BWN Suite dock. Without BWN Suite Core
   installed, a **Note Report** button appears at the bottom-right instead.

## Use

1. Sign in to Umbrava as usual and open **Note Report** from the dock.
2. Type at least 2 letters of a name in **User** and pick the person from the list. Teams are not listed.
3. Adjust **Start** / **End** if needed. The default is the last 7 days, including today, in Eastern Time.
4. Options:
   - *Also include WOs where the user is the assigned coordinator and LastNoteDate is in range* (on by default).
   - *Include notes by others* (off by default). This adds other people's notes as muted context rows.
5. Click **Run**. Progress shows `Resolving WOs X/Y…`, then `Pulling notes X/Y…`.
   **Cancel run** stops queued requests; anything already retrieved is kept.
6. Review the summary and the sortable table, then click **Export** to download
   `NoteReport_<LastName>_<start>_to_<end>.xlsx`.

## Scope rules

All dates are Eastern Time calendar days. Start = 12:00 AM on the start date; end = 11:59:59 PM on the end date.

A work order is in scope when the user has a work-order task on it that meets any of these:
- it was created in the range
- it was completed in the range
- it is still open and its target start date is on or before the end date

With the coordinator option on, work orders are added where the user is the assigned coordinator
and the work order's last note date falls in the range. Work orders are de-duplicated before notes
are pulled.

A note is counted when its author is the selected user and it was created in the range. The author
is whoever logged the note in Umbrava. A note quoting someone else's email still belongs to the
person who logged it.

## Export

| Tab | Contents |
|---|---|
| Summary | User, range, generated time (ET), totals, notes per day, notes per work order, work orders with open tasks, flag list |
| Notes | One row per note, sorted by WO then time. Columns: WO # (links to the Umbrava WO), Location #, Client, WO Status, Assigned Coordinator, Date (ET), Time (ET), Note Type, Note (full text, wrapped), Author. Autofilter, frozen header. Context notes by others are grey italic. |
| Tasks | Each in-scope task: WO #, Description, Created, Target, Completed, Status (Open/Done), Days Open |
| Flags | WOs past expected completion; open tasks past their target date; WOs with task activity but no notes by the user in range; gaps of 2+ business days with no user note on an open WO; any WO whose notes or details could not be retrieved |

## Safety

- **Read-only.** The script can send only five fixed, named GraphQL queries, all to the same-origin
  endpoint `https://app.umbrava.com/api/graphql`. Every request goes through one guard, which
  rejects any other operation, any mutation or subscription, and any other host.
- **Authentication.** The script transiently uses the active Umbrava session's access token, only
  for these same-origin read-only calls. It never stores, logs, displays or exports the token. If
  the session has expired, the run stops and asks you to refresh or sign in.
- **No external calls** except loading ExcelJS from cdnjs at install time. No data is sent anywhere else.
- **Nothing is persisted.** Results live in page memory until you close or reload the tab.
- **Load.** At most 4 requests are in flight at once. Retries (at most 2, with backoff) happen only
  for rate limiting (429) or temporary gateway errors (502/503/504). Authentication and validation
  errors are never retried. One failed work order is shown in the results and the Flags tab; the
  rest of the run continues.

## Known limits

- Umbrava has no author or date filter for notes. Each work order's notes are pulled in full and
  filtered in the browser, so work orders with long histories make runs slower.
- Note types are shown as Umbrava's numeric codes until a label mapping is confirmed.
- Business-day gaps skip Saturdays and Sundays only; holidays are not excluded.
- Authors other than the selected user are named only when they are the WO's assigned coordinator.
  Anyone else shows as "Other user (id prefix)".
- A task's target date at exactly midnight UTC is treated as a calendar date.
- **Open vs. closed work orders.** Umbrava returns no closed/completed flag, so the script reads the
  WO's phase, system status and status text. Any of *Complete(d), Closed, Cancelled/Canceled, Void,
  Archived* (any case) means closed; any other value means open; no value means unknown. Unknown
  WOs never get past-expected-completion or note-gap flags. Closed WOs are excluded from the
  open-task count and the open-task-past-target flags. The word list is a defensive rule, not a
  verified list of every Umbrava status.
- Excel shows DM Sans only if it is installed on the machine; otherwise Excel substitutes a font.
- A user's task total can differ from earlier manual pulls (for example, 243 historically) as tasks
  are added or reassigned.

## Change log

- **1.2.0** (2026-09-30) - Moved into the BWN Suite repo as `bwn-note-report.user.js` (was
  `userscripts/note-report/umbrava-note-report.user.js` in `broadway-internal-ops`). Suite header:
  `BWN Note Report (Broadway National)`, namespace `broadwaynational.bwn`, `@downloadURL` /
  `@updateURL` so it auto-updates, ExcelJS `@require` pinned with a sha384 integrity hash. The dock
  row gets Core's line icon and visibility policy (Core 1.92.1). No behaviour change.
- **1.1.0** (2026-09-30) - Opens from the BWN Suite dock (floating button only when Core is
  absent). Close and Esc now close the modal, and Esc works even when focus has left it. Opening
  it closes any other open BWN drawer.
- **1.0.0** (2026-09-30) - First release: user typeahead, task / coordinator scope, batched WO
  details, notes pull with client-side filtering, preview table, four-tab Excel export.
