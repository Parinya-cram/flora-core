# ICU rounds: scheduled workflow forms

A workflow form can have a **schedule**. The form is then filled once per **slot**, for example every morning
at 07:00, every shift, or every 8 h. Each fill is its own **entry**. Users can also add **unscheduled entries**.
Forms without a schedule work as before, with one record per case in `case_form_record`.

Plan: `~/.claude/plans/rustling-noodling-crab.md`, part A.

## Workflow definition (`flora-workflow/1`, `app/workflows.py`)

```jsonc
{
  "day_start": "07:00",                   // optional. Day 1 of the stay starts at the first day_start
                                          // at or before the case start (local time).
  "shifts": [                             // optional. Default D 07:00, E 15:00, N 23:00.
    {"code": "D", "label": "Day",     "start": "07:00"},
    {"code": "E", "label": "Evening", "start": "15:00"},
    {"code": "N", "label": "Night",   "start": "23:00"}
  ],
  "forms": [{
    "form_id": "icu_daily_round", "version": 2, "phase": "intraop", "required": true,
    "schedule": {
      "kind": "daily",          // "daily" | "every" | "per_shift"
      "at": "07:00",            // daily only
      "every_hours": 8,         // every only (1-24), anchored at day_start
      "days": null,             // null = until discharge; N = only the first N days of the stay
      "grace_min": 120          // due until slot+grace, then overdue.
                                // Default 120 (daily/every); per_shift defaults to the shift length.
    }
  }]
}
```

- `normalize` keeps `schedule`, `day_start` and `shifts`.
- `validate` checks the HH:MM format, ranges, unique shift codes, and that shifts are ordered by start time.

## Slots (`app/form_schedule.py`)

Slots are computed, not stored.
- **Time zone:** the Leaf's `workstation_context.timezone`, falling back to Asia/Bangkok.
- **First slot:** the first slot at or after the case start (minute precision).
- **Last slot:** the last slot at or before `min(discharge_time or now+24h, start + days*24h)`.
- **Status of a slot:**
  - `done`: a completed entry exists.
  - `skipped`: the entry was skipped.
  - `draft`: an entry exists but is not completed.
  - `due`: now ≥ slot and now < slot + grace.
  - `overdue`: now ≥ slot + grace.
  - `upcoming`: the slot is in the future.
- `day` is 1-based from `day_start`.
- **Label:** "Day 3 · 07:00", or "Day 3 · N" for shifts.

## Storage: `case_form_entry` (migration 0097)

| column | |
|---|---|
| `id uuid` PK | |
| `case_id bigint` | → cases, on delete cascade |
| `form_id text`, `form_version int` | |
| `slot_ts bigint` | null means unscheduled |
| `status` | `draft` \| `completed` \| `skipped` |
| `data jsonb`, `field_versions jsonb` | |
| `skip_reason text` | |
| `created_at`, `created_by` | |
| `updated_at`, `updated_by` | |
| `completed_at`, `completed_by` | |

Unique on `(case_id, form_id, slot_ts)` where `slot_ts` is not null.

## Leaf API (`routes/case_workflow.py`, prefix `/api/case`)

| Method and path | Permission | Result |
|---|---|---|
| `GET /{case_id}/workflow-forms/{form_id}/entries` | case.read | `{form_id, schedule, timezone, slots: [Slot], unscheduled: [Entry], summary: {due, overdue, done}}` |
| `POST /{case_id}/workflow-forms/{form_id}/entries` `{slot_ts: int\|null}` | case.chart | `{entry}`. Idempotent per slot: returns the existing entry. A slot_ts that is not a slot gives 400. |
| `GET /{case_id}/workflow-forms/{form_id}/entries/{entry_id}` | case.read | `{definition, entry}` |
| `PATCH /{case_id}/workflow-forms/{form_id}/entries/{entry_id}` `{patch, status?}` | case.chart | `{entry}`. Same shallow merge, `form_sync.stamp_changes` and audit as the single-record PATCH. Audit action: `workflow_form_entry.patch:{form_id}`. Status `completed` sets `completed_at`/`_by`. |
| `POST /{case_id}/workflow-forms/{form_id}/entries/{entry_id}/skip` `{reason}` | case.chart | `{entry}` |
| `GET /worklist` | case.read | `{cases: [{case_id, due, overdue, forms: [{form_id, title, due, overdue, next_slot_ts}]}]}` for every active case |

Objects:
- **Slot:** `{slot_ts, day, shift: code|null, label, status, entry_id: uuid|null, completedBy, completedAt, skipReason,
  updatedAt}` (the last four are null when the slot has no entry).
- **Entry:** `{id, slot_ts, status, data, formVersion, updatedAt, updatedBy, completedAt, completedBy, skipReason}`.
  Camel case, like `public_record`.

Changes to existing endpoints:
- `GET /{case_id}/workflow`: each `forms[form_id]` adds `schedule` (or null) and `summary`
  (`{due, overdue, done}`) when the form is scheduled. `record` stays null for scheduled forms.
- Archived cases are read-only.
- Discharged cases are still editable: late documentation is allowed. No new slots appear after discharge.

## Sync and handover

- **Snapshot:** the sync worker snapshot adds `workflow_entries: [Entry + form_id]` for the whole case
  (`GET /{case_id}/workflow-entries`).
- **Canopy:** `workflows.ingest_workflow_forms` writes one Form Studio record per entry, with id
  `record_id_for(gcid, f"{form_id}:{entry_id}")`.
- **Handover:** `case_handover.CASE_TABLES` includes `case_form_record` and `case_form_entry`.
