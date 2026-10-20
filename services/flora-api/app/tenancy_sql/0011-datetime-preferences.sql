ALTER TABLE workstation_context
  ADD COLUMN IF NOT EXISTS date_format text NOT NULL DEFAULT 'DD/MM/YYYY',
  ADD COLUMN IF NOT EXISTS time_format text NOT NULL DEFAULT '24h';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workstation_context_date_format_check') THEN
    ALTER TABLE workstation_context ADD CONSTRAINT workstation_context_date_format_check
      CHECK (date_format IN ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='workstation_context_time_format_check') THEN
    ALTER TABLE workstation_context ADD CONSTRAINT workstation_context_time_format_check
      CHECK (time_format IN ('24h','12h'));
  END IF;
END $$;
