"""Chart undo: revert the latest chart action of the signed-in user on a case.

The database logs every change to the chart's tables made under an
X-Flora-Change-Set id (0078-case-change-log.sql): vital edits, invalid marks,
events, fluids/medications/drips/blood. Undo restores the before images of the
user's latest action, newest first. It refuses when a row was changed again
since (by another action, user or device), so it never overwrites later work.
"""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from psycopg import Connection, sql
from psycopg.types.json import Jsonb

from ..clinical import case_audit
from ..database import connection
from .auth_leaf import now_ms, require_permission
from .cases_lifecycle import editable_case

router = APIRouter(prefix="/api/case", tags=["chart undo"])

# Parents first: a deleted run is put back before its segments.
TABLES = ("case_io_run", "case_io_segment", "case_io_event", "case_event_note", "case_timeline_value", "case_timeline_mask")
LABELS = {
    "case_timeline_value": "vital value", "case_timeline_mask": "invalid mark", "case_event_note": "event",
    "case_io_run": "fluid / medication", "case_io_segment": "drip rate", "case_io_event": "fluid / medication",
}


def latest_set(database: Connection, case_id: int, username: str) -> dict[str, Any] | None:
    return database.execute(
        """SELECT change_set, max(id) AS last_id, max(created_at) AS created_at, count(*) AS entries,
                  array_agg(DISTINCT table_name) AS tables
           FROM case_change_log
           WHERE case_id=%s AND actor=%s AND undone_at IS NULL
             AND change_set = (SELECT change_set FROM case_change_log
                               WHERE case_id=%s AND actor=%s AND undone_at IS NULL ORDER BY id DESC LIMIT 1)
           GROUP BY change_set""",
        (case_id, username, case_id, username),
    ).fetchone()


def describe(found: dict[str, Any] | None) -> dict[str, Any]:
    if not found:
        return {"available": False}
    labels = sorted({LABELS.get(table, table) for table in found["tables"]})
    return {"available": True, "change_set": found["change_set"], "entries": found["entries"],
            "created_at": found["created_at"], "label": ", ".join(labels)}


def columns(database: Connection, table: str) -> list[str]:
    rows = database.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position",
        (table,)).fetchall()
    return [row["column_name"] for row in rows if row["column_name"] != "id"]


def current_row(database: Connection, table: str, row_id: int) -> Any:
    row = database.execute(sql.SQL("SELECT to_jsonb(t) AS r FROM {} t WHERE id=%s").format(sql.Identifier(table)),
                           (row_id,)).fetchone()
    return row["r"] if row else None


def require_unchanged(database: Connection, entry: dict[str, Any]) -> None:
    now = current_row(database, entry["table_name"], entry["row_id"])
    if now != entry["new_row"]:
        raise HTTPException(409, f"The {LABELS.get(entry['table_name'], 'entry')} was changed again afterwards, so this "
                                 "action cannot be undone. Undo the later change first or correct it by hand.")


@router.get("/{case_id}/undo")
def undo_status(case_id: int, actor: dict = Depends(require_permission("case.chart")),
                database: Connection = Depends(connection)) -> dict:
    return describe(latest_set(database, case_id, actor["username"]))


@router.post("/{case_id}/undo")
def undo(case_id: int, payload: dict = Body(default={}), actor: dict = Depends(require_permission("case.chart")),
         database: Connection = Depends(connection)) -> dict:
    with database.transaction():
        # The revert itself is not a chart action: keep it out of the change log.
        database.execute("SELECT set_config('flora.change_set', '', true)")
        database.execute("SELECT pg_advisory_xact_lock(6894, %s)", (case_id,))
        editable_case(database, case_id)
        found = latest_set(database, case_id, actor["username"])
        if not found:
            raise HTTPException(404, "nothing to undo")
        if payload.get("change_set") and payload["change_set"] != found["change_set"]:
            raise HTTPException(409, "the chart changed; refresh and try again")
        entries = [dict(row) for row in database.execute(
            "SELECT * FROM case_change_log WHERE change_set=%s AND case_id=%s AND undone_at IS NULL ORDER BY id DESC",
            (found["change_set"], case_id)).fetchall()]
        if any(entry["table_name"] not in TABLES for entry in entries):
            raise HTTPException(409, "this change cannot be undone")
        # Newest first: remove inserted rows and roll updates back...
        for entry in entries:
            if entry["op"] == "DELETE":
                continue
            require_unchanged(database, entry)
            table = sql.Identifier(entry["table_name"])
            if entry["op"] == "INSERT":
                database.execute(sql.SQL("DELETE FROM {} WHERE id=%s").format(table), (entry["row_id"],))
            else:
                names = columns(database, entry["table_name"])
                database.execute(
                    sql.SQL("UPDATE {t} SET ({c}) = (SELECT {c} FROM jsonb_populate_record(NULL::{t}, %s)) WHERE id=%s").format(
                        t=table, c=sql.SQL(",").join(map(sql.Identifier, names))),
                    (Jsonb(entry["old_row"]), entry["row_id"]))
        # ...then put deleted rows back, parents before children.
        deleted = sorted((entry for entry in entries if entry["op"] == "DELETE"),
                         key=lambda entry: (TABLES.index(entry["table_name"]), entry["id"]))
        for entry in deleted:
            if current_row(database, entry["table_name"], entry["row_id"]) is not None:
                raise HTTPException(409, "a deleted entry already exists again; cannot undo")
            table = sql.Identifier(entry["table_name"])
            database.execute(sql.SQL("INSERT INTO {t} SELECT * FROM jsonb_populate_record(NULL::{t}, %s)").format(t=table),
                             (Jsonb(entry["old_row"]),))
        stamp = now_ms()
        database.execute("UPDATE case_change_log SET undone_at=%s, undone_by=%s WHERE change_set=%s AND case_id=%s",
                         (stamp, actor["username"], found["change_set"], case_id))
        summary = describe(found)
        case_audit(database, case_id, "chart.undo", {"change_set": found["change_set"], "label": summary["label"],
                                                       "entries": found["entries"]}, None, actor)
    return {"ok": True, "undone": summary, "next": describe(latest_set(database, case_id, actor["username"]))}
