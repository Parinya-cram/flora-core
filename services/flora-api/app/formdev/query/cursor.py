"""Signed keyset cursors (Phase 4.5).

token = base64url(payload) "." base64url(HMAC-SHA256(secret, payload)), payload =
{v: [order value, record_id], q: query-shape fingerprint, s: principal user id, e: expiry ms}.
A cursor only works for the same query shape, the same user and until it expires; values are
type-checked before they are bound, so a forged or stale cursor is a 400, never a 500.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from typing import Any

from ..errors import FormDevError

MAX_TOKEN = 2048
RECORD_ID = re.compile(r"^[A-Za-z0-9-]{8,64}\Z")
TTL_MS = 60 * 60 * 1000


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def encode(secret: bytes, values: list[Any], fingerprint: str, user_id: Any, now_ms: int) -> str:
    payload = _b64(json.dumps({"v": values, "q": fingerprint, "s": user_id, "e": now_ms + TTL_MS}, separators=(",", ":")).encode())
    return f"{payload}.{_b64(hmac.new(secret, payload.encode('ascii'), hashlib.sha256).digest())}"


def decode(secret: bytes, token: str, fingerprint: str, user_id: Any, now_ms: int, order_kind: str, unique: bool) -> tuple[Any, ...]:
    """Return the keyset tuple or raise invalid_cursor."""
    try:
        if not isinstance(token, str) or len(token) > MAX_TOKEN or "." not in token:
            raise ValueError
        payload, signature = token.split(".", 1)
        expected = _b64(hmac.new(secret, payload.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        data = json.loads(_unb64(payload))
        if data.get("q") != fingerprint or data.get("s") != user_id or int(data.get("e", 0)) < now_ms:
            raise ValueError
        values = data.get("v")
        if not isinstance(values, list) or len(values) != (1 if unique else 2):
            raise ValueError
        order_value = values[0]
        if order_kind == "record_id":
            if not isinstance(order_value, str) or not RECORD_ID.match(order_value):
                raise ValueError
        elif not isinstance(order_value, int) or isinstance(order_value, bool):
            raise ValueError
        if not unique and (not isinstance(values[1], str) or not RECORD_ID.match(values[1])):
            raise ValueError
        return tuple(values)
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        raise FormDevError("invalid_cursor", "The page cursor is invalid or expired; start again from the first page", 400) from None
