/** Keyset cursor "updated_at:record_id" in base64url; same format as the server. */
import { FormDevError } from "./types";

const RECORD_ID = /^[A-Za-z0-9-]{8,64}$/;

export function encodeCursor(row: { updated_at: number; record_id: string }): string {
  return btoa(`${row.updated_at}:${row.record_id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string): [number, string] {
  try {
    const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const split = raw.indexOf(":");
    const updatedAt = Number(raw.slice(0, split));
    const recordId = raw.slice(split + 1);
    if (split < 1 || !Number.isInteger(updatedAt) || !RECORD_ID.test(recordId)) throw new Error("bad cursor");
    return [updatedAt, recordId];
  } catch {
    throw new FormDevError("invalid_cursor", "Pagination cursor is not valid");
  }
}
