"""Central gateway alert log at Canopy.

Gateways queue alerts locally and send every change through Haber (sync mode,
`POST /api/sync/v1/gateways/{id}/alerts`). The Canopy UI reads the merged log
(`GET /api/fleet/gateway-alerts`).

The stream-hub's case UUID <-> device bindings come the same way
(`POST /api/sync/v1/gateways/{id}/case-bindings`, read with `GET /api/fleet/case-bindings`).
"""
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from psycopg import Connection
from pydantic import BaseModel, Field

from .. import directory
from ..database import connection
from .auth_canopy import read_token
from .fleet_read import IN_SCOPE, fleet_scope
from .sync_ingest import require_sync_secret

sync_router = APIRouter(prefix="/api/sync/v1", tags=["leaf-canopy-sync"])
fleet_router = APIRouter(prefix="/api/fleet", tags=["canopy-fleet"], dependencies=[Depends(read_token)])

ALERT_FIELDS = ("alert_key", "category", "severity", "title", "detail", "opened_at", "last_seen_at",
                "resolved_at", "acknowledged_at", "acknowledged_by", "version")


class GatewayAlert(BaseModel):
    alert_id: int
    alert_key: str = Field(max_length=200)
    category: str = Field(max_length=40)
    severity: Literal["critical", "warning", "info"]
    title: str = Field(max_length=300)
    detail: str | None = Field(default=None, max_length=2000)
    opened_at: int
    last_seen_at: int
    resolved_at: int | None = None
    acknowledged_at: int | None = None
    acknowledged_by: str | None = Field(default=None, max_length=120)
    version: int = Field(ge=1)


class GatewayAlertBatch(BaseModel):
    alerts: list[GatewayAlert] = Field(default_factory=list, max_length=500)


@sync_router.post("/gateways/{gateway_id}/alerts", dependencies=[Depends(require_sync_secret)])
def store_gateway_alerts(gateway_id: str, payload: GatewayAlertBatch,
                         database: Connection = Depends(connection)) -> dict[str, Any]:
    """Upserts each alert unless Canopy already holds a newer version; confirms what it holds."""
    received = directory.now_ms()
    accepted = []
    with database.transaction():
        for alert in payload.alerts:
            values = alert.model_dump()
            database.execute(
                f"""INSERT INTO canopy_gateway_alert (gateway_id, alert_id, {', '.join(ALERT_FIELDS)}, received_at)
                    VALUES (%s, %s, {', '.join(['%s'] * len(ALERT_FIELDS))}, %s)
                    ON CONFLICT (gateway_id, alert_id) DO UPDATE SET
                      {', '.join(f'{field}=excluded.{field}' for field in ALERT_FIELDS)}, received_at=excluded.received_at
                    WHERE canopy_gateway_alert.version < excluded.version""",
                (gateway_id, alert.alert_id, *(values[field] for field in ALERT_FIELDS), received))
            accepted.append({"alert_id": alert.alert_id, "version": alert.version})
    return {"accepted": accepted}


@fleet_router.get("/gateway-alerts")
def list_gateway_alerts(status: Literal["all", "open", "resolved"] = "all",
                        gateway_id: str | None = None, limit: int = Query(default=200, ge=1, le=1000),
                        database: Connection = Depends(connection)) -> dict[str, Any]:
    """Alerts from every gateway, open ones first, joined with where each gateway is installed."""
    conditions, params = [], []
    if status == "open":
        conditions.append("alert.resolved_at IS NULL")
    elif status == "resolved":
        conditions.append("alert.resolved_at IS NOT NULL")
    if gateway_id:
        conditions.append("alert.gateway_id = %s")
        params.append(gateway_id)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = database.execute(
        f"""SELECT alert.*, gateway.site->>'display_name' AS site_name, gateway.site->>'unit' AS site_unit,
                   gateway.last_seen_at AS gateway_last_seen_at
            FROM canopy_gateway_alert alert LEFT JOIN canopy_gateway gateway USING (gateway_id)
            {where} ORDER BY alert.resolved_at IS NOT NULL, alert.opened_at DESC LIMIT %s""",
        (*params, limit)).fetchall()
    counts = database.execute(
        """SELECT count(*) FILTER (WHERE resolved_at IS NULL) AS open,
                  count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'critical') AS critical_open,
                  count(DISTINCT gateway_id) FILTER (WHERE resolved_at IS NULL) AS gateways_affected
           FROM canopy_gateway_alert""").fetchone()
    return {"rows": rows, "counts": counts}


class CaseBinding(BaseModel):
    id: int
    session_id: uuid.UUID
    leaf_id: str = Field(max_length=120)
    case_uuid: uuid.UUID
    device_id: str = Field(max_length=120)
    mode: Literal["exclusive", "shared"]
    bound_at: datetime
    unbound_at: datetime | None = None
    unbind_reason: str | None = Field(default=None, max_length=60)
    last_acked_seq: int | None = None


class CaseBindingBatch(BaseModel):
    bindings: list[CaseBinding] = Field(default_factory=list, max_length=1000)


@sync_router.post("/gateways/{gateway_id}/case-bindings", dependencies=[Depends(require_sync_secret)])
def store_case_bindings(gateway_id: str, payload: CaseBindingBatch,
                        database: Connection = Depends(connection)) -> dict[str, Any]:
    """Upserts stream-hub bindings; a late resend of an open row never reopens a closed one."""
    with database.transaction():
        for row in payload.bindings:
            database.execute(
                """INSERT INTO canopy_gateway_case_binding (gateway_id, binding_id, session_id, leaf_id, case_uuid,
                       device_id, mode, bound_at, unbound_at, unbind_reason, last_acked_seq, updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                   ON CONFLICT (gateway_id, binding_id) DO UPDATE SET
                     unbound_at=coalesce(canopy_gateway_case_binding.unbound_at, excluded.unbound_at),
                     unbind_reason=coalesce(canopy_gateway_case_binding.unbind_reason, excluded.unbind_reason),
                     last_acked_seq=GREATEST(canopy_gateway_case_binding.last_acked_seq, excluded.last_acked_seq),
                     updated_at=now()""",
                (gateway_id, row.id, row.session_id, row.leaf_id, row.case_uuid, row.device_id, row.mode,
                 row.bound_at, row.unbound_at, row.unbind_reason, row.last_acked_seq))
    return {"accepted": [row.id for row in payload.bindings]}


@fleet_router.get("/case-bindings")
def list_case_bindings(case_uuid: uuid.UUID | None = None, leaf_id: str | None = None,
                       is_open: bool | None = Query(default=None, alias="open"),
                       limit: int = Query(default=200, ge=1, le=1000),
                       scope: list[str] | None = Depends(fleet_scope),
                       database: Connection = Depends(connection)) -> dict[str, Any]:
    """Device sessions from every gateway's stream-hub, newest first, with the synced case where known."""
    conditions, params = [IN_SCOPE], [scope, scope]
    if case_uuid:
        conditions.append("b.case_uuid = %s")
        params.append(case_uuid)
    if leaf_id:
        conditions.append("b.leaf_id = %s")
        params.append(leaf_id)
    if is_open is not None:
        conditions.append("b.unbound_at IS NULL" if is_open else "b.unbound_at IS NOT NULL")
    rows = database.execute(
        f"""SELECT b.gateway_id, b.binding_id, b.session_id, b.leaf_id, b.case_uuid, b.device_id, b.mode,
                   b.bound_at, b.unbound_at, b.unbind_reason, b.last_acked_seq, b.updated_at,
                   coalesce(nullif(leaf.canopy_display_name,''), leaf.display_name) AS leaf_name,
                   gd.label AS device_label, c.hn, c.status AS case_status,
                   c.snapshot->'patient'->'row'->>'name' AS patient_name, c.snapshot->'case'->>'bed_label' AS bed_label
            FROM canopy_gateway_case_binding b
            LEFT JOIN sync_leaf_node leaf ON leaf.leaf_id = b.leaf_id
            LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id = b.leaf_id
            LEFT JOIN canopy_gateway_device gd ON gd.gateway_id = b.gateway_id AND gd.device_id = b.device_id
            LEFT JOIN sync_case_index c ON c.global_case_id = b.case_uuid
            WHERE {' AND '.join(conditions)}
            ORDER BY b.unbound_at IS NOT NULL, b.bound_at DESC LIMIT %s""",
        (*params, limit)).fetchall()
    return {"rows": rows}
