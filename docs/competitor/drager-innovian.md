# Competitor: Dräger Innovian

Research date: 13 October 2026. Every web-sourced claim has a numbered source in [Sources](#sources).
Labels used in this file:
- **[INTERNAL]**: taken from FLORA's own repo documents (not public; do not use in customer-facing material without approval).
- **[UNVERIFIED]**: our inference or something we could not confirm from a public source.

---

## 1. Summary

| Item | Finding |
| --- | --- |
| Product | Innovian Anesthesia (AIMS), Innovian Critical Care (ICU PDMS), sold together as the Innovian Solution Suite, plus Innovian IQ and Anesthesia Analytics reporting add-ons [1][3][5][6][7] |
| Vendor | Drägerwerk AG & Co. KGaA (Lübeck, Germany). The Thai subsidiary is Draeger Medical (Thailand) Ltd. [8][9][10] |
| Latest version found | Innovian Anesthesia **V9.0** on Dräger's US product page; we could not find its release date [1] |
| Lifecycle | **No public end-of-life notice for the Innovian product line as a whole.** Old versions have been retired one at a time: Dräger set **Innovian Anesthesia 6.x to EOL on 31 Dec 2022** and offered support customers a v8.0 licence at no charge, with professional services and hardware/OS/SQL upgrades billed separately [12]. The US VA lists 8.0.x as the only version "Authorized w/ Constraints" and puts 7.0 on "Divest" [13] |
| Market focus | Public material is almost all US-focused (VA/DoD, US hospitals) [11][13][14]. Dräger says Innovian runs in more than 130 hospitals with more than 3,000 users worldwide [2]. We found **no public Asian or Thai reference site** |
| Dräger's direction | Device interoperability (ISO/IEEE 11073 SDC, the Interoperability Suite, converters) plus partnerships with third-party clinical IT vendors. In Europe it partners with Bow Medical (DIANE AIMS) and Better Care, and it has done SDC demos with Epic [15][16]. In German-speaking markets its ICU PDMS is ICM (Integrated Care Manager), not Innovian [17][18] |
| Thai reference | **[INTERNAL]** KCMH (King Chulalongkorn Memorial Hospital) runs Innovian as a legacy production system. Public confirmation: none found |
| Thai pricing | None found in e-GP or in hospital procurement portals |

---

## 2. Vendor and distributor profile in Thailand

- **Draeger Medical (Thailand) Ltd.** (registered name Draeger Medical (Thailand) Company Limited / บริษัท ดรายเออร์ เมดิคอล (ประเทศไทย) จำกัด; check the Thai spelling with DBD) is Dräger's own subsidiary, not a third-party distributor.
  - Current contact page address: 111 True Digital Park West, Unicorn Building, 9th floor, Sukhumvit Road, Bangchak, Phra Khanong, Bangkok 10260. Phone +66 2095 2100-3 [9].
  - An older Dräger news page gives a former address at Ample Tower, Bangna [10].
  - The LEI registry lists it as a Thai private limited company and shows a 2024 record change [19].
  - Its sister company Draeger Safety (Thailand) Ltd. handles gas detection and safety equipment, not clinical IT [9].
  - Dräger's Southeast Asia site lists subsidiaries in Singapore, Malaysia, Indonesia, Thailand, Vietnam, the Philippines and Myanmar [20].
- **Local business focus:** a 2020 NIMT visit report describes the Thai entity as manufacturing and distributing anaesthetic machines [21]. Dräger Thailand's public pages put hardware first: anesthesia workstations, ventilators, Infinity monitoring and neonatal care [8]. **[UNVERIFIED]** We found no Thai-language Innovian marketing page, which suggests Innovian is not actively promoted in Thailand.
- **Meditop Co., Ltd. [INTERNAL + partly public]:**
  - FLORA's internal Innovian-to-EPHIS PDF project scope names Meditop as the *customer* for the KCMH Innovian PDF utility. That implies Meditop has a service or contract role around Innovian at KCMH.
  - Public sources describe Meditop as a large Bangkok medical device distributor: founded 1985, about 439 staff, THB 20 M registered capital [22].
  - **[UNVERIFIED]** We found no public source naming Meditop as an authorised Dräger or Innovian distributor or service partner [22][23]. Confirm with the KCMH IT and anesthesia departments before stating it.

---

## 3. Product capabilities

### Innovian Anesthesia (AIMS)
- A continuous, paperless anesthesia record from pre-op assessment through intra-op to PACU [1][3][11].
- Captures data automatically from monitors, anesthesia machines and other devices. Its open architecture interfaces with other device vendors, and it can exchange HL7 data with the HIS and other systems [3][11].
- Built on Microsoft .NET and Microsoft SQL Server, with a web API layer [3][11]. **[INTERNAL]** At KCMH it runs as Innovian Server VM, Web Application and SQL Server databases, fed through the Dräger Infinity Gateway and Capsule/Xnet DataCaptor.
- Earlier versions added these capabilities: required fields, timestamps and e-signatures (v4.0, 2011) [24], a remote/mobile report viewer (v4.1) [25], and US ONC EHR certification [26].
- V9.0 adds a lab "fishbone" panel with trends, customizable toolbars, post-anesthesia evaluation notes, and badge login for the VA only [1].
- Reporting add-ons:
  - **Innovian IQ** and **Innovian Anesthesia Analytics** come with 32 pre-configured reports [5][6].
  - A 2018 partnership with Cognitive Medical Systems added quality-measure decision support [27].

### Innovian Critical Care (ICU)
- Replaces most paper ICU charts and care plans. It charts device parameters automatically and covers labs, fluid balance, scoring and printable reports. It can view the patient's anesthesia record [4].
- Dräger launched it in 2007 as part of the web-based **Innovian Solution Suite**, a single platform for perioperative and critical care [7].
- **[UNVERIFIED]** We found no recent (post-2015) collateral for Innovian Critical Care. In Europe, Dräger's current ICU PDMS is **ICM**, whose v14 release in 2022 added FHIR [17][18]. Innovian Critical Care therefore looks like a maintenance-mode product outside North America.

### Integration with the Dräger ecosystem
- Innovian is tightly integrated with Dräger monitoring (Infinity), ventilation and anesthesia workstations [7].
- Dräger's newer connectivity products use **ISO/IEEE 11073 SDC**:
  - the Interoperability Suite, with HL7v2 IHE output and high-resolution streaming;
  - the Infinity Converter Service;
  - the CC300 converter for therapy devices [15][28].

---

## 4. Current status, end of life and successor

| Evidence | What it says | Source |
| --- | --- | --- |
| Dräger letter to VA customers (Nov 2020) | Innovian Anesthesia 6.x EOL on **31 Dec 2022**. Customers under a support contract get a v8.0 licence at no charge. **Professional services fees apply**, and hardware/OS/SQL must be re-validated | [12] |
| VA Technical Reference Model (decision 20 Nov 2025) | Release dates: 6.0 in 2014, 6.1 in 2015, 7.0 in 2017, 8.0.x in 2020 (8.0 SP1 in Jul 2022). 6.x and 7.0 are unauthorized or divest. 8.0.x is authorized with constraints through 2027. FIPS 140-2 status could not be verified | [13] |
| Dräger US product page | Still marketed; current version **V9.0** | [1] |
| Dräger Benelux page | Still listed, claiming more than 130 hospitals and more than 3,000 users | [2] |
| Search for a product-line EOL or successor | **Nothing found.** No public statement names a successor | — |

**Interpretation [UNVERIFIED]:**
- Innovian is a mature product that still gets updates, but its centre of gravity is the US, especially the federal VA/DoD market [11][14].
- Dräger's strategic investment is going into device connectivity (SDC) and partner ecosystems, not into growing its own AIMS/PDMS outside North America. In Europe it sells ICM for the ICU and partners with Bow Medical DIANE for anesthesia [15][16][17].
- For a Thai site on an older version (6.x or 7.x), the practical choice is one of the following:
  - a paid upgrade to 8.x/9.x, with new server OS, SQL licences and professional services, following the VA pattern [12];
  - staying on unsupported software;
  - replacing it.
- **Ask KCMH [INTERNAL follow-up]:**
  - Which Innovian version and Windows/SQL Server versions are in production?
  - Is there an active Dräger support contract?
  - Who provides local first-line support (Dräger Thailand, Meditop or in-house)?

---

## 5. Thai reference sites

| Site | Product | Evidence | Status |
| --- | --- | --- | --- |
| King Chulalongkorn Memorial Hospital (KCMH), Thai Red Cross / Chulalongkorn University | Innovian Anesthesia (anesthesia record, PACU, checklists, PAIN forms), using the Infinity Gateway and Capsule/Xnet | **[INTERNAL]** `docs/HANDOFF-INNOVIAN.md`, `INNOVIAN-FORM-COVERAGE.md`, `INNOVIAN-PDF-REPORT-READINESS.md` | Legacy production. FLORA/Anora already holds a 2024-2026 archive copy (about 5,529 cases and about 14,964 forms) |
| Any other Thai hospital | — | Searches in English and Thai (Innovian โรงพยาบาล, วิสัญญี, e-GP) found nothing | **No public reference found** |

At KCMH, PDF reports from Innovian are moved to ePHIS (the hospital's document/EMR system) through file-share workflows. A separate utility project exists just to fix PDF naming, multi-case days and delivery **[INTERNAL]**. This is direct evidence that the Innovian-to-HIS integration at KCMH is weak.

---

## 6. Pricing and tender values

- **No Thai public tender or ราคากลาง (reference price) for Innovian was found.**
  - Searches covered e-GP (gprocurement.go.th), university hospital procurement portals (KKU/Srinagarind, Siriraj Piyamaharajkarun) and Thai keywords such as ระบบบันทึกข้อมูลทางวิสัญญี and Anesthesia Information Management System. None returned an Innovian item [29][30].
  - **[UNVERIFIED]** KCMH is under the Thai Red Cross Society, which does not necessarily publish through e-GP. That may explain why we found nothing.
- **Cost structure (from US evidence):**
  - per-licence software;
  - professional services for implementation and every major upgrade;
  - an annual support contract with tiers. The "Basic plus Proactive Maintenance" tier includes 24x7 phone support, remote login, backups, HL7 interface monitoring and SQL health checks [12];
  - Windows Server and SQL Server licences and hardware, paid separately.
- **Next steps:**
  1. Search e-GP manually for "Innovian", "ดรายเออร์", "วิสัญญี" + "ซอฟต์แวร์" for fiscal years 2560-2569.
  2. Ask KCMH procurement for the original contract value and the annual MA (บำรุงรักษา) cost.

---

## 7. Strengths and weaknesses (from FLORA's point of view)

### Strengths of Innovian
- Global brand. Dräger is a leader in anesthesia workstations and ventilation, and anesthesiologists trust it [8].
- Mature AIMS with US EHR certification and a long VA/DoD track record [11][13][26].
- Deep native integration with Dräger anesthesia machines and Infinity monitors [7]. This matters wherever Dräger hardware is the OR standard.
- Built-in analytics (Innovian IQ, 32 reports) [5][6].
- An incumbent at a flagship tier-1 Thai teaching hospital (KCMH) **[INTERNAL]**. Clinicians already know the workflow and the printed record.

### Weaknesses and risks
- **Lifecycle and upgrade burden:**
  - Each major version change has needed paid services plus OS/SQL/hardware refreshes [12].
  - Older versions are being retired: 6.x reached EOL in 2022 and 7.0 is on divest in the VA [12][13].
- **Legacy stack:** .NET plus Microsoft SQL Server on Windows, with per-core SQL licensing and Windows server patching [3][11]. The VA could not verify FIPS 140-2 status [13].
- **US-centric roadmap:**
  - New features target VA needs, such as VA-only badge login [1].
  - No Thai-language UI or Thai HIS integration pattern is evident **[UNVERIFIED]**.
- **Weak local HIS/document integration [INTERNAL]:** at KCMH the hand-off to ePHIS is a PDF/file-share process that needed a separate custom utility.
- **Vendor-dependent configuration:** forms and reports are vendor- or service-configured **[UNVERIFIED for Thai sites]**. The KCMH archive holds seven flat form families, which FLORA's analysis found unsuited to task-oriented workflow **[INTERNAL]**.
- **Device integration:** connections to non-Dräger devices need an extra gateway layer. At KCMH this is Capsule/Xnet DataCaptor, a Philips product, which adds a second vendor dependency **[INTERNAL]**.
- **ICU side:** Innovian Critical Care appears to be in maintenance mode outside North America **[UNVERIFIED]** [4][17].
- **Local presence:** the Thai subsidiary is hardware-focused, and we found no public Thai Innovian team or marketing [8][21] **[UNVERIFIED]**.

---

## 8. Migration opportunity for FLORA

### Tier 1 (large university / MOPH regional hospitals; KCMH-type sites)
- **Opportunity:** high, but the bar is high.
  - Tier-1 sites with Innovian face a paid upgrade cycle and a Windows/SQL refresh.
  - FLORA can present itself as the *replacement*, with lower lifecycle cost and a Thai UI.
- **Proof point:** the KCMH archive work **[INTERNAL]**.
  - The full 2024-2026 Innovian data is imported into the Anora PostgreSQL archive, about 2.47 M flowsheet observations and 2.66 M form cells.
  - It follows a no-data-loss contract and preserves provenance (`native` / `derived` / `read_only_legacy` / `unmapped`).
  - Data migration and keeping the archive readable are the two main barriers to switching, and the archive work addresses both.
- **Must-haves before claiming replacement:**
  1. **Innovian archive parity:** an exact-PDF anesthesia/PACU packet that passes the 8 clinical acceptance gates in `INNOVIAN-PDF-REPORT-READINESS.md` **[INTERNAL]**. Until then, call it a "review draft".
  2. **Coexistence with Dräger hardware:**
     - The Gateway reads Infinity Gateway / Dräger workstation data, and ideally SDC.
     - Talking points: "keep your Dräger machines, replace the software", and "no Capsule dependency".
  3. **HIS / ePHIS integration:** native structured push instead of PDF file drops.
  4. **ICU coverage in the same platform:** Canopy + Leaf for ICU, replacing Innovian Critical Care or paper.
- **Positioning:**
  - Hospital self-authoring (Form/Report/Workflow Studio) removes vendor change-request cycles.
  - Thai language throughout.
  - Local support.
  - PostgreSQL / open stack with no SQL Server licences.
  - Vendor-neutral Gateway.

### Tier 2 (smaller provincial / private hospitals)
- **Opportunity:** greenfield rather than replacement. **[UNVERIFIED]** We found no evidence of Innovian at tier-2 Thai sites.
- Innovian's cost structure (licences, professional services, SQL/Windows and support tiers) [12] and its lack of Thai localization make it an unlikely tier-2 competitor.
- The more realistic tier-2 competitors are monitor-vendor central stations (Mindray, Nihon Kohden) and HIS OR/ICU modules (see `README.md`).
- **Where Dräger does show up:** Dräger hardware is common in Thai ORs and ICUs.
  - FLORA should make sure Gateway drivers cover Dräger anesthesia workstations (Atlan/Perseus/Primus/Fabius) and Infinity monitors.
  - The pitch is "your Dräger devices, charted automatically, without Innovian".

### Suggested battlecard lines
- "Innovian is a US-centred product; Dräger's own European strategy partners with third-party AIMS vendors such as Bow Medical DIANE [16]. FLORA is built for Thai hospitals."
- "Every Innovian major upgrade means professional services plus Windows/SQL refresh [12]. FLORA ships Root-signed releases that the hospital approves and applies itself."
- "We already read your Innovian history; nothing is lost [INTERNAL – use only with KCMH consent]."

---

## 9. Open questions

1. KCMH Innovian version, support-contract status and annual MA value. Who is the local service provider: Dräger Thailand or Meditop?
2. Are there other Thai Innovian sites (ask Dräger Thailand or anesthesia society contacts)? Are any Thai hospitals running Dräger ICM?
3. Has Dräger made any formal end-of-sale announcement for Innovian in APAC (ask a regional Dräger contact)?
4. e-GP / Thai Red Cross procurement history for the original KCMH purchase.

---

## Sources

1. Dräger US, Innovian Anesthesia Information Management System (V9.0 features): https://www.draeger.com/en-us_us/Hospital/Operating-Room/Innovian
2. Dräger Belgium (NL), Innovian Anaesthesia (more than 130 hospitals, more than 3,000 users): https://www.draeger.com/nl_be/Products/Innovian-Anaesthesia
3. Dräger, Innovian Anesthesia brochure D-43681-2021: https://www.draeger.com/Content/Documents/Products/innovian-anesthesia-br-9066712-us.pdf
4. Dräger, Innovian Critical Care data sheet: https://www.draeger.com/Content/Documents/Products/innovian-critical-care_ds_9051617_en.pdf
5. Dräger, Innovian IQ: https://www.draeger.com/en-us_us/Hospital/Operating-Room/Innovian/IQ
6. Dräger, Innovian Anesthesia Analytics brochure: https://www.draeger.com/Content/Documents/Products/innovian-anesthesia-analytics-br-9051628-en-us.pdf
7. Dräger, Infinity Acute Care System (Innovian Solution Suite description): https://www.draeger.com/en-us_ca/Products/Infinity-Acute-Care-System ; launch news: https://respiratory-therapy.com/department-management/clinical/draeger-medical-launches-web-based-information-management-solution/
8. Dräger Thailand home: https://www.draeger.com/th_th/Home
9. Dräger Thailand contact: https://www.draeger.com/th_th/Contact
10. Dräger Thailand news (older address): https://www.draeger.com/th_th/Home/Draeger-Thailand-News
11. Dräger Innovian capability statement (US federal): https://www.draeger.com/Content/Documents/Content/cap-statement-innovian-DMC-101214-us-2205-7.pdf
12. Dräger letter to VA customers, Innovian Anesthesia 6.x EOL 31 Dec 2022: https://www.oit.va.gov/Services/TRM/files/EOL_Letter_IA_6_V5_11_20_20_Final_Approved.pdf
13. US VA Technical Reference Model, Innovian entry: https://www.oit.va.gov/Services/TRM/ToolPage.aspx?tid=7755
14. Dräger US Federal Government solutions: https://www.draeger.com/en-us_us/Hospital/Federal-Government
15. Dräger Interoperability Suite: https://www.draeger.com/en_uk/Products/Interoperability-Suite ; Medical Device Interoperability: https://www.draeger.com/en_seeur/Hospital/Medical-Device-Interoperability
16. Dräger Clinical IT Partners (Bow Medical DIANE, Better Care): https://www.draeger.com/en_neeur/Hospital/Clinical-IT-Collaboration
17. Dräger Germany, Integrated Care Manager (ICM): https://www.draeger.com/de_de/Products/Integrated-Care-Manager-ICM
18. Dräger newsroom, ICM 14 PDMS extension (2022): https://www.draeger.com/de_de/Newsroom/about-draeger/PDMS-extension-maintenance-process-digital-throughout-Document
19. Bloomberg LEI record, Draeger Medical (Thailand): https://lei.bloomberg.com/leis/view/5299001HXI9XZIBGGU19
20. Dräger Southeast Asia locations: https://www.draeger.com/en_sea/Locations
21. NIMT visit report mentioning Draeger Medical (Thailand): https://en.nimt.or.th/?p=4988
22. Kyushu METI event profile listing Meditop Co., Ltd.: https://www.kyushu.meti.go.jp/event/2402/240209_1_4.pdf
23. GlobalData, Meditop Co Ltd company review: https://app.researchpool.com/provider/globaldata-plc/meditop-co-ltd-company-review
24. HealthExec, Draeger releases Innovian Anesthesia 4.0: https://healthexec.com/topics/healthcare-management/healthcare-economics/draeger-releases-innovian-anesthesia-40
25. MedWrench, Innovian Anesthesia 4.1 with remote access: https://www.medwrench.com/article/30194/dr-ger-introduces-innovian-anesthesia-4-1-with-remote-access-option
26. Becker's ASC, Innovian EHR technology certification: https://www.beckersasc.com/uncategorized/draeger-medicals-innovian-anesthesia-solution-receives-ehr-technology-certification/
27. Cognitive Medical Systems and Dräger (2018): https://cognitivemedicalsystems.com/company/news/cognitive-medical-systems-teams-up-with-drager-to-streamline-quality-measure-adherence-in-perioperative-care/
28. Dräger SEA Hospital Digital Solutions (connectivity): https://www.draeger.com/en_sea/Productfinder/Hospital-Digital-Solutions
29. KKU / Srinagarind procurement announcements (searched; no AIMS item): https://procurement.kku.ac.th/view/63304062/3
30. Thai e-GP portal (manual search still required): https://www.gprocurement.go.th

Internal (not public): `docs/HANDOFF-INNOVIAN.md`, `docs/INNOVIAN-FORM-COVERAGE.md`, `docs/INNOVIAN-PDF-REPORT-READINESS.md`, `docs/Innovian-EPHIS-PDF-Management-*.md`.

Note: draeger.com blocked automated page fetches (HTTP 403) during this research. Claims citing Dräger pages come from search-result snippets of those pages. Re-check them in a browser before external use.
