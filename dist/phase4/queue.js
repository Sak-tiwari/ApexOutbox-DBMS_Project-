"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUEUE_NAME = void 0;
exports.createQueueClient = createQueueClient;
const ioredis_1 = __importDefault(require("ioredis"));
const bullmq_1 = require("bullmq");
exports.QUEUE_NAME = "client-onboarding";
/**
 * Producer-side queue client (API and dispatcher).
 * `enableOfflineQueue: false` makes commands FAIL FAST when Redis is down instead of waiting
 * indefinitely for it to return. The dispatcher turns that failure into a retry with backoff.
 * (Workers use their own connection with maxRetriesPerRequest: null, as BullMQ requires.)
 */
function createQueueClient(redisUrl) {
    const connection = new ioredis_1.default(redisUrl, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 200, 2_000)
    });
    connection.on("error", () => {
        /* connection errors surface through failed commands; avoid unhandled 'error' events */
    });
    const queue = new bullmq_1.Queue(exports.QUEUE_NAME, {
        connection,
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
            removeOnComplete: 100,
            removeOnFail: 500
        }
    });
    queue.on("error", () => { });
    return {
        queue,
        connection,
        // jobId makes publishing idempotent: adding the same invoice twice yields ONE job.
        enqueueInvoiceJob: (invoiceId) => queue.add("process-invoice", { invoiceId }, { jobId: `invoice-${invoiceId}` }),
        requeueInvoice: async (invoiceId) => {
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
//# sourceMappingURL=queue.js.map