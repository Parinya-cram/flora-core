# Flora LiveAgent

Synthetic HTTP observation feed for development. It does not connect to or
control a medical device. B. Braun's real BCC driver is in
`flora-gateway/python/device-medical-service/device_medical_service/parsers/bbraun/bcc/`.

## Choose a profile

| `LIVEAGENT_PROFILE` | Devices |
| --- | --- |
| `stable-anes` | Existing simulated monitor and anesthesia machine (default) |
| `bbraun` | Two simulated B. Braun infusion pumps |
| `stable-anes-bbraun` | Existing demo plus both pumps |

From the repository root, with Docker running:

```powershell
$env:LIVEAGENT_PROFILE = 'stable-anes-bbraun'
docker compose -f compose.dev.yaml up -d --build flora-liveagent
```

Or set `LIVEAGENT_PROFILE` in the repository `.env` file. Shell environment
variables take precedence. This starts only LiveAgent; start Leaf separately
when testing its ingestion.

Open `http://localhost:6897/health` to confirm the profile, then
`http://localhost:6897/api/devices/status` to see pump identities and samples.
Port 6897 is the default; `FLORA_LIVEAGENT_PORT` can override it.

```powershell
$end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$start = $end - 120000
Invoke-RestMethod "http://localhost:6897/api/observations?from=$start&to=$end" |
    Where-Object protocol -eq 'bbraun-bcc' | ConvertTo-Json -Depth 8
```

## Pump configuration and behavior

Edit `app/bbraun_pumps.json` and rebuild the image to change device IDs, labels,
rates (`mL/h`), starting volume (`mL`), and pause intervals (minutes since start).
Each pump has a separate identity; readings from different pumps are not merged.

The scenario starts at the service's startup minute. Set optional
`LIVEAGENT_PUMP_START_MS` to Unix milliseconds for reproducible replay across
restarts. Pump records are absent before the start. Values are deterministic
for a given timestamp/configuration; polling does not advance the simulation.
Delivered volume increases while running, stops during the configured pause,
and is capped at the configured total. Completion sets rate to zero and raises
the simulated end-of-volume flag. Restarting with no fixed start resets the demo.

The existing LiveAgent API uses minute snapshots stamped at second 55. A query
returns snapshots for the minute buckets it touches, rather than strictly
filtering individual timestamps; the current-minute snapshot can be in the future.
Use completed minutes when comparing recorded timestamps.

Output uses Gateway BCC keys such as `infusion_rate`, `vtbi`, `infused_volume`,
`active_pumping`, and `end_of_volume_alarm`, with `BCC_*` raw-code labels.
Every row has `synthetic: true` and `source: liveagent`. The `run_state` strings
are human-readable demo labels, not a validated BCC status-code interpretation.
Drug name is a demo placeholder; patient identifiers and medication dosing are
not simulated. It is an HTTP data simulator, not a BCC wire-protocol simulator.

The pump rows are available through `/api/observations` and
`/api/observations/bulk`. A dedicated Leaf infusion display and mapping into
clinical infusion records are separate work; generating rows does not add them.

## Tests

```powershell
docker compose -f compose.dev.yaml run --rm --no-deps flora-liveagent python -m unittest discover -s tests -v
```
