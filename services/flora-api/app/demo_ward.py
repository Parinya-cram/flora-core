"""Canopy demo mode: a synthetic "Demo Ward" for showing report statistics.

Every generated row is marked as demo -- the care unit has is_demo, Leaf ids start
with 'demo-' and archive rows use source_system 'flora-demo' -- so the data never
counts towards the Canopy centre's own figures (see fleet_read.IN_SCOPE and
canopy_reports._filters). Deletion goes through the canopy_demo_reset() database
function only (0040-canopy-demo-ward.sql).
"""
import math
import random
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb


DEMO_SOURCE = "flora-demo"
DEMO_WARD_NAME = "Demo Ward"
LEAF_PREFIX = "demo-leaf-"
MINUTE = 60_000
BANGKOK = timezone(timedelta(hours=7))

# name, ICD-9-CM, service, diagnosis, ICD-10, min/max surgery minutes, technique,
# emergency probability, arterial line, estimated blood loss (ml)
PROCEDURES = [
    ("Laparoscopic cholecystectomy", "51.23", "General Surgery", "Calculus of gallbladder with cholecystitis", "K80.1", 50, 110, "ga_ett", 0.05, False, 50),
    ("Laparoscopic appendectomy", "47.01", "General Surgery", "Acute appendicitis", "K35.8", 35, 80, "ga_ett", 0.8, False, 20),
    ("Inguinal hernia repair with mesh", "53.05", "General Surgery", "Unilateral inguinal hernia", "K40.9", 40, 80, "spinal", 0.05, False, 30),
    ("Exploratory laparotomy", "54.11", "General Surgery", "Intestinal obstruction", "K56.6", 100, 220, "ga_ett", 0.7, True, 400),
    ("Total thyroidectomy", "06.4", "General Surgery", "Nontoxic multinodular goitre", "E04.2", 90, 170, "ga_ett", 0.0, False, 100),
    ("Modified radical mastectomy", "85.43", "General Surgery", "Malignant neoplasm of breast", "C50.9", 110, 190, "ga_ett", 0.0, False, 200),
    ("Right hemicolectomy", "45.73", "General Surgery", "Malignant neoplasm of colon", "C18.9", 150, 280, "ga_epidural", 0.0, True, 300),
    ("Total knee arthroplasty", "81.54", "Orthopedics", "Primary gonarthrosis, bilateral", "M17.0", 90, 150, "spinal_block", 0.0, False, 250),
    ("Total hip arthroplasty", "81.51", "Orthopedics", "Primary coxarthrosis", "M16.1", 90, 160, "spinal", 0.0, False, 350),
    ("ORIF distal radius", "79.32", "Orthopedics", "Fracture of lower end of radius", "S52.5", 50, 110, "block", 0.3, False, 30),
    ("ORIF intertrochanteric femur", "79.35", "Orthopedics", "Pertrochanteric fracture", "S72.1", 70, 140, "spinal", 0.4, False, 300),
    ("Lower segment caesarean section", "74.1", "Obstetrics & Gynecology", "Maternal care for uterine scar", "O34.2", 40, 75, "spinal", 0.45, False, 600),
    ("Total abdominal hysterectomy", "68.49", "Obstetrics & Gynecology", "Leiomyoma of uterus", "D25.9", 90, 170, "ga_ett", 0.0, False, 300),
    ("Transurethral resection of prostate", "60.29", "Urology", "Hyperplasia of prostate", "N40", 50, 100, "spinal", 0.0, False, 150),
    ("Percutaneous nephrolithotomy", "55.03", "Urology", "Calculus of kidney", "N20.0", 90, 170, "ga_ett", 0.0, False, 150),
    ("Cystoscopy with ureteric stent", "59.8", "Urology", "Hydronephrosis with ureteral stricture", "N13.1", 20, 45, "ga_lma", 0.2, False, 0),
    ("Tonsillectomy", "28.2", "ENT", "Chronic tonsillitis", "J35.0", 25, 60, "ga_ett", 0.0, False, 50),
    ("Functional endoscopic sinus surgery", "22.63", "ENT", "Chronic sinusitis", "J32.9", 60, 130, "ga_ett", 0.0, False, 100),
    ("Phacoemulsification with IOL", "13.41", "Ophthalmology", "Senile nuclear cataract", "H25.1", 15, 40, "mac", 0.0, False, 0),
    ("Craniotomy for tumour removal", "01.59", "Neurosurgery", "Malignant neoplasm of brain", "C71.9", 180, 330, "ga_ett", 0.1, True, 400),
    ("Wound debridement", "86.22", "Plastic Surgery", "Pressure ulcer stage III", "L89.3", 25, 60, "ga_lma", 0.3, False, 50),
]
PROCEDURE_WEIGHTS = [8, 6, 5, 3, 3, 3, 2, 4, 3, 4, 3, 6, 3, 4, 3, 4, 3, 2, 6, 1, 4]

MALE_FIRST = ["สมชาย", "สมศักดิ์", "วิชัย", "ประเสริฐ", "สุรชัย", "ธนากร", "อนุชา", "กิตติพงษ์",
              "ณัฐวุฒิ", "ปิยะ", "ชัยวัฒน์", "บุญมี", "สุเทพ", "เกรียงไกร", "ภานุวัฒน์", "ศุภชัย"]
FEMALE_FIRST = ["สมหญิง", "มาลี", "สุภาพร", "วันเพ็ญ", "กาญจนา", "นภัสสร", "ปิยะนุช", "อรุณี",
                "จันทร์เพ็ญ", "ศิริพร", "พรทิพย์", "ณัฐธิดา", "รัตนา", "อัมพร", "ลำดวน", "ชุติมา"]
LAST_NAMES = ["ใจดี", "สุขสวัสดิ์", "ศรีสุข", "วงศ์ใหญ่", "บุญประเสริฐ", "แก้วมณี", "ทองดี", "พรหมมา",
              "รัตนพันธ์", "จันทร์หอม", "ศักดิ์สิทธิ์", "มั่นคง", "เพชรรัตน์", "สมบูรณ์", "อินทร์แก้ว",
              "ชัยมงคล", "สายทอง", "ประเสริฐวงศ์"]
ANESTHESIOLOGISTS = ["พญ. ศิริลักษณ์ วงศ์วิสัญญี", "นพ. ธีรวัฒน์ ปัญญาดี", "พญ. กมลวรรณ ศรีอรุณ",
                     "นพ. อดิศร เรืองชัย", "พญ. ปวีณา ทองคำ"]
NURSE_ANESTHETISTS = ["วิภาวรรณ สุขใจ", "จิราพร มีสุข", "สุนันทา แสงทอง", "อำไพ รักษ์ดี",
                      "ปราณี บุญเรือง", "ดวงใจ คำแสน", "สุดารัตน์ พูลผล"]
OR_NURSES = ["กัญญา ศรีวงศ์", "นันทนา ใจงาม", "พิมพ์ชนก แสนดี", "รุ่งนภา คงสุข", "ยุพิน ทองแท้",
             "อรอุมา บุญมา", "ศศิธร วงศ์สวัสดิ์", "เบญจวรรณ ชื่นใจ"]
SURGEONS = {
    "General Surgery": ["นพ. ชาญวิทย์ ศัลยกุล", "พญ. นิภาพร ใจเย็น", "นพ. วรพล สุขเจริญ"],
    "Orthopedics": ["นพ. ธนพล กระดูกดี", "นพ. สิทธิชัย มั่นคง"],
    "Obstetrics & Gynecology": ["พญ. สุพัตรา แม่นยำ", "พญ. อรวรรณ รักษ์ไทย"],
    "Urology": ["นพ. ปกรณ์ ไตงาม"],
    "ENT": ["พญ. ลลิตา โสตถิ"],
    "Ophthalmology": ["นพ. เอกชัย ตาใส", "พญ. มณีรัตน์ แก้วตา"],
    "Neurosurgery": ["นพ. ภูมิ ประสาทดี"],
    "Plastic Surgery": ["พญ. ธิดารัตน์ งามผิว"],
}
ALLERGENS = [("Penicillin", "Rash", "Moderate"), ("Sulfonamide", "Urticaria", "Mild"),
             ("Shellfish", "Angioedema", "Severe"), ("NSAIDs", "Bronchospasm", "Moderate")]
GENERAL_ITEMS = ["Forced-air warming blanket", "Foley catheter", "Sequential compression device",
                 "Fluid warmer", "Arterial line", "Central venous catheter"]
SPECIAL_TECHNIQUES = ["Rapid sequence induction", "Controlled hypotension", "Goal-directed fluid therapy",
                      "Awake fibreoptic intubation", "One-lung ventilation"]
NERVE_BLOCKS = {"spinal_block": ["Adductor canal block", "IPACK block"],
                "block": ["Supraclavicular brachial plexus block", "Infraclavicular brachial plexus block"],
                "ga_epidural": ["Thoracic epidural"]}

ITEMS = {  # name: (item id, kind, unit, category, code)
    "Acetated Ringer's": (9001, "fluid", "ml", "Crystalloid", "AR"),
    "Propofol": (9101, "med", "mg", "Induction agent", "PROP"),
    "Fentanyl": (9102, "med", "mcg", "Opioid", "FENT"),
    "Cisatracurium": (9103, "med", "mg", "Neuromuscular blocker", "CISA"),
    "Cefazolin": (9104, "med", "g", "Antibiotic", "CEFA"),
    "Ondansetron": (9105, "med", "mg", "Antiemetic", "ONDA"),
    "Morphine": (9106, "med", "mg", "Opioid", "MORP"),
    "Sugammadex": (9107, "med", "mg", "Reversal agent", "SUGA"),
    "Bupivacaine 0.5% heavy": (9108, "med", "ml", "Local anaesthetic", "BUPH"),
    "Bupivacaine 0.25%": (9109, "med", "ml", "Local anaesthetic", "BUP25"),
    "Midazolam": (9110, "med", "mg", "Sedative", "MIDA"),
    "Ephedrine": (9111, "med", "mg", "Vasopressor", "EPHE"),
    "Oxytocin": (9112, "med", "unit", "Uterotonic", "OXYT"),
    "Urine": (9201, "output", "ml", "Output", "URINE"),
    "Blood loss": (9202, "output", "ml", "Output", "EBL"),
}


def _ms(value: datetime) -> int:
    return int(value.timestamp() * 1000)


def _dt(value_ms: int | None) -> datetime | None:
    return None if value_ms is None else datetime.fromtimestamp(value_ms / 1000, timezone.utc)


def _uuid(rng: random.Random) -> uuid.UUID:
    return uuid.UUID(int=rng.getrandbits(128), version=4)


def _between(rng: random.Random, low: float, high: float) -> int:
    return int(round(rng.uniform(low, high)))


# --- patients ------------------------------------------------------------------

def _patient(rng: random.Random, procedure: tuple, used_hn: set[str], when: datetime) -> dict[str, Any]:
    name = procedure[0]
    if "caesarean" in name.lower():
        age, sex = _between(rng, 19, 41), "F"
    elif "hysterectomy" in name.lower() or "mastectomy" in name.lower():
        age, sex = _between(rng, 35, 70), "F"
    elif "prostate" in name.lower():
        age, sex = _between(rng, 55, 85), "M"
    elif "cataract" in procedure[3].lower() or "arthroplasty" in name.lower():
        age, sex = _between(rng, 55, 86), rng.choice("MF")
    elif "tonsillectomy" in name.lower():
        age, sex = _between(rng, 5, 30), rng.choice("MF")
    else:
        age, sex = _between(rng, 18, 82), rng.choice("MF")
    if age < 15:
        title = "ด.ช." if sex == "M" else "ด.ญ."
    else:
        title = "นาย" if sex == "M" else rng.choice(["นาง", "นางสาว"])
    first = rng.choice(MALE_FIRST if sex == "M" else FEMALE_FIRST)
    last = rng.choice(LAST_NAMES)
    while True:
        hn = f"DEMO-{rng.randint(10000, 99999)}"
        if hn not in used_hn:
            used_hn.add(hn)
            break
    if age < 15:
        weight = round(rng.uniform(18, 50), 1)
        height = _between(rng, 110, 160)
    else:
        height = _between(rng, 150, 172) if sex == "F" else _between(rng, 160, 182)
        weight = round(rng.uniform(19, 31) * (height / 100) ** 2, 1)
    born = (when - timedelta(days=age * 365 + rng.randint(0, 364))).date()
    return {
        "hn": hn, "an": f"DA{when:%y}{rng.randint(10000, 99999)}", "sex": sex, "age": age,
        "dob": born, "title_th": title, "first_name": first, "last_name": last,
        "patient_name": f"{title}{first} {last}", "weight_kg": weight, "height_cm": height,
        "blood_group": rng.choice(["A", "B", "O", "O", "AB"]) + " Rh+",
    }


def _asa(rng: random.Random, age: int, emergency: bool) -> str:
    if age < 40:
        grade = rng.choices([1, 2, 3], [60, 33, 7])[0]
    elif age < 65:
        grade = rng.choices([1, 2, 3, 4], [15, 55, 27, 3])[0]
    else:
        grade = rng.choices([2, 3, 4], [40, 50, 10])[0]
    return f"{grade}{'E' if emergency else ''}"


# --- case course ---------------------------------------------------------------

def _plan(rng: random.Random, start_ms: int, procedure: tuple, minimum_out: int | None = None) -> dict[str, int | None]:
    """Event times (epoch ms) of one OR stay; position may be missing or implausible."""
    technique = procedure[7]
    anes = start_ms + _between(rng, 4, 12) * MINUTE
    airway = anes + _between(rng, 3, 7) * MINUTE
    position = anes + _between(rng, 6, 15) * MINUTE
    incision = position + _between(rng, 6, 15) * MINUTE
    surgery = rng.triangular(procedure[5], procedure[6], procedure[5] + (procedure[6] - procedure[5]) * 0.35)
    end_surgery = incision + int(surgery) * MINUTE
    anes_end = end_surgery + _between(rng, 4, 14 if technique.startswith("ga") else 6) * MINUTE
    out = anes_end + _between(rng, 3, 9) * MINUTE
    if minimum_out and out < minimum_out:
        shift = minimum_out - out
        end_surgery, anes_end, out = end_surgery + shift, anes_end + shift, out + shift
    quality = rng.random()
    return {
        "in": start_ms, "anes": anes, "airway": airway,
        "position": None if quality < 0.04 else anes - 3 * MINUTE if quality < 0.06 else position,
        "incision": incision, "end_surgery": end_surgery, "anes_end": anes_end, "out": out,
    }


def _episodes(rng: random.Random, plan: dict[str, int | None]) -> list[tuple[str, int, int]]:
    """Occasional excursions: post-induction hypotension, desaturation, tachycardia, hypertension."""
    episodes = []
    if rng.random() < 0.35:
        start = plan["anes"] + _between(rng, 5, 15) * MINUTE
        episodes.append(("hypotension", start, start + _between(rng, 3, 9) * MINUTE))
    span = max(MINUTE, plan["anes_end"] - plan["incision"])
    for kind, chance in (("desaturation", 0.12), ("tachycardia", 0.18), ("hypertension", 0.12)):
        if rng.random() < chance:
            start = plan["incision"] + int(rng.random() * span)
            episodes.append((kind, start, start + _between(rng, 2, 7) * MINUTE))
    return episodes


def _vitals(rng: random.Random, plan: dict[str, int | None], end_ms: int, technique: str,
            patient: dict[str, Any], art_line: bool, episodes: list[tuple[str, int, int]]) -> list[dict[str, Any]]:
    ga = technique.startswith("ga")
    spinal = technique.startswith("spinal") or technique == "ga_epidural"
    young = patient["age"] < 15
    hr0 = rng.gauss(95 if young else 78, 9)
    sbp0 = rng.gauss(108 if young else 128 + max(0, patient["age"] - 50) * 0.4, 12)
    dbp0 = sbp0 * rng.uniform(0.55, 0.65)
    spo20 = rng.choice([99, 99, 100]) if ga else rng.choice([97, 98, 99])
    temp = rng.uniform(36.3, 36.9)
    agent = "SEV" if rng.random() < 0.8 else "DES"
    tidal = int(round(patient["weight_kg"] * 7 / 10) * 10)
    noise = {"hr": 0.0, "bp": 0.0, "spo2": 0.0, "rr": 0.0, "co2": 0.0, "agent": 0.0}
    rows = []
    t = plan["in"] // MINUTE * MINUTE
    while t <= end_ms:
        m_anes = (t - plan["anes"]) / MINUTE
        hr_f = bp_f = 1.0
        if t < plan["anes"]:
            hr_f, bp_f = 1.08, 1.1
        else:
            if ga:
                drop = 0.2 * min(1, m_anes / 4) * math.exp(-max(0, m_anes - 4) / 12)
                bp_f, hr_f = bp_f - drop, hr_f - drop * 0.4
            if spinal:
                drop = 0.15 * min(1, max(0, (m_anes - 2) / 8)) * math.exp(-max(0, m_anes - 15) / 30)
                bp_f, hr_f = bp_f - drop, hr_f - drop * 0.5
            if ga and t >= plan["incision"]:
                surge = 0.12 * math.exp(-(t - plan["incision"]) / MINUTE / 8)
                bp_f, hr_f = bp_f + surge, hr_f + surge
            if t >= plan["anes_end"] - 6 * MINUTE:
                lift = 0.12 if ga else 0.04
                bp_f, hr_f = bp_f + lift, hr_f + lift
        hr_x = bp_x = spo2_x = 0.0
        for kind, start, stop in episodes:
            if start <= t <= stop:
                if kind == "hypotension":
                    bp_f *= 0.68
                    hr_x += 8
                elif kind == "hypertension":
                    bp_f *= 1.28
                elif kind == "tachycardia":
                    hr_x += 34
                elif kind == "desaturation":
                    spo2_x -= rng.uniform(6, 10)
        noise["hr"] = 0.85 * noise["hr"] + rng.gauss(0, 1.6)
        noise["bp"] = 0.85 * noise["bp"] + rng.gauss(0, 2.2)
        noise["spo2"] = 0.6 * noise["spo2"] + rng.gauss(0, 0.4)
        noise["rr"] = 0.7 * noise["rr"] + rng.gauss(0, 0.6)
        noise["co2"] = 0.8 * noise["co2"] + rng.gauss(0, 0.7)
        noise["agent"] = 0.9 * noise["agent"] + rng.gauss(0, 0.03)
        hr = max(38, round(hr0 * hr_f + hr_x + noise["hr"]))
        sbp = max(55, round(sbp0 * bp_f + noise["bp"]))
        dbp = max(28, round(dbp0 * bp_f + noise["bp"] * 0.6))
        mean = round((sbp + 2 * dbp) / 3)
        ventilated = ga and plan["airway"] <= t < plan["anes_end"]
        payload: dict[str, Any] = {
            "hr": hr, "pr": hr + rng.choice([0, 0, 1, -1]),
            "spo2": int(min(100, max(82, round(spo20 + spo2_x + noise["spo2"])))),
            "rr": max(6, round((12 if ventilated else 16) + noise["rr"])),
        }
        minute_index = (t - plan["in"]) // MINUTE
        if art_line and t >= plan["anes"] + 10 * MINUTE:
            payload.update(art_sys=sbp, art_dia=dbp, art_map=mean)
        if minute_index % 5 == 0 and (not art_line or minute_index % 15 == 0):
            cuff = rng.gauss(0, 3)
            payload.update(nibp_sys=round(sbp + cuff), nibp_dia=round(dbp + cuff * 0.5),
                           nibp_map=round(mean + cuff * 0.7))
        if ga and t >= plan["anes"]:
            temp = max(35.4, temp - 0.007)
        elif t >= plan["anes"]:
            temp = max(35.9, temp - 0.003)
        if ga or minute_index % 15 == 0:
            payload["temperature"] = round(temp, 1)
        if ventilated:
            fio2 = 50 + rng.gauss(0, 1)
            et_agent = (2.0 if agent == "SEV" else 6.0) + noise["agent"] * (1 if agent == "SEV" else 3)
            payload.update(
                et_co2=round(35 + noise["co2"]), set_vent_mode="VCV", set_tidal_volume=tidal, set_rr=12,
                set_peep=5, set_fio2=50, fio2=round(fio2, 1), tidal_volume_exp=round(tidal + rng.gauss(0, 12)),
                airway_pressure_peak=round(17 + rng.gauss(0, 1.4), 1), agent_id=agent,
                et_agent=round(et_agent, 2), fi_agent=round(et_agent + 0.4, 2),
                mac=round(et_agent / (2.0 if agent == "SEV" else 6.0), 2),
            )
        elif t >= plan["anes"] and not ga:
            payload["et_co2"] = round(31 + noise["co2"] * 1.5)
        rows.append({"ts_minute": t, "payload": payload, "provenance": {}})
        t += MINUTE
    return rows


def _events(plan: dict[str, int | None], technique: str) -> list[tuple[str, int | None]]:
    airway = {"ga_ett": "Intubation", "ga_epidural": "Intubation", "ga_lma": "LMA insertion",
              "spinal": "Spinal block", "spinal_block": "Spinal block", "block": "Nerve block",
              "mac": "Sedation"}[technique]
    return [
        ("Patient In", plan["in"]), ("Start Anesthesia", plan["anes"]), (airway, plan["airway"]),
        ("Position", plan["position"]), ("Incision", plan["incision"]),
        ("End of Surgery", plan["end_surgery"]),
        ("Extubation" if technique in {"ga_ett", "ga_epidural"} else "End Anesthesia", plan["anes_end"]),
        ("Patient Out", plan["out"]),
    ]


def _io(rng: random.Random, case_id: int, plan: dict[str, int | None], end_ms: int, active: bool,
        technique: str, procedure: tuple, patient: dict[str, Any], episodes: list) -> dict[str, Any]:
    doses: list[tuple[str, int, float, str]] = []  # item, ts, amount, route
    anes, w = plan["anes"], patient["weight_kg"]
    if procedure[2] != "Ophthalmology":
        doses.append(("Cefazolin", anes - 2 * MINUTE, 2 if w > 80 else 1, "IV"))
    if technique.startswith("ga"):
        doses += [("Fentanyl", anes, round(w * 1.5 / 25) * 25, "IV"),
                  ("Propofol", anes + MINUTE, round(w * 2 / 10) * 10, "IV")]
        if technique != "ga_lma":
            doses += [("Cisatracurium", anes + 2 * MINUTE, round(w * 0.15), "IV"),
                      ("Sugammadex", plan["end_surgery"] + 3 * MINUTE, round(w * 2 / 50) * 50, "IV")]
        doses.append(("Morphine", plan["incision"] + 20 * MINUTE, rng.choice([3, 4, 5]), "IV"))
    elif technique.startswith("spinal"):
        doses += [("Bupivacaine 0.5% heavy", anes + 2 * MINUTE, rng.choice([2.4, 2.6, 2.8, 3.0]), "IT"),
                  ("Morphine", anes + 2 * MINUTE, 0.2, "IT")]
    elif technique == "mac":
        doses += [("Midazolam", anes, 1, "IV"), ("Fentanyl", anes + MINUTE, 25, "IV")]
    if technique in NERVE_BLOCKS:
        doses.append(("Bupivacaine 0.25%", anes + 4 * MINUTE, 20, "Perineural"))
    if "caesarean" in procedure[0].lower():
        doses.append(("Oxytocin", plan["incision"] + 8 * MINUTE, 5, "IV"))
    for kind, start, _ in episodes:
        if kind == "hypotension":
            doses.append(("Ephedrine", start + 2 * MINUTE, 6, "IV"))
    doses.append(("Ondansetron", plan["end_surgery"] - 15 * MINUTE, 4, "IV"))

    runs: dict[str, dict[str, Any]] = {}
    events = []

    def run_for(name: str, route: str, drip: bool = False, started: int | None = None, stopped: int | None = None):
        if name not in runs:
            item_id, kind, unit, category, code = ITEMS[name]
            runs[name] = {
                "id": case_id * 100 + len(runs) + 1, "case_id": case_id, "item_id": item_id,
                "item_code": code, "item_name": name, "item_category": category, "item_unit": unit,
                "kind": kind, "route": route, "started_at": started, "stopped_at": stopped,
                "entry_mode": "drip" if drip else "bolus", "note": None, "include_in_balance": 1,
                "segments": [],
            }
        return runs[name]

    fluid_stop = None if active else plan["out"]
    rate = rng.choice([80, 100, 120, 150])
    fluid = run_for("Acetated Ringer's", "IV", True, plan["in"] + 2 * MINUTE, fluid_stop)
    fluid["segments"].append({"id": fluid["id"], "run_id": fluid["id"], "ts_from": plan["in"] + 2 * MINUTE,
                              "ts_to": fluid_stop, "rate_value": rate, "rate_unit": "ml/hr",
                              "dose_value": None, "dose_unit": None, "include_in_balance": 1})
    for name, ts, amount, route in sorted(doses, key=lambda dose: dose[1]):
        if ts > end_ms:
            continue
        run = run_for(name, route, started=ts, stopped=ts)
        run["stopped_at"] = ts
        events.append({"id": case_id * 1000 + len(events) + 1, "case_id": case_id, "run_id": run["id"],
                       "item_id": run["item_id"], "item_name": name, "item_code": run["item_code"],
                       "item_category": run["item_category"], "kind": "med", "event_ts": ts,
                       "dose_value": amount, "dose_unit": run["item_unit"], "volume_ml": None, "route": route})
    intake = rate * (min(end_ms, plan["out"]) - plan["in"]) / 3_600_000
    blood = urine = 0
    if not active:
        blood = max(0, int(rng.gauss(procedure[10], procedure[10] * 0.35)) // 10 * 10)
        urine = int((plan["out"] - plan["in"]) / 3_600_000 * rng.uniform(0.5, 1.2) * w) // 10 * 10
        for name, volume in (("Blood loss", blood), ("Urine", urine)):
            if volume:
                run = run_for(name, "", started=plan["end_surgery"], stopped=plan["end_surgery"])
                events.append({"id": case_id * 1000 + len(events) + 1, "case_id": case_id, "run_id": run["id"],
                               "item_id": run["item_id"], "item_name": name, "item_code": run["item_code"],
                               "item_category": "Output", "kind": "output", "event_ts": plan["end_surgery"],
                               "dose_value": None, "dose_unit": None, "volume_ml": volume, "route": None})
    return {
        "runs": list(runs.values()), "events": events,
        "totals": {"intake_ml": round(intake), "output_ml": blood + urine, "net_ml": round(intake) - blood - urine,
                   "urine_output_ml": urine, "blood_loss_ml": blood},
    }


def _labs(rng: random.Random, patient: dict[str, Any]) -> list[dict[str, str]]:
    hb = rng.gauss(13.5 if patient["sex"] == "M" else 12.2, 1.4)
    k = rng.gauss(4.0, 0.4)
    return [
        {"LABNAME": "Hemoglobin", "LABRESULT": f"{hb:.1f}", "LABUNIT": "g/dL", "ABNORMALFLAG": "L" if hb < 11 else ""},
        {"LABNAME": "Platelet", "LABRESULT": str(_between(rng, 160, 380) * 1000), "LABUNIT": "/uL", "ABNORMALFLAG": ""},
        {"LABNAME": "Creatinine", "LABRESULT": f"{rng.uniform(0.6, 1.3):.2f}", "LABUNIT": "mg/dL", "ABNORMALFLAG": ""},
        {"LABNAME": "Potassium", "LABRESULT": f"{k:.1f}", "LABUNIT": "mmol/L", "ABNORMALFLAG": "L" if k < 3.5 else ""},
    ]


def _form_fields(rng: random.Random, technique: str, emergency: bool) -> list[tuple[int, str, str]]:
    """(Innovian component id, field title, selected label) for the anaesthesia record."""
    fields: list[tuple[int, str, str]] = []
    if technique.startswith("ga"):
        fields.append((790, "General anaesthesia", "General anaesthesia"))
        fields.append((4490, "Anaesthesia technique", "Combined GA and RA" if technique == "ga_epidural"
                       else rng.choices(["Balance", "TIVA", "Inhalational"], [70, 18, 12])[0]))
        if technique == "ga_lma":
            fields.append((5060, "Airway equipment", "LMA"))
        else:
            video = rng.random() < 0.22
            fields += [
                (5060, "Airway equipment", "ETT"),
                (4487, "Intubating technique", "Video laryngoscopy" if video else "Direct laryngoscopy"),
                (4489, "Laryngoscope", "Video laryngoscope (C-MAC)" if video else rng.choices(["Macintoch", "Miller"], [9, 1])[0]),
                (4491, "Blade size", rng.choice(["3", "3", "4"])),
                (868, "Cuff", "Cuffed"),
                (871, "Tube size", rng.choice(["6.5", "7.0", "7.0", "7.5", "8.0"])),
                (873, "Tube depth", f"{rng.choice([20, 21, 21, 22, 23])} cm"),
            ]
            if rng.random() < 0.06:
                fields.append((5055, "Airway problem", rng.choice(["Difficult mask ventilation", "Difficult laryngoscopy (CL 3)"])))
    elif technique.startswith("spinal"):
        fields += [(4490, "Anaesthesia technique", "Spinal anaesthesia"),
                   (898, "Regional location", rng.choice(["L3-L4", "L3-L4", "L4-L5", "L2-L3"])),
                   (899, "Needle size", rng.choice(["Quincke 25G", "Quincke 27G", "Pencil-point 27G"])),
                   (900, "Regional technique", "Spinal")]
    elif technique == "mac":
        fields.append((4490, "Anaesthesia technique", "MAC"))
    else:
        fields.append((4490, "Anaesthesia technique", "Regional anaesthesia"))
    if technique in NERVE_BLOCKS:
        fields += [(4816, "Nerve block guidance", "Ultrasound guided"),
                   (4091, "Nerve block type", rng.choice(NERVE_BLOCKS[technique]))]
    for item in rng.sample(GENERAL_ITEMS[:4], rng.randint(1, 2)):
        fields.append((2699, "General item / equipment", item))
    if emergency and technique.startswith("ga"):
        fields.append((1406, "Special technique", "Rapid sequence induction"))
    elif rng.random() < 0.12:
        fields.append((1406, "Special technique", rng.choice(SPECIAL_TECHNIQUES[1:])))
    return fields


# --- persistence ---------------------------------------------------------------

def _demo_hierarchy(database: Connection, rooms: int, created: int) -> tuple[int, list[int]]:
    from .routes.fleet_control import ensure_location

    hospital = database.execute(
        "SELECT id FROM canopy_location WHERE kind='hospital' AND is_active AND NOT is_demo ORDER BY sort_order,id LIMIT 1"
    ).fetchone()
    hospital_id = hospital["id"] if hospital else ensure_location(database, None, "hospital", "Demo Hospital")
    building = database.execute(
        """SELECT id FROM canopy_location WHERE kind='building' AND parent_id=%s AND is_active AND NOT is_demo
           ORDER BY sort_order,id LIMIT 1""", (hospital_id,)
    ).fetchone()
    building_id = building["id"] if building else ensure_location(database, hospital_id, "building", "Main building")
    if database.execute(
        "SELECT 1 FROM canopy_location WHERE parent_id=%s AND lower(name)=lower(%s)", (building_id, DEMO_WARD_NAME)
    ).fetchone():
        raise HTTPException(status_code=409, detail=f"A non-demo location named '{DEMO_WARD_NAME}' already exists")

    def insert(parent: int, kind: str, name: str, order: int, code: str | None = None) -> int:
        return database.execute(
            """INSERT INTO canopy_location(parent_id,kind,code,name,is_active,sort_order,is_demo,created_at,updated_at)
               VALUES (%s,%s,%s,%s,true,%s,true,%s,%s) RETURNING id""",
            (parent, kind, code, name, order, created, created),
        ).fetchone()["id"]

    unit = insert(building_id, "care_unit", DEMO_WARD_NAME, 9999, "DEMO")
    beds = []
    for index in range(1, rooms + 1):
        room = insert(unit, "room", f"Demo OR {index}", index)
        beds.append(insert(room, "bed", f"Demo OR {index} workstation", 0))
    return unit, beds


def generate(database: Connection, cases: int = 200, days: int = 30, active: int = 3,
             seed: int | None = None) -> dict[str, Any]:
    """Replace any existing demo data with a fresh demo ward. Call inside a transaction."""
    from .routes.fleet_control import write_assignment

    started = time.monotonic()
    seed = seed if seed is not None else random.randrange(1, 2**31)
    rng = random.Random(seed)
    active = min(active, cases)
    database.execute("SELECT canopy_demo_reset()")

    now = datetime.now(timezone.utc)
    now_ms = _ms(now)
    leaf_count = max(3, active) + 1
    unit_id, beds = _demo_hierarchy(database, leaf_count, now_ms)
    real_hospital = database.execute(
        "SELECT hospital_id FROM sync_leaf_node WHERE leaf_id NOT LIKE %s ORDER BY registered_at LIMIT 1", ("demo-%",)
    ).fetchone()
    hospital_id = real_hospital["hospital_id"] if real_hospital else "hospital-01"
    leaves = []
    for index, bed in enumerate(beds, 1):
        leaf_id = f"{LEAF_PREFIX}{index:02d}"
        database.execute(
            """INSERT INTO sync_leaf_node(leaf_id,hospital_id,display_name,software_version,last_seen_at,registered_at,metadata)
               VALUES (%s,%s,%s,'demo',now(),%s,%s)""",
            (leaf_id, hospital_id, f"Demo OR {index}", now - timedelta(days=days + 1), Jsonb({"demo": True})),
        )
        write_assignment(database, leaf_id, bed, {"timezone": "Asia/Bangkok", "date_format": "DD/MM/YYYY", "time_format": "24h"})
        database.execute("UPDATE canopy_leaf_assignment SET applied_version=desired_version WHERE leaf_id=%s", (leaf_id,))
        leaves.append(leaf_id)

    # Discharged cases: weekday-weighted days in the past window, listed per OR from 08:30.
    today = now.astimezone(BANGKOK).date()
    past_days = [today - timedelta(days=offset) for offset in range(1, days + 1)]
    weights = [1.0 if day.weekday() < 5 else 0.3 for day in past_days]
    slots: dict[tuple[date, int], list[tuple[tuple, bool]]] = {}
    for _ in range(cases - active):
        procedure = rng.choices(PROCEDURES, PROCEDURE_WEIGHTS)[0]
        key = (rng.choices(past_days, weights)[0], rng.randrange(len(leaves)))
        slots.setdefault(key, []).append((procedure, rng.random() < procedure[8]))
    schedule = []  # (leaf index, procedure, emergency, active, event plan)
    for (day, leaf_index), items in slots.items():
        items.sort(key=lambda item: item[1])  # elective list first, emergencies after it
        cursor = _ms(datetime(day.year, day.month, day.day, 8, 30, tzinfo=BANGKOK)) + _between(rng, -10, 20) * MINUTE
        for procedure, emergency in items:
            plan = _plan(rng, cursor, procedure)
            schedule.append((leaf_index, procedure, emergency, False, plan))
            cursor = plan["out"] + _between(rng, 20, 45 if not emergency else 120) * MINUTE
    for leaf_index in range(active):
        elapsed = _between(rng, 40, 210)
        procedure = rng.choice([item for item in PROCEDURES if item[6] >= 90])
        start = (now_ms - elapsed * MINUTE) // MINUTE * MINUTE
        plan = _plan(rng, start, procedure, now_ms + _between(rng, 20, 90) * MINUTE)
        schedule.append((leaf_index, procedure, False, True, plan))
    schedule.sort(key=lambda item: item[4]["in"])

    case_rows, archive = [], {"case": [], "context": [], "staff": [], "event": [], "form": [], "field": [], "report": []}
    used_hn: set[str] = set()
    sequence = {leaf: 0 for leaf in leaves}
    for leaf_index, procedure, emergency, is_active, plan in schedule:
        leaf_id = leaves[leaf_index]
        sequence[leaf_id] += 1
        case_id = sequence[leaf_id]
        start = plan["in"]
        when = _dt(start).astimezone(BANGKOK)
        patient = _patient(rng, procedure, used_hn, when)
        asa = _asa(rng, patient["age"], emergency)
        technique = procedure[7]
        end_ms = now_ms // MINUTE * MINUTE if is_active else plan["out"]
        episodes = _episodes(rng, plan)
        timeline = _vitals(rng, plan, end_ms, technique, patient, procedure[9], episodes)
        io = _io(rng, case_id, plan, end_ms, is_active, technique, procedure, patient, episodes)
        surgeon = rng.choice(SURGEONS[procedure[2]])
        anesthesiologist = rng.choice(ANESTHESIOLOGISTS)
        nurse_anesthetist = rng.choice(NURSE_ANESTHETISTS)
        scrub, circulating = rng.sample(OR_NURSES, 2)
        staff = [(anesthesiologist, "Anesthesiologist", "Anesthesia", plan["in"] + _between(rng, -10, 8) * MINUTE),
                 (nurse_anesthetist, "Nurse Anesthetist", "Anesthesia", plan["in"] + _between(rng, -15, 2) * MINUTE),
                 (surgeon, "Surgeon", "Surgery", plan["incision"] - _between(rng, 2, 15) * MINUTE),
                 (scrub, "Scrub Nurse", "Nursing", plan["in"] - _between(rng, 5, 20) * MINUTE),
                 (circulating, "Circulating Nurse", "Nursing", plan["in"] - _between(rng, 0, 15) * MINUTE)]
        case_code = f"{patient['hn']}_{when:%Y%m%d}_01"
        events = [(title, ts) for title, ts in _events(plan, technique) if ts is not None and ts <= end_ms]
        allergies = [{"id": 1, "allergen": "NKA", "reaction": None, "severity": None}]
        if rng.random() < 0.12:
            allergen, reaction, severity = rng.choice(ALLERGENS)
            allergies = [{"id": 1, "allergen": allergen, "reaction": reaction, "severity": severity}]
        discharge = None if is_active else plan["out"]
        window = {"from": plan["in"] // MINUTE * MINUTE, "to": end_ms + MINUTE}
        snapshot = {
            "case": {"hn": patient["hn"], "status": "ACTIVE" if is_active else "DISCHARGED", "case_id": case_id,
                     "case_code": case_code, "created_at": start - 5 * MINUTE, "start_time": start,
                     "discharge_time": discharge, "identity_status": "local", "admission_source": "demo"},
            "window": window,
            "patient": {"row": {
                "hn": patient["hn"], "an": patient["an"], "case_id": case_id, "source": "DEMO",
                "sex": patient["sex"], "dob": patient["dob"].isoformat(), "age_text": f"{patient['age']}y",
                "title_th": patient["title_th"], "first_name": patient["first_name"], "last_name": patient["last_name"],
                "patient_name": patient["patient_name"], "weight_kg": patient["weight_kg"],
                "height_cm": patient["height_cm"], "blood_group_text": patient["blood_group"],
                "asa_status": asa.rstrip("E"), "asa_emergency": asa.endswith("E"), "nationality": "ไทย",
                "his_payload": {"lab": _labs(rng, patient)}, "updated_at": start,
            }},
            "allergies": {"rows": allergies},
            "diagnosis": {"case_id": case_id, "rows": [{
                "id": 1, "diagnosis_text": procedure[3], "icd_text": procedure[3], "icd_code": procedure[4],
                "icd_version": "ICD-10", "seq": 1, "event_ts": start, "created_at": start}]},
            "procedures": {"case_id": case_id, "rows": [{
                "id": 1, "procedure_text": procedure[0], "icd_text": procedure[0], "icd_code": procedure[1],
                "icd_version": "ICD-9", "seq": 1, "event_ts": start, "created_at": start}]},
            "staff": {"case_id": case_id, "rows": [
                {"id": index, "name": name, "role": role, "seq": index}
                for index, (name, role, _, _) in enumerate(staff, 1)]},
            "forms": {"ok": True, "draft": None, "case_id": case_id, "updated_at": None},
            "events": {**window, "case_id": case_id, "rows": [
                {"id": index, "title": title, "detail": None, "event_ts": ts, "event_type": "event",
                 "created_at": ts, "created_by": "demo", "updated_at": ts, "updated_by": "demo"}
                for index, (title, ts) in enumerate(events, 1)]},
            "timeline": {**window, "rows": timeline},
            "vitals": {**window, "rows": [{"ts_minute": row["ts_minute"], "payload": row["payload"]} for row in timeline]},
            "io_runs": {**window, "case_id": case_id, "rows": io["runs"]},
            "io_events": {**window, "case_id": case_id, "rows": io["events"]},
            "io_summary": {**window, "rows": [], "totals": io["totals"]},
            "demo": True,
        }
        last_synced = now if is_active else _dt(plan["out"] + MINUTE)
        case_rows.append((
            uuid.uuid5(uuid.NAMESPACE_URL, f"flora:{hospital_id}:{leaf_id}:case:{case_id}"), hospital_id, leaf_id,
            str(case_id), case_code, patient["hn"], snapshot["case"]["status"], start, discharge,
            _ms(last_synced), Jsonb(snapshot), last_synced,
        ))

        archive_id = _uuid(rng)
        archive["case"].append((
            archive_id, DEMO_SOURCE, case_code, patient["hn"],
            Jsonb({"hn": patient["hn"], "name": patient["patient_name"], "sex": patient["sex"], "age": patient["age"]}),
            Jsonb({"name": procedure[0], "icd9": procedure[1], "service": procedure[2]}),
            _dt(plan["in"]), _dt(discharge), "complete" if discharge else "partial",
        ))
        bed_label = f"Demo OR {leaf_index + 1}"
        archive["context"].append((
            archive_id, patient["hn"], patient["an"], patient["patient_name"], patient["dob"], patient["sex"],
            f"ASA {asa}", procedure[1], procedure[0], procedure[4], procedure[3], procedure[2], DEMO_WARD_NAME, bed_label,
        ))
        for name, role, group, entered in staff:
            if entered <= end_ms:
                archive["staff"].append((_uuid(rng), archive_id, name, role, group, _dt(entered), _dt(discharge)))
        archive_events = [("In/Out OR", "1", plan["in"]), ("Anesthesia", "1", plan["anes"]),
                          ("Positioning", "1", plan["position"]), ("Surgery", "1", plan["incision"]),
                          ("Surgery", "2", plan["end_surgery"]), ("Anesthesia", "2", plan["anes_end"]),
                          ("In/Out OR", "2", plan["out"])]
        for name, state, ts in archive_events:
            if ts is not None and ts <= end_ms:
                archive["event"].append((_uuid(rng), archive_id, name, DEMO_WARD_NAME, state, _dt(ts)))
        pacu = None
        if not is_active and rng.random() < 0.88:
            pacu = "PACU (Ambulatory)" if technique == "mac" or (procedure[5] < 45 and rng.random() < 0.5) else "PACU"
            pacu_in = plan["out"] + _between(rng, 2, 6) * MINUTE
            pacu_out = pacu_in + _between(rng, 30, 95) * MINUTE
            archive["event"].append((_uuid(rng), archive_id, "In/Out PACU", "PACU", "1", _dt(pacu_in)))
            archive["event"].append((_uuid(rng), archive_id, "In/Out PACU", "PACU", "2", _dt(pacu_out)))
        anaesthesia_form = _uuid(rng)
        archive["form"].append((anaesthesia_form, archive_id, 1, 1, "Anesthesia Record", _dt(plan["in"]), _dt(end_ms)))
        for cell, (component, title, label) in enumerate(_form_fields(rng, technique, emergency), 1):
            archive["field"].append((_uuid(rng), anaesthesia_form, cell, component, 3, title, label,
                                     Jsonb({"selected": [{"label": label}]})))
        if pacu:
            pacu_form = _uuid(rng)
            archive["form"].append((pacu_form, archive_id, 2, 2, pacu, _dt(plan["out"]), _dt(plan["out"] + 30 * MINUTE)))
            aldrete = str(rng.choice([9, 9, 10]))
            archive["field"].append((_uuid(rng), pacu_form, 1, 9001, 3, "Aldrete score", aldrete, Jsonb({"text": aldrete})))
        expected = [("ANES", True), ("FORM", True), ("POST", rng.random() < 0.7), ("PACU", pacu is not None)]
        for report_type, is_expected in expected:
            if not is_expected:
                continue
            present = discharge is not None and rng.random() < 0.93
            archive["report"].append((
                archive_id, report_type, "demo generator",
                f"/ephis/demo/{when:%Y/%m}/{case_code}_{report_type}.pdf" if present else None,
                _dt(discharge + _between(rng, 5, 90) * MINUTE) if present else None,
                _between(rng, 80_000, 900_000) if present else None,
            ))

    with database.cursor() as cursor:
        cursor.executemany(
            """INSERT INTO sync_case_index(global_case_id,hospital_id,leaf_id,source_case_id,case_code,hn,status,
                 start_time,discharge_time,revision,snapshot,last_synced_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", case_rows)
        cursor.executemany(
            """INSERT INTO archive_case(id,source_system,source_case_id,patient_reference,patient_snapshot,
                 procedure_snapshot,started_at,completed_at,migration_status,mapping_profile)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'flora-demo')""", archive["case"])
        cursor.executemany(
            """INSERT INTO archive_case_context(archive_case_id,hn,encounter_number,patient_name,date_of_birth,gender,
                 asa_status,procedure_code,procedure_name,diagnosis_code,diagnosis_name,case_type,care_unit,location)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", archive["context"])
        cursor.executemany(
            """INSERT INTO archive_staff_assignment(id,archive_case_id,display_name,role,staff_group,entered_at,
                 exited_at,time_quality) VALUES (%s,%s,%s,%s,%s,%s,%s,'exact')""", archive["staff"])
        cursor.executemany(
            """INSERT INTO archive_event(id,archive_case_id,source_event_name,care_unit,source_state,occurred_at,
                 time_quality) VALUES (%s,%s,%s,%s,%s,%s,'exact')""", archive["event"])
        cursor.executemany(
            """INSERT INTO archive_form(id,archive_case_id,source_form_id,source_original_form_id,name,
                 source_created_at,source_updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s)""", archive["form"])
        cursor.executemany(
            """INSERT INTO archive_form_field(id,archive_form_id,source_grid_cell_id,source_component_id,
                 component_type,title,raw_value,value) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""", archive["field"])
        cursor.executemany(
            """INSERT INTO archive_case_report(archive_case_id,report_type,expected,evidence,file_path,
                 generated_at,file_size_bytes) VALUES (%s,%s,true,%s,%s,%s,%s)""", archive["report"])
    return {**status(database), "seed": seed, "elapsed_seconds": round(time.monotonic() - started, 2)}


def status(database: Connection) -> dict[str, Any]:
    ward = database.execute(
        """SELECT id::text AS key, name, created_at FROM canopy_location
           WHERE is_demo AND kind='care_unit' ORDER BY id LIMIT 1"""
    ).fetchone()
    counts = database.execute(
        """SELECT (SELECT count(*) FROM sync_leaf_node WHERE leaf_id LIKE %(leaf)s) AS leaves,
                  (SELECT count(*) FROM sync_case_index WHERE leaf_id LIKE %(leaf)s) AS cases,
                  (SELECT count(*) FROM sync_case_index WHERE leaf_id LIKE %(leaf)s AND upper(status)='ACTIVE') AS active_cases,
                  (SELECT count(*) FROM archive_case WHERE source_system=%(source)s) AS archive_cases,
                  (SELECT min(started_at) FROM archive_case WHERE source_system=%(source)s) AS first_case_at,
                  (SELECT max(started_at) FROM archive_case WHERE source_system=%(source)s) AS last_case_at""",
        {"leaf": "demo-%", "source": DEMO_SOURCE},
    ).fetchone()
    return {
        "exists": ward is not None,
        "ward": {"key": ward["key"], "name": ward["name"]} if ward else None,
        "created_at": ward["created_at"] if ward else None,
        **{key: int(counts[key]) for key in ("leaves", "cases", "active_cases", "archive_cases")},
        "first_case_at": counts["first_case_at"], "last_case_at": counts["last_case_at"],
    }
