# Competitor: Senemed (originally briefed as "Mindmed")

Status: **unresolved. No public footprint found for "Senemed".** Researched 2026-10-13.

## TL;DR

- **"Senemed" cannot be found publicly.** Searches in English and Thai (Senemed, SeneMed, Sene Med, เซเนเมด, ซีเนเมด, เซเน่เมด) and nearby spellings (Sanemed, Synemed, Zenemed, Sensemed, Sinemed) turned up no Thai hospital-software company or product. `senemed.com` is a parked domain that GoDaddy is selling, and `senemed.co.th` does not resolve.
- **"Mindmed" does match a real Thai company.** The Facebook page `facebook.com/mindmedthailand` belongs to **Mind Medical Care Co., Ltd. (บริษัท มายด์ เมดิคอล แคร์ จำกัด)** of Sriracha, Chonburi. It sells medical devices and some software: telemedicine, IPD Paperless ("iChart"), cardio PACS, Virtual ER/LR. We found **no anesthesia, OR or ICU product**. It overlaps with FLORA only a little.
- The US psychedelics company MindMed (Mind Medicine Inc., renamed Definium Therapeutics in Jan 2026) is unrelated and left out.
- **Action needed:** someone needs to confirm the exact name. Good leads are the TOR or bid-opening record where the name appeared, a business card, or a brochure. The e-GP vendor search on gprocurement.go.th is dynamic, so it was not indexed. Search it by hand.

## 1. Company profile

### 1a. Senemed: not found

| Check | Result |
|---|---|
| `https://www.senemed.com` | HTTP 200, then a JS redirect to `/lander`, which goes to a GoDaddy "for sale" parking page. Not an operating company. |
| `senemed.co.th`, `senemed.net`, `senemed.io` | No HTTP response or no DNS |
| Web search (EN/TH variants) | No relevant hits |
| LinkedIn / Facebook search | No relevant hits |
| Thai HIS vendor roundup (rath.asia, 2019, 35 vendors) | Not listed [S6] |
| e-GP (site search) | No indexed hits. Needs a manual search on gprocurement.go.th |

**Unverified hypothesis:** "Senemed" may be a mishearing or misspelling of another vendor name, or a brand too new or too small to be indexed. Candidate names checked that are **not** a match: Synemed (US ophthalmic imaging) [S9], Sedana Medical, Senzime. Thai vendors with "Med" in the name: iMed / International Medical Software, MEDcury (MED-HIS), Mind Medical Care [S6][S7].

### 1b. Mind Medical Care Co., Ltd.: the probable "Mindmed"

- **Legal name:** บริษัท มายด์ เมดิคอล แคร์ จำกัด / Mind Medical Care Co., Ltd. Facebook handle `mindmedthailand` [S2].
- **Registration no.:** 0205554015946 (the 0205-55 prefix means Chonburi, registered around 2011, B.E. 2554). Registered capital is reported as **THB 5,000,000**. The DBD-derived listing gives its main business as **medical device distribution** [S3]. (dataforthai returned 403 to direct fetch, so these figures come from the search-result summary and are partly unverified.)
- **Address:** 183/4 Moo 2, Surasak, Sriracha, Chonburi 20110. Tel +66 38 312 984, info@mindmedicalcare.com [S2][S3].
- **Positioning:** the website calls the company a "leader of medical software solutions of Thailand" [S1]. Its catalog mixes **hardware** (BT-380 fetal/maternal monitor, BT-450 phototherapy blanket, BT-500 infant incubator) with **software** [S1].
- **Size and owners:** not found publicly. With THB 5M capital and a medical-device distribution business, it is likely a small SME. (Inference, unverified.)
- A different company, **บริษัท มายด์เมดิคอลเซ็นเตอร์ จำกัด** (reg. 0125557008097, Nonthaburi), also exists. We found nothing linking it to hospital software [S5].

## 2. Product capabilities (Mind Medical Care)

Software products and list prices as shown on the vendor's software category page (taken from the search summary; the site refused direct fetch during research) [S4]:

| Product | What it is (vendor claim) | List price (THB) |
|---|---|---|
| iChart: IPD Paperless | Inpatient-ward paperless records: patient records, schedules, prescriptions [S8] | 1,500,000 |
| AmbuLink EMS Telemedicine | Ambulance-to-hospital real-time video/audio teleconsult [S10] | 1,200,000 |
| HeartStream | Cardio PACS / ECG streaming (inferred from "Cario PACs" on the homepage) | 3,500,000 |
| Virtual ER | No detail found | 650,000 |
| Virtual LR | Labor room; no detail found | 450,000 |

- **Anesthesia record / AIMS, OR, ICU flowsheet:** none found.
- **Bedside device integration:** none advertised beyond the vendor's own devices (fetal monitor, etc.). Unverified.
- **HIS integration:** no public documentation found. Unverified.
- **Deployment and pricing model:** pricing is listed as a one-off THB package price, which suggests a perpetual licence. Whether it runs on-prem or in the cloud is unknown.
- **Caution:** "IPD Paperless" is a generic MOPH Smart Hospital initiative term. Many community hospitals (e.g., รพ.น้ำปาด, รพ.วังเจ้า, Phrae province) run IPD Paperless on their own HIS, often HOSxP. Their pages do **not** name Mind Medical Care, so they are **not** reference sites for it [S11][S12].

## 3. Known Thai reference sites

- **Senemed:** none found.
- **Mind Medical Care:** none found with a source link. No hospital press release, journal paper or e-GP award naming the company or its products turned up.

## 4. Pricing / public tenders

- **e-GP:** no indexed award or TOR names Senemed or มายด์ เมดิคอล แคร์ (site-restricted search on gprocurement.go.th; the PSU and Siriraj monthly procurement summaries that surfaced do not mention either company) [S13].
- The only price data is Mind Medical Care's public list prices (section 2): iChart IPD Paperless at THB 1.5M and the others at THB 0.45M to 3.5M [S4].
- **To do (manual):** search the e-GP "ค้นหาประกาศจัดซื้อจัดจ้าง" page by vendor name. Use these spellings: "มายด์ เมดิคอล แคร์", "มายด์เมดิคอลแคร์", the confirmed Senemed Thai spelling, and the tax ID 0205554015946.

## 5. Strengths, weaknesses, positioning

The assessment covers Mind Medical Care (the probable "Mindmed"). Redo it once the "Senemed" name is confirmed.

**Likely strengths (inferred)**
- Local Thai SME based in the Eastern Seaboard (Chonburi). It may have relationships with regional and private hospitals in the EEC.
- It sells hardware and software together: fetal monitors and incubators plus telemedicine. This suits MCH/LR and EMS buyers.
- Its packages are fixed-price and fairly cheap (THB 0.45–1.5M), which fits tier-2 budgets.

**Likely weaknesses (inferred)**
- No anesthesia record, OR, ICU flowsheet or multi-vendor device gateway is visible, and these are the core of FLORA.
- No published reference sites, academic validation or e-GP footprint, which matters for tier-1 TOR scoring.
- Small capital base (THB 5M), so it has limited capacity for tier-1 multi-site rollouts, 24/7 support and HIS integration projects.

**FLORA positioning**
- **Tier 1** (university / MOPH regional / centre hospitals): FLORA should rarely meet this vendor directly. Write TOR specs that it is unlikely to meet:
  - automatic vitals capture from mixed-brand anesthesia machines, monitors and ventilators through a vendor-neutral gateway
  - a perioperative timeline (pre-op → intra-op → PACU) plus ICU flowsheets
  - HIS integration (HOSxP / TrakCare / MED-HIS) via HL7/FHIR
  - hospital self-authoring of forms and reports (Form/Report/Workflow Studio)
  - central server with offline-tolerant bedside workstations
  - named Thai reference sites
- **Tier 2** (smaller / private): this is where it could overlap, on general IPD/ward paperless or ER/LR packages. Two approaches:
  - (a) Do not compete on ward paperless. Pitch FLORA as the OR/anesthesia/ICU specialist that sits alongside the HIS or whatever ward-paperless system the hospital has.
  - (b) If a TOR bundles ER/LR, keep a partner or integration story ready for LR monitoring, such as ingesting fetal monitor data via Gateway.
- Track their published list prices as a ceiling reference for tier-2 software budgets.

## Searches performed

Senemed (EN/TH): "Senemed Thailand hospital system"; "Senemed ระบบ โรงพยาบาล"; "SeneMed" anesthesia/ICU/operating room; "เซเนเมด" / "ซีเนเมด" / "เซเน่เมด"; "Senemed OR Sanemed OR Synemed OR Zenemed software Thailand"; "Senemed" OR "Sene Med" Thailand (extended); "Senemed" facebook/linkedin; Sensemed/Sinemed Thailand anesthesia ICU; site:gprocurement.go.th Senemed; domain probes senemed.com/.co.th/.net/.io.

Mindmed (EN/TH): "Mindmed ระบบ โรงพยาบาล"; "Mindmed" anesthesia record Thailand; "มายด์เมด ระบบ"; "mindmed.co.th"; Mindmed ICU nurse documentation; "Mindmed" Thailand software company (extended); "มายด์ เมด"/"มายด์เมด" บริษัท; ระบบ Mindmed จัดซื้อจัดจ้าง; "Mind Medical Care" บริษัท มายด์ เมดิคอล แคร์; Mind Medical Care iChart IPD Paperless; Thai AIMS vendor survey query; rath.asia Thai HIS vendor list.

## Sources

- [S1] Mind Medical Care website: https://www.mindmedicalcare.com/ (search snippet; direct fetch failed with "socket closed")
- [S2] Facebook, Mind Medical Care Co.,Ltd - บริษัท มายด์ เมดิคอล แคร์ จำกัด: https://www.facebook.com/mindmedthailand/
- [S3] DataForThai company record 0205554015946: https://www.dataforthai.com/company/0205554015946/ (search snippet; direct fetch 403)
- [S4] Mind Medical Care software category / price list: https://www.mindmedicalcare.com/category/%E0%B8%8B%E0%B8%AD%E0%B8%9F%E0%B8%97%E0%B9%8C%E0%B9%81%E0%B8%A7%E0%B8%A3%E0%B9%8C (search snippet)
- [S5] Creden, บริษัท มายด์เมดิคอลเซ็นเตอร์ จำกัด: https://data.creden.co/company/general/0125557008097
- [S6] Rath Panyowat, รวมผู้ขาย HIS ในประเทศไทย (2019): https://rath.asia/blog/2019/11/15/his-vendors-thailand/
- [S7] MEDcury / MED-HIS distributor news: https://www.matichon.co.th/publicize/news_4072936
- [S8] iChart: IPD Paperless product page: https://www.mindmedicalcare.com/product-page/ichart-ipd-paperless (search snippet)
- [S9] Synemed (US, unrelated): https://www.synemed.com/
- [S10] AmbuLink EMS Telemedicine product page: https://www.mindmedicalcare.com/product-page/ambulink-ems-telemedicine (search snippet)
- [S11] HFocus, Phrae IPD Paperless rollout (generic MOPH initiative, vendor not named): https://www.hfocus.org/content/2021/10/23297
- [S12] รพ.วังเจ้า IPD Paperless page (vendor not named): https://www.wangchaohosp.go.th/IPD_Paperless.php
- [S13] Example procurement summaries searched (no match): https://si.mahidol.ac.th/th/division/assets/procurement/MonthlyResult_files/256205_NP8PX.pdf
- Unrelated US MindMed, excluded: https://en.wikipedia.org/wiki/MindMed_Inc.
- senemed.com parked-domain redirect: https://forsale.godaddy.com/forsale/www.senemed.com
