"""Form Studio fields linked to Flora Leaf's anesthesia record, both ways (field.bind "record.<field>").

The record is the Leaf's own case form (case_detail.form_draft_json: Case & Plan, Pre-anesthesia, Checklist, GA,
blocks, lines, PACU, pain, outcome; the 355 fields of record_fields.json, read from FormView.tsx by
formdev/scripts/build_leaf_record_fields.mjs). A workflow form field bound to one of them shares its value:

- a value changed in the form goes into the record (the Leaf tab shows it on its next refresh);
- a value changed in the record (on the Leaf, or by Canopy) goes into every open form of the case that is bound to it;
- when both changed, the newest change wins: both sides keep a version (epoch ms) per field, and form_sync.merge takes
  the newer one, as it already does between the Leaf and Canopy.

Everything runs on the Leaf, inside the transaction of the change that triggered it, so both copies then travel to
Canopy by the usual sync. A completed form is part of the record and changes only as an amendment with a reason: the
record never writes into it (it is reported as `kept`), and its own amendments still update the record. Signatures,
files and tables are never linked. Values that do not fit the other side (an option that does not exist, text in a
number field) are skipped, never guessed.
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from . import form_sync

CATALOG = json.loads((Path(__file__).parent / "record_fields.json").read_text(encoding="utf-8"))["fields"]
BY_BIND: dict[str, dict[str, Any]] = {field["bind"]: field for field in CATALOG}
BY_KEY: dict[str, dict[str, Any]] = {field["key"]: field for field in CATALOG}
PREFIX = "record."
LINKABLE = {"text", "textarea", "number", "integer", "decimal", "date", "time", "datetime", "select", "radio", "multiselect", "checkbox", "switch"}
ACTOR = "record-link"


def _fold(value: Any) -> str:
    return re.sub(r"[^a-z0-9ก-๙+-]", "", str(value).lower())


def bound_fields(definition: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """Form data key → {field, record}: the form's top-level fields bound to a record field."""
    from .formdev.definition import field_key, fields

    out: dict[str, dict[str, Any]] = {}
    for field in fields(definition or {}):
        record = BY_BIND.get(str(field.get("bind") or ""))
        key = field_key(field)
        if record and isinstance(key, str) and field.get("type") in LINKABLE:
            out[key] = {"field": field, "record": record}
    return out


# ---------------------------------------------------------------- values across

def _iso(raw: Any) -> str | None:
    text = str(raw or "").strip()
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return f"{match[1]}-{match[2]}-{match[3]}"
    match = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", text)
    if not match:
        return None
    year = int(match[3]) - 543 if int(match[3]) > 2400 else int(match[3])
    try:
        return date(year, int(match[2]), int(match[1])).isoformat()
    except ValueError:
        return None


def _option(options: list[dict[str, Any]] | None, value: Any) -> dict[str, Any] | None:
    wanted = _fold(value)
    return next((option for option in options or [] if wanted and wanted in (_fold(option.get("value")), _fold(option.get("label")))), None)


def to_form(value: Any, field: dict[str, Any], record: dict[str, Any]) -> tuple[bool, Any]:
    """The record value as the form field stores it: (fits, value). An empty value clears the field."""
    kind = field.get("type")
    if value is None or value == "" or value == []:
        return True, None
    if kind in ("checkbox", "switch"):
        return (True, value) if isinstance(value, bool) else (True, _fold(value) in ("true", "yes", "1", "ใช่")) if isinstance(value, str) else (False, None)
    if kind in ("number", "decimal", "integer"):
        try:
            number = float(str(value).replace(",", "."))
        except ValueError:
            return False, None
        return True, (round(number) if kind == "integer" else number)
    if kind == "date":
        iso = _iso(value)
        return (iso is not None), iso
    if kind == "time":
        match = re.match(r"^(\d{1,2})[:.](\d{2})", str(value).strip())
        return (True, f"{int(match[1]):02d}:{match[2]}") if match else (False, None)
    if kind in ("select", "radio"):
        option = _option(field.get("options"), value[0] if isinstance(value, list) and len(value) == 1 else value)
        return (True, option["value"]) if option else (False, None)
    if kind == "multiselect":
        values = value if isinstance(value, list) else [part.strip() for part in str(value).split(",") if part.strip()]
        chosen = [_option(field.get("options"), item) for item in values]
        return (True, [option["value"] for option in chosen]) if all(chosen) else (False, None)
    if isinstance(value, list):
        return True, ", ".join(str(item) for item in value)
    if isinstance(value, bool):
        return True, "Yes" if value else "No"
    return True, str(value)


def to_record(value: Any, field: dict[str, Any], record: dict[str, Any]) -> tuple[bool, Any]:
    """The form value as the Leaf record stores it (its own option labels, DD/MM/YYYY dates, text numbers)."""
    kind = record.get("kind")
    if value is None or value == "" or value == []:
        return True, ([] if kind == "multi" else False if kind == "boolean" else "")
    if kind == "boolean":
        return (True, value) if isinstance(value, bool) else (False, None)
    labels = {_fold(option.get("value")): option.get("label") for option in field.get("options") or []}

    def record_option(item: Any) -> Any:
        own = _option(record.get("options"), item) or _option(record.get("options"), labels.get(_fold(item), item))
        return own["value"] if own else None

    if kind == "multi":
        items = value if isinstance(value, list) else [value]
        mapped = [record_option(item) if record.get("options") else str(labels.get(_fold(item), item)) for item in items]
        return (True, mapped) if None not in mapped else (False, None)
    if kind == "choice" and record.get("options"):
        mapped = record_option(value[0] if isinstance(value, list) and len(value) == 1 else value)
        return (mapped is not None), mapped
    if kind == "date":
        iso = _iso(value)
        if iso is None:
            return False, None
        year, month, day = iso.split("-")
        return True, f"{day}/{month}/{year}"
    if isinstance(value, bool):
        return True, "Yes" if value else "No"
    if isinstance(value, list):
        return True, ", ".join(str(labels.get(_fold(item), item)) for item in value)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return True, str(labels.get(_fold(value), value)) if field.get("type") in ("select", "radio") else str(value)


# ---------------------------------------------------------------- form → record

def form_to_record(database: Connection, case_id: int, definition: dict[str, Any] | None, data: dict[str, Any],
                   versions: dict[str, Any], keys: set[str] | None, actor: str) -> list[str]:
    """Record fields updated from a form's bound fields (`keys`: the form keys that just changed; None = all)."""
    links = bound_fields(definition)
    patch: dict[str, Any] = {}
    stamps: dict[str, int] = {}
    for key, link in links.items():
        if keys is not None and key not in keys:
            continue
        fits, value = to_record(data.get(key), link["field"], link["record"])
        version = int(versions.get(key) or 0)
        if fits and version:
            patch[link["record"]["key"]] = value
            stamps[link["record"]["key"]] = version
    if not patch:
        return []
    row = database.execute("SELECT form_draft_json, field_versions FROM case_detail WHERE case_id=%s FOR UPDATE", (case_id,)).fetchone()
    old = form_sync.parse(row and row["form_draft_json"])
    merged, merged_versions, changed = form_sync.merge(old, (row or {}).get("field_versions") or {}, patch, stamps)
    if not changed:
        return []
    from .clinical import case_audit
    from .routes.auth_leaf import now_ms

    now = now_ms()
    database.execute(
        """INSERT INTO case_detail(case_id, created_at, updated_at, form_draft_json, field_versions) VALUES (%s,%s,%s,%s,%s)
           ON CONFLICT(case_id) DO UPDATE SET updated_at=excluded.updated_at, form_draft_json=excluded.form_draft_json,
             field_versions=excluded.field_versions""",
        (case_id, now, now, json.dumps(merged), Jsonb(merged_versions)))
    written = sorted(key for key in patch if old.get(key) != merged.get(key))
    case_audit(database, case_id, "form.draft.linked", {key: old.get(key) for key in written},
               {key: merged.get(key) for key in written}, {"username": actor, "name": "Form Studio link"})
    return written


# ---------------------------------------------------------------- record → forms

def record_to_forms(database: Connection, case_id: int, keys: set[str] | None = None) -> dict[str, list[str]]:
    """Open forms of the case updated from the record (`keys`: record keys that just changed; None = all).
    Returns {"updated": ["form_id.key", ...], "kept": [...]} (kept: a completed form the record does not change)."""
    from . import case_forms
    from .clinical import case_audit
    from .routes.auth_leaf import now_ms
    from .routes.case_workflow import cached_items, definition_for

    out: dict[str, list[str]] = {"updated": [], "kept": []}
    if keys is not None and not keys:
        return out
    case = database.execute("SELECT id, status, workflow FROM cases WHERE id=%s", (case_id,)).fetchone()
    workflow = (case or {}).get("workflow") or {}
    if not case or case["status"] == "archived" or not workflow.get("forms"):
        return out
    draft_row = database.execute("SELECT form_draft_json, field_versions FROM case_detail WHERE case_id=%s", (case_id,)).fetchone()
    draft = form_sync.parse(draft_row and draft_row["form_draft_json"])
    draft_versions = (draft_row or {}).get("field_versions") or {}
    _, cached, _ = cached_items(database)
    rows = {row["form_id"]: row for row in database.execute(
        "SELECT * FROM case_form_record WHERE case_id=%s FOR UPDATE", (case_id,)).fetchall()}
    for entry in workflow.get("forms") or []:
        if not isinstance(entry, dict) or not entry.get("form_id"):
            continue
        links = bound_fields(definition_for(database, workflow, entry, cached))
        if not links:
            continue
        form_ids = [entry["form_id"], *[key for key in rows if key.startswith(f"{entry['form_id']}~")]] if entry.get("repeatable") else [entry["form_id"]]
        for form_id in form_ids:
            row = rows.get(form_id)
            local = case_forms.leaf_copy(row) if row else case_forms.copy_of({}, {}, {}, "draft")
            remote = case_forms.copy_of({}, {}, {}, local["status"])
            for key, link in links.items():
                record_key = link["record"]["key"]
                if keys is not None and record_key not in keys:
                    continue
                version = int(draft_versions.get(record_key) or 0)
                if not version:
                    continue
                fits, value = to_form(draft.get(record_key), link["field"], link["record"])
                if not fits:
                    continue
                if value is None:
                    remote["versions"][key] = version  # cleared in the record
                else:
                    remote["data"][key] = value
                    remote["versions"][key] = version
                remote["authors"][key] = {"by": ACTOR, "at": version, "via": "record"}
            if not remote["versions"]:
                continue
            merged, changed = case_forms.merge(local, remote)
            if not changed:
                continue
            touched = sorted(key for key in remote["versions"] if merged["data"].get(key) != local["data"].get(key))
            if local["status"] == "completed":
                out["kept"].extend(f"{form_id}.{key}" for key in touched)
                continue
            now = now_ms()
            database.execute(
                """INSERT INTO case_form_record (case_id, form_id, form_version, data, field_versions, field_authors, status,
                     updated_at, updated_by, created_at, created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (case_id, form_id) DO UPDATE SET data=excluded.data, field_versions=excluded.field_versions,
                     field_authors=excluded.field_authors, updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
                (case_id, form_id, int((row or {}).get("form_version") or entry.get("version") or 1), Jsonb(merged["data"]),
                 Jsonb(merged["versions"]), Jsonb(merged["authors"]), merged["status"], now, ACTOR, now, ACTOR))
            case_audit(database, case_id, f"workflow_form.linked:{form_id}", {key: local["data"].get(key) for key in touched},
                       {key: merged["data"].get(key) for key in touched}, {"username": ACTOR, "name": "Leaf record link"})
            out["updated"].extend(f"{form_id}.{key}" for key in touched)
    return out


def changed_record_keys(old_versions: dict[str, Any] | None, new_versions: dict[str, Any] | None) -> set[str]:
    old = old_versions or {}
    return {key for key, version in (new_versions or {}).items() if old.get(key) != version and key in BY_KEY}
