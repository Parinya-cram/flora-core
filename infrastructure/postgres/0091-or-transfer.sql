-- OR → Recovery is a Transfer: the OR room's case closes (its chart prints as the Anesthesia Report)
-- and the recovery bed's Leaf starts a new case (Post-Anesthesia / PACU chart). The booking keeps
-- both: global_case_id follows the newest case, or_global_case_id keeps the OR case.
-- billing_mode: 'combined' shows the OR and Recovery billing orders as one bill in Canopy,
-- 'separate' keeps two bills. Chosen at transfer; can be changed later.
BEGIN;

DO $$ BEGIN
  IF to_regclass('canopy_admission') IS NOT NULL THEN
    ALTER TABLE canopy_admission
      ADD COLUMN IF NOT EXISTS or_global_case_id uuid,
      ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'combined';
    BEGIN
      ALTER TABLE canopy_admission ADD CONSTRAINT canopy_admission_billing_mode_check
        CHECK (billing_mode IN ('combined','separate'));
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    CREATE INDEX IF NOT EXISTS canopy_admission_or_global_case_idx ON canopy_admission(or_global_case_id)
      WHERE or_global_case_id IS NOT NULL;
  END IF;
END $$;

COMMIT;
