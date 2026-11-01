"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoOutboxStore = exports.MongoInvoiceStore = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const models_1 = require("./models");
const outbox_1 = require("./outbox");
const asInvoice = (d) => ({
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
class MongoInvoiceStore {
    async findById(id) {
        if (!mongoose_1.default.isValidObjectId(id))
            return null;
        const doc = await models_1.Invoice.findById(id).lean();
        return doc ? asInvoice(doc) : null;
    }
    async setPdf(id, pdfPath) {
        // One atomic write for the normal case, so a crash can never leave "path saved, status PENDING".
        const r = await models_1.Invoice.updateOne({ _id: id, status: "PENDING" }, { $set: { pdfPath, status: "PDF_READY" } });
        if (r.matchedCount === 0)
            await models_1.Invoice.updateOne({ _id: id, pdfPath: "" }, { $set: { pdfPath } });
    }
    async claimForSending(id) {
        const doc = await models_1.Invoice.findOneAndUpdate({ _id: id, status: { $in: ["PDF_READY", "EMAIL_FAILED"] }, pdfPath: { $ne: "" } }, { $set: { status: "EMAIL_SENDING" }, $inc: { emailAttempts: 1 } }, { new: true, lean: true });
        return doc ? asInvoice(doc) : null;
    }
    async markSent(id, messageId) {
        await models_1.Invoice.updateOne({ _id: id, status: { $in: ["EMAIL_SENDING", "EMAIL_UNCERTAIN"] } }, { $set: { status: "EMAIL_SENT", emailMessageId: messageId, lastError: "" } });
    }
    async markFailed(id, error) {
        await models_1.Invoice.updateOne({ _id: id, status: "EMAIL_SENDING" }, { $set: { status: "EMAIL_FAILED", lastError: error } });
    }
    async markUncertain(id, error) {
        await models_1.Invoice.updateOne({ _id: id, status: "EMAIL_SENDING" }, { $set: { status: "EMAIL_UNCERTAIN", lastError: error } });
    }
    async markAbandoned(id, error) {
        await models_1.Invoice.updateOne({ _id: id, status: { $in: ["EMAIL_SENDING", "EMAIL_FAILED"] } }, { $set: { status: "EMAIL_ABANDONED", lastError: error } });
    }
    async findStuck(olderThan, limit) {
        const docs = await models_1.Invoice.find({ status: { $in: ["PENDING", "PDF_READY", "EMAIL_SENDING", "EMAIL_FAILED"] }, updatedAt: { $lt: olderThan } })
            .sort({ updatedAt: 1 })
            .limit(limit)
            .select("_id")
            .lean();
        return docs.map((d) => String(d._id));
    }
}
exports.MongoInvoiceStore = MongoInvoiceStore;
const asOutbox = (d) => ({
    id: String(d._id),
    eventId: d.eventId,
    eventType: d.eventType,
    payload: d.payload ?? {},
    attempts: d.attempts ?? 0
});
class MongoOutboxStore {
    async recoverStale(olderThan, maxAttempts) {
        const r = await outbox_1.OutboxEvent.updateMany({ status: "PROCESSING", updatedAt: { $lt: olderThan }, attempts: { $lt: maxAttempts } }, { $set: { status: "PENDING", lastError: "Recovered stale processing event" } });
        return r.modifiedCount;
    }
    async failExhausted(maxAttempts) {
        const r = await outbox_1.OutboxEvent.updateMany({ status: { $in: ["PENDING", "PROCESSING"] }, attempts: { $gte: maxAttempts }, updatedAt: { $lt: new Date(Date.now() - 60_000) } }, { $set: { status: "FAILED", lastError: "Maximum dispatch attempts reached" } });
        return r.modifiedCount;
    }
    async claimNext(now, maxAttempts) {
        const doc = await outbox_1.OutboxEvent.findOneAndUpdate({ status: "PENDING", attempts: { $lt: maxAttempts }, nextAttemptAt: { $lte: now } }, { $set: { status: "PROCESSING" }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true, lean: true });
        return doc ? asOutbox(doc) : null;
    }
    async markPublished(id) {
        await outbox_1.OutboxEvent.updateOne({ _id: id }, { $set: { status: "PUBLISHED", publishedAt: new Date(), lastError: "" } });
    }
    async markRetry(id, error, nextAttemptAt, final) {
        await outbox_1.OutboxEvent.updateOne({ _id: id }, { $set: { status: final ? "FAILED" : "PENDING", lastError: error, nextAttemptAt } });
    }
}
exports.MongoOutboxStore = MongoOutboxStore;
//# sourceMappingURL=mongoStores.js.map