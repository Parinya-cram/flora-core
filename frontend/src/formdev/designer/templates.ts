/**
 * Ready-made paper forms (Template phase): complete definitions laid out like the hospital's printed forms, built
 * with the paper-layout features (boxed sections, a patient header and a signature footer on every page, score
 * matrices, checklists in columns). The designer offers them as starting points; everything stays editable.
 */
import type { FieldDefinition, FieldOption, FormDefinition, MatrixCell, SectionDefinition } from "../core/types";

const options = (...items: Array<string | [string, string]>): FieldOption[] =>
  items.map(item => (Array.isArray(item) ? { value: item[0], label: item[1] } : { value: item.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label: item }));
const span = (n: number) => ({ layout: { span: n } });
const scale = (...values: string[]): MatrixCell => ({ type: "select", options: values.map(value => ({ value, label: value })) });

/** The patient header of the perioperative forms (PACU, anesthesia record): drawn at the top of every page. */
export function perioperativeHeader(title: string): SectionDefinition {
  const fields: FieldDefinition[] = [
    { id: "patient_name", type: "text", label: "Patient name", ...span(12) },
    { id: "hn", type: "text", label: "HN", required: true, indexed: true, ...span(4) },
    { id: "an", type: "text", label: "AN", indexed: true, ...span(4) },
    { id: "id_card", type: "text", label: "ID Card", ...span(4) },
    { id: "dob", type: "date", label: "D.O.B", ...span(4) },
    { id: "age", type: "integer", label: "Age", unit: "Y", min: 0, max: 150, ...span(3) },
    { id: "gender", type: "select", label: "Gender", options: options("Male", "Female"), ...span(4) },
    { id: "blood_type", type: "select", label: "Blood Type", options: options(["a_pos", "A+"], ["a_neg", "A-"], ["b_pos", "B+"], ["b_neg", "B-"], ["ab_pos", "AB+"], ["ab_neg", "AB-"], ["o_pos", "O+"], ["o_neg", "O-"]), ...span(4) },
    { id: "weight", type: "decimal", label: "WT", unit: "kg", decimals: 1, min: 0, max: 400, ...span(4) },
    { id: "height", type: "decimal", label: "HT", unit: "cm", decimals: 1, min: 0, max: 250, ...span(5) },
    { id: "post_op_dx", type: "text", label: "Post-OP Dx", ...span(14) },
    { id: "admit_date", type: "date", label: "Hospital admit Date", ...span(5) },
    { id: "op_date", type: "date", label: "Op. Date", ...span(5) },
    { id: "operation", type: "text", label: "Operation", ...span(14) },
    { id: "room", type: "text", label: "Room", ...span(3) },
    { id: "asa_status", type: "select", label: "ASA Status", options: options("1", "2", "3", "4", "5", "6", ["1e", "1E"], ["2e", "2E"], ["3e", "3E"], ["4e", "4E"], ["5e", "5E"]), ...span(3) },
    { id: "case_type", type: "text", label: "Case Type", ...span(4) },
    { id: "allergy", type: "text", label: "Allergy", ...span(24) },
  ];
  return { id: "patient_header", title, print_style: "boxed", repeat_on_pages: "header", fields };
}

/** Signatures and times at the bottom of every page. */
export function perioperativeFooter(): SectionDefinition {
  return {
    id: "signatures", title: "Signatures", print_style: "boxed", hide_title: true, repeat_on_pages: "footer",
    fields: [
      { id: "surgeon_sign", type: "signature", label: "Surgeon", ...span(4) },
      { id: "anesthesiologist_sign", type: "signature", label: "Anesthesiologist", ...span(4) },
      { id: "anesthesia_nurse1_sign", type: "signature", label: "Anesthesia nurse 1", ...span(4) },
      { id: "anesthesia_nurse2_sign", type: "signature", label: "Anesthesia nurse 2", ...span(4) },
      { id: "discharge_info", type: "group", label: "Discharge", ...span(8), fields: [
        { id: "discharge_location", type: "text", label: "Discharge Location", ...span(24) },
        { id: "anesthesia_time", type: "text", label: "Anesthesia time", placeholder: "09:10 - 13:35 (04:25)", ...span(24) },
        { id: "surgery_duration", type: "text", label: "Surgery Duration", placeholder: "10:05 - 13:20 (03:15)", ...span(24) },
      ] },
    ],
  };
}

const SCORE = scale("0", "1", "2");

/** PACU: Post Anesthetic Record, as on the hospital's paper form (one A4 page). */
export function pacuForm(formId: string, title: string): FormDefinition {
  return {
    format: "flora.form/1", form_id: formId, schema_version: 1, title, paper: { size: "A4", orientation: "portrait", margin_mm: { top: 10, right: 10, bottom: 12, left: 10 } },
    style_id: "style.a4.medical", layout: { type: "grid", columns: 24 },
    extensions: { "flora.subject_field": "hn" },
    sections: [
      perioperativeHeader("PACU"),
      { id: "recovery", title: "PACU: Post Anesthetic Record", print_style: "boxed", fields: [
        { id: "recovery_place", type: "text", label: "Recovery Place", ...span(8) },
        { id: "recovery_start", type: "time", label: "Recovery Time Start", ...span(8) },
        { id: "recovery_end", type: "time", label: "Recovery Time End", ...span(8) },
      ] },
      { id: "aldrete", title: "The Modified Aldrete Score (MASS)", print_style: "boxed", fields: [
        { id: "mass", type: "matrix", label: "Criteria", ...span(24), cell: SCORE,
          rows: [
            { id: "activity", label: "Activity" }, { id: "respiration", label: "Respiration" }, { id: "circulation", label: "Circulation" },
            { id: "consciousness", label: "Consciousness" }, { id: "spo2", label: "Spo2" },
            { id: "pain", label: "Pain Score", cell: { type: "integer", min: 0, max: 10 } },
            { id: "sedation", label: "Sedation Score", cell: scale("0", "1", "2", "3", "S") },
          ],
          cols: [{ id: "preop", label: "Preop" }, { id: "admit", label: "Admit" }, { id: "m15", label: "15’" }, { id: "m30", label: "30’" },
            { id: "m45", label: "45’" }, { id: "m60", label: "60’" }, { id: "dc", label: "D/C" }],
          totals: [{ id: "total", label: "Total", of: ["activity", "respiration", "circulation", "consciousness", "spo2"] }] },
      ] },
      { id: "problems", title: "Immediate Post Anesthetic Problems", print_style: "boxed", hide_title: true, fields: [
        { id: "post_anesthetic_problems", type: "multiselect", label: "Immediate Post Anesthetic Problems", option_columns: 4, ...span(24),
          options: [
            ...options("Alteration of Consciousness", "Weakness after operation", "Nausea / Vomiting", "Skin bleb", "Sore throat", "Oropharyngeal injury", "Delirium",
              "Anaphylaxis", "Shivering", "Contact dermatitis", "Arrhythmia", "Reintubation", "Pulmonary aspiration", "Convulsion", "Desaturation", "Suspected MI", "Coma",
              "Suspected PE", "Nerve injuries", "Death", "Cardiac arrest", "No complication", "Awareness"),
            { value: "other", label: "Other", has_input: true },
          ] },
      ] },
      { id: "discharge", title: "Immediate Post Anesthetic Record", print_style: "boxed", hide_title: true, fields: [
        { id: "post_record", type: "group", label: "Immediate Post Anesthetic Record", ...span(8), fields: [
          { id: "gcs_e", type: "select", label: "GCS: E", options: options("1", "2", "3", "4"), ...span(24) },
          { id: "gcs_v", type: "select", label: "GCS: V", options: options("1", "2", "3", "4", "5", ["t", "T"]), ...span(24) },
          { id: "gcs_m", type: "select", label: "GCS: M", options: options("1", "2", "3", "4", "5", "6"), ...span(24) },
          { id: "motor_upper", type: "text", label: "Motor power gr. Upper Rt/Lt", placeholder: "V / V", ...span(24) },
          { id: "motor_lower", type: "text", label: "Motor power gr. Lower Rt/Lt", placeholder: "V / V", ...span(24) },
        ] },
        { id: "discharge_status", type: "radio", label: "Discharge Status", option_columns: 1, ...span(8),
          options: [{ value: "awake", label: "Fully awake or return to baseline conscious" }, { value: "other", label: "Other", has_input: true }] },
        { id: "continuing_care", type: "multiselect", label: "Continuing Care", option_columns: 1, ...span(8),
          options: [...options("Airway", ["vs", "V/S"], ["ns", "N/S"], "Pain score", "Bleeding", "Motor power", ["io", "I/O"]), { value: "other", label: "Other", has_input: true }] },
      ] },
      perioperativeFooter(),
    ],
  };
}

/** Complete forms offered as starting points, by starter id. */
export const PAPER_TEMPLATES: Record<string, (formId: string, title: string) => FormDefinition> = { pacu: pacuForm };
