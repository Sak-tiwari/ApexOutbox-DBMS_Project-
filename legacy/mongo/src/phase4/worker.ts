import "dotenv/config";
import mongoose from "mongoose";
import IORedis from "ioredis";
import { UnrecoverableError, Worker } from "bullmq";
import { createLogger } from "../logger";
import { generateInvoicePDF } from "./invoice";
import { sendInvoiceEmail } from "./email";
import { MongoInvoiceStore } from "./mongoStores";
import { InvoiceNotFoundError, processInvoiceJob } from "./processor";
import { QUEUE_NAME } from "./queue";

/** Standalone invoice worker process. */
async function main() {
  const log = createLogger();
  const mongoUri = process.env.MONGODB_URI;
  const redisUrl = process.env.REDIS_URL;
  if (!mongoUri || !redisUrl) throw new Error("MONGODB_URI and REDIS_URL must be configured");

  await mongoose.connect(mongoUri);
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const store = new MongoInvoiceStore();

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      try {
        return await processInvoiceJob(job.data.invoiceId, { store, generatePdf: generateInvoicePDF, sendEmail: sendInvoiceEmail, log });
      } catch (error) {
        // Retrying cannot create a missing invoice.
        if (error instanceof InvoiceNotFoundError) throw new UnrecoverableError(error.message);
        throw error;
      }
    },
    { connection, concurrency: 3 }
  );

  worker.on("completed", (job) => log.info({ jobId: job.id }, "job completed"));
  worker.on("failed", (job, error) => log.error({ jobId: job?.id, error: error.message }, "job failed"));
  worker.on("error", (error) => log.error({ error: error.message }, "worker error"));

  const shutdown = async () => {
    await worker.close();
    connection.disconnect();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info({}, "invoice worker started");
}

main().catch((error) => {
  console.error("Worker startup failed:", error);
  process.exit(1);
});
