"""HL7 admission interface: the gateway's EMR webhook in, settings and message log for admins."""
import hmac
import secrets
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection
from pydantic import BaseModel, Field

from .. import directory, hl7_interface
from ..database import connection
from .fleet_control import require_admin

webhook_router = APIRouter(prefix="/api/integrations/hl7", tags=["hl7 interface"])
admin_router = APIRouter(prefix="/api/fleet/control/integrations/hl7", tags=["hl7 interface"],
                         dependencies=[Depends(require_admin)])


@webhook_router.post("/webhook/{token}")
def webhook(token: str, payload: dict[str, Any] = Body(...), database: Connection = Depends(connection)) -> dict[str, Any]:
    """The gateway's outbound EMR webhook. It cannot send credentials, so the URL carries a secret token."""
    config = hl7_interface.settings(database)
    if not config["webhook_token"] or not hmac.compare_digest(token, config["webhook_token"]):
        raise HTTPException(status_code=404, detail="not found")
    if not config["enabled"]:
        raise HTTPException(status_code=503, detail="HL7 interface is disabled")
    outcome = hl7_interface.process(database, payload, config)
    return {"ok": outcome["status"] != "error", "status": outcome["status"], "id": outcome["id"]}


class SettingsInput(BaseModel):
    enabled: bool = False
    gateway_url: str = Field(default="", max_length=500)
    basic_username: str = Field(default="", max_length=200)
    basic_password: str | None = Field(default=None, max_length=500)  # None keeps the stored value
    bearer_token: str | None = Field(default=None, max_length=500)
    verify_tls: bool = True
    default_unit_key: str | None = Field(default=None, max_length=40)
    create_on: list[str] = Field(default_factory=lambda: list(hl7_interface.DEFAULT_CREATE_ON))


class LocationInput(BaseModel):
    unit_key: str = Field(min_length=1, max_length=40)
    target_leaf_id: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


@admin_router.get("")
def get_settings(database: Connection = Depends(connection)) -> dict[str, Any]:
    return hl7_interface.public_settings(hl7_interface.settings(database))


@admin_router.put("")
def put_settings(payload: SettingsInput, user: dict = Depends(require_admin),
                 database: Connection = Depends(connection)) -> dict[str, Any]:
    allowed = {"SIU^S12", "ORM^O01", "ADT^A01"}
    if not set(payload.create_on) <= allowed:
        raise HTTPException(status_code=400, detail=f"create_on accepts {sorted(allowed)}")
    if payload.default_unit_key and not any(w["key"] == payload.default_unit_key for w in directory.ward_options(database)["rows"]):
        raise HTTPException(status_code=400, detail="unknown default ward")
    current = hl7_interface.settings(database)
    database.execute(
        """UPDATE canopy_hl7_interface SET enabled=%s,gateway_url=%s,basic_username=%s,basic_password=%s,
             bearer_token=%s,verify_tls=%s,default_unit_key=%s,create_on=%s,updated_at=%s,updated_by=%s WHERE id=1""",
        (payload.enabled, payload.gateway_url.strip().rstrip("/"), payload.basic_username.strip(),
         current["basic_password"] if payload.basic_password is None else payload.basic_password,
         current["bearer_token"] if payload.bearer_token is None else payload.bearer_token.strip(),
         payload.verify_tls, payload.default_unit_key or None, payload.create_on,
         hl7_interface.now_ms(), user.get("username")),
    )
    return hl7_interface.public_settings(hl7_interface.settings(database))


@admin_router.post("/rotate-webhook-token")
def rotate_token(database: Connection = Depends(connection)) -> dict[str, Any]:
    hl7_interface.settings(database)
    database.execute("UPDATE canopy_hl7_interface SET webhook_token=%s,updated_at=%s WHERE id=1",
                     (secrets.token_urlsafe(32), hl7_interface.now_ms()))
    return hl7_interface.public_settings(hl7_interface.settings(database))


@admin_router.post("/test")
def test_gateway(database: Connection = Depends(connection)) -> dict[str, Any]:
    config = hl7_interface.settings(database)
    try:
        status, body = hl7_interface.gateway_get(config, "/health")
    except Exception as error:
        return {"ok": False, "error": f"cannot reach the gateway ({type(error).__name__}: {error})"}
    return {"ok": status == 200, "status": status, "health": body}


@admin_router.get("/locations")
def locations(database: Connection = Depends(connection)) -> dict[str, Any]:
    rows = database.execute(
        """SELECT m.*, unit.name AS unit_name, coalesce(nullif(leaf.canopy_display_name,''),leaf.display_name) AS leaf_name
           FROM canopy_hl7_location_map m
           LEFT JOIN canopy_location unit ON unit.id::text=m.unit_key
           LEFT JOIN sync_leaf_node leaf ON leaf.leaf_id=m.target_leaf_id
           ORDER BY m.code"""
    ).fetchall()
    seen = database.execute(
        """SELECT location_code AS code, count(*) AS messages, max(received_at) AS last_seen
           FROM canopy_hl7_message WHERE location_code IS NOT NULL
             AND location_code NOT IN (SELECT code FROM canopy_hl7_location_map)
           GROUP BY location_code ORDER BY max(received_at) DESC LIMIT 100"""
    ).fetchall()
    return {"rows": rows, "unmapped": seen}


@admin_router.put("/locations/{code}")
def put_location(code: str, payload: LocationInput, database: Connection = Depends(connection)) -> dict[str, Any]:
    normalized = code.strip().upper()
    if not normalized:
        raise HTTPException(status_code=400, detail="location code required")
    if not any(w["key"] == payload.unit_key for w in directory.ward_options(database)["rows"]):
        raise HTTPException(status_code=400, detail="unknown ward")
    if payload.target_leaf_id:
        leaf = database.execute("SELECT unit_key FROM canopy_leaf_unit WHERE leaf_id=%s", (payload.target_leaf_id,)).fetchone()
        if leaf is None or leaf["unit_key"] != payload.unit_key:
            raise HTTPException(status_code=400, detail="that Leaf is not in the selected ward")
    database.execute(
        """INSERT INTO canopy_hl7_location_map(code,unit_key,target_leaf_id,note,updated_at) VALUES (%s,%s,%s,%s,%s)
           ON CONFLICT(code) DO UPDATE SET unit_key=excluded.unit_key,target_leaf_id=excluded.target_leaf_id,
             note=excluded.note,updated_at=excluded.updated_at""",
        (normalized, payload.unit_key, payload.target_leaf_id or None, payload.note, hl7_interface.now_ms()),
    )
    return {"ok": True, "code": normalized}


@admin_router.delete("/locations/{code}")
def delete_location(code: str, database: Connection = Depends(connection)) -> dict[str, Any]:
    database.execute("DELETE FROM canopy_hl7_location_map WHERE code=%s", (code.strip().upper(),))
    return {"ok": True}


@admin_router.get("/messages")
def messages(status: str | None = Query(default=None, pattern="^(applied|ignored|unrouted|error)$"),
             mrn: str | None = Query(default=None, max_length=64),
             limit: int = Query(default=100, ge=1, le=500),
             database: Connection = Depends(connection)) -> dict[str, Any]:
    rows = database.execute(
        """SELECT id,received_at,message_type,control_id,mrn,location_code,status,action,admission_id,error
           FROM canopy_hl7_message
           WHERE (%s::text IS NULL OR status=%s) AND (%s::text IS NULL OR mrn=%s)
           ORDER BY received_at DESC, id DESC LIMIT %s""",
        (status, status, mrn, mrn, limit),
    ).fetchall()
    counts = database.execute(
        "SELECT status, count(*) AS n FROM canopy_hl7_message WHERE received_at > %s GROUP BY status",
        (hl7_interface.now_ms() - 24 * 3600 * 1000,),
    ).fetchall()
    return {"rows": rows, "last24h": {row["status"]: row["n"] for row in counts}}


@admin_router.get("/messages/{message_id}")
def message(message_id: int, database: Connection = Depends(connection)) -> dict[str, Any]:
    row = database.execute("SELECT * FROM canopy_hl7_message WHERE id=%s", (message_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="message not found")
    return {"row": row}


@admin_router.post("/messages/{message_id}/reprocess")
def reprocess(message_id: int, database: Connection = Depends(connection)) -> dict[str, Any]:
    row = database.execute("SELECT payload FROM canopy_hl7_message WHERE id=%s", (message_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="message not found")
    return hl7_interface.process(database, row["payload"], hl7_interface.settings(database), message_id)


@admin_router.post("/messages/reprocess-unrouted")
def reprocess_unrouted(database: Connection = Depends(connection)) -> dict[str, Any]:
    config = hl7_interface.settings(database)
    rows = database.execute(
        "SELECT id,payload FROM canopy_hl7_message WHERE status='unrouted' ORDER BY received_at LIMIT 500"
    ).fetchall()
    results = [hl7_interface.process(database, row["payload"], config, row["id"]) for row in rows]
    return {"processed": len(results), "applied": sum(1 for r in results if r["status"] == "applied"),
            "still_unrouted": sum(1 for r in results if r["status"] == "unrouted")}
