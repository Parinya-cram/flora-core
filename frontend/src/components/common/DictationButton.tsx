import { useEffect, useLayoutEffect, useRef } from "react";
import { useDictation, type DictationLanguage } from "../../hooks/useDictation";

/** Microphone for one text field: speech is typed into the field live (offline STT). */

export function MicIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

export function LanguageToggle({ value, onChange, disabled }: {
  value: DictationLanguage; onChange: (v: DictationLanguage) => void; disabled?: boolean;
}) {
  const items: Array<[DictationLanguage, string]> = [["th", "ไทย"], ["en", "EN"], ["auto", "Auto"]];
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border,#e5e7eb)] text-xs" role="group" aria-label="Dictation language">
      {items.map(([code, text]) => (
        <button key={code} type="button" disabled={disabled} onClick={() => onChange(code)}
          className={`px-2 py-1 ${value === code ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

function join(base: string, spoken: string): string {
  if (!spoken) return base;
  if (!base) return spoken;
  return /\s$/.test(base) ? base + spoken : `${base} ${spoken}`;
}

export default function DictationButton({ value, onChange, prompt }: {
  value: string; onChange: (next: string) => void; prompt?: string;
}) {
  const dictation = useDictation({ prompt });
  const base = useRef("");
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { onChangeRef.current = onChange; });

  // Committed + in-progress speech follow the text that was there when recording began.
  useEffect(() => {
    if (!dictation.recording && !dictation.busy) return;
    const spoken = [dictation.text, dictation.partial].filter(Boolean).join(" ");
    if (spoken) onChangeRef.current(join(base.current, spoken));
  }, [dictation.text, dictation.partial, dictation.recording, dictation.busy]);

  const toggle = async () => {
    if (dictation.recording) {
      const finalText = await dictation.stop();
      onChangeRef.current(join(base.current, finalText));
    } else {
      base.current = value;
      await dictation.start();
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={dictation.busy && !dictation.recording}
        title={dictation.recording ? "Stop dictation" : "Dictate (offline speech-to-text)"}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${
          dictation.recording
            ? "border-red-500 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
            : "border-[var(--app-border,#e5e7eb)] text-[var(--app-text,inherit)] hover:bg-[var(--app-accent-soft,#fdf2f8)]"
        }`}
      >
        <span className="relative inline-flex">
          <MicIcon />
          {dictation.recording ? (
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500"
              style={{ transform: `scale(${1 + dictation.level})` }} />
          ) : null}
        </span>
        {dictation.recording ? "Stop" : dictation.busy ? "Finishing…" : "Speak"}
      </button>
      {!dictation.recording ? (
        <LanguageToggle value={dictation.language} onChange={dictation.setLanguage} disabled={dictation.busy} />
      ) : (
        <span className="text-xs text-[var(--app-muted)]">Listening… text appears as you speak</span>
      )}
      {dictation.error ? <span className="text-xs text-red-600 dark:text-red-400">{dictation.error}</span> : null}
    </div>
  );
}
