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
from .routes.legacy_archive import router as legacy_archive_router
from .routes.canopy_reports import router as canopy_reports_router
from .routes.canopy_preferences import router as canopy_preferences_router
from .routes.canopy_users import router as canopy_users_router
from .routes.sync_ingest import router as sync_ingest_router
from .routes.workstation import router as workstation_router
from .routes.terminology import router as terminology_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    api_mode = os.getenv("FLORA_API_MODE", "leaf").strip().lower()
    if api_mode in {"leaf", "canopy"}:
        with pool.connection() as database:
            ensure_bootstrap_admin(database)
    if api_mode == "leaf":
        device_writer.start()
    yield
    device_writer.stop()
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
    app.include_router(fleet_read_router)
    app.include_router(fleet_control_router)
    app.include_router(legacy_archive_router)
    app.include_router(canopy_reports_router)
if API_MODE == "sync":
    app.include_router(sync_ingest_router)


@app.middleware("http")
async def enforce_canopy_read_only(request: Request, call_next):
    if API_MODE == "canopy" and request.method not in {"GET", "HEAD", "OPTIONS"}:
        canopy_preference_write = request.url.path.startswith("/api/auth/preferences/") or request.url.path.startswith("/api/auth/self/")
        canopy_preference_write = canopy_preference_write or request.url.path.startswith("/api/auth/users/") or request.url.path == "/api/auth/users"
        report_generation = request.method == "POST" and request.url.path.startswith("/api/fleet/legacy/cases/") and request.url.path.endswith("/report.pdf")
        if request.url.path not in {"/api/auth/login", "/api/auth/logout"} and not request.url.path.startswith("/api/fleet/control") and not canopy_preference_write and not report_generation:
            return JSONResponse(
                status_code=403,
                content={"error": "Flora Canopy is read-only"},
            )
    return await call_next(request)


@app.exception_handler(HTTPException)
async def legacy_http_error(_: Request, error: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"error": error.detail})


@app.get("/health")
def health(database: Connection = Depends(connection)) -> dict:
    database.execute("SELECT 1").fetchone()
    return {"status": "OK", "data_ready": True, "data_mode": "local" if API_MODE == "leaf" else "server", "api_mode": API_MODE}
