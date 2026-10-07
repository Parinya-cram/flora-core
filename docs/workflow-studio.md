# Workflow Studio

A **workflow** describes what a case records and prints: which built-in Anesthesia
record sections it uses, which Form Studio forms it adds, and the order of the
combined **case packet** PDF. Canopy admins build workflows in **Workflow Studio**,
assign several to each ward (one default), and the ward's Leafs offer them when a
case starts. Everything needed is cached on the Leaf, so starting a case and filling
forms work offline.

## 1. Workflow file (`*.workflow.json`, format `flora-workflow/1`)

The same JSON is stored in Canopy, exported/imported as a file, and sent to Leafs.

```json
{
  "format": "flora-workflow/1",
  "id": "or_general",                       // ^[a-z][a-z0-9_]{1,63}$
  "name": "OR – General anaesthesia",
  "description": "Elective GA cases in the OR suite",
  "anesthesia_record": {
    "enabled": true,                          // false = no built-in record (forms only)
    "sections": ["caseInfo", "preop", "checklist", "ga_ett", "pacu", "outcome"],
    "optional_sections": ["neuraxial", "pnb", "line", "comorbid", "extubation", "pain"]
  },
  "forms": [
    { "form_id": "patient_assessment", "version": 3, "title": "Nursing assessment",
      "phase": "preop", "required": false }
  ],
  "packet": [
    { "kind": "anesthesia_report", "mode": "standard" },
    { "kind": "form", "form_id": "patient_assessment" }
  ],
  "bundled_forms": { }                        // export only: { form_id: { version, definition } }
}
```

- `anesthesia_record.sections` – built-in FormView tab ids switched on when the case
  starts (core tabs `caseInfo, preop, checklist, pacu, outcome` plus optional
  `ga_ett | ga_lma | ga_tubeless | neuraxial | pnb | line | comorbid | extubation | pain`).
  `optional_sections` – the optional tabs the clinician may still switch on/off.
- `forms[]` – Form Studio forms, pinned to a **published** `version`. `phase`:
  `preop | intraop | postop | any` (tab grouping only).
- `packet[]` – order of the combined PDF. `kind`: `anesthesia_report` (`mode`:
  `standard | smart_fit | detail`) or `form` (`form_id` from `forms`).
- `bundled_forms` – present only in exported files; on import, missing forms are
  created in Form Studio (as drafts) so a file moves between hospitals.

## 2. Canopy API (canopy mode, Canopy session; writes need admin)

Migration `0070-workflow-studio.sql` (Canopy tables):
`canopy_workflow(id PK, name, description, definition jsonb, version bigint,
status draft|published|archived, updated_at, updated_by)`,
`canopy_workflow_unit(workflow_id, unit_key, sort_order, is_default, PK(workflow_id, unit_key))`.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/fleet/workflows` | `{rows:[{id,name,description,status,version,updatedAt,updatedBy,definition,wards:[{unitKey,unitName,isDefault,sortOrder}]}]}` |
| GET | `/api/fleet/workflows/{id}` | one row |
| POST | `/api/fleet/workflows` | `{definition}` → row (status draft, version 0) |
| PUT | `/api/fleet/workflows/{id}` | `{definition}` → row (stays draft until published) |
| POST | `/api/fleet/workflows/{id}/publish` | validates, version += 1, status published → row |
| POST | `/api/fleet/workflows/{id}/archive` | status archived (removed from wards' lists) |
| PUT | `/api/fleet/workflows/{id}/wards` | `{wards:[{unit_key,is_default,sort_order}]}` → row; one default per ward |
| GET | `/api/fleet/workflows/{id}/export` | the `flora-workflow/1` file incl. `bundled_forms` |
| POST | `/api/fleet/workflows/import` | `{file}` (parsed JSON) → `{row, createdForms:[…], warnings:[…]}` |
| GET | `/api/fleet/workflows/options` | `{sections:[{id,label,core}], forms:[{form_id,title,published_version,versions:[n…]}], wards:[{key,name,buildingName,isDemo}]}` |

Validation on publish: id/format, sections known, every form exists with that
published version, packet entries reference listed forms, at most one
`anesthesia_report`.

## 3. Delivery to Leafs (sync)

The ward exchange (`POST /api/sync/v1/ward`, `routes/sync_ward.py`) response gains
`workflows: { version, items: [ {definition, isDefault, sortOrder} ], forms: { "<form_id>@<version>": definition } }`
– published workflows assigned to the Leaf's ward plus the pinned published Form
Studio definitions. `version` = max(updated_at) so the Leaf can skip unchanged sets.

Leaf (migration `0070` also creates):
`leaf_workflow_state(id=1, version, payload jsonb, synced_at)` – the last set received;
`cases.workflow jsonb` – snapshot of the chosen workflow definition at start
(changes later in Canopy do not alter a running case);
`case_form_record(case_id, form_id, form_version, data jsonb, field_versions jsonb,
status draft|completed, updated_at, updated_by, PK(case_id, form_id))`.

Leaf endpoints (leaf mode, Leaf session):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/case/workflows` | `{rows:[{id,name,description,isDefault,sections,forms:[…]}], syncedAt}` from the cache; works offline |
| POST | `/api/case/start` | new optional `workflow_id`; stored as `cases.workflow`; the case draft's `enabledForms` is set from `anesthesia_record.sections`. A Canopy admission may preset `admission.workflow_id`. Unknown id → 409 |
| GET | `/api/case/{id}/workflow` | `{workflow, forms:{form_id:{definition, record}}}` – definitions from the cache |
| GET | `/api/case/{id}/workflow-forms/{form_id}` | `{definition, record:{data, status, updatedAt}}` |
| PATCH | `/api/case/{id}/workflow-forms/{form_id}` | `{patch:{field:value}, status?}` – changed keys only (field_versions like case forms); archived case → 409 |

The sync worker's snapshot gains `workflow` (the case's workflow snapshot) and
`workflow_forms` (`{form_id: {form_version, data, status, updatedAt}}`), so Canopy
shows them; Canopy additionally upserts each into Form Studio as `formdev_record`
(`record_id = "<global_case_id>-<form_id>"`, `subject_id = HN`) so Form Studio's
Records/Query see bedside entries.

## 4. UI

- **Canopy → Workflow Studio** (new nav item, admin): list; editor with sections
  checklist, form picker (published forms + version), packet order (up/down),
  ward assignment (multi-ward, default per ward), Validate / Publish / Archive,
  Export file / Import file.
- **Leaf → start case**: "Workflow" select from `/api/case/workflows`
  (ward default preselected; admission preset wins). Shown only when the ward has
  workflows.
- **Leaf → case**: built-in record tabs follow the workflow; each workflow form is an
  extra tab rendered with Form Studio's renderer, saved per case.
- **Leaf → Reports → "Case packet"**: one PDF in `packet` order – the anesthesia
  report PDF followed by each form's A4 PDF (Form Studio `buildFormPdf`), merged with
  pdf-lib.
