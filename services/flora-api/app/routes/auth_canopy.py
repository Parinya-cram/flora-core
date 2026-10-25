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

from .. import activity_log, central_auth, tenancy
from ..database import connection
from .auth_leaf import attach_entitlements, public_user as shared_public_user


router = APIRouter(prefix="/api/auth", tags=["authentication"])
SESSION_TTL_SECONDS = int(os.getenv("FLORA_CANOPY_SESSION_TTL_SECONDS", "28800"))
SESSION_SECRET = os.environ.get("FLORA_CANOPY_SESSION_SECRET", "")


class LoginRequest(BaseModel):
    username: str
    password: str
    # Account (hospital) code; defaults to the request's account (cookie / only account).
    # "platform" signs in a platform administrator (account management only, no hospital data).
    account_code: str | None = None


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


def create_token(user: dict[str, Any], account: str | None = None) -> tuple[str, int]:
    if not SESSION_SECRET:
        raise HTTPException(status_code=503, detail="Canopy session secret is not configured")
    expires_at = int(time.time() * 1000) + SESSION_TTL_SECONDS * 1000
    payload = {
        "acct": account,
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


def verified_payload(token: str) -> dict[str, Any] | None:
    """The claims of a valid, unexpired session token; None otherwise."""
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected_signature = encode_part(
            hmac.new(SESSION_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
        )
        if not SESSION_SECRET or not hmac.compare_digest(supplied_signature, expected_signature):
            return None
        payload = json.loads(decode_part(encoded))
        if int(payload["exp"]) <= int(time.time() * 1000):
            return None
        return payload
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def read_token(request: Request) -> dict[str, Any]:
    """A signed-in hospital user of the request's account. Platform-admin tokens and tokens of
    another account are refused here, so no hospital route serves them."""
    payload = verified_payload(session_token(request))
    if payload is None:
        raise HTTPException(status_code=401, detail="sign in required")
    if tenancy.MULTI_ACCOUNT:
        account = tenancy.current_account()
        if account is None or payload.get("acct") != account.code:
            raise HTTPException(status_code=401, detail="sign in required")
    return payload


def read_platform_token(request: Request) -> dict[str, Any]:
    payload = verified_payload(session_token(request))
    if payload is None or payload.get("acct") != tenancy.PLATFORM_CODE:
        raise HTTPException(status_code=401, detail="platform administrator sign-in required")
    return payload


def _account_info(account: tenancy.Account | None) -> dict[str, Any] | None:
    return {"code": account.code, "name": account.name} if account else None


@router.post("/login")
def login(payload: LoginRequest, request: Request, database: Connection = Depends(connection)) -> dict:
    username = payload.username.strip()
    if not username or not payload.password:
        raise HTTPException(status_code=400, detail="username and password are required")
    account = None
    if tenancy.MULTI_ACCOUNT:
        code = (payload.account_code or "").strip().lower()
        if code == tenancy.PLATFORM_CODE:
            from .. import tenancy_provision
            try:
                admin = tenancy_provision.verify_platform_admin(username, payload.password)
            except tenancy_provision.ProvisionError as error:
                raise HTTPException(status_code=503, detail=str(error)) from None
            if admin is None:
                raise HTTPException(status_code=401, detail="invalid username or password")
            user = {"id": 0, "username": admin["username"], "name": admin["name"] or admin["username"], "role": "platform_admin"}
            token, expires_at = create_token(user, tenancy.PLATFORM_CODE)
            return {"user": {**user, "permissions": []}, "session_token": token, "expires_at": expires_at,
                    "account": {"code": tenancy.PLATFORM_CODE, "name": "Platform"}}
        account = tenancy.by_code(code) if code else tenancy.current_account()
        if account is None:
            raise HTTPException(status_code=401, detail="unknown or inactive account")
        # The connection was taken for the request's account; sign in to the one named in the form.
        with tenancy.using(account):
            tenancy.scope_connection(database)
    try:
        user = central_auth.authenticate(database, username, payload.password)
    except HTTPException as error:
        activity_log.record_sign_in(request, username, account, None, error.status_code, str(error.detail))
        raise
    user = attach_entitlements(database, user)
    activity_log.record_sign_in(request, username, account, user, 200)
    token, expires_at = create_token(user, account.code if account else None)
    return {
        "user": public_user(user),
        "session_token": token,
        "expires_at": expires_at,
        "account": _account_info(account),
    }


@router.get("/account/{code}")
def account_name(code: str) -> dict:
    """The login form shows which hospital a remembered account code belongs to."""
    if code.strip().lower() == tenancy.PLATFORM_CODE:
        return {"code": tenancy.PLATFORM_CODE, "name": "Platform administration"}
    account = tenancy.by_code(code) if tenancy.MULTI_ACCOUNT else None
    if account is None:
        raise HTTPException(status_code=404, detail="unknown account")
    return _account_info(account)


@router.get("/whoami")
def whoami(request: Request, database: Connection = Depends(connection)) -> dict:
    platform = verified_payload(session_token(request)) if tenancy.MULTI_ACCOUNT else None
    if platform and platform.get("acct") == tenancy.PLATFORM_CODE:
        # Platform administrators have no hospital user; the console only needs who they are.
        user = {"id": 0, "username": platform.get("username"), "name": platform.get("name"), "role": "platform_admin", "permissions": []}
        return {"user": user, "account": {"code": tenancy.PLATFORM_CODE, "name": "Platform"}}
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
    return {"user": public_user(attach_entitlements(database, user)), "account": _account_info(tenancy.current_account())}


@router.post("/logout")
def logout() -> dict:
    return {"ok": True}
