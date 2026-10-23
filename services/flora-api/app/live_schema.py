"""Applies migration 0090 (multi-case + live stream) to a Leaf database created before it.

A Leaf database only runs migrations when its volume is first initialised. This runs the bundled
file once, when its tables are missing. ALTER TABLE cases needs the table owner, so it connects as
FLORA_MIGRATION_DATABASE_URL (the database owner) when set.
"""
import logging
import os
from pathlib import Path

import psycopg

from .database import DATABASE_URL

MIGRATION = Path(__file__).parent / "tenancy_sql" / "0090-leaf-live-stream.sql"
log = logging.getLogger("flora.live_schema")


def missing(connection) -> bool:
    row = connection.execute(
        """SELECT to_regclass('stream_wave') IS NULL
                  OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                                 WHERE table_schema = current_schema() AND table_name = 'cases' AND column_name = 'bed_label')"""
    ).fetchone()
    return bool(row[0])


def ensure_live_schema() -> bool:
    url = os.getenv("FLORA_MIGRATION_DATABASE_URL", "").strip() or DATABASE_URL
    try:
        with psycopg.connect(url, autocommit=True) as connection:
            if not missing(connection):
                return False
            connection.execute(MIGRATION.read_text(encoding="utf-8"))
        log.warning("applied %s", MIGRATION.name)
        return True
    except Exception:  # noqa: BLE001 - the Leaf keeps running single-case features without it
        log.exception("could not apply %s", MIGRATION.name)
        return False
