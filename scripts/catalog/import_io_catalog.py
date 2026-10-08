#!/usr/bin/env python3
"""Import the medication / fluid / output catalogue (CSV) into a Flora database.

    python3 scripts/catalog/import_io_catalog.py [csv] | docker exec -i <db-container> psql -U flora_admin -d flora

Prints idempotent SQL: groups are created when missing (new ones are appended after
the existing groups of their kind), items are inserted or updated by `code`, and
nothing is deleted, so items added locally and every case referencing an item keep
working. Columns: kind, code, name, group_code, default_unit, note.
"""
import csv
import sys
from pathlib import Path

DEFAULT_CSV = Path(__file__).resolve().parents[2] / "infrastructure/catalog/io-medication-fluid.csv"
GROUP_NAMES = {"crystalloid": "Crystalloid", "colloid": "Colloid"}


def quote(value: str | None) -> str:
    return "NULL" if value in (None, "") else "'" + str(value).replace("'", "''") + "'"


def main() -> None:
    rows = list(csv.DictReader(open(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV, encoding="utf-8")))
    now = "(extract(epoch from clock_timestamp())*1000)::bigint"
    print("BEGIN;")
    for group in sorted({(row["group_code"], row["kind"]) for row in rows}):
        code, kind = group
        print(f"""INSERT INTO io_group_master(code,display_name,kind,is_active,sort_order,created_at,updated_at)
SELECT {quote(code)},{quote(GROUP_NAMES.get(code, code))},{quote(kind)},1,
       coalesce((SELECT max(sort_order) FROM io_group_master WHERE kind={quote(kind)}),0)+10,{now},{now}
WHERE NOT EXISTS (SELECT 1 FROM io_group_master WHERE code={quote(code)});""")
    for row in rows:
        print(f"""INSERT INTO io_item_master(kind,code,name,default_unit,category,group_id,is_active,created_at,updated_at)
VALUES ({quote(row['kind'])},{quote(row['code'])},{quote(row['name'])},{quote(row['default_unit'])},{quote(row['group_code'])},
        (SELECT id FROM io_group_master WHERE code={quote(row['group_code'])}),1,{now},{now})
ON CONFLICT (code) DO UPDATE SET kind=excluded.kind,name=excluded.name,default_unit=excluded.default_unit,
  category=excluded.category,group_id=excluded.group_id,is_active=1,updated_at=excluded.updated_at;""")
    print("COMMIT;")


if __name__ == "__main__":
    main()
