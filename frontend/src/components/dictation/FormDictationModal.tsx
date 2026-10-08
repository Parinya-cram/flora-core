import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BACKEND_BASE } from "../../api/backendBase";
import { readStoredAuthToken } from "../../api/authApi";
import { useDictation } from "../../hooks/useDictation";
import { LanguageToggle, MicIcon } from "../common/DictationButton";
import { applyFieldValue, describeField, formatValue, scanFormFields, type ScannedField } from "./formFields";

/**
 * Dictate a form: speak (offline, live transcript), then the hospital's AI service
 * maps what was said onto the fields of the tab on screen. Nothing changes until
 * the clinician reviews the proposed values and applies them; Save stays manual.
 */

type Proposal = { field: ScannedField; value: unknown; apply: boolean };
type Phase = "listening" | "extracting" | "review" | "done";

async function extract(form: string, transcript: string, fields: ScannedField[]) {
  const token = readStoredAuthToken();
  const response = await fetch(`${BACKEND_BASE}/api/dictation/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-FLORA-Session": token } : {}) },
    body: JSON.stringify({
      form, transcript,
      fields: fields.map(f => ({ id: f.id, label: f.label, group: f.group, section: f.section, type: f.type,
        options: f.options, placeholder: f.placeholder, value: f.value })),
    }),
  });
  const data = await response.json().catch(() => ({})) as { values?: Record<string, unknown>; unmatched?: string; detail?: unknown };
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Form filling failed (${response.status})`);
  return { values: data.values || {}, unmatched: data.unmatched || "" };
}

export default function FormDictationModal({ open, onClose, rootRef, formName }: {
  open: boolean; onClose: () => void; rootRef: RefObject<HTMLElement | null>; formName: string;
}) {
  const dictation = useDictation();
  const [phase, setPhase] = useState<Phase>("listening");
  const [transcript, setTranscript] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [unmatched, setUnmatched] = useState("");
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(0);
  const [fieldCount, setFieldCount] = useState(0);
  const [prefix, setPrefix] = useState("");
  const startRef = useRef(dictation.start);
  useLayoutEffect(() => { startRef.current = dictation.start; });

  // Mounted fresh for each dictation (the parent renders it only while open): listen straight away.
  useEffect(() => {
    if (open) void startRef.current();
  }, [open]);

  if (!open) return null;

  const live = [dictation.text, dictation.partial].filter(Boolean).join(" ");

  const runExtraction = async (text: string) => {
    const root = rootRef.current;
    if (!text.trim()) { setError("Nothing was heard. Try again closer to the microphone."); setPhase("review"); return; }
    if (!root) { setError("The form is not on screen."); return; }
    setPhase("extracting"); setError("");
    const fields = scanFormFields(root);
    setFieldCount(fields.length);
    try {
      const result = await extract(formName, text, fields);
      const byId = new Map(fields.map(f => [f.id, f]));
      setProposals(Object.entries(result.values).flatMap(([id, value]) => {
        const field = byId.get(id);
        return field && formatValue(value) !== formatValue(field.value) ? [{ field, value, apply: true }] : [];
      }));
      setUnmatched(result.unmatched);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setPhase("review");
  };

  const stopAndFill = async () => {
    const spoken = await dictation.stop();
    const text = [prefix, spoken].filter(Boolean).join(" ");
    setTranscript(text);
    await runExtraction(text);
  };

  const restart = async () => {
    // Speaking again adds to the transcript so far.
    setPrefix(transcript); setProposals([]); setUnmatched(""); setError(""); setPhase("listening");
    await dictation.start();
  };

  const applyAll = () => {
    let count = 0;
    for (const p of proposals) if (p.apply && applyFieldValue(p.field, p.value)) count += 1;
    setApplied(count);
    setPhase("done");
  };

  const cancel = () => {
    if (dictation.recording) void dictation.stop();
    onClose();
  };

  const selected = proposals.filter(p => p.apply).length;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4" data-no-dictation>
      <div className="app-theme-scope flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg,#fff)] text-[var(--app-text)] shadow-2xl">
        <div className="flex items-start gap-3 border-b border-[var(--app-border)] p-4">
          <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${dictation.recording ? "bg-red-100 text-red-600 dark:bg-red-950/50" : "bg-[var(--app-accent)]/12 text-[var(--app-accent)]"}`}>
            <MicIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">Dictation · {formName}</div>
            <h2 className="text-lg font-bold">
              {phase === "listening" ? (dictation.recording ? "Listening…" : dictation.busy ? "Starting microphone…" : "Microphone off")
                : phase === "extracting" ? "Filling the form…" : phase === "done" ? "Fields filled" : "Review the values"}
            </h2>
            <p className="text-xs text-[var(--app-muted)]">
              Speech is transcribed on this Leaf (offline). The AI service then fills the fields on the tab on screen; review before Save.
            </p>
          </div>
          <button type="button" onClick={cancel} className="rounded-lg px-2 py-1 text-lg text-[var(--app-muted)]" aria-label="Close">×</button>
        </div>

        <div className="flex-1 space-y-3 overflow-auto p-4">
          {phase === "listening" ? (
            <>
              <div className="flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--app-border)]">
                  <div className="h-full rounded-full bg-red-500 transition-[width] duration-150" style={{ width: `${Math.round(dictation.level * 100)}%` }} />
                </div>
                <LanguageToggle value={dictation.language} onChange={dictation.setLanguage} disabled={dictation.recording || dictation.busy} />
              </div>
              <div className="min-h-[140px] whitespace-pre-wrap rounded-xl border border-[var(--app-border)] p-3 text-sm leading-relaxed">
                {prefix ? <span>{prefix} </span> : null}
                {dictation.text ? <span>{dictation.text} </span> : null}
                {dictation.partial ? <span className="text-[var(--app-muted)]">{dictation.partial}</span> : null}
                {!live && !prefix ? <span className="text-[var(--app-muted)]">Speak naturally, e.g. "ผู้ป่วยน้ำหนัก 70 กิโล สูง 170 ASA 2 ทำ general anesthesia monitor NIBP ECG pulse oximetry นอนหงาย"</span> : null}
              </div>
            </>
          ) : null}

          {phase !== "listening" ? (
            <div className="grid gap-1">
              <label className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--app-muted)]">Transcript (editable)</label>
              <textarea value={transcript} onChange={e => setTranscript(e.target.value)} disabled={phase === "extracting"}
                className="min-h-[90px] rounded-xl border border-[var(--app-border)] bg-transparent p-3 text-sm" />
            </div>
          ) : null}

          {phase === "extracting" ? <div className="text-sm text-[var(--app-muted)]">Asking the AI service to match the transcript to {fieldCount} fields…</div> : null}

          {phase === "review" && proposals.length ? (
            <div className="overflow-hidden rounded-xl border border-[var(--app-border)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--app-accent)]/8 text-left text-[10px] uppercase tracking-[0.1em] text-[var(--app-muted)]">
                  <tr><th className="w-8 p-2" /><th className="p-2">Field</th><th className="p-2">Now</th><th className="p-2">New</th></tr>
                </thead>
                <tbody>
                  {proposals.map((p, index) => (
                    <tr key={p.field.id} className="border-t border-[var(--app-border)]">
                      <td className="p-2"><input type="checkbox" checked={p.apply} onChange={e => setProposals(list => list.map((x, i) => i === index ? { ...x, apply: e.target.checked } : x))} /></td>
                      <td className="p-2 font-medium">{describeField(p.field)}</td>
                      <td className="p-2 text-[var(--app-muted)]">{formatValue(p.field.value)}</td>
                      <td className="p-2 font-semibold text-[var(--app-accent)]">{formatValue(p.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {phase === "review" && !proposals.length && !error ? <div className="text-sm text-[var(--app-muted)]">No field on this tab matched what was said.</div> : null}
          {unmatched && phase !== "listening" ? <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"><b>Not placed in a field:</b> {unmatched}</div> : null}
          {phase === "done" ? <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">{applied} field{applied === 1 ? "" : "s"} filled. Check them, then press Save.</div> : null}
          {error || dictation.error ? <div className="text-sm text-red-600 dark:text-red-400">{error || dictation.error}</div> : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--app-border)] p-3">
          {phase === "listening" ? (
            <>
              <button type="button" onClick={cancel} className="rounded-xl border border-[var(--app-border)] px-4 py-2 text-sm">Cancel</button>
              {!dictation.recording && !dictation.busy ? <button type="button" onClick={() => void dictation.start()} className="rounded-xl border border-[var(--app-border)] px-4 py-2 text-sm">Start again</button> : null}
              <button type="button" onClick={() => void stopAndFill()} disabled={!dictation.recording}
                className="rounded-xl bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">
                {dictation.busy ? "Finishing…" : "Stop & fill"}
              </button>
            </>
          ) : phase === "done" ? (
            <button type="button" onClick={onClose} className="rounded-xl bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)]">Close</button>
          ) : (
            <>
              <button type="button" onClick={cancel} className="rounded-xl border border-[var(--app-border)] px-4 py-2 text-sm">Cancel</button>
              <button type="button" onClick={() => void restart()} disabled={phase === "extracting"} className="rounded-xl border border-[var(--app-border)] px-4 py-2 text-sm">Dictate again</button>
              <button type="button" onClick={() => void runExtraction(transcript)} disabled={phase === "extracting"} className="rounded-xl border border-[var(--app-border)] px-4 py-2 text-sm">Re-run on transcript</button>
              <button type="button" onClick={applyAll} disabled={phase === "extracting" || !selected}
                className="rounded-xl bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">
                Fill {selected} field{selected === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
