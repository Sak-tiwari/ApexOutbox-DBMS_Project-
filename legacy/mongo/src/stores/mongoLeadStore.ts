import mongoose from "mongoose";
import { Lead } from "../models/Lead";
import type { OnboardingStatus } from "../models/Lead";
import type { LeadRecord, LeadStore, ListLeadsQuery, NewLead, TransitionWrite } from "./types";

function toRecord(doc: any): LeadRecord {
  return {
    id: String(doc._id),
    name: doc.name,
    company: doc.company,
    currentState: doc.currentState,
    ownerId: doc.ownerId,
    version: doc.__v ?? 0,
    followUpDate: doc.followUpDate ?? undefined,
    activityHistory: (doc.activityHistory ?? []).map((a: any) => ({
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

export class MongoLeadStore implements LeadStore {
  async findById(id: string): Promise<LeadRecord | null> {
    // A malformed id is simply "not found", not a database error.
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await Lead.findById(id).lean();
    return doc ? toRecord(doc) : null;
  }

  async applyTransition(w: TransitionWrite): Promise<LeadRecord | null> {
    const set: Record<string, unknown> = { currentState: w.to };
    if (w.deal) {
      set.deal = w.deal;
      set.onboardingStatus = "PENDING";
      set.onboardingAttempts = 0;
      set.onboardingError = "";
    }
    const doc = await Lead.findOneAndUpdate(
      { _id: w.id, __v: w.expectedVersion, currentState: w.from },
      { $set: set, $push: { activityHistory: w.entry }, $inc: { __v: 1 } },
      { new: true, lean: true },
    );
    return doc ? toRecord(doc) : null;
  }

  async list(q: ListLeadsQuery) {
    const filter: Record<string, unknown> = {};
    if (q.ownerId) filter.ownerId = q.ownerId;
    if (q.state) filter.currentState = q.state;
    if (q.followUpBefore || q.followUpAfter) {
      filter.followUpDate = { ...(q.followUpBefore ? { $lte: q.followUpBefore } : {}), ...(q.followUpAfter ? { $gte: q.followUpAfter } : {}) };
    }
    if (q.after) {
      if (!mongoose.isValidObjectId(q.after)) return { items: [], nextCursor: null };
      filter._id = { $gt: q.after };
    }
    const docs = await Lead.find(filter).select("-activityHistory").sort({ _id: 1 }).limit(q.limit + 1).lean();
    const page = docs.slice(0, q.limit).map(toRecord);
    return { items: page, nextCursor: docs.length > q.limit ? page[page.length - 1].id : null };
  }

  async create(l: NewLead) {
    const doc = await Lead.create({ name: l.name, company: l.company, ownerId: l.ownerId, ...(l.followUpDate ? { followUpDate: l.followUpDate } : {}) });
    return toRecord(doc.toObject());
  }

  async cancelPendingOnboarding(id: string) {
    if (!mongoose.isValidObjectId(id)) return;
    await Lead.updateOne(
      { _id: id, onboardingStatus: "PENDING", currentState: { $ne: "Closed-Won" } },
      { $set: { onboardingStatus: "CANCELLED", onboardingError: "Lead left Closed-Won before onboarding finished" } },
    );
  }

  async findOnboardingPending(limit: number): Promise<LeadRecord[]> {
    const docs = await Lead.find({ onboardingStatus: "PENDING", currentState: "Closed-Won" })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();
    return docs.map(toRecord);
  }

  async markOnboarding(id: string, status: OnboardingStatus, error = ""): Promise<void> {
    const inc = status === "DONE" ? {} : { onboardingAttempts: 1 };
    await Lead.updateOne({ _id: id }, { $set: { onboardingStatus: status, onboardingError: error }, ...(status === "DONE" ? {} : { $inc: inc }) });
  }
}
