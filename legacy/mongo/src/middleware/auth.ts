import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { UnauthenticatedError } from "../errors";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * API-key authentication. The caller proves who they are with a secret key; the user id comes from
 * the server-side key map. Phase 3's `x-user-id` header was removed on purpose: it let any caller
 * claim to be any lead owner.
 */
export function apiKeyAuth(keys: Map<string, string>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.header("x-api-key") ?? "");
    if (!presented) return next(new UnauthenticatedError());
    let userId: string | undefined;
    for (const [key, user] of keys) {
      // Compare against every key so timing does not reveal which prefix matched.
      if (safeEqual(key, presented)) userId = user;
    }
    if (!userId) return next(new UnauthenticatedError());
    req.userId = userId;
    next();
  };
}
