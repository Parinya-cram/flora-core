"""Leaf: clinical scores of a case (see app/scoring.py, app/score_writer.py)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import Connection
from pydantic import BaseModel

from .. import scoring, score_writer
from ..clinical import case_audit
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .cases_lifecycle import editable_case
from .cases_read import get_case_range_row, resolve_case_range

router = APIRouter(prefix="/api/case", tags=["scores"])


class EvaluateInput(BaseModel):
    ts: int | None = None
    values: dict[str, Any] = {}
    save: bool = False


def case_or_404(database: Connection, case_id: int) -> dict[str, Any]:
    row = database.execute("SELECT id, status, start_time, discharge_time, workflow FROM cases WHERE id=%s",
                           (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    return row


@router.get("/scores/status")
def status(_: dict = Depends(require_permission("case.read"))) -> dict[str, Any]:
    writer = score_writer.score_writer
    return {"enabled": writer.enabled, "intervalSeconds": writer.interval, **writer.state}


@router.get("/{case_id}/scores")
def case_scores(case_id: int, request: Request, _: dict = Depends(require_permission("case.read")),
                database: Connection = Depends(connection)) -> dict[str, Any]:
    """The case's score definitions and results in the requested range (default: the whole case)."""
    case = case_or_404(database, case_id)
    from_ts, to_ts = resolve_case_range(get_case_range_row(database, case_id), request)
    if database.execute("SELECT to_regclass('case_score_result') AS t").fetchone()["t"] is None:
        return {"case_id": case_id, "from": from_ts, "to": to_ts, "definitions": [], "rows": []}  # not migrated yet
    definitions = score_writer.case_scores(database, case)
    rows = database.execute(
        """SELECT * FROM case_score_result WHERE case_id=%s AND ts BETWEEN %s AND %s ORDER BY ts, score_id, source""",
        (case_id, from_ts, to_ts)).fetchall() if definitions or _has_results(database, case_id) else []
    return {"case_id": case_id, "from": from_ts, "to": to_ts,
            "definitions": [score_writer.summary(sid, definition) for sid, definition in definitions.items()],
            "rows": [score_writer.public_row(row) for row in rows]}


def _has_results(database: Connection, case_id: int) -> bool:
    return database.execute("SELECT 1 FROM case_score_result WHERE case_id=%s LIMIT 1", (case_id,)).fetchone() is not None


@router.post("/{case_id}/scores/{score_id}/evaluate")
def evaluate(case_id: int, score_id: str, payload: EvaluateInput, actor: dict = Depends(require_permission("case.chart")),
             database: Connection = Depends(connection)) -> dict[str, Any]:
    """Run a score now (or at `ts`) from the chart plus values given by the clinician; with
    `save` the result is kept as a manual result of that time."""
    case = editable_case(database, case_id) if payload.save else case_or_404(database, case_id)
    definition = score_writer.case_scores(database, case).get(score_id)
    if definition is None:
        raise HTTPException(404, f"score '{score_id}' is not used by this case's workflow")
    score = scoring.normalize(definition)
    current = now_ms()
    ts = int(payload.ts) if payload.ts is not None else current // 60_000 * 60_000
    if ts < int(case["start_time"]) - 3_600_000 or ts > current + 60_000:
        raise HTTPException(422, "time is outside the case")
    lookback = score_writer._lookback_ms(score)
    minutes = score_writer._minutes(database, case_id, ts - lookback, ts)
    result = scoring.evaluate_at(score, minutes, ts, payload.values)
    version = int(score.get("version") or 0)
    saved = None
    if payload.save:
        if result["total"] is None:
            raise HTTPException(422, "the score is incomplete: " + ", ".join(result["missing"]))
        score_writer.store(database, case_id, score_id, version, ts, result, "manual", actor["username"])
        row = database.execute("SELECT * FROM case_score_result WHERE case_id=%s AND score_id=%s AND ts=%s AND source='manual'",
                               (case_id, score_id, ts)).fetchone()
        saved = score_writer.public_row(row)
        case_audit(database, case_id, "score.record", None,
                   {"score_id": score_id, "version": version, "ts": ts, "total": result["total"], "band": result["band"]}, actor)
    return {"score_id": score_id, "score_version": version, "ts": ts, **result, "saved": saved}


@router.post("/{case_id}/scores/recalculate")
def recalculate(case_id: int, _: dict = Depends(require_permission("case.chart")),
                database: Connection = Depends(connection)) -> dict[str, Any]:
    """Recompute the automatic scores over the whole case (e.g. after editing old readings)."""
    case = editable_case(database, case_id)
    return {"written": score_writer.compute_case(database, case)}


@router.delete("/{case_id}/scores/results/{result_id}")
def delete_manual(case_id: int, result_id: int, actor: dict = Depends(require_permission("case.chart")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    editable_case(database, case_id)
    row = database.execute("DELETE FROM case_score_result WHERE id=%s AND case_id=%s AND source='manual' RETURNING *",
                           (result_id, case_id)).fetchone()
    if row is None:
        raise HTTPException(404, "manual score result not found")
    case_audit(database, case_id, "score.delete", score_writer.public_row(row), None, actor)
    return {"ok": True}
