"""ICU shift handover: the automatic summary of one shift of a case (routes/shift_handover_leaf.py).

`summary(database, case_id, window)` is computed live while the handover is a draft and frozen into
case_shift_handover.summary when the outgoing person hands over. window = form_schedule.shift_window(...):
{code, label, start, end} in epoch ms, end exclusive. Sections:

    vitals       latest / min / max per main parameter over the shift (effective timeline: charted values
                 and overrides applied, masked readings left out)
    io           intake / output / net for the shift and the stay so far (to the shift end); per-item totals
    infusions    drips running at the shift end (or now): item, current rate / dose, since when
    events       event notes in the shift
    scores       latest result per score (at or before the shift end)
    forms        round-form slots of the shift that are due / overdue / skipped, overdue count of the case
    medications  only when app.med_orders exists (med_orders.handover_section(database, case_id, (start, end - 1)))
"""
from __future__ import annotations

import logging
from typing import Any

from psycopg import Connection

from . import form_schedule
from .routes.auth_leaf import now_ms
from .routes.case_workflow import case_row, entry_rows, form_slots, form_title, schedule_of
from .routes.cases_read import effective_minutes, finite_number, io_summary_data

log = logging.getLogger("flora.shift_handover")
MINUTE = 60_000
# vital_minutes keys (app/vitals_mapping.py) shown in the handover, in display order; et_co2 (ventilator) feeds etco2.
VITAL_KEYS = ("hr", "spo2", "nibp_sys", "nibp_dia", "nibp_map", "art_sys", "art_dia", "art_map", "rr", "temperature",
              "etco2", "cvp")
VITAL_ALIASES = {"et_co2": "etco2"}
FORM_STATUSES = ("due", "overdue", "skipped")
EVENT_LIMIT = 200


def summary(database: Connection, case_id: int, window: dict[str, Any]) -> dict[str, Any]:
    case = case_row(database, case_id)
    current = now_ms()
    start = int(window["start"])
    last_minute = int(window["end"]) - MINUTE  # inclusive minute bounds for the case reads
    out: dict[str, Any] = {"generated_at": current, "window": window,
                           "vitals": vitals(database, case_id, start, last_minute),
                           "io": io(database, case, start, last_minute),
                           "infusions": infusions(database, case_id, start, min(int(window["end"]), current)),
                           "events": events(database, case_id, start, last_minute),
                           "scores": scores(database, case_id, last_minute),
                           "forms": forms(database, case, start, int(window["end"]), current)}
    try:
        from . import med_orders  # type: ignore[attr-defined]  # ICU medication orders / MAR, when installed
    except ImportError:
        med_orders = None
    if (med_orders is not None and hasattr(med_orders, "handover_section")
            and database.execute("SELECT to_regclass('case_med_order') AS t").fetchone()["t"] is not None):
        try:
            with database.transaction():  # a savepoint: a Leaf without the medication tables keeps the rest
                # (from, to) inclusive, the form med_orders.window_bounds takes.
                out["medications"] = med_orders.handover_section(database, case_id, (start, int(window["end"]) - 1))
        except Exception:  # noqa: BLE001
            log.exception("medication section of the shift handover failed (case %s)", case_id)
    return out


def vitals(database: Connection, case_id: int, from_ts: int, to_ts: int) -> list[dict[str, Any]]:
    """[{key, latest, latest_at, min, max, count}] for the VITAL_KEYS that have numbers in the shift."""
    by_minute, _provenance, _masked, _masks = effective_minutes(database, case_id, from_ts, to_ts)
    stats: dict[str, dict[str, Any]] = {}
    for ts in sorted(by_minute):
        payload = by_minute[ts]
        if not isinstance(payload, dict):
            continue
        for raw_key, raw in payload.items():
            key = VITAL_ALIASES.get(raw_key, raw_key)
            value = finite_number(raw) if key in VITAL_KEYS and not isinstance(raw, bool) else None
            if value is None:
                continue
            entry = stats.setdefault(key, {"key": key, "min": value, "max": value, "count": 0})
            entry.update(latest=value, latest_at=ts, min=min(entry["min"], value), max=max(entry["max"], value),
                         count=entry["count"] + 1)
    return [stats[key] for key in VITAL_KEYS if key in stats]


def io_totals(totals: dict[str, Any]) -> dict[str, Any]:
    return {key: totals[key] for key in ("intake_ml", "output_ml", "net_ml", "urine_output_ml", "blood_loss_ml")}


def io(database: Connection, case: dict[str, Any], from_ts: int, to_ts: int) -> dict[str, Any]:
    """Shift and stay-so-far balance; the same totals as GET /io/summary (a 1-day bucket only keeps it cheap)."""
    shift = io_summary_data(database, case["id"], from_ts, to_ts, 1440)["totals"]
    stay_from = (int(case.get("start_time") or case.get("created_at") or from_ts) // MINUTE) * MINUTE
    stay = io_summary_data(database, case["id"], min(stay_from, from_ts), to_ts, 1440)["totals"]
    return {"shift": io_totals(shift), "stay": io_totals(stay), "stay_from": stay_from, "items": shift["item_totals_ml"]}


def infusions(database: Connection, case_id: int, from_ts: int, at: int) -> list[dict[str, Any]]:
    """Drips running at `at` (the shift end, or now while the shift is current): the current segment's rate / dose."""
    runs = database.execute(
        """SELECT r.id, r.kind, r.route, r.started_at, r.stopped_at, r.note, i.code AS item_code, i.name AS item_name,
                  i.default_unit AS item_unit
           FROM case_io_run r JOIN io_item_master i ON i.id = r.item_id
           WHERE r.case_id=%s AND r.entry_mode='drip' AND r.kind IN ('med','fluid') AND r.started_at <= %s
             AND (r.stopped_at IS NULL OR r.stopped_at > %s)
           ORDER BY r.started_at, r.id""", (case_id, at, at)).fetchall()
    if not runs:
        return []
    segments = database.execute(
        """SELECT DISTINCT ON (run_id) run_id, ts_from, rate_value, rate_unit, dose_value, dose_unit
           FROM case_io_segment WHERE run_id = ANY(%s) AND ts_from <= %s ORDER BY run_id, ts_from DESC, id DESC""",
        ([run["id"] for run in runs], at)).fetchall()
    current = {segment["run_id"]: segment for segment in segments}
    out = []
    for run in runs:
        segment = current.get(run["id"]) or {}
        out.append({"run_id": run["id"], "kind": run["kind"], "item_code": run["item_code"], "item_name": run["item_name"],
                    "item_unit": run["item_unit"], "route": run["route"], "note": run["note"],
                    "started_at": run["started_at"], "rate_since": segment.get("ts_from"),
                    "rate_value": finite_number(segment.get("rate_value")), "rate_unit": segment.get("rate_unit"),
                    "dose_value": finite_number(segment.get("dose_value")), "dose_unit": segment.get("dose_unit"),
                    "started_in_shift": run["started_at"] >= from_ts})
    return out


def events(database: Connection, case_id: int, from_ts: int, to_ts: int) -> list[dict[str, Any]]:
    rows = database.execute(
        """SELECT id, event_ts, event_type, title, detail, created_by FROM case_event_note
           WHERE case_id=%s AND is_deleted=0 AND event_ts BETWEEN %s AND %s ORDER BY event_ts, id LIMIT %s""",
        (case_id, from_ts, to_ts, EVENT_LIMIT)).fetchall()
    return [dict(row) for row in rows]


def scores(database: Connection, case_id: int, to_ts: int) -> list[dict[str, Any]]:
    """Latest result per score at or before the shift end (a manual result wins a tie with the automatic one)."""
    if database.execute("SELECT to_regclass('case_score_result') AS t").fetchone()["t"] is None:
        return []
    rows = database.execute(
        """SELECT DISTINCT ON (score_id) score_id, ts, source, total, band, level, partial
           FROM case_score_result WHERE case_id=%s AND ts <= %s ORDER BY score_id, ts DESC, source DESC""",
        (case_id, to_ts + MINUTE - 1)).fetchall()
    names = score_names(database, case_id)
    return [{"score_id": row["score_id"], "name": names.get(row["score_id"]) or row["score_id"], "ts": row["ts"],
             "source": row["source"], "total": finite_number(row["total"]), "band": row["band"], "level": row["level"],
             "partial": row["partial"]} for row in rows]


def score_names(database: Connection, case_id: int) -> dict[str, str]:
    from . import score_writer, scoring
    try:
        case = database.execute("SELECT id, workflow FROM cases WHERE id=%s", (case_id,)).fetchone()
        definitions = score_writer.case_scores(database, case)
        return {score_id: scoring.normalize(definition)["name"] for score_id, definition in definitions.items()}
    except Exception:  # noqa: BLE001 - names are cosmetic; the id is shown instead
        return {}


def forms(database: Connection, case: dict[str, Any], start: int, end: int, current: int) -> dict[str, Any]:
    """Round-form slots of the shift still open (due / overdue) or skipped, and the overdue total of the case."""
    workflow = case.get("workflow") or {}
    scheduled = [entry for entry in workflow.get("forms") or [] if isinstance(entry, dict) and schedule_of(entry)]
    if not scheduled or database.execute("SELECT to_regclass('case_form_entry') AS t").fetchone()["t"] is None:
        return {"slots": [], "overdue_total": 0}
    timezone = form_schedule.timezone_of(database)
    rows = entry_rows(database, case["id"])
    slots, overdue_total = [], 0
    for entry in scheduled:
        slot_list = form_slots(case, entry, [row for row in rows if row["form_id"] == entry["form_id"]], current, timezone)
        overdue_total += form_schedule.summary(slot_list)["overdue"]
        title = form_title(database, workflow, entry)
        slots.extend({"form_id": entry["form_id"], "title": title, "slot_ts": slot["slot_ts"], "label": slot["label"],
                      "status": slot["status"], "skip_reason": slot["skipReason"]}
                     for slot in slot_list if start <= slot["slot_ts"] < end and slot["status"] in FORM_STATUSES)
    slots.sort(key=lambda slot: (slot["slot_ts"], slot["title"]))
    return {"slots": slots, "overdue_total": overdue_total}
