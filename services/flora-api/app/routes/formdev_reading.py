"""Uploads (/api/formdev/uploads), reading documents into forms (/api/formdev/reading) and the variable-name standard
(/api/formdev/ids).

POST /uploads?name= takes a file as it is (the body is the file, no base64) and checks it; POST /reading/jobs
{upload} starts a job on that document (a PDF, or a PNG / JPEG page; the browser merges an assembled group of pages
into one PDF first) and returns at once; GET /reading/jobs/{id}?after=n returns the events after n, which the screen
draws on the page as they come, then the draft form (GET …/result). See app/formdev/reading/ and formdev/uploads.py.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from ..formdev import documents, ids, uploads
from ..formdev.errors import FormDevError
from ..formdev.reading import jobs, ocr
from .formdev_ai import _ai_config, _validator, ai_author, upload_body

router = APIRouter(prefix="/api/formdev", tags=["formdev reading"])
READABLE = ("application/pdf", "image/png", "image/jpeg")


def _owner(user: dict[str, Any]) -> str:
    return uploads.owner_of(user)


@router.post("/uploads")
async def upload_file(request: Request, name: str = Query(default="document", max_length=200), user: dict = Depends(ai_author)) -> dict[str, Any]:
    """One file, sent as it is: {upload: {id, name, size, media_type, kind, pages}, file: inspection}; a .form.json
    file is validated too (file.issues)."""
    received = await uploads.receive(request, _owner(user), name)
    definition = received.pop("definition")
    if definition is not None:
        validate = await run_in_threadpool(_validator)
        received["file"]["issues"] = validate(definition)[:100]
    return received


@router.delete("/uploads/{upload_id}")
def remove_upload(upload_id: str, user: dict = Depends(ai_author)) -> dict[str, Any]:
    uploads.remove(_owner(user), upload_id)
    return {"removed": upload_id}


@router.get("/reading/status")
def reading_status(_: dict = Depends(ai_author)) -> dict[str, Any]:
    from .. import ai_service

    config = _ai_config()
    return {"ocr": ocr.available(), "ai": ai_service.public(config)["configured"], "model": ai_service.public(config)["model"],
            "maxPages": jobs.MAX_PAGES, "maxBytes": uploads.MAX_FILE_BYTES}


@router.post("/reading/jobs")
def start_reading(payload: dict[str, Any] = Body(...), user: dict = Depends(ai_author)) -> dict[str, Any]:
    """Read an uploaded document into a draft form: {upload, ai?, title?, form_id?}. The same upload can be read again
    (for example with the AI turned on) without sending the file again."""
    meta, content = uploads.get(_owner(user), str(payload.get("upload") or ""))
    if documents.sniff(content)[1] not in READABLE:
        raise FormDevError("invalid_request", "PDF, PNG or JPEG only", 422)
    options = {"ai": payload.get("ai") is True, "title": str(payload.get("title") or "")[:200] or None,
               "form_id": str(payload.get("form_id") or "") or None, "upload": meta["id"]}
    job = jobs.start(_owner(user), str(meta.get("name") or "document")[:200], content, options, _ai_config)
    return {"job": job.public()}


@router.get("/reading/jobs/{job_id}")
def reading_job(job_id: str, after: int = Query(default=0, ge=0), user: dict = Depends(ai_author)) -> dict[str, Any]:
    job = jobs.get(job_id, _owner(user))
    if job is None:
        raise HTTPException(status_code=404, detail="reading job not found (jobs are kept for two hours, and not across a server restart)")
    events = job.since(after)
    return {"job": job.public(), "events": events, "next": after + len(events)}


@router.get("/reading/jobs/{job_id}/result")
def reading_result(job_id: str, user: dict = Depends(ai_author)) -> dict[str, Any]:
    job = jobs.get(job_id, _owner(user))
    if job is None:
        raise HTTPException(status_code=404, detail="reading job not found")
    if job.result is None:
        raise HTTPException(status_code=409, detail=f"the job is {job.status}")
    return {"job": job.public(), **job.result}


@router.post("/reading/jobs/{job_id}/cancel")
def cancel_reading(job_id: str, user: dict = Depends(ai_author)) -> dict[str, Any]:
    job = jobs.get(job_id, _owner(user))
    if job is None:
        raise HTTPException(status_code=404, detail="reading job not found")
    job.cancel = True
    return {"job": job.public()}


@router.post("/ids/suggest")
def suggest_ids(payload: dict[str, Any] = Body(...), _: dict = Depends(ai_author)) -> dict[str, Any]:
    """Names for fields by the standard: {fields: [{label, label_en?, bind?, type?, section?}], taken?: [keys]}."""
    fields = payload.get("fields")
    if not isinstance(fields, list) or len(fields) > 500:
        raise FormDevError("invalid_request", "fields: a list of at most 500", 422)
    taken = set(str(key) for key in payload.get("taken") or [])
    out = []
    for field in fields:
        if not isinstance(field, dict):
            out.append(None)
            continue
        suggestion = ids.suggest(str(field.get("label") or ""), field.get("label_en"), field.get("bind"), field.get("type"),
                                 field.get("section"), taken)
        taken.add(suggestion["key"])
        out.append(suggestion)
    return {"suggestions": out}


@router.post("/ids/check")
def check_ids(payload: dict[str, Any] = Body(...), _: dict = Depends(ai_author)) -> dict[str, Any]:
    """What in a definition breaks the variable-name standard, each with the name it should have."""
    definition = payload.get("definition")
    if not isinstance(definition, dict):
        raise FormDevError("invalid_request", "definition must be an object", 422)
    return {"findings": ids.check(definition)}


@router.post("/ai/jobs")
async def start_ai_job(request: Request, user: dict = Depends(ai_author)) -> dict[str, Any]:
    """The designer's AI: {mode: create | revise, instructions, definition? (revise), focus?: [field ids], title?, form_id?}.
    Runs in the background (a form can take minutes); watch it at /reading/jobs/{id}."""
    body = await upload_body(request)
    mode = body.get("mode")
    instructions = body.get("instructions")
    if mode not in ("create", "revise") or not isinstance(instructions, str) or not instructions.strip() or len(instructions) > 4000:
        raise FormDevError("invalid_request", "mode is create or revise, with instructions (1-4000 characters)", 422)
    start = body.get("definition") if mode == "revise" else None
    if mode == "revise" and not isinstance(start, dict):
        raise FormDevError("invalid_request", "revise needs the current definition", 422)
    focus = [str(item) for item in body.get("focus") or [] if isinstance(item, str)][:50]
    options = {"mode": mode, "instructions": instructions.strip(), "start": start, "focus": focus,
               "title": str(body.get("title") or "")[:200] or None, "form_id": str(body.get("form_id") or "") or None}
    job = jobs.start_ai(_owner(user), instructions.strip()[:80], options, _ai_config, _validator())
    return {"job": job.public()}

