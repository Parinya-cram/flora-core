"""Write formdev/spec/fixtures/concepts.json from Canopy's concept module (services/flora-api/app/concepts.py): the
concept dictionary, where the record draft keeps each concept, and the value of every concept for sample cases. The
Leaf's tests (frontend/tests/formdev/concepts.test.ts) check concepts.ts and caseData.ts give the same; Canopy's
(services/flora-api/tests/formdev/test_concepts.py) that the file is current. Times are the hospital's (Asia/Bangkok).

    python formdev/scripts/build_concept_fixtures.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "services/flora-api"))

from app import concepts  # noqa: E402

OUT = ROOT / "spec/fixtures/concepts.json"
NOW = 1_792_120_000_000  # 2026-10-16, the reference "now" of cases without a start time


def at(day: int, hour: int, minute: int) -> int:
    return int(datetime(2026, 10, day, hour, minute, tzinfo=ZoneInfo("Asia/Bangkok")).timestamp() * 1000)


CASES = [
    {"name": "the record draft first, then HIS and the lists", "head": {"caseId": 1, "hn": "6512345", "admissionNumber": "67-1", "startTime": at(16, 8, 0)},
     "loaded": {
         "draft": {"titleTh": "นาย", "firstName": "สมชาย", "lastName": "ใจดี", "an": "67-00123", "idCard": "1100100100100", "dob": "02/05/2513",
                   "sex": "Male", "weightKg": "70,5", "heightCm": 170, "bloodGroupABO": "o", "bloodGroupRh": "neg", "asa": "2", "emergency": True,
                   "diagnosis": ["Appendicitis", " "], "operation": "Appendectomy", "anesthesiaTypes": ["General anesthesia", "Spinal anesthesia"],
                   "pacuArrivalTime": "9.05", "pacuDischargeTime": "10:30", "postoperativeDestination": "Ward 5"},
         "patient": {"patient_name": "HIS NAME", "an": "HIS-AN", "sex": "F", "weight_kg": 50, "asa_status": "3"},
         "diagnosis": [{"diagnosis_text": "Acute appendicitis", "icd_code": "K35.8"}, {"diagnosis_text": "", "icd_code": ""}],
         "procedures": [{"procedure_text": "Laparoscopic appendectomy"}],
         "allergies": [{"allergen": "Penicillin", "reaction": "rash"}, {"allergen": "NKA"}, {"allergen": "Latex", "reaction": ""}],
         "labs": [{"test_name": "Hgb", "value_text": "12,5"}, {"test_name": "Platelet count", "value_text": "250"}, {"test_name": "WBC", "value_text": "pending"}],
         "events": [{"event_type": "event", "title": "Start Anesthesia", "event_ts": at(16, 8, 5)}, {"event_type": "event", "title": "Start Surgery", "event_ts": at(16, 8, 30)},
                    {"event_type": "note", "title": "End Surgery", "event_ts": at(16, 9, 59)}, {"event_type": "event", "title": "End Surgery", "event_ts": at(16, 9, 40)},
                    {"event_type": "event", "title": "EA", "event_ts": at(16, 9, 50)}, {"event_type": "event", "title": "End Anesthesia", "event_ts": at(16, 9, 55)}],
         "staff": [{"role_id": "anesthetistResident", "name": "Dr Res"}, {"role_id": "anesthetist", "name": "Dr Staff"}, {"role": "Surgeon", "name": "Dr Cut"},
                   {"role_id": "nurseAnesthetist", "name": ""}, {"role_id": "nurseAnesthetist", "name": "Nurse A"}],
         "workstation": {"roomName": "OR 3", "careUnitName": "Main OR"}}},
    {"name": "HIS only", "head": {"caseId": 2, "hn": None, "startTime": at(16, 23, 30)},
     "loaded": {
         "draft": None,
         "patient": {"hn": "HN-HIS", "an": "AN-HIS", "title_th": "Mr.", "first_name": "John", "last_name": "Doe", "dob": "1970-05-02T00:00:00",
                     "age_text": "56 Y", "sex": "M", "weight_kg": "60", "height_cm": 165.5, "blood_group_abo": "a", "blood_group_rh": "+",
                     "asa_status": "3", "asa_emergency": True, "pre_admit_at": at(15, 10, 0)},
         "diagnosis": [], "procedures": [], "allergies": [{"allergen": "NKDA"}], "labs": [], "events": [], "staff": [], "workstation": None}},
    {"name": "age from the date of birth, Thai title without a space", "head": {"caseId": 3, "startTime": at(16, 7, 0)},
     "loaded": {"draft": {"titleTh": "ด.ญ.", "firstName": "มะลิ", "dob": "2016-10-17", "emergency": False},
                "patient": {"blood_group_text": "B Rh+", "pre_admit_at": "16/10/2569"}, "diagnosis": [], "procedures": [], "allergies": [],
                "labs": [], "events": [], "staff": [], "workstation": None}},
    {"name": "nothing known", "head": {"caseId": 4}, "loaded": {"draft": {}, "patient": {}, "diagnosis": [], "procedures": [], "allergies": [],
                                                               "labs": [], "events": [], "staff": [], "workstation": {}}},
]


def main() -> None:
    out = {
        "concepts": concepts.CONCEPTS,
        "draft_keys": concepts.DRAFT_KEYS,
        "now": NOW,
        "cases": [{**case, "values": concepts.case_values(case["head"], case["loaded"], NOW)} for case in CASES],
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(out['concepts'])} concepts, {len(out['cases'])} cases")


if __name__ == "__main__":
    main()
