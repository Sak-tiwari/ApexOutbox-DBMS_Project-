import { writeAudit } from "../audit.js";
import { withTenant, type Db } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { cursorTs, decodeCursor, encodeCursor } from "../http/pagination.js";
import { likePattern } from "../leads/service.js";
import type { AuthContext } from "../middleware/auth.js";

interface Row {
  id: string; lead_id: string; name: string; company_name: string | null; email: string; phone: string | null;
  billing_address: Record<string, string>; tax_id: string | null; created_at: Date; updated_at: Date;
  invoice_count?: number; billed_minor?: string; cursor_t?: string;
}
const view = (r: Row) => ({
  id: r.id, leadId: r.lead_id, name: r.name, companyName: r.company_name, email: r.email, phone: r.phone,
  billingAddress: r.billing_address, taxId: r.tax_id, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  ...(r.invoice_count !== undefined ? { invoiceCount: r.invoice_count, billedMinor: Number(r.billed_minor ?? 0) } : {}),
});
const BASE = "c.id, c.lead_id, c.name, c.company_name, c.email, c.phone, c.billing_address, c.tax_id, c.created_at, c.updated_at";

export interface ClientPatch {
  name?: string;
  companyName?: string | null;
  email?: string;
  phone?: string | null;
  billingAddress?: Record<string, string>;
  taxId?: string | null;
}

export class ClientsService {
  constructor(private readonly db: Db) {}

  async list(actor: AuthContext, f: { limit: number; cursor?: string; q?: string }) {
    const cursor = decodeCursor(f.cursor);
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${BASE}, ${cursorTs("c.created_at")} AS cursor_t,
                (SELECT count(*)::int FROM invoices i WHERE i.tenant_id = c.tenant_id AND i.client_id = c.id AND i.deleted_at IS NULL) AS invoice_count,
                (SELECT coalesce(sum(total_minor), 0)::text FROM invoices i WHERE i.tenant_id = c.tenant_id AND i.client_id = c.id AND i.deleted_at IS NULL AND i.status <> 'VOID') AS billed_minor
           FROM clients c
          WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
            AND ($2::timestamptz IS NULL OR (c.created_at, c.id) < ($2::timestamptz, $3::uuid))
            AND ($4::text IS NULL OR lower(c.name || ' ' || coalesce(c.company_name, '') || ' ' || c.email) LIKE $4 ESCAPE '\\')
          ORDER BY c.created_at DESC, c.id DESC LIMIT $5`,
        [actor.tenantId, cursor?.t ?? null, cursor?.id ?? null, f.q ? likePattern(f.q) : null, f.limit + 1],
      );
      const page = rows.slice(0, f.limit);
      const last = page[page.length - 1];
      return { items: page.map(view), nextCursor: rows.length > f.limit && last ? encodeCursor({ t: last.cursor_t!, id: last.id }) : null };
    });
  }

  async get(actor: AuthContext, id: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT ${BASE} FROM clients c WHERE c.tenant_id = $1 AND c.id = $2 AND c.deleted_at IS NULL`, [actor.tenantId, id]);
      if (!rows[0]) throw new NotFoundError("Client not found");
      const invoices = await tx.query<{ id: string; number: string; status: string; total_minor: number; currency: string; issued_at: Date; due_at: Date | null }>(
        "SELECT id, number, status, total_minor, currency, issued_at, due_at FROM invoices WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100",
        [actor.tenantId, id],
      );
      return {
        client: view(rows[0]),
        invoices: invoices.rows.map((i) => ({ id: i.id, number: i.number, status: i.status, totalMinor: i.total_minor, currency: i.currency, issuedAt: i.issued_at.toISOString(), dueAt: i.due_at?.toISOString() ?? null })),
      };
    });
  }

  /** Edits the client record. Issued invoices keep the details they were issued with (immutable snapshot). */
  async update(actor: AuthContext, id: string, p: ClientPatch, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const cur = await tx.query<Row>(`SELECT ${BASE} FROM clients c WHERE c.tenant_id = $1 AND c.id = $2 AND c.deleted_at IS NULL FOR UPDATE`, [actor.tenantId, id]);
      const c = cur.rows[0];
      if (!c) throw new NotFoundError("Client not found");
      const { rows } = await tx.query<Row>(
        `UPDATE clients SET name = $3, company_name = $4, email = $5, phone = $6, billing_address = $7, tax_id = $8
          WHERE tenant_id = $1 AND id = $2 RETURNING id, lead_id, name, company_name, email, phone, billing_address, tax_id, created_at, updated_at`,
        [actor.tenantId, id, p.name ?? c.name, p.companyName !== undefined ? p.companyName : c.company_name, p.email ?? c.email,
         p.phone !== undefined ? p.phone : c.phone, JSON.stringify(p.billingAddress ?? c.billing_address), p.taxId !== undefined ? p.taxId : c.tax_id],
      );
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "client.updated", entityType: "client", entityId: id, metadata: { fields: Object.keys(p) }, ip });
      return view(rows[0]!);
    });
  }
}

