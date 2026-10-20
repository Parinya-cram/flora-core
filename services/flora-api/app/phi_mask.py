"""Mask identifiable patient data in public API responses.

Applied to every /api/v1 response (see public_api.MaskedRoute), so no key or scope can
turn it off. A value keeps its first three characters and the rest becomes "--------":
"สุภาพร" → "สุภ--------", "HN0012345" → "HN0--------". Masking is by field name, at
any depth, so the same rule covers case summaries, forms, admissions and anything added
later. Clinician names (staff) are not patient data and are left as they are.
"""
import re
import unicodedata
from typing import Any

MASK = "--------"
KEEP = 3

# Field names (lowercased, without "_" or "-") that identify the patient.
NAME_FIELDS = {
    "patientname", "fullname", "firstname", "lastname", "firstnameen", "lastnameen",
    "firstnameth", "lastnameth", "givenname", "familyname", "surname", "middlename", "fname", "lname", "contactname",
}
ID_FIELDS = {
    "hn", "mrn", "an", "admissionnumber", "vn", "cid", "citizenid", "nationalid", "idcard", "idcardno", "pid",
    "personalid", "passport", "passportno", "passportnumber",
}
OTHER_FIELDS = {
    "dob", "dateofbirth", "birthdate", "birthday", "phone", "tel", "telephone", "mobile", "contacttel", "contactphone",
    "address", "legaladdress", "presentaddress", "homeaddress", "email",
}
SENSITIVE = NAME_FIELDS | ID_FIELDS | OTHER_FIELDS
# Concept keys (app/concepts.py) that identify the patient, matched as written ("patient.name"): name or other.
PATIENT_CONCEPTS = {"patient.name": "name", "patient.hn": "other", "patient.an": "other", "patient.id_card": "other",
                    "patient.dob": "other"}
# Thai and English titles stay readable in front of a masked name ("นางสุภ-------- สมบ--------").
TITLES = ("นางสาว", "นาง", "นาย", "เด็กหญิง", "เด็กชาย", "ด.ญ.", "ด.ช.", "น.ส.", "พญ.", "นพ.", "ดร.",
          "Mrs.", "Miss", "Mrs", "Mr.", "Ms.", "Mr", "Ms", "Dr.")


def _field(key: str) -> str:
    return re.sub(r"[_\-\s]", "", key.lower())


def mask_text(value: str) -> str:
    """First three characters (plus any combining marks on the third) followed by the mask; short values are masked whole."""
    text = value.strip()
    if not text:
        return value
    cut = min(KEEP, len(text))
    while cut < len(text) and unicodedata.category(text[cut]) == "Mn":
        cut += 1  # keep Thai vowel and tone marks with their consonant
    return (text[:cut] if cut < len(text) else "") + MASK


def mask_name(value: str) -> str:
    """Mask a person's name word by word, keeping a leading title."""
    text = value.strip()
    if not text:
        return value
    if text.upper().startswith("HN "):  # the "HN 12345" fallback when a case has no name
        return "HN " + mask_text(text[3:])
    # Thai titles run straight into the name; an English one needs a dot or space after it ("Mr" ≠ "Mrinal").
    title = next((t for t in TITLES if text.startswith(t)
                  and (not t.isascii() or t.endswith(".") or text[len(t):len(t) + 1] in ("", " "))), "")
    rest = text[len(title):].strip()
    masked = " ".join(mask_text(word) for word in rest.split()) if rest else ""
    gap = " " if title and masked and (title.endswith(".") or title.isascii()) else ""
    return title + gap + masked


def _mask_value(key: str, value: Any) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return mask(value)
    return mask_name(value) if _field(key) in NAME_FIELDS or PATIENT_CONCEPTS.get(key) == "name" else mask_text(value)


def mask(data: Any) -> Any:
    """Return a copy of a JSON-like value with patient identifiers masked."""
    if isinstance(data, list):
        return [mask(item) for item in data]
    if not isinstance(data, dict):
        return data
    out: dict[str, Any] = {}
    for key, value in data.items():
        sensitive = isinstance(key, str) and (_field(key) in SENSITIVE or key in PATIENT_CONCEPTS)
        out[key] = _mask_value(key, value) if sensitive else mask(value)
    # A case code embeds the HN ("<HN>_<date>_<n>"): mask that part too.
    for key in ("case_code", "caseCode"):
        code = out.get(key)
        if isinstance(code, str) and code:
            hn = next((str(data[k]) for k in ("hn", "HN") if data.get(k)), None)
            if hn and hn in code:
                out[key] = code.replace(hn, mask_text(hn))
            elif "_" in code:
                head, tail = code.split("_", 1)
                out[key] = f"{mask_text(head)}_{tail}"
    return out
