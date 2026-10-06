"""Leaf side of Canopy admissions: the "Prepared patients" inbox and form sync.

The sync worker pulls `outbox` (forms of cases started from a Canopy admission)
and pushes `inbox` (admissions this Leaf may start, plus form changes made in
Canopy, e.g. pre-op filled on a tablet).
"""
import json
from typing import Any

from fastapi import APIRouter, Depends
from psycopg import Connection
from psycopg.types.json import Jsonb

from .. import form_sync
from ..clinical import case_audit
from ..database import connection
from .auth_leaf import now_ms, require_permission, service_only

router = APIRouter(prefix="/api/case", tags=["canopy admissions"])
SYNC_ACTOR = {"username": "canopy-sync", "role": "integration"}


def inbox_public(row: dict[str, Any]) -> dict[str, Any]:
    header = row.get("header") or {}
    values = row.get("form_values") or {}
    return {
        "id": str(row["id"]),
        "hn": header.get("hn"),
        "admissionNumber": header.get("admission_number"),
        "patient": header.get("patient") or {},
        "admission": header.get("admission") or {},
        "unitName": header.get("unit_name"),
        "targetLeafId": header.get("target_leaf_id"),
        "scheduledAt": header.get("scheduled_at"),
        "note": header.get("note"),
        "createdBy": header.get("created_by"),
        "formFieldCount": len([value for value in values.values() if value not in (None, "", [], {})]),
        "preopFilled": any(key.startswith("preop") and value not in (None, "", [], {}) for key, value in values.items()),
    }


@router.get("/canopy-admissions")
def canopy_admissions(_: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict:
    rows = database.execute(
        "SELECT * FROM canopy_admission_inbox WHERE status='pending' ORDER BY (header->>'scheduled_at')::bigint NULLS LAST, received_at"
    ).fetchall()
    return {"rows": [inbox_public(row) for row in rows]}


@router.get("/canopy-sync/outbox")
def outbox(_: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    cases = database.execute(
        """SELECT c.id, c.canopy_admission_id, c.status, c.case_code, c.start_time, c.discharge_time,
                  d.form_draft_json, d.field_versions
           FROM cases c LEFT JOIN case_detail d ON d.case_id=c.id
           WHERE c.canopy_admission_id IS NOT NULL
             AND (c.status<>'archived' OR c.archive_time > %s)""",
        (now_ms() - 24 * 3600 * 1000,),
    ).fetchall()
    claims = database.execute(
        "SELECT id, case_id FROM canopy_admission_inbox WHERE status='claimed' AND NOT claim_acknowledged"
    ).fetchall()
    return {
        "cases": [{
            "admission_id": str(row["canopy_admission_id"]), "case_id": row["id"], "status": row["status"],
            "case_code": row["case_code"], "start_time": row["start_time"], "discharge_time": row["discharge_time"],
            "values": form_sync.parse(row["form_draft_json"]), "versions": row["field_versions"] or {},
        } for row in cases],
        "claims": [{"admission_id": str(row["id"]), "case_id": row["case_id"]} for row in claims],
    }


@router.put("/canopy-sync/inbox")
def inbox(payload: dict[str, Any], _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict:
    current = now_ms()
    pending = [item for item in payload.get("pending") or [] if isinstance(item, dict) and item.get("id")]
    received, updated_forms = 0, 0
    with database.transaction():
        for item in pending:
            existing = database.execute(
                "SELECT * FROM canopy_admission_inbox WHERE id=%s FOR UPDATE", (item["id"],)
            ).fetchone()
            if existing and existing["status"] == "claimed":
                continue
            values, versions = item.get("form_values") or {}, item.get("form_versions") or {}
            database.execute(
                """INSERT INTO canopy_admission_inbox(id,header,form_values,form_versions,status,received_at,updated_at)
                   VALUES (%s,%s,%s,%s,'pending',%s,%s)
                   ON CONFLICT(id) DO UPDATE SET header=excluded.header,form_values=excluded.form_values,
                     form_versions=excluded.form_versions,status='pending',updated_at=excluded.updated_at""",
                (item["id"], Jsonb(item.get("header") or {}), Jsonb(values), Jsonb(versions), current, current),
            )
            received += 1
        # Cancelled in Canopy, or started at another Leaf of the ward.
        withdrawn = database.execute(
            """UPDATE canopy_admission_inbox SET status='withdrawn',updated_at=%s
               WHERE status='pending' AND NOT (id::text = ANY(%s)) RETURNING id""",
            (current, [str(item["id"]) for item in pending]),
        ).fetchall()
        for admission_id in payload.get("acknowledged") or []:
            database.execute(
                "UPDATE canopy_admission_inbox SET claim_acknowledged=true,updated_at=%s WHERE id::text=%s",
                (current, str(admission_id)),
            )
        # Form changes made in Canopy for cases running here.
        for item in payload.get("linked") or []:
            case = database.execute(
                "SELECT id,status FROM cases WHERE canopy_admission_id::text=%s", (str(item.get("admission_id")),)
            ).fetchone()
            if case is None or case["status"] == "archived":
                continue
            row = database.execute(
                "SELECT form_draft_json,field_versions FROM case_detail WHERE case_id=%s FOR UPDATE", (case["id"],)
            ).fetchone()
            old = form_sync.parse(row and row["form_draft_json"])
            values, versions, changed = form_sync.merge(
                old, (row or {}).get("field_versions") or {}, item.get("values") or {}, item.get("versions") or {})
            if not changed and row and versions == (row.get("field_versions") or {}):
                continue
            database.execute(
                """INSERT INTO case_detail(case_id,created_at,updated_at,form_draft_json,field_versions) VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT(case_id) DO UPDATE SET updated_at=excluded.updated_at,form_draft_json=excluded.form_draft_json,
                     field_versions=excluded.field_versions""",
                (case["id"], current, current, json.dumps(values), Jsonb(versions)),
            )
            if changed:
                case_audit(database, case["id"], "form.draft.canopy", old, values, SYNC_ACTOR)
                updated_forms += 1
    return {"ok": True, "received": received, "withdrawn": [str(row["id"]) for row in withdrawn],
            "updated_forms": updated_forms}
