"""Sends the stream-hub's case UUID <-> device bindings (gateway_case_binding) to Canopy through
Haber, same pattern as activity.py. stream-hub resets `delivered` when it closes a row, so a row
is sent once open and again once closed."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import httpx

from . import db, settings

BATCH = 500
FIELDS = ("id", "session_id", "leaf_id", "case_uuid", "device_id", "mode", "bound_at", "unbound_at",
          "unbind_reason", "last_acked_seq")


def _json(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else str(value) if isinstance(value, uuid.UUID) else value


async def push() -> dict[str, Any]:
    if not settings.HABER_URL:
        return {"sent": 0, "reason": "Haber not configured"}
    rows = db.fetch_all("SELECT * FROM gateway_case_binding WHERE NOT delivered ORDER BY id LIMIT %s", (BATCH,))
    if not rows:
        return {"sent": 0}
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"{settings.HABER_URL}/api/haber/v1/gateways/{settings.GATEWAY_ID}/case-bindings",
            headers={"authorization": f"Bearer {settings.HABER_TOKEN}"},
            json={"gateway_id": settings.GATEWAY_ID,
                  "bindings": [{field: _json(row[field]) for field in FIELDS} for row in rows]},
        )
        response.raise_for_status()
        accepted = {int(item) for item in response.json().get("accepted") or []}
    with db.pool.connection() as connection:
        for row in rows:
            if row["id"] in accepted:
                # A row closed since it was read stays queued (its close is not at Canopy yet).
                connection.execute("UPDATE gateway_case_binding SET delivered=true "
                                   "WHERE id=%s AND unbound_at IS NOT DISTINCT FROM %s", (row["id"], row["unbound_at"]))
    return {"sent": len(accepted)}
