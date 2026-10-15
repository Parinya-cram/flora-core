# Flora on Kubernetes — migration design (draft for decision)

Status: **design / for review** — nothing here is deployed. It is the Phase 3 plan of the
device-distribution roadmap. Read [`../flora-haber/README.md`](../flora-haber/README.md) for
the Phase 1 Haber split this builds on.

## 1. Guiding principles
- **k8s is the capstone, not the foundation.** The compose + Haber + updater model already
  works and is offline-capable. Move to k8s deliberately, **tier by tier**, after Phase 1+2
  (Haber split + distribution UI) are proven.
- **Keep Haber as the approval control plane.** k8s changes only *how an approved release is
  applied* (the updater), not *who decides* (Haber) — so the Phase 2 UI is reused unchanged.
- **Offline-first stays.** The hospital keeps an in-cluster image mirror; nodes pull locally;
  Root can be offline; Ed25519 verification still gates every image.
- **Target k3s, not full k8s** — lightweight, on-prem / edge friendly, air-gap friendly.

## 2. Tier-by-tier decision (the crux — don't big-bang)
| Tier | k8s? | Why |
|---|---|---|
| **Root** (vendor) | separate concern | Builds/signs/publishes; stays the vendor's own managed service. |
| **Canopy** (canopy-db, canopy-api, sync-api, canopy-web, Haber, haber-registry) | **Yes — k3s, first** | Stateless APIs + one stateful DB + a registry → clean k8s fit; highest value. |
| **Leaf** (leaf-db, leaf-api, leaf-web, liveagent, sync-worker) | **Optional — k3s per site** | Offline-first OR workstation; can stay docker-compose or run single-node k3s per site. |
| **Gateway** (controllers, gateway-service, parser-per-device, kafka) | **No full k8s — docker, or k3s + operator** | Edge, real hardware (serial/USB/socket), spawns one container per device. Hardest; may stay docker. |

End-state is likely **k8s for the server tier (Canopy) + edge tiers on docker/k3s**, not
everything on one cluster.

## 3. Compose → k8s mapping (mechanical for stateless services)
Phase 1 already made this clean: DB decoupled from Haber, every cross-service link is an env
URL, the external `flora_shared` network = the cluster's own DNS.

| Compose | k8s |
|---|---|
| stateless service (canopy-api, sync-api, canopy-web, haber) | Deployment + Service + ConfigMap (env) + Secret (tokens/passwords) |
| edge nginx + cloudflared | Ingress (+ cert-manager / existing TLS) |
| canopy-db / leaf-db | StatefulSet + PVC (or external managed Postgres) |
| migrations (`/docker-entrypoint-initdb.d`) | initContainer or a Job (idempotent `psql -f`, as today) |
| haber-registry | in-cluster registry (Deployment + PVC), or k3s built-in — the offline mirror |
| named volumes | PVCs |
| `flora_shared` | cluster Service DNS (no change needed) |

## 4. The two real redesigns (these do NOT get cheaper by rushing)
### 4.1 updater → k8s-native rollout
Today `flora-updater` polls Haber `nodes/{id}/desired`, `docker pull`, `docker compose up`.
- **Option A (recommended): a small Flora controller.** Watches Haber desired-state, verifies
  Root's Ed25519 signature, then `kubectl set image` on the tier's Deployments. Keeps Haber as
  the source of truth + offline + signature verify + the Phase 2 approve UI. Least disruption.
- **Option B: GitOps (Argo/Flux).** Haber approval writes a manifest to git; Argo syncs. More
  standard but needs git reachable (weaker offline story) and duplicates Haber's role.
→ Recommend **A**; it reuses everything we built.

### 4.2 parser-per-device → Operator + CRD (the real engineering)
Today `gateway-service` spawns one parser container per device via the docker socket.
- Define a CRD **`Device`** (spec: `device_type`, parser image ref, `source_ip`, options, pod).
- A **Flora gateway operator** reconciles `Device` objects → one Pod/Deployment per device,
  injecting `DEVICE_ID`/`POD`/`PARSER`/`PARSER_OPTIONS`, pulling the parser image from the
  in-cluster mirror.
- The Rust **controllers** (serial/socket/feeder/webhook) need host hardware → DaemonSet with
  host serial/USB/network access (privileged / hostPath), or stay on the gateway host.
→ This is why the **gateway is the hardest**. Realistic options: **k3s at the gateway with the
  operator**, or **keep the gateway on docker-compose** and only move the server tiers.

## 5. Offline / air-gap
- In-cluster registry = today's haber-registry mirror; nodes pull from it, no internet needed.
- Approved images imported via the mirror (or `k3s ctr images import`); Root sync still gates
  what is approved; the controller verifies the Root signature before applying.
- A node keeps running its current images if the cluster control plane is unreachable (same
  guarantee as today's "already-pulled images keep running").

## 6. CI changes (extends Phase 0)
- After the `test` stage passes: **build + push images to a registry** (stop building on the
  server). `flora-root/scripts/publish_release.py` already builds + digest-pins + signs → this
  feeds k8s image refs directly.
- Package tiers as **Helm charts** (or Kustomize) rendered from the signed release manifest.
- Keep `test → build → publish → (Haber approve) → rollout` as the gate chain.

## 7. Config & secrets
- envs → ConfigMap (non-secret) + **Secret** (HABER_*_TOKEN, DB passwords, session secrets,
  AI keys). Rotate the `admin`/`admin` dev defaults before any real deployment.

## 8. Recommended order (each step shippable, production cut last)
1. **CI build+push** images after tests (extend Phase 0; no runtime change yet).
2. **Canopy tier on k3s** (canopy-db StatefulSet; canopy-api/sync-api/haber/canopy-web
   Deployments; haber-registry; Ingress). Prove it + the Phase 2 distribution UI on it.
3. **Flora controller** (updater replacement, Option A) for canopy self-update.
4. **Leaf on k3s** (optional, per site) — keep offline-first.
5. **Gateway operator + `Device` CRD** (hardest) — or decide the gateway stays docker.
6. **Cut production tier by tier**, Canopy first, with rollback per tier.

## 9. Open decisions (need sign-off before building)
- Gateway on k8s at all? (hardware access) — **k3s-privileged DaemonSet vs keep docker.**
- DB on k8s (StatefulSet+PVC) vs external managed Postgres.
- Single-node k3s vs HA multi-node (hospital scale / uptime needs).
- Ingress/TLS: replace edge nginx + cloudflared with Ingress + cert-manager, or keep edge.
- Leaf: k3s per site vs stay docker-compose.

## 10. What is reused unchanged (not thrown away)
- Haber as the approval control plane + its overview API + the **Phase 2 distribution UI**
  (it just points at the same Haber).
- Ed25519 signing/verification, digest-pinned images, the offline mirror concept.
- `flora-root/scripts/publish_release.py` and the release model.
- The Phase 1 DB decouple + env-driven URLs (already k8s-shaped).
