import mongoose from "mongoose";
import { Lead } from "../models/Lead";
import { Invoice } from "../phase4/models";
import type { Log } from "../phase4/ports";
import type { InvoiceAccess, OwnedInvoice } from "../routes/invoiceTemplateRoutes";
import { generateInvoicePdfWithTemplate } from "./invoicePdf";
import type { InvoiceTemplateStore } from "./store";

const leadIdOf = (key: string) => /^lead:(.+):initial-invoice$/.exec(key)?.[1];

/** Invoices made before templates have no ownerId: their owner is the owner of the lead they came from. */
async function ownerOf(d: any): Promise<string | undefined> {
  if (d.ownerId) return d.ownerId;
  const leadId = leadIdOf(d.idempotencyKey ?? "");
  if (!leadId || !mongoose.isValidObjectId(leadId)) return undefined;
  return (await Lead.findById(leadId).select("ownerId").lean<any>())?.ownerId;
}

export class MongoInvoiceAccess implements InvoiceAccess {
  constructor(private deps: { store: InvoiceTemplateStore; invoiceDir: string; log: Log }) {}

  async get(ownerId: string, invoiceId: string): Promise<OwnedInvoice | null> {
    if (!mongoose.isValidObjectId(invoiceId)) return null;
    const d = await Invoice.findById(invoiceId).lean<any>();
    if (!d || (await ownerOf(d)) !== ownerId) return null;
    return { id: String(d._id), number: d.invoiceNumber, status: d.status, snapshot: { ...d.snapshot, ownerId } };
  }

  async list(ownerId: string, limit: number) {
    const docs = await Invoice.find({ ownerId }).sort({ _id: -1 }).limit(limit).lean<any[]>();
    if (docs.length < limit) {
      // Older invoices (no ownerId): checked through their lead.
      for (const d of await Invoice.find({ ownerId: { $exists: false } }).sort({ _id: -1 }).limit(limit).lean<any[]>()) {
        if (docs.length >= limit) break;
        if ((await ownerOf(d)) === ownerId) docs.push(d);
      }
    }
    return docs.map((d) => ({ id: String(d._id), number: d.displayNumber || d.snapshot?.displayNumber || d.invoiceNumber, clientName: d.snapshot?.clientName ?? "" }));
  }

  async regenerate(ownerId: string, invoiceId: string, templateVersionId?: string) {
    const inv = await this.get(ownerId, invoiceId);
    if (!inv) throw new Error("Invoice not found");
    const snapshot = { ...inv.snapshot, ...(templateVersionId ? { templateVersionId } : {}) };
    const r = await generateInvoicePdfWithTemplate(inv.number, snapshot, this.deps);
    await Invoice.updateOne({ _id: invoiceId }, { $set: { pdfPath: r.path, ...(templateVersionId ? { "snapshot.templateVersionId": templateVersionId } : {}) } });
    return { fallback: r.fallback, usedVersionId: r.usedVersionId };
  }
}
