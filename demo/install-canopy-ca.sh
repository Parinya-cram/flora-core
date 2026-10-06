#!/usr/bin/env bash
# Trust Canopy's private dev CA on this machine's Leaf and Gateway.
# Not needed when Canopy's edge has a publicly trusted certificate.
#   ./demo/install-canopy-ca.sh [path/to/canopy-trust.pem]
set -euo pipefail
cd "$(dirname "$0")/.."
bundle=${1:-flora-canopy/edge/certs/canopy-trust.pem}
[ -f "$bundle" ] || { echo "missing $bundle (run flora-canopy/edge/make-dev-cert.sh on Canopy)"; exit 1; }
for package in flora-leaf flora-gateway; do
  cp "$bundle" "$package/certs/canopy-trust.pem"
  echo "SSL_CERT_FILE=/etc/flora/certs/canopy-trust.pem" > "$package/certs/trust.env"
  echo "installed Canopy CA for $package"
done
