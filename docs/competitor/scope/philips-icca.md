# System scope: Philips IntelliSpace Critical Care and Anesthesia (ICCA) + add-ons (Philips; Thai seller Xovic Co., Ltd.)

Research date: 13 Oct 2026. Company and Thai-market background is in [../philips-icca-xovic.md](../philips-icca-xovic.md) [30].
Add-on stack assumed in this checklist: **ICCA** (documentation/CDS core) + **PIC iX** (Philips central station and data acquisition) and/or **Capsule MDIP** (vendor-neutral device integration) + **IntelliBridge EC10 / IntelliBridge System** (third-party bedside devices) + **IntelliBridge Enterprise** (HL7 engine) + **DAR** (reporting module). **IntelliSpace Perinatal** is a separate obstetrics product that is relevant only for labour room (A18). Philips says ICCA data integration "requires a data acquisition platform" (PIC iX and/or MDIP) [1][14], and the Release J datasheet says PatientLink and MDIP are "sold separately" [4].

Legend per item: ✅ supported (cite) · ◐ partial / add-on / needs extra product (say which) · ❌ not offered · ? not found publicly. Cite a source [n] on every ✅/◐/❌.

## A. Clinical workflow coverage
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| A1 | Pre-anesthesia assessment / pre-op evaluation | ✅ | Notes and Forms with a dynamic pre-anesthesia evaluation (PAE) form that shows only the questions relevant to the patient's demographics and answers. Pre-op data is pulled from hospital systems. Previous anesthesia records are available on demand | [3][6][7] |
| A2 | Consent / pre-op checklist | ◐ | "Patient readiness reports" and structured forms are documented. Electronic consent is not documented; it would have to be a hospital-built form | [5][7] |
| A3 | WHO surgical safety checklist (sign-in/time-out/sign-out) | ? | Not named in any Philips material found. It could probably be built as a configurable form, but that is unconfirmed | — |
| A4 | Intra-op anesthesia record — auto vitals capture | ◐ | Capture from devices into the anesthetic record is automatic, at hospital-configured intervals with clinician verification. **Requires an add-on**: PIC iX and/or Capsule MDIP (IntelliBridge for non-Philips devices) | [1][3][4][7] |
| A5 | Intra-op — drugs, fluids, blood, gases, events, airway | ✅ | The anesthetic record is driven by departmental case templates, with touch UI and shortcut keys. Intraop documentation includes cost capture. Care Continuum carries intake/output sites, fluid totals and key therapies. POCT blood gas is charted (Pécs). Blood products and airway fields are not itemised publicly, and the record is described as "retrospective documentation" | [4][5][6][12] |
| A6 | Anesthesia machine / ventilator parameter capture | ◐ | Philips says ICCA interfaces with "anesthesia machines, ventilators and patient monitors". This works only through MDIP / IntelliBridge (add-ons) | [5][7][16] |
| A7 | PACU / recovery (Aldrete, discharge criteria) | ◐ | Release J describes "customizable workflows transitioning care to post-surgical caregivers". Vienna uses ICCA through the recovery room. No Aldrete score or PACU discharge-criteria content is documented; a hospital would have to configure it | [4][11] |
| A8 | Post-op anesthesia visit / pain service | ? | Not documented | — |
| A9 | ICU flowsheet / vital charting | ✅ | Configurable flowsheet per care unit covering vitals, device data, labs, I/O, observations, assessments and procedures. Also used for code sheets, respiratory therapy and dialysis | [3][4][9] |
| A10 | ICU nursing assessment, care plan, nursing notes | ✅ | Nursing assessment records sit in the flowsheet. Forms cover nursing notes and the treatment plan. A phrase builder supports structured free text. Wound photos can be attached | [3][10] |
| A11 | Medication orders / MAR / infusion management | ✅ | Order Management (physician order entry, administration record, worklists, order sets, overdue reminders) or an HL7 interface to the hospital CPOE/pharmacy. Infusion Management charts rate, dose and volume manually or automatically. NICU fixed-volume dosing. Pump auto-charting needs device integration (add-on) | [3][4][8] |
| A12 | Fluid balance (I/O) | ✅ | I/O in the flowsheet. Fluid-balance calculations in the calculation engine. Care Continuum fluid totals carry across OR and ICU | [3][8][10] |
| A13 | ICU scoring (APACHE, SOFA, GCS, etc.) | ✅ | SAPS II, TISS, Norton, Braden and GCS are calculated automatically from charted data. APACHE, PRISM and others are configurable. SOFA is not named but would be configurable. Pécs reports compulsory scores auto-filled | [10][12] |
| A14 | Physician notes / progress notes | ✅ | Notes and Forms: admission, progress, consult notes, discharge summaries | [3][4] |
| A15 | Lab / imaging results view | ✅ | HL7 labs, ASTM/LIS2 local lab, microbiology (organism, susceptibility) and pathology import. Radiology orders. A PACS viewer launches from ICCA using RIS/PACS image location | [3][4][10] |
| A16 | Shift handover / transfer summary | ◐ | Care Continuum and record transfer pre-op → OR → ICU. Configurable epicrisis/summary. Pécs configured "shift transfer notes" as a flowsheet section. No dedicated handover (SBAR-style) tool is documented | [4][8][10][12] |
| A17 | General ward / IPD charting | ◐ | Philips claims support "across anesthesiology, critical care, intermediate care, and medical-surgical care specialties", but positions the product for high-acuity units. No general-ward deployment found | [3][11] |
| A18 | ER / labour room / other areas | ◐ | ER: Vienna describes a single record "starting from the emergency room". Labour room needs the **separate IntelliSpace Perinatal** product (fetal surveillance, OB charting) | [11][19] |

## B. OR / perioperative management
| B1 | OR scheduling / booking | ❌ | Not in the ICCA module list. No scheduling or theatre-management interface (e.g. SIU) is documented. The OR schedule would come from the HIS or a third-party system (absence inferred from the module list) | [4][7] |
| B2 | OR status board / case tracking | ❌ | Not in the ICCA module list. No status-board product in the documentation (absence inferred from the module list) | [4] |
| B3 | Staff / resource management | ? | Not documented. Only Active Directory user/role management is described | — |
| B4 | Supplies, implants, charge capture / billing | ◐ | "Intraoperative documentation and cost capture". Vienna analyses material costs. Diagnosis/procedure coding uses ICD catalogs or house catalogs "for reimbursement". Billing itself is done in the HIS. Implant tracking is not documented | [5][7][9][10][11] |

## C. Medical device integration
| C1 | Own device gateway / middleware (name) | ◐ | Not part of ICCA. Needs **PIC iX** (Philips central) and/or **Capsule MDIP** (vendor-neutral), plus **IntelliBridge EC10** (bedside module) or IntelliBridge System for third-party devices. All are sold separately | [1][4][14][16][17] |
| C2 | Multi-brand support (number of drivers / brands) | ◐ | Through MDIP (add-on), which Philips said in 2021 connects >1,000 device models. The EC10 lists Maquet, Dräger, GE, CareFusion, Covidien/Puritan Bennett and Edwards, with up to 4 devices per monitor | [15][16] |
| C3 | Monitors, anesthesia machines, ventilators, pumps | ◐ | All four are supported via the add-ons above. Infusion pumps are matched to orders by drug/solution | [3][7][16] |
| C4 | Waveform / high-resolution data | ◐ | ICCA charts numerics at configurable intervals. "Trend Upload" back-fills up to 8 h of numerics from PIC iX. Waveforms and full disclosure (7 days per the older PIIC iX brochure) stay in PIC iX. IntelliBridge Enterprise has a licence to send waveform snippets | [3][4][18][29] |
| C5 | Alarm management / surveillance | ◐ | ICCA "advisories" are clinical rules, not device alarms. Device alarm review and analytics are in PIC iX. Capsule Surveillance is a separate product | [3][14][18] |

## D. HIS / interoperability
| D1 | HL7 v2 (ADT, orders, results) | ✅ | HL7 v2.3/2.4 for ADT, labs, orders and results, document export/import and patient data export/import. Interfaces to CPOE/pharmacy. Usually routed through IntelliBridge Enterprise (ICCA bed-connection licences). Supports IHE and CCOW | [3][4][8][10][29] |
| D2 | FHIR | ◐ | The current product page cites "industry standards (e.g., HL7, FHIR)" for interfacing. No FHIR resources or profiles are documented | [1] |
| D3 | Document/PDF export to HIS | ✅ | Document export (PDF + HL7). Full patient record printable or saved as PDF. Document import (TXT/DOC/PDF/images) | [3][10] |
| D4 | Thai HIS experience (HOSxP, in-house HIS, etc.) | ? | No public evidence of a Thai HIS interface. Thai reference sites are claimed by Philips only, with no detail | [21][30] |

## E. Clinical decision support & analytics
| E1 | Alerts / rules / care bundles | ✅ | Calculation engine and clinical advisories with configurable rules. Hospitals can write their own. Five bundles: VAP, CLABSI, glucose, DVT, sepsis. Notifications can go to pager/phone. Published AKI CDS deployment in two UK ICUs | [3][8][9][10][27] |
| E2 | Drug interaction / dosing checks | ◐ | The "Medical Reference" module flags ADEs, allergy contraindications and inappropriate therapy, but the knowledge base comes from a **third-party drug-knowledge vendor** (extra licence) | [3][4][9] |
| E3 | Dashboards / quality indicators / reports | ✅ | 30+ standard reports, a drag-and-drop custom report builder and self-service visualisation. Reporting DB is separate from the charting DB. Delivered through the **IntelliSpace DAR module** (labelled as a module, "not intended for direct patient care") | [5][7][8][9] |
| E4 | Research / data export | ✅ | Searchable research DB (Vienna: 30–40k procedures/yr). Export to XML/CSV. Registry datasets (ICNARC, SRLF, DGAI). ODBC reporting database | [10][11] |
| E5 | AI features | ❌ | No AI or ML is marketed for ICCA; CDS is rule-based. Philips' Hemodynamic Instability Index work was research/trial, not an ICCA feature | [1][9][28] |

## F. Configurability
| F1 | Form builder (who does it: hospital vs vendor) | ✅ | Notes and Forms are hospital-customisable. A graphical configuration editor for documents, DB fields and lists is "usable without DB skills", with a separate test environment. In practice this is Philips configuration workshops plus a trained hospital analyst, not front-line clinicians | [1][3][10] |
| F2 | Report builder | ✅ | Drag-and-drop custom reports (DAR) | [5][7] |
| F3 | Workflow / rule configuration | ✅ | Flexible rules engine for hospital-defined advisories. VB.NET-based calculation engine. Order sets. Multiple unit configurations on one system | [8][10][4] |

## G. Technical
| G1 | Architecture, OS, database | ✅ | Release J: Windows Server 2016/2022 with Remote Desktop Services, SQL Server 2016/2022, Windows 10/11 thick or terminal-server clients, .NET 4.8, Active Directory. Separate reporting DB. Citrix thin clients supported (older release) | [4][8][10] |
| G2 | Deployment: on-prem / cloud / hybrid | ◐ | On-premise on hospital servers (single server, multi-server or cluster). Release J adds multi-tenancy across a campus or hospital group. A third-party source says "hybrid". No cloud/SaaS ICCA found | [4][10][22] |
| G3 | Offline / downtime mode at bedside | ◐ | Microsoft failover clustering for server HA. Trend Upload back-fills up to 8 h of monitor data after transport or outage. No offline bedside charting client is documented | [4][10] |
| G4 | Mobile / web access | ◐ | Access through terminal server/Citrix on tablets and laptops, a portal on IntelliVue bedside monitors and web-browser support (older release). "ICCA Anywhere" tablet client won an iF award. No native mobile app on current product pages; the mobile app (Care Assist) is a PIC iX product | [1][8][10][20] |
| G5 | Thai language UI | ? | Thai product page is English-only. Localised material exists in other languages (Russian, German), but no Thai UI evidence was found | [2][9][10] |
| G6 | Security / certifications (FDA, CE, ISO 13485, IEC 62304 …) | ✅ | FDA 510(k) K151366 (2015, product code DXJ). CE under EU MDR 2017/745, Class IIb SaMD. Non-modifiable audit trail, RBAC, encrypted backups. ISO 13485 / IEC 62304 not stated publicly beyond "Philips QMS". Thai FDA (อย.) registration not found | [1][13] |

## H. Commercial
| H1 | Licensing model (per bed / site / module / subscription) | ◐ | Modular: DAR, Medical Reference, MDIP, PIC iX and IntelliBridge are separate. IntelliBridge Enterprise sells per-bed connection licences (e.g. "ICCA 300 Beds License"). UK buyers purchase ICCA licences through Philips' sole agent. The core ICCA licence metric is not public | [4][25][29] |
| H2 | Typical project components (hardware, services, support) | ✅ | App/DB servers + AD + clients, PIC iX/MDIP, IntelliBridge, IBE, plus configuration workshops, onsite/remote training, go-live support and SLA service contracts. Sometimes bundled in multi-year financed hospital deals (Mandaya, Jakarta) | [1][4][26][29] |
| H3 | Known price points | ◐ | UK only: NHS GG&C 3-year support extension for its CareVue/ICCA ICU system, listed at £27M (aggregator figure, unverified). Belfast ICCA licence top-up about £18.4k. NHS Grampian 2026 award for "Philips hardware & software for ICCA" (value not shown). No Thai price or TOR found | [23][24][25][30] |

## Sources
1. Philips USA, ICCA product page: https://www.usa.philips.com/healthcare/product/HCNOCTN332/intellispace-critical-care-and-anesthesia (UK equivalent: https://www.philips.co.uk/healthcare/product/HCNOCTN332/intellispace-critical-care-and-anaesthesia)
2. Philips Thailand, ICCA product page (English only): https://www.philips.co.th/healthcare/product/HCNOCTN332/intellispace-critical-care-and-anesthesia
3. Philips, ICCA Release H technical data sheet (May 2015): https://images.philips.com/is/content/PhilipsConsumer/Campaigns/HC20140401_DG/Documents/ICCA%20data%20sheet.pdf
4. Philips, ICCA Release J technical data sheet (Mar 2024; multi-tenancy, OS/SQL list, "PatientLink and MDIP sold separately"): https://www.documents.philips.com/assets/20170523/77faf30709b44ea9a204a77c01611c8e.pdf
5. Philips, ICCA Anesthesia brochure (May 2015): https://images.philips.com/is/content/PhilipsConsumer/Campaigns/HC20140401_DG/Documents/ICCA%20Anesthesia%20brochure.pdf
6. Philips, ICCA "End to end solution for anesthesia information management" brochure (Aug 2021): https://www.documents.philips.com/assets/20170523/228759946b2240cf9df1a77c01611920.pdf
7. Philips, ICCA perioperative brochure "Elevating perioperative care" (Mar 2024): https://www.documents.philips.com/assets/20240328/5ef867e13382411db967b141012f93d2.pdf
8. Philips, ICCA critical care brochure "Electronic documentation for your acute patients" (Aug 2021): https://www.documents.philips.com/assets/20170523/c7433a2a2a0740b285fca77c01611ac2.pdf
9. Philips, ICCA critical care brochure "Enabling high-acuity care" (Mar 2024): https://www.documents.philips.com/assets/20240328/1f29e4ae828e40078b61b141013de55f.pdf ; German edition (Jun 2024): https://www.documents.philips.com/assets/20240624/6a99de3569a74e53a067b199007a820b.pdf
10. Philips, ICCA Russian-language brochure (Mar 2008; scores, phrase builder, PACS launch, HL7 2.3/2.4, CCOW, ODBC, Citrix, clustering, config editor): https://www.philips.com/c-dam/b2bhc/master/healthcare/room-layout/mri/ICCA.pdf
11. Philips, Vienna General Hospital / Asklepios Wiesbaden ICCA customer story (May 2014): https://images.philips.com/is/content/PhilipsConsumer/Campaigns/HC20140401_DG/Documents/Wien%20ICCA%20customer%20story.pdf
12. Philips, interview with Dr K. Jáksó, University of Pécs ICU (ICCA PDMS since 2015): https://www.philips.com/c-dam/b2bhc/ro/sites/ICCA_pdf_eng.pdf
13. US FDA 510(k) database, K151366 "CS770 IntelliSpace Critical Care and Anesthesia" (cleared 30 Oct 2015): https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?id=K151366
14. Capsule (Philips), ICCA page ("data integration requires a data acquisition platform"; Capsule Surveillance listed separately): https://capsuletech.com/icca
15. Philips press release, Capsule MDIP device-integration milestone (28 Oct 2021): https://www.philips.com/a-w/about/news/archive/standard/news/press/2021/20211028-philips-capsule-medical-device-information-platform-reaches-device-integration-milestone.html
16. Philips, IntelliBridge EC10 product page: https://www.philips.pt/healthcare/product/HCNOCTN429/intellibridge-ec10-medical-device-interfacing-module ; FDA K082583 (EC10/EC5 modules): https://www.accessdata.fda.gov/cdrh_docs/pdf8/K082583.pdf
17. Philips Thailand, IntelliBridge System: https://www.philips.co.th/healthcare/product/HCNOCTN333/intellibridge-system
18. Philips, IntelliVue Information Center iX brochure (full disclosure, alarm audit): https://www.documents.philips.com/assets/20170523/d4231d64c445479da2f6a77c0154054d.pdf ; "A new era in centralized patient monitoring" (PIC iX): https://www.usa.philips.com/healthcare/article/a-new-era-in-centralized-patient-monitoring (read via search summaries only; not opened directly)
19. Philips, IntelliSpace Perinatal product page: https://www.philips.no/healthcare/product/HCNOCTN177
20. iF Design Award, "IntelliSpace Critical Care & Anesthesia Anywhere": https://ifdesign.com/en/winner-ranking/project/intellispace-critical-care-anesthesia-anywhere/201289
21. Bangkokbiznews, interview with Philips Thailand MD (about 2023): https://www.bangkokbiznews.com/health/public-health/1073363
22. IntuitionLabs, Philips IntelliSpace Critical Care overview (third-party): https://intuitionlabs.ai/software/intensive-care-critical-care/critical-care-documentation/philips-intellispace-critical-care
23. Bidstats (aggregator), NHS Greater Glasgow & Clyde "Carevue ICU System Support and Maintenance" award, Jun 2022 (OJEU 336863-2022): https://bidstats.uk/tenders/2022/W25/777256965
24. UK Find a Tender, NHS Grampian contract award "Philips hardware & software for ICCA" (Aug 2026): https://www.find-tender.service.gov.uk/procurement/ocds-h6vhtk-06ef0e
25. Bidstats (aggregator), "ICCA Software Licenses BCH" (Belfast, 2021): https://bidstats.uk/tenders/2021/W06/744816888
26. Philips customer story, Mandaya Royal Hospital Puri (ICCA in a multi-year Philips deal): https://www.documents.philips.com/assets/20220607/e5b4957d0f444b838cfaaead0158b87f.pdf
27. Bourdeaux C. et al., "Impact of a computerized decision support tool deployed in two intensive care units on acute kidney injury progression…", Critical Care 2020;24:656 (cited by Philips in [8]): https://doi.org/10.1186/s13054-020-03343-1
28. ClinicalTrials.gov NCT02185521, Hemodynamic Instability Index (Philips): https://clinicaltrials.gov/study/NCT02185521
29. Philips, IntelliBridge Enterprise Release B.18 technical data sheet (ICCA compatibility, per-bed connection licences): https://www.documents.philips.com/assets/20221212/bc88e09cf1bf4d3b8ea5af6900d099d7.pdf
30. FLORA internal competitor profile: [../philips-icca-xovic.md](../philips-icca-xovic.md). It records that no Thai TOR, ราคากลาง or e-GP notice naming ICCA was found; Thai web searches for this checklist ("ระบบสารสนเทศผู้ป่วยวิกฤต", "Clinical Information System ICU TOR") also found none
