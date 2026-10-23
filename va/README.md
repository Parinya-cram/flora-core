# FLORA iCIS — Vulnerability Assessment (VA) preparation

Working folder for the hospital VA scan of FLORA iCIS (Canopy, Leaf, Gateway).
Status on 2026-10-22: **internal pre-scan done, not ready for the vendor scan yet** — 4 Critical and
7 High items to close first (see [05-remediation-plan.md](05-remediation-plan.md), band "Before VA").

| File | What it is | For |
|---|---|---|
| [01-scope-and-rules-of-engagement.md](01-scope-and-rules-of-engagement.md) | Scope / RoE template to agree and sign with hospital IT and the VA vendor | hospital, vendor |
| [02-asset-inventory.md](02-asset-inventory.md) | Hosts, services, ports, exposure, unauthenticated endpoints, data stores | vendor, ESM |
| [03-pre-scan-results.md](03-pre-scan-results.md) | Dependency scan of release 1.2.9 images and lock files | ESM |
| [04-findings.md](04-findings.md) | Findings register (F = configuration/code, D = dependency) with evidence and fixes | ESM |
| [05-remediation-plan.md](05-remediation-plan.md) | What to fix before the VA, before go-live, and backlog; closure rules | ESM, hospital |
| [06-scan-runbook.md](06-scan-runbook.md) | How to re-run the pre-scan, support the vendor on the day, and close findings | ESM |
| [evidence/](evidence/) | Raw tool output, one folder per date (later: vendor report) | audit trail |

## Findings at a glance

| Severity | Count | IDs |
|---|---|---|
| Critical | 4 | F1 default secrets, F2 sync-secret takeover, D1 Pillow, D2 certifi |
| High | 7 | F3 gateway data-api, F4 device listeners, F5 registry, F6 docker.sock, D3 cryptography, D4 Starlette, D5 Vite dev server |
| Medium | 8 | F7–F14 |
| Low / Info | 6 | F15–F20 |

## Not covered yet

- OS packages inside the images (needs Trivy — runbook §2.2).
- Live scans (nmap, testssl, ZAP) — need the release with fixes running in a staging environment.
- Medical devices are **out of scope** and must never be scanned.

Confidential — contains security weaknesses of a clinical system. Share with hospital IT security and
the contracted VA vendor only.
