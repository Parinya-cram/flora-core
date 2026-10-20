#!/usr/bin/env python3
"""Copy the Canopy schema (dump + migrations, in Dockerfile.postgres.dev order) into the API package.

    python3 scripts/tenancy/build_schema_bundle.py          # write
    python3 scripts/tenancy/build_schema_bundle.py --check  # exit 1 when the bundle is out of date

A multi-account Canopy creates each account's schema from this bundle (app/tenancy_provision.py), so
it must contain every file a fresh database gets. Role scripts (CREATE ROLE, psql meta commands) are
left out: roles are shared by all accounts and exist already. Run it after adding a migration.
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "services/flora-api/app/tenancy_sql"
SKIP = {"0000-create-app-role.sql", "0003-create-view-role.sql"}


def sources() -> list[tuple[Path, str]]:
    files = []
    for line in (ROOT / "Dockerfile.postgres.dev").read_text().splitlines():
        match = re.match(r"COPY (\S+\.sql) /docker-entrypoint-initdb\.d/(\S+\.sql)", line.strip())
        if match and Path(match.group(1)).name not in SKIP:
            files.append((ROOT / match.group(1), match.group(2)))
    return files


def main() -> int:
    files = sources()
    manifest = [name for _, name in files]
    if "--check" in sys.argv:
        current = json.loads((TARGET / "manifest.json").read_text()) if (TARGET / "manifest.json").exists() else []
        stale = [name for source, name in files if not (TARGET / name).exists() or (TARGET / name).read_bytes() != source.read_bytes()]
        if current != manifest or stale:
            print(f"schema bundle out of date: {', '.join(stale) or 'manifest'}; run scripts/tenancy/build_schema_bundle.py")
            return 1
        print(f"schema bundle up to date ({len(files)} files)")
        return 0
    TARGET.mkdir(parents=True, exist_ok=True)
    for old in TARGET.glob("*.sql"):
        if old.name not in manifest and old.name != "platform.sql":
            old.unlink()
    for source, name in files:
        shutil.copyfile(source, TARGET / name)
    (TARGET / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {len(files)} files to {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
