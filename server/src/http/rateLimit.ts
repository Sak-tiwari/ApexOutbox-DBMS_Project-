import type { Request, RequestHandler } from "express";
import { TooManyRequestsError } from "../errors.js";

export interface RateLimitOptions {
  /** Used in the key so different limiters never share counters. */
  name: string;
  limit: number;
  windowMs: number;
  /** Defaults to the client IP. */
  key?: (req: Request) => string;
  now?: () => number;
}

/**
 * Fixed-window limiter, in memory. State is per process: behind several API replicas the effective limit
 * is limit x replicas, so put a gateway limiter in front for a hard global limit (see docs). Set
 * TRUST_PROXY so req.ip is the real client address, not the proxy's.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req, res, next) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);

    const key = `${options.name}:${options.key ? options.key(req) : req.ip || "unknown"}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + options.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    res.setHeader("RateLimit-Limit", String(options.limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.limit - entry.count)));
    if (entry.count > options.limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      return next(new TooManyRequestsError("Too many requests. Please slow down and try again shortly.", retryAfter));
    }
    next();
  };
}
