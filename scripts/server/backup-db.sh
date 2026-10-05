#!/usr/bin/env bash
# Dump the shared Leaf database.  One stack, one database, both developers
# share it, so take a backup before anything destructive.
#
#   ./scripts/server/backup-db.sh [output-dir]      (default: ./backup)
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=${1:-./backup}
USER=${FLORA_POSTGRES_ADMIN_USER:-flora_admin}
DB=${FLORA_POSTGRES_DB:-flora}
mkdir -p "$OUT"
FILE="$OUT/flora-$(date +%Y%m%d-%H%M%S).sql.gz"

docker compose -f compose.dev.yaml exec -T postgres \
  pg_dump -U "$USER" -d "$DB" --clean --if-exists | gzip > "$FILE"

# keep the 20 most recent
ls -1t "$OUT"/flora-*.sql.gz 2>/dev/null | tail -n +21 | xargs -r rm --

echo "$FILE  ($(du -h "$FILE" | cut -f1))"
