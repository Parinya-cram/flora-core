"""Leaf: Patient Journey of a case — the other cases of the same admission (AN) on other Leafs (OR → Recovery
→ ICU), read from Canopy, so the receiving team sees earlier orders and which infusions continue."""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from psycopg import Connection

from ..database import connection
from .auth_leaf import require_permission

router = APIRouter(prefix="/api/case", tags=["patient journey"])


@router.get("/{case_id}/journey")
def case_journey(case_id: int, _: dict = Depends(require_permission("case.read")),
                 database: Connection = Depends(connection)) -> dict[str, Any]:
    from .ward import canopy
    case = database.execute(
        """SELECT c.id, c.start_time, coalesce(nullif(trim(c.admission_number), ''), nullif(trim(p.an), '')) AS an
           FROM cases c LEFT JOIN case_his_patient p ON p.case_id = c.id WHERE c.id=%s""", (case_id,)).fetchone()
    if case is None:
        raise HTTPException(404, "case not found")
    if not case["an"]:
        return {"an": None, "cases": [], "reason": "This case has no AN, so it cannot be linked to other cases."}
    try:
        result = canopy("POST", "/api/sync/v1/journey",
                        {"leaf_id": os.getenv("FLORA_LEAF_ID", ""), "case_id": str(case_id), "admission_number": case["an"]})
    except HTTPException as error:
        return {"an": case["an"], "cases": [], "reason": str(error.detail)}
    cases = result.get("cases") or []
    before = [row for row in cases if (row.get("start_time") or 0) <= (case["start_time"] or 0)]
    # What the previous case handed over: infusions running when the patient left it.
    continuing = [{**row, "from_stage": before[-1]["stage"], "from_leaf": before[-1]["leaf_name"]}
                  for row in (before[-1]["infusions"] if before else []) if row.get("state") in ("continuing", "running")]
    return {"an": case["an"], "cases": cases, "continuing": continuing}
