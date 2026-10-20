"""Form Studio AI builder and template library (/api/formdev/ai, /api/formdev/templates).

Flow: the author uploads source documents → /ai/inspect checks every file (type, size, pages, text layer, damaged or
encrypted files, form JSON validity) → /ai/generate has the shared AI service write a flora.form/1 definition, checks
it with the form validator (with up to two automatic corrections) and keeps the result as a draft template with its
report and the source documents → the author reviews it in Form Studio against the documents, fixes it in the designer
and marks it reviewed → creates a form from it, publishes it, and adds it to a workflow in Workflow Studio (which
offers the AI's suggested Leaf placement).

The AI call can take minutes: authentication and storage use short connections, never one held across the call.
"""
from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import Response

from .. import ai_service
from ..database import pool
from ..formdev import FormDevServices, ai_builder, documents, uploads
from ..formdev.attachments import INLINE_TYPES
from ..formdev.definition import FORMAT, FORM_ID, describe_issues, validate_definition
from ..formdev.errors import FormDevError
from ..formdev.reading import draft as reading_draft
from .auth_canopy import read_token
from .auth_leaf import attach_entitlements
from .formdev import formdev, strict_json, username
from .formdev_runtime import checkout, storage
from .studio_access import can_author, require_studio_author

router = APIRouter(prefix="/api/formdev", tags=["formdev ai"])
log = logging.getLogger("flora.formdev.ai")
MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # JSON requests (a form definition, instructions); files come through /uploads
MAX_INSTRUCTIONS = 4000


def ai_author(request: Request) -> dict[str, Any]:
    """A Form Studio author (studio.manage), checked on a short connection: AI requests outlive it."""
    payload = read_token(request)
    with pool.connection() as database:
        row = database.execute("SELECT id,username,name,role,must_change_password,is_active FROM auth_user WHERE id=%s",
                               (payload["sub"],)).fetchone()
        if not row or not row["is_active"]:
            raise HTTPException(status_code=401, detail="sign in required")
        user = attach_entitlements(database, row)
    if user.get("must_change_password"):
        raise HTTPException(status_code=403, detail="password change required")
    if not can_author(user):
        raise HTTPException(status_code=403, detail="studio.manage permission required")
    return user


async def upload_body(request: Request) -> dict[str, Any]:
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        raise FormDevError("body_too_large", f"Uploads are limited to {MAX_UPLOAD_BYTES // (1024 * 1024)} MB", 413)
    try:
        value = json.loads(body)
    except ValueError:
        raise FormDevError("invalid_request", "Body must be JSON", 422) from None
    if not isinstance(value, dict):
        raise FormDevError("invalid_request", "Body must be a JSON object", 422)
    return value


def _ai_config() -> dict[str, Any]:
    with checkout() as connection:
        return ai_service.load(connection)


def _validator() -> Any:
    """validate(definition) -> described issues, with the registry ids read now (no connection kept)."""
    with checkout() as connection, storage(connection) as fd:
        style_ids, font_ids = fd.styles.style_ids(), fd.styles.font_ids()
    return lambda definition: describe_issues(definition, validate_definition(definition, style_ids, font_ids))


def _inspected(body: dict[str, Any], user: dict[str, Any]) -> list[documents.SourceFile]:
    """The documents of a build, by the ids of files already uploaded (POST /uploads), inspected again."""
    ids = body.get("uploads")
    if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
        raise FormDevError("invalid_request", "uploads: the ids of the uploaded documents (POST /api/formdev/uploads)", 422)
    try:
        return documents.inspect(documents.check_request([uploads.source(uploads.owner_of(user), item) for item in ids]))
    except documents.DocumentError as error:
        raise FormDevError("invalid_documents", str(error), 422) from None


def _options(body: dict[str, Any]) -> tuple[str, str | None, str | None]:
    instructions = body.get("instructions") or ""
    if not isinstance(instructions, str) or len(instructions) > MAX_INSTRUCTIONS:
        raise FormDevError("invalid_request", f"instructions: text of at most {MAX_INSTRUCTIONS} characters", 422)
    form_id = body.get("form_id") or None
    if form_id is not None and (not isinstance(form_id, str) or not FORM_ID.match(form_id)):
        raise FormDevError("invalid_request", "form_id must be lower snake case, 2-64 characters", 422)
    title = body.get("title") or None
    if title is not None and (not isinstance(title, str) or len(title) > 200):
        raise FormDevError("invalid_request", "title: at most 200 characters", 422)
    return instructions, form_id, title.strip() if title else None


def _status(config: dict[str, Any]) -> dict[str, Any]:
    public = ai_service.public(config)
    return {"configured": public["configured"], "apiFormat": public["apiFormat"], "model": public["model"],
            "needsPageImages": ai_builder.needs_page_images(config),
            "limits": {"files": documents.MAX_FILES, "fileBytes": documents.MAX_FILE_BYTES, "totalBytes": documents.MAX_TOTAL_BYTES,
                       "pdfPages": documents.MAX_PDF_PAGES, "pageImages": documents.MAX_PAGE_IMAGES}}


def _check_for_ai(files: list[documents.SourceFile], config: dict[str, Any]) -> None:
    """OpenAI-compatible hosts cannot read PDF files: their pages are rendered here as images."""
    if ai_builder.needs_page_images(config):
        left = documents.MAX_PAGE_IMAGES
        for source in files:
            if source.kind == "pdf" and not source.scan_images and source.status != "error" and left > 0:
                try:
                    source.page_images = documents.render_pages(source.content, left)
                    left -= len(source.page_images)
                except Exception as error:  # noqa: BLE001 - a PDF the renderer cannot open is reported, not sent
                    source.note("error", f"The pages of this PDF could not be rendered for the AI ({type(error).__name__})")


def _measured_draft(files: list[documents.SourceFile], form_id: str | None, title: str | None) -> dict[str, Any] | None:
    """The first scanned or PDF document read by the tools first (reading/, no AI): the paper's layout, tables and paper
    measured, for the AI to correct rather than guess. None when there is no such document or it cannot be read."""
    from ..formdev.reading import jobs as reading_jobs

    page = next((source for source in files if source.kind in ("pdf", "image") and source.status != "error"), None)
    if page is None or any(source.definition is not None for source in files):
        return None
    job = reading_jobs.Job("ai-builder", page.name, page.content, {"ai": False, "title": title, "form_id": form_id})
    reading_jobs._run(job, lambda: {})
    if job.status != "done" or not job.result:
        log.info("measured draft of %s not made: %s", page.name, job.error)
        return None
    return job.result["definition"]


@router.get("/ai/status")
def ai_status(_: dict = Depends(ai_author)) -> dict[str, Any]:
    return _status(_ai_config())


@router.post("/ai/generate")
def ai_generate(user: dict = Depends(ai_author), body: dict = Depends(upload_body)) -> dict[str, Any]:
    """Build a form from uploaded documents and keep it as a draft template: {uploads: [ids], instructions?, form_id?,
    title?} -> {template, issues, inspection, usage}."""
    instructions, form_id, title = _options(body)
    files = _inspected(body, user)
    config = _ai_config()
    validate = _validator()
    # A file added twice is reported in the inspection but read and sent once.
    usable = [source for source in files if not source.duplicate]
    only_forms = all(source.definition is not None for source in usable)
    if not only_forms or instructions.strip():
        _check_for_ai(usable, config)
    inspection = documents.summary(files)
    if not inspection["ok"]:
        raise FormDevError("invalid_documents", "Some documents cannot be used; see the report", 422, inspection)
    if only_forms and len(usable) == 1 and not instructions.strip():
        # A flora.form/1 file: checked and kept as is, no AI needed.
        definition = ai_builder.normalize(usable[0].definition, form_id, title)
        result = {"definition": definition, "report": None, "issues": validate(definition), "attempts": 0, "usage": None, "model": None}
        origin = "import"
    else:
        measured = _measured_draft(usable, form_id, title)
        try:
            result = ai_builder.build(config, usable, instructions=instructions, form_id=form_id, title=title, validate=validate,
                                      start=measured, measured=measured is not None)
        except ai_builder.BuildError as error:
            raise FormDevError("ai_failed", str(error), 502, inspection) from None
        if measured is not None:
            result["definition"] = reading_draft.keep_paper(result["definition"], measured)
            result["issues"] = validate(result["definition"])
        origin = "ai"
    sources = [{key: entry[key] for key in ("name", "kind", "media_type", "size", "sha256", "pages", "status", "notes")} for entry in inspection["files"]]
    if result["report"] is not None:
        result["report"]["instructions"] = instructions.strip()
        result["report"]["model"] = result["model"]
        result["report"]["usage"] = result["usage"]
        result["report"]["attempts"] = result["attempts"]
    actor = username(user)
    with checkout() as connection, storage(connection) as fd:
        stored: set[str] = set()
        for source in files:
            if source.sha256 not in stored:
                fd.attachments.put(source.sha256, source.media_type, source.content, actor)
                stored.add(source.sha256)
        template = fd.templates.create(definition=result["definition"], user=actor, origin=origin, title=result["definition"].get("title"),
                                       report=result["report"], sources=sources)
    log.info("formdev template %s built from %s document(s) by %s (%s, %s attempt(s), %s issue(s))", template["template_id"], len(files),
             actor, origin, result["attempts"], len(result["issues"]))
    return {"template": template, "issues": result["issues"], "inspection": inspection, "usage": result["usage"]}


# Template library -----------------------------------------------------------------------------------
@router.get("/templates")
def list_templates(_: dict = Depends(require_studio_author), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"rows": fd.templates.list()}


@router.get("/templates/{template_id}")
def get_template(template_id: str, _: dict = Depends(require_studio_author), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    template = fd.templates.get(template_id)
    return {"template": template, "issues": fd.schemas.validate(template["definition"])}


@router.post("/templates")
def create_template(user: dict = Depends(require_studio_author), body: Any = Depends(strict_json), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    """Keep a form definition as a template: {definition, title?, description?, origin?: manual | import}."""
    if not isinstance(body, dict) or set(body) - {"definition", "title", "description", "origin"}:
        raise FormDevError("invalid_request", "Body is {definition, title?, description?, origin?}", 422)
    origin = body.get("origin") or "manual"
    if origin not in ("manual", "import"):
        raise FormDevError("invalid_request", "origin is manual or import", 422)
    template = fd.templates.create(definition=body.get("definition"), user=username(user), origin=origin, title=body.get("title"),
                                   description=body.get("description") or "")
    return {"template": template, "issues": fd.schemas.validate(template["definition"])}


@router.put("/templates/{template_id}")
def update_template(template_id: str, user: dict = Depends(require_studio_author), body: Any = Depends(strict_json),
                    fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    template = fd.templates.update(template_id, body, username(user))
    return {"template": template, "issues": fd.schemas.validate(template["definition"])}


@router.delete("/templates/{template_id}")
def delete_template(template_id: str, _: dict = Depends(require_studio_author), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    fd.templates.delete(template_id)
    return {"deleted": template_id}


@router.get("/templates/{template_id}/sources/{sha256}")
def template_source(template_id: str, sha256: str, _: dict = Depends(require_studio_author), fd: FormDevServices = Depends(formdev)) -> Response:
    """A source document of the template, for checking the form against it."""
    source = next((item for item in fd.templates.get(template_id).get("sources") or [] if item.get("sha256") == sha256), None)
    found = fd.attachments.get(sha256) if source else None
    if found is None:
        raise FormDevError("attachment_not_found", "This document is not kept with the template", 404)
    meta, content = found
    media = meta.get("media_type") or "application/octet-stream"
    disposition = "inline" if media in INLINE_TYPES else "attachment"
    return Response(content, media_type=media, headers={
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(str(source.get('name') or sha256))}",
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300"})


@router.post("/templates/{template_id}/forms")
def form_from_template(template_id: str, user: dict = Depends(require_studio_author), body: Any = Body(...),
                       fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    """Create a Form Studio form (version 1 draft) from the template: {form_id, title?}."""
    form_id = body.get("form_id") if isinstance(body, dict) else None
    if not isinstance(form_id, str) or not FORM_ID.match(form_id):
        raise FormDevError("invalid_request", "form_id must be lower snake case, 2-64 characters", 422)
    title = body.get("title") if isinstance(body.get("title"), str) and body["title"].strip() else None
    definition = fd.templates.form_definition(template_id, form_id, title)
    version = fd.schemas.create_form(definition, username(user))
    return {"form_id": form_id, "version": version, "format": FORMAT}
