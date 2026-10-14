# EDIS – Detailed Form Specifications

สร้างอัตโนมัติจากนิยามฟอร์มจริง (`build_er_workflows.py`) — ตรงกับฟอร์มใน Form Studio ทุก field.
Data type ตาม Form Studio (`flora.form/1`); ค่าเวลาเก็บเป็น ISO 8601; ทุก record มี created/updated by/at
และ revision history อัตโนมัติ (ไม่ทับข้อมูลเดิม).

## ER Registration (`er_registration`)

Form 01 · ลงทะเบียนผู้ป่วยห้องฉุกเฉิน


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Visit · การมารับบริการ | `hn` | HN | Text | ✓ | ≤ 20 chars; indexed (searchable) |
| Visit · การมารับบริการ | `vn` | VN / AN | Text |  | ≤ 30 chars; indexed (searchable) |
| Visit · การมารับบริการ | `encounter_id` | Encounter ID (HIS) | Text |  | ≤ 60 chars |
| Visit · การมารับบริการ | `arrival_at` | Arrived at ER | Date-time | ✓ | indexed (searchable) |
| Visit · การมารับบริการ | `arrival_mode` | Arrival | Single choice | ✓ | options: `walk_in` Walk-in, `ems` EMS / 1669, `referral` Referral from another hospital, `internal` Internal transfer (OPD / ward), `police` Brought by police / rescue, `other` Other; indexed (searchable) |
| Visit · การมารับบริการ | `category` | Patient category | Single choice |  | options: `trauma` Trauma (บาดเจ็บ), `non_trauma` Non-trauma (เจ็บป่วย); indexed (searchable); Trauma / non-trauma is separate from the triage level and from the treatment area. |
| EMS · การนำส่ง *(shown when arrival_mode equals "ems")* | `ems_operation_no` | EMS operation number | Text |  | ≤ 40 chars |
| EMS · การนำส่ง *(shown when arrival_mode equals "ems")* | `ems_team_level` | Team level | Single choice |  | options: `als` ALS, `ils` ILS, `bls` BLS, `fr` FR, `other` Other |
| EMS · การนำส่ง *(shown when arrival_mode equals "ems")* | `ems_unit` | Unit / agency | Text |  | ≤ 120 chars |
| EMS · การนำส่ง *(shown when arrival_mode equals "ems")* | `ems_dispatch_at` | Call / dispatch time | Date-time |  |  |
| EMS · การนำส่ง *(shown when arrival_mode equals "ems")* | `ems_scene_at` | At scene | Date-time |  |  |
| EMS · การนำส่ง *(shown when arrival_mode equals "ems")* | `ems_prehospital` | Pre-hospital care and handover notes | Long text |  | ≤ 2000 chars |
| Referral in · รับส่งต่อ *(shown when arrival_mode equals "referral")* | `referring_hospital` | Referring hospital | Text |  | ≤ 200 chars |
| Referral in · รับส่งต่อ *(shown when arrival_mode equals "referral")* | `referral_no` | Referral document number | Text |  | ≤ 60 chars |
| Referral in · รับส่งต่อ *(shown when arrival_mode equals "referral")* | `referral_reason` | Reason for referral | Long text |  | ≤ 1000 chars |
| Coverage · สิทธิการรักษา | `coverage` | Coverage (สิทธิ) | Single choice |  | options: `uc` UC (บัตรทอง), `sss` Social security (ประกันสังคม), `csmbs` Civil servant (ข้าราชการ), `lgo` Local government (อปท.), `self_pay` Self-pay, `insurance` Private insurance, `other` Other; indexed (searchable) |
| Coverage · สิทธิการรักษา | `ucep_assessed` | Assessed for UCEP (เจ็บป่วยฉุกเฉินวิกฤต) — criteria per สพฉ./สปสช. | Yes/No |  |  |
| Coverage · สิทธิการรักษา | `road_accident` | Road accident (พ.ร.บ. ผู้ประสบภัยจากรถ) | Yes/No |  |  |
| Coverage · สิทธิการรักษา | `contact_name` | Relative / contact | Text |  | ≤ 120 chars |
| Coverage · สิทธิการรักษา | `contact_phone` | Contact phone | Text |  | ≤ 30 chars |
| Coverage · สิทธิการรักษา | `registered_by` | Registered by | Text | ✓ | ≤ 120 chars |

## Emergency Triage Record (`er_triage`)

Form 02 · คัดแยกผู้ป่วยฉุกเฉิน (MOPH ED Triage 5 ระดับ)

- **Rule** `ISBLANK(level_num) OR ISBLANK(suggested_level) OR level_num = suggested_level OR NOT ISBLANK(override_reason)` → Give a reason when the level differs from the suggested level

| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Arrival · การมาถึง | `arrival_at` | Arrived at ER | Date-time | ✓ |  |
| Arrival · การมาถึง | `arrival_mode` | Arrival | Single choice |  | options: `walk_in` Walk-in, `ems` EMS / 1669, `referral` Referral from another hospital, `internal` Internal transfer (OPD / ward), `police` Brought by police / rescue, `other` Other |
| Arrival · การมาถึง | `category` | Patient category | Single choice |  | options: `trauma` Trauma (บาดเจ็บ), `non_trauma` Non-trauma (เจ็บป่วย) |
| Arrival · การมาถึง | `chief_complaint` | Chief complaint (อาการสำคัญ) | Long text | ✓ | ≤ 500 chars |
| Arrival · การมาถึง | `duration_value` | Duration | Integer |  | range 0–100000 |
| Arrival · การมาถึง | `duration_unit` | Unit | Single choice |  | options: `min` minutes, `h` hours, `d` days, `w` weeks |
| Vital signs · สัญญาณชีพ | `sbp` | SBP | Integer |  | range 0–300 |
| Vital signs · สัญญาณชีพ | `dbp` | DBP | Integer |  | range 0–200 |
| Vital signs · สัญญาณชีพ | `hr` | HR | Integer |  | range 0–300 |
| Vital signs · สัญญาณชีพ | `rr` | RR | Integer |  | range 0–80 |
| Vital signs · สัญญาณชีพ | `temp` | Temp | Decimal |  | range 25–45 |
| Vital signs · สัญญาณชีพ | `spo2` | SpO₂ | Integer |  | range 0–100 |
| Vital signs · สัญญาณชีพ | `o2` | O₂ support | Single choice |  | options: `room_air` Room air, `cannula` Cannula, `mask` Mask, `nrb` Non-rebreather, `hfnc` HFNC, `niv` NIV, `ett` ETT / BVM |
| Vital signs · สัญญาณชีพ | `dtx` | Capillary glucose | Integer |  | range 0–2000 |
| Vital signs · สัญญาณชีพ | `pain` | Pain score | Integer |  | range 0–10 |
| Vital signs · สัญญาณชีพ | `avpu` | Consciousness (AVPU) | Single choice |  | options: `A` A – Alert, `V` V – Voice, `P` P – Pain, `U` U – Unresponsive |
| Vital signs · สัญญาณชีพ | `gcs_e` | GCS E | Single choice |  | options: `4` 4 – Spontaneous, `3` 3 – To voice, `2` 2 – To pain, `1` 1 – None |
| Vital signs · สัญญาณชีพ | `gcs_v` | GCS V | Single choice |  | options: `5` 5 – Oriented, `4` 4 – Confused, `3` 3 – Words, `2` 2 – Sounds, `1` 1 – None, `t` T – Intubated |
| Vital signs · สัญญาณชีพ | `gcs_m` | GCS M | Single choice |  | options: `6` 6 – Obeys, `5` 5 – Localises, `4` 4 – Withdraws, `3` 3 – Abnormal flexion, `2` 2 – Extension, `1` 1 – None |
| Vital signs · สัญญาณชีพ | `gcs` | GCS | Calculated |  | formula: `IF(gcs_e='4', 4, IF(gcs_e='3', 3, IF(gcs_e='2', 2, IF(gcs_e='1', 1, NULL)))) + IF(gcs_v='5', 5, IF(gcs_v='4', 4, IF(gcs_v='3', 3, IF(gcs_v='2', 2, IF(gcs_v='1', 1, IF(gcs_v='t', 1, NULL)))))) + IF(gcs_m='6', 6, IF(gcs_m='5', 5, IF(gcs_m='4', 4, IF(gcs_m='3', 3, IF(gcs_m='2', 2, IF(gcs_m='1', 1, NULL))))))` |
| Decision points · การตัดสินระดับ | `dp_lifesaving` | Needs an immediate life-saving intervention | Yes/No |  |  |
| Decision points · การตัดสินระดับ | `dp_high_risk` | High-risk situation | Yes/No |  |  |
| Decision points · การตัดสินระดับ | `dp_altered` | New confusion, lethargy or disorientation | Yes/No |  |  |
| Decision points · การตัดสินระดับ | `dp_severe_pain` | Severe pain or distress | Yes/No |  |  |
| Decision points · การตัดสินระดับ | `resources` | Resources expected | Single choice |  | options: `0` None, `1` One, `2plus` Two or more |
| Decision points · การตัดสินระดับ | `dp_danger_vitals` | Vital signs in the hospital's danger zone | Yes/No |  |  |
| Decision points · การตัดสินระดับ | `suggested_level` | Suggested level | Calculated |  | formula: `IF(dp_lifesaving, 1, IF(dp_high_risk OR dp_altered OR dp_severe_pain, 2, IF(resources = '2plus', IF(dp_danger_vitals, 2, 3), IF(resources = '1', 4, IF(resources = '0', 5, NULL)))))`; Follows the published decision order (life-saving → high risk → resources). Danger-zone limits and any local criteria are set by the hospital. |
| Triage level · ระดับความฉุกเฉิน | `triage_level` | Triage level | Single choice | ✓ | options: `1` 1 · Resuscitation · แดง, `2` 2 · Emergency · ชมพู, `3` 3 · Urgency · เหลือง, `4` 4 · Semi-urgency · เขียว, `5` 5 · Non-urgency · ขาว; indexed (searchable) |
| Triage level · ระดับความฉุกเฉิน | `level_num` | Level (number) | Calculated |  | formula: `IF(triage_level='1', 1, IF(triage_level='2', 2, IF(triage_level='3', 3, IF(triage_level='4', 4, IF(triage_level='5', 5, NULL)))))` |
| Triage level · ระดับความฉุกเฉิน | `triage_reason` | Reason for the level (เหตุผลประกอบการคัดแยก) | Long text |  | ≤ 1000 chars |
| Triage level · ระดับความฉุกเฉิน | `override_reason` | Why the level differs from the suggestion | Long text |  | ≤ 500 chars |
| Triage level · ระดับความฉุกเฉิน | `assigned_zone` | Assigned area (zone) | Single choice |  | options: `resuscitation` Resuscitation (Red), `trauma` Trauma, `acute_pink` Acute (Pink), `urgent_yellow` Urgent (Yellow), `fast_track` Fast track, `observation` Observation, `isolation` Isolation, `pediatric` Pediatric, `psychiatric` Psychiatric, `procedure` Procedure; indexed (searchable) |
| Triage level · ระดับความฉุกเฉิน | `triaged_at` | Triage time | Date-time | ✓ | indexed (searchable) |
| Triage level · ระดับความฉุกเฉิน | `triage_nurse` | Triage nurse | Text | ✓ | ≤ 120 chars |
| Re-triage · คัดแยกซ้ำ | `retriage` | Re-triage | Repeating table |  |  |
| Re-triage · คัดแยกซ้ำ | `retriage[].at` | Time | Date-time | ✓ |  |
| Re-triage · คัดแยกซ้ำ | `retriage[].level` | Level | Single choice | ✓ | options: `1` 1 · Resuscitation · แดง, `2` 2 · Emergency · ชมพู, `3` 3 · Urgency · เหลือง, `4` 4 · Semi-urgency · เขียว, `5` 5 · Non-urgency · ขาว |
| Re-triage · คัดแยกซ้ำ | `retriage[].zone` | Area | Single choice |  | options: `resuscitation` Resuscitation (Red), `trauma` Trauma, `acute_pink` Acute (Pink), `urgent_yellow` Urgent (Yellow), `fast_track` Fast track, `observation` Observation, `isolation` Isolation, `pediatric` Pediatric, `psychiatric` Psychiatric, `procedure` Procedure |
| Re-triage · คัดแยกซ้ำ | `retriage[].reason` | Reason | Text |  | ≤ 200 chars |
| Re-triage · คัดแยกซ้ำ | `retriage[].by` | By | Text |  | ≤ 60 chars |

## Emergency Physician Assessment (`er_physician_assessment`)

Form 03 · บันทึกการตรวจของแพทย์


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Seen by physician | `seen_at` | Physician first saw patient | Date-time | ✓ | indexed (searchable) |
| Seen by physician | `physician` | Physician | Text | ✓ | ≤ 120 chars |
| History · ประวัติ | `hpi` | History of present illness | Long text | ✓ | ≤ 4000 chars |
| History · ประวัติ | `pmh` | Past medical / surgical history | Long text |  | ≤ 4000 chars |
| History · ประวัติ | `medications` | Current medications | Long text |  | ≤ 4000 chars |
| History · ประวัติ | `allergies` | Allergies | Text |  | ≤ 500 chars |
| History · ประวัติ | `social` | Social / family history | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_general` | General appearance | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_heent` | HEENT | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_cvs` | Cardiovascular | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_resp` | Respiratory | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_abd` | Abdomen | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_neuro` | Neurological | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_ext` | Extremities / skin | Long text |  | ≤ 1000 chars |
| Physical examination · ตรวจร่างกาย | `pe_other` | Other findings | Long text |  | ≤ 1000 chars |
| Assessment and plan | `ddx` | Differential diagnosis | Long text |  | ≤ 1000 chars |
| Assessment and plan | `dx_icd10` | Working diagnosis – ICD-10 | Text |  | ≤ 20 chars; indexed (searchable) |
| Assessment and plan | `dx_text` | Working diagnosis | Text | ✓ | ≤ 300 chars |
| Assessment and plan | `plan` | Treatment plan / initial orders | Long text | ✓ | ≤ 4000 chars |
| Assessment and plan | `signature` | Signature | Signature |  |  |

## ER Nursing Assessment (`er_nursing_assessment`)

Form 04 · ประเมินและบันทึกทางการพยาบาล


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Initial nursing assessment | `assessed_at` | Assessed at | Date-time | ✓ |  |
| Initial nursing assessment | `airway` | Airway | Single choice |  | options: `patent` Patent, `at_risk` At risk, `obstructed` Obstructed |
| Initial nursing assessment | `breathing` | Breathing | Single choice |  | options: `normal` Normal, `distress` Distress, `assisted` Assisted |
| Initial nursing assessment | `circulation` | Circulation | Single choice |  | options: `normal` Normal, `impaired` Impaired, `shock` Shock signs |
| Initial nursing assessment | `avpu` | Consciousness | Single choice |  | options: `A` A – Alert, `V` V – Voice, `P` P – Pain, `U` U – Unresponsive |
| Initial nursing assessment | `pain` | Pain score | Integer |  | range 0–10 |
| Initial nursing assessment | `fall_risk` | Fall risk | Single choice |  | options: `low` Low, `moderate` Moderate, `high` High |
| Initial nursing assessment | `risks` | Other risks | Multiple choice |  | options: `aspiration` Aspiration, `pressure` Pressure injury, `violence` Violence / aggression, `self_harm` Self-harm, `infection` Infection control precautions, `bleeding` Bleeding |
| Initial nursing assessment | `allergies` | Allergies | Text |  | ≤ 500 chars |
| Nursing diagnoses and interventions | `diagnoses` | Nursing diagnosis | Repeating table |  |  |
| Nursing diagnoses and interventions | `diagnoses[].diagnosis` | Nursing diagnosis | Text | ✓ | ≤ 300 chars |
| Nursing diagnoses and interventions | `diagnoses[].goal` | Goal | Long text |  | ≤ 500 chars |
| Nursing diagnoses and interventions | `diagnoses[].interventions` | Interventions | Long text |  | ≤ 1000 chars |
| Nursing diagnoses and interventions | `diagnoses[].evaluation` | Evaluation | Long text |  | ≤ 500 chars |
| Nursing progress notes | `notes` | Note | Repeating table |  |  |
| Nursing progress notes | `notes[].at` | Time | Date-time | ✓ |  |
| Nursing progress notes | `notes[].note` | Progress / reassessment | Long text |  | ≤ 2000 chars |
| Nursing progress notes | `notes[].by` | Nurse | Text |  | ≤ 60 chars |

## ER Discharge / Disposition Summary (`er_disposition_summary`)

Form 15 · สรุปการจำหน่ายจากห้องฉุกเฉิน


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Diagnosis and treatment | `final_dx_icd10` | Principal diagnosis – ICD-10 | Text | ✓ | ≤ 20 chars; indexed (searchable) |
| Diagnosis and treatment | `final_dx` | Principal diagnosis | Text | ✓ | ≤ 300 chars |
| Diagnosis and treatment | `other_dx` | Other diagnoses (ICD-10) | Long text |  | ≤ 1000 chars |
| Diagnosis and treatment | `treatment_summary` | Treatment summary | Long text | ✓ | ≤ 4000 chars |
| Disposition · การจำหน่าย | `disposition` | Disposition | Single choice | ✓ | options: `discharge` Discharge home, `admit` Admit, `transfer` Transfer, `refer_out` Refer out, `ama` Against medical advice, `death` Death, `left` Left without being seen; indexed (searchable) |
| Disposition · การจำหน่าย | `decision_at` | Disposition decided | Date-time | ✓ |  |
| Disposition · การจำหน่าย | `left_er_at` | Left ER | Date-time | ✓ | indexed (searchable) |
| Disposition · การจำหน่าย | `admit_ward` | Admitting ward / unit | Text |  | ≤ 120 chars; shown when disposition equals "admit" |
| Disposition · การจำหน่าย | `death_at` | Time of death | Date-time |  | shown when disposition equals "death" |
| Disposition · การจำหน่าย | `ama_note` | AMA discussion and signature on the hospital form | Long text |  | ≤ 1000 chars; shown when disposition equals "ama" |
| Discharge instructions *(shown when disposition equals "discharge")* | `discharge_meds` | Discharge medication | Long text |  | ≤ 2000 chars |
| Discharge instructions *(shown when disposition equals "discharge")* | `instructions` | Patient instructions | Long text |  | ≤ 4000 chars |
| Discharge instructions *(shown when disposition equals "discharge")* | `follow_up` | Follow-up appointment | Long text |  | ≤ 500 chars |
| Physician | `physician` | Physician | Text | ✓ | ≤ 120 chars |
| Physician | `signature` | Signature | Signature |  |  |

## Emergency Nursing Handover (SBAR) (`er_nursing_handover`)

Form 16 · ส่งเวร / ส่งต่อทางการพยาบาล


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| SBAR | `at` | Handover time | Date-time | ✓ |  |
| SBAR | `s` | S – Situation | Long text | ✓ | ≤ 1000 chars |
| SBAR | `b` | B – Background | Long text |  | ≤ 2000 chars |
| SBAR | `a` | A – Assessment | Long text |  | ≤ 2000 chars |
| SBAR | `r` | R – Recommendation | Long text |  | ≤ 1000 chars |
| SBAR | `pending` | Pending investigations / results | Long text |  | ≤ 1000 chars |
| SBAR | `meds_due` | Medication due / running infusions | Long text |  | ≤ 1000 chars |
| SBAR | `risks` | Risks | Multiple choice |  | options: `fall` Fall, `aspiration` Aspiration, `bleeding` Bleeding, `deterioration` Deterioration, `self_harm` Self-harm, `violence` Violence, `allergy` Allergy, `infection` Isolation |
| SBAR | `handed_by` | Handed over by | Text | ✓ | ≤ 120 chars |
| SBAR | `received_by` | Received by | Text | ✓ | ≤ 120 chars |

## Trauma Assessment (`er_trauma_assessment`)

Form 05 · ประเมินผู้บาดเจ็บ (Primary / Secondary survey)


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Mechanism of injury | `injured_at` | Time of injury | Date-time |  |  |
| Mechanism of injury | `mechanism` | Mechanism | Single choice |  | options: `rta_motorcycle` Road traffic – motorcycle, `rta_car` Road traffic – car, `rta_pedestrian` Road traffic – pedestrian, `fall_height` Fall from height, `fall_level` Fall – same level, `assault` Assault, `stab` Stab, `gunshot` Gunshot, `burn` Burn, `crush` Crush, `other` Other; indexed (searchable) |
| Mechanism of injury | `protection` | Protection | Multiple choice |  | options: `helmet` Helmet, `seatbelt` Seat belt, `airbag` Airbag, `none` None |
| Mechanism of injury | `alcohol` | Alcohol / substance suspected | Yes/No |  |  |
| Mechanism of injury | `mechanism_detail` | Details | Long text |  | ≤ 1000 chars |
| Mechanism of injury | `trauma_team` | Trauma team activated | Yes/No |  |  |
| Mechanism of injury | `trauma_team_at` | Activation time | Date-time |  | shown when trauma_team equals true |
| Primary survey (ABCDE) | `a_airway` | A – Airway and C-spine | Long text |  | ≤ 1000 chars |
| Primary survey (ABCDE) | `b_breathing` | B – Breathing | Long text |  | ≤ 1000 chars |
| Primary survey (ABCDE) | `c_circulation` | C – Circulation / haemorrhage control | Long text |  | ≤ 1000 chars |
| Primary survey (ABCDE) | `d_disability` | D – Disability (GCS, pupils) | Long text |  | ≤ 1000 chars |
| Primary survey (ABCDE) | `e_exposure` | E – Exposure / temperature | Long text |  | ≤ 1000 chars |
| Primary survey (ABCDE) | `adjuncts` | Adjuncts | Multiple choice |  | options: `efast` eFAST, `cxr` Chest X-ray, `pelvis_xr` Pelvis X-ray, `ecg` ECG, `abg` ABG, `foley` Urinary catheter, `ngt` NG tube |
| Revised Trauma Score | `rts_gcs` | GCS (coded) | Single choice |  | options: `4` 4 · GCS 13–15, `3` 3 · 9–12, `2` 2 · 6–8, `1` 1 · 4–5, `0` 0 · 3 |
| Revised Trauma Score | `rts_sbp` | SBP (coded) | Single choice |  | options: `4` 4 · SBP > 89, `3` 3 · 76–89, `2` 2 · 50–75, `1` 1 · 1–49, `0` 0 · 0 |
| Revised Trauma Score | `rts_rr` | RR (coded) | Single choice |  | options: `4` 4 · RR 10–29, `3` 3 · > 29, `2` 2 · 6–9, `1` 1 · 1–5, `0` 0 · 0 |
| Revised Trauma Score | `rts` | RTS | Calculated |  | formula: `0.9368 * (IF(rts_gcs='4', 4, IF(rts_gcs='3', 3, IF(rts_gcs='2', 2, IF(rts_gcs='1', 1, IF(rts_gcs='0', 0, NULL)))))) + 0.7326 * (IF(rts_sbp='4', 4, IF(rts_sbp='3', 3, IF(rts_sbp='2', 2, IF(rts_sbp='1', 1, IF(rts_sbp='0', 0, NULL)))))) + 0.2908 * (IF(rts_rr='4', 4, IF(rts_rr='3', 3, IF(rts_rr='2', 2, IF(rts_rr='1', 1, IF(rts_rr='0', 0, NULL))))))` |
| Revised Trauma Score | `iss` | Injury Severity Score (if calculated) | Integer |  | range 0–75 |
| Secondary survey | `secondary` | Head-to-toe findings | Long text |  | ≤ 4000 chars |
| Secondary survey | `injuries` | Injury | Repeating table |  |  |
| Secondary survey | `injuries[].region` | Region | Single choice |  | options: `head` Head, `face` Face, `neck` Neck, `chest` Chest, `abdomen` Abdomen, `pelvis` Pelvis, `spine` Spine, `upper` Upper limb, `lower` Lower limb, `skin` Skin / burn |
| Secondary survey | `injuries[].injury` | Injury | Text |  | ≤ 200 chars |
| Secondary survey | `injuries[].plan` | Plan | Text |  | ≤ 200 chars |
| Reassessment | `reassessments` | Reassessment | Repeating table |  |  |
| Reassessment | `reassessments[].at` | Time | Date-time | ✓ |  |
| Reassessment | `reassessments[].gcs` | GCS | Integer |  | range 3–15 |
| Reassessment | `reassessments[].sbp` | SBP | Integer |  | range 0–300 |
| Reassessment | `reassessments[].hr` | HR | Integer |  | range 0–300 |
| Reassessment | `reassessments[].change` | Change / action | Text |  | ≤ 200 chars |
| Reassessment | `reassessments[].by` | By | Text |  | ≤ 60 chars |

## Resuscitation Record (`er_resuscitation_record`)

Form 06 · บันทึกการช่วยฟื้นคืนชีพ


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Arrest | `arrest_at` | Arrest / collapse time | Date-time | ✓ |  |
| Arrest | `location` | Location | Single choice |  | options: `prehospital` Pre-hospital, `er` In ER |
| Arrest | `witnessed` | Witnessed | Yes/No |  |  |
| Arrest | `bystander_cpr` | Bystander CPR | Yes/No |  |  |
| Arrest | `initial_rhythm` | Initial rhythm | Single choice |  | options: `vf` VF, `pvt` Pulseless VT, `pea` PEA, `asystole` Asystole, `unknown` Unknown; indexed (searchable) |
| Arrest | `cpr_start_at` | CPR started (ER) | Date-time |  |  |
| Arrest | `team_leader` | Team leader | Text |  | ≤ 120 chars |
| CPR timeline | `events` | Event | Repeating table |  |  |
| CPR timeline | `events[].at` | Time | Time | ✓ |  |
| CPR timeline | `events[].event` | Event | Single choice |  | options: `cpr` CPR cycle, `rhythm` Rhythm check, `shock` Defibrillation, `drug` Drug, `airway` Airway, `rosc` ROSC, `other` Other |
| CPR timeline | `events[].rhythm` | Rhythm | Single choice |  | options: `vf` VF, `pvt` pVT, `pea` PEA, `asystole` Asystole, `organised` Organised |
| CPR timeline | `events[].joules` | Joules | Integer |  | range 0–400 |
| CPR timeline | `events[].drug` | Drug / dose / route | Text |  | ≤ 120 chars |
| CPR timeline | `events[].note` | Note | Text |  | ≤ 200 chars |
| Airway | `airway_device` | Device | Single choice |  | options: `bvm` BVM, `sga` Supraglottic, `ett` Endotracheal tube |
| Airway | `ett_size` | ETT size | Decimal |  | range 2–10 |
| Airway | `ett_depth` | Depth at lip | Integer |  | range 5–35 |
| Airway | `airway_at` | Placed at | Date-time |  |  |
| Airway | `etco2_confirmed` | Placement confirmed with EtCO₂ | Yes/No |  |  |
| Outcome | `outcome` | Outcome | Single choice | ✓ | options: `rosc` ROSC, `ongoing` Ongoing at transfer, `terminated` Resuscitation stopped; indexed (searchable) |
| Outcome | `rosc_at` | ROSC time | Date-time |  | shown when outcome equals "rosc" |
| Outcome | `terminated_at` | Stopped at | Date-time |  | shown when outcome equals "terminated" |
| Outcome | `post_rosc` | Post-ROSC care / disposition | Long text |  | ≤ 2000 chars |
| Outcome | `leader_sign` | Team leader signature | Signature |  |  |

## Emergency Procedure Record (`er_procedure_record`)

Form 09 · บันทึกหัตถการ


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Procedures | `procedures` | Procedure | Repeating table |  |  |
| Procedures | `procedures[].procedure` | Procedure | Single choice | ✓ | options: `intubation` Endotracheal intubation, `cvc` Central line, `art` Arterial line, `chest_drain` Chest drain, `suture` Wound suturing, `splint` Splint / cast, `reduction` Reduction, `i_and_d` Incision and drainage, `lp` Lumbar puncture, `ngt` NG tube, `foley` Urinary catheter, `cardioversion` Cardioversion / pacing, `other` Other |
| Procedures | `procedures[].icd9cm` | ICD-9-CM | Text |  | ≤ 12 chars |
| Procedures | `procedures[].at` | Time | Date-time | ✓ |  |
| Procedures | `procedures[].site` | Site / side | Text |  | ≤ 120 chars |
| Procedures | `procedures[].operator` | Operator | Text | ✓ | ≤ 120 chars |
| Procedures | `procedures[].assistant` | Assistant | Text |  | ≤ 120 chars |
| Procedures | `procedures[].consent` | Consent obtained (per hospital consent policy) | Yes/No |  |  |
| Procedures | `procedures[].details` | Technique / findings | Long text |  | ≤ 2000 chars |
| Procedures | `procedures[].complications` | Complications | Text |  | ≤ 300 chars |

## Investigations & Results (`er_investigations`)

Form 10 · การส่งตรวจและผล


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Laboratory | `labs` | Lab | Repeating table |  |  |
| Laboratory | `labs[].test` | Test | Text | ✓ | ≤ 120 chars |
| Laboratory | `labs[].ordered_at` | Ordered | Time |  |  |
| Laboratory | `labs[].resulted_at` | Resulted | Time |  |  |
| Laboratory | `labs[].result` | Result | Text |  | ≤ 200 chars |
| Laboratory | `labs[].critical` | Critical | Yes/No |  |  |
| Laboratory | `labs[].ack_by` | Acknowledged by | Text |  | ≤ 60 chars |
| Laboratory | `labs[].ack_at` | Ack time | Time |  |  |
| Imaging | `imaging` | Study | Repeating table |  |  |
| Imaging | `imaging[].modality` | Modality | Single choice |  | options: `xr` X-ray, `us` Ultrasound, `ct` CT, `mri` MRI, `other` Other |
| Imaging | `imaging[].study` | Study | Text | ✓ | ≤ 120 chars |
| Imaging | `imaging[].img_ordered_at` | Ordered | Time |  |  |
| Imaging | `imaging[].done_at` | Done | Time |  |  |
| Imaging | `imaging[].report` | Report / finding | Text |  | ≤ 300 chars |
| Imaging | `imaging[].img_critical` | Critical | Yes/No |  |  |
| Imaging | `imaging[].img_ack_by` | Acknowledged by | Text |  | ≤ 60 chars |
| ECG and point-of-care tests | `ecgs` | ECG | Repeating table |  |  |
| ECG and point-of-care tests | `ecgs[].at` | Time | Time | ✓ |  |
| ECG and point-of-care tests | `ecgs[].interpretation` | Interpretation | Text |  | ≤ 200 chars |
| ECG and point-of-care tests | `ecgs[].stemi` | STEMI criteria met (physician) | Yes/No |  |  |
| ECG and point-of-care tests | `ecgs[].by` | Read by | Text |  | ≤ 60 chars |
| ECG and point-of-care tests | `poct` | Point-of-care tests (glucose, blood gas, troponin, …) | Long text |  | ≤ 2000 chars |
| ECG and point-of-care tests | `follow_up` | Pending results / follow-up | Long text |  | ≤ 1000 chars |

## Clinical Pathway / Fast Track (`er_fast_track_pathway`)

Form 11 · Fast track ตามแนวทางของโรงพยาบาล


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Pathway | `path_stroke` | Stroke fast track | Yes/No |  |  |
| Pathway | `path_stemi` | STEMI fast track | Yes/No |  |  |
| Pathway | `path_sepsis` | Sepsis | Yes/No |  |  |
| Pathway | `path_trauma` | Major trauma | Yes/No |  |  |
| Pathway | `path_other` | Other pathway | Text |  | ≤ 120 chars |
| Pathway | `activated_at` | Activated at | Date-time | ✓ |  |
| Pathway | `activated_by` | Activated by | Text |  | ≤ 120 chars |
| Stroke *(shown when path_stroke equals true)* | `last_known_well` | Last known well | Date-time |  |  |
| Stroke *(shown when path_stroke equals true)* | `nihss` | NIHSS | Integer |  | range 0–42 |
| Stroke *(shown when path_stroke equals true)* | `ct_at` | CT / CTA done | Date-time |  |  |
| Stroke *(shown when path_stroke equals true)* | `ct_read_at` | CT read | Date-time |  |  |
| Stroke *(shown when path_stroke equals true)* | `reperfusion` | Reperfusion | Single choice |  | options: `ivt` IV thrombolysis, `evt` Thrombectomy, `both` Both, `none` None |
| Stroke *(shown when path_stroke equals true)* | `needle_at` | Thrombolysis start | Date-time |  |  |
| Stroke *(shown when path_stroke equals true)* | `stroke_notes` | Notes | Long text |  | ≤ 1000 chars |
| STEMI *(shown when path_stemi equals true)* | `first_ecg_at` | First ECG | Date-time |  |  |
| STEMI *(shown when path_stemi equals true)* | `cath_activation_at` | Cath lab activated | Date-time |  |  |
| STEMI *(shown when path_stemi equals true)* | `lysis_at` | Fibrinolysis start | Date-time |  |  |
| STEMI *(shown when path_stemi equals true)* | `transfer_out_at` | Left for PCI | Date-time |  |  |
| STEMI *(shown when path_stemi equals true)* | `stemi_notes` | Notes | Long text |  | ≤ 1000 chars |
| Sepsis *(shown when path_sepsis equals true)* | `time_zero` | Time zero | Date-time |  |  |
| Sepsis *(shown when path_sepsis equals true)* | `lactate` | Lactate | Decimal |  | range 0–30 |
| Sepsis *(shown when path_sepsis equals true)* | `cultures_before_abx` | Cultures before antibiotics | Yes/No |  |  |
| Sepsis *(shown when path_sepsis equals true)* | `abx_at` | Antibiotics given | Date-time |  |  |
| Sepsis *(shown when path_sepsis equals true)* | `fluid_ml` | Fluid given | Integer |  | range 0–20000 |
| Sepsis *(shown when path_sepsis equals true)* | `vaso_at` | Vasopressor started | Date-time |  |  |
| Major trauma *(shown when path_trauma equals true)* | `team_at` | Trauma team arrived | Date-time |  |  |
| Major trauma *(shown when path_trauma equals true)* | `ct_trauma_at` | CT | Date-time |  |  |
| Major trauma *(shown when path_trauma equals true)* | `or_at` | To OR / intervention | Date-time |  |  |
| Major trauma *(shown when path_trauma equals true)* | `mtp` | Massive transfusion protocol | Yes/No |  |  |

## ER Observation Chart (`er_observation_chart`)

Form 12 · บันทึกการสังเกตอาการ — vital signs from monitors are charted automatically in the case; enter here only what the chart lacks


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Observation | `start_at` | Observation started | Date-time | ✓ |  |
| Observation | `reason` | Reason / goal | Long text | ✓ | ≤ 500 chars |
| Observation | `plan` | Monitoring plan | Long text |  | ≤ 1000 chars |
| Observation | `rounds` | Reassessment | Repeating table |  |  |
| Observation | `rounds[].at` | Time | Date-time | ✓ |  |
| Observation | `rounds[].sbp` | SBP | Integer |  | range 0–300 |
| Observation | `rounds[].hr` | HR | Integer |  | range 0–300 |
| Observation | `rounds[].rr` | RR | Integer |  | range 0–80 |
| Observation | `rounds[].spo2` | SpO₂ | Integer |  | range 0–100 |
| Observation | `rounds[].pain` | Pain | Integer |  | range 0–10 |
| Observation | `rounds[].progress` | Progress / response | Text |  | ≤ 300 chars |
| Observation | `rounds[].by` | By | Text |  | ≤ 60 chars |
| Observation | `end_at` | Observation ended | Date-time |  |  |
| Observation | `duration_days` | Duration | Calculated |  | formula: `DAYS(start_at, end_at)` |
| Observation | `result` | Result | Single choice |  | options: `discharge` Discharge, `admit` Admit, `transfer` Transfer, `other` Other |

## Consultation Record (`er_consultation`)

Form 13 · การปรึกษาแพทย์เฉพาะทาง


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Consultations | `consults` | Consultation | Repeating table |  |  |
| Consultations | `consults[].specialty` | Specialty | Text | ✓ | ≤ 80 chars |
| Consultations | `consults[].question` | Reason / question | Long text |  | ≤ 1000 chars |
| Consultations | `consults[].requested_at` | Requested | Date-time | ✓ |  |
| Consultations | `consults[].requested_by` | Requested by | Text |  | ≤ 120 chars |
| Consultations | `consults[].responded_at` | Consultant responded | Date-time |  |  |
| Consultations | `consults[].consultant` | Consultant | Text |  | ≤ 120 chars |
| Consultations | `consults[].assessment` | Assessment | Long text |  | ≤ 2000 chars |
| Consultations | `consults[].recommendation` | Recommendation | Long text |  | ≤ 2000 chars |

## Referral & Transfer Record (`er_referral_transfer`)

Form 14 · ส่งต่อ / ย้ายผู้ป่วย


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Transfer | `type` | Type | Single choice | ✓ | options: `refer_out` Refer out (other hospital), `internal` Internal transfer (ward / ICU / OR) |
| Transfer | `reason` | Reason | Long text | ✓ | ≤ 1000 chars |
| Transfer | `destination` | Receiving hospital / unit | Text | ✓ | ≤ 200 chars |
| Transfer | `accepted_by` | Accepted by (name / role) | Text |  | ≤ 120 chars |
| Transfer | `accepted_at` | Accepted at | Date-time |  |  |
| Transfer | `refer_no` | Referral number / system | Text |  | ≤ 60 chars |
| Condition at transfer | `t_sbp` | SBP | Integer |  | range 0–300 |
| Condition at transfer | `t_dbp` | DBP | Integer |  | range 0–200 |
| Condition at transfer | `t_hr` | HR | Integer |  | range 0–300 |
| Condition at transfer | `t_rr` | RR | Integer |  | range 0–80 |
| Condition at transfer | `t_temp` | Temp | Decimal |  | range 25–45 |
| Condition at transfer | `t_spo2` | SpO₂ | Integer |  | range 0–100 |
| Condition at transfer | `t_o2` | O₂ support | Single choice |  | options: `room_air` Room air, `cannula` Cannula, `mask` Mask, `nrb` Non-rebreather, `hfnc` HFNC, `niv` NIV, `ett` ETT / BVM |
| Condition at transfer | `t_dtx` | Capillary glucose | Integer |  | range 0–2000 |
| Condition at transfer | `t_pain` | Pain score | Integer |  | range 0–10 |
| Condition at transfer | `t_gcs` | GCS | Integer |  | range 3–15 |
| Condition at transfer | `condition` | Condition / risks | Long text |  | ≤ 1000 chars |
| Transport and handover | `team` | Transport team | Single choice |  | options: `als` ALS, `bls` BLS, `nurse` Nurse escort, `porter` Porter, `family` Family |
| Transport and handover | `equipment` | Equipment | Multiple choice |  | options: `monitor` Monitor, `ventilator` Ventilator, `pump` Infusion pump, `o2` Oxygen, `defib` Defibrillator |
| Transport and handover | `left_at` | Left ER | Date-time | ✓ |  |
| Transport and handover | `handover_to` | Handed over to | Text |  | ≤ 120 chars |
| Transport and handover | `documents` | Documents sent | Multiple choice |  | options: `referral` Referral letter, `imaging` Imaging, `labs` Lab results, `ecg` ECG, `meds` Medication list |

## ER Quality & Incident Record (`er_quality_incident`)

Form 17 · บันทึกอุบัติการณ์และความเสี่ยง


| Section | Field ID | Label | Type | Req. | Validation / options / clinical rule |
|---|---|---|---|---|---|
| Event | `occurred_at` | Occurred at | Date-time | ✓ |  |
| Event | `type` | Type | Single choice | ✓ | options: `incident` Incident, `adverse` Adverse event, `near_miss` Near miss, `delay` Clinical delay, `risk` Risk event; indexed (searchable) |
| Event | `category` | Category (hospital risk taxonomy) | Text |  | ≤ 120 chars |
| Event | `description` | What happened | Long text | ✓ | ≤ 4000 chars |
| Event | `severity` | Severity level | Single choice |  | options: `A` A, `B` B, `C` C, `D` D, `E` E, `F` F, `G` G, `H` H, `I` I, `1` 1, `2` 2, `3` 3, `4` 4, `5` 5; Clinical A–I / non-clinical 1–5 as used in the hospital's risk system (confirm with the hospital). |
| Event | `immediate_action` | Immediate action | Long text |  | ≤ 1000 chars |
| Event | `corrective_action` | Corrective / preventive action | Long text |  | ≤ 2000 chars |
| Event | `reported_by` | Reported by | Text | ✓ | ≤ 120 chars |
| Event | `sent_to_risk_system` | Entered in the hospital risk reporting system | Yes/No |  |  |

