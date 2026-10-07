/**
 * Offline storage in IndexedDB (persists across reloads and app restarts).
 *
 * Stores: forms, schemas, records (+ multiEntry record index), styles, fonts, lookups, attachments, sync_queue.
 * Filters resolve through the "index_keys" multiEntry index ([form_id, field, value]),
 * never by scanning record data. A filtered search reads at most OFFLINE_CANDIDATE_CAP
 * candidates (from the narrowest filter) and refuses broader searches instead of loading them.
 */
import { decodeCursor, encodeCursor } from "../core/cursor";
import { FormDevError, type FontEntry, type FormRecord, type FormSummary, type LocalAttachment, type LocalRecord, type LookupTable, type RecordPage, type RecordQuery, type RecordStatus, type SchemaVersion, type StyleEntry, type SyncAck } from "../core/types";
import type { IndexKeyFn, LocalDataAdapter, QueueItem, QueueState } from "./DataAdapter";

const DB_VERSION = 3; // 2: lookup tables (Phase 2.3); 3: attachments
const ACTIVE: RecordStatus[] = ["draft", "submitted"];
const OPEN_STATES: QueueState[] = ["pending", "processing", "failed"];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new FormDevError("transaction_aborted", "Local transaction aborted"));
  });
}

/** Most records a filtered offline search may consider; broader filters fail with filter_too_broad_offline. */
export const OFFLINE_CANDIDATE_CAP = 2000;

/** Primary keys of an index range through a key cursor, stopping after `cap`. */
function primaryKeys(index: IDBIndex, range: IDBKeyRange, cap: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const keys: string[] = [];
    const cursor = index.openKeyCursor(range);
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current || keys.length >= cap) return resolve(keys);
      keys.push(current.primaryKey as string);
      current.continue();
    };
  });
}

function inRange(range: IDBKeyRange, key: IDBValidKey): boolean {
  try {
    return range.includes(key);
  } catch {
    return false;
  }
}

const toFormRecord = (record: LocalRecord): FormRecord => ({
  record_id: record.record_id, form_id: record.form_id, schema_version: record.schema_version, status: record.status,
  data: record.data, created_at: record.created_at, created_by: record.created_by, updated_at: record.updated_at,
  updated_by: record.updated_by, sync_id: record.sync_id, version: record.version,
});

export class IndexedDbAdapter implements LocalDataAdapter {
  readonly vendor = "indexeddb";
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(name = "flora-formdev", factory: IDBFactory = indexedDB): Promise<IndexedDbAdapter> {
    const open = factory.open(name, DB_VERSION);
    open.onupgradeneeded = event => {
      const db = open.result;
      if (event.oldVersion < 2) db.createObjectStore("lookups", { keyPath: "lookup_id" });
      if (event.oldVersion < 3) db.createObjectStore("attachments", { keyPath: "sha256" });
      if (event.oldVersion >= 1) return;
      db.createObjectStore("forms", { keyPath: "form_id" });
      db.createObjectStore("schemas", { keyPath: ["form_id", "schema_version"] });
      const records = db.createObjectStore("records", { keyPath: "record_id" });
      records.createIndex("form_updated", ["form_id", "updated_at"]);
      records.createIndex("index_keys", "index_keys", { multiEntry: true });
      db.createObjectStore("styles", { keyPath: "style_id" });
      db.createObjectStore("fonts", { keyPath: "font_id" });
      const queue = db.createObjectStore("sync_queue", { keyPath: "seq", autoIncrement: true });
      queue.createIndex("state", "state");
      queue.createIndex("op_id", "op.op_id", { unique: true });
      queue.createIndex("record", "op.record_id");
    };
    const db = await request(open);
    // Another tab (or a newer app version) needs to upgrade the schema: let it, instead of blocking it forever.
    db.onversionchange = () => db.close();
    return new IndexedDbAdapter(db);
  }

  close(): void {
    this.db.close();
  }

  // Forms and registry cache ---------------------------------------------------------
  async listForms(): Promise<FormSummary[]> {
    const rows = await request(this.db.transaction("forms").objectStore("forms").getAll()) as FormSummary[];
    return rows.sort((a, b) => a.title.localeCompare(b.title) || a.form_id.localeCompare(b.form_id));
  }

  async saveForms(forms: FormSummary[]): Promise<void> {
    const tx = this.db.transaction("forms", "readwrite");
    forms.forEach(form => tx.objectStore("forms").put(form));
    await done(tx);
  }

  async listSchemas(formId: string): Promise<SchemaVersion[]> {
    const range = IDBKeyRange.bound([formId, 0], [formId, Number.MAX_SAFE_INTEGER]);
    return await request(this.db.transaction("schemas").objectStore("schemas").getAll(range)) as SchemaVersion[];
  }

  async getSchema(formId: string, version: number): Promise<SchemaVersion | null> {
    return (await request(this.db.transaction("schemas").objectStore("schemas").get([formId, version])) as SchemaVersion | undefined) || null;
  }

  async saveSchemas(rows: SchemaVersion[]): Promise<void> {
    const tx = this.db.transaction("schemas", "readwrite");
    rows.forEach(row => tx.objectStore("schemas").put(row));
    await done(tx);
  }

  async listStyles(): Promise<StyleEntry[]> {
    return await request(this.db.transaction("styles").objectStore("styles").getAll()) as StyleEntry[];
  }

  async listFonts(): Promise<FontEntry[]> {
    return await request(this.db.transaction("fonts").objectStore("fonts").getAll()) as FontEntry[];
  }

  async saveRegistry(styles: StyleEntry[], fonts: FontEntry[]): Promise<void> {
    const tx = this.db.transaction(["styles", "fonts"], "readwrite");
    styles.forEach(style => tx.objectStore("styles").put(style));
    fonts.forEach(font => tx.objectStore("fonts").put(font));
    await done(tx);
  }

  async getLookup(lookupId: string): Promise<LookupTable | null> {
    return (await request(this.db.transaction("lookups").objectStore("lookups").get(lookupId)) as LookupTable | undefined) ?? null;
  }

  async saveLookups(tables: LookupTable[]): Promise<void> {
    const tx = this.db.transaction("lookups", "readwrite");
    tables.forEach(table => tx.objectStore("lookups").put(table));
    await done(tx);
  }

  // Attachments --------------------------------------------------------------------------
  async saveAttachment(attachment: LocalAttachment): Promise<void> {
    const tx = this.db.transaction("attachments", "readwrite");
    const store = tx.objectStore("attachments");
    const existing = await request(store.get(attachment.sha256)) as LocalAttachment | undefined;
    // Same content, same key: keep an existing row (it may already be uploaded).
    if (!existing) store.put(attachment);
    await done(tx);
  }

  async getAttachment(sha256: string): Promise<LocalAttachment | null> {
    return (await request(this.db.transaction("attachments").objectStore("attachments").get(sha256)) as LocalAttachment | undefined) ?? null;
  }

  async markAttachmentUploaded(sha256: string): Promise<void> {
    const tx = this.db.transaction("attachments", "readwrite");
    const store = tx.objectStore("attachments");
    const row = await request(store.get(sha256)) as LocalAttachment | undefined;
    if (row && !row.uploaded) store.put({ ...row, uploaded: true });
    await done(tx);
  }

  // Records ----------------------------------------------------------------------------
  async getLocalRecord(recordId: string): Promise<LocalRecord | null> {
    return (await request(this.db.transaction("records").objectStore("records").get(recordId)) as LocalRecord | undefined) || null;
  }

  async getRecord(recordId: string): Promise<FormRecord | null> {
    const record = await this.getLocalRecord(recordId);
    return record ? toFormRecord(record) : null;
  }

  async writeRecordAndEnqueue(record: LocalRecord, expectedVersion: number | null, item: QueueItem): Promise<void> {
    const tx = this.db.transaction(["records", "sync_queue"], "readwrite");
    const completion = done(tx);
    const records = tx.objectStore("records");
    const current = await request(records.get(record.record_id)) as LocalRecord | undefined;
    if ((expectedVersion === null && current) || (expectedVersion !== null && current?.version !== expectedVersion)) {
      tx.abort();
      await completion.catch(() => undefined);
      throw new FormDevError(expectedVersion === null ? "record_exists" : "version_conflict", "The local record changed; reload and try again");
    }
    records.put(record);
    tx.objectStore("sync_queue").add(item);
    await completion;
  }

  async mergeServerRecords(rows: FormRecord[], indexKeys: IndexKeyFn): Promise<number> {
    const tx = this.db.transaction("records", "readwrite");
    const completion = done(tx);
    const store = tx.objectStore("records");
    let merged = 0;
    for (const row of rows) {
      const local = await request(store.get(row.record_id)) as LocalRecord | undefined;
      if (!local || (local.sync_state === "synced" && row.version >= local.server_version)) {
        store.put({ ...row, sync_state: "synced", server_version: row.version, index_keys: indexKeys(row) } satisfies LocalRecord);
        merged += 1;
      }
    }
    await completion;
    return merged;
  }

  async searchLocalRecords(query: RecordQuery): Promise<RecordPage<LocalRecord>> {
    const statuses = new Set(query.statuses?.length ? query.statuses : ACTIVE);
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const isAfter = (row: LocalRecord) => !after || row.updated_at < after[0] || (row.updated_at === after[0] && row.record_id < after[1]);
    const tx = this.db.transaction("records");
    const store = tx.objectStore("records");
    let rows: LocalRecord[] = [];

    if (query.filters?.length) {
      const index = store.index("index_keys");
      const ranges = query.filters.map(filter => {
        const key = (value: string | number) => [query.formId, filter.field, value];
        const value = typeof filter.value === "boolean" ? Number(filter.value) : filter.value;
        return filter.op === "eq" ? IDBKeyRange.only(key(value))
          : filter.op === "prefix" ? IDBKeyRange.bound(key(String(value)), key(`${String(value)}\uffff`))
            : typeof value === "number"
              ? filter.op === "gte" ? IDBKeyRange.bound(key(value), key(Number.MAX_VALUE)) : IDBKeyRange.bound(key(-Number.MAX_VALUE), key(value))
              : filter.op === "gte" ? IDBKeyRange.bound(key(value), key("\uffff")) : IDBKeyRange.bound(key(""), key(value));
      });
      // The narrowest filter drives the scan; the others are checked on each candidate's own keys.
      // Nothing loads an unbounded key set: count() first, then a key cursor capped at the limit.
      const counts: number[] = [];
      for (const range of ranges) counts.push(await request(index.count(range)));
      const narrowest = counts.indexOf(Math.min(...counts));
      if (counts[narrowest] > OFFLINE_CANDIDATE_CAP) {
        throw new FormDevError("filter_too_broad_offline", `Every filter matches more than ${OFFLINE_CANDIDATE_CAP} records on this device; narrow the search or search online`, { cap: OFFLINE_CANDIDATE_CAP, matches: counts[narrowest] });
      }
      const candidates = counts[narrowest] ? await primaryKeys(index, ranges[narrowest], OFFLINE_CANDIDATE_CAP) : [];
      const others = ranges.filter((_, position) => position !== narrowest);
      for (const id of new Set(candidates)) {
        const row = await request(store.get(id)) as LocalRecord | undefined;
        if (row && statuses.has(row.status) && isAfter(row) && others.every(range => (row.index_keys ?? []).some(entry => inRange(range, entry)))) rows.push(row);
      }
      rows.sort((a, b) => b.updated_at - a.updated_at || (a.record_id < b.record_id ? 1 : -1));
      rows = rows.slice(0, limit + 1);
    } else {
      const upper = after ? after[0] : Number.MAX_SAFE_INTEGER;
      const range = IDBKeyRange.bound([query.formId, -Number.MAX_SAFE_INTEGER], [query.formId, upper]);
      await new Promise<void>((resolve, reject) => {
        const cursor = store.index("form_updated").openCursor(range, "prev");
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current || rows.length > limit) return resolve();
          const row = current.value as LocalRecord;
          if (statuses.has(row.status) && isAfter(row)) rows.push(row);
          current.continue();
        };
      });
    }
    const page = rows.slice(0, limit);
    return { rows: page, next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
  }

  async searchRecords(query: RecordQuery): Promise<RecordPage> {
    const page = await this.searchLocalRecords(query);
    return { rows: page.rows.map(toFormRecord), next_cursor: page.next_cursor };
  }

  // Sync queue ---------------------------------------------------------------------------
  async listQueue(states?: QueueState[]): Promise<QueueItem[]> {
    const rows = await request(this.db.transaction("sync_queue").objectStore("sync_queue").getAll()) as QueueItem[];
    return states ? rows.filter(row => states.includes(row.state)) : rows;
  }

  async updateQueueItem(item: QueueItem): Promise<void> {
    const tx = this.db.transaction("sync_queue", "readwrite");
    tx.objectStore("sync_queue").put(item);
    await done(tx);
  }

  async recoverQueue(): Promise<number> {
    const tx = this.db.transaction("sync_queue", "readwrite");
    const completion = done(tx);
    const store = tx.objectStore("sync_queue");
    const stuck = await request(store.index("state").getAll("processing")) as QueueItem[];
    stuck.forEach(item => store.put({ ...item, state: "pending", updated_at: Date.now() }));
    await completion;
    return stuck.length;
  }

  async applyAck(item: QueueItem, ack: SyncAck, indexKeys: IndexKeyFn): Promise<void> {
    const tx = this.db.transaction(["sync_queue", "records"], "readwrite");
    const completion = done(tx);
    const queue = tx.objectStore("sync_queue");
    const records = tx.objectStore("records");
    const sameRecord = (await request(queue.index("record").getAll(item.op.record_id)) as QueueItem[])
      .filter(other => (other.seq ?? 0) > (item.seq ?? 0) && OPEN_STATES.includes(other.state))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const local = await request(records.get(item.op.record_id)) as LocalRecord | undefined;
    const now = Date.now();
    // A caller who may not read the form gets the record's identity and versions without data: keep the device's
    // own copy of the data and settle the versions only.
    const raw = ack.record as Record<string, unknown> | undefined;
    const server = raw && !("data" in raw) && local ? ({ ...local, ...raw, data: local.data } as unknown as typeof ack.record) : ack.record;

    if (ack.status === "applied" && server) {
      queue.put({ ...item, state: "success", ack, last_error: null, updated_at: now });
      if (sameRecord.length) {
        // Later ops were built on this op's result: rebase the next one on the server version.
        queue.put({ ...sameRecord[0], op: { ...sameRecord[0].op, base_version: server.version }, updated_at: now });
        if (local) records.put({ ...local, server_version: server.version, version: Math.max(local.version, server.version) });
      } else {
        records.put({ ...server, sync_state: "synced", server_version: server.version, index_keys: local?.index_keys ?? indexKeys(server) });
      }
    } else if (ack.status === "conflict" && server) {
      queue.put({ ...item, state: "conflict", ack, last_error: ack.conflict?.reason ?? "conflict", updated_at: now });
      sameRecord.forEach(other => queue.put({ ...other, state: "conflict", last_error: "superseded by the server copy", updated_at: now }));
      records.put({ ...server, sync_state: "conflict", server_version: server.version, index_keys: indexKeys(server) });
    } else {
      queue.put({ ...item, state: "failed", ack, last_error: ack.error?.message ?? "rejected by server", updated_at: now });
      if (local) records.put({ ...local, sync_state: "error" });
    }
    await completion;
  }
}
