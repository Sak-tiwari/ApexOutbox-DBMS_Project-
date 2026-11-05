import mongoose from "mongoose";
import { Invoice } from "./models";
import { OutboxEvent } from "./outbox";
import type { InvoiceRecord, InvoiceStore, OutboxRecord, OutboxStore } from "./ports";

const asInvoice = (d: any): InvoiceRecord => ({
  id: String(d._id),
  invoiceNumber: d.invoiceNumber,
  snapshot: d.snapshot,
  pdfPath: d.pdfPath ?? "",
  status: d.status,
  emailAttempts: d.emailAttempts ?? 0,
  emailMessageId: d.emailMessageId ?? "",
  lastError: d.lastError ?? "",
  updatedAt: d.updatedAt ?? new Date(0)
});

export class MongoInvoiceStore implements InvoiceStore {
  async findById(id: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await Invoice.findById(id).lean();
    return doc ? asInvoice(doc) : null;
  }
  async setPdf(id: string, pdfPath: string) {
    // One atomic write for the normal case, so a crash can never leave "path saved, status PENDING".
    const r = await Invoice.updateOne({ _id: id, status: "PENDING" }, { $set: { pdfPath, status: "PDF_READY" } });
    if (r.matchedCount === 0) await Invoice.updateOne({ _id: id, pdfPath: "" }, { $set: { pdfPath } });
  }
  async claimForSending(id: string) {
    const doc = await Invoice.findOneAndUpdate(
      { _id: id, status: { $in: ["PDF_READY", "EMAIL_FAILED"] }, pdfPath: { $ne: "" } },
      { $set: { status: "EMAIL_SENDING" }, $inc: { emailAttempts: 1 } },
      { new: true, lean: true }
    );
    return doc ? asInvoice(doc) : null;
  }
  async markSent(id: string, messageId: string) {
    await Invoice.updateOne(
      { _id: id, status: { $in: ["EMAIL_SENDING", "EMAIL_UNCERTAIN"] } },
      { $set: { status: "EMAIL_SENT", emailMessageId: messageId, lastError: "" } }
    );
  }
  async markFailed(id: string, error: string) {
    await Invoice.updateOne({ _id: id, status: "EMAIL_SENDING" }, { $set: { status: "EMAIL_FAILED", lastError: error } });
  }
  async markUncertain(id: string, error: string) {
    await Invoice.updateOne({ _id: id, status: "EMAIL_SENDING" }, { $set: { status: "EMAIL_UNCERTAIN", lastError: error } });
  }
  async markAbandoned(id: string, error: string) {
    await Invoice.updateOne(
      { _id: id, status: { $in: ["EMAIL_SENDING", "EMAIL_FAILED"] } },
      { $set: { status: "EMAIL_ABANDONED", lastError: error } }
    );
  }
  async findStuck(olderThan: Date, limit: number) {
    const docs = await Invoice.find({ status: { $in: ["PENDING", "PDF_READY", "EMAIL_SENDING", "EMAIL_FAILED"] }, updatedAt: { $lt: olderThan } })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .select("_id")
      .lean();
    return docs.map((d: any) => String(d._id));
  }
}

const asOutbox = (d: any): OutboxRecord => ({
  id: String(d._id),
  eventId: d.eventId,
  eventType: d.eventType,
  payload: d.payload ?? {},
  attempts: d.attempts ?? 0
});

export class MongoOutboxStore implements OutboxStore {
  async recoverStale(olderThan: Date, maxAttempts: number) {
    const r = await OutboxEvent.updateMany(
      { status: "PROCESSING", updatedAt: { $lt: olderThan }, attempts: { $lt: maxAttempts } },
      { $set: { status: "PENDING", lastError: "Recovered stale processing event" } }
    );
    return r.modifiedCount;
  }
  async failExhausted(maxAttempts: number) {
    const r = await OutboxEvent.updateMany(
      { status: { $in: ["PENDING", "PROCESSING"] }, attempts: { $gte: maxAttempts }, updatedAt: { $lt: new Date(Date.now() - 60_000) } },
      { $set: { status: "FAILED", lastError: "Maximum dispatch attempts reached" } }
    );
    return r.modifiedCount;
  }
  async claimNext(now: Date, maxAttempts: number) {
    const doc = await OutboxEvent.findOneAndUpdate(
      { status: "PENDING", attempts: { $lt: maxAttempts }, nextAttemptAt: { $lte: now } },
      { $set: { status: "PROCESSING" }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true, lean: true }
    );
    return doc ? asOutbox(doc) : null;
  }
  async markPublished(id: string) {
    await OutboxEvent.updateOne({ _id: id }, { $set: { status: "PUBLISHED", publishedAt: new Date(), lastError: "" } });
  }
  async markRetry(id: string, error: string, nextAttemptAt: Date, final: boolean) {
    await OutboxEvent.updateOne(
      { _id: id },
      { $set: { status: final ? "FAILED" : "PENDING", lastError: error, nextAttemptAt } }
    );
  }
}

import type { InvoiceReader, InvoiceView } from "../routes/invoiceRoutes";

/** Read-only view of invoices for the UI. */
export class MongoInvoiceReader implements InvoiceReader {
  async list({ leadId, limit }: { leadId?: string; limit: number }): Promise<InvoiceView[]> {
    const filter = leadId ? { idempotencyKey: `lead:${leadId}:initial-invoice` } : {};
    const docs = await Invoice.find(filter).sort({ _id: -1 }).limit(limit).lean();
    return docs.map((d: any) => ({
      id: String(d._id),
      invoiceNumber: d.invoiceNumber,
      leadId: /^lead:(.+):initial-invoice$/.exec(d.idempotencyKey)?.[1] ?? null,
      status: d.status,
      clientName: d.snapshot?.clientName ?? "",
      email: d.snapshot?.email ?? "",
      company: d.snapshot?.company ?? "",
      amount: d.snapshot?.amount ?? 0,
      currency: d.snapshot?.currency ?? "INR",
      description: d.snapshot?.description ?? "",
      emailAttempts: d.emailAttempts ?? 0,
      lastError: d.lastError ?? "",
      hasPdf: !!d.pdfPath,
      createdAt: new Date(d.createdAt).toISOString(),
      updatedAt: new Date(d.updatedAt).toISOString(),
    }));
  }

  async pdfPath(id: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const d: any = await Invoice.findById(id).select("pdfPath invoiceNumber").lean();
    return d?.pdfPath ? { path: d.pdfPath as string, invoiceNumber: d.invoiceNumber as string } : null;
  }
}
