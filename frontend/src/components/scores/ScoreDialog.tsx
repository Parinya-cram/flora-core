import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  deleteManualScore, evaluateCaseScore, type CaseScoreDefinition, type CaseScoreRow, type ScoreResult,
} from "../../api/scoresApi";
import { useWorkstationSettings } from "../../hooks/useWorkstationSettings";
import { formatConfiguredDateTime } from "../../utils/dateTime";
import { LEVEL_TONE } from "../workflow/scoreTone";

type Props = {
  caseId: number;
  definition: CaseScoreDefinition;
  /** Time point to show or record (epoch ms). */
  ts: number;
  /** The stored result at that point, if any. */
  result: CaseScoreRow | null;
  readOnly?: boolean;
  onClose: () => void;
  onChanged: () => void;
};

const field = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";

function shown(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * A score at one time point: its items, the readings used (with their time) and what is missing.
 * The clinician can enter the values that are not charted and record the result at that time.
 */
export default function ScoreDialog({ caseId, definition, ts, result, readOnly = false, onClose, onChanged }: Props) {
  const workstation = useWorkstationSettings();
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ScoreResult | null>(result);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pointTs = Math.min(result?.ts ?? ts, Date.now());
  const entered = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));

  const calculate = useCallback(async (input: Record<string, string>) => {
    setError("");
    try {
      setPreview(await evaluateCaseScore(caseId, definition.id, { ts: pointTs, values: input }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [caseId, definition.id, pointTs]);

  useEffect(() => {
    if (result) return;
    let alive = true;
    void evaluateCaseScore(caseId, definition.id, { ts: pointTs }).then(next => { if (alive) setPreview(next); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [caseId, definition.id, pointTs, result]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const record = async () => {
    setBusy(true);
    setError("");
    try {
      await evaluateCaseScore(caseId, definition.id, { ts: pointTs, values: entered, save: true });
      onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await deleteManualScore(caseId, result.id);
      onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const current = preview;
  const band = current?.band ? definition.bands.find(item => item.label === current.band) : undefined;
  const editable = !readOnly;
  const enterable = definition.inputs.filter(input => input.source === "manual" || input.options?.length || input.type === "text");

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="app-theme-scope fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={`${definition.name} score`} className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Clinical score · v{definition.version}{result ? ` · ${result.source === "manual" ? `recorded by ${result.created_by || "—"}` : "automatic"}` : " · now from the chart"}</div>
            <h2 className="text-lg font-bold">{definition.name} <span className="text-sm font-normal text-[var(--app-muted)]">{formatConfiguredDateTime(pointTs, workstation)}</span></h2>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-lg text-[var(--app-muted)] hover:bg-[var(--app-control-bg-hover)]" aria-label="Close">×</button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {current ? <div className={`rounded-xl border px-3 py-2 ${LEVEL_TONE[current.level || "info"]}`}>
            <div className="text-xl font-extrabold">{current.total ?? "—"}{current.band ? <span className="ml-2 text-sm font-bold">{current.band}</span> : null}{current.partial ? <span className="ml-2 text-xs font-semibold">partial</span> : null}</div>
            {band?.action ? <div className="text-xs">{band.action}</div> : null}
          </div> : <div className="text-sm text-[var(--app-muted)]">Calculating…</div>}
          {current?.flags.map(flag => <div key={flag.label} className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${LEVEL_TONE[flag.level]}`}>⚠ {flag.label}</div>)}
          {current ? <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] uppercase tracking-[0.1em] text-[var(--app-muted)]"><th className="py-1">Item</th><th className="py-1">Value</th><th className="py-1">From</th><th className="py-1 text-right">Points</th></tr></thead>
            <tbody>{current.items.map(item => {
              const used = current.inputs[item.key] || current.inputs[definition.items.find(entry => entry.key === item.key)?.input || ""];
              return <tr key={item.key} className="border-t border-[var(--app-border)]">
                <td className="py-1.5">{item.label}</td>
                <td className="py-1.5 font-mono">{shown(used ? used.value : item.value)}</td>
                <td className="py-1.5 text-xs text-[var(--app-muted)]">{used?.source === "manual" ? "entered" : used?.source === "default" ? "default" : used?.ts ? `${used.param} ${formatConfiguredDateTime(used.ts, workstation).split(" ").pop()}` : ""}</td>
                <td className="py-1.5 text-right font-bold">{item.points ?? <span className="text-amber-600 dark:text-amber-300">missing</span>}</td>
              </tr>;
            })}</tbody>
          </table> : null}
          {current?.missing.length ? <p className="text-xs text-[var(--app-muted)]">Missing readings: chart them in the vital sign rows (within the score's time window) or enter them below.</p> : null}
          {editable && enterable.length ? <div className="grid gap-2 sm:grid-cols-2">
            {enterable.map(input => <label key={input.key} className="text-xs font-bold text-[var(--app-muted)]">{input.label}{input.unit ? ` (${input.unit})` : ""}
              {input.options?.length ? <select className={`${field} mt-1`} value={values[input.key] ?? ""} onChange={event => setValues(next => ({ ...next, [input.key]: event.target.value }))}>
                <option value="">{input.source === "param" ? "from the chart" : "—"}</option>
                {input.options.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label ? `${option.label} (${option.points})` : `${String(option.value)} (${option.points})`}</option>)}
              </select> : input.type === "bool" ? <select className={`${field} mt-1`} value={values[input.key] ?? ""} onChange={event => setValues(next => ({ ...next, [input.key]: event.target.value }))}>
                <option value="">{input.default !== undefined && input.default !== null ? `default (${shown(input.default)})` : "from the chart"}</option><option value="yes">yes</option><option value="no">no</option>
              </select> : <input className={`${field} mt-1`} value={values[input.key] ?? ""} placeholder={input.source === "param" ? "from the chart" : ""}
                onChange={event => setValues(next => ({ ...next, [input.key]: event.target.value }))} />}
            </label>)}
          </div> : null}
          {definition.reference ? <p className="text-[11px] text-[var(--app-muted)]">Reference: {definition.reference}</p> : null}
          {error ? <div className="rounded-lg border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-500">{error}</div> : null}
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
          {editable && result?.source === "manual" ? <button type="button" className={button} disabled={busy} onClick={() => void remove()}>Delete record</button> : null}
          {editable ? <button type="button" className={button} disabled={busy} onClick={() => void calculate(entered)}>Calculate</button> : null}
          {editable ? <button type="button" className={primary} disabled={busy || current?.total === null || current?.total === undefined} onClick={() => void record()}>Record at this time</button> : null}
          <button type="button" className={button} onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
