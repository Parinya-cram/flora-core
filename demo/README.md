# Flora platform demo (one machine)

Four separate Docker Compose apps that work together the way they would across a
real deployment. Every patient and device value is synthetic.

```
Flora Root      (cloud)      flora-root/     tenants · signed licenses · global config
 └─ Canopy      (hospital)   flora-canopy/   central DB · sync API · Haber device registry
     ├─ Leaf    (OR-1)       flora-leaf/     Electron/web workstation · local Postgres · sync worker
     ├─ Leaf    (ICU bed 1)  flora-leaf/     second instance of the same app
     └─ Gateway (devices)    flora-gateway/  Rust controllers · Kafka · Python parsers · Kong data-api
```

The apps only talk to each other through published host ports, exactly like
separate machines would. To split them across machines, change the URLs in the
env files (`FLORA_ROOT_URL`, `HABER_URL`, `CANOPY_SYNC_URL`, `LEAF_DEVICE_READ_URL`).

## Run it

```bash
./demo/up.sh        # build + start everything, open a demo case on each Leaf
./demo/status.sh    # health of every tier + device data path
./demo/down.sh      # stop (keeps data);  ./demo/down.sh --reset  wipes demo volumes
./demo/test-sync-outage.sh   # proves Leaf → Canopy sync recovers by itself after an outage
```

The first build takes a few minutes (the Rust image compiles inside Docker).
Vitals show up on each Leaf chart within about a minute of the case opening.

## Where to look

| What | URL | Sign in |
| --- | --- | --- |
| Root admin (cloud) | http://localhost:7100 | `admin` / `admin` |
| Canopy viewer | http://localhost:7200 | `admin` / `admin` |
| Canopy Haber | http://localhost:7204 | `admin` / `admin` |
| Gateway admin | http://localhost:7400 | `admin` / `admin` (localhost only) |
| Device simulator | http://localhost:7420 | — |
| Leaf OR-1 | http://localhost:7300 | `admin` / `admin` |
| Leaf ICU bed 1 | http://localhost:7310 | `admin` / `admin` |

Every system defaults to `admin` / `admin`. Leaf and Canopy skip the forced
password change (`FLORA_BOOTSTRAP_ADMIN_MUST_CHANGE_PASSWORD=false`); Root, Haber
and the Gateway admin page use a browser sign-in (`*_ADMIN_USERNAME` /
`*_ADMIN_PASSWORD`). If a Leaf or Canopy password was changed, put it back with
`./demo/reset-admins.sh`.

## What the demo shows

1. **Root → Canopy licensing.** Root signs the hospital's license bundle with
   Ed25519. Haber verifies the signature, caches the bundle and reports usage
   (Leaves, gateways, devices) back to Root. Root's page shows the usage bars.
2. **Canopy → Gateway.** The gateway checks in to Haber, receives the device
   catalog (Device Type, Image) and its share of the device license, then starts
   one parser container per device instance.
3. **Five device paths through the gateway.**

   | Device | Path | Leaf |
   | --- | --- | --- |
   | OR patient monitor | HL7 v2 ORU over MLLP → socket-controller pod `9001` → `hl7v2` parser | OR-1 |
   | OR anesthesia machine | JSON POST → webhook-controller pod `9003` → `json_fields` | OR-1 |
   | OR temp/CVP module | RS-232 (virtual COM port), **polled**: parser sends `?` via `gw.cmd.serial.COM1`, device answers | OR-1 |
   | ICU patient monitor | HL7 v2 over MLLP → socket pod `9002` → `hl7v2` | ICU-1 |
   | ICU ventilator | feeder-controller polls an HTTP endpoint every 5 s → `json_fields` | ICU-1 |

4. **Leaf pulls.** Each Leaf's device writer reads its own Kong route
   (`/data-api/leaf-or-01`, `/data-api/leaf-icu-01`), so each workstation only
   sees its own bedside devices. No Leaf code changed: the gateway's data-api is
   Vector-compatible.
5. **Leaf → Canopy sync.** Each Leaf's sync worker pushes case snapshots to the
   Canopy sync API; both Leaves appear in Canopy and in Haber.
6. **Egress push.** The publisher forwards every observation to the simulator's
   `/receiver` (the `pod:uri` box in the gateway diagram).

7. **Root → Haber → node updates.** Root is the only place images are built. A
   release pins each service of one component to an image digest and is signed
   by Root. Haber copies those digests into the hospital registry (`:7205`), the
   hospital approves the release on Haber's **Releases** tab, and every node's
   `flora-updater` sidecar pulls from Haber and recreates only the changed
   services. Leaves wait until no case is open. See [flora-updater](../flora-updater/README.md).

### Try a release

```bash
./demo/release.sh 1.2.3            # build, push, publish and approve canopy, leaf, gateway 1.2.3
./demo/release.sh 1.2.4 gateway    # just the gateway (parsers restart one at a time)
```

Watch it on Haber's **Nodes** tab (`http://localhost:7204/#nodes`) or with
`./demo/status.sh`. The demo cases keep each Leaf on **waiting · active case**
until the case is discharged. To roll back, approve the older release on Haber's
**Releases** tab. **Hold** stops a component from following approvals.

### Try the license controls

On the Root page, **Revoke** the hospital's license. Within about 30 s Haber picks
up the revoked bundle, the gateway marks its license invalid and stops every
parser container; Leaf charts stop receiving new vitals. **Edit license** issues
a new bundle and the parsers come back. Lowering *Max gateway devices* below the
running count blocks adding new devices on the gateway.

To speed it up instead of waiting for the sync loops:

```bash
curl -X POST localhost:7204/api/haber/v1/root/sync
curl -X POST localhost:7400/api/haber/sync
curl -X POST localhost:7400/api/instances/reconcile
```

## Leaf Ward page, gateway wizard and case handover

**Ward page** (Leaf home, before the case). Everything comes from the Leaf's own
database first, so it works with no network: this workstation's case, prepared
admissions, recent cases, bedside devices, and the other beds of the ward as last
received from Canopy. The sync worker refreshes it every `FLORA_SYNC_INTERVAL_SECONDS`;
**Sync now** runs a full sync immediately (about 1 s).

**Set up gateway** (Ward page → Bedside devices). Five steps: choose a gateway
registered in Canopy → test the connection from this Leaf → assign this bed's
devices (saved in Canopy; the gateway applies it on its next check-in, no inbound
connection) → check live readings → save. The device writer then reads
`<data-api>/api/observations?leaf_id=<this leaf>`; without a saved source it falls
back to `VECTOR_READ_URL`. Gateways report their LAN data-api address with
`GATEWAY_DATA_API_URL`.

**Take over a case** (Ward page → Other beds → Take over), e.g. when a workstation
fails. Each Leaf sends Canopy a full copy of its active case (every row, not only
the 24 h viewer window). The new Leaf imports that copy, translating local ids
(I/O items by code, concepts by domain/local id), and continues the case; Canopy
marks the original handed over and, optionally, moves the bed's devices in the
gateway configuration. The old Leaf locks its copy read-only when it next connects.
Needs Canopy online; entries made on the old Leaf after its last sync are not
included. Only one open handover per case; the receiving Leaf must be idle.

## Canopy on 443 only

Canopy has one public port: an nginx edge on 443 (`flora-canopy/edge/`). Leaves,
Gateways and updaters all connect out to it, so they can sit behind NAT; Canopy
never opens a connection to them.

| Path | Goes to | Used by |
| --- | --- | --- |
| `/api/sync/` | sync-api | Leaf sync worker, Leaf login/directory |
| `/api/haber/` | Haber | Gateway check-in, flora-updater |
| `/haber/` | Haber admin page | browser |
| `/v2/` | haber-registry | Docker pulls (set `HABER_REGISTRY_PUBLIC=<canopy-host>`) |
| `/api/`, `/` | canopy-api, viewer | browser |

`demo/up.sh` creates a private dev CA (`flora-canopy/edge/make-dev-cert.sh`) and
trusts it on this machine's Leaf and Gateway (`demo/install-canopy-ca.sh`). For a
real site, put a publicly trusted certificate in `flora-canopy/edge/certs/` as
`canopy.crt` / `canopy.key`; Leaves and Gateways then need only
`CANOPY_SYNC_URL=https://<canopy-host>` and `HABER_URL=https://<canopy-host>`.

## Port map

Each app owns one block, so everything fits on one machine next to the original
`flora-core` dev stack (68xx/69xx).

| Block | App | Port | Service | Bound to |
| --- | --- | ---: | --- | --- |
| 71xx | flora-root | 7100 | Root API + admin page | all interfaces (Canopy calls it) |
| | | 7102 | root-db (Postgres) | 127.0.0.1 |
| | | 7105 | Root registry (CI pushes, Haber mirrors) | all |
| 72xx | flora-canopy | **443** | **edge (nginx, TLS): the only public port**, 80 redirects | all |
| | | 7200 | Canopy web (Vite) | 127.0.0.1 |
| | | 7201 | canopy-api | 127.0.0.1 |
| | | 7202 | canopy-db | 127.0.0.1 |
| | | 7203 | sync-api (Leaves reach it as `https://<canopy>/api/sync/`) | 127.0.0.1 |
| | | 7204 | Haber (gateways check in, updaters ask here) | all |
| | | 7205 | haber-registry (nodes pull images here) | all |
| 73xx | flora-leaf `leaf-or-01` | 7300 / 7301 / 7302 | web / API (Electron) / db | web all, rest 127.0.0.1 |
| | flora-leaf `leaf-icu-01` | 7310 / 7311 / 7312 | web / API / db | same |
| | next Leaf | 7320 / 7321 / 7322 | copy an env file | |
| 74xx | flora-gateway | 7400 | gateway-service admin | 127.0.0.1 |
| | | 7401–7406 | serial, feeder, webhook, socket, collector, publisher admin | 127.0.0.1 |
| | | 7410 | Kong `data-api` (Leaf pulls here) | all |
| | | 7412 | gateway-db | 127.0.0.1 |
| | | 7414 | Kafka (host listener) | 127.0.0.1 |
| | | 7420 | device simulator | 127.0.0.1 |
| | | 7421 / 7422 | HL7 MLLP pods (OR / ICU monitor) | all (devices connect) |
| | | 7423 | webhook pod (anesthesia machine) | all |
| | | 7430 | virtual RS-232 bridge (demo only) | 127.0.0.1 |

## Demo-only shortcuts

These keep the demo self-contained; none of them is acceptable at a site.

- Every sign-in is `admin` / `admin`, and secrets and passwords are fixed demo values in the compose files and
  `flora-leaf/env/*.env`. Replace every `*-demo-*` / `*-local-only` value.
- Root's admin API is open (`ROOT_ADMIN_KEY` empty), and Haber trusts the first
  Root public key it sees (`FLORA_ROOT_PUBLIC_KEY` empty). Set both.
- The gateway service and every `flora-updater` mount the Docker socket.
- Both registries are plain HTTP with no auth (Docker trusts `localhost`). At a
  site: TLS on both, Root registry pull-only per tenant, haber-registry push for
  Haber only, and nodes configured to trust Haber's certificate.
- Nodes trust the first Root key Haber hands them; pin `FLORA_ROOT_PUBLIC_KEY`.
- Releases are built from the dev Dockerfiles (`uvicorn --reload`, Vite dev
  server for the web UIs, which are not release-managed yet).
- Every app speaks plain HTTP. Put TLS in front of Root, the Canopy sync API,
  Haber and the gateway data-api.
