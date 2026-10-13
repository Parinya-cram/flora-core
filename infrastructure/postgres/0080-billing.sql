-- OR billing checklist ("Anesthesia Check List (Billing)").
--
-- Master data (billing_group, billing_item) is owned by Canopy and travels to every
-- Leaf with the directory exchange, like the I/O catalogue; Leafs upsert it by code.
-- A Leaf records one billing order per case (case_billing_order + items); it reaches
-- Canopy in the case snapshot ("billing"), where sync ingest keeps a structured copy
-- (canopy_case_billing + items) for billing staff and reports.
-- The same file runs on Leaf and Canopy databases; each uses the tables it needs.
BEGIN;

-- ---------------------------------------------------------------- master (Canopy → Leaf)
CREATE TABLE IF NOT EXISTS billing_group (
  code text PRIMARY KEY,
  name text NOT NULL,
  form_column int NOT NULL DEFAULT 1,       -- column on the printed checklist (1-4)
  sort_order int NOT NULL DEFAULT 0,
  is_active int NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_item (
  code text PRIMARY KEY,
  group_code text NOT NULL REFERENCES billing_group(code) ON UPDATE CASCADE,
  name text NOT NULL,
  unit text,                                 -- amp, ml, bag, piece, hr, case ...
  qty_mode text NOT NULL DEFAULT 'count' CHECK (qty_mode IN ('count','hours','used')),
  variant_label text,                        -- e.g. 'No.' when a size must be written (IV cath No. 20)
  io_item_code text,                         -- io_item_master.code: suggest quantity from charted I/O
  charge_code text,                          -- hospital billing / HIS charge code
  unit_price numeric(12,2),                  -- optional; snapshotted on each order line
  sort_order int NOT NULL DEFAULT 0,
  is_active int NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  updated_by text
);
CREATE INDEX IF NOT EXISTS billing_item_group_idx ON billing_item(group_code, sort_order);

ALTER TABLE auth_directory_state ADD COLUMN IF NOT EXISTS billing_catalog_version bigint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- orders (Leaf, per case)
CREATE TABLE IF NOT EXISTS case_billing_order (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  order_uuid uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','void')),
  anesthesia_start bigint, anesthesia_end bigint,
  surgery_start bigint, surgery_end bigint,
  discharge_location text,
  signers jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{role: surgeon|anesthesiologist|nurse1|nurse2, name, staff_id}]
  note text,
  submitted_at bigint, submitted_by text,
  created_by text, created_at bigint NOT NULL,
  updated_by text, updated_at bigint NOT NULL
);
-- One live (non-void) order per case.
CREATE UNIQUE INDEX IF NOT EXISTS case_billing_order_live_idx ON case_billing_order(case_id) WHERE status <> 'void';

CREATE TABLE IF NOT EXISTS case_billing_order_item (
  id bigserial PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  order_id bigint NOT NULL REFERENCES case_billing_order(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  item_code text,                            -- billing_item.code; NULL for a free-text line
  group_code text NOT NULL,
  name text NOT NULL,                        -- snapshot of the item name (or the free text)
  variant text,                              -- size / number written on the form
  qty numeric(10,2) NOT NULL CHECK (qty >= 0),
  unit text,
  qty_mode text NOT NULL DEFAULT 'count',
  unit_price numeric(12,2),                  -- snapshot at entry
  charge_code text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','io_suggestion')),
  note text,
  created_at bigint NOT NULL, updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS case_billing_order_item_order_idx ON case_billing_order_item(order_id, line_no);

-- ---------------------------------------------------------------- Canopy structured copy
CREATE TABLE IF NOT EXISTS canopy_case_billing (
  global_case_id uuid PRIMARY KEY,
  leaf_id text NOT NULL,
  source_case_id text NOT NULL,
  order_uuid uuid,
  case_code text, hn text, an text, patient_name text,
  case_status text,
  status text NOT NULL,                      -- draft | submitted | void
  anesthesia_start bigint, anesthesia_end bigint, surgery_start bigint, surgery_end bigint,
  discharge_location text,
  signers jsonb NOT NULL DEFAULT '[]'::jsonb,
  item_count int NOT NULL DEFAULT 0,
  total_amount numeric(14,2),
  submitted_at bigint, submitted_by text,
  order_updated_at bigint,
  revision bigint NOT NULL,
  synced_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_case_billing_status_idx ON canopy_case_billing(status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS canopy_case_billing_item (
  global_case_id uuid NOT NULL REFERENCES canopy_case_billing(global_case_id) ON DELETE CASCADE,
  line_no int NOT NULL,
  item_code text, group_code text, name text NOT NULL, variant text,
  qty numeric(10,2) NOT NULL, unit text, qty_mode text,
  unit_price numeric(12,2), amount numeric(14,2), charge_code text, source text,
  PRIMARY KEY (global_case_id, line_no)
);
CREATE INDEX IF NOT EXISTS canopy_case_billing_item_code_idx ON canopy_case_billing_item(item_code);

-- ---------------------------------------------------------------- permission
INSERT INTO auth_permission(code,display_name,category,risk_level,created_at,updated_at) VALUES
 ('billing.manage','Manage the billing item master','Configuration','high',1760313600000,1760313600000)
ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,category=excluded.category,
  risk_level=excluded.risk_level,updated_at=excluded.updated_at;
INSERT INTO auth_role_permission(role_code,permission_code,created_at)
SELECT code,'billing.manage',1760313600000 FROM auth_role WHERE code IN ('system_admin','clinical_admin')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON billing_group, billing_item TO flora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON case_billing_order, case_billing_order_item TO flora_app;
GRANT USAGE, SELECT ON SEQUENCE case_billing_order_id_seq, case_billing_order_item_id_seq TO flora_app;
DO $$ BEGIN
  GRANT SELECT ON billing_group, billing_item TO flora_sync;
  GRANT SELECT, INSERT, UPDATE, DELETE ON canopy_case_billing, canopy_case_billing_item TO flora_sync;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE ON billing_group, billing_item TO flora_view;
  GRANT SELECT ON canopy_case_billing, canopy_case_billing_item TO flora_view;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- ---------------------------------------------------------------- seed (scripts/catalog/build_billing_migration_seed.py)
INSERT INTO billing_group(code,name,form_column,sort_order,is_active,created_at,updated_at) VALUES
 ('gas','Gas / Inhalation',1,0,1,1760313600000,1760313600000),
 ('induction','Induction Agent',1,10,1,1760313600000,1760313600000),
 ('relaxant','Muscle Relaxant',1,20,1,1760313600000,1760313600000),
 ('narcotic','Narcotics',1,30,1,1760313600000,1760313600000),
 ('reversal','Reversal Agent',1,40,1,1760313600000,1760313600000),
 ('local','Local Anesthesia',2,50,1,1760313600000,1760313600000),
 ('fluid','Fluids',2,60,1,1760313600000,1760313600000),
 ('othermed','Other Medication',2,70,1,1760313600000,1760313600000),
 ('equipment','Other Equipment',3,80,1,1760313600000,1760313600000),
 ('disposable','Disposable Supply',3,90,1,1760313600000,1760313600000),
 ('sensor','Lab and Disposable Sensor',4,100,1,1760313600000,1760313600000),
 ('technique','Anesthetic Technique',4,110,1,1760313600000,1760313600000),
 ('pacu','PACU care',4,120,1,1760313600000,1760313600000)
ON CONFLICT (code) DO NOTHING;

INSERT INTO billing_item(code,group_code,name,unit,qty_mode,variant_label,io_item_code,sort_order,is_active,created_at,updated_at) VALUES
 ('gas-o2-air-n2o','gas','O2/AIR/N2O (hr)','hr','hours',NULL,NULL,0,1,1760313600000,1760313600000),
 ('gas-desflurane','gas','Desflurane (hr)','hr','hours',NULL,NULL,10,1,1760313600000,1760313600000),
 ('gas-sevoflurane','gas','Sevoflurane (hr)','hr','hours',NULL,NULL,20,1,1760313600000,1760313600000),
 ('ind-thiopentone','induction','Thiopentone (ml)','ml','count',NULL,NULL,30,1,1760313600000,1760313600000),
 ('ind-propofol-20','induction','Propofol 20 ml (20 ml/amp)','amp','count',NULL,'propofol',40,1,1760313600000,1760313600000),
 ('ind-propofol-50','induction','Propofol 50 ml (50 ml/bottle)','bottle','count',NULL,NULL,50,1,1760313600000,1760313600000),
 ('ind-etomidate','induction','Etomidate','amp','count',NULL,'etomidate',60,1,1760313600000,1760313600000),
 ('ind-midazolam','induction','Midazolam','amp','count',NULL,'midazolam',70,1,1760313600000,1760313600000),
 ('mr-succinylcholine','relaxant','S. choline','amp','count',NULL,'succinylcholine',80,1,1760313600000,1760313600000),
 ('mr-atracurium','relaxant','Atracurium','amp','count',NULL,'atracurium',90,1,1760313600000,1760313600000),
 ('mr-cisatracurium','relaxant','Cisatracurium','amp','count',NULL,'cisatracurium',100,1,1760313600000,1760313600000),
 ('mr-rocuronium','relaxant','Rocuronium','amp','count',NULL,'rocuronium',110,1,1760313600000,1760313600000),
 ('nc-fentanyl','narcotic','Fentanyl','amp','count',NULL,'fentanyl',120,1,1760313600000,1760313600000),
 ('nc-morphine','narcotic','Morphine','amp','count',NULL,'morphine',130,1,1760313600000,1760313600000),
 ('nc-pethidine','narcotic','Pethidine','amp','count',NULL,'pethidine',140,1,1760313600000,1760313600000),
 ('nc-tramadol','narcotic','Tramadol','amp','count',NULL,NULL,150,1,1760313600000,1760313600000),
 ('rv-atropine','reversal','Atropine','amp','count',NULL,'atropine',160,1,1760313600000,1760313600000),
 ('rv-glycopyrrolate','reversal','Glycopyrrolate','amp','count',NULL,'glycopyrrolate',170,1,1760313600000,1760313600000),
 ('rv-prostigmine','reversal','Prostigmine','amp','count',NULL,'neostigmine',180,1,1760313600000,1760313600000),
 ('rv-sugammadex','reversal','Sugammadex','vial','count',NULL,'sugammadex',190,1,1760313600000,1760313600000),
 ('la-marcaine-05','local','0.5% Marcaine','amp','count',NULL,'bupivacaine',200,1,1760313600000,1760313600000),
 ('la-xylocaine-2','local','2% Xylocaine','vial','count',NULL,'lidocaineLocalAnesthetic',210,1,1760313600000,1760313600000),
 ('la-xylocaine-2-pf','local','2% Xylocaine preservative free','amp','count',NULL,NULL,220,1,1760313600000,1760313600000),
 ('la-xylocaine-2-viscous','local','2% Xylocaine viscous (ml)','ml','count',NULL,NULL,230,1,1760313600000,1760313600000),
 ('la-xylocaine-10-spray','local','10% Xylocaine spray (puff)','puff','count',NULL,NULL,240,1,1760313600000,1760313600000),
 ('fl-water-10','fluid','Water 10 ml','amp','count',NULL,NULL,250,1,1760313600000,1760313600000),
 ('fl-nss-100','fluid','0.9 NSS 100 ml','bag','count',NULL,NULL,260,1,1760313600000,1760313600000),
 ('fl-nss-500','fluid','0.9 NSS 500 ml','bag','count',NULL,NULL,270,1,1760313600000,1760313600000),
 ('fl-nss-1000','fluid','0.9 NSS 1000 ml','bag','count',NULL,'normalSaline',280,1,1760313600000,1760313600000),
 ('fl-acetar-1000','fluid','Acetar 1000 ml','bag','count',NULL,NULL,290,1,1760313600000,1760313600000),
 ('fl-sterofundin-1000','fluid','Sterofundin 1000 ml','bag','count',NULL,'sterofundin',300,1,1760313600000,1760313600000),
 ('fl-voluven','fluid','Voluven','bag','count',NULL,'voluven',310,1,1760313600000,1760313600000),
 ('fl-volulyte-6','fluid','Volulyte 6%','bag','count',NULL,'volulyte',320,1,1760313600000,1760313600000),
 ('fl-d5w-100','fluid','5% D/W 100 ml','bag','count',NULL,NULL,330,1,1760313600000,1760313600000),
 ('fl-d5n2-1000','fluid','5% D/N/2 1000 ml','bag','count',NULL,NULL,340,1,1760313600000,1760313600000),
 ('fl-mannitol-20','fluid','20% Mannitol','bottle','count',NULL,'mannitol20',350,1,1760313600000,1760313600000),
 ('om-adrenaline','othermed','Adrenaline','amp','count',NULL,'epinephrine',360,1,1760313600000,1760313600000),
 ('om-amiodarone','othermed','Amiodarone','amp','count',NULL,'amiodarone',370,1,1760313600000,1760313600000),
 ('om-cpm','othermed','CPM','amp','count',NULL,NULL,380,1,1760313600000,1760313600000),
 ('om-calcium-gluconate','othermed','Calcium gluconate','amp','count',NULL,'calciumGluconate',390,1,1760313600000,1760313600000),
 ('om-dexamethasone','othermed','Dexamethasone','amp','count',NULL,'dexamethasone',400,1,1760313600000,1760313600000),
 ('om-dopamine','othermed','Dopamine','amp','count',NULL,'dopamine',410,1,1760313600000,1760313600000),
 ('om-ephedrine','othermed','Ephedrine','amp','count',NULL,'ephedrine',420,1,1760313600000,1760313600000),
 ('om-esmolol','othermed','Esmolol','vial','count',NULL,'esmolol',430,1,1760313600000,1760313600000),
 ('om-furosemide','othermed','Furosemide','amp','count',NULL,'furosemide',440,1,1760313600000,1760313600000),
 ('om-hydrocortisone','othermed','Hydrocortisone','vial','count',NULL,'hydrocortisone',450,1,1760313600000,1760313600000),
 ('om-labetalol','othermed','Labetalol','amp','count',NULL,'labetalol',460,1,1760313600000,1760313600000),
 ('om-metoclopramide','othermed','Metoclopramide','amp','count',NULL,'metoclopramide',470,1,1760313600000,1760313600000),
 ('om-naloxone','othermed','Naloxone','amp','count',NULL,'naloxone',480,1,1760313600000,1760313600000),
 ('om-nicardipine-2','othermed','Nicardipine (2 ml/amp)','amp','count',NULL,'nicardipine',490,1,1760313600000,1760313600000),
 ('om-nicardipine-10','othermed','Nicardipine (10 ml/amp)','amp','count',NULL,NULL,500,1,1760313600000,1760313600000),
 ('om-norepinephrine','othermed','Norepinephrine','amp','count',NULL,'norepinephrine',510,1,1760313600000,1760313600000),
 ('om-ondansetron','othermed','Ondansetron','amp','count',NULL,'ondansetron',520,1,1760313600000,1760313600000),
 ('om-paracetamol','othermed','Paracetamol','vial','count',NULL,'paracetamol',530,1,1760313600000,1760313600000),
 ('om-phenylephrine','othermed','Phenylephrine','amp','count',NULL,'phenylephrine',540,1,1760313600000,1760313600000),
 ('om-sodium-bicarbonate','othermed','Sodium bicarbonate','amp','count',NULL,'sodiumBicarbonate',550,1,1760313600000,1760313600000),
 ('om-tranexamic-acid','othermed','Tranexamic acid','amp','count',NULL,'tranexamicAcid',560,1,1760313600000,1760313600000),
 ('om-chloramphenicol-oint','othermed','Chloramphenicol ointment','tube','count',NULL,NULL,570,1,1760313600000,1760313600000),
 ('om-ventolin-nb','othermed','Ventolin (NB)','neb','count',NULL,NULL,580,1,1760313600000,1760313600000),
 ('om-berodual-nb','othermed','Berodual (NB)','neb','count',NULL,NULL,590,1,1760313600000,1760313600000),
 ('eq-infusion-pump','equipment','Infusion pump','set','count',NULL,NULL,600,1,1760313600000,1760313600000),
 ('eq-syringe-pump','equipment','Syringe pump','set','count',NULL,NULL,610,1,1760313600000,1760313600000),
 ('eq-fiberoptic','equipment','Fiberoptic','use','used',NULL,NULL,620,1,1760313600000,1760313600000),
 ('eq-pca','equipment','PCA','set','count',NULL,NULL,630,1,1760313600000,1760313600000),
 ('eq-ultrasound','equipment','Ultrasound','use','used',NULL,NULL,640,1,1760313600000,1760313600000),
 ('eq-fluoroscope','equipment','Fluoroscope','use','used',NULL,NULL,650,1,1760313600000,1760313600000),
 ('ds-bacteria-filter','disposable','Bacteria filter','piece','count',NULL,NULL,660,1,1760313600000,1760313600000),
 ('ds-hepa-filter','disposable','HEPA filter','piece','count',NULL,NULL,670,1,1760313600000,1760313600000),
 ('ds-cvp-arrow','disposable','CVP arrow','set','count',NULL,NULL,680,1,1760313600000,1760313600000),
 ('ds-cvp-bbraun','disposable','CVP bbraun','set','count',NULL,NULL,690,1,1760313600000,1760313600000),
 ('ds-iv-cath','disposable','IV cath','piece','count','No.',NULL,700,1,1760313600000,1760313600000),
 ('ds-jelco','disposable','Jelco','piece','count','No.',NULL,710,1,1760313600000,1760313600000),
 ('ds-venflon-18','disposable','Venflon No 18','piece','count',NULL,NULL,720,1,1760313600000,1760313600000),
 ('ds-needle-18','disposable','Needle No. 18','piece','count',NULL,NULL,730,1,1760313600000,1760313600000),
 ('ds-needle-22','disposable','Needle No. 22','piece','count',NULL,NULL,740,1,1760313600000,1760313600000),
 ('ds-spinal-needle','disposable','Spinal needle','piece','count','No.',NULL,750,1,1760313600000,1760313600000),
 ('ds-spinal-drain','disposable','Spinal drain','set','count','No.',NULL,760,1,1760313600000,1760313600000),
 ('ds-et-tube-cuff','disposable','ET tube cuff','piece','count','No.',NULL,770,1,1760313600000,1760313600000),
 ('ds-suction-tube-14','disposable','Suction tube No 14','piece','count',NULL,NULL,780,1,1760313600000,1760313600000),
 ('ds-close-suction','disposable','Close suction','set','count',NULL,NULL,790,1,1760313600000,1760313600000),
 ('ds-microext','disposable','MicroExt','piece','count','No.',NULL,800,1,1760313600000,1760313600000),
 ('ds-extension-42','disposable','Extension No 42','piece','count',NULL,NULL,810,1,1760313600000,1760313600000),
 ('ds-extension-t','disposable','Extension with T','piece','count',NULL,NULL,820,1,1760313600000,1760313600000),
 ('ds-syringe-3','disposable','Syringe 3 cc','piece','count',NULL,NULL,830,1,1760313600000,1760313600000),
 ('ds-syringe-5','disposable','Syringe 5 cc','piece','count',NULL,NULL,840,1,1760313600000,1760313600000),
 ('ds-syringe-10','disposable','Syringe 10 cc','piece','count',NULL,NULL,850,1,1760313600000,1760313600000),
 ('ds-syringe-20','disposable','Syringe 20 cc','piece','count',NULL,NULL,860,1,1760313600000,1760313600000),
 ('ds-syringe-50','disposable','Syringe 50 cc','piece','count',NULL,NULL,870,1,1760313600000,1760313600000),
 ('ds-syringe-insulin','disposable','Syringe insulin','piece','count',NULL,NULL,880,1,1760313600000,1760313600000),
 ('ds-blood-iv-set','disposable','Blood IV set','set','count',NULL,NULL,890,1,1760313600000,1760313600000),
 ('ds-iv-set-bbraun','disposable','IV set Bbraun','set','count',NULL,NULL,900,1,1760313600000,1760313600000),
 ('ds-three-way','disposable','Three way','piece','count',NULL,NULL,910,1,1760313600000,1760313600000),
 ('ds-tegaderm-10x12','disposable','Tegaderm 10x12 cm','piece','count',NULL,NULL,920,1,1760313600000,1760313600000),
 ('ds-tegaderm-1624w','disposable','Tegaderm 1624W','piece','count',NULL,NULL,930,1,1760313600000,1760313600000),
 ('ds-iv-set','disposable','IV set','set','count',NULL,NULL,940,1,1760313600000,1760313600000),
 ('sn-o3-sensor','sensor','O3 sensor','piece','count',NULL,NULL,950,1,1760313600000,1760313600000),
 ('sn-sedline','sensor','Sed line','piece','count',NULL,NULL,960,1,1760313600000,1760313600000),
 ('sn-bis','sensor','BIS','piece','count',NULL,NULL,970,1,1760313600000,1760313600000),
 ('sn-dtx','sensor','DTX','test','count',NULL,NULL,980,1,1760313600000,1760313600000),
 ('sn-hb','sensor','Hb','test','count',NULL,NULL,990,1,1760313600000,1760313600000),
 ('sn-hct','sensor','HCT','test','count',NULL,NULL,1000,1,1760313600000,1760313600000),
 ('tq-ga','technique','GA','case','used',NULL,NULL,1010,1,1760313600000,1760313600000),
 ('tq-ra','technique','RA','case','used',NULL,NULL,1020,1,1760313600000,1760313600000),
 ('tq-iva','technique','IVA','case','used',NULL,NULL,1030,1,1760313600000,1760313600000),
 ('tq-mac','technique','MAC','case','used',NULL,NULL,1040,1,1760313600000,1760313600000),
 ('pc-o2-therapy','pacu','O2 therapy','case','used',NULL,NULL,1050,1,1760313600000,1760313600000)
ON CONFLICT (code) DO NOTHING;

COMMIT;
