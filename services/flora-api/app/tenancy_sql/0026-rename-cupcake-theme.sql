BEGIN;

UPDATE theme_scheme_master
SET display_name = 'Cupcake',
    updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE code = 'pink-pastel';

COMMIT;
