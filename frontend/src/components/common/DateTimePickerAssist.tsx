import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { registerTimePicker } from "./timePicker";

/**
 * Desktop helper for every typed date/time field.
 *
 * Fields keep their own masks and validation; this only offers a calendar (fields whose
 * placeholder is dd/mm/yyyy) or an hour/minute grid (placeholder HH:mm) while the field
 * has focus, and writes the chosen value as if it were typed (native setter + "input"
 * event, so React onChange runs). Native date/time inputs get the browser's own picker on
 * click. Mouse/trackpad devices only; opt a field out with data-no-picker.
 *
 * Fields split into separate hour and minute boxes call openTimePicker() (./timePicker) to get the same
 * hour/minute grid anchored to their own element.
 */

type Kind = "date" | "time";
const DATE_PLACEHOLDER = /^dd\/mm\/yyyy$/i;
const TIME_PLACEHOLDER = /^hh:mm$/i;
const NATIVE_PICKER_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);
const MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);
const HOURS = Array.from({ length: 24 }, (_, index) => index);
const pad = (value: number) => String(value).padStart(2, "0");

type Target = {
  kind: Kind;
  anchor: HTMLElement;
  /** Typed field the choice is written into. */
  input?: HTMLInputElement;
  /** Split hour/minute fields receive the choice here instead. */
  onPick?: (hour: number, minute: number) => void;
  current?: { hour: number; minute: number } | null;
};

function kindOf(element: EventTarget | null): Kind | null {
  if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly || element.dataset.noPicker != null) return null;
  const placeholder = (element.getAttribute("placeholder") || "").trim();
  if (DATE_PLACEHOLDER.test(placeholder)) return "date";
  if (TIME_PLACEHOLDER.test(placeholder)) return "time";
  return null;
}

/** Writes through React's value tracker so the field's onChange runs as for typing. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function parseDate(text: string) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTime(text: string) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim());
  return match ? { hour: Math.min(23, Number(match[1])), minute: Math.min(59, Number(match[2])) } : null;
}

export default function DateTimePickerAssist() {
  const [target, setTarget] = useState<Target | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [month, setMonth] = useState(() => new Date());
  const [hour, setHour] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const desktop = useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches, []);

  useEffect(() => {
    if (!desktop) return;
    const onFocus = (event: FocusEvent) => {
      const kind = kindOf(event.target);
      if (!kind) return;
      const input = event.target as HTMLInputElement;
      if (kind === "date") setMonth(parseDate(input.value) || new Date());
      setHour(kind === "time" ? parseTime(input.value)?.hour ?? null : null);
      setRect(input.getBoundingClientRect());
      setTarget({ input, anchor: input, kind });
    };
    const onFocusOut = (event: FocusEvent) => {
      // Keep the panel while focus moves into it (it never takes focus, but be safe).
      if (panelRef.current && event.relatedTarget instanceof Node && panelRef.current.contains(event.relatedTarget)) return;
      setTarget(current => (current && current.input === event.target ? null : current));
    };
    const onNativeClick = (event: MouseEvent) => {
      const input = event.target;
      if (input instanceof HTMLInputElement && NATIVE_PICKER_TYPES.has(input.type) && !input.disabled && !input.readOnly
          && input.dataset.noPicker == null && typeof input.showPicker === "function") {
        try { input.showPicker(); } catch { /* not allowed for this input; the browser control still works */ }
      }
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setTarget(null); };
    // Split hour/minute fields: close when the user clicks anywhere outside the field and the panel.
    const onPointerDown = (event: PointerEvent) => {
      setTarget(current => {
        if (!current || current.input) return current;
        const node = event.target as Node;
        return current.anchor.contains(node) || panelRef.current?.contains(node) ? current : null;
      });
    };
    registerTimePicker(request => {
      setHour(request.current?.hour ?? null);
      setRect(request.anchor.getBoundingClientRect());
      setTarget({ kind: "time", ...request });
    });
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("click", onNativeClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", onNativeClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      registerTimePicker(null);
    };
  }, [desktop]);

  // Follow the field while modals scroll or the window resizes; close if it leaves the page.
  useEffect(() => {
    if (!target) return;
    const follow = () => {
      if (!target.anchor.isConnected) return setTarget(null);
      setRect(target.anchor.getBoundingClientRect());
    };
    const refresh = () => setTick(value => value + 1);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    target.input?.addEventListener("input", refresh);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      target.input?.removeEventListener("input", refresh);
    };
  }, [target]);

  if (!target || !rect) return null;
  const { input, kind } = target;
  const width = kind === "date" ? 284 : 300;
  const height = kind === "date" ? 316 : 268;
  const below = rect.bottom + 6 + height < window.innerHeight;
  const style = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    top: below ? rect.bottom + 6 : Math.max(8, rect.top - height - 6),
    width,
  };
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  const button = "rounded-md text-xs tabular-nums hover:bg-[var(--app-hover-bg,var(--app-control-bg))]";
  const selectedDate = kind === "date" && input ? parseDate(input.value) : null;
  const selectedTime = kind === "time" ? (input ? parseTime(input.value) : target.current ?? null) : null;

  const chooseDate = (date: Date) => {
    if (!input) return;
    typeInto(input, `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`);
    setTarget(null);
  };
  const chooseTime = (h: number, m: number) => {
    if (target.onPick) target.onPick(h, m);
    else if (input) typeInto(input, `${pad(h)}:${pad(m)}`);
    setTarget(null);
  };

  const panel = kind === "date" ? (() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells = [...Array(first).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)];
    const today = new Date();
    const shift = (delta: number) => setMonth(current => new Date(current.getFullYear(), current.getMonth() + delta, 1));
    return <>
      <div className="mb-2 flex items-center justify-between gap-1">
        <button type="button" className={`${button} h-7 w-7 border border-[var(--app-border)]`} onClick={() => shift(-12)} aria-label="Previous year">«</button>
        <button type="button" className={`${button} h-7 w-7 border border-[var(--app-border)]`} onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <div className="flex-1 text-center text-sm font-bold">{new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(month)}</div>
        <button type="button" className={`${button} h-7 w-7 border border-[var(--app-border)]`} onClick={() => shift(1)} aria-label="Next month">›</button>
        <button type="button" className={`${button} h-7 w-7 border border-[var(--app-border)]`} onClick={() => shift(12)} aria-label="Next year">»</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-[var(--app-muted)]">{["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(day => <span key={day}>{day}</span>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">{cells.map((day, index) => {
        if (day == null) return <span key={`blank-${index}`} />;
        const date = new Date(month.getFullYear(), month.getMonth(), day, 12);
        const same = (other: Date | null) => other && other.getFullYear() === date.getFullYear() && other.getMonth() === date.getMonth() && other.getDate() === day;
        return <button key={day} type="button" onClick={() => chooseDate(date)}
          className={`${button} h-8 ${same(selectedDate) ? "bg-[var(--app-accent)] font-bold text-[var(--app-accent-contrast)]" : same(today) ? "border border-[var(--app-accent)] font-bold" : ""}`}>{day}</button>;
      })}</div>
      <div className="mt-2 flex justify-between border-t border-[var(--app-border)] pt-2">
        <button type="button" className={`${button} px-2 py-1 font-semibold text-[var(--app-accent)]`} onClick={() => chooseDate(new Date())}>Today</button>
        <button type="button" className={`${button} px-2 py-1 text-[var(--app-muted)]`} onClick={() => setTarget(null)}>Close</button>
      </div>
    </>;
  })() : <>
    <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">
      <span>Hour</span><span>{hour == null ? "pick an hour" : `${pad(hour)}:__`}</span>
    </div>
    <div className="grid grid-cols-8 gap-1">{HOURS.map(h => <button key={h} type="button" onClick={() => setHour(h)}
      className={`${button} h-7 ${(hour ?? selectedTime?.hour) === h ? "bg-[var(--app-accent)] font-bold text-[var(--app-accent-contrast)]" : ""}`}>{pad(h)}</button>)}</div>
    <div className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Minute</div>
    <div className="grid grid-cols-6 gap-1">{MINUTES.map(m => <button key={m} type="button" disabled={hour == null && !selectedTime}
      onClick={() => chooseTime(hour ?? selectedTime!.hour, m)}
      className={`${button} h-7 disabled:opacity-30 ${selectedTime && selectedTime.minute === m && (hour == null || hour === selectedTime.hour) ? "border border-[var(--app-accent)] font-bold" : ""}`}>:{pad(m)}</button>)}</div>
    <div className="mt-2 flex justify-between border-t border-[var(--app-border)] pt-2">
      <button type="button" className={`${button} px-2 py-1 font-semibold text-[var(--app-accent)]`} onClick={() => { const now = new Date(); chooseTime(now.getHours(), now.getMinutes()); }}>Now</button>
      <span className="self-center text-[10px] text-[var(--app-muted)]">or type any minute</span>
      <button type="button" className={`${button} px-2 py-1 text-[var(--app-muted)]`} onClick={() => setTarget(null)}>Close</button>
    </div>
  </>;

  return createPortal(
    <div ref={panelRef} onMouseDown={keepFocus} role="dialog" aria-label={kind === "date" ? "Choose a date" : "Choose a time"}
      className="fixed z-[2147483000] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 text-[var(--app-text)] shadow-2xl" style={style}>
      {panel}
    </div>,
    document.body,
  );
}
