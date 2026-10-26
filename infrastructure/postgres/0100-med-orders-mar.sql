-- Medication orders + MAR (app/med_orders.py): doctors order on the Leaf (or the HIS sends orders), nurses
-- record administrations. A given dose also writes the I/O row (case_io_event / case_io_run) so I/O stays the one
-- place doses are charted; case_med_admin keeps the link. Slots are computed (app/med_orders.py), never stored.
-- Some drugs need a doctor's staff-PIN approval (case owner's seniority or higher) to start the order and/or per dose.
-- Leaf tables; harmless (empty) on Canopy, which keeps staff_directory PIN hashes for the ward sync.
BEGIN;

-- ---------------------------------------------------------------- terminology: Thai TMT (drugs) and TMLT (lab)
-- terminology_release.system_key (0018) has no CHECK; only the concept coding is constrained.
ALTER TABLE clinical_concept_coding DROP CONSTRAINT IF EXISTS clinical_concept_coding_system_key_check;
ALTER TABLE clinical_concept_coding ADD CONSTRAINT clinical_concept_coding_system_key_check
  CHECK (system_key IN ('SNOMED_CT','ICD_10','ICD_9_CM','LOINC','RXNORM','ATC','UCUM','TMT','TMLT'));

-- ---------------------------------------------------------------- drug approval flag
-- order: activating the order needs a doctor's PIN; admin: every dose / infusion start does; both.
ALTER TABLE io_item_master ADD COLUMN IF NOT EXISTS approval_required text NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE io_item_master ADD CONSTRAINT io_item_master_approval_required_check
    CHECK (approval_required IN ('none','order','admin','both'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- staff seniority + PIN
-- Seniority ranks doctor roles: the case owner is the case's most senior doctor; approvers need >= that.
ALTER TABLE staff_role ADD COLUMN IF NOT EXISTS seniority smallint NOT NULL DEFAULT 0;
UPDATE staff_role SET seniority = CASE id
    WHEN 'rotateResident' THEN 10 WHEN 'surgeryResident' THEN 10 WHEN 'anesthetistResident' THEN 10
    WHEN 'fellowAnesthetist' THEN 20 WHEN 'anesthetist' THEN 30 WHEN 'surgeon' THEN 30 ELSE 0 END
  WHERE seniority = 0;

-- pin_hash = 'scrypt$<salt hex>$<hash hex>'; synced Canopy <-> Leaf (newest pin_set_at wins). Failures and locks are local.
ALTER TABLE staff_directory
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS pin_set_at bigint,
  ADD COLUMN IF NOT EXISTS pin_failed smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until bigint;

-- ---------------------------------------------------------------- orders
CREATE TABLE IF NOT EXISTS case_med_order (
  id uuid PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  item_id bigint REFERENCES io_item_master(id),          -- null: free text / HIS drug not in the catalogue
  drug_name text NOT NULL,
  codings jsonb NOT NULL DEFAULT '[]'::jsonb,           -- snapshot [{system, code, display}]: TMT, SNOMED_CT, HIS
  order_type text NOT NULL CHECK (order_type IN ('continue','once')),
  prn boolean NOT NULL DEFAULT false,
  dose numeric, dose_unit text, route text, form text,
  -- {kind:'every', every_hours, anchor:'HH:MM'} | {kind:'times', times:['08:00',...]} | {kind:'infusion', rate, rate_unit}
  schedule jsonb,
  start_at bigint NOT NULL,
  end_at bigint,
  duration_days integer,
  instructions text,
  indication text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending_approval','active','held','discontinued','completed')),
  holds jsonb NOT NULL DEFAULT '[]'::jsonb,             -- [{from, to|null, by, reason}]
  approval_required text NOT NULL DEFAULT 'none' CHECK (approval_required IN ('none','order','admin','both')),
  activated_at bigint,                                  -- set on order approval: no slots before it
  source text NOT NULL DEFAULT 'leaf' CHECK (source IN ('leaf','his')),
  his_ref text,
  his_state text CHECK (his_state IS NULL OR his_state IN ('draft','sending','sent','failed')),
  ordered_by text, ordered_at bigint NOT NULL,
  verified_by text, verified_at bigint,
  discontinued_by text, discontinued_at bigint, discontinue_reason text,
  updated_at bigint NOT NULL, updated_by text
);
CREATE INDEX IF NOT EXISTS case_med_order_case ON case_med_order (case_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS case_med_order_his_ref ON case_med_order (case_id, his_ref) WHERE his_ref IS NOT NULL;

-- ---------------------------------------------------------------- administrations (MAR)
CREATE TABLE IF NOT EXISTS case_med_admin (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES case_med_order(id) ON DELETE CASCADE,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  due_at bigint,                                        -- null: prn / unscheduled
  status text NOT NULL CHECK (status IN ('given','held','refused','missed','not_given')),
  given_at bigint,
  dose numeric, dose_unit text, route text, site text, note text,
  io_event_id bigint,                                   -- the I/O row this dose wrote (no FK: I/O owns its rows)
  io_run_id bigint,
  recorded_by text, recorded_at bigint NOT NULL,
  witness_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS case_med_admin_slot ON case_med_admin (order_id, due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS case_med_admin_case ON case_med_admin (case_id, given_at);

-- ---------------------------------------------------------------- doctor PIN approvals
CREATE TABLE IF NOT EXISTS case_med_approval (
  id uuid PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES case_med_order(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES case_med_admin(id) ON DELETE CASCADE,   -- null: order approval
  kind text NOT NULL CHECK (kind IN ('order','admin')),
  approver_staff_id bigint, approver_code text, approver_name text, approver_role text,
  approved_at bigint NOT NULL,
  recorded_by text,                                     -- the user signed in at the terminal
  note text
);
CREATE INDEX IF NOT EXISTS case_med_approval_order ON case_med_approval (order_id);

-- ---------------------------------------------------------------- permission: prescribing
INSERT INTO auth_permission(code,display_name,category,risk_level,created_at,updated_at) VALUES
 ('med.order','Prescribe medication orders','Case','high',1792972800000,1792972800000)
ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,category=excluded.category,
  risk_level=excluded.risk_level,updated_at=excluded.updated_at;
-- No doctor auth role existed (clinician covers nurses too): add one; admins get it as well.
INSERT INTO auth_role(code,display_name,description,is_system,is_active,sort_order,created_at,updated_at) VALUES
 ('physician','Physician','Chart cases and prescribe medication orders.',1,1,25,1792972800000,1792972800000)
ON CONFLICT(code) DO NOTHING;
INSERT INTO auth_role_permission(role_code,permission_code,created_at)
SELECT 'physician',permission_code,1792972800000 FROM auth_role_permission WHERE role_code='clinician'
ON CONFLICT DO NOTHING;
INSERT INTO auth_role_permission(role_code,permission_code,created_at)
SELECT code,'med.order',1792972800000 FROM auth_role WHERE code IN ('system_admin','clinical_admin','physician')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE, DELETE ON case_med_order, case_med_admin, case_med_approval TO flora_app;
DO $$
BEGIN
  -- Canopy's case reads (cases_read) run as flora_view.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT ON case_med_order, case_med_admin, case_med_approval TO flora_view;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT ON case_med_order, case_med_admin, case_med_approval TO flora_sync;
  END IF;
END $$;

COMMIT;
