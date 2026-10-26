#!/usr/bin/env bash
# One-time move of the production (floraicis) Canopy to multi-account: its `public` schema becomes
# account kcmh (schema acct_kcmh). Run from the repo root:
#
#   scripts/tenancy/floraicis-adopt-kcmh.sh check     # read-only: expected state, compose config
#   scripts/tenancy/floraicis-adopt-kcmh.sh run       # backup, build, adopt, migrate 0088/0089, restart
#   scripts/tenancy/floraicis-adopt-kcmh.sh verify    # account list, service health
#
# The production database was created 2026-10-16 from Dockerfile.postgres.dev without 0088 / 0089;
# adopt-public records every bundle file as applied, so those two are un-recorded and applied after.
set -euo pipefail
cd "$(dirname "$0")/../.."

export DOCKER_CONTEXT=default
CODE=kcmh
NAME="King Chulalongkorn Memorial Hospital"
MISSING=("0088-digital-twin.sql" "0089-or-schedule.sql")
DB=floraicis-db-canopy-db-1
API=floraicis-canopy-canopy-api-1
PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$API")
DC=(docker compose -p "$PROJECT" -f canopy.floraicis.prod.yml --env-file floraicis.prod.env)

sql() { docker exec -i "$DB" psql -U flora_admin -d flora -v ON_ERROR_STOP=1 -Atc "$1"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

check() {
  step "compose project $PROJECT"
  "${DC[@]}" config --quiet || die "compose config does not resolve"
  step "database state"
  [[ $(sql "SELECT to_regclass('public.auth_user') IS NOT NULL") == t ]] || die "public holds no Canopy data"
  if [[ $(sql "SELECT to_regclass('platform.account') IS NOT NULL") == t ]]; then
    [[ $(sql "SELECT count(*) FROM platform.account") == 0 ]] || die "accounts exist already"
  fi
  [[ $(sql "SELECT to_regclass('public.canopy_patient_movement') IS NULL") == t ]] || die "0088 is applied already: fix MISSING"
  [[ $(sql "SELECT to_regclass('public.canopy_or_type') IS NULL") == t ]] || die "0089 is applied already: fix MISSING"
  echo "public: $(sql "SELECT count(*) FROM pg_tables WHERE schemaname='public'") tables," \
       "$(sql "SELECT count(*) FROM public.auth_user") users, 0088/0089 not applied, no accounts: ok"
}

run() {
  check
  secret=$(grep -m1 '^FLORA_SYNC_SHARED_SECRET=' floraicis.prod.env | cut -d= -f2- | sed -E "s/^['\"](.*)['\"]$/\1/")
  [[ -n $secret ]] || die "FLORA_SYNC_SHARED_SECRET is empty in floraicis.prod.env"

  step "backup"
  mkdir -p backup
  dump="backup/floraicis-canopy-$(date +%Y%m%d-%H%M).dump"
  docker exec "$DB" pg_dump -U flora_admin -Fc flora > "$dump"
  docker exec -i "$DB" pg_restore -l < "$dump" > /dev/null || die "backup $dump is unreadable"
  ls -lh "$dump"

  step "build (services keep running)"
  "${DC[@]}" build canopy-api sync-api flora-mcp canopy-web

  step "stop database users"
  "${DC[@]}" stop canopy-api sync-api flora-mcp haber

  step "adopt public as $CODE"
  "${DC[@]}" run --rm --no-deps -e FLORA_SYNC_SHARED_SECRET="$secret" canopy-api \
    python -m app.cli_accounts adopt-public "$CODE" "$NAME"
  for file in "${MISSING[@]}"; do
    sql "DELETE FROM platform.schema_migration WHERE account_code='$CODE' AND file_name='$file'"
  done
  "${DC[@]}" run --rm --no-deps canopy-api python -m app.cli_accounts migrate "$CODE"

  step "start on the new code"
  "${DC[@]}" up -d canopy-api sync-api flora-mcp haber canopy-web
  verify
  echo; echo "Done. Backup: $dump"
}

verify() {
  step "accounts"
  "${DC[@]}" exec -T canopy-api python -m app.cli_accounts list
  step "services"
  sleep 15
  "${DC[@]}" ps --format '{{.Service}}\t{{.Status}}'
}

case "${1:-}" in
  check) check ;;
  run) run ;;
  verify) verify ;;
  *) sed -n 2,8p "$0"; exit 2 ;;
esac
