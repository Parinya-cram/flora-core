/**
 * Safe formula language (Phase 2.4): tokenizer -> parser -> AST -> evaluator. Twin of
 * services/flora-api/app/formdev/logic/formula.py; both run formdev/spec/fixtures/formula-cases.json.
 * Formulas are never executed as code (no eval or Function constructor). Language reference: formdev/spec/LOGIC.md.
 */

export const MAX_LENGTH = 2000;
export const MAX_TOKENS = 1000;
export const MAX_DEPTH = 64;
const KEYWORDS = ["and", "or", "not", "true", "false", "null"];
/** name -> [minimum arguments, maximum arguments or null] */
export const FUNCTIONS: Readonly<Record<string, [number, number | null]>> = {
  IF: [3, 3], MIN: [1, null], MAX: [1, null], SUM: [1, null], AVG: [1, null], COUNT: [1, null],
  ROUND: [1, 2], FLOOR: [1, 1], CEIL: [1, 1], ABS: [1, 1], SQRT: [1, 1], COALESCE: [1, null],
  ISBLANK: [1, 1], AGE: [1, 2], DAYS: [2, 2], TODAY: [0, 0],
};
const COMPARISONS = ["=", "!=", "<", "<=", ">", ">="];
const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/y;
const KEY_PATH = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const OPERATORS = ["<=", ">=", "!=", "<>", "==", "+", "-", "*", "/", "%", "^", "=", "<", ">"];
const SPACE = " \t\r\n";

export type FormulaValue = number | string | boolean | null | FormulaValue[];

export class FormulaError extends Error {
  readonly code: string;
  /** 1-based column */
  readonly position: number;

  constructor(code: string, message: string, position: number) {
    super(message);
    this.name = "FormulaError";
    this.code = code;
    this.position = position;
  }
}

type Token = { kind: "num" | "str" | "name" | "func" | "kw" | "op" | "lparen" | "rparen" | "comma" | "end"; value: string | number | null; position: number };

export type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "ref"; name: string; position: number }
  | { kind: "neg" | "not"; operand: Node }
  | { kind: "and" | "or"; left: Node; right: Node }
  | { kind: "bin"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[]; position: number };

const isDigit = (char: string) => char >= "0" && char <= "9";
const isAlpha = (char: string) => /[A-Za-z]/.test(char);

export function tokenize(text: string): Token[] {
  if (typeof text !== "string") throw new FormulaError("formula_syntax", "A formula must be text", 1);
  if (text.length > MAX_LENGTH) throw new FormulaError("formula_too_complex", `Formulas are limited to ${MAX_LENGTH} characters`, 1);
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    const position = at + 1;
    if (SPACE.includes(char)) {
      at += 1;
      continue;
    }
    if (isDigit(char)) {
      NUMBER.lastIndex = at;
      const match = NUMBER.exec(text) as RegExpExecArray;
      tokens.push({ kind: "num", value: Number(match[0]), position });
      at = NUMBER.lastIndex;
    } else if (char === "'" || char === "\"") {
      const [next, value] = readString(text, at);
      tokens.push({ kind: "str", value, position });
      at = next;
    } else if (isAlpha(char) || char === "_") {
      WORD.lastIndex = at;
      const word = (WORD.exec(text) as RegExpExecArray)[0];
      at = WORD.lastIndex;
      let following = at;
      while (following < text.length && SPACE.includes(text[following])) following += 1;
      if (KEYWORDS.includes(word.toLowerCase())) tokens.push({ kind: "kw", value: word.toLowerCase(), position });
      else if (following < text.length && text[following] === "(" && !word.includes(".")) tokens.push({ kind: "func", value: word.toUpperCase(), position });
      else if (KEY_PATH.test(word)) tokens.push({ kind: "name", value: word, position });
      else throw new FormulaError("formula_syntax", `'${word}' is not a field key (keys are lower case)`, position);
    } else if (char === "(") {
      tokens.push({ kind: "lparen", value: char, position });
      at += 1;
    } else if (char === ")") {
      tokens.push({ kind: "rparen", value: char, position });
      at += 1;
    } else if (char === ",") {
      tokens.push({ kind: "comma", value: char, position });
      at += 1;
    } else {
      const operator = OPERATORS.find(op => text.startsWith(op, at));
      if (operator === undefined) throw new FormulaError("formula_syntax", `Unexpected character '${char}'`, position);
      tokens.push({ kind: "op", value: operator === "==" ? "=" : operator === "<>" ? "!=" : operator, position });
      at += operator.length;
    }
    if (tokens.length > MAX_TOKENS) throw new FormulaError("formula_too_complex", `Formulas are limited to ${MAX_TOKENS} tokens`, position);
  }
  tokens.push({ kind: "end", value: null, position: text.length + 1 });
  return tokens;
}

function readString(text: string, start: number): [number, string] {
  const quote = text[start];
  let out = "";
  let at = start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\" && at + 1 < text.length && ["\\", "'", "\""].includes(text[at + 1])) {
      out += text[at + 1];
      at += 2;
    } else if (char === quote) {
      return [at + 1, out];
    } else {
      out += char;
      at += 1;
    }
  }
  throw new FormulaError("formula_syntax", "Text is not closed", start + 1);
}

class Parser {
  private at = 0;
  private depth = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.at];
  }

  private take(): Token {
    return this.tokens[this.at++];
  }

  private enter(token: Token) {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new FormulaError("formula_too_complex", `Formulas may nest at most ${MAX_DEPTH} levels`, token.position);
  }

  private isKeyword(value: string) {
    const token = this.peek();
    return token.kind === "kw" && token.value === value;
  }

  private isOp(...values: string[]) {
    const token = this.peek();
    return token.kind === "op" && values.includes(token.value as string);
  }

  parse(): Node {
    const node = this.or();
    const token = this.peek();
    if (token.kind !== "end") throw new FormulaError("formula_syntax", `Unexpected '${String(token.value)}'`, token.position);
    return node;
  }

  private or(): Node {
    this.enter(this.peek());
    let node = this.and();
    while (this.isKeyword("or")) {
      this.take();
      node = { kind: "or", left: node, right: this.and() };
    }
    this.depth -= 1;
    return node;
  }

  private and(): Node {
    let node = this.not();
    while (this.isKeyword("and")) {
      this.take();
      node = { kind: "and", left: node, right: this.not() };
    }
    return node;
  }

  private not(): Node {
    const token = this.peek();
    if (token.kind === "kw" && token.value === "not") {
      this.take();
      this.enter(token);
      const node: Node = { kind: "not", operand: this.not() };
      this.depth -= 1;
      return node;
    }
    return this.comparison();
  }

  private comparison(): Node {
    let node = this.additive();
    const token = this.peek();
    if (token.kind === "op" && COMPARISONS.includes(token.value as string)) {
      this.take();
      node = { kind: "bin", op: token.value as string, left: node, right: this.additive() };
      const following = this.peek();
      if (following.kind === "op" && COMPARISONS.includes(following.value as string)) throw new FormulaError("formula_syntax", "Comparisons cannot be chained; use AND", following.position);
    }
    return node;
  }

  private additive(): Node {
    let node = this.multiplicative();
    while (this.isOp("+", "-")) node = { kind: "bin", op: this.take().value as string, left: node, right: this.multiplicative() };
    return node;
  }

  private multiplicative(): Node {
    let node = this.unary();
    while (this.isOp("*", "/", "%")) node = { kind: "bin", op: this.take().value as string, left: node, right: this.unary() };
    return node;
  }

  private unary(): Node {
    const token = this.peek();
    if (token.kind === "op" && (token.value === "-" || token.value === "+")) {
      this.take();
      this.enter(token);
      const operand = this.unary();
      this.depth -= 1;
      return token.value === "-" ? { kind: "neg", operand } : operand;
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.isOp("^")) {
      const token = this.take();
      this.enter(token);
      const exponent = this.unary();
      this.depth -= 1;
      return { kind: "bin", op: "^", left: base, right: exponent };
    }
    return base;
  }

  private primary(): Node {
    const token = this.take();
    if (token.kind === "num") return { kind: "num", value: token.value as number };
    if (token.kind === "str") return { kind: "str", value: token.value as string };
    if (token.kind === "kw" && (token.value === "true" || token.value === "false")) return { kind: "bool", value: token.value === "true" };
    if (token.kind === "kw" && token.value === "null") return { kind: "null" };
    if (token.kind === "name") return { kind: "ref", name: token.value as string, position: token.position };
    if (token.kind === "func") return this.call(token);
    if (token.kind === "lparen") {
      const node = this.or(); // or() counts the nesting level
      const closing = this.take();
      if (closing.kind !== "rparen") throw new FormulaError("formula_syntax", "Missing ')'", closing.position);
      return node;
    }
    if (token.kind === "end") throw new FormulaError("formula_syntax", "The formula ends too early", token.position);
    throw new FormulaError("formula_syntax", `Unexpected '${String(token.value)}'`, token.position);
  }

  private call(token: Token): Node {
    const name = token.value as string;
    if (!Object.hasOwn(FUNCTIONS, name)) throw new FormulaError("unknown_function", `Unknown function ${name}`, token.position);
    this.take(); // "("
    this.enter(token);
    const args: Node[] = [];
    if (this.peek().kind !== "rparen") {
      args.push(this.or());
      while (this.peek().kind === "comma") {
        this.take();
        args.push(this.or());
      }
    }
    const closing = this.take();
    if (closing.kind !== "rparen") throw new FormulaError("formula_syntax", `Missing ')' after the arguments of ${name}`, closing.position);
    this.depth -= 1;
    const [low, high] = FUNCTIONS[name];
    if (args.length < low || (high !== null && args.length > high)) {
      const expected = low === high ? `${low}` : high === null ? `${low} or more` : `${low}-${high}`;
      throw new FormulaError("invalid_arguments", `${name} takes ${expected} argument(s)`, token.position);
    }
    return { kind: "call", name, args, position: token.position };
  }
}

/** AST of a formula; throws FormulaError. */
export const parse = (text: string): Node => new Parser(tokenize(text)).parse();

/** Field keys a formula reads, with their positions, in order of appearance. */
export function references(node: Node): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const walk = (item: Node) => {
    if (item.kind === "ref") out.push([item.name, item.position]);
    else if (item.kind === "neg" || item.kind === "not") walk(item.operand);
    else if (item.kind === "and" || item.kind === "or" || item.kind === "bin") {
      walk(item.left);
      walk(item.right);
    } else if (item.kind === "call") item.args.forEach(walk);
  };
  walk(node);
  return out;
}

/** Rewrite field keys in a formula (calculator templates, Phase 2.5); token-based, so quoted text is untouched. */
export function rename(text: string, mapping: Record<string, string>): string {
  let out = text;
  for (const token of tokenize(text).reverse()) {
    if (token.kind === "name" && Object.hasOwn(mapping, token.value as string)) {
      const start = token.position - 1;
      out = out.slice(0, start) + mapping[token.value as string] + out.slice(start + (token.value as string).length);
    }
  }
  return out;
}

/** Static problems of a formula: syntax, functions, arity, and keys `known` does not accept. */
export function check(text: string, known: (name: string) => boolean): FormulaError[] {
  let node: Node;
  try {
    node = parse(text);
  } catch (error) {
    if (error instanceof FormulaError) return [error];
    throw error;
  }
  return references(node).filter(([name]) => !known(name)).map(([name, position]) => new FormulaError("unknown_field_reference", `'${name}' is not a field key of this form`, position));
}

// Evaluation ---------------------------------------------------------------------------------------

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const finite = (value: number | null): number | null => (value !== null && Number.isFinite(value) ? value : null);

export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return true;
}

const sameKind = (a: unknown, b: unknown) =>
  (num(a) !== null && num(b) !== null) || (typeof a === "string" && typeof b === "string") || (typeof a === "boolean" && typeof b === "boolean");

export function equal(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === null && (b ?? null) === null;
  if (!sameKind(a, b)) return false;
  return a === b;
}

function compare(op: string, a: FormulaValue, b: FormulaValue): boolean | null {
  if (op === "=") return equal(a, b);
  if (op === "!=") return !equal(a, b);
  if (a === null || b === null) return null; // unknown: a rule with a missing input passes, a condition on it is false
  if (typeof a === "boolean" || typeof b === "boolean" || !sameKind(a, b)) return false;
  const [x, y] = [a as number | string, b as number | string];
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

function arithmetic(op: string, a: unknown, b: unknown): number | null {
  const x = num(a);
  const y = num(b);
  if (x === null || y === null) return null;
  if (op === "+") return finite(x + y);
  if (op === "-") return finite(x - y);
  if (op === "*") return finite(x * y);
  if (op === "/") return y === 0 ? null : finite(x / y);
  if (op === "%") return y === 0 ? null : finite(x % y);
  return finite(Math.pow(x, y));
}

export function roundHalfAway(value: number, digits = 0): number {
  const factor = 10 ** digits;
  const rounded = Math.floor(Math.abs(value) * factor + 0.5) / factor;
  return value < 0 ? -rounded : rounded;
}

const flatten = (values: FormulaValue[]): FormulaValue[] => values.flatMap(value => (Array.isArray(value) ? value : [value]));

function toDate(value: unknown): number | null {
  const match = typeof value === "string" ? DATE_PREFIX.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? time : null;
}

function callFunction(name: string, args: Node[], lookup: (key: string) => unknown, today: string): FormulaValue {
  if (name === "IF") return evaluate(truthy(evaluate(args[0], lookup, today)) ? args[1] : args[2], lookup, today);
  const values = args.map(arg => evaluate(arg, lookup, today));
  if (name === "MIN" || name === "MAX" || name === "SUM" || name === "AVG") {
    const numbers = flatten(values).map(num).filter((value): value is number => value !== null);
    let total = 0;
    for (const value of numbers) total += value;
    if (name === "SUM") return finite(total);
    if (!numbers.length) return null;
    return name === "MIN" ? Math.min(...numbers) : name === "MAX" ? Math.max(...numbers) : finite(total / numbers.length);
  }
  if (name === "COUNT") return flatten(values).filter(item => item !== null && item !== "").length;
  if (name === "COALESCE") return values.find(item => item !== null && item !== "") ?? null;
  if (name === "ISBLANK") return values[0] === null || values[0] === "" || (Array.isArray(values[0]) && values[0].length === 0);
  if (name === "TODAY") return today;
  if (name === "AGE" || name === "DAYS") {
    const first = toDate(values[0]);
    const second = toDate(values.length > 1 ? values[1] : today);
    if (first === null || second === null) return null;
    if (name === "DAYS") return Math.round((second - first) / 86400000);
    if (first > second) return null; // not born yet
    const a = new Date(first);
    const b = new Date(second);
    const before = b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate());
    return b.getUTCFullYear() - a.getUTCFullYear() - (before ? 1 : 0);
  }
  const number = num(values[0]);
  if (number === null) return null;
  if (name === "ROUND") {
    const digits = values.length > 1 ? num(values[1]) : 0;
    if (digits === null || !Number.isInteger(digits) || digits < 0 || digits > 10) return null;
    return roundHalfAway(number, digits);
  }
  if (name === "FLOOR") return Math.floor(number);
  if (name === "CEIL") return Math.ceil(number);
  if (name === "ABS") return Math.abs(number);
  return number >= 0 ? Math.sqrt(number) : null; // SQRT
}

/** Value of an AST. `lookup(key)` gives a field value (a list for repeat columns such as meds.dose). */
export function evaluate(node: Node, lookup: (key: string) => unknown, today: string): FormulaValue {
  switch (node.kind) {
    case "num":
    case "str":
    case "bool":
      return node.value;
    case "null":
      return null;
    case "ref": {
      const value = lookup(node.name);
      return value === undefined ? null : (value as FormulaValue);
    }
    case "neg": {
      const value = num(evaluate(node.operand, lookup, today));
      return value === null ? null : -value;
    }
    case "not":
      return !truthy(evaluate(node.operand, lookup, today));
    case "and":
      return truthy(evaluate(node.left, lookup, today)) && truthy(evaluate(node.right, lookup, today));
    case "or":
      return truthy(evaluate(node.left, lookup, today)) || truthy(evaluate(node.right, lookup, today));
    case "bin": {
      const a = evaluate(node.left, lookup, today);
      const b = evaluate(node.right, lookup, today);
      return COMPARISONS.includes(node.op) ? compare(node.op, a, b) : arithmetic(node.op, a, b);
    }
    default:
      return callFunction(node.name, node.args, lookup, today);
  }
}

/** Parse and evaluate against a flat {key: value} map (tests and tools). */
export const run = (text: string, values: Record<string, unknown>, today: string): FormulaValue => evaluate(parse(text), key => values[key], today);
