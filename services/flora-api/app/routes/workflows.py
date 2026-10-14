"""Workflow Studio, Canopy side (/api/fleet/workflows). See docs/workflow-studio.md.

Reads need a Canopy session; writes need studio.manage (routes/studio_access.py). Published workflows
reach the ward's Leafs through the ward exchange (routes/sync_ward.py).
"""
from __future__ import annotations

import copy
import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import directory, workflows
from ..database import connection
from .auth_canopy import read_token
from .studio_access import require_studio_author

router = APIRouter(prefix="/api/fleet/workflows", tags=["workflow studio"])
LOG = logging.getLogger("flora.workflows")


class DefinitionInput(BaseModel):
    definition: dict[str, Any]


class WardInput(BaseModel):
    unit_key: str = Field(min_length=1, max_length=40)
    is_default: bool = False
    sort_order: int = 0


class WardsInput(BaseModel):
    wards: list[WardInput] = Field(default_factory=list, max_length=500)


class ImportInput(BaseModel):
    file: dict[str, Any]


def actor(user: dict[str, Any]) -> str:
    return str(user.get("username") or user.get("sub") or "unknown")


def invalid(issues: list[dict[str, str]], message: str = "workflow is not valid", status: int = 422) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message, "issues": issues})


def ward_names(database: Connection) -> dict[str, str]:
    return {row["key"]: row["name"] for row in directory.ward_options(database)["rows"]}


def public(row: dict[str, Any], wards: list[dict[str, Any]], names: dict[str, str]) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "description": row["description"], "status": row["status"],
        "version": int(row["version"]), "updatedAt": row["updated_at"], "updatedBy": row["updated_by"],
        "publishedAt": row.get("published_at"), "definition": row["definition"],
        "wards": [{"unitKey": ward["unit_key"], "unitName": names.get(ward["unit_key"]),
                   "isDefault": bool(ward["is_default"]), "sortOrder": int(ward["sort_order"])} for ward in wards],
    }


def load_rows(database: Connection, workflow_id: str | None = None) -> list[dict[str, Any]]:
    rows = database.execute(
        "SELECT * FROM canopy_workflow" + (" WHERE id=%s" if workflow_id else "") + " ORDER BY status='archived', name, id",
        (workflow_id,) if workflow_id else ()).fetchall()
    units = database.execute(
        "SELECT * FROM canopy_workflow_unit" + (" WHERE workflow_id=%s" if workflow_id else "") + " ORDER BY sort_order, unit_key",
        (workflow_id,) if workflow_id else ()).fetchall()
    names = ward_names(database)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for unit in units:
        grouped.setdefault(unit["workflow_id"], []).append(unit)
    return [public(row, grouped.get(row["id"], []), names) for row in rows]


def one(database: Connection, workflow_id: str) -> dict[str, Any]:
    rows = load_rows(database, workflow_id)
    if not rows:
        raise HTTPException(404, "workflow not found")
    return rows[0]


def clean_definition(definition: dict[str, Any], workflow_id: str | None = None) -> dict[str, Any]:
    result = workflows.normalize(definition)
    if workflow_id is not None:
        result["id"] = workflow_id
    return result


# ---------------------------------------------------------------- reads

@router.get("")
def list_workflows(_: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    return {"rows": load_rows(database)}


@router.get("/options")
def options(_: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    forms = workflows.published_versions(database)
    return {
        "sections": workflows.SECTIONS,
        "forms": [{"form_id": form_id, "title": form["title"], "published_version": form["published_version"],
                   "versions": form["versions"], "placement": form["placement"]} for form_id, form in forms.items()],
        "wards": [{"key": ward["key"], "name": ward["name"], "buildingName": ward.get("buildingName"),
                   "isDemo": bool(ward.get("isDemo"))} for ward in directory.ward_options(database)["rows"]],
    }


@router.post("/validate")
def validate(payload: DefinitionInput, _: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Publish-time validation without publishing (the editor's Validate button)."""
    return {"issues": workflows.validate(database, payload.definition)}


@router.get("/{workflow_id}")
def get_workflow(workflow_id: str, _: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    return one(database, workflow_id)


# ---------------------------------------------------------------- writes

def insert(database: Connection, definition: dict[str, Any], user: str) -> None:
    current = workflows.now_ms()
    database.execute(
        """INSERT INTO canopy_workflow (id, name, description, definition, version, status, created_at, created_by,
                                        updated_at, updated_by)
           VALUES (%s,%s,%s,%s,0,'draft',%s,%s,%s,%s)""",
        (definition["id"], definition["name"], definition["description"], Jsonb(definition), current, user, current, user))


def update_definition(database: Connection, definition: dict[str, Any], user: str) -> None:
    database.execute(
        """UPDATE canopy_workflow SET name=%s, description=%s, definition=%s,
             status=CASE WHEN status='published' AND definition IS DISTINCT FROM %s THEN 'draft' ELSE status END,
             updated_at=%s, updated_by=%s WHERE id=%s""",
        (definition["name"], definition["description"], Jsonb(definition), Jsonb(definition),
         workflows.now_ms(), user, definition["id"]))


@router.post("")
def create_workflow(payload: DefinitionInput, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    issues = workflows.structural_issues(payload.definition)
    if issues:
        return invalid(issues)
    definition = clean_definition(payload.definition)
    with database.transaction():
        if database.execute("SELECT 1 FROM canopy_workflow WHERE id=%s", (definition["id"],)).fetchone():
            raise HTTPException(409, f"workflow '{definition['id']}' already exists")
        insert(database, definition, actor(user))
    return one(database, definition["id"])


@router.put("/{workflow_id}")
def save_workflow(workflow_id: str, payload: DefinitionInput, user: dict = Depends(require_studio_author),
                  database: Connection = Depends(connection)):
    if payload.definition.get("id") not in (None, workflow_id):
        return invalid([{"path": "$.id", "message": "id cannot be changed"}])
    definition = clean_definition(payload.definition, workflow_id)
    issues = workflows.structural_issues(definition)
    if issues:
        return invalid(issues)
    with database.transaction():
        row = database.execute("SELECT status FROM canopy_workflow WHERE id=%s FOR UPDATE", (workflow_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "workflow not found")
        if row["status"] == "archived":
            raise HTTPException(409, "archived workflows cannot be changed")
        update_definition(database, definition, actor(user))
    return one(database, workflow_id)


@router.post("/{workflow_id}/publish")
def publish(workflow_id: str, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    with database.transaction():
        row = database.execute("SELECT * FROM canopy_workflow WHERE id=%s FOR UPDATE", (workflow_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "workflow not found")
        issues = workflows.validate(database, row["definition"])
        if issues:
            return invalid(issues)
        current = workflows.now_ms()
        database.execute(
            """UPDATE canopy_workflow SET status='published', version=version+1, published_definition=definition,
                 published_at=%s, updated_at=%s, updated_by=%s WHERE id=%s""",
            (current, current, actor(user), workflow_id))
    LOG.info("workflow %s published by %s", workflow_id, actor(user))
    return one(database, workflow_id)


@router.post("/{workflow_id}/archive")
def archive(workflow_id: str, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    with database.transaction():
        row = database.execute(
            "UPDATE canopy_workflow SET status='archived', updated_at=%s, updated_by=%s WHERE id=%s RETURNING id",
            (workflows.now_ms(), actor(user), workflow_id)).fetchone()
        if row is None:
            raise HTTPException(404, "workflow not found")
        database.execute("DELETE FROM canopy_workflow_unit WHERE workflow_id=%s", (workflow_id,))
    return one(database, workflow_id)


@router.put("/{workflow_id}/wards")
def set_wards(workflow_id: str, payload: WardsInput, user: dict = Depends(require_studio_author),
              database: Connection = Depends(connection)):
    names = ward_names(database)
    unknown = sorted({ward.unit_key for ward in payload.wards} - set(names))
    if unknown:
        raise HTTPException(400, f"unknown wards: {', '.join(unknown)}")
    keys = [ward.unit_key for ward in payload.wards]
    if len(keys) != len(set(keys)):
        raise HTTPException(400, "a ward is listed twice")
    with database.transaction():
        row = database.execute("SELECT status FROM canopy_workflow WHERE id=%s FOR UPDATE", (workflow_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "workflow not found")
        if row["status"] == "archived" and payload.wards:
            raise HTTPException(409, "archived workflows cannot be assigned to wards")
        database.execute("DELETE FROM canopy_workflow_unit WHERE workflow_id=%s", (workflow_id,))
        for ward in payload.wards:
            if ward.is_default:
                # One default per ward: this workflow takes it over.
                database.execute("UPDATE canopy_workflow_unit SET is_default=false WHERE unit_key=%s AND is_default",
                                 (ward.unit_key,))
            database.execute(
                "INSERT INTO canopy_workflow_unit (workflow_id, unit_key, sort_order, is_default) VALUES (%s,%s,%s,%s)",
                (workflow_id, ward.unit_key, ward.sort_order, ward.is_default))
        # Leafs of affected wards see a new set version.
        database.execute("UPDATE canopy_workflow SET updated_at=%s, updated_by=%s WHERE id=%s",
                         (workflows.now_ms(), actor(user), workflow_id))
    return one(database, workflow_id)


# ---------------------------------------------------------------- files

@router.get("/{workflow_id}/export")
def export(workflow_id: str, _: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    row = database.execute("SELECT definition FROM canopy_workflow WHERE id=%s", (workflow_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "workflow not found")
    result = workflows.normalize(row["definition"])
    bundled = {}
    for item in result["forms"]:
        if not isinstance(item, dict) or not isinstance(item.get("version"), int):
            continue
        definition = workflows.form_definition(database, item["form_id"], item["version"])
        if definition is not None:
            bundled[item["form_id"]] = {"version": item["version"], "definition": definition}
    result["bundled_forms"] = bundled
    return result


def import_form(fd: Any, form_id: str, bundle: dict[str, Any], user: str) -> tuple[int | None, str]:
    """Create a missing form from its bundled definition as a draft (version 1)."""
    definition = copy.deepcopy(bundle.get("definition"))
    if not isinstance(definition, dict):
        raise ValueError("bundled definition is missing")
    definition["form_id"] = form_id
    definition["schema_version"] = 1
    definition.pop("migration", None)
    fd.schemas.create_form(definition, user)
    return 1, "created"


@router.post("/import")
def import_workflow(payload: ImportInput, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    file = payload.file
    issues = workflows.structural_issues(file)
    if issues:
        return invalid(issues, "not a flora-workflow/1 file")
    definition = clean_definition(file)
    bundled = file.get("bundled_forms") if isinstance(file.get("bundled_forms"), dict) else {}
    known = workflows.published_versions(database)
    existing_forms = set(known)  # every Form Studio form, published or not
    created: list[dict[str, Any]] = []
    warnings: list[str] = []
    from .formdev_runtime import storage  # Form Studio service layer, same connection

    for item in definition["forms"]:
        if not isinstance(item, dict):
            continue
        form_id, version = item.get("form_id"), item.get("version")
        if not isinstance(form_id, str) or not workflows.FORM_ID.match(form_id):
            warnings.append(f"form entry {form_id!r} is not valid")
            continue
        if form_id in existing_forms:
            if form_id in known and version in known[form_id]["versions"]:
                continue
            warnings.append(f"form '{form_id}' exists but has no published version {version}; "
                            "pick a published version before publishing")
            continue
        bundle = bundled.get(form_id)
        if not isinstance(bundle, dict):
            warnings.append(f"form '{form_id}' does not exist here and the file does not bundle it")
            continue
        try:
            with storage(database) as fd:
                new_version, _ = import_form(fd, form_id, bundle, actor(user))
        except Exception as error:
            message = getattr(error, "message", None) or str(error)
            warnings.append(f"form '{form_id}' could not be created: {message}")
            continue
        existing_forms.add(form_id)
        item["version"] = new_version
        created.append({"form_id": form_id, "version": new_version, "status": "draft",
                        "sourceVersion": bundle.get("version")})
        warnings.append(f"form '{form_id}' was created as a draft (version 1); publish it in Form Studio "
                        "before publishing this workflow")
    with database.transaction():
        row = database.execute("SELECT status, definition FROM canopy_workflow WHERE id=%s FOR UPDATE", (definition["id"],)).fetchone()
        if row is None:
            insert(database, definition, actor(user))
        elif row["definition"] == definition and row["status"] != "archived":
            warnings.append(f"workflow '{definition['id']}' already exists with the same definition; nothing changed")
        else:
            if row["status"] == "archived":
                database.execute("UPDATE canopy_workflow SET status='draft' WHERE id=%s", (definition["id"],))
            update_definition(database, definition, actor(user))
            warnings.append(f"workflow '{definition['id']}' already existed; its definition was replaced (now a draft "
                            "until published again)")
    return {"row": one(database, definition["id"]), "createdForms": created, "warnings": warnings}
