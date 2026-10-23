# Remediation plan

Priority bands:
- **Before VA** — would be reported as Critical/High or is trivially found by any scanner. Fix and release
  before the vendor scans; otherwise the report is mostly our own known issues.
- **Before go-live** — fix before production use with real patients at the hospital.
- **Backlog** — hardening; can be accepted with a written risk note if needed.

Owner and date columns are for the team to fill in.

## Before VA

| # | Finding | Action | Effort | Owner | Target | Status |
|---|---|---|---|---|---|---|
| 1 | F1 | Remove secret defaults from all compose files (`${VAR:?}`); per-site secret generation script (`scripts/install/gen-secrets.sh`) writing `.env` with `openssl rand`; bootstrap admin must change password; API refuses demo/short secrets at start-up | M | | | Open |
| 2 | D1–D4 | Pin `Pillow>=13.0.0`, `certifi>=2026.10.19`, `cryptography>=50.0.0`; upgrade FastAPI + `starlette>=1.3.1`; rebuild images; run API test suites; re-run OSV check | M | | | Open |
| 3 | D5, F11 | Hospital compose uses `Dockerfile.frontend.prod` (static nginx), no `--reload`, `FLORA_API_ENV=production`; upgrade Vite ≥ 7.3.7 anyway | S | | | Open |
| 4 | F9 | Disable `/docs`, `/redoc`, `/openapi.json` unless development; remove edge locations; CORS = Canopy origin | S | | | Open |
| 5 | F10 | Remove `/api/sync/v1/fingerprint` (edge health check → `/health`) | S | | | Open |
| 6 | F8 | Edge hardening snippet included by every nginx conf: `server_tokens off`, cipher list, HSTS, CSP, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy; hospital-CA certificate for the scanned host | S | | | Open |
| 7 | F5 | Registry auth (htpasswd/token), edge `/v2/` GET/HEAD only from node IPs, delete disabled | S | | | Open |
| 8 | F3 | Gateway `/data-api` key-auth (per-Leaf key) or mTLS; remove catch-all route | M | | | Open |
| 9 | F4 | Bind device listeners to the device-VLAN address; firewall allow-list of monitor IPs; webhook token | S–M | | | Open |
| 10 | F7 | Login throttling: nginx `limit_req` on login paths now; app-level per-user lockout + PIN attempt counter; dummy hash for unknown users | M | | | Open |

## Before go-live

| # | Finding | Action | Effort | Owner | Target | Status |
|---|---|---|---|---|---|---|
| 11 | F2 | Per-Leaf sync credentials bound to `leaf_id`; reject role / admin-PIN / all-units / new-admin changes from Leaves; stop sending password hashes and AI key to Leaves in clear | L | | | Open |
| 12 | F13 | Non-root `USER` in all Dockerfiles; compose `cap_drop: [ALL]`, `read_only`, `no-new-privileges` | M | | | Open |
| 13 | F6 | docker-socket-proxy for updater; remove socket from gateway-service | M | | | Open |
| 14 | F14 | Root public key baked into updater image / required variable | S | | | Open |
| 15 | F12 | Strict CSP (from #6); Canopy session table or deny-list so logout and deactivation take effect; DB re-check of role on admin routes; Leaf TTL ≤ 12 h; `Secure` account cookie | M | | | Open |
| 16 | F20 | Rotate every demo secret in real sites; remove demo secrets from tracked env files (use `.env.example`) | S | | | Open |

## Backlog

| # | Finding | Action | Effort | Status |
|---|---|---|---|---|
| 17 | F15 | Re-enter AI key when host changes; outbound URL allow-list | S | Open |
| 18 | F16 | Electron `sandbox: true`, navigation / window-open guards, private temp dir for PDF previews | S | Open |
| 19 | F17 | Webhook token in header; mask in nginx logs | S | Open |
| 20 | F18 | Rate-limit account lookup; token → account index in `platform` schema | M | Open |
| 21 | F19 | MCP DNS-rebinding protection with allowed hosts | S | Open |
| 22 | — | Trivy image scan (OS packages) added to the release pipeline; fail build on Critical | M | Open |
| 23 | — | Verify items under "Needs verification" in 04-findings.md | M | Open |

Effort: S ≤ 1 day, M 2–4 days, L ≥ 1 week.

## Closing a finding

1. Fix merged and released (note the release number in the Status column).
2. Re-test with the same tool/request that showed it; save output in `va/evidence/<date>/`.
3. Mark **Closed (release x.y.z, evidence file)**. For accepted risks: **Accepted** + who approved + reason.
