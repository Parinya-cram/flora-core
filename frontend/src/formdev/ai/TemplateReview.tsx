/**
 * Review of a template (Form Studio): the source documents beside the form built from them. The checklist lists every
 * item the AI found on the paper and the field it became (items not captured stand out), what the AI was unsure
 * about, the validator's problems, the form on screen and on A4, and where it is suggested to be filled in on Flora
 * Leaf. The author fixes the form in the designer, marks the template reviewed, and creates a Form Studio form from
 * it (published there, then picked in Workflow Studio).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FieldDefinition, FontEntry, RecordData, StyleEntry } from "../core/types";
import { fieldMap, issueText } from "../core/validate";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import { tr, type Lang } from "../designer/catalog";
import { danger, input, label, panel, primary, secondary, small } from "../designer/styles";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../registry/defaults";
import FormRenderer from "../ui/FormRenderer";
import PdfPreview from "../ui/PdfPreview";
import { download, errorMessage, sizeLabel } from "./files";
import { LEAF_TABS, PHASE_LABEL, suggestedPlacement, withPlacement } from "./placement";
import type { DescribedIssue, Placement, Template, TemplateSource } from "./types";

type Props = {
  remote: RestApiAdapter; lang: Lang; language: string; templateId: string; isNew?: boolean;
  onBack: () => void; onEdit: (template: Template) => void; onFormCreated: (formId: string) => void;
};
type Pane = "check" | "form" | "print" | "issues";

const VIEWABLE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

function SourceViewer({ remote, templateId, source, lang }: { remote: RestApiAdapter; templateId: string; source: TemplateSource; lang: Lang }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    void remote.templateSource(templateId, source.sha256).then(blob => {
      if (!live) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }).catch(caught => { if (live) setError(errorMessage(caught)); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [remote, templateId, source.sha256]);
  if (error) return <p className="p-3 text-sm text-rose-600 dark:text-rose-300">{error}</p>;
  if (!url) return <p className="p-3 text-sm text-[var(--app-muted)]">…</p>;
  if (source.media_type === "application/pdf") return <iframe title={source.name} src={url} className="h-[75vh] w-full rounded-xl border border-[var(--app-border)] bg-white" />;
  if (VIEWABLE.has(source.media_type)) return <div className="max-h-[75vh] overflow-auto rounded-xl border border-[var(--app-border)] bg-white"><img src={url} alt={source.name} className="w-full" /></div>;
  return <div className="space-y-2 p-3 text-sm text-[var(--app-muted)]">
    <p>{t("ไฟล์ชนิดนี้เปิดดูในหน้าเว็บไม่ได้", "This file type cannot be shown in the page")}</p>
    <a className={small} href={url} download={source.name}>⬇ {source.name}</a>
  </div>;
}

export default function TemplateReview({ remote, lang, language, templateId, isNew, onBack, onEdit, onFormCreated }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [template, setTemplate] = useState<Template | null>(null);
  const [issues, setIssues] = useState<DescribedIssue[]>([]);
  const [pane, setPane] = useState<Pane>("check");
  const [sourceIndex, setSourceIndex] = useState(0);
  const [registry, setRegistry] = useState<{ styles: StyleEntry[]; fonts: FontEntry[] }>({ styles: DEFAULT_STYLES, fonts: DEFAULT_FONTS });
  const [tryData, setTryData] = useState<RecordData>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [creating, setCreating] = useState<{ formId: string; title: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await remote.getTemplate(templateId);
      setTemplate(found.template);
      setIssues(found.issues);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    }
  }, [remote, templateId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let live = true;
    void Promise.all([remote.listStyles(), remote.listFonts()]).then(([styles, fonts]) => { if (live && styles.length) setRegistry({ styles, fonts }); }).catch(() => undefined);
    return () => { live = false; };
  }, [remote]);

  const fieldsById = useMemo(() => {
    const map = new Map<string, FieldDefinition>();
    if (!template) return map;
    const walk = (list: FieldDefinition[] | undefined) => (list ?? []).forEach(field => { map.set(field.id, field); walk(field.fields); });
    for (const field of fieldMap(template.definition).values()) { map.set(field.id, field); walk(field.fields); }
    return map;
  }, [template]);

  if (!template) return <div className={`${panel} p-4 text-sm text-[var(--app-muted)]`}>{message?.text ?? "…"}</div>;

  const report = template.report;
  const coverage = report?.coverage ?? [];
  const captured = coverage.filter(item => item.found).length;
  const placement = suggestedPlacement(template.definition) ?? report?.placement ?? null;
  const shown = onlyMissing ? coverage.filter(item => !item.found) : coverage;

  const update = async (body: Parameters<RestApiAdapter["updateTemplate"]>[1], done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await remote.updateTemplate(template.template_id, body);
      setTemplate(saved.template);
      setIssues(saved.issues);
      if (done) setMessage({ tone: "ok", text: done });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const setPlacement = (next: Placement) => void update({ version: template.version, definition: withPlacement(template.definition, next) },
    t("บันทึกตำแหน่งบน Flora Leaf แล้ว", "Leaf placement saved"));
  const createForm = async () => {
    if (!creating) return;
    setBusy(true);
    setMessage(null);
    try {
      const made = await remote.formFromTemplate(template.template_id, creating.formId, creating.title.trim() || undefined);
      setCreating(null);
      onFormCreated(made.form_id);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await remote.deleteTemplate(template.template_id);
      onBack();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
      setBusy(false);
    }
  };

  const tabs: Array<[Pane, string]> = [
    ["check", report ? t(`ตรวจรายการ (${captured}/${coverage.length})`, `Checklist (${captured}/${coverage.length})`) : t("รายละเอียด", "Details")],
    ["form", t("ตัวอย่างฟอร์ม", "Form")], ["print", "A4 PDF"], ["issues", t(`ปัญหา (${issues.length})`, `Problems (${issues.length})`)],
  ];
  const sources = template.sources ?? [];
  const validId = (id: string) => /^[a-z][a-z0-9_]{1,63}$/.test(id);

  return <div className="space-y-3">
    <div className={`${panel} flex flex-wrap items-center gap-2 p-2`}>
      <button type="button" className={small} onClick={onBack}>← {t("คลังแม่แบบ", "Template library")}</button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-[var(--app-text)]">{template.title}</div>
        <div className="text-[11px] text-[var(--app-muted)]"><code>{template.template_id}</code> · v{template.version}
          {report?.document_type ? ` · ${report.document_type}` : ""}{report?.model ? ` · ${report.model}` : ""}</div>
      </div>
      <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${template.status === "reviewed" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-300" : "border-amber-500/40 text-amber-600 dark:text-amber-300"}`}>
        {template.status === "reviewed" ? t("✓ ตรวจแล้ว", "✓ Reviewed") : t("ร่าง · รอตรวจ", "Draft · to review")}</span>
      <button type="button" className={secondary} disabled={busy} onClick={() => onEdit(template)}>✎ {t("แก้ไขในตัวออกแบบ", "Edit in the designer")}</button>
      {template.status === "draft"
        ? <button type="button" className={secondary} disabled={busy || issues.length > 0} title={issues.length ? t("แก้ปัญหาให้หมดก่อน", "Fix the problems first") : undefined}
            onClick={() => void update({ version: template.version, status: "reviewed" }, t("ทำเครื่องหมายว่าตรวจแล้ว", "Marked reviewed"))}>✓ {t("ตรวจแล้ว", "Mark reviewed")}</button>
        : <button type="button" className={secondary} disabled={busy} onClick={() => void update({ version: template.version, status: "draft" })}>{t("กลับเป็นร่าง", "Back to draft")}</button>}
      <button type="button" className={primary} disabled={busy} onClick={() => setCreating({ formId: template.definition.form_id, title: template.definition.title })}>
        {t("สร้างแบบฟอร์มจากแม่แบบ", "Create a form")}</button>
      <button type="button" className={small} onClick={() => download(`${template.template_id}.form.json`, JSON.stringify(template.definition, null, 2))}>⬇ .form.json</button>
      <button type="button" className={danger} disabled={busy} onClick={() => setConfirmDelete(true)}>{t("ลบ", "Delete")}</button>
    </div>

    {isNew && report ? <div className="rounded-xl border border-[var(--app-accent)]/50 bg-[var(--app-accent)]/10 px-3 py-2 text-sm text-[var(--app-text)]">
      {t(`AI สร้างแบบฟอร์มแล้ว (${report.attempts ?? 1} รอบ${report.usage ? `, ${report.usage.seconds} วินาที` : ""}) — ตรวจกับเอกสารต้นฉบับทางซ้ายก่อนใช้งาน`,
        `The AI built the form (${report.attempts ?? 1} round(s)${report.usage ? `, ${report.usage.seconds} s` : ""}) — check it against the source documents on the left before using it`)}
    </div> : null}
    {message ? <div role={message.tone === "error" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${message.tone === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{message.text}</div> : null}

    {confirmDelete ? <div role="alertdialog" className="rounded-xl border border-rose-500/50 bg-[var(--app-panel-bg)] p-3 text-sm text-[var(--app-text)]">
      <div className="font-semibold">{t(`ลบแม่แบบ "${template.title}"?`, `Delete the template "${template.title}"?`)}</div>
      <p className="text-xs text-[var(--app-muted)]">{t("แบบฟอร์มที่สร้างจากแม่แบบนี้แล้วไม่ถูกลบ", "Forms already created from it are not deleted")}</p>
      <div className="mt-2 flex gap-2"><button type="button" className={danger} disabled={busy} onClick={() => void remove()}>{t("ลบแม่แบบ", "Delete template")}</button>
        <button type="button" className={secondary} onClick={() => setConfirmDelete(false)}>{t("ยกเลิก", "Cancel")}</button></div>
    </div> : null}

    {creating ? <div role="dialog" aria-label={t("สร้างแบบฟอร์มจากแม่แบบ", "Create a form from the template")} className={`${panel} space-y-2 p-3`}>
      <div className="text-sm font-semibold text-[var(--app-text)]">{t("สร้างแบบฟอร์ม (ร่างเวอร์ชัน 1) แล้วเปิดในตัวออกแบบเพื่อเผยแพร่", "Create a form (draft version 1) and open it in the designer to publish")}</div>
      {template.status !== "reviewed" ? <p className="text-xs text-amber-600 dark:text-amber-300">{t("แม่แบบนี้ยังไม่ได้ทำเครื่องหมายว่าตรวจแล้ว", "This template is not marked reviewed yet")}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1"><span className={label}>{t("รหัสแบบฟอร์ม", "Form id")}</span>
          <input className={`${input} font-mono`} value={creating.formId} onChange={event => setCreating({ ...creating, formId: event.target.value.toLowerCase() })} /></label>
        <label className="space-y-1"><span className={label}>{t("ชื่อแบบฟอร์ม", "Title")}</span>
          <input className={input} value={creating.title} maxLength={200} onChange={event => setCreating({ ...creating, title: event.target.value })} /></label>
      </div>
      <div className="flex gap-2">
        <button type="button" className={primary} disabled={busy || !validId(creating.formId) || issues.length > 0} onClick={() => void createForm()}>{t("สร้างและเปิด", "Create and open")}</button>
        <button type="button" className={secondary} onClick={() => setCreating(null)}>{t("ยกเลิก", "Cancel")}</button>
        {issues.length ? <span className="self-center text-xs text-rose-600 dark:text-rose-300">{t("แก้ปัญหาในตัวออกแบบก่อน", "Fix the problems in the designer first")}</span> : null}
      </div>
    </div> : null}

    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className={`${panel} space-y-2 p-2`}>
        <div className="flex flex-wrap items-center gap-1">
          <span className="px-1 text-xs font-semibold text-[var(--app-muted)]">{t("เอกสารต้นฉบับ", "Source documents")}</span>
          {sources.map((source, index) => <button key={source.sha256 + index} type="button" onClick={() => setSourceIndex(index)}
            className={`rounded-lg px-2 py-1 text-xs font-semibold ${index === sourceIndex ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)] hover:bg-[var(--app-control-bg)]"}`}
            title={`${source.name} · ${sizeLabel(source.size)}`}>{source.name}</button>)}
        </div>
        {sources[sourceIndex] ? <SourceViewer key={`${sourceIndex}:${sources[sourceIndex].sha256}`} remote={remote} templateId={template.template_id} source={sources[sourceIndex]} lang={lang} />
          : <p className="p-3 text-sm text-[var(--app-muted)]">{t("แม่แบบนี้ไม่ได้สร้างจากเอกสาร", "This template was not built from documents")}</p>}
        {sources[sourceIndex]?.notes.length ? <ul className="px-2 text-[11px] text-amber-600 dark:text-amber-300">{sources[sourceIndex].notes.map(note => <li key={note}>⚠ {note}</li>)}</ul> : null}
      </section>

      <section className="min-w-0 space-y-2">
        <div className="flex flex-wrap gap-1 rounded-xl border border-[var(--app-border)] p-0.5">
          {tabs.map(([id, text]) => <button key={id} type="button" onClick={() => setPane(id)}
            className={`rounded-lg px-2.5 py-1 text-xs font-bold ${pane === id ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{text}</button>)}
        </div>

        {pane === "check" ? <div className="space-y-3">
          {report?.summary ? <p className={`${panel} p-3 text-sm text-[var(--app-text)]`}>{report.summary}</p> : null}

          <div className={`${panel} space-y-2 p-3`}>
            <div className="text-sm font-semibold text-[var(--app-text)]">📍 {t("จุดกรอกบน Flora Leaf (ใช้เป็นค่าเริ่มต้นใน Workflow Studio)", "Where it is filled in on Flora Leaf (Workflow Studio's default)")}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1"><span className={label}>{t("ช่วงของเคส", "Case phase")}</span>
                <select className={input} disabled={busy} value={placement?.phase ?? "any"} onChange={event => setPlacement({ phase: event.target.value as Placement["phase"], after_section: placement?.after_section ?? null })}>
                  {(Object.keys(PHASE_LABEL) as Placement["phase"][]).map(phase => <option key={phase} value={phase}>{tr(lang, ...PHASE_LABEL[phase])}</option>)}
                </select></label>
              <label className="space-y-1"><span className={label}>{t("แสดงเป็นแท็บต่อจาก", "Shown as a tab after")}</span>
                <select className={input} disabled={busy} value={placement?.after_section ?? ""} onChange={event => setPlacement({ phase: placement?.phase ?? "any", after_section: event.target.value || null })}>
                  <option value="">{t("ท้ายสุด (หลังแท็บบันทึกทั้งหมด)", "At the end (after every record tab)")}</option>
                  {LEAF_TABS.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
                </select></label>
            </div>
            {report?.placement.reason ? <p className="text-xs text-[var(--app-muted)]">AI: {report.placement.reason}</p> : null}
          </div>

          {report?.uncertain.length ? <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">{t(`จุดที่ AI ไม่แน่ใจ (${report.uncertain.length})`, `Where the AI was unsure (${report.uncertain.length})`)}</div>
            <ul className="mt-1 space-y-0.5 text-xs text-[var(--app-text)]">{report.uncertain.map((item, index) => <li key={index}>
              {item.field ? <b>{fieldsById.get(item.field)?.label ?? item.field}: </b> : null}{item.note}</li>)}</ul>
          </div> : null}

          {report ? <div className={`${panel} p-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-[var(--app-text)]">{t("รายการบนเอกสาร → ช่องในแบบฟอร์ม", "Items on the documents → form fields")}</div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-emerald-600 dark:text-emerald-300">✓ {captured}</span>
                <span className={report.missing ? "text-rose-600 dark:text-rose-300" : "text-[var(--app-muted)]"}>✕ {report.missing}</span>
                <label className="flex items-center gap-1 text-[var(--app-muted)]"><input type="checkbox" checked={onlyMissing} onChange={event => setOnlyMissing(event.target.checked)} />{t("เฉพาะที่ขาด", "Missing only")}</label>
              </div>
            </div>
            <div className="mt-2 max-h-[60vh] overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[var(--app-panel-bg)] text-[var(--app-muted)]"><tr>
                  <th className="py-1 pr-2">{t("ที่มา", "Source")}</th><th className="py-1 pr-2">{t("รายการบนเอกสาร", "Item on paper")}</th><th className="py-1">{t("ช่องในแบบฟอร์ม", "Form field")}</th></tr></thead>
                <tbody>{shown.map((item, index) => {
                  const field = item.field ? fieldsById.get(item.field) : undefined;
                  return <tr key={index} className={`border-t border-[var(--app-border)] ${item.found ? "" : "bg-rose-500/10"}`}>
                    <td className="py-1 pr-2 align-top text-[var(--app-muted)]">{item.source}</td>
                    <td className="py-1 pr-2 align-top text-[var(--app-text)]">{item.item}{item.note ? <div className="text-[11px] text-[var(--app-muted)]">{item.note}</div> : null}</td>
                    <td className="py-1 align-top">{item.found && field ? <span className="text-emerald-700 dark:text-emerald-300">✓ {field.label} <code className="text-[10px] text-[var(--app-muted)]">{field.id} · {field.type}</code></span>
                      : item.field ? <span className="text-rose-600 dark:text-rose-300">✕ {t(`ไม่มีช่อง "${item.field}" ในแบบฟอร์ม`, `no field "${item.field}" in the form`)}</span>
                        : <span className="text-rose-600 dark:text-rose-300">✕ {t("ยังไม่มีในแบบฟอร์ม", "not in the form")}</span>}</td>
                  </tr>;
                })}</tbody>
              </table>
              {!shown.length ? <p className="py-2 text-xs text-[var(--app-muted)]">{t("ไม่มีรายการ", "Nothing to show")}</p> : null}
            </div>
          </div> : <p className={`${panel} p-3 text-sm text-[var(--app-muted)]`}>{t("แม่แบบนี้ไม่มีรายงานจาก AI", "This template has no AI report")}</p>}
          {report?.instructions ? <p className="text-xs text-[var(--app-muted)]">{t("คำสั่งที่ให้ AI: ", "Instructions given: ")}{report.instructions}</p> : null}
        </div> : null}

        {pane === "form" ? <div className="rounded-2xl bg-[var(--app-bg)] p-1">
          <FormRenderer definition={template.definition} value={tryData} language={language} styles={registry.styles} fonts={registry.fonts} onChange={setTryData} />
        </div> : null}
        {pane === "print" ? <PdfPreview definition={template.definition} value={tryData} styles={registry.styles} fonts={registry.fonts} language={lang} /> : null}
        {pane === "issues" ? <div className={`${panel} space-y-1 p-3`}>
          {issues.length ? issues.map((item, index) => <div key={index} className="text-xs">
            <span className="font-semibold text-[var(--app-text)]">{item.location ?? item.path}</span> — <span className="text-rose-600 dark:text-rose-300">{issueText(item, language)}</span>
          </div>) : <p className="text-sm text-emerald-600 dark:text-emerald-300">✓ {t("ไม่มีปัญหา ตรวจผ่านตัวตรวจสอบของระบบ", "No problems: the form passes the validator")}</p>}
          {issues.length ? <p className="pt-1 text-xs text-[var(--app-muted)]">{t("กด \"แก้ไขในตัวออกแบบ\" เพื่อแก้ แล้วบันทึกกลับเข้าแม่แบบ", "Use \"Edit in the designer\" to fix them and save back to the template")}</p> : null}
        </div> : null}
      </section>
    </div>
  </div>;
}
