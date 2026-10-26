#!/usr/bin/env bash
# Regenerate databases/seed/*.sql from the running demo databases (demo/up.sh).
#
# Each database is copied to a scratch database inside its own container, sanitised there (no live
# secrets, sessions or kiosk/API keys; every user's password = the admin's, i.e. "admin"), dumped
# with --clean --if-exists --no-owner, and the scratch database is dropped. The live databases are
# only read. Usage: scripts/dump-dev-seeds.sh [canopy|leaf|root|gateway ...]   (default: all four)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=databases/seed
LEAF_CONTAINER=${LEAF_CONTAINER:-flora-leaf-or-01-leaf-db-1}
stamp() { date -u +%Y-%m-%dT%H:%MZ; }

# dump <container> <user> <db> <outfile> <header> <sanitise-sql>
dump() {
  local c=$1 u=$2 d=$3 out=$4 header=$5 sql=$6
  docker exec "$c" dropdb -U "$u" --if-exists seed_tmp
  docker exec "$c" createdb -U "$u" seed_tmp
  docker exec "$c" sh -c "pg_dump -U $u -Fc -d $d | pg_restore -U $u -d seed_tmp" 2>&1 | grep -v "does not exist, skipping" || true
  docker exec -i "$c" psql -q -U "$u" -d seed_tmp -v ON_ERROR_STOP=1 <<<"$sql"
  { printf '%s\n\n' "$header"; docker exec "$c" pg_dump -U "$u" -d seed_tmp --no-owner --clean --if-exists; } > "$out.tmp"
  mv "$out.tmp" "$out"
  docker exec "$c" dropdb -U "$u" seed_tmp
  echo "$out $(du -h "$out" | cut -f1)"
}

# Sanitising a Flora API schema (Canopy account schemas, and the Leaf's public schema).
FLORA_API_SANITISE='
CREATE FUNCTION pg_temp.sanitise(s text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('"'"'SET LOCAL search_path TO %I'"'"', s);
  UPDATE ai_service_config SET api_key = '"'"''"'"';
  TRUNCATE auth_session;
  UPDATE auth_user SET password_hash = a.password_hash, password_salt = a.password_salt
    FROM (SELECT password_hash, password_salt FROM auth_user WHERE username = '"'"'admin'"'"') a;
  UPDATE auth_user SET admin_pin_hash = NULL, admin_pin_salt = NULL, sign_pin_hash = NULL, sign_pin_salt = NULL,
                       must_change_password = 0;
  UPDATE staff_directory SET pin_hash = NULL;
  DELETE FROM canopy_api_key;
  DELETE FROM ai_studio_dashboard_link;
  UPDATE canopy_hl7_interface SET basic_password = DEFAULT, bearer_token = DEFAULT, webhook_token = DEFAULT;
  UPDATE canopy_outbound_destination SET password = DEFAULT, bearer_token = DEFAULT, client_key = DEFAULT;
  UPDATE leaf_gateway_link SET token = NULL;
  TRUNCATE sync_message;
END $fn$;'

seed_canopy() {
  dump flora-canopy-canopy-db-1 flora_admin flora $OUT/flora_canopy.sql "-- Flora Canopy dev seed: dump of the demo Canopy database (flora), $(stamp).
-- Multi-account: platform schema + one schema per account (acct_kcmh, acct_demo).
-- Sanitised in every account schema: AI service key cleared, sign-in sessions, public API keys and
-- AI Studio kiosk links removed, every user's password = admin, admin/sign PINs and staff PINs
-- removed, HL7 / outbound interface secrets and Leaf-Gateway link tokens cleared; sync_message
-- history emptied (current case snapshots in sync_case_index are kept). Platform console admin
-- password = admin. Account sync-secret hashes are kept so the seeded Leaves still sync.
-- Restore into a fresh Canopy database:
--   psql -U flora_admin -d flora -f databases/seed/flora_canopy.sql
-- Roles flora_app / flora_view / flora_sync must exist (created by the Dockerfile.postgres.dev init)." "
BEGIN;
$FLORA_API_SANITISE
SELECT pg_temp.sanitise(nspname) FROM pg_namespace WHERE nspname LIKE 'acct\_%';
UPDATE platform.admin_user SET password_hash = a.password_hash, password_salt = a.password_salt
  FROM (SELECT password_hash, password_salt FROM acct_kcmh.auth_user WHERE username = 'admin') a;
COMMIT;"
}

seed_leaf() {
  dump "$LEAF_CONTAINER" flora_admin flora $OUT/flora_leaf.sql "-- Flora Leaf dev seed: dump of ${LEAF_CONTAINER%-leaf-db-1} (demo data), $(stamp).
-- Sanitised: ai_service_config.api_key cleared, auth_session emptied, every user's password = admin,
-- admin/sign PINs, staff PINs, kiosk links, HL7 / outbound secrets and the Gateway link token removed
-- (pair the Leaf with its Gateway again after restoring). Restore into a fresh Leaf database:
--   psql -U flora_admin -d flora -f databases/seed/flora_leaf.sql
-- Roles flora_app / flora_view / flora_sync must exist (created by the Dockerfile.postgres.dev init)." "
BEGIN;
$FLORA_API_SANITISE
SELECT pg_temp.sanitise('public');
COMMIT;"
}

seed_root() {
  dump flora-root-root-db-1 flora_root flora_root $OUT/flora_root.sql "-- Flora Root dev seed: dump of the demo Root database (flora_root), $(stamp).
-- Sanitised: sign-in sessions removed, every user's password = admin's, signing keys removed.
-- Root creates a new Ed25519 signing key on first start: re-issue licenses and re-publish releases
-- (demo/release.sh) after restoring, and give Haber the new public key.
-- Restore into a fresh Root database:
--   psql -U flora_root -d flora_root -f databases/seed/flora_root.sql" "
BEGIN;
TRUNCATE root_session;
UPDATE root_user SET password_hash = (SELECT password_hash FROM root_user WHERE username = 'admin'),
                     must_change_password = false, failed_logins = 0, locked_until = NULL;
DELETE FROM root_signing_key;
COMMIT;"
}

seed_gateway() {
  dump flora-gateway-gateway-db-1 flora_gateway flora_gateway $OUT/flora_gateway.sql "-- Flora Gateway dev seed: dump of the demo Gateway database (flora_gateway), $(stamp).
-- Sanitised: sign-in sessions and Leaf pairing tokens removed, every user's password = admin, Canopy
-- link key cleared (set it again under Overview -> Canopy connection); observations and measurements
-- trimmed to the last hour of data. Restore into a fresh Gateway database:
--   psql -U flora_gateway -d flora_gateway -f databases/seed/flora_gateway.sql" "
BEGIN;
TRUNCATE gateway_session;
DELETE FROM gateway_leaf_token;
UPDATE gateway_user SET password_hash = (SELECT password_hash FROM gateway_user WHERE username = 'admin');
UPDATE gateway_canopy_link SET gateway_key = '';
DELETE FROM gateway_observation WHERE system_ts < (SELECT max(system_ts) FROM gateway_observation) - 3600000;
DELETE FROM gateway_measurement WHERE system_ts < (SELECT max(system_ts) FROM gateway_measurement) - 3600000;
COMMIT;"
}

for target in "${@:-canopy leaf root gateway}"; do
  for name in $target; do "seed_$name"; done
done
