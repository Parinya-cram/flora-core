"""File-based storage (data layer: File adapter): every table as a JSON file in one directory.

For the simplest standalone setup: no database server and no database file format, only readable JSON that can
be copied, backed up and diffed. It is the SQLite adapter running in memory, so it has every feature (records,
sync, query engine, jobs, registry) and passes the same contract tests:

* on open, migrations build the schema in memory and ``<table>.json`` files are loaded into it;
* after every committed change, the tables whose content changed are written back, each through a temporary
  file renamed into place, so a crash leaves either the old or the new file, never half of one.

Limits: the whole data set lives in memory and every commit re-serialises the changed tables, so it suits small
installations (thousands of records). One process at a time: a lock file refuses a second writer.
Select it with FORMDEV_STORAGE=json:/path/to/folder.
"""
from __future__ import annotations

import base64
import json
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..errors import FormDevError
from .sqlite import SQLiteAdapter

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows: no advisory lock, one process by convention
    fcntl = None  # type: ignore[assignment]

FORMAT = "flora.formdev.jsonfiles/1"
BYTES_KEY = "$base64"


def _encode(value: Any) -> Any:
    return {BYTES_KEY: base64.b64encode(value).decode("ascii")} if isinstance(value, (bytes, bytearray, memoryview)) else value


def _decode(value: Any) -> Any:
    return base64.b64decode(value[BYTES_KEY]) if isinstance(value, dict) and set(value) == {BYTES_KEY} else value


class JsonFileAdapter(SQLiteAdapter):
    vendor = "jsonfiles"

    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._lock_file = self._acquire()
        super().__init__(":memory:")
        self._written: dict[str, str] = {}
        self._changes = 0
        with self.lock:
            self._load()
            self._changes = self.connection.total_changes
            self._flush(force=True)

    # Lock --------------------------------------------------------------------------------------
    def _acquire(self) -> Any:
        handle = open(self.directory / ".lock", "a+")  # noqa: SIM115 - held for the adapter's lifetime
        if fcntl is not None:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                handle.close()
                raise FormDevError("storage_locked", f"{self.directory} is open in another process", 503) from None
        return handle

    def close(self) -> None:
        try:
            with self.lock:
                self._flush()
            super().close()
        finally:
            self._lock_file.close()

    # Load / save -------------------------------------------------------------------------------
    def _tables(self) -> list[str]:
        rows = self.connection.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        return [row["name"] for row in rows]

    def _columns(self, table: str) -> list[str]:
        return [row["name"] for row in self.connection.execute(f'PRAGMA table_info("{table}")').fetchall()]

    def _load(self) -> None:
        # Seed rows from the migrations are replaced by what the files hold.
        self.connection.execute("PRAGMA foreign_keys = OFF")
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            for table in self._tables():
                path = self.directory / f"{table}.json"
                if not path.is_file():
                    continue
                rows = json.loads(path.read_text(encoding="utf-8"))
                known = self._columns(table)
                self.connection.execute(f'DELETE FROM "{table}"')
                for row in rows:
                    names = [name for name in known if name in row]
                    if not names:
                        continue
                    quoted = ", ".join(f'"{name}"' for name in names)
                    marks = ", ".join("?" for _ in names)
                    self.connection.execute(f'INSERT INTO "{table}" ({quoted}) VALUES ({marks})', tuple(_decode(row[name]) for name in names))
            self.connection.execute("COMMIT")
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise
        finally:
            self.connection.execute("PRAGMA foreign_keys = ON")

    def _dump(self, table: str) -> str:
        columns = self._columns(table)
        order = ", ".join(f'"{name}"' for name in columns)
        rows = [{name: _encode(row[name]) for name in columns} for row in self.connection.execute(f'SELECT * FROM "{table}" ORDER BY {order}').fetchall()]
        return json.dumps(rows, ensure_ascii=False, indent=1) + "\n"

    def _flush(self, force: bool = False) -> None:
        """Write the tables whose content changed since the last flush (all of them when ``force``)."""
        if self._depth > 0 or (not force and self.connection.total_changes == self._changes):
            return
        self._changes = self.connection.total_changes
        for table in self._tables():
            text = self._dump(table)
            if not force and self._written.get(table) == text:
                continue
            _write_atomic(self.directory / f"{table}.json", text)
            self._written[table] = text
        _write_atomic(self.directory / "manifest.json", json.dumps({"format": FORMAT, "schema_version": self.schema_version, "tables": self._tables()}, indent=1) + "\n")

    def _transaction(self) -> Iterator[None]:
        yield from super()._transaction()
        self._flush()

    def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        with self.lock:
            result = super()._execute(sql, params)
            self._flush()  # a statement outside a transaction commits on its own
            return result


def _write_atomic(path: Path, text: str) -> None:
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
