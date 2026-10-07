/**
 * Settings of the selected field, grouped in plain language: basics, choices, calculation, auto-fill, when it
 * shows, checks, size and position, where it is used, who may see it, and the advanced key / JSON.
 */
import { useState } from "react";
import { fieldTypeSpec } from "../core/fieldTypes";
import type { FieldDefinition, FieldType, FormDefinition, LookupDerive, ValidationRules } from "../core/types";
import { fieldKey } from "../core/validate";
import { check } from "../logic/formula";
import { CALCULATOR_TEMPLATES } from "../registry/defaults";
import { instantiateTemplate } from "../logic/calculators";
import { FIELD_ACTIONS, PALETTE, PATTERNS, WIDTHS, tr, typeName, type Lang } from "./catalog";
import ConditionEditor from "./ConditionEditor";
import { Group, NumberField, SelectField, TextField, Toggle } from "./controls";
import { allFields, fieldAt, fieldPath, patchField, placeOnGrid, renameKey, samePath, uniqueName, usedNames, type FieldRef } from "./model";
import OptionsEditor, { type LookupInfo } from "./OptionsEditor";
import PermissionEditor from "./PermissionEditor";
import { input, label, small } from "./styles";

type Props = { definition: FormDefinition; fieldRef: FieldRef; lang: Lang; lookups: LookupInfo[]; publishedKeys: Set<string>; onChange: (next: FormDefinition) => void };
type Patch = Partial<Record<keyof FieldDefinition, unknown>>;

const NUMERIC = new Set(["number", "integer", "decimal", "calculated"]);
const TEXTUAL = new Set(["text", "textarea"]);
const CHOICE = new Set(["select", "radio", "multiselect"]);
const CONTAINER = new Set(["group", "repeat"]);
const DATES = new Set(["date", "datetime"]);
const INDEXABLE = new Set(["text", "number", "integer", "decimal", "date", "datetime", "time", "select", "radio", "checkbox", "switch", "calculated"]);
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

export default function FieldInspector({ definition, fieldRef, lang, lookups, publishedKeys, onChange }: Props) {
  const field = fieldAt(definition, fieldRef);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [templateId, setTemplateId] = useState("");
  if (!field) return null;
  const t = (th: string, en: string) => tr(lang, th, en);
  const set = (patch: Patch) => onChange(patchField(definition, fieldRef, patch));
  const rules: ValidationRules = field.validation ?? {};
  const setRules = (patch: Partial<Record<keyof ValidationRules, unknown>>) => {
    const next = { ...rules } as Record<string, unknown>;
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined || value === false) delete next[name];
      else next[name] = value;
    }
    set({ validation: Object.keys(next).length ? next : undefined });
  };
  const key = fieldKey(field);
  const type = field.type;
  const everyField = allFields(definition);
  const candidates = everyField
    .filter(entry => (entry.depth === 0 || samePath(entry.ref.list, fieldRef.list)) && !samePath(fieldPath(entry.ref), fieldPath(fieldRef)) && !CONTAINER.has(entry.field.type))
    .map(entry => entry.field);
  const knownName = (name: string) => everyField.some(entry => fieldKey(entry.field) === name)
    || (name.includes(".") && everyField.some(entry => entry.field.type === "repeat" && name.startsWith(`${fieldKey(entry.field)}.`)));

  const changeType = (next: FieldType) => {
    const patch: Patch = { type: next };
    const value = fieldTypeSpec(next)?.value;
    if (value === "option" || value === "options") { if (!field.options && !field.lookup) patch.options = [{ value: "opt_1", label: t("ตัวเลือก 1", "Option 1") }, { value: "opt_2", label: t("ตัวเลือก 2", "Option 2") }]; }
    else { patch.options = undefined; patch.lookup = undefined; }
    if (CONTAINER.has(next)) { if (!field.fields?.length) patch.fields = [{ id: uniqueName("item", usedNames(definition)), type: "text", label: t("รายการ", "Item") }]; }
    else patch.fields = undefined;
    if (next !== "calculated") { patch.calculator = undefined; patch.formula = undefined; } else patch.required = undefined;
    if (next !== "text") patch.derive = undefined;
    if (next !== "decimal" && next !== "calculated") patch.decimals = undefined;
    set(patch);
  };

  // Calculation -------------------------------------------------------------------------------
  const template = CALCULATOR_TEMPLATES.find(item => item.template_id === templateId);
  const calculator = (definition.calculators ?? []).find(item => item.id === field.calculator);
  const applyTemplate = () => {
    if (!template) return;
    const id = uniqueName(`${key}_calc`, usedNames(definition));
    const made = instantiateTemplate(template, mapping, id);
    const withCalc: FormDefinition = { ...definition, calculators: [...(definition.calculators ?? []), made] };
    const patch: Patch = { calculator: id, formula: undefined };
    if (!field.unit && template.output?.unit) patch.unit = template.output.unit;
    onChange(patchField(withCalc, fieldRef, patch));
    setMapping({});
  };
  const formulaErrors = typeof field.formula === "string" && field.formula.trim() ? check(field.formula, knownName) : [];

  // Auto-fill from a lookup ---------------------------------------------------------------------
  const derive = field.derive;
  const deriveTable = lookups.find(item => item.lookup_id === derive?.lookup);
  const setDerive = (patch: Partial<LookupDerive>) => {
    const next = { ...(derive ?? { lookup: lookups[0]?.lookup_id ?? "", column: "", match: {} }), ...patch } as LookupDerive;
    set({ derive: next, readonly: true });
  };

  // Layout -------------------------------------------------------------------------------------
  const span = field.layout?.span;
  const pattern = PATTERNS.find(item => Object.entries(item.rules).every(([name, value]) => (rules as Record<string, unknown>)[name] === value))?.id
    ?? (rules.pattern ? "custom" : "");

  return <div className="space-y-2">
    <div className="flex items-center justify-between">
      <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{typeName(type, lang)}</div>
      <code className="text-[11px] text-[var(--app-muted)]">{key}</code>
    </div>

    <Group title={t("ข้อมูลพื้นฐาน", "Basics")} open>
      <TextField label={t("ชื่อช่อง (ที่ผู้กรอกเห็น)", "Label")} value={field.label} onChange={value => set({ label: value ?? "" })} />
      <TextField label={t("คำอธิบายใต้ช่อง", "Help text")} value={field.description} onChange={value => set({ description: value })} />
      {TEXTUAL.has(type) || (NUMERIC.has(type) && type !== "calculated") || type === "select"
        ? <TextField label={t("ข้อความตัวอย่างในช่อง", "Placeholder")} value={field.placeholder} onChange={value => set({ placeholder: value })} /> : null}
      {NUMERIC.has(type) || type === "text" ? <TextField label={t("หน่วย", "Unit")} value={field.unit} placeholder="kg, mmHg, °C" onChange={value => set({ unit: value })} /> : null}
      {type === "decimal" || type === "calculated" ? <NumberField label={t("จำนวนตำแหน่งทศนิยม", "Decimal places")} value={field.decimals} min={0} max={10} onChange={value => set({ decimals: value })} /> : null}
      {!CONTAINER.has(type) && type !== "calculated" ? <Toggle label={t("ต้องกรอก", "Required")} checked={field.required === true} onChange={on => set({ required: on || undefined })} /> : null}
      {!CONTAINER.has(type) && type !== "calculated" ? <Toggle label={t("อ่านอย่างเดียว", "Read-only")} checked={field.readonly === true} onChange={on => set({ readonly: on || undefined })} /> : null}
      <SelectField label={t("ชนิดช่อง", "Field type")} value={type} onChange={value => changeType(value as FieldType)}
        options={PALETTE.flatMap(group => group.items).map(item => ({ value: item.type, label: tr(lang, item.th, item.en) }))} />
    </Group>

    {CHOICE.has(type) ? <Group title={t("ตัวเลือก", "Choices")} open badge={field.lookup ? t("ตาราง", "table") : String(field.options?.length ?? 0)}>
      <OptionsEditor field={field} candidates={candidates} lookups={lookups} lang={lang} onPatch={set} />
    </Group> : null}

    {type === "calculated" ? <Group title={t("การคำนวณ", "Calculation")} open>
      {calculator ? <div className="rounded-lg bg-[var(--app-control-bg)] p-2 text-xs text-[var(--app-text)]">
        <div className="font-semibold">{calculator.name ?? calculator.id}</div>
        <code className="block break-all text-[11px] text-[var(--app-muted)]">{calculator.formula}</code>
      </div> : null}
      <SelectField label={t("เลือกสูตรสำเร็จรูป", "Ready-made formula")} value={templateId} onChange={value => { setTemplateId(value); setMapping({}); }}
        options={[{ value: "", label: t("— เลือก —", "— choose —") }, ...CALCULATOR_TEMPLATES.map(item => ({ value: item.template_id, label: item.name }))]} />
      {template ? <div className="space-y-2">
        <p className="text-[11px] text-[var(--app-muted)]">{template.description}</p>
        {template.params.map(param => <label key={param.name} className="block space-y-1">
          <span className={label}>{param.label}{param.unit ? ` (${param.unit})` : ""}</span>
          <select className={input} value={mapping[param.name] ?? ""} onChange={event => setMapping({ ...mapping, [param.name]: event.target.value })}>
            <option value="">{t("— เลือกช่อง —", "— choose a field —")}</option>
            {candidates.map(other => <option key={fieldKey(other)} value={fieldKey(other)}>{other.label}</option>)}
          </select>
        </label>)}
        <button type="button" className={small} disabled={template.params.some(param => !mapping[param.name])} onClick={applyTemplate}>{t("ใช้สูตรนี้", "Use this formula")}</button>
      </div> : null}
      <details>
        <summary className="cursor-pointer text-[11px] text-[var(--app-muted)]">{t("หรือเขียนสูตรเอง", "Or write a formula")}</summary>
        <div className="mt-2 space-y-2">
          <TextField label={t("สูตร (ใช้ชื่อช่องภาษาอังกฤษ)", "Formula (use field keys)")} value={field.formula} mono multiline
            onChange={value => set({ formula: value, calculator: value ? undefined : field.calculator })} placeholder="weight_kg / ((height_cm / 100) ^ 2)" />
          <div className="flex flex-wrap gap-1">
            {candidates.filter(other => NUMERIC.has(other.type) || DATES.has(other.type)).map(other => <button key={fieldKey(other)} type="button" className={small}
              onClick={() => set({ formula: `${field.formula ?? ""}${field.formula ? " " : ""}${fieldKey(other)}`, calculator: undefined })}>{other.label}</button>)}
          </div>
          <p className="text-[11px] text-[var(--app-muted)]">{t("ใช้ได้: + - * / ^ ( ) IF MIN MAX SUM AVG ROUND AGE DAYS TODAY", "Available: + - * / ^ ( ) IF MIN MAX SUM AVG ROUND AGE DAYS TODAY")}</p>
          {formulaErrors.map((error, index) => <p key={index} className="text-[11px] text-rose-600 dark:text-rose-300">{error.message}</p>)}
        </div>
      </details>
    </Group> : null}

    {type === "text" && lookups.length ? <Group title={t("เติมค่าอัตโนมัติจากตาราง", "Auto-fill from a table")} badge={derive ? "✓" : undefined}>
      <Toggle label={t("เติมค่าให้อัตโนมัติ (เช่น รหัสไปรษณีย์จากตำบล)", "Fill automatically (e.g. postcode from sub-district)")} checked={derive !== undefined}
        onChange={on => (on ? setDerive({}) : set({ derive: undefined, readonly: undefined }))} />
      {derive ? <>
        <SelectField label={t("ตาราง", "Table")} value={derive.lookup} options={lookups.map(item => ({ value: item.lookup_id, label: item.metadata.title }))} onChange={value => setDerive({ lookup: value, column: "", match: {} })} />
        <SelectField label={t("เอาค่าจากคอลัมน์", "Take the value of column")} value={derive.column}
          options={[{ value: "", label: "—" }, ...(deriveTable?.metadata.columns ?? []).map(column => ({ value: column.name, label: column.label ?? column.name }))]} onChange={value => setDerive({ column: value })} />
        <span className={label}>{t("แถวที่ตรงกับ", "From the row where")}</span>
        {(deriveTable?.metadata.columns ?? []).filter(column => column.name !== derive.column).map(column => <label key={column.name} className="flex items-center gap-2 text-xs text-[var(--app-text)]">
          <span className="w-28 shrink-0">{column.label ?? column.name} =</span>
          <select className={input} value={derive.match[column.name] ?? ""} onChange={event => {
            const match = { ...derive.match };
            if (event.target.value) match[column.name] = event.target.value;
            else delete match[column.name];
            setDerive({ match });
          }}>
            <option value="">—</option>
            {candidates.map(other => <option key={fieldKey(other)} value={fieldKey(other)}>{other.label}</option>)}
          </select>
        </label>)}
      </> : null}
    </Group> : null}

    <Group title={t("แสดงเมื่อ (เงื่อนไข)", "Show when")} badge={field.visibility ? "✓" : undefined}>
      <p className="text-[11px] text-[var(--app-muted)]">{t("ไม่มีเงื่อนไข = แสดงเสมอ ช่องที่ซ่อนจะไม่ถูกบังคับกรอก", "No condition = always shown. Hidden fields are never required.")}</p>
      <ConditionEditor key={`vis-${key}`} condition={field.visibility?.when} candidates={candidates} lang={lang} onChange={when => set({ visibility: when ? { when } : undefined })} />
      {field.visibility ? <Toggle label={t("ล้างค่าเมื่อช่องถูกซ่อน", "Clear the value when hidden")} checked={field.clear_when_hidden === true}
        onChange={on => set({ clear_when_hidden: on || undefined })} /> : null}
    </Group>

    {!CONTAINER.has(type) && type !== "calculated" ? <Group title={t("การตรวจสอบค่า", "Checks")} badge={Object.keys(rules).length || field.min !== undefined || field.max !== undefined ? "✓" : undefined}>
      {NUMERIC.has(type) ? <div className="grid grid-cols-2 gap-2">
        <NumberField label={t("ค่าต่ำสุด", "Minimum")} value={field.min} onChange={value => set({ min: value })} />
        <NumberField label={t("ค่าสูงสุด", "Maximum")} value={field.max} onChange={value => set({ max: value })} />
      </div> : null}
      {TEXTUAL.has(type) ? <>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label={t("อย่างน้อย (ตัวอักษร)", "Min length")} value={rules.min_length} min={1} onChange={value => setRules({ min_length: value })} />
          <NumberField label={t("ไม่เกิน (ตัวอักษร)", "Max length")} value={field.max_length} min={1} onChange={value => set({ max_length: value })} />
        </div>
        <SelectField label={t("รูปแบบที่ต้องเป็น", "Format")} value={pattern} onChange={value => {
          const preset = PATTERNS.find(item => item.id === value);
          setRules({ pattern: undefined, email: undefined, numeric: undefined, ...(preset?.rules ?? {}), ...(value === "custom" ? { pattern: rules.pattern ?? ".*" } : {}) });
        }} options={[{ value: "", label: t("ไม่กำหนด", "Any") }, ...PATTERNS.map(item => ({ value: item.id, label: tr(lang, item.th, item.en) })), { value: "custom", label: t("กำหนดเอง (regex)", "Custom (regex)") }]} />
        {pattern === "custom" ? <TextField label="Regex" mono value={rules.pattern} onChange={value => setRules({ pattern: value })} /> : null}
      </> : null}
      {DATES.has(type) ? <div className="grid grid-cols-2 gap-2">
        <SelectField label={t("ไม่ก่อนวันที่", "Not before")} value={rules.min_date ?? ""} onChange={value => setRules({ min_date: value || undefined })}
          options={[{ value: "", label: t("ไม่กำหนด", "Any") }, { value: "today", label: t("วันนี้", "Today") }, { value: "today-30d", label: t("30 วันก่อน", "30 days ago") }, { value: "today-365d", label: t("1 ปีก่อน", "1 year ago") }]} />
        <SelectField label={t("ไม่หลังวันที่", "Not after")} value={rules.max_date ?? ""} onChange={value => setRules({ max_date: value || undefined })}
          options={[{ value: "", label: t("ไม่กำหนด", "Any") }, { value: "today", label: t("วันนี้", "Today") }, { value: "today+30d", label: t("อีก 30 วัน", "In 30 days") }]} />
      </div> : null}
      <TextField label={t("ข้อความแจ้งเตือนเมื่อไม่ผ่าน", "Message when it fails")} value={rules.message} onChange={value => setRules({ message: value })} />
    </Group> : null}

    <Group title={t("ขนาดและตำแหน่ง", "Size and position")}>
      <span className={label}>{t("ความกว้าง (จอคอมพิวเตอร์)", "Width (desktop)")}</span>
      <div className="flex flex-wrap gap-1">
        {WIDTHS.map(width => <button key={width.span} type="button" className={`${small} ${span === width.span ? "border-[var(--app-accent)]" : ""}`}
          onClick={() => onChange(placeOnGrid(definition, fieldRef, { span: width.span }))}>{tr(lang, width.th, width.en)}</button>)}
      </div>
      <SelectField label={t("เริ่มที่คอลัมน์", "Start column")} value={String(field.layout?.col ?? "")}
        onChange={value => onChange(placeOnGrid(definition, fieldRef, { col: value ? Number(value) : null }))}
        options={[{ value: "", label: t("ต่อจากช่องก่อนหน้า", "After the previous field") }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]} />
      <SelectField label={t("ความกว้างบนแท็บเล็ต", "Width on tablets")} value={String(field.layout?.responsive?.tablet?.span ?? "")}
        onChange={value => onChange(value ? placeOnGrid(definition, fieldRef, { span: Number(value) }, "tablet")
          : patchField(definition, fieldRef, { layout: { ...field.layout, responsive: { ...field.layout?.responsive, tablet: undefined } } }))}
        options={[{ value: "", label: t("เหมือนจอคอมพิวเตอร์", "Same as desktop") }, ...WIDTHS.map(width => ({ value: String(width.span), label: tr(lang, width.th, width.en) }))]} />
      <Toggle label={t("ซ่อนบนมือถือ", "Hide on phones")} checked={field.layout?.responsive?.mobile?.hidden === true}
        onChange={on => set({ layout: { ...field.layout, responsive: { ...field.layout?.responsive, mobile: on ? { hidden: true } : undefined } } })} />
      <Toggle label={t("ขึ้นหน้ากระดาษใหม่ก่อนช่องนี้ (A4)", "Start a new A4 page before it")} checked={field.layout?.page_break === "before"}
        onChange={on => set({ layout: { ...field.layout, page_break: on ? "before" : undefined } })} />
    </Group>

    <Group title={t("การแสดงในตาราง / ค้นหา / ส่งออก", "Tables, search and export")}>
      <Toggle label={t("แสดงในตารางรายการ", "Show in the records table")} checked={field.display?.table !== false} onChange={on => set({ display: { ...field.display, table: on ? undefined : false } })} />
      <Toggle label={t("แสดงในหน้ารายละเอียด", "Show in the detail view")} checked={field.display?.detail !== false} onChange={on => set({ display: { ...field.display, detail: on ? undefined : false } })} />
      <Toggle label={t("ส่งออกได้", "Include in exports")} checked={field.display?.export !== false} onChange={on => set({ display: { ...field.display, export: on ? undefined : false } })} />
      {INDEXABLE.has(type) && fieldRef.list.filter(step => step === "fields").length === 1
        ? <Toggle label={t("ใช้ค้นหาและทำรายงานได้เร็ว", "Fast search and reports")} hint={t("ใช้กับช่องสำคัญ เช่น HN, วันที่, ผลคำนวณ", "For key fields such as HN, dates, results")}
            checked={field.indexed === true} onChange={on => set({ indexed: on || undefined })} /> : null}
    </Group>

    <Group title={t("สิทธิ์การเข้าถึง", "Who can see it")} badge={field.permission ? "✓" : undefined}>
      <PermissionEditor value={field.permission} actions={FIELD_ACTIONS} lang={lang} onChange={value => set({ permission: value })} />
    </Group>

    <Group title={t("ขั้นสูง", "Advanced")}>
      <TextField label={t("ชื่อข้อมูล (key ภาษาอังกฤษ ใช้ในสูตรและรายงาน)", "Data key (used in formulas and reports)")} mono value={key}
        onChange={value => value && onChange(renameKey(definition, fieldRef, value))}
        hint={publishedKeys.has(key) ? t("ช่องนี้มีข้อมูลในเวอร์ชันที่ใช้งานอยู่ — ถ้าเปลี่ยน ระบบจะย้ายข้อมูลเดิมให้อัตโนมัติเมื่อเผยแพร่", "This field holds data in the live version — renaming migrates old records automatically on publish") : undefined} />
      {!KEY.test(key) ? <p className="text-[11px] text-rose-600 dark:text-rose-300">{t("ใช้ a-z ตัวเลข และ _ ขึ้นต้นด้วยตัวอักษร", "Use a-z, digits and _, starting with a letter")}</p> : null}
      <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--app-control-bg)] p-2 text-[10px] text-[var(--app-text)]">{JSON.stringify(field, null, 2)}</pre>
    </Group>
  </div>;
}
