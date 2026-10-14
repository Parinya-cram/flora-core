"""Clinical scores (`flora-score/1`): definitions, validation and the evaluator.

A score is one JSON document (versioned and published like a workflow), not rows of
items and conditions, because real scores need more than "value <= 10 → 1": NEWS2 picks a
SpO2 scale from the oxygen state, SOFA uses a P/F ratio. Simple items use bands or options;
anything else is a Form Studio formula (app/formdev/logic/formula.py), so there is one
formula language for forms and scores.

  {format, id, name, description, reference, interval_min, missing: partial|none,
   inputs: {key: {source: param|manual, param, fallback: [param...], window_min, agg, type, round, default, label, unit}},
   mode: auto (computed every interval_min) | manual (only when a clinician runs it),
   items:  [{key, label, input | formula, requires?, bands: [{min?, max?, points}] | options: [{value, points}]}],
   total:  {formula?},                       # default: sum of item points
   bands:  [{min?, max?, label, level}],     # interpretation of the total (info|warning|critical)
   flags:  [{when, label, level}]}           # formulas over the result, e.g. "max_points >= 3"

Formulas see the input values by key, `points.<item>` and `value.<item>`, and in total/flags
also `total`, `max_points` and `missing_count`. Band bounds are inclusive; the first band
that matches wins. Inputs with `round` are rounded first, so 35.04 °C is banded as 35.0.
"""
from __future__ import annotations

import bisect
import math
import re
from typing import Any, Iterable

from .formdev.logic import formula

FORMAT = "flora-score/1"
SCORE_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}\Z")
KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}\Z")
SOURCES = {"param", "manual"}
AGGREGATES = {"latest", "min", "max", "avg"}
TYPES = {"number", "text", "bool"}
LEVELS = {"info", "warning", "critical"}
MISSING = {"partial", "none"}
MODES = {"auto", "manual"}
MINUTE_MS = 60_000
TRUE_TEXT = {"1", "true", "yes", "y", "on", "o2"}
FALSE_TEXT = {"0", "false", "no", "n", "off", "air", "ra"}


# ---------------------------------------------------------------- definition

def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str) and value.strip():
        try:
            number = float(value.strip())
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _bands(raw: Any, value_key: str) -> list[dict[str, Any]]:
    bands = []
    for band in raw if isinstance(raw, list) else []:
        if not isinstance(band, dict):
            continue
        entry = {key: band[key] for key in ("min", "max") if band.get(key) not in (None, "")}
        for key in ("min", "max"):
            if key in entry and _number(entry[key]) is not None:
                entry[key] = _number(entry[key])
        for key in (value_key, "label", "level", "action"):
            if band.get(key) not in (None, ""):
                entry[key] = band[key]
        bands.append(entry)
    return bands


def normalize(definition: dict[str, Any]) -> dict[str, Any]:
    inputs: dict[str, Any] = {}
    for key, raw in (definition.get("inputs") or {}).items() if isinstance(definition.get("inputs"), dict) else []:
        if not isinstance(raw, dict):
            continue
        entry: dict[str, Any] = {"source": raw.get("source") or "param", "type": raw.get("type") or "number",
                                 "label": str(raw.get("label") or key)}
        if entry["source"] == "param":
            entry["param"] = str(raw.get("param") or key).strip()
            fallback = raw.get("fallback")
            entry["fallback"] = [str(item).strip() for item in (fallback if isinstance(fallback, list) else [fallback] if fallback else [])]
            entry["window_min"] = raw.get("window_min", 60)
            entry["agg"] = raw.get("agg") or "latest"
        for name in ("round", "default", "unit", "options"):
            if raw.get(name) not in (None, ""):
                entry[name] = raw[name]
        inputs[str(key).strip()] = entry
    items = []
    for raw in definition.get("items") or []:
        if not isinstance(raw, dict):
            continue
        entry = {"key": str(raw.get("key") or "").strip(), "label": str(raw.get("label") or raw.get("key") or "")}
        for name in ("input", "formula"):
            if raw.get(name) not in (None, ""):
                entry[name] = str(raw[name]).strip()
        if isinstance(raw.get("requires"), list):
            entry["requires"] = [str(name).strip() for name in raw["requires"]]
        if raw.get("bands"):
            entry["bands"] = _bands(raw["bands"], "points")
        if raw.get("options"):
            entry["options"] = [{"value": option.get("value"), "points": option.get("points"),
                                 **({"label": option["label"]} if option.get("label") else {})}
                                for option in raw["options"] if isinstance(option, dict)]
        items.append(entry)
    total = definition.get("total") if isinstance(definition.get("total"), dict) else {}
    return {
        "format": FORMAT, "id": definition.get("id"), "name": str(definition.get("name") or "").strip(),
        "description": str(definition.get("description") or ""), "reference": str(definition.get("reference") or ""),
        **({"version": int(definition["version"])} if isinstance(definition.get("version"), int) else {}),
        "mode": definition.get("mode") or "auto",
        "interval_min": definition.get("interval_min", 15),
        "missing": definition.get("missing") or "partial",
        "inputs": inputs, "items": items,
        "total": {"formula": str(total["formula"]).strip()} if total.get("formula") else {},
        "bands": _bands(definition.get("bands"), "label"),
        "flags": [{"when": str(flag.get("when") or ""), "label": str(flag.get("label") or ""),
                   "level": flag.get("level") or "warning"}
                  for flag in definition.get("flags") or [] if isinstance(flag, dict)],
    }


def structural_issues(definition: Any) -> list[dict[str, str]]:
    if not isinstance(definition, dict):
        return [{"path": "$", "message": "definition must be an object"}]
    issues = []
    if definition.get("format", FORMAT) != FORMAT:
        issues.append({"path": "$.format", "message": f"format must be {FORMAT}"})
    if not isinstance(definition.get("id"), str) or not SCORE_ID.match(definition["id"]):
        issues.append({"path": "$.id", "message": "id must match ^[a-z][a-z0-9_]{1,63}$"})
    for key, kind in (("inputs", dict), ("items", list), ("bands", list), ("flags", list)):
        if definition.get(key) is not None and not isinstance(definition[key], kind):
            issues.append({"path": f"$.{key}", "message": f"{key} must be {'an object' if kind is dict else 'a list'}"})
    return issues


def _band_issues(bands: list[dict[str, Any]], path: str, value_key: str) -> list[dict[str, str]]:
    issues = []
    for index, band in enumerate(bands):
        where = f"{path}[{index}]"
        low, high = band.get("min"), band.get("max")
        if (low is not None and _number(low) is None) or (high is not None and _number(high) is None):
            issues.append({"path": where, "message": "min and max must be numbers"})
            continue
        if low is not None and high is not None and low > high:
            issues.append({"path": where, "message": "min is above max"})
        if value_key == "points" and _number(band.get("points")) is None:
            issues.append({"path": f"{where}.points", "message": "points must be a number"})
        if value_key == "label" and not band.get("label"):
            issues.append({"path": f"{where}.label", "message": "label is required"})
        if value_key == "label" and band.get("level", "info") not in LEVELS:
            issues.append({"path": f"{where}.level", "message": "level must be info, warning or critical"})
    ranges = sorted((band.get("min", -math.inf), band.get("max", math.inf), index)
                    for index, band in enumerate(bands) if _number(band.get("min", 0)) is not None and _number(band.get("max", 0)) is not None)
    for (low_a, high_a, a), (low_b, _high_b, b) in zip(ranges, ranges[1:]):
        if low_b <= high_a:
            issues.append({"path": f"{path}[{b}]", "message": f"overlaps band {a + 1}"})
    return issues


def _formula_issues(text: str, path: str, known: set[str]) -> list[dict[str, str]]:
    try:
        node = formula.parse(text)
    except formula.FormulaError as error:
        return [{"path": path, "message": f"{error.message} (column {error.position})"}]
    return [{"path": path, "message": f"unknown name '{name}'"}
            for name, _position in formula.references(node) if name not in known]


def validate(definition: Any, parameters: Iterable[str] | None = None) -> list[dict[str, str]]:
    """Everything that blocks publishing (empty = publishable). `parameters`: known param keys."""
    issues = structural_issues(definition)
    if issues:
        return issues
    score = normalize(definition)
    known_params = set(parameters) if parameters is not None else None
    if not score["name"]:
        issues.append({"path": "$.name", "message": "name is required"})
    interval = _number(score["interval_min"])
    if interval is None or not 1 <= interval <= 1440 or interval != int(interval):
        issues.append({"path": "$.interval_min", "message": "interval_min must be a whole number of minutes (1-1440)"})
    if score["mode"] not in MODES:
        issues.append({"path": "$.mode", "message": "mode must be auto (every interval) or manual"})
    if score["missing"] not in MISSING:
        issues.append({"path": "$.missing", "message": "missing must be partial or none"})
    if not score["items"]:
        issues.append({"path": "$.items", "message": "add at least one item"})
    for key, entry in score["inputs"].items():
        path = f"$.inputs.{key}"
        if not KEY.match(key):
            issues.append({"path": path, "message": "input key must be lowercase letters, digits or _"})
        if entry["source"] not in SOURCES:
            issues.append({"path": f"{path}.source", "message": "source must be param or manual"})
        if entry["type"] not in TYPES:
            issues.append({"path": f"{path}.type", "message": "type must be number, text or bool"})
        if entry["source"] == "param":
            for param in [entry["param"], *entry["fallback"]]:
                if known_params is not None and param not in known_params:
                    issues.append({"path": f"{path}.param", "message": f"parameter '{param}' is not in the parameter master"})
            window = _number(entry["window_min"])
            if window is None or not 0 < window <= 1440:
                issues.append({"path": f"{path}.window_min", "message": "window_min must be 1-1440 minutes"})
            if entry["agg"] not in AGGREGATES:
                issues.append({"path": f"{path}.agg", "message": "agg must be latest, min, max or avg"})
            if entry["agg"] != "latest" and entry["type"] != "number":
                issues.append({"path": f"{path}.agg", "message": "only number inputs can use min, max or avg"})
        if "round" in entry and (_number(entry["round"]) is None or not 0 <= entry["round"] <= 4):
            issues.append({"path": f"{path}.round", "message": "round must be 0-4 decimals"})
    names = set(score["inputs"])
    item_keys: set[str] = set()
    for index, item in enumerate(score["items"]):
        path = f"$.items[{index}]"
        if not KEY.match(item["key"]):
            issues.append({"path": f"{path}.key", "message": "item key must be lowercase letters, digits or _"})
        if item["key"] in item_keys:
            issues.append({"path": f"{path}.key", "message": f"item '{item['key']}' is listed twice"})
        if not item["label"]:
            issues.append({"path": f"{path}.label", "message": "label is required"})
        has_input, has_formula = "input" in item, "formula" in item
        if has_input == has_formula:
            issues.append({"path": path, "message": "an item needs either input or formula"})
        if has_input and item["input"] not in names:
            issues.append({"path": f"{path}.input", "message": f"input '{item['input']}' is not defined"})
        for name in item.get("requires") or []:
            if name not in names:
                issues.append({"path": f"{path}.requires", "message": f"input '{name}' is not defined"})
        if has_formula:
            issues.extend(_formula_issues(item["formula"], f"{path}.formula",
                                          names | {f"points.{key}" for key in item_keys} | {f"value.{key}" for key in item_keys}))
        if "bands" in item and "options" in item:
            issues.append({"path": path, "message": "use bands or options, not both"})
        if has_input and "bands" not in item and "options" not in item:
            issues.append({"path": path, "message": "an input item needs bands or options"})
        issues.extend(_band_issues(item.get("bands") or [], f"{path}.bands", "points"))
        for o, option in enumerate(item.get("options") or []):
            if _number(option.get("points")) is None:
                issues.append({"path": f"{path}.options[{o}].points", "message": "points must be a number"})
        item_keys.add(item["key"])
    result_names = names | {f"points.{key}" for key in item_keys} | {f"value.{key}" for key in item_keys} \
        | {"total", "max_points", "missing_count"}
    if score["total"].get("formula"):
        issues.extend(_formula_issues(score["total"]["formula"], "$.total.formula", result_names - {"total"}))
    issues.extend(_band_issues(score["bands"], "$.bands", "label"))
    for index, flag in enumerate(score["flags"]):
        if not flag["label"]:
            issues.append({"path": f"$.flags[{index}].label", "message": "label is required"})
        if flag["level"] not in LEVELS:
            issues.append({"path": f"$.flags[{index}].level", "message": "level must be info, warning or critical"})
        issues.extend(_formula_issues(flag["when"], f"$.flags[{index}].when", result_names))
    return issues


# ---------------------------------------------------------------- inputs from the timeline

def _typed(value: Any, entry: dict[str, Any]) -> Any:
    if value is None or value == "":
        return None
    kind = entry.get("type", "number")
    if kind == "bool":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in TRUE_TEXT:
            return True
        if text in FALSE_TEXT:
            return False
        number = _number(text)
        return None if number is None else number > 0
    if kind == "text":
        return str(value).strip().upper() if isinstance(value, str) else str(value)
    number = _number(value)
    if number is not None and "round" in entry:
        number = formula.round_half_away(number, int(entry["round"]))
    return number


def resolve_inputs(score: dict[str, Any], minutes: dict[int, dict[str, Any]], ts: int,
                   manual: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """({key: value}, {key: {value, param, ts}}) at `ts` from effective minute payloads.

    A param input looks back window_min minutes (inclusive of ts); older readings count as
    missing, never as current. Manual values (POST evaluate) win over the timeline."""
    manual = manual or {}
    values: dict[str, Any] = {}
    used: dict[str, Any] = {}
    stamps = sorted(minutes)
    high = bisect.bisect_right(stamps, ts)
    for key, entry in score["inputs"].items():
        if key in manual and manual[key] not in (None, ""):
            values[key] = _typed(manual[key], entry)
            used[key] = {"value": values[key], "source": "manual"}
            continue
        value, detail = None, None
        if entry["source"] == "param":
            window = stamps[bisect.bisect_right(stamps, ts - int(float(entry["window_min"]) * MINUTE_MS)):high]
            for param in [entry["param"], *entry["fallback"]]:
                found = [(stamp, _typed(minutes[stamp].get(param), entry)) for stamp in window
                         if isinstance(minutes[stamp], dict)]
                found = [(stamp, item) for stamp, item in found if item is not None]
                if not found:
                    continue
                agg = entry["agg"]
                if agg == "latest":
                    stamp, value = found[-1]
                else:
                    numbers = [item for _stamp, item in found]
                    value = min(numbers) if agg == "min" else max(numbers) if agg == "max" else \
                        formula.round_half_away(sum(numbers) / len(numbers), int(entry.get("round", 1)))
                    stamp = found[-1][0]
                detail = {"value": value, "param": param, "ts": stamp, **({"agg": agg, "n": len(found)} if agg != "latest" else {})}
                break
        if value is None and "default" in entry:
            value = _typed(entry["default"], entry)
            detail = {"value": value, "source": "default"}
        values[key] = value
        if detail is not None:
            used[key] = detail
    return values, used


# ---------------------------------------------------------------- evaluation

def _in_band(value: float, band: dict[str, Any]) -> bool:
    return ("min" not in band or value >= band["min"]) and ("max" not in band or value <= band["max"])


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _number(a) is not None and _number(b) is not None:
        return _number(a) == _number(b)
    return str(a).strip().upper() == str(b).strip().upper()


def _points(item: dict[str, Any], value: Any) -> float | None:
    if value is None:
        return None
    if "bands" in item:
        number = _number(value) if not isinstance(value, bool) else float(value)
        if number is None:
            return None
        band = next((band for band in item["bands"] if _in_band(number, band)), None)
        return _number(band["points"]) if band else None
    if "options" in item:
        option = next((option for option in item["options"] if _same(option.get("value"), value)), None)
        return _number(option["points"]) if option else None
    return _number(value)  # a formula item without bands gives its points directly


def evaluate(definition: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    """{total, band, level, partial, items: [{key,label,value,points}], missing, flags}."""
    score = normalize(definition)
    scope: dict[str, Any] = dict(values)
    items, missing = [], []
    for item in score["items"]:
        if "formula" in item:
            # A formula would treat a missing reading as false or 0, so its inputs must be present
            # (by default every input it names; `requires` narrows that for formulas that handle blanks).
            required = item.get("requires")
            if required is None:
                required = [name for name, _ in formula.references(formula.parse(item["formula"])) if name in score["inputs"]]
            try:
                value = None if any(values.get(name) is None for name in required) else \
                    formula.evaluate(formula.parse(item["formula"]), scope.get, "1970-01-01")
            except formula.FormulaError:
                value = None
        else:
            value = values.get(item["input"])
        points = _points(item, value)
        scope[f"value.{item['key']}"] = value
        scope[f"points.{item['key']}"] = points
        if points is None:
            missing.append(item["key"])
        items.append({"key": item["key"], "label": item["label"], "value": value, "points": points})
    available = [item["points"] for item in items if item["points"] is not None]
    scope["max_points"] = max(available) if available else None
    scope["missing_count"] = float(len(missing))
    if score["total"].get("formula"):
        total = _number(formula.evaluate(formula.parse(score["total"]["formula"]), scope.get, "1970-01-01"))
    else:
        total = float(sum(available)) if available else None
    if missing and score["missing"] == "none":
        total = None
    scope["total"] = total
    band = next((band for band in score["bands"] if total is not None and _in_band(total, band)), None)
    flags = []
    for flag in score["flags"]:
        try:
            if formula.truthy(formula.evaluate(formula.parse(flag["when"]), scope.get, "1970-01-01")):
                flags.append({"label": flag["label"], "level": flag["level"]})
        except formula.FormulaError:
            continue
    if total is not None and total == int(total):
        total = int(total)
    return {"total": total, "band": band.get("label") if band else None, "level": band.get("level", "info") if band else None,
            "partial": bool(missing) and total is not None, "items": items, "missing": missing, "flags": flags}


def evaluate_at(definition: dict[str, Any], minutes: dict[int, dict[str, Any]], ts: int,
                manual: dict[str, Any] | None = None) -> dict[str, Any]:
    score = normalize(definition)
    values, used = resolve_inputs(score, minutes, ts, manual)
    return {**evaluate(score, values), "inputs": used}


def slots(definition: dict[str, Any], start_ts: int, end_ts: int) -> list[int]:
    """Interval boundaries (epoch ms, aligned to the clock) in (start_ts, end_ts]."""
    step = int(float(definition.get("interval_min") or 15)) * MINUTE_MS
    first = (start_ts // step + 1) * step
    return list(range(first, end_ts + 1, step))


# ---------------------------------------------------------------- Canopy delivery

def published(database: Any, score_ids: list[str]) -> dict[str, dict[str, Any]]:
    """{id: {definition, updated_at}} of published scores (for the ward exchange)."""
    if not score_ids or database.execute("SELECT to_regclass('canopy_score_definition') AS t").fetchone()["t"] is None:
        return {}
    rows = database.execute(
        """SELECT id, published_definition, version, updated_at FROM canopy_score_definition
           WHERE id = ANY(%s) AND status <> 'archived' AND published_definition IS NOT NULL""", (score_ids,)).fetchall()
    return {row["id"]: {"definition": row["published_definition"], "updated_at": int(row["updated_at"])} for row in rows}


def score_ids_of(workflow: dict[str, Any] | None) -> list[str]:
    ids = (workflow or {}).get("scores")
    return [item for item in ids if isinstance(item, str) and item] if isinstance(ids, list) else []
