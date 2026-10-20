-- Review of case forms in Canopy (Reviewed → Approved), signing PINs for signatures, and the hospital's name and logo
-- set in Canopy and sent to the Leafs (formdev/docs/CANOPY-LEAF-FORM-WORKFLOW.md §12). Idempotent.
BEGIN;

-- Canopy: a case form's review. The state holds for the form as it was reviewed (review_digest): any later change, from
-- the Leaf or an amendment, makes it "changed since review" until it is reviewed again.
ALTER TABLE canopy_case_form ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'none';
ALTER TABLE canopy_case_form ADD COLUMN IF NOT EXISTS review_digest text;
ALTER TABLE canopy_case_form ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE canopy_case_form ADD COLUMN IF NOT EXISTS reviewed_at bigint;
ALTER TABLE canopy_case_form ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE canopy_case_form ADD COLUMN IF NOT EXISTS approved_at bigint;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canopy_case_form_review_state_check') THEN
    ALTER TABLE canopy_case_form ADD CONSTRAINT canopy_case_form_review_state_check
      CHECK (review_state IN ('none', 'reviewed', 'approved'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS canopy_case_form_review (
  id bigserial PRIMARY KEY,
  case_key text NOT NULL,
  form_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('reviewed', 'approved')),
  digest text NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 500),
  acted_by text NOT NULL,
  acted_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS canopy_case_form_review_form ON canopy_case_form_review (case_key, form_id, acted_at);

GRANT SELECT, INSERT ON canopy_case_form_review TO flora_view, flora_sync;
GRANT USAGE, SELECT ON SEQUENCE canopy_case_form_review_id_seq TO flora_view, flora_sync;

INSERT INTO auth_permission (code, display_name, category, risk_level, created_at, updated_at) VALUES
  ('form.review', 'Mark case forms filled on Flora Leaf as reviewed', 'Clinical', 'normal', 1792108800000, 1792108800000),
  ('form.approve', 'Approve reviewed case forms', 'Clinical', 'sensitive', 1792108800000, 1792108800000)
ON CONFLICT (code) DO NOTHING;
INSERT INTO auth_role_permission (role_code, permission_code, created_at)
SELECT code, 'form.review', 1792108800000 FROM auth_role WHERE code IN ('system_admin', 'clinical_admin', 'clinician')
ON CONFLICT DO NOTHING;
INSERT INTO auth_role_permission (role_code, permission_code, created_at)
SELECT code, 'form.approve', 1792108800000 FROM auth_role WHERE code IN ('system_admin', 'clinical_admin')
ON CONFLICT DO NOTHING;

-- Every user: a signing PIN (4-8 digits, salted scrypt) confirming a signature drawn in a form. It travels with the
-- user directory like the admin PIN, so it works on every Leaf of the ward.
ALTER TABLE auth_user ADD COLUMN IF NOT EXISTS sign_pin_salt text;
ALTER TABLE auth_user ADD COLUMN IF NOT EXISTS sign_pin_hash text;

-- Canopy: the hospital's name and logo for printed reports and forms (sent to the Leafs with the ward exchange).
CREATE TABLE IF NOT EXISTS canopy_hospital_profile (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name_th text NOT NULL DEFAULT '',
  name_en text NOT NULL DEFAULT '',
  logo text CHECK (logo IS NULL OR (logo ~ '^data:image/(png|jpeg);base64,' AND length(logo) <= 400000)),
  updated_at bigint NOT NULL,
  updated_by text
);
GRANT SELECT, INSERT, UPDATE ON canopy_hospital_profile TO flora_view;
GRANT SELECT ON canopy_hospital_profile TO flora_sync;

-- Leaf: the copy received from Canopy (works offline).
CREATE TABLE IF NOT EXISTS leaf_hospital_profile (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at bigint
);
GRANT SELECT, INSERT, UPDATE ON leaf_hospital_profile TO flora_app;
GRANT SELECT ON leaf_hospital_profile TO flora_view;

COMMIT;
