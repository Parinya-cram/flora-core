#!/usr/bin/env bash
# Development/demo only: a private CA plus a Canopy server certificate for the edge.
# In production, put a publicly trusted certificate (e.g. Let's Encrypt) in certs/
# as canopy.crt / canopy.key instead; Leaves and Gateways then need no extra setup.
#
#   ./make-dev-cert.sh [extra-hostname-or-ip ...]
set -euo pipefail
cd "$(dirname "$0")/certs"
if [ -f canopy.crt ] && [ -z "${FORCE:-}" ]; then echo "certs exist (FORCE=1 to regenerate)"; exit 0; fi
san="DNS:localhost,DNS:host.docker.internal,DNS:canopy.local,IP:127.0.0.1"
for extra in "$@"; do
  if [[ $extra =~ ^[0-9.]+$ ]]; then san="$san,IP:$extra"; else san="$san,DNS:$extra"; fi
done
printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > ca.ext
openssl req -new -newkey rsa:3072 -nodes -subj "/CN=Flora Canopy Dev CA" -keyout ca.key -out ca.csr 2>/dev/null
openssl x509 -req -in ca.csr -signkey ca.key -days 3650 -extfile ca.ext -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=canopy.local" -keyout canopy.key -out canopy.csr 2>/dev/null
# Python 3.13 verifies strictly: key identifiers and key usage must be present.
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' "$san" > canopy.ext
openssl x509 -req -in canopy.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 \
  -extfile canopy.ext -out canopy.crt 2>/dev/null
rm -f canopy.csr canopy.ext ca.csr ca.ext ca.srl
chmod 600 ca.key canopy.key
echo "created certs/ca.crt and certs/canopy.crt ($san)"
# Trust bundle for Leaves/Gateways: the public CAs plus this CA, so HTTPS elsewhere still works.
for system in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
  [ -f "$system" ] && { cat "$system" ca.crt > canopy-trust.pem; break; }
done
[ -f canopy-trust.pem ] || cp ca.crt canopy-trust.pem
echo "created certs/canopy-trust.pem; install it on a Leaf/Gateway with ../../demo/install-canopy-ca.sh"
