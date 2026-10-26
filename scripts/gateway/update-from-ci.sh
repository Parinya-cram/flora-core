#!/bin/sh
# Runs ON the gateway (e.g. .233), started by the CI job deploy-gateway-233: the job has just pushed the branch's
# commit into this checkout as refs/heads/ci-incoming. Moves the checkout to it, rebuilds the gateway images and
# recreates only the services whose image or settings changed (compose decides), then checks the admin API.
# Usage: sh update-from-ci.sh <branch>   (run from anywhere; FLORA_REPO overrides the checkout path)
set -eu
BRANCH="${1:-device-distribution}"
REPO="${FLORA_REPO:-$HOME/flora/flora-core}"
COMPOSE_FILE="${FLORA_GATEWAY_COMPOSE:-compose.production.yaml}"
cd "$REPO"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "gateway checkout has local changes; not updating (commit or stash them first):" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi
before=$(git rev-parse --short HEAD)
git checkout -q -B "$BRANCH" ci-incoming
echo "== $BRANCH: $before -> $(git rev-parse --short HEAD)"
cd flora-gateway
docker compose -f "$COMPOSE_FILE" build -q
docker compose -f "$COMPOSE_FILE" up -d --no-build 2>&1 | grep -E "Recreated|Created|Started|Error" || echo "(no service changed)"
for i in $(seq 1 60); do curl -sf -m3 http://127.0.0.1:7400/health >/dev/null && break; sleep 2; done
curl -sf -m3 http://127.0.0.1:7400/health || { echo "gateway-service is not healthy" >&2; exit 1; }
echo
docker compose -f "$COMPOSE_FILE" ps --format "{{.Service}}\t{{.Status}}"
