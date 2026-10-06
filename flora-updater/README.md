# flora-updater

One sidecar image for every Canopy, Leaf and Gateway compose project. It keeps the
project on the release the hospital approved in Haber.

```
Root CI ── build + push ──▶ Root registry :7105 ──┐
Root API ── signed release manifest (Ed25519) ─────┤
                                                   ▼
                     Haber: verify ▸ mirror digests into haber-registry :7205 ▸ hospital approves
                                                   │
          flora-updater (each node) ◀── desired release + Root's envelope, untouched
              verify Root signature ▸ safety gate ▸ write .release/<project>.env
              docker pull <haber>/<repo>@sha256 ▸ docker compose up -d --no-build
              health check ▸ roll back on failure ▸ report to Haber
```

- **Trust.** Haber can only pick among releases Root signed. The node checks Root's
  signature itself, and Haber hashes every manifest and blob it mirrors, so an image
  digest in a signed release cannot be swapped for other content.
- **Only what changed.** Compose image fields read `${FLORA_IMAGE_<SERVICE>:-<dev image>}`;
  the updater writes those variables and compose recreates only the services whose image
  moved (plus their dependents). Databases, Kafka and the dev web servers are not release-managed.
- **Safety.** `FLORA_UPDATER_GATE_URL` must not answer `{"status": "ACTIVE"}` (Leaf: no open case);
  an unreachable gate blocks the update. `FLORA_UPDATER_WINDOW=HH:MM-HH:MM` limits updates to a window.
- **Rollback.** If a service is unhealthy within `FLORA_UPDATER_HEALTH_TIMEOUT_SEC` (180), the previous
  env file is restored and that release is not retried until a new approval. Approving an older
  release in Haber rolls every node back.
- **Offline.** Nodes need only Haber. Haber needs Root only to receive new releases.

It discovers its compose project from its own container labels. It needs the Docker
socket and the project's parent directory mounted at `/host`; compose resolves bind
mounts to host paths, so the updater links the files at their host path inside the container.

| Env | Meaning |
| --- | --- |
| `FLORA_COMPONENT` | `canopy`, `leaf` or `gateway` |
| `FLORA_NODE_ID` | name shown in Haber (Leaf ID, gateway ID, `canopy`) |
| `HABER_URL`, `HABER_NODE_TOKEN` | Haber and its node token |
| `FLORA_ROOT_PUBLIC_KEY` | pin Root's key (otherwise trusted on first use, from Haber) |
| `FLORA_UPDATER_GATE_URL`, `FLORA_UPDATER_GATE_HEADER` | safety gate; header as `name: value` |
| `FLORA_UPDATER_WINDOW` | maintenance window, local time |
| `FLORA_UPDATER_INTERVAL_SEC` | poll interval (30) |

Known gaps: the updater does not update itself, does not notice drift when someone
runs compose without the release env file, and Windows hosts (drive-letter paths)
are untested.
