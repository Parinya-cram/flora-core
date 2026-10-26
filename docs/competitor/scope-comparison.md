# System Scope Comparison (สรุปเปรียบเทียบขอบเขตระบบ) — updated 2026-10-26

> **2026-10-26:** FLORA re-assessed after gateway EKG/waveform, live streaming, ICU rounds, scoring engine and OR schedule work (B1, B2 → ✅; C4 → ◐). These features are on `main` but **not yet in a signed release** (pins leaf-1.2.9 / gateway-0.2.4).

Built from the per-system checklists in [scope/](scope/) (same 48 items, A1–H3). Each cell links back to cited evidence in the system's file.
Legend: ✅ supported · ◐ partial / add-on / extra product needed · ❌ not offered · ? not found publicly.
FLORA is a self-assessment from the repo ([scope/flora.md](scope/flora.md)); competitor cells are from public sources (vendor marketing, datasheets, FDA, KLAS) and are **not verified in a demo**.

## 1. สรุปภาพรวม (Executive summary)

| | FLORA | Philips ICCA | Picis | Dräger Innovian | Mediplex / Mindray | Mind Medical |
|---|---|---|---|---|---|---|
| ระบบหลัก | Anesthesia + ICU + Studio | ICU-first CIS + anesthesia | Full periop suite + ICU | Anesthesia-first AIMS (+ ICU legacy) | Device connectivity / central monitoring (no AIMS outside China) | IPD paperless, ER/LR/EMS telemedicine |
| เด่นที่สุด | Hospital self-authoring, Thai, offline, AI, live streaming + OR schedule | ICU depth, scoring, FDA, references | Device Hub 420–450+ drivers, OR management | Dräger/GE device data, offline thick client | Waveform, alarms, Mindray devices | Low price, Thai local |
| อ่อนที่สุด | Device breadth (3 brands; waveform M540 only), ICU content unpublished, no CPOE, no certification | Needs PIC iX/Capsule/IntelliBridge, no OR mgmt, no Thai | ICU thin, no ward, vendor-configured, no Thai | Legacy Windows stack, ICU dormant, no Thai | No clinical charting | No anesthesia/OR/ICU |
| Tier ที่เจอ | 1 & 2 | **1 (main threat)** | 1 | 1 (replacement target) | **2 (hardware bundle)** | 2 (rare) |

## 2. ตารางเปรียบเทียบขอบเขต (Scope matrix)

| Count | FLORA | Philips ICCA | Picis | Dräger Innovian | Mediplex / Mindray | Mind Medical |
|---|---|---|---|---|---|---|
| ✅ | 23 | 20 | 24 | 15 | 8 | 3 |
| ◐ | 22 | 20 | 10 | 25 | 20 | 14 |
| ❌ | 2 | 3 | 2 | 0 | 0 | 9 |
| ? | 1 | 5 | 12 | 8 | 20 | 22 |

### A. Clinical workflow

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| A1 | Pre-anesthesia assessment | ✅ | ✅ | ✅ | ✅ | ? | ❌ |
| A2 | Consent / pre-op checklist | ✅ | ◐ | ✅ | ◐ | ? | ? |
| A3 | WHO surgical safety checklist | ◐ | ? | ? | ? | ? | ❌ |
| A4 | Intra-op auto vitals capture | ✅ | ◐ | ✅ | ✅ | ◐ | ❌ |
| A5 | Drugs, fluids, blood, gases, events, airway | ✅ | ✅ | ✅ | ✅ | ◐ | ❌ |
| A6 | Anesthesia machine / ventilator capture | ✅ | ◐ | ✅ | ✅ | ◐ | ❌ |
| A7 | PACU / recovery | ✅ | ◐ | ✅ | ✅ | ? | ❌ |
| A8 | Post-op visit / pain service | ◐ | ? | ◐ | ◐ | ◐ | ❌ |
| A9 | ICU flowsheet | ✅ | ✅ | ✅ | ✅ | ◐ | ? |
| A10 | ICU nursing assessment / care plan | ◐ | ✅ | ◐ | ◐ | ? | ◐ |
| A11 | Orders / MAR / infusion | ◐ | ✅ | ◐ | ◐ | ◐ | ◐ |
| A12 | Fluid balance (I/O) | ✅ | ✅ | ✅ | ✅ | ◐ | ? |
| A13 | ICU scoring | ◐ | ✅ | ? | ◐ | ◐ | ? |
| A14 | Physician / progress notes | ◐ | ✅ | ✅ | ? | ? | ? |
| A15 | Lab / imaging results | ◐ | ✅ | ◐ | ◐ | ? | ◐ |
| A16 | Handover / transfer summary | ◐ | ◐ | ✅ | ◐ | ◐ | ◐ |
| A17 | General ward / IPD | ◐ | ◐ | ❌ | ? | ◐ | ✅ |
| A18 | ER / labour room | ❌ | ◐ | ◐ | ◐ | ? | ✅ |

### B. OR management

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| B1 | OR scheduling | ✅ | ❌ | ✅ | ◐ | ? | ❌ |
| B2 | OR status board | ✅ | ❌ | ✅ | ◐ | ◐ | ❌ |
| B3 | Staff / resources | ◐ | ? | ✅ | ? | ? | ? |
| B4 | Supplies / charge capture | ✅ | ◐ | ✅ | ◐ | ? | ? |

### C. Device integration

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| C1 | Own gateway | ✅ | ◐ | ✅ | ✅ | ✅ | ◐ |
| C2 | Multi-brand | ◐ | ◐ | ✅ | ◐ | ◐ | ? |
| C3 | Monitors / machines / vents / pumps | ◐ | ◐ | ✅ | ◐ | ✅ | ◐ |
| C4 | Waveform | ◐ | ◐ | ◐ | ◐ | ✅ | ◐ |
| C5 | Alarm / surveillance | ◐ | ◐ | ❌ | ◐ | ✅ | ? |

### D. HIS / interoperability

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| D1 | HL7 v2 | ◐ | ✅ | ✅ | ✅ | ✅ | ? |
| D2 | FHIR | ◐ | ◐ | ? | ◐ | ? | ? |
| D3 | PDF to HIS | ◐ | ✅ | ? | ◐ | ✅ | ? |
| D4 | Thai HIS | ✅ | ? | ? | ◐ | ? | ? |

### E. CDS & analytics

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| E1 | Alerts / bundles | ◐ | ✅ | ✅ | ◐ | ◐ | ? |
| E2 | Drug interaction / dosing | ❌ | ◐ | ? | ? | ◐ | ? |
| E3 | Dashboards / QI / reports | ✅ | ✅ | ✅ | ✅ | ? | ? |
| E4 | Research / export | ✅ | ✅ | ◐ | ✅ | ? | ? |
| E5 | AI | ✅ | ❌ | ◐ | ? | ◐ | ◐ |

### F. Configurability

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| F1 | Form builder | ✅ | ✅ | ✅ | ◐ | ? | ? |
| F2 | Report builder | ✅ | ✅ | ◐ | ◐ | ? | ◐ |
| F3 | Workflow / rules | ✅ | ✅ | ✅ | ? | ? | ? |

### G. Technical

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| G1 | Architecture | ✅ | ✅ | ? | ✅ | ◐ | ◐ |
| G2 | Deployment | ✅ | ◐ | ? | ✅ | ◐ | ? |
| G3 | Offline at bedside | ✅ | ◐ | ? | ✅ | ◐ | ◐ |
| G4 | Mobile / web | ◐ | ◐ | ✅ | ◐ | ✅ | ◐ |
| G5 | Thai UI | ✅ | ? | ? | ? | ? | ? |
| G6 | Security / certifications | ◐ | ✅ | ◐ | ◐ | ✅ | ? |

### H. Commercial

| # | Item | [FLORA](scope/flora.md) | [Philips ICCA](scope/philips-icca.md) | [Picis](scope/picis.md) | [Dräger Innovian](scope/drager-innovian.md) | [Mediplex / Mindray](scope/mediplex-mindray.md) | [Mind Medical](scope/mindmedical.md) |
|---|---|---|---|---|---|---|---|
| H1 | Licensing | ◐ | ◐ | ? | ◐ | ◐ | ◐ |
| H2 | Project components | ◐ | ✅ | ✅ | ✅ | ◐ | ◐ |
| H3 | Price points | ? | ◐ | ? | ◐ | ? | ✅ |

## 3. ข้อสรุปเปรียบเทียบรายหมวด

**A. Clinical workflow** — FLORA's anesthesia record (A1–A7) matches Picis/Innovian and beats ICCA on PACU and checklist content. FLORA's ICU infrastructure is now strong (scheduled rounds/bundles with worklists, auto NEWS2/MEWS/qSOFA/GCS, long-stay flowsheet, multi-bed Leaf, transfer without discharge) but ICU forms are not yet published and APACHE II/MAR are missing; ICCA still leads ICU depth (care plan, MAR/orders, APACHE/SAPS). Nobody publicly documents a true WHO sign-in/time-out/sign-out (A3) — an easy TOR differentiator for FLORA if we add the 3-phase format.

**B. OR management** — Picis is the fullest OR suite (scheduling, board, staff, implants). FLORA now has an OR schedule (room × time booking), OR status/journey and Digital Twin, plus charge capture — close to Picis except staff rostering and implants. ICCA has none.

**C. Device integration** — Picis (Device Hub) and Mindray (eGateway, waveform, alarms) are strongest. ICCA and Innovian need separately licensed Philips/Dräger gateways. FLORA has its own gateway in the price and now live 1-s streaming with **EKG waveform from Dräger M540** (Leaf display, not diagnostic, rate unverified), but still only 3 driver brands, 0 formally validated, no Philips/Mindray, no clinical alarms — **still the biggest technical gap for tier 1**.

**D. HIS / interoperability** — Competitors have mature HL7 v2 in/out. FLORA has inbound only and FHIR is demo; but FLORA is the only one with proven Thai HIS work (KCMH, EPHIS). Nobody shows production FHIR detail.

**E. CDS & analytics** — ICCA and Picis have rule-based bundles/alerts; drug-interaction checks generally need third-party drug knowledge licences. FLORA leads on AI (AI Studio, offline Thai STT, dictation) — no competitor has comparable AI.

**F. Configurability** — FLORA (Form/Workflow/Report Studio, hospital-run) and ICCA (graphical form editor, Philips-trained analysts) are strongest. Picis and Innovian configuration is vendor-led.

**G. Technical** — FLORA is the only modern web/containers stack with offline-first Leaf and **Thai UI** (no competitor Thai UI found). ICCA/Innovian are Windows/SQL Server on-prem. Competitors hold FDA 510(k); **FLORA has no regulatory certification** — check every TOR for อย./ISO 13485/IEC 62304 requirements.

**H. Commercial** — Prices are almost entirely unknown in Thailand. ICCA licences per bed (+IntelliBridge per bed); Mind Medical lists ฿0.45–3.5M per package.

## 4. สิ่งที่ FLORA ควรทำ / ใช้ในการประมูล

Close before tier-1 bids:
1. Device drivers for **Philips and Mindray monitors** + a formally validated device list (C2/C3); verify M540 waveform on real captures and extend waveform to GE.
2. Publish ICU workflow content v2 (A10/A14/E1) and ship the ICU + live-stream code in a signed release (leaf > 1.2.9, gateway > 0.2.4).
3. Outbound HL7 (ORU/MDM PDF to HIS) and a basic FHIR API (D1–D3).
4. Regulatory path (Thai FDA medical-device software classification, ISO 13485 / IEC 62304 plan).

TOR levers where FLORA already wins:
- Thai UI + Thai forms; proven Thai HIS integration with named site.
- Gateway included (no per-bed middleware licences from a monitor vendor).
- Hospital self-authoring of forms, workflows, reports.
- Offline bedside operation; on-prem data sovereignty with full export; legacy (Innovian) archive import.
- AI/STT features, WHO 3-phase checklist (once added).

## 5. Caveats
- Competitor evidence is mostly vendor marketing; several sources are old (Innovian 2006–2012, ICCA brochure 2008) or snippet-only (draeger.com blocked). Confirm in demos or TOR responses.
- "Senemed" is still unidentified (candidates: Mind Medical Care, SaintMed/SMD Rise — unverified). "ปันสุข" is probably the company ปัญญ์สุข เมดิคัล, not software.
