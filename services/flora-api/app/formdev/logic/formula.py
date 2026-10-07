"""Safe formula language (Phase 2.4): tokenizer -> parser -> AST -> evaluator.

Formulas are never executed as code (no eval, exec or Function constructor): text is tokenized, parsed into a small AST of tuples and walked by the
evaluator below. The TypeScript twin is frontend/src/formdev/logic/formula.ts; both are checked against
formdev/spec/fixtures/formula-cases.json. Language reference: formdev/spec/LOGIC.md.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Iterable

MAX_LENGTH = 2000
MAX_TOKENS = 1000
MAX_DEPTH = 64
KEYWORDS = ("and", "or", "not", "true", "false", "null")
# name: (minimum arguments, maximum arguments or None)
FUNCTIONS: dict[str, tuple[int, int | None]] = {
    "IF": (3, 3), "MIN": (1, None), "MAX": (1, None), "SUM": (1, None), "AVG": (1, None), "COUNT": (1, None),
    "ROUND": (1, 2), "FLOOR": (1, 1), "CEIL": (1, 1), "ABS": (1, 1), "SQRT": (1, 1), "COALESCE": (1, None),
    "ISBLANK": (1, 1), "AGE": (1, 2), "DAYS": (2, 2), "TODAY": (0, 0),
}
COMPARISONS = ("=", "!=", "<", "<=", ">", ">=")

NUMBER = re.compile(r"[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?")
KEY_PATH = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?\Z")
DATE_PREFIX = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})")
DIGITS = "0123456789"
LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
OPERATORS = ("<=", ">=", "!=", "<>", "==", "+", "-", "*", "/", "%", "^", "=", "<", ">")


class FormulaError(Exception):
    def __init__(self, code: str, message: str, position: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.position = position  # 1-based column


@dataclass(frozen=True)
class Token:
    kind: str  # num, str, name, func, kw, op, lparen, rparen, comma, end
    value: Any
    position: int


def tokenize(text: str) -> list[Token]:
    if not isinstance(text, str):
        raise FormulaError("formula_syntax", "A formula must be text", 1)
    if len(text) > MAX_LENGTH:
        raise FormulaError("formula_too_complex", f"Formulas are limited to {MAX_LENGTH} characters", 1)
    tokens: list[Token] = []
    at = 0
    while at < len(text):
        char = text[at]
        position = at + 1
        if char in " \t\r\n":
            at += 1
            continue
        # ASCII only, like the TypeScript twin (str.isdigit/isalpha would also accept Thai digits and letters).
        if char in DIGITS:
            match = NUMBER.match(text, at)
            assert match
            tokens.append(Token("num", float(match.group(0)), position))
            at = match.end()
        elif char in "'\"":
            at, value = _read_string(text, at)
            tokens.append(Token("str", value, position))
        elif char in LETTERS:
            match = WORD.match(text, at)
            assert match
            word = match.group(0)
            at = match.end()
            following = at
            while following < len(text) and text[following] in " \t\r\n":
                following += 1
            if word.lower() in KEYWORDS:
                tokens.append(Token("kw", word.lower(), position))
            elif following < len(text) and text[following] == "(" and "." not in word:
                tokens.append(Token("func", word.upper(), position))
            elif KEY_PATH.match(word):
                tokens.append(Token("name", word, position))
            else:
                raise FormulaError("formula_syntax", f"'{word}' is not a field key (keys are lower case)", position)
        elif char == "(":
            tokens.append(Token("lparen", char, position))
            at += 1
        elif char == ")":
            tokens.append(Token("rparen", char, position))
            at += 1
        elif char == ",":
            tokens.append(Token("comma", char, position))
            at += 1
        else:
            operator = next((op for op in OPERATORS if text.startswith(op, at)), None)
            if operator is None:
                raise FormulaError("formula_syntax", f"Unexpected character '{char}'", position)
            tokens.append(Token("op", {"==": "=", "<>": "!="}.get(operator, operator), position))
            at += len(operator)
        if len(tokens) > MAX_TOKENS:
            raise FormulaError("formula_too_complex", f"Formulas are limited to {MAX_TOKENS} tokens", position)
    tokens.append(Token("end", None, len(text) + 1))
    return tokens


def _read_string(text: str, start: int) -> tuple[int, str]:
    quote = text[start]
    out: list[str] = []
    at = start + 1
    while at < len(text):
        char = text[at]
        if char == "\\" and at + 1 < len(text) and text[at + 1] in ("\\", "'", '"'):
            out.append(text[at + 1])
            at += 2
        elif char == quote:
            return at + 1, "".join(out)
        else:
            out.append(char)
            at += 1
    raise FormulaError("formula_syntax", "Text is not closed", start + 1)


class _Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.at = 0
        self.depth = 0

    def peek(self) -> Token:
        return self.tokens[self.at]

    def take(self) -> Token:
        token = self.tokens[self.at]
        self.at += 1
        return token

    def enter(self, token: Token) -> None:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise FormulaError("formula_too_complex", f"Formulas may nest at most {MAX_DEPTH} levels", token.position)

    def parse(self) -> tuple:
        node = self.or_()
        token = self.peek()
        if token.kind != "end":
            raise FormulaError("formula_syntax", f"Unexpected '{token.value}'", token.position)
        return node

    def or_(self) -> tuple:
        self.enter(self.peek())
        node = self.and_()
        while self.peek().kind == "kw" and self.peek().value == "or":
            self.take()
            node = ("or", node, self.and_())
        self.depth -= 1
        return node

    def and_(self) -> tuple:
        node = self.not_()
        while self.peek().kind == "kw" and self.peek().value == "and":
            self.take()
            node = ("and", node, self.not_())
        return node

    def not_(self) -> tuple:
        token = self.peek()
        if token.kind == "kw" and token.value == "not":
            self.take()
            self.enter(token)
            node = ("not", self.not_())
            self.depth -= 1
            return node
        return self.comparison()

    def comparison(self) -> tuple:
        node = self.additive()
        token = self.peek()
        if token.kind == "op" and token.value in COMPARISONS:
            self.take()
            node = ("bin", token.value, node, self.additive())
            following = self.peek()
            if following.kind == "op" and following.value in COMPARISONS:
                raise FormulaError("formula_syntax", "Comparisons cannot be chained; use AND", following.position)
        return node

    def additive(self) -> tuple:
        node = self.multiplicative()
        while self.peek().kind == "op" and self.peek().value in ("+", "-"):
            node = ("bin", self.take().value, node, self.multiplicative())
        return node

    def multiplicative(self) -> tuple:
        node = self.unary()
        while self.peek().kind == "op" and self.peek().value in ("*", "/", "%"):
            node = ("bin", self.take().value, node, self.unary())
        return node

    def unary(self) -> tuple:
        token = self.peek()
        if token.kind == "op" and token.value in ("-", "+"):
            self.take()
            self.enter(token)
            operand = self.unary()
            self.depth -= 1
            return ("neg", operand) if token.value == "-" else operand
        return self.power()

    def power(self) -> tuple:
        base = self.primary()
        if self.peek().kind == "op" and self.peek().value == "^":
            token = self.take()
            self.enter(token)
            exponent = self.unary()
            self.depth -= 1
            return ("bin", "^", base, exponent)
        return base

    def primary(self) -> tuple:
        token = self.take()
        if token.kind == "num":
            return ("num", token.value)
        if token.kind == "str":
            return ("str", token.value)
        if token.kind == "kw" and token.value in ("true", "false"):
            return ("bool", token.value == "true")
        if token.kind == "kw" and token.value == "null":
            return ("null",)
        if token.kind == "name":
            return ("ref", token.value, token.position)
        if token.kind == "func":
            return self.call(token)
        if token.kind == "lparen":
            node = self.or_()  # or_() counts the nesting level
            closing = self.take()
            if closing.kind != "rparen":
                raise FormulaError("formula_syntax", "Missing ')'", closing.position)
            return node
        if token.kind == "end":
            raise FormulaError("formula_syntax", "The formula ends too early", token.position)
        raise FormulaError("formula_syntax", f"Unexpected '{token.value}'", token.position)

    def call(self, token: Token) -> tuple:
        name = token.value
        if name not in FUNCTIONS:
            raise FormulaError("unknown_function", f"Unknown function {name}", token.position)
        self.take()  # "("
        self.enter(token)
        args: list[tuple] = []
        if self.peek().kind != "rparen":
            args.append(self.or_())
            while self.peek().kind == "comma":
                self.take()
                args.append(self.or_())
        closing = self.take()
        if closing.kind != "rparen":
            raise FormulaError("formula_syntax", f"Missing ')' after the arguments of {name}", closing.position)
        self.depth -= 1
        low, high = FUNCTIONS[name]
        if len(args) < low or (high is not None and len(args) > high):
            expected = f"{low}" if low == high else f"{low} or more" if high is None else f"{low}-{high}"
            raise FormulaError("invalid_arguments", f"{name} takes {expected} argument(s)", token.position)
        return ("call", name, args, token.position)


def parse(text: str) -> tuple:
    """AST of a formula; raises FormulaError."""
    return _Parser(tokenize(text)).parse()


def references(node: tuple) -> list[tuple[str, int]]:
    """Field keys a formula reads, with their positions, in order of appearance."""
    out: list[tuple[str, int]] = []

    def walk(item: tuple) -> None:
        kind = item[0]
        if kind == "ref":
            out.append((item[1], item[2]))
        elif kind in ("neg", "not"):
            walk(item[1])
        elif kind in ("and", "or"):
            walk(item[1])
            walk(item[2])
        elif kind == "bin":
            walk(item[2])
            walk(item[3])
        elif kind == "call":
            for arg in item[2]:
                walk(arg)

    walk(node)
    return out


def rename(text: str, mapping: dict[str, str]) -> str:
    """Rewrite field keys in a formula (calculator templates, Phase 2.5). Works on tokens, so text in quotes
    and function names are never touched."""
    out = text
    for token in reversed(tokenize(text)):
        if token.kind == "name" and token.value in mapping:
            start = token.position - 1
            out = out[:start] + mapping[token.value] + out[start + len(token.value):]
    return out


def check(text: str, known: Callable[[str], bool]) -> list[FormulaError]:
    """Static problems of a formula: syntax, functions, arity, and keys `known` does not accept."""
    try:
        node = parse(text)
    except FormulaError as error:
        return [error]
    return [FormulaError("unknown_field_reference", f"'{name}' is not a field key of this form", position)
            for name, position in references(node) if not known(name)]


# ------------------------------------------------------------------------------------------------
# Evaluation
# ------------------------------------------------------------------------------------------------

def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _finite(value: float | None) -> float | None:
    return value if value is not None and math.isfinite(value) else None


def truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, (str, list)):
        return len(value) > 0
    return True


def _same_kind(a: Any, b: Any) -> bool:
    numbers = _num(a) is not None and _num(b) is not None
    return numbers or (isinstance(a, str) and isinstance(b, str)) or (isinstance(a, bool) and isinstance(b, bool))


def equal(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if not _same_kind(a, b):
        return False
    return (_num(a) == _num(b)) if _num(a) is not None else a == b


def _compare(op: str, a: Any, b: Any) -> bool | None:
    if op == "=":
        return equal(a, b)
    if op == "!=":
        return not equal(a, b)
    if a is None or b is None:
        return None  # unknown: a rule with a missing input passes, a condition on it is false
    if isinstance(a, bool) or isinstance(b, bool) or not _same_kind(a, b):
        return False
    x, y = (_num(a), _num(b)) if _num(a) is not None else (a, b)
    return {"<": x < y, "<=": x <= y, ">": x > y, ">=": x >= y}[op]


def _arithmetic(op: str, a: Any, b: Any) -> float | None:
    x, y = _num(a), _num(b)
    if x is None or y is None:
        return None
    if op == "+":
        return _finite(x + y)
    if op == "-":
        return _finite(x - y)
    if op == "*":
        return _finite(x * y)
    if op == "/":
        return None if y == 0 else _finite(x / y)
    if op == "%":
        return None if y == 0 else _finite(math.fmod(x, y))
    try:
        return _finite(math.pow(x, y))
    except (OverflowError, ValueError, ZeroDivisionError):
        return None


def round_half_away(value: float, digits: int = 0) -> float:
    factor = 10.0 ** digits
    rounded = math.floor(abs(value) * factor + 0.5) / factor
    return -rounded if value < 0 else rounded


def _flatten(values: Iterable[Any]) -> list[Any]:
    out: list[Any] = []
    for value in values:
        if isinstance(value, list):
            out.extend(value)
        else:
            out.append(value)
    return out


def _date(value: Any) -> date | None:
    match = DATE_PREFIX.match(value) if isinstance(value, str) else None
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _call(name: str, args: list[tuple], lookup: Callable[[str], Any], today: str) -> Any:
    if name == "IF":
        return evaluate(args[1] if truthy(evaluate(args[0], lookup, today)) else args[2], lookup, today)
    values = [evaluate(arg, lookup, today) for arg in args]
    if name in ("MIN", "MAX", "SUM", "AVG"):
        numbers = [number for number in (_num(item) for item in _flatten(values)) if number is not None]
        # Plain left-to-right addition, exactly like the TypeScript twin (math.fsum could differ in the last digit).
        total = 0.0
        for number in numbers:
            total += number
        if name == "SUM":
            return _finite(total)
        if not numbers:
            return None
        return min(numbers) if name == "MIN" else max(numbers) if name == "MAX" else _finite(total / len(numbers))
    if name == "COUNT":
        return float(sum(1 for item in _flatten(values) if item is not None and item != ""))
    if name == "COALESCE":
        return next((item for item in values if item is not None and item != ""), None)
    if name == "ISBLANK":
        return values[0] is None or values[0] == "" or values[0] == []
    if name == "TODAY":
        return today
    if name in ("AGE", "DAYS"):
        first = _date(values[0])
        second = _date(values[1] if len(values) > 1 else today)
        if first is None or second is None:
            return None
        if name == "DAYS":
            return float((second - first).days)
        if first > second:
            return None  # not born yet
        years = second.year - first.year - (1 if (second.month, second.day) < (first.month, first.day) else 0)
        return float(years)
    number = _num(values[0])
    if number is None:
        return None
    if name == "ROUND":
        digits = _num(values[1]) if len(values) > 1 else 0.0
        if digits is None or digits != int(digits) or not 0 <= digits <= 10:
            return None
        return round_half_away(number, int(digits))
    if name == "FLOOR":
        return float(math.floor(number))
    if name == "CEIL":
        return float(math.ceil(number))
    if name == "ABS":
        return abs(number)
    return math.sqrt(number) if number >= 0 else None  # SQRT


def evaluate(node: tuple, lookup: Callable[[str], Any], today: str) -> Any:
    """Value of an AST. `lookup(key)` gives a field value (a list for repeat columns such as meds.dose)."""
    kind = node[0]
    if kind in ("num", "str", "bool"):
        return node[1]
    if kind == "null":
        return None
    if kind == "ref":
        value = lookup(node[1])
        return float(value) if _num(value) is not None else value
    if kind == "neg":
        value = _num(evaluate(node[1], lookup, today))
        return None if value is None else -value
    if kind == "not":
        return not truthy(evaluate(node[1], lookup, today))
    if kind == "and":
        return truthy(evaluate(node[1], lookup, today)) and truthy(evaluate(node[2], lookup, today))
    if kind == "or":
        return truthy(evaluate(node[1], lookup, today)) or truthy(evaluate(node[2], lookup, today))
    if kind == "bin":
        op = node[1]
        a, b = evaluate(node[2], lookup, today), evaluate(node[3], lookup, today)
        return _compare(op, a, b) if op in COMPARISONS else _arithmetic(op, a, b)
    return _call(node[1], node[2], lookup, today)


def run(text: str, values: dict[str, Any], today: str) -> Any:
    """Parse and evaluate against a flat {key: value} map (tests and tools)."""
    return evaluate(parse(text), values.get, today)
