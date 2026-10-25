#!/usr/bin/env python3
"""Draft ICU forms (Form Studio, flora.form/1) and workflows (Workflow Studio, flora-workflow/1).

    python3 docs/icu-workflows/build_icu_workflows.py

Writes icu_neuro.workflow.json and icu_critical.workflow.json next to this script. Each file
carries its forms in `bundled_forms`, so Canopy → Workflow Studio → Import file creates the
forms (as drafts) and the workflow in one step. Every form is checked with the platform's
own validator (services/flora-api/app/formdev/definition.py) before writing.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
STYLE, FONT = "form.a4.medical", "noto-sans-thai"


# ---- field helpers ---------------------------------------------------------------
def opts(*pairs):
    return [{"value": v, "label": l} for v, l in pairs]


def f(id, type, label, **kw):
    field = {"id": id, "type": type, "label": label}
    field.update(kw)
    return field


def radio(id, label, options, **kw):
    return f(id, "radio", label, options=opts(*options), **kw)


def select(id, label, options, **kw):
    return f(id, "select", label, options=opts(*options), **kw)


def multi(id, label, options, **kw):
    return f(id, "multiselect", label, options=opts(*options), **kw)


def num(id, label, unit=None, lo=None, hi=None, decimals=None, **kw):
    field = f(id, "decimal" if decimals else "number", label, **kw)
    if unit:
        field["unit"] = unit
    if lo is not None:
        field["min"] = lo
    if hi is not None:
        field["max"] = hi
    if decimals:
        field["decimals"] = decimals
    return field


def integer(id, label, unit=None, lo=None, hi=None, **kw):
    field = f(id, "integer", label, **kw)
    if unit:
        field["unit"] = unit
    if lo is not None:
        field["min"] = lo
    if hi is not None:
        field["max"] = hi
    return field


def calc(id, label, formula, unit=None, decimals=0, **kw):
    field = f(id, "calculated", label, formula=formula, decimals=decimals, **kw)
    if unit:
        field["unit"] = unit
    return field


def check(id, label, **kw):
    return f(id, "checkbox", label, **kw)


def text(id, label, **kw):
    return f(id, "text", label, max_length=kw.pop("max_length", 200), **kw)


def note(id, label, **kw):
    return f(id, "textarea", label, max_length=kw.pop("max_length", 4000), **kw)


def when(field, operator, value=None):
    condition = {"field": field, "operator": operator}
    if value is not None:
        condition["value"] = value
    return {"when": condition}


def score(field, mapping):
    """IF-chain turning an option value into its points: score('gcs_e', {'4': 4, ...})."""
    expr = "NULL"
    for value, points in reversed(list(mapping.items())):
        expr = f"IF({field}='{value}', {points}, {expr})"
    return expr


def section(id, title, fields, description=None, **kw):
    s = {"id": id, "title": title, "fields": fields}
    if description:
        s["description"] = description
    s.update(kw)
    return s


def form(form_id, title, description, sections, **kw):
    d = {"format": "flora.form/1", "form_id": form_id, "schema_version": 1, "title": title,
         "description": description, "paper": {"size": "A4", "orientation": "portrait",
                                                "footer": {"left": "{title}", "right": "{page}/{pages}"}},
         "style_id": STYLE, "font_id": FONT, "offline": True, "sections": sections}
    d.update(kw)
    return d


def v1_dropped(*fields):
    """v2 migration: v1 kept these as a repeat/array; v2 is one entry per slot, so the old key goes."""
    return {"from": 1, "ops": [{"op": "remove_field", "field": name} for name in fields]}


GCS_E = [("4", "4 – Spontaneous"), ("3", "3 – To voice"), ("2", "2 – To pain"), ("1", "1 – None")]
GCS_V = [("5", "5 – Oriented"), ("4", "4 – Confused"), ("3", "3 – Words"), ("2", "2 – Sounds"), ("1", "1 – None"),
         ("t", "T – Intubated")]
GCS_M = [("6", "6 – Obeys"), ("5", "5 – Localises"), ("4", "4 – Withdraws"), ("3", "3 – Abnormal flexion"),
         ("2", "2 – Extension"), ("1", "1 – None")]
PUPIL = [("brisk", "Brisk"), ("sluggish", "Sluggish"), ("fixed", "Fixed"), ("closed", "Closed / unable")]
RASS = [("4", "+4 Combative"), ("3", "+3 Very agitated"), ("2", "+2 Agitated"), ("1", "+1 Restless"),
        ("0", "0 Alert and calm"), ("-1", "−1 Drowsy"), ("-2", "−2 Light sedation"), ("-3", "−3 Moderate sedation"),
        ("-4", "−4 Deep sedation"), ("-5", "−5 Unarousable")]
YES_NO_NA = [("yes", "Yes"), ("no", "No"), ("na", "N/A")]
SEX = [("male", "Male"), ("female", "Female")]
PBW = "IF(sex='male', 50, IF(sex='female', 45.5, NULL)) + 0.91 * (height_cm - 152.4)"


def gcs_total(e, v, m):
    return f"{score(e, {k: int(k) for k, _ in GCS_E})} + {score(v, {k: int(k) for k, _ in GCS_V if k != 't'} | {'t': 1})} + " \
           f"{score(m, {k: int(k) for k, _ in GCS_M})}"


# ===================================================================================
# Shared ICU forms
# ===================================================================================
icu_admission = form("icu_admission", "ICU Admission Assessment",
                     "แบบประเมินแรกรับผู้ป่วย ICU – used by every ICU workflow", [
    section("admission", "Admission · ข้อมูลการรับเข้า", [
        f("admit_at", "datetime", "Admitted to ICU", required=True, indexed=True),
        radio("icu_type", "ICU", [("neuro", "Neuro ICU"), ("critical", "Medical / Surgical critical care"),
                                   ("other", "Other")], required=True, indexed=True, option_columns=3),
        radio("admit_source", "Admitted from", [("er", "Emergency"), ("or", "Operating room"), ("ward", "Ward"),
                                                ("transfer", "Other hospital"), ("other", "Other")],
              option_columns=5, indexed=True),
        radio("admit_type", "Admission type", [("emergency", "Emergency"), ("elective", "Elective / planned post-op"),
                                               ("readmit", "ICU readmission < 48 h")], option_columns=3),
        note("admitting_diagnosis", "Admitting diagnosis", required=True, max_length=1000),
        multi("icu_reason", "Main reason for ICU", [
            ("resp_failure", "Respiratory failure"), ("shock", "Shock"), ("sepsis", "Sepsis"),
            ("neuro", "Neurological"), ("post_op", "Post-operative monitoring"), ("cardiac", "Cardiac"),
            ("metabolic", "Metabolic / renal"), ("trauma", "Trauma"), ("other", "Other")], option_columns=3),
        text("attending", "Attending intensivist"),
        radio("code_status", "Code status", [("full", "Full code"), ("dnr", "DNR"), ("limited", "Limited treatment"),
                                             ("palliative", "Palliative")], option_columns=4, indexed=True),
    ]),
    section("background", "History · ประวัติ", [
        radio("sex", "Sex", SEX, option_columns=2),
        num("weight_kg", "Weight", "kg", 1, 400, decimals=1),
        num("height_cm", "Height", "cm", 40, 250),
        calc("bmi", "BMI", "weight_kg / ((height_cm / 100) ^ 2)", "kg/m²", 1),
        calc("pbw_kg", "Predicted body weight", PBW, "kg", 1,
             description="For lung-protective ventilation (6–8 mL/kg PBW)"),
        multi("comorbid", "Comorbidities", [
            ("htn", "Hypertension"), ("dm", "Diabetes"), ("cad", "Coronary disease"), ("chf", "Heart failure"),
            ("ckd", "CKD"), ("esrd", "ESRD on dialysis"), ("copd", "COPD / asthma"), ("cirrhosis", "Cirrhosis"),
            ("stroke", "Previous stroke"), ("malignancy", "Malignancy"), ("immuno", "Immunosuppressed")],
              option_columns=3),
        note("allergies", "Allergies", max_length=1000),
        note("home_meds", "Home medications (anticoagulants / antiplatelets first)", max_length=2000),
    ]),
    section("initial", "Initial status · สภาวะแรกรับ", [
        radio("airway", "Airway", [("natural", "Natural"), ("ett", "Endotracheal tube"), ("trach", "Tracheostomy"),
                                   ("niv", "NIV / HFNC")], option_columns=4),
        integer("gcs_admit", "GCS on admission", None, 3, 15),
        num("map_admit", "MAP", "mmHg", 0, 250),
        check("vasopressor_admit", "On vasopressor"),
        num("lactate_admit", "Lactate", "mmol/L", 0, 30, decimals=1),
        integer("apache_ii", "APACHE II (first 24 h)", None, 0, 71, indexed=True),
        integer("sofa_admit", "SOFA on admission", None, 0, 24, indexed=True),
    ], layout={"type": "grid", "columns": 2}),
    section("goals", "Goals of care · เป้าหมายการรักษา", [
        check("family_informed", "Family informed of ICU admission"),
        note("goals_of_care", "Goals of care / family meeting notes", max_length=2000),
        text("assessed_by", "Assessed by", required=True),
        f("assessor_sign", "signature", "Signature"),
    ]),
])

# v2: one entry per ICU day (workflow schedule daily 07:00, docs/ICU-ROUNDS.md); the slot carries the date and
# the ICU day, so v1's per-day repeat, round_date and icu_day are gone.
icu_daily_round = form("icu_daily_round", "ICU Daily Round (FAST HUGS BID)",
                       "แบบบันทึก round ประจำวัน – one entry per ICU day (07:00 round)", [
    section("round", "Daily round · บันทึกรายวัน", [
            radio("rass", "RASS", RASS, option_columns=5),
            radio("rass_target", "RASS target", [("0", "0"), ("-1", "−1"), ("-2", "−2"), ("-3", "−3 or deeper")],
                  option_columns=4),
            radio("cam_icu", "CAM-ICU (delirium)", [("negative", "Negative"), ("positive", "Positive"),
                                                    ("unable", "Unable to assess (RASS −4/−5)")], option_columns=3),
            integer("cpot", "Pain – CPOT", None, 0, 8),
            radio("feeding", "F – Feeding", [("enteral", "Enteral"), ("oral", "Oral"), ("parenteral", "Parenteral"),
                                             ("npo", "NPO")], option_columns=4),
            check("analgesia_ok", "A – Analgesia adequate"),
            radio("sat_done", "S – Sedation interruption (SAT)", YES_NO_NA, option_columns=3),
            radio("dvt", "T – Thromboprophylaxis", [("lmwh", "LMWH"), ("ufh", "UFH"), ("mechanical", "Mechanical only"),
                                                     ("therapeutic", "Therapeutic anticoagulation"),
                                                     ("none", "Contraindicated")], option_columns=3),
            check("hob_30", "H – Head of bed ≥ 30°"),
            check("ulcer_ppx", "U – Stress-ulcer prophylaxis indicated and given"),
            check("glucose_ok", "G – Glucose 140–180 mg/dL"),
            radio("sbt_done", "S – Spontaneous breathing trial", YES_NO_NA, option_columns=3),
            check("bowel_ok", "B – Bowels open / regimen"),
            check("lines_reviewed", "I – Indwelling lines and catheters reviewed"),
            check("abx_reviewed", "D – De-escalation / antibiotic day reviewed"),
            radio("mobility", "Mobility level", [("0", "0 Bed rest"), ("1", "1 Passive ROM"), ("2", "2 Sit edge of bed"),
                                                 ("3", "3 Stand / chair"), ("4", "4 Walk")], option_columns=5),
            check("skin_ok", "Skin intact – no new pressure injury"),
            note("plan", "Problems and plan", max_length=3000),
            check("family_updated", "Family updated today"),
            text("round_by", "Physician"),
    ]),
], schema_version=2, migration=v1_dropped("rounds"))

icu_lines_devices = form("icu_lines_devices", "ICU Lines & Devices",
                         "ติดตามสายและอุปกรณ์ (CLABSI / CAUTI / VAP prevention)", [
    section("devices", "Invasive devices · สายและอุปกรณ์", [
        f("items", "repeat", "Device", view="table", fields=[
            select("device", "Device", [("cvc", "Central venous catheter"), ("picc", "PICC"), ("art", "Arterial line"),
                                        ("hd", "Dialysis catheter"), ("foley", "Urinary catheter"), ("ett", "ETT"),
                                        ("trach", "Tracheostomy"), ("evd", "EVD"), ("icp", "ICP bolt"),
                                        ("icd", "Chest drain"), ("ngt", "NG / OG tube"), ("other", "Other")],
                   required=True),
            text("site", "Site", max_length=60),
            f("inserted_on", "date", "Inserted", required=True),
            text("inserted_by", "By", max_length=60),
            f("removed_on", "date", "Removed"),
            calc("days", "Days", "DAYS(inserted_on, COALESCE(removed_on, TODAY()))", "d"),
            check("still_needed", "Needed today"),
        ]),
    ]),
    section("bundles", "Prevention bundles · bundle ป้องกันการติดเชื้อ", [
        check("clabsi_hand", "CLABSI – hand hygiene and maximal barrier at insertion"),
        check("clabsi_chg", "CLABSI – chlorhexidine skin prep, dressing clean and dated"),
        check("cauti_closed", "CAUTI – closed drainage, bag below bladder"),
        check("cauti_review", "CAUTI – daily removal review"),
        note("bundle_notes", "Notes", max_length=1000),
    ]),
])

icu_discharge = form("icu_discharge", "ICU Discharge / Transfer Summary",
                     "สรุปการจำหน่าย/ย้ายออกจาก ICU", [
    section("discharge", "Discharge · การจำหน่าย", [
        f("discharge_at", "datetime", "Left ICU", required=True, indexed=True),
        f("icu_admit_date", "date", "ICU admission date", required=True),
        calc("icu_los", "ICU length of stay", "DAYS(icu_admit_date, discharge_at)", "days"),
        radio("destination", "Destination", [("ward", "Ward"), ("step_down", "Step-down / HDU"), ("home", "Home"),
                                             ("transfer", "Other hospital"), ("death", "Died in ICU")],
              required=True, indexed=True, option_columns=5),
        radio("icu_type", "ICU", [("neuro", "Neuro ICU"), ("critical", "Critical care")], option_columns=2),
        note("final_diagnosis", "Final diagnoses", required=True, max_length=2000),
        multi("procedures", "ICU procedures", [
            ("mv", "Mechanical ventilation"), ("niv", "NIV / HFNC"), ("cvc", "Central line"), ("art", "Arterial line"),
            ("rrt", "Renal replacement therapy"), ("vaso", "Vasopressors"), ("trach", "Tracheostomy"),
            ("evd", "EVD / ICP monitoring"), ("craniotomy", "Neurosurgery"), ("transfusion", "Transfusion"),
            ("prone", "Prone positioning")], option_columns=3),
        integer("mv_days", "Ventilator days", "d", 0, 365),
        multi("complications", "ICU complications", [
            ("vap", "VAP"), ("clabsi", "CLABSI"), ("cauti", "CAUTI"), ("pressure", "Pressure injury"),
            ("delirium", "Delirium"), ("unplanned_extub", "Unplanned extubation"), ("reintubation", "Re-intubation < 48 h"),
            ("dvt_pe", "DVT / PE"), ("aki", "New AKI")], option_columns=3),
    ]),
    section("neuro_outcome", "Neurological outcome · ผลลัพธ์ทางระบบประสาท", [
        integer("gcs_discharge", "GCS at discharge", None, 3, 15),
        radio("mrs", "Modified Rankin Scale", [("0", "0 No symptoms"), ("1", "1 No significant disability"),
                                               ("2", "2 Slight disability"), ("3", "3 Moderate disability"),
                                               ("4", "4 Moderately severe"), ("5", "5 Severe disability"),
                                               ("6", "6 Dead")], option_columns=4),
    ], visibility=when("icu_type", "equals", "neuro")),
    section("handover", "Handover · ส่งต่อ", [
        note("handover", "Handover to receiving team (ISBAR)", max_length=4000),
        note("pending", "Pending results / follow-up", max_length=2000),
        text("discharged_by", "Discharged by", required=True),
        f("discharge_sign", "signature", "Signature"),
    ]),
])

# ===================================================================================
# Neuro ICU forms
# ===================================================================================
neuro_dx = [("tbi", "Traumatic brain injury"), ("sah", "Subarachnoid haemorrhage"), ("ich", "Intracerebral haemorrhage"),
            ("stroke", "Acute ischaemic stroke"), ("post_crani", "Post-craniotomy / tumour"),
            ("status", "Status epilepticus"), ("cns_inf", "CNS infection"), ("sci", "Spinal cord injury"),
            ("other", "Other")]
neuro_icu_assessment = form("neuro_icu_assessment", "Neuro ICU Assessment",
                            "แบบประเมินทางระบบประสาทแรกรับ Neuro ICU พร้อม scale ตามโรค", [
    section("diagnosis", "Neurological diagnosis · การวินิจฉัย", [
        radio("neuro_dx", "Primary neurological diagnosis", neuro_dx, required=True, indexed=True, option_columns=3),
        f("ictus_at", "datetime", "Onset / injury time"),
        text("neurosurgeon", "Neurosurgeon / neurologist"),
    ]),
    section("baseline", "Baseline neuro exam · ตรวจร่างกายแรกรับ", [
        radio("gcs_e", "Eye opening (E)", GCS_E, option_columns=4),
        radio("gcs_v", "Verbal (V)", GCS_V, option_columns=3),
        radio("gcs_m", "Motor (M)", GCS_M, option_columns=3),
        calc("gcs_total", "GCS total", gcs_total("gcs_e", "gcs_v", "gcs_m"), indexed=True),
        num("pupil_l_mm", "Left pupil size", "mm", 1, 9, decimals=1),
        select("pupil_l_react", "Left pupil reaction", PUPIL),
        num("pupil_r_mm", "Right pupil size", "mm", 1, 9, decimals=1),
        select("pupil_r_react", "Right pupil reaction", PUPIL),
        f("motor_power", "matrix", "Motor power (MRC 0–5)",
          rows=[{"id": "rue", "label": "Right arm"}, {"id": "lue", "label": "Left arm"},
                {"id": "rle", "label": "Right leg"}, {"id": "lle", "label": "Left leg"}],
          cols=[{"id": "prox", "label": "Proximal"}, {"id": "dist", "label": "Distal"}],
          cell={"type": "integer", "min": 0, "max": 5}),
        multi("brainstem", "Brainstem reflexes present",
              [("corneal", "Corneal"), ("cough", "Cough"), ("gag", "Gag"), ("oculo", "Oculocephalic")],
              option_columns=4),
    ]),
    section("tbi", "TBI", [
        radio("tbi_severity", "Severity (by GCS)", [("mild", "Mild 13–15"), ("moderate", "Moderate 9–12"),
                                                    ("severe", "Severe 3–8")], option_columns=3),
        integer("marshall_ct", "Marshall CT class", None, 1, 6),
        check("polytrauma", "Polytrauma"),
    ], visibility=when("neuro_dx", "equals", "tbi")),
    section("sah", "Subarachnoid haemorrhage", [
        radio("hunt_hess", "Hunt & Hess", [("1", "I"), ("2", "II"), ("3", "III"), ("4", "IV"), ("5", "V")],
              option_columns=5, indexed=True),
        radio("wfns", "WFNS grade", [("1", "I"), ("2", "II"), ("3", "III"), ("4", "IV"), ("5", "V")], option_columns=5),
        radio("mfisher", "Modified Fisher", [("0", "0"), ("1", "1"), ("2", "2"), ("3", "3"), ("4", "4")],
              option_columns=5),
        radio("aneurysm_tx", "Aneurysm treatment", [("coil", "Coiling"), ("clip", "Clipping"), ("pending", "Pending"),
                                                    ("none", "Not treated")], option_columns=4),
        check("nimodipine", "Nimodipine started"),
    ], visibility=when("neuro_dx", "equals", "sah")),
    section("ich", "Intracerebral haemorrhage – ICH score", [
        integer("ich_volume_ml", "Haematoma volume (ABC/2)", "mL", 0, 300),
        check("ich_ivh", "Intraventricular extension"),
        check("ich_infratentorial", "Infratentorial origin"),
        integer("ich_age", "Age", "y", 0, 120),
        calc("ich_score", "ICH score (0–6)",
             "IF(gcs_total <= 4, 2, IF(gcs_total <= 12, 1, 0)) + IF(ich_volume_ml >= 30, 1, 0) + IF(ich_ivh, 1, 0)"
             " + IF(ich_infratentorial, 1, 0) + IF(ich_age >= 80, 1, 0)", indexed=True),
        check("anticoag_reversal", "Anticoagulant reversal given"),
        integer("sbp_target", "SBP target", "mmHg", 100, 220),
    ], visibility=when("neuro_dx", "equals", "ich")),
    section("stroke", "Acute ischaemic stroke", [
        integer("nihss", "NIHSS", None, 0, 42, indexed=True),
        radio("reperfusion", "Reperfusion", [("ivt", "IV thrombolysis"), ("evt", "Thrombectomy"), ("both", "Both"),
                                             ("none", "None")], option_columns=4),
        f("reperfusion_at", "datetime", "Needle / groin puncture time"),
        check("dysphagia_screen", "Dysphagia screen before oral intake"),
    ], visibility=when("neuro_dx", "equals", "stroke")),
    section("status_epi", "Seizures", [
        radio("eeg", "EEG monitoring", [("none", "None"), ("routine", "Routine"), ("continuous", "Continuous cEEG")],
              option_columns=3),
        note("aed", "Antiseizure medication", max_length=1000),
    ], visibility={"when": {"or": [{"field": "neuro_dx", "operator": "equals", "value": "status"},
                                   {"field": "neuro_dx", "operator": "equals", "value": "tbi"},
                                   {"field": "neuro_dx", "operator": "equals", "value": "sah"}]}}),
    section("icp", "ICP monitoring and targets · เป้าหมาย ICP/CPP", [
        radio("icp_device", "ICP device", [("none", "None"), ("evd", "EVD"), ("parenchymal", "Parenchymal bolt")],
              option_columns=3),
        integer("evd_level", "EVD level above tragus", "cmH₂O", 0, 30,
                visibility=when("icp_device", "equals", "evd")),
        integer("icp_target", "ICP threshold", "mmHg", 10, 30),
        integer("cpp_target_low", "CPP target – lower", "mmHg", 40, 90),
        integer("cpp_target_high", "CPP target – upper", "mmHg", 50, 110),
        text("assessed_by", "Assessed by", required=True),
    ]),
])

neuro_icu_obs_chart = form("neuro_icu_obs_chart", "Neuro Observation Chart",
                           "บันทึก neuro sign รายชั่วโมง (GCS, pupils, ICP/CPP)", [
    section("obs", "Neuro observations · neuro sign", [
        f("entries", "repeat", "Observation", view="table", fields=[
            f("at", "time", "Time", required=True),
            select("e", "E", GCS_E),
            select("v", "V", GCS_V),
            select("m", "M", GCS_M),
            calc("gcs", "GCS", gcs_total("e", "v", "m")),
            num("pl", "L pupil", "mm", 1, 9, decimals=1),
            select("plr", "L react", PUPIL),
            num("pr", "R pupil", "mm", 1, 9, decimals=1),
            select("prr", "R react", PUPIL),
            integer("icp", "ICP", "mmHg", -10, 100),
            integer("map", "MAP", "mmHg", 0, 250),
            calc("cpp", "CPP", "map - icp", "mmHg"),
            integer("evd_out", "EVD out", "mL", 0, 200),
            check("seizure", "Seizure"),
            text("by", "Nurse", max_length=30),
        ]),
    ]),
    section("escalation", "Escalation · การรายงานแพทย์", [
        note("escalation_notes", "Drop in GCS ≥ 2, new pupil asymmetry, ICP > threshold > 5 min, CPP below target: "
             "time reported and action taken", max_length=3000),
    ]),
])

# v2: one entry per shift (workflow schedule per_shift); the slot carries the date and shift.
neuro_icu_brain_bundle = form("neuro_icu_brain_bundle", "Brain Protection Bundle",
                              "ป้องกัน secondary brain injury – one entry per shift", [
    section("shift", "Shift check · ตรวจทุกเวร", [
            check("hob", "Head of bed 30°, head neutral, collar / ETT ties not tight"),
            check("spo2_ok", "SpO₂ ≥ 94 %"),
            check("paco2_ok", "PaCO₂ / EtCO₂ 35–40 mmHg (no prophylactic hyperventilation)"),
            check("cpp_ok", "MAP / CPP within targets"),
            check("na_ok", "Sodium within target (avoid hyponatraemia)"),
            num("na", "Sodium", "mmol/L", 100, 180),
            check("glucose_ok", "Glucose 140–180 mg/dL"),
            check("normothermia", "Temperature ≤ 37.5 °C"),
            check("sedation_ok", "Sedation / analgesia at target, daily neuro-check window"),
            check("seizure_ppx", "Seizure prophylaxis / treatment given as ordered"),
            check("dvt_ok", "DVT prophylaxis (mechanical; drug when neurosurgery clears)"),
            multi("icp_tier", "ICP therapy used this shift", [
                ("tier0", "Tier 0 – basic measures"), ("tier1_csf", "Tier 1 – CSF drainage"),
                ("tier1_osm", "Tier 1 – mannitol / hypertonic saline"), ("tier2", "Tier 2 – deeper sedation / mild hypocapnia"),
                ("tier3", "Tier 3 – barbiturate / decompression")], option_columns=2),
            text("by", "Nurse", max_length=60),
    ]),
], schema_version=2, migration=v1_dropped("checks"))

# ===================================================================================
# Critical care forms
# ===================================================================================
CV_SOFA = [("0", "0 – MAP ≥ 70"), ("1", "1 – MAP < 70"), ("2", "2 – Dopamine ≤ 5 or dobutamine"),
           ("3", "3 – Dopamine > 5 or NE / Epi ≤ 0.1"), ("4", "4 – Dopamine > 15 or NE / Epi > 0.1")]
# v2: one entry per ICU day (workflow schedule daily 07:00); the slot carries the date.
critical_icu_sofa = form("critical_icu_sofa", "SOFA Score – Daily",
                         "คะแนน SOFA รายวัน คำนวณจากค่าแลบ – one entry per day", [
    section("sofa", "Daily SOFA · คะแนน SOFA", [
            num("pao2", "PaO₂", "mmHg", 20, 700),
            integer("fio2", "FiO₂", "%", 21, 100),
            check("resp_support", "Mechanical respiratory support"),
            calc("pf", "P/F ratio", "pao2 / (fio2 / 100)"),
            calc("s_resp", "Respiration",
                 "IF(pf < 100 AND resp_support, 4, IF(pf < 200 AND resp_support, 3, IF(pf < 300, 2, IF(pf < 400, 1, IF(pf >= 400, 0, NULL)))))"),
            integer("platelets", "Platelets", "×10³/µL", 0, 2000),
            calc("s_coag", "Coagulation",
                 "IF(platelets < 20, 4, IF(platelets < 50, 3, IF(platelets < 100, 2, IF(platelets < 150, 1, IF(platelets >= 150, 0, NULL)))))"),
            num("bilirubin", "Bilirubin", "mg/dL", 0, 60, decimals=1),
            calc("s_liver", "Liver",
                 "IF(bilirubin >= 12, 4, IF(bilirubin >= 6, 3, IF(bilirubin >= 2, 2, IF(bilirubin >= 1.2, 1, IF(bilirubin >= 0, 0, NULL)))))"),
            select("cv", "Cardiovascular", CV_SOFA),
            calc("s_cv", "Cardiovascular score", score("cv", {"0": 0, "1": 1, "2": 2, "3": 3, "4": 4})),
            integer("gcs", "GCS", None, 3, 15),
            calc("s_cns", "CNS", "IF(gcs < 6, 4, IF(gcs < 10, 3, IF(gcs < 13, 2, IF(gcs < 15, 1, IF(gcs = 15, 0, NULL)))))"),
            num("creatinine", "Creatinine", "mg/dL", 0, 30, decimals=1),
            integer("urine_24h", "Urine output 24 h", "mL", 0, 20000),
            calc("s_renal", "Renal",
                 "MAX(IF(creatinine >= 5, 4, IF(creatinine >= 3.5, 3, IF(creatinine >= 2, 2, IF(creatinine >= 1.2, 1, 0)))),"
                 " IF(urine_24h < 200, 4, IF(urine_24h < 500, 3, 0)))"),
            calc("sofa_total", "SOFA total", "s_resp + s_coag + s_liver + s_cv + s_cns + s_renal", indexed=True),
    ]),
], schema_version=2, migration=v1_dropped("days"))

critical_icu_sepsis_bundle = form("critical_icu_sepsis_bundle", "Sepsis Hour-1 Bundle",
                                  "Surviving Sepsis Campaign hour-1 bundle", [
    section("recognition", "Recognition · การคัดกรอง", [
        f("time_zero", "datetime", "Time zero (sepsis recognised)", required=True, indexed=True),
        text("suspected_source", "Suspected source"),
        check("qsofa_rr", "qSOFA – RR ≥ 22"),
        check("qsofa_mental", "qSOFA – altered mentation"),
        check("qsofa_sbp", "qSOFA – SBP ≤ 100"),
        calc("qsofa", "qSOFA", "IF(qsofa_rr, 1, 0) + IF(qsofa_mental, 1, 0) + IF(qsofa_sbp, 1, 0)"),
        radio("shock", "Septic shock (vasopressor for MAP ≥ 65 and lactate > 2)", [("yes", "Yes"), ("no", "No")],
              option_columns=2, indexed=True),
    ]),
    section("bundle", "Hour-1 bundle · ภายใน 1 ชั่วโมง", [
        num("lactate_1", "Lactate", "mmol/L", 0, 30, decimals=1),
        f("lactate_1_at", "datetime", "Lactate measured"),
        num("lactate_2", "Repeat lactate (if initial > 2)", "mmol/L", 0, 30, decimals=1,
            visibility=when("lactate_1", "gt", 2)),
        check("cultures_before_abx", "Blood cultures taken before antibiotics"),
        f("abx_at", "datetime", "Broad-spectrum antibiotics given"),
        note("abx_given", "Antibiotics", max_length=500),
        num("weight_kg", "Weight", "kg", 1, 400, decimals=1),
        calc("fluid_target_ml", "Crystalloid 30 mL/kg target", "weight_kg * 30", "mL"),
        integer("fluid_given_ml", "Crystalloid given (first 3 h)", "mL", 0, 20000),
        f("vaso_at", "datetime", "Vasopressor started"),
        integer("map_target", "MAP target", "mmHg", 55, 90),
        check("source_control", "Source control planned / done"),
    ]),
    section("review", "Reassessment · ประเมินซ้ำ", [
        note("reassessment", "Volume status / perfusion reassessment", max_length=2000),
        text("by", "Completed by", required=True),
    ]),
])

# v2: the per-shift VAP checks moved to critical_icu_vap_check (one entry per shift).
critical_icu_ventilator = form("critical_icu_ventilator", "Ventilator & Weaning",
                               "การตั้งเครื่องช่วยหายใจ lung-protective และการหย่าเครื่อง", [
    section("airway", "Airway · ทางเดินหายใจ", [
        f("intubated_at", "datetime", "Intubated", indexed=True),
        num("ett_size", "ETT size", "mm", 2, 10, decimals=1),
        integer("ett_mark", "ETT mark at lip", "cm", 5, 35),
        radio("sex", "Sex", SEX, option_columns=2),
        num("height_cm", "Height", "cm", 40, 250),
        calc("pbw_kg", "Predicted body weight", PBW, "kg", 1),
    ]),
    section("settings", "Ventilator settings · การตั้งเครื่อง", [
        f("settings", "repeat", "Setting", view="table", fields=[
            f("at", "datetime", "Time", required=True),
            select("mode", "Mode", [("vc_ac", "VC-AC"), ("pc_ac", "PC-AC"), ("simv", "SIMV"), ("psv", "PSV"),
                                    ("prvc", "PRVC"), ("aprv", "APRV"), ("cpap", "CPAP")]),
            integer("vt", "Vt", "mL", 0, 2000),
            calc("vt_kg", "Vt/PBW", "vt / pbw_kg", "mL/kg", 1),
            integer("rr", "RR", "/min", 0, 60),
            integer("peep", "PEEP", "cmH₂O", 0, 30),
            integer("fio2", "FiO₂", "%", 21, 100),
            integer("pplat", "Pplat", "cmH₂O", 0, 60),
            calc("dp", "Driving P", "pplat - peep", "cmH₂O"),
            integer("pao2", "PaO₂", "mmHg", 0, 700),
            calc("pf", "P/F", "pao2 / (fio2 / 100)"),
        ]),
    ]),
    section("ards", "ARDS management", [
        radio("ards", "ARDS (Berlin)", [("none", "No ARDS"), ("mild", "Mild P/F 200–300"),
                                        ("moderate", "Moderate 100–200"), ("severe", "Severe < 100")], option_columns=4),
        check("prone", "Prone positioning"),
        check("nmb", "Neuromuscular blockade"),
        check("conservative_fluid", "Conservative fluid strategy"),
    ]),
    section("weaning", "Weaning and extubation · การหย่าเครื่อง", [
        f("sbt_at", "datetime", "SBT"),
        radio("sbt_result", "SBT result", [("pass", "Pass"), ("fail", "Fail")], option_columns=2),
        integer("rsbi", "RSBI", "br/min/L", 0, 500),
        f("extubated_at", "datetime", "Extubated", indexed=True),
        radio("extubation_type", "Extubation", [("planned", "Planned"), ("unplanned", "Unplanned / self")],
              option_columns=2),
        check("reintubated_48h", "Re-intubated within 48 h"),
        integer("mv_days", "Ventilator days", "d", 0, 365),
    ]),
], schema_version=2, migration=v1_dropped("vap_checks"))

critical_icu_vap_check = form("critical_icu_vap_check", "VAP Bundle – Shift Check",
                              "bundle ป้องกัน VAP – one entry per shift while ventilated", [
    section("vap", "VAP bundle · bundle ป้องกัน VAP", [
        check("ventilated", "Patient on invasive ventilation this shift"),
        check("hob", "HOB 30–45°"),
        check("oral_care", "Oral care (chlorhexidine / toothbrushing)"),
        check("cuff", "Cuff pressure 20–30 cmH₂O"),
        check("subglottic", "Subglottic suction"),
        check("sat_sbt", "SAT / SBT assessed"),
        text("by", "Nurse", max_length=60),
    ]),
])

FORMS = [icu_admission, icu_daily_round, icu_lines_devices, icu_discharge, neuro_icu_assessment, neuro_icu_obs_chart,
         neuro_icu_brain_bundle, critical_icu_sofa, critical_icu_sepsis_bundle, critical_icu_ventilator,
         critical_icu_vap_check]
BY_ID = {d["form_id"]: d for d in FORMS}


# Scheduled forms (docs/ICU-ROUNDS.md): filled once per slot; the others once per case.
DAILY_0700 = {"kind": "daily", "at": "07:00", "days": None}
PER_SHIFT = {"kind": "per_shift", "days": None}
SCHEDULES = {"icu_daily_round": DAILY_0700, "critical_icu_sofa": DAILY_0700,
             "neuro_icu_brain_bundle": PER_SHIFT, "critical_icu_vap_check": PER_SHIFT}
SHIFTS = [{"code": "D", "label": "Day", "start": "07:00"}, {"code": "E", "label": "Evening", "start": "15:00"},
          {"code": "N", "label": "Night", "start": "23:00"}]


def workflow(id, name, description, forms):
    entries = []
    for fid, phase, required in forms:
        entry = {"form_id": fid, "version": BY_ID[fid]["schema_version"], "title": BY_ID[fid]["title"], "phase": phase,
                 "required": required}
        if fid in SCHEDULES:
            entry["schedule"] = dict(SCHEDULES[fid])
        entries.append(entry)
    return {
        "format": "flora-workflow/1", "id": id, "name": name, "description": description,
        "day_start": "07:00", "shifts": SHIFTS,
        "anesthesia_record": {"enabled": True, "sections": ["caseInfo", "outcome"],
                              "optional_sections": ["line", "comorbid", "pain"]},
        "forms": entries,
        "packet": [{"kind": "anesthesia_report", "mode": "standard"}] +
                  [{"kind": "form", "form_id": fid} for fid, _, _ in forms],
        "bundled_forms": {fid: {"version": BY_ID[fid]["schema_version"], "definition": BY_ID[fid]} for fid, _, _ in forms},
    }


WORKFLOWS = [
    workflow("icu_neuro", "Neuro ICU",
             "TBI, SAH, ICH, stroke, post-craniotomy and status epilepticus: neuro exam with disease scales, "
             "hourly neuro observation chart with ICP/CPP, brain protection bundle, daily rounds, devices, discharge.", [
                 ("icu_admission", "preop", True),
                 ("neuro_icu_assessment", "preop", True),
                 ("neuro_icu_obs_chart", "intraop", True),
                 ("neuro_icu_brain_bundle", "intraop", False),
                 ("icu_daily_round", "intraop", True),
                 ("icu_lines_devices", "intraop", False),
                 ("icu_discharge", "postop", True),
             ]),
    workflow("icu_critical", "Critical Care ICU",
             "Medical / surgical critical care: shock, sepsis and respiratory failure – daily SOFA, sepsis hour-1 "
             "bundle, lung-protective ventilation with a per-shift VAP bundle, daily rounds, devices, discharge.", [
                 ("icu_admission", "preop", True),
                 ("critical_icu_sofa", "intraop", True),
                 ("critical_icu_sepsis_bundle", "preop", False),
                 ("critical_icu_ventilator", "intraop", False),
                 ("critical_icu_vap_check", "intraop", False),
                 ("icu_daily_round", "intraop", True),
                 ("icu_lines_devices", "intraop", False),
                 ("icu_discharge", "postop", True),
             ]),
]


def main() -> int:
    sys.path.insert(0, str(ROOT / "services/flora-api"))
    from app.formdev.definition import validate_definition
    from app import form_schedule

    failed = False
    for definition in FORMS:
        issues = validate_definition(definition)
        for issue in issues:
            failed = True
            print(f"{definition['form_id']}: {issue}")
    for wf in WORKFLOWS:
        issues = form_schedule.day_settings_issues(wf.get("day_start"), wf.get("shifts"))
        for index, entry in enumerate(wf["forms"]):
            issues += form_schedule.schedule_issues(entry.get("schedule"), f"$.forms[{index}].schedule")
        for issue in issues:
            failed = True
            print(f"{wf['id']}: {issue}")
    if failed:
        return 1
    for wf in WORKFLOWS:
        path = HERE / f"{wf['id']}.workflow.json"
        path.write_text(json.dumps(wf, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)} ({len(wf['forms'])} forms)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
