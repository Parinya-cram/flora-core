#!/usr/bin/env bash
# Replaced by the shared Flora CA: certificates and trust now come from each tier's .env
# via scripts/tls/make-cert.sh (see docs/https.md). Kept so old instructions still work.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d scripts ] || cd ..
for tier in flora-canopy; do scripts/tls/make-cert.sh "$tier"; done
