# flora-haber — device control plane as its own stack

Haber (release approve/mirror/hold, node desired-state, gateway check-in) and its image
mirror `haber-registry` used to live inside **flora-canopy**. They now run as their own
`flora-haber` stack so the device-distribution appliance can ship, scale and later move to
Kubernetes on its own.

## What changed
- **Decoupled from canopy-db.** Haber no longer opens `CANOPY_DATABASE_URL`. The one thing it
  read from canopy-db (the Leaf-node list for its overview/usage) now comes over HTTP from
  sync-api: `GET /api/sync/v1/leaves` (added in `services/flora-api/app/routes/sync_ward.py`,
  guarded by `FLORA_SYNC_SHARED_SECRET`). `psycopg` is dropped from Haber's image.
- **Cross-stack link is only the network.** `canopy-api` and `sync-api` join an external
  `flora_shared` network so they can resolve `haber` by name, and Haber can resolve `sync-api`.
- `haber_data` + `haber_registry_data` volumes move to this stack.

## Cutover (one time, on the VM) — does NOT touch canopy-db data
Everything below runs images; no database is dropped or migrated.

```sh
cd ~/flora-deploy
export FLORA_BIND_ADDR=0.0.0.0

# 1. shared network for canopy <-> haber
docker network create flora_shared        # idempotent; ignore "already exists"

# 2. stop the OLD haber inside flora-canopy (frees ports 7204/7205 + the volumes)
docker stop flora-canopy-haber-1 flora-canopy-haber-registry-1 || true
docker rm   flora-canopy-haber-1 flora-canopy-haber-registry-1 || true

# 3. bring up the new stack (reuses the same named volumes if the project keeps their names;
#    otherwise Haber re-mirrors from Root on first start — data-safe either way)
docker-compose -p flora-haber -f flora-haber/compose.server.yaml up -d --build

# 4. re-create canopy so canopy-api/sync-api join flora_shared and canopy drops its haber
docker-compose -p flora-canopy -f flora-canopy/compose.server.yaml up -d
```

Note on volumes: compose names volumes `<project>_<volume>`, so the old data was
`flora-canopy_haber_data` / `flora-canopy_haber_registry_data` and the new stack creates
`flora-haber_haber_data` / `flora-haber_haber_registry_data`. The registry is just a mirror of
Root's images, so a fresh one re-fills automatically on the next root sync + approve; to keep
the exact bytes, copy the volumes first:
`docker run --rm -v flora-canopy_haber_registry_data:/from -v flora-haber_haber_registry_data:/to alpine sh -c 'cp -a /from/. /to/'`
(same for `haber_data`).

## Verify
```sh
curl -s -u admin:admin http://127.0.0.1:7204/api/haber/v1/overview | head -c 200   # root: ok, leaves listed
docker exec flora-canopy-canopy-api-1 sh -c 'curl -s http://haber:8000/health'     # canopy-api reaches haber
```

## Edge routing
Nodes pull images from `HABER_REGISTRY_PUBLIC` (`172.22.1.151:7205`) and talk to Haber on
`:7204` — both still published on the host, so gateway/leaf/canopy updaters need no change.
The Canopy web edge routes `/api/haber`, `/haber`, `/v2` to `haber` / `haber-registry`; keep
those targets resolvable (the edge joins `flora_shared`, or routes to the host ports).

## Rollback
`docker-compose -p flora-haber down` then restore haber/haber-registry in
`flora-canopy/compose.server.yaml` (git revert this change) and redeploy flora-canopy.
Data is unaffected (canopy-db never changed).
