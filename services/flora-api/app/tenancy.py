"""Accounts (tenants) of a multi-hospital Canopy: one PostgreSQL schema per account.

Every account's data — patients, cases, configuration, users — lives in its own schema
(`acct_<code>`); the schema `platform` only holds the account registry and platform
administrators. Each request runs with the account it belongs to (`current_account`), and every
pooled connection is switched to that account's schema when it is taken and to an empty schema
when it is given back, so a connection can never read another account's tables:

- canopy mode: the account comes from the signed session token (claim `acct`); before sign-in
  from the `X-Flora-Account` header (the login form's account code, remembered in a cookie);
- sync mode (Leafs, Haber): from the Bearer sync secret, which is unique per account;
- public API keys and HL7 webhook tokens: looked up in each account (see find_account_by).

Leaf mode is single-tenant and keeps the default `public` schema; nothing here applies to it.
"""
from __future__ import annotations

import contextvars
import hashlib
import os
import re
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

API_MODE = os.getenv("FLORA_API_MODE", "leaf").strip().lower()
MULTI_ACCOUNT = API_MODE in {"canopy", "sync"}
PLATFORM_SCHEMA = "platform"
ISOLATED_SCHEMA = "flora_no_account"      # empty schema: queries without an account fail instead of leaking
PLATFORM_CODE = "platform"                # reserved account code for platform administrators
CODE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
ACCOUNT_HEADER = "x-flora-account"


@dataclass(frozen=True)
class Account:
    code: str
    name: str
    schema: str
    status: str
    haber_url: str | None = None


_current: contextvars.ContextVar[Account | None] = contextvars.ContextVar("flora_account", default=None)
_cache: dict[str, Any] = {"at": 0.0, "accounts": {}, "secrets": {}}
_cache_lock = threading.Lock()
CACHE_SECONDS = 15


def schema_for(code: str) -> str:
    if not CODE.match(code) or code == PLATFORM_CODE:
        raise ValueError(f"invalid account code {code!r}")
    return f"acct_{code}"


def secret_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def current_account() -> Account | None:
    return _current.get()


def set_current(account: Account | None) -> contextvars.Token:
    return _current.set(account)


def reset_current(token: contextvars.Token) -> None:
    _current.reset(token)


@contextmanager
def using(account: Account) -> Iterator[Account]:
    """Run a block (background job, CLI) as one account."""
    token = _current.set(account)
    try:
        yield account
    finally:
        _current.reset(token)


# ------------------------------------------------------------------ registry (cached)

def _load(connection: Any) -> None:
    rows = connection.execute(
        f"SELECT code, name, schema_name, status, sync_secret_hash, haber_url FROM {PLATFORM_SCHEMA}.account").fetchall()
    accounts = {row["code"]: Account(row["code"], row["name"], row["schema_name"], row["status"], row["haber_url"]) for row in rows}
    secrets = {row["sync_secret_hash"]: row["code"] for row in rows if row["sync_secret_hash"]}
    _cache.update(at=time.monotonic(), accounts=accounts, secrets=secrets)


def _registry() -> dict[str, Any]:
    with _cache_lock:
        if time.monotonic() - _cache["at"] > CACHE_SECONDS:
            from .database import platform_connection
            with platform_connection() as connection:
                _load(connection)
        return _cache


def invalidate() -> None:
    with _cache_lock:
        _cache["at"] = 0.0


def accounts(active_only: bool = True) -> list[Account]:
    return [account for account in _registry()["accounts"].values() if not active_only or account.status == "active"]


def by_code(code: str | None) -> Account | None:
    if not code:
        return None
    account = _registry()["accounts"].get(code.strip().lower())
    return account if account and account.status == "active" else None


def by_sync_secret(secret: str) -> Account | None:
    if not secret:
        return None
    return by_code(_registry()["secrets"].get(secret_hash(secret)))


def find_account_by(sql: str, params: tuple) -> Account | None:
    """The one active account whose schema answers `sql` with a row (e.g. an API key prefix).
    Used where the caller proves its account with a secret instead of naming it."""
    from .database import pool
    found = None
    for account in accounts():
        with using(account), pool.connection() as connection:
            if connection.execute(sql, params).fetchone():
                if found is not None:
                    return None          # ambiguous: refuse rather than guess
                found = account
    return found


# ------------------------------------------------------------------ connection scoping

def scope_connection(connection: Any) -> None:
    """Point a pooled connection at the current account's schema (or at nothing)."""
    if not MULTI_ACCOUNT:
        return
    account = _current.get()
    schema = account.schema if account else ISOLATED_SCHEMA
    connection.execute(f'SET search_path TO "{schema}"')


def isolate_connection(connection: Any) -> None:
    if MULTI_ACCOUNT:
        connection.execute(f'SET search_path TO "{ISOLATED_SCHEMA}"')
