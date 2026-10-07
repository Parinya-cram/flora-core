#!/usr/bin/env python3
"""Build a FormDev lookup table (Phase 2.3) from a CSV file, and optionally upload it.

The CSV is the user's own copy of the source data (for Thai addresses: the official DOPA / Thailand Post list);
nothing is downloaded. Columns are mapped to lookup column names, blank and duplicate rows are dropped, and the
result is validated exactly as the server validates it.

    # write a registry file (then: python3 formdev/scripts/sync_registry_seed.py to seed fresh installs)
    python3 formdev/scripts/import_lookup.py thai_address addresses.csv \\
        --title "ที่อยู่ประเทศไทย" --map province=ProvinceThai --map district=DistrictThai \\
        --map subdistrict=TambonThai --map postcode=PostCodeMain --source "DOPA 2026-09" --authoritative \\
        --version 2 --out formdev/registry/lookups/thai_address.json

    # or upload to a running API as an administrator (the server bumps the version)
    FORMDEV_SESSION=... python3 formdev/scripts/import_lookup.py thai_address addresses.csv ... \\
        --api http://127.0.0.1:7990/api/formdev

--map name=CSV header (repeatable; default: every CSV header, lowercased). --label name=Text sets a column label.
The session token is read from the FORMDEV_SESSION environment variable and never printed.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app.formdev.lookups import validate_lookup  # noqa: E402


def pairs(values: list[str], flag: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for value in values:
        name, sep, target = value.partition("=")
        if not sep or not name or not target:
            sys.exit(f"{flag} expects name=value, got {value!r}")
        out[name.strip()] = target.strip()
    return out


def build(args: argparse.Namespace) -> dict:
    with open(args.csv, encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=args.delimiter)
        headers = reader.fieldnames or []
        mapping = pairs(args.map, "--map") or {header.strip().lower(): header for header in headers}
        missing = [header for header in mapping.values() if header not in headers]
        if missing:
            sys.exit(f"CSV has no column(s) {missing}; it has {headers}")
        seen: set[tuple] = set()
        entries = []
        for row in reader:
            entry = {name: (row.get(header) or "").strip() for name, header in mapping.items()}
            entry = {name: value for name, value in entry.items() if value}
            key = tuple(sorted(entry.items()))
            if entry and key not in seen:
                seen.add(key)
                entries.append(entry)
    labels = pairs(args.label, "--label")
    metadata = {"title": args.title, "columns": [{"name": name, "label": labels.get(name, name)} for name in mapping],
                "authoritative": args.authoritative}
    if args.source:
        metadata["source"] = args.source
    if args.notice:
        metadata["notice"] = args.notice
    issues = validate_lookup(args.lookup_id, metadata, entries)
    if issues:
        for issue in issues[:20]:
            print(f"{issue.path}: {issue.message}", file=sys.stderr)
        sys.exit("lookup is not valid; nothing written")
    return {"lookup_id": args.lookup_id, "version": args.version, "metadata": metadata, "entries": entries}


def upload(base: str, table: dict) -> None:
    token = os.environ.get("FORMDEV_SESSION", "")
    if not token:
        sys.exit("set FORMDEV_SESSION to an administrator's session token to upload")
    body = json.dumps({"metadata": table["metadata"], "entries": table["entries"]}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(f"{base.rstrip('/')}/lookups/{table['lookup_id']}", data=body, method="PUT")
    request.add_header("Content-Type", "application/json")
    request.add_header("X-FLORA-Session", token)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            saved = json.loads(response.read())["lookup"]
    except urllib.error.HTTPError as error:
        sys.exit(f"upload refused ({error.code}): {error.read()[:500].decode('utf-8', 'replace')}")
    print(f"uploaded {table['lookup_id']} as version {saved['version']} ({len(table['entries'])} rows)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("lookup_id")
    parser.add_argument("csv")
    parser.add_argument("--title", required=True)
    parser.add_argument("--map", action="append", default=[])
    parser.add_argument("--label", action="append", default=[])
    parser.add_argument("--source")
    parser.add_argument("--notice")
    parser.add_argument("--authoritative", action="store_true", help="the data comes from the official source")
    parser.add_argument("--version", type=int, default=1, help="registry file version (the sample is 1; an import should be higher)")
    parser.add_argument("--delimiter", default=",")
    parser.add_argument("--out", help="write a registry JSON file")
    parser.add_argument("--api", help="upload to this FormDev API base, e.g. http://127.0.0.1:7990/api/formdev")
    args = parser.parse_args()
    if not args.out and not args.api:
        parser.error("give --out, --api or both")
    table = build(args)
    if args.out:
        Path(args.out).write_text(json.dumps(table, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.out}: {len(table['entries'])} rows")
    if args.api:
        upload(args.api, table)
    return 0


if __name__ == "__main__":
    sys.exit(main())
