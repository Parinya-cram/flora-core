/**
 * Static elements on screen and in the HTML print: a heading (its label in the UI language), a paragraph (its
 * content) or a dividing line. They hold no value. The PDF draws the same in render/pdfLayout.ts.
 */
import type { CSSProperties } from "react";
import type { FieldDefinition } from "../core/types";

/** A heading (its label), a paragraph (its content) or a dividing line: shown, never filled in. */
export default function StaticElement({ field, text, css }: { field: FieldDefinition; text: string; css: CSSProperties }) {
  const align = field.align ?? "left";
  if (field.type === "divider") return <hr data-static="divider" style={{ border: 0, borderTop: "0.4mm solid #94a3b8", margin: "1.5mm 0" }} />;
  if (field.type === "paragraph") {
    return <p data-static="paragraph" style={{ ...css, fontWeight: 400, margin: 0, whiteSpace: "pre-wrap", textAlign: align }}>{field.content}</p>;
  }
  const size = field.level === 3 ? "10.5pt" : field.level === 1 ? "15pt" : "12.5pt";
  return <div role="heading" aria-level={(field.level ?? 2) + 2} data-static="heading" style={{ ...css, fontSize: size, fontWeight: 700, textAlign: align, margin: 0 }}>{text}</div>;
}

