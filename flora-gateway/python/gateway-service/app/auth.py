"""Admin sign-in for the gateway station page and API.

Users live in `gateway_user` with scrypt password hashes. The browser signs in
at /login and gets an HttpOnly session cookie; scripts may send HTTP Basic with
the same username and password. On first start, when no user exists, one is
created from GATEWAY_ADMIN_USERNAME / GATEWAY_ADMIN_PASSWORD (default admin / admin).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, RedirectResponse

from . import db, settings

COOKIE = "flora_gw_session"
SESSION_MS = settings.SESSION_HOURS * 3600 * 1000
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return "scrypt${n}${r}${p}${salt}${digest}".format(
        **_SCRYPT, salt=salt.hex(), digest=digest.hex())


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


def ensure_default_admin() -> None:
    if db.fetch_one("SELECT 1 FROM gateway_user LIMIT 1"):
        return
    current = db.now_ms()
    db.execute("""INSERT INTO gateway_user (username,password_hash,display_name,role,created_at,updated_at)
                  VALUES (%s,%s,%s,'admin',%s,%s) ON CONFLICT (username) DO NOTHING""",
               (settings.ADMIN_USERNAME, hash_password(settings.ADMIN_PASSWORD), "Administrator", current, current))


def authenticate(username: str, password: str) -> dict[str, Any] | None:
    user = db.fetch_one("SELECT * FROM gateway_user WHERE username=%s AND enabled", (username,))
    if user is None:
        hash_password(password)  # same cost as a real check, so unknown names are not faster
        return None
    return user if verify_password(password, user["password_hash"]) else None


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    current = db.now_ms()
    db.execute("DELETE FROM gateway_session WHERE expires_at < %s", (current,))
    db.execute("INSERT INTO gateway_session (token_hash,user_id,created_at,expires_at) VALUES (%s,%s,%s,%s)",
               (_token_hash(token), user_id, current, current + SESSION_MS))
    db.execute("UPDATE gateway_user SET last_login_at=%s WHERE id=%s", (current, user_id))
    return token


def end_session(token: str | None) -> None:
    if token:
        db.execute("DELETE FROM gateway_session WHERE token_hash=%s", (_token_hash(token),))


def end_user_sessions(user_id: int, keep_token: str | None = None) -> None:
    db.execute("DELETE FROM gateway_session WHERE user_id=%s AND token_hash<>%s",
               (user_id, _token_hash(keep_token) if keep_token else ""))


def _session_user(token: str) -> dict[str, Any] | None:
    return db.fetch_one(
        """SELECT u.id, u.username, u.display_name, u.role FROM gateway_session s JOIN gateway_user u ON u.id = s.user_id
           WHERE s.token_hash=%s AND s.expires_at > %s AND u.enabled""",
        (_token_hash(token), db.now_ms()))


def _basic_user(header: str) -> dict[str, Any] | None:
    try:
        username, _, password = base64.b64decode(header[6:]).decode().partition(":")
    except (ValueError, UnicodeDecodeError):
        return None
    user = authenticate(username, password)
    return user and {"id": user["id"], "username": user["username"], "display_name": user["display_name"],
                     "role": user["role"]}


def resolve_user(request: Request) -> dict[str, Any] | None:
    token = request.cookies.get(COOKIE)
    if token:
        user = _session_user(token)
        if user:
            return user
    header = request.headers.get("authorization", "")
    if header.lower().startswith("basic "):
        return _basic_user(header)
    return None


def require_role_admin(request: Request) -> None:
    """Route dependency: station-level settings (device types, manufacturers, users) are admin-only."""
    if (getattr(request.state, "user", None) or {}).get("role") != "admin":
        raise HTTPException(403, "admin role required")


def install(app: FastAPI, public: list[str]) -> None:
    patterns = [re.compile(pattern) for pattern in public]

    @app.middleware("http")
    async def require_user(request: Request, call_next):
        if any(pattern.fullmatch(request.url.path) for pattern in patterns):
            return await call_next(request)
        user = await run_in_threadpool(resolve_user, request)
        if user is not None:
            request.state.user = user
            return await call_next(request)
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "sign in required"}, status_code=401)
        return RedirectResponse("/login", status_code=303)
