-- Case staff: when each person came into and left the case (epoch ms, minute precision).
-- time_in defaults to "now" when someone is added in the chart; time_out stays empty while they are present.
BEGIN;

ALTER TABLE case_staff ADD COLUMN IF NOT EXISTS time_in bigint;
ALTER TABLE case_staff ADD COLUMN IF NOT EXISTS time_out bigint;

DO $$ BEGIN
  ALTER TABLE case_staff ADD CONSTRAINT case_staff_time_order CHECK (time_out IS NULL OR time_in IS NULL OR time_out >= time_in);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
