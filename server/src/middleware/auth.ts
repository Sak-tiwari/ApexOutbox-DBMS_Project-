import type { Request, RequestHandler } from "express";
import { can, type Permission, type Role } from "../auth/rbac.js";
import { verifyAccessToken } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { withTenant, type Db } from "../db/pool.js";
import { ForbiddenError, UnauthenticatedError } from "../errors.js";

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  name: string;
  mustChangePassword: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

/** The authenticated caller, or throws 401. Use inside handlers that sit behind requireAuth. */
export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new UnauthenticatedError();
  return req.auth;
}

export function requestMeta(req: Request) {
  return { ip: req.ip, userAgent: req.header("user-agent") };
}

export function createAuthMiddleware(deps: { db: Db; config: Config }) {
  /**
   * Authenticates the Bearer access token, then RE-READS the user and tenant from the database.
   * The token's role is only a hint: a demoted, removed or suspended user loses access on the very
   * next request instead of when the token expires.
   */
  function requireAuth(options: { allowPendingPasswordChange?: boolean } = {}): RequestHandler {
    return async (req, _res, next) => {
      const header = req.header("authorization") ?? "";
      if (!header.startsWith("Bearer ")) throw new UnauthenticatedError();
      const claims = await verifyAccessToken(deps.config, header.slice(7).trim());

      const row = await withTenant(deps.db, claims.tenantId, async (tx) => {
        const { rows } = await tx.query<{ id: string; email: string; name: string; role: Role; must_change_password: boolean }>(
          `SELECT u.id, u.email, u.name, u.role, u.must_change_password
             FROM users u JOIN tenants t ON t.id = u.tenant_id
            WHERE u.tenant_id = $1 AND u.id = $2 AND u.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status = 'ACTIVE'`,
          [claims.tenantId, claims.userId],
        );
        return rows[0];
      });
      if (!row) throw new UnauthenticatedError("Invalid or expired access token");

      if (row.must_change_password && !options.allowPendingPasswordChange) {
        throw new ForbiddenError("You must choose a new password before continuing", "PASSWORD_CHANGE_REQUIRED");
      }
      req.auth = {
        userId: row.id,
        tenantId: claims.tenantId,
        role: row.role, // from the database, not from the token
        email: row.email,
        name: row.name,
        mustChangePassword: row.must_change_password,
      };
      next();
    };
  }

  function requirePermission(permission: Permission): RequestHandler {
    return (req, _res, next) => {
      const auth = authOf(req);
      if (!can(auth.role, permission)) throw new ForbiddenError("You do not have permission to do that", "FORBIDDEN");
      next();
    };
  }

  return { requireAuth, requirePermission };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;
