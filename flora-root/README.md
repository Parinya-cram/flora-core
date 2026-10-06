# Flora Root

Cloud control plane for every tenant (one tenant = one hospital = one Canopy).

- **Tenants** with their own API key (Root stores only the hash).
- **License bundles**: modules, max Leaves, max gateways, max gateway devices and
  licensed device types, plus **global configuration**, signed with Ed25519.
- **Check-ins** from each Canopy's Haber with current usage and the release each node runs.
- **Releases** and the **Root registry** (`:7105`): Root CI is the only place Flora
  images are built. A release pins every service of one component (canopy, leaf,
  gateway) to an image digest, and each tenant gets its channel's releases as a
  signed manifest. Haber mirrors them; the hospital approves the rollout.

```bash
flora-root/scripts/publish_release.py gateway 0.2.0 --notes "MEDIBUS fixes"   # build, push, publish
```

```bash
docker compose up -d --build      # http://localhost:7100
```

| Endpoint | Caller |
| --- | --- |
| `GET /api/v1/keys` | Haber: Root public signing key |
| `GET /api/v1/tenants/{id}/bundle` | Haber (Bearer tenant key): signed bundle |
| `POST /api/v1/tenants/{id}/heartbeat` | Haber: usage report |
| `GET /api/v1/tenants/{id}/releases` | Haber (Bearer tenant key): signed release manifest for the tenant's channel |
| `POST /api/v1/releases`, `POST .../withdraw`, `PUT /api/v1/tenants/{id}/channel` | Root CI / admin |
| `POST /api/v1/tenants`, `PUT .../license`, `POST .../license/revoke`, `PUT /api/v1/global-config/{key}` | Root admin (`x-root-key` when `ROOT_ADMIN_KEY` is set) |
| `GET /api/v1/overview` | Root admin page |

## Operator sign-in

Open Root through the edge (`https://<root-host>/`, port 443 by default) and sign in at `/login`
(demo: `admin` / `admin` from `ROOT_ADMIN_USERNAME` / `ROOT_ADMIN_PASSWORD`, created only when no operator exists).

- Operators are `admin` (full control) or `viewer` (read only), managed under **System → Operators**.
  New operators and password resets must set their own password (10+ characters) at first sign-in.
- Server-side sessions in an HttpOnly, SameSite=Strict cookie: 30 min idle (`ROOT_SESSION_IDLE_MIN`),
  8 h maximum (`ROOT_SESSION_HOURS`). Signing out or changing a password ends them for real.
- 5 wrong passwords lock the account for 15 min (`ROOT_MAX_FAILED_LOGINS`, `ROOT_LOCK_MIN`);
  each IP is throttled too. Cookie writes must come from Root's own origin.
- Every sign-in, failure, lockout and change lands in **System → Audit log** (`root_audit`).
- Scripts keep working without a browser session: HTTP Basic with an operator account, or
  `x-root-key: $ROOT_ADMIN_KEY` (acts as admin `root-ci`). Haber keeps its tenant key.

Revocation and tenant suspension are delivered as a bundle with `expires_at = 0`,
so every tier enforces them the same way as expiry.

Before production: set `ROOT_ADMIN_KEY`, disable `ROOT_SEED_DEMO`, give each
Canopy the Root public key (`FLORA_ROOT_PUBLIC_KEY`), and keep the signing key in
a KMS/HSM instead of the database.
