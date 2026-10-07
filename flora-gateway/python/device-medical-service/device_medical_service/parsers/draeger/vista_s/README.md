# Dräger Vista 120 S (central-station link)

- Parser name in config: `draeger_vista_s`.
- Device type: `draeger-vista-120s`.
- Transport: TCP. The monitor connects to the gateway as to its central station (CMS),
  on port 9500 at the reference site. Socket pod with `framing = "raw"` and `auto_ack = false`.

Ported from the gxt miot-monitor gateway (`services/miot-monitor/devices/vista-120-S-gw.rb`),
which ran against real Vista 120 S monitors.

## How the link works

1. The monitors find the CMS through a UDP broadcast every second (port 9610 at the
   reference site). The socket controller sends it from the pod's `[beacon]` setting.
   The payload is the capture from the gxt CMS. Bytes 94–101 hold two IPv4 addresses from
   that site, and their meaning is not verified.
2. A monitor opens a TCP connection. On the `connected` event the parser answers with the
   16-byte CMS greeting (`greeting_hex`).
3. The monitor streams messages. Each one starts with a uint16 length and a uint16 type
   (little endian). Only type `0x51` (vitals) is decoded; waveform and status messages are
   skipped by their length.

Vitals frame: a 12-byte header (`length = 12 + count × 6`, type `0x51`, stream position,
stream remaining, record count, reserved 0), then `count` records of `[uint16 id][float32 value]`.
`-1000.0` means no reading. A full frame is 58 records (360 bytes), but the parser accepts
any length that agrees with its record count. When the stream loses a message boundary,
the parser looks for the next header that proves itself (type, reserved 0, length matching
the count).

## Mapping (`flora_mapping.json`)

| Record | Name | Flora parameter | Unit |
| --- | --- | --- | --- |
| 0 | HR | `hr` | /min |
| 14 | RR | `rr` | /min |
| 15 / 16 / 17 | NIBP sys / dia / mean | `nibp_sys` / `nibp_dia` / `nibp_map` | mmHg |
| 19 | SpO2 | `spo2` | % |
| 20 | SpO2 pulse | `pr` | /min |
| 53 | T1 | `temperature` | Cel |
| 3, 18, 54 | ST, NIBP pulse, T2 | kept as measurements only | mm, /min, Cel |

The other record ids are not identified. They are dropped unless `record_unmapped` is
true, in which case they are kept in `gateway_measurement` with a null name.

NIBP is a spot reading, so it is charted once when the reading changes. The NIBP pulse
fills `pr` only for that reading, and only when SpO2 pulse is absent.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `source_ip` | none | Monitor IPv4. Required when several monitors share the pod; each device instance then picks its own connection. |
| `min_interval_sec` | 1 | At most one frame per interval is charted. A new NIBP reading is never held back. |
| `greeting_hex` | gxt CMS greeting | Bytes written when a monitor connects; `""` sends nothing. |
| `record_unmapped` | false | Also store unidentified record ids as measurements. |
| `records` | — | Override or extend `flora_mapping.json` by record id. |
| `max_buffer_bytes` | 65536 | Bound on bytes held while waiting for a message to complete. |

## Configuration

See the `vista` pod in [gateway.draeger.toml](../../../../../../config/gateway.draeger.toml)
and `or-vista-01` in [instances.draeger.json](../../../../../../config/instances.draeger.json).

The beacon is a UDP broadcast. From a Docker bridge network it does not reach the
monitor LAN, so on site run the socket controller natively or with host networking, or
configure each monitor's CMS address by hand. The demo simulator connects directly and
needs no beacon.

## Tests

From `flora-gateway/python/device-medical-service`:

```powershell
python -m pytest -q tests/draeger/vista_s
```
