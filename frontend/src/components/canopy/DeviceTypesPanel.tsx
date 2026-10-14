import { useCallback, useEffect, useState } from "react";
import {
  createDeviceType, deleteDeviceType, getDeviceTypes, updateDeviceType,
  type Controller, type DeviceTypeCatalog, type DeviceTypeFields, type HospitalDeviceType, type ReleaseDeviceType,
} from "../../api/deviceManagementApi";
import { CATEGORIES } from "./deviceManagementFormat";

// Canopy → Devices → Device types. Flora Root release types are read-only; the hospital adds its
// own types, which Haber delivers to every gateway at check-in (running the release's parsers).

type Spec = { key: string; label: string; kind: "number" | "bool" | "enum"; values?: (string | number)[] };
const CONNECTION_FIELDS: Record<Controller, Spec[]> = {
  serial: [
    { key: "baud", label: "Baud", kind: "enum", values: [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400] },
    { key: "data_bits", label: "Data bits", kind: "enum", values: [5, 6, 7, 8] },
    { key: "parity", label: "Parity", kind: "enum", values: ["none", "even", "odd"] },
    { key: "stop_bits", label: "Stop bits", kind: "enum", values: [1, 2] },
    { key: "flow_control", label: "Flow control", kind: "enum", values: ["none", "hardware", "software"] },
    { key: "rts", label: "RTS", kind: "bool" },
    { key: "dtr", label: "DTR", kind: "bool" },
    { key: "idle_ms", label: "Frame idle (ms)", kind: "number" },
    { key: "max_frame_bytes", label: "Max frame (bytes)", kind: "number" },
  ],
  socket: [
    { key: "transport", label: "Transport", kind: "enum", values: ["tcp", "udp"] },
    { key: "framing", label: "Framing", kind: "enum", values: ["mllp", "line", "idle", "raw", "udp_relay"] },
    { key: "auto_ack", label: "Auto ACK (HL7)", kind: "bool" },
    { key: "idle_ms", label: "Frame idle (ms)", kind: "number" },
    { key: "connect_timeout_ms", label: "Connect timeout (ms)", kind: "number" },
    { key: "read_timeout_ms", label: "Read timeout (ms)", kind: "number" },
    { key: "reconnect_ms", label: "Reconnect (ms)", kind: "number" },
    { key: "max_frame_bytes", label: "Max frame (bytes)", kind: "number" },
  ],
  feeder: [
    { key: "interval_ms", label: "Poll interval (ms)", kind: "number" },
    { key: "timeout_ms", label: "Timeout (ms)", kind: "number" },
  ],
  webhook: [{ key: "max_body_bytes", label: "Max body (bytes)", kind: "number" }],
};
const CONTROLLER_LABEL: Record<Controller, string> = {
  serial: "Serial (RS-232)", socket: "Socket (TCP/UDP, HL7 MLLP)", feeder: "Feeder (HTTP poll)", webhook: "Webhook (HTTP push)",
};

const input = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1.5 text-sm text-[var(--app-text)] disabled:opacity-70";
const button = "rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)] disabled:opacity-50";
const primary = "rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--app-accent-contrast)] hover:opacity-90 disabled:opacity-50";

type Draft = DeviceTypeFields & { code: string; optionsText: string };
const blank = (): Draft => ({
  code: "", label: "", category: "patient_monitor", manufacturer: null, model: null, description: null, protocol: "",
  controller: "socket", parser: "", default_options: {}, connection_defaults: {}, enabled: true, optionsText: "{}",
});
const draftOf = (type: HospitalDeviceType | ReleaseDeviceType, asNew: boolean): Draft => ({
  code: asNew ? "" : type.code, label: asNew ? `${type.label} (hospital)` : type.label, category: type.category || "device",
  manufacturer: type.manufacturer ?? null, model: type.model ?? null, description: type.description ?? null,
  protocol: type.protocol, controller: type.controller, parser: type.parser, default_options: type.default_options || {},
  connection_defaults: type.connection_defaults || {}, enabled: "enabled" in type ? type.enabled : true,
  optionsText: JSON.stringify(type.default_options || {}, null, 2),
});

function Editor({ draft, isNew, parsers, onCancel, onSaved }: {
  draft: Draft; isNew: boolean; parsers: string[]; onCancel: () => void; onSaved: () => void;
}) {
  const [value, setValue] = useState(draft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(key: K, next: Draft[K]) => setValue(current => ({ ...current, [key]: next }));
  const setConnection = (key: string, next: unknown) => setValue(current => {
    const connection = { ...current.connection_defaults };
    if (next === "" || next === undefined || next === null) delete connection[key]; else connection[key] = next;
    return { ...current, connection_defaults: connection };
  });

  const save = async () => {
    let options: Record<string, unknown>;
    try {
      options = JSON.parse(value.optionsText || "{}");
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error();
    } catch {
      setError("Default parser options must be a JSON object, e.g. {\"timezone\": \"Asia/Bangkok\"}.");
      return;
    }
    const allowed = new Set(CONNECTION_FIELDS[value.controller].map(field => field.key));
    const connection = Object.fromEntries(Object.entries(value.connection_defaults).filter(([key]) => allowed.has(key)));
    const { code, optionsText: _ignored, ...rest } = value;
    void _ignored;
    const body: DeviceTypeFields = { ...rest, default_options: options, connection_defaults: connection };
    setBusy(true);
    setError("");
    try {
      if (isNew) await createDeviceType({ ...body, code });
      else await updateDeviceType(code, body);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, node: React.ReactNode, wide = false) => (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">{label}</span>{node}
    </label>
  );
  return (
    <div className="fixed inset-0 z-[1100] flex justify-end bg-black/30" onClick={onCancel}>
      <aside role="dialog" aria-label="Device type" className="flex h-full w-full max-w-2xl flex-col bg-[var(--app-panel-bg)] shadow-2xl" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-5 py-4">
          <h2 className="text-lg font-semibold text-[var(--app-text)]">{isNew ? "New hospital device type" : `Edit ${value.code}`}</h2>
          <button className={button} onClick={onCancel}>Close</button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error && <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            {field("Code *", <input className={input} disabled={!isNew} value={value.code} placeholder="mindray-n12"
              onChange={event => set("code", event.target.value.toLowerCase().replace(/\s+/g, "-"))} />)}
            {field("Category", (
              <select className={input} value={value.category} onChange={event => set("category", event.target.value)}>
                {CATEGORIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                <option value="device">Other device</option>
              </select>
            ))}
            {field("Name *", <input className={input} value={value.label} onChange={event => set("label", event.target.value)} />, true)}
            {field("Manufacturer", <input className={input} value={value.manufacturer ?? ""} onChange={event => set("manufacturer", event.target.value || null)} />)}
            {field("Model", <input className={input} value={value.model ?? ""} onChange={event => set("model", event.target.value || null)} />)}
            {field("Controller *", (
              <select className={input} value={value.controller} onChange={event => set("controller", event.target.value as Controller)}>
                {(Object.keys(CONTROLLER_LABEL) as Controller[]).map(code => <option key={code} value={code}>{CONTROLLER_LABEL[code]}</option>)}
              </select>
            ))}
            {field("Parser *", (
              <select className={input} value={value.parser} onChange={event => set("parser", event.target.value)}>
                <option value="">Choose…</option>
                {parsers.map(parser => <option key={parser} value={parser}>{parser}</option>)}
              </select>
            ))}
            {field("Protocol *", <input className={input} value={value.protocol} placeholder="hl7v2" onChange={event => set("protocol", event.target.value)} />)}
            {field("Delivered to gateways", (
              <label className="flex items-center gap-2 py-1.5 text-sm text-[var(--app-text)]">
                <input type="checkbox" checked={value.enabled} onChange={event => set("enabled", event.target.checked)} /> Enabled
              </label>
            ))}
            {field("Description", <textarea className={`${input} min-h-16`} value={value.description ?? ""} onChange={event => set("description", event.target.value || null)} />, true)}
          </div>
          <section>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">Connection defaults · {CONTROLLER_LABEL[value.controller]}</h3>
            <p className="mb-2 text-xs text-[var(--app-muted)]">Empty fields use the gateway's defaults. Per-device addresses (COM port, IP, port) are set on each device at the gateway.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {CONNECTION_FIELDS[value.controller].map(spec => {
                const current = value.connection_defaults[spec.key];
                return field(spec.label, spec.kind === "number" ? (
                  <input type="number" className={input} value={current == null ? "" : String(current)}
                    onChange={event => setConnection(spec.key, event.target.value === "" ? "" : Number(event.target.value))} />
                ) : (
                  <select className={input} value={current == null ? "" : String(current)}
                    onChange={event => {
                      const raw = event.target.value;
                      if (raw === "") return setConnection(spec.key, "");
                      if (spec.kind === "bool") return setConnection(spec.key, raw === "true");
                      setConnection(spec.key, typeof spec.values?.[0] === "number" ? Number(raw) : raw);
                    }}>
                    <option value="">default</option>
                    {(spec.kind === "bool" ? ["true", "false"] : spec.values || []).map(option => (
                      <option key={String(option)} value={String(option)}>{spec.kind === "bool" ? (option === "true" ? "on" : "off") : String(option)}</option>
                    ))}
                  </select>
                ));
              })}
            </div>
          </section>
          {field("Default parser options (JSON)", (
            <textarea className={`${input} min-h-28 font-mono text-xs`} value={value.optionsText} onChange={event => set("optionsText", event.target.value)} />
          ), true)}
          <div className="flex gap-2">
            <button className={primary} disabled={busy || !value.code || !value.label || !value.parser || !value.protocol} onClick={() => void save()}>
              {isNew ? "Add type" : "Save"}
            </button>
            <button className={button} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default function DeviceTypesPanel({ isAdmin, onChanged }: { isAdmin: boolean; onChanged?: () => void }) {
  const [catalog, setCatalog] = useState<DeviceTypeCatalog | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setCatalog(await getDeviceTypes());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    getDeviceTypes().then(result => { if (!cancelled) setCatalog(result); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async (type: HospitalDeviceType) => {
    try {
      await updateDeviceType(type.code, { ...draftOf(type, false), enabled: !type.enabled });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const remove = async (type: HospitalDeviceType) => {
    if (!window.confirm(`Delete device type ${type.code}?`)) return;
    try { await deleteDeviceType(type.code); await load(); onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const th = "px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--app-muted)]";
  const td = "px-3 py-2 align-top text-sm";

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--app-muted)]">
        Flora Root releases deliver the standard types to every gateway. Add hospital types for other models on a supported protocol:
        they run the release's parsers, are licensed when Root licenses a type with the same parser, and reach every gateway at its next check-in.
      </p>
      {error && <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
      {catalog?.haber_error && <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">Haber is unavailable, so the release catalog and parser list cannot be shown ({catalog.haber_error}).</div>}

      <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--app-text)]">Hospital types</h2>
            <p className="text-xs text-[var(--app-muted)]">Managed here · delivered to gateways through Haber</p>
          </div>
          {isAdmin && <button className={primary} onClick={() => setEditing({ draft: blank(), isNew: true })}>Add device type</button>}
        </div>
        <div className="overflow-x-auto border-t border-[var(--app-border)]">
          <table className="w-full min-w-[800px]">
            <thead><tr><th className={th}>Type</th><th className={th}>Manufacturer · model</th><th className={th}>Controller · parser</th><th className={th}>In use</th><th className={th}>Delivered</th><th className={th} /></tr></thead>
            <tbody>
              {(catalog?.hospital_types || []).map(type => (
                <tr key={type.code} className="border-t border-[var(--app-border)]">
                  <td className={td}><div className="font-medium text-[var(--app-text)]">{type.label}</div><div className="font-mono text-xs text-[var(--app-muted)]">{type.code}</div></td>
                  <td className={`${td} text-[var(--app-muted)]`}>{[type.manufacturer, type.model].filter(Boolean).join(" · ") || "—"}</td>
                  <td className={`${td} text-[var(--app-muted)]`}>{type.controller} · {type.parser}</td>
                  <td className={td}>{type.in_use}</td>
                  <td className={td}>
                    {isAdmin ? <button className={button} onClick={() => void toggle(type)}>{type.enabled ? "Enabled" : "Disabled"}</button>
                      : type.enabled ? "Enabled" : "Disabled"}
                  </td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    {isAdmin && <>
                      <button className={button} onClick={() => setEditing({ draft: draftOf(type, false), isNew: false })}>Edit</button>{" "}
                      <button className={button} disabled={type.in_use > 0} title={type.in_use ? "In use: disable it instead" : ""} onClick={() => void remove(type)}>Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
              {catalog && !catalog.hospital_types.length && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-[var(--app-muted)]">No hospital types yet{isAdmin ? " — add one, or start from a release type below." : "."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
        <div className="px-4 py-3">
          <h2 className="text-lg font-semibold text-[var(--app-text)]">Flora Root release types</h2>
          <p className="text-xs text-[var(--app-muted)]">Read-only · from the approved gateway release</p>
        </div>
        <div className="overflow-x-auto border-t border-[var(--app-border)]">
          <table className="w-full min-w-[800px]">
            <thead><tr><th className={th}>Type</th><th className={th}>Category</th><th className={th}>Controller · parser</th><th className={th}>Protocol</th><th className={th}>In use</th><th className={th} /></tr></thead>
            <tbody>
              {(catalog?.release_types || []).map(type => (
                <tr key={type.code} className="border-t border-[var(--app-border)]">
                  <td className={td}><div className="font-medium text-[var(--app-text)]">{type.label}</div><div className="font-mono text-xs text-[var(--app-muted)]">{type.code}</div></td>
                  <td className={`${td} text-[var(--app-muted)]`}>{type.category}</td>
                  <td className={`${td} text-[var(--app-muted)]`}>{type.controller} · {type.parser}</td>
                  <td className={`${td} text-[var(--app-muted)]`}>{type.protocol}</td>
                  <td className={td}>{type.in_use}</td>
                  <td className={`${td} text-right`}>
                    {isAdmin && <button className={button} onClick={() => setEditing({ draft: draftOf(type, true), isNew: true })}>Use as template</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && catalog && (
        <Editor draft={editing.draft} isNew={editing.isNew} parsers={catalog.parsers}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); onChanged?.(); }} />
      )}
    </div>
  );
}
