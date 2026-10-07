#!/bin/sh
# Run a perf script inside the API image on the compose network (Phase 4.13).
#   formdev/scripts/perf/run.sh load.py --records 100000 --noise 50000 --label 100k
# Credentials come from .env and are passed through the environment (never printed).
set -eu
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$1"; shift
PERF_PG_USER="$(grep -E '^FLORA_POSTGRES_ADMIN_USER=' "$REPO/.env" | cut -d= -f2-)"
PERF_PG_PASSWORD="$(grep -E '^FLORA_POSTGRES_ADMIN_PASSWORD=' "$REPO/.env" | cut -d= -f2-)"
export PERF_PG_USER PERF_PG_PASSWORD
exec docker run --rm --network flora-core-v2_default -v "$REPO":/repo -w /repo \
  -e PYTHONPATH=/repo/services/flora-api -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONUNBUFFERED=1 \
  -e PERF_PG_USER -e PERF_PG_PASSWORD -e PERF_PG_HOST=postgres -e PERF_PG_DB="${PERF_PG_DB:-flora_formdev_perf_test}" \
  -e PERF_LABEL="${PERF_LABEL:-}" \
  flora-core-v2-flora-canopy-api python "formdev/scripts/perf/$SCRIPT" "$@"
