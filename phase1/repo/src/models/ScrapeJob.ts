import { Schema, model, type InferSchemaType } from "mongoose";

const scrapeJobSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    adapter: { type: String, required: true, trim: true }, // source adapter name, e.g. "example-directory"
    params: { type: Schema.Types.Mixed, default: {} }, // validated by Zod per adapter before insert
    status: {
      type: String,
      enum: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"],
      default: "QUEUED",
      required: true,
    },
    counts: {
      found: { type: Number, default: 0, min: 0 },
      inserted: { type: Number, default: 0, min: 0 },
      duplicates: { type: Number, default: 0, min: 0 },
      rejected: { type: Number, default: 0, min: 0 },
    },
    errors: [{ at: Date, message: String, url: String }],
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true },
);

scrapeJobSchema.index({ tenantId: 1, createdAt: -1 });
scrapeJobSchema.index({ status: 1, createdAt: 1 });

export type ScrapeJobDoc = InferSchemaType<typeof scrapeJobSchema>;
export const ScrapeJob = model("ScrapeJob", scrapeJobSchema);
