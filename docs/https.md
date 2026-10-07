# HTTPS for every Flora tier

Every tier is reached over HTTPS through its own nginx **edge**. Certificates are
self-signed by one shared **Flora CA**, so a browser, tablet or another tier trusts the
whole platform after installing a single file: `certs/flora-ca.crt`.

| Tier | Edge serves | Production | This dev machine |
|---|---|---|---|
| Root | API, admin, release registry (`/v2/`) | 443 | 8443 |
| Canopy | viewer, API, sync, Haber, MCP | 443 | 9443 |
| Gateway | admin UI/API, data API for Leafs (`/data-api/`) | 443 | 7443 |
| Leaf | bedside viewer, API | 443 | OR 7343, ICU 7353 |

Not HTTPS by design: device feeds (HL7 MLLP, serial/socket, device webhooks), Kafka and
databases (internal), and the Leaf desktop app's own API on `127.0.0.1` (loopback). The
plain-HTTP debug ports (71xx–74xx) listen on `127.0.0.1` only.

## Configuration (`.env`)

Each tier reads its settings from its env file (`flora-root/.env`, `flora-canopy/.env`,
`flora-gateway/.env`, `flora-leaf/env/<leaf>.env`; see the `.env.example` files):

```
TLS_HOSTNAMES=localhost,host.docker.internal,127.0.0.1,10.149.1.22,canopy.local
TLS_CERT_FILE=./certs/server.crt      # served by the edge
TLS_KEY_FILE=./certs/server.key
TLS_CA_FILE=../certs/flora-ca.crt     # the shared Flora CA
TLS_CA_KEY_FILE=../certs/flora-ca.key # only where certificates are issued
TLS_DAYS=825
```

`TLS_HOSTNAMES` must list every name or IP clients use (LAN IP for tablets, Tailscale
name for a remote gateway, …). Paths are relative to the tier directory.

## Issue / renew

```bash
scripts/tls/make-cert.sh flora-canopy
scripts/tls/make-cert.sh flora-leaf flora-leaf/env/leaf-or-01.env
```

The script creates the Flora CA on first use, issues the tier certificate (again when
`TLS_HOSTNAMES` or the CA changes, or with `FORCE=1`), and writes
`<tier>/certs/flora-trust.pem` + `certs/trust.env` so the tier's outbound calls
(Leaf → Canopy, Gateway → Haber, Haber → Root, Leaf → Gateway) trust the Flora CA.
Then recreate the tier's `edge` (and restart its clients) with docker compose.
`demo/up.sh` does all of this.

## Separate machines

Issue every certificate on the machine holding `certs/flora-ca.key`, then copy to each
host: its `TLS_CERT_FILE`/`TLS_KEY_FILE`, plus `certs/flora-ca.crt` and the tier's
`certs/flora-trust.pem` + `certs/trust.env`. Install `flora-ca.crt` in the trust store of
browsers and tablets. To use a certificate from the hospital's own CA instead, point
`TLS_CERT_FILE`/`TLS_KEY_FILE` at it and add that CA to the trust bundles.
