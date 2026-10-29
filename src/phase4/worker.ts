
import "dotenv/config";
import mongoose from "mongoose";
import IORedis from "ioredis";
import { Worker } from "bullmq";
import { Invoice } from "./models";
import { generateInvoicePDF } from "./invoice";
import { sendInvoiceEmail } from "./email";

async function main() {
  if (!process.env.MONGODB_URI || !process.env.REDIS_URL) {
    throw new Error(
      "MONGODB_URI and REDIS_URL must be configured"
    );
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const connection = new IORedis(
    process.env.REDIS_URL,
    { maxRetriesPerRequest: null }
  );

  const worker = new Worker(
    "client-onboarding",
    async (job) => {
      const invoice = await Invoice.findById(
        job.data.invoiceId
      );

      if (!invoice) {
        throw new Error("Invoice not found");
      }

      if (invoice.status === "EMAIL_SENT") {
        return { skipped: true };
      }

      try {
        if (!invoice.pdfPath) {
          invoice.pdfPath = await generateInvoicePDF(
            invoice.invoiceNumber,
            invoice.snapshot
          );

          invoice.status = "PDF_READY";
          await invoice.save();
        }

        invoice.emailAttempts += 1;
        await invoice.save();

        const result = await sendInvoiceEmail({
          to: invoice.snapshot.email,
          clientName: invoice.snapshot.clientName,
          invoiceNumber: invoice.invoiceNumber,
          pdfPath: invoice.pdfPath
        });

        invoice.emailMessageId = result.messageId;
        invoice.status = "EMAIL_SENT";
        invoice.lastError = "";

        await invoice.save();

        return {
          invoiceId: String(invoice._id),
          status: invoice.status,
          demoEmail: result.demo
        };
      } catch (error) {
        invoice.status = "EMAIL_FAILED";
        invoice.lastError = String(error);
        await invoice.save();
        throw error;
      }
    },
    {
      connection,
      concurrency: 3
    }
  );

  worker.on("completed", (job) => {
    console.log(`Completed job: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `Failed job: ${job?.id}`,
      error.message
    );
  });

  console.log("Phase 4 onboarding worker started");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
