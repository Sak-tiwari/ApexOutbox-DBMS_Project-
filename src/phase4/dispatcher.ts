import "dotenv/config";
import mongoose from "mongoose";
import { createLogger } from "../logger";
import { dispatchOnce } from "./dispatcherCore";
import { MongoOutboxStore } from "./mongoStores";
import { createQueueClient } from "./queue";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Standalone dispatcher process (the combined worker runs the same loop; use one or the other). */
async function main() {
  const log = createLogger();
  const uri = process.env.MONGODB_URI;
  const redisUrl = process.env.REDIS_URL;
  if (!uri || !redisUrl) throw new Error("MONGODB_URI and REDIS_URL must be configured");

  await mongoose.connect(uri);
  const queue = createQueueClient(redisUrl);
  const store = new MongoOutboxStore();
  log.info({}, "outbox dispatcher started");

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stopping = true; });

  while (!stopping) {
    try {
      const outcome = await dispatchOnce({ store, publishInvoiceJob: queue.enqueueInvoiceJob, log });
      if (outcome === "idle") await sleep(2000);
      else if (outcome === "retry" || outcome === "failed") await sleep(1000);
    } catch (error) {
      log.error({ error: String(error) }, "dispatcher loop error");
      await sleep(3000);
    }
  }
  await queue.close();
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("Dispatcher stopped:", error);
  process.exit(1);
});
