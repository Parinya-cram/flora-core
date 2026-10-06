#!/usr/bin/env bash
# Stops the demo. Data is kept; pass --reset to delete every demo volume too.
set -euo pipefail
cd "$(dirname "$0")/.."
flag=""
[ "${1:-}" = "--reset" ] && flag="--volumes"
for leaf in leaf-or-01 leaf-icu-01; do
  docker compose -f flora-leaf/compose.yaml -p "flora-$leaf" --env-file "flora-leaf/env/$leaf.env" down $flag
done
# Parser containers are started by gateway-service, not compose.
parsers=$(docker ps -aq --filter label=flora.gateway.role=parser)
[ -n "$parsers" ] && docker rm -f $parsers >/dev/null
docker compose -f flora-gateway/compose.yaml --profile demo down $flag
docker compose -f flora-canopy/compose.yaml down $flag
docker compose -f flora-root/compose.yaml down $flag
# Release pins written by flora-updater point at registries that were just wiped.
[ -n "$flag" ] && rm -rf flora-*/.release
