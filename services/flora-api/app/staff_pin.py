"""Staff PIN (staff_directory.pin_hash): a doctor confirms a high-alert medication order or dose at the Leaf.

- 4-6 digits, hashed with the auth_user password KDF (routes/auth_leaf.password_hash: scrypt n=2^14 r=8 p=1, per-PIN
  salt): 'scrypt$<salt hex>$<hash hex>'. Kept import-light (no FastAPI / psycopg) so it is unit-testable.
- 5 wrong PINs lock the person for 15 min. Failures and locks are Leaf-local; the hash and pin_set_at sync with
  Canopy (app/staff_sync.py, newest pin_set_at wins, a reset is a newer pin_set_at with no hash).
- The PIN and its hash are never logged, returned or put in a URL.

`attempt` commits its own failure count, so call it outside the request's main transaction.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from psycopg import Connection

PIN_PATTERN = re.compile(r"\d{4,6}")
MAX_FAILURES = 5
LOCK_MS = 15 * 60_000
# error code -> HTTP status
ERRORS = {"no_pin_set": 409, "pin_locked": 423, "pin_invalid": 403, "not_authorized_level": 403, "staff_not_found": 404}


def now_ms() -> int:
    return int(time.time() * 1000)


def http_error(code: str):
    from fastapi import HTTPException
    return HTTPException(ERRORS.get(code, 403), code)


def password_hash(secret: str, salt_hex: str) -> str:
    """Same KDF as routes/auth_leaf.password_hash (auth_user passwords)."""
    return hashlib.scrypt(secret.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=64).hex()


def valid_pin(pin: Any) -> bool:
    return isinstance(pin, str) and PIN_PATTERN.fullmatch(pin) is not None


def hash_pin(pin: str) -> str:
    if not valid_pin(pin):
        raise ValueError("PIN must be 4-6 digits")
    salt = secrets.token_hex(16)
    return f"scrypt${salt}${password_hash(pin, salt)}"


def verify_pin(pin: Any, stored: str | None) -> bool:
    if not valid_pin(pin) or not stored:
        return False
    parts = stored.split("$")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    try:
        return hmac.compare_digest(password_hash(pin, parts[1]), parts[2])
    except (TypeError, ValueError):
        return False


def locked(row: dict[str, Any], now: int) -> bool:
    return bool(row.get("pin_locked_until")) and int(row["pin_locked_until"]) > now


def after_failure(failed: int, now: int) -> tuple[int, int | None]:
    """(pin_failed, pin_locked_until) after one more wrong PIN: the fifth locks and resets the count."""
    failed = int(failed or 0) + 1
    return (0, now + LOCK_MS) if failed >= MAX_FAILURES else (failed, None)


def check(row: dict[str, Any], pin: Any, now: int) -> str | None:
    """Pure: None when the PIN is accepted, else an error code (lock is checked before the PIN)."""
    if not row.get("pin_hash"):
        return "no_pin_set"
    if locked(row, now):
        return "pin_locked"
    return None if verify_pin(pin, row["pin_hash"]) else "pin_invalid"


def staff_by_code(database: "Connection", staff_code: Any) -> dict[str, Any] | None:
    code = str(staff_code or "").strip()
    if not code:
        return None
    return database.execute(
        """SELECT s.id, s.staff_code, s.staff_name, s.staff_role_id, s.staff_role, s.pin_hash, s.pin_failed,
                  s.pin_locked_until, coalesce(r.staff_type, 'other') AS staff_type, coalesce(r.seniority, 0) AS seniority
           FROM staff_directory s LEFT JOIN staff_role r ON r.id = s.staff_role_id
           WHERE lower(s.staff_code) = lower(%s) AND s.is_active = 1""", (code,)).fetchone()


def attempt(database: "Connection", staff_id: int, pin: Any, on_failure=None) -> str | None:
    """Verify a PIN, recording failures / locks (committed even when the request then fails).
    `on_failure(code)` runs inside the same transaction (audit). Returns None or the error code."""
    now = now_ms()
    with database.transaction():
        row = database.execute("SELECT id, pin_hash, pin_failed, pin_locked_until FROM staff_directory WHERE id=%s FOR UPDATE",
                               (staff_id,)).fetchone()
        if row is None:
            return "staff_not_found"
        error = check(row, pin, now)
        if error == "pin_invalid":
            failed, until = after_failure(row["pin_failed"], now)
            database.execute("UPDATE staff_directory SET pin_failed=%s, pin_locked_until=coalesce(%s, pin_locked_until) WHERE id=%s",
                             (failed, until, staff_id))
            if until:
                error = "pin_locked"
        elif error is None and (row["pin_failed"] or row["pin_locked_until"]):
            database.execute("UPDATE staff_directory SET pin_failed=0, pin_locked_until=NULL WHERE id=%s", (staff_id,))
        if error and on_failure:
            on_failure(error)
    return error


def set_pin(database: "Connection", staff_id: int, pin_hash: str | None) -> None:
    """Store (or clear) a PIN hash; a coded person is queued for the directory push so it reaches Canopy."""
    current = now_ms()
    database.execute(
        """UPDATE staff_directory SET pin_hash=%s, pin_set_at=%s, pin_failed=0, pin_locked_until=NULL,
             directory_pending = CASE WHEN coalesce(staff_code, '') <> '' THEN 1 ELSE directory_pending END,
             directory_version = CASE WHEN coalesce(staff_code, '') <> '' THEN %s ELSE directory_version END,
             updated_at=%s WHERE id=%s""", (pin_hash, current, current, current, staff_id))
