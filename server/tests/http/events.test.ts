import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/logger.js";
import { RealtimeHub } from "../../src/realtime/hub.js";
import { AuthService } from "../../src/auth/service.js";
import { bearer, newAccount, testConfig } from "../helpers/app.js";
import { appPool, closePools, ownerPool } from "../helpers/db.js";

const closers: (() => Promise<void> | void)[] = [];
// Each test gets its own hub and server; tear them down after every test so listener connections never pile up.
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
afterAll(closePools);

async function boot(streamOptions: { maxStreamMs?: number; heartbeatMs?: number } = {}) {
  const config = testConfig();
  const log = createLogger("silent");
  const hub = new RealtimeHub(appPool(), log);
  await hub.start();
  const app = createApp({ db: appPool(), log, config, hub, streamOptions });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  closers.push(async () => { server.closeAllConnections(); server.close(); await hub.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ctx = { app, config, auth: new AuthService(appPool(), config, log) };
  return { base, ctx, hub };
}

/** Opens a live stream and collects parsed events as they arrive. */
async function stream(base: string, token: string) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const events: { event: string; data: unknown }[] = [];
  let raw = "";
  let ended = false;
  if (res.ok && res.body) {
    (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += dec.decode(value);
          let i: number;
          while ((i = raw.indexOf("\n\n")) >= 0) {
            const block = raw.slice(0, i);
            raw = raw.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          }
        }
      } catch { /* aborted */ }
      ended = true;
    })();
  }
  const waitFor = async (pred: (e: { event: string; data: unknown }) => boolean, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    return undefined;
  };
  return { res, events, waitFor, close: () => ac.abort(), isEnded: () => ended };
}

describe("live event stream", () => {
  it("requires authentication", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    expect((await fetch(`${base}/api/events`, { headers: { Authorization: "Bearer junk" } })).status).toBe(401);
  });

  it("announces itself, then pushes changes in this workspace as they happen", async () => {
    const { base, ctx } = await boot();
    const a = await newAccount(ctx, "sseA");
    const s = await stream(base, a.accessToken);
    expect(s.res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(s.res.headers.get("cache-control")).toMatch(/no-store/);
    expect(await s.waitFor((e) => e.event === "ready")).toBeTruthy();

    const created = await request(ctx.app).post("/api/leads").set(bearer(a.accessToken)).send({ name: "Live Lead", website: "https://live-1.example.com" });
    const insert = await s.waitFor((e) => e.event === "change" && (e.data as { id: string }).id === created.body.id);
    expect(insert?.data).toEqual({ entity: "lead", id: created.body.id, op: "INSERT" });

    await request(ctx.app).post(`/api/leads/${created.body.id}/transition`).set(bearer(a.accessToken)).send({ to: "CONTACTED", version: 0 });
    const update = await s.waitFor((e) => e.event === "change" && (e.data as { op: string; id: string }).op === "UPDATE" && (e.data as { id: string }).id === created.body.id);
    expect(update).toBeTruthy();
    s.close();
  });

  it("never delivers another workspace's changes, and events carry ids only (no names, e-mails or amounts)", async () => {
    const { base, ctx } = await boot();
    const a = await newAccount(ctx, "sseIsoA");
    const b = await newAccount(ctx, "sseIsoB");
    const sa = await stream(base, a.accessToken);
    const sb = await stream(base, b.accessToken);
    await sa.waitFor((e) => e.event === "ready");
    await sb.waitFor((e) => e.event === "ready");

    const secret = await request(ctx.app).post("/api/leads").set(bearer(a.accessToken)).send({ name: "Top Secret Prospect", email: "secret@prospect.example.com", website: "https://secret-co.example.com" });
    await sa.waitFor((e) => e.event === "change");
    await new Promise((r) => setTimeout(r, 300));
    expect(sb.events.filter((e) => e.event === "change")).toEqual([]);
    const text = JSON.stringify(sa.events);
    expect(text).not.toMatch(/Top Secret|secret@prospect|secret-co/);
    expect(Object.keys((sa.events.find((e) => e.event === "change")!.data as object)).sort()).toEqual(["entity", "id", "op"]);
    expect(secret.status).toBe(201);
    sa.close(); sb.close();
  });

  it("covers every entity the UI shows (clients, invoices, e-mails, scrape jobs)", async () => {
    const { base, ctx } = await boot();
    const a = await newAccount(ctx, "sseAll");
    const s = await stream(base, a.accessToken);
    await s.waitFor((e) => e.event === "ready");
    const lead = (await request(ctx.app).post("/api/leads").set(bearer(a.accessToken)).send({ name: "All Things", website: "https://all-things.example.com" })).body;
    for (const [to, v] of [["CONTACTED", 0], ["NEGOTIATION", 1]] as const) await request(ctx.app).post(`/api/leads/${lead.id}/transition`).set(bearer(a.accessToken)).send({ to, version: v });
    await request(ctx.app).post(`/api/leads/${lead.id}/transition`).set(bearer(a.accessToken)).send({ to: "CLOSED_WON", version: 2, deal: { email: "x@client.example.com", items: [{ description: "x", quantity: 1, unitAmountMinor: 1000 }] } });
    await request(ctx.app).post("/api/scrape/domains").set(bearer(a.accessToken)).send({ domain: "live-scrape.example.com" });
    await request(ctx.app).post("/api/scrape/jobs").set(bearer(a.accessToken)).send({ urls: ["https://live-scrape.example.com/"] });
    await new Promise((r) => setTimeout(r, 400));
    const entities = new Set(s.events.filter((e) => e.event === "change").map((e) => (e.data as { entity: string }).entity));
    expect([...entities].sort()).toEqual(["client", "email", "invoice", "lead", "scrape_job"]);
    await ownerPool().query("UPDATE scrape_jobs SET status = 'CANCELLED' WHERE tenant_id = $1", [a.tenantId]);
    s.close();
  });

  it("limits open streams per user, and frees the slot when one closes", async () => {
    const { base, ctx } = await boot();
    const a = await newAccount(ctx, "sseCap");
    const open = [];
    for (let i = 0; i < 5; i++) open.push(await stream(base, a.accessToken));
    const sixth = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${a.accessToken}` } });
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    open[0]!.close();
    await new Promise((r) => setTimeout(r, 300));
    const again = await stream(base, a.accessToken);
    expect(again.res.status).toBe(200);
    again.close(); open.slice(1).forEach((o) => o.close());
  });

  it("ends a stream after its maximum age so it cannot outlive the sign-in", async () => {
    const { base, ctx } = await boot({ maxStreamMs: 300 });
    const a = await newAccount(ctx, "sseExp");
    const s = await stream(base, a.accessToken);
    expect(await s.waitFor((e) => e.event === "expired")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.isEnded()).toBe(true);
  });

  it("keeps idle connections alive with heartbeats", async () => {
    const { base, ctx } = await boot({ heartbeatMs: 100 });
    const a = await newAccount(ctx, "sseBeat");
    const res = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${a.accessToken}` } });
    const reader = res.body!.getReader();
    let text = "";
    const dec = new TextDecoder();
    const until = Date.now() + 1500;
    while (Date.now() < until && !text.includes(": keep-alive")) text += dec.decode((await reader.read()).value);
    expect(text).toContain(": keep-alive");
    await reader.cancel();
  });

  it("reconnects after the database listener dies and tells streams to refetch everything", async () => {
    const { base, ctx, hub } = await boot();
    const a = await newAccount(ctx, "sseRecon");
    const s = await stream(base, a.accessToken);
    await s.waitFor((e) => e.event === "ready");
    // Simulate the network dropping under the listener connection (the owner role may not terminate apex_app backends).
    (hub as unknown as { client: { connection: { stream: { destroy(): void } } } }).client.connection.stream.destroy();
    expect(await s.waitFor((e) => e.event === "change" && (e.data as { entity: string }).entity === "*", 6000)).toBeTruthy();
    const lead = await request(ctx.app).post("/api/leads").set(bearer(a.accessToken)).send({ name: "After Reconnect", website: "https://after-reconnect.example.com" });
    expect(await s.waitFor((e) => (e.data as { id?: string })?.id === lead.body.id)).toBeTruthy();
    s.close();
  }, 20_000);
});
