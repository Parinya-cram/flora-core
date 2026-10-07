from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .sql import SqlDataAdapter
from .sql_query import CompiledQuery, QueryFailed, QueryTimeout

HERE = Path(__file__).parent
# Ordered schema migrations; position n (1-based) becomes PRAGMA user_version n once applied.
# Files created before versioning (user_version 0) already hold migration 1, which is idempotent.
MIGRATIONS: tuple[Path, ...] = (
    HERE / "sqlite_schema.sql",
    HERE / "sqlite_0002_query.sql",
    HERE / "sqlite_0003_registry.sql",
    HERE / "sqlite_0004_lookup.sql",
    HERE / "sqlite_0005_attachment.sql",
)


class _Result:
    """A fully fetched statement result, so no cursor is shared between threads."""

    def __init__(self, cursor: sqlite3.Cursor):
        self.description = cursor.description
        self.rowcount = cursor.rowcount
        self._rows = cursor.fetchall() if cursor.description else []

    def fetchall(self) -> list[Any]:
        return self._rows

    def fetchone(self) -> Any:
        return self._rows[0] if self._rows else None


TABLE_SCAN = re.compile(r"^SCAN (k|r|s|x|i\d+|m\d+)\b(?!.*USING)")
INDEX_NAME = re.compile(r"USING (?:COVERING )?INDEX (\w+)")


class SqliteReadSession:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def fetch(self, query: CompiledQuery) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self.connection.execute(query.sql, query.params).fetchall()]
        for row in rows:
            if isinstance(row.get("data"), str):
                row["data"] = json.loads(row["data"])
        return rows

    def data_versions(self, form_ids: list[str]) -> dict[str, int]:
        if not form_ids:
            return {}
        placeholders = ", ".join("?" for _ in form_ids)
        rows = self.connection.execute(f"SELECT form_id, version FROM formdev_data_version WHERE form_id IN ({placeholders})", tuple(form_ids)).fetchall()
        found = {row["form_id"]: int(row["version"]) for row in rows}
        return {form_id: found.get(form_id, 0) for form_id in form_ids}

    def explain(self, query: CompiledQuery, analyze: bool = False) -> dict[str, Any]:
        details = [row["detail"] for row in self.connection.execute("EXPLAIN QUERY PLAN " + query.sql, query.params).fetchall()]
        return {
            "indexes_used": sorted({match.group(1) for detail in details for match in INDEX_NAME.finditer(detail)}),
            "full_scan": any(TABLE_SCAN.match(detail) for detail in details),
            "node_types": details,
            "est_rows": None,
            "rows_scanned": None,
            "buffers": None,
            "planning_ms": None,
            "execution_ms": None,
        }

    def sleep(self, ms: int) -> None:
        # No sleep() in SQLite: burn CPU until the progress-handler deadline interrupts it (test hook).
        self.connection.execute("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000) SELECT count(*) FROM c").fetchone()


class SQLiteAdapter(SqlDataAdapter):
    """Standalone / desktop storage. Needs only the Python standard library.

    ``path`` may be a file (WAL journal, survives restarts) or ``":memory:"`` for tests.
    Pending schema migrations are applied on open, each in its own transaction.
    """

    vendor = "sqlite"
    capabilities = {"explain_analyze": False, "row_estimate": False}

    def __init__(self, path: str | Path = ":memory:"):
        self.path = str(path)
        self._readers: set[sqlite3.Connection] = set()
        self.connection = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        if self.path != ":memory:":
            self.connection.execute("PRAGMA journal_mode = WAL")
        self._depth = 0
        # Serializes statements and transactions on the shared connection across request and
        # job-worker threads (re-entrant: a transaction holds it from BEGIN to COMMIT).
        self.lock = threading.RLock()
        self._migrate()

    @property
    def schema_version(self) -> int:
        return int(self.connection.execute("PRAGMA user_version").fetchone()[0])

    def _migrate(self) -> None:
        for number, path in enumerate(MIGRATIONS, start=1):
            if number <= self.schema_version:
                continue
            script = path.read_text(encoding="utf-8")
            try:
                self.connection.executescript(f"BEGIN IMMEDIATE;\n{script}\nPRAGMA user_version = {number};\nCOMMIT;")
            except BaseException:
                if self.connection.in_transaction:
                    self.connection.execute("ROLLBACK")
                raise

    def close(self) -> None:
        self.connection.close()

    def interrupt(self) -> None:
        # sqlite3.Connection.interrupt is safe from another thread; read sessions on file databases have their own.
        for connection in [self.connection, *self._readers]:
            try:
                connection.interrupt()
            except sqlite3.ProgrammingError:
                pass  # closed meanwhile

    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self.lock:
            yield from self._transaction()

    def _transaction(self) -> Iterator[None]:
        if self._depth == 0:
            self.connection.execute("BEGIN IMMEDIATE")
        else:
            self.connection.execute(f"SAVEPOINT formdev_{self._depth}")
        self._depth += 1
        try:
            yield
        except BaseException:
            self._depth -= 1
            if self._depth == 0:
                self.connection.execute("ROLLBACK")
            else:
                self.connection.execute(f"ROLLBACK TO formdev_{self._depth}")
                self.connection.execute(f"RELEASE formdev_{self._depth}")
            raise
        self._depth -= 1
        if self._depth == 0:
            self.connection.execute("COMMIT")
        else:
            self.connection.execute(f"RELEASE formdev_{self._depth}")

    def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        with self.lock:
            return _Result(self.connection.execute(sql, params))

    @contextmanager
    def read_session(self, timeout_ms: int, purpose: str = "interactive") -> Iterator[SqliteReadSession]:
        """File databases get a private read-only connection (WAL readers never block the writer
        or wait for the request lock); a progress-handler deadline interrupts long statements and
        is always removed afterwards. In-memory test databases reuse the main connection."""
        owned = self.path != ":memory:"
        if owned:
            connection = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, isolation_level=None, check_same_thread=False)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only = ON")
            self._readers.add(connection)
        else:
            # In-memory databases (tests) have no second connection; hold the lock for the session.
            self.lock.acquire()
            connection = self.connection
            connection.execute("PRAGMA query_only = ON")
        deadline = time.monotonic() + timeout_ms / 1000
        connection.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 1000)
        try:
            if owned:
                connection.execute("BEGIN")
            yield SqliteReadSession(connection)
        except sqlite3.OperationalError as error:
            if "interrupt" in str(error):
                raise QueryTimeout() from None
            raise QueryFailed("sqlite_error") from None
        except sqlite3.DatabaseError:
            raise QueryFailed("sqlite_error") from None
        finally:
            connection.set_progress_handler(None, 0)
            if owned:
                self._readers.discard(connection)
                connection.close()
            else:
                connection.execute("PRAGMA query_only = OFF")
                self.lock.release()

    def _rows(self, cursor: Any) -> list[dict[str, Any]]:
        return [dict(row) for row in cursor.fetchall()] if cursor.description else []

    def _encode_json(self, value: Any) -> Any:
        return None if value is None else json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    def _decode_json(self, value: Any) -> Any:
        return json.loads(value) if isinstance(value, str) else value
