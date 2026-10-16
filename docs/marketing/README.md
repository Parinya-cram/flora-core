# FLORA iCIS marketing

Marketing material for FLORA iCIS (E.S.M. Solution Co., Ltd.), started 2026-10-16. The customer-facing names follow `~/Downloads/FLORA iCIS Catalog.pdf`. The device gateway is **Flora Tendril**, and the catalog's three pillars are Integration as a Service, Customization and The Agent.

| Item | Path | Notes |
| --- | --- | --- |
| Brand logos | `brand/` | Horizontal, stacked and mark-only PNG (transparent) |
| Website prototype (6 pages, TH/EN) | `website/` | Pages: Home, Platform, OR/ICU, Devices, Security, Contact. Published as a private artifact: https://claude.ai/artifact/NQRk3B57e96i7YU4EC9PEF |
| Homepage design drafts A/B/C | `website/drafts.html` | The user chose A (Clinical Calm) |
| One-pager (A4, TH + EN) | `onepager/onepager.pdf` | Rebuild: `python3 onepager/build_onepager.py`, then print with Chrome headless (below) |
| Promo video (42 s, 1920×1080, silent) | `video/flora-icis-promo.mp4` | HyperFrames source: `video/index.html` |
| Marketing plan 2027 | Claude Doc | https://claude.ai/code/artifact/66594db8-83d5-4417-847f-1fddd483f995 |

`website/devices.json` is exported from `flora-root/api/app/reference/device_types.json`. It keeps only rows with status `driver_in_code` (shown as "Driver") or `to_validate` (shown as "Candidate"). Re-export it whenever the catalog changes.

## Rules for claims

- No headline device counts ("150+ devices"). Show evidence levels per `docs/DEVICE-COMPATIBILITY-CATALOG.md`.
- No regulatory or certification claims (Thai FDA, FDA, CE, ISO 13485).
- Do not name customer hospitals until they give written permission.
- ICU form packs are labelled "in validation" until they ship in a Leaf release.

## Rebuild

```bash
python3 docs/marketing/onepager/build_onepager.py
```

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf=docs/marketing/onepager/onepager.pdf "file://$PWD/docs/marketing/onepager/onepager.html"
```

```bash
cd docs/marketing/video && npx hyperframes check && npx hyperframes render --output flora-icis-promo.mp4
```
