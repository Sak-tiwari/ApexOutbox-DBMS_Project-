import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "../config.js";
import { ForbiddenError } from "../errors.js";
import { CSRF_COOKIE, readCookies } from "./cookies.js";

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * CSRF protection for the only cookie-authenticated endpoints (refresh, logout). Three layers:
 *   1. The refresh cookie is SameSite=Strict, so browsers do not attach it to cross-site requests.
 *   2. The request's Origin (or Referer) must be one of ALLOWED_ORIGINS.
 *   3. Double-submit token: header X-CSRF-Token must equal the csrf cookie. A cross-site page can
 *      neither read that cookie nor set the header.
 * Every other API route authenticates with an Authorization header, which browsers never add on their own.
 */
export function requireCsrf(config: Pick<Config, "allowedOrigins">): RequestHandler {
  return (req, _res, next) => {
    const origin = req.header("origin") ?? safeOrigin(req.header("referer"));
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return next(new ForbiddenError("Request origin is not allowed", "CSRF_ORIGIN"));
    }
    const cookie = readCookies(req)[CSRF_COOKIE];
    const header = req.header("x-csrf-token");
    if (!cookie || !header || !safeEqual(cookie, header)) {
      return next(new ForbiddenError("Missing or invalid CSRF token", "CSRF_TOKEN"));
    }
    next();
  };
}

function safeOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
