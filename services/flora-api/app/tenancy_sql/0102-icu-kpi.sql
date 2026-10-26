-- ICU KPIs and bundle compliance (Canopy). Projected from each case snapshot by app/icu_kpi.py
-- (sync ingest; `python -m app.icu_kpi backfill` for existing cases). Bundle definitions: app/icu_bundles.py.
-- Canopy tables; harmless (empty) on a Leaf.
BEGIN;

-- One row per (scheduled slot or entry, bundle). Slots with no entry are projected too
-- (entry_id 'slot-<form_id>-<slot_ts>'), so missed slots stay in the denominator.
CREATE TABLE IF NOT EXISTS canopy_bundle_entry (
  global_case_id uuid NOT NULL,
  form_id text NOT NULL,
  entry_id text NOT NULL,
  bundle_id text NOT NULL,
  slot_ts bigint,
  shift_code text,
  stay_day integer,
  status text NOT NULL,                     -- done | draft | skipped | missed
  applicable boolean NOT NULL,
  compliant boolean NOT NULL,
  missed boolean NOT NULL DEFAULT false,    -- overdue / skipped with no data
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  unit_key text,
  leaf_id text,
  hn text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (global_case_id, entry_id, bundle_id)
);
CREATE INDEX IF NOT EXISTS canopy_bundle_entry_unit_slot ON canopy_bundle_entry (unit_key, slot_ts);
CREATE INDEX IF NOT EXISTS canopy_bundle_entry_bundle_slot ON canopy_bundle_entry (bundle_id, slot_ts);

-- One row per ICU case: stay, outcome, device days and device-associated events.
CREATE TABLE IF NOT EXISTS canopy_case_kpi (
  global_case_id uuid PRIMARY KEY,
  hn text,
  admission_number text,
  unit_key text,
  leaf_id text,
  admitted_at bigint,
  discharged_at bigint,
  los_hours numeric,
  destination text,
  died boolean NOT NULL DEFAULT false,
  vent_days numeric,
  central_line_days numeric,
  urinary_catheter_days numeric,
  vap boolean NOT NULL DEFAULT false,
  clabsi boolean NOT NULL DEFAULT false,
  cauti boolean NOT NULL DEFAULT false,
  pressure_injury boolean NOT NULL DEFAULT false,
  reintubation_48h boolean NOT NULL DEFAULT false,
  readmission_48h boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_case_kpi_unit_admit ON canopy_case_kpi (unit_key, admitted_at);
CREATE INDEX IF NOT EXISTS canopy_case_kpi_hn ON canopy_case_kpi (hn, discharged_at);

-- The sync API (snapshot ingest, backfill) writes; the Canopy UI API reads.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_bundle_entry, canopy_case_kpi TO flora_sync;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT ON canopy_bundle_entry, canopy_case_kpi TO flora_view;
  END IF;
END $$;

COMMIT;
