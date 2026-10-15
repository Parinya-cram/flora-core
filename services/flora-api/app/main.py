from contextlib import asynccontextmanager
import os

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg import Connection

from .bootstrap_admin import ensure_bootstrap_admin
from .database import close_pool, connection, open_pool, pool
from .device_writer import device_writer
from .routes.cases_read import router as cases_read_router
from .routes.auth_canopy import router as canopy_auth_router
from .routes.auth_leaf import router as leaf_auth_router
from .routes.cases_lifecycle import router as cases_lifecycle_router
from .routes.clinical_write import router as clinical_write_router
from .routes.catalog_write import router as catalog_write_router
from .routes.io_write import router as io_write_router
from .routes.ephis import router as ephis_router
from .routes.device_writer import router as device_writer_router
from .routes.his import router as his_router
from .routes.fleet_read import router as fleet_read_router
from .routes.fleet_control import router as fleet_control_router
from .routes.device_distribution import router as device_distribution_router
from .routes.legacy_archive import router as legacy_archive_router
from .routes.canopy_reports import router as canopy_reports_router
from .routes.ai_studio import router as ai_studio_router
from .routes.canopy_preferences import router as canopy_preferences_router
from .routes.canopy_users import router as canopy_users_router
from .routes.canopy_inbox import router as canopy_inbox_router
from .routes.sync_ward import router as sync_ward_router
from .routes.ward import router as ward_router
from .routes.dictation import router as dictation_router
from .routes.chart_undo import router as chart_undo_router
from .routes.billing_leaf import router as billing_leaf_router
from .routes.billing_canopy import router as billing_canopy_router
from .routes.billing_templates import router as billing_templates_router
from .routes.scores_canopy import router as scores_canopy_router
from .routes.scores_leaf import router as scores_leaf_router
from .routes.staff_canopy import router as staff_canopy_router
from .routes.staff_sync_leaf import router as staff_sync_leaf_router
from .score_writer import score_writer
from .routes.canopy_admissions import router as canopy_admissions_router
from .routes.hl7_interface import admin_router as hl7_admin_router, webhook_router as hl7_webhook_router
from .routes.public_api import router as public_api_router
from .routes.api_keys_admin import router as api_keys_admin_router
from . import api_keys
import time
from .routes.ai_settings import build_router as build_ai_settings_router
from .routes.sync_ingest import router as sync_ingest_router
from .routes.gateway_alerts import fleet_router as gateway_alerts_fleet_router, sync_router as gateway_alerts_sync_router
from .routes.device_management import (control_router as device_control_router, fleet_router as device_fleet_router,
                                       sync_router as device_sync_router)
from .routes.topology_physical import router as topology_physical_router
from .routes.workstation import router as workstation_router
from .routes.terminology import router as terminology_router
from .routes.formdev import router as formdev_router
from .routes.formdev_query import router as formdev_query_router
from .routes.formdev_ai import router as formdev_ai_router
from .routes.workflows import router as workflows_router
from .routes.case_workflow import router as case_workflow_router
from .routes import formdev_runtime
from .formdev.errors import FormDevError


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    api_mode = os.getenv("FLORA_API_MODE", "leaf").strip().lower()
    if api_mode in {"leaf", "canopy"}:
        with pool.connection() as database:
            ensure_bootstrap_admin(database)
    if api_mode == "leaf":
        device_writer.start()
        score_writer.start()
    if api_mode == "canopy":
        formdev_runtime.start_background()
    yield
    if api_mode == "canopy":
        # Workers return unfinished jobs to the queue before the pools close.
        formdev_runtime.stop_background()
    device_writer.stop()
    score_writer.stop()
    close_pool()


app = FastAPI(title="Flora API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
API_MODE = os.getenv("FLORA_API_MODE", "leaf").strip().lower()
if API_MODE in {"leaf", "canopy"}:
    app.include_router(cases_read_router)
if API_MODE == "leaf" and os.getenv("FLORA_LEAF_WRITE_API", "false").lower() == "true":
    app.include_router(leaf_auth_router)
    app.include_router(build_ai_settings_router())
    app.include_router(canopy_inbox_router)
    app.include_router(ward_router)
    app.include_router(dictation_router)
    app.include_router(chart_undo_router)
    app.include_router(billing_leaf_router)
    app.include_router(scores_leaf_router)
    app.include_router(staff_sync_leaf_router)  # before catalog_write's /staff/* routes
    app.include_router(case_workflow_router)
    app.include_router(cases_lifecycle_router)
    app.include_router(clinical_write_router)
    app.include_router(catalog_write_router)
    app.include_router(io_write_router)
    app.include_router(ephis_router)
    app.include_router(device_writer_router)
    app.include_router(his_router)
    app.include_router(workstation_router)
    app.include_router(terminology_router)
if API_MODE == "canopy":
    app.include_router(canopy_auth_router)
    app.include_router(canopy_preferences_router)
    app.include_router(canopy_users_router)
    app.include_router(build_ai_settings_router())
    app.include_router(canopy_admissions_router)
    app.include_router(hl7_webhook_router)
    app.include_router(hl7_admin_router)
    app.include_router(public_api_router)
    app.include_router(api_keys_admin_router)
    app.include_router(fleet_read_router)
    app.include_router(gateway_alerts_fleet_router)
    app.include_router(device_fleet_router)
    app.include_router(device_control_router)
    app.include_router(topology_physical_router)
    app.include_router(fleet_control_router)
    app.include_router(device_distribution_router)
    app.include_router(legacy_archive_router)
    app.include_router(canopy_reports_router)
    app.include_router(ai_studio_router)
    app.include_router(formdev_router)
    app.include_router(formdev_query_router)
    app.include_router(formdev_ai_router)
    app.include_router(billing_templates_router)  # before workflows: /billing-templates is not a workflow id
    app.include_router(scores_canopy_router)  # before workflows: /scores is not a workflow id
    app.include_router(workflows_router)
    app.include_router(billing_canopy_router)
    app.include_router(staff_canopy_router)
if API_MODE == "sync":
    app.include_router(sync_ingest_router)
    app.include_router(sync_ward_router)
    app.include_router(gateway_alerts_sync_router)
    app.include_router(device_sync_router)


@app.middleware("http")
async def enforce_canopy_read_only(request: Request, call_next):
    if API_MODE == "canopy" and request.method not in {"GET", "HEAD", "OPTIONS"}:
        canopy_preference_write = request.url.path.startswith("/api/auth/preferences/") or request.url.path.startswith("/api/auth/self/")
        canopy_preference_write = canopy_preference_write or request.url.path.startswith("/api/auth/users/") or request.url.path == "/api/auth/users"
        # Ward desks and tablets admit cases and fill their forms (synced to the Leaf).
        canopy_preference_write = canopy_preference_write or request.url.path.startswith("/api/fleet/admissions")
        # Inbound HL7 interface engine webhook (secret token in the URL).
        canopy_preference_write = canopy_preference_write or request.url.path.startswith("/api/integrations/hl7/webhook/")
        # Public API v1: API-key auth with scopes (e.g. admissions:write).
        canopy_preference_write = canopy_preference_write or request.url.path.startswith("/api/v1/")
        report_generation = request.method == "POST" and request.url.path.startswith("/api/fleet/legacy/cases/") and request.url.path.endswith("/report.pdf")
        formdev_write = request.url.path.startswith("/api/formdev/") or request.url.path.startswith("/api/reports/studio/")
        # Workflow Studio (admin-only writes, checked by the routes).
        formdev_write = formdev_write or request.url.path.startswith("/api/fleet/workflows")
        # AI Studio chats and kept visuals (permission checked by the routes).
        formdev_write = formdev_write or request.url.path.startswith("/api/ai-studio/")
        if request.url.path not in {"/api/auth/login", "/api/auth/logout"} and not request.url.path.startswith("/api/fleet/control") and not canopy_preference_write and not report_generation and not formdev_write:
            return JSONResponse(
                status_code=403,
                content={"error": "Flora Canopy is read-only"},
            )
    return await call_next(request)


@app.middleware("http")
async def public_api_access_log(request: Request, call_next):
    """Every public API / MCP request is logged, with the case ids it returned."""
    if API_MODE != "canopy" or not request.url.path.startswith("/api/v1/"):
        return await call_next(request)
    started = time.monotonic()
    status, error = 500, None
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    except Exception as exc:
        error = type(exc).__name__
        raise
    finally:
        try:
            with pool.connection() as database:
                api_keys.log_request(database, request, status, int((time.monotonic() - started) * 1000), error)
        except Exception:  # logging must never break the API
            pass


@app.exception_handler(HTTPException)
async def legacy_http_error(_: Request, error: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"error": error.detail})


@app.exception_handler(FormDevError)
async def formdev_error(_: Request, error: FormDevError) -> JSONResponse:
    headers = {}
    if isinstance(error.details, dict) and "retry_after" in error.details:
        headers["Retry-After"] = str(error.details["retry_after"])
    return JSONResponse(status_code=error.status, content={"error": error.message, **error.as_dict()}, headers=headers)


@app.get("/health")
def health(database: Connection = Depends(connection)) -> dict:
    database.execute("SELECT 1").fetchone()
    return {"status": "OK", "data_ready": True, "data_mode": "local" if API_MODE == "leaf" else "server", "api_mode": API_MODE}
