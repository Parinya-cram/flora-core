"""Canopy ICU KPIs and bundle compliance per ward and period (tables: migration 0102, projection: app/icu_kpi.py).

    GET /api/fleet/icu-kpis?from&to&unit_key
    GET /api/fleet/bundle-compliance?from&to&unit_key[&bundle_id][&count_missed]

`from` / `to` are local dates (YYYY-MM-DD, both inclusive) or epoch ms; default the last 30 days. Ward scope as
the other /api/fleet reads: the x-flora-ward header / the user's wards; `unit_key` narrows it further.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection

from .. import form_schedule, icu_bundles, icu_kpi
from ..database import connection
from .auth_canopy import read_token
from .fleet_read import _patient_name, _record, fleet_scope

router = APIRouter(prefix="/api/fleet", tags=["canopy-icu-kpi"], dependencies=[Depends(read_token)])

DAY = 86_400_000
# Unit scope of a row with a unit_key column (alias k): as fleet_read.IN_SCOPE, demo wards only when selected.
IN_SCOPE = ("((%s::text[] IS NULL AND NOT coalesce(scope_unit.is_demo, false)) OR k.unit_key = ANY(%s))")


def account_timezone(database: Connection) -> str:
    row = database.execute("""SELECT desired_config->>'timezone' AS tz FROM canopy_leaf_assignment
                              WHERE desired_config ? 'timezone' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1""").fetchone()
    return str(form_schedule.zone(row["tz"]).key) if row and row["tz"] else form_schedule.DEFAULT_TIMEZONE


def bound(value: str | None, tz: str, end: bool) -> int | None:
    if not value:
        return None
    if value.strip().lstrip("-").isdigit():
        return int(value)
    try:
        day = date.fromisoformat(value.strip()[:10])
    except ValueError:
        raise HTTPException(400, f"'{value}' is not a date (YYYY-MM-DD) or epoch ms")
    day += timedelta(days=1) if end else timedelta()
    return int(datetime(day.year, day.month, day.day, tzinfo=form_schedule.zone(tz)).timestamp() * 1000)


def period(start: str | None, finish: str | None, tz: str) -> tuple[int, int]:
    """[from, to) in epoch ms; `to` date is inclusive. Default: the last 30 days up to today."""
    now = icu_kpi.now_ms()
    period_to = bound(finish, tz, True) or bound(icu_kpi.to_date(now, tz).isoformat(), tz, True)
    period_from = bound(start, tz, False) or period_to - 30 * DAY
    if period_from >= period_to:
        raise HTTPException(400, "from must be before to")
    if period_to - period_from > 400 * DAY:
        raise HTTPException(400, "the period is limited to 400 days")
    return period_from, period_to


def units(scope: list[str] | None, unit_key: str | None) -> list[str] | None:
    if not unit_key or unit_key == "all":
        return scope
    if scope is not None and unit_key not in scope:
        raise HTTPException(403, "you are not assigned to this ward")
    return [unit_key]


def unit_names(database: Connection) -> dict[str, str]:
    return {row["key"]: row["name"] for row in
            database.execute("SELECT id::text AS key, name FROM canopy_location WHERE kind='care_unit'").fetchall()}


def bed_counts(database: Connection) -> dict[str, int]:
    rows = database.execute(
        """SELECT u.unit_key, count(DISTINCT b.bed_location_id) AS beds
           FROM canopy_leaf_unit u
           JOIN (SELECT leaf_id, bed_location_id FROM canopy_leaf_assignment
                 UNION SELECT leaf_id, bed_location_id FROM canopy_leaf_bed) b ON b.leaf_id=u.leaf_id
           GROUP BY u.unit_key""").fetchall()
    return {row["unit_key"]: int(row["beds"]) for row in rows}


@router.get("/icu-kpis")
def icu_kpis(start: str | None = Query(default=None, alias="from"), finish: str | None = Query(default=None, alias="to"),
             unit_key: str | None = None, scope: list[str] | None = Depends(fleet_scope),
             database: Connection = Depends(connection)) -> dict[str, Any]:
    tz = account_timezone(database)
    period_from, period_to = period(start, finish, tz)
    allowed = units(scope, unit_key)
    now = icu_kpi.now_ms()
    rows = database.execute(
        f"""SELECT k.*,
                   k.readmission_48h OR EXISTS (
                     SELECT 1 FROM canopy_case_kpi p WHERE p.hn=k.hn AND p.global_case_id<>k.global_case_id
                       AND p.unit_key IS NOT DISTINCT FROM k.unit_key
                       AND p.discharged_at < k.admitted_at AND p.discharged_at >= k.admitted_at - 48 * 3600000) AS readmitted
            FROM canopy_case_kpi k
            LEFT JOIN canopy_location scope_unit ON scope_unit.id::text = k.unit_key
            WHERE k.admitted_at < %s AND coalesce(k.discharged_at, %s) >= %s AND {IN_SCOPE}""",
        (period_to, now, period_from, allowed, allowed)).fetchall()
    for row in rows:
        row["readmission_48h"] = row.pop("readmitted")
    beds = bed_counts(database)
    names = unit_names(database)
    keys = sorted({row["unit_key"] for row in rows if row["unit_key"]} | set(allowed or []))
    total_beds = sum(beds.get(key, 0) for key in keys)  # wards in view with ICU cases (all wards: those with cases)
    by_unit = [{"unit_key": key, "unit_name": names.get(key, key),
                **icu_kpi.kpi_summary([row for row in rows if row["unit_key"] == key], period_from, period_to, now,
                                      beds.get(key) or None)} for key in keys]
    return {"from": period_from, "to": period_to, "timezone": tz, "server_time": now, "units": allowed,
            "kpis": icu_kpi.kpi_summary(rows, period_from, period_to, now, total_beds or None), "by_unit": by_unit}


@router.get("/bundle-compliance")
def bundle_compliance(start: str | None = Query(default=None, alias="from"), finish: str | None = Query(default=None, alias="to"),
                      unit_key: str | None = None, bundle_id: str | None = None,
                      count_missed: bool = Query(default=icu_bundles.COUNT_MISSED),
                      scope: list[str] | None = Depends(fleet_scope),
                      database: Connection = Depends(connection)) -> dict[str, Any]:
    if bundle_id and bundle_id not in icu_bundles.BY_ID:
        raise HTTPException(400, f"unknown bundle '{bundle_id}'")
    tz = account_timezone(database)
    period_from, period_to = period(start, finish, tz)
    allowed = units(scope, unit_key)
    rows = database.execute(
        f"""SELECT k.global_case_id::text AS global_case_id, k.bundle_id, k.slot_ts, k.shift_code, k.stay_day, k.status,
                   k.applicable, k.compliant, k.missed, k.missing, k.unit_key, k.leaf_id, k.hn
            FROM canopy_bundle_entry k
            LEFT JOIN canopy_location scope_unit ON scope_unit.id::text = k.unit_key
            WHERE k.slot_ts >= %s AND k.slot_ts < %s AND (%s::text IS NULL OR k.bundle_id = %s) AND {IN_SCOPE}""",
        (period_from, period_to, bundle_id, bundle_id, allowed, allowed)).fetchall()
    result = icu_kpi.compliance_summary(rows, tz, count_missed, lowest=10)
    ids = [case["global_case_id"] for case in result["lowest_cases"]]
    if ids:
        names = unit_names(database)
        for row in database.execute(
                """SELECT global_case_id::text AS id, case_code, status, start_time, discharge_time,
                          snapshot->'patient'->'row' AS patient
                   FROM sync_case_index WHERE global_case_id = ANY(%s::uuid[])""", (ids,)).fetchall():
            for case in result["lowest_cases"]:
                if case["global_case_id"] == row["id"]:
                    case.update(case_code=row["case_code"], status=row["status"], start_time=row["start_time"],
                                discharge_time=row["discharge_time"], unit_name=names.get(case["unit_key"] or ""),
                                patient_name=_patient_name(_record(row["patient"]), case["hn"]))
    return {"from": period_from, "to": period_to, "timezone": tz, "units": allowed, "count_missed": count_missed,
            "bundle_id": bundle_id, **result}
