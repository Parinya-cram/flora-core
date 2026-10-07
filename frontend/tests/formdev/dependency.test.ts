/** Phase 2.3 dependency: the TypeScript engine runs the same fixture as the Python engine; the renderer offers the
 * evaluated options, and lookup tables are cached in IndexedDB for offline saves. */
import { IDBFactory } from "fake-indexeddb";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFormDevClient, IndexedDbAdapter, type FormDefinition, type LookupTable, type SchemaVersion } from "../../src/formdev";
import { evaluateRecord, type Evaluation } from "../../src/formdev/logic/evaluate";
import { deriveValue, lookupIds, lookupOptions } from "../../src/formdev/logic/lookup";
import { pullCatalog } from "../../src/formdev/offline/FormSync";
import FormRenderer from "../../src/formdev/ui/FormRenderer";
import { FakeServer, fonts, loadJson, styles } from "./helpers";

type Case = { name: string; status: string; data: Record<string, unknown>; lookups: boolean;
  expect: { data: Record<string, unknown>; codes: string[]; paths: string[]; hidden: string[]; options: Evaluation["options"] } };
const fixture = loadJson<{ definition: string; lookups: Record<string, string>; today: string; cases: Case[] }>("spec/fixtures/dependency-cases.json");
const definition = loadJson<FormDefinition>(fixture.definition);
const table = loadJson<LookupTable>(fixture.lookups.thai_address);
const lookups = { thai_address: table.entries };
const schemaRow = (form: FormDefinition): SchemaVersion => ({ form_id: form.form_id, schema_version: form.schema_version, status: "published", definition: form, checksum: "t" });

describe("dependency fixtures", () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const result = evaluateRecord(definition, testCase.data, testCase.status, fixture.today, testCase.lookups ? lookups : {});
      expect(result.data).toEqual(testCase.expect.data);
      expect(result.issues.map(item => item.code).sort()).toEqual(testCase.expect.codes);
      expect(result.issues.map(item => item.path).sort()).toEqual(testCase.expect.paths);
      expect(result.hidden).toEqual(testCase.expect.hidden);
      expect(result.options).toEqual(testCase.expect.options);
    });
  }

  it("helpers match the server's", () => {
    const valueOf = (key: string) => ({ province: "เชียงใหม่", subdistrict: "ตำบลสันทรายหลวง" } as Record<string, string>)[key] ?? null;
    expect(lookupOptions(table.entries, { value: "district", filter: { province: "province" } }, valueOf).map(option => option.value)).toEqual(["อำเภอเมืองเชียงใหม่", "อำเภอสันทราย"]);
    expect(deriveValue(table.entries, { column: "postcode", match: { subdistrict: "subdistrict" } }, valueOf)).toBe("50210");
    expect([...lookupIds(definition)]).toEqual(["thai_address"]);
  });
});

describe("renderer offers the evaluated options", () => {
  const render = (value: Record<string, unknown>, tables = lookups) =>
    renderToStaticMarkup(createElement(FormRenderer, { definition, value: value as never, lookups: tables, mode: "desktop", onChange: () => undefined }));

  it("districts of the chosen province only, postcode derived and read-only", () => {
    const html = render({ province: "เชียงใหม่", district: "อำเภอสันทราย", subdistrict: "ตำบลสันทรายหลวง" });
    const district = html.slice(html.indexOf('data-field="district"'), html.indexOf('data-field="subdistrict"'));
    expect(district).toContain("อำเภอสันทราย");
    expect(district).not.toContain("อำเภอกะทู้");
    expect(html).toMatch(/data-field="postcode"[^]*?<input[^>]*disabled[^>]*value="50210"|data-field="postcode"[^]*?<input[^>]*value="50210"[^>]*disabled/);
  });

  it("conditional options follow the scheme", () => {
    const benefits = (scheme: string) => { const html = render({ scheme }); return html.slice(html.indexOf('data-field="benefits"')); };
    expect(benefits("sss")).toContain("ทันตกรรม");
    expect(benefits("uc")).not.toContain("ทันตกรรม");
    expect(benefits("self")).toContain("ส่วนลดชำระเงินสด");
  });

  it("without the table the current value still shows", () => {
    const html = render({ province: "เชียงใหม่" }, {} as typeof lookups);
    expect(html.slice(html.indexOf('data-field="province"'), html.indexOf('data-field="district"'))).toContain("เชียงใหม่");
  });
});

describe("lookup tables offline", () => {
  async function deviceWithTable(withTable: boolean) {
    const local = await IndexedDbAdapter.open(`dep-${Math.random()}`, new IDBFactory());
    await local.saveRegistry(styles, fonts);
    await local.saveSchemas([schemaRow(definition)]);
    await local.saveForms([{ form_id: definition.form_id, title: definition.title, latest_version: 1, published_version: 1, updated_at: 0 }]);
    if (withTable) await local.saveLookups([table]);
    let ids = 0;
    const client = createFormDevClient(local, new FakeServer(), { user: () => "nurse1", now: () => 1, newId: () => `dep-record-${(ids += 1)}`,
      sync: { now: () => 1, random: () => 1, isOnline: () => false } });
    return { local, client };
  }

  it("an offline save clears what the table does not offer and derives the postcode", async () => {
    const { client } = await deviceWithTable(true);
    const saved = await client.records.create(definition.form_id, { hn: "HN1", scheme: "uc", province: "เชียงใหม่", district: "อำเภอสันทราย", subdistrict: "ตำบลสันทรายหลวง", postcode: "0" });
    expect(saved.data.postcode).toBe("50210");
    const moved = await client.records.create(definition.form_id, { hn: "HN2", scheme: "uc", province: "ภูเก็ต", district: "อำเภอสันทราย" });
    expect(moved.data.district).toBeUndefined();
  });

  it("without a cached table the save keeps the values for the server to check", async () => {
    const { client } = await deviceWithTable(false);
    const saved = await client.records.create(definition.form_id, { hn: "HN1", scheme: "uc", province: "ภูเก็ต", district: "อำเภอสันทราย", postcode: "0" });
    expect([saved.data.district, saved.data.postcode]).toEqual(["อำเภอสันทราย", "0"]);
  });

  it("a version 1 database gains the lookup store and keeps its data", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open("old-device", 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore("forms", { keyPath: "form_id" }).put({ form_id: "kept", title: "Kept", latest_version: 1, published_version: 1, updated_at: 0 });
        for (const name of ["schemas", "records", "styles", "fonts", "sync_queue"]) db.createObjectStore(name, { keyPath: name === "schemas" ? ["form_id", "schema_version"] : "id" });
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const local = await IndexedDbAdapter.open("old-device", factory);
    expect((await local.listForms()).map(form => form.form_id)).toEqual(["kept"]);
    await local.saveLookups([table]);
    expect((await local.getLookup("thai_address"))?.entries.length).toBe(table.entries.length);
  });

  it("pulling the catalog downloads the tables the forms read", async () => {
    const local = await IndexedDbAdapter.open(`pull-${Math.random()}`, new IDBFactory());
    const server = new FakeServer();
    server.lookups.set("thai_address", table);
    server.listForms = async () => [{ form_id: definition.form_id, title: definition.title, latest_version: 1, published_version: 1, updated_at: 0 }];
    server.listSchemas = async () => [schemaRow(definition)];
    const result = await pullCatalog(server, local);
    expect(result.lookups).toBe(1);
    expect((await local.getLookup("thai_address"))?.version).toBe(1);
  });
});

describe("edits keep the record as the engine leaves it", () => {
  it("a district cleared by a province change does not come back when the province is switched back", async () => {
    const { changeRecord } = await import("../../src/formdev/ui/renderUtils");
    let data = changeRecord(definition, { hn: "HN1", province: "เชียงใหม่" }, "district", "อำเภอสันทราย", lookups) as Record<string, never>;
    data = changeRecord(definition, data, "subdistrict", "ตำบลสันทรายหลวง", lookups) as Record<string, never>;
    expect(data.postcode).toBe("50210");
    data = changeRecord(definition, data, "province", "ภูเก็ต", lookups) as Record<string, never>;
    expect([data.district, data.subdistrict, data.postcode]).toEqual([undefined, undefined, undefined]);
    data = changeRecord(definition, data, "province", "เชียงใหม่", lookups) as Record<string, never>;
    expect(data.district).toBeUndefined();
  });
});
