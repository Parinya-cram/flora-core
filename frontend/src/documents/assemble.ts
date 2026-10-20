/**
 * A group of page clips → one PDF (pdf-lib): PDF pages are copied as they are (vector, text layer kept) with the
 * rotation chosen here; pictures are placed on A4 (portrait or landscape like the picture), fitted with a 8 mm margin.
 */
import type { PageClip, SourceDocument } from "./pages";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 8 * 72 / 25.4;

export async function mergeClips(clips: PageClip[], sources: Map<string, SourceDocument>, title: string): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await import("pdf-lib");
  const out = await PDFDocument.create();
  const loaded = new Map<string, Awaited<ReturnType<typeof PDFDocument.load>>>();
  for (const clip of clips) {
    const source = sources.get(clip.sourceId);
    if (!source) continue;
    if (source.kind === "pdf") {
      let pdf = loaded.get(source.id);
      if (!pdf) {
        pdf = await PDFDocument.load(source.bytes, { ignoreEncryption: true });
        loaded.set(source.id, pdf);
      }
      const [page] = await out.copyPages(pdf, [clip.pageIndex]);
      if (clip.rotation) page.setRotation(degrees((page.getRotation().angle + clip.rotation) % 360));
      out.addPage(page);
    } else {
      const image = source.mime === "image/jpeg" ? await out.embedJpg(source.bytes) : await out.embedPng(source.bytes);
      const turned = clip.rotation % 180 !== 0;
      const landscape = turned ? image.height > image.width : image.width > image.height;
      const size: [number, number] = landscape ? [A4[1], A4[0]] : A4;
      const page = out.addPage(size);
      const boxW = size[0] - 2 * MARGIN;
      const boxH = size[1] - 2 * MARGIN;
      const drawnW = turned ? image.height : image.width;
      const drawnH = turned ? image.width : image.height;
      const scale = Math.min(boxW / drawnW, boxH / drawnH);
      const w = image.width * scale;
      const h = image.height * scale;
      const cx = size[0] / 2;
      const cy = size[1] / 2;
      // pdf-lib rotates about the image's lower-left corner: place that corner so the turned picture is centred.
      const angle = (360 - clip.rotation) % 360;
      const corner = angle === 90 ? { x: cx + h / 2, y: cy - w / 2 } : angle === 180 ? { x: cx + w / 2, y: cy + h / 2 }
        : angle === 270 ? { x: cx - h / 2, y: cy + w / 2 } : { x: cx - w / 2, y: cy - h / 2 };
      page.drawImage(image, { x: corner.x, y: corner.y, width: w, height: h, rotate: degrees(angle) });
    }
  }
  out.setTitle(title);
  out.setProducer("Flora Form Studio");
  return await out.save();
}

export function download(bytes: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
