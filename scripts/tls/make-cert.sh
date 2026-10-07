#!/usr/bin/env bash
# Self-signed HTTPS for one Flora tier, configured from its .env.
#
#   scripts/tls/make-cert.sh <tier-dir> [env-file]
#     e.g. scripts/tls/make-cert.sh flora-canopy
#          scripts/tls/make-cert.sh flora-leaf flora-leaf/env/leaf-or-01.env
#
# Reads from the env file (defaults in brackets; relative paths are relative to <tier-dir>):
#   TLS_HOSTNAMES     names and IPs the certificate is valid for, comma separated
#                     [localhost,host.docker.internal,127.0.0.1]
#   TLS_CERT_FILE     server certificate the tier's edge serves   [./certs/server.crt]
#   TLS_KEY_FILE      its private key                             [./certs/server.key]
#   TLS_CA_FILE       Flora CA certificate                        [../certs/flora-ca.crt]
#   TLS_CA_KEY_FILE   Flora CA key (only on the machine issuing)  [../certs/flora-ca.key]
#   TLS_DAYS          certificate lifetime                        [825]
#
# One shared, self-signed "Flora CA" signs every tier's certificate, so a machine or
# browser trusts the whole platform after installing that one CA (certs/flora-ca.crt).
# The certificate is (re)issued when missing, when TLS_HOSTNAMES or the CA changed,
# or with FORCE=1. It also writes <tier-dir>/certs/flora-trust.pem (public CAs + Flora
# CA) and <tier-dir>/certs/trust.env so the tier's outbound HTTPS calls trust Flora.
# To use a certificate from your own CA instead, point TLS_CERT_FILE/TLS_KEY_FILE at it
# and do not run this script for that tier.
set -euo pipefail
tier=${1:?usage: make-cert.sh <tier-dir> [env-file]}
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
tier=${tier%/}
env_file=${2:-$tier/.env}

read_env() { # read_env NAME DEFAULT
  local value=""
  [ -f "$env_file" ] && value=$(grep -E "^$1=" "$env_file" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  echo "${value:-$2}"
}
resolve() { case "$1" in /*) echo "$1" ;; *) echo "$tier/${1#./}" ;; esac; }

hostnames=$(read_env TLS_HOSTNAMES "localhost,host.docker.internal,127.0.0.1")
cert=$(resolve "$(read_env TLS_CERT_FILE ./certs/server.crt)")
key=$(resolve "$(read_env TLS_KEY_FILE ./certs/server.key)")
ca=$(resolve "$(read_env TLS_CA_FILE ../certs/flora-ca.crt)")
ca_key=$(resolve "$(read_env TLS_CA_KEY_FILE ../certs/flora-ca.key)")
days=$(read_env TLS_DAYS 825)
mkdir -p "$(dirname "$cert")" "$(dirname "$key")" "$(dirname "$ca")" "$tier/certs"

# 1. The shared Flora CA (created once, on the machine that issues certificates).
if [ ! -f "$ca" ]; then
  [ -f "$ca_key" ] && { echo "CA key exists without $ca"; exit 1; }
  printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > "$ca.ext"
  openssl req -new -newkey rsa:3072 -nodes -subj "/CN=Flora CA (self-signed)" -keyout "$ca_key" -out "$ca.csr" 2>/dev/null
  openssl x509 -req -in "$ca.csr" -signkey "$ca_key" -days 3650 -extfile "$ca.ext" -out "$ca" 2>/dev/null
  rm -f "$ca.csr" "$ca.ext"
  chmod 600 "$ca_key"
  echo "created Flora CA $ca"
fi

# 2. The tier's server certificate, reissued when the names or the CA changed.
san=""
IFS=',' read -ra names <<< "$hostnames"
for name in "${names[@]}"; do
  name=$(echo "$name" | xargs)
  [ -z "$name" ] && continue
  if [[ $name =~ ^[0-9.]+$ || $name == *:* ]]; then san="$san,IP:$name"; else san="$san,DNS:$name"; fi
done
san=${san#,}
stamp="$san|$(openssl x509 -in "$ca" -noout -fingerprint -sha256)"
if [ -n "${FORCE:-}" ] || [ ! -f "$cert" ] || [ ! -f "$key" ] || [ "$(cat "$cert.stamp" 2>/dev/null)" != "$stamp" ]; then
  [ -f "$ca_key" ] || { echo "cannot issue $cert: no CA key at $ca_key (issue it on the CA machine)"; exit 1; }
  common=$(echo "${names[0]}" | xargs)
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$common" -keyout "$key" -out "$cert.csr" 2>/dev/null
  # Python 3.13 verifies strictly: key identifiers and key usage must be present.
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' "$san" > "$cert.ext"
  openssl x509 -req -in "$cert.csr" -CA "$ca" -CAkey "$ca_key" -CAcreateserial -days "$days" -extfile "$cert.ext" -out "$cert" 2>/dev/null
  rm -f "$cert.csr" "$cert.ext" "${ca%.crt}.srl"
  chmod 600 "$key"
  echo "$stamp" > "$cert.stamp"
  echo "issued $cert ($san)"
else
  echo "certificate up to date: $cert"
fi

# 3. Trust bundle for this tier's outbound calls (public CAs + Flora CA).
bundle="$tier/certs/flora-trust.pem"
for system in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do
  [ -f "$system" ] && { cat "$system" "$ca" > "$bundle"; break; }
done
[ -f "$bundle" ] || cp "$ca" "$bundle"
echo "SSL_CERT_FILE=/etc/flora/certs/flora-trust.pem" > "$tier/certs/trust.env"
