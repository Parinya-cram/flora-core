import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser } from "../auth/useAuth";
import {
  createCanopyStaff, getCanopyStaffOptions, importCanopyStaff, listCanopyStaff, markCanopyStaffReviewed, saveCanopyStaff, saveStaffRole,
  type CanopyStaff, type CanopyStaffSave, type StaffImportReport, type StaffRoleRow, type StaffType, type StaffWard,
} from "../api/staffDirectoryApi";

/**
 * Canopy → Staff directory: the hospital's doctors, nurses and other staff, and the wards they work in.
 * Each Leaf receives the staff of its ward (plus "all wards" staff) at every sync; people added on a Leaf
 * arrive here flagged for review. The staff code (doctor / nurse code) identifies a person everywhere.
 */

const inputClass = "w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4";
const label = "text-xs font-bold text-[var(--app-muted)]";
const IMPORT_COLUMNS = "staff_code,role,th_first_name,th_last_name,en_first_name,en_last_name,hospital_id,email,wards";
const TYPE_LABEL: Record<StaffType, string> = { doctor: "Doctor", nurse: "Nurse", other: "Other" };

type Draft = CanopyStaffSave & { id?: number; unit_keys: string[] };
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

function emptyDraft(roleId: string): Draft {
  return { staff_code: "", staff_role_id: roleId, staff_name: "", th_first_name: "", th_last_name: "", en_first_name: "", en_last_name: "",
    hospital_id: "", email: "", is_active: 1, all_units: false, unit_keys: [] };
}

/** CSV with a header row; quoted fields may hold commas and doubled quotes. */
function parseCsv(textValue: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < textValue.length; i += 1) {
    const char = textValue[i];
    if (quoted) {
      if (char === '"' && textValue[i + 1] === '"') { field += '"'; i += 1; } else if (char === '"') quoted = false; else field += char;
    } else if (char === '"') quoted = true;
    else if (char === "," || char === "\t") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && textValue[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some(cell => cell.trim())) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map(cell => cell.trim().toLowerCase());
  return body.map(cells => Object.fromEntries(keys.map((key, index) => [key, (cells[index] ?? "").trim()])));
}

export default function CanopyStaffView({ sessionUser }: { sessionUser: AuthUser | null }) {
  const canEdit = Boolean(sessionUser?.permissions?.includes("staff.manage")) || String(sessionUser?.role || "").toLowerCase() === "admin";
  const [rows, setRows] = useState<CanopyStaff[]>([]);
  const [totals, setTotals] = useState({ active: 0, review: 0, no_code: 0 });
  const [roles, setRoles] = useState<StaffRoleRow[]>([]);
  const [wards, setWards] = useState<StaffWard[]>([]);
  const [filter, setFilter] = useState({ q: "", unit: "", role_id: "", review: false, include_inactive: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [panel, setPanel] = useState<"edit" | "import" | "roles">("edit");
  const [importText, setImportText] = useState("");
  const [importReport, setImportReport] = useState<StaffImportReport | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, options] = await Promise.all([listCanopyStaff(filter), getCanopyStaffOptions()]);
      setRows(list.rows);
      setTotals(list.totals);
      setRoles(options.roles);
      setWards(options.wards);
    } catch (reason) { setError(errorText(reason)); }
  }, [filter]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const roleById = useMemo(() => new Map(roles.map(role => [role.id, role])), [roles]);
  const wardName = useMemo(() => new Map(wards.map(ward => [ward.key, ward.name])), [wards]);
  const draftRole = draft ? roleById.get(String(draft.staff_role_id || "")) : undefined;
  const codeRequired = draftRole?.staff_type === "doctor" || draftRole?.staff_type === "nurse";

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(""); setNote("");
    try { await action(); setNote(message); await load(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const openRow = (row: CanopyStaff) => {
    setPanel("edit");
    setDraft({ ...row, unit_keys: row.units.map(unit => unit.key) });
    setNote(""); setError("");
  };
  const save = () => draft && run(async () => {
    const { id, ...body } = draft;
    const saved = id ? await saveCanopyStaff(id, body) : await createCanopyStaff(body);
    setDraft({ ...saved, unit_keys: saved.units.map(unit => unit.key) });
  }, "Saved. Leafs in these wards receive it at their next sync.");
  const runImport = () => run(async () => {
    const parsed = parseCsv(importText);
    if (!parsed.length) throw new Error(`Paste a CSV with a header row: ${IMPORT_COLUMNS}`);
    setImportReport(await importCanopyStaff(parsed));
  }, "Import finished.");

  return (
    <div className="app-theme-scope w-full space-y-4 p-3 sm:p-5 pb-24 text-[var(--app-text)]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">ESM Flora Canopy · master data</div>
          <h1 className="mt-1 text-2xl font-semibold">Staff directory</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)]">Doctors, nurses and other staff by ward. Each Leaf receives its ward's staff; people added on a Leaf come here for review. The staff code identifies a person on every Leaf.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="rounded-xl border border-[var(--app-border)] px-3 py-2"><b>{totals.active}</b> active</span>
          <button type="button" className={`rounded-xl border px-3 py-2 ${filter.review ? "border-amber-500 bg-amber-400/15" : "border-[var(--app-border)]"}`}
            onClick={() => setFilter(current => ({ ...current, review: !current.review }))}><b>{totals.review}</b> to review</button>
          {totals.no_code ? <span className="rounded-xl border border-rose-400/50 px-3 py-2 text-rose-500"><b>{totals.no_code}</b> without code (not synced)</span> : null}
          {canEdit ? <>
            <button type="button" className={secondary} onClick={() => setPanel("roles")}>Roles</button>
            <button type="button" className={secondary} onClick={() => { setPanel("import"); setImportReport(null); }}>Import CSV</button>
            <button type="button" className={primary} onClick={() => { setPanel("edit"); setDraft(emptyDraft(roles[0]?.id || "")); }}>+ Add staff</button>
          </> : null}
        </div>
      </header>

      {error ? <div className="whitespace-pre-line rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-500">{error}</div> : null}
      {note ? <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-300">{note}</div> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <section className={`${card} space-y-3`}>
          <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_1fr_1fr_auto]">
            <input className={inputClass} placeholder="Search name, staff code, hospital ID" value={filter.q} onChange={e => setFilter(c => ({ ...c, q: e.target.value }))} />
            <select className={inputClass} value={filter.unit} onChange={e => setFilter(c => ({ ...c, unit: e.target.value }))} aria-label="Ward">
              <option value="">All wards</option>{wards.map(ward => <option key={ward.key} value={ward.key}>{ward.name}</option>)}
            </select>
            <select className={inputClass} value={filter.role_id} onChange={e => setFilter(c => ({ ...c, role_id: e.target.value }))} aria-label="Role">
              <option value="">All roles</option>{roles.map(role => <option key={role.id} value={role.id}>{role.display_name}</option>)}
            </select>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={filter.include_inactive} onChange={e => setFilter(c => ({ ...c, include_inactive: e.target.checked }))} className="accent-[var(--app-accent)]" />Inactive</label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="text-left text-[10px] uppercase tracking-[0.1em] text-[var(--app-muted)]">
                <th className="py-1.5">Code</th><th className="py-1.5">Name</th><th className="py-1.5">Role</th><th className="py-1.5">Wards</th><th className="py-1.5">Source</th></tr></thead>
              <tbody>{rows.map(row => (
                <tr key={row.id} onClick={() => openRow(row)}
                  className={`cursor-pointer border-t border-[var(--app-border)] hover:bg-[var(--app-control-bg)] ${draft?.id === row.id ? "bg-[var(--app-accent)]/10" : ""} ${row.is_active ? "" : "opacity-50"}`}>
                  <td className="py-1.5 font-mono text-xs">{row.staff_code || <span className="text-rose-500">no code</span>}</td>
                  <td className="py-1.5"><div className="font-semibold">{row.staff_name}</div>
                    {row.en_first_name || row.th_first_name ? <div className="text-[11px] text-[var(--app-muted)]">{[row.th_first_name, row.th_last_name].filter(Boolean).join(" ")} {row.en_first_name ? `· ${[row.en_first_name, row.en_last_name].filter(Boolean).join(" ")}` : ""}</div> : null}</td>
                  <td className="py-1.5 text-xs">{row.staff_role}<span className="ml-1 text-[var(--app-muted)]">{TYPE_LABEL[roleById.get(row.staff_role_id)?.staff_type || "other"]}</span></td>
                  <td className="py-1.5 text-xs">{row.all_units ? <b>All wards</b> : row.units.map(unit => unit.name).join(", ") || <span className="text-amber-600">no ward</span>}</td>
                  <td className="py-1.5 text-xs">{row.origin_leaf ? `Leaf ${row.origin_leaf}` : "Canopy"}
                    {row.needs_review ? <span className="ml-1 rounded-full border border-amber-500 px-1.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">review</span> : null}</td>
                </tr>
              ))}</tbody>
            </table>
            {!rows.length ? <p className="py-6 text-center text-sm text-[var(--app-muted)]">No staff found.</p> : null}
          </div>
        </section>

        <aside className={`${card} h-fit space-y-3`}>
          {panel === "import" ? <>
            <h2 className="text-lg font-bold">Import staff (CSV)</h2>
            <p className="text-xs text-[var(--app-muted)]">Header row: <code>{IMPORT_COLUMNS}</code>. <b>role</b> is a role id or name; <b>wards</b> are ward names separated by <code>;</code>, or <code>all</code>. A known staff code updates that person.</p>
            <input type="file" accept=".csv,text/csv,text/plain" className="text-xs" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(setImportText); }} />
            <textarea className={`${inputClass} h-56 font-mono text-xs`} value={importText} onChange={e => setImportText(e.target.value)} placeholder={`${IMPORT_COLUMNS}\nD12345,surgeon,สมชาย,ใจดี,Somchai,Jaidee,,,OR Suite`} />
            <button type="button" className={primary} disabled={busy || !importText.trim()} onClick={() => void runImport()}>Import</button>
            {importReport ? <div className="space-y-1 text-sm">
              <div><b>{importReport.created}</b> created · <b>{importReport.updated}</b> updated · <b className={importReport.errors ? "text-rose-500" : ""}>{importReport.errors}</b> errors</div>
              <ul className="max-h-48 overflow-y-auto text-xs">{importReport.rows.filter(row => row.status === "error").map(row =>
                <li key={row.row} className="text-rose-500">Row {row.row}{row.staff_code ? ` (${row.staff_code})` : ""}: {row.error}</li>)}</ul>
            </div> : null}
          </> : panel === "roles" ? <RolesPanel roles={roles} disabled={!canEdit || busy}
            onSave={(id, body) => run(() => saveStaffRole(id, body), "Role saved. Leafs receive it at their next sync.")} /> : !draft ? (
            <p className="text-sm text-[var(--app-muted)]">Select a person to see or change them{canEdit ? ", or add one" : ""}.</p>
          ) : <>
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-bold">{draft.id ? draft.staff_name || "Staff" : "Add staff"}</h2>
              {draft.id && rows.find(row => row.id === draft.id)?.needs_review && canEdit ? (
                <button type="button" className={secondary} disabled={busy} onClick={() => void run(() => markCanopyStaffReviewed(draft.id as number), "Marked as reviewed.")}>Mark reviewed</button>
              ) : null}
            </div>
            {draft.id && rows.find(row => row.id === draft.id)?.origin_leaf ? <p className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-2 py-1.5 text-xs">Added on Leaf {rows.find(row => row.id === draft.id)?.origin_leaf}. Check the name, code and wards.</p> : null}
            <div className="grid grid-cols-2 gap-2">
              <label className={label}>Staff code{codeRequired ? " *" : ""}<input className={`${inputClass} mt-1 font-mono`} disabled={!canEdit} value={draft.staff_code || ""}
                placeholder={codeRequired ? "Doctor / nurse code" : "Optional"} onChange={e => setDraft({ ...draft, staff_code: e.target.value.trim() })} /></label>
              <label className={label}>Role *<select className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.staff_role_id || ""} onChange={e => setDraft({ ...draft, staff_role_id: e.target.value })}>
                {roles.filter(role => role.is_active || role.id === draft.staff_role_id).map(role => <option key={role.id} value={role.id}>{role.display_name} ({TYPE_LABEL[role.staff_type]})</option>)}
              </select></label>
              <label className={label}>First name (TH)<input className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.th_first_name || ""} onChange={e => setDraft({ ...draft, th_first_name: e.target.value })} /></label>
              <label className={label}>Last name (TH)<input className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.th_last_name || ""} onChange={e => setDraft({ ...draft, th_last_name: e.target.value })} /></label>
              <label className={label}>First name (EN)<input className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.en_first_name || ""} onChange={e => setDraft({ ...draft, en_first_name: e.target.value })} /></label>
              <label className={label}>Last name (EN)<input className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.en_last_name || ""} onChange={e => setDraft({ ...draft, en_last_name: e.target.value })} /></label>
              <label className={`${label} col-span-2`}>Display name<input className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.staff_name || ""} placeholder="From the Thai or English name when empty"
                onChange={e => setDraft({ ...draft, staff_name: e.target.value })} /></label>
              <label className={label}>Hospital ID<input className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.hospital_id || ""} onChange={e => setDraft({ ...draft, hospital_id: e.target.value })} /></label>
              <label className={label}>Email<input className={`${inputClass} mt-1`} disabled={!canEdit} value={draft.email || ""} onChange={e => setDraft({ ...draft, email: e.target.value })} /></label>
            </div>
            <div className="space-y-1">
              <div className={label}>Wards (the Leafs that receive this person)</div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={Boolean(draft.all_units)} className="accent-[var(--app-accent)]"
                onChange={e => setDraft({ ...draft, all_units: e.target.checked })} />All wards</label>
              {!draft.all_units ? <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto">{wards.map(ward => (
                <label key={ward.key} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} className="accent-[var(--app-accent)]"
                  checked={draft.unit_keys.includes(ward.key)}
                  onChange={e => setDraft({ ...draft, unit_keys: e.target.checked ? [...draft.unit_keys, ward.key] : draft.unit_keys.filter(key => key !== ward.key) })} />
                  <span className="truncate">{ward.name}</span></label>
              ))}</div> : null}
              {draft.unit_keys.some(key => !wardName.has(key)) ? <p className="text-xs text-[var(--app-muted)]">Also: {draft.unit_keys.filter(key => !wardName.has(key)).join(", ")}</p> : null}
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={Boolean(draft.is_active)} className="accent-[var(--app-accent)]"
              onChange={e => setDraft({ ...draft, is_active: e.target.checked ? 1 : 0 })} />Active (inactive people are removed from Leafs; their past cases keep the name)</label>
            {canEdit ? <div className="flex gap-2">
              <button type="button" className={primary} disabled={busy || (codeRequired && !draft.staff_code)} onClick={() => void save()}>Save</button>
              <button type="button" className={secondary} onClick={() => setDraft(null)}>Close</button>
            </div> : null}
          </>}
        </aside>
      </div>
    </div>
  );
}

function RolesPanel({ roles, disabled, onSave }: { roles: StaffRoleRow[]; disabled: boolean; onSave: (id: string, body: Omit<StaffRoleRow, "id">) => void }) {
  const [edits, setEdits] = useState<Record<string, Omit<StaffRoleRow, "id">>>({});
  const [newId, setNewId] = useState("");
  const value = (role: StaffRoleRow) => edits[role.id] || { display_name: role.display_name, sort_order: role.sort_order, staff_type: role.staff_type, is_active: role.is_active };
  return <>
    <h2 className="text-lg font-bold">Roles</h2>
    <p className="text-xs text-[var(--app-muted)]">Doctor and nurse roles need a staff code. Roles go to every Leaf.</p>
    <div className="max-h-[60vh] space-y-1 overflow-y-auto">{roles.map(role => {
      const current = value(role);
      const changed = Boolean(edits[role.id]);
      const patch = (next: Partial<Omit<StaffRoleRow, "id">>) => setEdits(all => ({ ...all, [role.id]: { ...current, ...next } }));
      return <div key={role.id} className="grid grid-cols-[minmax(0,1fr)_100px_auto] items-center gap-1">
        <input className={`${inputClass} !py-1`} disabled={disabled} value={current.display_name} onChange={e => patch({ display_name: e.target.value })} aria-label={`${role.id} name`} />
        <select className={`${inputClass} !py-1`} disabled={disabled} value={current.staff_type} onChange={e => patch({ staff_type: e.target.value as StaffType })} aria-label={`${role.id} type`}>
          <option value="doctor">Doctor</option><option value="nurse">Nurse</option><option value="other">Other</option>
        </select>
        <button type="button" className={`${secondary} !px-2 !py-1 text-xs`} disabled={disabled || !changed} onClick={() => { onSave(role.id, current); setEdits(all => { const next = { ...all }; delete next[role.id]; return next; }); }}>Save</button>
      </div>;
    })}</div>
    <div className="flex gap-1">
      <input className={`${inputClass} !py-1 font-mono`} disabled={disabled} value={newId} placeholder="newRoleId" onChange={e => setNewId(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} />
      <button type="button" className={`${secondary} !py-1 text-xs`} disabled={disabled || newId.length < 2}
        onClick={() => { onSave(newId, { display_name: newId, sort_order: 100, staff_type: "other", is_active: 1 }); setNewId(""); }}>+ Role</button>
    </div>
  </>;
}
