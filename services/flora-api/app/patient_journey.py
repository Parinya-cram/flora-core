"""Patient journey: the earlier cases of the same admission (AN) on other Leafs — e.g. OR → Recovery → ICU.

Built on Canopy from each case's full export (`canopy_case_export`, sent by every Leaf). Medications are
the point: like an ICU round, the next team sees what was given before and, above all, which infusions
were still running when the patient left that case (**continuing**) — a transfer or discharge stops them
on that chart at the hand-off time, so "running at the end" means stopped at (or after) the case end.
"""
from __future__ import annotations

from typing import Any

from psycopg import Connection

HANDOFF_SLACK_MS = 60_000  # stop times are rounded to the chart minute
MED_KINDS = ("med", "fluid")


def _stage(case: dict[str, Any], unit_name: str | None) -> str:
    stage = case.get("or_stage")
    if stage in ("or", "or_recovery"):
        return "OR · Anesthesia"
    if stage == "recovery":
        return "Recovery · Post-Anesthesia"
    return unit_name or "Ward"


def _names(database: Connection, codes: set[str]) -> dict[str, dict[str, Any]]:
    if not codes:
        return {}
    rows = database.execute("SELECT code, name, kind, default_unit FROM io_item_master WHERE code = ANY(%s)",
                            (sorted(codes),)).fetchall()
    return {row["code"]: row for row in rows}


def summarize(database: Connection, export: dict[str, Any]) -> dict[str, Any]:
    case = export.get("case") or {}
    tables = export.get("tables") or {}
    item_codes = export.get("items") or {}
    names = _names(database, {code for code in item_codes.values() if code})

    def item(item_id: Any) -> dict[str, Any]:
        code = item_codes.get(str(item_id))
        found = names.get(code or "") or {}
        return {"code": code, "name": found.get("name") or code or f"item {item_id}", "kind": found.get("kind"),
                "unit": found.get("default_unit")}

    active = case.get("status") == "active"
    end = case.get("discharge_time")
    segments: dict[Any, list[dict[str, Any]]] = {}
    for segment in tables.get("case_io_segment") or []:
        segments.setdefault(segment.get("run_id"), []).append(segment)

    infusions = []
    for run in tables.get("case_io_run") or []:
        if run.get("kind") not in MED_KINDS or run.get("entry_mode") != "drip":
            continue
        last = max(segments.get(run.get("id")) or [{}], key=lambda row: row.get("ts_from") or 0)
        stopped = run.get("stopped_at")
        if active:
            state = "running" if stopped is None else "stopped"
        else:
            # Running when the patient left this case: continues on the next one.
            state = "continuing" if stopped is None or (end and stopped >= end - HANDOFF_SLACK_MS) else "stopped"
        infusions.append({
            **item(run.get("item_id")), "route": run.get("route"), "note": run.get("note"),
            "started_at": run.get("started_at"), "stopped_at": stopped, "state": state,
            "rate_value": last.get("rate_value"), "rate_unit": last.get("rate_unit"),
            "dose_value": last.get("dose_value"), "dose_unit": last.get("dose_unit"),
        })
    order = {"continuing": 0, "running": 0, "stopped": 1}
    infusions.sort(key=lambda row: (order[row["state"]], -(row.get("started_at") or 0)))

    doses = sorted(({**item(event.get("item_id")), "at": event.get("event_ts"), "dose_value": event.get("dose_value"),
                     "dose_unit": event.get("dose_unit"), "volume_ml": event.get("volume_ml"), "note": event.get("note")}
                    for event in tables.get("case_io_event") or [] if event.get("kind") in MED_KINDS),
                   key=lambda row: -(row.get("at") or 0))

    events = sorted(({"at": row.get("event_ts"), "title": row.get("title"), "detail": row.get("detail"),
                      "type": row.get("event_type")}
                     for row in tables.get("case_event_note") or [] if not row.get("is_deleted")),
                    key=lambda row: row.get("at") or 0)
    vitals = tables.get("vital_minutes") or []
    latest = max(vitals, key=lambda row: row.get("ts_minute") or 0) if vitals else None
    patient = (tables.get("case_his_patient") or [{}])[0]
    allergies = sorted({row.get("allergen") for key in ("case_his_allergy", "case_allergy")
                        for row in tables.get(key) or [] if row.get("allergen")})
    return {
        "case_code": case.get("case_code"), "status": case.get("status"), "or_stage": case.get("or_stage"),
        "start_time": case.get("start_time"), "end_time": end, "discharge_reason": case.get("discharge_reason"),
        "discharge_destination": case.get("discharge_destination"),
        "workflow": (case.get("workflow") or {}).get("name") if isinstance(case.get("workflow"), dict) else None,
        "weight_kg": patient.get("weight_kg"), "allergies": allergies,
        "infusions": infusions, "doses": doses[:100], "events": events[-200:],
        "latest_vitals": {"at": latest.get("ts_minute"), "values": latest.get("payload")} if latest else None,
    }


def journey(database: Connection, admission_number: str, exclude_leaf_id: str, exclude_case_id: str) -> list[dict[str, Any]]:
    """Every other case of this AN, oldest first, with where it was and its medication summary."""
    an = (admission_number or "").strip()
    if not an:
        return []
    rows = database.execute(
        """SELECT e.global_case_id, e.leaf_id, e.source_case_id, e.export,
                  coalesce(nullif(n.canopy_display_name,''), n.display_name, e.leaf_id) AS leaf_name,
                  unit.name AS unit_name
           FROM canopy_case_export e
           LEFT JOIN sync_leaf_node n ON n.leaf_id = e.leaf_id
           LEFT JOIN canopy_leaf_unit lu ON lu.leaf_id = e.leaf_id
           LEFT JOIN canopy_location unit ON unit.id::text = lu.unit_key
           WHERE trim(e.export->'case'->>'admission_number') = %s
             AND NOT (e.leaf_id = %s AND e.source_case_id = %s)
           ORDER BY (e.export->'case'->>'start_time')::bigint NULLS LAST""",
        (an, exclude_leaf_id, str(exclude_case_id))).fetchall()
    out = []
    for row in rows:
        summary = summarize(database, row["export"] or {})
        out.append({"global_case_id": str(row["global_case_id"]), "leaf_name": row["leaf_name"], "unit_name": row["unit_name"],
                    "stage": _stage((row["export"] or {}).get("case") or {}, row["unit_name"]), **summary})
    return out
