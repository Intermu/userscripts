# Ask BWN - Tier 1 trips feasibility spike (documentation only)

Read-only investigation. No runtime tool, no GraphQL registration, no Ask preload change,
no Quick Command, no modal UI, no user-visible change was made by this spike.

## Read-only surfaces reviewed

`bwn-suite-ai.user.js` (case-file card, approx lines 4084-4114):

```graphql
query($id:Int!){ workOrderTrips(jobId:$id){ trips{ onSiteDate completedDate canceledDate status } } }
query($id:Int!){ purchaseOrderTrips(jobId:$id){ vendorName trips{ onSiteDate completedDate canceledDate status } } }
```

- Both are read-only GraphQL `query` operations, browser-executed with the coordinator's
  same-origin session (via the suite-ai `gql()` helper).
- Both are keyed by the INTERNAL job id (`jobId: Int!`), NOT the work-order number.
- Documented, proven history: the query was previously wrong (guessed args, threw, swallowed
  to empty) and was corrected against the live schema on 2026-08-06. `WorkOrderTrip` has
  exactly four fields (`trips, clientId, clientName, hasActiveUsers`); the trip rows carry
  `onSiteDate / completedDate / canceledDate / status`; `purchaseOrderTrips` additionally
  carries `vendorName`.
- The case-file code derives on-site dates as `trips.filter(t => t.onSiteDate && !t.canceledDate)`
  then sorts real dates - i.e. chronology comes from `onSiteDate` presence, not from `status`.

`bwn-ask.user.js` (coordinator Ask preload):

- `gatherContext()` queries `workOrder(workOrderNumber:$n)` selecting
  `number / trackingNumber / scopeOfWork / serviceInstructions / locationId / locationName /
  address / trades / priority / doNotExceed / statusName / dates / coordinator / vendorNames`
  and `jobNotes(workOrderNumber:$n)`.
- It does NOT select or expose the internal `id` / `jobId`. The trips query needs that id.

`broadway-internal-ops/api/ai/index.js`:

- Only future prompt/citation implications noted; no server change made or required.

## Findings against the go/no-go rubric

| Question | Finding |
|---|---|
| Internal `jobId` available in Ask preload? | NO. Neither Ask WO query selects it. Would require adding `workOrder{ id }` and verifying it returns the id `workOrderTrips`/`purchaseOrderTrips` accept. |
| Technician identity present? | NO. Trip rows are dates + `status` only. The only actor is a VENDOR name via `purchaseOrderTrips.vendorName` - not an individual technician. |
| Trip status vocabulary verified? | NO. `status` is selected but its allowed values are not enumerated anywhere; the shipped code infers state from date-field presence (`onSiteDate`, `canceledDate`), not from `status`. |
| Chronology reliable? | PARTIAL. Real `onSiteDate` values are orderable and canceled trips are excluded, but this holds only where `onSiteDate` is a real, non-null date. |
| Vendor-to-specific-on-site-date correlation? | NOT CLEAN. The case-file code pushes vendor names and trip dates into separate lists; there is no proven per-trip vendor+date correlation to say "vendor X was on site on date Y". |

## Verdict

- NO-GO for "who was last on site", "who was on site", and "latest verified visit". Blockers:
  internal `jobId` is not available in Ask preload context; technician identity is absent;
  trip status vocabulary is unverified; vendor-to-specific-on-site-date correlation is not clean.
- CONDITIONAL FUTURE POSSIBILITY (separate approval only): a narrower dates-only "documented
  on-site date(s) on this work order" feature could be reconsidered after verifying, against
  the live schema, (a) job-id availability from an Ask WO query, (b) `onSiteDate` timestamp
  semantics and reliable ordering, (c) the `status` vocabulary, (d) PII handling for any vendor
  name shown, and (e) the citation shape. It would be preloaded context (consistent with the
  Ask architecture), not a model tool, and must never assert a person or "who was on site".

## Confirmation

This spike created no runtime tool, no GraphQL registration, and no user-visible feature.
