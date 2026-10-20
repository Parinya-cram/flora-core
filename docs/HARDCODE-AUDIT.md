# ตรวจจุดที่ hardcode และแนวทางทำให้เป็น dynamic

ตรวจเมื่อ 2026-10-20 ครอบคลุม `services/flora-api`, `services/flora-sync-worker`, `frontend/src`, `compose*` และ `.env.example`
- ไม่นับเทสต์ ข้อมูลตัวอย่าง (demo/seed) และตารางแปลภาษา
- ทุกบรรทัดในตารางตรวจกับโค้ดจริงแล้ว

## หลักการ: ค่าแต่ละแบบควรอยู่ที่ไหน

| ชนิดของค่า | ควรอยู่ที่ | เหตุผล |
|---|---|---|
| รหัสผ่าน / secret | env ที่ **บังคับต้องตั้ง** (ไม่มีค่าเริ่มต้นบน server) | ถ้าลืมตั้ง ระบบต้องไม่ยอมเปิด ไม่ใช่เปิดด้วยรหัส `admin` |
| ที่อยู่ระบบภายนอก (HIS, gateway, STT) | env ต่อ site และไม่มีค่าเริ่มต้นที่เป็นของโรงพยาบาลอื่น หรือหน้าตั้งค่าใน Canopy | แต่ละโรงพยาบาลมีเครือข่ายของตัวเอง |
| ข้อมูลของโรงพยาบาล (ชื่อ, โลโก้, **เขตเวลา**) | Hospital profile ใน Canopy (มีแล้ว และส่งไปทุก Leaf) | ตั้งครั้งเดียว ใช้ทุกที่ |
| รายการตัวเลือกทางคลินิก (เทคนิค, ปลายทาง, ยา, อุปกรณ์) | ตาราง terminology / lookup / catalog ที่มีอยู่แล้ว | ผู้ดูแลแก้เองได้โดยไม่ต้องแก้โค้ด |
| เกณฑ์ทางคลินิก (เช่น Aldrete ≥ 9) | score library (`canopy_score_definition`) | มีระบบนี้แล้ว |
| ค่าทางเทคนิค (timeout, polling, ขนาด) | env มีค่าเริ่มต้น และต้องเขียนไว้ใน `.env.example` | ไม่ต้องเปลี่ยนบ่อย แต่ต้องรู้ว่ามี |

**หลักเรื่องคีย์:** แยก **รหัสคงที่** (เช่น `ga`, `spinal`) ออกจาก **ข้อความที่แสดง** (เช่น "General anesthesia")
- โค้ด เช่น billing, การเปิดแท็บ และรายงาน ต้องอ้างรหัส ไม่อ้างข้อความ
- ตอนนี้หลายจุดอ้างข้อความตรง ๆ ทำให้แค่เปลี่ยนคำก็ทำให้ระบบพัง

## ลำดับความสำคัญ

### P1 — ความปลอดภัยและข้อมูลของโรงพยาบาลอื่น (ควรแก้ก่อน)

| จุด | ปัญหา | แนวทาง |
|---|---|---|
| `compose.server.yaml` บรรทัด 29–32, 72, 78, 81, 83, 111, 114, 150–151, 169, 172, 175 | ถ้าไม่ได้ตั้ง env รหัสผ่านฐานข้อมูล, session secret, sync secret และ admin จะเป็น `admin` ทั้งหมด และ server นี้เปิดให้ LAN เข้าได้ | ใช้ `${VAR:?ต้องตั้ง VAR}` ให้ stack ไม่ยอมเริ่มถ้าไม่ได้ตั้ง (dev compose ใช้ค่า `*-local-only` ได้ตามเดิม) |
| `app/bootstrap_admin.py:35` รหัสเริ่มต้น `admin`, `routes/fleet_read.py:555` Haber `admin/admin`, `routes/auth_leaf.py:27` รหัสพนักงานใหม่ `flora` | รหัสผ่านที่เดาได้ | ไม่มีค่าเริ่มต้นบน server: ถ้าไม่ได้ตั้ง bootstrap ให้สุ่มรหัสครั้งเดียว บังคับเปลี่ยน แล้วแสดงใน log ครั้งเดียว ส่วนพนักงานใหม่ให้สุ่มและบังคับเปลี่ยนเช่นกัน |
| `routes/his.py:18`, `compose/flora-leaf-api.yaml:30`, `compose/flora-multi-leaf.yaml:38`, `compose.server.yaml:88`, `.env.example:31` — `http://10.35.202.6:8590` | IP ภายในของ HIS โรงพยาบาลหนึ่งเป็นค่าเริ่มต้น site ใหม่ที่ลืมตั้งจะยิงไปเครือข่ายนั้น | ไม่มีค่าเริ่มต้น: ถ้าไม่ได้ตั้ง HIS ให้ปิดพร้อมข้อความ "ยังไม่ได้ตั้ง HIS" และในอนาคตย้ายไปหน้าตั้งค่า Canopy แบบเดียวกับ AI service |
| `compose.server.yaml:87` — `http://172.22.1.233:7410/…/leaf-or-01/…` | ที่อยู่ gateway อุปกรณ์ของ site เดียว | ใช้ค่าจาก gateway wizard (`leaf_device_source`) ที่มีอยู่แล้ว และไม่ใส่ค่าเริ่มต้นเป็น IP |
| `services/innovian_report.py:170` — "NEUROLOGICAL INSTITUTE OF THAILAND" | ชื่อโรงพยาบาลพิมพ์ลงหัวรายงานทุกหน้า | อ่านชื่อจาก Hospital profile (`hospital_profile.canopy_get`) ที่มีอยู่แล้ว |

### P2 — เขตเวลา (กระทบเวลาในข้อมูลทางคลินิก)

`Asia/Bangkok` / `+7` ฝังอยู่หลายที่ ถ้ามีโรงพยาบาลหรือ server ที่ไม่ได้อยู่ในเขตนี้ เวลาจะเพี้ยน:

| จุด | ใช้ทำอะไร |
|---|---|
| `concepts.py:19` `HOSPITAL_TZ` | วันที่ของข้อมูลเคส |
| `routes/cases_lifecycle.py:154` | วันที่ในรหัสเคส |
| `routes/case_workflow.py:454` | เวลาลงนามฟอร์ม |
| `hl7_interface.py:110` | อ่านเวลาใน HL7 |
| `formdev/definition.py:75`, `formdev/query/validator.py:430`, `formdev/logic/evaluate.py:23` | offset 420 นาทีของ Form Studio |
| `routes/legacy_archive.py:549,566`, `services/innovian_report.py:503-505` | เวลาในรายงานจากระบบเก่า (+7 ชม. ตายตัว) |
| `routes/fleet_control.py:62,72,264,396`, `routes/ward.py:302`, `routes/sync_ward.py:293` | ค่าเริ่มต้นของ location / workstation (ค่านี้ตั้งได้อยู่แล้ว) |

**แนวทาง**
1. เพิ่ม `timezone` ใน Hospital profile โดยใช้ค่าเริ่มต้นจาก env `FLORA_HOSPITAL_TZ` แล้วค่อยใช้ `Asia/Bangkok`
2. สร้างฟังก์ชันกลาง `hospital_tz()` ที่เดียว แล้วให้ทุกจุดข้างบนเรียกฟังก์ชันนี้
3. รายงานจากระบบเก่าให้ใช้เขตเวลาของ source ที่ import มา (เก็บไว้ตอน import) ไม่ใช่ +7 ตายตัว

### P3 — รายการตัวเลือกทางคลินิกในหน้าบันทึกการระงับความรู้สึก

ทุกรายการอยู่ใน `frontend/src/views/FormView.tsx` ยกเว้นที่ระบุไฟล์ไว้:

| รายการ | จุด | ใช้ที่ไหนต่อ |
|---|---|---|
| เทคนิคการระงับความรู้สึก | `options.anesthesia` (:241) | ใช้เป็นคีย์ใน `ANESTHESIA_TAB_MAP` (:129) และ `billing.py:162` `TECHNIQUE_FROM_FORM` เปลี่ยนคำแล้ว billing กับการเปิดแท็บจะพัง |
| ปลายทางหลังผ่าตัด | :2988 `["PACU","ICU","Ward","Death"]` | `billing.py:218` |
| ปลายทางจาก PACU | :3460, :3474 | — |
| หน่วยบริการ / specialty | :238 (มีรหัสของ site เช่น `G1–G4`) | — |
| ท่าผ่าตัด, monitor, extubation | :247, :244, :339 | — |
| อุปกรณ์ทางเดินหายใจ, เข็ม, block, CVC, ยาเตรียมจมูก | ประมาณ :252–338 | — |
| เทคนิค / ASA / priority ฝั่ง Canopy | `CanopyAdmissionsView.tsx:28-30`, `IdleCaseLanding.tsx:108` | รายการไม่ตรงกับ FormView |
| ยา bolus / drip ที่แนะนำ | `utils/medicationBolus.ts`, `utils/medicationDrip.ts`, `InputOutputBalanceView.tsx:192` | ได้มาจากข้อมูลระบบเก่าของ NIT |
| สารน้ำ, blood product | `FluidEntryModal.tsx:51-75`, `BloodProductEntryModal.tsx:7` | — |
| route / หน่วยยา | `InputOutputBalanceView.tsx:143,161` และ `ClinicalChartView.tsx:338,353` (ซ้ำกันสองที่) | — |
| สารก่อภูมิแพ้, ความรุนแรง, คำนำหน้า | `LeftRail.tsx:176-196`, `PatientView.tsx:80-89` | — |
| เหตุการณ์ใน timeline | `clinical-chart/constants.ts:182-199` | `billing.py:166` อ้างข้อความ "Start Anesthesia", "End Surgery" |
| บทบาทผู้ลงนาม | `billing.py:24`, `BillingView.tsx:21` | — |
| แท็บ / ส่วนหลักของฟอร์ม | `workflows.py:27-42` และ `FormView.tsx:71-86` | นิยามซ้ำทั้ง backend และ frontend |

**แนวทาง** (ใช้ระบบที่มีอยู่แล้ว ไม่ต้องสร้างใหม่)
1. **ยา, สารน้ำ, blood product** → ตาราง terminology ที่มี domain `medication`, `fluid`, `blood_product` อยู่แล้ว และ `io_item_master` ส่วนรายการ "ยอดนิยม" ให้คำนวณจากการใช้จริงในฐานข้อมูล ไม่ใช่ลิสต์จากโรงพยาบาลเดียว
2. **รายการตัวเลือกทั่วไป** (ท่าผ่าตัด, monitor, อุปกรณ์, ปลายทาง, specialty, สารก่อภูมิแพ้, route) → ใช้ formdev lookups (`/api/formdev/lookups`) เป็น "รายการตัวเลือก" ที่แก้ได้ใน Canopy แล้วส่งไป Leaf เหมือนข้อมูลอื่น
   - ทุกรายการเป็นรูป `{code, label_th, label_en, active, sort}`
   - หน้าจอแสดง label ส่วนข้อมูลเก็บ code
3. **คีย์ที่ระบบใช้ต่อ** (เทคนิค, ปลายทาง, เหตุการณ์ในตาราง) ให้มี code คงที่ เช่น `ga`, `spinal`, `pacu`, `anesthesia_start` แล้วให้ billing / tab map / รายงานอ้าง code
   - ตอนย้ายต้องมี migration แปลงค่าข้อความเดิมเป็น code
4. **แท็บของฟอร์มหลัก** → ให้ `workflows.py` เป็นแหล่งเดียว และ frontend อ่านจาก API แทนการนิยามซ้ำ

### P4 — เกณฑ์ ตัวเลขการทำงาน และ mapping ของระบบเก่า

| จุด | ค่า | แนวทาง |
|---|---|---|
| `FormView.tsx:3458` | Aldrete ≥ 9 ถือว่าพร้อมออกจาก PACU | ใช้ cut-off ใน `scoring_library/aldrete.json` / `canopy_score_definition` ที่มีอยู่แล้ว |
| `hl7_interface.py:195` | ช่วงเวลา 36 ชม. สำหรับจับคู่ booking กับ order | ย้ายไปไว้ใน config ของ HL7 interface |
| `hl7_interface.py:32-33` | ชนิดข้อความ HL7 ที่สร้าง/ยกเลิกเคส | ย้ายไปไว้ใน config ของ HL7 interface |
| `routes/cases_read.py:15` (5 นาที), `routes/sync_ward.py:20` (online 60 วินาที), `api_keys.py:26` (300 ครั้ง/นาที) | ค่าการทำงาน | env พร้อมค่าเริ่มต้นเดิม |
| polling ใน frontend (10–60 วินาที ใน 6 ไฟล์) | ค่าการทำงาน | ค่าคงที่กลางไฟล์เดียว หรือ `VITE_*` (ความสำคัญต่ำ) |
| `routes/canopy_reports.py:26-32` | component id ของ Innovian (4490, 898, …) | ตาราง mapping ต่อ source ใน `canopy_report_definition` |
| `canopy_reports.py:278,290` | ชื่อในระบบเก่า (รวมคำสะกดผิด `'inubating lma'`) | ตาราง mapping ต่อ source |
| `legacy_archive.py:56+,747` | `PARAMETER_ALIASES`, การหา PACU จากชื่อ | ตาราง mapping ต่อ source |
| `components/billing/billingSheet.ts:67` | หัวกระดาษ billing | อ่านจาก Hospital profile หรือแม่แบบ Form Studio |

### P5 — ตั้งค่าได้แล้ว แต่ไม่มีใครรู้ว่ามี

มี env ประมาณ 36 ตัวที่โค้ดอ่าน แต่ไม่มีใน `.env.example` และ compose เช่น:
- **การเชื่อมต่อและ session:** `HIS_GATEWAY_TIMEOUT_SECONDS`, `FLORA_STT_URL`, `FLORA_HABER_URL`, `FLORA_AUTH_SESSION_TTL_MS`, `FLORA_CANOPY_SESSION_TTL_SECONDS`
- **Form Studio:** `FORMDEV_AI_TIMEOUT_S`, `FORMDEV_ATTACHMENT_MAX_BYTES`, `FLORA_UPLOAD_MAX_TOTAL_MB`
- **การเก็บข้อมูล:** `FLORA_SYNC_MESSAGE_KEEP_DAYS`, `FLORA_DEVICE_AUDIT_KEEP_DAYS`

**แนวทาง**
- เขียนทุกตัวลง `.env.example` แบ่งหมวด พร้อมค่าเริ่มต้นและคำอธิบาย
- เพิ่มเทสต์ใน CI ที่ล้มเมื่อโค้ดอ่าน env ใหม่ที่ไม่มีใน `.env.example` เพื่อไม่ให้กลับมาเป็นแบบนี้อีก

## ที่ทำดีอยู่แล้ว (ไม่ต้องแก้)
- ที่อยู่ backend ฝั่ง frontend: ใช้ค่าจาก desktop → `VITE_FLORA_BACKEND_BASE` → `window.location.origin` ตามลำดับ
- ไม่มีรูปแบบ HN, ward id หรือ leaf id ฝังในโค้ดแอป (มีเฉพาะใน demo และค่าเริ่มต้นของ dev)
- score อย่าง NEWS2 / MEWS เป็นข้อมูลอยู่แล้ว
- Hospital profile, terminology, lookups, workflows และ location tree เป็นกลไกที่ใช้ต่อได้ทันที
