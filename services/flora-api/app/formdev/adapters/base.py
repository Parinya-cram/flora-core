"""Storage contract for FormDev.

Repositories (and therefore the form engine) only talk to ``DataAdapter``; they never
see SQL dialects, drivers or connection objects. Every method takes and returns plain
dicts with JSON-compatible values (definition/data columns are already decoded).
Timestamps are epoch milliseconds, matching the rest of Flora.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from contextlib import AbstractContextManager
from typing import Any, Literal, TypedDict


class IndexFilter(TypedDict):
    field: str
    op: Literal["eq", "prefix", "gte", "lte"]
    value: Any


class DataAdapter(ABC):
    vendor: str = "abstract"

    @abstractmethod
    def transaction(self) -> AbstractContextManager[None]:
        """Atomic unit of work. Nested calls join the outer transaction (savepoint)."""

    # Forms ------------------------------------------------------------------
    @abstractmethod
    def get_form(self, form_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def list_forms(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    def save_form(self, row: dict[str, Any]) -> None:
        """Insert or replace the form header row."""

    # Schema versions --------------------------------------------------------
    @abstractmethod
    def get_schema_version(self, form_id: str, schema_version: int) -> dict[str, Any] | None: ...

    @abstractmethod
    def list_schema_versions(self, form_id: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    def insert_schema_version(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def update_schema_version(self, form_id: str, schema_version: int, changes: dict[str, Any]) -> None: ...

    # Records ----------------------------------------------------------------
    @abstractmethod
    def get_record(self, record_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def insert_record(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def update_record(self, row: dict[str, Any], expected_version: int) -> bool:
        """Optimistic write: only succeeds when the stored version equals expected_version."""

    @abstractmethod
    def insert_revision(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def list_revisions(self, record_id: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    def get_revision(self, record_id: str, version: int) -> dict[str, Any] | None: ...

    @abstractmethod
    def replace_index_entries(self, record_id: str, form_id: str, entries: list[dict[str, Any]], status: str, updated_at: int) -> None:
        """Replace a record's index rows; status/updated_at are copied from the record row."""

    @abstractmethod
    def set_record_derived(self, record_id: str, subject_id: str | None) -> None:
        """Update derived columns (subject_id) without touching version or edit times."""

    @abstractmethod
    def bump_data_version(self, form_id: str, at: int) -> int:
        """Increment and return the per-form change counter (cache keys, ingest_seq)."""

    @abstractmethod
    def data_versions(self, form_ids: list[str]) -> dict[str, int]: ...

    @abstractmethod
    def count_records(self, form_id: str) -> int: ...

    @abstractmethod
    def records_after(self, form_id: str, after_record_id: str | None, limit: int) -> list[dict[str, Any]]:
        """record_id-ordered batch (record_id, schema_version, status, data, updated_at) for reindexing."""

    @abstractmethod
    def list_index_config(self, form_id: str) -> list[str]: ...

    @abstractmethod
    def add_index_config(self, form_id: str, field_id: str, at: int, user: str) -> None: ...

    @abstractmethod
    def remove_index_config(self, form_id: str, field_id: str) -> None: ...

    @abstractmethod
    def list_index_coverage(self, form_id: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    def set_index_coverage(self, form_id: str, field_id: str, origin: str, state: str, schema_version: int, at: int) -> None: ...

    @abstractmethod
    def clear_index_coverage(self, form_id: str, keep: list[str]) -> None:
        """Delete coverage rows for fields no longer indexed."""

    @abstractmethod
    def search_records(
        self,
        form_id: str,
        statuses: list[str],
        filters: list[IndexFilter],
        after: tuple[int, str] | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        """Newest first by (updated_at, record_id). ``after`` is the exclusive keyset cursor.
        Filters are resolved through the record index, never by scanning record JSON."""

    @abstractmethod
    def count_index_entries(self, record_id: str) -> int: ...

    # Sync -------------------------------------------------------------------
    @abstractmethod
    def get_sync_receipt(self, op_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def insert_sync_receipt(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def insert_conflict(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def list_conflicts(self, record_id: str) -> list[dict[str, Any]]: ...

    # Assets -----------------------------------------------------------------
    @abstractmethod
    def save_asset(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def get_asset(self, form_id: str, path: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def list_assets(self, form_id: str) -> list[dict[str, Any]]: ...

    # Style / font registry --------------------------------------------------
    @abstractmethod
    def get_style(self, style_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def list_styles(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    def save_style(self, row: dict[str, Any]) -> None: ...

    @abstractmethod
    def get_font(self, font_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def list_fonts(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    def save_font(self, row: dict[str, Any]) -> None: ...

    # Lookup tables (Phase 2.3) ----------------------------------------------
    @abstractmethod
    def get_lookup(self, lookup_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def list_lookups(self) -> list[dict[str, Any]]:
        """Every lookup without its entries (lookup_id, version, metadata, updated_at, updated_by)."""

    @abstractmethod
    def save_lookup(self, row: dict[str, Any]) -> None: ...
