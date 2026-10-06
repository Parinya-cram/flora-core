import { useEffect, useMemo, useState } from "react";
import {
  changeOwnPassword,
  createPersonalTheme,
  deletePersonalTheme,
  getPersonalThemes,
  getPreferenceOptions,
  getSelfManagedUser,
  mergeStoredAuthUser,
  savePersonalThemeToAccount,
  setOwnAdminPin,
  updateOwnPreferences,
  type ManagedAuthUser,
  type PersonalThemeRow,
  type PreferenceOptions,
} from "../api/authApi";
import { getStaffDirectory, type StaffLibraryItem } from "../api/staffApi";
import type { AuthUser } from "../auth/useAuth";
import {
  normalizePatientNameLanguage,
  type PatientNameLanguage,
} from "../utils/patientName";
import {
  applyChartPreferencesLocally,
  chartGroupToAccountParameter,
  DEFAULT_DRIP_GROUP_COLORS,
  DEFAULT_FUTURE_COLUMNS,
  DRIP_GROUP_OPTIONS,
  MAX_FUTURE_COLUMNS,
  normalizeDripGroupColors,
  normalizeFutureColumns,
  readLocalChartGroups,
  readLocalDripGroupColors,
  readLocalFutureColumns,
  readLocalSmartContrast,
  type DripGroupColors,
} from "../utils/chartPreferences";

const PARAMETERS = [
  ["hr", "Heart rate"], ["pr", "Pulse rate (PR/PLS)"], ["spo2", "SpO₂"], ["nibp", "NIBP"],
  ["art", "Arterial pressure"], ["cvp", "CVP"], ["temperature", "Temperature"],
] as const;
const REPORT_SECTIONS = [
  ["patient", "Patient"], ["clinical", "Clinical summary"], ["careTeam", "Care team"],
  ["chart", "Chart"], ["io", "I/O"], ["forms", "Forms"],
] as const;

export default function AccountView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const [account, setAccount] = useState<ManagedAuthUser | null>(null);
  const [options, setOptions] = useState<PreferenceOptions | null>(null);
  const [staff, setStaff] = useState<StaffLibraryItem[]>([]);
  const [personalThemes, setPersonalThemes] = useState<PersonalThemeRow[]>([]);
  const [addingPersonalTheme, setAddingPersonalTheme] = useState(false);
  const [personalDraft, setPersonalDraft] = useState({
    code: "", displayName: "", colors: ["#121212", "#1c1c1c", "#444444", "#e0e0e0", "#b0b0b0", "#4f8ee8"] as [string, string, string, string, string, string],
  });
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en");
  const [patientNameLanguage, setPatientNameLanguage] = useState<PatientNameLanguage>("auto");
  const [scheme, setScheme] = useState("monochromatic");
  const [scale, setScale] = useState(5);
  const [futureColumns, setFutureColumns] = useState(DEFAULT_FUTURE_COLUMNS);
  const [parameters, setParameters] = useState<string[]>(PARAMETERS.map(([key]) => key));
  const [smartContrast, setSmartContrast] = useState(true);
  const [dripGroupColors, setDripGroupColors] = useState<DripGroupColors>(DEFAULT_DRIP_GROUP_COLORS);
  const [reports, setReports] = useState<Record<string, boolean>>(() => Object.fromEntries(REPORT_SECTIONS.map(([key]) => [key, true])));
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pinPassword, setPinPassword] = useState("");
  const [pinValue, setPinValue] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinSet, setPinSet] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      getSelfManagedUser(sessionUser?.username || ""),
      getPreferenceOptions(),
      getPersonalThemes().catch(() => []),
      getStaffDirectory({ include_inactive: true, limit: 500 }).catch(() => []),
    ]).then(([user, preferenceOptions, privateThemes, directory]) => {
      setAccount(user); setOptions(preferenceOptions); setPersonalThemes(privateThemes); setStaff(directory);
      setName(user.name); setLanguage(String(user.languageCode || preferenceOptions.defaultLanguage));
      setPatientNameLanguage(normalizePatientNameLanguage(user.parameterPreferences?.patientNameLanguage));
      setScheme(String(user.themeColor || preferenceOptions.defaultTheme));
      const parameterPrefs = user.parameterPreferences || {};
      const localScale = typeof window === "undefined"
        ? Number.NaN
        : Number(window.localStorage.getItem(`flora.timelineScale.${user.username}`));
      setScale(Number.isFinite(localScale) && localScale > 0 ? localScale : Number(parameterPrefs.timeScaleMin) || 5);
      setFutureColumns(readLocalFutureColumns(user.username) ?? normalizeFutureColumns(parameterPrefs.futureColumns));
      const localGroups = readLocalChartGroups(user.username);
      if (localGroups != null) {
        setParameters(localGroups.map(chartGroupToAccountParameter).filter((key): key is string => key != null));
      } else if (Array.isArray(parameterPrefs.visibleParameters)) {
        setParameters(parameterPrefs.visibleParameters.map(String));
      }
      setSmartContrast(readLocalSmartContrast(user.username) ?? parameterPrefs.smartContrast !== false);
      setDripGroupColors(
        readLocalDripGroupColors(user.username) ?? normalizeDripGroupColors(parameterPrefs.dripGroupColors),
      );
      setReports(current => ({ ...current, ...(user.reportPreferences as Record<string, boolean>) }));
    }).catch(err => setError(err instanceof Error ? err.message : "Unable to load account"));
  }, [sessionUser?.username]);

  const canManageUsers = sessionUser?.permissions?.includes("account.manage") === true;
  const hasAdminPin = pinSet ?? (account?.hasAdminPin === true || sessionUser?.hasAdminPin === true);
  const isLdapAccount = (account?.authSource || sessionUser?.authSource) === "ldap";

  const saveAdminPin = async (clear: boolean) => {
    if (!clear) {
      if (!/^\d{4,8}$/.test(pinValue)) return setError("Admin PIN must be 4–8 digits.");
      if (pinValue !== pinConfirm) return setError("Admin PINs do not match.");
    }
    setSaving(true); setError(""); setMessage("");
    try {
      await setOwnAdminPin(pinPassword, clear ? null : pinValue);
      setPinSet(!clear);
      if (sessionUser) {
        mergeStoredAuthUser({ ...sessionUser, hasAdminPin: !clear });
        window.dispatchEvent(new Event("flora:auth-changed"));
      }
      setPinPassword(""); setPinValue(""); setPinConfirm("");
      setMessage(clear ? "Admin PIN cleared." : "Admin PIN saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update admin PIN"); }
    finally { setSaving(false); }
  };

  const linkedStaff = useMemo(() => staff.find(row => row.id === account?.staffDirectoryId), [account?.staffDirectoryId, staff]);
  const selectableThemes = useMemo(() => [...(options?.themes || []), ...personalThemes], [options?.themes, personalThemes]);
  const toggleParameter = (key: string) => setParameters(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]);

  const save = async () => {
    setSaving(true); setError(""); setMessage("");
    try {
      const next = await updateOwnPreferences({
        name: name.trim(), languageCode: language, themeMode: "dark", themeColor: scheme,
        parameterPreferences: {
          ...(account?.parameterPreferences || {}),
          timeScaleMin: scale,
          futureColumns,
          visibleParameters: parameters,
          smartContrast,
          dripGroupColors,
          patientNameLanguage,
        },
        reportPreferences: reports,
      });
      mergeStoredAuthUser(next);
      applyChartPreferencesLocally({
        username: next.username,
        timeScaleMin: scale,
        futureColumns,
        visibleParameters: parameters,
        smartContrast,
        dripGroupColors,
      });
      window.dispatchEvent(new Event("flora:auth-changed"));
      setAccount(current => current ? { ...current, name: next.name, languageCode: next.languageCode, themeColor: next.themeColor,
        parameterPreferences: next.parameterPreferences || {}, reportPreferences: next.reportPreferences || {} } : current);
      setMessage("Account settings saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save account"); }
    finally { setSaving(false); }
  };

  const changePassword = async () => {
    if (newPassword.length < 8) return setError("New password must be at least 8 characters.");
    if (newPassword !== confirmPassword) return setError("Passwords do not match.");
    setSaving(true); setError(""); setMessage("");
    try {
      const changed = await changeOwnPassword(sessionUser?.username || "", currentPassword, newPassword);
      mergeStoredAuthUser(changed);
      window.dispatchEvent(new Event("flora:auth-changed"));
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setMessage("Password changed.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to change password"); }
    finally { setSaving(false); }
  };

  return <div className="mx-auto flex h-full w-full max-w-[1180px] flex-col gap-4 overflow-y-auto p-4 md:p-6">
    <header><h1 className="text-xl font-bold text-[var(--app-text)]">Account settings</h1><p className="text-sm text-[var(--app-muted)]">Personal profile and workspace preferences</p></header>
    {error ? <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div> : null}
    {message ? <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{message}</div> : null}
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5">
        <h2 className="font-semibold">Profile</h2>
        <label className="block text-sm">Display name<input className="mt-1 w-full max-w-xl rounded-lg border border-[var(--app-border)] px-3 py-2" value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-[var(--app-control-bg)] p-3"><div className="text-xs text-[var(--app-muted)]">Username</div><div className="font-medium">{account?.username || "—"}</div></div>
          <div className="rounded-lg bg-[var(--app-control-bg)] p-3"><div className="text-xs text-[var(--app-muted)]">Role</div><div className="font-medium">{account?.role || "—"}</div></div>
        </div>
        <div className="rounded-lg border border-[var(--app-border)] p-3"><div className="text-xs text-[var(--app-muted)]">Linked staff profile</div><div className="mt-1 font-semibold">{linkedStaff?.name || "Not linked"}</div>{linkedStaff ? <div className="text-xs text-[var(--app-muted)]">{linkedStaff.role}{linkedStaff.hospital_id ? ` · ${linkedStaff.hospital_id}` : ""}</div> : <div className="text-xs text-amber-300">Ask an administrator to link this account in Config → User.</div>}</div>
      </section>
      <section className="space-y-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5">
        <h2 className="font-semibold">Appearance</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Interface language<select className="mt-1 w-full rounded-lg border border-[var(--app-border)] px-3 py-2" value={language} onChange={e => setLanguage(e.target.value)}>{options?.languages.map(row => <option key={row.code} value={row.code}>{row.nameNative}</option>)}</select></label>
          <label className="text-sm">Preferred scheme<select className="mt-1 w-full rounded-lg border border-[var(--app-border)] px-3 py-2" value={scheme} onChange={e => setScheme(e.target.value)}>{selectableThemes.map(row => <option key={row.code} value={row.code}>{row.scope === "personal" ? `My theme · ${row.displayName}` : row.displayName}</option>)}</select></label>
          <label className="text-sm sm:col-span-2">Patient name language<select className="mt-1 w-full rounded-lg border border-[var(--app-border)] px-3 py-2" value={patientNameLanguage} onChange={e => setPatientNameLanguage(normalizePatientNameLanguage(e.target.value))}><option value="auto">Automatic — use the hospital display name</option><option value="thai">Thai name</option><option value="english">English name</option></select><span className="mt-1 block text-xs text-[var(--app-muted)]">Independent from the interface language. Falls back safely when the selected name is unavailable.</span></label>
        </div>
        <div className="flex flex-wrap gap-2">{selectableThemes.find(row => row.code === scheme)?.colors.map((color, index) => <span key={index} className="h-10 w-10 rounded-lg border border-white/15" style={{ backgroundColor: color }} title={color} />)}</div>
        <div className="border-t border-[var(--app-border)] pt-4">
          <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">My themes</h3><p className="text-xs text-[var(--app-muted)]">Private to your account. Local Leaf themes are uploaded only when you choose Save to account.</p></div><button type="button" className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-xs font-semibold" onClick={() => setAddingPersonalTheme(value => !value)}>+ Personal theme</button></div>
          {addingPersonalTheme ? <div className="mt-3 space-y-3 rounded-lg border border-[var(--app-border)] p-3">
            <div className="grid gap-2 sm:grid-cols-2"><input className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm" placeholder="Theme code" value={personalDraft.code} onChange={event => setPersonalDraft(current => ({ ...current, code: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))} /><input className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm" placeholder="Theme name" value={personalDraft.displayName} onChange={event => setPersonalDraft(current => ({ ...current, displayName: event.target.value }))} /></div>
            <div className="flex flex-wrap gap-2">{personalDraft.colors.map((color, index) => <input key={index} aria-label={`Personal theme color ${index + 1}`} type="color" value={color} onChange={event => setPersonalDraft(current => ({ ...current, colors: current.colors.map((entry, colorIndex) => colorIndex === index ? event.target.value : entry) as typeof current.colors }))} className="h-10 w-12 rounded border border-[var(--app-border)] bg-transparent p-1" />)}</div>
            <button type="button" disabled={saving || personalDraft.code.length < 2 || !personalDraft.displayName.trim()} className="rounded-lg bg-[var(--app-accent)] px-3 py-2 text-xs font-bold text-[var(--app-accent-contrast)] disabled:opacity-50" onClick={() => { setSaving(true); setError(""); void createPersonalTheme({ code: `personal:${personalDraft.code}`, displayName: personalDraft.displayName, colors: personalDraft.colors, scope: "personal" }).then(created => { setPersonalThemes(current => [...current, created]); setScheme(created.code); setAddingPersonalTheme(false); setPersonalDraft({ code: "", displayName: "", colors: ["#121212", "#1c1c1c", "#444444", "#e0e0e0", "#b0b0b0", "#4f8ee8"] }); setMessage(created.syncState === "central" ? "Personal theme saved to your account." : "Personal theme saved locally on this Leaf."); }).catch(err => setError(err instanceof Error ? err.message : "Unable to create personal theme")).finally(() => setSaving(false)); }}>Create</button>
          </div> : null}
          <div className="mt-3 space-y-2">{personalThemes.map(theme => <div key={theme.code} className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--app-border)] p-3"><div className="min-w-32 flex-1"><div className="text-sm font-semibold">{theme.displayName}</div><div className="text-xs text-[var(--app-muted)]">{theme.syncState === "central" ? "Saved to my account" : "Local to this Leaf"}</div></div><div className="flex gap-1">{theme.colors.map((color, index) => <span key={index} className="h-7 w-5 first:rounded-l last:rounded-r" style={{ backgroundColor: color }} />)}</div>{theme.syncState === "local" ? <button type="button" className="rounded border border-[var(--app-border)] px-3 py-2 text-xs font-semibold" onClick={() => { setSaving(true); void savePersonalThemeToAccount(theme.code).then(saved => { setPersonalThemes(current => current.map(row => row.code === saved.code ? saved : row)); setMessage("Personal theme saved to your Canopy account."); }).catch(err => setError(err instanceof Error ? err.message : "Unable to save theme to account")).finally(() => setSaving(false)); }}>Save to account</button> : null}<button type="button" className="rounded border border-rose-400/40 px-3 py-2 text-xs text-rose-300" onClick={() => { setSaving(true); void deletePersonalTheme(theme.code).then(() => { setPersonalThemes(current => current.filter(row => row.code !== theme.code)); if (scheme === theme.code) setScheme(options?.defaultTheme || "monochromatic"); }).catch(err => setError(err instanceof Error ? err.message : "Unable to delete personal theme")).finally(() => setSaving(false)); }}>Delete</button></div>)}</div>
        </div>
      </section>
      <section className="space-y-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5">
        <h2 className="font-semibold">Chart preferences</h2>
        <div className="grid max-w-xl gap-3 sm:grid-cols-2">
          <label className="block text-sm">Default time scale<select className="mt-1 w-full rounded-lg border border-[var(--app-border)] px-3 py-2" value={scale} onChange={e => setScale(Number(e.target.value))}>{[1,5,10,15,30,60].map(value => <option key={value} value={value}>{value} min</option>)}</select></label>
          <label className="block text-sm">Future columns<input type="number" min={0} max={MAX_FUTURE_COLUMNS} step={1} className="mt-1 w-full rounded-lg border border-[var(--app-border)] px-3 py-2" value={futureColumns} onChange={event => setFutureColumns(normalizeFutureColumns(event.target.value))} /></label>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">{PARAMETERS.map(([key, label]) => <label key={key} className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"><input type="checkbox" checked={parameters.includes(key)} onChange={() => toggleParameter(key)} />{label}</label>)}</div>
        <label className="flex items-start gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-3 text-sm"><input type="checkbox" className="mt-0.5" checked={smartContrast} onChange={event => setSmartContrast(event.target.checked)} /><span><strong className="block">Smart invert color</strong><span className="text-xs text-[var(--app-muted)]">Adjust chart colors that blend into the active scheme.</span></span></label>
        <div className="space-y-3 rounded-xl border border-[var(--app-border)] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Drip line colors</h3>
              <p className="text-xs text-[var(--app-muted)]">Defaults follow the medication group. Smart invert keeps them readable in the selected scheme.</p>
            </div>
            <button type="button" className="shrink-0 rounded-lg border border-[var(--app-border)] px-3 py-2 text-xs font-semibold hover:bg-[var(--app-control-bg-hover)]" onClick={() => setDripGroupColors(DEFAULT_DRIP_GROUP_COLORS)}>Reset</button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {DRIP_GROUP_OPTIONS.map(option => (
              <label key={option.key} className="flex items-center gap-3 rounded-lg bg-[var(--app-control-bg)] px-3 py-2 text-sm">
                <input
                  type="color"
                  className="h-8 w-10 cursor-pointer rounded border border-[var(--app-border)] bg-transparent p-0.5"
                  value={dripGroupColors[option.key]}
                  onChange={event => setDripGroupColors(current => ({ ...current, [option.key]: event.target.value.toUpperCase() }))}
                  aria-label={`${option.label} drip color`}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="font-mono text-[10px] text-[var(--app-muted)]">{dripGroupColors[option.key]}</span>
              </label>
            ))}
          </div>
        </div>
      </section>
      <section className="space-y-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5">
        <h2 className="font-semibold">Report preferences</h2>
        <div className="grid gap-2 sm:grid-cols-2">{REPORT_SECTIONS.map(([key, label]) => <label key={key} className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"><input type="checkbox" checked={reports[key] !== false} onChange={e => setReports(current => ({ ...current, [key]: e.target.checked }))} />{label}</label>)}</div>
      </section>
    </div>
    <button type="button" onClick={() => void save()} disabled={saving || !name.trim()} className="w-fit rounded-lg bg-[var(--app-accent)] px-5 py-2.5 font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50">{saving ? "Saving…" : "Save account"}</button>
    {isLdapAccount
      ? <section className="space-y-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5"><h2 className="font-semibold">Password</h2><p className="text-sm text-[var(--app-muted)]">This account signs in through the organisation directory (LDAP). Change your password in the directory service.</p></section>
      : <section className="space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5"><h2 className="font-semibold">Password</h2><div className="grid max-w-3xl gap-3 sm:grid-cols-3"><input type="password" className="rounded-lg border border-[var(--app-border)] px-3 py-2" placeholder="Current password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /><input type="password" className="rounded-lg border border-[var(--app-border)] px-3 py-2" placeholder="New password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /><input type="password" className="rounded-lg border border-[var(--app-border)] px-3 py-2" placeholder="Confirm password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></div><button type="button" onClick={() => void changePassword()} disabled={saving || !currentPassword || !newPassword || !confirmPassword} className="rounded-lg border border-[var(--app-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50">Change password</button></section>}
    {canManageUsers ? <section className="space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Admin PIN</h2>
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${hasAdminPin ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-300" : "border-amber-400/35 bg-amber-500/10 text-amber-300"}`}>{hasAdminPin ? "PIN set" : "No PIN set"}</span>
      </div>
      <p className="text-xs text-[var(--app-muted)]">A 4–8 digit PIN that authorises user and ward changes made at a Leaf bedside. Confirm with your current password.</p>
      <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
        <input type="password" autoComplete="current-password" className="rounded-lg border border-[var(--app-border)] px-3 py-2" placeholder="Current password" value={pinPassword} onChange={e => setPinPassword(e.target.value)} />
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} className="rounded-lg border border-[var(--app-border)] px-3 py-2" placeholder="New PIN (4–8 digits)" value={pinValue} onChange={e => setPinValue(e.target.value.replace(/\D/g, "").slice(0, 8))} />
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} className="rounded-lg border border-[var(--app-border)] px-3 py-2" placeholder="Confirm PIN" value={pinConfirm} onChange={e => setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 8))} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void saveAdminPin(false)} disabled={saving || !pinPassword || pinValue.length < 4 || !pinConfirm} className="rounded-lg border border-[var(--app-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50">{hasAdminPin ? "Change PIN" : "Set PIN"}</button>
        {hasAdminPin ? <button type="button" onClick={() => void saveAdminPin(true)} disabled={saving || !pinPassword} className="rounded-lg border border-rose-400/40 px-4 py-2 text-sm font-semibold text-rose-300 disabled:opacity-50">Clear PIN</button> : null}
      </div>
    </section> : null}
  </div>;
}
