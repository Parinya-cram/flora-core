#!/bin/sh
# Run services/flora-api/tests/test_leaf_writes.py against a disposable database.
#
#   scripts/test-leaf-writes.sh            # build, test, drop
#   KEEP=1 scripts/test-leaf-writes.sh     # keep the database afterwards (for debugging)
#
# The database is built as a new install builds it: every script of Dockerfile.postgres.dev in init order, then the
# public terminology baseline (ICD-10 WHO, ICD-9-CM, UCUM releases) copied from databases/seed/flora_leaf.sql, so no
# download is needed, and turned into ICD master concepts by scripts/import-terminology.py materialize-icd-masters.
# Needs the dev stack's PostgreSQL container and API image (docker compose -f compose.dev.yaml up).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB:-flora_leaf_writes_test}"
CONTAINER="${PG_CONTAINER:-flora-core-postgres-1}"
NETWORK="${PG_NETWORK:-flora-core_default}"
IMAGE="${API_IMAGE:-flora-core-flora-canopy-api}"
case "$DB" in *_test) ;; *) echo "refusing: database '$DB' does not end in _test" >&2; exit 2 ;; esac

psql_db() { docker exec -i "$CONTAINER" sh -c "psql -v ON_ERROR_STOP=1 -q -U \"\$POSTGRES_USER\" -d $1"; }
drop() { echo "DROP DATABASE IF EXISTS $DB WITH (FORCE)" | psql_db postgres; }

echo "== building $DB from Dockerfile.postgres.dev"
drop
echo "CREATE DATABASE $DB" | psql_db postgres
grep -E '^COPY ' "$REPO/Dockerfile.postgres.dev" | awk '{name=$3; sub(".*/", "", name); print name " " $2}' | sort |
while read -r name source; do
  if ! psql_db "$DB" < "$REPO/$source" > /dev/null 2>&1; then
    echo "install script failed: $name" >&2
    psql_db "$DB" < "$REPO/$source" 2>&1 | grep ERROR >&2 || true
    exit 1
  fi
done

echo "== loading the terminology baseline from databases/seed/flora_leaf.sql"
for table in terminology_release terminology_entry terminology_synonym; do
  awk -v head="COPY public.$table " 'index($0, head) == 1 {copy = 1} copy {print} copy && /^\\\.$/ {exit}' \
    "$REPO/databases/seed/flora_leaf.sql" | psql_db "$DB"
done
for table in terminology_release terminology_entry terminology_synonym; do
  echo "SELECT setval(pg_get_serial_sequence('$table','id'), greatest(1, (SELECT coalesce(max(id), 0) FROM $table)))" | psql_db "$DB" > /dev/null
done

ADMIN="$(grep -E '^FLORA_POSTGRES_ADMIN_USER=' "$REPO/.env" | cut -d= -f2-)"
PASSWORD="$(grep -E '^FLORA_POSTGRES_ADMIN_PASSWORD=' "$REPO/.env" | cut -d= -f2- || true)"
[ -n "$PASSWORD" ] || PASSWORD="$(docker exec "$CONTAINER" printenv POSTGRES_PASSWORD)"
URL="postgresql://$ADMIN:$PASSWORD@postgres:5432/$DB"
api() { docker run --rm --network "$NETWORK" -v "$REPO:/repo" -w /repo/services/flora-api -e FLORA_DATABASE_URL="$URL" -e PYTHONPATH=/repo/services/flora-api "$IMAGE" "$@"; }

api python /repo/scripts/import-terminology.py materialize-icd-masters

echo "== running tests/test_leaf_writes.py"
status=0
output="$(api python -m unittest tests/test_leaf_writes.py 2>&1)" || status=$?
printf '%s\n' "$output" | grep -vE '^INFO:' | sed "s|$PASSWORD|***|g"

[ "${KEEP:-0}" = "1" ] && echo "kept $DB" || drop
exit "$status"
