import request from "supertest";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { FoundLead, LeadSearch } from "../../src/leadFinder/models";
import { runSearch } from "../../src/leadFinder/runSearch";
import { activeSources } from "../../src/leadFinder/sources";
import { LeadFinderStore } from "../../src/leadFinder/store";
import { SourceBlockedError, type LeadSource, type RawLead, type SourceContext } from "../../src/leadFinder/types";
import { Lead } from "../../src/models/Lead";
import { Metrics } from "../../src/metrics";
import { silentLog } from "../../src/phase4/ports";
import { MAX_ACTIVE_SEARCHES_PER_USER } from "../../src/routes/leadFinderRoutes";
import { TransitionService } from "../../src/services/TransitionService";
import { MongoLeadStore } from "../../src/stores/mongoLeadStore";
import { connectTestDb, dropAndDisconnect, mongoEngine } from "../helpers/mongo";
import { requireOrWarn } from "../helpers/require";

const engine = await mongoEngine();
requireOrWarn("lead-finder.test", engine !== "none", "no MongoDB-compatible server is reachable at TEST_MONGODB_URI");

const KEY_A = "a".repeat(24);
const KEY_B = "b".repeat(24);
const A = { Authorization: `Bearer ${KEY_A}` };
const B = { Authorization: `Bearer ${KEY_B}` };
const http: SourceContext = { get: async () => "" };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const post = (over: Partial<RawLead>): RawLead => ({ externalId: "x", title: "Website for my bakery", url: "https://p.test/x", postedAt: hoursAgo(2), ...over });
const fake = (id: string, leads: RawLead[] | Error): LeadSource => ({ id, name: `Fake ${id}`, async search() { if (leads instanceof Error) throw leads; return leads; } });

describe.skipIf(engine === "none")("Lead Finder", () => {
  const store = new LeadFinderStore();
  const leads = new MongoLeadStore();
  let app: ReturnType<typeof createApp>;
  let sources: LeadSource[] = [];

  const runQueued = async (list: LeadSource[] = sources) => {
    for (let s = await store.claimNext(); s; s = await store.claimNext()) await runSearch(s, { store, sources: list, http, log: silentLog });
  };
  const search = async (h: Record<string, string>, body: object) => request(app).post("/api/lead-finder/search").set(h).send(body);
  const results = async (h: Record<string, string>, id: string, qs = "") => (await request(app).get(`/api/lead-finder/search/${id}${qs}`).set(h)).body.data;
  const profile = (h: Record<string, string>, description = "We build websites for small businesses") => request(app).post("/api/lead-finder/profile").set(h).send({ description });

  beforeAll(async () => {
    await connectTestDb("apex_finder");
    await Promise.all([FoundLead.init(), LeadSearch.init(), Lead.init()]);
    app = createApp({
      leads, transitions: new TransitionService(leads), onboard: async () => ({}) as any, log: silentLog, metrics: new Metrics(),
      apiKeys: new Map([[KEY_A, "ownerA"], [KEY_B, "ownerB"]]), checks: { mongo: () => true, redis: () => true },
      leadFinder: { store, sources: activeSources({ mock: true }), mock: true },
    });
  });
  afterAll(async () => { await dropAndDisconnect(); });

  describe("service profile", () => {
    it("requires authentication", async () => {
      expect((await request(app).get("/api/lead-finder/profile")).status).toBe(401);
      expect((await request(app).post("/api/lead-finder/search").send({ mode: "auto" })).status).toBe(401);
    });
    it("returns null before a profile exists, then stores it with extracted keywords", async () => {
      expect((await request(app).get("/api/lead-finder/profile").set(A)).body.data).toBeNull();
      const res = await profile(A);
      expect(res.status).toBe(200);
      expect(res.body.data.keywords).toEqual(expect.arrayContaining(["website", "web developer"]));
      expect((await request(app).get("/api/lead-finder/profile").set(A)).body.data.description).toMatch(/websites/);
    });
    it("lets the user edit the keywords, and saving again updates (one profile per user)", async () => {
      const res = await request(app).post("/api/lead-finder/profile").set(A).send({ description: "We build websites", keywords: ["Shopify", "shopify", " Landing Page "] });
      expect(res.body.data.keywords).toEqual(["shopify", "landing page"]);
      expect((await mongoose.connection.collection("serviceprofiles").countDocuments({ ownerId: "ownerA" }))).toBe(1);
    });
    it("rejects an empty description and suggests keywords without saving", async () => {
      expect((await request(app).post("/api/lead-finder/profile").set(A).send({ description: "" })).status).toBe(400);
      const s = await request(app).post("/api/lead-finder/keywords/suggest").set(B).send({ description: "I edit videos" });
      expect(s.body.data.keywords).toContain("video editing");
      expect((await request(app).get("/api/lead-finder/profile").set(B)).body.data).toBeNull();
    });
  });

  describe("search validation", () => {
    it("auto mode needs a profile; manual mode needs a query", async () => {
      expect((await search(B, { mode: "auto" })).status).toBe(400);
      expect((await search(A, { mode: "manual" })).status).toBe(400);
      expect((await search(A, { mode: "manual", query: "   " })).status).toBe(400);
    });
    it.each([
      [{ mode: "manual", query: "x", filters: { postedWithin: "1y" } }],
      [{ mode: "manual", query: "x", filters: { budgetMin: 500, budgetMax: 100 } }],
      [{ mode: "manual", query: "x", filters: { budgetMin: -5 } }],
      [{ mode: "manual", query: "x", filters: { surprise: true } }],
      [{ mode: "manual", query: "x", filters: { platforms: ["../etc"] } }],
      [{ mode: "weird", query: "x" }],
      [{ mode: "manual", query: "x".repeat(300) }],
    ])("rejects bad input %j", async (body) => { expect((await search(A, body)).status).toBe(400); });
  });

  describe("running a search", () => {
    it("auto mode queues a job (202) and the worker fills in scored results, best first", async () => {
      sources = activeSources({ mock: true });
      const queued = await search(A, { mode: "auto" });
      expect(queued.status).toBe(202);
      expect(queued.body.data).toMatchObject({ status: "QUEUED", mode: "auto", ownerId: "ownerA" });
      await runQueued();
      const data = await results(A, queued.body.data.id);
      expect(data.search).toMatchObject({ status: "DONE" });
      expect(data.search.sources).toEqual([expect.objectContaining({ id: "mock", status: "done" })]);
      expect(data.results.length).toBeGreaterThanOrEqual(2); // this user's edited keywords are shopify + landing page
      const scores = data.results.map((r: any) => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      expect(data.results[0]).toMatchObject({ source: "mock", url: expect.stringContaining("https://") });
      expect(data.results.every((r: any) => r.score >= 10 && r.score <= 100)).toBe(true);
    });
    it("manual mode ranks by the typed query and respects the filters and sort order", async () => {
      const q = await search(A, { mode: "manual", query: "shopify", filters: { budgetMin: 900 } });
      await runQueued();
      const data = await results(A, q.body.data.id);
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].title + data.results[0].description).toMatch(/shopify/i); // best match first
      expect(data.results.every((r: any) => (r.budgetMax ?? 0) >= 900)).toBe(true);
      const byBudget = await results(A, q.body.data.id, "?sort=budget");
      const b = byBudget.results.map((r: any) => r.budgetMax);
      expect(b).toEqual([...b].sort((x, y) => y - x));
      expect((await results(A, q.body.data.id, "?minScore=99")).results.length).toBeLessThan(data.results.length);
      expect((await request(app).get(`/api/lead-finder/search/${q.body.data.id}?sort=bogus`).set(A)).status).toBe(400);
    });
    it("posted-within filter hides old posts", async () => {
      const day = await search(A, { mode: "manual", query: "website", filters: { postedWithin: "24h" } });
      const month = await search(A, { mode: "manual", query: "website", filters: { postedWithin: "30d" } });
      await runQueued();
      const d = (await results(A, day.body.data.id)).results.length;
      const m = (await results(A, month.body.data.id)).results.length;
      expect(d).toBeLessThan(m);
    });
    it("re-running never duplicates: (owner, source, externalId) is unique", async () => {
      const before = await FoundLead.countDocuments({ ownerId: "ownerA" });
      await search(A, { mode: "auto" });
      await runQueued();
      expect(await FoundLead.countDocuments({ ownerId: "ownerA" })).toBe(before);
      await expect(FoundLead.create({ ownerId: "ownerA", source: "mock", externalId: "m01", title: "dup", url: "https://x.test" })).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe("source failures and de-duplication", () => {
    it("a blocked or crashing source only changes its own chip; the search still succeeds", async () => {
      sources = [
        fake("good", [post({ externalId: "g1", title: "Website for my bakery" })]),
        fake("blocked", new SourceBlockedError("site refused automated access (HTTP 403)")),
        fake("broken", new Error("boom")),
        { id: "slow", name: "Slow", search: () => new Promise(() => undefined) },
      ];
      const q = await search(A, { mode: "manual", query: "website bakery" });
      for (let s = await store.claimNext(); s; s = await store.claimNext()) await runSearch(s, { store, sources, http, log: silentLog, timeoutMs: 200 });
      const { search: s, results: r } = await results(A, q.body.data.id);
      const chip = Object.fromEntries(s.sources.map((c: any) => [c.id, c]));
      expect(s.status).toBe("DONE");
      expect(chip.good.status).toBe("done");
      expect(chip.blocked).toMatchObject({ status: "blocked", error: expect.stringContaining("403") });
      expect(chip.broken).toMatchObject({ status: "failed", error: "boom" });
      expect(chip.slow).toMatchObject({ status: "failed", error: expect.stringContaining("too long") });
      expect(r).toHaveLength(1);
    });
    it("when every source fails the search is FAILED with a reason", async () => {
      sources = [fake("a", new Error("x")), fake("b", new SourceBlockedError("no"))];
      const q = await search(A, { mode: "manual", query: "anything" });
      await runQueued();
      expect((await results(A, q.body.data.id)).search).toMatchObject({ status: "FAILED", error: expect.stringContaining("Every source") });
    });
    it("the platforms filter picks sources; unknown platforms fail clearly", async () => {
      sources = [fake("p1", [post({ externalId: "p1" })]), fake("p2", [post({ externalId: "p2", title: "Other website job", company: "Z" })])];
      const only = await search(A, { mode: "manual", query: "website", filters: { platforms: ["p2"] } });
      const none = await search(A, { mode: "manual", query: "website", filters: { platforms: ["nope"] } });
      await runQueued();
      expect((await results(A, only.body.data.id)).search.sources.map((c: any) => c.id)).toEqual(["p2"]);
      expect((await results(A, none.body.data.id)).search).toMatchObject({ status: "FAILED", error: expect.stringContaining("selected platforms") });
    });
    it("the same request on two platforms becomes one lead listing both links", async () => {
      sources = [
        fake("site1", [post({ externalId: "s1", title: "[HIRING] Website redesign for dental clinic", company: "Kumar Dental", url: "https://site1.test/1" })]),
        fake("site2", [post({ externalId: "t9", title: "Need: dental clinic website redesign", company: "kumar dental", url: "https://site2.test/9" })]),
      ];
      const q = await search(B, { mode: "manual", query: "website redesign" });
      await runQueued();
      const r = (await results(B, q.body.data.id)).results;
      expect(r).toHaveLength(1);
      expect(r[0].alsoOn).toHaveLength(1);
      expect([r[0].url, r[0].alsoOn[0].url].sort()).toEqual(["https://site1.test/1", "https://site2.test/9"]);
    });
  });

  describe("tenant isolation", () => {
    it("two users never see each other's profiles, searches, results or leads", async () => {
      sources = [fake("iso", [post({ externalId: "same-id", title: "Landing page for yoga studio", url: "https://iso.test/1" })])];
      await profile(B, "We design logos and brands");
      const a = await search(A, { mode: "manual", query: "yoga studio" });
      const b = await search(B, { mode: "manual", query: "yoga studio" });
      await runQueued();

      // both users found the same external post: two separate rows, one each
      expect(await FoundLead.countDocuments({ source: "iso", externalId: "same-id" })).toBe(2);
      const ra = (await results(A, a.body.data.id)).results;
      const rb = (await results(B, b.body.data.id)).results;
      expect(ra).toHaveLength(1); expect(rb).toHaveLength(1);
      expect(ra[0].id).not.toBe(rb[0].id);

      // B cannot touch A's rows by id: everything answers 404
      for (const [method, path] of [
        ["get", `/search/${a.body.data.id}`], ["post", `/search/${a.body.data.id}/save`], ["post", `/saved-searches/${a.body.data.id}/run`],
        ["post", `/leads/${ra[0].id}/save`], ["post", `/leads/${ra[0].id}/dismiss`], ["post", `/leads/${ra[0].id}/pipeline`], ["delete", `/saved-searches/${a.body.data.id}`],
      ] as const) {
        const res = await (request(app) as any)[method](`/api/lead-finder${path}`).set(B).send({ name: "x" });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      expect(await Lead.countDocuments({ source: /Lead Finder/ })).toBe(0);
      expect((await request(app).get("/api/lead-finder/profile").set(A)).body.data.description).not.toMatch(/logos/);
      expect((await request(app).get("/api/lead-finder/profile").set(B)).body.data.description).toMatch(/logos/);
    });
    it("malformed ids are 404, not 500", async () => {
      expect((await request(app).get("/api/lead-finder/search/not-an-id").set(A)).status).toBe(404);
      expect((await request(app).post("/api/lead-finder/leads/%7B%7D/pipeline").set(A)).status).toBe(404);
    });
  });

  describe("actions on a found lead", () => {
    let id: string;
    beforeAll(async () => {
      sources = [fake("act", [post({ externalId: "act1", title: "Build me a website", company: "Orchid Salon", url: "https://orchid.test/post/1" }), post({ externalId: "act2", title: "Another website job", url: "https://orchid.test/post/2" })])];
      const q = await search(A, { mode: "manual", query: "website" });
      await runQueued();
      id = (await results(A, q.body.data.id)).results.find((r: any) => r.externalId === "act1").id;
      (globalThis as any).__q = q.body.data.id;
    });
    it("Add to Sales Pipeline creates a New lead with the post link, and clicking twice makes only one", async () => {
      const first = await request(app).post(`/api/lead-finder/leads/${id}/pipeline`).set(A);
      expect(first.status).toBe(201);
      expect(first.body.data.lead).toMatchObject({ currentState: "New", company: "Orchid Salon", website: "https://orchid.test/post/1", source: "Lead Finder: Fake act", ownerId: "ownerA", version: 0 });
      const second = await request(app).post(`/api/lead-finder/leads/${id}/pipeline`).set(A);
      expect(second.body.data.lead.id).toBe(first.body.data.lead.id);
      expect(await Lead.countDocuments({ ownerId: "ownerA", source: "Lead Finder: Fake act" })).toBe(1);
      expect(first.body.data.found.status).toBe("PIPELINED");
      // the lead is a normal pipeline lead: it appears in /api/leads and can be moved
      const list = (await request(app).get("/api/leads?limit=100").set(A)).body.data;
      const lead = list.find((l: any) => l.id === first.body.data.lead.id);
      expect(lead).toBeTruthy();
      const moved = await request(app).post(`/api/leads/${lead.id}/transition`).set(A).send({ targetState: "Contacted", version: lead.version });
      expect(moved.status).toBe(200);
    });
    it("cannot dismiss a lead that is already in the pipeline", async () => {
      expect((await request(app).post(`/api/lead-finder/leads/${id}/dismiss`).set(A)).status).toBe(409);
    });
    it("save and dismiss work; dismissed leads leave the default list but can be listed", async () => {
      const other = (await results(A, (globalThis as any).__q)).results.find((r: any) => r.externalId === "act2");
      expect((await request(app).post(`/api/lead-finder/leads/${other.id}/save`).set(A)).body.data.status).toBe("SAVED");
      expect((await request(app).post(`/api/lead-finder/leads/${other.id}/dismiss`).set(A)).body.data.status).toBe("DISMISSED");
      expect((await results(A, (globalThis as any).__q)).results.find((r: any) => r.id === other.id)).toBeUndefined();
      expect((await results(A, (globalThis as any).__q, "?status=DISMISSED")).results.find((r: any) => r.id === other.id)).toBeTruthy();
    });
  });

  describe("saved searches, schedule and the new-matches badge", () => {
    it("saves a search; a due one is re-queued by the scheduler, new finds are unseen until opened", async () => {
      sources = [fake("sched", [post({ externalId: "s-old", title: "Website job one" })])];
      const first = await search(B, { mode: "manual", query: "website job", save: { name: "Website jobs", everyHours: 6 } });
      await runQueued();
      expect((await request(app).get("/api/lead-finder/summary").set(B)).body.data.unseen).toBe(0); // a search the user ran themselves is seen
      const saved = (await request(app).get("/api/lead-finder/saved-searches").set(B)).body.data;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ name: "Website jobs", everyHours: 6, status: "DONE", saved: true });
      expect((await request(app).get("/api/lead-finder/saved-searches").set(A)).body.data.find((s: any) => s.name === "Website jobs")).toBeUndefined();

      expect(await store.queueDue()).toBe(0); // not due yet
      await LeadSearch.updateOne({ _id: first.body.data.id }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
      sources = [fake("sched", [post({ externalId: "s-old", title: "Website job one" }), post({ externalId: "s-new", title: "Website job two, brand new" })])];
      expect(await store.queueDue()).toBe(1);
      expect(await store.queueDue()).toBe(0); // queued only once
      await runQueued();

      expect((await request(app).get("/api/lead-finder/summary").set(B)).body.data.unseen).toBe(1);
      expect((await request(app).get("/api/lead-finder/summary").set(A)).body.data.unseen).toBe(0);
      const after = (await request(app).get("/api/lead-finder/saved-searches").set(B)).body.data[0];
      expect(after).toMatchObject({ newCount: 1, unseen: 1, runs: 2 });
      expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(Date.now());
      await request(app).post("/api/lead-finder/seen").set(B);
      expect((await request(app).get("/api/lead-finder/summary").set(B)).body.data.unseen).toBe(0);
    });
    it("Run now re-queues a finished saved search and refuses while it is already running", async () => {
      const saved = (await request(app).get("/api/lead-finder/saved-searches").set(B)).body.data[0];
      const run = await request(app).post(`/api/lead-finder/saved-searches/${saved.id}/run`).set(B);
      expect(run.status).toBe(202);
      expect((await request(app).post(`/api/lead-finder/saved-searches/${saved.id}/run`).set(B)).status).toBe(409);
      await runQueued();
    });
    it("an existing search can be saved afterwards, and unsaved again", async () => {
      sources = [fake("later", [post({ externalId: "l1" })])];
      const s = await search(A, { mode: "manual", query: "bakery" });
      await runQueued();
      const saved = await request(app).post(`/api/lead-finder/search/${s.body.data.id}/save`).set(A).send({ name: "Bakery", everyHours: 0 });
      expect(saved.body.data).toMatchObject({ saved: true, name: "Bakery" });
      expect((await request(app).delete(`/api/lead-finder/saved-searches/${s.body.data.id}`).set(A)).status).toBe(200);
      expect((await request(app).get("/api/lead-finder/saved-searches").set(A)).body.data.find((x: any) => x.id === s.body.data.id)).toBeUndefined();
    });
    it("crashed workers: a search stuck RUNNING is failed after the timeout", async () => {
      const s = await search(A, { mode: "manual", query: "stuck" });
      await store.claimNext();
      await LeadSearch.updateOne({ _id: s.body.data.id }, { $set: { startedAt: new Date(Date.now() - 20 * 60_000) } });
      expect(await store.recoverStale(10 * 60_000)).toBeGreaterThanOrEqual(1);
      expect((await results(A, s.body.data.id)).search.status).toBe("FAILED");
    });
  });

  it("limits how many searches one user can have waiting", async () => {
    await runQueued(); // drain anything left over
    for (let i = 0; i < MAX_ACTIVE_SEARCHES_PER_USER; i++) expect((await search(A, { mode: "manual", query: `q${i}` })).status).toBe(202);
    expect((await search(A, { mode: "manual", query: "one more" })).status).toBe(409);
    expect((await search(B, { mode: "manual", query: "other user is fine" })).status).toBe(202);
    await runQueued();
  });

  it("lists the available platforms and whether demo mode is on", async () => {
    const r = await request(app).get("/api/lead-finder/sources").set(A);
    expect(r.body.data).toEqual({ mock: true, sources: [{ id: "mock", name: "Sample data (demo)" }] });
  });
});
