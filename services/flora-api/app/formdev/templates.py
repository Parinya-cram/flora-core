"""Template library (Form Studio): complete form definitions kept as starting points.

A template is {template_id, title, description, origin (ai | manual | import), status (draft | reviewed), definition,
report (the AI builder's document report), sources (the source documents: name, type, size, sha256, inspection notes),
version, created/updated}. AI-built templates start as drafts; an author checks them against the source documents
(kept in the attachment store) and marks them reviewed, which needs a definition without validation problems. Forms
are created from a template as ordinary Form Studio drafts; only their published versions reach Workflow Studio.
"""
from __future__ import annotations

import re
import time
from collections.abc import Callable
from typing import Any

from .adapters.base import DataAdapter
from .definition import FORMAT, canonical_json
from .errors import FormDevError

TEMPLATE_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")
ORIGINS = ("ai", "manual", "import")
STATUSES = ("draft", "reviewed")
MAX_DEFINITION_BYTES = 2 * 1024 * 1024
MAX_TEXT = {"title": 200, "description": 2000}
PATCH_KEYS = {"title", "description", "definition", "status", "version"}


def _now() -> int:
    return int(time.time() * 1000)


class TemplateRepository:
    def __init__(self, adapter: DataAdapter, validate: Callable[[dict[str, Any]], list[dict[str, Any]]]):
        self.adapter = adapter
        self.validate = validate

    def list(self) -> list[dict[str, Any]]:
        return self.adapter.list_templates()

    def get(self, template_id: str) -> dict[str, Any]:
        row = self.adapter.get_template(template_id) if isinstance(template_id, str) and TEMPLATE_ID.match(template_id) else None
        if row is None:
            raise FormDevError("template_not_found", f"Template '{template_id}' not found", 404)
        return row

    def free_id(self, base: str) -> str:
        base = base if TEMPLATE_ID.match(base) else "template"
        candidate, number = base, 2
        while self.adapter.get_template(candidate) is not None:
            suffix = f"_{number}"
            candidate, number = base[: 64 - len(suffix)] + suffix, number + 1
        return candidate

    @staticmethod
    def _check_definition(definition: Any) -> dict[str, Any]:
        if not isinstance(definition, dict) or definition.get("format") != FORMAT:
            raise FormDevError("invalid_definition", f"A template holds a {FORMAT} form definition", 422)
        if len(canonical_json(definition).encode("utf-8")) > MAX_DEFINITION_BYTES:
            raise FormDevError("body_too_large", f"Form definitions are limited to {MAX_DEFINITION_BYTES} bytes", 413)
        return definition

    @staticmethod
    def _text(value: Any, name: str) -> str:
        if not isinstance(value, str) or len(value) > MAX_TEXT[name] or (name == "title" and not value.strip()):
            raise FormDevError("invalid_request", f"{name}: text of at most {MAX_TEXT[name]} characters" + (", required" if name == "title" else ""), 422)
        return value.strip()

    def create(self, *, definition: Any, user: str, origin: str = "manual", title: str | None = None, description: str = "",
               report: dict[str, Any] | None = None, sources: list[dict[str, Any]] | None = None, template_id: str | None = None) -> dict[str, Any]:
        definition = self._check_definition(definition)
        if origin not in ORIGINS:
            raise FormDevError("invalid_request", f"origin is one of {', '.join(ORIGINS)}", 422)
        title = self._text(title if title is not None else str(definition.get("title") or "Template"), "title")
        description = self._text(description or "", "description")
        if template_id is not None and not TEMPLATE_ID.match(template_id):
            raise FormDevError("invalid_request", "template_id: lowercase letters, digits and _ (2-64)", 422)
        now = _now()
        with self.adapter.transaction():
            chosen = self.free_id(template_id or str(definition.get("form_id") or "template"))
            row = {"template_id": chosen, "title": title, "description": description, "origin": origin, "status": "draft",
                   "definition": definition, "report": report, "sources": sources or [], "version": 1,
                   "created_at": now, "created_by": user, "updated_at": now, "updated_by": user}
            self.adapter.save_template(row)
        return row

    def update(self, template_id: str, body: Any, user: str) -> dict[str, Any]:
        """{version, title?, description?, definition?, status?}. A changed definition makes a reviewed template a draft
        again unless the same request marks it reviewed; reviewed needs a definition without validation problems."""
        if not isinstance(body, dict) or set(body) - PATCH_KEYS or not isinstance(body.get("version"), int):
            raise FormDevError("invalid_request", "Body is {version, title?, description?, definition?, status?}", 422)
        with self.adapter.transaction():
            row = dict(self.get(template_id))
            if row["version"] != body["version"]:
                raise FormDevError("version_conflict", "The template was changed by someone else; reload it", 409,
                                   {"current_version": row["version"]})
            for name in ("title", "description"):
                if name in body:
                    row[name] = self._text(body[name], name)
            if "definition" in body:
                definition = self._check_definition(body["definition"])
                if canonical_json(definition) != canonical_json(row["definition"]):
                    row["definition"] = definition
                    row["status"] = "draft"
            if "status" in body:
                if body["status"] not in STATUSES:
                    raise FormDevError("invalid_request", f"status is one of {', '.join(STATUSES)}", 422)
                if body["status"] == "reviewed":
                    issues = self.validate(row["definition"])
                    if issues:
                        raise FormDevError("template_not_valid", "Fix the form's problems before marking the template reviewed", 422, issues[:50])
                row["status"] = body["status"]
            row.update(version=row["version"] + 1, updated_at=_now(), updated_by=user)
            self.adapter.save_template(row)
        return row

    def delete(self, template_id: str) -> None:
        with self.adapter.transaction():
            self.get(template_id)
            self.adapter.delete_template(template_id)

    def form_definition(self, template_id: str, form_id: str, title: str | None) -> dict[str, Any]:
        """The template's definition as a new form (version 1 draft) with the author's form_id and title."""
        definition = dict(self.get(template_id)["definition"])
        definition.update(form_id=form_id, schema_version=1)
        definition.pop("migration", None)
        if title:
            definition["title"] = title
        return definition
