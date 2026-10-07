"""Lookup tables (Phase 2.3): registry data behind dependent options and derived values.

A lookup is {lookup_id, version, metadata: {title, columns: [{name, label}], authoritative, notice, source},
entries: [{column: text}]}. Stored in formdev_lookup, served by /api/formdev/lookups and packed into formpacks so
offline clients evaluate the same options as the server. formdev/scripts/import_lookup.py builds one from CSV.
"""
from __future__ import annotations

import re
import time
from typing import Any

from .adapters.base import DataAdapter
from .definition import Issue
from .errors import FormDevError

LOOKUP_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")
COLUMN = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z")
METADATA_KEYS = {"title", "columns", "authoritative", "notice", "source"}
MAX_ENTRIES = 50_000
MAX_COLUMNS = 32
MAX_TEXT = 500


def validate_lookup(lookup_id: Any, metadata: Any, entries: Any) -> list[Issue]:
    issues: list[Issue] = []
    if not isinstance(lookup_id, str) or not LOOKUP_ID.match(lookup_id):
        issues.append(Issue("$.lookup_id", "invalid_lookup_id", "lookup_id: lowercase letters, digits and _ (2-64)"))
    if not isinstance(metadata, dict):
        return issues + [Issue("$.metadata", "not_object", "metadata must be an object")]
    for key in sorted(set(metadata) - METADATA_KEYS):
        issues.append(Issue(f"$.metadata.{key}", "unknown_property", f"Unknown property '{key}'"))
    if not isinstance(metadata.get("title"), str) or not metadata["title"].strip():
        issues.append(Issue("$.metadata.title", "required", "title is required"))
    columns = metadata.get("columns")
    names: list[str] = []
    if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_COLUMNS:
        issues.append(Issue("$.metadata.columns", "invalid_lookup", f"columns: 1-{MAX_COLUMNS} entries of {{name, label}}"))
    else:
        for index, column in enumerate(columns):
            name = column.get("name") if isinstance(column, dict) else None
            if not isinstance(name, str) or not COLUMN.match(name) or name in names:
                issues.append(Issue(f"$.metadata.columns[{index}].name", "invalid_lookup", "Column names are unique lowercase identifiers"))
            else:
                names.append(name)
    if "authoritative" in metadata and not isinstance(metadata["authoritative"], bool):
        issues.append(Issue("$.metadata.authoritative", "wrong_type", "authoritative is true or false"))
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        return issues + [Issue("$.entries", "invalid_lookup", f"entries: a list of at most {MAX_ENTRIES} rows")]
    allowed = set(names)
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or set(entry) - allowed:
            issues.append(Issue(f"$.entries[{index}]", "invalid_lookup", "Each entry maps declared columns to text"))
        elif any(not isinstance(value, str) or len(value) > MAX_TEXT for value in entry.values()):
            issues.append(Issue(f"$.entries[{index}]", "invalid_lookup", f"Entry values are text of at most {MAX_TEXT} characters"))
        if len(issues) > 50:
            break
    return issues


class LookupRepository:
    def __init__(self, adapter: DataAdapter):
        self.adapter = adapter

    def list(self) -> list[dict[str, Any]]:
        return self.adapter.list_lookups()

    def get(self, lookup_id: str) -> dict[str, Any]:
        row = self.adapter.get_lookup(lookup_id) if isinstance(lookup_id, str) else None
        if row is None:
            raise FormDevError("lookup_not_found", f"Lookup '{lookup_id}' not found", 404)
        return row

    def put(self, lookup_id: str, body: Any, user: str) -> dict[str, Any]:
        """Add or replace a lookup (administrators). The version goes up by one."""
        if not isinstance(body, dict) or set(body) - {"metadata", "entries"}:
            raise FormDevError("invalid_lookup", "Body must be {metadata, entries}", 422)
        issues = validate_lookup(lookup_id, body.get("metadata"), body.get("entries"))
        if issues:
            raise FormDevError("invalid_lookup", "Lookup is not valid", 422, [issue.as_dict() for issue in issues])
        existing = self.adapter.get_lookup(lookup_id)
        row = {"lookup_id": lookup_id, "version": int(existing["version"]) + 1 if existing else 1, "metadata": body["metadata"],
               "entries": body["entries"], "updated_at": int(time.time() * 1000), "updated_by": user}
        with self.adapter.transaction():
            self.adapter.save_lookup(row)
        return row

    def tables(self, lookup_ids: set[str]) -> dict[str, list[dict[str, Any]]]:
        """lookup_id -> entries for the ids that exist (the evaluator skips lookups it is not given)."""
        out: dict[str, list[dict[str, Any]]] = {}
        for lookup_id in sorted(lookup_ids):
            row = self.adapter.get_lookup(lookup_id)
            if row is not None:
                out[lookup_id] = row["entries"]
        return out
