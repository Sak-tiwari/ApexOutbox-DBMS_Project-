import "dotenv/config";
import pino from "pino";
import { parseEnv } from "./config/env.js";
import { connectMongo, createRedis, mongoIsReady } from "./db/connect.js";
import { createApp } from "./api/app.js";
import "./models/index.js"; // registers schemas so indexes are built on connect

const env = parseEnv(process.env);
const log = pino({ level: env.LOG_LEVEL });

async function main() {
  await connectMongo(env.MONGODB_URI);
  const redis = createRedis(env.REDIS_URL);
  await redis.connect();

  const app = createApp({
    mongo: mongoIsReady,
    redis: async () => (await redis.ping()) === "PONG",
  });

  const server = app.listen(env.PORT, () => log.info({ port: env.PORT }, "API listening"));

  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "failed to start API");
  process.exit(1);
});
