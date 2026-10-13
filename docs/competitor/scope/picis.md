# System scope: Picis suite: Anesthesia Manager, Critical Care Manager, OR/PACU/Preop Manager, PicisPrima, Device Hub, Envision (Picis Clinical Solutions / N. Harris Computer Corp., Constellation Software; Thai seller CIS Imaging)

> Research date: 2026-10-13. Public desk research only. Company and channel background is in
> `../picis-cis-imaging.md` and is not repeated here. Most sources are vendor marketing pages. They
> show what Picis *claims*, not what a Thai deployment actually delivers. Sources [15] and [16] are
> third-party and lower confidence: [15] is AI-generated and [16] contains template placeholder text.
> They are used only as secondary support and marked as such.

Legend per item: ✅ supported (cite) · ◐ partial / add-on / needs extra product (say which) · ❌ not offered · ? not found publicly. Cite a source [n] on every ✅/◐/❌.

## A. Clinical workflow coverage
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| A1 | Pre-anesthesia assessment / pre-op evaluation | ✅ | **Preop Manager**: structured pre-admission assessments, history/physical, configurable anesthesia risk forms, surgery-specific questionnaires. Anesthesia Manager also builds the anesthetic assessment. | [6][2] |
| A2 | Consent / pre-op checklist | ✅ | Preop Manager captures signed consents and readiness status. "Smart checklists" flag missing items before the day of surgery. | [6] |
| A3 | WHO surgical safety checklist (sign-in/time-out/sign-out) | ? | Configurable pre-op checklists and compliance alerts exist [6][7], but no public page names a WHO checklist, time-out, or sign-out. It could likely be built as a form; not confirmed. | |
| A4 | Intra-op anesthesia record — auto vitals capture | ✅ | Anesthesia Manager collects data automatically from monitors and other devices. PicisPrima (iPad) receives monitor/ventilator data too. | [2][14][11] |
| A5 | Intra-op — drugs, fluids, blood, gases, events, airway | ✅ (drugs/fluids/events) · ? (blood/airway/gases itemised) | Meds, fluids and events are documented quickly, and printouts include medications and IV fluids. Billing/clinical milestones (anesthesia start/ready). Blood products, airway and anesthetic gases are not itemised in public material. | [14][2][11] |
| A6 | Anesthesia machine / ventilator parameter capture | ✅ | Driver library covers anesthesia machines and ventilators. | [2][14][10] |
| A7 | PACU / recovery (Aldrete, discharge criteria) | ✅ | **PACU Manager**: "standard scores and assessment findings", care-documentation prompting, monitor/vent/pump capture, hand-off summary views. Aldrete and discharge criteria are not named specifically. | [5] |
| A8 | Post-op anesthesia visit / pain service | ◐ | Anesthesia Manager covers "postoperative care" [2]. PACU Manager correlates pain scores with meds and physiology [5]. No dedicated post-op visit or acute-pain-service module found. | [2][5] |
| A9 | ICU flowsheet / vital charting | ✅ | **Critical Care Manager (CCM)**: adult, paediatric and neonatal ICU. Device capture of "thousands of data points", graphical trends, one-screen workflow, remote chart view. | [3][8] |
| A10 | ICU nursing assessment, care plan, nursing notes | ◐ | Structured documentation for the ICU team, configurable forms/templates, "hospital-defined order sets or protocols", "editable best practice workflows". Nursing assessment and care plan are not itemised publicly. | [3][15] |
| A11 | Medication orders / MAR / infusion management | ◐ | Infusion: direct IV-pump connection with up-to-the-minute fluid balance [3]. Order sets/protocols [3]. A MAR or CPOE is **not named** on any Picis page [8]. Medication orders presumably come from HIS/pharmacy (unconfirmed). | [3][8] |
| A12 | Fluid balance (I/O) | ✅ | "Advanced fluid management" with automatic I/O totals. NICU precision to 0.01 mL. | [3][15] |
| A13 | ICU scoring (APACHE, SOFA, GCS, etc.) | ? | No public mention of APACHE, SOFA, SAPS or GCS calculators. Only a **Sepsis Screening add-on** (user-defined risk-factor fields with prompts) [8]. | |
| A14 | Physician notes / progress notes | ✅ | CCM: physician notes, progress notes, admission and discharge summaries. | [3][15] |
| A15 | Lab / imaging results view | ◐ | Lab system data is imported into AM, PACU and CCM [3][5][14]. Imaging/PACS viewing is not mentioned. | [3][5][14] |
| A16 | Shift handover / transfer summary | ✅ | CCM quick patient summaries for shift change and transfer [3]. PACU hand-off summary views [5]. | [3][5] |
| A17 | General ward / IPD charting | ❌ | Picis positions itself only on "life-critical" areas (ED, OR, ICU) [14]. The product list has no ward/IPD module [1]. | [1][14] |
| A18 | ER / labour room / other areas | ◐ | **ED**: ED PulseCheck EDIS (web-based tracking, physician/nurse documentation, orders, charges; InSight ED rules engine) [21][22][23]. It is now branded "Harris PulseCheck" and is still listed on picis.com [1] (see note 2). **Ambulatory surgery**: Experior ASC [1]. Labour room/obstetrics: not found. | [1][21][22][23] |

## B. OR / perioperative management
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| B1 | OR scheduling / booking | ✅ | **OR Manager**: block scheduling and utilisation, conflict flagging, booking queue, multi-facility, historical case-duration estimates, Physician Office Link [4][7]. **SmartRequest**: web booking-request portal [13]. **PriorityQ**: surgical prioritisation (listed only, no detail) [1]. | [4][7][13][1] |
| B2 | OR status board / case tracking | ✅ | **SmarTrack Next**: web OR timeline view, configurable digital displays replacing whiteboards, auto-updates from charted events, family notifications by SMS/email and portal, surgeon mobile app with push. No RTLS. | [12][7] |
| B3 | Staff / resource management | ✅ | OR Manager resource management [7]. SmarTrack drag-and-drop staff-to-room assignment [12]. Staff rostering/HR is not described. | [7][12] |
| B4 | Supplies, implants, charge capture / billing | ✅ | OR Manager: surgeon/procedure preference cards, implant/tissue tracking with recall lookup, real-time supply costing, waste reporting, costs appended to the record [4]. Anesthesia professional-fee billing output via HL7 (optional) [14]. US-payer oriented. | [4][14][16] |

## C. Medical device integration
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| C1 | Own device gateway / middleware (name) | ✅ | **Picis Device Hub**: vendor-neutral, runs on mini-PC, ARM, VM (VMware/Hyper-V), tablets or anesthesia machines. Serial, Ethernet, USB. Wi-Fi mini-PC option. Web "Picis Portal" for driver and mini-PC management. Bed reassignment without reconfiguration. "No third-party device integration needed" [2]. | [10][2] |
| C2 | Multi-brand support (number of drivers / brands) | ✅ | "Over 420 device drivers" [2] and "450+" devices [10] (picis.com is inconsistent). The older CCM claim is 400+ [8]. **No public brand/model list.** Ask for the list against the hospital's installed base. | [2][10][8] |
| C3 | Monitors, anesthesia machines, ventilators, pumps | ✅ | All four classes are named. CCM also lists specialty CVICU devices: IABP and VAD. | [2][3] |
| C4 | Waveform / high-resolution data | ◐ | **Waveforms add-on**: tagged snapshots of up to 5 minutes (e.g. ECG) saved to the chart. Requires Anesthesia Manager 8.6 MR6+. No continuous high-resolution waveform storage claimed. Device Hub sends "near real-time snapshots". | [8][3][10] |
| C5 | Alarm management / surveillance | ❌ | FDA describes the CareSuite AM/PACU/CCM family as a **"non-alarming"** patient information system [17]. There is no device-alarm management. Clinical surveillance is limited to protocol prompts (sepsis screening) [8]. | [17][8] |

## D. HIS / interoperability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| D1 | HL7 v2 (ADT, orders, results) | ✅ | Device Hub sends data to EMR/HIS via HL7 [10]. PicisPrima integrates with EMR via HL7 [11]. Professional-fee billing via HL7 [14]. Data in from HIS and lab [14][5]. **Published message-type list (ADT/ORM/ORU) not found.** | [10][11][14][5] |
| D2 | FHIR | ? | No mention of FHIR on any Picis page or in news (searched 2024-2026). | |
| D3 | Document/PDF export to HIS | ? | Customisable printouts [2]. Envision report export to Excel/PDF [9]. Pushing a document/PDF to the HIS is not described. | |
| D4 | Thai HIS experience (HOSxP, in-house HIS, etc.) | ? | No Thai site, HIS interface or reference found (see `../picis-cis-imaging.md` §3). Asian distribution on FDA records lists Malaysia and Singapore, not Thailand [17]. | |

## E. Clinical decision support & analytics
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| E1 | Alerts / rules / care bundles | ✅ | "Advanced decision support" in AM [14]. Guidelines are brought into charting [2]. CCM proactive care-compliance tracking and notifications [3]. **Sepsis Screening add-on** [8]. Reseller lists "user-defined rules, automated notifications" [16]. | [14][2][3][8][16] |
| E2 | Drug interaction / dosing checks | ? | Not mentioned in any public Picis material. | |
| E3 | Dashboards / quality indicators / reports | ✅ | **Envision Analytics** (built on Microsoft Power BI): prebuilt dashboards for volumes, delays, cancellations, cost per case, PACU quality and safety, and ICU VAP/CAUTI/CLABSI compliance. Mobile app [9][7]. Legacy **Quality Reporting Portal**: regulatory measures (US SCIP/PQRI/MU) exported to Excel [14]. Measures are US-centric. | [9][7][14] |
| E4 | Research / data export | ◐ | Excel/PDF export from Envision [9]. Quality Reporting Portal Excel extracts [14]. Device Hub data export via Portal [10]. Standard AQI report extract [16]. No dedicated research/data-warehouse export product found. | [9][14][10][16] |
| E5 | AI features | ◐ | Only natural-language "typed or verbal" querying in Envision (Power BI feature) [9]. No AI on PicisPrima [11]. No predictive or generative AI claimed anywhere. | [9][11] |

## F. Configurability
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| F1 | Form builder (who does it: hospital vs vendor) | ✅ | Templates per department, modifiable forms, re-usable form sections, "forms builder" for printouts [14][2]. Shipped with the **Content Library** of predefined dictionary content [14]. Picis "clinician-developers" do customisation and configuration during implementation [7]. Hospital self-service is possible, but the tool name and skill level required are not public. | [14][2][7] |
| F2 | Report builder | ◐ | Envision ships prebuilt reports with drill-down and filters on a Power BI base [9]. No end-user report-builder is advertised. Custom reports likely need Power BI skills or Picis services (unconfirmed). | [9] |
| F3 | Workflow / rule configuration | ✅ | "Editable best practice workflows", hospital-defined order sets and protocols [3]. Sepsis add-on has user-defined risk-factor fields [8]. Reseller lists user-defined rules [16]. | [3][8][16] |

## G. Technical
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| G1 | Architecture, OS, database | ? | Core server OS, database and client technology are **not published**. Known pieces: Device Hub runs on mini-PC/ARM/VM with a web Portal [10]. PicisPrima is an iPad client that needs a constant server connection [11]. SmartRequest is web-based with no VPN/Citrix needed [13]. FDA describes the suite as running on "commonly available hardware" [17]. Current release lineage is 8.6 [8][24]. | |
| G2 | Deployment: on-prem / cloud / hybrid | ? | Hosting of the core suite is not stated. Device Hub alone can run local, cloud or virtualised [10]. Envision connects directly to the client database [9], which suggests on-prem, but this is unconfirmed. | |
| G3 | Offline / downtime mode at bedside | ? | Core Anesthesia Manager/CCM downtime behaviour is not published. **PicisPrima explicitly does not work offline** (constant server connection required) [11]. | |
| G4 | Mobile / web access | ✅ | PicisPrima (iPad anesthesia charting) [11]. SmarTrack Next web plus surgeon mobile app [12]. Envision mobile app [9]. CCM remote chart view [3]. SmartRequest web [13]. | [11][12][9][3][13] |
| G5 | Thai language UI | ? | No evidence of a Thai UI. The product is used in Spanish at Spanish hospitals (Fuenlabrada, IB-Salut) [24][25]. Marketing sites are EN/ES/FR [2] and CIS Imaging's page is English [26]. | |
| G6 | Security / certifications (FDA, CE, ISO 13485, IEC 62304 …) | ◐ | **US FDA**: the AM/PACU/CCM family is listed under product code NSX ("unclassified", non-alarming patient information system). There were Class 2 recalls, including Z-0139-2012 for v8.2 SP4+, where the wrong patient's data was displayed [17][18]. A 1995 510(k) K950536 covers legacy "PICIS CHART+" (Barcelona) [19]. CE / ISO 13485 is claimed only by an AI-generated third-party summary [15] and is **unverified**. No IEC 62304 or Thai FDA (อย.) listing found. Audit trail and "high-level security" are claimed [3]. | [17][18][19][15][3] |

## H. Commercial
| # | Item | Status | Notes / module name | Src |
|---|---|---|---|---|
| H1 | Licensing model (per bed / site / module / subscription) | ? | Not public. A third-party summary says enterprise licence, implementation and maintenance [15] (AI-generated, unverified). Products are sold per module (separately named products and add-ons) [1][8]. | |
| H2 | Typical project components (hardware, services, support) | ✅ | Services: HealthCheck, **PASS** (annual supplemental services), Picis Assist, professional services, training [1]. Picis implements and supports directly "without third-party vendors" [7]. Device Hub mini-PCs per bed or room [10]. Add-ons (Waveforms, Sepsis) sold separately [8]. | [1][7][10][8] |
| H3 | Known price points | ? | None found (no Thai e-GP, TOR, or international list price). | |

### Notes
1. **KLAS:** the latest public figure found is Anesthesia Manager software score 80.2 against a market average of 84.1 (2016 Category Leader page) [20]. That is below average and dated.
2. **ED PulseCheck:** it was sold with Picis in the 2015 Harris deal ("perioperative management and emergency department solutions", 700+ sites) [21]. It is sold since as Harris Healthcare ED PulseCheck [22] and appears as "Harris PulseCheck" on picis.com [1]. Whether CIS Imaging offers it in Thailand is unknown.
3. **Not found on picis.com:** Orchestrator and RapidICU are listed in the site nav [1], but their pages returned no product content. Their scope is **unknown**.

## Sources
1. Picis — Home / product list (incl. Orchestrator, RapidICU, PriorityQ, Experior ASC, Harris PulseCheck, services): https://www.picis.com/
2. Picis — Anesthesia Manager: https://www.picis.com/solution/anesthesia-manager/
3. Picis — Critical Care Manager: https://www.picis.com/solution/clinical-information-system-suite/critical-care-manager/
4. Picis — OR Manager: https://picis.com/solution/perioperative-suite/or-manager/
5. Picis — PACU Manager: https://picis.com/solution/pacu-manager/
6. Picis — Preop Manager: https://picis.com/solution/preop-manager/
7. Picis — Perioperative Suite: https://picis.com/solution/perioperative-suite/
8. Picis — Clinical Information System Suite (Waveforms add-on, Sepsis Screening add-on): https://picis.com/solution/clinical-information-system-suite/
9. Picis — Envision Analytics: https://picis.com/solution/analytics-suite/
10. Picis — Device Hub: https://www.picis.com/device-hub/
11. Picis — PicisPrima: https://www.picis.com/picisprima/
12. Picis — SmarTrack Next: https://picis.com/solution/smartrack-next/
13. Picis — SmartRequest: https://www.picis.com/smartrequest/
14. Picis Anesthesia Manager product sheet (OptumInsight era, 2011, North America): https://www.anesthesiallc.com/images/brochures/product_sheet_anesthesia_manager.pdf
15. IntuitionLabs — "Picis Critical Care Manager – Software Overview" (AI-generated third-party, Nov 2025; low confidence): https://intuitionlabs.ai/software/pdfs/picis-critical-care-manager.pdf
16. i2medi (EU/LatAm reseller) — Picis Anesthesia Manager (page contains template placeholder text; low confidence): https://www.i2medi.com/en/picis-anesthesia-manager.html
17. ICIJ Medical Devices DB (FDA-derived) — CareSuite Critical Care Manager, PACU Manager and Anesthesia Manager (recalls, NSX, distribution): https://es.medicaldevices.icij.org/devices/usa-general-hospital-and-personal-use-devices-caresuite-critical-care-manager-pacu-manager-and-anesthesia-manager
18. ICIJ Medical Devices DB — Picis Anesthesia Manager (recall Z-0139-2012): https://es.medicaldevices.icij.org/devices/usa-general-hospital-and-personal-use-devices-picis-anesthesia-manager
19. FDA 510(k) K950536 — PICIS CHART+ (1995): https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=k950536
20. KLAS — 2016 Category Leader Anesthesia: https://klasresearch.com/best-in-klas-ranking/anesthesia/2016/107
21. Constellation Software — "Constellation Acquires Picis" (2015): https://www.globenewswire.com/news-release/2015/05/20/1061474/0/en/constellation-acquires-picis.html
22. BusinessWire — "Arnot Health Inc. Chooses Harris Healthcare Emergency Department Information System" (2017, ED PulseCheck): https://www.businesswire.com/news/home/20170221006139/en/Arnot-Health-Inc.-Chooses-Harris-Healthcare-Emergency-Department-Information-System
23. FierceHealthcare — "Bayonne Medical Center Modernizes Emergency Department with Picis EDIS"; HC Innovation Group — Picis/Sullivan Group InSight ED rules: https://www.fiercehealthcare.com/healthcare/bayonne-medical-center-modernizes-emergency-department-picis-edis · https://www.hcinnovationgroup.com/home/news/13014751/picis-sullivan-group-help-ed-clinicians-identify-patient-risk-reduce-errors
24. Comunidad de Madrid — Hospital de Fuenlabrada ICU, CCM/Anesthesia Manager v8.6 (first outside US): https://www.comunidad.madrid/hospital/fuenlabrada/noticia/52192
25. Digital Health — "Picis expands CareSuite in Spain" (IB-Salut, 2010): https://www.digitalhealth.net/2010/01/picis-expands-caresuite-in-spain/
26. CIS Imaging — PICIS page: https://cis-imaging.com/picis
