# Competitor Feature & Company Matrix (initial, 2026-10-13)

Summary of the per-competitor files in this folder. Each cell is backed by sources in the linked file;
`?` = not found publicly, `(unverified)` = from search snippets / vendor claims only.

## 1. Companies (Thai seller)

| | Philips ICCA | Picis | Dräger Innovian | Mediplex / ปัญญ์สุข | Mind Medical Care ("Senemed"?) |
| --- | --- | --- | --- | --- | --- |
| Detail file | [philips-icca-xovic.md](philips-icca-xovic.md) | [picis-cis-imaging.md](picis-cis-imaging.md) | [drager-innovian.md](drager-innovian.md) | [mediplex-pansuk.md](mediplex-pansuk.md) | [senemed.md](senemed.md) |
| Product owner | Philips (NL) | N. Harris Computer / Constellation (CA) since 2015 | Dräger (DE) | — (sells Mindray-model devices, unverified) | own products |
| Thai seller | Xovic Co., Ltd. (บ. โซวิค) | CIS Imaging Co. (Pak Kret) | Draeger Medical (Thailand) Ltd. (subsidiary) | บ. เมดดิเพล็กซ์ (ไทยแลนด์) + บ. ปัญญ์สุข เมดิคัล | บ. มายด์ เมดิคอล แคร์ (Sriracha) |
| Seller type | Large device distributor, 30+ yr Philips partner | Small multi-brand IT/device reseller | Manufacturer subsidiary | Device distributor (anesthesia, OR equipment) | Small device distributor + own software |
| Size | ~1,246 gov contracts / 6.19 bn THB (2016 report) | 11–50 staff (unverified) | Global corp; local size ? | 11–50 staff, ~USD 5.4M (unverified); ปัญญ์สุข capital 20M THB | capital 5M THB |
| Public-sector reach | Very strong (MOPH, Army) | ? | ? (KCMH via Thai Red Cross) | North / Northeast sales (unverified) | ? |

## 2. Product capabilities

| Capability | FLORA | Philips ICCA | Picis | Dräger Innovian | Mediplex | Mind Medical |
| --- | --- | --- | --- | --- | --- | --- |
| Anesthesia record (AIMS) | ✅ | ✅ | ✅ | ✅ | ? (likely Mindray device apps) | ❌ |
| ICU charting | ✅ | ✅ (core strength) | ✅ | ✅ (maintenance mode? unverified) | ? | ❌ (IPD paperless ward only) |
| Pre-op / PACU / OR mgmt | ✅ forms | partial | ✅ full suite | ✅ | ? | ❌ |
| Device integration | Own vendor-neutral Gateway | Needs PIC iX / Capsule MDIP (+IntelliBridge) | 420–450+ drivers (vendor claim) | Dräger devices + 3rd party | Mindray eGateway / BeneLink (single-brand) | ❌ |
| HIS integration | HL7/FHIR + Thai HIS work | HL7 (ADT/lab/orders), FHIR | HL7 | Weak — KCMH sends PDF via file share | ? | ? |
| Clinical decision support | partial | ✅ bundles, drug interactions | ✅ | partial | ? | ? |
| Hospital self-authoring (forms/reports/workflow) | ✅ Studio + AI Studio | config by vendor/admin | config by vendor | config by vendor | ? | ? |
| Thai UI | ✅ | ❌ not found | ? not found | ❌ not found | ? | ✅ (local product) |
| Deployment | On-prem Canopy + offline Leaf + cloud Root | On-prem / hybrid | On-prem (?) | On-prem (.NET + MS SQL) | ? | ? |
| Product status | Active development | No EOL notice; Philips marketing now leads with Capsule (roadmap risk, inferred) | Active, new modules 2026 | Versions retired one by one (6.x EOL 2022; 7.0 divest) | — | — |
| Thai reference sites | KCMH (internal) | Chula, Rama, Rajavithi, Bangkok Hosp. (Philips claim, unconfirmed) | none found | KCMH (internal) | none found | none found |
| Tender price found | — | ❌ | ❌ | ❌ | ❌ | list prices 0.45–3.5M THB / module (unverified) |

## 3. Where we meet them

| | Tier 1 (large / university / MOPH regional) | Tier 2 (smaller / private) |
| --- | --- | --- |
| Philips ICCA | **Main threat** — bundled into Philips monitoring bids | Rare; Philips central station alone instead |
| Picis | Possible; strong brand, weak local proof | Unlikely (cost/scope) |
| Dräger Innovian | **Replacement opportunity** (aging installs, paid upgrades, archive import) | Unlikely; target Dräger device connectivity |
| Mediplex | Low (no public software refs) | **"Free with hardware"** bundle threat |
| Mind Medical | Unlikely | Possible on ward paperless / ER / LR packages |

## 4. TOR levers that favour FLORA

1. Vendor-neutral multi-brand device capture, no per-bed proprietary middleware.
2. Two-way HIS integration (HL7/FHIR) with named live Thai sites.
3. Full Thai UI and Thai forms out of the box.
4. Hospital self-authoring of forms, reports, workflows.
5. Live POC on the hospital's own HIS and installed monitors.
6. Standards-based full data export / no lock-in; legacy archive migration.
7. Named local support team with SLA.

## 5. Open items

- Confirm "Senemed" spelling/source (currently only Mind Medical Care found).
- Confirm "ปันสุข" = company (ปัญญ์สุข เมดิคัล) or a software brand.
- Manual e-GP (gprocurement.go.th) searches by vendor name / tax ID for all five.
- Re-check Dräger and Philips page claims in a browser (automated fetch blocked).
