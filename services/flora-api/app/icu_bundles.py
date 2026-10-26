"""ICU care bundles: definitions and compliance per scheduled-form slot. Pure (no database).

A bundle reads one scheduled workflow form (docs/ICU-ROUNDS.md, forms from docs/icu-workflows/build_icu_workflows.py).
Per slot of that form:
    applicable  the bundle applies (VAP: only when `ventilated` is ticked; brain bundle: always)
    compliant   every applicable item is done (all-or-none)
    missing     the item keys not done
A slot that is overdue with no entry, or skipped with no data, is "missed": applicable and not compliant
(COUNT_MISSED; callers may pass count_missed=False to leave missed slots out of the denominator). A slot
still within its grace window is "pending" and not counted. Unscheduled entries are not counted.

Item kinds (the field's value semantics):
    check   checkbox; True = done
    yes_na  radio yes/no/na; "yes" = done, "na" = item not applicable (e.g. SAT/SBT when not ventilated)
    any     any value recorded (radio / select / number: the assessment was made)
    values  the value is one of item["values"]
An item with several `fields` is done when all of them are (n/a fields ignored).
"""
from __future__ import annotations

import bisect
from collections import Counter
from datetime import date, timedelta
from typing import Any, Iterable

from . import form_schedule

COUNT_MISSED = True


def item(key: str, en: str, th: str, kind: str = "check", fields: list[str] | None = None, **extra: Any) -> dict[str, Any]:
    return {"key": key, "label": {"en": en, "th": th}, "kind": kind, "fields": fields or [key], **extra}


BUNDLES: list[dict[str, Any]] = [
    {"id": "vap", "label": {"en": "VAP bundle", "th": "Bundle ป้องกัน VAP"}, "form_id": "critical_icu_vap_check",
     # Applies only to ventilated shifts. A missed slot counts when the nearest filled shift was ventilated.
     "applies": {"field": "ventilated", "kind": "check"}, "missed": "neighbour",
     "items": [item("hob", "HOB 30–45°", "หัวเตียงสูง 30–45°"),
               item("oral_care", "Oral care", "ทำความสะอาดช่องปาก"),
               item("cuff", "Cuff pressure 20–30 cmH₂O", "ความดัน cuff 20–30 cmH₂O"),
               item("subglottic", "Subglottic suction", "ดูดเสมหะเหนือ cuff"),
               item("sat_sbt", "SAT / SBT assessed", "ประเมิน SAT / SBT")]},
    {"id": "brain", "label": {"en": "Brain protection bundle", "th": "Bundle ป้องกันสมองบาดเจ็บซ้ำ"},
     "form_id": "neuro_icu_brain_bundle", "applies": None, "missed": "always",
     "items": [item("hob", "HOB 30°, head neutral", "หัวเตียง 30° ศีรษะตรง"),
               item("spo2_ok", "SpO₂ ≥ 94 %", "SpO₂ ≥ 94 %"),
               item("paco2_ok", "PaCO₂ 35–40 mmHg", "PaCO₂ 35–40 mmHg"),
               item("cpp_ok", "MAP / CPP at target", "MAP / CPP ตามเป้า"),
               item("na_ok", "Sodium at target", "โซเดียมตามเป้า"),
               item("glucose_ok", "Glucose 140–180", "น้ำตาล 140–180"),
               item("normothermia", "Temperature ≤ 37.5 °C", "อุณหภูมิ ≤ 37.5 °C"),
               item("sedation_ok", "Sedation at target", "ยานอนหลับตามเป้า"),
               item("seizure_ppx", "Seizure prophylaxis", "ป้องกันชัก"),
               item("dvt_ok", "DVT prophylaxis", "ป้องกัน DVT")]},
    {"id": "fast_hugs", "label": {"en": "FAST HUGS BID", "th": "FAST HUGS BID"}, "form_id": "icu_daily_round",
     "applies": None, "missed": "always",
     "items": [item("feeding", "Feeding plan", "แผนการให้อาหาร", "any"),
               item("analgesia_ok", "Analgesia adequate", "ระงับปวดเพียงพอ"),
               item("sat_done", "Sedation interruption (SAT)", "หยุดยานอนหลับ (SAT)", "yes_na"),
               item("dvt", "Thromboprophylaxis decided", "ป้องกันลิ่มเลือด", "any"),
               item("hob_30", "Head of bed ≥ 30°", "หัวเตียง ≥ 30°"),
               item("ulcer_ppx", "Stress-ulcer prophylaxis", "ป้องกันแผลในกระเพาะ"),
               item("glucose_ok", "Glucose 140–180", "น้ำตาล 140–180"),
               item("sbt_done", "Spontaneous breathing trial", "ทดลองหายใจเอง (SBT)", "yes_na"),
               item("bowel_ok", "Bowel care", "การขับถ่าย"),
               item("lines_reviewed", "Lines reviewed", "ทบทวนสายต่าง ๆ"),
               item("abx_reviewed", "Antibiotics reviewed", "ทบทวนยาปฏิชีวนะ")]},
    {"id": "abcdef", "label": {"en": "ICU Liberation (ABCDEF)", "th": "ICU Liberation (ABCDEF)"}, "form_id": "icu_daily_round",
     "applies": None, "missed": "always",
     "items": [item("a_pain", "A – Pain assessed (CPOT)", "A – ประเมินปวด (CPOT)", "any", ["cpot"]),
               item("b_sat", "B – SAT (when ventilated)", "B – SAT (เมื่อใช้เครื่องช่วยหายใจ)", "yes_na", ["sat_done"]),
               item("b_sbt", "B – SBT (when ventilated)", "B – SBT (เมื่อใช้เครื่องช่วยหายใจ)", "yes_na", ["sbt_done"]),
               item("c_sedation", "C – RASS and target", "C – RASS และเป้าหมาย", "any", ["rass", "rass_target"]),
               item("d_delirium", "D – CAM-ICU done", "D – ประเมิน CAM-ICU", "any", ["cam_icu"]),
               item("e_mobility", "E – Mobility level", "E – ระดับการเคลื่อนไหว", "any", ["mobility"]),
               item("f_family", "F – Family updated", "F – แจ้งญาติ", "check", ["family_updated"])]},
]
BY_ID = {b["id"]: b for b in BUNDLES}


def bundles_for_form(form_id: str) -> list[dict[str, Any]]:
    return [b for b in BUNDLES if b["form_id"] == form_id]


def item_label(bundle_id: str, key: str, language: str = "en") -> str:
    for entry in (BY_ID.get(bundle_id) or {}).get("items") or []:
        if entry["key"] == key:
            return entry["label"].get(language) or entry["label"]["en"]
    return key


def public_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    return {"id": bundle["id"], "label": bundle["label"], "form_id": bundle["form_id"],
            "items": [{"key": i["key"], "label": i["label"]} for i in bundle["items"]]}


# ---------------------------------------------------------------- one entry

def recorded(value: Any) -> bool:
    return value is not None and value != "" and value != [] and value != {}


def ticked(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in ("true", "yes", "1")) or value == 1


def field_state(kind: str, value: Any, values: Iterable[Any] = ()) -> str:
    if kind == "check":
        return "done" if ticked(value) else "missing"
    if kind == "yes_na":
        text = str(value).strip().lower() if value is not None else ""
        return "done" if text == "yes" else "na" if text == "na" else "missing"
    if kind == "values":
        return "done" if value in set(values) else "missing"
    return "done" if recorded(value) else "missing"  # any


def item_state(spec: dict[str, Any], data: dict[str, Any]) -> str:
    """done | missing | na."""
    states = [field_state(spec["kind"], data.get(name), spec.get("values") or ()) for name in spec["fields"]]
    if all(state == "na" for state in states):
        return "na"
    return "missing" if "missing" in states else "done"


def applies(bundle: dict[str, Any], data: dict[str, Any]) -> bool:
    rule = bundle.get("applies")
    if not rule:
        return True
    return field_state(rule.get("kind") or "check", data.get(rule["field"]), rule.get("values") or ()) == "done"


def evaluate(bundle: dict[str, Any], data: dict[str, Any] | None) -> dict[str, Any]:
    """{applicable, compliant, missing: [item key]} for one entry's data."""
    data = data if isinstance(data, dict) else {}
    if not applies(bundle, data):
        return {"applicable": False, "compliant": False, "missing": []}
    states = [(spec["key"], item_state(spec, data)) for spec in bundle["items"]]
    missing = [key for key, state in states if state == "missing"]
    counted = [key for key, state in states if state != "na"]
    return {"applicable": bool(counted), "compliant": bool(counted) and not missing, "missing": missing}


# ---------------------------------------------------------------- slots of a case

def slot_state(entry: dict[str, Any] | None, slot_ts: int, grace: int, now: int) -> str:
    """done | draft | skipped | missed | pending | upcoming (an overdue draft is evaluated as it stands)."""
    if now < slot_ts:
        return "upcoming"
    open_window = now < slot_ts + grace
    if entry is None:
        return "pending" if open_window else "missed"
    status = entry.get("status")
    if status == "completed":
        return "done"
    if status == "skipped":
        return "skipped" if recorded(entry.get("data")) else "missed"
    return "pending" if open_window else "draft"


def case_rows(workflow: dict[str, Any] | None, entries: Iterable[dict[str, Any]], start: int, discharge: int | None,
              now: int, tz_name: str | None, include_upcoming: bool = False) -> list[dict[str, Any]]:
    """Bundle rows for every past or current slot (and future ones with include_upcoming; never counted)
    of the case's scheduled bundle forms.

    entries: [{id, form_id, slot_ts, status, data}] (case_form_entry rows or snapshot `workflow_entries`).
    Row: {bundle_id, form_id, entry_id, slot_ts, shift, day, status, applicable, compliant, missed, missing}.
    A slot without an entry has entry_id 'slot-<form_id>-<slot_ts>'."""
    workflow = workflow or {}
    tz = form_schedule.zone(tz_name)
    day_start = form_schedule.workflow_day_start(workflow)
    shifts = form_schedule.workflow_shifts(workflow)
    by_form: dict[str, dict[int, dict[str, Any]]] = {}
    for entry in entries:
        if isinstance(entry, dict) and entry.get("slot_ts") is not None and entry.get("form_id"):
            by_form.setdefault(str(entry["form_id"]), {})[int(entry["slot_ts"])] = entry
    rows: list[dict[str, Any]] = []
    for ref in workflow.get("forms") or []:
        if not isinstance(ref, dict):
            continue
        schedule = ref.get("schedule")
        bundles = bundles_for_form(str(ref.get("form_id") or ""))
        if not bundles or not isinstance(schedule, dict) or schedule.get("kind") not in form_schedule.KINDS:
            continue
        form_id = ref["form_id"]
        held = by_form.get(form_id, {})
        slots = []
        for slot_ts, shift, grace in form_schedule.slot_times(schedule, start, discharge, now, tz, day_start, shifts):
            entry = held.get(slot_ts)
            state = slot_state(entry, slot_ts, grace, now)
            if state != "upcoming" or include_upcoming:
                slots.append((slot_ts, shift, entry, state))
        for bundle in bundles:
            evaluated = [evaluate(bundle, (entry or {}).get("data")) if state not in ("missed",) else None
                         for _, _, entry, state in slots]
            filled = [index for index, (_, _, entry, _) in enumerate(slots)
                      if evaluated[index] is not None and recorded((entry or {}).get("data"))]
            for index, (slot_ts, shift, entry, state) in enumerate(slots):
                result = evaluated[index]
                if result is None:
                    result = {"applicable": missed_applies(bundle, evaluated, filled, index), "compliant": False, "missing": []}
                if state in ("pending", "upcoming"):
                    result = {**result, "applicable": False, "compliant": False}
                rows.append({"bundle_id": bundle["id"], "form_id": form_id,
                             "entry_id": str(entry["id"]) if entry is not None and entry.get("id") else f"slot-{form_id}-{slot_ts}",
                             "slot_ts": slot_ts, "shift": shift, "day": form_schedule.stay_day(slot_ts, start, tz, day_start),
                             "status": state, "applicable": result["applicable"], "compliant": result["compliant"],
                             "missed": state == "missed", "missing": result["missing"]})
    return rows


def missed_applies(bundle: dict[str, Any], evaluated: list[dict[str, Any] | None], filled: list[int], index: int) -> bool:
    """'always': a missed slot counts. 'neighbour': it counts when the nearest filled slot (`filled`: indices
    with data; the earlier one on a tie) had the bundle applicable, e.g. the patient was ventilated on the
    shift before. No filled slot at all: not counted."""
    if bundle.get("missed", "always") == "always":
        return True
    if not filled:
        return False
    position = bisect.bisect_left(filled, index)
    before = filled[position - 1] if position > 0 else None
    after = filled[position] if position < len(filled) else None
    nearest = before if after is None or (before is not None and index - before <= after - index) else after
    return bool(evaluated[nearest]["applicable"])


# ---------------------------------------------------------------- summaries

def counted(rows: Iterable[dict[str, Any]], count_missed: bool = COUNT_MISSED) -> list[dict[str, Any]]:
    return [r for r in rows if r["applicable"] and (count_missed or not r["missed"])]


def pct(compliant: int, applicable: int) -> float | None:
    return round(100.0 * compliant / applicable, 1) if applicable else None


def tally(rows: Iterable[dict[str, Any]], count_missed: bool = COUNT_MISSED) -> dict[str, Any]:
    """{applicable, compliant, pct, missed}: compliance % = compliant / applicable."""
    use = counted(rows, count_missed)
    compliant = sum(1 for r in use if r["compliant"])
    return {"applicable": len(use), "compliant": compliant, "pct": pct(compliant, len(use)),
            "missed": sum(1 for r in use if r["missed"])}


def top_missing(rows: Iterable[dict[str, Any]], bundle_id: str | None = None, limit: int = 5,
                count_missed: bool = COUNT_MISSED) -> list[dict[str, Any]]:
    counts: Counter = Counter()
    for r in counted(rows, count_missed):
        for key in r.get("missing") or []:
            counts[(bundle_id or r["bundle_id"], key)] += 1
    return [{"bundle_id": b, "item": key, "label": {"en": item_label(b, key, "en"), "th": item_label(b, key, "th")},
             "count": n} for (b, key), n in counts.most_common(limit)]


def local_date(ts: int, tz_name: str | None) -> date:
    return form_schedule.local(ts, form_schedule.zone(tz_name)).date()


def case_compliance(workflow: dict[str, Any] | None, rows: list[dict[str, Any]], start: int, now: int,
                    tz_name: str | None, days: int = 7, count_missed: bool = COUNT_MISSED) -> list[dict[str, Any]]:
    """Per bundle of the case's workflow: totals, the last `days` local dates, today's stay-day slots and
    the most common missing items (Leaf: GET /api/case/{id}/bundle-compliance)."""
    tz = form_schedule.zone(tz_name)
    workflow = workflow or {}
    today_day = form_schedule.stay_day(now, start, tz, form_schedule.workflow_day_start(workflow))
    today = local_date(now, tz_name)
    dates = [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    out = []
    seen: set[str] = set()
    for ref in workflow.get("forms") or []:
        for bundle in bundles_for_form(str((ref or {}).get("form_id") or "")) if isinstance(ref, dict) else []:
            if bundle["id"] in seen:
                continue
            seen.add(bundle["id"])
            mine = [r for r in rows if r["bundle_id"] == bundle["id"]]
            by_date: dict[date, list[dict[str, Any]]] = {}
            for r in mine:
                by_date.setdefault(local_date(r["slot_ts"], tz_name), []).append(r)
            out.append({**public_bundle(bundle), **tally(mine, count_missed),
                        "pending": sum(1 for r in mine if r["status"] == "pending"),
                        "by_day": [{"date": d.isoformat(), **tally(by_date.get(d, []), count_missed)} for d in dates],
                        "today": [{"slot_ts": r["slot_ts"], "shift": r["shift"], "day": r["day"], "status": r["status"],
                                   "applicable": r["applicable"], "compliant": r["compliant"], "missing": r["missing"]}
                                  for r in mine if r["day"] == today_day],
                        "missed_slots": [{"slot_ts": r["slot_ts"], "shift": r["shift"], "day": r["day"]}
                                         for r in mine if r["missed"] and r["applicable"]][-20:],
                        "top_missing": top_missing(mine, bundle["id"], 5, count_missed)})
    return out
