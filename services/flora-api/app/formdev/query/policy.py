"""Query limits (Phase 4.7). Identical to formdev/spec/query-policy.json (enforced by tests);
the TypeScript validator receives the effective policy from the catalog endpoint."""
from __future__ import annotations

import copy
from typing import Any

DEFAULT_POLICY: dict[str, Any] = {
    "format": "flora.query-policy/1",
    "max_body_bytes": 65536,
    "max_page_rows": 500,
    "max_offset": 10000,
    "max_select_fields": 40,
    "max_sort_keys": 1,
    "max_filter_depth": 4,
    "max_filter_leaves": 32,
    "max_index_terms_per_and": 8,
    "max_in_values": 500,
    "max_total_values": 2000,
    "max_string_length": 1000,
    "min_prefix_length": 1,
    "max_group_keys": 3,
    "max_aggregates": 10,
    "max_groups": 1000,
    "timeout_ms": {
        "default": 5000,
        "max": 15000
    },
    "max_result_bytes": 2097152,
    "cache_ttl_s": {
        "default": 30,
        "max": 300
    },
    "count_cap": 10000,
    "interactive_aggregate_max_rows": 50000,
    "probe_timeout_ms": 250,
    "export_max_rows": {
        "default": 100000,
        "formdev.manage": 1000000
    },
    "rate": {
        "per_minute": 60,
        "burst": 20
    },
    "pull_rate": {
        "per_minute": 600,
        "burst": 100
    },
    "concurrency": {
        "per_user": 2,
        "global": 4
    },
    "jobs": {
        "per_user_open": 3,
        "global_open": 20,
        "workers": 2,
        "batch_rows": 1000,
        "batch_timeout_ms": 30000,
        "aggregate_timeout_ms": 300000,
        "max_runtime_ms": 1800000,
        "max_result_bytes": 536870912,
        "lease_ms": 120000,
        "poll_ms": 1000,
        "result_ttl_ms": 86400000,
        "max_attempts": 3
    }
}


def policy(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    out = copy.deepcopy(DEFAULT_POLICY)
    for key, value in (overrides or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key].update(value)
        else:
            out[key] = value
    return out
