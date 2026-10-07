import ClinicalDateInput from "./ClinicalDateInput";
import { openTimePicker } from "./common/timePicker";

type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
type TimeFormat = "24h" | "12h";

export default function ClinicalDateTimeInput({ value, onChange, dateFormat, timeFormat }: { value: string; onChange: (value: string) => void; dateFormat: DateFormat; timeFormat: TimeFormat }) {
  const [date = "", rawTime = "00:00"] = value.split("T");
  const [rawHour = "0", rawMinute = "0"] = rawTime.split(":");
  const hour24 = Number(rawHour) || 0;
  const minute = Number(rawMinute) || 0;
  const period = hour24 >= 12 ? "PM" : "AM";
  const shownHour = timeFormat === "12h" ? hour24 % 12 || 12 : hour24;
  const commit = (nextDate: string, nextHour24: number, nextMinute: number) => onChange(`${nextDate || date || new Date().toISOString().slice(0, 10)}T${String(Math.max(0, Math.min(23, nextHour24))).padStart(2, "0")}:${String(Math.max(0, Math.min(59, nextMinute))).padStart(2, "0")}`);
  const hourChanged = (entered: number) => {
    if (timeFormat === "24h") return commit(date, entered, minute);
    const normalized = Math.max(1, Math.min(12, entered));
    commit(date, (normalized % 12) + (period === "PM" ? 12 : 0), minute);
  };
  return <div className="flex items-end gap-2">
    <div className="min-w-[170px] max-w-[260px] flex-1"><ClinicalDateInput value={date} format={dateFormat} onChange={nextDate => commit(nextDate, hour24, minute)} /></div>
    <div className="mt-2 flex h-11 shrink-0 items-center overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] focus-within:border-[var(--app-accent)]"><input aria-label="Hour" onFocus={event => openTimePicker(event.currentTarget.parentElement!, { hour: hour24, minute }, (h, m) => commit(date, h, m))} type="number" min={timeFormat === "12h" ? 1 : 0} max={timeFormat === "12h" ? 12 : 23} value={shownHour} onChange={event => hourChanged(Number(event.target.value))} className="h-full w-12 bg-transparent px-1 text-center text-sm text-[var(--app-text)] outline-none" /><span className="font-bold text-[var(--app-muted)]">:</span><input aria-label="Minute" onFocus={event => openTimePicker(event.currentTarget.parentElement!, { hour: hour24, minute }, (h, m) => commit(date, h, m))} type="number" min="0" max="59" value={String(minute).padStart(2, "0")} onChange={event => commit(date, hour24, Number(event.target.value))} className="h-full w-12 bg-transparent px-1 text-center text-sm text-[var(--app-text)] outline-none" />{timeFormat === "12h" ? <div className="flex h-full border-l border-[var(--app-border)]">{(["AM", "PM"] as const).map(option => <button key={option} type="button" onClick={() => commit(date, (hour24 % 12) + (option === "PM" ? 12 : 0), minute)} className={`px-2 text-xs font-bold ${period === option ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "text-[var(--app-muted)]"}`}>{option}</button>)}</div> : null}</div>
  </div>;
}
