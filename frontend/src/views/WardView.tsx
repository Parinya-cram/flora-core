import { useCallback, useEffect, useMemo, useState } from "react";
import type { CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import { useLanguage } from "../context/LanguageContext";
import { getWardOverview, requestWardSync, takeOverCase, type WardOverview, type WardPeer } from "../api/wardApi";
import GatewayWizard from "../components/ward/GatewayWizard";

type Props = {
  caseStatus: CaseStatus;
  sessionUser: AuthUser | null;
  onOpenCase: () => void;
  onCaseChanged: () => Promise<void> | void;
};

const TEXT = {
  en: {
    ward: "Ward", thisLeaf: "This workstation", noCase: "No active case on this workstation.", openCase: "Open case",
    startCase: "Start a case", prepared: "Prepared admissions", preparedHint: "From Canopy, kept on this Leaf",
    none: "None", peers: "Other beds in this ward", peersHint: "Last known from Canopy", takeOver: "Take over",
    devices: "Bedside devices", setupGateway: "Set up gateway", noSource: "No gateway set up; using the default device feed.",
    recent: "Recent cases on this Leaf", syncNow: "Sync now", syncing: "Syncing…", auto: "Auto-sync every", sec: "s",
    lastSync: "Last sync with Canopy", never: "never", offline: "Canopy unreachable — showing local data",
    started: "Started", handedTo: "Handed over to", from: "Continued from", noCaseShort: "No active case",
    lastSeen: "seen", confirmTitle: "Take over this case?", moveDevices: "Also move this bed's devices to this workstation",
    confirmBody: "Canopy moves the case here and the other workstation locks its copy when it next connects. Entries made there after its last sync are not included.",
    confirm: "Take over", cancel: "Cancel", copyAge: "Canopy copy is", old: "old", noCopy: "Canopy has no complete copy yet",
    busyHere: "Discharge the case on this workstation first",
  },
  th: {
    ward: "หอผู้ป่วย", thisLeaf: "เครื่องนี้", noCase: "ไม่มีเคสที่กำลังทำอยู่บนเครื่องนี้", openCase: "เปิดเคส",
    startCase: "เริ่มเคส", prepared: "ผู้ป่วยที่เตรียมรับ", preparedHint: "จาก Canopy เก็บไว้ในเครื่องนี้",
    none: "ไม่มี", peers: "เตียงอื่นในหอผู้ป่วย", peersHint: "ข้อมูลล่าสุดจาก Canopy", takeOver: "รับเคสมาทำต่อ",
    devices: "อุปกรณ์ข้างเตียง", setupGateway: "ตั้งค่า Gateway", noSource: "ยังไม่ได้ตั้งค่า Gateway ใช้ค่าเริ่มต้นของระบบ",
    recent: "เคสล่าสุดบนเครื่องนี้", syncNow: "Sync ตอนนี้", syncing: "กำลัง sync…", auto: "Sync อัตโนมัติทุก", sec: "วินาที",
    lastSync: "Sync กับ Canopy ล่าสุด", never: "ยังไม่เคย", offline: "เชื่อมต่อ Canopy ไม่ได้ — แสดงข้อมูลในเครื่อง",
    started: "เริ่ม", handedTo: "ส่งต่อให้", from: "รับต่อจาก", noCaseShort: "ไม่มีเคส",
    lastSeen: "ล่าสุด", confirmTitle: "รับเคสนี้มาทำต่อ?", moveDevices: "ย้ายอุปกรณ์ของเตียงนั้นมาที่เครื่องนี้ด้วย",
    confirmBody: "Canopy จะย้ายเคสมาที่เครื่องนี้ และเครื่องเดิมจะล็อกเคสเมื่อเชื่อมต่อครั้งถัดไป ข้อมูลที่บันทึกที่เครื่องเดิมหลัง sync ครั้งล่าสุดจะไม่ถูกนำมา",
    confirm: "รับเคส", cancel: "ยกเลิก", copyAge: "สำเนาใน Canopy อายุ", old: "", noCopy: "Canopy ยังไม่มีสำเนาเคสที่สมบูรณ์",
    busyHere: "ต้อง discharge เคสบนเครื่องนี้ก่อน",
  },
};

function ago(ms?: number | null) {
  if (!ms) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

function clock(ms?: number | null) {
  return ms ? new Date(ms).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
}

function Card({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{title}</h2>
        {hint ? <div className="mt-0.5 text-[11px] text-[var(--app-muted)]">{hint}</div> : null}
      </div>
      {action}
    </div>
    {children}
  </section>;
}

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--app-accent)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";

export default function WardView({ sessionUser, onOpenCase, onCaseChanged }: Props) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [data, setData] = useState<WardOverview | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<WardPeer | null>(null);
  const [moveDevices, setMoveDevices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const permissions = sessionUser?.permissions || [];
  const canConfigure = permissions.includes("config.manage");
  const canStart = permissions.includes("case.create");

  const load = useCallback(async () => {
    try {
      setData(await getWardOverview());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  // A requested sync is done once the ward state is newer than the request.
  useEffect(() => {
    if (syncing && data?.sync.ward_synced_at && data.sync.ward_synced_at >= syncing) setSyncing(null);
  }, [data, syncing]);

  const syncNow = async () => {
    try {
      const { requested_at } = await requestWardSync();
      setSyncing(requested_at);
      window.setTimeout(() => void load(), 1500);
      window.setTimeout(() => setSyncing(null), 30000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const takeOver = async () => {
    if (!confirm?.active_case) return;
    setBusy(true);
    try {
      await takeOverCase(confirm.active_case.global_case_id, moveDevices);
      setConfirm(null);
      await onCaseChanged();
      onOpenCase();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const activeCase = data?.cases.find(item => item.status === "active");
  const sync = data?.sync;
  const failing = (sync?.components || []).filter(item => item.last_error);
  const stale = !sync?.last_ok_at || Date.now() - sync.last_ok_at > Math.max(30, (sync.auto_interval_sec || 10) * 3) * 1000;
  const myDevices = useMemo(() => (data?.gateways || []).flatMap(gateway =>
    gateway.devices.filter(device => device.leaf_id === data?.leaf.id).map(device => ({ ...device, gateway: gateway.site_name }))), [data]);
  const sourceGateway = data?.gateways.find(gateway => gateway.gateway_id === data?.device_source?.gateway_id);
  const location = [data?.workstation.room_name, data?.workstation.bed_name].filter(Boolean).join(" · ");

  return <main className="min-h-full bg-[var(--app-bg)] px-4 py-4 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1180px] space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.ward}</div>
          <div className="truncate text-xl font-bold">{data?.ward.name || "—"}</div>
          <div className="text-sm text-[var(--app-muted)]">{location}{data?.leaf.id ? ` · ${data.leaf.id}` : ""}</div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className={`rounded-xl border px-3 py-2 ${stale ? "border-amber-500/50 text-amber-600" : failing.length ? "border-amber-500/40" : "border-emerald-500/40"}`}>
            <div className="font-semibold">{stale ? L.offline : `${L.lastSync}: ${ago(sync?.last_ok_at)}`}</div>
            <div className="text-[var(--app-muted)]">{L.auto} {sync?.auto_interval_sec ?? 10} {L.sec}
              {failing.length && !stale ? ` · ${failing.map(item => item.component).join(", ")} ⚠` : ""}</div>
          </div>
          <button type="button" className={primary} onClick={() => void syncNow()} disabled={Boolean(syncing)}>{syncing ? L.syncing : L.syncNow}</button>
        </div>
      </section>

      {error ? <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-500">{error}</div> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={L.thisLeaf}>
          {activeCase ? <div className="space-y-2">
            <div className="text-lg font-bold">{activeCase.patient_display_name || activeCase.hn}</div>
            <div className="text-sm text-[var(--app-muted)]">
              {activeCase.admission_number ? `AN ${activeCase.admission_number} · ` : ""}HN {activeCase.hn} · {L.started} {clock(activeCase.start_time)}
            </div>
            {activeCase.handover_from_leaf_id ? <div className="text-xs text-[var(--app-accent)]">{L.from} {activeCase.handover_from_leaf_id}</div> : null}
            <button type="button" className={primary} onClick={onOpenCase}>{L.openCase}</button>
          </div> : <div className="space-y-2">
            <div className="text-sm text-[var(--app-muted)]">{L.noCase}</div>
            {canStart ? <button type="button" className={primary} onClick={onOpenCase}>{L.startCase}</button> : null}
          </div>}
        </Card>

        <Card title={L.prepared} hint={L.preparedHint}>
          {data?.admissions.length ? <ul className="divide-y divide-[var(--app-border)]">
            {data.admissions.map(item => <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-semibold">{item.patient?.patient_name || item.hn}</div>
                <div className="truncate text-xs text-[var(--app-muted)]">HN {item.hn}{item.admissionNumber ? ` · AN ${item.admissionNumber}` : ""}{item.admission?.operation ? ` · ${item.admission.operation}` : ""}</div>
              </div>
              {!activeCase && canStart ? <button type="button" className={button} onClick={onOpenCase}>{L.startCase}</button> : null}
            </li>)}
          </ul> : <div className="text-sm text-[var(--app-muted)]">{L.none}</div>}
        </Card>

        <Card title={L.peers} hint={`${L.peersHint} · ${ago(sync?.ward_synced_at)}`}>
          {data?.peers.length ? <ul className="divide-y divide-[var(--app-border)]">
            {data.peers.map(peer => <li key={peer.leaf_id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-semibold">
                  <span className={`inline-block h-2 w-2 rounded-full ${peer.online ? "bg-emerald-500" : "bg-gray-400"}`} />
                  <span className="truncate">{peer.name}</span>
                  <span className="text-[11px] font-normal text-[var(--app-muted)]">{L.lastSeen} {ago(peer.last_seen)}</span>
                </div>
                <div className="truncate text-xs text-[var(--app-muted)]">
                  {peer.active_case ? `${peer.active_case.patient_name || ""} HN ${peer.active_case.hn}${peer.active_case.admission_number ? ` · AN ${peer.active_case.admission_number}` : ""}` : L.noCaseShort}
                </div>
              </div>
              {peer.active_case && canStart ? <button type="button" className={button}
                disabled={Boolean(activeCase) || !peer.active_case.export_revision}
                title={activeCase ? L.busyHere : !peer.active_case.export_revision ? L.noCopy : ""}
                onClick={() => { setMoveDevices(true); setConfirm(peer); }}>{L.takeOver}</button> : null}
            </li>)}
          </ul> : <div className="text-sm text-[var(--app-muted)]">{L.none}</div>}
        </Card>

        <Card title={L.devices} action={canConfigure ? <button type="button" className={button} onClick={() => setWizardOpen(true)}>{L.setupGateway}</button> : null}>
          <div className="mb-2 text-xs text-[var(--app-muted)]">
            {data?.device_source ? <>{sourceGateway?.site_name || data.device_source.gateway_id || "Gateway"} · <code>{data.device_source.data_api_url}</code></> : L.noSource}
          </div>
          {myDevices.length ? <ul className="flex flex-wrap gap-2">
            {myDevices.map(device => <li key={device.device_id} className="rounded-lg border border-[var(--app-border)] px-2 py-1 text-xs">
              {device.label || device.device_id} <span className="text-[var(--app-muted)]">· {device.device_type}</span>
            </li>)}
          </ul> : <div className="text-sm text-[var(--app-muted)]">{L.none}</div>}
        </Card>
      </div>

      <Card title={L.recent}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <tbody>
              {(data?.cases || []).map(item => <tr key={item.case_id} className="border-t border-[var(--app-border)]">
                <td className="py-2 pr-3 font-semibold">{item.patient_display_name || item.hn}</td>
                <td className="py-2 pr-3 text-[var(--app-muted)]">HN {item.hn}{item.admission_number ? ` · AN ${item.admission_number}` : ""}</td>
                <td className="py-2 pr-3">{clock(item.start_time)}</td>
                <td className="py-2 pr-3 text-xs">
                  {item.handover_to_leaf_id ? `${L.handedTo} ${item.handover_to_leaf_id}` : item.status}
                  {item.handover_from_leaf_id ? ` · ${L.from} ${item.handover_from_leaf_id}` : ""}
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </Card>
    </div>

    {confirm?.active_case ? <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 shadow-2xl">
        <h3 className="text-lg font-bold">{L.confirmTitle}</h3>
        <div className="mt-2 text-sm">{confirm.active_case.patient_name || ""} HN {confirm.active_case.hn} — {confirm.name}</div>
        <p className="mt-3 text-sm text-[var(--app-muted)]">{L.confirmBody}</p>
        <p className="mt-2 text-xs text-[var(--app-muted)]">{L.copyAge} {ago(confirm.active_case.export_revision)} {L.old}</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={moveDevices} onChange={event => setMoveDevices(event.target.checked)} />{L.moveDevices}
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={button} onClick={() => setConfirm(null)} disabled={busy}>{L.cancel}</button>
          <button type="button" className={primary} onClick={() => void takeOver()} disabled={busy}>{busy ? "…" : L.confirm}</button>
        </div>
      </div>
    </div> : null}

    {wizardOpen && data ? <GatewayWizard overview={data} onClose={() => { setWizardOpen(false); void load(); }} /> : null}
  </main>;
}
