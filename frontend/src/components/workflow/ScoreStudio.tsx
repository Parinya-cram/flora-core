import { useCallback, useEffect, useState } from "react";
import {
  archiveScore, createScore, duplicateScore, emptyScore, getScoreOptions, importLibraryScore, listScores, publishScore, saveScore,
  tryScore, validateScore,
  type BillingTemplateIssue, type ScoreBand, type ScoreDefinition, type ScoreInput, type ScoreItem, type ScoreOptions, type ScoreRow,
  type ScoreTryResult,
} from "../../api/workflowApi";
import { LEVEL_TONE } from "./scoreTone";

/**
 * Workflow Studio → Scores: clinical scores (`flora-score/1`, app/scoring.py) such as NEWS2 or
 * Aldrete. Inputs read charted or device parameters (looking back a window) or are entered by the
 * clinician; items turn a value into points by bands, options or a Form Studio formula. Workflows
 * list the scores they use; the Leaf computes `auto` scores every interval from the chart.
 */

const inputClass = "w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const cell = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const danger = "rounded-xl border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-500 disabled:opacity-50";
const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4";
const tiny = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-bold text-[var(--app-text)] disabled:opacity-40";
const label = "text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--app-muted)]";
const ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const statusBadge: Record<string, string> = {
  draft: "border-amber-400/40 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  published: "border-emerald-400/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  archived: "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]",
};

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const numberOrUndefined = (text: string) => (text.trim() === "" || !Number.isFinite(Number(text)) ? undefined : Number(text));
function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
function omit<T extends object>(value: T, ...keys: string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;
}
function parseOptionValue(text: string): string | number | boolean {
  if (text === "true" || text === "false") return text === "true";
  return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
}

type Editing = { originalId: string | null; definition: ScoreDefinition };

function BandsEditor({ bands, valueKey, readOnly, onChange }: {
  bands: ScoreBand[]; valueKey: "points" | "label"; readOnly: boolean; onChange: (bands: ScoreBand[]) => void;
}) {
  const set = (index: number, change: Partial<ScoreBand>) => onChange(bands.map((band, i) => {
    if (i !== index) return band;
    const next = { ...band, ...change };
    for (const key of Object.keys(next) as Array<keyof ScoreBand>) if (next[key] === undefined || next[key] === "") delete next[key];
    return next;
  }));
  return <div className="space-y-1">
    <div className={`grid gap-1 ${valueKey === "points" ? "grid-cols-[1fr_1fr_1fr_auto]" : "grid-cols-[80px_80px_1fr_110px_2fr_auto]"}`}>
      <span className={label}>Min ≥</span><span className={label}>Max ≤</span>
      {valueKey === "points" ? <span className={label}>Points</span> : <><span className={label}>Label</span><span className={label}>Level</span><span className={label}>Action</span></>}
      <span />
      {bands.map((band, index) => <div key={index} className="contents">
        <input className={cell} disabled={readOnly} value={band.min ?? ""} placeholder="—" inputMode="decimal" onChange={e => set(index, { min: numberOrUndefined(e.target.value) })} />
        <input className={cell} disabled={readOnly} value={band.max ?? ""} placeholder="—" inputMode="decimal" onChange={e => set(index, { max: numberOrUndefined(e.target.value) })} />
        {valueKey === "points"
          ? <input className={cell} disabled={readOnly} value={band.points ?? ""} inputMode="decimal" onChange={e => set(index, { points: numberOrUndefined(e.target.value) })} />
          : <>
            <input className={cell} disabled={readOnly} value={band.label ?? ""} onChange={e => set(index, { label: e.target.value })} />
            <select className={cell} disabled={readOnly} value={band.level || "info"} onChange={e => set(index, { level: e.target.value as ScoreBand["level"] })}>
              <option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option>
            </select>
            <input className={cell} disabled={readOnly} value={band.action ?? ""} placeholder="What to do" onChange={e => set(index, { action: e.target.value || undefined })} />
          </>}
        {!readOnly ? <button type="button" className={tiny} onClick={() => onChange(bands.filter((_, i) => i !== index))} aria-label="Remove band">✕</button> : <span />}
      </div>)}
    </div>
    {!readOnly ? <button type="button" className={tiny} onClick={() => onChange([...bands, valueKey === "points" ? { points: 0 } : { label: "", level: "info" }])}>+ Band</button> : null}
  </div>;
}

export default function ScoreStudio({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [options, setOptions] = useState<ScoreOptions>({ parameters: [], library: [] });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [issues, setIssues] = useState<BillingTemplateIssue[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [tryValues, setTryValues] = useState<Record<string, string>>({});
  const [tried, setTried] = useState<ScoreTryResult | null>(null);

  const load = useCallback(async (selectId?: string) => {
    try {
      const [nextRows, nextOptions] = await Promise.all([listScores(), getScoreOptions()]);
      setRows(nextRows);
      setOptions(nextOptions);
      if (selectId) {
        const row = nextRows.find(item => item.id === selectId);
        if (row) setEditing({ originalId: row.id, definition: row.definition });
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);
  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  const selected = editing?.originalId ? rows.find(row => row.id === editing.originalId) || null : null;
  const readOnly = !isAdmin || selected?.status === "archived";
  const def = editing?.definition;
  const inputKeys = def ? Object.keys(def.inputs) : [];

  const open = (next: Editing | null) => { setEditing(next); setIssues([]); setNote(""); setError(""); setJsonText(null); setTried(null); setTryValues({}); };
  const patch = (change: (current: ScoreDefinition) => ScoreDefinition) => {
    setEditing(current => (current ? { ...current, definition: change(current.definition) } : current));
    setIssues([]);
    setTried(null);
  };
  const patchInput = (key: string, change: Partial<ScoreInput>) => patch(current => {
    const next = { ...current.inputs[key], ...change };
    for (const name of Object.keys(next) as Array<keyof ScoreInput>) if (next[name] === undefined) delete next[name];
    return { ...current, inputs: { ...current.inputs, [key]: next } };
  });
  const renameInput = (key: string, nextKey: string) => patch(current => ({
    ...current,
    inputs: Object.fromEntries(Object.entries(current.inputs).map(([name, entry]) => [name === key ? nextKey : name, entry])),
    items: current.items.map(item => (item.input === key ? { ...item, input: nextKey } : item)),
  }));
  const patchItem = (index: number, change: (item: ScoreItem) => ScoreItem) =>
    patch(current => ({ ...current, items: current.items.map((item, i) => (i === index ? change(item) : item)) }));

  const run = async (action: () => Promise<ScoreRow | void>, message: string) => {
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
  const save = () => def && run(async () => (editing?.originalId ? saveScore(editing.originalId, def) : createScore(def)), "Draft saved.");
  const publish = () => def && run(async () => {
    const saved = editing?.originalId ? await saveScore(editing.originalId, def) : await createScore(def);
    const check = await validateScore(saved.definition);
    if (check.issues.length) { setIssues(check.issues); throw new Error("Fix the problems below before publishing."); }
    return publishScore(saved.id);
  }, "Published. Wards whose workflows use this score receive it at their next sync.");
  const check = async () => {
    if (!def) return;
    try {
      const result = await validateScore(def);
      setIssues(result.issues);
      setNote(result.issues.length ? "" : "No problems found.");
    } catch (reason) { setError(errorText(reason)); }
  };
  const runTry = async () => {
    if (!def) return;
    try {
      setTried(await tryScore(def, Object.fromEntries(Object.entries(tryValues).filter(([, value]) => value !== ""))));
    } catch (reason) { setError(errorText(reason)); }
  };

  const localErrors = !def ? [] : [
    ...(!ID_PATTERN.test(def.id) ? ["Id: lower-case letters, digits and _ (2–64), starting with a letter."] : []),
    ...(!def.name.trim() ? ["Name is required."] : []),
  ];
  const visible = rows.filter(row => showArchived || row.status !== "archived");
  const library = options.library.filter(item => !item.imported);

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section className="h-fit space-y-4">
        <div className={`${card} space-y-2`}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold">Scores <span className="text-[var(--app-muted)]">{visible.length}</span></h2>
            <label className="flex items-center gap-1 text-xs text-[var(--app-muted)]"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="accent-[var(--app-accent)]" />Archived</label>
          </div>
          {isAdmin ? <button type="button" className={`${primary} w-full`} onClick={() => open({ originalId: null, definition: emptyScore() })}>+ New score</button> : null}
          {visible.map(row => (
            <button key={row.id} type="button" onClick={() => open({ originalId: row.id, definition: row.definition })}
              className={`w-full rounded-xl border p-3 text-left transition ${editing?.originalId === row.id ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:border-[var(--app-accent)]/60"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><div className="truncate text-sm font-bold">{row.name || row.id}</div><div className="truncate font-mono text-[11px] text-[var(--app-muted)]">{row.id}</div></div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadge[row.status]}`}>{row.status}</span>
              </div>
              <div className="mt-1 text-[11px] text-[var(--app-muted)]">v{row.version} · {row.mode === "auto" ? `every ${row.definition.interval_min} min` : "run by clinician"} · {row.itemCount} items · {row.usedBy.length ? `used by ${row.usedBy.map(w => w.name || w.id).join(", ")}` : "not used yet"}</div>
            </button>
          ))}
        </div>
        {isAdmin && library.length ? <div className={`${card} space-y-2`}>
          <div><h3 className="text-sm font-bold">Score library</h3><p className="text-xs text-[var(--app-muted)]">Validated scores with their reference. They are added as drafts: review the bands with the clinical team, then publish.</p></div>
          {library.map(item => <div key={item.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2">
            <div className="flex items-center justify-between gap-2"><b className="text-sm">{item.name}</b>
              <button type="button" className={tiny} disabled={busy} onClick={() => void run(() => importLibraryScore(item.id), `${item.name} added as a draft.`)}>Add</button></div>
            <p className="mt-1 text-[11px] text-[var(--app-muted)]">{item.description}</p>
          </div>)}
        </div> : null}
      </section>

      {!editing || !def ? <section className={`${card} text-sm text-[var(--app-muted)]`}>Select a score{isAdmin ? ", add one from the library or create a new one" : ""}. A workflow lists its scores under <b>Scores</b>; the Leaf computes automatic scores from the chart every interval and shows them under the vital signs.</section> : (
        <section className="space-y-4">
          {error ? <div className="whitespace-pre-line rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-500">{error}</div> : null}
          {note ? <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-300">{note}</div> : null}
          {issues.length ? <ul className="list-disc rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 pl-8 text-sm text-amber-700 dark:text-amber-300">{issues.map(issue => <li key={`${issue.path}${issue.message}`}><span className="font-mono text-[11px]">{issue.path}</span> {issue.message}</li>)}</ul> : null}

          <div className={`${card} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold">{editing.originalId ? def.name || editing.originalId : "New score"}
                {selected ? <span className={`ml-2 rounded-full border px-2 py-0.5 align-middle text-[10px] font-bold uppercase ${statusBadge[selected.status]}`}>{selected.status} · v{selected.version}</span> : null}
              </h2>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondary} disabled={busy} onClick={() => void check()}>Check</button>
                {isAdmin && !readOnly ? <>
                  <button type="button" className={secondary} disabled={busy || localErrors.length > 0} onClick={() => void save()}>Save draft</button>
                  <button type="button" className={primary} disabled={busy || localErrors.length > 0} onClick={() => void publish()}>Publish</button>
                </> : null}
                {isAdmin && editing.originalId ? <button type="button" className={secondary} disabled={busy} onClick={() => {
                  const newId = window.prompt("Id of the copy (a-z, 0-9, _)", `${editing.originalId}_copy`);
                  if (newId) void run(() => duplicateScore(editing.originalId as string, newId.trim(), `${def.name} (copy)`), "Copied as a draft.");
                }}>Duplicate</button> : null}
                {isAdmin && editing.originalId && selected?.status !== "archived" ? <button type="button" className={danger} disabled={busy}
                  onClick={() => void run(() => archiveScore(editing.originalId as string), "Archived.")}>Archive</button> : null}
              </div>
            </div>
            {localErrors.length && !readOnly ? <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-300">{localErrors.map(text => <li key={text}>{text}</li>)}</ul> : null}
            <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
              <label className="text-xs font-bold text-[var(--app-muted)]">Id
                <input className={`${inputClass} mt-1 font-mono`} value={def.id} disabled={readOnly || Boolean(editing.originalId)} placeholder="news2"
                  onChange={e => patch(current => ({ ...current, id: e.target.value.trim().toLowerCase() }))} />
              </label>
              <label className="text-xs font-bold text-[var(--app-muted)]">Name
                <input className={`${inputClass} mt-1`} value={def.name} disabled={readOnly} placeholder="NEWS2" onChange={e => patch(current => ({ ...current, name: e.target.value }))} />
              </label>
            </div>
            <label className="block text-xs font-bold text-[var(--app-muted)]">Description
              <textarea className={`${inputClass} mt-1 resize-y`} rows={2} value={def.description || ""} disabled={readOnly} onChange={e => patch(current => ({ ...current, description: e.target.value }))} />
            </label>
            <label className="block text-xs font-bold text-[var(--app-muted)]">Reference (publication the bands come from)
              <input className={`${inputClass} mt-1`} value={def.reference || ""} disabled={readOnly} onChange={e => patch(current => ({ ...current, reference: e.target.value }))} />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-bold text-[var(--app-muted)]">Mode
                <select className={`${inputClass} mt-1`} disabled={readOnly} value={def.mode} onChange={e => patch(current => ({ ...current, mode: e.target.value as ScoreDefinition["mode"] }))}>
                  <option value="auto">Automatic, from the chart</option><option value="manual">Run by the clinician</option>
                </select>
              </label>
              <label className="text-xs font-bold text-[var(--app-muted)]">Every (minutes)
                <input className={`${inputClass} mt-1`} inputMode="numeric" disabled={readOnly || def.mode === "manual"} value={def.interval_min}
                  onChange={e => patch(current => ({ ...current, interval_min: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 }))} />
              </label>
              <label className="text-xs font-bold text-[var(--app-muted)]">When a reading is missing
                <select className={`${inputClass} mt-1`} disabled={readOnly} value={def.missing} onChange={e => patch(current => ({ ...current, missing: e.target.value as ScoreDefinition["missing"] }))}>
                  <option value="partial">Show a partial total</option><option value="none">No total until complete</option>
                </select>
              </label>
            </div>
            {selected?.usedBy.length ? <div className="text-xs text-[var(--app-muted)]">Used by: {selected.usedBy.map(w => `${w.name || w.id} (${w.status})`).join(", ")}</div> : null}
          </div>

          <div className={`${card} space-y-2`}>
            <div><h3 className="font-bold">Inputs</h3><p className="text-xs text-[var(--app-muted)]">A parameter input takes the chart value (device or charted, masked readings left out) within the window before each time point; older readings count as missing.</p></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-xs">
              <thead><tr className="text-left"><th className={label}>Key</th><th className={label}>Label</th><th className={label}>Source</th><th className={label}>Parameter</th><th className={label}>Fallback</th><th className={label}>Window</th><th className={label}>Value</th><th className={label}>Type</th><th className={label}>Round</th><th /></tr></thead>
              <tbody>{Object.entries(def.inputs).map(([key, entry]) => (
                <tr key={key} className="border-t border-[var(--app-border)] align-top">
                  <td className="py-1 pr-1"><input className={`${cell} font-mono`} disabled={readOnly} defaultValue={key} onBlur={e => {
                    const next = e.target.value.trim().toLowerCase();
                    if (next !== key && KEY_PATTERN.test(next) && !def.inputs[next]) renameInput(key, next); else e.target.value = key;
                  }} /></td>
                  <td className="py-1 pr-1"><input className={cell} disabled={readOnly} value={entry.label || ""} onChange={e => patchInput(key, { label: e.target.value })} /></td>
                  <td className="py-1 pr-1"><select className={cell} disabled={readOnly} value={entry.source} onChange={e => patchInput(key, e.target.value === "param" ? { source: "param", param: entry.param || key, window_min: 60, agg: "latest" } : { source: "manual", param: undefined, fallback: undefined, window_min: undefined, agg: undefined })}>
                    <option value="param">Chart parameter</option><option value="manual">Entered when run</option></select></td>
                  <td className="py-1 pr-1">{entry.source === "param" ? <select className={cell} disabled={readOnly} value={entry.param || ""} onChange={e => patchInput(key, { param: e.target.value })}>
                    {!options.parameters.some(p => p.param_key === entry.param) ? <option value={entry.param || ""}>{entry.param || "—"} (unknown)</option> : null}
                    {options.parameters.map(p => <option key={p.param_key} value={p.param_key}>{p.label} ({p.param_key})</option>)}
                  </select> : null}</td>
                  <td className="py-1 pr-1">{entry.source === "param" ? <input className={`${cell} font-mono`} disabled={readOnly} value={(entry.fallback || []).join(", ")} placeholder="art_sys"
                    onChange={e => patchInput(key, { fallback: e.target.value.split(",").map(text => text.trim()).filter(Boolean) })} /> : null}</td>
                  <td className="py-1 pr-1">{entry.source === "param" ? <input className={cell} disabled={readOnly} inputMode="numeric" value={entry.window_min ?? ""} title="minutes"
                    onChange={e => patchInput(key, { window_min: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })} /> : null}</td>
                  <td className="py-1 pr-1">{entry.source === "param" ? <select className={cell} disabled={readOnly} value={entry.agg || "latest"} onChange={e => patchInput(key, { agg: e.target.value as ScoreInput["agg"] })}>
                    <option value="latest">latest</option><option value="min">lowest</option><option value="max">highest</option><option value="avg">average</option></select> : null}</td>
                  <td className="py-1 pr-1"><select className={cell} disabled={readOnly} value={entry.type || "number"} onChange={e => patchInput(key, { type: e.target.value as ScoreInput["type"] })}>
                    <option value="number">number</option><option value="text">text</option><option value="bool">yes/no</option></select></td>
                  <td className="py-1 pr-1"><input className={cell} disabled={readOnly} inputMode="numeric" value={entry.round ?? ""} placeholder="—" title="decimals"
                    onChange={e => patchInput(key, { round: numberOrUndefined(e.target.value) })} /></td>
                  <td className="py-1 text-right">{!readOnly ? <button type="button" className={tiny} onClick={() => patch(current => ({ ...current, inputs: omit(current.inputs, key) }))} aria-label="Remove input">✕</button> : null}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {!readOnly ? <button type="button" className={tiny} onClick={() => patch(current => {
              let n = Object.keys(current.inputs).length + 1;
              while (current.inputs[`input${n}`]) n += 1;
              return { ...current, inputs: { ...current.inputs, [`input${n}`]: { source: "param", param: options.parameters[0]?.param_key || "hr", window_min: 60, agg: "latest", label: "" } } };
            })}>+ Input</button> : null}
          </div>

          {def.items.map((item, index) => {
            const kind = item.formula !== undefined ? "formula" : item.options ? "options" : "bands";
            return <div key={index} className={`${card} space-y-2`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-center text-xs font-bold text-[var(--app-muted)]">{index + 1}</span>
                <input className={`${cell} !w-32 font-mono`} disabled={readOnly} value={item.key} aria-label="Item key" onChange={e => patchItem(index, current => ({ ...current, key: e.target.value.trim().toLowerCase() }))} />
                <input className={`${cell} min-w-48 flex-1 !text-sm font-semibold`} disabled={readOnly} value={item.label} aria-label="Item label" onChange={e => patchItem(index, current => ({ ...current, label: e.target.value }))} />
                <select className={`${cell} !w-auto`} disabled={readOnly} value={kind} aria-label="Points from" onChange={e => patchItem(index, current => {
                  const rest = omit(current, "formula", "options", "bands", "requires");
                  if (e.target.value === "formula") return { ...rest, input: undefined, formula: "" };
                  return { ...rest, input: current.input || inputKeys[0], ...(e.target.value === "options" ? { options: [] } : { bands: [] }) };
                })}>
                  <option value="bands">Points by range</option><option value="options">Points by value</option><option value="formula">Formula</option>
                </select>
                {!readOnly ? <div className="flex gap-1">
                  <button type="button" className={tiny} disabled={index === 0} onClick={() => patch(current => ({ ...current, items: move(current.items, index, -1) }))} aria-label="Move up">↑</button>
                  <button type="button" className={tiny} disabled={index === def.items.length - 1} onClick={() => patch(current => ({ ...current, items: move(current.items, index, 1) }))} aria-label="Move down">↓</button>
                  <button type="button" className={tiny} onClick={() => patch(current => ({ ...current, items: current.items.filter((_, i) => i !== index) }))} aria-label="Remove item">✕</button>
                </div> : null}
              </div>
              {kind !== "formula" ? <label className="flex items-center gap-2 text-xs"><span className={label}>Input</span>
                <select className={`${cell} !w-auto`} disabled={readOnly} value={item.input || ""} onChange={e => patchItem(index, current => ({ ...current, input: e.target.value }))}>
                  {!inputKeys.includes(item.input || "") ? <option value={item.input || ""}>{item.input || "—"}</option> : null}
                  {inputKeys.map(key => <option key={key} value={key}>{def.inputs[key].label || key} ({key})</option>)}
                </select></label> : <div className="space-y-1">
                <textarea className={`${cell} resize-y font-mono`} rows={2} disabled={readOnly} value={item.formula || ""} aria-label="Formula"
                  onChange={e => patchItem(index, current => ({ ...current, formula: e.target.value }))} />
                <p className="text-[11px] text-[var(--app-muted)]">Form Studio formula over the input keys ({inputKeys.join(", ") || "none"}) and earlier items as <code>points.key</code>. It gives the points, or a value for the ranges below. Missing inputs leave the item missing unless listed as optional.</p>
                <label className="flex items-center gap-2 text-xs"><span className={label}>Needs</span>
                  <input className={`${cell} font-mono`} disabled={readOnly} value={item.requires ? item.requires.join(", ") : ""} placeholder="every input it names"
                    onChange={e => patchItem(index, current => {
                      const names = e.target.value.split(",").map(text => text.trim()).filter(Boolean);
                      const rest = omit(current, "requires");
                      return e.target.value.trim() === "" ? rest : { ...rest, requires: names };
                    })} /></label>
              </div>}
              {kind === "options" ? <div className="space-y-1">
                <div className="grid grid-cols-[1fr_1fr_2fr_auto] gap-1">
                  <span className={label}>Value</span><span className={label}>Points</span><span className={label}>Label</span><span />
                  {(item.options || []).map((option, o) => <div key={o} className="contents">
                    <input className={`${cell} font-mono`} disabled={readOnly} value={String(option.value)} onChange={e => patchItem(index, current => ({ ...current, options: (current.options || []).map((x, j) => (j === o ? { ...x, value: parseOptionValue(e.target.value) } : x)) }))} />
                    <input className={cell} disabled={readOnly} inputMode="decimal" value={option.points} onChange={e => patchItem(index, current => ({ ...current, options: (current.options || []).map((x, j) => (j === o ? { ...x, points: Number(e.target.value) || 0 } : x)) }))} />
                    <input className={cell} disabled={readOnly} value={option.label || ""} onChange={e => patchItem(index, current => ({ ...current, options: (current.options || []).map((x, j) => (j === o ? { ...x, label: e.target.value || undefined } : x)) }))} />
                    {!readOnly ? <button type="button" className={tiny} onClick={() => patchItem(index, current => ({ ...current, options: (current.options || []).filter((_, j) => j !== o) }))} aria-label="Remove value">✕</button> : <span />}
                  </div>)}
                </div>
                {!readOnly ? <button type="button" className={tiny} onClick={() => patchItem(index, current => ({ ...current, options: [...(current.options || []), { value: "", points: 0 }] }))}>+ Value</button> : null}
              </div> : null}
              {kind === "bands" || (kind === "formula" && item.bands) ? <BandsEditor bands={item.bands || []} valueKey="points" readOnly={readOnly}
                onChange={bands => patchItem(index, current => ({ ...current, bands }))} /> : null}
              {kind === "formula" && !item.bands && !readOnly ? <button type="button" className={tiny} onClick={() => patchItem(index, current => ({ ...current, bands: [] }))}>+ Ranges for the formula value</button> : null}
            </div>;
          })}
          {!readOnly ? <div className={card}><button type="button" className={secondary} onClick={() => patch(current => ({
            ...current, items: [...current.items, { key: `item${current.items.length + 1}`, label: "New item", input: inputKeys[0], bands: [] }],
          }))}>+ Item</button></div> : null}

          <div className={`${card} space-y-3`}>
            <div><h3 className="font-bold">Total and interpretation</h3><p className="text-xs text-[var(--app-muted)]">The total is the sum of the item points unless a formula is given (names: <code>points.key</code>, <code>max_points</code>, <code>missing_count</code>).</p></div>
            <input className={`${cell} font-mono`} disabled={readOnly} value={def.total?.formula || ""} placeholder="sum of item points"
              onChange={e => patch(current => ({ ...current, total: e.target.value.trim() ? { formula: e.target.value } : {} }))} />
            <BandsEditor bands={def.bands} valueKey="label" readOnly={readOnly} onChange={bands => patch(current => ({ ...current, bands }))} />
            <div className="space-y-1">
              <div className={label}>Alerts (formula is true → show)</div>
              {def.flags.map((flag, f) => <div key={f} className="grid grid-cols-[2fr_2fr_110px_auto] gap-1">
                <input className={`${cell} font-mono`} disabled={readOnly} value={flag.when} placeholder="max_points >= 3" onChange={e => patch(current => ({ ...current, flags: current.flags.map((x, j) => (j === f ? { ...x, when: e.target.value } : x)) }))} />
                <input className={cell} disabled={readOnly} value={flag.label} placeholder="Message" onChange={e => patch(current => ({ ...current, flags: current.flags.map((x, j) => (j === f ? { ...x, label: e.target.value } : x)) }))} />
                <select className={cell} disabled={readOnly} value={flag.level} onChange={e => patch(current => ({ ...current, flags: current.flags.map((x, j) => (j === f ? { ...x, level: e.target.value as typeof flag.level } : x)) }))}>
                  <option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option></select>
                {!readOnly ? <button type="button" className={tiny} onClick={() => patch(current => ({ ...current, flags: current.flags.filter((_, j) => j !== f) }))} aria-label="Remove alert">✕</button> : <span />}
              </div>)}
              {!readOnly ? <button type="button" className={tiny} onClick={() => patch(current => ({ ...current, flags: [...current.flags, { when: "", label: "", level: "warning" }] }))}>+ Alert</button> : null}
            </div>
          </div>

          <div className={`${card} space-y-3`}>
            <div><h3 className="font-bold">Try it</h3><p className="text-xs text-[var(--app-muted)]">Type values to check the bands before publishing (empty = missing).</p></div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{Object.entries(def.inputs).map(([key, entry]) => (
              <label key={key} className="text-xs font-bold text-[var(--app-muted)]">{entry.label || key}{entry.unit ? ` (${entry.unit})` : ""}
                <input className={`${inputClass} mt-1`} value={tryValues[key] ?? ""} placeholder={entry.type === "bool" ? "yes / no" : entry.default !== undefined ? `default ${String(entry.default)}` : ""}
                  onChange={e => setTryValues(values => ({ ...values, [key]: e.target.value }))} />
              </label>
            ))}</div>
            <button type="button" className={secondary} onClick={() => void runTry()}>Calculate</button>
            {tried ? <div className="space-y-2">
              <div className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold ${LEVEL_TONE[tried.level || "info"]}`}>
                Total {tried.total ?? "—"}{tried.band ? ` · ${tried.band}` : ""}{tried.partial ? " (partial)" : ""}
              </div>
              <table className="w-full text-xs"><tbody>{tried.items.map(item => <tr key={item.key} className="border-t border-[var(--app-border)]">
                <td className="py-1">{item.label}</td><td className="py-1 font-mono">{item.value === null || item.value === undefined ? "—" : String(item.value)}</td>
                <td className="py-1 text-right font-bold">{item.points ?? <span className="text-amber-600">missing</span>}</td></tr>)}</tbody></table>
              {tried.flags.map(flag => <div key={flag.label} className={`rounded-lg border px-2 py-1 text-xs ${LEVEL_TONE[flag.level]}`}>{flag.label}</div>)}
            </div> : null}
          </div>

          <details className={card} onToggle={e => { if ((e.target as HTMLDetailsElement).open) setJsonText(JSON.stringify(def, null, 2)); }}>
            <summary className="cursor-pointer text-sm font-bold">Score JSON</summary>
            <textarea className={`${cell} mt-3 h-[420px] resize-y font-mono`} disabled={readOnly} value={jsonText ?? ""} onChange={e => setJsonText(e.target.value)} />
            {!readOnly ? <button type="button" className={`${secondary} mt-2`} onClick={() => {
              try {
                const parsed = JSON.parse(jsonText || "{}") as ScoreDefinition;
                patch(current => ({ ...emptyScore(), ...parsed, id: editing.originalId || parsed.id || current.id }));
                setNote("JSON applied (not saved yet).");
              } catch (reason) { setError(`JSON: ${errorText(reason)}`); }
            }}>Apply JSON</button> : null}
          </details>
        </section>
      )}
    </div>
  );
}
