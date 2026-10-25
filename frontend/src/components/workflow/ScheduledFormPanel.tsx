import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createFormEntry,
  getFormEntries,
  getFormEntry,
  skipFormEntry,
  type CaseWorkflowForm,
  type FormEntries,
  type FormEntry,
  type FormScheduleSummary,
  type FormSlot,
  type FormSlotStatus,
} from "../../api/workflowApi";
import { useLanguage } from "../../context/LanguageContext";
import WorkflowFormPanel from "./WorkflowFormPanel";
import { currentDay, groupSlotsByDay, scheduleText, slotDate, SLOT_TONE } from "./formSchedule";

/**
 * A scheduled workflow form on a Leaf case (ICU rounds, docs/ICU-ROUNDS.md): the stay's slots by day, newest first,
 * each opening its own entry in the usual form panel; plus unscheduled entries and skipping a slot with a reason.
 */

const REFRESH_MS = 60_000;
const tiny = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-bold text-[var(--app-text)] disabled:opacity-40";
const input = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";

type Props = {
  caseId: number;
  formId: string;
  form: CaseWorkflowForm;
  hint?: string;
  readOnly?: boolean;
  hidden?: boolean;
  /** The latest due/overdue counts (for the form tab's badge). */
  onSummary?: (summary: FormScheduleSummary) => void;
};

type Open = { entry: FormEntry; label: string };

const STATUS_LABEL: Record<FormSlotStatus, { th: string; en: string }> = {
  done: { th: "เสร็จแล้ว", en: "Done" },
  draft: { th: "ร่าง", en: "Draft" },
  due: { th: "ถึงเวลา", en: "Due" },
  overdue: { th: "เลยกำหนด", en: "Overdue" },
  skipped: { th: "ข้าม", en: "Skipped" },
  upcoming: { th: "ยังไม่ถึง", en: "Upcoming" },
};

const entryStatus = (entry: FormEntry): FormSlotStatus => (entry.status === "completed" ? "done" : entry.status === "skipped" ? "skipped" : "draft");

function when(value: string | number | null | undefined): string {
  const date = slotDate(value ?? null);
  return date ? date.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

export default function ScheduledFormPanel({ caseId, formId, form, hint = "", readOnly = false, hidden = false, onSummary }: Props) {
  const { language } = useLanguage();
  const thai = language.toLowerCase().startsWith("th");
  const tr = (th: string, en: string) => (thai ? th : en);
  const [data, setData] = useState<FormEntries | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [expanded, setExpanded] = useState<Set<number> | null>(null);
  const [skipping, setSkipping] = useState<{ key: string; reason: string } | null>(null);
  /** Entries fetched for who/when on the slot rows (slots carry only entry_id). */
  const [details, setDetails] = useState<Record<string, FormEntry>>({});
  const onSummaryRef = useRef(onSummary);
  useEffect(() => { onSummaryRef.current = onSummary; }, [onSummary]);

  const reload = useCallback(async () => {
    try {
      const next = await getFormEntries(caseId, formId);
      setData(next);
      setError("");
      onSummaryRef.current?.(next.summary);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [caseId, formId]);

  // Load, then refresh every minute while the tab is shown (slots turn due/overdue as time passes).
  useEffect(() => {
    let live = true;
    const tick = () => { if (live) void reload(); };
    const first = window.setTimeout(tick, 0);
    const timer = hidden ? null : window.setInterval(tick, REFRESH_MS);
    return () => { live = false; window.clearTimeout(first); if (timer != null) window.clearInterval(timer); };
  }, [reload, hidden]);

  const days = useMemo(() => groupSlotsByDay(data?.slots ?? []), [data]);
  const today = useMemo(() => currentDay(data?.slots ?? []), [data]);
  const isExpanded = (day: number) => (expanded ? expanded.has(day) : day === today);
  const toggleDay = (day: number) => setExpanded(current => {
    const next = new Set(current ?? (today != null ? [today] : []));
    if (next.has(day)) next.delete(day); else next.add(day);
    return next;
  });

  // Who/when for the entries of the expanded days.
  const wanted = useMemo(() => {
    const shown = expanded ?? new Set(today != null ? [today] : []);
    return days.filter(group => shown.has(group.day)).flatMap(group => group.slots)
      .map(slot => slot.entry_id).filter((id): id is string => Boolean(id));
  }, [days, expanded, today]);
  /** Entry ids already asked for (so a failed read is not retried in a loop). */
  const requested = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = wanted.filter(id => !details[id] && !requested.current.has(id)).slice(0, 24);
    if (!missing.length) return;
    for (const id of missing) requested.current.add(id);
    void Promise.all(missing.map(id => getFormEntry(caseId, formId, id).then(result => result.entry).catch(() => null)))
      .then(found => {
        setDetails(current => {
          const next = { ...current };
          for (const entry of found) if (entry) next[entry.id] = entry;
          return next;
        });
      });
  }, [wanted, details, caseId, formId]);
  // A slot changed status since its entry was read (someone else completed it): read it again.
  useEffect(() => {
    const stale = (data?.slots ?? []).filter(slot => slot.entry_id && details[slot.entry_id] && entryStatus(details[slot.entry_id]) !== slot.status)
      .map(slot => slot.entry_id!);
    if (!stale.length) return;
    for (const id of stale) requested.current.delete(id);
    const timer = window.setTimeout(() => setDetails(current => {
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    }), 0);
    return () => window.clearTimeout(timer);
  }, [data, details]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  const openSlot = (slot: FormSlot) => run(async () => {
    const entry = slot.entry_id
      ? (await getFormEntry(caseId, formId, slot.entry_id)).entry
      : readOnly ? null : await createFormEntry(caseId, formId, slot.slot_ts);
    if (!entry) return;
    setOpen({ entry, label: slot.label });
    if (!slot.entry_id) await reload();
  });
  const openEntry = (entry: FormEntry, label: string) => run(async () => {
    const fresh = (await getFormEntry(caseId, formId, entry.id)).entry;
    setOpen({ entry: fresh ?? entry, label });
  });
  const addUnscheduled = () => run(async () => {
    const entry = await createFormEntry(caseId, formId, null);
    setOpen({ entry, label: tr("บันทึกนอกรอบ", "Unscheduled entry") });
    await reload();
  });
  const skip = (slot: FormSlot | null, entry: FormEntry | null, reason: string) => run(async () => {
    const target = entry ?? (slot ? (slot.entry_id ? (await getFormEntry(caseId, formId, slot.entry_id)).entry : await createFormEntry(caseId, formId, slot.slot_ts)) : null);
    if (!target) return;
    const skipped = await skipFormEntry(caseId, formId, target.id, reason);
    setDetails(current => ({ ...current, [skipped.id]: skipped }));
    setSkipping(null);
    if (open?.entry.id === skipped.id) setOpen(null);
    await reload();
  });

  // An entry's status changed in the form panel: refresh the list (and the tab badge).
  const lastStatus = useRef<Record<string, string>>({});
  const onEntrySaved = useCallback((entry: FormEntry) => {
    setDetails(current => ({ ...current, [entry.id]: entry }));
    if (lastStatus.current[entry.id] !== entry.status) {
      lastStatus.current[entry.id] = entry.status;
      void reload();
    }
  }, [reload]);

  const skipBox = (key: string, onConfirm: (reason: string) => void) => skipping?.key === key
    ? <span className="flex basis-full items-center gap-1 pt-1">
      <input className={`${input} flex-1`} autoFocus value={skipping.reason} placeholder={tr("เหตุผลที่ข้าม (เช่น ผู้ป่วยไปทำหัตถการ)", "Reason (e.g. patient off the unit)")}
        onChange={event => setSkipping({ key, reason: event.target.value })}
        onKeyDown={event => { if (event.key === "Enter" && skipping.reason.trim()) onConfirm(skipping.reason.trim()); if (event.key === "Escape") setSkipping(null); }} />
      <button type="button" className={tiny} disabled={busy || !skipping.reason.trim()} onClick={() => onConfirm(skipping.reason.trim())}>{tr("ข้าม", "Skip")}</button>
      <button type="button" className={tiny} onClick={() => setSkipping(null)}>{tr("ยกเลิก", "Cancel")}</button>
    </span> : null;

  const who = (entry: FormEntry | undefined) => {
    if (!entry) return "";
    if (entry.status === "completed") return [entry.completedBy, when(entry.completedAt)].filter(Boolean).join(" · ");
    if (entry.status === "skipped") return entry.skipReason || "";
    return [entry.updatedBy, when(entry.updatedAt)].filter(Boolean).join(" · ");
  };

  const chip = (status: FormSlotStatus) => <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${SLOT_TONE[status]}`}>
    {thai ? STATUS_LABEL[status].th : STATUS_LABEL[status].en}</span>;

  const summary = data?.summary;

  return <div className={`grid gap-3 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)] ${hidden ? "hidden" : ""}`}>
    <section className="h-fit space-y-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{form.definition.title || formId}</h2>
          <div className="text-xs text-[var(--app-muted)]">{scheduleText(data?.schedule ?? form.schedule)}{data?.timezone ? ` · ${data.timezone}` : ""}</div>
          {summary ? <div className="mt-1 flex flex-wrap gap-1 text-[10px] font-bold">
            {summary.overdue ? <span className={`rounded-full border px-2 py-0.5 ${SLOT_TONE.overdue}`}>{summary.overdue} {tr("เลยกำหนด", "overdue")}</span> : null}
            {summary.due ? <span className={`rounded-full border px-2 py-0.5 ${SLOT_TONE.due}`}>{summary.due} {tr("ถึงเวลา", "due")}</span> : null}
            <span className={`rounded-full border px-2 py-0.5 ${SLOT_TONE.done}`}>{summary.done} {tr("เสร็จ", "done")}</span>
          </div> : null}
        </div>
        <button type="button" className={tiny} disabled={busy} onClick={() => void reload()} aria-label={tr("รีเฟรช", "Refresh")}>↻</button>
      </div>
      {hint ? <p className="rounded-lg bg-[var(--app-accent)]/10 px-2 py-1 text-xs">ℹ {hint}</p> : null}
      {error ? <div role="alert" className="whitespace-pre-line text-xs text-rose-500">{error}</div> : null}
      {!data && !error ? <div className="text-xs text-[var(--app-muted)]">{tr("กำลังโหลด…", "Loading…")}</div> : null}
      {data && !data.slots.length ? <div className="text-xs text-[var(--app-muted)]">{tr("ยังไม่มีรอบที่ต้องบันทึก", "No slots yet for this stay.")}</div> : null}

      <div className="space-y-1">
        {days.map(group => {
          const pending = group.slots.filter(slot => slot.status === "due" || slot.status === "overdue").length;
          return <div key={group.day} className="rounded-xl border border-[var(--app-border)]">
            <button type="button" onClick={() => toggleDay(group.day)} aria-expanded={isExpanded(group.day)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-bold">
              <span>{isExpanded(group.day) ? "▾" : "▸"} {tr("วันที่", "Day")} {group.day}
                <span className="ml-2 text-xs font-normal text-[var(--app-muted)]">{slotDate(group.slots[0]?.slot_ts)?.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })}</span></span>
              <span className="flex gap-1">
                {pending ? chip(group.slots.some(slot => slot.status === "overdue") ? "overdue" : "due") : null}
                <span className="text-xs font-normal text-[var(--app-muted)]">{group.slots.filter(slot => slot.status === "done").length}/{group.slots.length}</span>
              </span>
            </button>
            {isExpanded(group.day) ? <ul className="border-t border-[var(--app-border)]">
              {group.slots.map(slot => {
                const key = `slot-${slot.slot_ts}`;
                const selected = open != null && (open.entry.id === slot.entry_id || open.entry.slot_ts === slot.slot_ts);
                const detail = slot.entry_id ? details[slot.entry_id] : undefined;
                const canOpen = slot.status !== "upcoming" || Boolean(slot.entry_id);
                return <li key={key} className={`flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs ${selected ? "bg-[var(--app-accent)]/10" : ""}`}>
                  <button type="button" disabled={busy || !canOpen || (readOnly && !slot.entry_id)} onClick={() => void openSlot(slot)}
                    className="min-w-0 flex-1 text-left font-semibold hover:underline disabled:no-underline disabled:opacity-70">
                    {slot.label}
                    {who(detail) ? <span className="block truncate font-normal text-[var(--app-muted)]">{who(detail)}</span> : null}
                  </button>
                  {chip(slot.status)}
                  {!readOnly && (slot.status === "due" || slot.status === "overdue" || slot.status === "draft")
                    ? <button type="button" className={tiny} disabled={busy} onClick={() => setSkipping({ key, reason: "" })}>{tr("ข้าม", "Skip")}</button> : null}
                  {skipBox(key, reason => void skip(slot, null, reason))}
                </li>;
              })}
            </ul> : null}
          </div>;
        })}
      </div>

      <div className="space-y-1 border-t border-[var(--app-border)] pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold text-[var(--app-muted)]">{tr("บันทึกนอกรอบ", "Unscheduled entries")} {data?.unscheduled.length ? data.unscheduled.length : ""}</span>
          {!readOnly ? <button type="button" className={tiny} disabled={busy || !data} onClick={() => void addUnscheduled()}>+ {tr("เพิ่มบันทึกนอกรอบ", "Add unscheduled entry")}</button> : null}
        </div>
        {[...(data?.unscheduled ?? [])].reverse().map(entry => {
          const label = `${tr("นอกรอบ", "Unscheduled")} · ${when(entry.completedAt ?? entry.updatedAt)}`;
          const key = `entry-${entry.id}`;
          return <div key={entry.id} className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-xs ${open?.entry.id === entry.id ? "bg-[var(--app-accent)]/10" : ""}`}>
            <button type="button" disabled={busy} onClick={() => void openEntry(entry, label)} className="min-w-0 flex-1 text-left font-semibold hover:underline">
              {label}{who(entry) ? <span className="block truncate font-normal text-[var(--app-muted)]">{who(entry)}</span> : null}
            </button>
            {chip(entryStatus(entry))}
            {!readOnly && entry.status === "draft" ? <button type="button" className={tiny} disabled={busy} onClick={() => setSkipping({ key, reason: "" })}>{tr("ข้าม", "Skip")}</button> : null}
            {skipBox(key, reason => void skip(null, entry, reason))}
          </div>;
        })}
      </div>
    </section>

    {open ? <div className="min-w-0 space-y-2">
      <button type="button" className={`${tiny} lg:hidden`} onClick={() => setOpen(null)}>← {tr("กลับไปที่รายการ", "All entries")}</button>
      {open.entry.status === "skipped" ? <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 text-xs text-[var(--app-muted)]">
        {tr("รอบนี้ถูกข้าม", "This slot was skipped")}{open.entry.skipReason ? `: ${open.entry.skipReason}` : ""}</div> : null}
      <WorkflowFormPanel key={open.entry.id} caseId={caseId} formId={formId} form={form} hint="" entry={open.entry} subtitle={open.label}
        readOnly={readOnly || open.entry.status === "skipped"} onEntrySaved={onEntrySaved} />
    </div> : <div className="hidden rounded-2xl border border-dashed border-[var(--app-border)] p-6 text-sm text-[var(--app-muted)] lg:block">
      {tr("เลือกรอบทางซ้ายเพื่อบันทึก", "Pick a slot on the left to fill it in.")}</div>}
  </div>;
}
