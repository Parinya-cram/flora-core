import { useCallback, useEffect, useMemo, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import { useLanguage } from "../context/LanguageContext";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import {
  formatConfiguredDate, formatConfiguredDateTime, formatConfiguredTime, timestampToWallClockInput, wallClockInputToTimestamp,
} from "../utils/dateTime";
import {
  approveMedOrder, createMedOrder, discontinueMedOrder, getMar, holdMedOrder, listMedOrders, needsAdminApproval,
  needsOrderApproval, recordMar, resumeMedOrder, searchMedCatalog, verifyMedOrder, voidMar,
  type ApprovalRule, type CatalogDrug, type Mar, type MarEntry, type MarOrder, type MarSlot, type MarSlotStatus,
  type MedAdmin, type MedAdminStatus, type MedCoding, type MedOrder, type MedSchedule, type NewMedOrder, type TmtEntry,
} from "../api/medOrdersApi";
import PinApprovalDialog from "../components/meds/PinApprovalDialog";
import { pinErrorText } from "../components/meds/pinErrors";

/**
 * Medication orders + MAR (routes/med_orders_leaf.py). Doctors (`med.order`) order Continue / One-time drugs;
 * nurses verify and chart doses on the MAR. A given dose also writes the I/O chart. High-alert drugs need a
 * doctor's staff PIN to start the order and/or per dose.
 */

const TEXT = {
  en: {
    title: "Medication", orders: "Orders", mar: "MAR", noCase: "No case is open.", newOrder: "New order",
    continue: "Continue", once: "One-time", none: "No orders.", prn: "PRN", his: "HIS", verified: "verified",
    status: { pending_approval: "Awaiting approval", active: "Active", held: "Held", discontinued: "Discontinued", completed: "Completed" },
    hold: "Hold", resume: "Resume", discontinue: "Discontinue", verify: "Verify", approve: "Approve", reason: "Reason",
    reasonRequired: "A reason is required.", cancel: "Cancel", save: "Save", saving: "Saving…", close: "Close",
    search: "Search drug (name, TMT, SNOMED code)", searching: "Searching…", catalogue: "Catalogue", tmtOnly: "TMT (not in catalogue)",
    freeText: "Use as free text", drug: "Drug", type: "Order type", dose: "Dose", unit: "Unit", route: "Route", form: "Form",
    schedule: "Schedule", every: "Every", hours: "h", firstAt: "first at", times: "Times (HH:MM, comma separated)",
    infusion: "Continuous infusion", rate: "Rate", start: "Start", end: "End (optional)", days: "Duration (days)",
    instructions: "Instructions", indication: "Indication", approvalRule: "Doctor PIN", approvalOrder: "to start the order",
    approvalAdmin: "for every dose", approvalHint: "Required by the drug; you can add a rule, not remove one.",
    approveOrder: "Approve order", approveDose: "Confirm dose", prev: "Previous day", next: "Next day", today: "Today",
    givePrn: "Give PRN", startInfusion: "Start", running: "Running", notRunning: "Not running", give: "Give",
    holdDose: "Hold", refuse: "Refuse", notGiven: "Not given", missed: "Missed", givenAt: "Time", site: "Site", note: "Note",
    record: "Record", recorded: "Recorded by", voidRecord: "Void (entered in error)", voidReason: "Reason for voiding",
    slotStatus: { given: "Given", held: "Held", refused: "Refused", missed: "Missed", not_given: "Not given", due: "Due",
      overdue: "Overdue", upcoming: "Upcoming" } as Record<MarSlotStatus, string>,
    unscheduled: "Unscheduled doses", noDrugItem: "Not in the catalogue: the dose is not added to I/O.", orderedBy: "Ordered by",
    scheduleNeeded: "Choose a schedule (or PRN).",
  },
  th: {
    title: "ยา", orders: "คำสั่งยา", mar: "MAR", noCase: "ยังไม่มีเคสที่เปิดอยู่", newOrder: "สั่งยา",
    continue: "Continue (ต่อเนื่อง)", once: "One-time (ครั้งเดียว)", none: "ไม่มีคำสั่งยา", prn: "PRN", his: "HIS", verified: "ตรวจสอบแล้ว",
    status: { pending_approval: "รออนุมัติ", active: "ใช้อยู่", held: "พักยา", discontinued: "หยุดยา", completed: "เสร็จสิ้น" },
    hold: "พักยา", resume: "ให้ต่อ", discontinue: "หยุดยา", verify: "ตรวจสอบคำสั่ง", approve: "อนุมัติ", reason: "เหตุผล",
    reasonRequired: "ต้องระบุเหตุผล", cancel: "ยกเลิก", save: "บันทึก", saving: "กำลังบันทึก…", close: "ปิด",
    search: "ค้นหายา (ชื่อ, รหัส TMT, SNOMED)", searching: "กำลังค้นหา…", catalogue: "รายการยา", tmtOnly: "TMT (ไม่อยู่ในรายการยา)",
    freeText: "ใช้เป็นข้อความอิสระ", drug: "ยา", type: "ประเภทคำสั่ง", dose: "ขนาดยา", unit: "หน่วย", route: "วิธีให้", form: "รูปแบบ",
    schedule: "เวลาให้ยา", every: "ทุก", hours: "ชม.", firstAt: "เริ่มเวลา", times: "เวลา (HH:MM คั่นด้วยจุลภาค)",
    infusion: "หยดต่อเนื่อง (infusion)", rate: "อัตรา", start: "เริ่ม", end: "สิ้นสุด (ถ้ามี)", days: "จำนวนวัน",
    instructions: "คำแนะนำ", indication: "ข้อบ่งใช้", approvalRule: "PIN แพทย์", approvalOrder: "เพื่อเริ่มคำสั่งยา",
    approvalAdmin: "ทุกครั้งที่ให้ยา", approvalHint: "ยานี้กำหนดไว้แล้ว เพิ่มเงื่อนไขได้แต่ลดไม่ได้",
    approveOrder: "อนุมัติคำสั่งยา", approveDose: "ยืนยันการให้ยา", prev: "วันก่อน", next: "วันถัดไป", today: "วันนี้",
    givePrn: "ให้ยา PRN", startInfusion: "เริ่ม", running: "กำลังให้", notRunning: "ยังไม่เริ่ม", give: "ให้ยา",
    holdDose: "งดให้", refuse: "ผู้ป่วยปฏิเสธ", notGiven: "ไม่ได้ให้", missed: "ขาดการให้", givenAt: "เวลา", site: "ตำแหน่ง", note: "หมายเหตุ",
    record: "บันทึก", recorded: "บันทึกโดย", voidRecord: "ยกเลิกรายการ (บันทึกผิด)", voidReason: "เหตุผลที่ยกเลิก",
    slotStatus: { given: "ให้แล้ว", held: "งดให้", refused: "ปฏิเสธ", missed: "ขาด", not_given: "ไม่ได้ให้", due: "ถึงเวลา",
      overdue: "เลยเวลา", upcoming: "ยังไม่ถึง" } as Record<MarSlotStatus, string>,
    unscheduled: "การให้ยานอกตาราง", noDrugItem: "ไม่อยู่ในรายการยา: จะไม่ลง I/O", orderedBy: "สั่งโดย",
    scheduleNeeded: "เลือกเวลาให้ยา (หรือ PRN)",
  },
};
type Text = (typeof TEXT)["en"];

const ROUTES = ["IV", "PO", "IM", "SC", "SL", "PR", "INH", "TOP", "NG", "OTHER"];
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--app-accent)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const field = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--app-accent)]";
const label = "block text-xs font-semibold text-[var(--app-muted)]";

const STATUS_CHIP: Record<string, string> = {
  pending_approval: "border-amber-500/40 bg-amber-500/10 text-amber-700",
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  held: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  discontinued: "border-rose-500/40 bg-rose-500/10 text-rose-500",
  completed: "border-[var(--app-border)] text-[var(--app-muted)]",
};
const SLOT_CELL: Record<MarSlotStatus, string> = {
  given: "border-emerald-500/50 bg-emerald-500/15 text-emerald-600",
  held: "border-amber-500/50 bg-amber-500/10 text-amber-600",
  refused: "border-rose-500/40 bg-rose-500/10 text-rose-500",
  missed: "border-rose-500/60 bg-rose-500/15 text-rose-500",
  not_given: "border-rose-500/40 bg-rose-500/10 text-rose-500",
  due: "border-sky-500/60 bg-sky-500/15 text-sky-600 font-bold",
  overdue: "border-rose-500 bg-rose-500/20 text-rose-600 font-bold",
  upcoming: "border-[var(--app-border)] text-[var(--app-muted)]",
};

function Modal({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
    <div className={`max-h-[90vh] w-full ${wide ? "max-w-2xl" : "max-w-lg"} overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 shadow-2xl`}>
      <h3 className="text-lg font-bold">{title}</h3>
      {children}
    </div>
  </div>;
}

const errorText = (err: unknown, language: string) => pinErrorText(err, language);

function codingText(codings: MedCoding[] | null | undefined) {
  return (codings || []).filter(c => c.system === "TMT" || c.system === "SNOMED_CT")
    .map(c => `${c.system === "SNOMED_CT" ? "SCT" : c.system} ${c.code}`).join(" · ");
}

function scheduleText(order: Pick<MedOrder, "schedule" | "prn" | "order_type">, L: Text) {
  const s = order.schedule;
  const parts = [];
  if (s?.kind === "every") parts.push(`q${s.every_hours}h${s.anchor ? ` (${s.anchor})` : ""}`);
  if (s?.kind === "times") parts.push(s.times.join(", "));
  if (s?.kind === "infusion") parts.push(`${L.infusion} ${s.rate} ${s.rate_unit || "ml/h"}`);
  if (order.prn) parts.push(L.prn);
  return parts.join(" · ");
}

function doseText(order: Pick<MedOrder, "dose" | "dose_unit" | "route">) {
  return [order.dose !== null && order.dose !== undefined ? `${order.dose} ${order.dose_unit || ""}`.trim() : "", order.route || ""]
    .filter(Boolean).join(" ");
}

export default function MedicationView({ caseStatus, sessionUser }: { caseStatus: CaseStatus; sessionUser: AuthUser | null }) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [tab, setTab] = useState<"orders" | "mar">("orders");
  const permissions = sessionUser?.permissions || [];
  const canOrder = permissions.includes("med.order");
  const canChart = permissions.includes("case.chart");
  if (caseStatus.status === "IDLE") return <div className="p-6 text-sm text-[var(--app-muted)]">{L.noCase}</div>;
  const caseId = caseStatus.case_id;
  const editable = caseStatus.status !== "ARCHIVED";
  return <div className="flex h-full min-h-0 flex-col gap-3 p-4">
    <div className="flex items-center gap-3">
      <h2 className="text-xl font-bold">{L.title}</h2>
      <div className="flex rounded-lg border border-[var(--app-border)] p-0.5">
        {(["orders", "mar"] as const).map(key => <button key={key} type="button" onClick={() => setTab(key)}
          className={`rounded-md px-3 py-1 text-sm font-semibold ${tab === key ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : ""}`}>
          {key === "orders" ? L.orders : L.mar}</button>)}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      {tab === "orders"
        ? <OrdersTab caseId={caseId} L={L} canOrder={canOrder && editable} canChart={canChart && editable} />
        : <MarTab caseId={caseId} L={L} canChart={canChart && editable} />}
    </div>
  </div>;
}

// ---------------------------------------------------------------- orders

function OrdersTab({ caseId, L, canOrder, canChart }: { caseId: number; L: Text; canOrder: boolean; canChart: boolean }) {
  const { language } = useLanguage();
  const settings = useWorkstationSettings();
  const [orders, setOrders] = useState<MedOrder[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState<MedOrder | null>(null);
  const [approving, setApproving] = useState<MedOrder | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    listMedOrders(caseId).then(result => { setOrders(result.orders); setError(""); }).catch(err => setError(errorText(err, language)));
  }, [caseId, language]);
  useEffect(() => { load(); }, [load]);

  const act = async (order: MedOrder, run: () => Promise<unknown>) => {
    setBusy(order.id);
    try { await run(); load(); } catch (err) { setError(errorText(err, language)); } finally { setBusy(""); }
  };

  const groups: [string, MedOrder[]][] = [
    [L.continue, (orders || []).filter(o => o.order_type === "continue")],
    [L.once, (orders || []).filter(o => o.order_type === "once")],
  ];
  return <div className="space-y-4">
    <div className="flex items-center gap-2">
      {canOrder && <button type="button" className={primary} onClick={() => setCreating(true)}>+ {L.newOrder}</button>}
      {error && <span className="text-sm text-[var(--app-danger)]">{error}</span>}
    </div>
    {groups.map(([title, list]) => <section key={title} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
      <div className="border-b border-[var(--app-border)] px-4 py-2 text-sm font-bold">{title}</div>
      {!list.length && <div className="px-4 py-3 text-sm text-[var(--app-muted)]">{L.none}</div>}
      {list.map(order => <div key={order.id} className={`flex flex-wrap items-center gap-3 border-b border-[var(--app-border)] px-4 py-2 last:border-0 ${order.status === "discontinued" || order.status === "completed" ? "opacity-60" : ""}`}>
        <div className="min-w-[240px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{order.drug_name}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_CHIP[order.status]}`}>{L.status[order.status]}</span>
            {order.prn && <span className="rounded-full border border-sky-500/40 px-2 py-0.5 text-[11px] font-semibold text-sky-600">{L.prn}</span>}
            {order.source === "his" && <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-0.5 text-[11px] font-bold">{L.his}</span>}
            {order.approval_required !== "none" && <span className="text-[11px] text-amber-700" title={L.approvalRule}>🔒 {L.approvalRule}</span>}
            {order.verified_at && <span className="text-[11px] text-emerald-600">✓ {L.verified}</span>}
          </div>
          <div className="text-sm">{[doseText(order), scheduleText(order, L)].filter(Boolean).join(" · ")}</div>
          <div className="text-xs text-[var(--app-muted)]">
            {L.start} {formatConfiguredDateTime(order.start_at, settings)}
            {order.end_at ? ` → ${formatConfiguredDateTime(order.end_at, settings)}` : order.duration_days ? ` · ${order.duration_days} d` : ""}
            {` · ${L.orderedBy} ${order.ordered_by || "-"}`}
            {codingText(order.codings) ? ` · ${codingText(order.codings)}` : ""}
            {order.instructions ? ` · ${order.instructions}` : ""}
            {order.discontinue_reason ? ` · ${L.reason}: ${order.discontinue_reason}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {order.status === "pending_approval" && canChart &&
            <button type="button" className={primary} disabled={busy === order.id} onClick={() => setApproving(order)}>{L.approve}</button>}
          {canChart && !order.verified_at && order.status !== "discontinued" &&
            <button type="button" className={button} disabled={busy === order.id} onClick={() => act(order, () => verifyMedOrder(caseId, order.id))}>{L.verify}</button>}
          {canOrder && order.status === "active" &&
            <button type="button" className={button} disabled={busy === order.id} onClick={() => act(order, () => holdMedOrder(caseId, order.id))}>{L.hold}</button>}
          {canOrder && order.status === "held" &&
            <button type="button" className={button} disabled={busy === order.id} onClick={() => act(order, () => resumeMedOrder(caseId, order.id))}>{L.resume}</button>}
          {canOrder && ["pending_approval", "active", "held"].includes(order.status) &&
            <button type="button" className={`${button} text-rose-500`} disabled={busy === order.id} onClick={() => setStopping(order)}>{L.discontinue}</button>}
        </div>
      </div>)}
    </section>)}
    {creating && <NewOrderDialog caseId={caseId} L={L} onClose={() => setCreating(false)}
      onDone={order => { setCreating(false); load(); if (order.status === "pending_approval") setApproving(order); }} />}
    {stopping && <ReasonDialog title={`${L.discontinue}: ${stopping.drug_name}`} L={L} onClose={() => setStopping(null)}
      onSubmit={reason => discontinueMedOrder(caseId, stopping.id, reason).then(() => { setStopping(null); load(); })} />}
    {approving && <PinApprovalDialog caseId={caseId} title={L.approveOrder}
      detail={`${approving.drug_name} ${doseText(approving)} ${scheduleText(approving, L)}`} onClose={() => setApproving(null)}
      onApprove={async approval => { await approveMedOrder(caseId, approving.id, { ...approval, kind: "order" }); setApproving(null); load(); }} />}
  </div>;
}

function ReasonDialog({ title, L, onSubmit, onClose }: { title: string; L: Text; onSubmit: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const { language } = useLanguage();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!reason.trim()) { setError(L.reasonRequired); return; }
    setBusy(true);
    try { await onSubmit(reason.trim()); } catch (err) { setError(errorText(err, language)); setBusy(false); }
  };
  return <Modal title={title}>
    <label className={`${label} mt-3`}>{L.reason}
      <input className={`${field} mt-1`} value={reason} onChange={event => setReason(event.target.value)} autoFocus />
    </label>
    {error && <div className="mt-2 text-sm text-[var(--app-danger)]">{error}</div>}
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" className={button} onClick={onClose} disabled={busy}>{L.cancel}</button>
      <button type="button" className={primary} onClick={submit} disabled={busy}>{busy ? L.saving : L.save}</button>
    </div>
  </Modal>;
}

type ScheduleKind = "every" | "times" | "infusion" | "none";
type Pick_ = { kind: "item"; item: CatalogDrug } | { kind: "tmt"; entry: TmtEntry } | { kind: "free"; name: string };

function NewOrderDialog({ caseId, L, onClose, onDone }: { caseId: number; L: Text; onClose: () => void; onDone: (order: MedOrder) => void }) {
  const { language } = useLanguage();
  const settings = useWorkstationSettings();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ items: CatalogDrug[]; tmt: TmtEntry[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [drug, setDrug] = useState<Pick_ | null>(null);
  const [orderType, setOrderType] = useState<"continue" | "once">("continue");
  const [prn, setPrn] = useState(false);
  const [dose, setDose] = useState("");
  const [unit, setUnit] = useState("");
  const [route, setRoute] = useState("IV");
  const [kind, setKind] = useState<ScheduleKind>("every");
  const [everyHours, setEveryHours] = useState(8);
  const [anchor, setAnchor] = useState("06:00");
  const [times, setTimes] = useState("08:00, 20:00");
  const [rate, setRate] = useState("");
  const [rateUnit, setRateUnit] = useState("ml/h");
  const [start, setStart] = useState(() => timestampToWallClockInput(Date.now(), settings.timezone));
  const [end, setEnd] = useState("");
  const [days, setDays] = useState("");
  const [instructions, setInstructions] = useState("");
  const [indication, setIndication] = useState("");
  const [extraOrder, setExtraOrder] = useState(false);
  const [extraAdmin, setExtraAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || drug) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchMedCatalog(q).then(result => { if (alive) setResults(result); }).catch(() => undefined)
        .finally(() => { if (alive) setSearching(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query, drug]);

  const itemRule: ApprovalRule = drug?.kind === "item" ? drug.item.approval_required || "none" : "none";
  const ruleOrder = needsOrderApproval(itemRule) || extraOrder;
  const ruleAdmin = needsAdminApproval(itemRule) || extraAdmin;
  const effectiveKind: ScheduleKind = orderType === "once" && kind !== "infusion" ? "none" : kind;

  const choose = (pick: Pick_) => {
    setDrug(pick);
    if (pick.kind === "item" && pick.item.default_unit) setUnit(pick.item.default_unit);
  };

  const submit = async () => {
    if (!drug) return;
    let schedule: MedSchedule | null = null;
    if (effectiveKind === "every") schedule = { kind: "every", every_hours: everyHours, anchor };
    if (effectiveKind === "times") schedule = { kind: "times", times: times.split(/[,\s]+/).map(t => t.trim()).filter(Boolean) };
    if (effectiveKind === "infusion") schedule = { kind: "infusion", rate: Number(rate), rate_unit: rateUnit };
    if (orderType === "continue" && !schedule && !prn) { setError(L.scheduleNeeded); return; }
    const startAt = wallClockInputToTimestamp(start, settings.timezone) ?? Date.now();
    const order: NewMedOrder = {
      order_type: orderType, prn: orderType === "continue" && prn, schedule: prn && effectiveKind !== "infusion" ? null : schedule,
      dose: dose ? Number(dose) : null, dose_unit: unit || null, route, start_at: startAt,
      end_at: end ? wallClockInputToTimestamp(end, settings.timezone) : null, duration_days: days ? Number(days) : null,
      instructions: instructions || null, indication: indication || null,
      approval_required: ruleOrder && ruleAdmin ? "both" : ruleOrder ? "order" : ruleAdmin ? "admin" : "none",
      ...(drug.kind === "item" ? { item_id: drug.item.id } : drug.kind === "tmt"
        ? { drug_name: drug.entry.display, codings: drug.entry.codings } : { drug_name: drug.name }),
    };
    setBusy(true);
    setError("");
    try {
      const result = await createMedOrder(caseId, order);
      onDone(result.order);
    } catch (err) {
      setError(errorText(err, language));
      setBusy(false);
    }
  };

  const drugName = drug?.kind === "item" ? drug.item.name : drug?.kind === "tmt" ? drug.entry.display : drug?.name;
  return <Modal title={L.newOrder} wide>
    <div className="mt-3 space-y-3">
      {!drug ? <div>
        <label className={label}>{L.drug}
          <input className={`${field} mt-1`} value={query} onChange={event => setQuery(event.target.value)} placeholder={L.search} autoFocus />
        </label>
        {searching && <div className="mt-1 text-xs text-[var(--app-muted)]">{L.searching}</div>}
        {results && query.trim().length >= 2 && <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-[var(--app-border)]">
          {results.items.length > 0 && <div className="px-3 pt-2 text-[11px] font-bold uppercase text-[var(--app-muted)]">{L.catalogue}</div>}
          {results.items.map(item => <button key={item.id} type="button" onClick={() => choose({ kind: "item", item })}
            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--app-control-bg-hover)]">
            <span className="font-semibold">{item.name}</span>
            {item.approval_required !== "none" && <span className="ml-1 text-xs text-amber-700">🔒</span>}
            <span className="ml-2 text-xs text-[var(--app-muted)]">{[item.code, codingText(item.codings)].filter(Boolean).join(" · ")}</span>
          </button>)}
          {results.tmt.length > 0 && <div className="px-3 pt-2 text-[11px] font-bold uppercase text-[var(--app-muted)]">{L.tmtOnly}</div>}
          {results.tmt.map(entry => <button key={entry.code} type="button" onClick={() => choose({ kind: "tmt", entry })}
            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--app-control-bg-hover)]">
            {entry.display} <span className="text-xs text-[var(--app-muted)]">TMT {entry.code}{entry.level ? ` · ${entry.level}` : ""}</span>
          </button>)}
          <button type="button" onClick={() => choose({ kind: "free", name: query.trim() })}
            className="block w-full border-t border-[var(--app-border)] px-3 py-1.5 text-left text-sm italic hover:bg-[var(--app-control-bg-hover)]">
            {L.freeText}: “{query.trim()}”</button>
        </div>}
      </div> : <div className="flex items-start justify-between gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2">
        <div>
          <div className="font-semibold">{drugName}</div>
          <div className="text-xs text-[var(--app-muted)]">
            {drug.kind === "item" ? codingText(drug.item.codings) : drug.kind === "tmt" ? `TMT ${drug.entry.code}` : ""}
          </div>
          {drug.kind !== "item" && <div className="text-xs text-amber-700">{L.noDrugItem}</div>}
        </div>
        <button type="button" className={button} onClick={() => { setDrug(null); setResults(null); }}>✕</button>
      </div>}

      <div className="flex flex-wrap gap-2">
        <span className={label}>{L.type}</span>
        {(["continue", "once"] as const).map(type => <button key={type} type="button" onClick={() => setOrderType(type)}
          className={orderType === type ? primary : button}>{type === "continue" ? L.continue : L.once}</button>)}
        {orderType === "continue" && <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={prn} onChange={event => setPrn(event.target.checked)} /> {L.prn}</label>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className={label}>{L.dose}<input className={`${field} mt-1`} inputMode="decimal" value={dose} onChange={event => setDose(event.target.value)} /></label>
        <label className={label}>{L.unit}<input className={`${field} mt-1`} value={unit} onChange={event => setUnit(event.target.value)} /></label>
        <label className={label}>{L.route}
          <select className={`${field} mt-1`} value={route} onChange={event => setRoute(event.target.value)}>
            {ROUTES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      </div>

      <div className="space-y-2 rounded-lg border border-[var(--app-border)] p-3">
        <div className={label}>{L.schedule}</div>
        <div className="flex flex-wrap gap-2">
          {orderType === "continue" && <>
            {[4, 6, 8, 12, 24].map(hours => <button key={hours} type="button" className={kind === "every" && everyHours === hours ? primary : button}
              onClick={() => { setKind("every"); setEveryHours(hours); }}>q{hours}h</button>)}
            <button type="button" className={kind === "times" ? primary : button} onClick={() => setKind("times")}>{L.times.split(" (")[0]}</button>
          </>}
          <button type="button" className={kind === "infusion" ? primary : button} onClick={() => setKind(kind === "infusion" ? (orderType === "once" ? "none" : "every") : "infusion")}>{L.infusion}</button>
        </div>
        {effectiveKind === "every" && !prn && <label className={`${label} flex items-center gap-2`}>{L.firstAt}
          <input type="time" className={`${field} w-32`} value={anchor} onChange={event => setAnchor(event.target.value)} /></label>}
        {effectiveKind === "times" && !prn && <label className={label}>{L.times}
          <input className={`${field} mt-1`} value={times} onChange={event => setTimes(event.target.value)} /></label>}
        {effectiveKind === "infusion" && <div className="grid grid-cols-2 gap-2">
          <label className={label}>{L.rate}<input className={`${field} mt-1`} inputMode="decimal" value={rate} onChange={event => setRate(event.target.value)} /></label>
          <label className={label}>{L.unit}<input className={`${field} mt-1`} value={rateUnit} onChange={event => setRateUnit(event.target.value)} /></label>
        </div>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <label className={label}>{L.start}<input type="datetime-local" className={`${field} mt-1`} value={start} onChange={event => setStart(event.target.value)} /></label>
        {orderType === "continue" && <>
          <label className={label}>{L.end}<input type="datetime-local" className={`${field} mt-1`} value={end} onChange={event => setEnd(event.target.value)} /></label>
          <label className={label}>{L.days}<input className={`${field} mt-1`} inputMode="numeric" value={days} onChange={event => setDays(event.target.value.replace(/\D/g, ""))} /></label>
        </>}
      </div>
      <label className={label}>{L.instructions}<input className={`${field} mt-1`} value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
      <label className={label}>{L.indication}<input className={`${field} mt-1`} value={indication} onChange={event => setIndication(event.target.value)} /></label>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
        <div className="text-xs font-semibold text-amber-700">🔒 {L.approvalRule}</div>
        <label className="mr-4 inline-flex items-center gap-1"><input type="checkbox" checked={ruleOrder} disabled={needsOrderApproval(itemRule)}
          onChange={event => setExtraOrder(event.target.checked)} /> {L.approvalOrder}</label>
        <label className="inline-flex items-center gap-1"><input type="checkbox" checked={ruleAdmin} disabled={needsAdminApproval(itemRule)}
          onChange={event => setExtraAdmin(event.target.checked)} /> {L.approvalAdmin}</label>
        {itemRule !== "none" && <div className="text-xs text-[var(--app-muted)]">{L.approvalHint}</div>}
      </div>
    </div>
    {error && <div className="mt-3 text-sm text-[var(--app-danger)]">{error}</div>}
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" className={button} onClick={onClose} disabled={busy}>{L.cancel}</button>
      <button type="button" className={primary} onClick={submit} disabled={busy || !drug}>{busy ? L.saving : L.save}</button>
    </div>
  </Modal>;
}

// ---------------------------------------------------------------- MAR

type GiveTarget = { order: MarOrder; dueAt: number | null; infusion?: boolean };

function MarTab({ caseId, L, canChart }: { caseId: number; L: Text; canChart: boolean }) {
  const { language } = useLanguage();
  const settings = useWorkstationSettings();
  const [mar, setMar] = useState<Mar | null>(null);
  const [from, setFrom] = useState<number | undefined>(undefined);
  const [error, setError] = useState("");
  const [give, setGive] = useState<GiveTarget | null>(null);
  const [shown, setShown] = useState<{ order: MarOrder; admin: MedAdmin } | null>(null);

  const load = useCallback(() => {
    getMar(caseId, from).then(result => { setMar(result); setError(""); }).catch(err => setError(errorText(err, language)));
  }, [caseId, from, language]);
  useEffect(() => { load(); }, [load]);

  const hours = useMemo(() => mar ? Array.from({ length: 24 }, (_, index) => mar.from + index * 3_600_000) : [], [mar]);
  const DAY = 86_400_000;
  const hourOf = (ts: number) => mar ? Math.min(23, Math.max(0, Math.floor((ts - mar.from) / 3_600_000))) : 0;
  const rows = (mar?.orders || []).filter(o => o.status !== "pending_approval");

  const openSlot = (order: MarOrder, slot: MarSlot) => {
    const admin = slot.admin_id ? order.admins.find(a => a.id === slot.admin_id) : undefined;
    if (admin) setShown({ order, admin });
    else if (canChart && order.status !== "discontinued") setGive({ order, dueAt: slot.due_at });
  };

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} disabled={!mar} onClick={() => mar && setFrom(mar.from - DAY)}>‹ {L.prev}</button>
      <div className="min-w-[140px] text-center text-sm font-bold">{mar ? formatConfiguredDate(mar.from, settings) : "…"}
        {mar && mar.day_start !== "00:00" && <span className="ml-1 text-xs font-normal text-[var(--app-muted)]">({mar.day_start})</span>}</div>
      <button type="button" className={button} disabled={!mar} onClick={() => mar && setFrom(mar.from + DAY)}>{L.next} ›</button>
      <button type="button" className={button} onClick={() => setFrom(undefined)}>{L.today}</button>
      {error && <span className="text-sm text-[var(--app-danger)]">{error}</span>}
    </div>
    {mar && <div className="overflow-x-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
      <table className="w-full min-w-[1100px] border-collapse text-xs">
        <thead><tr className="border-b border-[var(--app-border)]">
          <th className="sticky left-0 z-10 w-64 bg-[var(--app-panel-bg)] px-3 py-2 text-left">{L.drug}</th>
          {hours.map(ts => <th key={ts} className={`w-10 px-0.5 py-2 text-center font-semibold ${mar.now >= ts && mar.now < ts + 3_600_000 ? "text-[var(--app-accent)]" : "text-[var(--app-muted)]"}`}>
            {formatConfiguredTime(ts, settings).slice(0, 2)}</th>)}
        </tr></thead>
        <tbody>
          {!rows.length && <tr><td colSpan={25} className="px-3 py-4 text-sm text-[var(--app-muted)]">{L.none}</td></tr>}
          {rows.map(order => {
            const infusion = order.schedule?.kind === "infusion";
            const unscheduled = order.admins.filter(a => a.due_at === null);
            return <tr key={order.id} className="border-b border-[var(--app-border)] last:border-0 align-top">
              <td className="sticky left-0 z-10 bg-[var(--app-panel-bg)] px-3 py-2">
                <div className="font-semibold">{order.drug_name}
                  {order.approval_required !== "none" && <span className="ml-1 text-amber-700">🔒</span>}</div>
                <div className="text-[var(--app-muted)]">{[doseText(order), scheduleText(order, L)].filter(Boolean).join(" · ")}</div>
                {order.status !== "active" && <span className={`mt-1 inline-block rounded-full border px-2 text-[10px] font-semibold ${STATUS_CHIP[order.status]}`}>{L.status[order.status]}</span>}
                {infusion && <div className={`mt-1 text-[11px] font-semibold ${order.infusion ? "text-emerald-600" : "text-[var(--app-muted)]"}`}>
                  {order.infusion ? `● ${L.running} ${order.infusion.rate_value ?? ""} ${order.infusion.rate_unit || ""} · ${formatConfiguredTime(order.infusion.started_at, settings)}` : L.notRunning}
                </div>}
                <div className="mt-1 flex gap-1">
                  {canChart && order.status === "active" && order.prn && !infusion &&
                    <button type="button" className={primary} onClick={() => setGive({ order, dueAt: null })}>{L.givePrn}</button>}
                  {canChart && order.status === "active" && infusion && !order.infusion &&
                    <button type="button" className={primary} onClick={() => setGive({ order, dueAt: null, infusion: true })}>▶ {L.startInfusion}</button>}
                </div>
              </td>
              {hours.map((ts, index) => {
                const slots = order.slots.filter(s => hourOf(s.due_at) === index);
                const extra = unscheduled.filter(a => hourOf(a.given_at ?? a.recorded_at) === index);
                return <td key={ts} className="border-l border-[var(--app-border)] px-0.5 py-1 text-center">
                  {slots.map(slot => <button key={slot.due_at} type="button" title={`${formatConfiguredTime(slot.due_at, settings)} · ${L.slotStatus[slot.status]}`}
                    onClick={() => openSlot(order, slot)}
                    className={`mb-0.5 block w-full rounded border px-0.5 py-1 text-[10px] leading-tight ${SLOT_CELL[slot.status]}`}>
                    {formatConfiguredTime(slot.due_at, settings)}
                    <span className="block text-[9px]">{slot.status === "given" ? "✓" : L.slotStatus[slot.status].slice(0, 6)}</span>
                  </button>)}
                  {extra.map(admin => <button key={admin.id} type="button" onClick={() => setShown({ order, admin })}
                    title={L.unscheduled} className={`mb-0.5 block w-full rounded border border-dashed px-0.5 py-1 text-[10px] ${SLOT_CELL[admin.status]}`}>
                    {formatConfiguredTime(admin.given_at ?? admin.recorded_at, settings)}<span className="block text-[9px]">{infusion ? "▶" : "✓"}</span>
                  </button>)}
                </td>;
              })}
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
    {give && <GiveDialog caseId={caseId} target={give} L={L} onClose={() => setGive(null)} onDone={() => { setGive(null); load(); }} />}
    {shown && <AdminDialog caseId={caseId} order={shown.order} admin={shown.admin} L={L} canChart={canChart}
      onClose={() => setShown(null)} onDone={() => { setShown(null); load(); }} />}
  </div>;
}

function GiveDialog({ caseId, target, L, onClose, onDone }: { caseId: number; target: GiveTarget; L: Text; onClose: () => void; onDone: () => void }) {
  const { language } = useLanguage();
  const settings = useWorkstationSettings();
  const { order, dueAt } = target;
  const [status, setStatus] = useState<MedAdminStatus>("given");
  const [dose, setDose] = useState(order.dose !== null ? String(order.dose) : "");
  const [unit, setUnit] = useState(order.dose_unit || "");
  const [time, setTime] = useState(() => timestampToWallClockInput(Date.now(), settings.timezone));
  const [site, setSite] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pinStep, setPinStep] = useState<MarEntry | null>(null);

  const entry = (): MarEntry => ({
    order_id: order.id, due_at: dueAt, status, dose: dose ? Number(dose) : null, dose_unit: unit || null, route: order.route,
    site: site || null, note: note || null,
    ...(status === "given" ? { given_at: wallClockInputToTimestamp(time, settings.timezone) ?? Date.now() } : {}),
  });
  const submit = async () => {
    const value = entry();
    if (status === "given" && needsAdminApproval(order.approval_required)) { setPinStep(value); return; }
    setBusy(true);
    setError("");
    try { await recordMar(caseId, value); onDone(); } catch (err) { setError(errorText(err, language)); setBusy(false); }
  };
  const options: [MedAdminStatus, string][] = target.infusion ? [["given", L.startInfusion]]
    : [["given", L.give], ["held", L.holdDose], ["refused", L.refuse], ["not_given", L.notGiven], ...(dueAt !== null ? [["missed", L.missed] as [MedAdminStatus, string]] : [])];
  return <>
    <Modal title={`${target.infusion ? L.startInfusion : L.record}: ${order.drug_name}`}>
      <div className="mt-1 text-sm text-[var(--app-muted)]">
        {[doseText(order), scheduleText(order, L), dueAt !== null ? `${L.slotStatus.due} ${formatConfiguredDateTime(dueAt, settings)}` : ""].filter(Boolean).join(" · ")}
      </div>
      {!order.item_id && <div className="mt-1 text-xs text-amber-700">{L.noDrugItem}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map(([key, text]) => <button key={key} type="button" className={status === key ? primary : button} onClick={() => setStatus(key)}>{text}</button>)}
      </div>
      {status === "given" && <div className="mt-3 grid grid-cols-2 gap-2">
        <label className={label}>{L.dose}<input className={`${field} mt-1`} inputMode="decimal" value={dose} onChange={event => setDose(event.target.value)} /></label>
        <label className={label}>{L.unit}<input className={`${field} mt-1`} value={unit} onChange={event => setUnit(event.target.value)} /></label>
        <label className={label}>{L.givenAt}<input type="datetime-local" className={`${field} mt-1`} value={time} onChange={event => setTime(event.target.value)} /></label>
        <label className={label}>{L.site}<input className={`${field} mt-1`} value={site} onChange={event => setSite(event.target.value)} /></label>
      </div>}
      <label className={`${label} mt-2`}>{L.note}<input className={`${field} mt-1`} value={note} onChange={event => setNote(event.target.value)} /></label>
      {status === "given" && needsAdminApproval(order.approval_required) && <div className="mt-2 text-xs text-amber-700">🔒 {L.approveDose}</div>}
      {error && <div className="mt-3 text-sm text-[var(--app-danger)]">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={button} onClick={onClose} disabled={busy}>{L.cancel}</button>
        <button type="button" className={primary} onClick={submit} disabled={busy}>{busy ? L.saving : L.record}</button>
      </div>
    </Modal>
    {pinStep && <PinApprovalDialog caseId={caseId} title={L.approveDose} detail={`${order.drug_name} ${pinStep.dose ?? ""} ${pinStep.dose_unit || ""} ${order.route || ""}`}
      onClose={() => setPinStep(null)} onApprove={async approval => { await recordMar(caseId, { ...pinStep, approval }); setPinStep(null); onDone(); }} />}
  </>;
}

function AdminDialog({ caseId, order, admin, L, canChart, onClose, onDone }: {
  caseId: number; order: MarOrder; admin: MedAdmin; L: Text; canChart: boolean; onClose: () => void; onDone: () => void;
}) {
  const settings = useWorkstationSettings();
  const [voiding, setVoiding] = useState(false);
  const approval = order.approvals.find(a => a.admin_id === admin.id);
  if (voiding) return <ReasonDialog title={`${L.voidRecord}: ${order.drug_name}`} L={L} onClose={() => setVoiding(false)}
    onSubmit={reason => voidMar(caseId, admin.id, reason).then(onDone)} />;
  return <Modal title={order.drug_name}>
    <dl className="mt-3 grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-[var(--app-muted)]">Status</dt><dd className="font-semibold">{L.slotStatus[admin.status]}</dd>
      {admin.due_at !== null && <><dt className="text-[var(--app-muted)]">{L.slotStatus.due}</dt><dd>{formatConfiguredDateTime(admin.due_at, settings)}</dd></>}
      {admin.given_at !== null && <><dt className="text-[var(--app-muted)]">{L.givenAt}</dt><dd>{formatConfiguredDateTime(admin.given_at, settings)}</dd></>}
      {admin.dose !== null && <><dt className="text-[var(--app-muted)]">{L.dose}</dt><dd>{admin.dose} {admin.dose_unit || ""} {admin.route || ""}</dd></>}
      {admin.site && <><dt className="text-[var(--app-muted)]">{L.site}</dt><dd>{admin.site}</dd></>}
      {admin.note && <><dt className="text-[var(--app-muted)]">{L.note}</dt><dd>{admin.note}</dd></>}
      <dt className="text-[var(--app-muted)]">{L.recorded}</dt><dd>{admin.recorded_by} · {formatConfiguredDateTime(admin.recorded_at, settings)}</dd>
      {approval && <><dt className="text-[var(--app-muted)]">🔒 {L.approvalRule}</dt><dd>{approval.approver_name} ({approval.approver_role})</dd></>}
    </dl>
    <div className="mt-4 flex justify-between gap-2">
      {canChart ? <button type="button" className={`${button} text-rose-500`} onClick={() => setVoiding(true)}>{L.voidRecord}</button> : <span />}
      <button type="button" className={button} onClick={onClose}>{L.close}</button>
    </div>
  </Modal>;
}
