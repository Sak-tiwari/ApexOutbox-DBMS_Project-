import mongoose from "mongoose";
import { Client, Invoice } from "./models";
import { getInvoiceIdempotencyKey, type onboardingSchema } from "./onboarding";
import { recordOnboardingEvent } from "./outbox";
import path from "node:path";
import { computeTotals } from "../invoiceTemplates/gst";
import { InvoiceTemplateStore } from "../invoiceTemplates/store";
import type { InvoiceSnapshot } from "./types";

// Only reads the business profile and the default template here (no files), so the asset folder is not used.
const templates = new InvoiceTemplateStore(path.join(process.env.INVOICE_DIR || "generated-invoices", "assets"));

export class InvoiceNumberTakenError extends Error {}
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

    const invoiceNumber = `INV-${new mongoose.Types.ObjectId().toString()}`;
    const snapshot = await buildSnapshot(data, invoiceNumber);
    try {
      invoice = await Invoice.create({
        idempotencyKey,
        invoiceNumber,
        clientId: client._id,
        snapshot,
        ...(data.ownerId ? { ownerId: data.ownerId, displayNumber: snapshot.displayNumber } : {}),
        status: "PENDING"
      });
    } catch (error) {
      // A duplicate request may have created the invoice first.
      invoice = await Invoice.findOne({ idempotencyKey });
      if (!invoice) {
        if (isDuplicateKey(error) && /displayNumber/.test(String((error as { message?: string }).message))) {
          throw new InvoiceNumberTakenError(`Invoice number ${snapshot.displayNumber} is already used on another invoice`);
        }
        throw error;
      }
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

/**
 * Everything printed on the invoice is copied into the snapshot when the invoice is created: business details,
 * GST, totals and the template version. Later edits to the profile or the template never change this invoice.
 */
async function buildSnapshot(data: OnboardingInput, internalNumber: string): Promise<InvoiceSnapshot> {
  const base: InvoiceSnapshot = {
    clientName: data.clientName, email: data.email, company: data.company || "", amount: data.amount,
    currency: data.currency, description: data.description, createdAt: new Date(),
  };
  if (!data.ownerId) return base; // old callers (the plain /api/onboard route): unchanged behaviour
  const biz = await templates.getBusiness(data.ownerId);
  const business = {
    name: biz.name, address: biz.address, gstin: data.businessGstin || biz.gstin, state: biz.state, email: biz.email, phone: biz.phone,
    logoAssetId: biz.logoAssetId, bankName: biz.bankName, account: biz.account, ifsc: biz.ifsc, upiId: biz.upiId,
    paymentLink: biz.paymentLink, qrAssetId: biz.qrAssetId, terms: biz.terms,
  };
  const rate = data.gstRate ?? biz.defaultGstRate ?? 0;
  const items = [{ description: data.description, qty: 1, rate: data.amount, taxRate: rate, amount: data.amount }];
  const totals = computeTotals(items, rate, business, { gstin: data.clientGstin, state: data.clientState });
  return {
    ...base,
    amount: totals.total,
    ownerId: data.ownerId,
    displayNumber: data.invoiceNumber || internalNumber,
    business,
    clientAddress: data.clientAddress || "",
    clientState: data.clientState || "",
    clientGstin: data.clientGstin || "",
    items,
    gstRate: rate,
    totals,
    templateVersionId: await templates.resolveVersionId(data.ownerId, data.templateId),
  };
}
