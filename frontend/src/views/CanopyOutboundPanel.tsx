import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_FEEDS,
  cancelOutboundMessage,
  createOutboundDestination,
  deleteOutboundDestination,
  getOutbound,
  getOutboundMessage,
  getOutboundTestCases,
  listOutboundMessages,
  resendOutboundMessage,
  saveOutboundDestination,
  testOutboundDestination,
  type DocumentFeed,
  type OutboundDestination,
  type OutboundDestinationInput,
  type OutboundKind,
  type OutboundMessageDetail,
  type OutboundMessageRow,
  type OutboundTestCase,
  type OutboundTestResult,
  type OutboundWard,
} from "../api/outboundApi";

const LOG_REFRESH_MS = 10_000;
const MESSAGE_STATUSES = ["pending", "sent", "error", "failed", "cancelled"] as const;
const KINDS: Array<{ kind: OutboundKind; label: string }> = [
  { kind: "vitals", label: "Vital signs" },
  { kind: "form", label: "Form saved" },
  { kind: "discharge", label: "Discharge" },
];

const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5";
const inputClass = "mt-1 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const labelClass = "text-xs font-semibold text-[var(--app-muted)]";
const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const small = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--app-text)] disabled:opacity-50";
const errorBox = "rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300";
const okBox = "rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300";
const checkRow = "flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-3 text-sm font-semibold text-[var(--app-text)]";

const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

function formatTime(ms: number | null | undefined) {
  if (!ms) return "—";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

function clock(ms: number | null | undefined) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

function statusBadge(status: string) {
  if (status === "sent") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "pending") return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "error") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "failed") return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]";
}

function SectionTitle({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0"><h2 className="font-semibold text-[var(--app-text)]">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs text-[var(--app-muted)]">{subtitle}</p> : null}</div>
    {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
  </div>;
}

function blankDraft(): OutboundDestinationInput {
  return {
    name: "", enabled: false, format: "hl7v2", hl7_version: "2.5.1", host: "", port: 2575, url: "",
    auth_type: "none", username: "", password: null, bearer_token: null, verify_tls: true,
    tls: false, ca_cert: "", client_cert: "", client_key: null, identity: "masked",
    unit_keys: ["*"], sending_application: "FLORA", sending_facility: "", receiving_application: "", receiving_facility: "",
    feeds: structuredClone(DEFAULT_FEEDS),
  };
}

function toDraft(row: OutboundDestination): OutboundDestinationInput {
  return {
    name: row.name, enabled: row.enabled, format: row.format, hl7_version: row.hl7_version, host: row.host, port: row.port,
    url: row.url, auth_type: row.auth_type, username: row.username, password: null, bearer_token: null,
    verify_tls: row.verify_tls, tls: row.tls ?? false, ca_cert: row.ca_cert || "", client_cert: row.client_cert || "", client_key: null,
    identity: row.identity, unit_keys: row.unit_keys?.length ? row.unit_keys : ["*"],
    sending_application: row.sending_application, sending_facility: row.sending_facility,
    receiving_application: row.receiving_application, receiving_facility: row.receiving_facility,
    feeds: {
      vitals: { ...DEFAULT_FEEDS.vitals, ...(row.feeds?.vitals || {}) },
      form: { ...DEFAULT_FEEDS.form, ...(row.feeds?.form || {}) },
      discharge: { ...DEFAULT_FEEDS.discharge, ...(row.feeds?.discharge || {}) },
    },
  };
}

function feedSummary(row: OutboundDestination) {
  const parts: string[] = [];
  if (row.feeds?.vitals?.enabled) parts.push(`vitals / ${row.feeds.vitals.interval_minutes} min`);
  for (const kind of ["form", "discharge"] as const) {
    const feed = row.feeds?.[kind];
    if (feed?.enabled) parts.push(`${kind} ${feed.timing === "daily" ? `at ${feed.daily_at}` : `+${feed.delay_seconds}s`}`);
  }
  return parts.length ? parts.join(" · ") : "no feeds on";
}

/* ------------------------------------------------------------------ feed editors */

function DocumentFeedEditor({ title, note, feed, onChange }: { title: string; note: string; feed: DocumentFeed; onChange: (next: DocumentFeed) => void }) {
  const set = (patch: Partial<DocumentFeed>) => onChange({ ...feed, ...patch });
  return <div className="rounded-xl border border-[var(--app-border)] p-4">
    <label className="flex items-start gap-3 text-sm font-semibold text-[var(--app-text)]">
      <input type="checkbox" className="mt-1" checked={feed.enabled} onChange={event => set({ enabled: event.target.checked })} />
      <span>{title}<span className="block text-xs font-normal text-[var(--app-muted)]">{note}</span></span>
    </label>
    {feed.enabled ? <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <label className={labelClass}>Send
        <select className={inputClass} value={feed.timing} onChange={event => set({ timing: event.target.value as DocumentFeed["timing"] })}>
          <option value="delay">after a delay</option>
          <option value="daily">at a daily time</option>
        </select>
      </label>
      {feed.timing === "delay"
        ? <label className={labelClass}>Delay (seconds)<input type="number" min={0} max={604800} className={inputClass} value={feed.delay_seconds} onChange={event => set({ delay_seconds: Math.max(0, Number(event.target.value) || 0) })} />
          <span className="mt-1 block font-normal">Another save within the delay restarts it, so a burst of edits is sent once.</span></label>
        : <label className={labelClass}>Time (hospital time)<input type="time" className={inputClass} value={feed.daily_at} onChange={event => set({ daily_at: event.target.value || "00:00" })} />
          <span className="mt-1 block font-normal">00:00 sends the day's records at midnight.</span></label>}
      <label className="flex items-center gap-2 self-start rounded-xl border border-[var(--app-border)] px-3 py-2.5 text-sm font-semibold text-[var(--app-text)] sm:mt-5"><input type="checkbox" checked={feed.pdf} onChange={event => set({ pdf: event.target.checked })} />Attach the PDF record</label>
    </div> : null}
  </div>;
}

/* ------------------------------------------------------------------ destination editor */

function DestinationEditor({ row, wards, onSaved, onDeleted }: {
  row: OutboundDestination | null; wards: OutboundWard[]; onSaved: (next: OutboundDestination) => void; onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<OutboundDestinationInput>(() => row ? toDraft(row) : blankDraft());
  const [password, setPassword] = useState("");
  const [bearer, setBearer] = useState("");
  const [clientKey, setClientKey] = useState("");
  const [clearClientKey, setClearClientKey] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "delete" | "test">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [testKind, setTestKind] = useState<OutboundKind>("form");
  const [testCaseId, setTestCaseId] = useState("");
  const [testCases, setTestCases] = useState<OutboundTestCase[]>([]);
  const [test, setTest] = useState<OutboundTestResult | null>(null);

  useEffect(() => {
    setDraft(row ? toDraft(row) : blankDraft()); setPassword(""); setBearer(""); setClientKey(""); setClearClientKey(false); setError(""); setNote(""); setTest(null); setTestCaseId("");
    if (row) getOutboundTestCases(row.id).then(data => setTestCases(data.rows)).catch(() => setTestCases([]));
    else setTestCases([]);
  }, [row]);

  const set = (patch: Partial<OutboundDestinationInput>) => setDraft(current => ({ ...current, ...patch }));
  const allWards = draft.unit_keys.includes("*");
  const toggleWard = (key: string) => set({ unit_keys: draft.unit_keys.includes(key) ? draft.unit_keys.filter(item => item !== key) : [...draft.unit_keys.filter(item => item !== "*"), key] });

  const save = async () => {
    setBusy("save"); setError(""); setNote("");
    try {
      const input = { ...draft, unit_keys: allWards || !draft.unit_keys.length ? ["*"] : draft.unit_keys,
        password: password ? password : null, bearer_token: bearer.trim() ? bearer.trim() : null,
        client_key: clearClientKey ? "" : clientKey.trim() ? clientKey.trim() : null };
      const next = row ? await saveOutboundDestination(row.id, input) : await createOutboundDestination(input);
      setPassword(""); setBearer(""); setClientKey(""); setClearClientKey(false); onSaved(next); setNote("Destination saved.");
    } catch (reason) { setError(message(reason, "Unable to save the destination.")); }
    finally { setBusy(""); }
  };

  const remove = async () => {
    if (!row || !window.confirm(`Delete destination "${row.name}" and its message log?`)) return;
    setBusy("delete"); setError("");
    try { await deleteOutboundDestination(row.id); onDeleted(); }
    catch (reason) { setError(message(reason, "Unable to delete the destination.")); }
    finally { setBusy(""); }
  };

  const runTest = async () => {
    if (!row) return;
    setBusy("test"); setTest(null);
    try { setTest(await testOutboundDestination(row.id, testKind, testCaseId || undefined)); }
    catch (reason) { setTest({ ok: false, error: message(reason, "Test failed.") } as OutboundTestResult); }
    finally { setBusy(""); }
  };

  const hl7 = draft.format === "hl7v2";
  return <section className={`${card} space-y-5`}>
    <SectionTitle title={row ? row.name : "New destination"} subtitle="Where Canopy sends data, for which wards, and when.">
      {row ? <span className={`self-center rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.12em] ${row.enabled ? statusBadge("sent") : statusBadge("cancelled")}`}>{row.enabled ? "Enabled" : "Disabled"}</span> : null}
    </SectionTitle>

    <div className="grid gap-4 sm:grid-cols-2">
      <label className={labelClass}>Name<input className={inputClass} value={draft.name} onChange={event => set({ name: event.target.value })} placeholder="e.g. HIS – Central data warehouse" /></label>
      <label className={labelClass}>Format
        <select className={inputClass} value={draft.format} onChange={event => set({ format: event.target.value as OutboundDestinationInput["format"] })}>
          <option value="hl7v2">HL7 v2 ORU^R01 over MLLP</option>
          <option value="fhir">FHIR R4 Bundle over HTTP(S)</option>
        </select>
      </label>
      <label className={`${checkRow} sm:col-span-2`}>
        <input type="checkbox" checked={draft.enabled} onChange={event => set({ enabled: event.target.checked })} />
        <span>Destination enabled<span className="block text-xs font-normal text-[var(--app-muted)]">While disabled nothing is queued or sent; a test send still works.</span></span>
      </label>
    </div>

    <div>
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Connection</div>
      {hl7 ? <div className="grid gap-4 sm:grid-cols-3">
        <label className={`${labelClass} sm:col-span-2`}>Host<input className={inputClass} value={draft.host} onChange={event => set({ host: event.target.value })} placeholder="e.g. his-interface.hospital.local" /></label>
        <label className={labelClass}>Port<input type="number" min={1} max={65535} className={inputClass} value={draft.port ?? ""} onChange={event => set({ port: event.target.value ? Number(event.target.value) : null })} /></label>
        <label className={labelClass}>HL7 version<select className={inputClass} value={draft.hl7_version} onChange={event => set({ hl7_version: event.target.value })}>{["2.3", "2.3.1", "2.4", "2.5", "2.5.1", "2.6"].map(v => <option key={v}>{v}</option>)}</select></label>
        <label className={labelClass}>Sending application (MSH-3)<input className={inputClass} value={draft.sending_application} onChange={event => set({ sending_application: event.target.value })} /></label>
        <label className={labelClass}>Sending facility (MSH-4)<input className={inputClass} value={draft.sending_facility} onChange={event => set({ sending_facility: event.target.value })} /></label>
        <label className={labelClass}>Receiving application (MSH-5)<input className={inputClass} value={draft.receiving_application} onChange={event => set({ receiving_application: event.target.value })} /></label>
        <label className={labelClass}>Receiving facility (MSH-6)<input className={inputClass} value={draft.receiving_facility} onChange={event => set({ receiving_facility: event.target.value })} /></label>
        <label className={`${checkRow} sm:col-span-3`}>
          <input type="checkbox" checked={draft.tls} onChange={event => set({ tls: event.target.checked })} />
          <span>MLLP over TLS<span className="block text-xs font-normal text-[var(--app-muted)]">Encrypts the connection. Use it whenever the receiver supports it, especially across networks.</span></span>
        </label>
        {draft.tls ? <>
          <label className="flex items-center gap-2 self-start rounded-xl border border-[var(--app-border)] px-3 py-2.5 text-sm font-semibold text-[var(--app-text)] sm:col-span-3"><input type="checkbox" checked={draft.verify_tls} onChange={event => set({ verify_tls: event.target.checked })} />Verify the receiver's certificate{!draft.verify_tls ? <span className="text-xs font-normal text-rose-600 dark:text-rose-300">— off: encrypted but not authenticated; for testing only</span> : null}</label>
          <label className={`${labelClass} sm:col-span-3`}>CA certificate (PEM)<textarea rows={3} className={`${inputClass} font-mono text-[11px]`} value={draft.ca_cert} onChange={event => set({ ca_cert: event.target.value })} placeholder="-----BEGIN CERTIFICATE----- … (empty = trust the system CAs)" /></label>
          <label className={`${labelClass} sm:col-span-3`}>Client certificate (PEM, for mutual TLS)<textarea rows={3} className={`${inputClass} font-mono text-[11px]`} value={draft.client_cert} onChange={event => set({ client_cert: event.target.value })} placeholder="Only when the receiver asks for a client certificate" /></label>
          <label className={`${labelClass} sm:col-span-3`}>Client private key (PEM)
            <textarea rows={3} className={`${inputClass} font-mono text-[11px]`} value={clientKey} disabled={clearClientKey} onChange={event => setClientKey(event.target.value)} placeholder={row?.has_client_key ? "saved – leave blank to keep" : "not set"} autoComplete="off" />
            {row?.has_client_key ? <span className="mt-1 flex items-center gap-2 font-normal"><input type="checkbox" checked={clearClientKey} onChange={event => setClearClientKey(event.target.checked)} />Clear saved key</span> : null}
          </label>
        </> : null}
      </div> : <div className="grid gap-4 sm:grid-cols-2">
        <label className={`${labelClass} sm:col-span-2`}>FHIR base URL<input className={inputClass} value={draft.url} onChange={event => set({ url: event.target.value })} placeholder="e.g. https://fhir.hospital.local/r4" />
          <span className="mt-1 block font-normal">Each message is POSTed as a transaction Bundle to this URL.</span></label>
        <label className={labelClass}>Authentication
          <select className={inputClass} value={draft.auth_type} onChange={event => set({ auth_type: event.target.value as OutboundDestinationInput["auth_type"] })}>
            <option value="none">None</option><option value="basic">Basic</option><option value="bearer">Bearer token</option>
          </select>
        </label>
        <label className={labelClass}>Organisation identifier system<input className={inputClass} value={draft.sending_facility} onChange={event => set({ sending_facility: event.target.value })} placeholder="e.g. KCMH (used in HN / AN identifiers)" /></label>
        {draft.auth_type === "basic" ? <>
          <label className={labelClass}>Username<input className={inputClass} value={draft.username} onChange={event => set({ username: event.target.value })} autoComplete="off" /></label>
          <label className={labelClass}>Password<input type="password" className={inputClass} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder={row?.has_password ? "saved – leave blank to keep" : "not set"} /></label>
        </> : null}
        {draft.auth_type === "bearer" ? <label className={`${labelClass} sm:col-span-2`}>Bearer token<input type="password" className={inputClass} value={bearer} onChange={event => setBearer(event.target.value)} autoComplete="new-password" placeholder={row?.has_bearer_token ? "saved – leave blank to keep" : "not set"} /></label> : null}
        <label className="flex items-center gap-2 self-start rounded-xl border border-[var(--app-border)] px-3 py-2.5 text-sm font-semibold text-[var(--app-text)] sm:col-span-2"><input type="checkbox" checked={draft.verify_tls} onChange={event => set({ verify_tls: event.target.checked })} />Verify the server's TLS certificate</label>
      </div>}
    </div>

    <div>
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Patient identity</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {([["full", "Full identifiers", "Name, HN, AN and national ID as recorded. For the hospital's own HIS / EMR."],
          ["masked", "Masked", "First three characters then -------- (as the public API and MCP). For central or research systems."]] as const).map(([value, title, text]) =>
          <label key={value} className={`flex items-start gap-3 rounded-xl border px-3 py-3 text-sm font-semibold text-[var(--app-text)] ${draft.identity === value ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>
            <input type="radio" className="mt-1" name="identity" checked={draft.identity === value} onChange={() => set({ identity: value })} />
            <span>{title}<span className="block text-xs font-normal text-[var(--app-muted)]">{text}</span></span>
          </label>)}
      </div>
    </div>

    <div>
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Wards</div>
      <label className={checkRow}><input type="checkbox" checked={allWards} onChange={event => set({ unit_keys: event.target.checked ? ["*"] : [] })} />All wards (*)<span className="text-xs font-normal text-[var(--app-muted)]">including wards added later</span></label>
      {!allWards ? <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{wards.map(ward =>
        <label key={ward.key} className="flex items-center gap-3 rounded-xl border border-[var(--app-border)] px-3 py-2.5 text-sm text-[var(--app-text)]">
          <input type="checkbox" checked={draft.unit_keys.includes(ward.key)} onChange={() => toggleWard(ward.key)} />
          <span className="min-w-0 truncate">{ward.name}{ward.isDemo ? " (demo)" : ""}{ward.buildingName ? <span className="text-xs text-[var(--app-muted)]"> – {ward.buildingName}</span> : null}</span>
        </label>)}</div> : null}
    </div>

    <div className="space-y-3">
      <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">What and when</div>
      <div className="rounded-xl border border-[var(--app-border)] p-4">
        <label className="flex items-start gap-3 text-sm font-semibold text-[var(--app-text)]">
          <input type="checkbox" className="mt-1" checked={draft.feeds.vitals.enabled} onChange={event => set({ feeds: { ...draft.feeds, vitals: { ...draft.feeds.vitals, enabled: event.target.checked } } })} />
          <span>Vital signs (candles)<span className="block text-xs font-normal text-[var(--app-muted)]">For every active case: first, maximum, minimum and last of each parameter (HR, SpO₂, RR, NIBP, ART, EtCO₂, temperature, CVP) per period.</span></span>
        </label>
        {draft.feeds.vitals.enabled ? <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className={labelClass}>Period (minutes)
            <select className={inputClass} value={draft.feeds.vitals.interval_minutes} onChange={event => set({ feeds: { ...draft.feeds, vitals: { ...draft.feeds.vitals, interval_minutes: Number(event.target.value) } } })}>
              {[1, 2, 5, 10, 15, 30, 60].map(m => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
          <p className="self-end text-xs text-[var(--app-muted)] sm:col-span-2">1 minute is the fastest. Canopy keeps one value per parameter per minute, so a 1-minute candle has first = max = min = last; 2 minutes or more give a real range. Periods follow the clock (e.g. 10:00–10:05) and are sent about 90 seconds after they end.</p>
        </div> : null}
      </div>
      <DocumentFeedEditor title="When a form is saved" note="Sends the case record (ORU^R01 / DiagnosticReport) with the anaesthesia record PDF." feed={draft.feeds.form}
        onChange={next => set({ feeds: { ...draft.feeds, form: next } })} />
      <DocumentFeedEditor title="When a case is discharged" note="Sends the final case record once the case is discharged." feed={draft.feeds.discharge}
        onChange={next => set({ feeds: { ...draft.feeds, discharge: next } })} />
    </div>

    {error ? <div className={errorBox}>{error}</div> : null}
    {note ? <div className={okBox}>{note}</div> : null}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={primary} disabled={busy !== "" || !draft.name.trim()} onClick={() => void save()}>{busy === "save" ? "Saving…" : row ? "Save destination" : "Create destination"}</button>
      {row ? <button type="button" className={secondary} disabled={busy !== ""} onClick={() => void remove()}>{busy === "delete" ? "Deleting…" : "Delete"}</button> : null}
    </div>

    {row ? <div className="border-t border-[var(--app-border)] pt-5">
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Test send</div>
      <p className="mb-3 text-xs text-[var(--app-muted)]">Builds and sends one message now with the saved settings, even while the destination is disabled. It is logged as "test".</p>
      <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto]">
        <select className={inputClass} value={testKind} onChange={event => setTestKind(event.target.value as OutboundKind)}>{KINDS.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select>
        <select className={inputClass} value={testCaseId} onChange={event => setTestCaseId(event.target.value)}>
          <option value="">Latest case in its wards</option>
          {testCases.map(item => <option key={item.case_id} value={item.case_id}>{item.case_code || item.case_id} · {item.status} · {item.ward || "—"} / {item.bed || "—"}</option>)}
        </select>
        <button type="button" className={`${secondary} mt-1`} disabled={busy !== ""} onClick={() => void runTest()}>{busy === "test" ? "Sending…" : "Send test"}</button>
      </div>
      {test ? <div className={`mt-3 ${test.ok ? okBox : errorBox}`}>
        <div className="font-semibold">{test.ok ? "Accepted by the receiver" : `Not delivered: ${test.error || "unknown error"}`}</div>
        {test.note ? <div className="mt-1 text-xs">{test.note}</div> : null}
        {test.response ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{test.response.replace(/\r/g, "\n")}</pre> : null}
      </div> : null}
    </div> : null}
  </section>;
}

/* ------------------------------------------------------------------ message log */

function MessageLog({ destinations, refreshKey }: { destinations: OutboundDestination[]; refreshKey: number }) {
  const [rows, setRows] = useState<OutboundMessageRow[]>([]);
  const [destinationId, setDestinationId] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<OutboundMessageDetail | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try { setRows((await listOutboundMessages({ destination_id: destinationId, status, kind, limit: 200 })).rows); setError(""); }
    catch (reason) { setError(message(reason, "Unable to load the message log.")); }
  }, [destinationId, status, kind]);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), LOG_REFRESH_MS); return () => window.clearInterval(timer); }, [load, refreshKey]);

  const open = async (id: string) => {
    try { setDetail(await getOutboundMessage(id)); } catch (reason) { setError(message(reason, "Unable to open the message.")); }
  };
  const act = async (id: string, action: "resend" | "cancel") => {
    setBusy(id);
    try { await (action === "resend" ? resendOutboundMessage(id) : cancelOutboundMessage(id)); await load(); if (detail?.id === id) await open(id); }
    catch (reason) { setError(message(reason, `Unable to ${action}.`)); }
    finally { setBusy(""); }
  };

  return <section className={card}>
    <SectionTitle title="Message log" subtitle={`Queued and sent messages, newest first. Refreshes every ${LOG_REFRESH_MS / 1000} seconds. Failed messages retry with backoff (1 min doubling to 1 h, 10 attempts); a message the receiver rejects (AR / HTTP 4xx) stops.`}>
      <select className={`${small} py-1.5`} value={destinationId} onChange={event => setDestinationId(event.target.value)}><option value="">All destinations</option>{destinations.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <select className={`${small} py-1.5`} value={kind} onChange={event => setKind(event.target.value)}><option value="">All kinds</option>{[...KINDS.map(k => k.kind), "test"].map(k => <option key={k} value={k}>{k}</option>)}</select>
      <select className={`${small} py-1.5`} value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{MESSAGE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select>
    </SectionTitle>
    {error ? <div className={`${errorBox} mb-3`}>{error}</div> : null}
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="text-xs uppercase tracking-[0.08em] text-[var(--app-muted)]"><tr>
          <th className="px-2 py-2">#</th><th className="px-2 py-2">Destination</th><th className="px-2 py-2">Kind</th><th className="px-2 py-2">Case</th>
          <th className="px-2 py-2">Status</th><th className="px-2 py-2">Due / sent</th><th className="px-2 py-2">Detail</th><th className="px-2 py-2" />
        </tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className="border-t border-[var(--app-border)] align-top text-[var(--app-text)]">
          <td className="px-2 py-2 font-mono text-xs">{row.control_id || row.id}</td>
          <td className="px-2 py-2">{row.destination_name}</td>
          <td className="px-2 py-2">{row.kind}{row.period_start ? <span className="block text-xs text-[var(--app-muted)]">{clock(row.period_start)}–{clock(row.period_end)}</span> : null}</td>
          <td className="px-2 py-2 font-mono text-xs">{row.case_code || row.case_id?.slice(0, 8) || "—"}</td>
          <td className="px-2 py-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadge(row.status)}`}>{row.status}</span>{row.attempts > 1 ? <span className="ml-1 text-xs text-[var(--app-muted)]">×{row.attempts}</span> : null}</td>
          <td className="px-2 py-2 text-xs">{row.sent_at ? formatTime(row.sent_at) : row.status === "pending" || row.status === "error" ? `due ${formatTime(row.next_attempt_at)}` : formatTime(row.created_at)}</td>
          <td className="max-w-[260px] truncate px-2 py-2 text-xs text-[var(--app-muted)]" title={row.error || row.message_type || ""}>{row.error || row.message_type || "—"}</td>
          <td className="whitespace-nowrap px-2 py-2 text-right">
            <button type="button" className={small} onClick={() => void open(row.id)}>View</button>
            {row.kind !== "test" && row.status !== "pending" ? <button type="button" className={`${small} ml-1`} disabled={busy === row.id} onClick={() => void act(row.id, "resend")}>{row.status === "sent" ? "Resend" : "Retry"}</button> : null}
            {row.status === "pending" || row.status === "error" ? <button type="button" className={`${small} ml-1`} disabled={busy === row.id} onClick={() => void act(row.id, "cancel")}>Cancel</button> : null}
          </td>
        </tr>)}</tbody>
      </table>
      {!rows.length ? <div className="px-4 py-10 text-center text-sm text-[var(--app-muted)]">No messages yet.</div> : null}
    </div>
    {detail ? <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-[var(--app-text)]">{detail.control_id || detail.id} · {detail.message_type || detail.kind} · {detail.destination_name} <span className="text-xs font-normal text-[var(--app-muted)]">({detail.identity} identity)</span></div>
        <button type="button" className={small} onClick={() => setDetail(null)}>Close</button>
      </div>
      {detail.error ? <div className={`${errorBox} mb-2`}>{detail.error}</div> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <div><div className={labelClass}>Message (patient identifiers masked, PDF shortened)</div><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--app-panel-bg)] p-3 font-mono text-[11px] text-[var(--app-text)]">{detail.payload || "— not built yet —"}</pre></div>
        <div><div className={labelClass}>Response</div><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--app-panel-bg)] p-3 font-mono text-[11px] text-[var(--app-text)]">{(detail.response || "—").replace(/\r/g, "\n")}</pre></div>
      </div>
    </div> : null}
  </section>;
}

/* ------------------------------------------------------------------ panel */

export default function CanopyOutboundPanel() {
  const [rows, setRows] = useState<OutboundDestination[]>([]);
  const [wards, setWards] = useState<OutboundWard[]>([]);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async (select?: string | "new" | null) => {
    try {
      const data = await getOutbound();
      setRows(data.rows); setWards(data.wards); setError("");
      setSelected(current => (select !== undefined ? select : current) ?? data.rows[0]?.id ?? "new");
    } catch (reason) { setError(message(reason, "Unable to load the outbound interface.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const current = useMemo(() => rows.find(row => row.id === selected) || null, [rows, selected]);
  const wardName = (key: string) => wards.find(ward => ward.key === key)?.name || key;

  return <div className="space-y-4">
    {error ? <div className={errorBox}>{error}</div> : null}
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,.7fr)_minmax(480px,1.3fr)]">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3 px-1">
          <div><h2 className="font-semibold text-[var(--app-text)]">Outbound destinations</h2><p className="text-xs text-[var(--app-muted)]">Send vitals and case records to the HIS, a data warehouse or a FHIR server.</p></div>
          <button type="button" className={secondary} onClick={() => setSelected("new")}>+ Destination</button>
        </div>
        {rows.map(row => <button key={row.id} type="button" onClick={() => setSelected(row.id)} className={`w-full rounded-2xl border p-4 text-left ${selected === row.id ? "border-[var(--app-accent)] bg-[var(--app-hover-bg)]" : "border-[var(--app-border)] bg-[var(--app-panel-bg)]"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><div className="truncate font-semibold text-[var(--app-text)]">{row.name}</div>
              <div className="truncate text-xs text-[var(--app-muted)]">{row.format === "fhir" ? `FHIR · ${row.url || "no URL"}` : `HL7 ${row.hl7_version} · ${row.tls ? "TLS · " : ""}${row.host || "?"}:${row.port || "?"}`}</div></div>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${row.enabled ? statusBadge("sent") : statusBadge("cancelled")}`}>{row.enabled ? "on" : "off"}</span>
          </div>
          <div className="mt-2 truncate text-xs text-[var(--app-muted)]">{row.unit_keys.includes("*") ? "All wards" : row.unit_keys.map(wardName).join(", ")} · {row.identity} identity</div>
          <div className="mt-1 truncate text-xs text-[var(--app-muted)]">{feedSummary(row)}</div>
          <div className="mt-2 flex gap-3 text-xs text-[var(--app-muted)]"><span>{row.sent_24h} sent / 24 h</span>{row.queued ? <span>{row.queued} queued</span> : null}{row.failed_24h ? <span className="text-rose-600 dark:text-rose-300">{row.failed_24h} failed</span> : null}</div>
        </button>)}
        {!loading && !rows.length ? <div className="rounded-2xl border border-dashed border-[var(--app-border)] px-6 py-12 text-center text-sm text-[var(--app-muted)]">No destinations yet. Add one to start sending.</div> : null}
      </section>
      {selected ? <DestinationEditor key={selected} row={current} wards={wards}
        onSaved={next => { void load(next.id); setRefreshKey(key => key + 1); }}
        onDeleted={() => void load(null)} /> : null}
    </div>
    <MessageLog destinations={rows} refreshKey={refreshKey} />
  </div>;
}
