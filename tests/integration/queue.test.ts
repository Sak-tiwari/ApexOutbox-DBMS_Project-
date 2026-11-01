import IORedis from "ioredis";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOnce } from "../../src/phase4/dispatcherCore";
import { silentLog } from "../../src/phase4/ports";
import { createQueueClient, QUEUE_NAME, type QueueClient } from "../../src/phase4/queue";
import { TestRedis } from "../helpers/redis";
import { MemoryOutboxStore } from "../helpers/memory";

let redis: TestRedis;
let client: QueueClient;
// A clock that jumps 20 minutes on every read, so every backoff delay has always expired by the next step.
const advancingClock = () => { let t = Date.now(); return () => new Date((t += 20 * 60_000)); };

beforeAll(async () => {
  redis = await TestRedis.create();
  await redis.start();
  client = createQueueClient(redis.url);
});
afterAll(async () => {
  await client.close();
  await redis.stop();
});

describe("queue (real Redis + BullMQ)", () => {
  it("publishing the same invoice twice creates ONE job (duplicate jobs)", async () => {
    await client.enqueueInvoiceJob("dup-1");
    await client.enqueueInvoiceJob("dup-1");
    await client.enqueueInvoiceJob("dup-1");
    const jobs = await client.queue.getJobs(["waiting", "delayed", "active", "completed"]);
    expect(jobs.filter((j) => j.data.invoiceId === "dup-1")).toHaveLength(1);
  });

  it("dispatcher publishes a pending event to Redis", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e1", "inv-pub");
    expect(await dispatchOnce({ store, publishInvoiceJob: client.enqueueInvoiceJob, log: silentLog })).toBe("published");
    expect(await client.queue.getJob("invoice-inv-pub")).toBeTruthy();
  });
});

describe("Redis outage", () => {
  it("BASELINE: the original queue settings make a publish hang while Redis is down", async () => {
    // Original Phase 4 queue.ts: new IORedis(url, { maxRetriesPerRequest: null }) with the default offline queue.
    const original = new IORedis(redis.url, { maxRetriesPerRequest: null });
    original.on("error", () => {});
    const q = new Queue(QUEUE_NAME + "-baseline", { connection: original });
    q.on("error", () => {});
    await q.waitUntilReady();
    await redis.stop();
    const verdict = await Promise.race([
      q.add("x", { a: 1 }).then(() => "settled", () => "settled"),
      new Promise((r) => setTimeout(() => r("still waiting after 3s"), 3000)),
    ]);
    expect(verdict).toBe("still waiting after 3s");
    await redis.start();
    original.disconnect();
    await q.close().catch(() => {});
  });

  it("dispatcher does not hang while Redis is down: event goes back to PENDING with backoff, then publishes after recovery", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e-out", "inv-outage");

    await redis.stop();
    const started = Date.now();
    const outcome = await dispatchOnce({ store, publishInvoiceJob: client.enqueueInvoiceJob, log: silentLog, publishTimeoutMs: 3000 });
    expect(outcome).toBe("retry");
    expect(Date.now() - started).toBeLessThan(6000);
    const e = store.events.get("e-out")!;
    expect(e.status).toBe("PENDING");
    expect(e.attempts).toBe(1);
    expect(e.lastError).toBeTruthy();

    await redis.start();
    let result = "retry";
    const clock = advancingClock();
    for (let i = 0; i < 20 && result !== "published"; i++) {
      result = await dispatchOnce({ store, publishInvoiceJob: client.enqueueInvoiceJob, log: silentLog, publishTimeoutMs: 3000, now: clock });
      if (result !== "published") await new Promise((r) => setTimeout(r, 500));
    }
    expect(result).toBe("published");
    expect(store.events.get("e-out")!.status).toBe("PUBLISHED");
    expect(await client.queue.getJob("invoice-inv-outage")).toBeTruthy();
  });
});

describe("requeue after lost or failed jobs (real Redis + BullMQ)", () => {
  it("creates a job when Redis lost it, and leaves a live job alone", async () => {
    expect(await client.queue.getJob("invoice-lost-1")).toBeUndefined();
    expect(await client.requeueInvoice("lost-1")).toBe("created");
    expect(await client.requeueInvoice("lost-1")).toBe("already-queued");
    const jobs = await client.queue.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
    expect(jobs.filter((j) => j.data.invoiceId === "lost-1")).toHaveLength(1);
  });

  it("retries a job that exhausted its attempts, and the retry can then succeed", async () => {
    let healthy = false;
    const handled: string[] = [];
    const conn = new IORedis(redis.url, { maxRetriesPerRequest: null });
    const worker = new Worker(QUEUE_NAME, async (job) => {
      if (job.data.invoiceId !== "failed-1") return;
      if (!healthy) throw new UnrecoverableError("provider down");
      handled.push(job.data.invoiceId);
    }, { connection: conn });
    worker.on("error", () => {});
    try {
      await client.enqueueInvoiceJob("failed-1");
      for (let i = 0; i < 50 && !(await (await client.queue.getJob("invoice-failed-1"))?.isFailed()); i++) await new Promise((r) => setTimeout(r, 100));
      expect(await (await client.queue.getJob("invoice-failed-1"))!.isFailed()).toBe(true);
      // Re-adding with the same id does nothing for a failed job: this is why requeue must call retry().
      await client.enqueueInvoiceJob("failed-1");
      expect(await (await client.queue.getJob("invoice-failed-1"))!.isFailed()).toBe(true);

      healthy = true;
      expect(await client.requeueInvoice("failed-1")).toBe("retried");
      for (let i = 0; i < 50 && handled.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(handled).toEqual(["failed-1"]);
    } finally {
      await worker.close();
      conn.disconnect();
    }
  });
});
