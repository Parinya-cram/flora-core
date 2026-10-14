"""Workflow Studio: clinical scores, Canopy side (/api/fleet/workflows/scores).

Reads need a Canopy session; writes need studio.manage. Registered before the workflow
routes so these paths are not taken for a workflow id. See app/scoring.py.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from .. import scoring, workflows
from ..database import connection
from .auth_canopy import read_token
from .studio_access import require_studio_author

router = APIRouter(prefix="/api/fleet/workflows/scores", tags=["workflow studio"])
LIBRARY = Path(__file__).resolve().parents[1] / "scoring_library"


class DefinitionInput(BaseModel):
    definition: dict[str, Any]


class DuplicateInput(BaseModel):
    id: str
    name: str = ""


class TryInput(BaseModel):
    definition: dict[str, Any]
    values: dict[str, Any] = {}


def actor(user: dict[str, Any]) -> str:
    return str(user.get("username") or user.get("sub") or "unknown")


def invalid(issues: list[dict[str, str]], message: str = "score is not valid") -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": message, "issues": issues})


def parameters(database: Connection) -> list[dict[str, Any]]:
    return [dict(row) for row in database.execute(
        """SELECT param_key, coalesce(short_name, display_name) AS label, display_name, value_type, unit
           FROM clinical_parameter_master WHERE is_active = 1 ORDER BY display_order, param_key""").fetchall()]


def check(database: Connection, definition: Any) -> list[dict[str, str]]:
    return scoring.validate(definition, [row["param_key"] for row in parameters(database)])


def used_by(database: Connection) -> dict[str, list[dict[str, str]]]:
    rows = database.execute(
        """SELECT id, name, status, coalesce(definition->'scores', '[]'::jsonb) AS draft_ids,
                  coalesce(published_definition->'scores', '[]'::jsonb) AS published_ids
           FROM canopy_workflow WHERE status <> 'archived'""").fetchall()
    result: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        ids = {item for item in [*(row["draft_ids"] or []), *(row["published_ids"] or [])] if isinstance(item, str)}
        for score_id in ids:
            result.setdefault(score_id, []).append({"id": row["id"], "name": row["name"], "status": row["status"]})
    return result


def public(row: dict[str, Any], users: dict[str, list[dict[str, str]]]) -> dict[str, Any]:
    definition = row["definition"]
    return {"id": row["id"], "name": row["name"], "description": row["description"], "status": row["status"],
            "version": int(row["version"]), "updatedAt": row["updated_at"], "updatedBy": row["updated_by"],
            "publishedAt": row.get("published_at"), "definition": definition,
            "itemCount": len(definition.get("items") or []), "mode": definition.get("mode") or "auto",
            "usedBy": users.get(row["id"], [])}


def one(database: Connection, score_id: str) -> dict[str, Any]:
    row = database.execute("SELECT * FROM canopy_score_definition WHERE id=%s", (score_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "score not found")
    return public(row, used_by(database))


def library() -> dict[str, dict[str, Any]]:
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(LIBRARY.glob("*.json"))}


@router.get("")
def list_scores(_: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    users = used_by(database)
    rows = database.execute("SELECT * FROM canopy_score_definition ORDER BY status='archived', name, id").fetchall()
    return {"rows": [public(row, users) for row in rows]}


@router.get("/options")
def options(_: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Parameters a score can read, and the bundled library of validated scores."""
    have = {row["id"] for row in database.execute("SELECT id FROM canopy_score_definition").fetchall()}
    return {"parameters": parameters(database),
            "library": [{"id": key, "name": item.get("name"), "description": item.get("description"),
                         "reference": item.get("reference"), "imported": key in have}
                        for key, item in library().items()]}


@router.post("/validate")
def validate(payload: DefinitionInput, _: dict = Depends(read_token), database: Connection = Depends(connection)) -> dict[str, Any]:
    return {"issues": check(database, payload.definition)}


@router.post("/try")
def try_score(payload: TryInput, _: dict = Depends(read_token)) -> dict[str, Any]:
    """Evaluate a (draft) definition against values typed in the studio."""
    issues = scoring.structural_issues(payload.definition)
    if issues:
        return invalid(issues)
    score = scoring.normalize(payload.definition)
    values = {key: scoring._typed(payload.values.get(key, entry.get("default")), entry) for key, entry in score["inputs"].items()}
    try:
        return scoring.evaluate(score, values)
    except Exception as error:  # a draft can still have a broken formula
        return invalid([{"path": "$", "message": str(error)}], "score could not be evaluated")


@router.post("")
def create(payload: DefinitionInput, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    issues = scoring.structural_issues(payload.definition)
    if issues:
        return invalid(issues)
    definition = scoring.normalize(payload.definition)
    definition.pop("version", None)
    now = workflows.now_ms()
    with database.transaction():
        if database.execute("SELECT 1 FROM canopy_score_definition WHERE id=%s", (definition["id"],)).fetchone():
            raise HTTPException(409, f"score '{definition['id']}' already exists")
        database.execute(
            """INSERT INTO canopy_score_definition (id,name,description,definition,status,created_at,created_by,updated_at,updated_by)
               VALUES (%s,%s,%s,%s,'draft',%s,%s,%s,%s)""",
            (definition["id"], definition["name"], definition["description"], Jsonb(definition), now, actor(user), now, actor(user)))
    return one(database, definition["id"])


@router.post("/library/{library_id}")
def import_library(library_id: str, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    """Add a bundled score as a draft (to be reviewed by the clinical team before publishing)."""
    item = library().get(library_id)
    if item is None:
        raise HTTPException(404, "not in the score library")
    return create(DefinitionInput(definition=item), user, database)


@router.put("/{score_id}")
def save(score_id: str, payload: DefinitionInput, user: dict = Depends(require_studio_author),
         database: Connection = Depends(connection)):
    if payload.definition.get("id") not in (None, score_id):
        return invalid([{"path": "$.id", "message": "id cannot be changed"}])
    issues = scoring.structural_issues({**payload.definition, "id": score_id})
    if issues:
        return invalid(issues)
    definition = scoring.normalize({**payload.definition, "id": score_id})
    definition.pop("version", None)
    with database.transaction():
        row = database.execute("SELECT status, published_definition FROM canopy_score_definition WHERE id=%s FOR UPDATE",
                               (score_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "score not found")
        if row["status"] == "archived":
            raise HTTPException(409, "archived scores cannot be changed")
        published = {key: value for key, value in (row["published_definition"] or {}).items() if key != "version"}
        # Editing a published score makes it a draft; Leafs keep the published copy until it is published again.
        status = "draft" if row["status"] == "published" and published != definition else row["status"]
        database.execute(
            """UPDATE canopy_score_definition SET name=%s, description=%s, definition=%s, status=%s,
                 updated_at=%s, updated_by=%s WHERE id=%s""",
            (definition["name"], definition["description"], Jsonb(definition), status, workflows.now_ms(), actor(user), score_id))
    return one(database, score_id)


@router.post("/{score_id}/publish")
def publish(score_id: str, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    with database.transaction():
        row = database.execute("SELECT * FROM canopy_score_definition WHERE id=%s FOR UPDATE", (score_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "score not found")
        issues = check(database, row["definition"])
        if issues:
            return invalid(issues)
        now = workflows.now_ms()
        version = int(row["version"]) + 1
        # The published copy carries its version: results on the Leaf record which version computed them.
        database.execute(
            """UPDATE canopy_score_definition SET status='published', version=%s, published_definition=%s,
                 published_at=%s, updated_at=%s, updated_by=%s WHERE id=%s""",
            (version, Jsonb({**row["definition"], "version": version}), now, now, actor(user), score_id))
        # Wards using it see a new workflow set version, so their Leafs pick up the change.
        database.execute("UPDATE canopy_workflow SET updated_at=%s WHERE published_definition->'scores' ? %s", (now, score_id))
    return one(database, score_id)


@router.post("/{score_id}/archive")
def archive(score_id: str, user: dict = Depends(require_studio_author), database: Connection = Depends(connection)):
    users = used_by(database).get(score_id, [])
    if any(item["status"] == "published" for item in users):
        raise HTTPException(409, "published workflows still use this score: " + ", ".join(item["name"] or item["id"] for item in users))
    row = database.execute(
        "UPDATE canopy_score_definition SET status='archived', updated_at=%s, updated_by=%s WHERE id=%s RETURNING id",
        (workflows.now_ms(), actor(user), score_id)).fetchone()
    if row is None:
        raise HTTPException(404, "score not found")
    return one(database, score_id)


@router.post("/{score_id}/duplicate")
def duplicate(score_id: str, payload: DuplicateInput, user: dict = Depends(require_studio_author),
              database: Connection = Depends(connection)):
    row = database.execute("SELECT definition FROM canopy_score_definition WHERE id=%s", (score_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "score not found")
    copy = {**row["definition"], "id": payload.id, "name": payload.name or f"{row['definition'].get('name', '')} (copy)"}
    return create(DefinitionInput(definition=copy), user, database)
