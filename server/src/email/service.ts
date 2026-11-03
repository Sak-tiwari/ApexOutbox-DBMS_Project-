import { writeAudit } from "../audit.js";
import { withTenant, type Db } from "../db/pool.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { cursorTs, decodeCursor, encodeCursor } from "../http/pagination.js";
import type { AuthContext } from "../middleware/auth.js";

export const EMAIL_STATUSES = ["PENDING", "SENDING", "SENT", "UNCERTAIN", "FAILED", "ABANDONED"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

interface Row {
  id: string; kind: string; invoice_id: string | null; invoice_number: string | null; to_email: string; subject: string; status: EmailStatus;
  attempts: number; max_attempts: number; next_attempt_at: Date; last_error: string | null; sent_at: Date | null; created_at: Date; cursor_t?: string;
}
const COLUMNS = `e.id, e.kind, e.invoice_id, i.number AS invoice_number, e.to_email, e.subject, e.status, e.attempts, e.max_attempts,
  e.next_attempt_at, e.last_error, e.sent_at, e.created_at`;
const view = (r: Row) => ({
  id: r.id, kind: r.kind, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, to: r.to_email, subject: r.subject, status: r.status,
  attempts: r.attempts, maxAttempts: r.max_attempts, nextAttemptAt: r.next_attempt_at.toISOString(), lastError: r.last_error,
  sentAt: r.sent_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});

export class EmailService {
  constructor(private readonly db: Db) {}

  async list(actor: AuthContext, f: { limit: number; cursor?: string; status?: EmailStatus[] }) {
    const cursor = decodeCursor(f.cursor);
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT ${COLUMNS}, ${cursorTs("e.created_at")} AS cursor_t
           FROM email_outbox e LEFT JOIN invoices i ON i.tenant_id = e.tenant_id AND i.id = e.invoice_id
          WHERE e.tenant_id = $1 AND ($2::timestamptz IS NULL OR (e.created_at, e.id) < ($2::timestamptz, $3::uuid)) AND ($4::text[] IS NULL OR e.status = ANY($4))
          ORDER BY e.created_at DESC, e.id DESC LIMIT $5`,
        [actor.tenantId, cursor?.t ?? null, cursor?.id ?? null, f.status?.length ? f.status : null, f.limit + 1],
      );
      const page = rows.slice(0, f.limit);
      const last = page[page.length - 1];
      return { items: page.map(view), nextCursor: rows.length > f.limit && last ? encodeCursor({ t: last.cursor_t!, id: last.id }) : null };
    });
  }

  async stats(actor: AuthContext) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ status: EmailStatus; n: number }>("SELECT status, count(*)::int AS n FROM email_outbox WHERE tenant_id = $1 GROUP BY status", [actor.tenantId]);
      const byStatus: Record<string, number> = Object.fromEntries(EMAIL_STATUSES.map((s) => [s, 0]));
      for (const r of rows) byStatus[r.status] = r.n;
      return { byStatus, needsAttention: byStatus.UNCERTAIN! + byStatus.FAILED! + byStatus.ABANDONED! };
    });
  }

  /** FAILED / ABANDONED -> try again (3 more attempts). Safe: these states mean the mail definitely did not go out. */
  async retry(actor: AuthContext, id: string, ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE email_outbox SET status = 'PENDING', next_attempt_at = now(), max_attempts = GREATEST(max_attempts, attempts + 3), last_error = NULL
          WHERE tenant_id = $1 AND id = $2 AND status IN ('FAILED', 'ABANDONED') RETURNING id`,
        [actor.tenantId, id],
      );
      if (!rows[0]) throw await this.cannot(tx, actor.tenantId, id, "Only failed or abandoned e-mails can be retried. Use 'resolve' for e-mails with unknown status");
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "email.retry", entityType: "email", entityId: id, ip });
    });
  }

  /**
   * A human checked with the provider/recipient what happened to an UNCERTAIN e-mail.
   * "delivered" closes it as SENT; "not_delivered" re-queues it. The choice is audited.
   */
  async resolve(actor: AuthContext, id: string, outcome: "delivered" | "not_delivered", ip?: string) {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const sql =
        outcome === "delivered"
          ? "UPDATE email_outbox SET status = 'SENT', sent_at = now(), last_error = 'Confirmed delivered by a person' WHERE tenant_id = $1 AND id = $2 AND status = 'UNCERTAIN' RETURNING id, invoice_id"
          : "UPDATE email_outbox SET status = 'PENDING', next_attempt_at = now(), max_attempts = GREATEST(max_attempts, attempts + 1), last_error = NULL WHERE tenant_id = $1 AND id = $2 AND status = 'UNCERTAIN' RETURNING id, invoice_id";
      const { rows } = await tx.query<{ id: string; invoice_id: string | null }>(sql, [actor.tenantId, id]);
      if (!rows[0]) throw await this.cannot(tx, actor.tenantId, id, "Only e-mails with unknown delivery status can be resolved");
      if (outcome === "delivered" && rows[0].invoice_id) {
        await tx.query("UPDATE invoices SET status = 'SENT' WHERE tenant_id = $1 AND id = $2 AND status = 'ISSUED'", [actor.tenantId, rows[0].invoice_id]);
      }
      await writeAudit(tx, { tenantId: actor.tenantId, actorId: actor.userId, action: "email.resolved", entityType: "email", entityId: id, metadata: { outcome }, ip });
    });
  }

  private async cannot(tx: import("../db/pool.js").Tx, tenantId: string, id: string, message: string) {
    const r = await tx.query<{ status: string }>("SELECT status FROM email_outbox WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return r.rows[0] ? new ConflictError(`${message} (this one is ${r.rows[0].status})`, "INVALID_EMAIL_STATE") : new NotFoundError("E-mail not found");
  }
}
