/** Screen inputs, one per value kind; inputRegistry.ts maps field types onto them. */
import { useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { AttachmentContext } from "./attachments";
import { localIso } from "./renderUtils";
import type { FieldDefinition, FileValue, JsonValue, MatrixCell, MatrixValue, SignatureValue } from "../core/types";
import { matrixCell, matrixTotals } from "../core/validate";

export type InputProps = { field: FieldDefinition; value: JsonValue | undefined; disabled: boolean; css: CSSProperties; label: string; onChange: (value: JsonValue) => void };

const textOf = (value: JsonValue | undefined) => (value === null || value === undefined ? "" : String(value));
const options = (field: FieldDefinition) => field.options ?? [];
/** option_columns: options in columns (fewer when the box is narrow, as on a phone); otherwise they wrap like words. */
const optionLayout = (field: FieldDefinition): CSSProperties => field.option_columns
  ? { display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(max(34mm, calc(${100 / field.option_columns}% - 3mm)), 1fr))`, gap: "1mm 3mm", alignItems: "center" }
  : { display: "flex", flexWrap: "wrap", gap: "1mm 4mm", minHeight: "8mm", alignItems: "center" };

export function TextInput({ field, value, disabled, css, label, onChange }: InputProps) {
  return <input aria-label={label} style={css} value={textOf(value)} disabled={disabled} maxLength={field.max_length} placeholder={field.placeholder} onChange={event => onChange(event.target.value || null)} />;
}

export function TextArea({ field, value, disabled, css, label, onChange }: InputProps) {
  return <textarea aria-label={label} style={{ ...css, minHeight: "20mm", padding: "1.5mm" }} value={textOf(value)} disabled={disabled} maxLength={field.max_length} placeholder={field.placeholder}
    onChange={event => onChange(event.target.value || null)} />;
}

export function NumberInput({ field, value, disabled, css, label, onChange }: InputProps) {
  const step = field.type === "integer" ? 1 : field.type === "decimal" ? 10 ** -(field.decimals ?? 2) : "any";
  return <input aria-label={label} type="number" style={css} value={textOf(value)} disabled={disabled} min={field.min} max={field.max} step={step} placeholder={field.placeholder}
    onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))} />;
}

export function TemporalInput({ field, value, disabled, css, label, onChange }: InputProps) {
  const type = field.type === "datetime" ? "datetime-local" : field.type;
  const shown = field.type === "datetime" ? textOf(value).slice(0, 16) : textOf(value);
  return <input aria-label={label} type={type} style={css} value={shown} disabled={disabled} onChange={event => onChange(event.target.value || null)} />;
}

export function SelectInput({ field, value, disabled, css, label, onChange }: InputProps) {
  return <select aria-label={label} style={css} value={textOf(value)} disabled={disabled} onChange={event => onChange(event.target.value || null)}>
    <option value="">{field.placeholder ?? "—"}</option>
    {options(field).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}

export function RadioInput({ field, value, disabled, label, onChange }: InputProps) {
  return <div role="radiogroup" aria-label={label} style={optionLayout(field)}>
    {options(field).map(option => <label key={option.value} style={{ display: "inline-flex", gap: "1.5mm", alignItems: "center" }}>
      <input type="radio" name={field.id} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} />{option.label}
    </label>)}
  </div>;
}

export function MultiSelectInput({ field, value, disabled, label, onChange }: InputProps) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  return <div role="group" aria-label={label} style={optionLayout(field)}>
    {options(field).map(option => <label key={option.value} style={{ display: "inline-flex", gap: "1.5mm", alignItems: "center" }}>
      <input type="checkbox" disabled={disabled} checked={selected.includes(option.value)}
        onChange={event => onChange(event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))} />{option.label}
    </label>)}
  </div>;
}

export function CheckboxInput({ value, disabled, label, onChange }: InputProps) {
  return <input aria-label={label} type="checkbox" style={{ width: "5mm", height: "5mm", marginTop: "1.5mm" }} checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
}

export function SwitchInput({ value, disabled, label, onChange }: InputProps) {
  const on = value === true;
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
    style={{ width: "11mm", height: "6mm", borderRadius: "3mm", border: "none", padding: "0.6mm", background: on ? "#0d9488" : "#cbd5e1", cursor: disabled ? "default" : "pointer", marginTop: "1mm" }}>
    <span style={{ display: "block", width: "4.8mm", height: "4.8mm", borderRadius: "50%", background: "#ffffff", marginLeft: on ? "auto" : 0 }} />
  </button>;
}

export function FileInput({ field, value, disabled, label, onChange }: InputProps) {
  const attachments = useContext(AttachmentContext);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const many = field.multiple === true;
  const files: FileValue[] = Array.isArray(value) ? (value as FileValue[]) : value ? [value as FileValue] : [];
  const accept = (field.accept ?? (field.type === "image" ? ["image/*"] : [])).join(",");
  const pick = async (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (!chosen.length) return;
    setBusy(true);
    setProblem("");
    try {
      // The bytes stay on this device (and are uploaded by sync); the record keeps {name, mime, size, ref}.
      const picked = await Promise.all(chosen.map(file => attachments.save(file)));
      onChange((many ? [...files, ...picked] : picked[0]) as JsonValue);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const open = async (file: FileValue) => {
    const blob = await attachments.open(file).catch(() => null);
    if (!blob) { setProblem(`${file.name}: not available on this device yet`); return; }
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return <div style={{ display: "grid", gap: "1mm" }}>
    {!disabled ? <input aria-label={label} type="file" accept={accept || undefined} multiple={many} disabled={busy} onChange={event => { void pick(event.target.files); event.target.value = ""; }} /> : null}
    {files.map((file, index) => <div key={`${file.ref}-${index}`} style={{ display: "flex", gap: "2mm", alignItems: "center", fontSize: "9pt" }}>
      {file.mime.startsWith("image/") ? <Thumbnail file={file} /> : <span aria-hidden>📎</span>}
      <button type="button" onClick={() => void open(file)} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}>
        {file.name}
      </button>
      <span style={{ color: "#64748b" }}>({Math.ceil(file.size / 1024)} KB)</span>
      {!disabled ? <button type="button" aria-label={`Remove ${file.name}`} onClick={() => onChange((many ? files.filter((_, i) => i !== index) : null) as JsonValue)}>×</button> : null}
    </div>)}
    {busy ? <span style={{ fontSize: "8pt", color: "#64748b" }}>…</span> : null}
    {problem ? <span role="alert" style={{ fontSize: "8pt", color: "#e11d48" }}>{problem}</span> : null}
  </div>;
}

/** A small preview of an image attachment (from this device, or from the server through its record). */
function Thumbnail({ file }: { file: FileValue }) {
  const attachments = useContext(AttachmentContext);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let created: string | null = null;
    void attachments.open(file).then(blob => {
      if (!live || !blob) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    }).catch(() => undefined);
    return () => { live = false; if (created) URL.revokeObjectURL(created); };
  }, [attachments, file]);
  return url ? <img src={url} alt="" style={{ width: "12mm", height: "12mm", objectFit: "cover", borderRadius: "1mm", border: "0.3mm solid #cbd5e1" }} />
    : <span aria-hidden>🖼</span>;
}

export function SignatureInput({ field, value, disabled, label, onChange }: InputProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const drew = useRef(false);
  const [resigning, setResigning] = useState(false);
  const signature = value as SignatureValue | null | undefined;
  if (signature?.data && !resigning) {
    return <div style={{ display: "grid", gap: "1mm" }}>
      <img alt={label} src={signature.data} style={{ maxHeight: "25mm", border: "0.3mm solid #cbd5e1", background: "#ffffff" }} />
      <span style={{ fontSize: "8pt", color: "#64748b" }}>{[signature.signer, signature.signed_at].filter(Boolean).join(" · ")}</span>
      {!disabled ? <button type="button" onClick={() => { onChange(null); setResigning(true); }}>Sign again</button> : null}
    </div>;
  }
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - box.left) * (event.currentTarget.width / box.width), (event.clientY - box.top) * (event.currentTarget.height / box.height)];
  };
  return <div style={{ display: "grid", gap: "1mm" }}>
    <canvas ref={canvas} aria-label={label} width={600} height={180} style={{ width: "100%", height: "25mm", border: "0.3mm dashed #94a3b8", background: "#ffffff", touchAction: "none" }}
      onPointerDown={event => {
        if (disabled) return;
        drawing.current = true;
        const context = event.currentTarget.getContext("2d");
        const [x, y] = point(event);
        context?.beginPath();
        context?.moveTo(x, y);
      }}
      onPointerMove={event => {
        if (!drawing.current) return;
        const context = event.currentTarget.getContext("2d");
        const [x, y] = point(event);
        if (context) {
          context.lineWidth = 2.5;
          context.lineCap = "round";
          context.lineTo(x, y);
          context.stroke();
        }
        drew.current = true;
      }}
      onPointerUp={() => {
        drawing.current = false;
        if (canvas.current && drew.current) {
          drew.current = false;
          setResigning(false);
          onChange({ data: canvas.current.toDataURL("image/png"), signed_at: localIso() });
        }
      }} />
    <span style={{ fontSize: "8pt", color: "#64748b" }}>{disabled ? "—" : `Sign inside the box${field.max_size_kb ? ` (max ${field.max_size_kb} KB)` : ""}`}</span>
  </div>;
}

export function CalculatedOutput({ field, value, css, label }: InputProps) {
  const shown = typeof value === "number" && field.decimals !== undefined ? value.toFixed(field.decimals) : textOf(value);
  return <output aria-label={label} title={field.formula ?? field.calculator} style={{ ...css, display: "flex", alignItems: "center", background: "#f8fafc" }}>{shown || "—"}</output>;
}

/** matrix: a score sheet (rows x columns of cells) with computed total rows, e.g. the Modified Aldrete score. */
export function MatrixInput({ field, value, disabled, css, label, onChange }: InputProps) {
  const data = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as MatrixValue;
  const totals = matrixTotals(field, data);
  const set = (row: string, col: string, next: string | number | null) => {
    const cells = { ...(data[row] ?? {}) };
    if (next === null) delete cells[col];
    else cells[col] = next;
    const out = { ...data, [row]: cells };
    if (!Object.keys(cells).length) delete out[row];
    onChange(Object.keys(out).length ? (out as JsonValue) : null);
  };
  const border: CSSProperties = { border: "0.3mm solid #cbd5e1", padding: "0.6mm", textAlign: "center" };
  const head: CSSProperties = { ...border, background: "#f1f5f9", fontWeight: 600 };
  const input: CSSProperties = { ...css, minHeight: 0, width: "100%", minWidth: "11mm", boxSizing: "border-box", textAlign: "center", padding: "0.8mm" };
  const editor = (row: string, col: string, cell: Partial<MatrixCell>) => {
    const current = data[row]?.[col];
    const name = `${label}: ${(field.rows ?? []).find(item => item.id === row)?.label ?? row} / ${(field.cols ?? []).find(item => item.id === col)?.label ?? col}`;
    if (cell.type === "select") {
      return <select aria-label={name} style={input} value={current === null || current === undefined ? "" : String(current)} disabled={disabled} onChange={event => set(row, col, event.target.value || null)}>
        <option value="">—</option>
        {(cell.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>;
    }
    if (cell.type === "integer" || cell.type === "number") {
      return <input aria-label={name} type="number" style={input} value={current === null || current === undefined ? "" : String(current)} disabled={disabled}
        min={cell.min} max={cell.max} step={cell.type === "integer" ? 1 : "any"} onChange={event => set(row, col, event.target.value === "" ? null : Number(event.target.value))} />;
    }
    return <input aria-label={name} style={input} value={current === null || current === undefined ? "" : String(current)} disabled={disabled} maxLength={200} onChange={event => set(row, col, event.target.value || null)} />;
  };
  const rows: Array<{ id: string; label: string; total?: true }> = [];
  for (const row of field.rows ?? []) {
    rows.push(row);
    // A total row follows the last row it adds up (as on paper: criteria, Total, then other scores).
    for (const total of field.totals ?? []) if (total.of[total.of.length - 1] === row.id) rows.push({ id: total.id, label: total.label, total: true });
  }
  return <div style={{ overflowX: "auto" }} data-matrix={field.id}>
    <table aria-label={label} style={{ borderCollapse: "collapse", width: "100%", fontSize: "9.5pt" }}>
      <thead><tr><th style={{ ...head, textAlign: "left", minWidth: "30mm" }} />{(field.cols ?? []).map(col => <th key={col.id} style={head}>{col.label}</th>)}</tr></thead>
      <tbody>
        {rows.map(row => <tr key={row.id} style={row.total ? { background: "#f8fafc", fontWeight: 700 } : undefined}>
          <td style={{ ...border, textAlign: "left" }}>{row.label}</td>
          {(field.cols ?? []).map(col => <td key={col.id} style={border}>
            {row.total ? totals[row.id]?.[col.id] ?? "" : editor(row.id, col.id, matrixCell(field, (field.rows ?? []).find(item => item.id === row.id) ?? { id: row.id, label: row.label }))}
          </td>)}
        </tr>)}
      </tbody>
    </table>
  </div>;
}
