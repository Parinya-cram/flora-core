import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { createFormDevClient, IndexedDbAdapter, type FormDefinition, type FormRecord, type LookupTable, type RemoteDataAdapter, type SchemaVersion, type SyncAck, type SyncOp } from "../../src/formdev";
import type { SyncOptions } from "../../src/formdev/offline/SyncEngine";

export function loadJson<T = unknown>(relative: string): T {
  return JSON.parse(readFileSync(new URL(`../../../formdev/${relative}`, import.meta.url), "utf-8")) as T;
}

export const example = (version: number) => loadJson<FormDefinition>(`examples/patient-assessment/v${version}.form.json`);
export const styles = loadJson<Array<{ style_id: string; version: number; definition: Record<string, never> }>>("registry/styles.json");
export const fonts = loadJson<Array<{ font_id: string; metadata: Record<string, never> }>>("registry/fonts.json");

export const schemaRow = (definition: FormDefinition): SchemaVersion => ({
  form_id: definition.form_id, schema_version: definition.schema_version, status: "published", definition, checksum: `test-${definition.schema_version}`,
});

export const submittedData = (overrides: Record<string, string | number> = {}) => ({ hn: "HN0001", full_name: "Test Patient", assessed_at: "2026-10-05T08:30:00+07:00", ...overrides });

/** Minimal in-memory server with the same rules as SyncService: receipts, versions, last-write-wins. */
export class FakeServer implements RemoteDataAdapter {
  readonly vendor = "fake";
  records = new Map<string, FormRecord>();
  receipts = new Map<string, SyncAck>();
  revisions = new Map<string, number>();
  pushes: SyncOp[][] = [];
  failNext = 0;
  failWith: Error = new TypeError("network down");

  async listForms() { return []; }
  async listSchemas() { return []; }
  async getSchema() { return null; }
  async getRecord(id: string) { return this.records.get(id) ?? null; }
  async searchRecords() { return { rows: [], next_cursor: null }; }
  async listStyles() { return []; }
  async listFonts() { return []; }
  readonly lookups = new Map<string, LookupTable>();
  async getLookup(lookupId: string) { return this.lookups.get(lookupId) ?? null; }

  private write(op: SyncOp, version: number, existing?: FormRecord): FormRecord {
    const record: FormRecord = {
      record_id: op.record_id, form_id: op.form_id, schema_version: op.schema_version, status: op.status, data: op.data,
      created_at: existing?.created_at ?? op.client_updated_at, created_by: existing?.created_by ?? "client",
      updated_at: op.client_updated_at, updated_by: "client", sync_id: op.op_id, version,
    };
    this.records.set(op.record_id, record);
    this.revisions.set(op.record_id, (this.revisions.get(op.record_id) ?? 0) + 1);
    return record;
  }

  /** Simulates another user's edit on the server. */
  editOnServer(recordId: string, data: Record<string, string>, updatedAt: number) {
    const current = this.records.get(recordId)!;
    this.records.set(recordId, { ...current, data, updated_at: updatedAt, version: current.version + 1, updated_by: "other" });
  }

  async pushOps(ops: SyncOp[]): Promise<SyncAck[]> {
    this.pushes.push(ops);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw this.failWith;
    }
    return ops.map(op => {
      const receipt = this.receipts.get(op.op_id);
      if (receipt) return { ...receipt, duplicate: true };
      const current = this.records.get(op.record_id);
      let ack: SyncAck;
      if (op.data && "reject_me" in op.data) ack = { op_id: op.op_id, status: "rejected", error: { code: "invalid_record", message: "rejected by test" } };
      else if (!current) ack = op.kind === "create" ? { op_id: op.op_id, status: "applied", record: this.write(op, 1) } : { op_id: op.op_id, status: "rejected", error: { code: "record_not_found", message: "missing" } };
      else if (current.version === op.base_version) ack = { op_id: op.op_id, status: "applied", record: this.write(op, current.version + 1, current) };
      else if (op.client_updated_at > current.updated_at) ack = { op_id: op.op_id, status: "applied", record: this.write(op, current.version + 1, current), conflict: { strategy: "last-write-wins", resolution: "local_wins", base_version: op.base_version, server_version: current.version, reason: "local edit is newer" } };
      else ack = { op_id: op.op_id, status: "conflict", record: current, conflict: { strategy: "last-write-wins", resolution: "remote_wins", base_version: op.base_version, server_version: current.version, reason: "server copy is newer or equal" } };
      this.receipts.set(op.op_id, ack);
      return ack;
    });
  }
}

let databaseCounter = 0;

/** A fresh device: its own IndexedDB with the example form (v1, optionally v2) installed. */
export async function device(options: { versions?: number[]; factory?: IDBFactory; name?: string; server?: FakeServer; sync?: SyncOptions; clock?: { now: number } } = {}) {
  const factory = options.factory ?? new IDBFactory();
  const name = options.name ?? `formdev-test-${(databaseCounter += 1)}`;
  const local = await IndexedDbAdapter.open(name, factory);
  const versions = options.versions ?? [1];
  await local.saveRegistry(styles, fonts);
  await local.saveSchemas(versions.map(version => schemaRow(example(version))));
  await local.saveForms([{ form_id: "patient_assessment", title: "แบบประเมินผู้ป่วย", latest_version: Math.max(...versions), published_version: Math.max(...versions), updated_at: 0 }]);
  const server = options.server ?? new FakeServer();
  const clock = options.clock ?? { now: 1_800_000_000_000 };
  let ids = 0;
  const client = createFormDevClient(local, server, {
    user: () => "nurse1",
    now: () => clock.now,
    newId: () => `${name}-${String((ids += 1)).padStart(4, "0")}`.replace(/[^A-Za-z0-9-]/g, "-"),
    sync: { now: () => clock.now, random: () => 1, isOnline: () => true, baseDelayMs: 1000, maxAttempts: 3, ...options.sync },
  });
  await client.records.prepare(["patient_assessment"]);
  return { local, server, client, clock, factory, name };
}
