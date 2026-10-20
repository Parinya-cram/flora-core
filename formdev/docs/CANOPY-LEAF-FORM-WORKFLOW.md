# Canopy forms on Flora Leaf: operational workflow, gaps and standards check

Status: **analysis 2026-10-16; phases A and B implemented (§10)** · code at `Flora-Form` / `main` `bb9a3a5`, live dev stack checked
Builds on `INTEGRATION-ANALYSIS.md` (2026-10-14). None of its problems P1–P14 has been fixed since; this document
re-verifies them and adds what that analysis did not cover: why a form does not appear on Leaf, the invocation
variables, the response lifecycle, review in Canopy, and print / page sizes against medical-record practice.

Goal: a form designed in Canopy appears on Leaf where the clinician needs it, is filled there, and **every response
comes back to Canopy complete, attributable and reviewable**, and every printed copy meets medical-record rules.

---

## 1. The workflow end to end (what exists today)

```
CANOPY                                                         FLORA LEAF (one per OR / bed)
1 Form Studio      design → validate → publish version N (immutable)
2 Workflow Studio  workflow = forms[] (form_id@version + variables §3)
                   publish → assign to ward (canopy_workflow_unit, default?)
3 Delivery         ──── sync worker pulls /api/sync/v1/ward every 10 s ───► leaf_workflow_state (1 JSON row)
4                                                              Case start: picker (admission preset > ward default
                                                               > first) → cases.workflow snapshot, forms pinned
5                                                              Forms page: a tab per form with display "tab",
                                                               after its after_section; autosave; "Complete"
6                                                              Reports page: forms with display "report" filled
                                                               from case data (bind) → preview / print / PDF
7 Return           ◄─── case_snapshot (whole case) ─────────── case_form_record (case_id, form_id): draft|completed
                   ingest_workflow_forms → formdev_record (record_id = <global_case_id>-<form_id>)
8 Review           Form Studio → Records sheet of that form (the only screen showing Leaf responses)
```

## 2. Why a Canopy form does not show on Leaf (checked live on the dev stack)

| # | Cause | Evidence |
|---|---|---|
| W1 | **A workflow is attached only when the case starts.** No route attaches or changes a workflow on an open case. The open case (id 1, HN D-HL7-001) started 2026-10-14 before workflow "Test" was assigned to the ward, so `cases.workflow` is NULL and the case shows no workflow forms. | `case_workflow.py:110-147` (resolve/apply_on_start only), `cases_lifecycle.py:122,138-139,243` |
| W2 | **"Test" is not the ward's default** (`is_default=false`). A new case gets it only if the user picks it on the start screen; the emergency start path uses the default only. | `canopy_workflow_unit`, `leafWorkflows.ts:18-20`, `IdleCaseLanding.tsx:466` |
| W3 | **Its only form is `display: "report"`**, i.e. print-only: it never gets a data-entry tab, by design. | `caseWorkflow.ts:27` |
| W4 | Delivery itself works: `leaf_workflow_state` holds the workflow and `form_20261014_ns1@1`. Note the delivered v1 is titled "New form" (the workflow entry says "Test Form"); the tab uses the workflow title. | live query |

Result on the dev stack: `case_form_record` and `formdev_record` are both empty. The return path (step 7) has
never run here, so it is untested end to end.

## 3. Variables that decide whether, where and how a form appears

| Variable | Values | Checked in | Effect today |
|---|---|---|---|
| Leaf → ward `canopy_leaf_unit.unit_key` | ward key | `directory.py:331` | which workflows this Leaf receives |
| `canopy_workflow_unit (workflow_id, unit_key, sort_order, is_default)` | ≤ 1 default per ward | SQL `0070:27-36`, `routes/workflows.py:207-231` | list, order, default |
| `canopy_workflow.status` + `published_definition` | draft / published / archived | SQL `0070:17-18` | only published, not archived, is delivered |
| `StartCase.workflow_id` | id ≤ 64 | `cases_lifecycle.py:50`; unknown → 409 | explicit choice at start |
| `admission.workflow_id` (Canopy admission) | id | unknown → ignored | preset when no explicit choice |
| `cases.workflow` (+ `bundled_forms`) | snapshot | `case_workflow.py:48-70,125` | pins form versions for the life of the case |
| `anesthesia_record.enabled / sections` | section ids | `workflows.py:25-42` | built-in tabs; off → workflow forms only |
| `forms[].form_id`, `forms[].version` | published form@version | `workflows.py:161-178` | which definition; stored as `form_version` |
| `forms[].display` | `tab` \| `report` | `workflows.py:48,171`; `workflowApi.ts` | data-entry tab, or print-only on Reports |
| `forms[].after_section` | built-in section id or none | `workflows.py:169` | tab position |
| `forms[].phase` | preop / intraop / postop / any | `workflows.py:43,167` | **tooltip only, no gating** |
| `forms[].required` | bool | `workflows.py:70` | **red asterisk only, not enforced** at discharge/archive |
| `forms[].hint` | ≤ 300 chars | `workflows.py:45,173` | note above the form |
| `packet[]` | anesthesia_report(mode) / form | `workflows.py:179-195` | packet order; **`mode` ignored** (P10) |
| field `bind` | `domain.name` | `definition.py:98` | **print only** (Reports), not data-entry prefill |
| `permission` (form/section/category) | roles | `definition.py:80-84` | **not applied on Leaf** (no roles passed, no server check) |
| `paper`, style | §6 | | print / PDF only |

## 4. Response handling (filling on Leaf → Canopy)

**Lifecycle on Leaf** (`case_form_record`, one row per form per case):
- **States.** Only `draft` and `completed`; there is no signed, amended or entered-in-error state. A user can untick back to draft and edit freely, including after discharge. Only archiving locks a case (`case_workflow.py:277`).
- **Attribution.** `updated_by` holds a username and `updated_at` a timestamp. There is no created-by/at and no completed-by/at.
  - Every PATCH writes a full before/after row to `case_clinical_audit` (`case_workflow.py:295`), but nothing reads it.
- **Signature field.** It stores the drawn image and `signed_at`. `signer` is never filled from the logged-in user, there is no credential check, and nothing locks after signing.
- **Repeat use.** The primary key `(case_id, form_id)` allows a single instance per case, so a form cannot be repeated (for example a second PACU assessment).

**Return to Canopy, re-verified:**

| # | Problem | Status |
|---|---|---|
| P1 | Handover to another Leaf: `case_form_record` is not copied (`case_handover.py:17-21`). The new case gets the workflow but empty forms, and Canopy creates a second record under a new `global_case_id`. | open |
| P2 | File/image fields on Leaf exist only in browser memory (no `AttachmentContext`). Canopy then rejects the whole record because the attachment is missing (`repositories.py:393`). **Signatures are not affected** (stored inline). | open |
| P3 | Leaf server does not validate. The browser checks only types and required fields on "Complete". Canopy validates fully and either stores the record as a draft or **drops it with only a log line** (`workflows.py:330`). `evaluate_record` can also rewrite values, so Canopy's copy may differ from Leaf's. | open |
| P4 | Leaf `field_versions` are never sent. Canopy keeps or replaces the whole record by `updated_at`. **If anyone edits the record in Canopy's Records sheet, later Leaf edits are silently ignored.** | open |
| P5 | The return is a whole-case snapshot with no per-form receipt. Leaf never learns whether Canopy accepted a form. Retries happen about once a minute while the case is active, but not after discharge until data changes; cases older than 24 h are sent only after a worker restart. | open |
| P6 | `subject_id` is set by direct SQL, bypassing revision/versioning (`workflows.py:326`). | open |
| P7 | Data entry starts empty: HN, name, weight, ASA are retyped. `fillFromCase` exists but is used only for printing. | open |
| P8 | Lookups and role permissions do not work on Leaf. | open |
| — | Canopy records the author as `leaf:<leaf_id>`, not the clinician (`workflows.py:289`; the snapshot drops `updated_by`). | new |
| — | One Canopy revision per ingest: edits between syncs collapse into one, and the revisions API has no UI. | new |

## 5. Review in Canopy (the end of the workflow)

| Need | Today |
|---|---|
| See all forms of one case / patient | **Missing.** The Canopy case chart shows only built-in and Innovian forms; `snapshot.workflow_forms` is stored but no screen reads it. |
| Find a response | Only in Form Studio → Records, per form. Rows have no HN, patient, case, ward or Leaf column; the id is `<global_case_id>-<form_id>`. |
| Review / approve / sign off | **Missing.** Record states are draft / submitted / deleted. ("reviewed" exists only for AI *templates*.) |
| History of changes | API only (`formdev.py:319`), no UI; edits between syncs collapsed. |
| Edit safely | The Records sheet edits Leaf data inline with no reason or amendment, and that silently blocks later Leaf edits (P4). |
| Report on responses | Report Studio / AI Studio read the Innovian archive only (P9). |

## 6. Printing and page sizes

| Output | Sizes | Per-page patient ID | Page n/N | Printed date-time / by | Signature lines |
|---|---|---|---|---|---|
| Form Studio PDF / print | A4, A5, Letter (portrait/landscape), margins 0-60 mm; `screen` falls back to A4 | **Only if the author adds a `repeat_on_pages` header** (no template does); band tokens have no `{hn}`/`{name}` | PDF default yes; HTML print only if configured | date only; no time, no user | only signature fields the author adds |
| Leaf anesthesia report (Electron PDF / browser) | **A4 portrait only**, margins ≈ 6-7 mm | yes: name, HN, AN, age, barcode | yes | **none** | **none** |
| Case packet | each part keeps its own size | per part | **per part, not packet-wide** | — | — |
| Billing sheet | A4, 10 mm | page 1 only | none | yes | yes |
| Canopy Report Studio | no print (CSV/XLSX) | — | — | — | — |

Further findings:
- **Barcode minimum not enforced.** `pdfLayout.ts:269` clamps the module width so that it never goes *up* to 0.19 mm. A long value in a narrow cell prints bars too thin to scan reliably.
- ~~**Fit scale below the documented floor.**~~ Resolved: 0.74 is intended (tested; type stays ≥ 5.5 pt); the comments were corrected.
- **Fonts.** A style's paper size and font are ignored by the PDF, which always uses Noto Sans Thai. Outside Windows, the Leaf PDF cannot draw Thai and falls back to English names.
- **Leaf report gaps.** No date of birth (age only). The hospital name and logo are hard-coded to King Chulalongkorn Memorial Hospital for every edition except EforL.
- **Browser print overflow.** The browser report uses `min-height: 281mm`, so an overfull page spills onto an extra sheet and its "Page n/N" becomes wrong.

## 7. Medical-standards check

The rules below are the common requirements of the references named. **The hospital's medical-records committee
must confirm which apply and at what level** (e.g. HA accreditation surveyors, สปสช. medical-record audit).

| Requirement | Reference | Status |
|---|---|---|
| ≥ 2 patient identifiers (name + HN, ± DOB) on **every page** of a record | JCI IPSG.1; Thai Patient Safety Goals (SIMPLE / 2P Safety, *Patient identification*); สปสช. Medical Record Audit Guideline | Leaf report ✓ (no DOB) · Form Studio ✗ by default · Billing ✗ after page 1 |
| Every entry attributable: who, when (date **and time**), signature of the recorder | HA Thailand medical-record standard; Medical Record Audit Guideline; ALCOA+ | ✗ Canopy shows `leaf:<id>`; signature not bound to user; no completed-by/at |
| Corrections keep the original, with reason, who, when (no silent overwrite) | ALCOA+; HA; FHIR status `amended` | ✗ free edit after complete; Canopy inline edit; collapsed revisions; no UI |
| Audit trail readable by authorised reviewers | HA; PDPA B.E. 2562 (health data is sensitive) | partial: `case_clinical_audit` written, never shown |
| Electronic signature reliably linked to the signer | Electronic Transactions Act B.E. 2544 (s. 26) | ✗ drawn image only |
| No silent data loss between systems | data integrity (ALCOA+ "complete") | ✗ P1, P2, P3 (dropped with a log line), P4 |
| Access by role; minimum necessary | PDPA; HA | ✗ form permissions not applied on Leaf |
| Printed copy: page n of N, print date-time and who printed, document id/version | Medical Record Audit Guideline; document control practice | partial (see §6) |
| Standard paper: ISO 216 A4 for records; A5 only for small slips | ISO 216; Thai practice | ✓ A4 default; Letter allowed in Form Studio (non-standard in Thailand) |
| Scannable barcode on the HN label | ISO/IEC 15417 (Code 128), ISO/IEC 15416 print quality | ✗ minimum module not enforced; Leaf's own HnBarcode drops letters |
| Response statuses interoperable with HIS | HL7 FHIR R4 QuestionnaireResponse (in-progress, completed, amended, entered-in-error, stopped) | partial: draft/completed ↔ draft/submitted only |

## 8. Proposed plan (each phase usable on its own)

| Phase | What | Fixes |
|---|---|---|
| **A. Forms appear where needed** | Attach or change a workflow on an **open** case (pinned, audited, admin or charge-nurse permission). Prompt to choose a ward default. On the Leaf Forms page, list the case's forms with status (not started / draft / completed / sent to Canopy). Honour `required` (warn at discharge, configurable block). | W1-W3, `required` |
| **B. No silent data loss** | Copy `case_form_record` on handover and keep one `global_case_id`. Upload Leaf attachments. Validate on Leaf with the same `evaluate_record` and show issues before Complete. Send `field_versions` + `updated_by` and merge per field. Add a per-form receipt (accepted / rejected + reason) shown on Leaf. Remove the `subject_id` SQL. | P1-P6 |
| **C. Review in Canopy** | Case-centric "Forms" panel in the Canopy case chart (all workflow forms of the case, HN/name/ward/Leaf/clinician). Records sheet gains HN / case columns. Add review states (reviewed / approved) and a revision-history view. Canopy edits become amendments with a reason, never silent overwrites. | §5 |
| **D. Lifecycle & signature** | created/completed-by/at; amend-after-complete with reason (FHIR `amended`); `entered-in-error`. Signature filled from the logged-in user, re-authenticated by PIN, locks the form. Repeatable forms (instance number). | §4, §7 |
| **E. Print standard** | Default running header on every page for every form (logo, hospital, name, HN, AN, DOB/age, form id + version) via new tokens `{hn} {name} {dob} {an}`. Footer: page n/N, printed date-time + printed by. Packet: one size (A4) and packet-wide numbering. Add DOB, printed-by and signature lines to the Leaf report, and configurable hospital name/logo. Enforce the barcode minimum (or switch symbology / warn). FIT floor 0.8. | §6 |
| **F. Prefill & permissions on Leaf** | Data entry fills from `bind` (the print logic already exists). Pass roles and lookups to the Leaf renderer and check permissions on the server. | P7, P8 |

Recommended order: **A → B → C → E → D → F**. A and B are what make "a Canopy form, filled on Leaf, reviewable in
Canopy" true. C closes the loop. E and D are what the medical-record audit checks on paper and in the system.

## 9. Decisions needed before implementation

1. **Can a workflow be attached or changed on an open case, and by whom?** Recommendation: yes, with an audit entry; forms already started keep their version.
2. **Should Canopy ever edit Leaf responses?** Recommendation: no direct edit. Use an amendment with a reason, sent back to Leaf, or make Canopy read-only.
3. **Do `required` forms block discharge or only warn?**
4. **Who reviews in Canopy, and what are the states?** For example, submitted → reviewed → approved.
5. **What is the e-signature level?** A drawn image plus PIN re-authentication is the suggested minimum; a certificate-based signature is out of scope.
6. **Allowed paper sizes.** A4 for records, A5 for slips; drop Letter?
7. **Default per-page header.** Which identifiers (name + HN + DOB/age + AN), and the hospital name/logo for each site.

---

## 10. Implemented: phases A and B (decisions: two-way per field · attach on open case, audited · Canopy edits are amendments with a reason)

```
LEAF                                    sync worker (step case_forms, every 10 s)            CANOPY
case_form_record                        GET  /api/case/workflow-forms-sync/outbox            canopy_case_form (one copy per case form,
 data + field_versions + field_authors   POST /api/sync/v1/case-forms ───────────────────►   merged per field, newest wins)
 + receipt (sync_state, sync_issues)     ◄── receipts, inbound (Canopy changes), need_files    ├─ formdev_record (Form Studio)
                                        PUT  /api/case/workflow-forms-sync/inbox  (acks next)   ├─ canopy_case_form_amendment
files: formdev_attachment on the Leaf   need_files: Leaf → PUT /api/sync/v1/case-forms/files    └─ admission forms ('admission:<id>')
```

| Problem / need | What was done | Code |
|---|---|---|
| W1 workflow only at start | `PUT /api/case/{id}/workflow` attaches or changes the workflow of an open case (audit `workflow.attach`); forms already filled keep their version and stay on the case; Leaf Forms page shows "no workflow → Attach" and "Change workflow" | `routes/case_workflow.py` `attach_workflow`, `CaseWorkflowControl.tsx` |
| W2 no default | Workflow Studio warns about wards with workflows but no default | `WorkflowStudioView.tsx` |
| Form status on Leaf | Tab marks (● started, ✓ completed, ↑ not yet in Canopy, ⚠ Canopy reported a problem); receipt badge and issues on the form | `caseWorkflow.ts`, `WorkflowFormPanel.tsx`, `FormView.tsx` |
| `required` | Listed in the discharge dialog when not completed (reminder; discharge stays possible) | `RequiredFormsNotice.tsx` |
| P1 handover | `case_form_record` exported / imported; the new Leaf sends under `handover_global_case_id` (same Canopy copy and record) | `case_handover.py`, `case_forms.leaf_outbox` |
| P2 files | File / image fields store the file on the Leaf (`PUT /api/case/{id}/workflow-forms-files/{sha}`); Canopy asks for missing ones (`need_files`), state `waiting_files` until they arrive | `WorkflowFormPanel.tsx` `leafAttachments`, `sync_ingest.put_case_form_file` |
| P3 validation | Completing a form runs Form Studio's rules on the Leaf (`evaluate_record` + files) → 422 with the issues; Canopy's result comes back as a receipt (stored / kept as draft / not stored + issues), never only a log line | `case_forms.leaf_issues`, `project` |
| P4 merge | Both copies carry per-field versions and authors; merge per field both ways; status has its own version (`__status`) | `case_forms.merge` |
| P5 receipts / retries | Digest per copy; the Leaf resends until Canopy acknowledges that exact copy; Canopy resends its changes until the Leaf acks them | `leaf_outbox` / `leaf_inbox` / `exchange` |
| P6 subject SQL | Not used for these records any more (the old snapshot ingest runs only for Leafs without the exchange: `case_forms_channel`) | `sync_ingest.py` |
| Attribution | Each field: `{by, at, via, leaf_id?, reason?}`; Form Studio records are written as `user@leaf` | `case_forms.stamp`, `project` |
| Canopy → Leaf data | (a) Form Studio edits of a Leaf record are amendments: the server refuses them without a reason (`amendment_reason_required`), applies only the fields the user changed (never older values), records them in `canopy_case_form_amendment` and sends them to the Leaf; completing / deleting stays on the Leaf. (b) Admission forms: filled on the ward tablet for a Canopy admission, they become the case's forms when it starts on a Leaf; changing a field filled at the bedside afterwards needs a reason | `case_forms.amend`, `formdev/sync.py` hook, `LeafLinkPanel.tsx`, `RecordsSheet.tsx`, `AdmissionWorkflowForms.tsx`, `routes/canopy_admissions.py` |
| Live updates on Leaf | The case's forms are re-read every 15 s; changes from Canopy appear in the open form without overwriting what is being typed, with "Changed in Canopy" (who, when, reason) | `useCaseWorkflow`, `WorkflowFormPanel.tsx` |

Found while testing: on the Forms page AN / DOB / age / weight / height / blood group (filled from the patient record) went
blank when the saved draft loaded after the patient record (a race that a newer draft exposes, e.g. after attaching a
workflow). A draft that does not hold these fields no longer clears them (`FormView.tsx` `applyServerDraft`).

Migration `infrastructure/postgres/0088-case-form-exchange.sql` (both databases; existing ones: run it with psql, it is
idempotent). Tests: `services/flora-api/tests/test_case_forms.py` (12, PostgreSQL, via `scripts/test-leaf-writes.sh`),
`tests/test_case_forms_merge.py` (5).

Still open (phases C-F): a case-centric review view and review states in Canopy, the print standard (§6), signatures bound
to the user, prefill by `bind`, lookups / roles on the Leaf, repeatable forms, and the barcode minimum module (§6).

## 11. Added after the end-to-end test round (2026-10-16)

| Area | Change | Code |
|---|---|---|
| Deploy | `deploy.sh` rebuilds when the sync worker or live agent changes; their code is copied into the image, so a pull alone left the old code running | `scripts/server/deploy.sh` |
| D. Amend on the Leaf | A completed form is read-only on the Leaf. **Amend** asks for a reason once; every change (or reopening it as a draft) carries it. The server refuses a change without a reason (`amendment_reason_required`). Each changed field keeps the reason, and the case audit records `workflow_form.amend`. Canopy shows these as "Amended on the Leaf". | `routes/case_workflow.py`, `WorkflowFormPanel.tsx`, `LeafLinkPanel.tsx` |
| C. Review in Canopy | The Canopy case page → Forms lists the case's Workflow Studio forms, read-only with field labels. It shows: the status on the Leaf; the Form Studio receipt and its issues; who filled the form; and every amendment (Canopy and Leaf) with its reason. It includes forms carried over by a handover. | `GET /api/fleet/cases/{id}/forms` (`fleet_read.py`), `CaseFormsReview.tsx` |
| E. Patient on every page | Band tokens `{hn} {an} {patient} {dob} {printed_at} {printed_by}` work in both validators (fixtures regenerated, 145 cases). Values come from the form's fields (bind or usual names) and its subject field. A form without a footer prints a default one on **every page**, in the PDF and the HTML print: HN · name · DOB · AN on the left; "Printed date-time · who" and page n/N on the right. | `core/layout.ts` (`printContext`, `defaultFooter`), `pdfLayout.ts`, `FormPrint.tsx`, callers pass who prints |
| E. Barcode | Bars are never thinner than 0.19 mm. A value too long for its cell prints as text with "too narrow to scan, widen the field" instead of unscannable bars. | `pdfLayout.ts` `printedBlock` |
| E. Fit scale | 0.74 is intended (tested; type ≥ 5.5 pt); the comments were corrected | `pdfLayout.ts`, `definition.py` |

Checked on the dev stack: the Test Form printed from Leaf Reports for HN D-HL7-001 carries, on every page,
"HN D-HL7-001 · name · DOB 12/04/2511 · AN D-AN-260091 … Printed 16/10/2569 16:55 · admin · n/11".

Still open from §8: review states (reviewed / approved) and a revision-history view, signatures bound to the user, repeatable forms, prefill by
`bind` and lookups / roles on the Leaf, one paper size and numbering across a case packet, and the Leaf anesthesia
report's own gaps (DOB, printed by, signature lines, hard-coded hospital logo).
(All but lookups / roles on the Leaf are done in §12.)

## 12. Second round: review, signatures, printing, repeatable forms (2026-10-16)

Decisions: review is **Reviewed → Approved**; a signature is **drawn, confirmed with the signer's PIN, then locked**;
the hospital's name and logo are **set in Canopy and sent to every Leaf**. Migrations `0090-form-review-signing-hospital.sql`
and `0091-repeatable-case-forms.sql` (apply to an existing database with `scripts/apply-migrations.sh`, below).

| Area | Change | Code |
|---|---|---|
| Review in Canopy | **Mark reviewed** (`form.review`: clinician, clinical admin, system admin) then **Approve** (`form.approve`: clinical admin, system admin), each with an optional note. A state holds for the copy it was given to: any later change (Leaf or amendment) shows **Changed since review** until it is reviewed again. **History** lists every Form Studio version with its changes, every amendment with its reason and every review action. | `case_forms.review`, `history`; `POST /api/fleet/cases/{id}/forms/{form}/review`, `GET …/history`; `CaseFormsReview.tsx` |
| Signatures | A signature field shows the drawing and **Sign with PIN**. The PIN (4-8 digits, salted scrypt) is set under Account on the Leaf or in Canopy and travels with the user directory, so it works on every Leaf of the ward. The server stores `{data, signed_at, signer, signer_name, verified: "pin"}`; a value claiming `verified` that did not come through the PIN route is refused (`sign_with_pin`). Five wrong PINs in 15 minutes lock signing for that user (429); a refusal is audited (`sign_refused`). A signed field is locked: Canopy cannot amend it (`signature_locked`); on the Leaf re-signing a completed form needs a reason. | `POST /api/case/{id}/workflow-forms/{form}/sign`, `PUT /api/auth/self/sign-pin` (Leaf and Canopy); `directory.set_sign_pin`; `signing.ts`, `fieldInputs.tsx` `SignatureInput` |
| Prefill by concept | When a form opens on the Leaf, empty fields no one has filled are filled from the case (by `bind`, or by the usual field names of `concepts.ts`) and saved as this user's entries, listed under "Filled from the case (please check)". A field someone cleared stays empty. **Fixed during the live check:** the fill was dropped when the case or form object changed while the case data loaded (status polling), so it never happened on the dev stack; it is now dropped only when the panel unmounts. | `WorkflowFormPanel.tsx`, `caseData.ts` |
| Case packet | Every sheet is A4: a page of another size (A5, Letter) is scaled onto A4, keeping its orientation; forms are filled from the case as on Reports; "Case packet n/N" at the foot of every sheet (each part keeps its own page numbers). Copies of a repeatable form print after the form. | `casePacket.ts` |
| Hospital name and logo | Canopy → System → **Hospital**: Thai and English name, PNG/JPEG logo (scaled down, ≤ 400 kB as data URL; `config.manage`). Sent with the ward exchange; the worker stores it on the Leaf when it changes, so it prints offline. Used by: the Leaf anesthesia report header (browser and Electron PDF; without a Thai font the PDF prints the English name); Form Studio logo fields set to **Use the hospital's logo** (`src: "hospital"`); the band token `{hospital}`. With none set, everything prints as before. | `hospital_profile.py`; `GET/PUT /api/fleet/hospital-profile`; `GET/PUT /api/workstation/hospital-profile`; `sync_ward`, `sync_worker.synchronize_ward`; `HospitalProfileTab.tsx`, `core/hospital.ts`, `ReportView.tsx`, `electron/reportPdf.cjs`; validators + fixtures |
| Leaf report gaps | Footer of every page: "CONFIDENTIAL · Printed date time · who", and DOB next to HN / AN. Summary page: signature lines for the anesthesiologist and the nurse anesthetist (names from the case staff, a dotted blank otherwise) with "Date / time" to fill by hand. Same in the Electron PDF. | `ReportView.tsx`, `pdfModel.ts` (`reportSigners`), `electron/reportPdf.cjs` |
| Repeatable forms | Workflow Studio: **Repeatable** (data-entry forms only) and "at most N copies" (2-99). On the Leaf each copy is a tab, "Title (1)", "Title (2)"…, with **+ Add another** after the last copy once it has been started. A copy is keyed `<form_id>~2`, `~3`… everywhere a case form is stored or exchanged; it is its own Form Studio record of the same form (id ending `-C2`…). Required: every started copy must be completed. Attaching a workflow that lists the form once keeps filled copies reachable. Canopy review shows "(2)". | `case_forms.INSTANCE_KEY`, `workflow_entry`, `record_id`; `workflows.validate`; `routes/case_workflow.py`; `caseWorkflow.ts`, `FormView.tsx`, `WorkflowStudioView.tsx`; `0091` |
| Phase 0 leftovers | A closed case's snapshot carries its **whole** record (vitals, events up to 5000, I/O, scores) up to `FLORA_SYNC_FINAL_HISTORY_DAYS` (31) back; an open case still carries the latest 24 h. `window.complete` says whether the snapshot starts at the case start. Canopy refuses a Leaf whose sync protocol is older than `FLORA_SYNC_MIN_PROTOCOL` (default 1: everyone) with **426** and the reason, kept in `sync_leaf_node.metadata.protocol_refused`; the worker shows it on the Ward page instead of a bare HTTP error. | `sync_worker.build_snapshot`, `check_refused`; `sync_ingest.require_protocol` (batch, ward, case forms) |
| Concept layer (skeleton) | `app/concepts.py` is the Canopy twin of `concepts.ts` + `caseData.ts caseValues`: same dictionary, same values and sources, plus `DRAFT_KEYS` (where today's record draft keeps each concept). `formdev/scripts/build_concept_fixtures.py` writes `formdev/spec/fixtures/concepts.json`; both sides' tests check they agree. Consumers moved without visible change: billing reads the technique concept; the public API adds `concepts` to `GET /cases/{id}` and `/cases/{id}/forms` (patient identifiers masked like every other field). | `app/concepts.py`, `billing.py`, `routes/public_api.py`, `phi_mask.py` |
| CI and migrations | CI job **test-db** runs the database suites on a throwaway PostgreSQL built from `Dockerfile.postgres.dev`, with its own network and API image, all removed afterwards (`scripts/ci-test-db.sh`); **test-worker** runs the worker's own tests. `scripts/apply-migrations.sh --from 0088` applies new scripts to an existing database in install order and records them in `flora_migration_log` (`--list`, `--dry-run`, `--only`, `--force`). | `.gitlab-ci.yml`, `scripts/ci-test-db.sh`, `scripts/apply-migrations.sh` |

**Tests:** DB suites 43 (on a throwaway server, as CI runs them) · end-to-end flow 18 steps · Form Studio Python 484 ·
frontend vitest 795 · worker 2 · tsc, eslint, production build clean.

**Checked live on the dev stack:**
- Hospital name set in Canopy → on the Leaf within one sync. The report header shows logo and names; the footer shows DOB and "Printed … · admin"; the signature lines print.
- Repeatable test form on case D-HL7-001: copy 1 filled from the case, **+ Add another** → copy 2 filled from the case, saved, stored in Form Studio as `…-C2`. Canopy shows both, the second as "(2)".
- Not checked live: PIN signing and review buttons. They need a second signed-in user on the Leaf, so they are covered by `test_case_forms.py` and the end-to-end test only.
- The test data, the hospital profile and the temporary Canopy account were removed afterwards.

**Not applied on the dev server:** 0088-0091. Back it up, then run `scripts/apply-migrations.sh --from 0088` there.

**Still open:**
- Lookups and roles on the Leaf.
- Phases 2-6 of LEAF-DYNAMIC-STANDALONE-ANALYSIS.md: the report from concepts, patient data out of the draft, and the rest.
- A clinical sign-off of the concept dictionary.
