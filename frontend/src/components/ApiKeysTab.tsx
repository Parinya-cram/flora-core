import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createApiKey,
  getApiKeyScopes,
  listApiKeys,
  listApiLogs,
  listApiWardOptions,
  revokeApiKey,
  type ApiKeyRow,
  type ApiKeyScopesInfo,
  type ApiLogRow,
  type ApiWardOption,
} from "../api/apiKeysApi";
import ConfirmDialog from "./common/ConfirmDialog";

const LOG_REFRESH_MS = 10_000;
const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
  { value: "", label: "Never" },
];
const REST_ENDPOINTS: Array<[string, string]> = [
  ["GET /me", "The key itself: name, scopes, ward limit"],
  ["GET /wards", "Wards the key may read"],
  ["GET /cases?ward&status&hn&since&until&limit&offset", "Search cases"],
  ["GET /cases/{id}", "Case summary"],
  ["GET /cases/{id}/vitals?parameters&interval&since&until", "Vital signs (vitals:read)"],
  ["GET /cases/{id}/events", "Case events"],
  ["GET /cases/{id}/medications", "Medications"],
  ["GET /cases/{id}/forms", "Clinical forms (forms:read)"],
  ["GET /admissions", "Admissions (admissions:read)"],
  ["POST /admissions", "Create an admission (admissions:write)"],
];
const MCP_TOOLS = ["list_wards", "search_cases", "get_case", "get_vitals", "get_case_events", "get_medications", "get_case_forms", "list_admissions"];

const card = "rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 space-y-4";
const input = "w-full rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] disabled:opacity-60";
const filterInput = "rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]";
const buttonPrimary = "rounded bg-[var(--app-accent)] px-3 py-2 text-sm font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50";
const buttonSecondary = "rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] disabled:opacity-50";
const buttonSmall = "rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-semibold text-[var(--app-text)] disabled:opacity-50";
const errorBox = "rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-300";
const okBox = "rounded border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300";

const errorText = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

function formatTime(ms: number | null | undefined) {
  if (!ms) return "—";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function statusClass(status: string) {
  if (status === "active") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "expired") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className={buttonSmall} onClick={() => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  }}>{copied ? "Copied" : label}</button>;
}

function Snippet({ title, text }: { title: string; text: string }) {
  return <div>
    <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-semibold text-[var(--app-muted)]">{title}</span><CopyButton text={text} /></div>
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 font-mono text-xs text-[var(--app-text)]">{text}</pre>
  </div>;
}

function Section({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <section className={card}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><div className="text-sm font-semibold text-[var(--app-text)]">{title}</div>{subtitle ? <div className="mt-1 max-w-3xl text-xs text-[var(--app-muted)]">{subtitle}</div> : null}</div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
    {children}
  </section>;
}

/* ------------------------------------------------------------------ connection */

function ConnectionSection({ info }: { info: ApiKeyScopesInfo | null }) {
  const origin = window.location.origin;
  const apiBase = `${origin}${info?.apiBasePath || "/api/v1"}`;
  const docs = `${origin}${info?.docsPath || "/docs"}`;
  const mcp = `${origin}${info?.mcpPath || "/mcp"}`;
  const claudeCmd = `claude mcp add --transport http flora-canopy ${mcp} --header "Authorization: Bearer <key>"`;
  const jsonConfig = JSON.stringify({ mcpServers: { "flora-canopy": { type: "http", url: mcp, headers: { Authorization: "Bearer <key>" } } } }, null, 2);
  const curl = `curl -H "Authorization: Bearer <key>" "${apiBase}/cases?status=active"`;
  const row = (label: string, value: ReactNode, copy?: string) => <div className="flex flex-wrap items-center gap-2 text-sm">
    <span className="w-32 shrink-0 text-xs font-semibold text-[var(--app-muted)]">{label}</span>
    <span className="min-w-0 flex-1 break-all text-[var(--app-text)]">{value}</span>
    {copy ? <CopyButton text={copy} /> : null}
  </div>;
  return <Section title="Connection" subtitle="Read-only access to Canopy data for dashboards, HIS / scheduling systems and AI agents. Each key is limited to its scopes and wards; every call is logged below.">
    <div className="space-y-2">
      {row("REST base URL", <code className="font-mono text-xs">{apiBase}</code>, apiBase)}
      {row("Authentication", <span className="text-xs"><code className="font-mono">Authorization: Bearer flk_…</code> or <code className="font-mono">X-API-Key: flk_…</code></span>)}
      {row("OpenAPI docs", <a className="font-mono text-xs text-[var(--app-accent)] underline" href={docs} target="_blank" rel="noreferrer">{docs}</a>, docs)}
      {row("MCP server", <span className="text-xs"><code className="font-mono">{mcp}</code> <span className="text-[var(--app-muted)]">(Streamable HTTP)</span></span>, mcp)}
      {row("Rate limit", <span className="text-xs">{info ? `${info.rateLimitPerMinute} requests per minute per key` : "—"}</span>)}
    </div>
    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      With the development certificate authority, clients must trust <code className="font-mono">flora-canopy/edge/certs/ca.crt</code> (e.g. <code className="font-mono">NODE_EXTRA_CA_CERTS</code>, <code className="font-mono">curl --cacert</code>) before they can connect over HTTPS.
    </div>
    <div className="grid gap-3 lg:grid-cols-2">
      <Snippet title="Claude Code" text={claudeCmd} />
      <Snippet title="curl" text={curl} />
      <div className="lg:col-span-2"><Snippet title="Generic MCP client config (JSON)" text={jsonConfig} /></div>
    </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div>
        <div className="mb-1 text-xs font-semibold text-[var(--app-muted)]">REST endpoints (relative to the base URL)</div>
        <ul className="divide-y divide-[var(--app-border)] rounded border border-[var(--app-border)] text-xs">
          {REST_ENDPOINTS.map(([path, note]) => <li key={path} className="flex flex-wrap justify-between gap-2 px-3 py-1.5"><code className="font-mono text-[var(--app-text)]">{path}</code><span className="text-[var(--app-muted)]">{note}</span></li>)}
        </ul>
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold text-[var(--app-muted)]">MCP tools (all read-only)</div>
        <div className="flex flex-wrap gap-1.5">{MCP_TOOLS.map(tool => <code key={tool} className="rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 font-mono text-xs text-[var(--app-text)]">{tool}</code>)}</div>
      </div>
    </div>
  </Section>;
}

/* ------------------------------------------------------------------ create */

function CreateKeyModal({ info, wards, onClose, onCreated }: {
  info: ApiKeyScopesInfo | null;
  wards: ApiWardOption[];
  onClose: () => void;
  onCreated: (row: ApiKeyRow, key: string, notice?: string) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["cases:read"]);
  const [allWards, setAllWards] = useState(true);
  const [unitKeys, setUnitKeys] = useState<string[]>([]);
  const [includeDemo, setIncludeDemo] = useState(false);
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(item => item !== value) : [...list, value];
  const invalid = !name.trim() ? "Enter a name." : !scopes.length ? "Choose at least one scope." : !allWards && !unitKeys.length ? "Choose at least one ward." : "";

  const submit = async () => {
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError("");
    try {
      const result = await createApiKey({
        name: name.trim(),
        scopes,
        unit_keys: allWards ? null : unitKeys,
        include_demo: includeDemo,
        expires_in_days: expiry ? Number(expiry) : null,
      });
      onCreated(result.row, result.key, result.notice);
    } catch (reason) { setError(errorText(reason, "Unable to create the API key.")); }
    finally { setBusy(false); }
  };

  return <div className="app-theme-scope fixed inset-0 z-[1100] flex items-stretch justify-center bg-black/55 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Create API key">
    <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-[var(--app-panel-bg)] text-[var(--app-text)] shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:border sm:border-[var(--app-border)]">
      <div className="flex items-center justify-between border-b border-[var(--app-border)] px-5 py-4">
        <h2 className="text-lg font-bold">Create API key</h2>
        <button type="button" onClick={onClose} className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] text-xl" aria-label="Close">×</button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <label className="block text-xs font-semibold text-[var(--app-muted)]">Name<input className={`${input} mt-1`} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. ICU dashboard, AI agent" maxLength={120} autoFocus /></label>
        <div>
          <div className="mb-2 text-xs font-semibold text-[var(--app-muted)]">Scopes</div>
          <div className="space-y-1.5">
            {(info?.scopes || []).map(scope => <label key={scope.code} className="flex items-start gap-3 rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm">
              <input type="checkbox" className="mt-1" checked={scopes.includes(scope.code)} onChange={() => setScopes(current => toggle(current, scope.code))} />
              <span><code className="font-mono text-xs font-semibold">{scope.code}</code><span className="block text-xs text-[var(--app-muted)]">{scope.label}</span></span>
            </label>)}
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold text-[var(--app-muted)]">Wards</div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" checked={allWards} onChange={() => setAllWards(true)} />All wards</label>
            <label className="flex items-center gap-2"><input type="radio" checked={!allWards} onChange={() => setAllWards(false)} />Selected wards</label>
          </div>
          {!allWards ? <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {wards.map(ward => <label key={ward.key} className="flex items-center gap-2 rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm">
              <input type="checkbox" checked={unitKeys.includes(ward.key)} onChange={() => setUnitKeys(current => toggle(current, ward.key))} />
              <span className="min-w-0 truncate">{ward.name}{ward.isDemo ? " (demo)" : ""}{ward.buildingName ? <span className="text-xs text-[var(--app-muted)]"> – {ward.buildingName}</span> : null}</span>
            </label>)}
          </div> : null}
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={includeDemo} onChange={event => setIncludeDemo(event.target.checked)} />Include demo ward data</label>
        </div>
        <label className="block text-xs font-semibold text-[var(--app-muted)]">Expires after
          <select className={`${input} mt-1`} value={expiry} onChange={event => setExpiry(event.target.value)}>{EXPIRY_OPTIONS.map(option => <option key={option.label} value={option.value}>{option.label}</option>)}</select>
        </label>
        {error ? <div className={errorBox}>{error}</div> : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--app-border)] px-5 py-3">
        <button type="button" className={buttonSecondary} onClick={onClose}>Cancel</button>
        <button type="button" className={buttonPrimary} disabled={busy} onClick={() => void submit()}>{busy ? "Creating…" : "Create key"}</button>
      </div>
    </div>
  </div>;
}

function NewKeyModal({ name, secret, notice, onClose }: { name: string; secret: string; notice?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div className="app-theme-scope fixed inset-0 z-[1100] flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-label="New API key">
    <div className="w-full max-w-xl space-y-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5 text-[var(--app-text)] shadow-2xl">
      <h2 className="text-lg font-bold">API key created — {name}</h2>
      <div className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
        <strong>Copy this key now — it is shown only once.</strong> {notice || "Canopy stores only its hash and cannot show it again."} If it is lost, revoke it and create a new one. Treat it like a password.
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2.5 font-mono text-sm">{secret}</code>
        <button type="button" className={buttonPrimary} onClick={() => { void navigator.clipboard.writeText(secret).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <div className="flex justify-end"><button type="button" className={buttonSecondary} onClick={onClose}>{copied ? "Done" : "I have stored the key"}</button></div>
    </div>
  </div>;
}

/* ------------------------------------------------------------------ keys */

function KeysSection({ info, wards, keys, onChanged }: { info: ApiKeyScopesInfo | null; wards: ApiWardOption[]; keys: ApiKeyRow[]; onChanged: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; secret: string; notice?: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const wardNames = useMemo(() => new Map(wards.map(ward => [ward.key, ward.name])), [wards]);

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setBusy(true); setError("");
    try { await revokeApiKey(revokeTarget.id); setNote(`Key “${revokeTarget.name}” revoked.`); setRevokeTarget(null); await onChanged(); }
    catch (reason) { setError(errorText(reason, "Unable to revoke the key.")); setRevokeTarget(null); }
    finally { setBusy(false); }
  };

  return <Section title="API keys" actions={<button type="button" className={buttonPrimary} disabled={!info} onClick={() => { setNote(""); setCreating(true); }}>Create API key</button>}>
    <div className="overflow-x-auto rounded border border-[var(--app-border)]">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-[var(--app-control-bg)] text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Key</th><th className="px-3 py-2">Scopes</th><th className="px-3 py-2">Wards</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Created</th><th className="px-3 py-2">Expires</th><th className="px-3 py-2">Last used</th><th className="px-3 py-2 text-right">24 h</th><th className="px-3 py-2" /></tr></thead>
        <tbody>
          {keys.map(row => <tr key={row.id} className={`border-t border-[var(--app-border)] align-top ${row.status !== "active" ? "opacity-60" : ""}`}>
            <td className="px-3 py-2 font-semibold text-[var(--app-text)]">{row.name}{row.createdBy ? <div className="text-[11px] font-normal text-[var(--app-muted)]">by {row.createdBy}</div> : null}</td>
            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--app-muted)]">flk_{row.prefix}_…</td>
            <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{row.scopes.map(scope => <code key={scope} className="rounded bg-[var(--app-control-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--app-text)]">{scope}</code>)}</div></td>
            <td className="px-3 py-2 text-xs text-[var(--app-text)]">{row.unitKeys == null ? "All wards" : row.unitKeys.map(key => wardNames.get(key) || key).join(", ")}{row.includeDemo ? <span className="text-[var(--app-muted)]"> + demo</span> : null}</td>
            <td className="px-3 py-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusClass(row.status)}`}>{row.status}</span></td>
            <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--app-muted)]">{formatTime(row.createdAt)}</td>
            <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--app-muted)]">{row.revokedAt ? `revoked ${formatTime(row.revokedAt)}` : row.expiresAt ? formatTime(row.expiresAt) : "Never"}</td>
            <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--app-muted)]">{formatTime(row.lastUsedAt)}</td>
            <td className="px-3 py-2 text-right text-xs tabular-nums text-[var(--app-text)]">{row.requestCount24h}</td>
            <td className="px-3 py-2 text-right">{row.status === "active" ? <button type="button" className={`${buttonSmall} text-rose-600 dark:text-rose-300`} onClick={() => setRevokeTarget(row)}>Revoke</button> : null}</td>
          </tr>)}
          {!keys.length ? <tr><td colSpan={10} className="px-3 py-6 text-center text-sm text-[var(--app-muted)]">No API keys yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
    {error ? <div className={errorBox}>{error}</div> : null}
    {note ? <div className={okBox}>{note}</div> : null}
    {creating ? <CreateKeyModal info={info} wards={wards} onClose={() => setCreating(false)} onCreated={(row, secret, notice) => {
      setCreating(false);
      setCreated({ name: row.name, secret, notice });
      void onChanged();
    }} /> : null}
    {created ? <NewKeyModal name={created.name} secret={created.secret} notice={created.notice} onClose={() => setCreated(null)} /> : null}
    <ConfirmDialog
      open={Boolean(revokeTarget)}
      title="Revoke this API key?"
      message={revokeTarget ? `“${revokeTarget.name}” (flk_${revokeTarget.prefix}_…) stops working immediately. This cannot be undone.` : ""}
      confirmLabel="Revoke key"
      busy={busy}
      onCancel={() => setRevokeTarget(null)}
      onConfirm={() => void confirmRevoke()}
    />
  </Section>;
}

/* ------------------------------------------------------------------ access log */

function AccessLogSection({ keys, refreshKey }: { keys: ApiKeyRow[]; refreshKey: number }) {
  const [keyId, setKeyId] = useState("");
  const [status, setStatus] = useState<"" | "ok" | "error">("");
  const [mcpOnly, setMcpOnly] = useState(false);
  const [caseInput, setCaseInput] = useState("");
  const [caseId, setCaseId] = useState("");
  const [rows, setRows] = useState<ApiLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setRows(await listApiLogs({ keyId, status, mcpOnly, caseId, limit: 200 })); setError(""); }
    catch (reason) { setError(errorText(reason, "Unable to load the access log.")); }
    finally { setLoading(false); }
  }, [keyId, status, mcpOnly, caseId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), LOG_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  return <Section title="Access log" subtitle="Every REST and MCP call made with an API key. Refreshes every 10 seconds." actions={<button type="button" className={buttonSecondary} onClick={() => void load()}>{loading ? "Loading…" : "Refresh"}</button>}>
    <div className="flex flex-wrap items-center gap-2">
      <select className={filterInput} value={keyId} onChange={event => setKeyId(event.target.value)} aria-label="Filter by key">
        <option value="">All keys</option>
        {keys.map(key => <option key={key.id} value={key.id}>{key.name} (flk_{key.prefix})</option>)}
      </select>
      <select className={filterInput} value={status} onChange={event => setStatus(event.target.value as "" | "ok" | "error")} aria-label="Filter by result">
        <option value="">OK and errors</option>
        <option value="ok">OK only</option>
        <option value="error">Errors only</option>
      </select>
      <label className="flex items-center gap-2 rounded border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)]"><input type="checkbox" checked={mcpOnly} onChange={event => setMcpOnly(event.target.checked)} />MCP only</label>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setCaseId(caseInput.trim()); }}>
        <input className={`${filterInput} w-64`} value={caseInput} onChange={event => setCaseInput(event.target.value)} placeholder="Case id" aria-label="Filter by case id" />
        <button type="submit" className={buttonSmall}>Filter</button>
        {caseId ? <button type="button" className={buttonSmall} onClick={() => { setCaseId(""); setCaseInput(""); }}>Clear</button> : null}
      </form>
    </div>
    <div className="overflow-x-auto rounded border border-[var(--app-border)]">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="bg-[var(--app-control-bg)] text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]"><tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Key</th><th className="px-3 py-2">Client / tool</th><th className="px-3 py-2">Request</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">ms</th><th className="px-3 py-2 text-right">Cases</th><th className="px-3 py-2">IP</th></tr></thead>
        <tbody>
          {rows.map(row => {
            const ok = row.status < 400;
            return <tr key={row.id} className="border-t border-[var(--app-border)] align-top">
              <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--app-muted)]">{formatTime(row.at)}</td>
              <td className="px-3 py-2 text-xs"><div className="font-semibold text-[var(--app-text)]">{row.keyName || "—"}</div>{row.keyPrefix ? <div className="font-mono text-[var(--app-muted)]">flk_{row.keyPrefix}</div> : null}</td>
              <td className="px-3 py-2 text-xs">{row.client === "mcp" ? <span className="inline-flex items-center gap-1.5"><span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-violet-700 dark:text-violet-300">MCP</span>{row.tool ? <code className="font-mono text-[var(--app-text)]">{row.tool}</code> : null}</span> : <span className="text-[var(--app-muted)]" title={row.userAgent || ""}>{row.client || "REST"}</span>}</td>
              <td className="max-w-[360px] px-3 py-2 font-mono text-xs text-[var(--app-text)]"><span className="font-bold">{row.method}</span> <span className="break-all">{row.path}{row.query ? `?${row.query}` : ""}</span>{row.error ? <div className="mt-0.5 font-sans text-rose-600 dark:text-rose-300">{row.error}</div> : null}</td>
              <td className="px-3 py-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${ok ? statusClass("active") : statusClass("revoked")}`}>{row.status}</span></td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-[var(--app-muted)]">{row.durationMs ?? "—"}</td>
              <td className="px-3 py-2 text-right text-xs tabular-nums text-[var(--app-text)]" title={row.caseIds.length ? row.caseIds.join("\n") : undefined}>{row.caseIds.length ? <span className="cursor-help underline decoration-dotted">{row.caseIds.length}</span> : "—"}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--app-muted)]">{row.ip || "—"}</td>
            </tr>;
          })}
          {!rows.length ? <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-[var(--app-muted)]">{loading ? "Loading…" : "No requests match."}</td></tr> : null}
        </tbody>
      </table>
    </div>
    {error ? <div className={errorBox}>{error}</div> : null}
  </Section>;
}

/** Canopy admin: public REST API / MCP keys and their access log. */
export default function ApiKeysTab() {
  const [info, setInfo] = useState<ApiKeyScopesInfo | null>(null);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [wards, setWards] = useState<ApiWardOption[]>([]);
  const [error, setError] = useState("");
  const [logKey, setLogKey] = useState(0);

  const loadKeys = useCallback(async () => {
    try { setKeys(await listApiKeys()); setError(""); }
    catch (reason) { setError(errorText(reason, "Unable to load API keys.")); }
    setLogKey(value => value + 1);
  }, []);

  useEffect(() => {
    getApiKeyScopes().then(setInfo).catch(reason => setError(errorText(reason, "Unable to load API settings.")));
    listApiWardOptions().then(setWards).catch(() => setWards([]));
    listApiKeys().then(setKeys).catch(reason => setError(errorText(reason, "Unable to load API keys.")));
  }, []);

  return <div className="space-y-4 p-4">
    {error ? <div className={errorBox}>{error}</div> : null}
    <ConnectionSection info={info} />
    <KeysSection info={info} wards={wards} keys={keys} onChanged={loadKeys} />
    <AccessLogSection keys={keys} refreshKey={logKey} />
  </div>;
}
