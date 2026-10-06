#!/usr/bin/env bash
# Proves Leaf → Canopy sync recovers by itself after Canopy is unreachable:
# offline notes/edits/deletes, a case started and discharged offline, late entries after
# discharge, no duplicates, with and without a sync-worker restart during the outage.
# Needs the demo running (./demo/up.sh). Briefly stops Canopy's sync-api.
set -euo pipefail
cd "$(dirname "$0")/.."
leaf=(docker compose -f flora-leaf/compose.yaml -p flora-leaf-test-01 --env-file demo/leaf-test-01.env)
cleanup() {
  docker compose -f flora-canopy/compose.yaml start sync-api >/dev/null 2>&1 || true
  "${leaf[@]}" down --volumes >/dev/null 2>&1 || true
  docker exec flora-canopy-canopy-db-1 psql -U flora_admin -d flora -qAtc \
    "DELETE FROM canopy_case_handover WHERE from_leaf_id='leaf-test-01' OR to_leaf_id='leaf-test-01'; DELETE FROM canopy_case_export WHERE leaf_id='leaf-test-01'; DELETE FROM sync_case_index WHERE leaf_id='leaf-test-01'; DELETE FROM sync_message WHERE leaf_id='leaf-test-01'; DELETE FROM sync_leaf_node WHERE leaf_id='leaf-test-01';" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${leaf[@]}" up -d --build leaf-db leaf-api leaf-sync
until curl -fsS http://localhost:7321/health >/dev/null 2>&1; do sleep 2; done
sleep 8
echo "=== outage"
python3 demo/sync_outage_test.py
echo "=== outage with sync-worker restart"
python3 demo/sync_outage_test.py --restart-worker
