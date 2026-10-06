import json
import time
from pathlib import Path
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from . import settings

pool = ConnectionPool(settings.DATABASE_URL, min_size=1, max_size=5, open=False,
                      kwargs={"row_factory": dict_row, "autocommit": True})


def now_ms() -> int:
    return int(time.time() * 1000)


def fetch_all(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with pool.connection() as connection:
        return connection.execute(sql, params).fetchall()


def fetch_one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    with pool.connection() as connection:
        return connection.execute(sql, params).fetchone()


def execute(sql: str, params: tuple = ()) -> None:
    with pool.connection() as connection:
        connection.execute(sql, params)


def migrate() -> list[str]:
    """Applies app/migrations/*.sql once each, in name order, under an advisory lock."""
    applied = []
    with pool.connection() as connection:
        connection.execute("SELECT pg_advisory_lock(7400)")
        try:
            connection.execute("""CREATE TABLE IF NOT EXISTS gateway_schema_migration (
                                    name text PRIMARY KEY, applied_at bigint NOT NULL)""")
            done = {row["name"] for row in connection.execute("SELECT name FROM gateway_schema_migration")}
            for path in sorted((Path(__file__).parent / "migrations").glob("*.sql")):
                if path.name in done:
                    continue
                with connection.transaction():
                    connection.execute(path.read_text())
                    connection.execute("INSERT INTO gateway_schema_migration (name, applied_at) VALUES (%s,%s)",
                                       (path.name, now_ms()))
                applied.append(path.name)
        finally:
            connection.execute("SELECT pg_advisory_unlock(7400)")
    return applied


def upsert_manufacturer(code: str, name: str | None = None) -> None:
    current = now_ms()
    execute("""INSERT INTO gateway_device_manufacturer (code,name,created_at,updated_at) VALUES (%s,%s,%s,%s)
               ON CONFLICT (code) DO NOTHING""", (code, name or code, current, current))


def upsert_device_types(types: list[dict[str, Any]], source: str) -> int:
    current = now_ms()
    for item in types:
        if item.get("manufacturer"):
            upsert_manufacturer(item["manufacturer"], item.get("manufacturer_name"))
    with pool.connection() as connection:
        for item in types:
            connection.execute(
                """INSERT INTO gateway_device_type
                     (code,label,category,protocol,controller,parser,image,default_options,source,haber_version,synced_at,
                      manufacturer,model,description,connection_defaults,origin)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (code) DO UPDATE SET label=excluded.label, category=excluded.category,
                     protocol=excluded.protocol, controller=excluded.controller, parser=excluded.parser,
                     image=excluded.image, default_options=excluded.default_options, source=excluded.source,
                     haber_version=excluded.haber_version, synced_at=excluded.synced_at, origin=excluded.origin,
                     manufacturer=COALESCE(excluded.manufacturer, gateway_device_type.manufacturer),
                     model=COALESCE(excluded.model, gateway_device_type.model),
                     description=COALESCE(excluded.description, gateway_device_type.description),
                     connection_defaults=CASE WHEN excluded.connection_defaults = '{}'::jsonb
                       THEN gateway_device_type.connection_defaults ELSE excluded.connection_defaults END""",
                (item["code"], item["label"], item.get("category", "device"), item["protocol"], item["controller"],
                 item["parser"], item.get("image") or settings.PARSER_IMAGE, Jsonb(item.get("default_options") or {}),
                 source, str(item.get("version") or ""), current,
                 item.get("manufacturer"), item.get("model"), item.get("description"),
                 Jsonb(item.get("connection_defaults") or {}),
                 # Canopy marks a hospital's own types origin="canopy"; everything else came from a Root release.
                 "canopy" if item.get("origin") == "canopy" else "root"),
            )
    return len(types)


def store_parser_images(images: list[dict[str, Any]], types: list[dict[str, Any]], release_id: str | None) -> None:
    """Replaces the image list with what Canopy delivered: its image catalog plus every image a synced type uses."""
    parsers: dict[str, dict[str, Any]] = {}
    for item in images:
        parsers[item["image"]] = {"version": item.get("version"), "registry": item.get("registry"),
                                  "parsers": set(item.get("parsers") or [])}
    for item in types:
        if item.get("image"):
            entry = parsers.setdefault(item["image"], {"version": item.get("version"), "registry": None, "parsers": set()})
            entry["parsers"].add(item["parser"])
    if not parsers:
        return
    current = now_ms()
    with pool.connection() as connection, connection.transaction():
        connection.execute("DELETE FROM gateway_parser_image")
        for image, entry in parsers.items():
            connection.execute(
                "INSERT INTO gateway_parser_image (image,version,registry,parsers,release_id,synced_at) VALUES (%s,%s,%s,%s,%s,%s)",
                (image, entry["version"], entry["registry"], sorted(entry["parsers"]), release_id, current))


def store_license(license_: dict[str, Any], tenant_id: str | None) -> None:
    execute(
        """INSERT INTO gateway_license (id,gateway_id,tenant_id,max_devices,allowed_types,expires_at,bundle_id,raw,synced_at)
           VALUES (1,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (id) DO UPDATE SET gateway_id=excluded.gateway_id, tenant_id=excluded.tenant_id,
             max_devices=excluded.max_devices, allowed_types=excluded.allowed_types, expires_at=excluded.expires_at,
             bundle_id=excluded.bundle_id, raw=excluded.raw, synced_at=excluded.synced_at""",
        (settings.GATEWAY_ID, tenant_id, int(license_.get("max_devices", 0)), list(license_.get("allowed_types") or []),
         license_.get("expires_at"), license_.get("bundle_id"), Jsonb(license_), now_ms()),
    )


def instance_row(row: dict[str, Any]) -> dict[str, Any]:
    if isinstance(row.get("options"), str):
        row["options"] = json.loads(row["options"])
    return row
