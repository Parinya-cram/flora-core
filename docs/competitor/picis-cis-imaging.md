# Competitor: Picis (via CIS Imaging, Thailand)

> Research date: 2026-10-13. Desk research only (public web). Every factual claim has a source tag `[Sn]`
> that maps to the **Sources** section. Items marked **UNVERIFIED** could not be confirmed from a
> public source and must not go into customer-facing material until confirmed.

## TL;DR

- **Owner correction:** Picis is **not** Optum/UnitedHealth any more. UnitedHealth's Ingenix (later
  OptumInsight) bought Picis in 2010 [S5][S6]. **N. Harris Computer Corp. (part of Constellation Software)
  bought it in 2015** [S3][S4]. Picis.com still describes itself as a wholly owned subsidiary of
  N. Harris Computer Corporation, Massachusetts HQ, with licensed solutions in 400+ hospitals worldwide [S1].
  (`docs/competitor/README.md` still lists "Optum" and should be fixed.)
- **Thai channel:** the Thai seller is **CIS Imaging Company** (Pak Kret, Nonthaburi). It is small
  (ZoomInfo says 11-50 staff [S10]), and its products page lists PICIS alongside Corsano, MEDcury, CHILINE and Fusion [S7][S8].
- **No public Thai reference sites found.** Neither CIS Imaging nor Picis names a Thai hospital, and
  searches of Thai government/university domains and news turned up nothing. Picis's FDA distribution
  lists name Malaysia and Singapore but not Thailand [S13].
- **No Thai tender prices found** for Picis (searches for "PICIS" on `.go.th` only matched the drug
  standard **PIC/S**, not this software).
- **Positioning:** Picis is a mature, US-built AIMS/ICU suite with deep device drivers (420-450+) and a
  full perioperative suite. Its weak points in Thailand are a small local partner, no visible Thai
  installs, an English-first product, a holding-company owner focused on keeping existing customers,
  and a US-centric workflow. FLORA should compete on local support, Thai UI and forms, HIS
  integration, self-authoring (Studio), and total cost.

## 1. CIS Imaging — company profile

| Item | Finding | Source |
| --- | --- | --- |
| Trading name | **CIS Imaging Company** (website/Facebook); Corsano lists it as **"CIS Imaging Co. Ltd."** | [S7][S9][S11] |
| Thai registered name | **UNVERIFIED.** Search did not return a DBD record. Likely "บริษัท ซีไอเอส อิมเมจจิ้ง จำกัด", but this needs a check in DBD DataWarehouse+. Note that **บริษัท ซีไอเอส (ประเทศไทย) จำกัด (CIS (Thailand) Co., Ltd., 0105561074759)** and **ซี.เอส.ไอ. (ประเทศไทย)** are **different, unrelated-looking** companies that come up in searches. Do not confuse them. | [S12] |
| Address | AIAT, 47/405, Pak Kret, Nonthaburi 11120 (website). The Facebook page shows a Bangkok address (Sukhapiban Bangramad 3). | [S7][S9] |
| Contact | 097-959-9224, info@cis-imaging.com | [S7] |
| Size | 11-50 employees (ZoomInfo estimate; treat as indicative) | [S10] |
| People | ZoomInfo lists Khomsan Pratnakhonkhet (cis-imaging.com email). The website mentions an unnamed co-founder with "30+ years in medical devices and medical software". | [S7][S14] |
| Positioning | "Modern medical technology" to give clinicians efficient access to patient information. Sells to both government and private sectors. | [S7] |
| Product lines | **PICIS** (perioperative/ICU CIS); **Corsano** (wearable vital-sign bracelet; CIS Imaging is Corsano's listed Thai distributor [S11]); **MEDcury** (Thai HIS/paperless vendor [S15]); **CHILINE**, **Fusion** (no detail on site). ZoomInfo also lists **GE VNA** (vendor-neutral archive, imaging). That explains the "Imaging" name, but it is **UNVERIFIED** from GE or CIS directly. | [S7][S8][S10][S11] |
| PACS? | No evidence of selling a PACS of its own. The "imaging" link is only the GE VNA mention (UNVERIFIED). | [S10] |

**Read-out:** CIS Imaging looks like a **small multi-brand importer/integrator**, not a dedicated
Picis subsidiary. That matters in bids. A large tier-1 Picis go-live (device drivers, HIS HL7, Thai
forms, 24/7 support) would rely on a thin local team and on remote Picis staff (US/Spain).
Picis says it implements and supports directly without third parties [S17]. We could not confirm
how that works in Thailand.

## 2. Picis — product and corporate status

### Ownership timeline
- 1994: founded (per PitchBook/aggregator profile) [S6]. Barcelona/Spain origins are suggested by staff bios [S1]. Exact origin is **UNVERIFIED**.
- 2010: acquired by **Ingenix** (UnitedHealth Group, later rebranded OptumInsight) [S5][S6]. An older brochure calls Picis "a part of OptumInsight" [S16].
- 2015: **N. Harris Computer Corporation** (wholly owned by Constellation Software) agreed in May and closed in June to acquire the Picis clinical applications [S3][S4].
- 2026: picis.com (©2026) still says "wholly owned subsidiary of N. Harris Computer Corporation" [S1][S2].
- No 2025-2026 sale, merger or end-of-life notice found in public news.

### Product suite (vendor-stated)
| Module | What it does | Source |
| --- | --- | --- |
| Anesthesia Manager | Anesthesia record from pre-op assessment through intra-op charting to post-op. Automatic device capture from **420+ / 450+ device drivers** (the site gives both figures): anesthesia machines, ventilators, pumps, monitors. Configurable templates and printouts. | [S2][S17] |
| Critical Care Manager | ICU CIS for adult, paediatric and neonatal units. Device, medication, lab and order data. Protocol-based flags/alerts. Shares data with the HIS. | [S8][S18] |
| OR Manager | Scheduling, intra-op documentation, supply chain, revenue, quality reporting | [S8] |
| PACU Manager, Preop Manager | Recovery documentation; pre-admission risk assessment and checklists | [S8] |
| Envision Analytics | Reporting built on **Microsoft Power BI** | [S8] |
| Others | SmarTrack Next (patient tracking), Device Hub, SmartRequest, PicisPrima, PriorityQ, RapidICU, Orchestrator, Experior ASC; a "Government suite" | [S2] |
| Services | HealthCheck, PASS (annual supplemental services), Picis Assist, professional services, training | [S2] |

Deployment model (on-prem vs cloud/SaaS) is **not stated** on the public site [S2][S17]. Software UI
language support is **not stated**. The website is in English, Spanish and French, with no Thai.
The CIS Imaging PICIS page is English apart from navigation [S8].

### End-of-life / roadmap risk (analysis, not sourced fact)
- Constellation/Harris usually **buys mature vertical software and runs it for maintenance revenue**.
  That points to a stable product with slower innovation, not a near-term EOL. The website still lists
  new-sounding modules (PicisPrima, Orchestrator, PriorityQ), so the product line is alive [S2].
- Asia is not mentioned anywhere on picis.com [S1]. Thailand is not on the FDA distribution lists
  (Malaysia and Singapore are) [S13]. Thailand is therefore a **peripheral market** for Picis, and
  roadmap items (Thai language, Thai MOPH reports, Thai HIS interfaces) would have to come from the
  local partner.
- **Ask in bids:** Thai FDA (อย.) registration status as medical-device software, Thai UI
  localisation, local driver development capability, and source of 24/7 support. All **UNVERIFIED**.

## 3. Thai reference sites

**None found and verified.** Searched English and Thai (`Picis โรงพยาบาล`, `ระบบ Picis ห้องผ่าตัด`,
`ระบบบันทึกข้อมูลวิสัญญีอิเล็กทรอนิกส์ PICIS`, `PICIS site:go.th / ac.th / or.th`, Bangkok/teaching
hospital names). Results:
- The CIS Imaging site names no customers [S7][S8].
- The Picis site names only US/UK/Canada sites (e.g. Frimley Health, University of Ottawa Heart Institute, Southern New Hampshire Medical Center, Torbay Hospital) [S1][S17].
- The `.go.th` hits for "PICIS" are **PIC/S (Pharmaceutical Inspection Co-operation Scheme)** drug
  specs, e.g. Lampang hospital's drug price-performance criteria. They are **false positives** [S19].

Recommended next step: field intel (anaesthesiologists at RCAT meetings, the hospital IT network),
an e-GP search inside the gprocurement.go.th portal (not indexable by web search) for
`วิสัญญี`, `Anesthesia Information`, `ระบบสารสนเทศห้องผ่าตัด`, `ICU information` with vendor "ซีไอเอส".

## 4. Pricing / tender values

**Not found.** No public Thai TOR, ราคากลาง or award listing mentions Picis or CIS Imaging. Do not
quote a number. If an e-GP award appears, record: hospital, project title, ราคากลาง, award value,
date, modules, bed/OR count.

## 5. Strengths, weaknesses, and FLORA positioning

### Picis strengths
- 25+ years in AIMS/ICU. 400+ hospitals worldwide. KLAS-referenced brand that is credible with
  US/UK-trained anaesthesiologists [S1][S17].
- **Large device-driver library (420-450+)**, the main technical moat versus new entrants [S2][S17].
- Full perioperative continuum in one vendor: Preop, OR scheduling, Anesthesia, PACU, ICU, plus analytics [S8][S2].
- Power BI-based analytics is familiar to hospital IT [S8].

### Picis weaknesses (in Thailand)
- **No visible Thai install base**, so it is hard for a buyer to do a site visit.
- **Small local partner** (11-50 staff, multi-brand), which makes implementation and 24/7 support risky for tier-1 [S10].
- English-first. No evidence of a Thai UI, Thai forms, or Thai MOPH/สปสช. reporting.
- US-centric workflow (revenue cycle and billing features are aimed at US payers) [S8][S2].
- Customisation depends on the vendor. Hospitals cannot easily author their own forms or reports.
- The owner (Constellation/Harris) optimises for maintenance revenue, so expect slow feature
  delivery for a non-core market (analysis).
- Licence and USD-denominated maintenance are likely expensive (**UNVERIFIED**, no price data).

### How FLORA should position

**Tier 1 (university / MOPH regional / large private):**
- Picis is credible on paper (brand, driver count, modules). Attack **delivery risk and fit**:
  - Ask for **Thai reference sites with site visits** and a **Thai-language UI demo**. We expect Picis to have neither.
  - Ask for a **named local support team, SLA and escalation path in Thailand**.
  - Put **HIS integration with the Thai HIS (HOSxP/in-house/SSB etc.) as a live PoC** in the TOR.
  - Show FLORA **Gateway's vendor-neutral device coverage of the models actually in that hospital**
    (Mindray, Nihon Kohden, Philips, GE, Dräger). Match on the installed base, not on a 450-driver
    headline. Use the device type catalog from the hospital's monitor list.
  - **Studio (Form/Report/Workflow/AI)**: the hospital owns its forms, reports and workflows without
    vendor change requests. Picis has no equivalent self-authoring story in public material.
  - **Data sovereignty**: Canopy on-prem, with Root used only for releases and updates.
- TOR-writing hooks: Thai UI, Thai MOPH report outputs, local support SLA, PoC with the hospital's
  own devices, data export/handover (full raw export).

**Tier 2 (smaller public / private):**
- Picis is likely over-priced and over-scoped here. Position FLORA as **right-sized and
  quick to deploy**: Leaf bedside + Gateway, Canopy as an appliance, Thai forms ready to use, and
  local-currency pricing.
- Picis's US revenue-cycle and OR supply-chain depth is not a deciding factor at this tier.

### Watch-outs
- Do **not** claim Picis is EOL. It is still marketed in 2026 [S2].
- CIS Imaging also sells **Corsano** wearables [S11] and has a stated link to **MEDcury** (Thai HIS) [S7].
  A bundled "HIS + perioperative + wearables" offer from this channel is possible (analysis).
- Correct the README entry: owner is **N. Harris Computer / Constellation Software**, not Optum.

## Sources

- [S1] Picis — About: https://www.picis.com/about/
- [S2] Picis — Home / product list: https://www.picis.com/
- [S3] Constellation Software — "Harris division completes the acquisition of Picis" (2015): https://www.csisoftware.com/constellation-software-s-harris-division-completes-the-acquisition-of-picis/
- [S4] Constellation/Harris press release PDF (agreement, 2015): https://www.csisoftware.com/docs/default-source/press-releases/picis_harris-press-release-final.pdf
- [S5] BioWorld — "Ingenix to buy health info solution provider Picis" (2010): https://www.bioworld.com/articles/417088-deals-roundup-ingenix-to-buy-health-info-solution-provider-picis
- [S6] PitchBook — Picis Clinical Solutions profile: https://pitchbook.com/profiles/company/10426-33
- [S7] CIS Imaging Company — Home: https://cis-imaging.com/
- [S8] CIS Imaging — PICIS Patient Clinical Information System: https://cis-imaging.com/picis
- [S9] CIS Imaging Company — Facebook: https://www.facebook.com/CISImaging
- [S10] ZoomInfo — CIS Imaging overview: https://www.zoominfo.com/c/cis-imaging-co/1339031259
- [S11] Corsano Health — Find a distributor: https://corsano.com/distributor/
- [S12] Creden — CIS (Thailand) Co., Ltd. 0105561074759 (different company): https://data.creden.co/company/general/0105561074759
- [S13] ICIJ Medical Devices DB (FDA-derived) — Picis CareSuite distribution: https://es.medicaldevices.icij.org/devices/usa-general-hospital-and-personal-use-devices-caresuite-critical-care-manager-pacu-manager-and-anesthesia-manager
- [S14] ZoomInfo — Khomsan Pratnakhonkhet: https://www.zoominfo.com/p/Khomsan-Pratnakhonkhet/-1509909085
- [S15] MEDcury: https://www.medcury.health/en
- [S16] Picis Anesthesia Manager product sheet (OptumInsight era): https://www.anesthesiallc.com/images/brochures/product_sheet_anesthesia_manager.pdf
- [S17] Picis — Anesthesia Manager: https://www.picis.com/solution/anesthesia-manager/
- [S18] Picis — Critical Care Manager: https://www.picis.com/solution/clinical-information-system-suite/critical-care-manager/
- [S19] Lampang hospital drug price-performance criteria (PIC/S false positive): https://www.lpch.go.th/lpch/uploads/20221003145102321348.pdf
- Context: i2medi (Berlin) — another Picis reseller (EU/LatAm): https://www.i2medi.com/en/picis-anesthesia-manager.html
