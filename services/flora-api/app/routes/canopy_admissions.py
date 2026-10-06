"""Admit cases in Canopy and fill their forms (e.g. pre-op) from a ward tablet.

An admission targets a ward, or one bed's Leaf. Leafs list it under "Prepared
patients"; the nurse starts it at the bedside. Its form keeps syncing both ways
through Canopy (field-level, newest wins) until the case is archived.
"""
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import directory, form_sync, hl7_interface
from ..database import connection
from .canopy_preferences import require_canopy_permission
from .canopy_users import ward_scope

router = APIRouter(prefix="/api/fleet/admissions", tags=["canopy admissions"])


class PatientInput(BaseModel):
    patient_name: str = Field(min_length=1, max_length=240)
    sex: str | None = Field(default=None, max_length=32)
    dob: str | None = Field(default=None, max_length=32)
    age_text: str | None = Field(default=None, max_length=80)
    weight_kg: float | None = Field(default=None, gt=0, le=500)
    height_cm: float | None = Field(default=None, gt=0, le=300)


class DetailsInput(BaseModel):
    diagnosis: str | None = Field(default=None, max_length=1000)
    operation: str | None = Field(default=None, max_length=1000)
    anaesthesia_technique: str | None = Field(default=None, max_length=80)
    asa_status: str | None = Field(default=None, max_length=16)
    asa_emergency: bool = False
    surgical_priority: str | None = Field(default=None, max_length=80)
    surgeon: str | None = Field(default=None, max_length=200)


class AdmissionInput(BaseModel):
    unit_key: str = Field(min_length=1, max_length=40)
    target_leaf_id: str | None = Field(default=None, max_length=120)
    hn: str = Field(min_length=1, max_length=128)
    admission_number: str | None = Field(default=None, max_length=80)
    patient: PatientInput
    admission: DetailsInput = Field(default_factory=DetailsInput)
    scheduled_at: int | None = Field(default=None, gt=0)
    note: str | None = Field(default=None, max_length=2000)


class FormPatch(BaseModel):
    patch: dict[str, Any]


def _allowed(scope: list[str] | None, unit_key: str) -> None:
    if scope is not None and unit_key not in scope:
        raise HTTPException(status_code=403, detail="you are not assigned to this ward")


def _target_check(database: Connection, unit_key: str, leaf_id: str | None) -> None:
    if not leaf_id:
        return
    row = database.execute("SELECT unit_key FROM canopy_leaf_unit WHERE leaf_id=%s", (leaf_id,)).fetchone()
    if row is None or row["unit_key"] != unit_key:
        raise HTTPException(status_code=400, detail="the selected bed's Leaf is not in this ward")


def _public(row: dict[str, Any]) -> dict[str, Any]:
    values = row.get("form_values") or {}
    return {
        "id": str(row["id"]), "unitKey": row["unit_key"], "unitName": row.get("unit_name"),
        "targetLeafId": row["target_leaf_id"], "targetLeafName": row.get("target_leaf_name"),
        "hn": row["hn"], "admissionNumber": row["admission_number"], "patient": row["patient"] or {},
        "admission": row["admission"] or {}, "scheduledAt": row["scheduled_at"], "note": row["note"],
        "status": row["status"], "claimedLeafId": row["claimed_leaf_id"], "claimedLeafName": row.get("claimed_leaf_name"),
        "claimedAt": row["claimed_at"], "caseStatus": row["case_status"],
        "globalCaseId": str(row["global_case_id"]) if row.get("global_case_id") else None,
        "formUpdatedAt": row["form_updated_at"],
        "formFieldCount": len([value for value in values.values() if value not in (None, "", [], {})]),
        "createdBy": row["created_by"], "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        "source": row.get("source") or "canopy", "accessionNumber": row.get("accession_number"),
        "appointmentId": row.get("appointment_id"),
        "formEditable": row["status"] in {"pending", "started", "conflict"} and row.get("case_status") != "archived",
    }


SELECT = """SELECT a.*, unit.name AS unit_name,
                   coalesce(nullif(target.canopy_display_name,''),target.display_name) AS target_leaf_name,
                   coalesce(nullif(claimed.canopy_display_name,''),claimed.display_name) AS claimed_leaf_name
            FROM canopy_admission a
            LEFT JOIN canopy_location unit ON unit.id::text=a.unit_key
            LEFT JOIN sync_leaf_node target ON target.leaf_id=a.target_leaf_id
            LEFT JOIN sync_leaf_node claimed ON claimed.leaf_id=a.claimed_leaf_id"""


def _load(database: Connection, admission_id: str, scope: list[str] | None, lock: bool = False) -> dict[str, Any]:
    try:
        uuid.UUID(admission_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="admission not found") from None
    row = database.execute(f"{SELECT} WHERE a.id=%s", (admission_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="admission not found")
    _allowed(scope, row["unit_key"])
    if lock:
        database.execute("SELECT 1 FROM canopy_admission WHERE id=%s FOR UPDATE", (admission_id,))
    return row


@router.get("/options")
def options(scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Wards the user may admit to, with each ward's beds (Leafs)."""
    wards = [ward for ward in directory.ward_options(database)["rows"] if scope is None or ward["key"] in scope]
    leaves = database.execute(
        """SELECT lu.unit_key, leaf.leaf_id, coalesce(nullif(leaf.canopy_display_name,''),leaf.display_name) AS name,
                  assignment.desired_config#>>'{location,bedName}' AS bed_name
           FROM canopy_leaf_unit lu JOIN sync_leaf_node leaf ON leaf.leaf_id=lu.leaf_id
           LEFT JOIN canopy_leaf_assignment assignment ON assignment.leaf_id=leaf.leaf_id
           ORDER BY name"""
    ).fetchall()
    return {"wards": [{**ward, "leaves": [{"leafId": leaf["leaf_id"], "name": leaf["name"], "bedName": leaf["bed_name"]}
                                          for leaf in leaves if leaf["unit_key"] == ward["key"]]} for ward in wards]}


@router.get("/hl7-lookup")
def hl7_lookup(mrn: str = Query(min_length=1, max_length=64), _: dict = Depends(require_canopy_permission("case.create")),
               database: Connection = Depends(connection)) -> dict[str, Any]:
    """Fetch demographics for the admit form from the HL7 gateway (GET /api/patients/:mrn)."""
    config = hl7_interface.settings(database)
    if not config["gateway_url"]:
        raise HTTPException(status_code=409, detail="the HL7 gateway is not configured")
    try:
        patient = hl7_interface.lookup_patient(config, mrn)
    except PermissionError as error:
        raise HTTPException(status_code=502, detail=str(error)) from None
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"HL7 gateway unavailable ({type(error).__name__})") from None
    return {"found": patient is not None, "patient": patient}


@router.get("")
def list_admissions(
    status: str | None = Query(default=None, pattern="^(pending|started|cancelled|conflict|open)$"),
    scope: list[str] | None = Depends(ward_scope),
    database: Connection = Depends(connection),
) -> dict[str, Any]:
    rows = database.execute(
        f"""{SELECT}
            WHERE (%s::text[] IS NULL OR a.unit_key = ANY(%s))
              AND (%s::text IS NULL
                   OR (%s='open' AND (a.status IN ('pending','conflict')
                       OR (a.status='started' AND coalesce(a.case_status,'active') NOT IN ('archived'))))
                   OR a.status=%s)
            ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'conflict' THEN 1 WHEN 'started' THEN 2 ELSE 3 END,
                     a.scheduled_at NULLS LAST, a.created_at DESC
            LIMIT 300""",
        (scope, scope, status, status, status),
    ).fetchall()
    return {"rows": [_public(row) for row in rows]}


@router.post("")
def create_admission(payload: AdmissionInput, user: dict = Depends(require_canopy_permission("case.create")),
                     scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    _allowed(scope, payload.unit_key)
    if not any(ward["key"] == payload.unit_key for ward in directory.ward_options(database)["rows"]):
        raise HTTPException(status_code=400, detail="unknown ward")
    _target_check(database, payload.unit_key, payload.target_leaf_id)
    current = directory.now_ms()
    admission_id = uuid.uuid4()
    with database.transaction():
        database.execute(
            """INSERT INTO canopy_admission(id,unit_key,target_leaf_id,hn,admission_number,patient,admission,scheduled_at,
                     note,created_by,created_at,updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (admission_id, payload.unit_key, payload.target_leaf_id or None, payload.hn.strip(),
             (payload.admission_number or "").strip() or None, Jsonb(payload.patient.model_dump()),
             Jsonb(payload.admission.model_dump()), payload.scheduled_at, payload.note, user["username"], current, current),
        )
    return {"row": _public(_load(database, str(admission_id), scope))}


@router.put("/{admission_id}")
def update_admission(admission_id: str, payload: AdmissionInput,
                     _: dict = Depends(require_canopy_permission("case.create")),
                     scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    _allowed(scope, payload.unit_key)
    with database.transaction():
        row = _load(database, admission_id, scope, lock=True)
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail="the case has already started; edit it at the Leaf")
        _target_check(database, payload.unit_key, payload.target_leaf_id)
        database.execute(
            """UPDATE canopy_admission SET unit_key=%s,target_leaf_id=%s,hn=%s,admission_number=%s,patient=%s,
                 admission=%s,scheduled_at=%s,note=%s,updated_at=%s WHERE id=%s""",
            (payload.unit_key, payload.target_leaf_id or None, payload.hn.strip(),
             (payload.admission_number or "").strip() or None, Jsonb(payload.patient.model_dump()),
             Jsonb(payload.admission.model_dump()), payload.scheduled_at, payload.note, directory.now_ms(), admission_id),
        )
    return {"row": _public(_load(database, admission_id, scope))}


@router.post("/{admission_id}/cancel")
def cancel_admission(admission_id: str, _: dict = Depends(require_canopy_permission("case.create")),
                     scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        row = _load(database, admission_id, scope, lock=True)
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail="only an admission that has not started can be cancelled")
        database.execute("UPDATE canopy_admission SET status='cancelled',updated_at=%s WHERE id=%s",
                         (directory.now_ms(), admission_id))
    return {"row": _public(_load(database, admission_id, scope))}


@router.get("/{admission_id}/form")
def get_form(admission_id: str, _: dict = Depends(require_canopy_permission("case.read")),
             scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    row = _load(database, admission_id, scope)
    return {"ok": True, "admission": _public(row), "draft": row["form_values"] or {},
            "versions": row["form_versions"] or {}, "updated_at": row["form_updated_at"]}


@router.patch("/{admission_id}/form")
def patch_form(admission_id: str, payload: FormPatch, user: dict = Depends(require_canopy_permission("case.chart")),
               scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Save changed fields only; each one is stamped so the Leaf merges it field by field."""
    with database.transaction():
        row = _load(database, admission_id, scope, lock=True)
        if not _public(row)["formEditable"]:
            raise HTTPException(status_code=409, detail="this case is archived or cancelled; the form is read-only")
        old = row["form_values"] or {}
        merged = {**old, **payload.patch}
        current = directory.now_ms()
        versions = form_sync.stamp_changes(old, merged, row["form_versions"] or {}, current, set(payload.patch))
        database.execute(
            """UPDATE canopy_admission SET form_values=%s,form_versions=%s,form_updated_at=%s,updated_at=%s
               WHERE id=%s""",
            (Jsonb(merged), Jsonb(versions), current, current, admission_id),
        )
    return {"ok": True, "draft": merged, "updated_at": current, "updated_by": user["username"]}
