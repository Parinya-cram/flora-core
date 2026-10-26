"""Leaf active cases (several beds per Leaf) and the gateway devices each case records from."""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from psycopg import Connection
from pydantic import BaseModel

from .. import case_bindings
from ..database import connection
from .auth_leaf import require_permission
from .cases_lifecycle import DeviceRequest

router = APIRouter(prefix="/api/case", tags=["case devices"])


class DeviceList(BaseModel):
    devices: list[DeviceRequest]


@router.get("/active")
def active_cases(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        """SELECT c.id, c.hn, c.bed_label, c.status, c.start_time, c.admission_number, c.case_code,
                  coalesce(c.patient_display_name, p.patient_name) AS patient_name
           FROM cases c
           LEFT JOIN LATERAL (SELECT patient_name FROM case_his_patient WHERE case_id=c.id ORDER BY id DESC LIMIT 1) p ON true
           WHERE c.status='active' ORDER BY c.start_time DESC, c.id DESC"""
    ).fetchall()
    devices = case_bindings.bindings(database, [row["id"] for row in rows])
    return {"cases": [{
        "case_id": row["id"], "case_uuid": case_bindings.case_uuid(row["id"]), "case_code": row["case_code"],
        "hn": row["hn"], "admission_number": row["admission_number"], "patient_name": row["patient_name"],
        "bed_label": row["bed_label"], "status": row["status"].upper(), "start_time": row["start_time"],
        "devices": devices[row["id"]],
    } for row in rows]}


@router.get("/{case_id}/devices")
def case_devices(case_id: int, include_released: bool = False, _: dict = Depends(require_permission("case.read")),
                 database: Connection = Depends(connection)) -> dict:
    if not database.execute("SELECT 1 FROM cases WHERE id=%s", (case_id,)).fetchone():
        raise HTTPException(404, "case not found")
    return {"devices": case_bindings.bindings(database, [case_id], include_released)[case_id]}


@router.put("/{case_id}/devices")
def replace_devices(case_id: int, payload: DeviceList, _: dict = Depends(require_permission("case.create")),
                    database: Connection = Depends(connection)):
    with database.transaction():
        database.execute("SELECT pg_advisory_xact_lock(6893, 1)")
        case = database.execute("SELECT status FROM cases WHERE id=%s FOR UPDATE", (case_id,)).fetchone()
        if case is None:
            raise HTTPException(404, "case not found")
        if case["status"] != "active":
            raise HTTPException(409, "only an active case records from devices")
        try:
            case_bindings.replace(database, case_id,
                                  case_bindings.normalize(database, [d.model_dump() for d in payload.devices]))
        except ValueError as error:
            raise HTTPException(400, str(error)) from None
        except case_bindings.DeviceInUse as clash:
            return JSONResponse(status_code=409, content=clash.body())
    return {"devices": case_bindings.bindings(database, [case_id])[case_id]}
