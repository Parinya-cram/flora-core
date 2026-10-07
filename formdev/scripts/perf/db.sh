#!/bin/sh
# Create or drop the FormDev perf database (Phase 4.13). Refuses names that do not end in _test.
#   formdev/scripts/perf/db.sh create flora_formdev_perf_test
#   formdev/scripts/perf/db.sh drop   flora_formdev_perf_test
# Applies the FormDev migrations only (0060-0065), as the API's FormDev tables expect them.
set -eu
ACTION="${1:?create|drop}"
DB="${2:?database name}"
case "$DB" in *_test) ;; *) echo "refusing: database '$DB' does not end in _test" >&2; exit 2 ;; esac
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTAINER="${PERF_PG_CONTAINER:-flora-core-v2-postgres-1}"
ADMIN="$(grep -E '^FLORA_POSTGRES_ADMIN_USER=' "$REPO/.env" | cut -d= -f2-)"
psql_admin() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$ADMIN" "$@"; }
case "$ACTION" in
  create)
    psql_admin -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
    psql_admin -d postgres -c "CREATE DATABASE $DB"
    for f in 0060-formdev.sql 0061-formdev-query.sql 0061b-formdev-query-indexes.sql 0062-formdev-registry.sql 0063-formdev-lookup.sql \
             0064-formdev-attachment.sql 0065-formdev-index-rebuild.sql; do
      psql_admin -d "$DB" < "$REPO/infrastructure/postgres/$f"
    done
    psql_admin -d "$DB" -Atc "SELECT indexname FROM pg_indexes WHERE tablename IN ('formdev_record','formdev_record_index') ORDER BY 1"
    ;;
  drop)
    psql_admin -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
    ;;
  *) echo "usage: $0 create|drop <db>_test" >&2; exit 2 ;;
esac
