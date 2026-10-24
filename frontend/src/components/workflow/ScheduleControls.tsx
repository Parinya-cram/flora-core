import { useState } from "react";
import type { WorkflowFormSchedule, WorkflowScheduleKind, WorkflowShift } from "../../api/workflowApi";
import { DEFAULT_DAY_START, DEFAULT_SHIFTS } from "./formSchedule";

/** Workflow Studio: a form's schedule (ICU rounds) and the workflow's day start and shifts (docs/ICU-ROUNDS.md). */

const input = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const tiny = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-bold text-[var(--app-text)] disabled:opacity-40";

const intOrNull = (text: string): number | null => {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value) : null;
};

export function FormScheduleControl({ value, readOnly, onChange }: {
  value: WorkflowFormSchedule | null | undefined;
  readOnly: boolean;
  onChange: (next: WorkflowFormSchedule | null) => void;
}) {
  const [advanced, setAdvanced] = useState(value?.grace_min != null);
  const kind = value?.kind ?? "";
  const setKind = (next: WorkflowScheduleKind | "") => {
    if (!next) return onChange(null);
    const base: WorkflowFormSchedule = { kind: next, days: value?.days ?? null, ...(value?.grace_min != null ? { grace_min: value.grace_min } : {}) };
    if (next === "daily") base.at = value?.at || DEFAULT_DAY_START;
    if (next === "every") base.every_hours = value?.every_hours || 8;
    onChange(base);
  };
  const patch = (change: Partial<WorkflowFormSchedule>) => value && onChange({ ...value, ...change });

  return <div className="flex basis-full flex-wrap items-center gap-2 text-xs text-[var(--app-muted)]">
    <label className="flex items-center gap-1">Schedule <select className={input} disabled={readOnly} value={kind} onChange={event => setKind(event.target.value as WorkflowScheduleKind | "")}>
      <option value="">None (one record per case)</option>
      <option value="daily">Daily at…</option>
      <option value="every">Every N hours</option>
      <option value="per_shift">Every shift</option>
    </select></label>
    {value?.kind === "daily" ? <input type="time" className={input} disabled={readOnly} value={value.at || ""} aria-label="Daily at"
      onChange={event => patch({ at: event.target.value })} /> : null}
    {value?.kind === "every" ? <label className="flex items-center gap-1">every <input type="number" min={1} max={24} className={`${input} w-16`} disabled={readOnly}
      value={value.every_hours ?? ""} onChange={event => patch({ every_hours: intOrNull(event.target.value) ?? undefined })} /> h</label> : null}
    {value ? <>
      <label className="flex items-center gap-1">for <input type="number" min={1} className={`${input} w-16`} disabled={readOnly} placeholder="∞"
        value={value.days ?? ""} onChange={event => patch({ days: intOrNull(event.target.value) })} /> days</label>
      <span className="text-[11px]">{value.days ? "" : "(until discharge)"}</span>
      {advanced ? <label className="flex items-center gap-1">grace <input type="number" min={0} className={`${input} w-20`} disabled={readOnly}
        placeholder={value.kind === "per_shift" ? "shift" : "120"} value={value.grace_min ?? ""}
        onChange={event => patch({ grace_min: intOrNull(event.target.value) })} /> min</label>
        : <button type="button" className="underline" onClick={() => setAdvanced(true)}>grace…</button>}
    </> : null}
  </div>;
}

export function WorkflowDaySettings({ dayStart, shifts, readOnly, onChange }: {
  dayStart: string | undefined;
  shifts: WorkflowShift[] | undefined;
  readOnly: boolean;
  onChange: (next: { day_start?: string; shifts?: WorkflowShift[] }) => void;
}) {
  const list = shifts ?? DEFAULT_SHIFTS;
  const setShift = (index: number, change: Partial<WorkflowShift>) =>
    onChange({ shifts: list.map((shift, i) => (i === index ? { ...shift, ...change } : shift)) });

  return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[var(--app-border)] p-2 text-xs text-[var(--app-muted)]">
    <span className="font-bold">Scheduled forms</span>
    <label className="flex items-center gap-1">Day starts at <input type="time" className={input} disabled={readOnly} value={dayStart ?? DEFAULT_DAY_START}
      onChange={event => onChange({ day_start: event.target.value })} /></label>
    <span className="ml-2">Shifts</span>
    {list.map((shift, index) => <span key={index} className="flex items-center gap-1">
      <input className={`${input} w-10 font-mono`} disabled={readOnly} maxLength={4} value={shift.code} aria-label={`Shift ${index + 1} code`}
        onChange={event => setShift(index, { code: event.target.value.trim().toUpperCase() })} />
      <input className={`${input} w-20`} disabled={readOnly} maxLength={40} value={shift.label ?? ""} placeholder="Label" aria-label={`Shift ${index + 1} label`}
        onChange={event => setShift(index, { label: event.target.value })} />
      <input type="time" className={input} disabled={readOnly} value={shift.start} aria-label={`Shift ${index + 1} start`}
        onChange={event => setShift(index, { start: event.target.value })} />
      {!readOnly && list.length > 1 ? <button type="button" className={tiny} aria-label={`Remove shift ${shift.code}`}
        onClick={() => onChange({ shifts: list.filter((_, i) => i !== index) })}>✕</button> : null}
    </span>)}
    {!readOnly ? <button type="button" className={tiny} onClick={() => onChange({ shifts: [...list, { code: "", label: "", start: "" }] })}>+ Shift</button> : null}
    {!readOnly && shifts ? <button type="button" className="underline" onClick={() => onChange({ shifts: undefined })}>defaults</button> : null}
  </div>;
}
