"""Documents attached to a case on Flora Leaf (0092): pages put together in the assembly workspace, kept with the case
as one PDF (offline too) and sent to Canopy once by the sync worker. A document is removed with a reason, never
deleted: the removal reaches Canopy as well (its details only; the file is not sent again).

POST /api/case/{id}/documents?title=&pages= takes the PDF as the request body (app/request_body.py), not as base64."""
from __future__ import annotations

import hashlib
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from psycopg import Connection
from pydantic import BaseModel, Field

from ..clinical import case_audit
from ..database import connection
from ..request_body import read_limited
from .auth_leaf import now_ms, require_permission, service_only

router = APIRouter(tags=["case documents"])
MAX_BYTES = 30 * 1024 * 1024
COLUMNS = "id, case_id, title, pages, bytes, sha256, created_at, created_by, removed_at, removed_by, removed_reason, synced_at, sync_error"


class Removal(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


def _case(database: Connection, case_id: int) -> dict[str, Any]:
    row = database.execute("SELECT id, status FROM cases WHERE id=%s", (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "case not found")
    return row


@router.get("/api/case/{case_id}/documents")
def list_documents(case_id: int, _: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> dict[str, Any]:
    _case(database, case_id)
    rows = database.execute(f"SELECT {COLUMNS} FROM case_document WHERE case_id=%s ORDER BY created_at, id", (case_id,)).fetchall()
    return {"documents": rows}


async def pdf_body(request: Request) -> bytes:
    """The request body: one PDF of at most MAX_BYTES."""
    content = await read_limited(request, MAX_BYTES)
    if content[:5] != b"%PDF-":
        raise HTTPException(422, "the body is the PDF itself (Content-Type: application/pdf)")
    return content


@router.post("/api/case/{case_id}/documents")
def attach_document(case_id: int, title: str = Query(min_length=1, max_length=200), pages: int = Query(ge=1, le=500),
                    content: bytes = Depends(pdf_body), actor: dict = Depends(require_permission("case.chart")),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    case = _case(database, case_id)
    if case["status"] == "archived":
        raise HTTPException(409, "archived case is read-only")
    with database.transaction():
        row = database.execute(
            f"""INSERT INTO case_document (case_id, title, pages, bytes, sha256, content, created_at, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING {COLUMNS}""",
            (case_id, title.strip(), pages, len(content), hashlib.sha256(content).hexdigest(), content, now_ms(),
             actor.get("username"))).fetchone()
        case_audit(database, case_id, "document.attach", None, {"document": row["id"], "title": row["title"], "pages": row["pages"]}, actor)
    return {"document": row}


@router.get("/api/case/{case_id}/documents/{document_id}/file")
def document_file(case_id: int, document_id: int, _: dict = Depends(require_permission("case.read")), database: Connection = Depends(connection)) -> Response:
    row = database.execute("SELECT title, content FROM case_document WHERE case_id=%s AND id=%s", (case_id, document_id)).fetchone()
    if row is None:
        raise HTTPException(404, "document not found")
    return Response(bytes(row["content"]), media_type="application/pdf", headers={"Cache-Control": "private, no-store"})


@router.post("/api/case/{case_id}/documents/{document_id}/remove")
def remove_document(case_id: int, document_id: int, payload: Removal, actor: dict = Depends(require_permission("case.chart")),
                    database: Connection = Depends(connection)) -> dict[str, Any]:
    with database.transaction():
        row = database.execute(
            f"""UPDATE case_document SET removed_at=%s, removed_by=%s, removed_reason=%s, synced_at=NULL
                WHERE case_id=%s AND id=%s AND removed_at IS NULL RETURNING {COLUMNS}""",
            (now_ms(), actor.get("username"), payload.reason.strip(), case_id, document_id)).fetchone()
        if row is None:
            raise HTTPException(404, "document not found or already removed")
        case_audit(database, case_id, "document.remove", {"document": document_id}, {"reason": payload.reason.strip()}, actor)
    return {"document": row}


# ---------------------------------------------------------------- the sync worker

@router.get("/api/case-documents/outbox")
def documents_outbox(limit: int = Query(default=20, ge=1, le=100), _: dict = Depends(service_only), database: Connection = Depends(connection)) -> dict[str, Any]:
    """Documents Canopy does not have as they are now (new, or removed since sent), oldest first."""
    rows = database.execute(
        f"""SELECT {', '.join('d.' + column for column in COLUMNS.split(', '))}, c.hn, c.handover_global_case_id
            FROM case_document d JOIN cases c ON c.id = d.case_id WHERE d.synced_at IS NULL ORDER BY d.id LIMIT %s""", (limit,)).fetchall()
    return {"documents": [{**row, "handover_global_case_id": str(row["handover_global_case_id"]) if row.get("handover_global_case_id") else None} for row in rows]}


@router.get("/api/case-documents/{document_id}/file")
def outbox_file(document_id: int, _: dict = Depends(service_only), database: Connection = Depends(connection)) -> Response:
    row = database.execute("SELECT content FROM case_document WHERE id=%s", (document_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "document not found")
    return Response(bytes(row["content"]), media_type="application/pdf")


@router.put("/api/case-documents/{document_id}/synced")
def mark_synced(document_id: int, payload: dict[str, Any] = Body(default={}), _: dict = Depends(service_only),
                database: Connection = Depends(connection)) -> dict[str, Any]:
    error = payload.get("error")
    database.execute("UPDATE case_document SET synced_at=CASE WHEN %s::text IS NULL THEN %s ELSE synced_at END, sync_error=%s WHERE id=%s",
                     (error, now_ms(), str(error)[:300] if error else None, document_id))
    return {"ok": True}
