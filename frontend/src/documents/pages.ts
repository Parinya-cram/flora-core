/**
 * Pages of incoming documents (the assembly workspace, "ประกอบร่าง"): every PDF page and every picture becomes a
 * clip with a thumbnail, rendered in the browser with pdf.js. Nothing is uploaded until a group is used.
 */
export type SourceDocument = { id: string; name: string; kind: "pdf" | "image"; bytes: Uint8Array; mime: string };
export type PageClip = {
  id: string; sourceId: string; name: string; pageIndex: number; kind: "pdf" | "image";
  /** Page size in points as drawn (before rotation). */
  width: number; height: number;
  /** Extra rotation chosen here: 0, 90, 180 or 270 degrees clockwise. */
  rotation: number;
  thumb: string;
};

const THUMB_WIDTH = 220;
let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export const ACCEPT_DOCUMENTS = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

async function pdfjs() {
  const lib = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}

export const isPdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

async function canvasUrl(draw: (canvas: HTMLCanvasElement) => Promise<void>): Promise<string> {
  const canvas = document.createElement("canvas");
  await draw(canvas);
  return canvas.toDataURL("image/jpeg", 0.82);
}

/** Read dropped files into documents and page clips (PDF pages and pictures; other files are refused by name). */
export async function readFiles(files: File[], maxPages = 200): Promise<{ documents: SourceDocument[]; clips: PageClip[]; refused: string[] }> {
  const documents: SourceDocument[] = [];
  const clips: PageClip[] = [];
  const refused: string[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = newId("d");
    if (isPdf(bytes)) {
      const lib = await pdfjs();
      const task = lib.getDocument({ data: bytes.slice() });
      try {
        const pdf = await task.promise;
        documents.push({ id, name: file.name, kind: "pdf", bytes, mime: "application/pdf" });
        for (let number = 1; number <= pdf.numPages && clips.length < maxPages; number += 1) {
          const page = await pdf.getPage(number);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
          const thumb = await canvasUrl(async canvas => {
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d", { alpha: false });
            if (context) await page.render({ canvas, canvasContext: context, viewport }).promise;
          });
          clips.push({ id: newId("p"), sourceId: id, name: file.name, pageIndex: number - 1, kind: "pdf", width: base.width, height: base.height, rotation: 0, thumb });
        }
      } catch {
        refused.push(file.name);
      } finally {
        await task.destroy().catch(() => undefined);
      }
    } else if (/^image\/(png|jpeg)$/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: file.type || "image/png" }));
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = reject;
          element.src = url;
        });
        const thumb = await canvasUrl(async canvas => {
          canvas.width = THUMB_WIDTH;
          canvas.height = Math.round(THUMB_WIDTH * image.naturalHeight / Math.max(1, image.naturalWidth));
          canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        });
        const mime = /\.jpe?g$/i.test(file.name) || file.type === "image/jpeg" ? "image/jpeg" : "image/png";
        documents.push({ id, name: file.name, kind: "image", bytes, mime });
        // A photo or scan at 200 dpi: its size in points.
        clips.push({ id: newId("p"), sourceId: id, name: file.name, pageIndex: 0, kind: "image", width: image.naturalWidth * 0.36, height: image.naturalHeight * 0.36, rotation: 0, thumb });
      } catch {
        refused.push(file.name);
      } finally {
        URL.revokeObjectURL(url);
      }
    } else {
      refused.push(file.name);
    }
  }
  return { documents, clips, refused };
}

/** Draw one clip large (preview, reading view) on a canvas at the given CSS width; returns the drawn size. */
export async function drawClip(canvas: HTMLCanvasElement, clip: PageClip, source: SourceDocument, cssWidth: number): Promise<{ width: number; height: number }> {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const turned = clip.rotation % 180 !== 0;
  const pageWidth = turned ? clip.height : clip.width;
  const pageHeight = turned ? clip.width : clip.height;
  const scale = cssWidth / pageWidth;
  canvas.width = Math.ceil(pageWidth * scale * ratio);
  canvas.height = Math.ceil(pageHeight * scale * ratio);
  canvas.style.width = `${Math.round(pageWidth * scale)}px`;
  canvas.style.height = `${Math.round(pageHeight * scale)}px`;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return { width: 0, height: 0 };
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (source.kind === "pdf") {
    const lib = await pdfjs();
    const task = lib.getDocument({ data: source.bytes.slice() });
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(clip.pageIndex + 1);
      const viewport = page.getViewport({ scale: scale * ratio, rotation: (page.rotate + clip.rotation) % 360 });
      await page.render({ canvas, canvasContext: context, viewport }).promise;
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } else {
    const url = URL.createObjectURL(new Blob([source.bytes as Uint8Array<ArrayBuffer>], { type: source.mime }));
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = reject;
        element.src = url;
      });
      context.save();
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate((clip.rotation * Math.PI) / 180);
      const w = (turned ? canvas.height : canvas.width);
      const h = (turned ? canvas.width : canvas.height);
      context.drawImage(image, -w / 2, -h / 2, w, h);
      context.restore();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { width: Math.round(pageWidth * scale), height: Math.round(pageHeight * scale) };
}

/** A clip's thumbnail turned by its rotation (CSS). */
export const thumbStyle = (clip: PageClip) => ({ transform: `rotate(${clip.rotation}deg)` });
