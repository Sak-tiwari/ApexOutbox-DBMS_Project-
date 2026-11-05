import http from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Lead } from "../../src/models/Lead";
import { silentLog } from "../../src/phase4/ports";
import { MongoScrapeJobStore, ScrapeJob } from "../../src/scraper/jobs";
import { processScrapeJob } from "../../src/scraper/processor";
import { scrapePage } from "../../src/scraper/scrapePage";
import { MongoLeadStore } from "../../src/stores/mongoLeadStore";
import { connectTestDb, dropAndDisconnect, mongoEngine } from "../helpers/mongo";
import { requireOrWarn } from "../helpers/require";

const engine = await mongoEngine();
requireOrWarn("scraper.test", engine !== "none", "no MongoDB-compatible server is reachable at TEST_MONGODB_URI");
const realMongo = engine === "mongodb";

const PAGES: Record<string, { status?: number; type?: string; body?: string; location?: string; length?: number }> = {
  "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /demo/private\n" },
  "/demo/shop": { type: "text/html; charset=utf-8", body: '<html><head><title>Bloom Bakery | Home</title></head><body><a href="mailto:Owner@bloom.test">Mail</a> info@bloom.test</body></html>' },
  "/demo/quiet": { type: "text/html", body: "<html><title>Quiet Studio</title><body>No contact details here.</body></html>" },
  "/demo/private": { type: "text/html", body: "<title>x</title> secret@bloom.test" },
  "/demo/go": { status: 302, location: "/demo/shop" },
  "/demo/loop": { status: 302, location: "/demo/loop" },
  "/demo/evil": { status: 301, location: "http://169.254.169.254/latest/meta-data/" },
  "/demo/evil2": { status: 302, location: "http://localhost:6379/" },
  "/demo/file": { type: "application/pdf", body: "%PDF-1.4" },
  "/demo/big": { type: "text/html", body: "<title>big</title>", length: 50_000_000 },
  "/demo/gone": { status: 404, type: "text/html", body: "not found" },
  "/demo/broken": { status: 500, type: "text/html", body: "boom" },
};
let server: http.Server;
let base = "";
const safe = { allowLoopback: true };

beforeAll(() => new Promise<void>((resolve) => {
  server = http.createServer((req, res) => {
    const p = PAGES[req.url ?? ""];
    if (!p) { res.statusCode = 404; return res.end(); }
    res.statusCode = p.status ?? 200;
    if (p.type) res.setHeader("content-type", p.type);
    if (p.location) res.setHeader("location", p.location);
    if (p.length) res.setHeader("content-length", String(p.length));
    res.end(p.length ? undefined : p.body);
  }).listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); });
}));
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("scrapePage with real Crawlee against a local server", () => {
  it("reads the title and every contact email", async () => {
    const r = await scrapePage(`${base}/demo/shop`, safe);
    expect(r).toMatchObject({ ok: true, title: "Bloom Bakery | Home", emails: ["owner@bloom.test", "info@bloom.test"] });
  });
  it("returns an empty email list (not an error) for a page with no contacts", async () => {
    expect(await scrapePage(`${base}/demo/quiet`, safe)).toMatchObject({ ok: true, title: "Quiet Studio", emails: [] });
  });
  it("respects robots.txt: the disallowed page is never read", async () => {
    expect(await scrapePage(`${base}/demo/private`, safe)).toMatchObject({ ok: false, reason: "ROBOTS" });
  });
  it("follows a safe redirect", async () => {
    const r = await scrapePage(`${base}/demo/go`, safe);
    expect(r).toMatchObject({ ok: true, finalUrl: `${base}/demo/shop` });
  });
  it("stops a redirect to a cloud-metadata or localhost address (SSRF)", async () => {
    expect(await scrapePage(`${base}/demo/evil`, safe)).toMatchObject({ ok: false, reason: "UNSAFE_URL" });
    expect(await scrapePage(`${base}/demo/evil2`, safe)).toMatchObject({ ok: false, reason: "UNSAFE_URL" });
  });
  it("gives up on a redirect loop", async () => {
    expect(await scrapePage(`${base}/demo/loop`, safe)).toMatchObject({ ok: false, reason: "TOO_MANY_REDIRECTS" });
  });
  it("refuses non-HTML, oversized, 404 and 500 responses with a readable reason", async () => {
    expect(await scrapePage(`${base}/demo/file`, safe)).toMatchObject({ ok: false, reason: "NOT_HTML" });
    expect(await scrapePage(`${base}/demo/big`, safe)).toMatchObject({ ok: false });
    expect(await scrapePage(`${base}/demo/gone`, safe)).toMatchObject({ ok: false, reason: "HTTP_ERROR", message: expect.stringContaining("404") });
    expect(await scrapePage(`${base}/demo/broken`, safe)).toMatchObject({ ok: false });
  });
  it("refuses loopback entirely when demo pages are not enabled", async () => {
    expect(await scrapePage(`${base}/demo/shop`, {})).toMatchObject({ ok: false, reason: "UNSAFE_URL" });
  });
  it("reports a closed port as a failure instead of hanging", async () => {
    const r = await scrapePage("http://127.0.0.1:9/demo/x", safe);
    expect(r.ok).toBe(false);
  }, 60_000);
});

describe.skipIf(engine === "none")("scrape jobs on MongoDB", () => {
  const leads = new MongoLeadStore();
  const jobs = new MongoScrapeJobStore();
  beforeAll(async () => { await connectTestDb("apex_scrape"); await Lead.init(); await ScrapeJob.init(); });
  afterAll(async () => { await dropAndDisconnect(); });

  it("end to end: queue -> claim -> real scrape -> lead with emails -> job DONE", async () => {
    const { job, created } = await jobs.enqueue("ownerA", `${base}/demo/shop`);
    expect(created).toBe(true);
    expect((await jobs.enqueue("ownerA", `${base}/demo/shop`)).created).toBe(false); // no duplicate while waiting
    expect(await jobs.countActive("ownerA")).toBe(1);

    const claimed = (await jobs.claimNext())!;
    expect(claimed).toMatchObject({ id: job.id, status: "RUNNING", attempts: 1 });
    expect(await jobs.claimNext()).toBeNull();
    await processScrapeJob(claimed, { jobs, leads, log: silentLog, scrape: (u) => scrapePage(u, safe) });

    const done = (await jobs.findById(job.id))!;
    expect(done).toMatchObject({ status: "DONE", leadCreated: true, title: "Bloom Bakery | Home", emails: ["owner@bloom.test", "info@bloom.test"] });
    const lead = (await leads.findById(done.leadId!))!;
    expect(lead).toMatchObject({ name: "Bloom Bakery | Home", company: "127.0.0.1", currentState: "New", ownerId: "ownerA", email: "owner@bloom.test", source: "Website scraper", version: 0 });
    expect(lead.emails).toEqual(["owner@bloom.test", "info@bloom.test"]);
  });

  it("scraping the same website again returns the same lead (one lead per website and contact)", async () => {
    const before = await Lead.countDocuments();
    const { job } = await jobs.enqueue("ownerA", `${base}/demo/shop`);
    await processScrapeJob((await jobs.claimNext())!, { jobs, leads, log: silentLog, scrape: (u) => scrapePage(u, safe) });
    const again = (await jobs.findById(job.id))!;
    expect(again).toMatchObject({ status: "DONE", leadCreated: false });
    expect(await Lead.countDocuments()).toBe(before);
  });

  it("another user scraping the same site gets their own lead", async () => {
    const before = await Lead.countDocuments();
    const { job } = await jobs.enqueue("ownerB", `${base}/demo/shop`);
    await processScrapeJob((await jobs.claimNext())!, { jobs, leads, log: silentLog, scrape: (u) => scrapePage(u, safe) });
    expect((await jobs.findById(job.id))!.leadCreated).toBe(true);
    expect(await Lead.countDocuments()).toBe(before + 1);
  });

  it("a robots.txt refusal fails the job with the reason and creates no lead", async () => {
    const before = await Lead.countDocuments();
    const { job } = await jobs.enqueue("ownerA", `${base}/demo/private`);
    await processScrapeJob((await jobs.claimNext())!, { jobs, leads, log: silentLog, scrape: (u) => scrapePage(u, safe) });
    expect(await jobs.findById(job.id)).toMatchObject({ status: "FAILED", errorCode: "ROBOTS" });
    expect(await Lead.countDocuments()).toBe(before);
  });

  it("a scraped lead can be moved through the pipeline like any other", async () => {
    const lead = (await leads.list({ ownerId: "ownerA", limit: 10 })).items[0];
    expect(lead.website).toContain("/demo/shop");
    expect(lead.version).toBe(0);
  });

  it("jobs left RUNNING by a crashed worker are re-queued once, then failed", async () => {
    const { job } = await jobs.enqueue("ownerC", "https://crash.test/");
    await jobs.claimNext();
    await ScrapeJob.updateOne({ _id: job.id }, { $set: { startedAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await jobs.recoverStale(5 * 60_000, 2)).toBe(1);
    expect((await jobs.findById(job.id))!.status).toBe("QUEUED");
    await jobs.claimNext();
    await ScrapeJob.updateOne({ _id: job.id }, { $set: { startedAt: new Date(Date.now() - 10 * 60_000) } });
    await jobs.recoverStale(5 * 60_000, 2);
    expect(await jobs.findById(job.id)).toMatchObject({ status: "FAILED", errorCode: "WORKER_LOST" });
  });

  it.skipIf(!realMongo)("concurrent claims never hand the same job to two workers; concurrent scrapes of one site make one lead", async () => {
    for (let i = 0; i < 5; i++) await jobs.enqueue("ownerD", `https://many${i}.test/`);
    const claims = (await Promise.all(Array.from({ length: 10 }, () => jobs.claimNext()))).filter(Boolean);
    expect(new Set(claims.map((c) => c!.id)).size).toBe(claims.length);
    expect(claims).toHaveLength(5);
    const input = { ownerId: "ownerE", name: "Race", company: "race.test", website: "https://race.test/", email: "a@race.test", emails: ["a@race.test"], source: "Website scraper" };
    const results = await Promise.all(Array.from({ length: 8 }, () => leads.upsertScraped(input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await Lead.countDocuments({ ownerId: "ownerE" })).toBe(1);
  });
});
