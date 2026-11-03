import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, makeApp, newAccount, type Account, type TestCtx } from "../helpers/app.js";
import { closePools } from "../helpers/db.js";

afterAll(closePools);

/**
 * The cross-tenant sweep: tenant A owns one of everything; tenant B (a full OWNER of its own workspace) then tries every
 * id-addressed route against A's ids. The answer must be 404, identical to "no such id", and A's data must be unchanged.
 */
let ctx: TestCtx;
let a: Account;
let b: Account;
const ids: Record<string, string> = {};
const tag = randomUUID().slice(0, 8);

beforeAll(async () => {
  ctx = makeApp();
  a = await newAccount(ctx, "sweep-a");
  b = await newAccount(ctx, "sweep-b");
  const A = (m: "post" | "get", url: string, body?: object) => request(ctx.app)[m](url).set(bearer(a.accessToken)).send(body);

  const lead = await A("post", "/api/leads", { name: `Sweep ${tag}`, companyName: "A Co", website: `https://a-${tag}.example.com` });
  ids.lead = lead.body.id;
  const toWin = await A("post", "/api/leads", { name: `Win ${tag}`, website: `https://w-${tag}.example.com` });
  await A("post", `/api/leads/${toWin.body.id}/transition`, { to: "CONTACTED", version: 0 });
  await A("post", `/api/leads/${toWin.body.id}/transition`, { to: "NEGOTIATION", version: 1 });
  const won = await A("post", `/api/leads/${toWin.body.id}/transition`, {
    to: "CLOSED_WON", version: 2, deal: { email: `sweep-${tag}@client.example.com`, items: [{ description: "Work", quantity: 1, unitAmountMinor: 100_000 }] },
  });
  expect(won.status, JSON.stringify(won.body)).toBe(200);
  ids.client = won.body.conversion.clientId;
  ids.invoice = won.body.conversion.invoiceId;
  ids.email = (await A("get", "/api/emails")).body.items[0].id;
  const dom = await A("post", "/api/scrape/domains", { domain: `a-${tag}.example.com` });
  ids.domain = dom.body.id;
  const job = await A("post", "/api/scrape/jobs", { urls: [`https://a-${tag}.example.com/`] });
  expect(job.status, JSON.stringify(job.body)).toBeLessThan(300);
  ids.job = job.body.id;
  const user = await A("post", "/api/users", { email: `sweep-user-${tag}@example.com`, name: "A User", role: "MEMBER" });
  ids.user = user.body.user.id;
  for (const [k, v] of Object.entries(ids)) expect(v, k).toBeTruthy();
});

type Case = [method: "get" | "post" | "patch" | "delete", path: (i: typeof ids) => string, body?: object];
const CASES: Case[] = [
  ["get", (i) => `/api/leads/${i.lead}`],
  ["patch", (i) => `/api/leads/${i.lead}`, { name: "Hijacked", version: 0 }],
  ["post", (i) => `/api/leads/${i.lead}/transition`, { to: "CONTACTED", version: 0 }],
  ["post", (i) => `/api/leads/${i.lead}/notes`, { note: "hello" }],
  ["delete", (i) => `/api/leads/${i.lead}`],
  ["get", (i) => `/api/clients/${i.client}`],
  ["patch", (i) => `/api/clients/${i.client}`, { name: "Hijacked" }],
  ["get", (i) => `/api/invoices/${i.invoice}`],
  ["get", (i) => `/api/invoices/${i.invoice}/pdf`],
  ["post", (i) => `/api/invoices/${i.invoice}/mark-paid`],
  ["post", (i) => `/api/invoices/${i.invoice}/void`, { reason: "attack" }],
  ["post", (i) => `/api/invoices/${i.invoice}/resend`, {}],
  ["post", (i) => `/api/emails/${i.email}/retry`],
  ["post", (i) => `/api/emails/${i.email}/resolve`, { outcome: "delivered" }],
  ["get", (i) => `/api/scrape/jobs/${i.job}`],
  ["post", (i) => `/api/scrape/jobs/${i.job}/cancel`],
  ["delete", (i) => `/api/scrape/domains/${i.domain}`],
  ["patch", (i) => `/api/users/${i.user}`, { role: "OWNER" }],
  ["delete", (i) => `/api/users/${i.user}`],
  ["post", (i) => `/api/users/${i.user}/reset-password`],
];

describe("tenant B cannot touch tenant A's records through any id route", () => {
  it.each(CASES.map((c) => [`${c[0].toUpperCase()} ${c[1]({ lead: ":lead", client: ":client", invoice: ":invoice", email: ":email", job: ":job", domain: ":domain", user: ":user" })}`, c] as const))("%s -> 404", async (_name, c) => {
    const [method, path, body] = c;
    const res = await request(ctx.app)[method](path(ids)).set(bearer(b.accessToken)).send(body);
    expect(res.status, `${res.status} ${JSON.stringify(res.body)}`).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(tag); // nothing about A leaks in the error either
    expect(JSON.stringify(res.body)).not.toContain(a.tenantId);
  });

  it("returns the SAME 404 as for an id that never existed (no existence oracle)", async () => {
    const real = await request(ctx.app).get(`/api/invoices/${ids.invoice}`).set(bearer(b.accessToken));
    const fake = await request(ctx.app).get(`/api/invoices/${randomUUID()}`).set(bearer(b.accessToken));
    expect(real.status).toBe(fake.status);
    expect(real.body).toEqual(fake.body);
  });

  it("A's data is exactly as A left it", async () => {
    const A = (url: string) => request(ctx.app).get(url).set(bearer(a.accessToken));
    const lead = await A(`/api/leads/${ids.lead}`);
    expect(lead.body.lead).toMatchObject({ name: `Sweep ${tag}`, status: "NEW", version: 0 });
    expect((await A(`/api/invoices/${ids.invoice}`)).body.status).not.toBe("VOID");
    expect((await A(`/api/clients/${ids.client}`)).body.name).not.toBe("Hijacked");
    expect((await A("/api/scrape/domains")).body.items.some((d: { id: string }) => d.id === ids.domain)).toBe(true);
    expect((await A("/api/users")).body.items.some((u: { id: string }) => u.id === ids.user)).toBe(true);
  });
});

describe("list, stats, search and export never include another tenant's rows", () => {
  const LISTS = ["/api/leads", "/api/leads?q=Sweep", "/api/clients", "/api/invoices", "/api/emails", "/api/scrape/jobs", "/api/scrape/domains", "/api/users", "/api/audit"];
  it.each(LISTS)("GET %s", async (url) => {
    const res = await request(ctx.app).get(`${url}${url.includes("?") ? "&" : "?"}limit=100`).set(bearer(b.accessToken));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const v of Object.values(ids)) expect(text, `${url} leaked ${v}`).not.toContain(v);
    expect(text).not.toContain(tag);
    expect(text).not.toContain(a.userId);
  });

  it("stats are computed per tenant", async () => {
    const mine = await request(ctx.app).get("/api/leads/stats").set(bearer(b.accessToken));
    expect(mine.body.total).toBe(0);
    expect((await request(ctx.app).get("/api/invoices/stats").set(bearer(b.accessToken))).body.outstandingMinor).toBe(0);
    expect((await request(ctx.app).get("/api/emails/stats").set(bearer(b.accessToken))).body.needsAttention).toBe(0);
  });

  it.each(["leads", "clients", "invoices"])("CSV export of %s", async (e) => {
    const res = await request(ctx.app).get(`/api/export/${e}.csv`).set(bearer(b.accessToken));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(tag);
    expect(res.text.trim().split(/\r?\n/)).toHaveLength(1); // header only
  });

  it("a foreign lead id inside a body cannot be attached to B's records", async () => {
    const res = await request(ctx.app).post("/api/leads").set(bearer(b.accessToken)).send({ name: "B lead", ownerId: a.userId });
    expect(res.status === 201 ? res.body.ownerId : null).not.toBe(a.userId);
  });
});

describe("every protected route rejects anonymous callers", () => {
  const ROUTES: [string, string][] = [
    ["get", "/api/me"], ["get", "/api/leads"], ["post", "/api/leads"], ["get", "/api/leads/stats"], ["post", "/api/leads/import"],
    ["get", "/api/clients"], ["get", "/api/invoices"], ["get", "/api/invoices/stats"], ["get", "/api/emails"], ["get", "/api/emails/stats"],
    ["get", "/api/scrape/jobs"], ["post", "/api/scrape/jobs"], ["get", "/api/scrape/domains"], ["post", "/api/scrape/domains"],
    ["get", "/api/users"], ["post", "/api/users"], ["get", "/api/audit"], ["get", "/api/export/leads.csv"], ["delete", "/api/me"],
    ["delete", "/api/tenant"], ["patch", "/api/tenant"], ["patch", "/api/tenant/settings"], ["post", "/api/auth/logout-all"],
    ["post", "/api/auth/2fa/setup"], ["post", "/api/auth/password/change"],
  ];
  it.each(ROUTES)("%s %s -> 401", async (m, url) => {
    const res = await (request(ctx.app) as unknown as Record<string, (u: string) => request.Test>)[m]!(url).send({});
    expect(res.status).toBe(401);
  });
});
