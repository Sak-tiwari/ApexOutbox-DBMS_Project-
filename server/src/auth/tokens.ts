import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config.js";
import { UnauthenticatedError } from "../errors.js";
import { isRole, type Role } from "./rbac.js";

const ISSUER = "apexoutbox";
const AUDIENCE = "apexoutbox-api";

export interface AccessClaims {
  userId: string;
  tenantId: string;
  role: Role;
}

const secretKey = (config: Pick<Config, "JWT_ACCESS_SECRET">) => new TextEncoder().encode(config.JWT_ACCESS_SECRET);

/**
 * Short-lived access token (default 10 min), sent in the Authorization header. Because it is NOT a
 * cookie, API routes cannot be triggered cross-site (no CSRF surface). The role in the token is a hint:
 * the server re-reads the user on every request, so a role change or deletion takes effect at once.
 */
export async function signAccessToken(config: Config, claims: AccessClaims): Promise<string> {
  return new SignJWT({ tid: claims.tenantId, role: claims.role, typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey(config));
}

export async function verifyAccessToken(config: Config, token: string): Promise<AccessClaims> {
  try {
    // Only HS256 is accepted: blocks "alg: none" and algorithm-confusion tricks.
    const { payload } = await jwtVerify(token, secretKey(config), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    if (payload.typ !== "access" || typeof payload.sub !== "string" || typeof payload.tid !== "string" || !isRole(payload.role)) {
      throw new Error("bad claims");
    }
    return { userId: payload.sub, tenantId: payload.tid, role: payload.role };
  } catch {
    throw new UnauthenticatedError("Invalid or expired access token");
  }
}

/** Proof that the password step succeeded, exchanged together with a TOTP code for a real session. */
export async function signTwoFactorChallenge(config: Config, userId: string, tenantId: string): Promise<string> {
  return new SignJWT({ tid: tenantId, typ: "2fa" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secretKey(config));
}

export async function verifyTwoFactorChallenge(config: Config, token: string): Promise<{ userId: string; tenantId: string }> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    if (payload.typ !== "2fa" || typeof payload.sub !== "string" || typeof payload.tid !== "string") throw new Error("bad claims");
    return { userId: payload.sub, tenantId: payload.tid };
  } catch {
    throw new UnauthenticatedError("The sign-in step expired. Please sign in again.");
  }
}

/** 256 random bits. Only its SHA-256 hash is ever stored. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
