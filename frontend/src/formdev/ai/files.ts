/**
 * Source documents in the browser (AI form builder). Files are sent to the server as they are, one by one
 * (RestApiAdapter.upload: no base64, and PDF pages are rendered on the server for AI hosts that need images).
 */
export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.txt,.csv,.json,application/pdf,image/*";

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
