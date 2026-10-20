#!/bin/sh
# CI: the database-backed API tests (scripts/test-leaf-writes.sh: Leaf writes, case forms, Leaf sync, hospital profile, case documents)
# on a throwaway PostgreSQL built as a new install builds it, with its own network and API image, all removed afterwards
# whatever happens. Needs only docker (the GitLab shell runner); nothing touches the dev stack or its .env.
#
#   scripts/ci-test-db.sh
#   TESTS=tests/test_case_forms.py scripts/ci-test-db.sh
#   API_IMAGE=flora-core-flora-canopy-api scripts/ci-test-db.sh   # an API image already built (no build)
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ID="flora-ci-${CI_PIPELINE_ID:-local}-$$"
PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  docker rm -f "$ID-pg" >/dev/null 2>&1 || true
  docker network rm "$ID" >/dev/null 2>&1 || true
  [ -n "${BUILT:-}" ] && docker image rm "$BUILT" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "== throwaway PostgreSQL and API image ($ID)"
docker network create "$ID" >/dev/null
docker run -d --name "$ID-pg" --network "$ID" --network-alias postgres \
  -e POSTGRES_USER=flora_ci -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=postgres postgres:17.6-alpine >/dev/null
if [ -z "${API_IMAGE:-}" ]; then
  BUILT="$ID-api"
  docker build -q -t "$BUILT" "$REPO/services/flora-api" >/dev/null
  API_IMAGE="$BUILT"
fi
# Over TCP: the image's first-init server listens on its socket only, so this waits for the real one.
tries=0
until docker exec "$ID-pg" pg_isready -q -h 127.0.0.1 -U flora_ci -d postgres; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || { echo "PostgreSQL did not start" >&2; docker logs "$ID-pg" >&2; exit 1; }
  sleep 1
done

PG_CONTAINER="$ID-pg" PG_NETWORK="$ID" API_IMAGE="$API_IMAGE" PG_ADMIN_USER=flora_ci PG_ADMIN_PASSWORD="$PASSWORD" \
  DB=flora_ci_test sh "$REPO/scripts/test-leaf-writes.sh"
