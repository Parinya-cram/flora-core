# Dräger M540 and MEDIBUS integration

For file selection, validation, native startup, and applying changes, follow
[CONFIGURATION.md](CONFIGURATION.md). Both starter pods and device instances
are disabled until configured; enable the intended entries in each file.

The Vector integrations now use Flora-Gateway's existing data path:

```text
M540 UDP multicast → Rust socket-controller → gw.raw.socket.m540
                                               ↓ Python iacs_m540
                                            gw.obs → collector → data-api → Leaf
                                               ↑ Python medibus
MEDIBUS RS-232 ↔ Rust serial-controller ↔ gw.raw.serial.medibus / gw.cmd.serial.medibus
```

The parsers do not open sockets, serial ports, or databases. Gateway Service
starts one parser container per device using the two new Haber catalog types,
`draeger-iacs-m540` and `draeger-medibus`.

## What the port supports

| Integration | Implemented behavior |
| --- | --- |
| M540 | Passive IPv4 UDP multicast reception; explicit interface/group configuration; controller IP allowlist; per-instance source-IP selection; Vector's 12 numeric mappings; bounded block decoding |
| MEDIBUS.X | 19200/8E1 example with RTS/DTR; checksum validation; buffering across serial chunks; ICC/device-ID handshake; NOP and stop replies; sequential measured-page 1, page 2, and settings polling; timeout recovery |
| Observations | Flora `ivy_param`, numeric value, normalized unit, actual device ID, raw code, pod, and ingress timestamp |

M540 waveform blocks remain available in the low-level decoder for tests, but
waveforms are not published to `gw.obs`. MEDIBUS realtime waveform negotiation,
alarms, and variable-length text messages are not implemented. The MEDIBUS default
mapping is for the MEDIBUS.X code pages in the supplied VSCapture source; it is
not a claim that every classic MEDIBUS model uses the same codes.

Vector's M540 fixture is synthetic and its mapping is research-derived. Tests
verify the port against that fixture and constructed MEDIBUS packets. No physical
M540 or MEDIBUS device has been used to validate this port.

## Configuration files

Connection settings are configuration data, not values to edit in parser code:

| File | Settings |
| --- | --- |
| `config/gateway.draeger.toml` | M540 UDP port, bind address, multicast interface/groups, monitor IP allowlist; MEDIBUS COM port, baud, parity, data/stop bits, RTS/DTR |
| `config/instances.draeger.json` | Device IDs, Leaf assignments, each M540 monitor's `options.source_ip`, and MEDIBUS polling interval |

The current addresses and COM port are editable placeholders. Set the monitor IP
in both the UDP `source_ips` list and its instance's `options.source_ip`.
Controllers load the TOML selected by `FLORA_GATEWAY_CONFIG`. Gateway Service
reads initial device registrations from `FLORA_GATEWAY_SEED`; subsequent instance
changes belong in its database/API because the seed does not overwrite existing
registrations.

These files use the existing gateway schemas. A later app settings screen can
read/write controller settings through `GET /api/config` and
`PUT /api/config/{section}`. Per-device options already use the instance schema;
editing existing instances will need an update endpoint alongside the current
create API. Controller changes currently require a restart; native controller
restart support must be connected to that screen when it is built.

## Configure the hardware

Use [gateway.draeger.toml](config/gateway.draeger.toml) for the native
controllers. Edit the COM port, monitor IP, interface IP, and M540 UDP port in this file. `port = 0` is intentionally rejected.

The supplied Vector tree is missing `iacs-m540/config/m540_cfg.rb`, so its actual
M540 ports and discovery groups could not be recovered. The old gateway derives
each data group as `224.0.1.<last monitor IP octet>`; the example shows that rule,
but the group must be confirmed for the installation. This port uses explicit
group membership; it does not discover monitors or read the separate patient
information multicast stream.

Use one UDP pod per data port, with every required multicast group in that pod.
Create one parser instance per monitor and set `options.source_ip` to the monitor's
IP. That option is required: a parser ignores frames from other source IPs and
frames without source-IP metadata. `source_ips` filters at the controller too.

The UDP pod is receive-only. `auto_ack` and TCP framing do not apply. Its status
becomes connected after an accepted datagram, and becomes disconnected after ten
seconds without receiving traffic. This is listener status, not per-monitor
clinical availability; a shared pod can remain active while one monitor is silent.

MEDIBUS uses one serial pod and one parser instance per device. Confirm baud,
parity, data bits, stop bits, and adapter control-line requirements on the device.
The supplied VSCapture defaults are 19200 baud, 8 data bits, even parity, 1 stop
bit, RTS and DTR asserted. The parser handles protocol boundaries independently
of the serial controller's idle-based chunking.

## Run the integration

1. Rebuild the gateway parser image and Rust controllers. Rebuild/restart Haber
   so it loads the new catalog, then allow Gateway Service to sync. The gateway's
   existing license must permit the new device types.
2. Start the gateway Kafka/store/API stack using its normal Compose workflow.
3. Build and run the hardware controllers on the host that can reach the ports
   and multicast interface. For Windows, from `flora-gateway/rust`:

   ```powershell
   cargo build --release --locked -p serial-controller -p socket-controller
   $env:FLORA_GATEWAY_CONFIG = 'C:\path\to\gateway.draeger.toml'
   $env:FLORA_KAFKA_BROKERS = '127.0.0.1:7414'
   # Run each controller in its own terminal with those environment variables.
   .\target\release\serial-controller.exe
   .\target\release\socket-controller.exe
   ```

   The Windows native build requires a Rust/MSVC toolchain and the native build
   dependencies needed by librdkafka. Compilation in this change was checked in
   Linux Docker; Windows-native hardware operation still needs verification.
   The example uses admin ports 7501/7504 to avoid the demo controller ports.
   Gateway Service's default status polling/restart targets still point to its
   Compose controllers; inspect native status directly at those ports and
   restart native processes after configuration changes.

   On Linux, serial devices can be mapped into containers. Multicast reception
   needs access to the device LAN and interface; ordinary Docker Desktop port
   publishing does not supply a physical multicast interface to a container.

4. Adapt [instances.draeger.json](config/instances.draeger.json).
   It contains disabled starter instances, so it can be configured before polling
   hardware. Register each through `POST /api/instances` (include the configured
   admin key), or merge them into the normal seed file before startup. Enable
   each instance through the management UI after completing its configuration.
5. Use the existing Leaf route, for example
   `http://<gateway-host>:7410/data-api/leaf-or-01/api/observations`.

Native controllers and parser containers must use the same Kafka broker, gateway
ID, and pod names. The repository's demo configuration and demo seed are unchanged.

## Mapping and protocol behavior

Original decoded fields are now stored independently of Flora conversions.
See [DRAEGER-PARAMETERS.md](DRAEGER-PARAMETERS.md) for definitions, evidence,
the required database migration, and the original-measurement API.
Flora mappings ship beside each Dräger parser as `flora_mapping.json`;
the MEDIBUS source-reference dictionary is `device_parameters.json`.

- M540 `parameters` replaces the default rule list. Each rule supplies
  `source_keys`, `ivy_param`, `unit`, optional `scale`, `precision`, and
  `invalid_values`. No undocumented sentinel values are guessed. Unknown block
  tags and truncated known blocks reject the datagram. Values are never carried
  forward from previous datagrams.
- MEDIBUS `parameters` overrides individual rules using a page-qualified key,
  such as `24:D6` (respiratory rate) or `29:09` (set rate). Measured entries use
  two ASCII hex code characters plus four value characters; settings use five
  value characters. Decimal points are already present in the wire value.
- MEDIBUS mappings convert mbar to cmH2O, L to mL for set tidal volume, mL/min to
  L/min for gas flow, and L/bar to mL/cmH2O for compliance. Only codes with a
  matching Flora meaning are enabled. CO2 percentage values and generic tidal
  volume are not mislabeled as mmHg or expired tidal volume.
- Bad checksums, incomplete records, unavailable values, and unmapped codes
  produce no Flora observations. Valid MEDIBUS fields, including unavailable
  and unmapped fields, remain in the separate original-measurement store.
  An oversized or interrupted serial frame is discarded
  and parsing resumes at the next start byte. Realtime bytes do not interfere
  with the ASCII channel, but are not decoded as observations.
- Commands returned by `poll()` and replies returned by `drain_commands()` go
  through `gw.cmd.<pod>`. Polling allows one outstanding request. Missing replies
  restart initialization after `response_timeout_sec`; inactivity resets the
  session after `session_timeout_sec`. No ventilator setting-write commands are
  issued; the settings page reads current settings.
- Neither protocol provides a verified device timestamp here. `device_ts` stays
  null and `system_ts` uses the raw ingress frame's timestamp.

## Verification

```powershell
cd flora-gateway/python/device-medical-service
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

The suite covers the Vector M540 fixture, signed waveforms, truncation, identity
filtering, MEDIBUS handshake and timeout recovery, all split positions in a
sample measured-data packet, multiple packets per chunk, checksum corruption,
resynchronization, code-page separation, and unit conversion. A runtime test uses
an in-memory broker double to verify reply and observation topic routing.

Rust tests can run without a host toolchain:

```powershell
cd flora-gateway/rust
docker build -f Dockerfile.test -t flora-gateway-rust-tests:local .
```

See [third-party notices](python/device-medical-service/THIRD_PARTY_NOTICES.md)
for source attribution and the MEDIBUS port's license.
