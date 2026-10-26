-- Transfer: move a running case to another bed without discharging it — to another Leaf (room change)
-- or to another bed of the same multi-bed Leaf (e.g. Recovery). The source Leaf or the Canopy ward desk
-- offers the case; the destination Leaf presses Receive (handover 'offered' → 'claimed' → ...). A bed
-- move on the same Leaf is applied by that Leaf itself (status 'offered' → 'released').
BEGIN;

ALTER TABLE canopy_case_handover DROP CONSTRAINT IF EXISTS canopy_case_handover_status_check;
ALTER TABLE canopy_case_handover ADD CONSTRAINT canopy_case_handover_status_check
  CHECK (status IN ('offered', 'claimed', 'imported', 'released', 'cancelled'));
-- take_over: pulled by the destination (Ward → Take over); transfer / bed_move: offered by the source or Canopy.
ALTER TABLE canopy_case_handover ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'take_over';
ALTER TABLE canopy_case_handover ADD COLUMN IF NOT EXISTS initiated_from text;
ALTER TABLE canopy_case_handover ADD COLUMN IF NOT EXISTS to_bed_location_id bigint;
ALTER TABLE canopy_case_handover ADD COLUMN IF NOT EXISTS to_bed_label text;
ALTER TABLE canopy_case_handover ADD COLUMN IF NOT EXISTS admission_id text;
ALTER TABLE canopy_case_handover ADD COLUMN IF NOT EXISTS note text;

DROP INDEX IF EXISTS canopy_case_handover_open;
CREATE UNIQUE INDEX canopy_case_handover_open
  ON canopy_case_handover (global_case_id) WHERE status IN ('offered', 'claimed', 'imported');
CREATE INDEX IF NOT EXISTS canopy_case_handover_to ON canopy_case_handover (to_leaf_id, status);

DO $$
BEGIN
  -- The ward desk (Canopy API) offers and withdraws transfers too.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flora_view') THEN
    GRANT SELECT, INSERT, UPDATE ON canopy_case_handover TO flora_view;
  END IF;
END $$;

COMMIT;
