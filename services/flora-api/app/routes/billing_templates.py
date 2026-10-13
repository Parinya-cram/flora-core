"""Workflow Studio: itemize (billing) templates, Canopy side (/api/fleet/workflows/billing-templates).

Reads need a Canopy session; writes need studio.manage. Registered before the workflow
routes so these paths are not taken for a workflow id. See app/billing_templates.py.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from .. import billing, billing_templates, workflows
from ..database import connection
from .auth_canopy import read_token
from .studio_access import require_studio_author

router = APIRouter(prefix="/api/fleet/workflows/billing-templates", tags=["workflow studio"])


class DefinitionInput(BaseModel):
    definition: dict[str, Any]


class DuplicateInput(BaseModel):
    id: str
    name: str = ""


def actor(user: dict[str, Any]) -> str:
    return str(user.get("username") or user.get("sub") or "unknown")


def invalid(issues: list[dict[str, str]], message: str = "template is not valid") -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": message, "issues": issues})


def used_by(database: Connection) -> dict[str, list[dict[str, str]]]:
    rows = database.execute(
        """SELECT id, name, status, coalesce(definition->'billing'->>'template_id', '') AS draft_id,
                  coalesce(published_definition->'billing'->>'template_id', '') AS published_id
           FROM canopy_workflow WHERE status <> 'archived'""").fetchall()
    result: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        for template_id in {row["draft_id"], row["published_id"]} - {""}:
            result.setdefault(template_id, []).append({"id": row["id"], "name": row["name"], "status": row["status"]})
    return result


def public(row: dict[str, Any], users: dict[str, list[dict[str, str]]]) -> dict[str, Any]:
    definition = row["definition"]
    return {"id": row["id"], "name": row["name"], "description": row["description"], "status": row["status"],
            "version": int(row["version"]), "updatedAt": row["updated_at"], "updatedBy": row["updated_by"],
            "publishedAt": row.get("published_at"), "definition": definition,
            "itemCount": sum(len(group.get("items") or []) for group in definition.get("groups") or []),
            "usedBy": users.get(row["id"], [])}


def one(database: Connection, template_id: str) -> dict[str, Any]:
    row = database.execute("SELECT * FROM canopy_billing_template WHERE id=%s", (template_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "template not found")
    return public(row, used_by(database))


@router.get("")
def list_templates(_: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    users = used_by(database)
    rows = database.execute("SELECT * FROM canopy_billing_template ORDER BY status='archived', name, id").fetchall()
    return {"rows": [public(row, users) for row in rows]}


@router.get("/options")
def options(_: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    """The billing master to pick items from, plus its groups as starting points."""
    return billing.load_catalog(database, active_only=True)


@router.post("/validate")
def validate(payload: DefinitionInput, _: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    return {"issues": billing_templates.validate(database, payload.definition)}


@router.post("")
def create(payload: DefinitionInput, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    issues = billing_templates.structural_issues(payload.definition)
    if issues:
        return invalid(issues)
    definition = billing_templates.normalize(payload.definition)
    now = workflows.now_ms()
    with database.transaction():
        if database.execute("SELECT 1 FROM canopy_billing_template WHERE id=%s", (definition["id"],)).fetchone():
            raise HTTPException(409, f"template '{definition['id']}' already exists")
        database.execute(
            """INSERT INTO canopy_billing_template (id,name,description,definition,status,created_at,created_by,updated_at,updated_by)
               VALUES (%s,%s,%s,%s,'draft',%s,%s,%s,%s)""",
            (definition["id"], definition["name"], definition["description"], Jsonb(definition), now, actor(user), now, actor(user)))
    return one(database, definition["id"])


@router.put("/{template_id}")
def save(template_id: str, payload: DefinitionInput, user: dict = Depends(require_studio_author),
         database: Connection = Depends(connection)):
    if payload.definition.get("id") not in (None, template_id):
        return invalid([{"path": "$.id", "message": "id cannot be changed"}])
    definition = billing_templates.normalize({**payload.definition, "id": template_id})
    with database.transaction():
        row = database.execute("SELECT status FROM canopy_billing_template WHERE id=%s FOR UPDATE", (template_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "template not found")
        if row["status"] == "archived":
            raise HTTPException(409, "archived templates cannot be changed")
        # Editing a published template makes it a draft; Leafs keep the published copy until it is published again.
        database.execute(
            """UPDATE canopy_billing_template SET name=%s, description=%s, definition=%s,
                 status=CASE WHEN status='published' AND published_definition IS DISTINCT FROM %s THEN 'draft' ELSE status END,
                 updated_at=%s, updated_by=%s WHERE id=%s""",
            (definition["name"], definition["description"], Jsonb(definition), Jsonb(definition), workflows.now_ms(),
             actor(user), template_id))
    return one(database, template_id)


@router.post("/{template_id}/publish")
def publish(template_id: str, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    with database.transaction():
        row = database.execute("SELECT * FROM canopy_billing_template WHERE id=%s FOR UPDATE", (template_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "template not found")
        issues = billing_templates.validate(database, row["definition"])
        if issues:
            return invalid(issues)
        now = workflows.now_ms()
        database.execute(
            """UPDATE canopy_billing_template SET status='published', version=version+1, published_definition=definition,
                 published_at=%s, updated_at=%s, updated_by=%s WHERE id=%s""", (now, now, actor(user), template_id))
        # Wards using it see a new workflow set version, so their Leafs pick up the change.
        database.execute(
            """UPDATE canopy_workflow SET updated_at=%s WHERE published_definition->'billing'->>'template_id' = %s""",
            (now, template_id))
    return one(database, template_id)


@router.post("/{template_id}/archive")
def archive(template_id: str, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    users = used_by(database).get(template_id, [])
    if any(item["status"] == "published" for item in users):
        raise HTTPException(409, "published workflows still use this template: " + ", ".join(item["name"] or item["id"] for item in users))
    row = database.execute(
        "UPDATE canopy_billing_template SET status='archived', updated_at=%s, updated_by=%s WHERE id=%s RETURNING id",
        (workflows.now_ms(), actor(user), template_id)).fetchone()
    if row is None:
        raise HTTPException(404, "template not found")
    return one(database, template_id)


@router.post("/{template_id}/duplicate")
def duplicate(template_id: str, payload: DuplicateInput, user: dict = Depends(require_studio_author),
              database: Connection = Depends(connection)):
    row = database.execute("SELECT definition FROM canopy_billing_template WHERE id=%s", (template_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "template not found")
    copy = {**row["definition"], "id": payload.id, "name": payload.name or f"{row['definition'].get('name', '')} (copy)"}
    return create(DefinitionInput(definition=copy), user, database)
