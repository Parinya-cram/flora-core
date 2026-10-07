/**
 * A form (with or without a record's values) as a PDF file (Designer phase: PDF output). Uses Flora's pdf-lib for
 * pages, lines and images, and the bundled Noto Sans Thai (Thai and Latin subsets, chosen per character run) for
 * text, so it works offline and on the intranet with nothing downloaded. The page layout comes from pdfLayout.ts;
 * values are evaluated with the same engine as the screen (calculated values, hidden fields, Other text) and the
 * user's permissions apply.
 *
 * Text is drawn as glyph outlines shaped by fontkit (Thai tone marks and vowels positioned by the font's GPOS
 * rules). Embedding the fonts instead is not possible here: they ship only as WOFF2, which PDF viewers cannot
 * read, and fontkit's subsetter (which converts to TrueType) fails on Noto Sans Thai's composite glyphs. The
 * trade-off: text in the PDF is not selectable. Prints and displays the same everywhere.
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFImage, type PDFPage } from "pdf-lib";
import notoThai from "@fontsource-variable/noto-sans-thai/files/noto-sans-thai-thai-wght-normal.woff2?inline";
import notoLatin from "@fontsource-variable/noto-sans-thai/files/noto-sans-thai-latin-wght-normal.woff2?inline";
import { resolvePaper } from "../core/layout";
import type { FontEntry, FormDefinition, JsonValue, RecordData, StyleEntry } from "../core/types";
import { evaluateRecord } from "../logic/evaluate";
import type { LookupTables } from "../logic/lookup";
import { denied as deniedFields } from "../logic/permission";
import { formStyle, registries } from "../ui/formStyle";
import { thaiDate } from "../ui/renderUtils";
import { layoutPdf, type Measure, type Op, type Tone } from "./pdfLayout";

export type FormPdfInput = {
  definition: FormDefinition;
  value?: RecordData;
  recordId?: string;
  printedAt?: string;
  styles?: StyleEntry[];
  fonts?: FontEntry[];
  /** Flora role codes: fields the user may not view are left out (omitted = no filtering). */
  roles?: string[];
  isAdmin?: boolean;
  lookups?: LookupTables;
  language?: string;
};

const TONES: Record<Tone, ReturnType<typeof rgb>> = { text: rgb(0.12, 0.16, 0.22), muted: rgb(0.38, 0.43, 0.5), accent: rgb(0.05, 0.32, 0.45) };
const LINE_COLOR = rgb(0.45, 0.5, 0.57);
/** Characters the bundled fonts lack, written with ones they have. */
const SUBSTITUTE: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "⁰": "0", "¹": "1", "²": "2", "³": "3", "–": "-", "—": "-", "…": "...", "≥": ">=", "≤": "<=", "→": "->", "✓": "/", "✗": "x" };

const bytesOf = (dataUrl: string) => {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
};

type GlyphFont = {
  unitsPerEm: number;
  characterSet: number[];
  layout: (text: string) => { glyphs: Array<{ id: number; path: { scale: (x: number, y: number) => { toSVG: () => string } } }>;
    positions: Array<{ xAdvance: number; xOffset: number; yOffset: number }>; advanceWidth: number };
};
type Fonts = { list: Array<{ font: GlyphFont; chars: Set<number>; svg: Map<number, string> }> };
type Run = { entry: Fonts["list"][number]; text: string };

/** Runs of text, each in the first font that has its characters. */
function runs(fonts: Fonts, text: string): Run[] {
  const out: Run[] = [];
  for (const raw of text) {
    let char = raw;
    let entry = fonts.list.find(item => item.chars.has(char.codePointAt(0)!));
    if (!entry) {
      char = SUBSTITUTE[raw] ?? (/\s/.test(raw) ? " " : "?");
      entry = fonts.list.find(item => item.chars.has(char.codePointAt(0)!)) ?? fonts.list[fonts.list.length - 1];
    }
    const last = out[out.length - 1];
    if (last && last.entry === entry) last.text += char;
    else out.push({ entry, text: char });
  }
  return out;
}

const runWidth = (run: Run, size: number) => (run.entry.font.layout(run.text).advanceWidth * size) / run.entry.font.unitsPerEm;

export async function buildFormPdf(input: FormPdfInput): Promise<Uint8Array> {
  const { definition } = input;
  const regs = registries(input.styles, input.fonts);
  const style = formStyle(definition, regs);
  const evaluation = evaluateRecord(definition, input.value ?? {}, "draft", undefined, input.lookups ?? {});
  const denied = input.roles ? deniedFields(definition, "view", input.roles, input.isAdmin ?? false, true) : new Set<string>();

  const pdf = await PDFDocument.create();
  const fonts: Fonts = { list: [notoThai, notoLatin].map(url => {
    const font = fontkit.create(bytesOf(url)) as unknown as GlyphFont;
    return { font, chars: new Set(font.characterSet), svg: new Map<number, string>() };
  }) };
  const measure: Measure = (text, size) => runs(fonts, text).reduce((sum, run) => sum + runWidth(run, size), 0);

  const columns = typeof style.tokens.columns === "number" ? style.tokens.columns : 2;
  const layout = layoutPdf({
    definition, data: evaluation.data as Record<string, JsonValue>, paper: resolvePaper(definition, style.tokens),
    context: { title: definition.title, form_id: definition.form_id, version: definition.schema_version, date: input.printedAt ?? thaiDate(), record_id: input.recordId },
    hidden: new Set(evaluation.hidden), denied, styleColumns: columns, measure, language: input.language,
  });

  const images = new Map<string, PDFImage>();
  for (const ops of layout.pages) {
    const page = pdf.addPage([layout.width, layout.height]);
    for (const op of ops) await draw(pdf, page, op, fonts, images);
  }
  pdf.setTitle(definition.title);
  pdf.setSubject(`${definition.form_id} v${definition.schema_version}${input.recordId ? ` · ${input.recordId}` : ""}`);
  pdf.setCreator("Flora FormDev");
  pdf.setProducer("Flora FormDev (pdf-lib)");
  pdf.setLanguage("th-TH");
  return await pdf.save();
}

async function draw(pdf: PDFDocument, page: PDFPage, op: Op, fonts: Fonts, images: Map<string, PDFImage>) {
  const H = page.getHeight();
  switch (op.kind) {
    case "text": {
      let pen = op.x;
      const color = TONES[op.tone ?? "text"];
      for (const run of runs(fonts, op.text)) {
        const { font, svg } = run.entry;
        const scale = op.size / font.unitsPerEm;
        const shaped = font.layout(run.text);
        shaped.glyphs.forEach((glyph, index) => {
          const position = shaped.positions[index];
          let path = svg.get(glyph.id);
          if (path === undefined) {
            path = glyph.path.scale(1, -1).toSVG(); // font units are y-up, SVG paths y-down
            svg.set(glyph.id, path);
          }
          if (path) page.drawSvgPath(path, { x: pen + position.xOffset * scale, y: H - op.y + position.yOffset * scale, scale, color, borderWidth: 0 });
          pen += position.xAdvance * scale;
        });
      }
      return;
    }
    case "line":
      page.drawLine({ start: { x: op.x1, y: H - op.y1 }, end: { x: op.x2, y: H - op.y2 }, thickness: op.width ?? 0.5, color: LINE_COLOR,
        dashArray: op.dotted ? [1, 2] : undefined });
      return;
    case "rect":
      page.drawRectangle({ x: op.x, y: H - op.y - op.h, width: op.w, height: op.h, borderWidth: 0.4, borderColor: LINE_COLOR });
      return;
    case "mark": {
      const half = op.size / 2;
      const cx = op.x + half;
      const cy = H - op.y - half;
      if (op.round) {
        page.drawCircle({ x: cx, y: cy, size: half, borderWidth: 0.6, borderColor: TONES.text });
        if (op.on) page.drawCircle({ x: cx, y: cy, size: half * 0.5, color: TONES.text });
      } else {
        page.drawRectangle({ x: op.x, y: cy - half, width: op.size, height: op.size, borderWidth: 0.6, borderColor: TONES.text });
        if (op.on) {
          page.drawLine({ start: { x: op.x + op.size * 0.2, y: cy }, end: { x: op.x + op.size * 0.42, y: cy - half * 0.6 }, thickness: 1, color: TONES.text });
          page.drawLine({ start: { x: op.x + op.size * 0.42, y: cy - half * 0.6 }, end: { x: op.x + op.size * 0.85, y: cy + half * 0.7 }, thickness: 1, color: TONES.text });
        }
      }
      return;
    }
    case "image": {
      let image = images.get(op.data);
      if (!image) {
        try {
          image = op.data.startsWith("data:image/png") ? await pdf.embedPng(bytesOf(op.data)) : await pdf.embedJpg(bytesOf(op.data));
        } catch {
          return; // A damaged signature image is left out rather than failing the whole PDF.
        }
        images.set(op.data, image);
      }
      const scale = Math.min(op.w / image.width, op.h / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: op.x + (op.w - w) / 2, y: H - op.y - h, width: w, height: h });
    }
  }
}

/** Save bytes as a file in the browser. */
export function downloadPdf(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
