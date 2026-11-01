import { describe, expect, it } from "vitest";
import { silentLog } from "../../src/phase4/ports";
import { requeueStuckInvoices } from "../../src/phase4/requeue";
import { MemoryInvoiceStore } from "../helpers/memory";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("requeue sweep", () => {
  it("re-queues only unsent invoices that have been idle long enough", async () => {
    const store = new MemoryInvoiceStore();
    store.seed({ id: "old-pending", status: "PENDING", updatedAt: minutesAgo(30) });
    store.seed({ id: "old-failed", status: "EMAIL_FAILED", updatedAt: minutesAgo(30) });
    store.seed({ id: "fresh", status: "PENDING", updatedAt: minutesAgo(1) });
    store.seed({ id: "sent", status: "EMAIL_SENT", updatedAt: minutesAgo(60) });
    store.seed({ id: "uncertain", status: "EMAIL_UNCERTAIN", updatedAt: minutesAgo(60) });
    store.seed({ id: "sending-old", status: "EMAIL_SENDING", updatedAt: minutesAgo(60) });
    store.seed({ id: "sending-fresh", status: "EMAIL_SENDING", updatedAt: minutesAgo(1) });
    store.seed({ id: "abandoned", status: "EMAIL_ABANDONED", updatedAt: minutesAgo(60) });
    const seen: string[] = [];
    const tally = await requeueStuckInvoices({ store, requeue: async (id) => { seen.push(id); return "created"; }, log: silentLog });
    expect(seen.sort()).toEqual(["old-failed", "old-pending", "sending-old"]);
    expect(tally).toEqual({ created: 3, retried: 0, alreadyQueued: 0 });
  });

  it("counts each outcome and survives a failing requeue", async () => {
    const store = new MemoryInvoiceStore();
    for (const id of ["a", "b", "c", "d"]) store.seed({ id, status: "PENDING", updatedAt: minutesAgo(30) });
    const answers: Record<string, any> = { a: "created", b: "retried", c: "already-queued" };
    const tally = await requeueStuckInvoices({ store, requeue: async (id) => { if (id === "d") throw new Error("redis down"); return answers[id]; }, log: silentLog });
    expect(tally).toEqual({ created: 1, retried: 1, alreadyQueued: 1 });
  });

  it("does nothing when nothing is stuck", async () => {
    const tally = await requeueStuckInvoices({ store: new MemoryInvoiceStore(), requeue: async () => "created", log: silentLog });
    expect(tally).toEqual({ created: 0, retried: 0, alreadyQueued: 0 });
  });
});
