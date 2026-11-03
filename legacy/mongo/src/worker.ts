import "dotenv/config";
import fs from "node:fs";
import mongoose from "mongoose";
import IORedis from "ioredis";
import { UnrecoverableError, Worker } from "bullmq";
import { parseConfig } from "./config";
import { createLogger } from "./logger";
import { MongoLeadStore } from "./stores/mongoLeadStore";
import { reconcileOnboarding } from "./services/onboardingHandoff";
import { onboardClient } from "./phase4/onboardingService";
import { dispatchOnce } from "./phase4/dispatcherCore";
import { generateInvoicePDF } from "./phase4/invoice";
import { sendInvoiceEmail } from "./phase4/email";
import { MongoInvoiceStore, MongoOutboxStore } from "./phase4/mongoStores";
import { InvoiceNotFoundError, processInvoiceJob } from "./phase4/processor";
import { QUEUE_NAME, createQueueClient } from "./phase4/queue";
import { requeueStuckInvoices } from "./phase4/requeue";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ONE deployable worker process:
 *   1. BullMQ worker      - makes invoice PDFs and sends emails (at most once per invoice)
 *   2. outbox dispatcher  - publishes pending outbox events to the queue
 *   3. reconciler         - retries Closed-Won leads whose onboarding hand-off did not finish
 *   4. requeue sweep      - re-creates queue jobs for unsent invoices if Redis lost them
 */
async function main() {
  const config = parseConfig();
  const log = createLogger(config.LOG_LEVEL);

  await mongoose.connect(config.MONGODB_URI);
  const queue = createQueueClient(config.REDIS_URL);
  const workerConnection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const invoiceStore = new MongoInvoiceStore();
  const outboxStore = new MongoOutboxStore();
  const leads = new MongoLeadStore();

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      try {
        return await processInvoiceJob(job.data.invoiceId, {
          store: invoiceStore,
          generatePdf: (n, s) => generateInvoicePDF(n, s, config.INVOICE_DIR),
          sendEmail: (d) => sendInvoiceEmail(d, { env: { ...process.env, NODE_ENV: config.NODE_ENV } }),
          log,
        });
      } catch (error) {
        if (error instanceof InvoiceNotFoundError) throw new UnrecoverableError(error.message);
        throw error;
      }
    },
    { connection: workerConnection, concurrency: 3 },
  );
  worker.on("failed", (job, error) => log.error({ jobId: job?.id, error: error.message }, "job failed"));
  worker.on("error", (error) => log.error({ error: error.message }, "worker error"));

  let stopping = false;

  const dispatchLoop = (async () => {
    while (!stopping) {
      try {
        const outcome = await dispatchOnce({ store: outboxStore, publishInvoiceJob: queue.enqueueInvoiceJob, log });
        await sleep(outcome === "published" ? 0 : outcome === "idle" ? 2000 : 1000);
      } catch (error) {
        log.error({ error: String(error) }, "dispatcher loop error");
        await sleep(3000);
      }
    }
  })();

  const reconcileLoop = (async () => {
    while (!stopping) {
      try {
        const tally = await reconcileOnboarding({ leads, onboard: onboardClient, log });
        if (tally.done || tally.failed) log.info(tally, "onboarding reconciliation");
      } catch (error) {
        log.error({ error: String(error) }, "reconciler error");
      }
      await sleep(30_000);
    }
  })();

  const requeueLoop = (async () => {
    while (!stopping) {
      try {
        await requeueStuckInvoices({ store: invoiceStore, requeue: queue.requeueInvoice, log });
      } catch (error) {
        log.error({ error: String(error) }, "requeue sweep error");
      }
      await sleep(60_000);
    }
  })();

  // Liveness signal for the container healthcheck: only refreshed while the loops are actually running
  // and MongoDB is connected, so a wedged or disconnected worker becomes "unhealthy".
  const HEARTBEAT = process.env.WORKER_HEARTBEAT_FILE || "/tmp/worker-heartbeat";
  const beat = () => {
    if (mongoose.connection.readyState === 1) {
      try { fs.writeFileSync(HEARTBEAT, String(Date.now())); } catch { /* read-only fs: healthcheck will flag it */ }
    }
  };
  beat();
  const heartbeat = setInterval(beat, 15_000);
  heartbeat.unref();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker shutting down");
    stopping = true;
    clearInterval(heartbeat);
    await worker.close();
    await Promise.race([Promise.all([dispatchLoop, reconcileLoop, requeueLoop]), sleep(5000)]);
    await queue.close();
    workerConnection.disconnect();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info({}, "worker started (invoice jobs + outbox dispatcher + onboarding reconciler)");
}

main().catch((error) => {
  console.error("Worker startup failed:", error);
  process.exit(1);
});
