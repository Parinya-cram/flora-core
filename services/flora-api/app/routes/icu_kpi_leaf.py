"""ICU bundle compliance of one case, Leaf side (bundles: app/icu_bundles.py; slots: docs/ICU-ROUNDS.md)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from psycopg import Connection

from .. import form_schedule, icu_bundles
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .case_workflow import case_end, case_row, case_start, entry_rows

router = APIRouter(prefix="/api/case", tags=["icu kpi"])


@router.get("/{case_id}/bundle-compliance")
def bundle_compliance(case_id: int, days: int = Query(default=7, ge=1, le=31),
                      count_missed: bool = Query(default=icu_bundles.COUNT_MISSED),
                      _: dict = Depends(require_permission("case.read")),
                      database: Connection = Depends(connection)) -> dict[str, Any]:
    """Per bundle of the case's workflow: applicable, compliant, %, missed slots, the last `days` days,
    today's slots (stay day of now) and the most common missing items."""
    case = case_row(database, case_id)
    workflow = case["workflow"] or {}
    timezone = form_schedule.timezone_of(database)
    current = now_ms()
    has_entries = database.execute("SELECT to_regclass('case_form_entry') AS t").fetchone()["t"] is not None
    entries = [{**row, "id": str(row["id"])} for row in entry_rows(database, case_id)] if has_entries else []
    start = case_start(case)
    rows = icu_bundles.case_rows(workflow, entries, start, case_end(case), current, timezone, include_upcoming=True)
    return {"case_id": case_id, "timezone": timezone, "generated_at": current, "count_missed": count_missed,
            "bundles": icu_bundles.case_compliance(workflow, rows, start, current, timezone, days, count_missed)}
