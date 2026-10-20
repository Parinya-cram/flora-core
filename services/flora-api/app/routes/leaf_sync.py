"""The sync worker's memory on the Leaf (0091-leaf-sync-state.sql): which cases to send to Canopy now, and what Canopy
took. Service calls only (X-FLORA-Service-Secret).

Which cases a pass looks at (`plan`), most urgent first, at most `limit`:
1. active cases (every pass: the live window moves);
2. cases never sent, and archived cases not sent since they were archived (once: an archived case no longer changes);
3. other open (discharged) cases in turn, the longest unchecked first, `idle` per pass: every open case is checked again
   however long ago it was discharged, so documentation finished days later still reaches Canopy.
The worker sends a case only when its snapshot differs from the digest Canopy last took, then reports back (`results`).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection
from psycopg.types.json import Jsonb

from ..database import connection
from .auth_leaf import now_ms, service_only

router = APIRouter(prefix="/api/leaf-sync", tags=["leaf sync"])

CASE_COLUMNS = "c.id, c.case_code, c.hn, c.status, c.start_time, c.discharge_time, c.created_at, c.admission_source, c.identity_status"


def _row(row: dict[str, Any]) -> dict[str, Any]:
    """The case as /api/case/list gives it (the snapshot's `case`), with what Canopy last took."""
    return {"case_id": row["id"], "case_code": row["case_code"], "hn": row["hn"], "status": row["status"].upper(),
            "start_time": row["start_time"], "discharge_time": row["discharge_time"], "created_at": row["created_at"],
            "admission_source": row["admission_source"], "identity_status": row["identity_status"],
            "sent_digest": row.get("snapshot_digest"), "export_digest": row.get("export_digest")}


def plan(database: Connection, limit: int, idle: int) -> list[dict[str, Any]]:
    rows = database.execute(
        f"""SELECT {CASE_COLUMNS}, s.snapshot_digest, s.export_digest, s.checked_at, s.snapshot_sent_at,
                   CASE WHEN c.status = 'active' THEN 0
                        WHEN s.snapshot_sent_at IS NULL THEN 1
                        WHEN c.status = 'archived' AND coalesce(c.archive_time, 0) > s.snapshot_sent_at THEN 1
                        WHEN c.status = 'archived' THEN 3
                        ELSE 2 END AS rank
            FROM cases c LEFT JOIN leaf_sync_case s ON s.case_id = c.id
            ORDER BY rank, coalesce(s.checked_at, 0), c.id DESC""").fetchall()
    out, idle_taken = [], 0
    for row in rows:
        if len(out) >= limit or row["rank"] == 3:
            break
        if row["rank"] == 2:
            if idle_taken >= idle:
                continue
            idle_taken += 1
        out.append(_row(row))
    return out


@router.get("/cases")
def sync_plan(limit: int = Query(default=100, ge=1, le=400), idle: int = Query(default=10, ge=0, le=200),
              _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict[str, Any]:
    """The cases this pass should look at, and the worker's settings."""
    return {"cases": plan(database, limit, idle), "state": state(database)}


@router.put("/cases")
def sync_results(payload: dict[str, Any] = Body(...), _: dict = Depends(service_only),
                 database: Connection = Depends(connection)) -> dict[str, Any]:
    """[{case_id, checked?, sent_digest?, export_digest?, error?}]: what happened to each case of the pass."""
    current = now_ms()
    stored = 0
    with database.transaction():
        for item in payload.get("results") or []:
            if not isinstance(item, dict) or not isinstance(item.get("case_id"), int):
                continue
            error = str(item["error"])[:500] if item.get("error") else None
            database.execute(
                """INSERT INTO leaf_sync_case (case_id, snapshot_digest, snapshot_sent_at, export_digest, checked_at, last_error, last_error_at)
                   SELECT %(id)s, %(digest)s, CASE WHEN %(digest)s::text IS NULL THEN NULL ELSE %(now)s END, %(export)s, %(now)s,
                          %(error)s, CASE WHEN %(error)s::text IS NULL THEN NULL ELSE %(now)s END
                   WHERE EXISTS (SELECT 1 FROM cases WHERE id = %(id)s)
                   ON CONFLICT (case_id) DO UPDATE SET
                     snapshot_digest = coalesce(excluded.snapshot_digest, leaf_sync_case.snapshot_digest),
                     snapshot_sent_at = coalesce(excluded.snapshot_sent_at, leaf_sync_case.snapshot_sent_at),
                     export_digest = coalesce(excluded.export_digest, leaf_sync_case.export_digest),
                     checked_at = excluded.checked_at,
                     last_error = excluded.last_error,
                     last_error_at = CASE WHEN excluded.last_error IS NULL THEN NULL ELSE excluded.last_error_at END""",
                {"id": item["case_id"], "digest": item.get("sent_digest"), "export": item.get("export_digest"),
                 "now": current, "error": error})
            stored += 1
    return {"ok": True, "stored": stored}


def state(database: Connection) -> dict[str, Any]:
    return {row["key"]: row["value"] for row in database.execute("SELECT key, value FROM leaf_sync_state").fetchall()}


def set_state(database: Connection, key: str, value: Any) -> None:
    database.execute(
        """INSERT INTO leaf_sync_state (key, value, updated_at) VALUES (%s, %s, %s)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
        (key, Jsonb(value), now_ms()))


@router.put("/state/{key}")
def put_state(key: str, value: Any = Body(...), _: dict = Depends(service_only),
              database: Connection = Depends(connection)) -> dict[str, Any]:
    if not key.replace("_", "").replace(".", "").replace("-", "").isalnum() or not 2 <= len(key) <= 64 or not key[0].isalpha():
        raise HTTPException(400, "invalid key")
    set_state(database, key, value)
    return {"ok": True}
