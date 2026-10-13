# System scope: Mindray software stack as resold/bundled by Mediplex (Mediplex (Thailand) Co., Ltd. / Shenzhen Mindray)

Legend per item: ✅ supported (cite) · ◐ partial / add-on / needs extra product (say which) · ❌ not offered · ? not found publicly. Cite a source [n] on every ✅/◐/❌.

> Research date: 2026-10-13. Desk research only. Companion to `../mediplex-pansuk.md` [1].
>
> **How to read this sheet.** The **Status** column rates the **Mindray-official software stack** that a Mindray
> distributor could bundle: BeneVision CMS / DMS, eGateway, BeneLink, M-Connect (ICU and OR solutions),
> monitor-resident Clinical Assistive Applications, and AnaeSight. In **Notes**, `MR:` marks Mindray-official
> facts and `MPX:` marks what **Mediplex is confirmed to sell in Thailand**.
>
> **What Mediplex is confirmed to sell.** Hardware only: A7 / A8 / A9 / WATO EX-65 / EX-35 / EX-20 anesthesia
> machines. The A7 listing names "AnaeSight" as an integrated IV-inhalational solution linking machine, monitor and pumps [3].
> The site also lists Ventilator, Patient Monitor, Infusion and Ultrasound "systems" [2], and offers delivery, service,
> installation and renovation [2]. **The Mediplex site never names Mindray, CMS, eGateway, BeneLink or any information
> system** [2][3]. Its only software signal is an "Application Support" job ad for a "Medical system" at an affiliate's Chiang Mai
> branch [4]. **Mindray has its own Thai subsidiary**, Mindray Medical (Thailand) Ltd. [16]. So the IT stack (eGateway / CMS) may be
> sold and implemented by Mindray Thailand directly rather than by Mediplex. This is **UNVERIFIED**.
>
> **Key finding.** No Mindray-branded **AIMS (anesthesia record)** or **ICU CIS (nursing/physician documentation)** turned up
> outside China. Mindray's historical AIMS route was a 2010 US co-marketing deal with DocuSys [13]. In China, Mindray sells the
> "瑞智联" (M-Connect) IT ecosystem in about 700 hospitals [15]. A 2026 China-only "瑞智重症决策辅助系统" (ICU decision-support) module
> aggregates vitals, I/O and infection indicators [14]. Outside China, Mindray's offer is **device connectivity plus central
> monitoring plus an HL7 pipe to someone else's EMR/CIS** [5][7], not clinical charting.

## A. Clinical workflow coverage
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| A1 | Pre-anesthesia assessment / pre-op evaluation | ? | MR: no Mindray AIMS found. The OR solution page lists no pre-op module [6]. MPX: none. | [6][13] |
| A2 | Consent / pre-op checklist | ? | No product found. | |
| A3 | WHO surgical safety checklist (sign-in/time-out/sign-out) | ? | No product found. | |
| A4 | Intra-op anesthesia record — auto vitals capture | ◐ | MR: vitals are captured on the monitor and CMS, and eGateway sends periodic vitals (IHE PCD results) to a **third-party** EMR/AIMS. Mindray provides no anesthesia record of its own [6][7]. MPX: not advertised. | [6][7] |
| A5 | Intra-op — drugs, fluids, blood, gases, events, airway | ◐ | MR: **AnaeSight** on A7/A5 controls infusion pumps from the anesthesia machine and shows the **eMAC** combined-drug-effect indicator. This is device control and display, not documentation [12]. MPX: AnaeSight named on the A7 listing [3]. | [3][12] |
| A6 | Anesthesia machine / ventilator parameter capture | ◐ | MR: anesthesia machines and ventilators enter the monitor or CMS via **BeneLink** (up to 4 devices per monitor) and go to the EPR via eGateway [6][8]. Capture goes to the monitoring layer only, with no record. | [6][8] |
| A7 | PACU / recovery (Aldrete, discharge criteria) | ? | MR: "seamless transport monitoring" from OR to ward exists [6]. No Aldrete or discharge-criteria module was found. | [6] |
| A8 | Post-op anesthesia visit / pain service | ◐ | MR: MobileViewer lets anesthesiologists "follow patients after surgery" (viewing monitoring data only) [6]. No pain-service documentation. | [6] |
| A9 | ICU flowsheet / vital charting | ◐ | MR: CMS trends and 240 h full disclosure. CMS Viewer has "professional analysis tools" in the doctor's office [5][9]. China only: 瑞智重症决策辅助系统 replaces hand-transcribed vitals and curves [14]. No nursing flowsheet outside China. | [5][9][14] |
| A10 | ICU nursing assessment, care plan, nursing notes | ? | None found. Mindray positions an external CIS/EMR as the documentation system [5]. | [5] |
| A11 | Medication orders / MAR / infusion management | ◐ | MR: M-Connect "Infusion Closed Loop Management". The nurse scans patient and drug barcodes, executes CPOE orders on the pump, and infusion data feeds back to the EMR/HIS over the IHE HL7 interface. **Requires the hospital's CPOE/HIS** [5]. InfusionView shows vitals alongside infusions [5]. | [5] |
| A12 | Fluid balance (I/O) | ◐ | China only: the 瑞智重症 decision-support article cites I/O among the integrated data [14]. Not evidenced in export markets. | [14] |
| A13 | ICU scoring (APACHE, SOFA, GCS, etc.) | ◐ | MR: monitor-resident Clinical Assistive Apps on BeneVision N22/N19: **Early Warning Score, GCS, SepsisSight, HemoSight**, ST Graphic [11][18]. No APACHE or SOFA found. | [11][18] |
| A14 | Physician notes / progress notes | ? | None found. | |
| A15 | Lab / imaging results view | ? | Unconfirmed: a search summary says the iView workstation can host third-party PACS/LIS/HIS apps. No primary page was retrieved. | |
| A16 | Shift handover / transfer summary | ◐ | MR: "Pick and Go" transport monitor carries data continuously and uploads transfer data on re-insertion [5]. No handover document. | [5] |
| A17 | General ward / IPD charting | ◐ | MR: eGateway "Spot Check interface" sends vital-signs-monitor readings and manually entered modifiers to the EMR [7]. Vitals only. | [7] |
| A18 | ER / labour room / other areas | ? | Mindray has ER and CCU solution pages for monitoring. No documentation product found. | |

## B. OR / perioperative management
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| B1 | OR scheduling / booking | ? | Not mentioned on the M-Connect OR solution page [6]. | [6] |
| B2 | OR status board / case tracking | ◐ | MR: ViewStation "patient summary" of all surgical patients for the medical director. **Alarmwatch / Viewbed** let a senior anesthesiologist watch other ORs, and there is a one-key emergency call [6]. This is a monitoring view, not case-status tracking. | [6] |
| B3 | Staff / resource management | ? | Not found. | |
| B4 | Supplies, implants, charge capture / billing | ? | Not found. | |

## C. Medical device integration
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| C1 | Own device gateway / middleware (name) | ✅ | MR: **eGateway** (HL7 integration engine, in 32-bed, 200-bed and Enterprise tiers of up to 1,200 beds) plus the **BeneLink** bedside module [7][8]. MPX: not listed on its site [2]. | [2][7][8] |
| C2 | Multi-brand support (number of drivers / brands) | ◐ | MR: third-party ventilators, anesthesia machines, pumps and others connect **only through a Mindray N-series/Passport monitor via BeneLink**, up to 4 devices per monitor [8]. The supported-device list is in the BeneLink manual (not retrieved). Driver and brand counts are unknown. | [8] |
| C3 | Monitors, anesthesia machines, ventilators, pumps | ✅ | MR: M-Connect ICU integrates monitors, ventilators, infusion pumps, CRRT and ECMO [5]. The OR solution covers anesthesia machines and pumps [6]. | [5][6] |
| C4 | Waveform / high-resolution data | ✅ | MR: CMS has up to **240 h full-disclosure** waveforms [9]. eGateway has an optional high-resolution interface for vitals (IHE PCD), waveforms (IHE WCM) and alarms [7]. | [7][9] |
| C5 | Alarm management / surveillance | ✅ | MR: CentralStation alarms include pump and vent technical alarms ("drug exhaustion", "disconnected ventilator tubes") [5]. eGateway has an IHE ACM alarm interface [7]. **AlarmGUARD** pushes alarms to mobile devices (FDA K242728; not a primary alarm source) [10]. | [5][7][10] |

## D. HIS / interoperability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| D1 | HL7 v2 (ADT, orders, results) | ✅ | MR: eGateway supports **HL7 v2.1–2.6 plus IHE PCD**, with ADT (3 channels) and results (4 channels). Orders are limited to CPOE-to-pump in the infusion loop. eGateway also pulls ADT demographics down to the monitors [5][7][17]. | [5][7][17] |
| D2 | FHIR | ? | Not mentioned in the eGateway sheet (rev K, 2023) [7]. | [7] |
| D3 | Document/PDF export to HIS | ✅ | MR: eGateway "Document Sharing interface" files real-time and historical reports to the EMR or hospital DMS [7]. | [7] |
| D4 | Thai HIS experience (HOSxP, in-house HIS, etc.) | ? | No public Thai eGateway or HIS reference found (including HOSxP). MPX: none. | [1] |

## E. Clinical decision support & analytics
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| E1 | Alerts / rules / care bundles | ◐ | MR: monitor-resident EWS and SepsisSight, which follows Surviving Sepsis Campaign elements [11]. Per the K202405 summary, these were bench-tested only [18]. No configurable rule engine. | [11][18] |
| E2 | Drug interaction / dosing checks | ◐ | MR: eMAC combined anesthetic-effect indicator (PK/PD model) [12]. Barcode patient-drug match in the infusion loop [5]. No drug-interaction checking found. | [5][12] |
| E3 | Dashboards / quality indicators / reports | ? | Only CMS Viewer "analysis tools" and the ViewStation patient summary [5][6]. No QI or KPI dashboards found. | [5][6] |
| E4 | Research / data export | ? | Not found beyond the HL7 feeds [7]. | [7] |
| E5 | AI features | ◐ | China only: 瑞智重症决策辅助系统 ("patient digital twin" ICU decision support, 2026) [14]. Not shown as sold in Thailand. | [14] |

## F. Configurability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| F1 | Form builder (who does it: hospital vs vendor) | ? | No documentation product, so no form builder found. | |
| F2 | Report builder | ? | Not found. | |
| F3 | Workflow / rule configuration | ? | Not found. | |

## G. Technical
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| G1 | Architecture, OS, database | ◐ | MR: eGateway runs as software-only on a VM or as a Mindray-provided appliance, with multiple-DMS support [7]. CMS has CentralStation / WorkStation / ViewStation / CMS Viewer / MobileViewer tiers [5][9]. OS and database not published. | [5][7][9] |
| G2 | Deployment: on-prem / cloud / hybrid | ◐ | MR: on-prem (appliance or VM) [7]. Remote viewing from outside the hospital is via MobileViewer [5]. Cloud: not found. | [5][7] |
| G3 | Offline / downtime mode at bedside | ◐ | MR: monitors run standalone. eGateway accepts **48 h backfill** from devices after an outage [7]. | [7] |
| G4 | Mobile / web access | ✅ | MR: **MobileViewer / CMS Mobile Viewer** (multi-bed and single-bed views, alarm push) [5][6]. CMS Viewer on office PCs [5]. | [5][6] |
| G5 | Thai language UI | ? | Not verified for CMS, eGateway or the viewers. | |
| G6 | Security / certifications (FDA, CE, ISO 13485, IEC 62304 …) | ✅ | MR: FDA 510(k) for BeneVision CMS (K220058, K242728) [10] and the N-series monitors with CAA (K202405) [18]. Thai FDA registration of the IT products: ? | [10][18] |

## H. Commercial
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| H1 | Licensing model (per bed / site / module / subscription) | ◐ | MR: eGateway is tiered by bed count (32 / 200 / Enterprise up to 1,200), with optional alarm and high-res interfaces [7]. CMS, M-Connect and Thai pricing models: ? | [7] |
| H2 | Typical project components (hardware, services, support) | ◐ | MPX: devices plus nationwide delivery, service, installation and renovation [2]. Sister company Pansook supplies OR tables, lights and pendants [1]. Application support for a "Medical system" (Chiang Mai affiliate) [4]. Device-led bundle: inferred, UNVERIFIED [1]. | [1][2][4] |
| H3 | Known price points | ? | No e-GP awards or list prices found [1]. | [1] |

## Sources
1. FLORA internal: `docs/competitor/mediplex-pansuk.md` (company profile, search log, 2026-10-13).
2. Mediplex Thailand, home page (product categories, services, "Exclusive Distributor"; no Mindray/IT mention): https://www.mediplexthailand.com/
3. Mediplex Thailand, Anesthesia category (A7/A8/A9/WATO EX-65/35/20; AnaeSight on the A7 page; Mindray not named): https://www.mediplexthailand.com/category/2059/anesthesia
4. JobBKK, Mediplex (Thailand) "Application support (affiliated company, Chiang Mai branch)": https://jobbkk.com/jobs/detailurgent/197655/1376083
5. Mindray, *M-Connect IT solution for ICU* brochure (2020, P/N 210285X8P): https://www.mindray.com/content/dam/xpace/en/resources/brochure/M-Connect_IT_Solution_for_ICU_Brochure.pdf
6. Mindray, M-Connect OR solution page: https://www.mindray.com/en/solutions/hospitalwide-solution/or-solution
7. Mindray, eGateway product sheet 7009 rev K (2023-02-02): https://www.mindray.com/content/dam/xpace/en_us/resource-library/patient-monitoring/brochure/interoperability-and-cybersecurity/eGateway_prod_sheet_7009rev-K-2023-02-02.pdf
8. Mindray, BeneLink product page and product sheet 8130 rev C: https://www.mindray.com/na/products/patient-monitoring/interoperability-and-cybersecurity/benelink/ ; https://www.mindray.com/content/dam/xpace/en_us/resource-library/patient-monitoring/brochure/interoperability-and-cybersecurity/Benelink_prod_sheet_8130-revC-2022-01-31.pdf
9. Mindray, BeneVision CMS product page (240 h full disclosure, up to 1,200 devices, eGateway ADT/EMR): https://www.mindray.com/en/products/patient-monitoring/centralized-monitoring/benevision-cms
10. FDA 510(k) summaries via Innolitics: K220058 (BeneVision CMS) https://510k.innolitics.com/device/K220058 ; K242728 (CMS + AlarmGUARD) https://510k.innolitics.com/device/K242728
11. Mindray, BeneVision N22/N19 product page (Clinical Assistive Applications: SepsisSight, HemoSight, EWS, GCS, ST Graphic): https://www.mindray.com/uk/products/patient-monitoring/continuous-patient-monitoring/benevision-n22-n19
12. Mindray press release, A Series upgrades, AnaeSight and eMAC (Aug 2023): https://www.mindray.com/en/media-center/press/a-series-anesthesia-system-upgrades-enhance-safety-efficiency
13. Healthcare Innovation, "Mindray North America Forms Partnership with DocuSys" (2010, AIMS co-marketing): https://www.hcinnovationgroup.com/home/article/13002194/mindray-north-america-forms-partnership-with-docusys
14. PEdaily (China), 瑞智重症决策辅助系统 at a Guangxi Medical University affiliated hospital ICU (2026-05-12): https://news.pedaily.cn/20260512/129598.shtml
15. TMTPost (China), 迈瑞 "三瑞" ecosystem; 瑞智联 in about 700 hospitals by end-2023: https://www.tmtpost.com/7068453.html
16. Mindray SEC filing EX-8.1 (subsidiary list incl. Mindray Medical Thailand Limited): https://www.sec.gov/Archives/edgar/data/1373060/000119312514163316/d646003dex81.htm
17. Mindray, eGateway product page (bi-directional vitals/alarms/reports/full disclosure; ADT demographics download): https://www.mindray.com/in/products/it-products/egateway/
18. FDA 510(k) K202405 (BeneVision N-series incl. EWS / SepsisSight / GCS; bench testing) via Innolitics: https://fda.innolitics.com/device/K202405
