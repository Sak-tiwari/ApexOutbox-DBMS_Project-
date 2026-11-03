import { randomBytes, randomUUID } from "node:crypto";
import { writeAudit } from "../audit.js";
import type { Config } from "../config.js";
import { withTenant, type Db, type Tx } from "../db/pool.js";
import { ConflictError, TooManyRequestsError, UnauthenticatedError, ValidationError } from "../errors.js";
import type { Log } from "../logger.js";
import { checkPasswordPolicy, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from "./password.js";
import type { Role } from "./rbac.js";
import {
  hashToken,
  newOpaqueToken,
  signAccessToken,
  signTwoFactorChallenge,
  verifyTwoFactorChallenge,
} from "./tokens.js";
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.js";

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
  mustChangePassword: boolean;
}

export interface SessionTokens {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshMaxAgeSeconds: number;
}

export type LoginResult =
  | { kind: "session"; user: AuthUser; session: SessionTokens }
  | { kind: "two_factor"; challengeToken: string };

export const DEFAULT_TENANT_SETTINGS = {
  features: { scraper: true, invoices: true, email: true },
  invoice: { prefix: "INV", currency: "INR", defaultTaxRateBp: 1800 },
} as const;

/** A refresh token used again within this window is treated as a parallel-tab race, not as theft. */
const REFRESH_RACE_GRACE_MS = 10_000;

const INVALID_CREDENTIALS = "Invalid email or password";

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  must_change_password: boolean;
  totp_enabled: boolean;
  totp_secret_enc: string | null;
  totp_pending_enc: string | null;
  totp_last_step: number | null;
  failed_login_count: number;
  locked_until: Date | null;
}

const toAuthUser = (r: Pick<UserRow, "id" | "tenant_id" | "email" | "name" | "role" | "totp_enabled" | "must_change_password">): AuthUser => ({
  id: r.id,
  tenantId: r.tenant_id,
  email: r.email,
  name: r.name,
  role: r.role,
  totpEnabled: r.totp_enabled,
  mustChangePassword: r.must_change_password,
});

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return `${base.length >= 2 ? base : "workspace"}-${randomBytes(3).toString("hex")}`;
}

const isUniqueViolation = (e: unknown, constraint: string) =>
  (e as { code?: string; constraint?: string })?.code === "23505" && (e as { constraint?: string }).constraint === constraint;

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: Log,
  ) {}

  // ------------------------------------------------------------------------------------------
  // registration
  // ------------------------------------------------------------------------------------------

  async register(input: { tenantName: string; name: string; email: string; password: string }, meta: RequestMeta) {
    const email = input.email.trim().toLowerCase();
    this.assertPasswordOk(input.password, { email, name: input.name });
    const passwordHash = await hashPassword(input.password);
    const tenantId = randomUUID();

    try {
      return await withTenant(this.db, tenantId, async (tx) => {
        // Inside the new tenant's own context: the RLS policy lets us create exactly this one tenant.
        await tx.query("INSERT INTO tenants (id, slug, name, settings) VALUES ($1, $2, $3, $4)", [
          tenantId,
          slugify(input.tenantName),
          input.tenantName.trim(),
          JSON.stringify(DEFAULT_TENANT_SETTINGS),
        ]);
        await tx.query("INSERT INTO invoice_counters (tenant_id) VALUES ($1)", [tenantId]);
        const { rows } = await tx.query<UserRow>(
          `INSERT INTO users (tenant_id, email, name, password_hash, role, last_login_at)
           VALUES ($1, $2, $3, $4, 'OWNER', now())
           RETURNING id, tenant_id, email, name, role, totp_enabled, must_change_password`,
          [tenantId, email, input.name.trim(), passwordHash],
        );
        const user = toAuthUser(rows[0]!);
        await writeAudit(tx, { tenantId, actorId: user.id, action: "tenant.registered", entityType: "tenant", entityId: tenantId, ip: meta.ip });
        const session = await this.issueSession(tx, user, meta);
        return { user, session };
      });
    } catch (error) {
      if (isUniqueViolation(error, "users_email_uq")) {
        throw new ConflictError("An account with this e-mail address already exists", "EMAIL_TAKEN");
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------
  // login (password, then TOTP when enabled)
  // ------------------------------------------------------------------------------------------

  async login(emailRaw: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const email = emailRaw.trim().toLowerCase();
    const { rows } = await this.db.query<UserRow>("SELECT * FROM auth_find_user_by_email($1)", [email]);
    const found = rows[0];

    if (!found) {
      await verifyAgainstDummy(password); // same cost as a real check: no user enumeration by timing
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }
    this.assertNotLocked(found.locked_until);

    if (!(await verifyPassword(found.password_hash, password))) {
      await this.recordFailure(found.tenant_id, found.id, "auth.login_failed", meta);
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }

    if (found.totp_enabled) {
      return { kind: "two_factor", challengeToken: await signTwoFactorChallenge(this.config, found.id, found.tenant_id) };
    }

    const newHash = needsRehash(found.password_hash) ? await hashPassword(password) : null;
    return withTenant(this.db, found.tenant_id, async (tx) => {
      await tx.query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(),
                          password_hash = COALESCE($3, password_hash)
          WHERE tenant_id = $1 AND id = $2`,
        [found.tenant_id, found.id, newHash],
      );
      const user = toAuthUser(found);
      await writeAudit(tx, { tenantId: found.tenant_id, actorId: found.id, action: "auth.login", ip: meta.ip });
      return { kind: "session" as const, user, session: await this.issueSession(tx, user, meta) };
    });
  }

  async loginWithSecondFactor(challengeToken: string, code: string, meta: RequestMeta) {
    const { userId, tenantId } = await verifyTwoFactorChallenge(this.config, challengeToken);

    const outcome = await withTenant(this.db, tenantId, async (tx) => {
      const user = await this.lockUser(tx, tenantId, userId);
      if (!user || !user.totp_enabled) return { ok: false as const, locked: null };
      if (user.locked_until && user.locked_until > new Date()) return { ok: false as const, locked: user.locked_until };

      if (await this.checkSecondFactor(tx, user, code)) {
        await tx.query(
          "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE tenant_id = $1 AND id = $2",
          [tenantId, userId],
        );
        await writeAudit(tx, { tenantId, actorId: userId, action: "auth.login", metadata: { twoFactor: true }, ip: meta.ip });
        const authUser = toAuthUser(user);
        return { ok: true as const, user: authUser, session: await this.issueSession(tx, authUser, meta) };
      }
      await this.countFailure(tx, tenantId, userId, "auth.second_factor_failed", meta);
      return { ok: false as const, locked: null };
    });

    if (outcome.ok) return { kind: "session" as const, user: outcome.user, session: outcome.session };
    this.assertNotLocked(outcome.locked);
    throw new UnauthenticatedError("Invalid verification code");
  }

  // ------------------------------------------------------------------------------------------
  // refresh-token rotation
  // ------------------------------------------------------------------------------------------

  async refresh(rawToken: string, meta: RequestMeta): Promise<{ user: AuthUser; session: SessionTokens }> {
    const { rows } = await this.db.query<{ id: string; tenant_id: string }>("SELECT * FROM auth_find_refresh_token($1)", [hashToken(rawToken)]);
    const found = rows[0];
    if (!found) throw new UnauthenticatedError("Session expired. Please sign in again.");

    const outcome = await withTenant(this.db, found.tenant_id, async (tx) => {
      const { rows: tokens } = await tx.query<{
        id: string; user_id: string; family_id: string; expires_at: Date; family_expires_at: Date; used_at: Date | null; revoked_at: Date | null;
      }>(
        `SELECT id, user_id, family_id, expires_at, family_expires_at, used_at, revoked_at
           FROM refresh_tokens WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [found.id, found.tenant_id],
      );
      const token = tokens[0];
      const now = Date.now();
      if (!token || token.revoked_at || token.expires_at.getTime() <= now || token.family_expires_at.getTime() <= now) {
        return { ok: false as const };
      }
      if (token.used_at) {
        if (now - token.used_at.getTime() < REFRESH_RACE_GRACE_MS) return { ok: false as const }; // parallel tabs
        // A token that was already exchanged is being presented again: it was stolen or replayed.
        await tx.query(
          "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'reuse_detected' WHERE tenant_id = $1 AND family_id = $2 AND revoked_at IS NULL",
          [found.tenant_id, token.family_id],
        );
        await writeAudit(tx, { tenantId: found.tenant_id, actorId: token.user_id, action: "auth.refresh_reuse_detected", ip: meta.ip });
        this.log.warn({ tenantId: found.tenant_id, userId: token.user_id }, "refresh token reuse detected; session family revoked");
        return { ok: false as const };
      }

      const user = await this.loadActiveUser(tx, found.tenant_id, token.user_id);
      if (!user) return { ok: false as const };

      await tx.query("UPDATE refresh_tokens SET used_at = now() WHERE id = $1", [token.id]);
      const { session, tokenId } = await this.issueSessionWithId(tx, user, meta, { id: token.family_id, expiresAt: token.family_expires_at });
      await tx.query("UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1", [token.id, tokenId]);
      return { ok: true as const, user, session };
    });

    if (!outcome.ok) throw new UnauthenticatedError("Session expired. Please sign in again.");
    return { user: outcome.user, session: outcome.session };
  }

  /** Ends the session chain behind this refresh token. Idempotent: unknown tokens are ignored. */
  async logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!rawToken) return;
    const { rows } = await this.db.query<{ id: string; tenant_id: string; user_id: string }>("SELECT * FROM auth_find_refresh_token($1)", [hashToken(rawToken)]);
    const found = rows[0];
    if (!found) return;
    await withTenant(this.db, found.tenant_id, async (tx) => {
      await tx.query(
        `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
          WHERE tenant_id = $1 AND revoked_at IS NULL
            AND family_id = (SELECT family_id FROM refresh_tokens WHERE id = $2 AND tenant_id = $1)`,
        [found.tenant_id, found.id],
      );
      await writeAudit(tx, { tenantId: found.tenant_id, actorId: found.user_id, action: "auth.logout", ip: meta.ip });
    });
  }

  async logoutEverywhere(tenantId: string, userId: string, meta: RequestMeta): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      await this.revokeUserSessions(tx, tenantId, userId, "logout_all");
      await writeAudit(tx, { tenantId, actorId: userId, action: "auth.logout_all", ip: meta.ip });
    });
  }

  /** Used by password change, password reset and user removal. Call inside the caller's transaction. */
  async revokeUserSessions(tx: Tx, tenantId: string, userId: string, reason: string): Promise<void> {
    await tx.query(
      "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $3 WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [tenantId, userId, reason],
    );
  }

  // ------------------------------------------------------------------------------------------
  // password change
  // ------------------------------------------------------------------------------------------

  async changePassword(auth: { tenantId: string; userId: string }, currentPassword: string, newPassword: string, meta: RequestMeta) {
    const outcome = await withTenant(this.db, auth.tenantId, async (tx) => {
      const user = await this.lockUser(tx, auth.tenantId, auth.userId);
      if (!user) return { kind: "gone" as const };
      if (user.locked_until && user.locked_until > new Date()) return { kind: "locked" as const, until: user.locked_until };
      if (!(await verifyPassword(user.password_hash, currentPassword))) {
        await this.countFailure(tx, auth.tenantId, auth.userId, "auth.password_change_failed", meta);
        return { kind: "wrong" as const };
      }
      const problems = checkPasswordPolicy(newPassword, { email: user.email, name: user.name });
      if (problems.length > 0) return { kind: "weak" as const, problems };
      if (await verifyPassword(user.password_hash, newPassword)) return { kind: "same" as const };

      const hash = await hashPassword(newPassword);
      await tx.query(
        `UPDATE users SET password_hash = $3, password_changed_at = now(), must_change_password = false,
                          failed_login_count = 0, locked_until = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, auth.userId, hash],
      );
      // Every other device is signed out; this one receives a fresh session.
      await this.revokeUserSessions(tx, auth.tenantId, auth.userId, "password_changed");
      await writeAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: "auth.password_changed", ip: meta.ip });
      const authUser = toAuthUser({ ...user, must_change_password: false });
      return { kind: "ok" as const, user: authUser, session: await this.issueSession(tx, authUser, meta) };
    });

    switch (outcome.kind) {
      case "ok":
        return { user: outcome.user, session: outcome.session };
      case "wrong":
        throw new ValidationError("Current password is incorrect", undefined, "INVALID_CURRENT_PASSWORD");
      case "weak":
        throw new ValidationError("Password does not meet the policy", outcome.problems.map((message) => ({ path: "newPassword", message })), "WEAK_PASSWORD");
      case "same":
        throw new ValidationError("Choose a password you have not used before", undefined, "PASSWORD_UNCHANGED");
      case "locked":
        this.assertNotLocked(outcome.until);
        throw new TooManyRequestsError();
      default:
        throw new UnauthenticatedError();
    }
  }

  // ------------------------------------------------------------------------------------------
  // TOTP 2FA
  // ------------------------------------------------------------------------------------------

  /** Step 1: create a pending secret and return it for the authenticator app. Not active until confirmed. */
  async beginTotpSetup(auth: { tenantId: string; userId: string }) {
    return withTenant(this.db, auth.tenantId, async (tx) => {
      const user = await this.lockUser(tx, auth.tenantId, auth.userId);
      if (!user) throw new UnauthenticatedError();
      if (user.totp_enabled) throw new ConflictError("Two-factor authentication is already enabled", "TOTP_ALREADY_ENABLED");
      const secret = generateTotpSecret();
      await tx.query("UPDATE users SET totp_pending_enc = $3 WHERE tenant_id = $1 AND id = $2", [
        auth.tenantId,
        auth.userId,
        encryptSecret(this.config.totpKey, secret),
      ]);
      return { secret, otpauthUri: otpauthUri("ApexOutbox", user.email, secret) };
    });
  }

  /** Step 2: the user proves the app works by entering a code. Returns the one-time recovery codes. */
  async confirmTotpSetup(auth: { tenantId: string; userId: string }, code: string, meta: RequestMeta) {
    return withTenant(this.db, auth.tenantId, async (tx) => {
      const user = await this.lockUser(tx, auth.tenantId, auth.userId);
      if (!user) throw new UnauthenticatedError();
      if (user.totp_enabled) throw new ConflictError("Two-factor authentication is already enabled", "TOTP_ALREADY_ENABLED");
      if (!user.totp_pending_enc) throw new ValidationError("Start the setup first", undefined, "TOTP_SETUP_NOT_STARTED");
      const secret = decryptSecret(this.config.totpKey, user.totp_pending_enc);
      const step = verifyTotp(secret, code, Date.now(), null);
      if (step === null) throw new ValidationError("That code is not valid. Check your authenticator app and try again.", undefined, "INVALID_CODE");

      await tx.query(
        `UPDATE users SET totp_enabled = true, totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = $3
          WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, auth.userId, step],
      );
      const recoveryCodes = await this.replaceRecoveryCodes(tx, auth.tenantId, auth.userId);
      await writeAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: "auth.2fa_enabled", ip: meta.ip });
      return { recoveryCodes };
    });
  }

  async disableTotp(auth: { tenantId: string; userId: string }, password: string, code: string, meta: RequestMeta) {
    const outcome = await withTenant(this.db, auth.tenantId, async (tx) => {
      const user = await this.lockUser(tx, auth.tenantId, auth.userId);
      if (!user || !user.totp_enabled) return "not_enabled" as const;
      if (user.locked_until && user.locked_until > new Date()) return "locked" as const;
      const passwordOk = await verifyPassword(user.password_hash, password);
      const codeOk = passwordOk && (await this.checkSecondFactor(tx, user, code));
      if (!codeOk) {
        await this.countFailure(tx, auth.tenantId, auth.userId, "auth.2fa_disable_failed", meta);
        return "wrong" as const;
      }
      await tx.query(
        "UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = NULL WHERE tenant_id = $1 AND id = $2",
        [auth.tenantId, auth.userId],
      );
      await tx.query("DELETE FROM totp_recovery_codes WHERE tenant_id = $1 AND user_id = $2", [auth.tenantId, auth.userId]);
      await writeAudit(tx, { tenantId: auth.tenantId, actorId: auth.userId, action: "auth.2fa_disabled", ip: meta.ip });
      return "ok" as const;
    });
    if (outcome === "ok") return;
    if (outcome === "locked") throw new TooManyRequestsError("Too many failed attempts. Try again later.");
    if (outcome === "not_enabled") throw new ValidationError("Two-factor authentication is not enabled", undefined, "TOTP_NOT_ENABLED");
    throw new ValidationError("Password or code is incorrect", undefined, "INVALID_CREDENTIALS");
  }

  // ------------------------------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------------------------------

  private assertPasswordOk(password: string, ctx: { email: string; name: string }) {
    const problems = checkPasswordPolicy(password, ctx);
    if (problems.length > 0) {
      throw new ValidationError("Password does not meet the policy", problems.map((message) => ({ path: "password", message })), "WEAK_PASSWORD");
    }
  }

  private assertNotLocked(lockedUntil: Date | null) {
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new TooManyRequestsError("Too many failed attempts. Please try again later.", Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
    }
  }

  /** Counts a failure in its own transaction (so it survives the request failing). */
  private async recordFailure(tenantId: string, userId: string, action: string, meta: RequestMeta) {
    await withTenant(this.db, tenantId, (tx) => this.countFailure(tx, tenantId, userId, action, meta));
  }

  private async countFailure(tx: Tx, tenantId: string, userId: string, action: string, meta: RequestMeta) {
    const { rows } = await tx.query<{ failed_login_count: number; locked_until: Date | null }>(
      `UPDATE users
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
        WHERE tenant_id = $1 AND id = $2
        RETURNING failed_login_count, locked_until`,
      [tenantId, userId, this.config.LOGIN_MAX_FAILURES, this.config.LOGIN_LOCK_MINUTES],
    );
    const row = rows[0];
    await writeAudit(tx, { tenantId, actorId: userId, action, ip: meta.ip });
    if (row && row.failed_login_count === this.config.LOGIN_MAX_FAILURES) {
      await writeAudit(tx, { tenantId, actorId: userId, action: "auth.account_locked", ip: meta.ip });
      this.log.warn({ tenantId, userId }, "account locked after repeated failures");
    }
  }

  private async lockUser(tx: Tx, tenantId: string, userId: string): Promise<UserRow | undefined> {
    const { rows } = await tx.query<UserRow>(
      `SELECT id, tenant_id, email, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc,
              totp_pending_enc, totp_last_step, failed_login_count, locked_until
         FROM users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [tenantId, userId],
    );
    return rows[0];
  }

  private async loadActiveUser(tx: Tx, tenantId: string, userId: string): Promise<AuthUser | undefined> {
    const { rows } = await tx.query<UserRow>(
      `SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.totp_enabled, u.must_change_password
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.tenant_id = $1 AND u.id = $2 AND u.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status = 'ACTIVE'`,
      [tenantId, userId],
    );
    return rows[0] ? toAuthUser(rows[0]) : undefined;
  }

  /** Accepts a current TOTP code (never the same step twice) or an unused recovery code. */
  private async checkSecondFactor(tx: Tx, user: UserRow, codeRaw: string): Promise<boolean> {
    const code = codeRaw.trim();
    if (/^\d{6}$/.test(code)) {
      if (!user.totp_secret_enc) return false;
      const secret = decryptSecret(this.config.totpKey, user.totp_secret_enc);
      const step = verifyTotp(secret, code, Date.now(), user.totp_last_step);
      if (step === null) return false;
      await tx.query("UPDATE users SET totp_last_step = $3 WHERE tenant_id = $1 AND id = $2", [user.tenant_id, user.id, step]);
      return true;
    }
    const { rowCount } = await tx.query(
      "UPDATE totp_recovery_codes SET used_at = now() WHERE tenant_id = $1 AND user_id = $2 AND code_hash = $3 AND used_at IS NULL",
      [user.tenant_id, user.id, hashRecoveryCode(code)],
    );
    return rowCount === 1;
  }

  private async replaceRecoveryCodes(tx: Tx, tenantId: string, userId: string): Promise<string[]> {
    await tx.query("DELETE FROM totp_recovery_codes WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]);
    const codes = generateRecoveryCodes(8);
    for (const code of codes) {
      await tx.query("INSERT INTO totp_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1, $2, $3)", [tenantId, userId, hashRecoveryCode(code)]);
    }
    return codes;
  }

  private async issueSession(tx: Tx, user: AuthUser, meta: RequestMeta, family?: { id: string; expiresAt: Date }): Promise<SessionTokens> {
    return (await this.issueSessionWithId(tx, user, meta, family)).session;
  }

  private async issueSessionWithId(tx: Tx, user: AuthUser, meta: RequestMeta, family?: { id: string; expiresAt: Date }) {
    const now = Date.now();
    const familyExpires = family?.expiresAt ?? new Date(now + this.config.REFRESH_FAMILY_MAX_DAYS * 86_400_000);
    const expires = new Date(Math.min(now + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000, familyExpires.getTime()));
    const refreshToken = newOpaqueToken();

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at, family_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [user.tenantId, user.id, family?.id ?? randomUUID(), hashToken(refreshToken), expires, familyExpires, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
    );
    const session: SessionTokens = {
      accessToken: await signAccessToken(this.config, { userId: user.id, tenantId: user.tenantId, role: user.role }),
      expiresInSeconds: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshMaxAgeSeconds: Math.max(1, Math.floor((expires.getTime() - now) / 1000)),
    };
    return { session, tokenId: rows[0]!.id };
  }
}
