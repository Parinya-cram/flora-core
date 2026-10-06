"""Canopy public API v1: read cases synchronized from every Leaf, and admissions.

Authenticate with an API key (Authorization: Bearer flk_…, or X-API-Key). Each key
has scopes and may be limited to some wards; demo wards are excluded unless the key
allows them or the request names the ward. Every request is written to the access
log together with the case ids it returned. The MCP server is a client of this API.
"""
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import api_keys, directory
from ..database import connection
from .canopy_admissions import AdmissionInput, _public as admission_public, _target_check
from .fleet_read import _chart_summary, _compact_vitals, _number, _patient_name, _record, _rows

router = APIRouter(prefix="/api/v1", tags=["public api v1"])

SCOPE_SQL = """(%(wards)s::text[] IS NULL OR scope_unit.unit_key = ANY(%(wards)s))
               AND (%(demo)s OR scope_unit.is_demo IS NOT TRUE)"""
VITAL_KEYS = {
    "hr": ("hr", "pr"), "spo2": ("spo2",), "rr": ("rr", "set_rr"), "sbp": ("art_sys", "nibp_sys"),
    "dbp": ("art_dia", "nibp_dia"), "map": ("art_map", "nibp_map"), "temperature": ("temperature", "temp"),
    "etco2": ("etco2", "et_co2"),
}


def api_key(request: Request, database: Connection = Depends(connection)) -> dict[str, Any]:
    return api_keys.authenticate(request, database)


def _time(value: str | None, name: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{name} must be ISO 8601") from None


def _epoch_ms(value: datetime | None) -> int | None:
    return int(value.timestamp() * 1000) if value else None


def _summary(row: dict[str, Any]) -> dict[str, Any]:
    snapshot = _record(row.get("snapshot"))
    patient = _record(_record(snapshot.get("patient")).get("row"))
    procedures = _rows(snapshot.get("procedures"))
    diagnoses = _rows(snapshot.get("diagnosis"))
    return {
        "case_id": str(row["global_case_id"]), "case_code": row["case_code"], "hn": row["hn"],
        "status": str(row["status"]).lower(), "start_time": row["start_time"], "discharge_time": row["discharge_time"],
        "leaf_id": row["leaf_id"], "leaf_name": row["leaf_name"], "ward_key": row["unit_key"], "ward": row["unit_name"],
        "demo": bool(row.get("is_demo")),
        "patient_name": _patient_name(patient, row["hn"]), "sex": patient.get("sex") or patient.get("gender"),
        "age": patient.get("age_text"),
        "procedure": (procedures[0].get("procedure_text") or procedures[0].get("icd_text")) if procedures else None,
        "diagnosis": (diagnoses[0].get("diagnosis_text") or diagnoses[0].get("icd_text")) if diagnoses else None,
        "last_synced_at": row["last_synced_at"],
    }


def _case_query(where: str) -> str:
    return f"""SELECT c.*, coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name,
                      scope_unit.unit_key, scope_unit.unit_name, scope_unit.is_demo
               FROM sync_case_index c
               JOIN sync_leaf_node l ON l.leaf_id=c.leaf_id
               LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id=c.leaf_id
               WHERE {SCOPE_SQL} AND {where}"""


def _load_case(database: Connection, key: dict[str, Any], case_id: str, request: Request, scope: str) -> dict[str, Any]:
    api_keys.require_scope(key, scope)
    try:
        uuid.UUID(case_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="case not found") from None
    wards = list(key["unit_keys"]) if key.get("unit_keys") is not None else None
    # A case id is explicit, so demo cases are readable when the key may see that ward.
    row = database.execute(_case_query("c.global_case_id=%(id)s"),
                           {"wards": wards, "demo": True if wards is not None else bool(key["include_demo"]),
                            "id": case_id}).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="case not found")
    request.state.case_ids = [case_id]
    return row


@router.get("/me")
def me(key: dict = Depends(api_key)) -> dict[str, Any]:
    return {"key": api_keys.public(key), "scopes_available": api_keys.SCOPES}


@router.get("/wards")
def wards(key: dict = Depends(api_key), database: Connection = Depends(connection)) -> dict[str, Any]:
    allowed = set(key["unit_keys"]) if key.get("unit_keys") is not None else None
    rows = [ward for ward in directory.ward_options(database)["rows"]
            if (allowed is None or ward["key"] in allowed) and (key["include_demo"] or not ward.get("isDemo") or allowed)]
    return {"rows": [{"key": w["key"], "name": w["name"], "building": w.get("buildingName"),
                      "leaf_count": w.get("leafCount"), "demo": bool(w.get("isDemo"))} for w in rows]}


@router.get("/cases")
def cases(
    request: Request,
    ward: str | None = Query(default=None, max_length=40),
    status: str | None = Query(default=None, pattern="^[a-z_]{1,24}$", description="active, discharged, archived, handed_over…"),
    hn: str | None = Query(default=None, max_length=128),
    since: str | None = Query(default=None, description="ISO 8601; cases started at or after"),
    until: str | None = Query(default=None, description="ISO 8601; cases started before"),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    key: dict = Depends(api_key),
    database: Connection = Depends(connection),
) -> dict[str, Any]:
    api_keys.require_scope(key, "cases:read")
    wards_filter, demo = api_keys.ward_filter(key, ward)
    params = {"wards": wards_filter, "demo": demo, "status": (status or "").upper(), "hn": hn,
              "since": _epoch_ms(_time(since, "since")), "until": _epoch_ms(_time(until, "until")),
              "limit": limit, "offset": offset}
    where = """(%(status)s = '' OR upper(c.status) = %(status)s) AND (%(hn)s::text IS NULL OR c.hn = %(hn)s)
               AND (%(since)s::bigint IS NULL OR c.start_time >= %(since)s)
               AND (%(until)s::bigint IS NULL OR c.start_time < %(until)s)"""
    total = database.execute(f"SELECT count(*) AS n FROM ({_case_query(where)}) q", params).fetchone()["n"]
    rows = database.execute(_case_query(where) + " ORDER BY c.start_time DESC NULLS LAST LIMIT %(limit)s OFFSET %(offset)s",
                            params).fetchall()
    request.state.case_ids = [str(row["global_case_id"]) for row in rows]
    return {"total": total, "limit": limit, "offset": offset, "rows": [_summary(row) for row in rows]}


@router.get("/cases/{case_id}")
def case(case_id: str, request: Request, key: dict = Depends(api_key), database: Connection = Depends(connection)) -> dict[str, Any]:
    row = _load_case(database, key, case_id, request, "cases:read")
    snapshot = _record(row.get("snapshot"))
    patient = _record(_record(snapshot.get("patient")).get("row"))
    latest, _ = _compact_vitals(snapshot, 1)
    chart = _chart_summary(snapshot, patient)
    return {**_summary(row), "latest_vitals": latest, "chart": chart,
            "procedures": _rows(snapshot.get("procedures")), "diagnoses": _rows(snapshot.get("diagnosis")),
            "allergies": _rows(snapshot.get("allergies")), "staff": _rows(snapshot.get("staff"))}


@router.get("/cases/{case_id}/vitals")
def vitals(
    case_id: str, request: Request,
    parameters: str | None = Query(default=None, description=f"comma list of {', '.join(VITAL_KEYS)}"),
    interval: int = Query(default=1, ge=1, le=60, description="minutes between points"),
    since: str | None = None, until: str | None = None,
    key: dict = Depends(api_key), database: Connection = Depends(connection),
) -> dict[str, Any]:
    row = _load_case(database, key, case_id, request, "vitals:read")
    wanted = [p.strip() for p in (parameters or ",".join(VITAL_KEYS)).split(",") if p.strip()]
    unknown = [p for p in wanted if p not in VITAL_KEYS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown parameter(s): {', '.join(unknown)}")
    start, end = _epoch_ms(_time(since, "since")), _epoch_ms(_time(until, "until"))
    snapshot = _record(row.get("snapshot"))
    points, last_bucket = [], None
    for item in _rows(snapshot.get("vitals")) or _rows(snapshot.get("timeline")):
        ts = item.get("ts_minute")
        if not isinstance(ts, (int, float)) or (start and ts < start) or (end and ts >= end):
            continue
        bucket = int(ts // (interval * 60000))
        if bucket == last_bucket:
            continue
        last_bucket = bucket
        payload = _record(item.get("payload"))
        point = {"ts": int(ts)}
        for name in wanted:
            point[name] = next((_number(payload.get(k)) for k in VITAL_KEYS[name] if _number(payload.get(k)) is not None), None)
        points.append(point)
    window = _record(snapshot.get("window"))
    return {"case_id": case_id, "interval_minutes": interval, "parameters": wanted,
            "window": {"from": window.get("from"), "to": window.get("to")},
            "note": "Canopy keeps the latest 24 hours of each case; older minutes stay on the Leaf.",
            "points": points}


@router.get("/cases/{case_id}/events")
def events(case_id: str, request: Request, key: dict = Depends(api_key), database: Connection = Depends(connection)) -> dict[str, Any]:
    row = _load_case(database, key, case_id, request, "cases:read")
    return {"case_id": case_id, "rows": _rows(_record(row.get("snapshot")).get("events"))}


@router.get("/cases/{case_id}/medications")
def medications(case_id: str, request: Request, key: dict = Depends(api_key), database: Connection = Depends(connection)) -> dict[str, Any]:
    row = _load_case(database, key, case_id, request, "cases:read")
    snapshot = _record(row.get("snapshot"))
    return {"case_id": case_id, "runs": _rows(snapshot.get("io_runs")), "events": _rows(snapshot.get("io_events")),
            "totals": _record(_record(snapshot.get("io_summary")).get("totals"))}


@router.get("/cases/{case_id}/forms")
def forms(case_id: str, request: Request, key: dict = Depends(api_key), database: Connection = Depends(connection)) -> dict[str, Any]:
    row = _load_case(database, key, case_id, request, "forms:read")
    form = _record(_record(row.get("snapshot")).get("forms"))
    return {"case_id": case_id, "updated_at": form.get("updated_at"), "fields": _record(form.get("draft"))}


class ApiAdmissionInput(AdmissionInput):
    external_ref: str | None = Field(default=None, max_length=200, description="your id; repeats update instead of duplicating")


@router.get("/admissions")
def admissions(
    request: Request,
    ward: str | None = Query(default=None, max_length=40),
    status: str | None = Query(default=None, pattern="^(pending|started|cancelled|conflict)$"),
    limit: int = Query(default=100, ge=1, le=500),
    key: dict = Depends(api_key), database: Connection = Depends(connection),
) -> dict[str, Any]:
    api_keys.require_scope(key, "admissions:read")
    wards_filter, demo = api_keys.ward_filter(key, ward)
    rows = database.execute(
        """SELECT a.*, unit.name AS unit_name, NULL AS target_leaf_name, NULL AS claimed_leaf_name
           FROM canopy_admission a LEFT JOIN canopy_location unit ON unit.id::text=a.unit_key
           WHERE (%(wards)s::text[] IS NULL OR a.unit_key = ANY(%(wards)s))
             AND (%(demo)s OR unit.is_demo IS NOT TRUE)
             AND (%(status)s::text IS NULL OR a.status=%(status)s)
           ORDER BY a.created_at DESC LIMIT %(limit)s""",
        {"wards": wards_filter, "demo": demo, "status": status, "limit": limit},
    ).fetchall()
    return {"rows": [admission_public(row) for row in rows]}


@router.post("/admissions")
def create_admission(payload: ApiAdmissionInput, key: dict = Depends(api_key),
                     database: Connection = Depends(connection)) -> dict[str, Any]:
    """Admit a patient from a HIS / scheduling system; Leafs of the ward list it under "Prepared patients"."""
    api_keys.require_scope(key, "admissions:write")
    allowed = key.get("unit_keys")
    if allowed is not None and payload.unit_key not in allowed:
        raise HTTPException(status_code=403, detail="this API key has no access to that ward")
    if not any(w["key"] == payload.unit_key for w in directory.ward_options(database)["rows"]):
        raise HTTPException(status_code=400, detail="unknown ward")
    _target_check(database, payload.unit_key, payload.target_leaf_id)
    current = api_keys.now_ms()
    with database.transaction():
        existing = database.execute(
            "SELECT id,status FROM canopy_admission WHERE source='api' AND external_ref=%s FOR UPDATE",
            (payload.external_ref,),
        ).fetchone() if payload.external_ref else None
        if existing and existing["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"admission already {existing['status']}")
        values = (payload.unit_key, payload.target_leaf_id or None, payload.hn.strip(),
                  (payload.admission_number or "").strip() or None, Jsonb(payload.patient.model_dump()),
                  Jsonb(payload.admission.model_dump()), payload.scheduled_at, payload.note)
        if existing:
            database.execute(
                """UPDATE canopy_admission SET unit_key=%s,target_leaf_id=%s,hn=%s,admission_number=%s,patient=%s,
                     admission=%s,scheduled_at=%s,note=%s,updated_at=%s WHERE id=%s""",
                (*values, current, existing["id"]))
            admission_id, created = existing["id"], False
        else:
            admission_id, created = uuid.uuid4(), True
            database.execute(
                """INSERT INTO canopy_admission(id,unit_key,target_leaf_id,hn,admission_number,patient,admission,
                         scheduled_at,note,created_by,created_at,updated_at,source,external_ref)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'api',%s)""",
                (admission_id, *values, f"api:{key['name']}", current, current, payload.external_ref))
    row = database.execute(
        """SELECT a.*, unit.name AS unit_name, NULL AS target_leaf_name, NULL AS claimed_leaf_name
           FROM canopy_admission a LEFT JOIN canopy_location unit ON unit.id::text=a.unit_key WHERE a.id=%s""",
        (admission_id,)).fetchone()
    return {"created": created, "row": admission_public(row)}
