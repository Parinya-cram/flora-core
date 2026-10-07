"""FormDev HTTP API (/api/formdev). Routes only translate HTTP <-> repositories.

Storage is chosen by FORMDEV_STORAGE:
- ``postgresql`` (default): the Flora PostgreSQL service through the request connection
- ``sqlite:/path/to/formdev.db``: standalone mode with no PostgreSQL dependency
"""
from __future__ import annotations

import base64
import logging
import re
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, Query, Request
from fastapi.responses import Response

from ..formdev import FormDevServices
from ..formdev.attachments import INLINE_TYPES, MAX_BYTES as MAX_ATTACHMENT_BYTES, refs as attachment_refs
from ..formdev.definition import Issue, describe_issues, parse_json_strict
from ..formdev.errors import FormDevError
from ..formdev.adapters.sql_query import QueryFailed, QueryTimeout
from ..formdev.formpack import export_formpack, install_formpack, media_type
from ..formdev.record_access import FormView
from .auth_canopy import read_token
from .fleet_control import require_admin
from .formdev_runtime import STORAGE, checkout, hidden_fields, principal_for, record_access, runtime, storage, write_guard

router = APIRouter(prefix="/api/formdev", tags=["formdev"])
log = logging.getLogger("flora.formdev")
FILTER = re.compile(r"^([a-z][a-z0-9_]{0,63}):(eq|prefix|gte|lte):(.*)$", re.DOTALL)


def formdev(request: Request) -> Iterator[FormDevServices]:
    """Storage for one request (see formdev_runtime). The connection is kept on request.state so
    endpoints can resolve the caller's current permissions."""
    with checkout() as connection:
        request.state.formdev_connection = connection
        with storage(connection) as services:
            yield services


def username(user: dict[str, Any]) -> str:
    return str(user.get("username") or user.get("sub") or "unknown")


def _definition_body(body: Any) -> dict[str, Any]:
    definition = body.get("definition") if isinstance(body, dict) else None
    if not isinstance(definition, dict):
        raise FormDevError("invalid_definition", "Request body must be {\"definition\": {...}}")
    return definition


MAX_DEFINITION_BYTES = 2 * 1024 * 1024


async def strict_definition(request: Request) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """{"definition": {...}} parsed without silently dropping duplicate keys (Phase 1.10).
    Returns the definition and its duplicate-key issues (paths relative to the definition)."""
    body = await request.body()
    if len(body) > MAX_DEFINITION_BYTES:
        raise FormDevError("body_too_large", f"Form definitions are limited to {MAX_DEFINITION_BYTES} bytes", 413)
    value, issues = parse_json_strict(body.decode("utf-8", errors="replace"))
    if any(issue.code == "invalid_json" for issue in issues):
        raise FormDevError("invalid_definition", "Request body must be JSON")
    definition = _definition_body(value)
    duplicates = [Issue("$" + issue.path[len("$.definition"):], issue.code, issue.message)
                  for issue in issues if issue.path.startswith("$.definition.") or issue.path.startswith("$.definition[")]
    return definition, describe_issues(definition, duplicates)


async def strict_json(request: Request) -> Any:
    """A small JSON body that may not repeat a key."""
    body = await request.body()
    if len(body) > MAX_DEFINITION_BYTES:
        raise FormDevError("body_too_large", f"Bodies are limited to {MAX_DEFINITION_BYTES} bytes", 413)
    value, issues = parse_json_strict(body.decode("utf-8", errors="replace"))
    if issues:
        raise FormDevError("invalid_request", "Body must be JSON without repeated keys", 422, [issue.as_dict() for issue in issues])
    return value


MAX_LOOKUP_BYTES = 16 * 1024 * 1024


async def strict_lookup(request: Request) -> Any:
    """A lookup table body {metadata, entries} (up to 16 MB) that may not repeat a key."""
    body = await request.body()
    if len(body) > MAX_LOOKUP_BYTES:
        raise FormDevError("body_too_large", f"Lookup tables are limited to {MAX_LOOKUP_BYTES} bytes", 413)
    value, issues = parse_json_strict(body.decode("utf-8", errors="replace"))
    if issues:
        raise FormDevError("invalid_request", "Body must be JSON without repeated keys", 422, [issue.as_dict() for issue in issues[:20]])
    return value


def _refuse_duplicates(duplicates: list[dict[str, str]]) -> None:
    if duplicates:
        raise FormDevError("invalid_definition", "Form definition repeats a key", 422, duplicates)


# Registry -------------------------------------------------------------------
@router.get("/registry")
def registry(_: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"styles": fd.styles.list_styles(), "fonts": fd.styles.list_fonts(), "storage": fd.adapter.vendor}


@router.put("/styles/{style_id}")
def put_style(style_id: str, user: dict = Depends(require_admin), body: Any = Depends(strict_json), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    """Add or change a registry style: {"definition": {name, category, inherit?, tokens, components?}}."""
    row = fd.styles.put_style(style_id, body.get("definition") if isinstance(body, dict) else None)
    log.info("formdev style %s saved as version %s by %s", style_id, row["version"], username(user))
    return {"style": row}


@router.put("/fonts/{font_id}")
def put_font(font_id: str, user: dict = Depends(require_admin), body: Any = Depends(strict_json), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    """Add or change a font: {"metadata": {family, ...}, "assets": [...], "fallback": [...]} (no font files)."""
    row = fd.styles.put_font(font_id, body)
    log.info("formdev font %s saved by %s", font_id, username(user))
    return {"font": row}


# Attachments (data layer: file storage) ------------------------------------------
@router.put("/attachments/{sha256}")
async def put_attachment(sha256: str, request: Request, user: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    """Upload the bytes of a file field before syncing the record that references them (ref "att:<sha256>").
    Idempotent; the server checks the hash. Body: the raw file, Content-Type: its media type."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_ATTACHMENT_BYTES:
        raise FormDevError("attachment_too_large", f"Attachments are limited to {MAX_ATTACHMENT_BYTES} bytes", 413)
    content = await request.body()
    media_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    meta = fd.attachments.put(sha256, media_type, content, username(user))
    return {"attachment": {key: meta[key] for key in ("sha256", "media_type", "size", "created")}}


@router.get("/attachments/{sha256}")
def get_attachment(sha256: str, request: Request, record_id: str = Query(...), fd: FormDevServices = Depends(formdev)) -> Response:
    """A file of a record the caller may read; only files the record references in fields the caller may view."""
    record, view = _record_access(request, fd, record_id)
    references = {sha: value for _, sha, value in attachment_refs(view.mask_data(record["data"], record["schema_version"]))}
    found = fd.attachments.get(sha256) if sha256 in references else None
    if found is None:
        raise FormDevError("attachment_not_found", "Attachment not found", 404)
    meta, content = found
    inline = meta["media_type"] in INLINE_TYPES
    name = str(references[sha256].get("name") or sha256).replace('"', "")
    return Response(content=content, media_type=meta["media_type"] if inline else "application/octet-stream", headers={
        "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(name)}",
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'; sandbox",
    })


# Lookup tables (Phase 2.3) ------------------------------------------------------
@router.get("/lookups")
def list_lookups(_: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"rows": fd.lookups.list()}


@router.get("/lookups/{lookup_id}")
def get_lookup(lookup_id: str, _: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"lookup": fd.lookups.get(lookup_id)}


@router.put("/lookups/{lookup_id}")
def put_lookup(lookup_id: str, user: dict = Depends(require_admin), body: Any = Depends(strict_lookup), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    """Add or replace a lookup table: {"metadata": {title, columns, authoritative?, notice?, source?}, "entries": [...]}."""
    row = fd.lookups.put(lookup_id, body, username(user))
    log.info("formdev lookup %s saved as version %s (%s rows) by %s", lookup_id, row["version"], len(row["entries"]), username(user))
    return {"lookup": {key: value for key, value in row.items() if key != "entries"}}


# Forms and versions -----------------------------------------------------------
@router.get("/forms")
def list_forms(_: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"rows": fd.forms.list()}


@router.post("/validate")
def validate(_: dict = Depends(read_token), parsed: tuple = Depends(strict_definition), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    definition, duplicates = parsed
    return {"issues": duplicates + fd.schemas.validate(definition)}


@router.post("/forms")
def create_form(user: dict = Depends(require_admin), parsed: tuple = Depends(strict_definition), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    definition, duplicates = parsed
    _refuse_duplicates(duplicates)
    return {"version": fd.schemas.create_form(definition, username(user))}


@router.get("/forms/{form_id}")
def get_form(form_id: str, _: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"form": fd.forms.get(form_id), "versions": fd.schemas.versions(form_id), "assets": fd.adapter.list_assets(form_id)}


@router.post("/forms/{form_id}/versions")
def new_version(form_id: str, user: dict = Depends(require_admin), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"version": fd.schemas.new_draft(form_id, username(user))}


@router.get("/forms/{form_id}/versions/{schema_version}")
def get_version(form_id: str, schema_version: int, _: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"version": fd.schemas.get_version(form_id, schema_version)}


@router.put("/forms/{form_id}/versions/{schema_version}")
def save_version(
    form_id: str, schema_version: int, user: dict = Depends(require_admin),
    parsed: tuple = Depends(strict_definition), fd: FormDevServices = Depends(formdev),
) -> dict[str, Any]:
    definition, duplicates = parsed
    _refuse_duplicates(duplicates)
    if definition.get("form_id") != form_id or definition.get("schema_version") != schema_version:
        raise FormDevError("invalid_definition", "form_id and schema_version must match the URL")
    return {"version": fd.schemas.save_draft(definition, username(user))}


@router.post("/forms/{form_id}/versions/{schema_version}/publish")
def publish_version(form_id: str, schema_version: int, user: dict = Depends(require_admin), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"version": fd.schemas.publish(form_id, schema_version, username(user))}


@router.get("/forms/{form_id}/assets/{path:path}")
def get_asset(form_id: str, path: str, _: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> Response:
    asset = fd.adapter.get_asset(form_id, path)
    if asset is None:
        raise FormDevError("asset_not_found", f"Asset '{path}' not found", 404)
    return Response(base64.b64decode(asset["content_b64"]), media_type=asset["media_type"] or media_type(path),
                    headers={"Cache-Control": "private, max-age=3600", "ETag": asset["sha256"]})


# Form packages -----------------------------------------------------------------
@router.get("/forms/{form_id}/package")
def export_package(
    form_id: str, version: int | None = Query(default=None, ge=1),
    _: dict = Depends(require_admin), fd: FormDevServices = Depends(formdev),
) -> Response:
    content = export_formpack(fd.schemas, fd.styles, form_id, version)
    name = f"{form_id.replace('_', '-')}{'.v' + str(version) if version else ''}.formpack"
    return Response(content, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/packages")
async def install_package(request: Request, user: dict = Depends(require_admin), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    return {"result": install_formpack(await request.body(), fd.schemas, fd.styles, fd.records, username(user))}


# Records -------------------------------------------------------------------------
@router.get("/records")
def search_records(
    request: Request,
    form_id: str,
    status: list[str] | None = Query(default=None),
    filter: list[str] | None = Query(default=None, description="field:op:value, op in eq|prefix|gte|lte"),
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    fd: FormDevServices = Depends(formdev),
) -> dict[str, Any]:
    principal = principal_for(request, request.state.formdev_connection)
    view = _form_view(fd, principal, form_id, f"Form '{form_id}' not found", "form_not_found")
    if status and "deleted" in status and not principal.is_admin:
        raise FormDevError("deleted_requires_admin", "Only administrators can list deleted records", 403)
    filters = []
    for raw in filter or []:
        match = FILTER.match(raw)
        if not match:
            raise FormDevError("invalid_filter", f"Filter '{raw}' must look like field:op:value")
        if match.group(1) in view.hidden_latest:
            raise FormDevError("unauthorized_field", f"You may not filter on '{match.group(1)}'", 403)
        filters.append({"field": match.group(1), "op": match.group(2), "value": match.group(3)})
    rt = runtime()
    # Paged pulls by offline clients get their own, larger bucket and no interactive query slot (see QUERY.md).
    rt.pull_rate.take(str(principal.user_id))
    try:
        if STORAGE.startswith("sqlite:") or STORAGE.startswith("json:"):
            result = fd.records.search(form_id, filters, status, cursor, limit)  # type: ignore[arg-type]
        else:
            # Same connection: the read-only session's statement timeout applies to the search.
            with fd.adapter.read_session(rt.policy["timeout_ms"]["default"]):
                result = fd.records.search(form_id, filters, status, cursor, limit)  # type: ignore[arg-type]
    except QueryTimeout:
        raise FormDevError("query_timeout", "The search took too long; narrow the filters and try again", 504) from None
    except QueryFailed:
        raise FormDevError("query_failed", "The search could not be run", 500) from None
    result["rows"] = [view.mask_row(row) for row in result["rows"] if view.can_see(row)]
    return result


def _form_view(fd: FormDevServices, principal: Any, form_id: str, missing: str, code: str) -> FormView:
    """The caller's view of a form's records, or 404 when they lack FormDev query access and 403 when the form's
    own rules (definition view permission, policy query list) refuse them."""
    if not principal.has("formdev.query"):
        raise FormDevError(code, missing, 404)
    view = record_access(fd, principal).form(form_id)
    if not view.readable:
        raise FormDevError("forbidden", "You may not view records of this form", 403)
    return view


def _record_access(request: Request, fd: FormDevServices, record_id: str) -> tuple[dict[str, Any], FormView]:
    principal = principal_for(request, request.state.formdev_connection)
    record = fd.records.get(record_id)
    view = _form_view(fd, principal, record["form_id"], f"Record '{record_id}' not found", "record_not_found")
    if not view.can_see(record):
        raise FormDevError("record_not_found", f"Record '{record_id}' not found", 404)
    return record, view


@router.get("/records/{record_id}")
def get_record(request: Request, record_id: str, as_version: int | None = Query(default=None, ge=1), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    _, view = _record_access(request, fd, record_id)
    return {"record": view.mask_row(fd.records.get(record_id, as_version))}


@router.get("/records/{record_id}/revisions")
def record_revisions(request: Request, record_id: str, fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    _, view = _record_access(request, fd, record_id)
    return {"rows": [view.mask_row(row) for row in fd.records.revisions(record_id)]}


@router.get("/records/{record_id}/conflicts")
def record_conflicts(request: Request, record_id: str, fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    _, view = _record_access(request, fd, record_id)
    # Conflict payloads carry no schema version: mask the names every version used.
    return {"rows": [{**row, "local_data": view.mask_data(row["local_data"], None), "server_data": view.mask_data(row["server_data"], None)}
                     for row in fd.adapter.list_conflicts(record_id)]}


@router.post("/records/{record_id}/upgrade")
def upgrade_record(record_id: str, body: Any = Body(...), user: dict = Depends(require_admin), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    if not isinstance(body, dict) or not isinstance(body.get("expected_version"), int):
        raise FormDevError("invalid_request", "expected_version is required")
    return {"record": fd.records.upgrade(record_id, body["expected_version"], username(user), body.get("to_version"))}


# Sync ------------------------------------------------------------------------------
@router.post("/sync")
def sync(request: Request, body: Any = Body(...), user: dict = Depends(read_token), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    ops = body.get("ops") if isinstance(body, dict) else None
    principal = principal_for(request, request.state.formdev_connection)
    access = record_access(fd, principal)
    locked, allows = write_guard(fd, principal, access)

    def present(record: dict[str, Any]) -> dict[str, Any]:
        """Acks show the record as the caller may read it; callers who may not read the form get only its
        identity and versions (enough for the client to settle its queue), never data."""
        view = access.form(record["form_id"])
        if view.can_see(record):
            return view.mask_row(record)
        return {key: record.get(key) for key in ("record_id", "form_id", "schema_version", "status", "version", "updated_at")}

    acks = fd.sync.apply(ops, username(user), protected=hidden_fields(fd, principal, access), locked=locked, allows=allows, present=present)
    return {"acks": acks, "server_time": int(time.time() * 1000)}
