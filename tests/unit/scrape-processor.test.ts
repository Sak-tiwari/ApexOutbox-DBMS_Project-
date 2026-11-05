import { describe, expect, it } from "vitest";
import { silentLog } from "../../src/phase4/ports";
import { processScrapeJob } from "../../src/scraper/processor";
import type { ScrapeOutcome } from "../../src/scraper/scrapePage";
import { MemoryLeadStore, MemoryScrapeJobStore } from "../helpers/memory";

async function run(outcome: ScrapeOutcome | Error, store = new MemoryScrapeJobStore(), leads = new MemoryLeadStore(), url = "https://bloom.test/") {
  const { job } = await store.enqueue("ownerA", url);
  const claimed = (await store.claimNext())!;
  expect(claimed.id).toBe(job.id);
  await processScrapeJob(claimed, { jobs: store, leads, log: silentLog, scrape: async () => { if (outcome instanceof Error) throw outcome; return outcome; } });
  return { store, leads, job: (await store.findById(job.id))! };
}
const good: ScrapeOutcome = { ok: true, finalUrl: "https://www.bloom.test/", title: "Bloom Bakery", emails: ["info@bloom.test", "owner@bloom.test"] };

describe("scrape job processor", () => {
  it("creates one New lead with the best email and marks the job DONE", async () => {
    const { leads, job } = await run(good);
    expect(job.status).toBe("DONE");
    expect(job.leadCreated).toBe(true);
    const lead = leads.leads.get(job.leadId!)!;
    expect(lead).toMatchObject({ name: "Bloom Bakery", company: "bloom.test", currentState: "New", ownerId: "ownerA", email: "owner@bloom.test", website: "https://www.bloom.test/", source: "Website scraper" });
    expect(lead.emails).toEqual(["info@bloom.test", "owner@bloom.test"]);
  });
  it("scraping the same site twice does not create a second lead", async () => {
    const leads = new MemoryLeadStore();
    const first = await run(good, new MemoryScrapeJobStore(), leads);
    const second = await run(good, new MemoryScrapeJobStore(), leads);
    expect(second.job.leadId).toBe(first.job.leadId);
    expect(second.job.leadCreated).toBe(false);
    expect(leads.leads.size).toBe(1);
  });
  it("a page with no email still becomes a lead (found by name)", async () => {
    const { leads, job } = await run({ ok: true, finalUrl: "https://quiet.test/", title: "", emails: [] });
    expect(job.status).toBe("DONE");
    expect(leads.leads.get(job.leadId!)).toMatchObject({ name: "quiet.test", email: undefined });
  });
  it("records the reason when the scrape is refused, and creates no lead", async () => {
    const { leads, job } = await run({ ok: false, reason: "ROBOTS", message: "blocked by robots.txt" });
    expect(job).toMatchObject({ status: "FAILED", errorCode: "ROBOTS", error: "blocked by robots.txt" });
    expect(leads.leads.size).toBe(0);
  });
  it("an unexpected crash fails the job with a safe message instead of leaking details", async () => {
    const { job } = await run(new Error("mongodb://user:secret@host exploded"));
    expect(job.status).toBe("FAILED");
    expect(job.error).not.toMatch(/secret/);
  });
  it("two workers never claim the same job; a crashed worker's job is re-queued once, then failed", async () => {
    const store = new MemoryScrapeJobStore();
    await store.enqueue("ownerA", "https://a.test/");
    const [x, y] = await Promise.all([store.claimNext(), store.claimNext()]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    store.jobs[0].startedAt = new Date(Date.now() - 10 * 60_000);
    expect(await store.recoverStale(5 * 60_000, 2)).toBe(1);
    expect((await store.claimNext())!.attempts).toBe(2);
    store.jobs[0].startedAt = new Date(Date.now() - 10 * 60_000);
    expect(await store.recoverStale(5 * 60_000, 2)).toBe(0);
    expect(store.jobs[0]).toMatchObject({ status: "FAILED", errorCode: "WORKER_LOST" });
  });
});
