import "dotenv/config";
import IORedis from "ioredis";
import { Queue } from "bullmq";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL must be configured");
}

export const redisConnection = new IORedis(
  process.env.REDIS_URL,
  {
    maxRetriesPerRequest: null
  }
);

export const onboardingQueue = new Queue(
  "client-onboarding",
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  }
);

export async function enqueueInvoiceJob(
  invoiceId: string
) {
  return onboardingQueue.add(
    "process-invoice",
    { invoiceId },
    {
      jobId: `invoice-${invoiceId}`
    }
  );
}
