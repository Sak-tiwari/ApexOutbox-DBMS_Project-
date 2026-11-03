import type { RequestHandler } from "express";
import helmet from "helmet";
import type { Config } from "../config.js";
import { ForbiddenError } from "../errors.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Security headers. The API only returns JSON/PDF/CSV, so its CSP forbids everything. The bundled SPA (when this server serves it)
 * gets a strict policy: scripts and styles from our own origin only, no inline script, no eval, no framing, no plugins.
 * HSTS is sent only in production over HTTPS, so local http development is never pinned to https.
 */
export function securityHeaders(config: Pick<Config, "NODE_ENV">): RequestHandler {
  const common = {
    hsts: config.NODE_ENV === "production" ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
    crossOriginResourcePolicy: { policy: "same-origin" as const },
    referrerPolicy: { policy: "no-referrer" as const },
  };
  const api = helmet({ ...common, contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  const spa = helmet({
    ...common,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
        // React sets a few inline style="" attributes (progress bars). Attribute styles cannot run script.
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", "data:"], fontSrc: ["'self'"], connectSrc: ["'self'"], manifestSrc: ["'self'"], workerSrc: ["'self'"],
        objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      },
    },
  });
  return (req, res, next) => (req.path.startsWith("/api/") || req.path === "/health" || req.path === "/ready" ? api(req, res, next) : spa(req, res, next));
}

/**
 * Strict CORS allowlist. A request from an origin that is not in ALLOWED_ORIGINS gets no CORS headers (so the browser blocks the
 * response) and, if it would change state, is refused outright: the request is never executed. Requests without an Origin header
 * (curl, server-to-server, same-origin GET) are not browser cross-site requests and are unaffected.
 */
export function corsAllowlist(config: Pick<Config, "allowedOrigins">): RequestHandler {
  const allowed = new Set(config.allowedOrigins);
  return (req, res, next) => {
    const origin = req.header("origin");
    res.vary("Origin");
    if (!origin) return next();
    if (!allowed.has(origin)) {
      if (!SAFE.has(req.method) || req.method === "OPTIONS") return next(new ForbiddenError("Request origin is not allowed", "CORS_ORIGIN"));
      return next();
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", "Retry-After, X-Request-Id");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-CSRF-Token");
      res.setHeader("Access-Control-Max-Age", "600");
      return void res.status(204).end();
    }
    next();
  };
}

/** Spreadsheet formula injection: a cell that starts with = + - @ TAB or CR is executed by Excel/Sheets. Prefix an apostrophe. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");
