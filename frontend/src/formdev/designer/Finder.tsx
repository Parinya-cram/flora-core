/**
 * Find parts to build a form from (Ctrl+K): field types, ready-made blocks, case data (concepts: the field comes
 * bound and named by the standard), blocks saved by the team, sections of other forms, fields of this form, and
 * designer commands — one search box, Thai or English, any word order. Enter or a click uses the highlighted item.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldDefinition, FieldType, FormDefinition, SectionDefinition } from "../core/types";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import { CONCEPTS } from "../leaf/concepts";
import { BLOCKS, PALETTE, scaleSpans, tr, type Lang } from "./catalog";
import { allFields, usedNames, type FieldRef } from "./model";
import { formColumns } from "../core/layout";
import { fieldFromRecord, RECORD_FIELDS } from "../leaf/record";

export type FinderPick =
  | { kind: "type"; type: FieldType }
  | { kind: "block"; id: string }
  | { kind: "concept"; concept: string; type: FieldType; th: string; en: string }
  | { kind: "fields"; fields: FieldDefinition[]; name: string }
  | { kind: "section"; section: SectionDefinition; name: string }
  | { kind: "jump"; ref: FieldRef }
  | { kind: "command"; id: string };

type Item = { id: string; group: string; icon: string; title: string; hint: string; words: string; pick: FinderPick | (() => Promise<FinderPick | null>) };

const CONCEPT_TYPE: Record<string, FieldType> = { text: "text", number: "decimal", date: "date", time: "time", datetime: "datetime", list: "textarea" };
const fold = (text: string) => text.normalize("NFC").toLowerCase().replace(/\s+/g, " ");

export const BLOCK_EXTENSION = "flora.block";

export default function Finder({ lang, definition, remote, online, commands, onPick, onClose }: {
  lang: Lang; definition: FormDefinition; remote: RestApiAdapter; online: boolean;
  commands: Array<{ id: string; icon: string; th: string; en: string }>;
  onPick: (pick: FinderPick) => void; onClose: () => void;
}) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [library, setLibrary] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { box.current?.focus(); }, []);

  // The library (blocks the team saved, other forms' sections) is read once when the search opens.
  useEffect(() => {
    if (!online) return;
    let live = true;
    void (async () => {
      const items: Item[] = [];
      const templates = await remote.listTemplates().catch(() => []);
      for (const row of templates) {
        const block = (row as unknown as { extensions?: Record<string, unknown> }).extensions?.[BLOCK_EXTENSION] !== undefined || /^block_/.test(row.template_id);
        items.push({ id: `tpl:${row.template_id}`, group: block ? t("ชุดของทีม", "Team blocks") : t("แม่แบบ", "Templates"), icon: block ? "🧩" : "📚",
          title: row.title, hint: row.template_id, words: fold(`${row.title} ${row.template_id} ${row.description ?? ""}`),
          pick: async () => {
            const full = await remote.getTemplate(row.template_id);
            const sections = full.template.definition.sections;
            return block ? { kind: "fields", fields: sections.flatMap(section => section.fields), name: row.title }
              : { kind: "section", section: sections[0], name: `${row.title} › ${sections[0]?.title ?? ""}` };
          } });
      }
      const forms = await remote.listForms().catch(() => []);
      for (const form of forms) {
        items.push({ id: `form:${form.form_id}`, group: t("ส่วนจากแบบฟอร์มอื่น", "Sections of other forms"), icon: "📄", title: form.title, hint: `${form.form_id} · ${t("เลือกแล้วแสดงส่วนของฟอร์มนี้", "pick to list its sections")}`,
          words: fold(`${form.title} ${form.form_id}`), pick: async () => {
            const versions = await remote.listSchemas(form.form_id);
            const latest = versions.filter(version => version.status === "published").sort((a, b) => b.schema_version - a.schema_version)[0] ?? versions[0];
            if (!latest) return null;
            const sections = latest.definition.sections;
            setLibrary(current => [...sections.map((section, index): Item => ({
              id: `section:${form.form_id}:${index}`, group: `${t("ส่วนของ", "Sections of")} ${form.title}`, icon: "▤", title: section.title,
              hint: `${section.fields.length} ${t("ช่อง", "fields")}`, words: fold(`${section.title} ${form.title}`),
              pick: { kind: "section", section, name: `${form.title} › ${section.title}` },
            })), ...current]);
            setQuery(form.title);
            return null;
          } });
      }
      if (live) setLibrary(items);
    })();
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, online]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const group of PALETTE) for (const item of group.items) {
      out.push({ id: `type:${item.type}`, group: t("ชนิดช่อง", "Field types"), icon: item.icon, title: tr(lang, item.th, item.en), hint: tr(lang, item.hintTh, item.hintEn),
        words: fold(`${item.th} ${item.en} ${item.hintTh} ${item.hintEn} ${item.type}`), pick: { kind: "type", type: item.type } });
    }
    for (const block of BLOCKS) {
      out.push({ id: `block:${block.id}`, group: t("ชุดสำเร็จรูป", "Ready-made blocks"), icon: block.icon, title: tr(lang, block.th, block.en), hint: tr(lang, block.hintTh, block.hintEn),
        words: fold(`${block.th} ${block.en} ${block.hintTh} ${block.hintEn}`), pick: { kind: "block", id: block.id } });
    }
    for (const concept of CONCEPTS) {
      out.push({ id: `concept:${concept.key}`, group: t("ข้อมูลเคส (ผูกอัตโนมัติ)", "Case data (bound)"), icon: "⛓", title: tr(lang, concept.th, concept.en), hint: concept.key,
        words: fold(`${concept.th} ${concept.en} ${concept.key} ${concept.aliases.join(" ")}`),
        pick: { kind: "concept", concept: concept.key, type: CONCEPT_TYPE[concept.kind] ?? "text", th: concept.th, en: concept.en } });
    }
    // The Leaf's anesthesia record, field by field: added already bound both ways ("record.<field>").
    const columns = formColumns(definition);
    for (const record of RECORD_FIELDS) {
      out.push({ id: `record:${record.bind}`, group: t("ใบบันทึกดมยา Leaf (ใช้ข้อมูลร่วมกันสองทาง)", "Leaf anesthesia record (shared both ways)"), icon: "⇄",
        title: record.label, hint: `${tr(lang, record.tab_th, record.tab_en)} · ${record.bind}`,
        words: fold(`${record.label} ${record.key} ${record.bind} ${record.tab_th} ${record.tab_en}`),
        pick: () => Promise.resolve({ kind: "fields", name: record.label, fields: scaleSpans([fieldFromRecord(record, usedNames(definition), lang)], columns) }) });
    }
    for (const { ref, field } of allFields(definition)) {
      out.push({ id: `field:${JSON.stringify(ref)}`, group: t("ช่องในฟอร์มนี้", "Fields in this form"), icon: "↪", title: field.label, hint: field.key ?? field.id,
        words: fold(`${field.label} ${field.label_en ?? ""} ${field.id} ${field.key ?? ""}`), pick: { kind: "jump", ref } });
    }
    for (const command of commands) {
      out.push({ id: `cmd:${command.id}`, group: t("คำสั่ง", "Commands"), icon: command.icon, title: tr(lang, command.th, command.en), hint: "",
        words: fold(`${command.th} ${command.en}`), pick: { kind: "command", id: command.id } });
    }
    return [...out, ...library];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, library, commands, lang]);

  const shown = useMemo(() => {
    const words = fold(query).split(" ").filter(Boolean);
    if (!words.length) return items.filter(item => item.group !== t("ช่องในฟอร์มนี้", "Fields in this form")).slice(0, 60);
    return items.map(item => ({ item, at: words.every(word => item.words.includes(word)) ? item.words.indexOf(words[0]) : -1 }))
      .filter(entry => entry.at >= 0).sort((a, b) => a.at - b.at).map(entry => entry.item).slice(0, 60);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query]);

  const use = async (item: Item | undefined) => {
    if (!item) return;
    if (typeof item.pick === "function") {
      setBusy(true);
      try {
        const pick = await item.pick();
        if (pick) { onPick(pick); onClose(); }
      } finally {
        setBusy(false);
      }
      return;
    }
    onPick(item.pick);
    onClose();
  };

  let lastGroup = "";
  return <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onClick={onClose} role="dialog" aria-modal aria-label={t("ค้นหาส่วนประกอบ", "Find parts")}>
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-2xl" onClick={event => event.stopPropagation()}>
      <input ref={box} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(shown.length - 1, index + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); void use(shown[active]); }
        }}
        placeholder={t("ค้นหา: ชนิดช่อง, ชุดสำเร็จรูป, ข้อมูลเคส (เช่น น้ำหนัก), ส่วนจากฟอร์มอื่น, ช่องในฟอร์ม…", "Search: field types, blocks, case data (e.g. weight), sections of other forms, fields…")}
        className="w-full border-b border-[var(--app-border)] bg-transparent px-4 py-3 text-base text-[var(--app-text)] outline-none" />
      <ul className="max-h-[60vh] overflow-y-auto p-1" role="listbox">
        {shown.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return <li key={item.id}>
            {header ? <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{header}</div> : null}
            <button type="button" role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => void use(item)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm ${index === active ? "bg-[var(--app-accent)]/15" : ""}`}>
              <span className="w-6 text-center">{item.icon}</span>
              <span className="min-w-0 flex-1"><span className="block truncate font-semibold text-[var(--app-text)]">{item.title}</span>
                {item.hint ? <span className="block truncate text-[11px] text-[var(--app-muted)]">{item.hint}</span> : null}</span>
            </button>
          </li>;
        })}
        {!shown.length ? <li className="px-4 py-8 text-center text-sm text-[var(--app-muted)]">{t("ไม่พบ", "Nothing found")}</li> : null}
      </ul>
      <div className="flex items-center justify-between border-t border-[var(--app-border)] px-3 py-1.5 text-[11px] text-[var(--app-muted)]">
        <span>↑↓ {t("เลือก", "move")} · Enter {t("ใช้", "use")} · Esc {t("ปิด", "close")}</span>
        {busy ? <span>…</span> : <span>{items.length + library.length} {t("รายการ", "items")}</span>}
      </div>
    </div>
  </div>;
}
