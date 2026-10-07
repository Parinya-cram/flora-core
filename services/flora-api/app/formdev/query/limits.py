"""Per-process rate and concurrency limits (Phase 4.11). State lives in memory: it resets on
restart and is per process (documented). The database-backed job queue limit is the hard one."""
from __future__ import annotations

import math
import threading
import time
from contextlib import contextmanager
from typing import Callable, Iterator

from ..errors import FormDevError


class RateLimiter:
    """Token bucket per key: ``burst`` tokens, refilled at ``per_minute``/60 per second."""

    def __init__(self, per_minute: int, burst: int, clock: Callable[[], float] = time.monotonic, max_keys: int = 10_000):
        self.rate = per_minute / 60.0
        self.burst = burst
        self.clock = clock
        self.max_keys = max_keys
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def take(self, key: str, cost: float = 1.0) -> None:
        now = self.clock()
        with self._lock:
            tokens, stamp = self._buckets.get(key, (float(self.burst), now))
            tokens = min(self.burst, tokens + (now - stamp) * self.rate)
            if tokens < cost:
                # Rounded up: a client that waits Retry-After seconds is served (rounding down refused it again).
                retry = (cost - tokens) / self.rate if self.rate else 60
                self._buckets[key] = (tokens, now)
                raise FormDevError("rate_limited", "Too many queries; please wait a moment", 429, {"retry_after": max(1, math.ceil(retry))})
            self._buckets[key] = (tokens - cost, now)
            if len(self._buckets) > self.max_keys:
                full = [k for k, (t, s) in self._buckets.items() if min(self.burst, t + (now - s) * self.rate) >= self.burst]
                for k in full[: len(self._buckets) - self.max_keys + 1]:
                    del self._buckets[k]


class ConcurrencyLimiter:
    """Non-blocking slots: a request that cannot get one is refused at once (429), so it never
    waits for — or holds — a database connection."""

    def __init__(self, per_user: int, total: int):
        self.per_user = per_user
        self.total = total
        self._active: dict[str, int] = {}
        self._count = 0
        self._lock = threading.Lock()

    @contextmanager
    def slot(self, key: str) -> Iterator[None]:
        with self._lock:
            if self._count >= self.total or self._active.get(key, 0) >= self.per_user:
                raise FormDevError("too_many_concurrent_queries", "Other queries are still running; try again shortly", 429, {"retry_after": 1})
            self._active[key] = self._active.get(key, 0) + 1
            self._count += 1
        try:
            yield
        finally:
            with self._lock:
                self._count -= 1
                self._active[key] -= 1
                if not self._active[key]:
                    del self._active[key]

    def active(self) -> int:
        return self._count
