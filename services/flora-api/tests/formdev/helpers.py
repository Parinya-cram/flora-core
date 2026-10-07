import copy
import json
import os
from pathlib import Path

from app.formdev import FormDevServices, services_for
from app.formdev.styles import stored_font

FORMDEV_ROOT = Path(os.environ.get("FORMDEV_ROOT") or Path(__file__).resolve().parents[4] / "formdev")
USER = "tester"


def load_json(relative: str):
    return json.loads((FORMDEV_ROOT / relative).read_text(encoding="utf-8"))


def example(version: int) -> dict:
    return copy.deepcopy(load_json(f"examples/patient-assessment/v{version}.form.json"))


def seed_registry(services: FormDevServices) -> None:
    # Fonts first: styles are validated against the font registry.
    for font in load_json("registry/fonts.json"):
        services.styles.save_font(font["font_id"], stored_font(font))
    for style in load_json("registry/styles.json"):
        services.styles.save_style(style["style_id"], style["definition"], style["version"])


def ready_services(adapter) -> FormDevServices:
    services = services_for(adapter)
    seed_registry(services)
    return services


def published_example(services: FormDevServices, version: int = 1) -> dict:
    services.schemas.create_form(example(1), USER)
    services.schemas.publish("patient_assessment", 1, USER)
    for next_version in range(2, version + 1):
        services.schemas.save_draft(example(next_version), USER)
        services.schemas.publish("patient_assessment", next_version, USER)
    return services.schemas.latest_published("patient_assessment")


def submitted_data(**overrides) -> dict:
    data = {"hn": "HN0001", "full_name": "Test Patient", "assessed_at": "2026-10-05T08:30:00+07:00"}
    data.update(overrides)
    return data
