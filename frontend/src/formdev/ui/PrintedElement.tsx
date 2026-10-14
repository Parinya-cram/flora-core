/**
 * Printed elements on screen (field types logo and barcode): the definition's picture, or the barcode of another
 * field's value drawn from the same bars as the PDF (render/barcode.ts). An empty barcode shows a dashed blank with
 * its label, as it prints.
 */
import type { FieldDefinition, JsonValue } from "../core/types";
import { encodeBarcode } from "../render/barcode";

const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end" } as const;

export default function PrintedElement({ field, data }: { field: FieldDefinition; data: Record<string, JsonValue> }) {
  const align = field.align ?? (field.type === "logo" ? "left" : "center");
  if (field.type === "logo") {
    const height = `${field.height_mm ?? 14}mm`;
    return <div data-printed="logo" style={{ display: "flex", justifyContent: JUSTIFY[align], height }}>
      {field.src ? <img src={field.src} alt={field.label} style={{ height, maxWidth: "100%", objectFit: "contain" }} />
        : <span style={{ alignSelf: "center", fontSize: "8pt", color: "#94a3b8" }}>{field.label}</span>}
    </div>;
  }
  const code = encodeBarcode(field.symbology, field.source ? data[field.source] : undefined);
  const height = (field.height_mm ?? 10) * 4;
  if (!code) {
    return <div data-printed="barcode" role="img" aria-label={field.label}
      style={{ height: `${field.height_mm ?? 10}mm`, border: "0.3mm dashed #cbd5e1", borderRadius: "1mm", fontSize: "8pt", color: "#94a3b8", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {field.label}
    </div>;
  }
  return <div data-printed="barcode" style={{ display: "flex", flexDirection: "column", alignItems: JUSTIFY[align] }}>
    <svg role="img" aria-label={`${field.label}: ${code.text}`} viewBox={`0 0 ${code.width} ${height}`} preserveAspectRatio="none"
      style={{ width: `min(100%, ${(code.width * 0.33).toFixed(1)}mm)`, height: `${field.height_mm ?? 10}mm`, background: "#ffffff" }}>
      {code.bars.map((bar, index) => <rect key={index} x={bar.x} y={0} width={bar.w} height={height} fill="#111827" />)}
    </svg>
    {field.show_text === false ? null : <span style={{ fontSize: "8pt", letterSpacing: "0.5mm", fontFamily: "monospace" }}>{code.text}</span>}
  </div>;
}
