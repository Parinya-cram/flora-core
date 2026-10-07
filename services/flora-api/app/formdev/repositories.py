"""Repository layer: the only place that applies FormDev business rules to storage.

API routes, the sync service and the formpack installer call repositories; none of
them touch an adapter's tables directly, and repositories never know which vendor the
adapter talks to.
"""
from __future__ import annotations

import base64
import re
import time
import uuid
from typing import Any, Callable

from .adapters.base import DataAdapter, IndexFilter
from .definition import (
    INDEXABLE_TYPES,
    Issue,
    checksum,
    describe_issues,
    field_key,
    field_map,
    index_entries,
    validate_definition,
)
from .errors import FormDevError
from .field_types import FIELD_TYPES
from .logic.evaluate import evaluate_record
from .logic.lookup import lookup_ids
from .attachments import AttachmentStore, attachment_store
from .lookups import LookupRepository
from .styles import normalize_style, stored_font, validate_font, validate_style, validate_style_registry
from .indexing import IndexMaintenance
from .migration import compatibility_issues, migrate

RECORD_ID = re.compile(r"^[A-Za-z0-9-]{8,64}\Z")
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
ACTIVE_STATUSES = ["draft", "submitted"]


def now_ms() -> int:
    return int(time.time() * 1000)


def _issues_error(code: str, message: str, issues: list[Any]) -> FormDevError:
    return FormDevError(code, message, 422, [issue.as_dict() for issue in issues])


class StyleRepository:
    """Style and font registry. New styles/fonts are data rows, never core code changes."""

    def __init__(self, adapter: DataAdapter):
        self.adapter = adapter

    def list_styles(self) -> list[dict[str, Any]]:
        return self.adapter.list_styles()

    def get_style(self, style_id: str) -> dict[str, Any]:
        row = self.adapter.get_style(style_id)
        if row is None:
            raise FormDevError("style_not_found", f"Style '{style_id}' not found", 404)
        return row

    def save_style(self, style_id: str, definition: dict[str, Any], version: int = 1) -> dict[str, Any]:
        issues = validate_style(style_id, normalize_style(definition) if isinstance(definition, dict) else definition, self.font_ids())
        if issues:
            raise FormDevError("invalid_style", "Style definition is not valid", 422, [issue.as_dict() for issue in issues])
        row = {"style_id": style_id, "version": version, "definition": definition, "updated_at": now_ms()}
        self.adapter.save_style(row)
        return row

    def put_style(self, style_id: str, definition: Any) -> dict[str, Any]:
        """Add or change a registry style (administrators). The version goes up by one, and the registry must
        stay consistent: tokens and fonts valid, parent present, no inheritance cycle."""
        existing = self.adapter.get_style(style_id)
        others = [row for row in self.adapter.list_styles() if row["style_id"] != style_id]
        version = int(existing["version"]) + 1 if existing else 1
        candidate = {"style_id": style_id, "version": version, "definition": definition if isinstance(definition, dict) else {}}
        own = f"$[{len(others)}]"
        issues = [Issue("$" + issue.path[len(own):] if issue.path.startswith(own) else issue.path, issue.code, issue.message)
                  for issue in validate_style_registry([*others, candidate], self.font_ids())
                  if issue.path.startswith(own) or issue.path.startswith(f"$.{style_id}.")]
        if not isinstance(definition, dict):
            issues.insert(0, Issue("$", "not_object", "Style definition must be an object"))
        if issues:
            raise FormDevError("invalid_style", "Style definition is not valid", 422, [issue.as_dict() for issue in issues])
        return self.save_style(style_id, definition, version)

    def put_font(self, font_id: str, entry: Any) -> dict[str, Any]:
        """Add or change a font (administrators) from a registry entry {metadata, assets?, fallback}. Only
        metadata is stored; font files are never uploaded through FormDev."""
        if not isinstance(entry, dict) or not isinstance(entry.get("metadata"), dict):
            raise FormDevError("invalid_font", "Body must be {metadata, assets?, fallback}", 422)
        return self.save_font(font_id, stored_font(entry))

    def list_fonts(self) -> list[dict[str, Any]]:
        return self.adapter.list_fonts()

    def get_font(self, font_id: str) -> dict[str, Any]:
        row = self.adapter.get_font(font_id)
        if row is None:
            raise FormDevError("font_not_found", f"Font '{font_id}' not found", 404)
        return row

    def save_font(self, font_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
        issues = validate_font(font_id, metadata)
        if issues:
            raise FormDevError("invalid_font", "Font needs a registry id, a family and a fallback list", 422, [issue.as_dict() for issue in issues])
        row = {"font_id": font_id, "metadata": metadata, "updated_at": now_ms()}
        self.adapter.save_font(row)
        return row

    def style_ids(self) -> list[str]:
        return [row["style_id"] for row in self.adapter.list_styles()]

    def font_ids(self) -> list[str]:
        return [row["font_id"] for row in self.adapter.list_fonts()]


class FormRepository:
    def __init__(self, adapter: DataAdapter):
        self.adapter = adapter

    def list(self) -> list[dict[str, Any]]:
        return self.adapter.list_forms()

    def get(self, form_id: str) -> dict[str, Any]:
        row = self.adapter.get_form(form_id)
        if row is None:
            raise FormDevError("form_not_found", f"Form '{form_id}' not found", 404)
        return row


class SchemaRepository:
    """Versioned form definitions. Published versions are immutable (also enforced by DB triggers)."""

    def __init__(self, adapter: DataAdapter, styles: StyleRepository):
        self.adapter = adapter
        self.styles = styles
        self.forms = FormRepository(adapter)
        # Set by services_for: (form_id, previous published definition or None, user) -> coverage state.
        self.on_published: Callable[[str, dict[str, Any] | None, str], str] | None = None

    def _previous_published(self, form_id: str) -> dict[str, Any] | None:
        form = self.adapter.get_form(form_id)
        if not form or not form.get("published_version"):
            return None
        row = self.adapter.get_schema_version(form_id, int(form["published_version"]))
        return row["definition"] if row else None

    def _published(self, form_id: str, previous: dict[str, Any] | None, user: str) -> None:
        self.adapter.bump_data_version(form_id, now_ms())
        if self.on_published is not None:
            self.on_published(form_id, previous, user)

    def validate(self, definition: Any) -> list[dict[str, str]]:
        """Issues with a readable location (Section "…" › Field "…" (key) › property)."""
        return describe_issues(definition, validate_definition(definition, self.styles.style_ids(), self.styles.font_ids()))

    def _require_valid(self, definition: Any) -> None:
        issues = validate_definition(definition, self.styles.style_ids(), self.styles.font_ids())
        if issues:
            raise FormDevError("invalid_definition", "Form definition is not valid", 422, describe_issues(definition, issues))

    def get_version(self, form_id: str, schema_version: int) -> dict[str, Any]:
        row = self.adapter.get_schema_version(form_id, schema_version)
        if row is None:
            raise FormDevError("version_not_found", f"Form '{form_id}' has no version {schema_version}", 404)
        return row

    def versions(self, form_id: str) -> list[dict[str, Any]]:
        self.forms.get(form_id)
        return self.adapter.list_schema_versions(form_id)

    def latest_published(self, form_id: str) -> dict[str, Any]:
        form = self.forms.get(form_id)
        if not form.get("published_version"):
            raise FormDevError("form_not_published", f"Form '{form_id}' has no published version", 409)
        return self.get_version(form_id, int(form["published_version"]))

    def loader(self, form_id: str) -> Callable[[int], dict[str, Any]]:
        cache: dict[int, dict[str, Any]] = {}

        def load(version: int) -> dict[str, Any]:
            if version not in cache:
                cache[version] = self.get_version(form_id, version)["definition"]
            return cache[version]

        return load

    def create_form(self, definition: dict[str, Any], user: str) -> dict[str, Any]:
        self._require_valid(definition)
        if definition["schema_version"] != 1:
            raise FormDevError("invalid_schema_version", "A new form starts at schema_version 1")
        if self.adapter.get_form(definition["form_id"]) is not None:
            raise FormDevError("form_exists", f"Form '{definition['form_id']}' already exists", 409)
        current = now_ms()
        with self.adapter.transaction():
            self.adapter.save_form({
                "form_id": definition["form_id"], "title": definition["title"], "latest_version": 1,
                "published_version": None, "created_at": current, "created_by": user,
                "updated_at": current, "updated_by": user,
            })
            self.adapter.insert_schema_version(self._version_row(definition, "draft", user, current))
        return self.get_version(definition["form_id"], 1)

    def save_draft(self, definition: dict[str, Any], user: str) -> dict[str, Any]:
        self._require_valid(definition)
        form = self.forms.get(definition["form_id"])
        version = definition["schema_version"]
        existing = self.adapter.get_schema_version(form["form_id"], version)
        current = now_ms()
        with self.adapter.transaction():
            if existing is not None:
                if existing["status"] != "draft":
                    raise FormDevError("version_immutable", f"Version {version} is {existing['status']} and cannot be changed", 409)
                self.adapter.update_schema_version(form["form_id"], version, {"definition": definition, "checksum": checksum(definition)})
            else:
                latest = self.adapter.get_schema_version(form["form_id"], int(form["latest_version"]))
                if version != int(form["latest_version"]) + 1 or (latest and latest["status"] == "draft"):
                    raise FormDevError("invalid_schema_version", "Create the next version only after the current draft is published")
                self.adapter.insert_schema_version(self._version_row(definition, "draft", user, current))
                form["latest_version"] = version
            form.update({"title": definition["title"], "updated_at": current, "updated_by": user})
            self.adapter.save_form(form)
        return self.get_version(form["form_id"], version)

    def new_draft(self, form_id: str, user: str) -> dict[str, Any]:
        form = self.forms.get(form_id)
        latest = self.get_version(form_id, int(form["latest_version"]))
        if latest["status"] == "draft":
            return latest
        definition = dict(latest["definition"])
        definition["schema_version"] = int(form["latest_version"]) + 1
        definition["migration"] = {"from": int(form["latest_version"]), "ops": []}
        return self.save_draft(definition, user)

    def publish(self, form_id: str, schema_version: int, user: str) -> dict[str, Any]:
        row = self.get_version(form_id, schema_version)
        if row["status"] != "draft":
            raise FormDevError("version_immutable", f"Version {schema_version} is already {row['status']}", 409)
        self._require_valid(row["definition"])
        if schema_version > 1:
            previous = self.get_version(form_id, schema_version - 1)
            if previous["status"] == "draft":
                raise FormDevError("previous_not_published", "Publish versions in order")
            problems = compatibility_issues(previous["definition"], row["definition"])
            if problems:
                raise FormDevError("migration_incomplete", "Records of the previous version would not be readable", 422, problems)
        current = now_ms()
        previous = self._previous_published(form_id)
        with self.adapter.transaction():
            self.adapter.update_schema_version(form_id, schema_version, {"status": "published", "published_at": current, "published_by": user})
            self._carry_access(form_id, row["definition"], user, current)
            form = self.forms.get(form_id)
            form.update({"published_version": schema_version, "updated_at": current, "updated_by": user})
            self.adapter.save_form(form)
        self._published(form_id, previous, user)
        return self.get_version(form_id, schema_version)

    def _carry_access(self, form_id: str, definition: dict[str, Any], user: str, at: int) -> None:
        """Keep field restrictions valid across a publish: a renamed field keeps its access list under the new key,
        a removed field's entry is dropped (its values are retired). Without this a stale policy no longer
        validates against the latest definition, and field protection would depend on error handling."""
        ops = (definition.get("migration") or {}).get("ops") or []
        renames = {op["from"]: op["to"] for op in ops if op.get("op") == "rename_field"}
        keys = set(field_map(definition))

        def carry(mapping: dict[str, Any]) -> dict[str, Any]:
            return {renames.get(name, name): codes for name, codes in mapping.items()
                    if name.startswith("$") or renames.get(name, name) in keys}

        policy = self.adapter.get_form_policy(form_id)
        if policy is not None and isinstance(policy.get("policy"), dict):
            body = dict(policy["policy"])
            fields = carry(body.get("fields") or {})
            if fields != (body.get("fields") or {}):
                body["fields"] = fields
                self.adapter.save_form_policy({"form_id": form_id, "policy": body, "version": int(policy["version"]) + 1, "updated_at": at, "updated_by": user})
        for source in self.adapter.list_sources():
            if source.get("form_id") != form_id or not isinstance(source.get("config"), dict):
                continue
            config = dict(source["config"])
            changed = dict(config)
            if config.get("fields"):
                changed["fields"] = carry(config["fields"])
            if config.get("hidden"):
                changed["hidden"] = [renames.get(name, name) for name in config["hidden"] if renames.get(name, name) in keys]
            if config.get("relations"):
                changed["relations"] = {name: {**relation, "local": renames.get(relation.get("local"), relation.get("local"))}
                                        for name, relation in config["relations"].items()}
            if changed != config:
                self.adapter.save_source({**source, "config": changed, "version": int(source["version"]) + 1, "updated_at": at, "updated_by": user})

    def install_published(self, definition: dict[str, Any], user: str) -> str:
        """Install a published version from a formpack. Re-installing the same version is a no-op."""
        self._require_valid(definition)
        form_id, version = definition["form_id"], definition["schema_version"]
        existing = self.adapter.get_schema_version(form_id, version)
        if existing is not None:
            if existing["checksum"] != checksum(definition):
                raise FormDevError("version_conflict", f"{form_id} v{version} is already installed with different content", 409)
            return "unchanged"
        current = now_ms()
        previous = self._previous_published(form_id)
        with self.adapter.transaction():
            form = self.adapter.get_form(form_id) or {
                "form_id": form_id, "title": definition["title"], "latest_version": 0, "published_version": None,
                "created_at": current, "created_by": user,
            }
            self.adapter.save_form({**form, "updated_at": current, "updated_by": user})
            row = self._version_row(definition, "published", user, current)
            row.update({"published_at": current, "published_by": user})
            self.adapter.insert_schema_version(row)
            form = self.forms.get(form_id)
            form.update({
                "latest_version": max(int(form["latest_version"]), version),
                "published_version": max(int(form.get("published_version") or 0), version),
                "title": definition["title"] if version >= int(form["latest_version"]) else form["title"],
            })
            self.adapter.save_form(form)
        if int(form["published_version"]) == version:
            self._published(form_id, previous, user)
        return "installed"

    @staticmethod
    def _version_row(definition: dict[str, Any], status: str, user: str, at: int) -> dict[str, Any]:
        return {
            "form_id": definition["form_id"], "schema_version": definition["schema_version"], "status": status,
            "definition": definition, "checksum": checksum(definition), "created_at": at, "created_by": user,
            "published_at": None, "published_by": None,
        }


def encode_cursor(row: dict[str, Any]) -> str:
    raw = f"{row['updated_at']}:{row['record_id']}".encode("ascii")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[int, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("ascii")
        updated_at, record_id = raw.split(":", 1)
        if not RECORD_ID.match(record_id):
            raise ValueError
        return int(updated_at), record_id
    except (ValueError, UnicodeDecodeError):
        raise FormDevError("invalid_cursor", "Pagination cursor is not valid") from None


class RecordRepository:
    """Form records: hybrid storage (metadata columns + JSON data + record index)."""

    def __init__(self, adapter: DataAdapter, schemas: SchemaRepository, indexing: IndexMaintenance | None = None):
        self.adapter = adapter
        self.schemas = schemas
        self.indexing = indexing or IndexMaintenance(adapter, schemas)
        self.lookups = LookupRepository(adapter)
        self.attachments: AttachmentStore = attachment_store(adapter)

    def get_raw(self, record_id: str) -> dict[str, Any] | None:
        return self.adapter.get_record(record_id)

    def get(self, record_id: str, as_version: int | None = None) -> dict[str, Any]:
        record = self.adapter.get_record(record_id)
        if record is None:
            raise FormDevError("record_not_found", f"Record '{record_id}' not found", 404)
        if as_version is None or as_version == record["schema_version"]:
            return record
        data = migrate(record["data"], record["schema_version"], as_version, self.schemas.loader(record["form_id"]))
        return {**record, "data": data, "schema_version": as_version, "stored_schema_version": record["schema_version"], "migrated": True}

    def revisions(self, record_id: str) -> list[dict[str, Any]]:
        self.get(record_id)
        return self.adapter.list_revisions(record_id)

    def _definition(self, form_id: str, schema_version: int) -> dict[str, Any]:
        return self.schemas.get_version(form_id, schema_version)["definition"]

    @staticmethod
    def _edited_at(updated_at: int | None) -> int:
        current = now_ms()
        if updated_at is None:
            return current
        return min(int(updated_at), current + MAX_CLOCK_SKEW_MS)

    def _check(self, definition: dict[str, Any], data: Any, status: str) -> dict[str, Any]:
        """Run the form's logic (Phase 2) and return the data to store: calculated values recomputed by the
        server, values cleared where the definition asks, Other text tidied. Raises on any issue."""
        result = evaluate_record(definition, data, status, lookups=self.lookups.tables(lookup_ids(definition)))
        issues = result.issues or self.attachments.missing(result.data)
        if issues:
            raise _issues_error("invalid_record", "Record data is not valid", issues)
        return result.data

    def _persist(self, row: dict[str, Any], expected_version: int | None) -> dict[str, Any]:
        """Write a record version, its revision and index rows, and bump the form's change counter.
        Index rows and subject_id follow the latest published definition (see indexing.py)."""
        entries, row["subject_id"] = self.indexing.derive(row["form_id"], int(row["schema_version"]), row["data"])
        at = now_ms()
        with self.adapter.transaction():
            if expected_version is None:
                # The per-form counter row is locked from here to commit, so ingest_seq is commit-ordered.
                row["ingest_seq"] = self.adapter.bump_data_version(row["form_id"], at)
                row["ingested_at"] = at
                self.adapter.insert_record(row)
            elif not self.adapter.update_record(row, expected_version):
                current = self.adapter.get_record(row["record_id"])
                raise FormDevError("version_conflict", "The record was changed by someone else", 409, {"current": current})
            self.adapter.insert_revision({key: row[key] for key in ("record_id", "version", "schema_version", "status", "data", "updated_at", "updated_by", "sync_id")})
            self.adapter.replace_index_entries(row["record_id"], row["form_id"], entries, row["status"], int(row["updated_at"]))
            if expected_version is not None:
                self.adapter.bump_data_version(row["form_id"], at)
        return row

    def create(
        self,
        form_id: str,
        data: dict[str, Any],
        user: str,
        status: str = "draft",
        record_id: str | None = None,
        schema_version: int | None = None,
        updated_at: int | None = None,
        sync_id: str | None = None,
    ) -> dict[str, Any]:
        if status not in ACTIVE_STATUSES:
            raise FormDevError("invalid_status", "New records are draft or submitted")
        if schema_version is None:
            version_row = self.schemas.latest_published(form_id)
        else:
            version_row = self.schemas.get_version(form_id, schema_version)
            if version_row["status"] == "draft":
                raise FormDevError("form_not_published", "Records can only use published form versions", 409)
        record_id = record_id or str(uuid.uuid4())
        if not RECORD_ID.match(record_id):
            raise FormDevError("invalid_record_id", "record_id must be 8-64 letters, digits or '-'")
        if self.adapter.get_record(record_id) is not None:
            raise FormDevError("record_exists", f"Record '{record_id}' already exists", 409)
        definition = version_row["definition"]
        data = self._check(definition, data, status)
        edited_at = self._edited_at(updated_at)
        row = {
            "record_id": record_id, "form_id": form_id, "schema_version": version_row["schema_version"],
            "status": status, "data": data, "created_at": edited_at, "created_by": user,
            "updated_at": edited_at, "updated_by": user, "sync_id": sync_id, "version": 1,
        }
        return self._persist(row, None)

    def update(
        self,
        record_id: str,
        data: dict[str, Any],
        expected_version: int,
        user: str,
        status: str | None = None,
        updated_at: int | None = None,
        sync_id: str | None = None,
    ) -> dict[str, Any]:
        current = self.get(record_id)
        if current["status"] == "deleted":
            raise FormDevError("record_deleted", "Deleted records cannot be changed", 409)
        status = status or current["status"]
        if status not in ACTIVE_STATUSES or (current["status"] == "submitted" and status == "draft"):
            raise FormDevError("invalid_transition", f"Cannot move a {current['status']} record to {status}", 409)
        definition = self._definition(current["form_id"], current["schema_version"])
        data = self._check(definition, data, status)
        row = {
            **current, "data": data, "status": status, "updated_at": self._edited_at(updated_at),
            "updated_by": user, "sync_id": sync_id, "version": current["version"] + 1,
        }
        return self._persist(row, expected_version)

    def submit(self, record_id: str, data: dict[str, Any], expected_version: int, user: str, **kwargs: Any) -> dict[str, Any]:
        return self.update(record_id, data, expected_version, user, status="submitted", **kwargs)

    def delete(self, record_id: str, expected_version: int, user: str, updated_at: int | None = None, sync_id: str | None = None) -> dict[str, Any]:
        """Soft delete: the record and every revision stay for audit; it leaves active searches."""
        current = self.get(record_id)
        if current["status"] == "deleted":
            return current
        definition = self._definition(current["form_id"], current["schema_version"])
        row = {
            **current, "status": "deleted", "updated_at": self._edited_at(updated_at),
            "updated_by": user, "sync_id": sync_id, "version": current["version"] + 1,
        }
        return self._persist(row, expected_version)

    def upgrade(self, record_id: str, expected_version: int, user: str, to_version: int | None = None) -> dict[str, Any]:
        """Persist a migration to a newer schema version. The previous revision is kept intact.
        Required-field rules are those of the version a record was submitted under, so
        only value/type rules are re-checked here."""
        current = self.get(record_id)
        target = to_version or int(self.schemas.latest_published(current["form_id"])["schema_version"])
        target_row = self.schemas.get_version(current["form_id"], target)
        if target_row["status"] == "draft":
            raise FormDevError("form_not_published", "Records can only use published form versions", 409)
        if target == current["schema_version"]:
            return current
        data = migrate(current["data"], current["schema_version"], target, self.schemas.loader(current["form_id"]))
        data = self._check(target_row["definition"], data, "draft")
        row = {**current, "data": data, "schema_version": target, "updated_at": now_ms(), "updated_by": user, "version": current["version"] + 1}
        return self._persist(row, expected_version)

    @staticmethod
    def _filter_value(field: dict[str, Any], op: str, value: Any) -> Any:
        """Coerce a filter value (often text from a query string) to the field's index column type."""
        kind = FIELD_TYPES.get(field["type"], {}).get("value")
        key = field_key(field)
        if kind in ("number", "integer", "decimal"):
            if op == "prefix":
                raise FormDevError("invalid_filter", "prefix filters only apply to text fields")
            if isinstance(value, str):
                try:
                    value = float(value)
                except ValueError:
                    raise FormDevError("invalid_filter", f"'{key}' needs a numeric filter value") from None
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise FormDevError("invalid_filter", f"'{key}' needs a numeric filter value")
            return value
        if kind == "boolean":
            if op != "eq" or value not in (True, False, "true", "false"):
                raise FormDevError("invalid_filter", f"'{key}' accepts eq true or false")
            return value in (True, "true")
        if not isinstance(value, str):
            raise FormDevError("invalid_filter", f"'{key}' needs a text filter value")
        return value

    def search(
        self,
        form_id: str,
        filters: list[IndexFilter] | None = None,
        statuses: list[str] | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> dict[str, Any]:
        definition = self.schemas.latest_published(form_id)["definition"]
        indexed = {field_id: field for field_id, field in field_map(definition).items() if field.get("indexed") and field["type"] in INDEXABLE_TYPES}
        filters = [dict(item) for item in filters or []]  # type: ignore[misc]
        for item in filters:
            if item.get("field") not in indexed:
                raise FormDevError("field_not_indexed", f"Field '{item.get('field')}' is not indexed; mark it indexed to filter on it")
            if item.get("op") not in ("eq", "prefix", "gte", "lte"):
                raise FormDevError("invalid_filter", "Filter op must be eq, prefix, gte or lte")
            item["value"] = self._filter_value(indexed[item["field"]], item["op"], item.get("value"))
        statuses = statuses or ACTIVE_STATUSES
        if any(status not in ("draft", "submitted", "deleted") for status in statuses):
            raise FormDevError("invalid_status", "Unknown record status filter")
        limit = max(1, min(int(limit), MAX_LIMIT))
        rows = self.adapter.search_records(form_id, statuses, filters, decode_cursor(cursor) if cursor else None, limit + 1)
        page = rows[:limit]
        return {"rows": page, "next_cursor": encode_cursor(page[-1]) if len(rows) > limit else None}
