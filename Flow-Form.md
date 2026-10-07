# MASTER PROMPT

# Universal Form Schema Engine (UFSE)

คุณกำลังทำหน้าที่เป็น Senior Software Architect + Senior Full-Stack Developer + Database Engineer + QA Engineer

เป้าหมายของงานนี้คือการสร้างระบบกลางชื่อ:

**Universal Form Schema Engine (UFSE)**

ระบบนี้ต้องทำหน้าที่เป็น Form Platform สำหรับสร้าง Form, จัด Layout, จัด Style, จัด Logic, Calculator, Validation, Data Storage, Query, Offline และนำ Form Definition เดิมไปใช้งานแบบ Standalone / Intranet / Offline / Server ได้

==================================================

## 1. เป้าหมายหลัก

==================================================

ระบบต้องมีคุณสมบัติ:

1. สร้าง Form ได้ง่าย
2. Form Definition ใช้ JSON เป็น Canonical Format
3. มี Text DSL สำหรับสร้าง/แก้ Form ได้ง่าย
4. สามารถ Render Form เดียวกันในหลาย Environment
5. Form ไม่ผูกกับ Database Vendor
6. Form ไม่ผูกกับ UI Framework
7. Style แยกจาก Data Schema
8. มี style_id ของ Form / Section / Field
9. สามารถเพิ่ม Style ใหม่ได้โดยไม่แก้ Form Core
10. สามารถเลือก Style ได้จาก Style Registry
11. สามารถกำหนด visible / hidden ของแต่ละ Field
12. สามารถเก็บ Field ที่ซ่อนไว้ใน Database ได้
13. มี Validation
14. มี Conditional Visibility
15. มี Dependency
16. มี Calculator / Formula Engine
17. รองรับ Answer + Other
18. รองรับ Repeatable Field / Group
19. รองรับ Permission ระดับ Form / Section / Field
20. รองรับ A4 Standard Paper
21. รองรับ 13+1 Thai Official Fonts ผ่าน Font Registry
22. รองรับ Web
23. รองรับ Intranet
24. รองรับ Offline
25. รองรับ Standalone
26. รองรับ SQLite / Server Database / REST API ผ่าน Adapter
27. รองรับ Pagination
28. รองรับ Cursor Pagination
29. รองรับ Index
30. รองรับ Query Validation
31. รองรับ Query Cache
32. รองรับ Background Query / Export Job
33. ป้องกัน Query ที่ทำให้ Server Timeout
34. รองรับ Version ของ Form Schema
35. รองรับ Offline Sync
36. รองรับ Conflict Resolution
37. รองรับ AI-generated Form ในอนาคต
38. Core ต้องไม่มี dependency ที่จำเป็นต้องเชื่อม SaaS ภายนอก

==================================================

## 2. หลักการ Architecture

==================================================

ให้แยกระบบออกเป็น:

FORM DESIGNER
↓
FORM SCHEMA
↓
SCHEMA VALIDATOR
↓
RENDER ENGINE
↓
DATA ENGINE
↓
QUERY ENGINE

และมีระบบเสริม:

STYLE ENGINE
CALCULATOR ENGINE
VALIDATION ENGINE
PERMISSION ENGINE
SYNC ENGINE
CACHE ENGINE
AI FORM GENERATOR

หลักการสำคัญ:

### Form Definition ต้องไม่รู้ Database Vendor

ห้ามผูก Schema กับ:

* PostgreSQL syntax
* MySQL syntax
* SQLite syntax
* ORM-specific object
* UI component-specific property

### UI ต้องไม่เป็นเจ้าของ Business Logic

Logic ต้องอยู่ใน Schema / Engine

### Database ต้องไม่เป็นเจ้าของ Presentation

Style และ Layout ต้องแยกจาก Data

==================================================

## 3. ID Strategy

==================================================

ต้องแยก:

form_id
schema_version
section_id
field_id
record_id
style_id
font_id
calculator_id
query_id
sync_id

และให้มี stable key แยกจาก database identity

ตัวอย่าง:

id = internal identity
key = "bp_sys"

ห้ามเขียน Formula โดยอ้าง numeric database ID

Formula ต้องอ้าง Field Key

ตัวอย่าง:

bp_sys
bp_dia
pulse
spo2
weight
height

==================================================

## 4. Security

==================================================

ห้ามใช้:

eval()
new Function()
dynamic executable JavaScript จาก Form JSON
unsafe SQL concatenation

Formula ต้องผ่าน Parser / AST / Safe DSL

Query ต้องผ่าน Query Validator

ทุก Query ที่มาจาก User หรือ Dynamic Form ต้อง:

1. Validate
2. Authorize
3. Limit
4. Optimize
5. Execute

==================================================

## 5. Data Safety

==================================================

ห้ามใช้:

SELECT * FROM huge_table

โดยไม่มี:

* Filter
* Pagination
* Limit

ห้ามโหลด Dataset จำนวนมากเข้าหน่วยความจำโดยไม่มีเหตุผล

ต้องสนับสนุน:

LIMIT
CURSOR
INDEX
PROJECTION
FILTER
SORT

Large Export ต้องแยกเป็น Background Job

==================================================

## 6. Versioning

==================================================

Form ทุกตัวต้องมี:

form_id
schema_version
status
created_at
updated_at

ข้อมูลที่บันทึกต้องรู้ว่าใช้ Schema Version ไหน

ห้ามแก้ Schema Version เก่าจน Data เก่าอ่านไม่ได้

==================================================

## 7. Development Rule

==================================================

ก่อนแก้ไข Code ให้:

1. ตรวจสอบ Project Structure
2. ตรวจสอบ Existing Architecture
3. ตรวจสอบ Dependency
4. ตรวจสอบ Database
5. ตรวจสอบ Existing API
6. ตรวจสอบ Testing
7. ตรวจสอบ Build System

ห้ามสร้าง Architecture ใหม่โดยไม่ดูระบบเดิม

ถ้ามีระบบเดิมที่สามารถ Reuse ได้ ให้ Reuse

ห้าม Rewrite Project ทั้งระบบโดยไม่จำเป็น

แก้เฉพาะส่วนที่จำเป็น

==================================================

## 8. Coding Rule

==================================================

Code ต้อง:

* Production-ready
* Typed
* Modular
* Testable
* Maintainable
* มี Error Handling
* มี Logging
* ไม่ Duplicate Logic
* ไม่สร้าง Helper ซ้ำโดยไม่จำเป็น

ทุก Module ต้องมี Responsibility ชัดเจน

==================================================

## 9. Output ที่ต้องรายงานทุก Phase

==================================================

เมื่อทำงานเสร็จแต่ละ Phase ให้รายงาน:

### A. Files Created

รายชื่อไฟล์ที่สร้าง

### B. Files Modified

รายชื่อไฟล์ที่แก้

### C. Architecture

อธิบายว่า Module ใหม่เชื่อมกับระบบเดิมอย่างไร

### D. Database Changes

Migration / Table / Index ที่เพิ่ม

### E. API Changes

Endpoint ใหม่

### F. Tests

Test ที่เพิ่ม

### G. Verification

คำสั่งที่ใช้ Run Test / Build / Lint

### H. Known Issues

ปัญหาที่ยังเหลือ

### I. Phase Acceptance

ตรวจทุก Acceptance Criteria แล้วระบุ PASS / FAIL

ห้ามรายงานว่า PASS ถ้ายังไม่ได้ Execute Test จริง

==================================================

## 10. Execution Rule

==================================================

อย่าเพียงอธิบายวิธีทำ

ต้อง:

* Inspect
* Design
* Implement
* Test
* Fix
* Verify

ถ้าพบปัญหาระหว่างทาง ให้แก้ก่อนสรุป

แต่ห้ามเปลี่ยน Scope ไป Phase ถัดไปเอง

# เมื่อ Phase ปัจจุบันเสร็จแล้ว ให้หยุดที่ Phase นั้น


# PHASE 1 — FORM SCHEMA CORE + DESIGN SYSTEM

เริ่มพัฒนาจาก Master Prompt

เป้าหมายของ Phase นี้คือสร้าง Core ของ Form System โดยยังไม่ต้องพัฒนา Advanced Query และ Offline Sync เต็มรูปแบบ

==================================================

## PHASE 1.1 — Form Schema

==================================================

สร้าง JSON Schema มาตรฐาน Version 1

ต้องรองรับอย่างน้อย:

form
metadata
paper
style
sections
fields
layout
validation
visibility
permission
calculators

ตัวอย่างโครงสร้าง:

{
"form": {
"id": "patient_assessment",
"version": 1,
"title": "แบบประเมินผู้ป่วย",
"status": "draft",

```
"paper": {
  "size": "A4",
  "orientation": "portrait"
},

"style": {
  "id": "form.a4.medical"
},

"sections": []
```

}
}

อย่าจำกัด Schema จนไม่สามารถต่อยอดได้

==================================================

## PHASE 1.2 — ID System

==================================================

กำหนดมาตรฐาน:

form_id
section_id
field_id
record_id
style_id
font_id
calculator_id

Field ต้องมี:

id
key
type
label

ตัวอย่าง:

{
"id": "fld_001",
"key": "bp_sys",
"type": "number",
"label": "ความดันตัวบน"
}

==================================================

## PHASE 1.3 — Field Types

==================================================

ต้องรองรับ:

text
textarea
number
decimal
integer
date
datetime
time
select
radio
checkbox
switch
file
image
signature
calculated
group
repeat

เตรียม Architecture ให้เพิ่ม Field Type ใหม่ได้โดยไม่แก้ Core จำนวนมาก

ใช้ Registry Pattern หรือ Strategy Pattern ตามความเหมาะสม

==================================================

## PHASE 1.4 — Field Display

==================================================

Field ต้องรองรับ:

visible
readonly
required

และ Display Policy:

form
table
detail
query
export

ตัวอย่าง:

"display": {
"form": false,
"table": false,
"detail": false,
"query": true,
"export": true
}

จุดประสงค์คือ:

user_id อาจถูกเก็บใน Database
แต่ไม่จำเป็นต้องแสดงใน Form

==================================================

## PHASE 1.5 — Layout Engine

==================================================

สร้าง Layout Schema

ต้องรองรับ:

row
column
grid
group
nested section

อย่างน้อยต้องรองรับ 12-column grid

ตัวอย่าง:

{
"layout": {
"type": "grid",
"columns": 12
}
}

Field สามารถกำหนด:

col
row
span

และต้องเตรียม Responsive Rule

Desktop
Tablet
Mobile
Print

==================================================

## PHASE 1.6 — A4

==================================================

A4 ต้องเป็น First-Class Configuration

รองรับ:

A4 portrait
A4 landscape
margin
header
footer
page break

Default:

210mm x 297mm

สร้าง Print Layout แยกจาก Screen Layout

==================================================

## PHASE 1.7 — Font Registry

==================================================

สร้าง Font Registry

Field / Style ต้องอ้าง:

font_id

ห้าม hard-code font family ลงใน Form ทุกตัว

เตรียมรองรับ 13+1 Thai Official Fonts

แต่ต้องแยก:

font registry
font metadata
font assets
font fallback

และต้องไม่ฝัง Font File ลง Repository โดยไม่ได้รับอนุญาต

==================================================

## PHASE 1.8 — Style Registry

==================================================

สร้างระบบ:

style registry

ต้องรองรับ:

style_id
name
category
inherit
tokens
component styles

ตัวอย่าง:

style.a4.default
style.a4.medical
style.a4.official
style.a4.compact
field.text.default
field.number.large
section.header

==================================================

## PHASE 1.9 — Style Inheritance

==================================================

รองรับ:

base style
↓
form style
↓
section style
↓
field style
↓
instance override

ตัวอย่าง:

{
"style": {
"id": "form.a4.medical",
"override": {
"fontSize": 14
}
}
}

ห้าม Duplicate Style ทั้งหมดเพียงเพื่อเปลี่ยน Property เดียว

==================================================

## PHASE 1.10 — JSON Validator

==================================================

สร้าง Schema Validator

ต้องตรวจ:

required fields
type
enum
invalid property
duplicate key
invalid ID
broken references
invalid style_id
invalid field reference
invalid calculator reference

ต้องมี Error Message ที่อ่านง่าย

==================================================

## PHASE 1.11 — Preview

==================================================

สร้าง Preview Renderer อย่างน้อย:

Desktop
Mobile
A4 Print

ต้องสามารถ Load JSON แล้ว Render Form ได้

==================================================

## PHASE 1.12 — Tests

==================================================

เพิ่ม Unit Test สำหรับ:

Schema Validation
Field Registry
Style Registry
Layout
A4
Display Policy
Invalid Schema

==================================================

## PHASE 1 ACCEPTANCE CRITERIA

==================================================

ถือว่า Phase 1 เสร็จเมื่อ:

[ ] JSON Schema ทำงานจริง
[ ] Field Registry ทำงานจริง
[ ] Style Registry ทำงานจริง
[ ] Font Registry ทำงานจริง
[ ] A4 Preview ทำงาน
[ ] Print Layout ทำงาน
[ ] Hidden Field ทำงาน
[ ] Responsive Layout ทำงาน
[ ] Validation ทำงาน
[ ] Unit Tests ผ่าน
[ ] Existing Project Build ผ่าน
[ ] Existing Tests ไม่พัง

ห้ามเริ่ม Phase 2 จนกว่าจะผ่านรายการด้านบน

==================================================

# PHASE 2 — FORM LOGIC ENGINE

==================================================

ต่อยอดจาก Phase 1

เป้าหมายคือทำให้ Form สามารถคิดและควบคุมตัวเองได้

==================================================

## PHASE 2.1 — Validation Engine

==================================================

รองรับ:

required
min
max
minLength
maxLength
pattern
email
numeric
date range
custom validation rule

ตัวอย่าง:

{
"validation": {
"required": true,
"min": 40,
"max": 250
}
}

Error ต้องผูกกับ field_id/key

==================================================

## PHASE 2.2 — Visibility Engine

==================================================

ต้องรองรับ Conditional Visibility

ตัวอย่าง:

{
"visibility": {
"when": {
"field": "has_fever",
"operator": "equals",
"value": true
}
}
}

รองรับ:

equals
not_equals
gt
gte
lt
lte
in
not_in
exists
empty

และรองรับ AND / OR

ตัวอย่าง:

has_fever == true
AND
age >= 60

==================================================

## PHASE 2.3 — Dependency Engine

==================================================

รองรับ dependency ระหว่าง Field

ตัวอย่าง:

province
→ district
→ subdistrict
→ postcode

และ:

diagnosis
→ treatment

ต้องสามารถ Trigger Update ได้เมื่อค่าต้นทางเปลี่ยน

==================================================

## PHASE 2.4 — Calculator Engine

==================================================

สร้าง Safe Formula DSL

ห้าม:

eval()
new Function()

ต้องสร้าง:

Tokenizer
Parser
AST
Evaluator

รองรับ:

*

-

*

/
%
^
()
compare
AND
OR
IF
MIN
MAX
ROUND

Formula ต้องอ้าง Field Key

ตัวอย่าง:

BMI =
weight / ((height / 100) ^ 2)

==================================================

## PHASE 2.5 — Medical Calculator

==================================================

Architecture ต้องรองรับ Formula ที่มีความซับซ้อนเพิ่มภายหลัง

ตัวอย่าง:

BMI
MAP
BSA
Age calculation
Risk score
Total score
Percentage
Sub-score

ห้าม Hard-code Calculator ใน UI

Calculator ต้องเป็น Definition

==================================================

## PHASE 2.6 — Answer + Other

==================================================

รองรับ:

radio
select
checkbox

และ:

Other + free text

ตัวอย่าง:

{
"value": "other",
"label": "อื่นๆ",
"has_input": true
}

ข้อมูล Answer และ Other ต้องเก็บอย่างเป็นระเบียบ

==================================================

## PHASE 2.7 — Repeatable Group

==================================================

รองรับ:

repeat field
repeat section
nested group

ตัวอย่าง:

medications[]

แต่ละรายการประกอบด้วย:

drug_name
dose
frequency

ต้องสามารถ Add / Remove / Reorder ได้

==================================================

## PHASE 2.8 — Permission

==================================================

รองรับ Permission:

form
section
field
action

เช่น:

view
create
edit
delete
export

Role:

admin
doctor
nurse
staff
patient

ต้องสามารถซ่อน Field ตาม Role

==================================================

## PHASE 2.9 — Versioning

==================================================

Form ต้องมี:

schema_version

และ Runtime ต้องรู้ว่า Record ถูกสร้างจาก Version ใด

ห้ามทำให้ Form Version ใหม่ทำลายข้อมูลเก่า

==================================================

## PHASE 2.10 — Logic Graph

==================================================

สร้าง Internal Dependency Graph

ตัวอย่าง:

weight
↓
BMI
↓
BMI classification

ถ้า Field มี Circular Dependency ต้อง Detect และ Reject

==================================================

## PHASE 2.11 — Tests

==================================================

ต้องมี Test สำหรับ:

validation
visibility
dependency
calculator
circular dependency
repeat
answer + other
permission
versioning

==================================================

## PHASE 2 ACCEPTANCE CRITERIA

==================================================

[ ] Validation ทำงานจริง
[ ] Conditional Visibility ทำงาน
[ ] Dependency ทำงาน
[ ] Formula Engine ทำงาน
[ ] ไม่มี eval/new Function
[ ] Calculator ทำงาน
[ ] Answer + Other ทำงาน
[ ] Repeatable Group ทำงาน
[ ] Permission ทำงาน
[ ] Circular dependency ถูกตรวจจับ
[ ] Versioning ทำงาน
[ ] Tests ผ่าน
[ ] Existing App Build ผ่าน

หยุดหลัง Phase 2

# PHASE 3 — DATA ENGINE + OFFLINE + STANDALONE

==================================================

ต่อยอดจาก Phase 1 และ Phase 2

เป้าหมายคือทำให้ Form Definition สามารถนำไปใช้งานจริงกับหลาย Data Source โดยไม่ผูกกับ Database Vendor

==================================================

## PHASE 3.1 — Data Model

==================================================

สร้าง Conceptual Model:

Form Definition
Form Record
Form Value
Form Index
Schema Version

Minimum metadata:

record_id
form_id
schema_version
created_at
created_by
updated_at
updated_by
status
sync_id
version

==================================================

## PHASE 3.2 — Hybrid Data Model

==================================================

ใช้แนวทาง Hybrid

Core metadata เก็บเป็น Column ปกติ

Dynamic Form Data เก็บตามความเหมาะสม เช่น JSON

แต่ Field ที่ต้อง Query บ่อยต้องสามารถสร้าง Index ได้

ห้ามใช้ JSON เป็นเหตุผลให้ทุก Query ต้อง Scan ทั้ง JSON

==================================================

## PHASE 3.3 — Data Adapter

==================================================

สร้าง Interface กลาง:

DataAdapter

รองรับ:

SQLiteAdapter
PostgreSQLAdapter
MySQLAdapter
RestApiAdapter

ถ้า Project ใช้ Database อื่นอยู่ ให้ทำ Adapter ตาม Existing Stack

Form Engine ต้องไม่รู้ว่ากำลังใช้ Database ตัวไหน

==================================================

## PHASE 3.4 — Repository Layer

==================================================

สร้าง:

FormRepository
RecordRepository
SchemaRepository
StyleRepository

UI ห้ามยิง Database โดยตรง

==================================================

## PHASE 3.5 — Local Storage

==================================================

Standalone / Offline ต้องทำงานได้โดยไม่มี Server

แนะนำ SQLite สำหรับ Desktop / Mobile

และ IndexedDB หรือ SQLite WASM ตาม Environment ที่ Project รองรับ

ต้องสามารถ:

Create
Read
Update
Delete
Search
Draft
Submit

ใน Offline Mode

==================================================

## PHASE 3.6 — Offline Queue

==================================================

สร้าง Sync Queue

ตัวอย่างสถานะ:

pending
processing
success
failed
conflict

ข้อมูล Offline ต้องไม่หายเมื่อ Application ปิด

==================================================

## PHASE 3.7 — Sync

==================================================

เมื่อกลับ Online:

Local
↓
Sync Queue
↓
Server
↓
Acknowledge

ต้องมี:

retry
backoff
idempotency
failure recovery

==================================================

## PHASE 3.8 — Conflict Resolution

==================================================

รองรับอย่างน้อย:

last-write-wins

และออกแบบให้เพิ่ม:

field-level merge

ในอนาคตได้

==================================================

## PHASE 3.9 — Standalone Bundle

==================================================

สร้าง Form Package ที่ประกอบด้วย:

form.json
styles
font metadata
assets
schema version
optional seed data

ตัวอย่าง:

patient-assessment.formpack

Form Package ต้องสามารถนำไปติดตั้งใน Standalone Environment ได้

==================================================

## PHASE 3.10 — Intranet

==================================================

ต้องสามารถ Deploy ใน LAN ได้ โดยไม่ต้องพึ่ง Internet

ตรวจสอบ:

API URL
Local Database
Asset Loading
Font Loading
Authentication
Sync

==================================================

## PHASE 3.11 — Data Migration

==================================================

สร้าง Migration Strategy

หาก Schema Version เปลี่ยน:

v1
↓
Migration
↓
v2

ต้องไม่ทำลาย Existing Records

==================================================

## PHASE 3 ACCEPTANCE CRITERIA

==================================================

[ ] SQLite ใช้งานได้
[ ] Server Adapter ใช้งานได้
[ ] Form ไม่ผูก DB Vendor
[ ] CRUD ใช้งานได้
[ ] Offline ใช้งานได้
[ ] Sync Queue ทำงาน
[ ] Retry ทำงาน
[ ] Conflict ถูก Detect
[ ] Standalone Form Package ใช้งานได้
[ ] Intranet ใช้งานได้
[ ] Migration ทำงาน
[ ] Tests ผ่าน

หยุดหลัง Phase 3

# PHASE 4 — QUERY ENGINE + PERFORMANCE + LARGE DATA

==================================================

เป้าหมายของ Phase นี้คือป้องกัน Query Timeout, Memory Explosion และ Database Load ที่ไม่จำเป็น

==================================================

## PHASE 4.1 — Query Definition

==================================================

สร้าง Query Schema

ต้องรองรับ:

query_id
source
select
filter
sort
pagination
limit
timeout
cache
export

ตัวอย่าง:

{
"query": {
"id": "patient_list",
"source": "patient",
"select": [
"hn",
"name",
"age",
"status"
],
"pagination": {
"mode": "cursor",
"limit": 50
}
}
}

==================================================

## PHASE 4.2 — Query Builder

==================================================

สร้าง Visual / Programmatic Query Builder

รองรับ:

SELECT fields
FILTER
AND
OR
SORT
LIMIT
GROUP
AGGREGATE

ต้องไม่เปิดให้ UI เขียน SQL โดยตรง

==================================================

## PHASE 4.3 — Query Validator

==================================================

ตรวจ:

missing filter
missing limit
invalid field
unauthorized field
invalid sort
invalid relation
dangerous operation

Query ต้องผ่าน Validator ก่อน Execute

==================================================

## PHASE 4.4 — Projection

==================================================

ห้าม SELECT * โดยไม่จำเป็น

ให้ Query ระบุ Field ที่ต้องใช้เท่านั้น

==================================================

## PHASE 4.5 — Pagination

==================================================

รองรับ:

offset pagination

และต้องให้ความสำคัญกับ:

cursor pagination

สำหรับ Dataset ขนาดใหญ่

Cursor ต้อง Stable

แนะนำใช้:

primary key
created_at + id

ตามความเหมาะสม

==================================================

## PHASE 4.6 — Index Strategy

==================================================

สร้าง Index Strategy จาก Query Usage

ตัวอย่าง:

form_id
created_at
patient_id
status

และ Dynamic Field Index ที่ถูก Query บ่อย

ห้ามสร้าง Index ทุก Field แบบสุ่ม

ต้องวิเคราะห์ Trade-off:

read performance
write performance
storage

==================================================

## PHASE 4.7 — Query Limits

==================================================

ทุก Query ต้องมี:

max rows
max execution time
max result size

ตัวอย่าง:

timeout = 5000ms
max_rows = 500
max_export_rows = policy-based

==================================================

## PHASE 4.8 — Cache

==================================================

สร้าง Query Cache

รองรับ:

cache key
TTL
invalidate
manual refresh

Data ที่เปลี่ยนต้องสามารถ Invalidate Cache ได้

==================================================

## PHASE 4.9 — Background Jobs

==================================================

Query ขนาดใหญ่ต้องเปลี่ยนจาก:

HTTP Request → Wait → Timeout

เป็น:

Create Job
↓
Queue
↓
Worker
↓
Progress
↓
Result
↓
Download

ใช้กับ:

Export
Report
Aggregation
Large Search

==================================================

## PHASE 4.10 — Query Explain / Diagnostics

==================================================

สร้าง Diagnostic Information:

execution time
rows scanned
rows returned
index used
cache hit
query type

แต่ห้ามเปิดข้อมูล Sensitive ให้ User ที่ไม่มีสิทธิ์

==================================================

## PHASE 4.11 — Rate Limit / Concurrency

==================================================

ป้องกัน User / Process ยิง Query จำนวนมากพร้อมกัน

ต้องมี:

rate limit
concurrency limit
job queue limit

==================================================

## PHASE 4.12 — Query Failure Recovery

==================================================

เมื่อ Query Timeout:

ระบบต้อง:

1. Cancel/Stop เท่าที่ทำได้
2. ไม่ถือ Connection ค้าง
3. Log
4. Return Friendly Error
5. ไม่ทำให้ Server Process ค้าง

==================================================

## PHASE 4.13 — Large Dataset Test

==================================================

สร้าง Test Dataset จำลองอย่างน้อย:

100,000 records

และถ้า Environment รองรับ:

1,000,000 records

ทดสอบ:

search
filter
sort
pagination
aggregate
export

ห้ามอ้างว่า Performance ดีโดยไม่มี Test Evidence

==================================================

## PHASE 4 ACCEPTANCE CRITERIA

==================================================

[ ] Query Schema ทำงาน
[ ] Query Builder ทำงาน
[ ] Query Validator ทำงาน
[ ] Pagination ทำงาน
[ ] Cursor Pagination ทำงาน
[ ] Index Strategy ถูกใช้
[ ] Query Limit ทำงาน
[ ] Cache ทำงาน
[ ] Background Job ทำงาน
[ ] Query Timeout ถูก Handle
[ ] Concurrency Control ทำงาน
[ ] Large Dataset Test ผ่าน
[ ] No SELECT * จาก Dynamic Query โดยไม่จำเป็น
[ ] Tests ผ่าน

หยุดหลัง Phase 4

# PHASE 5 — AI FORM GENERATOR + TEXT DSL

==================================================

เป้าหมายคือทำให้ User สามารถสร้าง Form ด้วย Text / Natural Language แล้วแปลงเป็น Form Schema ที่ Valid

==================================================

## PHASE 5.1 — Text DSL

==================================================

สร้าง DSL ที่อ่านง่าย

ตัวอย่าง:

FORM patient_assessment
TITLE "แบบประเมินผู้ป่วย"
PAPER A4
STYLE form.a4.medical

SECTION patient
TITLE "ข้อมูลผู้ป่วย"

FIELD hn
TYPE text
LABEL "HN"

FIELD age
TYPE number
LABEL "อายุ"

SECTION vital_sign
TITLE "Vital Signs"

FIELD bp_sys
TYPE number
LABEL "ความดันตัวบน"
UNIT mmHg

FIELD bp_dia
TYPE number
LABEL "ความดันตัวล่าง"
UNIT mmHg

CALCULATOR bmi
FORMULA weight / ((height / 100) ^ 2)

FIELD bmi
TYPE calculated
READONLY true

==================================================

## PHASE 5.2 — DSL Parser

==================================================

สร้าง:

Lexer
Parser
AST
Schema Generator

Flow:

TEXT
↓
TOKENIZE
↓
PARSE
↓
AST
↓
VALIDATE
↓
JSON Schema

Error ต้องระบุตำแหน่งที่ผิด

ตัวอย่าง:

Line 12:
Unknown Field Type: numer

แนะนำ:
Did you mean "number"?

==================================================

## PHASE 5.3 — JSON ↔ TEXT

==================================================

ต้องสามารถ:

JSON → Text

และ:

Text → JSON

โดยไม่สูญเสียข้อมูลสำคัญ

ถ้ามี Property ที่ DSL ยังไม่รองรับ ต้องมี Extension mechanism

==================================================

## PHASE 5.4 — AI Form Generation

==================================================

สร้าง AI Adapter Layer

AI ต้องสามารถรับ:

Natural Language

ตัวอย่าง:

"สร้างแบบประเมินผู้สูงอายุ A4 มีข้อมูลผู้ป่วย Vital Sign การประเมินความเสี่ยงล้ม และคำนวณ BMI"

แล้วสร้าง:

Text DSL
หรือ
JSON Schema

==================================================

## PHASE 5.5 — AI MUST NOT EXECUTE DIRECTLY

==================================================

AI ห้ามสร้าง Form แล้วนำไป Execute โดยตรง

ต้องผ่าน:

AI Output
↓
Schema Validator
↓
Security Validator
↓
Reference Validator
↓
Preview
↓
Human Approval
↓
Publish

==================================================

## PHASE 5.6 — AI Safety

==================================================

AI Output ต้องตรวจ:

invalid Field Type
invalid Formula
unknown style_id
unknown font_id
broken field reference
circular dependency
invalid permission
unsafe expression

==================================================

## PHASE 5.7 — Form Template Library

==================================================

สร้าง Template Registry

ตัวอย่าง:

medical.basic
medical.vital_sign
medical.elderly
government.a4
survey.basic
registration.basic

Template ต้อง Clone แล้วแก้ไขได้

==================================================

## PHASE 5.8 — Style Recommendation

==================================================

AI สามารถแนะนำ:

Style
Font
Layout
Field Type

แต่ต้องเลือก Style ที่มีอยู่ใน Registry

AI ห้ามสร้าง CSS Arbitrary จำนวนมากโดยไม่จำเป็น

==================================================

## PHASE 5.9 — Form Preview

==================================================

AI-generated Form ต้องมี Preview ก่อน Publish

อย่างน้อย:

Desktop
Mobile
A4 Print

==================================================

## PHASE 5.10 — Publish Lifecycle

==================================================

Draft
↓
Review
↓
Approved
↓
Published
↓
Archived

Version ต้อง Immutable หลัง Publish

==================================================

## PHASE 5.11 — AI Regression Test

==================================================

สร้าง Test Prompt อย่างน้อย:

1. Patient Registration
2. Vital Sign
3. Fall Risk
4. Medication
5. Survey
6. A4 Government Form
7. Dynamic Conditional Form
8. Calculator Form
9. Repeat Group
10. Offline-capable Form

ตรวจว่า AI Output ผ่าน Schema Validator

==================================================

## PHASE 5 ACCEPTANCE CRITERIA

==================================================

[ ] Text DSL ทำงาน
[ ] DSL Parser ทำงาน
[ ] JSON → DSL ทำงาน
[ ] DSL → JSON ทำงาน
[ ] AI Adapter มี Abstraction
[ ] AI Output ผ่าน Validator
[ ] Preview ทำงาน
[ ] Template Registry ทำงาน
[ ] Style Recommendation ทำงาน
[ ] Publish Lifecycle ทำงาน
[ ] Version Lock หลัง Publish
[ ] Regression Tests ผ่าน

==================================================

# FINAL QUALITY GATE

==================================================

หลัง Phase 5 ให้ตรวจระบบทั้งหมดในมุม:

ARCHITECTURE
SECURITY
DATABASE
PERFORMANCE
OFFLINE
SYNC
UI
PRINT
FONT
QUERY
VERSIONING
TESTING
MAINTAINABILITY

ต้องตรวจว่า:

1. Form Definition ไม่ผูก Database
2. Form Definition ไม่ผูก UI
3. Style ไม่ผูก Data
4. Query ไม่ยิง SELECT * แบบไม่จำเป็น
5. Large Dataset ไม่ถูก Load ทั้งก้อน
6. Query ใหญ่ไป Background Job
7. Formula ไม่มี eval()
8. Dynamic SQL ผ่าน Parameterization
9. Offline Data ไม่หาย
10. Sync Retry ได้
11. Schema Version เก่าอ่านได้
12. Published Form ไม่ถูกแก้ย้อนหลัง
13. Hidden Field ยังเก็บ Data ได้
14. Permission ทำงานจริง
15. A4 Print Layout แยกจาก Screen Layout
16. Style Registry สามารถเพิ่ม Style ใหม่ได้โดยไม่แก้ Core
17. Font Registry สามารถเพิ่ม Font ใหม่ได้
18. Query Index มีเหตุผล
19. Test มีจริงและ Execute จริง
20. Existing Project Functionality ไม่พัง

==================================================

# FINAL DELIVERABLE

==================================================

ส่งมอบ:

1. Source Code
2. Database Schema
3. Migration
4. JSON Schema
5. Text DSL Specification
6. API Specification
7. Style Registry Specification
8. Font Registry Specification
9. Query Specification
10. Offline/Sync Specification
11. Test Suite
12. Example Forms
13. Example Form Packages
14. Developer Documentation
15. Deployment Documentation
16. Performance Test Report

และสร้าง Example อย่างน้อย:

### Example 1

Patient Registration

### Example 2

Vital Sign

### Example 3

BMI Calculator

### Example 4

Fall Risk Assessment

### Example 5

Answer + Other

### Example 6

Repeatable Medication

### Example 7

A4 Official Form

### Example 8

Offline Form

### Example 9

Large Dataset Query

### Example 10

AI Generated Form

==================================================

## FINAL RULE

==================================================

อย่าสร้าง Demo ที่ดูเหมือนทำงานได้แต่ไม่มี Architecture จริง

ทุก Feature ต้องเชื่อมกับ Core Architecture จริง

ทุก Claim ว่า "ใช้งานได้" ต้องมี Test หรือ Verification รองรับ

# และต้องรักษา Backward Compatibility ของ Form Schema ทุก Version ที่ถูก Publish แล้ว
