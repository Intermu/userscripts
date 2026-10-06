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
- **The `ai-preview` URL with the vendor quoteId shows "No data available".** The AI preview id is
  not the vendor quoteId. Cross-page context is now keyed on the WO number, which is in both URLs.

## Inferred (verify live)

1. **Response field name.** The script reads `data.<first field>` and doesn't hard-code
   `generateAIProposalPreview`.
2. **Rework response shape.** Assumed to be the same `{success, message, preview}` envelope. If
   `preview` is missing, the script falls back to `result`, and then to the payload itself when it
   has `lineItems`.
3. **Where `validationErrors` lives.** The script collects it from any depth (payload,
   `errors[].extensions`), plus `errors[].message` and a `success:false` `message`.
4. **`unitCharge` format.** Assumed to be a bare number in cents. A `{amount, precision}` object is
   also accepted.
5. **`markUpPercent` units.** Assumed to be a whole percent (35, not 0.35).
6. **Transport.** Apollo is assumed to use `fetch`. XHR is tapped too, as a backup. A `Request`
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
