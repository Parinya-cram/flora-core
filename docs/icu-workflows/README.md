# ICU workflows (draft): Neuro ICU and Critical Care ICU

This document drafts the forms and workflows for two kinds of ICU in Workflow Studio / Form Studio.

- **Workflow files:** `icu_neuro.workflow.json` and `icu_critical.workflow.json` (format `flora-workflow/1`).
  - Each file carries its forms in `bundled_forms`, so one import from Canopy → Workflow Studio → Import file brings in everything.
- **Generator:** `build_icu_workflows.py`.
  - It checks every form with the system's own `validate_definition` before writing the files.
  - To change something, edit this script and run it again.

```bash
python3 docs/icu-workflows/build_icu_workflows.py
```

## Scheduled forms (v2)

Round-type forms are **scheduled** (see `docs/ICU-ROUNDS.md`): the form is filled once per slot, and each fill is
its own entry, instead of a repeat of days inside one record. Both workflows set `day_start: "07:00"` and the default
shifts D 07:00 / E 15:00 / N 23:00.

| form_id | Version | Schedule |
|---|---|---|
| `icu_daily_round` | 2 (one day per entry; v1 was a per-day repeat) | daily 07:00, until discharge |
| `critical_icu_sofa` | 2 (one day per entry) | daily 07:00, until discharge |
| `neuro_icu_brain_bundle` | 2 (one shift per entry) | every shift |
| `critical_icu_vap_check` | 1 (new, split out of `critical_icu_ventilator`) | every shift |
| `critical_icu_ventilator` | 2 (VAP checks removed) | none (one record per case) |

The slot carries the date, ICU day and shift, so v2 no longer has date / ICU day / shift fields. Records filled with v1
stay readable. To go live, import the regenerated files and publish the new versions; the Leaf needs the
scheduled-forms code (migration 0097).

## Comparing the two workflows

| Phase (tab group) | Neuro ICU (`icu_neuro`) | Critical Care ICU (`icu_critical`) |
|---|---|---|
| Admission (`preop`) | ICU Admission Assessment ★ · **Neuro ICU Assessment** ★ | ICU Admission Assessment ★ · **Sepsis Hour-1 Bundle** |
| During ICU stay (`intraop`) | **Neuro Observation Chart** ★ · **Brain Protection Bundle** · ICU Daily Round ★ · ICU Lines & Devices | **SOFA Score – Daily** ★ · **Ventilator & Weaning** · **VAP Bundle – Shift Check** · ICU Daily Round ★ · ICU Lines & Devices |
| Discharge (`postop`) | ICU Discharge / Transfer Summary ★ (shows mRS / GCS at discharge) | ICU Discharge / Transfer Summary ★ |
| Built-in record | Case & Plan, Outcome (optional: Line, Comorbid, Pain) | Same |
| Case packet (PDF) | Vital-sign/event report followed by every form, in the order above | Same |

★ = required. Forms in **bold** are specific to that ICU type. Forms without bold are shared: the same form is used by both workflows, so queries across ICUs share a structure.

## Forms (11)

### Shared

| form_id | Contents | Calculations |
|---|---|---|
| `icu_admission` | Admission source and type; diagnosis; reason for ICU; code status; comorbidities; allergies; home medications; initial airway, MAP and lactate; APACHE II / SOFA; goals of care; signature | BMI, **PBW** (for ventilator settings) |
| `icu_daily_round` | One entry per day (07:00 round): RASS + target, CAM-ICU, CPOT, the **FAST HUGS BID** checklist, SAT/SBT, mobility level, skin, plan, family update | – |
| `icu_lines_devices` | Device table (CVC, PICC, A-line, HD catheter, Foley, ETT, EVD, ICP, ICD, NG); insertion and removal dates; whether still needed; CLABSI / CAUTI bundle | **Device days** (counted until removal or today) |
| `icu_discharge` | Time out of ICU; destination; final diagnosis; ICU procedures; ventilator days; complications (VAP / CLABSI / CAUTI / pressure injury / delirium / re-intubation…); ISBAR handover; signature. The neuro section (GCS, **mRS**) appears only when ICU = Neuro | **ICU LOS** |

### Neuro ICU

| form_id | Contents | Calculations / logic |
|---|---|---|
| `neuro_icu_assessment` | Diagnosis (TBI, SAH, ICH, stroke, post-craniotomy, status epilepticus, CNS infection, SCI); baseline GCS; pupils; motor power matrix (MRC 0–5, 4 limbs × proximal/distal); brainstem reflexes; ICP device, EVD level, ICP/CPP targets | **GCS total** (V = T counts as 1). The scale for each disease appears automatically: TBI → Marshall; SAH → Hunt & Hess / WFNS / modified Fisher / nimodipine; ICH → **ICH score**; stroke → NIHSS / reperfusion; seizure → EEG / AED |
| `neuro_icu_obs_chart` | Hourly neuro-sign table: E/V/M, pupils L/R, ICP, MAP, EVD output, seizure; escalation section (when to call the doctor) | **GCS** and **CPP = MAP − ICP** on every row |
| `neuro_icu_brain_bundle` | Secondary brain injury prevention, one entry per shift: HOB 30° / neutral head; SpO₂ ≥ 94; PaCO₂ 35–40; CPP within target; Na; glucose 140–180; temp ≤ 37.5; sedation; seizure prophylaxis; DVT; tier of ICP therapy used (Tier 0–3) | – |

### Critical Care ICU

| form_id | Contents | Calculations |
|---|---|---|
| `critical_icu_sofa` | One entry per day; enter raw lab and clinical values | **P/F ratio** and all six organ scores (Resp, Coag, Liver, CV, CNS, Renal); renal takes the higher of the creatinine and urine-output scores; **SOFA total** |
| `critical_icu_sepsis_bundle` | Time zero; qSOFA; septic shock; lactate (a repeat lactate field appears when the first is > 2); cultures before antibiotics; antibiotic time; fluids; vasopressor; MAP target; source control | **qSOFA**, **fluid target 30 mL/kg** |
| `critical_icu_ventilator` | ETT size and mark; ventilator settings table; ARDS (Berlin), prone, NMB; SBT / RSBI; extubation; re-intubation < 48 h | **PBW**, **Vt/PBW (mL/kg)**, **driving pressure**, **P/F** |
| `critical_icu_vap_check` | VAP bundle, one entry per shift: ventilated this shift, HOB 30–45°, oral care, cuff pressure, subglottic suction, SAT/SBT | – |

The formulas were tested with the system's formula engine, for example:
- E2 + VT + M5 → GCS 8, and with ICH 35 mL + IVH at age 82 → ICH score 4.
- SOFA from P/F 160 on a ventilator, platelets 90, bilirubin 2.5, NE ≤ 0.1, GCS 11, creatinine 2.4 / urine 450 mL → 3/2/2/3/2/3.
- Male, 170 cm → PBW 66 kg; Vt 420 → 6.4 mL/kg.

## Current status in Canopy (dev)

Both workflows and the 10 v1 forms were imported into Canopy and published (v1). Ward ICU1 has `icu_critical` (default) and `icu_neuro`. The v2 forms above are not imported yet.

Steps to go live:
1. **Form Studio:** clinicians review each form and adjust labels to match hospital practice. Then publish each form. Publish the shared forms first.
2. **Workflow Studio:** open `icu_neuro` / `icu_critical` → **Validate** → **Publish**.
3. **Assign wards:** for example, Neuro ICU → `icu_neuro` as the default; Medical/Surgical ICU → `icu_critical` as the default. A ward can have both workflows, so the nurse chooses one when starting a case.
4. Release Canopy/Leaf with the Workflow Studio Leaf-side code. The leaf-1.2.x releases do not have it yet.

## Points for the clinical team to decide

- Leaf already records vital signs, I/O and medications, so these forms do not record them again. They record only assessments, scores and bundles.
- Neuro observations are a table in a form, not a chart. If you want a GCS / pupil / ICP trend graph like the vital-sign graph, that should become a built-in record section later.
- Targets (ICP threshold, CPP, Na, MAP) are entered as numbers for each patient. There are no hard-coded defaults, because they vary by protocol.
- APACHE II is a single number entered on the admission form. If you want it calculated automatically, a separate form with about 12 variables can be added.
- Labels are in English (clinical terms), with Thai section headings. Form Studio can switch them to Thai.
