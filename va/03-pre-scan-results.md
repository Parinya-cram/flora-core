# Pre-scan results — dependencies (2026-10-22)

Internal pre-scan by ESM before the hospital VA. Raw output: [evidence/2026-10-22/](evidence/2026-10-22/).

## Method

| Layer | What was checked | Tool | Source of truth |
|---|---|---|---|
| Python (server) | Packages installed in the **release 1.2.9 images**: `canopy/api`, `canopy/haber`, `leaf/sync` (`pip freeze --all` inside the image) | OSV.dev API (`querybatch`) | what actually runs |
| Python (other) | Pinned `requirements.txt` of flora-root/api, flora-mcp, gateway-service, device-medical-service | OSV.dev API | repository |
| JavaScript | `frontend` (React web app), repo root (Electron desktop / Leaf) — production dependencies | `npm audit --omit=dev` | lock files |
| OS packages in images | **Not yet checked** — needs Trivy (see runbook §2.2) | — | — |

85 pinned Python packages checked. All images: Debian 13 (trixie), Python 3.13.15, **run as root (uid 0)**.
`leaf/api` uses the same flora-api code and requirements as `canopy/api`; scan it the same way.

## Summary

| Package | Version found | Where | Worst severity | Advisories | Fixed in |
|---|---|---|---|---|---|
| Pillow | 12.3.0 | canopy/api (and leaf/api) | **Critical** | 28 (heap overflows in JPEG/TIFF decoding, Ghostscript argument injection, many DoS) | 13.0.0 |
| certifi | 2026.7.22 | canopy/haber, leaf/sync | **Critical** | 1 (trusts emSign roots with compromised intermediates) | 2026.10.19 |
| cryptography | 46.0.2 | canopy/haber, flora-root/api | High | 7 (bundled OpenSSL, PKCS#7 Bleichenbacher, subgroup attack, …) | 50.0.0 |
| Starlette | 0.47.3 / 0.48.0 | canopy/api, canopy/haber | High | 6 (Range-header DoS, form limits ignored, Host-header poisoning, StaticFiles SSRF via UNC) | 1.3.1 (needs FastAPI upgrade) |
| vite | 7.3.6 | frontend (build tool) | High | 5 (dev-server cross-origin script execution, launch-editor command execution) | ≥ 7.3.7 |
| source-map-js | 1.2.1 | frontend (build tool) | High | 1 (DoS) | ≥ 1.2.2 |
| Electron desktop deps | — | repo root | none | 0 | — |
| Gateway, MCP pinned deps | — | requirements | none found | 0 | — |

Notes:
- Pillow, Starlette and certifi are **transitive** (not pinned in `services/flora-api/requirements.txt`):
  the image picks whatever version resolves at build time. Pin minimum safe versions explicitly.
- Starlette ≥ 1.0 needs a FastAPI release that supports it (FastAPI is pinned 0.116.1 in flora-api,
  0.118.0 in flora-root). Upgrade FastAPI and Starlette together and run the API test suites.
- vite / source-map-js are build-time only **if** production serves the built files from nginx
  (`Dockerfile.frontend.prod`). They are exploitable when the Vite **dev server** is reachable — in the
  current dev Canopy it is (port 7200). Make sure no hospital deployment runs the dev server.
- `services/flora-mcp/requirements.txt` has 2 unpinned packages; pin them so scans are reproducible.

## Re-running the Python check without installing anything

```python
# python3 osv_check.py va/evidence/<date>/pip-freeze-*.txt
import json, re, sys, urllib.request
pkgs = [(m[1], m[2]) for f in sys.argv[1:] for m in re.finditer(r"^([A-Za-z0-9_.\-]+)==(\S+)$", open(f).read(), re.M)]
q = {"queries": [{"package": {"name": n, "ecosystem": "PyPI"}, "version": v} for n, v in pkgs]}
res = json.load(urllib.request.urlopen(urllib.request.Request("https://api.osv.dev/v1/querybatch",
      json.dumps(q).encode(), {"Content-Type": "application/json"})))["results"]
for (n, v), r in zip(pkgs, res):
    for vuln in r.get("vulns", []):
        print(n, v, vuln["id"])
```
