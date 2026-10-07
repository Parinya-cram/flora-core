"""FormDev Phase 4 HTTP API: queries, saved queries, background jobs and administration.

Every query endpoint resolves one dependency in a fixed order — token, rate limit, concurrency
slot, pooled connection (2 s), current permissions — so refused requests never hold a connection.
Request bodies are capped at max_body_bytes and parsed with duplicate keys rejected.
"""
from __future__ import annotations

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse

from ..formdev import FormDevServices
from ..formdev.errors import FormDevError
from ..formdev.query.access import MANAGE_PERMISSION, Principal
from ..formdev.query.advisor import advise
from ..formdev.query.catalog import SOURCE_ID, build_catalog, validate_policy, validate_source_config
from ..formdev.query.engine import QueryEngine, QueryRuntime
from ..formdev.query.jobs import JobService
from . import formdev_runtime as rt
from .auth_canopy import read_token

router = APIRouter(prefix="/api/formdev", tags=["formdev-query"])


@dataclass
class Context:
    runtime: QueryRuntime
    services: FormDevServices
    principal: Principal

    def engine(self) -> QueryEngine:
        return QueryEngine(self.runtime, self.services, self.principal)

    def jobs(self) -> JobService:
        return JobService(self.runtime, self.services, self.principal, rt.store())


def _context(request: Request, slot: bool, cost: float) -> Iterator[Context]:
    runtime = rt.runtime()
    subject = str(read_token(request).get("sub"))
    runtime.rate.take(subject, cost)
    if slot:
        with runtime.concurrency.slot(subject):
            yield from _with_storage(request, runtime)
    else:
        yield from _with_storage(request, runtime)


def _with_storage(request: Request, runtime: QueryRuntime) -> Iterator[Context]:
    with rt.checkout() as connection:
        principal = rt.principal_for(request, connection)
        with rt.storage(connection) as services:
            yield Context(runtime, services, principal)


def query_context(request: Request) -> Iterator[Context]:
    yield from _context(request, slot=True, cost=1.0)


def api_context(request: Request) -> Iterator[Context]:
    yield from _context(request, slot=False, cost=0.2)


def _require_manage(ctx: Context) -> None:
    if not ctx.principal.has(MANAGE_PERMISSION):
        raise FormDevError("forbidden", "This needs the formdev.manage permission", 403)


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)


async def read_json(request: Request) -> Any:
    limit = rt.runtime().policy["max_body_bytes"]
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise FormDevError("body_too_large", f"Request bodies are limited to {limit} bytes", 413)
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise FormDevError("body_too_large", f"Request bodies are limited to {limit} bytes", 413)
    try:
        return json.loads(body or b"null", object_pairs_hook=_no_duplicates)
    except RecursionError:
        raise FormDevError("dangerous_operation", "The request is nested too deeply") from None
    except ValueError as error:
        code = "dangerous_operation" if "duplicate key" in str(error) else "invalid_request"
        raise FormDevError(code, "Duplicate keys are not allowed" if code == "dangerous_operation" else "Body must be JSON") from None


# Catalog and queries -------------------------------------------------------------------------
@router.get("/query/sources")
def query_sources(ctx: Context = Depends(api_context)) -> dict[str, Any]:
    engine = ctx.engine()
    ids = [form["form_id"] for form in ctx.services.forms.list() if form.get("published_version")]
    ids += [source["source_id"] for source in ctx.services.adapter.list_sources()]
    rows = []
    for source_id in dict.fromkeys(ids):
        catalog = engine.catalog(source_id)
        if catalog is not None:
            rows.append({"source_id": catalog.source_id, "form_id": catalog.form_id, "title": catalog.title,
                         "kind": "form" if catalog.source_id == catalog.form_id else "named", "can_export": catalog.can_export(ctx.principal)})
    return {"rows": rows}


@router.get("/query/catalog/{source_id}")
def query_catalog(source_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    catalog = ctx.engine().catalog(source_id)
    if catalog is None:
        raise FormDevError("unknown_source", "Unknown source", 404)
    policy = ctx.runtime.policy
    public_policy = {key: policy[key] for key in policy if key not in ("rate", "concurrency", "jobs", "max_body_bytes")}
    return {"catalog": catalog.public(ctx.principal), "policy": public_policy}


@router.post("/query/validate")
async def validate_query(request: Request, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    body = await read_json(request)
    issues, _, _ = await run_in_threadpool(ctx.engine().validate, body)
    return {"issues": [issue.as_dict() for issue in issues]}


@router.post("/query")
async def run_query(
    request: Request,
    refresh: bool = False,
    explain: bool = False,
    test_sleep_ms: int | None = Query(default=None, include_in_schema=False),
    ctx: Context = Depends(query_context),
) -> dict[str, Any]:
    body = await read_json(request)
    if refresh:
        ctx.runtime.rate.take(f"refresh:{ctx.principal.user_id}")
    return await run_in_threadpool(ctx.engine().run, body, refresh, explain, test_sleep_ms if ctx.runtime.test_hooks else None)


# Saved queries --------------------------------------------------------------------------------
@router.get("/queries")
def list_saved(ctx: Context = Depends(api_context)) -> dict[str, Any]:
    return {"rows": [{key: row[key] for key in ("query_id", "owner", "updated_at")} | {"source": (row["definition"].get("query") or {}).get("source")}
                     for row in ctx.services.adapter.list_saved_queries()]}


@router.get("/queries/{query_id}")
def get_saved(query_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    row = ctx.services.adapter.get_saved_query(query_id)
    if row is None:
        raise FormDevError("query_not_found", "Saved query not found", 404)
    return {"query": row}


@router.put("/queries/{query_id}")
async def save_query(query_id: str, request: Request, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    body = await read_json(request)
    if not SOURCE_ID.match(query_id):
        raise FormDevError("invalid_value", "query_id is a lower_snake_case name")
    if not isinstance(body, dict) or not isinstance(body.get("query"), dict):
        raise FormDevError("invalid_request", "Body must be {\"query\": {...}}")
    body = {**body, "query": {**body["query"], "id": query_id}}
    await run_in_threadpool(ctx.engine().require_valid, body)
    adapter = ctx.services.adapter
    existing = adapter.get_saved_query(query_id)
    if existing and existing["owner_user_id"] != ctx.principal.user_id and not ctx.principal.is_admin:
        raise FormDevError("forbidden", "Only the owner or an administrator can change this saved query", 403)
    now = int(time.time() * 1000)
    with adapter.transaction():
        adapter.save_saved_query({"query_id": query_id, "definition": body, "owner_user_id": ctx.principal.user_id, "owner": ctx.principal.username,
                                  "created_at": existing["created_at"] if existing else now, "updated_at": now})
    return {"query": adapter.get_saved_query(query_id)}


@router.delete("/queries/{query_id}")
def delete_saved(query_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    adapter = ctx.services.adapter
    existing = adapter.get_saved_query(query_id)
    if existing is None:
        raise FormDevError("query_not_found", "Saved query not found", 404)
    if existing["owner_user_id"] != ctx.principal.user_id and not ctx.principal.is_admin:
        raise FormDevError("forbidden", "Only the owner or an administrator can delete this saved query", 403)
    with adapter.transaction():
        adapter.delete_saved_query(query_id)
    return {"deleted": query_id}


@router.post("/queries/{query_id}/run")
async def run_saved(query_id: str, request: Request, ctx: Context = Depends(query_context)) -> dict[str, Any]:
    overrides = await read_json(request) or {}
    row = ctx.services.adapter.get_saved_query(query_id)
    if row is None:
        raise FormDevError("query_not_found", "Saved query not found", 404)
    body = json.loads(json.dumps(row["definition"]))
    if isinstance(overrides, dict) and isinstance(overrides.get("cursor"), str):
        body["query"].setdefault("pagination", {"mode": "cursor", "limit": 50})["cursor"] = overrides["cursor"]
    return await run_in_threadpool(ctx.engine().run, body)


# Jobs -------------------------------------------------------------------------------------------
def _jobs_ready() -> None:
    if not rt.jobs_available:
        raise FormDevError("jobs_unavailable", "Background jobs are not available on this server", 503)


@router.post("/jobs")
async def create_job(request: Request, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _jobs_ready()
    body = await read_json(request)
    if not isinstance(body, dict) or not isinstance(body.get("kind"), str):
        raise FormDevError("invalid_job", "Body must be {\"kind\": ..., \"format\"?: ..., \"body\": {\"query\": {...}}}")
    return {"job": await run_in_threadpool(ctx.jobs().create, body["kind"], body.get("body"), body.get("format"))}


@router.get("/jobs")
def list_jobs(ctx: Context = Depends(api_context)) -> dict[str, Any]:
    return {"rows": ctx.jobs().list()}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    return {"job": ctx.jobs().get(job_id)}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    return {"job": ctx.jobs().cancel(job_id)}


@router.get("/jobs/{job_id}/download")
def download_job(job_id: str, ctx: Context = Depends(api_context)) -> StreamingResponse:
    chunks, media_type, name, size = ctx.jobs().download(job_id)
    return StreamingResponse(chunks, media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{name}"',
                                                                      "Content-Length": str(size), "Cache-Control": "no-store"})


# Administration -------------------------------------------------------------------------------------
@router.get("/policies/{form_id}")
def get_policy(form_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    return {"policy": ctx.services.adapter.get_form_policy(form_id)}


@router.put("/policies/{form_id}")
async def save_policy(form_id: str, request: Request, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    body = await read_json(request)
    adapter = ctx.services.adapter
    definition = ctx.services.schemas.latest_published(form_id)["definition"]
    policy = validate_policy(body.get("policy") if isinstance(body, dict) else None, definition)
    existing = adapter.get_form_policy(form_id)
    with adapter.transaction():
        adapter.save_form_policy({"form_id": form_id, "policy": policy, "version": (existing["version"] if existing else 0) + 1,
                                  "updated_at": int(time.time() * 1000), "updated_by": ctx.principal.username})
        adapter.bump_data_version(form_id, int(time.time() * 1000))
    ctx.runtime.cache.invalidate_form(form_id)
    return {"policy": adapter.get_form_policy(form_id)}


@router.put("/sources/{source_id}")
async def save_source(source_id: str, request: Request, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    body = await read_json(request)
    if not SOURCE_ID.match(source_id):
        raise FormDevError("invalid_source", "source_id is a lower_snake_case name")
    config = validate_source_config(body.get("config") if isinstance(body, dict) else None)
    form_id = config.get("form_id") or (body or {}).get("form_id")
    if not isinstance(form_id, str) or ctx.services.adapter.get_form(form_id) is None or form_id == source_id:
        raise FormDevError("invalid_source", "A named source needs an existing form_id different from its own id")
    adapter = ctx.services.adapter
    existing = adapter.get_source(source_id)
    with adapter.transaction():
        adapter.save_source({"source_id": source_id, "form_id": form_id, "config": {k: v for k, v in config.items() if k != "form_id"},
                             "version": (existing["version"] if existing else 0) + 1, "updated_at": int(time.time() * 1000), "updated_by": ctx.principal.username})
    catalog = build_catalog(ctx.services, source_id)  # validates relations against real sources
    for name, relation in catalog.relations.items():
        foreign = relation["target"].fields.get(relation["foreign"])
        local = catalog.fields.get(relation["local"])
        if not foreign or not foreign.get("indexed") or not local:
            with adapter.transaction():
                adapter.delete_source(source_id) if existing is None else adapter.save_source(existing)
            raise FormDevError("invalid_relation", f"Relation '{name}' needs an existing local field and an indexed foreign field")
    ctx.runtime.cache.clear()
    return {"source": adapter.get_source(source_id)}


@router.delete("/sources/{source_id}")
def delete_source(source_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    with ctx.services.adapter.transaction():
        ctx.services.adapter.delete_source(source_id)
    ctx.runtime.cache.clear()
    return {"deleted": source_id}


@router.get("/index-config/{form_id}")
def index_config(form_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    return {"fields": ctx.services.indexing.indexed_fields(form_id), "config": ctx.services.adapter.list_index_config(form_id)}


@router.post("/index-config/{form_id}/{field_id}")
def add_index(form_id: str, field_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    state = ctx.services.indexing.add_config_field(form_id, field_id, ctx.principal.username)
    ctx.runtime.cache.invalidate_form(form_id)
    return {"field": field_id, "state": state}


@router.delete("/index-config/{form_id}/{field_id}")
def remove_index(form_id: str, field_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    state = ctx.services.indexing.remove_config_field(form_id, field_id, ctx.principal.username)
    ctx.runtime.cache.invalidate_form(form_id)
    return {"field": field_id, "state": state}


@router.get("/query/advice")
def query_advice(source_id: str, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    rt.flush_stats()
    catalog = build_catalog(ctx.services, source_id)
    stats = ctx.services.adapter.list_query_stats(source_id)
    return {"advice": advise(catalog, stats, ctx.services.adapter.count_records(catalog.form_id), ctx.services.adapter.vendor), "shapes": len(stats)}


@router.get("/query/stats")
def query_stats(source_id: str | None = None, ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    return {"rows": ctx.services.adapter.list_query_stats(source_id), "cache": ctx.runtime.cache.stats(),
            "active_queries": ctx.runtime.concurrency.active()}


@router.get("/query/audit")
def query_audit(limit: int = Query(default=200, ge=1, le=1000), ctx: Context = Depends(api_context)) -> dict[str, Any]:
    _require_manage(ctx)
    return {"rows": ctx.services.adapter.list_audit(limit)}

