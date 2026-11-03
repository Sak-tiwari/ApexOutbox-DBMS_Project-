import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { AuthService } from "../../src/auth/service.js";
import { createApp } from "../../src/app.js";
import { parseConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { appPool } from "./db.js";

export const TEST_ORIGIN = "http://localhost:5173";
export const TEST_PASSWORD = "Correct-Horse-Battery-9";

/** Fixed, obviously-fake test secrets. Real secrets only ever come from the environment. */
export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return parseConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    JWT_ACCESS_SECRET: "test-only-access-secret-0123456789abcdef-test-only",
    TOTP_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_ORIGINS: TEST_ORIGIN,
    COOKIE_SECURE: "false",
    INVOICE_STORAGE_DIR: path.join(os.tmpdir(), "apex-test-invoices"),
    ...overrides,
  });
}

export interface TestCtx {
  app: Express;
  config: Config;
  auth: AuthService;
}

/** A fresh app (and therefore fresh rate limiters) per call. */
export function makeApp(overrides: Record<string, string | undefined> = {}, now?: () => number): TestCtx {
  const config = testConfig(overrides);
  const log = createLogger("silent");
  const db = appPool();
  return { app: createApp({ db, log, config, now }), config, auth: new AuthService(db, config, log) };
}

export interface Account {
  tenantId: string;
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

/** Registers a workspace + OWNER directly through the service (no HTTP, so no register rate limit). */
export async function newAccount(ctx: TestCtx, label = "acct"): Promise<Account> {
  const tag = randomUUID().slice(0, 8);
  const email = `${label}-${tag}@example.com`;
  const { user, session } = await ctx.auth.register(
    { tenantName: `Workspace ${label} ${tag}`, name: "Test Person", email, password: TEST_PASSWORD },
    { ip: "203.0.113.9" },
  );
  return { tenantId: user.tenantId, userId: user.id, email, password: TEST_PASSWORD, accessToken: session.accessToken, refreshToken: session.refreshToken };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Headers a browser would send to a cookie-authenticated endpoint (refresh/logout). */
export function cookieHeaders(refreshToken: string, csrf = "csrf-token-for-tests") {
  return { Cookie: `apex_rt=${refreshToken}; apex_csrf=${csrf}`, "X-CSRF-Token": csrf, Origin: TEST_ORIGIN };
}

export function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
}

export function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
  return line?.split(";")[0]?.slice(name.length + 1) || undefined;
}

/**
 * Creates a user with the given role through the API (as `actorToken`), signs them in with the temporary
 * password, and completes the forced password change. Returns a ready-to-use access token.
 */
export async function userWithRole(ctx: TestCtx, actorToken: string, role: "OWNER" | "ADMIN" | "MEMBER", label = role.toLowerCase()) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
  const created = await request(ctx.app).post("/api/users").set(bearer(actorToken)).send({ email, name: `User ${label}`, role });
  if (created.status !== 201) throw new Error(`could not create ${role}: ${created.status} ${JSON.stringify(created.body)}`);
  const login = await request(ctx.app).post("/api/auth/login").send({ email, password: created.body.temporaryPassword });
  const changed = await request(ctx.app)
    .post("/api/auth/password/change")
    .set(bearer(login.body.accessToken))
    .send({ currentPassword: created.body.temporaryPassword, newPassword: TEST_PASSWORD });
  if (changed.status !== 200) throw new Error(`password change failed: ${changed.status} ${JSON.stringify(changed.body)}`);
  return { id: created.body.user.id as string, email, accessToken: changed.body.accessToken as string, refreshToken: cookieValue(changed, "apex_rt")! };
}
