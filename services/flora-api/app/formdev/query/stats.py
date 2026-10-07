"""Query usage statistics by shape (no values), aggregated in memory and flushed in batches.
Best effort: a failing flush is logged and never affects queries (Phase 4.6 advisor input)."""
from __future__ import annotations

import logging
import threading
from typing import Any, Callable

LOG = logging.getLogger("formdev.query")
OUTCOMES = ("ok", "timeouts", "rejected")


class StatsCollector:
    def __init__(self, clock_ms: Callable[[], int], max_shapes: int = 1000):
        self.clock_ms = clock_ms
        self.max_shapes = max_shapes
        self._rows: dict[str, dict[str, Any]] = {}
        self._dropped = 0
        self._lock = threading.Lock()

    def record(self, fingerprint: str, source_id: str, shape: dict[str, Any], outcome: str, ms: int, rows: int) -> None:
        now = self.clock_ms()
        with self._lock:
            row = self._rows.get(fingerprint)
            if row is None:
                if len(self._rows) >= self.max_shapes:
                    self._dropped += 1
                    return
                row = self._rows[fingerprint] = {"fingerprint": fingerprint, "source_id": source_id, "shape": shape, "runs": 0, "ok": 0,
                                                 "timeouts": 0, "rejected": 0, "total_ms": 0, "max_ms": 0, "rows_returned": 0,
                                                 "first_run_at": now, "last_run_at": now}
            row["runs"] += 1
            row[outcome if outcome in OUTCOMES else "rejected"] += 1
            row["total_ms"] += int(ms)
            row["max_ms"] = max(row["max_ms"], int(ms))
            row["rows_returned"] += int(rows)
            row["last_run_at"] = now

    def drain(self) -> tuple[list[dict[str, Any]], int]:
        with self._lock:
            rows, dropped = list(self._rows.values()), self._dropped
            self._rows, self._dropped = {}, 0
        return rows, dropped

    def flush(self, write: Callable[[list[dict[str, Any]]], None]) -> int:
        rows, dropped = self.drain()
        if dropped:
            LOG.warning("formdev query stats: %d query shapes dropped (cap %d)", dropped, self.max_shapes)
        if not rows:
            return 0
        try:
            write(rows)
        except Exception:  # noqa: BLE001 - statistics must never break queries
            LOG.warning("formdev query stats flush failed; %d shapes discarded", len(rows), exc_info=True)
            return 0
        return len(rows)
