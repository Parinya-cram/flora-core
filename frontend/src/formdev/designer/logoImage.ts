/**
 * A logo picture for the form (field type logo): read in the browser and scaled down until its data URL fits the
 * definition's limit. PNG keeps transparency and sharp edges (logos); JPEG is the fallback for photo-like pictures
 * that stay too large as PNG. SVG, WEBP and GIF are drawn to a canvas and stored as PNG (the PDF embeds PNG / JPEG).
 */

/** Longest side first tried, in pixels: about 300 dpi for a 40 mm wide logo. */
const START_PX = 600;
const MIN_PX = 120;

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("The file is not a picture this browser can read")); };
    image.src = url;
  });
}

function draw(image: HTMLImageElement, longest: number, type: "image/png" | "image/jpeg"): string {
  const width = image.naturalWidth || image.width || longest;
  const height = image.naturalHeight || image.height || longest;
  const scale = Math.min(1, longest / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The picture could not be prepared");
  if (type === "image/jpeg") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, 0.88);
}

export async function logoDataUrl(file: File, maxChars: number): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a PNG, JPEG, SVG, WEBP or GIF picture");
  const image = await load(file);
  for (let longest = START_PX; longest >= MIN_PX; longest = Math.round(longest * 0.75)) {
    const png = draw(image, longest, "image/png");
    if (png.length <= maxChars) return png;
    const jpeg = draw(image, longest, "image/jpeg");
    if (jpeg.length <= maxChars) return jpeg;
  }
  throw new Error("The picture is too detailed to keep in the form; use a simpler logo file");
}
