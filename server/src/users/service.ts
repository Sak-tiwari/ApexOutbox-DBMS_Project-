import { writeAudit } from "../audit.js";
import type { AuthService } from "../auth/service.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import { canManageRole, type Role } from "../auth/rbac.js";
import { withTenant, type Db, type Tx } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from "../errors.js";
import { cursorTs, decodeCursor, encodeCursor } from "../http/pagination.js";
import type { AuthContext } from "../middleware/auth.js";

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Row {
  id: string; name: string; email: string; role: Role; totp_enabled: boolean; must_change_password: boolean;
  last_login_at: Date | null; created_at: Date; cursor_t?: string;
}

const COLUMNS = "id, name, email, role, totp_enabled, must_change_password, last_login_at, created_at";

const view = (r: Row): UserView => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  totpEnabled: r.totp_enabled,
  mustChangePassword: r.must_change_password,
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
  ) {}

  async list(actor: AuthContext, params: { limit: number; cursor?: string }) {
    const cursor = decodeCursor(params.cursor);
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLUMNS}, ${cursorTs("created_at")} AS cursor_t
           FROM users
          WHERE tenant_id = $1 AND deleted_at IS NULL
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [actor.tenantId, cursor?.t ?? null, cursor?.id ?? null, params.limit + 1],
      );
      const page = rows.slice(0, params.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(view),
        nextCursor: rows.length > params.limit && last ? encodeCursor({ t: last.cursor_t!, id: last.id }) : null,
      };
    });
  }

  /** Creates an account with a random temporary password, shown to the admin ONCE. The user must change it at first sign-in. */
  async create(actor: AuthContext, input: { email: string; name: string; role: Role }, ip?: string) {
    if (!canManageRole(actor.role, input.role)) throw new ForbiddenError("You cannot create a user with that role", "ROLE_NOT_ALLOWED");
    const temporaryPassword = generateTemporaryPassword();
    const hash = await hashPassword(temporaryPassword);
    try {
      return await withTenant(this.db, actor.tenantId, async (tx) => {
        const { rows } = await tx.query<Row>(
          `INSERT INTO users (tenant_id, email, name, password_hash, role, must_change_password)
           VALUES ($1, $2, $3, $4, $5, true) RETURNING ${COLUMNS}`,
          [actor.tenantId, input.email, input.name, hash, input.role],
        );
        const created = rows[0]!;
        await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "user.created", entityType: "user", entityId: created.id, metadata: { role: input.role }, ip });
        return { user: view(created), temporaryPassword };
      });
    } catch (error) {
      if ((error as { code?: string; constraint?: string }).code === "23505") {
        throw new ConflictError("An account with this e-mail address already exists", "EMAIL_TAKEN");
      }
      throw error;
    }
  }

  async update(actor: AuthContext, id: string, patch: { name?: string; role?: Role }, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const target = await this.lockTarget(tx, actor, id);
      if (patch.role !== undefined && patch.role !== target.role) {
        if (target.id === actor.userId) throw new ForbiddenError("You cannot change your own role", "ROLE_NOT_ALLOWED");
        if (!canManageRole(actor.role, patch.role)) throw new ForbiddenError("You cannot assign that role", "ROLE_NOT_ALLOWED");
        if (target.role === "OWNER") await this.assertAnotherOwner(tx, actor.tenantId, target.id);
      }
      const { rows } = await tx.query<Row>(
        `UPDATE users SET name = COALESCE($3, name), role = COALESCE($4, role)
          WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        [actor.tenantId, id, patch.name ?? null, patch.role ?? null],
      );
      await writeAudit(tx, {
        tenantId: actor.tenantId, actorId: actor.userId, action: "user.updated", entityType: "user", entityId: id,
        metadata: { ...(patch.role && patch.role !== target.role ? { role: { from: target.role, to: patch.role } } : {}), ...(patch.name ? { renamed: true } : {}) },
        ip,
      });
      return view(rows[0]!);
    });
  }

  /** Soft delete: the account can no longer sign in (its sessions are revoked) and its e-mail address is freed. */
  async remove(actor: AuthContext, id: string, ip?: string) {
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const target = await this.lockTarget(tx, actor, id);
      if (target.id === actor.userId) throw new ForbiddenError("You cannot remove your own account here", "SELF_ACTION");
      if (target.role === "OWNER") await this.assertAnotherOwner(tx, actor.tenantId, target.id);
      await tx.query("UPDATE users SET deleted_at = now() WHERE tenant_id = $1 AND id = $2", [actor.tenantId, id]);
      await this.auth.revokeUserSessions(tx, actor.tenantId, id, "user_removed");
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "user.removed", entityType: "user", entityId: id, ip });
    });
  }

  async resetPassword(actor: AuthContext, id: string, ip?: string) {
    const temporaryPassword = generateTemporaryPassword();
    const hash = await hashPassword(temporaryPassword);
    await withTenant(this.db, actor.tenantId, async (tx) => {
      const target = await this.lockTarget(tx, actor, id);
      if (target.id === actor.userId) throw new ForbiddenError("Use the change-password option for your own account", "SELF_ACTION");
      await tx.query(
        `UPDATE users SET password_hash = $3, must_change_password = true, password_changed_at = now(),
                          failed_login_count = 0, locked_until = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, id, hash],
      );
      await this.auth.revokeUserSessions(tx, actor.tenantId, id, "password_reset");
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "user.password_reset", entityType: "user", entityId: id, ip });
    });
    return { temporaryPassword };
  }

  /** Finds the target inside the caller's tenant (another tenant's id is simply "not found") and checks the actor may manage it. */
  private async lockTarget(tx: Tx, actor: AuthContext, id: string): Promise<{ id: string; role: Role }> {
    const { rows } = await tx.query<{ id: string; role: Role }>(
      "SELECT id, role FROM users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
      [actor.tenantId, id],
    );
    const target = rows[0];
    if (!target) throw new NotFoundError("User not found");
    if (target.id !== actor.userId && !canManageRole(actor.role, target.role)) {
      throw new ForbiddenError("You cannot manage a user with that role", "ROLE_NOT_ALLOWED");
    }
    return target;
  }

  private async assertAnotherOwner(tx: Tx, tenantId: string, excludingUserId: string) {
    const { rows } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'OWNER' AND deleted_at IS NULL AND id <> $2",
      [tenantId, excludingUserId],
    );
    if (rows[0]!.n < 1) throw new UnprocessableError("A workspace must always have at least one owner", "LAST_OWNER");
  }
}
