import logging
import os

from psycopg import Connection

from .routes.auth_leaf import new_password_record, now_ms


logger = logging.getLogger(__name__)


def _enabled() -> bool:
    configured = os.getenv("FLORA_BOOTSTRAP_ADMIN_ENABLED")
    if configured is not None:
        return configured.strip().lower() in {"1", "true", "yes", "on"}
    return os.getenv("FLORA_API_ENV", "production").strip().lower() == "development"


def _must_change_password() -> bool:
    # Demo installs set this to false so the default admin/admin keeps working.
    configured = os.getenv("FLORA_BOOTSTRAP_ADMIN_MUST_CHANGE_PASSWORD", "true")
    return configured.strip().lower() in {"1", "true", "yes", "on"}


def ensure_bootstrap_admin(database: Connection) -> bool:
    """Create the first local administrator for a completely empty installation.

    This intentionally does nothing once any user exists. It is an installation
    bootstrap, not a password reset or a way to recreate a removed administrator.
    """
    if not _enabled():
        return False

    username = os.getenv("FLORA_BOOTSTRAP_ADMIN_USERNAME", "admin").strip()
    password = os.getenv("FLORA_BOOTSTRAP_ADMIN_PASSWORD", "admin")
    display_name = os.getenv("FLORA_BOOTSTRAP_ADMIN_NAME", "Administrator").strip() or "Administrator"
    if not username or not password:
        logger.warning("Initial administrator bootstrap is enabled but credentials are incomplete")
        return False

    with database.transaction():
        database.execute("SELECT pg_advisory_xact_lock(hashtext('flora-bootstrap-admin'))")
        total = database.execute("SELECT count(*) AS total FROM auth_user").fetchone()
        if total is None or int(total["total"]) != 0:
            return False

        role = database.execute(
            "SELECT code FROM auth_role WHERE code='system_admin' AND is_active=1"
        ).fetchone()
        if role is None:
            raise RuntimeError("system_admin role is unavailable; database initialization is incomplete")

        language = database.execute(
            """SELECT code FROM language_master
               WHERE is_active=1
               ORDER BY CASE WHEN code='en' THEN 0 ELSE 1 END, sort_order, code
               LIMIT 1"""
        ).fetchone()
        if language is None:
            raise RuntimeError("no active interface language is available; database initialization is incomplete")

        salt, password_digest = new_password_record(password)
        current = now_ms()
        user = database.execute(
            """INSERT INTO auth_user (
                   username, auth_source, password_salt, password_hash, name, role,
                   is_active, created_at, updated_at, language_code, must_change_password
               ) VALUES (%s,'local',%s,%s,%s,'admin',1,%s,%s,%s,%s)
               RETURNING id""",
            (username, salt, password_digest, display_name, current, current, language["code"],
             1 if _must_change_password() else 0),
        ).fetchone()
        database.execute(
            """INSERT INTO auth_user_role (
                   user_id, role_code, scope_type, scope_id, created_at, updated_at
               ) VALUES (%s,'system_admin','global','*',%s,%s)""",
            (user["id"], current, current),
        )

    logger.warning(
        "Created the initial Flora administrator '%s'; its password must be changed after sign-in",
        username,
    )
    return True
