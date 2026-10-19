import { useCallback, useEffect, useMemo, useState } from "react";
import {
  approveRelease, getDistributionOverview, holdComponent, mirrorRelease, rootSync,
  getDistSettings, saveDistSettings,
  type DistributionOverview, type DistributionNode, type ReleaseRow,
} from "../api/deviceDistributionApi";

// Haber Root/registry config, editable here instead of env/kubectl (user: config via UI, not env).
const SETTING_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "root_url", label: "Root URL", placeholder: "http://root-api.flora-root.svc.cluster.local:8000" },
  { key: "root_registry_url", label: "Root registry URL (mirror source)", placeholder: "http://root-registry.flora-root.svc.cluster.local:5000" },
  { key: "registry_public", label: "Hospital registry (nodes pull)", placeholder: "172.22.19.81:7205" },
  { key: "canopy_sync_url", label: "Canopy sync URL", placeholder: "http://sync-api.flora-canopy.svc.cluster.local:8000" },
  { key: "tenant_id", label: "Tenant ID", placeholder: "hospital-01" },
  { key: "sync_interval", label: "Root sync interval (s)", placeholder: "15" },
];

function HaberSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<Record<string, { overridden?: boolean }>>({});
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const reload = useCallback(async () => {
    try {
      const data = await getDistSettings();
      const v: Record<string, string> = {}, m: Record<string, { overridden?: boolean }> = {};
      for (const f of SETTING_FIELDS) {
        const s = data.settings?.[f.key];
        v[f.key] = s && s.value != null ? String(s.value) : "";
        m[f.key] = { overridden: s?.overridden };
      }
      setValues(v); setMeta(m);
    } catch { /* leave blank */ }
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, reload]);

  const save = async () => {
    setSaving(true); setMsg("");
    try {
      await saveDistSettings(values);
      setMsg("Saved · takes effect at once");
      await reload();
    } catch (reason) {
      setMsg(reason instanceof Error ? reason.message : "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <section className="mb-5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-bold">Registry &amp; Root settings</span>
        <span className="text-xs text-[var(--app-muted)]">{open ? "hide" : "configure"}</span>
      </button>
      {open ? (
        <div className="border-t border-[var(--app-border)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {SETTING_FIELDS.map((f) => (
              <label key={f.key} className="text-xs text-[var(--app-muted)]">
                {f.label} {meta[f.key]?.overridden ? <span className="text-[var(--app-accent)]">· custom</span> : <span>· default</span>}
                <input value={values[f.key] ?? ""} placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1.5 text-sm text-[var(--app-text)]" />
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" disabled={saving} onClick={() => void save()}
              className="rounded-lg border border-[var(--app-accent)] bg-[var(--app-accent)] px-3 py-1.5 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50">Save settings</button>
            <span className="text-[11px] text-[var(--app-muted)]">Blank a field to reset it to the env default. Stored in Haber, applied live.</span>
            {msg ? <span className="text-xs text-[var(--app-muted)]">{msg}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// Device Distribution console (Canopy admin): the Root -> Canopy -> node image rollout.
// Root publishes a release -> Haber mirrors it to the hospital registry -> an admin approves
// it -> each node's updater pulls and applies it. Everything here proxies to Haber; nothing
// touches patient data. Loaded under the System menu.

const POLL_MS = 15_000;
const COMPONENTS = ["canopy", "gateway", "leaf"] as const;

const mirrorBadge: Record<string, string> = {
  ready: "bg-emerald-600 text-white",
  mirroring: "bg-sky-500 text-white",
  pending: "bg-amber-400 text-black",
  failed: "bg-rose-600 text-white",
  idle: "bg-slate-500 text-white",
};
const nodeBadge: Record<string, string> = {
  ok: "bg-emerald-600 text-white",
  updating: "bg-sky-500 text-white",
  unmanaged: "bg-slate-500 text-white",
  error: "bg-rose-600 text-white",
};

function ago(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function DeviceDistributionView() {
  const [data, setData] = useState<DistributionOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await getDistributionOverview());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Distribution state is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = useCallback(async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setNotice("");
    try {
      await run();
      setNotice(done);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const releases = data?.releases;
  const approvals = releases?.approvals || {};
  const byComponent = useMemo(() => {
    const map: Record<string, ReleaseRow[]> = {};
    for (const row of releases?.rows || []) (map[row.component] ||= []).push(row);
    for (const rows of Object.values(map)) rows.sort((a, b) => b.created_at - a.created_at);
    return map;
  }, [releases]);

  if (loading && !data) {
    return <div className="mx-auto max-w-5xl px-4 py-10 text-center text-sm text-[var(--app-muted)]">Loading distribution state…</div>;
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 text-[var(--app-text)]">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold">Device Distribution</h1>
        <p className="text-xs text-[var(--app-muted)]">
          Image rollout, tier by tier: Root publishes → the hospital mirrors → you approve → each node updates.
        </p>
      </header>

      {error ? <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-400">{error}</div> : null}
      {notice ? <div className="mb-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{notice}</div> : null}

      {/* Tier 1 — Root */}
      <section className="mb-5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold">Root</div>
            <div className="mt-0.5 text-xs text-[var(--app-muted)]">
              <span className={data?.root.verified ? "text-emerald-500" : "text-rose-500"}>
                {data?.root.status === "ok" && data?.root.verified ? "connected · verified" : data?.root.status || "unknown"}
              </span>
              {" · synced "}{ago(data?.root.last_sync)}
              {data?.root.error ? <span className="text-rose-400"> · {data.root.error}</span> : null}
              {releases ? <span> · channel {releases.channel} · registry {releases.registry}</span> : null}
            </div>
            {releases?.mirror ? (
              <div className="mt-1 text-[11px] text-[var(--app-muted)]">
                Mirror worker: <span className="font-medium">{releases.mirror.status}</span>
                {releases.mirror.error ? <span className="text-rose-400"> · {releases.mirror.error}</span> : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => act("root-sync", rootSync, "Root sync requested.")}
            disabled={busy === "root-sync"}
            className="rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--app-accent-contrast)] hover:opacity-90 disabled:opacity-50"
          >{busy === "root-sync" ? "Syncing…" : "Sync from Root"}</button>
        </div>
      </section>

      {/* Tier 2 — Releases (mirror → approve) */}
      <HaberSettings />

      <section className="mb-5">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">Releases — mirror &amp; approve</h2>
        <div className="space-y-4">
          {COMPONENTS.map(component => {
            const rows = byComponent[component] || [];
            const approved = approvals[component];
            const held = !approved;
            return (
              <div key={component} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
                <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-2">
                  <div className="text-sm font-bold capitalize">{component}</div>
                  <div className="flex items-center gap-2 text-[11px] text-[var(--app-muted)]">
                    <span>latest {releases?.latest?.[component] || "—"}</span>
                    {approved ? (
                      <button
                        type="button"
                        onClick={() => act(`hold-${component}`, () => holdComponent(component), `${component}: held on current image.`)}
                        disabled={busy === `hold-${component}`}
                        className="rounded border border-[var(--app-border)] px-2 py-0.5 font-semibold text-[var(--app-text)] hover:border-[var(--app-accent)] disabled:opacity-50"
                      >Hold</button>
                    ) : <span className="rounded bg-slate-500 px-2 py-0.5 font-semibold text-white">no approval</span>}
                  </div>
                </div>
                {rows.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-[var(--app-muted)]">No releases for this component yet.</div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="text-[var(--app-muted)]">
                      <tr>
                        <th className="px-4 py-1.5 font-semibold">Version</th>
                        <th className="px-4 py-1.5 font-semibold">Mirror</th>
                        <th className="px-4 py-1.5 font-semibold">Device types</th>
                        <th className="px-4 py-1.5 font-semibold">Published</th>
                        <th className="px-4 py-1.5 text-right font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => {
                        const ms = row.mirror?.status || "pending";
                        const isApproved = approved === row.release_id;
                        return (
                          <tr key={row.release_id} className="border-t border-[var(--app-border)]">
                            <td className="px-4 py-2 font-medium">
                              {row.version}
                              {isApproved ? <span className="ml-2 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">approved</span> : null}
                            </td>
                            <td className="px-4 py-2">
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${mirrorBadge[ms] || mirrorBadge.pending}`}>{ms}</span>
                              {row.mirror?.error ? <span className="ml-1 text-rose-400" title={row.mirror.error}>!</span> : null}
                            </td>
                            <td className="px-4 py-2 text-[var(--app-muted)]">{row.device_types}</td>
                            <td className="px-4 py-2 text-[var(--app-muted)]">{ago(row.created_at)}</td>
                            <td className="px-4 py-2">
                              <div className="flex justify-end gap-2">
                                {ms !== "ready" ? (
                                  <button type="button" onClick={() => act(`mirror-${row.release_id}`, () => mirrorRelease(row.release_id), `${row.version}: mirror started.`)}
                                    disabled={busy === `mirror-${row.release_id}`}
                                    className="rounded border border-[var(--app-border)] px-2 py-1 font-semibold hover:border-[var(--app-accent)] disabled:opacity-50">
                                    {busy === `mirror-${row.release_id}` ? "…" : "Mirror"}</button>
                                ) : null}
                                {ms === "ready" && !isApproved ? (
                                  <button type="button" onClick={() => act(`approve-${row.release_id}`, () => approveRelease(row.release_id), `${row.version}: approved — nodes will update.`)}
                                    disabled={busy === `approve-${row.release_id}`}
                                    className="rounded bg-[var(--app-accent)] px-2 py-1 font-semibold text-[var(--app-accent-contrast)] hover:opacity-90 disabled:opacity-50">
                                    {busy === `approve-${row.release_id}` ? "…" : approved ? "Switch to this" : "Approve"}</button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {held ? <div className="px-4 py-1.5 text-[11px] text-[var(--app-muted)]">Nodes stay on their current image until a release is approved.</div> : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* Tier 3 — Nodes (applied) */}
      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">Nodes — applied</h2>
        <div className="overflow-hidden rounded-xl border border-[var(--app-border)]">
          <table className="w-full text-left text-xs">
            <thead className="bg-[var(--app-control-bg)] text-[var(--app-muted)]">
              <tr>
                <th className="px-3 py-2 font-semibold">Node</th>
                <th className="px-3 py-2 font-semibold">Component</th>
                <th className="px-3 py-2 font-semibold">State</th>
                <th className="px-3 py-2 font-semibold">Applied → target</th>
                <th className="px-3 py-2 text-right font-semibold">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {(data?.nodes || []).length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-[var(--app-muted)]">No nodes have reported yet.</td></tr>
              ) : (
                (data?.nodes || []).map((node: DistributionNode) => (
                  <tr key={node.node_id} className="border-t border-[var(--app-border)]">
                    <td className="px-3 py-2 font-medium">{node.node_id}</td>
                    <td className="px-3 py-2 text-[var(--app-muted)]">{node.component}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${nodeBadge[node.state] || nodeBadge.unmanaged}`}>{node.state}</span>
                      {node.detail ? <span className="ml-1 text-[var(--app-muted)]" title={node.detail}>ⓘ</span> : null}
                    </td>
                    <td className="px-3 py-2 text-[var(--app-muted)]">
                      {node.release_id || "—"}{node.target && node.target !== node.release_id ? ` → ${node.target}` : ""}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--app-muted)]">{ago(node.last_seen)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-[var(--app-muted)]">
          Approved images are mirrored to the hospital registry, so nodes update and keep running offline once pulled.
        </p>
      </section>
    </div>
  );
}
