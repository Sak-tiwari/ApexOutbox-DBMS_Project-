"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_fs_1 = __importDefault(require("node:fs"));
const mongoose_1 = __importDefault(require("mongoose"));
const ioredis_1 = __importDefault(require("ioredis"));
const bullmq_1 = require("bullmq");
const config_1 = require("./config");
const logger_1 = require("./logger");
const mongoLeadStore_1 = require("./stores/mongoLeadStore");
const onboardingHandoff_1 = require("./services/onboardingHandoff");
const onboardingService_1 = require("./phase4/onboardingService");
const dispatcherCore_1 = require("./phase4/dispatcherCore");
const invoice_1 = require("./phase4/invoice");
const email_1 = require("./phase4/email");
const mongoStores_1 = require("./phase4/mongoStores");
const processor_1 = require("./phase4/processor");
const queue_1 = require("./phase4/queue");
const requeue_1 = require("./phase4/requeue");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * ONE deployable worker process:
 *   1. BullMQ worker      - makes invoice PDFs and sends emails (at most once per invoice)
 *   2. outbox dispatcher  - publishes pending outbox events to the queue
 *   3. reconciler         - retries Closed-Won leads whose onboarding hand-off did not finish
 *   4. requeue sweep      - re-creates queue jobs for unsent invoices if Redis lost them
 */
async function main() {
    const config = (0, config_1.parseConfig)();
    const log = (0, logger_1.createLogger)(config.LOG_LEVEL);
    await mongoose_1.default.connect(config.MONGODB_URI);
    const queue = (0, queue_1.createQueueClient)(config.REDIS_URL);
    const workerConnection = new ioredis_1.default(config.REDIS_URL, { maxRetriesPerRequest: null });
    const invoiceStore = new mongoStores_1.MongoInvoiceStore();
    const outboxStore = new mongoStores_1.MongoOutboxStore();
    const leads = new mongoLeadStore_1.MongoLeadStore();
    const worker = new bullmq_1.Worker(queue_1.QUEUE_NAME, async (job) => {
        try {
            return await (0, processor_1.processInvoiceJob)(job.data.invoiceId, {
                store: invoiceStore,
                generatePdf: (n, s) => (0, invoice_1.generateInvoicePDF)(n, s, config.INVOICE_DIR),
                sendEmail: (d) => (0, email_1.sendInvoiceEmail)(d, { env: { ...process.env, NODE_ENV: config.NODE_ENV } }),
                log,
            });
        }
        catch (error) {
            if (error instanceof processor_1.InvoiceNotFoundError)
                throw new bullmq_1.UnrecoverableError(error.message);
            throw error;
        }
    }, { connection: workerConnection, concurrency: 3 });
    worker.on("failed", (job, error) => log.error({ jobId: job?.id, error: error.message }, "job failed"));
    worker.on("error", (error) => log.error({ error: error.message }, "worker error"));
    let stopping = false;
    const dispatchLoop = (async () => {
        while (!stopping) {
            try {
                const outcome = await (0, dispatcherCore_1.dispatchOnce)({ store: outboxStore, publishInvoiceJob: queue.enqueueInvoiceJob, log });
                await sleep(outcome === "published" ? 0 : outcome === "idle" ? 2000 : 1000);
            }
            catch (error) {
                log.error({ error: String(error) }, "dispatcher loop error");
                await sleep(3000);
            }
        }
    })();
    const reconcileLoop = (async () => {
        while (!stopping) {
            try {
                const tally = await (0, onboardingHandoff_1.reconcileOnboarding)({ leads, onboard: onboardingService_1.onboardClient, log });
                if (tally.done || tally.failed)
                    log.info(tally, "onboarding reconciliation");
            }
            catch (error) {
                log.error({ error: String(error) }, "reconciler error");
            }
            await sleep(30_000);
        }
    })();
    const requeueLoop = (async () => {
        while (!stopping) {
            try {
                await (0, requeue_1.requeueStuckInvoices)({ store: invoiceStore, requeue: queue.requeueInvoice, log });
            }
            catch (error) {
                log.error({ error: String(error) }, "requeue sweep error");
            }
            await sleep(60_000);
        }
    })();
    // Liveness signal for the container healthcheck: only refreshed while the loops are actually running
    // and MongoDB is connected, so a wedged or disconnected worker becomes "unhealthy".
    const HEARTBEAT = process.env.WORKER_HEARTBEAT_FILE || "/tmp/worker-heartbeat";
    const beat = () => {
        if (mongoose_1.default.connection.readyState === 1) {
            try {
                node_fs_1.default.writeFileSync(HEARTBEAT, String(Date.now()));
            }
            catch { /* read-only fs: healthcheck will flag it */ }
        }
    };
    beat();
    const heartbeat = setInterval(beat, 15_000);
    heartbeat.unref();
    const shutdown = async (signal) => {
        log.info({ signal }, "worker shutting down");
        stopping = true;
        clearInterval(heartbeat);
        await worker.close();
        await Promise.race([Promise.all([dispatchLoop, reconcileLoop, requeueLoop]), sleep(5000)]);
        await queue.close();
        workerConnection.disconnect();
        await mongoose_1.default.disconnect();
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
//# sourceMappingURL=worker.js.map