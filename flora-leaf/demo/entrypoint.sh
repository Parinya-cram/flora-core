#!/usr/bin/env bash
# Demo only: run every Leaf in FLORA_DEMO_LEAVES inside this one container.
#   FLORA_DEMO_LEAVES="leaf-or-01|OR-1|Operating Room 1;leaf-icu-01|ICU|ICU Bed 1"   (optional 4th field: database)
# Per Leaf: its own database on leaf-db (created on first start), leaf-api on 127.0.0.1:8001.., a sync worker.
# nginx on :80 serves the UI, routes /ws/<leaf-id>/ to that Leaf and /api/ to the first one, and publishes
# /demo-workstations.js so the UI's workstation switcher lists these Leafs.
set -euo pipefail

: "${FLORA_DEMO_LEAVES:?set FLORA_DEMO_LEAVES}"
DB_HOST=${LEAF_DB_HOST:-leaf-db}
export PGPASSWORD=${LEAF_DB_ADMIN_PASSWORD:?set LEAF_DB_ADMIN_PASSWORD} PGOPTIONS="-c client_min_messages=warning"
admin_psql() { psql -h "$DB_HOST" -U "${LEAF_DB_ADMIN_USER:-flora_admin}" --no-psqlrc -v ON_ERROR_STOP=1 -q "$@"; }

until admin_psql -d postgres -c 'SELECT 1' >/dev/null 2>&1; do echo "waiting for $DB_HOST"; sleep 2; done

# Build a missing database under a temporary name, then rename it, so a failed init is redone next start.
ensure_database() {
  local db=$1 building="$1__init"
  [ "$(admin_psql -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$db'")" = 1 ] && return
  echo "== creating database $db"
  admin_psql -d postgres -c "DROP DATABASE IF EXISTS \"$building\"" -c "CREATE DATABASE \"$building\""
  for script in /initdb/*.sql; do admin_psql -d "$building" -f "$script" >/dev/null; done
  admin_psql -d postgres -c "ALTER DATABASE \"$building\" RENAME TO \"$db\""
}

IFS=';' read -ra ENTRIES <<< "$FLORA_DEMO_LEAVES"
port=8000
locations=""
workstations="[]"
for entry in "${ENTRIES[@]}"; do
  IFS='|' read -r leaf_id short name db <<< "$entry"
  [ -n "$leaf_id" ] || continue
  port=$((port + 1))
  db=${db:-flora_${leaf_id//-/_}}
  ensure_database "$db"

  (
    export FLORA_LEAF_ID=$leaf_id FLORA_LEAF_NAME=$name
    export FLORA_DATABASE_URL="postgresql://flora_app:${LEAF_DB_APP_PASSWORD}@${DB_HOST}:5432/${db}"
    export FORMDEV_JOB_DIR=/var/lib/flora/$leaf_id/formdev-jobs
    export VECTOR_READ_URL="${FLORAICIS_GATEWAY_URL}/data-api/${leaf_id}/api/observations"
    cd /app && exec uvicorn app.main:app --host 127.0.0.1 --port "$port" 2>&1 | sed -u "s/^/[$leaf_id api] /"
  ) &
  (
    export FLORA_LEAF_ID=$leaf_id FLORA_LEAF_NAME=$name FLORA_LEAF_API_URL=http://127.0.0.1:$port
    until python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$port/health', timeout=2)" 2>/dev/null; do sleep 2; done
    cd /worker && exec python sync_worker.py 2>&1 | sed -u "s/^/[$leaf_id sync] /"
  ) &

  [ -n "$locations" ] || first_port=$port
  locations+="
  location /ws/$leaf_id/ {
    proxy_pass http://127.0.0.1:$port/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 300s;
  }"
  workstations=$(LEAF_ID=$leaf_id SHORT=${short:-$leaf_id} NAME=${name:-$leaf_id} LIST=$workstations python -c '
import json, os
items = json.loads(os.environ["LIST"])
base = "/ws/" + os.environ["LEAF_ID"]
items.append({"id": os.environ["LEAF_ID"], "name": os.environ["SHORT"], "role": os.environ["NAME"], "apiBase": base, "liveBase": base})
print(json.dumps(items))')
done

echo "window.__FLORA_DEMO_WORKSTATIONS__ = $workstations;" > /usr/share/nginx/html/demo-workstations.js
cat > /etc/nginx/conf.d/default.conf <<EOF
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  client_max_body_size 50m;

  location / { try_files \$uri \$uri/ /index.html; }
  location = /demo-workstations.js { add_header Cache-Control no-store; }
$locations

  # Anything without a /ws/<leaf-id>/ prefix goes to the first Leaf.
  location /api/ {
    proxy_pass http://127.0.0.1:$first_port;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 300s;
  }
  location /health { proxy_pass http://127.0.0.1:$first_port; }
}
EOF
nginx -g 'daemon off;' &

# Any process ending stops the container, so Docker's restart policy brings every Leaf back together.
wait -n
echo "a demo Leaf process exited; stopping" >&2
exit 1
