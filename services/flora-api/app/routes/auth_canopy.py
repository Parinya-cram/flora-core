import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg import Connection
from pydantic import BaseModel

from .. import central_auth
from ..database import connection
from .auth_leaf import attach_entitlements, public_user as shared_public_user


router = APIRouter(prefix="/api/auth", tags=["authentication"])
SESSION_TTL_SECONDS = int(os.getenv("FLORA_CANOPY_SESSION_TTL_SECONDS", "28800"))
SESSION_SECRET = os.environ.get("FLORA_CANOPY_SESSION_SECRET", "")


class LoginRequest(BaseModel):
    username: str
    password: str


def encode_part(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode_part(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def public_user(row: dict[str, Any]) -> dict[str, Any]:
    return shared_public_user(row)


def verify_password(password: str, salt_hex: str, expected_hex: str) -> bool:
    try:
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=2**14,
            r=8,
            p=1,
            dklen=64,
        ).hex()
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected_hex)


def create_token(user: dict[str, Any]) -> tuple[str, int]:
    if not SESSION_SECRET:
        raise HTTPException(status_code=503, detail="Canopy session secret is not configured")
    expires_at = int(time.time() * 1000) + SESSION_TTL_SECONDS * 1000
    payload = {
        "sub": user["id"],
        "username": user["username"],
        "name": user["name"],
        "role": user.get("role"),
        "theme_mode": user.get("theme_mode"),
        "theme_color": user.get("theme_color"),
        "language_code": user.get("language_code"),
        "exp": expires_at,
    }
    encoded = encode_part(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = encode_part(
        hmac.new(SESSION_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{encoded}.{signature}", expires_at


def session_token(request: Request) -> str:
    explicit = request.headers.get("x-flora-session", "").strip()
    if explicit:
        return explicit
    authorization = request.headers.get("authorization", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


def read_token(request: Request) -> dict[str, Any]:
    token = session_token(request)
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected_signature = encode_part(
            hmac.new(SESSION_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise ValueError("invalid signature")
        payload = json.loads(decode_part(encoded))
        if int(payload["exp"]) <= int(time.time() * 1000):
            raise ValueError("expired")
        return payload
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise HTTPException(status_code=401, detail="sign in required") from None


@router.post("/login")
def login(payload: LoginRequest, database: Connection = Depends(connection)) -> dict:
    username = payload.username.strip()
    if not username or not payload.password:
        raise HTTPException(status_code=400, detail="username and password are required")
    user = central_auth.authenticate(database, username, payload.password)
    user = attach_entitlements(database, user)
    token, expires_at = create_token(user)
    return {
        "user": public_user(user),
        "session_token": token,
        "expires_at": expires_at,
    }


@router.get("/whoami")
def whoami(request: Request, database: Connection = Depends(connection)) -> dict:
    payload = read_token(request)
    user = database.execute(
        """SELECT id,username,name,role,theme_mode,theme_color,language_code,
                  staff_directory_id,parameter_preferences,report_preferences,
                  must_change_password,is_active,auth_source,all_units,admin_pin_hash
           FROM auth_user WHERE id=%s LIMIT 1""",
        (payload["sub"],),
    ).fetchone()
    if user is None or not user["is_active"]:
        raise HTTPException(status_code=401, detail="sign in required")
    return {"user": public_user(attach_entitlements(database, user))}


@router.post("/logout")
def logout() -> dict:
    return {"ok": True}
