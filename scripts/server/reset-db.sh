#!/usr/bin/env bash
# Recreate the database from infrastructure/postgres/*.sql.
#
# Those files are mounted into /docker-entrypoint-initdb.d/ and postgres runs
# them only when the data volume is empty.  Applying a new migration therefore
# means destroying the volume: every case, account and setting is lost.  This
# is the shared server, so it affects both developers.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "This DELETES the shared Flora database and rebuilds it from migrations."
read -r -p "type RESET to continue: " ok
[ "$ok" = "RESET" ] || { echo "cancelled"; exit 1; }

./scripts/server/backup-db.sh || echo "(no running database to back up)"

docker compose -f compose.dev.yaml down -v
docker compose -f compose.dev.yaml up -d --build
echo "database recreated"
