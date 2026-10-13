# System scope: Dräger Innovian — Innovian Anesthesia, Innovian Critical Care, Innovian IQ / Anesthesia Analytics, Innovian Solution Suite, plus Infinity Gateway / Interoperability Suite (SDC) (Drägerwerk AG & Co. KGaA)

Research date: 13 Oct 2026. Companion to the profile `../drager-innovian.md`.

Legend per item: ✅ supported (cite) · ◐ partial / add-on / needs extra product (say which) · ❌ not offered · ? not found publicly. Cite a source [n] on every ✅/◐/❌.

Labels: **[INTERNAL]** = from FLORA repo documents about the KCMH install (sources I1–I3); not for customer-facing use without approval. **[snippet]** = draeger.com returned HTTP 403 to automated fetches, so the claim comes from a search-engine snippet of that page/PDF; re-check in a browser before external use. Many public sources are old (2006–2012). Where that matters, the year is given.

## A. Clinical workflow coverage
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| A1 | Pre-anesthesia assessment / pre-op evaluation | ✅ | Web-based pre-anesthesia assessment through **Innovian Anesthesia E-Forms**. Can be filled at pre-admission testing, holding or inpatient units, then flows into the AIMS record. History, allergies and current tests are captured. [INTERNAL] KCMH runs "Preanesthetic evaluation and medication record" and "PreOp" form families. | [11][17][2] [snippet]; I2 |
| A2 | Consent / pre-op checklist | ◐ | E-Forms lists a "preoperative verification process" [snippet]. v4.0 added barcode patient ID/verification. [INTERNAL] KCMH uses an "Anesthesia Check List" form family. No public evidence of an electronic consent module. | [11][15]; I2 |
| A3 | WHO surgical safety checklist (sign-in/time-out/sign-out) | ? | No public mention of a WHO-format checklist. KCMH's "Anesthesia Check List" form [INTERNAL] could be configured that way, but whether it is WHO-structured is unconfirmed. | I2 |
| A4 | Intra-op anesthesia record — auto vitals capture | ✅ | Core function: a continuous paperless record with automated capture of vital signs from monitors and devices. | [3][17][14] |
| A5 | Intra-op — drugs, fluids, blood, gases, events, airway | ✅ | Drugs, fluids and events are charted on the record. The v8 Moderate Sedation module adds a quick-charting medication toolbar, timers and reminders. [INTERNAL] KCMH "Anesthesia Report" holds airway, regional, line and invasive-procedure sections, plus pump info and clinical events. Blood-product specifics are not stated publicly. | [3][20]; I2 |
| A6 | Anesthesia machine / ventilator parameter capture | ✅ | Native integration with Dräger anesthesia workstations and ventilation via Infinity. GE published a list of GE anesthesia machines (Aisys, Avance, Aespire…) that connect to Innovian. | [7][23][24] |
| A7 | PACU / recovery (Aldrete, discharge criteria) | ✅ | Pre-op through PACU. v2.2 added Holding and PACU data access. [INTERNAL] KCMH has "PACU" and "PACU (Ambulatory)" form families with recovery scoring. The public material does not name Aldrete specifically. | [10][12][17]; I2 |
| A8 | Post-op anesthesia visit / pain service | ◐ | V9.0 adds post-anesthesia evaluation notes [snippet]. [INTERNAL] KCMH has a "PAIN" form family (scores, catheter, adverse effects). No public evidence of a dedicated acute-pain-service module or worklist. | [1]; I2 |
| A9 | ICU flowsheet / vital charting | ✅ | **Innovian Critical Care**: electronic ICU chart with flowsheets. Automatically charts device parameters, lab data and fluid balances. | [4][34][7] |
| A10 | ICU nursing assessment, care plan, nursing notes | ◐ | Care-plan templates (ventilated patient, MI, sepsis) and patient-specific care plans; "replaces most paper-based documentation". Nursing-assessment and nursing-note content is not detailed publicly. Also, there is no post-2015 ICC collateral, which suggests the product is in maintenance mode. | [4][7] |
| A11 | Medication orders / MAR / infusion management | ◐ | Intra-op medication *documentation* only (incl. the sedation quick-charting toolbar). No public evidence of CPOE, an ICU MAR or pump-programming integration. [INTERNAL] KCMH archive holds "pump information" records. | [3][20]; I2 |
| A12 | Fluid balance (I/O) | ✅ | ICC automatically charts fluid balances. | [4] |
| A13 | ICU scoring (APACHE, SOFA, GCS, etc.) | ◐ | "Scoring" is listed as an ICC feature, but no source names which scores (APACHE/SOFA/GCS). | [7][4] |
| A14 | Physician notes / progress notes | ? | No public description of ICU physician progress notes. [INTERNAL] the KCMH archive has "structured notes", but this is anesthesia-side. | I2 |
| A15 | Lab / imaging results view | ◐ | Labs: imported over HL7 into both Anesthesia and ICC. V9.0 adds a lab "fishbone" panel with trends [snippet]. Imaging view: not found. | [4][14][1] |
| A16 | Shift handover / transfer summary | ◐ | Continuity only: ICC can reference the patient's anesthesia record when the patient arrives in the ICU. No dedicated handover or transfer-summary tool was found. | [4] |
| A17 | General ward / IPD charting | ? | Dräger positions the suite for perioperative and critical care only. We found no ward module, but also no explicit statement that one is not offered. In Europe Dräger partners with third-party clinical IT vendors rather than extending Innovian. | [7][26] |
| A18 | ER / labour room / other areas | ◐ | Optional v8 **Moderate Sedation** module covers sedation cases outside the OR (meets VHA Directive 1073). ER and labour-room use: not found. | [20] |

## B. OR / perioperative management
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| B1 | OR scheduling / booking | ◐ | The 2007 suite launch describes OR coverage "scheduling, pre-op, holding, intra-op, PACU". Dräger's NL page frames this as *integration with* existing OR-planning systems. No public evidence of a native booking engine. | [7][2] [snippet] |
| B2 | OR status board / case tracking | ◐ | Anesthesia Analytics sample dashboards include a "family waiting room dashboard" and perioperative KPIs. This is a report add-on, not a live OR board. | [6] [snippet] |
| B3 | Staff / resource management | ? | Not found. | — |
| B4 | Supplies, implants, charge capture / billing | ◐ | **Charge capture: strong.** Automated capture of anesthesia billing and compliance elements is a headline feature (US billing model). Supplies and implants tracking: not found. | [3][17][15] |

## C. Medical device integration
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| C1 | Own device gateway / middleware (name) | ✅ | **Infinity Gateway Suite** (Infinity network → HL7 2.3 / IHE HL7 2.6, ASTM, paging). Newer: the **Dräger Interoperability Suite** (SDC Inbound Service + Clinical Data Broker, Infinity Converter Service, HL7 Metrics outbound, High-Resolution Data Service, Discovery Proxy) and the CC300 converter. [INTERNAL] KCMH feeds Innovian through Infinity Gateway **plus** Capsule/Xnet DataCaptor (a Philips product). | [24][25]; I1 |
| C2 | Multi-brand support (number of drivers / brands) | ◐ | "Open architecture" connects to existing third-party devices. GE published a GE device list for Innovian (anesthesia machines and monitors, 2018). No driver count is published. [INTERNAL] KCMH needed Capsule for non-Dräger devices, a second-vendor dependency. | [3][23]; I1 |
| C3 | Monitors, anesthesia machines, ventilators, pumps | ◐ | Monitors, anesthesia machines and ventilators: yes (Dräger native, GE listed). Infusion pumps: no public evidence of direct integration. | [7][23][24] |
| C4 | Waveform / high-resolution data | ◐ | Innovian charts trend/parameter values. Near-real-time high-resolution streaming exists only via the separate Interoperability Suite **High Resolution Data Service** (optional). Waveform storage inside Innovian: not found. | [25] |
| C5 | Alarm management / surveillance | ◐ | This sits in the Infinity Gateway (alarm export to paging/third-party systems, remote alarm viewing) and the IHE HL7 2.6 alarm option, not in Innovian. Innovian itself has only "notification capabilities" (v2.0). | [24][14] |

## D. HIS / interoperability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| D1 | HL7 v2 (ADT, orders, results) | ✅ | ICC receives ADT and labs from the HIS via HL7. Anesthesia exchanges data via HL7/XML. In the VA it reads and writes VistA. US support tiers include HL7 interface monitoring. | [4][14][10][9] |
| D2 | FHIR | ◐ | Innovian: not found. The Interoperability Suite's Clinical Data Broker can output FHIR (device data only). Dräger's ICM 14 PDMS (EU, a different product) added FHIR. | [25][27] |
| D3 | Document/PDF export to HIS | ◐ | Embedded NovaPDF creates searchable PDFs, and there is a ReportViewer/Web API (v2.2). [INTERNAL] At KCMH, the PDF hand-off to ePHIS is a file-share workflow that needed a separate custom utility for naming, multi-case days and delivery. | [10][12]; I1, I3 |
| D4 | Thai HIS experience (HOSxP, in-house HIS, etc.) | ◐ | [INTERNAL] KCMH (in-house ePHIS) only, via PDF/file share, with no structured push. No public Thai reference site and no HOSxP evidence. | I1, I3 |

## E. Clinical decision support & analytics
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| E1 | Alerts / rules / care bundles | ◐ | The core has notifications (v2.0), required fields and time stamps (v4.0), and timers/reminders in the sedation module. Quality-measure decision support came through a 2018 partnership with Cognitive Medical Systems (third party). ICC has care-plan templates (e.g., sepsis). No general rules engine is described. | [14][15][20][19][4] |
| E2 | Drug interaction / dosing checks | ? | Not found for Innovian. | — |
| E3 | Dashboards / quality indicators / reports | ✅ | **Innovian Anesthesia Analytics** (ClickOnce Windows app, retrospective reports, tables/matrices/graphs, KPIs such as antibiotic timing and PONV, dashboards incl. medication reconciliation). **Innovian IQ** has 32 pre-configured reports, per the profile's source [5]; a 2026 re-search could not reconfirm the figure. Add-on modules. | [6][5] |
| E4 | Research / data export | ✅ | Web API with read/write access to the central DB, plus custom stored-procedure calls for data mining and cross-case analysis (v2.2). The vendor lists "data available for research". | [12][17] |
| E5 | AI features | ? | None found. | — |

## F. Configurability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| F1 | Form builder (who does it: hospital vs vendor) | ◐ | E-Forms makes web documents "similar to existing hospital paper forms" and can be configured for other care-path steps. Case environments are configurable per case type. **Who configures is not stated publicly.** US projects bill professional services per upgrade. [INTERNAL] KCMH ended up with seven flat form families. | [11][17][9]; I2 |
| F2 | Report builder | ◐ | Analytics add-on supports user-defined reports, for "those with basic knowledge of off-the-shelf reporting applications". SSRS is a dependency per VA TRM. | [6][10] |
| F3 | Workflow / rule configuration | ? | Only "solution adapted to the hospital's existing workflow" and configurable case environments. No rule or workflow designer is described. | [17] |

## G. Technical
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| G1 | Architecture, OS, database | ✅ | Windows client and Windows Server only, Microsoft .NET Framework, IIS, Microsoft SQL Server, SSRS, embedded NovaPDF, Web API layer. Thick-client workstations with a central server. [INTERNAL] KCMH: Innovian Server VM, Web Application and SQL Server prod/backup DBs. | [10][8][28][13]; I1 |
| G2 | Deployment: on-prem / cloud / hybrid | ✅ | On-premise (hospital servers). VA TRM notes the product "includes cloud-based functionality" (unspecified). No vendor SaaS offering found. | [10] |
| G3 | Offline / downtime mode at bedside | ✅ | Thick-client workstations kept recording without a server connection during a ~4 h total server outage, with no data loss (Rockford Memorial, 2006 first-person account). Behaviour in current versions is not re-confirmed. | [13] |
| G4 | Mobile / web access | ◐ | Web-based access to records and the E-Forms web UI. The Mobile Report Viewer (v4.1, 2012) is **view-only** in a browser. No native mobile app. Badge login in V9.0 is VA-only [snippet]. | [16][11][1] |
| G5 | Thai language UI | ? | No evidence of a Thai (or other Asian-language) UI. Dräger Thailand has no Innovian marketing page. | [33] |
| G6 | Security / certifications (FDA, CE, ISO 13485, IEC 62304 …) | ◐ | Listed in FDA GUDID as a device (Draeger Medical Systems; product code BSZ; "not exempt from premarket submission", but no 510(k) number disclosed). ONC EHR certification (US). Vendor claims DoD DIACAP certification. VA could **not verify FIPS 140-2**. CE / ISO 13485 / IEC 62304 statements for Innovian: not found. | [22][18][3][10] |

## H. Commercial
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| H1 | Licensing model (per bed / site / module / subscription) | ◐ | Per-version software licence (6.x→8.0 licence given free to support customers), separately sold modules (E-Forms, Analytics, Moderate Sedation) and an annual tiered support contract. The licence metric (per bed/workstation/site) is not public. | [9][20][6] |
| H2 | Typical project components (hardware, services, support) | ✅ | Licence + professional services (implementation, every major upgrade, clinical training) + support tier ("Basic plus Proactive Maintenance": 24x7 phone, remote login, backups, HL7 interface monitoring, SQL health checks) + customer-supplied Windows Server/SQL licences and hardware. Gateway products are extra. Major upgrades can strand old data (pre-6.1 data cannot migrate to 8.0). | [9][31][32][24][21] |
| H3 | Known price points | ◐ | Only fragments: a US VA award of ~USD 13K for Innovian professional services/clinical training (Nov 2025), and VA sole-source annual maintenance notices (no value shown). No licence prices; no Thai tender/ราคากลาง found. Scale references: Duke >150 points of care; >130 hospitals worldwide. | [32][31][29][30] |

## Sources
1. Dräger US, Innovian Anesthesia (V9.0 features: lab fishbone, toolbars, post-anesthesia evaluation notes, VA badge login) [snippet]: https://www.draeger.com/en-us_us/Hospital/Operating-Room/Innovian
2. Dräger Belgium (NL), Innovian Anaesthesia (open architecture; OK-planning integration; >130 hospitals / >3,000 users) [snippet]: https://www.draeger.com/nl_be/Products/Innovian-Anaesthesia
3. Dräger, Innovian Anesthesia brochure 9066712 (auto vitals, charge capture, DIACAP claim) [snippet]: https://www.draeger.com/Content/Documents/Products/innovian-anesthesia-br-9066712-us.pdf
4. Dräger, Innovian Critical Care data sheet 9051617 (device/lab/fluid-balance charting, HL7 ADT/lab, care-plan templates, web access) [snippet]: https://www.draeger.com/Content/Documents/Products/innovian-critical-care_ds_9051617_en.pdf
5. Dräger, Innovian IQ (32 reports; cited from profile, not re-confirmed 2026): https://www.draeger.com/en-us_us/Hospital/Operating-Room/Innovian/IQ
6. Dräger, Innovian Anesthesia Analytics brochure 9051628 (ClickOnce, user-defined reports, KPIs, sample dashboards incl. family waiting room) [snippet]: https://www.draeger.com/Content/Documents/Products/innovian-anesthesia-analytics-br-9051628-en-us.pdf
7. Respiratory Therapy, "Draeger Medical launches web-based information management solution" (Innovian Solution Suite, 2007: ICU charting, flowsheets, scoring; OR scheduling-to-PACU): https://respiratory-therapy.com/department-management/clinical/draeger-medical-launches-web-based-information-management-solution/
8. Dräger, Innovian capability statement (US federal): https://www.draeger.com/Content/Documents/Content/cap-statement-innovian-DMC-101214-us-2205-7.pdf
9. Dräger letter to VA customers, Innovian Anesthesia 6.x EOL 31 Dec 2022 (licence, services, support tiers): https://www.oit.va.gov/Services/TRM/files/EOL_Letter_IA_6_V5_11_20_20_Final_Approved.pdf
10. US VA Technical Reference Model, Innovian Anesthesia (Windows-only, .NET, IIS, SQL Server, SSRS, NovaPDF, VistA R/W, cloud functionality, FIPS unverified; 8.0 SP1 Jul 2022): https://www.oit.va.gov/Services/TRM/ToolPage.aspx?tid=7755
11. Dräger, Innovian Anesthesia E-Forms brochure 9051624 [snippet]: https://www.draeger.com/Content/Documents/Products/innovian-e-forms-9051624-en-us.pdf
12. ITN, "Draeger upgrades its Innovian Anesthesia system" (v2.2, May 2008: Web API, stored procedures, Holding/PACU, ReportViewer, PreOp eForms): https://www.itnonline.com/content/draeger-upgrades-its-innovian-anesthesia-system
13. ITN, "Innovian Anesthesia withstands server shutdown, maintains data integrity" (2006 thick-client downtime account): http://www.itnonline.com/content/innovian-anesthesia-withstands-server-shutdown-maintains-data-integrity
14. ITN, "Draeger Medical feature Innovian Anesthesia 2.0" (HL7/XML, notifications, labs): https://www.itnonline.com/content/draeger-medical-feature-innovian-anesthesia-20
15. HealthExec, "Draeger releases Innovian Anesthesia 4.0" (required fields, e-signatures, barcode ID, charge capture): https://healthexec.com/topics/healthcare-management/healthcare-economics/draeger-releases-innovian-anesthesia-40
16. MedWrench, "Dräger introduces Innovian Anesthesia 4.1 with remote access option" (Mobile Report Viewer, 2012): https://www.medwrench.com/article/30194/dr-ger-introduces-innovian-anesthesia-4-1-with-remote-access-option
17. MedWrench, Dräger Innovian Anesthesia equipment listing (feature list: web pre-anesthesia, billing capture, configurable case environments, research data): https://www.medwrench.com/equipment/9686/dr-ger-innovian-anesthesia
18. Becker's ASC, Innovian EHR technology certification: https://www.beckersasc.com/uncategorized/draeger-medicals-innovian-anesthesia-solution-receives-ehr-technology-certification/
19. Cognitive Medical Systems and Dräger, quality-measure decision support (2018): https://cognitivemedicalsystems.com/company/news/cognitive-medical-systems-teams-up-with-drager-to-streamline-quality-measure-adherence-in-perioperative-care/
20. Dräger, Innovian Moderate Sedation flyer DMC-106177 (v8 optional module, VHA Directive 1073) [snippet]: https://www.draeger.com/Content/Documents/Products/sedation-fl-DMC-106177-en-us-2305-1.pdf
21. Innovian Anesthesia Customer Release Notes v8.0 Ed. 2, Mar 2022 (third-party mirror; pre-6.1 data cannot migrate to 8.0) [snippet; fetch 403]: https://bioclinicalservices.com.au/drager-medical/clinical/innovian-anesthesia-customer-release-notes-ver-8-0-ed-2-march-2022
22. FDA AccessGUDID, Innovian Anesthesia (Draeger Medical Systems, product code BSZ): https://accessgudid.nlm.nih.gov/devices/04049098005081
23. GE Healthcare, perioperative connectivity brochure (GE devices supported via Draeger Innovian Anesthesia, 2018) [snippet; fetch 502]: https://www.gehealthcare.com/-/jssmedia/2bd8714feeb0442da7174c275cddf76c.pdf
24. Dräger, Infinity Gateway Suite (HL7 2.3, IHE HL7 2.6 vitals/alarms, paging, ASTM) [snippet]: https://www.draeger.com/en-us_us/Products/Infinity-Gateway-Suite
25. Dräger, Interoperability Suite (SDC Inbound + Clinical Data Broker → HL7/FHIR/streaming; Infinity Converter Service; High Resolution Data Service) [snippet]: https://www.draeger.com/en_uk/Products/Interoperability-Suite
26. Dräger Clinical IT Partners (Bow Medical DIANE, Better Care): https://www.draeger.com/en_neeur/Hospital/Clinical-IT-Collaboration
27. Dräger newsroom, ICM 14 PDMS (FHIR, 2022): https://www.draeger.com/de_de/Newsroom/about-draeger/PDMS-extension-maintenance-process-digital-throughout-Document
28. iFixit, Drager Innovian device page (web-based architecture, .NET, SQL, Web API): https://ts.ifixit.com/Device/Drager_Innovian
29. BioSpace, Duke University Health System implements Innovian Anesthesia (>150 points of care): https://www.biospace.com/duke-university-health-system-joins-with-draeger-medical-inc-to-implement-innovian-anesthesia-solution
30. Newswire, Capital District Health Authority and IWK Health Centre to implement AIMS (Innovian, >130 hospitals): https://www.newswire.ca/news-releases/capital-district-health-authority-and-iwk-health-centre-to-implementanesthesia-information-management-system-544287552.html
31. VA sole-source notice, Innovian Anesthesia Record Keeping System maintenance, VISN 5 (2026–27): https://console.sweetspotgov.com/federal-contracts/0fcff063-7d75-5829-a13b-31885152c740
32. GovCon in a Box, Draeger Inc federal awards (VA "Innovian professional services – clinical/training", ~USD 13K, Nov 2025): https://www.govconinabox.com/explore/contractors/profile/M835NJ4FS8T9
33. Dräger Thailand home (no Innovian/Thai-language AIMS marketing found): https://www.draeger.com/th_th/Home
34. Dräger, Innovian Critical Care data sheet (Spanish): https://www.draeger.com/Content/Documents/Products/innovian-criticalcare-905162-es.pdf

Internal (not public; label [INTERNAL]; no network details reproduced):
- I1. `docs/HANDOFF-INNOVIAN.md`: KCMH legacy install components (Innovian Server VM, Web App, SQL Server, Infinity Gateway, Capsule/Xnet DataCaptor, HIS PDF/file-share).
- I2. `docs/INNOVIAN-FORM-COVERAGE.md`: seven KCMH form families and related archive data.
- I3. `docs/competitor/drager-innovian.md`: competitor profile (Innovian-to-ePHIS PDF utility project).
