# Devices (Canopy)

Canopy → **Devices** (tabs **Registry** and **Device types**) is the hospital's registry of medical devices and of the gateways that connect them. The page is grouped by ward. Each gateway sends hourly device activity and on/off events to it.

## Registry rules

- **Canopy is the master record.**
  - Administrators register devices with asset tag, S/N, manufacturer, model, category, ward, room/bed, status, acquisition date, warranty, PM dates, vendor contact and notes.
  - Administrators can also pre-register gateways.
- **Automatic additions.** A gateway that checks in without being registered appears with `registry_status = auto`, marked **Review**. So does a device it reports that is not registered yet.
  - Saving the record registers it.
  - An automatically added device takes its ward from the Leaf it feeds.
- **Matching on check-in.** When a gateway checks in, each device it reports is matched to the registry in this order:
  1. The existing link (`gateway_id`, `gateway_device_id`).
  2. The asset tag.
  3. The serial number (with the same device type).
  - If a device's tag or serial was on another gateway that no longer reports it, the device has **moved** and is re-linked.
  - A check-in only fills empty serial, asset tag and type fields. It never overwrites what an administrator entered.
- **Wards.**
  - A gateway belongs to `canopy_gateway.unit_id`. This is set by Topology → Set location or by the gateway registry form. It is kept at Canopy because the gateway's own site record does not store it.
  - A device belongs to its own `unit_id`.
  - Ward-scoped users see the gateways in their ward. They also see other gateways, under "Gateways in other wards", when those gateways serve devices in their ward.

## Device types

- **Flora Root release types** come from the approved gateway release through Haber. They are read-only at Canopy.
- **Hospital types** live in `canopy_device_type` and are managed by Canopy administrators: Devices → Device types → Add, or "Use as template" on a release type. Each type has:
  - code, name, category, manufacturer and model
  - controller and parser
  - protocol
  - connection defaults, checked with the gateway's own rules
  - default parser options
- **Delivery to gateways.**
  1. Canopy returns the enabled hospital types in its answer to every gateway check-in.
  2. Haber adds them to the gateway's catalog with `origin: "canopy"` and the release's digest-pinned parser image.
  3. A hospital type is licensed when the Root bundle licenses a type that uses the same parser. Haber then adds the hospital type's code to the gateway's `allowed_types`.
  - Codes already used by Root types are refused at Canopy and skipped by Haber.
- **Disabling and deleting.**
  - Disabling a type stops delivering it. Gateways keep the copy they already have.
  - A type that is in use cannot be deleted; disable it instead.

## Activity and events (gateway → Haber → Canopy)

| | Gateway | Canopy |
|---|---|---|
| Hourly rollup | `gateway_activity_hour` (migration `0010_device_activity.sql`), rebuilt every 10 min over the last 24 h | `canopy_device_activity_hour` |
| On/off events | `gateway_device_event` | `canopy_device_event`, plus `canopy_medical_device.last_event_*` |

- **Hourly rollup.** One row per device per hour, plus one row for the gateway service itself.
  - Counts the 30-second status samples by state: ok, down and stopped.
  - Also records seconds online, the number of values received, first and last data, and power on/off counts.
  - `complete=false` while the hour is still running.
- **Delivery.**
  - Rows are versioned and resent until Canopy confirms them, the same pattern as gateway alerts.
  - Route: `POST /api/haber/v1/gateways/{id}/activity` → Haber → `POST /api/sync/v1/gateways/{id}/activity`.

**What "on / off" means.**

| Event | Basis | Raised when |
|---|---|---|
| `power_on` / `power_off` | connection | The device's own link comes up or goes down: a TCP connection to a socket pod, UDP data on a socket pod, or answered polls on a feeder pod. Only on a pod used by that device alone. |
| `data_resumed` / `data_stopped` | data | Data starts again, or stops for 2 minutes. Applies to every device, but cannot distinguish power-off from an unplugged cable or an idle device. |

Serial pods do not raise power events, because "port open" describes the USB adapter, not the device. Disabling a device is a configuration change, not an event.

**Device state on the page:** On / Off / Disabled / Unknown (gateway offline) / Not reported / Not connected.

## API

**Canopy mode:**
- `GET /api/fleet/device-management` returns wards, gateways and devices, with 24 cells for the last 24 hours.
- `GET /api/fleet/device-management/devices/{id}?days=7` and `/gateways/{id}?days=7` return the detail views.
- `GET /api/fleet/device-management/link-options` lists devices that can be linked.
- `GET /api/fleet/device-management/device-types` returns the release types, the hospital types and the available parsers.

**Writes** (Canopy administrators), under `/api/fleet/control/device-management`:
- `POST /devices`, `PUT /devices/{id}`, `DELETE /devices/{id}`
- `PUT /devices/{id}/link`
- `POST /gateways`, `PUT /gateways/{id}`
- `POST /device-types`, `PUT /device-types/{code}`, `DELETE /device-types/{code}`

## Rollout

- **Canopy DB:** migration `0082-device-management.sql`. It has already been applied to the dev Canopy DB.
- **Gateway:** `gateway-service` applies `0010_device_activity.sql` itself on start.
- **Code that needs new releases:**
  - Canopy `sync-api`: the activity ingest, registry matching on check-in, and returning hospital device types in the check-in answer.
  - Haber: the relay, and adding hospital device types to the check-in catalog.
  - Gateway `gateway-service`: the rollup, events and push.
- Until then, gateways keep their activity queued locally and send it once the releases are in place.
