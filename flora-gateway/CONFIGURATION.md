# Configure Flora-Gateway devices

Device connections are configured in files now. These files use the gateway's
existing schemas so a later app settings screen can manage the same fields.

## Choose the files

| Devices | Controller config | Initial device registrations |
| --- | --- | --- |
| Demo | `config/gateway.toml` | `config/instances.json` |
| M540 and MEDIBUS | `config/gateway.draeger.toml` | `config/instances.draeger.json` |
| Hidro GE, BCC, and HL7 | `config/gateway.hidro.toml` | `config/instances.hidro.json` |

Hardware profiles start disabled in **both** files. Their IP addresses and COM
ports are placeholders. Edit the connection settings and enable the selected
pods and instances when ready to connect.

A controller loads one TOML file. For a mixed installation, copy one file to
`gateway.site.toml`, merge the needed `serial.pods` and `socket.pods` entries, and
combine the matching instances into `instances.site.json`. Keep one `[serial]`
and one `[socket]` table, with unique pod IDs in each. Do not start two serial
pods on the same COM port. Choose either Aisys COM 1.2 or its legacy DRI
alternative for a given physical connection.

## What to edit

### Serial devices

Each `[[serial.pods]]` entry specifies:

| Field | Meaning |
| --- | --- |
| `id` | Stable connection name; the instance uses `serial.<id>` |
| `enabled` | Whether the controller opens this port; defaults to true if omitted |
| `path` | Windows `COM6` or Linux `/dev/ttyUSB0` |
| `baud` | Baud rate |
| `data_bits`, `parity`, `stop_bits` | 7 or 8 bits; `none`, `even`, or `odd`; 1 or 2 stop bits |
| `flow_control` | `none`, `hardware` (RTS/CTS), or `software` |
| `rts`, `dtr` | Optional explicit control-line values; normally omit `rts` when hardware flow control owns it |
| `idle_ms` | Silence before a raw chunk is sent to the parser |
| `max_frame_bytes` | Maximum buffered chunk before flushing; parsers separately bound their protocol buffers |

Starter values from the supplied source:

| Integration | Baud / bits / parity / stop | Flow control |
| --- | --- | --- |
| GE Carestation 750 | 19200 / 7 / odd / 1 | none, RTS+DTR asserted |
| GE Aisys CS2 active Hidro profile | 19200 / 7 / odd / 1 | none, RTS+DTR asserted |
| GE Bx50/B650 | 19200 / 8 / even / 1 | hardware, DTR asserted |
| GE S/5 | 19200 / 8 / even / 1 | hardware, DTR asserted |
| Legacy Aisys DRI alternative | 115200 / 8 / even / 1 | none, RTS+DTR asserted |
| MEDIBUS.X | 19200 / 8 / even / 1 | none, RTS+DTR asserted |

Confirm the settings selected on the actual device. The parser does not search
for a COM port, toggle Windows drivers, or take over ports from another process.
The Rust controller reconnects to its configured serial path if opening or I/O fails.

### Monitor network connections

For **M540**, edit the UDP pod's `port`, `multicast_interface`,
`multicast_groups`, and `source_ips`. The local interface is the workstation's
device-network IPv4 address. The monitor address belongs in `source_ips` and
the matching instance's `options.source_ip`. The missing M540 data port is `0`
until configured; an enabled pod cannot use port zero. See [DRAEGER.md](DRAEGER.md).

For **HL7**, use `transport = "tcp"`, `framing = "mllp"`, and `auto_ack = true`.
The monitor connects to the workstation's `bind_address`/`port`. Use
`source_ips` to restrict accepted peers and set the same monitor IP in the
instance's `options.source_ip`. A separate pod per monitor is simplest; if a
listener is shared, each parser must have a distinct source-IP filter.

For **B. Braun BCC**, set `remote_host` to the BCC server's IP and `port` to its
TCP port (Hidro default: 4001). Use `framing = "raw"`, `auto_ack = false`.
Here Flora connects **outward** to the device. `connect_timeout_ms`,
`read_timeout_ms`, and `reconnect_ms` control connection timeout, receive silence,
and reconnection delay. The parser supplies BCC checksums, requests, and ACKs.

### Device identities and parser options

Each JSON instance has a unique `device_id`, catalog `device_type`, `pod`,
`leaf_id`, `options`, and `enabled` flag. The pod name must exactly match its
TOML connection. Examples:

```json
{
  "device_id": "or-bx50-01",
  "device_type": "ge-bx50-dri",
  "pod": "serial.bx50",
  "leaf_id": "leaf-or-01",
  "options": {
    "pressure_roles": {"P1": "ART", "P2": "CVP"},
    "temperature_channel": "T1",
    "respiration_channel": "CO2_RR"
  },
  "enabled": false
}
```

Assign pressure roles only after confirming the channel connections. Without a
role, DRI P1–P4 stay channel-specific observations. Available temperature channels
are `T1`–`T4`; respiration can be `RR_IMP`, `CO2_RR`, or `FV_RR`.

BCC also requires `options.bed_id` and `options.address`. Address selects one pump
channel; records from other addresses are ignored. Give each pump its own device
instance and TCP pod. Do not put multiple polling parsers on one BCC pod.

Catalog defaults and instance options merge at the top level. An instance option
replaces the catalog value for that option. Protocol field maps and other
profile-specific options are described in [HIDRO.md](HIDRO.md) and
[DRAEGER.md](DRAEGER.md).

## Validate before connecting

From `flora-gateway`, using Python 3.11 or later:

```powershell
python scripts/validate_config.py config/gateway.hidro.toml config/instances.hidro.json
python scripts/validate_config.py config/gateway.draeger.toml config/instances.draeger.json
```

Validation checks parser options, catalog types, pod references, IP filters,
duplicate enabled COM ports, and whether enabled instances reference enabled
pods. It opens no network or hardware connections. Run it again after enabling
the actual pods and instances. Rust controllers also reject invalid active
connection settings at startup.

## Start with native Windows hardware controllers

From `flora-gateway`, choose the config filenames visible inside the Compose
`/config` mount:

```powershell
$env:FLORA_GATEWAY_CONFIG_FILE = 'gateway.hidro.toml'
$env:FLORA_GATEWAY_SEED_FILE = 'instances.hidro.json'
$env:SERIAL_ADMIN_URL = 'http://host.docker.internal:7501'
$env:SOCKET_ADMIN_URL = 'http://host.docker.internal:7504'
docker compose up -d --build kafka gateway-db server collector publisher kong gateway-service
```

This builds the parser image through Gateway Service's dependency. Rebuild and
restart Haber in the Canopy deployment so it loads the new device catalog.
Gateway Service syncs that catalog and the existing license before starting
enabled parser instances. Add a Kong route if the chosen Leaf is new.

Build the Rust hardware controllers using the host Rust/MSVC toolchain and its
native dependencies:

```powershell
cd rust
cargo build --release --locked -p serial-controller -p socket-controller
```

In each controller terminal, from `flora-gateway/rust`:

```powershell
$env:FLORA_GATEWAY_CONFIG = (Resolve-Path '../config/gateway.hidro.toml').Path
$env:FLORA_KAFKA_BROKERS = '127.0.0.1:7414'
```

Run `./target/release/serial-controller.exe` in one terminal and
`./target/release/socket-controller.exe` in another. Stop any old Hidro process
or competing controller that owns the same device port before starting its
replacement. Rust compilation is tested in Linux Docker; native Windows builds
and physical hardware behavior require verification on the workstation.

For Linux containers, map the serial device and use its container path. TCP
listeners need published ports. UDP multicast needs access to the device LAN
and the configured network interface; ordinary Docker Desktop port forwarding
does not expose a physical multicast interface.

## Apply changes and inspect status

Controller configuration is read at process startup. After editing TOML, restart
the affected native controller. Changing a parser's options requires restarting
that device's parser with the updated instance record.

**The JSON file is a seed, not an ongoing override.** Gateway Service inserts
missing device IDs once; editing a seed entry does not overwrite an existing
database record. Edit an installed device on the **Devices** tab of the station
admin (`http://localhost:7400`) or with `PUT /api/instances/<device_id>`; changing
its type, pod or options restarts its parser.

For a new instance in a running gateway:

```powershell
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('admin:admin'))  # a gateway user
$headers = @{ 'authorization' = "Basic $basic"; 'x-gateway-key' = $env:GATEWAY_ADMIN_KEY }
$devices = Get-Content '../config/instances.hidro.json' -Raw | ConvertFrom-Json
# Adjust the path above for your current directory. Select the intended device.
$device = $devices | Where-Object device_id -eq 'or-bx50-01'
Invoke-RestMethod 'http://localhost:7400/api/instances' -Method Post `
  -Headers $headers -ContentType 'application/json' -Body ($device | ConvertTo-Json -Depth 12)
```

Use `GET /api/config` to read the selected TOML and
`PUT /api/config/serial?restart=false` or `PUT /api/config/socket?restart=false`
to save a section for native controllers. When supplying `pods`, send the entire
desired list for that section. `restart=true` restarts Compose containers, not
native processes. A future UI must account for this distinction.

Check native controller status at `http://localhost:7501/status` and
`http://localhost:7504/status`, parser state at
`http://localhost:7400/api/instances`, and observations through the Leaf data API.
Verify the expected device ID, raw code, value, unit, and timestamp using
synthetic traffic first, then compare with the actual device output.
