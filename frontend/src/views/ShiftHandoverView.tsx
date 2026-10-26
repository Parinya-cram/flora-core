import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import {
  acceptShiftHandover,
  getShiftHandovers,
  getShiftHandoverSummary,
  handOverShift,
  ISBAR_FIELDS,
  saveShiftHandover,
  type HandoverIoTotals,
  type HandoverRole,
  type HandoverStatus,
  type HandoverSummary,
  type IsbarField,
  type IsbarText,
  type ShiftHandover,
  type ShiftWindow,
} from "../api/shiftHandoverApi";
import { useLanguage } from "../context/LanguageContext";
import BundleComplianceCard from "../components/icu/BundleComplianceCard";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import { formatConfiguredDateTime, formatConfiguredTime, type DateTimePreferences } from "../utils/dateTime";

/** ICU shift handover: the shift's automatic summary + ISBAR note and plan; Hand over → Accept (docs/ICU-ROUNDS.md). */

type Props = { caseStatus: CaseStatus; sessionUser: AuthUser | null };
type Selection = { kind: "current" } | { kind: "previous" } | { kind: "at"; start: number };

const REFRESH_MS = 60_000;
const AUTOSAVE_MS = 800;

const TEXT = {
  en: {
    title: "Shift handover", noCase: "Open a case to hand over its shift.", current: "Current shift", previous: "Previous shift",
    history: "History", nurse: "Nurse", doctor: "Doctor", day: "Day", print: "Print", loading: "Loading…",
    status: { none: "Not started", draft: "Draft", handed: "Handed over", accepted: "Accepted" },
    vitals: "Vital signs", latest: "Latest", min: "Min", max: "Max", noVitals: "No vital signs in this shift.",
    io: "Intake / output", shiftIo: "This shift", stayIo: "Stay so far", intake: "Intake", output: "Output", net: "Net",
    urine: "Urine", blood: "Blood loss", items: "By item", infusions: "Running infusions", noInfusions: "No infusion running.",
    since: "since", rateSince: "rate since", newInShift: "new", events: "Events & notes", noEvents: "No events in this shift.",
    scores: "Scores", noScores: "No score results.", partial: "partial", forms: "Round forms",
    noForms: "Nothing due, overdue or skipped in this shift.", overdueTotal: "Overdue in the stay",
    formStatus: { due: "Due", overdue: "Overdue", skipped: "Skipped" }, medications: "Medications",
    medActive: "Active orders", medGiven: "Given", noMedications: "No doses due or given in this shift.",
    isbar: "ISBAR", fields: {
      identify: "I — Identify", situation: "S — Situation", background: "B — Background", assessment: "A — Assessment",
      recommendation: "R — Recommendation", plan: "Plan",
    },
    placeholders: {
      identify: "Patient, location, who is handing over to whom", situation: "Current problem and status",
      background: "Diagnosis, history, relevant events", assessment: "Your assessment: what is going on",
      recommendation: "What the next shift must do or watch", plan: "Plan for the next shift",
    },
    saving: "Saving…", saved: "Saved", handOver: "Hand over", accept: "Accept", handedBy: "Handed over by",
    acceptedBy: "Accepted by", at: "at", frozen: "Summary frozen at hand-over", live: "Live summary · refreshed every minute",
    waitAccept: "Waiting for the incoming person to accept.", ownHanded: "You handed this over; you can still edit it until it is accepted.",
    readOnly: "Read-only", archived: "Archived case: read-only.", future: "This shift has not started yet.",
    noHistory: "No handovers yet.", open: "Open", generated: "Summary as of",
  },
  th: {
    title: "ส่งเวร", noCase: "เปิดเคสก่อนเพื่อส่งเวร", current: "เวรปัจจุบัน", previous: "เวรก่อนหน้า",
    history: "ประวัติการส่งเวร", nurse: "พยาบาล", doctor: "แพทย์", day: "วันที่", print: "พิมพ์", loading: "กำลังโหลด…",
    status: { none: "ยังไม่เริ่ม", draft: "ร่าง", handed: "ส่งเวรแล้ว", accepted: "รับเวรแล้ว" },
    vitals: "สัญญาณชีพ", latest: "ล่าสุด", min: "ต่ำสุด", max: "สูงสุด", noVitals: "ไม่มีสัญญาณชีพในเวรนี้",
    io: "สารน้ำเข้า / ออก", shiftIo: "เวรนี้", stayIo: "สะสมตั้งแต่รับไว้", intake: "เข้า", output: "ออก", net: "สุทธิ",
    urine: "ปัสสาวะ", blood: "เสียเลือด", items: "แยกรายการ", infusions: "ยา/สารน้ำที่หยดอยู่", noInfusions: "ไม่มียาหยดต่อเนื่อง",
    since: "เริ่ม", rateSince: "อัตรานี้ตั้งแต่", newInShift: "ใหม่", events: "เหตุการณ์และบันทึก", noEvents: "ไม่มีเหตุการณ์ในเวรนี้",
    scores: "คะแนน", noScores: "ยังไม่มีผลคะแนน", partial: "ไม่ครบ", forms: "แบบฟอร์มราวด์",
    noForms: "ไม่มีแบบฟอร์มที่ถึงกำหนด เกินกำหนด หรือข้ามในเวรนี้", overdueTotal: "เกินกำหนดทั้งการรักษา",
    formStatus: { due: "ถึงกำหนด", overdue: "เกินกำหนด", skipped: "ข้าม" }, medications: "ยา",
    medActive: "คำสั่งยาที่ใช้อยู่", medGiven: "ให้แล้ว", noMedications: "ไม่มียาที่ถึงกำหนดหรือให้ในเวรนี้",
    isbar: "ISBAR", fields: {
      identify: "I — ระบุตัวตน", situation: "S — สถานการณ์", background: "B — ภูมิหลัง", assessment: "A — การประเมิน",
      recommendation: "R — ข้อเสนอแนะ", plan: "แผน",
    },
    placeholders: {
      identify: "ผู้ป่วย ตำแหน่ง ผู้ส่งเวรและผู้รับเวร", situation: "ปัญหาและสถานะปัจจุบัน",
      background: "การวินิจฉัย ประวัติ เหตุการณ์ที่เกี่ยวข้อง", assessment: "การประเมินของผู้ส่งเวร",
      recommendation: "สิ่งที่เวรถัดไปต้องทำหรือเฝ้าระวัง", plan: "แผนสำหรับเวรถัดไป",
    },
    saving: "กำลังบันทึก…", saved: "บันทึกแล้ว", handOver: "ส่งเวร", accept: "รับเวร", handedBy: "ส่งเวรโดย",
    acceptedBy: "รับเวรโดย", at: "เมื่อ", frozen: "สรุปถูกบันทึกไว้ ณ เวลาส่งเวร", live: "สรุปอัตโนมัติ · ปรับทุก 1 นาที",
    waitAccept: "รอผู้รับเวรกดรับเวร", ownHanded: "คุณเป็นผู้ส่งเวรนี้ ยังแก้ไขได้จนกว่าจะมีผู้รับเวร",
    readOnly: "อ่านอย่างเดียว", archived: "เคสถูกเก็บถาวร: อ่านอย่างเดียว", future: "เวรนี้ยังไม่เริ่ม",
    noHistory: "ยังไม่มีการส่งเวร", open: "เปิด", generated: "สรุป ณ",
  },
};
type Text = typeof TEXT.en;

const VITALS: Record<string, { label: string; unit: string }> = {
  hr: { label: "HR", unit: "/min" }, spo2: { label: "SpO₂", unit: "%" },
  nibp_sys: { label: "NIBP sys", unit: "mmHg" }, nibp_dia: { label: "NIBP dia", unit: "mmHg" }, nibp_map: { label: "NIBP mean", unit: "mmHg" },
  art_sys: { label: "ART sys", unit: "mmHg" }, art_dia: { label: "ART dia", unit: "mmHg" }, art_map: { label: "ART mean", unit: "mmHg" },
  rr: { label: "RR", unit: "/min" }, temperature: { label: "Temp", unit: "°C" }, etco2: { label: "EtCO₂", unit: "mmHg" },
  cvp: { label: "CVP", unit: "mmHg" },
};

const EMPTY_TEXT: IsbarText = { identify: "", situation: "", background: "", assessment: "", recommendation: "", plan: "" };

const num = (value: number | null | undefined, digits = 1) =>
  value == null ? "—" : Number(value).toLocaleString([], { maximumFractionDigits: digits });
const ml = (value: number) => `${num(value, 0)} mL`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATUS_STYLE: Record<HandoverStatus | "none", string> = {
  none: "border-[var(--app-border)] text-[var(--app-muted)]",
  draft: "border-[var(--app-accent)]/50 bg-[var(--app-accent)]/10 text-[var(--app-accent)]",
  handed: "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  accepted: "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

function StatusChip({ status, L }: { status: HandoverStatus | "none"; L: Text }) {
  return <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${STATUS_STYLE[status]}`}>
    {L.status[status]}</span>;
}

function Card({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="shift-card break-inside-avoid rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div className="text-xs text-[var(--app-muted)]">{children}</div>;

function shiftName(win: ShiftWindow | { code: string; start: number }, prefs: DateTimePreferences) {
  return `${win.code} · ${formatConfiguredDateTime(win.start, prefs)}`;
}

function IoBlock({ title, totals, L }: { title: string; totals: HandoverIoTotals; L: Text }) {
  return (
    <div className="rounded-xl border border-[var(--app-border)] p-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--app-muted)]">{title}</div>
      <div className="mt-1 grid grid-cols-3 gap-1 text-center">
        {[[L.intake, totals.intake_ml], [L.output, totals.output_ml], [L.net, totals.net_ml]].map(([label, value]) => (
          <div key={label as string}>
            <div className="text-[10px] text-[var(--app-muted)]">{label}</div>
            <div className="text-sm font-bold tabular-nums text-[var(--app-text)]">{ml(value as number)}</div>
          </div>
        ))}
      </div>
      <div className="mt-1 text-[11px] text-[var(--app-muted)]">{L.urine} {ml(totals.urine_output_ml)}
        {totals.blood_loss_ml ? ` · ${L.blood} ${ml(totals.blood_loss_ml)}` : ""}</div>
    </div>
  );
}

function SummaryCards({ summary, L, prefs }: { summary: HandoverSummary; L: Text; prefs: DateTimePreferences }) {
  const time = (ts: number) => formatConfiguredTime(ts, prefs);
  const when = (ts: number) => formatConfiguredDateTime(ts, prefs);
  const medications = summary.medications;
  return (
    <div className="grid gap-3 lg:grid-cols-2 print:grid-cols-2">
      <Card title={L.vitals}>
        {summary.vitals.length ? (
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-[10px] uppercase tracking-wider text-[var(--app-muted)]">
              <th className="py-1 text-left font-bold" /><th className="text-right font-bold">{L.latest}</th>
              <th className="text-right font-bold">{L.min}</th><th className="text-right font-bold">{L.max}</th>
            </tr></thead>
            <tbody>
              {summary.vitals.map(row => (
                <tr key={row.key} className="border-t border-[var(--app-border)]">
                  <td className="py-1 font-semibold text-[var(--app-text)]">{VITALS[row.key]?.label ?? row.key}
                    <span className="ml-1 text-[10px] font-normal text-[var(--app-muted)]">{VITALS[row.key]?.unit}</span></td>
                  <td className="text-right font-bold text-[var(--app-text)]" title={when(row.latest_at)}>{num(row.latest)}
                    <span className="ml-1 text-[10px] font-normal text-[var(--app-muted)]">{time(row.latest_at)}</span></td>
                  <td className="text-right text-[var(--app-text)]">{num(row.min)}</td>
                  <td className="text-right text-[var(--app-text)]">{num(row.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>{L.noVitals}</Empty>}
      </Card>

      <Card title={L.io}>
        <div className="grid gap-2 sm:grid-cols-2">
          <IoBlock title={L.shiftIo} totals={summary.io.shift} L={L} />
          <IoBlock title={`${L.stayIo} (${formatConfiguredDateTime(summary.io.stay_from, prefs)})`} totals={summary.io.stay} L={L} />
        </div>
        {summary.io.items.length ? (
          <ul className="mt-2 grid gap-0.5 text-xs">
            {summary.io.items.slice(0, 12).map(item => (
              <li key={`${item.kind}-${item.item_id ?? item.item_code}`} className="flex justify-between gap-2">
                <span className="truncate text-[var(--app-text)]">{item.item_name}
                  <span className="ml-1 text-[10px] uppercase text-[var(--app-muted)]">{item.kind}</span></span>
                <span className="tabular-nums text-[var(--app-text)]">{ml(item.total_ml)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title={L.infusions}>
        {summary.infusions.length ? (
          <ul className="grid gap-1.5">
            {summary.infusions.map(row => {
              const rate = [row.rate_value != null ? `${num(row.rate_value, 2)} ${row.rate_unit || ""}` : "",
                row.dose_value != null ? `${num(row.dose_value, 2)} ${row.dose_unit || ""}` : ""].filter(Boolean).join(" · ");
              return (
                <li key={row.run_id} className="rounded-lg border border-[var(--app-border)] px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold text-[var(--app-text)]">{row.item_name}</span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--app-text)]">{rate || "—"}</span>
                  </div>
                  <div className="text-[11px] text-[var(--app-muted)]">
                    {[row.route, `${L.since} ${when(row.started_at)}`,
                      row.rate_since && row.rate_since !== row.started_at ? `${L.rateSince} ${when(row.rate_since)}` : "",
                      row.started_in_shift ? L.newInShift : ""].filter(Boolean).join(" · ")}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <Empty>{L.noInfusions}</Empty>}
      </Card>

      <Card title={L.scores}>
        {summary.scores.length ? (
          <ul className="grid gap-1 text-xs">
            {summary.scores.map(row => (
              <li key={row.score_id} className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-[var(--app-text)]">{row.name}</span>
                <span className="tabular-nums text-[var(--app-text)]">
                  <b>{num(row.total, 2)}</b>{row.band ? ` · ${row.band}` : ""}{row.partial ? ` · ${L.partial}` : ""}
                  <span className="ml-1 text-[10px] text-[var(--app-muted)]">{when(row.ts)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : <Empty>{L.noScores}</Empty>}
      </Card>

      <Card title={L.forms} aside={summary.forms.overdue_total ? (
        <span className="rounded-full border border-red-500/60 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-600 dark:text-red-300">
          {L.overdueTotal}: {summary.forms.overdue_total}</span>) : null}>
        {summary.forms.slots.length ? (
          <ul className="grid gap-1 text-xs">
            {summary.forms.slots.map(slot => (
              <li key={`${slot.form_id}-${slot.slot_ts}`} className="flex items-center justify-between gap-2">
                <span className="truncate text-[var(--app-text)]">{slot.title} <span className="text-[var(--app-muted)]">{slot.label}</span>
                  {slot.skip_reason ? <span className="text-[var(--app-muted)]"> · {slot.skip_reason}</span> : null}</span>
                <span className={`shrink-0 font-bold ${slot.status === "overdue" ? "text-red-600 dark:text-red-300" : slot.status === "due" ? "text-amber-600 dark:text-amber-300" : "text-[var(--app-muted)]"}`}>
                  {L.formStatus[slot.status]}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>{L.noForms}</Empty>}
      </Card>

      {medications ? (
        <Card title={L.medications} aside={medications.counts ? (
          <span className="text-[10px] text-[var(--app-muted)]">
            {L.medActive} {medications.counts.active ?? 0} · {L.medGiven} {medications.counts.given ?? 0}
            {medications.counts.overdue ? <b className="text-red-600 dark:text-red-300"> · {L.formStatus.overdue} {medications.counts.overdue}</b> : null}
          </span>) : null}>
          {medications.due?.length || medications.given?.length ? (
            <ul className="grid gap-1 text-xs">
              {(medications.due ?? []).map(row => (
                <li key={`due-${row.order_id}-${row.due_at}`} className="flex items-center justify-between gap-2">
                  <span className="truncate text-[var(--app-text)]"><b>{row.drug_name}</b> {[row.dose != null ? `${row.dose} ${row.dose_unit || ""}` : "", row.route].filter(Boolean).join(" · ")}</span>
                  <span className={`shrink-0 font-bold ${row.status === "overdue" ? "text-red-600 dark:text-red-300" : "text-amber-600 dark:text-amber-300"}`}>
                    {L.formStatus[row.status]} {time(row.due_at)}</span>
                </li>
              ))}
              {(medications.given ?? []).map(row => (
                <li key={`given-${row.id}`} className="flex items-center justify-between gap-2">
                  <span className="truncate text-[var(--app-text)]">{row.drug_name} {row.dose != null ? `${row.dose} ${row.dose_unit || ""}` : ""}</span>
                  <span className="shrink-0 text-[var(--app-muted)]">{L.medGiven} {time(row.given_at)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>{L.noMedications}</Empty>}
        </Card>
      ) : null}

      <Card title={L.events}>
        {summary.events.length ? (
          <ul className="grid max-h-72 gap-1 overflow-auto text-xs print:max-h-none">
            {summary.events.map(row => (
              <li key={row.id} className="flex gap-2">
                <span className="w-12 shrink-0 tabular-nums text-[var(--app-muted)]">{time(row.event_ts)}</span>
                <span className="min-w-0 text-[var(--app-text)]"><b>{row.title || row.event_type}</b>{row.detail ? ` — ${row.detail}` : ""}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>{L.noEvents}</Empty>}
      </Card>
    </div>
  );
}

const PRINT_MEDIA = `@media print {
  body * { visibility: hidden !important; }
  .shift-handover-print, .shift-handover-print * { visibility: visible !important; }
  .shift-handover-print { position: absolute; inset: 0 auto auto 0; width: 100%; padding: 0 !important; }
  .shift-handover-print .no-print { display: none !important; }
  .shift-handover-print textarea { border: none !important; resize: none; height: auto !important; }
  .shift-card { break-inside: avoid; }
}`;

export default function ShiftHandoverView({ caseStatus, sessionUser }: Props) {
  const caseId = caseStatus.status === "IDLE" ? null : caseStatus.case_id;
  const archived = caseStatus.status === "ARCHIVED";
  const me = sessionUser?.username ?? "";
  const canChart = !sessionUser?.permissions || sessionUser.permissions.includes("case.chart");
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const prefs = useWorkstationSettings();

  const [selection, setSelection] = useState<Selection>({ kind: "current" });
  const [role, setRole] = useState<HandoverRole>("nurse");
  const [live, setLive] = useState<{ key: string; window: ShiftWindow; summary: HandoverSummary } | null>(null);
  const [handovers, setHandovers] = useState<{ caseId: number | null; rows: ShiftHandover[] }>({ caseId: null, rows: [] });
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState<IsbarText>(EMPTY_TEXT);
  const [draftKey, setDraftKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  const editSeq = useRef(0);
  const pending = useRef<{ caseId: number; shift_start: number; role: HandoverRole; text: IsbarText } | null>(null);

  const selectionKey = `${caseId}|${selection.kind}|${selection.kind === "at" ? selection.start : ""}`;
  const loadedSummary = live?.key === selectionKey ? live : null;
  const win = loadedSummary?.window ?? null;
  const rows = handovers.caseId === caseId ? handovers.rows : [];
  const loaded = handovers.caseId === caseId;
  const record = win ? rows.find(row => row.shift_start === win.start && row.role === role) ?? null : null;
  const status: HandoverStatus | "none" = record?.status ?? "none";
  const isCurrent = !!win && win.start <= now && now < win.end;

  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    const options = selection.kind === "at" ? { at: selection.start } : { shift: selection.kind };
    getShiftHandoverSummary(caseId, options)
      .then(data => { if (!cancelled) { setLive({ key: selectionKey, ...data }); setError(""); } })
      .catch(err => { if (!cancelled) setError(errorText(err)); });
    getShiftHandovers(caseId)
      .then(data => { if (!cancelled) setHandovers({ caseId, rows: data }); })
      .catch(err => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [caseId, selection, selectionKey, tick]);

  // Refresh the live summary every minute while the shown shift is still running.
  useEffect(() => {
    const id = globalThis.setInterval(() => {
      setNow(Date.now());
      if (isCurrent) setTick(value => value + 1);
    }, REFRESH_MS);
    return () => globalThis.clearInterval(id);
  }, [isCurrent]);

  // The textareas follow the stored record until the user types; a save brings them back in sync.
  const sourceKey = `${win?.start ?? ""}|${role}|${loaded ? "1" : "0"}|${dirty ? "edit" : record?.updated_at ?? ""}`;
  if (!dirty && sourceKey !== draftKey) {
    setDraftKey(sourceKey);
    setDraft(record ? Object.fromEntries(ISBAR_FIELDS.map(field => [field, record[field] ?? ""])) as IsbarText : EMPTY_TEXT);
  }

  const upsert = useCallback((saved: ShiftHandover) => {
    setHandovers(current => current.caseId !== saved.case_id ? current : {
      caseId: current.caseId,
      rows: [saved, ...current.rows.filter(row => row.id !== saved.id)].sort((a, b) => b.shift_start - a.shift_start || a.role.localeCompare(b.role)),
    });
  }, []);

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      globalThis.clearTimeout(timer.current);
      timer.current = null;
    }
    const job = pending.current;
    if (!job) return null;
    pending.current = null;
    const seq = editSeq.current;
    setSaving(true);
    try {
      const saved = await saveShiftHandover(job.caseId, { shift_start: job.shift_start, role: job.role, ...job.text });
      upsert(saved);
      if (seq === editSeq.current) setDirty(false);
      setError("");
      return saved;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [upsert]);

  useEffect(() => () => { void flush(); }, [flush]);

  const editable = !!caseId && !!win && canChart && !archived && win.start <= now
    && (status === "none" || status === "draft" || (status === "handed" && record?.handed_by === me));
  const frozen = record && record.status !== "draft" ? record.summary : null;
  const summary = frozen ?? loadedSummary?.summary ?? null;

  const edit = (field: IsbarField, value: string) => {
    if (!caseId || !win) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    setDirty(true);
    editSeq.current += 1;
    pending.current = { caseId, shift_start: win.start, role, text: next };
    if (timer.current !== null) globalThis.clearTimeout(timer.current);
    timer.current = globalThis.setTimeout(() => { void flush(); }, AUTOSAVE_MS);
  };

  const choose = (next: Selection, nextRole: HandoverRole = role) => {
    void flush();  // saves what was typed for the shift being left; the textareas then follow the new one
    editSeq.current += 1;
    setDirty(false);
    setSelection(next);
    setRole(nextRole);
  };

  const handOver = async () => {
    if (!caseId || !win) return;
    setBusy(true);
    try {
      const saved = (await flush()) ?? record ?? await saveShiftHandover(caseId, { shift_start: win.start, role });
      upsert(await handOverShift(caseId, saved.id));
      setError("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!caseId || !record) return;
    setBusy(true);
    try {
      upsert(await acceptShiftHandover(caseId, record.id));
      setError("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!caseId) {
    return <div className="p-6 text-sm text-[var(--app-muted)]">{L.noCase}</div>;
  }

  const historyStarts = [...new Set(rows.map(row => row.shift_start))];
  const selectValue = selection.kind === "at" ? String(selection.start) : selection.kind;
  const history = rows.filter(row => !(win && row.shift_start === win.start && row.role === role));
  const who = (by?: string | null, at?: number | null) => `${by ?? "—"}${at ? ` ${L.at} ${formatConfiguredDateTime(at, prefs)}` : ""}`;

  return (
    <div className="shift-handover-print flex h-full flex-col gap-3 overflow-auto bg-[var(--app-bg)] p-4 text-[var(--app-text)] print:bg-white">
      <style>{PRINT_MEDIA}</style>

      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-extrabold">{L.title}</h1>
        <select
          className="no-print h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 text-sm"
          value={selectValue}
          onChange={event => {
            const value = event.target.value;
            choose(value === "current" || value === "previous" ? { kind: value } : { kind: "at", start: Number(value) });
          }}
        >
          <option value="current">{L.current}</option>
          <option value="previous">{L.previous}</option>
          {historyStarts.length ? <optgroup label={L.history}>
            {historyStarts.map(start => {
              const sample = rows.find(row => row.shift_start === start)!;
              return <option key={start} value={String(start)}>{shiftName({ code: sample.shift_code, start }, prefs)}</option>;
            })}
          </optgroup> : null}
        </select>
        <div className="no-print inline-flex overflow-hidden rounded-lg border border-[var(--app-border)]">
          {(["nurse", "doctor"] as const).map(value => (
            <button key={value} type="button" onClick={() => choose(selection, value)}
              className={`h-8 px-3 text-sm font-semibold ${role === value ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-control-bg)] text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)]"}`}>
              {L[value]}
            </button>
          ))}
        </div>
        <StatusChip status={status} L={L} />
        {win ? (
          <span className="text-sm text-[var(--app-muted)]">
            <b className="text-[var(--app-text)]">{win.label} ({win.code})</b>
            {win.day ? ` · ${L.day} ${win.day}` : ""} · {formatConfiguredDateTime(win.start, prefs)} – {formatConfiguredTime(win.end, prefs)}
            <span className="hidden print:inline"> · {L[role]}</span>
          </span>
        ) : <span className="text-sm text-[var(--app-muted)]">{L.loading}</span>}
        <button type="button" onClick={() => globalThis.print()}
          className="no-print ml-auto h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 text-sm font-semibold hover:bg-[var(--app-control-bg-hover)]">
          {L.print}
        </button>
      </header>

      {error ? <div className="no-print rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div> : null}

      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_26rem] print:block">
        <div className="min-w-0">
          <div className="mb-2 text-[11px] text-[var(--app-muted)]">
            {frozen ? L.frozen : isCurrent ? L.live : null}
            {summary ? ` · ${L.generated} ${formatConfiguredDateTime(summary.generated_at, prefs)}` : ""}
          </div>
          {summary ? <SummaryCards summary={summary} L={L} prefs={prefs} /> : <Empty>{L.loading}</Empty>}
          {caseId ? <div className="mt-3 print:hidden"><BundleComplianceCard caseId={caseId} /></div> : null}
        </div>

        <aside className="flex flex-col gap-3 print:mt-3">
          <Card title={L.isbar} aside={<span className="no-print text-[10px] text-[var(--app-muted)]">
            {saving ? L.saving : dirty ? "" : record ? L.saved : ""}</span>}>
            <div className="grid gap-2">
              {ISBAR_FIELDS.map(field => (
                <label key={field} className="grid gap-1">
                  <span className="text-[11px] font-bold text-[var(--app-text)]">{L.fields[field]}</span>
                  <textarea
                    className="min-h-[3.5rem] rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)] disabled:opacity-80"
                    rows={field === "plan" || field === "recommendation" ? 3 : 2}
                    value={draft[field]}
                    placeholder={editable ? L.placeholders[field] : ""}
                    disabled={!editable}
                    onChange={event => edit(field, event.target.value)}
                    onBlur={() => { void flush(); }}
                  />
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-2 text-xs">
              {record?.handed_by ? <div className="text-[var(--app-muted)]">{L.handedBy} <b className="text-[var(--app-text)]">{who(record.handed_by, record.handed_at)}</b></div> : null}
              {record?.accepted_by ? <div className="text-[var(--app-muted)]">{L.acceptedBy} <b className="text-[var(--app-text)]">{who(record.accepted_by, record.accepted_at)}</b></div> : null}
              {archived ? <div className="text-[var(--app-muted)]">{L.archived}</div>
                : win && win.start > now ? <div className="text-[var(--app-muted)]">{L.future}</div>
                  : status === "handed" && record?.handed_by === me ? <div className="text-[var(--app-muted)]">{L.ownHanded}</div>
                    : status === "handed" ? <div className="text-[var(--app-muted)]">{L.waitAccept}</div> : null}
              <div className="no-print flex flex-wrap gap-2">
                {(status === "none" || status === "draft") && editable ? (
                  <button type="button" disabled={busy} onClick={() => { void handOver(); }}
                    className="h-9 rounded-lg bg-[var(--app-accent)] px-4 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">
                    {L.handOver}
                  </button>
                ) : null}
                {status === "handed" && record?.handed_by !== me && canChart && !archived ? (
                  <button type="button" disabled={busy} onClick={() => { void accept(); }}
                    className="h-9 rounded-lg bg-emerald-600 px-4 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                    {L.accept}
                  </button>
                ) : null}
                {!editable && status !== "handed" ? <span className="self-center text-[var(--app-muted)]">{L.readOnly}</span> : null}
              </div>
            </div>
          </Card>

          <Card title={L.history}>
            {history.length ? (
              <ul className="grid gap-1 text-xs">
                {history.map(row => (
                  <li key={row.id}>
                    <button type="button" onClick={() => choose({ kind: "at", start: row.shift_start }, row.role)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] px-2 py-1.5 text-left hover:bg-[var(--app-hover-bg)]">
                      <span className="min-w-0">
                        <span className="font-semibold text-[var(--app-text)]">{shiftName({ code: row.shift_code, start: row.shift_start }, prefs)}</span>
                        <span className="ml-1 text-[var(--app-muted)]">· {L[row.role]}</span>
                        {row.handed_by ? <span className="block truncate text-[10px] text-[var(--app-muted)]">
                          {row.handed_by}{row.accepted_by ? ` → ${row.accepted_by}` : ""}</span> : null}
                      </span>
                      <StatusChip status={row.status} L={L} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : <Empty>{L.noHistory}</Empty>}
          </Card>
        </aside>
      </div>
    </div>
  );
}
