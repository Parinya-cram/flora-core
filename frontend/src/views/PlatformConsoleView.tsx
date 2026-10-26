import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuthUser } from "../auth/useAuth";
import canopyLogo from "../assets/logos/canopyicon.png";
import ThemePicker from "../components/ThemePicker";
import {
  createAccount,
  listAccounts,
  migrateAccounts,
  rotateSecret,
  updateAccount,
  type PlatformAccount,
} from "../api/platformApi";

type Props = { user: AuthUser; onLogout: () => void };

const inputClass = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";
const buttonClass = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text)] hover:bg-[var(--app-control-bg-hover)] disabled:opacity-50";
const primaryClass = "rounded-lg bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] hover:brightness-110 disabled:opacity-50";

/** Shown once: a new account's (or rotated) sync secret for its Leafs and Haber. */
function SecretNotice({ code, secret, onClose }: { code: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return <div role="alert" className="rounded-xl border border-amber-400/50 bg-amber-500/10 p-4 text-sm text-[var(--app-text)]">
    <div className="font-bold">Sync secret for {code}: shown this once</div>
    <p className="mt-1 text-xs text-[var(--app-muted)]">Set it as FLORA_SYNC_SHARED_SECRET on this account's Leafs and Haber. Flora keeps only a hash.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-lg bg-[var(--app-control-bg)] px-3 py-2 font-mono text-xs">{secret}</code>
      <button type="button" className={buttonClass} onClick={() => { void navigator.clipboard?.writeText(secret).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy"}</button>
      <button type="button" className={buttonClass} onClick={onClose}>I have stored it</button>
    </div>
  </div>;
}

function CreateAccountForm({ onCreated }: { onCreated: (code: string, secret: string) => void }) {
  const [form, setForm] = useState({ code: "", name: "", admin_username: "admin", admin_password: "", haber_url: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (value: string) => setForm(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await createAccount({ ...form, haber_url: form.haber_url.trim() || undefined });
      onCreated(result.code, result.sync_secret);
      setForm({ code: "", name: "", admin_username: "admin", admin_password: "", haber_url: "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not create the account");
    } finally {
      setBusy(false);
    }
  };
  return <form onSubmit={submit} className="grid gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4 sm:grid-cols-2">
    <h2 className="text-sm font-bold text-[var(--app-text)] sm:col-span-2">New account</h2>
    <label className="text-xs font-semibold text-[var(--app-muted)]">Code
      <input className={`${inputClass} mt-1 font-mono`} value={form.code} required pattern="[a-z][a-z0-9_]{1,30}" placeholder="hospital_code"
        onChange={event => set("code")(event.target.value.toLowerCase().replace(/\s/g, ""))} />
    </label>
    <label className="text-xs font-semibold text-[var(--app-muted)]">Hospital name
      <input className={`${inputClass} mt-1`} value={form.name} required onChange={event => set("name")(event.target.value)} />
    </label>
    <label className="text-xs font-semibold text-[var(--app-muted)]">First administrator
      <input className={`${inputClass} mt-1`} value={form.admin_username} required autoComplete="off" onChange={event => set("admin_username")(event.target.value)} />
    </label>
    <label className="text-xs font-semibold text-[var(--app-muted)]">Temporary password (changed at first sign-in)
      <input className={`${inputClass} mt-1`} type="password" value={form.admin_password} required minLength={8} autoComplete="new-password" onChange={event => set("admin_password")(event.target.value)} />
    </label>
    <label className="text-xs font-semibold text-[var(--app-muted)] sm:col-span-2">Haber URL (optional)
      <input className={`${inputClass} mt-1 font-mono`} value={form.haber_url} placeholder="http://haber.hospital.local:8000" onChange={event => set("haber_url")(event.target.value)} />
    </label>
    {error ? <p role="alert" className="text-xs text-rose-500 sm:col-span-2">{error}</p> : null}
    <div className="sm:col-span-2"><button type="submit" className={primaryClass} disabled={busy}>{busy ? "Creating schema…" : "Create account"}</button></div>
  </form>;
}

function AccountRow({ account, onChanged, onSecret }: { account: PlatformAccount; onChanged: () => void; onSecret: (code: string, secret: string) => void }) {
  const [haber, setHaber] = useState(account.haber_url || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed");
    } finally {
      setBusy(false);
    }
  };
  const suspended = account.status !== "active";
  const behind = account.migrations < account.migrations_total;
  return <tr className="border-t border-[var(--app-border)] align-top">
    <td className="px-3 py-3"><div className="font-mono text-sm font-bold text-[var(--app-text)]">{account.code}</div><div className="text-xs text-[var(--app-muted)]">{account.schema_name}</div></td>
    <td className="px-3 py-3 text-sm text-[var(--app-text)]">{account.name}</td>
    <td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${suspended ? "bg-rose-500/15 text-rose-500" : "bg-emerald-500/15 text-emerald-500"}`}>{account.status}</span></td>
    <td className={`px-3 py-3 text-xs tabular-nums ${behind ? "font-bold text-amber-500" : "text-[var(--app-muted)]"}`}>{account.migrations}/{account.migrations_total}</td>
    <td className="px-3 py-3">
      <div className="flex gap-1">
        <input className={`${inputClass} min-w-[180px] py-1 font-mono text-xs`} value={haber} placeholder="none" onChange={event => setHaber(event.target.value)} aria-label={`Haber URL of ${account.code}`} />
        {haber !== (account.haber_url || "") ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => updateAccount(account.code, { haber_url: haber.trim() }))}>Save</button> : null}
      </div>
      {error ? <p className="mt-1 text-xs text-rose-500">{error}</p> : null}
    </td>
    <td className="px-3 py-3">
      <div className="flex flex-wrap justify-end gap-1">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => {
          if (window.confirm(`Rotate the sync secret of ${account.code}? Its Leafs and Haber stop syncing until they get the new one.`)) {
            void run(async () => onSecret(account.code, (await rotateSecret(account.code)).sync_secret));
          }
        }}>Rotate secret</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => {
          if (suspended || window.confirm(`Suspend ${account.code}? Its users are signed out and its Leafs stop syncing.`)) {
            void run(() => updateAccount(account.code, { status: suspended ? "active" : "suspended" }));
          }
        }}>{suspended ? "Activate" : "Suspend"}</button>
      </div>
    </td>
  </tr>;
}

export default function PlatformConsoleView({ user, onLogout }: Props) {
  const [rows, setRows] = useState<PlatformAccount[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [secret, setSecret] = useState<{ code: string; secret: string } | null>(null);
  const [migrating, setMigrating] = useState(false);

  const load = useCallback(() => {
    listAccounts().then(data => { setRows(data.rows); setError(""); }).catch(cause => setError(cause instanceof Error ? cause.message : "could not load accounts"));
  }, []);
  useEffect(() => { load(); }, [load]);

  const migrate = async () => {
    setMigrating(true);
    setNotice("");
    try {
      const { applied } = await migrateAccounts();
      const changed = Object.entries(applied).filter(([, files]) => files.length);
      setNotice(changed.length ? changed.map(([code, files]) => `${code}: ${files.length} file(s)`).join(" · ") : "Every account is up to date.");
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "migration failed");
    } finally {
      setMigrating(false);
    }
  };

  return <div className="app-shell app-theme-scope min-h-screen bg-[var(--app-bg)] font-sans text-[var(--app-text)]">
    <header className="app-topbar flex h-14 items-center gap-3 border-b px-4">
      <img src={canopyLogo} alt="" className="h-9 w-9 object-contain [image-rendering:pixelated]" />
      <div className="leading-tight"><div className="text-[15px] font-extrabold">Canopy platform</div><div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--app-muted)]">Accounts</div></div>
      <div className="ml-auto flex items-center gap-2">
        <ThemePicker compact />
        <span className="hidden text-xs text-[var(--app-muted)] sm:inline">@{user.username}</span>
        <button type="button" className={buttonClass} onClick={onLogout}>Sign out</button>
      </div>
    </header>
    <main className="w-full space-y-4 p-4 md:p-6">
      <p className="text-sm text-[var(--app-muted)]">Each account is one hospital with its own database schema. Platform administrators manage accounts here but cannot open any account's patients or settings.</p>
      {secret ? <SecretNotice code={secret.code} secret={secret.secret} onClose={() => setSecret(null)} /> : null}
      {error ? <p role="alert" className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-500">{error}</p> : null}
      <section className="overflow-x-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)]">
        <div className="flex items-center gap-3 px-4 py-3">
          <h2 className="text-sm font-bold">Accounts <span className="font-normal text-[var(--app-muted)]">({rows.length})</span></h2>
          {notice ? <span className="text-xs text-[var(--app-muted)]">{notice}</span> : null}
          <button type="button" className={`${buttonClass} ml-auto`} disabled={migrating} onClick={() => void migrate()}>{migrating ? "Migrating…" : "Apply migrations to all"}</button>
        </div>
        <table className="w-full min-w-[820px] text-left">
          <thead className="text-[11px] uppercase tracking-wide text-[var(--app-muted)]"><tr>
            <th className="px-3 py-2">Code</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Schema</th><th className="px-3 py-2">Haber</th><th className="px-3 py-2" />
          </tr></thead>
          <tbody>{rows.map(account => <AccountRow key={`${account.code}:${account.haber_url ?? ""}`} account={account} onChanged={load} onSecret={(code, value) => setSecret({ code, secret: value })} />)}</tbody>
        </table>
      </section>
      <CreateAccountForm onCreated={(code, value) => { setSecret({ code, secret: value }); load(); }} />
    </main>
  </div>;
}
