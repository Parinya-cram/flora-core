# Asset and port inventory

What a VA scanner will find, per host. "Exposed" = published on all interfaces (0.0.0.0); "local" =
published on 127.0.0.1 only (not reachable from the network). Ports are the defaults in the compose
files; a site `.env` may change them — record the real values per hospital.

## Canopy server (hospital)

Deployed with `flora-canopy/compose.yaml` (current demo/dev layout).

| Service | Purpose | Host port | Exposure | Notes |
|---|---|---|---|---|
| edge (nginx) | TLS entry for web, API, sync, Haber, registry | 443, 80 | **Exposed** | 80 redirects to 443. Routes `/`, `/api/`, `/api/sync/`, `/haber/`, `/v2/`, `/docs`, `/openapi.json` |
| canopy-web | Web app (currently Vite **dev server**) | 7200 | local | F11 / D5: production must serve static build |
| canopy-api | Canopy API (multi-account) | 7201 | local | via edge `/api/` |
| sync-api | Leaf / Haber → Canopy sync | 7203 | local | via edge `/api/sync/` (F2, F10) |
| canopy-db (PostgreSQL) | All accounts' schemas | 7202 | local | |
| haber | Release relay, gateway catalog | 7204 | local | via edge `/haber/` (Basic auth, F1, F7) |
| haber-registry | Docker image registry | 7205 | local | via edge `/v2/` without auth (F5) |
| flora-mcp | AI assistant tools (API-key auth) | 7206 | local | F19 |
| updater | Applies signed releases | — | none | mounts docker.sock (F6), F14 |

`flora-canopy/compose.server.yaml` (server variant): db 6902, api 6895, sync 6896, registry 7205,
haber 7204 on `${FLORA_BIND_ADDR:-127.0.0.1}`; **canopy-web 6894 exposed**.

## Leaf (bedside workstation)

`flora-leaf/compose.yaml`: db 7302, api 7301, web 7300 local; **edge `${LEAF_HTTPS_PORT:-443}` exposed**.
Desktop app: Electron (`electron/main.cjs`) talking to `http://127.0.0.1:6893` (local).
Older layout `compose.server.yaml` (repo root): postgres 6892, liveagent 6897, leaf-api 6893, sync 6896,
canopy-api 6895 on `${FLORA_BIND_ADDR}`; **leaf web 6890 exposed** (dev server).

## Gateway (device interface)

`flora-gateway/compose.yaml`:

| Service | Host port | Exposure | Notes |
|---|---|---|---|
| edge (nginx) | 443 | **Exposed** | `/data-api/` without auth (F3); gateway console (login) |
| HL7 MLLP listeners | 7421, 7422 | **Exposed** | no auth (F4) — should be device VLAN only |
| Vista listener | 9500 | **Exposed** | no auth (F4) |
| Webhook controller | 7423 | **Exposed** | no auth (F4) |
| gateway-service console | 7400 | local | default `admin/admin` (F1), docker.sock (F6) |
| kong, kafka, db, serial, controllers, simulator | 7401–7431 | local | |

## Root (ESM cloud) — out of hospital scope

`flora-root/compose.yaml`: edge 443/80 exposed; db 7102, api 7100, registry 7105 local.
`flora-edge/compose.server.yaml` (shared edge): 443, 80, 7443, 8443, 9443 exposed.

## Unauthenticated HTTP endpoints (by design unless marked)

| Endpoint | Component | Note |
|---|---|---|
| `GET /health` | all APIs | |
| `POST /api/auth/login`, `POST /api/auth/logout` | canopy-api | no rate limit (F7) |
| `GET /api/auth/account/{code}` | canopy-api | account name for the login form (F18) |
| `GET /api/auth/preferences/options`, `/preferences/translations/{code}`, `/ldap/status` | canopy-api | |
| `GET /api/sync/v1/fingerprint` | sync-api | **remove** (F10) |
| `POST /api/integrations/hl7/webhook/{token}` | canopy-api | token in URL (F17) |
| `GET /docs`, `/openapi.json` (`/redoc` not proxied) | canopy-api | **disable in production** (F9) |
| `GET /api/workstation/context` | leaf-api | needs verification whether reachable via Leaf edge |
| `/data-api/*` (`/api/observations`, `/api/measurements`, `/api/devices/status`) | gateway | **must require auth** (F3) |
| `/health`, `/login`, `/api/auth/login`, `/api/site/label` | gateway-service | |
| `/v2/*` | registry | **must require auth** (F5) |
| `/health` | haber | other routes Basic / token auth |

## Data held

| Store | Contents | Sensitivity |
|---|---|---|
| Canopy PostgreSQL (`acct_<code>` per hospital) | patients, cases, vitals, forms, users (scrypt hashes), configuration | PHI — highest |
| Canopy PostgreSQL `platform` schema | account registry, sync-secret hashes, platform admins | secrets (hashed) |
| Leaf PostgreSQL | current and recent cases for that bed, user directory copy | PHI |
| Gateway PostgreSQL / Kafka | device measurements (no names, linked to bed / Leaf) | PHI (indirect) |
| Haber registry | container images | integrity-critical |
