import { BACKEND_BASE } from "./backendBase";
import { readStoredAuthToken } from "./authApi";
import { wardHeaders } from "./wardSelection";

/** A document attached to a case (0094): pages put together in the assembly workspace, kept with the case as one PDF. */
export type CaseDocument = {
  id: number; case_id: number; title: string; pages: number; bytes: number; sha256: string; created_at: number; created_by: string | null;
  removed_at: number | null; removed_by: string | null; removed_reason: string | null; synced_at: number | null; sync_error: string | null;
};

const BASE = `${BACKEND_BASE}/api/case`;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({})) as { detail?: unknown };
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${response.status})`);
  return data as T;
}

export const listCaseDocuments = (caseId: number) => json<{ documents: CaseDocument[] }>(`${BASE}/${caseId}/documents`).then(data => data.documents);

/** The PDF is the request body (no base64); title and page count go in the address. */
export const attachCaseDocument = (caseId: number, details: { title: string; pages: number }, pdf: Uint8Array) =>
  json<{ document: CaseDocument }>(`${BASE}/${caseId}/documents?${new URLSearchParams({ title: details.title, pages: String(details.pages) })}`,
    { method: "POST", headers: { "Content-Type": "application/pdf" }, body: new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) }).then(data => data.document);

export const removeCaseDocument = (caseId: number, documentId: number, reason: string) =>
  json<{ document: CaseDocument }>(`${BASE}/${caseId}/documents/${documentId}/remove`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });

export async function caseDocumentFile(caseId: number, documentId: number): Promise<Uint8Array> {
  const response = await fetch(`${BASE}/${caseId}/documents/${documentId}/file`);
  if (!response.ok) throw new Error(`Could not read the document (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Canopy: the documents a Leaf attached to a synchronized case. */
export type CanopyCaseDocument = { leaf_id: string; document_id: number; title: string; pages: number; bytes: number; created_at: number; created_by: string | null;
  removed_at: number | null; removed_by: string | null; removed_reason: string | null; received_at: number;
  /** The file itself has arrived (the details come first). */
  received: boolean };

function canopyHeaders(): Record<string, string> {
  const token = readStoredAuthToken();
  return { ...wardHeaders(), ...(token ? { "X-FLORA-Session": token } : {}) };
}

export const listCanopyCaseDocuments = (globalCaseId: string) =>
  json<{ documents: CanopyCaseDocument[] }>(`${BACKEND_BASE}/api/fleet/cases/${encodeURIComponent(globalCaseId)}/documents`, { headers: canopyHeaders() }).then(data => data.documents);

export async function canopyCaseDocumentFile(globalCaseId: string, leafId: string, documentId: number): Promise<Blob> {
  const response = await fetch(`${BACKEND_BASE}/api/fleet/cases/${encodeURIComponent(globalCaseId)}/documents/${encodeURIComponent(leafId)}/${documentId}/file`, { headers: canopyHeaders() });
  if (!response.ok) throw new Error(`Could not read the document (${response.status})`);
  return await response.blob();
}
