import type { InvoiceStore, Log } from "./ports";

export interface RequeueDeps {
  store: Pick<InvoiceStore, "findStuck">;
  requeue: (invoiceId: string) => Promise<"created" | "retried" | "already-queued">;
  log: Log;
  now?: () => Date;
  /** An invoice untouched for this long and still unsent is considered stuck. Default 10 minutes. */
  olderThanMs?: number;
  batch?: number;
}

/**
 * Recovery sweep for lost queue state. If Redis loses its data (restart without persistence, failover,
 * flush), invoices whose outbox event was already PUBLISHED would otherwise wait forever.
 * Safe to run repeatedly: the job id is per invoice, live jobs are left alone, and the processor sends
 * the email at most once.
 */
export async function requeueStuckInvoices(deps: RequeueDeps): Promise<{ created: number; retried: number; alreadyQueued: number }> {
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - (deps.olderThanMs ?? 10 * 60_000));
  const ids = await deps.store.findStuck(cutoff, deps.batch ?? 50);
  const tally = { created: 0, retried: 0, alreadyQueued: 0 };
  for (const id of ids) {
    try {
      const result = await deps.requeue(id);
      if (result === "created") tally.created++;
      else if (result === "retried") tally.retried++;
      else tally.alreadyQueued++;
    } catch (error) {
      deps.log.warn({ invoiceId: id, error: String(error) }, "requeue failed; will try again next sweep");
    }
  }
  if (tally.created || tally.retried) deps.log.warn({ ...tally }, "requeued stuck invoices");
  return tally;
}
