import { useCallback, useEffect, useMemo, useState } from "react";
import type { BillingCatalog, BillingItem } from "../../api/billingApi";
import {
  archiveBillingTemplate, createBillingTemplate, duplicateBillingTemplate, emptyBillingTemplate, getBillingTemplateOptions,
  listBillingTemplates, publishBillingTemplate, saveBillingTemplate, validateBillingTemplate,
  type BillingTemplateDefinition, type BillingTemplateGroup, type BillingTemplateIssue, type BillingTemplateRow,
} from "../../api/workflowApi";

/**
 * Workflow Studio → Itemize templates: standing-order lists for the OR billing checklist.
 * Groups and items (from the billing master) in display order; preselected items start ticked
 * on the Leaf with their quantity. Workflows pick a template, so one template serves many.
 */

const inputClass = "w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const danger = "rounded-xl border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-500 disabled:opacity-50";
const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4";
const tiny = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-bold text-[var(--app-text)] disabled:opacity-40";
const ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const statusBadge: Record<string, string> = {
  draft: "border-amber-400/40 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  published: "border-emerald-400/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  archived: "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]",
};

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "group";

type Editing = { originalId: string | null; definition: BillingTemplateDefinition };

export default function BillingTemplateStudio({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<BillingTemplateRow[]>([]);
  const [catalog, setCatalog] = useState<BillingCatalog>({ version: 0, groups: [], items: [] });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [issues, setIssues] = useState<BillingTemplateIssue[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState<Record<string, string>>({});

  const load = useCallback(async (selectId?: string) => {
    try {
      const [nextRows, nextCatalog] = await Promise.all([listBillingTemplates(), getBillingTemplateOptions()]);
      setRows(nextRows);
      setCatalog(nextCatalog);
      if (selectId) {
        const row = nextRows.find(item => item.id === selectId);
        if (row) setEditing({ originalId: row.id, definition: row.definition });
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);
  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  const item = useMemo(() => new Map(catalog.items.map(row => [row.code, row])), [catalog.items]);
  const selected = editing?.originalId ? rows.find(row => row.id === editing.originalId) || null : null;
  const readOnly = !isAdmin || selected?.status === "archived";
  const def = editing?.definition;
  const used = useMemo(() => new Set(def?.groups.flatMap(group => group.items.map(entry => entry.code)) || []), [def]);

  const patch = (change: (current: BillingTemplateDefinition) => BillingTemplateDefinition) => {
    setEditing(current => (current ? { ...current, definition: change(current.definition) } : current));
    setIssues([]);
  };
  const patchGroup = (index: number, change: (group: BillingTemplateGroup) => BillingTemplateGroup) =>
    patch(current => ({ ...current, groups: current.groups.map((group, i) => (i === index ? change(group) : group)) }));

  const addGroup = (name = "New group", items: BillingItem[] = []) => patch(current => {
    const taken = new Set(current.groups.map(group => group.key));
    let key = slug(name);
    for (let n = 2; taken.has(key); n += 1) key = `${slug(name)}_${n}`;
    const existing = new Set(current.groups.flatMap(group => group.items.map(entry => entry.code)));
    return { ...current, groups: [...current.groups, { key, name, items: items.filter(row => !existing.has(row.code)).map(row => ({ code: row.code })) }] };
  });

  const run = async (action: () => Promise<BillingTemplateRow | void>, message: string) => {
    setBusy(true); setError(""); setNote("");
    try {
      const row = await action();
      setNote(message);
      await load(row ? row.id : editing?.originalId || undefined);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const save = () => def && run(async () => (editing?.originalId ? saveBillingTemplate(editing.originalId, def) : createBillingTemplate(def)), "Draft saved.");
  const publish = () => def && run(async () => {
    const saved = editing?.originalId ? await saveBillingTemplate(editing.originalId, def) : await createBillingTemplate(def);
    const check = await validateBillingTemplate(saved.definition);
    if (check.issues.length) { setIssues(check.issues); throw new Error("Fix the items below before publishing."); }
    return publishBillingTemplate(saved.id);
  }, "Published. Wards whose workflows use this template receive it at their next sync.");

  const localErrors = !def ? [] : [
    ...(!ID_PATTERN.test(def.id) ? ["Id: lower-case letters, digits and _ (2–64), starting with a letter."] : []),
    ...(!def.name.trim() ? ["Name is required."] : []),
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section className={`${card} h-fit space-y-2`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">Itemize templates <span className="text-[var(--app-muted)]">{rows.filter(row => showArchived || row.status !== "archived").length}</span></h2>
          <label className="flex items-center gap-1 text-xs text-[var(--app-muted)]"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="accent-[var(--app-accent)]" />Archived</label>
        </div>
        {isAdmin ? <button type="button" className={`${primary} w-full`} onClick={() => { setEditing({ originalId: null, definition: emptyBillingTemplate() }); setIssues([]); setNote(""); setError(""); }}>+ New template</button> : null}
        {rows.filter(row => showArchived || row.status !== "archived").map(row => (
          <button key={row.id} type="button" onClick={() => { setEditing({ originalId: row.id, definition: row.definition }); setIssues([]); setNote(""); setError(""); }}
            className={`w-full rounded-xl border p-3 text-left transition ${editing?.originalId === row.id ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:border-[var(--app-accent)]/60"}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><div className="truncate text-sm font-bold">{row.name || row.id}</div><div className="truncate font-mono text-[11px] text-[var(--app-muted)]">{row.id}</div></div>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadge[row.status]}`}>{row.status}</span>
            </div>
            <div className="mt-1 text-[11px] text-[var(--app-muted)]">v{row.version} · {row.itemCount} items · {row.usedBy.length ? `used by ${row.usedBy.map(w => w.name || w.id).join(", ")}` : "not used yet"}</div>
          </button>
        ))}
      </section>

      {!editing || !def ? <section className={`${card} text-sm text-[var(--app-muted)]`}>Select a template{isAdmin ? " or create a new one" : ""}. A workflow picks its template under <b>Billing</b>.</section> : (
        <section className="space-y-4">
          {error ? <div className="whitespace-pre-line rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-500">{error}</div> : null}
          {note ? <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-300">{note}</div> : null}
          {issues.length ? <ul className="list-disc rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 pl-8 text-sm text-amber-700 dark:text-amber-300">{issues.map(issue => <li key={`${issue.path}${issue.message}`}>{issue.message}</li>)}</ul> : null}

          <div className={`${card} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold">{editing.originalId ? def.name || editing.originalId : "New itemize template"}
                {selected ? <span className={`ml-2 rounded-full border px-2 py-0.5 align-middle text-[10px] font-bold uppercase ${statusBadge[selected.status]}`}>{selected.status} · v{selected.version}</span> : null}
              </h2>
              <div className="flex flex-wrap gap-2">
                {isAdmin && !readOnly ? <>
                  <button type="button" className={secondary} disabled={busy || localErrors.length > 0} onClick={() => void save()}>Save draft</button>
                  <button type="button" className={primary} disabled={busy || localErrors.length > 0} onClick={() => void publish()}>Publish</button>
                </> : null}
                {isAdmin && editing.originalId ? <button type="button" className={secondary} disabled={busy} onClick={() => {
                  const newId = window.prompt("Id of the copy (a-z, 0-9, _)", `${editing.originalId}_copy`);
                  if (newId) void run(() => duplicateBillingTemplate(editing.originalId as string, newId.trim(), `${def.name} (copy)`), "Copied as a draft.");
                }}>Duplicate</button> : null}
                {isAdmin && editing.originalId && selected?.status !== "archived" ? <button type="button" className={danger} disabled={busy}
                  onClick={() => void run(() => archiveBillingTemplate(editing.originalId as string), "Archived.")}>Archive</button> : null}
              </div>
            </div>
            {localErrors.length && !readOnly ? <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-300">{localErrors.map(text => <li key={text}>{text}</li>)}</ul> : null}
            <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
              <label className="text-xs font-bold text-[var(--app-muted)]">Id
                <input className={`${inputClass} mt-1 font-mono`} value={def.id} disabled={readOnly || Boolean(editing.originalId)} placeholder="or_neuro_items"
                  onChange={e => patch(current => ({ ...current, id: e.target.value.trim().toLowerCase() }))} />
              </label>
              <label className="text-xs font-bold text-[var(--app-muted)]">Name
                <input className={`${inputClass} mt-1`} value={def.name} disabled={readOnly} placeholder="Neuro OR standing items" onChange={e => patch(current => ({ ...current, name: e.target.value }))} />
              </label>
            </div>
            <label className="block text-xs font-bold text-[var(--app-muted)]">Description
              <textarea className={`${inputClass} mt-1 resize-y`} rows={2} value={def.description || ""} disabled={readOnly} onChange={e => patch(current => ({ ...current, description: e.target.value }))} />
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={readOnly} checked={def.allow_other_items} className="h-4 w-4 accent-[var(--app-accent)]"
              onChange={e => patch(current => ({ ...current, allow_other_items: e.target.checked }))} />Leaf may add items that are not in this template (from the whole billing master)</label>
            {selected?.usedBy.length ? <div className="text-xs text-[var(--app-muted)]">Used by: {selected.usedBy.map(w => `${w.name || w.id} (${w.status})`).join(", ")}</div> : null}
          </div>

          {def.groups.map((group, g) => (
            <div key={group.key} className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-center text-xs font-bold text-[var(--app-muted)]">{g + 1}</span>
                <input className={`${inputClass} !w-auto min-w-56 flex-1 font-semibold`} value={group.name} disabled={readOnly} aria-label="Group name"
                  onChange={e => patchGroup(g, current => ({ ...current, name: e.target.value }))} />
                <span className="font-mono text-[11px] text-[var(--app-muted)]">{group.key}</span>
                {!readOnly ? <div className="flex gap-1">
                  <button type="button" className={tiny} disabled={g === 0} onClick={() => patch(current => ({ ...current, groups: move(current.groups, g, -1) }))} aria-label="Move group up">↑</button>
                  <button type="button" className={tiny} disabled={g === def.groups.length - 1} onClick={() => patch(current => ({ ...current, groups: move(current.groups, g, 1) }))} aria-label="Move group down">↓</button>
                  <button type="button" className={tiny} onClick={() => patch(current => ({ ...current, groups: current.groups.filter((_, i) => i !== g) }))} aria-label="Remove group">✕</button>
                </div> : null}
              </div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[10px] uppercase tracking-[0.1em] text-[var(--app-muted)]"><th className="w-8" /><th className="py-1">Item</th><th className="py-1">Unit</th><th className="py-1">Default qty</th><th className="py-1">Preselect</th><th /></tr></thead>
                <tbody>{group.items.map((entry, i) => {
                  const master = item.get(entry.code);
                  return (
                    <tr key={entry.code} className="border-t border-[var(--app-border)]">
                      <td className="py-1 text-center text-xs text-[var(--app-muted)]">{i + 1}</td>
                      <td className="py-1">{master?.name || <span className="text-rose-500">{entry.code} (not in master)</span>} <span className="font-mono text-[10px] text-[var(--app-muted)]">{entry.code}</span></td>
                      <td className="py-1 text-xs">{master?.qty_mode === "used" ? "used" : master?.unit || ""}</td>
                      <td className="py-1">{master?.qty_mode === "used" ? <span className="text-xs text-[var(--app-muted)]">—</span> : (
                        <input className={`${inputClass} !w-20 !py-1 text-right`} inputMode="decimal" disabled={readOnly} value={entry.qty ?? ""} placeholder="1"
                          onChange={e => patchGroup(g, current => ({ ...current, items: current.items.map((x, j) => (j === i ? { ...x, qty: e.target.value === "" ? null : Number(e.target.value.replace(/[^0-9.]/g, "")) } : x)) }))} />
                      )}</td>
                      <td className="py-1"><input type="checkbox" disabled={readOnly} checked={Boolean(entry.preselect)} className="h-4 w-4 accent-[var(--app-accent)]" aria-label={`Preselect ${master?.name || entry.code}`}
                        onChange={e => patchGroup(g, current => ({ ...current, items: current.items.map((x, j) => (j === i ? { ...x, preselect: e.target.checked } : x)) }))} /></td>
                      <td className="py-1 text-right">{!readOnly ? <div className="inline-flex gap-1">
                        <button type="button" className={tiny} disabled={i === 0} onClick={() => patchGroup(g, current => ({ ...current, items: move(current.items, i, -1) }))} aria-label="Move up">↑</button>
                        <button type="button" className={tiny} disabled={i === group.items.length - 1} onClick={() => patchGroup(g, current => ({ ...current, items: move(current.items, i, 1) }))} aria-label="Move down">↓</button>
                        <button type="button" className={tiny} onClick={() => patchGroup(g, current => ({ ...current, items: current.items.filter((_, j) => j !== i) }))} aria-label="Remove">✕</button>
                      </div> : null}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {!readOnly ? <div className="flex flex-wrap gap-2">
                <select className={`${inputClass} max-w-md`} value={adding[group.key] || ""} onChange={e => setAdding(a => ({ ...a, [group.key]: e.target.value }))} aria-label="Item to add">
                  <option value="">Add an item from the billing master…</option>
                  {catalog.groups.map(master => (
                    <optgroup key={master.code} label={master.name}>
                      {catalog.items.filter(row => row.group_code === master.code && !used.has(row.code)).map(row => <option key={row.code} value={row.code}>{row.name}</option>)}
                    </optgroup>
                  ))}
                </select>
                <button type="button" className={secondary} disabled={!adding[group.key]} onClick={() => {
                  const code = adding[group.key];
                  patchGroup(g, current => ({ ...current, items: [...current.items, { code }] }));
                  setAdding(a => ({ ...a, [group.key]: "" }));
                }}>Add</button>
              </div> : null}
            </div>
          ))}

          {!readOnly ? <div className={`${card} flex flex-wrap items-center gap-2`}>
            <button type="button" className={secondary} onClick={() => addGroup()}>+ Empty group</button>
            <span className="text-xs text-[var(--app-muted)]">or copy a master group:</span>
            {catalog.groups.map(master => (
              <button key={master.code} type="button" className={`${secondary} !px-2 !py-1 text-xs`} onClick={() => addGroup(master.name, catalog.items.filter(row => row.group_code === master.code))}>+ {master.name}</button>
            ))}
          </div> : null}
        </section>
      )}
    </div>
  );
}
