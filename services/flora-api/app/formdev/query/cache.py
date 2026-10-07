"""In-process query result cache (Phase 4.8): TTL + LRU, bounded by entries and bytes.

Keys include the per-form change counters read inside the query's own transaction, so a write
in any process makes older entries unreachable; local invalidation also evicts them eagerly.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Callable


class QueryCache:
    def __init__(self, max_entries: int = 500, max_bytes: int = 20 * 1024 * 1024, clock: Callable[[], float] | None = None):
        import time

        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.clock = clock or time.monotonic
        self._items: OrderedDict[str, tuple[float, int, set[str], Any]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> Any | None:
        with self._lock:
            item = self._items.get(key)
            if item is None or item[0] < self.clock():
                if item is not None:
                    self._drop(key)
                self.misses += 1
                return None
            self._items.move_to_end(key)
            self.hits += 1
            return item[3]

    def put(self, key: str, value: Any, ttl_s: float, size: int, forms: set[str]) -> None:
        if ttl_s <= 0 or size > self.max_bytes // 10:
            return
        with self._lock:
            if key in self._items:
                self._drop(key)
            self._items[key] = (self.clock() + ttl_s, size, forms, value)
            self._bytes += size
            while len(self._items) > self.max_entries or self._bytes > self.max_bytes:
                self._drop(next(iter(self._items)))

    def invalidate_form(self, form_id: str) -> int:
        with self._lock:
            keys = [key for key, item in self._items.items() if form_id in item[2]]
            for key in keys:
                self._drop(key)
            return len(keys)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._bytes = 0

    def _drop(self, key: str) -> None:
        item = self._items.pop(key)
        self._bytes -= item[1]

    def stats(self) -> dict[str, int]:
        return {"entries": len(self._items), "bytes": self._bytes, "hits": self.hits, "misses": self.misses}
