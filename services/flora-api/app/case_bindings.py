"""Gateway devices bound to Leaf cases (case_device_binding) and the gateway links they use.

Exclusive: no other open binding of the device on this Leaf. Shared: no open exclusive one.
Callers hold pg_advisory_xact_lock(6893, 1) so starts and edits are checked one at a time.
"""
import os
import time
import uuid
from typing import Any

from psycopg import Connection

LEAF_ID = os.getenv("FLORA_LEAF_ID", "").strip()
HOSPITAL_ID = os.getenv("FLORA_HOSPITAL_ID", "hospital-dev").strip()
CONNECTED_LAG_MS = 10_000
BINDING_COLUMNS = """b.id::text, b.case_id, b.gateway_link_id, b.device_id, b.mode, b.bound_at, b.released_at,
                     b.release_reason, b.gateway_state, b.gateway_detail"""


def now_ms() -> int:
    return int(time.time() * 1000)


def case_uuid(case_id: int) -> str:
    """Canopy's global_case_id (routes/sync_ingest.py::_global_case_id)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{HOSPITAL_ID}:{LEAF_ID}:case:{case_id}"))


class DeviceInUse(Exception):
    def __init__(self, device_id: str, case_id: int):
        super().__init__(f"device {device_id} is in use by case {case_id}")
        self.device_id, self.case_id = device_id, case_id

    def body(self) -> dict[str, Any]:
        return {"error": "device_in_use", "device_id": self.device_id, "case_id": self.case_id}


def default_link_id(database: Connection) -> int | None:
    row = database.execute("SELECT id FROM leaf_gateway_link ORDER BY is_default DESC, id LIMIT 1").fetchone()
    return row["id"] if row else None


def normalize(database: Connection, devices: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Requested devices with a link id (the default link when left out), one per (link, device)."""
    result: dict[tuple, dict[str, Any]] = {}
    fallback = None
    for item in devices or []:
        device_id = str(item.get("device_id") or "").strip()
        if not device_id:
            raise ValueError("device_id required")
        mode = item.get("mode") or "exclusive"
        if mode not in ("exclusive", "shared"):
            raise ValueError("mode must be exclusive or shared")
        link = item.get("gateway_link_id")
        if link is None:
            fallback = fallback or default_link_id(database)
            link = fallback
        if link is None or not database.execute("SELECT 1 FROM leaf_gateway_link WHERE id=%s", (link,)).fetchone():
            raise ValueError("unknown gateway link")
        result[(int(link), device_id)] = {"gateway_link_id": int(link), "device_id": device_id, "mode": mode}
    return list(result.values())


def check_clash(database: Connection, devices: list[dict[str, Any]], case_id: int | None = None) -> None:
    for device in devices:
        other = database.execute(
            """SELECT case_id FROM case_device_binding
               WHERE released_at IS NULL AND gateway_link_id=%s AND device_id=%s AND case_id IS DISTINCT FROM %s::bigint
                 AND (%s::text = 'exclusive' OR mode = 'exclusive')
               ORDER BY bound_at LIMIT 1""",
            (device["gateway_link_id"], device["device_id"], case_id, device["mode"]),
        ).fetchone()
        if other:
            raise DeviceInUse(device["device_id"], other["case_id"])


def replace(database: Connection, case_id: int, devices: list[dict[str, Any]], current: int | None = None) -> None:
    """Make `devices` the case's open bindings: unchanged ones stay, the rest are released ("edited")."""
    current = current or now_ms()
    check_clash(database, devices, case_id)
    wanted = {(d["gateway_link_id"], d["device_id"], d["mode"]) for d in devices}
    for row in database.execute(
        "SELECT id, gateway_link_id, device_id, mode FROM case_device_binding WHERE case_id=%s AND released_at IS NULL",
        (case_id,),
    ).fetchall():
        key = (row["gateway_link_id"], row["device_id"], row["mode"])
        if key in wanted:
            wanted.discard(key)
        else:
            database.execute("UPDATE case_device_binding SET released_at=%s, release_reason='edited' WHERE id=%s",
                             (current, row["id"]))
    for link, device_id, mode in sorted(wanted):
        database.execute(
            """INSERT INTO case_device_binding (case_id, gateway_link_id, device_id, mode, bound_at)
               VALUES (%s, %s, %s, %s, %s)""", (case_id, link, device_id, mode, current))


def release(database: Connection, case_id: int, reason: str, current: int | None = None) -> None:
    database.execute(
        "UPDATE case_device_binding SET released_at=%s, release_reason=%s WHERE case_id=%s AND released_at IS NULL",
        (current or now_ms(), reason, case_id))


def bindings(database: Connection, case_ids: list[int], include_released: bool = False) -> dict[int, list[dict[str, Any]]]:
    """Bindings per case with the stream state derived from stored seconds."""
    rows = database.execute(
        f"""SELECT {BINDING_COLUMNS}, s.last_seq
            FROM case_device_binding b
            LEFT JOIN LATERAL (SELECT max(seq) AS last_seq FROM stream_second
                               WHERE case_id=b.case_id AND device_id=b.device_id) s ON true
            WHERE b.case_id = ANY(%s::bigint[]) AND (%s::boolean OR b.released_at IS NULL)
            ORDER BY b.case_id, b.bound_at, b.device_id""",
        (case_ids, include_released),
    ).fetchall()
    current = now_ms()
    result: dict[int, list[dict[str, Any]]] = {case_id: [] for case_id in case_ids}
    for row in rows:
        last_seq = row.pop("last_seq")
        lag = current - (last_seq + 1) * 1000 if last_seq is not None else None
        row["stream"] = {"connected": row["gateway_state"] == "bound" and row["released_at"] is None
                         and lag is not None and lag < CONNECTED_LAG_MS, "last_seq": last_seq, "lag_ms": lag}
        result[row.pop("case_id")].append(row)
    return result


def link_public(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    public = {key: value for key, value in row.items() if key != "token"}
    public["has_token"] = bool(row.get("token"))
    return public


def mirror_default(database: Connection, actor: str | None = None) -> None:
    """Keep the wizard's leaf_device_source in step with the default link (Ward page, older readers)."""
    row = database.execute(
        "SELECT gateway_id, data_api_url, updated_at FROM leaf_gateway_link WHERE is_default AND data_api_url IS NOT NULL"
    ).fetchone()
    if row is None:
        return
    database.execute(
        """INSERT INTO leaf_device_source (id, gateway_id, data_api_url, configured_by, configured_at)
           VALUES (1, %s, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET gateway_id=excluded.gateway_id, data_api_url=excluded.data_api_url,
             configured_by=coalesce(excluded.configured_by, leaf_device_source.configured_by),
             configured_at=excluded.configured_at""",
        (row["gateway_id"], row["data_api_url"], actor, row["updated_at"]))
