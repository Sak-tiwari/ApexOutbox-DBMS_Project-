import type { Log, OutboxStore } from "./ports";

export const MAX_ATTEMPTS = 5;
const STALE_AFTER_MS = 60_000;

export interface DispatchDeps {
  store: OutboxStore;
  /** Publishes the invoice job to the queue. Must be idempotent (BullMQ jobId makes it so). */
  publishInvoiceJob: (invoiceId: string) => Promise<unknown>;
  log: Log;
  now?: () => Date;
  maxAttempts?: number;
  publishTimeoutMs?: number;
}

export type DispatchOutcome = "idle" | "published" | "retry" | "failed";

export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 5_000, 15 * 60_000);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One dispatcher step. The original loop awaited the queue with no deadline: when Redis was down
 * the call could wait forever and the loop stopped moving. Every publish now has a deadline, and a
 * failure puts the event back to PENDING with exponential backoff (or FAILED after the last try).
 */
export async function dispatchOnce(deps: DispatchDeps): Promise<DispatchOutcome> {
  const { store, publishInvoiceJob, log } = deps;
  const now = deps.now ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  const timeoutMs = deps.publishTimeoutMs ?? 5_000;

  await store.recoverStale(new Date(now().getTime() - STALE_AFTER_MS), maxAttempts);
  await store.failExhausted(maxAttempts);

  const event = await store.claimNext(now(), maxAttempts);
  if (!event) return "idle";

  try {
    if (event.eventType !== "INVOICE_CREATED" || !event.payload.invoiceId) {
      throw new Error(`Unsupported event: ${event.eventType}`);
    }
    await withTimeout(publishInvoiceJob(event.payload.invoiceId), timeoutMs, "queue publish");
    await store.markPublished(event.id);
    log.info({ eventId: event.eventId }, "outbox event published");
    return "published";
  } catch (error) {
    const final = event.attempts >= maxAttempts;
    await store.markRetry(event.id, String(error), new Date(now().getTime() + backoffMs(event.attempts)), final);
    if (final) {
      log.error({ eventId: event.eventId, attempts: event.attempts, error: String(error) }, "ALERT outbox event permanently failed");
    } else {
      log.warn({ eventId: event.eventId, attempts: event.attempts, error: String(error) }, "outbox publish failed; will retry");
    }
    return final ? "failed" : "retry";
  }
}
