"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongoose_1 = __importDefault(require("mongoose"));
const ioredis_1 = __importDefault(require("ioredis"));
const bullmq_1 = require("bullmq");
const logger_1 = require("../logger");
const invoice_1 = require("./invoice");
const email_1 = require("./email");
const mongoStores_1 = require("./mongoStores");
const processor_1 = require("./processor");
const queue_1 = require("./queue");
/** Standalone invoice worker process. */
async function main() {
    const log = (0, logger_1.createLogger)();
    const mongoUri = process.env.MONGODB_URI;
    const redisUrl = process.env.REDIS_URL;
    if (!mongoUri || !redisUrl)
        throw new Error("MONGODB_URI and REDIS_URL must be configured");
    await mongoose_1.default.connect(mongoUri);
    const connection = new ioredis_1.default(redisUrl, { maxRetriesPerRequest: null });
    const store = new mongoStores_1.MongoInvoiceStore();
    const worker = new bullmq_1.Worker(queue_1.QUEUE_NAME, async (job) => {
        try {
            return await (0, processor_1.processInvoiceJob)(job.data.invoiceId, { store, generatePdf: invoice_1.generateInvoicePDF, sendEmail: email_1.sendInvoiceEmail, log });
        }
        catch (error) {
            // Retrying cannot create a missing invoice.
            if (error instanceof processor_1.InvoiceNotFoundError)
                throw new bullmq_1.UnrecoverableError(error.message);
            throw error;
        }
    }, { connection, concurrency: 3 });
    worker.on("completed", (job) => log.info({ jobId: job.id }, "job completed"));
    worker.on("failed", (job, error) => log.error({ jobId: job?.id, error: error.message }, "job failed"));
    worker.on("error", (error) => log.error({ error: error.message }, "worker error"));
    const shutdown = async () => {
        await worker.close();
        connection.disconnect();
        await mongoose_1.default.disconnect();
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
//# sourceMappingURL=worker.js.map