"""Leaf: the OR billing checklist of a case (see app/billing.py)."""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import billing, billing_templates
from ..clinical import case_audit, text, timestamp
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .cases_lifecycle import editable_case

router = APIRouter(prefix="/api/case", tags=["billing"])


@router.get("/billing/catalog")
def catalog(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    """Active billing groups and items (master data synced from Canopy)."""
    held = database.execute("SELECT billing_catalog_version FROM auth_directory_state WHERE id=1").fetchone()
    return {**billing.load_catalog(database, active_only=True),
            "synced_version": int((held or {}).get("billing_catalog_version") or 0)}


@router.get("/{case_id}/billing")
def read_order(case_id: int, _: dict = Depends(require_permission("case.read")),
               database: Connection = Depends(connection)) -> dict:
    if not database.execute("SELECT 1 FROM cases WHERE id=%s", (case_id,)).fetchone():
        raise HTTPException(404, "case not found")
    return {**billing.order_payload(database, case_id), "defaults": billing.chart_defaults(database, case_id),
            "template": case_template(database, case_id)}


def case_template(database: Connection, case_id: int) -> dict[str, Any] | None:
    """The itemize template of the case's workflow: the Leaf's newest published copy, else the copy
    taken when the case started; a case without a workflow uses the ward's default workflow."""
    from .case_workflow import cached_billing_template, cached_items
    row = database.execute("SELECT workflow FROM cases WHERE id=%s", (case_id,)).fetchone()
    workflow = (row or {}).get("workflow") if isinstance((row or {}).get("workflow"), dict) else None
    if workflow is None:
        items, _forms, _synced = cached_items(database)
        default = next((item["definition"] for item in items if item.get("isDefault")), None)
        workflow = default
    template_id = billing_templates.template_id_of(workflow)
    return cached_billing_template(database, template_id) or (workflow or {}).get("bundled_billing_template")


def _signers(raw: Any) -> list[dict[str, Any]]:
    out = []
    for signer in raw if isinstance(raw, list) else []:
        if isinstance(signer, dict) and signer.get("role") in billing.SIGNER_ROLES and text(signer.get("name")):
            out.append({"role": signer["role"], "name": text(signer.get("name"))[:160],
                        **({"staff_id": signer["staff_id"]} if signer.get("staff_id") else {})})
    return out


@router.put("/{case_id}/billing")
def save_order(case_id: int, payload: dict = Body(...), actor: dict = Depends(require_permission("case.chart")),
               database: Connection = Depends(connection)) -> dict:
    """Save the checklist: header fields plus the full list of ticked lines (replaces the lines)."""
    now = now_ms()
    with database.transaction():
        editable_case(database, case_id)
        order = billing.ensure_order(database, case_id, actor["username"], now)
        if order["status"] == "submitted":
            raise HTTPException(409, "billing was submitted; reopen it to make changes")
        try:
            lines = billing.normalise_lines(database, payload.get("items") or [])
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        before = billing.order_payload(database, case_id)
        header = {key: timestamp(payload.get(key), key) for key in ("anesthesia_start", "anesthesia_end", "surgery_start", "surgery_end")}
        database.execute(
            """UPDATE case_billing_order SET anesthesia_start=%s,anesthesia_end=%s,surgery_start=%s,surgery_end=%s,
                 discharge_location=%s,signers=%s,note=%s,updated_by=%s,updated_at=%s WHERE id=%s""",
            (header["anesthesia_start"], header["anesthesia_end"], header["surgery_start"], header["surgery_end"],
             (text(payload.get("discharge_location")) or None), Jsonb(_signers(payload.get("signers"))),
             (text(payload.get("note")) or None), actor["username"], now, order["id"]))
        database.execute("DELETE FROM case_billing_order_item WHERE order_id=%s", (order["id"],))
        for number, line in enumerate(lines, start=1):
            database.execute(
                """INSERT INTO case_billing_order_item(case_id,order_id,line_no,item_code,group_code,name,variant,qty,unit,
                     qty_mode,unit_price,charge_code,source,note,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (case_id, order["id"], number, line["item_code"], line["group_code"], line["name"], line["variant"],
                 line["qty"], line["unit"], line["qty_mode"], line["unit_price"], line["charge_code"], line["source"],
                 line["note"], now, now))
        after = billing.order_payload(database, case_id)
        case_audit(database, case_id, "billing.save", _audit_view(before), _audit_view(after), actor)
    return after


def _audit_view(payload: dict[str, Any]) -> dict[str, Any] | None:
    if not payload.get("order"):
        return None
    return {"status": payload["order"]["status"],
            "items": [[i["item_code"] or i["name"], i["variant"], i["qty"]] for i in payload["items"]]}


def _set_status(database: Connection, case_id: int, actor: dict, to_status: str, from_status: str) -> dict:
    now = now_ms()
    with database.transaction():
        editable_case(database, case_id)
        order = billing.live_order(database, case_id)
        if not order:
            raise HTTPException(404, "no billing for this case yet")
        if order["status"] != from_status:
            raise HTTPException(409, f"billing is {order['status']}")
        if to_status == "submitted":
            if not database.execute("SELECT 1 FROM case_billing_order_item WHERE order_id=%s", (order["id"],)).fetchone():
                raise HTTPException(400, "tick at least one item before submitting")
            database.execute("""UPDATE case_billing_order SET status='submitted',submitted_at=%s,submitted_by=%s,
                                  updated_by=%s,updated_at=%s WHERE id=%s""",
                             (now, actor["username"], actor["username"], now, order["id"]))
        else:
            database.execute("""UPDATE case_billing_order SET status='draft',submitted_at=NULL,submitted_by=NULL,
                                  updated_by=%s,updated_at=%s WHERE id=%s""", (actor["username"], now, order["id"]))
        case_audit(database, case_id, f"billing.{'submit' if to_status == 'submitted' else 'reopen'}",
                   {"status": from_status}, {"status": to_status}, actor)
    return billing.order_payload(database, case_id)


@router.post("/{case_id}/billing/submit")
def submit(case_id: int, actor: dict = Depends(require_permission("case.chart")), database: Connection = Depends(connection)) -> dict:
    return _set_status(database, case_id, actor, "submitted", "draft")


@router.post("/{case_id}/billing/reopen")
def reopen(case_id: int, actor: dict = Depends(require_permission("case.chart")), database: Connection = Depends(connection)) -> dict:
    return _set_status(database, case_id, actor, "draft", "submitted")
