import IORedis from "ioredis";
import { Queue } from "bullmq";

export const QUEUE_NAME = "client-onboarding";

export interface QueueClient {
  queue: Queue;
  connection: IORedis;
  enqueueInvoiceJob(invoiceId: string): Promise<unknown>;
  /** Makes sure a job exists for this invoice: creates it if missing, retries it if it failed, leaves live jobs alone. */
  requeueInvoice(invoiceId: string): Promise<"created" | "retried" | "already-queued">;
  close(): Promise<void>;
}

/**
 * Producer-side queue client (API and dispatcher).
 * `enableOfflineQueue: false` makes commands FAIL FAST when Redis is down instead of waiting
 * indefinitely for it to return. The dispatcher turns that failure into a retry with backoff.
 * (Workers use their own connection with maxRetriesPerRequest: null, as BullMQ requires.)
 */
export function createQueueClient(redisUrl: string): QueueClient {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 2_000)
  });
  connection.on("error", () => {
    /* connection errors surface through failed commands; avoid unhandled 'error' events */
  });

  const queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  });
  queue.on("error", () => {});

  return {
    queue,
    connection,
    // jobId makes publishing idempotent: adding the same invoice twice yields ONE job.
    enqueueInvoiceJob: (invoiceId: string) => queue.add("process-invoice", { invoiceId }, { jobId: `invoice-${invoiceId}` }),
    requeueInvoice: async (invoiceId: string) => {
      const job = await queue.getJob(`invoice-${invoiceId}`);
      if (!job) {
        await queue.add("process-invoice", { invoiceId }, { jobId: `invoice-${invoiceId}` });
        return "created";
      }
      if (await job.isFailed()) {
        await job.retry();
        return "retried";
      }
      if (await job.isCompleted()) {
        // The job finished but the invoice is still unsent (e.g. it was skipped as in-progress). A completed
        // job id blocks re-adding, so drop it and add a fresh one.
        await job.remove();
        await queue.add("process-invoice", { invoiceId }, { jobId: `invoice-${invoiceId}` });
        return "created";
      }
      return "already-queued";
    },
    close: async () => {
      await queue.close();
      connection.disconnect();
    }
  };
}
