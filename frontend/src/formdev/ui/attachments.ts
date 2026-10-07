/**
 * Where file fields keep the files people pick. The record stores {name, mime, size, ref: "att:<sha256>"}; the
 * bytes live on this device (IndexedDB) until sync uploads them, and are read back from the device or, for
 * records from the server, through the record (GET /attachments/{sha}?record_id=...). Without a provider
 * (designer previews) files are kept in memory only.
 */
import { createContext } from "react";
import { attachmentRef, shaOf } from "../core/attachments";
import { sha256 } from "../core/sha256";
import type { FileValue, LocalAttachment } from "../core/types";
import type { LocalDataAdapter, RemoteDataAdapter } from "../data/DataAdapter";

export type AttachmentService = {
  /** Keep a picked file and return the value to store in the record. */
  save: (file: File) => Promise<FileValue>;
  /** The file's bytes, or null when this device does not have them and the server cannot give them. */
  open: (value: FileValue) => Promise<Blob | null>;
};

async function describe(file: File): Promise<{ value: FileValue; bytes: ArrayBuffer }> {
  const bytes = await file.arrayBuffer();
  const sha = await sha256(new Uint8Array(bytes));
  const mime = (file.type || "application/octet-stream").toLowerCase();
  return { value: { name: file.name, mime, size: file.size, ref: attachmentRef(sha) }, bytes };
}

export function memoryAttachments(): AttachmentService {
  const files = new Map<string, { bytes: ArrayBuffer; mime: string }>();
  return {
    save: async file => {
      const { value, bytes } = await describe(file);
      files.set(value.ref, { bytes, mime: value.mime });
      return value;
    },
    open: async value => {
      const found = files.get(value.ref);
      return found ? new Blob([found.bytes], { type: found.mime }) : null;
    },
  };
}

export function deviceAttachments(local: LocalDataAdapter, remote: RemoteDataAdapter | null, recordId: () => string | undefined, now = () => Date.now()): AttachmentService {
  return {
    save: async file => {
      const { value, bytes } = await describe(file);
      const row: LocalAttachment = { sha256: shaOf(value.ref)!, mime: value.mime, size: value.size, name: value.name, bytes, uploaded: false, created_at: now() };
      await local.saveAttachment(row);
      return value;
    },
    open: async value => {
      const sha = shaOf(value.ref);
      if (!sha) return null;
      const stored = await local.getAttachment(sha);
      if (stored) return new Blob([stored.bytes], { type: stored.mime });
      const id = recordId();
      return id && remote?.getAttachment ? await remote.getAttachment(sha, id) : null;
    },
  };
}

export const AttachmentContext = createContext<AttachmentService>(memoryAttachments());
