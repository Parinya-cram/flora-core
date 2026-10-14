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
from ..formdev import FormDevServices, ai_builder, documents
from ..formdev.attachments import INLINE_TYPES
from ..formdev.definition import FORMAT, FORM_ID, describe_issues, validate_definition
from ..formdev.errors import FormDevError
from .auth_canopy import read_token
from .auth_leaf import attach_entitlements
from .formdev import formdev, strict_json, username
from .formdev_runtime import checkout, storage
from .studio_access import can_author, require_studio_author

router = APIRouter(prefix="/api/formdev", tags=["formdev ai"])
log = logging.getLogger("flora.formdev.ai")
MAX_UPLOAD_BYTES = 48 * 1024 * 1024  # base64 of documents.MAX_TOTAL_BYTES plus page images and JSON
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


def _inspected(body: dict[str, Any]) -> list[documents.SourceFile]:
    try:
        return documents.inspect(documents.read_upload(body))
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
    if ai_builder.needs_page_images(config):
        for source in files:
            if source.kind == "pdf" and not source.page_images and not source.scan_images:
                source.note("error", "This AI host cannot read PDF files: Form Studio sends the pages as images (reload the page and try again)")


@router.get("/ai/status")
def ai_status(_: dict = Depends(ai_author)) -> dict[str, Any]:
    return _status(_ai_config())


@router.post("/ai/inspect")
def ai_inspect(_: dict = Depends(ai_author), body: dict = Depends(upload_body)) -> dict[str, Any]:
    """Check the documents without calling the AI service; form JSON files are validated."""
    files = _inspected(body)
    validate = _validator()
    report = documents.summary(files)
    for source, entry in zip(files, report["files"]):
        if source.definition is not None:
            entry["issues"] = validate(source.definition)[:100]
    return report


@router.post("/ai/generate")
def ai_generate(user: dict = Depends(ai_author), body: dict = Depends(upload_body)) -> dict[str, Any]:
    """Build a form from the documents and keep it as a draft template: {template, issues, inspection, usage}."""
    instructions, form_id, title = _options(body)
    files = _inspected(body)
    config = _ai_config()
    validate = _validator()
    only_forms = all(source.definition is not None for source in files)
    if not only_forms or instructions.strip():
        _check_for_ai(files, config)
    inspection = documents.summary(files)
    if not inspection["ok"]:
        raise FormDevError("invalid_documents", "Some documents cannot be used; see the report", 422, inspection)
    if only_forms and len(files) == 1 and not instructions.strip():
        # A flora.form/1 file: checked and kept as is, no AI needed.
        definition = ai_builder.normalize(files[0].definition, form_id, title)
        result = {"definition": definition, "report": None, "issues": validate(definition), "attempts": 0, "usage": None, "model": None}
        origin = "import"
    else:
        try:
            result = ai_builder.build(config, files, instructions=instructions, form_id=form_id, title=title, validate=validate)
        except ai_builder.BuildError as error:
            raise FormDevError("ai_failed", str(error), 502, inspection) from None
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
