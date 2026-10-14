# วิเคราะห์จุดเชื่อม Form Studio ↔ Workflow Studio ↔ Flora Leaf ↔ Report (ก่อนพัฒนาเป็นระบบเดียว)

สถานะ: **บทวิเคราะห์ ยังไม่ได้พัฒนา** · วันที่ 2026-10-14 · อ้างอิงโค้ดใน branch `Flora-Form`

เป้าหมายที่ผู้ใช้ตั้งไว้:
1. Workflow Studio ส่ง Form ไป Flora Leaf ทั้งเพื่อ **กรอกข้อมูล** และเพื่อ **ทำ Report** โดยดึงจาก Template ของ Form Studio
2. เก็บข้อมูลแบบ **Dynamic** (ไม่ต้องสร้างตารางใหม่ทุกครั้งที่มีฟอร์มใหม่) และรองรับ **Offline** ในอนาคต
3. **ตัวเชื่อม Field ต้องตรงกันทั้งระบบ** โดยให้ Form Studio เป็นศูนย์กลางของทุก Field

---

## 1. ภาพรวมการไหลของข้อมูลในปัจจุบัน

```
                         CANOPY (ส่วนกลาง)                                    FLORA LEAF (ประจำห้อง/วอร์ด)
┌──────────────────────────────────────────────┐                ┌───────────────────────────────────────────────┐
│ Form Studio                                  │                │ leaf_workflow_state (JSON 1 แถว: workflow +   │
│  formdev_form / formdev_schema_version        │   ward sync    │   form definitions ที่ pin version)            │
│  formdev_template (AI) → publish               │ ─────────────► │                                               │
│ Workflow Studio                                │  (sync worker  │ เริ่มเคส → cases.workflow (snapshot +          │
│  canopy_workflow(+_unit) pin form@version      │   ทุก 10 วิ)    │   bundled_forms)                               │
│                                                │                │                                               │
│ formdev_record  ◄── ingest_workflow_forms ──── │ ◄───────────── │ กรอก: case_form_record(case_id, form_id,       │
│  (record_id = <global_case_id>-<form-id>)      │  case_snapshot │   data jsonb, field_versions)  ← ไม่ validate  │
│                                                │  (สถานะล่าสุด)  │                                               │
│ Report Studio / AI Studio → archive_* เท่านั้น  │                │ บันทึกในตัว: case_detail.form_draft_json        │
│ (ไม่เห็น Leaf case และไม่เห็น formdev_record)    │                │ Report/Packet PDF: สร้างในเบราว์เซอร์ Leaf       │
└──────────────────────────────────────────────┘                └───────────────────────────────────────────────┘
```

### 1.1 จุดเชื่อมที่มีอยู่แล้ว (ทำงานได้)

| # | จุดเชื่อม | ทำงานอย่างไร | โค้ด |
|---|---|---|---|
| A | Publish workflow | ตรวจ workflow แล้วคัดลอกเป็น `published_definition` | `routes/workflows.py:177-192` |
| B | ส่ง workflow + form ไป Leaf | sync worker ขอ `/api/sync/v1/ward` → `workflows.leaf_delivery` ส่ง `{items, forms:{"form@ver": definition}}` | `sync_worker.py:233-264`, `workflows.py:217-242` |
| C | Leaf เก็บ | upsert แถวเดียว `leaf_workflow_state` เมื่อ payload เปลี่ยน | `case_workflow.py:68-82` |
| D | ผูกเคส | ตอนเริ่มเคส snapshot workflow + `bundled_forms` ลง `cases.workflow` (แช่แข็งต่อเคส) | `case_workflow.py:116-137` |
| E | กรอกบน Leaf | `WorkflowFormPanel` autosave 1.5 วิ ส่งเฉพาะ key ที่เปลี่ยน → `PATCH /api/case/{id}/workflow-forms/{form_id}` | `WorkflowFormPanel.tsx`, `case_workflow.py:230-255` |
| F | กลับ Canopy | snapshot ทั้งเคส → `ingest_workflow_forms` เขียน `formdev_record` (ทั้ง record, ตามเวลาล่าสุด) | `sync_ingest.py:190-204`, `workflows.py:256-312` |
| G | Packet PDF | สร้างในเบราว์เซอร์ Leaf: anesthesia report (Electron) + `buildFormPdf` ของแต่ละ form ตามลำดับ `packet` | `ReportView.tsx:824-871`, `casePacket.ts` |
| H | Timeline | field `timeline` ดึงค่าจาก Leaf (vitals/events) อัตโนมัติ | `formdev/leaf/timeline.ts`, `TimelineInput.tsx` |
| I | ตำแหน่งบน Leaf | `phase` / `after_section` / `hint` (เพิ่มในงานล่าสุด) | `caseWorkflow.ts:orderCaseTabs` |

---

## 2. ปัญหาที่พบ (เรียงตามความรุนแรง)

### ระดับวิกฤต: ข้อมูลหายหรือไม่ตรงกัน

| # | ปัญหา | ผลกระทบ | หลักฐาน |
|---|---|---|---|
| P1 | **ส่งต่อเคส (handover) แล้วข้อมูลฟอร์มหาย**: `case_form_record` ไม่อยู่ใน `CASE_TABLES` และ Leaf ปลายทางสร้าง `global_case_id` ใหม่ | ฟอร์มที่กรอกแล้วไม่ตามเคสไป และ Canopy ได้ record ซ้ำคนละ id | `case_handover.py:17-21`, `sync_ingest.py:66-67` |
| P2 | **ไฟล์แนบหาย**: panel บน Leaf ไม่มี `AttachmentContext` ไฟล์จึงอยู่แค่ในหน่วยความจำ และ Canopy ปฏิเสธ record ที่อ้างไฟล์ที่ไม่มี | ฟอร์มที่มีช่องไฟล์/รูป/ลายเซ็นภาพจะไม่เข้า Form Studio เลย | `WorkflowFormPanel.tsx:124`, `attachments.py:85-87` |
| P3 | **ตรวจข้อมูลไม่เท่ากัน**: server ของ Leaf ไม่ validate เลย เบราว์เซอร์ตรวจแค่ชนิดข้อมูลและช่องบังคับตอนกด Complete ส่วน Canopy ตรวจเต็ม (`evaluate_record`: เงื่อนไข, lookup, derived, ซ่อนแล้วล้างค่า) | ฟอร์มที่ "เสร็จ" บน Leaf อาจกลายเป็นร่างใน Form Studio หรือถูกทิ้งเงียบ ๆ (มีแค่ log) | `case_workflow.py:230-255`, `workflows.py:288-304` |
| P4 | **กติกาชนกันสองแบบ**: Leaf รวมทีละ field ตามเวลาของ field ส่วน Canopy แทนทั้ง record ตาม `updated_at` | แก้คนละที่แล้วข้อมูลอีกฝั่งหายทั้ง record | `form_sync.py`, `formdev/conflict.py`, `workflows.py:284-286` |
| P5 | **การส่งกลับไม่มีการยืนยันรายการ**: เป็น snapshot สถานะล่าสุด ไม่มี outbox/receipt ถ้า Canopy ปฏิเสธจะไม่ส่งซ้ำจนกว่าข้อมูลจะเปลี่ยน และเคสที่จำหน่ายเกิน 24 ชม. จะไม่ถูกส่งอีก | แก้ย้อนหลังไม่ขึ้น Canopy | `sync_worker.py:22,121-130`, `sync_ingest.py:198-204` |
| P6 | **`subject_id` ถูกเขียนทับด้วย SQL ตรง** ไม่ผ่าน `_persist` (ไม่มี revision และไม่เพิ่ม version) | ผู้ใช้ offline ของ Form Studio ไม่เห็นการเปลี่ยนแปลง และการ reindex ภายหลังคำนวณค่าใหม่ทับ | `workflows.py:305-307` |

### ระดับสูง: ใช้งานไม่ครบ

| # | ปัญหา | หลักฐาน |
|---|---|---|
| P7 | **ไม่มีการเติมค่าล่วงหน้า (prefill)**: ฟอร์ม workflow เริ่มว่างเสมอ HN ชื่อ อายุ น้ำหนัก ASA วันผ่าตัด ต้องพิมพ์ซ้ำทั้งที่มีอยู่ในเคสแล้ว | `WorkflowFormPanel.tsx:36` |
| P8 | **Leaf ไม่ส่ง lookup / roles ให้ฟอร์ม**: ตัวเลือกแบบ lookup และสิทธิ์ราย field ไม่ทำงานบน Leaf | `WorkflowFormPanel.tsx:124` เทียบกับ `FormDevWorkspace.tsx:292-296` |
| P9 | **Report Studio / AI Studio เห็นแค่ archive Innovian**: ไม่เห็นเคสจาก Leaf ไม่เห็น `formdev_record` และไม่เห็นบันทึกในตัว | `canopy_reports.py:344`, `report_engine.py:27-40` |
| P10 | **Packet ไม่ใช้ `mode` ที่ workflow กำหนด** (ใช้ค่าที่ผู้ใช้เลือกอยู่ แค่แสดงหมายเหตุ) และสร้างได้เฉพาะใน Electron, Canopy สร้าง packet ไม่ได้ | `ReportView.tsx:850-854` |
| P11 | **เปลี่ยน version ฟอร์มไม่มีการย้ายข้อมูลเคส**: เคสเดิมใช้ version ที่ pin ไว้ตลอด (ถูกตามหลัก แต่ไม่มีเครื่องมือย้าย) | `case_workflow.py:157-163` |

### ระดับกลาง: Offline

| # | ปัญหา | หลักฐาน |
|---|---|---|
| P12 | **ไม่มี Form Studio API บน Leaf** (router `formdev` เปิดเฉพาะ canopy) และ protocol `/api/formdev/sync` ใช้ token ของ Canopy | `main.py:125-127`, `routes/formdev.py:27` |
| P13 | **เบราว์เซอร์ทำงาน offline ไม่ได้**: ไม่มี service worker และ IndexedDB ใช้เฉพาะ Form Studio ใน Canopy ถ้า Leaf API ล่ม ค่าที่ยังไม่บันทึกหายเมื่อรีโหลด | `FormDevWorkspace.tsx:92-115` |
| P14 | **นิยามฟอร์มบน Leaf อยู่ใน JSON ก้อนเดียว** ไม่มี replicate `formdev_schema_version` / lookups / styles / fonts ไป Leaf | `case_workflow.py:74-81` |

---

## 3. ปัญหา Field ไม่ตรงกัน (หัวใจของเรื่อง "ตัวเชื่อม Field")

แนวคิดเดียวกันถูกเก็บ **6-8 ที่ ด้วยชื่อคนละแบบ** และ **ไม่มีที่ไหนประกาศว่าเป็นเรื่องเดียวกัน**:

| แนวคิด | บันทึกในตัว (FormView draft) | ตารางเคส Leaf | HIS / HL7 / Admission | Archive / Report Studio | Form Studio (template) |
|---|---|---|---|---|---|
| HN | `hn` | `cases.hn`, `case_his_patient.hn` | HL7 PID-3, `canopy_admission.hn` | `patient.hn` | `hn` + `subject_id` |
| เลข AN / Encounter | `an` | `cases.admission_number` | PV1-19 `admission_number` | `case.encounter_number` | `an` |
| ชื่อผู้ป่วย | `titleTh/firstName/lastName(+En)` | `case_his_patient.first_name…`, `cases.patient_display_name` | `patient_name` | `patient.name` | `patient_name` |
| น้ำหนัก / ส่วนสูง | `weightKg`/`heightCm` (ข้อความ) | `weight_kg`/`height_cm` | `WEIGHT`/`weight_kg` (HL7 ไม่มี) | archive `admission_weight`+unit (ไม่อยู่ใน catalog) | `weight`/`height` |
| อายุ / วันเกิด | `dob` (DD/MM/YYYY), `ageY`, `ageM` | `dob`, `age_text` | `DOB`, `AGE` | `patient.age_years` (คำนวณ) | `dob`, `age` |
| เพศ | ไม่มีใน draft | `sex` | `SEX/GENDER→sex` | `patient.gender` | `gender` |
| ASA | `asa` + `emergency` (boolean แยก) | `admission_metadata.asa_status` + `asa_emergency` | `asa_status` | `patient.asa_status` | `asa_status` ("2E" รวมกัน) |
| Diagnosis / Operation | `diagnosis[]`/`operation[]` | `case_diagnosis`/`case_procedure` (+concept_id) | `admission.diagnosis/operation` | `case.diagnosis`/`case.procedure` | `post_op_dx`/`operation` |
| เวลา anesthesia / surgery | ไม่มี (ใช้ชื่อ event มาเดา) | `case_event_note` | — | `case.started_at` / `case.completed_at` | ข้อความ `anesthesia_time` |
| เวลา PACU | `pacuArrivalTime`/`pacuDischargeTime` | — | — | `recovery.pacu` (มี/ไม่มี) | `recovery_start`/`recovery_end` |
| Vital signs | `preopBaselineHr`, `preopBaselineBp` (รวม) | `hr, spo2, nibp_sys…` (= `clinical_parameter_master`) | — | archive observation | timeline rows (+`bis, tof, insp_des…` ไม่มี concept) |
| เทคนิคยาระงับความรู้สึก | `anesthesiaTypes[]` (เป็นป้ายข้อความ) | `admission_metadata.anaesthesia_technique` | `anaesthesia_technique` | `anesthesia.technique` (`general_anesthesia`…) | — |
| หมู่เลือด | `bloodGroupABO`/`bloodGroupRh` | `blood_group_abo`/`blood_group_rh` | `ABO`/`RH` | archive `blood_type` | `blood_type` ("a_pos" รวมกัน) |

ข้อสังเกตเพิ่มเติม:
- **มีของเดิมที่ใช้ต่อยอดได้**: `clinical_concept` + `clinical_concept_coding` (SNOMED/LOINC/ICD…) และ `clinical_parameter_master` (vitals) (`0012-clinical-terminology.sql`) แต่ **ยังไม่มี domain สำหรับข้อมูลผู้ป่วย/เคส** (HN, น้ำหนัก, ASA, เวลา) และยังไม่มีใครใน draft, Form Studio, Report Studio หรือ HIS ใช้มัน
- **ค่าเดียวกันแต่รูปแบบต่างกัน** เช่น ASA (`asa`+`emergency` กับ `"2E"`), หมู่เลือด (ABO+Rh กับ `a_pos`), วันเกิด (DD/MM/YYYY กับ ISO), น้ำหนัก (ข้อความกับตัวเลข) แค่ map ชื่อจึงไม่พอ ต้องมี **ตัวแปลงค่า (transform)** ด้วย
- `asa_status` จากการรับผู้ป่วย **ไม่ถูกคัดลอก** ไป draft `asa` (`cases_lifecycle.py:135-221`) ซึ่งเป็นตัวอย่างของปัญหานี้ที่เกิดอยู่แล้วตอนนี้

---

## 4. สถาปัตยกรรมเป้าหมาย: "Form Studio เป็นศูนย์กลางของทุก Field"

### 4.1 หลักการ 5 ข้อ

1. **Field Dictionary กลางเดียว**: ทุกแนวคิดมี `concept_key` ถาวร เช่น `patient.hn`, `patient.weight_kg`, `case.asa`, `anesthesia.start_at`, `vital.hr`, `pacu.arrival_at` พร้อมชนิดค่า หน่วย ตัวเลือก และรหัสมาตรฐาน (ต่อยอดจาก `clinical_concept`)
2. **ฟอร์มผูก field กับ concept (binding)**: field ใน `flora.form/1` มีคุณสมบัติใหม่ `bind`
   ```json
   { "id": "weight", "type": "decimal", "unit": "kg", "bind": { "concept": "patient.weight_kg", "mode": "prefill" } }
   ```
   `mode`: `prefill` (เติมให้ตอนเปิด แก้ได้) · `sync` (สองทาง: แก้ในฟอร์มแล้วอัปเดตต้นทาง) · `readonly` (แสดงจากต้นทาง) · `capture` (ฟอร์มนี้เป็นต้นทางของค่านี้)
3. **Adapter ต่อระบบ**: concept หนึ่งตัวมีจุดอ่าน/เขียนในแต่ละระบบ (draft key, คอลัมน์ `case_his_patient`, HIS key, HL7 segment, archive resolver, Report Studio field) พร้อม transform เช่น `"2E" ↔ {asa:"2", emergency:true}` ทุก adapter อยู่ใน registry เดียวและมี test ครบทุกคู่
4. **ที่เก็บข้อมูลแบบ dynamic แบบเดียว**: ทุกฟอร์ม (รวมฟอร์มจาก workflow) เก็บแบบเดียวกับ `formdev_record` (`data jsonb` + `formdev_record_index` แบบ EAV + revision + receipt) ทั้งบน Leaf และ Canopy ฟอร์มใหม่จึงไม่ต้องสร้างตารางใหม่ และ query/report ได้ทันทีผ่าน index ของ field ที่ `indexed` หรือ `bind`
5. **กติกาเดียวทุกที่**: validator เดียวกัน (Python และ TS ที่ตรงกันอยู่แล้ว), conflict policy เดียวกัน (รวมทีละ field ตาม `field_versions` โดยทำเป็น resolver ใน `formdev/conflict.py`), record id เดียวกัน (UUID ของเคสที่คงที่ข้าม handover)

### 4.2 ภาพเป้าหมาย

```
                    Field Dictionary (concept_key, type, unit, codes, adapters)
                              ▲ bind             ▲ resolver           ▲ catalog
Form Studio definitions ──────┘                  │                    │
   │ publish                                     │                    │
   ▼                                             │                    │
Workflow Studio (forms + placement + packet + report)                 │
   │ ward sync (definitions + dictionary + lookups + styles)          │
   ▼                                                                  │
Flora Leaf: formdev API (leaf mode) ── formdev_record (+index, revision, receipt)
   │   ▲ prefill / sync จาก case tables ผ่าน adapter                    │
   │   └── เบราว์เซอร์: IndexedDbAdapter + SyncEngine (offline ได้)      │
   │ op outbox (idempotent, receipt)                                  │
   ▼                                                                  │
Canopy sync API → formdev_record (record เดียวกัน, id เดียวกัน) ───────┘
   ├─ Report Studio dataset "formdev" + concept fields (เห็นทั้ง Leaf และ archive)
   └─ Packet / Report PDF ฝั่ง server หรือ Canopy (ใช้ buildFormPdf ตัวเดียวกัน)
```

### 4.3 Report และ Form กรอกข้อมูลใช้ template เดียวกัน

- ฟอร์มหนึ่งตัวใช้ได้ทั้ง **กรอกข้อมูล** (FormRenderer) และ **พิมพ์รายงาน** (buildFormPdf / A4 แบบกระดาษ) เพราะใช้นิยามเดียวกัน ซึ่งทำได้แล้ววันนี้
- สิ่งที่ต้องเพิ่ม: packet entry ระบุ **mode ที่บังคับใช้จริง**, ส่วนหัวรายงานดึงจาก concept (`patient.*`, `case.*`) แทนการอ่าน draft key ตรง ๆ, และ **สร้าง packet ได้ทั้งบน Leaf และ Canopy** (ย้าย `casePacket.ts` ไปใช้ข้อมูลจาก formdev record)
- Report Studio เพิ่ม dataset ใหม่ที่อ่าน `formdev_record_index` ผ่าน concept field ให้รายงานรวมอ่าน "น้ำหนัก" ได้จากทุกฟอร์มที่ `bind` ไป `patient.weight_kg` โดยไม่ต้องรู้ชื่อ field ของแต่ละฟอร์ม

### 4.4 Offline (อนาคต) แบ่ง 2 ชั้น

| ชั้น | วันนี้ | เป้าหมาย |
|---|---|---|
| Leaf ↔ Canopy (วอร์ดขาดจากส่วนกลาง) | ทำได้แล้วบางส่วน (Leaf เป็นแหล่งข้อมูลจริง ส่ง snapshot ทีหลัง) | op outbox ทนทาน + receipt + retry, ไม่จำกัด 24 ชม., ส่งต่อ handover ได้ครบ |
| เบราว์เซอร์ ↔ Leaf API (เครื่อง/แท็บเล็ตหลุดจาก Leaf) | ทำไม่ได้ | ใช้ `IndexedDbAdapter` + `SyncEngine` ของ Form Studio ที่มีอยู่แล้วกับ Leaf formdev API, เพิ่ม service worker สำหรับเปิดแอปตอนไม่มีเน็ต |

ข้อดีของการใช้ protocol `/api/formdev/sync` ที่มีอยู่: เป็น op ทีละรายการ, idempotent ด้วย `op_id`, มี version ต่อ record, มีบันทึกการชน และทดสอบไว้แล้ว **ไม่ต้องคิดใหม่ ต้องย้ายมาเปิดบน Leaf และต่อ Leaf → Canopy เป็น relay ผ่าน sync API (shared secret)**

---

## 5. แผนพัฒนา (แบ่งเฟส แต่ละเฟสส่งมอบใช้งานได้จริง)

| เฟส | เนื้อหา | แก้ปัญหา | ความเสี่ยง |
|---|---|---|---|
| **0. แก้ด่วน (ไม่เปลี่ยนสถาปัตยกรรม)** | ใส่ `case_form_record` ใน handover; Leaf server validate ด้วย `evaluate_record`; ส่ง lookups/roles ให้ panel; ไฟล์แนบบน Leaf (อัปโหลดเข้า attachment store และส่งต่อ); ลบ SQL `subject_id` แล้วใช้ subject field ปกติ; คัดลอก `asa_status → asa` ตอนเริ่มเคส; ส่ง case ที่แก้หลัง 24 ชม. ด้วย (ตาม `updated_at` ของ form record) | P1, P2, P3, P5 (บางส่วน), P6, P8 | ต่ำ |
| **1. Field Dictionary** | ตาราง/registry `concept` (ต่อยอด `clinical_concept`: domain `patient`, `case`, `anesthesia`, `pacu`, `vital`…) + adapter + transform + test ครบทุกคู่; หน้า Form Studio "Field Dictionary"; validator รองรับ `bind` (Python + TS + schema + messages) | ตาราง §3 | กลาง (ต้องตกลงรายการ concept กับผู้ใช้งานทางคลินิก) |
| **2. Prefill / Sync ด้วย bind** | Leaf เปิดฟอร์มแล้วเติมค่าจาก concept; `sync` เขียนกลับ case tables ผ่าน adapter; AI builder และ designer เสนอ `bind` อัตโนมัติ (เช่น HN → `patient.hn`) | P7 | กลาง (ต้องกำหนดว่าใครเป็นต้นทางของค่า) |
| **3. ที่เก็บ dynamic เดียว + sync แบบ op** | เปิด router `formdev` โหมด leaf (auth ของ Leaf); workflow form เก็บเป็น `formdev_record` บน Leaf (ย้ายข้อมูลจาก `case_form_record`); record id = UUID เคสถาวร; outbox Leaf→Canopy ผ่าน `/api/sync/v1/formdev` ใช้ op และ receipt เดิม; resolver รวมทีละ field | P1 (ถาวร), P4, P5, P12, P14 | สูง (migration ข้อมูลเดิม, ต้องรันทั้ง PG Leaf และ Canopy) |
| **4. Report เป็นหนึ่งเดียว** | Report Studio dataset `formdev` + concept fields (Leaf และ archive รวมกัน); AI Studio ใช้ dataset ใหม่; packet ใช้ mode จริงและสร้างได้ใน Canopy; หัวรายงานอ่าน concept | P9, P10 | กลาง |
| **5. Offline ในเบราว์เซอร์** | Leaf ใช้ `IndexedDbAdapter`/`SyncEngine` กับ Leaf formdev API; service worker; หน้าแสดงคิวที่ยังไม่ส่ง | P13 | กลาง |
| **6. (ทางเลือก) บันทึกในตัวเป็น Form Studio** | ค่อย ๆ ย้ายแท็บของ FormView (preop, pacu …) เป็นนิยาม `flora.form/1` ที่ bind concept ให้ทั้งระบบเหลือรูปแบบเดียว | ความซ้ำซ้อนทั้งหมด | สูง (หน้าจอหลักที่ใช้ทุกวัน, ทำทีละแท็บ) |

ลำดับที่แนะนำ: **0 → 1 → 2 → 3 → 4 → 5** (เฟส 6 ตัดสินใจภายหลัง)
เฟส 0 ทำได้ทันทีและลดความเสี่ยงข้อมูลหาย ส่วนเฟส 1 เป็นฐานของทุกเฟสถัดไป

---

## 6. เรื่องที่ต้องตัดสินใจก่อนเริ่ม

1. **ต้นทางของค่า (source of truth) ต่อ concept**: เช่น น้ำหนัก ใช้ค่าจาก HIS, จากแบบฟอร์ม Pre-op หรือค่าที่บันทึกล่าสุด? ถ้าสองที่ขัดกันให้ใครชนะ?
2. **ชุดชื่อ concept**: ใช้รูปแบบ `domain.name` (แนะนำ: ตรงกับ Report Studio ที่มีอยู่ เช่น `patient.hn`) และควรผูกรหัสมาตรฐาน (LOINC/SNOMED) ตั้งแต่แรกหรือไม่
3. **บันทึกในตัว (FormView)**: เก็บเป็นระบบเดิมและเชื่อมด้วย adapter (เฟส 1-5) หรือวางแผนย้ายเป็น Form Studio ทั้งหมด (เฟส 6)
4. **ขอบเขต offline**: เพียงพอที่ "วอร์ดหลุดจาก Canopy" (ทำได้แล้ว) หรือต้องให้ "แท็บเล็ตหลุดจาก Leaf" ด้วย (เฟส 5)
5. **ข้อมูลเดิมใน `case_form_record`**: ย้ายเข้า `formdev_record` บน Leaf ทั้งหมดตอนเฟส 3 หรือเก็บไว้อ่านอย่างเดียว
6. **Report Studio**: รวม Leaf + archive Innovian ใน dataset เดียว หรือแยก dataset

---

## 7. ภาคผนวก: โค้ดที่เกี่ยวข้อง

- ส่ง/เก็บ workflow: `services/flora-api/app/workflows.py`, `routes/workflows.py`, `routes/case_workflow.py`, `routes/sync_ward.py`, `services/flora-sync-worker/sync_worker.py`
- กรอกบน Leaf: `frontend/src/components/workflow/WorkflowFormPanel.tsx`, `caseWorkflow.ts`, `frontend/src/views/FormView.tsx`
- กลับ Canopy: `routes/sync_ingest.py`, `workflows.ingest_workflow_forms`, `app/formdev/repositories.py`
- รายงาน: `frontend/src/views/ReportView.tsx`, `components/workflow/casePacket.ts`, `electron/reportPdf.cjs`, `formdev/render/formPdf.ts`, `routes/canopy_reports.py`, `report_engine.py`, `routes/ai_studio.py`
- Field/terminology: `infrastructure/postgres/0012-clinical-terminology.sql`, `0018-terminology-releases.sql`, `routes/terminology.py`, `frontend/src/utils/patientSharedFields.ts`, `routes/his.py`, `hl7_interface.py`, `routes/canopy_admissions.py`, `routes/cases_lifecycle.py`
- Form Studio storage/sync: `infrastructure/postgres/0060-formdev.sql`, `app/formdev/sync.py`, `conflict.py`, `frontend/src/formdev/offline/SyncEngine.ts`, `data/IndexedDbAdapter.ts`
