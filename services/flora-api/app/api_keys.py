"""API keys for the Canopy public API (/api/v1) and the MCP server.

Key format: flk_<prefix>_<secret>. The prefix identifies the key (shown in logs and
the admin page); only SHA-256(secret) is stored, so a lost key cannot be recovered,
only revoked and replaced.
"""
import hashlib
import hmac
import secrets
import threading
import time
import uuid
from collections import deque
from typing import Any

from fastapi import HTTPException, Request
from psycopg import Connection

SCOPES = {
    "cases:read": "Case list, case summary, events, medications",
    "vitals:read": "Minute-by-minute vital signs",
    "forms:read": "Clinical forms (pre-op, checklist, PACU…)",
    "admissions:read": "Admissions waiting for or started at a Leaf",
    "admissions:write": "Create admissions (HIS / scheduling systems)",
}
RATE_LIMIT_PER_MINUTE = 300
_calls: dict[str, deque] = {}
_lock = threading.Lock()


def now_ms() -> int:
    return int(time.time() * 1000)


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def generate() -> tuple[str, str, str]:
    """(full key, prefix, secret hash)"""
    prefix = secrets.token_hex(4)
    secret = secrets.token_urlsafe(32)
    return f"flk_{prefix}_{secret}", prefix, _hash(secret)


def public(row: dict[str, Any]) -> dict[str, Any]:
    current = now_ms()
    status = ("revoked" if row.get("revoked_at") else
              "expired" if row.get("expires_at") and row["expires_at"] <= current else "active")
    return {
        "id": str(row["id"]), "name": row["name"], "prefix": row["prefix"], "scopes": list(row["scopes"] or []),
        "unitKeys": list(row["unit_keys"]) if row.get("unit_keys") is not None else None,
        "includeDemo": row["include_demo"], "createdBy": row["created_by"], "createdAt": row["created_at"],
        "expiresAt": row["expires_at"], "lastUsedAt": row["last_used_at"], "revokedAt": row["revoked_at"],
        "status": status, "requestCount24h": row.get("requests_24h"),
    }


def _rate_limit(prefix: str) -> None:
    window = time.monotonic() - 60
    with _lock:
        calls = _calls.setdefault(prefix, deque())
        while calls and calls[0] < window:
            calls.popleft()
        if len(calls) >= RATE_LIMIT_PER_MINUTE:
            raise HTTPException(status_code=429, detail=f"rate limit: {RATE_LIMIT_PER_MINUTE} requests per minute")
        calls.append(time.monotonic())


def authenticate(request: Request, database: Connection) -> dict[str, Any]:
    supplied = request.headers.get("x-api-key", "").strip()
    authorization = request.headers.get("authorization", "").strip()
    if not supplied and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    parts = supplied.split("_", 2)
    if len(parts) != 3 or parts[0] != "flk":
        raise HTTPException(status_code=401, detail="API key required (Authorization: Bearer flk_…)")
    request.state.api_key_prefix = parts[1]
    row = database.execute("SELECT * FROM canopy_api_key WHERE prefix=%s", (parts[1],)).fetchone()
    if row is None or not hmac.compare_digest(row["secret_hash"], _hash(parts[2])):
        raise HTTPException(status_code=401, detail="invalid API key")
    request.state.api_key_id = str(row["id"])
    if row["revoked_at"]:
        raise HTTPException(status_code=401, detail="API key revoked")
    if row["expires_at"] and row["expires_at"] <= now_ms():
        raise HTTPException(status_code=401, detail="API key expired")
    _rate_limit(row["prefix"])
    if not row["last_used_at"] or now_ms() - row["last_used_at"] > 60_000:
        database.execute("UPDATE canopy_api_key SET last_used_at=%s WHERE id=%s", (now_ms(), row["id"]))
    return dict(row)


def require_scope(key: dict[str, Any], scope: str) -> None:
    if scope not in (key.get("scopes") or []):
        raise HTTPException(status_code=403, detail=f"this API key lacks the {scope} scope")


def ward_filter(key: dict[str, Any], ward: str | None) -> tuple[list[str] | None, bool]:
    """(ward keys or None for all, include demo wards) for a request, honouring the key's limits."""
    allowed = list(key["unit_keys"]) if key.get("unit_keys") is not None else None
    if ward:
        if allowed is not None and ward not in allowed:
            raise HTTPException(status_code=403, detail="this API key has no access to that ward")
        return [ward], True
    return allowed, bool(key.get("include_demo"))


def log_request(database: Connection, request: Request, status: int, duration_ms: int, error: str | None = None) -> None:
    state = request.state
    database.execute(
        """INSERT INTO canopy_api_access_log(at,key_id,key_prefix,method,path,query,status,duration_ms,ip,user_agent,
                 client,tool,case_ids,error) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (now_ms(), getattr(state, "api_key_id", None), getattr(state, "api_key_prefix", None), request.method,
         request.url.path, request.url.query or None, status, duration_ms,
         request.headers.get("x-forwarded-for", request.client.host if request.client else None),
         (request.headers.get("user-agent") or "")[:300], request.headers.get("x-flora-client"),
         request.headers.get("x-flora-mcp-tool"), list(getattr(state, "case_ids", []) or [])[:500] or None,
         error),
    )


def new_key_row(database: Connection, *, name: str, scopes: list[str], unit_keys: list[str] | None,
                include_demo: bool, expires_at: int | None, created_by: str | None) -> tuple[dict[str, Any], str]:
    key, prefix, secret_hash = generate()
    row = database.execute(
        """INSERT INTO canopy_api_key(id,name,prefix,secret_hash,scopes,unit_keys,include_demo,created_by,created_at,expires_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
        (uuid.uuid4(), name, prefix, secret_hash, scopes, unit_keys, include_demo, created_by, now_ms(), expires_at),
    ).fetchone()
    return dict(row), key
