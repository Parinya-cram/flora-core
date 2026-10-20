/** The assembly workspace (src/documents): page clips merged into one PDF, and the AI panel's list of what changed. */
import { PDFDocument, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { mergeClips } from "../../src/documents/assemble";
import { isPdf, type PageClip, type SourceDocument } from "../../src/documents/pages";
import { changesOf } from "../../src/formdev/designer/model";
import { example } from "./helpers";

// A 40 × 20 picture: wider than tall.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJ0lEQVR4nGM8ISfHMBCAaUBsHbV41OJRi0ctHrV41OJRi0ctHhAAAF+MASwoT9QRAAAAAElFTkSuQmCC"), c => c.charCodeAt(0));

async function pdf(sizes: Array<[number, number]>, rotation = 0) {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size).setRotation(degrees(rotation));
  return await doc.save();
}

const clip = (sourceId: string, pageIndex: number, kind: "pdf" | "image", rotation = 0): PageClip =>
  ({ id: `${sourceId}${pageIndex}${rotation}`, sourceId, name: sourceId, pageIndex, kind, width: 0, height: 0, rotation, thumb: "" });

describe("assembling pages into one PDF", () => {
  it("copies PDF pages as they are, adds the rotation chosen, and places pictures on A4 the way they face", async () => {
    const sources = new Map<string, SourceDocument>([
      ["a", { id: "a", name: "a.pdf", kind: "pdf", bytes: await pdf([[300, 400], [500, 200]]), mime: "application/pdf" }],
      ["b", { id: "b", name: "b.pdf", kind: "pdf", bytes: await pdf([[300, 400]], 90), mime: "application/pdf" }],
      ["p", { id: "p", name: "scan.png", kind: "image", bytes: PNG, mime: "image/png" }],
    ]);
    const bytes = await mergeClips([clip("a", 1, "pdf"), clip("b", 0, "pdf", 90), clip("p", 0, "image"), clip("p", 0, "image", 90), clip("gone", 0, "pdf")],
      sources, "ชุดเอกสารเคส");
    expect(isPdf(bytes)).toBe(true);
    const merged = await PDFDocument.load(bytes);
    const pages = merged.getPages();
    expect(pages).toHaveLength(4); // the clip of a removed source is left out
    expect(pages[0].getSize()).toEqual({ width: 500, height: 200 });
    expect(pages[1].getRotation().angle).toBe(180); // the page's own 90° plus the 90° chosen
    expect(pages[2].getSize().width).toBeGreaterThan(pages[2].getSize().height); // a wide picture on landscape A4
    expect(pages[3].getSize().width).toBeLessThan(pages[3].getSize().height); // turned a quarter: portrait
    expect(merged.getTitle()).toBe("ชุดเอกสารเคส");
  });

  it("knows a PDF by its first bytes", () => {
    expect(isPdf(new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(isPdf(PNG)).toBe(false);
    expect(isPdf(new Uint8Array())).toBe(false);
  });
});

describe("what the AI changed", () => {
  it("lists fields added, removed and changed by id", () => {
    const before = example(1);
    const after = structuredClone(before);
    const [first, second] = after.sections[0].fields;
    first.label = `${first.label} (แก้)`;
    after.sections[0].fields = after.sections[0].fields.filter(field => field.id !== second.id);
    after.sections[0].fields.push({ id: "pain_score", key: "pain_score", type: "integer", label: "คะแนนปวด" } as never);
    const changes = changesOf(before, after);
    expect(changes.added.map(field => field.id)).toEqual(["pain_score"]);
    expect(changes.removed.map(field => field.id)).toEqual([second.id]);
    expect(changes.changed.map(([old, next]) => [old.label, next.label])).toEqual([[before.sections[0].fields[0].label, first.label]]);
  });
});
