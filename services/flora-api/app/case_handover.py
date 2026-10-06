"""Full-fidelity case export/import for handing a case to another Leaf.

The viewer snapshot is a 24 h window of API views; this is every stored row of the
case, so a different Leaf can continue it even when the original Leaf is gone.
Leaf-local ids are translated on import: I/O items by `io_item_master.code`,
clinical concepts by `clinical_concept(domain, local_id)`, I/O segments by their run.
Audit tables are not copied; the import writes one `handover.import` audit row.
"""
import json
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

EXPORT_VERSION = 1
# Rows that belong to a case, keyed by case_id (case_io_segment hangs off case_io_run).
CASE_TABLES = (
    "case_his_patient", "case_his_allergy", "case_allergy", "case_his_lab", "patient_snapshot",
    "case_diagnosis", "case_procedure", "case_staff", "case_detail", "vital_minutes",
    "case_event_note", "case_timeline_value", "case_io_run", "case_io_event",
)
CASE_COLUMNS_SKIP = {"id", "status", "case_code", "archive_time", "handover_from_leaf_id", "handover_from_case_id",
                     "handover_global_case_id", "handover_to_leaf_id", "handover_at", "canopy_admission_id"}


def _rows(database: Connection, sql: str, params: tuple) -> list[dict[str, Any]]:
    row = database.execute(f"SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM ({sql}) t", params).fetchone()
    return row["rows"]


def export_case(database: Connection, case_id: int) -> dict[str, Any] | None:
    case = _rows(database, "SELECT * FROM cases WHERE id=%s", (case_id,))
    if not case:
        return None
    tables = {table: _rows(database, f"SELECT * FROM {table} WHERE case_id=%s ORDER BY id", (case_id,))
              for table in CASE_TABLES}
    tables["case_io_segment"] = _rows(
        database, "SELECT s.* FROM case_io_segment s JOIN case_io_run r ON r.id=s.run_id WHERE r.case_id=%s ORDER BY s.id",
        (case_id,))
    item_ids = sorted({row["item_id"] for key in ("case_io_run", "case_io_event") for row in tables[key] if row.get("item_id")})
    concept_ids = sorted({row["concept_id"] for key in ("case_diagnosis", "case_procedure")
                          for row in tables[key] if row.get("concept_id")})
    items = {str(row["id"]): row["code"] for row in _rows(
        database, "SELECT id, code FROM io_item_master WHERE id = ANY(%s)", (item_ids,))}
    concepts = {str(row["id"]): [row["domain"], row["local_id"]] for row in _rows(
        database, "SELECT id, domain, local_id FROM clinical_concept WHERE id = ANY(%s)", (concept_ids,))}
    return {"version": EXPORT_VERSION, "case": case[0], "tables": tables, "items": items, "concepts": concepts}


def _columns(database: Connection, table: str) -> dict[str, str]:
    rows = database.execute(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=%s",
        (table,)).fetchall()
    return {row["column_name"]: row["data_type"] for row in rows}


def _value(value: Any, data_type: str) -> Any:
    if data_type in {"json", "jsonb"}:
        return None if value is None else Jsonb(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return value


def _insert(database: Connection, table: str, columns: dict[str, str], row: dict[str, Any]) -> int:
    names = [name for name in row if name != "id" and name in columns]
    placeholders = ", ".join(["%s"] * len(names))
    result = database.execute(
        f"INSERT INTO {table} ({', '.join(names)}) VALUES ({placeholders}) RETURNING id",
        tuple(_value(row[name], columns[name]) for name in names),
    ).fetchone()
    return result["id"]


def import_case(database: Connection, export: dict[str, Any], *, from_leaf_id: str, global_case_id: str,
                actor: str, now: int) -> dict[str, Any]:
    """Insert the exported case as this Leaf's active case. Caller holds the start-case lock."""
    if int(export.get("version") or 0) != EXPORT_VERSION:
        raise ValueError(f"unsupported export version {export.get('version')}")
    source = export["case"]
    case_columns = _columns(database, "cases")
    code = source.get("case_code") or f"HO-{global_case_id[:8]}"
    if database.execute("SELECT 1 FROM cases WHERE case_code=%s", (code,)).fetchone():
        code = f"{code}-HO{now % 100000}"
    row = {name: value for name, value in source.items() if name not in CASE_COLUMNS_SKIP}
    row.update(case_code=code, status="active", discharge_time=None, updated_at=now,
               handover_from_leaf_id=from_leaf_id, handover_from_case_id=source["id"],
               handover_global_case_id=global_case_id, handover_at=now)
    case_id = _insert(database, "cases", case_columns, row)

    items = {code: item_id for code, item_id in (
        (r["code"], r["id"]) for r in database.execute(
            "SELECT id, code FROM io_item_master WHERE code = ANY(%s)", (list(export["items"].values()),)).fetchall())}
    concepts = {}
    for old_id, (domain, local_id) in export["concepts"].items():
        found = database.execute("SELECT id FROM clinical_concept WHERE domain=%s AND local_id=%s",
                                 (domain, local_id)).fetchone()
        concepts[old_id] = found["id"] if found else None
    counts, skipped, run_ids = {}, [], {}
    tables = export["tables"]
    for table in CASE_TABLES:
        columns = _columns(database, table)
        for item in tables.get(table) or []:
            item = {**item, "case_id": case_id}
            if "item_id" in item and item["item_id"] is not None:
                mapped = items.get(export["items"].get(str(item["item_id"])))
                if mapped is None:
                    skipped.append(f"{table}#{item['id']}: I/O item {export['items'].get(str(item['item_id']))} unknown here")
                    continue
                item["item_id"] = mapped
            if "concept_id" in item and item["concept_id"] is not None:
                item["concept_id"] = concepts.get(str(item["concept_id"]))
            new_id = _insert(database, table, columns, item)
            if table == "case_io_run":
                run_ids[item["id"]] = new_id
            counts[table] = counts.get(table, 0) + 1
    segment_columns = _columns(database, "case_io_segment")
    for segment in tables.get("case_io_segment") or []:
        if segment["run_id"] not in run_ids:
            continue
        _insert(database, "case_io_segment", segment_columns, {**segment, "run_id": run_ids[segment["run_id"]]})
        counts["case_io_segment"] = counts.get("case_io_segment", 0) + 1
    database.execute(
        """INSERT INTO case_clinical_audit (case_id, action, before_json, after_json, actor_username, actor_role, created_at)
           VALUES (%s, 'handover.import', NULL, %s, %s, 'integration', %s)""",
        (case_id, json.dumps({"from_leaf_id": from_leaf_id, "from_case_id": source["id"],
                              "global_case_id": global_case_id, "rows": counts, "skipped": skipped}), actor, now),
    )
    return {"case_id": case_id, "case_code": code, "rows": counts, "skipped": skipped}
