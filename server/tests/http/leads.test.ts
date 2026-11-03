import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { bearer, makeApp, newAccount, userWithRole } from "../helpers/app.js";
import { closePools, ownerPool } from "../helpers/db.js";

afterAll(closePools);

const tag = () => randomUUID().slice(0, 8);
async function setup(label = "leads") {
  const ctx = makeApp();
  const owner = await newAccount(ctx, label);
  const post = (body: object, token = owner.accessToken) => request(ctx.app).post("/api/leads").set(bearer(token)).send(body);
  const mk = async (over: object = {}, token = owner.accessToken) => {
    const t = tag();
    const res = await post({ name: `Lead ${t}`, website: `https://biz-${t}.example.com`, ...over }, token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; status: string };
  };
  const move = (id: string, to: string, version: number, extra: object = {}, token = owner.accessToken) =>
    request(ctx.app).post(`/api/leads/${id}/transition`).set(bearer(token)).send({ to, version, ...extra });
  return { ctx, owner, post, mk, move };
}

describe("creating leads", () => {
  it("creates a NEW lead owned by the caller, normalised, with a CREATED activity", async () => {
    const { ctx, owner, post } = await setup();
    const t = tag();
    const res = await post({ name: "  Priya\u0000 Nair ", email: `  Hello-${t}@Biz.EXAMPLE.com `, website: `biz-${t}.example.com`, phone: "+91 98765 43210" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Priya  Nair", email: `hello-${t}@biz.example.com`, status: "NEW", version: 0, ownerId: owner.userId, needsReview: false });
    expect(res.body.allowedNext).toEqual(["CONTACTED", "CLOSED_LOST"]);
    const detail = await request(ctx.app).get(`/api/leads/${res.body.id}`).set(bearer(owner.accessToken));
    expect(detail.body.activities).toHaveLength(1);
    expect(detail.body.activities[0]).toMatchObject({ type: "CREATED", toStatus: "NEW", actorId: owner.userId });
  });

  it("rejects bad input: dangerous URL schemes, bad e-mail/phone, unknown fields, oversized text", async () => {
    const { post } = await setup();
    for (const bad of [
      { name: "A", website: "javascript:alert(1)" },
      { name: "A", website: "data:text/html,<script>1</script>" },
      { name: "A", website: "https://user:pw@example.com" },
      { name: "A", email: "nope" },
      { name: "A", phone: "<script>" },
      { name: "", website: "https://a.example.com" },
      { name: "x".repeat(201) },
      { name: "A", tenantId: randomUUID() },
      { name: "A", status: "CLOSED_WON" },
      { name: "A", ownerId: "not-a-uuid" },
    ]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("flags leads with no reliable identity for review instead of deduping them", async () => {
    const { post } = await setup();
    const a = await post({ name: "Walk-in One" });
    const b = await post({ name: "Walk-in One" });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.needsReview).toBe(true);
  });

  it("rejects a duplicate business (same website domain) and says which lead it collides with", async () => {
    const { post, mk } = await setup();
    const first = await mk({ website: "https://www.acme-dup.example.com/contact" });
    const dup = await post({ name: "Other Name", website: "http://acme-dup.example.com" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("DUPLICATE_LEAD");
    expect(dup.body.error.details.existingId).toBe(first.id);
  });

  it("two tenants may hold the same business", async () => {
    const a = await setup("dupA");
    const b = await setup("dupB");
    const site = `https://shared-${tag()}.example.com`;
    expect((await a.post({ name: "Shared", website: site })).status).toBe(201);
    expect((await b.post({ name: "Shared", website: site })).status).toBe(201);
  });
});

describe("listing, search and filters", () => {
  it("paginates with keyset cursors without gaps or repeats, newest first", async () => {
    const { ctx, owner, mk } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await mk()).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await request(ctx.app).get(`/api/leads?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).set(bearer(owner.accessToken));
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((l: { id: string }) => l.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
  });

  it("a lead updated while paging does not cause duplicates in later pages", async () => {
    const { ctx, owner, mk } = await setup();
    for (let i = 0; i < 4; i++) await mk();
    const first = await request(ctx.app).get("/api/leads?limit=2").set(bearer(owner.accessToken));
    const untouched = first.body.items[1];
    // The first row of page 1 is edited (moves to the top) after the client already has it.
    await request(ctx.app).patch(`/api/leads/${first.body.items[0].id}`).set(bearer(owner.accessToken)).send({ version: first.body.items[0].version, name: "Edited" });
    const second = await request(ctx.app).get(`/api/leads?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`).set(bearer(owner.accessToken));
    const ids = second.body.items.map((l: { id: string }) => l.id);
    expect(ids).not.toContain(untouched.id);
    expect(ids).toHaveLength(2);
  });

  it("searches name, company, e-mail and website case-insensitively, treating % and _ literally", async () => {
    const { ctx, owner, mk } = await setup();
    const t = tag();
    const a = await mk({ name: `Zebra ${t} Traders` });
    const b = await mk({ name: "Other", companyName: `Quokka-${t} Pvt Ltd` });
    const c = await mk({ name: "Third", email: `sales@giraffe-${t}.example.com`, website: null });
    const d = await mk({ name: "100% Organic" });
    const search = async (q: string) => (await request(ctx.app).get("/api/leads").query({ q }).set(bearer(owner.accessToken))).body.items.map((l: { id: string }) => l.id);
    expect(await search(`ZEBRA ${t}`)).toEqual([a.id]);
    expect(await search(`quokka-${t}`)).toEqual([b.id]);
    expect(await search(`giraffe-${t}`)).toEqual([c.id]);
    expect(await search("100%")).toEqual([d.id]);
    expect((await search("%")).length).toBe(1); // a bare % is literal, not "match everything"
    expect(await search("no-such-thing-" + t)).toEqual([]);
    expect(await search(`x'; DROP TABLE leads; --`)).toEqual([]);
  });

  it("filters by status, owner, unowned, review flag and due follow-ups", async () => {
    const { ctx, owner, mk, move } = await setup();
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    const a = await mk();
    const b = await mk({ ownerId: member.id });
    const c = await mk({ ownerId: null, website: null, name: "No identity" });
    await move(a.id, "CONTACTED", a.version);
    const get = async (qs: string) => (await request(ctx.app).get(`/api/leads?${qs}`).set(bearer(owner.accessToken))).body.items.map((l: { id: string }) => l.id);
    expect(await get("status=CONTACTED")).toEqual([a.id]);
    expect((await get("status=NEW,CONTACTED")).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(await get(`ownerId=${member.id}`)).toEqual([b.id]);
    expect(await get("unowned=true")).toEqual([c.id]);
    expect(await get("needsReview=true")).toEqual([c.id]);
    await ownerPool().query("UPDATE leads SET follow_up_at = now() - interval '1 day' WHERE id = $1", [b.id]);
    expect(await get("followUpDue=true")).toEqual([b.id]);
    expect((await request(ctx.app).get("/api/leads?status=BOGUS").set(bearer(owner.accessToken))).status).toBe(400);
  });

  it("stats count leads per stage", async () => {
    const { ctx, owner, mk, move } = await setup();
    const a = await mk();
    await mk();
    await move(a.id, "CONTACTED", a.version);
    const res = await request(ctx.app).get("/api/leads/stats").set(bearer(owner.accessToken));
    expect(res.body).toMatchObject({ total: 2, byStatus: { NEW: 1, CONTACTED: 1, CLOSED_WON: 0 } });
  });
});

describe("pipeline transitions", () => {
  it("walks the allowed path, bumps the version, and records history", async () => {
    const { ctx, owner, mk, move } = await setup();
    const lead = await mk();
    const a = await move(lead.id, "CONTACTED", 0);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ status: "CONTACTED", version: 1 });
    const b = await move(lead.id, "NEGOTIATION", 1);
    expect(b.body.allowedNext).toEqual(["FOLLOW_UP", "CLOSED_WON", "CLOSED_LOST"]);
    const detail = await request(ctx.app).get(`/api/leads/${lead.id}`).set(bearer(owner.accessToken));
    expect(detail.body.activities.map((x: { toStatus: string }) => x.toStatus)).toEqual(["NEGOTIATION", "CONTACTED", "NEW"]);
  });

  it("refuses illegal jumps with the legal options attached", async () => {
    const { mk, move } = await setup();
    const lead = await mk();
    const res = await move(lead.id, "NEGOTIATION", 0);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
    expect(res.body.error.details.allowedNext).toEqual(["CONTACTED", "CLOSED_LOST"]);
    expect((await move(lead.id, "NEW", 0)).body.error.code).toBe("SAME_STATE");
  });

  it("two simultaneous moves from the same version: exactly one wins, the other gets VERSION_CONFLICT", async () => {
    const { mk, move } = await setup();
    const lead = await mk();
    const [a, b] = await Promise.all([move(lead.id, "CONTACTED", 0), move(lead.id, "CLOSED_LOST", 0)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe("VERSION_CONFLICT");
    expect(loser.body.error.details.currentVersion).toBe(1);
  });

  it("a stale version is rejected even when the move itself is legal", async () => {
    const { mk, move } = await setup();
    const lead = await mk();
    await move(lead.id, "CONTACTED", 0);
    const stale = await move(lead.id, "FOLLOW_UP", 0);
    expect(stale.status).toBe(409);
  });

  it("CLOSED_LOST reopens only to FOLLOW_UP and only with a reason; the history keeps both", async () => {
    const { ctx, owner, mk, move } = await setup();
    const lead = await mk();
    await move(lead.id, "CLOSED_LOST", 0, { reason: "No budget" });
    const noReason = await move(lead.id, "FOLLOW_UP", 1);
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe("REASON_REQUIRED");
    expect((await move(lead.id, "NEW", 1, { reason: "trying to cheat" })).body.error.code).toBe("INVALID_TRANSITION");
    const ok = await move(lead.id, "FOLLOW_UP", 1, { reason: "Budget approved next quarter" });
    expect(ok.status).toBe(200);
    const audit = await ownerPool().query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at", [lead.id]);
    expect(audit.rows.map((r) => r.action)).toContain("lead.reopened");
    const detail = await request(ctx.app).get(`/api/leads/${lead.id}`).set(bearer(owner.accessToken));
    expect(detail.body.activities[0]).toMatchObject({ fromStatus: "CLOSED_LOST", toStatus: "FOLLOW_UP", reason: "Budget approved next quarter" });
  });

  it("closing as won is not available until the client/invoice flow exists, and changes nothing", async () => {
    const { mk, move } = await setup();
    const lead = await mk();
    await move(lead.id, "CONTACTED", 0);
    await move(lead.id, "NEGOTIATION", 1);
    const res = await move(lead.id, "CLOSED_WON", 2);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("CLOSED_WON_UNAVAILABLE");
    expect((await ownerPool().query("SELECT status, version FROM leads WHERE id = $1", [lead.id])).rows[0]).toEqual({ status: "NEGOTIATION", version: 2 });
  });
});

describe("editing and ownership", () => {
  it("PATCH uses optimistic concurrency and recomputes dedupe/review state", async () => {
    const { ctx, owner, mk } = await setup();
    const lead = await mk();
    const patch = (body: object) => request(ctx.app).patch(`/api/leads/${lead.id}`).set(bearer(owner.accessToken)).send(body);
    const ok = await patch({ version: 0, name: "Renamed", phone: "98765 43210", website: null });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Renamed", version: 1, website: null, needsReview: false });
    expect((await patch({ version: 0, name: "Late" })).body.error.code).toBe("VERSION_CONFLICT");
    expect((await patch({ version: 1 })).status).toBe(200); // no-op patches are fine
    expect((await patch({ name: "No version" })).status).toBe(400);
  });

  it("editing into another lead's identity is a duplicate error, not a 500", async () => {
    const { ctx, owner, mk } = await setup();
    const a = await mk({ website: "https://taken-site.example.com" });
    const b = await mk();
    const res = await request(ctx.app).patch(`/api/leads/${b.id}`).set(bearer(owner.accessToken)).send({ version: 0, website: "https://taken-site.example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_LEAD");
    expect(a.id).not.toBe(b.id);
  });

  it("members change only their own or unowned leads; admins change any", async () => {
    const { ctx, owner, mk, move } = await setup();
    const m1 = await userWithRole(ctx, owner.accessToken, "MEMBER", "m1");
    const m2 = await userWithRole(ctx, owner.accessToken, "MEMBER", "m2");
    const mine = await mk({ ownerId: m1.id });
    const unowned = await mk({ ownerId: null });

    const blocked = await move(mine.id, "CONTACTED", 0, {}, m2.accessToken);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("NOT_LEAD_OWNER");
    expect((await request(ctx.app).patch(`/api/leads/${mine.id}`).set(bearer(m2.accessToken)).send({ version: 0, name: "Hijack" })).status).toBe(403);
    expect((await request(ctx.app).post(`/api/leads/${mine.id}/notes`).set(bearer(m2.accessToken)).send({ note: "hi" })).status).toBe(403);

    expect((await move(mine.id, "CONTACTED", 0, {}, m1.accessToken)).status).toBe(200);
    expect((await move(unowned.id, "CONTACTED", 0, {}, m2.accessToken)).status).toBe(200); // unowned: anyone can work it
    expect((await move(mine.id, "FOLLOW_UP", 1, {}, owner.accessToken)).status).toBe(200); // admin override
    // Reads are open to every member.
    expect((await request(ctx.app).get(`/api/leads/${mine.id}`).set(bearer(m2.accessToken))).status).toBe(200);
  });

  it("assignment rules: members claim only for themselves; admins assign anyone in the workspace", async () => {
    const { ctx, owner, mk } = await setup();
    const other = await setup("otherTenant");
    const m1 = await userWithRole(ctx, owner.accessToken, "MEMBER", "c1");
    const m2 = await userWithRole(ctx, owner.accessToken, "MEMBER", "c2");
    const lead = await mk({ ownerId: null });
    const assign = (token: string, ownerId: string | null, version: number) =>
      request(ctx.app).patch(`/api/leads/${lead.id}`).set(bearer(token)).send({ version, ownerId });

    expect((await assign(m1.accessToken, m2.id, 0)).status).toBe(403);
    const claimed = await assign(m1.accessToken, m1.id, 0);
    expect(claimed.status).toBe(200);
    expect((await assign(m2.accessToken, m2.id, 1)).status).toBe(403); // already owned by m1
    expect((await assign(m1.accessToken, null, 1)).status).toBe(403); // members cannot unassign
    expect((await assign(owner.accessToken, m2.id, 1)).status).toBe(200);
    // An owner id belonging to another workspace is refused.
    const foreign = await assign(owner.accessToken, other.owner.userId, 2);
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe("INVALID_OWNER");
    const history = await ownerPool().query("SELECT count(*)::int AS n FROM activities WHERE lead_id = $1 AND type = 'OWNER_CHANGED'", [lead.id]);
    expect(history.rows[0].n).toBe(2);
  });

  it("notes are appended to the history", async () => {
    const { ctx, owner, mk } = await setup();
    const lead = await mk();
    expect((await request(ctx.app).post(`/api/leads/${lead.id}/notes`).set(bearer(owner.accessToken)).send({ note: "Called, call back Monday" })).status).toBe(201);
    const detail = await request(ctx.app).get(`/api/leads/${lead.id}`).set(bearer(owner.accessToken));
    expect(detail.body.activities[0]).toMatchObject({ type: "NOTE", reason: "Called, call back Monday" });
    expect((await request(ctx.app).post(`/api/leads/${lead.id}/notes`).set(bearer(owner.accessToken)).send({ note: "" })).status).toBe(400);
  });
});

describe("deleting", () => {
  it("is admin-only, soft, hides the lead, and frees its identity for a fresh lead", async () => {
    const { ctx, owner, mk, post } = await setup();
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    const site = `https://gone-${tag()}.example.com`;
    const lead = await mk({ website: site });
    expect((await request(ctx.app).delete(`/api/leads/${lead.id}`).set(bearer(member.accessToken))).status).toBe(403);
    expect((await request(ctx.app).delete(`/api/leads/${lead.id}`).set(bearer(owner.accessToken))).status).toBe(204);
    expect((await ownerPool().query("SELECT deleted_at FROM leads WHERE id = $1", [lead.id])).rows[0].deleted_at).not.toBeNull();
    expect((await request(ctx.app).get(`/api/leads/${lead.id}`).set(bearer(owner.accessToken))).status).toBe(404);
    expect((await request(ctx.app).delete(`/api/leads/${lead.id}`).set(bearer(owner.accessToken))).status).toBe(404);
    expect((await post({ name: "Fresh", website: site })).status).toBe(201);
  });
});

describe("tenant isolation for leads", () => {
  it("another workspace sees 404 for every operation and never sees the lead in lists or search", async () => {
    const a = await setup("isoLA");
    const b = await setup("isoLB");
    const secret = tag();
    const lead = await a.mk({ name: `Secret ${secret}` });
    const hdr = bearer(b.owner.accessToken);
    expect((await request(b.ctx.app).get(`/api/leads/${lead.id}`).set(hdr)).status).toBe(404);
    expect((await request(b.ctx.app).patch(`/api/leads/${lead.id}`).set(hdr).send({ version: 0, name: "x" })).status).toBe(404);
    expect((await b.move(lead.id, "CONTACTED", 0)).status).toBe(404);
    expect((await request(b.ctx.app).post(`/api/leads/${lead.id}/notes`).set(hdr).send({ note: "hi" })).status).toBe(404);
    expect((await request(b.ctx.app).delete(`/api/leads/${lead.id}`).set(hdr)).status).toBe(404);
    const search = await request(b.ctx.app).get("/api/leads").query({ q: secret }).set(hdr);
    expect(search.body.items).toEqual([]);
    expect((await request(b.ctx.app).get("/api/leads/stats").set(hdr)).body.total).toBe(0);
    expect((await request(b.ctx.app).get("/api/leads/not-a-uuid").set(hdr)).status).toBe(404);
    // Untouched.
    expect((await ownerPool().query("SELECT status, version, deleted_at FROM leads WHERE id = $1", [lead.id])).rows[0]).toEqual({ status: "NEW", version: 0, deleted_at: null });
  });

  it("a cursor minted in one workspace cannot be used to read another's rows", async () => {
    const a = await setup("curA");
    const b = await setup("curB");
    for (let i = 0; i < 3; i++) await a.mk();
    await b.mk();
    const page = await request(a.ctx.app).get("/api/leads?limit=1").set(bearer(a.owner.accessToken));
    const res = await request(b.ctx.app).get(`/api/leads?cursor=${encodeURIComponent(page.body.nextCursor)}`).set(bearer(b.owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.items.every((l: { ownerId: string }) => l.ownerId === b.owner.userId)).toBe(true);
  });

  it("requires authentication", async () => {
    const { ctx } = await setup();
    expect((await request(ctx.app).get("/api/leads")).status).toBe(401);
  });
});
