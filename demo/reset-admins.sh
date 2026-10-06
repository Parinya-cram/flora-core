#!/usr/bin/env bash
# Resets the `admin` account on every Leaf and on Canopy to admin / admin and
# clears the forced password change. Demo installs only.
set -euo pipefail
reset() {
  local api=$1 db=$2
  local record
  record=$(docker exec "$api" python -c "from app.routes.auth_leaf import new_password_record; print(*new_password_record('admin'))")
  local salt=${record% *} hash=${record#* }
  docker exec "$db" psql -U flora_admin -d flora -qAtc \
    "UPDATE auth_user SET password_salt='$salt', password_hash='$hash', must_change_password=0, is_active=1 WHERE lower(username)='admin' RETURNING 'reset admin on $api'"
}
reset flora-leaf-or-01-leaf-api-1  flora-leaf-or-01-leaf-db-1
reset flora-leaf-icu-01-leaf-api-1 flora-leaf-icu-01-leaf-db-1
reset flora-canopy-canopy-api-1    flora-canopy-canopy-db-1
