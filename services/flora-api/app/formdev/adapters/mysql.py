"""FormDev storage on MySQL 8.0.19+ / 8.4 (data layer: MySQL), through PyMySQL.

The statements are the portable ones in sql.py and sql_query.py; this adapter only translates the few vendor
differences:

* ``?`` placeholders -> PyMySQL's ``%s`` (literal ``%`` doubled);
* ``ON CONFLICT (...) DO UPDATE SET ... excluded.x`` -> ``AS excluded ON DUPLICATE KEY UPDATE ...`` (row alias,
  8.0.19+) and ``ON CONFLICT (...) DO NOTHING`` -> ``ON DUPLICATE KEY UPDATE <key> = <key>``;
* ``CAST(NULL AS TEXT / DOUBLE PRECISION)`` -> ``CHAR`` / ``DOUBLE``;
* connections use CLIENT.FOUND_ROWS, so UPDATE rowcounts are rows matched (compare-and-set claims and
  fenced job updates rely on it), not rows changed.

Schema: mysql_schema.sql (migration 1) and the generated mysql_0002_registry.sql, applied on open and tracked in
formdev_schema_migration. JSON is LONGTEXT encoded by the adapter; utf8mb4_bin keeps comparisons byte-ordered
like the other vendors. Query sessions are READ ONLY transactions with max_execution_time as the deadline.
Select it with FORMDEV_STORAGE=mysql://user:password@host:3306/database.
"""
from __future__ import annotations

import json
import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .sql import SqlDataAdapter
from .sql_query import CompiledQuery, QueryFailed, QueryTimeout

HERE = Path(__file__).parent
MIGRATIONS: tuple[Path, ...] = (HERE / "mysql_schema.sql", HERE / "mysql_0002_registry.sql")
# Re-applied whenever the registry changes (generated, idempotent); the schema runs once.
ALWAYS = {"mysql_0002_registry.sql"}

UPSERT = re.compile(r"\s+ON CONFLICT \(([^)]*)\) DO UPDATE SET\s+", re.IGNORECASE)
IGNORE = re.compile(r"\s+ON CONFLICT \(([^)]*)\) DO NOTHING", re.IGNORECASE)
NULL_TYPES = {"CAST(NULL AS TEXT)": "CAST(NULL AS CHAR)", "CAST(NULL AS DOUBLE PRECISION)": "CAST(NULL AS DOUBLE)"}
TIMEOUT_ERRORS = {3024, 1317, 1028}  # max_execution_time exceeded, query interrupted, sort aborted


def translate(sql: str) -> str:
    """Portable SQL with ``?`` placeholders -> MySQL with PyMySQL ``%s`` placeholders."""
    if UPSERT.search(sql):
        sql = UPSERT.sub(" AS excluded ON DUPLICATE KEY UPDATE ", sql)
    sql = IGNORE.sub(lambda match: f" ON DUPLICATE KEY UPDATE {match.group(1).split(',')[0].strip()} = {match.group(1).split(',')[0].strip()}", sql)
    for portable, native in NULL_TYPES.items():
        sql = sql.replace(portable, native)
    return sql.replace("%", "%%").replace("?", "%s")


def split_script(script: str) -> list[str]:
    """Statements of a migration file; ``DELIMITER x`` lines switch the terminator as in the mysql client."""
    statements: list[str] = []
    delimiter = ";"
    current: list[str] = []
    for line in script.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith("DELIMITER "):
            delimiter = stripped.split(None, 1)[1]
            continue
        if not current and (not stripped or stripped.startswith("--")):
            continue
        current.append(line)
        if stripped.endswith(delimiter):
            text = "\n".join(current).rstrip()
            statements.append(text[: -len(delimiter)].rstrip())
            current = []
    if "\n".join(current).strip():
        statements.append("\n".join(current).strip())
    return statements


def connect(url: str) -> Any:
    import pymysql  # optional dependency: only MySQL deployments need it
    from pymysql.constants import CLIENT
    from pymysql.cursors import DictCursor

    parsed = urlparse(url)
    return pymysql.connect(
        host=parsed.hostname or "localhost", port=parsed.port or 3306, user=unquote(parsed.username or ""), password=unquote(parsed.password or ""),
        database=parsed.path.lstrip("/"), charset="utf8mb4", cursorclass=DictCursor, autocommit=True, init_command="SET time_zone = '+00:00'",
        # rowcount = rows matched, as on PostgreSQL and SQLite: fenced updates that rewrite identical values still succeed.
        client_flag=CLIENT.FOUND_ROWS,
    )


class MySqlReadSession:
    def __init__(self, adapter: "MySQLAdapter"):
        self.adapter = adapter

    def fetch(self, query: CompiledQuery) -> list[dict[str, Any]]:
        rows = self.adapter._rows(self.adapter._raw(translate(query.sql), query.params))
        for row in rows:
            if isinstance(row.get("data"), str):
                row["data"] = json.loads(row["data"])
        return rows

    def data_versions(self, form_ids: list[str]) -> dict[str, int]:
        if not form_ids:
            return {}
        marks = ", ".join("?" for _ in form_ids)
        rows = self.adapter._rows(self.adapter._raw(translate(f"SELECT form_id, version FROM formdev_data_version WHERE form_id IN ({marks})"), tuple(form_ids)))
        found = {row["form_id"]: int(row["version"]) for row in rows}
        return {form_id: found.get(form_id, 0) for form_id in form_ids}

    def explain(self, query: CompiledQuery, analyze: bool = False) -> dict[str, Any]:
        row = self.adapter._rows(self.adapter._raw("EXPLAIN FORMAT=JSON " + translate(query.sql), query.params))[0]
        plan = json.loads(next(iter(row.values())))
        indexes: set[str] = set()
        full_scan = False
        access: list[str] = []

        def walk(node: Any) -> None:
            nonlocal full_scan
            if isinstance(node, dict):
                if isinstance(node.get("table"), dict):
                    table = node["table"]
                    access.append(f"{table.get('table_name')}:{table.get('access_type')}")
                    if table.get("key"):
                        indexes.add(table["key"])
                    if table.get("access_type") == "ALL" and table.get("table_name") in ("k", "r", "s", "x"):
                        full_scan = True
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(plan)
        cost = plan.get("query_block", {}).get("cost_info", {}).get("query_cost")
        return {"indexes_used": sorted(indexes), "full_scan": full_scan, "node_types": access, "est_rows": None,
                "rows_scanned": None, "buffers": None, "planning_ms": None, "execution_ms": None, "cost": cost}

    def sleep(self, ms: int) -> None:
        # SLEEP() interrupted by max_execution_time returns 1 instead of raising: report it as the timeout.
        row = self.adapter._rows(self.adapter._raw("SELECT SLEEP(%s) AS slept", (ms / 1000,)))[0]
        if int(row["slept"]) == 1:
            raise QueryTimeout()


class MySQLAdapter(SqlDataAdapter):
    vendor = "mysql"
    row_locks = True
    capabilities = {"explain_analyze": False, "row_estimate": False}

    def __init__(self, url: str | None = None, connection: Any = None):
        self.connection = connection if connection is not None else connect(url or "")
        self._url = url
        self._reconnect = connection is None
        self._depth = 0
        self.lock = threading.RLock()
        self._migrate()

    # Schema ------------------------------------------------------------------------------------
    def _migrate(self) -> None:
        with self.lock:
            self._raw("CREATE TABLE IF NOT EXISTS formdev_schema_migration (name varchar(191) NOT NULL PRIMARY KEY, applied_at bigint NOT NULL) "
                      "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin")
            done = {row["name"] for row in self._rows(self._raw("SELECT name FROM formdev_schema_migration"))}
            for path in MIGRATIONS:
                if path.name in done and path.name not in ALWAYS:
                    continue
                # DDL commits implicitly in MySQL, so each statement stands alone; every one is idempotent.
                for statement in split_script(path.read_text(encoding="utf-8")):
                    self._raw(statement)
                self._raw("INSERT INTO formdev_schema_migration (name, applied_at) VALUES (%s, UNIX_TIMESTAMP() * 1000) "
                          "ON DUPLICATE KEY UPDATE applied_at = VALUES(applied_at)", (path.name,))

    @property
    def schema_version(self) -> int:
        return len(self._rows(self._raw("SELECT name FROM formdev_schema_migration")))

    def close(self) -> None:
        self.connection.close()

    # Execution ---------------------------------------------------------------------------------
    def _raw(self, sql: str, params: tuple[Any, ...] | None = None) -> Any:
        with self.lock:
            if self._depth == 0 and getattr(self, "_reconnect", False):
                # MySQL closes idle connections (wait_timeout): reconnect between transactions, never inside one.
                self.connection.ping(reconnect=True)
            cursor = self.connection.cursor()
            cursor.execute(sql, params)
            return cursor

    def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        return self._raw(translate(sql), params)

    def _rows(self, cursor: Any) -> list[dict[str, Any]]:
        rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
        cursor.close()
        return [{key: (bytes(value) if isinstance(value, bytearray) else value) for key, value in row.items()} for row in rows]

    def _encode_json(self, value: Any) -> Any:
        return None if value is None else json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    def _decode_json(self, value: Any) -> Any:
        return json.loads(value) if isinstance(value, str) else value

    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self.lock:
            if self._depth == 0:
                self._raw("START TRANSACTION")
            else:
                self._raw(f"SAVEPOINT formdev_{self._depth}")
            self._depth += 1
            try:
                yield
            except BaseException:
                self._depth -= 1
                if self._depth == 0:
                    self._raw("ROLLBACK")
                else:
                    self._raw(f"ROLLBACK TO SAVEPOINT formdev_{self._depth}")
                    self._raw(f"RELEASE SAVEPOINT formdev_{self._depth}")
                raise
            self._depth -= 1
            if self._depth == 0:
                self._raw("COMMIT")
            else:
                self._raw(f"RELEASE SAVEPOINT formdev_{self._depth}")

    def interrupt(self) -> None:
        # The running statement is killed from a second connection (KILL QUERY); the session itself survives.
        if not self._url:
            return
        killer = connect(self._url)
        try:
            killer.cursor().execute("KILL QUERY %s", (self.connection.thread_id(),))
        finally:
            killer.close()

    def lock_job_quota(self, owner_user_id: Any) -> None:
        # Row locks held to commit: a global one and one per owner (PostgreSQL uses advisory locks).
        for key in ("formdev_job:global", f"formdev_job:{owner_user_id}"):
            self._execute("INSERT INTO formdev_job_lock (lock_key) VALUES (?) ON CONFLICT (lock_key) DO NOTHING", (key,))
            self._execute("SELECT lock_key FROM formdev_job_lock WHERE lock_key = ? FOR UPDATE", (key,))

    @contextmanager
    def read_session(self, timeout_ms: int, purpose: str = "interactive") -> Iterator[MySqlReadSession]:
        """A READ ONLY transaction; max_execution_time stops each SELECT at the deadline."""
        import pymysql

        with self.lock:
            self._raw("SET SESSION max_execution_time = %s", (int(timeout_ms),))
            self._raw("START TRANSACTION READ ONLY")
            try:
                yield MySqlReadSession(self)
                self._raw("COMMIT")
            except pymysql.err.OperationalError as error:
                self._raw("ROLLBACK")
                if error.args and error.args[0] in TIMEOUT_ERRORS:
                    raise QueryTimeout() from None
                raise QueryFailed(f"mysql_{error.args[0] if error.args else 'error'}") from None
            except pymysql.err.MySQLError as error:
                self._raw("ROLLBACK")
                raise QueryFailed(f"mysql_{error.args[0] if error.args else 'error'}") from None
            except BaseException:
                self._raw("ROLLBACK")
                raise
            finally:
                self._raw("SET SESSION max_execution_time = 0")
