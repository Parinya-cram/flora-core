#!/bin/sh
# End-to-end test of the form loop (services/flora-api/tests/e2e_form_flow.py): Form Studio → Workflow Studio → Flora Leaf
# → back to Canopy, on a disposable database, with the Leaf API, Canopy sync API and Canopy API each in its own mode and
# the real sync worker code.
#
#   scripts/test-form-flow.sh                         # build, run, drop; step report in ./e2e-form-flow.json
#   KEEP=1 REPORT_DIR=/some/dir scripts/test-form-flow.sh
#
# The API image has no httpx (the worker's HTTP client): it is borrowed from the sync worker image, nothing is downloaded.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_IMAGE="${WORKER_IMAGE:-flora-core-flora-leaf-sync}"
REPORT_DIR="${REPORT_DIR:-$PWD}"
LIB="$(mktemp -d)"
trap 'rm -rf "$LIB"' EXIT
container="$(docker create "$WORKER_IMAGE")"
for package in httpx httpcore h11 anyio certifi idna sniffio; do
  docker cp "$container:/usr/local/lib/python3.13/site-packages/$package" "$LIB/" 2>/dev/null || true
done
docker rm "$container" > /dev/null
mkdir -p "$REPORT_DIR"
# The Leaf's own database (as in production), built the same way; the flow below drops it again.
LEAF_DB="${LEAF_DB:-flora_form_flow_leaf_test}"
echo "== Leaf database $LEAF_DB"
DB="$LEAF_DB" TESTS="tests/test_case_forms_merge.py" KEEP=1 sh "$REPO/scripts/test-leaf-writes.sh" > /dev/null
ADMIN="$(grep -E '^FLORA_POSTGRES_ADMIN_USER=' "$REPO/.env" | cut -d= -f2-)"
PASSWORD="$(grep -E '^FLORA_POSTGRES_ADMIN_PASSWORD=' "$REPO/.env" | cut -d= -f2- || true)"
[ -n "$PASSWORD" ] || PASSWORD="$(docker exec "${PG_CONTAINER:-flora-core-postgres-1}" printenv POSTGRES_PASSWORD)"
status=0
DB="${DB:-flora_form_flow_test}" TESTS="tests/e2e_form_flow.py" \
API_DOCKER_ARGS="-v $LIB:/e2elib -v $REPORT_DIR:/report -e PYTHONPATH=/repo/services/flora-api:/e2elib -e E2E_REPORT=/report/e2e-form-flow.json -e E2E_LEAF_DATABASE_URL=postgresql://$ADMIN:$PASSWORD@postgres:5432/$LEAF_DB" \
  sh "$REPO/scripts/test-leaf-writes.sh" || status=$?
[ "${KEEP:-0}" = "1" ] || echo "DROP DATABASE IF EXISTS $LEAF_DB WITH (FORCE)" | docker exec -i "${PG_CONTAINER:-flora-core-postgres-1}" sh -c 'psql -q -U "$POSTGRES_USER" -d postgres'
exit "$status"
