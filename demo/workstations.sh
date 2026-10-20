#!/usr/bin/env bash
# Demo workstations for the OR → Recovery journey: OR-2 and Recovery as lean Leaf stacks
# (leaf-db, leaf-api, leaf-sync) on one shared docker network, next to OR-1 from demo/up.sh.
# Switch between them in any Leaf web (http://localhost:7300) from the login page or the user menu.
#   ./demo/workstations.sh up | down | status | assign
set -euo pipefail
cd "$(dirname "$0")/.."
LEAVES=(leaf-or-02 leaf-recovery-01)
NETWORK=flora-demo-leaves
compose() { docker compose -f flora-leaf/compose.yaml -f flora-leaf/compose.demo-shared.yaml -p "flora-$1" --env-file "flora-leaf/env/$1.env" "${@:2}"; }

assign() {
  # Rooms, beds and Leaf assignments in Canopy's OR Suite (account kcmh by default).
  docker exec flora-canopy-canopy-api-1 python -m app.demo_or_workstations "${FLORA_DEMO_ACCOUNT:-kcmh}"
}

case "${1:-up}" in
  up)
    docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
    for leaf in "${LEAVES[@]}"; do
      echo "== $leaf"
      compose "$leaf" up -d --build leaf-db leaf-api leaf-sync
    done
    echo "== waiting for the new Leafs to sync with Canopy"
    sleep 20
    assign
    ;;
  assign) assign ;;
  down)
    for leaf in "${LEAVES[@]}"; do compose "$leaf" down "${@:2}"; done
    ;;
  status)
    for leaf in "${LEAVES[@]}"; do
      port=$(grep '^LEAF_API_PORT=' "flora-leaf/env/$leaf.env" | cut -d= -f2)
      printf "%-14s api :%s  " "$leaf" "$port"
      curl -fsS -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1 && echo up || echo down
    done
    ;;
  *) echo "usage: $0 up|down|status|assign" >&2; exit 2 ;;
esac
