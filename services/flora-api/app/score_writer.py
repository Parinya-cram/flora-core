"""Leaf: computes the clinical scores of active cases into case_score_result (see app/scoring.py).

Runs in the Leaf API process next to the device writer. Each pass evaluates every `auto`
score of the case's workflow at its interval boundaries from the effective timeline (charted
values and overrides applied, masked readings left out). The first pass for a case covers the
whole stay; later passes the last few hours, so late entries, edits and masks are picked up.
A stored result is rewritten only by the same score version, so results keep the version
that produced them.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from . import scoring
from .database import pool

LOG = logging.getLogger("flora.scores")
HOUR_MS = 3_600_000


def now_ms() -> int:
    return int(time.time() * 1000)


def case_scores(database: Connection, case: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """{score_id: definition} for a case: the scores of its workflow, newest copy this Leaf holds
    (else the copy taken at the case start); a case without a workflow uses the ward's default."""
    from .routes.case_workflow import cached_items, workflow_state
    workflow = case.get("workflow") if isinstance(case.get("workflow"), dict) else None
    if workflow is None:
        items, _forms, _synced = cached_items(database)
        workflow = next((item["definition"] for item in items if item.get("isDefault")), None)
    cached = workflow_state(database)["payload"].get("scores") or {}
    bundled = (workflow or {}).get("bundled_scores") or {}
    result = {}
    for score_id in scoring.score_ids_of(workflow):
        definition = cached.get(score_id) if isinstance(cached.get(score_id), dict) else bundled.get(score_id)
        if isinstance(definition, dict):
            result[score_id] = definition
    return result


def _minutes(database: Connection, case_id: int, from_ts: int, to_ts: int) -> dict[int, dict[str, Any]]:
    from .routes.cases_read import effective_minutes
    by_minute, _provenance, _masked, _masks = effective_minutes(database, case_id, from_ts, to_ts)
    return by_minute


def _lookback_ms(score: dict[str, Any]) -> int:
    windows = [float(entry.get("window_min") or 0) for entry in score["inputs"].values() if entry.get("source") == "param"]
    return int(max(windows, default=0) * 60_000)


def store(database: Connection, case_id: int, score_id: str, version: int, ts: int, result: dict[str, Any],
          source: str, actor: str | None) -> bool:
    """Upsert one result; True when a row was written."""
    current = now_ms()
    row = database.execute(
        """INSERT INTO case_score_result (case_id, score_id, score_version, ts, source, total, band, level, partial,
                                          items, inputs, missing, flags, created_by, created_at, updated_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (case_id, score_id, ts, source) DO UPDATE SET
             score_version=excluded.score_version, total=excluded.total, band=excluded.band, level=excluded.level,
             partial=excluded.partial, items=excluded.items, inputs=excluded.inputs, missing=excluded.missing,
             flags=excluded.flags, created_by=excluded.created_by, updated_at=excluded.updated_at
           WHERE (excluded.source = 'manual' OR case_score_result.score_version = excluded.score_version)
             AND (case_score_result.total, case_score_result.items, case_score_result.inputs, case_score_result.flags,
                  case_score_result.created_by)
                 IS DISTINCT FROM (excluded.total, excluded.items, excluded.inputs, excluded.flags, excluded.created_by)
           RETURNING id""",
        (case_id, score_id, version, ts, source, result["total"], result["band"], result["level"], result["partial"],
         Jsonb(result["items"]), Jsonb(result.get("inputs") or {}), result["missing"], Jsonb(result["flags"]),
         actor, current, current)).fetchone()
    return row is not None


def compute_case(database: Connection, case: dict[str, Any], from_ts: int | None = None) -> int:
    """Evaluate the auto scores of a case from `from_ts` (default: the case start) to now
    or its discharge. Returns the number of rows written."""
    scores = {sid: scoring.normalize(definition) for sid, definition in case_scores(database, case).items()}
    scores = {sid: score for sid, score in scores.items() if score["mode"] == "auto"}
    if not scores:
        return 0
    start = int(case["start_time"])
    end = min(now_ms(), int(case["discharge_time"])) if case.get("discharge_time") else now_ms()
    begin = max(start, from_ts) if from_ts is not None else start
    lookback = max(_lookback_ms(score) for score in scores.values())
    minutes = _minutes(database, case["id"], begin - lookback, end)
    written = 0
    for score_id, score in scores.items():
        version = int(score.get("version") or 0)
        stale = []
        for ts in scoring.slots(score, begin, end):
            if ts < start:
                continue
            result = scoring.evaluate_at(score, minutes, ts)
            if not result["inputs"] or all(item["points"] is None for item in result["items"]):
                stale.append(ts)  # nothing charted: no result (a masked reading can empty a slot)
                continue
            written += store(database, case["id"], score_id, version, ts, result, "auto", None)
        if stale:
            database.execute(
                """DELETE FROM case_score_result WHERE case_id=%s AND score_id=%s AND source='auto'
                   AND score_version=%s AND ts = ANY(%s)""", (case["id"], score_id, version, stale))
    return written


class ScoreWriter:
    def __init__(self):
        self.enabled = os.getenv("FLORA_SCORE_WRITER_ENABLED", "true").lower() == "true"
        self.interval = max(10.0, float(os.getenv("SCORE_WRITER_INTERVAL_SECONDS", "60")))
        self.recent_ms = int(float(os.getenv("SCORE_WRITER_RECENT_HOURS", "6")) * HOUR_MS)
        self.seen: set[int] = set()
        self.state: dict[str, Any] = {"lastTickTs": None, "lastError": None, "written": 0}
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if not self.enabled or self.thread:
            return
        self.thread = threading.Thread(target=self._loop, name="flora-score-writer", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)
        self.thread = None

    def _loop(self) -> None:
        while not self.stop_event.wait(self.interval):
            try:
                self.tick()
                self.state["lastError"] = None
            except Exception as error:  # keep running; reported by /api/case/scores/status
                self.state["lastError"] = f"{type(error).__name__}: {error}"
                LOG.warning("score pass failed: %s", self.state["lastError"])
            self.state["lastTickTs"] = now_ms()

    def tick(self) -> None:
        with pool.connection() as database:
            if database.execute("SELECT to_regclass('case_score_result') AS t").fetchone()["t"] is None:
                return
            cases = database.execute(
                "SELECT id, start_time, discharge_time, workflow FROM cases WHERE status='active'").fetchall()
            for case in cases:
                first = case["id"] not in self.seen
                with database.transaction():
                    self.state["written"] += compute_case(database, case, None if first else now_ms() - self.recent_ms)
                self.seen.add(case["id"])
            self.seen &= {case["id"] for case in cases}


score_writer = ScoreWriter()


def public_row(row: dict[str, Any]) -> dict[str, Any]:
    total = row["total"]
    return {"id": row["id"], "score_id": row["score_id"], "score_version": int(row["score_version"]), "ts": int(row["ts"]),
            "source": row["source"], "total": None if total is None else (int(total) if total == int(total) else float(total)),
            "band": row["band"], "level": row["level"], "partial": row["partial"], "items": row["items"],
            "inputs": row["inputs"], "missing": list(row["missing"] or []), "flags": row["flags"],
            "created_by": row["created_by"], "updated_at": int(row["updated_at"])}


def summary(score_id: str, definition: dict[str, Any]) -> dict[str, Any]:
    """What the chart and the run dialog need from a definition."""
    score = scoring.normalize(definition)
    options = {item["input"]: item.get("options") for item in score["items"] if item.get("input") and item.get("options")}
    return {"id": score_id, "name": score["name"], "description": score["description"], "reference": score["reference"],
            "version": int(score.get("version") or 0), "mode": score["mode"], "interval_min": score["interval_min"],
            "bands": score["bands"],
            "items": [{"key": item["key"], "label": item["label"], "input": item.get("input")} for item in score["items"]],
            "inputs": [{"key": key, "label": entry["label"], "source": entry["source"], "type": entry["type"],
                        "param": entry.get("param"), "unit": entry.get("unit"), "default": entry.get("default"),
                        "options": options.get(key)} for key, entry in score["inputs"].items()]}

