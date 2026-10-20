"""Concepts: the named case data forms bind to (patient.hn, case.asa, anesthesia.start...) and that billing, reports, the
Canopy chart and the public API read, so none of them depends on the key a value happens to be stored under
(formdev/docs/LEAF-DYNAMIC-STANDALONE-ANALYSIS.md, phase 1).

The dictionary is the Leaf's (frontend/src/formdev/leaf/concepts.ts) and `case_values` is the twin of caseData.ts
`caseValues`: the same value and source for every concept, read from today's case (the record draft, the HIS patient
row, diagnosis / procedures / allergies / labs / events / staff). formdev/scripts/build_concept_fixtures.py writes
formdev/spec/fixtures/concepts.json from this module; tests on both sides check they agree. `draft_value` gives a
concept's value as the record draft keeps it today (a list stays a list) for consumers that need it unformatted.
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

HOSPITAL_TZ = ZoneInfo("Asia/Bangkok")

CONCEPTS: list[dict[str, Any]] = [
    {"key": "patient.hn", "th": "HN", "en": "HN", "kind": "text", "aliases": ["hn", "hospital_number", "mrn"]},
    {"key": "patient.an", "th": "AN", "en": "AN", "kind": "text", "aliases": ["an", "admission_number", "encounter_number"]},
    {"key": "patient.name", "th": "ชื่อ-นามสกุลผู้ป่วย", "en": "Patient name", "kind": "text", "aliases": ["patient_name", "name", "full_name", "patient_full_name"]},
    {"key": "patient.id_card", "th": "เลขบัตรประชาชน", "en": "ID card", "kind": "text", "aliases": ["id_card", "cid", "citizen_id", "national_id"]},
    {"key": "patient.dob", "th": "วันเกิด", "en": "Date of birth", "kind": "date", "aliases": ["dob", "date_of_birth", "birth_date"]},
    {"key": "patient.age_years", "th": "อายุ (ปี)", "en": "Age (years)", "kind": "number", "aliases": ["age", "age_years", "age_y"]},
    {"key": "patient.sex", "th": "เพศ", "en": "Sex", "kind": "text", "aliases": ["gender", "sex"]},
    {"key": "patient.weight_kg", "th": "น้ำหนัก (kg)", "en": "Weight (kg)", "kind": "number", "aliases": ["weight", "weight_kg", "wt", "body_weight"]},
    {"key": "patient.height_cm", "th": "ส่วนสูง (cm)", "en": "Height (cm)", "kind": "number", "aliases": ["height", "height_cm", "ht"]},
    {"key": "patient.blood_group", "th": "หมู่เลือด", "en": "Blood group", "kind": "text", "aliases": ["blood_type", "blood_group", "blood_group_abo"]},
    {"key": "patient.allergy", "th": "ประวัติแพ้", "en": "Allergy", "kind": "text", "aliases": ["allergy", "allergies", "drug_allergy"]},
    {"key": "case.asa", "th": "ASA", "en": "ASA", "kind": "text", "aliases": ["asa_status", "asa", "asa_class"]},
    {"key": "case.diagnosis", "th": "การวินิจฉัย", "en": "Diagnosis", "kind": "text", "aliases": ["post_op_dx", "diagnosis", "pre_op_dx", "dx"]},
    {"key": "case.operation", "th": "การผ่าตัด / หัตถการ", "en": "Operation", "kind": "text", "aliases": ["operation", "procedure", "operation_name"]},
    {"key": "case.room", "th": "ห้องผ่าตัด", "en": "Room", "kind": "text", "aliases": ["room", "or_room", "theatre"]},
    {"key": "case.ward", "th": "หอผู้ป่วย / หน่วยงาน", "en": "Ward / unit", "kind": "text", "aliases": ["ward", "care_unit", "unit"]},
    {"key": "case.date", "th": "วันที่ผ่าตัด", "en": "Operation date", "kind": "date", "aliases": ["op_date", "operation_date", "date", "case_date"]},
    {"key": "case.admit_date", "th": "วันที่รับไว้ในโรงพยาบาล", "en": "Admission date", "kind": "date", "aliases": ["admit_date", "admission_date"]},
    {"key": "case.type", "th": "ประเภทเคส", "en": "Case type", "kind": "text", "aliases": ["case_type", "priority", "surgical_priority"]},
    {"key": "anesthesia.technique", "th": "เทคนิคระงับความรู้สึก", "en": "Anesthesia technique", "kind": "text", "aliases": ["anesthesia_technique", "technique", "anesthesia_type"]},
    {"key": "anesthesia.start", "th": "เวลาเริ่มให้ยาระงับความรู้สึก", "en": "Anesthesia start", "kind": "time", "aliases": ["anesthesia_start", "start_anesthesia"]},
    {"key": "anesthesia.end", "th": "เวลาสิ้นสุดการให้ยาระงับความรู้สึก", "en": "Anesthesia end", "kind": "time", "aliases": ["anesthesia_end", "end_anesthesia"]},
    {"key": "anesthesia.time", "th": "ช่วงเวลาให้ยาระงับความรู้สึก", "en": "Anesthesia time", "kind": "text", "aliases": ["anesthesia_time"]},
    {"key": "surgery.start", "th": "เวลาเริ่มผ่าตัด", "en": "Surgery start", "kind": "time", "aliases": ["surgery_start", "start_surgery", "incision_time"]},
    {"key": "surgery.end", "th": "เวลาสิ้นสุดการผ่าตัด", "en": "Surgery end", "kind": "time", "aliases": ["surgery_end", "end_surgery"]},
    {"key": "surgery.duration", "th": "ช่วงเวลาผ่าตัด", "en": "Surgery duration", "kind": "text", "aliases": ["surgery_duration", "operation_duration"]},
    {"key": "staff.anesthesiologist", "th": "วิสัญญีแพทย์", "en": "Anesthesiologist", "kind": "text", "aliases": ["anesthesiologist", "anesthesiologist_name"]},
    {"key": "staff.surgeon", "th": "ศัลยแพทย์", "en": "Surgeon", "kind": "text", "aliases": ["surgeon", "surgeon_name"]},
    {"key": "staff.nurse", "th": "พยาบาลวิสัญญี", "en": "Anesthesia nurse", "kind": "text", "aliases": ["anesthesia_nurse", "nurse_anesthetist"]},
    {"key": "pacu.arrival", "th": "เวลาเข้า PACU", "en": "PACU arrival", "kind": "time", "aliases": ["recovery_start", "pacu_arrival", "pacu_in"]},
    {"key": "pacu.discharge", "th": "เวลาออกจาก PACU", "en": "PACU discharge", "kind": "time", "aliases": ["recovery_end", "pacu_discharge", "pacu_out"]},
    {"key": "pacu.destination", "th": "ส่งต่อไปที่", "en": "Discharge location", "kind": "text", "aliases": ["discharge_location", "destination", "postoperative_destination"]},
    {"key": "lab.hb", "th": "Hb", "en": "Hb", "kind": "number", "aliases": ["hb", "hemoglobin"]},
    {"key": "lab.hct", "th": "Hct", "en": "Hct", "kind": "number", "aliases": ["hct", "hematocrit"]},
    {"key": "lab.wbc", "th": "WBC", "en": "WBC", "kind": "number", "aliases": ["wbc"]},
    {"key": "lab.plt", "th": "Platelet", "en": "Platelet", "kind": "number", "aliases": ["plt", "platelet"]},
]
CONCEPT_BY_KEY = {concept["key"]: concept for concept in CONCEPTS}

# Where the record draft (case_detail.form_draft_json, the snapshot's forms.draft) keeps each concept today. When the
# record moves to Form Studio, only this map (and caseData.ts) changes; consumers keep asking for the concept.
DRAFT_KEYS: dict[str, str] = {
    "patient.hn": "hn", "patient.an": "an", "patient.id_card": "idCard", "patient.dob": "dob", "patient.age_years": "ageY",
    "patient.sex": "sex", "patient.weight_kg": "weightKg", "patient.height_cm": "heightCm", "case.asa": "asa",
    "case.diagnosis": "diagnosis", "case.operation": "operation", "case.type": "emergency",
    "anesthesia.technique": "anesthesiaTypes", "pacu.arrival": "pacuArrivalTime", "pacu.discharge": "pacuDischargeTime",
    "pacu.destination": "postoperativeDestination",
}


def draft_value(draft: dict[str, Any] | None, key: str) -> Any:
    """A concept's value as the record draft keeps it (None when the draft has no place for it)."""
    return (draft or {}).get(DRAFT_KEYS[key]) if key in DRAFT_KEYS else None


# ---------------------------------------------------------------- the twin of caseData.ts (same rules, same order)

def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return str(int(value)) if float(value).is_integer() else repr(float(value))
    return ""


def _list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in (_text(entry) for entry in value) if item]
    return [_text(value)] if _text(value) else []


NUMBER_PREFIX = re.compile(r"^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?")


def _number(value: Any) -> float | int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value if math.isfinite(value) else None
    match = NUMBER_PREFIX.match(_text(value).replace(",", ".", 1))  # as JavaScript's parseFloat
    if not match:
        return None
    parsed = float(match.group(0))
    return int(parsed) if parsed.is_integer() else parsed


def _local(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, HOSPITAL_TZ)


def _iso_date(ms: float) -> str:
    return _local(ms).strftime("%Y-%m-%d")


def _clock(ms: float) -> str:
    return _local(ms).strftime("%H:%M")


def _span(start: float, end: float) -> str:
    minutes = max(0, round((end - start) / 60_000))
    return f"{_clock(start)} - {_clock(end)} ({minutes // 60:02d}:{minutes % 60:02d})"


def to_iso_date(value: Any) -> str | None:
    """DD/MM/YYYY (Thai Buddhist years above 2400 converted), YYYY-MM-DD or an ISO date-time → YYYY-MM-DD."""
    raw = _text(value)
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    match = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", raw)
    if not match:
        return None
    year = int(match.group(3)) - 543 if int(match.group(3)) > 2400 else int(match.group(3))
    return f"{year}-{int(match.group(2)):02d}-{int(match.group(1)):02d}"


def _age_years(dob: str, at: float) -> int | None:
    year, month, day = (int(part) for part in dob.split("-"))
    when = _local(at)
    if not year:
        return None
    age = when.year - year - (1 if (when.month, when.day) < (month, day) else 0)
    return age if 0 <= age < 150 else None


def _token(title: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", _text(title).lower())


MILESTONES = {
    "startAne": ["startane", "startanes", "startanesthesia", "startanaesthesia", "sa"],
    "endAne": ["endane", "endanes", "endanesthesia", "endanaesthesia", "ea"],
    "startSurg": ["startsurg", "startsurgery", "ss"],
    "endSurg": ["endsurg", "endsurgery", "es"],
}


def _milestones(events: list[dict[str, Any]]) -> dict[str, float]:
    """Starts: the first matching event; ends: the last (as billing)."""
    timed = []
    for event in events:
        if event.get("event_type") not in (None, "event"):
            continue
        ts = _number(event.get("event_ts"))
        if ts is not None:
            timed.append((ts, _token(event.get("title"))))
    timed.sort(key=lambda item: item[0])
    out = {}
    for name, tokens in MILESTONES.items():
        hits = [ts for ts, key in timed if key in tokens]
        if hits:
            out[name] = hits[0] if name.startswith("start") else hits[-1]
    return out


STAFF_ROLES = {
    "staff.anesthesiologist": re.compile(r"^(anesthetist|fellowanesthetist|anesthetistresident|anesthesiologist)$"),
    "staff.surgeon": re.compile(r"^surgeon$"),
    "staff.nurse": re.compile(r"^(nurseanesthetist|anesthesianurse)$"),
}
LABS = {"lab.hb": re.compile(r"^(hb|hgb|hemoglobin|haemoglobin)$"), "lab.hct": re.compile(r"^(hct|hematocrit|haematocrit)$"),
        "lab.wbc": re.compile(r"^(wbc|whitebloodcell)"), "lab.plt": re.compile(r"^(plt|platelet)")}


def _full_name(title: Any, first: Any, last: Any) -> str:
    """"นายสมชาย ใจดี": a Thai title is written against the first name; other titles take a space."""
    given = " ".join(part for part in (_text(first), _text(last)) if part)
    if not given:
        return ""
    prefix = _text(title)
    return f"{prefix}{'' if re.search(r'[ก-๙.]$', prefix) else ' '}{given}" if prefix else given


def _with(main: Any, detail: Any) -> str:
    """"Penicillin (rash)", "Appendicitis (K35.8)": the detail in brackets when there is one."""
    return f"{_text(main)} ({_text(detail)})" if _text(detail) else _text(main)


def _blood_group(abo: Any, rh: Any) -> str:
    group = _text(abo).upper()
    if not group:
        return ""
    sign = _text(rh).lower()
    return f"{group}{'-' if re.search(r'-|neg', sign) else '+' if sign else ''}"


def case_values(head: dict[str, Any], loaded: dict[str, Any], now_ms: float) -> dict[str, dict[str, Any]]:
    """{concept: {value, source}} of a case, as caseData.ts caseValues gives them (first source with a value wins)."""
    out: dict[str, dict[str, Any]] = {}

    def put(key: str, value: Any, source: str) -> None:
        if key in out or value is None or value == "":
            return
        out[key] = {"value": value, "source": source}

    draft = loaded.get("draft") or {}
    patient = loaded.get("patient") or {}
    rows = {name: [row for row in loaded.get(name) or [] if isinstance(row, dict)]
            for name in ("diagnosis", "procedures", "allergies", "labs", "events", "staff")}
    at = head["startTime"] if head.get("startTime") is not None else now_ms

    put("patient.hn", _text(head.get("hn")) or _text(patient.get("hn")) or _text(draft.get("hn")), "เคส / Case")
    put("patient.an", _text(draft.get("an")), "บันทึก / Record")
    put("patient.an", _text(patient.get("an")) or _text(head.get("admissionNumber")), "HIS")
    put("patient.name", _full_name(draft.get("titleTh"), draft.get("firstName"), draft.get("lastName")), "บันทึก / Record")
    put("patient.name", _text(patient.get("patient_name")) or _full_name(patient.get("title_th"), patient.get("first_name"), patient.get("last_name")), "HIS")
    put("patient.id_card", _text(draft.get("idCard")), "บันทึก / Record")
    dob = to_iso_date(draft.get("dob")) or to_iso_date(patient.get("dob"))
    put("patient.dob", dob, "บันทึก / Record" if to_iso_date(draft.get("dob")) else "HIS")
    put("patient.age_years", _number(draft.get("ageY")), "บันทึก / Record")
    put("patient.age_years", _number(patient.get("age_text")), "HIS")
    put("patient.age_years", _age_years(dob, at) if dob else None, "คำนวณจากวันเกิด / From DOB")
    put("patient.sex", _text(draft.get("sex")), "บันทึก / Record")
    put("patient.sex", _text(patient.get("sex")), "HIS")
    put("patient.weight_kg", _number(draft.get("weightKg")), "บันทึก / Record")
    put("patient.weight_kg", _number(patient.get("weight_kg")), "HIS")
    put("patient.height_cm", _number(draft.get("heightCm")), "บันทึก / Record")
    put("patient.height_cm", _number(patient.get("height_cm")), "HIS")
    put("patient.blood_group", _blood_group(draft.get("bloodGroupABO"), draft.get("bloodGroupRh")), "บันทึก / Record")
    put("patient.blood_group", _blood_group(patient.get("blood_group_abo"), patient.get("blood_group_rh")) or _text(patient.get("blood_group_text")), "HIS")
    allergies = [row for row in rows["allergies"] if not re.match(r"^(nka|nkda|none|ไม่มี)", _text(row.get("allergen")), re.I)]
    if allergies:
        put("patient.allergy", ", ".join(_with(row.get("allergen"), row.get("reaction")) for row in allergies), "ประวัติแพ้ / Allergies")
    elif rows["allergies"]:
        put("patient.allergy", "NKA", "ประวัติแพ้ / Allergies")

    asa = _text(draft.get("asa"))
    if asa:
        put("case.asa", f"{asa}{'E' if draft.get('emergency') is True or draft.get('emergency') == 'true' else ''}", "บันทึก / Record")
    if _text(patient.get("asa_status")):
        put("case.asa", f"{_text(patient.get('asa_status'))}{'E' if patient.get('asa_emergency') is True else ''}", "รับผู้ป่วย / Admission")
    put("case.diagnosis", "; ".join(item for item in (_with(row.get("diagnosis_text"), row.get("icd_code")) for row in rows["diagnosis"]) if item),
        "การวินิจฉัย / Diagnosis")
    put("case.diagnosis", "; ".join(_list(draft.get("diagnosis"))), "บันทึก / Record")
    put("case.operation", "; ".join(item for item in (_text(row.get("procedure_text")) for row in rows["procedures"]) if item), "หัตถการ / Procedures")
    put("case.operation", "; ".join(_list(draft.get("operation"))), "บันทึก / Record")
    workstation = loaded.get("workstation") or {}
    put("case.room", _text(workstation.get("roomName")), "เครื่องนี้ / Workstation")
    put("case.ward", _text(workstation.get("careUnitName")), "เครื่องนี้ / Workstation")
    if head.get("startTime"):
        put("case.date", _iso_date(head["startTime"]), "เคส / Case")
    admitted = _number(patient.get("pre_admit_at"))
    put("case.admit_date", to_iso_date(patient.get("pre_admit_at")) or (_iso_date(admitted) if admitted else None), "HIS")
    if isinstance(draft.get("emergency"), bool):
        put("case.type", "Emergency" if draft["emergency"] else "Elective", "บันทึก / Record")
    put("anesthesia.technique", ", ".join(_list(draft.get("anesthesiaTypes"))), "บันทึก / Record")

    times = _milestones(rows["events"])
    if times.get("startAne"):
        put("anesthesia.start", _clock(times["startAne"]), "เหตุการณ์ / Events")
    if times.get("endAne"):
        put("anesthesia.end", _clock(times["endAne"]), "เหตุการณ์ / Events")
    if times.get("startAne") and times.get("endAne"):
        put("anesthesia.time", _span(times["startAne"], times["endAne"]), "เหตุการณ์ / Events")
    if times.get("startSurg"):
        put("surgery.start", _clock(times["startSurg"]), "เหตุการณ์ / Events")
    if times.get("endSurg"):
        put("surgery.end", _clock(times["endSurg"]), "เหตุการณ์ / Events")
    if times.get("startSurg") and times.get("endSurg"):
        put("surgery.duration", _span(times["startSurg"], times["endSurg"]), "เหตุการณ์ / Events")

    for key, pattern in STAFF_ROLES.items():
        names = [_text(member.get("name")) for member in rows["staff"]
                 if pattern.search(_token(member.get("role_id")) or _token(member.get("role")))]
        if any(names):
            put(key, ", ".join(name for name in names if name), "ทีม / Staff")

    def hhmm(value: Any) -> str | None:
        raw = _text(value)
        return raw.replace(".", ":", 1).rjust(5, "0") if re.match(r"^\d{1,2}[:.]\d{2}$", raw) else None

    put("pacu.arrival", hhmm(draft.get("pacuArrivalTime")), "บันทึก / Record")
    put("pacu.discharge", hhmm(draft.get("pacuDischargeTime")), "บันทึก / Record")
    put("pacu.destination", _text(draft.get("postoperativeDestination")), "บันทึก / Record")
    for key, pattern in LABS.items():
        row = next((lab for lab in rows["labs"] if pattern.search(_token(lab.get("test_name")))), None)
        if row is not None:
            value = _number(row.get("value_text"))
            put(key, value if value is not None else _text(row.get("value_text")), "Lab")
    return out


def _rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        value = value.get("rows")
    return [row for row in value or [] if isinstance(row, dict)] if isinstance(value, list) else []


def from_snapshot(snapshot: dict[str, Any], now_ms: float) -> dict[str, dict[str, Any]]:
    """The concepts of a case as Canopy holds it (the Leaf's case snapshot)."""
    case = snapshot.get("case") if isinstance(snapshot.get("case"), dict) else {}
    forms = snapshot.get("forms") if isinstance(snapshot.get("forms"), dict) else {}
    patient = snapshot.get("patient") if isinstance(snapshot.get("patient"), dict) else {}
    head = {"caseId": case.get("case_id"), "hn": case.get("hn"), "admissionNumber": None,
            "startTime": case.get("start_time"), "dischargeTime": case.get("discharge_time")}
    loaded = {"draft": forms.get("draft") if isinstance(forms.get("draft"), dict) else {},
              "patient": patient.get("row") if isinstance(patient.get("row"), dict) else {},
              **{name: _rows(snapshot.get(name)) for name in ("diagnosis", "procedures", "allergies", "labs", "events", "staff")},
              "workstation": None}
    return case_values(head, loaded, now_ms)
