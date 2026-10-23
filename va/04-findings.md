# Pre-VA findings register (2026-10-22)

Internal review by ESM before the hospital VA scan: code and configuration review of `flora-core`
(Canopy, Leaf, Gateway, Haber, Root, updater, Electron) plus the dependency scan in
[03-pre-scan-results.md](03-pre-scan-results.md). Read-only; nothing was changed while reviewing.
Severity is our own estimate (CVSS-style); the vendor's score replaces it once the VA report arrives.

Status: **Open** unless marked otherwise. Fix plan and target dates: [05-remediation-plan.md](05-remediation-plan.md).

| ID | Severity | Title | Component | A scanner will see it? |
|---|---|---|---|---|
| F1 | Critical | Default secrets and `admin/admin` in effect (session secret, sync secret, Haber, Gateway, Root) | all compose files | Yes (default-credential checks) |
| F2 | Critical | Sync secret acts as a master key: a Leaf can create/overwrite Canopy users incl. password hash and role, and receives password hashes and the AI key | canopy sync-api | Authenticated test |
| D1 | Critical | Pillow 12.3.0 — 28 advisories (heap overflows, Ghostscript argument injection) | canopy/api, leaf/api images | Yes (image / SCA scan) |
| D2 | Critical | certifi 2026.7.22 trusts compromised emSign intermediates | haber, leaf/sync images | Yes |
| F3 | High | Gateway data-api (live vitals of every bed) has no authentication, exposed on gateway 443 | gateway | Yes |
| F4 | High | Device listeners (HL7 MLLP 7421/7422, Vista 9500, webhook 7423) bind 0.0.0.0 without authentication | gateway | Yes (open ports) |
| F5 | High | Image registry `/v2/` reachable through the Canopy edge without authentication (push; delete in server compose) | canopy edge / registry | Yes |
| F6 | High | `docker.sock` mounted into flora-updater and gateway-service (host root on compromise) | updater, gateway | Config review |
| D3 | High | cryptography 46.0.2 — 7 advisories (bundled OpenSSL, PKCS#7 Bleichenbacher, …) | haber, flora-root | Yes |
| D4 | High | Starlette 0.47/0.48 — Range-header DoS, form limits ignored, Host-header poisoning | canopy/api, haber | Yes |
| D5 | High | Vite 7.3.6 dev server reachable (cross-origin script execution) where the dev server runs | canopy-web (dev) | Yes, if port open |
| F7 | Medium | No login rate limiting / lockout; admin PIN 4–8 digits without attempt counter; username timing oracle | auth (Canopy, Leaf, Haber, Gateway) | Yes (brute-force test) |
| F8 | Medium | No HSTS / CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy; `server_tokens` on; no cipher list; private-CA certificate | all edges | Yes |
| F9 | Medium | `/docs` and `/openapi.json` published on the Canopy edge; CORS `*` | canopy-api, edge | Yes |
| F10 | Medium | Unauthenticated `/api/sync/v1/fingerprint` reveals a hash prefix of the sync secret (confirms default secret) | sync-api | Yes |
| F11 | Medium | Deployment runs the dev stack: Vite dev server, uvicorn `--reload`, `FLORA_API_ENV=development`, bootstrap admin enabled | canopy compose | Yes |
| F12 | Medium | Session token in localStorage without CSP; Canopy tokens stateless (logout does not revoke, role changes apply after up to 8 h); `flora_account` cookie without `Secure` | frontend, auth | Partly |
| F13 | Medium | All containers run as root; no `cap_drop`, `read_only`, `no-new-privileges` | all images / compose | Yes (image / config scan) |
| F14 | Medium | Updater trusts the Root signing key on first use when `FLORA_ROOT_PUBLIC_KEY` is empty (default) | flora-updater | Config review |
| F15 | Low | Admin-only SSRF / key exfiltration via AI-service “test” (new host + saved key) and Leaf gateway test URL | canopy-api, leaf-api | Authenticated test |
| F16 | Low | Electron: `sandbox: false`, no window-open / navigation guard; PHI PDFs written to OS temp dir | Leaf desktop | Desktop review |
| F17 | Low | HL7 webhook token in URL path → written to nginx access logs | canopy-api | Log review |
| F18 | Low | Account-code enumeration (`/api/auth/account/{code}`); unauthenticated requests with `flk_` / webhook tokens scan every account schema | canopy multi-account | Yes |
| F19 | Low | MCP server DNS-rebinding protection off (API key still required) | flora-mcp | Unlikely |
| F20 | Info | Demo secrets in git-tracked Leaf env files; old `.env` (admin password) in git history | repo | Secret scan |

Positive controls already in place (worth telling the vendor / hospital):
parameterised SQL throughout (schema names validated), LDAP filter escaping, scrypt password hashing,
constant-time comparison for sync secret / API keys / webhook / Haber tokens, zip-slip and size checks on
form packs, 25 MB attachment limit, escaped PDF rendering, AI Studio HTML in an opaque sandboxed iframe,
PHI masking in the public API / MCP, no PHI found in log statements, signed release bundles with images
pinned by digest, per-hospital database schemas with no cross-account access (multi-account Canopy,
covered by `services/flora-api/tests/test_multi_account.py`), internal service ports bound to 127.0.0.1.

---

## Details

### F1 — Default secrets and `admin/admin` in effect (Critical)
**Evidence** — `flora-canopy/.env`, `flora-gateway/.env`, `flora-root/.env` set ports and TLS paths only, so
compose defaults apply:
- `flora-canopy/compose.yaml:41` `FLORA_CANOPY_SESSION_SECRET: ${CANOPY_SESSION_SECRET:-flora-canopy-demo-session-secret-change-me}`
- `:46-47` bootstrap admin password `admin`, `MUST_CHANGE_PASSWORD` false
- `:89, :147` `FLORA_SYNC_SHARED_SECRET:-flora-sync-demo-secret-change-me`; `:52, :149` `HABER_ADMIN_PASSWORD:-admin`;
  `:142` root tenant key, `:144` gateway token, `:152` node token — all demo defaults
- `flora-gateway/compose.yaml:201` `GATEWAY_ADMIN_PASSWORD:-admin`, empty `GATEWAY_ADMIN_KEY` disables the key check
- `flora-root/compose.yaml:32` `ROOT_ADMIN_PASSWORD:-admin`; `compose.server.yaml` files default DB passwords and secrets to `admin`

**Impact** — the session secret is public (it is in the repository), so anyone can forge a signed Canopy
session for any account with role admin (`auth_canopy.py` HMAC tokens). `admin/admin` opens Canopy,
Haber, Gateway and Root consoles.

**Fix** — replace every secret default with `${VAR:?must be set}`; generate per-site secrets at install
(`openssl rand -base64 48`); bootstrap admin must change password; API refuses to start when a secret is a
known demo value or shorter than 32 bytes.

### F2 — Sync secret = Canopy admin takeover (Critical)
**Evidence** — `routes/sync_ingest.py:342` `POST /api/sync/v1/directory` (only `require_sync_secret`) calls
`directory.apply_record(..., from_canopy=False)`, which inserts/updates `auth_user` with caller-supplied
`password_hash`, `role`, `all_units`, `admin_pin_hash` (`directory.py:255-300`). The response returns the
Leaf directory (with password salts/hashes) for a caller-chosen `leaf_id`, plus the AI service key.
`/api/sync/` is published on the Canopy edge.

**Impact** — whoever has the sync secret (the demo default, or copied from any one Leaf) becomes system
admin of that hospital account and can crack all password hashes offline. With multi-account Canopy the
damage stays inside one account (each account has its own secret), but within it the impact is total.

**Fix** — per-Leaf credentials bound to `leaf_id` (mTLS or per-Leaf key) and check
`payload.leaf_id == authenticated Leaf`; never accept role / admin-PIN / all-units changes or new admin
users from a Leaf; never send password hashes or the AI key to Leaves in clear (Leaf-side login against
Canopy, or per-Leaf encryption).

### D1–D5 — Vulnerable dependencies
See [03-pre-scan-results.md](03-pre-scan-results.md): upgrade Pillow ≥ 13.0.0, certifi ≥ 2026.10.19,
cryptography ≥ 50.0.0, Starlette ≥ 1.3.1 (with a FastAPI release that supports it), Vite ≥ 7.3.7;
pin them so image builds cannot regress.

### F3 — Gateway data-api without authentication (High)
`flora-gateway/edge/nginx.conf` `location /data-api/` → Kong → Rust server (`rust/crates/server/src/main.rs:65-68`
`/api/observations`, `/api/measurements`, `/api/devices/status`), no auth plugin in `kong/kong.yaml`; per-Leaf
paths are only query filters. **Impact:** anyone on the LAN reads live vitals of every bed.
**Fix:** Kong `key-auth` (per-Leaf key) or mTLS; remove the catch-all `/data-api` route; allow-list Leaf IPs.

### F4 — Device listeners open on all interfaces (High)
`flora-gateway/compose.yaml:101, 108-111` publish 7423, 7421, 7422, 9500 on 0.0.0.0;
`webhook-controller/src/main.rs:63` binds 0.0.0.0 without a token. **Impact:** open ports in the scan;
injection of fake vitals/alarms (patient-safety risk). **Fix:** bind to the device-VLAN interface
(`FLORA_DEVICE_BIND_ADDR`), host firewall allow-list of monitor IPs, token on the webhook.

### F5 — Open image registry (High)
`flora-canopy/edge/nginx.conf:60` `location /v2/` → `registry:3` without auth (`compose.yaml:171-176`);
`compose.server.yaml` enables delete. **Impact:** anyone can list, push or delete images (signed,
digest-pinned releases block code execution, but deletion breaks updates). **Fix:** registry htpasswd/token
auth; edge allows only GET/HEAD from node IPs; disable delete.

### F6 — Docker socket mounts (High)
`flora-canopy/compose.yaml:194` (updater, plus `..:/host`), `flora-leaf/compose.yaml` (updater),
`flora-gateway/compose.yaml:208` (gateway-service, a login-protected web app) and `:255`.
**Fix:** docker-socket-proxy with an allow-list; remove the socket from gateway-service; document risk
acceptance for the updater.

### F7 — No brute-force protection (Medium)
No limiter on `central_auth.authenticate` / Canopy login, Haber and gateway Basic auth;
`directory.py:20` PIN `\d{4,8}` without attempt counter; unknown usernames skip scrypt (timing oracle);
password policy is length ≥ 8 only. **Fix:** per-IP + per-user lockout with backoff, nginx `limit_req` on
login paths, PIN ≥ 6 digits with lockout, dummy hash for unknown users, password policy per hospital rules.

### F8 — TLS configuration and security headers (Medium)
All edges: TLS 1.2/1.3 only and HTTP→HTTPS redirect (good), but no `ssl_ciphers`, no HSTS, no CSP /
X-Frame-Options / X-Content-Type-Options / Referrer-Policy, `server_tokens` on; certificates from the
Flora private CA. **Fix:** modern cipher list, `add_header` set (always), `server_tokens off`,
hospital-CA certificate (or register the Flora CA with the VA team).

### F9 — Public API docs, permissive CORS (Medium)
`flora-canopy/edge/nginx.conf:77` publishes `/docs` and `/openapi.json`; `main.py:102` default docs URLs;
`main.py:105` `allow_origins=["*"]` (credentials off, bearer header — low real impact, but flagged).
**Fix:** `docs_url=None, redoc_url=None, openapi_url=None` outside development; drop the edge locations;
origins = Canopy hostname.

### F10 — Sync-secret fingerprint oracle (Medium)
`routes/sync_ingest.py:222-225` unauthenticated, returns `sha256(secret)[:12]`. **Fix:** remove or require
auth; edge health check uses `/health`.

### F11 — Dev stack deployed (Medium)
`flora-canopy/compose.yaml:109-122` canopy-web runs `npm run dev --host 0.0.0.0` (`vite.config.ts:12`
`allowedHosts: true`); API `--reload`; `FLORA_API_ENV: development`; bootstrap admin on.
**Fix:** hospital installs use `Dockerfile.frontend.prod` (static nginx), no `--reload`,
`FLORA_API_ENV=production`, bootstrap admin only at first install.

### F12 — Session handling (Medium)
Token in localStorage (`authApi.ts:117`) with no CSP; Canopy tokens are stateless HMAC, 8 h TTL, logout
does not revoke, admin routes trust the token's role claim (`fleet_control.py:30`); Leaf TTL 30 days sliding;
`flora_account` cookie lacks `Secure`. **Fix:** strict CSP now; next: HttpOnly Secure SameSite cookie or a
server-side session table / deny-list; re-check `is_active` and role from the DB on admin routes; shorter
Leaf TTL; `Secure` on the account cookie when served over HTTPS.

### F13 — Containers as root (Medium)
Confirmed: canopy/api, canopy/haber, leaf/sync 1.2.9 run as uid 0; no `USER` in Dockerfiles; no
`cap_drop` / `read_only` / `security_opt`. **Fix:** non-root user, `cap_drop: [ALL]`, `read_only: true` +
tmpfs, `security_opt: [no-new-privileges:true]`.

### F14 — Updater trust on first use (Medium)
`flora-updater/updater.py:144` (“Trust on first use (demo)”); `compose.yaml:191` key empty by default.
Signature verification itself is sound (Ed25519, digests). **Fix:** bake the Root public key into the
updater image or make it a required variable.

### F15 — Admin SSRF (Low)
`routes/ai_settings.py:48-58` test call with a new host reuses the saved API key; `routes/ward.py:224`
fetches an admin-given URL and returns error text. **Fix:** require re-entering the key when the host
changes; outbound URL allow-list.

### F16 — Electron hardening (Low)
`electron/main.cjs:58` `sandbox: false` (context isolation on, node integration off — good); no
`setWindowOpenHandler` / `will-navigate` guard; `FLORA_FRONTEND_URL` override; PHI PDF previews in OS temp.
**Fix:** `sandbox: true`, deny navigation outside the app origin, per-user private temp directory.

### F17 — Webhook token in URL (Low)
`hl7_interface.py:20` `POST /webhook/{token}`. **Fix:** header token, or mask it in nginx `log_format`.

### F18 — Account enumeration / lookup cost (Low)
`auth_canopy.py` `GET /api/auth/account/{code}` (no auth); `account_middleware.py` scans every account
for `flk_` / webhook tokens. **Fix:** rate-limit; cache negative lookups; global token → account index in
`platform` schema (Phase 2 of multi-account).

### F19 — MCP DNS rebinding (Low)
`services/flora-mcp/server.py:143` `enable_dns_rebinding_protection=False`. **Fix:** enable with
`allowed_hosts` = Canopy hostname.

### F20 — Secrets in git (Info)
`flora-leaf/env/leaf-*.env`, `demo/leaf-test-01.env` (demo sync secret); old root `.env` in history
(`912a8fc^`, placeholders + `admin`). CA and server keys exist on disk but are git-ignored.
**Fix:** treat all demo values as burned (never use in hospitals); keep the CA key off servers.

### Needs verification
- FormDev query DSL → SQL compiler (`formdev/adapters/postgres.py:62`) not audited.
- `/api/fleet/*` reads require a session; ward scoping inside each handler not checked one by one.
- Leaf `GET /api/workstation/context` has no auth; check whether the Leaf edge proxies it.
- Root `compose.server.yaml:182` port entry not reviewed.
