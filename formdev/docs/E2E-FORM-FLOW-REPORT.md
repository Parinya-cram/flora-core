# Form flow end-to-end test report (Canopy ↔ Workflow Studio ↔ Flora Leaf)

Date 2026-10-16 · branch `Flora-Form` (uncommitted work: case form exchange, phase 0, this test round) · **result: all
passing after 4 fixes found by the tests (§5).**

The loop under test: a form designed in Canopy (Form Studio) → sent by Workflow Studio → filled on Flora Leaf → back to
Canopy as a record → changed in Canopy (amendment) → back on the Leaf → printed. The aim was also that both systems
"speak the same form format" with no restriction: every field type, every rule, the same answer on both sides.

## 1. How it was tested

| Layer | What | How to run |
|---|---|---|
| A. Whole loop on real servers | Leaf API, Canopy sync API and Canopy API, each in its own mode, **on two separate databases (Leaf and Canopy, as in production)**, driven over HTTP; the **real sync worker code** (`sync_worker.py`) moves data between them | `scripts/test-form-flow.sh` → `services/flora-api/tests/e2e_form_flow.py` (step report JSON) |
| B. Same form format on both sides | A form with **all 23 field types** (`formdev/examples/e2e-kitchen-sink`) and 15 record cases: Canopy's Python rules and the Leaf's TypeScript rules must give **the same issues**; every type renders and prints | `tests/formdev/test_kitchen_sink.py` (Python) · `frontend/tests/formdev/kitchenSink.test.ts` (TS) · cases from `formdev/scripts/build_kitchen_sink_cases.py` |
| C. Real screens on the dev stack | Leaf UI → Canopy Form Studio UI → Leaf UI, with the running worker | Browser on `localhost:6890` (Leaf) and `localhost:6894` (Canopy) |
| D. Regression | Everything else | `scripts/test-leaf-writes.sh` (33) · Form Studio Python (479) · frontend vitest (766), tsc, eslint, build |

The kitchen-sink form uses every type:
- Values: text, textarea, number, decimal, integer, date, datetime, time, select, radio, multiselect, checkbox, switch, file, image, signature and calculated.
- Containers: group, repeat and matrix.
- Leaf data: timeline.
- Print-only: logo and barcode.

It also has:
- conditions (show / hide, required when shown, cleared when hidden);
- "Other" inputs with required text;
- a pattern rule;
- a repeat limit;
- a matrix total;
- a calculation (BMI);
- a compact paper setting;
- a footer;
- a Leaf placement hint.

## 2. Layer A: the loop on real servers (18 steps, all passing, about 5 s)

| # | Step | Checked |
|---|---|---|
| 1 | Leaf registers with Canopy | Handshake protocol 2 stored. Ward → room → bed → Leaf. |
| 2 | Sign in on Canopy and on the Leaf | Separate users in the two databases. |
| 3 | Form Studio: create and publish the 23-type form | Workflow Studio offers it with its suggested placement (intraop, after PACU). |
| 4 | Workflow Studio: workflow with the form as a required tab after PACU; publish; ward default | |
| 5 | Canopy admission with the workflow preset; form filled on the ward tablet before the case | Copy keyed `admission:<id>`, record stored. |
| 6 | Ward exchange | Workflow and pinned form reach the Leaf (default ✓); the admission is offered. |
| 7 | Leaf starts the case from the admission with the workflow | |
| 8 | The tablet's form becomes the case's form on the Leaf | Values and the author (via Canopy) arrive. |
| 9 | Every field filled on the Leaf; the file stored on the Leaf | Complete without consent → **422** with the issue; with consent → completed. |
| 10 | Back to Canopy | Receipt "stored, current" on the Leaf. **Submitted** Form Studio record with every value (repeat, matrix, timeline, signature, Other texts…). BMI 24.0 computed by Canopy. Author `user@leaf`. **The file travelled to Canopy's store** (separate databases). |
| 11 | Canopy amendment | Without a reason → refused (`amendment_reason_required`). With a reason → applied and recorded (only the changed field). |
| 12 | The amendment reaches the Leaf | Who / when / why travel with it; the Leaf's completion stands. Once confirmed it is not sent again. |
| 13 | Leaf Reports | The form is offered to print with the case's data. |
| 14 | **Canopy down** | The Leaf keeps saving and the receipt shows "not current". The worker fails all three steps (ConnectError). Canopy back → caught up in one pass, value in Canopy. |
| 15 | Worker restart | State is read from the Leaf DB; no full re-send. |
| 16 | Discharge and archive | Canopy gets the archived case once. The form is read-only (409). Nothing is re-sent afterwards. |
| 17 | Workflow attached to a case already open | Form filled and stored in Canopy; the attach is audited. |
| 18 | Final state | Every case form stored in Form Studio; nothing pending either way. |

## 3. Layer B: the same answer on both sides

| Case | Issues (identical in Python and TypeScript) |
|---|---|
| complete record | none |
| required fields missing | hn, full_name, assessed_at, consent: `required` |
| a draft may leave required fields empty | none |
| fever: temperature required | temperature_c `required` |
| temperature out of range | `out_of_range` |
| **no fever: the hidden temperature is not required** | none |
| phone pattern | `pattern_mismatch` |
| repeat: a required child missing | lines[0].site `required` |
| repeat: too many items | lines `too_many_items` |
| matrix cell out of range | aldrete.activity.admit `out_of_range` |
| Other chosen without its text | symptoms `other_text_required` |
| wrong value types | age `invalid_type`, has_fever `invalid_type`, weight_kg `out_of_range` |
| an option not offered | sex, symptoms `invalid_option` |
| unknown field | `unknown_field` |
| timeline value off its axis | `unknown_field` |

Also checked:
- **The BMI calculation is the same.**
- **All 23 types render in the Leaf's renderer.** The condition-hidden field is correctly not shown.
- **The A4 print has the logo, the barcode bars and the repeat's rows.**

The Python test checks the same cases from Canopy's side, so a rule change on either side that breaks the agreement fails a test.

## 4. Layer C: the real screens (dev stack)

1. **Leaf, Forms:** "Change workflow" → "E2E flow (test)".
   - The tab appears right after "Recovery / PACU", marked required (*).
   - The patient fields stay filled.
2. **Leaf:** HN and name typed.
   - "Waiting to send to Canopy" → **"Saved in Canopy" in about 12 s**.
3. **Canopy, Form Studio → Records:**
   - The row shows **"Leaf · D-HL7-001"**.
   - Opening it shows the **Flora Leaf panel**: HN, Leaf, "still being filled on the Leaf", Form Studio: stored.
   - The barcode now prints from the HN.
4. **Canopy:** name edited.
   - "Save amendment" stays disabled until a reason is typed.
   - Saved → queue 0 pending / 0 failed.
   - The database holds the amendment `{full_name: from → to}`, the reason and the user.
5. **Leaf:** the form shows **"Changed in Canopy"** with the field, who, when and the reason. The badge still reads "Saved in Canopy".
6. **Leaf, "Mark complete":** only the two truly missing fields are flagged (assessed at, consent). The hidden temperature is not.

## 5. Problems the tests found, and the fixes

| # | Problem | Effect | Fix |
|---|---|---|---|
| 1 | **The Leaf's completion check used simplified rules** (`validateRecord`: types and required only), unlike the server and Canopy (`evaluate_record`) | A field hidden by its condition blocked "Complete" (e.g. temperature when there is no fever). Pattern, Other-text and similar issues only appeared after a server round trip. | The Leaf uses `evaluateRecord`, the TypeScript twin of the server rules (`WorkflowFormPanel.tsx`). A test case was added. |
| 2 | **A Canopy amendment counted derived values as the reviewer's changes** | Changing "notes" also recorded "bmi null → 24" under the reviewer's name and sent it to the Leaf | Only the fields the user changed form the amendment. Calculations are derived where they are stored (`case_forms.amend`). The e2e test now checks that the amendment holds only "notes". |
| 3 | "Save failed: 2 field(s) need attention…" when a form is not complete yet | Looked like data was lost; it was not | Separate "incomplete" state, shown in amber without "Save failed". |
| 4 | Test realism: with one shared database the Leaf's file was already "in Canopy" | File transfer was not really tested | The flow now runs on two databases. The worker uploads the file (`need_files`), and the test checks it lands in Canopy's store. |

Earlier in this round (phase 0 deploy): the sync worker image had to be rebuilt; its code is not mounted. That is done.

## 6. Left on the dev stack

- **Form Studio:** form `e2e_kitchen_sink` v1, published.
- **Workflow:** `e2e_flow` "E2E flow (test)". It is published, offered in the Perioperative unit, and **not** the ward's default.
- **Open case 1 (HN D-HL7-001):** its workflow is now "E2E flow (test)". Its E2E form has HN and name, plus one amendment (name corrected, with reason) and the matching Form Studio record.
- **The temporary Canopy test account `e2e_ui_tester`** was created for the UI test and **deleted** afterwards.
- **The disposable test databases** were dropped.

To undo: switch case 1 back to "Test" on the Leaf Forms page (the filled E2E form stays on the case, as designed), then archive the `e2e_flow` workflow in Workflow Studio.

## 7. Not covered / still open

- Handover between two Leafs: unit-tested (`test_case_forms.py`), not in the live loop, because it needs two Leaf servers.
- Printing to PDF in the browser: covered by the layout tests, not by a print run.
- Lookups and role permissions on the Leaf (planned, phase F).
- ~~Repeatable forms~~, ~~vitals history older than 24 h in snapshots~~ and ~~rejecting incompatible Leaf versions~~:
  done in the second round (CANOPY-LEAF-FORM-WORKFLOW.md §12). The test from that round passes: 18 steps, with the new
  worker.
