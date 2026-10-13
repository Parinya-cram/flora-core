"""Workflow Studio: shared logic for Canopy (design, delivery) and the sync API (ingest).

A workflow (`flora-workflow/1`, see docs/workflow-studio.md) says which built-in
Anesthesia record sections a case uses, which Form Studio forms it adds (pinned to a
published version) and the order of the case packet PDF.
"""
from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Any

from psycopg import Connection

LOG = logging.getLogger("flora.workflows")
FORMAT = "flora-workflow/1"
WORKFLOW_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")
FORM_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")

# Built-in FormView tabs (frontend/src/views/FormView.tsx FORM_TAB_DEFS), in FormView order.
SECTIONS: list[dict[str, Any]] = [
    {"id": "caseInfo", "label": "Case & Plan", "core": True},
    {"id": "preop", "label": "Pre-anesthesia", "core": True},
    {"id": "checklist", "label": "Safety Checklist", "core": True},
    {"id": "ga_ett", "label": "GA ETT", "core": False},
    {"id": "ga_lma", "label": "GA LMA", "core": False},
    {"id": "ga_tubeless", "label": "GA Tubeless", "core": False},
    {"id": "neuraxial", "label": "Neuraxial Block", "core": False},
    {"id": "pnb", "label": "PNB", "core": False},
    {"id": "line", "label": "Line", "core": False},
    {"id": "comorbid", "label": "Comorbid", "core": False},
    {"id": "extubation", "label": "Extubation", "core": False},
    {"id": "pacu", "label": "Recovery / PACU", "core": True},
    {"id": "pain", "label": "Pain", "core": False},
    {"id": "outcome", "label": "Outcome", "core": True},
]
SECTION_IDS = [section["id"] for section in SECTIONS]
CORE_SECTIONS = [section["id"] for section in SECTIONS if section["core"]]
PHASES = {"preop", "intraop", "postop", "any"}
REPORT_MODES = {"standard", "smart_fit", "detail"}


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- definition

def normalize(definition: dict[str, Any]) -> dict[str, Any]:
    """A clean `flora-workflow/1` definition (without `bundled_forms`); keeps unknown values
    so validation can report them."""
    record = definition.get("anesthesia_record") if isinstance(definition.get("anesthesia_record"), dict) else {}
    forms = []
    for item in definition.get("forms") or []:
        if not isinstance(item, dict):
            forms.append(item)
            continue
        entry = {"form_id": item.get("form_id"), "version": item.get("version"),
                 "title": item.get("title") or "", "phase": item.get("phase") or "any",
                 "required": bool(item.get("required"))}
        forms.append(entry)
    return {
        "format": definition.get("format") or FORMAT,
        "id": definition.get("id"),
        "name": str(definition.get("name") or ""),
        "description": str(definition.get("description") or ""),
        "anesthesia_record": {
            "enabled": bool(record.get("enabled", True)),
            "sections": list(record.get("sections") or []),
            "optional_sections": list(record.get("optional_sections") or []),
        },
        "forms": forms,
        "packet": list(definition.get("packet") or []),
        # Itemize (billing) template shown on the Leaf Billing screen; shared by any number of workflows.
        "billing": {"template_id": (str((definition.get("billing") or {}).get("template_id") or "").strip() or None)
                    if isinstance(definition.get("billing"), dict) else None},
    }


def structural_issues(definition: Any) -> list[dict[str, str]]:
    """Problems that make a definition unusable even as a draft."""
    if not isinstance(definition, dict):
        return [{"path": "$", "message": "definition must be an object"}]
    issues = []
    if definition.get("format", FORMAT) != FORMAT:
        issues.append({"path": "$.format", "message": f"format must be {FORMAT}"})
    if not isinstance(definition.get("id"), str) or not WORKFLOW_ID.match(definition["id"]):
        issues.append({"path": "$.id", "message": "id must match ^[a-z][a-z0-9_]{1,63}$"})
    for key in ("forms", "packet"):
        if key in definition and definition[key] is not None and not isinstance(definition[key], list):
            issues.append({"path": f"$.{key}", "message": f"{key} must be a list"})
    if "anesthesia_record" in definition and not isinstance(definition["anesthesia_record"], dict):
        issues.append({"path": "$.anesthesia_record", "message": "anesthesia_record must be an object"})
    return issues


def published_versions(database: Connection) -> dict[str, dict[str, Any]]:
    """{form_id: {title, published_version, versions:[n...]}} from Form Studio (published versions only)."""
    if database.execute("SELECT to_regclass('formdev_form') AS t").fetchone()["t"] is None:
        return {}
    rows = database.execute(
        """SELECT f.form_id, f.title, f.published_version,
                  coalesce(array_agg(v.schema_version ORDER BY v.schema_version)
                           FILTER (WHERE v.status = 'published'), '{}') AS versions
           FROM formdev_form f LEFT JOIN formdev_schema_version v ON v.form_id = f.form_id
           GROUP BY f.form_id, f.title, f.published_version ORDER BY f.title, f.form_id""").fetchall()
    return {row["form_id"]: {"title": row["title"], "published_version": row["published_version"],
                             "versions": [int(v) for v in row["versions"]]} for row in rows}


def validate(database: Connection, definition: Any) -> list[dict[str, str]]:
    """Every problem that blocks publishing (empty = publishable)."""
    issues = structural_issues(definition)
    if issues:
        return issues
    workflow = normalize(definition)
    if not workflow["name"].strip():
        issues.append({"path": "$.name", "message": "name is required"})
    record = workflow["anesthesia_record"]
    for key in ("sections", "optional_sections"):
        for index, section in enumerate(record[key]):
            if section not in SECTION_IDS:
                issues.append({"path": f"$.anesthesia_record.{key}[{index}]", "message": f"unknown section '{section}'"})
    if record["enabled"] and not record["sections"]:
        issues.append({"path": "$.anesthesia_record.sections", "message": "an enabled anesthesia record needs sections"})
    known = published_versions(database)
    listed: set[str] = set()
    for index, item in enumerate(workflow["forms"]):
        path = f"$.forms[{index}]"
        if not isinstance(item, dict):
            issues.append({"path": path, "message": "form entry must be an object"})
            continue
        form_id, version = item.get("form_id"), item.get("version")
        if not isinstance(form_id, str) or not FORM_ID.match(form_id):
            issues.append({"path": f"{path}.form_id", "message": "form_id is not valid"})
            continue
        if form_id in listed:
            issues.append({"path": f"{path}.form_id", "message": f"form '{form_id}' is listed twice"})
        listed.add(form_id)
        if item.get("phase") not in PHASES:
            issues.append({"path": f"{path}.phase", "message": "phase must be preop, intraop, postop or any"})
        if form_id not in known:
            issues.append({"path": f"{path}.form_id", "message": f"form '{form_id}' does not exist in Form Studio"})
        elif not isinstance(version, int) or isinstance(version, bool) or version not in known[form_id]["versions"]:
            issues.append({"path": f"{path}.version", "message": f"form '{form_id}' has no published version {version}"})
    reports = 0
    for index, entry in enumerate(workflow["packet"]):
        path = f"$.packet[{index}]"
        kind = entry.get("kind") if isinstance(entry, dict) else None
        if kind == "anesthesia_report":
            reports += 1
            if entry.get("mode", "standard") not in REPORT_MODES:
                issues.append({"path": f"{path}.mode", "message": "mode must be standard, smart_fit or detail"})
            if not record["enabled"]:
                issues.append({"path": path, "message": "the anesthesia report needs the anesthesia record enabled"})
        elif kind == "form":
            if entry.get("form_id") not in listed:
                issues.append({"path": f"{path}.form_id", "message": f"form '{entry.get('form_id')}' is not in forms"})
        else:
            issues.append({"path": f"{path}.kind", "message": "kind must be anesthesia_report or form"})
    if reports > 1:
        issues.append({"path": "$.packet", "message": "at most one anesthesia_report"})
    template_id = workflow["billing"]["template_id"]
    if template_id:
        from . import billing_templates
        if template_id not in billing_templates.published(database, [template_id]):
            issues.append({"path": "$.billing.template_id",
                           "message": f"itemize template '{template_id}' is not published"})
    return issues


def form_definition(database: Connection, form_id: str, version: int) -> dict[str, Any] | None:
    if database.execute("SELECT to_regclass('formdev_schema_version') AS t").fetchone()["t"] is None:
        return None
    row = database.execute(
        "SELECT definition FROM formdev_schema_version WHERE form_id=%s AND schema_version=%s AND status='published'",
        (form_id, version)).fetchone()
    return row["definition"] if row else None


# ---------------------------------------------------------------- delivery to Leafs (sync API)

def leaf_delivery(database: Connection, unit_key: str | None) -> dict[str, Any] | None:
    """`workflows` of the ward exchange: published workflows of the ward and their pinned forms.
    None when it cannot be read (the Leaf then keeps its cached set)."""
    try:
        return _leaf_delivery(database, unit_key)
    except Exception as error:  # never break the ward exchange
        LOG.warning("workflow delivery for unit %s failed: %s: %s", unit_key, type(error).__name__, error)
        return None


def _leaf_delivery(database: Connection, unit_key: str | None) -> dict[str, Any]:
    if not unit_key or database.execute("SELECT to_regclass('canopy_workflow') AS t").fetchone()["t"] is None:
        return {"version": 0, "items": [], "forms": {}}
    rows = database.execute(
        """SELECT w.published_definition AS definition, w.updated_at, u.is_default, u.sort_order
           FROM canopy_workflow_unit u JOIN canopy_workflow w ON w.id = u.workflow_id
           WHERE u.unit_key = %s AND w.status <> 'archived' AND w.published_definition IS NOT NULL
           ORDER BY u.sort_order, w.name, w.id""", (unit_key,)).fetchall()
    forms: dict[str, Any] = {}
    for row in rows:
        for item in row["definition"].get("forms") or []:
            key = f"{item.get('form_id')}@{item.get('version')}"
            if key not in forms:
                definition = form_definition(database, item.get("form_id"), int(item.get("version") or 0))
                if definition is not None:
                    forms[key] = definition
    from . import billing_templates
    templates = billing_templates.published(
        database, sorted({tid for row in rows if (tid := billing_templates.template_id_of(row["definition"]))}))
    return {
        "version": max([int(row["updated_at"]) for row in rows] + [t["updated_at"] for t in templates.values()], default=0),
        "items": [{"definition": row["definition"], "isDefault": bool(row["is_default"]),
                   "sortOrder": int(row["sort_order"])} for row in rows],
        "forms": forms,
        "billing_templates": {tid: t["definition"] for tid, t in templates.items()},
    }


# ---------------------------------------------------------------- snapshot ingest (sync API)

def record_id_for(global_case_id: str, form_id: str) -> str:
    """`<global_case_id>-<form_id>`; Form Studio record ids allow only letters, digits and '-'
    (8-64 chars), so '_' becomes '-' and an over-long id falls back to a UUIDv5 of the same."""
    candidate = f"{global_case_id}-{form_id.replace('_', '-')}"
    if len(candidate) <= 64:
        return candidate
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"flora:workflow-form:{global_case_id}:{form_id}"))


def ingest_workflow_forms(connection: Connection, items: list[dict[str, Any]], leaf_id: str) -> int:
    """Upsert the bedside workflow forms of stored case snapshots into Form Studio records.

    items: [{global_case_id, hn, workflow_forms}]. Best effort: a form that Form Studio rejects
    (unknown version, invalid data) is logged and skipped; nothing here fails the ingest."""
    if not items or connection.execute("SELECT to_regclass('formdev_record') AS t").fetchone()["t"] is None:
        return 0
    from .formdev import services_for
    from .formdev.adapters.postgres import PostgreSQLAdapter
    from .formdev.errors import FormDevError

    services = services_for(PostgreSQLAdapter(connection))
    user = f"leaf:{leaf_id}"[:120]
    written = 0
    for item in items:
        for form_id, form in (item.get("workflow_forms") or {}).items():
            try:
                if not isinstance(form, dict) or not FORM_ID.match(str(form_id)):
                    continue
                record_id = record_id_for(str(item["global_case_id"]), form_id)
                data = form.get("data") if isinstance(form.get("data"), dict) else {}
                status = "submitted" if form.get("status") == "completed" else "draft"
                updated_at = int(form.get("updatedAt") or now_ms())
                current = services.records.get_raw(record_id)
                if current is not None and current["status"] == "deleted":
                    continue
                if current is not None and current["status"] == "submitted":
                    status = "submitted"  # Form Studio does not reopen submitted records
                if current is not None and (int(current["updated_at"] or 0) > updated_at
                                            or (current["data"] == data and current["status"] == status)):
                    pass  # Form Studio already has this (or a newer) copy
                else:
                    # A form completed at the bedside that Form Studio would not accept as submitted
                    # (e.g. a required field left empty) is kept as a draft rather than dropped.
                    reopenable = current is None or current["status"] == "draft"
                    attempts = [status, "draft"] if status == "submitted" and reopenable else [status]
                    for index, attempt in enumerate(attempts):
                        try:
                            if current is None:
                                services.records.create(form_id, data, user, status=attempt, record_id=record_id,
                                                        schema_version=int(form.get("form_version") or 0) or None,
                                                        updated_at=updated_at)
                            else:
                                services.records.update(record_id, data, int(current["version"]), user,
                                                        status=attempt, updated_at=updated_at)
                            break
                        except FormDevError as error:
                            if error.code != "invalid_record" or index == len(attempts) - 1:
                                raise
                if item.get("hn"):
                    connection.execute("UPDATE formdev_record SET subject_id=%s WHERE record_id=%s AND subject_id IS DISTINCT FROM %s",
                                       (item["hn"], record_id, item["hn"]))
                written += 1
            except Exception as error:  # never fail the ingest
                LOG.warning("workflow form %s of case %s not stored in Form Studio: %s: %s",
                            form_id, item.get("global_case_id"), type(error).__name__, getattr(error, "message", error))
    return written
