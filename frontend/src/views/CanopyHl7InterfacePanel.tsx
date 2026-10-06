import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getAdmissionOptions, type AdmissionWardOption } from "../api/admissionApi";
import {
  HL7_CREATE_ON_OPTIONS,
  deleteHl7Location,
  getHl7Locations,
  getHl7Message,
  getHl7Settings,
  listHl7Messages,
  reprocessHl7Message,
  reprocessUnroutedHl7,
  rotateHl7WebhookToken,
  saveHl7Location,
  saveHl7Settings,
  testHl7Connection,
  type Hl7LocationRow,
  type Hl7MessageDetail,
  type Hl7MessageRow,
  type Hl7Settings,
  type Hl7TestResult,
  type Hl7UnmappedLocation,
} from "../api/hl7InterfaceApi";

const LOG_REFRESH_MS = 10_000;
const MESSAGE_STATUSES = ["applied", "ignored", "unrouted", "error"] as const;

const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5";
const inputClass = "mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const labelClass = "text-xs font-semibold text-[var(--app-muted)]";
const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const small = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--app-text)] disabled:opacity-50";
const errorBox = "rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300";
const okBox = "rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300";

const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

function formatTime(ms: number | null | undefined) {
  if (!ms) return "—";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

function statusBadge(status: string) {
  if (status === "applied") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "unrouted") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "error") return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]";
}

function SectionTitle({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0"><h2 className="font-semibold text-[var(--app-text)]">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs text-[var(--app-muted)]">{subtitle}</p> : null}</div>
    {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
  </div>;
}

function wardLabel(ward: AdmissionWardOption) {
  return `${ward.name}${ward.isDemo ? " (demo)" : ""}${ward.buildingName ? ` – ${ward.buildingName}` : ""}`;
}

/* ------------------------------------------------------------------ connection */

function ConnectionCard({ settings, wards, onSaved }: { settings: Hl7Settings; wards: AdmissionWardOption[]; onSaved: (next: Hl7Settings) => void }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [gatewayUrl, setGatewayUrl] = useState(settings.gatewayUrl);
  const [username, setUsername] = useState(settings.basicUsername);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [bearer, setBearer] = useState("");
  const [clearBearer, setClearBearer] = useState(false);
  const [verifyTls, setVerifyTls] = useState(settings.verifyTls);
  const [defaultUnit, setDefaultUnit] = useState(settings.defaultUnitKey || "");
  const [createOn, setCreateOn] = useState<string[]>(settings.createOn);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [test, setTest] = useState<Hl7TestResult | null>(null);

  const reset = (next: Hl7Settings) => {
    setEnabled(next.enabled); setGatewayUrl(next.gatewayUrl); setUsername(next.basicUsername);
    setPassword(""); setClearPassword(false); setBearer(""); setClearBearer(false);
    setVerifyTls(next.verifyTls); setDefaultUnit(next.defaultUnitKey || ""); setCreateOn(next.createOn);
  };

  const save = async () => {
    setBusy("save"); setError(""); setNote("");
    try {
      const next = await saveHl7Settings({
        enabled,
        gateway_url: gatewayUrl.trim(),
        basic_username: username.trim(),
        basic_password: clearPassword ? "" : password ? password : null,
        bearer_token: clearBearer ? "" : bearer.trim() ? bearer.trim() : null,
        verify_tls: verifyTls,
        default_unit_key: defaultUnit || null,
        create_on: createOn,
      });
      reset(next); onSaved(next); setNote("HL7 interface settings saved.");
    } catch (reason) { setError(message(reason, "Unable to save HL7 settings.")); }
    finally { setBusy(""); }
  };

  const runTest = async () => {
    setBusy("test"); setTest(null);
    try { setTest(await testHl7Connection()); }
    catch (reason) { setTest({ ok: false, error: message(reason, "Test failed.") }); }
    finally { setBusy(""); }
  };

  const toggleCreate = (code: string) => setCreateOn(current => current.includes(code) ? current.filter(item => item !== code) : [...current, code]);

  return <section className={card}>
    <SectionTitle title="Connection" subtitle="Flora receives admissions from the HL7 gateway's EMR webhook and calls the gateway's REST API for patient lookups and the health check.">
      <span className={`self-center rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.12em] ${settings.enabled ? statusBadge("applied") : statusBadge("ignored")}`}>{settings.enabled ? "Enabled" : "Disabled"}</span>
    </SectionTitle>
    <label className="flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-3 text-sm font-semibold text-[var(--app-text)]">
      <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
      <span>Interface enabled<span className="block text-xs font-normal text-[var(--app-muted)]">When disabled the webhook answers 503 and no admissions are created.</span></span>
    </label>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className={`${labelClass} sm:col-span-2`}>Gateway URL<input className={inputClass} value={gatewayUrl} onChange={event => setGatewayUrl(event.target.value)} placeholder="e.g. http://hl7-gw:4567" /></label>
      <label className={labelClass}>Basic auth username<input className={inputClass} value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" /></label>
      <label className={labelClass}>Basic auth password
        <input type="password" className={inputClass} value={password} disabled={clearPassword} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder={settings.hasBasicPassword ? "saved – leave blank to keep" : "not set"} />
        {settings.hasBasicPassword ? <span className="mt-1 flex items-center gap-2 font-normal"><input type="checkbox" checked={clearPassword} onChange={event => setClearPassword(event.target.checked)} />Clear saved password</span> : null}
      </label>
      <label className={labelClass}>Bearer token
        <input type="password" className={inputClass} value={bearer} disabled={clearBearer} onChange={event => setBearer(event.target.value)} autoComplete="new-password" placeholder={settings.hasBearerToken ? "saved – leave blank to keep" : "not set (optional)"} />
        {settings.hasBearerToken ? <span className="mt-1 flex items-center gap-2 font-normal"><input type="checkbox" checked={clearBearer} onChange={event => setClearBearer(event.target.checked)} />Clear saved token</span> : null}
      </label>
      <label className={labelClass}>Default ward
        <select className={inputClass} value={defaultUnit} onChange={event => setDefaultUnit(event.target.value)}>
          <option value="">— none (unmapped messages wait) —</option>
          {wards.map(ward => <option key={ward.key} value={ward.key}>{wardLabel(ward)}</option>)}
        </select>
        <span className="mt-1 block font-normal">Used when a message's location code has no mapping below.</span>
      </label>
      <label className="flex items-center gap-2 self-start rounded-xl border border-[var(--app-border)] px-3 py-2.5 text-sm font-semibold text-[var(--app-text)] sm:col-span-2"><input type="checkbox" checked={verifyTls} onChange={event => setVerifyTls(event.target.checked)} />Verify the gateway's TLS certificate</label>
    </div>
    <div className="mt-5">
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Create an admission on</div>
      <div className="grid gap-2 md:grid-cols-3">
        {HL7_CREATE_ON_OPTIONS.map(option => <label key={option.code} className={`flex items-start gap-3 rounded-xl border px-3 py-3 text-sm ${createOn.includes(option.code) ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>
          <input type="checkbox" className="mt-1" checked={createOn.includes(option.code)} onChange={() => toggleCreate(option.code)} />
          <span><span className="block font-semibold text-[var(--app-text)]">{option.label}</span><span className="block text-xs text-[var(--app-muted)]">{option.note}</span></span>
        </label>)}
      </div>
      <p className="mt-2 text-xs text-[var(--app-muted)]">Other messages (cancellations, demographic updates) still update admissions that already exist.</p>
    </div>
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <button type="button" className={primary} disabled={!!busy} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save"}</button>
      <button type="button" className={secondary} disabled={!!busy || !settings.gatewayUrl} title={!settings.gatewayUrl ? "Save a gateway URL first" : "Calls the gateway's GET /health with the saved settings"} onClick={() => void runTest()}>{busy === "test" ? "Testing…" : "Test connection"}</button>
      {settings.updatedAt ? <span className="text-xs text-[var(--app-muted)]">Last saved {formatTime(settings.updatedAt)}{settings.updatedBy ? ` by ${settings.updatedBy}` : ""}</span> : null}
    </div>
    {test ? <div className={`mt-3 ${test.ok ? okBox : errorBox}`}>
      <div className="font-semibold">{test.ok ? "Gateway reachable" : "Gateway not reachable"}{test.status ? ` · HTTP ${test.status}` : ""}</div>
      {test.error ? <div className="mt-1">{test.error}</div> : null}
      {test.health != null ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{typeof test.health === "string" ? test.health : JSON.stringify(test.health, null, 2)}</pre> : null}
    </div> : null}
    {error ? <div className={`mt-3 ${errorBox}`}>{error}</div> : null}
    {note ? <div className={`mt-3 ${okBox}`}>{note}</div> : null}
  </section>;
}

/* ------------------------------------------------------------------ webhook */

function WebhookCard({ settings, onRotated }: { settings: Hl7Settings; onRotated: (next: Hl7Settings) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const url = settings.webhookUrl || `${window.location.origin}${settings.webhookPath}`;

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setError("Copy failed — select the URL and copy it manually."); }
  };
  const rotate = async () => {
    if (!window.confirm("Rotate the webhook URL? The current URL stops working immediately; update emr_webhook_url on the HL7 gateway afterwards.")) return;
    setBusy(true); setError("");
    try { onRotated(await rotateHl7WebhookToken()); }
    catch (reason) { setError(message(reason, "Unable to rotate the webhook URL.")); }
    finally { setBusy(false); }
  };

  return <section className={card}>
    <SectionTitle title="Webhook" subtitle="Set this as emr_webhook_url on the HL7 gateway (PUT /admin/settings). The gateway cannot send credentials, so the URL itself is the secret — rotate it if it leaks." />
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2.5 text-xs text-[var(--app-text)]">{url}</code>
      <button type="button" className={secondary} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      <button type="button" className={`${secondary} text-rose-600 dark:text-rose-300`} disabled={busy} onClick={() => void rotate()}>{busy ? "Rotating…" : "Rotate"}</button>
    </div>
    <p className="mt-2 text-xs text-[var(--app-muted)]">The gateway must be able to reach this address; if it runs in another network, replace the host with one it can resolve.</p>
    {error ? <div className={`mt-3 ${errorBox}`}>{error}</div> : null}
  </section>;
}

/* ------------------------------------------------------------------ locations */

type MappingDraft = { code: string; unitKey: string; leafId: string; note: string; isNew: boolean };

function LocationsCard({ wards, onReprocessed }: { wards: AdmissionWardOption[]; onReprocessed: () => void }) {
  const [rows, setRows] = useState<Hl7LocationRow[]>([]);
  const [unmapped, setUnmapped] = useState<Hl7UnmappedLocation[]>([]);
  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try { const data = await getHl7Locations(); setRows(data.rows || []); setUnmapped(data.unmapped || []); setError(""); }
    catch (reason) { setError(message(reason, "Unable to load location mappings.")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const ward = wards.find(item => item.key === draft?.unitKey);
  const startNew = (code = "") => { setNote(""); setDraft({ code, unitKey: wards.length === 1 ? wards[0].key : "", leafId: "", note: "", isNew: true }); };
  const edit = (row: Hl7LocationRow) => { setNote(""); setDraft({ code: row.code, unitKey: row.unit_key, leafId: row.target_leaf_id || "", note: row.note || "", isNew: false }); };

  const save = async () => {
    if (!draft || !draft.code.trim() || !draft.unitKey) return;
    setBusy("save"); setError("");
    try {
      await saveHl7Location(draft.code.trim(), { unit_key: draft.unitKey, target_leaf_id: draft.leafId || null, note: draft.note.trim() });
      setNote(`Location ${draft.code.trim()} mapped.`); setDraft(null); await load();
    } catch (reason) { setError(message(reason, "Unable to save the mapping.")); }
    finally { setBusy(""); }
  };
  const remove = async (code: string) => {
    if (!window.confirm(`Delete the mapping for location ${code}? New messages from it will wait as unrouted (or use the default ward).`)) return;
    setBusy(`delete:${code}`); setError("");
    try { await deleteHl7Location(code); setNote(`Mapping for ${code} deleted.`); if (draft?.code === code) setDraft(null); await load(); }
    catch (reason) { setError(message(reason, "Unable to delete the mapping.")); }
    finally { setBusy(""); }
  };
  const reprocess = async () => {
    setBusy("reprocess"); setError("");
    try {
      const result = await reprocessUnroutedHl7();
      setNote(`Reprocessed ${result.processed} unrouted message${result.processed === 1 ? "" : "s"}: ${result.applied} applied, ${result.still_unrouted} still unrouted.`);
      await load(); onReprocessed();
    } catch (reason) { setError(message(reason, "Unable to reprocess unrouted messages.")); }
    finally { setBusy(""); }
  };

  return <section className={card}>
    <SectionTitle title="Location mapping" subtitle="Map the HIS location code (PV1-3 / AIL-3) of incoming messages to a Canopy ward and optionally a specific bed / Leaf.">
      <button type="button" className={secondary} disabled={!!busy} onClick={() => void reprocess()}>{busy === "reprocess" ? "Reprocessing…" : "Reprocess unrouted messages"}</button>
      <button type="button" className={primary} onClick={() => startNew()}>+ Mapping</button>
    </SectionTitle>
    {draft ? <div className="mb-4 rounded-xl border border-[var(--app-accent)] bg-[var(--app-hover-bg)] p-4">
      <div className="grid gap-3 md:grid-cols-4">
        <label className={labelClass}>HIS location code<input className={inputClass} value={draft.code} disabled={!draft.isNew} onChange={event => setDraft({ ...draft, code: event.target.value })} placeholder="e.g. OR-3" /></label>
        <label className={labelClass}>Ward<select className={inputClass} value={draft.unitKey} onChange={event => setDraft({ ...draft, unitKey: event.target.value, leafId: "" })}><option value="">Choose ward…</option>{wards.map(item => <option key={item.key} value={item.key}>{wardLabel(item)}</option>)}</select></label>
        <label className={labelClass}>Bed / Leaf<select className={inputClass} value={draft.leafId} disabled={!ward} onChange={event => setDraft({ ...draft, leafId: event.target.value })}><option value="">Any bed in ward</option>{(ward?.leaves || []).map(leaf => <option key={leaf.leafId} value={leaf.leafId}>{leaf.bedName && leaf.bedName !== leaf.name ? `${leaf.bedName} (${leaf.name})` : leaf.name}</option>)}</select></label>
        <label className={labelClass}>Note<input className={inputClass} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} placeholder="Optional" /></label>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" className={primary} disabled={busy === "save" || !draft.code.trim() || !draft.unitKey} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save mapping"}</button>
        <button type="button" className={secondary} onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div> : null}
    <div className="overflow-x-auto rounded-xl border border-[var(--app-border)]">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="bg-[var(--app-control-bg)] text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]"><tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Ward</th><th className="px-3 py-2">Bed / Leaf</th><th className="px-3 py-2">Note</th><th className="px-3 py-2" /></tr></thead>
        <tbody>
          {rows.map(row => <tr key={row.code} className="border-t border-[var(--app-border)]">
            <td className="px-3 py-2 font-mono font-semibold text-[var(--app-text)]">{row.code}</td>
            <td className="px-3 py-2 text-[var(--app-text)]">{row.unit_name || row.unit_key}</td>
            <td className="px-3 py-2 text-[var(--app-muted)]">{row.leaf_name || row.target_leaf_id || "Any bed"}</td>
            <td className="px-3 py-2 text-[var(--app-muted)]">{row.note || ""}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right"><button type="button" className={small} onClick={() => edit(row)}>Edit</button> <button type="button" className={`${small} text-rose-600 dark:text-rose-300`} disabled={busy === `delete:${row.code}`} onClick={() => void remove(row.code)}>Delete</button></td>
          </tr>)}
          {!rows.length ? <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-[var(--app-muted)]">No location mappings yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
    {unmapped.length ? <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="text-xs font-bold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">Seen but unmapped</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {unmapped.map(item => <div key={item.code} className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2.5 py-1.5 text-xs">
          <span className="font-mono font-semibold text-[var(--app-text)]">{item.code}</span>
          <span className="text-[var(--app-muted)]">{item.messages} msg · {formatTime(item.last_seen)}</span>
          <button type="button" className={small} onClick={() => startNew(item.code)}>Map…</button>
        </div>)}
      </div>
    </div> : null}
    {error ? <div className={`mt-3 ${errorBox}`}>{error}</div> : null}
    {note ? <div className={`mt-3 ${okBox}`}>{note}</div> : null}
  </section>;
}

/* ------------------------------------------------------------------ message log */

function MessageModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [row, setRow] = useState<Hl7MessageDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(async () => {
    try { setRow((await getHl7Message(id)).row); setError(""); }
    catch (reason) { setError(message(reason, "Unable to load the message.")); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reprocess = async () => {
    setBusy(true); setError(""); setNote("");
    try {
      const result = await reprocessHl7Message(id);
      setNote(`Reprocessed: ${result.status}${result.action ? ` — ${result.action}` : ""}`);
      await load(); onChanged();
    } catch (reason) { setError(message(reason, "Unable to reprocess the message.")); }
    finally { setBusy(false); }
  };

  const segments = Array.isArray(row?.payload?.segments) ? row.payload.segments : [];
  return <div className="app-theme-scope fixed inset-0 z-[1100] flex items-stretch justify-center bg-black/55 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="HL7 message" onClick={onClose}>
    <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:border sm:border-[var(--app-border)]" onClick={event => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] px-5 py-4">
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">HL7 message #{id}</div>
          <h2 className="text-lg font-bold">{row?.message_type || "…"}{row?.control_id ? <span className="ml-2 text-sm font-normal text-[var(--app-muted)]">control id {row.control_id}</span> : null}</h2>
          {row ? <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--app-muted)]">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadge(row.status)}`}>{row.status}</span>
            <span>{formatTime(row.received_at)}</span>
            {row.mrn ? <span>MRN {row.mrn}</span> : null}
            {row.location_code ? <span>Location {row.location_code}</span> : null}
            {row.admission_id ? <span title={row.admission_id}>Admission {row.admission_id.slice(0, 8)}</span> : null}
          </div> : null}
        </div>
        <button type="button" onClick={onClose} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] text-xl" aria-label="Close">×</button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {row?.action ? <div className="text-sm"><span className="font-semibold">Action:</span> {row.action}</div> : null}
        {row?.error ? <div className={errorBox}>{row.error}</div> : null}
        {segments.length ? <div className="overflow-x-auto rounded-xl border border-[var(--app-border)]">
          <table className="w-full text-left font-mono text-xs">
            <tbody>
              {segments.map((segment, index) => {
                const fields = Array.isArray(segment.fields) ? segment.fields : [];
                const offset = segment.segment === "MSH" ? 2 : 1; // MSH-1 is the field separator itself
                return <tr key={index} className="border-t border-[var(--app-border)] align-top first:border-t-0">
                  <th className="w-16 bg-[var(--app-control-bg)] px-3 py-2 font-bold text-[var(--app-accent)]">{segment.segment}</th>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {fields.map((field, fieldIndex) => {
                        const value = typeof field === "string" ? field : JSON.stringify(field);
                        if (!value) return null;
                        return <span key={fieldIndex} className="break-all"><span className="text-[var(--app-muted)]">{segment.segment}-{fieldIndex + offset}</span> <span className="text-[var(--app-text)]">{value}</span></span>;
                      })}
                    </div>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div> : row ? <div className="text-sm text-[var(--app-muted)]">No segments in the payload.</div> : null}
        {row?.payload ? <div>
          <button type="button" className={small} onClick={() => setShowRaw(value => !value)}>{showRaw ? "Hide raw JSON" : "Show raw JSON"}</button>
          {showRaw ? <pre className="mt-2 max-h-80 overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 text-xs">{JSON.stringify(row.payload, null, 2)}</pre> : null}
        </div> : null}
        {error ? <div className={errorBox}>{error}</div> : null}
        {note ? <div className={okBox}>{note}</div> : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--app-border)] px-5 py-3">
        <button type="button" className={secondary} onClick={onClose}>Close</button>
        <button type="button" className={primary} disabled={busy || !row} onClick={() => void reprocess()}>{busy ? "Reprocessing…" : "Reprocess"}</button>
      </div>
    </div>
  </div>;
}

function MessageLogCard({ refreshKey }: { refreshKey: number }) {
  const [status, setStatus] = useState("");
  const [mrnInput, setMrnInput] = useState("");
  const [mrn, setMrn] = useState("");
  const [rows, setRows] = useState<Hl7MessageRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listHl7Messages({ status, mrn, limit: 200 });
      setRows(data.rows || []); setCounts(data.last24h || {}); setError("");
    } catch (reason) { setError(message(reason, "Unable to load the message log.")); }
    finally { setLoading(false); }
  }, [status, mrn]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), LOG_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const chip = (active: boolean) => `rounded-full border px-3 py-1.5 text-xs font-bold ${active ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)] hover:text-[var(--app-text)]"}`;

  return <section className={card}>
    <SectionTitle title="Message log" subtitle="Every message the gateway delivered to the webhook. Refreshes every 10 seconds; click a row for the segments.">
      <button type="button" className={secondary} onClick={() => void load()}>{loading ? "Loading…" : "Refresh"}</button>
    </SectionTitle>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <button type="button" className={chip(status === "")} onClick={() => setStatus("")}>All · {total} in 24 h</button>
      {MESSAGE_STATUSES.map(item => <button key={item} type="button" className={chip(status === item)} onClick={() => setStatus(item)}><span className="capitalize">{item}</span> · {counts[item] || 0}</button>)}
      <form className="ml-auto flex gap-2" onSubmit={event => { event.preventDefault(); setMrn(mrnInput.trim()); }}>
        <input className="w-40 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]" value={mrnInput} onChange={event => setMrnInput(event.target.value)} placeholder="Search MRN" aria-label="Search MRN" />
        <button type="submit" className={small}>Search</button>
        {mrn ? <button type="button" className={small} onClick={() => { setMrn(""); setMrnInput(""); }}>Clear</button> : null}
      </form>
    </div>
    <div className="overflow-x-auto rounded-xl border border-[var(--app-border)]">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="bg-[var(--app-control-bg)] text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]"><tr><th className="px-3 py-2">Received</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Control id</th><th className="px-3 py-2">MRN</th><th className="px-3 py-2">Location</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Action / error</th><th className="px-3 py-2">Admission</th></tr></thead>
        <tbody>
          {rows.map(row => <tr key={row.id} className="cursor-pointer border-t border-[var(--app-border)] hover:bg-[var(--app-hover-bg)]" onClick={() => setOpenId(row.id)}>
            <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--app-muted)]">{formatTime(row.received_at)}</td>
            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold text-[var(--app-text)]">{row.message_type || "—"}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--app-muted)]">{row.control_id || "—"}</td>
            <td className="px-3 py-2 text-[var(--app-text)]">{row.mrn || "—"}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--app-text)]">{row.location_code || "—"}</td>
            <td className="px-3 py-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadge(row.status)}`}>{row.status}</span></td>
            <td className={`max-w-[320px] truncate px-3 py-2 text-xs ${row.error ? "text-rose-600 dark:text-rose-300" : "text-[var(--app-muted)]"}`} title={row.error || row.action || ""}>{row.error || row.action || "—"}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--app-muted)]" title={row.admission_id || ""}>{row.admission_id ? row.admission_id.slice(0, 8) : "—"}</td>
          </tr>)}
          {!rows.length ? <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-[var(--app-muted)]">{loading ? "Loading…" : "No messages match."}</td></tr> : null}
        </tbody>
      </table>
    </div>
    {error ? <div className={`mt-3 ${errorBox}`}>{error}</div> : null}
    {openId != null ? <MessageModal id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} /> : null}
  </section>;
}

/* ------------------------------------------------------------------ panel */

/** Canopy admin: HL7 admission interface (gateway connection, webhook, location mapping, message log). */
export default function CanopyHl7InterfacePanel() {
  const [settings, setSettings] = useState<Hl7Settings | null>(null);
  const [wards, setWards] = useState<AdmissionWardOption[]>([]);
  const [error, setError] = useState("");
  const [logKey, setLogKey] = useState(0);

  useEffect(() => {
    getHl7Settings().then(setSettings).catch(reason => setError(message(reason, "Unable to load the HL7 interface.")));
    getAdmissionOptions().then(setWards).catch(() => setWards([]));
  }, []);

  if (error) return <div className={errorBox}>{error}</div>;
  if (!settings) return <div className={`${card} text-sm text-[var(--app-muted)]`}>Loading HL7 interface…</div>;
  return <div className="space-y-4">
    <ConnectionCard settings={settings} wards={wards} onSaved={setSettings} />
    <WebhookCard settings={settings} onRotated={setSettings} />
    <LocationsCard wards={wards} onReprocessed={() => setLogKey(value => value + 1)} />
    <MessageLogCard refreshKey={logKey} />
  </div>;
}
