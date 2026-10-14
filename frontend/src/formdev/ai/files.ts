/**
 * Source documents in the browser (AI form builder): files as base64 for the server and, for AI hosts that cannot read
 * PDF files (OpenAI-compatible), every PDF page rendered as a PNG with pdf.js. The server checks every file again;
 * nothing here decides whether a document is usable.
 */
import type { UploadFile } from "./types";

/** Rendering width of a page image: enough for small print on an A4 form, small enough to send. */
const PAGE_WIDTH_PX = 1600;

export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.txt,.csv,.json,application/pdf,image/*";

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (let start = 0; start < view.length; start += 0x8000) text += String.fromCharCode(...view.subarray(start, start + 0x8000));
  return btoa(text);
}

const isPdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

/** PNG pages of a PDF (at most maxPages); an unreadable PDF gives no pages and the server reports it. */
export async function pdfPages(bytes: Uint8Array, maxPages: number): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pages: string[] = [];
  try {
    const pdf = await task.promise;
    for (let number = 1; number <= Math.min(pdf.numPages, maxPages); number += 1) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PAGE_WIDTH_PX / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) break;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
      if (blob) pages.push(base64(await blob.arrayBuffer()));
    }
  } catch {
    return [];
  } finally {
    await task.destroy().catch(() => undefined);
  }
  return pages;
}

/** The files as the server expects them; PDF pages as images when the AI host needs them. */
export async function uploadFiles(files: File[], options: { pageImages: boolean; maxPages: number }): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  let pagesLeft = options.maxPages;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const item: UploadFile = { name: file.name, data: base64(bytes) };
    if (options.pageImages && isPdf(bytes) && pagesLeft > 0) {
      item.page_images = await pdfPages(bytes, pagesLeft);
      pagesLeft -= item.page_images.length;
    }
    out.push(item);
  }
  return out;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Save text as a file (a template's .form.json). */
export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
