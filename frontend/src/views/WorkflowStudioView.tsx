import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canAuthorStudio } from "../auth/studioAccess";
import type { AuthUser } from "../auth/useAuth";
import {
  archiveWorkflow,
  createWorkflow,
  emptyWorkflow,
  exportWorkflow,
  getWorkflowOptions,
  importWorkflow,
  listBillingTemplates,
  listScores,
  listWorkflows,
  publishWorkflow,
  setWorkflowWards,
  updateWorkflow,
  type WorkflowDefinition,
  type WorkflowFormRef,
  type WorkflowImportResult,
  type WorkflowOptions,
  type WorkflowPacketEntry,
  type WorkflowPhase,
  type WorkflowReportMode,
  type WorkflowRow,
  type BillingTemplateRow,
  type ScoreRow,
} from "../api/workflowApi";
import BillingTemplateStudio from "../components/workflow/BillingTemplateStudio";
import ScoreStudio from "../components/workflow/ScoreStudio";

/** Canopy → Workflow Studio: what a case records and prints (docs/workflow-studio.md). */

const inputClass = "w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] disabled:opacity-60";
const primary = "rounded-xl border border-[var(--app-accent)] bg-[var(--app-accent)] px-4 py-2 text-sm font-bold text-[var(--app-accent-contrast)] disabled:opacity-50";
const secondary = "rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-text)] disabled:opacity-50";
const danger = "rounded-xl border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-500 disabled:opacity-50";
const card = "rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-bg)] p-4";
const tiny = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs font-bold text-[var(--app-text)] disabled:opacity-40";
const ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const PHASES: WorkflowPhase[] = ["preop", "intraop", "postop", "any"];
const MODES: WorkflowReportMode[] = ["standard", "smart_fit", "detail"];

type WardPick = { unitKey: string; isDefault: boolean };
type Editing = { originalId: string | null; definition: WorkflowDefinition; wards: WardPick[] };

const statusBadge: Record<string, string> = {
  draft: "border-amber-400/40 bg-amber-400/10 text-amber-600 dark:text-amber-300",
  published: "border-emerald-400/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  archived: "border-[var(--app-border)] bg-[var(--app-control-bg)] text-[var(--app-muted)]",
};

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function normalizeDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const base = emptyWorkflow();
  return {
    ...base,
    ...definition,
    format: "flora-workflow/1",
    anesthesia_record: { ...base.anesthesia_record, ...(definition.anesthesia_record || {}) },
    forms: Array.isArray(definition.forms) ? definition.forms : [],
    packet: Array.isArray(definition.packet) ? definition.packet : [],
    billing: { template_id: definition.billing?.template_id ?? null },
    scores: Array.isArray(definition.scores) ? definition.scores : [],
  };
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function editingFrom(row: WorkflowRow): Editing {
  const { bundled_forms: _bundled, ...definition } = normalizeDefinition(row.definition);
  void _bundled;
  return {
    originalId: row.id,
    definition: { ...definition, id: row.id, name: definition.name || row.name, description: definition.description ?? row.description ?? "" },
    wards: [...(row.wards || [])].sort((a, b) => a.sortOrder - b.sortOrder).map(ward => ({ unitKey: ward.unitKey, isDefault: ward.isDefault })),
  };
}

function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function WorkflowStudioView({ sessionUser }: { sessionUser: AuthUser | null }) {
  // Authoring needs studio.manage (system and clinical administrators), the same check the API makes.
  const isAdmin = canAuthorStudio(sessionUser);

  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [options, setOptions] = useState<WorkflowOptions>({ sections: [], forms: [], wards: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [importResult, setImportResult] = useState<WorkflowImportResult | null>(null);
  const [addFormId, setAddFormId] = useState("");
  const [mode, setMode] = useState<"workflows" | "templates" | "scores">("workflows");
  const [templates, setTemplates] = useState<BillingTemplateRow[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (selectId?: string) => {
    setLoading(true);
    setError("");
    try {
      const [nextRows, nextOptions, nextTemplates, nextScores] = await Promise.all([
        listWorkflows(),
        getWorkflowOptions().catch(() => ({ sections: [], forms: [], wards: [] }) as WorkflowOptions),
        listBillingTemplates().catch(() => [] as BillingTemplateRow[]),
        listScores().catch(() => [] as ScoreRow[]),
      ]);
      setTemplates(nextTemplates);
      setScores(nextScores);
      setRows(nextRows);
      setOptions({ sections: nextOptions.sections || [], forms: nextOptions.forms || [], wards: nextOptions.wards || [] });
      if (selectId) {
        const row = nextRows.find(item => item.id === selectId);
        if (row) setEditing(editingFrom(row));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => { if (alive) void load(); });
    return () => { alive = false; };
  }, [load]);

  const selectedRow = editing?.originalId ? rows.find(row => row.id === editing.originalId) || null : null;
  const readOnly = !isAdmin || selectedRow?.status === "archived";
  const visibleRows = rows.filter(row => showArchived || row.status !== "archived");
  const wardName = useMemo(() => new Map(options.wards.map(ward => [ward.key, ward.name])), [options.wards]);
  // Wards offering published workflows but none as default: a case started there quickly (or as an emergency) gets
  // no workflow, so its Form Studio forms do not show at the bedside until one is attached to the case.
  const wardsWithoutDefault = useMemo(() => {
    const offered = new Set<string>();
    const defaulted = new Set<string>();
    for (const row of rows) {
      if (row.status !== "published") continue;
      for (const ward of row.wards || []) {
        offered.add(ward.unitKey);
        if (ward.isDefault) defaulted.add(ward.unitKey);
      }
    }
    return [...offered].filter(key => !defaulted.has(key));
  }, [rows]);
  const formOption = useMemo(() => new Map(options.forms.map(form => [form.form_id, form])), [options.forms]);

  const def = editing?.definition;
  const patchDef = (change: (current: WorkflowDefinition) => WorkflowDefinition) =>
    setEditing(current => current && { ...current, definition: change(current.definition) });

  // ---------------------------------------------------------------- sections

  const sectionList = options.sections.length
    ? options.sections
    : ["caseInfo", "preop", "checklist", "pacu", "outcome", "ga_ett", "ga_lma", "ga_tubeless", "neuraxial", "pnb", "line", "comorbid", "extubation", "pain"]
      .map((id, index) => ({ id, label: id, core: index < 5 }));

  const toggleSection = (id: string, key: "sections" | "optional_sections") => patchDef(current => {
    const list = current.anesthesia_record[key];
    const next = list.includes(id) ? list.filter(item => item !== id) : [...list, id];
    return { ...current, anesthesia_record: { ...current.anesthesia_record, [key]: next } };
  });

  // ---------------------------------------------------------------- forms + packet

  const addForm = () => {
    const option = formOption.get(addFormId);
    if (!option || !def || def.forms.some(form => form.form_id === option.form_id)) return;
    const version = option.published_version ?? option.versions[option.versions.length - 1] ?? 1;
    patchDef(current => ({
      ...current,
      // Where Form Studio suggests the form is filled in on Leaf (AI builder), else any time at the end.
      forms: [...current.forms, { form_id: option.form_id, version, title: option.title, phase: option.placement?.phase ?? "any", required: false,
        after_section: option.placement?.after_section ?? null, hint: "", display: "tab" }],
      packet: [...current.packet, { kind: "form", form_id: option.form_id }],
    }));
    setAddFormId("");
  };
  const patchForm = (index: number, change: Partial<WorkflowFormRef>) =>
    patchDef(current => ({ ...current, forms: current.forms.map((form, i) => i === index ? { ...form, ...change } : form) }));
  const removeForm = (formId: string) => patchDef(current => ({
    ...current,
    forms: current.forms.filter(form => form.form_id !== formId),
    packet: current.packet.filter(entry => entry.kind !== "form" || entry.form_id !== formId),
  }));

  const packetLabel = (entry: WorkflowPacketEntry) => {
    if (entry.kind === "anesthesia_report") return "Anesthesia record report";
    const form = def?.forms.find(item => item.form_id === entry.form_id);
    return form?.title || formOption.get(entry.form_id)?.title || entry.form_id;
  };
  const hasReport = Boolean(def?.packet.some(entry => entry.kind === "anesthesia_report"));
  const formsNotInPacket = def ? def.forms.filter(form => !def.packet.some(entry => entry.kind === "form" && entry.form_id === form.form_id)) : [];

  // ---------------------------------------------------------------- wards

  const toggleWard = (unitKey: string) => setEditing(current => {
    if (!current) return current;
    const has = current.wards.some(ward => ward.unitKey === unitKey);
    return { ...current, wards: has ? current.wards.filter(ward => ward.unitKey !== unitKey) : [...current.wards, { unitKey, isDefault: false }] };
  });
  const toggleWardDefault = (unitKey: string) => setEditing(current => current && {
    ...current,
    wards: current.wards.map(ward => ward.unitKey === unitKey ? { ...ward, isDefault: !ward.isDefault } : ward),
  });

  // ---------------------------------------------------------------- actions

  const localErrors = (() => {
    if (!def) return [] as string[];
    const out: string[] = [];
    if (!ID_PATTERN.test(def.id)) out.push("Id must start with a letter and use 2–64 lowercase letters, digits or _.");
    if (!def.name.trim()) out.push("Name is required.");
    if (def.packet.filter(entry => entry.kind === "anesthesia_report").length > 1) out.push("The packet may contain at most one anesthesia report.");
    return out;
  })();

  const wardsChanged = (row: WorkflowRow | null, picks: WardPick[]) => {
    const before = [...(row?.wards || [])].sort((a, b) => a.sortOrder - b.sortOrder).map(ward => `${ward.unitKey}:${ward.isDefault}`).join("|");
    return before !== picks.map(ward => `${ward.unitKey}:${ward.isDefault}`).join("|");
  };

  /** Saves the definition (and ward assignment when it changed); returns the saved id. */
  const saveDraft = async (): Promise<string | null> => {
    if (!editing) return null;
    if (localErrors.length) { setError(localErrors.join("\n")); return null; }
    const definition: WorkflowDefinition = { ...editing.definition, name: editing.definition.name.trim(), format: "flora-workflow/1" };
    let row = editing.originalId ? await updateWorkflow(editing.originalId, definition) : await createWorkflow(definition);
    if (wardsChanged(editing.originalId ? selectedRow : null, editing.wards)) {
      row = await setWorkflowWards(row.id || definition.id, editing.wards.map((ward, index) => ({ unit_key: ward.unitKey, is_default: ward.isDefault, sort_order: index })));
    }
    return row?.id || definition.id;
  };

  const run = async (label: string, action: () => Promise<string | null | void>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const id = await action();
      if (id === null) return;
      await load(typeof id === "string" ? id : editing?.originalId || undefined);
      setNote(label);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => run("Draft saved.", saveDraft);
  const onPublish = () => run("Published.", async () => {
    const id = await saveDraft();
    if (!id) return null;
    await publishWorkflow(id);
    return id;
  });
  const onArchive = () => {
    if (!editing?.originalId) return;
    if (!window.confirm(`Archive workflow “${editing.definition.name || editing.originalId}”? It is removed from its wards' lists.`)) return;
    const id = editing.originalId;
    void run("Archived.", async () => { await archiveWorkflow(id); return id; });
  };
  const onExport = async () => {
    if (!editing?.originalId) return;
    setError("");
    try {
      const file = await exportWorkflow(editing.originalId);
      downloadJson(file, `${editing.originalId}.workflow.json`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setNote("");
    setImportResult(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not valid JSON.`);
      }
      const result = await importWorkflow(parsed);
      setImportResult({ row: result.row, createdForms: result.createdForms || [], warnings: result.warnings || [] });
      setNote(`Imported “${result.row?.name || result.row?.id}”.`);
      await load(result.row?.id);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const startNew = () => {
    setEditing({ originalId: null, definition: emptyWorkflow(), wards: [] });
    setNote("");
    setError("");
    setImportResult(null);
  };

  return <div className="app-theme-scope mx-auto max-w-[1500px] space-y-4 p-4 pb-24 text-[var(--app-text)]">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="text-xs font-extrabold uppercase tracking-[0.16em] text-[var(--app-accent)]">Flora iCIS Canopy · case workflows</div>
        <h1 className="mt-1 text-2xl font-semibold">Workflow Studio</h1>
        <p className="mt-1 text-sm text-[var(--app-muted)]">Choose which record sections and Form Studio forms a case uses, the order of its case packet, and which wards offer it.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="inline-flex overflow-hidden rounded-xl border border-[var(--app-border)]" role="tablist" aria-label="Workflow Studio">
          {([["workflows", "Workflows"], ["templates", "Itemize templates"], ["scores", "Scores"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={mode === key} onClick={() => { setMode(key); if (key === "workflows") void load(editing?.originalId || undefined); }}
              className={`px-3 py-2 text-sm font-semibold ${mode === key ? "bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "bg-[var(--app-control-bg)]"}`}>{label}</button>
          ))}
        </div>
        {mode === "workflows" ? <button type="button" className={secondary} disabled={loading} onClick={() => void load(editing?.originalId || undefined)}>{loading ? "Refreshing…" : "Refresh"}</button> : null}
        {isAdmin && mode === "workflows" ? <>
          <button type="button" className={secondary} disabled={busy} onClick={() => fileInput.current?.click()}>Import file</button>
          <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={event => void onImportFile(event.target.files?.[0])} />
          <button type="button" className={primary} disabled={busy} onClick={startNew}>+ New workflow</button>
        </> : null}
      </div>
    </header>

    {error ? <div className="whitespace-pre-line rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm text-rose-500">{error}</div> : null}
    {note ? <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-300">{note}</div> : null}
    {importResult && (importResult.createdForms.length || importResult.warnings.length) ? <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-3 text-sm">
      {importResult.createdForms.length ? <div>Created in Form Studio (as drafts — publish them there): <b>{importResult.createdForms.join(", ")}</b></div> : null}
      {importResult.warnings.length ? <ul className="mt-1 list-disc pl-5 text-amber-600 dark:text-amber-300">{importResult.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    </div> : null}

    {mode === "templates" ? <BillingTemplateStudio isAdmin={isAdmin} /> : mode === "scores" ? <ScoreStudio isAdmin={isAdmin} /> : <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section className={`${card} h-fit space-y-2`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">Workflows <span className="text-[var(--app-muted)]">{visibleRows.length}</span></h2>
          <label className="flex items-center gap-1 text-xs text-[var(--app-muted)]"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} className="accent-[var(--app-accent)]" />Archived</label>
        </div>
        {wardsWithoutDefault.length ? <div className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-2 py-1.5 text-[11px]">
          <b>No default workflow:</b> {wardsWithoutDefault.map(key => wardName.get(key) || key).join(", ")}. Cases started there get no workflow
          unless one is chosen at the start (or attached later on the Leaf's Forms page). Mark one workflow of each ward as Default.
        </div> : null}
        {!loading && !visibleRows.length ? <p className="text-sm text-[var(--app-muted)]">No workflows yet.{isAdmin ? " Create one or import a .workflow.json file." : ""}</p> : null}
        {visibleRows.map(row => <button key={row.id} type="button" onClick={() => { setEditing(editingFrom(row)); setNote(""); setError(""); setImportResult(null); }}
          className={`w-full rounded-xl border p-3 text-left transition ${editing?.originalId === row.id ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10" : "border-[var(--app-border)] bg-[var(--app-control-bg)] hover:border-[var(--app-accent)]/60"}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><div className="truncate text-sm font-bold">{row.name || row.id}</div><div className="truncate font-mono text-[11px] text-[var(--app-muted)]">{row.id}</div></div>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusBadge[row.status] || statusBadge.archived}`}>{row.status}</span>
          </div>
          <div className="mt-1 text-[11px] text-[var(--app-muted)]">v{row.version} · {row.wards?.length ? row.wards.map(ward => `${ward.unitName || wardName.get(ward.unitKey) || ward.unitKey}${ward.isDefault ? " ★" : ""}`).join(", ") : "no wards"}</div>
        </button>)}
      </section>

      {!editing || !def ? <section className={`${card} text-sm text-[var(--app-muted)]`}>Select a workflow{isAdmin ? " or create a new one" : ""}.</section> : <section className="space-y-4">
        <div className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">{editing.originalId ? def.name || editing.originalId : "New workflow"}
              {selectedRow ? <span className={`ml-2 rounded-full border px-2 py-0.5 align-middle text-[10px] font-bold uppercase ${statusBadge[selectedRow.status]}`}>{selectedRow.status} · v{selectedRow.version}</span> : null}
            </h2>
            <div className="flex flex-wrap gap-2">
              {isAdmin && !readOnly ? <>
                <button type="button" className={secondary} disabled={busy} onClick={() => void onSave()}>Save draft</button>
                <button type="button" className={primary} disabled={busy} onClick={() => void onPublish()}>Publish</button>
              </> : null}
              {isAdmin && editing.originalId && selectedRow?.status !== "archived" ? <button type="button" className={danger} disabled={busy} onClick={onArchive}>Archive</button> : null}
              {editing.originalId ? <button type="button" className={secondary} disabled={busy} onClick={() => void onExport()}>Export</button> : null}
            </div>
          </div>
          {selectedRow?.updatedAt ? <div className="text-xs text-[var(--app-muted)]">Updated {new Date(selectedRow.updatedAt).toLocaleString()}{selectedRow.updatedBy ? ` by ${selectedRow.updatedBy}` : ""}</div> : null}
          {localErrors.length && !readOnly ? <ul className="list-disc pl-5 text-xs text-amber-600 dark:text-amber-300">{localErrors.map(item => <li key={item}>{item}</li>)}</ul> : null}
          <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="text-xs font-bold text-[var(--app-muted)]">Id
              <input className={`${inputClass} mt-1 font-mono`} value={def.id} disabled={readOnly || Boolean(editing.originalId)} placeholder="or_general"
                onChange={event => patchDef(current => ({ ...current, id: event.target.value.trim().toLowerCase() }))} />
            </label>
            <label className="text-xs font-bold text-[var(--app-muted)]">Name
              <input className={`${inputClass} mt-1`} value={def.name} disabled={readOnly} onChange={event => patchDef(current => ({ ...current, name: event.target.value }))} />
            </label>
          </div>
          <label className="block text-xs font-bold text-[var(--app-muted)]">Description
            <textarea className={`${inputClass} mt-1 resize-y`} rows={2} value={def.description || ""} disabled={readOnly} onChange={event => patchDef(current => ({ ...current, description: event.target.value }))} />
          </label>
        </div>

        <div className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="font-bold">Anesthesia record</h3><p className="text-xs text-[var(--app-muted)]">Built-in record sections switched on when the case starts, and which optional ones the clinician may still switch.</p></div>
            <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" disabled={readOnly} checked={def.anesthesia_record.enabled} className="h-4 w-4 accent-[var(--app-accent)]"
              onChange={event => patchDef(current => ({ ...current, anesthesia_record: { ...current.anesthesia_record, enabled: event.target.checked } }))} />Use the built-in record</label>
          </div>
          {def.anesthesia_record.enabled ? <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[10px] uppercase tracking-[0.1em] text-[var(--app-muted)]"><th className="py-1 pr-3">Section</th><th className="px-3 py-1">On at start</th><th className="px-3 py-1">Clinician may toggle</th></tr></thead>
              <tbody>{sectionList.map(section => <tr key={section.id} className="border-t border-[var(--app-border)]">
                <td className="py-1.5 pr-3">{section.label} <span className="font-mono text-[10px] text-[var(--app-muted)]">{section.id}</span>{section.core ? <span className="ml-2 rounded-full bg-[var(--app-accent)]/12 px-2 py-0.5 text-[10px] font-bold text-[var(--app-accent)]">core</span> : null}</td>
                <td className="px-3 py-1.5"><input type="checkbox" className="h-4 w-4 accent-[var(--app-accent)]" disabled={readOnly || section.core}
                  checked={section.core || def.anesthesia_record.sections.includes(section.id)} onChange={() => toggleSection(section.id, "sections")} /></td>
                <td className="px-3 py-1.5">{section.core ? <span className="text-xs text-[var(--app-muted)]">always on</span> : <input type="checkbox" className="h-4 w-4 accent-[var(--app-accent)]" disabled={readOnly}
                  checked={def.anesthesia_record.optional_sections.includes(section.id)} onChange={() => toggleSection(section.id, "optional_sections")} />}</td>
              </tr>)}</tbody>
            </table>
          </div> : <p className="text-sm text-[var(--app-muted)]">Forms only — no built-in anesthesia record.</p>}
        </div>

        <div className={`${card} space-y-3`}>
          <div><h3 className="font-bold">Forms</h3><p className="text-xs text-[var(--app-muted)]">Published Form Studio forms, pinned to a version. Each becomes an extra tab on the case in Flora Leaf, placed after the record tab chosen here (with the phase it belongs to and a note for whoever fills it in).</p></div>
          {def.forms.length ? <div className="space-y-2">{def.forms.map((form, index) => {
            const option = formOption.get(form.form_id);
            const versions = Array.from(new Set([...(option?.versions || []), form.version])).sort((a, b) => a - b);
            return <div key={form.form_id} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2">
              <div className="min-w-48 flex-1"><div className="text-sm font-bold">{form.title || option?.title || form.form_id}</div><div className="font-mono text-[11px] text-[var(--app-muted)]">{form.form_id}{option ? "" : " · not found in Form Studio"}</div></div>
              <label className="text-xs text-[var(--app-muted)]">Version <select className={`${inputClass} !w-auto !py-1`} disabled={readOnly} value={form.version} onChange={event => patchForm(index, { version: Number(event.target.value) })}>
                {versions.map(version => <option key={version} value={version}>v{version}{option?.published_version === version ? " (published)" : ""}</option>)}
              </select></label>
              <label className="text-xs text-[var(--app-muted)]">Phase <select className={`${inputClass} !w-auto !py-1`} disabled={readOnly} value={form.phase || "any"} onChange={event => patchForm(index, { phase: event.target.value as WorkflowPhase })}>
                {PHASES.map(phase => <option key={phase} value={phase}>{phase}</option>)}
              </select></label>
              <label className="text-xs text-[var(--app-muted)]">Used as <select className={`${inputClass} !w-auto !py-1`} disabled={readOnly} value={form.display ?? "tab"}
                onChange={event => patchForm(index, { display: event.target.value as WorkflowFormRef["display"],
                  ...(event.target.value === "report" ? { repeatable: undefined, max_instances: undefined } : {}) })}>
                <option value="tab">data-entry tab + print</option>
                <option value="report">print from Reports only</option>
              </select></label>
              <label className="text-xs text-[var(--app-muted)]">Leaf tab after <select className={`${inputClass} !w-auto !py-1`} disabled={readOnly} value={form.after_section ?? ""} onChange={event => patchForm(index, { after_section: event.target.value || null })}>
                <option value="">the last record tab</option>
                {options.sections.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}
              </select></label>
              <label className="flex items-center gap-1 text-xs font-semibold"><input type="checkbox" disabled={readOnly} checked={Boolean(form.required)} onChange={event => patchForm(index, { required: event.target.checked })} className="accent-[var(--app-accent)]" />Required</label>
              {(form.display ?? "tab") === "tab" ? <label className="flex items-center gap-1 text-xs font-semibold" title="Several copies per case on Leaf (e.g. one per transfusion), each its own Form Studio record">
                <input type="checkbox" disabled={readOnly} checked={Boolean(form.repeatable)} className="accent-[var(--app-accent)]"
                  onChange={event => patchForm(index, event.target.checked ? { repeatable: true } : { repeatable: undefined, max_instances: undefined })} />Repeatable</label> : null}
              {form.repeatable ? <label className="text-xs text-[var(--app-muted)]">at most <input type="number" min={2} max={99} step={1} className={`${inputClass} !w-16 !py-1`} disabled={readOnly}
                value={form.max_instances ?? ""} placeholder="99" aria-label={`Most copies of ${form.title || form.form_id}`}
                onChange={event => patchForm(index, { max_instances: event.target.value ? Math.max(2, Math.min(99, Math.round(Number(event.target.value)))) : undefined })} /> copies</label> : null}
              <input className={`${inputClass} !py-1 basis-full text-xs`} disabled={readOnly} maxLength={300} value={form.hint ?? ""} placeholder="Note shown on Leaf, e.g. Filled in by the PACU nurse before discharge"
                aria-label={`Note for ${form.title || form.form_id} on Leaf`} onChange={event => patchForm(index, { hint: event.target.value })} />
              {option?.placement && (option.placement.phase !== (form.phase || "any") || (option.placement.after_section ?? null) !== (form.after_section ?? null))
                ? <div className="basis-full text-[11px] text-[var(--app-muted)]">Form Studio suggests {option.placement.phase}
                  {option.placement.after_section ? `, after ${options.sections.find(section => section.id === option.placement?.after_section)?.label ?? option.placement.after_section}` : ", at the end"}
                  {!readOnly ? <button type="button" className={`${tiny} ml-2`} onClick={() => patchForm(index, { phase: option.placement!.phase, after_section: option.placement!.after_section })}>Use it</button> : null}
                </div> : null}
              {!readOnly ? <div className="flex gap-1">
                <button type="button" className={tiny} disabled={index === 0} onClick={() => patchDef(current => ({ ...current, forms: move(current.forms, index, -1) }))} aria-label="Move up">↑</button>
                <button type="button" className={tiny} disabled={index === def.forms.length - 1} onClick={() => patchDef(current => ({ ...current, forms: move(current.forms, index, 1) }))} aria-label="Move down">↓</button>
                <button type="button" className={tiny} onClick={() => removeForm(form.form_id)} aria-label="Remove">✕</button>
              </div> : null}
            </div>;
          })}</div> : <p className="text-sm text-[var(--app-muted)]">No forms.</p>}
          {!readOnly ? <div className="flex flex-wrap gap-2">
            <select className={`${inputClass} max-w-md`} value={addFormId} onChange={event => setAddFormId(event.target.value)}>
              <option value="">Add a published form…</option>
              {options.forms.filter(form => form.published_version != null && !def.forms.some(item => item.form_id === form.form_id)).map(form =>
                <option key={form.form_id} value={form.form_id}>{form.title} ({form.form_id} v{form.published_version})</option>)}
            </select>
            <button type="button" className={secondary} disabled={!addFormId} onClick={addForm}>Add</button>
          </div> : null}
        </div>

        <div className={`${card} space-y-3`}>
          <div><h3 className="font-bold">Case packet</h3><p className="text-xs text-[var(--app-muted)]">Order of the combined PDF printed from Leaf → Reports → Case packet.</p></div>
          {def.packet.length ? <ol className="space-y-2">{def.packet.map((entry, index) => <li key={`${entry.kind}-${entry.kind === "form" ? entry.form_id : "report"}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-control-bg)] p-2">
            <span className="w-6 text-center text-xs font-bold text-[var(--app-muted)]">{index + 1}</span>
            <span className="min-w-48 flex-1 text-sm font-semibold">{packetLabel(entry)}{entry.kind === "form" ? <span className="ml-2 font-mono text-[11px] text-[var(--app-muted)]">{entry.form_id}</span> : null}</span>
            {entry.kind === "anesthesia_report" ? <select className={`${inputClass} !w-auto !py-1`} disabled={readOnly} value={entry.mode || "standard"}
              onChange={event => patchDef(current => ({ ...current, packet: current.packet.map((item, i) => i === index ? { kind: "anesthesia_report", mode: event.target.value as WorkflowReportMode } : item) }))}>
              {MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
            </select> : null}
            {!readOnly ? <div className="flex gap-1">
              <button type="button" className={tiny} disabled={index === 0} onClick={() => patchDef(current => ({ ...current, packet: move(current.packet, index, -1) }))} aria-label="Move up">↑</button>
              <button type="button" className={tiny} disabled={index === def.packet.length - 1} onClick={() => patchDef(current => ({ ...current, packet: move(current.packet, index, 1) }))} aria-label="Move down">↓</button>
              <button type="button" className={tiny} onClick={() => patchDef(current => ({ ...current, packet: current.packet.filter((_, i) => i !== index) }))} aria-label="Remove">✕</button>
            </div> : null}
          </li>)}</ol> : <p className="text-sm text-[var(--app-muted)]">The packet is empty.</p>}
          {!readOnly ? <div className="flex flex-wrap gap-2">
            {!hasReport ? <button type="button" className={secondary} onClick={() => patchDef(current => ({ ...current, packet: [{ kind: "anesthesia_report", mode: "standard" }, ...current.packet] }))}>+ Anesthesia report</button> : null}
            {formsNotInPacket.map(form => <button key={form.form_id} type="button" className={secondary} onClick={() => patchDef(current => ({ ...current, packet: [...current.packet, { kind: "form", form_id: form.form_id }] }))}>+ {form.title || form.form_id}</button>)}
          </div> : null}
        </div>

        <div className={`${card} space-y-3`}>
          <div><h3 className="font-bold">Wards</h3><p className="text-xs text-[var(--app-muted)]">Leafs in these wards offer the workflow once it is published. The default is preselected when a case starts (one default per ward).</p></div>
          {options.wards.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{options.wards.map(ward => {
            const pick = editing.wards.find(item => item.unitKey === ward.key);
            return <div key={ward.key} className={`flex items-center justify-between gap-2 rounded-xl border p-2 ${pick ? "border-[var(--app-accent)]/60 bg-[var(--app-accent)]/5" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>
              <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" disabled={readOnly} checked={Boolean(pick)} onChange={() => toggleWard(ward.key)} className="h-4 w-4 accent-[var(--app-accent)]" />
                <span className="min-w-0"><span className="block truncate font-semibold">{ward.name}</span><span className="block truncate text-[11px] text-[var(--app-muted)]">{[ward.buildingName, ward.isDemo ? "demo" : ""].filter(Boolean).join(" · ") || ward.key}</span></span></label>
              {pick ? <label className="flex shrink-0 items-center gap-1 text-xs font-semibold"><input type="radio" disabled={readOnly} checked={pick.isDefault} onClick={() => toggleWardDefault(ward.key)} onChange={() => undefined} className="accent-[var(--app-accent)]" />Default</label> : null}
            </div>;
          })}</div> : <p className="text-sm text-[var(--app-muted)]">No wards available.</p>}
          {editing.wards.some(pick => !options.wards.some(ward => ward.key === pick.unitKey)) ? <p className="text-xs text-[var(--app-muted)]">Also assigned: {editing.wards.filter(pick => !options.wards.some(ward => ward.key === pick.unitKey)).map(pick => pick.unitKey).join(", ")}</p> : null}
        </div>

        <div className={`${card} space-y-3`}>
          <div><h3 className="font-bold">Billing</h3><p className="text-xs text-[var(--app-muted)]">Itemize template shown on the Leaf Billing screen (groups, order and preselected items). One template can serve many workflows; manage them under Itemize templates.</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={`${inputClass} max-w-md`} disabled={readOnly} value={def.billing?.template_id || ""}
              onChange={event => patchDef(current => ({ ...current, billing: { template_id: event.target.value || null } }))} aria-label="Itemize template">
              <option value="">No template (the whole billing master)</option>
              {templates.filter(t => t.status !== "archived" || t.id === def.billing?.template_id).map(t =>
                <option key={t.id} value={t.id}>{t.name || t.id} · {t.itemCount} items{t.status !== "published" ? ` (${t.status})` : ""}</option>)}
            </select>
            <button type="button" className={secondary} onClick={() => setMode("templates")}>Manage templates</button>
          </div>
          {def.billing?.template_id && templates.find(t => t.id === def.billing?.template_id)?.status !== "published"
            ? <p className="text-xs text-amber-600 dark:text-amber-300">Publish this template before publishing the workflow.</p> : null}
        </div>

        <div className={`${card} space-y-3`}>
          <div><h3 className="font-bold">Scores</h3><p className="text-xs text-[var(--app-muted)]">Clinical scores the Leaf computes for cases of this workflow: automatic ones every interval from the chart (shown under the vital signs), manual ones when a clinician runs them. Manage them under Scores.</p></div>
          {scores.filter(score => score.status !== "archived" || def.scores?.includes(score.id)).length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {scores.filter(score => score.status !== "archived" || def.scores?.includes(score.id)).map(score => {
              const picked = Boolean(def.scores?.includes(score.id));
              return <label key={score.id} className={`flex items-start gap-2 rounded-xl border p-2 text-sm ${picked ? "border-[var(--app-accent)]/60 bg-[var(--app-accent)]/5" : "border-[var(--app-border)] bg-[var(--app-control-bg)]"}`}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--app-accent)]" disabled={readOnly} checked={picked}
                  onChange={() => patchDef(current => ({ ...current, scores: picked ? (current.scores || []).filter(id => id !== score.id) : [...(current.scores || []), score.id] }))} />
                <span className="min-w-0"><span className="block truncate font-semibold">{score.name || score.id}</span>
                  <span className="block truncate text-[11px] text-[var(--app-muted)]">{score.mode === "auto" ? `every ${score.definition.interval_min} min` : "run by clinician"}{score.status !== "published" ? ` · ${score.status}` : ""}</span></span>
              </label>;
            })}
          </div> : <p className="text-sm text-[var(--app-muted)]">No scores yet.</p>}
          <button type="button" className={secondary} onClick={() => setMode("scores")}>Manage scores</button>
          {(def.scores || []).some(id => scores.find(score => score.id === id)?.status !== "published")
            ? <p className="text-xs text-amber-600 dark:text-amber-300">Publish every selected score before publishing the workflow.</p> : null}
        </div>

        <details className={card}>
          <summary className="cursor-pointer text-sm font-bold">Workflow JSON</summary>
          <pre className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--app-control-bg)] p-3 font-mono text-xs">{JSON.stringify(def, null, 2)}</pre>
        </details>
      </section>}
    </div>}
  </div>;
}
