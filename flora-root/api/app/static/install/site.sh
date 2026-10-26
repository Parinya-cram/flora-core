#!/bin/sh
# Flora iCIS hospital site installer: Canopy + appliance (Haber) on the hospital's main server.
#   curl -fsSL __ROOT_URL__/install/site.sh | sudo sh -s -- --code XXXX-XXXX-XXXX-XXXX
# The one-time code (Root > Topology > hospital > Install site server) is traded at Root for this
# hospital's appliance credentials. Images come from Root's registry, pinned by the signed Canopy release.
# Passwords and certificates are generated here and stored as k8s Secrets on this server only.
# Without a cluster it installs k3s (needs internet, like the appliance itself).
#
# Options: --ip IP (default: this server's address)   --prefix NAME (namespaces NAME-canopy / NAME-appliance; flora)
#          --canopy-port 9443  --haber-port 7204  --registry-port 7205   --existing-cluster (never install k3s)
#          --root-insecure (Root has a self-signed certificate)
set -eu
ROOT="__ROOT_URL__"; CODE=""; IP=""; P="flora"; CANOPY_PORT=9443; HABER_PORT=7204; REGISTRY_PORT=7205
EXISTING=0; K="-fsS"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;          --code) CODE="${2:-}"; shift 2 ;;
    --ip) IP="${2:-}"; shift 2 ;;              --prefix) P="${2:-}"; shift 2 ;;
    --canopy-port) CANOPY_PORT="${2:-}"; shift 2 ;; --haber-port) HABER_PORT="${2:-}"; shift 2 ;;
    --registry-port) REGISTRY_PORT="${2:-}"; shift 2 ;;
    --existing-cluster) EXISTING=1; shift ;;   --root-insecure) K="-fsSk"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
[ -n "$CODE" ] || { echo "usage: sh -s -- --code XXXX-XXXX-XXXX-XXXX" >&2; exit 2; }
for tool in curl openssl python3; do command -v "$tool" >/dev/null || die "$tool is required"; done
json() { python3 -c 'import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=(d or {}).get(k) if isinstance(d, dict) else None
print("" if d is None else d)' "$1"; }
[ -n "$IP" ] || IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] || die "cannot tell this server's address: pass --ip"
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"

say "1/8 Redeeming the install code at Root ($ROOT)"
SITE=$(curl $K -X POST -H 'content-type: application/json' -d "{\"code\":\"$CODE\"}" "$ROOT/api/v1/install/redeem") \
  || die "Root refused the code (wrong, used or expired) or is unreachable"
TENANT=$(printf '%s' "$SITE" | json tenant_id); NAME=$(printf '%s' "$SITE" | json name)
TENANT_KEY=$(printf '%s' "$SITE" | json tenant_key); INSTALL_ID=$(printf '%s' "$SITE" | json install_id)
ROOT_URL=$(printf '%s' "$SITE" | json root_url); ROOT_KEY=$(printf '%s' "$SITE" | json signing_key.public_raw)
ROOT_REGISTRY=$(printf '%s' "$SITE" | json registry); REGISTRY_HOST=$(printf '%s' "$ROOT_REGISTRY" | sed -E 's#^https?://##')
[ -n "$TENANT_KEY" ] || die "unexpected answer from Root"
echo "hospital $TENANT — $NAME"
report() { curl $K -X POST -H "authorization: Bearer $TENANT_KEY" -H 'content-type: application/json' \
  -d "$(printf '{"status":"%s","detail":{"hostname":"%s","ip":"%s"%s}}' "$1" "$(hostname)" "$IP" "${2:+,\"error\":\"$2\"}")" \
  "$ROOT/api/v1/tenants/$TENANT/installs/$INSTALL_ID/report" >/dev/null 2>&1 || true; }
fail() { report failed "$(printf '%s' "$*" | tr '"\n' "' " | cut -c1-300)"; die "$*"; }

say "2/8 Kubernetes"
if command -v kubectl >/dev/null && kubectl get nodes >/dev/null 2>&1; then KUBECTL=kubectl
elif command -v k3s >/dev/null; then KUBECTL="k3s kubectl"
elif [ "$EXISTING" = 1 ]; then fail "no working cluster (kubectl get nodes failed)"
else
  [ "$(id -u)" = 0 ] || fail "installing k3s needs sudo"
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh - || fail "k3s install failed"
  KUBECTL="k3s kubectl"
fi
$KUBECTL get nodes -o wide | sed -n '2p'

say "3/8 The signed Canopy release from Root"
RELEASES=$(curl $K -H "authorization: Bearer $TENANT_KEY" "$ROOT/api/v1/tenants/$TENANT/releases") || fail "cannot read releases from Root"
IMAGES=$(printf '%s' "$RELEASES" | python3 -c '
import json, sys
d, registry = json.load(sys.stdin)["bundle"], sys.argv[1]
rid = d["latest"].get("canopy"); rel = next(r for r in d["releases"] if r["release_id"] == rid)
for key in ("api", "web", "db", "haber", "registry"):
    image = rel["services"][key]
    print("%s %s/%s@%s" % (key.upper(), registry, image["repository"], image["digest"]))
print("RELEASE " + rid)' "$REGISTRY_HOST") || fail "the Canopy release has no full site image set (api web db haber registry)"
img() { printf '%s\n' "$IMAGES" | sed -n "s/^$1 //p"; }
echo "release $(img RELEASE)"

say "4/8 Pulling images into this server's container runtime"
# Each image is pulled once by digest and kept under a local name (flora-site/<service>:<release>); the
# cluster runs those local names only (imagePullPolicy: Never), so it never needs to reach a registry.
RELEASE_ID=$(img RELEASE)
for key in API WEB DB HABER REGISTRY; do
  ref=$(img $key); local_ref="flora-site/$(echo $key | tr 'A-Z' 'a-z'):$RELEASE_ID"
  if command -v k3s >/dev/null && [ "$KUBECTL" = "k3s kubectl" ]; then
    $SUDO k3s ctr -n k8s.io images pull --plain-http "$ref" >/dev/null && $SUDO k3s ctr -n k8s.io images tag --force "$ref" "docker.io/$local_ref" >/dev/null
  elif command -v nerdctl >/dev/null; then
    $SUDO nerdctl -n k8s.io pull -q --insecure-registry "$ref" >/dev/null && $SUDO nerdctl -n k8s.io tag "$ref" "$local_ref"
  else
    $SUDO ctr -n k8s.io images pull --plain-http "$ref" >/dev/null && $SUDO ctr -n k8s.io images tag --force "$ref" "docker.io/$local_ref" >/dev/null
  fi || fail "cannot pull $ref"
  echo "  $key ok ($local_ref)"
done
img() { case "$1" in RELEASE) printf '%s\n' "$RELEASE_ID" ;; *) echo "flora-site/$(echo $1 | tr 'A-Z' 'a-z'):$RELEASE_ID" ;; esac; }

say "5/8 Secrets and certificate (generated here, kept in this cluster)"
for ns in "$P-canopy" "$P-appliance"; do
  $KUBECTL get ns "$ns" >/dev/null 2>&1 || $KUBECTL create ns "$ns" >/dev/null
  $KUBECTL label ns "$ns" flora/site="$TENANT" --overwrite >/dev/null
done
rnd() { openssl rand -hex 24; }
if ! $KUBECTL -n "$P-canopy" get secret site >/dev/null 2>&1; then
  SECRET_ARGS="--from-literal=db-admin=$(rnd) --from-literal=db-app=$(rnd) --from-literal=db-view=$(rnd) --from-literal=db-sync=$(rnd)
    --from-literal=session=$(rnd) --from-literal=admin=$(rnd | cut -c1-16) --from-literal=haber-admin=$(rnd | cut -c1-16)
    --from-literal=sync=$(rnd) --from-literal=gateway-token=$(rnd) --from-literal=node-token=$(rnd) --from-literal=tenant-key=$TENANT_KEY"
  for ns in "$P-canopy" "$P-appliance"; do $KUBECTL -n "$ns" create secret generic site $SECRET_ARGS >/dev/null; done
else   # re-run: the new tenant key from this redeem replaces the old one
  for ns in "$P-canopy" "$P-appliance"; do
    $KUBECTL -n "$ns" patch secret site -p "{\"stringData\":{\"tenant-key\":\"$TENANT_KEY\"}}" >/dev/null; done
fi
sec() { $KUBECTL -n "$P-canopy" get secret site -o jsonpath="{.data.$1}" | base64 -d; }
if ! $KUBECTL -n "$P-canopy" get secret edge-tls >/dev/null 2>&1; then
  TMP=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 1825 -subj "/CN=$TENANT" -keyout "$TMP/tls.key" -out "$TMP/tls.crt" \
    -addext "subjectAltName=IP:$IP,DNS:$(hostname),DNS:localhost" >/dev/null 2>&1 || fail "cannot make the certificate"
  $KUBECTL -n "$P-canopy" create secret tls edge-tls --cert "$TMP/tls.crt" --key "$TMP/tls.key" >/dev/null; rm -rf "$TMP"
fi

# The appliance talks to Root over HTTPS: trust the system CAs plus Root's certificate as seen now.
ROOT_HOST=$(printf '%s' "$ROOT_URL" | sed -E 's#^https?://##; s#/.*$##'); case "$ROOT_HOST" in *:*) ;; *) ROOT_HOST="$ROOT_HOST:443" ;; esac
TMP=$(mktemp -d)
cat /etc/ssl/certs/ca-certificates.crt > "$TMP/trust.pem" 2>/dev/null || true
case "$ROOT_URL" in https://*) echo | openssl s_client -connect "$ROOT_HOST" -showcerts 2>/dev/null | sed -n '/BEGIN CERT/,/END CERT/p' >> "$TMP/trust.pem" ;; esac
$KUBECTL -n "$P-appliance" create configmap root-trust --from-file=trust.pem="$TMP/trust.pem" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
rm -rf "$TMP"

say "6/8 Installing Canopy and the appliance ($P-canopy, $P-appliance)"
curl $K "$ROOT/install/files/site/site.yaml" | sed \
  -e "s#__P__#$P#g" -e "s#__TENANT__#$TENANT#g" -e "s#__IP__#$IP#g" -e "s#__CANOPY_PORT__#$CANOPY_PORT#g" \
  -e "s#__HABER_PORT__#$HABER_PORT#g" -e "s#__REGISTRY_PORT__#$REGISTRY_PORT#g" -e "s#__ROOT_API__#$ROOT_URL#g" \
  -e "s#__ROOT_PUBLIC_KEY__#$ROOT_KEY#g" -e "s#__ROOT_REGISTRY__#$ROOT_REGISTRY#g" \
  -e "s#__IMG_API__#$(img API)#g" -e "s#__IMG_WEB__#$(img WEB)#g" -e "s#__IMG_DB__#$(img DB)#g" \
  -e "s#__IMG_HABER__#$(img HABER)#g" -e "s#__IMG_REGISTRY__#$(img REGISTRY)#g" \
  | $KUBECTL apply -f - >/dev/null || fail "kubectl apply failed"
for d in canopy-db canopy-api sync-api canopy-web edge; do
  $KUBECTL -n "$P-canopy" rollout status "deploy/$d" --timeout=600s >/dev/null || fail "$d did not start"; echo "  $d ready"; done

say "7/8 Hospital account in Canopy"
OWNER="postgresql://flora_admin:$(sec db-admin)@canopy-db:5432/flora"
# Canopy account codes are [a-z][a-z0-9_]: Root's tenant id with "-" as "_" (hospital-01 -> hospital_01).
ACCOUNT=$(printf '%s' "$TENANT" | tr 'A-Z-' 'a-z_'); case "$ACCOUNT" in [a-z]*) ;; *) ACCOUNT="h_$ACCOUNT" ;; esac
cli() { $KUBECTL -n "$P-canopy" exec deploy/canopy-api -c canopy-api -- env FLORA_PLATFORM_DATABASE_URL="$OWNER" \
  FLORA_SYNC_SHARED_SECRET="$(sec sync)" TENANT="$ACCOUNT" NAME="$NAME" sh -c \
  'export FLORA_DATABASE_URL=postgresql://flora_view:$DB_VIEW@canopy-db:5432/flora; python -m app.cli_accounts "$@"' cli "$@"; }
if ! cli list 2>/dev/null | grep -q "^$ACCOUNT "; then
  $KUBECTL -n "$P-canopy" exec deploy/canopy-api -c canopy-api -- env FLORA_PLATFORM_DATABASE_URL="$OWNER" \
    FLORA_SYNC_SHARED_SECRET="$(sec sync)" TENANT="$ACCOUNT" NAME="$NAME" sh -c \
    'export FLORA_DATABASE_URL=postgresql://flora_view:$DB_VIEW@canopy-db:5432/flora; python -m app.cli_accounts adopt-public "$TENANT" "$NAME"' >/dev/null \
    || fail "cannot create the hospital account in Canopy"
  $KUBECTL -n "$P-canopy" rollout restart deploy/canopy-api >/dev/null        # first administrator of the account
  $KUBECTL -n "$P-canopy" rollout status deploy/canopy-api --timeout=300s >/dev/null || fail "canopy-api did not restart"
fi
echo "  account $ACCOUNT ready"

say "8/8 Appliance: connecting to Root"
for d in haber-registry haber; do
  $KUBECTL -n "$P-appliance" rollout status "deploy/$d" --timeout=600s >/dev/null || fail "$d did not start"; done
HAUTH="admin:$(sec haber-admin)"; i=0
until [ "$(curl -fsS -u "$HAUTH" "http://$IP:$HABER_PORT/api/haber/v1/overview" 2>/dev/null | json root.status)" = ok ]; do
  i=$((i + 1)); [ $i -le 30 ] || fail "the appliance cannot reach Root yet ($(curl -fsS -u "$HAUTH" "http://$IP:$HABER_PORT/api/haber/v1/overview" 2>/dev/null | json root.error))"
  curl -fsS -u "$HAUTH" -X POST "http://$IP:$HABER_PORT/api/haber/v1/root/sync" >/dev/null 2>&1 || true; sleep 5; done
report installed
echo "
Flora iCIS site $TENANT is running ($NAME).
  Canopy:      https://$IP:$CANOPY_PORT     first login admin / $(sec admin)  (change it at first sign-in)
  Appliance:   http://$IP:$HABER_PORT        admin / $(sec haber-admin)
  Leafs and gateways on the LAN install from the appliance: plan them at Root > Topology > $TENANT."
