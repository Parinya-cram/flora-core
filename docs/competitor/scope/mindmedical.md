# System scope: iChart IPD Paperless / AmbuLink / HeartStream / Virtual ER / Virtual LR (Mind Medical Care Co., Ltd., provisional match for "Senemed")

Legend per item: ✅ supported (cite) · ◐ partial / add-on / needs extra product (say which) · ❌ not offered · ? not found publicly. Cite a source [n] on every ✅/◐/❌.

> Research date: 2026-10-13. Desk research only. Companion to `../senemed.md` [1].
>
> **Identity status.** "Senemed" is still **not found** as a Thai hospital-software brand. A re-search of EN/TH spellings,
> LinkedIn, Facebook, app stores and company registries found nothing. `senemed.com` is a GoDaddy for-sale parking page [14].
> One **new phonetic candidate** turned up: **SaintMed (บริษัท เซนต์เมด จำกัด (มหาชน))**, renamed **SMD Rise PCL (SET: SMD100)** in 2025.
> It is a Nonthaburi medical-device distributor with a "Smart Hospital Medical Devices" product group, but no named
> clinical software was found [11][12][13]. "Sen-med" is plausible as a spoken form of "SaintMed". **UNVERIFIED.** Ask the source.
>
> This sheet rates **Mind Medical Care Co., Ltd. (บริษัท มายด์ เมดิคอล แคร์ จำกัด)**, Sriracha, Chonburi, reg. 0205554015946 [9][10],
> on its published software catalog [3].
>
> **Provenance finding (new).** At least part of the catalog appears to be built by **10bit Development Co., Ltd.
> (บริษัท 10บิตเดเวลอปเมนต์ จำกัด, Bang Phli, Samut Prakan)**:
> - 10bit's site lists **HeartStream** as its own web-based DICOM PACS [7].
> - An "iChart" IPD-paperless login page at `ichart.smpkhos.go.th` credits "10Bitdevelopment" (2021) [8].
>
> So Mind Medical Care is probably a **reseller/partner** of 10bit products. That hospital domain is a *possible* iChart site, but no
> source links it to Mind Medical Care. **UNVERIFIED.**
>
> Note: the HeartStream URL on Mind Medical Care's old site actually describes AmbuLink (per the search summary), and
> Mind's homepage calls it "Cario PACs" [1][2].
>
> The vendor site refused direct fetch (TLS reset) during this research. Product facts come from search-engine summaries of the vendor pages [2]–[6].

## A. Clinical workflow coverage
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| A1 | Pre-anesthesia assessment / pre-op evaluation | ❌ | No anesthesia/OR product in the published software catalog (5 products) [3]. | [3] |
| A2 | Consent / pre-op checklist | ? | Not described for iChart [4]. | [4] |
| A3 | WHO surgical safety checklist (sign-in/time-out/sign-out) | ❌ | No OR product in catalog [3]. | [3] |
| A4 | Intra-op anesthesia record — auto vitals capture | ❌ | No anesthesia record product [3]. | [3] |
| A5 | Intra-op — drugs, fluids, blood, gases, events, airway | ❌ | No anesthesia record product [3]. | [3] |
| A6 | Anesthesia machine / ventilator parameter capture | ❌ | Not advertised. Device capture is limited to vitals/ECG in Virtual ER and AmbuLink [5][6]. | [3][5][6] |
| A7 | PACU / recovery (Aldrete, discharge criteria) | ❌ | Not in catalog [3]. | [3] |
| A8 | Post-op anesthesia visit / pain service | ❌ | Not in catalog [3]. | [3] |
| A9 | ICU flowsheet / vital charting | ? | iChart is generic "IPD paperless". ICU flowsheet and auto-charting not described [4]. | [4] |
| A10 | ICU nursing assessment, care plan, nursing notes | ◐ | iChart covers inpatient "patient records" in general. No ICU-specific nursing content described [4]. | [4] |
| A11 | Medication orders / MAR / infusion management | ◐ | iChart mentions "prescriptions" [4]. MAR and infusion management not described. | [4] |
| A12 | Fluid balance (I/O) | ? | Not described. | |
| A13 | ICU scoring (APACHE, SOFA, GCS, etc.) | ? | Not described. | |
| A14 | Physician notes / progress notes | ? | Possibly within iChart "patient records" [4]. Not confirmed. | [4] |
| A15 | Lab / imaging results view | ◐ | Imaging only: **HeartStream** web DICOM PACS viewer with measurement tools and report templates (per 10bit) [7]. Lab view not found. | [7] |
| A16 | Shift handover / transfer summary | ◐ | Pre-hospital handover only: **AmbuLink** streams video, audio, GPS, patient assessment and continuous vitals from the ambulance to a command center [5]. No in-hospital handover document found. | [5] |
| A17 | General ward / IPD charting | ✅ | **iChart: IPD Paperless**: inpatient records, schedules and prescriptions; list price ฿1.5M [4]. | [4] |
| A18 | ER / labour room / other areas | ✅ | **Virtual ER**: ER telemedicine with vital signs, 12-lead ECG reports with analysis, and video consult, ฿650k [6]. **Virtual LR** (labour room), ฿450k, no detail [3]. **AmbuLink EMS**, ฿1.2M [5]. | [3][5][6] |

## B. OR / perioperative management
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| B1 | OR scheduling / booking | ❌ | No OR product in catalog [3]. | [3] |
| B2 | OR status board / case tracking | ❌ | No OR product in catalog [3]. | [3] |
| B3 | Staff / resource management | ? | iChart "schedules" are mentioned without detail [4]. | [4] |
| B4 | Supplies, implants, charge capture / billing | ? | Not described. | |

## C. Medical device integration
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| C1 | Own device gateway / middleware (name) | ◐ | No named gateway. Device capture is embedded in Virtual ER (vitals, 12-lead ECG) and AmbuLink (continuous vitals) [5][6]. | [5][6] |
| C2 | Multi-brand support (number of drivers / brands) | ? | Supported device brands not published. | |
| C3 | Monitors, anesthesia machines, ventilators, pumps | ◐ | Vital-signs monitors and ECG only, in the ER and ambulance products [5][6]. Mind also sells its own BT-380 fetal/maternal monitor and BT-500 incubator hardware [1][2]. Integration of these devices is not stated. | [1][2][5][6] |
| C4 | Waveform / high-resolution data | ◐ | 12-lead ECG with analysis in Virtual ER [6]. HeartStream handles DICOM images [7]. Continuous waveform storage not described. | [6][7] |
| C5 | Alarm management / surveillance | ? | Not described. | |

## D. HIS / interoperability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| D1 | HL7 v2 (ADT, orders, results) | ? | No public interface documentation. 10bit claims "compatibility with other systems" for HeartStream, unspecified [7]. | [7] |
| D2 | FHIR | ? | Not found. | |
| D3 | Document/PDF export to HIS | ? | HeartStream has report templates [7]. Export to HIS not described. | [7] |
| D4 | Thai HIS experience (HOSxP, in-house HIS, etc.) | ? | None documented. A possible iChart deployment exists at a `.go.th` hospital domain credited to 10bit, not to Mind [8]. | [8] |

## E. Clinical decision support & analytics
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| E1 | Alerts / rules / care bundles | ? | Not described. | |
| E2 | Drug interaction / dosing checks | ? | Not described. | |
| E3 | Dashboards / quality indicators / reports | ? | Not described. | |
| E4 | Research / data export | ? | Not described. | |
| E5 | AI features | ◐ | Roadmap only: HeartStream lists "future AI-assisted image analysis" (10bit) [7]. ECG "analysis" in Virtual ER may be device-native [6]. | [6][7] |

## F. Configurability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| F1 | Form builder (who does it: hospital vs vendor) | ? | Not described. | |
| F2 | Report builder | ◐ | HeartStream only: "customizable report templates" for imaging reports [7]. | [7] |
| F3 | Workflow / rule configuration | ? | Not described. | |

## G. Technical
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| G1 | Architecture, OS, database | ◐ | HeartStream: web-based PACS server, browser access without install, updates over the internet [7]. Other products: ? | [7] |
| G2 | Deployment: on-prem / cloud / hybrid | ? | Not stated. One-off package pricing hints at on-prem/perpetual (inference) [3]. | [3] |
| G3 | Offline / downtime mode at bedside | ◐ | AmbuLink falls back to push-to-talk over cellular when video bandwidth is weak [5]. Ward/bedside downtime mode: ? | [5] |
| G4 | Mobile / web access | ◐ | HeartStream: any device via web browser [7]. AmbuLink: in-ambulance mobile kit [5]. iChart platform: ? | [5][7] |
| G5 | Thai language UI | ? | The vendor site is mainly Thai [2], but the product UI language is not documented. | [2] |
| G6 | Security / certifications (FDA, CE, ISO 13485, IEC 62304 …) | ? | None found. | |

## H. Commercial
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| H1 | Licensing model (per bed / site / module / subscription) | ◐ | Fixed one-off package prices per product (suggesting perpetual licences, inferred) [3]. | [3] |
| H2 | Typical project components (hardware, services, support) | ◐ | Hardware (fetal monitor, phototherapy, incubator) plus software catalog [2]. The AmbuLink/Virtual ER kits presumably include devices (unverified) [5][6]. Services and SLA: ? | [2][5][6] |
| H3 | Known price points | ✅ | List prices: iChart ฿1.5M, AmbuLink ฿1.2M, HeartStream ฿3.5M, Virtual ER ฿650k, Virtual LR ฿450k [3][4][5][6]. | [3][4][5][6] |

## Sources
1. FLORA internal: `docs/competitor/senemed.md` (Senemed search log, Mind Medical Care profile, 2026-10-13).
2. Mind Medical Care, home page (self-described "leader of medical software solutions of Thailand"; hardware + software; search summary, direct fetch failed): https://www.mindmedicalcare.com/
3. Mind Medical Care, Software category page (5 products and list prices; search summary): https://www.mindmedicalcare.com/category/%E0%B8%8B%E0%B8%AD%E0%B8%9F%E0%B8%97%E0%B9%8C%E0%B9%81%E0%B8%A7%E0%B8%A3%E0%B9%8C
4. Mind Medical Care, iChart: IPD Paperless product page (search summary): https://www.mindmedicalcare.com/product-page/ichart-ipd-paperless
5. Mind Medical Care, AmbuLink EMS Telemedicine product page (search summary): https://www.mindmedicalcare.com/product-page/ambulink-ems-telemedicine
6. Mind Medical Care, Virtual ER product page (search summary): https://www.mindmedicalcare.com/product-page/virtual-er
7. 10bit Development Co., Ltd., HeartStream product page (web DICOM PACS; other 10bit modules: cardiovascular, ophthalmology, OB&GYN/MOM, emergency medicine, general medicine, radiology): https://10bitdevelopment.com/heartstream/
8. iChart login page at a Thai government hospital domain, crediting 10Bitdevelopment (2021): https://ichart.smpkhos.go.th/default/login
9. Facebook, Mind Medical Care Co.,Ltd (mindmedthailand): https://www.facebook.com/mindmedthailand/
10. DataForThai, company record 0205554015946 (search summary; direct fetch 403): https://www.dataforthai.com/company/0205554015946/
11. SET Listed Company Snapshot, SMD100 / SMD Rise PCL (formerly SaintMed), product groups incl. "Smart Hospital Medical Devices": https://lssmedia.setlink.set.or.th/2024/YE/SMD100-YE67-ListedCompanySnapshot-EN.html
12. DataForThai, บริษัท เซนต์เมด จำกัด: https://www.dataforthai.com/company/0125554002331/
13. Kaohoon, SaintMed renamed SMD Rise and restructured: https://www.kaohoon.com/news/713815
14. senemed.com parked domain (GoDaddy for sale): https://forsale.godaddy.com/forsale/www.senemed.com
