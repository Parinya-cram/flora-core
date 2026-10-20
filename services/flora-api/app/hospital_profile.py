"""The hospital's name and logo on printed reports and forms (0092): set in Canopy, sent to every Leaf with the ward
exchange and kept there, so printing works offline. Forms print it with a logo field whose src is "hospital"; the
Leaf anesthesia report prints it in its header (until one is set, the report keeps its built-in logo)."""
from __future__ import annotations

import re
import time
from typing import Any

from fastapi import HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb

LOGO = re.compile(r"^data:image/(png|jpeg);base64,[A-Za-z0-9+/=\s]+$")
MAX_LOGO_CHARS = 400_000


def _clean(payload: dict[str, Any]) -> dict[str, Any]:
    name_th = str(payload.get("name_th") or "").strip()[:200]
    name_en = str(payload.get("name_en") or "").strip()[:200]
    logo = payload.get("logo") or None
    if logo is not None and (not isinstance(logo, str) or len(logo) > MAX_LOGO_CHARS or not LOGO.match(logo)):
        raise HTTPException(status_code=422, detail=f"logo must be a PNG or JPEG data URL of at most {MAX_LOGO_CHARS} characters")
    return {"name_th": name_th, "name_en": name_en, "logo": logo}


def canopy_get(database: Connection) -> dict[str, Any] | None:
    if database.execute("SELECT to_regclass('canopy_hospital_profile') AS t").fetchone()["t"] is None:
        return None
    row = database.execute("SELECT name_th, name_en, logo, updated_at, updated_by FROM canopy_hospital_profile WHERE id=1").fetchone()
    return dict(row) if row else None


def canopy_put(database: Connection, payload: dict[str, Any], user: str) -> dict[str, Any]:
    clean = _clean(payload)
    now = int(time.time() * 1000)
    database.execute(
        """INSERT INTO canopy_hospital_profile (id, name_th, name_en, logo, updated_at, updated_by) VALUES (1,%s,%s,%s,%s,%s)
           ON CONFLICT (id) DO UPDATE SET name_th=excluded.name_th, name_en=excluded.name_en, logo=excluded.logo,
             updated_at=excluded.updated_at, updated_by=excluded.updated_by""",
        (clean["name_th"], clean["name_en"], clean["logo"], now, user))
    return canopy_get(database) or {}


def delivery(database: Connection) -> dict[str, Any] | None:
    """The profile for the ward exchange; None when Canopy has none (the Leaf keeps what it has)."""
    try:
        return canopy_get(database)
    except Exception:
        return None


def leaf_get(database: Connection) -> dict[str, Any]:
    if database.execute("SELECT to_regclass('leaf_hospital_profile') AS t").fetchone()["t"] is None:
        return {}
    row = database.execute("SELECT payload, synced_at FROM leaf_hospital_profile WHERE id=1").fetchone()
    return {**(row["payload"] or {}), "synced_at": row["synced_at"]} if row else {}


def leaf_put(database: Connection, payload: dict[str, Any]) -> dict[str, Any]:
    clean = {**_clean(payload), "updated_at": payload.get("updated_at")}
    database.execute(
        """INSERT INTO leaf_hospital_profile (id, payload, synced_at) VALUES (1,%s,%s)
           ON CONFLICT (id) DO UPDATE SET payload=excluded.payload, synced_at=excluded.synced_at""",
        (Jsonb(clean), int(time.time() * 1000)))
    return clean
