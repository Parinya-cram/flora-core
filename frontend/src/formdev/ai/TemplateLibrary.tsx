/**
 * Template library (Form Studio → Templates): every kept template (built by the AI from documents, imported from
 * a .form.json, or kept from the designer), the paper forms that ship with Form Studio, and the AI builder.
 * Templates are starting points to review; forms made from them are published in Form Studio and only then offered
 * in Workflow Studio.
 */
import { useCallback, useEffect, useState } from "react";
import type { FormDefinition } from "../core/types";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import { STARTERS, langOf, tr } from "../designer/catalog";
import { panel, primary, small } from "../designer/styles";
import { PAPER_TEMPLATES } from "../designer/templates";
import AiBuilder from "./AiBuilder";
import { errorMessage } from "./files";
import TemplateReview from "./TemplateReview";
import type { Template, TemplateRow } from "./types";

type Props = {
  remote: RestApiAdapter; online: boolean; language?: string;
  /** Open the template's definition in the designer; saving there writes back to the template. */
  onEdit: (template: Template) => void;
  /** A form was created from a template: open it in the designer. */
  onFormCreated: (formId: string) => void;
  /** Opens this template's review when it changes (e.g. after saving it from the designer). */
  focus?: { templateId: string; key: number } | null;
};
type Screen = { kind: "list" } | { kind: "build" } | { kind: "review"; templateId: string; isNew: boolean };

const ORIGIN: Record<TemplateRow["origin"], [string, string]> = { ai: ["✨ AI", "✨ AI"], import: ["นำเข้า", "Imported"], manual: ["สร้างเอง", "Hand-made"] };

export default function TemplateLibrary({ remote, online, language = "th", onEdit, onFormCreated, focus }: Props) {
  const lang = langOf(language);
  const t = (th: string, en: string) => tr(lang, th, en);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await remote.listTemplates());
      setError("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [remote]);
  useEffect(() => { if (online && screen.kind === "list") void load(); }, [online, screen.kind, load]);
  useEffect(() => { if (focus) setScreen({ kind: "review", templateId: focus.templateId, isNew: false }); }, [focus]);

  if (!online) return <div className={`${panel} p-4 text-sm text-[var(--app-muted)]`}>{t("คลังแม่แบบต้องเชื่อมต่อเซิร์ฟเวอร์", "The template library needs the server")}</div>;
  if (screen.kind === "build") return <AiBuilder remote={remote} lang={lang} onCancel={() => setScreen({ kind: "list" })}
    onBuilt={result => setScreen({ kind: "review", templateId: result.template.template_id, isNew: true })} />;
  if (screen.kind === "review") return <TemplateReview key={screen.templateId} remote={remote} lang={lang} language={language} templateId={screen.templateId} isNew={screen.isNew}
    onBack={() => setScreen({ kind: "list" })} onEdit={onEdit} onFormCreated={onFormCreated} />;

  const keepBuiltIn = async (id: string, title: string) => {
    setBusy(true);
    try {
      const definition: FormDefinition = PAPER_TEMPLATES[id](`${id}_form`, title);
      const saved = await remote.createTemplate({ definition, title, origin: "manual" });
      setScreen({ kind: "review", templateId: saved.template.template_id, isNew: false });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const needle = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter(row => !needle || row.title.toLowerCase().includes(needle) || row.template_id.includes(needle));
  const builtIn = STARTERS.filter(starter => PAPER_TEMPLATES[starter.id]);

  return <div className="space-y-4">
    <section className={`${panel} flex flex-wrap items-center gap-3 p-4`}>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-[var(--app-text)]">{t("คลังแม่แบบ", "Template library")}</h2>
        <p className="text-xs text-[var(--app-muted)]">{t("เอกสาร → AI สร้างแม่แบบ → ตรวจกับต้นฉบับ → สร้างแบบฟอร์มและเผยแพร่ → เลือกใช้ใน Workflow Studio เพื่อกรอกบน Flora Leaf",
          "Documents → AI builds a template → check it against the originals → create and publish a form → pick it in Workflow Studio for Flora Leaf")}</p>
      </div>
      <input className="w-48 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)]" placeholder={t("ค้นหา", "Search")}
        value={filter} onChange={event => setFilter(event.target.value)} aria-label={t("ค้นหาแม่แบบ", "Search templates")} />
      <button type="button" className={primary} onClick={() => setScreen({ kind: "build" })}>✨ {t("สร้างจากเอกสารด้วย AI", "Build from documents with AI")}</button>
    </section>

    {error ? <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300">{error}</div> : null}

    <section className="space-y-2">
      {rows === null ? <p className="text-sm text-[var(--app-muted)]">…</p> : !shown.length
        ? <div className={`${panel} p-6 text-center text-sm text-[var(--app-muted)]`}>{rows.length ? t("ไม่พบแม่แบบที่ค้นหา", "No template matches") : t("ยังไม่มีแม่แบบ — เริ่มจากอัปโหลดเอกสารให้ AI สร้าง", "No templates yet — start by uploading documents for the AI")}</div>
        : <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map(row => <button key={row.template_id} type="button" onClick={() => setScreen({ kind: "review", templateId: row.template_id, isNew: false })}
            className={`${panel} p-3 text-left hover:border-[var(--app-accent)]`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-[var(--app-text)]">{row.title}</div>
                <div className="text-[11px] text-[var(--app-muted)]"><code>{row.template_id}</code> · v{row.version} · {new Date(row.updated_at).toLocaleString(lang === "th" ? "th-TH" : "en-GB")}</div>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${row.status === "reviewed" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-300" : "border-amber-500/40 text-amber-600 dark:text-amber-300"}`}>
                {row.status === "reviewed" ? t("ตรวจแล้ว", "Reviewed") : t("รอตรวจ", "To review")}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-[var(--app-muted)]">
              <span>{tr(lang, ...ORIGIN[row.origin])}</span>
              {row.sources?.length ? <span>📄 {row.sources.map(source => source.name).join(", ")}</span> : null}
            </div>
          </button>)}
        </div>}
    </section>

    <section className={`${panel} space-y-2 p-4`}>
      <h3 className="text-sm font-semibold text-[var(--app-text)]">{t("แม่แบบกระดาษที่มากับ Form Studio", "Paper forms that ship with Form Studio")}</h3>
      <div className="grid gap-2 md:grid-cols-2">
        {builtIn.map(starter => <div key={starter.id} className="flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
          <div className="text-2xl">{starter.icon}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--app-text)]">{tr(lang, starter.th, starter.en)}</div>
            <div className="text-[11px] text-[var(--app-muted)]">{tr(lang, starter.hintTh, starter.hintEn)}</div>
          </div>
          <button type="button" className={small} disabled={busy} onClick={() => void keepBuiltIn(starter.id, tr(lang, starter.th, starter.en))}>{t("เก็บเข้าคลัง", "Add to library")}</button>
        </div>)}
      </div>
    </section>
  </div>;
}
