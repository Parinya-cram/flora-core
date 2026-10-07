#!/usr/bin/env python3
"""Build the example form packages into formdev/packs/ (deterministic output).

    PYTHONPATH=services/flora-api python3 formdev/scripts/build_example_packs.py          # rewrite
    PYTHONPATH=services/flora-api python3 formdev/scripts/build_example_packs.py --check  # exit 1 if out of date

- patient-assessment.formpack     v1 + header asset + one seed record
- patient-assessment.v2.formpack  v2 upgrade (migration from v1), no seed
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app.formdev.formpack import pack, read_formpack  # noqa: E402
from app.formdev.styles import pack_registry, stored_font  # noqa: E402


def load(path: str):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def build() -> dict[str, bytes]:
    """Every example package, as export_formpack would build it: the form, its whole style chain and its fonts."""
    styles = {row["style_id"]: row for row in load("registry/styles.json")}
    fonts = {row["font_id"]: {"font_id": row["font_id"], "metadata": stored_font(row)} for row in load("registry/fonts.json")}
    example = ROOT / "examples/patient-assessment"
    assets = {path.name: path.read_bytes() for path in sorted((example / "assets").iterdir()) if path.is_file()}
    builds = {
        "patient-assessment.formpack": (load("examples/patient-assessment/v1.form.json"), load("examples/patient-assessment/seed.records.json")),
        "patient-assessment.v2.formpack": (load("examples/patient-assessment/v2.form.json"), None),
    }
    out: dict[str, bytes] = {}
    for name, (definition, seed) in builds.items():
        content = pack(definition, *pack_registry(definition, styles.__getitem__, fonts.__getitem__), assets, seed)
        read_formpack(content)  # verify before writing
        out[name] = content
    return out


def main() -> int:
    target = ROOT / "packs"
    stale = [name for name, content in build().items() if not (target / name).exists() or (target / name).read_bytes() != content]
    if "--check" in sys.argv:
        print("example packs " + ("out of date: " + ", ".join(stale) if stale else "up to date"))
        return 1 if stale else 0
    target.mkdir(exist_ok=True)
    for name, content in build().items():
        (target / name).write_bytes(content)
        print(f"{name}: {len(content)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
