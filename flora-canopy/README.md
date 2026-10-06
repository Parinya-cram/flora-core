# Flora Canopy

One per hospital. Central database for every Leaf (Ward, ICU, ER, OR), the sync
API Leaves push to, the read-only Canopy viewer, and **Haber**, the hospital's
image repository and device registry.

```bash
docker compose up -d --build      # viewer http://localhost:7200, Haber http://localhost:7204
```

| Service | Port | Notes |
| --- | ---: | --- |
| canopy-web | 7200 | React viewer, `VITE_FLORA_SURFACE=canopy` |
| canopy-api | 7201 | `FLORA_API_MODE=canopy`, read-only `flora_view` role |
| canopy-db | 7202 | Own Postgres, not shared with any Leaf |
| sync-api | 7203 | `FLORA_API_MODE=sync`; Leaves push case snapshots here |
| haber | 7204 | Verifies Root's signed bundle and releases; serves Device Type / Device License to gateways; approves releases |
| haber-registry | 7205 | The hospital's copy of every Flora image (registry:3); nodes pull here |
| updater | — | flora-updater for this project (see `../flora-updater`) |

API and web build from the shared source in `../services/flora-api` and `../frontend`.
Every Leaf and the sync API must share `FLORA_SYNC_SHARED_SECRET`.

Haber endpoints: `POST /api/haber/v1/gateways/{id}/checkin` (Bearer `HABER_GATEWAY_TOKEN`),
`GET /api/haber/v1/nodes/{id}/desired`, `POST /api/haber/v1/nodes/{id}/report`, `GET /api/haber/v1/root-keys`
(Bearer `HABER_NODE_TOKEN`), and for the admin page `GET /api/haber/v1/overview`, `POST /api/haber/v1/root/sync`,
`POST /api/haber/v1/releases/{id}/approve`, `POST /api/haber/v1/components/{c}/hold`.

`compose.override.yaml` mounts the API source for hot reload and is loaded only by a
plain `docker compose up` here; `demo/up.sh` and release-managed sites use `-f compose.yaml`.

## Wards, users and LDAP

Canopy is multi-ward. A Leaf belongs to the ward (care unit) of the bed it is
assigned to in **Infrastructure**. Users are created once and then assigned to
wards separately from their roles (**System settings → User → Ward access**):

- Users only see Leafs and cases of their wards; *All wards* users (and system
  administrators) can switch ward from the top bar.
- Each Leaf's sync worker pulls the users of its ward (plus all-ward users) every
  cycle and caches them for offline sign-in. A user just assigned to a ward can
  sign in at that ward's Leafs immediately: the Leaf checks with Canopy when it
  does not know the user yet.
- Users can also be edited on a Leaf; saving there needs an administrator's PIN
  (set in Canopy under **Account → Admin PIN**). The newest change wins.

LDAP / Active Directory sign-in is configured on `canopy-api` and `sync-api`
(Leafs delegate LDAP sign-in to the sync API and cache the password hash locally):

| Variable | Example |
| --- | --- |
| `FLORA_LDAP_ENABLED` | `true` |
| `FLORA_LDAP_URL` | `ldaps://ad.hospital.local:636` |
| `FLORA_LDAP_BIND_DN` / `FLORA_LDAP_BIND_PASSWORD` | service account used to find the user |
| `FLORA_LDAP_BASE_DN` | `ou=people,dc=hospital,dc=local` |
| `FLORA_LDAP_USER_FILTER` | `(uid={username})`, AD: `(sAMAccountName={username})` |
| `FLORA_LDAP_NAME_ATTR` | `displayName` |
| `FLORA_LDAP_START_TLS`, `FLORA_LDAP_TLS_VERIFY` | `false`, `true` |
| `FLORA_LDAP_AUTO_PROVISION` | `true` creates unknown directory users on first sign-in |
| `FLORA_LDAP_DEFAULT_ROLE` | role for auto-provisioned users (no ward until assigned) |
