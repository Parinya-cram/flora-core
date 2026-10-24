import { useCallback, useEffect, useState } from "react";
import {
  getOrTransferOptions, requestOrTransfer, withdrawOrTransfer,
  type OrSession, type SessionTransferOptions,
} from "../../api/orScheduleApi";

/**
 * Ward desk › OR session › Transfer: move the patient's running case to another bed without discharging it
 * (room change, or another recovery bed). Another Leaf lists it under Incoming transfers and presses Receive;
 * a bed of the same multi-bed Leaf is moved by that Leaf at its next sync. The chart continues.
 */
export default function SessionTransfer({ session, busy, field, button, label, onChanged }: {
  session: OrSession; busy: boolean; field: string; button: string; label: string;
  onChanged: (row: OrSession) => void;
}) {
  const [options, setOptions] = useState<SessionTransferOptions | null>(null);
  const [bedId, setBedId] = useState<number | "">("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => getOrTransferOptions(session.id).then(setOptions).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))), [session.id]);
  useEffect(() => { void load(); }, [load, session.updatedAt]);

  const run = async (action: () => Promise<{ row: OrSession; warning?: string | null; kind?: string }>) => {
    setWorking(true); setError(""); setMessage("");
    try {
      const result = await action();
      onChanged(result.row);
      setMessage(result.warning || (result.kind === "bed_move" ? "Sent; the Leaf moves the case to this bed at its next sync."
        : result.kind === "transfer" ? "Sent; the destination Leaf lists the patient under Incoming transfers and presses Receive." : ""));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setWorking(false); }
  };

  const current = (options?.case?.bed_label || "").trim().toLowerCase();
  const beds = (options?.beds || []).filter(bed => !(bed.leaf_id === options?.case?.leaf_id && current
    && [bed.bed_name, bed.bed_code].some(name => (name || "").trim().toLowerCase() === current)));
  const chosen = bedId === "" ? beds.find(bed => !bed.busy)?.bed_location_id ?? "" : bedId;
  const pending = options?.pending;

  return <div className="space-y-1 border-t border-[var(--app-border)] pt-2">
    <div className={label}>Transfer (case continues, no discharge)</div>
    {pending ? <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>Waiting at <b>{pending.to_bed_label || pending.to_leaf_id}</b>{pending.kind === "bed_move" ? " (same Leaf)" : " — press Receive on that Leaf"}{pending.requested_by ? ` · ${pending.requested_by}` : ""}.</span>
      <button type="button" className={button} disabled={busy || working} onClick={() => void run(() => withdrawOrTransfer(session.id))}>Cancel transfer</button>
    </div> : !options?.case ? <p className="text-xs text-[var(--app-muted)]">{options ? "Canopy has not seen this patient's case yet; wait for the Leaf to sync." : "…"}</p> : <div className="flex flex-wrap gap-2">
      <select className={`${field} !w-auto`} value={chosen} onChange={e => setBedId(e.target.value ? Number(e.target.value) : "")} aria-label="Transfer to bed">
        {beds.map(bed => <option key={bed.bed_location_id} value={bed.bed_location_id} disabled={Boolean(bed.busy)}>
          {bed.room_name || "—"} · {bed.bed_name}{bed.leaf_id === options.case?.leaf_id ? " (same Leaf)" : ""}{bed.busy ? ` · busy (HN ${bed.busy.hn})` : ""}</option>)}
      </select>
      <button type="button" className={button} disabled={busy || working || chosen === ""}
        onClick={() => void run(() => requestOrTransfer(session.id, Number(chosen)))}>Transfer</button>
    </div>}
    {message ? <p className="text-xs text-[var(--app-muted)]">{message}</p> : null}
    {error ? <p className="text-xs text-rose-500">{error}</p> : null}
  </div>;
}
