/**
 * The records list as a spreadsheet: every table field as a column, sort by a header click, a filter box per
 * column, double-click a cell to edit it in place (saved like the form: on this device first, then synced),
 * download as Excel, and import rows from Excel or CSV (preview with validation before anything is saved).
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { FormDevClient } from "../index";
import { FormDevError, type LeafLink, type FieldDefinition, type FormDefinition, type Issue, type JsonValue, type LocalRecord } from "../core/types";
import { describePath, fieldKey, issueText } from "../core/validate";
import { readCsv, readXlsx, writeXlsx } from "../core/xlsx";
import { fieldPermissions, recordAllows } from "../logic/permission";
import { cellValue } from "./gridPaste";
import { cellText, importRows, matchColumns, recordSheets, sheetFields, type ImportRow } from "./sheetIO";

type Props = {
  client: FormDevClient; definition: FormDefinition; schemaVersion: number; codes: string[]; isAdmin: boolean; language: string;
  /** Changes when records may have changed elsewhere (sync, a saved form). */
  refreshKey: number;
  /** Records that are Flora Leaf case forms: shown with the patient's HN and changed only by amendment (open the record). */
  leafLinks?: Record<string, LeafLink>;
  onOpen: (record: LocalRecord) => void; onNew: () => void; onChanged: () => void;
};
type Sort = { key: string; dir: 1 | -1 } | null;
type Editing = { recordId: string; key: string; text: string } | null;
type Preview = { file: string; headers: string[]; mapping: Array<string | null>; rows: ImportRow[]; status: "draft" | "submitted"; running: boolean; done: string };

const PAGE = 200;
const control = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-2 py-1 text-xs text-[var(--app-text)]";
const button = "rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text)] disabled:opacity-50";
const primary = "rounded-lg bg-[var(--app-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--app-accent-contrast)] disabled:opacity-50";
const INLINE = new Set(["text", "number", "decimal", "integer", "date", "datetime", "time", "select", "radio", "checkbox", "switch"]);

const compare = (a: JsonValue | undefined, b: JsonValue | undefined) => {
  if (a === b) return 0;
  if (a === undefined || a === null || a === "") return 1;
  if (b === undefined || b === null || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};

/** An error as text; validation issues name their field ("Age: …"). */
const messageOf = (error: unknown, language: string, definition?: FormDefinition) => error instanceof FormDevError && Array.isArray(error.details)
  ? (error.details as Issue[]).map(item => {
    const where = definition ? describePath(definition, item.path) : undefined;
    return where ? `${where}: ${issueText(item, language)}` : issueText(item, language);
  }).join("; ") || error.message
  : error instanceof Error ? error.message : String(error);

export default function RecordsSheet({ client, definition, schemaVersion, codes, isAdmin, language, refreshKey, leafLinks = {}, onOpen, onNew, onChanged }: Props) {
  const th = language.toLowerCase().startsWith("th");
  const t = (thai: string, english: string) => (th ? thai : english);
  const formId = definition.form_id;
  const [records, setRecords] = useState<LocalRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Editing>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** The imported sheet's rows (header first), kept to re-read them when a column is mapped differently. */
  const [raw, setRaw] = useState<string[][]>([]);

  const grants = useMemo(() => fieldPermissions(definition, codes, isAdmin), [definition, codes, isAdmin]);
  const grant = useCallback((key: string) => grants[key] ?? { view: true, edit: true, export: true }, [grants]);
  const columns = useMemo(() => sheetFields(definition).filter(field => grant(fieldKey(field)).view), [definition, grant]);
  const canEdit = recordAllows(definition, "edit", codes, isAdmin);
  const canCreate = recordAllows(definition, "create", codes, isAdmin);

  const load = useCallback(async (all = false) => {
    let rows: LocalRecord[] = [];
    let next: string | null = null;
    do {
      const page = await client.records.search({ formId, limit: PAGE, cursor: next });
      rows = [...rows, ...page.rows];
      next = page.next_cursor;
    } while (all && next);
    return { rows, next };
  }, [client, formId]);

  useEffect(() => {
    let cancelled = false;
    void load().then(({ rows, next }) => {
      if (cancelled) return;
      setRecords(rows);
      setCursor(next);
    });
    return () => { cancelled = true; };
  }, [load, refreshKey]);

  const more = async (all: boolean) => {
    setBusy(true);
    try {
      let rows = records;
      let next = cursor;
      do {
        const page = await client.records.search({ formId, limit: PAGE, cursor: next });
        rows = [...rows, ...page.rows];
        next = page.next_cursor;
      } while (all && next);
      setRecords(rows);
      setCursor(next);
      return rows;
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const active = Object.entries(filters).filter(([, text]) => text.trim());
    const byKey = new Map(columns.map(field => [fieldKey(field), field]));
    let rows = records.filter(record => active.every(([key, text]) => {
      const value = key === "$status" ? record.status : cellText(byKey.get(key)!, record.data[key]);
      return value.toLowerCase().includes(text.trim().toLowerCase());
    }));
    if (sort) {
      const value = (record: LocalRecord): JsonValue | undefined => (sort.key === "$updated" ? record.updated_at : sort.key === "$status" ? record.status : record.data[sort.key]);
      rows = [...rows].sort((a, b) => sort.dir * compare(value(a), value(b)));
    }
    return rows;
  }, [records, filters, sort, columns]);

  const toggleSort = (key: string) => setSort(current => (current?.key !== key ? { key, dir: 1 } : current.dir === 1 ? { key, dir: -1 } : null));

  const editable = (record: LocalRecord, field: FieldDefinition) => canEdit && !leafLinks[record.record_id] && INLINE.has(field.type) && field.readonly !== true && field.derive === undefined
    && record.status !== "deleted" && record.schema_version === schemaVersion && grant(fieldKey(field)).edit;

  const commit = async (record: LocalRecord, field: FieldDefinition, text: string) => {
    setEditing(null);
    const key = fieldKey(field);
    const value = field.type === "checkbox" || field.type === "switch" ? text === "true" : cellValue(field, text);
    const data = { ...record.data };
    if (value === undefined) delete data[key];
    else data[key] = value;
    if (JSON.stringify(data) === JSON.stringify(record.data)) return;
    try {
      const saved = await client.records.update(record.record_id, data, record.version);
      setRecords(current => current.map(row => (row.record_id === saved.record_id ? saved : row)));
      setMessage(t("บันทึกแล้วในเครื่องนี้ จะซิงก์เมื่อเชื่อมต่อได้", "Saved on this device; it syncs when the server is reachable."));
      client.sync.runSoon(0);
      onChanged();
    } catch (caught) {
      setMessage(messageOf(caught, language, definition));
    }
  };

  // Excel export ----------------------------------------------------------------------------------------------
  const download = async () => {
    setBusy(true);
    try {
      const all = cursor ? await more(true) : records;
      const visible = new Set(shown.map(record => record.record_id));
      const rows = (Object.values(filters).some(text => text.trim()) ? all.filter(record => visible.has(record.record_id)) : all);
      const bytes = writeXlsx(recordSheets(definition, rows, key => grant(key).view && grant(key).export));
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${formId}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(t(`ดาวน์โหลด ${rows.length} รายการ`, `Downloaded ${rows.length} records`));
    } catch (caught) {
      setMessage(messageOf(caught, language));
    } finally {
      setBusy(false);
    }
  };

  // Import --------------------------------------------------------------------------------------------------
  const importable = useMemo(() => sheetFields(definition, "form").filter(field => field.type !== "calculated" && field.derive === undefined && grant(fieldKey(field)).edit),
    [definition, grant]);

  const pick = async (file: File) => {
    try {
      const rows = /\.csv$/i.test(file.name) ? readCsv(await file.text()) : (await readXlsx(new Uint8Array(await file.arrayBuffer())))[0]?.rows ?? [];
      if (rows.length < 2) throw new Error(t("ไฟล์ไม่มีข้อมูล (ต้องมีแถวหัวตารางและข้อมูลอย่างน้อย 1 แถว)", "The file has no data (a header row and at least one row are needed)"));
      const headers = rows[0];
      const mapping = matchColumns(headers, importable);
      setPreview({ file: file.name, headers, mapping, rows: importRows(rows, mapping, importable), status: "draft", running: false, done: "" });
      setRaw(rows);
    } catch (caught) {
      setMessage(messageOf(caught, language));
    }
  };
  const remap = (column: number, key: string) => setPreview(current => {
    if (!current) return current;
    const mapping = current.mapping.map((value, index) => (index === column ? key || null : value === key && key ? null : value));
    return { ...current, mapping, rows: importRows(raw, mapping, importable) };
  });

  const runImport = async () => {
    if (!preview) return;
    setPreview({ ...preview, running: true, done: "" });
    const byId = new Map(records.map(record => [record.record_id, record]));
    let created = 0;
    let updated = 0;
    const failed: string[] = [];
    for (const row of preview.rows) {
      try {
        const existing = row.recordId ? byId.get(row.recordId) ?? await client.records.get(row.recordId).catch(() => undefined) : undefined;
        if (existing && existing.form_id === formId) {
          if (!canEdit) throw new Error(t("ไม่มีสิทธิ์แก้ไข", "You may not edit records"));
          if (leafLinks[existing.record_id]) throw new Error(t("กรอกจาก Flora Leaf: เปิดรายการเพื่อแก้ไขพร้อมเหตุผล", "Filled on Flora Leaf: open the record to amend it with a reason"));
          await client.records.update(existing.record_id, { ...existing.data, ...row.data }, existing.version);
          updated += 1;
        } else {
          if (!canCreate) throw new Error(t("ไม่มีสิทธิ์สร้างรายการ", "You may not create records"));
          await client.records.create(formId, row.data, row.status ?? preview.status);
          created += 1;
        }
      } catch (caught) {
        failed.push(`${t("แถว", "Row")} ${row.line}: ${messageOf(caught, language, definition)}`);
      }
    }
    client.sync.runSoon(0);
    onChanged();
    const summary = t(`นำเข้าแล้ว: สร้าง ${created}, แก้ไข ${updated}, ไม่ผ่าน ${failed.length}`, `Imported: ${created} created, ${updated} updated, ${failed.length} failed`);
    setPreview(current => current && { ...current, running: false, done: [summary, ...failed.slice(0, 50), failed.length > 50 ? `… ${failed.length - 50} more` : ""].filter(Boolean).join("\n") });
    const { rows, next } = await load();
    setRecords(rows);
    setCursor(next);
  };

  const th_ = "sticky top-0 z-10 border-b border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1.5 text-left text-xs font-bold text-[var(--app-muted)] whitespace-nowrap";
  const td = "border-b border-r border-[var(--app-border)] px-2 py-1 align-top whitespace-nowrap max-w-[280px] overflow-hidden text-ellipsis";
  const arrow = (key: string) => (sort?.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
      <div className="text-xs text-[var(--app-muted)]">
        {t(`แสดง ${shown.length} จาก ${records.length}${cursor ? "+" : ""} รายการ · ดับเบิลคลิกช่องเพื่อแก้ไข`, `${shown.length} of ${records.length}${cursor ? "+" : ""} records · double-click a cell to edit`)}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void download()}>⬇ {t("ดาวน์โหลด Excel", "Download Excel")}</button>
        {canCreate || canEdit ? <label className={`${button} cursor-pointer`}>⬆ {t("นำเข้าจาก Excel", "Import from Excel")}
          <input type="file" accept=".xlsx,.csv" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void pick(file); }} />
        </label> : null}
        <button type="button" className={primary} disabled={!canCreate} onClick={onNew}>{t("+ รายการใหม่", "+ New record")}</button>
      </div>
    </div>
    {message ? <div className="mx-4 rounded-lg border border-[var(--app-border)] bg-[var(--app-control-bg)] px-3 py-1.5 text-xs text-[var(--app-text)]">{message}</div> : null}

    {preview ? <div className="mx-4 space-y-2 rounded-xl border border-[var(--app-accent)] p-3 text-xs text-[var(--app-text)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">{t("นำเข้า", "Import")} {preview.file}: {preview.rows.length} {t("แถว", "rows")}</div>
        <div className="flex items-center gap-2">
          <label>{t("สถานะของรายการใหม่", "New records are")} <select className={control} value={preview.status} onChange={event => setPreview({ ...preview, status: event.target.value as Preview["status"] })}>
            <option value="draft">{t("ฉบับร่าง", "drafts")}</option><option value="submitted">{t("ส่งแล้ว", "submitted")}</option>
          </select></label>
          <button type="button" className={button} disabled={preview.running} onClick={() => setPreview(null)}>{t("ปิด", "Close")}</button>
          <button type="button" className={primary} disabled={preview.running || !preview.mapping.some(Boolean) || Boolean(preview.done)} onClick={() => void runImport()}>
            {preview.running ? "…" : t("นำเข้า", "Import")}
          </button>
        </div>
      </div>
      <div className="text-[var(--app-muted)]">{t("จับคู่คอลัมน์ในไฟล์กับช่องในฟอร์ม (คอลัมน์ record_id = แก้ไขรายการเดิม, ไม่มี = สร้างใหม่)", "Match the file's columns to form fields (a record_id column updates existing records; rows without one create records)")}</div>
      <div className="flex flex-wrap gap-2">
        {preview.headers.map((name, column) => <label key={column} className="flex items-center gap-1 rounded-lg border border-[var(--app-border)] px-2 py-1">
          <span className="max-w-[140px] truncate font-semibold">{name || `#${column + 1}`}</span> →
          <select className={control} value={preview.mapping[column] ?? ""} onChange={event => remap(column, event.target.value)}>
            <option value="">{t("(ไม่นำเข้า)", "(skip)")}</option>
            <option value="record_id">record_id</option>
            <option value="status">status</option>
            {importable.map(field => <option key={field.id} value={fieldKey(field)}>{field.label}</option>)}
          </select>
        </label>)}
      </div>
      <div className="max-h-48 overflow-auto rounded-lg border border-[var(--app-border)]">
        <table className="text-left"><tbody>
          {preview.rows.slice(0, 5).map(row => <tr key={row.line}><td className={td}>{row.line}</td>{importable.filter(field => fieldKey(field) in row.data).map(field => <td key={field.id} className={td}>{field.label}: {cellText(field, row.data[fieldKey(field)])}</td>)}</tr>)}
        </tbody></table>
      </div>
      {preview.done ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--app-control-bg)] p-2">{preview.done}</pre> : null}
    </div> : null}

    <div className="max-h-[65vh] overflow-auto border-t border-[var(--app-border)]">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={th_}>#</th>
            {columns.map(field => <th key={field.id} className={`${th_} cursor-pointer`} onClick={() => toggleSort(fieldKey(field))}>{field.label}{field.unit ? ` (${field.unit})` : ""}{arrow(fieldKey(field))}</th>)}
            <th className={`${th_} cursor-pointer`} onClick={() => toggleSort("$status")}>{t("สถานะ", "Status")}{arrow("$status")}</th>
            <th className={`${th_} cursor-pointer`} onClick={() => toggleSort("$updated")}>{t("แก้ไขล่าสุด", "Updated")}{arrow("$updated")}</th>
            <th className={th_}>{t("ซิงก์", "Sync")}</th>
          </tr>
          <tr>
            <th className={th_} />
            {columns.map(field => <th key={field.id} className={th_}><input aria-label={`${t("กรอง", "Filter")} ${field.label}`} className={`${control} w-full min-w-[80px] font-normal`} placeholder="🔍"
              value={filters[fieldKey(field)] ?? ""} onChange={event => setFilters(current => ({ ...current, [fieldKey(field)]: event.target.value }))} /></th>)}
            <th className={th_}><input aria-label={t("กรองสถานะ", "Filter status")} className={`${control} w-full min-w-[70px] font-normal`} placeholder="🔍" value={filters.$status ?? ""} onChange={event => setFilters(current => ({ ...current, $status: event.target.value }))} /></th>
            <th className={th_} /><th className={th_} />
          </tr>
        </thead>
        <tbody>
          {shown.map((record, index) => <tr key={record.record_id} className="hover:bg-[var(--app-control-bg)]">
            <td className={`${td} cursor-pointer text-right text-[var(--app-muted)]`} title={t("เปิดฟอร์ม", "Open the form")} onClick={() => onOpen(record)}>
              {leafLinks[record.record_id] ? <span className="mr-1 rounded bg-sky-600 px-1 text-[9px] font-bold text-white" title={t("กรอกจาก Flora Leaf: แก้ไขได้ด้วยการเปิดรายการและระบุเหตุผล", "Filled on Flora Leaf: open the record to amend it with a reason")}>
                Leaf · {leafLinks[record.record_id].hn || "—"}</span> : null}{index + 1} ↗</td>
            {columns.map(field => {
              const key = fieldKey(field);
              const active = editing?.recordId === record.record_id && editing.key === key;
              const can = editable(record, field);
              return <td key={field.id} className={`${td} ${can ? "cursor-cell" : ""}`} onDoubleClick={() => can && setEditing({ recordId: record.record_id, key, text: editText(record.data[key]) })}>
                {active ? <CellEditor field={field} text={editing.text} onCancel={() => setEditing(null)} onCommit={text => void commit(record, field, text)} /> : cellText(field, record.data[key])}
              </td>;
            })}
            <td className={td}>{record.status}</td>
            <td className={`${td} text-[var(--app-muted)]`}>{new Date(record.updated_at).toLocaleString()}</td>
            <td className={td}><span className="text-[10px] font-bold uppercase">{record.sync_state}</span></td>
          </tr>)}
        </tbody>
      </table>
      {!records.length ? <div className="px-4 py-10 text-center text-sm text-[var(--app-muted)]">{t("ยังไม่มีข้อมูล", "No records yet.")}</div> : null}
    </div>
    {cursor ? <div className="flex gap-2 px-4 pb-3">
      <button type="button" className={button} disabled={busy} onClick={() => void more(false)}>{t(`โหลดเพิ่ม ${PAGE}`, `Load ${PAGE} more`)}</button>
      <button type="button" className={button} disabled={busy} onClick={() => void more(true)}>{t("โหลดทั้งหมด", "Load all")}</button>
    </div> : null}
  </div>;
}

const editText = (value: JsonValue | undefined) => (value === null || value === undefined ? "" : typeof value === "boolean" ? String(value) : String(value));

function CellEditor({ field, text, onCommit, onCancel }: { field: FieldDefinition; text: string; onCommit: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(text);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter") onCommit(value);
    else if (event.key === "Escape") onCancel();
  };
  const css = "w-full min-w-[120px] rounded border border-[var(--app-accent)] bg-[var(--app-control-bg)] px-1 py-0.5 text-sm text-[var(--app-text)]";
  if (field.type === "checkbox" || field.type === "switch") {
    return <select autoFocus className={css} value={value} onChange={event => onCommit(event.target.value)} onBlur={() => onCancel()} onKeyDown={keys}>
      <option value="true">✓</option><option value="false">✗</option>
    </select>;
  }
  if ((field.type === "select" || field.type === "radio") && field.options?.length && field.lookup === undefined) {
    return <select autoFocus className={css} value={value} onChange={event => onCommit(event.target.value)} onBlur={() => onCancel()} onKeyDown={keys}>
      <option value="">—</option>
      {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>;
  }
  const type = field.type === "date" ? "date" : field.type === "time" ? "time" : field.type === "datetime" ? "datetime-local" : ["number", "decimal", "integer"].includes(field.type) ? "number" : "text";
  return <input autoFocus className={css} type={type} value={field.type === "datetime" ? value.slice(0, 16) : value} onChange={event => setValue(event.target.value)}
    onKeyDown={keys} onBlur={() => onCommit(field.type === "datetime" && value.length === 16 ? `${value}:00` : value)} />;
}
