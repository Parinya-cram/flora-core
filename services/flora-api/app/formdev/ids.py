"""The variable-name standard of Form Studio: one way to name every field, so a form's data reads the same everywhere
(formulas, conditions, reports, the public API, Flora Leaf). See formdev/docs/FORM-STUDIO-V2.md §3.

A field's key (its variable name; the id is the same for new fields) is lower snake_case, English, and says what the
value is, never what kind of input holds it:

1. A field bound to case data (bind) is named after the concept: patient.weight_kg → patient_weight_kg.
2. Otherwise from its English label (label_en, or the English half of "น้ำหนัก / Weight"): "Pain score" → pain_score.
3. Otherwise from its Thai label: medical form words through TERMS, other words romanised (Royin):
   "คะแนนความปวด" → pain_score, "ผู้ประเมิน" → assessor.
4. A name that alone says little (date, time, note, other...) or that Flora Leaf would read as case data without a
   bind (an alias of concepts.py: hn, name, date...) gets the section's name in front: consent_date, nurse_name.
5. Unique in its scope: _2, _3... only when the same name is taken.

check() lists what breaks the standard in a definition, each with the name it should have.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import Any, Iterable

from .definition import ITEM_ID

MAX_KEY = 40
THAI = re.compile(r"[฀-๿]")

# Thai words of medical and administrative forms → English name parts. A value starting with "@" is a concept of
# app/concepts.py: the field means that case datum, so it is suggested as a bind as well.
TERMS: dict[str, str] = {
    # patient and case (concepts)
    "เลขประจำตัวผู้ป่วย": "@patient.hn", "เลขที่โรงพยาบาล": "@patient.hn", "เลขที่ผู้ป่วยใน": "@patient.an",
    "ชื่อ-นามสกุล": "@patient.name", "ชื่อนามสกุล": "@patient.name", "ชื่อผู้ป่วย": "@patient.name",
    "เลขบัตรประชาชน": "@patient.id_card", "เลขประจำตัวประชาชน": "@patient.id_card", "วันเกิด": "@patient.dob",
    "วันเดือนปีเกิด": "@patient.dob", "น้ำหนัก": "@patient.weight_kg", "น้ำหนักตัว": "@patient.weight_kg", "ส่วนสูง": "@patient.height_cm",
    "หมู่เลือด": "@patient.blood_group", "กรุ๊ปเลือด": "@patient.blood_group", "ประวัติแพ้ยา": "@patient.allergy",
    "ประวัติการแพ้": "@patient.allergy", "การวินิจฉัย": "@case.diagnosis", "วินิจฉัย": "@case.diagnosis",
    "การผ่าตัด": "@case.operation", "หัตถการ": "@case.operation", "ชื่อการผ่าตัด": "@case.operation",
    "ห้องผ่าตัด": "@case.room", "หอผู้ป่วย": "@case.ward", "วันที่ผ่าตัด": "@case.date", "วันที่รับไว้": "@case.admit_date",
    "วิสัญญีแพทย์": "@staff.anesthesiologist", "ศัลยแพทย์": "@staff.surgeon", "พยาบาลวิสัญญี": "@staff.nurse",
    "เทคนิคการระงับความรู้สึก": "@anesthesia.technique", "ชนิดการระงับความรู้สึก": "@anesthesia.technique",
    # people
    "ผู้ป่วย": "patient", "ญาติ": "relative", "ผู้ติดต่อ": "contact", "ความสัมพันธ์": "relationship", "พยาน": "witness",
    "ผู้ให้ข้อมูล": "informant", "ผู้ประเมิน": "assessor", "ผู้บันทึก": "recorder", "ผู้รับผิดชอบ": "responsible",
    "พยาบาล": "nurse", "แพทย์": "doctor", "เภสัชกร": "pharmacist", "ผู้ช่วย": "assistant",
    # identity and contact
    "ชื่อ": "name", "นามสกุล": "surname", "คำนำหน้า": "title", "อายุ": "age", "เพศ": "sex", "ชาย": "male", "หญิง": "female",
    "ที่อยู่": "address", "โทรศัพท์": "phone", "เบอร์โทร": "phone", "เบอร์โทรศัพท์": "phone", "ศาสนา": "religion",
    "สัญชาติ": "nationality", "เชื้อชาติ": "ethnicity", "อาชีพ": "occupation", "สถานภาพ": "marital_status",
    "สิทธิการรักษา": "coverage", "สิทธิ์การรักษา": "coverage", "อีเมล": "email",
    # time
    "วันที่": "date", "เวลา": "time", "วัน": "day", "เดือน": "month", "ปี": "year", "ชั่วโมง": "hour", "นาที": "minute",
    "เริ่ม": "start", "สิ้นสุด": "end", "เข้า": "in", "ออก": "out", "ก่อน": "before", "หลัง": "after",
    "ก่อนผ่าตัด": "preop", "ระหว่างผ่าตัด": "intraop", "หลังผ่าตัด": "postop",
    # vital signs and measurements
    "สัญญาณชีพ": "vital_signs", "ความดันโลหิต": "blood_pressure", "ความดัน": "pressure", "ชีพจร": "pulse",
    "อัตราการเต้นของหัวใจ": "heart_rate", "อัตราการหายใจ": "respiratory_rate", "การหายใจ": "breathing",
    "อุณหภูมิ": "temperature", "ออกซิเจน": "oxygen", "ความอิ่มตัวของออกซิเจน": "spo2", "ระดับน้ำตาล": "blood_sugar",
    "น้ำตาลในเลือด": "blood_sugar", "ดัชนีมวลกาย": "bmi", "รอบเอว": "waist", "ความปวด": "pain", "ระดับความปวด": "pain_score",
    "คะแนนความปวด": "pain_score", "ความรู้สึกตัว": "consciousness", "ระดับความรู้สึกตัว": "consciousness_level",
    "ทางเดินหายใจ": "airway", "ท่อช่วยหายใจ": "endotracheal_tube", "ใส่ท่อช่วยหายใจ": "intubation",
    # clinical
    "ประวัติ": "history", "โรคประจำตัว": "underlying_disease", "อาการ": "symptom", "อาการสำคัญ": "chief_complaint",
    "การตรวจร่างกาย": "physical_exam", "ตรวจร่างกาย": "physical_exam", "การประเมิน": "assessment", "ประเมิน": "assessment",
    "แพ้": "allergy", "การแพ้": "allergy", "ยา": "medication", "ยาที่ใช้": "medications", "ขนาดยา": "dose", "ขนาด": "size",
    "วิธีให้": "route", "ความถี่": "frequency", "ยาระงับความรู้สึก": "anesthetic", "การระงับความรู้สึก": "anesthesia",
    "ผลตรวจ": "test_result", "ผลการตรวจ": "test_result", "ผลแล็บ": "lab_result", "ผล": "result", "เลือด": "blood",
    "การเสียเลือด": "blood_loss", "ปัสสาวะ": "urine", "สารน้ำ": "fluid", "ปริมาณ": "amount", "แผนการรักษา": "treatment_plan",
    "การพยาบาล": "nursing", "ปัญหา": "problem", "เป้าหมาย": "goal", "กิจกรรม": "activity", "ผลลัพธ์": "outcome",
    "ความเสี่ยง": "risk", "การพลัดตกหกล้ม": "fall_risk", "พลัดตกหกล้ม": "fall_risk", "แผลกดทับ": "pressure_ulcer",
    "การจำหน่าย": "discharge", "จำหน่าย": "discharge", "ส่งต่อ": "refer", "ปลายทาง": "destination", "ตำแหน่ง": "site",
    "ซ้าย": "left", "ขวา": "right", "บน": "upper", "ล่าง": "lower", "สี": "color", "ระดับ": "level", "คะแนน": "score",
    "ชนิด": "type", "ประเภท": "type", "วิธี": "method", "สาเหตุ": "cause", "ระยะเวลา": "duration",
    # document words
    "ลงชื่อ": "signature", "ลายมือชื่อ": "signature", "ลายเซ็น": "signature", "ยินยอม": "consent", "ใบยินยอม": "consent",
    "หมายเหตุ": "note", "อื่นๆ": "other", "อื่น": "other", "ระบุ": "specify", "รายละเอียด": "detail", "มี": "yes",
    "ไม่มี": "no", "ใช่": "yes", "ไม่ใช่": "no", "ปกติ": "normal", "ผิดปกติ": "abnormal", "ลำดับ": "no", "รายการ": "item",
    "หมายเลข": "number", "เลขที่": "number", "รหัส": "code", "จำนวน": "quantity", "หน่วย": "unit", "ราคา": "price", "รวม": "total",
}
# Words that join others and name nothing on their own.
FILLER = {"ของ", "ที่", "และ", "หรือ", "ใน", "จาก", "ให้", "แก่", "โดย", "กับ", "ตาม", "เป็น", "ได้", "การ", "ความ", "ครั้ง", "ต่อ", "เพื่อ", "ว่า"}
# Names that say too little alone: they get the section's name in front.
GENERIC = {"date", "time", "datetime", "day", "month", "year", "name", "note", "notes", "other", "result", "status", "type",
           "value", "text", "number", "remark", "detail", "score", "comment", "item", "field", "sign", "signature", "level",
           "amount", "quantity", "code", "specify", "yes", "no", "start", "end", "title", "unit", "total", "method", "site"}
# Names the designer gives by field type (text, text_2...): they say nothing about the value.
TYPE_NAMES = {"text", "textarea", "number", "decimal", "integer", "date", "datetime", "time", "select", "radio", "multiselect",
              "checkbox", "switch", "file", "image", "signature", "calculated", "group", "repeat", "matrix", "timeline", "logo",
              "barcode", "heading", "paragraph", "divider", "note", "choices", "check", "yes_no", "result", "item", "field"}


def snake(text: str) -> str:
    """ASCII words → lower snake_case that starts with a letter, at most MAX_KEY characters ("" if nothing is left)."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    words = re.findall(r"[A-Z]+\d*(?![a-z])|[A-Z]?[a-z]+\d*|\d+", ascii_text)
    key = "_".join(word.lower() for word in words)
    key = re.sub(r"_+", "_", key).strip("_")
    key = re.sub(r"^[^a-z]+", "", key)
    return key[:MAX_KEY].rstrip("_")


def concept_key(concept: str) -> str:
    return concept.replace(".", "_")


def english_part(label: str, label_en: str | None) -> str:
    """The label's English: label_en, the English half of "ไทย / English", or the label itself when it has no Thai."""
    if label_en and label_en.strip():
        return label_en
    halves = re.match(r"^(.*[฀-๿].*?)\s+/\s+([^฀-๿]*[A-Za-z][^฀-๿]*)$", label.strip())
    if halves:
        return halves.group(2)
    return "" if THAI.search(label) else label


@lru_cache(maxsize=1)
def _tokenizer() -> Any:
    from pythainlp.corpus import thai_words
    from pythainlp.tokenize import Tokenizer

    return Tokenizer(custom_dict=set(thai_words()) | set(TERMS), engine="newmm")


# Labels that name case data only when they are the whole label: "อายุ" is the patient's age, "อายุครรภ์" is not.
WHOLE_TERMS = {"อายุ": "patient.age_years", "อายุปี": "patient.age_years", "ชื่อ-สกุล": "patient.name", "ชื่อสกุล": "patient.name",
               "ชื่อ-สกุลผู้ป่วย": "patient.name", "ชื่อ-นามสกุลผู้ป่วย": "patient.name"}


def thai_name(label: str) -> tuple[str, str | None]:
    """A Thai label → (English name parts, a concept it names or None)."""
    from pythainlp.transliterate import romanize

    text = re.sub(r"\(.*?\)|[:：*]", " ", label)
    whole = re.sub(r"\s+", "", text)
    if whole in WHOLE_TERMS:
        return concept_key(WHOLE_TERMS[whole]), WHOLE_TERMS[whole]
    if TERMS.get(whole, "").startswith("@"):
        return concept_key(TERMS[whole][1:]), TERMS[whole][1:]
    parts: list[str] = []
    concept = None
    for token in _tokenizer().word_tokenize(text):
        token = token.strip()
        if not token or token in FILLER:
            continue
        mapped = TERMS.get(token)
        if mapped and mapped.startswith("@"):
            concept = concept or mapped[1:]
            parts.append(concept_key(mapped[1:]).split("_", 1)[-1])
        elif mapped:
            parts.append(mapped)
        elif THAI.search(token):
            parts.append(romanize(token, engine="royin"))
        else:
            parts.append(token)
    # A part said again inside a later one adds nothing: "risk" before "fall_risk".
    kept = [part for index, part in enumerate(parts) if not any(set(part.split("_")) <= set(later.split("_")) and part != later
                                                                  for later in parts[index + 1:])]
    return snake(" ".join(dict.fromkeys(kept))), concept


def _section_prefix(section: str | None) -> str:
    if not section:
        return ""
    return snake(section).split("_")[0] if snake(section) else ""


@lru_cache(maxsize=1)
def _alias_concepts() -> dict[str, str]:
    from .. import concepts

    return {alias: concept["key"] for concept in concepts.CONCEPTS for alias in concept["aliases"]}


@lru_cache(maxsize=1)
def _aliases() -> set[str]:
    from .. import concepts

    return {alias for concept in concepts.CONCEPTS for alias in concept["aliases"]}


def suggest(label: str, label_en: str | None = None, bind: str | None = None, field_type: str | None = None,
            section: str | None = None, taken: Iterable[str] = ()) -> dict[str, Any]:
    """{key, concept, how} for a field: how it was named (bind, english, thai, type)."""
    concept = bind
    how = "bind"
    thai_concept = thai_name(label)[1] if not bind and THAI.search(label) else None
    if bind:
        key = concept_key(bind)
    elif thai_concept:
        # The Thai label names case data (น้ำหนัก, ประวัติแพ้ยา): its concept wins over a free English wording.
        concept, key, how = thai_concept, concept_key(thai_concept), "thai"
    else:
        key = snake(english_part(label, label_en))
        how = "english"
        if key in _alias_concepts() and key not in GENERIC:
            concept = _alias_concepts()[key]  # "HN", "Weight": the case datum of that usual name
            key = concept_key(concept)
        if not key and THAI.search(label):
            key, concept = thai_name(label)
            how = "thai"
            if concept:
                key = concept_key(concept)
        if not key:
            key, how = (field_type or "field"), "type"
        if not concept and (key in GENERIC or key in _aliases() or how == "type"):
            prefix = _section_prefix(section)
            if prefix and not key.startswith(prefix + "_") and prefix != key:
                key = f"{prefix}_{key}"
    key = key[:MAX_KEY].rstrip("_") or "field"
    if not ITEM_ID.match(key):
        key = f"field_{key}"[:MAX_KEY]
    used = set(taken)
    unique, number = key, 2
    while unique in used:
        unique = f"{key[:MAX_KEY - len(str(number)) - 1]}_{number}"
        number += 1
    # concept: a case datum the label names, offered as a bind (None when the field is bound already).
    return {"key": unique, "concept": None if bind else concept, "how": how}


# ---------------------------------------------------------------- checking a definition

def _fields(fields: list[dict[str, Any]], section: str, scope: str) -> Iterable[tuple[dict[str, Any], str, str]]:
    for field in fields or []:
        if not isinstance(field, dict):
            continue
        yield field, section, scope
        if field.get("type") == "repeat":
            yield from _fields(field.get("fields") or [], section, f"{scope}{field.get('key') or field.get('id')}.")
        elif field.get("type") == "group":
            yield from _fields(field.get("fields") or [], section, scope)


def _sections(sections: list[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for section in sections or []:
        if isinstance(section, dict):
            yield section
            yield from _sections(section.get("sections") or [])


def check(definition: dict[str, Any]) -> list[dict[str, Any]]:
    """What breaks the standard: [{path, id, key, problem, message, suggestion, concept}] (empty: all named well)."""
    from .field_types import has_value

    findings: list[dict[str, Any]] = []
    taken_by_scope: dict[str, set[str]] = {}
    entries = []
    for section in _sections(definition.get("sections") or []):
        lists = [section.get("fields") or []] + [category.get("fields") or [] for category in section.get("categories") or [] if isinstance(category, dict)]
        for fields in lists:
            for field, _, scope in _fields(fields, section.get("title_en") or section.get("id") or "", ""):
                entries.append((field, section, scope))
                taken_by_scope.setdefault(scope, set()).add(field.get("key") or field.get("id"))
    for field, section, scope in entries:
        if not has_value(field.get("type")):
            continue
        key = field.get("key") or field.get("id") or ""
        label = str(field.get("label") or "")
        problems = []
        base = re.sub(r"_\d+$", "", key)
        if base in TYPE_NAMES:
            problems.append(("named_by_type", f"'{key}' names the kind of input, not the value"))
        if not field.get("bind") and key in _aliases():
            problems.append(("reads_as_case_data", f"'{key}' is read as case data on Flora Leaf without a bind"))
        if field.get("key") and field.get("id") != field.get("key"):
            problems.append(("id_differs", f"id '{field.get('id')}' differs from the variable name '{key}'"))
        if THAI.search(label) and not english_part(label, field.get("label_en")):
            problems.append(("no_english", "the label has no English (label_en)"))
        if not problems:
            continue
        others = taken_by_scope.get(scope, set()) - {key}
        suggestion = suggest(label, field.get("label_en"), field.get("bind"), field.get("type"), section.get("title_en") or section.get("id"), others)
        for code, message in problems:
            findings.append({"id": field.get("id"), "key": key, "label": label, "problem": code, "message": message,
                             "suggestion": suggestion["key"] if code != "no_english" else None, "concept": suggestion["concept"]})
    return findings
