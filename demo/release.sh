#!/usr/bin/env bash
# Ships one release of every component through the whole chain:
#   Root CI builds + pushes images  ->  Root publishes signed release
#   ->  Haber mirrors the digests   ->  hospital admin approves  ->  flora-updater rolls each node.
# Usage: ./demo/release.sh <version> [component...]     e.g. ./demo/release.sh 1.2.3 leaf
set -euo pipefail
cd "$(dirname "$0")/.."
version=${1:?usage: demo/release.sh <version> [canopy|leaf|gateway ...]}
shift
components=("$@"); [ ${#components[@]} -eq 0 ] && components=(gateway leaf canopy)
HABER=http://localhost:7204
AUTH=admin:admin   # demo hospital admin

for component in "${components[@]}"; do
  echo "== $component $version: build + push + publish (Root CI)"
  python3 flora-root/scripts/publish_release.py "$component" "$version" --notes "demo/release.sh"
done

curl -fsS -u "$AUTH" -X POST "$HABER/api/haber/v1/root/sync" >/dev/null
for component in "${components[@]}"; do
  id="$component-$version"
  printf "== %s: waiting for Haber to mirror" "$id"
  for _ in $(seq 1 120); do
    if curl -fsS -u "$AUTH" -X POST "$HABER/api/haber/v1/releases/$id/approve" >/dev/null 2>&1; then
      echo " - approved"; continue 2
    fi
    printf "."; sleep 3
  done
  echo " - not mirrored in time; approve it in Haber ($HABER/#releases)" >&2
done
echo "Nodes pick it up within ~30s (Leaves wait until no case is open). Watch: $HABER/#nodes or ./demo/status.sh"
