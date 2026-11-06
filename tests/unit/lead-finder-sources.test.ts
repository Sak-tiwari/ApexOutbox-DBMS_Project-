import { describe, expect, it, vi } from "vitest";
import { createHttp } from "../../src/leadFinder/http";
import { mockSource } from "../../src/leadFinder/sources/mock";
import { redditSource } from "../../src/leadFinder/sources/reddit";
import { remoteOkSource } from "../../src/leadFinder/sources/remoteok";
import { remotiveSource } from "../../src/leadFinder/sources/remotive";
import { weWorkRemotelySource } from "../../src/leadFinder/sources/weworkremotely";
import { activeSources } from "../../src/leadFinder/sources";
import { SourceBlockedError, type SourceContext } from "../../src/leadFinder/types";

const ctxWith = (routes: Record<string, string>): SourceContext => ({
  async get(url) {
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) throw new Error("HTTP 404");
    return hit[1];
  },
});
const q = { keywords: ["website"], filters: {} };

describe("source modules parse real response shapes", () => {
  it("reddit: keeps only [HIRING]/[TASK] posts, strips the tag, links to the post", async () => {
    const body = JSON.stringify({ data: { children: [
      { data: { id: "a1", title: "[HIRING] Shopify developer for my store", selftext: "Budget: $300-$500", author: "bob", permalink: "/r/forhire/comments/a1/x/", created_utc: 1_762_400_000 } },
      { data: { id: "a2", title: "[FOR HIRE] I do websites", selftext: "", author: "eve", permalink: "/r/forhire/comments/a2/x/", created_utc: 1_762_400_000 } },
    ] } });
    const r = await redditSource({ baseUrl: "https://reddit.test", subreddits: [{ name: "forhire", hiring: /\[hiring\]/i }] }).search(q, ctxWith({ "/r/forhire/": body }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ externalId: "forhire:a1", title: "Shopify developer for my store", company: "u/bob", url: "https://www.reddit.com/r/forhire/comments/a1/x/", budgetMin: 300, budgetMax: 500 });
  });
  it("reddit: one subreddit failing does not lose the others; all failing reports the error", async () => {
    const good = JSON.stringify({ data: { children: [{ data: { id: "z", title: "[TASK] logo", permalink: "/p", created_utc: 1 } }] } });
    const partial = await redditSource({ baseUrl: "https://r.test", subreddits: [{ name: "bad", hiring: /./ }, { name: "ok", hiring: /./ }] }).search(q, ctxWith({ "/r/ok/": good }));
    expect(partial).toHaveLength(1);
    await expect(redditSource({ baseUrl: "https://r.test", subreddits: [{ name: "bad", hiring: /./ }] }).search(q, ctxWith({}))).rejects.toThrow();
  });
  it("remoteok: skips the legal-notice row and strips HTML", async () => {
    const body = JSON.stringify([{ legal: "terms" }, { id: 7, position: "Web Developer", company: "Acme", url: "https://remoteok.com/remote-jobs/7", description: "<p>Build <b>websites</b></p>", tags: ["react"], salary_min: 50000, salary_max: 70000, date: "2026-11-05T00:00:00Z" }]);
    const r = await remoteOkSource({ baseUrl: "https://ro.test" }).search(q, ctxWith({ "/api": body }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ externalId: "7", title: "Web Developer", company: "Acme", budgetMin: 50000 });
    expect(r[0].description).toContain("Build websites");
    expect(r[0].description).not.toContain("<");
  });
  it("remotive: searches each keyword and de-duplicates ids", async () => {
    const body = JSON.stringify({ jobs: [{ id: 1, title: "Frontend dev", url: "https://remotive.com/j/1", company_name: "X", description: "<b>hi</b>", publication_date: "2026-11-01T00:00:00" }] });
    const r = await remotiveSource({ baseUrl: "https://rm.test" }).search({ keywords: ["a", "b"], filters: {} }, ctxWith({ "/api/remote-jobs": body }));
    expect(r).toHaveLength(1);
  });
  it("weworkremotely: parses RSS items", async () => {
    const rss = `<rss><channel><item><title>Acme: React Developer</title><link>https://weworkremotely.com/jobs/1</link><pubDate>Wed, 05 Nov 2026 10:00:00 +0000</pubDate><description>&lt;p&gt;Build UI&lt;/p&gt;</description><region>Anywhere</region></item></channel></rss>`;
    const r = await weWorkRemotelySource({ baseUrl: "https://w.test", feeds: ["/f.rss"] }).search(q, ctxWith({ "/f.rss": rss }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ company: "Acme", title: "React Developer", url: "https://weworkremotely.com/jobs/1", location: "Anywhere" });
    expect(r[0].description).toBe("Build UI");
  });
  it("garbage responses throw instead of returning junk", async () => {
    await expect(remoteOkSource({ baseUrl: "https://ro.test" }).search(q, ctxWith({ "/api": "<html>captcha</html>" }))).rejects.toThrow();
  });
  it("mock source returns 16 realistic leads; mock mode uses only the mock source", async () => {
    const r = await mockSource().search(q, ctxWith({}));
    expect(r).toHaveLength(16);
    expect(new Set(r.map((x) => x.externalId)).size).toBe(16);
    expect(activeSources({ mock: true }).map((s) => s.id)).toEqual(["mock"]);
    expect(activeSources({ mock: false }).map((s) => s.id)).toEqual(["reddit", "remoteok", "remotive", "weworkremotely"]);
    expect(activeSources({ mock: false, disabled: ["reddit"] }).map((s) => s.id)).not.toContain("reddit");
    for (const banned of ["fiverr", "upwork", "glassdoor", "indeed", "linkedin"]) expect(activeSources({ mock: false }).map((s) => s.id)).not.toContain(banned);
  });
});

describe("polite HTTP helper", () => {
  const res = (status: number, body = "ok", headers: Record<string, string> = {}) => new Response(body, { status, headers });
  const noSleep = async () => undefined;

  it("retries network errors and 5xx with growing waits, then succeeds", async () => {
    const sleeps: number[] = [];
    const f = vi.fn().mockRejectedValueOnce(new Error("reset")).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200, "fine"));
    const http = createHttp({ fetchImpl: f as any, sleep: async (ms) => { sleeps.push(ms); }, minIntervalMs: 0 });
    expect(await http.get("https://a.test/x")).toBe("fine");
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
  });
  it("gives up after the retries and reports a readable error", async () => {
    const http = createHttp({ fetchImpl: vi.fn().mockResolvedValue(res(500)) as any, sleep: noSleep, minIntervalMs: 0, retries: 1 });
    await expect(http.get("https://a.test/x")).rejects.toThrow(/HTTP 500/);
  });
  it.each([401, 403, 429])("HTTP %i is 'blocked' and is never retried", async (status) => {
    const f = vi.fn().mockResolvedValue(res(status));
    const http = createHttp({ fetchImpl: f as any, sleep: noSleep, minIntervalMs: 0 });
    await expect(http.get("https://a.test/x")).rejects.toBeInstanceOf(SourceBlockedError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("identical requests are served from the cache, and the cache expires", async () => {
    const f = vi.fn().mockImplementation(async () => res(200, "body"));
    let t = 0;
    const realNow = Date.now; Date.now = () => t;
    try {
      const http = createHttp({ fetchImpl: f as any, sleep: noSleep, minIntervalMs: 0, cacheTtlMs: 1000 });
      await http.get("https://a.test/x"); await http.get("https://a.test/x");
      expect(f).toHaveBeenCalledTimes(1);
      t = 2000; await http.get("https://a.test/x");
      expect(f).toHaveBeenCalledTimes(2);
    } finally { Date.now = realNow; }
  });
  it("spaces requests to the same host, sends an identifying user agent, and rejects oversized bodies", async () => {
    const waits: number[] = [];
    const f = vi.fn().mockImplementation(async () => res(200, "x"));
    const http = createHttp({ fetchImpl: f as any, sleep: async (ms) => { waits.push(ms); }, minIntervalMs: 1000 });
    await http.get("https://a.test/1"); await http.get("https://a.test/2");
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect((f.mock.calls[0][1] as any).headers["user-agent"]).toMatch(/ApexOutbox/);
    const big = createHttp({ fetchImpl: vi.fn().mockResolvedValue(res(200, "x".repeat(50))) as any, sleep: noSleep, minIntervalMs: 0, maxBytes: 10, retries: 0 });
    await expect(big.get("https://a.test/big")).rejects.toThrow(/too large/);
  });
});
