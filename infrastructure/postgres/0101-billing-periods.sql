-- ICU daily billing: a case may hold one billing order per billing day (docs/BILLING.md, "ICU daily billing").
--
-- A billing day follows the ward workflow's day_start (default 07:00, Leaf time zone): day 1 runs from the
-- case start to the next day_start, then whole days until discharge. A daily order (kind 'daily') covers
-- [period_start, period_end); closing it submits and locks it. OR billing keeps one order per case
-- (kind 'case', period_start NULL). Standing charges (bed-day, nursing care-day, monitoring-day,
-- device-days) are generated per day from billing_item.charge_basis (app/billing_periods.py).
-- Canopy keeps one canopy_case_billing row per order: the key becomes (global_case_id, period_start),
-- with period_start 0 for the case order, so existing rows stay valid.
-- The same file runs on Leaf and Canopy databases; each uses the tables it needs.
BEGIN;

-- ---------------------------------------------------------------- master: how an item is charged
ALTER TABLE billing_item ADD COLUMN IF NOT EXISTS charge_basis text NOT NULL DEFAULT 'unit';
ALTER TABLE billing_item ADD COLUMN IF NOT EXISTS device_kind text;   -- per_device_day: ventilator | monitor | infusion_pump ...
ALTER TABLE billing_item DROP CONSTRAINT IF EXISTS billing_item_charge_basis_check;
ALTER TABLE billing_item ADD CONSTRAINT billing_item_charge_basis_check CHECK (charge_basis IN ('unit','per_day','per_device_day'));

-- ---------------------------------------------------------------- Leaf orders: case or billing day
ALTER TABLE case_billing_order ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'case';
ALTER TABLE case_billing_order ADD COLUMN IF NOT EXISTS period_start bigint;   -- daily: day window [start, end)
ALTER TABLE case_billing_order ADD COLUMN IF NOT EXISTS period_end bigint;
ALTER TABLE case_billing_order ADD COLUMN IF NOT EXISTS closed_at bigint;
ALTER TABLE case_billing_order ADD COLUMN IF NOT EXISTS closed_by text;
-- Closed and sent to Canopy under the previous case before a handover: shown, never projected again.
ALTER TABLE case_billing_order ADD COLUMN IF NOT EXISTS handover_billed boolean NOT NULL DEFAULT false;
ALTER TABLE case_billing_order DROP CONSTRAINT IF EXISTS case_billing_order_kind_check;
ALTER TABLE case_billing_order ADD CONSTRAINT case_billing_order_kind_check
  CHECK ((kind = 'case' AND period_start IS NULL) OR (kind = 'daily' AND period_start IS NOT NULL AND period_end > period_start));
-- One live (non-void) order per case and period (the case order has no period).
DROP INDEX IF EXISTS case_billing_order_live_idx;
CREATE UNIQUE INDEX IF NOT EXISTS case_billing_order_live_period_idx
  ON case_billing_order(case_id, coalesce(period_start, 0)) WHERE status <> 'void';

ALTER TABLE case_billing_order_item DROP CONSTRAINT IF EXISTS case_billing_order_item_source_check;
ALTER TABLE case_billing_order_item ADD CONSTRAINT case_billing_order_item_source_check
  CHECK (source IN ('manual','io_suggestion','standing'));

-- ---------------------------------------------------------------- Canopy copy: one row per order
DO $$ BEGIN
  IF to_regclass('canopy_case_billing') IS NOT NULL THEN
    ALTER TABLE canopy_case_billing ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'case';
    ALTER TABLE canopy_case_billing ADD COLUMN IF NOT EXISTS period_start bigint NOT NULL DEFAULT 0;  -- 0 = case order
    ALTER TABLE canopy_case_billing ADD COLUMN IF NOT EXISTS period_end bigint;
    ALTER TABLE canopy_case_billing ADD COLUMN IF NOT EXISTS closed_at bigint;
    ALTER TABLE canopy_case_billing ADD COLUMN IF NOT EXISTS closed_by text;
    ALTER TABLE canopy_case_billing_item ADD COLUMN IF NOT EXISTS period_start bigint NOT NULL DEFAULT 0;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canopy_case_billing_item_order_fkey'
                     AND conrelid = 'canopy_case_billing_item'::regclass) THEN
      ALTER TABLE canopy_case_billing_item DROP CONSTRAINT IF EXISTS canopy_case_billing_item_global_case_id_fkey;
      ALTER TABLE canopy_case_billing_item DROP CONSTRAINT IF EXISTS canopy_case_billing_item_pkey;
      ALTER TABLE canopy_case_billing DROP CONSTRAINT IF EXISTS canopy_case_billing_pkey;
      ALTER TABLE canopy_case_billing ADD CONSTRAINT canopy_case_billing_pkey PRIMARY KEY (global_case_id, period_start);
      ALTER TABLE canopy_case_billing_item ADD CONSTRAINT canopy_case_billing_item_pkey PRIMARY KEY (global_case_id, period_start, line_no);
      ALTER TABLE canopy_case_billing_item ADD CONSTRAINT canopy_case_billing_item_order_fkey
        FOREIGN KEY (global_case_id, period_start) REFERENCES canopy_case_billing(global_case_id, period_start) ON DELETE CASCADE;
    END IF;
    CREATE INDEX IF NOT EXISTS canopy_case_billing_period_idx ON canopy_case_billing(kind, period_start DESC);
  END IF;
END $$;

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON billing_group, billing_item TO flora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON case_billing_order, case_billing_order_item TO flora_app;
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_case_billing, canopy_case_billing_item TO flora_sync;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT SELECT ON canopy_case_billing, canopy_case_billing_item TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- ---------------------------------------------------------------- seed: ICU standing charges (prices set in Canopy)
INSERT INTO billing_group(code,name,form_column,sort_order,is_active,created_at,updated_at) VALUES
 ('icu_daily','ICU daily',4,200,1,1792972800000,1792972800000)
ON CONFLICT (code) DO NOTHING;

INSERT INTO billing_item(code,group_code,name,unit,qty_mode,charge_basis,device_kind,unit_price,sort_order,is_active,created_at,updated_at) VALUES
 ('icu_bed_day','icu_daily','ICU bed-day','day','count','per_day',NULL,0,2000,1,1792972800000,1792972800000),
 ('icu_nursing_day','icu_daily','ICU nursing care-day','day','count','per_day',NULL,0,2010,1,1792972800000,1792972800000),
 ('icu_monitor_day','icu_daily','Cardiac monitoring-day','day','count','per_day',NULL,0,2020,1,1792972800000,1792972800000),
 ('icu_ventilator_day','icu_daily','Ventilator-day','day','count','per_device_day','ventilator',0,2030,1,1792972800000,1792972800000),
 ('icu_infusion_pump_day','icu_daily','Infusion pump-day','day','count','per_device_day','infusion_pump',0,2040,1,1792972800000,1792972800000)
ON CONFLICT (code) DO NOTHING;

COMMIT;
