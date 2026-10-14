"""Shared SQL implementation of DataAdapter.

Statements are written once in portable SQL with ``?`` placeholders. Everything that
differs between vendors (placeholder style, JSON encoding, upsert syntax, transactions)
is delegated to the concrete adapter. Every value is bound as a parameter; no
caller-supplied text is ever concatenated into SQL.
"""
from __future__ import annotations

from abc import abstractmethod
from typing import Any, Iterable

from .base import DataAdapter, IndexFilter

FORM_COLUMNS = ("form_id", "title", "latest_version", "published_version", "created_at", "created_by", "updated_at", "updated_by")
SCHEMA_COLUMNS = ("form_id", "schema_version", "status", "definition", "checksum", "created_at", "created_by", "published_at", "published_by")
RECORD_COLUMNS = ("record_id", "form_id", "schema_version", "status", "data", "created_at", "created_by", "updated_at", "updated_by", "sync_id", "version", "subject_id", "ingest_seq", "ingested_at")
# Set once at insert; never rewritten by updates.
IMMUTABLE_RECORD_COLUMNS = ("record_id", "form_id", "created_at", "created_by", "ingest_seq", "ingested_at")
REVISION_COLUMNS = ("record_id", "version", "schema_version", "status", "data", "updated_at", "updated_by", "sync_id")
RECEIPT_COLUMNS = ("op_id", "record_id", "result", "processed_at")
CONFLICT_COLUMNS = ("conflict_id", "record_id", "op_id", "strategy", "resolution", "base_version", "server_version", "local_data", "server_data", "created_at")
ASSET_COLUMNS = ("form_id", "path", "media_type", "sha256", "size", "content_b64", "created_at")
STYLE_COLUMNS = ("style_id", "version", "definition", "updated_at")
FONT_COLUMNS = ("font_id", "metadata", "updated_at")
ATTACHMENT_COLUMNS = ("sha256", "media_type", "size", "content", "created_at", "created_by")
LOOKUP_COLUMNS = ("lookup_id", "version", "metadata", "entries", "updated_at", "updated_by")
POLICY_COLUMNS = ("form_id", "policy", "version", "updated_at", "updated_by")
SOURCE_COLUMNS = ("source_id", "form_id", "config", "version", "updated_at", "updated_by")
TEMPLATE_COLUMNS = ("template_id", "title", "description", "origin", "status", "definition", "report", "sources", "version",
                    "created_at", "created_by", "updated_at", "updated_by")
QUERY_COLUMNS = ("query_id", "definition", "owner_user_id", "owner", "created_at", "updated_at")
JOB_COLUMNS = ("job_id", "kind", "status", "query", "format", "owner_user_id", "owner", "rows_processed", "total_estimate", "checkpoint",
               "result_bytes", "result_sha256", "error", "attempt", "max_attempts", "lease_owner", "lease_expires_at", "cancel_requested",
               "created_at", "started_at", "heartbeat_at", "finished_at", "expires_at")
OPEN_JOB_STATUSES = ("queued", "running")
AUDIT_COLUMNS = ("audit_id", "at", "actor_user_id", "actor", "actor_roles", "action", "source_id", "fingerprint", "fields",
                 "filter_fields", "row_count", "job_id", "result_sha256", "client_ip")
JSON_COLUMNS = {"definition", "data", "result", "local_data", "server_data", "metadata", "policy", "config", "shape",
                "checkpoint", "error", "query", "actor_roles", "fields", "filter_fields", "entries", "report", "sources"}


def _cols(columns: Iterable[str], alias: str = "") -> str:
    prefix = f"{alias}." if alias else ""
    return ", ".join(prefix + column for column in columns)


# Upper bound for prefix ranges. Byte-order comparison (PostgreSQL C collation, SQLite BINARY) puts every
# string that starts with p in [p, p + U+10FFFF). Unlike LIKE, this is case-sensitive on both vendors.
PREFIX_UPPER = "\U0010ffff"


class SqlDataAdapter(DataAdapter):
    row_locks = False  # SELECT ... FOR UPDATE available (PostgreSQL, MySQL)

    # Vendor hooks ------------------------------------------------------------
    @abstractmethod
    def _execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        """Run one statement written with ``?`` placeholders; return a cursor."""

    @abstractmethod
    def _rows(self, cursor: Any) -> list[dict[str, Any]]: ...

    @abstractmethod
    def _encode_json(self, value: Any) -> Any: ...

    @abstractmethod
    def _decode_json(self, value: Any) -> Any: ...

    def _upsert_sql(self, table: str, columns: tuple[str, ...], keys: tuple[str, ...]) -> str:
        updates = ", ".join(f"{column} = excluded.{column}" for column in columns if column not in keys)
        placeholders = ", ".join("?" for _ in columns)
        return f"INSERT INTO {table} ({_cols(columns)}) VALUES ({placeholders}) ON CONFLICT ({_cols(keys)}) DO UPDATE SET {updates}"

    # Helpers -----------------------------------------------------------------
    def _params(self, row: dict[str, Any], columns: tuple[str, ...]) -> tuple[Any, ...]:
        return tuple(self._encode_json(row.get(column)) if column in JSON_COLUMNS else row.get(column) for column in columns)

    def _decode(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {key: self._decode_json(value) if key in JSON_COLUMNS and value is not None else value for key, value in row.items()}

    def _one(self, sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
        rows = self._rows(self._execute(sql, params))
        return self._decode(rows[0]) if rows else None

    def _all(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        return [self._decode(row) for row in self._rows(self._execute(sql, params))]  # type: ignore[misc]

    def _insert(self, table: str, columns: tuple[str, ...], row: dict[str, Any]) -> None:
        placeholders = ", ".join("?" for _ in columns)
        self._execute(f"INSERT INTO {table} ({_cols(columns)}) VALUES ({placeholders})", self._params(row, columns))

    # Forms -------------------------------------------------------------------
    def get_form(self, form_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(FORM_COLUMNS)} FROM formdev_form WHERE form_id = ?", (form_id,))

    def list_forms(self) -> list[dict[str, Any]]:
        return self._all(f"SELECT {_cols(FORM_COLUMNS)} FROM formdev_form ORDER BY title, form_id")

    def save_form(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_form", FORM_COLUMNS, ("form_id",)), self._params(row, FORM_COLUMNS))

    # Schema versions -----------------------------------------------------------
    def get_schema_version(self, form_id: str, schema_version: int) -> dict[str, Any] | None:
        return self._one(
            f"SELECT {_cols(SCHEMA_COLUMNS)} FROM formdev_schema_version WHERE form_id = ? AND schema_version = ?",
            (form_id, schema_version),
        )

    def list_schema_versions(self, form_id: str) -> list[dict[str, Any]]:
        return self._all(
            f"SELECT {_cols(SCHEMA_COLUMNS)} FROM formdev_schema_version WHERE form_id = ? ORDER BY schema_version",
            (form_id,),
        )

    def insert_schema_version(self, row: dict[str, Any]) -> None:
        self._insert("formdev_schema_version", SCHEMA_COLUMNS, row)

    def update_schema_version(self, form_id: str, schema_version: int, changes: dict[str, Any]) -> None:
        columns = tuple(column for column in SCHEMA_COLUMNS if column in changes and column not in ("form_id", "schema_version"))
        if not columns:
            return
        assignments = ", ".join(f"{column} = ?" for column in columns)
        self._execute(
            f"UPDATE formdev_schema_version SET {assignments} WHERE form_id = ? AND schema_version = ?",
            self._params(changes, columns) + (form_id, schema_version),
        )

    # Records -----------------------------------------------------------------
    def get_record(self, record_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(RECORD_COLUMNS)} FROM formdev_record WHERE record_id = ?", (record_id,))

    def insert_record(self, row: dict[str, Any]) -> None:
        self._insert("formdev_record", RECORD_COLUMNS, row)

    def update_record(self, row: dict[str, Any], expected_version: int) -> bool:
        columns = tuple(column for column in RECORD_COLUMNS if column not in IMMUTABLE_RECORD_COLUMNS)
        assignments = ", ".join(f"{column} = ?" for column in columns)
        cursor = self._execute(
            f"UPDATE formdev_record SET {assignments} WHERE record_id = ? AND version = ?",
            self._params(row, columns) + (row["record_id"], expected_version),
        )
        return cursor.rowcount == 1

    def insert_revision(self, row: dict[str, Any]) -> None:
        self._insert("formdev_record_revision", REVISION_COLUMNS, row)

    def list_revisions(self, record_id: str) -> list[dict[str, Any]]:
        return self._all(
            f"SELECT {_cols(REVISION_COLUMNS)} FROM formdev_record_revision WHERE record_id = ? ORDER BY version",
            (record_id,),
        )

    def get_revision(self, record_id: str, version: int) -> dict[str, Any] | None:
        return self._one(
            f"SELECT {_cols(REVISION_COLUMNS)} FROM formdev_record_revision WHERE record_id = ? AND version = ?",
            (record_id, version),
        )

    def replace_index_entries(self, record_id: str, form_id: str, entries: list[dict[str, Any]], status: str, updated_at: int) -> None:
        self._execute("DELETE FROM formdev_record_index WHERE record_id = ?", (record_id,))
        for entry in entries:
            self._execute(
                "INSERT INTO formdev_record_index (record_id, form_id, field_id, value_text, value_num, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (record_id, form_id, entry["field_id"], entry["value_text"], entry["value_num"], status, updated_at),
            )

    def set_record_derived(self, record_id: str, subject_id: str | None) -> None:
        self._execute("UPDATE formdev_record SET subject_id = ? WHERE record_id = ?", (subject_id, record_id))

    def bump_data_version(self, form_id: str, at: int) -> int:
        self._execute(
            "INSERT INTO formdev_data_version (form_id, version, updated_at) VALUES (?, 1, ?) "
            "ON CONFLICT (form_id) DO UPDATE SET version = formdev_data_version.version + 1, updated_at = excluded.updated_at",
            (form_id, at),
        )
        row = self._one("SELECT version FROM formdev_data_version WHERE form_id = ?", (form_id,))
        return int(row["version"]) if row else 0

    def data_versions(self, form_ids: list[str]) -> dict[str, int]:
        if not form_ids:
            return {}
        placeholders = ", ".join("?" for _ in form_ids)
        rows = self._all(f"SELECT form_id, version FROM formdev_data_version WHERE form_id IN ({placeholders})", tuple(form_ids))
        found = {row["form_id"]: int(row["version"]) for row in rows}
        return {form_id: found.get(form_id, 0) for form_id in form_ids}

    def count_records(self, form_id: str) -> int:
        row = self._one("SELECT COUNT(*) AS total FROM formdev_record WHERE form_id = ?", (form_id,))
        return int(row["total"]) if row else 0

    def records_after(self, form_id: str, after_record_id: str | None, limit: int, lock: bool = False) -> list[dict[str, Any]]:
        """Immutable record_id keyset used by reindexing. ``lock`` (inside a transaction) holds the rows until it
        ends where the database has row locks; SQLite transactions already exclude other writers."""
        columns = ("record_id", "schema_version", "status", "data", "updated_at")
        suffix = " FOR UPDATE" if lock and self.row_locks else ""
        if after_record_id is None:
            return self._all(f"SELECT {_cols(columns)} FROM formdev_record WHERE form_id = ? ORDER BY record_id LIMIT ?{suffix}", (form_id, limit))
        return self._all(
            f"SELECT {_cols(columns)} FROM formdev_record WHERE form_id = ? AND record_id > ? ORDER BY record_id LIMIT ?{suffix}",
            (form_id, after_record_id, limit),
        )

    def building_forms(self) -> list[str]:
        """Forms with index coverage still being built."""
        return [row["form_id"] for row in self._all("SELECT DISTINCT form_id FROM formdev_index_coverage WHERE state = 'building' ORDER BY form_id", ())]

    # Index configuration and coverage ---------------------------------------------
    def list_index_config(self, form_id: str) -> list[str]:
        return [row["field_id"] for row in self._all("SELECT field_id FROM formdev_index_config WHERE form_id = ? ORDER BY field_id", (form_id,))]

    def add_index_config(self, form_id: str, field_id: str, at: int, user: str) -> None:
        self._execute(
            "INSERT INTO formdev_index_config (form_id, field_id, created_at, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (form_id, field_id) DO NOTHING",
            (form_id, field_id, at, user),
        )

    def remove_index_config(self, form_id: str, field_id: str) -> None:
        self._execute("DELETE FROM formdev_index_config WHERE form_id = ? AND field_id = ?", (form_id, field_id))

    def list_index_coverage(self, form_id: str) -> list[dict[str, Any]]:
        return self._all(
            "SELECT form_id, field_id, origin, state, schema_version, updated_at FROM formdev_index_coverage WHERE form_id = ? ORDER BY field_id",
            (form_id,),
        )

    def set_index_coverage(self, form_id: str, field_id: str, origin: str, state: str, schema_version: int, at: int) -> None:
        self._execute(
            "INSERT INTO formdev_index_coverage (form_id, field_id, origin, state, schema_version, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (form_id, field_id) DO UPDATE SET origin = excluded.origin, state = excluded.state, "
            "schema_version = excluded.schema_version, updated_at = excluded.updated_at",
            (form_id, field_id, origin, state, schema_version, at),
        )

    def clear_index_coverage(self, form_id: str, keep: list[str]) -> None:
        rows = self.list_index_coverage(form_id)
        for row in rows:
            if row["field_id"] not in keep:
                self._execute("DELETE FROM formdev_index_coverage WHERE form_id = ? AND field_id = ?", (form_id, row["field_id"]))

    def count_index_entries(self, record_id: str) -> int:
        row = self._one("SELECT COUNT(*) AS total FROM formdev_record_index WHERE record_id = ?", (record_id,))
        return int(row["total"]) if row else 0

    def search_records(
        self,
        form_id: str,
        statuses: list[str],
        filters: list[IndexFilter],
        after: tuple[int, str] | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        joins: list[str] = []
        params: list[Any] = []
        for number, item in enumerate(filters):
            alias = f"i{number}"
            value = item["value"]
            numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
            column = f"{alias}.value_num" if numeric else f"{alias}.value_text"
            if isinstance(value, bool):
                column, value = f"{alias}.value_num", int(value)
            if item["op"] == "eq":
                condition = f"{column} = ?"
            elif item["op"] == "gte":
                condition = f"{column} >= ?"
            elif item["op"] == "lte":
                condition = f"{column} <= ?"
            else:
                condition = f"{alias}.value_text >= ? AND {alias}.value_text < ?"
            live = "" if "deleted" in statuses else f" AND {alias}.status <> 'deleted'"
            joins.append(
                f"JOIN formdev_record_index {alias} ON {alias}.record_id = r.record_id"
                f" AND {alias}.form_id = ? AND {alias}.field_id = ? AND {condition}{live}"
            )
            params.extend([form_id, item["field"], value])
            if item["op"] == "prefix":
                params.append(str(value) + PREFIX_UPPER)
        where = ["r.form_id = ?"]
        params.append(form_id)
        if statuses:
            where.append(f"r.status IN ({', '.join('?' for _ in statuses)})")
            params.extend(statuses)
        if after is not None:
            # Sargable leading bound plus a row comparison: an index range start, not a filter.
            where.append("r.updated_at <= ? AND (r.updated_at, r.record_id) < (?, ?)")
            params.extend([after[0], after[0], after[1]])
        params.append(limit)
        sql = (
            f"SELECT {_cols(RECORD_COLUMNS, 'r')} FROM formdev_record r {' '.join(joins)} "
            f"WHERE {' AND '.join(where)} ORDER BY r.updated_at DESC, r.record_id DESC LIMIT ?"
        )
        return self._all(sql, tuple(params))

    # Sync --------------------------------------------------------------------
    def get_sync_receipt(self, op_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(RECEIPT_COLUMNS)} FROM formdev_sync_receipt WHERE op_id = ?", (op_id,))

    def insert_sync_receipt(self, row: dict[str, Any]) -> None:
        self._insert("formdev_sync_receipt", RECEIPT_COLUMNS, row)

    def insert_conflict(self, row: dict[str, Any]) -> None:
        self._insert("formdev_conflict", CONFLICT_COLUMNS, row)

    def list_conflicts(self, record_id: str) -> list[dict[str, Any]]:
        return self._all(
            # seq is the insertion order; created_at alone ties within a millisecond.
            f"SELECT {_cols(CONFLICT_COLUMNS)} FROM formdev_conflict WHERE record_id = ? ORDER BY seq",
            (record_id,),
        )

    # Assets ------------------------------------------------------------------
    def save_asset(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_asset", ASSET_COLUMNS, ("form_id", "path")), self._params(row, ASSET_COLUMNS))

    def get_asset(self, form_id: str, path: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(ASSET_COLUMNS)} FROM formdev_asset WHERE form_id = ? AND path = ?", (form_id, path))

    def list_assets(self, form_id: str) -> list[dict[str, Any]]:
        columns = tuple(column for column in ASSET_COLUMNS if column != "content_b64")
        return self._all(f"SELECT {_cols(columns)} FROM formdev_asset WHERE form_id = ? ORDER BY path", (form_id,))

    # Query catalog: form policies, named sources, saved queries ---------------------
    def get_form_policy(self, form_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(POLICY_COLUMNS)} FROM formdev_form_policy WHERE form_id = ?", (form_id,))

    def save_form_policy(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_form_policy", POLICY_COLUMNS, ("form_id",)), self._params(row, POLICY_COLUMNS))

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(SOURCE_COLUMNS)} FROM formdev_source WHERE source_id = ?", (source_id,))

    def list_sources(self) -> list[dict[str, Any]]:
        return self._all(f"SELECT {_cols(SOURCE_COLUMNS)} FROM formdev_source ORDER BY source_id")

    def save_source(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_source", SOURCE_COLUMNS, ("source_id",)), self._params(row, SOURCE_COLUMNS))

    def delete_source(self, source_id: str) -> None:
        self._execute("DELETE FROM formdev_source WHERE source_id = ?", (source_id,))

    def get_saved_query(self, query_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(QUERY_COLUMNS)} FROM formdev_query WHERE query_id = ?", (query_id,))

    def list_saved_queries(self) -> list[dict[str, Any]]:
        return self._all(f"SELECT {_cols(QUERY_COLUMNS)} FROM formdev_query ORDER BY query_id")

    def save_saved_query(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_query", QUERY_COLUMNS, ("query_id",)), self._params(row, QUERY_COLUMNS))

    def delete_saved_query(self, query_id: str) -> None:
        self._execute("DELETE FROM formdev_query WHERE query_id = ?", (query_id,))

    # Template library ------------------------------------------------------------
    def get_template(self, template_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(TEMPLATE_COLUMNS)} FROM formdev_template WHERE template_id = ?", (template_id,))

    def list_templates(self) -> list[dict[str, Any]]:
        columns = tuple(column for column in TEMPLATE_COLUMNS if column not in ("definition", "report"))
        return self._all(f"SELECT {_cols(columns)} FROM formdev_template ORDER BY updated_at DESC, template_id")

    def save_template(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_template", TEMPLATE_COLUMNS, ("template_id",)), self._params(row, TEMPLATE_COLUMNS))

    def delete_template(self, template_id: str) -> None:
        self._execute("DELETE FROM formdev_template WHERE template_id = ?", (template_id,))

    # Background jobs (fenced leases) --------------------------------------------------
    def lock_job_quota(self, owner_user_id: Any) -> None:
        """Serialize job-limit checks with inserts. SQLite is already serialized by BEGIN IMMEDIATE."""

    def insert_job(self, row: dict[str, Any]) -> None:
        self._insert("formdev_job", JOB_COLUMNS, row)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(JOB_COLUMNS)} FROM formdev_job WHERE job_id = ?", (job_id,))

    def list_jobs(self, owner_user_id: Any | None, limit: int = 50) -> list[dict[str, Any]]:
        columns = _cols(column for column in JOB_COLUMNS if column != "query")
        if owner_user_id is None:
            return self._all(f"SELECT {columns} FROM formdev_job ORDER BY created_at DESC LIMIT ?", (limit,))
        return self._all(f"SELECT {columns} FROM formdev_job WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?", (owner_user_id, limit))

    def count_open_jobs(self, owner_user_id: Any | None) -> int:
        if owner_user_id is None:
            row = self._one("SELECT COUNT(*) AS total FROM formdev_job WHERE status IN ('queued', 'running') AND kind <> 'reindex'", ())
        else:
            row = self._one("SELECT COUNT(*) AS total FROM formdev_job WHERE status IN ('queued', 'running') AND owner_user_id = ?", (owner_user_id,))
        return int(row["total"]) if row else 0

    def claimable_jobs(self, now: int, limit: int = 5) -> list[str]:
        rows = self._all(
            "SELECT job_id FROM formdev_job WHERE cancel_requested = 0 AND attempt < max_attempts "
            "AND (status = 'queued' OR (status = 'running' AND lease_expires_at < ?)) ORDER BY created_at LIMIT ?",
            (now, limit),
        )
        return [row["job_id"] for row in rows]

    def claim_job(self, job_id: str, lease_owner: str, lease_until: int, now: int) -> dict[str, Any] | None:
        """Compare-and-set claim; the returned row's attempt is the fencing token. started_at is the start of
        this attempt: the runtime limit applies per attempt, not to time spent queued or waiting for a lease."""
        cursor = self._execute(
            "UPDATE formdev_job SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1, "
            "started_at = ?, heartbeat_at = ? WHERE job_id = ? AND cancel_requested = 0 AND attempt < max_attempts "
            "AND (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))",
            (lease_owner, lease_until, now, now, job_id, now),
        )
        return self.get_job(job_id) if cursor.rowcount == 1 else None

    def update_job_fenced(self, job_id: str, lease_owner: str, attempt: int, changes: dict[str, Any]) -> bool:
        columns = tuple(column for column in JOB_COLUMNS if column in changes)
        assignments = ", ".join(f"{column} = ?" for column in columns)
        cursor = self._execute(
            f"UPDATE formdev_job SET {assignments} WHERE job_id = ? AND lease_owner = ? AND attempt = ? AND status = 'running'",
            self._params(changes, columns) + (job_id, lease_owner, attempt),
        )
        return cursor.rowcount == 1

    def update_job_where(self, job_id: str, statuses: tuple[str, ...], changes: dict[str, Any]) -> bool:
        columns = tuple(column for column in JOB_COLUMNS if column in changes)
        assignments = ", ".join(f"{column} = ?" for column in columns)
        placeholders = ", ".join("?" for _ in statuses)
        cursor = self._execute(
            f"UPDATE formdev_job SET {assignments} WHERE job_id = ? AND status IN ({placeholders})",
            self._params(changes, columns) + (job_id, *statuses),
        )
        return cursor.rowcount == 1

    def fail_exhausted_jobs(self, now: int) -> list[str]:
        rows = self._all("SELECT job_id FROM formdev_job WHERE status = 'running' AND lease_expires_at < ? AND attempt >= max_attempts", (now,))
        failed = []
        for row in rows:
            if self.update_job_where(row["job_id"], ("running",), {"status": "failed", "finished_at": now, "lease_owner": None,
                                                                   "error": {"code": "job_abandoned", "message": "The job stopped responding too many times"}}):
                failed.append(row["job_id"])
        return failed

    def finish_cancelled_jobs(self, now: int) -> list[str]:
        """Cancelled jobs nobody is running any more (queued, or running with an expired lease: the worker died
        before it saw the request) become 'cancelled'; they are never claimable, so nothing else would end them."""
        condition = "cancel_requested = 1 AND (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))"
        rows = self._all(f"SELECT job_id FROM formdev_job WHERE {condition}", (now,))
        finished = []
        for row in rows:
            cursor = self._execute(f"UPDATE formdev_job SET status = 'cancelled', finished_at = ?, lease_owner = NULL, lease_expires_at = NULL "
                                   f"WHERE job_id = ? AND {condition}", (now, row["job_id"], now))
            if cursor.rowcount == 1:
                finished.append(row["job_id"])
        return finished

    def retained_job_bytes(self, owner_user_id: Any) -> int:
        """Bytes of an owner's finished results still kept for download."""
        row = self._one("SELECT COALESCE(SUM(result_bytes), 0) AS total FROM formdev_job WHERE status = 'succeeded' AND owner_user_id = ?", (owner_user_id,))
        return int(row["total"]) if row else 0

    def interrupt(self) -> None:
        """Stop the statement running on this adapter's connection from another thread (graceful shutdown)."""

    def expire_jobs(self, now: int) -> list[str]:
        rows = self._all("SELECT job_id FROM formdev_job WHERE status = 'succeeded' AND expires_at < ?", (now,))
        return [row["job_id"] for row in rows if self.update_job_where(row["job_id"], ("succeeded",), {"status": "expired"})]

    def job_ids_with_files(self) -> set[str]:
        return {row["job_id"] for row in self._all("SELECT job_id FROM formdev_job WHERE status IN ('queued', 'running', 'succeeded')", ())}

    # Query statistics and audit ------------------------------------------------------
    def flush_query_stats(self, rows: list[dict[str, Any]]) -> None:
        """Additive upsert of in-memory counters (one row per query shape)."""
        for row in rows:
            self._execute(
                "INSERT INTO formdev_query_stat (fingerprint, source_id, shape, runs, ok, timeouts, rejected, total_ms, max_ms, rows_returned, first_run_at, last_run_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (fingerprint) DO UPDATE SET "
                "runs = formdev_query_stat.runs + excluded.runs, ok = formdev_query_stat.ok + excluded.ok, "
                "timeouts = formdev_query_stat.timeouts + excluded.timeouts, rejected = formdev_query_stat.rejected + excluded.rejected, "
                "total_ms = formdev_query_stat.total_ms + excluded.total_ms, "
                "max_ms = CASE WHEN excluded.max_ms > formdev_query_stat.max_ms THEN excluded.max_ms ELSE formdev_query_stat.max_ms END, "
                "rows_returned = formdev_query_stat.rows_returned + excluded.rows_returned, last_run_at = excluded.last_run_at",
                (row["fingerprint"], row["source_id"], self._encode_json(row["shape"]), row["runs"], row["ok"], row["timeouts"], row["rejected"],
                 row["total_ms"], row["max_ms"], row["rows_returned"], row["first_run_at"], row["last_run_at"]),
            )

    def list_query_stats(self, source_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        columns = "fingerprint, source_id, shape, runs, ok, timeouts, rejected, total_ms, max_ms, rows_returned, first_run_at, last_run_at"
        if source_id:
            return self._all(f"SELECT {columns} FROM formdev_query_stat WHERE source_id = ? ORDER BY runs DESC LIMIT ?", (source_id, limit))
        return self._all(f"SELECT {columns} FROM formdev_query_stat ORDER BY runs DESC LIMIT ?", (limit,))

    def insert_audit(self, row: dict[str, Any]) -> None:
        self._insert("formdev_query_audit", AUDIT_COLUMNS, row)

    def list_audit(self, limit: int = 200) -> list[dict[str, Any]]:
        return self._all(f"SELECT {_cols(AUDIT_COLUMNS)} FROM formdev_query_audit ORDER BY at DESC LIMIT ?", (limit,))

    # Registry ----------------------------------------------------------------
    def get_style(self, style_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(STYLE_COLUMNS)} FROM formdev_style WHERE style_id = ?", (style_id,))

    def list_styles(self) -> list[dict[str, Any]]:
        return self._all(f"SELECT {_cols(STYLE_COLUMNS)} FROM formdev_style ORDER BY style_id")

    def save_style(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_style", STYLE_COLUMNS, ("style_id",)), self._params(row, STYLE_COLUMNS))

    def get_font(self, font_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(FONT_COLUMNS)} FROM formdev_font WHERE font_id = ?", (font_id,))

    def list_fonts(self) -> list[dict[str, Any]]:
        return self._all(f"SELECT {_cols(FONT_COLUMNS)} FROM formdev_font ORDER BY font_id")

    def save_font(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_font", FONT_COLUMNS, ("font_id",)), self._params(row, FONT_COLUMNS))

    def attachment_exists(self, sha256: str) -> bool:
        return self._one("SELECT 1 AS present FROM formdev_attachment WHERE sha256 = ?", (sha256,)) is not None

    def get_attachment(self, sha256: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(ATTACHMENT_COLUMNS)} FROM formdev_attachment WHERE sha256 = ?", (sha256,))

    def save_attachment(self, row: dict[str, Any]) -> None:
        # Content-addressed: an existing row already holds the same bytes.
        self._execute(f"INSERT INTO formdev_attachment ({_cols(ATTACHMENT_COLUMNS)}) VALUES ({', '.join('?' for _ in ATTACHMENT_COLUMNS)})"
                      " ON CONFLICT (sha256) DO NOTHING", self._params(row, ATTACHMENT_COLUMNS))

    def get_lookup(self, lookup_id: str) -> dict[str, Any] | None:
        return self._one(f"SELECT {_cols(LOOKUP_COLUMNS)} FROM formdev_lookup WHERE lookup_id = ?", (lookup_id,))

    def list_lookups(self) -> list[dict[str, Any]]:
        columns = tuple(column for column in LOOKUP_COLUMNS if column != "entries")
        return self._all(f"SELECT {_cols(columns)} FROM formdev_lookup ORDER BY lookup_id")

    def save_lookup(self, row: dict[str, Any]) -> None:
        self._execute(self._upsert_sql("formdev_lookup", LOOKUP_COLUMNS, ("lookup_id",)), self._params(row, LOOKUP_COLUMNS))
