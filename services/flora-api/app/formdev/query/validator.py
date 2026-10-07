"""Query validator (Phase 4.3). Pure: no database, no clock.

validate_query(body, catalog, principal, policy) -> (issues, normalized)

Every query passes here before anything is compiled or executed. ``normalized`` is only
returned when there are no errors; it resolves names to typed references and applies the
policy defaults. Twin: frontend/src/formdev/query/validate.ts, kept in sync by
formdev/spec/fixtures/query-cases.json (codes + paths are compared, messages are not).
"""
from __future__ import annotations

import difflib
import math
import re
from dataclasses import dataclass
from typing import Any

from ..definition import DATETIME, datetime_epoch_ms
from .access import Principal
from .catalog import CURSOR_KEYS, FIELD_FAMILY, METADATA, STABLE_CURSOR_KEYS, SourceCatalog

FORMAT = "flora.query/1"
ALIAS = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")
NAME = re.compile(r"^(\$[a-z_]+|[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63})?)\Z")
RECORD_STATUSES = ("draft", "submitted", "deleted")
MAX_SAFE = 2 ** 53
QUERY_KEYS = {"id", "source", "select", "filter", "sort", "pagination", "limit", "group", "aggregate", "count", "timeout", "cache", "export"}
LEAF_KEYS = {"field", "op", "value"}
VALUE_OPS = {"eq", "ne", "lt", "lte", "gt", "gte", "in", "between", "prefix"}
NULL_OPS = {"is_null", "is_not_null"}
RANGE_OPS = {"eq", "ne", "lt", "lte", "gt", "gte", "in", "between"}
OPS_BY_FAMILY = {
    "text": RANGE_OPS | {"prefix"} | NULL_OPS,
    "num": RANGE_OPS | NULL_OPS,
    "datetime": RANGE_OPS | NULL_OPS,
    "bool": {"eq", "ne"} | NULL_OPS,
    # metadata families
    "time": RANGE_OPS,
    "int": RANGE_OPS,
    "status": {"eq", "ne", "in"},
    "user": {"eq", "ne", "in"},
    "id": {"eq", "ne", "in"},
    "subject": {"eq", "ne", "in", "prefix"} | NULL_OPS,
}
AGG_FNS = {"count", "sum", "avg", "min", "max"}
AGG_FAMILIES = {"sum": {"num", "bool"}, "avg": {"num", "bool"}, "min": {"num", "datetime"}, "max": {"num", "datetime"}, "count": {"num", "bool", "datetime", "text"}}
BUCKETS = {"day": 86_400_000}


@dataclass(frozen=True)
class Issue:
    path: str
    code: str
    message: str
    severity: str = "error"
    field: str | None = None  # set for not_filterable / index_building (index advisor input)

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "code": self.code, "message": self.message, "severity": self.severity}


class _Context:
    def __init__(self, catalog: SourceCatalog | None, principal: Principal, policy: dict[str, Any]):
        self.catalog = catalog
        self.principal = principal
        self.policy = policy
        self.issues: list[Issue] = []
        self.leaves = 0
        self.values = 0

    def error(self, path: str, code: str, message: str) -> None:
        self.issues.append(Issue(path, code, message))

    def warn(self, path: str, code: str, message: str) -> None:
        self.issues.append(Issue(path, code, message, "warning"))

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value) <= MAX_SAFE


def _scan_dangerous(value: Any, path: str, ctx: _Context, depth: int = 0) -> None:
    """Reject NUL bytes, oversize strings and runaway nesting anywhere in the request."""
    if depth > 12:
        ctx.error(path, "dangerous_operation", "Query is nested too deeply")
        return
    if isinstance(value, str):
        if "\x00" in value:
            ctx.error(path, "dangerous_operation", "NUL characters are not allowed")
        elif len(value) > ctx.policy["max_string_length"] and not path.endswith(".cursor"):
            ctx.error(path, "invalid_value", f"Text values are limited to {ctx.policy['max_string_length']} characters")
    elif isinstance(value, dict):
        for key, item in value.items():
            _scan_dangerous(item, f"{path}.{key}", ctx, depth + 1)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _scan_dangerous(item, f"{path}[{index}]", ctx, depth + 1)


def _unknown_keys(value: dict[str, Any], allowed: set[str], path: str, ctx: _Context) -> None:
    for key in sorted(set(value) - allowed):
        ctx.error(f"{path}.{key}", "dangerous_operation", f"Unsupported key '{key}' (raw SQL and unknown clauses are not accepted)")


def _suggest(name: str, ctx: _Context) -> str:
    catalog = ctx.catalog
    if catalog is None:
        return ""
    choices = catalog.readable_fields(ctx.principal) + [m for m in METADATA if catalog.can_read(ctx.principal, m)]
    match = difflib.get_close_matches(name, choices, n=1)
    return f" Did you mean '{match[0]}'?" if match else ""


def resolve(name: Any, path: str, ctx: _Context, allow_relation: bool = False) -> dict[str, Any] | None:
    """Resolve a field reference to {kind, name, family, ...} or record an issue."""
    catalog = ctx.catalog
    if catalog is None:
        return None
    if not isinstance(name, str) or not NAME.match(name):
        ctx.error(path, "invalid_field", "Field references are field ids, $metadata names or relation.field")
        return None
    if "." in name:
        relation_name, field_id = name.split(".", 1)
        relation = catalog.relations.get(relation_name)
        # A relation joins on its local field: it is unknown to callers who may not read that field.
        if relation is None or not relation["target"].can_query(ctx.principal) or not catalog.can_read(ctx.principal, relation["local"]):
            ctx.error(path, "invalid_relation", f"Unknown relation '{relation_name}'")
            return None
        if not allow_relation:
            ctx.error(path, "invalid_relation", "Relation fields can only be selected")
            return None
        target = relation["target"]
        info = target.fields.get(field_id)
        if info is None:
            ctx.error(path, "invalid_field", f"Relation '{relation_name}' has no field '{field_id}'")
            return None
        if not target.can_read(ctx.principal, field_id):
            ctx.error(path, "unauthorized_field", f"You may not read '{name}'")
            return None
        return {"kind": "relation", "name": name, "relation": relation_name, "field": field_id, "family": FIELD_FAMILY.get(info["type"], "text"), "type": info["type"]}
    if name in catalog.fields:
        info = catalog.fields[name]
        if not catalog.can_read(ctx.principal, name):
            ctx.error(path, "unauthorized_field", f"You may not read '{name}'")
            return None
        return {"kind": "field", "name": name, "field": name, "type": info["type"], "family": FIELD_FAMILY.get(info["type"], "text"),
                "indexed": info.get("indexed"), "state": info.get("state")}
    meta_name = name if name.startswith("$") else f"${name}"
    if meta_name in METADATA:
        if not catalog.can_read(ctx.principal, meta_name):
            ctx.error(path, "unauthorized_field", f"You may not read '{meta_name}'")
            return None
        meta = METADATA[meta_name]
        family = "subject" if meta_name == "$subject_id" else meta["family"]
        return {"kind": "meta", "name": meta_name, "column": meta["column"], "family": family, "order_column": meta.get("order_column", meta["column"])}
    ctx.error(path, "invalid_field", f"Unknown field '{name}'.{_suggest(name, ctx)}")
    return None


def _require_index(ref: dict[str, Any], path: str, ctx: _Context, purpose: str) -> bool:
    if ref["kind"] != "field":
        return True
    if ref["family"] in ("longtext", "multi"):
        ctx.error(path, "not_filterable", f"{ref['type']} fields cannot be used to {purpose}")
        return False
    if not ref.get("indexed"):
        ctx.issues.append(Issue(path, "not_filterable", f"Field '{ref['name']}' is not indexed; an administrator can index it to {purpose}", field=ref["name"]))
        return False
    if ref.get("state") == "building":
        ctx.issues.append(Issue(path, "index_building", f"The index for '{ref['name']}' is being rebuilt; try again shortly", field=ref["name"]))
        return False
    return True


def _typed_value(ref: dict[str, Any], value: Any, path: str, ctx: _Context) -> Any:
    family = ref["family"]
    if family in ("text", "user", "subject"):
        if isinstance(value, str):
            return value
    elif family == "num":
        if _is_number(value):
            return value
    elif family == "int":
        if _is_number(value) and float(value).is_integer():
            return int(value)
    elif family == "bool":
        if isinstance(value, bool):
            return value
    elif family in ("datetime", "time"):
        if isinstance(value, str) and DATETIME.match(value):
            epoch = datetime_epoch_ms(value)
            if epoch is not None:
                return epoch
        elif _is_number(value) and float(value).is_integer():
            return int(value)
    elif family == "status":
        if value in RECORD_STATUSES:
            return value
    elif family == "id":
        if isinstance(value, str) and re.match(r"^[A-Za-z0-9-]{8,64}\Z", value):
            return value
    ctx.error(path, "invalid_value", f"Value does not match the type of '{ref['name']}'")
    return None


def _leaf(node: dict[str, Any], path: str, ctx: _Context) -> dict[str, Any] | None:
    _unknown_keys(node, LEAF_KEYS, path, ctx)
    ctx.leaves += 1
    ref = resolve(node.get("field"), f"{path}.field", ctx)
    op = node.get("op")
    if not isinstance(op, str) or op not in VALUE_OPS | NULL_OPS:
        ctx.error(f"{path}.op", "invalid_operator", f"Unknown operator '{op}'")
        return None
    if ref is None:
        return None
    if ref["family"] not in OPS_BY_FAMILY or op not in OPS_BY_FAMILY[ref["family"]]:
        if ref["kind"] == "field" and ref["family"] in ("longtext", "multi"):
            _require_index(ref, f"{path}.field", ctx, "filter")
        else:
            ctx.error(f"{path}.op", "invalid_operator", f"Operator '{op}' does not apply to '{ref['name']}'")
        return None
    if not _require_index(ref, f"{path}.field", ctx, "filter"):
        return None
    if op in NULL_OPS:
        if "value" in node:
            ctx.error(f"{path}.value", "invalid_value", f"'{op}' takes no value")
        return {"leaf": True, "ref": ref, "op": op, "values": []}
    if "value" not in node:
        ctx.error(f"{path}.value", "invalid_value", f"'{op}' needs a value")
        return None
    raw = node["value"]
    if op == "in":
        if not isinstance(raw, list) or not raw:
            ctx.error(f"{path}.value", "invalid_value", "'in' needs a non-empty list")
            return None
        if len(raw) > ctx.policy["max_in_values"]:
            ctx.error(f"{path}.value", "too_many_values", f"'in' accepts at most {ctx.policy['max_in_values']} values")
            return None
        values = [_typed_value(ref, item, f"{path}.value[{index}]", ctx) for index, item in enumerate(raw)]
    elif op == "between":
        if not isinstance(raw, list) or len(raw) != 2:
            ctx.error(f"{path}.value", "invalid_value", "'between' needs [low, high]")
            return None
        values = [_typed_value(ref, item, f"{path}.value[{index}]", ctx) for index, item in enumerate(raw)]
    else:
        values = [_typed_value(ref, raw, f"{path}.value", ctx)]
        if op == "prefix" and isinstance(raw, str) and len(raw) < ctx.policy["min_prefix_length"]:
            ctx.error(f"{path}.value", "invalid_value", f"prefix needs at least {ctx.policy['min_prefix_length']} character(s)")
    ctx.values += len(values)
    if ref["kind"] == "meta" and ref["family"] == "status" and "deleted" in values and op != "ne" and not ctx.principal.is_admin:
        ctx.error(f"{path}.value", "deleted_requires_admin", "Only administrators can query deleted records")
    if any(value is None for value in values):
        return None
    return {"leaf": True, "ref": ref, "op": op, "values": values}


def _filter(node: Any, path: str, ctx: _Context, depth: int = 1) -> dict[str, Any] | None:
    if not isinstance(node, dict):
        ctx.error(path, "invalid_filter", "A filter is an object")
        return None
    if depth > ctx.policy["max_filter_depth"]:
        ctx.error(path, "filter_too_complex", f"Filters may nest at most {ctx.policy['max_filter_depth']} levels")
        return None
    groups = [key for key in ("and", "or", "not") if key in node]
    if not groups:
        return _leaf(node, path, ctx)
    if len(node) != 1:
        _unknown_keys(node, {groups[0]}, path, ctx)
        return None
    key = groups[0]
    if key == "not":
        child = _filter(node["not"], f"{path}.not", ctx, depth + 1)
        return {"op": "not", "arg": child} if child else None
    items = node[key]
    if not isinstance(items, list) or not items:
        ctx.error(f"{path}.{key}", "invalid_filter", f"'{key}' needs a non-empty list")
        return None
    children = [_filter(item, f"{path}.{key}[{index}]", ctx, depth + 1) for index, item in enumerate(items)]
    if key == "and":
        index_terms = sum(1 for child in children if child and child.get("leaf") and child["ref"]["kind"] == "field")
        if index_terms > ctx.policy["max_index_terms_per_and"]:
            ctx.error(f"{path}.and", "filter_too_complex", f"At most {ctx.policy['max_index_terms_per_and']} indexed-field conditions per 'and'")
    if any(child is None for child in children):
        return None
    return {"op": key, "args": children}


def _mentions_status(node: dict[str, Any] | None) -> bool:
    if not node:
        return False
    if node.get("leaf"):
        return node["ref"]["kind"] == "meta" and node["ref"]["name"] == "$status"
    if node["op"] == "not":
        return _mentions_status(node["arg"])
    return any(_mentions_status(child) for child in node["args"])


def _pagination(query: dict[str, Any], ctx: _Context, grouped: bool) -> dict[str, Any]:
    policy = ctx.policy
    raw = query.get("pagination")
    alias_limit = query.get("limit")
    if raw is None and alias_limit is None:
        if grouped:
            return {"mode": "none", "limit": policy["max_groups"], "offset": 0, "cursor": None}
        ctx.error("$.query.pagination", "missing_limit", "List queries need pagination with a limit")
        return {}
    if raw is None:
        raw = {"mode": "offset" if grouped else "cursor", "limit": alias_limit}
    if not isinstance(raw, dict):
        ctx.error("$.query.pagination", "invalid_pagination", "pagination is an object")
        return {}
    _unknown_keys(raw, {"mode", "limit", "offset", "cursor"}, "$.query.pagination", ctx)
    mode = raw.get("mode", "offset" if grouped else "cursor")
    if mode not in ("cursor", "offset"):
        ctx.error("$.query.pagination.mode", "invalid_pagination", "mode is cursor or offset")
        return {}
    if grouped and mode == "cursor":
        ctx.error("$.query.pagination.mode", "cursor_not_supported_for_group", "Grouped results page with offset")
        return {}
    limit = raw.get("limit", alias_limit)
    if alias_limit is not None and raw.get("limit") is not None and alias_limit != raw.get("limit"):
        ctx.error("$.query.limit", "invalid_pagination", "limit and pagination.limit disagree")
    cap = policy["max_groups"] if grouped else policy["max_page_rows"]
    if limit is None:
        ctx.error("$.query.pagination.limit", "missing_limit", "pagination.limit is required")
        return {}
    if not _is_number(limit) or not float(limit).is_integer() or limit < 1:
        ctx.error("$.query.pagination.limit", "invalid_pagination", "limit is a positive integer")
        return {}
    if limit > cap:
        ctx.error("$.query.pagination.limit", "limit_exceeded", f"At most {cap} rows per page; use an export job for more")
    offset = raw.get("offset", 0)
    if mode == "cursor" and "offset" in raw:
        ctx.error("$.query.pagination.offset", "invalid_pagination", "Cursor pagination does not take an offset")
    if not _is_number(offset) or not float(offset).is_integer() or offset < 0:
        ctx.error("$.query.pagination.offset", "invalid_pagination", "offset is a non-negative integer")
        offset = 0
    elif offset > policy["max_offset"]:
        ctx.error("$.query.pagination.offset", "offset_exceeded", f"offset is limited to {policy['max_offset']}; use cursor pagination")
    cursor = raw.get("cursor")
    if cursor is not None and (mode != "cursor" or not isinstance(cursor, str) or len(cursor) > 2048):
        ctx.error("$.query.pagination.cursor", "invalid_cursor", "cursor is an opaque string from a previous page")
        cursor = None
    return {"mode": mode, "limit": int(limit), "offset": int(offset), "cursor": cursor}


def _sort(query: dict[str, Any], ctx: _Context, pagination: dict[str, Any], grouped_names: set[str] | None) -> list[dict[str, Any]]:
    raw = query.get("sort")
    if raw is None:
        if grouped_names is not None:
            return []
        return [{"ref": resolve("$ingested_at", "$.query.sort", ctx), "dir": "desc"}]
    if not isinstance(raw, list):
        ctx.error("$.query.sort", "invalid_sort", "sort is a list of {field, dir}")
        return []
    if len(raw) > ctx.policy["max_sort_keys"] and grouped_names is None:
        ctx.error("$.query.sort", "invalid_sort", f"At most {ctx.policy['max_sort_keys']} sort key (record id breaks ties)")
        return []
    out = []
    for index, item in enumerate(raw):
        path = f"$.query.sort[{index}]"
        if not isinstance(item, dict):
            ctx.error(path, "invalid_sort", "sort entries are objects")
            continue
        _unknown_keys(item, {"field", "dir"}, path, ctx)
        direction = item.get("dir", "asc")
        if direction not in ("asc", "desc"):
            ctx.error(f"{path}.dir", "invalid_sort", "dir is asc or desc")
            continue
        name = item.get("field")
        if grouped_names is not None:
            if not isinstance(name, str) or name not in grouped_names:
                ctx.error(f"{path}.field", "sort_not_grouped", "Sort grouped results by a group key or aggregate alias")
                continue
            out.append({"name": name, "dir": direction})
            continue
        ref = resolve(name, f"{path}.field", ctx)
        if ref is None:
            continue
        if pagination.get("mode") == "cursor":
            if ref["name"] not in CURSOR_KEYS:
                ctx.error(f"{path}.field", "cursor_requires_stable_sort", f"Cursor pagination sorts by {', '.join(CURSOR_KEYS)}; use offset pagination to sort by other fields")
                continue
            if ref["name"] not in STABLE_CURSOR_KEYS:
                ctx.warn(f"{path}.field", "cursor_not_snapshot_stable", "Records edited while paging may move between pages")
        elif ref["kind"] == "meta":
            if not METADATA[ref["name"]]["sortable"]:
                ctx.error(f"{path}.field", "invalid_sort", f"'{ref['name']}' cannot be sorted")
                continue
        elif ref["family"] not in ("text", "num", "datetime", "bool") or not _require_index(ref, f"{path}.field", ctx, "sort"):
            if ref["family"] not in ("text", "num", "datetime", "bool"):
                ctx.error(f"{path}.field", "invalid_sort", f"'{ref['name']}' cannot be sorted")
            continue
        out.append({"ref": ref, "dir": direction})
    return out


def _group(query: dict[str, Any], ctx: _Context) -> list[dict[str, Any]]:
    raw = query.get("group")
    if raw is None:
        return []
    if not isinstance(raw, list) or not raw:
        ctx.error("$.query.group", "aggregate_invalid", "group is a non-empty list")
        return []
    if len(raw) > ctx.policy["max_group_keys"]:
        ctx.error("$.query.group", "too_many_groups", f"Group by at most {ctx.policy['max_group_keys']} keys")
        return []
    out = []
    for index, item in enumerate(raw):
        path = f"$.query.group[{index}]"
        spec = {"field": item} if isinstance(item, str) else item
        if not isinstance(spec, dict):
            ctx.error(path, "aggregate_invalid", "group keys are names or {field, bucket}")
            continue
        _unknown_keys(spec, {"field", "bucket", "tz_offset_minutes"}, path, ctx)
        ref = resolve(spec.get("field"), path if isinstance(item, str) else f"{path}.field", ctx)
        if ref is None:
            continue
        bucket = spec.get("bucket")
        offset = spec.get("tz_offset_minutes", 420)
        if bucket is not None and (not isinstance(bucket, str) or bucket not in BUCKETS or ref["kind"] != "meta" or ref["family"] != "time"):
            ctx.error(f"{path}.bucket", "aggregate_invalid", "bucket 'day' applies to $created_at, $updated_at and $ingested_at")
            continue
        if not isinstance(offset, int) or isinstance(offset, bool) or abs(offset) > 14 * 60:
            ctx.error(f"{path}.tz_offset_minutes", "aggregate_invalid", "tz_offset_minutes is an integer within ±840")
            continue
        if ref["kind"] == "meta":
            if not METADATA[ref["name"]]["groupable"] or (ref["family"] == "time" and bucket is None):
                ctx.error(path, "aggregate_invalid", f"Group by '{ref['name']}'" + (" needs bucket 'day'" if ref["family"] == "time" else " is not supported"))
                continue
        elif ref["family"] not in ("text", "num", "bool") or not _require_index(ref, path, ctx, "group"):
            if ref["family"] not in ("text", "num", "bool"):
                ctx.error(path, "aggregate_invalid", f"Group by '{ref['name']}' is not supported")
            continue
        out.append({"ref": ref, "bucket": bucket, "tz_offset_minutes": offset, "name": ref["name"] if not bucket else f"{ref['name']}_{bucket}"})
    return out


def _aggregates(query: dict[str, Any], ctx: _Context, group_names: set[str]) -> list[dict[str, Any]]:
    raw = query.get("aggregate")
    if raw is None:
        return []
    if not isinstance(raw, list) or not raw:
        ctx.error("$.query.aggregate", "aggregate_invalid", "aggregate is a non-empty list")
        return []
    if len(raw) > ctx.policy["max_aggregates"]:
        ctx.error("$.query.aggregate", "aggregate_invalid", f"At most {ctx.policy['max_aggregates']} aggregates")
        return []
    out, aliases = [], set()
    for index, item in enumerate(raw):
        path = f"$.query.aggregate[{index}]"
        if not isinstance(item, dict):
            ctx.error(path, "aggregate_invalid", "aggregates are objects")
            continue
        _unknown_keys(item, {"fn", "field", "as"}, path, ctx)
        fn, alias = item.get("fn"), item.get("as")
        if not isinstance(fn, str) or fn not in AGG_FNS:
            ctx.error(f"{path}.fn", "aggregate_invalid", f"fn is one of {', '.join(sorted(AGG_FNS))}")
            continue
        if not isinstance(alias, str) or not ALIAS.match(alias) or alias in aliases or alias in group_names:
            ctx.error(f"{path}.as", "invalid_alias", "as is a unique lower_snake_case name")
            continue
        aliases.add(alias)
        ref = None
        if "field" in item:
            ref = resolve(item["field"], f"{path}.field", ctx)
            if ref is None:
                continue
            if ref["kind"] != "field" or ref["family"] not in AGG_FAMILIES[fn]:
                ctx.error(f"{path}.field", "aggregate_invalid", f"{fn} does not apply to '{ref['name']}'")
                continue
            if not _require_index(ref, f"{path}.field", ctx, "aggregate"):
                continue
        elif fn != "count":
            ctx.error(f"{path}.field", "aggregate_invalid", f"{fn} needs a field")
            continue
        out.append({"fn": fn, "ref": ref, "as": alias})
    return out


def _timeout(query: dict[str, Any], ctx: _Context) -> int:
    bounds = ctx.policy["timeout_ms"]
    raw = query.get("timeout")
    if raw is None:
        return bounds["default"]
    if not _is_number(raw) or not float(raw).is_integer() or raw < 1:
        ctx.error("$.query.timeout", "invalid_timeout", "timeout is a positive number of milliseconds")
        return bounds["default"]
    if raw > bounds["max"]:
        ctx.warn("$.query.timeout", "timeout_clamped", f"timeout reduced to {bounds['max']} ms")
        return bounds["max"]
    return int(raw)


def _cache(query: dict[str, Any], ctx: _Context) -> int:
    bounds = ctx.policy["cache_ttl_s"]
    raw = query.get("cache")
    if raw is None:
        return bounds["default"]
    if raw is False:
        return 0
    if not isinstance(raw, dict) or set(raw) - {"ttl"} or not _is_number(raw.get("ttl")) or raw["ttl"] < 0:
        ctx.error("$.query.cache", "invalid_cache", "cache is false or {ttl: seconds}")
        return 0
    if raw["ttl"] > bounds["max"]:
        ctx.warn("$.query.cache.ttl", "cache_ttl_clamped", f"cache ttl reduced to {bounds['max']} s")
        return bounds["max"]
    return int(raw["ttl"])


def _export(query: dict[str, Any], ctx: _Context) -> dict[str, Any] | None:
    raw = query.get("export")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        ctx.error("$.query.export", "invalid_export", "export is an object")
        return None
    _unknown_keys(raw, {"format", "headers", "max_rows"}, "$.query.export", ctx)
    fmt = raw.get("format", "csv")
    headers = raw.get("headers", "ids")
    if fmt not in ("csv", "jsonl", "json") or headers not in ("ids", "labels"):
        ctx.error("$.query.export", "invalid_export", "format is csv, jsonl or json; headers is ids or labels")
        return None
    limits = ctx.policy["export_max_rows"]
    cap = limits["formdev.manage"] if ctx.principal.is_admin else limits["default"]
    max_rows = raw.get("max_rows", cap)
    if not _is_number(max_rows) or not float(max_rows).is_integer() or max_rows < 1:
        ctx.error("$.query.export.max_rows", "invalid_export", "max_rows is a positive integer")
        return None
    if max_rows > cap:
        ctx.error("$.query.export.max_rows", "export_limit_exceeded", f"Your export limit is {cap} rows")
        return None
    return {"format": fmt, "headers": headers, "max_rows": int(max_rows)}


def validate_query(body: Any, catalog: SourceCatalog | None, principal: Principal, policy: dict[str, Any]) -> tuple[list[Issue], dict[str, Any] | None]:
    """Validate a flora.query/1 request against a catalog (None = the source is unknown or hidden)."""
    ctx = _Context(catalog, principal, policy)
    if not isinstance(body, dict) or not isinstance(body.get("query"), dict):
        ctx.error("$", "invalid_request", "Body must be {\"query\": {...}}")
        return ctx.issues, None
    _unknown_keys(body, {"format", "query"}, "$", ctx)
    if "format" in body and body["format"] != FORMAT:
        ctx.error("$.format", "invalid_format", f"format must be '{FORMAT}'")
    query = body["query"]
    _scan_dangerous(query, "$.query", ctx)
    _unknown_keys(query, QUERY_KEYS, "$.query", ctx)
    if "id" in query and (not isinstance(query["id"], str) or not ALIAS.match(query["id"]) or len(query["id"]) < 2):
        ctx.error("$.query.id", "invalid_value", "id is a lower_snake_case name")
    if catalog is None or catalog.source_id != query.get("source") or not catalog.can_query(principal):
        ctx.error("$.query.source", "unknown_source", "Unknown source")
        return ctx.issues, None

    group = _group(query, ctx)
    aggregates = _aggregates(query, ctx, {g["name"] for g in group})
    grouped = bool(group or "group" in query or aggregates or "aggregate" in query)
    filter_node = _filter(query["filter"], "$.query.filter", ctx) if "filter" in query else None
    if ctx.leaves > policy["max_filter_leaves"]:
        ctx.error("$.query.filter", "filter_too_complex", f"At most {policy['max_filter_leaves']} conditions")
    if ctx.values > policy["max_total_values"]:
        ctx.error("$.query.filter", "too_many_values", f"At most {policy['max_total_values']} values across the filter")
    pagination = _pagination(query, ctx, grouped)

    select: list[dict[str, Any]] = []
    raw_select = query.get("select")
    if grouped:
        names = {g["name"] for g in group} | {a["as"] for a in aggregates}
        if raw_select is not None:
            if not isinstance(raw_select, list) or not all(isinstance(item, str) for item in raw_select) or not set(raw_select) <= names:
                ctx.error("$.query.select", "select_not_grouped", "Grouped queries select only group keys and aggregate aliases")
        sort = _sort(query, ctx, pagination, names)
    else:
        if raw_select is None or raw_select == []:
            ctx.error("$.query.select", "missing_select", "List the fields to return")
        elif raw_select == "*" or (isinstance(raw_select, list) and "*" in raw_select):
            ctx.error("$.query.select", "select_star_not_allowed", "SELECT * is not allowed; list the fields you need")
        elif not isinstance(raw_select, list):
            ctx.error("$.query.select", "missing_select", "select is a list of field names")
        else:
            if len(raw_select) > policy["max_select_fields"]:
                ctx.error("$.query.select", "too_many_fields", f"At most {policy['max_select_fields']} fields")
            seen: set[str] = set()
            for index, name in enumerate(raw_select):
                ref = resolve(name, f"$.query.select[{index}]", ctx, allow_relation=True)
                if ref and ref["name"] not in seen:
                    seen.add(ref["name"])
                    select.append({**ref, "output": name})
        sort = _sort(query, ctx, pagination, None)
        if "filter" not in query:
            ctx.warn("$.query.filter", "missing_filter", "No filter: results are paged over the whole source")
    count = query.get("count", "none")
    if count not in ("none", "capped"):
        ctx.error("$.query.count", "invalid_value", "count is none or capped")
    timeout_ms = _timeout(query, ctx)
    cache_ttl = _cache(query, ctx)
    export = _export(query, ctx)
    if not ctx.ok:
        return ctx.issues, None
    return ctx.issues, {
        "id": query.get("id"), "source": catalog.source_id, "form_id": catalog.form_id, "kind": "aggregate" if grouped else "list",
        # Deleted records are hidden unless an administrator filters on $status explicitly.
        "select": select, "filter": filter_node, "live": not (principal.is_admin and _mentions_status(filter_node)), "sort": sort, "pagination": pagination,
        "group": group, "aggregate": aggregates, "count": count, "timeout_ms": timeout_ms, "cache_ttl_s": cache_ttl, "export": export,
    }
