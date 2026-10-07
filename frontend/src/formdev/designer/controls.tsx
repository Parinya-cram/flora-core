/** Small labelled inputs used by the designer's inspector. Empty input means "not set" (undefined). */
import type { ReactNode } from "react";
import { input, label as labelClass } from "./styles";

export function TextField({ label, value, onChange, placeholder, hint, multiline = false, mono = false }: {
  label: string; value: string | undefined; onChange: (next: string | undefined) => void; placeholder?: string; hint?: string; multiline?: boolean; mono?: boolean;
}) {
  const className = `${input} ${mono ? "font-mono text-xs" : ""}`;
  return <label className="block space-y-1">
    <span className={labelClass}>{label}</span>
    {multiline
      ? <textarea className={`${className} min-h-[70px]`} value={value ?? ""} placeholder={placeholder} onChange={event => onChange(event.target.value === "" ? undefined : event.target.value)} />
      : <input className={className} value={value ?? ""} placeholder={placeholder} onChange={event => onChange(event.target.value === "" ? undefined : event.target.value)} />}
    {hint ? <span className="block text-[11px] text-[var(--app-muted)]">{hint}</span> : null}
  </label>;
}

export function NumberField({ label, value, onChange, min, max, step }: {
  label: string; value: number | undefined; onChange: (next: number | undefined) => void; min?: number; max?: number; step?: number;
}) {
  return <label className="block space-y-1">
    <span className={labelClass}>{label}</span>
    <input className={input} type="number" value={value ?? ""} min={min} max={max} step={step}
      onChange={event => onChange(event.target.value === "" || !Number.isFinite(Number(event.target.value)) ? undefined : Number(event.target.value))} />
  </label>;
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (next: boolean) => void; hint?: string }) {
  return <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--app-text)]">
    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--app-accent)]" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span>{label}{hint ? <span className="block text-[11px] text-[var(--app-muted)]">{hint}</span> : null}</span>
  </label>;
}

export function SelectField({ label, value, options, onChange }: {
  label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (next: string) => void;
}) {
  return <label className="block space-y-1">
    <span className={labelClass}>{label}</span>
    <select className={input} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

/** A collapsible group of settings. */
export function Group({ title, children, open = false, badge }: { title: string; children: ReactNode; open?: boolean; badge?: string }) {
  return <details className="group rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]" open={open}>
    <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-bold text-[var(--app-text)]">
      <span>{title}{badge ? <span className="ml-2 rounded-full bg-[var(--app-accent)] px-2 py-0.5 text-[10px] text-[var(--app-accent-contrast)]">{badge}</span> : null}</span>
      <span className="text-xs text-[var(--app-muted)] transition group-open:rotate-180">▾</span>
    </summary>
    <div className="space-y-3 border-t border-[var(--app-border)] px-3 py-3">{children}</div>
  </details>;
}
