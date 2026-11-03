import "dotenv/config";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { assertRlsEffective, createPool } from "./db/pool.js";
import { createLogger } from "./logger.js";

async function main() {
  const config = parseConfig();
  const log = createLogger(config.LOG_LEVEL);
  const db = createPool(config.DATABASE_URL, { max: config.DB_POOL_MAX, applicationName: "apexoutbox-api" });

  // Refuse to run with a role that would silently disable Row-Level Security.
  await assertRlsEffective(db);

  const app = createApp({ db, log });
  const server = app.listen(config.PORT, () => log.info({ port: config.PORT }, "API listening"));

  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    server.close(() => {
      db.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
