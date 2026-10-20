"""OR billing checklist ("Anesthesia Check List (Billing)").

Master data (billing_group, billing_item) is owned by Canopy and travels to every Leaf
with the directory exchange, like the I/O catalogue (io_catalog.py): the Leaf upserts
by code and never deletes, so every order that references an item keeps its meaning.

A Leaf keeps one live order per case (case_billing_order + case_billing_order_item).
It reaches Canopy in the case snapshot under "billing"; sync ingest projects it into
canopy_case_billing / canopy_case_billing_item for billing staff (project_snapshot).
"""
import json
import uuid
from decimal import Decimal
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from . import concepts

GROUP_FIELDS = ("code", "name", "form_column", "sort_order", "is_active")
ITEM_FIELDS = ("code", "group_code", "name", "unit", "qty_mode", "variant_label", "io_item_code", "charge_code",
               "unit_price", "sort_order", "is_active")
SIGNER_ROLES = ("surgeon", "anesthesiologist", "nurse1", "nurse2")


def plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    return value


def row_dict(row: Any) -> dict[str, Any]:
    return {key: plain(value) for key, value in dict(row).items()}


# ---------------------------------------------------------------- master data
def load_catalog(database: Connection, active_only: bool = False) -> dict[str, Any]:
    """The whole master plus a version (latest change). Canopy sends this to Leafs."""
    where = "WHERE is_active=1" if active_only else ""
    groups = database.execute(f"SELECT {','.join(GROUP_FIELDS)},updated_at FROM billing_group {where} ORDER BY form_column,sort_order,code").fetchall()
    items = database.execute(
        f"""SELECT {','.join('i.' + f for f in ITEM_FIELDS)},i.updated_at FROM billing_item i
            LEFT JOIN billing_group g ON g.code=i.group_code {where.replace('is_active', 'i.is_active')}
            ORDER BY g.form_column,g.sort_order,i.sort_order,i.code""").fetchall()
    version = max([int(row["updated_at"] or 0) for row in [*groups, *items]] or [0])
    return {"version": version, "groups": [row_dict(r) for r in groups], "items": [row_dict(r) for r in items]}


def apply_catalog(database: Connection, catalog: dict[str, Any], current_version: int) -> int:
    """Leaf side: upsert a newer master by code. Returns the version now held."""
    version = int(catalog.get("version") or 0)
    if version <= current_version:
        return current_version
    with database.transaction():
        for group in catalog.get("groups") or []:
            stamp = int(group.get("updated_at") or version)
            database.execute(
                """INSERT INTO billing_group(code,name,form_column,sort_order,is_active,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (code) DO UPDATE SET name=excluded.name,form_column=excluded.form_column,
                     sort_order=excluded.sort_order,is_active=excluded.is_active,updated_at=excluded.updated_at""",
                (group["code"], group["name"], int(group.get("form_column") or 1), int(group.get("sort_order") or 0),
                 int(group.get("is_active", 1)), stamp, stamp))
        for item in catalog.get("items") or []:
            stamp = int(item.get("updated_at") or version)
            values = [item.get(field) for field in ITEM_FIELDS]
            database.execute(
                f"""INSERT INTO billing_item({','.join(ITEM_FIELDS)},created_at,updated_at)
                    VALUES ({','.join(['%s'] * len(ITEM_FIELDS))},%s,%s)
                    ON CONFLICT (code) DO UPDATE SET {','.join(f'{f}=excluded.{f}' for f in ITEM_FIELDS if f != 'code')},
                      updated_at=excluded.updated_at""",
                (*values, stamp, stamp))
        database.execute("UPDATE auth_directory_state SET billing_catalog_version=%s WHERE id=1", (version,))
    return version


# ---------------------------------------------------------------- Leaf: one order per case
def live_order(database: Connection, case_id: int) -> dict[str, Any] | None:
    row = database.execute("SELECT * FROM case_billing_order WHERE case_id=%s AND status<>'void' ORDER BY id DESC LIMIT 1",
                           (case_id,)).fetchone()
    return row_dict(row) if row else None


def order_lines(database: Connection, order_id: int) -> list[dict[str, Any]]:
    rows = database.execute("SELECT * FROM case_billing_order_item WHERE order_id=%s ORDER BY line_no", (order_id,)).fetchall()
    return [row_dict(r) for r in rows]


def amount(line: dict[str, Any]) -> float | None:
    price = line.get("unit_price")
    if price is None:
        return None
    qty = 1 if line.get("qty_mode") == "used" else float(line.get("qty") or 0)
    return round(float(price) * qty, 2)


def order_payload(database: Connection, case_id: int) -> dict[str, Any]:
    """The case's order as the Leaf UI, the snapshot and Canopy see it."""
    order = live_order(database, case_id)
    if not order:
        return {"order": None, "items": [], "total_amount": None}
    lines = order_lines(database, order["id"])
    for line in lines:
        line["amount"] = amount(line)
    priced = [line["amount"] for line in lines if line["amount"] is not None]
    order["order_uuid"] = str(order["order_uuid"])
    return {"order": order, "items": lines, "total_amount": round(sum(priced), 2) if priced else None}


def ensure_order(database: Connection, case_id: int, actor: str | None, now: int) -> dict[str, Any]:
    order = live_order(database, case_id)
    if order:
        return order
    row = database.execute(
        """INSERT INTO case_billing_order(case_id,order_uuid,status,created_by,created_at,updated_by,updated_at)
           VALUES (%s,%s,'draft',%s,%s,%s,%s) RETURNING *""",
        (case_id, str(uuid.uuid4()), actor, now, actor, now)).fetchone()
    return row_dict(row)


def normalise_lines(database: Connection, raw_lines: list[Any]) -> list[dict[str, Any]]:
    """Validate submitted lines against the master; snapshot name, unit and price."""
    items = {row["code"]: row_dict(row) for row in database.execute("SELECT * FROM billing_item").fetchall()}
    groups = {row["code"] for row in database.execute("SELECT code FROM billing_group").fetchall()}
    lines: list[dict[str, Any]] = []
    for raw in raw_lines:
        if not isinstance(raw, dict):
            continue
        code = (str(raw.get("item_code") or "").strip()) or None
        master = items.get(code) if code else None
        if code and not master:
            raise ValueError(f"unknown billing item {code}")
        qty_mode = master["qty_mode"] if master else "count"
        try:
            qty = float(raw.get("qty") if raw.get("qty") not in (None, "") else (1 if qty_mode == "used" else 0))
        except (TypeError, ValueError):
            raise ValueError(f"invalid quantity for {code or raw.get('name')}")
        if qty < 0 or qty > 100000:
            raise ValueError(f"invalid quantity for {code or raw.get('name')}")
        if qty == 0 and qty_mode != "used":
            continue  # unticked / empty lines are not stored
        name = master["name"] if master else str(raw.get("name") or "").strip()
        group_code = master["group_code"] if master else str(raw.get("group_code") or "").strip()
        # A free-text line may sit in a master group or in a group of the case's itemize template.
        if not name or not group_code or (master is None and len(group_code) > 80):
            raise ValueError("a free-text line needs a name and a group")
        if master is not None and group_code not in groups:
            raise ValueError(f"item {code} has an unknown group")
        lines.append({
            "item_code": code, "group_code": group_code, "name": name[:200],
            "variant": (str(raw.get("variant") or "").strip() or None),
            "qty": round(qty, 2), "unit": master.get("unit") if master else (raw.get("unit") or None), "qty_mode": qty_mode,
            "unit_price": master.get("unit_price") if master else None, "charge_code": master.get("charge_code") if master else None,
            "source": "io_suggestion" if raw.get("source") == "io_suggestion" else "manual",
            "note": (str(raw.get("note") or "").strip() or None),
        })
    return lines


# ---------------------------------------------------------------- Leaf: pre-fill from the chart
TECHNIQUE_FROM_FORM = {
    "General anesthesia": "tq-ga", "Spinal anesthesia": "tq-ra", "Epidural anesthesia": "tq-ra",
    "Peripheral nerve block": "tq-ra", "Truncal block": "tq-ra", "Conscious sedation/MAC": "tq-mac",
}
EVENT_TIMES = {"Start Anesthesia": "anesthesia_start", "End Anesthesia": "anesthesia_end",
               "Start Surgery": "surgery_start", "End Surgery": "surgery_end"}


def chart_defaults(database: Connection, case_id: int) -> dict[str, Any]:
    """What the chart already knows: times, signers, technique, discharge location, I/O used."""
    times: dict[str, int] = {}
    for row in database.execute(
            """SELECT title,event_ts FROM case_event_note WHERE case_id=%s AND is_deleted=0 AND title = ANY(%s)
               ORDER BY event_ts""", (case_id, list(EVENT_TIMES))).fetchall():
        key = EVENT_TIMES[row["title"]]
        if key.endswith("_start"):
            times.setdefault(key, int(row["event_ts"]))
        else:
            times[key] = int(row["event_ts"])  # the last end wins

    staff = database.execute("SELECT staff_role_id,staff_name,id FROM case_staff WHERE case_id=%s ORDER BY seq,id", (case_id,)).fetchall()
    def first(role_ids: tuple[str, ...], skip: int = 0) -> dict[str, Any] | None:
        hits = [s for s in staff if (s["staff_role_id"] or "") in role_ids and s["staff_name"]]
        return {"name": hits[skip]["staff_name"], "staff_id": hits[skip]["id"]} if len(hits) > skip else None
    signers = []
    for role, picked in (("surgeon", first(("surgeon",))),
                         ("anesthesiologist", first(("anesthetist", "fellowAnesthetist", "anesthetistResident"))),
                         ("nurse1", first(("nurseAnesthetist",))), ("nurse2", first(("nurseAnesthetist",), 1))):
        if picked:
            signers.append({"role": role, **picked})

    form: dict[str, Any] = {}
    detail = database.execute("SELECT form_draft_json FROM case_detail WHERE case_id=%s", (case_id,)).fetchone()
    if detail and detail["form_draft_json"]:
        try:
            form = json.loads(detail["form_draft_json"]) if isinstance(detail["form_draft_json"], str) else dict(detail["form_draft_json"])
        except (ValueError, TypeError):
            form = {}
    techniques = sorted({TECHNIQUE_FROM_FORM[t] for t in concepts.draft_value(form, "anesthesia.technique") or [] if t in TECHNIQUE_FROM_FORM})

    # Doses charted in I/O (bolus entries, plus each drip run), matched through io_item_code.
    suggestions = []
    for row in database.execute(
            """SELECT b.code, b.name, b.qty_mode, m.name AS io_name,
                      count(DISTINCT e.id) AS doses, count(DISTINCT r.id) AS runs
               FROM billing_item b
               JOIN io_item_master m ON m.code = b.io_item_code
               LEFT JOIN case_io_event e ON e.item_id = m.id AND e.case_id = %s
               LEFT JOIN case_io_run r ON r.item_id = m.id AND r.case_id = %s AND r.entry_mode = 'drip'
               WHERE b.is_active=1
               GROUP BY b.code, b.name, b.qty_mode, m.name
               HAVING count(DISTINCT e.id) + count(DISTINCT r.id) > 0""", (case_id, case_id)).fetchall():
        uses = int(row["doses"] or 0) + int(row["runs"] or 0)
        suggestions.append({"item_code": row["code"], "qty": uses,
                            "reason": f"{row['io_name']}: {uses} entr{'y' if uses == 1 else 'ies'} in I/O"})
    return {**times, "signers": signers, "techniques": techniques,
            "discharge_location": form.get("postoperativeDestination") or None, "suggestions": suggestions}


# ---------------------------------------------------------------- Canopy: structured copy
def project_snapshot(database: Connection, global_case_id: Any, leaf_id: str, source_case_id: str,
                     payload: dict[str, Any], revision: int, now: int) -> None:
    """Keep canopy_case_billing in step with the newest snapshot that carries billing."""
    billing = payload.get("billing")
    if not isinstance(billing, dict):
        return  # an older Leaf: leave what Canopy has
    order = billing.get("order")
    held = database.execute("SELECT revision FROM canopy_case_billing WHERE global_case_id=%s", (str(global_case_id),)).fetchone()
    if held and int(held["revision"]) > revision:
        return
    if not order:
        database.execute("DELETE FROM canopy_case_billing WHERE global_case_id=%s", (str(global_case_id),))
        return
    case = payload.get("case") or {}
    patient = payload.get("patient") or {}
    if isinstance(patient, dict) and isinstance(patient.get("row"), dict):
        patient = patient["row"]
    lines = billing.get("items") or []
    database.execute(
        """INSERT INTO canopy_case_billing(global_case_id,leaf_id,source_case_id,order_uuid,case_code,hn,an,patient_name,
             case_status,status,anesthesia_start,anesthesia_end,surgery_start,surgery_end,discharge_location,signers,
             item_count,total_amount,submitted_at,submitted_by,order_updated_at,revision,synced_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (global_case_id) DO UPDATE SET leaf_id=excluded.leaf_id,source_case_id=excluded.source_case_id,
             order_uuid=excluded.order_uuid,case_code=excluded.case_code,hn=excluded.hn,an=excluded.an,
             patient_name=excluded.patient_name,case_status=excluded.case_status,status=excluded.status,
             anesthesia_start=excluded.anesthesia_start,anesthesia_end=excluded.anesthesia_end,
             surgery_start=excluded.surgery_start,surgery_end=excluded.surgery_end,
             discharge_location=excluded.discharge_location,signers=excluded.signers,item_count=excluded.item_count,
             total_amount=excluded.total_amount,submitted_at=excluded.submitted_at,submitted_by=excluded.submitted_by,
             order_updated_at=excluded.order_updated_at,revision=excluded.revision,synced_at=excluded.synced_at""",
        (str(global_case_id), leaf_id, str(source_case_id), order.get("order_uuid"), case.get("case_code"), case.get("hn"),
         patient.get("an") or case.get("admission_number"),
         patient.get("patient_name") or " ".join(p for p in (patient.get("first_name"), patient.get("last_name")) if p) or None,
         str(case.get("status") or "").upper() or None, order.get("status") or "draft",
         order.get("anesthesia_start"), order.get("anesthesia_end"), order.get("surgery_start"), order.get("surgery_end"),
         order.get("discharge_location"), Jsonb(order.get("signers") or []), len(lines), billing.get("total_amount"),
         order.get("submitted_at"), order.get("submitted_by"), order.get("updated_at"), revision, now))
    database.execute("DELETE FROM canopy_case_billing_item WHERE global_case_id=%s", (str(global_case_id),))
    for line in lines:
        database.execute(
            """INSERT INTO canopy_case_billing_item(global_case_id,line_no,item_code,group_code,name,variant,qty,unit,
                 qty_mode,unit_price,amount,charge_code,source) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (str(global_case_id), int(line.get("line_no") or 0), line.get("item_code"), line.get("group_code"),
             line.get("name") or "", line.get("variant"), line.get("qty") or 0, line.get("unit"), line.get("qty_mode"),
             line.get("unit_price"), line.get("amount"), line.get("charge_code"), line.get("source")))
