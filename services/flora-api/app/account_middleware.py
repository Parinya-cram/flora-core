"""Decides which account (tenant) every canopy / sync request belongs to (see app/tenancy.py).

Order, first match wins — a caller can only reach an account it proves it belongs to:
1. sync mode: the Bearer sync secret (unique per account) — Leafs and Haber;
2. a signed Canopy session token: its `acct` claim (a token never moves to another account);
3. public API key (/api/v1, MCP) or HL7 webhook token: the account that holds it;
4. before sign-in: the account code the login form sends (`X-Flora-Account`, remembered in the
   `flora_account` cookie), or — with exactly one active account — that account.
Requests with no account still run, but their database connections point at an empty schema.
"""
from __future__ import annotations

from http.cookies import SimpleCookie
from typing import Any

import anyio

from . import tenancy

HL7_PREFIX = "/api/integrations/hl7/webhook/"


def _headers(scope: dict[str, Any]) -> dict[str, str]:
    return {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers") or []}


def _bearer(headers: dict[str, str]) -> str:
    authorization = headers.get("authorization", "").strip()
    return authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""


def resolve(path: str, headers: dict[str, str]) -> tenancy.Account | None:
    if tenancy.API_MODE == "sync":
        return tenancy.by_sync_secret(_bearer(headers))
    from .routes.auth_canopy import verified_payload

    token = headers.get("x-flora-session", "").strip() or _bearer(headers)
    if token and not token.startswith("flk_"):
        payload = verified_payload(token)
        if payload is not None:   # a valid session decides, even when its account is gone (then: none)
            return tenancy.by_code(payload.get("acct")) if payload.get("acct") != tenancy.PLATFORM_CODE else None
    if token.startswith("flk_"):
        parts = token.split("_")
        return tenancy.find_account_by("SELECT 1 FROM canopy_api_key WHERE prefix=%s", (parts[1],)) if len(parts) == 3 else None
    if path.startswith(HL7_PREFIX):
        webhook_token = path[len(HL7_PREFIX):].split("/")[0]
        return tenancy.find_account_by("SELECT 1 FROM canopy_hl7_interface WHERE webhook_token=%s", (webhook_token,)) if webhook_token else None
    code = headers.get(tenancy.ACCOUNT_HEADER, "").strip()
    if not code and headers.get("cookie"):
        cookie = SimpleCookie()
        try:
            cookie.load(headers["cookie"])
        except Exception:  # noqa: BLE001 - a malformed cookie names no account
            cookie = SimpleCookie()
        code = cookie["flora_account"].value if "flora_account" in cookie else ""
    if code:
        return tenancy.by_code(code)
    active = tenancy.accounts()
    return active[0] if len(active) == 1 else None


class AccountMiddleware:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http" or not tenancy.MULTI_ACCOUNT or scope.get("path") in {"/health", "/api/health"}:
            await self.app(scope, receive, send)
            return
        try:
            account = await anyio.to_thread.run_sync(resolve, scope.get("path", ""), _headers(scope))
        except Exception:  # registry unavailable (e.g. before the platform schema exists): no account
            account = None
        token = tenancy.set_current(account)
        scope.setdefault("state", {})["account"] = account
        try:
            await self.app(scope, receive, send)
        finally:
            tenancy.reset_current(token)
