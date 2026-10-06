# Flora Gateway

Low-level hardware integration for one bedside/OR network. Devices speak their
own protocols to the gateway; Leaf pulls clean, normalized observations from the
gateway's `data-api`.

Start with [CONFIGURATION.md](CONFIGURATION.md) for IP addresses, UDP/TCP ports,
serial settings, device registration, config selection, and restart instructions.
Developers: read [DEVELOPMENT.md](DEVELOPMENT.md) for the protocol folder map,
matching tests, and the steps for adding a driver.
The [Hidro migration guide](HIDRO.md) covers GE Carestation/Aisys, Bx50/S/5,
B. Braun BCC, and the shared HL7 profile.

Dräger M540 (IACS UDP) and MEDIBUS.X (RS-232) integrations are described in
[DRAEGER.md](DRAEGER.md), including hardware configuration examples and port scope.
See [Dräger parameter storage](DRAEGER-PARAMETERS.md) for original device fields,
their separate Flora mappings, and the migration required on existing databases.

```
                 INGRESS (Rust)                PROCESS (Python)                EGRESS (Rust)
RS-232 COMx ─▶ serial-controller  ─┐                                    ┌─▶ collector ─▶ Postgres ─▶ server ─▶ Kong data-api ─▶ Leaf (pull)
HTTP poll   ◀─ feeder-controller  ─┤   gw.raw.<pod>   device-medical-    │
HTTP POST   ─▶ webhook-controller ─┼─▶ Kafka ───────▶ service, one   ──▶ Kafka gw.obs ─┼─▶ publisher ─▶ pod:uri (push)
HL7/TCP     ─▶ socket-controller  ─┘   ◀── gw.cmd.<pod> container per        │
                                         (poll, ACK,   device instance       └─▶ gw.logs ─▶ collector ─▶ Logs
                                          settings)
        gateway-service (Python web): manage devices, restart containers, license from Haber at Canopy
```

## Layout

| Path | What |
| --- | --- |
| `rust/crates/gateway-core` | Config (`gateway.toml`), Kafka envelopes, Kafka helpers, admin `/status` endpoint |
| `rust/crates/serial-controller` | RS-232 ports; reads frames on line silence, writes commands back |
| `rust/crates/feeder-controller` | Polls device/vendor HTTP endpoints |
| `rust/crates/webhook-controller` | One listening port per pod for device/vendor pushes |
| `rust/crates/socket-controller` | TCP listeners/clients with MLLP / line / idle / raw framing; HL7 ACK; passive UDP multicast pods |
| `rust/crates/collector` | `gw.obs` + `gw.logs` → Postgres in batches (commit after store) |
| `rust/crates/server` | Vector-compatible read API (`/api/observations`, `/api/devices/status`) |
| `rust/crates/publisher` | Pushes observations to HTTP receivers |
| `python/device-medical-service` | Parser runtime; generic HL7/JSON/ASCII, M540, MEDIBUS, GE COM 1.2/DRI, BCC and Hidro HL7 profiles |
| `python/gateway-service` | Station admin web app (port 7400): sign-in, manufacturers, device types, installed devices, users |
| `python/device-simulator` | Synthetic devices for the demo |
| `config/gateway.toml` | Every pod of every controller |
| `config/instances.json` | Device instances seeded on first start |
| `kong/kong.yaml` | `data-api` routes, one per Leaf |
| `db/0001-gateway.sql` | Gateway store |

## Kafka topics

| Topic | Producer → consumer | Payload |
| --- | --- | --- |
| `gw.raw.<pod>` | controller → parser | `RawFrame`: pod, seq, ts, `utf8`/`base64` payload, meta |
| `gw.cmd.<pod>` | parser or gateway-service → controller | `Command`: bytes to write to the device |
| `gw.obs` | parser → collector, publisher | `Observation` (Vector row shape; `ivy_param` = Flora parameter key) |
| `gw.measurements` | Dräger parser → collector | Original decoded fields and source evidence, independent of Flora mapping |
| `gw.logs` | any component → collector | `LogEvent` |

A pod is `<controller>.<id>`, for example `serial.COM1`, `socket.or-monitor`.

## Updates

Images come from Flora Root through Haber, never from a local build at a site.
The `updater` sidecar (see `../flora-updater`) moves the Rust services and
gateway-service to the approved gateway release. The release also carries the
device-type catalog ([device-types.json](device-types.json), `"image": "parser"`);
gateway-service gets it from Haber with the parser image pinned by digest and
replaces one parser container per cycle, pulling the new image before it stops the old one.

## How Leaf connects

Leaf already reads a Vector-compatible endpoint, so no Leaf change is needed:

```
VECTOR_READ_URL=http://<gateway-host>:7410/data-api/<leaf-id>/api/observations
```

Kong adds `leaf_id` for that route, so a Leaf only sees devices assigned to it.

## Station admin

Open `http://localhost:7400` and sign in. The first start creates `admin` / `admin`
(override with `GATEWAY_ADMIN_USERNAME` / `GATEWAY_ADMIN_PASSWORD` before first start);
change it under **Users → My password**. Users, sessions and the device registry live
in the gateway database (`gateway_user`, `gateway_session`, `gateway_device_manufacturer`,
plus manufacturer/model on `gateway_device_type` and serial, asset tag, station, location
and install date on `gateway_device_instance`). gateway-service applies
`app/migrations/*.sql` on start.

API calls need a session cookie from `POST /api/auth/login` or HTTP Basic with a
gateway user (`curl -u admin:admin ...`). `/health` stays open.

Device types normally come from Canopy: Flora Root publishes them in releases with the
parser images, Canopy (Haber) mirrors those, and a hospital may define its own types at
its Canopy (`origin` = `root` or `canopy`). The gateway keeps their connection settings and
image; locally only manufacturer, model, description and connection defaults change.
A gateway **admin** may add a local template (`origin` = `gateway`) for a device Canopy
does not list yet. It must use a parser image Canopy delivered (`GET /api/parser-images`)
and a parser inside that image. Its type still needs the Root license, and a Canopy type
with the same code replaces it. **Operators** run devices, controllers and streams but
cannot change device types, manufacturers or users.

The **Streams** page tails `gw.raw.<pod>` (device → gateway) and `gw.cmd.<pod>`
(polls/ACKs back to the device) for every ingress pod. It shows frames/s and bytes/s
for the last 15 minutes and the latest 200 payloads per pod as text with visible
control characters, or as hex. It is held in memory only, starts empty when
gateway-service restarts, and never replays history to parsers.

Each device type also stores `connection_defaults` for its controller, using the same
keys as the pods in `gateway.toml`: serial `baud`, `data_bits`, `parity` (none/even/odd),
`stop_bits`, `flow_control`, `rts`, `dtr`, `idle_ms`; socket `transport`, `framing`,
`auto_ack` and timeouts; feeder `interval_ms`. The device's own address (COM path,
port, host, URL) stays on the pod. Defaults ship in `device-types.json` and can be
edited locally, including on Haber types.

Ingress controllers a station does not use can be stopped and started from the
Overview layers (`POST /api/controllers/<service>/stop|start`). Stopping one whose pods
still have running parsers returns 409 with the device list; the page asks again and
then retries with `?force=true`. A stopped controller stays down across Docker
restarts until it is started, but `docker compose up` starts it again.

## Add a device

1. The device type must exist in Haber's catalog (`flora-canopy/haber/app/catalog.json`)
   and be licensed by Root.
2. Add a pod for it in `config/gateway.toml` (or `PUT /api/config/<section>`), which restarts that controller.
3. Create the instance:

```bash
curl -u admin:admin -X POST localhost:7400/api/instances -H 'content-type: application/json' -d '{"device_id":"or2-monitor-01","device_type":"hl7-patient-monitor","pod":"socket.or2-monitor","leaf_id":"leaf-or-02"}'
```

Add a Kong route for a new Leaf in `kong/kong.yaml`.

## Add a parser

Create a protocol package under `python/device-medical-service/device_medical_service/parsers/`.
Subclass `Parser` from `parsers.shared.base`, register it in `parsers/__init__.py`,
add matching protocol tests, and reference it from a device type. Follow the
[developer guide](DEVELOPMENT.md) for the folder conventions and checklist.

```bash
cd python/device-medical-service && python -m pytest
cd rust && cargo test
```

## Production notes

- **Serial on Windows workstations.** Docker Desktop cannot pass COM ports into
  containers. Run `serial-controller` natively (`cargo build --release`), with
  `FLORA_KAFKA_BROKERS=localhost:7414` and `path = "COM1"` in `gateway.toml`.
  On Linux, map the device into the container (`devices:` in compose).
- **Kafka footprint.** Single-node Kafka needs about 0.5–1 GB RAM. If that's too much on a
  workstation, Redpanda is wire-compatible and smaller.
- **Retention.** Kafka keeps 72 h. `gateway_observation` has no pruning yet; add a
  daily delete older than the Leaf sync window.
- **License.** Device limits come from Haber; the gateway keeps the last license
  if Canopy is unreachable and stops parsers when it is revoked or expired.
