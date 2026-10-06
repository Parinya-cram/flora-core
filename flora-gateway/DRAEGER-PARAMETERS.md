# Dräger original parameters and Flora mappings

There are two separate outputs. Do not interpret a Flora chart key as the
manufacturer's parameter name.

| Output | Purpose | Kafka topic | PostgreSQL table | Read API |
| --- | --- | --- | --- | --- |
| Original decoded fields | Inspect device codes, original values, and available definitions | `gw.measurements` | `gateway_measurement` | `/api/measurements` |
| Flora observations | Existing selected conversions for Leaf | `gw.obs` | `gateway_observation` | `/api/observations` |

## Source definitions versus chart names

Under `python/device-medical-service/device_medical_service/parsers/draeger/`:

- `medibus/device_parameters.json` contains 357 page-qualified definitions
  extracted from the supplied VSCapture `Class2.cs` enums for measured pages 1/2
  and settings. It preserves source symbols, descriptions, and comments verbatim.
  It is a **legacy reference**, not an official complete Dräger code dictionary.
- `medibus/flora_mapping.json` contains the 24 existing Flora conversions.
- `iacs_m540/flora_mapping.json` contains the 12 existing legacy IACS conversions.
  No verified manufacturer IACS dictionary was supplied; original names and
  units stay null instead of being inferred from Flora chart keys.

The local `vector/medibus/Draeger Communicate Protocol.pdf` is *MEDIBUS.X Rules
and Standards for Implementation*. Printed page 19 explicitly identifies MVe,
MV, MVi, VTe, VT, VTi, RR, RRf, RRc, and RRp with their page/code pairs. Those
names have an individual document reference in the catalog. The document refers
to *MEDIBUS.X Profile Definition for Data Communication* for the complete code
list. That profile must still be supplied to verify the entire dictionary.

`name: null` or `unit: null` means not established. Legacy source descriptions
and comments remain available even when these fields are null. Only the
original units already documented in the existing legacy conversion map are
populated; they remain marked as legacy evidence. Model support and firmware
compatibility are not established merely by inclusion in this catalog.

## What is preserved

Each measurement includes `device_id`, `protocol`, `pod`, `raw_code`,
`raw_value`, `value`, `definition`, `mapping`, `system_ts`, `device_ts`,
`gateway_id`, and `seq`.

- MEDIBUS `raw_code` includes the response command and field code, e.g. `24:D6`
  is measured page 1 RR, while `29:09` is a setting. These are distinct records.
- MEDIBUS `raw_value` preserves the original ASCII field, including padding;
  `value` contains the number before scaling, or null for non-numeric fields.
- IACS `raw_value` and `value` preserve the signed integer decoded from each
  numeric field. They are not asserted to be a physical value in a known unit.
- `definition` records the available source metadata and evidence. Unknown
  codes have no invented label or unit.
- `mapping` snapshots the optional Flora conversion rule. It is empty when
  there is no mapping. This does not make the legacy rule manufacturer-verified.
- Original `device_ts` remains null; `system_ts` is the ingress timestamp. For
  a fragmented serial response, the completing chunk supplies the timestamp
  and sequence number. Sequence numbers can reset on controller restart.

For example, a MEDIBUS setting `29:04` containing ` 0.45` is retained as that
exact string plus the numeric value `0.45`, with legacy source unit `L`. Its
separate Flora observation is `set_tidal_volume = 450 mL`.

Unmapped numeric fields and non-numeric/unavailable field contents are retained
in measurements, but are not introduced into Leaf's observation stream.
Malformed checksums/field codes reject the response. IACS unknown block layouts
still reject a datagram; this change does not decode arbitrary unknown blocks.
Waveforms, alarms, and MEDIBUS text-message pages are outside this measurement
path. Original packet bytes remain on `gw.raw.<pod>` under Kafka retention.

## Upgrade an existing Gateway

New databases initialize both SQL files automatically. Existing volumes need
this additive migration **before starting the updated collector/parsers**.
From `flora-gateway` with the site's Compose configuration selected:

```powershell
Get-Content -Raw db/0002-device-measurements.sql | docker compose exec -T gateway-db psql -U flora_gateway -d flora_gateway -v ON_ERROR_STOP=1
```

Then rebuild the Rust and parser images, recreate collector/server, and restart
the affected parser instances through Gateway Service so they use the rebuilt
image. Existing observations are not rewritten. Previously discarded decoded
fields are not automatically backfilled.

Both record types use the collector's existing transaction/retry behavior. A
replay may create duplicates; this change does not add exactly-once delivery or
database retention. Source-only measurements do not update observation-based
device status, so a device with only unmapped fields can still appear waiting.

## Inspect original readings

From PowerShell, while the Gateway is running:

```powershell
$end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$start = $end - 60000
$url = "http://localhost:7410/data-api/leaf-or-01/api/measurements?from=$start&to=$end&device_id=or-medibus-01"
Invoke-RestMethod $url | ConvertTo-Json -Depth 12
```

The response contains `rows` and `next_after_id`. For more records, keep the same
time/device filters and add `&after_id=<next_after_id>` until `rows` is empty.
Default limit is 1000, maximum 10000, and the default maximum time window is four
hours. Leaf routes restrict records by the current device registration.
The existing `/api/observations` response is unchanged.

## Verify without hardware

```powershell
# From flora-gateway
python scripts/test_measurement_storage.py
# From python/device-medical-service
python -m pytest -q tests
```

The storage test starts and removes its own temporary PostgreSQL container. It
checks migration reapplication, preservation of existing observations, original
field storage, conversion separation, and the actual API query's pagination
and device/Leaf filters. It does not connect to a medical device.
