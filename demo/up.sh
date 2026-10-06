#!/usr/bin/env bash
# Starts the whole Flora platform on one machine: Root → Canopy → Gateway → 2 Leaves,
# then opens a demo case on each Leaf. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# Root and Canopy each have one TLS edge (443 in production). On this one machine they
# cannot both own 443, so the demo publishes Root on 8443 and Canopy on 9443.
export ROOT_HTTPS_PORT=${ROOT_HTTPS_PORT:-8443} ROOT_HTTP_PORT=${ROOT_HTTP_PORT:-8080}
export CANOPY_HTTPS_PORT=${CANOPY_HTTPS_PORT:-9443} CANOPY_HTTP_PORT=${CANOPY_HTTP_PORT:-9080}
export HABER_URL=${HABER_URL:-https://host.docker.internal:$CANOPY_HTTPS_PORT}

wait_for() {
  local name=$1 url=$2 ca=${3:-flora-canopy/edge/certs/ca.crt}
  for _ in $(seq 1 120); do
    if curl -fsS --cacert "$ca" "$url" >/dev/null 2>&1; then echo "  ok  $name"; return 0; fi
    sleep 2
  done
  echo "  !!  $name did not become healthy: $url" >&2
  exit 1
}

# A project the flora-updater already moved to a Haber release keeps it: its
# .release/<project>.env pins release images, which are pulled, never rebuilt.
up_app() {
  local dir=$1 project=$2 env_file=$3; shift 3
  local args=(-f "$dir/compose.yaml" -p "$project") build=(--build)
  [ -n "$env_file" ] && args+=(--env-file "$env_file")
  if [ -f "$dir/.release/$project.env" ]; then
    args+=(--env-file "$dir/.release/$project.env"); build=()
  fi
  docker compose "${args[@]}" "$@" up -d ${build[@]+"${build[@]}"}
}

echo "[1/4] flora-root (cloud)"
# TLS edge: dev CA + certificate on first run, trusted by this machine's Canopy (Haber).
flora-root/edge/make-dev-cert.sh
demo/install-root-ca.sh >/dev/null
up_app flora-root flora-root ""
wait_for "root api" http://localhost:7100/health
wait_for "root edge ($ROOT_HTTPS_PORT)" "https://localhost:$ROOT_HTTPS_PORT/api/v1/keys" flora-root/edge/certs/ca.crt

echo "[2/4] flora-canopy (hospital)"
# TLS edge: dev CA + certificate on first run, trusted by this machine's Leaf/Gateway.
flora-canopy/edge/make-dev-cert.sh
demo/install-canopy-ca.sh >/dev/null
up_app flora-canopy flora-canopy ""
wait_for "canopy edge ($CANOPY_HTTPS_PORT)" "https://localhost:$CANOPY_HTTPS_PORT/api/sync/v1/fingerprint"
wait_for "haber" http://localhost:7204/health

echo "[3/4] flora-gateway (devices) + simulator"
up_app flora-gateway flora-gateway "" --profile demo
wait_for "gateway service" http://localhost:7400/health
wait_for "gateway data-api (kong)" http://localhost:7410/data-api/health

echo "[4/4] flora-leaf x2 (workstations)"
for leaf in leaf-or-01 leaf-icu-01; do
  up_app flora-leaf "flora-$leaf" "flora-leaf/env/$leaf.env"
done
wait_for "leaf-or-01 api" http://localhost:7301/health
wait_for "leaf-icu-01 api" http://localhost:7311/health

echo "Opening demo cases"
python3 demo/seed-cases.py

cat <<URLS

Flora demo is running (all data is synthetic):
  Root (TLS edge)       https://localhost:$ROOT_HTTPS_PORT   (admin / admin)  443 in production
  Canopy (TLS edge)     https://localhost:$CANOPY_HTTPS_PORT   (admin / admin)  443 in production
  Canopy viewer (dev)   http://localhost:7200   (admin / admin)
  Canopy Haber          http://localhost:7204   (admin / admin)  releases · nodes
  Gateway admin         http://localhost:7400   (admin / admin)
  Device simulator      http://localhost:7420
  Leaf  OR-1            http://localhost:7300   (admin / admin)
  Leaf  ICU bed 1       http://localhost:7310   (admin / admin)
Vitals appear on each Leaf chart within about a minute. See demo/README.md.
Ship a release through Root -> Haber -> nodes:  ./demo/release.sh 1.2.3
URLS
