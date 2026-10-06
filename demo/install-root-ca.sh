#!/usr/bin/env bash
# Trust Root's private dev CA on this machine's Canopy (Haber calls Root over HTTPS).
# Not needed when Root's edge has a publicly trusted certificate.
#   ./demo/install-root-ca.sh [path/to/root-trust.pem]
set -euo pipefail
cd "$(dirname "$0")/.."
bundle=${1:-flora-root/edge/certs/root-trust.pem}
[ -f "$bundle" ] || { echo "missing $bundle (run flora-root/edge/make-dev-cert.sh on Root)"; exit 1; }
mkdir -p flora-canopy/root-certs
cp "$bundle" flora-canopy/root-certs/root-trust.pem
echo "SSL_CERT_FILE=/etc/flora/root-certs/root-trust.pem" > flora-canopy/root-certs/trust.env
echo "installed Root CA for flora-canopy"
