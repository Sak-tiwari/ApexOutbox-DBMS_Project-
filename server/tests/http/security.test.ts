import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { csvCell } from "../../src/http/security.js";
import { bearer, makeApp, newAccount, TEST_ORIGIN, TEST_PASSWORD, userWithRole } from "../helpers/app.js";
import { closePools } from "../helpers/db.js";

afterAll(closePools);

describe("security headers", () => {
  it("API responses forbid everything via CSP, framing, sniffing and referrers", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/health");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined(); // not in dev: never pin localhost to https
  });

  it("sends HSTS in production", async () => {
    const { app } = makeApp({
      NODE_ENV: "production", ALLOWED_ORIGINS: "https://app.example.com", COOKIE_SECURE: undefined,
      EMAIL_MODE: "smtp", SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p", EMAIL_FROM: "ApexOutbox <no-reply@example.com>",
    });
    const res = await request(app).get("/health");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=63072000; includeSubDomains; preload/);
  });
});

describe("CORS allowlist", () => {
  it("answers an allowed origin's preflight with exactly that origin and credentials", async () => {
    const { app } = makeApp();
    const res = await request(app).options("/api/leads").set("Origin", TEST_ORIGIN).set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-headers"]).toContain("X-CSRF-Token");
    expect(res.headers.vary).toContain("Origin");
  });

  it("never reflects an unknown origin and refuses its preflight and writes", async () => {
    const { app } = makeApp();
    const evil = "https://evil.example";
    const pre = await request(app).options("/api/leads").set("Origin", evil).set("Access-Control-Request-Method", "POST");
    expect(pre.status).toBe(403);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const get = await request(app).get("/health").set("Origin", evil);
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
    // A state-changing request from a foreign origin is not executed at all.
    const acct = await newAccount(makeApp());
    const ctx = makeApp();
    const post = await request(ctx.app).post("/api/leads").set(bearer(acct.accessToken)).set("Origin", evil).send({ name: "X" });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe("CORS_ORIGIN");
  });

  it("does not trust prefix or look-alike origins", async () => {
    const { app } = makeApp();
    for (const o of [`${TEST_ORIGIN}.evil.example`, "http://localhost:5174", "null"]) {
      const res = await request(app).options("/api/leads").set("Origin", o);
      expect(res.status, o).toBe(403);
    }
  });
});

describe("global rate limit", () => {
  it("returns 429 with Retry-After beyond the per-IP ceiling, but never for health checks", async () => {
    let t = 1_000_000;
    const { app } = makeApp({}, () => t);
    for (let i = 0; i < 600; i++) await request(app).get("/api/nope");
    const blocked = await request(app).get("/api/nope");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await request(app).get("/health")).status).toBe(200);
    t += 61_000;
    expect((await request(app).get("/api/nope")).status).toBe(404);
  }, 60_000);
});

describe("csvCell (formula injection)", () => {
  it.each(["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\t=x", "\r=x"])("neutralises %j", (v) => {
    expect(csvCell(v).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
  });
  it("quotes separators and doubles quotes, leaves numbers and plain text alone", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(-5)).toBe("-5"); // a real number, not a string
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(null)).toBe("");
  });
});

describe("audit log, export and deletion", () => {
  const setup = async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "acct6");
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    const admin = await userWithRole(ctx, owner.accessToken, "ADMIN");
    return { ctx, owner, member, admin, app: ctx.app };
  };

  it("audit log is for admins and owners, scoped to the tenant, paginated newest first", async () => {
    const { app, owner, member, admin } = await setup();
    const other = await newAccount(makeApp(), "other6");
    expect((await request(app).get("/api/audit").set(bearer(member.accessToken))).status).toBe(403);
    const first = await request(app).get("/api/audit?limit=2").set(bearer(admin.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app).get(`/api/audit?limit=2&cursor=${first.body.nextCursor}`).set(bearer(owner.accessToken));
    const ids = [...first.body.items, ...second.body.items].map((i: { id: string }) => BigInt(i.id));
    expect(new Set(ids.map(String)).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => (a > b ? -1 : 1))); // strictly newest first across pages
    const theirs = await request(app).get("/api/audit?limit=100").set(bearer(other.accessToken));
    const mine = await request(app).get("/api/audit?limit=100").set(bearer(owner.accessToken));
    const mineIds = new Set(mine.body.items.map((i: { id: string }) => i.id));
    expect(theirs.body.items.some((i: { id: string }) => mineIds.has(i.id))).toBe(false);
    expect(JSON.stringify(mine.body)).not.toMatch(/password_?hash|argon2|token_hash/i);
  });

  it("export needs data:export, neutralises formulas, stays inside the tenant and is audited", async () => {
    const { app, owner, member, admin } = await setup();
    const other = await newAccount(makeApp(), "other6b");
    const tag = randomUUID().slice(0, 6);
    await request(app).post("/api/leads").set(bearer(owner.accessToken)).send({ name: `Mine ${tag}`, companyName: "Co, \"Quoted\"" });
    await request(app).post("/api/leads").set(bearer(other.accessToken)).send({ name: `Theirs ${tag}` });
    // names starting with = are rejected on write (CSV import rule), so seed a dangerous value directly
    const { ownerPool } = await import("../helpers/db.js");
    await ownerPool().query("INSERT INTO leads (tenant_id, name, email, dedupe_key) VALUES ($1, $2, 'x@y.example', 'email:x@y.example')", [owner.tenantId, `=HYPERLINK("http://evil.example","x")`]);
    expect((await request(app).get("/api/export/leads.csv").set(bearer(member.accessToken))).status).toBe(403);
    const res = await request(app).get("/api/export/leads.csv").set(bearer(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.text).toContain(`Mine ${tag}`);
    expect(res.text).not.toContain(`Theirs ${tag}`);
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(res.text).toContain('"Co, ""Quoted"""');
    expect((await request(app).get("/api/export/passwords.csv").set(bearer(admin.accessToken))).status).toBe(422);
    const audit = await request(app).get("/api/audit?action=data.exported").set(bearer(owner.accessToken));
    expect(audit.body.items[0]).toMatchObject({ action: "data.exported", entityType: "leads" });
    for (const e of ["clients", "invoices"]) expect((await request(app).get(`/api/export/${e}.csv`).set(bearer(admin.accessToken))).status).toBe(200);
  });

  it("a member deletes their own account: password required, sessions dead, leads released", async () => {
    const { app, owner, member } = await setup();
    const lead = await request(app).post("/api/leads").set(bearer(member.accessToken)).send({ name: "Owned by member" });
    expect(lead.body.ownerId).toBe(member.id);
    expect((await request(app).delete("/api/me").set(bearer(member.accessToken)).send({ password: "wrong-password-123" })).status).toBe(403);
    expect((await request(app).get("/api/me").set(bearer(member.accessToken))).status).toBe(200);
    expect((await request(app).delete("/api/me").set(bearer(member.accessToken)).send({ password: TEST_PASSWORD })).status).toBe(204);
    expect((await request(app).get("/api/me").set(bearer(member.accessToken))).status).toBe(401); // access token dies immediately
    const login = await request(app).post("/api/auth/login").send({ email: member.email, password: TEST_PASSWORD });
    expect(login.status).toBe(401);
    const after = await request(app).get(`/api/leads/${lead.body.id}`).set(bearer(owner.accessToken));
    expect(after.body.lead.ownerId).toBeNull();
    const audit = await request(app).get("/api/audit?action=user.self_deleted").set(bearer(owner.accessToken));
    expect(audit.body.items).toHaveLength(1);
  });

  it("the only owner cannot delete themselves, only the workspace", async () => {
    const { app, owner } = await setup();
    const r = await request(app).delete("/api/me").set(bearer(owner.accessToken)).send({ password: TEST_PASSWORD });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("LAST_OWNER");
  });

  it("only an owner can delete the workspace, needs password and exact name, then everything is locked out", async () => {
    const { app, owner, admin, member } = await setup();
    const other = await newAccount(makeApp(), "bystander");
    const me = await request(app).get("/api/me").set(bearer(owner.accessToken));
    const name = me.body.tenant.name as string;
    expect((await request(app).delete("/api/tenant").set(bearer(admin.accessToken)).send({ password: TEST_PASSWORD, confirmName: name })).status).toBe(403);
    expect((await request(app).delete("/api/tenant").set(bearer(owner.accessToken)).send({ password: "wrong-password-123", confirmName: name })).status).toBe(403);
    const typo = await request(app).delete("/api/tenant").set(bearer(owner.accessToken)).send({ password: TEST_PASSWORD, confirmName: `${name}x` });
    expect(typo.status).toBe(422);
    expect(typo.body.error.code).toBe("CONFIRM_NAME_MISMATCH");
    expect((await request(app).get("/api/me").set(bearer(owner.accessToken))).status).toBe(200); // nothing happened yet
    expect((await request(app).delete("/api/tenant").set(bearer(owner.accessToken)).send({ password: TEST_PASSWORD, confirmName: name })).status).toBe(204);
    for (const t of [owner.accessToken, admin.accessToken, member.accessToken]) expect((await request(app).get("/api/leads").set(bearer(t))).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: owner.email, password: TEST_PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/refresh").set("Cookie", `apex_rt=${owner.refreshToken}; apex_csrf=c`).set("X-CSRF-Token", "c").set("Origin", TEST_ORIGIN)).status).toBe(401);
    expect((await request(app).get("/api/leads").set(bearer(other.accessToken))).status).toBe(200); // other tenants untouched
  });
});
