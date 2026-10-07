from __future__ import annotations

from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import Any

import psycopg
from psycopg import Connection
from psycopg.types.json import Jsonb

from .sql import SqlDataAdapter
from .sql_query import CompiledQuery, QueryFailed, QueryTimeout

PLAN_KEYS = ("Node Type", "Relation Name", "Index Name", "Plan Rows", "Actual Rows", "Actual Loops", "Shared Hit Blocks", "Shared Read Blocks")


def normalize_pg_plan(document: Any) -> dict[str, Any]:
    """Keep node types, relation/index names and row counts only: conditions and filters are
    dropped because PostgreSQL prints bound values (patient data) inside them."""
    root = document[0] if isinstance(document, list) else document
    plan = root["Plan"]
    nodes: list[dict[str, Any]] = []

    def walk(node: dict[str, Any]) -> None:
        nodes.append({key: node[key] for key in PLAN_KEYS if key in node})
        for child in node.get("Plans", []) or []:
            walk(child)

    walk(plan)
    scans = [n for n in nodes if "Scan" in n.get("Node Type", "")]
    indexes = sorted({n["Index Name"] for n in nodes if "Index Name" in n})
    analyzed = any("Actual Rows" in n for n in nodes)
    return {
        "indexes_used": indexes,
        "full_scan": any(n.get("Node Type") == "Seq Scan" and n.get("Relation Name", "").startswith("formdev_") for n in nodes),
        "node_types": [n.get("Node Type") for n in nodes],
        "est_rows": int(plan.get("Plan Rows", 0)),
        "rows_scanned": sum(int(n.get("Actual Rows", 0)) * int(n.get("Actual Loops", 1)) for n in scans) if analyzed else None,
        "buffers": sum(int(n.get("Shared Hit Blocks", 0)) + int(n.get("Shared Read Blocks", 0)) for n in nodes[:1]) if analyzed else None,
        "planning_ms": root.get("Planning Time"),
        "execution_ms": root.get("Execution Time"),
    }


class PgReadSession:
    def __init__(self, connection: Connection):
        self.connection = connection

    def fetch(self, query: CompiledQuery) -> list[dict[str, Any]]:
        cursor = self.connection.execute(query.sql.replace("?", "%s"), query.params, prepare=False)
        return [dict(row) for row in cursor.fetchall()]

    def data_versions(self, form_ids: list[str]) -> dict[str, int]:
        rows = self.connection.execute(
            "SELECT form_id, version FROM formdev_data_version WHERE form_id = ANY(%s)", (form_ids,), prepare=False
        ).fetchall()
        found = {row["form_id"]: int(row["version"]) for row in rows}
        return {form_id: found.get(form_id, 0) for form_id in form_ids}

    def explain(self, query: CompiledQuery, analyze: bool = False) -> dict[str, Any]:
        options = "ANALYZE, BUFFERS, FORMAT JSON" if analyze else "FORMAT JSON"
        row = self.connection.execute(f"EXPLAIN ({options}) " + query.sql.replace("?", "%s"), query.params, prepare=False).fetchone()
        return normalize_pg_plan(next(iter(row.values())))

    def sleep(self, ms: int) -> None:
        self.connection.execute("SELECT pg_sleep(%s)", (ms / 1000,), prepare=False)


class PostgreSQLAdapter(SqlDataAdapter):
    """FormDev storage on the Flora PostgreSQL service (schema: 0060-formdev.sql + 0061 + 0062 + 0063).

    Expects a psycopg connection using ``dict_row`` (as provided by app.database).
    """

    vendor = "postgresql"
    capabilities = {"explain_analyze": True, "row_estimate": True}

    def __init__(self, connection: Connection):
        self.connection = connection

    def transaction(self) -> AbstractContextManager[Any]:
        return self.connection.transaction()

    def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        return self.connection.execute(sql.replace("?", "%s"), params)

    def _rows(self, cursor: Any) -> list[dict[str, Any]]:
        return [dict(row) for row in cursor.fetchall()] if cursor.description else []

    def _encode_json(self, value: Any) -> Any:
        return None if value is None else Jsonb(value)

    def _decode_json(self, value: Any) -> Any:
        return value

    def interrupt(self) -> None:
        cancel = getattr(self.connection, "cancel_safe", None) or self.connection.cancel
        cancel()

    def lock_job_quota(self, owner_user_id: Any) -> None:
        # Transaction-scoped advisory locks: one per owner plus a global one, released at commit.
        self._execute("SELECT pg_advisory_xact_lock(hashtext(?))", ("formdev_job:global",))
        self._execute("SELECT pg_advisory_xact_lock(hashtext(?))", (f"formdev_job:{owner_user_id}",))

    @contextmanager
    def read_session(self, timeout_ms: int, purpose: str = "interactive") -> Iterator[PgReadSession]:
        """READ ONLY transaction with server-side deadlines. statement_timeout bounds each
        statement; interactive sessions also get transaction_timeout (PostgreSQL 17) for the whole
        session. Job sessions do not: on PostgreSQL 17 reaching transaction_timeout terminates the
        connection, and a job batch (fetch + relation lookups, each with its own statement deadline)
        must stay on a live connection to record its outcome. Custom plans are forced because
        selectivity in the index table depends on the bound values; JIT stays off for interactive work.
        On a statement timeout the transaction is rolled back and the connection is clean; when
        transaction_timeout ends an interactive session the pool discards the closed connection."""
        interactive = purpose == "interactive"
        settings = [("statement_timeout", f"{int(timeout_ms)}ms"), ("plan_cache_mode", "force_custom_plan"),
                    ("jit", "off" if interactive else "on"), ("max_parallel_workers_per_gather", "0" if interactive else "2"),
                    ("work_mem", "32MB" if interactive else "128MB")]
        if interactive and self.connection.info.server_version >= 170000:
            settings.append(("transaction_timeout", f"{int(timeout_ms) + 2000}ms"))
        try:
            with self.connection.transaction():
                self.connection.execute("SET TRANSACTION READ ONLY", prepare=False)
                self.connection.execute(
                    "SELECT " + ", ".join("set_config(%s, %s, true)" for _ in settings), [item for pair in settings for item in pair], prepare=False
                )
                yield PgReadSession(self.connection)
        except psycopg.errors.QueryCanceled:
            raise QueryTimeout() from None
        except psycopg.errors.IdleInTransactionSessionTimeout:
            raise QueryTimeout() from None
        except psycopg.errors.ReadOnlySqlTransaction:
            raise QueryFailed("read_only_violation") from None
        except psycopg.Error as error:
            # 25P04 transaction_timeout, 25P03 idle-in-transaction timeout: also deadlines.
            if error.sqlstate in ("57014", "25P03", "25P04"):
                raise QueryTimeout() from None
            raise QueryFailed(f"sqlstate_{error.sqlstate or 'unknown'}") from None
