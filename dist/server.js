"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongoose_1 = __importDefault(require("mongoose"));
const app_1 = require("./app");
const config_1 = require("./config");
const logger_1 = require("./logger");
const metrics_1 = require("./metrics");
const mongoLeadStore_1 = require("./stores/mongoLeadStore");
const TransitionService_1 = require("./services/TransitionService");
const onboardingService_1 = require("./phase4/onboardingService");
const queue_1 = require("./phase4/queue");
const models_1 = require("./phase4/models");
const outbox_1 = require("./phase4/outbox");
const Lead_1 = require("./models/Lead");
async function startServer() {
    const config = (0, config_1.parseConfig)();
    const log = (0, logger_1.createLogger)(config.LOG_LEVEL);
    await mongoose_1.default.connect(config.MONGODB_URI);
    log.info({}, "Connected to MongoDB successfully.");
    const queue = (0, queue_1.createQueueClient)(config.REDIS_URL);
    const leads = new mongoLeadStore_1.MongoLeadStore();
    const app = (0, app_1.createApp)({
        leads,
        transitions: new TransitionService_1.TransitionService(leads),
        onboard: onboardingService_1.onboardClient,
        apiKeys: (0, config_1.parseApiKeys)(config.API_KEYS),
        log,
        metrics: new metrics_1.Metrics(),
        rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
        checks: {
            mongo: () => mongoose_1.default.connection.readyState === 1,
            redis: async () => (await queue.connection.ping()) === "PONG",
        },
        gauges: async () => ({
            apexoutbox_outbox_pending: await outbox_1.OutboxEvent.countDocuments({ status: "PENDING" }),
            apexoutbox_outbox_failed: await outbox_1.OutboxEvent.countDocuments({ status: "FAILED" }),
            apexoutbox_invoices_email_uncertain: await models_1.Invoice.countDocuments({ status: "EMAIL_UNCERTAIN" }),
            apexoutbox_invoices_email_failed: await models_1.Invoice.countDocuments({ status: "EMAIL_FAILED" }),
            apexoutbox_invoices_email_abandoned: await models_1.Invoice.countDocuments({ status: "EMAIL_ABANDONED" }),
            apexoutbox_invoices_email_sending: await models_1.Invoice.countDocuments({ status: "EMAIL_SENDING" }),
            apexoutbox_leads_onboarding_pending: await Lead_1.Lead.countDocuments({ onboardingStatus: "PENDING", currentState: "Closed-Won" }),
            apexoutbox_leads_onboarding_failed: await Lead_1.Lead.countDocuments({ onboardingStatus: "FAILED" }),
        }),
    });
    const server = app.listen(config.PORT, () => log.info({ port: config.PORT }, "API listening"));
    const shutdown = (signal) => {
        log.info({ signal }, "shutting down");
        server.close(async () => {
            await queue.close();
            await mongoose_1.default.disconnect();
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}
startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
//# sourceMappingURL=server.js.map