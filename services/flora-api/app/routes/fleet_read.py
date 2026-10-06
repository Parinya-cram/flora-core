import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection

from ..database import connection
from .auth_canopy import read_token
from .canopy_users import ward_scope


router = APIRouter(
    prefix="/api/fleet",
    tags=["canopy-fleet"],
    dependencies=[Depends(read_token)],
)

# A Leaf belongs to the ward of its assigned bed; unassigned Leafs are visible only
# to users with access to every ward (scope None).
IN_SCOPE = "(%s::text[] IS NULL OR scope_unit.unit_key = ANY(%s))"


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _rows(value: Any) -> list[dict[str, Any]]:
    rows = _record(value).get("rows")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed else None
    except (TypeError, ValueError):
        return None


def _patient_name(patient: dict[str, Any], hn: str | None) -> str:
    direct = str(patient.get("patient_name") or "").strip()
    if direct:
        return direct
    for keys in (("title_th", "first_name", "last_name"), ("title_en", "first_name_en", "last_name_en")):
        joined = " ".join(str(patient.get(key) or "").strip() for key in keys).strip()
        if joined:
            return joined
    return f"HN {hn or '—'}"


def _latest_value(vitals: list[dict[str, Any]], *keys: str) -> float | None:
    for row in reversed(vitals):
        payload = _record(row.get("payload"))
        for key in keys:
            value = _number(payload.get(key))
            if value is not None:
                return value
    return None


def _compact_vitals(snapshot: dict[str, Any], limit_points: int) -> tuple[dict[str, float | None], list[dict[str, Any]]]:
    vitals = _rows(snapshot.get("vitals")) or _rows(snapshot.get("timeline"))
    recent = vitals[-limit_points:]
    latest = {
        "hr": _latest_value(vitals, "hr", "pr"),
        "spo2": _latest_value(vitals, "spo2"),
        "rr": _latest_value(vitals, "rr", "set_rr"),
        "sbp": _latest_value(vitals, "art_sys", "nibp_sys"),
        "dbp": _latest_value(vitals, "art_dia", "nibp_dia"),
        "map": _latest_value(vitals, "art_map", "nibp_map"),
        "temperature": _latest_value(vitals, "temperature", "temp"),
        "etco2": _latest_value(vitals, "etco2", "et_co2"),
    }
    trends: list[dict[str, Any]] = []
    for row in recent:
        payload = _record(row.get("payload"))
        trends.append({
            "ts": row.get("ts_minute"),
            "hr": _number(payload.get("hr") if payload.get("hr") is not None else payload.get("pr")),
            "spo2": _number(payload.get("spo2")),
            "map": _number(payload.get("art_map") if payload.get("art_map") is not None else payload.get("nibp_map")),
            "rr": _number(payload.get("rr") if payload.get("rr") is not None else payload.get("set_rr")),
        })
    return latest, trends


def _text(value: Any) -> str | None:
    result = str(value or "").strip()
    return result or None


def _chart_summary(snapshot: dict[str, Any], patient: dict[str, Any]) -> dict[str, Any]:
    diagnoses = _rows(snapshot.get("diagnosis"))
    allergies = _rows(snapshot.get("allergies"))
    events = _rows(snapshot.get("events"))
    staff = _rows(snapshot.get("staff"))
    io_events = _rows(snapshot.get("io_events"))
    io_runs = _rows(snapshot.get("io_runs"))
    forms = _rows(snapshot.get("forms"))
    io_totals = _record(_record(snapshot.get("io_summary")).get("totals"))

    his_payload = _record(patient.get("his_payload"))
    labs = his_payload.get("lab")
    lab_rows = [row for row in labs if isinstance(row, dict)] if isinstance(labs, list) else []
    run_by_id = {str(run.get("id")): run for run in io_runs if run.get("id") is not None}
    run_by_item = {str(run.get("item_id")): run for run in io_runs if run.get("item_id") is not None}

    def event_time(row: dict[str, Any]) -> float:
        return _number(row.get("event_ts") or row.get("ts") or row.get("created_at")) or 0

    recent_events = []
    for row in sorted(events, key=event_time, reverse=True)[:4]:
        recent_events.append({
            "time": row.get("event_ts") or row.get("ts") or row.get("created_at"),
            "title": _text(row.get("title") or row.get("event_name") or row.get("name") or row.get("event_type")) or "Chart event",
            "kind": _text(row.get("event_type") or row.get("type")),
        })

    recent_medications = []
    for row in sorted(io_events, key=event_time, reverse=True):
        run = run_by_id.get(str(row.get("run_id"))) or run_by_item.get(str(row.get("item_id"))) or {}
        if str(run.get("kind") or row.get("kind") or "").lower() == "output":
            continue
        name = _text(row.get("item_name") or row.get("name") or run.get("item_name"))
        if not name:
            continue
        recent_medications.append({
            "time": row.get("event_ts") or row.get("ts") or row.get("created_at"),
            "name": name,
            "dose": _number(row.get("dose_value") or row.get("dose")),
            "unit": _text(row.get("dose_unit") or row.get("unit") or run.get("item_unit")),
            "route": _text(row.get("route") or run.get("route")),
        })
        if len(recent_medications) == 4:
            break

    active_infusions = []
    for run in io_runs:
        segments = run.get("segments") if isinstance(run.get("segments"), list) else []
        if str(run.get("kind") or "").lower() == "output" or run.get("stopped_at") is not None or not segments:
            continue
        segment = _record(segments[-1])
        active_infusions.append({
            "name": _text(run.get("item_name")) or "Infusion",
            "rate": _number(segment.get("rate") or segment.get("rate_value") or segment.get("dose_rate")),
            "unit": _text(segment.get("rate_unit") or run.get("item_unit")),
        })

    return {
        "patient": {
            "age": _text(patient.get("age_text")),
            "weight_kg": _number(patient.get("weight_kg") or patient.get("weight")),
            "height_cm": _number(patient.get("height_cm") or patient.get("height")),
            "blood_group": _text(patient.get("blood_group_text") or patient.get("blood_group")),
            "asa_status": _text(patient.get("asa_status")),
        },
        "diagnoses": [
            _text(row.get("diagnosis_text") or row.get("icd_text") or row.get("name"))
            for row in diagnoses[:3]
            if _text(row.get("diagnosis_text") or row.get("icd_text") or row.get("name"))
        ],
        "allergies": [
            {
                "allergen": _text(row.get("allergen") or row.get("name")) or "Unspecified allergy",
                "reaction": _text(row.get("reaction")),
                "severity": _text(row.get("severity")),
            }
            for row in allergies[:3]
        ],
        "staff": [
            {
                "name": _text(row.get("display_name") or row.get("staff_name") or row.get("name")) or "Unnamed staff",
                "role": _text(row.get("role_name") or row.get("role") or row.get("staff_role")),
            }
            for row in staff[:4]
        ],
        "recent_events": recent_events,
        "recent_medications": recent_medications,
        "active_infusions": active_infusions[:4],
        "labs": [
            {
                "name": _text(row.get("LABNAME") or row.get("name")) or "Lab",
                "value": _text(row.get("LABRESULT") or row.get("value")),
                "unit": _text(row.get("LABUNIT") or row.get("unit")),
                "flag": _text(row.get("ABNORMALFLAG") or row.get("flag")),
            }
            for row in lab_rows[:4]
        ],
        "io": {
            "intake_ml": _number(io_totals.get("intake_ml")),
            "output_ml": _number(io_totals.get("output_ml")),
            "net_ml": _number(io_totals.get("net_ml")),
            "urine_output_ml": _number(io_totals.get("urine_output_ml")),
            "blood_loss_ml": _number(io_totals.get("blood_loss_ml")),
        },
        "documentation": {
            "events": len(events),
            "medications": len([row for row in io_events if str((run_by_id.get(str(row.get("run_id"))) or run_by_item.get(str(row.get("item_id"))) or {}).get("kind") or row.get("kind") or "").lower() != "output"]),
            "forms": len(forms),
            "staff": len(staff),
        },
    }


@router.get("/icu-overview")
def icu_overview(
    limit_points: int = Query(default=30, ge=12, le=120),
    scope: list[str] | None = Depends(ward_scope),
    database: Connection = Depends(connection),
) -> dict[str, Any]:
    rows = database.execute(
        """
        SELECT leaf.leaf_id,leaf.hospital_id,
               coalesce(nullif(leaf.canopy_display_name,''),leaf.display_name) AS display_name,
               leaf.last_seen_at,
               assignment.desired_config#>>'{location,hospitalName}' AS hospital_name,
               assignment.desired_config#>>'{location,buildingName}' AS building_name,
               assignment.desired_config#>>'{location,careUnitName}' AS care_unit_name,
               assignment.desired_config#>>'{location,roomName}' AS room_name,
               assignment.desired_config#>>'{location,bedName}' AS bed_name,
               CASE WHEN leaf.last_seen_at >= now() - interval '90 seconds' THEN 'online'
                    WHEN leaf.last_seen_at >= now() - interval '10 minutes' THEN 'delayed'
                    ELSE 'offline' END AS connection_status,
               active.global_case_id,active.source_case_id,active.case_code,active.hn,
               active.status,active.start_time,active.discharge_time,active.last_synced_at,active.snapshot
        FROM sync_leaf_node leaf
        LEFT JOIN canopy_leaf_assignment assignment ON assignment.leaf_id=leaf.leaf_id
        LEFT JOIN LATERAL (
          SELECT case_row.* FROM sync_case_index case_row
          WHERE case_row.leaf_id=leaf.leaf_id AND upper(case_row.status)='ACTIVE'
          ORDER BY case_row.last_synced_at DESC LIMIT 1
        ) active ON true
        LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id=leaf.leaf_id
        WHERE {IN_SCOPE}
        ORDER BY coalesce(assignment.desired_config#>>'{location,careUnitName}',''),
                 coalesce(assignment.desired_config#>>'{location,bedName}',''),
                 coalesce(nullif(leaf.canopy_display_name,''),leaf.display_name),leaf.leaf_id
        """.replace("{IN_SCOPE}", IN_SCOPE),
        (scope, scope),
    ).fetchall()
    result: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    for row in rows:
        item = {
            "leaf_id": row["leaf_id"], "hospital_id": row["hospital_id"],
            "display_name": row["display_name"], "last_seen_at": row["last_seen_at"],
            "connection_status": row["connection_status"],
            "hospital_name": row.get("hospital_name"), "building_name": row.get("building_name"),
            "care_unit_name": row.get("care_unit_name"), "room_name": row.get("room_name"),
            "bed_name": row.get("bed_name"), "case": None,
        }
        if row.get("global_case_id"):
            snapshot = _record(row.get("snapshot"))
            patient = _record(_record(snapshot.get("patient")).get("row"))
            procedures = _rows(snapshot.get("procedures"))
            procedure = procedures[0] if procedures else {}
            latest, trends = _compact_vitals(snapshot, limit_points)
            sync_status = "live" if row["last_synced_at"] >= now - timedelta(seconds=90) else "delayed" if row["last_synced_at"] >= now - timedelta(minutes=10) else "offline"
            item["case"] = {
                "global_case_id": str(row["global_case_id"]), "hospital_id": row["hospital_id"],
                "leaf_id": row["leaf_id"], "leaf_name": row["display_name"],
                "source_case_id": row["source_case_id"], "case_code": row.get("case_code"),
                "hn": row.get("hn"), "status": row["status"], "start_time": row.get("start_time"),
                "discharge_time": row.get("discharge_time"), "last_synced_at": row["last_synced_at"],
                "sync_status": sync_status, "patient_name": _patient_name(patient, row.get("hn")),
                "gender": patient.get("gender") or patient.get("sex"),
                "procedure": procedure.get("procedure_text") or procedure.get("icd_text"),
                "latest": latest, "trends": trends, "chart": _chart_summary(snapshot, patient),
            }
        result.append(item)
    return {"server_time": now, "rows": result}


@router.get("/leaves")
def leaves(scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        """
        SELECT leaf.leaf_id, leaf.hospital_id,
               coalesce(nullif(leaf.canopy_display_name,''),leaf.display_name) AS display_name,
               leaf.display_name AS reported_display_name, leaf.canopy_display_name,
               leaf.software_version,
               leaf.last_seen_at, leaf.registered_at,
               assignment.desired_config#>>'{location,hospitalName}' AS hospital_name,
               assignment.desired_config#>>'{location,buildingName}' AS building_name,
               assignment.desired_config#>>'{location,careUnitName}' AS care_unit_name,
               assignment.desired_config#>>'{location,roomName}' AS room_name,
               assignment.desired_config#>>'{location,bedName}' AS bed_name,
               assignment.desired_version, assignment.applied_version,
               CASE WHEN assignment.leaf_id IS NULL THEN 'unassigned'
                    WHEN assignment.applied_version >= assignment.desired_version THEN 'synced'
                    WHEN assignment.applied_version = 0 THEN 'pending'
                    ELSE 'outdated' END AS config_status,
               CASE WHEN leaf.last_seen_at >= now() - interval '90 seconds' THEN 'online'
                    WHEN leaf.last_seen_at >= now() - interval '10 minutes' THEN 'delayed'
                    ELSE 'offline' END AS connection_status
        FROM sync_leaf_node leaf
        LEFT JOIN canopy_leaf_assignment assignment ON assignment.leaf_id=leaf.leaf_id
        LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id=leaf.leaf_id
        WHERE {IN_SCOPE}
        ORDER BY coalesce(assignment.desired_config#>>'{location,hospitalName}', leaf.hospital_id),
                 assignment.desired_config#>>'{location,buildingName}',
                 assignment.desired_config#>>'{location,careUnitName}',
                 assignment.desired_config#>>'{location,roomName}',
                 coalesce(nullif(leaf.canopy_display_name,''),leaf.display_name), leaf.leaf_id
        """.replace("{IN_SCOPE}", IN_SCOPE),
        (scope, scope),
    ).fetchall()
    return {"rows": rows}


@router.get("/active-cases")
def active_cases(scope: list[str] | None = Depends(ward_scope), database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        """
        SELECT c.global_case_id, c.hospital_id, c.leaf_id,
               coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name,
               c.source_case_id, c.case_code, c.hn, c.status, c.start_time,
               c.discharge_time, c.last_synced_at,
               COALESCE(NULLIF(c.snapshot->'case'->>'admission_source', ''), 'unknown') AS admission_source,
               COALESCE(NULLIF(c.snapshot#>>'{patient,row,source}', ''),
                        NULLIF(c.snapshot->'case'->>'admission_source', ''), 'unknown') AS source_system,
               CASE WHEN l.last_seen_at >= now() - interval '90 seconds' THEN 'live'
                    WHEN l.last_seen_at >= now() - interval '10 minutes' THEN 'delayed'
                    ELSE 'offline' END AS sync_status
        FROM sync_case_index c
        JOIN sync_leaf_node l ON l.leaf_id = c.leaf_id
        LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id = c.leaf_id
        WHERE upper(c.status) = 'ACTIVE' AND {IN_SCOPE}
        ORDER BY c.start_time DESC NULLS LAST, c.last_synced_at DESC
        """.replace("{IN_SCOPE}", IN_SCOPE),
        (scope, scope),
    ).fetchall()
    return {"rows": rows}


@router.get("/cases")
def cases(
    status: str | None = Query(default=None, max_length=24),
    limit: int = Query(default=50, ge=1, le=500),
    scope: list[str] | None = Depends(ward_scope),
    database: Connection = Depends(connection),
) -> dict:
    normalized_status = str(status or "").strip().upper()
    if normalized_status and normalized_status not in {"ACTIVE", "DISCHARGED", "ARCHIVED"}:
        raise HTTPException(status_code=400, detail="invalid case status")
    rows = database.execute(
        """
        SELECT c.global_case_id, c.hospital_id, c.leaf_id,
               coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name,
               c.source_case_id, c.case_code, c.hn, c.status, c.start_time,
               c.discharge_time, c.last_synced_at,
               COALESCE(NULLIF(c.snapshot->'case'->>'admission_source', ''), 'unknown') AS admission_source,
               COALESCE(NULLIF(c.snapshot#>>'{patient,row,source}', ''),
                        NULLIF(c.snapshot->'case'->>'admission_source', ''), 'unknown') AS source_system,
               CASE WHEN l.last_seen_at >= now() - interval '90 seconds' THEN 'live'
                    WHEN l.last_seen_at >= now() - interval '10 minutes' THEN 'delayed'
                    ELSE 'offline' END AS sync_status
        FROM sync_case_index c
        JOIN sync_leaf_node l ON l.leaf_id = c.leaf_id
        LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id = c.leaf_id
        WHERE (%s = '' OR upper(c.status) = %s) AND {IN_SCOPE}
        ORDER BY c.last_synced_at DESC, c.start_time DESC NULLS LAST
        LIMIT %s
        """.replace("{IN_SCOPE}", IN_SCOPE),
        (normalized_status, normalized_status, scope, scope, limit),
    ).fetchall()
    return {"rows": rows}


@router.get("/cases/{global_case_id}/snapshot")
def case_snapshot(
    global_case_id: uuid.UUID,
    scope: list[str] | None = Depends(ward_scope),
    database: Connection = Depends(connection),
) -> dict:
    row = database.execute(
        """
        SELECT c.global_case_id, c.hospital_id, c.leaf_id,
               coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name,
               c.source_case_id, c.status, c.revision, c.last_synced_at, c.snapshot
        FROM sync_case_index c
        JOIN sync_leaf_node l ON l.leaf_id = c.leaf_id
        LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id = c.leaf_id
        WHERE c.global_case_id = %s AND {IN_SCOPE}
        """.replace("{IN_SCOPE}", IN_SCOPE),
        (global_case_id, scope, scope),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="synchronized case not found")
    return row
