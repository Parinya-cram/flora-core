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
import { FIELD_ACTIONS, PALETTE, PATTERNS, WIDTHS, tr, typeName, widthSpan, type Lang } from "./catalog";
import ConditionEditor from "./ConditionEditor";
import { Group, NumberField, SelectField, TextField, Toggle } from "./controls";
import { allFields, fieldAt, fieldPath, listColumns, patchField, placeOnGrid, renameKey, samePath, uniqueName, usedNames, type FieldRef } from "./model";
import { defaultSpan, formColumns, resolvePaper } from "../core/layout";
import { splitBilingual } from "../core/labels";
import MatrixEditor from "./MatrixEditor";
import TimelineEditor from "./TimelineEditor";
import PrintedEditor from "./PrintedEditor";
import CaseBlockEditor from "./CaseBlockEditor";
import { MAX_ROW_SPAN } from "../core/validate";
import { CONCEPT_BY_KEY, CONCEPTS, conceptOf } from "../leaf/concepts";
import OptionsEditor, { type LookupInfo } from "./OptionsEditor";
import PermissionEditor from "./PermissionEditor";
import { input, label, small } from "./styles";

type Props = {
  definition: FormDefinition; fieldRef: FieldRef; lang: Lang; lookups: LookupInfo[]; publishedKeys: Set<string>; onChange: (next: FormDefinition) => void;
  /** The name the variable-name standard gives this field (server: Thai labels romanised, concepts), or null offline. */
  suggestName?: (field: FieldDefinition) => Promise<{ key: string; concept: string | null } | null>;
};
type Patch = Partial<Record<keyof FieldDefinition, unknown>>;

const NUMERIC = new Set(["number", "integer", "decimal", "calculated"]);
const TEXTUAL = new Set(["text", "textarea"]);
const CHOICE = new Set(["select", "radio", "multiselect"]);
const CONTAINER = new Set(["group", "repeat"]);
/** Printed elements (no value): no required / read-only, checks or index. */
const PRINTED = new Set(["logo", "barcode", "case_block", "heading", "paragraph", "divider"]);
const STATIC = new Set(["heading", "paragraph", "divider"]);
const DATES = new Set(["date", "datetime"]);
const INDEXABLE = new Set(["text", "number", "integer", "decimal", "date", "datetime", "time", "select", "radio", "checkbox", "switch", "calculated"]);
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

export default function FieldInspector({ definition, fieldRef, lang, lookups, publishedKeys, onChange, suggestName }: Props) {
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
  const named = conceptOf({ id: field.id, key: field.key });
  const autoConcept = named ? CONCEPT_BY_KEY.get(named.key) : undefined;
  const everyField = allFields(definition);
  const candidates = everyField
    .filter(entry => (entry.depth === 0 || samePath(entry.ref.list, fieldRef.list)) && !samePath(fieldPath(entry.ref), fieldPath(fieldRef)) && !CONTAINER.has(entry.field.type))
    .map(entry => entry.field);
  const knownName = (name: string) => everyField.some(entry => fieldKey(entry.field) === name)
    || (name.includes(".") && everyField.some(entry => entry.field.type === "repeat" && name.startsWith(`${fieldKey(entry.field)}.`)));

  const bilingual = splitBilingual(field.label);

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
    if (PRINTED.has(next)) {
      Object.assign(patch, { required: undefined, indexed: undefined, validation: undefined, placeholder: undefined, unit: undefined, max_length: undefined, min: undefined, max: undefined, key: undefined,
        bind: undefined, readonly: undefined });
      if (next === "logo") Object.assign(patch, { height_mm: 14, source: undefined, symbology: undefined, show_text: undefined });
      else if (next === "barcode") Object.assign(patch, { source: field.source ?? "hn", symbology: field.symbology ?? "i2of5", height_mm: 10, src: undefined });
      else Object.assign(patch, { src: undefined, source: undefined, symbology: undefined, height_mm: undefined, show_text: undefined,
        level: next === "heading" ? field.level ?? 2 : undefined, content: next === "paragraph" ? field.content ?? field.label : undefined });
    } else Object.assign(patch, { src: undefined, source: undefined, symbology: undefined, height_mm: undefined, show_text: undefined, align: undefined, level: undefined, content: undefined });
    if (!STATIC.has(next)) Object.assign(patch, { level: undefined, content: undefined });
    if (next === "case_block") {
      Object.assign(patch, { block: "diagnoses", block_columns: [{ key: "no", width: 8 }, { key: "text", width: 62 }, { key: "icd", width: 30 }], min_rows: 3, max_rows: 15,
        src: undefined, source: undefined, symbology: undefined, height_mm: undefined, show_text: undefined, align: undefined });
    } else Object.assign(patch, { block: undefined, block_columns: undefined, max_rows: undefined, min_rows: undefined, show_header: undefined });
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
  // A derive saved without match (older drafts, hand-written JSON) is read as "no column matched yet".
  const derive = field.derive ? { ...field.derive, match: field.derive.match ?? {} } : undefined;
  const deriveTable = lookups.find(item => item.lookup_id === derive?.lookup);
  const setDerive = (patch: Partial<LookupDerive>) => {
    const next = { ...(derive ?? { lookup: lookups[0]?.lookup_id ?? "", column: "", match: {} }), ...patch } as LookupDerive;
    set({ derive: next, readonly: true });
  };

  // Layout -------------------------------------------------------------------------------------
  const span = field.layout?.span;
  const gridColumns = listColumns(definition, fieldRef.list, formColumns(definition));
  const defaultWidth = defaultSpan(field, gridColumns, 2, "desktop");
  const paperWidth = fieldRef.list.filter(step => step === "fields").length === 1 ? (() => { const paper = resolvePaper(definition); return paper.width_mm ? paper.width_mm - paper.margin.left - paper.margin.right : 0; })() : 0;
  const pattern = PATTERNS.find(item => Object.entries(item.rules).every(([name, value]) => (rules as Record<string, unknown>)[name] === value))?.id
    ?? (rules.pattern ? "custom" : "");

  return <div className="space-y-2">
    <div className="flex items-center justify-between">
      <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{typeName(type, lang)}</div>
      <code className="text-[11px] text-[var(--app-muted)]">{key}</code>
    </div>

    <Group title={t("ข้อมูลพื้นฐาน", "Basics")} open>
      <TextField label={type === "heading" ? t("ข้อความหัวข้อ", "Heading text") : t("ชื่อช่อง (ที่ผู้กรอกเห็น)", "Label")} value={field.label} onChange={value => set({ label: value ?? "" })} />
      <TextField label={t("ชื่อภาษาอังกฤษ (แสดงเมื่อใช้ภาษาอังกฤษ)", "English label (shown in English)")} value={field.label_en} onChange={value => set({ label_en: value || undefined })} />
      {bilingual && !field.label_en ? <button type="button" className={small} onClick={() => set({ label: bilingual.th, label_en: bilingual.en })}>
        {t(`แยก "${bilingual.th}" / "${bilingual.en}"`, `Split into "${bilingual.th}" / "${bilingual.en}"`)}</button> : null}
      {type === "heading" ? <SelectField label={t("ขนาดหัวข้อ", "Heading size")} value={String(field.level ?? 2)} onChange={value => set({ level: Number(value) })}
        options={[{ value: "1", label: t("ใหญ่", "Large") }, { value: "2", label: t("กลาง", "Medium") }, { value: "3", label: t("เล็ก", "Small") }]} /> : null}
      {type === "paragraph" ? <label className="block space-y-1"><span className={label}>{t("ข้อความ", "Text")}</span>
        <textarea className={`${input} min-h-[90px]`} value={field.content ?? ""} onChange={event => set({ content: event.target.value })} /></label> : null}
      {type === "heading" || type === "paragraph" ? <SelectField label={t("จัดวาง", "Alignment")} value={field.align ?? "left"} onChange={value => set({ align: value === "left" ? undefined : value })}
        options={[{ value: "left", label: t("ชิดซ้าย", "Left") }, { value: "center", label: t("กึ่งกลาง", "Centre") }, { value: "right", label: t("ชิดขวา", "Right") }]} /> : null}
      {!STATIC.has(type) ? <div className="space-y-1">
        <span className={label}>{t("ชื่อตัวแปร (ใช้ในสูตร เงื่อนไข รายงาน)", "Variable name (formulas, conditions, reports)")}</span>
        <div className="flex gap-1">
          <input className={`${input} font-mono`} value={key} onChange={event => event.target.value && KEY.test(event.target.value) && onChange(renameKey(definition, fieldRef, event.target.value))} />
          {suggestName ? <button type="button" className={small} title={t("ตั้งชื่อตามมาตรฐาน: ตามความหมายของป้าย / ข้อมูลเคส", "Name it by the standard: from the label's meaning / case data")}
            onClick={() => void suggestName(field).then(found => {
              if (!found || found.key === key) return;
              const renamed = renameKey(definition, fieldRef, found.key);
              onChange(found.concept && !field.bind ? patchField(renamed, fieldRef, { bind: found.concept }) : renamed);
            })}>✨ {t("ตั้งชื่อ", "Name it")}</button> : null}
        </div>
      </div> : null}
      <TextField label={t("คำอธิบายใต้ช่อง", "Help text")} value={field.description} onChange={value => set({ description: value })} />
      {TEXTUAL.has(type) || (NUMERIC.has(type) && type !== "calculated") || type === "select"
        ? <TextField label={t("ข้อความตัวอย่างในช่อง", "Placeholder")} value={field.placeholder} onChange={value => set({ placeholder: value })} /> : null}
      {NUMERIC.has(type) || type === "text" ? <TextField label={t("หน่วย", "Unit")} value={field.unit} placeholder="kg, mmHg, °C" onChange={value => set({ unit: value })} /> : null}
      {type === "decimal" || type === "calculated" ? <NumberField label={t("จำนวนตำแหน่งทศนิยม", "Decimal places")} value={field.decimals} min={0} max={10} onChange={value => set({ decimals: value })} /> : null}
      {!CONTAINER.has(type) && !PRINTED.has(type) && type !== "calculated" ? <Toggle label={t("ต้องกรอก", "Required")} checked={field.required === true} onChange={on => set({ required: on || undefined })} /> : null}
      {!CONTAINER.has(type) && !PRINTED.has(type) && type !== "calculated" ? <Toggle label={t("อ่านอย่างเดียว", "Read-only")} checked={field.readonly === true} onChange={on => set({ readonly: on || undefined })} /> : null}
      {type === "repeat" ? <Toggle label={t("แสดงเป็นตารางแบบ Excel (1 แถวต่อรายการ, วางข้อมูลจาก Excel ได้)", "Show as an Excel-style table (one row per entry; paste from Excel)")}
        checked={field.view === "table"} onChange={on => set({ view: on ? "table" : undefined })} /> : null}
      {!CONTAINER.has(type) && !PRINTED.has(type) && !["timeline", "matrix", "signature", "file", "image", "calculated"].includes(type) ? <SelectField
        label={t("ข้อมูลจาก Flora Leaf (เติมให้เมื่อพิมพ์/กรอกในเคส)", "Flora Leaf case datum (filled when printed / filled for a case)")}
        value={field.bind ?? ""} onChange={value => set({ bind: value || undefined })}
        options={[{ value: "", label: autoConcept ? t(`อัตโนมัติจากชื่อช่อง: ${autoConcept.th}`, `Automatic from the field name: ${autoConcept.en}`) : t("ไม่เชื่อม", "Not linked") },
          ...CONCEPTS.map(concept => ({ value: concept.key, label: `${tr(lang, concept.th, concept.en)} (${concept.key})` }))]} /> : null}
      <SelectField label={t("ชนิดช่อง", "Field type")} value={type} onChange={value => changeType(value as FieldType)}
        options={PALETTE.flatMap(group => group.items).map(item => ({ value: item.type, label: tr(lang, item.th, item.en) }))} />
    </Group>

    {CHOICE.has(type) ? <Group title={t("ตัวเลือก", "Choices")} open badge={field.lookup ? t("ตาราง", "table") : String(field.options?.length ?? 0)}>
      <OptionsEditor field={field} candidates={candidates} lookups={lookups} lang={lang} onPatch={set} />
      {type !== "select" || field.option_columns ? <SelectField label={t("จัดตัวเลือกเป็นคอลัมน์ (เหมือนแบบฟอร์มกระดาษ)", "Lay the options out in columns (as on paper)")}
        value={String(field.option_columns ?? "")} options={[{ value: "", label: t("เรียงต่อกัน", "In a line") }, ...[1, 2, 3, 4, 5, 6].map(n => ({ value: String(n), label: t(`${n} คอลัมน์`, `${n} columns`) }))]}
        onChange={value => set({ option_columns: value ? Number(value) : undefined })} /> : null}
    </Group> : null}

    {type === "logo" || type === "barcode" ? <Group title={type === "logo" ? t("รูปโลโก้", "Logo picture") : t("บาร์โค้ด", "Barcode")} open>
      <PrintedEditor field={field} candidates={candidates} lang={lang} onPatch={set} />
    </Group> : null}

    {type === "case_block" ? <Group title={t("ตารางข้อมูลเคส (รายงาน)", "Case data table (report)")} open badge={`${field.block_columns?.length ?? 0} ${t("คอลัมน์", "cols")}`}>
      <CaseBlockEditor field={field} lang={lang} onPatch={set} />
    </Group> : null}

    {type === "timeline" ? <Group title={t("Timeline (Flora Leaf)", "Timeline (Flora Leaf)")} open>
      <TimelineEditor field={field} lang={lang} onPatch={set} />
    </Group> : null}

    {type === "matrix" ? <Group title={t("ตารางคะแนน", "Score table")} open badge={`${field.rows?.length ?? 0}×${field.cols?.length ?? 0}`}>
      <MatrixEditor field={field} lang={lang} onPatch={set} />
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

    {!CONTAINER.has(type) && !PRINTED.has(type) && type !== "calculated" && type !== "matrix" && type !== "timeline" ? <Group title={t("การตรวจสอบค่า", "Checks")} badge={Object.keys(rules).length || field.min !== undefined || field.max !== undefined ? "✓" : undefined}>
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

    <Group title={t("ขนาดและตำแหน่ง", "Size and position")} open={type === "case_block"}
      badge={`${Math.round((span ?? defaultWidth) * 100 / gridColumns)}%`}>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className={label}>{t("ความกว้างบนกระดาษ / หน้าจอ", "Width on paper / screen")}</span>
          <span className="text-xs font-semibold text-[var(--app-text)]">{span ?? defaultWidth}/{gridColumns} {t("ช่อง", "cols")} · {Math.round((span ?? defaultWidth) * 100 / gridColumns)}%
            {paperWidth ? ` · ≈${Math.round((span ?? defaultWidth) * paperWidth / gridColumns)} mm` : ""}</span>
        </div>
        <input type="range" className="w-full" min={1} max={gridColumns} step={1} value={span ?? defaultWidth} aria-label={t("ความกว้าง", "Width")}
          onChange={event => onChange(placeOnGrid(definition, fieldRef, { span: Number(event.target.value) }, "desktop", gridColumns))} />
        <div className="relative h-3 w-full rounded bg-[var(--app-control-bg)]">
          <div className="absolute inset-y-0 rounded bg-[var(--app-accent)]/70"
            style={{ left: `${((field.layout?.col ?? 1) - 1) * 100 / gridColumns}%`, width: `${(span ?? defaultWidth) * 100 / gridColumns}%` }} />
        </div>
      </div>
      <NumberField label={t("ความสูง (จำนวนแถวของตาราง grid ที่ครอบคลุม)", "Height (grid rows covered)")} value={field.layout?.row_span} min={1} max={MAX_ROW_SPAN}
        onChange={value => set({ layout: { ...field.layout, row_span: value && value > 1 ? Math.min(MAX_ROW_SPAN, Math.round(value)) : undefined } })} />
      <span className={label}>{t("ความกว้างแบบด่วน", "Quick widths")}</span>
      <div className="flex flex-wrap gap-1">
        {WIDTHS.map(width => <button key={width.part} type="button" className={`${small} ${span === widthSpan(width.part, gridColumns) ? "border-[var(--app-accent)]" : ""}`}
          onClick={() => onChange(placeOnGrid(definition, fieldRef, { span: widthSpan(width.part, gridColumns) }, "desktop", gridColumns))}>{tr(lang, width.th, width.en)}</button>)}
      </div>
      <SelectField label={t("เริ่มที่คอลัมน์", "Start column")} value={String(field.layout?.col ?? "")}
        onChange={value => onChange(placeOnGrid(definition, fieldRef, { col: value ? Number(value) : null }, "desktop", gridColumns))}
        options={[{ value: "", label: t("ต่อจากช่องก่อนหน้า", "After the previous field") }, ...Array.from({ length: gridColumns }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]} />
      <SelectField label={t("ความกว้างบนแท็บเล็ต", "Width on tablets")} value={String(field.layout?.responsive?.tablet?.span ?? "")}
        onChange={value => onChange(value ? placeOnGrid(definition, fieldRef, { span: Number(value) }, "tablet", gridColumns)
          : patchField(definition, fieldRef, { layout: { ...field.layout, responsive: { ...field.layout?.responsive, tablet: undefined } } }))}
        options={[{ value: "", label: t("เหมือนจอคอมพิวเตอร์", "Same as desktop") }, ...WIDTHS.map(width => ({ value: String(widthSpan(width.part, gridColumns)), label: tr(lang, width.th, width.en) }))]} />
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
