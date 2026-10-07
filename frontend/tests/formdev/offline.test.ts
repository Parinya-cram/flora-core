/** Local (offline) storage: CRUD, draft/submit, search, persistence, atomic queueing. */
import { describe, expect, it } from "vitest";
import { IndexedDbAdapter, type FormDevError, type FormRecord } from "../../src/formdev";
import { OFFLINE_CANDIDATE_CAP } from "../../src/formdev/data/IndexedDbAdapter";
import { device, example, schemaRow, submittedData } from "./helpers";

describe("offline records in IndexedDB", () => {
  it("creates, updates, submits and deletes without a server", async () => {
    const { client, local } = await device();
    const draft = await client.records.create("patient_assessment", { hn: "HN1" });
    expect([draft.version, draft.status, draft.sync_state]).toEqual([1, "draft", "pending"]);

    const updated = await client.records.update(draft.record_id, { hn: "HN1", age: 41 }, 1);
    await expect(client.records.submit(draft.record_id, { hn: "HN1" }, 2)).rejects.toMatchObject({ code: "invalid_record" });
    const submitted = await client.records.submit(draft.record_id, submittedData({ hn: "HN1" }), updated.version);
    expect([submitted.status, submitted.version]).toEqual(["submitted", 3]);
    const deleted = await client.records.remove(draft.record_id, 3);
    expect(deleted.status).toBe("deleted");

    const queue = await local.listQueue();
    expect(queue.map(item => [item.op.kind, item.op.base_version, item.state])).toEqual([
      ["create", 0, "pending"], ["update", 1, "pending"], ["submit", 2, "pending"], ["delete", 3, "pending"],
    ]);
    expect((await client.records.search({ formId: "patient_assessment" })).rows).toEqual([]);
    expect((await client.records.search({ formId: "patient_assessment", statuses: ["deleted"] })).rows).toHaveLength(1);
  });

  it("rejects invalid data and stale versions without queueing anything", async () => {
    const { client, local } = await device();
    await expect(client.records.create("patient_assessment", { age: "old" })).rejects.toMatchObject({ code: "invalid_record" });
    const record = await client.records.create("patient_assessment", { hn: "HN1" });
    await client.records.update(record.record_id, { hn: "HN2" }, 1);
    await expect(client.records.update(record.record_id, { hn: "HN3" }, 1)).rejects.toMatchObject({ code: "version_conflict" });
    expect(await local.listQueue()).toHaveLength(2);
    expect((await client.records.get(record.record_id)).data).toEqual({ hn: "HN2" });
  });

  it("searches through the local record index", async () => {
    const { client } = await device();
    for (const [hn, age, risk] of [["HN100", 30, "no"], ["HN101", 70, "yes"], ["HX200", 80, "yes"]] as const) {
      await client.records.create("patient_assessment", { hn, age, fall_risk: risk });
    }
    const hns = async (filters: Parameters<typeof client.records.search>[0]["filters"]) =>
      (await client.records.search({ formId: "patient_assessment", filters })).rows.map(row => row.data.hn).sort();
    expect(await hns([{ field: "hn", op: "eq", value: "HN101" }])).toEqual(["HN101"]);
    expect(await hns([{ field: "hn", op: "prefix", value: "HN1" }])).toEqual(["HN100", "HN101"]);
    expect(await hns([{ field: "age", op: "gte", value: "70" }])).toEqual(["HN101", "HX200"]);
    expect(await hns([{ field: "fall_risk", op: "eq", value: "yes" }, { field: "age", op: "lte", value: 75 }])).toEqual(["HN101"]);
    await expect(hns([{ field: "full_name", op: "eq", value: "x" }])).rejects.toMatchObject({ code: "field_not_indexed" });
  });

  it("paginates with a stable keyset cursor", async () => {
    const { client, clock } = await device();
    const created = new Set<string>();
    for (let n = 0; n < 7; n += 1) {
      clock.now = 1_800_000_000_000 + Math.floor(n / 2);
      created.add((await client.records.create("patient_assessment", { hn: `HN${n}` })).record_id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await client.records.search({ formId: "patient_assessment", cursor, limit: 3 });
      seen.push(...page.rows.map(row => row.record_id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen)).toEqual(created);
    expect(seen).toHaveLength(7);
  });

  it("keeps records and the sync queue after the app is closed", async () => {
    const first = await device();
    const record = await first.client.records.create("patient_assessment", { hn: "KEEP" });
    first.local.close();
    const reopened = await IndexedDbAdapter.open(first.name, first.factory);
    expect((await reopened.getLocalRecord(record.record_id))?.data).toEqual({ hn: "KEEP" });
    expect((await reopened.listQueue()).map(item => item.state)).toEqual(["pending"]);
    reopened.close();
  });

  it("reads old records through the migration chain without rewriting them", async () => {
    const { client, local } = await device({ versions: [1] });
    const record = await client.records.create("patient_assessment", { hn: "HN7", bp: 140, weight: "70", fall_risk: "no", smoker: true });
    await local.saveSchemas([{ form_id: "patient_assessment", schema_version: 2, status: "published", definition: example(2), checksum: "v2" }]);
    const view = await client.records.get(record.record_id, 2);
    expect(view.data).toMatchObject({ bp_sys: 140, weight_kg: 70, fall_risk_level: "low", _retired: { smoker: true } });
    expect((await client.records.get(record.record_id)).data).toEqual({ hn: "HN7", bp: 140, weight: "70", fall_risk: "no", smoker: true });
  });

  it("rejects fields that are not part of the form version", async () => {
    const { client } = await device();
    const error = await client.records.create("patient_assessment", { unknown: "x" }).catch((caught: FormDevError) => caught);
    expect(error).toMatchObject({ code: "invalid_record" });
  });

  it("filters datetimes by instant across offsets", async () => {
    const { client } = await device();
    const times = { A: "2026-10-05T08:30:00+07:00", B: "2026-10-05T02:00:00Z", C: "2026-10-05T10:00", D: "2026-10-04T23:00:00-05:00" };
    for (const [hn, assessedAt] of Object.entries(times)) await client.records.create("patient_assessment", { hn, assessed_at: assessedAt });
    const hns = async (filters: Parameters<typeof client.records.search>[0]["filters"]) =>
      (await client.records.search({ formId: "patient_assessment", filters })).rows.map(row => row.data.hn).sort();
    // 01:45Z .. 03:30Z: B (02:00Z) and C (10:00 Bangkok = 03:00Z); a text comparison would pick neither.
    expect(await hns([{ field: "assessed_at", op: "gte", value: "2026-10-05T08:45:00+07:00" }, { field: "assessed_at", op: "lte", value: "2026-10-05T03:30:00Z" }])).toEqual(["B", "C"]);
    expect(await hns([{ field: "assessed_at", op: "gte", value: "2026-10-05T10:30:00+07:00" }])).toEqual(["D"]);
    expect(await hns([{ field: "assessed_at", op: "eq", value: "2026-10-05T01:30:00.000Z" }])).toEqual(["A"]);
    await expect(hns([{ field: "assessed_at", op: "gte", value: "yesterday" }])).rejects.toMatchObject({ code: "invalid_filter" });
    await expect(hns([{ field: "assessed_at", op: "prefix", value: "2026-10" }])).rejects.toMatchObject({ code: "invalid_filter" });
    const record = (await client.records.search({ formId: "patient_assessment", filters: [{ field: "hn", op: "eq", value: "A" }] })).rows[0];
    expect(record.index_keys).toContainEqual(["patient_assessment", "assessed_at", Date.UTC(2026, 9, 5, 1, 30)]);
  });

  it("filters indexed calculated fields as numbers", async () => {
    const { client, local } = await device();
    const definition = example(1);
    definition.sections[0].fields.push({ id: "bmi", type: "calculated", label: "BMI", formula: "weight / (height * height)", readonly: true, indexed: true });
    await local.saveSchemas([schemaRow(definition)]);
    await client.records.prepare(["patient_assessment"]);
    const rows: FormRecord[] = [["HN1", 19.5], ["HN2", 25], ["HN3", 31.2]].map(([hn, bmi], n) => ({
      record_id: `rec-bmi-${n}`, form_id: "patient_assessment", schema_version: 1, status: "submitted", data: { hn, bmi }, created_at: 1000 + n,
      created_by: "server", updated_at: 1000 + n, updated_by: "server", sync_id: null, version: 1,
    }));
    await local.mergeServerRecords(rows, client.records.indexKeys);
    const hns = async (filters: Parameters<typeof client.records.search>[0]["filters"]) =>
      (await client.records.search({ formId: "patient_assessment", filters })).rows.map(row => row.data.hn).sort();
    expect(await hns([{ field: "bmi", op: "gte", value: 25 }])).toEqual(["HN2", "HN3"]);
    expect(await hns([{ field: "bmi", op: "gte", value: "25" }])).toEqual(["HN2", "HN3"]);
    expect(await hns([{ field: "bmi", op: "lte", value: 25 }])).toEqual(["HN1", "HN2"]);
    expect(await hns([{ field: "bmi", op: "eq", value: 31.2 }])).toEqual(["HN3"]);
    await expect(hns([{ field: "bmi", op: "prefix", value: "2" }])).rejects.toMatchObject({ code: "invalid_filter" });
    await expect(hns([{ field: "bmi", op: "gte", value: "high" }])).rejects.toMatchObject({ code: "invalid_filter" });
  });

  it("refuses offline searches whose narrowest filter matches more than the cap", async () => {
    const { client, local } = await device();
    const total = 2500;
    const rows: FormRecord[] = Array.from({ length: total }, (_, n) => ({
      record_id: `rec-${String(n).padStart(5, "0")}`, form_id: "patient_assessment", schema_version: 1, status: "submitted",
      data: { hn: `HN${String(n).padStart(4, "0")}`, fall_risk: "yes", age: n % 100 }, created_at: 1000 + n, created_by: "server",
      updated_at: 1000 + n, updated_by: "server", sync_id: null, version: 1,
    }));
    expect(await local.mergeServerRecords(rows, client.records.indexKeys)).toBe(total);
    expect(total).toBeGreaterThan(OFFLINE_CANDIDATE_CAP);

    const search = (filters: Parameters<typeof client.records.search>[0]["filters"], limit = 50) => client.records.search({ formId: "patient_assessment", filters, limit });
    await expect(search([{ field: "fall_risk", op: "eq", value: "yes" }])).rejects.toMatchObject({ code: "filter_too_broad_offline" });
    await expect(search([{ field: "age", op: "gte", value: 0 }])).rejects.toMatchObject({ code: "filter_too_broad_offline" });
    // A narrow conjunct drives the scan, so the broad one no longer matters.
    expect((await search([{ field: "fall_risk", op: "eq", value: "yes" }, { field: "hn", op: "eq", value: "HN0007" }])).rows.map(row => row.record_id)).toEqual(["rec-00007"]);
    const prefixed = await search([{ field: "hn", op: "prefix", value: "HN00" }, { field: "age", op: "gte", value: 50 }], 200);
    expect(prefixed.rows.map(row => row.data.hn)).toEqual(Array.from({ length: 50 }, (_, n) => `HN00${99 - n}`));
    expect(prefixed.next_cursor).toBeNull();
    expect((await search([{ field: "hn", op: "eq", value: "nobody" }, { field: "fall_risk", op: "eq", value: "yes" }])).rows).toEqual([]);
    // Unfiltered browsing pages through the time index and is not capped.
    expect((await client.records.search({ formId: "patient_assessment", statuses: ["submitted"], limit: 5 })).rows).toHaveLength(5);
  });
});
