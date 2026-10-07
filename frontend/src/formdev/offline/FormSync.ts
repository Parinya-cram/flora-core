/** Pull side: install published forms, the registry and server records into local storage. */
import type { LocalDataAdapter, RemoteDataAdapter } from "../data/DataAdapter";
import type { LookupTable } from "../core/types";
import { lookupIds } from "../logic/lookup";
import type { RecordRepository } from "../repositories";

/** Download every form, its published versions, the style/font registry and the lookup tables the forms read,
 * for offline use. */
export async function pullCatalog(remote: RemoteDataAdapter, local: LocalDataAdapter): Promise<{ forms: number; versions: number; lookups: number }> {
  const [forms, styles, fonts] = await Promise.all([remote.listForms(), remote.listStyles(), remote.listFonts()]);
  await local.saveRegistry(styles, fonts);
  let versions = 0;
  const lookupsUsed = new Set<string>();
  for (const form of forms) {
    // Only published versions are usable for records; drafts stay on the server.
    const published = (await remote.listSchemas(form.form_id)).filter(row => row.status !== "draft");
    await local.saveSchemas(published);
    versions += published.length;
    published.forEach(row => lookupIds(row.definition).forEach(id => lookupsUsed.add(id)));
  }
  const tables = (await Promise.all([...lookupsUsed].sort().map(id => remote.getLookup(id)))).filter((table): table is LookupTable => table !== null);
  await local.saveLookups(tables);
  await local.saveForms(forms.filter(form => form.published_version));
  return { forms: forms.length, versions, lookups: tables.length };
}

/** Merge server records of one form into local storage, newest first, bounded by maxPages. */
export async function pullRecords(remote: RemoteDataAdapter, local: LocalDataAdapter, records: RecordRepository, formId: string, maxPages = 5): Promise<number> {
  await records.prepare([formId]);
  let cursor: string | null = null;
  let merged = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await remote.searchRecords({ formId, statuses: ["draft", "submitted"], cursor, limit: 100 });
    merged += await local.mergeServerRecords(result.rows, records.indexKeys);
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  return merged;
}
