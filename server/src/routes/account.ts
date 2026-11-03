import { Router } from "express";
import { z } from "zod";
import { verifyPassword } from "../auth/password.js";
import type { AuthService } from "../auth/service.js";
import { writeAudit } from "../audit.js";
import { withTenant, type Db } from "../db/pool.js";
import { ForbiddenError, UnauthenticatedError, UnprocessableError } from "../errors.js";
import { csvRow } from "../http/security.js";
import { cursorTs, limitSchema } from "../http/pagination.js";
import { ValidationError } from "../errors.js";
import { rateLimit } from "../http/rateLimit.js";
import { parse } from "../http/validate.js";
import { authOf, type AuthMiddleware } from "../middleware/auth.js";

const auditQuery = z.object({ limit: limitSchema, cursor: z.string().max(500).optional(), action: z.string().trim().max(100).optional() });
const confirmSchema = z.object({ password: z.string().min(1).max(128) }).strict();
const tenantConfirmSchema = confirmSchema.extend({ confirmName: z.string().trim().min(1).max(100) }).strict();
// audit_log ids are bigints, so this cursor differs from the uuid-based one used elsewhere.
const auditCursor = z.object({ t: z.string().datetime({ offset: true }), id: z.string().regex(/^[0-9]{1,19}$/) });
const decodeAuditCursor = (raw?: string) => {
  if (!raw) return undefined;
  try { return auditCursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))); } catch { throw new ValidationError("Invalid cursor", undefined, "INVALID_CURSOR"); }
};
const encodeAuditCursor = (c: { t: string; id: string }) => Buffer.from(JSON.stringify(c)).toString("base64url");
const EXPORTS = ["leads", "clients", "invoices"] as const;

export function createAccountRouter(deps: { db: Db; auth: AuthMiddleware; authService: AuthService; now?: () => number }) {
  const { db, auth, authService } = deps;
  const r = Router();
  // Auth is applied per route (not r.use): this router is mounted on /api, and a blanket guard would turn unknown paths into 401s.
  const authed = auth.requireAuth();

  // ---- audit log (admins and owners) ----
  r.get("/audit", authed, auth.requirePermission("audit:read"), async (req, res) => {
    const q = parse(auditQuery, req.query, "Query");
    const a = authOf(req);
    const cursor = decodeAuditCursor(q.cursor);
    res.json(await withTenant(db, a.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; actor_id: string | null; actor_name: string | null; action: string; entity_type: string | null; entity_id: string | null; metadata: unknown; at: Date; cursor_t: string }>(
        `SELECT l.id::text AS id, l.actor_id, u.name AS actor_name, l.action, l.entity_type, l.entity_id, l.metadata, l.at, ${cursorTs("l.at")} AS cursor_t
           FROM audit_log l LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.actor_id
          WHERE l.tenant_id = $1 AND ($2::timestamptz IS NULL OR (l.at, l.id) < ($2::timestamptz, $3::bigint)) AND ($4::text IS NULL OR l.action LIKE $4 || '%')
          ORDER BY l.at DESC, l.id DESC LIMIT $5`,
        [a.tenantId, cursor?.t ?? null, cursor?.id ?? null, q.action ?? null, q.limit + 1],
      );
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map((x) => ({ id: x.id, actorId: x.actor_id, actorName: x.actor_name, action: x.action, entityType: x.entity_type, entityId: x.entity_id, metadata: x.metadata, at: x.at.toISOString() })),
        nextCursor: rows.length > q.limit && last ? encodeAuditCursor({ t: last.cursor_t, id: last.id }) : null,
      };
    }));
  });

  // ---- data export (CSV, formula-safe) ----
  const exportLimit = rateLimit({ name: "export", limit: 10, windowMs: 60 * 60_000, key: (req) => authOf(req).userId, now: deps.now });
  r.get("/export/:entity.csv", authed, auth.requirePermission("data:export"), exportLimit, async (req, res) => {
    const entity = EXPORTS.find((e) => e === req.params.entity);
    if (!entity) throw new UnprocessableError("Unknown export", "UNKNOWN_EXPORT");
    const a = authOf(req);
    const SQL = {
      leads: { head: ["name", "company", "email", "phone", "website", "status", "source", "created_at"], q: "SELECT name, company_name, email, phone, website, status, source_adapter, created_at FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 50000" },
      clients: { head: ["name", "company", "email", "phone", "tax_id", "created_at"], q: "SELECT name, company_name, email, phone, tax_id, created_at FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 50000" },
      invoices: { head: ["number", "status", "client", "currency", "total", "issued_at", "due_at", "paid_at"], q: "SELECT number, status, snapshot->'client'->>'name' AS client, currency, total_minor::numeric / 100 AS total, issued_at, due_at, paid_at FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 50000" },
    }[entity];
    const rows = await withTenant(db, a.tenantId, async (tx) => {
      const out = await tx.query<Record<string, unknown>>({ text: SQL.q, values: [a.tenantId], rowMode: "array" } as never);
      await writeAudit(tx, { tenantId: a.tenantId, actorId: a.userId, action: "data.exported", entityType: entity, metadata: { rows: out.rows.length }, ip: req.ip });
      return out.rows as unknown as unknown[][];
    });
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${entity}.csv"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.send(`﻿${[csvRow(SQL.head), ...rows.map(csvRow)].join("\r\n")}\r\n`);
  });

  // ---- account deletion ----
  const deleteLimit = rateLimit({ name: "account-delete", limit: 5, windowMs: 60 * 60_000, key: (req) => authOf(req).userId, now: deps.now });

  async function confirmPassword(tenantId: string, userId: string, password: string) {
    const ok = await withTenant(db, tenantId, async (tx) => {
      const { rows } = await tx.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL", [tenantId, userId]);
      return rows[0] ? verifyPassword(rows[0].password_hash, password) : false;
    });
    if (!ok) throw new ForbiddenError("Password is incorrect", "WRONG_PASSWORD");
  }

  // Delete MY account. Leads I own become unowned so teammates can work them. The last owner must delete the workspace instead.
  r.delete("/me", authed, deleteLimit, async (req, res) => {
    const a = authOf(req);
    const { password } = parse(confirmSchema, req.body);
    await confirmPassword(a.tenantId, a.userId, password);
    await withTenant(db, a.tenantId, async (tx) => {
      const { rows } = await tx.query<{ role: string }>("SELECT role FROM users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE", [a.tenantId, a.userId]);
      if (!rows[0]) throw new UnauthenticatedError("Account not found");
      if (rows[0].role === "OWNER") {
        const o = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'OWNER' AND deleted_at IS NULL AND id <> $2", [a.tenantId, a.userId]);
        if (o.rows[0]!.n < 1) throw new UnprocessableError("You are the only owner. Delete the workspace instead, or make someone else an owner first.", "LAST_OWNER");
      }
      await tx.query("UPDATE leads SET owner_id = NULL WHERE tenant_id = $1 AND owner_id = $2", [a.tenantId, a.userId]);
      await tx.query("UPDATE users SET deleted_at = now() WHERE tenant_id = $1 AND id = $2", [a.tenantId, a.userId]);
      await authService.revokeUserSessions(tx, a.tenantId, a.userId, "account_deleted");
      await writeAudit(tx, { tenantId: a.tenantId, actorId: a.userId, action: "user.self_deleted", entityType: "user", entityId: a.userId, ip: req.ip });
    });
    res.status(204).end();
  });

  // Delete the WORKSPACE (owner only). Soft delete: everything becomes invisible and un-authenticatable at once.
  r.delete("/tenant", authed, auth.requirePermission("tenant:delete"), deleteLimit, async (req, res) => {
    const a = authOf(req);
    const { password, confirmName } = parse(tenantConfirmSchema, req.body);
    await confirmPassword(a.tenantId, a.userId, password);
    await withTenant(db, a.tenantId, async (tx) => {
      const t = await tx.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [a.tenantId]);
      if (!t.rows[0]) throw new ForbiddenError("Workspace not found");
      if (t.rows[0].name !== confirmName) throw new UnprocessableError("Type the workspace name exactly to confirm", "CONFIRM_NAME_MISMATCH");
      await tx.query("UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'tenant_deleted' WHERE tenant_id = $1 AND revoked_at IS NULL", [a.tenantId]);
      await tx.query("UPDATE users SET deleted_at = now() WHERE tenant_id = $1 AND deleted_at IS NULL", [a.tenantId]);
      await tx.query("UPDATE tenants SET deleted_at = now() WHERE id = $1", [a.tenantId]);
      await writeAudit(tx, { tenantId: a.tenantId, actorId: a.userId, action: "tenant.deleted", entityType: "tenant", entityId: a.tenantId, ip: req.ip });
    });
    res.status(204).end();
  });

  return r;
}
