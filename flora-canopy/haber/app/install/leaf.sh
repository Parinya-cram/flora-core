#!/bin/sh
# Flora iCIS Leaf installer, served by the hospital appliance (__HABER_URL__).
#   curl -fsSL __HABER_URL__/install/leaf.sh | sudo sh -s -- --code XXXX-XXXX-XXXX-XXXX
# Everything comes from the appliance on the hospital LAN (no internet): the one-time code from Root
# gives this machine its Leaf id, ward and bed; images come from the appliance registry; passwords and
# certificates are generated here and never leave this machine. Re-running with the same code resumes.
#
# Options: --dir DIR (default /opt/flora)   --https-port N (default 443, or the next free port)
#          --registry HOST:PORT (override)  --canopy URL (Canopy sync URL, override)
set -eu
HABER="__HABER_URL__"; CODE=""; BASE="/opt/flora"; HTTPS_PORT=""; REGISTRY=""; CANOPY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="${2:-}"; shift 2 ;;     --haber) HABER="${2:-}"; shift 2 ;;
    --dir) BASE="${2:-}"; shift 2 ;;      --https-port) HTTPS_PORT="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;; --canopy) CANOPY="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; [ -n "${CODE:-}" ] && curl -fsS -X POST -H 'content-type: application/json' \
  -d "$(printf '{"code":"%s","status":"failed","error":"%s"}' "$CODE" "$(printf '%s' "$*" | tr '"\n' "' " | cut -c1-400)")" \
  "$HABER/api/haber/v1/install/report" >/dev/null 2>&1 || true; exit 1; }
[ -n "$CODE" ] || { echo "usage: sh -s -- --code XXXX-XXXX-XXXX-XXXX" >&2; exit 2; }
for tool in curl openssl python3 docker; do command -v "$tool" >/dev/null || { echo "$tool is required on this machine" >&2; exit 1; }; done
docker compose version >/dev/null 2>&1 || { echo "docker compose (v2) is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "cannot use docker: run with sudo (or as a member of the docker group)" >&2; exit 1; }
json() { python3 -c 'import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=(d or {}).get(k) if isinstance(d, dict) else None
print("" if d is None else d)' "$1"; }

say "1/7 Claiming this machine with the appliance ($HABER)"
NODE=$(curl -fsS -X POST -H 'content-type: application/json' \
  -d "$(printf '{"code":"%s","kind":"leaf","hostname":"%s"}' "$CODE" "$(hostname)")" "$HABER/api/haber/v1/install/claim") \
  || { echo "the appliance refused the code (wrong, expired, or used by another machine)" >&2; exit 1; }
LEAF_ID=$(printf '%s' "$NODE" | json node_id); [ -n "$LEAF_ID" ] || die "unexpected answer from the appliance"
NAME=$(printf '%s' "$NODE" | json label); [ -n "$NAME" ] || NAME="$LEAF_ID"
TOKEN=$(printf '%s' "$NODE" | json node_token)
[ -n "$CANOPY" ] || CANOPY=$(printf '%s' "$NODE" | json canopy_sync_url)
[ -n "$CANOPY" ] || die "the appliance has no Canopy address for Leafs (set canopy_sync_public in Device Distribution settings)"
PROJECT="flora-$LEAF_ID"; DIR="$BASE/$LEAF_ID"
echo "Leaf $LEAF_ID ($NAME) · ward $(printf '%s' "$NODE" | json ward) · bed $(printf '%s' "$NODE" | json bed)"
install -d -m 750 "$DIR" "$DIR/certs" "$DIR/.release"

say "2/7 Fetching the approved Leaf release"
DESIRED=$(curl -fsS -H "authorization: Bearer $TOKEN" "$HABER/api/haber/v1/nodes/$LEAF_ID/desired?component=leaf") || die "cannot ask the appliance for the release"
RELEASE=$(printf '%s' "$DESIRED" | json release_id)
[ -n "$RELEASE" ] || die "no Leaf release is approved and mirrored on the appliance yet (approve one in Device Distribution)"
[ -n "$REGISTRY" ] || REGISTRY=$(printf '%s' "$DESIRED" | json registry)
printf '%s' "$DESIRED" | python3 -c '
import json, sys
d, registry, release = json.load(sys.stdin), sys.argv[1], sys.argv[2]
rel = next(r for r in d["envelope"]["bundle"]["releases"] if r["release_id"] == release)
print("# Written by leaf.sh; flora-updater rewrites it on each approved release.")
print("# release_id=" + release)
for key, image in sorted(rel["services"].items()):
    print("FLORA_IMAGE_%s=%s/%s@%s" % (key.upper(), registry, image["repository"], image["digest"]))
' "$REGISTRY" "$RELEASE" > "$DIR/.release/$PROJECT.env" || die "release $RELEASE is not in the signed release list"
for need in API SYNC WEB DB UPDATER; do grep -q "^FLORA_IMAGE_$need=" "$DIR/.release/$PROJECT.env" || die "release $RELEASE has no $need image (publish a full Leaf release)"; done
echo "release $RELEASE from $REGISTRY"

say "3/7 Registry access"
case "$REGISTRY" in
  localhost:*|127.*) ;;   # docker trusts a loopback registry without TLS
  *) if ! docker info 2>/dev/null | grep -q "$REGISTRY"; then
       [ "$(id -u)" = 0 ] || die "docker must trust the appliance registry $REGISTRY: re-run with sudo"
       python3 - "$REGISTRY" <<'PY' || die "cannot update /etc/docker/daemon.json"
import json, os, sys
path = "/etc/docker/daemon.json"
conf = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) else {}
conf["insecure-registries"] = sorted(set(conf.get("insecure-registries", [])) | {sys.argv[1]})
json.dump(conf, open(path, "w"), indent=2)
PY
       echo "docker now trusts $REGISTRY; restarting docker (other containers here restart too)"
       systemctl restart docker || die "docker restart failed"
     fi ;;
esac

say "4/7 Settings and secrets (generated here, kept in $DIR)"
for f in compose.yaml https.conf.template; do curl -fsS -o "$DIR/$f" "$HABER/install/files/leaf/$f" || die "cannot download $f"; done
free() { ! ss -Hltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"; }
if [ ! -f "$DIR/.env" ]; then
  [ -n "$HTTPS_PORT" ] || { HTTPS_PORT=443; while ! free "$HTTPS_PORT"; do [ "$HTTPS_PORT" = 443 ] && HTTPS_PORT=7443 || HTTPS_PORT=$((HTTPS_PORT + 10)); done; }
  API_PORT=7301; while ! free "$API_PORT"; do API_PORT=$((API_PORT + 10)); done
  rnd() { openssl rand -hex 24; }
  cat > "$DIR/.env" <<ENV
# Leaf $LEAF_ID — written by leaf.sh; secrets were generated on this machine.
FLORA_LEAF_ID=$LEAF_ID
FLORA_LEAF_NAME=$NAME
FLORA_HOSPITAL_ID=$(printf '%s' "$NODE" | json tenant_id)
CANOPY_SYNC_URL=$CANOPY
HABER_URL=$HABER
HABER_NODE_TOKEN=$TOKEN
FLORA_SYNC_SHARED_SECRET=$(printf '%s' "$NODE" | json sync_secret)
FLORA_LEAF_SERVICE_SECRET=$(rnd)
LEAF_DB_ADMIN_PASSWORD=$(rnd)
LEAF_DB_APP_PASSWORD=$(rnd)
LEAF_DB_VIEW_PASSWORD=$(rnd)
LEAF_DB_SYNC_PASSWORD=$(rnd)
LEAF_ADMIN_PASSWORD=$(rnd | cut -c1-16)
LEAF_HTTPS_PORT=$HTTPS_PORT
LEAF_API_PORT=$API_PORT
ENV
  chmod 600 "$DIR/.env"
fi
. "$DIR/.env"

say "5/7 Certificates"
if [ ! -f "$DIR/certs/server.crt" ]; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  openssl req -x509 -newkey rsa:2048 -nodes -days 1825 -subj "/CN=$LEAF_ID" -keyout "$DIR/certs/server.key" -out "$DIR/certs/server.crt" \
    -addext "subjectAltName=DNS:$(hostname),DNS:localhost${IP:+,IP:$IP},IP:127.0.0.1" >/dev/null 2>&1 || die "cannot make a certificate"
fi
CANOPY_HOST=$(printf '%s' "$CANOPY" | sed -E 's#^https?://##; s#/.*$##'); case "$CANOPY_HOST" in *:*) ;; *) CANOPY_HOST="$CANOPY_HOST:443" ;; esac
case "$CANOPY" in https://*)
  # Trust the hospital's Canopy certificate as the appliance network presents it (first contact).
  echo | openssl s_client -connect "$CANOPY_HOST" -showcerts 2>/dev/null | sed -n '/BEGIN CERT/,/END CERT/p' > "$DIR/certs/canopy.pem"
  [ -s "$DIR/certs/canopy.pem" ] || die "cannot reach Canopy at $CANOPY_HOST"
  cat /etc/ssl/certs/ca-certificates.crt "$DIR/certs/canopy.pem" > "$DIR/certs/flora-trust.pem" 2>/dev/null || cp "$DIR/certs/canopy.pem" "$DIR/certs/flora-trust.pem"
  echo "SSL_CERT_FILE=/etc/flora/certs/flora-trust.pem" > "$DIR/certs/trust.env" ;;
esac
chmod 640 "$DIR/certs/server.key"

say "6/7 Starting the Leaf (pulling images from the appliance; first time takes a few minutes)"
cd "$DIR"
COMPOSE="docker compose -p $PROJECT --project-directory $DIR -f $DIR/compose.yaml --env-file $DIR/.env --env-file $DIR/.release/$PROJECT.env"
$COMPOSE pull -q || die "cannot pull the Leaf images from $REGISTRY"
$COMPOSE up -d || die "docker compose up failed"
i=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' "$($COMPOSE ps -q leaf-api)" 2>/dev/null)" = healthy ]; do
  i=$((i + 1)); [ $i -le 60 ] || die "leaf-api did not become healthy: $($COMPOSE logs --tail 20 leaf-api 2>&1 | tail -5)"; sleep 5; done

say "7/7 Reporting to the appliance and Root"
curl -fsS -X POST -H 'content-type: application/json' -d "$(printf '{"code":"%s","status":"installed"}' "$CODE")" \
  "$HABER/api/haber/v1/install/report" >/dev/null || echo "(could not report yet; the Leaf runs anyway)"
echo "
Flora iCIS Leaf $LEAF_ID is running.
  Open:        https://$(hostname -I 2>/dev/null | awk '{print $1}'):$LEAF_HTTPS_PORT
  First login: admin / $LEAF_ADMIN_PASSWORD   (you must change it at first sign-in)
  Files:       $DIR
It joins Canopy on its first sync; the appliance then places it on its ward/bed."
