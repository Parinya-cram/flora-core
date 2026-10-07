/**
 * Pushes the durable sync queue to the server: Local -> Sync Queue -> Server -> Acknowledge.
 *
 * - order: ops are sent in queue order and at most one op per record per round, so a
 *   record's changes reach the server in the order they were made;
 * - retry/backoff: transport failures reschedule the op with exponential backoff + jitter;
 * - idempotency: an op keeps its op_id forever, so resending after a lost ack is safe;
 * - failure recovery: ops left "processing" by a crash are reset to "pending" on start.
 */
import { attachmentRefs } from "../core/attachments";
import type { SyncAck, SyncOp } from "../core/types";
import type { IndexKeyFn, LocalDataAdapter, QueueItem, QueueState, RemoteDataAdapter } from "../data/DataAdapter";
import { TransportError } from "../data/RestApiAdapter";

export type SyncOptions = {
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  intervalMs?: number;
  now?: () => number;
  random?: () => number;
  isOnline?: () => boolean;
};

export type SyncRunResult = { sent: number; applied: number; conflicts: number; rejected: number; retried: number; failed: number; offline?: boolean };
export type QueueCounts = Record<QueueState, number>;

export class SyncEngine {
  private readonly local: LocalDataAdapter;
  private readonly remote: RemoteDataAdapter;
  private readonly indexKeys: IndexKeyFn;
  private readonly options: Required<SyncOptions>;
  private running: Promise<SyncRunResult> | null = null;
  /** null until the first push attempt; false after a transport failure. */
  serverReachable: boolean | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly onOnline = () => void this.runSoon();

  constructor(local: LocalDataAdapter, remote: RemoteDataAdapter, indexKeys: IndexKeyFn, options: SyncOptions = {}) {
    this.local = local;
    this.remote = remote;
    this.indexKeys = indexKeys;
    this.options = {
      batchSize: options.batchSize ?? 20,
      baseDelayMs: options.baseDelayMs ?? 2_000,
      maxDelayMs: options.maxDelayMs ?? 5 * 60_000,
      maxAttempts: options.maxAttempts ?? 8,
      intervalMs: options.intervalMs ?? 15_000,
      now: options.now ?? (() => Date.now()),
      random: options.random ?? Math.random,
      isOnline: options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false),
    };
  }

  /** Delay before attempt n+1: base * 2^(n-1), capped, with 50-100% jitter to avoid thundering herds. */
  backoff(attempts: number): number {
    const raw = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** Math.max(0, attempts - 1));
    return Math.round(raw * (0.5 + this.options.random() / 2));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(listener => listener());
  }

  async counts(): Promise<QueueCounts> {
    const counts: QueueCounts = { pending: 0, processing: 0, success: 0, failed: 0, conflict: 0 };
    (await this.local.listQueue()).forEach(item => { counts[item.state] += 1; });
    return counts;
  }

  async start(): Promise<void> {
    await this.local.recoverQueue();
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
    this.runSoon(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
  }

  runSoon(delayMs = 0): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.runOnce();
      } finally {
        this.runSoon(this.options.intervalMs);
      }
    }, delayMs);
  }

  /** Manually requeue ops that exhausted their retries (rejected ops stay failed). */
  async retryFailed(): Promise<number> {
    const failed = (await this.local.listQueue(["failed"])).filter(item => !item.ack);
    for (const item of failed) await this.local.updateQueueItem({ ...item, state: "pending", attempts: 0, next_attempt_at: this.options.now(), updated_at: this.options.now() });
    this.notify();
    return failed.length;
  }

  /** One push round. ``force`` (manual "Sync now") ignores backoff timers for pending ops. */
  runOnce(options: { force?: boolean } = {}): Promise<SyncRunResult> {
    this.running ??= this.pushDue(options.force === true).finally(() => {
      this.running = null;
      this.notify();
    });
    return this.running;
  }

  /** Upload the device's files that these ops reference and the server has not received yet. */
  private async uploadAttachments(ops: SyncOp[]): Promise<void> {
    if (!this.remote.putAttachment) return;
    const wanted = new Set(ops.flatMap(op => attachmentRefs(op.data)));
    for (const sha of wanted) {
      const local = await this.local.getAttachment(sha);
      if (!local || local.uploaded) continue;
      await this.remote.putAttachment(sha, local.bytes, local.mime);
      await this.local.markAttachmentUploaded(sha);
    }
  }

  private async pushDue(force: boolean): Promise<SyncRunResult> {
    const result: SyncRunResult = { sent: 0, applied: 0, conflicts: 0, rejected: 0, retried: 0, failed: 0 };
    if (!this.options.isOnline()) return { ...result, offline: true };
    const now = this.options.now();
    const open = (await this.local.listQueue(["pending", "processing"])).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const blocked = new Set<string>();
    const due: QueueItem[] = [];
    for (const item of open) {
      const recordId = item.op.record_id;
      if (blocked.has(recordId)) continue;
      blocked.add(recordId);
      if (item.state === "pending" && (force || item.next_attempt_at <= now) && due.length < this.options.batchSize) due.push(item);
    }
    if (!due.length) return result;

    const processing = due.map(item => ({ ...item, state: "processing" as const, updated_at: now }));
    for (const item of processing) await this.local.updateQueueItem(item);
    this.notify();
    result.sent = processing.length;

    let acks: SyncAck[];
    try {
      // Files first: the server refuses a record whose attachment it does not have.
      await this.uploadAttachments(processing.map(item => item.op));
      acks = await this.remote.pushOps(processing.map(item => item.op));
    } catch (error) {
      const retriable = !(error instanceof TransportError) || error.retriable;
      this.serverReachable = !retriable;
      const message = error instanceof Error ? error.message : String(error);
      for (const item of processing) {
        const attempts = item.attempts + 1;
        const exhausted = !retriable || attempts >= this.options.maxAttempts;
        await this.local.updateQueueItem({
          ...item, attempts, last_error: message, updated_at: now,
          state: exhausted ? "failed" : "pending",
          next_attempt_at: exhausted ? item.next_attempt_at : now + this.backoff(attempts),
        });
        if (exhausted) result.failed += 1;
        else result.retried += 1;
      }
      return result;
    }

    this.serverReachable = true;
    const byOp = new Map(acks.map(ack => [ack.op_id, ack]));
    for (const item of processing) {
      const ack = byOp.get(item.op.op_id);
      if (!ack) {
        // Server answered without this op (should not happen): leave it for the next round.
        await this.local.updateQueueItem({ ...item, state: "pending", next_attempt_at: now + this.backoff(item.attempts + 1), attempts: item.attempts + 1 });
        result.retried += 1;
        continue;
      }
      await this.local.applyAck(item, ack, this.indexKeys);
      if (ack.status === "applied") result.applied += 1;
      else if (ack.status === "conflict") result.conflicts += 1;
      else result.rejected += 1;
    }
    return result;
  }
}
