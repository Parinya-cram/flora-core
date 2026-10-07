/** One AI Studio visual: runs its queries on current data, renders it in a locked-down iframe, and offers re-run, keep and share. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { renderData, runKept, type Artifact, type KeptArtifact, type Period, type RenderResult } from "../api/aiStudioApi";
import { buildSrcDoc, readTheme } from "./runtime";
import { tr, type Lang } from "../reportstudio/model";
import { input, small } from "../reportstudio/styles";

type Props = {
  lang: Lang;
  artifact: Artifact | KeptArtifact;
  /** A kept visual re-runs through its own endpoint (works for visuals shared by others). */
  keptId?: string;
  actions?: React.ReactNode;
  tall?: boolean;
};

export default function ArtifactFrame({ lang, artifact, keptId, actions, tall }: Props) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const frameId = useId();
  const frame = useRef<HTMLIFrameElement>(null);
  const [period, setPeriod] = useState<Period>({});
  const [result, setResult] = useState<RenderResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [scriptError, setScriptError] = useState("");
  const [height, setHeight] = useState(tall ? 520 : 360);
  const [showCode, setShowCode] = useState(false);
  const specKey = JSON.stringify(artifact.data);

  const run = useCallback(async (next: Period) => {
    setRunning(true);
    setError("");
    setScriptError("");
    try {
      setResult(keptId ? await runKept(keptId, next) : await renderData(JSON.parse(specKey), next));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }, [keptId, specKey]);

  useEffect(() => { if (!artifact.error) void run({}); }, [run, artifact.error]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data as { flora?: boolean; type?: string; height?: number; message?: string };
      if (!message?.flora) return;
      if (message.type === "height" && typeof message.height === "number") setHeight(Math.max(120, Math.min(2400, message.height + 4)));
      if (message.type === "error") setScriptError(String(message.message || "Script error"));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const srcDoc = useMemo(() => (result ? buildSrcDoc(artifact.html, result.data, result.params, readTheme(), frameId) : ""), [artifact.html, result, frameId]);
  const dataErrors = result ? Object.entries(result.data).filter(([, value]) => value.error).map(([name, value]) => `${name}: ${value.error}`) : [];

  return <div className="overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--app-border)] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[var(--app-text)]">{artifact.title}</div>
        <div className="text-[10px] text-[var(--app-muted)]">
          {result ? t(`ข้อมูล ณ ${new Date(result.ranAt).toLocaleString()}`, `Data as of ${new Date(result.ranAt).toLocaleString()}`) : running ? t("กำลังดึงข้อมูล…", "Loading data…") : ""}
          {result?.params.from || result?.params.to ? ` · ${result.params.from ?? "…"} → ${result.params.to ?? "…"}` : ""}
        </div>
      </div>
      <input type="date" aria-label={t("ตั้งแต่", "From")} className={`${input} w-auto py-1 text-xs`} value={period.from ?? ""} onChange={event => setPeriod(current => ({ ...current, from: event.target.value || undefined }))} />
      <span className="text-xs text-[var(--app-muted)]">→</span>
      <input type="date" aria-label={t("ถึง", "To")} className={`${input} w-auto py-1 text-xs`} value={period.to ?? ""} onChange={event => setPeriod(current => ({ ...current, to: event.target.value || undefined }))} />
      <button type="button" className={small} disabled={running || Boolean(artifact.error)} onClick={() => void run(period)} title={t("รันใหม่ด้วยข้อมูลล่าสุด", "Run again on current data")}>↻ {t("รันใหม่", "Re-run")}</button>
      <button type="button" className={small} onClick={() => setShowCode(value => !value)}>{showCode ? t("ซ่อนโค้ด", "Hide code") : "</>"}</button>
      {actions}
    </div>
    {artifact.error ? <div className="m-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{t("ภาพนี้ใช้งานไม่ได้: ", "This visual cannot run: ")}{artifact.error}</div> : null}
    {error ? <div className="m-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{error}</div> : null}
    {dataErrors.length || scriptError ? <div className="mx-3 mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      {[...dataErrors, scriptError].filter(Boolean).join(" · ")}
    </div> : null}
    {srcDoc ? <iframe ref={frame} title={artifact.title} sandbox="allow-scripts" srcDoc={srcDoc} className={`block w-full border-0 transition-opacity ${running ? "opacity-50" : ""}`} style={{ height }} /> : null}
    {!srcDoc && running ? <div className="p-10 text-center text-xs text-[var(--app-muted)]">{t("กำลังดึงข้อมูล…", "Loading data…")}</div> : null}
    {showCode ? <div className="space-y-2 border-t border-[var(--app-border)] p-3">
      {Object.entries(artifact.data).map(([name, spec]) => <details key={name} open className="text-xs">
        <summary className="cursor-pointer font-semibold text-[var(--app-text)]">{t("ข้อมูล", "Data")} “{name}” · {result?.data[name]?.rows.length ?? "…"} {t("แถว", "rows")}</summary>
        <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-[var(--app-control-bg)] p-2 font-mono text-[11px] text-[var(--app-text)]">{JSON.stringify(spec, null, 2)}</pre>
      </details>)}
      <details className="text-xs">
        <summary className="cursor-pointer font-semibold text-[var(--app-text)]">HTML</summary>
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--app-control-bg)] p-2 font-mono text-[11px] text-[var(--app-text)]">{artifact.html}</pre>
      </details>
    </div> : null}
  </div>;
}
