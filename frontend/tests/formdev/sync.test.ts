/** Sync queue + engine: ordering, retry/backoff, idempotency, crash recovery, conflicts. */
import { describe, expect, it } from "vitest";
import { SyncEngine } from "../../src/formdev/offline/SyncEngine";
import { TransportError } from "../../src/formdev";
import { device, FakeServer, submittedData } from "./helpers";

const states = async (local: Awaited<ReturnType<typeof device>>["local"]) => (await local.listQueue()).map(item => item.state);

describe("sync engine", () => {
  it("delivers a record's ops in order, one per round, rebasing on each ack", async () => {
    const { client, local, server } = await device();
    const record = await client.records.create("patient_assessment", { hn: "HN1" });
    await client.records.update(record.record_id, { hn: "HN1", age: 50 }, 1);
    await client.records.submit(record.record_id, submittedData({ hn: "HN1" }), 2);

    for (let round = 0; round < 3; round += 1) expect((await client.sync.runOnce()).applied).toBe(1);
    expect(server.pushes.map(batch => batch.map(op => [op.kind, op.base_version]))).toEqual([[["create", 0]], [["update", 1]], [["submit", 2]]]);
    expect(await states(local)).toEqual(["success", "success", "success"]);
    const synced = await client.records.get(record.record_id);
    expect([synced.sync_state, synced.version, synced.status]).toEqual(["synced", 3, "submitted"]);
    expect(server.records.get(record.record_id)?.version).toBe(3);
  });

  it("does nothing while offline and keeps the queue", async () => {
    const { client, local, server } = await device({ sync: { isOnline: () => false } });
    await client.records.create("patient_assessment", { hn: "OFF" });
    expect((await client.sync.runOnce()).offline).toBe(true);
    expect(server.pushes).toHaveLength(0);
    expect(await states(local)).toEqual(["pending"]);
  });

  it("retries transport failures with exponential backoff", async () => {
    const { client, local, server, clock } = await device();
    await client.records.create("patient_assessment", { hn: "RETRY" });
    server.failNext = 2;

    expect((await client.sync.runOnce()).retried).toBe(1);
    let [item] = await local.listQueue();
    expect([item.state, item.attempts, item.next_attempt_at - clock.now]).toEqual(["pending", 1, 1000]);
    expect((await client.sync.runOnce()).sent).toBe(0); // not due yet

    clock.now += 1000;
    expect((await client.sync.runOnce()).retried).toBe(1);
    [item] = await local.listQueue();
    expect([item.attempts, item.next_attempt_at - clock.now]).toEqual([2, 2000]);

    clock.now += 2000;
    expect((await client.sync.runOnce()).applied).toBe(1);
    expect(await states(local)).toEqual(["success"]);
    expect(server.pushes).toHaveLength(3);
  });

  it("backoff is capped and jittered", async () => {
    const { local, server } = await device();
    const engine = new SyncEngine(local, server, () => [], { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 0 });
    expect([1, 2, 3, 4, 10].map(attempt => engine.backoff(attempt))).toEqual([500, 1000, 2000, 2500, 2500]);
  });

  it("marks ops failed after max attempts and can requeue them", async () => {
    const { client, local, server, clock } = await device();
    await client.records.create("patient_assessment", { hn: "GIVEUP" });
    server.failNext = 99;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await client.sync.runOnce();
      clock.now += 60_000;
    }
    expect(await states(local)).toEqual(["failed"]);
    expect(await client.sync.retryFailed()).toBe(1);
    server.failNext = 0;
    expect((await client.sync.runOnce()).applied).toBe(1);
  });

  it("non-retriable transport errors fail immediately", async () => {
    const { client, local, server } = await device();
    await client.records.create("patient_assessment", { hn: "BAD" });
    server.failNext = 1;
    server.failWith = new TransportError("bad batch", false);
    expect((await client.sync.runOnce()).failed).toBe(1);
    expect(await states(local)).toEqual(["failed"]);
  });

  it("recovers after a crash between send and ack without duplicating", async () => {
    const server = new FakeServer();
    const first = await device({ server });
    await first.client.records.create("patient_assessment", { hn: "CRASH" });
    const [item] = await first.local.listQueue();
    await server.pushOps([item.op]); // server applied it ...
    await first.local.updateQueueItem({ ...item, state: "processing" }); // ... but the app died before the ack
    first.local.close();

    const second = await device({ server, factory: first.factory, name: first.name });
    await second.client.start();
    second.client.sync.stop();
    expect(await states(second.local)).toEqual(["pending"]);
    const result = await second.client.sync.runOnce();
    expect(result.applied).toBe(1);
    expect(server.revisions.get(item.op.record_id)).toBe(1);
    expect(await states(second.local)).toEqual(["success"]);
  });

  it("server-newer conflict keeps the server copy and supersedes later local ops", async () => {
    const { client, local, server, clock } = await device();
    const record = await client.records.create("patient_assessment", { hn: "BASE" });
    await client.sync.runOnce();
    clock.now += 10;
    await client.records.update(record.record_id, { hn: "LOCAL1" }, 1);
    await client.records.update(record.record_id, { hn: "LOCAL2" }, 2);
    server.editOnServer(record.record_id, { hn: "SERVER" }, clock.now + 5_000);

    expect((await client.sync.runOnce()).conflicts).toBe(1);
    expect(await states(local)).toEqual(["success", "conflict", "conflict"]);
    const after = await client.records.get(record.record_id);
    expect([after.sync_state, after.data.hn, after.version]).toEqual(["conflict", "SERVER", 2]);
    const searched = await client.records.search({ formId: "patient_assessment", filters: [{ field: "hn", op: "eq", value: "SERVER" }] });
    expect(searched.rows).toHaveLength(1);
  });

  it("local-newer conflict wins and later ops are rebased onto the server version", async () => {
    const { client, local, server, clock } = await device();
    const record = await client.records.create("patient_assessment", { hn: "BASE" });
    await client.sync.runOnce();
    server.editOnServer(record.record_id, { hn: "SERVER" }, clock.now - 5_000);
    clock.now += 10;
    await client.records.update(record.record_id, { hn: "LOCAL1" }, 1);
    await client.records.update(record.record_id, { hn: "LOCAL2" }, 2);

    await client.sync.runOnce();
    await client.sync.runOnce();
    expect(await states(local)).toEqual(["success", "success", "success"]);
    expect(server.pushes[2][0].base_version).toBe(3);
    expect(server.records.get(record.record_id)).toMatchObject({ version: 4, data: { hn: "LOCAL2" } });
    expect((await client.records.get(record.record_id)).sync_state).toBe("synced");
  });

  it("rejected ops stay failed and are not retried", async () => {
    const { client, local } = await device();
    const record = await client.records.create("patient_assessment", { hn: "R1" });
    const [item] = await local.listQueue();
    await local.updateQueueItem({ ...item, op: { ...item.op, data: { reject_me: "1" } } });
    expect((await client.sync.runOnce()).rejected).toBe(1);
    expect(await states(local)).toEqual(["failed"]);
    expect(await client.sync.retryFailed()).toBe(0);
    expect((await client.records.get(record.record_id)).sync_state).toBe("error");
  });

  it("other records keep syncing while one record waits for backoff", async () => {
    const { client, local, server, clock } = await device();
    await client.records.create("patient_assessment", { hn: "A" });
    server.failNext = 1;
    await client.sync.runOnce();
    await client.records.create("patient_assessment", { hn: "B" });
    expect((await client.sync.runOnce()).applied).toBe(1);
    expect((await local.listQueue()).map(item => [item.op.data.hn, item.state])).toEqual([["A", "pending"], ["B", "success"]]);
    clock.now += 1000;
    expect((await client.sync.runOnce()).applied).toBe(1);
  });
});

describe("manual sync", () => {
  it("force sends ops that are waiting for backoff and tracks reachability", async () => {
    const { client, local, server } = await device();
    await client.records.create("patient_assessment", { hn: "FORCE" });
    server.failNext = 1;
    await client.sync.runOnce();
    expect(client.sync.serverReachable).toBe(false);
    expect((await client.sync.runOnce()).sent).toBe(0);
    expect((await client.sync.runOnce({ force: true })).applied).toBe(1);
    expect(client.sync.serverReachable).toBe(true);
    expect((await local.listQueue()).map(item => item.state)).toEqual(["success"]);
  });
});

describe("acknowledgements without data", () => {
  it("a writer who may not read the form keeps its own copy and settles the versions", async () => {
    const { client, local, server } = await device();
    const push = server.pushOps.bind(server);
    server.pushOps = async ops => (await push(ops)).map(ack => (ack.record ? { ...ack, record: { record_id: ack.record.record_id, form_id: ack.record.form_id,
      schema_version: ack.record.schema_version, status: ack.record.status, version: ack.record.version, updated_at: ack.record.updated_at } as never } : ack));
    const record = await client.records.create("patient_assessment", submittedData(), "submitted");
    expect((await client.sync.runOnce({ force: true })).applied).toBe(1);
    const stored = await local.getLocalRecord(record.record_id);
    expect(stored?.data).toEqual(record.data);
    expect([stored?.sync_state, stored?.server_version]).toEqual(["synced", 1]);
  });
});
