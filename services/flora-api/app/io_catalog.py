"""Medication / fluid / output catalogue shared from Canopy to every Leaf.

Canopy holds the hospital catalogue (imported from infrastructure/catalog/*.csv with
scripts/catalog/import_io_catalog.py). It travels to Leafs with the directory
exchange; a Leaf upserts groups and items by `code` and never deletes, so items a Leaf
added itself and every case that references an item keep working.
"""
from typing import Any

from psycopg import Connection

GROUP_FIELDS = ("code", "display_name", "kind", "is_active", "sort_order")
ITEM_FIELDS = ("kind", "code", "name", "default_unit", "category", "is_active")


def load(database: Connection) -> dict[str, Any]:
    """Canopy side: the whole catalogue plus a version (latest change)."""
    groups = database.execute(f"SELECT {','.join(GROUP_FIELDS)},updated_at FROM io_group_master ORDER BY kind,sort_order,code").fetchall()
    items = database.execute(
        f"""SELECT {','.join('i.' + f for f in ITEM_FIELDS)},i.updated_at,g.code AS group_code
            FROM io_item_master i LEFT JOIN io_group_master g ON g.id=i.group_id
            WHERE i.code IS NOT NULL ORDER BY i.kind,i.code"""
    ).fetchall()
    version = max([int(row["updated_at"] or 0) for row in [*groups, *items]] or [0])
    return {"version": version, "groups": [dict(row) for row in groups], "items": [dict(row) for row in items]}


def apply(database: Connection, catalog: dict[str, Any], current_version: int) -> int:
    """Leaf side: upsert a newer catalogue by code. Returns the version now held."""
    version = int(catalog.get("version") or 0)
    if version <= current_version:
        return current_version
    with database.transaction():
        for group in catalog.get("groups") or []:
            database.execute(
                """INSERT INTO io_group_master(code,display_name,kind,is_active,sort_order,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (code) DO UPDATE SET display_name=excluded.display_name,kind=excluded.kind,
                     is_active=excluded.is_active,sort_order=excluded.sort_order,updated_at=excluded.updated_at""",
                (group["code"], group["display_name"], group["kind"], int(group.get("is_active", 1)),
                 int(group.get("sort_order") or 0), int(group.get("updated_at") or version), int(group.get("updated_at") or version)),
            )
        for item in catalog.get("items") or []:
            database.execute(
                """INSERT INTO io_item_master(kind,code,name,default_unit,category,group_id,is_active,created_at,updated_at)
                   VALUES (%s,%s,%s,%s,%s,(SELECT id FROM io_group_master WHERE code=%s),%s,%s,%s)
                   ON CONFLICT (code) DO UPDATE SET kind=excluded.kind,name=excluded.name,default_unit=excluded.default_unit,
                     category=excluded.category,group_id=coalesce(excluded.group_id,io_item_master.group_id),
                     is_active=excluded.is_active,updated_at=excluded.updated_at""",
                (item["kind"], item["code"], item["name"], item.get("default_unit"), item.get("category"),
                 item.get("group_code"), int(item.get("is_active", 1)),
                 int(item.get("updated_at") or version), int(item.get("updated_at") or version)),
            )
        database.execute("UPDATE auth_directory_state SET io_catalog_version=%s WHERE id=1", (version,))
    return version
