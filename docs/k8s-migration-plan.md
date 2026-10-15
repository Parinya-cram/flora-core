# Flora on Kubernetes — architecture & migration design (kubeadm)

Status: **design / for review** — nothing deployed. Phase 3 of the device-distribution
roadmap. Builds on the Phase 1 Haber split ([`../flora-haber/README.md`](../flora-haber/README.md))
and the Phase 2 distribution UI. Target: **upstream Kubernetes via `kubeadm`** (not k3s).

The emphasis of this doc is the **scale-out path**: start on one node, grow to a multi-node and
then HA cluster, and extend to multiple sites/hospitals — without re-architecting. All manifests
and Helm charts are identical across every stage; only the cluster grows underneath them.

---

## 1. Principles
- **k8s is the capstone, applied tier by tier** — the compose + Haber + updater model already
  works and is offline-capable; migrate deliberately, server tier first.
- **Haber stays the approval control plane.** k8s changes only *how* an approved release is
  applied (the updater → an in-cluster controller), not *who approves* (Haber). The Phase 2
  distribution UI is reused unchanged.
- **Offline-first stays** — the hospital keeps an in-cluster registry mirror; nodes pull locally;
  Root may be offline; every image is Ed25519-verified before it runs.
- **Same artifacts at every scale** — one Deployment/StatefulSet/Service/Helm set runs on a
  1-node cluster and on an HA multi-node cluster. Growth = add nodes, raise replicas.

---

## 2. Cluster topology & the scale-out path
```
STAGE 1 — single node (pilot)            STAGE 2 — add workers (scale out)
┌───────────────────────────┐           ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ control-plane + worker    │           │ control-pln │   │ worker A    │   │ worker B    │
│ (untainted)               │           │ (apiserver, │   │ canopy-api  │   │ canopy-api  │
│  canopy-db, canopy-api,   │           │  etcd,sched)│   │ sync-api…   │   │ (replicas)  │
│  sync-api, haber, web,    │           └─────────────┘   └─────────────┘   └─────────────┘
│  registry (all 1 replica) │                 kubeadm join  →  pods reschedule across workers
└───────────────────────────┘

STAGE 3 — HA (production)                  STAGE 4 — multi-site / multi-tenant
┌──────┐┌──────┐┌──────┐  control-plane x3   each hospital = its OWN cluster
│ cp-1 ││ cp-2 ││ cp-3 │  + stacked etcd      (Root is shared/vendor; Haber + registry per site),
└──────┘└──────┘└──────┘  + VIP (kube-vip)    OR one cluster, one namespace per tenant.
   │  worker pool (N)  │   + Longhorn (PVC HA) Root → each site's Haber → that site's cluster.
```
- **Stage 1 → 2:** `kubeadm join` more worker VMs; Deployments gain replicas and spread
  automatically (no manifest change). This is the "ขยายออกไปได้" core: add a VM, join, done.
- **Stage 2 → 3:** promote to 3 control-plane nodes (stacked etcd) behind a VIP (`kube-vip`
  or HAProxy); move storage to a replicated class (Longhorn) so PVCs survive a node loss.
- **Stage 3 → 4:** either a cluster per hospital (clean blast radius, matches the offline/
  per-site model) or one cluster with a **namespace per tenant** + ResourceQuota.

### Bootstrap (kubeadm)
- Runtime **containerd**; **kubeadm init** on the first node; CNI **Calico** (NetworkPolicy +
  scales to multi-node; Flannel if we want minimal).
- Single-node pilot: `kubectl taint nodes --all node-role.kubernetes.io/control-plane-` so the
  control-plane node also runs workloads. Removing that taint is undone automatically once real
  workers join.
- **Ingress:** `ingress-nginx` replaces the edge nginx; **MetalLB** (L2) gives bare-metal
  `LoadBalancer` IPs on the hospital LAN (or NodePort for the pilot). `cert-manager` for TLS.
- **Storage:** `local-path-provisioner` for the single-node pilot → **Longhorn** when multi-node
  (replicated PVCs for canopy-db + registry).

---

## 3. Node roles / pools (how the fleet is organised)
| Pool | Runs | Taint/label | Scale |
|---|---|---|---|
| **control-plane** | apiserver, etcd, scheduler | `node-role…/control-plane` | 1 → 3 (HA) |
| **server pool** | canopy (api/sync/haber/web/db), root (optional) | `flora.io/pool=server` | add VMs as load grows |
| **edge/gateway** | parser pods (if ever on k8s) | `flora.io/pool=edge`, host access | per-site; usually **stays docker** |
Workloads are pinned with `nodeSelector`/affinity to their pool, so server and edge scale
independently and gateway hardware nodes never receive server pods.

---

## 4. Tier → k8s objects (mechanical; Phase 1 already made it clean)
| Tier / service | k8s objects |
|---|---|
| canopy-api, sync-api, haber, canopy-web | Deployment + Service + ConfigMap + Secret (+ HPA) |
| canopy-db / leaf-db | **StatefulSet + PVC** (local-path → Longhorn for HA) |
| migrations (`/docker-entrypoint-initdb.d`) | Job / initContainer (idempotent `psql -f`, as today) |
| haber-registry | Deployment + PVC (the offline mirror) + Service |
| edge nginx + cloudflared | **ingress-nginx** + MetalLB/Ingress + cert-manager |
| `flora_shared` network | cluster Service DNS (no change — decoupled in Phase 1) |
| env URLs / tokens | ConfigMap (non-secret) + **Secret** (tokens, DB pw, session, AI key) |
Each is a Helm chart per tier (values per environment), rendered from the signed release.

---

## 5. The two real redesigns
### 5.1 updater → in-cluster Flora controller
Replace `flora-updater` (polls Haber, `docker compose up`) with a small **controller Deployment**
that watches Haber `nodes/{id}/desired`, verifies Root's Ed25519 signature, and `kubectl set
image` on the tier's Deployments (or patches a Helm release). Keeps Haber as source of truth +
offline + signature verification + the Phase 2 approve UI. (GitOps/Argo is the heavier alternative
but weakens the offline story.)

### 5.2 parser-per-device → Operator + `Device` CRD (only if gateway ever goes to k8s)
Today gateway-service spawns one parser container per device via the docker socket. On k8s:
a CRD **`Device`** (device_type, parser image, source_ip, options) + a **gateway operator** that
reconciles each `Device` into one Pod, pulling the parser image from the in-cluster mirror. The
Rust controllers (serial/socket) need host hardware → DaemonSet with host access, or stay on the
gateway host. **Recommendation: the gateway stays on docker-compose** (it already runs on its own
machine with real serial/USB hardware); revisit an edge k8s pool only if required.

---

## 6. Scaling each dimension (the extensibility story)
- **Stateless (canopy-api/sync-api/haber/web):** raise `replicas` or add an **HPA** (CPU/RAM or
  custom metrics); `kubeadm join` more workers and pods spread automatically. PodDisruptionBudgets
  keep a minimum during node drains.
- **Database:** single StatefulSet to start; scale by vertical PVC growth, then read replicas or
  move to an external/HA Postgres operator (CloudNativePG) when load demands.
- **Registry (haber-registry):** PVC grows with releases; front with a Service; a cluster can run
  a pull-through cache. Stays the offline source of truth per site.
- **More sites/hospitals:** a cluster per site (preferred — isolation + offline + a Haber each) or
  namespaces per tenant with ResourceQuota/NetworkPolicy. Root is the one shared upstream.
- **More device types / parsers:** no cluster change — they flow through the existing Root → Haber
  → registry → (apply) pipeline; the Phase 2 UI drives it at any scale.

---

## 7. Offline / air-gap (unchanged guarantee)
In-cluster registry = today's haber-registry mirror; nodes pull locally, no internet needed.
Approved images are imported to the mirror (or `ctr images import`); Root sync gates what is
approved; the controller verifies the Root signature before applying. A node keeps running its
current images if the control plane is unreachable — same guarantee as today.

---

## 8. CI/CD (extends Phase 0; runner lives on the GitLab host 172.22.1.103)
`test` (Phase 0) → **build + push images** to a registry after tests pass → publish a signed
release (reuse `flora-root/scripts/publish_release.py`: build + digest-pin + Ed25519 sign) → Haber
mirror → **admin approves in the Phase 2 UI** → the in-cluster controller rolls it out. Helm charts
(or Kustomize) are rendered from the signed release. Gate chain: `test → build → publish → approve
→ rollout`.

---

## 9. Phased rollout (each step shippable; production cut last)
1. **CI build+push** images after tests (no runtime change).
2. **Pilot: Canopy tier on a single-node kubeadm cluster** (new VM) — canopy-db StatefulSet;
   canopy-api/sync-api/haber/canopy-web Deployments; haber-registry; ingress-nginx. Prove it + the
   Phase 2 distribution UI. **Does not touch VM 151 / docker production.**
3. **Flora controller** (updater replacement) for canopy self-update.
4. **Scale out:** add a worker VM (`kubeadm join`), raise replicas, add HPA — validate scheduling.
5. **HA:** 3 control-plane + VIP + Longhorn (when moving toward production).
6. **Leaf** on its own cluster/namespace per site (optional; offline-first).
7. **Gateway** — stays docker (or an edge pool + Device CRD operator only if required).
8. **Cut production tier by tier**, Canopy first, rollback per tier.

---

## 10. Sizing (kubeadm is heavier than k3s — plan RAM)
| Node | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| Pilot single node (CP+worker+Canopy) | 4 | **16 GB recommended** (8 GB works, tight) | 80 GB | full k8s control plane ≈ 2 GB before workloads |
| HA control-plane (each ×3) | 2 | 4 GB | 40 GB | etcd stacked |
| Server worker (each) | 4 | 8–16 GB | 60 GB | scale by count |
Disk: registry mirror holds every approved image (≈6 GB today) — keep headroom.

---

## 11. Open decisions (sign-off before building past the pilot)
- CNI: **Calico** (NetworkPolicy, scales) vs Flannel (minimal).
- LoadBalancer: **MetalLB** vs NodePort (+ external LB).
- Storage at scale: **Longhorn** vs external NFS/CSI; DB: in-cluster StatefulSet vs CloudNativePG.
- Multi-site shape: **cluster-per-hospital** vs namespace-per-tenant.
- Gateway: stays docker (recommended) vs edge k8s pool + Device operator.

---

## 12. Reused unchanged (not thrown away)
Haber control plane + its overview API + the **Phase 2 distribution UI**; Ed25519 signing/verify;
digest-pinned images; the offline mirror; `publish_release.py` + the release model; the Phase 1
DB decouple + env-driven URLs (already k8s-shaped). Manifests/Helm are distro-agnostic — the same
charts that run the pilot run the HA cluster.
