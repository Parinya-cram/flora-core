/**
 * Case data a Form Studio field can show on Flora Leaf (field.bind): the concept keys, their labels, and the field ids
 * that mean the same thing in forms without a bind (the paper templates and AI-built forms use these names), so an
 * existing form fills itself without editing. caseData.ts reads each concept from the Leaf case.
 */
export type ConceptKind = "text" | "number" | "date" | "time" | "datetime" | "list";
export type Concept = { key: string; th: string; en: string; kind: ConceptKind; aliases: string[] };

export const CONCEPTS: Concept[] = [
  { key: "patient.hn", th: "HN", en: "HN", kind: "text", aliases: ["hn", "hospital_number", "mrn"] },
  { key: "patient.an", th: "AN", en: "AN", kind: "text", aliases: ["an", "admission_number", "encounter_number"] },
  { key: "patient.name", th: "ชื่อ-นามสกุลผู้ป่วย", en: "Patient name", kind: "text", aliases: ["patient_name", "name", "full_name", "patient_full_name"] },
  { key: "patient.id_card", th: "เลขบัตรประชาชน", en: "ID card", kind: "text", aliases: ["id_card", "cid", "citizen_id", "national_id"] },
  { key: "patient.dob", th: "วันเกิด", en: "Date of birth", kind: "date", aliases: ["dob", "date_of_birth", "birth_date"] },
  { key: "patient.age_years", th: "อายุ (ปี)", en: "Age (years)", kind: "number", aliases: ["age", "age_years", "age_y"] },
  { key: "patient.sex", th: "เพศ", en: "Sex", kind: "text", aliases: ["gender", "sex"] },
  { key: "patient.weight_kg", th: "น้ำหนัก (kg)", en: "Weight (kg)", kind: "number", aliases: ["weight", "weight_kg", "wt", "body_weight"] },
  { key: "patient.height_cm", th: "ส่วนสูง (cm)", en: "Height (cm)", kind: "number", aliases: ["height", "height_cm", "ht"] },
  { key: "patient.blood_group", th: "หมู่เลือด", en: "Blood group", kind: "text", aliases: ["blood_type", "blood_group", "blood_group_abo"] },
  { key: "patient.allergy", th: "ประวัติแพ้", en: "Allergy", kind: "text", aliases: ["allergy", "allergies", "drug_allergy"] },
  { key: "case.asa", th: "ASA", en: "ASA", kind: "text", aliases: ["asa_status", "asa", "asa_class"] },
  { key: "case.diagnosis", th: "การวินิจฉัย", en: "Diagnosis", kind: "text", aliases: ["post_op_dx", "diagnosis", "pre_op_dx", "dx"] },
  { key: "case.operation", th: "การผ่าตัด / หัตถการ", en: "Operation", kind: "text", aliases: ["operation", "procedure", "operation_name"] },
  { key: "case.room", th: "ห้องผ่าตัด", en: "Room", kind: "text", aliases: ["room", "or_room", "theatre"] },
  { key: "case.ward", th: "หอผู้ป่วย / หน่วยงาน", en: "Ward / unit", kind: "text", aliases: ["ward", "care_unit", "unit"] },
  { key: "case.date", th: "วันที่ผ่าตัด", en: "Operation date", kind: "date", aliases: ["op_date", "operation_date", "date", "case_date"] },
  { key: "case.admit_date", th: "วันที่รับไว้ในโรงพยาบาล", en: "Admission date", kind: "date", aliases: ["admit_date", "admission_date"] },
  { key: "case.type", th: "ประเภทเคส", en: "Case type", kind: "text", aliases: ["case_type", "priority", "surgical_priority"] },
  { key: "anesthesia.technique", th: "เทคนิคระงับความรู้สึก", en: "Anesthesia technique", kind: "text", aliases: ["anesthesia_technique", "technique", "anesthesia_type"] },
  { key: "anesthesia.start", th: "เวลาเริ่มให้ยาระงับความรู้สึก", en: "Anesthesia start", kind: "time", aliases: ["anesthesia_start", "start_anesthesia"] },
  { key: "anesthesia.end", th: "เวลาสิ้นสุดการให้ยาระงับความรู้สึก", en: "Anesthesia end", kind: "time", aliases: ["anesthesia_end", "end_anesthesia"] },
  { key: "anesthesia.time", th: "ช่วงเวลาให้ยาระงับความรู้สึก", en: "Anesthesia time", kind: "text", aliases: ["anesthesia_time"] },
  { key: "surgery.start", th: "เวลาเริ่มผ่าตัด", en: "Surgery start", kind: "time", aliases: ["surgery_start", "start_surgery", "incision_time"] },
  { key: "surgery.end", th: "เวลาสิ้นสุดการผ่าตัด", en: "Surgery end", kind: "time", aliases: ["surgery_end", "end_surgery"] },
  { key: "surgery.duration", th: "ช่วงเวลาผ่าตัด", en: "Surgery duration", kind: "text", aliases: ["surgery_duration", "operation_duration"] },
  { key: "staff.anesthesiologist", th: "วิสัญญีแพทย์", en: "Anesthesiologist", kind: "text", aliases: ["anesthesiologist", "anesthesiologist_name"] },
  { key: "staff.surgeon", th: "ศัลยแพทย์", en: "Surgeon", kind: "text", aliases: ["surgeon", "surgeon_name"] },
  { key: "staff.nurse", th: "พยาบาลวิสัญญี", en: "Anesthesia nurse", kind: "text", aliases: ["anesthesia_nurse", "nurse_anesthetist"] },
  { key: "pacu.arrival", th: "เวลาเข้า PACU", en: "PACU arrival", kind: "time", aliases: ["recovery_start", "pacu_arrival", "pacu_in"] },
  { key: "pacu.discharge", th: "เวลาออกจาก PACU", en: "PACU discharge", kind: "time", aliases: ["recovery_end", "pacu_discharge", "pacu_out"] },
  { key: "pacu.destination", th: "ส่งต่อไปที่", en: "Discharge location", kind: "text", aliases: ["discharge_location", "destination", "postoperative_destination"] },
  { key: "lab.hb", th: "Hb", en: "Hb", kind: "number", aliases: ["hb", "hemoglobin"] },
  { key: "lab.hct", th: "Hct", en: "Hct", kind: "number", aliases: ["hct", "hematocrit"] },
  { key: "lab.wbc", th: "WBC", en: "WBC", kind: "number", aliases: ["wbc"] },
  { key: "lab.plt", th: "Platelet", en: "Platelet", kind: "number", aliases: ["plt", "platelet"] },
];

export const CONCEPT_BY_KEY = new Map(CONCEPTS.map(concept => [concept.key, concept]));
const BY_ALIAS = new Map(CONCEPTS.flatMap(concept => concept.aliases.map(alias => [alias, concept.key] as const)));

/** The concept a field shows: its bind, else the concept whose usual field name it has. */
export function conceptOf(field: { id: string; key?: string; bind?: string }): { key: string; how: "bind" | "name" } | null {
  if (field.bind) return { key: field.bind, how: "bind" };
  const key = BY_ALIAS.get(field.key ?? field.id);
  return key ? { key, how: "name" } : null;
}
