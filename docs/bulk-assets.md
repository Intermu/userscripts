# BWN Bulk Asset Uploader (`bwn-bulk-assets.user.js`)

Bulk-creates Umbrava assets across a client's locations from a CSV/XLSX where each row is one
asset at one location. Validation is read-only; nothing is written until you confirm.

## Install and open

- Install from the raw URL (auto-updates like the rest of the suite):
  `https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-bulk-assets.user.js`
- Needs **bwn-suite-core 1.94.6+**, which carries the rail icon and the dock visibility rule.
- Opens from the **Bulk Assets** row on the BWN dock rail. The row appears only on
  `/clients/<id>` pages and only for rank 4+ (`BWN_DOCK_POLICY['bulk-assets']` in Core - change
  the floor there). Without Core, a floating **Bulk Assets** button appears instead after 4s.
- Kill switch: `bwn:modules.bulkAssets = false`, or the central `globalKillSwitch`, blocks every
  create before it is sent.

## Use

1. **Download template** (includes one `EXAMPLE` row - delete it; its location cannot resolve).
2. **Choose CSV / XLSX.** First sheet, header row 1, columns matched by header name in any order.
   - Required: `Location #`, `Asset Name`.
   - Optional: `Tag ID`, `Manufacturer`, `Model`, `Serial`, `Trade`, `Asset Type`, `Tag Location`,
     `Physical Location`, `Manufacture Date`, `Order Date`, `Install Date`,
     `Manufacturer Warranty End`, `Material Warranty End`, `Labor Warranty End`.
   - Aliases work (`Store #`, `S/N`, `Serial Number`, `Model #`, `Make`, ...). Unknown columns are
     listed as ignored.
   - Dates: Excel dates, `MM/DD/YYYY` or `YYYY-MM-DD`. Anything else is a row error.
   - Format long serial numbers as **Text** in Excel or Excel may round them.
3. **Validate (read-only).** Each row becomes:
   - `ready` - will be created.
   - `exists` - already at that location (serial match, else tag, else name). Skipped.
   - `error` - missing required value, location not found / ambiguous, unknown trade or type, bad
     date, or a duplicate of an earlier row (same location + serial/tag/name). Skipped.
     Since 0.1.2 also: an **Asset Name already used at that store** (by an earlier row, any case, or
     by an existing asset with a different serial - Umbrava refuses a repeated name per store), and
     any field over Umbrava's limits: Name 100, Tag ID / Model / Serial 50, Manufacturer 100,
     Tag Location / Physical Location 400. Both were found on the first live run (16 refused creates).
   - **Open locations only** (default on) limits the location search to open locations.
4. **Create N assets** - a confirm shows the count and the number of locations. One create at a
   time, 350 ms apart. **Stop after current row** finishes the row in flight; Create resumes.
5. **Download results** - XLSX: row, status, location, asset name, serial, created asset id or error.

### When a run halts

| Cause | What to do |
| --- | --- |
| Session expired / 401 / 403 | Refresh, sign in, reload the file, Validate. Created rows show `exists`. |
| 429 | Wait a minute, press Create to resume. |
| Network drop or 5xx on a create | Row shows `unknown`. Validate is required before Create unlocks; the row then reads `exists` or `ready`. |
| Kill switch on | Nothing more is sent; turn `bulkAssets` back on in Suite settings. |

Keep the tab open during a run (the page warns before closing). The drawer stays up while a run is
in progress even if another tool opens.

## Safety

- One write: `createAsset`, sent through `bwnGqlOp` (BWN-OPS-WRAP v3): `risk: 'high'` (confirmed by
  the run's confirm dialog), never retried, one PII-free `bwn:audit` entry per create (op, outcome,
  locationId - no field values), `success:false` rejected as a row failure.
- **No Umbrava permission gate yet (OWED).** Umbrava's asset permission flags have not been read out
  of the SPA bundle, so `createAsset` carries no `perm` and is listed in `PERM_EXEMPT`
  (`scripts/test-registry-authoritative.js`) with that reason. The server is the gate; the dock
  row's rank-4 floor is UI only. Capture the flags, add an `Asset` group to Core's `BWN_PERM_MAP`,
  then give `createAsset` its real `perm` and drop the exemption.
- Token: the canonical BWN-SHARED picker, read per request, never stored, logged or shown. Halts
  before sending when it is within 2 minutes of expiry.
- Activity log holds action labels, row numbers and counts only.
- Disabled off client routes; Create is blocked after navigating to a different client than the
  one validated.
- `@grant none`, no `@connect`, SheetJS 0.18.5 pinned by sha384. Never clicks page elements; no polling
  (SPA navigation via `pushState`/`replaceState`/`popstate`).

## API (live capture 2026-10-07; nothing else is sent)

`POST /api/graphql`, headers `Authorization: Bearer <token>` + `Content-Type: application/json`.

| Op | Use |
| --- | --- |
| `PagedLocations` | The client's whole location list, once per Validate (blank `search`, pages of 200 sorted by `Id`; error past 20,000); `clientTenantProfileId` = client id from the URL; open-only adds `{columnName:"Status",operation:"In",searchTerm:"[\"Open\"]"}`. Each sheet value is matched locally against that list. (0.1.0 searched per row; the server's contains-search paged through hundreds of loose hits, ~10 s a store on Pilot's 896 locations.) |
| Paging (0.1.3) | Both lists sort by `Id`: skip/take paging needs a unique sort key. A `Name` sort on Pilot (every name "Pilot Travel Center") returned 715 distinct of 896 on 2026-10-08 - a false "not found" in Validate. Results are de-duplicated by id and Validate stops with an error if the distinct count is not `rowCount`. |
| `ListTrades` | Once, if any row has a Trade. Case-insensitive name match. |
| `AssetTypes` | Once, if any row has an Asset Type; `tenantId` = client id. Pilot returns 0 types, so blank is normal. |
| `ListLocationAssets` | Existing assets per resolved location, pages of 500 sorted by `Id`. `isActive` omitted (assumed to include inactive - the stricter check). |
| `CreateAsset` | The write. `CreateAssetInput` exactly as the UI sends it, capital-P `PhysicalLocation`. |
| `AssetDetails` / `EditAsset` | Rename mode only (0.2.0) - see below. |

Matching rules:

- Digits-only sheet value (`1`, `0001`, numeric cell): the location number's digits, leading zeros
  stripped, must **equal** it - `1` matches `PFJ 0001`, never `PFJ 0011`.
- Otherwise equal after removing everything but letters/digits, case-insensitive.
- 0 matches = error, more than 1 = ambiguous error.
- Serial/tag compare ignores case, spaces and punctuation; `N/A`, `none`, `unknown`, `TBD`, `-`
  count as blank for matching only (still sent as typed).
- The name fallback for "exists" is deliberate: a token expiry forces a refresh, which loses the
  in-memory created list, and without it a row with no serial and no tag would be created twice.

Dates are sent as local midnight in ISO UTC (`new Date(y, m-1, d).toISOString()`), as captured.
Blank fields are sent as `null` (assumption for text fields - the capture only showed blank dates).

Errors: 401/403 or an `UNAUTHENTICATED`-family code (Umbrava sends that as HTTP 500) halt as auth;
429 halts as rate; a network failure or 5xx on a create halts as `unknown`; any other GraphQL error
(including `BAD_USER_INPUT` with an empty message, reported by its code) is a row failure.

Out of scope: attachments/photos (no upload call was captured).

## Rename by Tag ID (0.2.0)

A file with a **New Name** column switches the drawer to rename mode (the mapping card says
"Mode: rename by Tag ID"). Columns: **Location #**, **Tag ID**, **New Name** (required), **Current
Name** (optional guard). Other columns are ignored.

Validate (read-only) loads the client's locations once and each store's assets once, then per row:

- Location # + Tag ID must find exactly one asset (tag compared ignoring case/punctuation). None or
  two-plus sharing a tag is an error - never guessed.
- **Current Name**, when given, must still match Umbrava (or already be the new name) - a stale
  list is an error naming what Umbrava has now.
- New Name: 100 characters max, not used by another asset at that store, not repeated for that
  store in the file. The same asset twice in the file is an error.
- Already carrying the new name = `exists` (skipped).

**Rename N assets** confirms once, then per row, 350 ms apart:

1. `AssetDetails` reads the whole asset. If its name changed since Validate the row fails, unsent.
2. `EditAsset` sends **all 27 `EditAssetInput` fields** from that read with only `name` changed.
   The mutation is a full replace (captured from the asset form's own save, 2026-10-08), so a field
   left out could be blanked.
3. `AssetDetails` reads it again. If anything but the name moved, the row is `failed` and **the run
   halts**. Umbrava's own save turns an empty money field into $0 and a 04:00 time into midnight of
   the same day; those are not counted as changes (the form does the same).

`editAsset` goes through `bwnGqlOp` like `createAsset`: `risk: 'high'`, never retried, kill switch
`bulkAssets`, one PII-free audit entry (assetId + locationId only). Same OWED permission gap
(`PERM_EXEMPT`).

## Live test plan

Run in order on a client you can clean up; record results in the PR.

1. **1-2 rows at a test location.** Validate -> `ready`; Create -> `created` with an id. Check every
   field in Umbrava, especially dates (correct day), Trade and Physical Location. Delete afterwards.
2. **Location # formats.** `PFJ 0001`, `pfj-0001`, `0001`, `1` (also as a numeric cell) all resolve
   to one location; `1` never matches `0011`; a number shared by two locations is ambiguous.
3. **Unknown trade** -> row error; `hvac` resolves to `HVAC`.
4. **Bad dates** (`02/30/2024`, `Jan 5`, `15-01-2024`) -> row errors; Excel dates and ISO resolve.
5. **Duplicate re-upload.** The step-1 file again -> `exists`, Create count 0. Two identical rows ->
   the second is a duplicate error.
6. **Token expiry mid-run.** ~20 rows, sign out in another tab mid-run -> halts, nothing more sent.
   Refresh, reload, Validate -> created rows `exists`; Create finishes the rest.
7. **Stop then resume.** Current row completes, counts right; Create continues with `ready` rows only.
8. **Scale.** 50+ rows across 10+ locations: no 429, results XLSX matches the table.
9. **Kill switch.** `bulkAssets` off in Suite settings mid-run -> halts with the disabled message.
10. **Dock + context.** Row shows only on `/clients/<id>` and only at rank 4+; Create blocked after
    switching clients until re-validated; another tool's drawer does not close a running upload.
11. **Browsers.** Chrome and Edge, both with Tampermonkey.

## Develop

- Harness: `scripts/test-bulk-assets.js` (in CI). Loads the shipped file through its
  `module.exports` test hook; four negative controls re-run checks against mutated shipped bytes.
- Ledgers this script is classified in: manifest, UI-contract (drawer HAS), drawer-dismiss
  (CANONICAL), drawer-motion MODULES, shared token block (ADOPTED), toast (NONE), perm block
  (ADOPTED), registry-authoritative (`createAsset` in `PERM_EXEMPT`, OWED).
- Run with the Adobe-bundled node:
  `"/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bulk-assets.js`
