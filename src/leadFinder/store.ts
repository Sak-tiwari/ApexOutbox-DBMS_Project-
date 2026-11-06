import mongoose from "mongoose";
import { fuzzyKey } from "./dedupe";
import { FoundLead, LeadSearch, ServiceProfile, type FoundRecord, type FoundStatus, type ProfileRecord, type SearchRecord, type SourceRun } from "./models";
import type { RawLead, SearchFilters } from "./types";

const oid = (id: string) => (mongoose.isValidObjectId(id) ? id : null);

function toSearch(d: any): SearchRecord {
  return {
    id: String(d._id), ownerId: d.ownerId, mode: d.mode, query: d.query ?? "", keywords: d.keywords ?? [], filters: d.filters ?? {},
    status: d.status, sources: (d.sources ?? []).map((s: any) => ({ id: s.id, name: s.name, status: s.status, count: s.count ?? 0, error: s.error ?? "" })),
    resultCount: d.resultCount ?? 0, newCount: d.newCount ?? 0, error: d.error ?? "", saved: !!d.saved, name: d.name ?? "", everyHours: d.everyHours ?? 0,
    nextRunAt: d.nextRunAt ?? undefined, lastRunAt: d.lastRunAt ?? undefined, runs: d.runs ?? 0, createdAt: d.createdAt, finishedAt: d.finishedAt ?? undefined,
  };
}

function toFound(d: any): FoundRecord {
  return {
    id: String(d._id), source: d.source, sourceName: d.sourceName ?? d.source, externalId: d.externalId, title: d.title, company: d.company ?? "",
    description: d.description ?? "", url: d.url, budgetText: d.budgetText ?? "", budgetMin: d.budgetMin ?? undefined, budgetMax: d.budgetMax ?? undefined,
    location: d.location ?? "", remote: d.remote ?? undefined, postedAt: d.postedAt ?? undefined, score: d.score ?? 0, status: d.status, seen: d.seen !== false,
    leadId: d.leadId ?? undefined, alsoOn: d.alsoOn ?? [], foundAt: d.createdAt,
  };
}

export interface NewSearch {
  ownerId: string; mode: "auto" | "manual"; query: string; keywords: string[]; filters: SearchFilters;
  saved?: { name: string; everyHours: number };
}

export interface ResultQuery {
  minScore?: number; source?: string; status?: FoundStatus | "ALL"; sort?: "score" | "date" | "budget"; limit?: number;
}

/** All Lead Finder persistence. Every method takes the owner id: a user can never read or change another user's rows. */
export class LeadFinderStore {
  // ---- service profile ----
  async getProfile(ownerId: string): Promise<ProfileRecord | null> {
    const d = await ServiceProfile.findOne({ ownerId }).lean<any>();
    return d ? { description: d.description, keywords: d.keywords ?? [], updatedAt: d.updatedAt } : null;
  }
  async saveProfile(ownerId: string, description: string, keywords: string[]): Promise<ProfileRecord> {
    const d = await ServiceProfile.findOneAndUpdate({ ownerId }, { $set: { description, keywords } }, { upsert: true, new: true, lean: true, setDefaultsOnInsert: true });
    return { description: (d as any).description, keywords: (d as any).keywords ?? [], updatedAt: (d as any).updatedAt };
  }

  // ---- searches ----
  async createSearch(s: NewSearch): Promise<SearchRecord> {
    const doc = await LeadSearch.create({
      ownerId: s.ownerId, mode: s.mode, query: s.query, keywords: s.keywords, filters: s.filters,
      ...(s.saved ? { saved: true, name: s.saved.name, everyHours: s.saved.everyHours, nextRunAt: s.saved.everyHours > 0 ? new Date(Date.now() + s.saved.everyHours * 3_600_000) : undefined } : {}),
    });
    return toSearch(doc.toObject());
  }
  async countActive(ownerId: string) { return LeadSearch.countDocuments({ ownerId, status: { $in: ["QUEUED", "RUNNING"] } }); }
  async getSearch(ownerId: string, id: string): Promise<SearchRecord | null> {
    if (!oid(id)) return null;
    const d = await LeadSearch.findOne({ _id: id, ownerId }).lean();
    return d ? toSearch(d) : null;
  }
  async listSaved(ownerId: string): Promise<Array<SearchRecord & { unseen: number }>> {
    const docs = await LeadSearch.find({ ownerId, saved: true }).sort({ _id: -1 }).limit(50).lean();
    const out = [];
    for (const d of docs) out.push({ ...toSearch(d), unseen: await FoundLead.countDocuments({ ownerId, searchIds: String(d._id), status: "NEW", seen: false }) });
    return out;
  }
  async listRecent(ownerId: string, limit: number) {
    return (await LeadSearch.find({ ownerId }).sort({ _id: -1 }).limit(limit).lean()).map(toSearch);
  }
  async saveSearch(ownerId: string, id: string, name: string, everyHours: number): Promise<SearchRecord | null> {
    if (!oid(id)) return null;
    const d = await LeadSearch.findOneAndUpdate({ _id: id, ownerId }, { $set: { saved: true, name, everyHours, nextRunAt: everyHours > 0 ? new Date(Date.now() + everyHours * 3_600_000) : null } }, { new: true, lean: true });
    return d ? toSearch(d) : null;
  }
  async deleteSaved(ownerId: string, id: string): Promise<boolean> {
    if (!oid(id)) return false;
    const r = await LeadSearch.updateOne({ _id: id, ownerId, saved: true }, { $set: { saved: false, everyHours: 0, nextRunAt: null, name: "" } });
    return r.modifiedCount > 0;
  }
  /** Run a finished search again (same document, fresh run). False if it is already waiting or running. */
  async rerun(ownerId: string, id: string, scheduled = false): Promise<SearchRecord | null> {
    if (!oid(id)) return null;
    const d = await LeadSearch.findOneAndUpdate(
      { _id: id, ownerId, status: { $in: ["DONE", "FAILED"] } },
      { $set: { status: "QUEUED", sources: [], error: "", newCount: 0, scheduledRun: scheduled } },
      { new: true, lean: true },
    );
    return d ? toSearch(d) : null;
  }

  // ---- worker side ----
  /** Atomically takes the oldest QUEUED search: two workers never run the same search. */
  async claimNext(): Promise<SearchRecord | null> {
    const d = await LeadSearch.findOneAndUpdate({ status: "QUEUED" }, { $set: { status: "RUNNING", startedAt: new Date() }, $inc: { runs: 1 } }, { sort: { _id: 1 }, new: true, lean: true });
    return d ? toSearch(d) : null;
  }
  async isScheduledRun(id: string): Promise<boolean> {
    const d = await LeadSearch.findById(id).select("scheduledRun").lean<any>();
    return !!d?.scheduledRun;
  }
  async setSources(id: string, sources: SourceRun[]) { await LeadSearch.updateOne({ _id: id }, { $set: { sources } }); }
  async finish(id: string, r: { status: "DONE" | "FAILED"; resultCount: number; newCount: number; error?: string }) {
    const search = await LeadSearch.findById(id).select("saved everyHours").lean<any>();
    const next = search?.saved && search.everyHours > 0 ? new Date(Date.now() + search.everyHours * 3_600_000) : undefined;
    await LeadSearch.updateOne({ _id: id }, { $set: { status: r.status, resultCount: r.resultCount, newCount: r.newCount, error: r.error ?? "", finishedAt: new Date(), lastRunAt: new Date(), ...(next ? { nextRunAt: next } : {}) } });
  }
  /** Saved searches whose time has come are put back in the queue. Returns how many. */
  async queueDue(now = new Date()): Promise<number> {
    let n = 0;
    for (;;) {
      const d = await LeadSearch.findOneAndUpdate(
        { saved: true, everyHours: { $gt: 0 }, nextRunAt: { $lte: now }, status: { $in: ["DONE", "FAILED"] } },
        { $set: { status: "QUEUED", sources: [], error: "", newCount: 0, scheduledRun: true } },
        { sort: { nextRunAt: 1 }, new: true, lean: true },
      );
      if (!d) return n;
      n++;
    }
  }
  async recoverStale(olderThanMs: number): Promise<number> {
    const r = await LeadSearch.updateMany({ status: "RUNNING", startedAt: { $lt: new Date(Date.now() - olderThanMs) } }, { $set: { status: "FAILED", error: "The worker stopped during this search", finishedAt: new Date() } });
    return r.modifiedCount;
  }

  /**
   * Stores one found post. Returns what happened:
   *  - created: a new row
   *  - same-post: this exact (source, externalId) was already known; score refreshed
   *  - merged: the same request already exists from another platform; its link is added to alsoOn
   */
  async upsertFound(ownerId: string, searchId: string, source: { id: string; name: string }, raw: RawLead, score: number, seen: boolean): Promise<"created" | "same-post" | "merged"> {
    const fuzzy = fuzzyKey(raw.company, raw.title);
    const same = await FoundLead.findOneAndUpdate({ ownerId, source: source.id, externalId: raw.externalId }, { $addToSet: { searchIds: searchId }, $max: { score } }, { new: true, lean: true });
    if (same) return "same-post";
    const twin = await FoundLead.findOneAndUpdate(
      { ownerId, fuzzy, source: { $ne: source.id }, $nor: [{ "alsoOn.source": source.id }] },
      { $addToSet: { searchIds: searchId, alsoOn: { source: source.id, url: raw.url } }, $max: { score } },
      { new: true, lean: true },
    );
    if (twin) return "merged";
    try {
      await FoundLead.create({
        ownerId, source: source.id, sourceName: source.name, externalId: raw.externalId, title: raw.title.slice(0, 300), company: (raw.company ?? "").slice(0, 200),
        description: (raw.description ?? "").slice(0, 4000), url: raw.url, budgetText: raw.budgetText ?? "", budgetMin: raw.budgetMin, budgetMax: raw.budgetMax,
        location: raw.location ?? "", remote: raw.remote, postedAt: raw.postedAt, score, seen, fuzzy, searchIds: [searchId], rawJson: raw,
      });
      return "created";
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        await FoundLead.updateOne({ ownerId, source: source.id, externalId: raw.externalId }, { $addToSet: { searchIds: searchId } });
        return "same-post";
      }
      throw error;
    }
  }

  // ---- results ----
  async listResults(ownerId: string, searchId: string, q: ResultQuery = {}): Promise<FoundRecord[]> {
    const filter: Record<string, unknown> = { ownerId, searchIds: searchId };
    if (q.status && q.status !== "ALL") filter.status = q.status; else if (!q.status) filter.status = { $ne: "DISMISSED" };
    if (q.minScore) filter.score = { $gte: q.minScore };
    if (q.source) filter.source = q.source;
    const sort: Record<string, 1 | -1> = q.sort === "date" ? { postedAt: -1 } : q.sort === "budget" ? { budgetMax: -1 } : { score: -1, postedAt: -1 };
    return (await FoundLead.find(filter).sort(sort).limit(Math.min(q.limit ?? 200, 500)).lean()).map(toFound);
  }
  async getFound(ownerId: string, id: string): Promise<FoundRecord | null> {
    if (!oid(id)) return null;
    const d = await FoundLead.findOne({ _id: id, ownerId }).lean();
    return d ? toFound(d) : null;
  }
  async setFoundStatus(ownerId: string, id: string, status: FoundStatus, leadId?: string): Promise<FoundRecord | null> {
    if (!oid(id)) return null;
    const d = await FoundLead.findOneAndUpdate({ _id: id, ownerId }, { $set: { status, seen: true, ...(leadId ? { leadId } : {}) } }, { new: true, lean: true });
    return d ? toFound(d) : null;
  }
  async unseenCount(ownerId: string) { return FoundLead.countDocuments({ ownerId, status: "NEW", seen: false }); }
  async markAllSeen(ownerId: string) { await FoundLead.updateMany({ ownerId, seen: false }, { $set: { seen: true } }); }
}
