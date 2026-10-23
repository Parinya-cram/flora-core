import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActiveCase, CaseStatus } from "../api/caseApi";
import type { AuthUser } from "../auth/useAuth";
import { useLanguage } from "../context/LanguageContext";
import {
  gatewayLinkLabel, getGatewayLinks, getWardOverview, requestWardSync, takeOverCase,
  type GatewayLink, type WardAdmission, type WardOverview, type WardPeer, type WardPeerCase,
} from "../api/wardApi";
import { deviceInUseMessage, moveInRecovery, startCase } from "../api/caseApi";
import GatewayWizard from "../components/ward/GatewayWizard";
import GatewayLinksDialog from "../components/ward/GatewayLinksDialog";
import { BindingStateBadge, CaseDevicesDialog } from "../components/case/CaseDevicesPanel";

type Props = {
  caseStatus: CaseStatus;
  /** Every active case on this Leaf (one per bed). */
  activeCases?: ActiveCase[];
  sessionUser: AuthUser | null;
  /** Opens a case (by id), or the chart of the open case. */
  onOpenCase: (caseId?: number) => void;
  /** Opens the start landing for one more case. */
  onNewCase: () => void;
  onCaseChanged: (caseId?: number) => Promise<void> | void;
};

type PeerCase = WardPeerCase & { bed_label?: string | null };

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
    moveIn: "Move in", waitingHere: "Waiting for this room", moveInRequested: "Move-in requested by", fromOr: "Transfer from the OR, for recovery", receiveTransfer: "Receive transfer",
    activeHere: "Active cases on this workstation", bed: "Bed", noBed: "No bed", opened: "Open now", newCase: "Start another case",
    caseDevices: "Devices", deviceCount: "devices", noBound: "default feed", gateways: "Gateway links", manageLinks: "Manage gateways",
    streaming: "stream", noToken: "no token", defaultLink: "default",
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
    moveIn: "ย้ายเข้าห้อง", waitingHere: "รอเข้าห้องนี้", moveInRequested: "สั่งย้ายเข้าโดย", fromOr: "รับย้าย (Transfer) จากห้องผ่าตัด รอเข้า recovery", receiveTransfer: "รับ Transfer เริ่มเคส Recovery",
    activeHere: "เคสที่กำลังทำบนเครื่องนี้", bed: "เตียง", noBed: "ไม่ระบุเตียง", opened: "เปิดอยู่", newCase: "เริ่มเคสใหม่อีกเคส",
    caseDevices: "อุปกรณ์", deviceCount: "อุปกรณ์", noBound: "ใช้ค่าเริ่มต้น", gateways: "Gateway ที่เชื่อมต่อ", manageLinks: "จัดการ Gateway",
    streaming: "สตรีม", noToken: "ไม่มี token", defaultLink: "ค่าเริ่มต้น",
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

export default function WardView({ caseStatus, activeCases, sessionUser, onOpenCase, onNewCase, onCaseChanged }: Props) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const [data, setData] = useState<WardOverview | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<WardPeer | null>(null);
  const [moveDevices, setMoveDevices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [links, setLinks] = useState<GatewayLink[] | null>(null);
  const [devicesFor, setDevicesFor] = useState<ActiveCase | null>(null);
  const permissions = sessionUser?.permissions || [];
  const canConfigure = permissions.includes("config.manage");
  const canStart = permissions.includes("case.create");

  const load = useCallback(async () => {
    try {
      const overview = await getWardOverview();
      setData(overview);
      setError("");
      if (overview.gateway_links) setLinks(overview.gateway_links);
      else void getGatewayLinks().then(setLinks).catch(() => setLinks(null));
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

  // OR schedule: the patient assigned to this bed enters the room; the case starts now.
  const moveIn = async (item: WardAdmission) => {
    setBusy(true);
    try {
      const started = item.orSession?.stage === "recovery"
        ? await moveInRecovery(item.id)
        : await startCase(item.hn || "", Date.now(), {
            admissionSource: "prepared", canopyAdmissionId: item.id, overlapPolicy: "exclude",
            bedLabel: item.orSession?.bed_name || undefined,
          });
      const caseId = Number((started as { case_id?: unknown } | null)?.case_id);
      await onCaseChanged(Number.isFinite(caseId) && caseId > 0 ? caseId : undefined);
    } catch (err) {
      setError(deviceInUseMessage(err, language) || (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const takeOver = async () => {
    if (!confirm?.active_case) return;
    setBusy(true);
    try {
      const result = await takeOverCase(confirm.active_case.global_case_id, moveDevices);
      setConfirm(null);
      await onCaseChanged(Number.isFinite(Number(result?.case_id)) ? Number(result.case_id) : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Several beds can run on one Leaf; prefer the live list from App, else the ward overview.
  const hereCases: ActiveCase[] = useMemo(() => activeCases?.length
    ? activeCases
    : (data?.cases || []).filter(item => item.status === "active").map(item => ({
        case_id: item.case_id, hn: item.hn, patient_name: item.patient_display_name, admission_number: item.admission_number,
        bed_label: item.bed_label, status: "ACTIVE" as const, start_time: item.start_time, devices: [],
      })), [activeCases, data]);
  const openCaseId = caseStatus.status !== "IDLE" ? caseStatus.case_id : null;
  const wardCaseById = useMemo(() => new Map((data?.cases || []).map(item => [item.case_id, item])), [data]);
  /** Peers report every active case when they run several beds. */
  const peerCases = (peer: WardPeer): PeerCase[] => peer.active_cases?.length ? peer.active_cases : peer.active_case ? [peer.active_case] : [];
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
        <Card title={L.activeHere} hint={L.thisLeaf} action={canStart ? <button type="button" className={hereCases.length ? button : primary} onClick={onNewCase}>{hereCases.length ? `+ ${L.newCase}` : L.startCase}</button> : null}>
          {hereCases.length ? <ul className="divide-y divide-[var(--app-border)]">
            {[...hereCases].sort((a, b) => String(a.bed_label || "~").localeCompare(String(b.bed_label || "~"), undefined, { numeric: true }) || a.start_time - b.start_time).map(item => {
              const ward = wardCaseById.get(item.case_id);
              const open = item.case_id === openCaseId;
              const bound = item.devices.filter(binding => !binding.released_at);
              return <li key={item.case_id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className={`inline-flex h-10 min-w-10 shrink-0 items-center justify-center rounded-xl px-2 text-sm font-extrabold ${item.bed_label ? "bg-[var(--app-accent)]/12 text-[var(--app-accent)]" : "border border-dashed border-[var(--app-border)] text-[10px] font-semibold text-[var(--app-muted)]"}`} title={L.bed}>
                  {item.bed_label || L.noBed}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{item.patient_name || ward?.patient_display_name || item.hn || `#${item.case_id}`}</div>
                  <div className="truncate text-xs text-[var(--app-muted)]">
                    {item.admission_number ? `AN ${item.admission_number} · ` : ""}HN {item.hn || "—"} · {L.started} {clock(item.start_time)}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--app-muted)]">
                    {bound.length ? bound.map(binding => <span key={binding.id} className="inline-flex items-center gap-1 rounded-md border border-[var(--app-border)] px-1.5 py-0.5">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${binding.stream?.connected ? "bg-emerald-500" : "bg-gray-400"}`} />
                      {binding.device_id}{binding.mode === "shared" ? " ⇄" : ""}
                      {binding.gateway_state !== "bound" ? <BindingStateBadge binding={binding} /> : null}
                    </span>) : <span>{L.caseDevices}: {L.noBound}</span>}
                  </div>
                  {ward?.handover_from_leaf_id ? <div className="text-xs text-[var(--app-accent)]">{L.from} {ward.handover_from_leaf_id}</div> : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" className={button} onClick={() => setDevicesFor(item)}>{L.caseDevices}</button>
                  <button type="button" className={open ? button : primary} onClick={() => onOpenCase(item.case_id)}>{open ? L.opened : L.openCase}</button>
                </div>
              </li>;
            })}
          </ul> : <div className="text-sm text-[var(--app-muted)]">{L.noCase}</div>}
        </Card>

        <Card title={L.prepared} hint={L.preparedHint}>
          {data?.admissions.length ? <ul className="divide-y divide-[var(--app-border)]">
            {data.admissions.map(item => <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-semibold">{item.patient?.patient_name || item.hn}</div>
                <div className="truncate text-xs text-[var(--app-muted)]">HN {item.hn}{item.admissionNumber ? ` · AN ${item.admissionNumber}` : ""}{item.admission?.operation ? ` · ${item.admission.operation}` : ""}</div>
                {item.orSession ? <div className="truncate text-xs font-semibold text-orange-600 dark:text-orange-300">
                  {item.orSession.stage === "recovery" ? L.fromOr : L.waitingHere}{item.orSession.bed_name ? ` · ${item.orSession.bed_name}` : ""}
                  {item.orSession.move_in_requested_at ? ` · ${L.moveInRequested} ${item.orSession.move_in_requested_by || "Canopy"}` : ""}
                </div> : null}
              </div>
              {canStart && item.orSession ? <button type="button" className={primary} disabled={busy} onClick={() => void moveIn(item)}>{item.orSession.stage === "recovery" ? L.receiveTransfer : L.moveIn}</button>
                : canStart ? <button type="button" className={button} onClick={onNewCase}>{L.startCase}</button> : null}
            </li>)}
          </ul> : <div className="text-sm text-[var(--app-muted)]">{L.none}</div>}
        </Card>

        <Card title={L.peers} hint={`${L.peersHint} · ${ago(sync?.ward_synced_at)}`}>
          {data?.peers.length ? <ul className="divide-y divide-[var(--app-border)]">
            {data.peers.map(peer => {
              const cases = peerCases(peer);
              return <li key={peer.leaf_id} className="py-2 text-sm">
                <div className="flex items-center gap-2 font-semibold">
                  <span className={`inline-block h-2 w-2 rounded-full ${peer.online ? "bg-emerald-500" : "bg-gray-400"}`} />
                  <span className="truncate">{peer.name}</span>
                  <span className="text-[11px] font-normal text-[var(--app-muted)]">{L.lastSeen} {ago(peer.last_seen)}</span>
                </div>
                {cases.length ? <ul className="mt-1 space-y-1 pl-4">
                  {cases.map(item => <li key={item.global_case_id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-xs text-[var(--app-muted)]">
                      {item.bed_label ? <b className="mr-1 text-[var(--app-text)]">{item.bed_label}</b> : null}
                      {`${item.patient_name || ""} HN ${item.hn}${item.admission_number ? ` · AN ${item.admission_number}` : ""}`}
                    </div>
                    {canStart ? <button type="button" className={button}
                      disabled={!item.export_revision}
                      title={!item.export_revision ? L.noCopy : ""}
                      onClick={() => { setMoveDevices(true); setConfirm({ ...peer, active_case: item }); }}>{L.takeOver}</button> : null}
                  </li>)}
                </ul> : <div className="truncate pl-4 text-xs text-[var(--app-muted)]">{L.noCaseShort}</div>}
              </li>;
            })}
          </ul> : <div className="text-sm text-[var(--app-muted)]">{L.none}</div>}
        </Card>

        <Card title={L.devices} action={canConfigure ? <div className="flex gap-2">
          {links ? <button type="button" className={button} onClick={() => setLinksOpen(true)}>{L.manageLinks}</button> : null}
          <button type="button" className={button} onClick={() => setWizardOpen(true)}>{L.setupGateway}</button>
        </div> : null}>
          {links?.length ? <ul className="mb-2 space-y-1 text-xs">
            {links.map(link => <li key={link.id} className="flex flex-wrap items-center gap-1.5 text-[var(--app-muted)]">
              <span className="font-semibold text-[var(--app-text)]">{gatewayLinkLabel(link)}</span>
              {link.is_default ? <span className="rounded-full border border-[var(--app-border)] px-1.5 text-[10px]">{L.defaultLink}</span> : null}
              {link.data_api_url ? <code>{link.data_api_url}</code> : null}
              {link.stream_url ? <span>· {L.streaming} <code>{link.stream_url}</code>{link.has_token ? "" : ` (${L.noToken})`}</span> : null}
            </li>)}
          </ul> : <div className="mb-2 text-xs text-[var(--app-muted)]">
            {data?.device_source ? <>{sourceGateway?.site_name || data.device_source.gateway_id || "Gateway"} · <code>{data.device_source.data_api_url}</code></> : L.noSource}
          </div>}
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
    {linksOpen && data ? <GatewayLinksDialog gateways={data.gateways} onClose={() => { setLinksOpen(false); void load(); }} /> : null}
    {devicesFor ? <CaseDevicesDialog caseId={devicesFor.case_id}
      caseLabel={[devicesFor.bed_label, devicesFor.patient_name, devicesFor.hn ? `HN ${devicesFor.hn}` : null].filter(Boolean).join(" · ")}
      canEdit={canStart || canConfigure}
      onClose={() => setDevicesFor(null)} /> : null}
  </main>;
}
