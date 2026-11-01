import "dotenv/config";
import mongoose from "mongoose";
import { createApp } from "./app";
import { parseApiKeys, parseConfig } from "./config";
import { createLogger } from "./logger";
import { Metrics } from "./metrics";
import { MongoLeadStore } from "./stores/mongoLeadStore";
import { TransitionService } from "./services/TransitionService";
import { onboardClient } from "./phase4/onboardingService";
import { createQueueClient } from "./phase4/queue";
import { Invoice } from "./phase4/models";
import { OutboxEvent } from "./phase4/outbox";
import { Lead } from "./models/Lead";

async function startServer() {
    const config = parseConfig();
    const log = createLogger(config.LOG_LEVEL);

    await mongoose.connect(config.MONGODB_URI);
    log.info({}, "Connected to MongoDB successfully.");

    const queue = createQueueClient(config.REDIS_URL);
    const leads = new MongoLeadStore();

    const app = createApp({
        leads,
        transitions: new TransitionService(leads),
        onboard: onboardClient,
        apiKeys: parseApiKeys(config.API_KEYS),
        log,
        metrics: new Metrics(),
        checks: {
            mongo: () => mongoose.connection.readyState === 1,
            redis: async () => (await queue.connection.ping()) === "PONG",
        },
        gauges: async () => ({
            apexoutbox_outbox_pending: await OutboxEvent.countDocuments({ status: "PENDING" }),
            apexoutbox_outbox_failed: await OutboxEvent.countDocuments({ status: "FAILED" }),
            apexoutbox_invoices_email_uncertain: await Invoice.countDocuments({ status: "EMAIL_UNCERTAIN" }),
            apexoutbox_invoices_email_failed: await Invoice.countDocuments({ status: "EMAIL_FAILED" }),
            apexoutbox_leads_onboarding_pending: await Lead.countDocuments({ onboardingStatus: "PENDING" }),
            apexoutbox_leads_onboarding_failed: await Lead.countDocuments({ onboardingStatus: "FAILED" }),
        }),
    });

    const server = app.listen(config.PORT, () => log.info({ port: config.PORT }, "API listening"));

    const shutdown = (signal: string) => {
        log.info({ signal }, "shutting down");
        server.close(async () => {
            await queue.close();
            await mongoose.disconnect();
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
