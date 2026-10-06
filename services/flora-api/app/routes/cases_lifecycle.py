"""Leaf case lifecycle backed directly by PostgreSQL."""

import json
import math
import secrets
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from psycopg import Connection
from pydantic import BaseModel, Field

from psycopg.types.json import Jsonb

from ..account_config_sync import claim_canopy_admission
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .cases_read import floor_minute, rate_to_ml_per_hour

router = APIRouter(prefix="/api/case", tags=["case lifecycle"])


class StartTime(BaseModel):
    start_time: int = Field(gt=0)


class StartCase(StartTime):
    hn: str | None = Field(default=None, max_length=128)
    overlap_policy: Literal["include", "exclude"] | None = None
    admission_source: Literal["legacy", "prepared", "his", "manual", "emergency"] = "legacy"
    admission_number: str | None = Field(default=None, max_length=80)
    patient_name: str | None = Field(default=None, max_length=240)
    sex: str | None = Field(default=None, max_length=32)
    date_of_birth: str | None = Field(default=None, max_length=32)
    date_of_birth_precision: Literal["exact", "estimated"] | None = None
    age_text: str | None = Field(default=None, max_length=80)
    weight_kg: float | None = Field(default=None, gt=0, le=500)
    diagnosis: str | None = Field(default=None, max_length=1000)
    operation: str | None = Field(default=None, max_length=1000)
    anaesthesia_technique: str | None = Field(default=None, max_length=80)
    asa_status: str | None = Field(default=None, max_length=16)
    asa_emergency: bool = False
    surgical_priority: str | None = Field(default=None, max_length=80)
    # Start a case admitted in Canopy (listed under "Prepared patients").
    canopy_admission_id: str | None = Field(default=None, max_length=64)


class CaseId(BaseModel):
    case_id: int = Field(gt=0)


class Discharge(CaseId):
    discharge_time: int | None = Field(default=None, gt=0)


class EndTime(BaseModel):
    discharge_time: int = Field(gt=0)


def editable_case(database: Connection, case_id: int) -> dict:
    row = database.execute("SELECT * FROM cases WHERE id=%s FOR UPDATE", (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    if row["status"] == "archived":
        raise HTTPException(409, "archived case is read-only")
    return row


def start_overlap(database: Connection, start: int) -> dict | None:
    previous = database.execute(
        """SELECT id, hn, status, coalesce(discharge_time, start_time) AS ended
           FROM cases WHERE status IN ('discharged','archived')
           AND coalesce(discharge_time, start_time)>%s
           ORDER BY coalesce(discharge_time, start_time) DESC, id DESC LIMIT 1""",
        (start,),
    ).fetchone()
    if previous is None:
        return None
    stats = database.execute(
        """SELECT min(ts_minute) AS first, max(ts_minute) AS last, count(*) AS total
           FROM vital_minutes WHERE case_id=%s AND ts_minute BETWEEN %s AND %s""",
        (previous["id"], floor_minute(start), floor_minute(previous["ended"])),
    ).fetchone()
    if not stats["total"]:
        return None
    return {
        "previous_case_id": previous["id"], "previous_case_hn": previous["hn"],
        "previous_case_status": previous["status"].upper(),
        "previous_case_end_time": previous["ended"],
        "overlap_start_time": max(start, stats["first"]),
        "overlap_end_time": previous["ended"], "overlap_minute_count": stats["total"],
        "suggested_capture_start_time": max(((previous["ended"]+59999)//60000)*60000, stats["last"]+60000),
    }


def audit_run(database: Connection, case_id: int, before: dict | None, after: dict, actor: dict, reason: str) -> None:
    database.execute(
        """INSERT INTO case_io_audit
           (case_id, entity_type, entity_id, action, before_json, after_json, reason,
            actor_username, actor_name, actor_role, created_at)
           VALUES (%s,'run',%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (case_id, after["id"], "update" if before else "insert",
         json.dumps(before) if before else None, json.dumps(after), reason,
         actor["username"], actor.get("name"), actor.get("role"), now_ms()),
    )


@router.post("/start-overlap-check")
def overlap_check(payload: StartTime, _: dict = Depends(require_permission("case.create")), database: Connection = Depends(connection)):
    start = payload.start_time // 900000 * 900000
    return {"ok": True, "start_time": start, "overlap": start_overlap(database, start)}


@router.post("/start")
def start_case(payload: StartCase, actor: dict = Depends(require_permission("case.create")), database: Connection = Depends(connection)):
    admission = None
    if payload.canopy_admission_id:
        admission = database.execute(
            "SELECT * FROM canopy_admission_inbox WHERE id::text=%s", (payload.canopy_admission_id,)
        ).fetchone()
        if admission is None or admission["status"] != "pending":
            raise HTTPException(409, "this admission is no longer available")
        # Reserve it in Canopy so another Leaf of the ward cannot start it too; offline starts are reported later.
        claim = claim_canopy_admission(payload.canopy_admission_id)
        if claim == "taken":
            database.execute("UPDATE canopy_admission_inbox SET status='withdrawn',updated_at=%s WHERE id=%s",
                             (now_ms(), admission["id"]))
            raise HTTPException(409, "this admission was already started at another Leaf")
        header = admission["header"] or {}
        patient = header.get("patient") or {}
        details = header.get("admission") or {}
        payload = payload.model_copy(update={
            "admission_source": "prepared",
            "hn": payload.hn or header.get("hn"),
            "admission_number": payload.admission_number or header.get("admission_number"),
            "patient_name": payload.patient_name or patient.get("patient_name"),
            "sex": payload.sex or patient.get("sex"),
            "date_of_birth": payload.date_of_birth or patient.get("dob"),
            "age_text": payload.age_text or patient.get("age_text"),
            "weight_kg": payload.weight_kg or patient.get("weight_kg"),
            **{key: getattr(payload, key) or details.get(key) for key in
               ("diagnosis", "operation", "anaesthesia_technique", "asa_status", "surgical_priority")},
            "asa_emergency": payload.asa_emergency or bool(details.get("asa_emergency")),
        })
    start = payload.start_time // 900000 * 900000
    local_start = datetime.fromtimestamp(start/1000, ZoneInfo("Asia/Bangkok"))
    hn = (payload.hn or "").strip()
    patient_name = (payload.patient_name or "").strip()
    if payload.admission_source in {"legacy", "prepared", "his"} and not hn:
        raise HTTPException(400, "hn required")
    if payload.admission_source == "manual" and not (hn or patient_name):
        raise HTTPException(400, "manual admission requires an HN or patient name")
    suffix = secrets.token_hex(3).upper()
    if payload.admission_source == "emergency":
        hn = f"EMG-{local_start:%Y%m%d}-{suffix}"
        patient_name = patient_name or "Emergency patient"
    elif payload.admission_source == "manual" and not hn:
        hn = f"LOCAL-{local_start:%Y%m%d}-{suffix}"
    identity_status = "pending" if payload.admission_source == "emergency" else "local" if payload.admission_source == "manual" else "verified"
    with database.transaction():
        # Serializes start requests across workers, including an empty cases table.
        database.execute("SELECT pg_advisory_xact_lock(6893, 1)")
        active = database.execute("SELECT id,hn,start_time FROM cases WHERE status='active' LIMIT 1").fetchone()
        if active:
            return JSONResponse(status_code=409, content={
                "error": "an active case already exists", "active_case_id": active["id"],
                "active_case_hn": active["hn"], "active_case_start_time": active["start_time"],
            })
        overlap = start_overlap(database, start)
        if overlap and payload.overlap_policy is None:
            return JSONResponse(status_code=409, content={
                "error": "overlap choice required", "code": "OVERLAP_CHOICE_REQUIRED", "overlap": overlap,
            })
        capture = overlap["suggested_capture_start_time"] if overlap and payload.overlap_policy == "exclude" else start
        date = local_start.strftime("%Y%m%d")
        prefix = f"{hn}_{date}_"
        count = database.execute("SELECT count(*) AS n FROM cases WHERE hn=%s AND starts_with(case_code,%s)", (hn,prefix)).fetchone()["n"]
        sequence = count + 1
        while database.execute("SELECT 1 FROM cases WHERE case_code=%s", (f"{prefix}{sequence:02d}",)).fetchone():
            sequence += 1
        code = f"{prefix}{sequence:02d}"
        current = now_ms()
        admission_metadata = {
            "diagnosis": (payload.diagnosis or "").strip() or None,
            "operation": (payload.operation or "").strip() or None,
            "anaesthesia_technique": (payload.anaesthesia_technique or "").strip() or None,
            "asa_status": (payload.asa_status or "").strip() or None,
            "asa_emergency": payload.asa_emergency,
            "surgical_priority": (payload.surgical_priority or "").strip() or None,
            "allergies_status": "unknown" if payload.admission_source == "emergency" else None,
            "demographics_status": "unknown" if payload.admission_source == "emergency" else None,
            "date_of_birth_precision": payload.date_of_birth_precision,
        }
        case_id = database.execute(
            """INSERT INTO cases
               (case_code,hn,start_time,device_capture_start_time,status,created_at,updated_at,
                admission_source,identity_status,admission_number,patient_display_name,admitted_by,admission_metadata)
               VALUES (%s,%s,%s,%s,'active',%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (code,hn,start,capture,current,current,payload.admission_source,identity_status,
             (payload.admission_number or "").strip() or None,patient_name or None,actor["username"],json.dumps(admission_metadata)),
        ).fetchone()["id"]
        if admission is not None:
            header = admission["header"] or {}
            patient = header.get("patient") or {}
            database.execute("UPDATE cases SET canopy_admission_id=%s WHERE id=%s", (admission["id"], case_id))
            database.execute(
                """INSERT INTO case_his_patient
                   (case_id,hn,an,patient_name,sex,dob,age_text,weight_kg,source,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'CANOPY',%s,%s)""",
                (case_id, hn, (payload.admission_number or "").strip() or None, patient_name or None,
                 (payload.sex or "").strip() or "unknown", (payload.date_of_birth or "").strip() or None,
                 (payload.age_text or "").strip() or None, payload.weight_kg, current, current),
            )
            # Forms already filled in Canopy (e.g. pre-op on a tablet) carry over with their field versions.
            database.execute(
                """INSERT INTO case_detail(case_id,created_at,updated_at,form_draft_json,field_versions)
                   VALUES (%s,%s,%s,%s,%s)""",
                (case_id, current, current, json.dumps(admission["form_values"] or {}),
                 Jsonb(admission["form_versions"] or {})),
            )
            database.execute(
                """UPDATE canopy_admission_inbox SET status='claimed',case_id=%s,claim_acknowledged=false,updated_at=%s
                   WHERE id=%s""",
                (case_id, current, admission["id"]),
            )
        elif payload.admission_source in {"manual", "emergency"}:
            database.execute(
                """INSERT INTO case_his_patient
                   (case_id,hn,an,patient_name,sex,dob,age_text,weight_kg,source,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (case_id,hn,(payload.admission_number or "").strip() or None,patient_name or None,
                 (payload.sex or "").strip() or "unknown",(payload.date_of_birth or "").strip() or None,
                 (payload.age_text or "").strip() or None,payload.weight_kg,payload.admission_source.upper(),current,current),
            )
        items = database.execute("SELECT id FROM io_item_master WHERE kind='output' AND is_active=1 AND code IN ('urine','bloodLoss')").fetchall()
        for item in items:
            run = database.execute(
                """INSERT INTO case_io_run
                   (case_id,item_id,kind,started_at,entry_mode,include_in_balance,created_by,created_at,updated_at)
                   VALUES (%s,%s,'output',%s,'bolus',1,%s,%s,%s) RETURNING *""",
                (case_id,item["id"],start,actor["username"],current,current),
            ).fetchone()
            audit_run(database,case_id,None,run,actor,"default output rows")
    return {"ok":True,"case_id":case_id,"case_code":code,"hn":hn,"start_time":start,
            "admission_source":payload.admission_source,"identity_status":identity_status,
            "device_capture_start_time":capture,"overlap_policy":payload.overlap_policy if overlap else None}


def validate_end(database: Connection, case: dict, end: int) -> None:
    if end < case["start_time"]:
        raise HTTPException(400,"discharge_time must be >= start_time")


def stop_drips(database: Connection, case_id: int, end: int, actor: dict) -> list[dict]:
    runs = database.execute(
        """SELECT r.*,coalesce(m.name,m.code,'Unknown') AS item_name FROM case_io_run r
           JOIN io_item_master m ON m.id=r.item_id
           WHERE r.case_id=%s AND r.stopped_at IS NULL AND r.entry_mode='drip' FOR UPDATE OF r""", (case_id,),
    ).fetchall()
    stopped = []
    for run in runs:
        volume = 0.0
        segments = database.execute("SELECT * FROM case_io_segment WHERE run_id=%s ORDER BY ts_from",(run["id"],)).fetchall()
        for segment in segments:
            until = min(segment["ts_to"],end) if segment["ts_to"] is not None else end
            rate = segment["carrier_ml_per_hr"]
            if rate is None or rate <= 0:
                rate = rate_to_ml_per_hour(segment["rate_value"],segment["rate_unit"]) or 0
            volume += max(0,until-segment["ts_from"]) / 3600000 * rate
        after = database.execute("UPDATE case_io_run SET stopped_at=%s,updated_at=%s WHERE id=%s RETURNING *",
                                 (max(run["started_at"],end),now_ms(),run["id"])).fetchone()
        before = {k:v for k,v in run.items() if k != "item_name"}
        audit_run(database,case_id,before,after,actor,"case discharge")
        metadata = dict(part.split(":",1) for part in (run["note"] or "").split("|") if ":" in part)
        try:
            planned = float(metadata.get("totalVolumeMl", "0"))
        except ValueError:
            planned = 0
        stopped.append({"name":run["item_name"],"delivered_ml":round(volume,1),
                        "planned_volume_ml":planned if planned > 0 else None})
    return stopped


@router.post("/discharge")
def discharge(payload: Discharge, actor: dict = Depends(require_permission("case.discharge")), database: Connection = Depends(connection)):
    end = floor_minute(payload.discharge_time) if payload.discharge_time is not None else now_ms()
    with database.transaction():
        case = editable_case(database,payload.case_id)
        if case["status"] != "active":
            raise HTTPException(400,"case not active")
        validate_end(database,case,end)
        stopped = stop_drips(database,payload.case_id,end,actor)
        database.execute("UPDATE cases SET status='discharged',discharge_time=%s,updated_at=%s WHERE id=%s",(end,now_ms(),payload.case_id))
    return {"ok":True,"case_id":payload.case_id,"discharge_time":end,"stopped_drips":stopped}


@router.post("/archive")
def archive(payload: CaseId, _: dict = Depends(require_permission("case.discharge")), database: Connection = Depends(connection)):
    with database.transaction():
        case = database.execute("SELECT status,archive_time FROM cases WHERE id=%s FOR UPDATE",(payload.case_id,)).fetchone()
        if case is None:
            raise HTTPException(404,"case not found")
        if case["status"] == "archived":
            return {"ok":True,"case_id":payload.case_id,"archive_time":case["archive_time"]}
        if case["status"] != "discharged":
            raise HTTPException(400,"case must be discharged before archive")
        current = now_ms()
        database.execute("UPDATE cases SET status='archived',archive_time=%s,updated_at=%s WHERE id=%s",(current,current,payload.case_id))
    return {"ok":True,"case_id":payload.case_id,"archive_time":current}


@router.put("/{case_id}/start-time")
def update_start(case_id: int, payload: StartTime, _: dict = Depends(require_permission("case.create")), database: Connection = Depends(connection)):
    start = payload.start_time // 900000 * 900000
    with database.transaction():
        case = editable_case(database,case_id)
        if case["discharge_time"] is not None and start > case["discharge_time"]:
            raise HTTPException(400,"start_time must be <= discharge_time")
        capture = max(start,case["device_capture_start_time"] or start)
        database.execute("UPDATE cases SET start_time=%s,device_capture_start_time=%s,updated_at=%s WHERE id=%s",(start,capture,now_ms(),case_id))
    return {"ok":True,"case_id":case_id,"start_time":start,"device_capture_start_time":capture}


@router.put("/{case_id}/discharge-time")
def update_end(case_id: int, payload: EndTime, actor: dict = Depends(require_permission("case.discharge")), database: Connection = Depends(connection)):
    end = floor_minute(payload.discharge_time)
    with database.transaction():
        case = editable_case(database,case_id)
        if case["status"] != "discharged":
            raise HTTPException(400,"case must be discharged")
        validate_end(database,case,end)
        stopped = stop_drips(database,case_id,end,actor)
        database.execute("UPDATE cases SET discharge_time=%s,updated_at=%s WHERE id=%s",(end,now_ms(),case_id))
    return {"ok":True,"case_id":case_id,"discharge_time":end,"stopped_drips":stopped}


def _finite(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


@router.get("/{case_id}/suggested-end")
def suggested_end(case_id: int, _: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)):
    case = database.execute(
        "SELECT id,status,start_time,discharge_time FROM cases WHERE id=%s", (case_id,),
    ).fetchone()
    if not case:
        raise HTTPException(404, "not found")
    actual_end = case["discharge_time"] if case["status"] in {"discharged", "archived"} else now_ms()
    if not actual_end or actual_end <= case["start_time"]:
        return {"ok": True, "suggestion": None}
    max_vital = 0
    for row in database.execute(
        "SELECT ts_minute,payload FROM vital_minutes WHERE case_id=%s ORDER BY ts_minute DESC,id DESC", (case_id,),
    ).fetchall():
        try:
            payload = json.loads(row["payload"] or "{}")
            if isinstance(payload, dict) and any(_finite(value) for value in payload.values()):
                max_vital = row["ts_minute"]
                break
        except (TypeError, ValueError):
            continue
    max_io_event = database.execute(
        "SELECT coalesce(max(event_ts),0) AS value FROM case_io_event WHERE case_id=%s", (case_id,),
    ).fetchone()["value"]
    max_io_run = database.execute(
        """SELECT coalesce(max(value),0) AS value FROM (
             SELECT s.ts_from AS value FROM case_io_segment s JOIN case_io_run r ON r.id=s.run_id WHERE r.case_id=%s
             UNION ALL SELECT coalesce(s.ts_to,0) FROM case_io_segment s JOIN case_io_run r ON r.id=s.run_id WHERE r.case_id=%s
           ) activity""", (case_id, case_id),
    ).fetchone()["value"]
    milestone_aliases = {"time out", "timeout", "to", "start ane", "start anes", "start anesthesia",
        "start anaesthesia", "sa", "induction", "ssi", "ssi prophylaxis", "ssiprophylaxis", "start surg",
        "start surgery", "ss", "end surg", "end surgery", "es", "reversal", "rev", "end ane",
        "end anes", "end anesthesia", "end anaesthesia", "ea"}
    end_aliases = {"end ane", "end anes", "end anesthesia", "end anaesthesia", "ea"}
    max_milestone = end_ane = 0
    for event in database.execute(
        "SELECT title,event_ts FROM case_event_note WHERE case_id=%s AND is_deleted=0 AND event_type='event'", (case_id,),
    ).fetchall():
        title = " ".join(str(event["title"] or "").lower().split())
        if title in milestone_aliases:
            max_milestone = max(max_milestone, event["event_ts"] or 0)
        if title in end_aliases:
            end_ane = max(end_ane, event["event_ts"] or 0)
    activity = max(case["start_time"], max_vital, max_io_event, max_io_run, max_milestone)
    anchor = end_ane if end_ane and activity - end_ane > 30 * 60_000 else activity
    idle, span = max(0, actual_end - anchor), actual_end - case["start_time"]
    idle_threshold = (45 if end_ane else 60) * 60_000 if case["status"] == "active" else 4 * 60 * 60_000
    min_span = 2 * 60 * 60_000 if case["status"] == "active" else 8 * 60 * 60_000
    bucket = 15 * 60_000
    suggested = ((anchor + bucket + bucket - 1) // bucket) * bucket
    if span < min_span or idle < idle_threshold or suggested >= actual_end:
        return {"ok": True, "suggestion": None}
    based_on = "end_ane" if anchor == end_ane else "io" if anchor in {max_io_event, max_io_run} else "vitals" if anchor == max_vital else "milestone" if anchor == max_milestone else "activity"
    return {"ok": True, "suggestion": {"case_id": case_id, "suggested_end_time": suggested,
        "last_activity_time": anchor, "idle_tail_ms": idle, "has_end_ane": bool(end_ane), "based_on": based_on}}
