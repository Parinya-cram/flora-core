"""Applies migration 0090 (multi-case + live stream) and later Leaf migrations (0097 scheduled form entries)
to a Leaf database created before them.

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


def form_entry_missing(connection) -> bool:
    return connection.execute("SELECT to_regclass('case_form_entry') IS NULL").fetchone()[0]


# Later Leaf migrations applied the same way: (file, check that says it is still missing).
LATER = [(Path(__file__).parent / "tenancy_sql" / "0097-case-form-entry.sql", form_entry_missing)]


def apply(url: str, migration: Path, is_missing) -> bool:
    try:
        with psycopg.connect(url, autocommit=True) as connection:
            if not is_missing(connection):
                return False
            connection.execute(migration.read_text(encoding="utf-8"))
        log.warning("applied %s", migration.name)
        return True
    except Exception:  # noqa: BLE001 - the Leaf keeps running the features that do not need it
        log.exception("could not apply %s", migration.name)
        return False


def ensure_live_schema() -> bool:
    url = os.getenv("FLORA_MIGRATION_DATABASE_URL", "").strip() or DATABASE_URL
    applied = apply(url, MIGRATION, missing)
    for migration, is_missing in LATER:
        applied = apply(url, migration, is_missing) or applied
    return applied
