BEGIN;

ALTER TABLE clinical_concept DROP CONSTRAINT IF EXISTS clinical_concept_domain_check;

UPDATE clinical_concept
SET domain='observation', updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
WHERE domain IN ('vital','agent');

UPDATE clinical_concept concept
SET domain='blood_product', updated_at=(extract(epoch from clock_timestamp())*1000)::bigint
FROM io_item_master item
WHERE item.concept_id=concept.id
  AND item.kind='fluid'
  AND lower(coalesce(item.category,''))='bloodproduct';

ALTER TABLE clinical_concept ADD CONSTRAINT clinical_concept_domain_check
  CHECK (domain IN ('observation','fluid','blood_product','medication','output','diagnosis','procedure'));

COMMIT;
