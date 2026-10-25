import type { ActiveCase } from "../../api/caseApi";
import type { GatewayDevice, RegisteredGateway, WardBed, WardBedDevice } from "../../api/wardApi";
import { useLanguage } from "../../context/LanguageContext";
import { bedMatches } from "./bedSession";

const TEXT = {
  en: {
    title: "Beds and sessions", hint: "One session per bed: the patient there and the bed's devices. Tap a bed to open its session.",
    free: "Free", start: "Start session", open: "Open session", started: "started", noDevices: "No devices placed at this bed",
    devices: "devices", bound: "bound", offline: "offline", otherLeaf: "set for another Leaf", noLink: "no link to its gateway",
    primary: "this workstation's bed", other: "Sessions without a bed",
  },
  th: {
    title: "เตียงและ session", hint: "หนึ่งเตียงมีหนึ่ง session คือผู้ป่วยที่เตียงนั้นกับอุปกรณ์ของเตียง แตะที่เตียงเพื่อเข้า session",
    free: "ว่าง", start: "เริ่ม session", open: "เข้า session", started: "เริ่ม", noDevices: "ยังไม่มีอุปกรณ์ประจำเตียงนี้",
    devices: "อุปกรณ์", bound: "เชื่อมแล้ว", offline: "ออฟไลน์", otherLeaf: "ถูกตั้งให้ Leaf อื่น", noLink: "ยังไม่ได้เชื่อม Gateway นี้",
    primary: "เตียงหลักของเครื่องนี้", other: "Session ที่ยังไม่ระบุเตียง",
  },
};

type Props = {
  beds: WardBed[];
  cases: ActiveCase[];
  gateways: RegisteredGateway[];
  /** Gateway ids this Leaf has a link to (stream / data-api). */
  linkedGateways: ReadonlySet<string>;
  leafId: string;
  openCaseId?: number | null;
  canStart: boolean;
  onOpen: (caseId: number) => void;
  onStart: (bed: WardBed) => void;
};

const since = (ms: number) => {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d`;
};

/** The Leaf's beds as a board: a free bed starts a session there, an occupied bed opens its session. */
export default function BedBoard({ beds, cases, gateways, linkedGateways, leafId, openCaseId, canStart, onOpen, onStart }: Props) {
  const { language } = useLanguage();
  const L = TEXT[language === "th" ? "th" : "en"];
  const placed = new Set<number>();
  const caseOf = (bed: WardBed) => {
    const found = cases.find(item => !placed.has(item.case_id) && bedMatches(bed, item.bed_label));
    if (found) placed.add(found.case_id);
    return found;
  };
  const occupant = new Map(beds.map(bed => [bed.bed_location_id, caseOf(bed)]));
  const loose = cases.filter(item => !placed.has(item.case_id));
  const device = (wanted: WardBedDevice): { info?: GatewayDevice; online: boolean; problem?: string } => {
    const gateway = gateways.find(item => item.gateway_id === wanted.gateway_id);
    const info = gateway?.devices.find(item => item.device_id === wanted.device_id);
    const online = Boolean(gateway?.online) && (info?.parser_status ? info.parser_status === "running" : true);
    const problem = !linkedGateways.has(wanted.gateway_id) ? L.noLink
      : info?.leaf_id && info.leaf_id !== leafId ? L.otherLeaf : !online ? L.offline : undefined;
    return { info, online, problem };
  };

  return <section className="space-y-3">
    <div>
      <h2 className="text-lg font-extrabold text-[var(--app-text)]">{L.title}</h2>
      <p className="text-xs text-[var(--app-muted)]">{L.hint}</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
      {beds.map(bed => {
        const item = occupant.get(bed.bed_location_id);
        const open = item && item.case_id === openCaseId;
        const bound = item ? item.devices.filter(binding => !binding.released_at).length : 0;
        const act = () => (item ? onOpen(item.case_id) : canStart ? onStart(bed) : undefined);
        return <article key={bed.bed_location_id} role="button" tabIndex={0} onClick={act}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); act(); } }}
          aria-label={`${bed.bed_name}: ${item ? item.patient_name || item.hn : L.free}`}
          className={`flex min-h-36 cursor-pointer flex-col gap-2 rounded-2xl border p-3 text-left transition hover:border-[var(--app-accent)]
            ${item ? "border-[var(--app-border)] bg-[var(--app-panel-bg)]" : "border-dashed border-[var(--app-border)] bg-[var(--app-control-bg)]"}
            ${open ? "ring-2 ring-[var(--app-accent)]" : ""}`}>
          <header className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-9 min-w-9 items-center justify-center rounded-xl px-2 text-sm font-extrabold
                  ${item ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-accent)]/12 text-[var(--app-accent)]"}`}>{bed.bed_name}</span>
                <span className="truncate text-xs text-[var(--app-muted)]">{bed.room_name || ""}{bed.is_primary ? ` · ${L.primary}` : ""}</span>
              </div>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${item ? "bg-emerald-500/12 text-emerald-600" : "text-[var(--app-muted)]"}`}>
              {item ? `${L.started} ${since(item.start_time)}` : L.free}
            </span>
          </header>
          {item ? <div className="min-w-0">
            <div className="truncate text-base font-bold text-[var(--app-text)]">{item.patient_name || `HN ${item.hn}`}</div>
            <div className="text-xs text-[var(--app-muted)]">HN {item.hn}{item.admission_number ? ` · AN ${item.admission_number}` : ""}
              {bed.devices.length || bound ? ` · ${bound} ${L.devices} ${L.bound}` : ""}</div>
          </div> : null}
          {bed.devices.length ? <ul className="flex flex-wrap gap-1.5">
            {bed.devices.map(wanted => {
              const state = device(wanted);
              return <li key={`${wanted.gateway_id}/${wanted.device_id}`} title={state.problem || wanted.device_type || ""}
                className="flex items-center gap-1 rounded-lg border border-[var(--app-border)] px-1.5 py-0.5 text-[11px]">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: state.problem ? (state.online ? "#d97706" : "#e24b4a") : "#1d9e75" }} />
                {wanted.label || wanted.device_id}{state.problem ? <span className="text-[var(--app-muted)]">· {state.problem}</span> : null}
              </li>;
            })}
          </ul> : <div className="text-[11px] text-[var(--app-muted)]">{L.noDevices}</div>}
          <div className="mt-auto flex justify-end">
            {item ? <span className="rounded-lg border border-[var(--app-accent)] px-3 py-1 text-xs font-bold text-[var(--app-accent)]">{L.open}</span>
              : canStart ? <span className="rounded-lg bg-[var(--app-accent)] px-3 py-1 text-xs font-bold text-[var(--app-accent-contrast)]">+ {L.start}</span> : null}
          </div>
        </article>;
      })}
    </div>
    {loose.length ? <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <b>{L.other}:</b>{" "}
      {loose.map(item => <button key={item.case_id} type="button" onClick={() => onOpen(item.case_id)}
        className="mr-2 underline decoration-dotted">{[item.bed_label, item.patient_name || `HN ${item.hn}`].filter(Boolean).join(" · ")}</button>)}
    </div> : null}
  </section>;
}
