#!/usr/bin/env bash
# Update the shared development server from git.
#
# The dev stack bind-mounts ../frontend and ../services/flora-api/app, and the
# API runs uvicorn --reload, so ordinary source changes take effect from the
# pull alone.  Only dependency, image or compose changes need a rebuild.
#
#   ./scripts/server/deploy.sh            # pull, rebuild only when required
#   ./scripts/server/deploy.sh --force    # always rebuild
#
# Migrations are NOT applied automatically: infrastructure/postgres/*.sql runs
# only when the postgres volume is first created.  A new file there is reported
# and must be applied deliberately (see reset-db.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."

COMPOSE=(docker compose -f compose.dev.yaml)
FORCE=${1:-}

before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ] && [ "$FORCE" != "--force" ]; then
  echo "already up to date at ${after:0:8}"
  exit 0
fi

changed=$(git diff --name-only "$before" "$after")

rebuild=0
if [ "$FORCE" = "--force" ]; then
  rebuild=1
elif grep -qE '(^|/)(Dockerfile[^/]*|requirements\.txt|package\.json|package-lock\.json)$|^compose' <<<"$changed"; then
  rebuild=1
fi

if [ "$rebuild" -eq 1 ]; then
  echo "rebuilding"
  "${COMPOSE[@]}" up -d --build
else
  echo "hot reload only; no rebuild needed"
  "${COMPOSE[@]}" up -d --remove-orphans
fi

if grep -q '^infrastructure/postgres/' <<<"$changed"; then
  echo
  echo "!! new or changed database migration:"
  grep '^infrastructure/postgres/' <<<"$changed" | sed 's/^/     /'
  echo "!! these run only on a fresh volume.  Back up, then:"
  echo "     ./scripts/server/backup-db.sh"
  echo "     ./scripts/server/reset-db.sh"
fi

echo
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
echo "deployed ${after:0:8}"
