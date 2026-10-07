#!/usr/bin/env python3
"""Intranet readiness check for a built frontend bundle (no Internet dependency).

    python3 formdev/scripts/check_intranet.py frontend/dist

Fails if the bundle loads anything from an external host at runtime: stylesheets,
fonts, scripts, images or API calls. XML namespace identifiers (which browsers never
fetch) and documentation links inside license comments are ignored.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

URL = re.compile(r"""(?:url\(\s*['"]?|src=['"]|href=['"]|fetch\(\s*['"]|@import\s+['"]|from\s+['"]|import\(\s*['"])(https?://[^'")\s]+)""", re.IGNORECASE)
LOCAL_HOSTS = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.local|[a-z0-9-]+\.test)(:\d+)?(/|$)", re.IGNORECASE)
CHECKED = {".html", ".js", ".css", ".mjs"}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "frontend/dist")
    if not root.is_dir():
        print(f"bundle folder not found: {root}", file=sys.stderr)
        return 2
    problems: list[str] = []
    fonts = 0
    for path in sorted(root.rglob("*")):
        if path.suffix in (".woff2", ".woff", ".ttf"):
            fonts += 1
        if path.suffix not in CHECKED:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in URL.finditer(text):
            if not LOCAL_HOSTS.match(match.group(1)):
                problems.append(f"{path.relative_to(root)}: loads {match.group(1)}")
    print(f"checked {root}: {fonts} bundled font files")
    for problem in problems:
        print("EXTERNAL " + problem)
    print("intranet ready: no runtime requests to external hosts" if not problems else f"{len(problems)} external runtime reference(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
