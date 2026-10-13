# การศึกษา: การเชื่อมต่อ CPOE และการใช้ SNOMED CT ในการบันทึกข้อมูล (Flora)

สถานะ: ข้อเสนอเพื่อตัดสินใจ · ตุลาคม 2026

## 1. สรุป

- **Flora ไม่ควรสร้าง CPOE เต็มรูปแบบ** ระบบสั่งยาทั้งระบบ (pharmacist verification, drug interaction, MAR, dispense) เป็นของ HIS อยู่แล้ว
  Flora ควรเป็น **ต้นทางของข้อมูลที่เกิดในห้องผ่าตัด/ICU** และเป็น **ผู้ใช้ order จาก HIS**:
  1. ส่งรายการยา/เวชภัณฑ์ที่ใช้จริง (billing checklist ที่มีแล้ว) ไปลงค่าใช้จ่ายใน HIS (charge posting)
  2. รับ order ก่อนผ่าตัดจาก HIS มาแสดง (premedication, antibiotic prophylaxis, blood request) แบบอ่านอย่างเดียว
  3. order หลังผ่าตัด (PACU/ward) ให้เปิด CPOE ของ HIS ในบริบทผู้ป่วยเดียวกัน แทนการสร้างซ้ำ
- **SNOMED CT ใช้ได้ฟรีในไทย:** ประเทศไทยเป็นสมาชิก SNOMED International ตั้งแต่ปี 2022 และสำนักพัฒนามาตรฐานระบบข้อมูลสุขภาพไทย (THIS, สวรส.) เป็น National Release Centre ออก Affiliate License ให้ฟรี ([SNOMED Thailand](https://www.snomed.org/members/thailand), [ข่าวการเป็นสมาชิก](https://www.snomed.org/news/thailand-progresses-interoperability-journey-with-snomed-ct-membership)) Thai extension มี **TMT** (ยา) และ **TMLT** (แล็บ) รวมอยู่
- **Flora มีโครงสร้างรองรับครึ่งหนึ่งแล้ว** (`clinical_concept` + `clinical_concept_coding` + `terminology_release/entry`) แต่ยังขาด:
  - ตัว import SNOMED ที่ครบ (synonym, คำไทย, relationship, refset)
  - value set ที่ใช้ผูกกับช่องในฟอร์ม
  - รหัส TMT/TMLT
  - การบันทึกแพ้ยา/แล็บแบบมีรหัส
  - ช่องทางส่งข้อมูลออก (HL7 v2 / FHIR)
- **ลำดับที่แนะนำ:** (1) ขอ license และวางโครงสร้าง terminology + value set ที่ Canopy แล้ว sync ลง Leaf → (2) ส่ง charge จาก billing ไป HIS → (3) ผูกรหัส SNOMED กับฟอร์มและแพ้ยา → (4) เปิด FHIR read API ตาม Thai IG

## 2. สถานะปัจจุบันของ Flora

| ด้าน | มีแล้ว | ยังไม่มี |
| --- | --- | --- |
| Terminology | `clinical_concept`, `clinical_concept_coding` (SNOMED_CT, ICD_10, ICD_9_CM, LOINC, RXNORM, ATC, UCUM) และ `terminology_release` / `terminology_entry` / `terminology_synonym` (migration 0012, 0018) | ตาราง value set, refset, relationship (is-a); รหัส TMT, TMLT, ICD-10-TM, IEEE MDC |
| ข้อมูลที่โหลดแล้ว | WHO ICD-10 2019, ICD-9-CM v32, UCUM (`scripts/import-terminology.py`) | ข้อมูล SNOMED จริง: importer `snomed-rf2` โหลดเฉพาะ FSN ของ disorder/procedure ไม่มี synonym, คำไทย, substance, body structure หรือ refset |
| การบันทึก | Diagnosis/procedure เก็บ `concept_id` + `coding_snapshot`; I/O item ผูก concept ได้ | FormView (เทคนิคดมยา, monitoring, ท่า, ตำแหน่งแทงเส้น ฯลฯ) เป็นข้อความล้วนใน `form_draft_json`; แพ้ยา (`case_his_allergy`) และแล็บ (`case_his_lab`) เป็นข้อความ; Form Studio ผูกกับ value set ไม่ได้ |
| HIS / order | รับ HL7 v2 SIU^S12, ORM^O01, ADT เข้ามาเป็น admission (`app/hl7_interface.py`); ดึงผู้ป่วย/แพ้ยา/แล็บจาก HIS gateway (`routes/his.py`); Public API `/api/v1` (Flora JSON) | ไม่มี order model, ไม่ส่ง order/charge ออก, ไม่มี HL7 builder (นอกจาก ACK ใน gateway), ไม่มี FHIR serializer; สเปก Porjai drug-order API มีแต่เอกสาร |
| ใกล้เคียง order ที่สุด | `case_billing_order` + `_item` (มี `charge_code`, `io_item_code`, ราคา) sync ไป Canopy | ยังไม่ส่งไป HIS |

## 3. CPOE: แนวทางการเชื่อมต่อ

### 3.1 บทบาทที่เหมาะกับ Flora

ในห้องผ่าตัด วิสัญญีแพทย์ให้ยาเองทันที ไม่ได้ผ่านขั้นสั่ง → เภสัชตรวจ → จ่ายยา การบันทึกใน Flora จึงเป็น **การบันทึกการให้ยา (administration)** ไม่ใช่การสั่งยา ส่วนหลังผ่าตัดจึงเริ่มเป็น order ตามปกติของ HIS

| รูปแบบ | ทิศทาง | ใช้เมื่อ | มาตรฐาน |
| --- | --- | --- | --- |
| A. รับ order ก่อนผ่าตัด | HIS → Flora | แสดง premed / antibiotic / blood request ที่สั่งไว้ ให้ติ๊ก "ให้แล้ว" ใน I/O | HL7 v2 ORM^O01, OMP^O09, RDE^O11; FHIR `MedicationRequest`, `ServiceRequest` |
| B. ส่งยาและเวชภัณฑ์ที่ใช้จริง | Flora → HIS | ลงค่าใช้จ่ายและตัดสต็อกจาก billing checklist และ I/O | HL7 v2 DFT^P03 (charges), RAS^O17 (administration); FHIR `ChargeItem`, `MedicationAdministration`; หรือ REST ของ HIS (แบบ Porjai API 2) |
| C. Order หลังผ่าตัด | Flora → HIS | PACU / ward order set | **แนะนำให้เปิด CPOE ของ HIS** ด้วย context ผู้ป่วย (SMART on FHIR launch หรือ URL launch) แทนสร้างเอง; ถ้าจำเป็นค่อยส่ง order เป็นร่างให้แพทย์ยืนยันใน HIS |
| D. ส่งผลและเอกสารกลับ | Flora → HIS | Anesthesia record PDF, vital สรุป | HL7 v2 MDM^T02 / ORU^R01; FHIR `DocumentReference`, `Observation`, `Procedure` |

**แนะนำ:** เริ่มที่ **B** (มีข้อมูลพร้อมจาก billing) และ **A แบบอ่านอย่างเดียว** ส่วน **C** ใช้วิธี launch ไป HIS

### 3.2 สิ่งที่ order integration ต้องมี (ไม่ว่าใช้มาตรฐานไหน)

- **รหัสอ้างอิง:** placer order number (Flora) / filler order number (HIS) และ idempotency key ต่อรายการ เพื่อไม่ให้ลงค่าใช้จ่ายซ้ำเมื่อส่งใหม่
- **สถานะ:** draft → sending → accepted / rejected → cancelled / amended แยก "ส่งถึง" ออกจาก "HIS รับรายการแล้ว" (ตรงกับข้อกำหนดใน `docs/handoff/BKI handoff.md`)
- **การยกเลิกและแก้ไข:** ส่ง cancel / correction เมื่อ Reopen billing ที่ส่งไปแล้ว ตอนนี้สเปก Porjai ยังไม่มี cancel/amend และไม่คืน order ID เป็นคำถามที่ต้องตกลงกับผู้ทำ HIS
- **ตาราง mapping:** ยา (`io_item_master` / `billing_item` ↔ รหัสยา HIS ↔ **TMT**), หน่วย (UCUM ↔ `meduseunit` ของ HIS), วิธีให้ยา (route ↔ `meduestype`) จัดการที่ Canopy แล้ว sync ลง Leaf แบบเดียวกับ billing master
- **Audit และ retry:** log ข้อความทุกฉบับ (แบบ `canopy_hl7_message`) ส่งซ้ำได้ แสดงรายการที่ค้างให้ผู้ดูแลเห็น
- **ความปลอดภัย:** การตรวจซ้ำซ้อน แพ้ยา และขนาดยาควรอยู่ฝั่ง HIS/CDS ถ้าต้องการให้เตือนใน Flora ต้องมีแพ้ยาแบบมีรหัสก่อน (ข้อ 4) แล้วใช้ CDS Hooks (`order-select` / `order-sign`) หรือ rule ภายใน

### 3.3 ช่องทางเทคนิค

- **ใช้เส้นทางเดิม:** ส่งออกผ่าน Canopy เพราะ Leaf อยู่หลัง NAT และ Canopy เป็นจุดเดียวที่คุยกับ HIS
  - Leaf บันทึก → sync ขึ้น Canopy (มีแล้วใน billing) → **Canopy outbound worker** แปลงเป็น HL7 v2 / REST / FHIR → ส่งไป interface engine ของโรงพยาบาล (Scope-Life gateway ที่ใช้รับ SIU/ORM อยู่แล้ว)
- **รูปแบบข้อความ:**
  - HIS ไทยส่วนใหญ่ยังรับ HL7 v2 หรือ REST เฉพาะ vendor → เริ่มด้วย adapter แบบเสียบได้ (HL7 v2 DFT/RAS, Porjai REST)
  - FHIR R4 ทำเป็น adapter ตัวถัดไป

## 4. SNOMED CT: แนวทางใช้ในการบันทึก

### 4.1 License และแหล่งข้อมูล

- ไทยเป็นสมาชิกตั้งแต่ ก.พ. 2022
- ผู้ใช้และผู้พัฒนาในไทยลงทะเบียนขอ **Affiliate License ฟรี** กับ THIS
- ดาวน์โหลดผ่าน MLDS ของไทย (`mlds.ihtsdotools.org/th`) ทั้ง International Edition และ Thai extension (TMT, TMLT) ([Member Licensing](https://conf.spaces.snomed.org/wiki/spaces/MLDSDOC/pages/133145120/Member+Affiliate+Licensing+Information))
- **ต้องทำ:** ESM ลงทะเบียนเป็น Affiliate (ผู้พัฒนาซอฟต์แวร์) และแต่ละโรงพยาบาลลงทะเบียนการใช้งาน (deployment) กับ THIS
- **FHIR ของไทย:**
  - SIL-TH เผยแพร่ IG เช่น MoPH-PC-1, ClaimCon และ SIL-TH Terminology (มี value set TMT)
  - ยังไม่มี national terminology server ([FHIR jurisdiction TH](https://packages.fhir.org/jurisdictions/TH), [TMT value set](https://packages2.fhir.org/xig/resource/silth.fhir.terminology.core%7C0.1.2/ValueSet/th-tmt))

### 4.2 จะใช้ระบบรหัสไหนกับข้อมูลอะไร

| ข้อมูลใน Flora | รหัสหลักสำหรับบันทึก | รหัสสำหรับรายงาน/เบิก | ที่อยู่ปัจจุบัน |
| --- | --- | --- | --- |
| Diagnosis | SNOMED CT (disorder / finding) | ICD-10-TM (ผ่าน map) | `case_diagnosis` (มี concept แล้ว) |
| Procedure / operation | SNOMED CT (procedure) | ICD-9-CM | `case_procedure` |
| เทคนิคดมยา, block, line | SNOMED CT (procedure) + body site + laterality | — | FormView options (ข้อความ) |
| ท่าผู้ป่วย, monitoring, อุปกรณ์ทางเดินหายใจ | SNOMED CT (procedure / observable / physical object) | — | FormView options |
| เหตุการณ์ในเคส (intubation, incision, …) | SNOMED CT (procedure / event) | — | `case_event_note.title` (ข้อความ) |
| แพ้ยา | SNOMED CT substance หรือ **TMT** (ยา) + อาการแพ้ (finding) | — | `case_his_allergy` (ข้อความ) |
| ยาและสารน้ำ | **TMT** (ไทย), ATC / RxNorm (สากล) | รหัสยา HIS | `io_item_master` (มี concept), `billing_item` |
| ผลแล็บ | **TMLT**, LOINC | — | `case_his_lab` (ข้อความ) |
| Vital / ค่าจากเครื่อง | LOINC + IEEE 11073 MDC | — | `clinical_parameter_master` (มี LOINC บางส่วน) |
| หน่วย | UCUM | หน่วย HIS | มีแล้ว |

**หลักการ:**
1. เก็บทั้ง **รหัส local + รหัสมาตรฐาน + ข้อความที่ผู้ใช้เห็น** (มีอยู่แล้วใน `coding_snapshot`) เพื่อไม่เสียข้อมูลเมื่อรหัสเปลี่ยนรุ่น
2. ใช้ SNOMED บันทึก **ความหมายทางคลินิก** แล้วแปลงเป็น ICD เพื่อเบิกและสถิติ ไม่บังคับให้แพทย์เลือก ICD เอง
3. ผู้ใช้เห็นรายการเลือกจาก **value set** ที่คัดไว้ต่อ specialty (เช่น เทคนิควิสัญญี 30–50 รายการ) ไม่ใช่ค้นทั้ง SNOMED 350,000 concept
4. ไม่ทำ post-coordination ในระยะแรก ใช้ pre-coordinated concept และ attribute แยก (body site, laterality) เป็นช่องในฟอร์ม

### 4.3 สิ่งที่ต้องเพิ่มใน Flora

1. **Terminology store (Canopy เป็นเจ้าของ):**
   - เพิ่ม system key: `TMT`, `TMLT`, `ICD_10_TM`, `MDC`
   - ตารางใหม่:
     - `terminology_relationship` (is-a + transitive closure สำหรับค้นตามลำดับชั้น)
     - `value_set` / `value_set_member` (สร้างจาก refset หรือ ECL แล้วเก็บผลที่ขยายแล้ว)
     - `concept_map` (SNOMED → ICD-10, TMT ↔ รหัสยา HIS)
   - **อีกทางเลือก:** ใช้ terminology server ภายนอกที่ Canopy เช่น **Snowstorm** (open source ของ SNOMED International, รองรับ ECL และ FHIR terminology API) หรือ Ontoserver (เชิงพาณิชย์) แล้วให้ Flora เก็บเฉพาะ value set ที่ขยายแล้ว
2. **Importer:**
   - ขยาย `snomed-rf2` ให้โหลด synonym, คำไทย (ถ้ามีใน Thai extension), semantic tag ทุกกลุ่มที่ใช้, relationship และ refset
   - เพิ่ม importer TMT/TMLT จาก THIS
3. **Sync ลง Leaf:** ส่ง value set ที่ใช้งานลง Leaf ผ่าน directory exchange แบบเดียวกับ billing master/io_catalog ทำให้ใช้ได้แม้ offline Leaf ไม่ต้องเก็บ SNOMED ทั้งชุด
4. **ผูกกับการบันทึก:**
   - **FormView:** เปลี่ยน option ข้อความเป็น `{value, label, coding}` อ่านจาก value set ค่าเดิมยังอ่านได้
   - **Form Studio:** เพิ่ม option source แบบ `valueSet` ให้ select/radio/multiselect และให้ record เก็บ `{code, system, display}`
   - **Events:** preset event ผูก concept
   - **แพ้ยา:** ช่องเลือก substance (SNOMED/TMT) + reaction + severity โดยยังรับข้อความอิสระได้ (แพ้ยาจาก HIS มักเป็นข้อความ)
   - **I/O และ billing:** ผูก `io_item_master` / `billing_item` กับ TMT และรหัสยา HIS (ใช้ทั้ง CPOE ข้อ 3 และ SNOMED)
5. **ส่งออก:** แปลงเป็น FHIR `Condition`, `Procedure`, `AllergyIntolerance`, `MedicationAdministration`, `Observation` (CodeableConcept = SNOMED/TMT/LOINC + local) สอดคล้องกับ IG ของ SIL-TH

### 4.4 UX การบันทึก

- ค้นด้วยคำไทย อังกฤษ และคำย่อที่ใช้ในห้องผ่าตัด (synonym ภายในโรงพยาบาล เก็บใน `terminology_synonym`)
- รายการโปรดต่อ specialty / workflow (ใช้กลไกเดียวกับ itemize template ใน Workflow Studio)
- แสดงชื่อที่อ่านง่าย ไม่ใช่ FSN ยาว ๆ แต่เก็บ concept ID ไว้เบื้องหลัง
- ใช้ร่วมกับ dictation: ให้ LLM เสนอ concept จาก value set ที่จำกัดไว้ ห้ามเดารหัสนอก value set

## 5. แผนงานที่เสนอ

| ระยะ | งาน | ผลลัพธ์ | ประมาณ |
| --- | --- | --- | --- |
| 0 | ขอ SNOMED Affiliate License (ESM + รพ.นำร่อง); ขอ TMT/TMLT; สรุปกับผู้ทำ HIS เรื่องรูปแบบข้อความ, order ID, cancel/amend | สิทธิ์ใช้ข้อมูล + สเปก interface ที่ตกลงแล้ว | 2–4 สัปดาห์ (ขึ้นกับคู่สัญญา) |
| 1 | Terminology store ที่ Canopy (หรือ Snowstorm) + value set + sync ลง Leaf; importer SNOMED เต็ม + TMT; mapping ยา/หน่วย/route | value set สำหรับวิสัญญี, ยาผูก TMT | 4–6 สัปดาห์ |
| 2 | Charge posting: billing/I-O → Canopy outbound worker → HIS (HL7 v2 DFT หรือ REST) พร้อมสถานะ, retry, cancel; รับ pre-op order แบบอ่านอย่างเดียว | ค่าใช้จ่ายจากห้องผ่าตัดเข้า HIS อัตโนมัติ | 4–6 สัปดาห์ |
| 3 | ผูก value set กับ FormView / Form Studio / events / แพ้ยา; รายงานจาก concept (Report Studio dataset) | บันทึกแบบมีรหัส, รายงานตามความหมายคลินิก | 6–8 สัปดาห์ |
| 4 | FHIR R4 read API ตาม SIL-TH IG; launch CPOE ของ HIS จาก PACU; (ถ้าต้องการ) CDS Hooks | แลกเปลี่ยนข้อมูลตามมาตรฐาน | 6–8 สัปดาห์ |

## 6. ความเสี่ยงและคำถามที่ต้องตัดสินใจ

1. **ผู้ทำ HIS รองรับอะไร:** HL7 v2 DFT/RAS, REST เฉพาะ, หรือ FHIR และมี order ID / cancel / ack ระดับรายการหรือไม่
2. **ข้อมูลหลักยาอยู่ที่ไหน:** HIS, Canopy หรือ TMT ใครเป็นผู้ดูแล mapping
3. **คำไทยใน SNOMED:** Thai extension อาจยังไม่มีคำไทยครบ ต้องเพิ่ม synonym ของโรงพยาบาลเอง
4. **License ICD-10-TM:** ใช้สำหรับเบิก ต้องตรวจเงื่อนไขการใช้และแจกจ่าย (ระบุไว้ใน `docs/technology-transfer/THIRD-PARTY-SOFTWARE.md`)
5. **Clinical safety:** การส่ง order หรือ charge อัตโนมัติต้องมีขั้นทบทวน (เช่น Submit billing แล้วจึงส่ง) และต้องทดสอบกับ HIS test environment
6. **ขอบเขตกฎหมาย:** ข้อมูลออกนอก Canopy ต้องผ่าน PDPA และข้อตกลงกับโรงพยาบาล

## แหล่งอ้างอิง

- [SNOMED International: Thailand](https://www.snomed.org/members/thailand)
- [Thailand progresses interoperability journey with SNOMED CT membership](https://www.snomed.org/news/thailand-progresses-interoperability-journey-with-snomed-ct-membership)
- [SNOMED Member Affiliate Licensing Information (MLDS)](https://conf.spaces.snomed.org/wiki/spaces/MLDSDOC/pages/133145120/Member+Affiliate+Licensing+Information)
- [SNOMED CT licensing for vendors](https://docs.snomed.org/snomed-ct-practical-guides/vendor-introduction-to-snomed-ct/7-licensing)
- [FHIR packages: Thailand jurisdiction](https://packages.fhir.org/jurisdictions/TH)
- [SIL-TH MoPH-PC-1 IG](https://get-ig.org/silth.fhir.th.mophpc1/1.0.0)
- [SIL-TH Terminology: TMT value set](https://packages2.fhir.org/xig/resource/silth.fhir.terminology.core%7C0.1.2/ValueSet/th-tmt)
- [HSRI/THIS publication on TMT](https://www.hsri.or.th/printed-matter/468)
