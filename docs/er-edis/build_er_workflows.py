#!/usr/bin/env python3
"""Emergency department (EDIS) forms and workflows for Form Studio / Workflow Studio.

    python3 docs/er-edis/build_er_workflows.py

Writes er_emergency.workflow.json and er_fast_track.workflow.json (forms bundled) next to this
script after checking every form with the platform validator. Clinical thresholds are NOT
encoded: triage time targets, danger-zone vital signs and pathway targets differ between
sources and hospitals and must be confirmed (see EDIS-Blueprint.md §1). The suggested triage
level only follows the published decision order (life-saving → high risk → resources).
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
_spec = importlib.util.spec_from_file_location("icu", HERE.parent / "icu-workflows/build_icu_workflows.py")
icu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(icu)
f, radio, select, multi, num, integer, calc, check, text, note, when, score, section, form = (
    icu.f, icu.radio, icu.select, icu.multi, icu.num, icu.integer, icu.calc, icu.check, icu.text, icu.note,
    icu.when, icu.score, icu.section, icu.form)
GCS_E, GCS_V, GCS_M, PUPIL, SEX, YES_NO_NA = icu.GCS_E, icu.GCS_V, icu.GCS_M, icu.PUPIL, icu.SEX, icu.YES_NO_NA
gcs_total = icu.gcs_total

# Triage levels: 5 levels and colours as used with MOPH ED Triage (กรมการแพทย์ 2561). Thai names and
# time targets vary between published sources, so they are not part of the labels.
LEVELS = [("1", "1 · Resuscitation · แดง"), ("2", "2 · Emergency · ชมพู"), ("3", "3 · Urgency · เหลือง"),
          ("4", "4 · Semi-urgency · เขียว"), ("5", "5 · Non-urgency · ขาว")]
LEVEL_NUM = score("triage_level", {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5})
# Zones of the ER care unit (room attribute "zone" in Canopy). Hospital-specific.
ZONES = [("resuscitation", "Resuscitation (Red)"), ("trauma", "Trauma"), ("acute_pink", "Acute (Pink)"),
         ("urgent_yellow", "Urgent (Yellow)"), ("fast_track", "Fast track"), ("observation", "Observation"),
         ("isolation", "Isolation"), ("pediatric", "Pediatric"), ("psychiatric", "Psychiatric"),
         ("procedure", "Procedure")]
ARRIVAL = [("walk_in", "Walk-in"), ("ems", "EMS / 1669"), ("referral", "Referral from another hospital"),
           ("internal", "Internal transfer (OPD / ward)"), ("police", "Brought by police / rescue"),
           ("other", "Other")]
CATEGORY = [("trauma", "Trauma (บาดเจ็บ)"), ("non_trauma", "Non-trauma (เจ็บป่วย)")]
AVPU = [("A", "A – Alert"), ("V", "V – Voice"), ("P", "P – Pain"), ("U", "U – Unresponsive")]
SIGN = lambda id="signature", label="Signature": f(id, "signature", label)  # noqa: E731


def vitals(prefix=""):
    p = prefix
    return [
        integer(f"{p}sbp", "SBP", "mmHg", 0, 300), integer(f"{p}dbp", "DBP", "mmHg", 0, 200),
        integer(f"{p}hr", "HR", "/min", 0, 300), integer(f"{p}rr", "RR", "/min", 0, 80),
        num(f"{p}temp", "Temp", "°C", 25, 45, decimals=1), integer(f"{p}spo2", "SpO₂", "%", 0, 100),
        select(f"{p}o2", "O₂ support", [("room_air", "Room air"), ("cannula", "Cannula"), ("mask", "Mask"),
                                        ("nrb", "Non-rebreather"), ("hfnc", "HFNC"), ("niv", "NIV"), ("ett", "ETT / BVM")]),
        integer(f"{p}dtx", "Capillary glucose", "mg/dL", 0, 2000), integer(f"{p}pain", "Pain score", "0–10", 0, 10),
    ]


# ============================================================================= forms
er_registration = form("er_registration", "ER Registration", "Form 01 · ลงทะเบียนผู้ป่วยห้องฉุกเฉิน", [
    section("visit", "Visit · การมารับบริการ", [
        text("hn", "HN", required=True, indexed=True, max_length=20),
        text("vn", "VN / AN", indexed=True, max_length=30),
        text("encounter_id", "Encounter ID (HIS)", max_length=60),
        f("arrival_at", "datetime", "Arrived at ER", required=True, indexed=True),
        radio("arrival_mode", "Arrival", ARRIVAL, required=True, indexed=True, option_columns=3),
        radio("category", "Patient category", CATEGORY, indexed=True, option_columns=2,
              description="Trauma / non-trauma is separate from the triage level and from the treatment area."),
    ]),
    section("ems", "EMS · การนำส่ง", [
        text("ems_operation_no", "EMS operation number", max_length=40),
        select("ems_team_level", "Team level", [("als", "ALS"), ("ils", "ILS"), ("bls", "BLS"), ("fr", "FR"),
                                                 ("other", "Other")]),
        text("ems_unit", "Unit / agency", max_length=120),
        f("ems_dispatch_at", "datetime", "Call / dispatch time"),
        f("ems_scene_at", "datetime", "At scene"),
        note("ems_prehospital", "Pre-hospital care and handover notes", max_length=2000),
    ], visibility=when("arrival_mode", "equals", "ems")),
    section("referral", "Referral in · รับส่งต่อ", [
        text("referring_hospital", "Referring hospital", max_length=200),
        text("referral_no", "Referral document number", max_length=60),
        note("referral_reason", "Reason for referral", max_length=1000),
    ], visibility=when("arrival_mode", "equals", "referral")),
    section("coverage", "Coverage · สิทธิการรักษา", [
        select("coverage", "Coverage (สิทธิ)", [("uc", "UC (บัตรทอง)"), ("sss", "Social security (ประกันสังคม)"),
                                               ("csmbs", "Civil servant (ข้าราชการ)"), ("lgo", "Local government (อปท.)"),
                                               ("self_pay", "Self-pay"), ("insurance", "Private insurance"),
                                               ("other", "Other")], indexed=True),
        check("ucep_assessed", "Assessed for UCEP (เจ็บป่วยฉุกเฉินวิกฤต) — criteria per สพฉ./สปสช."),
        check("road_accident", "Road accident (พ.ร.บ. ผู้ประสบภัยจากรถ)"),
        text("contact_name", "Relative / contact", max_length=120),
        text("contact_phone", "Contact phone", max_length=30),
        text("registered_by", "Registered by", required=True, max_length=120),
    ]),
])

er_triage = form("er_triage", "Emergency Triage Record", "Form 02 · คัดแยกผู้ป่วยฉุกเฉิน (MOPH ED Triage 5 ระดับ)", [
    section("arrival", "Arrival · การมาถึง", [
        f("arrival_at", "datetime", "Arrived at ER", required=True),
        radio("arrival_mode", "Arrival", ARRIVAL, option_columns=3),
        radio("category", "Patient category", CATEGORY, option_columns=2),
        note("chief_complaint", "Chief complaint (อาการสำคัญ)", required=True, max_length=500),
        integer("duration_value", "Duration", None, 0, 100000),
        select("duration_unit", "Unit", [("min", "minutes"), ("h", "hours"), ("d", "days"), ("w", "weeks")]),
    ]),
    section("vitals", "Vital signs · สัญญาณชีพ", vitals() + [
        radio("avpu", "Consciousness (AVPU)", AVPU, option_columns=4),
        select("gcs_e", "GCS E", GCS_E), select("gcs_v", "GCS V", GCS_V), select("gcs_m", "GCS M", GCS_M),
        calc("gcs", "GCS", gcs_total("gcs_e", "gcs_v", "gcs_m")),
    ], layout={"type": "grid", "columns": 3}),
    section("decision", "Decision points · การตัดสินระดับ", [
        check("dp_lifesaving", "Needs an immediate life-saving intervention"),
        check("dp_high_risk", "High-risk situation"),
        check("dp_altered", "New confusion, lethargy or disorientation"),
        check("dp_severe_pain", "Severe pain or distress"),
        radio("resources", "Resources expected", [("0", "None"), ("1", "One"), ("2plus", "Two or more")],
              option_columns=3),
        check("dp_danger_vitals", "Vital signs in the hospital's danger zone"),
        calc("suggested_level", "Suggested level",
             "IF(dp_lifesaving, 1, IF(dp_high_risk OR dp_altered OR dp_severe_pain, 2, "
             "IF(resources = '2plus', IF(dp_danger_vitals, 2, 3), IF(resources = '1', 4, IF(resources = '0', 5, NULL)))))",
             description="Follows the published decision order (life-saving → high risk → resources). "
                         "Danger-zone limits and any local criteria are set by the hospital."),
    ], description="Decision order of MOPH ED Triage / ESI v4. Confirm against the edition the hospital uses."),
    section("result", "Triage level · ระดับความฉุกเฉิน", [
        radio("triage_level", "Triage level", LEVELS, required=True, indexed=True, option_columns=5),
        calc("level_num", "Level (number)", LEVEL_NUM, hidden=True),
        note("triage_reason", "Reason for the level (เหตุผลประกอบการคัดแยก)", max_length=1000),
        note("override_reason", "Why the level differs from the suggestion", max_length=500),
        select("assigned_zone", "Assigned area (zone)", ZONES, indexed=True),
        f("triaged_at", "datetime", "Triage time", required=True, indexed=True),
        text("triage_nurse", "Triage nurse", required=True, max_length=120),
    ]),
    section("retriage", "Re-triage · คัดแยกซ้ำ", [
        f("retriage", "repeat", "Re-triage", view="table", fields=[
            f("at", "datetime", "Time", required=True),
            select("level", "Level", LEVELS, required=True),
            select("zone", "Area", ZONES),
            text("reason", "Reason", max_length=200),
            text("by", "By", max_length=60),
        ]),
    ]),
], rules=[{"id": "override_needs_reason",
           "assert": "ISBLANK(level_num) OR ISBLANK(suggested_level) OR level_num = suggested_level OR NOT ISBLANK(override_reason)",
           "message": "Give a reason when the level differs from the suggested level", "fields": ["override_reason"]}])

er_physician = form("er_physician_assessment", "Emergency Physician Assessment", "Form 03 · บันทึกการตรวจของแพทย์", [
    section("seen", "Seen by physician", [
        f("seen_at", "datetime", "Physician first saw patient", required=True, indexed=True),
        text("physician", "Physician", required=True, max_length=120),
    ]),
    section("history", "History · ประวัติ", [
        note("hpi", "History of present illness", required=True),
        note("pmh", "Past medical / surgical history"),
        note("medications", "Current medications"),
        text("allergies", "Allergies", max_length=500),
        note("social", "Social / family history", max_length=1000),
    ]),
    section("exam", "Physical examination · ตรวจร่างกาย", [
        note("pe_general", "General appearance", max_length=1000), note("pe_heent", "HEENT", max_length=1000),
        note("pe_cvs", "Cardiovascular", max_length=1000), note("pe_resp", "Respiratory", max_length=1000),
        note("pe_abd", "Abdomen", max_length=1000), note("pe_neuro", "Neurological", max_length=1000),
        note("pe_ext", "Extremities / skin", max_length=1000), note("pe_other", "Other findings", max_length=1000),
    ]),
    section("impression", "Assessment and plan", [
        note("ddx", "Differential diagnosis", max_length=1000),
        text("dx_icd10", "Working diagnosis – ICD-10", indexed=True, max_length=20),
        text("dx_text", "Working diagnosis", required=True, max_length=300),
        note("plan", "Treatment plan / initial orders", required=True),
        SIGN(),
    ]),
])

er_nursing = form("er_nursing_assessment", "ER Nursing Assessment", "Form 04 · ประเมินและบันทึกทางการพยาบาล", [
    section("initial", "Initial nursing assessment", [
        f("assessed_at", "datetime", "Assessed at", required=True),
        radio("airway", "Airway", [("patent", "Patent"), ("at_risk", "At risk"), ("obstructed", "Obstructed")],
              option_columns=3),
        radio("breathing", "Breathing", [("normal", "Normal"), ("distress", "Distress"), ("assisted", "Assisted")],
              option_columns=3),
        radio("circulation", "Circulation", [("normal", "Normal"), ("impaired", "Impaired"), ("shock", "Shock signs")],
              option_columns=3),
        radio("avpu", "Consciousness", AVPU, option_columns=4),
        integer("pain", "Pain score", "0–10", 0, 10),
        select("fall_risk", "Fall risk", [("low", "Low"), ("moderate", "Moderate"), ("high", "High")]),
        multi("risks", "Other risks", [("aspiration", "Aspiration"), ("pressure", "Pressure injury"),
                                       ("violence", "Violence / aggression"), ("self_harm", "Self-harm"),
                                       ("infection", "Infection control precautions"), ("bleeding", "Bleeding")],
              option_columns=3),
        text("allergies", "Allergies", max_length=500),
    ]),
    section("care_plan", "Nursing diagnoses and interventions", [
        f("diagnoses", "repeat", "Nursing diagnosis", view="cards", fields=[
            text("diagnosis", "Nursing diagnosis", required=True, max_length=300),
            note("goal", "Goal", max_length=500), note("interventions", "Interventions", max_length=1000),
            note("evaluation", "Evaluation", max_length=500),
        ]),
    ]),
    section("progress", "Nursing progress notes", [
        f("notes", "repeat", "Note", view="table", fields=[
            f("at", "datetime", "Time", required=True), note("note", "Progress / reassessment", max_length=2000),
            text("by", "Nurse", max_length=60),
        ]),
    ]),
])

RTS_GCS = [("4", "4 · GCS 13–15"), ("3", "3 · 9–12"), ("2", "2 · 6–8"), ("1", "1 · 4–5"), ("0", "0 · 3")]
RTS_SBP = [("4", "4 · SBP > 89"), ("3", "3 · 76–89"), ("2", "2 · 50–75"), ("1", "1 · 1–49"), ("0", "0 · 0")]
RTS_RR = [("4", "4 · RR 10–29"), ("3", "3 · > 29"), ("2", "2 · 6–9"), ("1", "1 · 1–5"), ("0", "0 · 0")]
CODE = {"4": 4, "3": 3, "2": 2, "1": 1, "0": 0}
er_trauma = form("er_trauma_assessment", "Trauma Assessment", "Form 05 · ประเมินผู้บาดเจ็บ (Primary / Secondary survey)", [
    section("mechanism", "Mechanism of injury", [
        f("injured_at", "datetime", "Time of injury"),
        select("mechanism", "Mechanism", [("rta_motorcycle", "Road traffic – motorcycle"), ("rta_car", "Road traffic – car"),
                                           ("rta_pedestrian", "Road traffic – pedestrian"), ("fall_height", "Fall from height"),
                                           ("fall_level", "Fall – same level"), ("assault", "Assault"), ("stab", "Stab"),
                                           ("gunshot", "Gunshot"), ("burn", "Burn"), ("crush", "Crush"),
                                           ("other", "Other")], indexed=True),
        multi("protection", "Protection", [("helmet", "Helmet"), ("seatbelt", "Seat belt"), ("airbag", "Airbag"),
                                           ("none", "None")], option_columns=4),
        check("alcohol", "Alcohol / substance suspected"),
        note("mechanism_detail", "Details", max_length=1000),
        check("trauma_team", "Trauma team activated"),
        f("trauma_team_at", "datetime", "Activation time", visibility=when("trauma_team", "equals", True)),
    ]),
    section("primary", "Primary survey (ABCDE)", [
        note("a_airway", "A – Airway and C-spine", max_length=1000), note("b_breathing", "B – Breathing", max_length=1000),
        note("c_circulation", "C – Circulation / haemorrhage control", max_length=1000),
        note("d_disability", "D – Disability (GCS, pupils)", max_length=1000),
        note("e_exposure", "E – Exposure / temperature", max_length=1000),
        multi("adjuncts", "Adjuncts", [("efast", "eFAST"), ("cxr", "Chest X-ray"), ("pelvis_xr", "Pelvis X-ray"),
                                       ("ecg", "ECG"), ("abg", "ABG"), ("foley", "Urinary catheter"), ("ngt", "NG tube")],
              option_columns=4),
    ]),
    section("score", "Revised Trauma Score", [
        select("rts_gcs", "GCS (coded)", RTS_GCS), select("rts_sbp", "SBP (coded)", RTS_SBP),
        select("rts_rr", "RR (coded)", RTS_RR),
        calc("rts", "RTS", f"0.9368 * ({score('rts_gcs', CODE)}) + 0.7326 * ({score('rts_sbp', CODE)}) + "
                           f"0.2908 * ({score('rts_rr', CODE)})", decimals=4),
        integer("iss", "Injury Severity Score (if calculated)", None, 0, 75),
    ], description="RTS = 0.9368·GCSc + 0.7326·SBPc + 0.2908·RRc (Champion et al., 1989)."),
    section("secondary", "Secondary survey", [
        note("secondary", "Head-to-toe findings", max_length=4000),
        f("injuries", "repeat", "Injury", view="table", fields=[
            select("region", "Region", [("head", "Head"), ("face", "Face"), ("neck", "Neck"), ("chest", "Chest"),
                                        ("abdomen", "Abdomen"), ("pelvis", "Pelvis"), ("spine", "Spine"),
                                        ("upper", "Upper limb"), ("lower", "Lower limb"), ("skin", "Skin / burn")]),
            text("injury", "Injury", max_length=200), text("plan", "Plan", max_length=200),
        ]),
    ]),
    section("reassess", "Reassessment", [
        f("reassessments", "repeat", "Reassessment", view="table", fields=[
            f("at", "datetime", "Time", required=True), integer("gcs", "GCS", None, 3, 15),
            integer("sbp", "SBP", "mmHg", 0, 300), integer("hr", "HR", "/min", 0, 300),
            text("change", "Change / action", max_length=200), text("by", "By", max_length=60),
        ]),
    ]),
])

er_resus = form("er_resuscitation_record", "Resuscitation Record", "Form 06 · บันทึกการช่วยฟื้นคืนชีพ", [
    section("arrest", "Arrest", [
        f("arrest_at", "datetime", "Arrest / collapse time", required=True),
        radio("location", "Location", [("prehospital", "Pre-hospital"), ("er", "In ER")], option_columns=2),
        check("witnessed", "Witnessed"), check("bystander_cpr", "Bystander CPR"),
        select("initial_rhythm", "Initial rhythm", [("vf", "VF"), ("pvt", "Pulseless VT"), ("pea", "PEA"),
                                                     ("asystole", "Asystole"), ("unknown", "Unknown")], indexed=True),
        f("cpr_start_at", "datetime", "CPR started (ER)"),
        text("team_leader", "Team leader", max_length=120),
    ]),
    section("timeline", "CPR timeline", [
        f("events", "repeat", "Event", view="table", fields=[
            f("at", "time", "Time", required=True),
            select("event", "Event", [("cpr", "CPR cycle"), ("rhythm", "Rhythm check"), ("shock", "Defibrillation"),
                                      ("drug", "Drug"), ("airway", "Airway"), ("rosc", "ROSC"), ("other", "Other")]),
            select("rhythm", "Rhythm", [("vf", "VF"), ("pvt", "pVT"), ("pea", "PEA"), ("asystole", "Asystole"),
                                        ("organised", "Organised")]),
            integer("joules", "Joules", "J", 0, 400),
            text("drug", "Drug / dose / route", max_length=120),
            text("note", "Note", max_length=200),
        ]),
    ]),
    section("airway", "Airway", [
        select("airway_device", "Device", [("bvm", "BVM"), ("sga", "Supraglottic"), ("ett", "Endotracheal tube")]),
        num("ett_size", "ETT size", "mm", 2, 10, decimals=1), integer("ett_depth", "Depth at lip", "cm", 5, 35),
        f("airway_at", "datetime", "Placed at"), check("etco2_confirmed", "Placement confirmed with EtCO₂"),
    ]),
    section("outcome", "Outcome", [
        radio("outcome", "Outcome", [("rosc", "ROSC"), ("ongoing", "Ongoing at transfer"), ("terminated", "Resuscitation stopped")],
              required=True, indexed=True, option_columns=3),
        f("rosc_at", "datetime", "ROSC time", visibility=when("outcome", "equals", "rosc")),
        f("terminated_at", "datetime", "Stopped at", visibility=when("outcome", "equals", "terminated")),
        note("post_rosc", "Post-ROSC care / disposition", max_length=2000),
        SIGN("leader_sign", "Team leader signature"),
    ]),
])

er_procedure = form("er_procedure_record", "Emergency Procedure Record", "Form 09 · บันทึกหัตถการ", [
    section("procedures", "Procedures", [
        f("procedures", "repeat", "Procedure", view="cards", fields=[
            select("procedure", "Procedure", [("intubation", "Endotracheal intubation"), ("cvc", "Central line"),
                                              ("art", "Arterial line"), ("chest_drain", "Chest drain"),
                                              ("suture", "Wound suturing"), ("splint", "Splint / cast"),
                                              ("reduction", "Reduction"), ("i_and_d", "Incision and drainage"),
                                              ("lp", "Lumbar puncture"), ("ngt", "NG tube"), ("foley", "Urinary catheter"),
                                              ("cardioversion", "Cardioversion / pacing"), ("other", "Other")], required=True),
            text("icd9cm", "ICD-9-CM", max_length=12),
            f("at", "datetime", "Time", required=True), text("site", "Site / side", max_length=120),
            text("operator", "Operator", required=True, max_length=120), text("assistant", "Assistant", max_length=120),
            check("consent", "Consent obtained (per hospital consent policy)"),
            note("details", "Technique / findings", max_length=2000),
            text("complications", "Complications", max_length=300),
        ]),
    ]),
])

er_investigations = form("er_investigations", "Investigations & Results", "Form 10 · การส่งตรวจและผล", [
    section("lab", "Laboratory", [
        f("labs", "repeat", "Lab", view="table", fields=[
            text("test", "Test", required=True, max_length=120), f("ordered_at", "time", "Ordered"),
            f("resulted_at", "time", "Resulted"), text("result", "Result", max_length=200),
            check("critical", "Critical"), text("ack_by", "Acknowledged by", max_length=60), f("ack_at", "time", "Ack time"),
        ]),
    ]),
    section("imaging", "Imaging", [
        f("imaging", "repeat", "Study", view="table", fields=[
            select("modality", "Modality", [("xr", "X-ray"), ("us", "Ultrasound"), ("ct", "CT"), ("mri", "MRI"),
                                            ("other", "Other")]),
            text("study", "Study", required=True, max_length=120), f("img_ordered_at", "time", "Ordered"),
            f("done_at", "time", "Done"), text("report", "Report / finding", max_length=300), check("img_critical", "Critical"),
            text("img_ack_by", "Acknowledged by", max_length=60),
        ]),
    ]),
    section("ecg", "ECG and point-of-care tests", [
        f("ecgs", "repeat", "ECG", view="table", fields=[
            f("at", "time", "Time", required=True), text("interpretation", "Interpretation", max_length=200),
            check("stemi", "STEMI criteria met (physician)"), text("by", "Read by", max_length=60),
        ]),
        note("poct", "Point-of-care tests (glucose, blood gas, troponin, …)", max_length=2000),
        note("follow_up", "Pending results / follow-up", max_length=1000),
    ]),
])

er_pathway = form("er_fast_track_pathway", "Clinical Pathway / Fast Track", "Form 11 · Fast track ตามแนวทางของโรงพยาบาล", [
    section("pathway", "Pathway", [
        check("path_stroke", "Stroke fast track"), check("path_stemi", "STEMI fast track"), check("path_sepsis", "Sepsis"),
        check("path_trauma", "Major trauma"), text("path_other", "Other pathway", max_length=120),
        f("activated_at", "datetime", "Activated at", required=True),
        text("activated_by", "Activated by", max_length=120),
    ], description="Records times only; targets come from the hospital's own pathway documents."),
    section("stroke", "Stroke", [
        f("last_known_well", "datetime", "Last known well"), integer("nihss", "NIHSS", None, 0, 42),
        f("ct_at", "datetime", "CT / CTA done"), f("ct_read_at", "datetime", "CT read"),
        radio("reperfusion", "Reperfusion", [("ivt", "IV thrombolysis"), ("evt", "Thrombectomy"), ("both", "Both"),
                                             ("none", "None")], option_columns=4),
        f("needle_at", "datetime", "Thrombolysis start"), note("stroke_notes", "Notes", max_length=1000),
    ], visibility=when("path_stroke", "equals", True)),
    section("stemi", "STEMI", [
        f("first_ecg_at", "datetime", "First ECG"), f("cath_activation_at", "datetime", "Cath lab activated"),
        f("lysis_at", "datetime", "Fibrinolysis start"), f("transfer_out_at", "datetime", "Left for PCI"),
        note("stemi_notes", "Notes", max_length=1000),
    ], visibility=when("path_stemi", "equals", True)),
    section("sepsis", "Sepsis", [
        f("time_zero", "datetime", "Time zero"), num("lactate", "Lactate", "mmol/L", 0, 30, decimals=1),
        check("cultures_before_abx", "Cultures before antibiotics"), f("abx_at", "datetime", "Antibiotics given"),
        integer("fluid_ml", "Fluid given", "mL", 0, 20000), f("vaso_at", "datetime", "Vasopressor started"),
    ], visibility=when("path_sepsis", "equals", True)),
    section("trauma", "Major trauma", [
        f("team_at", "datetime", "Trauma team arrived"), f("ct_trauma_at", "datetime", "CT"),
        f("or_at", "datetime", "To OR / intervention"), check("mtp", "Massive transfusion protocol"),
    ], visibility=when("path_trauma", "equals", True)),
])

er_observation = form("er_observation_chart", "ER Observation Chart",
                      "Form 12 · บันทึกการสังเกตอาการ — vital signs from monitors are charted automatically in the case; "
                      "enter here only what the chart lacks", [
    section("obs", "Observation", [
        f("start_at", "datetime", "Observation started", required=True), note("reason", "Reason / goal", required=True, max_length=500),
        note("plan", "Monitoring plan", max_length=1000),
        f("rounds", "repeat", "Reassessment", view="table", fields=[
            f("at", "datetime", "Time", required=True), integer("sbp", "SBP", "mmHg", 0, 300), integer("hr", "HR", "/min", 0, 300),
            integer("rr", "RR", "/min", 0, 80), integer("spo2", "SpO₂", "%", 0, 100), integer("pain", "Pain", "0–10", 0, 10),
            text("progress", "Progress / response", max_length=300), text("by", "By", max_length=60),
        ]),
        f("end_at", "datetime", "Observation ended"),
        calc("duration_days", "Duration", "DAYS(start_at, end_at)", "days", 1),
        radio("result", "Result", [("discharge", "Discharge"), ("admit", "Admit"), ("transfer", "Transfer"),
                                   ("other", "Other")], option_columns=4),
    ]),
])

er_consult = form("er_consultation", "Consultation Record", "Form 13 · การปรึกษาแพทย์เฉพาะทาง", [
    section("consults", "Consultations", [
        f("consults", "repeat", "Consultation", view="cards", fields=[
            text("specialty", "Specialty", required=True, max_length=80), note("question", "Reason / question", max_length=1000),
            f("requested_at", "datetime", "Requested", required=True), text("requested_by", "Requested by", max_length=120),
            f("responded_at", "datetime", "Consultant responded"), text("consultant", "Consultant", max_length=120),
            note("assessment", "Assessment", max_length=2000), note("recommendation", "Recommendation", max_length=2000),
        ]),
    ]),
])

er_referral = form("er_referral_transfer", "Referral & Transfer Record", "Form 14 · ส่งต่อ / ย้ายผู้ป่วย", [
    section("transfer", "Transfer", [
        radio("type", "Type", [("refer_out", "Refer out (other hospital)"), ("internal", "Internal transfer (ward / ICU / OR)")],
              required=True, option_columns=2),
        note("reason", "Reason", required=True, max_length=1000),
        text("destination", "Receiving hospital / unit", required=True, max_length=200),
        text("accepted_by", "Accepted by (name / role)", max_length=120), f("accepted_at", "datetime", "Accepted at"),
        text("refer_no", "Referral number / system", max_length=60),
    ]),
    section("condition", "Condition at transfer", vitals("t_") + [
        integer("t_gcs", "GCS", None, 3, 15), note("condition", "Condition / risks", max_length=1000),
    ], layout={"type": "grid", "columns": 3}),
    section("transport", "Transport and handover", [
        select("team", "Transport team", [("als", "ALS"), ("bls", "BLS"), ("nurse", "Nurse escort"), ("porter", "Porter"),
                                           ("family", "Family")]),
        multi("equipment", "Equipment", [("monitor", "Monitor"), ("ventilator", "Ventilator"), ("pump", "Infusion pump"),
                                         ("o2", "Oxygen"), ("defib", "Defibrillator")], option_columns=5),
        f("left_at", "datetime", "Left ER", required=True), text("handover_to", "Handed over to", max_length=120),
        multi("documents", "Documents sent", [("referral", "Referral letter"), ("imaging", "Imaging"), ("labs", "Lab results"),
                                              ("ecg", "ECG"), ("meds", "Medication list")], option_columns=5),
    ]),
])

er_disposition = form("er_disposition_summary", "ER Discharge / Disposition Summary", "Form 15 · สรุปการจำหน่ายจากห้องฉุกเฉิน", [
    section("dx", "Diagnosis and treatment", [
        text("final_dx_icd10", "Principal diagnosis – ICD-10", required=True, indexed=True, max_length=20),
        text("final_dx", "Principal diagnosis", required=True, max_length=300),
        note("other_dx", "Other diagnoses (ICD-10)", max_length=1000),
        note("treatment_summary", "Treatment summary", required=True),
    ]),
    section("disposition", "Disposition · การจำหน่าย", [
        radio("disposition", "Disposition", [("discharge", "Discharge home"), ("admit", "Admit"), ("transfer", "Transfer"),
                                             ("refer_out", "Refer out"), ("ama", "Against medical advice"),
                                             ("death", "Death"), ("left", "Left without being seen")],
              required=True, indexed=True, option_columns=4),
        f("decision_at", "datetime", "Disposition decided", required=True),
        f("left_er_at", "datetime", "Left ER", required=True, indexed=True),
        text("admit_ward", "Admitting ward / unit", max_length=120, visibility=when("disposition", "equals", "admit")),
        f("death_at", "datetime", "Time of death", visibility=when("disposition", "equals", "death")),
        note("ama_note", "AMA discussion and signature on the hospital form", max_length=1000,
             visibility=when("disposition", "equals", "ama")),
    ]),
    section("home", "Discharge instructions", [
        note("discharge_meds", "Discharge medication", max_length=2000), note("instructions", "Patient instructions"),
        note("follow_up", "Follow-up appointment", max_length=500),
    ], visibility=when("disposition", "equals", "discharge")),
    section("sign", "Physician", [text("physician", "Physician", required=True, max_length=120), SIGN()]),
])

er_handover = form("er_nursing_handover", "Emergency Nursing Handover (SBAR)", "Form 16 · ส่งเวร / ส่งต่อทางการพยาบาล", [
    section("sbar", "SBAR", [
        f("at", "datetime", "Handover time", required=True),
        note("s", "S – Situation", required=True, max_length=1000), note("b", "B – Background", max_length=2000),
        note("a", "A – Assessment", max_length=2000), note("r", "R – Recommendation", max_length=1000),
        note("pending", "Pending investigations / results", max_length=1000),
        note("meds_due", "Medication due / running infusions", max_length=1000),
        multi("risks", "Risks", [("fall", "Fall"), ("aspiration", "Aspiration"), ("bleeding", "Bleeding"),
                                 ("deterioration", "Deterioration"), ("self_harm", "Self-harm"), ("violence", "Violence"),
                                 ("allergy", "Allergy"), ("infection", "Isolation")], option_columns=4),
        text("handed_by", "Handed over by", required=True, max_length=120),
        text("received_by", "Received by", required=True, max_length=120),
    ]),
])

er_quality = form("er_quality_incident", "ER Quality & Incident Record", "Form 17 · บันทึกอุบัติการณ์และความเสี่ยง", [
    section("event", "Event", [
        f("occurred_at", "datetime", "Occurred at", required=True),
        radio("type", "Type", [("incident", "Incident"), ("adverse", "Adverse event"), ("near_miss", "Near miss"),
                               ("delay", "Clinical delay"), ("risk", "Risk event")], required=True, indexed=True,
              option_columns=5),
        text("category", "Category (hospital risk taxonomy)", max_length=120),
        note("description", "What happened", required=True),
        select("severity", "Severity level", [(x, x) for x in "ABCDEFGHI"] + [(str(n), str(n)) for n in range(1, 6)],
               description="Clinical A–I / non-clinical 1–5 as used in the hospital's risk system (confirm with the hospital)."),
        note("immediate_action", "Immediate action", max_length=1000),
        note("corrective_action", "Corrective / preventive action", max_length=2000),
        text("reported_by", "Reported by", required=True, max_length=120),
        check("sent_to_risk_system", "Entered in the hospital risk reporting system"),
    ]),
])

CORE = [er_registration, er_triage, er_physician, er_nursing, er_disposition, er_handover]
CONDITIONAL = [er_trauma, er_resus, er_procedure, er_investigations, er_pathway, er_observation, er_consult,
               er_referral, er_quality]
FORMS = CORE + CONDITIONAL
BY_ID = {d["form_id"]: d for d in FORMS}


def workflow(id, name, description, entries):
    return {
        "format": "flora-workflow/1", "id": id, "name": name, "description": description,
        "anesthesia_record": {"enabled": True, "sections": ["caseInfo", "outcome"],
                              "optional_sections": ["line", "comorbid", "pain"]},
        "forms": [{"form_id": fid, "version": 1, "title": BY_ID[fid]["title"], "phase": phase, "required": required}
                  for fid, phase, required in entries],
        "packet": [{"kind": "anesthesia_report", "mode": "standard"}] + [{"kind": "form", "form_id": fid} for fid, _, _ in entries],
        "bundled_forms": {fid: {"version": 1, "definition": BY_ID[fid]} for fid, _, _ in entries},
    }


WORKFLOWS = [
    workflow("er_emergency", "ER – Emergency (EDIS)",
             "Emergency department: registration, MOPH ED Triage, physician and nursing assessment, trauma / resuscitation / "
             "procedures / investigations / fast-track pathways when needed, observation, consultation, transfer, disposition, "
             "SBAR handover and incident record. Vital signs and medications use the case chart.", [
                 ("er_registration", "preop", True), ("er_triage", "preop", True),
                 ("er_physician_assessment", "intraop", True), ("er_nursing_assessment", "intraop", True),
                 ("er_trauma_assessment", "intraop", False), ("er_resuscitation_record", "intraop", False),
                 ("er_procedure_record", "intraop", False), ("er_investigations", "intraop", False),
                 ("er_fast_track_pathway", "intraop", False), ("er_observation_chart", "intraop", False),
                 ("er_consultation", "intraop", False), ("er_referral_transfer", "postop", False),
                 ("er_disposition_summary", "postop", True), ("er_nursing_handover", "postop", False),
                 ("er_quality_incident", "postop", False),
             ]),
    workflow("er_fast_track", "ER – Fast Track (minor)",
             "Non-urgent / semi-urgent patients in the fast-track area: registration, triage, physician assessment, "
             "investigations and disposition.", [
                 ("er_registration", "preop", True), ("er_triage", "preop", True),
                 ("er_physician_assessment", "intraop", True), ("er_investigations", "intraop", False),
                 ("er_procedure_record", "intraop", False), ("er_disposition_summary", "postop", True),
             ]),
]


TYPE_TH = {"text": "Text", "textarea": "Long text", "number": "Number", "decimal": "Decimal", "integer": "Integer",
           "date": "Date", "datetime": "Date-time", "time": "Time", "select": "Single choice", "radio": "Single choice",
           "multiselect": "Multiple choice", "checkbox": "Yes/No", "signature": "Signature", "calculated": "Calculated",
           "repeat": "Repeating table", "matrix": "Matrix", "group": "Group"}


def _condition(condition):
    if "and" in condition or "or" in condition:
        key = "and" if "and" in condition else "or"
        return f" {key.upper()} ".join(_condition(item) for item in condition[key])
    value = condition.get("value")
    return f"{condition['field']} {condition['operator']} {json.dumps(value, ensure_ascii=False) if value is not None else ''}".strip()


def _rule(field):
    parts = []
    if field.get("min") is not None or field.get("max") is not None:
        parts.append(f"range {field.get('min', '')}–{field.get('max', '')}")
    if field.get("max_length"):
        parts.append(f"≤ {field['max_length']} chars")
    if field.get("options"):
        parts.append("options: " + ", ".join(f"`{o['value']}` {o['label']}" for o in field["options"]))
    if field.get("formula"):
        parts.append(f"formula: `{field['formula']}`")
    if field.get("visibility"):
        parts.append(f"shown when {_condition(field['visibility']['when'])}")
    if field.get("indexed"):
        parts.append("indexed (searchable)")
    if field.get("description"):
        parts.append(field["description"])
    return "; ".join(parts).replace("|", "\\|")


def specification() -> str:
    lines = ["# EDIS – Detailed Form Specifications", "",
             "สร้างอัตโนมัติจากนิยามฟอร์มจริง (`build_er_workflows.py`) — ตรงกับฟอร์มใน Form Studio ทุก field.",
             "Data type ตาม Form Studio (`flora.form/1`); ค่าเวลาเก็บเป็น ISO 8601; ทุก record มี created/updated by/at",
             "และ revision history อัตโนมัติ (ไม่ทับข้อมูลเดิม).", ""]
    for definition in FORMS:
        lines += [f"## {definition['title']} (`{definition['form_id']}`)", "", definition.get("description", ""), ""]
        for rule in definition.get("rules") or []:
            lines.append(f"- **Rule** `{rule['assert']}` → {rule['message']}")
        lines += ["", "| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |",
                  "|---|---|---|---|---|---|"]
        for sec in definition["sections"]:
            title = sec["title"] + (f" *(shown when {_condition(sec['visibility']['when'])})*" if sec.get("visibility") else "")
            for field in sec["fields"]:
                lines.append(f"| {title} | `{field['id']}` | {field['label']} | {TYPE_TH.get(field['type'], field['type'])} | "
                             f"{'✓' if field.get('required') else ''} | {_rule(field)} |")
                for child in field.get("fields") or []:
                    lines.append(f"| {title} | `{field['id']}[].{child['id']}` | {child['label']} | "
                                 f"{TYPE_TH.get(child['type'], child['type'])} | {'✓' if child.get('required') else ''} | "
                                 f"{_rule(child)} |")
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    sys.path.insert(0, str(ROOT / "services/flora-api"))
    from app.formdev.definition import validate_definition

    failed = False
    for definition in FORMS:
        for issue in validate_definition(definition):
            failed = True
            print(f"{definition['form_id']}: {issue}")
    if failed:
        return 1
    for wf in WORKFLOWS:
        path = HERE / f"{wf['id']}.workflow.json"
        path.write_text(json.dumps(wf, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)} ({len(wf['forms'])} forms)")
    spec = HERE / "EDIS-Form-Specifications.md"
    spec.write_text(specification(), encoding="utf-8")
    print(f"wrote {spec.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
