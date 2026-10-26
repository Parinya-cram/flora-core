"""AI Studio dashboard kiosk links (0098-ai-studio-kiosk-link.sql).

The owner makes a permanent link for a wall display; opening it needs no sign-in. The link carries
`fkd_<prefix>_<secret>` (sent back as the X-Flora-Kiosk header); only the secret's hash is stored,
so the full link is shown once, when it is made. A kiosk can only read its own dashboard: the board,
the owner's snippets placed on it, and the predefined widgets' data, all with the owner's ward
access (narrowed to the ward chosen when the link was made). Revoking, deleting the dashboard or
deactivating the owner stops it.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import tenancy
from ..database import pool
from .. import leaf_context
from ..demo_ward import DEMO_SOURCE
from .ai_studio import _owned_dashboard, _user
from .auth_leaf import attach_entitlements
from .canopy_reports import studio_rows
from .fleet_read import active_cases, leaves
from .gateway_alerts import list_gateway_alerts

router = APIRouter(tags=["ai studio kiosk"])

TOKEN_PREFIX = "fkd_"
KIOSK_HEADER = "x-flora-kiosk"
USED_EVERY_MS = 60_000
MAX_LINKS = 20


def _now() -> int:
    return int(time.time() * 1000)


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def split_token(token: str) -> tuple[str, str] | None:
    parts = token.strip().split("_")
    if len(parts) != 3 or f"{parts[0]}_" != TOKEN_PREFIX or not parts[1] or not parts[2]:
        return None
    return parts[1], parts[2]


# Owner: make, list and revoke links -------------------------------------------------------------
class LinkInput(BaseModel):
    label: str = Field(min_length=1, max_length=120)


LINK_COLUMNS = """l.id,l.label,l.prefix,l.ward_key,l.created_at,l.revoked_at,l.last_used_at,l.last_ip,
  coalesce(c.name,c.username) AS created_by_name, coalesce(r.name,r.username) AS revoked_by_name"""


@router.get("/api/ai-studio/dashboards/{dashboard_id}/links")
def list_links(dashboard_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        row = _owned_dashboard(database, dashboard_id, user)
        links = database.execute(
            f"""SELECT {LINK_COLUMNS} FROM ai_studio_dashboard_link l
                LEFT JOIN auth_user c ON c.id=l.created_by LEFT JOIN auth_user r ON r.id=l.revoked_by
                WHERE l.dashboard_id=%s ORDER BY l.revoked_at IS NOT NULL, l.created_at DESC""", (row["id"],)).fetchall()
    return {"rows": links}


@router.post("/api/ai-studio/dashboards/{dashboard_id}/links")
def create_link(dashboard_id: str, payload: LinkInput, request: Request):
    """The token is returned only here; Canopy keeps its hash."""
    user = _user(request)
    ward = request.headers.get("x-flora-ward", "").strip()
    ward = None if not ward or ward.lower() == "all" else ward
    with pool.connection() as database:
        row = _owned_dashboard(database, dashboard_id, user)
        live = database.execute("SELECT count(*) AS n FROM ai_studio_dashboard_link WHERE dashboard_id=%s AND revoked_at IS NULL",
                                (row["id"],)).fetchone()["n"]
        if live >= MAX_LINKS:
            raise HTTPException(status_code=409, detail=f"At most {MAX_LINKS} active kiosk links per dashboard; revoke one first")
        prefix, secret = secrets.token_hex(4), secrets.token_urlsafe(24).replace("_", "-")
        link_id = uuid.uuid4()
        database.execute(
            """INSERT INTO ai_studio_dashboard_link(id,dashboard_id,label,prefix,secret_hash,ward_key,created_by,created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (link_id, row["id"], payload.label.strip(), prefix, _hash(secret), ward, user["id"], _now()))
        link = database.execute(
            f"""SELECT {LINK_COLUMNS} FROM ai_studio_dashboard_link l LEFT JOIN auth_user c ON c.id=l.created_by
                LEFT JOIN auth_user r ON r.id=l.revoked_by WHERE l.id=%s""", (link_id,)).fetchone()
    return {**link, "token": f"{TOKEN_PREFIX}{prefix}_{secret}"}


@router.delete("/api/ai-studio/dashboards/{dashboard_id}/links/{link_id}")
def revoke_link(dashboard_id: str, link_id: str, request: Request):
    user = _user(request)
    with pool.connection() as database:
        row = _owned_dashboard(database, dashboard_id, user)
        found = database.execute(
            """UPDATE ai_studio_dashboard_link SET revoked_at=coalesce(revoked_at,%s), revoked_by=coalesce(revoked_by,%s)
               WHERE id::text=%s AND dashboard_id=%s RETURNING id""", (_now(), user["id"], link_id, row["id"])).fetchone()
    if not found:
        raise HTTPException(status_code=404, detail="Kiosk link not found")
    return {"id": link_id, "revoked": True}


# Kiosk: read one dashboard with its link ----------------------------------------------------------
def _kiosk(request: Request, database) -> dict[str, Any]:
    """The link, its dashboard and owner; 401 for anything unknown, revoked or no longer allowed."""
    parts = split_token(request.headers.get(KIOSK_HEADER, ""))
    denied = HTTPException(status_code=401, detail="This kiosk link is not valid or has been revoked")
    # The middleware found no account holding this link (unknown or revoked): nothing to read.
    if not parts or (tenancy.MULTI_ACCOUNT and tenancy.current_account() is None):
        raise denied
    link = database.execute(
        """SELECT l.*, d.owner_user_id, d.title, d.cols, d.rows, d.row_height, d.widgets, d.settings, d.updated_at AS dashboard_updated_at
           FROM ai_studio_dashboard_link l JOIN ai_studio_dashboard d ON d.id=l.dashboard_id
           WHERE l.prefix=%s AND l.revoked_at IS NULL""", (parts[0],)).fetchone()
    if not link or not hmac.compare_digest(link["secret_hash"], _hash(parts[1])):
        raise denied
    owner = database.execute("SELECT id,username,name,role,is_active,all_units FROM auth_user WHERE id=%s",
                             (link["owner_user_id"],)).fetchone()
    if not owner or not owner["is_active"]:
        raise denied
    owner = attach_entitlements(database, owner)
    allowed = None if owner.get("all_units") or "system_admin" in (owner.get("_role_codes") or []) \
        else [unit["key"] for unit in owner.get("_units") or []]
    ward = link["ward_key"]
    if ward and allowed is not None and ward not in allowed:
        raise denied
    now = _now()
    if not link["last_used_at"] or now - link["last_used_at"] > USED_EVERY_MS:
        ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or (request.client.host if request.client else None)
        database.execute("UPDATE ai_studio_dashboard_link SET last_used_at=%s,last_ip=%s WHERE id=%s", (now, ip, link["id"]))
    return {**link, "scope": [ward] if ward else allowed}


def _source(database, link: dict[str, Any]) -> str:
    ward = link["ward_key"]
    if ward and database.execute("SELECT 1 FROM canopy_location WHERE id::text=%s AND kind='care_unit' AND is_demo", (ward,)).fetchone():
        return DEMO_SOURCE
    return "innovian"


def _snippet_ids(link: dict[str, Any]) -> list[str]:
    return [str(w["config"]["artifactId"]) for w in link["widgets"] or []
            if w.get("type") == "snippet" and (w.get("config") or {}).get("artifactId")]


@router.get("/api/kiosk/dashboard")
def kiosk_dashboard(request: Request):
    with pool.connection() as database:
        link = _kiosk(request, database)
        ids = _snippet_ids(link)
        snippets = database.execute(
            """SELECT id,title,html,data,created_at,updated_at FROM ai_studio_artifact
               WHERE id::text=ANY(%s) AND (owner_user_id=%s OR shared)""", (ids, link["owner_user_id"])).fetchall() if ids else []
    return {"dashboard": {"id": str(link["dashboard_id"]), "title": link["title"], "cols": link["cols"], "rows": link["rows"],
                          "row_height": link["row_height"], "widgets": link["widgets"], "settings": link["settings"] or {},
                          "updated_at": link["dashboard_updated_at"]},
            "snippets": snippets, "label": link["label"]}


def _period(request: Request) -> dict[str, str]:
    out = {}
    for key in ("from", "to"):
        value = request.query_params.get(key, "").strip()
        try:
            out[key] = date.fromisoformat(value).isoformat()
        except ValueError:
            pass
    return out


@router.get("/api/kiosk/snippets/{artifact_id}/run")
def kiosk_snippet(artifact_id: str, request: Request):
    """Only a snippet placed on this dashboard, with the owner's access."""
    with pool.connection() as database:
        link = _kiosk(request, database)
        if artifact_id not in _snippet_ids(link):
            raise HTTPException(status_code=404, detail="Snippet not on this dashboard")
        row = database.execute("SELECT data FROM ai_studio_artifact WHERE id::text=%s AND (owner_user_id=%s OR shared)",
                               (artifact_id, link["owner_user_id"])).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Snippet not available")
        query = {"_source": _source(database, link), **_period(request)}
        out: dict[str, Any] = {}
        for name, spec in list((row["data"] or {}).items())[:8]:
            try:
                out[name] = studio_rows(database, spec, query)
            except HTTPException as error:
                out[name] = {"error": str(error.detail), "columns": [], "rows": []}
    return {"data": out, "params": {key: query[key] for key in ("from", "to") if key in query}, "ranAt": _now()}


def _count_spec(start: date, end: date) -> dict[str, Any]:
    return {"dataset": "innovian_cases", "view": "stats", "columns": [], "groups": [],
            "filters": [{"field": "case.started_at", "op": "between", "value": [start.isoformat(), end.isoformat()]}],
            "measures": [{"agg": "count_cases", "label": "Cases"}, {"agg": "count_patients", "label": "Patients"}]}


@router.get("/api/kiosk/case-counts")
def kiosk_case_counts(request: Request):
    today = date.today()
    specs = {"today": _count_spec(today, today), "week": _count_spec(today - timedelta(days=6), today),
             "month": _count_spec(today.replace(day=1), today)}
    with pool.connection() as database:
        link = _kiosk(request, database)
        query = {"_source": _source(database, link)}
        data = {name: studio_rows(database, spec, query) for name, spec in specs.items()}
    return {"data": data, "params": {}, "ranAt": _now()}


@router.get("/api/kiosk/leaves")
def kiosk_leaves(request: Request):
    with pool.connection() as database:
        link = _kiosk(request, database)
        return leaves(scope=link["scope"], database=database)


@router.get("/api/kiosk/active-cases")
def kiosk_active_cases(request: Request):
    with pool.connection() as database:
        link = _kiosk(request, database)
        return active_cases(scope=link["scope"], database=database)


@router.get("/api/kiosk/gateway-alerts")
def kiosk_gateway_alerts(request: Request):
    with pool.connection() as database:
        _kiosk(request, database)
        return list_gateway_alerts(status="open", gateway_id=None, limit=200, database=database)


@router.get("/api/kiosk/leaf-context")
def kiosk_leaf_context(request: Request):
    """The Leaf the board follows (its saved setting), within the owner's ward access."""
    with pool.connection() as database:
        link = _kiosk(request, database)
        leaf_id = (link["settings"] or {}).get("leafId")
        found = leaf_context.context(database, leaf_id) if leaf_id else None
        if found and link["scope"] is not None and found["leaf"]["unit_key"] not in link["scope"]:
            found = None
    return {"context": found}


@router.get("/api/fleet/leaf-context/{leaf_id}")
def viewer_leaf_context(leaf_id: str, request: Request):
    """The same, for a signed-in viewer: a Leaf of a ward they may see."""
    from .canopy_preferences import current_canopy_user
    from .canopy_users import ward_scope
    with pool.connection() as database:
        scope = ward_scope(request, current_canopy_user(request, database))
        found = leaf_context.context(database, leaf_id)
    if not found or (scope is not None and found["leaf"]["unit_key"] not in scope):
        raise HTTPException(status_code=404, detail="Leaf not found in your wards")
    return {"context": found}
