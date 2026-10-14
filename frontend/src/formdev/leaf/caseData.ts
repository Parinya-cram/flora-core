/**
 * A Flora Leaf case's data for Form Studio templates: every concept of concepts.ts read from the Leaf APIs the Report
 * page already uses (detail draft, HIS patient row, diagnosis / procedures, allergies, labs, events, staff, workstation),
 * with where each value came from. fillFromCase puts them into a form's fields (bound by field.bind or by the usual
 * field name) without changing anything on the server: printing is read-only.
 */
import type { FieldDefinition, FieldOption, FormDefinition, JsonValue, RecordData, TimelineValue } from "../core/types";
import { fieldKey, fields as definitionFields } from "../core/validate";
import { CONCEPT_BY_KEY, conceptOf } from "./concepts";
import { loadLeafTimeline, neededRows, timelineConfig } from "./timeline";

export type CaseValue = { value: string | number; source: string };
export type CaseData = { values: Record<string, CaseValue>; failed: string[]; loadedAt: number };
/** What the case is known by on the Report page (CaseStatus). */
export type CaseHead = { caseId: number; hn?: string | null; admissionNumber?: string | null; startTime?: number | null; dischargeTime?: number | null };

type Loaded = {
  draft: Record<string, unknown> | null; patient: Record<string, unknown> | null; diagnosis: Array<Record<string, unknown>>; procedures: Array<Record<string, unknown>>;
  allergies: Array<Record<string, unknown>>; labs: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; staff: Array<Record<string, unknown>>;
  workstation: Record<string, unknown> | null;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "");
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : []);
const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(text(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const span = (from: number, to: number) => { const minutes = Math.max(0, Math.round((to - from) / 60_000)); return `${clock(from)} - ${clock(to)} (${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)})`; };

/** DD/MM/YYYY (Thai Buddhist years above 2400 converted), YYYY-MM-DD or an ISO date-time → YYYY-MM-DD. */
export function toIsoDate(value: unknown): string | null {
  const raw = text(value);
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!match) return null;
  const year = Number(match[3]) > 2400 ? Number(match[3]) - 543 : Number(match[3]);
  return `${year}-${pad(Number(match[2]))}-${pad(Number(match[1]))}`;
}

function ageYears(dob: string, at: number): number | null {
  const [y, m, d] = dob.split("-").map(Number);
  const when = new Date(at);
  if (!y) return null;
  let age = when.getFullYear() - y;
  if (when.getMonth() + 1 < m || (when.getMonth() + 1 === m && when.getDate() < d)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

const token = (title: unknown) => text(title).toLowerCase().replace(/[^a-z0-9]/g, "");
/** Event titles of the case milestones (Flora Leaf's report and billing use the same names and two-letter codes). */
const MILESTONES: Record<string, string[]> = {
  startAne: ["startane", "startanes", "startanesthesia", "startanaesthesia", "sa"],
  endAne: ["endane", "endanes", "endanesthesia", "endanaesthesia", "ea"],
  startSurg: ["startsurg", "startsurgery", "ss"],
  endSurg: ["endsurg", "endsurgery", "es"],
};
/** Starts: the first matching event; ends: the last (as billing). */
function milestones(events: Loaded["events"]): Record<string, number> {
  const out: Record<string, number> = {};
  const sorted = events.filter(event => event.event_type === undefined || event.event_type === "event")
    .map(event => ({ ts: Number(event.event_ts), key: token(event.title) })).filter(event => Number.isFinite(event.ts)).sort((a, b) => a.ts - b.ts);
  for (const [name, tokens] of Object.entries(MILESTONES)) {
    const hits = sorted.filter(event => tokens.includes(event.key));
    if (hits.length) out[name] = name.startsWith("start") ? hits[0].ts : hits[hits.length - 1].ts;
  }
  return out;
}

const STAFF_ROLES: Record<string, RegExp> = {
  "staff.anesthesiologist": /^(anesthetist|fellowanesthetist|anesthetistresident|anesthesiologist)$/,
  "staff.surgeon": /^surgeon$/,
  "staff.nurse": /^(nurseanesthetist|anesthesianurse)$/,
};
const LABS: Record<string, RegExp> = { "lab.hb": /^(hb|hgb|hemoglobin|haemoglobin)$/, "lab.hct": /^(hct|hematocrit|haematocrit)$/, "lab.wbc": /^(wbc|whitebloodcell)/, "lab.plt": /^(plt|platelet)/ };

/** "นายสมชาย ใจดี": a Thai title is written against the first name; other titles take a space. */
function fullName(title: unknown, first: unknown, last: unknown): string {
  const given = [text(first), text(last)].filter(Boolean).join(" ");
  if (!given) return "";
  const prefix = text(title);
  return prefix ? `${prefix}${/[ก-๙.]$/.test(prefix) ? "" : " "}${given}` : given;
}

function bloodGroup(abo: unknown, rh: unknown): string {
  const group = text(abo).toUpperCase();
  if (!group) return "";
  const sign = text(rh).toLowerCase();
  return `${group}${/-|neg/.test(sign) ? "-" : sign ? "+" : ""}`;
}

/** The concepts of a loaded case (pure; tested without a server). */
export function caseValues(head: CaseHead, loaded: Loaded): Record<string, CaseValue> {
  const out: Record<string, CaseValue> = {};
  const put = (key: string, value: string | number | null | undefined, source: string) => {
    if (out[key] || value === null || value === undefined || value === "") return;
    out[key] = { value, source };
  };
  const draft = loaded.draft ?? {};
  const patient = loaded.patient ?? {};
  const at = head.startTime ?? Date.now();

  put("patient.hn", text(head.hn) || text(patient.hn) || text(draft.hn), "เคส / Case");
  put("patient.an", text(draft.an), "บันทึก / Record");
  put("patient.an", text(patient.an) || text(head.admissionNumber), "HIS");
  put("patient.name", fullName(draft.titleTh, draft.firstName, draft.lastName), "บันทึก / Record");
  put("patient.name", text(patient.patient_name) || fullName(patient.title_th, patient.first_name, patient.last_name), "HIS");
  put("patient.id_card", text(draft.idCard), "บันทึก / Record");
  const dob = toIsoDate(draft.dob) ?? toIsoDate(patient.dob);
  put("patient.dob", dob, toIsoDate(draft.dob) ? "บันทึก / Record" : "HIS");
  put("patient.age_years", number(draft.ageY), "บันทึก / Record");
  put("patient.age_years", number(patient.age_text), "HIS");
  put("patient.age_years", dob ? ageYears(dob, at) : null, "คำนวณจากวันเกิด / From DOB");
  put("patient.sex", text(draft.sex), "บันทึก / Record");
  put("patient.sex", text(patient.sex), "HIS");
  put("patient.weight_kg", number(draft.weightKg), "บันทึก / Record");
  put("patient.weight_kg", number(patient.weight_kg), "HIS");
  put("patient.height_cm", number(draft.heightCm), "บันทึก / Record");
  put("patient.height_cm", number(patient.height_cm), "HIS");
  put("patient.blood_group", bloodGroup(draft.bloodGroupABO, draft.bloodGroupRh), "บันทึก / Record");
  put("patient.blood_group", bloodGroup(patient.blood_group_abo, patient.blood_group_rh) || text(patient.blood_group_text), "HIS");
  const allergies = loaded.allergies.filter(row => !/^(nka|nkda|none|ไม่มี)/i.test(text(row.allergen)));
  if (allergies.length) put("patient.allergy", allergies.map(row => `${text(row.allergen)}${text(row.reaction) ? ` (${text(row.reaction)})` : ""}`).join(", "), "ประวัติแพ้ / Allergies");
  else if (loaded.allergies.length) put("patient.allergy", "NKA", "ประวัติแพ้ / Allergies");

  const asa = text(draft.asa);
  if (asa) put("case.asa", `${asa}${draft.emergency === true || draft.emergency === "true" ? "E" : ""}`, "บันทึก / Record");
  if (text(patient.asa_status)) put("case.asa", `${text(patient.asa_status)}${patient.asa_emergency === true ? "E" : ""}`, "รับผู้ป่วย / Admission");
  put("case.diagnosis", loaded.diagnosis.map(row => `${text(row.diagnosis_text)}${text(row.icd_code) ? ` (${text(row.icd_code)})` : ""}`).filter(Boolean).join("; "), "การวินิจฉัย / Diagnosis");
  put("case.diagnosis", list(draft.diagnosis).join("; "), "บันทึก / Record");
  put("case.operation", loaded.procedures.map(row => text(row.procedure_text)).filter(Boolean).join("; "), "หัตถการ / Procedures");
  put("case.operation", list(draft.operation).join("; "), "บันทึก / Record");
  put("case.room", text(loaded.workstation?.roomName), "เครื่องนี้ / Workstation");
  put("case.ward", text(loaded.workstation?.careUnitName), "เครื่องนี้ / Workstation");
  if (head.startTime) put("case.date", isoDate(head.startTime), "เคส / Case");
  put("case.admit_date", toIsoDate(patient.pre_admit_at) ?? (number(patient.pre_admit_at) ? isoDate(number(patient.pre_admit_at)!) : null), "HIS");
  if (typeof draft.emergency === "boolean") put("case.type", draft.emergency ? "Emergency" : "Elective", "บันทึก / Record");
  put("anesthesia.technique", list(draft.anesthesiaTypes).join(", "), "บันทึก / Record");

  const times = milestones(loaded.events);
  if (times.startAne) put("anesthesia.start", clock(times.startAne), "เหตุการณ์ / Events");
  if (times.endAne) put("anesthesia.end", clock(times.endAne), "เหตุการณ์ / Events");
  if (times.startAne && times.endAne) put("anesthesia.time", span(times.startAne, times.endAne), "เหตุการณ์ / Events");
  if (times.startSurg) put("surgery.start", clock(times.startSurg), "เหตุการณ์ / Events");
  if (times.endSurg) put("surgery.end", clock(times.endSurg), "เหตุการณ์ / Events");
  if (times.startSurg && times.endSurg) put("surgery.duration", span(times.startSurg, times.endSurg), "เหตุการณ์ / Events");

  for (const [key, pattern] of Object.entries(STAFF_ROLES)) {
    const names = loaded.staff.filter(member => pattern.test(token(member.role_id) || token(member.role))).map(member => text(member.name)).filter(Boolean);
    if (names.length) put(key, names.join(", "), "ทีม / Staff");
  }
  const hhmm = (value: unknown) => (/^\d{1,2}[:.]\d{2}$/.test(text(value)) ? text(value).replace(".", ":").padStart(5, "0") : null);
  put("pacu.arrival", hhmm(draft.pacuArrivalTime), "บันทึก / Record");
  put("pacu.discharge", hhmm(draft.pacuDischargeTime), "บันทึก / Record");
  put("pacu.destination", text(draft.postoperativeDestination), "บันทึก / Record");
  for (const [key, pattern] of Object.entries(LABS)) {
    const row = loaded.labs.find(lab => pattern.test(token(lab.test_name)));
    if (row) put(key, number(row.value_text) ?? text(row.value_text), "Lab");
  }
  return out;
}

/** Read the case from Leaf (in parallel; a source that fails is listed in `failed`, the rest still fill). */
export async function loadCaseData(head: CaseHead): Promise<CaseData> {
  const [{ getCaseDetailDraft }, his, clinical, { getCaseEvents }, { getCaseStaff }, { getWorkstationContext }] = await Promise.all([
    import("../../api/caseDetailApi"), import("../../api/caseHisApi"), import("../../api/caseClinicalApi"), import("../../api/caseEventApi"),
    import("../../api/staffApi"), import("../../api/workstationApi"),
  ]);
  const id = head.caseId;
  const until = head.dischargeTime || Date.now();
  const sources = {
    draft: getCaseDetailDraft(id), patient: his.getCasePatientInfo(id), diagnosis: clinical.getCaseDiagnosis(id), procedures: clinical.getCaseProcedures(id),
    allergies: his.getCaseAllergies(id), labs: his.getCaseLabs(id, { limit: 200 }), events: getCaseEvents(id, head.startTime ?? until - 86_400_000, until, 1000),
    staff: getCaseStaff(id), workstation: getWorkstationContext(),
  } as const;
  const names = Object.keys(sources) as Array<keyof typeof sources>;
  const settled = await Promise.allSettled(names.map(name => sources[name]));
  const loaded = { draft: null, patient: null, diagnosis: [], procedures: [], allergies: [], labs: [], events: [], staff: [], workstation: null } as unknown as Record<string, unknown>;
  const failed: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") loaded[names[index]] = result.value ?? loaded[names[index]];
    else failed.push(names[index]);
  });
  return { values: caseValues(head, loaded as unknown as Loaded), failed, loadedAt: Date.now() };
}

// Into a form -----------------------------------------------------------------------------------------

export type FillLine = {
  field: string; label: string; concept: string | null; how: "bind" | "name" | null; value: string;
  /** filled: from the case; kept: the form's own value (typed in Leaf) wins; empty: the case has no such datum;
   * unmatched: the case value is not one of the field's options; none: the field takes no case datum. */
  status: "filled" | "kept" | "empty" | "unmatched" | "none"; source: string;
};

const fold = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9ก-๙+-]/g, "");
const SEX: Record<string, string[]> = { m: ["m", "male", "ชาย", "man"], f: ["f", "female", "หญิง", "woman"] };

/** The option of a select / radio field that means the case value (by value, label, or Thai / English sex). */
function optionFor(options: FieldOption[] | undefined, value: string): string | null {
  const wanted = fold(value);
  const sex = Object.values(SEX).find(words => words.includes(wanted));
  for (const option of options ?? []) {
    const candidates = [fold(option.value), fold(option.label)];
    if (candidates.includes(wanted) || (sex && candidates.some(candidate => sex.includes(candidate)))) return option.value;
  }
  return null;
}

/** The case value as the field stores it, or undefined when it does not fit the field. */
function convert(field: FieldDefinition, value: string | number): JsonValue | undefined {
  const raw = String(value);
  switch (field.type) {
    case "integer": { const n = Number.parseFloat(raw); return Number.isFinite(n) ? Math.round(n) : undefined; }
    case "number": case "decimal": { const n = Number.parseFloat(raw); return Number.isFinite(n) ? n : undefined; }
    case "date": return toIsoDate(raw) ?? undefined;
    case "time": return /^\d{2}:\d{2}$/.test(raw) ? raw : undefined;
    case "select": case "radio": return optionFor(field.options, raw) ?? undefined;
    case "text": case "textarea": return raw;
    default: return undefined;
  }
}

const empty = (value: JsonValue | undefined) => value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);

/** The form's data with the case's values in the fields that are empty; every value field gets a line saying what
 * happened. Values typed into the form on Leaf are kept. */
export function fillFromCase(definition: FormDefinition, data: RecordData, caseData: CaseData): { data: RecordData; lines: FillLine[] } {
  const out: RecordData = { ...data };
  const lines: FillLine[] = [];
  for (const field of definitionFields(definition)) {
    if (["group", "repeat", "logo", "barcode", "timeline", "signature", "file", "image", "matrix", "calculated"].includes(field.type)) continue;
    const key = fieldKey(field);
    const concept = conceptOf(field);
    const line: FillLine = { field: key, label: field.label, concept: concept?.key ?? null, how: concept?.how ?? null, value: "", status: "none", source: "" };
    lines.push(line);
    if (!empty(out[key])) { line.status = "kept"; line.value = String(out[key]); line.source = "แบบฟอร์ม / Form"; continue; }
    if (!concept) continue;
    const found = caseData.values[concept.key];
    if (!found) { line.status = CONCEPT_BY_KEY.has(concept.key) ? "empty" : "unmatched"; continue; }
    const value = convert(field, found.value);
    if (value === undefined) { line.status = "unmatched"; line.value = String(found.value); line.source = found.source; continue; }
    out[key] = value;
    line.status = "filled";
    line.value = String(found.value);
    line.source = found.source;
  }
  return { data: out, lines };
}

/** Timeline fields whose source is Flora Leaf and that hold nothing yet: the case's trends, read now. */
export async function fillTimelines(definition: FormDefinition, data: RecordData, caseId: number): Promise<RecordData> {
  const out: RecordData = { ...data };
  for (const field of definitionFields(definition)) {
    if (field.type !== "timeline" || !empty(out[fieldKey(field)])) continue;
    const config = timelineConfig(field);
    if (config.source !== "leaf") continue;
    try {
      const value: TimelineValue = await loadLeafTimeline({ caseId }, config.step, neededRows(config.rows.map(row => row.id), config.chart));
      out[fieldKey(field)] = value as unknown as JsonValue;
    } catch {
      // No trends for this case (or Leaf did not answer): the timeline prints empty, to write on.
    }
  }
  return out;
}
