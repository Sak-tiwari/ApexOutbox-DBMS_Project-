import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { permissionsFor } from "../auth/rbac.js";
import { withTenant, type Db } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { parse } from "../http/validate.js";
import { authOf, type AuthMiddleware } from "../middleware/auth.js";

/** Tenant settings the UI and the server both read. Strict: unknown keys are rejected, not stored. */
export const settingsPatchSchema = z
  .object({
    features: z.object({ scraper: z.boolean(), invoices: z.boolean(), email: z.boolean() }).partial().strict().optional(),
    invoice: z
      .object({
        prefix: z.string().regex(/^[A-Z0-9-]{1,10}$/, "1-10 upper-case letters, digits or dashes"),
        currency: z.string().regex(/^[A-Z]{3}$/, "3-letter currency code"),
        defaultTaxRateBp: z.number().int().min(0).max(10_000),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

const tenantPatchSchema = z.object({ name: z.string().trim().min(2).max(100) });

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, Record<string, unknown>>;
}

const tenantView = (t: TenantRow) => ({ id: t.id, name: t.name, slug: t.slug, settings: t.settings });

export function createMeRouter(deps: { db: Db; auth: AuthMiddleware }) {
  const { db, auth } = deps;
  const router = Router();

  // Everything the SPA needs to render a role-aware UI: who you are, your permissions, tenant settings.
  // Allowed even while a password change is pending, so the UI can show the "choose a new password" screen.
  router.get("/me", auth.requireAuth({ allowPendingPasswordChange: true }), async (req, res) => {
    const a = authOf(req);
    const result = await withTenant(db, a.tenantId, async (tx) => {
      const { rows } = await tx.query<TenantRow>("SELECT id, name, slug, settings FROM tenants WHERE id = $1 AND deleted_at IS NULL", [a.tenantId]);
      const t = rows[0];
      if (!t) throw new NotFoundError("Workspace not found");
      const u = await tx.query<{ totp_enabled: boolean }>("SELECT totp_enabled FROM users WHERE tenant_id = $1 AND id = $2", [a.tenantId, a.userId]);
      return { tenant: tenantView(t), totpEnabled: u.rows[0]?.totp_enabled ?? false };
    });
    res.json({
      user: { id: a.userId, name: a.name, email: a.email, role: a.role, totpEnabled: result.totpEnabled, mustChangePassword: a.mustChangePassword },
      tenant: result.tenant,
      permissions: permissionsFor(a.role),
    });
  });

  router.patch("/tenant", auth.requireAuth(), auth.requirePermission("tenant:settings"), async (req, res) => {
    const a = authOf(req);
    const { name } = parse(tenantPatchSchema, req.body);
    const tenant = await withTenant(db, a.tenantId, async (tx) => {
      const { rows } = await tx.query<TenantRow>("UPDATE tenants SET name = $2 WHERE id = $1 RETURNING id, name, slug, settings", [a.tenantId, name]);
      await writeAudit(tx, { tenantId: a.tenantId, actorId: a.userId, action: "tenant.renamed", entityType: "tenant", entityId: a.tenantId, ip: req.ip });
      return rows[0]!;
    });
    res.json(tenantView(tenant));
  });

  router.patch("/tenant/settings", auth.requireAuth(), auth.requirePermission("tenant:settings"), async (req, res) => {
    const a = authOf(req);
    const patch = parse(settingsPatchSchema, req.body, "Settings");
    const tenant = await withTenant(db, a.tenantId, async (tx) => {
      const { rows } = await tx.query<TenantRow>("SELECT id, name, slug, settings FROM tenants WHERE id = $1 FOR UPDATE", [a.tenantId]);
      const current = rows[0]!;
      const merged = {
        ...current.settings,
        features: { ...current.settings.features, ...patch.features },
        invoice: { ...current.settings.invoice, ...patch.invoice },
      };
      const updated = await tx.query<TenantRow>("UPDATE tenants SET settings = $2 WHERE id = $1 RETURNING id, name, slug, settings", [a.tenantId, JSON.stringify(merged)]);
      await writeAudit(tx, { tenantId: a.tenantId, actorId: a.userId, action: "tenant.settings_changed", entityType: "tenant", entityId: a.tenantId, metadata: { keys: Object.keys(patch) }, ip: req.ip });
      return updated.rows[0]!;
    });
    res.json(tenantView(tenant));
  });

  return router;
}
