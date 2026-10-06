"""Canopy admin: issue / revoke public API keys and read the access log."""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg import Connection
from pydantic import BaseModel, Field

from .. import api_keys, directory
from ..database import connection
from .fleet_control import require_admin

router = APIRouter(prefix="/api/fleet/control", tags=["public api keys"], dependencies=[Depends(require_admin)])


class KeyInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    scopes: list[str] = Field(min_length=1)
    unit_keys: list[str] | None = None
    include_demo: bool = False
    expires_in_days: int | None = Field(default=365, ge=1, le=3650)


@router.get("/api-keys/scopes")
def scopes() -> dict[str, Any]:
    return {"scopes": [{"code": code, "label": label} for code, label in api_keys.SCOPES.items()],
            "rateLimitPerMinute": api_keys.RATE_LIMIT_PER_MINUTE,
            "apiBasePath": "/api/v1", "docsPath": "/docs", "mcpPath": "/mcp"}


@router.get("/api-keys")
def list_keys(database: Connection = Depends(connection)) -> dict[str, Any]:
    rows = database.execute(
        """SELECT k.*, (SELECT count(*) FROM canopy_api_access_log l WHERE l.key_id=k.id AND l.at > %s) AS requests_24h
           FROM canopy_api_key k ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC""",
        (api_keys.now_ms() - 24 * 3600 * 1000,),
    ).fetchall()
    return {"rows": [api_keys.public(row) for row in rows]}


@router.post("/api-keys")
def create_key(payload: KeyInput, user: dict = Depends(require_admin), database: Connection = Depends(connection)) -> dict[str, Any]:
    unknown = [scope for scope in payload.scopes if scope not in api_keys.SCOPES]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown scope(s): {', '.join(unknown)}")
    if payload.unit_keys is not None:
        known = {ward["key"] for ward in directory.ward_options(database)["rows"]}
        if not payload.unit_keys or not set(payload.unit_keys) <= known:
            raise HTTPException(status_code=400, detail="choose at least one known ward, or all wards")
    expires = api_keys.now_ms() + payload.expires_in_days * 86_400_000 if payload.expires_in_days else None
    with database.transaction():
        row, key = api_keys.new_key_row(
            database, name=payload.name.strip(), scopes=list(dict.fromkeys(payload.scopes)),
            unit_keys=payload.unit_keys, include_demo=payload.include_demo, expires_at=expires,
            created_by=user.get("username"))
    return {"row": api_keys.public(row), "key": key,
            "notice": "Copy the key now. Canopy stores only its hash and cannot show it again."}


@router.post("/api-keys/{key_id}/revoke")
def revoke_key(key_id: str, user: dict = Depends(require_admin), database: Connection = Depends(connection)) -> dict[str, Any]:
    row = database.execute(
        """UPDATE canopy_api_key SET revoked_at=coalesce(revoked_at,%s),revoked_by=coalesce(revoked_by,%s)
           WHERE id::text=%s RETURNING *""",
        (api_keys.now_ms(), user.get("username"), key_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="API key not found")
    return {"row": api_keys.public(row)}


@router.get("/api-logs")
def access_log(
    key_id: str | None = Query(default=None, max_length=64),
    status: str | None = Query(default=None, pattern="^(ok|error)$"),
    client: str | None = Query(default=None, max_length=40),
    case_id: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=200, ge=1, le=1000),
    database: Connection = Depends(connection),
) -> dict[str, Any]:
    rows = database.execute(
        """SELECT l.*, k.name AS key_name FROM canopy_api_access_log l
           LEFT JOIN canopy_api_key k ON k.id=l.key_id
           WHERE (%(key)s::text IS NULL OR l.key_id::text=%(key)s)
             AND (%(status)s::text IS NULL OR (%(status)s='ok' AND l.status < 400) OR (%(status)s='error' AND l.status >= 400))
             AND (%(client)s::text IS NULL OR l.client=%(client)s)
             AND (%(case)s::text IS NULL OR %(case)s = ANY(l.case_ids))
           ORDER BY l.at DESC, l.id DESC LIMIT %(limit)s""",
        {"key": key_id, "status": status, "client": client, "case": case_id, "limit": limit},
    ).fetchall()
    return {"rows": [{
        "id": row["id"], "at": row["at"], "keyId": str(row["key_id"]) if row["key_id"] else None,
        "keyName": row["key_name"], "keyPrefix": row["key_prefix"], "method": row["method"], "path": row["path"],
        "query": row["query"], "status": row["status"], "durationMs": row["duration_ms"], "ip": row["ip"],
        "userAgent": row["user_agent"], "client": row["client"], "tool": row["tool"],
        "caseIds": list(row["case_ids"] or []), "error": row["error"],
    } for row in rows]}
