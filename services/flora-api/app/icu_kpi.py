"""Canopy ICU KPIs: project each ICU case snapshot into canopy_bundle_entry and canopy_case_kpi (migration 0102).

    project_case(database, leaf_id, hospital_id, global_case_id, snapshot, revision=None)   # sync ingest
    docker exec flora-canopy-sync-api-1 python -m app.icu_kpi backfill [account]         # existing cases

Bundle rows come from snapshot `workflow_entries` plus the slots of the case's scheduled forms, which Canopy
computes itself from snapshot `workflow` (schedule, day_start, shifts), the case span and the Leaf's time zone
(canopy_leaf_assignment.desired_config.timezone). So overdue slots without an entry are projected as "missed"
rows (entry_id 'slot-<form_id>-<slot_ts>') and the snapshot needs no slot list. Slots still in their grace
window are not stored; an active case is re-projected with each snapshot.

KPI row sources: case header (start / discharge), canopy_admission (AN, discharge destination), the single-record
forms icu_discharge (destination, mv_days, complications), icu_lines_devices (device days) and
critical_icu_ventilator (intubated / extubated, re-intubation < 48 h), then ventilator bindings
(canopy_gateway_case_binding × canopy_medical_device) for ventilator days. readmission_48h is set here best
effort and recomputed by the KPI query (routes/icu_kpi_canopy.py).

Only ICU cases are projected: a workflow with an ICU form, or a Leaf in a care unit named like "ICU". A case
continued elsewhere (handover source, archived without discharge) is removed, so a stay counts once.
"""
from __future__ import annotations

import logging
import sys
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any, Iterable

from . import form_schedule, icu_bundles

LOG = logging.getLogger("flora.icu_kpi")
HOUR = 3_600_000
CENTRAL_LINES = ("cvc", "picc", "hd")
URINARY = ("foley",)
AIRWAY = ("ett", "trach")
ICU_FORMS = {"icu_admission", "icu_daily_round", "icu_lines_devices", "icu_discharge", "critical_icu_ventilator",
             "critical_icu_vap_check", "critical_icu_sofa", "neuro_icu_brain_bundle", "neuro_icu_assessment"}
if TYPE_CHECKING:  # psycopg is imported where the database is used, so the pure helpers test without it
    from psycopg import Connection
DEATH_WORDS = ("death", "dead", "died", "expired", "deceased")


def now_ms() -> int:
    return int(datetime.now().timestamp() * 1000)


# ---------------------------------------------------------------- pure helpers

def to_date(value: Any, tz_name: str | None) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return form_schedule.local(int(value), form_schedule.zone(tz_name)).date()
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def to_ms(value: Any, tz_name: str | None) -> int | None:
    """Epoch ms of an epoch number or an ISO datetime (no offset: the Leaf's time zone)."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=form_schedule.zone(tz_name))
    return int(moment.timestamp() * 1000)


def device_days(items: Any, kinds: Iterable[str], start: int, end: int, tz_name: str | None) -> int | None:
    """Calendar days within the stay with at least one device of `kinds` in place (removal day included).
    None when the lines form has no device list."""
    if not isinstance(items, list) or not items:
        return None
    first, last = to_date(start, tz_name), to_date(end, tz_name)
    days: set[date] = set()
    for device in items:
        if not isinstance(device, dict) or device.get("device") not in kinds:
            continue
        inserted = to_date(device.get("inserted_on"), tz_name)
        if inserted is None:
            continue
        removed = to_date(device.get("removed_on"), tz_name) or last
        day = max(inserted, first)
        while day <= min(removed, last):
            days.add(day)
            day += timedelta(days=1)
    return len(days)


def form_data(forms: dict[str, Any], form_id: str) -> dict[str, Any]:
    form = (forms or {}).get(form_id)
    data = form.get("data") if isinstance(form, dict) else None
    return data if isinstance(data, dict) else {}


def number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def case_kpi(case: dict[str, Any], forms: dict[str, Any], tz_name: str | None, now: int | None = None,
             vent_binding_hours: float | None = None, admission: dict[str, Any] | None = None) -> dict[str, Any]:
    """The canopy_case_kpi values of one case (without ids / unit)."""
    now = now or now_ms()
    admission = admission or {}
    start = int(case.get("start_time") or case.get("created_at") or now)
    discharged = int(case["discharge_time"]) if case.get("discharge_time") else None
    end = discharged or now
    discharge = form_data(forms, "icu_discharge")
    lines = form_data(forms, "icu_lines_devices").get("items")
    vent = form_data(forms, "critical_icu_ventilator")
    complications = discharge.get("complications") if isinstance(discharge.get("complications"), list) else []
    destination = discharge.get("destination") or admission.get("discharge_destination") or case.get("discharge_reason")
    died = (str(discharge.get("mrs") or "") == "6"
            or any(word in str(destination or "").lower() for word in DEATH_WORDS))
    vent_days = number(discharge.get("mv_days"))
    if vent_days is None:
        vent_days = number(vent.get("mv_days"))
    if vent_days is None and to_ms(vent.get("intubated_at"), tz_name):
        until = to_ms(vent.get("extubated_at"), tz_name) or end
        vent_days = round(max(0, until - to_ms(vent.get("intubated_at"), tz_name)) / (24 * HOUR), 1)
    if vent_days is None:
        vent_days = device_days(lines, AIRWAY, start, end, tz_name)
    if vent_days is None and vent_binding_hours:
        vent_days = round(vent_binding_hours / 24, 1)
    return {
        "admission_number": admission.get("admission_number") or case.get("admission_number"),
        "admitted_at": start, "discharged_at": discharged,
        "los_hours": round((discharged - start) / HOUR, 1) if discharged else None,
        "destination": destination, "died": died, "vent_days": vent_days,
        "central_line_days": device_days(lines, CENTRAL_LINES, start, end, tz_name),
        "urinary_catheter_days": device_days(lines, URINARY, start, end, tz_name),
        "vap": "vap" in complications, "clabsi": "clabsi" in complications, "cauti": "cauti" in complications,
        "pressure_injury": "pressure" in complications,
        "reintubation_48h": "reintubation" in complications or icu_bundles.ticked(vent.get("reintubated_48h")),
    }


def export_entries(export: dict[str, Any] | None) -> list[dict[str, Any]]:
    """case_form_entry rows of a canopy_case_export in the snapshot `workflow_entries` shape."""
    rows = ((export or {}).get("tables") or {}).get("case_form_entry") or []
    return [{"id": str(r.get("id")), "form_id": r.get("form_id"), "slot_ts": r.get("slot_ts"), "status": r.get("status"),
             "data": r.get("data") or {}} for r in rows if isinstance(r, dict)]


def export_forms(export: dict[str, Any] | None) -> dict[str, Any]:
    rows = ((export or {}).get("tables") or {}).get("case_form_record") or []
    return {r["form_id"]: {"data": r.get("data") or {}, "status": r.get("status")}
            for r in rows if isinstance(r, dict) and r.get("form_id")}


def is_icu_case(workflow: dict[str, Any] | None, unit_name: str | None) -> bool:
    forms = {str(f.get("form_id")) for f in (workflow or {}).get("forms") or [] if isinstance(f, dict)}
    return bool(forms & ICU_FORMS) or "icu" in str(unit_name or "").lower()


# ---------------------------------------------------------------- period summaries (routes/icu_kpi_canopy.py)

def overlap_hours(start: int | None, end: int | None, period_from: int, period_to: int) -> float:
    if start is None:
        return 0.0
    return max(0, min(end if end is not None else period_to, period_to) - max(start, period_from)) / HOUR


def ratio(numerator: float, denominator: float, scale: float = 1.0, digits: int = 2) -> float | None:
    return round(scale * numerator / denominator, digits) if denominator else None


def median(values: list[float]) -> float | None:
    values = sorted(values)
    if not values:
        return None
    middle = len(values) // 2
    return values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2


def kpi_summary(rows: list[dict[str, Any]], period_from: int, period_to: int, now: int, beds: int | None = None) -> dict[str, Any]:
    """KPIs of canopy_case_kpi rows whose stay overlaps [period_from, period_to).

    Census (patient-days) and device utilization are prorated to the part of each stay inside the period
    (a case's device days × its in-period share of the stay). Outcomes (LOS, mortality, device-associated
    infections, re-intubation) count the cases discharged in the period; infection rates are per 1000 device
    days of those same cases. Readmission < 48 h counts admissions in the period."""
    until = min(period_to, now)
    admitted = [r for r in rows if r.get("admitted_at") is not None and period_from <= r["admitted_at"] < period_to]
    discharged = [r for r in rows if r.get("discharged_at") is not None and period_from <= r["discharged_at"] < period_to]
    patient_hours = 0.0
    device = {"vent_days": 0.0, "central_line_days": 0.0, "urinary_catheter_days": 0.0}
    for r in rows:
        inside = overlap_hours(r.get("admitted_at"), r.get("discharged_at"), period_from, until)
        patient_hours += inside
        # Device days cover the whole stay (to discharge, or to now while active).
        stay = max(0, (r.get("discharged_at") or now) - (r.get("admitted_at") or now)) / HOUR
        share = min(1.0, inside / stay) if stay else 0.0
        for key in device:
            device[key] += float(r.get(key) or 0) * share
    patient_days = patient_hours / 24
    los_days = [float(r["los_hours"]) / 24 for r in discharged if r.get("los_hours") is not None]
    out_device = {key: sum(float(r.get(key) or 0) for r in discharged) for key in device}
    ventilated = [r for r in discharged if float(r.get("vent_days") or 0) > 0]
    period_days = max(0.0, (until - period_from) / (24 * HOUR))
    return {
        "cases": len(rows), "admissions": len(admitted), "discharges": len(discharged),
        "patient_days": round(patient_days, 1),
        "alos_days": round(sum(los_days) / len(los_days), 1) if los_days else None,
        "median_los_days": round(median(los_days), 1) if los_days else None,
        "deaths": sum(1 for r in discharged if r.get("died")),
        "mortality_pct": ratio(sum(1 for r in discharged if r.get("died")), len(discharged), 100, 1),
        "vent_days": round(device["vent_days"], 1),
        "central_line_days": round(device["central_line_days"], 1),
        "urinary_catheter_days": round(device["urinary_catheter_days"], 1),
        "vent_utilization": ratio(device["vent_days"], patient_days),
        "central_line_utilization": ratio(device["central_line_days"], patient_days),
        "urinary_catheter_utilization": ratio(device["urinary_catheter_days"], patient_days),
        "vap": sum(1 for r in discharged if r.get("vap")),
        "clabsi": sum(1 for r in discharged if r.get("clabsi")),
        "cauti": sum(1 for r in discharged if r.get("cauti")),
        "pressure_injury": sum(1 for r in discharged if r.get("pressure_injury")),
        "vap_rate": ratio(sum(1 for r in discharged if r.get("vap")), out_device["vent_days"], 1000),
        "clabsi_rate": ratio(sum(1 for r in discharged if r.get("clabsi")), out_device["central_line_days"], 1000),
        "cauti_rate": ratio(sum(1 for r in discharged if r.get("cauti")), out_device["urinary_catheter_days"], 1000),
        "readmission_48h_pct": ratio(sum(1 for r in admitted if r.get("readmission_48h")), len(admitted), 100, 1),
        "reintubation_48h_pct": ratio(sum(1 for r in ventilated if r.get("reintubation_48h")), len(ventilated), 100, 1),
        "beds": beds,
        "bed_occupancy_pct": ratio(patient_days, beds * period_days, 100, 1) if beds and period_days else None,
    }


def week_start(ts: int, tz_name: str | None) -> str:
    day = to_date(ts, tz_name)
    return (day - timedelta(days=day.weekday())).isoformat()


def compliance_summary(rows: list[dict[str, Any]], tz_name: str | None, count_missed: bool = icu_bundles.COUNT_MISSED,
                       lowest: int = 10) -> dict[str, Any]:
    """canopy_bundle_entry rows ({bundle_id, slot_ts, shift_code, applicable, compliant, missed, missing,
    global_case_id, ...}) → per bundle (with weekly trend and per shift), most missed items, lowest cases."""
    weeks = sorted({week_start(r["slot_ts"], tz_name) for r in rows if r.get("slot_ts") is not None})
    bundles = []
    for bundle in icu_bundles.BUNDLES:
        mine = [r for r in rows if r["bundle_id"] == bundle["id"]]
        if not mine:
            continue
        shifts = sorted({r.get("shift_code") for r in mine if r.get("shift_code")})
        bundles.append({**icu_bundles.public_bundle(bundle), **icu_bundles.tally(mine, count_missed),
                        "cases": len({r["global_case_id"] for r in mine}),
                        "weekly": [{"week": w, **icu_bundles.tally([r for r in mine if r.get("slot_ts") is not None
                                                                    and week_start(r["slot_ts"], tz_name) == w], count_missed)}
                                   for w in weeks],
                        "by_shift": [{"shift": s, **icu_bundles.tally([r for r in mine if r.get("shift_code") == s], count_missed)}
                                     for s in shifts],
                        "top_missing": icu_bundles.top_missing(mine, bundle["id"], 5, count_missed)})
    by_case: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_case.setdefault(str(r["global_case_id"]), []).append(r)
    cases = []
    for gcid, mine in by_case.items():
        result = icu_bundles.tally(mine, count_missed)
        if result["applicable"]:
            first = mine[0]
            cases.append({"global_case_id": gcid, "hn": first.get("hn"), "unit_key": first.get("unit_key"),
                          "leaf_id": first.get("leaf_id"), "case_code": first.get("case_code"),
                          "patient_name": first.get("patient_name"), **result,
                          "bundles": sorted({r["bundle_id"] for r in mine})})
    cases.sort(key=lambda c: (c["pct"], -c["applicable"]))
    overall = icu_bundles.tally(rows, count_missed)
    return {"overall": overall, "weeks": weeks, "bundles": bundles,
            "top_missing": icu_bundles.top_missing(rows, None, 10, count_missed), "lowest_cases": cases[:lowest]}


# ---------------------------------------------------------------- projection

def leaf_context(database: Connection, leaf_id: str) -> dict[str, Any]:
    row = database.execute(
        """SELECT u.unit_key, u.unit_name, a.desired_config->>'timezone' AS timezone
           FROM (SELECT %s::text AS leaf_id) l
           LEFT JOIN canopy_leaf_unit u ON u.leaf_id=l.leaf_id
           LEFT JOIN canopy_leaf_assignment a ON a.leaf_id=l.leaf_id""", (leaf_id,)).fetchone() or {}
    return {"unit_key": row.get("unit_key"), "unit_name": row.get("unit_name"),
            "timezone": row.get("timezone") or form_schedule.DEFAULT_TIMEZONE}


def vent_binding_hours(database: Connection, global_case_id: str, end: int) -> float | None:
    row = database.execute(
        """SELECT sum(extract(epoch FROM coalesce(b.unbound_at, to_timestamp(%s / 1000.0)) - b.bound_at)) / 3600 AS hours
           FROM canopy_gateway_case_binding b
           JOIN canopy_medical_device d ON d.gateway_id=b.gateway_id AND d.gateway_device_id=b.device_id
           WHERE b.case_uuid=%s AND (d.device_type ILIKE '%%vent%%' OR d.category ILIKE '%%vent%%')""",
        (end, global_case_id)).fetchone()
    return float(row["hours"]) if row and row["hours"] is not None else None


def superseded(database: Connection, gcid: str, case: dict[str, Any]) -> bool:
    """Handed over to another Leaf (canopy_case_handover), or archived without a discharge (the Leaf archives
    the source of a take-over; the copy that continues it keeps the start time)."""
    if str(case.get("status") or "").lower() == "archived" and not case.get("discharge_time"):
        return True
    return database.execute(
        "SELECT 1 FROM canopy_case_handover WHERE global_case_id=%s AND status IN ('claimed','imported','released') LIMIT 1",
        (gcid,)).fetchone() is not None


def project_case(database: Connection, leaf_id: str, hospital_id: str, global_case_id: Any, snapshot: dict[str, Any],
                 revision: int | None = None, export: dict[str, Any] | None = None) -> int:
    """Upsert the case's bundle rows and KPI row; returns the bundle rows written. Never raises (logged).

    `revision`: skip when sync_case_index already holds a newer snapshot. `export`: a canopy_case_export
    payload filling in what an older snapshot lacks (backfill)."""
    try:
        with database.transaction():
            return _project(database, leaf_id, str(global_case_id), snapshot or {}, revision, export)
    except Exception as error:  # never fail the ingest
        LOG.warning("ICU KPI projection of case %s failed: %s: %s", global_case_id, type(error).__name__, error)
        return 0


def _project(database: Connection, leaf_id: str, gcid: str, snapshot: dict[str, Any], revision: int | None,
             export: dict[str, Any] | None) -> int:
    from psycopg.types.json import Jsonb
    if revision is not None:
        held = database.execute("SELECT revision FROM sync_case_index WHERE global_case_id=%s", (gcid,)).fetchone()
        if held and int(held["revision"]) > revision:
            return 0
    case = {**((export or {}).get("case") or {}), **(snapshot.get("case") or {})}
    workflow = snapshot.get("workflow") or (export or {}).get("case", {}).get("workflow")
    context = leaf_context(database, leaf_id)
    if not is_icu_case(workflow, context["unit_name"]):
        return 0
    if superseded(database, gcid, case):
        # Continued on another Leaf / case (handover, transfer): the continuation carries the stay.
        database.execute("DELETE FROM canopy_bundle_entry WHERE global_case_id=%s", (gcid,))
        database.execute("DELETE FROM canopy_case_kpi WHERE global_case_id=%s", (gcid,))
        return 0
    entries = snapshot.get("workflow_entries")
    if not entries and export:
        entries = export_entries(export)
    forms = {**export_forms(export), **(snapshot.get("workflow_forms") or {})}
    current = now_ms()
    tz = context["timezone"]
    start = int(case.get("start_time") or case.get("created_at") or current)
    discharge = int(case["discharge_time"]) if case.get("discharge_time") else None
    if discharge is None and str(case.get("status") or "").lower() in ("discharged", "archived"):
        discharge = current
    hn = case.get("hn")
    rows = [r for r in icu_bundles.case_rows(workflow, entries or [], start, discharge, current, tz) if r["status"] not in ("pending", "upcoming")]
    for r in rows:
        database.execute(
            """INSERT INTO canopy_bundle_entry (global_case_id, form_id, entry_id, bundle_id, slot_ts, shift_code, stay_day,
                 status, applicable, compliant, missed, missing, unit_key, leaf_id, hn, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (global_case_id, entry_id, bundle_id) DO UPDATE SET form_id=excluded.form_id,
                 slot_ts=excluded.slot_ts, shift_code=excluded.shift_code, stay_day=excluded.stay_day, status=excluded.status,
                 applicable=excluded.applicable, compliant=excluded.compliant, missed=excluded.missed, missing=excluded.missing,
                 unit_key=coalesce(canopy_bundle_entry.unit_key, excluded.unit_key), leaf_id=excluded.leaf_id, hn=excluded.hn,
                 updated_at=excluded.updated_at
               WHERE (canopy_bundle_entry.status, canopy_bundle_entry.applicable, canopy_bundle_entry.compliant,
                      canopy_bundle_entry.missed, canopy_bundle_entry.missing, canopy_bundle_entry.slot_ts,
                      canopy_bundle_entry.unit_key, canopy_bundle_entry.hn)
                 IS DISTINCT FROM (excluded.status, excluded.applicable, excluded.compliant, excluded.missed,
                      excluded.missing, excluded.slot_ts, coalesce(canopy_bundle_entry.unit_key, excluded.unit_key), excluded.hn)""",
            (gcid, r["form_id"], r["entry_id"], r["bundle_id"], r["slot_ts"], r["shift"], r["day"], r["status"],
             r["applicable"], r["compliant"], r["missed"], Jsonb(r["missing"]), context["unit_key"], leaf_id, hn, current))
    # Rows no longer produced (a missed slot that now has an entry, a removed form) go.
    database.execute("DELETE FROM canopy_bundle_entry WHERE global_case_id=%s AND NOT (entry_id || '|' || bundle_id = ANY(%s))",
                     (gcid, [f"{r['entry_id']}|{r['bundle_id']}" for r in rows]))
    admission = database.execute(
        "SELECT admission_number, discharge_destination FROM canopy_admission WHERE global_case_id=%s ORDER BY updated_at DESC LIMIT 1",
        (gcid,)).fetchone()
    kpi = case_kpi(case, forms, tz, current, vent_binding_hours(database, gcid, discharge or current), admission)
    readmitted = bool(hn) and database.execute(
        """SELECT 1 FROM canopy_case_kpi WHERE hn=%s AND global_case_id<>%s AND unit_key IS NOT DISTINCT FROM %s
             AND discharged_at < %s AND discharged_at >= %s - 48 * 3600000 LIMIT 1""",
        (hn, gcid, context["unit_key"], kpi["admitted_at"], kpi["admitted_at"])).fetchone() is not None
    columns = ["hn", "admission_number", "unit_key", "leaf_id", "admitted_at", "discharged_at", "los_hours", "destination",
               "died", "vent_days", "central_line_days", "urinary_catheter_days", "vap", "clabsi", "cauti",
               "pressure_injury", "reintubation_48h", "readmission_48h", "updated_at"]
    values = {**kpi, "hn": hn, "unit_key": context["unit_key"], "leaf_id": leaf_id, "readmission_48h": readmitted,
              "updated_at": current}
    database.execute(
        f"""INSERT INTO canopy_case_kpi (global_case_id, {', '.join(columns)}) VALUES (%s, {', '.join(['%s'] * len(columns))})
            ON CONFLICT (global_case_id) DO UPDATE SET
              {', '.join(f'{c}=excluded.{c}' for c in columns if c != 'unit_key')},
              unit_key=coalesce(canopy_case_kpi.unit_key, excluded.unit_key)""",
        (gcid, *[values[c] for c in columns]))
    return len(rows)


# ---------------------------------------------------------------- backfill CLI

def backfill(database: Connection) -> tuple[int, int]:
    """Re-project every case of the current account from sync_case_index (+ canopy_case_export)."""
    cases = database.execute(
        """SELECT i.global_case_id, i.hospital_id, i.leaf_id, i.revision, i.snapshot, e.export
           FROM sync_case_index i LEFT JOIN canopy_case_export e ON e.global_case_id=i.global_case_id
           ORDER BY i.start_time NULLS FIRST""").fetchall()
    rows = 0
    for case in cases:
        rows += project_case(database, case["leaf_id"], case["hospital_id"], case["global_case_id"],
                             case["snapshot"] or {}, None, case["export"])
    return len(cases), rows


def main(argv: list[str]) -> int:
    if not argv or argv[0] != "backfill":
        print("usage: python -m app.icu_kpi backfill [account]", file=sys.stderr)
        return 2
    from . import tenancy
    from .database import open_pool, pool
    open_pool()
    accounts = [None]
    if tenancy.MULTI_ACCOUNT:
        accounts = [tenancy.by_code(argv[1])] if len(argv) > 1 else tenancy.accounts()
        if None in accounts:
            print(f"no active account '{argv[1]}'", file=sys.stderr)
            return 1
    for account in accounts:
        token = tenancy.set_current(account)
        try:
            with pool.connection() as database:
                cases, rows = backfill(database)
            print(f"{account.code if account else 'default'}: {cases} case(s), {rows} bundle row(s)")
        finally:
            tenancy.reset_current(token)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sys.exit(main(sys.argv[1:]))
