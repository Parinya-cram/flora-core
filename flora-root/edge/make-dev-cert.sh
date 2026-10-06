#!/usr/bin/env bash
# Development/demo only: a private CA plus a Root server certificate for the edge.
# In production, put a publicly trusted certificate in certs/ as root.crt / root.key;
# Canopies then need no extra setup.
#
#   ./make-dev-cert.sh [extra-hostname-or-ip ...]
set -euo pipefail
cd "$(dirname "$0")/certs"
if [ -f root.crt ] && [ -z "${FORCE:-}" ]; then echo "certs exist (FORCE=1 to regenerate)"; exit 0; fi
san="DNS:localhost,DNS:host.docker.internal,DNS:root.local,IP:127.0.0.1"
for extra in "$@"; do
  if [[ $extra =~ ^[0-9.]+$ ]]; then san="$san,IP:$extra"; else san="$san,DNS:$extra"; fi
done
printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > ca.ext
openssl req -new -newkey rsa:3072 -nodes -subj "/CN=Flora Root Dev CA" -keyout ca.key -out ca.csr 2>/dev/null
openssl x509 -req -in ca.csr -signkey ca.key -days 3650 -extfile ca.ext -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=root.local" -keyout root.key -out root.csr 2>/dev/null
# Python 3.13 verifies strictly: key identifiers and key usage must be present.
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' "$san" > root.ext
openssl x509 -req -in root.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 \
  -extfile root.ext -out root.crt 2>/dev/null
rm -f root.csr root.ext ca.csr ca.ext ca.srl
chmod 600 ca.key root.key
echo "created certs/ca.crt and certs/root.crt ($san)"
# Trust bundle for Canopy (Haber): the public CAs plus this CA, so HTTPS elsewhere still works.
for system in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
  [ -f "$system" ] && { cat "$system" ca.crt > root-trust.pem; break; }
done
[ -f root-trust.pem ] || cp ca.crt root-trust.pem
echo "created certs/root-trust.pem; install it on Canopy with ../../demo/install-root-ca.sh"
