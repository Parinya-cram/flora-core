"""What a caller may see of a form's records on the record endpoints (/records, /records/{id}, revisions,
conflicts) and in sync acknowledgements: one place, so every path applies the same rules.

* Reading a form needs formdev.query (administrators always pass), the definition's form-level ``view``
  permission, and the form policy's ``query`` list. If the policy cannot be applied (for example it no longer
  matches the definition), access fails closed: only the raw policy's lists are used, every field the raw policy
  names is hidden, and so is restricted metadata.
* Hidden data keys are the policy's denied fields plus the definition's view denials (Phase 2.8), both named
  with latest-version keys. A stored row keeps the keys of its own schema version, so the hidden keys are mapped
  back through each later version's rename / remove operations before masking. Values set aside by migrations
  (``_retired``) are shown to administrators only.
* Metadata columns subject_id / created_by / updated_by are blanked when the policy restricts $subject_id,
  $created_by or $updated_by ($subject_id also follows the restriction on the subject field itself).
* Deleted records are visible to administrators only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .definition import RETIRED_KEY, field_map
from .errors import FormDevError
from .logic import permission
from .query.access import Principal
from .query.catalog import build_catalog

META_COLUMNS = {"$subject_id": "subject_id", "$created_by": "created_by", "$updated_by": "updated_by"}


@dataclass
class FormView:
    form_id: str
    readable: bool
    is_admin: bool
    hidden_latest: set[str] = field(default_factory=set)
    hidden_meta: set[str] = field(default_factory=set)
    # schema_version -> {key in that version: key in the latest version, or None when later removed}
    key_maps: dict[int, dict[str, str | None]] = field(default_factory=dict)

    def hidden_for(self, schema_version: int | None) -> set[str]:
        """Data keys to remove from a row stored under ``schema_version`` (None: every version's names)."""
        hidden = set(self.hidden_latest)
        maps = self.key_maps.values() if schema_version is None else [self.key_maps.get(int(schema_version), {})]
        for mapping in maps:
            hidden |= {old for old, new in mapping.items() if new is not None and new in self.hidden_latest}
        if not self.is_admin:
            hidden.add(RETIRED_KEY)
        return hidden

    def mask_data(self, data: Any, schema_version: int | None) -> Any:
        return permission.mask(data, self.hidden_for(schema_version))

    def mask_row(self, row: dict[str, Any]) -> dict[str, Any]:
        """A record or revision row as this caller may see it."""
        out = {**row, "data": self.mask_data(row.get("data"), row.get("schema_version"))}
        for column in self.hidden_meta:
            if column in out:
                out[column] = None
        return out

    def can_see(self, row: dict[str, Any]) -> bool:
        return self.readable and (row.get("status") != "deleted" or self.is_admin)


def _key_maps(services: Any, form_id: str) -> dict[int, dict[str, str | None]]:
    """For every published version, its field keys mapped to the latest published version's keys."""
    versions = sorted((row for row in services.adapter.list_schema_versions(form_id) if row["status"] != "draft"), key=lambda row: int(row["schema_version"]))
    maps: dict[int, dict[str, str | None]] = {}
    for index, row in enumerate(versions):
        mapping: dict[str, str | None] = {key: key for key in field_map(row["definition"])}
        for later in versions[index + 1:]:
            ops = (later["definition"].get("migration") or {}).get("ops") or []
            renames = {op["from"]: op["to"] for op in ops if op.get("op") == "rename_field"}
            removed = {op["field"] for op in ops if op.get("op") == "remove_field"}
            for old, current in mapping.items():
                if current is None:
                    continue
                mapping[old] = None if current in removed else renames.get(current, current)
        maps[int(row["schema_version"])] = mapping
    return maps


class RecordAccess:
    """Per request: FormView by form_id, built once."""

    def __init__(self, services: Any, principal: Principal):
        self.services = services
        self.principal = principal
        self._views: dict[str, FormView] = {}

    def form(self, form_id: str) -> FormView:
        if form_id not in self._views:
            self._views[form_id] = self._build(form_id)
        return self._views[form_id]

    def _build(self, form_id: str) -> FormView:
        principal = self.principal
        admin = principal.is_admin
        try:
            latest = self.services.schemas.latest_published(form_id)
        except FormDevError:
            latest = None
        definition = latest["definition"] if latest else None
        view = FormView(form_id, readable=principal.has("formdev.query"), is_admin=admin, key_maps=_key_maps(self.services, form_id) if latest else {})
        if definition is not None:
            view.readable = view.readable and permission.form_allows(definition, "view", principal.codes, admin)
            view.hidden_latest |= permission.denied(definition, "view", principal.codes, admin, nested=True)
        policy_row = self.services.adapter.get_form_policy(form_id)
        if policy_row is None or admin:
            return view
        try:
            catalog = build_catalog(self.services, form_id, with_relations=False)
        except FormDevError:
            # The policy cannot be applied: fail closed on what the raw policy says.
            raw = policy_row.get("policy") if isinstance(policy_row.get("policy"), dict) else {}
            fields = raw.get("fields") if isinstance(raw.get("fields"), dict) else {}
            view.readable = view.readable and principal.allowed(raw.get("query") if isinstance(raw.get("query"), list) else None)
            view.hidden_latest |= {name for name in fields if not name.startswith("$")}
            view.hidden_meta |= set(META_COLUMNS.values())
            return view
        view.readable = view.readable and catalog.can_query(principal)
        view.hidden_latest |= set(catalog.denied_fields(principal))
        # The catalog lists only queryable fields; the policy may also restrict others (files, signatures).
        fields = policy_row["policy"].get("fields") or {}
        view.hidden_latest |= {name for name, codes in fields.items() if not name.startswith("$") and not principal.allowed(codes)}
        view.hidden_meta |= {column for name, column in META_COLUMNS.items() if not catalog.can_read(principal, name)}
        return view
