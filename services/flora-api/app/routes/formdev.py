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

from fastapi import APIRouter, Body, Depends, Query, Request
from fastapi.responses import Response

from ..formdev import FormDevServices
from ..formdev.definition import Issue, describe_issues, parse_json_strict
from ..formdev.errors import FormDevError
from ..formdev.formpack import export_formpack, install_formpack, media_type
from .auth_canopy import read_token
from .fleet_control import require_admin
from ..formdev.logic.permission import form_allows, mask
from .formdev_runtime import STORAGE, checkout, hidden_fields, principal_for, published_definition, runtime, storage, write_guard

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


def _mask(data: Any, hidden: set[str]) -> Any:
    return mask(data, hidden)


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
    if not principal.has("formdev.query"):
        raise FormDevError("form_not_found", f"Form '{form_id}' not found", 404)
    _require_view(fd, principal, form_id)
    hidden = hidden_fields(fd, principal)(form_id)
    filters = []
    for raw in filter or []:
        match = FILTER.match(raw)
        if not match:
            raise FormDevError("invalid_filter", f"Filter '{raw}' must look like field:op:value")
        if match.group(1) in hidden:
            raise FormDevError("unauthorized_field", f"You may not filter on '{match.group(1)}'", 403)
        filters.append({"field": match.group(1), "op": match.group(2), "value": match.group(3)})
    rt = runtime()
    rt.rate.take(str(principal.user_id))
    with rt.concurrency.slot(str(principal.user_id)):
        if STORAGE.startswith("sqlite:"):
            result = fd.records.search(form_id, filters, status, cursor, limit)  # type: ignore[arg-type]
        else:
            # Same connection: the read-only session's statement timeout applies to the search.
            with fd.adapter.read_session(rt.policy["timeout_ms"]["default"]):
                result = fd.records.search(form_id, filters, status, cursor, limit)  # type: ignore[arg-type]
    if hidden:
        result["rows"] = [{**row, "data": _mask(row["data"], hidden)} for row in result["rows"]]
    return result


def _record_access(request: Request, fd: FormDevServices, record_id: str) -> tuple[dict[str, Any], set[str]]:
    principal = principal_for(request, request.state.formdev_connection)
    record = fd.records.get(record_id)
    if not principal.has("formdev.query"):
        raise FormDevError("record_not_found", f"Record '{record_id}' not found", 404)
    _require_view(fd, principal, record["form_id"])
    return record, hidden_fields(fd, principal)(record["form_id"])


def _require_view(fd: FormDevServices, principal: Any, form_id: str) -> None:
    """The definition's form-level view permission (Phase 2.8)."""
    definition = published_definition(fd, form_id)
    if definition is not None and not form_allows(definition, "view", principal.codes, principal.is_admin):
        raise FormDevError("forbidden", "You may not view records of this form", 403)


@router.get("/records/{record_id}")
def get_record(request: Request, record_id: str, as_version: int | None = Query(default=None, ge=1), fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    _, hidden = _record_access(request, fd, record_id)
    record = fd.records.get(record_id, as_version)
    return {"record": {**record, "data": _mask(record["data"], hidden)}}


@router.get("/records/{record_id}/revisions")
def record_revisions(request: Request, record_id: str, fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    _, hidden = _record_access(request, fd, record_id)
    return {"rows": [{**row, "data": _mask(row["data"], hidden)} for row in fd.records.revisions(record_id)]}


@router.get("/records/{record_id}/conflicts")
def record_conflicts(request: Request, record_id: str, fd: FormDevServices = Depends(formdev)) -> dict[str, Any]:
    _, hidden = _record_access(request, fd, record_id)
    return {"rows": [{**row, "local_data": _mask(row["local_data"], hidden), "server_data": _mask(row["server_data"], hidden)}
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
    locked, allows = write_guard(fd, principal)
    acks = fd.sync.apply(ops, username(user), protected=hidden_fields(fd, principal), locked=locked, allows=allows)
    return {"acks": acks, "server_time": int(time.time() * 1000)}
