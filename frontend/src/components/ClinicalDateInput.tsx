import { useMemo, useState } from "react";

type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

function isoParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

function displayDate(value: string, format: DateFormat) {
  const parts = isoParts(value);
  if (!parts) return "";
  const dd = String(parts.day).padStart(2, "0");
  const mm = String(parts.month).padStart(2, "0");
  const yyyy = String(parts.year);
  return format.replace("DD", dd).replace("MM", mm).replace("YYYY", yyyy);
}

function parseDate(value: string, format: DateFormat) {
  const numbers = value.trim().split(/[^0-9]+/).filter(Boolean).map(Number);
  if (numbers.length !== 3) return "";
  const [first, second, third] = numbers;
  const year = format === "YYYY-MM-DD" ? first : third;
  const month = format === "MM/DD/YYYY" ? first : second;
  const day = format === "YYYY-MM-DD" ? third : format === "MM/DD/YYYY" ? second : first;
  const candidate = new Date(year, month - 1, day, 12);
  if (year < 1900 || candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export default function ClinicalDateInput({ value, onChange, format, maxToday = false }: { value: string; onChange: (value: string) => void; format: DateFormat; maxToday?: boolean }) {
  const selected = isoParts(value);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => selected ? new Date(selected.year, selected.month - 1, 1) : new Date());
  const [todayTimestamp] = useState(() => Date.now());
  const currentYear = new Date().getFullYear();
  const years = useMemo(() => Array.from({ length: (maxToday ? currentYear : currentYear + 10) - 1799 }, (_, index) => (maxToday ? currentYear : currentYear + 10) - index), [currentYear, maxToday]);
  const monthNames = useMemo(() => Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat("en", { month: "short" }).format(new Date(2020, index, 1))), []);
  const days = useMemo(() => {
    const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array(firstWeekday).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)];
  }, [month]);
  const select = (day: number) => {
    const next = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (maxToday && new Date(`${next}T12:00:00`).getTime() > todayTimestamp) return;
    onChange(next); setFocused(false); setOpen(false);
  };
  return <div className="relative mt-2">
    <div className="flex h-11 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] focus-within:border-[var(--app-accent)]"><input data-no-picker value={focused ? text : displayDate(value, format)} inputMode="numeric" placeholder={format} onFocus={() => { setText(displayDate(value, format)); setFocused(true); }} onChange={event => setText(event.target.value)} onBlur={() => { const parsed = parseDate(text, format); if (parsed) onChange(parsed); setFocused(false); }} className="min-w-0 flex-1 bg-transparent px-3 text-sm text-[var(--app-text)] outline-none" /><button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { if (!open) { const next = isoParts(value); if (next) setMonth(new Date(next.year, next.month - 1, 1)); } setOpen(current => !current); }} className="grid w-12 shrink-0 place-items-center border-l border-[var(--app-border)] text-[var(--app-accent)] transition-colors hover:bg-[var(--app-control-bg-hover)]" aria-label="Open calendar"><svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01M16 17.5h.01" strokeWidth="2.4"/></svg></button></div>
    {open ? <div className="absolute left-0 top-12 z-50 w-[310px] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 shadow-2xl">
      <div className="mb-3 grid grid-cols-[32px_1fr_1fr_32px] gap-2">
        <button type="button" aria-label="Previous month" className="h-9 rounded-lg border border-[var(--app-border)]" onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))}>‹</button>
        <select aria-label="Month" value={month.getMonth()} onChange={event => setMonth(current => new Date(current.getFullYear(), Number(event.target.value), 1))} className="min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 text-sm font-semibold text-[var(--app-text)]">{monthNames.map((name, index) => <option key={name} value={index}>{name}</option>)}</select>
        <select aria-label="Year" value={month.getFullYear()} onChange={event => setMonth(current => new Date(Number(event.target.value), current.getMonth(), 1))} className="min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 text-sm font-semibold text-[var(--app-text)]">{years.map(year => <option key={year} value={year}>{year}</option>)}</select>
        <button type="button" aria-label="Next month" className="h-9 rounded-lg border border-[var(--app-border)]" onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-[var(--app-muted)]">{["Su","Mo","Tu","We","Th","Fr","Sa"].map(day => <span key={day}>{day}</span>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">{days.map((day, index) => {
        if (day == null) return <span key={`blank-${index}`} />;
        const candidate = new Date(month.getFullYear(), month.getMonth(), day, 12);
        const disabled = maxToday && candidate.getTime() > todayTimestamp;
        return <button key={day} type="button" disabled={disabled} onClick={() => select(day)} className={`h-8 rounded-lg text-xs disabled:cursor-not-allowed disabled:opacity-25 ${selected?.year === month.getFullYear() && selected.month === month.getMonth() + 1 && selected.day === day ? "bg-[var(--app-accent)] font-bold text-[var(--app-accent-contrast)]" : "text-[var(--app-text)] hover:bg-[var(--app-hover-bg)]"}`}>{day}</button>;
      })}</div>
    </div> : null}
  </div>;
}
