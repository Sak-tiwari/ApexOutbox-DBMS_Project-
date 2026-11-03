import "dotenv/config";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { assertRlsEffective, createPool } from "./db/pool.js";
import { createLogger } from "./logger.js";
import { EmailWorker } from "./email/worker.js";
import { createMailer } from "./email/mailer.js";
import { InvoiceStorage } from "./invoices/storage.js";
import { InvoicesService } from "./invoices/service.js";
import { RealtimeHub } from "./realtime/hub.js";
import { ScrapeWorker } from "./scraper/worker.js";

async function main() {
  const config = parseConfig();
  const log = createLogger(config.LOG_LEVEL);
  const db = createPool(config.DATABASE_URL, { max: config.DB_POOL_MAX, applicationName: "apexoutbox-api" });

  // Refuse to run with a role that would silently disable Row-Level Security.
  await assertRlsEffective(db);

  // The scraper runs in-process; it can be split into its own process later because it only talks to Postgres.
  const worker = new ScrapeWorker({ db, log });
  const invoices = new InvoicesService(db, new InvoiceStorage(config.INVOICE_STORAGE_DIR));
  const emailWorker = new EmailWorker({
    db, log, invoices, mailer: createMailer(config, log),
    messageIdDomain: config.EMAIL_FROM?.includes("@") ? config.EMAIL_FROM.split("@").pop()!.replace(/[^A-Za-z0-9.-]/g, "") : undefined,
  });
  const hub = new RealtimeHub(db, log);
  await hub.start();
  const app = createApp({ db, log, config, invoices, hub, onJobQueued: () => worker.poke(), onEmailQueued: () => emailWorker.poke() });
  worker.start();
  emailWorker.start();
  const server = app.listen(config.PORT, () => log.info({ port: config.PORT }, "API listening"));

  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    server.close(() => {
      Promise.all([worker.stop(), emailWorker.stop(), hub.close()]).then(() => db.end()).finally(() => process.exit(0));
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
