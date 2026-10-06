# Flora Leaf

One bedside/OR workstation: local Postgres, Leaf API, Leaf UI and the sync worker
that pushes to Canopy. It keeps working when Canopy is offline. Device data is
pulled from the workstation's Flora Gateway.

Each workstation is its own compose project with its own env file:

```bash
docker compose -p flora-leaf-or-01  --env-file env/leaf-or-01.env  up -d --build   # http://localhost:7300
docker compose -p flora-leaf-icu-01 --env-file env/leaf-icu-01.env up -d --build   # http://localhost:7310
```

To add a workstation, copy an env file, give it a new `FLORA_LEAF_ID` and the next
port block (7320/7321/7322, …), and add its Kong route on the gateway.

Electron connects to the Leaf API port:

```bash
FLORA_API_BASE_URL=http://127.0.0.1:7301 npm run desktop:start:no-build
```

API, sync worker and web build from the shared source in `../services` and `../frontend`.

Each project runs a `flora-updater` sidecar. When Haber approves a leaf release it
switches `leaf-api` and `leaf-sync` to the release images, but only while
`/api/case/status` reports no active case. Set `FLORA_UPDATER_WINDOW=02:00-05:00`
to also limit updates to a maintenance window. Once a node is on a release, keep
`--env-file .release/<project>.env` on manual compose commands (demo/up.sh does),
otherwise compose puts the dev images back. `compose.override.yaml` (dev only)
mounts the API source for hot reload.
