"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongoose_1 = __importDefault(require("mongoose"));
const logger_1 = require("../logger");
const dispatcherCore_1 = require("./dispatcherCore");
const mongoStores_1 = require("./mongoStores");
const queue_1 = require("./queue");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Standalone dispatcher process (the combined worker runs the same loop; use one or the other). */
async function main() {
    const log = (0, logger_1.createLogger)();
    const uri = process.env.MONGODB_URI;
    const redisUrl = process.env.REDIS_URL;
    if (!uri || !redisUrl)
        throw new Error("MONGODB_URI and REDIS_URL must be configured");
    await mongoose_1.default.connect(uri);
    const queue = (0, queue_1.createQueueClient)(redisUrl);
    const store = new mongoStores_1.MongoOutboxStore();
    log.info({}, "outbox dispatcher started");
    let stopping = false;
    for (const sig of ["SIGINT", "SIGTERM"])
        process.on(sig, () => { stopping = true; });
    while (!stopping) {
        try {
            const outcome = await (0, dispatcherCore_1.dispatchOnce)({ store, publishInvoiceJob: queue.enqueueInvoiceJob, log });
            if (outcome === "idle")
                await sleep(2000);
            else if (outcome === "retry" || outcome === "failed")
                await sleep(1000);
        }
        catch (error) {
            log.error({ error: String(error) }, "dispatcher loop error");
            await sleep(3000);
        }
    }
    await queue.close();
    await mongoose_1.default.disconnect();
}
main().catch((error) => {
    console.error("Dispatcher stopped:", error);
    process.exit(1);
});
//# sourceMappingURL=dispatcher.js.map