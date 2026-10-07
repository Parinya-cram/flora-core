"""Query execution (Phase 4): validate -> route -> read session -> cache -> fetch -> project.

The engine never builds SQL itself and never sees the database vendor: plans go to the
adapter's compiler and read session. Projection happens here, after migrating each row to the
catalog's schema version, so results are identical on every vendor and old records stay readable.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from ..adapters.sql_query import QueryFailed, QueryTimeout, SqlQueryCompiler, compile_plan, relation_lookup
from ..errors import FormDevError
from ..field_types import INDEX_FAMILY
from ..migration import migrate
from . import cursor as cursors
from .access import DIAGNOSTICS_PERMISSION, Principal
from .cache import QueryCache
from .catalog import SourceCatalog, build_catalog
from .limits import ConcurrencyLimiter, RateLimiter
from .plan import QueryPlan, build_plan, count_plan
from .policy import policy as default_policy
from .stats import StatsCollector
from .validator import validate_query

LOG = logging.getLogger("formdev.query")
DAY_MS = 86_400_000


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class QueryRuntime:
    """Process-wide query state, created once (app lifespan) and shared by every request."""

    policy: dict[str, Any] = field(default_factory=default_policy)
    cursor_secret: bytes = b""
    clock_ms: Callable[[], int] = now_ms
    test_hooks: bool = False
    cache: QueryCache | None = None
    rate: RateLimiter | None = None
    # GET /records: paged pulls by offline clients, separate from interactive queries (no concurrency slot).
    pull_rate: RateLimiter | None = None
    concurrency: ConcurrencyLimiter | None = None
    stats: StatsCollector | None = None

    def __post_init__(self) -> None:
        if not self.cursor_secret:
            secret = os.getenv("FORMDEV_CURSOR_SECRET") or os.getenv("FLORA_CANOPY_SESSION_SECRET") or ""
            self.cursor_secret = (secret or uuid.uuid4().hex).encode("utf-8")
        self.cache = self.cache or QueryCache()
        self.rate = self.rate or RateLimiter(self.policy["rate"]["per_minute"], self.policy["rate"]["burst"])
        self.pull_rate = self.pull_rate or RateLimiter(self.policy["pull_rate"]["per_minute"], self.policy["pull_rate"]["burst"])
        self.concurrency = self.concurrency or ConcurrencyLimiter(self.policy["concurrency"]["per_user"], self.policy["concurrency"]["global"])
        self.stats = self.stats or StatsCollector(self.clock_ms)


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _strip_refs(node: Any, with_values: bool) -> Any:
    if isinstance(node, dict):
        if node.get("leaf"):
            out = {"f": node["ref"]["name"], "op": node["op"]}
            if with_values:
                out["v"] = node["values"]
            return out
        if "args" in node:
            return {node["op"]: [_strip_refs(child, with_values) for child in node["args"]]}
        if "arg" in node:
            return {"not": _strip_refs(node["arg"], with_values)}
    return node


def query_shape(spec: dict[str, Any]) -> dict[str, Any]:
    """Shape without values, limits, cursors or offsets (statistics, advisor)."""
    return {
        "source": spec["source"], "kind": spec["kind"],
        "select": [ref["name"] for ref in spec["select"]],
        "filter": _strip_refs(spec["filter"], False),
        "sort": [{"f": item["ref"]["name"] if "ref" in item else item["name"], "d": item["dir"]} for item in spec["sort"]],
        "group": [item["name"] for item in spec["group"]],
        "aggregate": [{"fn": a["fn"], "f": a["ref"]["name"] if a["ref"] else None} for a in spec["aggregate"]],
        "mode": spec["pagination"].get("mode"),
    }


def fingerprints(spec: dict[str, Any]) -> tuple[str, str]:
    shape = query_shape(spec)
    full = {**shape, "filter": _strip_refs(spec["filter"], True), "limit": spec["pagination"].get("limit"), "live": spec["live"],
            "aggregate": [{"fn": a["fn"], "f": a["ref"]["name"] if a["ref"] else None, "as": a["as"]} for a in spec["aggregate"]],
            "group": [[item["name"], item["tz_offset_minutes"]] for item in spec["group"]]}
    digest = lambda value: hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()[:32]  # noqa: E731
    return digest(shape), digest(full)


def _sensitive(spec: dict[str, Any], catalog: SourceCatalog) -> bool:
    names = {ref["name"] for ref in spec["select"]} | filter_fields_from_spec(spec)
    return any(catalog.fields.get(name, {}).get("access") for name in names) or any(catalog.metadata_access.get(name) for name in names)


def filter_fields_from_spec(spec: dict[str, Any]) -> set[str]:
    out: set[str] = set()

    def walk(node: Any) -> None:
        if not node:
            return
        if node.get("leaf"):
            out.add(node["ref"]["name"])
        elif "args" in node:
            for child in node["args"]:
                walk(child)
        else:
            walk(node["arg"])

    walk(spec["filter"])
    return out


def _output_value(value: Any, field_type: str | None) -> Any:
    if field_type == "integer" and isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _epoch_iso(value: float) -> str:
    """An aggregated datetime (epoch ms in the index) as an ISO-8601 instant in UTC."""
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def relation_column(foreign_type: str) -> str:
    """The index column a relation's foreign field is matched in (as index_entries writes it)."""
    return "value_num" if INDEX_FAMILY.get(foreign_type) in ("num", "bool") else "value_text"


def relation_key(value: Any, column: str) -> Any:
    """A local value in the foreign column's domain, or None when it cannot match (lists, objects, non-numbers
    for a numeric column). Used for binding and for finding the match again, so both sides agree."""
    if value is None or value == "" or isinstance(value, (list, dict)):
        return None
    if column == "value_num":
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if number == number and number not in (float("inf"), float("-inf")) else None
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


FILTER_FIRST_MAX_CANDIDATES = 100_000  # beyond this, sorting the matches costs more than any walk we would avoid


class QueryEngine:
    def __init__(self, runtime: QueryRuntime, services: Any, principal: Principal):
        self.runtime = runtime
        self.services = services
        self.adapter = services.adapter
        self.principal = principal

    # Validation --------------------------------------------------------------------------
    def catalog(self, source_id: Any) -> SourceCatalog | None:
        try:
            catalog = build_catalog(self.services, source_id)
        except FormDevError as error:
            if error.code in ("unknown_source", "invalid_relation", "form_not_published", "version_not_found"):
                return None
            raise
        return catalog if catalog.can_query(self.principal) else None

    def validate(self, body: Any) -> tuple[list[Any], dict[str, Any] | None, SourceCatalog | None]:
        source = body.get("query", {}).get("source") if isinstance(body, dict) and isinstance(body.get("query"), dict) else None
        catalog = self.catalog(source) if isinstance(source, str) else None
        issues, spec = validate_query(body, catalog, self.principal, self.runtime.policy)
        return issues, spec, catalog

    def require_valid(self, body: Any) -> tuple[list[Any], dict[str, Any], SourceCatalog]:
        issues, spec, catalog = self.validate(body)
        if spec is None or catalog is None:
            missing = sorted({issue.field for issue in issues if issue.field and issue.code == "not_filterable"})
            if missing and catalog is not None:
                # Advisor input: which fields people try to filter/sort/group on without an index.
                shape = {"source": catalog.source_id, "rejected_not_indexed": missing}
                digest = hashlib.sha256(_canonical(shape).encode()).hexdigest()[:32]
                self.runtime.stats.record(digest, catalog.source_id, shape, "rejected", 0, 0)
            raise FormDevError("invalid_query", "The query is not valid", 422, [issue.as_dict() for issue in issues])
        return issues, spec, catalog

    # Execution -----------------------------------------------------------------------------
    def run(self, body: Any, refresh: bool = False, explain: bool = False, test_sleep_ms: int | None = None) -> dict[str, Any]:
        """test_sleep_ms is honoured only when the runtime enables test hooks (timeout tests)."""
        started = time.monotonic()
        issues, spec, catalog = self.require_valid(body)
        shape_fp, query_fp = fingerprints(spec)
        if explain and not self.principal.has(DIAGNOSTICS_PERMISSION):
            raise FormDevError("diagnostics_forbidden", "Query diagnostics need the formdev.diagnostics permission", 403)
        outcome, rows_out = "rejected", 0
        try:
            result = self._run(spec, catalog, query_fp, refresh, explain, test_sleep_ms if self.runtime.test_hooks else None)
            outcome, rows_out = "ok", len(result["rows"])
        except FormDevError as error:
            outcome = "timeouts" if error.code == "query_timeout" else "rejected"
            raise
        finally:
            elapsed = int((time.monotonic() - started) * 1000)
            self.runtime.stats.record(shape_fp, spec["source"], query_shape(spec), outcome, elapsed, rows_out)
            if outcome != "ok":
                LOG.warning("formdev query %s %s after %d ms (source %s)", shape_fp, outcome, elapsed, spec["source"])
        result["warnings"] = [issue.as_dict() for issue in issues if issue.severity == "warning"]
        diagnostics = result.setdefault("diagnostics", {})
        diagnostics.update({"execution_ms": int((time.monotonic() - started) * 1000), "rows_returned": len(result["rows"]),
                            "query_type": spec["kind"], "fingerprint": shape_fp})
        if _sensitive(spec, catalog):
            self.audit("query", spec, catalog, shape_fp, len(result["rows"]))
        return result

    def _session(self, timeout_ms: int, purpose: str = "interactive"):
        return self.adapter.read_session(timeout_ms, purpose)

    def probe_rows(self, spec: dict[str, Any], cap: int) -> int | None:
        """Capped count under a short deadline; None when the probe itself runs out of time."""
        try:
            with self._session(self.runtime.policy["probe_timeout_ms"]) as session:
                return int(session.fetch(compile_plan(count_plan(spec, cap)))[0]["total"])
        except QueryTimeout:
            return None

    def _keyset(self, spec: dict[str, Any], query_fp: str) -> tuple[Any, ...] | None:
        token = spec["pagination"].get("cursor")
        if not token:
            return None
        order = build_plan(spec).order
        kind = "record_id" if order.column == "record_id" else "number"
        return cursors.decode(self.runtime.cursor_secret, token, query_fp, self.principal.user_id, self.runtime.clock_ms(), kind, order.unique)

    def _run(self, spec: dict[str, Any], catalog: SourceCatalog, query_fp: str, refresh: bool, explain: bool, test_sleep_ms: int | None) -> dict[str, Any]:
        policy = self.runtime.policy
        if spec["kind"] == "aggregate":
            threshold = policy["interactive_aggregate_max_rows"]
            probed = self.probe_rows(spec, threshold)
            if probed is None or probed > threshold:
                raise FormDevError("full_scan_requires_job", "This aggregate covers too many records to run interactively; run it as a report job", 409,
                                   {"hint": "POST /api/formdev/jobs with kind aggregate or report", "threshold": threshold})
        keyset = self._keyset(spec, query_fp)
        plan = build_plan(spec, keyset)
        compiled = compile_plan(plan)
        count = compile_plan(count_plan(spec, policy["count_cap"])) if spec["kind"] == "list" and spec["count"] == "capped" else None
        position = spec["pagination"].get("cursor") or spec["pagination"].get("offset")
        try:
            with self._session(spec["timeout_ms"]) as session:
                versions = session.data_versions(catalog.form_ids())
                key = hashlib.sha256(_canonical([query_fp, position, self.principal.scope_key(), catalog.revision, versions]).encode()).hexdigest()
                # Explain always runs the query: a cached result has no plan to show.
                cached = None if refresh or explain or not spec["cache_ttl_s"] else self.runtime.cache.get(key)
                if cached is not None:
                    result = json.loads(cached)
                    result["next_cursor"] = self._sign(result.pop("_cursor", None), query_fp)
                    result["diagnostics"] = {"cache_hit": True}
                    return result
                if test_sleep_ms:
                    session.sleep(test_sleep_ms)
                if spec["kind"] == "list" and self._filter_first(session, plan):
                    plan.drive = "filter"
                    compiled = compile_plan(plan)
                rows = session.fetch(compiled)
                total = int(session.fetch(count)[0]["total"]) if count else None
                relations = self._relations(session, spec, catalog, rows[: plan.limit]) if spec["kind"] == "list" else {}
                plan_info = session.explain(compiled, analyze=bool(self.adapter.capabilities.get("explain_analyze"))) if explain else None
        except QueryTimeout:
            raise FormDevError("query_timeout", f"The query took longer than {spec['timeout_ms']} ms. Narrow the filter or run it as a background job.", 504,
                               {"hint": "add a selective filter on an indexed field, lower the limit, or create an export job"}) from None
        except QueryFailed as failure:
            LOG.error("formdev query failed: %s", failure.code)
            raise FormDevError("query_failed", "The query could not be completed", 500) from None
        result = self._project(spec, catalog, plan, rows, relations, query_fp) if spec["kind"] == "list" else self._aggregate_rows(spec, catalog, plan, rows)
        if count is not None:
            result["total"] = min(total, policy["count_cap"])
            result["total_is_lower_bound"] = total > policy["count_cap"]
        encoded = json.dumps(result, ensure_ascii=False, default=str)
        if len(encoded.encode("utf-8")) > policy["max_result_bytes"]:
            raise FormDevError("result_too_large", "The result is too large to return interactively; select fewer fields, lower the limit or create an export job", 422)
        # Cached entries are shared by callers with the same roles: they keep the cursor's position unsigned,
        # and each caller gets a cursor signed for them.
        cursor = result.pop("_cursor", None)
        result["next_cursor"] = self._sign(cursor, query_fp)
        if spec["cache_ttl_s"]:
            shared = json.dumps({**result, "next_cursor": None, "_cursor": cursor}, ensure_ascii=False, default=str)
            self.runtime.cache.put(key, shared, spec["cache_ttl_s"], len(shared), set(catalog.form_ids()))
        result["diagnostics"] = {"cache_hit": False}
        if plan_info is not None:
            result["diagnostics"].update({"storage": self.adapter.vendor, "sql": compiled.sql, "plan": plan_info})
        return result

    def _filter_first(self, session: Any, plan: QueryPlan) -> bool:
        """The LIMIT trap: walking the order index finds a page quickly only where matches are dense. A bounded
        probe counts matches among the next DENSITY_WINDOW_PAGES pages of records; when there is less than a page,
        the expected walk (window x page / hits) is compared with the number of candidates the filter-first page
        would sort, counted through the index up to that size. Fewer candidates: collect and sort them instead."""
        compiler = SqlQueryCompiler(plan)
        if not compiler.can_drive_by_filter():
            return False
        hits = int(session.fetch(SqlQueryCompiler(plan).density_probe())[0]["hits"])
        if hits > plan.limit:
            return False
        walk = compiler.density_window() * (plan.limit + 1) // max(hits, 1) * (1 if hits else 2)
        cap = min(walk, FILTER_FIRST_MAX_CANDIDATES)
        candidates = int(session.fetch(SqlQueryCompiler(plan).candidate_count(cap))[0]["total"])
        return candidates <= cap

    # Results -------------------------------------------------------------------------------
    def _sign(self, values: list[Any] | None, query_fp: str) -> str | None:
        return cursors.encode(self.runtime.cursor_secret, values, query_fp, self.principal.user_id, self.runtime.clock_ms()) if values else None

    def _loader(self, form_id: str) -> Callable[[int], dict[str, Any]]:
        return self.services.schemas.loader(form_id)

    def _migrated(self, row: dict[str, Any], form_id: str, version: int) -> dict[str, Any]:
        data = row["data"] or {}
        stored = int(row["schema_version"])
        return data if stored == version else migrate(data, stored, version, self._loader(form_id))

    def _project(self, spec: dict[str, Any], catalog: SourceCatalog, plan: QueryPlan, rows: list[dict[str, Any]],
                 relations: dict[str, dict[Any, dict[str, Any]]], query_fp: str) -> dict[str, Any]:
        has_more = len(rows) > plan.limit
        page = rows[: plan.limit]
        out = []
        for row in page:
            data = self._migrated(row, catalog.form_id, catalog.schema_version)
            item: dict[str, Any] = {"$record_id": row["record_id"]}
            for ref in spec["select"]:
                if ref["kind"] == "meta":
                    item[ref["output"]] = row.get(ref["column"]) if ref["column"] != "record_id" else row["record_id"]
                elif ref["kind"] == "field":
                    item[ref["output"]] = _output_value(data.get(ref["field"]), ref["type"])
                else:
                    relation = catalog.relations[ref["relation"]]
                    column = relation_column(relation["target"].fields[relation["foreign"]]["type"])
                    key = relation_key(data.get(relation["local"]), column)
                    match = relations.get(ref["relation"], {}).get(key) if key is not None else None
                    item[ref["output"]] = match.get(ref["field"]) if match else None
            out.append(item)
        cursor = None
        if has_more and plan.order is not None and plan.order.kind == "meta" and spec["pagination"]["mode"] == "cursor":
            last = page[-1]
            cursor = [last["order_value"]] if plan.order.unique else [last["order_value"], last["record_id"]]
        # "_cursor": the unsigned position; the caller (_run) signs it for the requesting user.
        result: dict[str, Any] = {"rows": out, "next_cursor": None, "_cursor": cursor, "has_more": has_more, "truncated": False}
        if spec["pagination"]["mode"] == "offset":
            result["next_offset"] = plan.offset + plan.limit if has_more else None
        ambiguous = {name: info.pop("_ambiguous", 0) for name, info in relations.items() if "_ambiguous" in info}
        if any(ambiguous.values()):
            result["relation_ambiguous"] = ambiguous
        return result

    def _relations(self, session: Any, spec: dict[str, Any], catalog: SourceCatalog, rows: list[dict[str, Any]]) -> dict[str, dict[Any, dict[str, Any]]]:
        used = {ref["relation"] for ref in spec["select"] if ref["kind"] == "relation"}
        out: dict[str, dict[Any, dict[str, Any]]] = {}
        for name in sorted(used):
            relation = catalog.relations[name]
            target: SourceCatalog = relation["target"]
            foreign = target.fields[relation["foreign"]]
            column = relation_column(foreign["type"])
            keys = list(dict.fromkeys(
                key for key in (relation_key(self._migrated(row, catalog.form_id, catalog.schema_version).get(relation["local"]), column) for row in rows)
                if key is not None))
            matches: dict[Any, dict[str, Any]] = {}
            ambiguous = 0
            if keys and foreign.get("indexed") and foreign.get("state") != "building":
                # The database ranks candidates and returns at most two per key: the best, and one more to tell
                # that the key is ambiguous. A non-unique key never loads every matching record.
                candidates = session.fetch(relation_lookup(target.form_id, relation["foreign"], column, keys))
                best: dict[Any, dict[str, Any]] = {}
                counts: dict[Any, int] = {}
                for candidate in candidates:
                    key = relation_key(candidate["relation_key"], column)
                    counts[key] = counts.get(key, 0) + 1
                    if int(candidate["relation_rank"]) == 1:
                        best[key] = candidate
                ambiguous = sum(1 for value in counts.values() if value > 1)
                for key, candidate in best.items():
                    data = self._migrated(candidate, target.form_id, target.schema_version)
                    matches[key] = {fid: data.get(fid) for fid in target.fields if target.can_read(self.principal, fid)}
            if ambiguous:
                matches["_ambiguous"] = ambiguous  # type: ignore[index]
            out[name] = matches
        return out

    def _aggregate_rows(self, spec: dict[str, Any], catalog: SourceCatalog, plan: QueryPlan, rows: list[dict[str, Any]]) -> dict[str, Any]:
        truncated = len(rows) > plan.limit
        out = []
        for row in rows[: plan.limit]:
            item: dict[str, Any] = {}
            for index, key in enumerate(spec["group"]):
                value = row[f"g{index}"]
                if key["bucket"] and value is not None:
                    value = datetime.fromtimestamp(int(value) * DAY_MS / 1000, tz=timezone.utc).date().isoformat()
                elif key["ref"]["kind"] == "field" and key["ref"]["family"] == "bool" and value is not None:
                    value = bool(value)
                elif key["ref"]["kind"] == "field":
                    value = _output_value(value, key["ref"]["type"])
                item[key["name"]] = value
            for index, agg in enumerate(spec["aggregate"]):
                value = row[f"a{index}"]
                if agg["fn"] == "count":
                    value = int(value or 0)
                elif value is not None:
                    value = float(value)
                    if agg["fn"] in ("min", "max") and agg["ref"].get("family") == "datetime":
                        value = _epoch_iso(value)  # the index aggregates datetimes as epoch ms
                    elif agg["fn"] in ("min", "max"):
                        value = _output_value(value, agg["ref"]["type"])
                item[agg["as"]] = value
            out.append(item)
        return {"rows": out, "next_cursor": None, "has_more": truncated, "truncated": truncated,
                "next_offset": plan.offset + plan.limit if truncated else None}

    # Audit -----------------------------------------------------------------------------------
    def audit(self, action: str, spec: dict[str, Any] | None, catalog: SourceCatalog | None, fingerprint: str | None,
              row_count: int | None, job_id: str | None = None, sha256: str | None = None, required: bool = False) -> None:
        row = {
            "audit_id": str(uuid.uuid4()), "at": self.runtime.clock_ms(), "actor_user_id": self.principal.user_id,
            "actor": self.principal.username, "actor_roles": list(self.principal.roles), "action": action,
            "source_id": catalog.source_id if catalog else (spec or {}).get("source"), "fingerprint": fingerprint,
            "fields": [ref["name"] for ref in spec["select"]] if spec else [],
            "filter_fields": sorted(filter_fields_from_spec(spec)) if spec else [],
            "row_count": row_count, "job_id": job_id, "result_sha256": sha256, "client_ip": None,
        }
        try:
            with self.adapter.transaction():
                self.adapter.insert_audit(row)
        except Exception:  # noqa: BLE001
            LOG.error("formdev audit write failed for %s", action, exc_info=True)
            if required:
                raise FormDevError("audit_unavailable", "The action could not be audited and was not performed", 503) from None
