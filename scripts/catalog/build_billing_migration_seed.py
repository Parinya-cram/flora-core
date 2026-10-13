#!/usr/bin/env python3
"""Print the seed SQL for the anesthesia billing checklist master.

Source: infrastructure/catalog/billing-anesthesia-checklist.csv (the hospital's
"Anesthesia Check List (Billing)" form). The seed lands in Canopy and every Leaf
on a fresh database; afterwards Canopy owns the master and syncs it down.

    python3 scripts/catalog/build_billing_migration_seed.py > /tmp/seed.sql
"""
import csv
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
GROUPS = [  # code, name, form column on the paper checklist
    ("gas", "Gas / Inhalation", 1), ("induction", "Induction Agent", 1), ("relaxant", "Muscle Relaxant", 1),
    ("narcotic", "Narcotics", 1), ("reversal", "Reversal Agent", 1), ("local", "Local Anesthesia", 2),
    ("fluid", "Fluids", 2), ("othermed", "Other Medication", 2), ("equipment", "Other Equipment", 3),
    ("disposable", "Disposable Supply", 3), ("sensor", "Lab and Disposable Sensor", 4),
    ("technique", "Anesthetic Technique", 4), ("pacu", "PACU care", 4),
]
STAMP = 1760313600000  # 2025-10-13: seed version; any Canopy edit is newer


def q(value):
    return "NULL" if value in (None, "") else "'" + str(value).replace("'", "''") + "'"


def main():
    print("INSERT INTO billing_group(code,name,form_column,sort_order,is_active,created_at,updated_at) VALUES")
    print(",\n".join(f" ({q(c)},{q(n)},{col},{i * 10},1,{STAMP},{STAMP})" for i, (c, n, col) in enumerate(GROUPS)))
    print("ON CONFLICT (code) DO NOTHING;\n")
    rows = list(csv.DictReader((ROOT / "infrastructure/catalog/billing-anesthesia-checklist.csv").open()))
    print("INSERT INTO billing_item(code,group_code,name,unit,qty_mode,variant_label,io_item_code,sort_order,is_active,created_at,updated_at) VALUES")
    print(",\n".join(
        f" ({q(r['code'])},{q(r['group_code'])},{q(r['name'])},{q(r['unit'])},{q(r['qty_mode'])},{q(r['variant_label'])},"
        f"{q(r['io_item_code'])},{i * 10},1,{STAMP},{STAMP})" for i, r in enumerate(rows)))
    print("ON CONFLICT (code) DO NOTHING;")


if __name__ == "__main__":
    main()
