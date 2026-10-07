/** FormDev client engine: offline-first repositories over a local adapter plus server sync. */
import type { LocalDataAdapter, RemoteDataAdapter } from "./data/DataAdapter";
import { pullCatalog, pullRecords } from "./offline/FormSync";
import { SyncEngine, type SyncOptions } from "./offline/SyncEngine";
import { FormRepository, RecordRepository, SchemaRepository, StyleRepository, type RepositoryOptions } from "./repositories";

export type FormDevClient = {
  forms: FormRepository;
  schemas: SchemaRepository;
  records: RecordRepository;
  styles: StyleRepository;
  sync: SyncEngine;
  /** Refresh the offline catalog and server records; returns false when the server is unreachable. */
  pull: (formIds?: string[]) => Promise<boolean>;
  /** Load installed definitions, recover the queue and start background sync (works offline). */
  start: () => Promise<void>;
};

export function createFormDevClient(local: LocalDataAdapter, remote: RemoteDataAdapter, options: RepositoryOptions & { sync?: SyncOptions }): FormDevClient {
  const schemas = new SchemaRepository(local);
  const records = new RecordRepository(local, schemas, options);
  const forms = new FormRepository(local);
  const sync = new SyncEngine(local, remote, records.indexKeys, options.sync);
  const pull = async (formIds?: string[]) => {
    try {
      await pullCatalog(remote, local);
      const ids = formIds ?? (await forms.list()).map(form => form.form_id);
      await records.prepare(ids);
      for (const formId of ids) await pullRecords(remote, local, records, formId);
      return true;
    } catch {
      return false;
    }
  };
  const start = async () => {
    await records.prepare((await forms.list()).map(form => form.form_id));
    await sync.start();
  };
  return { forms, schemas, records, styles: new StyleRepository(local), sync, pull, start };
}

export * from "./core/types";
export { validateDefinition, validateRecord } from "./core/validate";
export { migrate } from "./core/migrate";
export { IndexedDbAdapter } from "./data/IndexedDbAdapter";
export { RestApiAdapter, TransportError } from "./data/RestApiAdapter";
export type { LocalDataAdapter, RemoteDataAdapter, QueueItem, QueueState } from "./data/DataAdapter";
