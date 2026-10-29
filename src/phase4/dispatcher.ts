
import "dotenv/config";
import mongoose from "mongoose";
import { OutboxEvent } from "./outbox";
import { enqueueInvoiceJob } from "./queue";

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be configured");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  console.log("Outbox dispatcher started");

  while (true) {
    const event = await OutboxEvent.findOneAndUpdate(
      { status: "PENDING" },
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
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
      event.status = "PENDING";
      event.lastError = String(error);
      await event.save();

      console.error(`Dispatch failed: ${event.eventId}`, error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

main().catch((error) => {
  console.error("Dispatcher stopped:", error);
  process.exit(1);
});
