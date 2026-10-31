import { Schema, model, type InferSchemaType } from "mongoose";
import { LEAD_STATUSES } from "../domain/pipeline.js";

const leadSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    companyName: { type: String, trim: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    website: { type: String, trim: true },

    // Identity used for deduplication (see src/domain/normalize.ts). Null => manual review.
    dedupeKey: { type: String },
    needsReview: { type: Boolean, default: false },

    status: { type: String, enum: LEAD_STATUSES, default: "NEW", required: true },
    // Optimistic concurrency: every transition must present the version it read.
    version: { type: Number, default: 0, min: 0 },

    ownerId: { type: Schema.Types.ObjectId }, // user assignment; users collection arrives with auth
    followUpAt: Date,

    // Provenance: where this lead came from.
    source: {
      adapter: { type: String, required: true },
      url: { type: String },
      scrapedAt: { type: Date, required: true },
      jobId: { type: Schema.Types.ObjectId, ref: "ScrapeJob" },
    },

    // Set once when the lead is converted. Guards against a second conversion.
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
  },
  { timestamps: true, optimisticConcurrency: false, versionKey: false },
);

// Database-level duplicate protection. Partial: leads with no reliable identity are allowed
// (they are flagged needsReview) but never collide with each other.
leadSchema.index(
  { tenantId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);
// List/filter screens
leadSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });
leadSchema.index({ tenantId: 1, ownerId: 1, status: 1 });
leadSchema.index({ tenantId: 1, followUpAt: 1 }, { partialFilterExpression: { followUpAt: { $exists: true } } });

export type LeadDoc = InferSchemaType<typeof leadSchema>;
export const Lead = model("Lead", leadSchema);
