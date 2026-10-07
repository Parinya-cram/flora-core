/** Attachments on the client: hashing (with the no-Web-Crypto fallback), device storage, upload before sync. */
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { attachmentRefs, shaOf } from "../../src/formdev/core/attachments";
import { sha256, sha256Sync } from "../../src/formdev/core/sha256";
import type { FormDefinition, SchemaVersion, SyncOp } from "../../src/formdev/core/types";
import { createFormDevClient, IndexedDbAdapter } from "../../src/formdev";
import { deviceAttachments, memoryAttachments } from "../../src/formdev/ui/attachments";
import { FakeServer, fonts, styles } from "./helpers";

const bytes = (text: string) => new TextEncoder().encode(text);
const FORM: FormDefinition = {
  format: "flora.form/1", form_id: "wound_photo", schema_version: 1, title: "Wound photo", paper: "A4", style_id: "style.a4.medical",
  sections: [{ id: "main", title: "Main", fields: [{ id: "hn", type: "text", label: "HN" }, { id: "photo", type: "image", label: "Photo", multiple: true }] }],
};

describe("sha256", () => {
  it("matches the FIPS vectors and Node's crypto, with and without Web Crypto", async () => {
    expect(sha256Sync(bytes(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Sync(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Sync(bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    const big = new Uint8Array(200_003).map((_, index) => (index * 31) % 251);
    const expected = createHash("sha256").update(big).digest("hex");
    expect(sha256Sync(big)).toBe(expected);
    expect(await sha256(big)).toBe(expected);
  });

  it("finds references anywhere in record data", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(attachmentRefs({ x: { name: "x", ref: `att:${a}` }, rows: [{ f: [{ name: "y", ref: `att:${b}` }, { name: "z", ref: "pending:z" }] }], y: { ref: `att:${a}` } }).sort()).toEqual([a, b]);
    expect(shaOf("att:bad")).toBeNull();
  });
});

describe("attachments on a device", () => {
  async function device(server = new FakeServer()) {
    const local = await IndexedDbAdapter.open(`att-${Math.random()}`, new IDBFactory());
    await local.saveRegistry(styles, fonts);
    const row: SchemaVersion = { form_id: FORM.form_id, schema_version: 1, status: "published", definition: FORM, checksum: "t" };
    await local.saveSchemas([row]);
    await local.saveForms([{ form_id: FORM.form_id, title: FORM.title, latest_version: 1, published_version: 1, updated_at: 0 }]);
    let ids = 0;
    const client = createFormDevClient(local, server, { user: () => "nurse1", now: () => 1, newId: () => `att-record-${(ids += 1)}`,
      sync: { now: () => 1, random: () => 1, isOnline: () => true, baseDelayMs: 1, maxAttempts: 3 } });
    await client.records.prepare([FORM.form_id]);
    return { local, client, server };
  }

  it("a picked file is kept on the device, uploaded before its record, then opened from the device", async () => {
    const calls: string[] = [];
    const server = new FakeServer();
    const uploaded = new Map<string, Uint8Array>();
    server.putAttachment = async (sha, data) => { calls.push(`put:${sha.slice(0, 6)}`); uploaded.set(sha, new Uint8Array(data)); };
    const push = server.pushOps.bind(server);
    server.pushOps = async (ops: SyncOp[]) => { calls.push("push"); return push(ops); };
    const { local, client } = await device(server);
    const service = deviceAttachments(local, server, () => undefined);
    const file = new File([bytes("fake image bytes")], "wound.png", { type: "image/png" });
    const value = await service.save(file);
    expect(value).toMatchObject({ name: "wound.png", mime: "image/png", size: 16 });
    const sha = shaOf(value.ref)!;
    expect(sha).toBe(createHash("sha256").update("fake image bytes").digest("hex"));

    await client.records.create(FORM.form_id, { hn: "HN1", photo: [value] }, "submitted");
    const result = await client.sync.runOnce({ force: true });
    expect(result.applied).toBe(1);
    expect(calls).toEqual([`put:${sha.slice(0, 6)}`, "push"]);
    expect(new TextDecoder().decode(uploaded.get(sha))).toBe("fake image bytes");
    expect((await local.getAttachment(sha))?.uploaded).toBe(true);
    expect(await (await service.open(value))!.text()).toBe("fake image bytes");

    // Already uploaded: a later record with the same file does not upload it again.
    await client.records.create(FORM.form_id, { hn: "HN2", photo: [value] });
    await client.sync.runOnce({ force: true });
    expect(calls.filter(call => call.startsWith("put")).length).toBe(1);
  });

  it("when the upload fails the record waits and nothing is pushed", async () => {
    const server = new FakeServer();
    let pushed = 0;
    server.putAttachment = async () => { throw new TypeError("network down"); };
    const push = server.pushOps.bind(server);
    server.pushOps = async (ops: SyncOp[]) => { pushed += 1; return push(ops); };
    const { local, client } = await device(server);
    const value = await deviceAttachments(local, server, () => undefined).save(new File([bytes("x")], "a.png", { type: "image/png" }));
    await client.records.create(FORM.form_id, { hn: "HN1", photo: [value] });
    const result = await client.sync.runOnce({ force: true });
    expect([result.applied, result.retried, pushed]).toEqual([0, 1, 0]);
    expect((await local.listQueue(["pending"])).length).toBe(1);
  });

  it("a record from the server opens its file through the server", async () => {
    const server = new FakeServer();
    const asked: string[] = [];
    server.getAttachment = async (sha, recordId) => { asked.push(`${sha.slice(0, 4)}@${recordId}`); return new Blob(["from server"]); };
    const { local } = await device(server);
    const service = deviceAttachments(local, server, () => "rec-9");
    const blob = await service.open({ name: "x.png", mime: "image/png", size: 1, ref: `att:${"c".repeat(64)}` });
    expect(await blob!.text()).toBe("from server");
    expect(asked).toEqual(["cccc@rec-9"]);
    expect(await deviceAttachments(local, server, () => undefined).open({ name: "x", mime: "image/png", size: 1, ref: `att:${"d".repeat(64)}` })).toBeNull();
  });

  it("in-memory files for previews; same content stored once", async () => {
    const memory = memoryAttachments();
    const one = await memory.save(new File([bytes("same")], "a.txt", { type: "text/plain" }));
    const two = await memory.save(new File([bytes("same")], "b.txt", { type: "text/plain" }));
    expect(one.ref).toBe(two.ref);
    expect(await (await memory.open(one))!.text()).toBe("same");
  });

  it("a version 2 device database gains the attachment store and keeps its lookups", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const open = factory.open("v2-device", 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const name of ["forms", "schemas", "records", "styles", "fonts", "sync_queue"]) db.createObjectStore(name, { keyPath: name === "schemas" ? ["form_id", "schema_version"] : "id" });
        db.createObjectStore("lookups", { keyPath: "lookup_id" }).put({ lookup_id: "kept", version: 1, metadata: { title: "t", columns: [] }, entries: [] });
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });
    const local = await IndexedDbAdapter.open("v2-device", factory);
    expect((await local.getLookup("kept"))?.version).toBe(1);
    await local.saveAttachment({ sha256: "e".repeat(64), mime: "text/plain", size: 1, name: "e", bytes: bytes("e").buffer as ArrayBuffer, uploaded: false, created_at: 1 });
    expect((await local.getAttachment("e".repeat(64)))?.name).toBe("e");
  });
});
