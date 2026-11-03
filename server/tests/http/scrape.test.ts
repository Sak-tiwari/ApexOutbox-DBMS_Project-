import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { FetchError } from "../../src/scraper/fetch.js";
import { hostAllowed } from "../../src/scraper/ssrf.js";
import { ScrapeWorker } from "../../src/scraper/worker.js";
import { bearer, makeApp, newAccount, userWithRole } from "../helpers/app.js";
import { appPool, closePools, ownerPool } from "../helpers/db.js";

afterAll(closePools);

type Page = { status?: number; body: string } | Error;
const html = (title: string, extra = "") => ({ body: `<html><head><title>${title}</title></head><body>${extra}</body></html>` });

/** A pretend internet. Honours the workspace allowlist exactly like the real fetcher does. */
function fakeWeb(pages: Record<string, Page>, calls: string[] = []) {
  return (allowed: () => readonly string[]) => ({
    fetch: async (url: string) => {
      calls.push(url);
      const host = new URL(url).hostname;
      if (!hostAllowed(host, allowed())) throw new FetchError("Domain is not on your approved list", "blocked");
      const page = pages[url] ?? { status: 404, body: "not found" };
      if (page instanceof Error) throw page;
      return { url, status: page.status ?? 200, contentType: "text/html", body: page.body, truncated: false };
    },
  });
}

function worker(pages: Record<string, Page>, extra: Partial<ConstructorParameters<typeof ScrapeWorker>[0]> = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const w = new ScrapeWorker({
    db: appPool(), log: createLogger("silent"), minDelayMs: 1500, makeFetcher: fakeWeb(pages, calls),
    sleep: async (ms) => void sleeps.push(ms), ...extra,
  });
  return { w, calls, sleeps };
}

const site = () => `s${randomUUID().slice(0, 8)}.example.com`;

async function setup(label = "scrape") {
  const ctx = makeApp();
  const owner = await newAccount(ctx, label);
  const allow = (domain: string, token = owner.accessToken) => request(ctx.app).post("/api/scrape/domains").set(bearer(token)).send({ domain });
  const create = (urls: string[], extra: object = {}, token = owner.accessToken) => request(ctx.app).post("/api/scrape/jobs").set(bearer(token)).send({ urls, ...extra });
  const job = async (id: string, token = owner.accessToken) => (await request(ctx.app).get(`/api/scrape/jobs/${id}`).set(bearer(token))).body;
  const leads = async (token = owner.accessToken) => (await request(ctx.app).get("/api/leads?limit=100").set(bearer(token))).body.items as { id: string; name: string; email: string | null; website: string; needsReview: boolean; sourceAdapter: string; scrapeJobId: string }[];
  return { ctx, owner, allow, create, job, leads };
}

beforeEach(async () => {
  // Other tests in this file leave QUEUED jobs behind; the worker claims across all workspaces.
  await ownerPool().query("UPDATE scrape_jobs SET status = 'CANCELLED', finished_at = now() WHERE status IN ('QUEUED', 'RUNNING')");
});

describe("approved domains", () => {
  it("normalises input, lists, and removes", async () => {
    const { ctx, owner, allow } = await setup();
    const d = site();
    const added = await allow(`https://WWW.${d}/some/path?x=1`);
    expect(added.status).toBe(201);
    expect(added.body.domain).toBe(d);
    expect((await allow(d)).status).toBe(409);
    const list = await request(ctx.app).get("/api/scrape/domains").set(bearer(owner.accessToken));
    expect(list.body.items.map((x: { domain: string }) => x.domain)).toEqual([d]);
    expect((await request(ctx.app).delete(`/api/scrape/domains/${added.body.id}`).set(bearer(owner.accessToken))).status).toBe(204);
    expect((await request(ctx.app).delete(`/api/scrape/domains/${added.body.id}`).set(bearer(owner.accessToken))).status).toBe(404);
  });

  it("refuses IPs, localhost, internal names and junk", async () => {
    const { allow } = await setup();
    for (const bad of ["127.0.0.1", "http://10.0.0.5", "localhost", "intranet", "printer.local", "metadata.google.internal", "a b.com", "http://[::1]/", "javascript:alert(1)", "x"]) {
      const res = await allow(bad);
      expect(res.status, bad).toBe(400);
    }
  });

  it("members can view the list but only admins can change it", async () => {
    const { ctx, owner, allow } = await setup();
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    expect((await request(ctx.app).get("/api/scrape/domains").set(bearer(member.accessToken))).status).toBe(200);
    expect((await allow(site(), member.accessToken)).status).toBe(403);
    const d = await allow(site());
    expect((await request(ctx.app).delete(`/api/scrape/domains/${d.body.id}`).set(bearer(member.accessToken))).status).toBe(403);
  });

  it("another workspace cannot see or remove them", async () => {
    const a = await setup("domA");
    const b = await setup("domB");
    const d = await a.allow(site());
    expect((await request(b.ctx.app).get("/api/scrape/domains").set(bearer(b.owner.accessToken))).body.items).toEqual([]);
    expect((await request(b.ctx.app).delete(`/api/scrape/domains/${d.body.id}`).set(bearer(b.owner.accessToken))).status).toBe(404);
  });
});

describe("creating scrape jobs", () => {
  it("accepts approved URLs (subdomains too), queues the job and strips fragments", async () => {
    const { allow, create } = await setup();
    const d = site();
    await allow(d);
    const res = await create([`https://www.${d}/contact#team`, `https://${d}/about`, `https://www.${d}/contact`]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "QUEUED", pagesTotal: 2, pagesDone: 0, inserted: 0 });
    expect(res.body.urls).toEqual([`https://www.${d}/contact`, `https://${d}/about`]);
  });

  it("rejects everything that is not an approved public http(s) page, listing each problem", async () => {
    const { allow, create } = await setup();
    const d = site();
    await allow(d);
    const res = await create([`https://${d}/ok`, "https://not-approved.example.org/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", `https://${d}:8443/`, "http://localhost/admin", `https://u:p@${d}/`]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("URL_NOT_ALLOWED");
    expect(res.body.error.details).toHaveLength(7);
    expect(res.body.error.details[0].message).toMatch(/approved/);
  });

  it("validates the body shape", async () => {
    const { create } = await setup();
    expect((await create([])).status).toBe(400);
    expect((await create(Array.from({ length: 21 }, (_, i) => `https://x${i}.example.com/`))).status).toBe(400);
    expect((await create(["https://a.example.com"], { adapter: "evil" })).status).toBe(400);
    expect((await create(["https://a.example.com"], { idempotencyKey: "short" })).status).toBe(400);
  });

  it("is idempotent for a repeated key, returning the original job", async () => {
    const { allow, create } = await setup();
    const d = site();
    await allow(d);
    const key = `key-${randomUUID()}`;
    const first = await create([`https://${d}/`], { idempotencyKey: key });
    const second = await create([`https://${d}/`], { idempotencyKey: key });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.id).toBe(first.body.id);
  });

  it("allows at most 3 jobs in flight and 10 new jobs an hour", async () => {
    const { allow, create } = await setup();
    const d = site();
    await allow(d);
    for (let i = 0; i < 3; i++) expect((await create([`https://${d}/p${i}`])).status).toBe(201);
    const fourth = await create([`https://${d}/p3`]);
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe("TOO_MANY_JOBS");

    const b = await setup("rate");
    await b.allow(d);
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      await ownerPool().query("UPDATE scrape_jobs SET status = 'SUCCEEDED' WHERE tenant_id = $1", [b.owner.tenantId]);
      if ((await b.create([`https://${d}/q${i}`])).status === 429) limited++;
    }
    expect(limited).toBe(2);
  });

  it("is blocked when the workspace turned scraping off, and for nobody without scrape:run", async () => {
    const { ctx, owner, allow, create } = await setup();
    const d = site();
    await allow(d);
    await request(ctx.app).patch("/api/tenant/settings").set(bearer(owner.accessToken)).send({ features: { scraper: false } });
    const res = await create([`https://${d}/`]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FEATURE_DISABLED");
    expect((await request(ctx.app).post("/api/scrape/jobs").send({ urls: [`https://${d}/`] })).status).toBe(401);
  });
});

describe("running jobs", () => {
  it("scrapes pages into leads for the right workspace, with progress, source and history", async () => {
    const { owner, allow, create, job, leads, ctx } = await setup();
    const d = site();
    await allow(d);
    const created = await create([`https://${d}/`, `https://${d}/team`]);
    const { w } = worker({
      [`https://${d}/`]: html("Blossom Studios | Salon", `<a href="mailto:hello@${d}">m</a><a href="tel:+91 98765 43210">t</a>`),
      [`https://${d}/team`]: html("Blossom Studios | Team"), // same business: duplicate
    });
    expect(await w.runOnce()).toBe(true);
    const done = await job(created.body.id);
    expect(done).toMatchObject({ status: "SUCCEEDED", pagesDone: 2, pagesTotal: 2, found: 2, inserted: 1, duplicates: 1, rejected: 0, errors: [] });
    expect(done.finishedAt).not.toBeNull();

    const rows = await leads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Blossom Studios", email: `hello@${d}`, website: `https://${d}`, sourceAdapter: "generic-html", scrapeJobId: created.body.id, needsReview: false });
    const detail = await request(ctx.app).get(`/api/leads/${rows[0]!.id}`).set(bearer(owner.accessToken));
    expect(detail.body.lead.ownerId).toBeNull();
    expect(detail.body.activities[0]).toMatchObject({ type: "IMPORTED", actorType: "SYSTEM", actorId: null });
  });

  it("a second run over the same site inserts nothing new", async () => {
    const { allow, create, job } = await setup();
    const d = site();
    await allow(d);
    const pages = { [`https://${d}/`]: html("Acme Traders") };
    await create([`https://${d}/`]);
    await worker(pages).w.runOnce();
    const again = await create([`https://${d}/`]);
    await worker(pages).w.runOnce();
    expect(await job(again.body.id)).toMatchObject({ status: "SUCCEEDED", inserted: 0, duplicates: 1 });
  });

  it("two workspaces scraping the same site each get their own lead", async () => {
    const a = await setup("twoA");
    const b = await setup("twoB");
    const d = site();
    for (const t of [a, b]) { await t.allow(d); await t.create([`https://${d}/`]); }
    const { w } = worker({ [`https://${d}/`]: html("Shared Co") });
    await w.runOnce();
    await w.runOnce();
    expect(await a.leads()).toHaveLength(1);
    expect(await b.leads()).toHaveLength(1);
    expect((await a.leads())[0]!.id).not.toBe((await b.leads())[0]!.id);
  });

  it("obeys robots.txt: disallowed pages are skipped and reported, allowed ones still run", async () => {
    const { allow, create, job, leads } = await setup();
    const d = site();
    await allow(d);
    const created = await create([`https://${d}/private/x`, `https://${d}/public`]);
    const { w, calls } = worker({
      [`https://${d}/robots.txt`]: { body: "User-agent: *\nDisallow: /private/\n" },
      [`https://${d}/public`]: html("Public Co"),
      [`https://${d}/private/x`]: html("Secret Co"),
    });
    await w.runOnce();
    const done = await job(created.body.id);
    expect(done).toMatchObject({ status: "SUCCEEDED", inserted: 1, rejected: 1 });
    expect(done.errors).toEqual([{ url: `https://${d}/private/x`, message: "Blocked by the site's robots.txt" }]);
    expect(calls).not.toContain(`https://${d}/private/x`);
    expect((await leads()).map((l) => l.name)).toEqual(["Public Co"]);
  });

  it("a robots.txt server error means 'do not crawl'; a missing robots.txt means 'allowed'", async () => {
    const { allow, create, job } = await setup();
    const bad = site(), none = site();
    await allow(bad); await allow(none);
    const created = await create([`https://${bad}/`, `https://${none}/`]);
    const { w } = worker({ [`https://${bad}/robots.txt`]: { status: 503, body: "" }, [`https://${bad}/`]: html("Bad Co"), [`https://${none}/`]: html("None Co") });
    await w.runOnce();
    const done = await job(created.body.id);
    expect(done).toMatchObject({ inserted: 1, rejected: 1 });
  });

  it("throttles requests to the same host and honours Crawl-delay (capped)", async () => {
    const { allow, create } = await setup();
    const d = site();
    await allow(d);
    await create([`https://${d}/a`, `https://${d}/b`, `https://${d}/c`]);
    const { w, sleeps } = worker({ [`https://${d}/robots.txt`]: { body: "User-agent: *\nCrawl-delay: 30\n" }, [`https://${d}/a`]: html("A"), [`https://${d}/b`]: html("B"), [`https://${d}/c`]: html("C") });
    await w.runOnce();
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(sleeps.some((s) => s > 5000)).toBe(true); // the 30 s Crawl-delay was clamped to 10 s, not ignored
    expect(Math.min(...sleeps)).toBeGreaterThan(0);
  });

  it("records per-page failures without leaking internals, and marks an all-failed job FAILED", async () => {
    const { allow, create, job } = await setup();
    const d = site();
    await allow(d);
    const created = await create([`https://${d}/a`, `https://${d}/b`, `https://${d}/c`]);
    const { w } = worker({
      [`https://${d}/a`]: new FetchError("Timed out"),
      [`https://${d}/b`]: new Error("ECONNREFUSED 10.1.2.3:5432 secret stack"),
      [`https://${d}/c`]: { status: 500, body: "boom" },
    });
    await w.runOnce();
    const done = await job(created.body.id);
    expect(done.status).toBe("FAILED");
    expect(done.pagesDone).toBe(3);
    expect(done.errors.map((e: { message: string }) => e.message)).toEqual(["Timed out", "Unexpected error while reading this page", "The site answered HTTP 500"]);
    expect(JSON.stringify(done)).not.toMatch(/10\.1\.2\.3|secret stack/);
  });

  it("a page with no business name is rejected, not saved as a blank lead", async () => {
    const { allow, create, job, leads } = await setup();
    const d = site();
    await allow(d);
    const created = await create([`https://${d}/`]);
    await worker({ [`https://${d}/`]: { body: "<html><body>hi</body></html>" } }).w.runOnce();
    expect(await job(created.body.id)).toMatchObject({ status: "FAILED", rejected: 1 });
    expect(await leads()).toEqual([]);
  });

  it("cancelling a queued job stops it at once and the worker ignores it", async () => {
    const { ctx, owner, allow, create, job } = await setup();
    const d = site();
    await allow(d);
    const created = await create([`https://${d}/`]);
    const res = await request(ctx.app).post(`/api/scrape/jobs/${created.body.id}/cancel`).set(bearer(owner.accessToken));
    expect(res.body).toMatchObject({ status: "CANCELLED", cancelRequested: true });
    const { w, calls } = worker({ [`https://${d}/`]: html("Never") });
    expect(await w.runOnce()).toBe(false);
    expect(calls).toEqual([]);
    expect((await request(ctx.app).post(`/api/scrape/jobs/${created.body.id}/cancel`).set(bearer(owner.accessToken))).status).toBe(409);
    expect((await job(created.body.id)).pagesDone).toBe(0);
  });

  it("cancelling a running job stops after the page in flight", async () => {
    const { ctx, owner, allow, create, job, leads } = await setup();
    const d = site();
    await allow(d);
    const created = await create([`https://${d}/1`, `https://${d}/2`, `https://${d}/3`]);
    const web = fakeWeb({ [`https://${d}/1`]: html("One Co"), [`https://${d}/2`]: html("Two Co"), [`https://${d}/3`]: html("Three Co") });
    const w = new ScrapeWorker({
      db: appPool(), log: createLogger("silent"), minDelayMs: 0, sleep: async () => {},
      makeFetcher: (allowed) => {
        const inner = web(allowed);
        return { fetch: async (url: string) => {
          const page = await inner.fetch(url);
          if (url.endsWith("/1")) await request(ctx.app).post(`/api/scrape/jobs/${created.body.id}/cancel`).set(bearer(owner.accessToken));
          return page;
        } } as never;
      },
    });
    await w.runOnce();
    const done = await job(created.body.id);
    expect(done).toMatchObject({ status: "CANCELLED", pagesDone: 1, inserted: 1 });
    expect((await leads()).map((l) => l.name)).toEqual(["One Co"]);
  });

  it("removing an approved domain mid-run stops further fetches from it", async () => {
    const { ctx, owner, allow, create, job } = await setup();
    const d = site();
    const added = await allow(d);
    const created = await create([`https://${d}/1`, `https://${d}/2`]);
    const web = fakeWeb({ [`https://${d}/1`]: html("One Co"), [`https://${d}/2`]: html("Two Co") });
    const w = new ScrapeWorker({
      db: appPool(), log: createLogger("silent"), minDelayMs: 0, sleep: async () => {},
      makeFetcher: (allowed) => {
        const inner = web(allowed);
        return { fetch: async (url: string) => {
          const page = await inner.fetch(url);
          if (url.endsWith("/1")) await request(ctx.app).delete(`/api/scrape/domains/${added.body.id}`).set(bearer(owner.accessToken));
          return page;
        } } as never;
      },
    });
    await w.runOnce();
    const done = await job(created.body.id);
    expect(done).toMatchObject({ pagesDone: 2, inserted: 1 });
    expect(done.errors[0].message).toMatch(/approved list/);
  });

  it("two workers never take the same job; a crashed worker's stale job is taken over and resumed", async () => {
    const { allow, create, job } = await setup();
    const d = site();
    await allow(d);
    const j1 = await create([`https://${d}/1`]);
    const j2 = await create([`https://${d}/2`]);
    const pages = { [`https://${d}/1`]: html("One Co"), [`https://${d}/2`]: html("Two Co") };
    const [a, b, c] = await Promise.all([worker(pages).w.runOnce(), worker(pages).w.runOnce(), worker(pages).w.runOnce()]);
    expect([a, b, c].filter(Boolean)).toHaveLength(2);
    expect((await job(j1.body.id)).status).toBe("SUCCEEDED");
    expect((await job(j2.body.id)).status).toBe("SUCCEEDED");

    // Simulate a crash after page 1 of 2.
    const j3 = await create([`https://${d}/1`, `https://${d}/3`]);
    await ownerPool().query("UPDATE scrape_jobs SET status = 'RUNNING', locked_by = 'dead', locked_at = now() - interval '1 hour', pages_done = 1, inserted = 1 WHERE id = $1", [j3.body.id]);
    const { w, calls } = worker({ ...pages, [`https://${d}/3`]: html("Three Co") });
    expect(await w.runOnce()).toBe(true);
    expect(calls).not.toContain(`https://${d}/1`);
    expect(await job(j3.body.id)).toMatchObject({ status: "SUCCEEDED", pagesDone: 2, inserted: 1, duplicates: 1 }); // carried-over count + /3 is the same business
  });

  it("does not steal a job whose worker is still alive", async () => {
    const { allow, create } = await setup();
    const d = site();
    await allow(d);
    const j = await create([`https://${d}/1`]);
    await ownerPool().query("UPDATE scrape_jobs SET status = 'RUNNING', locked_by = 'alive', locked_at = now() WHERE id = $1", [j.body.id]);
    expect(await worker({}).w.runOnce()).toBe(false);
  });
});

describe("tenant isolation for scrape jobs", () => {
  it("other workspaces get 404 on read and cancel, and their lists are empty", async () => {
    const a = await setup("jobA");
    const b = await setup("jobB");
    const d = site();
    await a.allow(d);
    const created = await a.create([`https://${d}/`]);
    const hdr = bearer(b.owner.accessToken);
    expect((await request(b.ctx.app).get(`/api/scrape/jobs/${created.body.id}`).set(hdr)).status).toBe(404);
    expect((await request(b.ctx.app).post(`/api/scrape/jobs/${created.body.id}/cancel`).set(hdr)).status).toBe(404);
    expect((await request(b.ctx.app).get("/api/scrape/jobs").set(hdr)).body.items).toEqual([]);
    expect((await request(b.ctx.app).get("/api/scrape/jobs/not-a-uuid").set(hdr)).status).toBe(404);
    // B cannot create a job against A's approved domain.
    expect((await b.create([`https://${d}/`])).status).toBe(400);
    expect((await a.job(created.body.id)).status).toBe("QUEUED");
  });

  it("lists jobs newest first with a cursor", async () => {
    const { ctx, owner, allow, create } = await setup();
    const d = site();
    await allow(d);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await create([`https://${d}/${i}`])).body.id);
      await ownerPool().query("UPDATE scrape_jobs SET status = 'SUCCEEDED' WHERE id = $1", [ids[i]]);
    }
    const p1 = await request(ctx.app).get("/api/scrape/jobs?limit=2").set(bearer(owner.accessToken));
    const p2 = await request(ctx.app).get(`/api/scrape/jobs?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`).set(bearer(owner.accessToken));
    expect([...p1.body.items, ...p2.body.items].map((j: { id: string }) => j.id)).toEqual([...ids].reverse());
    expect(p2.body.nextCursor).toBeNull();
  });
});
