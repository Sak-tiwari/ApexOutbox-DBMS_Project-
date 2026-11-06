import mongoose, { Schema, model } from "mongoose";
import type { SearchFilters } from "./types";

export type SourceStatus = "queued" | "running" | "done" | "blocked" | "failed";
export type SearchStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";
export type FoundStatus = "NEW" | "SAVED" | "DISMISSED" | "PIPELINED";

export interface SourceRun {
  id: string;
  name: string;
  status: SourceStatus;
  count: number;
  error: string;
}

/** service_profiles: what the user's business offers, plus the search keywords derived from it. One per owner. */
const ServiceProfileSchema = new Schema({
  ownerId: { type: String, required: true, unique: true },
  description: { type: String, required: true, maxlength: 2000 },
  keywords: { type: [String], default: [] },
}, { timestamps: true });

/** lead_searches: one document per search. A saved search is the same document with saved=true and a schedule. */
const LeadSearchSchema = new Schema({
  ownerId: { type: String, required: true },
  mode: { type: String, enum: ["auto", "manual"], required: true },
  query: { type: String, default: "", maxlength: 200 },
  keywords: { type: [String], default: [] },
  filters: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ["QUEUED", "RUNNING", "DONE", "FAILED"], default: "QUEUED", required: true },
  sources: { type: [{ _id: false, id: String, name: String, status: String, count: Number, error: String }], default: [] },
  resultCount: { type: Number, default: 0 },
  newCount: { type: Number, default: 0 },
  error: { type: String, default: "" },
  saved: { type: Boolean, default: false },
  name: { type: String, default: "", maxlength: 80 },
  everyHours: { type: Number, default: 0 },
  nextRunAt: { type: Date },
  lastRunAt: { type: Date },
  scheduledRun: { type: Boolean, default: false },
  runs: { type: Number, default: 0 },
  startedAt: { type: Date },
  finishedAt: { type: Date },
}, { timestamps: true });
LeadSearchSchema.index({ ownerId: 1, _id: -1 });
LeadSearchSchema.index({ status: 1, _id: 1 });
LeadSearchSchema.index({ saved: 1, nextRunAt: 1 });

/** found_leads: one document per request found. (ownerId, source, externalId) is unique, so re-running a search never duplicates. */
const FoundLeadSchema = new Schema({
  ownerId: { type: String, required: true },
  source: { type: String, required: true },
  sourceName: { type: String, default: "" },
  externalId: { type: String, required: true },
  title: { type: String, required: true, maxlength: 300 },
  company: { type: String, default: "", maxlength: 200 },
  description: { type: String, default: "", maxlength: 4000 },
  url: { type: String, required: true, maxlength: 2000 },
  budgetText: { type: String, default: "" },
  budgetMin: { type: Number },
  budgetMax: { type: Number },
  location: { type: String, default: "" },
  remote: { type: Boolean },
  postedAt: { type: Date },
  score: { type: Number, default: 0 },
  status: { type: String, enum: ["NEW", "SAVED", "DISMISSED", "PIPELINED"], default: "NEW", required: true },
  seen: { type: Boolean, default: true },
  leadId: { type: String },
  fuzzy: { type: String, default: "" },
  alsoOn: { type: [{ _id: false, source: String, url: String }], default: [] },
  searchIds: { type: [String], default: [] },
  rawJson: { type: Schema.Types.Mixed },
}, { timestamps: true });
FoundLeadSchema.index({ ownerId: 1, source: 1, externalId: 1 }, { unique: true });
FoundLeadSchema.index({ ownerId: 1, fuzzy: 1 });
FoundLeadSchema.index({ ownerId: 1, searchIds: 1 });

export const ServiceProfile = mongoose.models.ServiceProfile ?? model("ServiceProfile", ServiceProfileSchema);
export const LeadSearch = mongoose.models.LeadSearch ?? model("LeadSearch", LeadSearchSchema);
export const FoundLead = mongoose.models.FoundLead ?? model("FoundLead", FoundLeadSchema);

export interface ProfileRecord { description: string; keywords: string[]; updatedAt: Date }
export interface SearchRecord {
  id: string; ownerId: string; mode: "auto" | "manual"; query: string; keywords: string[]; filters: SearchFilters;
  status: SearchStatus; sources: SourceRun[]; resultCount: number; newCount: number; error: string;
  saved: boolean; name: string; everyHours: number; nextRunAt?: Date; lastRunAt?: Date; runs: number; createdAt: Date; finishedAt?: Date;
}
export interface FoundRecord {
  id: string; source: string; sourceName: string; externalId: string; title: string; company: string; description: string; url: string;
  budgetText: string; budgetMin?: number; budgetMax?: number; location: string; remote?: boolean; postedAt?: Date; score: number;
  status: FoundStatus; seen: boolean; leadId?: string; alsoOn: Array<{ source: string; url: string }>; foundAt: Date;
}
