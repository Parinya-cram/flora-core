# Device library (Root)

The Device library is the vendor-maintained list of **device settings per device type**: which parser
reads the device, how the gateway connects to it, the parser options and the connection defaults. It lives in
Flora Root and reaches every hospital's gateways without a new gateway release.

## How it flows

```
Root (root_device_profile)  --signed, every Root sync (15-20 s)-->  appliance / Haber (kv "device_library")
   --gateway check-in (every 20 s)-->  gateway-service  -> gateway_device_type table
```

- Root signs the library per hospital: `GET /api/v1/tenants/{tenant}/device-library` (tenant key auth).
- Haber (`flora-canopy/haber/app/main.py`, `gateway_catalog()`) takes the approved gateway release's
  catalog (else the built-in `catalog.json`) and lays the library over it: library settings win, new
  profiles are added, withdrawn profiles are dropped. Items from the library carry `origin: "library"` and
  `version: "lib-<revision>"`.
- Gateways get the result in the check-in answer (`device_types`) and upsert it
  (`flora-gateway/python/gateway-service/app/db.py`, `upsert_device_types`).
- Canopy's Device Distribution page shows the same list (Haber overview `gateway_catalog`).
- **Licensing still applies:** a hospital only runs device types its Root license lists. A new type must
  also be added under Root → Tenants → Edit license.
- On first use the library is seeded from the newest gateway release's `device_types`
  (= `flora-gateway/device-types.json` at build time).

## Fields

| Field | Required | Notes |
|---|---|---|
| `code` | yes | in the URL; `[a-z0-9][a-z0-9_.-]{1,63}`; the key gateways and licenses use |
| `label` | yes | display name |
| `controller` | yes | `socket` (TCP/HL7/MLLP), `serial` (RS-232/COM), `webhook` (device pushes HTTP), `feeder` (gateway polls HTTP) |
| `parser` | yes | parser name in `device-medical-service`, e.g. `hl7v2`, `json_fields`, `medibus`, `ge_dri` |
| `category` | no | e.g. `patient_monitor`, `ventilator`, `anesthesia_machine` |
| `protocol` | no | e.g. `hl7v2`, `json`, `draeger-medibus` |
| `image` | no | gateway release service that runs the parser; default `parser` |
| `default_options` | no | JSON object: parser settings |
| `connection_defaults` | no | JSON object: transport, framing, port, baud rate, `interval_ms`, timeouts… |
| `models` | no | list of Root catalog `device_type_id`s this profile serves |
| `notes` | no | free text |

Every save bumps `revision`. Profiles are never deleted, only **withdrawn** (and can be restored).

## API (Root, `https://<root>:8443`)

Writes need an **admin** operator (HTTP Basic with the operator's username/password, or `x-root-key` when
`ROOT_ADMIN_KEY` is set). Create a personal operator in Root → System → Operators; do not share `admin`.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/device-library` | all profiles (signed-in operator) |
| PUT | `/api/v1/device-library/{code}` | create or update one (JSON body = fields above, without `code`) |
| POST | `/api/v1/device-library/{code}/withdraw` · `/restore` | take out of / back into service |
| GET | `/api/v1/device-library.csv` | active profiles as CSV — also the import template |
| POST | `/api/v1/device-library/import[?dry_run=true]` | CSV (`content-type: text/csv`) or JSON list (`application/json`) |

```bash
curl -k -u USER:PASS -X PUT https://172.22.19.81:8443/api/v1/device-library/mindray-benevision-hl7 \
  -H "content-type: application/json" \
  -d '{"label":"Mindray BeneVision (HL7)","category":"patient_monitor","protocol":"hl7v2","controller":"socket",
       "parser":"hl7v2","default_options":{"timezone":"Asia/Bangkok"},
       "connection_defaults":{"transport":"tcp","framing":"mllp","auto_ack":true}}'

curl -k -u USER:PASS -X POST "https://172.22.19.81:8443/api/v1/device-library/import?dry_run=true" \
  -H "content-type: text/csv" --data-binary @devices.csv
```

## CSV import

- Columns: `code,label,category,protocol,controller,parser,image,default_options,connection_defaults,models,notes`
- `default_options` / `connection_defaults`: JSON text in one cell. `models`: separated by `;`.
- **All or nothing:** every row is checked first; if any row is wrong nothing is saved and the answer lists
  `{"row", "code", "error"}` for each bad row. Existing codes are updated (revision + 1).
- `dry_run=true` reports `created` / `updated` without saving. The Root UI (Device library → Import CSV)
  does the dry run, asks, then imports.

## Code

- Root: `flora-root/api/app/schema.sql` (`root_device_profile`), `flora-root/api/app/main.py`
  (section "device library"), UI tab `library` in `flora-root/api/app/static/index.html`.
- Appliance: `flora-canopy/haber/app/main.py` — `sync_root()` fetches it, `gateway_catalog()` merges it.
