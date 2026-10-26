"""Canopy activity log (Administrator → Logs): sign-ins (failed ones too), sign-outs, every write
request and every patient chart or report opened, by whom, from where (0096-canopy-activity-log.sql).

Request bodies are never stored (they hold passwords and patient data); only the method, path,
query string and outcome. Logging must never break a request.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from fastapi import Request

from . import tenancy
from .database import pool

log = logging.getLogger(__name__)

READ_METHODS = {"GET", "HEAD", "OPTIONS"}
# Reads worth logging: a patient's chart or a printed report.
LOGGED_READS = (
    re.compile(r"^/api/fleet/(legacy/)?cases/[^/]+/snapshot$"),
    re.compile(r"^/api/fleet/central/cases/[^/]+/snapshot$"),
    re.compile(r"\.pdf$"),
)
# Longest prefix first.
CATEGORIES = (
    ("/api/auth/login", "sign-in"),
    ("/api/auth/logout", "sign-in"),
    ("/api/auth/users", "users"),
    ("/api/auth/preferences/ai-service", "configuration"),
    ("/api/auth/preferences", "preferences"),
    ("/api/auth/self", "preferences"),
    ("/api/fleet/admissions/or", "or-schedule"),
    ("/api/fleet/admissions", "admission"),
    ("/api/fleet/control/billing", "billing"),
    ("/api/fleet/control/staff", "staff"),
    ("/api/fleet/control/device-management", "devices"),
    ("/api/fleet/control/integrations", "integration"),
    ("/api/fleet/control", "configuration"),
    ("/api/fleet/workflows", "workflow-studio"),
    ("/api/fleet/legacy", "chart-view"),
    ("/api/fleet/central", "chart-view"),
    ("/api/fleet/cases", "chart-view"),
    ("/api/formdev", "form-studio"),
    ("/api/reports/studio", "report-studio"),
    ("/api/reports", "report"),
    ("/api/ai-studio", "ai-studio"),
    ("/api/platform", "platform"),
    ("/api/v1", "public-api"),
    ("/api/integrations", "integration"),
)
VERBS = {"GET": "view", "POST": "create", "PUT": "update", "PATCH": "update", "DELETE": "delete"}


def category(path: str) -> str:
    for prefix, name in CATEGORIES:
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "."):
            return name
    return "other"


def action(method: str, path: str) -> str:
    if path == "/api/auth/logout":
        return "sign out"
    if path.endswith(".pdf"):
        return "print report"
    if method == "GET" and path.endswith("/snapshot"):
        return "open chart"
    resource = path.removeprefix("/api/").removeprefix("fleet/").removeprefix("control/")
    return f"{VERBS.get(method, method.lower())} {resource}"


def should_log(method: str, path: str) -> bool:
    if not path.startswith("/api/") or path == "/api/auth/login":   # sign-in is logged by the route
        return False
    if method not in READ_METHODS:
        return True
    return method == "GET" and any(pattern.search(path) for pattern in LOGGED_READS)


def _client(request: Request) -> tuple[str | None, str]:
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or (request.client.host if request.client else None)
    return ip, (request.headers.get("user-agent") or "")[:300]


def actor_of(request: Request) -> dict[str, Any]:
    from .routes.auth_canopy import verified_payload

    token = request.headers.get("x-flora-session", "").strip()
    authorization = request.headers.get("authorization", "").strip()
    if not token and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if token.startswith("flk_"):
        parts = token.split("_")
        return {"username": f"api-key:{parts[1] if len(parts) == 3 else '?'}", "role": "api_key"}
    payload = verified_payload(token) if token else None
    if not payload:
        return {}
    return {"user_id": payload.get("sub"), "username": payload.get("username"), "user_name": payload.get("name"), "role": payload.get("role")}


def write(entry: dict[str, Any], account: tenancy.Account | None = None) -> None:
    """Insert one row in the current (or the given) account's schema; never raises."""
    def insert() -> None:
        with pool.connection() as database:
            database.execute(
                """INSERT INTO canopy_activity_log(at,user_id,username,user_name,role,category,action,method,path,query,
                       status,ok,duration_ms,ip,user_agent,detail)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (int(time.time() * 1000), entry.get("user_id"), entry.get("username"), entry.get("user_name"), entry.get("role"),
                 entry["category"], entry["action"], entry.get("method"), entry.get("path"), entry.get("query"),
                 entry.get("status"), entry.get("ok", True), entry.get("duration_ms"), entry.get("ip"), entry.get("user_agent"),
                 json.dumps(entry["detail"], separators=(",", ":")) if entry.get("detail") else None),
            )
    try:
        if account is not None:
            with tenancy.using(account):
                insert()
        elif not tenancy.MULTI_ACCOUNT or tenancy.current_account() is not None:
            insert()
    except Exception:  # noqa: BLE001 - logging must never break the API
        log.exception("activity log write failed")


def record_request(request: Request, status: int, duration_ms: int, error: str | None = None,
                   account: tenancy.Account | None = None) -> None:
    """Runs in a worker thread, so the request's account is passed in."""
    path = request.url.path
    ip, user_agent = _client(request)
    write({
        **actor_of(request), "category": category(path), "action": action(request.method, path),
        "method": request.method, "path": path, "query": request.url.query or None, "status": status,
        "ok": status < 400 and error is None, "duration_ms": duration_ms, "ip": ip, "user_agent": user_agent,
        "detail": {"error": error} if error else None,
    }, account)


def record_sign_in(request: Request, username: str, account: tenancy.Account | None, user: dict[str, Any] | None,
                   status: int, reason: str | None = None) -> None:
    ip, user_agent = _client(request)
    write({
        "user_id": user.get("id") if user else None, "username": (user or {}).get("username") or username,
        "user_name": user.get("name") if user else None, "role": user.get("role") if user else None,
        "category": "sign-in", "action": "sign in" if user else "sign in failed", "method": "POST", "path": "/api/auth/login",
        "status": status, "ok": user is not None, "ip": ip, "user_agent": user_agent,
        "detail": {"reason": reason} if reason else None,
    }, account)
