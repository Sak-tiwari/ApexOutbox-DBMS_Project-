import { randomUUID } from "node:crypto";
import { setTimeout as sleepMs } from "node:timers/promises";
import { withTenant, type Db } from "../db/pool.js";
import type { InvoicesService } from "../invoices/service.js";
import type { Log } from "../logger.js";
import { EmailPermanentError, EmailUncertainError, type Mailer } from "./mailer.js";

export interface EmailWorkerOptions {
  db: Db;
  log: Log;
  mailer: Mailer;
  invoices: InvoicesService;
  /** Domain used in Message-IDs. */
  messageIdDomain?: string;
  pollMs?: number;
  /** A SENDING row older than this belonged to a dead worker. Must exceed the SMTP timeouts. */
  staleSeconds?: number;
  workerId?: string;
}

interface Row {
  id: string; kind: string; invoice_id: string | null; to_email: string; subject: string; body_text: string;
  attempts: number; max_attempts: number; number: string | null;
}

/** 30 s, 1 min, 2 min, ... capped at 1 hour. */
export const backoffSeconds = (attempt: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));

/**
 * Sends queued e-mails with at-most-once delivery:
 *  - claim = durable (status SENDING, attempt counted) BEFORE the provider is contacted
 *  - provider accepted      -> SENT (and the invoice becomes SENT)
 *  - definitely rejected    -> FAILED (needs a human; retrying cannot help)
 *  - ordinary failure       -> PENDING again with back-off, until max_attempts, then ABANDONED
 *  - outcome unknown / worker died mid-send -> UNCERTAIN, never re-sent automatically
 */
export class EmailWorker {
  private readonly db: Db;
  private readonly log: Log;
  private readonly mailer: Mailer;
  private readonly invoices: InvoicesService;
  private readonly domain: string;
  private readonly pollMs: number;
  private readonly staleSeconds: number;
  private readonly workerId: string;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(o: EmailWorkerOptions) {
    this.db = o.db;
    this.log = o.log;
    this.mailer = o.mailer;
    this.invoices = o.invoices;
    this.domain = (o.messageIdDomain ?? "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
    this.pollMs = o.pollMs ?? 3000;
    this.staleSeconds = o.staleSeconds ?? 300;
    this.workerId = o.workerId ?? `mail-${randomUUID().slice(0, 8)}`;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (err) {
          this.log.error({ err: (err as Error).message }, "email worker loop error");
        }
        if (!worked && this.running) await new Promise<void>((resolve) => { this.wake = resolve; setTimeout(resolve, this.pollMs).unref(); });
      }
    })();
  }
  poke() { this.wake?.(); }
  async stop() {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Sends at most one e-mail. Returns false when nothing was due. */
  async runOnce(): Promise<boolean> {
    const stale = await this.db.query<{ n: number }>("SELECT email_expire_stale($1) AS n", [this.staleSeconds]);
    if (stale.rows[0]!.n > 0) this.log.error({ count: stale.rows[0]!.n }, "ALERT e-mails with unknown delivery status need a human check");

    const { rows } = await this.db.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM email_claim_next($1)", [this.workerId]);
    const claimed = rows[0];
    if (!claimed) return false;
    await this.send(claimed.tenant_id, claimed.id);
    return true;
  }

  private async send(tenantId: string, id: string) {
    const row = await withTenant(this.db, tenantId, async (tx) =>
      (await tx.query<Row>(
        `SELECT e.id, e.kind, e.invoice_id, e.to_email, e.subject, e.body_text, e.attempts, e.max_attempts, i.number
           FROM email_outbox e LEFT JOIN invoices i ON i.tenant_id = e.tenant_id AND i.id = e.invoice_id
          WHERE e.tenant_id = $1 AND e.id = $2`, [tenantId, id])).rows[0],
    );
    if (!row) return;

    try {
      const attachments = row.invoice_id
        ? await this.invoices.ensurePdf(tenantId, row.invoice_id).then((p) => [{ filename: p.filename, content: p.bytes, contentType: "application/pdf" }])
        : undefined;
      const result = await this.mailer.send({ messageId: `<${row.id}@${this.domain}>`, to: row.to_email, subject: row.subject, text: row.body_text, attachments });
      await withTenant(this.db, tenantId, async (tx) => {
        await tx.query(
          "UPDATE email_outbox SET status = 'SENT', sent_at = now(), provider_message_id = $3, last_error = NULL, locked_at = NULL, locked_by = NULL WHERE tenant_id = $1 AND id = $2",
          [tenantId, id, result.providerMessageId],
        );
        if (row.invoice_id) await tx.query("UPDATE invoices SET status = 'SENT' WHERE tenant_id = $1 AND id = $2 AND status = 'ISSUED'", [tenantId, row.invoice_id]);
      });
      this.log.info({ emailId: id, invoice: row.number }, "e-mail sent");
    } catch (err) {
      await this.fail(tenantId, row, err);
    }
  }

  private async fail(tenantId: string, row: Row, err: unknown) {
    const message = String((err as Error)?.message ?? err).replace(/\s+/g, " ").slice(0, 500);
    let status: "FAILED" | "UNCERTAIN" | "PENDING" | "ABANDONED";
    if (err instanceof EmailUncertainError) status = "UNCERTAIN";
    else if (err instanceof EmailPermanentError) status = "FAILED";
    else status = row.attempts >= row.max_attempts ? "ABANDONED" : "PENDING";

    await withTenant(this.db, tenantId, (tx) =>
      tx.query(
        `UPDATE email_outbox SET status = $3, last_error = $4, locked_at = NULL, locked_by = NULL,
                next_attempt_at = CASE WHEN $3 = 'PENDING' THEN now() + make_interval(secs => $5) ELSE next_attempt_at END
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, row.id, status, message, backoffSeconds(row.attempts)],
      ),
    );
    const level = status === "PENDING" ? "warn" : "error";
    this.log[level]({ emailId: row.id, invoice: row.number, status }, status === "PENDING" ? "e-mail failed, will retry" : "ALERT e-mail not delivered");
  }
}
