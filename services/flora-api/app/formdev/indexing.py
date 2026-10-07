"""Record index maintenance.

Rule: a record's index rows (and subject_id) always follow the form's LATEST published
definition applied to the record's data migrated to that version, plus any server-side
indexed fields from formdev_index_config. This keeps filters complete across schema
versions: a v1 record is found by a field that was renamed or newly indexed in v2.

After a publish (or an index-config change) the affected fields are reindexed. Small forms
are reindexed immediately; larger ones get coverage state 'building' and a reindex job, and
the query validator refuses those fields (index_building) until the job marks them ready.
"""
from __future__ import annotations

import copy
import time
from typing import Any, Callable

from .adapters.base import DataAdapter
from .definition import MAX_INDEXED_FIELDS, field_key, field_map, fields, index_entries, subject_value
from .field_types import INDEX_FAMILY, INDEXABLE_TYPES
from .errors import FormDevError
from .migration import migrate

SYNC_REINDEX_MAX_RECORDS = 5000
REINDEX_BATCH = 1000


def now_ms() -> int:
    return int(time.time() * 1000)


def effective_index_definition(definition: dict[str, Any], config_fields: list[str]) -> dict[str, Any]:
    """Copy of the definition with server-configured fields marked indexed."""
    if not config_fields:
        return definition
    extra = set(config_fields)
    out = copy.deepcopy(definition)
    for field in fields(out):
        if field_key(field) in extra and field.get("type") in INDEXABLE_TYPES:
            field["indexed"] = True
    return out


def indexed_field_ids(definition: dict[str, Any]) -> dict[str, str]:
    return {field_id: field["type"] for field_id, field in field_map(definition).items() if field.get("indexed") is True and field.get("type") in INDEXABLE_TYPES}


def changed_index_fields(previous: dict[str, Any] | None, current: dict[str, Any]) -> tuple[set[str], set[str]]:
    """(fields whose index rows must be rebuilt, fields no longer indexed)."""
    now = indexed_field_ids(current)
    before = indexed_field_ids(previous) if previous else {}
    touched: set[str] = set()
    for op in (current.get("migration") or {}).get("ops", []):
        touched.update(value for key, value in op.items() if key in ("to", "field") and isinstance(value, str))
    changed = {field_id for field_id, field_type in now.items()
               if field_id not in before or INDEX_FAMILY.get(before[field_id]) != INDEX_FAMILY.get(field_type) or field_id in touched}
    return changed, set(before) - set(now)


class IndexMaintenance:
    def __init__(self, adapter: DataAdapter, schemas: Any, enqueue_reindex: Callable[[str, str], None] | None = None):
        self.adapter = adapter
        self.schemas = schemas
        self.enqueue_reindex = enqueue_reindex
        self._plans: dict[str, tuple[dict[str, Any], dict[str, Any], int]] = {}

    def invalidate(self, form_id: str) -> None:
        self._plans.pop(form_id, None)

    def plan(self, form_id: str) -> tuple[dict[str, Any], dict[str, Any], int]:
        """(latest published definition, effective index definition, latest version)."""
        if form_id not in self._plans:
            latest = self.schemas.latest_published(form_id)
            definition = latest["definition"]
            self._plans[form_id] = (definition, effective_index_definition(definition, self.adapter.list_index_config(form_id)), int(latest["schema_version"]))
        return self._plans[form_id]

    def derive(self, form_id: str, schema_version: int, data: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
        latest, index_definition, latest_version = self.plan(form_id)
        migrated = data if schema_version == latest_version else migrate(data, schema_version, latest_version, self.schemas.loader(form_id))
        return index_entries(index_definition, migrated), subject_value(latest, migrated)

    def indexed_fields(self, form_id: str) -> dict[str, dict[str, Any]]:
        """field_id -> {type, origin, state} for every field the index currently serves."""
        latest, index_definition, _ = self.plan(form_id)
        coverage = {row["field_id"]: row for row in self.adapter.list_index_coverage(form_id)}
        defined = field_map(latest)
        return {
            field_id: {
                "type": field_type,
                "origin": "definition" if defined[field_id].get("indexed") else "config",
                "state": coverage[field_id]["state"] if field_id in coverage else "ready",
            }
            for field_id, field_type in indexed_field_ids(index_definition).items()
        }

    # Reindexing -------------------------------------------------------------------
    def reindex_batch(self, form_id: str, after: str | None, batch: int = REINDEX_BATCH) -> str | None:
        rows = self.adapter.records_after(form_id, after, batch)
        with self.adapter.transaction():
            for row in rows:
                entries, subject = self.derive(form_id, int(row["schema_version"]), row["data"])
                self.adapter.replace_index_entries(row["record_id"], form_id, entries, row["status"], int(row["updated_at"]))
                self.adapter.set_record_derived(row["record_id"], subject)
        return rows[-1]["record_id"] if len(rows) == batch else None

    def finish(self, form_id: str) -> None:
        _, _, version = self.plan(form_id)
        fields = self.indexed_fields(form_id)
        at = now_ms()
        with self.adapter.transaction():
            for field_id, info in fields.items():
                self.adapter.set_index_coverage(form_id, field_id, info["origin"], "ready", version, at)
            self.adapter.clear_index_coverage(form_id, list(fields))
            self.adapter.bump_data_version(form_id, at)

    def reindex_all(self, form_id: str) -> None:
        cursor: str | None = None
        while True:
            cursor = self.reindex_batch(form_id, cursor)
            if cursor is None:
                break
        self.finish(form_id)

    def schedule(self, form_id: str, changed: set[str], removed: set[str], user: str) -> str:
        """Rebuild the index now for small forms, otherwise mark fields building and queue a job."""
        self.invalidate(form_id)
        if not changed and not removed:
            self.finish(form_id)
            return "ready"
        if self.adapter.count_records(form_id) <= SYNC_REINDEX_MAX_RECORDS or self.enqueue_reindex is None:
            self.reindex_all(form_id)
            return "ready"
        _, _, version = self.plan(form_id)
        at = now_ms()
        fields = self.indexed_fields(form_id)
        with self.adapter.transaction():
            for field_id in changed:
                self.adapter.set_index_coverage(form_id, field_id, fields.get(field_id, {}).get("origin", "definition"), "building", version, at)
            self.adapter.bump_data_version(form_id, at)
        self.enqueue_reindex(form_id, user)
        return "building"

    def after_publish(self, form_id: str, previous: dict[str, Any] | None, user: str) -> str:
        self.invalidate(form_id)
        latest, index_definition, _ = self.plan(form_id)
        config = self.adapter.list_index_config(form_id)
        previous_index = effective_index_definition(previous, config) if previous else None
        changed, removed = changed_index_fields(previous_index, index_definition)
        return self.schedule(form_id, changed, removed, user)

    # Server-side index configuration (index advisor "apply") ------------------------------
    def add_config_field(self, form_id: str, field_id: str, user: str) -> str:
        latest, index_definition, _ = self.plan(form_id)
        field = field_map(latest).get(field_id)
        if field is None or field.get("type") not in INDEXABLE_TYPES:
            raise FormDevError("index_not_supported", f"Field '{field_id}' cannot be indexed")
        if field_id not in indexed_field_ids(index_definition) and len(indexed_field_ids(index_definition)) >= MAX_INDEXED_FIELDS:
            raise FormDevError("too_many_indexed", f"At most {MAX_INDEXED_FIELDS} fields may be indexed")
        self.adapter.add_index_config(form_id, field_id, now_ms(), user)
        return self.schedule(form_id, {field_id}, set(), user)

    def remove_config_field(self, form_id: str, field_id: str, user: str) -> str:
        self.adapter.remove_index_config(form_id, field_id)
        self.invalidate(form_id)
        latest, _, _ = self.plan(form_id)
        removed = set() if field_map(latest).get(field_id, {}).get("indexed") else {field_id}
        return self.schedule(form_id, set(), removed, user)
