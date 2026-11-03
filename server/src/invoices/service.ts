import { writeAudit } from "../audit.js";
import { withTenant, type Db, type Tx } from "../db/pool.js";
import { ConflictError, NotFoundError, UnprocessableError } from "../errors.js";
import { cursorTs, decodeCursor, encodeCursor } from "../http/pagination.js";
import type { AuthContext } from "../middleware/auth.js";
import { priceInvoice, type LineInput } from "./money.js";
import { renderInvoicePdf, type InvoiceSnapshot } from "./pdf.js";
import type { InvoiceStorage } from "./storage.js";

export type InvoiceStatus = "DRAFT" | "ISSUED" | "SENT" | "PAID" | "VOID";

export interface TenantInvoiceSettings {
  prefix: string;
  currency: string;
  defaultTaxRateBp: number;
}

export interface IssueParams {
  tenantId: string;
  tenantName: string;
  settings: TenantInvoiceSettings;
  clientId: string;
  client: InvoiceSnapshot["client"];
  leadId: string | null;
  idempotencyKey: string;
  items: { description: string; quantity: number; unitAmountMinor: number; taxRateBp?: number }[];
  currency?: string;
  dueInDays: number;
  /** When set, an INVOICE e-mail is queued in the same transaction. */
  sendTo?: string;
  actorId: string | null;
}

export const invoiceNumber = (prefix: string, n: number) => `${prefix}-${String(n).padStart(5, "0")}`;

/**
 * Issues an invoice inside the caller's transaction: takes the next gapless number, stores the invoice with an
 * immutable snapshot, and queues the e-mail. If anything later in the transaction fails, the number is rolled back with it.
 * Idempotent per `idempotencyKey`: a repeat returns the invoice that already exists and queues nothing new.
 */
export async function issueInvoice(tx: Tx, p: IssueParams): Promise<{ id: string; number: string; totalMinor: number; created: boolean }> {
  const existing = await tx.query<{ id: string; number: string; total_minor: number }>(
    "SELECT id, number, total_minor FROM invoices WHERE tenant_id = $1 AND idempotency_key = $2",
    [p.tenantId, p.idempotencyKey],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, number: existing.rows[0].number, totalMinor: existing.rows[0].total_minor, created: false };

  const currency = p.currency ?? p.settings.currency;
  const lines: LineInput[] = p.items.map((i) => ({ ...i, taxRateBp: i.taxRateBp ?? p.settings.defaultTaxRateBp }));
  let priced: ReturnType<typeof priceInvoice>;
  try {
    priced = priceInvoice(lines);
  } catch (err) {
    if (err instanceof RangeError) throw new UnprocessableError("This invoice total is too large", "INVOICE_TOO_LARGE");
    throw err;
  }

  // Row-locked until commit, so two concurrent issues serialise and numbers stay gapless.
  const counter = await tx.query<{ last_number: number }>(
    `INSERT INTO invoice_counters (tenant_id, last_number) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_number = invoice_counters.last_number + 1 RETURNING last_number`,
    [p.tenantId],
  );
  const number = invoiceNumber(p.settings.prefix, counter.rows[0]!.last_number);
  const issuedAt = new Date();
  const dueAt = new Date(issuedAt.getTime() + p.dueInDays * 86_400_000);
  const snapshot: InvoiceSnapshot = {
    number, issuedAt: issuedAt.toISOString(), dueAt: dueAt.toISOString(), currency,
    seller: { name: p.tenantName }, client: p.client,
    items: priced.lines, subtotalMinor: priced.subtotalMinor, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor,
  };

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, client_id, lead_id, idempotency_key, number, status, currency, subtotal_minor, tax_minor, total_minor, snapshot, issued_at, due_at)
     VALUES ($1, $2, $3, $4, $5, 'ISSUED', $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [p.tenantId, p.clientId, p.leadId, p.idempotencyKey, number, currency, priced.subtotalMinor, priced.taxMinor, priced.totalMinor, JSON.stringify(snapshot), issuedAt, dueAt],
  );
  const id = inserted.rows[0]!.id;
  for (const [position, line] of priced.lines.entries()) {
    await tx.query(
      "INSERT INTO invoice_items (tenant_id, invoice_id, position, description, quantity, unit_amount_minor, tax_rate_bp) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [p.tenantId, id, position, line.description, line.quantity, line.unitAmountMinor, line.taxRateBp],
    );
  }
  if (p.sendTo) await queueInvoiceEmail(tx, { tenantId: p.tenantId, invoiceId: id, to: p.sendTo, number, clientName: p.client.name, totalMinor: priced.totalMinor, currency, dueAt, sellerName: p.tenantName, idempotencyKey: `invoice-email:${id}:1` });
  await writeAudit(tx, { tenantId: p.tenantId, actorId: p.actorId, action: "invoice.issued", entityType: "invoice", entityId: id, metadata: { number, totalMinor: priced.totalMinor } });
  return { id, number, totalMinor: priced.totalMinor, created: true };
}

const noCrlf = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export async function queueInvoiceEmail(
  tx: Tx,
  p: { tenantId: string; invoiceId: string; to: string; number: string; clientName: string; totalMinor: number; currency: string; dueAt: Date | null; sellerName: string; idempotencyKey: string },
) {
  const { formatMoney } = await import("./money.js");
  const subject = noCrlf(`Invoice ${p.number} from ${p.sellerName}`).slice(0, 300);
  const body =
    `Hi ${noCrlf(p.clientName)},\n\nThank you for your business. Invoice ${p.number} for ${formatMoney(p.totalMinor, p.currency)} is attached.` +
    (p.dueAt ? `\nPayment is due by ${p.dueAt.toISOString().slice(0, 10)}.` : "") +
    `\n\nRegards,\n${noCrlf(p.sellerName)}\n`;
  const res = await tx.query<{ id: string }>(
    `INSERT INTO email_outbox (tenant_id, idempotency_key, kind, invoice_id, to_email, subject, body_text)
     VALUES ($1, $2, 'INVOICE', $3, lower($4), $5, $6) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [p.tenantId, p.idempotencyKey, p.invoiceId, p.to, subject, body],
  );
  return res.rows[0]?.id ?? null;
}

// -------------------------------------------------------------------------------------------------

export interface InvoiceView {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  clientId: string;
  clientName: string;
  leadId: string | null;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  overdue: boolean;
  createdAt: string;
}
interface Row {
  id: string; number: string | null; status: InvoiceStatus; client_id: string; lead_id: string | null; currency: string;
  subtotal_minor: number; tax_minor: number; total_minor: number; issued_at: Date | null; due_at: Date | null; paid_at: Date | null;
  created_at: Date; client_name: string; snapshot: InvoiceSnapshot; pdf_storage_key: string | null; pdf_sha256: string | null; cursor_t?: string;
}
const COLUMNS = `i.id, i.number, i.status, i.client_id, i.lead_id, i.currency, i.subtotal_minor, i.tax_minor, i.total_minor,
  i.issued_at, i.due_at, i.paid_at, i.created_at, i.snapshot->'client'->>'name' AS client_name, i.snapshot, i.pdf_storage_key, i.pdf_sha256`;

const view = (r: Row): InvoiceView => ({
  id: r.id, number: r.number, status: r.status, clientId: r.client_id, clientName: r.client_name, leadId: r.lead_id, currency: r.currency,
  subtotalMinor: r.subtotal_minor, taxMinor: r.tax_minor, totalMinor: r.total_minor,
  issuedAt: r.issued_at?.toISOString() ?? null, dueAt: r.due_at?.toISOString() ?? null, paidAt: r.paid_at?.toISOString() ?? null,
  overdue: (r.status === "ISSUED" || r.status === "SENT") && !!r.due_at && r.due_at.getTime() < Date.now(),
  createdAt: r.created_at.toISOString(),
});

export class InvoicesService {
  constructor(private readonly db: Db, private readonly storage: InvoiceStorage) {}

  async list(actor: AuthContext, f: { limit: number; cursor?: string; status?: InvoiceStatus[]; clientId?: string; q?: string; overdue?: boolean }) {
    const cursor = decodeCursor(f.cursor);
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLUMNS}, ${cursorTs("i.created_at")} AS cursor_t FROM invoices i
          WHERE i.tenant_id = $1 AND i.deleted_at IS NULL
            AND ($2::timestamptz IS NULL OR (i.created_at, i.id) < ($2::timestamptz, $3::uuid))
            AND ($4::text[] IS NULL OR i.status = ANY($4))
            AND ($5::uuid IS NULL OR i.client_id = $5)
            AND ($6::text IS NULL OR lower(coalesce(i.number, '') || ' ' || coalesce(i.snapshot->'client'->>'name', '') || ' ' || coalesce(i.snapshot->'client'->>'company', '')) LIKE $6 ESCAPE '\\')
            AND ($7::boolean IS NOT TRUE OR (i.status IN ('ISSUED', 'SENT') AND i.due_at < now()))
          ORDER BY i.created_at DESC, i.id DESC LIMIT $8`,
        [actor.tenantId, cursor?.t ?? null, cursor?.id ?? null, f.status?.length ? f.status : null, f.clientId ?? null,
         f.q ? `%${f.q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null, f.overdue ?? null, f.limit + 1],
      );
      const page = rows.slice(0, f.limit);
      const last = page[page.length - 1];
      return { items: page.map(view), nextCursor: rows.length > f.limit && last ? encodeCursor({ t: last.cursor_t!, id: last.id }) : null };
    });
  }

  async get(actor: AuthContext, id: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const row = await this.find(tx, actor.tenantId, id);
      const emails = await tx.query<{ id: string; status: string; to_email: string; attempts: number; last_error: string | null; sent_at: Date | null; created_at: Date }>(
        "SELECT id, status, to_email, attempts, last_error, sent_at, created_at FROM email_outbox WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY created_at DESC",
        [actor.tenantId, id],
      );
      return {
        invoice: view(row),
        items: row.snapshot.items,
        client: row.snapshot.client,
        emails: emails.rows.map((e) => ({ id: e.id, status: e.status, to: e.to_email, attempts: e.attempts, lastError: e.last_error, sentAt: e.sent_at?.toISOString() ?? null, createdAt: e.created_at.toISOString() })),
      };
    });
  }

  /** Returns the PDF bytes, (re)creating the file from the immutable snapshot when it is missing or fails its hash check. */
  async pdf(actor: AuthContext, id: string): Promise<{ bytes: Buffer; filename: string }> {
    return this.ensurePdf(actor.tenantId, id);
  }

  async ensurePdf(tenantId: string, id: string): Promise<{ bytes: Buffer; filename: string }> {
    const row = await withTenant(this.db, tenantId, (tx) => this.find(tx, tenantId, id));
    const filename = `${(row.number ?? row.id).replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`;
    if (row.pdf_storage_key) {
      const cached = await this.storage.read(row.pdf_storage_key, row.pdf_sha256);
      if (cached) return { bytes: cached, filename };
    }
    const bytes = await renderInvoicePdf(row.snapshot);
    const key = this.storage.keyFor(tenantId, id);
    const sha = await this.storage.save(key, bytes);
    await withTenant(this.db, tenantId, (tx) =>
      tx.query("UPDATE invoices SET pdf_storage_key = $3, pdf_sha256 = $4, pdf_generated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id, key, sha]),
    );
    return { bytes, filename };
  }

  async markPaid(actor: AuthContext, id: string, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "UPDATE invoices SET status = 'PAID', paid_at = now() WHERE tenant_id = $1 AND id = $2 AND status IN ('ISSUED', 'SENT') AND deleted_at IS NULL RETURNING id",
        [actor.tenantId, id],
      );
      if (!rows[0]) throw await this.cannot(tx, actor.tenantId, id, "Only issued or sent invoices can be marked paid");
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "invoice.paid", entityType: "invoice", entityId: id, ip });
      return view(await this.find(tx, actor.tenantId, id));
    });
  }

  async void(actor: AuthContext, id: string, reason: string, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "UPDATE invoices SET status = 'VOID' WHERE tenant_id = $1 AND id = $2 AND status IN ('ISSUED', 'SENT') AND deleted_at IS NULL RETURNING id",
        [actor.tenantId, id],
      );
      if (!rows[0]) throw await this.cannot(tx, actor.tenantId, id, "Only issued or sent invoices can be voided");
      // A voided invoice must not be e-mailed any more.
      await tx.query("UPDATE email_outbox SET status = 'ABANDONED', last_error = 'Invoice was voided' WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'PENDING'", [actor.tenantId, id]);
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "invoice.voided", entityType: "invoice", entityId: id, metadata: { reason }, ip });
      return view(await this.find(tx, actor.tenantId, id));
    });
  }

  /** Queues another copy of the invoice e-mail (e.g. wrong address fixed). Each resend is its own outbox row. */
  async resend(actor: AuthContext, id: string, to: string | undefined, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const row = await this.find(tx, actor.tenantId, id);
      if (row.status === "VOID") throw new UnprocessableError("A voided invoice cannot be sent", "INVOICE_VOID");
      const open = await tx.query("SELECT 1 FROM email_outbox WHERE tenant_id = $1 AND invoice_id = $2 AND status IN ('PENDING', 'SENDING', 'UNCERTAIN')", [actor.tenantId, id]);
      if (open.rows[0]) throw new ConflictError("An e-mail for this invoice is already waiting or needs checking", "EMAIL_IN_PROGRESS");
      const count = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM email_outbox WHERE tenant_id = $1 AND invoice_id = $2", [actor.tenantId, id])).rows[0]!.n;
      const tenant = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [actor.tenantId])).rows[0]!;
      const emailId = await queueInvoiceEmail(tx, {
        tenantId: actor.tenantId, invoiceId: id, to: to ?? row.snapshot.client.email, number: row.number!, clientName: row.snapshot.client.name,
        totalMinor: row.total_minor, currency: row.currency, dueAt: row.due_at, sellerName: tenant.name, idempotencyKey: `invoice-email:${id}:${count + 1}`,
      });
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "invoice.resend_queued", entityType: "invoice", entityId: id, ip });
      return { emailId };
    });
  }

  async stats(actor: AuthContext) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const byStatus = await tx.query<{ status: InvoiceStatus; n: number; total: string }>(
        "SELECT status, count(*)::int AS n, coalesce(sum(total_minor), 0)::text AS total FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY status",
        [actor.tenantId],
      );
      const overdue = await tx.query<{ n: number; total: string }>(
        "SELECT count(*)::int AS n, coalesce(sum(total_minor), 0)::text AS total FROM invoices WHERE tenant_id = $1 AND deleted_at IS NULL AND status IN ('ISSUED','SENT') AND due_at < now()",
        [actor.tenantId],
      );
      const monthly = await tx.query<{ month: string; billed: string; paid: string }>(
        `SELECT to_char(m, 'YYYY-MM') AS month,
                coalesce(sum(i.total_minor) FILTER (WHERE i.status <> 'VOID'), 0)::text AS billed,
                coalesce(sum(i.total_minor) FILTER (WHERE i.status = 'PAID'), 0)::text AS paid
           FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m
           LEFT JOIN invoices i ON i.tenant_id = $1 AND i.deleted_at IS NULL AND date_trunc('month', i.issued_at) = m
          GROUP BY m ORDER BY m`,
        [actor.tenantId],
      );
      const status: Record<string, { count: number; totalMinor: number }> = {};
      for (const r of byStatus.rows) status[r.status] = { count: r.n, totalMinor: Number(r.total) };
      const outstanding = (status.ISSUED?.totalMinor ?? 0) + (status.SENT?.totalMinor ?? 0);
      return {
        byStatus: status,
        outstandingMinor: outstanding,
        paidMinor: status.PAID?.totalMinor ?? 0,
        overdue: { count: overdue.rows[0]!.n, totalMinor: Number(overdue.rows[0]!.total) },
        monthly: monthly.rows.map((r) => ({ month: r.month, billedMinor: Number(r.billed), paidMinor: Number(r.paid) })),
      };
    });
  }

  private async find(tx: Tx, tenantId: string, id: string): Promise<Row> {
    const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM invoices i WHERE i.tenant_id = $1 AND i.id = $2 AND i.deleted_at IS NULL`, [tenantId, id]);
    if (!rows[0]) throw new NotFoundError("Invoice not found");
    return rows[0];
  }

  private async cannot(tx: Tx, tenantId: string, id: string, message: string) {
    const row = await tx.query<{ status: string }>("SELECT status FROM invoices WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL", [tenantId, id]);
    return row.rows[0] ? new ConflictError(`${message} (this one is ${row.rows[0].status})`, "INVALID_INVOICE_STATE") : new NotFoundError("Invoice not found");
  }
}
