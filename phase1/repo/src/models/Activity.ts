import { Schema, model, type InferSchemaType } from "mongoose";
import { LEAD_STATUSES } from "../domain/pipeline.js";

/**
 * Append-only audit log of everything that happens to a lead.
 * Rows are inserted, never updated or deleted by application code.
 */
const activitySchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    type: {
      type: String,
      enum: ["CREATED", "STATUS_CHANGED", "REOPENED", "NOTE", "OWNER_CHANGED", "CONVERTED"],
      required: true,
    },
    fromStatus: { type: String, enum: LEAD_STATUSES },
    toStatus: { type: String, enum: LEAD_STATUSES },
    reason: { type: String, trim: true, maxlength: 1000 },
    actorId: { type: Schema.Types.ObjectId }, // null for system actions (scraper, worker)
    actorType: { type: String, enum: ["USER", "SYSTEM"], default: "USER" },
    at: { type: Date, default: () => new Date(), required: true },
  },
  { timestamps: false, versionKey: false },
);

activitySchema.index({ tenantId: 1, leadId: 1, at: -1 });

export type ActivityDoc = InferSchemaType<typeof activitySchema>;
export const Activity = model("Activity", activitySchema);
