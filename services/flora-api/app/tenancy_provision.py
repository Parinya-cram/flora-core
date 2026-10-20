"""Create, migrate and manage Canopy accounts (one PostgreSQL schema per account).

Runs with the database owner (FLORA_PLATFORM_DATABASE_URL): it creates schemas and applies the schema
bundle (app/tenancy_sql, built by scripts/tenancy/build_schema_bundle.py). Used by the platform
console (routes/platform.py) and the CLI (python -m app.cli_accounts).
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import tenancy

BUNDLE = Path(__file__).parent / "tenancy_sql"
SERVICE_ROLES = ("flora_view", "flora_sync", "flora_app")


class ProvisionError(Exception):
    pass


def now_ms() -> int:
    return int(time.time() * 1000)


def admin_url() -> str:
    url = os.getenv("FLORA_PLATFORM_DATABASE_URL", "").strip()
    if not url:
        raise ProvisionError("FLORA_PLATFORM_DATABASE_URL (database owner) is not configured")
    return url


@contextmanager
def admin_connection() -> Iterator[psycopg.Connection]:
    with psycopg.connect(admin_url(), autocommit=True, row_factory=dict_row) as connection:
        yield connection


def manifest() -> list[str]:
    return json.loads((BUNDLE / "manifest.json").read_text())


def prepare(sql: str, schema: str) -> str:
    """A bundle file rewritten for one account's schema. psql meta commands (\\set, \\restrict) and
    `… \\gexec` statements — cluster-wide role creation and CONNECT grants, already done for the
    database — are dropped."""
    text = re.sub(r"(?ms)^SELECT format\(.*?\\gexec\s*$", "", sql)
    text = "\n".join(line for line in text.splitlines() if not line.startswith("\\"))
    text = text.replace("'public'", f"'{schema}'")
    text = re.sub(r"\bSCHEMA public\b", f'SCHEMA "{schema}"', text)
    text = re.sub(r"search_path\s*=\s*public\b", f'search_path = "{schema}"', text)
    text = re.sub(r"\bpublic\.", f'"{schema}".', text)
    return text


def split_statements(sql: str) -> list[str]:
    """Statements of a script, split on `;` outside quotes, comments and $tag$ bodies. Used for files
    with CREATE INDEX CONCURRENTLY, which must run outside the implicit transaction of a script."""
    statements, current, i, n = [], [], 0, len(sql)
    while i < n:
        char = sql[i]
        if char == "-" and sql.startswith("--", i):
            end = sql.find("\n", i)
            end = n if end < 0 else end
            current.append(sql[i:end]); i = end; continue
        if char == "'":
            end = i + 1
            while end < n and not (sql[end] == "'" and not sql.startswith("''", end)):
                end += 2 if sql.startswith("''", end) else 1
            current.append(sql[i:end + 1]); i = end + 1; continue
        if char == "$":
            match = re.match(r"\$[A-Za-z_]*\$", sql[i:])
            if match:
                tag = match.group(0)
                end = sql.find(tag, i + len(tag))
                end = n if end < 0 else end + len(tag)
                current.append(sql[i:end]); i = end; continue
        if char == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current, i = [], i + 1
            continue
        current.append(char); i += 1
    tail = "".join(current).strip()
    if tail and not all(line.strip().startswith("--") or not line.strip() for line in tail.splitlines()):
        statements.append(tail)
    return statements


def _rollback(connection: psycopg.Connection) -> None:
    try:
        connection.execute("ROLLBACK")
    except Exception:  # noqa: BLE001 - nothing open
        pass


def _execute(connection: psycopg.Connection, sql: str) -> None:
    if re.search(r"(?im)^\s*(CREATE|DROP|REINDEX)\b[^;]*\bCONCURRENTLY\b", sql):
        for statement in split_statements(sql):
            if statement.upper() in {"BEGIN", "COMMIT"}:
                continue
            connection.execute(statement)
    else:
        connection.execute(sql)


def ensure_platform(connection: psycopg.Connection) -> None:
    connection.execute((BUNDLE / "platform.sql").read_text())


def audit(connection: psycopg.Connection, actor: str | None, action: str, code: str | None, detail: dict[str, Any]) -> None:
    connection.execute("INSERT INTO platform.audit (actor, action, account_code, detail, created_at) VALUES (%s,%s,%s,%s,%s)",
                       (actor, action, code, Jsonb(detail), now_ms()))


def _grants(connection: psycopg.Connection, schema: str) -> None:
    existing = {row["rolname"] for row in connection.execute(
        "SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)", (list(SERVICE_ROLES),)).fetchall()}
    for role in existing:
        connection.execute(f'GRANT USAGE ON SCHEMA "{schema}" TO {role}')
    if "flora_view" in existing:   # what 0003-create-view-role.sql grants on the default schema
        connection.execute(f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema}" GRANT SELECT ON TABLES TO flora_view')
    if "flora_app" in existing:    # what 0000-create-app-role.sql grants on the default schema
        connection.execute(f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flora_app')
        connection.execute(f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema}" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO flora_app')


def _apply(connection: psycopg.Connection, code: str, schema: str, names: list[str]) -> list[str]:
    applied = []
    for name in names:
        connection.execute(f'SET search_path TO "{schema}"')
        try:
            _execute(connection, prepare((BUNDLE / name).read_text(encoding="utf-8"), schema))
        except Exception as error:
            _rollback(connection)   # a script's own BEGIN may have left a failed transaction open
            raise ProvisionError(f"{name}: {error}") from error
        connection.execute("SET search_path TO platform")
        connection.execute(
            "INSERT INTO platform.schema_migration (account_code, file_name, applied_at) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
            (code, name, now_ms()))
        applied.append(name)
    connection.execute("SET search_path TO platform")
    return applied


def _first_admin(connection: psycopg.Connection, schema: str, username: str, password: str, name: str) -> None:
    from .routes.auth_leaf import new_password_record

    connection.execute(f'SET search_path TO "{schema}"')
    language = connection.execute(
        "SELECT code FROM language_master WHERE is_active=1 ORDER BY CASE WHEN code='en' THEN 0 ELSE 1 END, sort_order, code LIMIT 1"
    ).fetchone()
    salt, digest = new_password_record(password)
    current = now_ms()
    user = connection.execute(
        """INSERT INTO auth_user (username, auth_source, password_salt, password_hash, name, role, is_active, created_at,
               updated_at, language_code, must_change_password, all_units)
           VALUES (%s,'local',%s,%s,%s,'admin',1,%s,%s,%s,1,1) RETURNING id""",
        (username, salt, digest, name, current, current, (language or {}).get("code") or "en")).fetchone()
    connection.execute(
        """INSERT INTO auth_user_role (user_id, role_code, scope_type, scope_id, created_at, updated_at)
           VALUES (%s,'system_admin','global','*',%s,%s)""", (user["id"], current, current))
    connection.execute("SET search_path TO platform")


def create_account(code: str, name: str, admin_username: str, admin_password: str, actor: str | None = None,
                   haber_url: str | None = None) -> dict[str, Any]:
    """New account: schema, every bundle file, first administrator and a sync secret (returned once)."""
    code = code.strip().lower()
    schema = tenancy.schema_for(code)
    if len(admin_password) < 8:
        raise ProvisionError("the first administrator's password needs at least 8 characters")
    secret = secrets.token_urlsafe(32)
    with admin_connection() as connection:
        ensure_platform(connection)
        if connection.execute("SELECT 1 FROM platform.account WHERE code=%s", (code,)).fetchone():
            raise ProvisionError(f"account {code} already exists")
        if connection.execute("SELECT 1 FROM pg_namespace WHERE nspname=%s", (schema,)).fetchone():
            raise ProvisionError(f"schema {schema} already exists")
        connection.execute(
            """INSERT INTO platform.account (code, name, schema_name, status, sync_secret_hash, haber_url, created_at, created_by, updated_at)
               VALUES (%s,%s,%s,'suspended',%s,%s,%s,%s,%s)""",
            (code, name.strip(), schema, tenancy.secret_hash(secret), haber_url, now_ms(), actor, now_ms()))
        try:
            connection.execute(f'CREATE SCHEMA "{schema}"')
            _grants(connection, schema)
            applied = _apply(connection, code, schema, manifest())
            _first_admin(connection, schema, admin_username.strip(), admin_password, "Administrator")
        except Exception:
            _rollback(connection)
            connection.execute("SET search_path TO platform")
            connection.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
            connection.execute("DELETE FROM platform.account WHERE code=%s", (code,))
            raise
        connection.execute("UPDATE platform.account SET status='active', updated_at=%s WHERE code=%s", (now_ms(), code))
        audit(connection, actor, "account.create", code, {"schema": schema, "files": len(applied)})
    tenancy.invalidate()
    return {"code": code, "schema": schema, "sync_secret": secret, "files": len(applied)}


def migrate(code: str | None = None, actor: str | None = None) -> dict[str, list[str]]:
    """Apply bundle files an account has not had yet (every account, or one)."""
    result: dict[str, list[str]] = {}
    with admin_connection() as connection:
        ensure_platform(connection)
        rows = connection.execute("SELECT code, schema_name FROM platform.account WHERE %s::text IS NULL OR code=%s ORDER BY code",
                                  (code, code)).fetchall()
        for row in rows:
            done = {r["file_name"] for r in connection.execute(
                "SELECT file_name FROM platform.schema_migration WHERE account_code=%s", (row["code"],)).fetchall()}
            pending = [name for name in manifest() if name not in done]
            result[row["code"]] = _apply(connection, row["code"], row["schema_name"], pending)
            if pending:
                audit(connection, actor, "account.migrate", row["code"], {"files": pending})
    return result


def rotate_secret(code: str, actor: str | None = None) -> str:
    secret = secrets.token_urlsafe(32)
    with admin_connection() as connection:
        row = connection.execute("UPDATE platform.account SET sync_secret_hash=%s, updated_at=%s WHERE code=%s RETURNING code",
                                 (tenancy.secret_hash(secret), now_ms(), code)).fetchone()
        if not row:
            raise ProvisionError(f"account {code} not found")
        audit(connection, actor, "account.rotate-secret", code, {})
    tenancy.invalidate()
    return secret


def update_account(code: str, actor: str | None = None, **fields: Any) -> None:
    allowed = {key: value for key, value in fields.items() if key in {"name", "status", "haber_url"} and value is not None}
    if not allowed:
        return
    with admin_connection() as connection:
        row = connection.execute(
            f"UPDATE platform.account SET {', '.join(f'{key}=%s' for key in allowed)}, updated_at=%s WHERE code=%s RETURNING code",
            (*allowed.values(), now_ms(), code)).fetchone()
        if not row:
            raise ProvisionError(f"account {code} not found")
        audit(connection, actor, "account.update", code, allowed)
    tenancy.invalidate()


def list_accounts() -> list[dict[str, Any]]:
    with admin_connection() as connection:
        ensure_platform(connection)
        total = len(manifest())
        return connection.execute(
            """SELECT a.code, a.name, a.schema_name, a.status, a.haber_url, a.created_at, a.updated_at,
                      (a.sync_secret_hash IS NOT NULL) AS has_sync_secret,
                      (SELECT count(*) FROM platform.schema_migration m WHERE m.account_code=a.code) AS migrations,
                      %s AS migrations_total
               FROM platform.account a ORDER BY a.code""", (total,)).fetchall()


def adopt_public(code: str, name: str, sync_secret: str, actor: str | None = None, haber_url: str | None = None,
                 compat_roles: tuple[str, ...] = ("flora_view", "flora_sync")) -> dict[str, Any]:
    """One-time move of a single-hospital Canopy: the `public` schema becomes account `code`.
    Every bundle file is recorded as applied (the database already had them).

    `compat_roles` get that schema as their default search_path, so services still running a
    single-account release keep serving this first account until they are upgraded; the
    multi-account code sets the schema itself on every connection and ignores the default."""
    schema = tenancy.schema_for(code)
    with admin_connection() as connection:
        ensure_platform(connection)
        if connection.execute("SELECT 1 FROM platform.account").fetchone():
            raise ProvisionError("accounts exist already; adopt-public is only for the first account")
        if not connection.execute("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='auth_user'").fetchone():
            raise ProvisionError("the public schema holds no Canopy data")
        with connection.transaction():
            connection.execute(f'ALTER SCHEMA public RENAME TO "{schema}"')
            connection.execute("CREATE SCHEMA public")
            connection.execute("GRANT USAGE ON SCHEMA public TO PUBLIC")
            # Functions pinned to the old schema name (SECURITY DEFINER … SET search_path = public).
            for fn in connection.execute(
                    """SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                       WHERE n.nspname=%s AND p.proconfig::text LIKE '%%search_path=public%%'""", (schema,)).fetchall():
                connection.execute(f'ALTER FUNCTION {fn["signature"]} SET search_path = "{schema}"')
            connection.execute(
                """INSERT INTO platform.account (code, name, schema_name, status, sync_secret_hash, haber_url, created_at, created_by,
                       updated_at)
                   VALUES (%s,%s,%s,'active',%s,%s,%s,%s,%s)""",
                (code, name, schema, tenancy.secret_hash(sync_secret), haber_url, now_ms(), actor, now_ms()))
            for role in compat_roles:
                if connection.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone():
                    connection.execute(f'ALTER ROLE {role} SET search_path TO "{schema}"')
            for file_name in manifest():
                connection.execute("INSERT INTO platform.schema_migration (account_code, file_name, applied_at) VALUES (%s,%s,%s)",
                                   (code, file_name, now_ms()))
            audit(connection, actor, "account.adopt-public", code, {"schema": schema})
    tenancy.invalidate()
    return {"code": code, "schema": schema}


def ensure_platform_admin(username: str, password: str, name: str = "Platform administrator") -> None:
    from .routes.auth_leaf import new_password_record

    salt, digest = new_password_record(password)
    with admin_connection() as connection:
        ensure_platform(connection)
        connection.execute(
            """INSERT INTO platform.admin_user (username, password_salt, password_hash, name, created_at) VALUES (%s,%s,%s,%s,%s)
               ON CONFLICT (username) DO UPDATE SET password_salt=excluded.password_salt, password_hash=excluded.password_hash""",
            (username, salt, digest, name, now_ms()))


def verify_platform_admin(username: str, password: str) -> dict[str, Any] | None:
    from .routes.auth_canopy import verify_password

    with admin_connection() as connection:
        ensure_platform(connection)
        row = connection.execute("SELECT * FROM platform.admin_user WHERE username=%s AND is_active", (username,)).fetchone()
        if not row or not verify_password(password, row["password_salt"], row["password_hash"]):
            return None
        connection.execute("UPDATE platform.admin_user SET last_login_at=%s WHERE username=%s", (now_ms(), username))
        return {"username": row["username"], "name": row["name"]}
