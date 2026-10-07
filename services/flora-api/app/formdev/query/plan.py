"""Vendor-free query plan (IR). Built from a validated, normalized query; compiled to SQL by
the storage adapter (adapters/sql_query.py). Nothing here knows SQL or a database vendor.

Filter semantics ("missing" = the record has no index row for the field, i.e. no value):
- eq / lt / lte / gt / gte / in / between / prefix: the record has a value that matches
- ne: the record has a value and it differs (missing is not "ne")
- not F: every record for which F is false, including records missing the field
- is_null: the field is missing; is_not_null: the field has a value
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

VALUE_COLUMN = {"text": "value_text", "num": "value_num", "bool": "value_num", "datetime": "value_num"}
DAY_MS = 86_400_000


@dataclass(frozen=True)
class Leaf:
    kind: str                  # index | meta | missing | present
    column: str                # value_text/value_num (index) or a formdev_record column (meta)
    op: str = "eq"
    values: tuple[Any, ...] = ()
    field: str | None = None   # field_id for index/missing/present


@dataclass(frozen=True)
class Node:
    op: str                    # and | or | not
    args: tuple[Any, ...]


@dataclass(frozen=True)
class OrderKey:
    kind: str                  # meta | field
    column: str                # record column, or value column for field keys
    direction: str             # asc | desc
    field: str | None = None
    unique: bool = False       # true for ingest_seq / record_id (no record_id tiebreak needed)


@dataclass(frozen=True)
class GroupKey:
    kind: str                  # meta | field
    column: str
    field: str | None = None
    bucket_ms: int | None = None
    offset_ms: int = 0
    name: str = ""


@dataclass(frozen=True)
class Aggregate:
    fn: str
    alias: str
    field: str | None = None
    column: str | None = None


@dataclass
class QueryPlan:
    form_id: str
    kind: str                                   # list | aggregate | count
    where: Leaf | Node | None = None
    live: bool = True                           # exclude soft-deleted records
    order: OrderKey | None = None
    keyset: tuple[Any, ...] | None = None       # (order value, record_id) after which the page starts
    limit: int = 50
    offset: int = 0
    meta_columns: tuple[str, ...] = ()
    group: tuple[GroupKey, ...] = ()
    aggregates: tuple[Aggregate, ...] = ()
    group_order: tuple[tuple[str, str], ...] = ()  # (output name, direction)
    count_cap: int = 0
    extras: dict[str, Any] = field(default_factory=dict)


def _value_values(ref: dict[str, Any], values: list[Any]) -> tuple[Any, ...]:
    if ref["family"] == "bool":
        return tuple(1 if value else 0 for value in values)
    return tuple(values)


def plan_filter(node: dict[str, Any] | None) -> Leaf | Node | None:
    if node is None:
        return None
    if node.get("leaf"):
        ref, op, values = node["ref"], node["op"], node["values"]
        if ref["kind"] == "meta":
            column = ref["column"]
            if op == "is_null":
                return Leaf("meta", column, "is_null")
            if op == "is_not_null":
                return Leaf("meta", column, "is_not_null")
            return Leaf("meta", column, op, tuple(values))
        column = VALUE_COLUMN[ref["family"]]
        if op == "is_null":
            return Leaf("missing", column, "is_null", (), ref["field"])
        if op == "is_not_null":
            return Leaf("present", column, "is_not_null", (), ref["field"])
        return Leaf("index", column, op, _value_values(ref, values), ref["field"])
    if node["op"] == "not":
        return Node("not", (plan_filter(node["arg"]),))
    return Node(node["op"], tuple(plan_filter(child) for child in node["args"]))


def order_key(sort: list[dict[str, Any]]) -> OrderKey:
    item = sort[0]
    ref, direction = item["ref"], item["dir"]
    if ref["kind"] == "meta":
        column = ref["order_column"]
        return OrderKey("meta", column, direction, unique=column in ("ingest_seq", "record_id"))
    return OrderKey("field", VALUE_COLUMN[ref["family"]], direction, ref["field"])


def build_plan(spec: dict[str, Any], keyset: tuple[Any, ...] | None = None) -> QueryPlan:
    where = plan_filter(spec["filter"])
    if spec["kind"] == "list":
        meta = tuple(dict.fromkeys(ref["column"] for ref in spec["select"] if ref["kind"] == "meta"))
        pagination = spec["pagination"]
        return QueryPlan(
            form_id=spec["form_id"], kind="list", where=where, live=spec["live"], order=order_key(spec["sort"]),
            keyset=keyset, limit=pagination["limit"], offset=pagination["offset"] if pagination["mode"] == "offset" else 0,
            meta_columns=meta,
        )
    group = []
    for item in spec["group"]:
        ref = item["ref"]
        if ref["kind"] == "meta":
            bucket = DAY_MS if item["bucket"] == "day" else None
            group.append(GroupKey("meta", ref["column"], bucket_ms=bucket, offset_ms=item["tz_offset_minutes"] * 60_000, name=item["name"]))
        else:
            group.append(GroupKey("field", VALUE_COLUMN[ref["family"]], ref["field"], name=item["name"]))
    aggregates = tuple(
        Aggregate(item["fn"], item["as"], item["ref"]["field"] if item["ref"] else None, VALUE_COLUMN[item["ref"]["family"]] if item["ref"] else None)
        for item in spec["aggregate"]
    )
    pagination = spec["pagination"]
    return QueryPlan(
        form_id=spec["form_id"], kind="aggregate", where=where, live=spec["live"], limit=pagination["limit"],
        offset=pagination["offset"], group=tuple(group), aggregates=aggregates,
        group_order=tuple((item["name"], item["dir"]) for item in spec["sort"]),
    )


def count_plan(spec: dict[str, Any], cap: int) -> QueryPlan:
    return QueryPlan(form_id=spec["form_id"], kind="count", where=plan_filter(spec["filter"]), live=spec["live"], count_cap=cap)


def filter_fields(node: Leaf | Node | None) -> set[str]:
    if node is None:
        return set()
    if isinstance(node, Leaf):
        return {node.field} if node.field else {f"${node.column}"}
    return set().union(*(filter_fields(child) for child in node.args))
