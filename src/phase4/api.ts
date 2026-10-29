
import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import { Client, Invoice } from "./models";
import { onboardingSchema, getInvoiceIdempotencyKey } from "./onboarding";
import { recordOnboardingEvent } from "./outbox";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", phase: 4 });
});

app.post("/api/phase4/onboard", async (req, res) => {
  try {
    const parsed = onboardingSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid onboarding data",
        details: parsed.error.issues
      });
    }

    const data = parsed.data;
    const idempotencyKey = getInvoiceIdempotencyKey(data.leadId);

    let invoice = await Invoice.findOne({ idempotencyKey });

    if (!invoice) {
      const client = await Client.findOneAndUpdate(
        { sourceLeadId: data.leadId },
        {
          $setOnInsert: {
            sourceLeadId: data.leadId,
            name: data.clientName,
            email: data.email,
            company: data.company || ""
          }
        },
        { upsert: true, new: true }
      );

      try {
        invoice = await Invoice.create({
          idempotencyKey,
          invoiceNumber: `INV-${new mongoose.Types.ObjectId().toString()}`,
          clientId: client._id,
          snapshot: {
            clientName: data.clientName,
            email: data.email,
            company: data.company || "",
            amount: data.amount,
            currency: data.currency,
            description: data.description,
            createdAt: new Date()
          },
          status: "PENDING"
        });
      } catch (error) {
        // A duplicate request may have created the invoice first.
        invoice = await Invoice.findOne({ idempotencyKey });

        if (!invoice) {
          throw error;
        }
      }
    }

    if (invoice.status === "PENDING") {
      await recordOnboardingEvent(String(invoice._id));
    }

    return res.status(202).json({
      message: "Onboarding accepted for processing",
      clientId: String(invoice.clientId),
      invoiceId: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status
    });
  } catch (error) {
    console.error("Onboarding API error:", error);

    return res.status(500).json({
      error: "Unable to process onboarding request"
    });
  }
});

async function startServer() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI must be configured");
  }

  await mongoose.connect(mongoUri);

  const port = Number(process.env.PORT || 3000);

  app.listen(port, () => {
    console.log(`Phase 4 API listening on port ${port}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start Phase 4 API:", error);
    process.exit(1);
  });
}

export default app;

