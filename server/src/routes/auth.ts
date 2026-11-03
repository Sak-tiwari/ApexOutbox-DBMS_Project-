import { createHash } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import type { AuthService, SessionTokens, AuthUser } from "../auth/service.js";
import type { Config } from "../config.js";
import { UnauthenticatedError } from "../errors.js";
import { clearCsrfCookie, clearRefreshCookie, readCookies, REFRESH_COOKIE, setCsrfCookie, setRefreshCookie } from "../http/cookies.js";
import { newCsrfToken, requireCsrf } from "../http/csrf.js";
import { rateLimit } from "../http/rateLimit.js";
import { parse } from "../http/validate.js";
import { authOf, requestMeta, type AuthMiddleware } from "../middleware/auth.js";

const email = z.string().trim().toLowerCase().email().max(254);
const secret = z.string().min(1).max(128);

const registerSchema = z.object({
  tenantName: z.string().trim().min(2).max(100),
  name: z.string().trim().min(1).max(100),
  email,
  password: secret,
});
const loginSchema = z.object({ email, password: secret });
const twoFactorSchema = z.object({ challengeToken: z.string().min(10).max(2000), code: z.string().trim().min(6).max(24) });
const changePasswordSchema = z.object({ currentPassword: secret, newPassword: secret });
const codeSchema = z.object({ code: z.string().trim().min(6).max(24) });
const disableSchema = z.object({ password: secret, code: z.string().trim().min(6).max(24) });

const userPayload = (u: AuthUser) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  totpEnabled: u.totpEnabled,
  mustChangePassword: u.mustChangePassword,
});

export function createAuthRouter(deps: { config: Config; service: AuthService; auth: AuthMiddleware; now?: () => number }) {
  const { config, service, auth } = deps;
  const router = Router();

  const startSession = (res: Response, session: SessionTokens) => {
    setRefreshCookie(res, config, session.refreshToken, session.refreshMaxAgeSeconds);
    setCsrfCookie(res, config, newCsrfToken(), session.refreshMaxAgeSeconds);
  };
  const endSession = (res: Response) => {
    clearRefreshCookie(res, config);
    clearCsrfCookie(res, config);
  };
  const body = (session: SessionTokens, user: AuthUser) => ({
    accessToken: session.accessToken,
    expiresIn: session.expiresInSeconds,
    user: userPayload(user),
  });

  // Brute-force protection, in addition to the per-account lockout in the database.
  const byEmail = (req: { body?: { email?: unknown } }) =>
    createHash("sha256").update(String(req.body?.email ?? "").trim().toLowerCase()).digest("hex").slice(0, 32);
  const loginIpLimit = rateLimit({ name: "login-ip", limit: 20, windowMs: 15 * 60_000, now: deps.now });
  const loginEmailLimit = rateLimit({ name: "login-email", limit: 10, windowMs: 15 * 60_000, key: byEmail, now: deps.now });
  const registerLimit = rateLimit({ name: "register", limit: 5, windowMs: 60 * 60_000, now: deps.now });
  const secondFactorLimit = rateLimit({ name: "2fa", limit: 15, windowMs: 15 * 60_000, now: deps.now });
  const refreshLimit = rateLimit({ name: "refresh", limit: 60, windowMs: 60_000, now: deps.now });

  router.post("/register", registerLimit, async (req, res) => {
    const input = parse(registerSchema, req.body);
    const { user, session } = await service.register(input, requestMeta(req));
    startSession(res, session);
    res.status(201).json(body(session, user));
  });

  router.post("/login", loginIpLimit, loginEmailLimit, async (req, res) => {
    const input = parse(loginSchema, req.body);
    const result = await service.login(input.email, input.password, requestMeta(req));
    if (result.kind === "two_factor") {
      res.json({ requiresTwoFactor: true, challengeToken: result.challengeToken });
      return;
    }
    startSession(res, result.session);
    res.json(body(result.session, result.user));
  });

  router.post("/login/2fa", loginIpLimit, secondFactorLimit, async (req, res) => {
    const input = parse(twoFactorSchema, req.body);
    const result = await service.loginWithSecondFactor(input.challengeToken, input.code, requestMeta(req));
    startSession(res, result.session);
    res.json(body(result.session, result.user));
  });

  // Cookie-authenticated, so CSRF-protected.
  router.post("/refresh", refreshLimit, requireCsrf(config), async (req, res) => {
    const token = readCookies(req)[REFRESH_COOKIE];
    if (!token) throw new UnauthenticatedError("Session expired. Please sign in again.");
    try {
      const { user, session } = await service.refresh(token, requestMeta(req));
      startSession(res, session);
      res.json(body(session, user));
    } catch (error) {
      if (error instanceof UnauthenticatedError) endSession(res); // drop the dead cookies
      throw error;
    }
  });

  router.post("/logout", requireCsrf(config), async (req, res) => {
    await service.logout(readCookies(req)[REFRESH_COOKIE], requestMeta(req));
    endSession(res);
    res.status(204).end();
  });

  router.post("/logout-all", auth.requireAuth(), async (req, res) => {
    const a = authOf(req);
    await service.logoutEverywhere(a.tenantId, a.userId, requestMeta(req));
    endSession(res);
    res.status(204).end();
  });

  router.post("/password/change", auth.requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
    const a = authOf(req);
    const input = parse(changePasswordSchema, req.body);
    const { user, session } = await service.changePassword(a, input.currentPassword, input.newPassword, requestMeta(req));
    startSession(res, session);
    res.json(body(session, user));
  });

  router.post("/2fa/setup", auth.requireAuth(), async (req, res) => {
    res.json(await service.beginTotpSetup(authOf(req)));
  });
  router.post("/2fa/enable", auth.requireAuth(), async (req, res) => {
    const input = parse(codeSchema, req.body);
    res.json(await service.confirmTotpSetup(authOf(req), input.code, requestMeta(req)));
  });
  router.post("/2fa/disable", auth.requireAuth(), async (req, res) => {
    const input = parse(disableSchema, req.body);
    await service.disableTotp(authOf(req), input.password, input.code, requestMeta(req));
    res.status(204).end();
  });

  return router;
}
