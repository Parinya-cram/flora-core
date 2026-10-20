#!/bin/sh
# Flora iCIS __KIND__ installer, served by the hospital appliance (__HABER_URL__).
#   curl -fsSL __HABER_URL__/install/__KIND__.sh | sudo sh -s -- --code XXXX-XXXX-XXXX-XXXX
# Trades the one-time code Root issued for this machine's settings and keeps them in /etc/flora.
# No internet needed: everything comes from the appliance on the hospital LAN.
set -eu
HABER="__HABER_URL__"
KIND="__KIND__"
CODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="${2:-}"; shift 2 ;;
    --haber) HABER="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CODE" ] || { echo "usage: sh -s -- --code XXXX-XXXX-XXXX-XXXX" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

echo "Flora iCIS: claiming this machine as a $KIND at $HABER ..."
BODY=$(printf '{"code":"%s","kind":"%s","hostname":"%s"}' "$CODE" "$KIND" "$(hostname)")
NODE=$(curl -fsS -X POST -H 'content-type: application/json' -d "$BODY" "$HABER/api/haber/v1/install/claim") || {
  echo "the appliance refused the code (wrong, expired or already used by another machine)" >&2; exit 1; }

# One env file per node: a machine may host several Leafs.
NODE_ID=$(printf '%s' "$NODE" | sed -n 's/.*"node_id":"\([^"]*\)".*/\1/p')
[ -n "$NODE_ID" ] || { echo "unexpected answer from the appliance: $NODE" >&2; exit 1; }
install -d -m 700 /etc/flora
printf '%s\n' "$NODE" > "/etc/flora/$NODE_ID.json"
chmod 600 "/etc/flora/$NODE_ID.json"
printf '%s\n' "$CODE" > "/etc/flora/$NODE_ID.code"
chmod 600 "/etc/flora/$NODE_ID.code"
echo "registered as $NODE_ID; settings saved in /etc/flora/$NODE_ID.json"

# Next build step: pull the approved $KIND images from the appliance registry, start them with the
# flora-updater, then report:  curl -X POST $HABER/api/haber/v1/install/report -d '{"code":"…","status":"installed"}'
echo "The container install for $KIND is the next build step; this machine is now claimed and visible at Root."
