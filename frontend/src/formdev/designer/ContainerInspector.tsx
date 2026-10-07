/** Settings of the form itself, a section or a category (sub-group of a section). */
import type { CategoryDefinition, FormDefinition, PaperConfig, SectionDefinition, StyleEntry } from "../core/types";
import { fieldKey, fields as topFields } from "../core/validate";
import { FORM_ACTIONS, SECTION_ACTIONS, tr, type Lang } from "./catalog";
import ConditionEditor from "./ConditionEditor";
import { Group, NumberField, SelectField, TextField, Toggle } from "./controls";
import { at, patchAt, uniqueName, usedNames, type Path } from "./model";
import PermissionEditor from "./PermissionEditor";
import { label } from "./styles";

type Props = {
  definition: FormDefinition; lang: Lang; styles: StyleEntry[]; formIdEditable: boolean;
  target: { kind: "form" } | { kind: "section" | "category"; path: Path };
  onChange: (next: FormDefinition) => void;
};

const FORM_ID = /^[a-z][a-z0-9_]{1,63}$/;

export default function ContainerInspector({ definition, lang, styles, formIdEditable, target, onChange }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const candidates = topFields(definition).filter(field => field.type !== "group" && field.type !== "repeat");

  if (target.kind === "form") {
    const paper: PaperConfig = typeof definition.paper === "string" ? { size: definition.paper } : definition.paper;
    const set = (patch: Record<string, unknown>) => onChange(patchAt(definition, [], patch));
    const setPaper = (patch: Partial<PaperConfig>) => set({ paper: { ...paper, ...patch } });
    const subject = typeof definition.extensions?.["flora.subject_field"] === "string" ? definition.extensions["flora.subject_field"] as string : "";
    return <div className="space-y-2">
      <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("ตั้งค่าแบบฟอร์ม", "Form settings")}</div>
      <Group title={t("ข้อมูลแบบฟอร์ม", "Form")} open>
        <TextField label={t("ชื่อแบบฟอร์ม", "Title")} value={definition.title} onChange={value => set({ title: value ?? "" })} />
        <TextField label={t("รหัสแบบฟอร์ม (ภาษาอังกฤษตัวเล็ก)", "Form id (lowercase)")} mono value={definition.form_id}
          onChange={value => formIdEditable && set({ form_id: (value ?? "").toLowerCase() })}
          hint={formIdEditable ? t("ตั้งครั้งเดียวก่อนบันทึก เช่น ward_admission", "Set once before saving, e.g. ward_admission") : t("เปลี่ยนไม่ได้หลังบันทึกแล้ว", "Fixed after the first save")} />
        {!FORM_ID.test(definition.form_id) ? <p className="text-[11px] text-rose-600 dark:text-rose-300">{t("ใช้ a-z ตัวเลข และ _ (2-64 ตัว)", "Use a-z, digits and _ (2-64)")}</p> : null}
        <TextField label={t("คำอธิบาย", "Description")} value={definition.description} multiline onChange={value => set({ description: value })} />
        <SelectField label={t("ช่องที่ระบุตัวผู้ป่วย (เช่น HN)", "Patient identifier field (e.g. HN)")} value={subject}
          onChange={value => set({ extensions: { ...(definition.extensions ?? {}), "flora.subject_field": value || undefined } })}
          options={[{ value: "", label: t("— ไม่มี —", "— none —") }, ...candidates.filter(field => field.type === "text").map(field => ({ value: fieldKey(field), label: field.label }))]} />
      </Group>
      <Group title={t("หน้ากระดาษและรูปแบบ", "Paper and style")}>
        <div className="grid grid-cols-2 gap-2">
          <SelectField label={t("ขนาดกระดาษ", "Paper")} value={paper.size} onChange={value => setPaper({ size: value as PaperConfig["size"] })}
            options={["A4", "A5", "Letter"].map(size => ({ value: size, label: size }))} />
          <SelectField label={t("แนวกระดาษ", "Orientation")} value={paper.orientation ?? "portrait"} onChange={value => setPaper({ orientation: value as "portrait" | "landscape" })}
            options={[{ value: "portrait", label: t("แนวตั้ง", "Portrait") }, { value: "landscape", label: t("แนวนอน", "Landscape") }]} />
        </div>
        <SelectField label={t("รูปแบบตัวอักษรและสี (สไตล์)", "Style")} value={definition.style_id ?? definition.style?.id ?? ""} onChange={value => set({ style_id: value, style: undefined })}
          options={styles.filter(style => style.definition.category === "form" || style.style_id.startsWith("style.")).map(style => ({ value: style.style_id, label: String(style.definition.name ?? style.style_id) }))} />
        <TextField label={t("หัวกระดาษ (กลาง)", "Header (centre)")} value={paper.header?.center} placeholder="{title}" onChange={value => setPaper({ header: { ...paper.header, center: value } })} />
        <TextField label={t("ท้ายกระดาษ (ขวา)", "Footer (right)")} value={paper.footer?.right} placeholder="หน้า {page}/{pages}" onChange={value => setPaper({ footer: { ...paper.footer, right: value } })}
          hint={t("ใช้ {title} {date} {page} {pages} {record_id} ได้", "You can use {title} {date} {page} {pages} {record_id}")} />
      </Group>
      <Group title={t("สิทธิ์ของแบบฟอร์ม", "Form permissions")} badge={definition.permission ? "✓" : undefined}>
        <PermissionEditor value={definition.permission} actions={FORM_ACTIONS} lang={lang} onChange={value => set({ permission: value })} />
      </Group>
    </div>;
  }

  const node = at(definition, target.path) as SectionDefinition | CategoryDefinition | undefined;
  if (!node) return null;
  const set = (patch: Record<string, unknown>) => onChange(patchAt(definition, target.path, patch));
  const isSection = target.kind === "section";
  return <div className="space-y-2">
    <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{isSection ? t("ส่วนของแบบฟอร์ม", "Section") : t("หมวดย่อย", "Category")}</div>
    <Group title={t("ข้อมูลพื้นฐาน", "Basics")} open>
      <TextField label={t("หัวข้อ", "Title")} value={node.title} onChange={value => set({ title: value ?? "" })} />
      <TextField label={t("คำอธิบาย", "Description")} value={node.description} multiline onChange={value => set({ description: value })} />
      <Toggle label={t("ขึ้นหน้ากระดาษใหม่ก่อนส่วนนี้ (A4)", "Start a new A4 page before it")} checked={node.page_break === "before"} onChange={on => set({ page_break: on ? "before" : undefined })} />
      <Toggle label={t("กรอกซ้ำได้หลายชุด (เช่น ประวัติหลายครั้ง)", "Can be filled several times (e.g. several events)")} checked={node.repeat !== undefined}
        onChange={on => set({ repeat: on ? { key: uniqueName(`${node.id}_items`, usedNames(definition)), max_items: 20 } : undefined })} />
      {node.repeat ? <NumberField label={t("จำนวนชุดสูงสุด", "Maximum entries")} value={node.repeat.max_items} min={1} onChange={value => set({ repeat: { ...node.repeat, max_items: value } })} /> : null}
    </Group>
    <Group title={t("รูปแบบกระดาษ (พิมพ์ / PDF)", "Paper layout (print / PDF)")} badge={node.print_style === "boxed" || (node as SectionDefinition).repeat_on_pages ? "✓" : undefined}>
      <Toggle label={t("ตารางมีเส้น: ช่องติดกันมีกรอบ, \"หัวข้อ: ค่า\" ในบรรทัดเดียว", "Bordered table: cells touch with borders, \"Label: value\" on one line")}
        checked={node.print_style === "boxed"} onChange={on => set({ print_style: on ? "boxed" : undefined })} />
      <Toggle label={t("ไม่พิมพ์หัวข้อของส่วนนี้", "Do not print this block's title")} checked={node.hide_title === true} onChange={on => set({ hide_title: on || undefined })} />
      {isSection && target.path.length === 2 ? <SelectField label={t("พิมพ์ซ้ำทุกหน้า", "Print on every page")} value={(node as SectionDefinition).repeat_on_pages ?? ""}
        options={[{ value: "", label: t("ไม่ซ้ำ", "No") }, { value: "header", label: t("เป็นหัวกระดาษ (เช่น ข้อมูลผู้ป่วย)", "As the page header (e.g. patient details)") },
          { value: "footer", label: t("เป็นท้ายกระดาษ (เช่น ลายเซ็น)", "As the page footer (e.g. signatures)") }]}
        onChange={value => set({ repeat_on_pages: value || undefined })} /> : null}
    </Group>
    <Group title={t("แสดงเมื่อ (เงื่อนไข)", "Show when")} badge={node.visibility ? "✓" : undefined}>
      <span className={label}>{t("ซ่อนทั้งส่วนจนกว่าเงื่อนไขจะเป็นจริง", "The whole block stays hidden until this is true")}</span>
      <ConditionEditor key={`vis-${node.id}`} condition={node.visibility?.when} candidates={candidates} lang={lang} onChange={when => set({ visibility: when ? { when } : undefined })} />
    </Group>
    <Group title={t("สิทธิ์การเข้าถึง", "Who can see it")} badge={node.permission ? "✓" : undefined}>
      <PermissionEditor value={node.permission} actions={SECTION_ACTIONS} lang={lang} onChange={value => set({ permission: value })} />
    </Group>
  </div>;
}
