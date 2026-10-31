import "dotenv/config";
import pino from "pino";
import { parseEnv } from "./config/env.js";
import { connectMongo, createRedis } from "./db/connect.js";
import "./models/index.js";

/**
 * Worker process entry point. Runs separately from the API (same codebase).
 * Phase 1: connects and idles. Later phases register BullMQ workers here:
 *   Phase 2  scrape-jobs queue
 *   Phase 4  outbox dispatcher, invoice-pdf queue, email queue
 */
const env = parseEnv(process.env);
const log = pino({ level: env.LOG_LEVEL });

async function main() {
  await connectMongo(env.MONGODB_URI);
  const redis = createRedis(env.REDIS_URL);
  await redis.connect();
  log.info("worker connected to MongoDB and Redis; no queues registered yet (Phase 1)");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker shutting down");
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "failed to start worker");
  process.exit(1);
});
