-- ICU shift handover (docs/ICU-ROUNDS.md): one record per case, shift and role (nurse / doctor). The summary is
-- computed live (app/shift_handover.py) and frozen into `summary` when the outgoing person hands over; the
-- incoming person accepts. ISBAR text + plan are typed by the outgoing person. Leaf table; harmless (empty) on Canopy.
-- Existing Leaf databases get this file at leaf-api start-up (app/live_schema.py).
BEGIN;

CREATE TABLE IF NOT EXISTS case_shift_handover (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  shift_start bigint NOT NULL,
  shift_end bigint NOT NULL,
  shift_code text NOT NULL,
  role text NOT NULL CHECK (role IN ('nurse','doctor')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','handed','accepted')),
  identify text,
  situation text,
  background text,
  assessment text,
  recommendation text,
  plan text,
  summary jsonb,
  handed_by text,
  handed_at bigint,
  accepted_by text,
  accepted_at bigint,
  created_by text,
  created_at bigint NOT NULL,
  updated_by text,
  updated_at bigint NOT NULL,
  UNIQUE (case_id, shift_start, role)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON case_shift_handover TO flora_app;
DO $$
BEGIN
  -- Canopy's case reads (cases_read) run as flora_view.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT ON case_shift_handover TO flora_view;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_sync') THEN
    GRANT SELECT ON case_shift_handover TO flora_sync;
  END IF;
END $$;

COMMIT;
