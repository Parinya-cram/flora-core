#!/bin/sh
# Flora iCIS gateway installer, served by the hospital appliance (__HABER_URL__).
#   curl -fsSL __HABER_URL__/install/gateway.sh | sudo sh -s -- --code XXXX-XXXX-XXXX-XXXX
# Everything comes from the appliance on the hospital LAN (no internet): the one-time code from Root gives
# this machine its gateway id; images (Flora's and the Kafka / Postgres / Kong / nginx it runs) come from
# the appliance registry; passwords and certificates are generated here. Devices are added afterwards in
# the gateway admin page, and Leafs connect to it from their Ward page. One gateway per machine.
#
# Options: --dir DIR (default /opt/flora)   --https-port N (default 443, or the next free port)
#          --registry HOST:PORT (override)
set -eu
HABER="__HABER_URL__"; CODE=""; BASE="/opt/flora"; HTTPS_PORT=""; REGISTRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="${2:-}"; shift 2 ;;     --haber) HABER="${2:-}"; shift 2 ;;
    --dir) BASE="${2:-}"; shift 2 ;;      --https-port) HTTPS_PORT="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;;
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
  -d "$(printf '{"code":"%s","kind":"gateway","hostname":"%s"}' "$CODE" "$(hostname)")" "$HABER/api/haber/v1/install/claim") \
  || { echo "the appliance refused the code (wrong, expired, or used by another machine)" >&2; exit 1; }
GW_ID=$(printf '%s' "$NODE" | json node_id); [ -n "$GW_ID" ] || die "unexpected answer from the appliance"
NAME=$(printf '%s' "$NODE" | json label); [ -n "$NAME" ] || NAME="$GW_ID"
TOKEN=$(printf '%s' "$NODE" | json node_token); GW_TOKEN=$(printf '%s' "$NODE" | json gateway_token)
PROJECT="flora-gateway"; DIR="$BASE/$GW_ID"
if docker ps -a --format '{{.Label "com.docker.compose.project"}} {{.Label "com.docker.compose.project.working_dir"}}' | grep -q "^flora-gateway " \
   && ! docker ps -a --format '{{.Label "com.docker.compose.project.working_dir"}}' | grep -qx "$DIR"; then
  die "this machine already runs a Flora gateway (another folder); one gateway per machine"
fi
echo "Gateway $GW_ID ($NAME)"
install -d -m 755 "$DIR" "$DIR/config" "$DIR/kong" "$DIR/edge" "$DIR/db"   # read by Kong / nginx / Postgres users
install -d -m 750 "$DIR/certs" "$DIR/.release"

say "2/7 Fetching the approved gateway release"
DESIRED=$(curl -fsS -H "authorization: Bearer $TOKEN" "$HABER/api/haber/v1/nodes/$GW_ID/desired?component=gateway") || die "cannot ask the appliance for the release"
RELEASE=$(printf '%s' "$DESIRED" | json release_id)
[ -n "$RELEASE" ] || die "no gateway release is approved and mirrored on the appliance yet (approve one in Device Distribution)"
[ -n "$REGISTRY" ] || REGISTRY=$(printf '%s' "$DESIRED" | json registry)
printf '%s' "$DESIRED" | python3 -c '
import json, sys
d, registry, release = json.load(sys.stdin), sys.argv[1], sys.argv[2]
rel = next(r for r in d["envelope"]["bundle"]["releases"] if r["release_id"] == release)
print("# Written by gateway.sh; flora-updater rewrites it on each approved release.")
print("# release_id=" + release)
for key, image in sorted(rel["services"].items()):
    print("FLORA_IMAGE_%s=%s/%s@%s" % (key.upper(), registry, image["repository"], image["digest"]))
' "$REGISTRY" "$RELEASE" > "$DIR/.release/$PROJECT.env" || die "release $RELEASE is not in the signed release list"
for need in RUST SERVICE PARSER UPDATER KAFKA DB KONG EDGE; do grep -q "^FLORA_IMAGE_$need=" "$DIR/.release/$PROJECT.env" || die "release $RELEASE has no $need image (publish a full gateway release)"; done
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
fetch() { curl -fsS -o "$DIR/$2" "$HABER/install/files/gateway/$1" || die "cannot download $1"; }
fetch compose.yaml compose.yaml; fetch nginx.conf edge/nginx.conf
fetch 0001-gateway.sql db/0001-gateway.sql; fetch 0002-device-measurements.sql db/0002-device-measurements.sql
# Starting config only once: afterwards the gateway admin page owns config/ and kong/.
[ -f "$DIR/config/gateway.toml" ] || { fetch gateway.toml config/gateway.toml; sed -i "s/__GATEWAY_ID__/$GW_ID/" "$DIR/config/gateway.toml"; }
[ -f "$DIR/config/instances.json" ] || fetch instances.json config/instances.json
[ -f "$DIR/kong/kong.yaml" ] || fetch kong.yaml kong/kong.yaml
# Serial ports present on this machine go to serial-controller (configure them in the admin page).
{ echo "# Serial ports found by gateway.sh on $(hostname)"; echo "services:"; echo "  serial-controller:"
  PORTS=$(ls /dev/ttyS[0-3] /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true)
  if [ -n "$PORTS" ]; then echo "    devices:"; for p in $PORTS; do echo "      - \"$p:$p\""; done; else echo "    environment: {}"; fi
} > "$DIR/compose.devices.yaml"
free() { ! ss -Hltn 2>/dev/null | awk '{print $4}' | grep -q ":$1\$"; }
if [ ! -f "$DIR/.env" ]; then
  [ -n "$HTTPS_PORT" ] || { HTTPS_PORT=443; while ! free "$HTTPS_PORT"; do [ "$HTTPS_PORT" = 443 ] && HTTPS_PORT=7443 || HTTPS_PORT=$((HTTPS_PORT + 10)); done; }
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  rnd() { openssl rand -hex 24; }
  cat > "$DIR/.env" <<ENV
# Gateway $GW_ID — written by gateway.sh; secrets were generated on this machine.
FLORA_GATEWAY_ID=$GW_ID
HABER_URL=$HABER
HABER_GATEWAY_TOKEN=$GW_TOKEN
HABER_NODE_TOKEN=$TOKEN
GATEWAY_DATA_API_URL=https://$IP:$HTTPS_PORT/data-api
FLORA_GATEWAY_DB_PASSWORD=$(rnd)
GATEWAY_ADMIN_PASSWORD=$(rnd | cut -c1-16)
GATEWAY_HTTPS_PORT=$HTTPS_PORT
ENV
  chmod 600 "$DIR/.env"
fi
envget() { sed -n "s/^$1=//p" "$DIR/.env" | tr -d '"'; }
chmod -R a+rX "$DIR/config" "$DIR/kong" "$DIR/edge" "$DIR/db"   # no secrets in these
GATEWAY_HTTPS_PORT=$(envget GATEWAY_HTTPS_PORT); GATEWAY_ADMIN_PASSWORD=$(envget GATEWAY_ADMIN_PASSWORD)

say "5/7 Certificates"
if [ ! -f "$DIR/certs/server.crt" ]; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  openssl req -x509 -newkey rsa:2048 -nodes -days 1825 -subj "/CN=$GW_ID" -keyout "$DIR/certs/server.key" -out "$DIR/certs/server.crt" \
    -addext "subjectAltName=DNS:$(hostname),DNS:localhost${IP:+,IP:$IP},IP:127.0.0.1" >/dev/null 2>&1 || die "cannot make a certificate"
fi
chmod 640 "$DIR/certs/server.key"

say "6/7 Starting the gateway (pulling images from the appliance; first time takes a few minutes)"
cd "$DIR"
COMPOSE="docker compose -p $PROJECT --project-directory $DIR -f $DIR/compose.yaml -f $DIR/compose.devices.yaml --env-file $DIR/.env --env-file $DIR/.release/$PROJECT.env"
$COMPOSE pull -q || die "cannot pull the gateway images from $REGISTRY"
# The updater starts last, once the stack is healthy, so it never recreates services mid-start.
$COMPOSE up -d --scale updater=0 || die "docker compose up failed"
i=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' "$($COMPOSE ps -q kong)" 2>/dev/null)" = healthy ] \
  && curl -fsS -o /dev/null http://127.0.0.1:7400/health 2>/dev/null; do
  i=$((i + 1)); [ $i -le 90 ] || die "the gateway did not come up: $($COMPOSE logs --tail 20 gateway-service 2>&1 | tail -5)"; sleep 5; done
$COMPOSE up -d updater >/dev/null || die "the updater did not start"

say "7/7 Reporting to the appliance and Root"
curl -fsS -X POST -H 'content-type: application/json' -d "$(printf '{"code":"%s","status":"installed"}' "$CODE")" \
  "$HABER/api/haber/v1/install/report" >/dev/null || echo "(could not report yet; the Leaf runs anyway)"
echo "
Flora iCIS gateway $GW_ID is running.
  Admin page:  https://$(hostname -I 2>/dev/null | awk '{print $1}'):$GATEWAY_HTTPS_PORT   (admin / $GATEWAY_ADMIN_PASSWORD)
  Data API:    $(envget GATEWAY_DATA_API_URL)   (what Leafs connect to from their Ward page)
  Files:       $DIR
Next: add this gateway's devices and ports in the admin page; it checks in with the appliance by itself."
