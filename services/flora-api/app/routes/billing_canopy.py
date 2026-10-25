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


def _combined_groups(database: Connection, ids: list[str]) -> dict[str, dict[str, Any]]:
    """OR → Recovery transfers whose billing is combined: {global_case_id: {admission_id, part, ids}}."""
    if not ids or database.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name='canopy_admission' AND column_name='billing_mode'"
    ).fetchone() is None:
        return {}
    rows = database.execute(
        """SELECT id, or_global_case_id::text AS or_id, global_case_id::text AS recovery_id FROM canopy_admission
           WHERE billing_mode='combined' AND or_global_case_id IS NOT NULL AND global_case_id IS NOT NULL
             AND or_global_case_id <> global_case_id
             AND (or_global_case_id::text = ANY(%s) OR global_case_id::text = ANY(%s))""", (ids, ids)).fetchall()
    out = {}
    for row in rows:
        group = {"admission_id": str(row["id"]), "ids": [row["or_id"], row["recovery_id"]]}
        out[row["or_id"]] = {**group, "part": "or"}
        out[row["recovery_id"]] = {**group, "part": "recovery"}
    return out


def _merge(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """One bill from the OR and Recovery orders (OR first)."""
    parts = sorted(parts, key=lambda row: 0 if row.get("_part") == "or" else 1)
    base = dict(parts[0])
    amounts = [row.get("total_amount") for row in parts if row.get("total_amount") is not None]
    starts = [row.get("anesthesia_start") for row in parts if row.get("anesthesia_start")]
    base.update({
        "combined": True,
        "status": "submitted" if all(row.get("status") == "submitted" for row in parts) else "draft",
        "item_count": sum(int(row.get("item_count") or 0) for row in parts),
        "total_amount": sum(float(value) for value in amounts) if amounts else None,
        "anesthesia_start": min(starts) if starts else base.get("anesthesia_start"),
        "order_updated_at": max(row.get("order_updated_at") or 0 for row in parts) or None,
        "leaf_name": " + ".join(filter(None, (row.get("leaf_name") or row.get("leaf_id") for row in parts))),
        "parts": [{"part": row.get("_part"), "global_case_id": str(row["global_case_id"]), "leaf_name": row.get("leaf_name"),
                   "status": row.get("status"), "item_count": row.get("item_count"), "total_amount": row.get("total_amount"),
                   "case_code": row.get("case_code")} for row in parts],
    })
    base.pop("_part", None)
    return base


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
    rows = [billing.row_dict(r) for r in rows]
    # OR + Recovery of one transfer with combined billing: one row (the other part is added even when filtered out).
    groups = _combined_groups(database, [str(row["global_case_id"]) for row in rows])
    out, seen = [], set()
    for row in rows:
        group = groups.get(str(row["global_case_id"]))
        if group is None:
            out.append(row)
            continue
        if group["admission_id"] in seen:
            continue
        seen.add(group["admission_id"])
        parts = database.execute(
            f"""SELECT b.*, coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name {ORDER_FROM}
                WHERE b.global_case_id::text = ANY(%s) AND {IN_SCOPE}""", (group["ids"], scope, scope)).fetchall()
        out.append(_merge([{**billing.row_dict(part), "_part": groups[str(part["global_case_id"])]["part"]} for part in parts]))
    return {"rows": out, "item_totals": [billing.row_dict(r) for r in totals]}


@router.get("/api/fleet/billing/orders/{global_case_id}")
def order(global_case_id: str, scope: list[str] | None = Depends(fleet_scope), database: Connection = Depends(connection)) -> dict:
    group = _combined_groups(database, [global_case_id]).get(global_case_id)
    ids = group["ids"] if group else [global_case_id]
    rows = database.execute(
        f"""SELECT b.*, coalesce(nullif(l.canopy_display_name,''),l.display_name) AS leaf_name {ORDER_FROM}
            WHERE b.global_case_id::text = ANY(%s) AND {IN_SCOPE}""", (ids, scope, scope)).fetchall()
    if not rows:
        raise HTTPException(404, "billing order not found")
    parts = {str(row["global_case_id"]): (_combined_groups(database, ids).get(str(row["global_case_id"])) or {}).get("part")
             for row in rows}
    items = database.execute(
        "SELECT * FROM canopy_case_billing_item WHERE global_case_id::text = ANY(%s) ORDER BY line_no", ([str(r["global_case_id"]) for r in rows],)
    ).fetchall()
    # Combined bill: OR lines first, then Recovery; each line says which part it came from.
    lines = sorted(({**billing.row_dict(r), "part": parts.get(str(r["global_case_id"]))} for r in items),
                   key=lambda line: (0 if line.get("part") in (None, "or") else 1, line.get("line_no") or 0))
    if len(rows) == 1:
        return {"order": billing.row_dict(rows[0]), "items": lines}
    return {"order": _merge([{**billing.row_dict(row), "_part": parts.get(str(row["global_case_id"]))} for row in rows]),
            "items": lines}
