/** Form Studio templates on Flora Leaf's Reports: a case's data (as the Leaf APIs return it) read into concepts, and
 * filled into the anesthesia template's fields by bind or by field name — with every field's source reported. */
import { describe, expect, it } from "vitest";
import { validateDefinition } from "../../src/formdev/core/validate";
import { anesthesiaForm } from "../../src/formdev/designer/templates";
import { caseValues, fillFromCase, toIsoDate, type CaseData } from "../../src/formdev/leaf/caseData";
import { conceptOf } from "../../src/formdev/leaf/concepts";
import { orderCaseTabs, workflowFormTabs } from "../../src/components/workflow/caseWorkflow";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../../src/formdev/registry/defaults";

const START = new Date(2026, 9, 14, 9, 0).getTime();
const at = (hour: number, minute: number) => new Date(2026, 9, 14, hour, minute).getTime();
const head = { caseId: 7, hn: "6512345", admissionNumber: "6700123", startTime: START, dischargeTime: null };
const loaded = {
  draft: { titleTh: "นาย", firstName: "ทดสอบ", lastName: "ระบบ", sex: "M", dob: "02/03/2511", ageY: "58", weightKg: "62.5", heightCm: "168", bloodGroupABO: "O", bloodGroupRh: "Positive",
    asa: "2", emergency: true, diagnosis: ["fallback dx"], anesthesiaTypes: ["General anesthesia", "Regional"], pacuArrivalTime: "10:42", postoperativeDestination: "Ward 5" },
  patient: { hn: "6512345", an: "6700123", dob: "1968-03-02", weight_kg: 63, asa_status: "3", pre_admit_at: "2026-10-13" },
  diagnosis: [{ diagnosis_text: "Symptomatic gallstone", icd_code: "K80.2" }],
  procedures: [{ procedure_text: "Laparoscopic cholecystectomy" }],
  allergies: [{ allergen: "Penicillin", reaction: "rash" }],
  labs: [{ test_name: "Hb", value_text: "12.8" }, { test_name: "Platelet count", value_text: "245" }],
  events: [{ event_type: "event", event_ts: at(9, 5), title: "Start Anesthesia" }, { event_type: "event", event_ts: at(9, 25), title: "SS" },
    { event_type: "event", event_ts: at(11, 40), title: "End Surgery" }, { event_type: "event", event_ts: at(12, 2), title: "End anesthesia" }],
  staff: [{ name: "นพ. วิสัญญี", role_id: "anesthetist" }, { name: "นพ. ศัลย์", role: "Surgeon" }, { name: "พว. สมใจ", role_id: "nurseAnesthetist" }],
  workstation: { roomName: "OR 2", careUnitName: "Perioperative unit" },
};

describe("case data from Flora Leaf", () => {
  const values = caseValues(head, loaded);

  it("reads every concept from the source the Report page uses, the record first", () => {
    expect(values["patient.hn"]).toEqual({ value: "6512345", source: "เคส / Case" });
    expect(values["patient.name"].value).toBe("นายทดสอบ ระบบ");
    expect(values["patient.dob"].value).toBe("1968-03-02");
    expect(values["patient.age_years"].value).toBe(58);
    expect(values["patient.weight_kg"]).toEqual({ value: 62.5, source: "บันทึก / Record" });
    expect(values["patient.blood_group"].value).toBe("O+");
    expect(values["patient.allergy"].value).toBe("Penicillin (rash)");
    expect(values["case.asa"].value).toBe("2E");
    expect(values["case.diagnosis"].value).toBe("Symptomatic gallstone (K80.2)");
    expect(values["case.operation"].value).toBe("Laparoscopic cholecystectomy");
    expect(values["case.date"].value).toBe("2026-10-14");
    expect(values["case.admit_date"].value).toBe("2026-10-13");
    expect(values["case.room"].value).toBe("OR 2");
    expect(values["anesthesia.technique"].value).toBe("General anesthesia, Regional");
    expect(values["anesthesia.time"].value).toBe("09:05 - 12:02 (02:57)");
    expect(values["surgery.duration"].value).toBe("09:25 - 11:40 (02:15)");
    expect(values["staff.anesthesiologist"].value).toBe("นพ. วิสัญญี");
    expect(values["staff.surgeon"].value).toBe("นพ. ศัลย์");
    expect(values["staff.nurse"].value).toBe("พว. สมใจ");
    expect(values["pacu.arrival"].value).toBe("10:42");
    expect(values["lab.hb"].value).toBe(12.8);
    expect(values["lab.plt"].value).toBe(245);
  });

  it("falls back to the HIS row and to the date of birth", () => {
    const less = caseValues(head, { ...loaded, draft: {} });
    expect(less["patient.weight_kg"]).toEqual({ value: 63, source: "HIS" });
    expect(less["case.asa"].value).toBe("3");
    expect(less["patient.age_years"]).toEqual({ value: 58, source: "คำนวณจากวันเกิด / From DOB" });
  });

  it("reads Thai and ISO dates", () => {
    expect(toIsoDate("02/03/2511")).toBe("1968-03-02");
    expect(toIsoDate("2/3/1968")).toBe("1968-03-02");
    expect(toIsoDate("1968-03-02T00:00:00Z")).toBe("1968-03-02");
    expect(toIsoDate("soon")).toBeNull();
  });
});

describe("filling a template", () => {
  const caseData: CaseData = { values: caseValues(head, loaded), failed: [], loadedAt: 0 };
  const definition = anesthesiaForm("form_20261014_ns1", "Test Form");

  it("fills the anesthesia template's patient header by field name, options matched by value or label", () => {
    const { data, lines } = fillFromCase(definition, {}, caseData);
    expect(data).toMatchObject({ hn: "6512345", an: "6700123", patient_name: "นายทดสอบ ระบบ", dob: "1968-03-02", age: 58, gender: "male", blood_type: "o_pos",
      weight: 62.5, height: 168, post_op_dx: "Symptomatic gallstone (K80.2)", op_date: "2026-10-14", admit_date: "2026-10-13", operation: "Laparoscopic cholecystectomy",
      room: "OR 2", asa_status: "2e", allergy: "Penicillin (rash)", discharge_location: "Ward 5", anesthesia_time: "09:05 - 12:02 (02:57)", surgery_duration: "09:25 - 11:40 (02:15)" });
    expect(lines.find(line => line.field === "id_card")?.status).toBe("empty");
    expect(lines.find(line => line.field === "hn")?.how).toBe("name");
    expect(validateDefinition(definition, DEFAULT_STYLES.map(s => s.style_id), DEFAULT_FONTS.map(f => f.font_id))).toEqual([]);
  });

  it("keeps what was typed into the form on Leaf, and follows an explicit bind", () => {
    const bound = { ...definition, sections: definition.sections.map(section => ({ ...section, fields: section.fields.map(field => (field.id === "case_type" ? { ...field, bind: "anesthesia.technique" } : field)) })) };
    const { data, lines } = fillFromCase(bound, { weight: 70 }, caseData);
    expect(data.weight).toBe(70);
    expect(lines.find(line => line.field === "weight")?.status).toBe("kept");
    expect(data.case_type).toBe("General anesthesia, Regional");
    expect(lines.find(line => line.field === "case_type")?.how).toBe("bind");
  });

  it("reports a case value that is not one of the field's options", () => {
    const odd: CaseData = { ...caseData, values: { ...caseData.values, "patient.blood_group": { value: "Bombay", source: "HIS" } } };
    const { data, lines } = fillFromCase(definition, {}, odd);
    expect(data.blood_type).toBeUndefined();
    expect(lines.find(line => line.field === "blood_type")).toMatchObject({ status: "unmatched", value: "Bombay" });
  });

  it("knows the usual field names", () => {
    expect(conceptOf({ id: "weight_kg" })).toEqual({ key: "patient.weight_kg", how: "name" });
    expect(conceptOf({ id: "x", bind: "lab.hb" })).toEqual({ key: "lab.hb", how: "bind" });
    expect(conceptOf({ id: "favourite_colour" })).toBeNull();
  });
});

describe("report-only workflow forms", () => {
  it("get no data-entry tab on Leaf", () => {
    const workflow = { workflow: { forms: [{ form_id: "a", version: 1, display: "tab" as const }, { form_id: "b", version: 1, display: "report" as const }] },
      forms: { a: { definition: anesthesiaForm("a", "A"), record: null }, b: { definition: anesthesiaForm("b", "B"), record: null } } };
    const tabs = workflowFormTabs(workflow as never);
    expect(tabs.map(tab => tab.formId)).toEqual(["a"]);
    expect(orderCaseTabs(["pacu"], tabs)).toHaveLength(2);
  });
});
