#!/usr/bin/env bash
# Restore a dump produced by backup-db.sh.  This overwrites the shared
# database for everyone, so confirm with the other developer first.
#
#   ./scripts/server/restore-db.sh backup/flora-20261005-120000.sql.gz
set -euo pipefail
cd "$(dirname "$0")/../.."

FILE=${1:?usage: restore-db.sh <dump.sql.gz>}
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
USER=${FLORA_POSTGRES_ADMIN_USER:-flora_admin}
DB=${FLORA_POSTGRES_DB:-flora}

read -r -p "overwrite the shared '$DB' database from $FILE? [y/N] " ok
[ "$ok" = "y" ] || { echo "cancelled"; exit 1; }

gunzip -c "$FILE" | docker compose -f compose.dev.yaml exec -T postgres \
  psql -U "$USER" -d "$DB" -v ON_ERROR_STOP=1

docker compose -f compose.dev.yaml restart flora-leaf-api flora-sync-api
echo "restored from $FILE"
