"""Operator sign-in for Flora Root: accounts, sessions, lockout and audit trail.

- Operators live in `root_user` (scrypt hashes, role admin or viewer). On first
  start, when no operator exists, one admin is created from ROOT_ADMIN_USERNAME /
  ROOT_ADMIN_PASSWORD (demo default admin / admin).
- The browser signs in at /login and receives an HttpOnly, SameSite=Strict
  session cookie. Only the token's sha256 is stored. Sessions end after
  ROOT_SESSION_IDLE_MIN without activity or ROOT_SESSION_HOURS in total.
- Scripts (Root CI) keep working with HTTP Basic or `x-root-key: $ROOT_ADMIN_KEY`.
- ROOT_MAX_FAILED_LOGINS wrong passwords lock the account for ROOT_LOCK_MIN
  minutes; each IP is also throttled. Every sign-in, failure and change is
  written to `root_audit`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import time
from collections import defaultdict, deque
from typing import Any
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, RedirectResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

COOKIE = "flora_root_session"
ADMIN_KEY = os.getenv("ROOT_ADMIN_KEY", "").strip()
SESSION_MS = int(os.getenv("ROOT_SESSION_HOURS", "8")) * 3_600_000
IDLE_MS = int(os.getenv("ROOT_SESSION_IDLE_MIN", "30")) * 60_000
MAX_FAILED = int(os.getenv("ROOT_MAX_FAILED_LOGINS", "5"))
LOCK_MS = int(os.getenv("ROOT_LOCK_MIN", "15")) * 60_000
IP_WINDOW_MS, IP_MAX_FAILURES = 10 * 60_000, 20
MIN_PASSWORD = 10
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}
_ip_failures: dict[str, deque[int]] = defaultdict(deque)
pool = None  # set by install()


def now_ms() -> int:
    return int(time.time() * 1000)


# ------------------------------------------------------------------ passwords

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return "scrypt${n}${r}${p}${salt}${digest}".format(**_SCRYPT, salt=salt.hex(), digest=digest.hex())


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), dklen=len(digest) // 2,
                                   n=int(n), r=int(r), p=int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate.hex(), digest)


def password_problem(password: str, username: str) -> str | None:
    if len(password) < MIN_PASSWORD:
        return f"use at least {MIN_PASSWORD} characters"
    if password.lower() == username.lower() or password.lower() in {"admin", "password", "flora-root"}:
        return "choose a password that is not easy to guess"
    return None


# ------------------------------------------------------------------ store helpers

def one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    with pool.connection() as connection:
        return connection.execute(sql, params).fetchone()


def run(sql: str, params: tuple = ()) -> None:
    with pool.connection() as connection:
        connection.execute(sql, params)


def client_ip(request: Request) -> str:
    return (request.headers.get("x-real-ip") or (request.client.host if request.client else "") or "").strip()


def audit(username: str | None, action: str, target: str | None = None, ip: str | None = None,
          detail: dict[str, Any] | None = None) -> None:
    run("INSERT INTO root_audit (at, username, action, target, ip, detail) VALUES (%s,%s,%s,%s,%s,%s)",
        (now_ms(), username, action, target, ip, Jsonb(detail or {})))


def ensure_bootstrap_admin() -> None:
    if one("SELECT 1 FROM root_user LIMIT 1"):
        return
    current = now_ms()
    username = os.getenv("ROOT_ADMIN_USERNAME", "admin")
    must_change = os.getenv("ROOT_BOOTSTRAP_MUST_CHANGE_PASSWORD", "false").lower() == "true"
    run("""INSERT INTO root_user (username, password_hash, display_name, role, must_change_password, created_at, updated_at)
           VALUES (%s,%s,%s,'admin',%s,%s,%s) ON CONFLICT (username) DO NOTHING""",
        (username, hash_password(os.getenv("ROOT_ADMIN_PASSWORD", "admin")), "Root Administrator", must_change,
         current, current))
    audit("system", "user.bootstrap", username)


# ------------------------------------------------------------------ sessions

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {key: user.get(key) for key in ("id", "username", "display_name", "role", "must_change_password")}


def authenticate(username: str, password: str, ip: str) -> dict[str, Any]:
    """Returns the user or raises 401/423/429. Unknown names cost the same time as wrong passwords."""
    current = now_ms()
    failures = _ip_failures[ip]
    while failures and failures[0] < current - IP_WINDOW_MS:
        failures.popleft()
    if len(failures) >= IP_MAX_FAILURES:
        audit(username, "login.throttled", None, ip)
        raise HTTPException(429, "too many attempts from this address; wait a few minutes")
    user = one("SELECT * FROM root_user WHERE lower(username)=lower(%s)", (username,))
    if user and user["locked_until"] and user["locked_until"] > current:
        audit(user["username"], "login.locked", None, ip)
        minutes = max(1, round((user["locked_until"] - current) / 60_000))
        raise HTTPException(423, f"account locked after repeated failures; try again in {minutes} min")
    valid = verify_password(password, user["password_hash"]) if user else (hash_password(password) and False)
    if not user or not valid or not user["enabled"]:
        failures.append(current)
        if user and user["enabled"]:
            count = user["failed_logins"] + 1
            locked = current + LOCK_MS if count >= MAX_FAILED else None
            run("UPDATE root_user SET failed_logins=%s, locked_until=%s WHERE id=%s",
                (0 if locked else count, locked, user["id"]))
            audit(user["username"], "login.failed", None, ip, {"locked": bool(locked)})
            if locked:
                raise HTTPException(423, f"account locked for {LOCK_MS // 60_000} min after {MAX_FAILED} failed attempts")
        else:
            audit(username[:64], "login.failed", None, ip, {"reason": "disabled" if user else "unknown user"})
        raise HTTPException(401, "username or password is incorrect")
    return user


def create_session(user: dict[str, Any], request: Request) -> str:
    token = secrets.token_urlsafe(32)
    current = now_ms()
    with pool.connection() as connection:
        connection.execute("DELETE FROM root_session WHERE expires_at < %s OR last_seen_at < %s", (current, current - IDLE_MS))
        connection.execute(
            """INSERT INTO root_session (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (_token_hash(token), user["id"], current, current + SESSION_MS, current, client_ip(request),
             request.headers.get("user-agent", "")[:300]))
        connection.execute("UPDATE root_user SET last_login_at=%s, failed_logins=0, locked_until=NULL WHERE id=%s",
                           (current, user["id"]))
    return token


def session_user(token: str) -> dict[str, Any] | None:
    current = now_ms()
    row = one(
        """SELECT u.*, s.token_hash, s.created_at AS session_created_at, s.expires_at AS session_expires_at,
                  s.last_seen_at AS session_last_seen_at
           FROM root_session s JOIN root_user u ON u.id = s.user_id
           WHERE s.token_hash=%s AND s.expires_at > %s AND s.last_seen_at > %s AND u.enabled""",
        (_token_hash(token), current, current - IDLE_MS))
    if row and current - row["session_last_seen_at"] > 60_000:  # sliding idle timeout, written at most once a minute
        run("UPDATE root_session SET last_seen_at=%s WHERE token_hash=%s", (current, row["token_hash"]))
    return row


def basic_user(header: str, ip: str) -> dict[str, Any] | None:
    try:
        username, _, password = base64.b64decode(header[6:]).decode().partition(":")
    except (ValueError, UnicodeDecodeError):
        return None
    try:
        return authenticate(username, password, ip)
    except HTTPException:
        return None


def resolve_user(request: Request) -> tuple[dict[str, Any] | None, str]:
    token = request.cookies.get(COOKIE)
    if token and (user := session_user(token)):
        return user, "session"
    if ADMIN_KEY and hmac.compare_digest(request.headers.get("x-root-key", ""), ADMIN_KEY):
        return {"id": None, "username": "root-ci", "display_name": "Root CI", "role": "admin",
                "must_change_password": False}, "key"
    # HTTP Basic is for scripts only. Browsers replay cached Basic credentials on their own
    # (e.g. from before sign-in existed), which would make sign-out impossible, so any request
    # carrying a browser's Sec-Fetch-* headers must use a session.
    header = request.headers.get("authorization", "")
    from_browser = any(name in request.headers for name in ("sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"))
    if header.lower().startswith("basic ") and not from_browser and (user := basic_user(header, client_ip(request))):
        return user, "basic"
    return None, ""


def same_origin(request: Request) -> bool:
    """Cookie-authenticated writes must come from Root's own page (CSRF defence on top of SameSite)."""
    origin = request.headers.get("origin") or request.headers.get("referer")
    if not origin:
        return False
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(":")[0]
    return urlparse(origin).hostname == host


# ------------------------------------------------------------------ dependencies

def current_user(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "sign in required")
    return user


def require_admin(request: Request) -> None:
    if current_user(request).get("role") != "admin":
        raise HTTPException(403, "this needs a Root administrator")


# ------------------------------------------------------------------ middleware

def install(app: FastAPI, connection_pool, public: list[str]) -> None:
    global pool
    pool = connection_pool
    patterns = [re.compile(p) for p in [*public, r"/login", r"/api/auth/login", r"/brand/.*", r"/favicon\.ico"]]
    password_paths = {"/api/auth/me", "/api/auth/password", "/api/auth/logout"}

    @app.middleware("http")
    async def require_operator(request: Request, call_next):
        path = request.url.path
        if any(pattern.fullmatch(path) for pattern in patterns):
            return await call_next(request)
        user, method = await run_in_threadpool(resolve_user, request)
        if user is None:
            if path.startswith("/api/"):
                return JSONResponse({"detail": "sign in required"}, status_code=401)
            return RedirectResponse(f"/login?next={quote(path)}", status_code=303)
        unsafe = request.method not in {"GET", "HEAD", "OPTIONS"}
        if method == "session" and unsafe and not same_origin(request):
            return JSONResponse({"detail": "cross-site request refused"}, status_code=403)
        if user.get("must_change_password") and path not in password_paths:
            if path.startswith("/api/"):
                return JSONResponse({"detail": "password change required"}, status_code=403)
            return RedirectResponse("/login?change=1", status_code=303)
        request.state.user = user
        response = await call_next(request)
        if unsafe and path.startswith("/api/") and not path.startswith("/api/auth/"):
            await run_in_threadpool(audit, user["username"], f"{request.method} {path}", None, client_ip(request),
                                    {"status": response.status_code, "via": method})
        return response


# ------------------------------------------------------------------ routes

router = APIRouter()


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


@router.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
    ip = client_ip(request)
    user = authenticate(body.username.strip(), body.password, ip)
    previous = one("""SELECT at, ip FROM root_audit WHERE username=%s AND action='login.ok' ORDER BY at DESC LIMIT 1""",
                   (user["username"],))
    failed_since = one("""SELECT count(*) AS n FROM root_audit WHERE username=%s AND action='login.failed' AND at > %s""",
                       (user["username"], previous["at"] if previous else 0))["n"]
    token = create_session(user, request)
    audit(user["username"], "login.ok", None, ip)
    secure = request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https"
    response.set_cookie(COOKIE, token, max_age=SESSION_MS // 1000, httponly=True, secure=secure, samesite="strict", path="/")
    return {"user": public_user(user), "previous_login": previous, "failed_since_previous": failed_since,
            "idle_minutes": IDLE_MS // 60_000}


@router.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        run("DELETE FROM root_session WHERE token_hash=%s", (_token_hash(token),))
        audit(getattr(request.state, "user", {}).get("username"), "logout", None, client_ip(request))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
def me(user: dict = Depends(current_user)):
    return {"user": public_user(user), "session": {
        "created_at": user.get("session_created_at"), "expires_at": user.get("session_expires_at"),
        "idle_minutes": IDLE_MS // 60_000}}


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(max_length=256)


@router.post("/api/auth/password")
def change_password(body: PasswordIn, request: Request, user: dict = Depends(current_user)):
    if user.get("id") is None:
        raise HTTPException(400, "machine credentials have no password")
    stored = one("SELECT password_hash FROM root_user WHERE id=%s", (user["id"],))
    if not verify_password(body.current_password, stored["password_hash"]):
        audit(user["username"], "password.failed", None, client_ip(request))
        raise HTTPException(400, "current password is incorrect")
    if problem := password_problem(body.new_password, user["username"]):
        raise HTTPException(422, problem)
    keep = request.cookies.get(COOKIE)
    with pool.connection() as connection:
        connection.execute("UPDATE root_user SET password_hash=%s, must_change_password=false, updated_at=%s WHERE id=%s",
                           (hash_password(body.new_password), now_ms(), user["id"]))
        # Every other browser signed in as this operator is signed out.
        connection.execute("DELETE FROM root_session WHERE user_id=%s AND token_hash<>%s",
                           (user["id"], _token_hash(keep) if keep else ""))
    audit(user["username"], "password.changed", None, client_ip(request))
    return {"ok": True}


# Operators and audit trail (admin only)

class UserIn(BaseModel):
    username: str = Field(pattern=r"^[a-zA-Z0-9._-]{3,40}$")
    display_name: str | None = Field(None, max_length=80)
    role: str = Field("viewer", pattern=r"^(admin|viewer)$")
    password: str = Field(max_length=256)


class UserPatch(BaseModel):
    display_name: str | None = Field(None, max_length=80)
    role: str | None = Field(None, pattern=r"^(admin|viewer)$")
    enabled: bool | None = None
    password: str | None = Field(None, max_length=256)  # admin reset: the operator must change it at next sign-in


@router.get("/api/v1/users", dependencies=[Depends(require_admin)])
def list_users():
    with pool.connection() as connection:
        rows = connection.execute(
            """SELECT u.id, u.username, u.display_name, u.role, u.enabled, u.must_change_password, u.locked_until,
                      u.last_login_at, u.created_at,
                      (SELECT count(*) FROM root_session s WHERE s.user_id=u.id AND s.expires_at > %s) AS sessions
               FROM root_user u ORDER BY u.username""", (now_ms(),)).fetchall()
    return {"rows": rows}


@router.post("/api/v1/users", dependencies=[Depends(require_admin)], status_code=201)
def create_user(body: UserIn):
    if problem := password_problem(body.password, body.username):
        raise HTTPException(422, problem)
    current = now_ms()
    with pool.connection() as connection:
        if connection.execute("SELECT 1 FROM root_user WHERE lower(username)=lower(%s)", (body.username,)).fetchone():
            raise HTTPException(409, "username exists")
        row = connection.execute(
            """INSERT INTO root_user (username, password_hash, display_name, role, must_change_password, created_at, updated_at)
               VALUES (%s,%s,%s,%s,true,%s,%s) RETURNING id""",
            (body.username, hash_password(body.password), body.display_name, body.role, current, current)).fetchone()
    return {"id": row["id"]}


@router.put("/api/v1/users/{user_id}", dependencies=[Depends(require_admin)])
def update_user(user_id: int, body: UserPatch, user: dict = Depends(current_user)):
    target = one("SELECT * FROM root_user WHERE id=%s", (user_id,))
    if target is None:
        raise HTTPException(404, "no such operator")
    if user.get("id") == user_id and (body.enabled is False or body.role == "viewer"):
        raise HTTPException(409, "you cannot disable or demote your own account")
    if (body.enabled is False or body.role == "viewer") and target["role"] == "admin" and one(
            "SELECT count(*) AS n FROM root_user WHERE role='admin' AND enabled AND id<>%s", (user_id,))["n"] == 0:
        raise HTTPException(409, "Root needs at least one enabled administrator")
    fields, values = [], []
    for column in ("display_name", "role", "enabled"):
        value = getattr(body, column)
        if value is not None:
            fields.append(f"{column}=%s")
            values.append(value)
    if body.password:
        if problem := password_problem(body.password, target["username"]):
            raise HTTPException(422, problem)
        fields += ["password_hash=%s", "must_change_password=true", "failed_logins=0", "locked_until=NULL"]
        values.append(hash_password(body.password))
    if not fields:
        return {"id": user_id}
    with pool.connection() as connection:
        connection.execute(f"UPDATE root_user SET {', '.join(fields)}, updated_at=%s WHERE id=%s", (*values, now_ms(), user_id))
        if body.enabled is False or body.password:
            connection.execute("DELETE FROM root_session WHERE user_id=%s", (user_id,))
    return {"id": user_id}


@router.post("/api/v1/users/{user_id}/unlock", dependencies=[Depends(require_admin)])
def unlock_user(user_id: int):
    run("UPDATE root_user SET failed_logins=0, locked_until=NULL WHERE id=%s", (user_id,))
    return {"id": user_id}


@router.get("/api/v1/audit", dependencies=[Depends(require_admin)])
def audit_log(limit: int = 100, before: int | None = None):
    with pool.connection() as connection:
        rows = connection.execute(
            "SELECT * FROM root_audit WHERE at < %s ORDER BY at DESC LIMIT %s",
            (before or now_ms() + 1, max(1, min(limit, 500)))).fetchall()
    return {"rows": rows}
