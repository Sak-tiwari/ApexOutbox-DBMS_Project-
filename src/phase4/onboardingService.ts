import mongoose from "mongoose";
import { Client, Invoice } from "./models";
import { getInvoiceIdempotencyKey, type onboardingSchema } from "./onboarding";
import { recordOnboardingEvent } from "./outbox";
import type { z } from "zod";

export type OnboardingInput = z.infer<typeof onboardingSchema>;

export interface OnboardingResult {
  clientId: string;
  invoiceId: string;
  invoiceNumber: string;
  status: string;
}

const isDuplicateKey = (e: unknown) => (e as { code?: number } | null)?.code === 11000;

/**
 * Create-or-get ONE client and ONE invoice for a lead, then make sure an outbox event exists.
 * Safe to call any number of times, concurrently, for the same lead:
 *   - client:  unique index on sourceLeadId
 *   - invoice: unique index on idempotencyKey ("lead:<id>:initial-invoice")
 *   - event:   unique index on eventId ("invoice-created:<invoiceId>")
 * (Extracted unchanged in behaviour from the Phase 4 route handler, plus handling of the
 * duplicate-key error that a concurrent client upsert can raise.)
 */
export async function onboardClient(data: OnboardingInput): Promise<OnboardingResult> {
  const idempotencyKey = getInvoiceIdempotencyKey(data.leadId);

  let invoice = await Invoice.findOne({ idempotencyKey });

  if (!invoice) {
    let client;
    try {
      client = await Client.findOneAndUpdate(
        { sourceLeadId: data.leadId },
        { $setOnInsert: { sourceLeadId: data.leadId, name: data.clientName, email: data.email, company: data.company || "" } },
        { upsert: true, new: true }
      );
    } catch (error) {
      // Two concurrent upserts can both try to insert; the loser gets E11000. The row exists now.
      if (!isDuplicateKey(error)) throw error;
      client = await Client.findOne({ sourceLeadId: data.leadId });
    }
    if (!client) throw new Error("Client could not be created or found");

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
      if (!invoice) throw error;
    }
  }

  if (invoice.status === "PENDING") {
    await recordOnboardingEvent(String(invoice._id));
  }

  return {
    clientId: String(invoice.clientId),
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status
  };
}
