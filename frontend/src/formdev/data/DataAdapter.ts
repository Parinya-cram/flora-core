/**
 * Storage contracts used by the FormDev engine. Repositories depend on these interfaces
 * only; they never see IndexedDB, fetch or a server database.
 */
import type { FontEntry, FormRecord, FormSummary, LocalAttachment, LocalRecord, LookupTable, RecordPage, RecordQuery, SchemaVersion, StyleEntry, SyncAck, SyncOp } from "../core/types";

/** Computes index keys for a server copy; supplied by the repository, which knows the form definition. */
export type IndexKeyFn = (record: FormRecord) => LocalRecord["index_keys"];

/** Read side shared by every adapter. */
export interface DataAdapter {
  readonly vendor: string;
  listForms(): Promise<FormSummary[]>;
  listSchemas(formId: string): Promise<SchemaVersion[]>;
  getSchema(formId: string, version: number): Promise<SchemaVersion | null>;
  getRecord(recordId: string): Promise<FormRecord | null>;
  searchRecords(query: RecordQuery): Promise<RecordPage>;
  listStyles(): Promise<StyleEntry[]>;
  listFonts(): Promise<FontEntry[]>;
  /** A lookup table (Phase 2.3), or null when it is not registered / not cached. */
  getLookup(lookupId: string): Promise<LookupTable | null>;
}

export type QueueState = "pending" | "processing" | "success" | "failed" | "conflict";

export type QueueItem = {
  seq?: number;
  op: SyncOp;
  state: QueueState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  ack: SyncAck | null;
  created_at: number;
  updated_at: number;
};

/** Offline store: a writable cache of forms plus records and the durable sync queue. */
export interface LocalDataAdapter extends DataAdapter {
  saveForms(forms: FormSummary[]): Promise<void>;
  saveSchemas(rows: SchemaVersion[]): Promise<void>;
  saveRegistry(styles: StyleEntry[], fonts: FontEntry[]): Promise<void>;
  saveLookups(tables: LookupTable[]): Promise<void>;
  /** Files of file / image fields, kept until sync has uploaded them. */
  saveAttachment(attachment: LocalAttachment): Promise<void>;
  getAttachment(sha256: string): Promise<LocalAttachment | null>;
  markAttachmentUploaded(sha256: string): Promise<void>;
  getLocalRecord(recordId: string): Promise<LocalRecord | null>;
  searchLocalRecords(query: RecordQuery): Promise<RecordPage<LocalRecord>>;
  /** Write the record and enqueue its op in ONE transaction, so a change is never saved without its sync op. */
  writeRecordAndEnqueue(record: LocalRecord, expectedVersion: number | null, item: QueueItem): Promise<void>;
  /** Store server copies (pull) without queueing anything. Local pending edits are kept. */
  mergeServerRecords(records: FormRecord[], indexKeys: IndexKeyFn): Promise<number>;
  listQueue(states?: QueueState[]): Promise<QueueItem[]>;
  updateQueueItem(item: QueueItem): Promise<void>;
  /** Apply a server acknowledgement atomically to the queue item, the local record and later ops. */
  applyAck(item: QueueItem, ack: SyncAck, indexKeys: IndexKeyFn): Promise<void>;
  /** After a crash or reload, ops left in "processing" go back to "pending" (the server is idempotent). */
  recoverQueue(): Promise<number>;
}

/** Server side reached over the network. Writes go through idempotent sync operations. */
export interface RemoteDataAdapter extends DataAdapter {
  pushOps(ops: SyncOp[]): Promise<SyncAck[]>;
  /** Upload a file's bytes (idempotent; the server checks the hash). Remotes without file storage omit it. */
  putAttachment?(sha256: string, bytes: ArrayBuffer, mime: string): Promise<void>;
  /** A file of a record the caller may read. */
  getAttachment?(sha256: string, recordId: string): Promise<Blob | null>;
}
