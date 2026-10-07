"""Process-wide FormDev wiring shared by the Phase 3 and Phase 4 routes.

- storage selection (FORMDEV_STORAGE: postgresql | sqlite:/path | json:/folder)
- principals: the caller's current RBAC roles/permissions loaded from auth_user (not the role
  frozen in the session token); deactivated users and pending password changes get 401
- the QueryRuntime singleton (cache, limits, statistics, cursor secret)
- background job worker and statistics flusher, started and stopped by the API lifespan
"""
from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Callable

from fastapi import HTTPException, Request
from psycopg import Connection
from psycopg_pool import PoolTimeout

from ..database import job_pool, pool
from ..formdev.logic import permission
from ..formdev import FormDevServices, services_for
from ..formdev.adapters.postgres import PostgreSQLAdapter
from ..formdev.adapters.jsonfiles import JsonFileAdapter
from ..formdev.adapters.sqlite import SQLiteAdapter
from ..formdev.errors import FormDevError
from ..formdev.query.access import Principal
from ..formdev.query.catalog import build_catalog
from ..formdev.query.engine import QueryRuntime
from ..formdev.query.jobs import JobWorker, ResultStore, enqueue_reindex
from .auth_canopy import read_token
from .auth_leaf import entitlements

LOG = logging.getLogger("formdev.runtime")
STORAGE = os.getenv("FORMDEV_STORAGE", "postgresql").strip()
PRINCIPAL_TTL_S = 30
POOL_TIMEOUT_S = float(os.getenv("FORMDEV_POOL_TIMEOUT_S", "2"))

_lock = threading.Lock()
_runtime: QueryRuntime | None = None
_sqlite: SQLiteAdapter | None = None
_store: ResultStore | None = None
_worker: JobWorker | None = None
_flusher: threading.Thread | None = None
_stop = threading.Event()
_principals: dict[Any, tuple[float, Principal | None]] = {}
jobs_available = False


def runtime() -> QueryRuntime:
    global _runtime
    with _lock:
        if _runtime is None:
            _runtime = QueryRuntime(test_hooks=os.getenv("FORMDEV_TEST_HOOKS") == "1")
        return _runtime


def sqlite_adapter() -> SQLiteAdapter:
    """The single local store: a SQLite file (sqlite:/path) or a folder of JSON files (json:/path)."""
    global _sqlite
    with _lock:
        if _sqlite is None:
            _sqlite = JsonFileAdapter(STORAGE[len("json:"):]) if STORAGE.startswith("json:") else SQLiteAdapter(STORAGE[len("sqlite:"):])
        return _sqlite


def store() -> ResultStore:
    global _store
    with _lock:
        if _store is None:
            root = os.getenv("FORMDEV_JOB_DIR", "/var/lib/flora/formdev-jobs")
            try:
                _store = ResultStore(root)
            except OSError:
                fallback = os.path.join(tempfile.gettempdir(), "formdev-jobs")
                LOG.warning("FORMDEV_JOB_DIR %s is not writable; using %s (results do not survive container rebuilds)", root, fallback)
                _store = ResultStore(fallback)
        return _store


def services_on(adapter: Any) -> FormDevServices:
    return services_for(adapter, enqueue_reindex=enqueue_reindex(adapter, runtime().clock_ms))


@contextmanager
def checkout(source: Any = None) -> Iterator[Connection]:
    """A pooled connection, or 503 database_busy after a short wait (never a 30 s hang)."""
    try:
        with (source or pool).connection(timeout=POOL_TIMEOUT_S) as connection:
            yield connection
    except PoolTimeout:
        raise FormDevError("database_busy", "The database is busy; try again shortly", 503, {"retry_after": 2}) from None


@contextmanager
def storage(connection: Connection) -> Iterator[FormDevServices]:
    if STORAGE.startswith(("sqlite:", "json:")):
        yield services_on(sqlite_adapter())
    else:
        yield services_on(PostgreSQLAdapter(connection))


def load_principal(connection: Connection, user_id: Any) -> Principal | None:
    row = connection.execute(
        "SELECT id, username, role, is_active, must_change_password FROM auth_user WHERE id = %s", (user_id,)
    ).fetchone()
    if row is None or not row["is_active"] or row.get("must_change_password"):
        return None
    roles, permissions = entitlements(connection, row)
    return Principal(int(row["id"]), row["username"], tuple(roles), tuple(permissions))


def principal_for(request: Request, connection: Connection) -> Principal:
    payload = read_token(request)
    key = payload.get("sub")
    now = time.monotonic()
    cached = _principals.get(key)
    if cached is None or cached[0] < now:
        principal = load_principal(connection, key)
        _principals[key] = (now + PRINCIPAL_TTL_S, principal)
        if len(_principals) > 5000:
            for stale in [k for k, (expiry, _) in _principals.items() if expiry < now]:
                _principals.pop(stale, None)
    principal = _principals[key][1]
    if principal is None:
        raise HTTPException(status_code=401, detail="sign in required")
    return principal


def token_subject(request: Request) -> str:
    return str(read_token(request).get("sub"))


def published_definition(services: FormDevServices, form_id: str) -> dict[str, Any] | None:
    try:
        return services.schemas.latest_published(form_id)["definition"]
    except FormDevError:
        return None


def hidden_fields(services: FormDevServices, principal: Principal):
    """form_id -> fields this principal may not read: the form's field policy (Phase 4) plus the definition's
    view permissions (Phase 2.8)."""
    cache: dict[str, set[str]] = {}

    def hidden(form_id: str) -> set[str]:
        if form_id not in cache:
            denied: set[str] = set()
            if services.adapter.get_form_policy(form_id) is not None:
                try:
                    denied = set(build_catalog(services, form_id, with_relations=False).denied_fields(principal))
                except FormDevError:
                    denied = set()
            definition = published_definition(services, form_id)
            if definition is not None:
                denied |= permission.denied(definition, "view", principal.codes, principal.is_admin, nested=True)
            cache[form_id] = denied
        return cache[form_id]

    return hidden


def write_guard(services: FormDevServices, principal: Principal) -> tuple[Callable[[str], set[str]], Callable[[str, str], bool]]:
    """(form_id -> fields this principal may not change, (form_id, action) -> allowed) for sync writes (Phase 2.8)."""
    hidden = hidden_fields(services, principal)

    def locked(form_id: str) -> set[str]:
        definition = published_definition(services, form_id)
        edit = permission.denied(definition, "edit", principal.codes, principal.is_admin) if definition is not None else set()
        return hidden(form_id) | edit

    def allows(form_id: str, action: str) -> bool:
        definition = published_definition(services, form_id)
        return definition is None or permission.record_allows(definition, action, principal.codes, principal.is_admin)

    return locked, allows


# Background work ---------------------------------------------------------------------------------
@contextmanager
def _job_services() -> Iterator[FormDevServices]:
    if STORAGE.startswith(("sqlite:", "json:")):
        yield services_on(sqlite_adapter())
        return
    with job_pool.connection(timeout=10) as connection:
        yield services_on(PostgreSQLAdapter(connection))


def _job_principal(user_id: Any) -> Principal | None:
    with job_pool.connection(timeout=10) as connection:
        return load_principal(connection, user_id)


def _flush_loop() -> None:
    while not _stop.wait(30):
        flush_stats()


def flush_stats() -> None:
    def write(rows: list[dict[str, Any]]) -> None:
        with _job_services() as services:
            with services.adapter.transaction():
                services.adapter.flush_query_stats(rows)

    runtime().stats.flush(write)


def start_background() -> None:
    """Start job workers and the statistics flusher. Failures disable jobs, never the API."""
    global _worker, _flusher, jobs_available
    try:
        job_pool.open(wait=False)
        _worker = JobWorker(runtime(), _job_services, _job_principal, store())
        _worker.start()
        _stop.clear()
        _flusher = threading.Thread(target=_flush_loop, name="formdev-stats", daemon=True)
        _flusher.start()
        jobs_available = True
    except Exception:  # noqa: BLE001
        LOG.exception("FormDev background jobs are unavailable")
        jobs_available = False


def stop_background() -> None:
    global _worker, jobs_available
    jobs_available = False
    _stop.set()
    if _worker is not None:
        _worker.stop(5.0)
        _worker = None
    try:
        flush_stats()
    except Exception:  # noqa: BLE001
        LOG.warning("final FormDev statistics flush failed", exc_info=True)
