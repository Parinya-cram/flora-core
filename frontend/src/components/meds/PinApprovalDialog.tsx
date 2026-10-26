import { useEffect, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { getMedApprovers, MedApiError, type MedApprover, type PinApproval } from "../../api/medOrdersApi";
import { pinErrorText } from "./pinErrors";

/**
 * Doctor PIN confirmation for high-alert drugs (app/staff_pin.py): the case owner, or a doctor at least as senior,
 * picks their name and enters their own staff PIN. `onApprove` sends the PIN with the action it confirms
 * (approve an order, or give a dose in the same request); errors from the server are shown here.
 */

const TEXT = {
  en: {
    approver: "Approving doctor", choose: "Choose…", pin: "Staff PIN", confirm: "Confirm", confirming: "Checking…",
    cancel: "Cancel", clear: "Clear", owner: "case owner", noPin: "no PIN", locked: "locked", none: "No eligible doctor on this ward has a PIN.",
    hint: "The case owner or a doctor of the same or higher level confirms with their own PIN.",
  },
  th: {
    approver: "แพทย์ผู้อนุมัติ", choose: "เลือก…", pin: "รหัส PIN", confirm: "ยืนยัน", confirming: "กำลังตรวจสอบ…",
    cancel: "ยกเลิก", clear: "ล้าง", owner: "แพทย์เจ้าของเคส", noPin: "ยังไม่ตั้ง PIN", locked: "ถูกล็อก", none: "ไม่มีแพทย์ที่มีสิทธิ์และตั้ง PIN ไว้",
    hint: "แพทย์เจ้าของเคส หรือแพทย์ระดับเดียวกันขึ้นไป ยืนยันด้วย PIN ของตนเอง",
  },
};

export function PinPad({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const key = "h-14 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] text-xl font-bold active:bg-[var(--app-control-bg-hover)] disabled:opacity-50";
  const press = (digit: string) => { if (value.length < 6) onChange(value + digit); };
  return <div className="space-y-2">
    <div className="flex h-10 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)]" aria-label={L.pin}>
      {Array.from({ length: 6 }, (_, index) => <span key={index}
        className={`h-3 w-3 rounded-full ${index < value.length ? "bg-[var(--app-text)]" : "border border-[var(--app-muted)]"}`} />)}
    </div>
    <div className="grid grid-cols-3 gap-2 select-none">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(digit =>
        <button key={digit} type="button" className={key} disabled={disabled} onClick={() => press(digit)}>{digit}</button>)}
      <button type="button" className={`${key} text-sm`} disabled={disabled} onClick={() => onChange("")}>{L.clear}</button>
      <button type="button" className={key} disabled={disabled} onClick={() => press("0")}>0</button>
      <button type="button" className={`${key} text-sm`} disabled={disabled} onClick={() => onChange(value.slice(0, -1))} aria-label="Backspace">⌫</button>
    </div>
  </div>;
}

export default function PinApprovalDialog({ caseId, title, detail, onApprove, onClose }: {
  caseId: number;
  title: string;
  /** What is being confirmed, e.g. "Morphine 2 mg IV". */
  detail?: string;
  /** Sends the approval with its action; throw to show the server's error code. */
  onApprove: (approval: PinApproval) => Promise<void>;
  onClose: () => void;
}) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [approvers, setApprovers] = useState<MedApprover[] | null>(null);
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    getMedApprovers(caseId).then(result => {
      if (!alive) return;
      setApprovers(result.approvers);
      const usable = result.approvers.filter(a => a.has_pin && !a.locked);
      if (usable.length === 1) setCode(usable[0].staff_code);
    }).catch(err => { if (alive) { setApprovers([]); setError(pinErrorText(err, language)); } });
    return () => { alive = false; };
  }, [caseId, language]);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onApprove({ staff_code: code, pin });
    } catch (err) {
      setError(pinErrorText(err, language));
      setPin("");
      if (err instanceof MedApiError && err.message === "pin_locked") {
        setApprovers(list => list && list.map(a => a.staff_code === code ? { ...a, locked: true } : a));
      }
    } finally {
      setBusy(false);
    }
  };

  const usable = (approvers || []).filter(a => a.has_pin);
  return <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
    <div className="max-h-[92vh] w-full max-w-sm overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 shadow-2xl">
      <h3 className="text-lg font-bold">{title}</h3>
      {detail && <div className="mt-1 text-sm font-semibold">{detail}</div>}
      <p className="mt-1 text-xs text-[var(--app-muted)]">{L.hint}</p>
      <label className="mt-3 block text-xs font-semibold text-[var(--app-muted)]">{L.approver}
        <select className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm"
          value={code} onChange={event => { setCode(event.target.value); setPin(""); setError(""); }} disabled={busy}>
          <option value="">{L.choose}</option>
          {(approvers || []).map(a => <option key={a.staff_id} value={a.staff_code} disabled={!a.has_pin || a.locked}>
            {a.name} · {a.role || ""}{a.is_owner ? ` · ${L.owner}` : ""}{!a.has_pin ? ` (${L.noPin})` : a.locked ? ` (${L.locked})` : ""}
          </option>)}
        </select>
      </label>
      {approvers && !usable.length && <div className="mt-2 text-xs text-[var(--app-danger)]">{L.none}</div>}
      <div className="mt-3"><PinPad value={pin} onChange={value => { setPin(value); setError(""); }} disabled={busy || !code} /></div>
      {error && <div className="mt-3 rounded-lg border border-[var(--app-danger)] px-3 py-2 text-sm text-[var(--app-danger)]" role="alert">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold"
          onClick={onClose} disabled={busy}>{L.cancel}</button>
        <button type="button" className="rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50"
          onClick={submit} disabled={busy || !code || pin.length < 4}>{busy ? L.confirming : L.confirm}</button>
      </div>
    </div>
  </div>;
}
