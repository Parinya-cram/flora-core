import json
import math
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import Connection

from ..database import connection
from .auth_leaf import require_permission


router = APIRouter(prefix="/api/case", tags=["cases"], dependencies=[Depends(require_permission("case.read"))])
MINUTE_MS = 60_000
ADVANCE_MIN = 5


def now_ms() -> int:
    return int(time.time() * 1000)


def floor_minute(value: int | float) -> int:
    return math.floor(value / MINUTE_MS) * MINUTE_MS


def number_or_none(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        value = float(raw.strip() or "0")
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def case_id_or_400(raw: str) -> int:
    value = number_or_none(raw)
    if value is None:
        raise HTTPException(status_code=400, detail="invalid case id")
    return int(value)


def get_case_range_row(database: Connection, case_id: int) -> dict[str, Any]:
    row = database.execute(
        """
        SELECT start_time, discharge_time, status
        FROM cases
        WHERE id = %s
        """,
        (case_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    return row


def resolve_case_range(row: dict[str, Any], request: Request) -> tuple[int, int]:
    default_from = floor_minute(row["start_time"])
    default_to = (
        floor_minute(now_ms() + ADVANCE_MIN * MINUTE_MS)
        if row["status"] == "active"
        else floor_minute(row["discharge_time"] or now_ms())
    )
    query_from = number_or_none(request.query_params.get("from"))
    query_to = number_or_none(request.query_params.get("to"))
    from_ts = floor_minute(query_from) if query_from is not None else default_from
    to_ts = floor_minute(query_to) if query_to is not None else default_to
    if to_ts < from_ts:
        raise HTTPException(status_code=400, detail="invalid range")
    return from_ts, to_ts


def parse_payload(raw: str | None) -> Any:
    try:
        return json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}


def io_kind(raw: str | None) -> str | None:
    value = (raw or "").strip().lower()
    return value if value in {"fluid", "med", "output"} else None


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def rate_to_ml_per_hour(value: Any, unit: Any) -> float | None:
    number = finite_number(value)
    if number is None:
        return None
    normalized = str(unit or "").strip().lower().replace(" ", "")
    if normalized in {"ml/hr", "ml/h", "mlhr", "mlperhour"}:
        return number
    if normalized in {"l/hr", "l/h", "lhr", "lperhour"}:
        return number * 1000
    return None


def value_with_unit_to_ml(value: Any, unit: Any) -> float | None:
    number = finite_number(value)
    if number is None or number <= 0:
        return None
    normalized = str(unit or "").strip().lower().replace(" ", "")
    if normalized in {"ml", "milliliter", "millilitre"}:
        return number
    if normalized in {"l", "liter", "litre"}:
        return number * 1000
    return None


def round2(value: float) -> float:
    return float(f"{value:.2f}")


@router.get("/status")
def case_status(database: Connection = Depends(connection)) -> dict:
    row = database.execute(
        """
        SELECT id, hn, admission_number, status, start_time, discharge_time, admission_source, identity_status
        FROM cases
        WHERE status = 'active'
        ORDER BY start_time DESC, id DESC
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return {"status": "IDLE"}
    return {
        "status": row["status"].upper(),
        "case_id": row["id"],
        "hn": row["hn"],
        "admission_number": row["admission_number"],
        "start_time": row["start_time"],
        "discharge_time": row["discharge_time"],
        "admission_source": row["admission_source"],
        "identity_status": row["identity_status"],
    }


@router.get("/list")
def case_list(request: Request, database: Connection = Depends(connection)) -> dict:
    requested_limit = number_or_none(request.query_params.get("limit"))
    limit = int(max(1, min(200, math.floor(requested_limit)))) if requested_limit is not None else 30
    include_archived = request.query_params.get("include_archived", "1").lower() != "0"
    statuses = (
        ["active", "discharged", "archived"]
        if include_archived
        else ["active", "discharged"]
    )
    rows = database.execute(
        """
        SELECT id, case_code, hn, status, start_time, discharge_time, created_at, admission_source, identity_status
        FROM cases
        WHERE status = ANY(%s)
        ORDER BY start_time DESC, id DESC
        LIMIT %s
        """,
        (statuses, limit),
    ).fetchall()
    return {
        "rows": [
            {
                "case_id": row["id"],
                "case_code": row["case_code"],
                "hn": row["hn"],
                "status": row["status"].upper(),
                "start_time": row["start_time"],
                "discharge_time": row["discharge_time"],
                "created_at": row["created_at"],
                "admission_source": row["admission_source"],
                "identity_status": row["identity_status"],
            }
            for row in rows
        ]
    }


@router.get("/{case_id_raw}/vitals")
def vitals(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    rows = database.execute(
        """
        SELECT ts_minute, payload, ivy_source
        FROM vital_minutes
        WHERE case_id = %s AND ts_minute BETWEEN %s AND %s
        ORDER BY ts_minute ASC
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()
    return {
        "case_id": case_id,
        "from": from_ts,
        "to": to_ts,
        "rows": [
            {"ts_minute": row["ts_minute"], "payload": parse_payload(row["payload"])}
            for row in rows
        ],
    }


@router.get("/{case_id_raw}/events")
def events(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    requested_limit = number_or_none(request.query_params.get("limit"))
    limit = int(max(1, min(1000, requested_limit))) if requested_limit is not None else 300
    rows = database.execute(
        """
        SELECT id, event_ts, event_type, title, detail,
               created_by, created_at, updated_by, updated_at
        FROM case_event_note
        WHERE case_id = %s
          AND is_deleted = 0
          AND event_ts BETWEEN %s AND %s
        ORDER BY event_ts DESC, id DESC
        LIMIT %s
        """,
        (case_id, from_ts, to_ts, limit),
    ).fetchall()
    return {"case_id": case_id, "from": from_ts, "to": to_ts, "rows": rows}


@router.get("/{case_id_raw}/timeline")
def timeline(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    rows = database.execute(
        """
        SELECT ts_minute, param_key, value_type, value_num, value_text,
               unit, source, note, updated_by, updated_at
        FROM case_timeline_value
        WHERE case_id = %s AND ts_minute BETWEEN %s AND %s
        ORDER BY ts_minute ASC, param_key ASC
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()
    output = []
    for row in rows:
        output.append(
            {
                "ts_minute": row["ts_minute"],
                "param_key": row["param_key"],
                "value_type": row["value_type"],
                "value": row["value_num"] if row["value_type"] == "number" else row["value_text"],
                "unit": row["unit"],
                "source": row["source"],
                "note": row["note"],
                "updated_by": row["updated_by"],
                "updated_at": row["updated_at"],
            }
        )
    return {"case_id": case_id, "from": from_ts, "to": to_ts, "rows": output}


@router.get("/{case_id_raw}/timeline/effective")
def effective_timeline(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    raw_rows = database.execute(
        """
        SELECT ts_minute, payload, ivy_source
        FROM vital_minutes
        WHERE case_id = %s AND ts_minute BETWEEN %s AND %s
        ORDER BY ts_minute ASC
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()
    manual_rows = database.execute(
        """
        SELECT ts_minute, param_key, value_type, value_num, value_text,
               unit, source, note, updated_by, updated_at,
               original_value_type, original_value_num, original_value_text, original_source
        FROM case_timeline_value
        WHERE case_id = %s AND ts_minute BETWEEN %s AND %s
        ORDER BY ts_minute ASC, param_key ASC
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()

    by_minute = {row["ts_minute"]: parse_payload(row["payload"]) for row in raw_rows}
    source_by_minute = {row["ts_minute"]: row["ivy_source"] for row in raw_rows}
    audit_rows = database.execute(
        """SELECT ts_minute,param_key,reason,actor_username,actor_name,actor_role,created_at
        FROM case_timeline_audit
        WHERE case_id=%s AND ts_minute BETWEEN %s AND %s
        ORDER BY created_at ASC,id ASC""",
        (case_id, from_ts, to_ts),
    ).fetchall()
    audit_by_cell: dict[tuple[int,str],dict] = {}
    for audit in audit_rows:
        audit_key=(audit["ts_minute"],audit["param_key"])
        summary=audit_by_cell.setdefault(audit_key,{"audit_count":0})
        summary["audit_count"]+=1
        summary.update({
            "reason":audit["reason"],"actor_username":audit["actor_username"],
            "actor_name":audit["actor_name"],"actor_role":audit["actor_role"],
            "edited_at":audit["created_at"],
        })
    provenance_by_minute: dict[int,dict] = {}
    for row in manual_rows:
        payload = by_minute.get(row["ts_minute"], {})
        if not isinstance(payload, dict):
            payload = {}
        original_value = row["original_value_num"] if row["original_value_type"] == "number" else row["original_value_text"]
        if original_value is None and row["source"] == "override":
            original_value = payload.get(row["param_key"])
        payload[row["param_key"]] = (
            row["value_num"] if row["value_type"] == "number" else row["value_text"]
        )
        by_minute[row["ts_minute"]] = payload
        audit = audit_by_cell.get((row["ts_minute"],row["param_key"]),{})
        provenance_by_minute.setdefault(row["ts_minute"],{})[row["param_key"]]={
            "source":row["source"],
            "original_value":original_value,
            "original_source":row["original_source"] or source_by_minute.get(row["ts_minute"]),
            "updated_by":row["updated_by"],"updated_at":row["updated_at"],"note":row["note"],
            **audit,
        }

    rows = [
        {"ts_minute": timestamp, "payload": by_minute[timestamp], "provenance": provenance_by_minute.get(timestamp,{})}
        for timestamp in sorted(by_minute)
    ]
    return {"case_id": case_id, "from": from_ts, "to": to_ts, "rows": rows}


@router.get("/{case_id_raw}/timeline/audit")
def timeline_audit(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    rows = database.execute(
        """
        SELECT *
        FROM case_timeline_audit
        WHERE case_id = %s AND ts_minute BETWEEN %s AND %s
        ORDER BY created_at ASC, id ASC
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()
    return {"case_id": case_id, "from": from_ts, "to": to_ts, "rows": rows}


@router.get("/{case_id_raw}/timeaxis")
def time_axis(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    requested_step = number_or_none(request.query_params.get("step")) or 1
    step_min = min(120, max(1, math.floor(requested_step + 0.5)))
    row = get_case_range_row(database, case_id)
    start_ts = floor_minute(row["start_time"])
    end_ts = (
        floor_minute(now_ms() + ADVANCE_MIN * MINUTE_MS)
        if row["status"] == "active"
        else floor_minute(row["discharge_time"] or 0)
    )
    step_ms = step_min * MINUTE_MS
    axis = list(range(start_ts, end_ts + 1, step_ms))
    return {"case_id": case_id, "axis": axis, "server_time": now_ms()}


@router.get("/{case_id_raw}/detail-draft")
def detail_draft(case_id_raw: str, database: Connection = Depends(connection)) -> dict:
    case_id = case_id_or_400(case_id_raw)
    if case_id <= 0:
        raise HTTPException(status_code=400, detail="invalid case id")
    row = database.execute(
        "SELECT form_draft_json, updated_at FROM case_detail WHERE case_id = %s",
        (case_id,),
    ).fetchone()
    draft = parse_payload(row["form_draft_json"]) if row else None
    if not isinstance(draft, dict):
        draft = None
    return {
        "ok": True,
        "case_id": case_id,
        "draft": draft,
        "updated_at": row["updated_at"] if row and row["updated_at"] else None,
    }


@router.get("/{case_id_raw}/patient")
def patient(case_id_raw: str, database: Connection = Depends(connection)) -> dict:
    case_id = case_id_or_400(case_id_raw)
    if case_id <= 0:
        raise HTTPException(status_code=400, detail="invalid case id")
    case_row = database.execute(
        "SELECT hn, admission_metadata FROM cases WHERE id = %s",
        (case_id,),
    ).fetchone()
    if case_row is None:
        raise HTTPException(status_code=404, detail="case not found")
    admission_metadata = parse_payload(case_row["admission_metadata"])
    if not isinstance(admission_metadata, dict):
        admission_metadata = {}

    row = database.execute(
        """
        SELECT case_id, hn, an, is_patient, notype, id_card, patient_name,
               title_th, title_en, first_name, last_name, first_name_en, last_name_en,
               sex, dob, age_text, weight_kg, height_cm, blood_group_text,
               blood_group_abo, blood_group_rh, race, ethnicity, religion,
               marital_status, present_address, present_province, legal_address,
               legal_province, mobile, contact_name, contact_tel, relation_desc,
               nationality, source, his_updated_at, updated_at, raw_payload
        FROM case_his_patient
        WHERE case_id = %s
        """,
        (case_id,),
    ).fetchone()
    if row is None:
        return {"row": {
            "hn": case_row["hn"],
            "asa_status": admission_metadata.get("asa_status"),
            "asa_emergency": bool(admission_metadata.get("asa_emergency")),
        }}
    output = dict(row)
    output["his_payload"] = parse_payload(row["raw_payload"]) if row["raw_payload"] else None
    output["asa_status"] = admission_metadata.get("asa_status")
    output["asa_emergency"] = bool(admission_metadata.get("asa_emergency"))
    return {"row": output}


@router.get("/{case_id_raw}/allergies")
def allergies(case_id_raw: str, database: Connection = Depends(connection)) -> dict:
    case_id = case_id_or_400(case_id_raw)
    if case_id <= 0:
        raise HTTPException(status_code=400, detail="invalid case id")
    rows = database.execute(
        """
        SELECT id, allergen, reaction, severity, status, source, updated_at
        FROM case_his_allergy
        WHERE case_id = %s
        ORDER BY id ASC
        """,
        (case_id,),
    ).fetchall()
    return {"rows": rows}


@router.get("/{case_id_raw}/labs")
def labs(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    if case_id <= 0:
        raise HTTPException(status_code=400, detail="invalid case id")
    from_ts = number_or_none(request.query_params.get("from"))
    to_ts = number_or_none(request.query_params.get("to"))
    requested_limit = number_or_none(request.query_params.get("limit"))
    limit = int(max(1, min(1000, math.trunc(requested_limit)))) if requested_limit is not None else 500
    filters = ["case_id = %s"]
    params: list[Any] = [case_id]
    if from_ts is not None:
        filters.append("COALESCE(collected_at, 0) >= %s")
        params.append(from_ts)
    if to_ts is not None:
        filters.append("COALESCE(collected_at, 0) <= %s")
        params.append(to_ts)
    params.append(limit)
    rows = database.execute(
        f"""
        SELECT id, test_name, test_group, value_text, unit,
               ref_range, flag, collected_at, source, updated_at
        FROM case_his_lab
        WHERE {' AND '.join(filters)}
        ORDER BY COALESCE(collected_at, 0) DESC, id DESC
        LIMIT %s
        """,
        params,
    ).fetchall()
    return {"rows": rows}


@router.get("/{case_id_raw}/diagnosis")
def diagnosis(case_id_raw: str, database: Connection = Depends(connection)) -> dict:
    case_id = case_id_or_400(case_id_raw)
    rows = database.execute(
        """
        SELECT d.id, d.diagnosis_text,
               CASE WHEN upper(COALESCE(d.icd_version, '')) = 'ICD-10'
                    THEN COALESCE(NULLIF(m.name_en, ''), NULLIF(m.name_th, ''), d.icd_text)
                    ELSE d.icd_text END AS icd_text,
               d.icd_code, d.icd_version, d.concept_id, d.coding_snapshot,
               d.seq, d.event_ts, d.entry_context, d.created_at
        FROM case_diagnosis d
        LEFT JOIN icd10_master m
          ON (m.icd10 = d.icd_code OR m.icd10who = d.icd_code)
        WHERE d.case_id = %s
        ORDER BY d.seq ASC, d.event_ts ASC, d.id ASC
        """,
        (case_id,),
    ).fetchall()
    return {"case_id": case_id, "rows": rows}


@router.get("/{case_id_raw}/procedures")
def procedures(case_id_raw: str, database: Connection = Depends(connection)) -> dict:
    case_id = case_id_or_400(case_id_raw)
    rows = database.execute(
        """
        SELECT p.id, p.procedure_text,
               CASE WHEN upper(COALESCE(p.icd_version, '')) = 'ICD-9'
                    THEN COALESCE(NULLIF(m.name_en, ''), p.icd_text)
                    ELSE p.icd_text END AS icd_text,
               p.icd_code, p.icd_version, p.concept_id, p.coding_snapshot,
               p.seq, p.event_ts, p.entry_context, p.created_at
        FROM case_procedure p
        LEFT JOIN icd9cm_master m
          ON m.icd9cm = replace(replace(COALESCE(p.icd_code, ''), '.', ''), ' ', '')
        WHERE p.case_id = %s
        ORDER BY p.seq ASC, p.event_ts ASC, p.id ASC
        """,
        (case_id,),
    ).fetchall()
    return {"case_id": case_id, "rows": rows}


@router.get("/{case_id_raw}/staff")
def case_staff(case_id_raw: str, database: Connection = Depends(connection)) -> dict:
    case_id = case_id_or_400(case_id_raw)
    exists = database.execute("SELECT id FROM cases WHERE id = %s", (case_id,)).fetchone()
    if exists is None:
        raise HTTPException(status_code=404, detail="not found")
    rows = database.execute(
        """
        SELECT id, hospital_id, personal_id, email, th_first_name, th_last_name,
               en_first_name, en_last_name, innovian_id,
               staff_role_id AS role_id, staff_name AS name, staff_role AS role,
               entry_year, profile_data, seq
        FROM case_staff
        WHERE case_id = %s
        ORDER BY seq ASC, id ASC
        """,
        (case_id,),
    ).fetchall()
    return {"case_id": case_id, "rows": rows}


@router.get("/staff/roles")
def staff_roles(database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        """
        SELECT id, display_name AS name, sort_order
        FROM staff_role
        ORDER BY sort_order ASC, id ASC
        """
    ).fetchall()
    return {"rows": rows}


@router.get("/{case_id_raw}/io/items")
def io_items(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    exists = database.execute("SELECT id FROM cases WHERE id = %s", (case_id,)).fetchone()
    if exists is None:
        raise HTTPException(status_code=404, detail="not found")
    kind = io_kind(request.query_params.get("kind"))
    if kind:
        rows = database.execute(
            """
            SELECT id, kind, code, name, default_unit, category,
                   usage_score, usage_rank, is_active
            FROM io_item_master
            WHERE is_active = 1 AND kind = %s
            ORDER BY COALESCE(usage_rank, 999999) ASC,
                     usage_score DESC, name ASC
            """,
            (kind,),
        ).fetchall()
    else:
        rows = database.execute(
            """
            SELECT id, kind, code, name, default_unit, category,
                   usage_score, usage_rank, is_active
            FROM io_item_master
            WHERE is_active = 1
            ORDER BY kind ASC, COALESCE(usage_rank, 999999) ASC,
                     usage_score DESC, name ASC
            """
        ).fetchall()
    return {"case_id": case_id, "rows": rows}


@router.get("/{case_id_raw}/io/runs")
def io_runs(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    runs = database.execute(
        """
        SELECT r.id, r.case_id, r.item_id, i.code AS item_code,
               i.name AS item_name, i.category AS item_category,
               i.default_unit AS item_unit, r.kind, r.route, r.started_at,
               r.stopped_at, r.entry_mode, r.note, r.include_in_balance,
               r.created_by, r.created_at, r.updated_at
        FROM case_io_run r
        JOIN io_item_master i ON i.id = r.item_id
        WHERE r.case_id = %s
          AND r.include_in_balance != 0
          AND r.started_at <= %s
          AND COALESCE(r.stopped_at, 9223372036854775807) >= %s
        ORDER BY r.started_at ASC, r.id ASC
        """,
        (case_id, to_ts, from_ts),
    ).fetchall()
    run_ids = [row["id"] for row in runs]
    segments = []
    if run_ids:
        segments = database.execute(
            """
            SELECT id, run_id, ts_from, ts_to, rate_value, rate_unit,
                   dose_value, dose_unit, carrier_ml_per_hr,
                   include_in_balance, note, created_by, created_at, updated_at
            FROM case_io_segment
            WHERE run_id = ANY(%s) AND include_in_balance != 0
            ORDER BY ts_from ASC, id ASC
            """,
            (run_ids,),
        ).fetchall()
    segments_by_run: dict[int, list[dict[str, Any]]] = {}
    for segment in segments:
        segments_by_run.setdefault(segment["run_id"], []).append(segment)
    rows = []
    for run in runs:
        output = dict(run)
        output["segments"] = segments_by_run.get(run["id"], [])
        rows.append(output)
    return {"case_id": case_id, "from": from_ts, "to": to_ts, "rows": rows}


@router.get("/{case_id_raw}/io/events")
def io_events(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    rows = database.execute(
        """
        SELECT e.*, i.code AS item_code, i.name AS item_name,
               i.category AS item_category
        FROM case_io_event e
        JOIN io_item_master i ON i.id = e.item_id
        WHERE e.case_id = %s
          AND e.include_in_balance != 0
          AND e.event_ts BETWEEN %s AND %s
        ORDER BY e.event_ts ASC, e.id ASC
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()
    return {"case_id": case_id, "from": from_ts, "to": to_ts, "rows": rows}


@router.get("/{case_id_raw}/io/audit")
def io_audit(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    rows = database.execute(
        """
        SELECT *
        FROM case_io_audit
        WHERE case_id = %s AND created_at BETWEEN %s AND %s
        ORDER BY created_at ASC, id ASC
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()
    return {"case_id": case_id, "from": from_ts, "to": to_ts, "rows": rows}


@router.get("/{case_id_raw}/io/summary")
def io_summary(
    case_id_raw: str,
    request: Request,
    database: Connection = Depends(connection),
) -> dict:
    case_id = case_id_or_400(case_id_raw)
    case_row = get_case_range_row(database, case_id)
    from_ts, to_ts = resolve_case_range(case_row, request)
    requested_bucket = number_or_none(request.query_params.get("bucket"))
    bucket_min = int(max(1, min(60, math.floor(requested_bucket)))) if requested_bucket is not None else 1
    bucket_ms = bucket_min * MINUTE_MS
    range_end_exclusive = to_ts + bucket_ms
    effective_end_exclusive = min(range_end_exclusive, now_ms())
    bucket_count = max(1, math.floor((to_ts - from_ts) / bucket_ms) + 1)
    buckets = [
        {
            "ts_bucket": from_ts + index * bucket_ms,
            "intake_ml": 0.0,
            "output_ml": 0.0,
            "net_ml": 0.0,
            "cumulative_net_ml": 0.0,
        }
        for index in range(bucket_count)
    ]

    total_intake = 0.0
    total_output = 0.0
    urine_output = 0.0
    blood_loss = 0.0
    item_totals: dict[str, dict[str, Any]] = {}

    def token(value: Any) -> str:
        return "".join(char for char in str(value or "").lower() if char.isascii() and char.isalnum())

    def is_urine(item: dict[str, Any]) -> bool:
        return (
            token(item.get("item_code")) == "urine"
            or "urine" in token(item.get("item_name"))
            or token(item.get("item_category")) == "urine"
        )

    def is_blood_loss(item: dict[str, Any]) -> bool:
        return (
            token(item.get("item_code")) == "bloodloss"
            or "bloodloss" in token(item.get("item_name"))
            or token(item.get("item_category")) == "bloodloss"
        )

    def add_item_total(item: dict[str, Any], kind: str, amount: float) -> None:
        if not math.isfinite(amount) or amount <= 0:
            return
        raw_item_id = finite_number(item.get("item_id"))
        item_id = int(raw_item_id) if raw_item_id is not None and raw_item_id > 0 else None
        item_code = str(item.get("item_code") or "").strip()
        item_name = str(item.get("item_name") or "").strip() or item_code or "Unknown"
        normalized_kind = kind if kind in {"fluid", "med", "output"} else "med"
        key = (
            f"{normalized_kind}|id:{item_id}"
            if item_id is not None
            else f"{normalized_kind}|token:{token(item_code or item_name) or 'unknown'}"
        )
        if key in item_totals:
            item_totals[key]["total_ml"] += amount
            return
        item_totals[key] = {
            "kind": normalized_kind,
            "item_id": item_id,
            "item_code": item_code,
            "item_name": item_name,
            "item_unit": str(item.get("item_unit") or "").strip(),
            "item_category": str(item.get("item_category") or "").strip(),
            "total_ml": amount,
        }

    def add_at(timestamp: int, intake: float, output: float) -> None:
        if timestamp < from_ts or timestamp > to_ts:
            return
        index = math.floor((timestamp - from_ts) / bucket_ms)
        if 0 <= index < len(buckets):
            buckets[index]["intake_ml"] += intake
            buckets[index]["output_ml"] += output

    events = database.execute(
        """
        SELECT e.item_id, e.event_ts, e.kind, e.volume_ml, e.dose_value,
               e.dose_unit, e.include_in_balance, i.code AS item_code,
               i.name AS item_name, i.default_unit AS item_unit,
               i.category AS item_category
        FROM case_io_event e
        JOIN io_item_master i ON i.id = e.item_id
        WHERE e.case_id = %s AND e.event_ts BETWEEN %s AND %s
        """,
        (case_id, from_ts, to_ts),
    ).fetchall()
    for event in events:
        if not event["include_in_balance"] or event["kind"] == "med":
            continue
        volume = finite_number(event["volume_ml"])
        if volume is None or volume <= 0:
            volume = value_with_unit_to_ml(event["dose_value"], event["dose_unit"])
        if volume is None or volume <= 0:
            continue
        if event["kind"] == "output":
            add_at(event["event_ts"], 0, volume)
            total_output += volume
            add_item_total(event, "output", volume)
            if is_urine(event):
                urine_output += volume
            if is_blood_loss(event):
                blood_loss += volume
        else:
            add_at(event["event_ts"], volume, 0)
            total_intake += volume
            add_item_total(event, event["kind"], volume)

    segments = database.execute(
        """
        SELECT i.id AS item_id, s.ts_from, s.ts_to, s.rate_value, s.rate_unit,
               s.carrier_ml_per_hr, s.include_in_balance AS seg_include,
               r.kind AS run_kind, r.include_in_balance AS run_include,
               r.stopped_at AS run_stopped_at, i.code AS item_code,
               i.name AS item_name, i.default_unit AS item_unit,
               i.category AS item_category
        FROM case_io_segment s
        JOIN case_io_run r ON r.id = s.run_id
        JOIN io_item_master i ON i.id = r.item_id
        WHERE r.case_id = %s
          AND s.ts_from <= %s
          AND COALESCE(s.ts_to, COALESCE(r.stopped_at, %s)) >= %s
        """,
        (case_id, effective_end_exclusive, effective_end_exclusive, from_ts),
    ).fetchall()
    for segment in segments:
        if not segment["seg_include"] or not segment["run_include"]:
            continue
        segment_start = max(from_ts, segment["ts_from"])
        segment_end_source = segment["ts_to"] or segment["run_stopped_at"] or effective_end_exclusive
        segment_end = min(segment_end_source, effective_end_exclusive)
        if segment_end <= segment_start:
            continue
        start_index = max(0, math.floor((segment_start - from_ts) / bucket_ms))
        end_index = min(
            len(buckets) - 1,
            math.floor((max(segment_start, segment_end - 1) - from_ts) / bucket_ms),
        )
        ml_per_hour = rate_to_ml_per_hour(segment["rate_value"], segment["rate_unit"])
        carrier = finite_number(segment["carrier_ml_per_hr"]) or 0
        for index in range(start_index, end_index + 1):
            bucket_start = from_ts + index * bucket_ms
            bucket_end = bucket_start + bucket_ms
            overlap_start = max(segment_start, bucket_start)
            overlap_end = min(segment_end, bucket_end)
            if overlap_end <= overlap_start:
                continue
            hours = (overlap_end - overlap_start) / 3_600_000
            base_ml = 0 if ml_per_hour is None else ml_per_hour * hours
            carrier_ml = 0 if segment["run_kind"] == "output" else max(0, carrier) * hours
            if segment["run_kind"] == "output":
                buckets[index]["output_ml"] += base_ml
                total_output += base_ml
                add_item_total(segment, "output", base_ml)
                if is_urine(segment):
                    urine_output += base_ml
                if is_blood_loss(segment):
                    blood_loss += base_ml
            else:
                amount = base_ml + carrier_ml
                buckets[index]["intake_ml"] += amount
                total_intake += amount
                add_item_total(segment, segment["run_kind"], base_ml)

    cumulative = 0.0
    for bucket in buckets:
        bucket["intake_ml"] = round2(bucket["intake_ml"])
        bucket["output_ml"] = round2(bucket["output_ml"])
        bucket["net_ml"] = round2(bucket["intake_ml"] - bucket["output_ml"])
        cumulative += bucket["net_ml"]
        bucket["cumulative_net_ml"] = round2(cumulative)
    item_total_rows = list(item_totals.values())
    for row in item_total_rows:
        row["total_ml"] = round2(row["total_ml"])
    item_total_rows.sort(key=lambda row: (-row["total_ml"], row["item_name"]))
    return {
        "case_id": case_id,
        "from": from_ts,
        "to": to_ts,
        "bucket_min": bucket_min,
        "totals": {
            "intake_ml": round2(total_intake),
            "output_ml": round2(total_output),
            "net_ml": round2(total_intake - total_output),
            "urine_output_ml": round2(urine_output),
            "blood_loss_ml": round2(blood_loss),
            "item_totals_ml": item_total_rows,
        },
        "rows": buckets,
    }
