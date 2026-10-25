# Scope and rules of engagement (template)

Fill this in with the hospital IT / security team and the VA vendor before scanning. Both sides sign.

| Item | Value |
|---|---|
| Hospital | _e.g. KCMH_ |
| System | FLORA iCIS — Canopy (hospital server), Leaf (bedside workstation), Gateway (device interface) |
| Release under test | _e.g. Canopy 1.2.10, Leaf 1.2.10, Gateway x.y_ |
| Environment | ☐ Staging (preferred) ☐ Production (read-only scan, off-peak only) |
| Scan type | ☐ Unauthenticated network VA ☐ Authenticated web VA ☐ Penetration test |
| Window | _date, start–end time (off-peak), time zone ICT_ |
| Vendor source IPs | _list_ |
| Vendor contact | _name, phone_ |
| Hospital IT contact | _name, phone_ |
| ESM / FLORA contact | _name, phone_ (on call during the window) |

## In scope

| Target | Address | Ports / URL |
|---|---|---|
| Canopy web + API (via edge) | _canopy host_ | 443 (HTTPS), 80 (redirect only) |
| Canopy sync API (Leaf → Canopy) | _canopy host_ | _sync port_ |
| Haber (image registry / relay) | _canopy host_ | _registry port_ |
| Leaf workstation(s) — 1 sample bed | _leaf ip_ | Leaf API port, OS services |
| Gateway — 1 sample | _gateway ip_ | Gateway service port |

Exact ports: see [02-asset-inventory.md](02-asset-inventory.md).

## Out of scope

- Medical devices behind gateways (monitors, ventilators, pumps) — **never scan them**; many devices
  fail or reboot under port scans. Exclude device VLAN ranges explicitly: _list_.
- Hospital HIS / LIS / PACS and the HL7 engine (separate owners).
- Root (ESM cloud) — covered by ESM's own assessment.
- Denial-of-service, load testing, social engineering, physical access.

## Rules

1. Use only the test hospital account `vatest` and test patients; no real patient data may be created,
   changed or exported. If real patient data is seen, stop and report it, do not copy it.
2. No destructive tests (data deletion, account lockout of real users, password spraying of real accounts).
3. Rate-limit scanning on Leaf and Gateway hosts (they are bedside systems).
4. Stop immediately if clinical use is affected and call the hospital IT contact.
5. Findings are confidential: report to hospital IT and ESM only.
6. Deliverables: raw scanner output + report with CVSS scores, evidence and affected host/URL per finding.

| | Name | Signature | Date |
|---|---|---|---|
| Hospital IT security | | | |
| VA vendor | | | |
| ESM (system vendor) | | | |
