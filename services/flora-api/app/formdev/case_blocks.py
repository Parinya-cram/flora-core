"""Report components (field type case_block): the Flora Leaf case data a printed template shows as a table.

CASE_BLOCKS equals formdev/spec/case-blocks.json (a test compares them); the TypeScript twin is
frontend/src/formdev/core/caseBlocks.ts, which also reads the rows from the case when printing. The server
only checks definitions (definition.py) and tells the AI builder what blocks exist (ai_builder.py).
"""
from __future__ import annotations

from typing import Any


def _columns(*rows: tuple[str, str, str, int]) -> list[dict[str, Any]]:
    return [{"key": key, "th": th, "en": en, "width": width} for key, th, en, width in rows]


CASE_BLOCKS: dict[str, dict[str, Any]] = {
    "diagnoses": {"th": "การวินิจฉัย", "en": "Diagnoses", "source": "diagnosis", "columns": _columns(
        ("no", "ที่", "#", 8), ("text", "การวินิจฉัย", "Diagnosis", 62), ("icd", "ICD-10", "ICD-10", 30))},
    "procedures": {"th": "หัตถการ / การผ่าตัด", "en": "Procedures", "source": "procedures", "columns": _columns(
        ("no", "ที่", "#", 8), ("text", "หัตถการ", "Procedure", 62), ("icd", "ICD-9-CM", "ICD-9-CM", 30))},
    "allergies": {"th": "ประวัติแพ้", "en": "Allergies", "source": "allergies", "columns": _columns(
        ("allergen", "สิ่งที่แพ้", "Allergen", 40), ("reaction", "อาการ", "Reaction", 40), ("severity", "ความรุนแรง", "Severity", 20))},
    "labs": {"th": "ผลแล็บ", "en": "Lab results", "source": "labs", "columns": _columns(
        ("test", "รายการ", "Test", 30), ("value", "ผล", "Result", 20), ("unit", "หน่วย", "Unit", 15), ("range", "ค่าปกติ", "Range", 20),
        ("time", "วันเวลา", "Taken", 15))},
    "events": {"th": "เหตุการณ์ระหว่างผ่าตัด", "en": "Case events", "source": "events", "columns": _columns(
        ("time", "เวลา", "Time", 15), ("title", "เหตุการณ์", "Event", 40), ("detail", "รายละเอียด", "Detail", 45))},
    "staff": {"th": "ทีมผู้ดูแล", "en": "Care team", "source": "staff", "columns": _columns(
        ("role", "หน้าที่", "Role", 40), ("name", "ชื่อ", "Name", 60))},
    "medications": {"th": "ยาที่ให้", "en": "Medications given", "source": "io", "columns": _columns(
        ("time", "เวลา", "Time", 15), ("name", "ยา", "Drug", 45), ("dose", "ขนาด", "Dose", 20), ("note", "หมายเหตุ", "Note", 20))},
    "fluids": {"th": "สารน้ำ / เลือด", "en": "Fluids and blood", "source": "io", "columns": _columns(
        ("start", "เริ่ม", "Start", 15), ("stop", "หยุด", "Stop", 15), ("name", "รายการ", "Item", 40), ("route", "ทาง", "Route", 15),
        ("volume", "ปริมาตร (ml)", "Volume (ml)", 15))},
    "outputs": {"th": "สิ่งที่ออกจากร่างกาย", "en": "Outputs", "source": "io", "columns": _columns(
        ("time", "เวลา", "Time", 20), ("name", "รายการ", "Output", 50), ("volume", "ปริมาตร (ml)", "Volume (ml)", 30))},
    "billing": {"th": "รายการค่าใช้จ่าย", "en": "Billing items", "source": "billing", "columns": _columns(
        ("code", "รหัส", "Code", 15), ("name", "รายการ", "Item", 50), ("qty", "จำนวน", "Qty", 10), ("unit", "หน่วย", "Unit", 10),
        ("amount", "จำนวนเงิน", "Amount", 15))},
    "scores": {"th": "คะแนนประเมิน", "en": "Scores", "source": "scores", "columns": _columns(
        ("time", "เวลา", "Time", 15), ("name", "แบบประเมิน", "Score", 40), ("total", "คะแนนรวม", "Total", 15), ("band", "แปลผล", "Result", 30))},
}
LIMITS: dict[str, list[int]] = {"max_rows": [1, 200], "min_rows": [0, 60], "column_width": [3, 100]}
MAX_COLUMNS = 12


def column_keys(block: str) -> list[str]:
    return [column["key"] for column in CASE_BLOCKS.get(block, {}).get("columns", [])]


def catalog_text() -> str:
    """One line per block for AI prompts: id, meaning, columns (key=default width %)."""
    return "\n".join(
        f"- {block_id}: {spec['en']} / {spec['th']} — columns " + ", ".join(f"{column['key']}={column['width']}" for column in spec["columns"])
        for block_id, spec in CASE_BLOCKS.items())
