# Flora Leaf: from a hard-coded record to Canopy-managed forms, and Leaf as a standalone system

Status: **architecture analysis, nothing changed** · 2026-10-16 · branch `Flora-Form` (after the case form exchange,
`CANOPY-LEAF-FORM-WORKFLOW.md` §10). Every claim below was checked in the code; file:line references are in the two
appendices.

Goals given:
1. Canopy owns the forms: Form Studio designs them, Workflow Studio sends them to Leaf. Today the main Leaf form (the
   anesthesia record) is hard-coded. **How hard is it to make it dynamic?**
2. Leaf is a **standalone system**: it receives forms, staff fill them **offline**, and completed forms sync back to
   Canopy **as reports**.

---

## 1. Today's architecture in one picture

```
CANOPY                                         LEAF (one per OR / bed: own PostgreSQL + API + sync worker + web/Electron)
Form Studio ── publish ──┐                     ┌─ Built-in "Anesthesia record" (FormView.tsx, HARD-CODED)
Workflow Studio ─────────┤ ward exchange       │    14 tabs · ~355 flat keys · case_detail.form_draft_json
                         └──────────────────►  │    read by name in ~13 places (report, PDF, side rail, billing...)
                                               ├─ Workflow forms (Form Studio, DYNAMIC) case_form_record
sync_case_index (snapshot JSON) ◄─ snapshot ── │    (Form Studio renderer; pinned per case; offline vs Canopy)
canopy_case_form → formdev_record ◄─ case-form exchange (per field, receipts, amendments)
Report/AI Studio: Innovian archive only        └─ Report PDF: built in Electron/browser, never sent to Canopy
```

Two form systems already live side by side on Leaf. The dynamic one (workflow forms) already has what goal 1 needs:
delivery, pinned versions, offline from Canopy, per-field sync, receipts and amendments. **Goal 1 is therefore not
"build dynamic forms" but "move the anesthesia record onto the dynamic system without breaking what reads it".**

## 2. Goal 1: how coupled the hard-coded record is

| Part | Size | Why it matters |
|---|---|---|
| The form (`FormView.tsx`) | 3,604 lines, 14 tabs (5 core + 9 optional), **~355 keys** (repeated groups: 4 IV lines, 4 arterial, 4 CVC, a second airway), ~68 option lists, ~11 legacy key spellings migrated on load | All logic is imperative React. This includes: GA type radio, anesthesia type → opens tabs, airway device → clears fields, technique lists stored as JSON strings, completion %, DOB↔age, patient dual-write, 10 s polling merge. |
| Consumers that read keys **by name** | **~13 places, ~150-170 distinct keys** | The biggest are listed below. |
| | Leaf report + PDF: `ReportView` ~71 keys, `ReportDocument` 16, `reportPdf.cjs` ~22 | They mirror FormView's code→label logic. |
| | `LeftRail` case summary: ~90 keys | |
| | `PatientView`: ~30 demographic keys | It stores the patient in the same draft. |
| | `billing.py`: anesthesiaTypes, postoperativeDestination | |
| | `caseData.ts`: 21 keys | Already concept-shaped. |
| Consumers that handle the draft **generically** | sync snapshot, Canopy admission form sync (both ways), Canopy case chart, **public API `GET /cases/{id}/forms`** (external contract), handover | Shape changes ripple to them. The public API is an external contract. |
| Workflow Studio | `anesthesia_record.sections` = the 14 hard-coded tab ids (duplicated in `workflows.py` and `workflowApi.ts`) | Stored workflows refer to built-in section ids. |

**Assessment: high complexity, but wide and shallow, and it can be done in steps.** No single consumer is hard. The
difficulty is the number of them, feature parity of the form, and two data shapes that must live together for a while.

Main risks:
1. **The Leaf report.** About 110 keys across report, document and PDF are read by name, and code→label is copied from FormView.
2. **The draft doubles as patient storage.** PatientView, LeftRail pre-start, ClinicalChart and I/O read demographics from it.
3. **The Canopy admission sync is built for one flat dict per admission.** This covers the tablet pre-op (FormView with `allowedTabs`) and the `preop*` key heuristic.
4. **The public API returns raw draft keys.** Changing them needs a versioned or compatibility output.
5. **Form Studio parity is unverified.** Repeat groups with 4 instances, device-dependent clearing, type-driven tab visibility and completion % need checking against `when`, `repeat`, `calculated`, `clear_when_hidden` and `required`.
6. **Old cases.** Every historic draft (with old key spellings) keeps its shape, and old reports must still print.
7. **Concept gap.** `concepts.ts` has 36 concepts for ~355 keys. Billing, the reports and the Canopy chart need concepts, and some semantics must be settled (e.g. `pacu.destination` ↔ `postoperativeDestination`).

**Existing bug found (reading only, not reproduced):** when a quick start finds a pre-start patient draft,
`LeftRail.tsx:1303` saves it with a **full PUT** right after `startCase`. This replaces the whole draft and drops the
`enabledForms` set by the workflow, along with pre-op values copied from a Canopy admission. Reset in FormView also
PUTs, which wipes Canopy-synced keys.

## 3. Goal 2: how standalone Leaf is today

There are two levels of "offline".

**Level A: the Leaf server is cut off from Canopy.** **Mostly works.**

| Works | Partial | Missing |
|---|---|---|
| Sign-in for local users and for LDAP users who signed in before (cached hash; +~1.5 s while Canopy is down) | Starting a prepared admission (a double start → `conflict` in Canopy) | First sign-in for a new user |
| Starting cases, filling and completing workflow forms with pinned definitions, Form Studio validation on Leaf | Dictation AI fill (needs the AI host, not Canopy) | Handover |
| Billing templates, scores, staff list, terminology, HIS (direct), device data (Gateway) | Catch-up after a long outage (see the gaps below) | HL7 and tablet admissions arriving; Canopy changes (workflows, amendments) |

**Level B: the browser, tablet or Electron client is cut off from its Leaf server.** **Almost nothing works.**
- There is no service worker and no IndexedDB for Leaf case data.
- When `/health` fails, the whole app is replaced by a disabled login screen.
- FormView's localStorage holds only the last copy the server confirmed. Unsaved edits are lost on reload, and workflow-form edits are kept in memory only.
- Electron does not embed a server; it is a client of `127.0.0.1:6893`.
- Form Studio's offline client (IndexedDB + SyncEngine) exists, but only in Canopy.

**"Back to Canopy as reports": not there yet.**
- The anesthesia record reaches Canopy only as JSON inside the case snapshot; it is not a Form Studio record.
- Leaf cases are not in Report Studio or AI Studio, which read the Innovian archive only.
- The Leaf report PDF is built in Electron or the browser and never uploaded. Canopy can only build a "review draft" PDF of its own from the snapshot.

**Gaps that block "standalone" (catch-up after an outage):**
1. **Sync state lives in memory.** The worker's digests, the previous active set and the initial-sync flag are lost on every restart, which then resends everything in one batch.
2. **24-hour windows.**
   - A discharged case edited more than 24 h after discharge is not re-sent.
   - Snapshots carry only the last 24 h of vitals, events and I/O.
   - The case-form and admission outboxes skip cases archived more than 24 h ago. **The case-form part is from the exchange I added; it needs the same fix.**
3. **Size limits.**
   - The case list is capped at 200 while the worker asks for 500.
   - The snapshot batch is all-or-nothing: one failing case blocks every case, and there is a 50 MB / 500-message limit.
   - The case-form and admission outboxes are uncapped while Canopy accepts at most 500 per exchange. Past 500 the exchange fails every time. **The case-form part is mine.**
4. **No version negotiation.** The version is hard-coded to "0.1.0", and only some endpoints fall back on 404.

## 4. Target architecture (recommended)

```
CANOPY: Form Studio + Workflow Studio ──► "ward package" (workflows, pinned forms, styles/fonts, lookups, concepts)
                                              │  ward exchange (versioned)
LEAF SERVER (system of record for its cases, works alone for days)
  ├─ every case form = Form Studio record (anesthesia record included), bound to concepts (bind)
  ├─ durable outbox (DB, not memory): forms, snapshots, files, report PDFs; no 24 h windows; paged batches
  └─ compatibility projection: concepts → old draft keys (reports, public API) during the transition
LEAF CLIENT (browser / Electron)
  ├─ app shell cached (service worker) · IndexedDB queue (Form Studio SyncEngine reused) → works when the Leaf API drops
CANOPY (back as reports)
  ├─ formdev_record per case form (queryable) · amendments with reason
  ├─ the Leaf's final report PDF stored per case (signed copy) + Canopy's own rendering from the same template
  └─ Report Studio / AI Studio dataset "Leaf cases" from concepts (not only the Innovian archive)
```

Principles:
- **Leaf owns its cases. Canopy owns definitions and reporting.** No feature at the bedside may need Canopy online, except first sign-in and handover.
- **One form system.** The anesthesia record becomes Form Studio forms delivered like any workflow form, so Canopy can change it without a Leaf release.
- **Concepts (`bind`) are the contract** between forms and everything that reads them: reports, billing, the Canopy chart, the public API and HIS. No consumer reads form keys by name.
- **Durable, idempotent, resumable sync**, with no in-memory state and no time windows that drop data.

## 5. Plan: phases, size, risk

Sizes are relative (S ≈ days, M ≈ 1-2 weeks, L ≈ 3-5 weeks for one developer who knows the code). They are estimates
from this reading, not commitments.

| Phase | Content | Size | Risk |
|---|---|---|---|
| **0. Make sync safe for standalone** (do first, small, no UX change) | Worker state in the Leaf DB; remove the 24 h windows (re-send by "changed since last ack"); page the outboxes and batches (≤500, size-aware), and isolate a failing case; fix the 200/500 cap; protocol and version handshake; **the LeftRail full-PUT bug** | M | Low |
| **1. Concept layer** | Extend `concepts.ts` and the Python side to cover what reports, billing, the Canopy chart and the public API read (~150 keys → concepts); give every consumer an adapter `concept → value` that reads **today's draft**, so nothing changes visibly | M-L | Low-Med (needs clinical agreement on concepts) |
| **2. Report from concepts / templates** | The Leaf report reads concepts (not keys) or becomes a Form Studio template (print engine already built: density, timeline, logo, barcode); keep the old renderer for old cases | L | Med (the most used printout) |
| **3. Anesthesia record as Form Studio forms, one tab at a time** | Start with preop and checklist (the tablet already shows Form Studio forms next to them), then PACU and outcome, then airway / lines (needs repeat-group parity). Use the existing `optional_sections` / `builtInRecord` switches; write a compatibility projection to the old keys while consumers move | L (5 steps) | Med-High (daily screen; parity) |
| **4. Patient data out of the draft** | Demographics read and written only in `case_his_patient` (concepts `patient.*`); PatientView and LeftRail stop using the draft | M | Med |
| **5. Leaf client offline (level B)** | Service worker for the app shell; mount Form Studio's IndexedDB + SyncEngine for Leaf case forms against a Leaf `formdev`-compatible API; queue view; the health gate opens case views in offline mode | L | Med-High (security of cached PHI on tablets: encryption, session expiry) |
| **6. Back to Canopy as reports** | Upload the final report PDF per case (plus hash and who/when) through the outbox; Report Studio / AI Studio dataset "Leaf cases" from concepts; Canopy case chart shows Form Studio forms with labels; public API v2 by concept | M-L | Low-Med |

Recommended order: **0 → 1 → 2 → 3 (preop/checklist) → 4 → 3 (rest) → 6 → 5.**
- **Phase 0 is needed whatever is decided.** It fixes data that can silently stay on a Leaf.
- **Phases 1-2 make the move safe.** Once reports and billing read concepts, the source of a value (hard-coded or Form Studio) no longer matters.
- **Phase 5** (true client offline) is the most expensive and has a PHI-on-device question. It should follow a decision on how much offline the bedside really needs (is the Leaf server in the same room?).

## 6. Decisions needed before any change

1. **How offline:** is "Leaf server without Canopy" enough (it is the design today: the Leaf server sits in the OR), or must a tablet keep working without the Leaf server too (phase 5, PHI stored on the device)?
2. **Report of record:** is the Leaf-generated PDF the legal record that Canopy must store, or does Canopy re-render from data?
3. **Scope of "dynamic":** the whole anesthesia record, or only sections hospitals customise (pre-op, checklist, PACU), keeping airway/lines (complex, standard) built in?
4. **Concept list and owners:** who signs off clinically on the concept dictionary (names, units, codes such as LOINC/SNOMED)?
5. **Public API:** keep v1 (draft keys) through a compatibility projection, and for how long?
6. **Old cases:** read old drafts with the old renderer forever, or convert once?

## Appendix A: hard-coded record coupling (file:line)

- **The form:**
  - `frontend/src/views/FormView.tsx`: tabs 70-97, keys `defaults()` 359-718, legacy migration 1460-1669, logic 1830-1933, sync 1938-2253.
  - `utils/patientSharedFields.ts`.
- **Report:**
  - `views/ReportView.tsx`: 610-631, 1189-1440, 2250-2290.
  - `views/report/ReportDocument.tsx`: 250-363.
  - `electron/reportPdf.cjs`: 131-149, 1251-1301.
- **Side rail:** `layout/LeftRail.tsx`: 117-173, 587-730, 964; full PUT at 1303.
- **Patient:** `views/PatientView.tsx`: 616, 1059.
- **Other Leaf screens:** `ClinicalChartView.tsx` 460-525 · `InputOutputBalanceView.tsx` 394-405, 2366-2380.
- **Form Studio case data:** `formdev/leaf/caseData.ts` 107-157; `concepts.ts` (36 concepts).
- **Billing:** `services/flora-api/app/billing.py` 160-214.
- **Canopy chart:** `CanopyCaseDetailPanel.tsx` 131-142, 654-745.
- **Public API:** `public_api.py` 222-226.
- **Admission sync:**
  - `canopy_inbox.py` 36, 51-129.
  - `sync_ingest.py` 530-591.
  - `canopy_admissions.py` 219-243.
  - `cases_lifecycle.py` 221-228.
- **Workflow sections:** `workflows.py` 24-42; `workflowApi.ts` 38-41.
- **Storage:** `cases_read.py` 434-450, `clinical_write.py` 55-102, `form_sync.py`.

## Appendix B: standalone evidence (file:line)

- **Deployment:**
  - `flora-leaf/compose.yaml`: services; leaf-web runs `npm ci` on start (:98).
  - `electron/main.cjs` 12, 26-68.
- **Sign-in:** `auth_leaf.py` 429-487; `account_config_sync.py` 15-43.
- **Offline from Canopy:**
  - Workflows cached: `case_workflow.py` 49-88, 196-202.
  - Admission claims: `cases_lifecycle.py` 123-134.
  - Canopy-only services: `ward.py` 157-181 (handover); `main.py` 117-148 (HL7, public API and Form Studio are Canopy-only).
- **Worker:**
  - `sync_worker.py`: in-memory state 22-36; 24 h window 21, 138; vitals window 69-70; all-or-nothing batch 142-171; case-form step 275-324.
  - Case list cap: `cases_read.py` 148 (`min(200, …)`).
  - Canopy limits: `sync_ingest.py` 38, 490-491, 601-602 (500).
- **Case-form outbox windows:** `case_forms.py` 471-473; `case_workflow.py` `RECENT_MS`.
- **Client:**
  - Health gate: `App.tsx` 360-370; `useBootstrapStatus.ts` 39-110.
  - FormView cache: `FormView.tsx` 1938-1945.
  - `WorkflowFormPanel.tsx` (memory only).
  - Form Studio offline: `formdev/offline/SyncEngine.ts`, `data/IndexedDbAdapter.ts`, mounted only in `CanopyFormDevView.tsx` 17.
- **Reports:**
  - Report Studio data: `canopy_reports.py` 56-104 (archive only).
  - PDFs: `legacy_archive.py` 766-790 (Innovian); `CanopyCaseDetailPanel.tsx` 232-262 (review draft).
  - No upload of Leaf PDFs (no `application/pdf` in Leaf routes or the worker).

---

## 7. Phase 0 done (2026-10-16)

| Gap (§3) | Change | Code |
|---|---|---|
| Worker state in memory | `leaf_sync_case` (per case: digest Canopy took, when sent, when checked, last error) and `leaf_sync_state` (settings) in the Leaf DB; the worker asks the Leaf what to send (`GET /api/leaf-sync/cases`) and reports back (`PUT`). A restart resumes; nothing is re-sent that Canopy already has | `0089-leaf-sync-state.sql`, `routes/leaf_sync.py`, `sync_worker.synchronize` |
| 24 h after discharge | Open cases are re-checked in turn (oldest check first, `FLORA_SYNC_IDLE_PER_CYCLE`, default 10 per pass) however old; archived cases are sent once after archiving | `leaf_sync.plan` |
| 200 / 500 list cap | The plan reads `cases` directly (not `/api/case/list`), at most `FLORA_SYNC_PLAN_LIMIT` (100) per pass, most urgent first | `leaf_sync.plan` |
| All-or-nothing batch | A case that cannot be read is recorded (`last_error`) and skipped; messages go in batches of ≤100 / ~8 MB; what went through is recorded even when a later batch fails | `sync_worker.batches`, `synchronize` |
| Case-form outbox: 24 h after archiving, no cap | Archived cases' forms are sent until Canopy has them (no time limit); ≤200 forms per exchange with `more` (worker repeats up to 5×), ≤400 cases; a receipt counts only for the copy it answers (a form changed meanwhile is sent again) | `case_forms.leaf_outbox`, `leaf_inbox` |
| Admissions outbox: 24 h after archiving, no cap | Archived cases are sent until an exchange built after their archiving went through (`admissions.synced_at`); ≤400 cases and claims | `routes/canopy_inbox.py` |
| `CASE_FORMS_ACTIVE` in memory | Kept as `case_forms.active` in `leaf_sync_state` | `sync_worker.synchronize_case_forms` |
| No version handshake | Every batch carries `protocol_version` 2 and `capabilities`; Canopy keeps them in `sync_leaf_node.metadata` and answers with its own | `sync_ingest.py`, `sync_worker.post_batch` |
| LeftRail full PUT after quick start | PATCH of the pre-start patient fields only | `layout/LeftRail.tsx` |
| Snapshots: only the latest 24 h of vitals, events and I/O | A closed case goes whole (up to `FLORA_SYNC_FINAL_HISTORY_DAYS`, 31 days; events up to 5000); an open case keeps the latest 24 h for the live viewer; `window.complete` tells Canopy whether it has the whole case | `sync_worker.build_snapshot` |
| Handshake did not refuse | Canopy refuses a Leaf whose protocol is older than `FLORA_SYNC_MIN_PROTOCOL` (default 1) with 426 and the reason (batch, ward and case-form exchanges), kept in `sync_leaf_node.metadata.protocol_refused`; the worker reports it on the Ward page | `sync_ingest.require_protocol`, `sync_worker.check_refused` |

Phase 1 (concept layer) has its skeleton: `app/concepts.py` is the Canopy twin of `concepts.ts` and `caseData.ts`
(the same 36 concepts, values and sources, checked through `formdev/spec/fixtures/concepts.json` on both sides), with
`DRAFT_KEYS` for where today's record draft keeps each concept. Billing and the public API read concepts, and nothing
visible changed. Still to come: the ~150 keys that reports and the Canopy chart read, and their clinical sign-off (§5,
question 4). See CANOPY-LEAF-FORM-WORKFLOW.md §12.

Tests: `tests/test_leaf_sync.py` (8, PostgreSQL); `scripts/test-leaf-writes.sh` runs 33 (Leaf writes 13, case forms 12,
leaf sync 8).

Deploy notes:
- Run `0089-leaf-sync-state.sql` (and `0088` if not yet) on existing Leaf and Canopy databases.
- **Rebuild the sync worker image.** Its code is copied in at build time, not mounted.

Still open:
- Snapshots carry the last 24 h of vitals, events and I/O. Long stays need history sent in chunks (later phase).
- The handshake records versions but does not yet refuse an incompatible Leaf.
- FormView's Reset still replaces the whole draft. This is deliberate: it is the user's "clear the form" action.
