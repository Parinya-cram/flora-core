#!/usr/bin/env bash
# What takes the server's disk, and what can be given back safely.
#
#   ./scripts/server/disk-report.sh            # report only
#   ./scripts/server/disk-report.sh --clean    # also remove unused images, stopped containers, build cache > 7 days
#
# Never removes volumes (the database lives in one): an orphaned volume is listed for a person to decide.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f compose.dev.yaml)

echo "== disk"
df -h / || true
[ -d /var/lib/docker ] && df -h /var/lib/docker | tail -n +2 || true
echo
echo "== docker"
docker system df
echo
echo "== container logs (each capped by compose: FLORA_LOG_MAX_FILES x FLORA_LOG_MAX_SIZE)"
for container in $(docker ps -q); do
  log=$(docker inspect --format '{{.LogPath}}' "$container")
  size=$(sudo -n du -h "$log" 2>/dev/null | cut -f1 || echo "?")
  opts=$(docker inspect --format '{{.HostConfig.LogConfig.Config}}' "$container")
  printf "  %-40s %8s  %s\n" "$(docker inspect --format '{{.Name}}' "$container" | cut -c2-)" "$size" "$opts"
done
echo
echo "== volumes (an orphaned one, used by no container, is listed with no user)"
for volume in $(docker volume ls -q); do
  users=$(docker ps -a --filter volume="$volume" --format '{{.Names}}' | paste -sd, -)
  printf "  %-60s %s\n" "$volume" "${users:-(orphaned)}"
done
echo
echo "== largest tables in the Flora database"
"${COMPOSE[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-flora}" -c "
  SELECT s.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, s.n_live_tup AS rows
  FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12"' || echo "  (database not running)"
echo
echo "== uploads waiting in Form Studio (kept two hours)"
"${COMPOSE[@]}" exec -T flora-canopy-api sh -c 'du -sh "${FLORA_UPLOAD_DIR:-/tmp/flora-formdev-uploads}" 2>/dev/null || echo "  none"' 2>/dev/null || echo "  (canopy api not running)"
echo
echo "== backups"
du -sh ./backup 2>/dev/null || echo "  none"

if [ "${1:-}" = "--clean" ]; then
  echo
  echo "== cleaning: unused images, stopped containers, build cache older than 7 days (volumes are kept)"
  docker container prune -f
  docker image prune -a -f --filter until=168h
  docker builder prune -f --filter until=168h
  docker system df
fi
