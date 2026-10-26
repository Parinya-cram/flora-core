/**
 * A board that follows a Leaf: its live case and timers, and the next booked case between cases.
 * The context is polled every 15 s; timers tick locally every second. When the patient moves out the
 * Leaf has no active case, so the widgets fall back to "no patient" and the next case in the schedule.
 */
import type { LeafCase, NextCase } from "../../api/aiStudioApi";
import { tr, type Lang } from "../../reportstudio/model";
import { useBoardLeaf } from "./dataSource";
import { clockText, span, useNow } from "./leafHooks";

const caseStart = (item: LeafCase) => item.milestones.patient_in ?? item.start_time;
const patientLine = (item: { patient_name?: string | null; hn?: string | null }, showPatient: boolean, fallback: string) =>
  showPatient && (item.patient_name || item.hn) ? [item.patient_name, item.hn ? `HN ${item.hn}` : null].filter(Boolean).join(" · ") : fallback;

/** One-line summary for the Clock widget. */
export function CaseStrip({ lang }: { lang: Lang }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const { leafId, context } = useBoardLeaf();
  const now = useNow();
  if (!leafId || !context) return null;
  const current = context.cases[0];
  if (current) {
    const m = current.milestones;
    const parts = [
      caseStart(current) ? `${t("เข้าห้อง", "In")} ${span(now - (caseStart(current) as number))}` : null,
      m.anesthesia_start ? `${t("ดมยา", "Anaes")} ${span((m.anesthesia_end ?? now) - m.anesthesia_start)}` : null,
      m.incision ? `${t("ลงมีด", "Incision")} ${span((m.surgery_end ?? now) - m.incision)}` : null,
    ].filter(Boolean);
    return <div className="mt-2 rounded-lg bg-[var(--app-control-bg)] px-3 py-1.5 text-sm tabular-nums text-[var(--app-text)]">{context.leaf.name} · {parts.join(" · ") || t("มีผู้ป่วย", "Patient in")}</div>;
  }
  const next = context.next[0];
  return <div className="mt-2 rounded-lg bg-[var(--app-control-bg)] px-3 py-1.5 text-sm text-[var(--app-muted)]">{context.leaf.name} · {next
    ? `${t("เคสถัดไป", "Next")} ${clockText(next.scheduled_at, lang)} (${next.scheduled_at > now ? `${t("อีก", "in")} ${span(next.scheduled_at - now)}` : `${t("เลยเวลา", "late")} ${span(now - next.scheduled_at)}`})`
    : t("ไม่มีผู้ป่วย", "No patient")}</div>;
}

function Milestone({ label, at, until, now, lang, done }: { label: string; at: number | null; until?: number | null; now: number; lang: Lang; done?: string }) {
  if (!at) return <div className="flex items-baseline justify-between gap-2 text-sm text-[var(--app-muted)]"><span>{label}</span><span>—</span></div>;
  return <div className="flex items-baseline justify-between gap-2 text-sm">
    <span className="text-[var(--app-muted)]">{label} <span className="tabular-nums text-[var(--app-text)]">{clockText(at, lang)}</span></span>
    <span className="font-semibold tabular-nums text-[var(--app-text)]">{span((until ?? now) - at)}{until && done ? <span className="ml-1 text-[10px] font-normal text-[var(--app-muted)]">{done}</span> : null}</span>
  </div>;
}

function CurrentCase({ item, lang, showPatient, now }: { item: LeafCase; lang: Lang; showPatient: boolean; now: number }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const m = item.milestones;
  const start = caseStart(item);
  const planned = item.duration_min && start ? start + item.duration_min * 60_000 : null;
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    <div>
      <div className="truncate text-base font-semibold text-[var(--app-text)]">{patientLine(item, showPatient, item.bed_label || item.case_code || t("ผู้ป่วย", "Patient"))}</div>
      {item.operation ? <div className="truncate text-xs text-[var(--app-muted)]">{item.operation}</div> : null}
      {item.surgeon || item.anaesthetist ? <div className="truncate text-[11px] text-[var(--app-muted)]">{[item.surgeon && `${t("ศัลยแพทย์", "Surgeon")} ${item.surgeon}`, item.anaesthetist && `${t("วิสัญญี", "Anaes")} ${item.anaesthetist}`].filter(Boolean).join(" · ")}</div> : null}
    </div>
    <div className="text-center">
      <div className="text-4xl font-bold tabular-nums text-[var(--app-text)]">{start ? span(now - start) : "—"}</div>
      <div className="text-[11px] text-[var(--app-muted)]">{m.patient_in ? t("ตั้งแต่ผู้ป่วยเข้าห้อง", "since the patient came in") : t("ตั้งแต่เริ่มเคส", "since the case started")}{start ? ` ${clockText(start, lang)}` : ""}</div>
      {planned ? <div className={`mt-0.5 text-[11px] font-semibold ${now > planned ? "text-amber-600" : "text-[var(--app-muted)]"}`}>
        {now > planned ? `${t("เกินเวลาที่วางแผน", "Over the planned time by")} ${span(now - planned)}` : `${t("เหลือตามแผน", "Planned time left")} ${span(planned - now)}`}</div> : null}
    </div>
    <div className="space-y-1">
      <Milestone label={t("เริ่มดมยา", "Anaesthesia start")} at={m.anesthesia_start} until={m.anesthesia_end} now={now} lang={lang} done={t("สิ้นสุดแล้ว", "ended")} />
      <Milestone label={t("ลงมีด", "Incision")} at={m.incision} until={m.surgery_end} now={now} lang={lang} done={t("ผ่าตัดเสร็จ", "surgery ended")} />
    </div>
  </div>;
}

function NextCases({ rows, lang, showPatient, now }: { rows: NextCase[]; lang: Lang; showPatient: boolean; now: number }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const [next, ...later] = rows;
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    <div className="text-center">
      <div className="text-sm font-semibold text-[var(--app-muted)]">{t("ไม่มีผู้ป่วยในห้อง", "No patient in the room")}</div>
    </div>
    {next ? <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2.5">
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{t("เคสถัดไป", "Next case")}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums text-[var(--app-text)]">{clockText(next.scheduled_at, lang)}</span>
        <span className={`text-xs font-semibold ${next.scheduled_at < now ? "text-amber-600" : "text-[var(--app-muted)]"}`}>
          {next.scheduled_at > now ? `${t("อีก", "in")} ${span(next.scheduled_at - now)}` : `${t("เลยเวลา", "late by")} ${span(now - next.scheduled_at)}`}</span>
      </div>
      <div className="truncate text-sm text-[var(--app-text)]">{patientLine(next, showPatient, next.operation || t("ผู้ป่วยนัดหมาย", "Booked patient"))}</div>
      {showPatient && next.operation ? <div className="truncate text-xs text-[var(--app-muted)]">{next.operation}</div> : null}
      {next.surgeon ? <div className="truncate text-[11px] text-[var(--app-muted)]">{t("ศัลยแพทย์", "Surgeon")} {next.surgeon}</div> : null}
    </div> : <div className="text-center text-xs text-[var(--app-muted)]">{t("ไม่มีเคสนัดต่อในตาราง", "Nothing else booked in the schedule")}</div>}
    {later.length ? <ul className="space-y-0.5 text-xs text-[var(--app-muted)]">{later.map(row => <li key={row.id} className="flex gap-2">
      <span className="tabular-nums text-[var(--app-text)]">{clockText(row.scheduled_at, lang)}</span>
      <span className="truncate">{patientLine(row, showPatient, row.operation || t("ผู้ป่วยนัดหมาย", "Booked patient"))}</span></li>)}</ul> : null}
  </div>;
}

/** Widget: the followed Leaf's case with live timers, or the next booked case. */
export function CaseTimer({ lang, config }: { lang: Lang; config: Record<string, unknown> }) {
  const t = (th: string, en: string) => tr(lang, th, en);
  const { leafId, context, error } = useBoardLeaf();
  const now = useNow();
  const showPatient = Boolean(config.showPatient);
  if (!leafId) return <div className="grid h-full place-items-center p-3 text-center text-xs text-[var(--app-muted)]">{t("เลือก Leaf ของบอร์ดที่แถบด้านบน", "Choose the board's Leaf in the toolbar")}</div>;
  if (!context) return <div className="grid h-full place-items-center p-3 text-center text-xs text-[var(--app-muted)]">{error || t("กำลังโหลด…", "Loading…")}</div>;
  return <div className="flex h-full flex-col gap-2 overflow-hidden p-3">
    <div className="flex items-center gap-2 text-xs text-[var(--app-muted)]">
      <span className={`h-2 w-2 rounded-full ${context.cases.length ? "animate-pulse bg-emerald-500" : "bg-slate-400"}`} />
      <span className="truncate font-semibold text-[var(--app-text)]">{context.leaf.name}</span>
      <span className="truncate">{[context.leaf.room_name, context.leaf.unit_name].filter(Boolean).join(" · ")}</span>
    </div>
    {context.cases.length
      ? context.cases.slice(0, 1).map(item => <CurrentCase key={item.global_case_id} item={item} lang={lang} showPatient={showPatient} now={now} />)
      : <NextCases rows={context.next} lang={lang} showPatient={showPatient} now={now} />}
    {context.cases.length > 1 ? <div className="text-[11px] text-[var(--app-muted)]">+{context.cases.length - 1} {t("เคสอื่นบน Leaf นี้", "more case(s) on this Leaf")}</div> : null}
  </div>;
}
