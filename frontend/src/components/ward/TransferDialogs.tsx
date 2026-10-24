import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import type { ActiveCase, DeviceBindingInput } from "../../api/caseApi";
import {
  getTransferTargets, moveCaseBed, receiveTransfer, transferCase,
  type TransferBed, type WardTransfer,
} from "../../api/wardApi";
import { DeviceBindingPicker } from "../case/CaseDevicesPanel";

/**
 * Transfer without discharge (app/case_transfer.py): the case moves to another bed and its chart continues.
 * A bed of this workstation moves at once; a bed of another workstation waits there for Receive.
 * Discharge stays the way to leave for real (a new case elsewhere, or out of the ward).
 */

const TEXT = {
  en: {
    title: "Transfer", hint: "Move the patient to another bed without discharging. The chart continues.",
    thisLeaf: "this workstation", busy: "occupied", choose: "Choose a bed", other: "Another bed on this workstation",
    otherHint: "Bed name, e.g. R2", note: "Note (optional)", offline: "Canopy is unreachable: only a bed on this workstation can be chosen.",
    current: "current bed", send: "Transfer", move: "Move bed", sending: "Moving…", cancel: "Cancel",
    waitsThere: "The case stays open here until the destination presses Receive; this bed's devices are released now.",
    receiveTitle: "Receive transfer", from: "From", bed: "Bed on this workstation", devices: "Devices of this bed",
    devicesHint: "Pick the monitors at the new bed. The previous bed's devices are not carried over.",
    receive: "Receive", receiving: "Receiving…", deviceInUse: "A chosen device is already bound to another case.",
    noBeds: "No beds of this ward are known to Canopy.",
  },
  th: {
    title: "ย้ายเตียง (Transfer)", hint: "ย้ายผู้ป่วยไปเตียงอื่นโดยไม่ต้อง discharge chart ต่อเนื่อง",
    thisLeaf: "เครื่องนี้", busy: "มีผู้ป่วย", choose: "เลือกเตียง", other: "เตียงอื่นบนเครื่องนี้",
    otherHint: "ชื่อเตียง เช่น R2", note: "หมายเหตุ (ถ้ามี)", offline: "เชื่อมต่อ Canopy ไม่ได้ — เลือกได้เฉพาะเตียงบนเครื่องนี้",
    current: "เตียงปัจจุบัน", send: "Transfer", move: "ย้ายเตียง", sending: "กำลังย้าย…", cancel: "ยกเลิก",
    waitsThere: "เคสยังเปิดอยู่ที่นี่จนกว่าปลายทางจะกด Receive และอุปกรณ์ของเตียงนี้จะถูกปล่อยทันที",
    receiveTitle: "รับ Transfer", from: "จาก", bed: "เตียงบนเครื่องนี้", devices: "อุปกรณ์ของเตียงนี้",
    devicesHint: "เลือก monitor ของเตียงใหม่ อุปกรณ์ของเตียงเดิมจะไม่ตามมา",
    receive: "Receive", receiving: "กำลังรับ…", deviceInUse: "อุปกรณ์ที่เลือกถูกผูกกับเคสอื่นอยู่แล้ว",
    noBeds: "Canopy ยังไม่มีข้อมูลเตียงของหอผู้ป่วยนี้",
  },
};

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--app-accent)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const field = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--app-accent)]";

function Modal({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
    <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 shadow-2xl">
      <h3 className="text-lg font-bold">{title}</h3>
      {children}
    </div>
  </div>;
}

const errorText = (err: unknown, L: (typeof TEXT)["en"]) => {
  const message = err instanceof Error ? err.message : String(err);
  return message === "device_in_use" ? L.deviceInUse : message;
};

export function TransferDialog({ item, leafId, onClose, onDone }: {
  item: ActiveCase; leafId: string; onClose: () => void; onDone: () => void;
}) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [beds, setBeds] = useState<TransferBed[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [chosen, setChosen] = useState<TransferBed | null>(null);
  const [manual, setManual] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    getTransferTargets().then(result => { if (alive) setBeds(result.beds); })
      .catch(() => { if (alive) { setBeds([]); setOffline(true); } });
    return () => { alive = false; };
  }, []);

  const current = (item.bed_label || "").trim().toLowerCase();
  const isCurrent = (bed: TransferBed) => bed.leaf_id === leafId && Boolean(current)
    && [bed.bed_name, bed.bed_code].some(name => (name || "").trim().toLowerCase() === current);
  const rooms = useMemo(() => {
    const grouped = new Map<string, TransferBed[]>();
    for (const bed of beds || []) grouped.set(bed.room_name || "—", [...(grouped.get(bed.room_name || "—") || []), bed]);
    return [...grouped.entries()];
  }, [beds]);
  const local = chosen ? chosen.leaf_id === leafId : Boolean(manual.trim());

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (chosen) await transferCase(item.case_id, chosen, note.trim() || undefined);
      else await moveCaseBed(item.case_id, manual.trim());
      onDone();
    } catch (err) {
      setError(errorText(err, L));
    } finally {
      setBusy(false);
    }
  };

  return <Modal title={L.title}>
    <div className="mt-1 text-sm">{[item.bed_label, item.patient_name, item.hn ? `HN ${item.hn}` : null].filter(Boolean).join(" · ")}</div>
    <p className="mt-1 text-xs text-[var(--app-muted)]">{L.hint}</p>
    {offline ? <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{L.offline}</div> : null}
    <div className="mt-3 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.choose}</div>
    {beds === null ? <div className="mt-2 text-sm text-[var(--app-muted)]">…</div> : null}
    {beds && !beds.length && !offline ? <div className="mt-2 text-sm text-[var(--app-muted)]">{L.noBeds}</div> : null}
    <div className="mt-2 space-y-3">
      {rooms.map(([room, list]) => <div key={room}>
        <div className="mb-1 text-xs font-semibold text-[var(--app-muted)]">{room}</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {list.map(bed => {
            const here = isCurrent(bed);
            const occupied = Boolean(bed.busy && bed.busy.hn !== item.hn);
            const selected = chosen?.bed_location_id === bed.bed_location_id;
            return <button key={bed.bed_location_id} type="button" disabled={here || occupied}
              onClick={() => { setChosen(bed); setManual(""); }}
              className={`rounded-xl border px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10" : "border-[var(--app-border)] hover:border-[var(--app-accent)]"}`}>
              <div className="font-bold">{bed.bed_name}</div>
              <div className="truncate text-[11px] text-[var(--app-muted)]">
                {here ? L.current : occupied ? `${L.busy} · HN ${bed.busy?.hn}` : bed.leaf_id === leafId ? L.thisLeaf : bed.leaf_name || bed.leaf_id}
              </div>
            </button>;
          })}
        </div>
      </div>)}
    </div>
    <label className="mt-3 block text-xs font-semibold text-[var(--app-muted)]">{L.other}
      <input className={`${field} mt-1`} value={manual} placeholder={L.otherHint} maxLength={60}
        onChange={event => { setManual(event.target.value); if (event.target.value) setChosen(null); }} />
    </label>
    {chosen && !local ? <>
      <label className="mt-3 block text-xs font-semibold text-[var(--app-muted)]">{L.note}
        <input className={`${field} mt-1`} value={note} maxLength={500} onChange={event => setNote(event.target.value)} />
      </label>
      <p className="mt-2 text-xs text-[var(--app-muted)]">{L.waitsThere}</p>
    </> : null}
    {error ? <div className="mt-3 text-sm text-rose-500">{error}</div> : null}
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" className={button} onClick={onClose} disabled={busy}>{L.cancel}</button>
      <button type="button" className={primary} disabled={busy || (!chosen && !manual.trim())} onClick={() => void submit()}>
        {busy ? L.sending : local ? L.move : L.send}
      </button>
    </div>
  </Modal>;
}

export function ReceiveTransferDialog({ transfer, onClose, onDone }: {
  transfer: WardTransfer; onClose: () => void; onDone: (caseId: number) => void;
}) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [bed, setBed] = useState(transfer.to_bed_label || "");
  const [devices, setDevices] = useState<DeviceBindingInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await receiveTransfer(transfer, bed.trim(), devices);
      onDone(result.case_id);
    } catch (err) {
      setError(errorText(err, L));
    } finally {
      setBusy(false);
    }
  };

  return <Modal title={L.receiveTitle}>
    <div className="mt-1 text-sm font-semibold">{transfer.patient_name || ""} HN {transfer.hn || "—"}</div>
    <div className="text-xs text-[var(--app-muted)]">
      {L.from} {[transfer.from_bed_label, transfer.from_leaf_name || transfer.from_leaf_id].filter(Boolean).join(" · ")}
      {transfer.requested_by ? ` · ${transfer.requested_by}` : ""}
    </div>
    {transfer.note ? <div className="mt-1 text-xs italic text-[var(--app-muted)]">{transfer.note}</div> : null}
    <label className="mt-3 block text-xs font-semibold text-[var(--app-muted)]">{L.bed}
      <input className={`${field} mt-1`} value={bed} maxLength={60} onChange={event => setBed(event.target.value)} />
    </label>
    <div className="mt-3 text-xs font-semibold text-[var(--app-muted)]">{L.devices}</div>
    <p className="text-[11px] text-[var(--app-muted)]">{L.devicesHint}</p>
    <div className="mt-2"><DeviceBindingPicker value={devices} onChange={setDevices} compact /></div>
    {error ? <div className="mt-3 text-sm text-rose-500">{error}</div> : null}
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" className={button} onClick={onClose} disabled={busy}>{L.cancel}</button>
      <button type="button" className={primary} disabled={busy} onClick={() => void submit()}>{busy ? L.receiving : L.receive}</button>
    </div>
  </Modal>;
}
