# Flora on Kubernetes — architecture & migration design (kubeadm)

Status: **design / for review** — nothing deployed. Phase 3 of the device-distribution
roadmap. Builds on the Phase 1 Haber split ([`../flora-haber/README.md`](../flora-haber/README.md))
and the Phase 2 distribution UI. Target: **upstream Kubernetes via `kubeadm`** (not k3s).

The emphasis of this doc is the **scale-out path**: start on one node, grow to a multi-node and
then HA cluster, and extend to multiple sites/hospitals — without re-architecting. All manifests
and Helm charts are identical across every stage; only the cluster grows underneath them.

---

## 0. Device-management model — decided (2026-10-15)
- **The device/image manager (Haber + registry) is a separate block = its own namespace** in the
  Canopy k8s cluster, egress-isolated: **only this namespace may reach the internet/Root**; every
  other Canopy namespace is egress default-deny. It downloads versions from Root and keeps the
  hospital's copy (the offline source). "แยกออกไปอีกก้อน" = this namespace + egress policy.
- **Each Leaf keeps its own local image cache** (its downloaded version), runs offline, and shows
  which version it holds — like a downloaded app.
- **Updates are manual, per node.** Approving a version at the appliance makes it *available*; each
  Canopy / Leaf / Gateway applies it only when an admin taps "update" for that node in the
  System-menu UI (opt-in, so an OR updates between cases, never mid-case). **Implication:** the
  rollout controller/updater runs in **opt-in mode** (not auto-apply-on-approve), and the Phase 2
  UI gains a per-node "update available → update" action + "installed version" indicator.

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
offline + signature verification + the Phase 2 approve UI. **Runs in opt-in mode (per §0):** an
approved version becomes *available*; the controller applies it to a node only after an admin
triggers "update" for that node — not automatically on approve. (GitOps/Argo is the heavier alternative
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

## 11. Observability & the central fleet monitor (Root) — the DevOps view
Two layers, by design:

**(a) Per-cluster stack (deep, local):** namespace `monitoring` with **Prometheus** (scrapes
kube-state-metrics, node-exporter, and each service's `/metrics` + `/health`), **Grafana**
(dashboards per tier), **Loki + promtail** (logs), **Alertmanager** (alerts → on-call / Haber).
This is the hospital's own ops view and works fully offline.

**(b) Central fleet monitor = Root (our own console, across every hospital).** Each site's Haber
already heartbeats to Root (`POST /api/v1/tenants/{id}/heartbeat`: canopy_version, bundle_id,
usage). We grow that into **Root's central DevOps dashboard**: every tenant × {approved release
per tier, device/node counts, node health & drift, last-seen, open alerts}. It is **coarse but
offline-tolerant** (store-and-forward heartbeats — always works even when a site's link is down),
so it is the single pane to answer "who is running what, and is anything unhealthy across the
fleet." → **This is the "ตัวจัดการ device กลาง": Root is the central monitor; Haber + the Phase 2
Canopy UI are the per-hospital console.**

Optional later: per-site Prometheus `remote_write` → a central Thanos/Grafana at Root for deep
cross-site metrics when links allow; the heartbeat fleet view remains the offline-safe baseline.

## 12. Backup & disaster recovery
- **etcd:** scheduled `etcdctl snapshot save` (kubeadm control plane) shipped off-node (NFS/S3).
- **Databases:** per-tier Postgres backups — `pg_dump` + WAL archiving, or **CloudNativePG**
  continuous backup if DB moves to an operator. Covers canopy-db / leaf-db / root-db.
- **PVCs:** **Velero** (namespace objects + PV snapshots) and/or **Longhorn** snapshots → NFS/S3.
- **haber-registry mirror:** snapshot to avoid a long re-mirror; it is also re-fillable from Root.
- **Haber state** (`haber_data`, approvals/mirror status) and **manifests/Helm** (in git = GitOps,
  self-recovering).
- **DR drill:** restore etcd + PVCs on a fresh cluster; document **RPO/RTO**; each offline site
  keeps its own local backups so it can recover without the vendor.

## 13. Security & RBAC
- **k8s RBAC (platform/ops):** least-privilege ServiceAccounts — the Flora controller may only
  patch Deployments in its tier namespaces; the gateway operator may only manage `Device`/Pods;
  **no cluster-admin for app workloads.**
- **NetworkPolicy (Calico):** default-deny per namespace; allow only real flows (web→api→db,
  haber↔sync-api, controller→apiserver). Sync endpoints internal-only.
- **Egress segmentation — Haber is the only internet-facing device-management image.** Only the
  Haber pod is allowed outbound to Root/internet (it mirrors images + syncs releases); **every
  other Canopy pod is egress default-deny**. So Canopy can be mostly air-gapped while one
  controlled component reaches out — "บางส่วนออกเน็ตได้ บางส่วนไม่ได้." Optionally route Haber's
  egress through a dedicated proxy for allow-listing + logging. This is the core rationale of the
  Phase 1 Haber split, now enforced by NetworkPolicy.
- **Secrets:** k8s **Secrets** (never ConfigMap) for tokens / DB passwords / session / AI keys;
  **Sealed Secrets** (or Vault) so they are git-safe; **rotate the `admin`/`admin` dev defaults**.
- **Image trust:** keep the **Ed25519 release verification** (already) + optionally cosign and an
  **admission policy (Kyverno/Gatekeeper)** that admits only images from the hospital mirror.
- **Pod Security:** `restricted` Pod Security Standard — non-root, drop caps, read-only rootfs
  where possible. Host-access pods (gateway operator/controllers) are the explicit, pinned
  exception on the edge pool.
- **Ingress:** TLS via cert-manager (keep the existing edge CA model); mTLS for inter-tier sync.
- **Audit:** k8s audit log + the app's own audit trails (e.g. formdev_audit) — two layers.
- **App RBAC vs k8s RBAC:** Flora's user roles (admin/clinician/…) stay for application access;
  k8s RBAC governs the platform. Keep them separate.

## 14. Open decisions (sign-off before building past the pilot)
- CNI: **Calico** (NetworkPolicy, scales) vs Flannel (minimal).
- LoadBalancer: **MetalLB** vs NodePort (+ external LB).
- Storage at scale: **Longhorn** vs external NFS/CSI; DB: in-cluster StatefulSet vs CloudNativePG.
- Multi-site shape: **cluster-per-hospital** vs namespace-per-tenant.
- Gateway: stays docker (recommended) vs edge k8s pool + Device operator.
- Observability: self-hosted **Prometheus/Grafana/Loki** (recommended, offline) vs managed.
- Backup tool: **Velero** vs per-component scripts; secrets: **Sealed Secrets** vs Vault.
- Central fleet monitor: extend Root heartbeat dashboard (recommended) vs central Thanos federation.

---

## 15. Reused unchanged (not thrown away)
Haber control plane + its overview API + the **Phase 2 distribution UI**; Ed25519 signing/verify;
digest-pinned images; the offline mirror; `publish_release.py` + the release model; the Phase 1
DB decouple + env-driven URLs (already k8s-shaped). Manifests/Helm are distro-agnostic — the same
charts that run the pilot run the HA cluster.

---

## 16. DevOps maturity — what's done vs what's still missing
**Done**
- All tiers containerized; compose production running; **Phase 0 CI test stage** (frontend+api)
  gating deploy; **Phase 1** Haber split + DB decouple; **Phase 2** device-distribution UI +
  Haber control plane; existing **release signing + digest pinning + offline mirror +
  approve/hold (rollback)**.

**Still missing (prioritized)**
- **P1 — close now**
  - CI **build + push + sign** in the pipeline (today only `test` runs; reuse `publish_release.py`).
  - **Image scanning + SBOM** (Trivy) and **secrets management** — move off `admin`/`admin`
    defaults to k8s Secrets + Sealed Secrets, with rotation.
  - **Liveness/readiness probes + resource requests/limits** on every k8s workload.
- **P2**
  - **Observability actually deployed** (Prometheus/Grafana/Loki + the Root fleet dashboard) —
    today it is design only; the running system has no metrics/log aggregation/alerting.
  - **Backup automation** (etcd snapshots, per-tier Postgres, Velero/Longhorn PVC). **Backup
    target can reuse the existing production machine (VM 151) as the backup store** — deferred;
    stand up the main k8s node first.
  - **IaC + GitOps** — codify cluster bootstrap (Ansible) and deploys (Argo/Flux) instead of
    manual kubeadm/CLI.
- **P3**
  - DR runbook + agreed **RPO/RTO**; load/capacity testing; dependency-update bot (Renovate);
    on-call alert routing; **gateway (stays docker) metrics fed into the Root fleet view**;
    a DB-migration rollback strategy (migrations are forward-only idempotent today).
