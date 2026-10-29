
import "dotenv/config";
import mongoose from "mongoose";
import { OutboxEvent } from "./outbox";
import { enqueueInvoiceJob } from "./queue";

const MAX_ATTEMPTS = 5;
const STALE_AFTER_MS = 60_000;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI must be configured");
  }

  await mongoose.connect(uri);
  console.log("Outbox dispatcher started");

  while (true) {
    try {
      // Recover events abandoned by a crashed dispatcher.
      await OutboxEvent.updateMany(
        {
          status: "PROCESSING",
          updatedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
          attempts: { $lt: MAX_ATTEMPTS }
        },
        {
          $set: {
            status: "PENDING",
            lastError: "Recovered stale processing event"
          }
        }
      );

      // Stop retrying events that exhausted their attempts.
      await OutboxEvent.updateMany(
        {
          status: "PENDING",
          attempts: { $gte: MAX_ATTEMPTS }
        },
        {
          $set: {
            status: "FAILED",
            lastError: "Maximum dispatch attempts reached"
          }
        }
      );

      const event = await OutboxEvent.findOneAndUpdate(
        {
          status: "PENDING",
          attempts: { $lt: MAX_ATTEMPTS }
        },
        {
          $set: { status: "PROCESSING" },
          $inc: { attempts: 1 }
        },
        {
          sort: { createdAt: 1 },
          new: true
        }
      );

      if (!event) {
        await sleep(2000);
        continue;
      }

      try {
        if (event.eventType !== "INVOICE_CREATED") {
          throw new Error(`Unsupported event: ${event.eventType}`);
        }

        await enqueueInvoiceJob(event.payload.invoiceId);

        event.status = "PUBLISHED";
        event.publishedAt = new Date();
        event.lastError = "";
        await event.save();

        console.log(`Published event: ${event.eventId}`);
      } catch (error) {
        event.lastError = String(error);
        event.status =
          event.attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";

        await event.save();
        console.error(`Dispatch failed: ${event.eventId}`, error);
        await sleep(2000);
      }
    } catch (error) {
      console.error("Dispatcher loop error:", error);
      await sleep(3000);
    }
  }
}

main().catch((error) => {
  console.error("Dispatcher stopped:", error);
  process.exit(1);
});

