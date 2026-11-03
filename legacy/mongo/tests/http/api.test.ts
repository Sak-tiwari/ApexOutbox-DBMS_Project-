import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { Metrics } from "../../src/metrics";
import { silentLog } from "../../src/phase4/ports";
import { TransitionService } from "../../src/services/TransitionService";
import { MemoryLeadStore } from "../helpers/memory";

const KEY_A = "a".repeat(24);
const KEY_B = "b".repeat(24);
const deal = { email: "asha@example.com", amount: 5000, currency: "INR", description: "Website build" };

function build(opts: { onboard?: (d: any) => Promise<any>; redisUp?: boolean } = {}) {
  const leads = new MemoryLeadStore();
  leads.seed({ id: "L1", ownerId: "ownerA" });
  const onboardCalls: any[] = [];
  const onboard = opts.onboard ?? (async (d: any) => { onboardCalls.push(d); return { clientId: "c1", invoiceId: "i1", invoiceNumber: "INV-1", status: "PENDING" }; });
  const metrics = new Metrics();
  const app = createApp({
    leads, transitions: new TransitionService(leads), onboard, log: silentLog, metrics,
    apiKeys: new Map([[KEY_A, "ownerA"], [KEY_B, "ownerB"]]),
    checks: { mongo: () => true, redis: () => opts.redisUp ?? true },
  });
  return { app, leads, onboardCalls, metrics };
}
const authA = { Authorization: `Bearer ${KEY_A}` };
const post = (app: any, body: object, headers: Record<string, string> = authA, id = "L1") => request(app).post(`/api/leads/${id}/transition`).set(headers).send(body);

describe("authentication", () => {
  it("rejects requests without credentials (401)", async () => {
    const { app } = build();
    expect((await request(app).get("/api/leads/L1")).status).toBe(401);
    expect((await request(app).post("/api/leads/L1/transition").send({ targetState: "Contacted", version: 0 })).status).toBe(401);
    expect((await request(app).post("/api/phase4/onboard").send({})).status).toBe(401);
    expect((await request(app).get("/metrics")).status).toBe(401);
  });

  it("rejects a wrong key (401) and accepts x-api-key as well as Bearer", async () => {
    const { app } = build();
    expect((await request(app).get("/api/leads/L1").set("Authorization", "Bearer wrong-key-wrong-key-xx")).status).toBe(401);
    expect((await request(app).get("/api/leads/L1").set("x-api-key", KEY_A)).status).toBe(200);
  });

  it("ignores the old x-user-id header: it can no longer impersonate the owner", async () => {
    const { app, leads } = build();
    const res = await post(app, { targetState: "Contacted", version: 0 }, { Authorization: `Bearer ${KEY_B}`, "x-user-id": "ownerA" });
    expect(res.status).toBe(403);
    expect(leads.leads.get("L1")!.currentState).toBe("New");
  });
});

describe("transition endpoint", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });

  it("200 on a valid move, with the new version", async () => {
    const res = await post(ctx.app, { targetState: "Contacted", version: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.currentState).toBe("Contacted");
    expect(res.body.data.version).toBe(1);
  });

  it.each([
    ["stale version", { targetState: "Contacted", version: 5 }, "L1", 409, "VERSION_CONFLICT"],
    ["illegal jump", { targetState: "Negotiation", version: 0 }, "L1", 422, "INVALID_TRANSITION"],
    ["unknown lead", { targetState: "Contacted", version: 0 }, "does-not-exist", 404, "NOT_FOUND"],
    ["missing version", { targetState: "Contacted" }, "L1", 400, "VALIDATION_ERROR"],
    ["bad state name", { targetState: "Banana", version: 0 }, "L1", 400, "VALIDATION_ERROR"],
    ["negative version", { targetState: "Contacted", version: -1 }, "L1", 400, "VALIDATION_ERROR"],
  ])("%s -> %i %s", async (_name, body, id, status, code) => {
    const res = await post(ctx.app, body, authA, id as string);
    expect([res.status, res.body.code]).toEqual([status, code]);
    expect(res.body.success).toBe(false);
  });

  it("422 lists the legal next states", async () => {
    const res = await post(ctx.app, { targetState: "Negotiation", version: 0 });
    expect(res.body.details.allowed).toEqual(["Contacted", "Closed-Lost"]);
  });

  it("malformed JSON is a clean 400, not a 500", async () => {
    const res = await request(ctx.app).post("/api/leads/L1/transition").set(authA).set("Content-Type", "application/json").send("{not json");
    expect([res.status, res.body.code]).toEqual([400, "VALIDATION_ERROR"]);
  });

  it("an oversized body is rejected (413)", async () => {
    const res = await post(ctx.app, { targetState: "Contacted", version: 0, reason: "x".repeat(200_000) });
    expect(res.status).toBe(413);
  });
});

describe("Closed-Won hand-off over HTTP", () => {
  const toNegotiation = async (c: ReturnType<typeof build>) => { c.leads.leads.get("L1")!.currentState = "Negotiation"; };

  it("requires a deal (400 DEAL_REQUIRED) and does not change the lead", async () => {
    const c = build(); await toNegotiation(c);
    const res = await post(c.app, { targetState: "Closed-Won", version: 0 });
    expect([res.status, res.body.code]).toEqual([400, "DEAL_REQUIRED"]);
    expect(c.leads.leads.get("L1")!.currentState).toBe("Negotiation");
  });

  it("validates the deal (bad email, 3 decimal places)", async () => {
    const c = build(); await toNegotiation(c);
    expect((await post(c.app, { targetState: "Closed-Won", version: 0, deal: { ...deal, email: "nope" } })).status).toBe(400);
    expect((await post(c.app, { targetState: "Closed-Won", version: 0, deal: { ...deal, amount: 10.005 } })).status).toBe(400);
  });

  it("onboards exactly once and reports DONE", async () => {
    const c = build(); await toNegotiation(c);
    const res = await post(c.app, { targetState: "Closed-Won", version: 0, deal });
    expect(res.status).toBe(200);
    expect(res.body.onboarding).toBe("DONE");
    expect(c.onboardCalls).toHaveLength(1);
    expect(c.onboardCalls[0]).toMatchObject({ leadId: "L1", email: "asha@example.com", amount: 5000 });
  });

  it("if onboarding fails, the lead is still Closed-Won (200) and reports PENDING for the reconciler", async () => {
    const c = build({ onboard: async () => { throw new Error("db down"); } }); await toNegotiation(c);
    const res = await post(c.app, { targetState: "Closed-Won", version: 0, deal });
    expect(res.status).toBe(200);
    expect(res.body.data.currentState).toBe("Closed-Won");
    expect(res.body.onboarding).toBe("PENDING");
    expect(c.leads.leads.get("L1")!.onboardingStatus).toBe("PENDING");
  });

  it("a replayed request with the old version gets 409 and does not onboard again", async () => {
    const c = build(); await toNegotiation(c);
    await post(c.app, { targetState: "Closed-Won", version: 0, deal });
    const again = await post(c.app, { targetState: "Closed-Won", version: 0, deal });
    expect(again.status).toBe(409);
    expect(c.onboardCalls).toHaveLength(1);
  });
});

describe("errors, health and metrics", () => {
  it("an unexpected error returns a generic 500 and never leaks internals", async () => {
    const c = build({});
    c.leads.findById = async () => { throw new Error("connect ECONNREFUSED mongodb://user:secret@db:27017"); };
    const res = await request(c.app).get("/api/leads/L1").set(authA);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|mongodb|ECONNREFUSED/);
    expect(res.body.code).toBe("INTERNAL");
  });

  it("/health is up regardless; /ready is 503 when Redis is down", async () => {
    const down = build({ redisUp: false });
    expect((await request(down.app).get("/health")).status).toBe(200);
    const ready = await request(down.app).get("/ready");
    expect([ready.status, ready.body.checks]).toEqual([503, { mongo: "up", redis: "down" }]);
    expect((await request(build().app).get("/ready")).status).toBe(200);
  });

  it("/ready survives a probe that throws or hangs", async () => {
    const c = build();
    const app = createApp({ leads: c.leads, transitions: new TransitionService(c.leads), onboard: async () => ({} as any), log: silentLog, metrics: new Metrics(), apiKeys: new Map(), checks: { mongo: () => { throw new Error("x"); }, redis: () => new Promise(() => {}) } });
    const t = Date.now();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it("/metrics exposes counters and business gauges to authenticated callers", async () => {
    const leads = new MemoryLeadStore(); leads.seed({ id: "L1", ownerId: "ownerA" });
    const metrics = new Metrics();
    const app = createApp({ leads, transitions: new TransitionService(leads), onboard: async () => ({} as any), log: silentLog, metrics, apiKeys: new Map([[KEY_A, "ownerA"]]), checks: { mongo: () => true, redis: () => true }, gauges: async () => ({ apexoutbox_invoices_email_uncertain: 2 }) });
    await post(app, { targetState: "Contacted", version: 0 });
    await post(app, { targetState: "New", version: 1 }); // Contacted -> New is not allowed
    const text = (await request(app).get("/metrics").set(authA)).text;
    expect(text).toContain('apexoutbox_transitions_total{outcome="OK"} 1');
    expect(text).toContain('apexoutbox_transitions_total{outcome="INVALID_TRANSITION"} 1');
    expect(text).toContain("apexoutbox_invoices_email_uncertain 2");
    expect(text).toMatch(/apexoutbox_http_requests_total\{status="2xx"\} \d+/);
  });

  it("unknown routes return JSON 404 without requiring auth to learn that", async () => {
    const res = await request(build().app).get("/nope");
    expect([res.status, res.body.code]).toEqual([404, "NOT_FOUND"]);
  });
});

import { rateLimit } from "../../src/middleware/rateLimit";

describe("lead creation, listing and paging", () => {
  it("creates a lead owned by the calling key, ignoring any ownerId in the body", async () => {
    const { app } = build();
    const res = await request(app).post("/api/leads").set(authA).send({ name: " Asha ", company: "Acme", ownerId: "someone-else" });
    expect(res.status).toBe(201);
    expect([res.body.data.name, res.body.data.ownerId, res.body.data.currentState, res.body.data.version]).toEqual(["Asha", "ownerA", "New", 0]);
    expect((await request(app).post("/api/leads").set(authA).send({ name: "", company: "Acme" })).status).toBe(400);
    expect((await request(app).post("/api/leads").send({ name: "A", company: "B" })).status).toBe(401);
  });

  it("pages with limit and an opaque cursor, and filters by state", async () => {
    const { app, leads } = build();
    for (const n of [2, 3, 4, 5]) leads.seed({ id: `L${n}`, ownerId: "ownerA", currentState: n % 2 ? "Contacted" : "New" });
    const first = await request(app).get("/api/leads").query({ limit: 2 }).set(authA);
    expect(first.body.data.map((l: any) => l.id)).toEqual(["L1", "L2"]);
    expect(first.body.data[0].activityHistory).toBeUndefined();
    const second = await request(app).get("/api/leads").query({ limit: 2, cursor: first.body.nextCursor }).set(authA);
    expect(second.body.data.map((l: any) => l.id)).toEqual(["L3", "L4"]);
    const last = await request(app).get("/api/leads").query({ limit: 2, cursor: second.body.nextCursor }).set(authA);
    expect([last.body.data.map((l: any) => l.id), last.body.nextCursor]).toEqual([["L5"], null]);
    const contacted = await request(app).get("/api/leads").query({ state: "Contacted" }).set(authA);
    expect(contacted.body.data.map((l: any) => l.id)).toEqual(["L3", "L5"]);
  });

  it("rejects bad paging input (400)", async () => {
    const { app } = build();
    for (const q of [{ limit: 0 }, { limit: 101 }, { limit: "abc" }, { cursor: "!!!not-base64!!!" }, { state: "Nope" }]) {
      expect((await request(app).get("/api/leads").query(q).set(authA)).status).toBe(400);
    }
  });
});

describe("version field", () => {
  it("accepts a numeric string and rejects empty, fractional, negative and non-numeric values", async () => {
    const { app, leads } = build();
    expect((await post(app, { targetState: "Contacted", version: "0" })).status).toBe(200);
    expect(leads.leads.get("L1")!.currentState).toBe("Contacted");
    for (const bad of ["", "1.5", "-1", "abc", null, 1.5, -1]) {
      expect((await post(app, { targetState: "Follow-up", version: bad })).status).toBe(400);
    }
  });
});

describe("re-opening a won lead before onboarding finished", () => {
  it("cancels the pending onboarding so the reconciler never bills a lead that is no longer won", async () => {
    const { app, leads } = build({ onboard: async () => { throw new Error("db blip"); } });
    for (const [to, v] of [["Contacted", 0], ["Negotiation", 1]] as const) await post(app, { targetState: to, version: v });
    const won = await post(app, { targetState: "Closed-Won", version: 2, deal });
    expect(won.body.onboarding).toBe("PENDING");
    const reopened = await post(app, { targetState: "Negotiation", version: 3, reason: "Client asked to renegotiate" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.onboardingStatus).toBe("CANCELLED");
    expect(await leads.findOnboardingPending(10)).toEqual([]);
  });

  it("keeps DONE when the client was already onboarded", async () => {
    const { app } = build();
    for (const [to, v] of [["Contacted", 0], ["Negotiation", 1]] as const) await post(app, { targetState: to, version: v });
    await post(app, { targetState: "Closed-Won", version: 2, deal });
    const reopened = await post(app, { targetState: "Negotiation", version: 3, reason: "Scope change after signing" });
    expect(reopened.body.data.onboardingStatus).toBe("DONE");
  });
});

describe("rate limiting", () => {
  it("answers 429 with Retry-After after the limit, then recovers in the next window", async () => {
    let t = 1_000_000;
    const mw = rateLimit({ limit: 2, windowMs: 60_000, now: () => t });
    const run = () => { const out: any = { headers: {} }; mw({ ip: "1.2.3.4" } as any, { setHeader: (k: string, v: string) => (out.headers[k] = v), status: (c: number) => ({ json: (b: any) => Object.assign(out, { status: c, body: b }) }) } as any, () => (out.passed = true)); return out; };
    expect([run().passed, run().passed]).toEqual([true, true]);
    const blocked = run();
    expect([blocked.status, blocked.body.code, blocked.headers["Retry-After"]]).toEqual([429, "RATE_LIMITED", "60"]);
    t += 61_000;
    expect(run().passed).toBe(true);
  });

  it("is applied to /api by createApp but never to /health", async () => {
    const leads = new MemoryLeadStore();
    const app = createApp({ leads, transitions: new TransitionService(leads), onboard: async () => ({} as any), log: silentLog, metrics: new Metrics(), apiKeys: new Map([[KEY_A, "ownerA"]]), checks: { mongo: () => true, redis: () => true }, rateLimitPerMinute: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).get("/api/leads").set(authA)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await request(app).get("/health")).status).toBe(200);
  });
});
