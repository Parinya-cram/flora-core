/**
 * Preview (Phase 1.11): load a form definition as JSON (paste, file, or a published form), validate it with
 * readable errors, and render it as Desktop, Tablet, Mobile or A4 Print. Works offline with the bundled
 * registry; uses the server's registry when it is reachable.
 */
import { useEffect, useMemo, useState } from "react";
import type { RestApiAdapter } from "../data/RestApiAdapter";
import type { FontEntry, FormDefinition, RecordData, StyleEntry } from "../core/types";
import { describeIssues, issueText, parseJsonStrict, validateDefinition, validateRecord } from "../core/validate";
import { DEFAULT_FONTS, DEFAULT_STYLES } from "../registry/defaults";
import FormPrint from "./FormPrint";
import FormRenderer from "./FormRenderer";

type Mode = "desktop" | "tablet" | "mobile" | "a4";
type Props = { remote?: RestApiAdapter; online?: boolean; definitions?: FormDefinition[]; language?: string };

const MODES: Array<{ mode: Mode; label: string; width: number | null }> = [
  { mode: "desktop", label: "Desktop", width: 1100 },
  { mode: "tablet", label: "Tablet", width: 768 },
  { mode: "mobile", label: "Mobile", width: 390 },
  { mode: "a4", label: "A4 Print", width: null },
];
const panel = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";

export default function FormPreview({ remote, online = false, definitions = [], language = "en" }: Props) {
  const [text, setText] = useState(() => (definitions[0] ? JSON.stringify(definitions[0], null, 2) : ""));
  const [mode, setMode] = useState<Mode>("desktop");
  const [data, setData] = useState<RecordData>({});
  const [registry, setRegistry] = useState<{ styles: StyleEntry[]; fonts: FontEntry[]; source: string }>({ styles: DEFAULT_STYLES, fonts: DEFAULT_FONTS, source: "bundled" });

  useEffect(() => {
    if (!remote || !online) return;
    let cancelled = false;
    void Promise.all([remote.listStyles(), remote.listFonts()])
      .then(([styles, fonts]) => !cancelled && styles.length && setRegistry({ styles, fonts, source: "server" }))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [remote, online]);

  const parsed = useMemo(() => {
    if (!text.trim()) return { definition: null, issues: [] };
    const { value, issues } = parseJsonStrict(text);
    if (issues.some(item => item.code === "invalid_json")) return { definition: null, issues: issues.map(item => ({ ...item, location: "JSON" })) };
    const found = [...issues, ...validateDefinition(value, registry.styles.map(row => row.style_id), registry.fonts.map(row => row.font_id))];
    return { definition: value as FormDefinition, issues: describeIssues(value, found) };
  }, [text, registry]);

  // Render only definitions that are structurally sound; show the last good one while the JSON is being edited.
  const [shown, setShown] = useState<FormDefinition | null>(null);
  const renderable = parsed.definition && !parsed.issues.some(item => ["not_object", "no_sections", "invalid_type", "invalid_field_type", "container_requires_fields"].includes(item.code));
  if (renderable && parsed.definition !== shown) setShown(parsed.definition);
  const recordIssues = useMemo(() => (shown ? validateRecord(shown, data, "submitted") : []), [shown, data]);

  const loadFile = async (file: File | undefined) => {
    if (file) setText(await file.text());
  };
  const width = MODES.find(item => item.mode === mode)?.width ?? null;

  return <div className="grid gap-4 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
    <section className={`${panel} space-y-3 p-4`}>
      <div className="text-sm font-semibold text-[var(--app-text)]">Form definition (flora.form/1)</div>
      <div className="flex flex-wrap gap-2">
        <label className={`${secondary} cursor-pointer`}>Load JSON file<input type="file" accept=".json,application/json" className="hidden" onChange={event => void loadFile(event.target.files?.[0])} /></label>
        {definitions.length ? <select aria-label="Load a published form" className={secondary} value="" onChange={event => {
          const chosen = definitions.find(item => item.form_id === event.target.value);
          if (chosen) setText(JSON.stringify(chosen, null, 2));
        }}>
          <option value="">Published form…</option>
          {definitions.map(item => <option key={item.form_id} value={item.form_id}>{item.title} (v{item.schema_version})</option>)}
        </select> : null}
        <button type="button" className={secondary} onClick={() => setData({})}>Clear sample data</button>
      </div>
      <textarea aria-label="Form definition JSON" spellCheck={false} value={text} onChange={event => setText(event.target.value)}
        className="h-[28rem] w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 font-mono text-xs text-[var(--app-text)]" placeholder='{"format": "flora.form/1", ...}' />
      <div className="text-xs text-[var(--app-muted)]">Registry: {registry.source} ({registry.styles.length} styles, {registry.fonts.length} fonts)</div>
      {parsed.issues.length ? <ul aria-label="Definition problems" className="max-h-64 space-y-1 overflow-y-auto text-xs">
        {parsed.issues.map((item, index) => <li key={`${item.path}:${item.code}:${index}`} className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-rose-700 dark:text-rose-300">
          <div className="font-semibold">{item.location}</div>
          <div>{issueText(item, language)} <code className="opacity-70">{item.code}</code></div>
        </li>)}
      </ul> : parsed.definition ? <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">Definition is valid.</div> : null}
    </section>

    <section className={`${panel} min-w-0 space-y-3 p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex flex-wrap gap-1" aria-label="Preview mode">
          {MODES.map(item => <button key={item.mode} type="button" aria-pressed={mode === item.mode} onClick={() => setMode(item.mode)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${mode === item.mode ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)] hover:bg-[var(--app-control-bg)]"}`}>{item.label}</button>)}
        </nav>
        <div className="flex items-center gap-2 text-xs text-[var(--app-muted)]">
          {shown && mode !== "a4" ? <span>{recordIssues.length} validation message(s) on the sample data</span> : null}
          {mode === "a4" && shown ? <button type="button" className={secondary} onClick={() => window.print()}>Print</button> : null}
        </div>
      </div>
      {!shown ? <div className="py-16 text-center text-sm text-[var(--app-muted)]">Load a form definition to preview it.</div> : mode === "a4"
        ? <div className="overflow-x-auto rounded-xl bg-slate-200 p-4 dark:bg-slate-800"><FormPrint definition={shown} value={data} styles={registry.styles} fonts={registry.fonts} /></div>
        : <div className="overflow-x-auto rounded-xl bg-slate-200 p-4 dark:bg-slate-800">
          <div data-preview-width={width} style={{ width: width ?? undefined, maxWidth: "none", margin: "0 auto" }}>
            <FormRenderer definition={shown} value={data} issues={recordIssues} language={language} mode={mode as "desktop" | "tablet" | "mobile"} styles={registry.styles} fonts={registry.fonts} onChange={setData} />
          </div>
        </div>}
    </section>
  </div>;
}
