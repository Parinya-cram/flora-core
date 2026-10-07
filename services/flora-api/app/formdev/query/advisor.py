"""Index advisor (Phase 4.6): recommendations from measured query usage, never applied
automatically. Each recommendation states its evidence and its trade-off (storage, extra index
rows written per record write, read benefit)."""
from __future__ import annotations

import hashlib
import re
from typing import Any

from ..field_types import INDEX_FAMILY, index_column
from .catalog import SourceCatalog

INDEX_ROW_BYTES = 110          # measured average formdev_record_index row + live-index entries (see PERFORMANCE-REPORT)
MIN_REJECTIONS = 3
HOT_SHARE = 0.3
LARGE_FORM_RECORDS = 100_000
SLOW_AVG_MS = 1000
SAFE_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")


def _fields(node: Any, out: set[str]) -> set[str]:
    if isinstance(node, dict):
        if "f" in node and isinstance(node["f"], str):
            out.add(node["f"])
        for value in node.values():
            _fields(value, out)
    elif isinstance(node, list):
        for item in node:
            _fields(item, out)
    return out


def usage(stats: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    per_field: dict[str, dict[str, int]] = {}
    for row in stats:
        shape = row["shape"] or {}
        for field_id in shape.get("rejected_not_indexed", []):
            per_field.setdefault(field_id, {"runs": 0, "rejections": 0})["rejections"] += int(row["runs"])
        used = _fields(shape.get("filter"), set()) | {item["f"] for item in shape.get("sort", [])} | set(shape.get("group", []))
        used |= {item["f"] for item in shape.get("aggregate", []) if item.get("f")}
        for field_id in used:
            per_field.setdefault(field_id, {"runs": 0, "rejections": 0})["runs"] += int(row["runs"])
    return per_field


def partial_index_ddl(form_id: str, field_id: str, column: str) -> str:
    """DDL text for an administrator to review. Identifiers are validated, never executed here."""
    if not SAFE_ID.match(form_id) or not SAFE_ID.match(field_id) or column not in ("value_text", "value_num"):
        raise ValueError("unsafe identifier")
    name = "formdev_ri_hot_" + hashlib.sha256(f"{form_id}.{field_id}".encode()).hexdigest()[:12]
    return (f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON formdev_record_index ({column}, updated_at DESC, record_id DESC) "
            f"WHERE form_id = '{form_id}' AND field_id = '{field_id}' AND status <> 'deleted';")


def advise(catalog: SourceCatalog, stats: list[dict[str, Any]], record_count: int, vendor: str) -> list[dict[str, Any]]:
    per_field = usage(stats)
    total_runs = sum(int(row["runs"]) for row in stats if "rejected_not_indexed" not in (row["shape"] or {})) or 0
    storage = record_count * INDEX_ROW_BYTES
    out: list[dict[str, Any]] = []
    for field_id, info in sorted(catalog.fields.items()):
        counters = per_field.get(field_id, {"runs": 0, "rejections": 0})
        tradeoff = {"storage_bytes": storage, "extra_index_rows_per_write": 1, "records": record_count}
        if not info.get("indexed") and counters["rejections"] >= MIN_REJECTIONS and info["type"] in INDEX_FAMILY:
            out.append({"kind": "index_field", "source_id": catalog.source_id, "field": field_id,
                        "reason": f"{counters['rejections']} queries were refused because '{field_id}' is not indexed",
                        "evidence": counters, "tradeoff": tradeoff,
                        "action": {"method": "POST", "path": f"/api/formdev/index-config/{catalog.form_id}/{field_id}"}})
        elif info.get("indexed") and counters["runs"] == 0 and total_runs >= 50:
            out.append({"kind": "unused_index", "source_id": catalog.source_id, "field": field_id,
                        "reason": f"'{field_id}' is indexed but none of the last {total_runs} queries used it",
                        "evidence": counters, "tradeoff": {**tradeoff, "storage_bytes": -storage, "extra_index_rows_per_write": -1},
                        "action": {"method": "DELETE", "path": f"/api/formdev/index-config/{catalog.form_id}/{field_id}"}
                        if info.get("origin") == "config" else {"note": "remove indexed: true in the next schema version"}})
        elif (info.get("indexed") and vendor == "postgresql" and record_count >= LARGE_FORM_RECORDS and total_runs
              and counters["runs"] / total_runs >= HOT_SHARE):
            column = index_column(info["type"])
            out.append({"kind": "partial_index", "source_id": catalog.source_id, "field": field_id,
                        "reason": f"'{field_id}' is used by {round(100 * counters['runs'] / total_runs)}% of queries on a {record_count}-record form",
                        "evidence": counters, "tradeoff": {**tradeoff, "storage_bytes": int(storage * 0.6)},
                        "action": {"sql": partial_index_ddl(catalog.form_id, field_id, column), "review": "apply in a maintenance window; verify with EXPLAIN"}})
    for row in stats:
        runs = int(row["runs"]) or 1
        if int(row["timeouts"]) or int(row["total_ms"]) / runs > SLOW_AVG_MS:
            out.append({"kind": "slow_query", "source_id": catalog.source_id, "fingerprint": row["fingerprint"],
                        "reason": "This query shape is slow or timed out",
                        "evidence": {"runs": runs, "timeouts": int(row["timeouts"]), "avg_ms": round(int(row["total_ms"]) / runs), "max_ms": int(row["max_ms"])},
                        "tradeoff": None, "action": {"note": "add a selective filter on an indexed field or run it as a job"}})
    return out
