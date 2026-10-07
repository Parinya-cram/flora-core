"""Compile a vendor-free QueryPlan into portable SQL (``?`` placeholders).

The SQL uses only constructs that PostgreSQL 17 and SQLite 3.35+ share: row-value comparisons,
EXISTS semi-joins, CASE, integer division, parenthesized sub-selects inside UNION ALL. Every
value is bound; identifiers come only from fixed whitelists in this module and generated
aliases (iN, fN, gN, aN) — no caller-supplied text is ever placed in the SQL string.
Vendor differences (timeouts, read-only sessions, EXPLAIN formats) live in the adapters.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ..query.plan import Leaf, Node, QueryPlan

RECORD_COLUMNS = {"record_id", "status", "schema_version", "version", "created_at", "updated_at", "ingested_at",
                  "ingest_seq", "created_by", "updated_by", "subject_id"}
# Columns that may be NULL: their conditions are made two-valued so that NOT keeps the NULL rows (plan.py: "not F"
# is every record for which F is false).
NULLABLE_COLUMNS = {"subject_id", "ingested_at", "ingest_seq"}
VALUE_COLUMNS = {"value_text", "value_num"}
COMPARE = {"eq": "=", "ne": "<>", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}
DIRECTIONS = {"asc": "ASC", "desc": "DESC"}
AGG_SQL = {"count": "COUNT", "sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX"}
PREFIX_UPPER = "\U0010ffff"
LIVE_INDEX = "status <> 'deleted'"


class QueryTimeout(Exception):
    """The statement or session exceeded its time budget (cancelled by the database)."""


class QueryFailed(Exception):
    """The database refused or failed the query. ``code`` is a stable, value-free identifier."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class CompiledQuery:
    sql: str
    params: tuple[Any, ...]


class ReadSession(Protocol):
    def fetch(self, query: CompiledQuery) -> list[dict[str, Any]]: ...
    def data_versions(self, form_ids: list[str]) -> dict[str, int]: ...
    def explain(self, query: CompiledQuery, analyze: bool = False) -> dict[str, Any]: ...
    def sleep(self, ms: int) -> None: ...


def _col(name: str, allowed: set[str]) -> str:
    if name not in allowed:
        raise ValueError(f"column not allowed: {name}")
    return name


class SqlQueryCompiler:
    def __init__(self, plan: QueryPlan):
        self.plan = plan
        self.params: list[Any] = []
        self._alias = 0

    def _next(self, prefix: str) -> str:
        self._alias += 1
        return f"{prefix}{self._alias}"

    def _bind(self, *values: Any) -> str:
        self.params.extend(values)
        return ", ".join("?" for _ in values)

    # Predicates --------------------------------------------------------------------------
    def _cond(self, column: str, op: str, values: tuple[Any, ...]) -> str:
        if op in COMPARE:
            return f"{column} {COMPARE[op]} {self._bind(values[0])}"
        if op == "in":
            return f"{column} IN ({self._bind(*values)})"
        if op == "between":
            return f"{column} >= {self._bind(values[0])} AND {column} <= {self._bind(values[1])}"
        if op == "prefix":
            return f"{column} >= {self._bind(values[0])} AND {column} < {self._bind(str(values[0]) + PREFIX_UPPER)}"
        raise ValueError(f"operator not allowed: {op}")

    def _index_exists(self, record: str, terms: list[Leaf], negate: bool = False) -> str:
        alias = self._next("i")
        parts = [f"{alias}.record_id = {record}.record_id", f"{alias}.form_id = {self._bind(self.plan.form_id)}"]
        if self.plan.live and not negate:
            parts.append(f"{alias}.{LIVE_INDEX}")
        clauses = []
        for leaf in terms:
            clause = f"{alias}.field_id = {self._bind(leaf.field)}"
            if leaf.kind == "index":
                clause += " AND " + self._cond(f"{alias}.{_col(leaf.column, VALUE_COLUMNS)}", leaf.op, leaf.values)
            clauses.append(clause)
        parts.append(clauses[0] if len(clauses) == 1 else "(" + " OR ".join(f"({clause})" for clause in clauses) + ")")
        body = " AND ".join(parts)
        return f"{'NOT ' if negate else ''}EXISTS (SELECT 1 FROM formdev_record_index {alias} WHERE {body})"

    def _meta(self, record: str, leaf: Leaf) -> str:
        column = f"{record}.{_col(leaf.column, RECORD_COLUMNS)}"
        if leaf.op == "is_null":
            return f"{column} IS NULL"
        if leaf.op == "is_not_null":
            return f"{column} IS NOT NULL"
        if leaf.column in NULLABLE_COLUMNS:
            return f"({column} IS NOT NULL AND {self._cond(column, leaf.op, leaf.values)})"
        return self._cond(column, leaf.op, leaf.values)

    def predicate(self, node: Leaf | Node | None, record: str = "k") -> str:
        if node is None:
            return ""
        if isinstance(node, Leaf):
            if node.kind == "meta":
                return self._meta(record, node)
            if node.kind == "missing":
                return self._index_exists(record, [node], negate=True)
            return self._index_exists(record, [node])
        if node.op == "not":
            return f"NOT ({self.predicate(node.args[0], record)})"
        children = list(node.args)
        if node.op == "or" and len(children) > 1 and all(isinstance(c, Leaf) and c.kind in ("index", "present") for c in children):
            # One EXISTS with an inner OR: a single semi-join over the index (BitmapOr on PostgreSQL).
            return self._index_exists(record, children)
        joiner = " AND " if node.op == "and" else " OR "
        return "(" + joiner.join(self.predicate(child, record) for child in children) + ")"

    def _scope(self, record: str = "k") -> str:
        sql = f"{record}.form_id = {self._bind(self.plan.form_id)}"
        if self.plan.live:
            sql += f" AND {record}.status <> 'deleted'"
        where = self.predicate(self.plan.where, record)
        return f"{sql} AND {where}" if where else sql

    # Statements ----------------------------------------------------------------------------
    def _output_columns(self) -> str:
        meta = [f"r.{_col(column, RECORD_COLUMNS)}" for column in self.plan.meta_columns if column not in ("record_id", "schema_version")]
        return ", ".join(["r.record_id", "r.schema_version", "r.data", *meta])

    def list_query(self) -> CompiledQuery:
        order = self.plan.order
        assert order is not None
        if order.kind == "field":
            return self._field_sorted_list()
        direction = DIRECTIONS[order.direction]
        column = _col(order.column, RECORD_COLUMNS)
        scope = self._scope("k")
        keyset = ""
        if self.plan.keyset is not None:
            compare = "<" if order.direction == "desc" else ">"
            if order.unique:
                keyset = f" AND k.{column} {compare} {self._bind(self.plan.keyset[0])}"
            else:
                bound = "<=" if order.direction == "desc" else ">="
                value, record_id = self.plan.keyset
                # Sargable leading bound + row comparison: an index range start, not a filter.
                keyset = (f" AND k.{column} {bound} {self._bind(value)}"
                          f" AND (k.{column}, k.record_id) {compare} ({self._bind(value)}, {self._bind(record_id)})")
        tie = "" if order.unique else f", k.record_id {direction}"
        page_tie = "" if order.unique else f", page.rid {direction}"
        limit = self._bind(self.plan.limit + 1)
        offset = f" OFFSET {self._bind(self.plan.offset)}" if self.plan.offset else ""
        sql = (f"SELECT {self._output_columns()}, page.ok AS order_value FROM ("
               f"SELECT k.record_id AS rid, k.{column} AS ok FROM formdev_record k WHERE {scope}{keyset}"
               f" ORDER BY k.{column} {direction}{tie} LIMIT {limit}{offset}) page"
               f" JOIN formdev_record r ON r.record_id = page.rid ORDER BY page.ok {direction}{page_tie}")
        return CompiledQuery(sql, tuple(self.params))

    def _field_sorted_list(self) -> CompiledQuery:
        """Offset pages sorted by an indexed field, NULLs (missing values) last, record_id tiebreak.
        Branch 1 walks the field's index rows in order; branch 2 appends records without a value."""
        order = self.plan.order
        assert order is not None and order.field
        direction = DIRECTIONS[order.direction]
        value = _col(order.column, VALUE_COLUMNS)
        window = self.plan.offset + self.plan.limit + 1
        live_s = " AND s.status <> 'deleted'" if self.plan.live else ""
        branch1 = (f"SELECT k.record_id AS rid, s.{value} AS sv, 0 AS nb FROM formdev_record_index s"
                   f" JOIN formdev_record k ON k.record_id = s.record_id"
                   f" WHERE s.form_id = {self._bind(self.plan.form_id)} AND s.field_id = {self._bind(order.field)}"
                   f" AND s.{value} IS NOT NULL{live_s} AND {self._scope('k')}"
                   f" ORDER BY s.{value} {direction}, k.record_id {direction} LIMIT {self._bind(window)}")
        missing = self._next("m")
        null_type = "DOUBLE PRECISION" if value == "value_num" else "TEXT"  # typed NULL: PostgreSQL resolves a bare NULL to text
        branch2 = (f"SELECT k.record_id AS rid, CAST(NULL AS {null_type}) AS sv, 1 AS nb FROM formdev_record k WHERE {self._scope('k')}"
                   f" AND NOT EXISTS (SELECT 1 FROM formdev_record_index {missing} WHERE {missing}.record_id = k.record_id"
                   f" AND {missing}.field_id = {self._bind(order.field)})"
                   f" ORDER BY k.record_id {direction} LIMIT {self._bind(window)}")
        limit = self._bind(self.plan.limit + 1)
        offset = self._bind(self.plan.offset)
        sql = (f"SELECT {self._output_columns()}, page.sv AS order_value FROM ("
               f"SELECT * FROM ({branch1}) b1 UNION ALL SELECT * FROM ({branch2}) b2) page"
               f" JOIN formdev_record r ON r.record_id = page.rid"
               f" ORDER BY page.nb, page.sv {direction}, page.rid {direction} LIMIT {limit} OFFSET {offset}")
        return CompiledQuery(sql, tuple(self.params))

    def count_query(self) -> CompiledQuery:
        scope = self._scope("k")
        cap = self._bind(self.plan.count_cap + 1)
        return CompiledQuery(f"SELECT COUNT(*) AS total FROM (SELECT 1 AS one FROM formdev_record k WHERE {scope} LIMIT {cap}) c", tuple(self.params))

    def aggregate_query(self) -> CompiledQuery:
        """One pivot pass: per record, the needed index values become columns (fN), metadata group
        columns and day buckets are computed inside (mN); the outer query groups and aggregates.
        Parameters are bound in the order they appear in the SQL text."""
        plan = self.plan
        fields: dict[str, str] = {}
        for key in plan.group:
            if key.kind == "field":
                fields.setdefault(key.field, key.column)
        for agg in plan.aggregates:
            if agg.field:
                fields.setdefault(agg.field, agg.column)
        field_alias = {field_id: f"f{index}" for index, field_id in enumerate(fields)}

        inner_cols = ["k.record_id AS rid"]
        inner_group = ["k.record_id"]
        key_source: list[str] = []
        for index, key in enumerate(plan.group):
            if key.kind == "field":
                key_source.append(f"p.{field_alias[key.field]}")
                continue
            column = f"k.{_col(key.column, RECORD_COLUMNS)}"
            expr = f"(({column} + {self._bind(key.offset_ms)}) / {int(key.bucket_ms)})" if key.bucket_ms else column
            inner_cols.append(f"{expr} AS m{index}")
            inner_group.append(column)
            key_source.append(f"p.m{index}")
        join = ""
        if fields:
            inner_cols += [f"MAX(CASE WHEN x.field_id = {self._bind(field_id)} THEN x.{_col(column, VALUE_COLUMNS)} END) AS {field_alias[field_id]}"
                           for field_id, column in fields.items()]
            join = f" LEFT JOIN formdev_record_index x ON x.record_id = k.record_id AND x.field_id IN ({self._bind(*fields)})"
        inner = f"SELECT {', '.join(inner_cols)} FROM formdev_record k{join} WHERE {self._scope('k')} GROUP BY {', '.join(inner_group)}"

        outputs = [f"{source} AS g{index}" for index, source in enumerate(key_source)]
        for index, agg in enumerate(plan.aggregates):
            target = "*" if agg.fn == "count" and not agg.field else f"p.{field_alias[agg.field]}"
            outputs.append(f"{AGG_SQL[agg.fn]}({target}) AS a{index}")
        group_clause = f" GROUP BY {', '.join(key_source)}" if key_source else ""
        grouped = f"SELECT {', '.join(outputs)} FROM ({inner}) p{group_clause}"

        name_to_alias = {key.name: f"g{index}" for index, key in enumerate(plan.group)}
        name_to_alias.update({agg.alias: f"a{index}" for index, agg in enumerate(plan.aggregates)})
        order_parts = [f"(q.{name_to_alias[name]} IS NULL), q.{name_to_alias[name]} {DIRECTIONS[direction]}" for name, direction in plan.group_order]
        order_parts += [f"(q.g{index} IS NULL), q.g{index} ASC" for index in range(len(plan.group))]
        order_clause = f" ORDER BY {', '.join(order_parts)}" if order_parts else ""
        limit = self._bind(plan.limit + 1)
        offset = f" OFFSET {self._bind(plan.offset)}" if plan.offset else ""
        return CompiledQuery(f"SELECT * FROM ({grouped}) q{order_clause} LIMIT {limit}{offset}", tuple(self.params))

    def compile(self) -> CompiledQuery:
        if self.plan.kind == "list":
            return self.list_query()
        if self.plan.kind == "count":
            return self.count_query()
        return self.aggregate_query()


def compile_plan(plan: QueryPlan) -> CompiledQuery:
    return SqlQueryCompiler(plan).compile()


def relation_lookup(form_id: str, field_id: str, column: str, keys: list[Any]) -> CompiledQuery:
    """Candidate target records for a many-to-one relation (live rows only, via the live index): at most two
    per key, ranked submitted first, then most recently updated, then record_id (relation_rank 1 is the match;
    a second row means the key is ambiguous)."""
    column = _col(column, VALUE_COLUMNS)
    placeholders = ", ".join("?" for _ in keys)
    ranked = (f"SELECT x.{column} AS relation_key, r.record_id, r.status, r.updated_at, r.schema_version, r.data,"
              f" ROW_NUMBER() OVER (PARTITION BY x.{column} ORDER BY CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END DESC,"
              f" r.updated_at DESC, r.record_id DESC) AS relation_rank"
              f" FROM formdev_record_index x JOIN formdev_record r ON r.record_id = x.record_id"
              f" WHERE x.form_id = ? AND x.field_id = ? AND x.{column} IN ({placeholders}) AND x.status <> 'deleted'")
    sql = f"SELECT * FROM ({ranked}) candidates WHERE relation_rank <= 2"
    return CompiledQuery(sql, (form_id, field_id, *keys))
