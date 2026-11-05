import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { Metrics } from "../../src/metrics";
import { silentLog } from "../../src/phase4/ports";
import { MAX_ACTIVE_SCRAPES_PER_USER } from "../../src/routes/scrapeRoutes";
import { TransitionService } from "../../src/services/TransitionService";
import { MemoryLeadStore, MemoryScrapeJobStore } from "../helpers/memory";

const KEY_A = "a".repeat(24);
const KEY_B = "b".repeat(24);
const authA = { Authorization: `Bearer ${KEY_A}` };
const authB = { Authorization: `Bearer ${KEY_B}` };

function build(allowLoopback = false) {
  const leads = new MemoryLeadStore();
  const scrapeJobs = new MemoryScrapeJobStore();
  const app = createApp({
    leads, transitions: new TransitionService(leads), onboard: async () => ({ clientId: "c", invoiceId: "i", invoiceNumber: "INV-1", status: "PENDING" }) as any,
    log: silentLog, metrics: new Metrics(), apiKeys: new Map([[KEY_A, "ownerA"], [KEY_B, "ownerB"]]),
    checks: { mongo: () => true, redis: () => true },
    scrapeJobs, scraperSafeUrl: { allowLoopback },
  });
  return { app, scrapeJobs };
}

describe("scrape jobs API", () => {
  it("requires authentication", async () => {
    const { app } = build();
    expect((await request(app).post("/api/scrape-jobs").send({ url: "https://example.com" })).status).toBe(401);
    expect((await request(app).get("/api/scrape-jobs")).status).toBe(401);
  });

  it("queues a job (202) and adds https:// to a bare domain", async () => {
    const { app, scrapeJobs } = build();
    const res = await request(app).post("/api/scrape-jobs").set(authA).send({ url: "  93.184.216.34/contact " });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: "QUEUED", url: "https://93.184.216.34/contact", ownerId: "ownerA" });
    expect(scrapeJobs.jobs).toHaveLength(1);
  });

  it("does not queue the same page twice while it is waiting", async () => {
    const { app, scrapeJobs } = build();
    await request(app).post("/api/scrape-jobs").set(authA).send({ url: "https://93.184.216.34/" });
    const again = await request(app).post("/api/scrape-jobs").set(authA).send({ url: "https://93.184.216.34/" });
    expect(again.status).toBe(200);
    expect(again.body.alreadyQueued).toBe(true);
    expect(scrapeJobs.jobs).toHaveLength(1);
  });

  it.each(["", "ftp://example.com", "http://127.0.0.1/", "http://169.254.169.254/latest", "http://localhost:3000/api/leads", "https://[::1]/", "file:///etc/passwd"])("refuses %j with a clear 400", async (url) => {
    const { app, scrapeJobs } = build();
    const res = await request(app).post("/api/scrape-jobs").set(authA).send({ url });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(scrapeJobs.jobs).toHaveLength(0);
  });

  it("rejects a missing or non-string url", async () => {
    const { app } = build();
    expect((await request(app).post("/api/scrape-jobs").set(authA).send({})).status).toBe(400);
    expect((await request(app).post("/api/scrape-jobs").set(authA).send({ url: 5 })).status).toBe(400);
  });

  it("accepts the bundled demo pages on loopback only when enabled", async () => {
    expect((await request(build(false).app).post("/api/scrape-jobs").set(authA).send({ url: "http://127.0.0.1:3000/demo/bakery.html" })).status).toBe(400);
    expect((await request(build(true).app).post("/api/scrape-jobs").set(authA).send({ url: "http://127.0.0.1:3000/demo/bakery.html" })).status).toBe(202);
  });

  it("caps the number of waiting scrapes per user", async () => {
    const { app } = build();
    for (let i = 0; i < MAX_ACTIVE_SCRAPES_PER_USER; i++) {
      expect((await request(app).post("/api/scrape-jobs").set(authA).send({ url: `https://93.184.216.34/p${i}` })).status).toBe(202);
    }
    const res = await request(app).post("/api/scrape-jobs").set(authA).send({ url: "https://93.184.216.34/one-more" });
    expect(res.status).toBe(409);
    expect((await request(app).post("/api/scrape-jobs").set(authB).send({ url: "https://93.184.216.34/other-user" })).status).toBe(202);
  });

  it("lists only the caller's jobs, newest first, and hides other users' jobs by id", async () => {
    const { app } = build();
    const a1 = await request(app).post("/api/scrape-jobs").set(authA).send({ url: "https://93.184.216.34/1" });
    await request(app).post("/api/scrape-jobs").set(authA).send({ url: "https://93.184.216.34/2" });
    await request(app).post("/api/scrape-jobs").set(authB).send({ url: "https://93.184.216.34/b" });
    const list = await request(app).get("/api/scrape-jobs?limit=5").set(authA);
    expect(list.body.data.map((j: any) => j.url)).toEqual(["https://93.184.216.34/2", "https://93.184.216.34/1"]);
    expect((await request(app).get(`/api/scrape-jobs/${a1.body.data.id}`).set(authA)).status).toBe(200);
    expect((await request(app).get(`/api/scrape-jobs/${a1.body.data.id}`).set(authB)).status).toBe(404);
    expect((await request(app).get("/api/scrape-jobs?limit=0").set(authA)).status).toBe(400);
  });

  it("/api/meta tells the dashboard whether scraping and demo pages exist", async () => {
    const withIt = await request(build(true).app).get("/api/meta").set(authA);
    expect(withIt.body.data).toMatchObject({ scraper: true, demoPages: true });
    const without = await request(build(false).app).get("/api/meta").set(authA);
    expect(without.body.data.demoPages).toBe(false);
  });
});
