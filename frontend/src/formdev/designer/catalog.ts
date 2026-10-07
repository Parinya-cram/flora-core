/**
 * What the designer offers: the field palette (every registered type, with plain-language names) and ready-made
 * blocks that insert several working fields at once (formulas, rules and lookups already wired).
 */
import type { CalculatorDefinition, FieldDefinition, FieldType, FormDefinition, SectionDefinition } from "../core/types";
import { instantiateTemplate } from "../logic/calculators";
import { CALCULATOR_TEMPLATES } from "../registry/defaults";
import { emptyForm, newField, uniqueName } from "./model";

export type Lang = "th" | "en";
export const langOf = (language: string): Lang => (language.toLowerCase().startsWith("th") ? "th" : "en");
export const tr = (lang: Lang, th: string, en: string) => (lang === "th" ? th : en);

export type PaletteItem = { type: FieldType; icon: string; th: string; en: string; hintTh: string; hintEn: string };
export type PaletteGroup = { th: string; en: string; items: PaletteItem[] };

export const PALETTE: PaletteGroup[] = [
  { th: "ข้อความและตัวเลข", en: "Text and numbers", items: [
    { type: "text", icon: "Aa", th: "ข้อความสั้น", en: "Short text", hintTh: "ชื่อ, HN, เลขที่", hintEn: "Name, HN, number" },
    { type: "textarea", icon: "¶", th: "ข้อความยาว", en: "Long text", hintTh: "บันทึก, รายละเอียด", hintEn: "Notes, details" },
    { type: "number", icon: "12", th: "ตัวเลข", en: "Number", hintTh: "ส่วนสูง, ปริมาณ", hintEn: "Height, amount" },
    { type: "integer", icon: "#", th: "จำนวนเต็ม", en: "Whole number", hintTh: "ชีพจร, จำนวนครั้ง", hintEn: "Pulse, count" },
    { type: "decimal", icon: "0.0", th: "ทศนิยม", en: "Decimal", hintTh: "น้ำหนัก, อุณหภูมิ", hintEn: "Weight, temperature" },
  ] },
  { th: "วันและเวลา", en: "Date and time", items: [
    { type: "date", icon: "📅", th: "วันที่", en: "Date", hintTh: "วันเกิด, วันรับไว้", hintEn: "Birth date, admission" },
    { type: "datetime", icon: "🕘", th: "วันที่และเวลา", en: "Date and time", hintTh: "เวลาประเมิน", hintEn: "Assessed at" },
    { type: "time", icon: "⏱", th: "เวลา", en: "Time", hintTh: "เวลาให้ยา", hintEn: "Dose time" },
  ] },
  { th: "ตัวเลือก", en: "Choices", items: [
    { type: "radio", icon: "◉", th: "เลือก 1 ข้อ", en: "Pick one", hintTh: "เพศ, ระดับ", hintEn: "Sex, level" },
    { type: "select", icon: "▾", th: "รายการเลื่อนลง", en: "Dropdown", hintTh: "ตัวเลือกจำนวนมาก", hintEn: "Many choices" },
    { type: "multiselect", icon: "☑", th: "เลือกได้หลายข้อ", en: "Pick several", hintTh: "อาการ, โรคประจำตัว", hintEn: "Symptoms" },
    { type: "checkbox", icon: "✓", th: "ช่องติ๊ก", en: "Checkbox", hintTh: "ยินยอม, ยืนยัน", hintEn: "Consent, confirm" },
    { type: "switch", icon: "⏻", th: "ใช่ / ไม่ใช่", en: "Yes / no", hintTh: "มีไข้, แพ้ยา", hintEn: "Fever, allergy" },
  ] },
  { th: "คำนวณและกลุ่ม", en: "Calculation and groups", items: [
    { type: "calculated", icon: "ƒ", th: "ค่าคำนวณ", en: "Calculated", hintTh: "BMI, อายุ, คะแนนรวม", hintEn: "BMI, age, total" },
    { type: "group", icon: "▣", th: "กลุ่มช่อง", en: "Group", hintTh: "จัดหลายช่องไว้ด้วยกัน", hintEn: "Fields kept together" },
    { type: "repeat", icon: "≡", th: "ตารางเพิ่มแถวได้", en: "Repeating rows", hintTh: "รายการยา, ประวัติ", hintEn: "Medications, history" },
  ] },
  { th: "ไฟล์และลายเซ็น", en: "Files and signature", items: [
    { type: "image", icon: "🖼", th: "รูปภาพ", en: "Image", hintTh: "ภาพแผล, ฟิล์ม", hintEn: "Wound photo" },
    { type: "file", icon: "📎", th: "ไฟล์แนบ", en: "File", hintTh: "เอกสาร PDF", hintEn: "PDF document" },
    { type: "signature", icon: "✍", th: "ลายเซ็น", en: "Signature", hintTh: "ผู้บันทึก, ผู้ป่วย", hintEn: "Recorder, patient" },
  ] },
];

const ITEMS = new Map(PALETTE.flatMap(group => group.items).map(item => [item.type, item]));
export const typeName = (type: string, lang: Lang) => { const item = ITEMS.get(type as FieldType); return item ? tr(lang, item.th, item.en) : type; };
export const typeIcon = (type: string) => ITEMS.get(type as FieldType)?.icon ?? "□";

/** A palette field with labels in the designer's language. */
export function paletteField(type: FieldType, used: Set<string>, lang: Lang): FieldDefinition {
  return newField(type, used, typeName(type, lang), { option: n => tr(lang, `ตัวเลือก ${n}`, `Option ${n}`), child: tr(lang, "รายการ", "Item") });
}

// Ready-made blocks ----------------------------------------------------------------------------

export type Block = { fields: FieldDefinition[]; calculators: CalculatorDefinition[] };
export type BlockItem = { id: string; icon: string; th: string; en: string; hintTh: string; hintEn: string; needsLookup?: string; build: (used: Set<string>, lang: Lang) => Block };

const template = (id: string) => CALCULATOR_TEMPLATES.find(item => item.template_id === id)!;
const options = (lang: Lang, items: Array<[string, string, string]>) => items.map(([value, th, en]) => ({ value, label: tr(lang, th, en) }));

export const BLOCKS: BlockItem[] = [
  { id: "excel_table", icon: "▦", th: "ตารางแบบ Excel", en: "Excel-style table", hintTh: "กรอกเป็นแถว/คอลัมน์ วางจาก Excel ได้", hintEn: "Rows and columns; paste from Excel",
    build: (used, lang) => {
      const table = uniqueName("table", used);
      const taken = new Set([...used, table]);
      const column = (base: string) => { const name = uniqueName(base, taken); taken.add(name); return name; };
      return { calculators: [], fields: [
        { id: table, type: "repeat", view: "table", label: tr(lang, "ตาราง", "Table"), max_items: 100, layout: { span: 12 }, fields: [
          { id: column("item"), type: "text", label: tr(lang, "รายการ", "Item") },
          { id: column("date"), type: "date", label: tr(lang, "วันที่", "Date") },
          { id: column("amount"), type: "number", label: tr(lang, "จำนวน", "Amount") },
          { id: column("note"), type: "text", label: tr(lang, "หมายเหตุ", "Note") },
        ] },
      ] };
    } },
  { id: "patient", icon: "👤", th: "ข้อมูลผู้ป่วย", en: "Patient", hintTh: "HN, ชื่อ, วันเกิด, อายุ (คำนวณ), เพศ", hintEn: "HN, name, birth date, age, sex",
    build: (used, lang) => {
      const hn = uniqueName("hn", used), name = uniqueName("full_name", used), birth = uniqueName("birth_date", used), age = uniqueName("age", used), sex = uniqueName("sex", used);
      const calculator = instantiateTemplate(template("age_years"), { birth_date: birth }, uniqueName("age_calc", used));
      return { calculators: [calculator], fields: [
        { id: hn, type: "text", label: "HN", required: true, indexed: true, layout: { span: 3 } },
        { id: name, type: "text", label: tr(lang, "ชื่อ-นามสกุล", "Full name"), required: true, layout: { span: 5 } },
        { id: sex, type: "radio", label: tr(lang, "เพศ", "Sex"), layout: { span: 4 }, options: options(lang, [["m", "ชาย", "Male"], ["f", "หญิง", "Female"]]) },
        { id: birth, type: "date", label: tr(lang, "วันเกิด", "Birth date"), validation: { max_date: "today" }, layout: { span: 4 } },
        { id: age, type: "calculated", label: tr(lang, "อายุ (ปี)", "Age (years)"), calculator: calculator.id, layout: { span: 2 } },
      ] };
    } },
  { id: "vitals", icon: "❤", th: "สัญญาณชีพ", en: "Vital signs", hintTh: "ความดัน, ชีพจร, อุณหภูมิ, หายใจ, SpO₂", hintEn: "BP, pulse, temperature, RR, SpO₂",
    build: (used, lang) => {
      const sys = uniqueName("bp_sys", used), dia = uniqueName("bp_dia", used);
      return { calculators: [], fields: [
        { id: sys, type: "integer", label: tr(lang, "ความดันตัวบน", "Systolic BP"), unit: "mmHg", min: 40, max: 300, layout: { span: 2 },
          validation: { rules: [{ assert: `${sys} > ${dia}`, message: tr(lang, "ความดันตัวบนต้องมากกว่าตัวล่าง", "Systolic must be above diastolic") }] } },
        { id: dia, type: "integer", label: tr(lang, "ความดันตัวล่าง", "Diastolic BP"), unit: "mmHg", min: 20, max: 200, layout: { span: 2 } },
        { id: uniqueName("pulse", used), type: "integer", label: tr(lang, "ชีพจร", "Pulse"), unit: "/min", min: 20, max: 250, layout: { span: 2 } },
        { id: uniqueName("temperature_c", used), type: "decimal", label: tr(lang, "อุณหภูมิ", "Temperature"), unit: "°C", decimals: 1, min: 34, max: 43, layout: { span: 2 } },
        { id: uniqueName("resp_rate", used), type: "integer", label: tr(lang, "อัตราการหายใจ", "Respiratory rate"), unit: "/min", min: 4, max: 80, layout: { span: 2 } },
        { id: uniqueName("spo2", used), type: "integer", label: "SpO₂", unit: "%", min: 50, max: 100, layout: { span: 2 } },
      ] };
    } },
  { id: "bmi", icon: "⚖", th: "น้ำหนัก ส่วนสูง BMI", en: "Weight, height, BMI", hintTh: "คำนวณ BMI และเกณฑ์ให้อัตโนมัติ", hintEn: "BMI and class calculated",
    build: (used, lang) => {
      const weight = uniqueName("weight_kg", used), height = uniqueName("height_cm", used), bmi = uniqueName("bmi", used), bmiClass = uniqueName("bmi_class", used);
      const bmiCalc = instantiateTemplate(template("bmi"), { weight, height }, uniqueName("bmi_calc", used));
      const classCalc = instantiateTemplate(template("bmi_class_asia"), { weight, height }, uniqueName("bmi_class_calc", used));
      return { calculators: [bmiCalc, classCalc], fields: [
        { id: weight, type: "decimal", label: tr(lang, "น้ำหนัก", "Weight"), unit: "kg", decimals: 1, min: 1, max: 400, layout: { span: 3 } },
        { id: height, type: "number", label: tr(lang, "ส่วนสูง", "Height"), unit: "cm", min: 30, max: 260, layout: { span: 3 } },
        { id: bmi, type: "calculated", label: "BMI", unit: "kg/m²", calculator: bmiCalc.id, indexed: true, layout: { span: 3 } },
        { id: bmiClass, type: "calculated", label: tr(lang, "เกณฑ์ BMI", "BMI class"), calculator: classCalc.id, layout: { span: 3 } },
      ] };
    } },
  { id: "thai_address", icon: "🏠", th: "ที่อยู่ (จังหวัด → อำเภอ → ตำบล)", en: "Thai address", hintTh: "เลือกต่อกันและเติมรหัสไปรษณีย์ให้", hintEn: "Linked choices, postcode filled in",
    needsLookup: "thai_address",
    build: (used, lang) => {
      const house = uniqueName("address_line", used), province = uniqueName("province", used), district = uniqueName("district", used),
        subdistrict = uniqueName("subdistrict", used), postcode = uniqueName("postcode", used);
      const fields: FieldDefinition[] = [
        { id: house, type: "text", label: tr(lang, "บ้านเลขที่ / ถนน", "House no. / street"), layout: { span: 12 } },
        { id: province, type: "select", label: tr(lang, "จังหวัด", "Province"), layout: { span: 6 }, lookup: { source: "thai_address", value: "province" } },
        { id: district, type: "select", label: tr(lang, "อำเภอ / เขต", "District"), layout: { span: 6 }, lookup: { source: "thai_address", value: "district", filter: { province } } },
        { id: subdistrict, type: "select", label: tr(lang, "ตำบล / แขวง", "Sub-district"), layout: { span: 6 },
          lookup: { source: "thai_address", value: "subdistrict", filter: { province, district } } },
        { id: postcode, type: "text", label: tr(lang, "รหัสไปรษณีย์", "Postcode"), readonly: true, layout: { span: 6 },
          derive: { lookup: "thai_address", column: "postcode", match: { province, district, subdistrict } } },
      ];
      return { calculators: [], fields };
    } },
  { id: "contact", icon: "☎", th: "การติดต่อ", en: "Contact", hintTh: "โทรศัพท์ (ตรวจรูปแบบ), อีเมล", hintEn: "Phone (checked), e-mail",
    build: (used, lang) => ({ calculators: [], fields: [
      { id: uniqueName("phone", used), type: "text", label: tr(lang, "โทรศัพท์", "Phone"), layout: { span: 6 },
        validation: { pattern: "0[0-9]{8,9}", message: tr(lang, "เบอร์โทรศัพท์ 9-10 หลัก ขึ้นต้นด้วย 0", "9-10 digits starting with 0") } },
      { id: uniqueName("email", used), type: "text", label: tr(lang, "อีเมล", "E-mail"), layout: { span: 6 }, validation: { email: true } },
    ] }) },
  { id: "medications", icon: "💊", th: "รายการยา", en: "Medications", hintTh: "ตารางเพิ่มแถว: ชื่อยา ขนาด ความถี่", hintEn: "Rows: drug, dose, frequency",
    build: (used, lang) => ({ calculators: [], fields: [
      { id: uniqueName("medications", used), type: "repeat", label: tr(lang, "รายการยา", "Medications"), max_items: 30, fields: [
        { id: uniqueName("drug_name", used), type: "text", label: tr(lang, "ชื่อยา", "Drug"), required: true, layout: { span: 6 } },
        { id: uniqueName("dose", used), type: "text", label: tr(lang, "ขนาด", "Dose"), layout: { span: 3 } },
        { id: uniqueName("frequency", used), type: "select", label: tr(lang, "ความถี่", "Frequency"), layout: { span: 3 },
          options: options(lang, [["od", "วันละครั้ง", "Once daily"], ["bid", "วันละ 2 ครั้ง", "Twice daily"], ["tid", "วันละ 3 ครั้ง", "Three times daily"], ["prn", "เมื่อมีอาการ", "As needed"]]) },
      ] },
    ] }) },
  { id: "sign", icon: "✍", th: "ลงชื่อผู้บันทึก", en: "Recorded by", hintTh: "ชื่อ, ลายเซ็น, วันเวลา", hintEn: "Name, signature, time",
    build: (used, lang) => ({ calculators: [], fields: [
      { id: uniqueName("recorder_name", used), type: "text", label: tr(lang, "ผู้บันทึก", "Recorded by"), layout: { span: 6 } },
      { id: uniqueName("recorded_at", used), type: "datetime", label: tr(lang, "วันเวลาที่บันทึก", "Recorded at"), layout: { span: 6 } },
      { id: uniqueName("recorder_signature", used), type: "signature", label: tr(lang, "ลายเซ็น", "Signature"), layout: { span: 12 } },
    ] }) },
];

// Labels for the inspector ---------------------------------------------------------------------

export const ROLES: Array<{ code: string; th: string; en: string }> = [
  { code: "clinician", th: "แพทย์ / พยาบาล (clinician)", en: "Clinician" },
  { code: "clinical_admin", th: "ผู้ดูแลงานคลินิก", en: "Clinical administrator" },
  { code: "viewer", th: "ผู้ดู / ผู้ตรวจสอบ", en: "Viewer / auditor" },
  { code: "system_admin", th: "ผู้ดูแลระบบ", en: "System administrator" },
];

export type ActionLabel = { action: string; th: string; en: string };
export const FIELD_ACTIONS: ActionLabel[] = [
  { action: "view", th: "ใครเห็นช่องนี้", en: "Who can see it" }, { action: "edit", th: "ใครแก้ไขได้", en: "Who can edit it" },
  { action: "export", th: "ใครส่งออกได้", en: "Who can export it" }];
export const SECTION_ACTIONS: ActionLabel[] = [
  { action: "view", th: "ใครเห็นส่วนนี้", en: "Who can see it" }, { action: "edit", th: "ใครแก้ไขได้", en: "Who can edit it" }];
export const FORM_ACTIONS: ActionLabel[] = [
  { action: "view", th: "ใครเปิดดูแบบฟอร์มได้", en: "Who can open it" }, { action: "create", th: "ใครสร้างรายการใหม่ได้", en: "Who can create records" },
  { action: "edit", th: "ใครแก้ไขรายการได้", en: "Who can edit records" }, { action: "delete", th: "ใครลบรายการได้", en: "Who can delete records" },
  { action: "export", th: "ใครส่งออกข้อมูลได้", en: "Who can export" }];

export const OPERATORS: Array<{ op: string; th: string; en: string; needsValue: boolean }> = [
  { op: "equals", th: "เท่ากับ", en: "is", needsValue: true },
  { op: "not_equals", th: "ไม่เท่ากับ", en: "is not", needsValue: true },
  { op: "in", th: "เป็นข้อใดข้อหนึ่งใน", en: "is one of", needsValue: true },
  { op: "gt", th: "มากกว่า", en: "greater than", needsValue: true },
  { op: "gte", th: "มากกว่าหรือเท่ากับ", en: "at least", needsValue: true },
  { op: "lt", th: "น้อยกว่า", en: "less than", needsValue: true },
  { op: "lte", th: "น้อยกว่าหรือเท่ากับ", en: "at most", needsValue: true },
  { op: "exists", th: "มีการกรอก", en: "is filled in", needsValue: false },
  { op: "empty", th: "ยังไม่กรอก", en: "is empty", needsValue: false },
];

export const PATTERNS: Array<{ id: string; th: string; en: string; rules: Record<string, unknown> }> = [
  { id: "phone", th: "เบอร์โทรศัพท์ไทย", en: "Thai phone number", rules: { pattern: "0[0-9]{8,9}" } },
  { id: "citizen_id", th: "เลขบัตรประชาชน 13 หลัก", en: "13-digit citizen ID", rules: { pattern: "[0-9]{13}" } },
  { id: "email", th: "อีเมล", en: "E-mail", rules: { email: true } },
  { id: "digits", th: "ตัวเลขเท่านั้น", en: "Digits only", rules: { numeric: true } },
];

export const WIDTHS: Array<{ span: number; th: string; en: string }> = [
  { span: 12, th: "เต็มแถว", en: "Full" }, { span: 9, th: "3/4", en: "3/4" }, { span: 8, th: "2/3", en: "2/3" },
  { span: 6, th: "ครึ่ง", en: "Half" }, { span: 4, th: "1/3", en: "1/3" }, { span: 3, th: "1/4", en: "1/4" },
];

// Starting points ----------------------------------------------------------------------------------

export type Starter = { id: string; icon: string; th: string; en: string; hintTh: string; hintEn: string; sections: Array<{ th: string; en: string; blocks: string[] }> };

export const STARTERS: Starter[] = [
  { id: "blank", icon: "📄", th: "แบบฟอร์มเปล่า", en: "Blank form", hintTh: "เริ่มจากศูนย์", hintEn: "Start from scratch", sections: [] },
  { id: "admission", icon: "🏥", th: "แบบประเมินแรกรับ", en: "Admission assessment", hintTh: "ผู้ป่วย, สัญญาณชีพ, BMI, ผู้บันทึก", hintEn: "Patient, vitals, BMI, recorder",
    sections: [{ th: "ข้อมูลผู้ป่วย", en: "Patient", blocks: ["patient"] }, { th: "สัญญาณชีพ", en: "Vital signs", blocks: ["vitals", "bmi"] },
      { th: "ผู้บันทึก", en: "Recorded by", blocks: ["sign"] }] },
  { id: "address", icon: "🏠", th: "ข้อมูลที่อยู่และการติดต่อ", en: "Address and contact", hintTh: "ผู้ป่วย, ที่อยู่แบบเลือกต่อกัน, โทรศัพท์", hintEn: "Patient, linked address, phone",
    sections: [{ th: "ข้อมูลผู้ป่วย", en: "Patient", blocks: ["patient"] }, { th: "ที่อยู่และการติดต่อ", en: "Address and contact", blocks: ["thai_address", "contact"] }] },
];

/** A new form from a starting point; every name is unique and every formula / lookup is wired. */
export function starterForm(starter: Starter, formId: string, title: string, lang: Lang): FormDefinition {
  const blank = emptyForm(formId, title, tr(lang, "ส่วนที่ 1", "Section 1"), used => paletteField("text", used, lang));
  if (!starter.sections.length) return blank;
  const used = new Set<string>();
  const calculators: CalculatorDefinition[] = [];
  const sections: SectionDefinition[] = starter.sections.map(spec => {
    const fields: FieldDefinition[] = [];
    for (const id of spec.blocks) {
      const built = BLOCKS.find(block => block.id === id)!.build(used, lang);
      fields.push(...built.fields);
      calculators.push(...built.calculators);
    }
    return { id: uniqueName("section", used), title: tr(lang, spec.th, spec.en), fields };
  });
  const definition: FormDefinition = { ...blank, sections };
  if (calculators.length) definition.calculators = calculators;
  const hn = sections.flatMap(section => section.fields).find(field => field.id === "hn");
  if (hn) definition.extensions = { "flora.subject_field": "hn" };
  return definition;
}
