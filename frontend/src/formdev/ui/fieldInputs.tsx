/** Screen inputs, one per value kind; inputRegistry.ts maps field types onto them. */
import { useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { AttachmentContext } from "./attachments";
import { localIso } from "./renderUtils";
import type { FieldDefinition, FileValue, JsonValue, SignatureValue } from "../core/types";

export type InputProps = { field: FieldDefinition; value: JsonValue | undefined; disabled: boolean; css: CSSProperties; label: string; onChange: (value: JsonValue) => void };

const textOf = (value: JsonValue | undefined) => (value === null || value === undefined ? "" : String(value));
const options = (field: FieldDefinition) => field.options ?? [];

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
  return <div role="radiogroup" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: "1mm 4mm", minHeight: "8mm", alignItems: "center" }}>
    {options(field).map(option => <label key={option.value} style={{ display: "inline-flex", gap: "1.5mm", alignItems: "center" }}>
      <input type="radio" name={field.id} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} />{option.label}
    </label>)}
  </div>;
}

export function MultiSelectInput({ field, value, disabled, label, onChange }: InputProps) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  return <div role="group" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: "1mm 4mm", minHeight: "8mm", alignItems: "center" }}>
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
