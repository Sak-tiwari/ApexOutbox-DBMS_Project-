import mongoose, { Schema, model } from "mongoose";

export type ScrapeStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export interface ScrapeJobRecord {
  id: string;
  ownerId: string;
  url: string;
  status: ScrapeStatus;
  attempts: number;
  title: string;
  emails: string[];
  leadId?: string;
  leadCreated?: boolean;
  errorCode: string;
  error: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface ScrapeResultWrite {
  title: string;
  emails: string[];
  leadId: string;
  leadCreated: boolean;
}

/** Persistence port for scrape jobs (Mongo in production, in-memory in tests). */
export interface ScrapeJobStore {
  /** Returns the job already waiting/running for this owner+url instead of queueing a duplicate. */
  enqueue(ownerId: string, url: string): Promise<{ job: ScrapeJobRecord; created: boolean }>;
  countActive(ownerId: string): Promise<number>;
  list(ownerId: string, limit: number): Promise<ScrapeJobRecord[]>;
  findById(id: string): Promise<ScrapeJobRecord | null>;
  /** Atomically takes the oldest QUEUED job (QUEUED -> RUNNING). Two workers never get the same job. */
  claimNext(): Promise<ScrapeJobRecord | null>;
  complete(id: string, result: ScrapeResultWrite): Promise<void>;
  fail(id: string, errorCode: string, error: string): Promise<void>;
  /** Jobs left RUNNING by a crashed worker: back to QUEUED (or FAILED after too many attempts). */
  recoverStale(olderThanMs: number, maxAttempts: number): Promise<number>;
}

interface ScrapeJobDoc {
  ownerId: string;
  url: string;
  status: ScrapeStatus;
  attempts: number;
  title: string;
  emails: string[];
  leadId?: string;
  leadCreated?: boolean;
  errorCode: string;
  error: string;
  startedAt?: Date;
  finishedAt?: Date;
}

const ScrapeJobSchema = new Schema<ScrapeJobDoc>({
  ownerId: { type: String, required: true },
  url: { type: String, required: true, maxlength: 2000 },
  status: { type: String, enum: ["QUEUED", "RUNNING", "DONE", "FAILED"], default: "QUEUED", required: true },
  attempts: { type: Number, default: 0 },
  title: { type: String, default: "" },
  emails: { type: [String], default: [] },
  leadId: { type: String },
  leadCreated: { type: Boolean },
  errorCode: { type: String, default: "" },
  error: { type: String, default: "" },
  startedAt: { type: Date },
  finishedAt: { type: Date },
}, { timestamps: true });
ScrapeJobSchema.index({ status: 1, _id: 1 });
ScrapeJobSchema.index({ ownerId: 1, _id: -1 });

export const ScrapeJob = mongoose.models.ScrapeJob ?? model<ScrapeJobDoc>("ScrapeJob", ScrapeJobSchema);

function toRecord(d: any): ScrapeJobRecord {
  return {
    id: String(d._id), ownerId: d.ownerId, url: d.url, status: d.status, attempts: d.attempts ?? 0,
    title: d.title ?? "", emails: d.emails ?? [], leadId: d.leadId ?? undefined, leadCreated: d.leadCreated ?? undefined,
    errorCode: d.errorCode ?? "", error: d.error ?? "", createdAt: d.createdAt, startedAt: d.startedAt ?? undefined, finishedAt: d.finishedAt ?? undefined,
  };
}

export class MongoScrapeJobStore implements ScrapeJobStore {
  async enqueue(ownerId: string, url: string) {
    const active = await ScrapeJob.findOne({ ownerId, url, status: { $in: ["QUEUED", "RUNNING"] } }).lean();
    if (active) return { job: toRecord(active), created: false };
    const doc = await ScrapeJob.create({ ownerId, url });
    return { job: toRecord(doc.toObject()), created: true };
  }
  countActive(ownerId: string) {
    return ScrapeJob.countDocuments({ ownerId, status: { $in: ["QUEUED", "RUNNING"] } });
  }
  async list(ownerId: string, limit: number) {
    const docs = await ScrapeJob.find({ ownerId }).sort({ _id: -1 }).limit(limit).lean();
    return docs.map(toRecord);
  }
  async findById(id: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const d = await ScrapeJob.findById(id).lean();
    return d ? toRecord(d) : null;
  }
  async claimNext() {
    const d = await ScrapeJob.findOneAndUpdate(
      { status: "QUEUED" },
      { $set: { status: "RUNNING", startedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { _id: 1 }, new: true, lean: true },
    );
    return d ? toRecord(d) : null;
  }
  async complete(id: string, r: ScrapeResultWrite) {
    await ScrapeJob.updateOne({ _id: id }, { $set: { status: "DONE", title: r.title, emails: r.emails, leadId: r.leadId, leadCreated: r.leadCreated, errorCode: "", error: "", finishedAt: new Date() } });
  }
  async fail(id: string, errorCode: string, error: string) {
    await ScrapeJob.updateOne({ _id: id }, { $set: { status: "FAILED", errorCode, error: error.slice(0, 500), finishedAt: new Date() } });
  }
  async recoverStale(olderThanMs: number, maxAttempts: number) {
    const cutoff = new Date(Date.now() - olderThanMs);
    const retry = await ScrapeJob.updateMany({ status: "RUNNING", startedAt: { $lt: cutoff }, attempts: { $lt: maxAttempts } }, { $set: { status: "QUEUED" } });
    await ScrapeJob.updateMany({ status: "RUNNING", startedAt: { $lt: cutoff }, attempts: { $gte: maxAttempts } }, { $set: { status: "FAILED", errorCode: "WORKER_LOST", error: "The worker stopped while scraping this page", finishedAt: new Date() } });
    return retry.modifiedCount;
  }
}
