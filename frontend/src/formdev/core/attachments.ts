/** Attachment references in record data (twin of services/flora-api/app/formdev/attachments.py refs()). */
import type { FileValue } from "./types";

export const ATTACHMENT_REF = /^att:([0-9a-f]{64})$/;
export const attachmentRef = (sha256: string) => `att:${sha256}`;

/** SHA-256 of an "att:" reference, or null. */
export const shaOf = (ref: unknown): string | null => (typeof ref === "string" ? ATTACHMENT_REF.exec(ref)?.[1] ?? null : null);

/** Every attachment hash referenced anywhere in a record's data (file values {name, ref: "att:..."}). */
export function attachmentRefs(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    const sha = shaOf((node as Partial<FileValue>).ref);
    if (sha && typeof (node as Partial<FileValue>).name === "string") { out.add(sha); return; }
    Object.values(node).forEach(walk);
  };
  walk(value);
  return [...out];
}
