#!/bin/sh
# Apply database migrations to an existing Flora database. PostgreSQL's initdb runs infrastructure/postgres/* only when
# a database is created; a server that already has its data needs the new scripts applied by hand. This does it in the
# order a new install uses (the COPY list of Dockerfile.postgres.dev) and records each script it applied in
# flora_migration_log, so a later run skips it.
#
#   scripts/apply-migrations.sh --list                 # scripts in install order; [x] = recorded as applied here
#   scripts/apply-migrations.sh --from 0090 --dry-run  # what would run
#   scripts/apply-migrations.sh --from 0090            # 0090 and later
#   scripts/apply-migrations.sh --only 0093            # one script
#   scripts/apply-migrations.sh --only 0093 --force    # again, even if recorded
#
#   PG_CONTAINER (default flora-core-postgres-1) and DB (default flora) choose the server and database.
#
# Every script from 0004 on is written to run again safely (IF NOT EXISTS, ON CONFLICT...); the base schema (0000-0003)
# is never applied here. Take a backup before applying to a shared server.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${PG_CONTAINER:-flora-core-postgres-1}"
DB="${DB:-flora}"
FROM="" ONLY="" LIST=0 DRY=0 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown option: $1 (see the top of $0)" >&2; exit 2 ;;
  esac
done
if [ "$LIST" = 0 ] && [ -z "$FROM$ONLY" ]; then
  echo "choose what to apply: --from NNNN or --only NNNN (or --list)" >&2
  exit 2
fi

psql_db() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" sh -c "psql -v ON_ERROR_STOP=1 -q -X -U \"\$POSTGRES_USER\" -d $DB $*"; }

if [ "$DRY" = 0 ] && [ "$LIST" = 0 ]; then
  psql_db <<'SQL'
CREATE TABLE IF NOT EXISTS flora_migration_log (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user
);
SQL
fi
applied="$(echo "SELECT name FROM flora_migration_log" | psql_db -t -A 2>/dev/null || true)"

# "<install name> <source path>" in install order (the initdb order: by name).
grep -E '^COPY ' "$REPO/Dockerfile.postgres.dev" | awk '{name=$3; sub(".*/", "", name); print name " " $2}' | sort |
while read -r name source; do
  number="$(printf '%s' "$name" | cut -c1-4)"
  done_here=0
  printf '%s\n' "$applied" | grep -qx "$name" && done_here=1
  if [ "$LIST" = 1 ]; then
    [ "$done_here" = 1 ] && echo "[x] $name" || echo "[ ] $name"
    continue
  fi
  [ "$number" -ge 4 ] 2>/dev/null || continue                      # never the base schema
  if [ -n "$ONLY" ]; then [ "$number" = "$ONLY" ] || continue; fi
  if [ -n "$FROM" ]; then [ "$number" -ge "$FROM" ] 2>/dev/null || continue; fi
  if [ "$done_here" = 1 ] && [ "$FORCE" = 0 ]; then
    echo "skip  $name (recorded as applied)"
    continue
  fi
  if [ "$DRY" = 1 ]; then
    echo "would apply $name"
    continue
  fi
  echo "apply $name"
  psql_db < "$REPO/$source" > /dev/null
  echo "INSERT INTO flora_migration_log (name) VALUES ('$name') ON CONFLICT (name) DO UPDATE SET applied_at = now(), applied_by = current_user" | psql_db
done
