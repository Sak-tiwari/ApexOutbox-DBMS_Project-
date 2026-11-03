import { describe, expect, it } from "vitest";
import { backoffMs, dispatchOnce, MAX_ATTEMPTS } from "../../src/phase4/dispatcherCore";
import { silentLog } from "../../src/phase4/ports";
import { MemoryOutboxStore } from "../helpers/memory";

describe("outbox dispatcher", () => {
  it("is idle when nothing is due", async () => {
    const store = new MemoryOutboxStore();
    expect(await dispatchOnce({ store, publishInvoiceJob: async () => {}, log: silentLog })).toBe("idle");
  });

  it("publishes a pending event once and marks it PUBLISHED", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e1", "inv1");
    const published: string[] = [];
    expect(await dispatchOnce({ store, publishInvoiceJob: async (id) => { published.push(id); }, log: silentLog })).toBe("published");
    expect(published).toEqual(["inv1"]);
    expect(store.events.get("e1")!.status).toBe("PUBLISHED");
    expect(await dispatchOnce({ store, publishInvoiceJob: async (id) => { published.push(id); }, log: silentLog })).toBe("idle");
    expect(published).toHaveLength(1);
  });

  it("a failed publish returns the event to PENDING with exponential backoff", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e1", "inv1");
    const t0 = new Date("2026-01-01T00:00:00Z");
    const outcome = await dispatchOnce({ store, publishInvoiceJob: async () => { throw new Error("redis down"); }, log: silentLog, now: () => t0 });
    const e = store.events.get("e1")!;
    expect(outcome).toBe("retry");
    expect(e.status).toBe("PENDING");
    expect(e.attempts).toBe(1);
    expect(e.lastError).toMatch(/redis down/);
    expect(e.nextAttemptAt.getTime()).toBe(t0.getTime() + backoffMs(1));
    // Not claimable again until the backoff has passed.
    expect(await dispatchOnce({ store, publishInvoiceJob: async () => {}, log: silentLog, now: () => new Date(t0.getTime() + 1000) })).toBe("idle");
    expect(await dispatchOnce({ store, publishInvoiceJob: async () => {}, log: silentLog, now: () => new Date(t0.getTime() + backoffMs(1) + 1) })).toBe("published");
  });

  it("a publish that never answers is cut off by the deadline instead of hanging the loop", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e1", "inv1");
    const started = Date.now();
    const outcome = await dispatchOnce({ store, publishInvoiceJob: () => new Promise(() => {}), log: silentLog, publishTimeoutMs: 100 });
    expect(outcome).toBe("retry");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(store.events.get("e1")!.lastError).toMatch(/timed out/);
    expect(store.events.get("e1")!.status).toBe("PENDING");
  });

  it("gives up after the maximum attempts and marks FAILED", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e1", "inv1");
    let outcome = "";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      outcome = await dispatchOnce({ store, publishInvoiceJob: async () => { throw new Error("nope"); }, log: silentLog, now: () => new Date(Date.now() + 24 * 3600_000 * (i + 1)) });
    }
    expect(outcome).toBe("failed");
    expect(store.events.get("e1")!.status).toBe("FAILED");
  });

  it("recovers an event abandoned in PROCESSING by a crashed dispatcher", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e1", "inv1", { status: "PROCESSING", attempts: 1, updatedAt: new Date(Date.now() - 5 * 60_000) });
    const published: string[] = [];
    expect(await dispatchOnce({ store, publishInvoiceJob: async (id) => { published.push(id); }, log: silentLog })).toBe("published");
    expect(published).toEqual(["inv1"]);
  });

  it("rejects an unknown event type instead of silently dropping it", async () => {
    const store = new MemoryOutboxStore();
    store.seed("e1", "inv1", { eventType: "SOMETHING_ELSE" });
    expect(await dispatchOnce({ store, publishInvoiceJob: async () => {}, log: silentLog })).toBe("retry");
    expect(store.events.get("e1")!.lastError).toMatch(/Unsupported event/);
  });

  it("backoff grows and is capped at 15 minutes", () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(3)).toBe(40_000);
    expect(backoffMs(30)).toBe(15 * 60_000);
  });
});
