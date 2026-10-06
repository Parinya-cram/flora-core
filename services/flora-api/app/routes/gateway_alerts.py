"""Central gateway alert log at Canopy.

Gateways queue alerts locally and send every change through Haber (sync mode,
`POST /api/sync/v1/gateways/{id}/alerts`). The Canopy UI reads the merged log
(`GET /api/fleet/gateway-alerts`).
"""
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from psycopg import Connection
from pydantic import BaseModel, Field

from .. import directory
from ..database import connection
from .auth_canopy import read_token
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
