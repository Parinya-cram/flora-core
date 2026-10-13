# Competitor: Philips IntelliSpace Critical Care and Anesthesia (ICCA), distributed in Thailand by Xovic

Research date: 13 October 2026. Every web-sourced claim has a numbered source in [Sources](#sources).
Labels used in this file:
- **[UNVERIFIED]**: our inference, or something we could not confirm from a public source.
- **[VENDOR CLAIM]**: stated by Philips or Philips Thailand in marketing or press, not independently confirmed.
- **[INTERNAL]**: taken from FLORA's own repo documents.

---

## 1. Summary

| Item | Finding |
| --- | --- |
| Product | IntelliSpace Critical Care and Anesthesia (ICCA). Philips sells it as a Class IIb SaMD for ICU/NICU/PICU and perioperative/anesthesia care, CE-marked under EU MDR 2017/745 [1][2] |
| Lineage | Descends from HP CareVue Chart and IntelliVue Clinical Information Portfolio (ICIP) [7] |
| Positioning | A high-acuity documentation and CDS system that sits next to the hospital EMR and does not replace it [1][2] |
| Device data path | ICCA needs a separate acquisition layer: Philips PIC iX and/or Capsule MDIP (formerly Capsule Technologies, bought by Philips in 2021). IntelliBridge handles non-Philips bedside devices [1][3][4][6] |
| Thai distributor | **Xovic Co., Ltd. (บริษัท โซวิค จำกัด)**, registration no. 0105529003833, Bangkok. Philips lists it as its Thai distributor for hospital patient monitoring and EMR [9][10][11][12] |
| Thai references | Philips Thailand's managing director said in a Thai news interview (about 2023) that Chulalongkorn, Ramathibodi, Rajavithi and Bangkok Hospital use ICCA [15] **[VENDOR CLAIM]**. No hospital-side confirmation found |
| Thai pricing | **No ICCA tender, TOR or ราคากลาง found** on public web or indexed e-GP pages (see §5) |
| Lifecycle | **No end-of-sale notice found.** Philips still has live ICCA product pages, including on philips.co.th [1][2]. Philips' US "Acute care informatics" portfolio page now leads with Capsule MDIP, Capsule surveillance, analytics and telehealth, and mentions ICCA only in a history list [8]. We read that as a sign of Philips' direction, not a discontinuation **[UNVERIFIED]** |

---

## 2. Thai distributor: Xovic Co., Ltd. (บริษัท โซวิค จำกัด)

| Item | Finding | Source |
| --- | --- | --- |
| Legal name | Xovic Co., Ltd. / บริษัท โซวิค จำกัด; "Xovic Company Limited" on its website | [9][11] |
| Registration | Juristic ID 0105529003833. A third-party registry aggregator gives the registration date as 3 Feb 1986 (2529 BE) | [12][16] |
| Address | 448, 450 Phaholyothin Rd, Samsen Nai, Phayathai, Bangkok 10400 | [9][10][11] |
| Contact | Website https://www.xovic.com (xovic.co.th does not resolve). Phone 02-090-2591-4, 02-271-3737, 02-278-2166; email info@xovic.com; LINE link from the site. The site has no separate contacts page: its "Contact" link goes to the home page | [11] |
| Philips relationship | Philips' Thai distributor list names Xovic for hospital patient monitoring and EMR, plus ambulatory monitoring. Philips calls it a "long-term partner" of more than 30 years in hospital patient monitoring, established in Thailand in 1986 | [9][10] |
| Learning and Experience Center | Philips and Xovic relaunched Philips' Learning and Experience Center in Bangkok, hosted at Xovic's site (announced 22 Jul 2024). It covers bedside and transport monitors, central stations, mobile apps and "integrated care systems with clinical decision support". ICCA is not named | [10][13] |
| Other brands | In 2015 Xovic partnered with Spok (US clinical communications/paging) for Thai hospitals. The Spok release calls Xovic the "first Full Function Distributor in South East Asia for Philips Medical Systems" | [17] |
| Public-sector footprint | A 2016 Isranews investigation counted about **1,246 government contracts worth about 6.19 billion THB** (1997–2016) across 31 agencies. The biggest buyers were the MOPH Permanent Secretary's Office (642 contracts, about 1.65 bn THB) and the Army (77 contracts, about 2.24 bn THB). The article was part of a 2016 political/news controversy about the company's ownership. We cite it only for the contract volume | [14] |
| Recent e-GP example | Bang Phli Hospital (รพ.บางพลี) awarded Xovic a biphasic defibrillator with SpO2/EtCO2 for 450,000 THB by specific method (วิธีเฉพาะเจาะจง). Xovic also appears as a winning bidder at Khon Kaen University (31 May 2024) | [18][19] |
| Size (headcount, revenue) | Not found from a citable public source **[UNVERIFIED]**. Creden/DataForThai hold financials behind a login or 403 | [12][16] |

**Takeaway:** Xovic is a long-established, MOPH-connected **Philips hardware channel** (monitors, central stations, defibrillators). In public it shows almost no software or clinical-informatics identity: its website does not mention ICCA [11]. Any ICCA deal in Thailand is probably delivered with Philips Thailand / Philips APAC informatics staff **[UNVERIFIED]**.

---

## 3. Product capabilities (ICCA)

| Area | What Philips documents | Source |
| --- | --- | --- |
| ICU charting | Configurable unit-specific flowsheet with vitals, device data, labs, I/O, observations, nursing assessments and procedures. Also used for code sheets, respiratory therapy and dialysis | [1][5] |
| Anesthesia record | Anesthetic record and perioperative flowsheet; dynamic pre-anesthesia evaluation form; preop data pulled from hospital systems; intraop documentation with cost capture; OR→ICU continuity | [1][5][6b] |
| Notes and forms | Hospital-customisable notes and forms (admission, discharge, progress, preop, consults). Customisation is done by Philips or a trained hospital analyst in a configuration tool, not by clinicians **[UNVERIFIED]** | [5] |
| Orders and medication | Order management; accepts nursing, dietary and radiology orders from the HIS; infusion management with auto/manual rate, dose and volume charting; ADE checking through a third-party drug-knowledge vendor (Medical Reference module) | [5][2] |
| CDS | Calculation engine, clinical advisories, evidence-based bundles (sepsis, VAP, DVT, diabetes) | [1][3][5] |
| Reporting | Data Analysis and Reporting (DAR) module; "self-service clinical intelligence" for query and visualisation | [1][3][5] |
| Device integration | Through PIC iX / Capsule MDIP, which Philips says connects >1,000 device models in >3,000 facilities as of 2021. IntelliBridge connects third-party bedside devices. Trend upload of up to 8 h of monitor data from Philips monitors | [3][4][5] |
| HIS / HL7 | HL7 for ADT, labs, orders and results, document and patient-data export/import; microbiology and pathology import. Current pages also mention FHIR | [1][5] |
| Mobility | "ICCA Anywhere" tablet client (iF Design award). Philips Thailand says doctors can view data remotely on phone or tablet | [20][15] |
| Deployment | On-premise or hybrid, hospital-managed IT. Configuration workshops, go-live support and SLA service contracts. Pricing is custom enterprise only | [1][7] |
| Thai language | **No evidence of a Thai UI.** The philips.co.th ICCA page is English-only and says nothing about Thai localisation [2]. **[UNVERIFIED]** whether a Thai language pack exists |
| Regulatory | Class IIb SaMD, CE/EU MDR. A 2014 BfArM field corrective action exists for an older release | [1][21] |

### Philips Capsule (relevance to FLORA Gateway)
Capsule MDIP is Philips' vendor-neutral device-integration layer, acquired in 2021. It is the closest competitor to **FLORA Gateway**, and Philips sells it on its own as well as under ICCA [4][8]. The two together give a "Philips stack" story: IntelliVue monitors → PIC iX / MDIP → ICCA → HIS. Our understanding is that MDIP needs separate licences and hardware per bed or device **[UNVERIFIED]**.

### Philips direction
- No ICCA end-of-sale notice or named successor found [1][2][7].
- Philips' US acute-care-informatics page lists Capsule MDIP, Capsule surveillance, retrospective analytics and inpatient telehealth (eICU / eCareManager). ICCA appears only in a history list [8]. Philips also reports strong demand for enterprise monitoring and informatics, sold increasingly as "Enterprise Monitoring as a Service" [22].
- Philips has moved other informatics products (IntelliSpace Cardiovascular, Image Management 15) to HealthSuite cloud/SaaS. We found no cloud ICCA announcement [22b].
- Philips also bundles ICCA into large multi-year turnkey hospital deals. Example: Mandaya Royal Hospital Puri, Jakarta (350+ beds), a 7-year partnership covering imaging, IntelliBridge Enterprise, ICCA and IntelliVue Guardian, with export-credit financing [23].

---

## 4. Thai reference sites

| Hospital | Evidence | Confidence |
| --- | --- | --- |
| Chulalongkorn Hospital (KCMH) | Named by Philips Thailand's MD in Bangkokbiznews, about 2023 [15] | **[VENDOR CLAIM]**. Note: FLORA's own notes treat KCMH as a Dräger Innovian incumbent **[INTERNAL]** (`../HANDOFF-INNOVIAN.md`), so ICCA may cover only some units. Verify with the department |
| Ramathibodi Hospital | Same article [15] | **[VENDOR CLAIM]** |
| Rajavithi Hospital (MOPH) | Same article [15]. A 2022 Thai article about the Philips Foundation and Rajavithi Hospital Foundation reportedly also mentions ICCA, but the page now returns 404 and we could not re-read it [24] | **[VENDOR CLAIM]**, partially corroborated |
| Bangkok Hospital | Same article [15] | **[VENDOR CLAIM]** |
| Phyathai Hospital | A LinkedIn post describes a Philips workshop at Phyathai showing Patient Monitoring + ICCA + MDIP. That is a **demo or pre-sales activity, not a confirmed install** [25] | Low |

We found no Thai peer-reviewed paper, hospital procurement notice or hospital press release that names ICCA. Workpoint Today (Aug 2024) describes ICCA as a Philips offering in Thailand but names no sites [26].

---

## 5. Pricing / public procurement

- **No e-GP announcement, TOR or ราคากลาง naming ICCA, "IntelliSpace Critical Care", or a Philips ICU clinical information system was found** in indexed web results (Thai and English searches, including gprocurement-style terms such as ระบบสารสนเทศผู้ป่วยวิกฤต and ระบบบันทึกข้อมูลผู้ป่วยวิกฤต).
- Likely reasons, all **[UNVERIFIED]**: (a) university hospitals (Chula, Rama) buy through their own procurement portals or foundation/donation funds, not e-GP keyword-visible notices; (b) ICCA is bundled inside larger monitoring tenders (เครื่องติดตามการทำงานของหัวใจและสัญญาณชีพ + central station) where the software is a line item; (c) Rajavithi-style foundation or donation channels [24].
- Global pricing is custom enterprise only and not published [7].
- **Next step (manual):** search the e-GP "ค้นหาประกาศจัดซื้อจัดจ้าง" screen by **vendor name "โซวิค"** and by agency (Rajavithi, KCMH, Rama) for 2018–2026. Look for monitoring tenders with "ระบบบันทึกข้อมูล", "Clinical Information" or "ICCA" in the TOR attachments. The e-GP search UI is not indexed by web search.

---

## 6. Strengths and weaknesses

### Strengths
1. **Philips brand and installed monitor base.** IntelliVue monitors are widespread in Thai ICUs. ICCA plus PIC iX is a natural upsell, and Xovic has decades of MOPH and military procurement relationships [10][14].
2. **Mature, broad clinical content.** Anesthesia and ICU in one product, CDS bundles, ADE checking, infusion management, analytics module, Class IIb certification [1][5].
3. **Capsule MDIP** gives a credible multi-vendor device story at enterprise scale [4].
4. **Flagship references.** Philips publicly names tier-1 Thai academic hospitals [15].
5. **Turnkey financing.** Philips can bundle ICCA into multi-year, export-credit-financed hospital deals [23].

### Weaknesses
1. **No evidence of Thai UI** or Thai-specific forms; English-only Thai product page [2].
2. **Heavy, costly enterprise implementation.** Philips-led configuration, on-prem or hybrid IT, high initial cost [7][1].
3. **Customisation depends on the vendor.** Forms and flowsheets are configured through Philips or trained analysts, not by clinicians themselves **[UNVERIFIED]**.
4. **Stack lock-in and add-on cost.** Device data needs PIC iX and/or MDIP, plus IntelliBridge for third-party devices. That means extra licences and hardware [1][3][5].
5. **Thin local software capability.** The distributor presents itself as a hardware house with no informatics content on its site [11]. Local HIS interfacing (HOSxP, in-house HIS, สปสช./e-Claim fields) probably needs custom work **[UNVERIFIED]**.
6. **Strategic drift.** Philips' informatics messaging now centres on Capsule, surveillance and telehealth, and ICCA gets little new public investment news [8][22]. That makes long-term roadmap risk a fair question for buyers **[UNVERIFIED]**.

---

## 7. How FLORA should position

### Tier 1 (university / MOPH regional / large hospitals: Chula, Rama, Rajavithi, ศูนย์)
- **Expect ICCA as the incumbent or as a bundled line in a Philips monitoring tender.** Write TORs that ask for:
  - a vendor-neutral device gateway (Mindray, Nihon Kohden, GE, Dräger and Philips monitors; anesthesia machines; pumps) **without third-party concentrators**;
  - hospital self-authoring of forms, reports and workflows (FLORA Form, Report, Workflow and AI Studio);
  - a full Thai UI;
  - local HIS integration (HOSxP and in-house HIS) with Thai coding and billing.
- Lead on **total cost**: no per-bed MDIP/PIC iX layer, and Canopy runs on hospital hardware. Lead also on **speed of change**: anaesthesiologists and ICU nurses edit forms themselves instead of raising Philips change requests.
- Offer **coexistence**: FLORA Gateway can ingest from Philips monitors and from sites that keep ICCA in ICU, so FLORA can win the OR/anesthesia record first. Then use the Root/Canopy multi-site story for regional networks.
- Ask buyers about Philips' ICCA roadmap and cloud plans, given the portfolio shift toward Capsule [8][22].

### Tier 2 (smaller MOPH, private)
- ICCA's cost and implementation weight are hard to justify here. Philips is more likely to sell monitors plus a central station (PIC iX) without ICCA **[UNVERIFIED]**.
- FLORA's angle: an affordable bedside Leaf + Gateway that charts automatically from **existing** mixed-brand monitors, with Thai forms ready on day one and a short go-live, all without a Philips-only central station.
- Watch Xovic's channel strength in MOPH procurement [14]. Consider partnering with, rather than fighting, local monitor distributors on mixed-brand sites.

### Proof points to prepare
- Live demo of Gateway pulling from a Philips IntelliVue (MIB/LAN) **and** a non-Philips monitor on the same Leaf.
- Thai anesthesia record and ICU flowsheet authored in Form Studio in front of the customer.
- HIS round trip (ADT in, record/billing out) with a Thai HIS.

---

## Sources

1. Philips, ICCA product page (EU/IE): https://www.philips.ie/healthcare/product/HCNOCTN332/intellispace-critical-care-and-anesthesia (also https://www.usa.philips.com/healthcare/product/HCNOCTN332/intellispace-critical-care-and-anesthesia)
2. Philips Thailand, ICCA product page (English only): https://www.philips.co.th/healthcare/product/HCNOCTN332/intellispace-critical-care-and-anesthesia
3. Capsule (Philips), ICCA page: https://capsuletech.com/icca
4. Philips press release, Capsule MDIP device-integration milestone (28 Oct 2021): https://www.philips.com/a-w/about/news/archive/standard/news/press/2021/20211028-philips-capsule-medical-device-information-platform-reaches-device-integration-milestone.html
5. Philips, ICCA Release H technical data sheet (May 2015): https://images.philips.com/is/content/PhilipsConsumer/Campaigns/HC20140401_DG/Documents/ICCA%20data%20sheet.pdf
6. Philips, IntelliBridge system (TH): https://www.philips.co.th/healthcare/product/HCNOCTN333/intellibridge-system
6b. Philips, ICCA Anesthesia brochure: https://images.philips.com/is/content/PhilipsConsumer/Campaigns/HC20140401_DG/Documents/ICCA%20Anesthesia%20brochure.pdf
7. IntuitionLabs, Philips IntelliSpace Critical Care overview (third-party): https://intuitionlabs.ai/software/intensive-care-critical-care/critical-care-documentation/philips-intellispace-critical-care
8. Philips USA, Acute care informatics portfolio: https://www.usa.philips.com/healthcare/acute-care-informatics
9. Philips Thailand, healthcare distributors list: https://www.philips.co.th/healthcare/about/distributors
10. Philips Singapore newsroom, "Philips partners with Xovic … Learning and Experience Center" (22 Jul 2024): https://www.philips.com.sg/a-w/about/news/archive/standard/news/articles/2024/20240722-empowering-health-systems-with-new-capabilities-in-hospital-patient-monitoring.html
11. Xovic Company Limited website: https://www.xovic.com/
12. Creden data, บริษัท โซวิค จำกัด (0105529003833): https://data.creden.co/company/general/0105529003833
13. Philips Thailand press (Thai), ฟิลิปส์จับมือโซวิค เปิดตัวศูนย์ Learning and Experience Center: https://www.philips.co.th/a-w/about/news/archive/standard/about/news/press/2024/20241219-philips-partners-with-sovic-to-launch-new-learning-and-experience-center.html ; also https://www.the-perspective.co/philips-and-xovic-grand-opening-learning-and-experience-center/
14. Isranews (31 May 2016), report on Xovic government contracts: https://www.isranews.org/content-page/item/47336-report_xovic_30559.html
15. Bangkokbiznews, รู้จัก 'health informatics' … (interview with Philips Thailand MD; about Jun 2023): https://www.bangkokbiznews.com/health/public-health/1073363
16. DataForThai, ข้อมูล บริษัท โซวิค จำกัด: https://www.dataforthai.com/company/0105529003833/
17. Business Wire (6 Jul 2015), Spok and Xovic partner for Thailand hospitals: https://www.businesswire.com/news/home/20150706005804/en/Spok-and-Xovic-Partner-to-Improve-Critical-Communications-for-Thailand-Hospitals
18. Bang Phli Hospital, ประกาศผู้ชนะการเสนอราคา เครื่องกระตุกไฟฟ้าหัวใจ: https://www.bph.go.th/?p=18717
19. Khon Kaen University procurement, winning bidders list: https://procurement.kku.ac.th/t/bidders?page=85&per-page=15&sort=-name
20. iF Design Award, IntelliSpace Critical Care & Anesthesia Anywhere: https://ifdesign.com/en/winner-ranking/project/intellispace-critical-care-anesthesia-anywhere/201289
21. BfArM, corrective action notice for ICCA (2014, ref 07760/14): https://bfarm.de/SharedDocs/Kundeninfos/EN/10/2014/07760-14_kundeninfo_en.pdf
22. National CIO Review, Philips Q4 2025 results coverage: https://nationalcioreview.com/?p=74531
22b. Philips Image Management 15 web viewer launch (Nov 2025): https://www.santelog.com/actualites-sante-nasdaq/philips-launches-next-generation-web-based-diagnostic-viewer-fast-secure
23. Mandaya Hospital Group, Philips seven-year partnership: https://mandayahospitalgroup.com/philips-and-mandaya-royal-hospital-puri-sign-seven-year-partnership-agreement-to-provide-patient-centered-care/
24. SM Magazine Online (14 Dec 2022), Philips Foundation / Rajavithi Hospital Foundation (now 404; content known only from a search snippet): https://www.smmagonline.com/2022/12/14/philips-foundation-rajavithi-hospital-04/
25. LinkedIn post re Philips Patient Monitoring/ICCA/MDIP workshop at Phyathai Hospital (search snippet only): https://th.linkedin.com/in/chatharnee-polmetharas
26. Workpoint Today (28 Aug 2024), 'PHILIPS' กุญแจแห่งความสำเร็จ สู่นวัตกรรมทางการแพทย์: https://www.workpointtoday.com/philips-medical-supplies-and-equipment-the-2024
