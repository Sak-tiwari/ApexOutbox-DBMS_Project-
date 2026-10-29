
import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import { Client, Invoice } from "./models";
import { validateOnboarding, getInvoiceIdempotencyKey } from "./onboarding";
import { enqueueInvoiceJob } from "./queue";

const app = express();
app.use(express.json());

app.post("/api/phase4/onboard", async (req, res) => {
  try {
    const parsed = validateOnboarding(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid onboarding data",
        details: parsed.error.flatten()
      });
    }

    const data = parsed.data;
    const idempotencyKey = getInvoiceIdempotencyKey(data.leadId);

    // Reuse an existing invoice if this lead was already processed.
    let invoice = await Invoice.findOne({ idempotencyKey });

    if (!invoice) {
      const client = await Client.findOneAndUpdate(
        { sourceLeadId: data.leadId },
        {
          $setOnInsert: {
            name: data.clientName,
            email: data.email,
            company: data.company
          }
        },
        { upsert: true, new: true }
      );

      try {
        invoice = await Invoice.create({
          idempotencyKey,
          clientId: client._id,
          invoiceNumber: `INV-${new mongoose.Types.ObjectId().toString()}`,
          snapshot: {
            clientName: data.clientName,
            email: data.email,
            company: data.company,
            amount: data.amount,
            currency: data.currency,
            description: data.description,
            createdAt: new Date()
          }
        });
      } catch (error) {
        // Another concurrent request may have created the invoice.
        invoice = await Invoice.findOne({ idempotencyKey });

        if (!invoice) {
          throw error;
        }
      }
    }

    if (invoice.status !== "EMAIL_SENT") {
      await enqueueInvoiceJob(String(invoice._id));
    }

    return res.status(202).json({
      message: "Onboarding request accepted",
      invoiceId: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status
    });
  } catch (error) {
    console.error("Onboarding error:", error);

    return res.status(500).json({
      error: "Unable to process onboarding request"
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = Number(process.env.PORT || 3000);

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Phase 4 API listening on port ${port}`);
  });
}

export default app;
