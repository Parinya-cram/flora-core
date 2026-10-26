"""Medication orders + MAR, Leaf side (migration 0100, app/med_orders.py).

Doctors order (`med.order`), nurses verify and record doses (`case.chart`). A given dose writes the I/O row through
the io_write helpers (case_io_event for a discrete dose, a case_io_run drip + segment for an infusion start), and
case_med_admin keeps the link, so the chart and the I/O balance stay the single place doses live.
Drugs flagged `approval_required` need a doctor's staff PIN (app/staff_pin.py): `order` before the order makes slots
(status pending_approval), `admin` for each dose / infusion start. Everything is audited in case_clinical_audit.
Archived cases are read-only.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from psycopg import Connection, errors
from psycopg.types.json import Jsonb

from .. import form_schedule, med_orders as mo, staff_pin
from ..clinical import case_audit, insert, io_audit, number, text, timestamp, update
from ..database import connection
from .auth_leaf import current_user, now_ms, require_permission, service_only
from .cases_lifecycle import editable_case
from .io_write import create_event_internal, event_row, item as io_item, run_row, run_values, segment_values

router = APIRouter(prefix="/api/case", tags=["medication orders"])

CODING_SYSTEMS = {"TMT", "SNOMED_CT", "RXNORM", "ATC", "HIS", "LOCAL"}
PATCH_FIELDS = ("dose", "dose_unit", "route", "form", "schedule", "end_at", "duration_days", "instructions", "indication")


def minute(ts: int | None = None) -> int:
    return (ts if ts is not None else now_ms()) // 60000 * 60000


def audit(database: Connection, case_id: int, action: str, before: Any, after: Any, actor: dict) -> None:
    case_audit(database, case_id, action, mo.plain(before) if before is not None else None,
               mo.plain(after) if after is not None else None, actor)


def parse_uuid(value: Any, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise HTTPException(400, f"invalid {field}") from None


def case_exists(database: Connection, case_id: int) -> dict[str, Any]:
    row = database.execute("SELECT id, status, workflow, start_time FROM cases WHERE id=%s", (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    return row


def order_row(database: Connection, case_id: int, order_id: Any, lock: bool = False) -> dict[str, Any]:
    row = database.execute("SELECT * FROM case_med_order WHERE id=%s AND case_id=%s" + (" FOR UPDATE" if lock else ""),
                           (parse_uuid(order_id, "order_id"), case_id)).fetchone()
    if row is None:
        raise HTTPException(404, "order not found")
    return row


def admin_row(database: Connection, case_id: int, admin_id: Any, lock: bool = False) -> dict[str, Any]:
    row = database.execute("SELECT * FROM case_med_admin WHERE id=%s AND case_id=%s" + (" FOR UPDATE" if lock else ""),
                           (parse_uuid(admin_id, "admin_id"), case_id)).fetchone()
    if row is None:
        raise HTTPException(404, "administration not found")
    return row


def public_order(row: dict[str, Any]) -> dict[str, Any]:
    return mo.plain(dict(row))


# ---------------------------------------------------------------- catalogue

def item_codings(database: Connection, item_id: int) -> list[dict[str, Any]]:
    return [{"system": r["system_key"], "code": r["code"], "display": r["display"]} for r in database.execute(
        """SELECT c.system_key, c.code, c.display FROM io_item_master i
           JOIN clinical_concept_coding c ON c.concept_id = i.concept_id WHERE i.id=%s
           ORDER BY c.system_key, c.is_preferred DESC, c.code""", (item_id,)).fetchall()]


def med_item(database: Connection, item_id: Any) -> dict[str, Any]:
    try:
        key = int(item_id)
    except (TypeError, ValueError):
        raise HTTPException(400, "invalid item_id") from None
    row = database.execute("SELECT * FROM io_item_master WHERE id=%s AND kind='med'", (key,)).fetchone()
    if row is None:
        raise HTTPException(400, "item_id is not a medication in the catalogue")
    return row


def clean_codings(value: Any) -> list[dict[str, Any]]:
    out = []
    for coding in value if isinstance(value, list) else []:
        if isinstance(coding, dict) and str(coding.get("system") or "").upper() in CODING_SYSTEMS and text(coding.get("code")):
            out.append({"system": str(coding["system"]).upper(), "code": text(coding["code"]), "display": text(coding.get("display"))})
    return out


def merge_codings(*lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen, out = set(), []
    for coding in (c for group in lists for c in group):
        key = (coding["system"], coding["code"])
        if key not in seen:
            seen.add(key)
            out.append(coding)
    return out


@router.get("/med-catalog")
def med_catalog(q: str = "", limit: int = Query(30, ge=1, le=100), _: dict = Depends(require_permission("case.read")),
                database: Connection = Depends(connection)) -> dict[str, Any]:
    """Catalogue medications (io_item_master kind='med') matching the name, item code or any coding (TMT, SNOMED CT,
    ...), plus TMT reference entries (terminology_entry) not yet in the catalogue for a free-text order."""
    query = q.strip()
    like = f"%{query}%"
    items = database.execute(
        """SELECT i.id, i.code, i.name, i.default_unit, i.category, i.approval_required,
                  coalesce(jsonb_agg(jsonb_build_object('system', c.system_key, 'code', c.code, 'display', c.display)
                           ORDER BY c.system_key) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS codings
           FROM io_item_master i LEFT JOIN clinical_concept_coding c ON c.concept_id = i.concept_id
           WHERE i.kind='med' AND i.is_active=1
             AND (%s = '' OR i.name ILIKE %s OR i.code ILIKE %s OR EXISTS (
                  SELECT 1 FROM clinical_concept_coding x WHERE x.concept_id = i.concept_id AND (x.code ILIKE %s OR x.display ILIKE %s)))
           GROUP BY i.id ORDER BY i.usage_rank NULLS LAST, i.name LIMIT %s""",
        (query, like, like, like, like, limit)).fetchall()
    reference = []
    if len(query) >= 2:
        reference = database.execute(
            """SELECT e.code, e.display, e.display_th, e.metadata->>'level' AS level FROM terminology_entry e
               JOIN terminology_release r ON r.id = e.release_id AND r.status='active' AND r.system_key='TMT'
               WHERE e.is_active=1 AND (e.code ILIKE %s OR e.display ILIKE %s OR e.display_th ILIKE %s)
                 AND NOT EXISTS (SELECT 1 FROM clinical_concept_coding x WHERE x.system_key='TMT' AND x.code = e.code)
               ORDER BY length(e.display), e.display LIMIT 20""", (like, like, like)).fetchall()
    return {"query": query, "items": [dict(row) for row in items],
            "tmt": [{**dict(row), "codings": [{"system": "TMT", "code": row["code"], "display": row["display"]}]} for row in reference]}


# ---------------------------------------------------------------- staff PIN

@router.put("/staff-pin")
def set_own_pin(payload: dict = Body(...), user: dict = Depends(current_user), database: Connection = Depends(connection)) -> dict:
    """The signed-in user's own staff PIN `{pin, current_pin?}` (current_pin is required when one is set)."""
    if user.get("id") is None or user.get("must_change_password"):
        raise HTTPException(403, "sign in as a staff member")
    staff_id = user.get("staff_directory_id")
    if not staff_id:
        raise HTTPException(409, "staff_not_linked")
    pin = payload.get("pin")
    if not staff_pin.valid_pin(pin):
        raise HTTPException(400, "PIN must be 4-6 digits")
    row = database.execute("SELECT id, pin_hash FROM staff_directory WHERE id=%s", (staff_id,)).fetchone()
    if row is None:
        raise HTTPException(409, "staff_not_linked")
    if row["pin_hash"]:
        error = staff_pin.attempt(database, staff_id, payload.get("current_pin"))
        if error:
            raise staff_pin.http_error(error)
    with database.transaction():
        staff_pin.set_pin(database, staff_id, staff_pin.hash_pin(pin))
    return {"ok": True, "pin_set": True}


@router.get("/staff-pin")
def own_pin_state(user: dict = Depends(current_user), database: Connection = Depends(connection)) -> dict:
    staff_id = user.get("staff_directory_id")
    row = database.execute("SELECT pin_hash IS NOT NULL AS pin_set, pin_set_at, pin_locked_until FROM staff_directory WHERE id=%s",
                           (staff_id,)).fetchone() if staff_id else None
    return {"linked": row is not None, "pin_set": bool(row and row["pin_set"]), "pin_set_at": row and row["pin_set_at"],
            "locked_until": row["pin_locked_until"] if row and staff_pin.locked(row, now_ms()) else None}


@router.delete("/staff-pin/{staff_id}")
def reset_pin(staff_id: int, _: dict = Depends(require_permission("staff.manage")), database: Connection = Depends(connection)) -> dict:
    """Admin reset: clears the person's PIN (and lock); the reset syncs like a new PIN."""
    with database.transaction():
        if database.execute("SELECT 1 FROM staff_directory WHERE id=%s", (staff_id,)).fetchone() is None:
            raise HTTPException(404, "staff not found")
        staff_pin.set_pin(database, staff_id, None)
    return {"ok": True, "pin_set": False}


# ---------------------------------------------------------------- approvers

def case_doctors(database: Connection, case_id: int) -> list[dict[str, Any]]:
    return [dict(row) for row in database.execute(
        """SELECT cs.staff_code, cs.staff_name, cs.staff_role_id, r.display_name AS role, r.seniority
           FROM case_staff cs JOIN staff_role r ON r.id = cs.staff_role_id
           WHERE cs.case_id=%s AND r.staff_type='doctor'""", (case_id,)).fetchall()]


@router.get("/{case_id}/med-approvers")
def med_approvers(case_id: int, _: dict = Depends(require_permission("case.read")),
                  database: Connection = Depends(connection)) -> dict[str, Any]:
    """Staff who may confirm with their PIN on this case: the case owner, or doctors at least as senior."""
    case_exists(database, case_id)
    doctors = case_doctors(database, case_id)
    rows = database.execute(
        """SELECT s.id, s.staff_code, s.staff_name, s.staff_role, s.pin_hash IS NOT NULL AS has_pin, s.pin_locked_until,
                  coalesce(r.staff_type, 'other') AS staff_type, coalesce(r.seniority, 0) AS seniority
           FROM staff_directory s LEFT JOIN staff_role r ON r.id = s.staff_role_id
           WHERE s.is_active=1 AND coalesce(s.staff_code, '') <> '' ORDER BY r.seniority DESC NULLS LAST, s.staff_name""").fetchall()
    current = now_ms()
    owners = {mo.norm_code(d["staff_code"]) for d in mo.case_owners(doctors) if d.get("staff_code")}
    out = [{"staff_id": row["id"], "staff_code": row["staff_code"], "name": row["staff_name"], "role": row["staff_role"],
            "seniority": row["seniority"], "has_pin": bool(row["has_pin"]), "locked": staff_pin.locked(row, current),
            "is_owner": mo.norm_code(row["staff_code"]) in owners}
           for row in rows if mo.can_approve(row, doctors)]
    return {"owner_seniority": mo.owner_seniority(doctors), "owners": mo.case_owners(doctors), "approvers": out}


def verify_approver(database: Connection, case_id: int, approval: Any, actor: dict, context: dict[str, Any]) -> dict[str, Any]:
    """PIN -> lock -> doctor type -> seniority. Call outside the main transaction: failures are committed and audited."""
    if not isinstance(approval, dict):
        raise HTTPException(400, "approval_required")
    staff = staff_pin.staff_by_code(database, approval.get("staff_code"))
    detail = {**context, "staff_code": text(approval.get("staff_code"))}

    def failed(code: str) -> None:
        audit(database, case_id, "med_approval.failed", None, {**detail, "error": code}, actor)

    if staff is None:
        with database.transaction():
            failed("staff_not_found")
        raise staff_pin.http_error("staff_not_found")
    error = staff_pin.attempt(database, staff["id"], approval.get("pin"), failed)
    if error:
        raise staff_pin.http_error(error)
    if not mo.can_approve(staff, case_doctors(database, case_id)):
        with database.transaction():
            failed("not_authorized_level")
        raise staff_pin.http_error("not_authorized_level")
    return staff


def record_approval(database: Connection, case_id: int, order_id: Any, admin_id: Any, kind: str, staff: dict,
                    actor: dict, note: Any = None) -> dict[str, Any]:
    row = insert(database, "case_med_approval", dict(
        id=uuid.uuid4(), case_id=case_id, order_id=order_id, admin_id=admin_id, kind=kind, approver_staff_id=staff["id"],
        approver_code=staff["staff_code"], approver_name=staff["staff_name"], approver_role=staff["staff_role"],
        approved_at=now_ms(), recorded_by=actor["username"], note=text(note)))
    audit(database, case_id, f"med_approval.{kind}", None, row, actor)
    return mo.plain(row)


def activate(database: Connection, case_id: int, order: dict[str, Any], actor: dict) -> dict[str, Any]:
    current = now_ms()
    return update(database, "case_med_order", order["id"], {"status": "active", "activated_at": current,
                                                            "updated_at": current, "updated_by": actor["username"]})


# ---------------------------------------------------------------- orders

def order_values(database: Connection, payload: dict[str, Any], old: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validated order columns; `old` = PATCH (only PATCH_FIELDS change)."""
    source = {**(old or {}), **({k: payload[k] for k in PATCH_FIELDS if k in payload} if old else payload)}
    order_type = source.get("order_type")
    prn = bool(source.get("prn"))
    if order_type == "once" and prn:
        raise HTTPException(400, "a one-time order cannot be prn")
    schedule = source.get("schedule") or None
    issues = mo.schedule_issues(order_type, prn, schedule)
    if issues:
        raise HTTPException(400, "; ".join(issues))
    start = int(old["start_at"]) if old else timestamp(source.get("start_at"), "start_at", minute())
    end = timestamp(source.get("end_at"), "end_at")
    if end is not None and end <= start:
        raise HTTPException(400, "end_at must be after start_at")
    days = source.get("duration_days")
    if days in ("", None):
        days = None
    elif not (isinstance(days, int) and not isinstance(days, bool) and 1 <= days <= 365):
        raise HTTPException(400, "duration_days must be 1-365")
    route = text(source.get("route"))
    values = dict(dose=number(source.get("dose"), "dose", 0), dose_unit=text(source.get("dose_unit")),
                  route=route.upper() if route else None, form=text(source.get("form")),
                  schedule=Jsonb(mo.normalize_schedule(schedule)) if schedule else None,
                  end_at=end, duration_days=days, instructions=text(source.get("instructions")),
                  indication=text(source.get("indication")))
    if not old:
        values.update(order_type=order_type, prn=prn, start_at=start)
    return values


def new_order(database: Connection, case_id: int, payload: dict[str, Any], actor: dict, source: str = "leaf",
              item: dict | None = None, extra_codings: list | None = None) -> dict[str, Any]:
    if item is None and payload.get("item_id") not in (None, ""):
        item = med_item(database, payload["item_id"])
    name = text(payload.get("drug_name")) or (item or {}).get("name")
    if not name:
        raise HTTPException(400, "drug_name or item_id required")
    current = now_ms()
    flag = mo.approval_union((item or {}).get("approval_required"), payload.get("approval_required"))
    codings = merge_codings(item_codings(database, item["id"]) if item else [], clean_codings(payload.get("codings")), extra_codings or [])
    status = "pending_approval" if mo.needs_order_approval(flag) else "active"
    values = order_values(database, payload)
    if values["dose_unit"] is None and item:
        values["dose_unit"] = item.get("default_unit")
    row = insert(database, "case_med_order", dict(
        id=uuid.uuid4(), case_id=case_id, item_id=item["id"] if item else None, drug_name=name, codings=Jsonb(codings),
        **values, status=status, approval_required=flag, activated_at=current if status == "active" else None,
        source=source, his_ref=text(payload.get("his_ref")), his_state=None,
        ordered_by=text(payload.get("ordered_by")) if source == "his" else actor["username"],
        ordered_at=timestamp(payload.get("ordered_at"), "ordered_at", current) if source == "his" else current,
        updated_at=current, updated_by=actor["username"]))
    audit(database, case_id, "med_order.create", None, row, actor)
    return row


@router.post("/his/med-orders")
def his_med_orders(payload: dict = Body(...), actor: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    """HIS intake (sync worker / HIS adapter). Orders are upserted by `his_ref`, `source='his'`.

        {"hn": "123456", "an": "6801234",            # AN wins when given; the newest active case is used
         "orders": [{
            "his_ref": "ORD-991-1",                    # required, unique per case
            "drug_code": "1000123",                    # HIS drug code -> io_item_master.code, else billing_item.charge_code
            "tmt": "662401",                           #   -> io_item_master via billing_item.io_item_code, else TMT coding
            "drug_name": "Ceftriaxone 1 g inj",        # required when the drug is not mapped
            "order_type": "continue" | "once", "prn": false,
            "dose": 1, "dose_unit": "g", "route": "IV", "form": "inj",
            "schedule": {"kind": "every", "every_hours": 12, "anchor": "08:00"} | {"kind": "times", "times": [...]}
                        | {"kind": "infusion", "rate": 5, "rate_unit": "ml/h"} | null,
            "start_at": 1790000000000, "end_at": null, "duration_days": 7,
            "instructions": "...", "indication": "...",
            "status": "active" | "discontinued",       # discontinued stops the Leaf order
            "discontinue_reason": "...", "ordered_by": "D12345", "ordered_at": 1790000000000
         }]}

    -> {case_id, results: [{his_ref, status: created|updated|discontinued|rejected, id?, item_id?, reason?}]}
    """
    hn, an = text(payload.get("hn")), text(payload.get("an"))
    if not hn and not an:
        raise HTTPException(400, "hn or an required")
    case = database.execute(
        """SELECT id FROM cases WHERE status='active' AND (%s::text IS NOT NULL AND admission_number=%s OR %s::text IS NULL AND hn=%s)
           ORDER BY start_time DESC NULLS LAST, id DESC LIMIT 1""", (an, an, an, hn)).fetchone()
    if case is None:
        raise HTTPException(404, "case not found")
    case_id = case["id"]
    results = []
    for raw in payload.get("orders") or []:
        ref = text((raw or {}).get("his_ref")) if isinstance(raw, dict) else None
        if not ref:
            results.append({"his_ref": None, "status": "rejected", "reason": "his_ref required"})
            continue
        try:
            with database.transaction():
                editable_case(database, case_id)
                results.append(his_upsert(database, case_id, ref, raw, actor))
        except HTTPException as error:
            results.append({"his_ref": ref, "status": "rejected", "reason": str(error.detail)})
    return {"case_id": case_id, "results": results}


def his_item(database: Connection, drug_code: str | None, tmt: str | None) -> dict[str, Any] | None:
    if drug_code:
        row = database.execute("SELECT * FROM io_item_master WHERE kind='med' AND code=%s", (drug_code,)).fetchone()
        if row is None:
            row = database.execute(
                """SELECT i.* FROM billing_item b JOIN io_item_master i ON i.code = b.io_item_code AND i.kind='med'
                   WHERE b.charge_code=%s ORDER BY b.is_active DESC LIMIT 1""", (drug_code,)).fetchone()
        if row is not None:
            return row
    if tmt:
        return database.execute(
            """SELECT i.* FROM clinical_concept_coding c JOIN io_item_master i ON i.concept_id = c.concept_id AND i.kind='med'
               WHERE c.system_key='TMT' AND c.code=%s ORDER BY i.is_active DESC, i.id LIMIT 1""", (tmt,)).fetchone()
    return None


def his_upsert(database: Connection, case_id: int, ref: str, raw: dict[str, Any], actor: dict) -> dict[str, Any]:
    drug_code, tmt = text(raw.get("drug_code")), text(raw.get("tmt"))
    item = his_item(database, drug_code, tmt)
    extra = ([{"system": "HIS", "code": drug_code, "display": text(raw.get("drug_name"))}] if drug_code else []) + \
            ([{"system": "TMT", "code": tmt, "display": None}] if tmt else [])
    old = database.execute("SELECT * FROM case_med_order WHERE case_id=%s AND his_ref=%s FOR UPDATE", (case_id, ref)).fetchone()
    stop = raw.get("status") == "discontinued"
    if old is None:
        if stop:
            return {"his_ref": ref, "status": "rejected", "reason": "unknown order discontinued"}
        row = new_order(database, case_id, {**raw, "his_ref": ref}, actor, "his", item, extra)
        return {"his_ref": ref, "status": "created", "id": str(row["id"]), "item_id": row["item_id"]}
    if stop:
        if old["status"] in mo.OPEN_STATUSES:
            discontinue_row(database, case_id, old, raw.get("discontinue_reason") or "HIS", minute(), actor)
        return {"his_ref": ref, "status": "discontinued", "id": str(old["id"])}
    values = order_values(database, {**raw, "order_type": old["order_type"]}, {**old, "schedule": old["schedule"]})
    values.update(drug_name=text(raw.get("drug_name")) or old["drug_name"], item_id=item["id"] if item else old["item_id"],
                  codings=Jsonb(merge_codings(clean_codings(old["codings"]), extra)), updated_at=now_ms(), updated_by=actor["username"])
    row = update(database, "case_med_order", old["id"], values)
    audit(database, case_id, "med_order.his_update", old, row, actor)
    return {"his_ref": ref, "status": "updated", "id": str(row["id"]), "item_id": row["item_id"]}


@router.get("/{case_id}/med-orders")
def list_orders(case_id: int, _: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    case_exists(database, case_id)
    approvals = mo.approval_rows(database, case_id)
    return {"orders": [{**o, "approvals": [a for a in approvals if a["order_id"] == o["id"]]} for o in mo.order_rows(database, case_id)]}


@router.post("/{case_id}/med-orders")
def create_order(case_id: int, payload: dict = Body(...), actor: dict = Depends(require_permission("med.order")),
                 database: Connection = Depends(connection)) -> dict:
    """{item_id?, drug_name?, codings?, order_type, prn, dose, dose_unit, route, form, schedule, start_at, end_at,
    duration_days, instructions, indication, approval_required? (can only add to the drug's rule),
    approval?: {staff_code, pin} (approve a pending order in the same request)}"""
    staff = None
    if payload.get("approval"):
        case_exists(database, case_id)
        staff = verify_approver(database, case_id, payload["approval"], actor, {"kind": "order", "drug_name": text(payload.get("drug_name"))})
    with database.transaction():
        editable_case(database, case_id)
        row = new_order(database, case_id, payload, actor)
        if staff is not None and row["status"] == "pending_approval":
            record_approval(database, case_id, row["id"], None, "order", staff, actor, payload.get("approval", {}).get("note"))
            row = activate(database, case_id, row, actor)
    return {"ok": True, "order": public_order(row)}


@router.patch("/{case_id}/med-orders/{order_id}")
def patch_order(case_id: int, order_id: str, payload: dict = Body(...), actor: dict = Depends(require_permission("med.order")),
                database: Connection = Depends(connection)) -> dict:
    """Dose, unit, route, form, schedule, end_at, duration_days, instructions, indication. Another drug or order type
    is a new order (discontinue this one)."""
    with database.transaction():
        editable_case(database, case_id)
        old = order_row(database, case_id, order_id, lock=True)
        if old["status"] not in mo.OPEN_STATUSES:
            raise HTTPException(409, f"order is {old['status']}")
        row = update(database, "case_med_order", old["id"], {**order_values(database, payload, old), "updated_at": now_ms(),
                                                             "updated_by": actor["username"]})
        audit(database, case_id, "med_order.patch", old, row, actor)
    return {"ok": True, "order": public_order(row)}


def transition(database: Connection, case_id: int, order_id: str, actor: dict, action: str, change) -> dict:
    with database.transaction():
        editable_case(database, case_id)
        old = order_row(database, case_id, order_id, lock=True)
        row = change(old)
        audit(database, case_id, f"med_order.{action}", old, row, actor)
    return {"ok": True, "order": public_order(row)}


@router.post("/{case_id}/med-orders/{order_id}/hold")
def hold_order(case_id: int, order_id: str, payload: dict = Body(default={}), actor: dict = Depends(require_permission("med.order")),
               database: Connection = Depends(connection)) -> dict:
    def change(old):
        if old["status"] != "active":
            raise HTTPException(409, f"order is {old['status']}")
        holds = [*(old["holds"] or []), {"from": minute(), "to": None, "by": actor["username"], "reason": text(payload.get("reason"))}]
        return update(database, "case_med_order", old["id"], {"status": "held", "holds": Jsonb(holds), "updated_at": now_ms(),
                                                               "updated_by": actor["username"]})
    return transition(database, case_id, order_id, actor, "hold", change)


@router.post("/{case_id}/med-orders/{order_id}/resume")
def resume_order(case_id: int, order_id: str, actor: dict = Depends(require_permission("med.order")),
                 database: Connection = Depends(connection)) -> dict:
    def change(old):
        if old["status"] != "held":
            raise HTTPException(409, f"order is {old['status']}")
        holds = [dict(h) for h in old["holds"] or []]
        for hold in holds:
            if hold.get("to") is None:
                hold["to"] = minute()
        return update(database, "case_med_order", old["id"], {"status": "active", "holds": Jsonb(holds), "updated_at": now_ms(),
                                                               "updated_by": actor["username"]})
    return transition(database, case_id, order_id, actor, "resume", change)


def discontinue_row(database: Connection, case_id: int, old: dict[str, Any], reason: Any, at: int, actor: dict) -> dict[str, Any]:
    """Stop the order; drips it started stop at the same time (I/O audit)."""
    holds = [dict(h) for h in old["holds"] or []]
    for hold in holds:
        if hold.get("to") is None:
            hold["to"] = at
    row = update(database, "case_med_order", old["id"], {
        "status": "discontinued", "discontinued_at": max(at, int(old["start_at"])), "discontinued_by": actor["username"],
        "discontinue_reason": text(reason), "holds": Jsonb(holds), "updated_at": now_ms(), "updated_by": actor["username"]})
    for run in database.execute(
            """SELECT r.* FROM case_med_admin a JOIN case_io_run r ON r.id = a.io_run_id AND r.stopped_at IS NULL
               WHERE a.order_id=%s""", (old["id"],)).fetchall():
        after = update(database, "case_io_run", run["id"], {"stopped_at": max(int(run["started_at"]), at), "updated_at": now_ms()})
        io_audit(database, case_id, "run", run, after, actor, "medication order discontinued")
    if old["source"] == "his":
        audit(database, case_id, "med_order.discontinue", old, row, actor)
    return row


@router.post("/{case_id}/med-orders/{order_id}/discontinue")
def discontinue_order(case_id: int, order_id: str, payload: dict = Body(...), actor: dict = Depends(require_permission("med.order")),
                      database: Connection = Depends(connection)) -> dict:
    reason = text(payload.get("reason"))
    if not reason:
        raise HTTPException(400, "reason required")

    def change(old):
        if old["status"] not in mo.OPEN_STATUSES:
            raise HTTPException(409, f"order is {old['status']}")
        return discontinue_row(database, case_id, old, reason, timestamp(payload.get("at"), "at", minute()), actor)
    return transition(database, case_id, order_id, actor, "discontinue", change)


@router.post("/{case_id}/med-orders/{order_id}/verify")
def verify_order(case_id: int, order_id: str, actor: dict = Depends(require_permission("case.chart")),
                 database: Connection = Depends(connection)) -> dict:
    def change(old):
        if old["verified_at"]:
            return old
        return update(database, "case_med_order", old["id"], {"verified_by": actor["username"], "verified_at": now_ms()})
    return transition(database, case_id, order_id, actor, "verify", change)


@router.post("/{case_id}/med-orders/{order_id}/approve")
def approve(case_id: int, order_id: str, payload: dict = Body(...), actor: dict = Depends(require_permission("case.chart")),
            database: Connection = Depends(connection)) -> dict:
    """{staff_code, pin, kind: order|admin, admin_id?, note?}. Checks PIN, lock, doctor type, seniority (case owner or
    higher), then that the case is not archived. Errors: no_pin_set 409, pin_locked 423, pin_invalid 403,
    not_authorized_level 403, staff_not_found 404."""
    kind = payload.get("kind") or "order"
    if kind not in ("order", "admin"):
        raise HTTPException(400, "kind must be order or admin")
    order = order_row(database, case_id, order_id)
    staff = verify_approver(database, case_id, payload, actor, {"kind": kind, "order_id": str(order["id"]), "drug_name": order["drug_name"]})
    with database.transaction():
        editable_case(database, case_id)
        order = order_row(database, case_id, order_id, lock=True)
        if kind == "order":
            if order["status"] != "pending_approval":
                raise HTTPException(409, "order does not await approval")
            approval = record_approval(database, case_id, order["id"], None, "order", staff, actor, payload.get("note"))
            order = activate(database, case_id, order, actor)
            audit(database, case_id, "med_order.activate", None, order, actor)
        else:
            admin = admin_row(database, case_id, payload.get("admin_id"))
            if admin["order_id"] != order["id"]:
                raise HTTPException(400, "administration belongs to another order")
            approval = record_approval(database, case_id, order["id"], admin["id"], "admin", staff, actor, payload.get("note"))
    return {"ok": True, "order": public_order(order), "approval": approval}


# ---------------------------------------------------------------- MAR

def day_start_of(case: dict[str, Any]) -> str:
    value = (case.get("workflow") or {}).get("day_start")
    return value if mo.hhmm(value) else "00:00"


def default_window(case: dict[str, Any], tz_name: str, current: int) -> tuple[int, int]:
    zone = form_schedule.zone(tz_name)
    offset = form_schedule.minutes(day_start_of(case))
    local = form_schedule.local(current, zone)
    start = form_schedule.at_local(local.date(), offset, zone)
    if start > current:
        start = form_schedule.at_local(local.date() - timedelta(days=1), offset, zone)
    return start, start + form_schedule.DAY - 1


@router.get("/{case_id}/mar")
def mar(case_id: int, from_: int | None = Query(None, alias="from"), to: int | None = Query(None),
        _: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    """{timezone, day_start, from, to, now, grace_min, orders: [order + {slots: [{due_at, status, admin_id}],
    admins: [in the window], approvals, infusion: running drip | null}]}. Default window: the day (from the
    workflow's day_start, else midnight) that contains now."""
    case = case_exists(database, case_id)
    tz = form_schedule.timezone_of(database)
    current = now_ms()
    start, end = default_window(case, tz, current) if from_ is None else (int(from_), int(to) if to else int(from_) + form_schedule.DAY - 1)
    if end < start or end - start > 14 * form_schedule.DAY:
        raise HTTPException(400, "window must be 0-14 days")
    admins = mo.admin_rows(database, case_id)
    approvals = mo.approval_rows(database, case_id)
    running = {r["order_id"]: r for r in mo.running_infusions(database, case_id)}
    out = []
    for order in mo.order_rows(database, case_id):
        own = [a for a in admins if a["order_id"] == order["id"]]
        shown = [a for a in own if start <= (a.get("given_at") or a.get("due_at") or a["recorded_at"]) <= end]
        if order["status"] in ("discontinued", "completed") and not shown and (mo.effective_end(order) or end) < start:
            continue  # stopped before this day: nothing to show
        out.append({**order, "slots": mo.mar_slots(order, own, start, end, current, tz), "admins": shown,
                    "approvals": [a for a in approvals if a["order_id"] == order["id"]], "infusion": running.get(order["id"])})
    return {"timezone": tz, "day_start": day_start_of(case), "from": start, "to": end, "now": current,
            "grace_min": mo.GRACE_MIN, "orders": out}


def admin_values(payload: dict[str, Any], order: dict[str, Any], old: dict[str, Any] | None = None) -> dict[str, Any]:
    source = {**(old or {}), **payload}
    status = source.get("status")
    if status not in mo.ADMIN_STATUSES:
        raise HTTPException(400, "status must be given, held, refused, missed or not_given")
    given_at = timestamp(source.get("given_at"), "given_at", minute()) if status == "given" else None
    dose = number(source.get("dose"), "dose", 0)
    route = text(source.get("route"))
    return dict(status=status, given_at=given_at,
                dose=dose if dose is not None or old else (float(order["dose"]) if order.get("dose") is not None and status == "given" else None),
                dose_unit=text(source.get("dose_unit")) or (order.get("dose_unit") if status == "given" else None),
                route=(route.upper() if route else None) or (order.get("route") if status == "given" else None),
                site=text(source.get("site")), note=text(source.get("note")), witness_by=text(source.get("witness_by")))


def chart_dose(database: Connection, case_id: int, order: dict[str, Any], values: dict[str, Any], actor: dict) -> dict[str, Any]:
    """Write the I/O row for a given dose -> {io_event_id} or {io_run_id}; nothing when the drug is not in the catalogue."""
    if not order.get("item_id"):
        return {}
    if mo.is_infusion(order):
        schedule = order["schedule"]
        master = io_item(database, order["item_id"])
        run_payload = {"item_id": master["id"], "kind": master["kind"], "route": values["route"] or "IV", "started_at": values["given_at"],
                       "entry_mode": "drip", "note": values["note"]}
        run = insert(database, "case_io_run", dict(case_id=case_id, **run_values(run_payload, master), created_by=actor["username"],
                                                   created_at=now_ms()))
        io_audit(database, case_id, "run", None, run_row(database, run["id"]), actor, "MAR infusion start")
        segment = insert(database, "case_io_segment", dict(run_id=run["id"], **segment_values(
            {"ts_from": values["given_at"], "rate_value": schedule.get("rate"), "rate_unit": schedule.get("rate_unit"),
             "dose_value": values["dose"], "dose_unit": values["dose_unit"]}), created_by=actor["username"], created_at=now_ms()))
        io_audit(database, case_id, "segment", None, segment, actor, "MAR infusion start")
        return {"io_run_id": run["id"]}
    event = create_event_internal(database, case_id, {
        "item_id": order["item_id"], "kind": "med", "event_ts": values["given_at"], "dose_value": values["dose"],
        "dose_unit": values["dose_unit"], "route": values["route"], "note": values["note"], "include_in_balance": True,
        "reason": "MAR"}, actor)
    return {"io_event_id": event["id"]}


def void_io(database: Connection, case_id: int, admin: dict[str, Any], actor: dict, reason: str) -> None:
    """Remove the I/O row a dose wrote, the way io_write deletes events (audited)."""
    if admin.get("io_event_id"):
        old = event_row(database, admin["io_event_id"])
        if old and old["case_id"] == case_id:
            database.execute("DELETE FROM case_io_event WHERE id=%s", (old["id"],))
            io_audit(database, case_id, "event", old, None, actor, reason)
    if admin.get("io_run_id"):
        old = run_row(database, admin["io_run_id"])
        if old and old["case_id"] == case_id:
            for segment in database.execute("DELETE FROM case_io_segment WHERE run_id=%s RETURNING *", (old["id"],)).fetchall():
                io_audit(database, case_id, "segment", segment, None, actor, reason)
            database.execute("DELETE FROM case_io_run WHERE id=%s", (old["id"],))
            io_audit(database, case_id, "run", old, None, actor, reason)


def has_admin_approval(database: Connection, admin_id: Any) -> bool:
    return database.execute("SELECT 1 FROM case_med_approval WHERE admin_id=%s AND kind='admin'", (admin_id,)).fetchone() is not None


@router.post("/{case_id}/mar")
def record_admin(case_id: int, payload: dict = Body(...), actor: dict = Depends(require_permission("case.chart")),
                 database: Connection = Depends(connection)) -> dict:
    """{order_id, due_at|null, status, given_at, dose, dose_unit, route, site, note, witness_by,
    approval?: {staff_code, pin}} (approval is required to give a drug flagged admin/both)."""
    order = mo.plain(order_row(database, case_id, payload.get("order_id")))
    giving = payload.get("status") == "given"
    staff = None
    if giving and mo.needs_admin_approval(order["approval_required"]):
        if not payload.get("approval"):
            raise HTTPException(428, "approval_required")
        staff = verify_approver(database, case_id, payload["approval"], actor, {"kind": "admin", "order_id": order["id"],
                                                                                 "drug_name": order["drug_name"]})
    try:
        with database.transaction():
            editable_case(database, case_id)
            locked = order_row(database, case_id, order["id"], lock=True)
            order = mo.plain(locked)
            if order["status"] == "pending_approval":
                raise HTTPException(409, "order awaits approval")
            if giving and order["status"] != "active":
                raise HTTPException(409, f"order is {order['status']}")
            due_at = timestamp(payload.get("due_at"), "due_at")
            if due_at is not None and due_at not in mo.due_times(order, due_at, due_at, form_schedule.timezone_of(database)):
                raise HTTPException(400, "due_at is not a slot of this order")
            values = admin_values(payload, order)
            links = chart_dose(database, case_id, order, values, actor) if giving else {}
            row = insert(database, "case_med_admin", dict(id=uuid.uuid4(), order_id=locked["id"], case_id=case_id, due_at=due_at,
                                                           **values, **links, recorded_by=actor["username"], recorded_at=now_ms()))
            audit(database, case_id, "med_admin.create", None, row, actor)
            approval = record_approval(database, case_id, locked["id"], row["id"], "admin", staff, actor) if staff else None
            if giving and order["order_type"] == "once" and not mo.is_infusion(order):
                done = update(database, "case_med_order", locked["id"], {"status": "completed", "updated_at": now_ms(),
                                                                         "updated_by": actor["username"]})
                audit(database, case_id, "med_order.complete", locked, done, actor)
    except errors.UniqueViolation:
        raise HTTPException(409, "this slot is already recorded") from None
    return {"ok": True, "admin": mo.plain(row), "approval": approval}


@router.patch("/{case_id}/mar/{admin_id}")
def correct_admin(case_id: int, admin_id: str, payload: dict = Body(...), actor: dict = Depends(require_permission("case.chart")),
                  database: Connection = Depends(connection)) -> dict:
    """Correct a record (status, given_at, dose, dose_unit, route, site, note, witness_by); the linked I/O row
    follows. Changing to given on an approval drug needs `approval: {staff_code, pin}` unless already approved."""
    old = admin_row(database, case_id, admin_id)
    order = mo.plain(order_row(database, case_id, old["order_id"]))
    staff = None
    if payload.get("status") == "given" and old["status"] != "given" and mo.needs_admin_approval(order["approval_required"]) \
            and not has_admin_approval(database, old["id"]):
        if not payload.get("approval"):
            raise HTTPException(428, "approval_required")
        staff = verify_approver(database, case_id, payload["approval"], actor, {"kind": "admin", "order_id": order["id"],
                                                                                 "admin_id": str(old["id"])})
    with database.transaction():
        editable_case(database, case_id)
        old = admin_row(database, case_id, admin_id, lock=True)
        fields = {k: payload[k] for k in ("status", "given_at", "dose", "dose_unit", "route", "site", "note", "witness_by") if k in payload}
        values = admin_values(fields, order, mo.plain(old))
        links: dict[str, Any] = {}
        if old["status"] == "given" and values["status"] != "given":
            void_io(database, case_id, old, actor, "MAR correction")
            links = {"io_event_id": None, "io_run_id": None}
        elif values["status"] == "given" and old["status"] != "given":
            links = chart_dose(database, case_id, order, values, actor)
        elif values["status"] == "given":
            if old["io_event_id"]:
                before = event_row(database, old["io_event_id"])
                if before:
                    update(database, "case_io_event", before["id"], {"event_ts": values["given_at"], "dose_value": values["dose"],
                                                                      "dose_unit": values["dose_unit"], "note": values["note"],
                                                                      "updated_at": now_ms()})
                    io_audit(database, case_id, "event", before, event_row(database, before["id"]), actor, "MAR correction")
            if old["io_run_id"]:
                before = run_row(database, old["io_run_id"])
                if before and before["stopped_at"] is None or (before and before["stopped_at"] >= values["given_at"]):
                    update(database, "case_io_run", before["id"], {"started_at": values["given_at"], "updated_at": now_ms()})
                    database.execute("""UPDATE case_io_segment SET ts_from=%s WHERE id=(SELECT id FROM case_io_segment
                                        WHERE run_id=%s ORDER BY ts_from, id LIMIT 1)""", (values["given_at"], before["id"]))
                    io_audit(database, case_id, "run", before, run_row(database, before["id"]), actor, "MAR correction")
        row = update(database, "case_med_admin", old["id"], {**values, **links})
        audit(database, case_id, "med_admin.patch", old, row, actor)
        if staff:
            record_approval(database, case_id, old["order_id"], old["id"], "admin", staff, actor)
    return {"ok": True, "admin": mo.plain(row)}


@router.delete("/{case_id}/mar/{admin_id}")
def void_admin(case_id: int, admin_id: str, payload: dict = Body(default={}), actor: dict = Depends(require_permission("case.chart")),
               database: Connection = Depends(connection)) -> dict:
    """Void a record entered in error: its I/O row is deleted too (both audited); a completed one-time order reopens."""
    with database.transaction():
        editable_case(database, case_id)
        old = admin_row(database, case_id, admin_id, lock=True)
        void_io(database, case_id, old, actor, text(payload.get("reason")) or "MAR void")
        database.execute("DELETE FROM case_med_admin WHERE id=%s", (old["id"],))
        audit(database, case_id, "med_admin.void", {**old, "reason": text(payload.get("reason"))}, None, actor)
        order = order_row(database, case_id, old["order_id"], lock=True)
        if order["order_type"] == "once" and order["status"] == "completed" and old["status"] == "given":
            reopened = update(database, "case_med_order", order["id"], {"status": "active", "updated_at": now_ms(),
                                                                         "updated_by": actor["username"]})
            audit(database, case_id, "med_order.reopen", order, reopened, actor)
    return {"ok": True, "deleted": 1}
