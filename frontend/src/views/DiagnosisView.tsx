import React, { useEffect, useState, useCallback } from "react";
import type { CaseStatus } from "../api/caseApi";
import {
  createCaseDiagnosis,
  createCaseProcedure,
  deleteCaseDiagnosis,
  deleteCaseProcedure,
  getCaseDiagnosis,
  getCaseProcedures,
  searchIcd9Procedures,
  searchIcd10,
  updateCaseDiagnosis,
  updateCaseProcedure,
  type CaseDiagnosisRow,
  type CaseProcedureRow,
  type Icd9ProcedureMatch,
  type Icd10Match,
} from "../api/caseClinicalApi";
import ConfirmDialog from "../components/common/ConfirmDialog";
import ClinicalDateTimeInput from "../components/ClinicalDateTimeInput";
import { useWorkstationSettings } from "../hooks/useWorkstationSettings";
import {
  formatConfiguredDateTime,
  timestampToWallClockInput,
  wallClockInputToTimestamp,
} from "../utils/dateTime";

type Props = {
  caseStatus: CaseStatus;
};

// --- Icons ---

function IconPlus() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
  );
}

function IconTrash() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
  );
}

function IconEdit() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>
  );
}

function IconChevronUp() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
  );
}

function IconChevronDown() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
  );
}

function IconSave() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
  );
}

function IconX() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
  );
}

// --- Types & Styles ---

type GenericEntry = {
  id: number;
  display_text: string; // Unified name for diagnosis_text / procedure_text
  icd_text?: string | null;
  icd_code?: string | null;
  icd_version?: string | null;
  seq: number;
  event_ts: number;
  entry_context: string;
};

const card = "rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 p-4 space-y-4 shadow-sm";

// --- Sub-components ---

function SuggestionList<M>({
  rows,
  onPick,
  renderRow,
  selectedIndex,
}: {
  rows: M[];
  onPick: (row: M) => void;
  renderRow: (row: M) => React.ReactNode;
  selectedIndex: number;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg max-h-60 overflow-y-auto py-1">
      {rows.map((row, idx) => (
        <button
          key={idx}
          type="button"
          onClick={() => onPick(row)}
          className={`w-full text-left px-3 py-2 transition-colors border-b border-gray-50 dark:border-gray-800 last:border-b-0 ${
            idx === selectedIndex
              ? "bg-blue-100 dark:bg-blue-800/60 ring-1 ring-inset ring-blue-500"
              : "hover:bg-blue-50 dark:hover:bg-blue-900/30"
          }`}
        >
          {renderRow(row)}
        </button>
      ))}
    </div>
  );
}

// --- Main Generic Section Component ---

interface ClinicalSectionProps<M> {
  title: string;
  entries: GenericEntry[];
  loading: boolean;
  onAdd: (data: Omit<GenericEntry, "id" | "seq">) => Promise<void>;
  onRemove: (id: number) => Promise<void>;
  onUpdate: (id: number, data: Partial<Omit<GenericEntry, "id">>) => Promise<void>;
  onSearch: (query: string) => Promise<M[]>;
  pickIcdText: (match: M) => string;
  pickIcdCode: (match: M) => string;
  renderMatch: (match: M) => React.ReactNode;
  placeholders: {
    entry: string;
    icdText: string;
    icdCode: string;
  };
  contextOptions: Array<{ value: string; label: string }>;
  defaultContext: string;
}

function ClinicalSection<M>({
  title,
  entries,
  loading,
  onAdd,
  onRemove,
  onUpdate,
  onSearch,
  pickIcdText,
  pickIcdCode,
  renderMatch,
  placeholders,
  contextOptions,
  defaultContext,
}: ClinicalSectionProps<M>) {
  const workstation = useWorkstationSettings();
  const [entryText, setEntryText] = useState("");
  const [icdText, setIcdText] = useState("");
  const [icdCode, setIcdCode] = useState("");
  const [matches, setMatches] = useState<M[]>([]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Partial<GenericEntry>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [pendingRemoveId, setPendingRemoveId] = useState<number | null>(null);
  const [entryContext, setEntryContext] = useState(defaultContext);
  const [entryTimestamp, setEntryTimestamp] = useState(() => Date.now());
  const [formError, setFormError] = useState("");
  const entryInputRef = React.useRef<HTMLInputElement>(null);

  // Search logic. onSearch is usually an inline arrow (new on every render); keep the
  // latest in a ref so frequent re-renders don't keep cancelling the debounce timer.
  const onSearchRef = React.useRef(onSearch);
  onSearchRef.current = onSearch;
  useEffect(() => {
    const q = searchQuery;
    if (q.trim().length < 2) {
      setMatches([]);
      setSelectedIndex(-1);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const results = await onSearchRef.current(q);
        setMatches(results);
        setSelectedIndex(results.length > 0 ? 0 : -1);
        setFormError("");
      } catch (error) {
        setMatches([]);
        setSelectedIndex(-1);
        setFormError(error instanceof Error ? error.message : "Clinical code search failed");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleAdd = async () => {
    if (!entryText.trim() || saving) return;
    setSaving(true);
    setFormError("");
    try {
      await onAdd({
        display_text: entryText.trim(),
        icd_text: icdText.trim() || undefined,
        icd_code: icdCode.trim() || undefined,
        event_ts: entryTimestamp,
        entry_context: entryContext,
      });
      setEntryText("");
      setIcdText("");
      setIcdCode("");
      setMatches([]);
      setSelectedIndex(-1);
      setSearchQuery("");
      setEntryTimestamp(Date.now());
      entryInputRef.current?.focus();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : `Unable to add ${title.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePick = (match: M) => {
    const code = pickIcdCode(match);
    const text = pickIcdText(match);
    setIcdCode(code);
    setIcdText(text);
    // Start with the selected catalog wording, but keep this as a normal
    // editable field so clinicians can tailor the patient-specific text.
    setEntryText(text);
    setMatches([]);
    setSelectedIndex(-1);
    setSearchQuery("");
    // Return focus to the primary description field
    entryInputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + matches.length) % matches.length);
      } else if (e.key === "Enter" && selectedIndex >= 0) {
        e.preventDefault();
        handlePick(matches[selectedIndex]);
      } else if (e.key === "Escape") {
        setMatches([]);
        setSelectedIndex(-1);
      }
    }
  };

  const startEdit = (entry: GenericEntry) => {
    setFormError("");
    setEditingId(entry.id);
    setEditData({
      display_text: entry.display_text,
      icd_text: entry.icd_text,
      icd_code: entry.icd_code,
      event_ts: entry.event_ts,
      entry_context: entry.entry_context,
    });
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    if (!editData.display_text?.trim()) {
      setFormError("Description is required.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await onUpdate(editingId, editData);
      setEditingId(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : `Unable to update ${title.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  const moveUp = async (index: number) => {
    if (index <= 0) return;
    const current = entries[index];
    const prev = entries[index - 1];
    setSaving(true);
    setFormError("");
    try {
      await Promise.all([
        onUpdate(current.id, { seq: prev.seq }),
        onUpdate(prev.id, { seq: current.seq }),
      ]);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to reorder entries");
    } finally {
      setSaving(false);
    }
  };

  const moveDown = async (index: number) => {
    if (index >= entries.length - 1) return;
    const current = entries[index];
    const next = entries[index + 1];
    setSaving(true);
    setFormError("");
    try {
      await Promise.all([
        onUpdate(current.id, { seq: next.seq }),
        onUpdate(next.id, { seq: current.seq }),
      ]);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to reorder entries");
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (pendingRemoveId === null) return;
    setSaving(true);
    setFormError("");
    try {
      await onRemove(pendingRemoveId);
      setPendingRemoveId(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : `Unable to remove ${title.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={card}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {title}
        </h2>
      </div>

      {/* Add Entry Form */}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleAdd();
        }}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">Record as</span>
          {contextOptions.map(option => (
            <button key={option.value} type="button" onClick={() => setEntryContext(option.value)} className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${entryContext === option.value ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-[var(--app-accent-contrast)]" : "border-[var(--app-border)] text-[var(--app-muted)]"}`}>
              {option.label}
            </button>
          ))}
          <label className="ml-auto min-w-[300px] text-[10px] font-bold uppercase tracking-wider text-[var(--app-muted)]">
            <span className="mb-1 block">Clinical time · {workstation.timezone}</span>
            <ClinicalDateTimeInput
              value={timestampToWallClockInput(entryTimestamp, workstation.timezone)}
              onChange={value => {
                const timestamp = wallClockInputToTimestamp(value, workstation.timezone);
                if (timestamp !== null) setEntryTimestamp(timestamp);
                setFormError("");
              }}
              dateFormat={workstation.dateFormat}
              timeFormat={workstation.timeFormat}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 relative">
          <div className="lg:col-span-5">
            <input
              ref={entryInputRef}
              value={entryText}
              onChange={(e) => {
                setEntryText(e.target.value);
                setSearchQuery(e.target.value);
                setFormError("");
              }}
              onKeyDown={handleKeyDown}
              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              placeholder={placeholders.entry}
            />
          </div>
          <div className="lg:col-span-4">
            <input
              value={icdText}
              onChange={(e) => {
                setIcdText(e.target.value);
                setSearchQuery(e.target.value);
                setFormError("");
              }}
              onKeyDown={handleKeyDown}
              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              placeholder={placeholders.icdText}
            />
          </div>
          <div className="lg:col-span-3 flex gap-2">
            <input
              value={icdCode}
              onChange={(e) => {
                setIcdCode(e.target.value);
                setSearchQuery(e.target.value);
                setFormError("");
              }}
              onKeyDown={handleKeyDown}
              className="flex-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              placeholder={placeholders.icdCode}
            />
            <button
              type="submit"
              disabled={!entryText.trim() || saving}
              className="shrink-0 flex items-center justify-center w-10 h-9 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              title="Add Entry"
            >
              <IconPlus />
            </button>
          </div>
          <div className="absolute top-full left-0 w-full z-20">
            <SuggestionList
              rows={matches}
              onPick={handlePick}
              renderRow={renderMatch}
              selectedIndex={selectedIndex}
            />
          </div>
        </div>
        {formError && (
          <div role="alert" className="rounded-md border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-500 dark:text-red-300">
            {formError}
          </div>
        )}
      </form>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 dark:bg-gray-900/80 text-gray-600 dark:text-gray-400 font-medium">
            <tr>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-left">ICD Reference</th>
              <th className="px-3 py-2 text-left w-24">ICD Code</th>
              <th className="px-3 py-2 text-left w-32">Context</th>
              <th className="px-3 py-2 text-left w-40">Clinical time</th>
              <th className="px-3 py-2 text-right w-36">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                  Loading clinical data...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                  No records added yet.
                </td>
              </tr>
            ) : (
              entries.map((row, idx) => (
                <tr key={row.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-900/30 transition-colors">
                  <td className="px-3 py-2">
                    {editingId === row.id ? (
                      <input
                        className="w-full px-2 py-1 rounded border border-blue-300 dark:border-blue-700 bg-white dark:bg-gray-950"
                        value={editData.display_text}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onChange={(e) => setEditData({ ...editData, display_text: e.target.value })}
                        autoFocus
                      />
                    ) : (
                      <span className="font-medium text-gray-800 dark:text-gray-200">{row.display_text}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {editingId === row.id ? (
                      <input
                        className="w-full px-2 py-1 rounded border border-blue-300 dark:border-blue-700 bg-white dark:bg-gray-950 text-gray-500"
                        value={editData.icd_text || ""}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onChange={(e) => setEditData({ ...editData, icd_text: e.target.value })}
                      />
                    ) : (
                      <span className="text-gray-500">{row.icd_text || "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {editingId === row.id ? (
                      <input
                        className="w-full px-2 py-1 rounded border border-blue-300 dark:border-blue-700 bg-white dark:bg-gray-950 font-mono"
                        value={editData.icd_code || ""}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onChange={(e) => setEditData({ ...editData, icd_code: e.target.value })}
                      />
                    ) : (
                      <span className="font-mono text-blue-600 dark:text-blue-400">{row.icd_code || "—"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 capitalize text-[var(--app-muted)]">
                    {editingId === row.id ? (
                      <select
                        value={editData.entry_context || defaultContext}
                        onChange={event => setEditData({ ...editData, entry_context: event.target.value })}
                        className="w-full rounded border border-blue-300 bg-[var(--app-control-bg)] px-2 py-1 text-[var(--app-text)] dark:border-blue-700"
                      >
                        {contextOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    ) : row.entry_context.replaceAll("_", " ")}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums text-[var(--app-muted)]">
                    {editingId === row.id ? (
                      <ClinicalDateTimeInput
                        value={timestampToWallClockInput(editData.event_ts ?? row.event_ts, workstation.timezone)}
                        onChange={value => {
                          const timestamp = wallClockInputToTimestamp(value, workstation.timezone);
                          if (timestamp !== null) setEditData({ ...editData, event_ts: timestamp });
                        }}
                        dateFormat={workstation.dateFormat}
                        timeFormat={workstation.timeFormat}
                      />
                    ) : formatConfiguredDateTime(row.event_ts, workstation)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {editingId === row.id ? (
                        <>
                          <button
                            onClick={() => void saveEdit()}
                            className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded"
                            title="Save"
                          >
                            <IconSave />
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="p-1.5 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded"
                            title="Cancel"
                          >
                            <IconX />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => void moveUp(idx)}
                            disabled={idx === 0}
                            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                            title="Move Up"
                          >
                            <IconChevronUp />
                          </button>
                          <button
                            onClick={() => void moveDown(idx)}
                            disabled={idx === entries.length - 1}
                            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                            title="Move Down"
                          >
                            <IconChevronDown />
                          </button>
                          <button
                            onClick={() => startEdit(row)}
                            className="p-1.5 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                            title="Edit"
                          >
                            <IconEdit />
                          </button>
                          <button
                            onClick={() => setPendingRemoveId(row.id)}
                            className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                            title="Delete"
                          >
                            <IconTrash />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={pendingRemoveId !== null}
        title={`Remove ${title.toLowerCase()} entry?`}
        message="This entry will be removed from the active clinical record."
        confirmLabel="Remove"
        busy={saving}
        onCancel={() => setPendingRemoveId(null)}
        onConfirm={confirmRemove}
      />
    </section>
  );
}

// --- Main View ---

export default function DiagnosisView({ caseStatus }: Props) {
  const caseId = caseStatus.status === "IDLE" ? null : caseStatus.case_id;
  const [diagnosisRows, setDiagnosisRows] = useState<CaseDiagnosisRow[]>([]);
  const [operationRows, setOperationRows] = useState<CaseProcedureRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!caseId) return;
    setLoading(true);
    setError("");
    try {
      const [diag, ops] = await Promise.all([
        getCaseDiagnosis(caseId),
        getCaseProcedures(caseId),
      ]);
      setDiagnosisRows(
        [...diag].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || (Number(a.event_ts) || 0) - (Number(b.event_ts) || 0)),
      );
      setOperationRows(
        [...ops].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || (Number(a.event_ts) || 0) - (Number(b.event_ts) || 0)),
      );
    } catch (err) {
      setDiagnosisRows([]);
      setOperationRows([]);
      setError(err instanceof Error ? err.message : "Failed to load clinical data");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const notifyChange = useCallback(() => {
    if (!caseId) return;
    window.dispatchEvent(
      new CustomEvent("flora:clinical-changed", { detail: { caseId } }),
    );
  }, [caseId]);

  // Map specialized rows to GenericEntry
  const genericDiagnosis = diagnosisRows.map(row => ({
    id: row.id,
    display_text: row.diagnosis_text,
    icd_text: row.icd_text,
    icd_code: row.icd_code,
    icd_version: row.icd_version,
    seq: row.seq,
    event_ts: row.event_ts,
    entry_context: row.entry_context,
  }));

  const genericOperations = operationRows.map(row => ({
    id: row.id,
    display_text: row.procedure_text,
    icd_text: row.icd_text,
    icd_code: row.icd_code,
    icd_version: row.icd_version,
    seq: row.seq,
    event_ts: row.event_ts,
    entry_context: row.entry_context,
  }));

  // Diagnosis Handlers
  const handleAddDiagnosis = async (data: Omit<GenericEntry, "id" | "seq">) => {
    if (!caseId) return;
    await createCaseDiagnosis(caseId, {
      diagnosis_text: data.display_text,
      icd_text: data.icd_text || undefined,
      icd_code: data.icd_code || undefined,
      icd_version: data.icd_code ? "ICD-10" : undefined,
      seq: diagnosisRows.length + 1,
      event_ts: data.event_ts,
      entry_context: data.entry_context as CaseDiagnosisRow["entry_context"],
    });
    await refresh();
    notifyChange();
  };

  const handleUpdateDiagnosis = async (id: number, data: Partial<Omit<GenericEntry, "id">>) => {
    if (!caseId) return;
    await updateCaseDiagnosis(caseId, id, {
      diagnosis_text: data.display_text,
      icd_text: data.icd_text ?? undefined,
      icd_code: data.icd_code ?? undefined,
      seq: data.seq,
      event_ts: data.event_ts,
      entry_context: data.entry_context as CaseDiagnosisRow["entry_context"] | undefined,
    });
    await refresh();
    notifyChange();
  };

  const handleRemoveDiagnosis = async (id: number) => {
    if (!caseId) return;
    await deleteCaseDiagnosis(caseId, id);
    await refresh();
    notifyChange();
  };

  // Operation Handlers
  const handleAddOperation = async (data: Omit<GenericEntry, "id" | "seq">) => {
    if (!caseId) return;
    await createCaseProcedure(caseId, {
      procedure_text: data.display_text,
      icd_text: data.icd_text || undefined,
      icd_code: data.icd_code || undefined,
      icd_version: data.icd_code ? "ICD-9" : undefined,
      seq: operationRows.length + 1,
      event_ts: data.event_ts,
      entry_context: data.entry_context as CaseProcedureRow["entry_context"],
    });
    await refresh();
    notifyChange();
  };

  const handleUpdateOperation = async (id: number, data: Partial<Omit<GenericEntry, "id">>) => {
    if (!caseId) return;
    await updateCaseProcedure(caseId, id, {
      procedure_text: data.display_text,
      icd_text: data.icd_text ?? undefined,
      icd_code: data.icd_code ?? undefined,
      seq: data.seq,
      event_ts: data.event_ts,
      entry_context: data.entry_context as CaseProcedureRow["entry_context"] | undefined,
    });
    await refresh();
    notifyChange();
  };

  const handleRemoveOperation = async (id: number) => {
    if (!caseId) return;
    await deleteCaseProcedure(caseId, id);
    await refresh();
    notifyChange();
  };

  if (caseStatus.status === "IDLE") {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-gray-400 space-y-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
        <p>No active case selected</p>
      </div>
    );
  }

  return (
    <div className="p-4 pb-24 space-y-6 w-full">
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-2 rounded-md text-sm">
          {error}
        </div>
      )}

      <ClinicalSection<Icd10Match>
        title="Diagnosis"
        entries={genericDiagnosis}
        loading={loading}
        onAdd={handleAddDiagnosis}
        onRemove={handleRemoveDiagnosis}
        onUpdate={handleUpdateDiagnosis}
        onSearch={(q) => searchIcd10(q, 15)}
        pickIcdText={(m) => (m.name_en || m.name_th || "").trim()}
        pickIcdCode={(m) => m.icd10}
        renderMatch={(m) => (
          <div className="text-sm">
            <span className="font-mono font-bold text-blue-600 dark:text-blue-400 mr-2">{m.icd10}</span>
            <span className="text-gray-700 dark:text-gray-300">{(m.name_en || m.name_th || "")}</span>
            {m.name_th && m.name_en && (
              <div className="text-[11px] text-gray-500 mt-0.5">{m.name_th}</div>
            )}
          </div>
        )}
        placeholders={{
          entry: "Clinical Diagnosis (Anesthetist's Note)",
          icdText: "ICD-10 Description",
          icdCode: "ICD-10 Code"
        }}
        contextOptions={[
          { value: "preoperative", label: "Pre-op" },
          { value: "intraoperative", label: "Intra-op" },
          { value: "postoperative", label: "Post-op" },
        ]}
        defaultContext="intraoperative"
      />

      <ClinicalSection<Icd9ProcedureMatch>
        title="Operation / Procedure"
        entries={genericOperations}
        loading={loading}
        onAdd={handleAddOperation}
        onRemove={handleRemoveOperation}
        onUpdate={handleUpdateOperation}
        onSearch={(q) => searchIcd9Procedures(q, 15)}
        pickIcdText={(m) => (m.name_en || m.short_name_en || "").trim()}
        pickIcdCode={(m) => m.icd9cm}
        renderMatch={(m) => (
          <div className="text-sm">
            <span className="font-mono font-bold text-blue-600 dark:text-blue-400 mr-2">{m.icd9cm}</span>
            <span className="text-gray-700 dark:text-gray-300">{(m.name_en || m.short_name_en || "")}</span>
          </div>
        )}
        placeholders={{
          entry: "Operation Name (Planned or Actual)",
          icdText: "ICD-9 Procedure Description",
          icdCode: "ICD-9 Code"
        }}
        contextOptions={[
          { value: "planned", label: "Planned" },
          { value: "performed", label: "Performed" },
        ]}
        defaultContext="performed"
      />
    </div>
  );
}
