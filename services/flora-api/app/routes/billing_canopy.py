"""Canopy: the billing item master (edited here, synced to Leafs) and the billing orders
that Leafs send with their case snapshots (see app/billing.py)."""
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection

from .. import billing
from ..database import connection
from .auth_canopy import read_token
from .canopy_preferences import require_canopy_permission
from .fleet_read import IN_SCOPE, fleet_scope

router = APIRouter(tags=["billing"])
manager = require_canopy_permission("billing.manage")


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- master data
@router.get("/api/fleet/billing/catalog", dependencies=[Depends(read_token)])
def catalog(database: Connection = Depends(connection)) -> dict:
    return billing.load_catalog(database)


@router.put("/api/fleet/control/billing/groups/{code}")
def save_group(code: str, payload: dict = Body(...), actor: dict = Depends(manager),
               database: Connection = Depends(connection)) -> dict:
    name = str(payload.get("name") or "").strip()
    if not code.strip() or not name:
        raise HTTPException(400, "code and name are required")
    stamp = now_ms()
    row = database.execute(
        """INSERT INTO billing_group(code,name,form_column,sort_order,is_active,created_at,updated_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (code) DO UPDATE SET name=excluded.name,form_column=excluded.form_column,
             sort_order=excluded.sort_order,is_active=excluded.is_active,updated_at=excluded.updated_at RETURNING *""",
        (code.strip(), name[:160], min(4, max(1, int(payload.get("form_column") or 1))), int(payload.get("sort_order") or 0),
         1 if payload.get("is_active", True) else 0, stamp, stamp)).fetchone()
    return billing.row_dict(row)


@router.put("/api/fleet/control/billing/items/{code}")
def save_item(code: str, payload: dict = Body(...), actor: dict = Depends(manager),
              database: Connection = Depends(connection)) -> dict:
    """Create or update one item. Leafs pick up the change at their next directory sync."""
    name = str(payload.get("name") or "").strip()
    group_code = str(payload.get("group_code") or "").strip()
    if not code.strip() or not name:
        raise HTTPException(400, "code and name are required")
    if not database.execute("SELECT 1 FROM billing_group WHERE code=%s", (group_code,)).fetchone():
        raise HTTPException(400, "unknown group")
    qty_mode = payload.get("qty_mode") or "count"
    if qty_mode not in {"count", "hours", "used"}:
        raise HTTPException(400, "qty_mode must be count, hours or used")
    price = payload.get("unit_price")
    try:
        price = None if price in (None, "") else round(float(price), 2)
    except (TypeError, ValueError) as error:
        raise HTTPException(400, "unit_price must be a number") from error
    if price is not None and price < 0:
        raise HTTPException(400, "unit_price must not be negative")
    clean = lambda key, size=120: (str(payload.get(key) or "").strip()[:size] or None)  # noqa: E731
    stamp = now_ms()
    row = database.execute(
        """INSERT INTO billing_item(code,group_code,name,unit,qty_mode,variant_label,io_item_code,charge_code,unit_price,
             sort_order,is_active,created_at,updated_at,updated_by)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (code) DO UPDATE SET group_code=excluded.group_code,name=excluded.name,unit=excluded.unit,
             qty_mode=excluded.qty_mode,variant_label=excluded.variant_label,io_item_code=excluded.io_item_code,
             charge_code=excluded.charge_code,unit_price=excluded.unit_price,sort_order=excluded.sort_order,
             is_active=excluded.is_active,updated_at=excluded.updated_at,updated_by=excluded.updated_by RETURNING *""",
        (code.strip()[:80], group_code, name[:200], clean("unit", 40), qty_mode, clean("variant_label", 40),
         clean("io_item_code", 80), clean("charge_code", 80), price, int(payload.get("sort_order") or 0),
         1 if payload.get("is_active", True) else 0, stamp, stamp, actor.get("username"))).fetchone()
    return billing.row_dict(row)


# ---------------------------------------------------------------- orders from Leafs
ORDER_FROM = """FROM canopy_case_billing b
  LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id = b.leaf_id
  LEFT JOIN sync_leaf_node l ON l.leaf_id = b.leaf_id"""


def _filters(status: str | None, q: str | None, date_from: int | None, date_to: int | None, scope: list[str] | None):
    where, params = [IN_SCOPE], [scope, scope]
    if status:
        where.append("b.status = %s"); params.append(status)
    if q:
        where.append("(b.hn ILIKE %s OR b.an ILIKE %s OR b.patient_name ILIKE %s OR b.case_code ILIKE %s)")
        params += [f"%{q}%"] * 4
    if date_from:
        where.append("coalesce(b.anesthesia_start,b.surgery_start,b.order_updated_at) >= %s"); params.append(date_from)
    if date_to:
        where.append("coalesce(b.anesthesia_start,b.surgery_start,b.order_updated_at) < %s"); params.append(date_to)
    return " AND ".join(where), params


@router.get("/api/fleet/billing/orders")
def orders(status: str | None = Query(default=None, pattern="^(draft|submitted|void)$"),
           q: str | None = Query(default=None, max_length=80), date_from: int | None = Query(default=None, alias="from"),
           date_to: int | None = Query(default=None, alias="to"), limit: int = Query(default=200, ge=1, le=1000),
           scope: list[str] | None = Depends(fleet_scope), database: Connection = Depends(connection)) -> dict:
    where, params = _filters(status, q, date_from, date_to, scope)
    rows = database.execute(
        f"""SELECT b.*, coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name {ORDER_FROM}
            WHERE {where} ORDER BY coalesce(b.anesthesia_start,b.order_updated_at) DESC NULLS LAST LIMIT %s""",
        (*params, limit)).fetchall()
    totals = database.execute(
        f"""SELECT i.item_code, min(i.name) AS name, min(i.group_code) AS group_code, min(i.unit) AS unit,
                   sum(i.qty) AS qty, count(DISTINCT b.global_case_id) AS cases, sum(i.amount) AS amount
            FROM canopy_case_billing_item i JOIN canopy_case_billing b ON b.global_case_id=i.global_case_id
            LEFT JOIN canopy_leaf_unit scope_unit ON scope_unit.leaf_id = b.leaf_id
            WHERE {where} GROUP BY i.item_code ORDER BY min(i.group_code), min(i.name)""", params).fetchall()
    return {"rows": [billing.row_dict(r) for r in rows], "item_totals": [billing.row_dict(r) for r in totals]}


@router.get("/api/fleet/billing/orders/{global_case_id}")
def order(global_case_id: str, scope: list[str] | None = Depends(fleet_scope), database: Connection = Depends(connection)) -> dict:
    row = database.execute(f"SELECT b.* {ORDER_FROM} WHERE b.global_case_id::text=%s AND {IN_SCOPE}",
                           (global_case_id, scope, scope)).fetchone()
    if not row:
        raise HTTPException(404, "billing order not found")
    items = database.execute("SELECT * FROM canopy_case_billing_item WHERE global_case_id::text=%s ORDER BY line_no",
                             (global_case_id,)).fetchall()
    return {"order": billing.row_dict(row), "items": [billing.row_dict(r) for r in items]}
