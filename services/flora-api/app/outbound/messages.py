"""Build outbound messages from a Canopy case snapshot.

HL7 v2: ORU^R01 with MSH, PID, PV1, OBR and OBX. Vital-sign candles are four NM OBX per
parameter (first, max, min, last) sharing an OBX-4 sub-id; a PDF is one ED OBX
(^AP^PDF^Base64^<data>). FHIR R4: a transaction Bundle of Patient, Encounter and either
Observations (one per parameter, the candle in `component`, the period in effectivePeriod)
or a DiagnosticReport with the PDF in presentedForm.
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .. import phi_mask

TZ = timezone(timedelta(hours=7))  # Thailand; HL7 timestamps carry the offset

# Canopy vitals key(s) -> LOINC code, display name, UCUM unit. The first key present wins.
VITALS: list[dict[str, Any]] = [
    {"param": "hr", "keys": ("hr", "pr"), "loinc": "8867-4", "name": "Heart rate", "unit": "/min"},
    {"param": "spo2", "keys": ("spo2",), "loinc": "59408-5", "name": "Oxygen saturation by pulse oximetry", "unit": "%"},
    {"param": "rr", "keys": ("rr", "set_rr"), "loinc": "9279-1", "name": "Respiratory rate", "unit": "/min"},
    {"param": "nibp_sys", "keys": ("nibp_sys",), "loinc": "8480-6", "name": "Systolic blood pressure", "unit": "mm[Hg]"},
    {"param": "nibp_dia", "keys": ("nibp_dia",), "loinc": "8462-4", "name": "Diastolic blood pressure", "unit": "mm[Hg]"},
    {"param": "nibp_map", "keys": ("nibp_map",), "loinc": "8478-0", "name": "Mean blood pressure", "unit": "mm[Hg]"},
    {"param": "art_sys", "keys": ("art_sys",), "loinc": "76215-3", "name": "Invasive systolic blood pressure", "unit": "mm[Hg]"},
    {"param": "art_dia", "keys": ("art_dia",), "loinc": "76213-8", "name": "Invasive diastolic blood pressure", "unit": "mm[Hg]"},
    {"param": "art_map", "keys": ("art_map",), "loinc": "76214-6", "name": "Invasive mean blood pressure", "unit": "mm[Hg]"},
    {"param": "etco2", "keys": ("etco2", "et_co2"), "loinc": "19889-5", "name": "End-tidal CO2", "unit": "mm[Hg]"},
    {"param": "temperature", "keys": ("temperature", "temp"), "loinc": "8310-5", "name": "Body temperature", "unit": "Cel"},
    {"param": "cvp", "keys": ("cvp",), "loinc": "60985-9", "name": "Central venous pressure", "unit": "mm[Hg]"},
]
STATS = (("first", "First"), ("max", "Maximum"), ("min", "Minimum"), ("last", "Last"))


# ------------------------------------------------------------------ helpers

def record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        value = value.get("rows")
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None  # drop NaN


def hl7_ts(ms: int | float | None) -> str:
    if not ms:
        return ""
    return datetime.fromtimestamp(ms / 1000, TZ).strftime("%Y%m%d%H%M%S%z")


def iso(ms: int | float | None) -> str | None:
    return datetime.fromtimestamp(ms / 1000, TZ).isoformat(timespec="seconds") if ms else None


def esc(value: Any) -> str:
    """HL7 v2 escaping for | ^ ~ \\ & and line breaks."""
    text = "" if value is None else str(value)
    for raw, code in (("\\", "\\E\\"), ("|", "\\F\\"), ("^", "\\S\\"), ("~", "\\R\\"), ("&", "\\T\\")):
        text = text.replace(raw, code)
    return text.replace("\r\n", "\\.br\\").replace("\n", "\\.br\\").replace("\r", "\\.br\\")


def fmt(value: float) -> str:
    return str(int(value)) if value == int(value) else f"{value:.2f}".rstrip("0").rstrip(".")


# ------------------------------------------------------------------ case context

def context(snapshot: dict[str, Any], row: dict[str, Any], identity: str) -> dict[str, Any]:
    """Patient, visit and order fields for one case. identity 'masked' masks identifiers."""
    case = record(snapshot.get("case"))
    patient = record(record(snapshot.get("patient")).get("row"))
    procedures = rows(snapshot.get("procedures"))
    first = procedures[0] if procedures else {}
    data = {
        "hn": patient.get("hn") or case.get("hn") or row.get("hn") or "",
        "an": patient.get("an") or "",
        "id_card": patient.get("id_card") or "",
        "title": patient.get("title_th") or patient.get("title_en") or "",
        "first_name": patient.get("first_name") or patient.get("first_name_en") or "",
        "last_name": patient.get("last_name") or patient.get("last_name_en") or "",
        "patient_name": patient.get("patient_name") or "",
        "sex": str(patient.get("sex") or patient.get("gender") or "").upper()[:1],
        "dob": patient.get("dob") or "",
        "case_code": case.get("case_code") or row.get("case_code") or "",
    }
    if identity == "masked":
        data = phi_mask.mask(data)
    data.update({
        "case_id": str(row.get("global_case_id") or ""),
        "status": str(case.get("status") or row.get("status") or "").upper(),
        "start_time": case.get("start_time") or row.get("start_time"),
        "discharge_time": case.get("discharge_time") or row.get("discharge_time"),
        "ward_code": row.get("ward_code") or row.get("unit_name") or "",
        "ward_name": row.get("unit_name") or "",
        "bed": case.get("bed_label") or row.get("leaf_name") or "",
        "procedure_code": first.get("icd_code") or "",
        "procedure_text": first.get("procedure_text") or first.get("icd_text") or "Anaesthesia record",
        "accession": row.get("accession_number") or "",
    })
    if not data["first_name"] and data["patient_name"]:
        parts = str(data["patient_name"]).split()
        data["first_name"], data["last_name"] = (parts[0], " ".join(parts[1:])) if parts else ("", "")
    return data


def _dob(value: str) -> str:
    """HL7 DT from 'YYYY-MM-DD' or 'DD/MM/YYYY' (Buddhist years above 2400 are converted)."""
    text = str(value or "").strip()
    try:
        if "/" in text:
            day, month, year = (int(part) for part in text.split("/")[:3])
        else:
            year, month, day = (int(part) for part in text[:10].split("-"))
        year -= 543 if year > 2400 else 0
        return f"{year:04d}{month:02d}{day:02d}"
    except ValueError:
        return ""


# ------------------------------------------------------------------ vitals candles

def candles(snapshot: dict[str, Any], start: int, end: int) -> list[dict[str, Any]]:
    """first / max / min / last of each parameter over minute rows in [start, end)."""
    minute_rows = sorted((row for row in rows(snapshot.get("vitals"))
                          if isinstance(row.get("ts_minute"), (int, float)) and start <= row["ts_minute"] < end),
                         key=lambda row: row["ts_minute"])
    result = []
    for spec in VITALS:
        values = []
        for row in minute_rows:
            payload = record(row.get("payload"))
            value = next((number(payload.get(key)) for key in spec["keys"] if number(payload.get(key)) is not None), None)
            if value is not None:
                values.append(value)
        if values:
            result.append({**spec, "first": values[0], "max": max(values), "min": min(values), "last": values[-1],
                           "count": len(values)})
    return result


# ------------------------------------------------------------------ HL7 v2

def _msh(destination: dict[str, Any], control_id: str, now_ms: int) -> str:
    return "|".join([
        "MSH", "^~\\&", esc(destination.get("sending_application") or "FLORA"), esc(destination.get("sending_facility")),
        esc(destination.get("receiving_application")), esc(destination.get("receiving_facility")), hl7_ts(now_ms), "",
        "ORU^R01^ORU_R01", control_id, "P", destination.get("hl7_version") or "2.5.1", "", "", "AL", "NE", "", "UNICODE UTF-8",
    ])


def _pid_pv1(destination: dict[str, Any], ctx: dict[str, Any]) -> list[str]:
    facility = esc(destination.get("sending_facility"))
    ids = [f"{esc(ctx['hn'])}^^^{facility}^MR"] if ctx["hn"] else []
    if ctx["id_card"]:
        ids.append(f"{esc(ctx['id_card'])}^^^THA^NI")
    name = f"{esc(ctx['last_name'])}^{esc(ctx['first_name'])}^^^{esc(ctx['title'])}"
    pid = ["PID", "1", "", "~".join(ids), "", name, "", _dob(ctx["dob"]), esc(ctx["sex"])]
    pv1 = ["PV1", "1", "I", f"{esc(ctx['ward_code'])}^^{esc(ctx['bed'])}^{facility}"] + [""] * 15 + [esc(ctx["an"])]
    pv1 += [""] * 24 + [hl7_ts(ctx["start_time"]), hl7_ts(ctx["discharge_time"])]
    return ["|".join(pid), "|".join(pv1)]


def _obr(ctx: dict[str, Any], code: str, text: str, start: int | None, end: int | None, now_ms: int) -> str:
    obr = ["OBR", "1", esc(ctx["case_code"]), esc(ctx["accession"] or ctx["case_id"]), f"{esc(code)}^{esc(text)}^L",
           "", "", hl7_ts(start), hl7_ts(end)] + [""] * 13 + [hl7_ts(now_ms), "", "", "F"]
    return "|".join(obr)


def hl7_vitals(destination, ctx, items, start, end, control_id, now_ms) -> str:
    segments = [_msh(destination, control_id, now_ms), *_pid_pv1(destination, ctx),
                _obr(ctx, "VITALS", f"Vital signs {int((end - start) / 60000)} min summary", start, end, now_ms)]
    n = 0
    for group, item in enumerate(items, start=1):
        for index, (stat, label) in enumerate(STATS, start=1):
            n += 1
            segments.append("|".join([
                "OBX", str(n), "NM", f"{item['loinc']}^{esc(item['name'])} ({label.lower()})^LN^{item['param']}_{stat}^^L",
                f"{group}.{index}", fmt(item[stat]), f"{esc(item['unit'])}^^UCUM", "", "", "", "", "F", "", "", hl7_ts(end),
            ]))
    return "\r".join(segments) + "\r"


def hl7_document(destination, ctx, kind: str, pdf: bytes | None, control_id, now_ms) -> str:
    title = "Discharge summary" if kind == "discharge" else "Case form"
    segments = [_msh(destination, control_id, now_ms), *_pid_pv1(destination, ctx),
                _obr(ctx, kind.upper(), f"{title}: {ctx['procedure_text']}", ctx["start_time"], ctx["discharge_time"], now_ms)]
    if pdf:
        data = base64.b64encode(pdf).decode()
        segments.append("|".join(["OBX", "1", "ED", "PDF^Anaesthesia record^L", "1", f"^AP^PDF^Base64^{data}",
                                  "", "", "", "", "", "F", "", "", hl7_ts(now_ms)]))
    else:
        segments.append("|".join(["OBX", "1", "ST", "STATUS^Case status^L", "1", esc(ctx["status"]),
                                  "", "", "", "", "", "F", "", "", hl7_ts(now_ms)]))
    return "\r".join(segments) + "\r"


# ------------------------------------------------------------------ FHIR R4

def _patient_resource(ctx: dict[str, Any], facility: str) -> dict[str, Any]:
    identifiers = [{"type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0203", "code": "MR"}]},
                    "system": f"urn:flora:{facility or 'hospital'}:hn", "value": ctx["hn"]}] if ctx["hn"] else []
    if ctx["id_card"]:
        identifiers.append({"type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0203", "code": "NI"}]},
                            "system": "urn:oid:2.16.764.1.1.1", "value": ctx["id_card"]})
    resource: dict[str, Any] = {"resourceType": "Patient", "identifier": identifiers,
                                "name": [{"family": ctx["last_name"], "given": [ctx["first_name"]] if ctx["first_name"] else [],
                                          "prefix": [ctx["title"]] if ctx["title"] else []}]}
    gender = {"M": "male", "F": "female"}.get(ctx["sex"])
    if gender:
        resource["gender"] = gender
    dob = _dob(ctx["dob"])
    if dob and "-" not in dob:
        resource["birthDate"] = f"{dob[:4]}-{dob[4:6]}-{dob[6:8]}"
    return resource


def _bundle(destination, ctx, extra: list[dict[str, Any]]) -> dict[str, Any]:
    patient_id, encounter_id = f"urn:uuid:{uuid.uuid4()}", f"urn:uuid:{uuid.uuid4()}"
    facility = destination.get("sending_facility") or ""
    encounter = {"resourceType": "Encounter", "status": "finished" if ctx["status"] == "DISCHARGED" else "in-progress",
                 "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "IMP"},
                 "identifier": [{"system": "urn:flora:case", "value": ctx["case_id"]}]
                 + ([{"system": f"urn:flora:{facility or 'hospital'}:an", "value": ctx["an"]}] if ctx["an"] else []),
                 "subject": {"reference": patient_id},
                 "period": {k: v for k, v in (("start", iso(ctx["start_time"])), ("end", iso(ctx["discharge_time"]))) if v},
                 "location": [{"location": {"display": " / ".join(x for x in (ctx["ward_name"], ctx["bed"]) if x)}}]}
    entries = [{"fullUrl": patient_id, "resource": _patient_resource(ctx, facility),
                "request": {"method": "POST", "url": "Patient"}},
               {"fullUrl": encounter_id, "resource": encounter, "request": {"method": "POST", "url": "Encounter"}}]
    for resource in extra:
        resource["subject"] = {"reference": patient_id}
        resource["encounter"] = {"reference": encounter_id}
        entries.append({"fullUrl": f"urn:uuid:{uuid.uuid4()}", "resource": resource,
                        "request": {"method": "POST", "url": resource["resourceType"]}})
    return {"resourceType": "Bundle", "type": "transaction", "entry": entries}


def fhir_vitals(destination, ctx, items, start, end) -> dict[str, Any]:
    observations = []
    for item in items:
        observations.append({
            "resourceType": "Observation", "status": "final",
            "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "vital-signs"}]}],
            "code": {"coding": [{"system": "http://loinc.org", "code": item["loinc"], "display": item["name"]}], "text": item["name"]},
            "effectivePeriod": {"start": iso(start), "end": iso(end)},
            "component": [{"code": {"coding": [{"system": "urn:flora:statistic", "code": stat, "display": label}], "text": label},
                           "valueQuantity": {"value": int(item[stat]) if item[stat] == int(item[stat]) else item[stat], "unit": item["unit"], "system": "http://unitsofmeasure.org",
                                             "code": item["unit"]}} for stat, label in STATS],
            "note": [{"text": f"{item['count']} one-minute values"}],
        })
    return _bundle(destination, ctx, observations)


def fhir_document(destination, ctx, kind: str, pdf: bytes | None, now_ms: int) -> dict[str, Any]:
    title = "Discharge summary" if kind == "discharge" else "Case form"
    report: dict[str, Any] = {"resourceType": "DiagnosticReport", "status": "final",
                              "code": {"text": f"{title}: {ctx['procedure_text']}"},
                              "identifier": [{"system": "urn:flora:case", "value": ctx["case_id"]}],
                              "issued": iso(now_ms)}
    if ctx["start_time"]:
        report["effectivePeriod"] = {k: v for k, v in (("start", iso(ctx["start_time"])), ("end", iso(ctx["discharge_time"]))) if v}
    if pdf:
        report["presentedForm"] = [{"contentType": "application/pdf", "title": "Anaesthesia record",
                                    "data": base64.b64encode(pdf).decode()}]
    return _bundle(destination, ctx, [report])
