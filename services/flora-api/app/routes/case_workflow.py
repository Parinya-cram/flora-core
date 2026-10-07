"""Workflow Studio, Leaf side: the ward's workflows (cached from Canopy, offline) and the
workflow forms filled per case. See docs/workflow-studio.md.
"""
from __future__ import annotations

import copy
import json
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from .. import form_sync
from ..clinical import case_audit
from ..database import connection
from .auth_leaf import now_ms, require_permission, service_only

router = APIRouter(prefix="/api/case", tags=["case workflow"])


# ---------------------------------------------------------------- cache

def workflow_state(database: Connection) -> dict[str, Any]:
    row = database.execute("SELECT version, payload, synced_at FROM leaf_workflow_state WHERE id=1").fetchone()
    return {"version": (row or {}).get("version") or 0, "payload": (row or {}).get("payload") or {},
            "synced_at": (row or {}).get("synced_at")}


def cached_items(database: Connection) -> tuple[list[dict[str, Any]], dict[str, Any], int | None]:
    state = workflow_state(database)
    payload = state["payload"]
    items = sorted((item for item in payload.get("items") or [] if isinstance(item.get("definition"), dict)),
                   key=lambda item: (int(item.get("sortOrder") or 0), str(item["definition"].get("name") or "")))
    return items, payload.get("forms") or {}, state["synced_at"]


def find_workflow(database: Connection, workflow_id: str) -> dict[str, Any] | None:
    """The cached workflow with its pinned form definitions bundled (the case's snapshot)."""
    items, forms, _ = cached_items(database)
    for item in items:
        definition = item["definition"]
        if definition.get("id") == workflow_id:
            snapshot = copy.deepcopy(definition)
            snapshot["bundled_forms"] = {
                entry["form_id"]: {"version": entry["version"], "definition": forms[f"{entry['form_id']}@{entry['version']}"]}
                for entry in definition.get("forms") or []
                if isinstance(entry, dict) and f"{entry.get('form_id')}@{entry.get('version')}" in forms
            }
            return snapshot
    return None


@router.put("/workflows/state")
def put_workflow_state(payload: dict[str, Any] = Body(...), _: dict = Depends(service_only),
                       database: Connection = Depends(connection)) -> dict[str, Any]:
    """Called by the sync worker with the `workflows` of the ward exchange; unchanged sets are skipped."""
    version = int(payload.get("version") or 0)
    stored = database.execute(
        """INSERT INTO leaf_workflow_state (id, version, payload, synced_at) VALUES (1, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET version=excluded.version, payload=excluded.payload, synced_at=excluded.synced_at
           WHERE leaf_workflow_state.version IS DISTINCT FROM excluded.version
              OR leaf_workflow_state.payload IS DISTINCT FROM excluded.payload
           RETURNING 1""",
        (version, Jsonb(payload), now_ms())).fetchone()
    if not stored:
        database.execute("UPDATE leaf_workflow_state SET synced_at=%s WHERE id=1", (now_ms(),))
    return {"ok": True, "changed": bool(stored), "version": version, "items": len(payload.get("items") or [])}


@router.get("/workflows")
def list_workflows(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict[str, Any]:
    items, _forms, synced_at = cached_items(database)
    rows = []
    for item in items:
        definition = item["definition"]
        record = definition.get("anesthesia_record") or {}
        rows.append({
            "id": definition.get("id"), "name": definition.get("name"), "description": definition.get("description"),
            "isDefault": bool(item.get("isDefault")),
            "sections": list(record.get("sections") or []) if record.get("enabled", True) else [],
            "forms": definition.get("forms") or [],
            # Extras for the case view and the packet.
            "anesthesiaRecord": record, "packet": definition.get("packet") or [], "definition": definition,
        })
    return {"rows": rows, "syncedAt": synced_at}


# ---------------------------------------------------------------- case start (called by cases_lifecycle)

def resolve(database: Connection, workflow_id: str | None, explicit: bool) -> dict[str, Any] | None:
    """The workflow snapshot for a new case. An unknown explicit id is a 409; an unknown
    admission preset is ignored (the case starts without a workflow)."""
    if not workflow_id:
        return None
    workflow = find_workflow(database, workflow_id)
    if workflow is None and explicit:
        raise HTTPException(409, f"workflow '{workflow_id}' is not available on this Leaf")
    return workflow


def apply_on_start(database: Connection, case_id: int, workflow: dict[str, Any] | None, current: int) -> None:
    """Store the snapshot on the case and switch on its built-in record sections."""
    if workflow is None:
        return
    database.execute("UPDATE cases SET workflow=%s WHERE id=%s", (Jsonb(workflow), case_id))
    record = workflow.get("anesthesia_record") or {}
    sections = list(record.get("sections") or []) if record.get("enabled", True) else []
    if not sections:
        return
    row = database.execute("SELECT form_draft_json, field_versions FROM case_detail WHERE case_id=%s FOR UPDATE",
                           (case_id,)).fetchone()
    draft = form_sync.parse(row["form_draft_json"]) if row else {}
    previous = draft.get("enabledForms") if isinstance(draft.get("enabledForms"), list) else []
    # Sections already chosen (e.g. on a Canopy tablet before the start) stay on.
    enabled = sections + [section for section in previous if section not in sections]
    updated = {**draft, "enabledForms": enabled}
    versions = form_sync.stamp_changes(draft, updated, (row or {}).get("field_versions") or {}, current, {"enabledForms"})
    database.execute(
        """INSERT INTO case_detail(case_id,created_at,updated_at,form_draft_json,field_versions) VALUES (%s,%s,%s,%s,%s)
           ON CONFLICT(case_id) DO UPDATE SET updated_at=excluded.updated_at,form_draft_json=excluded.form_draft_json,
             field_versions=excluded.field_versions""",
        (case_id, current, current, json.dumps(updated), Jsonb(versions)))


# ---------------------------------------------------------------- case forms

def case_row(database: Connection, case_id: int, lock: bool = False) -> dict[str, Any]:
    row = database.execute("SELECT id, status, workflow FROM cases WHERE id=%s" + (" FOR UPDATE" if lock else ""),
                           (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    return row


def form_entry(workflow: dict[str, Any] | None, form_id: str) -> dict[str, Any]:
    for entry in (workflow or {}).get("forms") or []:
        if isinstance(entry, dict) and entry.get("form_id") == form_id:
            return entry
    raise HTTPException(404, f"form '{form_id}' is not part of this case's workflow")


def definition_for(database: Connection, workflow: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any] | None:
    _, forms, _ = cached_items(database)
    cached = forms.get(f"{entry['form_id']}@{entry['version']}")
    if cached is not None:
        return cached
    bundled = ((workflow.get("bundled_forms") or {}).get(entry["form_id"]) or {})
    return bundled.get("definition") if bundled.get("version") == entry["version"] else None


def public_record(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {"data": row["data"] or {}, "status": row["status"], "updatedAt": row["updated_at"],
            "formVersion": row["form_version"], "updatedBy": row.get("updated_by")}


def records(database: Connection, case_id: int) -> dict[str, dict[str, Any]]:
    rows = database.execute("SELECT * FROM case_form_record WHERE case_id=%s", (case_id,)).fetchall()
    return {row["form_id"]: row for row in rows}


def strip_bundle(workflow: dict[str, Any] | None) -> dict[str, Any] | None:
    if workflow is None:
        return None
    return {key: value for key, value in workflow.items() if key != "bundled_forms"}


@router.get("/{case_id}/workflow")
def case_workflow(case_id: int, _: dict = Depends(require_permission("case.read")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    case = case_row(database, case_id)
    workflow = case["workflow"]
    if workflow is None:
        return {"workflow": None, "forms": {}}
    saved = records(database, case_id)
    forms = {}
    for entry in workflow.get("forms") or []:
        if isinstance(entry, dict) and entry.get("form_id"):
            forms[entry["form_id"]] = {"definition": definition_for(database, workflow, entry),
                                       "record": public_record(saved.get(entry["form_id"]))}
    return {"workflow": strip_bundle(workflow), "forms": forms}


@router.get("/{case_id}/workflow-snapshot")
def workflow_snapshot(case_id: int, _: dict = Depends(require_permission("case.read")),
                      database: Connection = Depends(connection)) -> dict[str, Any] | None:
    """The case's workflow without bundled form definitions (sync worker snapshot `workflow`)."""
    return strip_bundle(case_row(database, case_id)["workflow"])


@router.get("/{case_id}/workflow-forms")
def workflow_forms(case_id: int, _: dict = Depends(require_permission("case.read")),
                   database: Connection = Depends(connection)) -> dict[str, Any]:
    """{form_id: {form_version, data, status, updatedAt}} (sync worker snapshot `workflow_forms`)."""
    case_row(database, case_id)
    return {form_id: {"form_version": row["form_version"], "data": row["data"] or {}, "status": row["status"],
                      "updatedAt": row["updated_at"]} for form_id, row in records(database, case_id).items()}


@router.get("/{case_id}/workflow-forms/{form_id}")
def workflow_form(case_id: int, form_id: str, _: dict = Depends(require_permission("case.read")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    case = case_row(database, case_id)
    entry = form_entry(case["workflow"], form_id)
    row = records(database, case_id).get(form_id)
    return {"definition": definition_for(database, case["workflow"], entry), "record": public_record(row)}


class FormPatch(BaseModel):
    patch: dict[str, Any]
    status: Literal["draft", "completed"] | None = None


@router.patch("/{case_id}/workflow-forms/{form_id}")
def patch_workflow_form(case_id: int, form_id: str, payload: FormPatch, actor: dict = Depends(require_permission("case.chart")),
                        database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        case = case_row(database, case_id, lock=True)
        if case["status"] == "archived":
            raise HTTPException(409, "archived case is read-only")
        entry = form_entry(case["workflow"], form_id)
        row = database.execute("SELECT * FROM case_form_record WHERE case_id=%s AND form_id=%s FOR UPDATE",
                               (case_id, form_id)).fetchone()
        old = dict((row or {}).get("data") or {})
        merged = {**old, **payload.patch}
        current = now_ms()
        versions = form_sync.stamp_changes(old, merged, (row or {}).get("field_versions") or {}, current, set(payload.patch))
        status = payload.status or (row or {}).get("status") or "draft"
        saved = database.execute(
            """INSERT INTO case_form_record (case_id, form_id, form_version, data, field_versions, status, updated_at, updated_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (case_id, form_id) DO UPDATE SET data=excluded.data, field_versions=excluded.field_versions,
                 status=excluded.status, updated_at=excluded.updated_at, updated_by=excluded.updated_by
               RETURNING *""",
            (case_id, form_id, int((row or {}).get("form_version") or entry["version"]), Jsonb(merged), Jsonb(versions),
             status, current, actor["username"])).fetchone()
        case_audit(database, case_id, f"workflow_form.patch:{form_id}", {"data": old, "status": (row or {}).get("status")},
                   {"data": merged, "status": status}, actor)
    return {"ok": True, "case_id": case_id, "form_id": form_id, "record": public_record(saved)}
