"""Query catalog: what a source exposes, to whom, and how it is indexed.

A *source* is either a published form (implicit source, id = form_id) or a named source in
formdev_source that points at a form and may add relations and *narrow* access. Access lists
come from the form's policy (formdev_form_policy) and, for named sources, the source config;
every list that applies must allow the principal, so a named source can never widen access.

The catalog is plain data so the pure validator (and the shared fixtures) can use it without
a database.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..definition import displayed, field_map
from ..errors import FormDevError
from ..field_types import QUERY_FAMILY
from ..logic.permission import access_lists
from .access import Principal

SOURCE_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")
# Query family per field type (formdev/spec/field-types.json); types without one cannot be queried.
FIELD_FAMILY = QUERY_FAMILY

# Metadata columns ($name). family drives operators and value typing; "column" is the SQL column.
METADATA: dict[str, dict[str, Any]] = {
    "$record_id": {"column": "record_id", "family": "id", "sortable": True, "groupable": False},
    "$status": {"column": "status", "family": "status", "sortable": False, "groupable": True},
    "$schema_version": {"column": "schema_version", "family": "int", "sortable": False, "groupable": True},
    "$version": {"column": "version", "family": "int", "sortable": False, "groupable": False},
    "$created_at": {"column": "created_at", "family": "time", "sortable": True, "groupable": True},
    "$updated_at": {"column": "updated_at", "family": "time", "sortable": True, "groupable": True},
    # Server receive time; ordered by the per-form ingest sequence (immutable, commit ordered).
    "$ingested_at": {"column": "ingested_at", "family": "time", "sortable": True, "groupable": True, "order_column": "ingest_seq"},
    "$created_by": {"column": "created_by", "family": "user", "sortable": False, "groupable": True},
    "$updated_by": {"column": "updated_by", "family": "user", "sortable": False, "groupable": True},
    "$subject_id": {"column": "subject_id", "family": "text", "sortable": False, "groupable": False},
}
STABLE_CURSOR_KEYS = ("$ingested_at", "$created_at", "$record_id")
CURSOR_KEYS = STABLE_CURSOR_KEYS + ("$updated_at",)


@dataclass
class SourceCatalog:
    source_id: str
    form_id: str
    title: str
    schema_version: int
    fields: dict[str, dict[str, Any]]
    query_access: list[list[str]] = field(default_factory=list)
    export_access: list[list[str]] = field(default_factory=list)
    metadata_access: dict[str, list[list[str]]] = field(default_factory=dict)
    relations: dict[str, dict[str, Any]] = field(default_factory=dict)
    revision: dict[str, Any] = field(default_factory=dict)
    metadata_building: list[str] = field(default_factory=list)  # metadata columns being backfilled ($subject_id)

    # Access --------------------------------------------------------------------------------
    def can_query(self, principal: Principal) -> bool:
        from .access import QUERY_PERMISSION

        return principal.has(QUERY_PERMISSION) and all(principal.allowed(codes) for codes in self.query_access)

    def can_export(self, principal: Principal) -> bool:
        from .access import EXPORT_PERMISSION

        return principal.has(EXPORT_PERMISSION) and self.can_query(principal) and all(principal.allowed(codes) for codes in self.export_access)

    def can_read(self, principal: Principal, name: str) -> bool:
        lists = self.metadata_access.get(name, []) if name.startswith("$") else self.fields.get(name, {}).get("access", [])
        return all(principal.allowed(codes) for codes in lists)

    def can_export_field(self, principal: Principal, name: str) -> bool:
        info = self.fields.get(name, {})
        return info.get("exportable") is not False and all(principal.allowed(codes) for codes in info.get("export_access", []))

    def readable_fields(self, principal: Principal) -> list[str]:
        return [field_id for field_id in self.fields if self.can_read(principal, field_id)]

    def denied_fields(self, principal: Principal) -> set[str]:
        return {field_id for field_id in self.fields if not self.can_read(principal, field_id)}

    def form_ids(self) -> list[str]:
        return sorted({self.form_id, *(relation["target"].form_id for relation in self.relations.values())})

    def public(self, principal: Principal) -> dict[str, Any]:
        """The catalog as the caller may see it (served to the UI and the TS validator)."""
        return {
            "source_id": self.source_id, "form_id": self.form_id, "title": self.title, "schema_version": self.schema_version,
            "fields": {fid: {key: info.get(key) for key in ("type", "label", "unit", "indexed", "state", "options")}
                       for fid, info in self.fields.items() if self.can_read(principal, fid)},
            "metadata": sorted(name for name in METADATA if self.can_read(principal, name)),
            "metadata_building": [name for name in self.metadata_building if self.can_read(principal, name)],
            # A relation joins on its local field: hidden when the caller may not read that field.
            "relations": {name: {"local": rel["local"], "foreign": rel["foreign"], "source_id": rel["target"].source_id,
                                 "fields": {fid: {"type": info["type"], "label": info.get("label")} for fid, info in rel["target"].fields.items()
                                            if rel["target"].can_read(principal, fid)}}
                          for name, rel in self.relations.items() if rel["target"].can_query(principal) and self.can_read(principal, rel["local"])},
            "can_export": self.can_export(principal),
        }


def _codes(value: Any) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(code, str) and code for code in value):
        raise FormDevError("invalid_policy", "Access lists must be arrays of role or permission codes")
    return value


def validate_policy(policy: Any, definition: dict[str, Any]) -> dict[str, Any]:
    """Normalize a form policy {query, export, fields:{field|$meta: [codes]}}."""
    if not isinstance(policy, dict) or set(policy) - {"query", "export", "fields"}:
        raise FormDevError("invalid_policy", "Policy keys are query, export and fields")
    known = set(field_map(definition)) | set(METADATA)
    fields = policy.get("fields") or {}
    if not isinstance(fields, dict) or any(name not in known for name in fields):
        raise FormDevError("invalid_policy", "Policy fields must be form fields or $metadata columns")
    return {"query": _codes(policy.get("query")), "export": _codes(policy.get("export")),
            "fields": {name: _codes(codes) or [] for name, codes in fields.items()}}


def validate_source_config(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict) or set(config) - {"form_id", "relations", "query", "export", "fields", "hidden"}:
        raise FormDevError("invalid_source", "Source config keys are form_id, relations, query, export, fields, hidden")
    relations = config.get("relations") or {}
    if not isinstance(relations, dict):
        raise FormDevError("invalid_source", "relations must be an object")
    for name, relation in relations.items():
        if not SOURCE_ID.match(name) or not isinstance(relation, dict) or set(relation) != {"source", "local", "foreign"}:
            raise FormDevError("invalid_relation", f"Relation '{name}' needs source, local and foreign")
    hidden = config.get("hidden") or []
    if not isinstance(hidden, list) or not all(isinstance(item, str) for item in hidden):
        raise FormDevError("invalid_source", "hidden must be a list of field ids")
    return {"form_id": config.get("form_id"), "relations": relations, "query": _codes(config.get("query")),
            "export": _codes(config.get("export")), "fields": {k: _codes(v) or [] for k, v in (config.get("fields") or {}).items()},
            "hidden": hidden}


def _lists(*values: list[str] | None) -> list[list[str]]:
    return [value for value in values if value is not None]


def build_catalog(services: Any, source_id: str, with_relations: bool = True) -> SourceCatalog:
    """Resolve a source from storage. Raises unknown_source when it does not exist or is unpublished."""
    if not isinstance(source_id, str) or not SOURCE_ID.match(source_id):
        raise FormDevError("unknown_source", "Unknown source", 404)
    adapter = services.adapter
    named = adapter.get_source(source_id)
    config = validate_source_config(named["config"]) if named else {"relations": {}, "query": None, "export": None, "fields": {}, "hidden": []}
    form_id = named["form_id"] if named else source_id
    form = adapter.get_form(form_id)
    if form is None or not form.get("published_version"):
        raise FormDevError("unknown_source", "Unknown source", 404)
    latest = services.schemas.latest_published(form_id)
    definition = latest["definition"]
    policy_row = adapter.get_form_policy(form_id)
    policy = validate_policy(policy_row["policy"], definition) if policy_row else {"query": None, "export": None, "fields": {}}
    indexed = services.indexing.indexed_fields(form_id)
    grants = access_lists(definition)
    fields: dict[str, dict[str, Any]] = {}
    for field_id, info in field_map(definition).items():
        if field_id in config["hidden"] or info.get("type") not in FIELD_FAMILY or not displayed(info, "query"):
            continue
        index_info = indexed.get(field_id)
        fields[field_id] = {
            "type": info["type"], "label": info.get("label"), "unit": info.get("unit"),
            "options": [option["value"] for option in info.get("options") or []] or None,
            "indexed": index_info is not None, "state": index_info["state"] if index_info else None,
            "origin": index_info["origin"] if index_info else None, "exportable": displayed(info, "export"),
            "access": _lists(policy["fields"].get(field_id), config["fields"].get(field_id)) + grants["fields"].get(field_id, {}).get("view", []),
            "export_access": grants["fields"].get(field_id, {}).get("export", []),
        }
    catalog = SourceCatalog(
        source_id=source_id, form_id=form_id, title=definition.get("title", form_id), schema_version=int(latest["schema_version"]),
        fields=fields,
        query_access=_lists(policy["query"], config["query"], grants["form"]["view"]),
        export_access=_lists(policy["export"], config["export"], grants["form"]["export"]),
        metadata_access={name: _lists(policy["fields"].get(name), config["fields"].get(name)) for name in METADATA},
        revision={"published": int(latest["schema_version"]), "policy": policy_row["version"] if policy_row else 0,
                  "source": named["version"] if named else 0},
        metadata_building=services.indexing.metadata_building(form_id),
    )
    # $subject_id is the subject field's value: it is as restricted as that field (policy, source config and the
    # definition's view permission), not only by its own metadata entry.
    subject = (definition.get("extensions") or {}).get("flora.subject_field")
    if isinstance(subject, str):
        catalog.metadata_access["$subject_id"] = catalog.metadata_access["$subject_id"] + _lists(policy["fields"].get(subject), config["fields"].get(subject)) \
            + grants["fields"].get(subject, {}).get("view", [])
        if subject in config["hidden"]:
            catalog.metadata_access["$subject_id"] = catalog.metadata_access["$subject_id"] + [[]]
    if with_relations:
        for name, relation in config["relations"].items():
            try:
                target = build_catalog(services, relation["source"], with_relations=False)
            except FormDevError:
                raise FormDevError("invalid_relation", f"Relation '{name}' points at an unknown source") from None
            catalog.relations[name] = {"local": relation["local"], "foreign": relation["foreign"], "target": target}
            catalog.revision[f"relation:{name}"] = target.revision
    return catalog


def catalog_from_dict(value: dict[str, Any]) -> SourceCatalog:
    """Fixture/test helper: build a catalog from plain JSON."""
    relations = {name: {"local": rel["local"], "foreign": rel["foreign"], "target": catalog_from_dict(rel["target"])}
                 for name, rel in (value.get("relations") or {}).items()}
    fields = {fid: {"type": info["type"], "label": info.get("label", fid), "unit": info.get("unit"), "options": info.get("options"),
                    "indexed": bool(info.get("indexed")), "state": info.get("state", "ready" if info.get("indexed") else None),
                    "access": [info["access"]] if info.get("access") is not None else []}
              for fid, info in value["fields"].items()}
    return SourceCatalog(
        source_id=value["source_id"], form_id=value.get("form_id", value["source_id"]), title=value.get("title", value["source_id"]),
        schema_version=value.get("schema_version", 1), fields=fields,
        query_access=[value["query_access"]] if value.get("query_access") is not None else [],
        export_access=[value["export_access"]] if value.get("export_access") is not None else [],
        metadata_access={name: [codes] for name, codes in (value.get("metadata_access") or {}).items()},
        relations=relations,
        metadata_building=list(value.get("metadata_building") or []),
    )
