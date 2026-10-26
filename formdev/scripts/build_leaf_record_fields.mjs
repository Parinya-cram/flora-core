#!/usr/bin/env node
/**
 * The catalog of Flora Leaf's anesthesia record fields (frontend/src/views/FormView.tsx) for Form Studio: every field of
 * the record's draft with its tab, label, kind and options, and the bind key a Form Studio field uses to share it in
 * both directions ("record.<snake_case key>", see services/flora-api/app/record_link.py).
 *
 * Read from the code itself with the TypeScript compiler, so a field added to the Leaf record appears after a re-run:
 *   - the fields: the object returned by defaults() (a field's default value gives its kind);
 *   - labels, kinds and options: the helper call that draws each field (t, s, r, c, a, b, rCode, cCode, choiceSelect,
 *     scorePicker, smallCounterField), with option lists written inline, as split("a|b"), or from the `options` table;
 *   - the tab: the <section> whose className tests `activeTab === "<tab>"` around the call, else the key's prefix.
 *
 *   node formdev/scripts/build_leaf_record_fields.mjs          # write both copies
 *   node formdev/scripts/build_leaf_record_fields.mjs --check  # exit 1 when out of date
 *
 * Copies: services/flora-api/app/record_fields.json and frontend/src/formdev/leaf/recordFields.ts (the same list).
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(ROOT, "frontend/package.json"));
const ts = require("typescript");
const SOURCE = resolve(ROOT, "frontend/src/views/FormView.tsx");
const JSON_TARGET = resolve(ROOT, "services/flora-api/app/record_fields.json");
const TS_TARGET = resolve(ROOT, "frontend/src/formdev/leaf/recordFields.ts");

const TABS = {
  caseInfo: "Case & Plan", preop: "Pre-anesthesia", checklist: "Safety Checklist", ga_ett: "GA ETT", ga_lma: "GA LMA",
  ga_tubeless: "GA Tubeless", neuraxial: "Neuraxial Block", pnb: "PNB", line: "Line", comorbid: "Comorbid",
  extubation: "Extubation", pacu: "Recovery / PACU", pain: "Pain", outcome: "Outcome",
};
const TAB_TH = {
  caseInfo: "ข้อมูลเคสและแผน", preop: "ประเมินก่อนระงับความรู้สึก", checklist: "Safety Checklist", ga_ett: "GA ใส่ท่อช่วยหายใจ",
  ga_lma: "GA LMA", ga_tubeless: "GA ไม่ใส่ท่อ", neuraxial: "Neuraxial block", pnb: "Peripheral nerve block", line: "สายสวน / หลอดเลือด",
  comorbid: "โรคร่วม", extubation: "ถอดท่อช่วยหายใจ", pacu: "ห้องพักฟื้น (PACU)", pain: "ความปวด", outcome: "ผลลัพธ์",
};
/** Tab of a field drawn nowhere with a label: by its key's start. */
const PREFIX_TABS = [
  [/^preop/, "preop"], [/^checklist/, "checklist"], [/^pacu/, "pacu"], [/^pain/, "pain"], [/^outcome/, "outcome"],
  [/^(invasive|cvc|iv|arterial|line)/i, "line"], [/^pnb/, "pnb"], [/^(neuraxial|spinal|epidural)/, "neuraxial"],
  [/^extubation|airway_device_removed|suction_performed/, "extubation"], [/^comorbid|currentMedication/, "comorbid"],
  [/^(lma)/, "ga_lma"], [/^(secondary_|primary_|airway_)/, "ga_ett"], [/^(ga|oral_|nasal_|trach|mask_|opa_|npa_|jet_|blade|guide|laryngo|attempt|vdo|size_mm)/i, "ga_ett"],
];
/** Helpers that draw a field: kind, and which argument holds its options. */
const HELPERS = {
  t: { kind: "text" }, a: { kind: "textarea" }, b: { kind: "boolean" }, s: { kind: "choice", options: 2 }, r: { kind: "choice", options: 2 },
  rCode: { kind: "choice", options: 2 }, choiceSelect: { kind: "choice", options: 2 }, c: { kind: "multi", options: 2 },
  cCode: { kind: "multi", options: 2 }, scorePicker: { kind: "integer" }, smallCounterField: { kind: "integer" },
};
/** Internal keys, not clinical fields. */
const SKIP = new Set(["innovianLegacyFields", "enabledForms"]);
/** Fields the record keeps but other screens draw (the patient banner, case header): their label and kind. */
const KNOWN = {
  hn: ["HN", "text"], an: ["AN", "text"], dob: ["Date of birth", "date"], ageY: ["Age (years)", "integer"], ageM: ["Age (months)", "integer"],
  heightCm: ["Height (cm)", "number"], weightKg: ["Weight (kg)", "number"], bloodGroupABO: ["Blood group (ABO)", "text"],
  bloodGroupRh: ["Blood group (Rh)", "text"], asa: ["ASA class", "text"], emergency: ["Emergency case", "boolean"], service: ["Service", "text"],
  diagnosis: ["Diagnosis", "multi"], operation: ["Operation", "multi"], titleTh: ["Title (Thai)", "text"], firstName: ["First name", "text"],
  lastName: ["Last name", "text"], sex: ["Sex", "text"], idCard: ["National ID", "text"],
};
/** Words written in capitals, and units put in brackets, when a label is made from a key. */
const ACRONYMS = new Set(["iv", "cvc", "npo", "asa", "lma", "ett", "opa", "npa", "pnb", "pacu", "ecg", "spo2", "abo", "rh", "hn", "an", "or", "icu", "id", "nibp", "vdo"]);
const UNITS = { ml: "ml", cm: "cm", mm: "mm", kg: "kg", cmh2o: "cmH2O", min: "min", mg: "mg" };

const text = readFileSync(SOURCE, "utf8");
const file = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const str = node => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

// The `options` table: name → values (split("a|b"), string arrays, or {value,label} arrays).
const optionTable = {};
function optionsOf(node) {
  if (!node) return null;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "split" && str(node.arguments[0]) !== null) {
    return str(node.arguments[0]).split("|").map(value => ({ value, label: value }));
  }
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const element of node.elements) {
      if (str(element) !== null) out.push({ value: str(element), label: str(element) });
      else if (ts.isObjectLiteralExpression(element)) {
        const get = name => str(element.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === name)?.initializer);
        if (get("value") !== null) out.push({ value: get("value"), label: get("label") ?? get("value") });
      } else return null;
    }
    return out;
  }
  if (ts.isPropertyAccessExpression(node) && node.expression.getText() === "options") return optionTable[node.name.text] ?? null;
  return null;
}

let defaultsObject = null;
const sections = [];   // [start, end, tab]
const calls = [];      // {key, title, helper, node}
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText() === "options" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    for (const property of node.initializer.properties) {
      if (ts.isPropertyAssignment(property)) {
        const values = optionsOf(property.initializer);
        if (values) optionTable[property.name.getText()] = values;
      }
    }
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === "defaults") {
    const walk = inner => {
      if (ts.isReturnStatement(inner) && inner.expression && ts.isObjectLiteralExpression(inner.expression)) defaultsObject = inner.expression;
      else ts.forEachChild(inner, walk);
    };
    walk(node);
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === "section") {
    const match = node.openingElement.getText().match(/activeTab === "([a-zA-Z_]+)"/);
    if (match) sections.push([node.getStart(), node.getEnd(), match[1]]);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HELPERS[node.expression.text]) {
    const key = str(node.arguments[0]);
    const title = str(node.arguments[1]);
    if (key && title) calls.push({ key, title, helper: node.expression.text, node });
  }
  ts.forEachChild(node, visit);
}
visit(file);
if (!defaultsObject) throw new Error("defaults() was not found in FormView.tsx");

const kindOfDefault = node => {
  if (!node) return "text";
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(element => ts.isObjectLiteralExpression(element)) ? null : "multi";
  if (ts.isNumericLiteral(node)) return "number";
  return "text";
};
const snake = key => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
const humanize = key => {
  const words = snake(key).replace(/([a-z])(\d)/g, "$1_$2").split("_").filter(Boolean);
  const unit = words.length > 1 && UNITS[words[words.length - 1]] ? UNITS[words.pop()] : null;
  const text = words.map((word, index) => (ACRONYMS.has(word) ? word.toUpperCase() : index ? word : word[0].toUpperCase() + word.slice(1))).join(" ");
  return unit ? `${text} (${unit})` : text;
};
const tabAt = position => {
  const found = sections.filter(([start, end]) => start <= position && position <= end).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]))[0];
  return found ? found[2] : null;
};
const tabByPrefix = key => PREFIX_TABS.find(([pattern]) => pattern.test(key))?.[1] ?? "caseInfo";

const fields = new Map();
for (const property of defaultsObject.properties) {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
  const key = property.name.getText().replace(/^["']|["']$/g, "");
  if (SKIP.has(key)) continue;
  const kind = kindOfDefault(ts.isPropertyAssignment(property) ? property.initializer : null);
  if (kind === null) continue;
  fields.set(key, { key, kind, label: null, tab: null, options: null });
}
for (const call of calls) {
  const helper = HELPERS[call.helper];
  const field = fields.get(call.key) ?? { key: call.key, kind: helper.kind, label: null, tab: null, options: null };
  if (!field.label) {
    field.label = call.title;
    field.kind = helper.kind === "text" && call.node.arguments[2] && str(call.node.arguments[2]) === "number" ? "number"
      : helper.kind === "text" && call.node.arguments[2] && str(call.node.arguments[2]) === "date" ? "date" : helper.kind;
    if (helper.options !== undefined) field.options = optionsOf(call.node.arguments[helper.options]);
    if (call.helper === "scorePicker" || call.helper === "smallCounterField") {
      const max = call.node.arguments[2] && ts.isNumericLiteral(call.node.arguments[2]) ? Number(call.node.arguments[2].text) : call.helper === "scorePicker" ? 10 : 4;
      field.max = max;
    }
  }
  field.tab = field.tab ?? tabAt(call.node.getStart());
  fields.set(call.key, field);
}

const out = [];
const binds = new Set();
for (const field of fields.values()) {
  if (!field.label && KNOWN[field.key]) [field.label, field.kind] = KNOWN[field.key];
  // Options kept in the `options` table but drawn by another component: by name.
  const table = { anesthesiaTypes: "anesthesia", service: "serviceProvider", patientSafetyChecks: "patientSafety" }[field.key] ?? field.key;
  if (!field.options && (field.kind === "choice" || field.kind === "multi" || field.kind === "text") && optionTable[table]) {
    field.options = optionTable[table];
    if (field.kind === "text") field.kind = "choice";
  }
  if (/Time$|_time$/.test(field.key) && field.kind === "text") field.kind = "time";
  const bind = `record.${snake(field.key)}`;
  if (binds.has(bind)) throw new Error(`two Leaf fields give the same bind ${bind}`);
  binds.add(bind);
  // Sections inside a tab (e.g. "invasive" under Line) belong to that tab.
  const tab = { invasive: "line" }[field.tab] ?? field.tab ?? tabByPrefix(field.key);
  out.push({
    key: field.key, bind, tab, tab_en: TABS[tab] ?? tab, tab_th: TAB_TH[tab] ?? tab, label: field.label ?? humanize(field.key),
    labelled: field.label !== null && !KNOWN[field.key], kind: field.kind, ...(field.options?.length ? { options: field.options } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
  });
}
const tabOrder = Object.keys(TABS);
out.sort((x, y) => tabOrder.indexOf(x.tab) - tabOrder.indexOf(y.tab));
const json = `${JSON.stringify({ source: "frontend/src/views/FormView.tsx", generated_by: "formdev/scripts/build_leaf_record_fields.mjs", fields: out }, null, 1)}\n`;

const tsSource = `/**
 * Flora Leaf's anesthesia record fields (FormView.tsx), shared with Form Studio both ways by field.bind "record.<field>".
 * GENERATED by formdev/scripts/build_leaf_record_fields.mjs — do not edit; re-run it after changing the Leaf record.
 */
export type RecordFieldKind = "text" | "textarea" | "number" | "integer" | "date" | "time" | "choice" | "multi" | "boolean";
export type RecordField = {
  key: string; bind: string; tab: string; tab_en: string; tab_th: string; label: string; labelled: boolean; kind: RecordFieldKind;
  options?: Array<{ value: string; label: string }>; max?: number;
};

export const RECORD_FIELDS: RecordField[] = ${JSON.stringify(out, null, 1)};
`;
const outputs = [[JSON_TARGET, json], [TS_TARGET, tsSource]];
if (process.argv.includes("--check")) {
  const stale = outputs.filter(([target, content]) => { try { return readFileSync(target, "utf8") !== content; } catch { return true; } }).map(([target]) => target);
  if (stale.length) { console.error(`out of date: ${stale.join(", ")} — run node formdev/scripts/build_leaf_record_fields.mjs`); process.exit(1); }
  console.log(`up to date (${out.length} fields)`);
} else {
  for (const [target, content] of outputs) writeFileSync(target, content);
  const labelled = out.filter(field => field.labelled).length;
  const byTab = Object.fromEntries(tabOrder.map(tab => [tab, out.filter(field => field.tab === tab).length]));
  console.log(`${out.length} fields (${labelled} with the Leaf's own label), ${out.filter(field => field.options).length} with options`, byTab);
}
