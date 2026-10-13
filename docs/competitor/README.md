# Flora Competitor Landscape

Working folder for competitive analysis of FLORA (perioperative / ICU clinical information system:
Root / Canopy / Leaf / Gateway). One file per competitor, plus comparison notes.

> Bid competitors researched: see [scope-comparison.md](scope-comparison.md) (48-item scope matrix) and [feature-matrix.md](feature-matrix.md) — Philips ICCA (Xovic), Picis (CIS Imaging), Dräger Innovian, Mediplex/ปัญญ์สุข, Mind Medical Care ("Senemed"?).
>
> Status of the tables below: seed list from general market knowledge — verify pricing, local (TH) presence and
> current product status before using in customer-facing material.

## Anesthesia / ICU information systems (AIMS / CIS)

| Vendor | Product | Segment | Notes to verify |
| --- | --- | --- | --- |
| Dräger | Innovian | AIMS + ICU | Incumbent at KCMH — see `drager-innovian.md` |
| Philips | IntelliSpace Critical Care & Anesthesia (ICCA) / Capsule | AIMS + ICU + device integration | TH: Xovic — see `philips-icca-xovic.md` |
| GE HealthCare | Centricity Anesthesia / Carestation Insights | AIMS + OR analytics | Tied to GE monitors / anesthesia machines |
| iMDsoft | MetaVision (Anesthesia, ICU) | AIMS + ICU | Highly configurable, strong in ICU |
| N. Harris Computer (Constellation Software; ex-Optum until 2015) | Picis Anesthesia Manager / Critical Care Manager | AIMS + ICU | TH: CIS Imaging — see `picis-cis-imaging.md` |
| Epic | Anesthesia / ClinDoc (ICU) | EHR-embedded | Only where Epic is the HIS |
| Oracle Health (Cerner) | SurgiNet / Anesthesia (SAA) | EHR-embedded | Only where Cerner is the HIS |
| Mindray | BeneVision CMS / eGateway | Vendor-locked central station | Common in TH hospitals; monitor-centric |
| Nihon Kohden | Prime Vital / central stations | Vendor-locked central station | Monitor-centric |

## Device integration / data platforms

| Vendor | Product | Overlap with FLORA |
| --- | --- | --- |
| Philips | Capsule MDIP | Gateway tier |
| Medical Informatics Corp | Sickbay | High-res waveform capture + analytics (Canopy) |
| Masimo | Iris / UniView | Device connectivity hub |
| Etiometry | T3 | ICU risk analytics |
| Bernoulli | Bernoulli One | Device data + alarms |

## Thai market (local)

- Local HIS vendors with OR/ICU modules (e.g. HOSxP ecosystem, hospital in-house HIS) — TODO: list.
- Local integrators reselling Philips / GE / Mindray central stations — TODO: list.

## FLORA differentiators to test against each competitor

- Vendor-neutral device gateway (multi-brand monitors / anesthesia machines / pumps).
- Offline-capable bedside Leaf with sync to Canopy.
- Form / Report / Workflow / AI Studio — hospital-side authoring without vendor change requests.
- Thai-language UI and local HIS integration.
- Cost and deployment model (on-prem Canopy, Root-signed releases).

## Suggested files

- `innovian.md`, `philips-icca.md`, `metavision.md`, `ge-centricity.md`, `mindray.md`, ...
- `feature-matrix.md` — side-by-side capability comparison.
- `battlecard.md` — one-page objection handling for sales.
