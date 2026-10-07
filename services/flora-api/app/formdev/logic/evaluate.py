"""Record evaluation (Phase 2.1, 2.2, 2.5, 2.6, 2.7): run a definition's logic on one record.

evaluate_record() works on a copy of the data, in the logic graph's order:
  visibility -> clear_when_hidden -> offered options (option conditions, lookups; values no longer offered are
  cleared) -> derived and calculated values -> Answer + Other text -> validation.
The server runs it on every write and stores the returned data (its calculated values win); the client runs
the TypeScript twin (frontend/src/formdev/logic/evaluate.ts) for live feedback and offline use.
"""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field as dataclass_field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from ..definition import OTHER_KEY, Issue, effective_rules, validate_record
from ..field_types import FIELD_TYPES
from .formula import FormulaError, equal, evaluate, parse, round_half_away, truthy
from .lookup import Entries, derive_value, lookup_options
from .model import FieldNode, Model, Scope, build, formula_of, order

BANGKOK = timezone(timedelta(hours=7))
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+\Z")
NUMERIC = re.compile(r"^[+-]?[0-9]+(?:\.[0-9]+)?\Z")
RELATIVE_DATE = re.compile(r"^today(?:([+-])([0-9]{1,5})d)?\Z")
DATE_TEXT = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})")


def bangkok_today() -> str:
    return datetime.now(BANGKOK).date().isoformat()


@dataclass
class Context:
    """One data scope instance: the record (path "$.data") or one repeat item ("$.data.meds[0]")."""
    item: dict[str, Any]
    path: str
    scope: Scope
    parent: "Context | None" = None

    def lookup(self, key: str) -> Any:
        head, _, tail = key.partition(".")
        if tail:
            child = self.scope.repeats.get(head)
            if child is not None and tail in child.keys:
                items = self.item.get(head)
                return [entry.get(tail) if isinstance(entry, dict) else None for entry in items] if isinstance(items, list) else []
        elif key in self.scope.keys:
            return self.item.get(key)
        return self.parent.lookup(key) if self.parent is not None else None


@dataclass
class Evaluation:
    data: dict[str, Any]
    issues: list[Issue]
    hidden: list[str]  # data paths hidden by visibility conditions ("$.data.temp", "$.data.meds[0].dose")
    options: dict[str, list[dict[str, Any]]] = dataclass_field(default_factory=dict)  # path -> options offered now (dynamic only)

    @property
    def ok(self) -> bool:
        return not self.issues


@dataclass
class _Run:
    model: Model
    data: dict[str, Any]
    today: str
    status: str
    lookups: dict[str, Entries] = dataclass_field(default_factory=dict)
    hidden: set[str] = dataclass_field(default_factory=set)
    issues: list[Issue] = dataclass_field(default_factory=list)
    asts: dict[str, Any] = dataclass_field(default_factory=dict)
    options: dict[str, list[dict[str, Any]]] = dataclass_field(default_factory=dict)

    def contexts(self, scope: Scope) -> list[Context]:
        if scope.parent is None:
            return [Context(self.data, "$.data", scope)]
        key = scope.prefix[len(scope.parent.prefix):-1]
        out: list[Context] = []
        for parent in self.contexts(scope.parent):
            items = parent.item.get(key)
            for index, entry in enumerate(items if isinstance(items, list) else []):
                if isinstance(entry, dict):
                    out.append(Context(entry, f"{parent.path}.{key}[{index}]", scope, parent))
        return out

    def formula(self, text: str) -> Any:
        if text not in self.asts:
            try:
                self.asts[text] = parse(text)
            except FormulaError:
                self.asts[text] = None  # the definition validator reports it
        return self.asts[text]

    def run(self, text: str, context: Context) -> Any:
        node = self.formula(text)
        return None if node is None else evaluate(node, context.lookup, self.today)


def condition_true(condition: Any, lookup: Any) -> bool:
    """Visibility condition (Phase 2.2) against current values."""
    if not isinstance(condition, dict):
        return True
    if isinstance(condition.get("and"), list):
        return all(condition_true(part, lookup) for part in condition["and"])
    if isinstance(condition.get("or"), list):
        return any(condition_true(part, lookup) for part in condition["or"])
    value = lookup(condition.get("field")) if isinstance(condition.get("field"), str) else None
    operator = condition.get("operator")
    expected = condition.get("value")
    empty = value is None or value == "" or value == []
    if operator == "exists":
        return not empty
    if operator == "empty":
        return empty
    if isinstance(value, list):  # multiselect: equals / in look inside the selection
        if operator in ("equals", "in"):
            wanted = expected if isinstance(expected, list) else [expected]
            return any(equal(item, target) for item in value for target in wanted)
        if operator in ("not_equals", "not_in"):
            wanted = expected if isinstance(expected, list) else [expected]
            return not any(equal(item, target) for item in value for target in wanted)
        return False
    if operator == "equals":
        return equal(_number(value), _number(expected))
    if operator == "not_equals":
        return not equal(_number(value), _number(expected))
    if operator == "in":
        return isinstance(expected, list) and any(equal(_number(value), _number(item)) for item in expected)
    if operator == "not_in":
        return isinstance(expected, list) and not any(equal(_number(value), _number(item)) for item in expected)
    if operator in ("gt", "gte", "lt", "lte"):
        a, b = _number(value), _number(expected)
        same = (isinstance(a, float) and isinstance(b, float)) or (isinstance(a, str) and isinstance(b, str))
        if not same:
            return False
        return {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[operator]
    return False


def _number(value: Any) -> Any:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else value


def _resolve_date(text: str, today: str) -> str | None:
    match = RELATIVE_DATE.match(text)
    if not match:
        return text
    base = date.fromisoformat(today)
    if match.group(1):
        days = int(match.group(2))
        base = base + timedelta(days=days if match.group(1) == "+" else -days)
    return base.isoformat()


def _calculated(run: _Run, item: FieldNode, context: Context) -> Any:
    text = formula_of(run.model, item)
    value = run.run(text, context) if text else None
    calculator = run.model.calculator_defs.get(item.field.get("calculator")) if isinstance(item.field.get("calculator"), str) else None
    output = calculator["output"] if calculator is not None and isinstance(calculator.get("output"), dict) else {}
    field_decimals = item.field.get("decimals") if isinstance(item.field.get("decimals"), int) else None
    return apply_output(value, output, field_decimals)


def apply_output(value: Any, output: dict[str, Any], field_decimals: int | None = None) -> Any:
    """A calculator result in its declared output type, rounded to the field's decimals, else the calculator's."""
    kind = output.get("type", "number")
    if kind == "text":
        return None if value is None else value if isinstance(value, str) else _text(value)
    if kind == "boolean":
        return None if value is None else truthy(value)
    if not isinstance(value, float):
        return None
    decimals = field_decimals if field_decimals is not None else output.get("decimals")
    if kind == "integer":
        decimals = 0
    return round_half_away(value, decimals) if isinstance(decimals, int) and not isinstance(decimals, bool) else value


def _offered(run: _Run, item: FieldNode, context: Context) -> list[dict[str, Any]] | None:
    """Options offered now (Phase 2.3), or None when they are static or their lookup is not loaded."""
    field = item.field
    spec = field.get("lookup")
    if isinstance(spec, dict):
        entries = run.lookups.get(spec.get("source"))
        return None if entries is None else lookup_options(entries, spec, context.lookup)
    options = field.get("options")
    if not isinstance(options, list) or not any(isinstance(option, dict) and "when" in option for option in options):
        return None
    return [{key: value for key, value in option.items() if key != "when"} for option in options
            if isinstance(option, dict) and ("when" not in option or condition_true(option["when"], context.lookup))]


def _keep_offered(item: dict[str, Any], key: str, offered: list[dict[str, Any]]) -> None:
    """Clear a value (or the selections of a multiselect) that is no longer offered."""
    values = {option.get("value") for option in offered}
    value = item.get(key)
    if isinstance(value, list):
        kept = [entry for entry in value if entry in values]
        if not kept:
            item.pop(key, None)
        elif len(kept) != len(value):
            item[key] = kept
    elif value is not None and value not in values:
        item.pop(key, None)


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _other_inputs(field: dict[str, Any]) -> dict[str, bool]:
    """Options that ask for text: value -> text required."""
    return {option["value"]: option.get("input_required") is True for option in field.get("options") or []
            if isinstance(option, dict) and option.get("has_input") is True and isinstance(option.get("value"), str)}


def _clean_other(run: _Run, item: FieldNode, context: Context) -> None:
    inputs = _other_inputs(item.field)
    other = context.item.get(OTHER_KEY)
    if not inputs and not (isinstance(other, dict) and item.key in other):
        return
    value = context.item.get(item.key)
    chosen = [entry for entry in (value if isinstance(value, list) else [value]) if entry in inputs]
    path = f"{context.path}.{item.key}"
    if isinstance(other, dict) and item.key in other and not chosen:
        del other[item.key]
    text = other.get(item.key) if isinstance(other, dict) else None
    if run.status == "submitted" and path not in run.hidden and any(inputs[entry] for entry in chosen) and not (isinstance(text, str) and text.strip()):
        run.issues.append(Issue(path, "other_text_required", f"Please specify '{item.field.get('label', item.key)}'"))
    if isinstance(other, dict) and not other:
        del context.item[OTHER_KEY]


def _extra_rules(run: _Run, item: FieldNode, context: Context) -> None:
    """Phase 2.1 rules beyond Phase 1's types, required, min, max and max_length."""
    path = f"{context.path}.{item.key}"
    value = context.item.get(item.key)
    rules = effective_rules(item.field)
    custom = rules.get("message") if isinstance(rules.get("message"), str) else None

    def fail(code: str, message: str) -> None:
        run.issues.append(Issue(path, code, custom or message, custom is not None))

    if isinstance(value, str) and value != "":
        kind = FIELD_TYPES.get(item.field.get("type"), {}).get("value")
        if kind == "text":
            if isinstance(rules.get("min_length"), int) and len(value) < rules["min_length"]:
                fail("too_short", f"At least {rules['min_length']} characters")
            if isinstance(rules.get("pattern"), str):
                try:
                    if re.fullmatch(rules["pattern"], value) is None:
                        fail("pattern_mismatch", "Value does not have the required format")
                except re.error:
                    pass
            if rules.get("email") is True and not EMAIL.match(value):
                fail("invalid_email", "Not a valid e-mail address")
            if rules.get("numeric") is True and not NUMERIC.match(value):
                fail("not_numeric", "Digits only")
        if kind in ("date", "datetime"):
            match = DATE_TEXT.match(value)
            day = f"{match.group(1)}-{match.group(2)}-{match.group(3)}" if match else None
            low = _resolve_date(rules["min_date"], run.today) if isinstance(rules.get("min_date"), str) else None
            high = _resolve_date(rules["max_date"], run.today) if isinstance(rules.get("max_date"), str) else None
            if day and low and day < low:
                fail("date_too_early", f"Not before {low}")
            if day and high and day > high:
                fail("date_too_late", f"Not after {high}")
    field_rules = rules["rules"] if isinstance(rules.get("rules"), list) else []
    for rule in field_rules:
        if not isinstance(rule, dict) or not isinstance(rule.get("assert"), str):
            continue
        if "when" in rule and not condition_true(rule["when"], context.lookup):
            continue
        result = run.run(rule["assert"], context)
        if result is not None and not truthy(result):
            run.issues.append(Issue(path, "rule_failed", str(rule.get("message") or "Rule not met"), True))


def _form_rules(run: _Run, definition: dict[str, Any]) -> None:
    top = run.contexts(run.model.top)[0]
    form_rules = definition["rules"] if isinstance(definition.get("rules"), list) else []
    for rule in form_rules:
        if not isinstance(rule, dict) or not isinstance(rule.get("assert"), str) or not isinstance(rule.get("fields"), list):
            continue
        if "when" in rule and not condition_true(rule["when"], top.lookup):
            continue
        result = run.run(rule["assert"], top)
        if result is None or truthy(result):
            continue
        for key in rule["fields"]:
            path = f"$.data.{key}"
            if isinstance(key, str) and path not in run.hidden:
                run.issues.append(Issue(path, "rule_failed", str(rule.get("message") or "Rule not met"), True))


def _under(path: str, hidden: set[str]) -> bool:
    return any(path == prefix or path.startswith(prefix + ".") or path.startswith(prefix + "[") for prefix in hidden)


def evaluate_record(definition: dict[str, Any], data: Any, status: str = "draft", today: str | None = None,
                    lookups: dict[str, Entries] | None = None) -> Evaluation:
    """Run the form's logic on one record. Returns the data to store (calculated and derived values recomputed,
    hidden values cleared where the definition asks, values no longer offered cleared, Other text tidied), the
    issues, the hidden paths and the dynamic options. `lookups` maps lookup ids to their entries; a lookup that
    is not given is skipped (its options are not checked and its derived values are left as they are)."""
    work = copy.deepcopy(data) if isinstance(data, dict) else data
    if not isinstance(work, dict):
        return Evaluation(work, validate_record(definition, work, status), [])
    model = build(definition)
    run = _Run(model, work, today or bangkok_today(), status, dict(lookups or {}))
    by_node = model.by_node()
    for node in order(model):
        item = by_node[node]
        for context in run.contexts(item.scope):
            path = f"{context.path}.{item.key}"
            visible = all(condition_true(condition, context.lookup) for condition in item.conditions)
            if not visible:
                run.hidden.add(path)
                if item.field.get("clear_when_hidden") is True:
                    context.item.pop(item.key, None)
                    other = context.item.get(OTHER_KEY)
                    if isinstance(other, dict):
                        other.pop(item.key, None)
                    continue
            offered = _offered(run, item, context) if visible else None
            if offered is not None:
                run.options[path] = offered
                _keep_offered(context.item, item.key, offered)
            derive = item.field.get("derive")
            if isinstance(derive, dict) and derive.get("lookup") in run.lookups:
                value = derive_value(run.lookups[derive["lookup"]], derive, context.lookup)
                if value is None:
                    context.item.pop(item.key, None)
                else:
                    context.item[item.key] = value
            if item.field.get("type") == "calculated":
                value = _calculated(run, item, context)
                if value is None:
                    context.item.pop(item.key, None)
                else:
                    context.item[item.key] = value
    for item in model.fields:
        for context in run.contexts(item.scope):
            _clean_other(run, item, context)
            if f"{context.path}.{item.key}" not in run.hidden and not _under(context.path, run.hidden):
                _extra_rules(run, item, context)
    _form_rules(run, definition)
    base = [issue for issue in validate_record(definition, work, status) if not _under(issue.path, run.hidden)]
    custom_messages = _custom_messages(model)
    base = [Issue(issue.path, issue.code, custom_messages[_node_of(issue.path)], True) if _node_of(issue.path) in custom_messages else issue
            for issue in base]
    return Evaluation(work, base + run.issues, sorted(run.hidden), run.options)


def _custom_messages(model: Model) -> dict[str, str]:
    """node -> the designer's validation.message, used for that field's rule messages."""
    out: dict[str, str] = {}
    for item in model.fields:
        message = effective_rules(item.field).get("message")
        if isinstance(message, str) and message:
            out[item.node] = message
    return out


INDEX = re.compile(r"\[[0-9]+\]")


def _node_of(path: str) -> str:
    """'$.data.meds[2].dose' -> 'meds.dose'."""
    return INDEX.sub("", path[len("$.data."):]) if path.startswith("$.data.") else path
