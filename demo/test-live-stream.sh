#!/usr/bin/env bash
# End-to-end live stream test: simulated M540s → Gateway pod parser (virtual devices) →
# stream-hub WebSocket → leaf-live on a throwaway Leaf (leaf-test-01) → browser WebSocket.
# Several active cases, exclusive/shared bindings, case UUID audit at the Gateway,
# stream-hub outage + resume, discharge unbind. See docs/live-stream/PROTOCOL.md.
#
# Needs the Gateway stack (./demo/up.sh). The Gateway runs dev images (this source) during
# the test with its updater and Haber check-in stopped; afterwards it goes back to its pinned release unless
# KEEP_DEV=1. Never touches the demo Leaves.
set -euo pipefail
cd "$(dirname "$0")/.."
gw=(docker compose -f flora-gateway/compose.yaml -p flora-gateway --env-file flora-gateway/.env --profile demo --profile live)
leaf=(docker compose -f flora-leaf/compose.yaml -f flora-leaf/compose.demo-shared.yaml -p flora-leaf-test-01 --env-file demo/leaf-test-01.env --profile live)
gwsql() { docker exec flora-gateway-gateway-db-1 psql -U flora_gateway -d flora_gateway -qAtc "$1"; }
m540_image=$(gwsql "SELECT image FROM gateway_device_type WHERE code='draeger-iacs-m540'")

cleanup() {
  [ "${KEEP_LEAF:-0}" = 1 ] && return   # leave everything up for debugging
  "${leaf[@]}" down --volumes >/dev/null 2>&1 || true
  gwsql "UPDATE gateway_device_type SET image='$m540_image' WHERE code='draeger-iacs-m540';
         UPDATE gateway_device_instance SET enabled=false WHERE device_id LIKE 'm540-sim-%';" >/dev/null 2>&1 || true
  docker rm -f flora-gw-parser-pod-socket.m540-relay >/dev/null 2>&1 || true
  if [ "${KEEP_DEV:-0}" != 1 ] && [ -f flora-gateway/.release/flora-gateway.env ]; then
    "${gw[@]}" --env-file flora-gateway/.release/flora-gateway.env up -d >/dev/null 2>&1 || true
    "${gw[@]}" rm -sf stream-hub >/dev/null 2>&1 || true   # the release image has no stream-hub yet
  fi
}
trap cleanup EXIT

echo "== gateway: dev images, updater and Haber sync paused"
# Haber check-in would reset the M540 type to the release parser image (no pod mode yet).
HABER_URL=http://127.0.0.1:9 "${gw[@]}" up -d --build --scale updater=0
gwsql "UPDATE gateway_device_type SET image='flora-gateway-parser:dev', demux=true WHERE code='draeger-iacs-m540'"
until curl -fsS http://localhost:7400/health >/dev/null 2>&1; do sleep 2; done

echo "== leaf-test-01 (leaf-api + leaf-live)"
"${leaf[@]}" up -d --build leaf-db leaf-api leaf-live
until curl -fsS http://localhost:7321/health >/dev/null 2>&1; do sleep 2; done
until curl -fsS http://localhost:7323/health >/dev/null 2>&1; do sleep 2; done

"${PYTHON:-python3}" demo/live_stream_test.py   # needs websockets
