import { useEffect, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import { getOwnPinState, setOwnPin } from "../../api/medOrdersApi";
import { PinPad } from "./PinApprovalDialog";
import { pinErrorText } from "./pinErrors";

/** "My PIN": the signed-in staff member sets or changes the PIN they use to approve high-alert drugs. */

const TEXT = {
  en: {
    title: "My approval PIN", hint: "4-6 digits. Used to confirm high-alert medication orders and doses.",
    current: "Current PIN", next: "New PIN", repeat: "Repeat the new PIN", save: "Save PIN", saving: "Saving…",
    back: "Back", nextStep: "Next", mismatch: "The PINs do not match.", saved: "PIN saved.", isSet: "A PIN is set.",
    notSet: "No PIN yet.", unlinked: "Your account is not linked to a staff directory entry.", close: "Close",
  },
  th: {
    title: "PIN อนุมัติของฉัน", hint: "ตัวเลข 4-6 หลัก ใช้ยืนยันคำสั่งยาและการให้ยาที่มีความเสี่ยงสูง",
    current: "PIN ปัจจุบัน", next: "PIN ใหม่", repeat: "ใส่ PIN ใหม่อีกครั้ง", save: "บันทึก PIN", saving: "กำลังบันทึก…",
    back: "ย้อนกลับ", nextStep: "ถัดไป", mismatch: "PIN ไม่ตรงกัน", saved: "บันทึก PIN แล้ว", isSet: "ตั้ง PIN แล้ว",
    notSet: "ยังไม่ได้ตั้ง PIN", unlinked: "บัญชีนี้ยังไม่ได้เชื่อมกับรายชื่อบุคลากร", close: "ปิด",
  },
};

type Step = "current" | "next" | "repeat";

export default function StaffPinSetter({ onClose }: { onClose?: () => void }) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [state, setState] = useState<{ linked: boolean; pin_set: boolean } | null>(null);
  const [step, setStep] = useState<Step>("next");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    getOwnPinState().then(result => {
      if (!alive) return;
      setState(result);
      setStep(result.pin_set ? "current" : "next");
    }).catch(err => { if (alive) setError(pinErrorText(err, language)); });
    return () => { alive = false; };
  }, [language]);

  const save = async () => {
    if (next !== repeat) { setError(L.mismatch); setRepeat(""); return; }
    setBusy(true);
    setError("");
    try {
      await setOwnPin(next, state?.pin_set ? current : undefined);
      setMessage(L.saved);
      setState({ linked: true, pin_set: true });
      setCurrent(""); setNext(""); setRepeat(""); setStep("current");
    } catch (err) {
      setError(pinErrorText(err, language));
      setCurrent(""); setNext(""); setRepeat(""); setStep(state?.pin_set ? "current" : "next");
    } finally {
      setBusy(false);
    }
  };

  const value = step === "current" ? current : step === "next" ? next : repeat;
  const setValue = step === "current" ? setCurrent : step === "next" ? setNext : setRepeat;
  const label = step === "current" ? L.current : step === "next" ? L.next : L.repeat;
  const advance = () => {
    setError(""); setMessage("");
    if (step === "current") setStep("next");
    else if (step === "next") setStep("repeat");
    else void save();
  };
  const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold disabled:opacity-50";

  return <div className="w-full max-w-xs space-y-3">
    <div>
      <div className="text-sm font-bold">{L.title}</div>
      <div className="text-xs text-[var(--app-muted)]">{L.hint}</div>
      {state && <div className="mt-1 text-xs">{!state.linked ? L.unlinked : state.pin_set ? L.isSet : L.notSet}</div>}
    </div>
    {state?.linked && <>
      <div className="text-xs font-semibold text-[var(--app-muted)]">{label}</div>
      <PinPad value={value} onChange={v => { setValue(v); setError(""); }} disabled={busy} />
      {error && <div className="text-sm text-[var(--app-danger)]" role="alert">{error}</div>}
      {message && <div className="text-sm text-[var(--app-accent)]">{message}</div>}
      <div className="flex justify-end gap-2">
        {onClose && <button type="button" className={button} onClick={onClose} disabled={busy}>{L.close}</button>}
        {step !== (state.pin_set ? "current" : "next") &&
          <button type="button" className={button} disabled={busy} onClick={() => setStep(step === "repeat" ? "next" : "current")}>{L.back}</button>}
        <button type="button" disabled={busy || value.length < 4} onClick={advance}
          className="rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">
          {step === "repeat" ? (busy ? L.saving : L.save) : L.nextStep}
        </button>
      </div>
    </>}
  </div>;
}
