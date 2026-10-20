BEGIN;

CREATE TABLE IF NOT EXISTS io_group_master (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('med','fluid','output')),
  is_active bigint NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

INSERT INTO io_group_master(code,display_name,kind,is_active,sort_order,created_at,updated_at) VALUES
 ('fluids','Fluids','fluid',1,10,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('bloodProduct','Blood Product','fluid',1,20,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('ivAnesthetic','IV Anesthetic','med',1,100,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('opioid','Opioid','med',1,110,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('nmbd','NMBD','med',1,120,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('reversal','Reversal','med',1,130,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('anticholinergic','Anticholinergic','med',1,140,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('antiEmetic','Anti-emetic','med',1,150,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('analgesic','Analgesic','med',1,160,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('cvDrug','CV Drug','med',1,170,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('antimicrobial','Antibiotics','med',1,180,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('localAnesthetic','Local Anesthetic','med',1,190,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('other','Other','med',1,200,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('urineOutput','Urine','output',1,300,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('bloodLossOutput','Blood Loss','output',1,310,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000),
 ('otherOutput','Other Output','output',1,320,extract(epoch from clock_timestamp())*1000,extract(epoch from clock_timestamp())*1000)
ON CONFLICT(code) DO NOTHING;

ALTER TABLE io_item_master ADD COLUMN IF NOT EXISTS group_id bigint REFERENCES io_group_master(id);
UPDATE io_item_master item SET group_id=group_row.id
FROM io_group_master group_row
WHERE item.group_id IS NULL AND lower(group_row.code)=lower(item.category);
CREATE INDEX IF NOT EXISTS io_item_master_group_idx ON io_item_master(group_id);

GRANT SELECT,INSERT,UPDATE ON io_group_master TO flora_app;
GRANT USAGE,SELECT ON SEQUENCE io_group_master_id_seq TO flora_app;

COMMIT;
