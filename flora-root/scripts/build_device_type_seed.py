#!/usr/bin/env python3
"""Build api/app/reference/device_types.json, the seed for Root's device_type catalog.

Sources live in flora-root/reference/:
  Patient_Monitor_Database.xlsx             worldwide patient monitor reference (4 sheets)
  flora-protocol-compatibility-map.webp     Flora protocol lanes (transcribed in LANES below)

Root loads the JSON on start (main.load_device_types). Re-run this after changing a source:

    pip install openpyxl
    flora-root/scripts/build_device_type_seed.py
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "reference"
GATEWAY_TYPES = ROOT.parent / "flora-gateway" / "device-types.json"
OUT = ROOT / "api" / "app" / "reference" / "device_types.json"
XLSX = "Patient_Monitor_Database.xlsx"
MAP = "flora-protocol-compatibility-map.webp"

MANUFACTURERS = {
    "Philips": "philips", "GE Healthcare": "ge", "GE": "ge", "Mindray": "mindray", "Nihon Kohden": "nihon-kohden",
    "Dräger": "draeger", "Spacelabs": "spacelabs", "Edan": "edan", "Biolight": "biolight", "Comen": "comen",
    "Schiller": "schiller", "Welch Allyn (Baxter)": "welch-allyn", "Masimo": "masimo", "Fukuda Denshi": "fukuda",
    "Zoll": "zoll", "BPL Medical": "bpl", "Contec Medical": "contec", "Mediana": "mediana", "Skanray": "skanray",
    "Infinium Medical": "infinium", "Hamilton Medical": "hamilton", "Siemens Healthineers": "siemens",
    "B. Braun": "bbraun", "Fresenius Kabi": "fresenius", "Progetti": "progetti",
}
COUNTRY = {"ge": "USA", "draeger": "Germany", "philips": "Netherlands", "mindray": "China", "bbraun": "Germany",
           "fresenius": "Germany", "progetti": "Italy"}
# Spreadsheet rows that are not bedside patient monitors.
CATEGORY_OVERRIDES = {"CARESCAPE ONE": "parameter_module", "Radical-7": "pulse_oximeter",
                      "Patient SafetyNet": "central_station", "Connex ProBP 3400": "bp_monitor",
                      "C6 (with monitoring)": "ventilator"}

# The nine lanes of the compatibility map. Each model: (model, category, gateway codes, status).
# status: driver_in_code = a gateway parser covers it (not yet validated per model);
#         to_validate    = protocol lane planned, no parser or HL7 profile not proven.
LANES = [
    {"manufacturer": "GE", "family": "GE anaesthesia, ventilation and patient monitors",
     "protocol": "GE Datex-Ohmeda S/5 / CARESCAPE protocols", "adapter": "Serial / Ethernet adapters",
     "models": [
         ("Carestation 750", "anesthesia_machine", ["ge-carestation-750"], "driver_in_code"),
         ("Aestiva", "anesthesia_machine", [], "to_validate"),
         ("Aespire", "anesthesia_machine", [], "to_validate"),
         ("Avance", "anesthesia_machine", [], "to_validate"),
         ("Aisys", "anesthesia_machine", ["ge-aisys-cs2", "ge-aisys-dri"], "driver_in_code"),
         ("Carestation 600 / 620 / 650", "anesthesia_machine", [], "to_validate"),
         ("Engström", "ventilator", [], "to_validate"),
         ("CARESCAPE R860", "ventilator", [], "to_validate"),
         ("B105", "patient_monitor", [], "to_validate"),
         ("B125", "patient_monitor", [], "to_validate"),
         ("B450", "patient_monitor", ["ge-bx50-dri"], "driver_in_code"),
         ("B650", "patient_monitor", ["ge-bx50-dri"], "driver_in_code"),
         ("B850", "patient_monitor", ["ge-bx50-dri"], "driver_in_code"),
     ]},
    {"manufacturer": "Philips", "family": "Philips IntelliVue",
     "protocol": "Philips IntelliVue native protocol", "adapter": "LAN or MIB / RS-232",
     "note": "Native IntelliVue, not through a vendor gateway",
     "models": [
         ("MP5", "patient_monitor", [], "to_validate"),
         ("MP20–MP90", "patient_monitor", [], "to_validate"),
         ("MX400–MX850", "patient_monitor", [], "to_validate"),
         ("Avalon FM20–FM50", "fetal_monitor", [], "to_validate"),
     ]},
    {"manufacturer": "Dräger", "family": "Dräger IACS", "protocol": "IACS UDP multicast", "adapter": "Network listener",
     "models": [("Infinity M540", "patient_monitor", ["draeger-iacs-m540"], "driver_in_code")]},
    {"manufacturer": "Dräger", "family": "Dräger MEDIBUS.X", "protocol": "MEDIBUS.X", "adapter": "RS-232",
     "models": [(m, c, ["draeger-medibus"], "driver_in_code") for m, c in [
         ("Atlan", "anesthesia_machine"), ("Perseus A500", "anesthesia_machine"), ("Primus", "anesthesia_machine"),
         ("Apollo", "anesthesia_machine"), ("Fabius", "anesthesia_machine"), ("Zeus", "anesthesia_machine"),
         ("Evita", "ventilator"), ("Savina", "ventilator"), ("Carina", "ventilator"), ("Oxylog", "ventilator"),
         ("Babylog", "ventilator")]]},
    {"manufacturer": "Dräger", "family": "Dräger Vista family", "protocol": "Vista Gateway / CMS → HL7",
     "adapter": "TCP/IP HL7 receiver",
     "models": [("Vista 120", "patient_monitor", [], "to_validate"),
                ("Vista 120 S", "patient_monitor", ["draeger-vista-120s"], "driver_in_code"),
                ("Vista 120 SC", "patient_monitor", [], "to_validate")]},
    {"manufacturer": "B. Braun", "family": "B. Braun Space", "protocol": "BCC protocol", "adapter": "LAN or RS-232",
     "models": [("Space pumps via SpaceCom / SpaceStation", "infusion_pump", ["bbraun-space-bcc"], "driver_in_code")]},
    {"manufacturer": "Fresenius Kabi", "family": "Fresenius Kabi Agilia", "protocol": "Agilia Serial Export Protocol",
     "adapter": "RS-232 / USB or TCP via Link+",
     "models": [("Agilia Injectomat", "infusion_pump", [], "to_validate"),
                ("Agilia Volumat", "infusion_pump", [], "to_validate"),
                ("Injectomat TCI", "infusion_pump", [], "to_validate"),
                ("Agilia Link+", "docking_station", [], "to_validate")]},
    {"manufacturer": "Progetti", "family": "Progetti PG RIA", "protocol": "Native HL7", "adapter": "LAN / Wi-Fi",
     "models": [(m, "patient_monitor", ["hl7-patient-monitor"], "to_validate") for m in ("PG RIA 3", "PG RIA 5", "PG RIA 9")]},
    {"manufacturer": "Mindray", "family": "Mindray BeneVision", "protocol": "Native HL7", "adapter": "TCP/IP",
     "note": "Also compatible native-HL7 Mindray families",
     "models": [(m, "patient_monitor", ["hl7-patient-monitor"], "to_validate") for m in ("N12", "N15", "N17")]},
]
# Spreadsheet models that belong to a lane: (manufacturer code, spreadsheet model) -> (lane index, lane model).
SHEET_TO_LANE = {
    ("ge", "B125"): (0, "B125"), ("ge", "B450"): (0, "B450"), ("ge", "B650"): (0, "B650"), ("ge", "B850"): (0, "B850"),
    ("draeger", "Vista 120 S"): (4, "Vista 120 S"),
    ("mindray", "N17"): (8, "N17"), ("mindray", "N15"): (8, "N15"), ("mindray", "N12"): (8, "N12"),
}
PHILIPS_INTELLIVUE = {"MX800", "MX750", "MX700", "MX600", "MX500", "MX400", "X3 / MX100", "MP70/MP60",
                      "MP50/MP40/MP30", "MP20/MP5"}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("ö", "o").replace("ä", "a")).strip("-")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(sheet, header_row: int) -> list[dict]:
    data = list(sheet.iter_rows(values_only=True))
    header = [str(h).strip() for h in data[header_row - 1]]
    out = []
    for row in data[header_row:]:
        if not any(v not in (None, "") for v in row):
            continue
        out.append({h: (v.strip() if isinstance(v, str) else v) for h, v in zip(header, row)})
    return out


def is_family(model: str) -> bool:
    return any(mark in model for mark in ("/", "–", " via "))


def main() -> None:
    known_codes = {item["code"] for item in json.loads(GATEWAY_TYPES.read_text())}
    book = openpyxl.load_workbook(REFERENCE / XLSX, read_only=True, data_only=True)
    device_types: dict[str, dict] = {}

    for row in rows(book["Patient Monitors"], 3):
        code = MANUFACTURERS[row["Brand / Manufacturer"]]
        model = str(row["Model Name"])
        device_types[f"{code}-{slug(model)}"] = {
            "device_type_id": f"{code}-{slug(model)}", "manufacturer_code": code,
            "manufacturer": row["Brand / Manufacturer"], "country": row["Country"],
            "category": CATEGORY_OVERRIDES.get(model, "patient_monitor"), "series": row["Model Series"],
            "model": model, "is_family": is_family(model), "year_released": row["Year Released"],
            "care_area": row["Care Area"], "display_size": row["Display Size"],
            "hl7_v2": row["HL7 v2.x"], "hl7_fhir": row["HL7 FHIR"], "ieee_11073": row["IEEE 11073"],
            "dicom": row["DICOM"], "wifi": row["WiFi"], "wifi_standard": row["WiFi Standard"],
            "lan": row["LAN / Ethernet"], "bluetooth": row["Bluetooth"], "usb": row["USB"], "cellular": row["Cellular"],
            "integration_method": row["Integration Method"], "flora_protocol": None, "flora_adapter": None,
            "gateway_device_types": [], "status": "reference_only", "notes": row["Notes"], "sources": [XLSX],
        }

    lanes = []
    for number, lane in enumerate(LANES, start=1):
        code = MANUFACTURERS[lane["manufacturer"]]
        lanes.append({"lane_no": number, "manufacturer_code": code, "family": lane["family"],
                      "models": "; ".join(m[0] for m in lane["models"]), "protocol": lane["protocol"],
                      "adapter": lane["adapter"], "note": lane.get("note"), "source_id": MAP})
        for model, category, codes, status in lane["models"]:
            unknown = set(codes) - known_codes
            if unknown:
                raise SystemExit(f"{model}: unknown gateway device type {unknown}")
            existing = next((d for (c, m), (i, lm) in SHEET_TO_LANE.items()
                             if i == number - 1 and lm == model and (d := device_types.get(f"{c}-{slug(m)}"))), None)
            target = existing or device_types.setdefault(f"{code}-{slug(model)}", {
                "device_type_id": f"{code}-{slug(model)}", "manufacturer_code": code,
                "manufacturer": lane["manufacturer"], "country": COUNTRY.get(code), "category": category,
                "series": lane["family"], "model": model, "is_family": is_family(model) or model.endswith("pumps"),
                "notes": lane.get("note"), "sources": []})
            target.update({"flora_protocol": lane["protocol"], "flora_adapter": lane["adapter"],
                           "gateway_device_types": codes, "status": status})
            target["sources"] = sorted(set(target.get("sources", [])) | {MAP})

    # Spreadsheet IntelliVue rows sit in the Philips lane family entries.
    for device in device_types.values():
        if device["manufacturer_code"] == "philips" and device["model"] in PHILIPS_INTELLIVUE:
            device.update({"flora_protocol": LANES[1]["protocol"], "flora_adapter": LANES[1]["adapter"],
                           "status": "to_validate"})
            device["sources"] = sorted(set(device["sources"]) | {MAP})

    protocols = [{"protocol": r["Protocol"], "version": r["Version"], "transport": r["Transport"],
                  "data_format": r["Data Format"], "use_case": r["Use Case"], "vendors": r["Common Vendors"],
                  "source_id": XLSX} for r in rows(book["Protocol Reference"], 2)]
    connections = [{"connection_type": r["Connection Type"], "standard": r["Standard"], "speed": r["Speed"],
                    "range": r["Range"], "use_case": r["CIS Use Case"], "source_id": XLSX}
                   for r in rows(book["Connection Types"], 2)]
    manufacturers = [{"manufacturer_code": MANUFACTURERS[r["Brand"]], "name": r["Brand"], "country": r["Country"],
                      "hl7_v2_support": r["HL7 v2.x Support"], "fhir_support": r["FHIR Support"],
                      "wifi_support": r["WiFi Support"], "primary_integration": r["Primary Integration"],
                      "market_segment": r["Market Segment"], "source_id": XLSX}
                     for r in rows(book["Brand Summary"], 2) if r["Brand"] != "TOTAL"]
    listed = {m["manufacturer_code"] for m in manufacturers}
    for lane in LANES:
        code = MANUFACTURERS[lane["manufacturer"]]
        if code not in listed:
            listed.add(code)
            manufacturers.append({"manufacturer_code": code, "name": lane["manufacturer"], "country": COUNTRY.get(code),
                                  "primary_integration": lane["protocol"], "source_id": MAP})

    seed = {
        "sources": [
            {"source_id": XLSX, "title": "CIS-LIFE Patient Monitor Database — Worldwide Reference", "kind": "spreadsheet",
             "file_name": f"reference/{XLSX}", "sha256": sha256(REFERENCE / XLSX),
             "description": "Patient monitors with brand, model, year, protocol support and connectivity, for CIS "
                            "integration planning. Sheets: Patient Monitors, Protocol Reference, Brand Summary, "
                            "Connection Types."},
            {"source_id": MAP, "title": "FLORA Medical Device Connectivity — Protocol-First Compatibility Map",
             "kind": "image", "file_name": f"reference/{MAP}", "sha256": sha256(REFERENCE / MAP),
             "description": "Nine protocol lanes from device family to Flora edge adapter. Its '150+ devices' "
                            "figure is a compatibility estimate across models and protocol families; deployment "
                            "compatibility is validated per model, software version, interface and hospital."},
        ],
        "device_types": sorted(device_types.values(), key=lambda d: d["device_type_id"]),
        "protocols": protocols, "connection_types": connections, "manufacturers": manufacturers, "lanes": lanes,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(seed, ensure_ascii=False, indent=1) + "\n")
    counts = {key: len(value) for key, value in seed.items()}
    print(f"wrote {OUT.relative_to(ROOT)}: {counts}")


if __name__ == "__main__":
    main()
