"""Leaf: ICU shift handover (migration 0099, app/shift_handover.py).

One record per case, shift and role (nurse / doctor), keyed by the shift start (form_schedule.shift_window on the
case workflow's shifts and the Leaf's time zone). Flow: draft (ISBAR + plan, autosaved by anyone with case.chart)
→ handed (the outgoing person; the summary is frozen) → accepted (the incoming person, a different user).

Editing rules: a draft is shared; a handed record can still be edited by the person who handed it, until it is
accepted (the frozen summary stays as handed; only the text changes); an accepted record is read-only.
Archived cases are read-only.
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import form_schedule, shift_handover
from ..clinical import case_audit
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .case_workflow import case_row, case_start
from .cases_lifecycle import editable_case

router = APIRouter(prefix="/api/case", tags=["shift handover"])
TEXT_FIELDS = ("identify", "situation", "background", "assessment", "recommendation", "plan")
TEXT_MAX = 20_000


def window_at(database: Connection, case: dict[str, Any], ts: int, offset: int = 0) -> dict[str, Any]:
    """The shift window of the case's workflow at ts, with the stay day and whether it is the current shift."""
    timezone = form_schedule.timezone_of(database)
    workflow = case.get("workflow") or {}
    window = form_schedule.shift_window(ts, form_schedule.workflow_shifts(workflow), timezone, offset)
    current = now_ms()
    return {**window, "timezone": timezone, "is_current": window["start"] <= current < window["end"],
            "day": form_schedule.stay_day(window["start"], case_start(case), form_schedule.zone(timezone),
                                          form_schedule.workflow_day_start(workflow))}


def public(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": str(row["id"]), "case_id": row["case_id"], "shift_start": row["shift_start"],
            "shift_end": row["shift_end"], "shift_code": row["shift_code"], "role": row["role"], "status": row["status"],
            **{name: row[name] or "" for name in TEXT_FIELDS}, "summary": row["summary"],
            "handed_by": row["handed_by"], "handed_at": row["handed_at"], "accepted_by": row["accepted_by"],
            "accepted_at": row["accepted_at"], "created_by": row["created_by"], "created_at": row["created_at"],
            "updated_by": row["updated_by"], "updated_at": row["updated_at"]}


def texts(row: dict[str, Any]) -> dict[str, Any]:
    return {name: row.get(name) for name in TEXT_FIELDS}


def handover_row(database: Connection, case_id: int, handover_id: uuid.UUID) -> dict[str, Any]:
    row = database.execute("SELECT * FROM case_shift_handover WHERE id=%s AND case_id=%s FOR UPDATE",
                           (handover_id, case_id)).fetchone()
    if row is None:
        raise HTTPException(404, "shift handover not found")
    return row


@router.get("/{case_id}/shift-handover/summary")
def handover_summary(case_id: int, at: int | None = Query(None, gt=0),
                     shift: Literal["current", "previous"] = "current",
                     _: dict = Depends(require_permission("case.read")),
                     database: Connection = Depends(connection)) -> dict[str, Any]:
    """{window, summary}: the live summary of the shift at `at` (default now), or of the shift before it."""
    case = case_row(database, case_id)
    window = window_at(database, case, at or now_ms(), -1 if shift == "previous" else 0)
    return {"window": window, "summary": shift_handover.summary(database, case_id, window)}


@router.get("/{case_id}/shift-handovers")
def list_handovers(case_id: int, _: dict = Depends(require_permission("case.read")),
                   database: Connection = Depends(connection)) -> dict[str, Any]:
    """Every handover of the case, newest shift first (also the sync worker snapshot)."""
    case_row(database, case_id)
    if database.execute("SELECT to_regclass('case_shift_handover') AS t").fetchone()["t"] is None:
        return {"handovers": []}  # Leaf database without migration 0099 yet
    rows = database.execute("SELECT * FROM case_shift_handover WHERE case_id=%s ORDER BY shift_start DESC, role",
                            (case_id,)).fetchall()
    return {"handovers": [public(row) for row in rows]}


class HandoverSave(BaseModel):
    shift_start: int = Field(gt=0)
    role: Literal["nurse", "doctor"]
    identify: str | None = Field(None, max_length=TEXT_MAX)
    situation: str | None = Field(None, max_length=TEXT_MAX)
    background: str | None = Field(None, max_length=TEXT_MAX)
    assessment: str | None = Field(None, max_length=TEXT_MAX)
    recommendation: str | None = Field(None, max_length=TEXT_MAX)
    plan: str | None = Field(None, max_length=TEXT_MAX)


@router.put("/{case_id}/shift-handovers")
def save_handover(case_id: int, payload: HandoverSave, actor: dict = Depends(require_permission("case.chart")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    """Upsert the ISBAR text + plan of (shift_start, role); only the fields sent are changed."""
    with database.transaction():
        case = editable_case(database, case_id)
        window = window_at(database, case, payload.shift_start)
        if window["start"] != payload.shift_start:
            raise HTTPException(400, f"{payload.shift_start} is not the start of a shift")
        current = now_ms()
        if window["start"] > current:
            raise HTTPException(400, "the shift has not started yet")
        changes = payload.model_dump(include=set(TEXT_FIELDS), exclude_unset=True)
        created = database.execute(
            """INSERT INTO case_shift_handover (case_id, shift_start, shift_end, shift_code, role, status, created_by,
                                                created_at, updated_by, updated_at)
               VALUES (%s,%s,%s,%s,%s,'draft',%s,%s,%s,%s) ON CONFLICT (case_id, shift_start, role) DO NOTHING RETURNING id""",
            (case_id, window["start"], window["end"], window["code"], payload.role, actor["username"], current,
             actor["username"], current)).fetchone()
        row = database.execute("SELECT * FROM case_shift_handover WHERE case_id=%s AND shift_start=%s AND role=%s FOR UPDATE",
                               (case_id, window["start"], payload.role)).fetchone()
        if row["status"] == "accepted":
            raise HTTPException(409, "this handover was accepted and is read-only")
        if row["status"] == "handed" and row["handed_by"] != actor["username"]:
            raise HTTPException(409, f"handed over by {row['handed_by']}; only they can edit it until it is accepted")
        if not changes:
            if created is not None:
                case_audit(database, case_id, f"shift_handover.create:{payload.role}", None,
                           {"id": str(row["id"]), "shift_start": row["shift_start"], "status": "draft"}, actor)
            return {"handover": public(row)}
        values = {**texts(row), **changes}
        saved = database.execute(
            f"""UPDATE case_shift_handover SET {', '.join(f'{name}=%s' for name in TEXT_FIELDS)}, updated_by=%s, updated_at=%s
                WHERE id=%s RETURNING *""",
            (*[values[name] for name in TEXT_FIELDS], actor["username"], current, row["id"])).fetchone()
        case_audit(database, case_id, f"shift_handover.save:{payload.role}",
                   {"id": str(row["id"]), "shift_start": row["shift_start"], "status": row["status"], **texts(row)},
                   {"id": str(row["id"]), "shift_start": row["shift_start"], "status": saved["status"], **texts(saved)},
                   actor)
    return {"handover": public(saved)}


@router.post("/{case_id}/shift-handovers/{handover_id}/hand")
def hand_over(case_id: int, handover_id: uuid.UUID, actor: dict = Depends(require_permission("case.chart")),
              database: Connection = Depends(connection)) -> dict[str, Any]:
    """The outgoing person hands over: the summary of the shift is frozen into the record."""
    with database.transaction():
        case = editable_case(database, case_id)
        row = handover_row(database, case_id, handover_id)
        if row["status"] != "draft":
            raise HTTPException(409, f"this handover is already {row['status']}")
        # The record's own bounds win if the workflow's shifts were changed since the draft was made.
        window = {**window_at(database, case, row["shift_start"]), "code": row["shift_code"], "start": row["shift_start"],
                  "end": row["shift_end"]}
        frozen = shift_handover.summary(database, case_id, window)
        current = now_ms()
        saved = database.execute(
            """UPDATE case_shift_handover SET status='handed', summary=%s, handed_by=%s, handed_at=%s, updated_by=%s,
                 updated_at=%s WHERE id=%s RETURNING *""",
            (Jsonb(frozen, dumps=lambda value: json.dumps(value, default=str)), actor["username"], current, actor["username"], current, handover_id)).fetchone()
        case_audit(database, case_id, f"shift_handover.hand:{row['role']}",
                   {"id": str(handover_id), "shift_start": row["shift_start"], "status": row["status"]},
                   {"id": str(handover_id), "shift_start": row["shift_start"], "status": "handed", **texts(saved)}, actor)
    return {"handover": public(saved)}


@router.post("/{case_id}/shift-handovers/{handover_id}/accept")
def accept_handover(case_id: int, handover_id: uuid.UUID, actor: dict = Depends(require_permission("case.chart")),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    """The incoming person accepts; it must be someone other than the person who handed over."""
    with database.transaction():
        editable_case(database, case_id)
        row = handover_row(database, case_id, handover_id)
        if row["status"] != "handed":
            raise HTTPException(409, "only a handed-over record can be accepted" if row["status"] == "draft"
                                else "this handover is already accepted")
        if row["handed_by"] == actor["username"]:
            raise HTTPException(409, "the incoming person must accept, not the person who handed over")
        current = now_ms()
        saved = database.execute(
            """UPDATE case_shift_handover SET status='accepted', accepted_by=%s, accepted_at=%s, updated_by=%s,
                 updated_at=%s WHERE id=%s RETURNING *""",
            (actor["username"], current, actor["username"], current, handover_id)).fetchone()
        case_audit(database, case_id, f"shift_handover.accept:{row['role']}",
                   {"id": str(handover_id), "shift_start": row["shift_start"], "status": row["status"]},
                   {"id": str(handover_id), "shift_start": row["shift_start"], "status": "accepted"}, actor)
    return {"handover": public(saved)}
