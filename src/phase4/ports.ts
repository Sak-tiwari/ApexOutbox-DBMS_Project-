/** Minimal logger shape (pino satisfies it). */
export interface Log {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  snapshot: { clientName: string; email: string; company: string; amount: number; currency: string; description: string; createdAt: Date };
  pdfPath: string;
  status: "PENDING" | "PDF_READY" | "EMAIL_SENDING" | "EMAIL_SENT" | "EMAIL_FAILED" | "EMAIL_UNCERTAIN" | "EMAIL_ABANDONED";
  emailAttempts: number;
  emailMessageId: string;
  lastError: string;
  updatedAt: Date;
}

/**
 * Persistence port for invoice processing. `claimForSending` MUST be atomic
 * (PDF_READY | EMAIL_FAILED -> EMAIL_SENDING, attempts + 1): it is what guarantees an invoice email
 * is attempted by at most one worker at a time.
 */
export interface InvoiceStore {
  findById(id: string): Promise<InvoiceRecord | null>;
  /** MUST be one atomic write: records the path and moves PENDING -> PDF_READY together. */
  setPdf(id: string, pdfPath: string): Promise<void>;
  claimForSending(id: string): Promise<InvoiceRecord | null>;
  markSent(id: string, messageId: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  markUncertain(id: string, error: string): Promise<void>;
  /** Gives up for good (permanent rejection or too many failures). Needs a human; never retried. */
  markAbandoned(id: string, error: string): Promise<void>;
  /** Ids of invoices not yet finished (PENDING / PDF_READY / EMAIL_SENDING / EMAIL_FAILED) that have not changed since `olderThan`. */
  findStuck(olderThan: Date, limit: number): Promise<string[]>;
}

export interface OutboxRecord {
  id: string;
  eventId: string;
  eventType: string;
  payload: { invoiceId?: string };
  attempts: number;
}

/** Persistence port for the outbox dispatcher. `claimNext` MUST be atomic. */
export interface OutboxStore {
  recoverStale(olderThan: Date, maxAttempts: number): Promise<number>;
  failExhausted(maxAttempts: number): Promise<number>;
  claimNext(now: Date, maxAttempts: number): Promise<OutboxRecord | null>;
  markPublished(id: string): Promise<void>;
  /** Puts the event back to PENDING (retry at `nextAttemptAt`) or to FAILED when `final`. */
  markRetry(id: string, error: string, nextAttemptAt: Date, final: boolean): Promise<void>;
}
