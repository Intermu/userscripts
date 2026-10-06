# BWN AI Proposal Assist - discovery notes

Source: field testing, Oct 2026 (the spec handed to the build session on 2026-10-06). No live
Umbrava capture was taken while building v0.1.0. Anything marked **inferred** is a guess the code
makes in a forgiving way, and it needs confirming on a live page before the script is called done.

## Confirmed (from field testing)

| Fact | Where the script relies on it |
|---|---|
| Umbrava is an SPA. Data goes through `POST /api/graphql`. | Passive fetch/XHR tap filtered on `/api/graphql`. |
| AI ops are `GenerateAIProposalPreview(data:{quoteId, userPrompt})` and `ReworkAIProposal(data:{quoteId, previousResult{...}, userFeedback})`. | `WATCH_OPS` names both. |
| The preview carries `scopeOfWork, reasoning, estimatedGrossProfitPercent, estimatedTotal, estimatedVendorCost, lineItems[{sourceLineItemId, categoryId, categoryName, item, unitOfMeasurement, unitCost{amount,precision}, markUpPercent, unitCharge, chargeQuantity, rateId, isGenerated}]`. | `checkPreview`. |
| Money is in cents. | `gqlCents` treats a bare number as cents. |
| `userPrompt` limit is 1,000 chars. Over it, the server returns `validationErrors` and the UI shows only "Something went wrong". | Hard stop at 1,000, warning at 950. `errorsOf` shows the server text. |
| The Revise limit is 4,000 chars. | Not used. There is no Revise automation, on purpose. |
| The AI can only change scope text, markup and charge quantity. Line names, categories, UOM and Trip # come from the vendor proposal. | This is why Pre-flight works on the vendor proposal and never on the AI output. |
| Free-text vendor line names don't match the client rate card and can price below cost. The rate card overrides prompt guardrails. | Below-cost and range checks run after Generate. A prompt alone can't prevent it. |
| Revise regenerates the whole scope even for non-scope requests, and it ignores "do not change". | No Revise automation. The checker only reads Rework responses. |
| Vendor proposal route: `/work-orders/{wo}/proposals/vendor-proposals/{quoteId}/details`. AI preview route: `/work-orders/{wo}/proposals/{quoteId}/ai-preview`. | `RX_VP`, `RX_AI`. |
| Vendor grid columns: Category, Trade, Item, Trip #, UOM, Quantity, Unit Cost, Total Cost... | Columns are keyed by header text (`rowsFromGrid`), never by index. |
| The WO header strip shows Client DNE (NTE), Total Vendor Cost, WO # and Priority. | `readNte`, `readVendorTotal`. |

## Live findings, 2026-10-06 (WO 396190, vendor proposal 566726; fixed in 0.1.1)

These were read-only DOM checks with 0.1.1 loaded by eval. No graphql requests came from the script.

- **The vendor grid is a MUI `<table>` with three header rows:**
  1. A group row: Details, Cost and Tax, each spanning several columns.
  2. The column row. After the expected columns it also has Taxable, Tax %, Tax Amount and Total
     Charge, plus some unlabelled cells.
  3. A blank row.

  0.1.0 read all three header rows as one list, so every column after the group row was mapped to
  the wrong cell. 0.1.1 finds the header row by its content, expands colspans, and reads the data
  rows that follow it.
- **An empty Trip # or UOM cell renders as `--`.** It is now read as blank.
- **The Item cell can be truly empty.** Rows are now named by their category, e.g.
  "(Labor line, no item name)".
- **The vendor proposal header shows `PO NTE $…`** (the vendor PO limit), not the client DNE.
  Pre-flight now warns when the vendor total is over the PO NTE. The client DNE is not on this
  page, so the client NTE comparison shows "not found".
- **On the WO page, Client DNE is a labelled `<input>`, not text.** `readNte` reads a labelled
  input first. The WO page is not a script route, so this only helps if the AI preview page uses
  the same field.
- **Generate lives in a modal on the vendor proposal page, not on `ai-preview`.** "Generate Client
  Proposal" is a react-aria dialog. Its prompt box is a single-line `<input type="text">` with
  placeholder "keep labor markup under 30%" and no `maxlength`. After Generate, the app navigates
  to `/work-orders/{wo}/proposals/{vendor quoteId}/ai-preview`, which uses the same id. Opening that
  URL directly with no fresh preview shows "No data available".
  - **Effect on Insert:** while the modal is open, react-aria sets `inert` on every other child of
    `<body>`, including the panel, so the panel can't be clicked. 0.1.1 arms Insert instead: click
    Insert before opening the modal, and the text is filled once when the modal's box appears.
  - **Effect on the prompt text:** the single-line input drops newlines, so Insert joins the
    sections with a space.
  - **Effect on the checker:** it accepts the response on either route. Cross-page context is keyed
    on the WO number.
- **Response shape, confirmed by capturing keys and types only (no values):**
  `data = { __typename, generateAIProposalPreview: { __typename, success:boolean, message:string,
  preview: { scopeOfWork, reasoning, estimatedGrossProfit:Money, estimatedGrossProfitPercent:string,
  estimatedTotal:Money, estimatedVendorCost:Money, lineItems:[...] } } }`, plus
  `extensions.traceId`. `Money = { __typename, amount:number, currency, precision:number }`.
- **Line item fields:** `categoryId:number, categoryName, item, unitOfMeasurement,
  sourceLineItemId:number, isGenerated:boolean, revisedDescription:null, rateId:string,
  unitCost:Money, unitCharge:Money, markUpPercent:string, chargeQuantity:string`.
- **Two 0.1.0 checker bugs this exposed, both fixed:**
  - `data.__typename` is the **first** key, so "first field of data" returned the typename.
    `payloadOf` now skips it.
  - `markUpPercent` and `chargeQuantity` are decimal **strings**, so the negative-markup test
    (`typeof === 'number'`) never fired. Both are now parsed as numbers.
- **The script sent nothing.** A test-only logger wrapped `fetch` outside the script and recorded
  every graphql call through two Generates and the page loads: 31 calls, all from the app, none
  from the script. The app calls `window.fetch` at call time, so a document-start tap sees
  Generate.

## Inferred (verify live)

1. **Response field name.** CONFIRMED `generateAIProposalPreview` (see live findings). The script reads `data.<first field>` and doesn't hard-code
   `generateAIProposalPreview`.
2. **Rework response shape.** Assumed to be the same `{success, message, preview}` envelope. If
   `preview` is missing, the script falls back to `result`, and then to the payload itself when it
   has `lineItems`.
3. **Where `validationErrors` lives.** The script collects it from any depth (payload,
   `errors[].extensions`), plus `errors[].message` and a `success:false` `message`.
4. **`unitCharge` format.** CONFIRMED Money object. Assumed to be a bare number in cents. A `{amount, precision}` object is
   also accepted.
5. **`markUpPercent` units.** CONFIRMED a decimal string; units (35 vs 0.35) still to check against a known line. Assumed to be a whole percent (35, not 0.35).
6. **Transport.** CONFIRMED `window.fetch` at call time. Apollo is assumed to use `fetch`. XHR is tapped too, as a backup. A `Request`
   object passed as `input` with its body inside isn't read (`ponytail:` ceiling: add
   `input.clone().text()` if the live app does that).
7. **Grid DOM.** CONFIRMED <table> 2026-10-06 (see live findings).
   Original guess: Assumed to be a `<table>` or an ARIA grid (`role=grid|table|treegrid`,
   `columnheader`, `row`, `cell|gridcell`). If it's neither, Pre-flight shows "layout not
   recognised — disabled".
8. **Header strip DOM.** The label text node "Client DNE" / "NTE" / "Total Vendor Cost" is assumed
   to have a `$` amount within three ancestors.
9. **Generate prompt box.** Assumed to be the only `<textarea>` that shares a close ancestor with a
   button whose text starts with "Generate". React picks the value up through the prototype value
   setter plus an `input` event.
10. **NTE on the AI route.** The header strip is read there first. If it's absent, the script uses
    the value cached in sessionStorage from the vendor proposal page for the same quote.
11. **Same `quoteId` on both routes.** WRONG, see live findings; context now keys on the WO number.
    Original guess: Pre-flight caches item names, trip count and NTE under
    `bwn:apa:ctx:<quoteId>` so the builder can prefill. If the AI route's id differs, the prefill
    is just empty.

## Unknown (needs Mike)

- **The exact Pilot NEXREV override line.** It isn't in the spec, so the script does not invent it.
  Paste it once into the verbatim field and Save template. The Pilot Travel Centers template ships
  with that field empty.
- **Pricing-rules wording.** The seeded default is "rate card first, never below vendor unit cost,
  materials markup 35% max", taken from the checker's rules. It can be edited per template.

## 0.3.0 read-only context (live-checked 2026-10-06, WO 396190)

The spec's "no own API calls" rule was relaxed **for reads only**, at Mike's instruction, so the
panel can see what a side-loaded Claude sees.

**How it reads:**
- Four fixed, named queries, each copied from a proven suite read:
  - `APA_WorkOrder`: `workOrder(workOrderNumber)`, giving client, location, priority, `doNotExceed`
    (the client NTE), `totalNTE` and scope.
  - `APA_ClientProposals`: `listClientProposals(jobId)`. Status is derived from the dates.
    `grossProfitPercent` is a string fraction.
  - `APA_ClientProposal`: `proposal(id)` line items. `tripLabel` comes back like `1`, `2` or `3/4`,
    and `category` is an integer enum.
  - `APA_Trips`: `purchaseOrderTrips(jobId)`.
- One request path, `apaGql`, refuses anything that isn't on that list or isn't a single named
  `query`.
- The token comes from the suite's canonical BWN-SHARED picker.
- Reads happen only while the panel is open with "Work order context" ticked.
- If a read fails, the panel says so; it is never shown as "none".

**Live result:**
- 4 reads, 0 mutations.
- Client NTE $1,500. The vendor total of $7,500 is 5x that, which gives one message with the
  keep-NTE-out-of-prompt advice.
- Client proposal #1 (Submitted 10/5, $12,628.74, 33.5% GP) is flagged.
- **Client proposal #2 is a Draft ($4,708.80, -73.6% GP).** The earlier split is now taken from the
  latest Submitted/Approved proposal and falls back to a draft only if none was sent.

**Trips:**
- The POs record only Trip 1, as completed. The earlier proposal labels its lines 1, 2 and 3/4.
- The plan merges both sources: a trip completed on a PO is Incurred. A trip only the proposal names
  is Proposed and flagged "assumed - check". `3/4` becomes "Trip 3-4".
