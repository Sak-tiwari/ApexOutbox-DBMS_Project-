"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoLeadStore = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Lead_1 = require("../models/Lead");
function toRecord(doc) {
    return {
        id: String(doc._id),
        name: doc.name,
        company: doc.company,
        currentState: doc.currentState,
        ownerId: doc.ownerId,
        version: doc.__v ?? 0,
        followUpDate: doc.followUpDate ?? undefined,
        activityHistory: (doc.activityHistory ?? []).map((a) => ({
            fromState: a.fromState,
            toState: a.toState,
            changedBy: a.changedBy,
            reason: a.reason,
            timestamp: a.timestamp,
        })),
        deal: doc.deal ? { email: doc.deal.email, amount: doc.deal.amount, currency: doc.deal.currency, description: doc.deal.description } : undefined,
        onboardingStatus: doc.onboardingStatus ?? undefined,
        onboardingAttempts: doc.onboardingAttempts ?? 0,
        onboardingError: doc.onboardingError ?? "",
    };
}
class MongoLeadStore {
    async findById(id) {
        // A malformed id is simply "not found", not a database error.
        if (!mongoose_1.default.isValidObjectId(id))
            return null;
        const doc = await Lead_1.Lead.findById(id).lean();
        return doc ? toRecord(doc) : null;
    }
    async applyTransition(w) {
        const set = { currentState: w.to };
        if (w.deal) {
            set.deal = w.deal;
            set.onboardingStatus = "PENDING";
            set.onboardingAttempts = 0;
            set.onboardingError = "";
        }
        const doc = await Lead_1.Lead.findOneAndUpdate({ _id: w.id, __v: w.expectedVersion, currentState: w.from }, { $set: set, $push: { activityHistory: w.entry }, $inc: { __v: 1 } }, { new: true, lean: true });
        return doc ? toRecord(doc) : null;
    }
    async list(q) {
        const filter = {};
        if (q.ownerId)
            filter.ownerId = q.ownerId;
        if (q.state)
            filter.currentState = q.state;
        if (q.followUpBefore || q.followUpAfter) {
            filter.followUpDate = { ...(q.followUpBefore ? { $lte: q.followUpBefore } : {}), ...(q.followUpAfter ? { $gte: q.followUpAfter } : {}) };
        }
        if (q.after) {
            if (!mongoose_1.default.isValidObjectId(q.after))
                return { items: [], nextCursor: null };
            filter._id = { $gt: q.after };
        }
        const docs = await Lead_1.Lead.find(filter).select("-activityHistory").sort({ _id: 1 }).limit(q.limit + 1).lean();
        const page = docs.slice(0, q.limit).map(toRecord);
        return { items: page, nextCursor: docs.length > q.limit ? page[page.length - 1].id : null };
    }
    async create(l) {
        const doc = await Lead_1.Lead.create({ name: l.name, company: l.company, ownerId: l.ownerId, ...(l.followUpDate ? { followUpDate: l.followUpDate } : {}) });
        return toRecord(doc.toObject());
    }
    async cancelPendingOnboarding(id) {
        if (!mongoose_1.default.isValidObjectId(id))
            return;
        await Lead_1.Lead.updateOne({ _id: id, onboardingStatus: "PENDING", currentState: { $ne: "Closed-Won" } }, { $set: { onboardingStatus: "CANCELLED", onboardingError: "Lead left Closed-Won before onboarding finished" } });
    }
    async findOnboardingPending(limit) {
        const docs = await Lead_1.Lead.find({ onboardingStatus: "PENDING", currentState: "Closed-Won" })
            .sort({ updatedAt: 1 })
            .limit(limit)
            .lean();
        return docs.map(toRecord);
    }
    async markOnboarding(id, status, error = "") {
        const inc = status === "DONE" ? {} : { onboardingAttempts: 1 };
        await Lead_1.Lead.updateOne({ _id: id }, { $set: { onboardingStatus: status, onboardingError: error }, ...(status === "DONE" ? {} : { $inc: inc }) });
    }
}
exports.MongoLeadStore = MongoLeadStore;
//# sourceMappingURL=mongoLeadStore.js.map