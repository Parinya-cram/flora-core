import { useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "../../context/LanguageContext";
import {
  deviceInUseMessage,
  getActiveCases,
  getCaseDevices,
  putCaseDevices,
  type CaseDeviceBinding,
  type DeviceBindingInput,
  type DeviceBindingMode,
} from "../../api/caseApi";
import { gatewayLinkLabel as linkLabel, getGatewayLinkDevices, getGatewayLinks, type GatewayDevice, type GatewayLink } from "../../api/wardApi";

/**
 * Per-case Gateway device binding (docs/live-stream/PROTOCOL.md):
 * - DeviceBindingPicker: controlled list of {gateway_link_id, device_id, mode}; used by the start flow.
 * - CaseDevicesDialog: loads/saves GET|PUT /api/case/{id}/devices and shows gateway + stream state.
 */

const TEXT = {
  en: {
    title: "Bedside devices for this case", gateway: "Gateway", noLinks: "No gateway is set up on this Leaf. Set one up in Ward › Bedside devices.",
    loadingDevices: "Loading devices…", noDevices: "This gateway reports no devices for this Leaf.", devicesFailed: "Cannot reach the gateway",
    exclusive: "Exclusive", shared: "Shared", exclusiveHint: "Only this case receives the device", sharedHint: "Other cases may also read it",
    inUseExclusive: "in use (exclusive) by", inUseShared: "shared with", online: "online", offline: "offline",
    selected: "Selected", none: "No devices — the case will use the Leaf's default device feed.", remove: "Remove",
    state: { pending: "Waiting for gateway", bound: "Bound", rejected: "Rejected" },
    stream: "Stream", connected: "connected", disconnected: "not streaming", lag: "lag", lastSecond: "last second",
    save: "Save", saving: "Saving…", saved: "Saved", cancel: "Cancel", close: "Close", reload: "Refresh",
    current: "Current bindings", otherLink: "other gateway",
  },
  th: {
    title: "อุปกรณ์ข้างเตียงของเคสนี้", gateway: "Gateway", noLinks: "ยังไม่ได้ตั้งค่า Gateway บนเครื่องนี้ ตั้งค่าได้ที่ หอผู้ป่วย › อุปกรณ์ข้างเตียง",
    loadingDevices: "กำลังโหลดอุปกรณ์…", noDevices: "Gateway นี้ไม่มีอุปกรณ์สำหรับเครื่องนี้", devicesFailed: "เชื่อมต่อ Gateway ไม่ได้",
    exclusive: "ใช้เฉพาะเคสนี้", shared: "ใช้ร่วม", exclusiveHint: "เคสนี้รับข้อมูลอุปกรณ์ได้เพียงเคสเดียว", sharedHint: "เคสอื่นอ่านข้อมูลร่วมได้",
    inUseExclusive: "ถูกใช้ (เฉพาะ) โดย", inUseShared: "ใช้ร่วมกับ", online: "ออนไลน์", offline: "ออฟไลน์",
    selected: "ที่เลือก", none: "ไม่ได้เลือกอุปกรณ์ — เคสจะใช้ข้อมูลอุปกรณ์ค่าเริ่มต้นของเครื่อง", remove: "เอาออก",
    state: { pending: "รอ Gateway ยืนยัน", bound: "ผูกแล้ว", rejected: "ถูกปฏิเสธ" },
    stream: "สตรีม", connected: "เชื่อมต่อ", disconnected: "ไม่มีสตรีม", lag: "ล่าช้า", lastSecond: "วินาทีล่าสุด",
    save: "บันทึก", saving: "กำลังบันทึก…", saved: "บันทึกแล้ว", cancel: "ยกเลิก", close: "ปิด", reload: "รีเฟรช",
    current: "การผูกอุปกรณ์ปัจจุบัน", otherLink: "Gateway อื่น",
  },
};

type Texts = typeof TEXT.en;

const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--app-accent)] disabled:opacity-50";
const primary = "rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";

const bindingKey = (linkId: number, deviceId: string) => `${linkId}:${deviceId}`;


type OtherUse = { mode: DeviceBindingMode; who: string };

/** Who else on this Leaf holds each device (from GET /api/case/active). */
function useOtherCaseUse(excludeCaseId: number | null) {
  const [uses, setUses] = useState<Map<string, OtherUse[]>>(new Map());
  useEffect(() => {
    let alive = true;
    void getActiveCases().then(cases => {
      if (!alive || !cases) return;
      const next = new Map<string, OtherUse[]>();
      for (const item of cases) {
        if (item.case_id === excludeCaseId) continue;
        const who = [item.bed_label, item.patient_name || (item.hn ? `HN ${item.hn}` : `#${item.case_id}`)].filter(Boolean).join(" · ");
        for (const binding of item.devices) {
          if (binding.released_at) continue;
          const key = bindingKey(binding.gateway_link_id, binding.device_id);
          next.set(key, [...(next.get(key) || []), { mode: binding.mode, who }]);
        }
      }
      setUses(next);
    }).catch(() => {});
    return () => { alive = false; };
  }, [excludeCaseId]);
  return uses;
}

type PickerProps = {
  value: DeviceBindingInput[];
  onChange: (next: DeviceBindingInput[]) => void;
  /** The case being edited (its own bindings are not "in use by another case"). */
  caseId?: number | null;
  disabled?: boolean;
  compact?: boolean;
};

export function DeviceBindingPicker({ value, onChange, caseId = null, disabled = false, compact = false }: PickerProps) {
  const { language } = useLanguage();
  const L: Texts = TEXT[language === "th" ? "th" : "en"];
  const [links, setLinks] = useState<GatewayLink[] | null>(null);
  const [linksError, setLinksError] = useState("");
  const [linkId, setLinkId] = useState<number | null>(null);
  const [devices, setDevices] = useState<GatewayDevice[]>([]);
  const [devicesState, setDevicesState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [devicesError, setDevicesError] = useState("");
  const otherUse = useOtherCaseUse(caseId);

  useEffect(() => {
    let alive = true;
    void getGatewayLinks().then(rows => {
      if (!alive) return;
      setLinks(rows);
      setLinkId(current => current ?? (value[0]?.gateway_link_id ?? rows.find(row => row.is_default)?.id ?? rows[0]?.id ?? null));
    }).catch(err => {
      if (!alive) return;
      setLinks([]);
      setLinksError(err instanceof Error ? err.message : String(err));
    });
    return () => { alive = false; };
    // Only on mount: the first selection follows the initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDevices = useCallback(async (id: number) => {
    setDevicesState("loading");
    setDevicesError("");
    try {
      setDevices(await getGatewayLinkDevices(id));
      setDevicesState("ok");
    } catch (err) {
      setDevices([]);
      setDevicesState("error");
      setDevicesError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (linkId == null) return;
     
    void loadDevices(linkId);
  }, [linkId, loadDevices]);

  const selected = useMemo(() => new Map(value.map(item => [bindingKey(item.gateway_link_id, item.device_id), item])), [value]);
  const linkById = useMemo(() => new Map((links || []).map(link => [link.id, link])), [links]);

  const toggle = (device: GatewayDevice, checked: boolean, preferredMode: DeviceBindingMode) => {
    if (linkId == null) return;
    const key = bindingKey(linkId, device.device_id);
    if (checked) onChange([...value.filter(item => bindingKey(item.gateway_link_id, item.device_id) !== key), { gateway_link_id: linkId, device_id: device.device_id, mode: preferredMode }]);
    else onChange(value.filter(item => bindingKey(item.gateway_link_id, item.device_id) !== key));
  };
  const setMode = (item: DeviceBindingInput, mode: DeviceBindingMode) =>
    onChange(value.map(entry => (entry === item ? { ...entry, mode } : entry)));

  if (links === null) return <div className="text-xs text-[var(--app-muted)]">{L.loadingDevices}</div>;
  if (!links.length) return <div className="text-xs text-[var(--app-muted)]">{linksError ? `${L.noLinks} (${linksError})` : L.noLinks}</div>;

  const deviceLabel = (item: DeviceBindingInput) => {
    const device = item.gateway_link_id === linkId ? devices.find(row => row.device_id === item.device_id) : undefined;
    return device?.label || item.device_id;
  };
  const elsewhere = value.filter(item => item.gateway_link_id !== linkId);

  return <div className={`space-y-2 ${compact ? "text-xs" : "text-sm"}`}>
    {links.length > 1 ? <label className="flex items-center gap-2 text-xs font-semibold text-[var(--app-muted)]">
      {L.gateway}
      <select value={linkId ?? ""} disabled={disabled} onChange={event => setLinkId(Number(event.target.value))}
        className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs text-[var(--app-text)]">
        {links.map(link => <option key={link.id} value={link.id}>{linkLabel(link)}{link.is_default ? " ★" : ""}</option>)}
      </select>
    </label> : <div className="text-xs text-[var(--app-muted)]">{L.gateway}: <span className="font-semibold text-[var(--app-text)]">{linkLabel(links[0])}</span></div>}

    {devicesState === "loading" ? <div className="text-xs text-[var(--app-muted)]">{L.loadingDevices}</div> : null}
    {devicesState === "error" ? <div className="flex items-center gap-2 text-xs text-rose-500">{L.devicesFailed}: {devicesError}
      {linkId != null ? <button type="button" className={button} onClick={() => void loadDevices(linkId)}>{L.reload}</button> : null}</div> : null}
    {devicesState === "ok" && !devices.length ? <div className="text-xs text-[var(--app-muted)]">{L.noDevices}</div> : null}

    {devices.length ? <ul className="space-y-1">
      {devices.map(device => {
        const key = bindingKey(linkId ?? -1, device.device_id);
        const item = selected.get(key);
        const uses = otherUse.get(key) || [];
        const exclusiveElsewhere = uses.find(use => use.mode === "exclusive");
        const sharedElsewhere = uses.filter(use => use.mode === "shared");
        const blocked = Boolean(exclusiveElsewhere) && !item;
        const forcedShared = sharedElsewhere.length > 0;
        return <li key={device.device_id} className={`rounded-lg border px-2.5 py-1.5 ${item ? "border-[var(--app-accent)]" : "border-[var(--app-border)]"} ${blocked ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={Boolean(item)} disabled={disabled || blocked}
                onChange={event => toggle(device, event.target.checked, forcedShared ? "shared" : "exclusive")} />
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${device.is_online ? "bg-emerald-500" : "bg-gray-400"}`} title={device.is_online ? L.online : L.offline} />
              <span className="truncate font-semibold">{device.label || device.device_id}</span>
              <span className="truncate text-[11px] text-[var(--app-muted)]">{device.device_type}</span>
            </label>
            {item ? <div className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border)] text-[11px] font-bold" role="radiogroup">
              {(["exclusive", "shared"] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={item.mode === mode}
                disabled={disabled || (mode === "exclusive" && forcedShared)} title={mode === "exclusive" ? L.exclusiveHint : L.sharedHint}
                onClick={() => setMode(item, mode)}
                className={`px-2 py-0.5 disabled:opacity-40 ${item.mode === mode ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-control-bg)] text-[var(--app-text)]"}`}>
                {mode === "exclusive" ? L.exclusive : L.shared}
              </button>)}
            </div> : null}
          </div>
          {exclusiveElsewhere ? <div className="mt-0.5 text-[11px] text-rose-500">{L.inUseExclusive} {exclusiveElsewhere.who}</div>
            : sharedElsewhere.length ? <div className="mt-0.5 text-[11px] text-amber-600">{L.inUseShared} {sharedElsewhere.map(use => use.who).join(", ")}</div> : null}
        </li>;
      })}
    </ul> : null}

    {elsewhere.length ? <div className="flex flex-wrap gap-1.5">
      {elsewhere.map(item => <span key={bindingKey(item.gateway_link_id, item.device_id)} className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[11px]">
        {deviceLabel(item)} · {linkLabel(linkById.get(item.gateway_link_id)) || L.otherLink} · {item.mode === "shared" ? L.shared : L.exclusive}
        {!disabled ? <button type="button" aria-label={L.remove} className="text-[var(--app-muted)] hover:text-rose-500"
          onClick={() => onChange(value.filter(entry => entry !== item))}>×</button> : null}
      </span>)}
    </div> : null}

    {!value.length ? <div className="text-[11px] text-[var(--app-muted)]">{L.none}</div> : null}
  </div>;
}

export function BindingStateBadge({ binding }: { binding: CaseDeviceBinding }) {
  const { language } = useLanguage();
  const L: Texts = TEXT[language === "th" ? "th" : "en"];
  const tone = binding.gateway_state === "bound"
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
    : binding.gateway_state === "rejected"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-500"
      : "border-amber-500/40 bg-amber-500/10 text-amber-600";
  return <span title={binding.gateway_detail || undefined} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}>
    {L.state[binding.gateway_state]}
  </span>;
}

type DialogProps = {
  caseId: number;
  /** Shown in the title (bed / patient). */
  caseLabel?: string;
  canEdit?: boolean;
  onClose: () => void;
  onSaved?: (bindings: CaseDeviceBinding[]) => void;
};

export function CaseDevicesDialog({ caseId, caseLabel, canEdit = true, onClose, onSaved }: DialogProps) {
  const { language } = useLanguage();
  const L: Texts = TEXT[language === "th" ? "th" : "en"];
  const [bindings, setBindings] = useState<CaseDeviceBinding[] | null>(null);
  const [draft, setDraft] = useState<DeviceBindingInput[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [links, setLinks] = useState<GatewayLink[]>([]);

  const load = useCallback(async (resetDraft: boolean) => {
    try {
      const rows = await getCaseDevices(caseId);
      setBindings(rows);
      if (resetDraft) {
        setDraft(rows.filter(row => !row.released_at).map(row => ({ gateway_link_id: row.gateway_link_id, device_id: row.device_id, mode: row.mode })));
        setDirty(false);
      }
    } catch (err) {
      setBindings(current => current ?? []);
      setMessage({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [caseId]);

  useEffect(() => {
     
    void load(true);
    void getGatewayLinks().then(setLinks).catch(() => {});
  }, [load]);

  // Gateway state (pending → bound/rejected) and stream health change on their own; keep them fresh.
  useEffect(() => {
    const timer = window.setInterval(() => void load(false), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const rows = await putCaseDevices(caseId, draft);
      setBindings(rows);
      setDirty(false);
      setMessage({ tone: "ok", text: L.saved });
      onSaved?.(rows);
    } catch (err) {
      setMessage({ tone: "error", text: deviceInUseMessage(err, language) || (err instanceof Error ? err.message : String(err)) });
    } finally {
      setBusy(false);
    }
  };

  const linkById = new Map(links.map(link => [link.id, link]));
  const open = (bindings || []).filter(row => !row.released_at);

  return <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={L.title}>
    <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl">
      <header className="border-b border-[var(--app-border)] px-5 py-4">
        <h3 className="text-lg font-bold">{L.title}</h3>
        {caseLabel ? <div className="text-sm text-[var(--app-muted)]">{caseLabel}</div> : null}
      </header>
      <div className="min-h-[200px] flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
        <section>
          <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.current}</div>
          {bindings === null ? <div className="text-xs text-[var(--app-muted)]">…</div> : open.length ? <ul className="space-y-1.5">
            {open.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 py-2">
              <span className="font-semibold">{row.device_id}</span>
              <span className="text-xs text-[var(--app-muted)]">{linkLabel(linkById.get(row.gateway_link_id))} · {row.mode === "shared" ? L.shared : L.exclusive}</span>
              <BindingStateBadge binding={row} />
              <span className={`ml-auto text-[11px] ${row.stream?.connected ? "text-emerald-600" : "text-[var(--app-muted)]"}`}>
                {L.stream}: {row.stream?.connected ? L.connected : L.disconnected}
                {row.stream?.lag_ms != null ? ` · ${L.lag} ${(row.stream.lag_ms / 1000).toFixed(1)} s` : ""}
                {row.stream?.last_seq ? ` · ${L.lastSecond} ${new Date(row.stream.last_seq * 1000).toLocaleTimeString()}` : ""}
              </span>
              {row.gateway_state === "rejected" && row.gateway_detail ? <div className="w-full text-[11px] text-rose-500">{row.gateway_detail}</div> : null}
            </li>)}
          </ul> : <div className="text-xs text-[var(--app-muted)]">{L.none}</div>}
        </section>
        {canEdit ? <section>
          <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{L.selected}</div>
          {bindings !== null ? <DeviceBindingPicker caseId={caseId} value={draft} disabled={busy} onChange={next => { setDraft(next); setDirty(true); setMessage(null); }} /> : null}
        </section> : null}
        {message ? <div className={`rounded-xl border px-3 py-2 text-xs ${message.tone === "ok" ? "border-emerald-500/40 text-emerald-600" : "border-rose-500/40 bg-rose-500/10 text-rose-500"}`} role={message.tone === "error" ? "alert" : undefined}>{message.text}</div> : null}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-5 py-3">
        <button type="button" className={button} onClick={onClose} disabled={busy}>{dirty ? L.cancel : L.close}</button>
        {canEdit ? <button type="button" className={primary} onClick={() => void save()} disabled={busy || !dirty}>{busy ? L.saving : L.save}</button> : null}
      </footer>
    </div>
  </div>;
}
