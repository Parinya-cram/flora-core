"""Canopy's medical device registry (Device Management).

Canopy is the master record of every medical device and gateway. Gateway check-ins keep the
registry linked: a reported device is matched to its registry row by link, then by asset tag,
then by serial number; a device nobody registered yet is added with registry_status 'auto' so
an administrator can review it. Registry fields an administrator entered are never overwritten
by a check-in; empty serial / asset tag / type are filled in from what the gateway reports.
"""
from __future__ import annotations

from typing import Any

from psycopg import Connection

# Events that mean the device is (probably) off, and on.
OFF_EVENTS = {"power_off", "data_stopped"}
ON_EVENTS = {"power_on", "data_resumed"}


def _text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _unit_for_leaf(database: Connection, leaf_id: str | None) -> int | None:
    if not leaf_id:
        return None
    row = database.execute("SELECT unit_key FROM canopy_leaf_unit WHERE leaf_id=%s", (leaf_id,)).fetchone()
    return int(row["unit_key"]) if row and row["unit_key"] else None


def reconcile_reported(database: Connection, gateway_id: str, devices: list[dict[str, Any]], now: int) -> dict[str, int]:
    """Links (or adds) a registry row for every device a gateway reports. Runs in the check-in transaction."""
    stats = {"linked": 0, "added": 0}
    for device in devices:
        device_id = str(device["device_id"])
        serial, asset_tag = _text(device.get("serial_number")), _text(device.get("asset_tag"))
        device_type = _text(device.get("device_type"))
        row = database.execute(
            "SELECT id FROM canopy_medical_device WHERE gateway_id=%s AND gateway_device_id=%s",
            (gateway_id, device_id)).fetchone()
        if row is None:
            row = _match_unlinked(database, gateway_id, asset_tag, serial, device_type)
            if row is not None:
                database.execute(
                    """UPDATE canopy_medical_device SET gateway_id=%s, gateway_device_id=%s, updated_at=%s,
                              updated_by=%s WHERE id=%s""",
                    (gateway_id, device_id, now, f"gateway:{gateway_id}", row["id"]))
                stats["linked"] += 1
        if row is None:
            if asset_tag and database.execute(
                    "SELECT 1 FROM canopy_medical_device WHERE lower(asset_tag)=lower(%s)", (asset_tag,)).fetchone():
                asset_tag = None   # the tag belongs to a device another gateway still reports
            database.execute(
                """INSERT INTO canopy_medical_device (display_name, device_type, serial_number, asset_tag, unit_id,
                       location, registry_status, gateway_id, gateway_device_id, created_at, created_by, updated_at,
                       updated_by, notes)
                   VALUES (%s,%s,%s,%s,%s,%s,'auto',%s,%s,%s,%s,%s,%s,%s)""",
                (_text(device.get("label")) or device_id, device_type, serial, asset_tag,
                 _unit_for_leaf(database, _text(device.get("leaf_id"))),
                 _text(device.get("station")) or _text(device.get("location")), gateway_id, device_id,
                 now, f"gateway:{gateway_id}", now, f"gateway:{gateway_id}",
                 "Added automatically from a gateway check-in"))
            stats["added"] += 1
            continue
        # Fill gaps only; what an administrator entered stays.
        database.execute(
            """UPDATE canopy_medical_device SET
                 serial_number=coalesce(nullif(serial_number,''), %s),
                 asset_tag=CASE WHEN coalesce(asset_tag,'')<>'' OR %s::text IS NULL
                                     OR EXISTS (SELECT 1 FROM canopy_medical_device other
                                                WHERE lower(other.asset_tag)=lower(%s) AND other.id<>canopy_medical_device.id)
                                THEN asset_tag ELSE %s END,
                 device_type=coalesce(nullif(device_type,''), %s)
               WHERE id=%s""",
            (serial, asset_tag, asset_tag, asset_tag, device_type, row["id"]))
    return stats


def _match_unlinked(database: Connection, gateway_id: str, asset_tag: str | None, serial: str | None,
                    device_type: str | None) -> dict[str, Any] | None:
    """A registry row this report should attach to: same asset tag, else same serial (and type)."""
    if asset_tag:
        row = database.execute(
            """SELECT device.id, device.gateway_id, device.gateway_device_id FROM canopy_medical_device device
               WHERE lower(device.asset_tag)=lower(%s)""", (asset_tag,)).fetchone()
        if row and (row["gateway_id"] is None or not _still_reported(database, row, gateway_id)):
            return row
    if serial:
        row = database.execute(
            """SELECT device.id, device.gateway_id, device.gateway_device_id FROM canopy_medical_device device
               WHERE lower(device.serial_number)=lower(%s)
                 AND (device.device_type IS NULL OR %s::text IS NULL OR device.device_type=%s)
               ORDER BY device.gateway_id IS NOT NULL, device.id LIMIT 1""",
            (serial, device_type, device_type)).fetchone()
        if row and (row["gateway_id"] is None or not _still_reported(database, row, gateway_id)):
            return row
    return None


def _still_reported(database: Connection, row: dict[str, Any], reporting_gateway: str) -> bool:
    """True when the row's current link is a device some gateway still reports (not a move)."""
    if row["gateway_id"] == reporting_gateway:
        return True   # same gateway, different device id: keep both rows
    return database.execute(
        "SELECT 1 FROM canopy_gateway_device WHERE gateway_id=%s AND device_id=%s",
        (row["gateway_id"], row["gateway_device_id"])).fetchone() is not None


HOUR_FIELDS = ("samples_ok", "samples_down", "samples_stopped", "online_seconds", "observations", "first_data_ts",
               "last_data_ts", "power_on", "power_off", "complete", "version")


def store_activity(database: Connection, gateway_id: str, hours: list[dict[str, Any]],
                   events: list[dict[str, Any]], now: int) -> dict[str, Any]:
    """Upserts hourly rows (newer versions win) and inserts events; returns what Canopy holds."""
    accepted_hours, accepted_events = [], []
    with database.transaction():
        for hour in hours:
            database.execute(
                f"""INSERT INTO canopy_device_activity_hour (gateway_id, subject, device_id, hour_start,
                        {', '.join(HOUR_FIELDS)}, received_at)
                    VALUES (%s,%s,%s,%s,{', '.join(['%s'] * len(HOUR_FIELDS))},%s)
                    ON CONFLICT (gateway_id, subject, device_id, hour_start) DO UPDATE SET
                      {', '.join(f'{field}=excluded.{field}' for field in HOUR_FIELDS)}, received_at=excluded.received_at
                    WHERE canopy_device_activity_hour.version < excluded.version""",
                (gateway_id, hour["subject"], hour["device_id"], hour["hour_start"],
                 *(hour[field] for field in HOUR_FIELDS), now))
            accepted_hours.append({"subject": hour["subject"], "device_id": hour["device_id"],
                                   "hour_start": hour["hour_start"], "version": hour["version"]})
        latest: dict[str, dict[str, Any]] = {}
        for event in events:
            database.execute(
                """INSERT INTO canopy_device_event (gateway_id, event_id, device_id, event_type, basis, occurred_at,
                       detail, received_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (gateway_id, event_id) DO NOTHING""",
                (gateway_id, event["id"], event["device_id"], event["event_type"], event["basis"],
                 event["occurred_at"], event.get("detail"), now))
            accepted_events.append(event["id"])
            if event["device_id"] not in latest or event["occurred_at"] >= latest[event["device_id"]]["occurred_at"]:
                latest[event["device_id"]] = event
        for device_id, event in latest.items():
            database.execute(
                """UPDATE canopy_medical_device SET last_event_type=%s, last_event_at=%s
                   WHERE gateway_id=%s AND gateway_device_id=%s
                     AND (last_event_at IS NULL OR last_event_at <= %s)""",
                (event["event_type"], event["occurred_at"], gateway_id, device_id, event["occurred_at"]))
    return {"accepted_hours": accepted_hours, "accepted_events": accepted_events}
