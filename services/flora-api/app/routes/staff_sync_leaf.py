"""Leaf: staff directory sync with Canopy (see app/staff_sync.py). Status for the Staff screen, and the
sync worker's pending / apply calls."""
from typing import Any

from fastapi import APIRouter, Body, Depends
from psycopg import Connection

from .. import staff_sync
from ..database import connection
from .auth_leaf import require_permission, service_only

router = APIRouter(prefix="/api/case/staff/sync", tags=["staff sync"])


@router.get("")
def status(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Last staff sync (time, result), what is waiting to go up, and a pending Sync now request."""
    last = database.execute("SELECT * FROM leaf_sync_status WHERE component='staff'").fetchone()
    control = database.execute("SELECT requested_at FROM leaf_sync_control WHERE id=1").fetchone() or {}
    counts = database.execute(
        """SELECT count(*) FILTER (WHERE is_active=1 AND directory_managed=1) AS canopy,
                  count(*) FILTER (WHERE is_active=1 AND directory_managed=0 AND directory_pending=1) AS pending,
                  count(*) FILTER (WHERE is_active=1 AND directory_managed=0 AND sync_error IS NOT NULL) AS rejected,
                  count(*) FILTER (WHERE is_active=1 AND directory_managed=0 AND coalesce(staff_code,'')='') AS local_only
           FROM staff_directory""").fetchone()
    return {"last": last, "requested_at": control.get("requested_at"), "counts": counts}


@router.get("/pending")
def pending(_: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict[str, Any]:
    return {"staff": staff_sync.pending(database)}


@router.put("/apply")
def apply(payload: dict[str, Any] = Body(...), _: dict = Depends(service_only),
          database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        return staff_sync.apply_from_canopy(database, payload)
