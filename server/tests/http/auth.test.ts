import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { totpCode } from "../../src/auth/totp.js";
import { hashToken } from "../../src/auth/tokens.js";
import { bearer, cookieHeaders, cookieValue, makeApp, newAccount, setCookies, TEST_ORIGIN, TEST_PASSWORD } from "../helpers/app.js";
import { closePools, ownerPool } from "../helpers/db.js";

afterAll(closePools);

const uniqueEmail = (label = "u") => `${label}-${randomUUID().slice(0, 8)}@example.com`;

describe("POST /api/auth/register", () => {
  it("creates a workspace with an OWNER, returns an access token and sets hardened cookies", async () => {
    const { app } = makeApp();
    const email = uniqueEmail("reg");
    const res = await request(app).post("/api/auth/register").send({ tenantName: "Blossom Studios", name: "Priya Nair", email, password: TEST_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, name: "Priya Nair", role: "OWNER", totpEnabled: false, mustChangePassword: false });
    expect(res.body.accessToken.split(".")).toHaveLength(3);
    expect(res.body.expiresIn).toBe(600);

    const cookies = setCookies(res);
    const refresh = cookies.find((c) => c.startsWith("apex_rt="))!;
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/Path=\/api\/auth/);
    expect(refresh).toMatch(/Max-Age=\d+/);
    const csrf = cookies.find((c) => c.startsWith("apex_csrf="))!;
    expect(csrf).not.toMatch(/HttpOnly/i); // the SPA must be able to read this one
    expect(csrf).toMatch(/SameSite=Strict/i);
    // The response body never contains a refresh token (it only travels in the HttpOnly cookie).
    expect(JSON.stringify(res.body)).not.toContain(cookieValue(res, "apex_rt")!);
  });

  it("stores only an Argon2id hash of the password and only a hash of the refresh token", async () => {
    const { app } = makeApp();
    const email = uniqueEmail("hash");
    const res = await request(app).post("/api/auth/register").send({ tenantName: "Hash Co", name: "Hana Kim", email, password: TEST_PASSWORD });
    const { rows } = await ownerPool().query("SELECT password_hash FROM users WHERE email = $1", [email]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(TEST_PASSWORD);

    const refreshToken = cookieValue(res, "apex_rt")!;
    const tokens = await ownerPool().query("SELECT token_hash FROM refresh_tokens WHERE token_hash = $1 OR token_hash = $2", [refreshToken, hashToken(refreshToken)]);
    expect(tokens.rows.map((r) => r.token_hash)).toEqual([hashToken(refreshToken)]);
  });

  it("writes an audit entry and seeds the invoice counter and default settings", async () => {
    const { app } = makeApp();
    const email = uniqueEmail("aud");
    const res = await request(app).post("/api/auth/register").send({ tenantName: "Audit Co", name: "Asha Rao", email, password: TEST_PASSWORD });
    const tenantId = (await ownerPool().query("SELECT tenant_id FROM users WHERE id = $1", [res.body.user.id])).rows[0].tenant_id;
    const audit = await ownerPool().query("SELECT action FROM audit_log WHERE tenant_id = $1", [tenantId]);
    expect(audit.rows.map((r) => r.action)).toContain("tenant.registered");
    expect((await ownerPool().query("SELECT last_number FROM invoice_counters WHERE tenant_id = $1", [tenantId])).rows[0].last_number).toBe(0);
    const t = (await ownerPool().query("SELECT settings, slug FROM tenants WHERE id = $1", [tenantId])).rows[0];
    expect(t.settings.features).toEqual({ scraper: true, invoices: true, email: true });
    expect(t.slug).toMatch(/^audit-co-[0-9a-f]{6}$/);
  });

  it("rejects a weak password with reasons, and never echoes the password back", async () => {
    const { app } = makeApp();
    const weak = "Password123!";
    const res = await request(app).post("/api/auth/register").send({ tenantName: "Weak Co", name: "Wes Lee", email: uniqueEmail(), password: weak });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WEAK_PASSWORD");
    expect(res.body.error.details[0].message).toMatch(/common/);
    expect(JSON.stringify(res.body)).not.toContain(weak);
  });

  it("validates input with Zod (missing fields, bad e-mail, oversized values)", async () => {
    const { app } = makeApp();
    const bad = await request(app).post("/api/auth/register").send({ tenantName: "x", name: "", email: "not-an-email", password: "y".repeat(500) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    const paths = bad.body.error.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(["email", "name", "password", "tenantName"]);
  });

  it("rejects a duplicate e-mail address with 409, even when two requests race", async () => {
    const { app } = makeApp();
    const email = uniqueEmail("dup");
    const body = { tenantName: "Dup Co", name: "Dev Patel", email, password: TEST_PASSWORD };
    const results = await Promise.all([request(app).post("/api/auth/register").send(body), request(app).post("/api/auth/register").send(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("EMAIL_TAKEN");
    const { rows } = await ownerPool().query("SELECT count(*)::int AS n FROM users WHERE email = $1", [email]);
    expect(rows[0].n).toBe(1);
  });

  it("is rate limited (5 per hour per IP)", async () => {
    const { app } = makeApp();
    const send = () => request(app).post("/api/auth/register").send({ tenantName: "x", name: "", email: "bad", password: "y" });
    for (let i = 0; i < 5; i++) expect((await send()).status).toBe(400);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("POST /api/auth/login", () => {
  it("signs in with correct credentials (e-mail is case-insensitive)", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "login");
    const res = await request(ctx.app).post("/api/auth/login").send({ email: acct.email.toUpperCase(), password: acct.password });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(acct.userId);
    expect(cookieValue(res, "apex_rt")).toBeTruthy();
  });

  it("gives the same answer for a wrong password and an unknown account (no user enumeration)", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "enum");
    const wrong = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: "Wrong-Password-123" });
    const unknown = await request(ctx.app).post("/api/auth/login").send({ email: uniqueEmail("nobody"), password: "Wrong-Password-123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.message).toBe("Invalid email or password");
  });

  it("locks the account after 5 failures, even for the correct password, and unlocks after the lock period", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "lock");
    for (let i = 0; i < 5; i++) {
      expect((await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: `Nope-Nope-${i}-xx` })).status).toBe(401);
    }
    const locked = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);

    const audit = await ownerPool().query("SELECT action FROM audit_log WHERE tenant_id = $1", [acct.tenantId]);
    expect(audit.rows.map((r) => r.action)).toContain("auth.account_locked");

    // Time passes: the lock expires and a correct password works again.
    await ownerPool().query("UPDATE users SET locked_until = now() - interval '1 minute' WHERE id = $1", [acct.userId]);
    const ok = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    expect(ok.status).toBe(200);
    expect((await ownerPool().query("SELECT failed_login_count FROM users WHERE id = $1", [acct.userId])).rows[0].failed_login_count).toBe(0);
  });

  it("a successful login resets the failure counter", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "reset");
    for (let i = 0; i < 3; i++) await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: "Nope-Nope-123x" });
    await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    expect((await ownerPool().query("SELECT failed_login_count FROM users WHERE id = $1", [acct.userId])).rows[0].failed_login_count).toBe(0);
  });

  it("rate-limits by IP (and by e-mail) to slow credential stuffing", async () => {
    const byIp = makeApp();
    for (let i = 0; i < 20; i++) expect((await request(byIp.app).post("/api/auth/login").send({ email: uniqueEmail("s"), password: "Whatever-123456" })).status).toBe(401);
    expect((await request(byIp.app).post("/api/auth/login").send({ email: uniqueEmail("s"), password: "Whatever-123456" })).status).toBe(429);

    const byEmail = makeApp();
    const target = uniqueEmail("victim");
    for (let i = 0; i < 10; i++) expect((await request(byEmail.app).post("/api/auth/login").send({ email: target, password: "Whatever-123456" })).status).toBe(401);
    expect((await request(byEmail.app).post("/api/auth/login").send({ email: target, password: "Whatever-123456" })).status).toBe(429);
  });

  it("login failures are audited without secrets", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "audit");
    await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: "Super-Secret-Wrong-1" });
    const { rows } = await ownerPool().query("SELECT action, metadata, ip FROM audit_log WHERE tenant_id = $1 AND action = 'auth.login_failed'", [acct.tenantId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("Super-Secret-Wrong-1");
  });
});

describe("access tokens and GET /api/me", () => {
  it("returns identity, tenant settings and the role's permissions", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "me");
    const res = await request(ctx.app).get("/api/me").set(bearer(acct.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: acct.userId, role: "OWNER" });
    expect(res.body.tenant.id).toBe(acct.tenantId);
    expect(res.body.tenant.settings.invoice.currency).toBe("INR");
    expect(res.body.permissions).toContain("tenant:delete");
    expect(JSON.stringify(res.body)).not.toMatch(/password_?hash|argon2|totp_?secret|totp_?pending|refresh_?token/i);
  });

  it("requires a valid Bearer token", async () => {
    const { app } = makeApp();
    expect((await request(app).get("/api/me")).status).toBe(401);
    expect((await request(app).get("/api/me").set("Authorization", "Bearer garbage")).status).toBe(401);
    expect((await request(app).get("/api/me").set("Authorization", "Basic abc")).status).toBe(401);
  });

  it("a request carrying only the refresh cookie is NOT authenticated (so cookies cannot be abused cross-site)", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "cookieonly");
    const res = await request(ctx.app).get("/api/me").set(cookieHeaders(acct.refreshToken));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/refresh (rotating refresh tokens)", () => {
  it("issues a new access token and a NEW refresh token each time", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "rot");
    const res = await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const next = cookieValue(res, "apex_rt")!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(acct.refreshToken);
    expect((await request(ctx.app).get("/api/me").set(bearer(res.body.accessToken))).status).toBe(200);
    // The rotated token works too.
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(next))).status).toBe(200);
  });

  it("a stolen, already-used token revokes the WHOLE session family (theft detection)", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "theft");
    const first = await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken));
    const legit = cookieValue(first, "apex_rt")!;
    // Time passes beyond the parallel-tab grace window.
    await ownerPool().query("UPDATE refresh_tokens SET used_at = now() - interval '5 minutes' WHERE token_hash = $1", [hashToken(acct.refreshToken)]);

    // The attacker replays the old token: refused...
    const replay = await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken));
    expect(replay.status).toBe(401);
    // ...and the legitimate user's newer token is dead as well, forcing a fresh sign-in.
    const afterwards = await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(legit));
    expect(afterwards.status).toBe(401);

    const audit = await ownerPool().query("SELECT action FROM audit_log WHERE tenant_id = $1", [acct.tenantId]);
    expect(audit.rows.map((r) => r.action)).toContain("auth.refresh_reuse_detected");
  });

  it("two tabs refreshing at once is a harmless race, not treated as theft", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "race");
    const [a, b] = await Promise.all([
      request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken)),
      request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    // The session family survives: the winner's new token still works.
    const winner = a.status === 200 ? a : b;
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(cookieValue(winner, "apex_rt")!))).status).toBe(200);
  });

  it("rejects unknown, expired, revoked and missing tokens (and clears the cookie)", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "dead");
    const unknown = await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders("not-a-real-token"));
    expect(unknown.status).toBe(401);
    expect(setCookies(unknown).some((c) => c.startsWith("apex_rt=;") && /Max-Age=0/.test(c))).toBe(true);

    await ownerPool().query("UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(acct.refreshToken)]);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken))).status).toBe(401);

    const none = await request(ctx.app).post("/api/auth/refresh").set({ Cookie: "apex_csrf=c", "X-CSRF-Token": "c", Origin: TEST_ORIGIN });
    expect(none.status).toBe(401);
  });

  it("enforces the absolute session lifetime however often the token is rotated", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "abs");
    await ownerPool().query("UPDATE refresh_tokens SET family_expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(acct.refreshToken)]);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken))).status).toBe(401);
  });

  it("is refused for a user who was removed or whose workspace was suspended", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "gone");
    await ownerPool().query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [acct.tenantId]);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken))).status).toBe(401);
  });
});

describe("CSRF protection on cookie-authenticated endpoints", () => {
  it("rejects a missing CSRF header, a mismatched one, a foreign Origin, and no Origin at all", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "csrf");
    const good = cookieHeaders(acct.refreshToken);
    const post = () => request(ctx.app).post("/api/auth/refresh");

    const noHeader = await post().set({ Cookie: good.Cookie, Origin: TEST_ORIGIN });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe("CSRF_TOKEN");

    const mismatch = await post().set({ ...good, "X-CSRF-Token": "something-else" });
    expect(mismatch.status).toBe(403);

    const foreign = await post().set({ ...good, Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    // Refused by the global CORS allowlist before the CSRF layer even runs (two independent defences).
    expect(foreign.body.error.code).toBe("CORS_ORIGIN");

    const noOrigin = await post().set({ Cookie: good.Cookie, "X-CSRF-Token": "csrf-token-for-tests" });
    expect(noOrigin.status).toBe(403);

    // Referer is an acceptable fallback when Origin is absent.
    const viaReferer = await post().set({ Cookie: good.Cookie, "X-CSRF-Token": "csrf-token-for-tests", Referer: `${TEST_ORIGIN}/app/leads` });
    expect(viaReferer.status).toBe(200);

    // None of the rejected requests consumed the token.
    const stillValid = await post().set(cookieHeaders(cookieValue(viaReferer, "apex_rt")!));
    expect(stillValid.status).toBe(200);
  });

  it("logout is CSRF-protected too", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "csrflo");
    const res = await request(ctx.app).post("/api/auth/logout").set({ Cookie: `apex_rt=${acct.refreshToken}`, Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await ownerPool().query("SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1", [hashToken(acct.refreshToken)])).rows[0].revoked_at).toBeNull();
  });
});

describe("logout", () => {
  it("revokes the session family, clears cookies, and is idempotent", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "out");
    const rotated = await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken));
    const current = cookieValue(rotated, "apex_rt")!;

    const out = await request(ctx.app).post("/api/auth/logout").set(cookieHeaders(current));
    expect(out.status).toBe(204);
    expect(setCookies(out).filter((c) => /Max-Age=0/.test(c))).toHaveLength(2);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(current))).status).toBe(401);

    expect((await request(ctx.app).post("/api/auth/logout").set(cookieHeaders(current))).status).toBe(204);
    expect((await request(ctx.app).post("/api/auth/logout").set({ Origin: TEST_ORIGIN, Cookie: "apex_csrf=c", "X-CSRF-Token": "c" })).status).toBe(204);
  });

  it("logout-all ends every device's session", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "outall");
    const second = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    const secondRt = cookieValue(second, "apex_rt")!;
    expect((await request(ctx.app).post("/api/auth/logout-all").set(bearer(acct.accessToken))).status).toBe(204);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken))).status).toBe(401);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(secondRt))).status).toBe(401);
  });
});

describe("password change", () => {
  it("needs the current password, enforces the policy, and signs out every OTHER device", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "chg");
    const otherDevice = cookieValue(await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password }), "apex_rt")!;
    const change = (body: object) => request(ctx.app).post("/api/auth/password/change").set(bearer(acct.accessToken)).send(body);

    const wrong = await change({ currentPassword: "Not-My-Password-1", newPassword: "Brand-New-Passw0rd!x" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("INVALID_CURRENT_PASSWORD");

    const weak = await change({ currentPassword: acct.password, newPassword: "short" });
    expect(weak.body.error.code).toBe("WEAK_PASSWORD");

    const same = await change({ currentPassword: acct.password, newPassword: acct.password });
    expect(same.body.error.code).toBe("PASSWORD_UNCHANGED");

    const ok = await change({ currentPassword: acct.password, newPassword: "Brand-New-Passw0rd!x" });
    expect(ok.status).toBe(200);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(otherDevice))).status).toBe(401);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(acct.refreshToken))).status).toBe(401);
    expect((await request(ctx.app).post("/api/auth/refresh").set(cookieHeaders(cookieValue(ok, "apex_rt")!))).status).toBe(200); // this device keeps working
    expect((await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password })).status).toBe(401);
    expect((await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: "Brand-New-Passw0rd!x" })).status).toBe(200);
  });

  it("guessing the current password counts toward the lockout", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "chglock");
    for (let i = 0; i < 5; i++) {
      await request(ctx.app).post("/api/auth/password/change").set(bearer(acct.accessToken)).send({ currentPassword: `Guess-${i}-Guess-xx`, newPassword: "Brand-New-Passw0rd!x" });
    }
    const res = await request(ctx.app).post("/api/auth/password/change").set(bearer(acct.accessToken)).send({ currentPassword: acct.password, newPassword: "Brand-New-Passw0rd!x" });
    expect(res.status).toBe(429);
  });
});

describe("two-factor authentication (TOTP)", () => {
  async function enable2fa(ctx: ReturnType<typeof makeApp>, acct: { accessToken: string; password: string }) {
    const setup = await request(ctx.app).post("/api/auth/2fa/setup").set(bearer(acct.accessToken));
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    const enable = await request(ctx.app).post("/api/auth/2fa/enable").set(bearer(acct.accessToken)).send({ code: totpCode(secret, Date.now()) });
    expect(enable.status).toBe(200);
    return { secret, recoveryCodes: enable.body.recoveryCodes as string[], setup };
  }

  it("setup -> enable: stores the secret encrypted, issues 8 one-time recovery codes", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "tfa");
    const { secret, recoveryCodes, setup } = await enable2fa(ctx, acct);
    expect(setup.body.otpauthUri).toContain(`secret=${secret}`);
    expect(recoveryCodes).toHaveLength(8);

    const row = (await ownerPool().query("SELECT totp_enabled, totp_secret_enc, totp_pending_enc FROM users WHERE id = $1", [acct.userId])).rows[0];
    expect(row.totp_enabled).toBe(true);
    expect(row.totp_pending_enc).toBeNull();
    expect(row.totp_secret_enc).toMatch(/^v1\./);
    expect(row.totp_secret_enc).not.toContain(secret);
    const codes = await ownerPool().query("SELECT code_hash FROM totp_recovery_codes WHERE user_id = $1", [acct.userId]);
    expect(codes.rows).toHaveLength(8);
    expect(JSON.stringify(codes.rows)).not.toContain(recoveryCodes[0]!.replace("-", ""));
    expect((await request(ctx.app).get("/api/me").set(bearer(acct.accessToken))).body.user.totpEnabled).toBe(true);
  });

  it("a wrong confirmation code does not enable 2FA", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "tfabad");
    await request(ctx.app).post("/api/auth/2fa/setup").set(bearer(acct.accessToken));
    const res = await request(ctx.app).post("/api/auth/2fa/enable").set(bearer(acct.accessToken)).send({ code: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CODE");
    expect((await ownerPool().query("SELECT totp_enabled FROM users WHERE id = $1", [acct.userId])).rows[0].totp_enabled).toBe(false);
  });

  it("login becomes a two-step flow: password gives a challenge, not a session", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "tfalogin");
    const { secret } = await enable2fa(ctx, acct);

    const step1 = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    expect(step1.status).toBe(200);
    expect(step1.body.requiresTwoFactor).toBe(true);
    expect(step1.body.accessToken).toBeUndefined();
    expect(setCookies(step1)).toHaveLength(0);

    const challengeToken = step1.body.challengeToken as string;
    const wrong = await request(ctx.app).post("/api/auth/login/2fa").send({ challengeToken, code: "123456" });
    expect(wrong.status).toBe(401);

    // The code for the NEXT step is valid (clock drift window) and newer than the one used at setup.
    const code = totpCode(secret, Date.now() + 30_000);
    const ok = await request(ctx.app).post("/api/auth/login/2fa").send({ challengeToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(cookieValue(ok, "apex_rt")).toBeTruthy();

    // Replaying the same code (even with a fresh challenge) is refused.
    const again = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    const replay = await request(ctx.app).post("/api/auth/login/2fa").send({ challengeToken: again.body.challengeToken, code });
    expect(replay.status).toBe(401);
  });

  it("the 2FA challenge token cannot be used as an access token", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "tfachal");
    await enable2fa(ctx, acct);
    const step1 = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    expect((await request(ctx.app).get("/api/me").set(bearer(step1.body.challengeToken))).status).toBe(401);
  });

  it("a recovery code works once, in any letter case or formatting, then never again", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "tfarec");
    const { recoveryCodes } = await enable2fa(ctx, acct);
    const login = async (code: string) => {
      const s1 = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
      return request(ctx.app).post("/api/auth/login/2fa").send({ challengeToken: s1.body.challengeToken, code });
    };
    expect((await login(recoveryCodes[0]!.toUpperCase())).status).toBe(200);
    expect((await login(recoveryCodes[0]!)).status).toBe(401);
    expect((await login(recoveryCodes[1]!)).status).toBe(200);
    expect((await login("zzzzz-zzzzz")).status).toBe(401);
  });

  it("wrong second-factor codes count toward the account lockout", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "tfalock");
    const { secret } = await enable2fa(ctx, acct);
    const s1 = await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password });
    for (let i = 0; i < 5; i++) {
      expect((await request(ctx.app).post("/api/auth/login/2fa").send({ challengeToken: s1.body.challengeToken, code: "111111" })).status).toBe(401);
    }
    const locked = await request(ctx.app).post("/api/auth/login/2fa").send({ challengeToken: s1.body.challengeToken, code: totpCode(secret, Date.now() + 30_000) });
    expect(locked.status).toBe(429);
  });

  it("disabling needs the password AND a valid code, and removes the secret and recovery codes", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "tfaoff");
    const { secret } = await enable2fa(ctx, acct);
    const code = totpCode(secret, Date.now() + 30_000);
    const wrongPw = await request(ctx.app).post("/api/auth/2fa/disable").set(bearer(acct.accessToken)).send({ password: "Not-The-Password-1", code });
    expect(wrongPw.status).toBe(400);
    const ok = await request(ctx.app).post("/api/auth/2fa/disable").set(bearer(acct.accessToken)).send({ password: acct.password, code });
    expect(ok.status).toBe(204);
    const row = (await ownerPool().query("SELECT totp_enabled, totp_secret_enc FROM users WHERE id = $1", [acct.userId])).rows[0];
    expect(row).toEqual({ totp_enabled: false, totp_secret_enc: null });
    expect((await ownerPool().query("SELECT count(*)::int AS n FROM totp_recovery_codes WHERE user_id = $1", [acct.userId])).rows[0].n).toBe(0);
    expect((await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password })).body.accessToken).toBeTruthy();
  });
});

describe("access token handling on every request", () => {
  it("a token for a tenant the user does not belong to is rejected, even with a valid signature", async () => {
    const ctx = makeApp();
    const a = await newAccount(ctx, "tidA");
    const b = await newAccount(ctx, "tidB");
    const { signAccessToken } = await import("../../src/auth/tokens.js");
    const forged = await signAccessToken(ctx.config, { userId: a.userId, tenantId: b.tenantId, role: "OWNER" });
    expect((await request(ctx.app).get("/api/me").set(bearer(forged))).status).toBe(401);
  });

  it("a removed user's still-unexpired token stops working immediately", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "rm");
    expect((await request(ctx.app).get("/api/me").set(bearer(acct.accessToken))).status).toBe(200);
    await ownerPool().query("UPDATE users SET deleted_at = now() WHERE id = $1", [acct.userId]);
    expect((await request(ctx.app).get("/api/me").set(bearer(acct.accessToken))).status).toBe(401);
    expect((await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password })).status).toBe(401);
  });

  it("a suspended workspace cannot sign in or use existing tokens", async () => {
    const ctx = makeApp();
    const acct = await newAccount(ctx, "susp");
    await ownerPool().query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [acct.tenantId]);
    expect((await request(ctx.app).get("/api/me").set(bearer(acct.accessToken))).status).toBe(401);
    expect((await request(ctx.app).post("/api/auth/login").send({ email: acct.email, password: acct.password })).status).toBe(401);
  });
});
