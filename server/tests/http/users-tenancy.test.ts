import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { bearer, cookieHeaders, makeApp, newAccount, userWithRole, TEST_PASSWORD } from "../helpers/app.js";
import { closePools, ownerPool } from "../helpers/db.js";

afterAll(closePools);

describe("RBAC over HTTP", () => {
  it("MEMBER can read users but not manage them or change settings", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "rbac");
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    expect((await request(ctx.app).get("/api/users").set(bearer(member.accessToken))).status).toBe(200);
    const create = await request(ctx.app).post("/api/users").set(bearer(member.accessToken)).send({ email: `x-${randomUUID().slice(0, 6)}@example.com`, name: "X Y", role: "MEMBER" });
    expect(create.status).toBe(403);
    expect((await request(ctx.app).patch("/api/tenant").set(bearer(member.accessToken)).send({ name: "Hijacked" })).status).toBe(403);
    expect((await request(ctx.app).patch("/api/tenant/settings").set(bearer(member.accessToken)).send({ features: { email: false } })).status).toBe(403);
  });

  it("ADMIN can manage MEMBERs but cannot create or promote OWNERs/ADMINs", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "adm");
    const admin = await userWithRole(ctx, owner.accessToken, "ADMIN");
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    const mk = (role: string) => request(ctx.app).post("/api/users").set(bearer(admin.accessToken)).send({ email: `n-${randomUUID().slice(0, 8)}@example.com`, name: "New Person", role });
    expect((await mk("MEMBER")).status).toBe(201);
    expect((await mk("OWNER")).status).toBe(403);
    expect((await mk("ADMIN")).status).toBe(403);
    expect((await request(ctx.app).patch(`/api/users/${member.id}`).set(bearer(admin.accessToken)).send({ role: "OWNER" })).status).toBe(403);
    // Admin cannot touch the owner at all.
    expect((await request(ctx.app).post(`/api/users/${owner.userId}/reset-password`).set(bearer(admin.accessToken))).status).toBe(403);
    expect((await request(ctx.app).delete(`/api/users/${owner.userId}`).set(bearer(admin.accessToken))).status).toBe(403);
  });

  it("a role change takes effect on the very next request (token claims are not trusted)", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "demote");
    const admin = await userWithRole(ctx, owner.accessToken, "ADMIN");
    expect((await request(ctx.app).patch("/api/tenant").set(bearer(admin.accessToken)).send({ name: "Renamed Co" })).status).toBe(200);
    await request(ctx.app).patch(`/api/users/${admin.id}`).set(bearer(owner.accessToken)).send({ role: "MEMBER" });
    expect((await request(ctx.app).patch("/api/tenant").set(bearer(admin.accessToken)).send({ name: "Again Co" })).status).toBe(403);
  });
});

describe("user management", () => {
  it("creates a user with a one-time temporary password and forces a password change", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "mgmt");
    const email = `new-${randomUUID().slice(0, 8)}@example.com`;
    const created = await request(ctx.app).post("/api/users").set(bearer(owner.accessToken)).send({ email, name: "Nina Shah", role: "MEMBER" });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toBeTruthy();
    expect(JSON.stringify(created.body.user)).not.toMatch(/password_?hash|argon2|totp_?secret/i);

    const login = await request(ctx.app).post("/api/auth/login").send({ email, password: created.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    // Until the password is changed, ordinary endpoints are blocked but /me works.
    const blocked = await request(ctx.app).get("/api/users").set(bearer(login.body.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await request(ctx.app).get("/api/me").set(bearer(login.body.accessToken))).status).toBe(200);
    const changed = await request(ctx.app).post("/api/auth/password/change").set(bearer(login.body.accessToken)).send({ currentPassword: created.body.temporaryPassword, newPassword: TEST_PASSWORD });
    expect(changed.status).toBe(200);
    expect((await request(ctx.app).get("/api/users").set(bearer(changed.body.accessToken))).status).toBe(200);
  });

  it("rejects an e-mail that already exists anywhere on the platform", async () => {
    const ctx = makeApp();
    const a = await newAccount(ctx, "ea");
    const b = await newAccount(ctx, "eb");
    const res = await request(ctx.app).post("/api/users").set(bearer(a.accessToken)).send({ email: b.email, name: "Dup Dup", role: "MEMBER" });
    expect(res.status).toBe(409);
  });

  it("the last owner can be neither demoted nor removed; self-actions are blocked", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "last");
    expect((await request(ctx.app).patch(`/api/users/${owner.userId}`).set(bearer(owner.accessToken)).send({ role: "ADMIN" })).status).toBe(403);
    expect((await request(ctx.app).delete(`/api/users/${owner.userId}`).set(bearer(owner.accessToken))).status).toBe(403);
    expect((await request(ctx.app).post(`/api/users/${owner.userId}/reset-password`).set(bearer(owner.accessToken))).status).toBe(403);
  });

  it("removing a user soft-deletes, kills their sessions and frees nothing they could still use", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "del");
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    expect((await request(ctx.app).delete(`/api/users/${member.id}`).set(bearer(owner.accessToken))).status).toBe(204);
    expect((await ownerPool().query("SELECT deleted_at FROM users WHERE id = $1", [member.id])).rows[0].deleted_at).not.toBeNull();
    expect((await request(ctx.app).get("/api/me").set(bearer(member.accessToken))).status).toBe(401);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(member.refreshToken))).status).toBe(401);
  });

  it("reset-password issues a new temporary password, revokes sessions and unlocks the account", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "rst");
    const member = await userWithRole(ctx, owner.accessToken, "MEMBER");
    const res = await request(ctx.app).post(`/api/users/${member.id}/reset-password`).set(bearer(owner.accessToken));
    expect(res.status).toBe(200);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(member.refreshToken))).status).toBe(401);
    const login = await request(ctx.app).post("/api/auth/login").send({ email: member.email, password: res.body.temporaryPassword });
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it("list is paginated with an opaque cursor and rejects tampered cursors", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "page");
    for (let i = 0; i < 3; i++) await userWithRole(ctx, owner.accessToken, "MEMBER", `m${i}`);
    const first = await request(ctx.app).get("/api/users?limit=2").set(bearer(owner.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(ctx.app).get(`/api/users?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`).set(bearer(owner.accessToken));
    expect(second.body.items).toHaveLength(2);
    const ids = [...first.body.items, ...second.body.items].map((u: { id: string }) => u.id);
    expect(new Set(ids).size).toBe(4);
    expect((await request(ctx.app).get("/api/users?cursor=%27%3B%20DROP%20TABLE%20users").set(bearer(owner.accessToken))).status).toBe(400);
    expect((await request(ctx.app).get("/api/users?limit=1000").set(bearer(owner.accessToken))).status).toBe(400);
  });
});

describe("tenant isolation over HTTP", () => {
  it("tenant B can neither see nor touch tenant A's users — every answer is 404", async () => {
    const ctx = makeApp();
    const a = await newAccount(ctx, "isoA");
    const b = await newAccount(ctx, "isoB");
    const aMember = await userWithRole(ctx, a.accessToken, "MEMBER");

    const list = await request(ctx.app).get("/api/users").set(bearer(b.accessToken));
    expect(list.body.items.map((u: { id: string }) => u.id)).not.toContain(aMember.id);
    expect(list.body.items.map((u: { id: string }) => u.id)).not.toContain(a.userId);

    expect((await request(ctx.app).patch(`/api/users/${aMember.id}`).set(bearer(b.accessToken)).send({ role: "ADMIN" })).status).toBe(404);
    expect((await request(ctx.app).delete(`/api/users/${aMember.id}`).set(bearer(b.accessToken))).status).toBe(404);
    expect((await request(ctx.app).post(`/api/users/${aMember.id}/reset-password`).set(bearer(b.accessToken))).status).toBe(404);
    // Malformed ids look identical to foreign ids.
    expect((await request(ctx.app).delete("/api/users/not-a-uuid").set(bearer(b.accessToken))).status).toBe(404);
    // And A's user is untouched.
    expect((await ownerPool().query("SELECT role, deleted_at FROM users WHERE id = $1", [aMember.id])).rows[0]).toEqual({ role: "MEMBER", deleted_at: null });
  });

  it("a tenant_id supplied in the body or query is ignored", async () => {
    const ctx = makeApp();
    const a = await newAccount(ctx, "forgeA");
    const b = await newAccount(ctx, "forgeB");
    const email = `forge-${randomUUID().slice(0, 8)}@example.com`;
    const res = await request(ctx.app).post(`/api/users?tenant_id=${a.tenantId}`).set(bearer(b.accessToken)).send({ email, name: "Forged One", role: "MEMBER", tenant_id: a.tenantId, tenantId: a.tenantId });
    expect(res.status).toBe(201);
    expect((await ownerPool().query("SELECT tenant_id FROM users WHERE email = $1", [email])).rows[0].tenant_id).toBe(b.tenantId);
  });

  it("settings and renames only ever affect the caller's own workspace", async () => {
    const ctx = makeApp();
    const a = await newAccount(ctx, "setA");
    const b = await newAccount(ctx, "setB");
    const before = (await ownerPool().query("SELECT name, settings FROM tenants WHERE id = $1", [a.tenantId])).rows[0];
    expect((await request(ctx.app).patch("/api/tenant").set(bearer(b.accessToken)).send({ name: "B Renamed" })).status).toBe(200);
    expect((await request(ctx.app).patch("/api/tenant/settings").set(bearer(b.accessToken)).send({ invoice: { prefix: "BBB" } })).status).toBe(200);
    expect((await ownerPool().query("SELECT name, settings FROM tenants WHERE id = $1", [a.tenantId])).rows[0]).toEqual(before);
  });
});

describe("tenant settings", () => {
  it("merges partial updates, validates strictly, and audits", async () => {
    const ctx = makeApp();
    const owner = await newAccount(ctx, "cfg");
    const ok = await request(ctx.app).patch("/api/tenant/settings").set(bearer(owner.accessToken)).send({ features: { scraper: false }, invoice: { prefix: "ACME", defaultTaxRateBp: 500 } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.features).toEqual({ scraper: false, invoices: true, email: true });
    expect(ok.body.settings.invoice).toEqual({ prefix: "ACME", currency: "INR", defaultTaxRateBp: 500 });

    const patch = (b: object) => request(ctx.app).patch("/api/tenant/settings").set(bearer(owner.accessToken)).send(b);
    expect((await patch({ invoice: { prefix: "bad prefix!" } })).status).toBe(400);
    expect((await patch({ invoice: { defaultTaxRateBp: 20000 } })).status).toBe(400);
    expect((await patch({ invoice: { currency: "rupees" } })).status).toBe(400);
    expect((await patch({ isAdmin: true })).status).toBe(400); // unknown keys are rejected, not stored
    expect((await patch({ features: { __proto__: { x: 1 }, hacker: true } })).status).toBe(400);

    const audit = await ownerPool().query("SELECT action FROM audit_log WHERE tenant_id = $1", [owner.tenantId]);
    expect(audit.rows.map((r) => r.action)).toContain("tenant.settings_changed");
    // /me reflects the change so the UI can hide the scraper menu.
    expect((await request(ctx.app).get("/api/me").set(bearer(owner.accessToken))).body.tenant.settings.features.scraper).toBe(false);
  });
});
